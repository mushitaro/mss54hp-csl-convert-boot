/**
 * The staged sector, and the ordering rule that keeps a half-finished staging survivable.
 *
 * The magic word at 0xFFFC is checked by the RESET handler, so writing it is what commits the
 * ECU to running the loader on every power-up - not command 0x34. Every assertion about write
 * order here exists because of that: if staging is interrupted before the final chunk, the ECU
 * must still boot normally.
 *
 * The write lock is engaged in this build, so `buildStagedSector` throws. These tests exercise
 * it through a local unlock helper that stubs the lock, which keeps the assembly logic covered
 * without weakening the shipped lock - `writeLock.test.ts` proves the lock itself still holds.
 */
import { describe, it, expect, vi } from 'vitest';
import {
    STAGED_SECTOR_LENGTH, LOADER_CODE_OFFSET, BOOTLOADER_IMAGE_OFFSET, MAGIC_OFFSET,
    STAGED_MAGIC, MAGIC_CLEARED, LOADER_CODE_CAPACITY, FORBIDDEN_FIRST_BYTE, STAGING_DS2_ADDRESS,
    assertLoaderCodeIsStageable, sectorIsArmed, assertMagicIsLast,
} from './blLoader';
import { SA0_LENGTH, correctBootloaderCrc } from './bootloaderImage';
import { WRITE_CHUNK_MAX } from './regionMap';
import type { Processor } from './imageLayout';

vi.mock('./writeLock', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./writeLock')>();
    return { ...actual, assertWriteUnlocked: () => { /* unlocked for assembly tests only */ } };
});

// Imported after the mock so the module under test picks up the stubbed lock.
const { buildStagedSector, stagedWriteOrder } = await import('./blLoader');

const PROCESSORS: readonly Processor[] = ['master', 'slave'];

/** A syntactically valid bootloader image: correct length, self-consistent CRC. */
function fakeBootloader(processor: Processor): Uint8Array {
    const sa0 = new Uint8Array(SA0_LENGTH).fill(0xa5);
    correctBootloaderCrc(sa0, processor);
    return sa0;
}

/** Loader code starting with BRA (0x60), which neither processor forbids. */
function fakeLoader(length = 64): Uint8Array {
    const code = new Uint8Array(length).fill(0x4e);
    code[0] = 0x60;
    code[1] = 0x00;
    return code;
}

describe('the staged sector layout', () => {
    it('is one Am29F400BB 32 KiB sector with the magic in its last four bytes', () => {
        expect(STAGED_SECTOR_LENGTH).toBe(0x8000);
        expect(MAGIC_OFFSET + 4).toBe(STAGED_SECTOR_LENGTH);
        expect(LOADER_CODE_OFFSET).toBe(0);
        expect(BOOTLOADER_IMAGE_OFFSET + SA0_LENGTH).toBeLessThanOrEqual(MAGIC_OFFSET);
    });

    it('places the loader at CPU 0x8000, the image at 0x9000 and the magic at 0xFFFC', () => {
        for (const processor of PROCESSORS) {
            const sector = buildStagedSector(processor, fakeLoader(), fakeBootloader(processor));
            expect(sector.bytes).toHaveLength(STAGED_SECTOR_LENGTH);
            expect(sector.ds2Address).toBe(STAGING_DS2_ADDRESS[processor]);
            expect(sector.magicDs2Address).toBe(STAGING_DS2_ADDRESS[processor] + 0x7ffc);
            expect(sector.bytes[BOOTLOADER_IMAGE_OFFSET]).toBe(0xa5);
            expect(sectorIsArmed(sector.bytes)).toBe(true);
        }
    });

    it('fills everything it does not use with 0xFF, the erased state', () => {
        const sector = buildStagedSector('master', fakeLoader(64), fakeBootloader('master'));
        expect(sector.bytes[64]).toBe(0xff);
        expect(sector.bytes[BOOTLOADER_IMAGE_OFFSET - 1]).toBe(0xff);
        expect(sector.bytes[BOOTLOADER_IMAGE_OFFSET + SA0_LENGTH]).toBe(0xff);
    });

    it('is not a calibration pair: no checksum is written, only the staged bytes', () => {
        // A calibration half keeps a CRC-16/ARC at +0x3FFC. This sector must NOT have had
        // correctChecksums run over it - +0x3FFC here is just part of the bootloader image being
        // carried, and the sector's own tail holds the magic instead. That difference is what
        // stops the normal conversion path from ever emitting one of these by accident.
        const image = fakeBootloader('master');
        const sector = buildStagedSector('master', fakeLoader(), image);
        expect(sector.bytes[0x3ffc]).toBe(image[0x3ffc - BOOTLOADER_IMAGE_OFFSET]);
        expect(sector.bytes[0x3ffd]).toBe(image[0x3ffd - BOOTLOADER_IMAGE_OFFSET]);
    });
});

describe('the first-byte gate', () => {
    it('refuses loader code that begins with the byte its processor rejects', () => {
        for (const processor of PROCESSORS) {
            const bad = fakeLoader();
            bad[0] = FORBIDDEN_FIRST_BYTE[processor];
            expect(() => assertLoaderCodeIsStageable(processor, bad)).toThrow(/refuses/);
        }
    });

    it('accepts the two entry instructions a loader would realistically use', () => {
        for (const processor of PROCESSORS) {
            for (const first of [0x60 /* BRA */, 0x46 /* MOVE to SR */]) {
                const code = fakeLoader();
                code[0] = first;
                expect(() => assertLoaderCodeIsStageable(processor, code)).not.toThrow();
            }
        }
    });

    it('lets each processor use the byte the OTHER one forbids', () => {
        const masterCode = fakeLoader();
        masterCode[0] = FORBIDDEN_FIRST_BYTE.slave;
        expect(() => assertLoaderCodeIsStageable('master', masterCode)).not.toThrow();
    });

    it('refuses loader code that would overrun the bootloader image', () => {
        expect(() => assertLoaderCodeIsStageable('master', fakeLoader(LOADER_CODE_CAPACITY + 2))).toThrow(/overruns/);
    });

    it('refuses an odd-length loader', () => {
        expect(() => assertLoaderCodeIsStageable('master', fakeLoader(63))).toThrow(/even number of bytes/);
    });
});

describe('the bootloader image being staged', () => {
    it('is refused when its CRC does not validate', () => {
        const broken = new Uint8Array(SA0_LENGTH).fill(0xa5);
        expect(() => buildStagedSector('master', fakeLoader(), broken)).toThrow(/CRC does not validate/);
    });

    it('is refused when it is the wrong size', () => {
        expect(() => buildStagedSector('master', fakeLoader(), new Uint8Array(SA0_LENGTH - 2)))
            .toThrow(/must be 16384 bytes/);
    });
});

describe('the write order arms the ECU last', () => {
    for (const chunkSize of [WRITE_CHUNK_MAX, 2, 64, 0x1000]) {
        it(`puts the magic in the final chunk at chunk size ${chunkSize}`, () => {
            const sector = buildStagedSector('master', fakeLoader(), fakeBootloader('master'));
            const steps = stagedWriteOrder(sector, chunkSize);
            expect(steps.filter((s) => s.armsTheEcu)).toHaveLength(1);
            expect(steps[steps.length - 1]?.armsTheEcu).toBe(true);
            expect(steps.reduce((n, s) => n + s.bytes.length, 0)).toBe(STAGED_SECTOR_LENGTH);
        });
    }

    it('writes ascending addresses with no gaps', () => {
        const sector = buildStagedSector('slave', fakeLoader(), fakeBootloader('slave'));
        const steps = stagedWriteOrder(sector, WRITE_CHUNK_MAX);
        let expected = sector.ds2Address;
        for (const step of steps) {
            expect(step.ds2Address).toBe(expected);
            expected += step.bytes.length;
        }
    });

    it('rejects an ordering where the magic is not last', () => {
        const sector = buildStagedSector('master', fakeLoader(), fakeBootloader('master'));
        const steps = stagedWriteOrder(sector, WRITE_CHUNK_MAX);
        const reordered = [steps[steps.length - 1]!, ...steps.slice(0, -1)];
        expect(() => assertMagicIsLast(reordered)).toThrow(/must be written last/);
    });

    it('rejects an odd chunk size, which flash cannot program', () => {
        const sector = buildStagedSector('master', fakeLoader(), fakeBootloader('master'));
        expect(() => stagedWriteOrder(sector, 121)).toThrow(/positive and even/);
    });
});

describe('the magic word', () => {
    it('is the value the reset handler compares against', () => {
        expect(STAGED_MAGIC).toBe(0x5aa556c9);
    });

    it('is cleared to zero, which NOR can do without an erase', () => {
        expect(MAGIC_CLEARED).toBe(0);
        // Every bit of the cleared value must be reachable from the magic by clearing only.
        expect((STAGED_MAGIC & MAGIC_CLEARED) >>> 0).toBe(MAGIC_CLEARED);
    });

    it('recognises an armed sector, and does not mistake an unarmed one for armed', () => {
        const sector = buildStagedSector('master', fakeLoader(), fakeBootloader('master'));
        expect(sectorIsArmed(sector.bytes)).toBe(true);

        const disarmed = Uint8Array.from(sector.bytes);
        disarmed.fill(0, MAGIC_OFFSET, MAGIC_OFFSET + 4);
        expect(sectorIsArmed(disarmed)).toBe(false);

        expect(sectorIsArmed(new Uint8Array(STAGED_SECTOR_LENGTH).fill(0xff))).toBe(false);
        expect(sectorIsArmed(new Uint8Array(16))).toBe(false);
    });
});
