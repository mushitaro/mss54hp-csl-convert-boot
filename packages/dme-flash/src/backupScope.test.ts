/**
 * The parts of the backup path that decide whether a backup can actually restore an ECU.
 *
 * `backupPlan.test.ts` covers the shipped-content plan. These cover the two properties that were
 * added because they are the ones a failed conversion would depend on: that the module cannot emit
 * a destructive segment even if someone edits it, and that a cautious backup covers the whole
 * addressable window rather than only the bytes BMW ships.
 */
import { describe, it, expect } from 'vitest';
import {
    planFullBackup, planCautiousBackup, buildReadPayload, summariseContent,
    READ_CHUNK_MAX, MEASURED_MS_PER_BYTE_9600,
} from './backupPlan';
import { Segment, resolveFlashAddress, windowsForSegment } from './regionMap';
import { IMAGE_WINDOWS } from './imageLayout';

describe('read-only by construction', () => {
    it('refuses to encode a payload for any destructive segment', () => {
        for (const segment of [Segment.Write, Segment.Erase, Segment.Recycling, Segment.Finish]) {
            expect(() => buildReadPayload({ segment, ds2Address: 0x500000, count: 16, imageOffset: 0 }))
                .toThrow(/not one this module may send/);
        }
    });

    it('encodes segment, 24-bit address and count', () => {
        expect([...buildReadPayload({ segment: Segment.Read, ds2Address: 0xd3f2a0, count: 122, imageOffset: 0 })])
            .toEqual([0x00, 0xd3, 0xf2, 0xa0, 122]);
    });

    it('refuses a count the DME could not answer', () => {
        const base = { segment: Segment.Read, ds2Address: 0x500000, imageOffset: 0 };
        expect(() => buildReadPayload({ ...base, count: 123 })).toThrow(/outside 1\.\./);
        expect(() => buildReadPayload({ ...base, count: 0 })).toThrow(/outside 1\.\./);
    });

    it('every chunk of every plan uses the read segment', () => {
        for (const plan of [planFullBackup(), planCautiousBackup()]) {
            for (const c of plan.chunks) expect(c.segment).toBe(Segment.Read);
        }
    });
});

describe('cautious backup - the one that can restore a fully erased window', () => {
    const shipped = planFullBackup();
    const cautious = planCautiousBackup();

    it('covers the full addressable extent, not just what SP-DATEN fills', () => {
        // Shipped content: 2 x 256 KiB program + 2 x 32 KiB calibration.
        expect(shipped.totalBytes).toBe(0x90000);
        // Addressable: 2 x 448 KiB program + 2 x 32 KiB calibration.
        expect(cautious.totalBytes).toBe(2 * 0x70000 + 2 * 0x8000);
        expect(cautious.totalBytes).toBeGreaterThan(shipped.totalBytes);
        expect(cautious.fullWindowExtent).toBe(true);
        expect(shipped.fullWindowExtent).toBe(false);
    });

    it('reaches the last addressable byte of every window', () => {
        for (const descriptor of windowsForSegment(Segment.Read)) {
            const nibbles = IMAGE_WINDOWS.map((w) => (w.ds2Address >>> 20) & 0xf);
            if (!nibbles.includes(descriptor.nibble)) continue;
            const lastByte = descriptor.baseAddress + descriptor.end - 1;
            const covering = cautious.chunks.find(
                (c) => lastByte >= c.ds2Address && lastByte < c.ds2Address + c.count);
            expect(covering, `nibble 0x${descriptor.nibble.toString(16)}`).toBeDefined();
        }
    });

    it('plans only addresses the firmware accepts', () => {
        for (const c of cautious.chunks) {
            expect(resolveFlashAddress(c.segment, c.ds2Address, c.count).accepted,
                `0x${c.ds2Address.toString(16)}`).toBe(true);
        }
    });

    it('marks bytes that have no home in a 1 MiB image rather than mis-placing them', () => {
        // Beyond the 256 KiB of shipped program there is no image offset to write to. Those chunks
        // must be flagged, not folded into the image at a made-up offset.
        const unmapped = cautious.chunks.filter((c) => c.imageOffset === -1);
        expect(unmapped.length).toBeGreaterThan(0);
        for (const c of unmapped) {
            const nibble = (c.ds2Address >>> 20) & 0xf;
            expect([0x5, 0xd]).toContain(nibble); // only the oversized program windows
        }
        // Every mapped chunk lands inside a real window.
        for (const c of cautious.chunks.filter((x) => x.imageOffset !== -1)) {
            const w = IMAGE_WINDOWS.find(
                (x) => c.imageOffset >= x.imageOffset && c.imageOffset < x.imageOffset + x.length);
            expect(w, `0x${c.ds2Address.toString(16)}`).toBeDefined();
        }
    });

    it('is honest about how long it takes', () => {
        // The reference measured 65,536 B in 122.9 s at 9600 baud.
        expect(MEASURED_MS_PER_BYTE_9600).toBeCloseTo(1.875, 2);
        const minutes = cautious.estimatedMsAt9600 / 60_000;
        expect(minutes).toBeGreaterThan(25);   // ~30 min at 9600 - worth telling the operator
        expect(cautious.estimatedMsAt9600).toBeGreaterThan(shipped.estimatedMsAt9600);
    });

    it('honours a reduced chunk size for a marginal link', () => {
        const slow = planCautiousBackup(32);
        expect(Math.max(...slow.chunks.map((c) => c.count))).toBe(32);
        expect(slow.totalBytes).toBe(cautious.totalBytes);
        expect(() => planCautiousBackup(READ_CHUNK_MAX + 1)).toThrow(/out of range/);
    });
});

describe('content summary - the measurement the erase question needs', () => {
    it('finds the real extent inside an otherwise erased window', () => {
        const buf = new Uint8Array(1000).fill(0xff);
        buf.set([1, 2, 3], 10);
        expect(summariseContent(buf)).toEqual({ totalBytes: 1000, erasedBytes: 997, contentEnd: 13 });
    });

    it('reports a fully erased window as having no content', () => {
        expect(summariseContent(new Uint8Array(256).fill(0xff)))
            .toEqual({ totalBytes: 256, erasedBytes: 256, contentEnd: 0 });
    });
});
