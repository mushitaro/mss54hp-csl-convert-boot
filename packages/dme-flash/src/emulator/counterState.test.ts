import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Cpu32 } from './cpu32';

const path = process.env.CSL_0401_BIN
    ?? String.raw`C:\Users\kazuh\CSL_0401_Binary_Disassembly_Notes\Full 211323000401PD31_TERRA.bin`;
const maybe = existsSync(path) ? it : it.skip;

describe('BMW counter-to-session-state routine, executed without replacing its branches', () => {
    maybe('decodes all 64 counter positions and four marker values', () => {
        const flash = new Uint8Array(readFileSync(path)).slice(0, 0x80000);
        expect([...flash.slice(0x2e0c, 0x2e10)]).toEqual([0x48, 0xe7, 0x30, 0x20]);
        for (let used = 0; used <= 64; used++) for (const marker of [0, 0x00ff, 0xff00, 0x1234]) {
            const rom = flash.slice();
            const ram = new Uint8Array(0x10000);
            rom.fill(0xff, 0x4800, 0x4880);
            rom.fill(0, 0x4800, 0x4800 + used * 2);
            if (used > 0) { rom[0x4800 + used * 2 - 2] = marker >>> 8; rom[0x4800 + used * 2 - 1] = marker & 255; }
            const read = (address: number) => {
                const a = address & 0xffffff;
                if (a < rom.length) return rom[a]!;
                if (a >= 0xff0000) return ram[a & 0xffff]!;
                throw new Error(`unmodelled read ${a.toString(16)}`);
            };
            const write = (address: number, value: number) => {
                const a = address & 0xffffff;
                if (a < 0xff0000) throw new Error('counter decode must never write flash');
                ram[a & 0xffff] = value;
            };
            const cpu = new Cpu32({readByte: read, readWord: a => read(a) << 8 | read(a + 1),
                writeByte: write, writeWord: (a, v) => { write(a, v >>> 8); write(a + 1, v); }});
            cpu.pc = 0x2e0c; cpu.a[7] = 0xffe800;
            ram.set([0, 0x07, 0xff, 0x00], 0xe800); // return sentinel 0x7FF00
            cpu.run(() => cpu.pc === 0x7ff00, 2000);
            const expected = used > 0 && used < 63 ? marker === 0x00ff ? 0x3c : marker === 0xff00 ? 0x66 : 0xc3 : 0xc3;
            expect(ram[0xd00e], `used=${used}, marker=${marker.toString(16)}`).toBe(expected);
        }
    });
});
