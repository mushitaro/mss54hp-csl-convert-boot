/**
 * The factory software, as BMW ships it, and the six CSL builds inside it.
 *
 * SP-DATEN carries an MSS54HP conversion as two files: one `.0PA` holding the program, shared by
 * every CSL variant, and one `.0DA` per variant holding that variant's calibration. So a
 * conversion image is program + one calibration, and choosing a variant is choosing which `.0DA`.
 *
 * ## The variants name themselves
 *
 * Every `.0DA` opens with a header BMW wrote:
 *
 *     ;;ZL_REFERENZ:      211325000401PD31
 *     ;;K_V1:             E46-M3-CSL-EOBD SA231
 *     ;;K_V2:             SW fuer ZB 7.837.330
 *
 * This module reads those and hands them up unchanged. It does not carry a table of what the six
 * builds are, and that is deliberate: a table drifts from the files, and a label that describes a
 * variant wrongly is worse than one that is merely terse. It also keeps the tool honest about a
 * detail this project's own notes had backwards - `Vmax abgeregelt` is Vmax *limited*, while the
 * notes recorded 7837329 as unrestricted.
 *
 * Nothing here is bundled with the app. The operator supplies their own SP-DATEN, which is BMW's
 * to distribute and not this project's.
 */
import { parseAustauschDatei, verifyDeclaredChecksum, type AustauschFile, type HexSection } from './paband';
import type { ProgramSource } from './programVariant';
import { calibrationPairFrom, CALIBRATION_PAIR_LENGTH, HALF_BASE } from './calibrationImage';
import {
    FULL_IMAGE_LENGTH, IMAGE_WINDOWS, ds2ToImageOffset, windowFor, isProtectedImageOffset,
} from './imageLayout';

/** What a `.0DA` says about itself. Every field is BMW's own text, not this tool's. */
export interface SpDatenVariant {
    /** The file it came from, e.g. `A7837331.0DA`. */
    readonly file: string;
    /** `ZL_REFERENZ`, e.g. `211325000401PD31` - the program number and the build suffix. */
    readonly reference: string;
    /** `K_Stand`, e.g. `PD31 (03.12.04)`. */
    readonly stand: string;
    /** `K_V1` - the human name, e.g. `E46-M3-CSL-EOBD SA231`. Shown to the operator verbatim. */
    readonly name: string;
    /** `K_V2`, e.g. `SW fuer ZB 7.837.330`. */
    readonly zb: string;
    /** The 64 KiB calibration pair this file carries. */
    readonly pair: Uint8Array;
    /** Whether the file's own declared checksum matched. */
    readonly checksumValid: boolean;
}

/**
 * What a `.0PA` says about itself, plus its program sections.
 *
 * `sections` is the same list as `parsed.sections`, surfaced here so that a factory program
 * satisfies `ProgramSource` structurally. That is what lets `buildConversionImage` take either
 * this or a verified community-patched program without knowing which it has.
 */
export interface SpDatenProgram extends ProgramSource {
    readonly file: string;
    readonly reference: string;
    readonly parsed: AustauschFile;
    readonly sections: readonly HexSection[];
}

export class SpDatenError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SpDatenError';
    }
}

function meta(file: AustauschFile, key: string): string {
    return (file.meta.get(key) ?? '').trim();
}

/**
 * Is this a CSL build?
 *
 * Decided by the reference the file declares, not by its filename: `2113 2500` is the CSL program
 * number, `2113 2300` the standard M3 one. A renamed file therefore cannot be mistaken for a CSL
 * variant, which is the same rule `identifyBootloader` follows for SA0.
 */
export function isCslReference(reference: string): boolean {
    return reference.replace(/\s/g, '').startsWith('21132500');
}

/**
 * Read one `.0DA` as a variant. Throws when it is not a calibration file this tool understands.
 *
 * The CSL check comes BEFORE the pair is assembled, and that ordering is the whole reason this is
 * not one expression: a standard-M3 calibration has a different section layout, so building the
 * pair first made it fail with "calibration pair has a hole at 0x4000" - true, unhelpful, and it
 * hid the actual answer, which is that the file is for a different car.
 */
export function readVariant(fileName: string, bytes: Uint8Array | string): SpDatenVariant {
    const parsed = parseAustauschDatei(bytes);
    const reference = parsed.reference ?? meta(parsed, 'ZL_REFERENZ');
    if (!isCslReference(reference)) {
        throw new SpDatenError(`${fileName}: calibration ${reference || '(unnamed)'} is not a CSL build`);
    }
    const pair = calibrationPairFrom(parsed);
    if (pair.length !== CALIBRATION_PAIR_LENGTH) {
        throw new SpDatenError(
            `${fileName}: calibration is ${pair.length} bytes, expected ${CALIBRATION_PAIR_LENGTH}`);
    }
    return {
        file: fileName,
        reference,
        stand: meta(parsed, 'K_Stand'),
        name: meta(parsed, 'K_V1'),
        zb: meta(parsed, 'K_V2'),
        pair,
        checksumValid: verifyDeclaredChecksum(parsed).valid,
    };
}

/** Read one `.0PA` as the program half of a conversion. */
export function readProgram(fileName: string, bytes: Uint8Array | string): SpDatenProgram {
    const parsed = parseAustauschDatei(bytes);
    return {
        file: fileName,
        reference: parsed.reference ?? meta(parsed, 'ZL_REFERENZ'),
        parsed,
        sections: parsed.sections,
    };
}

export interface SpDatenSet {
    readonly program: SpDatenProgram | null;
    /** CSL variants found, in reference order so the list is stable between runs. */
    readonly variants: readonly SpDatenVariant[];
    /** Files that were offered and could not be used, with the reason. */
    readonly rejected: readonly { readonly file: string; readonly reason: string }[];
}

/**
 * Sort a pile of SP-DATEN files into the program and the CSL variants.
 *
 * Non-CSL calibrations are rejected rather than hidden: someone who selects the whole MSS54
 * directory has just handed over every E46 build BMW ships, and silently filtering to six would
 * leave them wondering which six.
 */
export function collectSpDaten(
    files: readonly { readonly name: string; readonly bytes: Uint8Array }[],
): SpDatenSet {
    let program: SpDatenProgram | null = null;
    const variants: SpDatenVariant[] = [];
    const rejected: { file: string; reason: string }[] = [];

    for (const { name, bytes } of files) {
        const isProgram = /\.0PA$/i.test(name);
        try {
            if (isProgram) {
                const candidate = readProgram(name, bytes);
                if (!isCslReference(candidate.reference)) {
                    rejected.push({ file: name, reason: `program ${candidate.reference} is not a CSL build` });
                    continue;
                }
                // The newest wins if several are offered; they are all the same program in practice.
                program = candidate;
                continue;
            }
            // readVariant already refuses a non-CSL reference, with the reason.
            variants.push(readVariant(name, bytes));
        } catch (error) {
            rejected.push({ file: name, reason: error instanceof Error ? error.message : String(error) });
        }
    }

    variants.sort((a, b) => a.reference.localeCompare(b.reference));
    return { program, variants, rejected };
}

/**
 * Assemble the 1 MiB image a conversion writes: this program, this variant's calibration.
 *
 * The program's sections carry DS2 addresses, so each is placed by asking `imageLayout` where that
 * address lives rather than by assuming a layout - a section addressed outside the four windows is
 * a refusal, not a silent skip.
 *
 * Everything the plan does not write stays 0xFF. That is not padding: the caller hands this to
 * `planFlash`, which only writes the four windows, so the rest is never sent. Filling it with the
 * ECU's current contents would produce an image that *looks* like a backup and is not one.
 */
export function buildConversionImage(program: ProgramSource, variant: SpDatenVariant): Uint8Array {
    if (!isCslReference(program.reference)) {
        throw new SpDatenError(`program ${program.reference} is not a CSL build`);
    }
    if (!isCslReference(variant.reference)) {
        throw new SpDatenError(`calibration ${variant.reference} is not a CSL build`);
    }

    const image = new Uint8Array(FULL_IMAGE_LENGTH).fill(0xff);

    // --- program ------------------------------------------------------------------------------
    let placed = 0;
    for (const section of program.sections) {
        const offset = ds2ToImageOffset(section.address);
        if (offset === undefined) {
            throw new SpDatenError(
                `${program.file}: section at 0x${section.address.toString(16)} is outside every`
                + ' window this tool writes');
        }
        if (isProtectedImageOffset(offset)) {
            throw new SpDatenError(
                `${program.file}: section at 0x${section.address.toString(16)} lands in a protected`
                + ' sector (bootloader or service block)');
        }
        image.set(section.bytes, offset);
        placed += section.bytes.length;
    }
    if (placed === 0) throw new SpDatenError(`${program.file}: carried no program data`);

    // --- calibration --------------------------------------------------------------------------
    // The pair holds slave at 0x0000 and master at 0x8000; the full image puts them 0x80000 apart.
    for (const half of ['slave', 'master'] as const) {
        const window = windowFor('calibration', half);
        image.set(
            variant.pair.subarray(HALF_BASE[half], HALF_BASE[half] + window.length),
            window.imageOffset);
    }

    return image;
}

/** Bytes a conversion writes, for the operator to see before it starts. */
export function conversionWriteBytes(): number {
    return IMAGE_WINDOWS.reduce((n, w) => n + w.length, 0);
}
