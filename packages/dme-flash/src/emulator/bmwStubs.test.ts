/**
 * The emulator validated against BMW's own code.
 *
 * Before this harness is allowed to say anything about a loader we wrote, it has to be shown to
 * be a faithful stand-in for the real machine. The way to do that without an ECU on the bench is
 * to run code that is already known to work on the real silicon: the erase and program routines
 * the resident firmware copies into RAM, lifted byte for byte out of the 0401 image.
 *
 *     flash_erase_sector        0x35DA, 0x62 bytes
 *     flash_program_word        0x348E, 0x64 bytes
 *
 * If these drive the flash model correctly - unlock cycles accepted, DQ7/DQ5 polling terminating,
 * the right sector cleared, the right word programmed - then the model reproduces the behaviour
 * BMW's engineers relied on, and the CPU core decodes the instructions they used. Any failure
 * here is a bug in the emulator, not in the firmware.
 *
 * These routines also document the calling convention our own loader must follow, because it is
 * going to reimplement exactly this.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { Cpu32 } from './cpu32';
import { Machine } from './machine';
import { Am29F400, DQ5, DQ7 } from './flashAm29f400';

const IMAGE = process.env.CSL_0401_BIN
    ?? String.raw`C:\Users\kazuh\CSL_0401_Binary_Disassembly_Notes\Full 211323000401PD31_TERRA.bin`;
const haveImage = existsSync(IMAGE);
/** One processor's flash. The image file holds both; the master half is the first 512 KiB. */
const firmware = haveImage
    ? new Uint8Array(readFileSync(IMAGE)).slice(0, 0x80000)
    : undefined;
const maybe = haveImage ? it : it.skip;

const ERASE_STUB = { address: 0x35da, length: 0x62 };
const PROGRAM_STUB = { address: 0x348e, length: 0x64 };

/** Where the harness places a stub and its stack, mirroring the firmware's use of the stack. */
const STUB_ADDRESS = 0x00ffe100;
const STACK_TOP = 0x00ffe800;
const RETURN_MARKER = 0x00fff0;

interface Rig {
    cpu: Cpu32;
    machine: Machine;
}

/**
 * Build a machine with the firmware image in flash, RAM and chip selects configured the way the
 * resident code configures them, and a stub copied to RAM ready to call.
 */
function rigWithStub(stub: { address: number; length: number }, options = {}): Rig {
    const machine = new Machine(firmware!, { erasePolls: 6, programPolls: 3, ...options });
    machine.enableRamLikeFirmware();
    machine.enableFlashWritesLikeFirmware();

    // Copy the stub out of flash into RAM, exactly as the firmware's wrapper does.
    for (let i = 0; i < stub.length; i += 2) {
        const word = machine.flash.readWord(stub.address + i);
        machine.writeWord(STUB_ADDRESS + i, word);
    }

    const cpu = new Cpu32({
        readWord: (a, f) => { machine.tick(); return machine.readWord(a, f); },
        readByte: (a, f) => machine.readByte(a, f),
        writeWord: (a, v) => machine.writeWord(a, v),
        writeByte: (a, v) => machine.writeByte(a, v),
    });
    cpu.a[7] = STACK_TOP;
    // A return address the harness can detect: the stub ends in RTS.
    machine.writeWord(STACK_TOP - 4, (RETURN_MARKER >>> 16) & 0xffff);
    machine.writeWord(STACK_TOP - 2, RETURN_MARKER & 0xffff);
    cpu.a[7] = STACK_TOP - 4;
    cpu.pc = STUB_ADDRESS;
    return { cpu, machine };
}

function runToReturn(rig: Rig, maxInstructions = 200_000): void {
    rig.cpu.run(() => rig.cpu.pc === RETURN_MARKER, maxInstructions);
}

describe("BMW's own sector-erase routine, running on this emulator", () => {
    maybe('erases the calibration sector and returns success', () => {
        const rig = rigWithStub(ERASE_STUB);
        // The routine takes the sector address in A5 and returns a code in D0.
        rig.cpu.a[5] = 0x8000;
        runToReturn(rig);

        expect(rig.cpu.pc).toBe(RETURN_MARKER);
        expect(rig.cpu.d[0]).toBe(0);  // 0 = success, per the firmware's own convention

        const sector = Am29F400.sectorOf(0x8000);
        expect(sector.start).toBe(0x8000);
        expect(sector.length).toBe(0x8000);
        for (let i = sector.start; i < sector.start + sector.length; i++) {
            expect(rig.machine.flash.array[i], `offset 0x${i.toString(16)}`).toBe(0xff);
        }
    });

    maybe('leaves every other sector untouched - including the bootloader', () => {
        const rig = rigWithStub(ERASE_STUB);
        const before = Uint8Array.from(firmware!.subarray(0, 0x8000));
        rig.cpu.a[5] = 0x8000;
        runToReturn(rig);
        expect(Array.from(rig.machine.flash.array.subarray(0, 0x8000))).toEqual(Array.from(before));
    });

    maybe('erases the bootloader sector when pointed at it - the operation is real', () => {
        // Not something the tool will ever do over DS2, but the loader must be able to, and the
        // model must not special-case SA0.
        const rig = rigWithStub(ERASE_STUB);
        rig.cpu.a[5] = 0x0000;
        runToReturn(rig);
        expect(rig.cpu.d[0]).toBe(0);
        for (let i = 0; i < 0x4000; i++) expect(rig.machine.flash.array[i]).toBe(0xff);
        // SA1 begins immediately after and must survive.
        expect(rig.machine.flash.array[0x4000]).toBe(firmware![0x4000]);
    });

    maybe('services the watchdog inside its polling loop, not just before it', () => {
        // A long erase with a watchdog budget far shorter than the whole operation. Only a
        // routine that services it *inside* the poll loop can survive; one that kicked only in
        // its prologue would be reset partway through, which on a real ECU means a sector left
        // half-erased. The budget (60 bus accesses) sits above the measured worst gap of 34 and
        // far below the ~360 accesses the whole erase takes.
        const rig = rigWithStub(ERASE_STUB, { erasePolls: 40, watchdogInstructions: 60 });
        rig.cpu.a[5] = 0x8000;
        runToReturn(rig);

        expect(rig.cpu.d[0]).toBe(0);
        expect(rig.machine.watchdogFired).toBe(false);
        expect(rig.machine.violations.filter((v) => v.kind === 'watchdog-reset')).toEqual([]);
    });

    maybe('would be reset by the watchdog if it did not service it', () => {
        // The other half of the previous test: with a budget below the worst gap, the same run
        // trips the watchdog. This proves the budget is actually being enforced, so the passing
        // case above means something.
        const rig = rigWithStub(ERASE_STUB, { erasePolls: 40, watchdogInstructions: 10 });
        rig.cpu.a[5] = 0x8000;
        runToReturn(rig);
        expect(rig.machine.watchdogFired).toBe(true);
    });

    maybe('reports failure instead of hanging when a sector will not erase', () => {
        // DQ5 asserted with the operation incomplete is the datasheet's timeout path.
        const rig = rigWithStub(ERASE_STUB, { erasePolls: Number.MAX_SAFE_INTEGER });
        rig.cpu.a[5] = 0x8000;
        // The stub polls DQ7 then DQ5; with an operation that never completes it must exit
        // through its error path rather than looping forever.
        expect(() => runToReturn(rig, 50_000)).not.toThrow();
        expect(rig.cpu.d[0]).not.toBe(0);
    });
});

describe("BMW's own word-program routine, running on this emulator", () => {
    /** The program stub expects: A5 = target word address, D1 = data, D6 = byte address. */
    function programWord(target: number, data: number, options = {}): Rig {
        const rig = rigWithStub(PROGRAM_STUB, options);
        rig.cpu.a[5] = target;
        rig.cpu.d[1] = data;
        rig.cpu.d[6] = target;
        runToReturn(rig);
        return rig;
    }

    maybe('programs a word into erased flash and returns success', () => {
        const rig = rigWithStub(PROGRAM_STUB);
        // Erase first so the cells can take any value.
        rig.machine.flash.array.fill(0xff, 0x8000, 0x10000);
        rig.cpu.a[5] = 0x8000;
        rig.cpu.d[1] = 0x1234;
        rig.cpu.d[6] = 0x8000;
        runToReturn(rig);

        expect(rig.cpu.d[0]).toBe(0);
        expect(rig.machine.flash.array[0x8000]).toBe(0x12);
        expect(rig.machine.flash.array[0x8001]).toBe(0x34);
    });

    maybe('clears bits without an erase, which is legal', () => {
        const rig = rigWithStub(PROGRAM_STUB);
        rig.machine.flash.array[0x8000] = 0xff;
        rig.machine.flash.array[0x8001] = 0xff;
        rig.cpu.a[5] = 0x8000;
        rig.cpu.d[1] = 0x0f0f;
        rig.cpu.d[6] = 0x8000;
        runToReturn(rig);
        expect(rig.cpu.d[0]).toBe(0);
        expect(rig.machine.flash.array[0x8000]).toBe(0x0f);
        // No violation: every changed bit went 1 -> 0.
        expect(rig.machine.flash.violations.filter((v) => v.kind === 'program-sets-bit')).toEqual([]);
    });

    maybe('never issues a 0 -> 1 program, because it reads and ANDs the current word', () => {
        // This is the behaviour that makes "write 0xFF into the untouched half" wrong. The
        // routine is handed a byte and a word address; it must not disturb the other half.
        const rig = rigWithStub(PROGRAM_STUB);
        rig.machine.flash.array[0x8000] = 0x0f;   // already partly programmed
        rig.machine.flash.array[0x8001] = 0xf0;
        rig.cpu.a[5] = 0x8000;
        rig.cpu.d[1] = 0x0700;                     // clear one more bit in the high half
        rig.cpu.d[6] = 0x8000;
        runToReturn(rig);
        expect(rig.machine.flash.violations.filter((v) => v.kind === 'program-sets-bit')).toEqual([]);
    });

    maybe('reports failure when a cell refuses to take its value', () => {
        const rig = rigWithStub(PROGRAM_STUB, { stuckByteOffset: 0x8000 });
        rig.machine.flash.array.fill(0xff, 0x8000, 0x10000);
        rig.cpu.a[5] = 0x8000;
        rig.cpu.d[1] = 0x1234;
        rig.cpu.d[6] = 0x8000;
        expect(() => runToReturn(rig, 50_000)).not.toThrow();
        expect(rig.cpu.d[0]).not.toBe(0);
    });
});

describe('what the emulator refuses to let a loader get away with', () => {
    maybe('records an instruction fetch from flash while the device is busy', () => {
        // The catastrophe the resident firmware avoids by copying its stub to RAM: run the erase
        // routine *in place* in flash and the CPU fetches status bits as opcodes.
        const machine = new Machine(firmware!, { erasePolls: 40 });
        machine.enableRamLikeFirmware();
        machine.enableFlashWritesLikeFirmware();
        const cpu = new Cpu32({
            readWord: (a, f) => { machine.tick(); return machine.readWord(a, f); },
            readByte: (a, f) => machine.readByte(a, f),
            writeWord: (a, v) => machine.writeWord(a, v),
            writeByte: (a, v) => machine.writeByte(a, v),
        });
        cpu.a[7] = STACK_TOP;
        cpu.pc = ERASE_STUB.address;   // executing from flash, not RAM
        cpu.a[5] = 0x8000;

        // It will fault or wander; what matters is that the model noticed why.
        try { cpu.run(() => false, 5_000); } catch { /* expected: it executes garbage */ }
        expect(machine.flash.violations.some((v) => v.kind === 'fetch-while-busy')).toBe(true);
    });

    maybe('records a flash write that the chip selects would have discarded', () => {
        const rig = rigWithStub(ERASE_STUB);
        rig.machine.csorbt = 0x68f0;   // read only
        rig.machine.csor0 = 0x0000;    // disabled - the loader forgot to set it
        rig.cpu.a[5] = 0x8000;
        try { runToReturn(rig, 50_000); } catch { /* the erase never starts, so it may hang */ }
        expect(rig.machine.violations.some((v) => v.kind === 'flash-write-blocked')).toBe(true);
        // And nothing was erased.
        expect(rig.machine.flash.array[0x8000]).toBe(firmware![0x8000]);
    });

    maybe('records a stub copied into RAM that was never enabled', () => {
        const machine = new Machine(firmware!);
        machine.enableFlashWritesLikeFirmware();
        // Deliberately do NOT enable RAM.
        machine.sramBase = 0x00ffe000;
        machine.sramEnabled = false;
        machine.writeWord(0x00ffe100, 0x1234);
        expect(machine.violations.some((v) => v.kind === 'write-to-disabled-ram')).toBe(true);
    });
});

describe('the flash model on its own', () => {
    it('has the bottom-boot sector map, summing to 512 KiB', () => {
        expect(Am29F400.sectorOf(0x0000)).toEqual({ start: 0x0000, length: 0x4000 });
        expect(Am29F400.sectorOf(0x3fff)).toEqual({ start: 0x0000, length: 0x4000 });
        expect(Am29F400.sectorOf(0x4000)).toEqual({ start: 0x4000, length: 0x2000 });
        expect(Am29F400.sectorOf(0x6000)).toEqual({ start: 0x6000, length: 0x2000 });
        expect(Am29F400.sectorOf(0x8000)).toEqual({ start: 0x8000, length: 0x8000 });
        expect(Am29F400.sectorOf(0x10000)).toEqual({ start: 0x10000, length: 0x10000 });
        expect(Am29F400.sectorOf(0x7ffff)).toEqual({ start: 0x70000, length: 0x10000 });
    });

    it('refuses a 0 -> 1 program and reports it on DQ5', () => {
        const flash = new Am29F400();
        flash.array[0x100] = 0x00;
        flash.array[0x101] = 0x00;
        // AA/55/A0 then the data cycle.
        flash.writeWord(0xaaaa, 0xaa);
        flash.writeWord(0x5554, 0x55);
        flash.writeWord(0xaaaa, 0xa0);
        flash.writeWord(0x100, 0xffff);
        expect(flash.violations.some((v) => v.kind === 'program-sets-bit')).toBe(true);
        expect(flash.inError).toBe(true);
        expect(flash.readWord(0x100) & DQ5).toBe(DQ5);
        // A reset command clears the error, as the datasheet says.
        flash.writeWord(0x000, 0xf0);
        expect(flash.inError).toBe(false);
    });

    it('presents DQ7 as the complement of the target while a program is running', () => {
        const flash = new Am29F400(undefined, { programPolls: 2 });
        flash.writeWord(0xaaaa, 0xaa);
        flash.writeWord(0x5554, 0x55);
        flash.writeWord(0xaaaa, 0xa0);
        flash.writeWord(0x200, 0x0000);        // target DQ7 = 0, so status DQ7 reads 1
        expect(flash.readWord(0x200) & DQ7).toBe(DQ7);
        expect(flash.busy).toBe(true);
    });

    it('erases only the sector it was given', () => {
        const flash = new Am29F400(undefined, { erasePolls: 1 });
        flash.array.fill(0x00);
        flash.writeWord(0xaaaa, 0xaa);
        flash.writeWord(0x5554, 0x55);
        flash.writeWord(0xaaaa, 0x80);
        flash.writeWord(0xaaaa, 0xaa);
        flash.writeWord(0x5554, 0x55);
        flash.writeWord(0x8000, 0x30);
        while (flash.busy) flash.readWord(0x8000);
        expect(flash.array[0x8000]).toBe(0xff);
        expect(flash.array[0x7fff]).toBe(0x00);
        expect(flash.array[0x10000]).toBe(0x00);
    });
});
