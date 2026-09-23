// The files the app carries that are not in the repository: BMW's SP-DATEN, the community-patched
// program and the CSL bootloader (THIRD-PARTY-NOTICES.md §2). They are supplied locally into
// packages/web/public/{spdaten,program,bootloader}/, which git ignores - and so nothing else sees
// what is in those folders. Vite copies a public folder whole, so anything dropped there beside
// them (a real car's ECU dump, a scratch capture) would ship to every owner and be precached onto
// their phones.
//
// This list is the only answer to "what may be served from those folders". The app fetches these
// names (App.tsx), the Vite plugin precaches exactly these and fails the build on anything else in
// the output (vite.config.ts), and the deploy guard checks the output against it again
// (scripts/deploy.mjs, through bundled-files-check.mjs). Plain JavaScript with no Node imports, so the
// browser bundle and the deploy script can both import it without a build.

/** Served paths, relative to the site root. */
export const REQUIRED_BINARIES = Object.freeze([
    'spdaten/7837340A.0PA',
    'spdaten/A7837329.0DA', 'spdaten/A7837331.0DA', 'spdaten/A7837333.0DA',
    'spdaten/A7837335.0DA', 'spdaten/A7837337.0DA', 'spdaten/A7837339.0DA',
    'program/211325000401PD31_Community_Patch_v1.bin',
    'bootloader/csl-sa0.bin',
]);

/** The folders the list covers. Nothing but the list, and a text note, may be in them. */
export const BUNDLED_DIRS = Object.freeze(['spdaten', 'program', 'bootloader']);

/** The names in one folder, for the app: `bundledNames('spdaten')` -> ['7837340A.0PA', ...]. */
export function bundledNames(dir) {
    return REQUIRED_BINARIES.filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1));
}
