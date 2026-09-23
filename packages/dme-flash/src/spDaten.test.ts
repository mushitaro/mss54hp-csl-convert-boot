/**
 * The six CSL builds, read out of BMW's own files.
 *
 * These tests run against the real SP-DATEN package, so what they pin is not this module's idea of
 * a CSL variant but what BMW shipped. The strongest of them compares the image this module
 * assembles against a genuine factory ECU dump - if those agree, the picker is offering the real
 * thing rather than something plausible.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
    collectSpDaten, readVariant, readProgram, buildConversionImage, isCslReference,
    SpDatenError, conversionWriteBytes, type SpDatenVariant,
} from './spDaten';
import { IMAGE_WINDOWS, FULL_IMAGE_LENGTH, isProtectedImageOffset } from './imageLayout';
import { extractSa0, identifyBootloader } from './bootloaderImage';
import {
    buildVariant, verifyManifest, variantLabel, variantWarnings, type VariantChoice,
} from './variant';
import { analyseChecksums, correctChecksums } from './calibrationImage';

const SP_DATEN = process.env.SP_DATEN_MSS54
    ?? String.raw`C:\Users\kazuh\E46M3SMG2_TuningTool\E46_v74\data\MSS54`;
const havePackage = existsSync(SP_DATEN);
const maybe = havePackage ? it : it.skip;

function load(name: string): { name: string; bytes: Uint8Array } {
    return { name, bytes: new Uint8Array(readFileSync(join(SP_DATEN, name))) };
}

/**
 * The whole package, read and parsed once.
 *
 * It is 96 files and 2.6 MB, one of them a 1.4 MB program. Re-reading and re-parsing that per test
 * was most of the suite's runtime and is what pushed it past the default timeout - and it tested
 * the filesystem repeatedly rather than the module.
 */
let cachedFiles: { name: string; bytes: Uint8Array }[] | undefined;
function everyFile(): { name: string; bytes: Uint8Array }[] {
    cachedFiles ??= readdirSync(SP_DATEN).filter((f) => /\.(0PA|0DA)$/i.test(f)).map(load);
    return cachedFiles;
}

let cachedSet: ReturnType<typeof collectSpDaten> | undefined;
function everySet(): ReturnType<typeof collectSpDaten> {
    cachedSet ??= collectSpDaten(everyFile());
    return cachedSet;
}

/** Parsing 2.6 MB of Intel hex and comparing megabytes byte by byte is seconds of real work. */
vi.setConfig({ testTimeout: 60_000 });

describe('what a CSL build is', () => {
    it('is decided by the declared reference, not the filename', () => {
        expect(isCslReference('211325000401PD31')).toBe(true);
        expect(isCslReference('2113 2500 0401 PD31')).toBe(true);
        // The standard M3 program number. A .0DA renamed to look like a CSL one still fails here.
        expect(isCslReference('211323000401PD31')).toBe(false);
        expect(isCslReference('')).toBe(false);
    });
});

describe('reading the package', () => {
    maybe('finds exactly six CSL calibrations and one CSL program', () => {
        const set = everySet();
        expect(set.program).not.toBeNull();
        expect(set.program!.file).toBe('7837340A.0PA');
        expect(set.variants).toHaveLength(6);
    });

    maybe('names each one with the text BMW wrote, not a table in this repo', () => {
        const set = everySet();
        // K_V1 verbatim. Note `Vmax abgeregelt` - LIMITED - which this project's own notes had
        // recorded as unrestricted for 7837329. The file is the authority.
        expect(set.variants.map((v) => `${v.file} ${v.reference} ${v.name}`)).toEqual([
            'A7837329.0DA 211325000401PD11 E46-M3-CSL-EOBD Vmax abgeregelt',
            'A7837333.0DA 211325000401PD1D E46-M3-CSL-SA861 Vmax abgeregelt',
            'A7837337.0DA 211325000401PD1J E46-M3-CSL-Japan Vmax abgeregelt',
            'A7837331.0DA 211325000401PD31 E46-M3-CSL-EOBD SA231',
            'A7837335.0DA 211325000401PD3D E46-M3-CSL-SA861 SA231',
            'A7837339.0DA 211325000401PD3J E46-M3-CSL-Japan SA231',
        ]);
    });

    maybe('carries each variant ZB number, so a part number can be matched', () => {
        const set = everySet();
        expect(set.variants.map((v) => v.zb)).toEqual([
            'SW fuer ZB 7.837.328',
            'SW fuer ZB 7.837.332',
            'SW fuer ZB 7.837.336',
            'SW fuer ZB 7.837.330',
            'SW fuer ZB 7.837.334',
            'SW fuer ZB 7.837.338',
        ]);
    });

    maybe('checks each file against its own declared checksum', () => {
        const set = everySet();
        for (const variant of set.variants) {
            expect(variant.checksumValid, variant.file).toBe(true);
        }
    });

    maybe('rejects the non-CSL builds rather than hiding them', () => {
        // The MSS54 directory holds every E46 build. Selecting all of it must not silently narrow
        // to six with no account of the rest.
        const set = everySet();
        expect(set.rejected.length).toBeGreaterThan(0);
        expect(set.rejected.every((r) => r.reason.length > 0)).toBe(true);
        // Every file is accounted for: a variant, the program, or a stated rejection.
        expect(set.variants.length + set.rejected.length + (set.program ? 1 : 0))
            .toBe(everyFile().length);
    });

    maybe('refuses a standard-M3 calibration offered as a CSL variant', () => {
        const set = collectSpDaten([load('A7833894.0DA')]);
        expect(set.variants).toHaveLength(0);
        expect(set.rejected[0]!.reason).toMatch(/not a CSL build/);
    });
});

describe('assembling the image a conversion writes', () => {
    maybe('fills exactly the four windows and nothing else', () => {
        const set = everySet();
        const image = buildConversionImage(set.program!, set.variants[0]!);
        expect(image).toHaveLength(FULL_IMAGE_LENGTH);

        const inAWindow = (at: number): boolean => IMAGE_WINDOWS.some(
            (w) => at >= w.imageOffset && at < w.imageOffset + w.length);
        for (let at = 0; at < FULL_IMAGE_LENGTH; at++) {
            if (inAWindow(at)) continue;
            expect(image[at], `0x${at.toString(16)} outside every window`).toBe(0xff);
        }
    });

    maybe('never places a byte in the bootloader or the service block', () => {
        const set = everySet();
        const image = buildConversionImage(set.program!, set.variants[0]!);
        for (let at = 0; at < FULL_IMAGE_LENGTH; at++) {
            if (isProtectedImageOffset(at)) expect(image[at], `0x${at.toString(16)}`).toBe(0xff);
        }
        // And the assembled image carries no bootloader at all, so it cannot be mistaken for one.
        expect(identifyBootloader(extractSa0(image, 'master'), 'master')).toBe('unknown');
    });

    maybe('gives every variant the same program and a different calibration', () => {
        const set = everySet();
        const images = set.variants.map((v) => buildConversionImage(set.program!, v));
        const program = IMAGE_WINDOWS.filter((w) => w.kind === 'program');
        const calibration = IMAGE_WINDOWS.filter((w) => w.kind === 'calibration');

        for (const window of program) {
            for (const image of images.slice(1)) {
                for (let i = 0; i < window.length; i++) {
                    const at = window.imageOffset + i;
                    if (image[at] !== images[0]![at]) throw new Error(`program differs at 0x${at.toString(16)}`);
                }
            }
        }
        // Every pair of variants must differ somewhere in calibration, or the choice is a lie.
        for (let a = 0; a < images.length; a++) {
            for (let b = a + 1; b < images.length; b++) {
                const differs = calibration.some((w) => {
                    for (let i = 0; i < w.length; i++) {
                        if (images[a]![w.imageOffset + i] !== images[b]![w.imageOffset + i]) return true;
                    }
                    return false;
                });
                expect(differs, `${set.variants[a]!.file} vs ${set.variants[b]!.file}`).toBe(true);
            }
        }
    });

    maybe('refuses to build from a standard-M3 program', () => {
        const set = everySet();
        const standard = readProgram('7833892A.0PA', readFileSync(join(SP_DATEN, '7833892A.0PA')));
        expect(() => buildConversionImage(standard, set.variants[0]!)).toThrow(SpDatenError);
    });

    it('states how many bytes a conversion writes', () => {
        // 256 KiB program + 32 KiB calibration, per processor.
        expect(conversionWriteBytes()).toBe(2 * (0x40000 + 0x8000));
    });
});

/**
 * The strongest check available without a car: does the assembled image match one BMW shipped?
 *
 * `data/genuine-csl/` holds factory ECU dumps. Their program and calibration windows should equal
 * what this module builds from SP-DATEN for the matching variant - the same bytes arriving by two
 * completely different routes.
 */
const GENUINE_DIR = process.env.YUL_CSL_DIR ?? join(process.cwd(), 'data', 'genuine-csl');
const haveGenuine = havePackage && existsSync(GENUINE_DIR);
const maybeBoth = haveGenuine ? it : it.skip;

describe('against a genuine factory ECU dump', () => {
    maybeBoth('builds the same program bytes BMW shipped in the car', () => {
        const set = everySet();
        const dumps = readdirSync(GENUINE_DIR).filter((f) => /\.bin$/i.test(f));
        expect(dumps.length).toBeGreaterThan(0);

        const dump = new Uint8Array(readFileSync(join(GENUINE_DIR, dumps[0]!)));
        const built = buildConversionImage(set.program!, set.variants[0]!);

        // Program only: the dump's calibration belongs to whichever variant that ECU was, and the
        // dump also carries a bootloader and a service block this image deliberately does not.
        for (const window of IMAGE_WINDOWS.filter((w) => w.kind === 'program')) {
            let differing = 0;
            for (let i = 0; i < window.length; i++) {
                const at = window.imageOffset + i;
                if (built[at] !== dump[at]) differing++;
            }
            // Not necessarily zero: published dumps carry third-party modifications. What matters
            // is that the overwhelming majority agrees - a wrong assembly would differ everywhere.
            const agreement = 1 - differing / window.length;
            expect(agreement, `${dumps[0]} ${window.processor} program`).toBeGreaterThan(0.99);
        }
    });

    maybeBoth('matches a genuine dump calibration for the variant that dump actually is', () => {
        const set = everySet();
        // ZB7837332 is SW 7837333 -> reference PD1D -> A7837333.0DA.
        const name = readdirSync(GENUINE_DIR).find((f) => f.includes('ZB7837332'));
        if (!name) return;
        const dump = new Uint8Array(readFileSync(join(GENUINE_DIR, name)));
        const variant = set.variants.find((v) => v.reference.endsWith('PD1D'));
        expect(variant, 'PD1D variant').toBeDefined();

        const built = buildConversionImage(set.program!, variant!);
        for (const window of IMAGE_WINDOWS.filter((w) => w.kind === 'calibration')) {
            let differing = 0;
            for (let i = 0; i < window.length; i++) {
                const at = window.imageOffset + i;
                if (built[at] !== dump[at]) differing++;
            }
            const agreement = 1 - differing / window.length;
            expect(agreement, `${name} ${window.processor} calibration`).toBeGreaterThan(0.99);
        }
    });
});

/**
 * The hardware answers, written through to the bytes.
 *
 * This is the path the PATCH step drives, and it is the one place where the app writes something
 * BMW did not ship. What it must not do is leak: an edit for a missing MAP sensor or a missing
 * snorkel flap belongs inside the calibration windows and nowhere else.
 */
describe('building a conversion for a car that lacks the CSL hardware', () => {
    const CHOICES: VariantChoice[] = (['csl', 'm3'] as const).flatMap((cams) => [
        { map: 'use' as const, flap: 'present' as const, cams },
        { map: 'off' as const, flap: 'present' as const, cams },
        { map: 'use' as const, flap: 'absent' as const, cams },
        { map: 'off' as const, flap: 'absent' as const, cams },
    ]);

    it('applies every combination to every factory build, with nothing stray', () => {
        const set = everySet();
        expect(set.variants.length).toBe(6);
        for (const variant of set.variants) {
            for (const choice of CHOICES) {
                const built = buildVariant(variant.pair, choice);
                const check = verifyManifest(variant.pair, built);
                expect(check.strayOffsets, `${variant.file} ${variantLabel(choice)}`).toEqual([]);
            }
        }
    });

    it('leaves the genuine bytes alone when both parts are fitted', () => {
        const set = everySet();
        for (const variant of set.variants) {
            const built = buildVariant(variant.pair, { map: 'use', flap: 'present', cams: 'csl' });
            expect(built.manifest.edits, variant.file).toEqual([]);
            expect(built.manifest.changedBytes, variant.file).toBe(0);
        }
    });

    it('confines every edit to the calibration windows of the image it writes', () => {
        const set = everySet();
        const program = set.program;
        expect(program).toBeDefined();
        const calibration = IMAGE_WINDOWS.filter((w) => w.kind === 'calibration');
        expect(calibration.length).toBeGreaterThan(0);

        for (const variant of set.variants) {
            const genuine = buildConversionImage(program!, variant);
            const built = buildVariant(variant.pair, { map: 'off', flap: 'absent', cams: 'm3' });
            const patched = buildConversionImage(program!, { ...variant, pair: built.pair });

            expect(patched.length).toBe(FULL_IMAGE_LENGTH);
            let differing = 0;
            for (let at = 0; at < FULL_IMAGE_LENGTH; at++) {
                if (genuine[at] === patched[at]) continue;
                differing++;
                expect(isProtectedImageOffset(at), `0x${at.toString(16)} is protected`).toBe(false);
                const inside = calibration.some(
                    (w) => at >= w.imageOffset && at < w.imageOffset + w.length);
                expect(inside, `0x${at.toString(16)} is outside every calibration window`).toBe(true);
            }
            // The edits are real: a car with neither part is not written genuine bytes.
            expect(differing, variant.file).toBeGreaterThan(0);
        }
    });
});

/**
 * The camshaft answer, checked against the binaries it was derived from.
 *
 * The MAP and flap edits are derived from BMW artefacts. This one is derived from a diff between
 * two community binaries, so the tests carry more of the weight: they pin the exact words, the
 * structure that identifies them, and the fact that the tool produces the checksum its source got
 * wrong.
 */
describe('the VANOS offsets and which camshafts the car has', () => {
    const VANOS_A = 0x1802;
    const VANOS_B = 0x1bb6;
    const CSL_CAMS = join(GENUINE_DIR, 'ZB7837328_CSL_cams.bin');
    const M3_CAMS = join(GENUINE_DIR, 'ZB7837328_stock_M3_cams.bin');
    const haveDumps = existsSync(CSL_CAMS) && existsSync(M3_CAMS);
    const withDumps = haveDumps ? it : it.skip;

    const word = (p: Uint8Array, at: number): number => {
        const raw = (p[at]! << 8) | p[at + 1]!;
        return raw & 0x8000 ? raw - 0x10000 : raw;
    };

    it('finds the identifying structure exactly twice in the whole pair', () => {
        // This is the evidence the identification rests on: the two words head identical control
        // blocks, and there is no third instance anywhere in 64 KiB. An S54 has two VANOS units.
        for (const variant of everySet().variants) {
            const p = variant.pair;
            const hits: number[] = [];
            for (let at = 0; at + 0x14 < p.length; at += 2) {
                if (word(p, at + 0x02) === 0x00ff && word(p, at + 0x06) === 0x003e
                    && word(p, at + 0x10) === 0x0010 && word(p, at + 0x12) === 0x00a4) hits.push(at);
            }
            expect(hits, variant.file).toEqual([VANOS_A, VANOS_B]);
        }
    });

    it('reads the same genuine offsets in all six factory builds', () => {
        for (const variant of everySet().variants) {
            expect(word(variant.pair, VANOS_A), `${variant.file} A`).toBe(30);
            expect(word(variant.pair, VANOS_B), `${variant.file} B`).toBe(-20);
        }
    });

    withDumps('writes exactly the four bytes that separate the two community builds', () => {
        const csl = new Uint8Array(readFileSync(CSL_CAMS));
        const m3 = new Uint8Array(readFileSync(M3_CAMS));
        const differing: number[] = [];
        for (let at = 0; at < csl.length; at++) if (csl[at] !== m3[at]) differing.push(at);
        // The whole basis of the option: four bytes in a megabyte, and they are these two words.
        expect(differing).toEqual([0x089802, 0x089803, 0x089bb6, 0x089bb7]);

        const variant = everySet().variants.find((v) => v.reference.endsWith('PD31'))!;
        const built = buildVariant(variant.pair, { map: 'use', flap: 'present', cams: 'm3' });
        expect(built.manifest.changedBytes).toBe(4);
        expect(word(built.pair, VANOS_A)).toBe(-20);
        expect(word(built.pair, VANOS_B)).toBe(10);
        // The same values the community build carries, read out of that file rather than retyped.
        expect(word(built.pair, VANOS_A)).toBe(word(m3, 0x089802));
        expect(word(built.pair, VANOS_B)).toBe(word(m3, 0x089bb6));
    });

    withDumps('produces the valid checksum its source file does not have', () => {
        // The community file stores the CSL-cam build's checksum over stock-cam content. This is
        // the one thing the tool can strictly improve on, so it is worth asserting both halves.
        const m3 = new Uint8Array(readFileSync(M3_CAMS));
        const sourcePair = new Uint8Array(0x10000);
        sourcePair.set(m3.subarray(0x088000, 0x090000), 0x0000);
        sourcePair.set(m3.subarray(0x008000, 0x010000), 0x8000);
        const asDistributed = analyseChecksums(sourcePair);
        expect(asDistributed.find((c) => c.half === 'slave')!.valid).toBe(false);

        const variant = everySet().variants.find((v) => v.reference.endsWith('PD31'))!;
        const built = buildVariant(variant.pair, { map: 'use', flap: 'present', cams: 'm3' });
        for (const half of analyseChecksums(built.pair)) {
            expect(half.valid, `${half.half} checksum`).toBe(true);
            expect(half.paddingIntact, `${half.half} padding`).toBe(true);
        }
    });

    it('leaves the offsets alone when the car has CSL camshafts', () => {
        for (const variant of everySet().variants) {
            const built = buildVariant(variant.pair, { map: 'use', flap: 'present', cams: 'csl' });
            expect(built.manifest.edits, variant.file).toEqual([]);
        }
    });

    it('refuses a calibration whose offsets have already been altered', () => {
        // Guards against writing cam timing into something that is not the structure we identified.
        const variant = everySet().variants[0]!;
        const tampered = Uint8Array.from(variant.pair);
        tampered[VANOS_A] = 0x12;
        tampered[VANOS_A + 1] = 0x34;
        expect(() => buildVariant(tampered, { map: 'use', flap: 'present', cams: 'm3' }))
            .toThrow(/refusing to patch/);

        const wrongShape = Uint8Array.from(variant.pair);
        // The low byte: 0x00A4's high byte is already 0x00, so writing 0x00 there breaks nothing.
        wrongShape[VANOS_B + 0x13] = 0x00;   // break the signature, leave the value intact
        expect(() => buildVariant(wrongShape, { map: 'use', flap: 'present', cams: 'm3' }))
            .toThrow(/not CSL 0401/);
    });
});

/**
 * The properties the camshaft option's safety argument rests on.
 *
 * Each of these was an assumption until it was written down here: that the checksum really does
 * cover the words (so `correctChecksums` is load-bearing rather than incidental), that the edit
 * touches nothing but the two words and the slot, that the commanded envelope is untouched, and
 * that an already-converted pair is refused rather than shifted twice.
 */
describe('what the camshaft option must not disturb', () => {
    const VANOS_A = 0x1802;
    const VANOS_B = 0x1bb6;
    const SLAVE_SLOT = 0x3ffc;
    const M3: VariantChoice = { map: 'use', flap: 'present', cams: 'm3' };

    const pd31 = (): SpDatenVariant =>
        everySet().variants.find((v) => v.reference.endsWith('PD31'))!;

    it('has all four bytes inside the slave checksum and outside the master one', () => {
        const genuine = pd31().pair;
        const before = analyseChecksums(genuine);
        for (const at of [VANOS_A, VANOS_A + 1, VANOS_B, VANOS_B + 1]) {
            const flipped = Uint8Array.from(genuine);
            flipped[at] = flipped[at]! ^ 0xff;
            const after = analyseChecksums(flipped);
            const slaveOf = (x: typeof before) => x.find((h) => h.half === 'slave')!.computed;
            const masterOf = (x: typeof before) => x.find((h) => h.half === 'master')!.computed;
            expect(slaveOf(after), `slave CRC ignores 0x${at.toString(16)}`).not.toBe(slaveOf(before));
            expect(masterOf(after), `master CRC covers 0x${at.toString(16)}`).toBe(masterOf(before));
        }
    });

    it('changes six bytes in the pair: the two words and the checksum slot', () => {
        // `changedBytes` counts the edits (4). The pair differs in six, and the extra two are the
        // recomputed slot - which is the number to use if anything ever compares whole images.
        const genuine = pd31().pair;
        const built = buildVariant(genuine, M3);
        const differing: number[] = [];
        for (let at = 0; at < genuine.length; at++) if (genuine[at] !== built.pair[at]) differing.push(at);
        expect(differing).toEqual([VANOS_A, VANOS_A + 1, VANOS_B, VANOS_B + 1, SLAVE_SLOT, SLAVE_SLOT + 1]);
        expect(built.manifest.changedBytes).toBe(4);
    });

    it('leaves the commanded envelope of both blocks byte-identical', () => {
        // The safety argument: only the sensor zero moves. The limits, the adaptation clamps and
        // the target maps are what bound where the cam can actually go, and they must not move.
        const genuine = pd31().pair;
        const built = buildVariant(genuine, M3).pair;
        for (const base of [VANOS_A, VANOS_B]) {
            for (let d = 2; d < 0x14; d++) {
                expect(built[base + d], `0x${(base + d).toString(16)}`).toBe(genuine[base + d]);
            }
        }
    });

    it('never touches the master half at the same in-half offset', () => {
        // 0x9802 is a different parameter (it reads 1300). An edit that confused the halves would
        // land there, so it is asserted rather than trusted.
        const genuine = pd31().pair;
        const word = (p: Uint8Array, at: number) => (p[at]! << 8) | p[at + 1]!;
        expect(word(genuine, 0x9802)).toBe(1300);
        for (const cams of ['csl', 'm3'] as const) {
            const built = buildVariant(genuine, { map: 'use', flap: 'present', cams }).pair;
            expect(word(built, 0x9802), cams).toBe(1300);
            expect(word(built, 0x9bb6), cams).toBe(67);
        }
    });

    it('refuses a pair it has already converted', () => {
        // The "operator read their own converted car back" case. Shifting twice would be silent.
        const built = buildVariant(pd31().pair, M3);
        expect(() => buildVariant(built.pair, M3)).toThrow(/refusing to patch/);
    });

    it('restores the genuine pair from its own manifest', () => {
        const genuine = pd31().pair;
        const built = buildVariant(genuine, M3);
        expect(verifyManifest(genuine, built)).toEqual({ ok: true, strayOffsets: [] });
        const undone = Uint8Array.from(built.pair);
        for (const edit of built.manifest.edits) undone.set(edit.before, edit.offset);
        correctChecksums(undone);
        expect(Array.from(undone)).toEqual(Array.from(genuine));
    });

    it('says something about the camshafts whichever way the question is answered', () => {
        // Neither answer is the quiet one. A silent branch would read as the safe branch.
        for (const cams of ['csl', 'm3'] as const) {
            const warnings = variantWarnings({ map: 'use', flap: 'present', cams });
            expect(warnings.some((w) => /camshaft/i.test(w)), cams).toBe(true);
        }
        expect(variantWarnings({ map: 'use', flap: 'present', cams: 'm3' })
            .some((w) => /community/i.test(w) && /BMW/.test(w))).toBe(true);
    });

    it('pins the source file as the broken artefact the copy describes', () => {
        // If someone "fixes" this fixture's checksum, the UI's provenance warning silently becomes
        // false. This test fails first and forces the copy to be revisited.
        const csl = join(GENUINE_DIR, 'ZB7837328_CSL_cams.bin');
        const m3 = join(GENUINE_DIR, 'ZB7837328_stock_M3_cams.bin');
        if (!existsSync(csl) || !existsSync(m3)) return;
        const pairOf = (file: string) => {
            const img = new Uint8Array(readFileSync(file));
            const pair = new Uint8Array(0x10000);
            pair.set(img.subarray(0x088000, 0x090000), 0x0000);
            pair.set(img.subarray(0x008000, 0x010000), 0x8000);
            return pair;
        };
        const good = analyseChecksums(pairOf(csl)).find((h) => h.half === 'slave')!;
        const bad = analyseChecksums(pairOf(m3)).find((h) => h.half === 'slave')!;
        expect(good.valid).toBe(true);
        expect(bad.valid).toBe(false);
        expect(bad.stored, 'the stale value is the CSL build\'s own').toBe(good.stored);
        expect(bad.stored).toBe(0x2f81);
        expect(bad.computed).toBe(0xf337);
    });
});
