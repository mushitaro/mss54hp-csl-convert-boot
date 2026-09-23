/**
 * Checked against genuine BMW calibration files. The CRC is the one checksum this tool must be
 * able to recompute, so it is pinned from three directions: BMW's own stored values, the fact
 * that an edit moves it, and the fact that correcting restores validity.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseAustauschDatei } from './paband';
import {
    calibrationPairFrom, analyseChecksums, correctChecksums, checksumOffsetOf, halfOf,
    CALIBRATION_PAIR_LENGTH, HALF_BASE,
} from './calibrationImage';

const SP_DATEN_MSS54 = process.env.SP_DATEN_MSS54
    ?? String.raw`C:\Users\kazuh\E46M3SMG2_TuningTool\E46_v74\data\MSS54`;
const CSL_PD31 = join(SP_DATEN_MSS54, 'A7837331.0DA');
const havePackage = existsSync(SP_DATEN_MSS54);
const maybe = havePackage ? it : it.skip;

function cslPair(): Uint8Array {
    return calibrationPairFrom(parseAustauschDatei(readFileSync(CSL_PD31)));
}

describe('the genuine CSL calibration (PD31)', () => {
    maybe('assembles into a complete 64 KiB pair with no holes', () => {
        const pair = cslPair();
        expect(pair.length).toBe(CALIBRATION_PAIR_LENGTH);
    });

    maybe('both stored CRCs are already valid, with intact padding', () => {
        for (const c of analyseChecksums(cslPair())) {
            expect(c.valid, `${c.half}: stored 0x${c.stored.toString(16)} computed 0x${c.computed.toString(16)}`).toBe(true);
            expect(c.paddingIntact, `${c.half} padding`).toBe(true);
        }
    });

    maybe('carries the CSL load-path constants this converter switches on', () => {
        const pair = cslPair();
        // k_rf_cfg: stock CSL is 0x12 = Alpha-N (0x02) + MAP integral (0x10).
        expect(pair[0xe5e4]).toBe(0x12);
        // The MAP path is real in genuine CSL - scaler, offset and validity limits are populated.
        const u16 = (o: number) => (pair[o]! << 8) | pair[o + 1]!;
        expect(u16(0xd2ee)).toBeGreaterThan(0); // k_p_saug_steigung
        expect(u16(0xd2f2)).toBeGreaterThan(0); // k_p_saug_diag_min
        expect(u16(0xd2f4)).toBeGreaterThan(u16(0xd2f2)); // ...max above min
        // Engine constants that pin the address mapping: 3.201 dm3 and 1.136 kg/m3.
        expect(u16(0xd21c)).toBe(3201);
        expect(u16(0xd21e)).toBe(1136);
    });

    maybe('ships an ACTIVE snorkel-flap adder - genuine CSL has the flap', () => {
        const pair = cslPair();
        // kf_rf_soll_ask: X 20 pts @0xDB32, Y 24 pts @0xDB5A, Z 24x20 @0xDB8A.
        const z = 0xdb8a;
        const cells = Array.from({ length: 480 }, (_, i) => (pair[z + 2 * i]! << 8) | pair[z + 2 * i + 1]!);
        expect(cells.some((v) => v !== 0)).toBe(true);
        // It is an adder, so it must stay far below the main VE table it adds to.
        const main = Array.from({ length: 480 }, (_, i) => (pair[0xd356 + 2 * i]! << 8) | pair[0xd356 + 2 * i + 1]!);
        expect(Math.max(...cells)).toBeLessThan(Math.max(...main) / 10);
        // Z ends exactly where kf_rf_soll_tau_up begins, which is what fixes the table shape.
        expect(z + 480 * 2).toBe(0xdf4a);
    });

    maybe('places every flap constant in the slave half and every MAP constant in the master half', () => {
        // This split is why a variant never has to touch program code.
        for (const flap of [0x21da, 0x21e1, 0x2265, 0x6164, 0x62de, 0x62ec]) {
            expect(halfOf(flap), `0x${flap.toString(16)}`).toBe('slave');
        }
        for (const map of [0xd2ee, 0xd2f4, 0xe088, 0xe5e4, 0xe5f8, 0xf420]) {
            expect(halfOf(map), `0x${map.toString(16)}`).toBe('master');
        }
    });
});

describe('checksum correction', () => {
    maybe('an edit invalidates the half it touched, and only that half', () => {
        const pair = cslPair();
        pair[0xe5e4] = 0x02; // master half: switch the MAP integral off
        const after = analyseChecksums(pair);
        expect(after.find((c) => c.half === 'master')!.valid).toBe(false);
        expect(after.find((c) => c.half === 'slave')!.valid).toBe(true);
    });

    maybe('correcting restores validity and reports the old value', () => {
        const pair = cslPair();
        const originalMaster = analyseChecksums(pair).find((c) => c.half === 'master')!.stored;
        pair[0xe5e4] = 0x02;
        const report = correctChecksums(pair);
        const master = report.find((c) => c.half === 'master')!;
        expect(master.stored).toBe(originalMaster);
        expect(master.computed).not.toBe(originalMaster);
        for (const c of analyseChecksums(pair)) expect(c.valid).toBe(true);
    });

    maybe('correcting an untouched pair changes nothing', () => {
        const pair = cslPair();
        const before = Uint8Array.from(pair);
        correctChecksums(pair);
        expect(pair).toEqual(before);
    });

    maybe('every MSS54HP calibration file in the package validates as shipped', () => {
        const files = readdirSync(SP_DATEN_MSS54).filter((f) => /\.0DA$/i.test(f));
        const failures: string[] = [];
        for (const name of files) {
            const parsed = parseAustauschDatei(readFileSync(join(SP_DATEN_MSS54, name)));
            if (parsed.payload.length !== CALIBRATION_PAIR_LENGTH) continue; // MSS54 non-HP is a 32 KiB single
            const pair = calibrationPairFrom(parsed);
            for (const c of analyseChecksums(pair)) {
                if (!c.valid) failures.push(`${name} ${c.half}: stored 0x${c.stored.toString(16)} computed 0x${c.computed.toString(16)}`);
            }
        }
        expect(failures).toEqual([]);
    });
});

describe('layout invariants', () => {
    it('the CRC slots sit at the documented offsets', () => {
        expect(checksumOffsetOf('slave')).toBe(0x3ffc);
        expect(checksumOffsetOf('master')).toBe(0xbffc);
        expect(HALF_BASE.slave).toBe(0);
        expect(HALF_BASE.master).toBe(0x8000);
    });

    it('refuses a pair of the wrong length rather than reading past it', () => {
        expect(() => analyseChecksums(new Uint8Array(0x8000))).toThrow(/must be 65536 bytes/);
    });
});
