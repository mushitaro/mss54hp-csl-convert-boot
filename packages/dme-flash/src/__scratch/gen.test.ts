import { it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { readProgram } from '../spDaten';
import { crc16Arc } from '../paband';
import { ds2ToImageOffset, imageOffsetToDs2 } from '../imageLayout';

// A generator, not a check: it prints the span table programVariant.ts carries. It needs the
// community patch and BMW's .0PA, neither of which is in the repository, so it skips without them.
const CP = 'data/211325000401PD31_Community_Patch_v1.bin';
const PA = 'packages/web/public/spdaten/7837340A.0PA';
const maybe = existsSync(CP) && existsSync(PA) ? it : it.skip;

maybe('generate span table', () => {
    const cp = new Uint8Array(readFileSync(CP));
    const prog = readProgram('7837340A.0PA', new Uint8Array(readFileSync(PA)));
    const gen = new Uint8Array(0x100000).fill(0xff);
    const covered = new Uint8Array(0x100000);
    for (const s of prog.parsed.sections) {
        const off = ds2ToImageOffset(s.address)!;
        gen.set(s.bytes, off); covered.fill(1, off, off + s.bytes.length);
    }
    const diff: number[] = [];
    for (let o = 0; o < 0x100000; o++) if (covered[o] && gen[o] !== cp[o]) diff.push(o);
    const runs: { start: number; end: number }[] = [];
    for (const o of diff) {
        const last = runs[runs.length - 1];
        if (last && o - last.end <= 16) last.end = o; else runs.push({ start: o, end: o });
    }
    for (const r of runs) {
        const len = r.end - r.start + 1;
        const before = crc16Arc(gen.slice(r.start, r.start + len));
        const after = crc16Arc(cp.slice(r.start, r.start + len));
        console.log(`    { offset: 0x${r.start.toString(16)}, length: ${len}, ds2: 0x${imageOffsetToDs2(r.start)!.toString(16)}, before: 0x${before.toString(16).padStart(4,'0')}, after: 0x${after.toString(16).padStart(4,'0')} },`);
    }
    // program window bytes, and the CP identity string
    const idx = Buffer.from(cp).indexOf(Buffer.from('211325000401', 'latin1'));
    console.log('first 211325000401 ASCII at image 0x' + idx.toString(16));
    console.log('whole-program CRC after patch: master=0x' + crc16Arc(cp.slice(0x10000, 0x50000)).toString(16)
        + ' slave=0x' + crc16Arc(cp.slice(0x90000, 0xd0000)).toString(16));
    console.log('whole-program CRC factory    : master=0x' + crc16Arc(gen.slice(0x10000, 0x50000)).toString(16)
        + ' slave=0x' + crc16Arc(gen.slice(0x90000, 0xd0000)).toString(16));
});
