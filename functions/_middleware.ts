/**
 * The owner gate, in front of everything this origin serves.
 *
 * Not only the API: the page, the bundle, the service worker, and the BMW files the app carries
 * (SP-DATEN, the CSL bootloader, the patched program - THIRD-PARTY-NOTICES.md §5) all sit behind
 * it. A browser m3.tsunagi.app has not confirmed as an `owner_preview` holder gets a redirect to
 * sign in (a page load) or a 401 (anything else), never a byte of the app.
 *
 * The gate itself is `_owner-gate/gate.ts`, a byte-for-byte copy of tsunagi-m3's
 * tools/owner-gate/server/gate.ts; `npm run gate:verify` fails if it drifts. What is decided here is
 * only this app's identity and which files browsers must be able to fetch without a cookie: the
 * manifest and the icons it and index.html name. Browsers fetch those credential-less, and an
 * install prompt that 401s on its own icon is broken, not safe. The build checks that every icon
 * it emits for the preview is in this list (packages/web/vite.config.ts), so the two cannot drift.
 */
import { createGate } from './_owner-gate/gate';

export const onRequest = createGate({
    clientId: 'boot-preview',
    canonicalHost: 'mss54hp-csl-convert-boot-preview.pages.dev',
    name: 'MSS54HP CSL CONVERT /// BOOT — PREVIEW',
    publicPaths: [
        '/manifest.webmanifest',
        '/icons/modification-dev-192.png',
        '/icons/modification-dev-512.png',
        '/icons/modification-dev-maskable-192.png',
        '/icons/modification-dev-maskable-512.png',
        '/icons/modification-dev-256.png',
        '/icons/modification-dev-32.png',
    ],
}) as unknown as PagesFunction;
