/**
 * The read path, exercised end to end with no cable.
 *
 * A mock reader returns slices of a known image - when that image is the real 0401 BIN, a
 * successful reassembly proves the plan's addressing against genuine bytes. The point of a read
 * being non-destructive is that this same code is what would run on a car, so testing it here is
 * testing the thing itself, not a stand-in.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import {
    planFullBackup, runBackup, READ_CHUNK_MAX, type ChunkReader,
} from './backupPlan';
import { IMAGE_WINDOWS, ds2ToImageOffset, FULL_IMAGE_LENGTH, isProtectedImageOffset } from './imageLayout';
import { Segment } from './regionMap';

const IMAGE = process.env.CSL_0401_BIN
    ?? String.raw`C:\Users\kazuh\CSL_0401_Binary_Disassembly_Notes\Full 211323000401PD31_TERRA.bin`;
const haveImage = existsSync(IMAGE);
const maybe = haveImage ? it : it.skip;

/** A reader backed by a full image, translating DS2 addresses the way the ECU would. */
function imageReader(image: Uint8Array): ChunkReader {
    return async (segment, ds2Address, count) => {
        expect(segment).toBe(Segment.Read);
        const offset = ds2ToImageOffset(ds2Address);
        if (offset === undefined) throw new Error(`reader asked for un-mapped 0x${ds2Address.toString(16)}`);
        return image.slice(offset, offset + count);
    };
}

describe('the backup plan', () => {
    it('covers exactly the four conversion windows, 576 KiB, in READ_CHUNK_MAX pieces', () => {
        const plan = planFullBackup();
        expect(plan.totalBytes).toBe(0x90000);
        expect(plan.windows).toBe(IMAGE_WINDOWS);
        // Every chunk is <= the cap, and only the last of each window may be short.
        for (const w of plan.windows) {
            const wChunks = plan.chunks.filter((c) => c.imageOffset >= w.imageOffset && c.imageOffset < w.imageOffset + w.length);
            for (const c of wChunks.slice(0, -1)) expect(c.count).toBe(READ_CHUNK_MAX);
            expect(wChunks.reduce((n, c) => n + c.count, 0)).toBe(w.length);
        }
    });

    it('never plans a read into a protected range', () => {
        for (const c of planFullBackup().chunks) {
            expect(isProtectedImageOffset(c.imageOffset)).toBe(false);
        }
    });

    it('uses the read segment, never erase or write', () => {
        for (const c of planFullBackup().chunks) expect(c.segment).toBe(Segment.Read);
    });

    it('rejects a chunk size above the read cap', () => {
        expect(() => planFullBackup(READ_CHUNK_MAX + 1)).toThrow(/out of range/);
        expect(() => planFullBackup(0)).toThrow(/out of range/);
    });
});

describe('running the backup against the genuine image', () => {
    maybe('reassembles every conversion window byte-for-byte', async () => {
        const image = new Uint8Array(readFileSync(IMAGE));
        const result = await runBackup(planFullBackup(), imageReader(image));
        expect(result.bytesRead).toBe(0x90000);
        for (const w of IMAGE_WINDOWS) {
            const got = result.image.subarray(w.imageOffset, w.imageOffset + w.length);
            const want = image.subarray(w.imageOffset, w.imageOffset + w.length);
            expect(got, `${w.kind}/${w.processor}`).toEqual(want);
        }
    });

    maybe('leaves unread regions as 0xFF, not zero', async () => {
        const image = new Uint8Array(readFileSync(IMAGE));
        const result = await runBackup(planFullBackup(), imageReader(image));
        // The master bootloader (0x0000..0x7FFF) is never read.
        expect(isProtectedImageOffset(0x100)).toBe(true);
        expect(result.image[0x100]).toBe(0xff);
        // The gap past the 256 KiB of program the file carries is also unread.
        expect(result.image[0x50000]).toBe(0xff);
    });

    maybe('reports progress that only ever advances and ends at the total', async () => {
        const image = new Uint8Array(readFileSync(IMAGE));
        let last = 0;
        let final = 0;
        await runBackup(planFullBackup(), imageReader(image), (p) => {
            expect(p.readSoFar).toBeGreaterThan(last);
            last = p.readSoFar;
            final = p.readSoFar;
            expect(p.total).toBe(0x90000);
        });
        expect(final).toBe(0x90000);
    });

    it('fails loudly if a read returns the wrong number of bytes', async () => {
        const shortReader: ChunkReader = async (_s, _a, count) => new Uint8Array(count - 1);
        await expect(runBackup(planFullBackup(), shortReader)).rejects.toThrow(/returned .* expected/);
    });
});

describe('the read cap is independent of the write cap', () => {
    it('is not silently coupled to the write chunk size', async () => {
        // Import lazily so a change that unifies them is visible here.
        const { WRITE_CHUNK_MAX } = await import('./regionMap');
        // They may be equal today, but they are separate symbols; this test exists so that a future
        // change to one is a deliberate change to both.
        expect(READ_CHUNK_MAX).toBe(122);
        expect(WRITE_CHUNK_MAX).toBe(122);
    });
});
