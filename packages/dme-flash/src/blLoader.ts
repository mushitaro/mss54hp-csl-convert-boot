/**
 * The staged calibration sector: loader code, the replacement bootloader, and the magic word
 * that arms it.
 *
 * ## Why the calibration sector
 *
 * The resident bootloader cannot erase SA0 - its erase routine copies a stub to RAM but returns
 * into the sector it would have erased - and the firmware's erase handler refuses nibble 0x1
 * anyway. The only in-ECU way to reprogram SA0 is to run code that does not live in SA0.
 *
 * The firmware provides exactly one such entry point. At flash 0x8000, which is the start of the
 * calibration sector (SA3), reached by:
 *
 *     reset handler 0x24A:  cmpi.l #$5AA556C9, $0000FFFC   -> jsr $1BDE
 *     0x1BDE:               move #$2700,sr; reset; ...; lea $8000,a0; jmp (a0)
 *
 * Both addresses are inside SA3: 0x8000 is its first byte and 0xFFFC its last four. And SA3 is
 * erasable and writable over DS2 through the ordinary, real-car-proven calibration path.
 *
 * ## The magic is the point of no return
 *
 * That check lives in the RESET handler, before SIMCR is configured, before the stack is set,
 * before the K-line comes up. Command 0x34 does not jump - its handler validates and returns.
 *
 * So the moment `5A A5 56 C9` is programmed at 0xFFFC, every power-up of that DME jumps to
 * 0x8000 forever. If the loader hangs, faults, or simply fails to enable its own flash writes,
 * the ECU never reaches its DS2 stack again and cannot be un-armed over OBD - with SA0 still
 * fully intact. That is a BDM-only brick that requires no erase at all.
 *
 * Two consequences are encoded here:
 *
 *  1. The magic must be the LAST thing written into the sector, so an interrupted staging leaves
 *     an ECU that still boots normally. `stagedWriteOrder` exists to make that checkable rather
 *     than a convention.
 *  2. The loader's FIRST successful flash operation must be to clear that magic (program zeros
 *     over it - a pure 1 -> 0 change needing no erase). Then the highest-probability loader bugs
 *     degrade to "power-cycle and you are back" instead of "bricked". `MAGIC_CLEARED` is the
 *     value it writes.
 *
 * ## The first-byte gate
 *
 * Both the reset path and command 0x34 test the top byte of the longword at 0x8000: the master
 * refuses 0x01, the slave refuses 0x02. Genuine calibration images start with exactly those
 * bytes (master `01 0E 00 D3`), so the gate is there to refuse to "run" a real calibration.
 * A loader must therefore not begin with its processor's forbidden byte.
 *
 * This module assembles and checks the sector. It does not build the 68k code - that comes from
 * `blLoaderPayload.generated.ts`, assembled and emulator-tested offline.
 */
import { assertWriteUnlocked } from './writeLock';
import { SA0_LENGTH, verifyBootloaderCrc } from './bootloaderImage';
import { CALIBRATION_PAIR_LENGTH } from './calibrationImage';
import type { Processor } from './imageLayout';

/** One Am29F400BB 32 KiB sector: the calibration sector, and the loader's home. */
export const STAGED_SECTOR_LENGTH = 0x8000;

/** Where the loader's entry point sits inside the sector (CPU 0x8000). */
export const LOADER_CODE_OFFSET = 0x0000;

/** Where the replacement bootloader image sits inside the sector (CPU 0x9000). */
export const BOOTLOADER_IMAGE_OFFSET = 0x1000;

/** Where the magic sits inside the sector (CPU 0xFFFC - the last four bytes). */
export const MAGIC_OFFSET = 0x7ffc;

/** The value the reset handler compares against. */
export const STAGED_MAGIC = 0x5aa556c9;

/** What the loader programs over the magic to disarm itself. Pure 1 -> 0; no erase needed. */
export const MAGIC_CLEARED = 0x00000000;

/** Space available for loader code before the bootloader image begins. */
export const LOADER_CODE_CAPACITY = BOOTLOADER_IMAGE_OFFSET - LOADER_CODE_OFFSET;

/** Top byte of the longword at 0x8000 that each processor refuses. */
export const FORBIDDEN_FIRST_BYTE: Readonly<Record<Processor, number>> = { master: 0x01, slave: 0x02 };

/** DS2 base address of the calibration sector each processor stages into. */
export const STAGING_DS2_ADDRESS: Readonly<Record<Processor, number>> = { master: 0x200000, slave: 0xa00000 };

/**
 * What a staged sector is for.
 *
 * Carried on the sector rather than inferred from its contents, because every later layer has to
 * make a different decision on it and inferring it means each layer inferring it separately.
 *
 * `probe` stages the probe loader and NOTHING else - the region where a bootloader image would sit
 * is left erased. It arms the ECU exactly as a replacement does, runs, clears the magic and lets
 * the watchdog reset the DME. SA0 is never touched. That is the whole point: the arming is the
 * irreversible act, and this is the smallest program that can survive it and prove the machine
 * setup works before a real replacement is ever armed.
 *
 * `replace` carries the bootloader image and rewrites SA0.
 */
export type LoaderPurpose = 'probe' | 'replace';

export interface StagedSector {
    readonly processor: Processor;
    readonly purpose: LoaderPurpose;
    readonly bytes: Uint8Array;
    /** DS2 address of the sector's first byte. */
    readonly ds2Address: number;
    /** DS2 address at which the magic lands. */
    readonly magicDs2Address: number;
}

/**
 * Assemble the 32 KiB sector: loader code, bootloader image, magic, 0xFF everywhere else.
 *
 * Gated by the write lock. The sector is not itself a telegram, but it exists only to be written
 * to an ECU, and building it is the step where a mistake becomes bytes.
 *
 * Deliberately does NOT run `correctChecksums`: this sector is code, not calibration. Its
 * 0x7FFC holds the magic, where a calibration pair would hold a CRC. That difference is what
 * keeps the normal conversion path from ever emitting one of these by accident.
 */
export function buildStagedSector(
    processor: Processor,
    loaderCode: Uint8Array,
    bootloaderImage: Uint8Array,
): StagedSector {
    assertWriteUnlocked(`staged loader sector for the ${processor}`);

    if (bootloaderImage.length !== SA0_LENGTH) {
        throw new Error(`bootloader image must be ${SA0_LENGTH} bytes, got ${bootloaderImage.length}`);
    }
    const crc = verifyBootloaderCrc(bootloaderImage, processor);
    if (!crc.valid) {
        throw new Error(
            `refusing to stage a bootloader whose CRC does not validate`
            + ` (stored 0x${crc.stored.toString(16)}, computed 0x${crc.computed.toString(16)})`);
    }
    assertLoaderCodeIsStageable(processor, loaderCode);

    const bytes = new Uint8Array(STAGED_SECTOR_LENGTH).fill(0xff);
    bytes.set(loaderCode, LOADER_CODE_OFFSET);
    bytes.set(bootloaderImage, BOOTLOADER_IMAGE_OFFSET);
    bytes[MAGIC_OFFSET] = (STAGED_MAGIC >>> 24) & 0xff;
    bytes[MAGIC_OFFSET + 1] = (STAGED_MAGIC >>> 16) & 0xff;
    bytes[MAGIC_OFFSET + 2] = (STAGED_MAGIC >>> 8) & 0xff;
    bytes[MAGIC_OFFSET + 3] = STAGED_MAGIC & 0xff;

    const ds2Address = STAGING_DS2_ADDRESS[processor];
    return {
        processor, purpose: 'replace', bytes, ds2Address,
        magicDs2Address: ds2Address + MAGIC_OFFSET,
    };
}

/**
 * Assemble a PROBE sector: loader code, magic, and erased flash everywhere else.
 *
 * ## Why this exists, and why it is a separate function
 *
 * There is no safe rehearsal for arming. The magic is checked by the reset handler at 0x24A -
 * before the SIM, before the stack, before the K-line - so from the moment it is programmed, every
 * power-up jumps to 0x8000 and a defective loader can never be reached over OBD again, with SA0
 * still perfectly intact. **The first arming is the first execution.**
 *
 * So the first thing ever armed on a real DME should be the smallest program that proves the
 * machine setup works, and its first successful flash operation should be to disarm itself. That
 * program is `tools/loader/probe.s`, and this builds the sector that carries it.
 *
 * What it proves, on THIS ECU rather than on the emulator: that the entry at 0x8000 is reached,
 * that enabling the SRAM array works from the state the RESET instruction leaves, that a stub
 * copied into RAM runs, and that a flash program cycle succeeds at the reset chip-select timings.
 * Those are exactly the things a replacement loader must also get right, and exactly the things
 * an emulator can only argue about.
 *
 * A separate function rather than an optional argument to `buildStagedSector`, because the
 * difference between the two is a bootloader image and the failure that matters is confusing one
 * for the other. An optional parameter makes that confusion a typo; two functions make it a
 * different call. `validateBlReplace` re-derives the distinction from the bytes anyway.
 */
export function buildProbeSector(processor: Processor, loaderCode: Uint8Array): StagedSector {
    assertWriteUnlocked(`staged probe sector for the ${processor}`);
    assertLoaderCodeIsStageable(processor, loaderCode);

    const bytes = new Uint8Array(STAGED_SECTOR_LENGTH).fill(0xff);
    bytes.set(loaderCode, LOADER_CODE_OFFSET);
    // Erased where a replacement would carry SA0. Nothing reads it, and leaving it erased is what
    // makes "this sector cannot rewrite a bootloader" a property of the bytes rather than a claim.
    bytes[MAGIC_OFFSET] = (STAGED_MAGIC >>> 24) & 0xff;
    bytes[MAGIC_OFFSET + 1] = (STAGED_MAGIC >>> 16) & 0xff;
    bytes[MAGIC_OFFSET + 2] = (STAGED_MAGIC >>> 8) & 0xff;
    bytes[MAGIC_OFFSET + 3] = STAGED_MAGIC & 0xff;

    const ds2Address = STAGING_DS2_ADDRESS[processor];
    return {
        processor, purpose: 'probe', bytes, ds2Address,
        magicDs2Address: ds2Address + MAGIC_OFFSET,
    };
}

/**
 * True when the region a replacement uses for the bootloader image is entirely erased.
 *
 * The check that separates a probe from a replacement by looking at the bytes instead of at the
 * label. A sector claiming to be a probe while carrying an SA0 image is the single most dangerous
 * mislabelling this tool could produce - it would arm a bootloader rewrite behind a screen that
 * says nothing will be rewritten.
 */
export function carriesNoBootloaderImage(sector: Uint8Array): boolean {
    for (let i = BOOTLOADER_IMAGE_OFFSET; i < BOOTLOADER_IMAGE_OFFSET + SA0_LENGTH; i++) {
        if (sector[i] !== 0xff) return false;
    }
    return true;
}

/**
 * Check loader code against the constraints the firmware imposes, without building a sector.
 *
 * Separate from `buildStagedSector` so it can be called while the write lock is engaged - the
 * whole loader can be developed and validated in the locked state.
 */
export function assertLoaderCodeIsStageable(processor: Processor, loaderCode: Uint8Array): void {
    if (loaderCode.length === 0) throw new Error('loader code is empty');
    if (loaderCode.length > LOADER_CODE_CAPACITY) {
        throw new Error(
            `loader code is ${loaderCode.length} bytes, which overruns the`
            + ` ${LOADER_CODE_CAPACITY}-byte space before the bootloader image at 0x${BOOTLOADER_IMAGE_OFFSET.toString(16)}`);
    }
    if (loaderCode.length % 2 !== 0) throw new Error('loader code must be an even number of bytes (68k word alignment)');
    const first = loaderCode[0] ?? 0;
    if (first === FORBIDDEN_FIRST_BYTE[processor]) {
        throw new Error(
            `loader code starts with 0x${first.toString(16).padStart(2, '0')}, which the ${processor}`
            + ' refuses: both the reset path and command 0x34 test the top byte of the longword at 0x8000'
            + ' and reject that value (it is how they refuse to "run" a genuine calibration)');
    }
}

export interface StagedWriteStep {
    readonly ds2Address: number;
    readonly bytes: Uint8Array;
    /**
     * True for the chunk that COMPLETES the magic - the moment the ECU becomes armed.
     *
     * Not merely "touches the magic": with a small chunk size the four magic bytes can span two
     * chunks, and a partially written magic does not match the reset handler's comparison, so
     * the ECU is not armed until the final byte lands.
     */
    readonly armsTheEcu: boolean;
}

/** Offset of the last byte of the magic - writing this is what arms the ECU. */
const MAGIC_LAST_BYTE_OFFSET = MAGIC_OFFSET + 3;

/**
 * Split a staged sector into ascending write chunks, with the arming chunk last.
 *
 * Ascending order puts the end of the magic in the final chunk naturally. This function exists
 * so that fact is asserted rather than assumed: `armsTheEcu` marks the chunk that completes the
 * magic, and `assertMagicIsLast` proves it is the last one. An interrupted staging then leaves
 * an ECU that still boots normally.
 */
export function stagedWriteOrder(sector: StagedSector, chunkSize: number): StagedWriteStep[] {
    if (chunkSize <= 0 || chunkSize % 2 !== 0) {
        throw new Error(`staged write chunk size ${chunkSize} must be positive and even`);
    }
    const steps: StagedWriteStep[] = [];
    for (let offset = 0; offset < STAGED_SECTOR_LENGTH; offset += chunkSize) {
        const end = Math.min(offset + chunkSize, STAGED_SECTOR_LENGTH);
        steps.push({
            ds2Address: sector.ds2Address + offset,
            bytes: sector.bytes.subarray(offset, end),
            armsTheEcu: offset <= MAGIC_LAST_BYTE_OFFSET && MAGIC_LAST_BYTE_OFFSET < end,
        });
    }
    assertMagicIsLast(steps);
    return steps;
}

/** The ordering invariant: exactly one chunk arms the ECU, and it is the final one. */
export function assertMagicIsLast(steps: readonly StagedWriteStep[]): void {
    const arming = steps.filter((s) => s.armsTheEcu);
    if (arming.length !== 1) {
        throw new Error(`expected exactly one arming chunk, found ${arming.length}`);
    }
    if (steps[steps.length - 1]?.armsTheEcu !== true) {
        throw new Error(
            'the chunk carrying the magic must be written last, so that an interrupted staging'
            + ' leaves an ECU that still boots normally');
    }
}

/** True when a sector image holds the magic - i.e. writing it would arm the ECU. */
export function sectorIsArmed(sector: Uint8Array): boolean {
    if (sector.length !== STAGED_SECTOR_LENGTH) return false;
    const value = ((sector[MAGIC_OFFSET] ?? 0) << 24 | (sector[MAGIC_OFFSET + 1] ?? 0) << 16
        | (sector[MAGIC_OFFSET + 2] ?? 0) << 8 | (sector[MAGIC_OFFSET + 3] ?? 0)) >>> 0;
    return value === STAGED_MAGIC;
}

/**
 * Load-time invariants for the sector layout.
 *
 * The bootloader image must fit between the loader code and the magic, and the calibration
 * sector must be half a calibration pair - both are the kind of arithmetic that is obviously
 * right until someone changes a constant.
 */
function assertStagedLayoutFits(): void {
    if (BOOTLOADER_IMAGE_OFFSET + SA0_LENGTH > MAGIC_OFFSET) {
        throw new Error('the bootloader image would overlap the magic word');
    }
    if (LOADER_CODE_OFFSET + LOADER_CODE_CAPACITY !== BOOTLOADER_IMAGE_OFFSET) {
        throw new Error('loader code capacity does not reach the bootloader image');
    }
    if (MAGIC_OFFSET + 4 !== STAGED_SECTOR_LENGTH) {
        throw new Error('the magic must occupy the last four bytes of the sector');
    }
    if (STAGED_SECTOR_LENGTH * 2 !== CALIBRATION_PAIR_LENGTH) {
        throw new Error('a staged sector must be exactly one half of a calibration pair');
    }
}
assertStagedLayoutFits();
