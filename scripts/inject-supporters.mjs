#!/usr/bin/env node
// Write the names an app's CREDITS carry into the app itself, at build time.
//
// The names are the people who bought MILE for this app's line on MESH and
// agreed to be named, most MILE first (m3.tsunagi.app/api/credits — names
// only, never a figure). They are baked into the built HTML rather than read
// when the app runs, so the app makes no request it did not make before: the
// privacy policy's "one kind of request" for TUNER and MONITORING's
// connect-src 'self' stay true. The cost is freshness — a name appears from
// the app's next deploy — and that is said to the buyer when they agree.
//
// Canonical copy: tsunagi-m3/tools/credits/inject-supporters.mjs. Each app
// carries a byte-identical copy at scripts/inject-supporters.mjs.
//
//   node scripts/inject-supporters.mjs                    no arguments, by design
//
// No arguments because TUNER's deploy-staging re-runs main's build steps as
// bare `node <file>`. What it needs comes from elsewhere:
//
//   package.json "meshProject"   which MESH line this app is (e.g. dme-mapping)
//   M_SUPPORTERS=off             build without names — warns, never silent
//   M_SUPPORTERS_OUT             the export directory (default: out)
//   M_CREDITS_ORIGIN             default https://m3.tsunagi.app
//   M_SUPPORTERS_FILE            a local JSON fixture instead of the network;
//                                refused when CI is set, so a release cannot
//                                ship a made-up list
//
// Runs AFTER the pages are written and BEFORE the service worker's cache name
// is computed (gen-sw): anything that rewrites bytes after the hash leaves a
// cache name that describes files that no longer exist.
//
// Fails the build when the list cannot be read or does not look right. An
// empty list is a real answer (nobody yet) and is written as such; a failed
// read is not, and is never quietly turned into one.
//
// Logs counts only — never the names. TUNER's CI logs are public.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MARK = 'm-supporters';
const BLOCK_RE = new RegExp(`<script type="application/json" id="${MARK}">[\\s\\S]*?</script>`, 'g');
const MAX_NAMES = 1000;
const MAX_NAME = 60;

/** The list as the app reads it back (client/supporters.ts). */
export function validate(data, project) {
  if (!data || typeof data !== 'object') throw new Error('not an object');
  if (data.project !== project) throw new Error(`answered for ${JSON.stringify(data.project)}, not ${project}`);
  if (!Array.isArray(data.names)) throw new Error('names is not a list');
  if (data.names.length > MAX_NAMES) throw new Error(`more than ${MAX_NAMES} names`);
  for (const n of data.names) {
    if (typeof n !== 'string' || !n.trim() || [...n].length > MAX_NAME || /[\p{Cc}\p{Cf}]/u.test(n)) {
      throw new Error('a name is empty, too long or carries control characters');
    }
  }
  if (typeof data.others !== 'boolean') throw new Error('others is not a boolean');
  return { names: data.names, others: data.others };
}

/** Today in Japan, which is where the list is kept. */
export function asOf(now = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(now);
}

/**
 * JSON that is safe inside a <script> element: nothing in it can close the
 * element or start a comment, whatever a name contains.
 */
export function blockFor(payload) {
  const json = JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `<script type="application/json" id="${MARK}">${json}</script>`;
}

/** Remove any earlier block, then put this one before </head>. Idempotent. */
export function injectIntoHtml(html, payload) {
  const clean = html.replace(BLOCK_RE, '');
  if (!payload) return clean;
  const at = clean.indexOf('</head>');
  if (at < 0) return clean;
  return clean.slice(0, at) + blockFor(payload) + clean.slice(at);
}

/** Every .html under dir. */
function htmlFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...htmlFiles(p));
    else if (entry.name.endsWith('.html')) out.push(p);
  }
  return out;
}

export function injectDir(dir, payload) {
  const files = htmlFiles(dir);
  let written = 0;
  for (const f of files) {
    const before = fs.readFileSync(f, 'utf8');
    const after = injectIntoHtml(before, payload);
    if (after !== before) fs.writeFileSync(f, after);
    if (payload && after.includes(`id="${MARK}"`)) written++;
  }
  return { files: files.length, written };
}

/** The list for one MESH line, from m3 or a local fixture. Throws on anything doubtful. */
export async function readSupporters(project, env = process.env) {
  if (env.M_SUPPORTERS_FILE) {
    if (env.CI) throw new Error('M_SUPPORTERS_FILE is for local builds only; CI must read the real list');
    return validate(JSON.parse(fs.readFileSync(env.M_SUPPORTERS_FILE, 'utf8')), project);
  }
  const origin = (env.M_CREDITS_ORIGIN || 'https://m3.tsunagi.app').replace(/\/$/, '');
  const url = `${origin}/api/credits?project=${encodeURIComponent(project)}`;
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return validate(await res.json(), project);
    } catch (e) {
      last = e;
      console.log(`  supporters: attempt ${attempt} failed (${e instanceof Error ? e.message : e})`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error(`could not read ${url}: ${last instanceof Error ? last.message : last}`);
}

/** The project this app is, from its package.json. */
export function meshProject(cwd = process.cwd()) {
  const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  const id = pkg.meshProject;
  if (typeof id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(id)) {
    throw new Error('package.json has no "meshProject" (the MESH line this app is, e.g. "dme-mapping")');
  }
  return id;
}

async function main() {
  const out = path.resolve(process.env.M_SUPPORTERS_OUT || 'out');
  if (!fs.existsSync(out)) throw new Error(`${out} does not exist — run this after the pages are built`);

  if (process.env.M_SUPPORTERS === 'off') {
    const { files } = injectDir(out, null);
    console.log(`supporters: OFF (M_SUPPORTERS=off) — ${files} page(s) carry no names. Not for a release.`);
    return;
  }

  const project = meshProject();
  const { names, others } = await readSupporters(project);
  const payload = { v: 1, project, names, others, asOf: asOf() };
  const { files, written } = injectDir(out, payload);
  if (written !== files) throw new Error(`wrote the list into ${written} of ${files} page(s) — a page has no </head>`);
  console.log(`supporters: ${names.length} name(s)${others ? ' + others' : ''} for ${project}, into ${written} page(s)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error(`supporters: ${e instanceof Error ? e.message : e}`);
    console.error('The build stops here rather than ship without its credits. M_SUPPORTERS=off builds without them, on purpose.');
    process.exit(1);
  });
}
