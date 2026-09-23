#!/usr/bin/env node
// deploy — build the owners' preview and put it on Cloudflare Pages, or refuse and say why.
//
//   npm run deploy            every guard, the preview build, then `wrangler pages deploy`
//   npm run deploy -- --check every guard and the build, and stop before anything is uploaded
//
// What it refuses, in the order it checks, and why each one is here:
//
//   1. wrangler.jsonc names a project other than the preview. The D1 binding applies only when the
//      config's name matches the project, silently otherwise; the name is read from there, never
//      passed in, so the two cannot disagree.
//   2. functions/_middleware.ts is missing, or `gate:verify` fails. Without the gate this origin
//      serves the app, the API and BMW's files to anyone.
//   3. check-public-tree fails. The source of what is served is public; so must the tree be clean.
//   4. The working tree has changes (untracked CLAUDE.md and .claude/ aside - agent notes, never
//      tracked). A build from uncommitted files serves source nobody can read.
//   5. HEAD is not what GitHub has on origin/main. The preview may serve only source that is
//      public: every build carries its sha in <meta name="build-id">, and that sha has to resolve
//      on github.com/mushitaro/mss54hp-csl-convert-boot. With no remote yet, it refuses and says
//      the repository must be pushed first.
//   6. The build (M_VARIANT=preview) fails its own checks (packages/web/vite.config.ts), carries a
//      sync-token meta, stamps a different or dirty sha, or lacks the BMW files the app needs
//      offline - they are not in the repository and have to be supplied locally
//      (THIRD-PARTY-NOTICES.md §2).
//
// Then it runs wrangler from the repository root - Pages takes functions/ from the working
// directory, not from the directory being uploaded - with --branch main, so every deployment
// lands on the project's own hostname and no branch alias is ever created.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROJECT = 'mss54hp-csl-convert-boot-preview';
const PUBLIC_BRANCH = 'main';
const REPO = 'mushitaro/mss54hp-csl-convert-boot';
const DIST = 'packages/web/dist';
/** What the app fetches from its own origin and precaches; none of it is in git. */
const REQUIRED_BINARIES = [
    'spdaten/7837340A.0PA',
    'spdaten/A7837329.0DA', 'spdaten/A7837331.0DA', 'spdaten/A7837333.0DA',
    'spdaten/A7837335.0DA', 'spdaten/A7837337.0DA', 'spdaten/A7837339.0DA',
    'program/211325000401PD31_Community_Patch_v1.bin',
    'bootloader/csl-sa0.bin',
];

const CHECK_ONLY = process.argv.includes('--check');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

function refuse(why) {
    console.error(`\nREFUSED: ${why}`);
    process.exit(1);
}
const ok = (m) => console.log(`  ok    ${m}`);
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
/** A child process whose output is shown and whose exit code is the answer. */
const run = (cmd, args, env = {}) =>
    spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: isWin, env: { ...process.env, ...env } }).status === 0;

// 1. the project
const config = fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
const name = /"name"\s*:\s*"([^"]+)"/.exec(config)?.[1];
if (name !== PROJECT) refuse(`wrangler.jsonc names "${name}", not the preview project "${PROJECT}".`);
ok(`project ${name}`);

// 2. the gate
if (!fs.existsSync(path.join(root, 'functions', '_middleware.ts'))) refuse('functions/_middleware.ts is missing: nothing would be gated.');
if (!run('npm', ['run', '--silent', 'gate:verify'])) refuse('gate:verify failed.');
ok('owner gate');

// 3. the public tree
if (!run('node', ['scripts/check-public-tree.mjs'])) refuse('check-public-tree failed.');

// 4. a clean tree
const dirty = git('status', '--porcelain')
    .split('\n')
    .filter(Boolean)
    .filter((l) => !/^\?\? (CLAUDE\.md|\.claude\/)/.test(l));
if (dirty.length) refuse(`the working tree has changes; commit and push them first:\n  ${dirty.join('\n  ')}`);
ok('working tree clean');

// 5. the source is public
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== PUBLIC_BRANCH) refuse(`on branch "${branch}"; the preview is built from ${PUBLIC_BRANCH} only.`);
let remote = '';
try { remote = git('remote', 'get-url', 'origin'); } catch { /* no remote */ }
if (!remote) {
    refuse(`this repository has no remote yet. It must be pushed to GitHub (${REPO}, public) before anything built from it is served:\n`
        + '  the preview may serve only source that is public.');
}
try {
    git('fetch', '--quiet', 'origin', PUBLIC_BRANCH);
} catch (e) {
    refuse(`could not fetch origin/${PUBLIC_BRANCH} to compare (${String(e.stderr ?? e.message).trim()}). Not verified is not the same as public.`);
}
const head = git('rev-parse', 'HEAD');
const published = git('rev-parse', `origin/${PUBLIC_BRANCH}`);
if (head !== published) refuse(`HEAD ${head.slice(0, 7)} is not origin/${PUBLIC_BRANCH} (${published.slice(0, 7)}). Push first; only public source is served.`);
ok(`HEAD ${head.slice(0, 7)} is origin/${PUBLIC_BRANCH}`);

// 6. the build
if (!run('npm', ['run', '--silent', 'build'], { M_VARIANT: 'preview' })) refuse('the preview build failed.');
const dist = path.join(root, DIST);
for (const f of REQUIRED_BINARIES) {
    if (!fs.existsSync(path.join(dist, f))) refuse(`${DIST}/${f} is missing. Supply it locally (THIRD-PARTY-NOTICES.md §2); the app needs it offline.`);
}
const htmls = fs.readdirSync(dist).filter((f) => f.endsWith('.html'));
for (const f of htmls) {
    if (/<meta\s+name="sync-token"/i.test(fs.readFileSync(path.join(dist, f), 'utf8'))) refuse(`${DIST}/${f} carries a sync-token meta.`);
}
const index = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const buildId = /<meta\s+name="build-id"\s+content="([^"]*)"/.exec(index)?.[1] ?? '';
const variant = /<meta\s+name="app-variant"\s+content="([^"]*)"/.exec(index)?.[1];
if (variant !== 'preview') refuse(`the build says app-variant "${variant}", not "preview".`);
const stamped = buildId.split('.').pop() ?? '';
if (!/^[0-9a-f]{7,40}$/.test(stamped) || !head.startsWith(stamped)) {
    refuse(`build-id "${buildId}" does not name the clean HEAD ${head.slice(0, 7)}.`);
}
ok(`build ${buildId}, app-variant preview, ${REQUIRED_BINARIES.length} bundled files present`);

if (CHECK_ONLY) {
    console.log('\n--check: every guard passed; nothing was uploaded.');
    process.exit(0);
}

// 7. deploy, from the root, so functions/ is the one that ships. Every argument is a plain token:
// on Windows this goes through a shell, which would split anything with a space in it.
if (!run('npx', ['wrangler', 'pages', 'deploy', DIST,
    '--project-name', PROJECT,
    '--branch', PUBLIC_BRANCH,
    '--commit-hash', head,
    '--commit-dirty=false'])) {
    refuse('wrangler pages deploy failed.');
}
console.log(`\nDeployed ${buildId} to https://${PROJECT}.pages.dev`);
console.log('Read it back before saying so: build-id and app-variant on "/", short_name in the manifest, /api/runs 401 without a session.');
