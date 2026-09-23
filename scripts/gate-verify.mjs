#!/usr/bin/env node
// gate:verify — is this app's copy of the owner gate the canonical one, and is
// it wired so that it can actually hold?
//
// CANONICAL COPY — lives in tsunagi-m3/tools/owner-gate/scripts/ and is copied
// into each preview app as scripts/gate-verify.mjs.
//
//   node scripts/gate-verify.mjs --functions functions --client src/lib/owner-sync.ts
//
// Fails (exit 1) when:
//   - the canonical owner-gate cannot be found (a check that silently passes
//     when its reference is missing is not a check);
//   - any copied file differs from the canonical one;
//   - functions/_middleware.ts does not build the gate with createGate;
//   - anything under functions/ calls passThroughOnException (Pages implements
//     it by serving the asset — the one thing the gate exists to prevent);
//   - .dev.vars is not ignored by git (it holds M3_CLIENT_SECRET locally).
//
// The canonical directory is found at $OWNER_GATE_CANONICAL, else at
// ../tsunagi-m3/tools/owner-gate relative to the git root.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const FUNCTIONS = path.resolve(argOf('--functions', 'functions'));
const CLIENT = argOf('--client', null);
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const canonical = process.env.OWNER_GATE_CANONICAL ?? path.resolve(root, '..', 'tsunagi-m3', 'tools', 'owner-gate');

let failures = 0;
const fail = (m) => {
  failures++;
  console.log(`  FAIL  ${m}`);
};
const ok = (m) => console.log(`  ok    ${m}`);
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

if (!fs.existsSync(path.join(canonical, 'server', 'gate.ts'))) {
  console.log(`  FAIL  canonical owner-gate not found at ${canonical}`);
  process.exit(1);
}

const pairs = [
  [path.join(canonical, 'server', 'gate.ts'), path.join(FUNCTIONS, '_owner-gate', 'gate.ts')],
  [path.join(canonical, 'server', 'owner.ts'), path.join(FUNCTIONS, '_owner-gate', 'owner.ts')],
];
if (CLIENT) pairs.push([path.join(canonical, 'client', 'owner-sync.ts'), path.resolve(CLIENT)]);

for (const [from, to] of pairs) {
  if (!fs.existsSync(to)) fail(`${path.relative(root, to)} is missing`);
  else if (read(from) !== read(to)) fail(`${path.relative(root, to)} differs from ${path.relative(path.dirname(canonical), from)}`);
  else ok(`${path.relative(root, to)} matches the canonical copy`);
}

const mw = path.join(FUNCTIONS, '_middleware.ts');
if (!fs.existsSync(mw)) fail(`${path.relative(root, mw)} is missing — nothing is gated`);
else if (!/createGate\(/.test(read(mw)) || !/_owner-gate\/gate/.test(read(mw))) fail(`${path.relative(root, mw)} does not build the gate from _owner-gate/gate`);
else ok(`${path.relative(root, mw)} builds the gate`);

const walk = (dir) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
    : [];
const bad = walk(FUNCTIONS).filter((f) => /\.(ts|js|mjs)$/.test(f) && !f.includes('_owner-gate') && read(f).includes('passThroughOnException'));
if (bad.length) fail(`passThroughOnException in ${bad.map((f) => path.relative(root, f)).join(', ')}`);
else ok('no passThroughOnException');

const devVars = path.relative(root, path.join(path.dirname(FUNCTIONS), '.dev.vars')).replace(/\\/g, '/');
try {
  execFileSync('git', ['check-ignore', '-q', devVars], { cwd: root });
  ok(`${devVars} is ignored by git`);
} catch {
  fail(`${devVars} is NOT ignored by git — it holds M3_CLIENT_SECRET`);
}

console.log(failures ? `\n${failures} failure(s).` : '\nowner gate: ok');
process.exit(failures ? 1 : 0);
