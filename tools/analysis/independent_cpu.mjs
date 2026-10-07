// node --experimental-transform-types tools/analysis/independent_cpu.mjs
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { Cpu32 } from '../../packages/dme-flash/src/emulator/cpu32.ts';
let seed = 0x68376;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
const words = (...values) => values.flatMap(v => [v >>> 8 & 255, v & 255]);
const cases = [];
// Every size/count/direction of ASx/LSx, plus zero register counts and edge values.
for (const value of [0, 1, 0x7f, 0x80, 0x7fff, 0x8000, 0x7fffffff, 0x80000000, 0xffffffff, random()]) {
    for (const size of [0, 1, 2]) for (const kind of [0, 1]) for (const left of [0, 1]) {
        for (const count of [0, 1, 2, 7]) {
            const code = words(0xe000 | count << 9 | left << 8 | size << 6 | kind << 3);
            cases.push({ code, value });
        }
    }
}
// MOVEM indirect/displacement, both sizes and directions; mask includes base register.
for (const size of [0, 1]) for (const direction of [0, 1]) for (const mask of [1, 0x104, 0x8303, 0xffff]) {
    for (const mode of [2, 5]) cases.push({code: words(0x4880 | direction << 10 | size << 6 | mode << 3,
        mask, ...(mode === 5 ? [0xfff0] : [])), value: random()});
}
for (let n = 0; n < 100; n++) {
    const value = random();
    // ADD/SUB/CMP/EOR D1,D0; MOVE D1,D0; ADDQ/SUBQ; TST; ANDI/EORI.
    for (const size of [0, 1, 2]) {
        for (const base of [0xd001, 0x9001, 0xb001, 0xb300, 0x5000, 0x5100, 0x4a00]) {
            cases.push({code: words(base | size << 6), value});
        }
        for (const kind of [0, 1]) for (const left of [0, 1]) {
            cases.push({code: words(0xe220 | left << 8 | size << 6 | kind << 3), value, count: n % 64});
        }
    }
}
// Brief indexed MOVE and LEA, address/PC bases, word/long index and all scales.
for (const scale of [0, 1, 2, 3]) for (const long of [0, 1]) for (const pc of [0, 1]) {
    for (const lea of [0, 1]) for (const index of [-2, 0, 3]) {
        cases.push({code: words((lea ? 0x43f0 : 0x3030) | (pc ? 11 : 0),
            0x1000 | long << 11 | scale << 9 | 0xfe), value: random(), index});
    }
}
// CPU32 full extension with base/index suppression and null/word/long displacement.
for (const bd of [1, 2, 3]) for (const suppress of [0, 0x40, 0x80, 0xc0]) {
    for (const scale of [0, 1, 2, 3]) for (const pc of [0, 1]) {
        const displacement = bd === 1 ? [] : bd === 2 ? [0x20] : [0, 0x20];
        cases.push({code: words(0x43f0 | (pc ? 11 : 0), 0x1900 | suppress | bd << 4 | scale << 9,
            ...displacement), value: random(), index: 3});
    }
}
for (const test of cases) {
    test.sr = 0x2700 | (random() & 31);
    test.d = Array.from({length: 8}, random); test.d[0] = test.value;
    if (test.count !== undefined) test.d[1] = test.count;
    if (test.index !== undefined) test.d[1] = test.index >>> 0;
    test.a = Array.from({length: 8}, (_, i) => 0x2040 + i * 4);
    test.memory = Array.from({length: 256}, () => random() & 255);
}
const oracle = spawnSync('python', ['tools/analysis/unicorn_oracle.py'], {
    input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
});
if (oracle.status !== 0) throw new Error(oracle.stderr);
const expected = JSON.parse(oracle.stdout);
const failures = [];
cases.forEach((test, i) => {
    const mem = new Uint8Array(0x10000); mem.set(test.code, 0x1000); mem.set(test.memory, 0x2000);
    const cpu = new Cpu32({readWord: a => mem[a] << 8 | mem[a + 1], readByte: a => mem[a],
        writeWord: (a, v) => {mem[a] = v >>> 8; mem[a + 1] = v;}, writeByte: (a, v) => {mem[a] = v;}});
    cpu.d.set(test.d); cpu.a.set(test.a); cpu.sr = test.sr; cpu.pc = 0x1000; cpu.step();
    const actual = {d: [...cpu.d], a: [...cpu.a], sr: cpu.sr, pc: cpu.pc, memory: [...mem.slice(0x2000, 0x2100)]};
    try { assert.deepEqual(actual, expected[i]); } catch {
        failures.push({case: i, code: Buffer.from(test.code).toString('hex'), value: test.value,
            sr: [actual.sr, expected[i].sr], d0: [actual.d[0], expected[i].d[0]]});
    }
});
console.log(JSON.stringify({seed: '0x68376', cases: cases.length, failures: failures.slice(0, 25), totalFailures: failures.length}, null, 2));
assert.equal(failures.length, 0, 'CPU32 subset must agree with independent Unicorn M68K execution');
