/**
 * The service worker.
 *
 * This app is used in a garage, on a phone, often with no signal — so it has to open offline. It
 * also drives a device that can be bricked, which puts a hard constraint on the usual PWA
 * behaviour: **a stale build must never be what runs.** Those two pull in opposite directions, and
 * every choice below is where the line was drawn.
 *
 * ## Navigation is network-first, not cache-first
 *
 * The usual advice is cache-first for the shell, because it is fast and the content rarely
 * changes. Here the content is the safety rules — which sectors may be erased, whether writes are
 * locked, what the confirm screen says. A phone that has been in a toolbox since March must not
 * quietly run March's rules. So a connected phone always gets the current build, and the cache is
 * the fallback for when there is no network rather than the default source.
 *
 * The cost is one round trip on launch, bounded by NETWORK_TIMEOUT_MS so a bad signal falls back
 * quickly instead of hanging on a splash screen.
 *
 * ## Hashed assets are cache-first, because they cannot go stale
 *
 * `/assets/index-<hash>.js` names its own contents. A new build produces a new name and the old
 * name still describes exactly what it always described. There is nothing to revalidate.
 *
 * ## `skipWaiting` only when a person asks for it
 *
 * Never on install. A full backup takes half an hour, and swapping the worker under a page
 * mid-transfer to save a reload is a bad trade.
 *
 * But the default lifecycle alone is not enough either, and the reason was measured rather than
 * guessed: a same-tab reload does **not** release the client, so a worker that is waiting stays
 * waiting and the page comes back on the old build. Telling the operator to reload was therefore
 * an instruction they could follow perfectly and still not update — the worst kind, because it
 * looks like it worked.
 *
 * So the app offers an UPDATE control instead, and pressing it sends the message below. The rule
 * survives intact: the swap happens when a person who knows they are between operations asks for
 * it, and at no other time.
 */
const BUILD_ID = '__BUILD_ID__';
const CACHE = `csl-boot-${BUILD_ID}`;
const PRECACHE = __PRECACHE__;

/** How long a launch waits for the network before opening from cache. */
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener('install', (event) => {
    // No skipWaiting - see the note above.
    event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
        await self.clients.claim();
    })());
});

self.addEventListener('message', (event) => {
    // Which build this is, for the page to display.
    if (event.data === 'build-id') event.source?.postMessage({ buildId: BUILD_ID });
    // The operator pressed UPDATE. Only ever reached from that control - see the note above.
    if (event.data === 'skip-waiting') void self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    if (request.mode === 'navigate') {
        event.respondWith(networkFirst(request));
        return;
    }
    if (url.pathname.startsWith('/assets/')) {
        event.respondWith(cacheFirst(request));
        return;
    }
    event.respondWith(networkFirst(request));
});

/**
 * The network, or the cache if it does not answer in time.
 *
 * A response is only cached when the server actually said 200. Caching an error page under the
 * app's own URL is how a PWA ends up permanently broken with no way for the user to fix it.
 */
async function networkFirst(request) {
    const cache = await caches.open(CACHE);
    try {
        const response = await withTimeout(fetch(request), NETWORK_TIMEOUT_MS);
        if (response && response.status === 200) cache.put(request, response.clone());
        return response;
    } catch {
        const cached = await cache.match(request, { ignoreVary: true })
            ?? await cache.match('/', { ignoreVary: true });
        if (cached) return cached;
        return new Response('offline, and this page is not cached', {
            status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
    }
}

/** Content-hashed, so a hit is definitionally current. A miss fills the cache for next time. */
async function cacheFirst(request) {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request, { ignoreVary: true });
    if (cached) return cached;
    const response = await fetch(request);
    if (response.status === 200) cache.put(request, response.clone());
    return response;
}

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('network timeout')), ms)),
    ]);
}
