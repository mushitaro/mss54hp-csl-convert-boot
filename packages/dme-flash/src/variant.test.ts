/**
 * Built against the genuine CSL calibration. The properties pinned here are the ones a flasher
 * relies on: the patched pair validates, only the documented bytes moved, and a toggle that
 * changes nothing produces no edit.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseAustauschDatei } from './paband';
import { calibrationPairFrom, analyseChecksums } from './calibrationImage';
import {
    buildVariant, verifyManifest, variantWarnings, variantLabel, dtcEnabled, DTC_RECORDS,
    MAP_LATER_IS_OFF, MAP_DTC_STAYS_ENABLED, type VariantChoice,
} from './variant';

const SP_DATEN_MSS54 = process.env.SP_DATEN_MSS54
    ?? String.raw`C:\Users\kazuh\E46M3SMG2_TuningTool\E46_v74\data\MSS54`;
const CSL_PD31 = join(SP_DATEN_MSS54, 'A7837331.0DA');
const havePackage = existsSync(SP_DATEN_MSS54);
const maybe = havePackage ? it : it.skip;

function genuine(): Uint8Array {
    return calibrationPairFrom(parseAustauschDatei(readFileSync(CSL_PD31)));
}

// Every combination, not a sample: the cam axis multiplies the option space, and the property
// each test below asserts (checksums validate, no stray bytes) has to hold for all of it.
const ALL_CHOICES: VariantChoice[] = (['csl', 'm3'] as const).flatMap((cams) => [
    { map: 'use' as const, flap: 'present' as const, cams },
    { map: 'use' as const, flap: 'absent' as const, cams },
    { map: 'later' as const, flap: 'present' as const, cams },
    { map: 'off' as const, flap: 'present' as const, cams },
    { map: 'off' as const, flap: 'absent' as const, cams },
]);

describe('every variant is a valid, honest calibration', () => {
    maybe('all choices produce a pair whose checksums validate', () => {
        const g = genuine();
        for (const choice of ALL_CHOICES) {
            const built = buildVariant(g, choice);
            for (const c of analyseChecksums(built.pair)) {
                expect(c.valid, `${variantLabel(choice)} ${c.half}`).toBe(true);
            }
        }
    });

    maybe('only documented bytes and checksum slots ever move', () => {
        const g = genuine();
        for (const choice of ALL_CHOICES) {
            const built = buildVariant(g, choice);
            const check = verifyManifest(g, built);
            expect(check.ok, `${variantLabel(choice)} stray at ${check.strayOffsets.slice(0, 5).map((o) => o.toString(16))}`).toBe(true);
        }
    });

    maybe('does not mutate the genuine input', () => {
        const g = genuine();
        const copy = Uint8Array.from(g);
        buildVariant(g, { map: 'off', flap: 'absent', cams: 'csl' });
        expect(g).toEqual(copy);
    });
});

describe('the genuine variant (MAP use, flap present)', () => {
    maybe('makes no edits and leaves the pair byte-identical', () => {
        const g = genuine();
        const built = buildVariant(g, { map: 'use', flap: 'present', cams: 'csl' });
        expect(built.manifest.edits).toHaveLength(0);
        expect(built.manifest.changedBytes).toBe(0);
        expect(built.pair).toEqual(g);
    });
});

describe('MAP off', () => {
    maybe('sets k_rf_cfg to pure Alpha-N and changes nothing else', () => {
        const g = genuine();
        const built = buildVariant(g, { map: 'off', flap: 'present', cams: 'csl' });
        expect(built.pair[0xe5e4]).toBe(0x02);
        const cfg = built.manifest.edits.find((e) => e.id === 'k_rf_cfg');
        expect(cfg?.before[0]).toBe(0x12);
        expect(cfg?.after[0]).toBe(0x02);
        expect(built.manifest.edits.map((e) => e.id)).toEqual(['k_rf_cfg']);
        expect(built.manifest.changedBytes).toBe(1);
    });

    maybe('LEAVES the MAP fault enabled - it is what forces Alpha-N in every fault case', () => {
        expect(MAP_DTC_STAYS_ENABLED).toBe(true);
        const g = genuine();
        for (const map of ['off', 'later'] as const) {
            const built = buildVariant(g, { map, flap: 'present', cams: 'csl' });
            // rf_diag_lut (master 0x3D534) yields rf_diag_ed_st = 2 for index 14 (LLS fault, MAP
            // still believed healthy), and rf_calc leaves RF at the MAP value when ed_st is 2.
            // Only a stored MAP fault clears index bit1 and forces ed_st = 1 everywhere.
            expect(dtcEnabled(built.pair, DTC_RECORDS.mapPressure.offset), map).toBe(true);
        }
    });

    maybe('"later" builds the same image as "off", because the alternative is unsafe', () => {
        expect(MAP_LATER_IS_OFF).toBe(true);
        const g = genuine();
        const later = buildVariant(g, { map: 'later', flap: 'present', cams: 'csl' });
        const off = buildVariant(g, { map: 'off', flap: 'present', cams: 'csl' });
        expect(later.pair).toEqual(off.pair);
        expect(later.pair[0xe5e4]).toBe(0x02);
        expect(dtcEnabled(later.pair, DTC_RECORDS.mapPressure.offset)).toBe(true);
    });

    maybe('refuses to build when the DTC table is not where CSL 0401 puts it', () => {
        const g = genuine();
        g[DTC_RECORDS.mapPressure.offset] = 0x00; // corrupt the code byte
        expect(() => buildVariant(g, { map: 'off', flap: 'present', cams: 'csl' }))
            .toThrow(/not CSL 0401 - refusing to patch/);
    });

    maybe('warns that the MAP fault is expected rather than pretending it is not', () => {
        const w = variantWarnings({ map: 'off', flap: 'present', cams: 'csl' });
        expect(w.some((x) => /left ENABLED and WILL be stored/.test(x))).toBe(true);
    });
});

describe('flap absent', () => {
    maybe('zeroes the Alpha-N ADDER, because zero is its neutral value', () => {
        const g = genuine();
        const built = buildVariant(g, { map: 'use', flap: 'absent', cams: 'csl' });
        for (let i = 0; i < 960; i++) expect(built.pair[0xdb8a + i]).toBe(0);
        expect(countGenuineNonzero(g, 0xdb8a, 960)).toBeGreaterThan(0); // it really was populated
    });

    maybe('makes the open-flap EGAS map identical to the normal one - never zero', () => {
        const g = genuine();
        const built = buildVariant(g, { map: 'use', flap: 'absent', cams: 'csl' });
        // A zeroed throttle map would command a closed throttle if the flap state were ever
        // asserted. Genuine CSL commands 700-950 across the top row; that must survive.
        const askZ = built.pair.subarray(0x8872, 0x8872 + 23 * 14 * 2);
        const normalZ = built.pair.subarray(0x83e8, 0x83e8 + 23 * 14 * 2);
        expect(askZ).toEqual(normalZ);
        expect(askZ.some((b) => b !== 0)).toBe(true);
        // Axes too - the rpm breakpoints differ in genuine CSL (1250 vs 1150 at index 3).
        expect(built.pair.subarray(0x8828, 0x8828 + 28))
            .toEqual(built.pair.subarray(0x839e, 0x839e + 28));
    });

    maybe('disables exactly the three flap faults, enable bit only', () => {
        const g = genuine();
        const built = buildVariant(g, { map: 'use', flap: 'absent', cams: 'csl' });
        for (const key of ['flapPot', 'flapRegulator', 'flapDriver'] as const) {
            const record = DTC_RECORDS[key];
            expect(dtcEnabled(g, record.offset), `${record.id} genuine`).toBe(true);
            expect(dtcEnabled(built.pair, record.offset), record.id).toBe(false);
            expect(built.pair[record.offset]).toBe(record.code);
            expect(built.pair[record.offset + 13]).toBe(0xff);
        }
        expect(built.manifest.edits.map((e) => e.id)).toEqual([
            'kf_rf_soll_ask', 'kf_egas_wdk_ask.x', 'kf_egas_wdk_ask.z',
            'DTC_7C_CSL_FLAP_POT', 'DTC_1C_CSL_FLAP_REGULATOR', 'DTC_12_CSL_FLAP_DRIVER',
        ]);
    });

    maybe('changes only the bytes that actually differed', () => {
        const g = genuine();
        const built = buildVariant(g, { map: 'use', flap: 'absent', cams: 'csl' });
        const askNonzero = countGenuineNonzero(g, 0xdb8a, 960);
        // The two EGAS maps differ by one axis point and four cells in genuine CSL.
        const egasDiff = countDiffering(g, 0x839e, 0x8828, 28) + countDiffering(g, 0x83e8, 0x8872, 23 * 14 * 2);
        // Five 16-bit values differ (one axis breakpoint 1250->1150 and four cells), but only six
        // BYTES: several of those pairs share a high byte. Counting values would overstate it.
        expect(egasDiff).toBe(6);
        expect(built.manifest.changedBytes).toBe(askNonzero + egasDiff + 3); // + three CTL bytes
    });

    maybe('warns only about what it does not cover', () => {
        const warnings = variantWarnings({ map: 'use', flap: 'absent', cams: 'csl' });
        expect(warnings.some((w) => /three known CSL flap faults/.test(w))).toBe(true);
        expect(warnings.some((w) => /cannot be suppressed/.test(w))).toBe(false);
    });
});

describe('labels and self-cancelling edits', () => {
    it('produces a stable, filename-safe label per choice', () => {
        expect(variantLabel({ map: 'use', flap: 'present', cams: 'csl' }))
            .toBe('CSL0401_MAP_flap_cslcams');
        expect(variantLabel({ map: 'off', flap: 'absent', cams: 'm3' }))
            .toBe('CSL0401_noMAP_noflap_m3cams');
        // 'later' and 'off' produce identical bytes, so they must produce an identical label.
        expect(variantLabel({ map: 'later', flap: 'present', cams: 'csl' }))
            .toBe('CSL0401_noMAP_flap_cslcams');
        expect(variantLabel({ map: 'later', flap: 'absent', cams: 'csl' }))
            .toBe(variantLabel({ map: 'off', flap: 'absent', cams: 'csl' }));
        // The cam answer DOES change the bytes, so it must change the label.
        expect(variantLabel({ map: 'use', flap: 'present', cams: 'm3' }))
            .not.toBe(variantLabel({ map: 'use', flap: 'present', cams: 'csl' }));
    });

    maybe('an edit that would write the value already present leaves no trace', () => {
        // Build MAP-off twice: the second build on an already-0x02 pair makes no k_rf_cfg edit.
        const g = genuine();
        const once = buildVariant(g, { map: 'off', flap: 'present', cams: 'csl' });
        const twice = buildVariant(once.pair, { map: 'off', flap: 'present', cams: 'csl' });
        expect(twice.manifest.edits.find((e) => e.id === 'k_rf_cfg')).toBeUndefined();
    });
});

function countGenuineNonzero(pair: Uint8Array, offset: number, len: number): number {
    let n = 0;
    for (let i = 0; i < len; i++) if (pair[offset + i] !== 0) n++;
    return n;
}

function countDiffering(pair: Uint8Array, a: number, b: number, len: number): number {
    let n = 0;
    for (let i = 0; i < len; i++) if (pair[a + i] !== pair[b + i]) n++;
    return n;
}
