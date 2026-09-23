/**
 * The bootloader replacement, executed end to end on the emulator.
 *
 * This is the whole project in one test: an ECU that starts with the standard M3 bootloader
 * (21132300) is left holding the genuine CSL bootloader (21132500), byte for byte, with a valid
 * CRC - and nothing else in flash disturbed.
 *
 * The starting SA0 comes from a real-car standard M3 dump and the target SA0 from factory CSL
 * ECU dumps, so "before" and "after" are both bytes BMW shipped rather than anything constructed
 * for the test.
 *
 * The negative controls are the point. Every hazard identified in the analysis is injected here
 * and the loader is required to fail in the *survivable* direction: refusing before it erases,
 * or reporting failure rather than hanging, and never leaving an ECU armed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { assemble } from './asm68k';
import { Cpu32 } from './cpu32';
import { Machine } from './machine';
import { FLASH_LENGTH } from './flashAm29f400';
import {
    SA0_LENGTH, extractSa0, verifyBootloaderCrc, identifyBootloader,
    masterProgramNumbers, KNOWN_BOOTLOADER_CRC, diffOffsets,
} from '../bootloaderImage';

const STOCK_M3 = process.env.HW2001_BIN
    ?? String.raw`C:\Users\kazuh\MSS54-DS2-Tool-Public-1.2.1\hw2001-analysis\hw2001_full.bin`;
const CP_V1 = process.env.CP_V1_BIN
    ?? join(process.cwd(), 'data', '211325000401PD31_Community_Patch_v1.bin');

const haveBoth = existsSync(STOCK_M3) && existsSync(CP_V1);
const stockImage = existsSync(STOCK_M3) ? new Uint8Array(readFileSync(STOCK_M3)) : undefined;
const cslImage = existsSync(CP_V1) ? new Uint8Array(readFileSync(CP_V1)) : undefined;
const maybe = haveBoth ? it : it.skip;

const loader = assemble(readFileSync('tools/loader/replace.s', 'utf8'));

const SECTOR_BASE = 0x8000;
const IMAGE_OFFSET = 0x9000;
const MAGIC_OFFSET = 0xfffc;
const MAGIC = 0x5aa556c9;

interface Rig {
    cpu: Cpu32;
    machine: Machine;
    doneAddress: number;
    giveupAddress: number;
    /** VBR at the moment the first sector erase was confirmed, or undefined if none. */
    vbrAtErase: number | undefined;
    /** True once a sector erase of SA0 has been confirmed. */
    erasedSa0: boolean;
}

function stagedRig(options: {
    /** Leave the image region erased, as a mis-staged sector would be. */
    blankImage?: boolean;
    flashOptions?: ConstructorParameters<typeof Machine>[1];
} = {}): Rig {
    // Start from a real standard M3 ECU: its own bootloader in SA0, its own service block.
    const flash = stockImage!.slice(0, FLASH_LENGTH);

    // Stage the calibration sector: erased, loader, replacement image, magic last.
    flash.fill(0xff, SECTOR_BASE, SECTOR_BASE + 0x8000);
    flash.set(loader.bytes, SECTOR_BASE);
    if (!options.blankImage) flash.set(extractSa0(cslImage!, 'master'), IMAGE_OFFSET);
    flash[MAGIC_OFFSET] = (MAGIC >>> 24) & 0xff;
    flash[MAGIC_OFFSET + 1] = (MAGIC >>> 16) & 0xff;
    flash[MAGIC_OFFSET + 2] = (MAGIC >>> 8) & 0xff;
    flash[MAGIC_OFFSET + 3] = MAGIC & 0xff;

    const machine = new Machine(flash, {
        programPolls: 1, erasePolls: 4, watchdogInstructions: 400, ...options.flashOptions,
    });
    machine.applyResetInstruction();

    const rig: Rig = {
        cpu: undefined as unknown as Cpu32, machine,
        doneAddress: SECTOR_BASE + loader.labels.get('done')!,
        giveupAddress: SECTOR_BASE + loader.labels.get('giveup')!,
        vbrAtErase: undefined, erasedSa0: false,
    };

    rig.cpu = new Cpu32({
        readWord: (a, f) => { machine.tick(); return machine.readWord(a, f); },
        readByte: (a, f) => machine.readByte(a, f),
        writeWord: (a, v) => {
            // The erase confirm cycle is 0x30 written to an address inside the sector.
            if ((v & 0xff) === 0x30 && (a >>> 0) < SA0_LENGTH && rig.vbrAtErase === undefined) {
                rig.vbrAtErase = rig.cpu.vbr;
                rig.erasedSa0 = true;
            }
            machine.writeWord(a, v);
        },
        writeByte: (a, v) => machine.writeByte(a, v),
    });
    rig.cpu.pc = SECTOR_BASE;
    rig.cpu.a[7] = 0;
    rig.cpu.vbr = 0;
    rig.cpu.sr = 0x2700;
    return rig;
}

function run(rig: Rig, maxInstructions = 4_000_000): 'done' | 'giveup' {
    rig.cpu.run(() => rig.cpu.pc === rig.doneAddress || rig.cpu.pc === rig.giveupAddress, maxInstructions);
    return rig.cpu.pc === rig.doneAddress ? 'done' : 'giveup';
}

function magicAt(machine: Machine): number {
    const a = machine.flash.array;
    return (((a[MAGIC_OFFSET] ?? 0) << 24) | ((a[MAGIC_OFFSET + 1] ?? 0) << 16)
        | ((a[MAGIC_OFFSET + 2] ?? 0) << 8) | (a[MAGIC_OFFSET + 3] ?? 0)) >>> 0;
}

describe('the replacement loader, as a program', () => {
    it('starts with a byte neither processor refuses', () => {
        expect(loader.bytes[0]).toBe(0x46);
    });

    it('fits in the space reserved before the staged image', () => {
        expect(loader.bytes.length).toBeLessThanOrEqual(IMAGE_OFFSET - SECTOR_BASE);
    });

    it('contains no RESET instruction: it leaves by watchdog', () => {
        for (let i = 0; i < loader.bytes.length; i += 2) {
            const word = ((loader.bytes[i] ?? 0) << 8) | (loader.bytes[i + 1] ?? 0);
            expect(word, `word at ${i}`).not.toBe(0x4e70);
        }
    });

    it('copies both flash routines whole, with the single-word entry inside the block', () => {
        const l = loader.labels;
        expect(l.get('prog_one')!).toBeGreaterThan(l.get('prog_stub')!);
        expect(l.get('prog_one')!).toBeLessThan(l.get('prog_end')!);
        expect(l.get('erase_end')! - l.get('erase_stub')!).toBeGreaterThan(0);
    });
});

describe('replacing a standard M3 bootloader with the genuine CSL one', () => {
    maybe('starts from a real standard M3 bootloader', () => {
        const rig = stagedRig();
        const before = rig.machine.flash.array.slice(0, SA0_LENGTH);
        expect(identifyBootloader(before, 'master')).toBe('standard-m3');
        expect(verifyBootloaderCrc(before, 'master').stored).toBe(KNOWN_BOOTLOADER_CRC.standardM3.master);
        expect(masterProgramNumbers(before)).toEqual(['21132300', '21132300', '21132300']);
    });

    maybe('leaves the genuine CSL bootloader in place, byte for byte', () => {
        const rig = stagedRig();
        expect(run(rig)).toBe('done');

        const after = rig.machine.flash.array.slice(0, SA0_LENGTH);
        const expected = extractSa0(cslImage!, 'master');
        expect(diffOffsets(after, expected)).toEqual([]);
    });

    maybe('and that bootloader identifies as CSL, with a CRC that validates', () => {
        const rig = stagedRig();
        run(rig);
        const after = rig.machine.flash.array.slice(0, SA0_LENGTH);
        expect(identifyBootloader(after, 'master')).toBe('csl');
        expect(verifyBootloaderCrc(after, 'master').valid).toBe(true);
        expect(verifyBootloaderCrc(after, 'master').stored).toBe(KNOWN_BOOTLOADER_CRC.csl.master);
        expect(masterProgramNumbers(after)).toEqual(['21132500', '21132500', '21132500']);
    });

    maybe('disarms the ECU, so the next reset boots the new bootloader', () => {
        const rig = stagedRig();
        expect(magicAt(rig.machine)).toBe(MAGIC);
        run(rig);
        expect(magicAt(rig.machine)).toBe(0);
    });

    maybe('clears the magic BEFORE it erases anything', () => {
        // Ordering is the difference between a recoverable failure and a brick.
        const rig = stagedRig();
        let magicClearedFirst = false;
        const machine = rig.machine;
        const original = machine.writeWord.bind(machine);
        // Watch the array rather than the bus: the program completes asynchronously.
        rig.cpu.run(() => {
            if (!magicClearedFirst && magicAt(machine) === 0) magicClearedFirst = true;
            return rig.erasedSa0 || rig.cpu.pc === rig.doneAddress || rig.cpu.pc === rig.giveupAddress;
        }, 4_000_000);
        void original;
        expect(rig.erasedSa0).toBe(true);
        expect(magicClearedFirst).toBe(true);
    });

    maybe('moves VBR into RAM before erasing the sector holding the vector table', () => {
        const rig = stagedRig();
        run(rig);
        expect(rig.erasedSa0).toBe(true);
        // The vectors live at address 0, inside SA0. Erasing with VBR still 0 means any
        // exception afterwards takes a double bus fault and the ECU is gone.
        expect(rig.vbrAtErase).toBe(0x00ffe000);
        expect(rig.cpu.vbr).toBe(0x00ffe000);
    });

    maybe('records no violation of any kind', () => {
        const rig = stagedRig();
        run(rig);
        expect(rig.machine.flash.violations).toEqual([]);
        expect(rig.machine.violations).toEqual([]);
    });

    maybe('never fetches an instruction from flash while the device is busy', () => {
        const rig = stagedRig();
        run(rig);
        expect(rig.machine.flash.violations.filter((v) => v.kind === 'fetch-while-busy')).toEqual([]);
    });

    maybe('services the watchdog throughout a 16 KiB program', () => {
        const rig = stagedRig();
        run(rig);
        expect(rig.machine.watchdogFired).toBe(false);
    });

    /**
     * The whole replacement, interpreted instruction by instruction: erase, 16 KiB of programming
     * with DQ7/DQ5 polling on every word, then a full read-back. It measures ~4.7 s on an idle
     * machine, which is under vitest's 5 s default only by luck - it timed out the moment the
     * machine had anything else running. The timeout is raised here rather than globally: this test
     * is slow for a reason nobody else in the suite shares, and a global raise would let a
     * genuinely hung test sit for half a minute.
     */
    maybe('changes only the bootloader sector and the magic', () => {
        const rig = stagedRig();
        const before = Uint8Array.from(rig.machine.flash.array);
        run(rig);
        const after = rig.machine.flash.array;
        for (let i = SA0_LENGTH; i < FLASH_LENGTH; i++) {
            if (i >= MAGIC_OFFSET && i < MAGIC_OFFSET + 4) continue;
            expect(after[i], `offset 0x${i.toString(16)}`).toBe(before[i]);
        }
    }, 30_000);

    maybe('leaves the service block - VIN, AIF, flash counter - exactly as it found it', () => {
        // SA1 and SA2 hold car-specific data that no distributable image contains. Losing them
        // is unrecoverable from anything but this car's own backup.
        const rig = stagedRig();
        run(rig);
        expect(Array.from(rig.machine.flash.array.subarray(0x4000, 0x8000)))
            .toEqual(Array.from(stockImage!.subarray(0x4000, 0x8000)));
    });
});

describe('negative controls', () => {
    maybe('refuses to erase when the staged image is blank, and stays bootable', () => {
        const rig = stagedRig({ blankImage: true });
        expect(run(rig)).toBe('giveup');

        // It must not have touched the bootloader...
        expect(rig.erasedSa0).toBe(false);
        expect(diffOffsets(rig.machine.flash.array.slice(0, SA0_LENGTH), extractSa0(stockImage!, 'master')))
            .toEqual([]);
        // ...and it must have disarmed itself, so the ECU boots normally rather than re-entering
        // this loader on every power-up.
        expect(magicAt(rig.machine)).toBe(0);
    });

    maybe('gives up rather than hanging when a cell will not program', () => {
        const rig = stagedRig({ flashOptions: { stuckByteOffset: 0x1000 } });
        expect(run(rig)).toBe('giveup');
        expect(magicAt(rig.machine)).toBe(0);
    });

    maybe('gives up rather than hanging when the sector will not erase', () => {
        const rig = stagedRig({ flashOptions: { erasePolls: Number.MAX_SAFE_INTEGER } });
        expect(run(rig)).toBe('giveup');
    });

    maybe('a loader that skipped the VBR move would be running with vectors in erased flash', () => {
        // Not a failure of this loader - a demonstration that the assertion above has teeth.
        // Patch out the `movec a0,vbr` (4E7B 8801) and confirm VBR is still 0 at the erase.
        const rig = stagedRig();
        const bytes = rig.machine.flash.array;
        for (let i = SECTOR_BASE; i < SECTOR_BASE + loader.bytes.length - 4; i += 2) {
            if (bytes[i] === 0x4e && bytes[i + 1] === 0x7b && bytes[i + 2] === 0x88 && bytes[i + 3] === 0x01) {
                bytes[i] = 0x4e; bytes[i + 1] = 0x71;      // NOP
                bytes[i + 2] = 0x4e; bytes[i + 3] = 0x71;  // NOP
            }
        }
        run(rig);
        expect(rig.erasedSa0).toBe(true);
        expect(rig.vbrAtErase).toBe(0);   // the hazard the real loader avoids
    });
});
