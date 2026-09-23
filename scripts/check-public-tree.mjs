#!/usr/bin/env node
// check-public-tree — nothing that must not be published is tracked by git.
//
// CANONICAL COPY — lives in tsunagi-m3/tools/owner-gate/scripts/ and is copied
// into each public tool repository as scripts/check-public-tree.mjs. Run by the
// pre-commit hook and by CI:
//
//   node scripts/check-public-tree.mjs            the tracked tree (git ls-files)
//   node scripts/check-public-tree.mjs --staged   what is about to be committed
//
// The tools are open source; these repositories are public. What stays out:
//   - BMW-derived data and third-party calibrations: .bin .0da .0pa .xdf and
//     ECU dumps, which are not ours to redistribute;
//   - local databases and state: .sqlite, .wrangler/;
//   - secrets: .env*, .dev.vars, token files;
//   - a real car's VIN, anywhere in a text file.
//
// A VIN is matched as WBS followed by 14 VIN characters (BMW M), the shape a
// real E46 M3 VIN takes. Test fixtures that need one use a made-up value listed
// in .public-tree-allow (one path or one value per line, # for comments).

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const STAGED = process.argv.includes('--staged');

const FORBIDDEN_EXT = /\.(bin|0da|0pa|0ds|ipo|prg|xdf|sqlite|sqlite3|db)$/i;
const FORBIDDEN_NAME = /(^|\/)(\.env(\..*)?|\.dev\.vars|\.sync-token|\.upload-token[^/]*|[^/]*token\.local)$/i;
const FORBIDDEN_DIR = /(^|\/)(\.wrangler|node_modules)\//;
const VIN = /\bWBS[A-HJ-NPR-Z0-9]{14}\b/g;
const TEXT_MAX = 2_000_000;

const allow = new Set(
  fs.existsSync('.public-tree-allow')
    ? fs
        .readFileSync('.public-tree-allow', 'utf8')
        .split(/\r?\n/)
        .map((l) => l.replace(/#.*/, '').trim())
        .filter(Boolean)
    : []
);

const files = execFileSync('git', STAGED ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR'] : ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .map((f) => f.trim())
  .filter(Boolean);

const problems = [];
for (const f of files) {
  if (allow.has(f)) continue;
  if (FORBIDDEN_DIR.test(f)) problems.push(`${f}: local state or dependencies`);
  else if (FORBIDDEN_NAME.test(f)) problems.push(`${f}: secrets`);
  else if (FORBIDDEN_EXT.test(f)) problems.push(`${f}: binary/calibration data (not ours to publish)`);
  else {
    let text;
    try {
      const buf = STAGED ? execFileSync('git', ['show', `:${f}`], { maxBuffer: 64 << 20 }) : fs.readFileSync(f);
      if (buf.length > TEXT_MAX || buf.includes(0)) continue;
      text = buf.toString('utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(VIN)) {
      if (!allow.has(m[0])) {
        problems.push(`${f}: looks like a real VIN (${m[0].slice(0, 6)}…)`);
        break;
      }
    }
  }
}

if (problems.length) {
  console.log('Not for a public repository:');
  for (const p of problems) console.log(`  ${p}`);
  console.log('\nRemove them (and add them to .gitignore), or list a deliberate exception in .public-tree-allow.');
  process.exit(1);
}
console.log(`public tree: ok (${files.length} file(s) checked)`);
