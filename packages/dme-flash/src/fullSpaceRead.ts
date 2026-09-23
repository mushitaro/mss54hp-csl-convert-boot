/**
 * Reading a processor's entire flash, including the three sectors no other path can reach.
 *
 * `backupPlan.ts` captures the four conversion windows (576 KiB) using segment 0x00. That is the
 * right backup before a normal conversion, but it cannot see the bootloader, the Free Identifiers
 * block or the tail guard - and those are exactly what a bootloader replacement puts at risk.
 *
 * The firmware offers a linear 24-bit read segment that covers the whole address space:
 * 0x05 for the master, 0x0C for the slave (the reference tool calls them Linear24BitMaster and
 * Linear24BitSlave). Command 0x06's dispatch sends those to a branch gated on bit 2 of 0xFFD003,
 * an access bit that command 0x90 grants, and answers 0xA2 when it is not set.
 *
 * ## Why this is deliberately bounded to 512 KiB
 *
 * The region table entry really is 0x000000-0xFFFFFF, all 16 MB. Reading all of it would walk
 * over 0xFFF000-0xFFFFFF, which is the SIM, QSM, TPU and QADC register block of the ECU we are
 * talking to. Reading a serial status or data register has side effects - it clears flags and
 * pops receive buffers - and unimplemented module space can bus-error. A backup that disturbs
 * the machine it is backing up is not a backup, so this module reads flash and nothing else.
 *
 * ## Two allowlists, kept apart on purpose
 *
 * `backupPlan.ALLOWED_SEGMENTS` stays exactly [Segment.Read]. This module has its own list
 * containing only the two linear read segments. Neither can grow into the other, and a load-time
 * check fails the package if either ever contains a segment that can modify flash.
 *
 * Pure: produces a plan and reassembles bytes from an injected reader. No transport.
 */
import { Segment } from './regionMap';
import { FULL_IMAGE_LENGTH, type Processor } from './imageLayout';
import { READ_CHUNK_MAX, type ChunkReader, type ContentSummary, summariseContent } from './backupPlan';
import { LinearReadSegment, buildReadTelegram } from './telegrams';

/** Bytes of flash per processor - one Am29F400BB. */
export const PROCESSOR_FLASH_LENGTH = 0x80000;

/** Segments this module may put in a telegram. Read-only, and disjoint from every write path. */
export const RAW_READ_ALLOWED: readonly number[] = [LinearReadSegment.master, LinearReadSegment.slave] as const;

/**
 * The censored window. The firmware substitutes 0xFF for reads of 0x4000-0x4017 (handler 0x201A
 * compares the resolved address against 0x4000 and 0x4018), so those 24 bytes can never be
 * captured. Recorded here so a byte-compare of two reads does not treat it as a fault.
 */
export const CENSORED_RANGE = { start: 0x4000, end: 0x4018 } as const;

export interface RawReadChunk {
    readonly segment: number;
    /** Linear address inside the processor's own flash, 0x000000-0x07FFFF. */
    readonly address: number;
    readonly count: number;
    /** Offset in the reassembled 1 MiB full image where these bytes land. */
    readonly imageOffset: number;
}

export interface RawReadPlan {
    readonly processor: Processor;
    readonly segment: number;
    readonly start: number;
    readonly end: number;
    readonly totalBytes: number;
    readonly chunks: readonly RawReadChunk[];
}

/** Full-image offset of a processor's flash base. */
export function processorImageBase(processor: Processor): number {
    return processor === 'master' ? 0x00000 : 0x80000;
}

/**
 * Plan a linear read of one processor's flash.
 *
 * Defaults to the whole 512 KiB, which is the capture a bootloader replacement needs. The bounds
 * are settable so a caller can re-read just SA0 to confirm a write, without a second full pass.
 */
export function planFullSpaceRead(
    processor: Processor,
    start = 0,
    end = PROCESSOR_FLASH_LENGTH,
    chunkSize = READ_CHUNK_MAX,
): RawReadPlan {
    if (chunkSize <= 0 || chunkSize > READ_CHUNK_MAX) {
        throw new Error(`read chunk size ${chunkSize} out of range (1..${READ_CHUNK_MAX})`);
    }
    if (start < 0 || end > PROCESSOR_FLASH_LENGTH || end <= start) {
        throw new Error(
            `range 0x${start.toString(16)}-0x${end.toString(16)} is outside the processor's`
            + ` 0x0-0x${PROCESSOR_FLASH_LENGTH.toString(16)} flash`);
    }
    const segment = processor === 'master' ? LinearReadSegment.master : LinearReadSegment.slave;
    const base = processorImageBase(processor);
    const chunks: RawReadChunk[] = [];
    for (let address = start; address < end; address += chunkSize) {
        const count = Math.min(chunkSize, end - address);
        chunks.push({ segment, address, count, imageOffset: base + address });
    }
    return { processor, segment, start, end, totalBytes: end - start, chunks };
}

/** Both processors, in master-then-slave order: the capture to take before touching anything. */
export function planWholeDmeRead(chunkSize = READ_CHUNK_MAX): RawReadPlan[] {
    return [planFullSpaceRead('master', 0, PROCESSOR_FLASH_LENGTH, chunkSize),
        planFullSpaceRead('slave', 0, PROCESSOR_FLASH_LENGTH, chunkSize)];
}

/** The 6-byte read telegram for one chunk, refusing any segment this module may not send. */
export function buildRawReadTelegram(chunk: RawReadChunk): Uint8Array {
    if (!RAW_READ_ALLOWED.includes(chunk.segment)) {
        throw new Error(`segment 0x${chunk.segment.toString(16)} is not one this module may send`);
    }
    if (chunk.count <= 0 || chunk.count > READ_CHUNK_MAX) {
        throw new Error(`read count ${chunk.count} outside 1..${READ_CHUNK_MAX}`);
    }
    return buildReadTelegram(chunk.segment, chunk.address, chunk.count);
}

export interface RawReadProgress {
    readonly bytesRead: number;
    readonly totalBytes: number;
    readonly address: number;
}

export interface RawReadResult {
    readonly processor: Processor;
    readonly bytes: Uint8Array;
    readonly summary: ContentSummary;
}

/**
 * Execute a plan against an injected reader and reassemble the bytes.
 *
 * The buffer starts as 0xFF, not zero: erased flash reads as 0xFF, so a short read leaves
 * something indistinguishable from erased rather than something that looks like valid zeros.
 */
export async function runFullSpaceRead(
    plan: RawReadPlan,
    read: ChunkReader,
    onProgress?: (p: RawReadProgress) => void,
): Promise<RawReadResult> {
    const bytes = new Uint8Array(plan.totalBytes).fill(0xff);
    let bytesRead = 0;
    for (const chunk of plan.chunks) {
        const got = await read(chunk.segment, chunk.address, chunk.count);
        if (got.length !== chunk.count) {
            throw new Error(
                `read at 0x${chunk.address.toString(16)} returned ${got.length} bytes, expected ${chunk.count}`);
        }
        bytes.set(got, chunk.address - plan.start);
        bytesRead += got.length;
        onProgress?.({ bytesRead, totalBytes: plan.totalBytes, address: chunk.address });
    }
    return { processor: plan.processor, bytes, summary: summariseContent(bytes) };
}

/** Place a processor's captured flash into a 1 MiB full image buffer. */
export function placeIntoFullImage(image: Uint8Array, result: RawReadResult, start = 0): void {
    if (image.length !== FULL_IMAGE_LENGTH) {
        throw new Error(`full image buffer must be ${FULL_IMAGE_LENGTH} bytes, got ${image.length}`);
    }
    image.set(result.bytes, processorImageBase(result.processor) + start);
}

export interface ReadComparison {
    readonly identical: boolean;
    /** Offsets that differ, excluding the censored window. */
    readonly differingOffsets: readonly number[];
}

/**
 * Compare two independent captures.
 *
 * A single pass is not a backup: a link that drops or duplicates a chunk produces a plausible
 * file. Two passes that agree everywhere outside the censored window is the cheapest evidence
 * that the read path is faithful - and it costs nothing but time.
 */
export function compareReads(a: Uint8Array, b: Uint8Array): ReadComparison {
    const differing: number[] = [];
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        if (a[i] === b[i]) continue;
        if (i >= CENSORED_RANGE.start && i < CENSORED_RANGE.end) continue;
        differing.push(i);
    }
    if (a.length !== b.length) differing.push(n);
    return { identical: differing.length === 0, differingOffsets: differing };
}

/**
 * Load-time invariant: this module reads and never writes.
 *
 * Stated as executable code because the segments it uses are the most powerful ones the firmware
 * exposes - they address the whole 16 MB space - and the only thing keeping that safe is that
 * they are used with command 0x06.
 */
function assertLinearReadIsReadOnly(): void {
    if (RAW_READ_ALLOWED.length !== 2) throw new Error('RAW_READ_ALLOWED must hold exactly the two linear read segments');
    for (const destructive of [Segment.Write, Segment.Erase, Segment.Recycling, Segment.Finish]) {
        if (RAW_READ_ALLOWED.includes(destructive)) {
            throw new Error(`fullSpaceRead must never emit segment 0x${destructive.toString(16)}`);
        }
    }
    if (PROCESSOR_FLASH_LENGTH * 2 !== FULL_IMAGE_LENGTH) {
        throw new Error('two processors of flash must make exactly one full image');
    }
}
assertLinearReadIsReadOnly();
