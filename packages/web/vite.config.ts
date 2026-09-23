import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
 * Emits `sw.js` with the real asset names baked in.
 *
 * The alternative - precaching only `/` and letting the runtime cache fill in - leaves the app
 * unusable offline until its second launch. That is the launch that happens in a garage.
 */
function serviceWorker(): Plugin {
    return {
        name: 'csl-service-worker',
        apply: 'build',
        generateBundle(_options, bundle) {
            const assets = Object.keys(bundle).map((name) => `/${name}`);
            // BMW's factory files, bundled so the version choice works in a garage with no
            // signal. ~645 KB gzipped, which is the whole reason they are precached rather than
            // fetched on demand: the launch that matters is the offline one.
            const spDaten = readdirSync(
                fileURLToPath(new URL('./public/spdaten', import.meta.url)))
                .filter((f) => /\.(0PA|0DA)$/i.test(f))
                .map((f) => `/spdaten/${f}`);
            // The community-patched program, precached on the same argument: the operator who
            // wants it is standing at the car, not choosing it at their desk. 1 MiB on disk,
            // ~213 KB gzipped - it is mostly the factory program, which compresses well.
            const patched = readdirSync(
                fileURLToPath(new URL('./public/program', import.meta.url)))
                .filter((f) => /\.bin$/i.test(f))
                .map((f) => `/program/${f}`);

            const precache = [
                '/',
                '/manifest.webmanifest',
                ...spDaten,
                ...patched,
                '/bootloader/csl-sa0.bin',
                '/icon-192.png',
                '/icon-512.png',
                '/icon-maskable-192.png',
                '/icon-maskable-512.png',
                '/icon.svg',
                // index.html is covered by '/', and listing both would fetch it twice on install.
                ...assets.filter((f) => f.startsWith('/assets/')),
            ];
            const template = readFileSync(
                fileURLToPath(new URL('./sw-template.js', import.meta.url)), 'utf8');
            this.emitFile({
                type: 'asset',
                fileName: 'sw.js',
                source: template
                    .replace('__BUILD_ID__', BUILD_ID)
                    .replace('__PRECACHE__', JSON.stringify(precache, null, 4)),
            });
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
    plugins: [react(), tailwindcss(), serviceWorker()],
    resolve: {
        alias: {
            // Source, not a build artifact. The UI and the link layer are checked by one compiler
            // pass, so a change to a telegram builder cannot pass typecheck here and fail there.
            'dme-flash': fileURLToPath(new URL('../dme-flash/src/index.ts', import.meta.url)),
        },
    },
    server: { host: true },
});
