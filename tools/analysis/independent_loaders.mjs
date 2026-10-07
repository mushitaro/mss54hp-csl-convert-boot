// Node 22: node --experimental-transform-types tools/analysis/independent_loaders.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { assemble } from '../../packages/dme-flash/src/emulator/asm68k.ts';
import { crc16Arc } from '../../packages/dme-flash/src/paband.ts';
mkdirSync('data/verification', {recursive: true});
for (const name of ['replace', 'probe']) {
    const assembled = assemble(readFileSync(`tools/loader/${name}.s`, 'utf8'));
    writeFileSync(`data/verification/${name}.bin`, assembled.bytes);
    writeFileSync(`data/verification/${name}.json`, JSON.stringify({labels: Object.fromEntries(assembled.labels)}));
}
const image = readFileSync(process.env.CP_V1_BIN ?? 'data/211325000401PD31_Community_Patch_v1.bin');
writeFileSync('data/verification/crc-cases.json', JSON.stringify([0, 0x80000].map(base => {
    const bytes = [...image.subarray(base, base + 0x4000)];
    return {bytes, expected: crc16Arc(Uint8Array.from(bytes))};
})));
for (const script of ['independent_assemble.py', 'unicorn_loader_crc.py', 'unicorn_counter_guard.py']) {
    const run = spawnSync('python', ['tools/analysis/' + script], {stdio: 'inherit'});
    if (run.status !== 0) process.exit(run.status ?? 1);
}
