/**
 * BMW "Austausch-Datei" reader - the .0PA (program) and .0DA (calibration) files that SP-DATEN
 * ships, which is where a genuine CSL 0401 image comes from.
 *
 * The format is Intel HEX with three BMW conventions layered on top:
 *
 *  - `$REFERENZ <12 digits> <letter>` and `$CHECKSUMME <4 hex> <letter>` directives around the
 *    hex body. The checksum is CRC-16/ARC over the whole payload in **file order**.
 *  - **Record type 0x10 is a DATA record**, used for the last record of each 64 KiB block. It is
 *    not in the Intel HEX standard and it is not a terminator: treating it as one silently drops
 *    16 bytes per block - 128 bytes of real program code per file - and every consistency check
 *    short of the declared checksum still passes. A zero-length 0x10 record IS a terminator.
 *  - Addresses are already in the ECU's DS2 space: the top nibble selects the flash window
 *    (see regionMap.ts), so a section's address can be handed to the flasher unchanged.
 *
 * `paband.test.ts` parses every MSS54 file in the SP-DATEN package and requires all 92 declared
 * checksums to validate. That is the test that caught the 0x10 bug, and it is the reason this
 * parser can be trusted with bytes that will be written to flash.
 */

/** CRC-16/ARC (reflected, poly 0xA001, init 0). BMW's checksum for both file kinds, and the same
 *  algorithm the reference tuner proved against a real calibration dump. */
export function crc16Arc(bytes: Uint8Array): number {
    let crc = 0;
    for (const b of bytes) {
        crc ^= b;
        for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
    return crc & 0xffff;
}

export interface HexSection {
    /** 24-bit DS2 address of the first byte. The top nibble is the flash window selector. */
    readonly address: number;
    readonly bytes: Uint8Array;
}

export interface AustauschFile {
    /** `;;Key value` header lines, e.g. ZL_System, ZL_REFERENZ, K_Stand, K_V2. */
    readonly meta: ReadonlyMap<string, string>;
    readonly reference?: string;
    /** The `$CHECKSUMME` value, when the file declares one. */
    readonly declaredChecksum?: number;
    /** Sections in file order - the order the declared checksum is computed over. */
    readonly sections: readonly HexSection[];
    /** Every payload byte, in file order. */
    readonly payload: Uint8Array;
}

export class AustauschParseError extends Error {
    constructor(message: string, readonly line?: number) {
        super(line === undefined ? message : `line ${line}: ${message}`);
        this.name = 'AustauschParseError';
    }
}

const RECORD_DATA = 0x00;
const RECORD_EOF = 0x01;
const RECORD_EXTENDED_SEGMENT = 0x02;
const RECORD_EXTENDED_LINEAR = 0x04;
/** BMW's block-final data record. Zero length means "end of block" instead. */
const RECORD_BMW_BLOCK_FINAL = 0x10;

interface OpenSection { address: number; next: number; chunks: Uint8Array[] }

export function parseAustauschDatei(input: Uint8Array | string): AustauschFile {
    const text = typeof input === 'string' ? input : new TextDecoder('latin1').decode(input);
    const meta = new Map<string, string>();
    const sections: HexSection[] = [];
    let reference: string | undefined;
    let declaredChecksum: number | undefined;
    let base = 0;
    let open: OpenSection | undefined;

    const flush = () => {
        if (!open) return;
        const total = open.chunks.reduce((n, c) => n + c.length, 0);
        const bytes = new Uint8Array(total);
        let o = 0;
        for (const c of open.chunks) { bytes.set(c, o); o += c.length; }
        sections.push({ address: open.address, bytes });
        open = undefined;
    };

    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!.trim();
        if (!line) continue;
        const lineNo = i + 1;

        if (line.startsWith(';')) {
            const m = /^;;([^\s:]+):?\s+(.*)$/.exec(line);
            if (m && m[2]!.trim()) meta.set(m[1]!, m[2]!.trim());
            continue;
        }
        if (line.startsWith('$')) {
            const ref = /^\$REFERENZ\s+(\S+)/.exec(line);
            if (ref) reference = ref[1];
            const cks = /^\$CHECKSUMME\s+([0-9A-Fa-f]{4})/.exec(line);
            if (cks) declaredChecksum = parseInt(cks[1]!, 16);
            continue;
        }
        if (!line.startsWith(':')) throw new AustauschParseError(`unrecognised line: ${line.slice(0, 40)}`, lineNo);

        const body = line.slice(1);
        if (body.length < 10 || body.length % 2 !== 0 || /[^0-9A-Fa-f]/.test(body)) {
            throw new AustauschParseError('malformed hex record', lineNo);
        }
        const raw = new Uint8Array(body.length / 2);
        for (let k = 0; k < raw.length; k++) raw[k] = parseInt(body.slice(k * 2, k * 2 + 2), 16);

        const length = raw[0]!;
        if (raw.length !== length + 5) throw new AustauschParseError('record length does not match its byte count', lineNo);
        let sum = 0;
        for (const b of raw) sum = (sum + b) & 0xff;
        if (sum !== 0) throw new AustauschParseError('record checksum mismatch', lineNo);

        const address = (raw[1]! << 8) | raw[2]!;
        const type = raw[3]!;
        const data = raw.subarray(4, 4 + length);

        switch (type) {
            case RECORD_EXTENDED_SEGMENT:
                base = ((data[0]! << 8) | data[1]!) << 4;
                break;
            case RECORD_EXTENDED_LINEAR:
                flush();
                base = ((data[0]! << 8) | data[1]!) << 16;
                break;
            case RECORD_BMW_BLOCK_FINAL:
                if (length === 0) break; // terminator, carries no data
            // falls through - a non-empty 0x10 record is data
            case RECORD_DATA: {
                const at = base + address;
                if (!open) open = { address: at, next: at, chunks: [] };
                if (at !== open.next) {
                    throw new AustauschParseError(
                        `non-contiguous data: expected 0x${open.next.toString(16)}, got 0x${at.toString(16)}`, lineNo);
                }
                open.chunks.push(data);
                open.next = at + length;
                break;
            }
            case RECORD_EOF:
                break;
            default:
                throw new AustauschParseError(`unknown record type 0x${type.toString(16)}`, lineNo);
        }
    }
    flush();

    const total = sections.reduce((n, s) => n + s.bytes.length, 0);
    const payload = new Uint8Array(total);
    let o = 0;
    for (const s of sections) { payload.set(s.bytes, o); o += s.bytes.length; }

    return { meta, reference, declaredChecksum, sections, payload };
}

export interface ChecksumVerdict {
    readonly declared?: number;
    readonly computed: number;
    /** False when the file declares a checksum and it does not match. Undeclared is not a failure. */
    readonly valid: boolean;
}

/** Check a parsed file against its own declared checksum. A file that fails this must not be
 *  flashed: the bytes are not the bytes BMW shipped. */
export function verifyDeclaredChecksum(file: AustauschFile): ChecksumVerdict {
    const computed = crc16Arc(file.payload);
    return {
        declared: file.declaredChecksum,
        computed,
        valid: file.declaredChecksum === undefined || file.declaredChecksum === computed,
    };
}
