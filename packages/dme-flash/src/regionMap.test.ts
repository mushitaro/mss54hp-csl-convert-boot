/**
 * Locks the facts in docs/region-map.md.
 *
 * Two kinds of test live here and the distinction matters:
 *
 *  1. Tests that re-derive the generated table straight from the firmware image. These are the
 *     reason the table is generated rather than typed: a transcription error would be an address
 *     the flasher accepts and the ECU refuses - or, on the erase path, one it accepts and should
 *     not have. They skip (loudly) when the image is not on this machine.
 *
 *  2. Tests that pin the interpretation against constants which have flashed a real vehicle.
 *     Those come from the reference tuner and were proven with read-back verification, so they
 *     are evidence about the ECU, not about this code.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import {
    REGION_TABLE, REGION_TABLE_BASE, REGION_TABLE_STRIDE, REGION_TABLE_MAX_ENTRIES,
    FIRMWARE_BLOCK_CAP,
} from './regionTable.generated';
import {
    Segment, WRITE_CHUNK_MAX, resolveFlashAddress, isAddressAccepted, windowsForSegment,
    RESPONSE_ADDRESS_REJECTED,
} from './regionMap';

const BIN = process.env.CSL_0401_BIN
    ?? String.raw`C:\Users\kazuh\CSL_0401_Binary_Disassembly_Notes\Full 211323000401PD31_TERRA.bin`;

describe('region table, re-derived from the firmware image', () => {
    const haveImage = existsSync(BIN);
    const maybe = haveImage ? it : it.skip;

    maybe('matches the generated file byte for byte', () => {
        const image = readFileSync(BIN);
        expect(image.length).toBe(0x100000);
        for (let i = 0; i < REGION_TABLE_MAX_ENTRIES; i++) {
            const o = REGION_TABLE_BASE + i * REGION_TABLE_STRIDE;
            expect(REGION_TABLE[i], `entry ${i}`).toEqual({
                id: image[o],
                variant: image[o + 1],
                start: image.readUInt32BE(o + 2),
                end: image.readUInt32BE(o + 6),
            });
        }
    });

    maybe('the table base is the immediate loaded by flash_req_parse', () => {
        // 0028A4: movea.l #$3ad6, a1   ->  bytes 22 7c 00 00 3a d6
        const image = readFileSync(BIN);
        expect([...image.subarray(0x28a4, 0x28aa)])
            .toEqual([0x22, 0x7c, 0x00, 0x00, 0x3a, 0xd6]);
        expect(image.readUInt32BE(0x28a6)).toBe(REGION_TABLE_BASE);
    });

    maybe('the entry-count bound is the immediate compared in the walk loop', () => {
        // 002920: cmpi.b #$41, d3  ->  bytes 0c 03 00 41
        const image = readFileSync(BIN);
        expect([...image.subarray(0x2920, 0x2924)]).toEqual([0x0c, 0x03, 0x00, 0x41]);
        expect(REGION_TABLE_MAX_ENTRIES).toBe(0x41);
    });
});

describe('write chunk size', () => {
    it('is the largest even value DS2 allows, not the firmware block cap', () => {
        expect(WRITE_CHUNK_MAX).toBe(122);
        expect(WRITE_CHUNK_MAX % 2).toBe(0);
        expect(WRITE_CHUNK_MAX).toBeLessThanOrEqual(123);
        expect(WRITE_CHUNK_MAX).toBeLessThan(FIRMWARE_BLOCK_CAP);
    });
});

describe('segments', () => {
    it('every DS2 programming control byte appears as a region_table id', () => {
        for (const [name, id] of Object.entries(Segment)) {
            expect(REGION_TABLE.some((e) => e.id === id), `${name} (0x${id.toString(16)})`).toBe(true);
        }
    });
});

describe('constants proven on a real vehicle', () => {
    // The reference tuner erases with segment 6 and writes with segment 2 at this address, and
    // has done so on a car with read-back verification. If our reading of the table refused it,
    // the reading would be wrong.
    const DATA_PROGRAMMING_SESSION_ADDRESS = 0xa02000;

    it('accepts the data programming session address for erase and write', () => {
        for (const segment of [Segment.Erase, Segment.Write]) {
            const r = resolveFlashAddress(segment, DATA_PROGRAMMING_SESSION_ADDRESS);
            expect(r.accepted, `segment 0x${segment.toString(16)}`).toBe(true);
            if (!r.accepted) return;
            expect(r.entry.variant).toBe(0xa0);
            expect(r.offset).toBe(0x2000);
            expect(r.entry.end - r.entry.start).toBe(32768);
        }
    });

    it('accepts the recycle-only and recycle-off magic addresses on the recycling segment', () => {
        for (const address of [0x424151, 0x424152]) {
            const r = resolveFlashAddress(Segment.Recycling, address);
            expect(r.accepted, `0x${address.toString(16)}`).toBe(true);
            if (!r.accepted) return;
            expect(r.entry.variant).toBe(0xff);
            expect(r.entry.start).toBe(0x424150);
            expect(r.entry.end).toBe(0x424160);
        }
    });

    it('places calibration data where the reference layout puts it: 32 KiB per processor', () => {
        // Mss54HpDataTuneLayout: master { 0x200000, 32768 }, slave { 0xA00000, 32768 }
        for (const [address, processor] of [[0x200000, 'master'], [0xa00000, 'slave']] as const) {
            const r = resolveFlashAddress(Segment.Read, address);
            expect(r.accepted).toBe(true);
            if (!r.accepted) return;
            expect(r.entry.end - r.entry.start).toBe(32768);
            const w = windowsForSegment(Segment.Read).find((x) => x.baseAddress === address);
            expect(w?.processor).toBe(processor);
        }
        // The last byte of the 32 KiB block is still inside; one past it is not.
        expect(isAddressAccepted(Segment.Write, 0x200000 + 32767)).toBe(true);
        expect(isAddressAccepted(Segment.Write, 0x200000 + 32768)).toBe(false);
    });
});

describe('the AIF guard sector is locked by the firmware itself', () => {
    // Entries id 0x03 and 0x0A carry start=0x6000, end=0x2000. end <= start can never satisfy
    // `start <= addr < end`, so these segments reject every address. Our own protected-region
    // guard is therefore a second line, not the only one.
    it.each([0x03, 0x0a])('segment 0x%s refuses every address', (segment) => {
        for (const address of [0x0000, 0x2000, 0x6000, 0x6100, 0x7fff, 0xffffff]) {
            const r = resolveFlashAddress(segment, address);
            expect(r.accepted, `0x${address.toString(16)}`).toBe(false);
            if (r.accepted) return;
            expect(r.kind).toBe('window-disabled');
        }
    });
});

describe('address resolution mirrors flash_req_parse', () => {
    it('refuses an unmapped nibble with no-entry (0x7 and 0xF are absent from the table)', () => {
        for (const nibble of [0x7, 0xf]) {
            const r = resolveFlashAddress(Segment.Write, nibble << 20);
            expect(r.accepted, `nibble 0x${nibble.toString(16)}`).toBe(false);
            if (r.accepted) return;
            expect(r.kind).toBe('no-entry');
        }
    });

    it('clamps the length to the window end, then to the firmware cap', () => {
        // Two bytes short of the end of the 32 KiB master data window.
        const nearEnd = resolveFlashAddress(Segment.Write, 0x200000 + 32766, FIRMWARE_BLOCK_CAP);
        expect(nearEnd.accepted).toBe(true);
        if (!nearEnd.accepted) return;
        expect(nearEnd.maxLength).toBe(2);

        // Deep inside the window a full-cap request survives, and an over-long one is capped.
        const deep = resolveFlashAddress(Segment.Write, 0x200000, 0x1000);
        expect(deep.accepted).toBe(true);
        if (!deep.accepted) return;
        expect(deep.maxLength).toBe(FIRMWARE_BLOCK_CAP);
    });

    it('reports out-of-range with the status byte the firmware answers', () => {
        // Nibble 0x3 is a 2 KiB window; 0x4000 is past its end.
        const r = resolveFlashAddress(Segment.Write, 0x300000 + 0x4000);
        expect(r.accepted).toBe(false);
        if (r.accepted) return;
        expect(r.kind).toBe('out-of-range');
        expect(r.reason).toContain(RESPONSE_ADDRESS_REJECTED.toString(16));
    });
});

describe('the windows a CSL conversion has to write', () => {
    it('exposes a 448 KiB program window per processor, addressable for erase and write', () => {
        for (const [nibble, processor] of [[0x5, 'master'], [0xd, 'slave']] as const) {
            for (const segment of [Segment.Read, Segment.Erase, Segment.Write]) {
                const w = windowsForSegment(segment).find((x) => x.nibble === nibble);
                expect(w, `segment 0x${segment.toString(16)} nibble 0x${nibble.toString(16)}`).toBeDefined();
                expect(w?.size).toBe(458752);
                expect(w?.processor).toBe(processor);
            }
        }
    });

    it('has exactly four windows worth writing for a conversion: program and data, per processor', () => {
        const write = windowsForSegment(Segment.Write);
        const conversion = write.filter((w) => w.size === 458752 || w.size === 32768);
        expect(conversion.map((w) => [w.nibble, w.size]))
            .toEqual([[0x2, 32768], [0x5, 458752], [0xa, 32768], [0xd, 458752]]);
    });

    it('mirrors master and slave window sizes exactly', () => {
        const write = windowsForSegment(Segment.Write);
        for (const w of write.filter((x) => x.processor === 'master')) {
            const mirror = write.find((x) => x.nibble === w.nibble + 8);
            expect(mirror?.size, `nibble 0x${w.nibble.toString(16)} mirror`).toBe(w.size);
        }
    });

    it('finish segment nibble 3 is the one documented asymmetry', () => {
        // Every other segment gives nibble 0x3 a 2 KiB window; Finish gives it 8 KiB. If this
        // ever starts passing as symmetric, the table was re-read wrongly.
        const finish3 = windowsForSegment(Segment.Finish).find((w) => w.nibble === 0x3);
        const write3 = windowsForSegment(Segment.Write).find((w) => w.nibble === 0x3);
        expect(write3?.size).toBe(2048);
        expect(finish3?.size).toBe(8192);
    });
});
