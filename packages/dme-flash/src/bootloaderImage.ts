/**
 * The bootloader sector (SA0), its integrity field, and the difference between the standard M3
 * and CSL bootloaders.
 *
 * ## What is in SA0
 *
 * Each processor's flash is an Am29F400BB (bottom boot), 512 KiB, laid out so that the region
 * table's window sizes fall exactly on its sector boundaries:
 *
 *     SA0     0x0000-0x3FFF   16K   bootloader body            DS2 nibble 0x1 / 0x9
 *     SA1     0x4000-0x5FFF    8K   Free Identifiers           nibble 0x0 / 0x8
 *     SA2     0x6000-0x7FFF    8K   tail guard / EEPROM emu    nibble 0x4 / 0xC
 *     SA3     0x8000-0xFFFF   32K   calibration                nibble 0x2 / 0xA
 *     SA4-10  0x10000-0x7FFFF 448K  program                    nibble 0x5 / 0xD
 *
 * ## The integrity field
 *
 * SA0 carries a CRC-16/ARC over itself, stored big-endian at the end of the covered range. It
 * is a plain unkeyed checksum - the same algorithm this package already uses for calibration
 * pairs - not a signature and not a security key. Master and slave differ in where the block
 * ends, because they are different builds of the bootloader:
 *
 *     master   CRC over 0x0000-0x3FFD   stored at 0x3FFE
 *     slave    CRC over 0x0000-0x3FE1   stored at 0x3FE2
 *
 * Verified against four genuine CSL ECU dumps, a real-car standard M3 dump, the community patch
 * and the TERRA image: eight images, sixteen faces, all self-consistent.
 *
 * ## Standard M3 vs CSL
 *
 * The two bootloaders are the same code apart from one instruction operand:
 *
 *     master 0x12AE   E0 -> F0    tst.b $8E002 becomes tst.b $8F002
 *     master 0x3FD7/0x3FDF/0x3FE7 '3' -> '5'   three copies of "21132300" -> "21132500"
 *     master 0x3FFE-0x3FFF        CRC
 *     slave  0x12AE   E1 -> E0    tst.b $8E102 becomes tst.b $8E002
 *     slave  0x3FE2-0x3FE3        CRC
 *
 * The functional effect of 0x12AE is that a calibration byte selects whether twelve bytes are
 * appended to one DS2 ident response. Nothing else in the running engine depends on it.
 *
 * ## Provenance, settled
 *
 * Applying these edits to a standard M3 SA0 and recomputing the CRC produces a sector that is
 * byte-identical to the SA0 in genuine factory CSL dumps. "Reconstructed" and "genuine" are the
 * same bytes, so the community patch's bootloader is the real BMW CSL bootloader. `patchToCsl`
 * exists as the executable form of that proof, not as a substitute for a genuine image.
 */
import { crc16Arc } from './paband';
import { FULL_IMAGE_LENGTH, type Processor } from './imageLayout';

/** Bytes in the bootloader sector. One Am29F400BB bottom-boot sector. */
export const SA0_LENGTH = 0x4000;

/** Full-image offset of each processor's SA0. */
export const SA0_IMAGE_OFFSET: Readonly<Record<Processor, number>> = { master: 0x00000, slave: 0x80000 };

export interface BootloaderSpec {
    /** First byte covered by the CRC. */
    readonly crcStart: number;
    /** One past the last byte covered by the CRC - also where the stored value begins. */
    readonly crcEnd: number;
    /** Offset of the big-endian stored CRC inside SA0. */
    readonly crcSlot: number;
}

/**
 * Where each processor's bootloader keeps its checksum.
 *
 * The two are different because master and slave run different builds: the master's identity
 * block is tagged "MM" at 0x3FFC and carries three copies of the program number, while the
 * slave's is tagged "SS" at 0x3FE0 and carries none (its identity lives in SA1, which is
 * car-specific). That is also why a slave bootloader has nothing to rename.
 */
export const BOOTLOADER_SPEC: Readonly<Record<Processor, BootloaderSpec>> = {
    master: { crcStart: 0x0000, crcEnd: 0x3ffe, crcSlot: 0x3ffe },
    slave: { crcStart: 0x0000, crcEnd: 0x3fe2, crcSlot: 0x3fe2 },
};

/** Known-good CRC values, so a test can name what it expects rather than recompute it. */
export const KNOWN_BOOTLOADER_CRC = {
    standardM3: { master: 0xe2c3, slave: 0xeaba },
    csl: { master: 0x3c45, slave: 0x6465 },
} as const;

/** Offsets that differ between the standard M3 and CSL bootloaders, per processor. */
export const BOOTLOADER_DIFF_OFFSETS: Readonly<Record<Processor, readonly number[]>> = {
    master: [0x12ae, 0x3fd7, 0x3fdf, 0x3fe7, 0x3ffe, 0x3fff],
    slave: [0x12ae, 0x3fe2, 0x3fe3],
};

/** The instruction operand byte the two builds disagree on, and the identity ASCII offsets. */
const HEALTH_CHECK_OPERAND_OFFSET = 0x12ae;
const IDENTITY_ASCII_OFFSETS: readonly number[] = [0x3fd7, 0x3fdf, 0x3fe7];

const HEALTH_CHECK_OPERAND: Readonly<Record<Processor, { readonly standardM3: number; readonly csl: number }>> = {
    master: { standardM3: 0xe0, csl: 0xf0 },
    slave: { standardM3: 0xe1, csl: 0xe0 },
};

/** Where the master keeps its identity block, for reporting the program number. */
export const MASTER_IDENTITY_OFFSET = 0x3fc8;
export const MASTER_IDENTITY_LENGTH = 0x21;

export type BootloaderFlavour = 'standard-m3' | 'csl' | 'unknown';

/** Extract one processor's bootloader sector from a 1 MiB full image. */
export function extractSa0(fullImage: Uint8Array, processor: Processor): Uint8Array {
    if (fullImage.length !== FULL_IMAGE_LENGTH) {
        throw new Error(`full image must be ${FULL_IMAGE_LENGTH} bytes, got ${fullImage.length}`);
    }
    const base = SA0_IMAGE_OFFSET[processor];
    return fullImage.slice(base, base + SA0_LENGTH);
}

export interface BootloaderCrc {
    readonly stored: number;
    readonly computed: number;
    readonly valid: boolean;
}

/** Read the stored CRC and recompute it over the covered range. */
export function verifyBootloaderCrc(sa0: Uint8Array, processor: Processor): BootloaderCrc {
    assertSa0Length(sa0);
    const spec = BOOTLOADER_SPEC[processor];
    const stored = ((sa0[spec.crcSlot] ?? 0) << 8) | (sa0[spec.crcSlot + 1] ?? 0);
    const computed = crc16Arc(sa0.subarray(spec.crcStart, spec.crcEnd));
    return { stored, computed, valid: stored === computed };
}

/** Write the correct CRC into a sector, in place. Returns what it stored. */
export function correctBootloaderCrc(sa0: Uint8Array, processor: Processor): BootloaderCrc {
    assertSa0Length(sa0);
    const spec = BOOTLOADER_SPEC[processor];
    const computed = crc16Arc(sa0.subarray(spec.crcStart, spec.crcEnd));
    sa0[spec.crcSlot] = (computed >>> 8) & 0xff;
    sa0[spec.crcSlot + 1] = computed & 0xff;
    return { stored: computed, computed, valid: true };
}

/** The three copies of the program number a master bootloader carries, e.g. "21132500". */
export function masterProgramNumbers(sa0: Uint8Array): string[] {
    assertSa0Length(sa0);
    return IDENTITY_ASCII_OFFSETS.map((asciiOffset) => {
        // The digit that differs sits at index 5 of an eight-character number.
        const start = asciiOffset - 5;
        return Array.from(sa0.subarray(start, start + 8), (b) => String.fromCharCode(b)).join('');
    });
}

/**
 * Which bootloader this sector is, decided by the operand byte rather than by the ASCII.
 *
 * The operand is the functional difference; the ASCII is a label. Reading the operand means a
 * relabelled image cannot be mistaken for a converted one.
 */
export function identifyBootloader(sa0: Uint8Array, processor: Processor): BootloaderFlavour {
    assertSa0Length(sa0);
    const operand = sa0[HEALTH_CHECK_OPERAND_OFFSET];
    const expected = HEALTH_CHECK_OPERAND[processor];
    if (operand === expected.csl) return 'csl';
    if (operand === expected.standardM3) return 'standard-m3';
    return 'unknown';
}

export interface BootloaderEdit {
    readonly offset: number;
    readonly before: number;
    readonly after: number;
    readonly note: string;
}

/**
 * A byte where this car's derived sector disagrees with the reference CSL bootloader.
 *
 * Not an edit: an edit is something this tool decided to do, an anomaly is something the car
 * turned out to have. They are reported separately because the operator's question is different -
 * "what will you change" versus "what is odd about my ECU".
 */
export interface BootloaderAnomaly {
    readonly offset: number;
    /** What deriving from this car produced. */
    readonly derived: number;
    /** What every reference image has, and what will be written instead. */
    readonly reference: number;
    /** True when the byte is outside the CRC's range, so BMW's own checksum never saw it. */
    readonly outsideCrc: boolean;
}

export interface PatchedBootloader {
    readonly sa0: Uint8Array;
    readonly edits: readonly BootloaderEdit[];
    readonly crc: BootloaderCrc;
    /**
     * Where the derivation disagreed with the reference, empty when it matched or when no
     * reference was given. `sa0` already holds the reference bytes at these offsets.
     */
    readonly anomalies: readonly BootloaderAnomaly[];
}

/** Split the bundled 32 KiB reference pair into one processor's sector. */
export function referenceCslSa0(pair: Uint8Array, processor: Processor): Uint8Array {
    if (pair.length !== SA0_LENGTH * 2) {
        throw new Error(`reference pair must be ${SA0_LENGTH * 2} bytes, got ${pair.length}`);
    }
    const base = processor === 'master' ? 0 : SA0_LENGTH;
    return pair.slice(base, base + SA0_LENGTH);
}

/**
 * Turn a standard M3 bootloader sector into the CSL one, and recompute the CRC.
 *
 * Input is not mutated. NOR flash programming can only clear bits and several of these edits set
 * bits, so this is a description of a *sector image*, never of an in-place modification. Applying
 * it to a real ECU requires erasing SA0, which cannot be done over DS2 (see telegrams.ts).
 *
 * ## Derive, then write the reference
 *
 * Pass `reference` - the CSL sector every source agrees on - and the result is that sector, with
 * the derivation kept as a CHECK on the car rather than as the source of the bytes.
 *
 * Both halves matter. Deriving is the provenance argument: this tool carries no bootloader it
 * cannot reconstruct from the car in front of it, using six bytes (three on the slave) whose
 * meaning is understood. Writing the reference is what stops a defect in one car's boot sector
 * from being carried into the replacement - and SA0 is the sector that cannot be recovered
 * without BDM, so "whatever this car had, plus edits" is the wrong thing to program into it.
 *
 * A real car has already shown why: one carried `82 79` three times at slave 0x3FE4-0x3FE9, a
 * region outside the slave CRC, which therefore passed BMW's own checksum and appears in no
 * reference image of either flavour. Derivation alone would have written it into the new
 * bootloader without a word.
 *
 * Called without a reference this behaves as it always did, and `anomalies` is empty. That path
 * is what `bootloaderImage.test.ts` uses to pin the derivation itself against genuine dumps.
 */
export function patchToCsl(
    standardSa0: Uint8Array, processor: Processor, reference?: Uint8Array,
): PatchedBootloader {
    assertSa0Length(standardSa0);
    const sa0 = Uint8Array.from(standardSa0);
    const edits: BootloaderEdit[] = [];

    const operand = HEALTH_CHECK_OPERAND[processor];
    const before = sa0[HEALTH_CHECK_OPERAND_OFFSET] ?? 0;
    if (before !== operand.csl) {
        sa0[HEALTH_CHECK_OPERAND_OFFSET] = operand.csl;
        edits.push({
            offset: HEALTH_CHECK_OPERAND_OFFSET, before, after: operand.csl,
            note: `health-check operand: the bootloader reads calibration 0x${processor === 'master' ? 'F002' : 'E002'} instead`,
        });
    }

    if (processor === 'master') {
        for (const offset of IDENTITY_ASCII_OFFSETS) {
            const digit = sa0[offset] ?? 0;
            if (digit !== 0x35) {
                sa0[offset] = 0x35;
                edits.push({ offset, before: digit, after: 0x35, note: 'program number 21132300 -> 21132500' });
            }
        }
    }

    // Reconcile against the reference before the checksum, so the CRC covers what is written.
    const anomalies: BootloaderAnomaly[] = [];
    if (reference) {
        assertSa0Length(reference);
        const spec = BOOTLOADER_SPEC[processor];
        for (let offset = 0; offset < SA0_LENGTH; offset++) {
            const derived = sa0[offset] ?? 0;
            const expected = reference[offset] ?? 0;
            if (derived === expected) continue;
            // The CRC slot itself is recomputed below; a difference there is not an anomaly.
            if (offset === spec.crcSlot || offset === spec.crcSlot + 1) continue;
            anomalies.push({
                offset, derived, reference: expected,
                outsideCrc: offset < spec.crcStart || offset >= spec.crcEnd,
            });
            sa0[offset] = expected;
        }
    }

    const crcBefore = verifyBootloaderCrc(sa0, processor);
    const crc = correctBootloaderCrc(sa0, processor);
    if (crcBefore.stored !== crc.stored) {
        const spec = BOOTLOADER_SPEC[processor];
        edits.push({
            offset: spec.crcSlot, before: (crcBefore.stored >>> 8) & 0xff, after: (crc.stored >>> 8) & 0xff,
            note: 'CRC-16/ARC over the sector, high byte',
        });
        edits.push({
            offset: spec.crcSlot + 1, before: crcBefore.stored & 0xff, after: crc.stored & 0xff,
            note: 'CRC-16/ARC over the sector, low byte',
        });
    }

    return { sa0, edits, crc, anomalies };
}

/** Offsets at which two sectors differ. The comparison the provenance argument rests on. */
export function diffOffsets(a: Uint8Array, b: Uint8Array): number[] {
    const n = Math.min(a.length, b.length);
    const out: number[] = [];
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) out.push(i);
    return out;
}

function assertSa0Length(sa0: Uint8Array): void {
    if (sa0.length !== SA0_LENGTH) {
        throw new Error(`bootloader sector must be ${SA0_LENGTH} bytes, got ${sa0.length}`);
    }
}

/**
 * Which processor to convert next, given what each one currently carries.
 *
 * Master and slave are not alternatives. The end state is both on the CSL bootloader, so this is a
 * two-stage job, and the order is forced twice over - which is why it is computed here rather than
 * offered as a choice:
 *
 *  1. **The slave's edit only clears a bit.** `0x12AE` goes `E1 -> E0` on the slave; on the master
 *     it goes `E0 -> F0`, and the program number's `'3' -> '5'`, both of which SET bits. NOR flash
 *     can only clear bits without an erase, so the master's half necessarily erases SA0 and the
 *     slave's may not have to. The cheaper, less destructive stage goes first.
 *  2. **The master is the processor that speaks DS2.** Arm the slave and the master still boots,
 *     keeps the link alive and can report what happened. Arm the master first and a failure takes
 *     away the only means of observing it.
 *
 * A stage is "done" when that processor's bootloader identifies as CSL - read from the operand at
 * `0x12AE`, not from the program-number ASCII, so a relabelled image does not count as converted.
 */
export interface ConversionStages {
    /** The processor to convert next, or null when there is nothing left to do. */
    readonly next: Processor | null;
    /** 1-based position of `next` in the job. Equals `total + 1` when the job is finished. */
    readonly stage: number;
    /** How many stages this DME's job has - 2 for a stock car, fewer if one half is already CSL. */
    readonly total: number;
    /** Processors already carrying the CSL bootloader. */
    readonly done: readonly Processor[];
    /** Set when a bootloader matched neither known image, which makes the rest unplannable. */
    readonly blocked: boolean;
}

export function conversionStages(
    master: BootloaderFlavour,
    slave: BootloaderFlavour,
): ConversionStages {
    if (master === 'unknown' || slave === 'unknown') {
        return { next: null, stage: 0, total: 0, done: [], blocked: true };
    }
    const flavours: Record<Processor, BootloaderFlavour> = { master, slave };
    const done = (['master', 'slave'] as const).filter((p) => flavours[p] === 'csl');
    // Slave first. See the note above - both reasons point the same way.
    const remaining = (['slave', 'master'] as const).filter((p) => flavours[p] !== 'csl');
    return {
        next: remaining[0] ?? null,
        stage: done.length + 1,
        total: done.length + remaining.length,
        done,
        blocked: false,
    };
}
