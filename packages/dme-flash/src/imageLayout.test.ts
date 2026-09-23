/**
 * The layout is pinned by placing genuine BMW files against a real 0401 image. If a constant here
 * drifts, these stop matching - which is the only way to notice, because a wrong offset produces
 * bytes that look entirely reasonable right up until they are flashed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseAustauschDatei, crc16Arc } from './paband';
import {
    IMAGE_WINDOWS, FULL_IMAGE_LENGTH, ds2ToImageOffset, imageOffsetToDs2,
    isProtectedImageOffset, windowFor, describeImageOffset, describeImageOffsets,
    PROTECTED_IMAGE_RANGES,
} from './imageLayout';

const SP_DATEN_MSS54 = process.env.SP_DATEN_MSS54
    ?? String.raw`C:\Users\kazuh\E46M3SMG2_TuningTool\E46_v74\data\MSS54`;
const IMAGE = process.env.CSL_0401_BIN
    ?? String.raw`C:\Users\kazuh\CSL_0401_Binary_Disassembly_Notes\Full 211323000401PD31_TERRA.bin`;

const haveBoth = existsSync(SP_DATEN_MSS54) && existsSync(IMAGE);
const maybe = haveBoth ? it : it.skip;

describe('address translation', () => {
    it('round-trips every window boundary', () => {
        for (const w of IMAGE_WINDOWS) {
            for (const delta of [0, 1, w.length - 1]) {
                const off = ds2ToImageOffset(w.ds2Address + delta);
                expect(off).toBe(w.imageOffset + delta);
                expect(imageOffsetToDs2(off!)).toBe(w.ds2Address + delta);
            }
            // One past the end belongs to no window.
            expect(ds2ToImageOffset(w.ds2Address + w.length)).toBeUndefined();
        }
    });

    it('reports no window for the bootloader region, which has no conversion target', () => {
        expect(imageOffsetToDs2(0x0000)).toBeUndefined();
        expect(imageOffsetToDs2(0x7fff)).toBeUndefined();
        expect(isProtectedImageOffset(0x0000)).toBe(true);
        expect(isProtectedImageOffset(0x7fff)).toBe(true);
        expect(isProtectedImageOffset(0x8000)).toBe(false);
        expect(isProtectedImageOffset(0x80000)).toBe(true);
        expect(isProtectedImageOffset(0x88000)).toBe(false);
    });

    it('covers 576 KiB of a 1 MiB image and never overlaps a protected range', () => {
        // 2 x 32 KiB calibration + 2 x 256 KiB program.
        const total = IMAGE_WINDOWS.reduce((n, w) => n + w.length, 0);
        expect(total).toBe(0x90000);
        expect(total).toBeLessThan(FULL_IMAGE_LENGTH);
        const seen = new Set<number>();
        for (const w of IMAGE_WINDOWS) {
            for (let o = w.imageOffset; o < w.imageOffset + w.length; o += 0x1000) {
                expect(isProtectedImageOffset(o)).toBe(false);
                expect(seen.has(o)).toBe(false);
                seen.add(o);
            }
        }
    });
});

describe('genuine SP-DATEN files land exactly where this layout says they do', () => {
    maybe('the CSL 0401 program sits at the program windows, differing only by a known modification', () => {
        const image = readFileSync(IMAGE);
        expect(image.length).toBe(FULL_IMAGE_LENGTH);
        const pa = parseAustauschDatei(readFileSync(join(SP_DATEN_MSS54, '7837340A.0PA')));

        let differing = 0;
        for (const section of pa.sections) {
            const offset = ds2ToImageOffset(section.address);
            expect(offset, `section 0x${section.address.toString(16)}`).toBeDefined();
            for (let i = 0; i < section.bytes.length; i++) {
                if (section.bytes[i] !== image[offset! + i]) differing++;
            }
        }
        // The reference image carries a documented third-party modification; everything else is
        // byte-identical to what BMW shipped. If this number moves, either the layout drifted or
        // the image is not the one this expectation was measured against.
        expect(differing).toBe(487);
        expect(differing / pa.payload.length).toBeLessThan(0.001);
    });

    maybe('the CSL calibration (PD31) sits at the calibration windows', () => {
        const image = readFileSync(IMAGE);
        const da = parseAustauschDatei(readFileSync(join(SP_DATEN_MSS54, 'A7837331.0DA')));
        let differing = 0;
        for (const section of da.sections) {
            const offset = ds2ToImageOffset(section.address);
            expect(offset).toBeDefined();
            for (let i = 0; i < section.bytes.length; i++) {
                if (section.bytes[i] !== image[offset! + i]) differing++;
            }
        }
        // 12 bytes: the two recalculated CRC slots and the changed reference strings.
        expect(differing).toBe(12);
    });
});

describe('the calibration CRC slots validate in place', () => {
    maybe('both 32 KiB halves check out against the stored CRC-16/ARC', () => {
        const image = readFileSync(IMAGE);
        // The reference tuner computes each half over a rotated input: the upper 16 KiB first,
        // then the lower 16 KiB up to (but excluding) the checksum slot at +0x3FFC.
        for (const processor of ['master', 'slave'] as const) {
            const w = windowFor('calibration', processor);
            const half = image.subarray(w.imageOffset, w.imageOffset + w.length);
            const input = new Uint8Array(0x7ffc);
            input.set(half.subarray(0x4000, 0x8000), 0);
            input.set(half.subarray(0, 0x3ffc), 0x4000);
            const stored = (half[0x3ffc]! << 8) | half[0x3ffd]!;
            expect(crc16Arc(input), processor).toBe(stored);
            expect([half[0x3ffe], half[0x3fff]], `${processor} padding`).toEqual([0xff, 0xff]);
        }
    });
});

describe('naming what diverged', () => {
    it('names every sector of both processors', () => {
        expect(describeImageOffset(0x00000)).toBe('master bootloader (SA0)');
        expect(describeImageOffset(0x03fff)).toBe('master bootloader (SA0)');
        expect(describeImageOffset(0x04000)).toBe('master service block (SA1)');
        expect(describeImageOffset(0x05fff)).toBe('master service block (SA1)');
        expect(describeImageOffset(0x06000)).toBe('master tail guard (SA2)');
        expect(describeImageOffset(0x08000)).toBe('master calibration (SA3)');
        expect(describeImageOffset(0x10000)).toBe('master program (SA4-SA10)');
        expect(describeImageOffset(0x7ffff)).toBe('master program (SA4-SA10)');
        expect(describeImageOffset(0x80000)).toBe('slave bootloader (SA0)');
        expect(describeImageOffset(0x84000)).toBe('slave service block (SA1)');
        expect(describeImageOffset(0x88000)).toBe('slave calibration (SA3)');
        expect(describeImageOffset(0xfffff)).toBe('slave program (SA4-SA10)');
    });

    it('agrees with the ranges the converter refuses to touch', () => {
        for (const range of PROTECTED_IMAGE_RANGES) {
            for (const offset of [range.start, range.end - 1]) {
                expect(describeImageOffset(offset)).toContain(range.processor);
            }
        }
    });

    it('collapses a run of offsets to the sectors they touch, in order, without repeats', () => {
        expect(describeImageOffsets([0x08010, 0x08011, 0x04000, 0x90000])).toEqual([
            'master calibration (SA3)',
            'master service block (SA1)',
            'slave program (SA4-SA10)',
        ]);
        expect(describeImageOffsets([])).toEqual([]);
    });
});

describe('the program window the firmware erases vs the one an image carries', () => {
    /**
     * A program erase clears 0x10000-0x7FFFF - 448 KiB - while `IMAGE_WINDOWS` carries 256 KiB of
     * content. So 192 KiB is blanked on every conversion and never written back.
     *
     * That is only harmless if it was already blank, and this is the evidence. Checked against a
     * real car dump and the community patch, both processors: not one non-0xFF byte in the tail.
     * If a future image ever carries data there, this fails and the erase becomes a data loss the
     * tool would otherwise not have mentioned.
     */
    const IMAGES = [
        process.env.HW2001_BIN ?? String.raw`C:\Users\kazuh\MSS54-DS2-Tool-Public-1.2.1\hw2001-analysis\hw2001_full.bin`,
        process.env.CP_V1_BIN ?? 'data/211325000401PD31_Community_Patch_v1.bin',
    ].filter((p) => existsSync(p));

    (IMAGES.length ? it : it.skip)('is blank in every image we have', () => {
        for (const path of IMAGES) {
            const image = new Uint8Array(readFileSync(path));
            for (const base of [0, 0x80000]) {
                for (let at = base + 0x50000; at < base + 0x80000; at++) {
                    if (image[at] !== 0xff) {
                        throw new Error(`${path}: 0x${at.toString(16)} is 0x${image[at]!.toString(16)}, not blank`);
                    }
                }
            }
        }
    });

    it('carries 256 KiB of program content inside a 448 KiB addressable window', () => {
        for (const window of IMAGE_WINDOWS.filter((w) => w.kind === 'program')) {
            expect(window.length).toBe(0x40000);
        }
    });
});
