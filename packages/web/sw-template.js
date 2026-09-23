/**
 * The service worker.
 *
 * This app is used in a garage, on a phone, often with no signal — so it has to open offline. It
 * also drives a device that can be bricked, which puts a hard constraint on the usual PWA
 * behaviour: **a stale build must never be what runs.** Those two pull in opposite directions, and
 * every choice below is where the line was drawn.
 *
 * It also lives behind the owner gate (functions/_middleware.ts), which answers a request without a
 * session with a redirect to m3 (a page load) or a 401 (anything else). Neither of those is ever
 * the app, and the rules below are written so that neither can be stored as it.
 *
 * ## The gate's own routes and the API are never touched
 *
 * `/_gate/*` and `/api/*` go straight to the network, and that test comes before everything else -
 * including the navigation fallback. A sign-in round trip answered from cache would loop; an API
 * answer from cache would be someone's data at the wrong moment.
 *
 * ## Navigation is network-first, not cache-first
 *
 * The usual advice is cache-first for the shell, because it is fast and the content rarely
 * changes. Here the content is the safety rules — which sectors may be erased, whether writes are
 * locked, what the confirm screen says. A phone that has been in a toolbox since March must not
 * quietly run March's rules. So a connected phone always gets the current build, and the cache is
 * the fallback for when the network cannot give it: no answer within NETWORK_TIMEOUT_MS, a redirect
 * (the gate sending an expired session to sign in), or anything but a 2xx. An owner whose session
 * lapsed in a garage still gets the app they installed; the app itself offers to sign in again.
 *
 * ## Hashed assets are cache-first, because they cannot go stale
 *
 * `/assets/index-<hash>.js` names its own contents. A new build produces a new name and the old
 * name still describes exactly what it always described. There is nothing to revalidate. The BMW
 * files and the bootloader are cache-first for the same reason: they are fixed per build and live
 * in this build's cache.
 *
 * ## An install either takes everything, or nothing
 *
 * Every file is fetched and checked - a 2xx, from this origin, not bounced through the gate, and
 * the type its name promises - before any of it is stored. One file that fails keeps the whole
 * update out, and the build already installed stays exactly as it was. The check that matters most
 * is the type: Pages answers a missing file with the app's own index.html and a 200, so without it
 * a missing bootloader would be cached as a web page under `csl-sa0.bin`.
 *
 * ## Nothing moves while the cable is in use
 *
 * An install first asks every open page whether it is busy (a link connected, an operation
 * running). If one is, the install gives up before downloading anything and the browser tries
 * again at its next update check.
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
 * it, and at no other time. The page hides that control while anything is connected or running.
 */
const BUILD_ID = '__BUILD_ID__';
const CACHE = `csl-boot-${BUILD_ID}`;
const PRECACHE = __PRECACHE__;

/** How long a launch waits for the network before opening from cache. */
const NETWORK_TIMEOUT_MS = 3000;

/** How long an install waits for pages to say whether they are busy. A page that does not answer is not. */
const BUSY_ASK_MS = 500;

/** Paths whose response must be a file, never a page: the SPA fallback's 200 text/html is refused. */
const BINARY = /^\/(spdaten|program|bootloader)\//;

self.addEventListener('install', (event) => {
    // No skipWaiting - see the note above.
    event.waitUntil((async () => {
        if (await anyPageBusy()) throw new Error('a page is using the cable; the update waits for the next check');
        await precache();
    })());
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

    // First, before any fallback: the gate and the API are the network's alone.
    if (url.pathname.startsWith('/_gate/') || url.pathname.startsWith('/api/')) return;

    if (request.mode === 'navigate') {
        event.respondWith(networkFirst(request, true));
        return;
    }
    if (url.pathname.startsWith('/assets/') || BINARY.test(url.pathname)) {
        event.respondWith(cacheFirst(request, url.pathname));
        return;
    }
    event.respondWith(networkFirst(request, false));
});

/**
 * Every precached file, fetched and checked, then stored together - or none of them.
 *
 * Keys ending in `.html` are fetched without the extension (Pages answers `/x.html` with a 308 to
 * `/x`) and stored under the key the page will ask for.
 */
async function precache() {
    const fetched = await Promise.all(PRECACHE.map(async (key) => {
        const from = key.endsWith('/index.html') ? key.slice(0, -'index.html'.length)
            : key.endsWith('.html') ? key.slice(0, -'.html'.length) : key;
        const response = await fetch(from, { cache: 'reload', credentials: 'same-origin' });
        if (!acceptable(key, response)) {
            throw new Error(`precache refused ${key}: ${response.status} ${response.type} ${response.headers.get('content-type')}`);
        }
        return [key, response];
    }));
    const cache = await caches.open(CACHE);
    try {
        await Promise.all(fetched.map(([key, response]) => cache.put(key, response)));
    } catch (error) {
        // A half-written cache under this build's name would be served as if it were whole.
        await caches.delete(CACHE);
        throw error;
    }
}

/**
 * Whether a response is really the file `key` names.
 *
 * `basic` rules out anything cross-origin; a redirect is allowed only if it stayed on this origin
 * and did not pass through the gate (a bounce to sign in ends somewhere that is not the file).
 */
function acceptable(key, response) {
    if (!response || !response.ok || response.type !== 'basic') return false;
    if (response.redirected) {
        const to = new URL(response.url);
        if (to.origin !== self.location.origin || to.pathname.startsWith('/_gate/')) return false;
    }
    return typeFits(key, response.headers.get('content-type') ?? '');
}

/** The content type a path's name promises. Anything the gate or the SPA fallback says instead fails. */
function typeFits(key, contentType) {
    const type = contentType.toLowerCase();
    const path = key.split('?')[0];
    if (path.endsWith('/') || path.endsWith('.html')) return type.startsWith('text/html');
    if (type.startsWith('text/html') || type.startsWith('application/json')) return false;
    if (path.endsWith('.js')) return type.includes('javascript');
    if (path.endsWith('.css')) return type.startsWith('text/css');
    if (path.endsWith('.png')) return type.startsWith('image/png');
    if (path.endsWith('.svg')) return type.startsWith('image/svg+xml');
    if (path.endsWith('.webmanifest')) return type.includes('manifest+json') || type.includes('json');
    // .0PA, .0DA, .bin, .txt: anything that is not a page or an error body.
    return true;
}

/**
 * Asks every open page whether it is busy with the cable. True if any says so.
 *
 * Pages answer from `pwa.ts`. One that does not answer in time - an old build, a frozen tab - is
 * treated as not busy, so a page can delay an update but never block updates for good.
 */
async function anyPageBusy() {
    const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const answers = await Promise.all(pages.map((page) => new Promise((resolve) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => resolve(false), BUSY_ASK_MS);
        channel.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data === true); };
        page.postMessage({ type: 'busy?' }, [channel.port2]);
    })));
    return answers.includes(true);
}

/**
 * The network, or this build's cached copy when the network cannot give the real thing.
 *
 * Nothing is stored here: what is cached is exactly what the install checked, and a response
 * taken at run time could be the new build's page sitting in the old build's cache.
 */
async function networkFirst(request, navigation) {
    const cache = await caches.open(CACHE);
    const cached = async () =>
        (await cache.match(request, { ignoreVary: true, ignoreSearch: navigation }))
        ?? (navigation ? await cache.match('/', { ignoreVary: true }) : undefined);
    try {
        const response = await withTimeout(fetch(request), NETWORK_TIMEOUT_MS);
        if (response.type === 'opaqueredirect' || !response.ok) {
            const fallback = await cached();
            if (fallback) return fallback;
        }
        return response;
    } catch {
        const fallback = await cached();
        if (fallback) return fallback;
        return new Response('offline, and this page is not cached', {
            status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
    }
}

/**
 * Fixed per build, so a hit is definitionally current. A miss goes to the network and is kept only
 * if it is really the file - never a page answering for a missing binary, which is refused here
 * rather than handed to the app as if it were one.
 */
async function cacheFirst(request, path) {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(request, { ignoreVary: true });
    if (hit) return hit;
    const response = await fetch(request);
    if (acceptable(path, response)) {
        await cache.put(request, response.clone()).catch(() => {});
        return response;
    }
    if (BINARY.test(path) && response.ok) {
        return new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    return response;
}

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('network timeout')), ms)),
    ]);
}
