import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { firmwareRig } from './firmwareHarness';
import { buildWriteTelegram } from '../telegrams';
import { withSimulatedEcu } from '../writeLock';
import { assemble } from './asm68k';
import { buildStagedSector } from '../blLoader';
import { inspectProgrammingCounter } from '../programmingState';

const path = process.env.CSL_0401_BIN
    ?? String.raw`C:\Users\kazuh\CSL_0401_Binary_Disassembly_Notes\Full 211323000401PD31_TERRA.bin`;
const maybe = existsSync(path) ? it : it.skip;
const image = (processor: 'master' | 'slave' = 'master') =>
    new Uint8Array(readFileSync(path)).slice(processor === 'master' ? 0 : 0x80000, processor === 'master' ? 0x80000 : 0x100000);

describe('resident firmware with real helper execution and NOR writes', () => {
    maybe.each(['master', 'slave'] as const)('%s: staging, reset, actual replacement, program, intermediate Finish, calibration, final Finish', async processor => {
        const stock = new Uint8Array(readFileSync(process.env.HW2001_BIN
            ?? String.raw`C:\Users\kazuh\MSS54-DS2-Tool-Public-1.2.1\hw2001-analysis\hw2001_full.bin`));
        const target = new Uint8Array(readFileSync(process.env.CP_V1_BIN ?? 'data/211325000401PD31_Community_Patch_v1.bin'));
        const base = processor === 'master' ? 0 : 0x80000;
        const calibrationAddress = processor === 'master' ? 0x200000 : 0xa00000;
        const programAddress = processor === 'master' ? 0x500000 : 0xd00000;
        let rig = firmwareRig(stock.slice(base, base + 0x80000));
        const write = async (address: number, bytes: Uint8Array) => {
            for (let at = 0; at < bytes.length; at += 122) {
                const reply = rig.telegram(buildWriteTelegram(address + at, bytes.slice(at, at + 122)));
                expect(reply[6], `WRITE ${processor} ${address + at}`).toBe(1);
            }
        };
        await withSimulatedEcu(async () => {
            const loader = assemble(readFileSync('tools/loader/replace.s', 'utf8'));
            const staged = buildStagedSector(processor, loader.bytes, target.slice(base, base + 0x4000));
            rig.control(6, 0xa02000);
            await write(calibrationAddress, staged.bytes);
            rig = firmwareRig(rig.machine.flash.array.slice());
            rig.machine.applyResetInstruction();
            rig.cpu.a[7] = rig.machine.readWord(0) * 65536 + rig.machine.readWord(2);
            rig.cpu.pc = rig.machine.readWord(4) * 65536 + rig.machine.readWord(6);
            rig.run(() => rig.cpu.pc === 0x8000 + loader.labels.get('done')!, 4_000_000);
            expect(rig.machine.watchdogFired).toBe(false);
            expect(rig.machine.flash.array.slice(0, 0x4000)).toEqual(target.slice(base, base + 0x4000));
            expect(rig.machine.readWord(0xfffc)).toBe(0);
            expect(rig.machine.violations).toEqual([]);
            expect(rig.machine.flash.violations).toEqual([]);
            // Command-entry boundary after watchdog/key reset. UART and paired
            // scheduling are separate from these two actual CPU executions.
            rig = firmwareRig(rig.machine.flash.array.slice());
            expect(rig.call(0x2e0c)).toBeDefined();
            expect(rig.machine.readByte(0xffd00e)).toBe(processor === 'master' ? 0x66 : 0x3c);
            const erased = rig.control(6, 0xd00000);
            expect(erased[0]).toBe(0xa0);
            if (processor === 'master') expect(erased[6]).toBe(1);
            await write(programAddress, target.slice(base + 0x10000, base + 0x50000));
            const middle = rig.control(15);
            expect(middle[6]).toBe(processor === 'master' ? 15 : 0);
            expect(rig.machine.readByte(0xffd00e)).toBe(processor === 'master' ? 0x3c : 0xc3);
            rig.control(6, 0xa02000);
            await write(calibrationAddress, target.slice(base + 0x8000, base + 0x10000));
            const final = rig.control(15);
            expect(final[6]).toBe(processor === 'master' ? 1 : 0);
            expect(rig.machine.readByte(0xffd00e)).toBe(0xc3);
            expect(Buffer.compare(Buffer.from(rig.machine.flash.array.subarray(0x8000, 0x50000)),
                Buffer.from(target.subarray(base + 0x8000, base + 0x50000)))).toBe(0);
            // The original erase/Finish routines really write AIF. Check the exact
            // resulting canonical history, and preserve every other service byte.
            const finalCounter = inspectProgrammingCounter(rig.machine.flash.array.slice(0x4800, 0x4880));
            const initialCounter = inspectProgrammingCounter(stock.slice(base + 0x4800, base + 0x4880));
            expect(finalCounter).toEqual({ used: initialCounter.used + 5,
                remaining: initialCounter.remaining - 5, mode: 'normal' });
            for (const [start, end] of [[0x4000, 0x4800], [0x4880, 0x8000]]) {
                expect(Buffer.compare(Buffer.from(rig.machine.flash.array.subarray(start, end)),
                    Buffer.from(stock.subarray(base + start!, base + end!)))).toBe(0);
            }
            expect(rig.machine.flash.array.subarray(0x50000).every(byte => byte === 255)).toBe(true);
            expect(rig.machine.flash.violations).toEqual([]);
            expect(rig.machine.violations.every(v => v.kind === 'unmapped-access'
                && [0xff8022, 0xff8023].includes(v.address))).toBe(true);
        });
    }, 30000);
    maybe('reaches the diagnostic main loop after a disarmed data-mode reset (no UART/peer proof)', () => {
        const rom = image(); rom.fill(0, 0x4800, 0x4808); rom.set([0, 255], 0x4808);
        rom.fill(0, 0xfffc, 0x10000);
        const rig = firmwareRig(rom); rig.machine.applyResetInstruction();
        rig.cpu.a[7] = 0; rig.cpu.pc = 0x200;
        rig.run(() => rig.cpu.pc === 0x320, 100000);
        expect(rig.cpu.pc).toBe(0x320);
        expect(rig.machine.tpuramBase).toBe(0xffd000);
        // Optional external RAM probe fails and resident firmware selects internal
        // TPURAM. FF8000/01/22/23 are board interface writes, not modelled peer IO.
        expect(rig.machine.violations.every(v => v.kind === 'unmapped-access'
            && [0x13fff0, 0x13fffc, 0x13fffe, 0xff8000, 0xff8001, 0xff8022, 0xff8023].includes(v.address))).toBe(true);
    });
    maybe.each([2, 16, 122])('accepts the host WRITE telegram and programs all %i bytes', async count => {
        const rig = firmwareRig(image());
        expect(rig.control(6, 0xa02000)[6]).toBe(1);
        const data = Uint8Array.from({ length: count }, (_, i) => (i * 37 + 0x46) & 255);
        const request = await withSimulatedEcu(async () => buildWriteTelegram(0x200000, data));
        expect(request[5]).toBe(count);
        expect([...rig.telegram(request)]).toEqual([0xa0, 2, 0x20, 0, count, count, 1]);
        expect(rig.machine.flash.array.slice(0x8000, 0x8000 + count)).toEqual(data);
        expect(rig.machine.violations).toEqual([]);
        expect(rig.machine.flash.violations).toEqual([]);
    });
    maybe('appends the calibration marker using the resident flash writer', () => {
        const rom = image();
        rom.fill(0xff, 0x4800, 0x4880); rom.fill(0, 0x4800, 0x4808);
        const rig = firmwareRig(rom);
        rig.machine.writeByte(0xffd00e, 0x3c);
        expect(rig.call(0x2d16)).toBe(1);
        expect(rig.machine.flash.array.slice(0x4800, 0x480c)).toEqual(
            new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255]));
        expect(rig.machine.violations).toEqual([]);
        expect(rig.machine.flash.violations).toEqual([]);
    });
    maybe('runs every original Finish metadata helper on the reference image', () => {
        for (const pc of [0x2b08, 0x2cb6, 0x2b1c, 0x2bb2, 0x2cdc, 0x2b9e, 0x2c2c]) {
            const rig = firmwareRig(image());
            expect(rig.call(pc), pc.toString(16)).toBeGreaterThan(0);
            expect(rig.machine.violations).toEqual([]);
            expect(rig.machine.flash.violations).toEqual([]);
        }
    });
    maybe.each(['master', 'slave'] as const)('runs %s erase/counter/reset to the armed loader', processor => {
        const rom = image(processor);
        rom.fill(0xff, 0x4800, 0x4880); rom.fill(0, 0x4800, 0x4808);
        const rig = firmwareRig(rom);
        const reply = rig.control(6, 0xa02000);
        expect([...reply]).toEqual(processor === 'master' ? [0xa0, 6, 0xa0, 0x20, 0, 0, 1] : [0xa0, 0, 0, 0, 0, 0, 0]);
        expect(rig.machine.readWord(0x4808)).toBe(0x00ff);
        expect(rig.machine.violations).toEqual([]);
        expect(rig.machine.flash.violations).toEqual([]);
        const prepared = rig.machine.flash.array.slice();
        prepared.set([0x5a, 0xa5, 0x56, 0xc9], 0xfffc);
        const boot = firmwareRig(prepared);
        boot.machine.applyResetInstruction();
        boot.cpu.a[7] = 0; boot.cpu.pc = 0x200;
        boot.run(() => boot.cpu.pc === 0x8000, 1000);
        expect(boot.cpu.resetExecuted).toBe(1);
        expect(boot.machine.violations).toEqual([]);
    });
    maybe.each(['master', 'slave'] as const)('programs a complete %s calibration using real command parsing', async processor => {
        const rig = firmwareRig(image(processor));
        rig.control(6, 0xa02000);
        const address = processor === 'master' ? 0x200000 : 0xa00000;
        const data = Uint8Array.from({ length: 0x8000 }, (_, i) => (i * 37 + (i >>> 8)) & 255);
        await withSimulatedEcu(async () => {
            for (let at = 0; at < data.length; at += 122) {
                const chunk = data.slice(at, at + 122);
                const reply = rig.telegram(buildWriteTelegram(address + at, chunk));
                expect(reply[6], `offset ${at}`).toBe(1);
            }
        });
        expect(rig.machine.flash.array.slice(0x8000, 0x10000)).toEqual(data);
        expect(rig.machine.violations.every(v => v.kind === 'unmapped-access'
            && [0xff8022, 0xff8023].includes(v.address))).toBe(true);
        expect(rig.machine.flash.violations).toEqual([]);
    });
    maybe('proves that data-mode program erase is rejected and does not change flash', () => {
        const rig = firmwareRig(image()); rig.control(6, 0xa02000);
        const before = rig.machine.flash.array.slice();
        expect(rig.control(6, 0xd00000)[6]).toBe(8);
        expect(rig.machine.flash.array).toEqual(before);
    });
    maybe.each([false, true])('executes Finish including actual counter writes, erased calibration=%s', erased => {
        const rom = image();
        rom.fill(0xff, 0x4800, 0x4880); rom.fill(0, 0x4800, 0x4808);
        rom.set([0xff, 0], 0x4808);
        if (erased) rom.fill(255, 0x8000, 0x10000);
        const rig = firmwareRig(rom);
        const reply = rig.control(15);
        expect([...reply]).toEqual([0xa0, 15, 0, 0, 0, 0, erased ? 15 : 1]);
        expect(rig.machine.readByte(0xffd00e)).toBe(erased ? 0x3c : 0xc3);
        expect(rig.machine.readWord(erased ? 0x480c : 0x480a)).toBe(erased ? 0x00ff : 0);
        expect(rig.machine.violations).toEqual([]);
        expect(rig.machine.flash.violations).toEqual([]);
    });
});
