/**
 * Which addresses the DME's bootloader will accept, and for which operation.
 *
 * This is a faithful port of `flash_req_parse` (CSL 0401 master 0x289C). It exists so the
 * converter can answer "will the ECU take this?" **before** a programming session is opened,
 * because the alternative is finding out from a rejection on an already-erased ECU.
 *
 * Everything here is pure: no transport, no clock, no I/O. The table it reads is generated
 * from the firmware image (`regionTable.generated.ts`), and `regionMap.test.ts` re-derives
 * that file from the BIN so a stale copy fails the test rather than a car.
 *
 * Address semantics, proven by disassembly and cross-checked against three constants that
 * have flashed a real vehicle (see docs/region-map.md):
 *
 *   variant 0xFF -> the 24-bit address is used as-is against [start, end)
 *   otherwise    -> the TOP NIBBLE selects the window; the low 20 bits are the offset into it
 */
import {
    REGION_TABLE, FIRMWARE_BLOCK_CAP, type RegionTableEntry,
} from './regionTable.generated';

/** DS2 programming control bytes. Names and values match the reference implementation's
 *  `Ds2ProgrammingControl`, and every one of them appears as an `id` in the region table. */
export const Segment = {
    /** Linear read segment - `Mss54HpDataTuneLayout.readSegment`. Non-destructive. */
    Read: 0x00,
    Write: 0x02,
    Erase: 0x06,
    Recycling: 0x0e,
    Finish: 0x0f,
} as const;
export type SegmentId = (typeof Segment)[keyof typeof Segment];

/**
 * Largest byte count a single write telegram may carry.
 *
 * NOT the firmware's `FIRMWARE_BLOCK_CAP` (0x80): DS2 caps the write count at 123 and flash
 * programming needs an even length at an even address, so 122 is the largest legal value and
 * it cannot be raised. Kept deliberately separate from any read chunk size - they are bounded
 * by different things and only the read side can ever grow. Sharing one constant is a latent
 * brick, because the write path erases first.
 */
export const WRITE_CHUNK_MAX = 122;

/** Load-time invariant. A constant checked only where it is used gets checked after the erase. */
function assertWriteChunkIsFlashSafe(): void {
    if (WRITE_CHUNK_MAX > FIRMWARE_BLOCK_CAP) {
        throw new Error(`WRITE_CHUNK_MAX ${WRITE_CHUNK_MAX} exceeds the firmware block cap ${FIRMWARE_BLOCK_CAP}`);
    }
    if (WRITE_CHUNK_MAX > 123) {
        throw new Error(`WRITE_CHUNK_MAX ${WRITE_CHUNK_MAX} exceeds the DS2 write count cap of 123`);
    }
    if (WRITE_CHUNK_MAX <= 0 || WRITE_CHUNK_MAX % 2 !== 0) {
        throw new Error(`WRITE_CHUNK_MAX ${WRITE_CHUNK_MAX} must be positive and even (flash writes are even-aligned)`);
    }
}
assertWriteChunkIsFlashSafe();

export interface ResolvedAddress {
    /** The entry that matched, for reporting. */
    readonly entry: RegionTableEntry;
    /** Offset the firmware resolves the request to, inside the matched window. */
    readonly offset: number;
    /** Bytes the firmware would allow for this request, before DS2 framing is considered. */
    readonly maxLength: number;
}

export type ResolveFailure =
    | { readonly kind: 'no-entry'; readonly reason: string }
    | { readonly kind: 'window-disabled'; readonly entry: RegionTableEntry; readonly reason: string }
    | { readonly kind: 'out-of-range'; readonly entry: RegionTableEntry; readonly offset: number; readonly reason: string };

export type ResolveResult =
    | ({ readonly accepted: true } & ResolvedAddress)
    | ({ readonly accepted: false } & ResolveFailure);

/** The status byte the firmware writes into the response when it refuses an address. */
export const RESPONSE_ADDRESS_REJECTED = 0xb0;

/**
 * Mirror of `flash_req_parse`. Given a segment and a 24-bit address, answer what the ECU would
 * do - including *why* it would refuse, because a refusal reason is data worth logging verbatim.
 *
 * `requestedLength` is optional: the firmware clamps to the window end and to its own cap, and
 * reports the clamped value. Pass what you intend to send to learn what would actually land.
 */
export function resolveFlashAddress(
    segment: number,
    address: number,
    requestedLength: number = FIRMWARE_BLOCK_CAP,
): ResolveResult {
    const variantKey = (address >>> 16) & 0xf0;

    let matched: RegionTableEntry | undefined;
    let matchedByVariant = false;
    for (const entry of REGION_TABLE) {
        if (entry.id !== segment) continue;
        if (entry.variant === 0xff) { matched = entry; break; }
        if (entry.variant === variantKey) { matched = entry; matchedByVariant = true; break; }
    }

    if (!matched) {
        return {
            accepted: false, kind: 'no-entry',
            reason: `no region_table entry for segment 0x${segment.toString(16).padStart(2, '0')}`
                + ` with address nibble 0x${(variantKey >>> 4).toString(16).toUpperCase()}`,
        };
    }

    // The firmware strips the selector nibble only when the entry is variant-mapped.
    const offset = matchedByVariant ? address & 0x0fffff : address & 0xffffff;

    // Both zero is the firmware's "empty slot" test, checked before the range compare.
    if (matched.start === 0 && matched.end === 0) {
        return {
            accepted: false, kind: 'window-disabled', entry: matched,
            reason: 'region_table slot is empty (start and end both zero)',
        };
    }
    if (matched.end <= matched.start) {
        return {
            accepted: false, kind: 'window-disabled', entry: matched,
            reason: `window 0x${matched.start.toString(16)}-0x${matched.end.toString(16)} has end <= start:`
                + ' unreachable by design (this is how the firmware locks the AIF guard sector)',
        };
    }
    if (offset < matched.start || offset >= matched.end) {
        return {
            accepted: false, kind: 'out-of-range', entry: matched, offset,
            reason: `offset 0x${offset.toString(16)} outside window`
                + ` 0x${matched.start.toString(16)}-0x${matched.end.toString(16)}`
                + ` (firmware answers 0x${RESPONSE_ADDRESS_REJECTED.toString(16)})`,
        };
    }

    let maxLength = requestedLength;
    if (matched.end < maxLength + offset) maxLength = matched.end - offset;
    if (maxLength > FIRMWARE_BLOCK_CAP) maxLength = FIRMWARE_BLOCK_CAP;

    return { accepted: true, entry: matched, offset, maxLength };
}

/** True when the ECU would accept this address for this segment. */
export function isAddressAccepted(segment: number, address: number): boolean {
    return resolveFlashAddress(segment, address).accepted;
}

export interface WindowDescriptor {
    readonly nibble: number;
    readonly processor: 'master' | 'slave';
    readonly start: number;
    readonly end: number;
    readonly size: number;
    /** Base 24-bit address of this window: the nibble in the top position. */
    readonly baseAddress: number;
}

/**
 * The variant windows for one segment, as addressable windows rather than raw entries.
 *
 * Nibbles 0x0-0x6 and 0x8-0xE mirror each other; the reference implementation's proven
 * constants place calibration data at 0x200000 (master) and 0xA00000 (slave), which fixes
 * the low half as master and the high half as slave.
 */
export function windowsForSegment(segment: number): WindowDescriptor[] {
    const out: WindowDescriptor[] = [];
    for (const entry of REGION_TABLE) {
        if (entry.id !== segment || entry.variant === 0xff) continue;
        if (entry.end <= entry.start) continue;
        const nibble = entry.variant >>> 4;
        out.push({
            nibble,
            processor: nibble < 0x8 ? 'master' : 'slave',
            start: entry.start,
            end: entry.end,
            size: entry.end - entry.start,
            baseAddress: nibble << 20,
        });
    }
    return out.sort((a, b) => a.nibble - b.nibble);
}
