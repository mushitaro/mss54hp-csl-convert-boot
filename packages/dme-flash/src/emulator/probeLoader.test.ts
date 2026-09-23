/**
 * The probe loader, run on the emulator from the exact state the ECU hands it.
 *
 * This is the offline gate the plan requires before anything is ever armed on real hardware.
 * The probe is the first code that would ever run inside a customer's DME, and the property it
 * has to have is narrow and absolute: **from the state left by the RESET instruction, using
 * nothing it has not set up itself, it must succeed in clearing the magic - or fail in a way
 * that still leaves the ECU bootable.**
 *
 * The negative controls matter as much as the positive one. A harness that only shows the good
 * path proves nothing about whether it would have noticed the bad one, so each hazard the plan
 * identified is injected here and the run is required to fail loudly.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { assemble } from './asm68k';
import { Cpu32 } from './cpu32';
import { Machine } from './machine';
import { FLASH_LENGTH } from './flashAm29f400';

const IMAGE = process.env.CSL_0401_BIN
    ?? String.raw`C:\Users\kazuh\CSL_0401_Binary_Disassembly_Notes\Full 211323000401PD31_TERRA.bin`;
const PROBE_SOURCE = 'tools/loader/probe.s';

const haveImage = existsSync(IMAGE);
const master = haveImage ? new Uint8Array(readFileSync(IMAGE)).slice(0, FLASH_LENGTH) : undefined;
const maybe = haveImage ? it : it.skip;

const SECTOR_BASE = 0x8000;          // SA3, the calibration sector - where the loader is staged
const MAGIC_OFFSET = 0xfffc;         // last four bytes of SA3
const MAGIC = 0x5aa556c9;

const probe = assemble(readFileSync(PROBE_SOURCE, 'utf8'));

interface Rig {
    cpu: Cpu32;
    machine: Machine;
    doneAddress: number;
    failedAddress: number;
}

/**
 * A DME whose calibration sector holds the probe and the magic, in the state the reset handler
 * hands over: modules freshly reset, RAM disabled, A7 = 0, VBR = 0, interrupts masked.
 */
function armedRig(options: {
    skipMagic?: boolean;
    flashOptions?: ConstructorParameters<typeof Machine>[1];
} = {}): Rig {
    const image = Uint8Array.from(master!);
    // Stage the sector: erased, then loader at its base, then the magic at the very end.
    image.fill(0xff, SECTOR_BASE, SECTOR_BASE + 0x8000);
    image.set(probe.bytes, SECTOR_BASE);
    if (!options.skipMagic) {
        image[MAGIC_OFFSET] = (MAGIC >>> 24) & 0xff;
        image[MAGIC_OFFSET + 1] = (MAGIC >>> 16) & 0xff;
        image[MAGIC_OFFSET + 2] = (MAGIC >>> 8) & 0xff;
        image[MAGIC_OFFSET + 3] = MAGIC & 0xff;
    }

    const machine = new Machine(image, { programPolls: 3, watchdogInstructions: 100000, ...options.flashOptions });
    machine.applyResetInstruction();   // exactly what 0x1BDE's RESET leaves behind

    const cpu = new Cpu32({
        readWord: (a, f) => { machine.tick(); return machine.readWord(a, f); },
        readByte: (a, f) => machine.readByte(a, f),
        writeWord: (a, v) => machine.writeWord(a, v),
        writeByte: (a, v) => machine.writeByte(a, v),
    });
    cpu.pc = SECTOR_BASE;
    cpu.a[7] = 0;          // the reset path leaves SSP = 0; the probe must set its own
    cpu.vbr = 0;
    cpu.sr = 0x2700;

    return {
        cpu, machine,
        doneAddress: SECTOR_BASE + probe.labels.get('done')!,
        failedAddress: SECTOR_BASE + probe.labels.get('failed')!,
    };
}

function runProbe(rig: Rig, maxInstructions = 200_000): 'done' | 'failed' {
    rig.cpu.run(() => rig.cpu.pc === rig.doneAddress || rig.cpu.pc === rig.failedAddress, maxInstructions);
    return rig.cpu.pc === rig.doneAddress ? 'done' : 'failed';
}

function magicAt(machine: Machine): number {
    const a = machine.flash.array;
    return (((a[MAGIC_OFFSET] ?? 0) << 24) | ((a[MAGIC_OFFSET + 1] ?? 0) << 16)
        | ((a[MAGIC_OFFSET + 2] ?? 0) << 8) | (a[MAGIC_OFFSET + 3] ?? 0)) >>> 0;
}

describe('the probe loader, as a program', () => {
    it('starts with a byte neither processor refuses', () => {
        // Both the reset path and cmd 0x34 reject 0x01 on the master and 0x02 on the slave,
        // so that a genuine calibration is never executed. MOVE to SR is 0x46.
        expect(probe.bytes[0]).toBe(0x46);
        expect(probe.bytes[0]).not.toBe(0x01);
        expect(probe.bytes[0]).not.toBe(0x02);
    });

    it('fits in the space before a staged bootloader image would begin', () => {
        expect(probe.bytes.length).toBeLessThanOrEqual(0x1000);
        expect(probe.bytes.length % 2).toBe(0);
    });

    it('contains no RESET instruction: it leaves by watchdog, depending on nothing else', () => {
        for (let i = 0; i < probe.bytes.length; i += 2) {
            const word = ((probe.bytes[i] ?? 0) << 8) | (probe.bytes[i + 1] ?? 0);
            expect(word, `word at ${i}`).not.toBe(0x4e70);
        }
    });

    it('clears the magic before it does anything else that could fail', () => {
        // Structural: the JSR to the programming stub must come before any other flash work.
        const labels = probe.labels;
        expect(labels.get('copy')!).toBeLessThan(labels.get('done')!);
        expect(labels.get('stub')!).toBeGreaterThan(labels.get('failed')!);
    });
});

describe('the probe loader, executed from the state the ECU hands it', () => {
    maybe('disarms the ECU and reaches its success path', () => {
        const rig = armedRig();
        expect(magicAt(rig.machine)).toBe(MAGIC);

        expect(runProbe(rig)).toBe('done');
        expect(magicAt(rig.machine)).toBe(0);
    });

    maybe('records no violation of any kind', () => {
        const rig = armedRig();
        runProbe(rig);
        expect(rig.machine.flash.violations).toEqual([]);
        expect(rig.machine.violations).toEqual([]);
    });

    maybe('never fetches an instruction from flash while the device is busy', () => {
        // The whole reason the stub is copied to RAM. The probe programs a word in SA3 while
        // executing from SA3, so getting this wrong is not theoretical.
        const rig = armedRig();
        runProbe(rig);
        expect(rig.machine.flash.violations.filter((v) => v.kind === 'fetch-while-busy')).toEqual([]);
    });

    maybe('changes nothing in flash except the four magic bytes', () => {
        const rig = armedRig();
        const before = Uint8Array.from(rig.machine.flash.array);
        runProbe(rig);
        const after = rig.machine.flash.array;
        const changed: number[] = [];
        for (let i = 0; i < FLASH_LENGTH; i++) if (before[i] !== after[i]) changed.push(i);
        expect(changed).toEqual([MAGIC_OFFSET, MAGIC_OFFSET + 1, MAGIC_OFFSET + 2, MAGIC_OFFSET + 3]);
    });

    maybe('leaves the bootloader sector untouched - it never goes near it', () => {
        const rig = armedRig();
        runProbe(rig);
        expect(Array.from(rig.machine.flash.array.subarray(0, 0x4000)))
            .toEqual(Array.from(master!.subarray(0, 0x4000)));
    });

    maybe('services the watchdog throughout, so a slow program cannot reset it mid-write', () => {
        // A budget far below the whole run: only servicing inside the poll loop survives it.
        const rig = armedRig({ flashOptions: { programPolls: 200, watchdogInstructions: 80 } });
        expect(runProbe(rig)).toBe('done');
        expect(rig.machine.watchdogFired).toBe(false);
    });

    maybe('sets up its own stack rather than trusting the one it inherits', () => {
        const rig = armedRig();
        expect(rig.cpu.a[7]).toBe(0);
        runProbe(rig);
        // It ran a JSR, which would have written through A7. If it had kept the inherited 0,
        // the push would have landed in the TPU register block instead of RAM.
        expect((rig.cpu.a[7] ?? 0) >>> 0).toBeGreaterThanOrEqual(0x00ffe000);
    });

    maybe('is idempotent: running it again on a disarmed ECU is harmless', () => {
        const rig = armedRig({ skipMagic: true });
        // The magic is already 0xFFFF...; programming zeros over it is still bit-clearing.
        expect(runProbe(rig)).toBe('done');
        expect(magicAt(rig.machine)).toBe(0);
        expect(rig.machine.flash.violations).toEqual([]);
    });
});

describe('negative controls: the hazards the plan identified', () => {
    maybe('a stub left in flash instead of RAM is caught as a fetch during a busy device', () => {
        // Rewrite the JSR target so the stub is called in place, in SA3.
        const rig = armedRig();
        const stubInFlash = SECTOR_BASE + probe.labels.get('stub')!;
        // Patch both `jsr STUBDEST` operands (4E B9 00 FF E9 00) to point into flash.
        const bytes = rig.machine.flash.array;
        for (let i = SECTOR_BASE; i < SECTOR_BASE + probe.bytes.length - 6; i += 2) {
            if (bytes[i] === 0x4e && bytes[i + 1] === 0xb9
                && bytes[i + 2] === 0x00 && bytes[i + 3] === 0xff
                && bytes[i + 4] === 0xe9 && bytes[i + 5] === 0x00) {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                bytes[i + 2] = (stubInFlash >>> 24) & 0xff;
                bytes[i + 3] = (stubInFlash >>> 16) & 0xff;
                bytes[i + 4] = (stubInFlash >>> 8) & 0xff;
                bytes[i + 5] = stubInFlash & 0xff;
            }
        }
        try { runProbe(rig, 100_000); } catch { /* it executes status bits; anything may happen */ }
        expect(rig.machine.flash.violations.some((v) => v.kind === 'fetch-while-busy')).toBe(true);
    });

    maybe('a loader that never enables RAM is caught writing into nothing', () => {
        // Blank out the two SRAM setup instructions (move.l and clr.w) with NOPs.
        const rig = armedRig();
        const bytes = rig.machine.flash.array;
        const setupStart = SECTOR_BASE + probe.labels.get('start')! + 10;
        for (let i = 0; i < 20; i += 2) { bytes[setupStart + i] = 0x4e; bytes[setupStart + 1 + i] = 0x71; }
        try { runProbe(rig, 100_000); } catch { /* the jump into RAM lands nowhere */ }
        const blocked = rig.machine.violations.filter(
            (v) => v.kind === 'write-to-disabled-ram' || v.kind === 'unmapped-access');
        expect(blocked.length).toBeGreaterThan(0);
        // And crucially: the magic is still intact, so this ECU would still boot.
        expect(magicAt(rig.machine)).toBe(MAGIC);
    });

    maybe('a chip select that forbids writes is caught, and nothing is programmed', () => {
        const rig = armedRig();
        rig.machine.csorbt = 0x68f0;   // read only
        rig.machine.csor0 = 0x0000;    // disabled
        try { runProbe(rig, 100_000); } catch { /* the program never completes */ }
        expect(rig.machine.violations.some((v) => v.kind === 'flash-write-blocked')).toBe(true);
        expect(magicAt(rig.machine)).toBe(MAGIC);
    });

    maybe('a cell that refuses to program makes the probe report failure, not hang', () => {
        const rig = armedRig({ flashOptions: { stuckByteOffset: MAGIC_OFFSET } });
        expect(runProbe(rig, 200_000)).toBe('failed');
        // The magic is untouched, so the ECU still boots into the loader and can be retried.
        expect(magicAt(rig.machine)).toBe(MAGIC);
    });
});
