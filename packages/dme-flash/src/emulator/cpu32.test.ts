import { describe, it, expect } from 'vitest';
import { Cpu32 } from './cpu32';

function rig(words: number[]) {
    const memory = new Uint8Array(0x1000);
    words.forEach((v, i) => { memory[2 * i] = v >>> 8; memory[2 * i + 1] = v; });
    const cpu = new Cpu32({
        readWord: a => memory[a]! << 8 | memory[a + 1]!, readByte: a => memory[a]!,
        writeWord: (a, v) => { memory[a] = v >>> 8; memory[a + 1] = v; },
        writeByte: (a, v) => { memory[a] = v; },
    });
    return { cpu, memory };
}

describe('CPU32 regressions found by independent instruction execution', () => {
    it.each([0xd001, 0x5200, 0x0600])('ADD variant %s sets signed overflow without carry', opcode => {
        const { cpu } = rig([opcode, 1]);
        cpu.d[0] = 0x7f; cpu.d[1] = 1;
        cpu.step();
        expect(cpu.d[0]).toBe(0x80);
        expect(cpu.sr & 31).toBe(0x0a);
    });
    it('ASL records any sign transition, including when the final result is zero', () => {
        const { cpu } = rig([0xe100]); // ASL.B #8,D0; Unicorn M68020: XZVC = 10111
        cpu.d[0] = 1;
        cpu.step();
        expect(cpu.d[0]).toBe(0);
        expect(cpu.sr & 31).toBe(0x17);
    });
    it('MOVEM.L displacement stores ascending registers without changing the base', () => {
        const { cpu, memory } = rig([0x48e8, 0x0105, 0xfff0]);
        cpu.a[0] = 0x100; cpu.d[0] = 0x11223344; cpu.d[2] = 0xabcdef01;
        cpu.step();
        expect([...memory.slice(0xf0, 0xfc)]).toEqual([0x11, 0x22, 0x33, 0x44, 0xab, 0xcd, 0xef, 1, 0, 0, 1, 0]);
        expect(cpu.a[0]).toBe(0x100);
    });
    it('MOVEM.W displacement sign extends loads even when it overwrites the base register', () => {
        const { cpu, memory } = rig([0x4ca8, 0x0301, 0xfff0]);
        cpu.a[0] = 0x100;
        memory.set([0x80, 0x01, 0xff, 0xfe, 0x7f, 0xff], 0xf0);
        cpu.step();
        expect([cpu.d[0], cpu.a[0], cpu.a[1]]).toEqual([0xffff8001, 0xfffffffe, 0x7fff]);
    });
});
