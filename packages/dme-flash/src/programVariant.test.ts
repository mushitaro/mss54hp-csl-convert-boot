/**
 * The community-patched program, checked against the real files rather than against fixtures.
 *
 * The point of `readPatchedProgram` is that it REFUSES, so most of what is worth testing here is
 * the refusals - and each of them is built by mutating the genuine patch, which is the only way to
 * know the check would have caught a file that was almost right.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { readProgram, readVariant, buildConversionImage } from './spDaten';
import {
    readPatchedProgram, isPatchedProgram, factoryProgramWindowCrc, GEN_ST_ENABLE,
    ProgramSourceError,
} from './programVariant';
import { IMAGE_WINDOWS, FULL_IMAGE_LENGTH } from './imageLayout';
import { crc16Arc } from './paband';

const SPD = 'packages/web/public/spdaten';
const PATCH = 'data/211325000401PD31_Community_Patch_v1.bin';
const VARIANTS = ['A7837329', 'A7837331', 'A7837333', 'A7837335', 'A7837337', 'A7837339'] as const;

vi.setConfig({ testTimeout: 60_000 });

function factory() {
    return readProgram('7837340A.0PA', new Uint8Array(readFileSync(`${SPD}/7837340A.0PA`)));
}
function patchImage(): Uint8Array {
    return new Uint8Array(readFileSync(PATCH));
}
// Neither file is in the repository (THIRD-PARTY-NOTICES.md): SP-DATEN is BMW's, and the patch is
// the community's. Without them these tests skip rather than fail, so a fresh clone runs green.
const haveSpDaten = existsSync(`${SPD}/7837340A.0PA`);
const havePatch = existsSync(PATCH);
const maybe = havePatch && haveSpDaten ? it : it.skip;
const withSpDaten = haveSpDaten ? it : it.skip;

describe('reading the community patch as a program source', () => {
    maybe('accepts the genuine patch and reports every span it changes', () => {
        const p = readPatchedProgram('community-patch-v1.bin', patchImage(), factory());
        expect(p.patchId).toBe('community-patch-v1');
        expect(isPatchedProgram(p)).toBe(true);
        expect(p.edits).toHaveLength(8);
        // 487 bytes actually differ; the eight spans covering them total 537.
        expect(p.changedBytes).toBe(487);
        expect(p.edits.reduce((n, e) => n + e.length, 0)).toBe(537);
    });

    maybe('carries only the two program windows, and they are the patched bytes', () => {
        const p = readPatchedProgram('cp.bin', patchImage(), factory());
        const image = patchImage();
        expect(p.sections).toHaveLength(2);
        for (const section of p.sections) {
            const window = IMAGE_WINDOWS.find((w) => w.ds2Address === section.address);
            expect(window?.kind).toBe('program');
            expect(section.bytes).toEqual(
                image.slice(window!.imageOffset, window!.imageOffset + window!.length));
        }
    });

    maybe('every span it names really is a place the two files differ', () => {
        const p = readPatchedProgram('cp.bin', patchImage(), factory());
        const image = patchImage();
        const genuine = new Uint8Array(FULL_IMAGE_LENGTH).fill(0xff);
        for (const s of factory().sections) {
            const w = IMAGE_WINDOWS.find((x) => x.ds2Address === (s.address & 0xf00000));
            if (w) genuine.set(s.bytes, w.imageOffset + (s.address & 0x0fffff));
        }
        for (const edit of p.edits) {
            const differs = Array.from({ length: edit.length })
                .some((_, i) => genuine[edit.offset + i] !== image[edit.offset + i]);
            expect(differs, `${edit.id} at 0x${edit.offset.toString(16)}`).toBe(true);
        }
    });

    maybe('the factory program is the one the patch was measured against', () => {
        const image = new Uint8Array(FULL_IMAGE_LENGTH).fill(0xff);
        for (const s of factory().sections) {
            const w = IMAGE_WINDOWS.find((x) => x.ds2Address === (s.address & 0xf00000));
            if (w) image.set(s.bytes, w.imageOffset + (s.address & 0x0fffff));
        }
        for (const w of IMAGE_WINDOWS.filter((x) => x.kind === 'program')) {
            expect(crc16Arc(image.slice(w.imageOffset, w.imageOffset + w.length)))
                .toBe(factoryProgramWindowCrc(w.processor));
        }
    });
});

describe('what it refuses', () => {
    maybe('a file that is not a full image', () => {
        expect(() => readPatchedProgram('short.bin', new Uint8Array(1024), factory()))
            .toThrow(ProgramSourceError);
    });

    maybe('the factory program itself, which carries no patch at all', () => {
        const image = new Uint8Array(FULL_IMAGE_LENGTH).fill(0xff);
        for (const s of factory().sections) {
            const w = IMAGE_WINDOWS.find((x) => x.ds2Address === (s.address & 0xf00000));
            if (w) image.set(s.bytes, w.imageOffset + (s.address & 0x0fffff));
        }
        expect(() => readPatchedProgram('factory.bin', image, factory()))
            .toThrow(/does not carry the community patch span/);
    });

    maybe('one extra byte changed outside every known span, and it says where', () => {
        const image = patchImage();
        // 0x41B95 is the identity ASCII the 21132300 build differs at - the same way that build
        // would be caught.
        image[0x41b95] = image[0x41b95]! ^ 0x06;
        expect(() => readPatchedProgram('other.bin', image, factory()))
            .toThrow(/0x41b95.*not part of the community patch/s);
    });

    maybe('the same spans carrying different bytes', () => {
        const image = patchImage();
        // Flip a byte in the middle of the added slave code: the span shape still matches, so only
        // the content check can catch this.
        image[0xbf000] = image[0xbf000]! ^ 0xff;
        expect(() => readPatchedProgram('v2.bin', image, factory()))
            .toThrow(/Same location, different content/);
    });

    maybe('a patch whose span is there but truncated', () => {
        const image = patchImage();
        // Restore the last 8 bytes of the added code to 0xFF, shortening that run.
        for (let i = 0; i < 8; i++) image[0xbf0a5 - i] = 0xff;
        expect(() => readPatchedProgram('trunc.bin', image, factory()))
            .toThrow(ProgramSourceError);
    });
});

describe('composing the patched program with a factory calibration', () => {
    maybe('works with all six builds, and never lets the patch file supply calibration', () => {
        const program = readPatchedProgram('cp.bin', patchImage(), factory());
        const patch = patchImage();
        for (const name of VARIANTS) {
            const variant = readVariant(`${name}.0DA`, new Uint8Array(readFileSync(`${SPD}/${name}.0DA`)));
            const image = buildConversionImage(program, variant);

            // program windows: the patched bytes
            for (const w of IMAGE_WINDOWS.filter((x) => x.kind === 'program')) {
                expect(image.slice(w.imageOffset, w.imageOffset + w.length))
                    .toEqual(patch.slice(w.imageOffset, w.imageOffset + w.length));
            }
            // calibration windows: this variant's, NOT the PD31 the patch file happens to carry
            for (const w of IMAGE_WINDOWS.filter((x) => x.kind === 'calibration')) {
                const base = w.processor === 'slave' ? 0x0000 : 0x8000;
                expect(image.slice(w.imageOffset, w.imageOffset + w.length))
                    .toEqual(variant.pair.slice(base, base + w.length));
            }
        }
    });

    maybe('the integrity words come from the patch and do not move with the calibration', () => {
        const program = readPatchedProgram('cp.bin', patchImage(), factory());
        const images = VARIANTS.map((name) => buildConversionImage(
            program,
            readVariant(`${name}.0DA`, new Uint8Array(readFileSync(`${SPD}/${name}.0DA`)))));
        for (const image of images) {
            expect([image[0x41be0], image[0x41be1]]).toEqual([0xf8, 0x59]);
            expect([image[0xc2482], image[0xc2483]]).toEqual([0xe9, 0x25]);
        }
    });
});

describe('the GEN_ST enable byte', () => {
    withSpDaten('is free space in every factory calibration, so nothing reads it without the patch', () => {
        for (const name of VARIANTS) {
            const v = readVariant(`${name}.0DA`, new Uint8Array(readFileSync(`${SPD}/${name}.0DA`)));
            expect(v.pair[GEN_ST_ENABLE.pairOffset]).toBe(GEN_ST_ENABLE.factoryValue);
        }
    });

    maybe('ships disabled in the patch itself', () => {
        // slave calibration lives at image 0x88000, and the pair puts the slave half at 0x0000.
        expect(patchImage()[0x88000 + GEN_ST_ENABLE.pairOffset]).toBe(GEN_ST_ENABLE.patchShippedValue);
        expect(GEN_ST_ENABLE.enabledValue).toBe(1);
    });
});
