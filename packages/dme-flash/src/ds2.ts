/**
 * BMW DS2 frame construction and parsing.
 *
 *     +---------+--------+----------------+----------+
 *     | ADDRESS | LENGTH |    DATA ...    | CHECKSUM |
 *     +---------+--------+----------------+----------+
 *
 *  ADDRESS  - ECU diagnostic address; the MSS54/MSS54HP DME is 0x12.
 *  LENGTH   - TOTAL frame length including address, length, data and checksum (= data + 3).
 *  DATA     - command byte followed by its payload.
 *  CHECKSUM - XOR of every preceding byte of the frame.
 *
 * Ported from two independent implementations that both talk to real cars: the diagnosis PWA's
 * `js/ds2.js` and the tuner's `src/lib/dme-link/ds2.ts`. They agree on every rule encoded here,
 * which is the only reason this file can be trusted with bytes bound for flash.
 *
 * Pure byte work: no transport, no timers, no retries. Framing is the one layer that must be
 * exactly right before anything else can be debugged, so it is kept alone and fully tested.
 */

/** Diagnostic address of the MSS54 / MSS54HP DME on the K-line. */
export const DME_DS2_ADDRESS = 0x12;

/** Bytes of overhead a frame adds to its data: address, length, checksum. */
export const DS2_FRAME_OVERHEAD = 3;

/** Smallest legal frame: address + length + checksum, with no data. */
export const DS2_MIN_FRAME_LENGTH = 3;

/**
 * The length byte is a single byte, so a frame can never exceed 255 bytes and its data can
 * never exceed 252. The write path is capped far below this by WRITE_CHUNK_MAX; this is only
 * the framing ceiling.
 */
export const DS2_MAX_FRAME_LENGTH = 0xff;
export const DS2_MAX_DATA_LENGTH = DS2_MAX_FRAME_LENGTH - DS2_FRAME_OVERHEAD;

/** XOR of every byte. The DS2 checksum, and also how a frame's checksum is verified. */
export function ds2Checksum(bytes: Uint8Array): number {
    let c = 0;
    for (const b of bytes) c ^= b;
    return c & 0xff;
}

/** Build a complete DS2 frame around `data` (which begins with the command byte). */
export function buildDs2Frame(address: number, data: Uint8Array): Uint8Array {
    if (data.length > DS2_MAX_DATA_LENGTH) {
        throw new Error(
            `DS2 data length ${data.length} exceeds ${DS2_MAX_DATA_LENGTH};`
            + ' the length byte cannot describe this frame');
    }
    const frame = new Uint8Array(data.length + DS2_FRAME_OVERHEAD);
    frame[0] = address & 0xff;
    frame[1] = frame.length & 0xff;
    frame.set(data, 2);
    frame[frame.length - 1] = ds2Checksum(frame.subarray(0, frame.length - 1));
    return frame;
}

/**
 * Response status bytes, as reported by the reference tuner against a real DME.
 *
 * Only `Ack` means the request was carried out. A positive status is necessary but never
 * sufficient for a write: the write response also carries an echoed address, a written count
 * and a verify byte, and all four must agree (see telegrams.ts).
 */
export const Ds2Status = {
    Ack: 0xa0,
    Busy: 0xa1,
    Rejected: 0xa2,
    ParameterError: 0xb0,
    FunctionError: 0xb1,
    Nak: 0xff,
} as const;
export type Ds2StatusValue = (typeof Ds2Status)[keyof typeof Ds2Status];

/** Human-readable name for a status byte, for logs and error messages. */
export function describeDs2Status(status: number): string {
    switch (status) {
        case Ds2Status.Ack: return 'ACK';
        case Ds2Status.Busy: return 'BUSY';
        case Ds2Status.Rejected: return 'REJECTED (0xA2 - session or access level)';
        case Ds2Status.ParameterError: return 'PARAMETER ERROR (0xB0 - address or value refused)';
        case Ds2Status.FunctionError: return 'FUNCTION ERROR (0xB1)';
        case Ds2Status.Nak: return 'NAK';
        default: return `unknown status 0x${status.toString(16).padStart(2, '0')}`;
    }
}

export interface Ds2Response {
    readonly ok: boolean;
    readonly address?: number;
    readonly length?: number;
    /** Frame contents between the length byte and the checksum. First byte is the status. */
    readonly data?: Uint8Array;
    readonly checksum?: number;
    readonly error?: string;
}

/**
 * Total frame length declared by a buffer, or -1 while the length byte has not arrived.
 *
 * A reader uses this to know when to stop reading rather than waiting for a timeout, which is
 * what keeps a slow-but-healthy link from being mistaken for a dead one.
 */
export function expectedDs2Length(buf: Uint8Array): number {
    return buf.length >= 2 ? (buf[1] ?? -1) : -1;
}

/** Parse a response frame. Never throws: a malformed frame is data about the link. */
export function parseDs2Frame(buf: Uint8Array): Ds2Response {
    if (buf.length < DS2_MIN_FRAME_LENGTH) {
        return { ok: false, error: `frame too short (${buf.length} bytes, minimum ${DS2_MIN_FRAME_LENGTH})` };
    }
    const address = buf[0] ?? 0;
    const length = buf[1] ?? 0;
    if (length < DS2_MIN_FRAME_LENGTH) {
        return { ok: false, address, length, error: `declared length ${length} is below the minimum ${DS2_MIN_FRAME_LENGTH}` };
    }
    if (buf.length < length) {
        return { ok: false, address, length, error: `incomplete frame (${buf.length}/${length} bytes)` };
    }
    const frame = buf.subarray(0, length);
    const checksum = frame[length - 1] ?? 0;
    const calculated = ds2Checksum(frame.subarray(0, length - 1));
    const data = frame.slice(2, length - 1);
    if (calculated !== checksum) {
        return {
            ok: false, address, length, data, checksum,
            error: `checksum mismatch (computed 0x${calculated.toString(16).padStart(2, '0')},`
                + ` frame carries 0x${checksum.toString(16).padStart(2, '0')})`,
        };
    }
    return { ok: true, address, length, data, checksum };
}

/** Status byte of a parsed response, or undefined when it carried no data. */
export function statusOf(response: Ds2Response): number | undefined {
    return response.data?.[0];
}

/** True when the frame parsed cleanly and the DME answered ACK. */
export function isPositive(response: Ds2Response): boolean {
    return response.ok && statusOf(response) === Ds2Status.Ack;
}

/** Format bytes as spaced uppercase hex - the form every reference log and doc uses. */
export function toHex(bytes: Uint8Array): string {
    return Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

// ---------------------------------------------------------------------------------------------
// Echo diagnosis
//
// Ported from the reference tuner's `classifyEchoMismatch`, which exists because "unexpected
// K-line echo" was the single most common real-vehicle failure and the message alone could not
// tell the operator which of two completely different problems they had. One is repaired by
// clearing a buffer; the other is repaired by getting under the dashboard.
// ---------------------------------------------------------------------------------------------

/** What a mismatched echo appears to have been. */
export type EchoFaultKind = 'desync' | 'electrical' | 'unclassified';

export interface EchoMismatchAnalysis {
    /** Byte offset into what we sent that best lines up with what came back. */
    readonly lag: number;
    /** How many byte pairs that alignment actually compared. */
    readonly compared: number;
    /** True when every returned bit is a subset of the sent bits, i.e. only 1→0 flips. */
    readonly allSubset: boolean;
    readonly flips1to0: number;
    readonly flips0to1: number;
    readonly trailingZeroRun: number;
    /** True when the bytes read look like a DS2 response rather than a corrupted echo. */
    readonly looksLikeResponse: boolean;
    readonly kind: EchoFaultKind;
    /** One sentence for the operator, naming the fault and whether software can fix it. */
    readonly verdict: string;
}

function popcount(byte: number): number {
    let n = byte & 0xff;
    let c = 0;
    while (n) { c += n & 1; n >>>= 1; }
    return c;
}

/**
 * Decide whether a bad echo was a buffer desync or an electrical event.
 *
 * The discriminator is bit direction, and it is physics rather than heuristics. Another driver on
 * a K-line can only pull it **low**, so an interfering device turns 1 bits into 0 bits and never
 * the reverse. An echo whose every difference is 1→0 was therefore corrupted on the wire; one
 * that has 0→1 flips cannot have been, and is far more likely to be a stale frame read out of the
 * buffer where the echo belonged.
 *
 * Small alignments are tried because a single dropped leading byte shifts everything by one and
 * would otherwise look like total corruption. The alignment that best fits the "only pulled low"
 * model wins.
 *
 * The two answers lead to opposite advice, which is the whole point of separating them: a desync
 * is repaired by clearing the buffer and retrying, and telling someone to check their cable is a
 * wasted trip. An electrical fault is not repaired by retrying at all, and "check the connection
 * and retry" is the only advice that can work.
 */
export function classifyEchoMismatch(sent: Uint8Array, got: Uint8Array): EchoMismatchAnalysis {
    let trailingZeroRun = 0;
    for (let i = got.length - 1; i >= 0 && got[i] === 0; i--) trailingZeroRun++;

    const looksLikeResponse = got.length >= 3
        && got[0] === DME_DS2_ADDRESS
        && (got[2] === Ds2Status.Ack || got[2] === Ds2Status.Busy || got[2] === Ds2Status.Rejected);

    let best: { lag: number; compared: number; allSubset: boolean; flips1to0: number; flips0to1: number } | null = null;
    for (let lag = 0; lag < Math.min(4, sent.length); lag++) {
        let compared = 0;
        let flips1to0 = 0;
        let flips0to1 = 0;
        let subset = true;
        for (let i = 0; i + lag < sent.length && i < got.length; i++) {
            const s = sent[i + lag] ?? 0;
            const g = got[i] ?? 0;
            compared++;
            flips1to0 += popcount(s & ~g);
            flips0to1 += popcount(~s & g & 0xff);
            if ((g & ~s & 0xff) !== 0) subset = false;
        }
        if (compared === 0) continue;
        const candidate = { lag, compared, allSubset: subset, flips1to0, flips0to1 };
        // Prefer an alignment with no 0→1 flips (physically impossible from an interfering driver),
        // then the one covering the most bytes, then the one with the fewest corrupted bits.
        if (!best
            || (candidate.allSubset && !best.allSubset)
            || (candidate.allSubset === best.allSubset && candidate.compared > best.compared)
            || (candidate.allSubset === best.allSubset && candidate.compared === best.compared
                && candidate.flips1to0 < best.flips1to0)) {
            best = candidate;
        }
    }

    const a = best ?? { lag: 0, compared: 0, allSubset: false, flips1to0: 0, flips0to1: 0 };
    // Needs enough bytes to mean anything: one or two matching bytes prove nothing either way.
    const pulledLow = a.compared >= 3 && a.allSubset && a.flips0to1 === 0;

    const kind: EchoFaultKind = looksLikeResponse ? 'desync'
        : pulledLow || trailingZeroRun >= 2 ? 'electrical'
            : 'unclassified';

    const verdict = looksLikeResponse
        ? 'a stale DS2 response was read where the echo belonged - the buffer is out of frame,'
          + ' which software can repair'
        : pulledLow
            ? 'the K-line was pulled low during our own transmission - an electrical fault in the'
              + ' cable, connector, ground or the DME itself. Retrying cannot repair this.'
            : trailingZeroRun >= 2
                ? 'the line was held low (break / framing errors) - electrical, not a buffer desync'
                : 'unclassified - either a buffer desync or line noise';

    return { ...a, trailingZeroRun, looksLikeResponse, kind, verdict };
}
