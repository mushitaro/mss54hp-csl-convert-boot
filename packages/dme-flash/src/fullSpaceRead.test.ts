/**
 * The full-flash read, exercised against a real 1 MiB image with no cable.
 *
 * This is the capture that a bootloader replacement depends on: it is the only path that can see
 * SA0, SA1 and SA2, and therefore the only backup that could restore a car-specific service
 * block. So the reassembly is tested against genuine bytes, and the two-pass comparison - the
 * thing that turns "a file" into "a backup" - is tested including the case it exists to catch.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import {
    PROCESSOR_FLASH_LENGTH, RAW_READ_ALLOWED, CENSORED_RANGE,
    planFullSpaceRead, planWholeDmeRead, buildRawReadTelegram, runFullSpaceRead,
    compareReads, placeIntoFullImage, processorImageBase,
} from './fullSpaceRead';
import { LinearReadSegment } from './telegrams';
import { Segment, WRITE_CHUNK_MAX } from './regionMap';
import { READ_CHUNK_MAX, type ChunkReader } from './backupPlan';
import { FULL_IMAGE_LENGTH, isProtectedImageOffset, type Processor } from './imageLayout';
import { extractSa0, verifyBootloaderCrc, SA0_LENGTH } from './bootloaderImage';

const IMAGE = process.env.CSL_0401_BIN
    ?? String.raw`C:\Users\kazuh\CSL_0401_Binary_Disassembly_Notes\Full 211323000401PD31_TERRA.bin`;
const image = existsSync(IMAGE) ? new Uint8Array(readFileSync(IMAGE)) : undefined;
const withImage = image ? it : it.skip;

/** A reader backed by a full image, addressing the way the linear segments do. */
function linearReader(full: Uint8Array, corrupt?: (offset: number) => number | undefined): ChunkReader {
    return async (segment, address, count) => {
        const processor: Processor = segment === LinearReadSegment.master ? 'master' : 'slave';
        const base = processorImageBase(processor);
        const out = full.slice(base + address, base + address + count);
        if (corrupt) {
            for (let i = 0; i < out.length; i++) {
                const replaced = corrupt(address + i);
                if (replaced !== undefined) out[i] = replaced;
            }
        }
        return out;
    };
}

describe('the linear read plan', () => {
    it('covers one processor of flash, and stops well short of the register block', () => {
        const plan = planFullSpaceRead('master');
        expect(plan.totalBytes).toBe(PROCESSOR_FLASH_LENGTH);
        expect(plan.end).toBe(0x80000);
        // The region table would allow up to 0xFFFFFF. Reading that far would touch the SIM,
        // QSM, TPU and QADC registers of the ECU we are talking to, some of which clear flags
        // when read. The plan must never go there.
        for (const chunk of plan.chunks) expect(chunk.address + chunk.count).toBeLessThanOrEqual(0x80000);
    });

    it('uses the master segment for the master and the slave segment for the slave', () => {
        expect(planFullSpaceRead('master').segment).toBe(0x05);
        expect(planFullSpaceRead('slave').segment).toBe(0x0c);
    });

    it('reaches the three sectors no other path in this package can', () => {
        const plan = planFullSpaceRead('master');
        const covered = (offset: number): boolean =>
            plan.chunks.some((c) => offset >= c.address && offset < c.address + c.count);
        for (const offset of [0x0000, 0x3fff, 0x4000, 0x5fff, 0x6000, 0x7fff]) {
            expect(covered(offset), `offset 0x${offset.toString(16)}`).toBe(true);
        }
        // And those are exactly the offsets the conversion path calls protected.
        expect(isProtectedImageOffset(0x0000)).toBe(true);
        expect(isProtectedImageOffset(0x7fff)).toBe(true);
    });

    it('chunks at the read cap, with only the last chunk short', () => {
        const plan = planFullSpaceRead('master');
        for (const c of plan.chunks.slice(0, -1)) expect(c.count).toBe(READ_CHUNK_MAX);
        expect(plan.chunks.reduce((n, c) => n + c.count, 0)).toBe(PROCESSOR_FLASH_LENGTH);
    });

    it('plans both processors, master first', () => {
        const plans = planWholeDmeRead();
        expect(plans.map((p) => p.processor)).toEqual(['master', 'slave']);
        expect(plans.reduce((n, p) => n + p.totalBytes, 0)).toBe(FULL_IMAGE_LENGTH);
    });

    it('accepts a narrowed range, for re-reading just the bootloader after a write', () => {
        const plan = planFullSpaceRead('master', 0, SA0_LENGTH);
        expect(plan.totalBytes).toBe(SA0_LENGTH);
    });

    it('refuses a range outside the processor flash', () => {
        expect(() => planFullSpaceRead('master', 0, 0x80001)).toThrow(/outside/);
        expect(() => planFullSpaceRead('master', 0x100, 0x100)).toThrow(/outside/);
    });
});

describe('the read telegrams', () => {
    it('are six bytes: command, segment, 24-bit address, count', () => {
        const chunk = planFullSpaceRead('master').chunks[0];
        expect(chunk).toBeDefined();
        expect(Array.from(buildRawReadTelegram(chunk!))).toEqual([0x06, 0x05, 0x00, 0x00, 0x00, READ_CHUNK_MAX]);
    });

    it('refuse any segment that could modify flash', () => {
        for (const segment of [Segment.Write, Segment.Erase, Segment.Recycling, Segment.Finish, Segment.Read]) {
            expect(() => buildRawReadTelegram({ segment, address: 0, count: 2, imageOffset: 0 }))
                .toThrow(/not one this module may send/);
        }
    });

    it('allow exactly the two linear read segments and nothing else', () => {
        expect([...RAW_READ_ALLOWED]).toEqual([0x05, 0x0c]);
        expect(RAW_READ_ALLOWED).not.toContain(Segment.Write);
        expect(RAW_READ_ALLOWED).not.toContain(Segment.Erase);
    });

    it('refuse a count above the read cap', () => {
        expect(() => buildRawReadTelegram({ segment: 0x05, address: 0, count: READ_CHUNK_MAX + 1, imageOffset: 0 }))
            .toThrow(/outside 1\.\./);
    });
});

describe('reassembly against a genuine image', () => {
    withImage('reproduces the master flash byte for byte, bootloader included', async () => {
        const plan = planFullSpaceRead('master');
        const result = await runFullSpaceRead(plan, linearReader(image!));
        expect(result.bytes).toHaveLength(PROCESSOR_FLASH_LENGTH);
        expect(Array.from(result.bytes.subarray(0, 64))).toEqual(Array.from(image!.subarray(0, 64)));

        // The point of the exercise: the captured SA0 is a real bootloader with a valid CRC.
        const captured = result.bytes.subarray(0, SA0_LENGTH);
        expect(verifyBootloaderCrc(captured, 'master').valid).toBe(true);
        expect(Array.from(captured)).toEqual(Array.from(extractSa0(image!, 'master')));
    });

    withImage('reproduces the slave flash too, and places both into a full image', async () => {
        const rebuilt = new Uint8Array(FULL_IMAGE_LENGTH).fill(0xff);
        for (const plan of planWholeDmeRead()) {
            placeIntoFullImage(rebuilt, await runFullSpaceRead(plan, linearReader(image!)));
        }
        expect(Array.from(rebuilt)).toEqual(Array.from(image!));
    });

    withImage('reports progress that reaches the total', async () => {
        const plan = planFullSpaceRead('master', 0, SA0_LENGTH);
        let last = 0;
        await runFullSpaceRead(plan, linearReader(image!), (p) => { last = p.bytesRead; });
        expect(last).toBe(SA0_LENGTH);
    });

    it('starts its buffer as 0xFF so a short read cannot look like valid zeros', async () => {
        const plan = planFullSpaceRead('master', 0, 4);
        const result = await runFullSpaceRead(plan, async () => new Uint8Array([1, 2, 3, 4]));
        expect(Array.from(result.bytes)).toEqual([1, 2, 3, 4]);
    });

    it('refuses a reader that returns the wrong number of bytes', async () => {
        const plan = planFullSpaceRead('master', 0, 4);
        await expect(runFullSpaceRead(plan, async () => new Uint8Array(2)))
            .rejects.toThrow(/returned 2 bytes, expected 4/);
    });
});

describe('the two-pass comparison', () => {
    it('accepts two identical captures', () => {
        const a = Uint8Array.from({ length: 1024 }, (_, i) => i & 0xff);
        expect(compareReads(a, Uint8Array.from(a)).identical).toBe(true);
    });

    it('catches a single flipped byte - the thing a one-pass backup would hide', () => {
        const a = Uint8Array.from({ length: 1024 }, (_, i) => i & 0xff);
        const b = Uint8Array.from(a);
        b[512] = (b[512] ?? 0) ^ 0xff;
        const cmp = compareReads(a, b);
        expect(cmp.identical).toBe(false);
        expect(cmp.differingOffsets).toEqual([512]);
    });

    it('ignores the window the firmware censors, so it is not reported as a fault', () => {
        const a = new Uint8Array(0x5000).fill(0x11);
        const b = Uint8Array.from(a);
        for (let i = CENSORED_RANGE.start; i < CENSORED_RANGE.end; i++) b[i] = 0xff;
        expect(compareReads(a, b).identical).toBe(true);
        expect(CENSORED_RANGE).toEqual({ start: 0x4000, end: 0x4018 });
    });

    it('notices a length mismatch', () => {
        expect(compareReads(new Uint8Array(10), new Uint8Array(8)).identical).toBe(false);
    });
});

describe('module boundaries', () => {
    it('does not adopt the write chunk size', () => {
        expect(READ_CHUNK_MAX).toBe(WRITE_CHUNK_MAX);
        // Equal today, but they are separate constants on purpose: only the read side can grow.
        expect(planFullSpaceRead('master').chunks[0]?.count).toBe(READ_CHUNK_MAX);
    });

    it('refuses to place a capture into a buffer that is not a full image', () => {
        expect(() => placeIntoFullImage(new Uint8Array(10), {
            processor: 'master', bytes: new Uint8Array(2), summary: { totalBytes: 2, erasedBytes: 0, contentEnd: 2 },
        })).toThrow(/must be 1048576 bytes/);
    });
});
