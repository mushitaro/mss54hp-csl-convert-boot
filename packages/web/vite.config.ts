import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_BINARIES } from './bundled-files.mjs';
import { strayBundledFiles } from './bundled-files-check.mjs';

/**
 * A build identifier the operator can read off the screen.
 *
 * Deliberately a timestamp rather than a content hash. The question this answers is a support one -
 * "which build is on that phone, and is it the one that did this?" - and a date answers it without
 * anyone having to look anything up. Reproducible builds would be the better trade in a library;
 * in a tool that talks to one car at a time, being able to name the build out loud wins.
 *
 * Seconds, not minutes, and that is not cosmetic: this string is the only thing that differs
 * between two service workers built from unchanged sources, and a browser decides whether to
 * install an update by comparing the worker byte for byte. At minute granularity two deploys inside
 * the same minute were byte-identical and the second one silently never shipped.
 */
const BUILD_ID = `${new Date().toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;

/**
 * The same build, tied to its source: `<BUILD_ID>.<short sha>`, with `+` when tracked files had
 * uncommitted changes.
 *
 * Written into `<meta name="build-id">`, which is what a deployment is checked against: the preview
 * may only serve source that is public, and the sha is how anyone can find that source. Untracked
 * files do not count as dirty - the agent notes (CLAUDE.md, .claude/) never are tracked.
 */
function sourceStamp(): string {
    const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    try {
        const sha = git('rev-parse', '--short', 'HEAD');
        const dirty = git('status', '--porcelain', '--untracked-files=no') !== '';
        return `${BUILD_ID}.${sha}${dirty ? '+' : ''}`;
    } catch {
        return `${BUILD_ID}.nogit`;
    }
}

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// --- identity -------------------------------------------------------------------------------

/**
 * Which build this is. Empty is production - the build nobody labelled - and it is what the
 * source files describe. `M_VARIANT=preview` is the build the owners get.
 *
 * A variant is one word that the running app compares (`isPreviewBuild` in owner-sync.ts reads
 * `app-variant`), and everything that differs between the two is derived from it here, in one
 * place, before the service worker is written - so the worker's precache list names the files the
 * branded build actually carries.
 */
const VARIANT = (process.env.M_VARIANT ?? '').trim().toLowerCase();
if (VARIANT && !/^[a-z]{1,12}$/.test(VARIANT)) {
    throw new Error(`M_VARIANT must be empty (production) or one lowercase word of at most 12 letters, got "${VARIANT}"`);
}
const LABEL = VARIANT.toUpperCase();

/** The product, as production calls it. Every other build is this plus its label. */
const PRODUCTION = { name: 'MSS54HP CSL CONVERT /// BOOT', shortName: 'CSL BOOT' };
const SHORT_NAME = LABEL ? `${LABEL[0]} ${PRODUCTION.shortName}` : PRODUCTION.shortName;
if (SHORT_NAME.length > 12) throw new Error(`short_name "${SHORT_NAME}" is over 12 characters; Android cuts it`);

/**
 * The M ICON mark this app wears: `migration`, by the operator's decision (2026-09-23) - BOOT moves
 * the DME onto the CSL program, which is a migration, not a `modification`. The tsunagi-m-release
 * table still lists `modification -> BOOT`; that row is stale. The files are written by tsunagi-m3's
 * `node scripts/m-icons.mjs --word migration --out packages/web/public/icons`.
 */
const ICON_WORD = 'migration';

/**
 * Production icons to the M ICON dev set (white on black). Every non-production build wears it -
 * maskable included, or a home screen shows a white-ground and a black-ground icon for one app.
 */
const iconFor = (path: string): string =>
    LABEL ? path.replace(new RegExp(`^/icons/${ICON_WORD}-(?!dev-)`), `/icons/${ICON_WORD}-dev-`) : path;

interface ManifestIcon { src: string; sizes?: string; type?: string; purpose?: string }
interface Manifest { name: string; short_name: string; description?: string; icons: ManifestIcon[] }

/**
 * The manifest the build ships: the source one, branded when this is not production.
 *
 * The source lives in `brand/`, not in `public/` or next to index.html: from either of those Vite
 * would copy or bundle it on its own (and rename it), and this plugin is the one writer.
 */
function brandedManifest(): Manifest {
    const source = JSON.parse(readFileSync(here('./brand/manifest.webmanifest'), 'utf8')) as Manifest;
    if (!LABEL) return source;
    return {
        ...source,
        name: `${source.name} — ${LABEL}`,
        short_name: SHORT_NAME,
        description: `${source.description ?? ''} — ${LABEL} BUILD, not the production tool.`,
        icons: source.icons.map((icon) => ({ ...icon, src: iconFor(icon.src) })),
    };
}

/**
 * index.html as this build ships it.
 *
 * The variant meta is removed before it is written, never only inserted: two would be read in
 * document order and the stale one would win. Same for build-id. `<title>` is left alone - the
 * name a home screen shows comes from the manifest and the apple title.
 */
function brandHtml(html: string, buildId: string): string {
    let out = html
        .replace(/\s*<meta\s+name="app-variant"[^>]*>/gi, '')
        .replace(/\s*<meta\s+name="build-id"[^>]*>/gi, '')
        .replace(/<\/head>/i, `  <meta name="app-variant" content="${VARIANT}" />\n    <meta name="build-id" content="${buildId}" />\n  </head>`);
    if (LABEL) {
        out = out
            .replace(/(<meta\s+name="apple-mobile-web-app-title"\s+content=")[^"]*(")/i, `$1${SHORT_NAME}$2`)
            .replace(/(<link\s+rel="(?:icon|apple-touch-icon)"[^>]*href=")([^"]+)(")/gi,
                (_m, a: string, href: string, b: string) => `${a}${iconFor(href)}${b}`);
    }
    return out;
}

/** Every icon index.html links to, as served paths. */
const linkedIcons = (html: string): string[] =>
    [...html.matchAll(/<link\s+rel="(?:icon|apple-touch-icon)"[^>]*href="([^"]+)"/gi)].map((m) => m[1]!);

// --- the offline set ------------------------------------------------------------------------

/**
 * The factory files, the patched program and the CSL bootloader, as `REQUIRED_BINARIES` names them
 * (bundled-files.mjs) - not whatever happens to be in `public/`.
 *
 * None of them is in the repository (THIRD-PARTY-NOTICES.md §2). A build without them still
 * builds - the app reports the missing file when it needs it - but it says so, and the deploy
 * script refuses a preview that does not carry them. Anything else in those folders fails the
 * build (`closeBundle`): Vite copies `public/` whole, and a stray ECU dump would otherwise ship.
 *
 * All of them are precached: BMW's factory files (~645 KB gzipped) so the version choice works in
 * a garage with no signal, and the community-patched program and the bootloader on the same
 * argument - the operator who wants them is standing at the car, not choosing them at a desk.
 */
function bundledBinaries(warn: (m: string) => void): string[] {
    const found: string[] = [];
    for (const f of REQUIRED_BINARIES) {
        if (existsSync(here(`./public/${f}`))) found.push(`/${f}`);
        else warn(`public/${f} is missing (not in the repository; see THIRD-PARTY-NOTICES.md)`);
    }
    return found;
}

/**
 * Brands the build, writes `manifest.webmanifest` and `sw.js`, then proves the output says what it
 * should.
 *
 * One plugin rather than three, because the order is the point: the manifest and the page are
 * branded before the worker's precache list is taken from them, so the worker can only ever name
 * files this build actually ships. The alternative - precaching only `/` and letting the runtime
 * cache fill in - leaves the app unusable offline until its second launch, which is the launch
 * that happens in a garage.
 */
function identityAndServiceWorker(): Plugin {
    const buildId = sourceStamp();
    let outDir = '';
    let precache: string[] = [];
    let manifest: Manifest | null = null;

    return {
        name: 'csl-identity-and-service-worker',
        configResolved(config) { outDir = resolve(config.root, config.build.outDir); },

        // `vite dev` serves the source manifest, so the page's <link> resolves there too.
        configureServer(server) {
            server.middlewares.use('/manifest.webmanifest', (_req, res) => {
                res.setHeader('content-type', 'application/manifest+json');
                res.end(JSON.stringify(brandedManifest()));
            });
        },

        transformIndexHtml(html, ctx) {
            return brandHtml(html, ctx.server ? 'dev' : buildId);
        },

        generateBundle(_options, bundle) {
            if (this.meta.watchMode) return;
            manifest = brandedManifest();
            this.emitFile({ type: 'asset', fileName: 'manifest.webmanifest', source: `${JSON.stringify(manifest, null, 2)}\n` });

            const html = brandHtml(readFileSync(here('./index.html'), 'utf8'), buildId);
            precache = [...new Set([
                '/',
                '/manifest.webmanifest',
                ...manifest.icons.map((icon) => icon.src),
                ...linkedIcons(html),
                ...bundledBinaries((m) => this.warn(m)),
                // index.html is covered by '/', and listing both would fetch it twice on install.
                ...Object.keys(bundle).map((name) => `/${name}`).filter((f) => f.startsWith('/assets/')),
            ])];

            const template = readFileSync(here('./sw-template.js'), 'utf8');
            this.emitFile({
                type: 'asset',
                fileName: 'sw.js',
                source: template
                    .replace('__BUILD_ID__', BUILD_ID)
                    .replace('__PRECACHE__', JSON.stringify(precache, null, 4)),
            });
        },

        /**
         * The output, checked after it is on disk. Each rule is a way a build has shipped wrong
         * without an error: a worker precaching a file that is not there fails its whole install;
         * a preview wearing production icons is indistinguishable on a home screen; a maskable
         * entry that reuses the full-bleed file is cropped by the launcher's circle.
         */
        closeBundle() {
            if (!manifest || !outDir) return;
            const problems: string[] = [];
            const dist = (p: string) => join(outDir, p === '/' ? 'index.html' : p.slice(1));

            for (const p of precache) if (!existsSync(dist(p))) problems.push(`precached but not in the build: ${p}`);
            // Only the listed binaries may be served from the bundled folders (bundled-files.mjs).
            for (const stray of strayBundledFiles(outDir)) problems.push(`${stray}; remove it from packages/web/public/ (only REQUIRED_BINARIES ship)`);

            const html = readFileSync(dist('/'), 'utf8');
            const variantMeta = [...html.matchAll(/<meta\s+name="app-variant"\s+content="([^"]*)"/gi)].map((m) => m[1]);
            if (variantMeta.length !== 1 || variantMeta[0] !== VARIANT) problems.push(`app-variant meta is ${JSON.stringify(variantMeta)}, expected ["${VARIANT}"]`);
            if ([...html.matchAll(/<meta\s+name="build-id"/gi)].length !== 1) problems.push('there must be exactly one build-id meta');
            for (const f of readdirSync(outDir)) {
                if (f.endsWith('.html') && /<meta\s+name="sync-token"/i.test(readFileSync(join(outDir, f), 'utf8'))) problems.push(`${f} carries a sync-token meta`);
            }

            const iconPaths = [...manifest.icons.map((i) => i.src), ...linkedIcons(html)];
            for (const p of iconPaths) {
                if (!existsSync(dist(p))) problems.push(`icon not in the build: ${p}`);
                if (LABEL && !p.includes('-dev-')) problems.push(`${LABEL} build points at a production icon: ${p}`);
                if (!LABEL && p.includes('-dev-')) problems.push(`production build points at a dev icon: ${p}`);
            }
            const anySrc = new Set(manifest.icons.filter((i) => (i.purpose ?? 'any').split(/\s+/).includes('any')).map((i) => i.src));
            for (const icon of manifest.icons) {
                const purposes = (icon.purpose ?? 'any').split(/\s+/);
                if (!purposes.includes('maskable')) continue;
                if (purposes.includes('any') || anySrc.has(icon.src)) problems.push(`maskable entry reuses an "any" file: ${icon.src}`);
                if (!icon.src.includes('-maskable-')) problems.push(`maskable entry is not a -maskable- file: ${icon.src}`);
            }
            if (LABEL && (!manifest.name.endsWith(` — ${LABEL}`) || manifest.short_name !== SHORT_NAME)) {
                problems.push(`manifest names "${manifest.name}" / "${manifest.short_name}" do not say ${LABEL}`);
            }

            // What browsers fetch without a cookie has to be let through by the gate, or the
            // install prompt breaks on its own icon. Checked against the middleware's own list.
            if (LABEL) {
                const middleware = readFileSync(here('../../functions/_middleware.ts'), 'utf8');
                for (const p of ['/manifest.webmanifest', ...iconPaths]) {
                    if (!middleware.includes(`'${p}'`)) problems.push(`not in the gate's publicPaths: ${p}`);
                }
            }

            if (problems.length) throw new Error(`the build is not what it should be:\n  ${problems.join('\n  ')}`);
            this.info?.(`identity ok: ${VARIANT || 'production'} ${buildId}, ${precache.length} precached`);
        },
    };
}

/**
 * Static build, served from the root of its own origin.
 *
 * The origin is not shared with the tuner, and that is forced rather than tidy: a service worker
 * scoped to `/` precaches the whole origin, so two apps on one origin would fight over the same
 * cache. It also has to be https - WebUSB is only exposed in a secure context - which rules out
 * opening the built `index.html` from the filesystem.
 */
export default defineConfig({
    base: '/',
    define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
    plugins: [react(), tailwindcss(), identityAndServiceWorker()],
    resolve: {
        alias: {
            // Source, not a build artifact. The UI and the link layer are checked by one compiler
            // pass, so a change to a telegram builder cannot pass typecheck here and fail there.
            'dme-flash': fileURLToPath(new URL('../dme-flash/src/index.ts', import.meta.url)),
        },
    },
    server: { host: true },
});
