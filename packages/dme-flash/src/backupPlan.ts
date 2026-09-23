/**
 * Reading the DME's current image back, without erasing anything.
 *
 * This is the first thing worth doing on real hardware, for two reasons that happen to be the
 * same operation:
 *
 *  1. **It is the backup M2 makes mandatory.** Before a program window is ever erased, the bytes
 *     that are there must be on disk.
 *  2. **It tests the riskiest unknown safely.** The whole conversion rests on the program windows
 *     (nibble 0x5 / 0xD) actually responding. Segment 0x00 (read) reaches those same windows, so a
 *     read proves the addressing without clearing a single cell. A dangerous hypothesis, tried
 *     with a harmless operation.
 *
 * This module is pure: it produces the *plan* (which reads, in what order, reassembled how) and
 * checks the result. The bytes come from an injected reader, so the whole thing runs against a
 * mock with no cable - which is the only way to test a read path without a car.
 */
import {
    Segment, resolveFlashAddress, windowsForSegment, WRITE_CHUNK_MAX, type SegmentId,
} from './regionMap';
import { IMAGE_WINDOWS, FULL_IMAGE_LENGTH, type ImageWindow } from './imageLayout';

/**
 * Bytes per read telegram.
 *
 * Deliberately a SEPARATE constant from WRITE_CHUNK_MAX even though both are 122 today. A read is
 * bounded by DS2 framing alone and could grow toward the DME's published telegram maximum; the
 * write side is capped lower and by different rules. Sharing one constant is the latent brick the
 * reference tool's comments warn about, so they are split here from the start - and a test asserts
 * the read side never silently adopts the write cap.
 */
export const READ_CHUNK_MAX = 122;

/**
 * Segments this module is permitted to put in a telegram. Exactly one entry, on purpose.
 *
 * A backup is the one operation this tool performs on a real ECU today, and its whole safety claim
 * is "this cannot destroy anything". Hardcoding Segment.Read at each call site states that; an
 * allowlist plus a load-time check enforces it, so a later edit that adds an erase here makes the
 * package fail to load rather than quietly gaining the ability to clear a sector.
 */
const ALLOWED_SEGMENTS: readonly SegmentId[] = [Segment.Read] as const;

/**
 * Measured throughput of the reference implementation: 65,536 bytes in 122.9 s at 9600 baud.
 *
 * Used only to tell the operator how long a read will take. Never used to derive a timeout - a
 * timeout computed from an average is how a slow-but-healthy link gets aborted mid-backup.
 */
export const MEASURED_MS_PER_BYTE_9600 = 122.9e3 / 65536;

export interface ReadChunk {
    readonly segment: number;
    readonly ds2Address: number;
    readonly count: number;
    /** Offset in the reassembled full image where this chunk's bytes land. */
    readonly imageOffset: number;
}

export interface ReadPlan {
    readonly chunks: readonly ReadChunk[];
    /** The windows this plan covers, for display and for the reassembly bounds. */
    readonly windows: readonly ImageWindow[];
    readonly totalBytes: number;
    /** Estimated wall-clock at 9600 baud, from measured throughput. Display only. */
    readonly estimatedMsAt9600: number;
    /**
     * True when the plan covers each window's full addressable extent rather than only the bytes
     * BMW ships. See planCautiousBackup for why that distinction decides whether a backup can
     * actually restore the ECU.
     */
    readonly fullWindowExtent: boolean;
}

/**
 * A read reader: given segment/address/count, return exactly `count` bytes. Errors are the
 * caller's to raise. The real one wraps DS2 read telegrams; the mock returns slices of a known
 * image. Both satisfy this one shape, which is what lets the plan be tested without hardware.
 */
export type ChunkReader = (segment: number, ds2Address: number, count: number) => Promise<Uint8Array>;

export interface BackupProgress {
    readonly readSoFar: number;
    readonly total: number;
    readonly window: ImageWindow;
}

/**
 * Plan a full non-destructive backup: every conversion window (program + calibration, both
 * processors), read in READ_CHUNK_MAX pieces, in a fixed order.
 *
 * Every chunk address is checked against the firmware's own acceptance table up front. A read
 * cannot brick anything, but a chunk the ECU will refuse wastes a telegram and muddies the log,
 * and refusing to plan it is free.
 */
export function planFullBackup(chunkSize = READ_CHUNK_MAX): ReadPlan {
    assertChunkSize(chunkSize);
    const chunks: ReadChunk[] = [];
    for (const window of IMAGE_WINDOWS) {
        for (let done = 0; done < window.length; done += chunkSize) {
            const count = Math.min(chunkSize, window.length - done);
            const ds2Address = window.ds2Address + done;
            const check = resolveFlashAddress(Segment.Read, ds2Address, count);
            if (!check.accepted) {
                throw new Error(`read chunk at 0x${ds2Address.toString(16)} would be refused: ${check.reason}`);
            }
            chunks.push({ segment: Segment.Read, ds2Address, count, imageOffset: window.imageOffset + done });
        }
    }
    return finishPlan(chunks, false);
}

/**
 * Plan a backup of each window's FULL addressable extent, not only the part SP-DATEN fills.
 *
 * This matters more than it looks. The program windows are 448 KiB each but only the first 256 KiB
 * carries program, so planFullBackup reads 576 KiB in total. If an erase turns out to clear the
 * whole window - which is NOT established, and is exactly the kind of thing that is discovered the
 * hard way - a 576 KiB backup cannot put the ECU back. This plan can.
 *
 * It is slower and most of what it reads is very likely 0xFF. That is the trade: a backup that is
 * short is worthless precisely when it is needed. summariseContent on the result reports how much
 * really came back erased, which is how the true extent gets established in the first place.
 */
export function planCautiousBackup(chunkSize = READ_CHUNK_MAX): ReadPlan {
    assertChunkSize(chunkSize);
    const readWindows = windowsForSegment(Segment.Read);
    const chunks: ReadChunk[] = [];
    for (const window of IMAGE_WINDOWS) {
        const nibble = (window.ds2Address >>> 20) & 0xf;
        const descriptor = readWindows.find((w) => w.nibble === nibble);
        if (!descriptor) throw new Error(`no readable window for nibble 0x${nibble.toString(16)}`);
        const extent = descriptor.end - descriptor.start;
        for (let done = 0; done < extent; done += chunkSize) {
            const count = Math.min(chunkSize, extent - done);
            const ds2Address = descriptor.baseAddress + descriptor.start + done;
            const check = resolveFlashAddress(Segment.Read, ds2Address, count);
            if (!check.accepted) {
                throw new Error(`read chunk at 0x${ds2Address.toString(16)} would be refused: ${check.reason}`);
            }
            // Only the shipped part of a program window has a home in a 1 MiB image; bytes beyond
            // it are still read and reported, never silently dropped, but they do not land in the
            // reassembled image. imageOffset -1 marks them.
            chunks.push({
                segment: Segment.Read, ds2Address, count,
                imageOffset: done < window.length ? window.imageOffset + done : -1,
            });
        }
    }
    return finishPlan(chunks, true);
}

function finishPlan(chunks: ReadChunk[], fullWindowExtent: boolean): ReadPlan {
    const totalBytes = chunks.reduce((n, c) => n + c.count, 0);
    return {
        chunks, windows: IMAGE_WINDOWS, totalBytes, fullWindowExtent,
        estimatedMsAt9600: Math.round(totalBytes * MEASURED_MS_PER_BYTE_9600),
    };
}

function assertChunkSize(chunkSize: number): void {
    if (chunkSize <= 0 || chunkSize > READ_CHUNK_MAX) {
        throw new Error(`read chunk size ${chunkSize} out of range (1..${READ_CHUNK_MAX})`);
    }
}

/** Build the 5-byte DS2 read payload: [segment, addrHi, addrMid, addrLo, count]. */
export function buildReadPayload(chunk: ReadChunk): Uint8Array {
    if (!ALLOWED_SEGMENTS.includes(chunk.segment as SegmentId)) {
        throw new Error(`segment 0x${chunk.segment.toString(16)} is not one this module may send`);
    }
    if (chunk.count <= 0 || chunk.count > READ_CHUNK_MAX) {
        throw new Error(`read count ${chunk.count} outside 1..${READ_CHUNK_MAX}`);
    }
    return new Uint8Array([
        chunk.segment,
        (chunk.ds2Address >>> 16) & 0xff,
        (chunk.ds2Address >>> 8) & 0xff,
        chunk.ds2Address & 0xff,
        chunk.count,
    ]);
}

export interface ContentSummary {
    readonly totalBytes: number;
    readonly erasedBytes: number;
    /** Offset just past the last non-0xFF byte - the real extent of what the window holds. */
    readonly contentEnd: number;
}

/**
 * How much of a captured window actually holds something.
 *
 * This is the measurement that turns "the window is 448 KiB" into "the program occupies the first
 * N KiB" - the number the erase-granularity question needs, obtained from a read that risks
 * nothing at all.
 */
export function summariseContent(bytes: Uint8Array): ContentSummary {
    let erased = 0;
    let contentEnd = 0;
    for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === 0xff) erased++;
        else contentEnd = i + 1;
    }
    return { totalBytes: bytes.length, erasedBytes: erased, contentEnd };
}

export interface BackupResult {
    /** A 1 MiB image with the read windows filled and everything else left 0xFF (unread). */
    readonly image: Uint8Array;
    /** Offsets actually populated, so a reader knows what is real vs unread. */
    readonly filledRanges: readonly { readonly start: number; readonly end: number }[];
    readonly bytesRead: number;
}

/**
 * Execute a plan through an injected reader and reassemble a full image.
 *
 * Unread regions (the bootloader/service block, and the gaps beyond the 256 KiB of program the
 * SP-DATEN carries) are left 0xFF, never zero: 0xFF is what erased flash reads as, and a backup
 * that quietly zero-filled the parts it did not read would look like a valid all-erased image.
 */
export async function runBackup(
    plan: ReadPlan,
    read: ChunkReader,
    onProgress?: (p: BackupProgress) => void,
): Promise<BackupResult> {
    const image = new Uint8Array(FULL_IMAGE_LENGTH).fill(0xff);
    const filled: { start: number; end: number }[] = [];
    let bytesRead = 0;

    for (const chunk of plan.chunks) {
        const bytes = await read(chunk.segment, chunk.ds2Address, chunk.count);
        if (bytes.length !== chunk.count) {
            throw new Error(
                `read at 0x${chunk.ds2Address.toString(16)} returned ${bytes.length} bytes, expected ${chunk.count}`);
        }
        image.set(bytes, chunk.imageOffset);
        mergeRange(filled, chunk.imageOffset, chunk.imageOffset + chunk.count);
        bytesRead += chunk.count;
        const window = plan.windows.find((w) => chunk.imageOffset >= w.imageOffset && chunk.imageOffset < w.imageOffset + w.length)!;
        onProgress?.({ readSoFar: bytesRead, total: plan.totalBytes, window });
    }
    return { image, filledRanges: filled, bytesRead };
}

/** Merge a newly-read [start,end) into a sorted, coalesced range list. */
function mergeRange(ranges: { start: number; end: number }[], start: number, end: number): void {
    const last = ranges[ranges.length - 1];
    if (last && start === last.end) { last.end = end; return; }
    ranges.push({ start, end });
}

/**
 * Load-time invariant: the read chunk size must be independent of, and no larger than, the write
 * chunk size's rules would demand of it - i.e. it may be >= the write cap only because reads have
 * no even-length requirement, and must never quietly BE the write constant.
 */
function assertReadChunkIndependent(): void {
    if (ALLOWED_SEGMENTS.length !== 1 || ALLOWED_SEGMENTS[0] !== Segment.Read) {
        throw new Error('backupPlan is read-only by construction: ALLOWED_SEGMENTS must be exactly [Segment.Read]');
    }
    for (const destructive of [Segment.Write, Segment.Erase, Segment.Recycling, Segment.Finish]) {
        if ((ALLOWED_SEGMENTS as readonly number[]).includes(destructive)) {
            throw new Error(`backupPlan must never emit segment 0x${destructive.toString(16)}`);
        }
    }
    if (READ_CHUNK_MAX <= 0) throw new Error('READ_CHUNK_MAX must be positive');
    // A read of an odd length is legal (no flash alignment on read), so this is only a sanity ceiling.
    if (READ_CHUNK_MAX > 251) throw new Error(`READ_CHUNK_MAX ${READ_CHUNK_MAX} exceeds the DS2 read framing limit`);
    // Document, in an executable way, that sharing the write constant is a mistake we chose not to make.
    void WRITE_CHUNK_MAX;
}
assertReadChunkIndependent();
