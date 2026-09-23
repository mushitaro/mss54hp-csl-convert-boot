/**
 * The 64 KiB calibration pair - the half of a CSL conversion that actually gets edited.
 *
 * Why this module carries the whole variant story: **every MAP and flap option lives in
 * calibration, not in program code.** The MAP constants (`k_rf_cfg`, `k_p_saug_*`, `k_rf_diag_*`)
 * are all in the master half; the snorkel-flap constants (`k_ask_*`) and the three flap DTC
 * records are all in the slave half. Nothing a variant needs is in the 512 KiB program image.
 *
 * That matters more than it sounds. The program image can therefore be flashed exactly as BMW
 * shipped it, so its integrity fields - including the 16-bit value at DS2 0x531BE0 that the ECU
 * reports through DS2 selection 0x0C, whose algorithm is NOT known - come along correct by
 * construction and never have to be computed. The only checksum this tool must recompute is the
 * calibration CRC-16/ARC, which is known, implemented, and verified against genuine BMW files.
 *
 * Addressing follows the convention the reference tuner and the XDF both use: a 64 KiB "partial
 * BIN" where 0x0000-0x7FFF is the SLAVE half and 0x8000-0xFFFF is the MASTER half.
 */
import { crc16Arc, type AustauschFile } from './paband';

export const CALIBRATION_PAIR_LENGTH = 0x10000;
export const CALIBRATION_HALF_LENGTH = 0x8000;
/** Offset of the CRC slot inside a half. The two bytes after it are 0xFF padding. */
export const CHECKSUM_OFFSET_IN_HALF = 0x3ffc;

export type Half = 'slave' | 'master';

/** Base of each half inside the pair. The XDF addresses are already pair offsets. */
export const HALF_BASE: Readonly<Record<Half, number>> = { slave: 0x0000, master: 0x8000 };

/** Which half a pair offset belongs to. */
export function halfOf(pairOffset: number): Half {
    return pairOffset < CALIBRATION_HALF_LENGTH ? 'slave' : 'master';
}

/**
 * Build the 64 KiB pair from a parsed .0DA.
 *
 * BMW ships calibration as four 16 KiB sections whose DS2 addresses carry the window nibble:
 * 0xA0xxxx is slave, 0x20xxxx is master. They are not in address order in the file.
 */
export function calibrationPairFrom(file: AustauschFile): Uint8Array {
    const pair = new Uint8Array(CALIBRATION_PAIR_LENGTH);
    const covered = new Uint8Array(CALIBRATION_PAIR_LENGTH);
    for (const section of file.sections) {
        const nibble = (section.address >>> 20) & 0xf;
        if (nibble !== 0x2 && nibble !== 0xa) {
            throw new Error(`section 0x${section.address.toString(16)} is not a calibration window`);
        }
        const base = (nibble === 0xa ? HALF_BASE.slave : HALF_BASE.master) + (section.address & 0xfffff);
        if (base + section.bytes.length > CALIBRATION_PAIR_LENGTH) {
            throw new Error(`section 0x${section.address.toString(16)} runs past the pair`);
        }
        pair.set(section.bytes, base);
        covered.fill(1, base, base + section.bytes.length);
    }
    const missing = covered.indexOf(0);
    if (missing !== -1) throw new Error(`calibration pair has a hole at 0x${missing.toString(16)}`);
    return pair;
}

/**
 * The CRC input for one half: the upper 16 KiB first, then the lower 16 KiB up to the slot.
 *
 * The rotation is not cosmetic - computing over the half in natural order gives a different
 * answer, and this order is the one that reproduces the value BMW stores.
 */
function checksumInput(pair: Uint8Array, half: Half): Uint8Array {
    const base = HALF_BASE[half];
    const input = new Uint8Array(CALIBRATION_HALF_LENGTH - 4);
    input.set(pair.subarray(base + 0x4000, base + 0x8000), 0);
    input.set(pair.subarray(base, base + CHECKSUM_OFFSET_IN_HALF), 0x4000);
    return input;
}

export interface HalfChecksum {
    readonly half: Half;
    /** Pair offset of the 16-bit slot. */
    readonly offset: number;
    readonly stored: number;
    readonly computed: number;
    readonly valid: boolean;
    /** BMW leaves 0xFF 0xFF after the slot; anything else means the layout assumption is wrong. */
    readonly paddingIntact: boolean;
}

export function checksumOffsetOf(half: Half): number {
    return HALF_BASE[half] + CHECKSUM_OFFSET_IN_HALF;
}

export function analyseChecksums(pair: Uint8Array): HalfChecksum[] {
    assertPairLength(pair);
    return (['slave', 'master'] as const).map((half) => {
        const offset = checksumOffsetOf(half);
        const stored = (pair[offset]! << 8) | pair[offset + 1]!;
        const computed = crc16Arc(checksumInput(pair, half));
        return {
            half, offset, stored, computed,
            valid: stored === computed,
            paddingIntact: pair[offset + 2] === 0xff && pair[offset + 3] === 0xff,
        };
    });
}

/**
 * Rewrite both CRC slots in place and report what changed.
 *
 * Call this after every edit. A calibration whose CRC does not match what the ECU computes is
 * exactly the kind of image that flashes without complaint and then behaves as a fault.
 */
export function correctChecksums(pair: Uint8Array): HalfChecksum[] {
    assertPairLength(pair);
    const before = analyseChecksums(pair);
    for (const { half, offset } of before) {
        const computed = crc16Arc(checksumInput(pair, half));
        pair[offset] = (computed >>> 8) & 0xff;
        pair[offset + 1] = computed & 0xff;
    }
    return analyseChecksums(pair).map((after, i) => ({ ...after, stored: before[i]!.stored }));
}

function assertPairLength(pair: Uint8Array): void {
    if (pair.length !== CALIBRATION_PAIR_LENGTH) {
        throw new Error(`calibration pair must be ${CALIBRATION_PAIR_LENGTH} bytes, got ${pair.length}`);
    }
}

/**
 * Load-time invariant: the CRC slot must sit inside the region the CRC is computed over having
 * been excluded from it. If these ever overlap the checksum becomes self-referential and
 * "corrected" images silently stop validating.
 */
function assertChecksumSlotIsExcluded(): void {
    const probe = new Uint8Array(CALIBRATION_PAIR_LENGTH);
    for (const half of ['slave', 'master'] as const) {
        const offset = checksumOffsetOf(half);
        const a = crc16Arc(checksumInput(probe, half));
        probe[offset] = 0x5a;
        probe[offset + 1] = 0xa5;
        const b = crc16Arc(checksumInput(probe, half));
        if (a !== b) throw new Error(`${half} checksum input includes its own slot`);
        probe[offset] = 0;
        probe[offset + 1] = 0;
    }
}
assertChecksumSlotIsExcluded();
