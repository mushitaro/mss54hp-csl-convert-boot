/**
 * The provenance proof, as a regression test.
 *
 * The question this file settles: is the bootloader in the community patch the genuine BMW CSL
 * bootloader, or is it a standard M3 bootloader that somebody relabelled?
 *
 * The bytes cannot answer that on their own - a CRC-16 is unkeyed and takes seconds to fix - so
 * the answer comes from comparing against ECUs BMW actually shipped. Four factory CSL dumps are
 * checked in under data/genuine-csl, and a real-car standard M3 dump provides the other end of
 * the comparison. The result is that "patched" and "genuine" are the same bytes.
 *
 * These assertions are what a future edit to bootloaderImage.ts has to keep true.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
    SA0_LENGTH, KNOWN_BOOTLOADER_CRC, BOOTLOADER_DIFF_OFFSETS,
    extractSa0, verifyBootloaderCrc, patchToCsl, identifyBootloader, diffOffsets,
    masterProgramNumbers, correctBootloaderCrc, BOOTLOADER_SPEC, conversionStages,
} from './bootloaderImage';
import type { Processor } from './imageLayout';

const PROCESSORS: readonly Processor[] = ['master', 'slave'];

/** The CSL 0401 image the rest of the suite already uses (a CSL bootloader, renamed program). */
const CSL_IMAGE = process.env.CSL_0401_BIN
    ?? String.raw`C:\Users\kazuh\CSL_0401_Binary_Disassembly_Notes\Full 211323000401PD31_TERRA.bin`;

/** The community patch: the image whose bootloader is under suspicion. */
const CP_V1 = process.env.CP_V1_BIN
    ?? join(process.cwd(), 'data', '211325000401PD31_Community_Patch_v1.bin');

/** A real-car standard M3 dump - the "before" side of the diff. */
const HW2001 = process.env.HW2001_BIN
    ?? String.raw`C:\Users\kazuh\MSS54-DS2-Tool-Public-1.2.1\hw2001-analysis\hw2001_full.bin`;

/** Factory CSL ECU dumps, released by BMW in December 2004. */
const GENUINE_DIR = process.env.YUL_CSL_DIR ?? join(process.cwd(), 'data', 'genuine-csl');

function load(path: string): Uint8Array | undefined {
    return existsSync(path) ? new Uint8Array(readFileSync(path)) : undefined;
}

function genuineDumps(): { name: string; image: Uint8Array }[] {
    if (!existsSync(GENUINE_DIR)) return [];
    return readdirSync(GENUINE_DIR)
        .filter((f) => f.toLowerCase().endsWith('.bin'))
        .map((f) => ({ name: f, image: new Uint8Array(readFileSync(join(GENUINE_DIR, f))) }))
        .filter((d) => d.image.length === 0x100000);
}

const terraImage = load(CSL_IMAGE);
const cpV1 = load(CP_V1);
const stockM3 = load(HW2001);
const genuine = genuineDumps();

/** A CSL *bootloader* to test against: the community patch, or any factory dump. */
const cslBootImage = cpV1 ?? genuine[0]?.image;

const withTerra = terraImage ? it : it.skip;
const withStock = stockM3 ? it : it.skip;
const withCslBoot = cslBootImage ? it : it.skip;
const withBoth = cslBootImage && stockM3 ? it : it.skip;
const withGenuine = genuine.length > 0 ? it : it.skip;
const withGenuineAndStock = genuine.length > 0 && stockM3 ? it : it.skip;
const withGenuineAndCp = genuine.length > 0 && cpV1 ? it : it.skip;

describe('the bootloader sector', () => {
    withCslBoot('carries a CRC-16/ARC over itself that validates, on both processors', () => {
        for (const processor of PROCESSORS) {
            const crc = verifyBootloaderCrc(extractSa0(cslBootImage!, processor), processor);
            expect(crc.valid).toBe(true);
            expect(crc.stored).toBe(KNOWN_BOOTLOADER_CRC.csl[processor]);
        }
    });

    withStock('validates on a real-car standard M3 dump too, with the standard values', () => {
        for (const processor of PROCESSORS) {
            const crc = verifyBootloaderCrc(extractSa0(stockM3!, processor), processor);
            expect(crc.valid).toBe(true);
            expect(crc.stored).toBe(KNOWN_BOOTLOADER_CRC.standardM3[processor]);
        }
    });

    withStock('is identified by its health-check operand, not by its label', () => {
        for (const processor of PROCESSORS) {
            expect(identifyBootloader(extractSa0(stockM3!, processor), processor)).toBe('standard-m3');
        }
    });

    withCslBoot('reports the CSL program number three times on the master', () => {
        const numbers = masterProgramNumbers(extractSa0(cslBootImage!, 'master'));
        expect(numbers).toEqual(['21132500', '21132500', '21132500']);
    });

    withStock('reports the standard program number three times on a standard master', () => {
        expect(masterProgramNumbers(extractSa0(stockM3!, 'master'))).toEqual(['21132300', '21132300', '21132300']);
    });
});

/**
 * The reason this project exists, stated as a test.
 *
 * The TERRA image is a CSL 0401 *program* - but its bootloader sector is byte-identical to a
 * real-car standard M3 dump. So the community's working conversion runs CSL software on the
 * standard bootloader, and the DME still identifies itself as 21132300 in programming mode.
 * If a future image ever changes this, that is a headline, not a detail.
 */
describe('the CSL program as the community ships it today', () => {
    withTerra('runs on the STANDARD M3 bootloader, not the CSL one', () => {
        for (const processor of PROCESSORS) {
            const sa0 = extractSa0(terraImage!, processor);
            expect(identifyBootloader(sa0, processor)).toBe('standard-m3');
            expect(verifyBootloaderCrc(sa0, processor).stored).toBe(KNOWN_BOOTLOADER_CRC.standardM3[processor]);
        }
        expect(masterProgramNumbers(extractSa0(terraImage!, 'master'))).toEqual(['21132300', '21132300', '21132300']);
    });

    withTerra('has a bootloader untouched by the third-party modification in its program area', () => {
        if (!stockM3) return;
        for (const processor of PROCESSORS) {
            expect(diffOffsets(extractSa0(terraImage!, processor), extractSa0(stockM3, processor))).toEqual([]);
        }
    });
});

describe('standard M3 versus CSL', () => {
    withBoth('differ at exactly the six master and three slave offsets, and nowhere else', () => {
        for (const processor of PROCESSORS) {
            const diff = diffOffsets(extractSa0(stockM3!, processor), extractSa0(cslBootImage!, processor));
            expect(diff).toEqual([...BOOTLOADER_DIFF_OFFSETS[processor]]);
        }
    });

    withBoth('are otherwise the same code: only one instruction operand differs outside the identity block', () => {
        for (const processor of PROCESSORS) {
            const spec = BOOTLOADER_SPEC[processor];
            const identityStart = processor === 'master' ? 0x3fc8 : 0x3fd0;
            const codeDiff = diffOffsets(extractSa0(stockM3!, processor), extractSa0(cslBootImage!, processor))
                .filter((o) => o < identityStart && o !== spec.crcSlot && o !== spec.crcSlot + 1);
            expect(codeDiff).toEqual([0x12ae]);
        }
    });
});

describe('provenance: is the community patch bootloader genuine?', () => {
    withGenuine('every genuine factory CSL dump has a self-consistent bootloader CRC', () => {
        for (const { name, image } of genuine) {
            for (const processor of PROCESSORS) {
                const crc = verifyBootloaderCrc(extractSa0(image, processor), processor);
                expect(crc.valid, `${name} ${processor}`).toBe(true);
                expect(crc.stored, `${name} ${processor}`).toBe(KNOWN_BOOTLOADER_CRC.csl[processor]);
            }
        }
    });

    withGenuineAndCp('the community patch bootloader is byte-identical to the factory one', () => {
        for (const { name, image } of genuine) {
            for (const processor of PROCESSORS) {
                expect(
                    diffOffsets(extractSa0(image, processor), extractSa0(cpV1!, processor)),
                    `${name} ${processor}`,
                ).toEqual([]);
            }
        }
    });

    withGenuineAndStock('patching a standard M3 bootloader reproduces the factory CSL one exactly', () => {
        for (const processor of PROCESSORS) {
            const patched = patchToCsl(extractSa0(stockM3!, processor), processor);
            expect(patched.crc.valid).toBe(true);
            expect(patched.crc.stored).toBe(KNOWN_BOOTLOADER_CRC.csl[processor]);
            expect(identifyBootloader(patched.sa0, processor)).toBe('csl');
            for (const { name, image } of genuine) {
                expect(diffOffsets(patched.sa0, extractSa0(image, processor)), `${name} ${processor}`).toEqual([]);
            }
        }
    });

    withGenuineAndStock('the patch touches only the offsets we claim it does', () => {
        for (const processor of PROCESSORS) {
            const patched = patchToCsl(extractSa0(stockM3!, processor), processor);
            const touched = patched.edits.map((e) => e.offset).sort((a, b) => a - b);
            expect(touched).toEqual([...BOOTLOADER_DIFF_OFFSETS[processor]]);
        }
    });
});

describe('the sector helpers', () => {
    it('refuse a sector of the wrong size rather than reading past it', () => {
        expect(() => verifyBootloaderCrc(new Uint8Array(16), 'master')).toThrow(/must be 16384 bytes/);
        expect(() => patchToCsl(new Uint8Array(SA0_LENGTH - 1), 'master')).toThrow(/must be 16384 bytes/);
    });

    it('refuse a full image of the wrong size', () => {
        expect(() => extractSa0(new Uint8Array(1024), 'master')).toThrow(/must be 1048576 bytes/);
    });

    withStock('do not mutate their input', () => {
        const original = extractSa0(stockM3!, 'master');
        const copy = Uint8Array.from(original);
        patchToCsl(original, 'master');
        expect(diffOffsets(original, copy)).toEqual([]);
    });

    it('round-trip an arbitrary sector through correctBootloaderCrc', () => {
        const sa0 = new Uint8Array(SA0_LENGTH).fill(0x5a);
        const written = correctBootloaderCrc(sa0, 'slave');
        const read = verifyBootloaderCrc(sa0, 'slave');
        expect(read.valid).toBe(true);
        expect(read.stored).toBe(written.stored);
    });
});

describe('which processor is next', () => {
    it('starts with the slave on a stock car, because its edit only clears a bit', () => {
        // 0x12AE: slave E1 -> E0 clears bit 0. Master E0 -> F0 sets bit 4, and '3' -> '5' sets
        // bit 1 - both need SA0 erased. The half that may not need an erase goes first.
        const stages = conversionStages('standard-m3', 'standard-m3');
        expect(stages).toEqual({ next: 'slave', stage: 1, total: 2, done: [], blocked: false });
    });

    it('moves to the master once the slave is CSL', () => {
        const stages = conversionStages('standard-m3', 'csl');
        expect(stages).toEqual({ next: 'master', stage: 2, total: 2, done: ['slave'], blocked: false });
    });

    it('reports nothing left to do when both are CSL', () => {
        const stages = conversionStages('csl', 'csl');
        expect(stages.next).toBeNull();
        expect(stages.done).toEqual(['master', 'slave']);
        expect(stages.blocked).toBe(false);
    });

    it('never offers both at once - there is always at most one next', () => {
        for (const master of ['standard-m3', 'csl'] as const) {
            for (const slave of ['standard-m3', 'csl'] as const) {
                const { next } = conversionStages(master, slave);
                expect(next === null || next === 'master' || next === 'slave').toBe(true);
            }
        }
    });

    it('refuses to plan anything against a bootloader it cannot identify', () => {
        for (const pair of [['unknown', 'standard-m3'], ['standard-m3', 'unknown'], ['unknown', 'unknown']] as const) {
            const stages = conversionStages(pair[0], pair[1]);
            expect(stages.blocked).toBe(true);
            expect(stages.next).toBeNull();
        }
    });

    it('counts a master already converted, so a resumed job does not redo it', () => {
        // The unusual order - master done, slave not - is still handled: the remaining work is the
        // slave, and it is stage 2 of 2 because one stage is already behind.
        const stages = conversionStages('csl', 'standard-m3');
        expect(stages).toEqual({ next: 'slave', stage: 2, total: 2, done: ['master'], blocked: false });
    });

    it('decides from the operand, so a relabelled image does not count as converted', () => {
        if (!stockM3) return;
        const sa0 = Uint8Array.from(extractSa0(stockM3, 'master'));
        // Rename it to 21132500 without touching the health-check operand.
        for (const asciiOffset of [0x3fd7, 0x3fdf, 0x3fe7]) sa0[asciiOffset] = 0x35;
        expect(masterProgramNumbers(sa0)).toEqual(['21132500', '21132500', '21132500']);
        expect(identifyBootloader(sa0, 'master')).toBe('standard-m3');
        expect(conversionStages(identifyBootloader(sa0, 'master'), 'csl').next).toBe('master');
    });
});
