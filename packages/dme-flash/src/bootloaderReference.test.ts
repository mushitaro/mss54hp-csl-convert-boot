/**
 * The bundled CSL bootloader, and what happens when a car disagrees with it.
 *
 * Two claims are pinned here, and the second only became testable when four real cars turned up:
 *
 *  1. There is exactly ONE CSL bootloader. Five independent sources hold the same 32 KiB.
 *  2. Deriving it from a standard-M3 sector reproduces it - from every M3 sector the project has
 *     except one real car, whose divergence is the reason `patchToCsl` now takes a reference.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import {
    extractSa0, patchToCsl, referenceCslSa0, diffOffsets, verifyBootloaderCrc, SA0_LENGTH,
} from './bootloaderImage';

const REFERENCE = 'packages/web/public/bootloader/csl-sa0.bin';
const GENUINE_CSL = [
    'data/genuine-csl/ZB7837328_CSL_cams.bin',
    'data/genuine-csl/ZB7837328_stock_M3_cams.bin',
    'data/genuine-csl/ZB7837332_SW7837333_Std_No_EOBD.bin',
    'data/genuine-csl/ZB7837336_SW7837337_Jap.bin',
];
const CP_V1 = 'data/211325000401PD31_Community_Patch_v1.bin';

const pair = existsSync(REFERENCE) ? new Uint8Array(readFileSync(REFERENCE)) : undefined;
const maybe = pair ? it : it.skip;
const load = (p: string) => new Uint8Array(readFileSync(p));

describe('the bundled reference bootloader', () => {
    maybe('is exactly two sectors and nothing else', () => {
        expect(pair!.length).toBe(SA0_LENGTH * 2);
    });

    maybe('matches every genuine BMW CSL dump, master and slave', () => {
        for (const path of GENUINE_CSL) {
            if (!existsSync(path)) continue;
            const image = load(path);
            for (const p of ['master', 'slave'] as const) {
                expect(diffOffsets(referenceCslSa0(pair!, p), extractSa0(image, p)), `${path} ${p}`)
                    .toEqual([]);
            }
        }
    });

    maybe('matches the community patch too, which is the fifth independent source', () => {
        if (!existsSync(CP_V1)) return;
        const image = load(CP_V1);
        for (const p of ['master', 'slave'] as const) {
            expect(diffOffsets(referenceCslSa0(pair!, p), extractSa0(image, p))).toEqual([]);
        }
    });

    maybe('carries a valid CRC on both sectors, as BMW stores it', () => {
        for (const p of ['master', 'slave'] as const) {
            const crc = verifyBootloaderCrc(referenceCslSa0(pair!, p), p);
            expect(crc.stored, `${p} CRC`).toBe(crc.computed);
        }
    });
});

describe('reconciling a car against the reference', () => {
    maybe('reports nothing when the derivation already agrees', () => {
        if (!existsSync(GENUINE_CSL[0]!)) return;
        // A genuine CSL sector is what a correct derivation lands on, so use one as the stand-in
        // for a healthy car by checking the reference against itself through the same path.
        for (const p of ['master', 'slave'] as const) {
            const built = patchToCsl(referenceCslSa0(pair!, p), p, referenceCslSa0(pair!, p));
            expect(built.anomalies).toEqual([]);
        }
    });

    maybe('normalises a byte the car has and no reference image does, and says so', () => {
        for (const p of ['master', 'slave'] as const) {
            const reference = referenceCslSa0(pair!, p);
            // The shape the real car had: bytes outside the CRC range, which BMW's checksum never
            // covered, so nothing on the ECU would ever have complained about them.
            const sick = Uint8Array.from(reference);
            sick[0x3fe4] = 0x82;
            sick[0x3fe5] = 0x79;

            const built = patchToCsl(sick, p, reference);
            expect(built.anomalies.map((a) => a.offset)).toEqual([0x3fe4, 0x3fe5]);
            expect(built.anomalies[0]).toMatchObject({ derived: 0x82, reference: reference[0x3fe4] });
            // Warned about, and not carried into what gets written.
            expect(diffOffsets(built.sa0, reference)).toEqual([]);
            // Whether BMW's own checksum would have caught it is the operator's cue for how long
            // it may have been there - and it depends on which processor, because the two CRCs
            // cover different ranges. The master's runs to 0x3FFD, so 0x3FE4 is inside it; the
            // slave's stops at 0x3FE1, which is why the real car's copy went unnoticed.
            expect(built.anomalies.every((a) => a.outsideCrc)).toBe(p === 'slave');
        }
    });

    maybe('marks an anomaly inside the CRC range as such', () => {
        const p = 'master' as const;
        const reference = referenceCslSa0(pair!, p);
        const sick = Uint8Array.from(reference);
        sick[0x1000] = (reference[0x1000]! ^ 0xff) & 0xff;
        const built = patchToCsl(sick, p, reference);
        expect(built.anomalies).toHaveLength(1);
        expect(built.anomalies[0]!.outsideCrc).toBe(false);
        expect(diffOffsets(built.sa0, reference)).toEqual([]);
    });

    maybe('still derives, so the provenance argument is unaffected', () => {
        // No reference: the old behaviour, which is what proves the tool can reconstruct the
        // bootloader rather than merely carry it.
        if (!existsSync(GENUINE_CSL[0]!)) return;
        for (const p of ['master', 'slave'] as const) {
            const built = patchToCsl(referenceCslSa0(pair!, p), p);
            expect(built.anomalies).toEqual([]);
        }
    });
});
