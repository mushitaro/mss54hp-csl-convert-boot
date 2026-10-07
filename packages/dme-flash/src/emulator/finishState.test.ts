import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Cpu32 } from './cpu32';

const path = process.env.CSL_0401_BIN
    ?? String.raw`C:\Users\kazuh\CSL_0401_Binary_Disassembly_Notes\Full 211323000401PD31_TERRA.bin`;
const maybe = existsSync(path) ? it : it.skip;

/**
 * Execute the original Finish dispatcher, injecting the results of its checksum
 * helpers. This proves conditional control flow, NOT the checksums, paired CPU
 * propagation, counter writes or a complete DS2 transaction on hardware.
 */
describe('BMW master Finish conditional transitions', () => {
    maybe.each([0, 0x2cdc, 0x2b9e, 0x2c2c])('program session with helper failure 0x%s', fault => {
        const flash = new Uint8Array(readFileSync(path)).slice(0, 0x80000);
        const ram = new Uint8Array(0x10000);
        const read = (a: number) => a < flash.length ? flash[a]! : ram[a & 0xffff]!;
        const write = (a: number, v: number) => {
            if (a < 0xff0000) throw new Error('dispatcher must not directly write flash');
            ram[a & 0xffff] = v;
        };
        const cpu = new Cpu32({readByte: read, readWord: a => read(a) << 8 | read(a + 1),
            writeByte: write, writeWord: (a, v) => { write(a, v >>> 8); write(a + 1, v); }});
        cpu.pc = 0x22c0; cpu.a[7] = 0xffe800;
        ram[0xd00e] = 0x66;
        const counterStates: number[] = [];
        const helpers = new Set([0x2b08, 0x2cb6, 0x2b1c, 0x2bb2, 0x2cdc, 0x2b9e, 0x2c2c, 0x2d16]);
        for (let step = 0; step < 300 && cpu.pc !== 0x25ee && cpu.pc !== 0x2254; step++) {
            if (helpers.has(cpu.pc)) {
                if (cpu.pc === 0x2d16) counterStates.push(ram[0xd00e]!);
                cpu.d[0] = cpu.pc === fault ? 0 : 1;
                const sp: number = cpu.a[7]!;
                cpu.pc = (read(sp) * 0x1000000 + (read(sp + 1) << 16) + (read(sp + 2) << 8) + read(sp + 3)) >>> 0;
                cpu.a[7] = sp + 4;
            } else cpu.step();
        }
        if (!fault) {
            expect(cpu.pc).toBe(0x25ee);
            expect(ram[0xd00e]).toBe(0xc3);
            expect(counterStates).toEqual([0xc3]);
        } else {
            // Negative status can accompany a successful transition into data mode.
            // Current host aborts safely on this status; it does not prove the full
            // conversion can proceed when the calibration still holds a loader.
            expect(cpu.pc).toBe(0x2254);
            expect(ram[0xd00c]).toBe(fault === 0x2cdc ? 0x0f : fault === 0x2b9e ? 0x0d : 0x0e);
            expect(ram[0xd00e]).toBe(0x3c);
            expect(counterStates).toEqual([0xc3, 0x3c]);
        }
    });
});
