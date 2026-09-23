/**
 * The other half of a conversion: which PROGRAM gets written.
 *
 * Until now this tool wrote exactly one program - BMW's `.0PA`, unmodified - and that was the
 * whole reason `variant.ts` could be so relaxed about integrity fields. Quoting `calibrationImage`:
 * the program's own fields, including the 16-bit value at DS2 `0x531BE0` whose algorithm is NOT
 * known, "come along correct by construction and never have to be computed".
 *
 * The community patch breaks that assumption in one direction and repairs it in another. It IS a
 * modified program, so the tool no longer writes only BMW's bytes. But its author recomputed both
 * integrity words, and those words turn out not to depend on the calibration at all:
 *
 * ```
 *   ZB7837328 (PD11 cal)   0x41BE0 = 0xDE9B   0xC2482 = 0xAED3
 *   ZB7837332 (PD1D cal)   0x41BE0 = 0xDE9B   0xC2482 = 0xAED3
 *   ZB7837336 (PD1J cal)   0x41BE0 = 0xDE9B   0xC2482 = 0xAED3
 *   community patch v1     0x41BE0 = 0xF859   0xC2482 = 0xE925
 * ```
 *
 * Three genuine ECU dumps carrying three DIFFERENT calibrations agree on both words, and only a
 * changed program moves them. So **the patched program composes with any of the six factory
 * calibrations**, and this module never has to compute a field it cannot.
 *
 * ## What the check actually compares, and what it is worth
 *
 * Three parties, not two:
 *
 *   A  the factory `.0PA`   - the bundled SP-DATEN copy, unless the operator supplied their own
 *   B  the patched image    - always the bundled copy; there is no picker for it
 *   C  the span table below - a constant in this source file
 *
 * and the check is `diff(A, B) === C`. Be precise about what that buys, because the obvious
 * reading is too generous: on the default path A and B both ship with the app, so their difference
 * is a constant and the check passes by construction. It is not evidence that B is authentic
 * community output - that is trust in this repository, and nothing here can upgrade it.
 *
 * What it does earn:
 *
 *  - **C lives in reviewed source**, so a B that was corrupted in transit, served stale by the
 *    service worker, or swapped in `public/program/` is refused. Integrity, not provenance.
 *  - **When the operator overrides SP-DATEN**, A really is theirs, and "this program is not the
 *    one the patch was measured against" becomes a genuine guard against writing a patch onto a
 *    program it was never measured against.
 *
 * The patch is 537 bytes across 8 spans and could simply have been hardcoded. Keeping it as a
 * verified file rather than a literal is what makes the second point possible at all, and it is
 * what will make the first point mean something once the patch is published upstream and B can
 * come from outside this repository.
 *
 * The check also removes a special case that would be easy to forget. The community ships two
 * builds, `21132500` (CSL bootloader) and `21132300` (standard-M3 bootloader). This tool writes
 * the CSL bootloader, so only the `2500` build belongs here - and the `2300` build differs from
 * the factory program at the identity ASCII (image `0x41B95`/`0x41BA1`/`0x41BAD`, DS2
 * `0x531B95`...), which is NOT one of the eight spans below. It is refused by the signature check,
 * with the extra span named, rather than by a rule someone had to remember to write.
 *
 * ## What the patch does, from its own code
 *
 * Established by disassembling the differing spans, not from the release notes:
 *
 *  - **`0x3109C` (24 B, master)** sits inside the handler the application command table registers
 *    for DS2 command `0x0B` (table at image `0x3A1F0`: `0x0B` -> `0x00030B84`, next handler
 *    `0x00031A3E`). Factory code reports a THRESHOLD FLAG for the word at `$00FFEECA`
 *    (`cmpi.w #8` / `shi` / `andi.l #1`); the patch reports the value itself (`asr.l #8`). Both
 *    write through `(a2)+` into an outgoing block, so this changes what a datalogger reads back.
 *  - **`0x3BEFC` (316 B, master)** rebuilds a status-bit block: many `btst` of RAM error flags
 *    packed with `bset #n,m(a2)`, reading `cfg_m.motortyp` at calibration `$088007`.
 *  - **`0xBEFEC` (186 B, slave)** is new code in space the factory program leaves as 0xFF, reached
 *    by two `jsr` operands redirected at `0x9241B` and `0x92B63`. It is gated on a calibration byte
 *    - see `GEN_ST_ENABLE` - and drives bit 0 of `$00FF8748` from a filtered value compared against
 *    a threshold with hysteresis. Consistent with the community's "GEN_ST over CAN", though the
 *    master/slave synchronisation of that byte has not been traced here.
 *  - **`0x41BE0` and `0xC2482` (2 B each)** are the two integrity words, recomputed by the author.
 *
 * Everything here is pure. It reads bytes and refuses; it does not flash.
 */
import { crc16Arc, type HexSection } from './paband';
import {
    FULL_IMAGE_LENGTH, IMAGE_WINDOWS, ds2ToImageOffset, imageOffsetToDs2,
} from './imageLayout';
import type { SpDatenProgram } from './spDaten';

/** A program this tool is willing to write, in the shape `buildConversionImage` places. */
export interface ProgramSource {
    readonly file: string;
    readonly reference: string;
    /** Sections carrying DS2 addresses, exactly as a `.0PA` would. */
    readonly sections: readonly HexSection[];
}

/** One contiguous run where a patched program differs from the factory one. */
export interface ProgramEdit {
    readonly id: string;
    /** Full-image offset of the first byte. */
    readonly offset: number;
    /** The DS2 address the same byte has on the wire. */
    readonly ds2Address: number;
    readonly length: number;
    /** Human-facing account of what this span does, from the disassembly. */
    readonly note: string;
}

/**
 * One span of a known patch: where it is, how long, and what the bytes must hash to before and
 * after. Both CRCs are checked, so a DIFFERENT patch touching the SAME span is still refused.
 */
interface PatchSpan {
    readonly id: string;
    readonly offset: number;
    readonly length: number;
    readonly before: number;
    readonly after: number;
    readonly note: string;
}

/**
 * MSS54HP CSL 0401 Community Patch v1, `21132500` build, measured against SP-DATEN `7837340A.0PA`.
 *
 * 487 bytes actually differ; the spans below total 537 because a span keeps the unchanged bytes
 * inside it - the run is the unit that gets verified, not the individual byte.
 */
const COMMUNITY_PATCH_V1: readonly PatchSpan[] = [
    {
        id: 'ds2_0b_report_value', offset: 0x3109c, length: 24, before: 0x823d, after: 0x2b4e,
        note: 'DS2 command 0x0B: the field for $00FFEECA is reported as its value rather than as a'
            + ' threshold flag. This changes what a datalogger reads back.',
    },
    {
        id: 'master_byte_36001', offset: 0x36001, length: 1, before: 0xcac1, after: 0x3180,
        note: 'One master program byte, 0x19 -> 0x42. Its role has not been established here.',
    },
    {
        id: 'status_block_rebuild', offset: 0x3befc, length: 316, before: 0xd89b, after: 0x1413,
        note: 'Status-bit block rebuilt: RAM error flags tested and packed into the outgoing block.'
            + ' Reads cfg_m.motortyp at calibration $088007.',
    },
    {
        id: 'master_integrity_word', offset: 0x41be0, length: 2, before: 0x0b18, after: 0xfa83,
        note: 'Master integrity word (DS2 selection 0x0C reads DS2 0x531BE0), recomputed by the'
            + ' patch author. Its algorithm is not known to this tool, so it is carried, not built.',
    },
    {
        id: 'gen_st_hook_1', offset: 0x9241b, length: 3, before: 0xfa78, after: 0xbdbd,
        note: 'Slave jsr operand redirected from $0162D8 to the added code at $03EFEC.',
    },
    {
        id: 'gen_st_hook_2', offset: 0x92b63, length: 3, before: 0xee43, after: 0xaab5,
        note: 'Slave jsr operand redirected from $013868 to the added code at $03F098.',
    },
    {
        id: 'gen_st_code', offset: 0xbefec, length: 186, before: 0x98fe, after: 0xd896,
        note: 'Added slave code at $03EFEC, in space the factory program leaves as 0xFF. Gated on'
            + ' the calibration byte at slave pair 0x5844; drives bit 0 of $00FF8748.',
    },
    {
        id: 'slave_integrity_word', offset: 0xc2482, length: 2, before: 0xfd3d, after: 0x4b8e,
        note: 'Slave integrity word, recomputed by the patch author. Carried, not built.',
    },
] as const;

/** CRC-16/ARC over each whole program window, factory and patched. A single pin on the result. */
const PROGRAM_WINDOW_CRC = {
    factory: { master: 0x3de3, slave: 0xf3b7 },
    patched: { master: 0x9950, slave: 0xf257 },
} as const;

/**
 * The calibration byte the added slave code reads as its enable.
 *
 * `cmpi.b #$01,$0008D844` / `bne` - so 1 runs the feature and anything else skips it. All six
 * factory calibrations hold 0xFF here (free space the XDF does not define), and the patch ships
 * 0x00, so the feature is OFF unless something writes 1.
 *
 * Given as a pair offset because that is the space `variant.ts` edits in.
 */
export const GEN_ST_ENABLE = {
    /** Offset in the 64 KiB calibration pair: slave half. */
    pairOffset: 0x5844,
    /** The address the added slave code reads. */
    cpuAddress: 0x08d844,
    factoryValue: 0xff,
    patchShippedValue: 0x00,
    enabledValue: 0x01,
} as const;

export class ProgramSourceError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ProgramSourceError';
    }
}

/** A patched program, verified against the factory one it was built from. */
export interface PatchedProgram extends ProgramSource {
    /** Stable id for the patch this file was recognised as. */
    readonly patchId: 'community-patch-v1';
    readonly edits: readonly ProgramEdit[];
    /** Total bytes that differ from the factory program. */
    readonly changedBytes: number;
    /** True when the added code that `GEN_ST_ENABLE` gates is present. */
    readonly offersGenSt: boolean;
}

/** Lay the factory program out in a full image, so the two can be compared byte for byte. */
function factoryImage(factory: SpDatenProgram): Uint8Array {
    const image = new Uint8Array(FULL_IMAGE_LENGTH).fill(0xff);
    let placed = 0;
    for (const section of factory.parsed.sections) {
        const offset = ds2ToImageOffset(section.address);
        if (offset === undefined) {
            throw new ProgramSourceError(
                `${factory.file}: section at 0x${section.address.toString(16)} is outside every window`);
        }
        image.set(section.bytes, offset);
        placed += section.bytes.length;
    }
    if (placed === 0) throw new ProgramSourceError(`${factory.file}: carried no program data`);
    return image;
}

/** The program windows only - a patched program may not reach calibration or the bootloader. */
function programWindows(): readonly { start: number; end: number }[] {
    return IMAGE_WINDOWS
        .filter((w) => w.kind === 'program')
        .map((w) => ({ start: w.imageOffset, end: w.imageOffset + w.length }));
}

/** Contiguous runs of differing bytes, merged across gaps of up to 16 unchanged bytes. */
function differingRuns(a: Uint8Array, b: Uint8Array): { start: number; end: number; changed: number }[] {
    const runs: { start: number; end: number; changed: number }[] = [];
    for (const window of programWindows()) {
        let open: { start: number; end: number; changed: number } | null = null;
        for (let o = window.start; o < window.end; o++) {
            if (a[o] === b[o]) continue;
            if (open && o - open.end <= 16) { open.end = o; open.changed++; }
            else { open = { start: o, end: o, changed: 1 }; runs.push(open); }
        }
    }
    return runs;
}

/**
 * Read a 1 MiB community image as a program source, proving it is the patch it claims to be.
 *
 * The factory program is the reference, so this cannot be called without the operator's own
 * SP-DATEN: what gets verified is the DIFFERENCE, which is the only part that is not BMW's.
 */
export function readPatchedProgram(
    fileName: string, imageBytes: Uint8Array, factory: SpDatenProgram,
): PatchedProgram {
    if (imageBytes.length !== FULL_IMAGE_LENGTH) {
        throw new ProgramSourceError(
            `${fileName}: expected a ${FULL_IMAGE_LENGTH}-byte full image, got ${imageBytes.length}`);
    }
    const genuine = factoryImage(factory);
    const runs = differingRuns(genuine, imageBytes);

    // Shape first: an unexpected span is the interesting failure, so name it rather than report a
    // count. This is also what refuses the 21132300 build - it differs at the identity ASCII.
    for (const run of runs) {
        const length = run.end - run.start + 1;
        if (!COMMUNITY_PATCH_V1.some((s) => s.offset === run.start && s.length === length)) {
            throw new ProgramSourceError(
                `${fileName}: changes 0x${run.start.toString(16)}..0x${run.end.toString(16)}`
                + ` (${length} bytes, DS2 0x${(imageOffsetToDs2(run.start) ?? 0).toString(16)}),`
                + ' which is not part of the community patch this tool knows.'
                + ' Refusing: an unrecognised program change cannot be described to the operator.');
        }
    }
    for (const span of COMMUNITY_PATCH_V1) {
        if (!runs.some((r) => r.start === span.offset && r.end - r.start + 1 === span.length)) {
            throw new ProgramSourceError(
                `${fileName}: does not carry the community patch span '${span.id}' at`
                + ` 0x${span.offset.toString(16)}. This file is not community patch v1.`);
        }
    }

    // Then content: the same spans carrying different bytes is a different patch, and must not pass.
    for (const span of COMMUNITY_PATCH_V1) {
        const was = crc16Arc(genuine.subarray(span.offset, span.offset + span.length));
        const now = crc16Arc(imageBytes.subarray(span.offset, span.offset + span.length));
        if (was !== span.before) {
            throw new ProgramSourceError(
                `${factory.file}: factory bytes at 0x${span.offset.toString(16)} hash to`
                + ` 0x${was.toString(16)}, expected 0x${span.before.toString(16)}.`
                + ' This SP-DATEN program is not the one the patch was measured against.');
        }
        if (now !== span.after) {
            throw new ProgramSourceError(
                `${fileName}: patched bytes at 0x${span.offset.toString(16)} hash to`
                + ` 0x${now.toString(16)}, expected 0x${span.after.toString(16)}.`
                + ' Same location, different content - this is not community patch v1.');
        }
    }

    // And the windows as a whole, so no byte outside a listed span can have moved unnoticed.
    const sections: HexSection[] = [];
    for (const window of IMAGE_WINDOWS) {
        if (window.kind !== 'program') continue;
        const bytes = imageBytes.slice(window.imageOffset, window.imageOffset + window.length);
        const crc = crc16Arc(bytes);
        if (crc !== PROGRAM_WINDOW_CRC.patched[window.processor]) {
            throw new ProgramSourceError(
                `${fileName}: ${window.processor} program window hashes to 0x${crc.toString(16)},`
                + ` expected 0x${PROGRAM_WINDOW_CRC.patched[window.processor].toString(16)}.`);
        }
        sections.push({ address: window.ds2Address, bytes });
    }

    return {
        file: fileName,
        reference: factory.reference,
        sections,
        patchId: 'community-patch-v1',
        edits: COMMUNITY_PATCH_V1.map((span) => ({
            id: span.id,
            offset: span.offset,
            ds2Address: imageOffsetToDs2(span.offset) ?? 0,
            length: span.length,
            note: span.note,
        })),
        changedBytes: runs.reduce((n, r) => n + r.changed, 0),
        offersGenSt: true,
    };
}

/** True when a program source is the factory one, i.e. not patched. */
export function isPatchedProgram(source: ProgramSource): source is PatchedProgram {
    return 'patchId' in source;
}

/** The factory program's window CRCs, so a caller can pin what "unmodified" means. */
export function factoryProgramWindowCrc(processor: 'master' | 'slave'): number {
    return PROGRAM_WINDOW_CRC.factory[processor];
}
