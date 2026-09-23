/**
 * Service-worker registration, and the one thing the app needs back from it.
 *
 * The worker's own policy lives in `sw-template.js`. This side does two jobs: register it, and
 * notice when a newer build is installed but waiting.
 *
 * **It never activates the waiting worker on its own.** That would swap the code under a page which
 * might be twenty minutes into a full backup. Only `applyUpdate` does it, and only from a control
 * the operator pressed - which is the only moment anyone can judge whether it is safe to.
 */

/** Stamped in at build time. Shown in the header so a phone can say what it is running. */
declare const __BUILD_ID__: string;
export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';

/** Whether a link is connected or an operation is running. Set by the app on every change. */
let linkBusy = false;

/**
 * Tell the service worker, when it asks, that now is not the time.
 *
 * A worker that is about to install an update asks every open page first (`anyPageBusy` in
 * sw-template.js), and a busy page makes it give up before downloading anything - the browser
 * tries again at its next check. Answered from here rather than pushed from the app, because the
 * worker that asks is a new one the page has never spoken to.
 */
export function setLinkBusy(busy: boolean): void {
    linkBusy = busy;
}

export function registerServiceWorker(onUpdate: () => void): void {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    // Not during `vite dev`: a worker caching a dev server produces failures that look like app
    // bugs and are not.
    if (import.meta.env.DEV) return;

    navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
        if ((event.data as { type?: string } | null)?.type === 'busy?') event.ports[0]?.postMessage(linkBusy);
    });
    // Messages from a worker are held until the page says it is listening.
    navigator.serviceWorker.startMessages();

    window.addEventListener('load', () => {
        void navigator.serviceWorker.register('/sw.js').then((registration) => {
            /**
             * A worker that is installed and waiting means a newer build is ready.
             *
             * `controller` is the test for "this is an update, not a first install" - without it,
             * every first visit would announce one. It is checked at the moment of the call rather
             * than captured, because a first visit becomes a controlled page moments later.
             */
            const announceIfWaiting = (worker: ServiceWorker | null): void => {
                if (worker?.state === 'installed' && navigator.serviceWorker.controller) onUpdate();
            };

            announceIfWaiting(registration.waiting);
            registration.addEventListener('updatefound', () => {
                const installing = registration.installing;
                if (!installing) return;
                // Called immediately AND on every transition. Listening only for `statechange`
                // loses the race whenever the worker finishes installing before this line runs -
                // which is most of the time on a cached origin, and is why an update that really
                // was waiting went unannounced on the deployed site.
                announceIfWaiting(installing);
                installing.addEventListener('statechange', () => announceIfWaiting(installing));
            });
        }).catch(() => {
            // A failed registration costs offline support and nothing else. It must not be able to
            // stop the app from opening, which is the only thing that actually matters here.
        });
    });
}

/**
 * Switch to the waiting build, then reload onto it.
 *
 * Two things here are not optional, and both were found by trying the obvious version first.
 *
 * A plain `location.reload()` does not do it. A same-tab reload does not release the client, so the
 * waiting worker keeps waiting and the page comes back on the old build - verified on the deployed
 * site, where the build id was identical before and after. The worker has to be told to take over.
 *
 * And the reload has to wait for `controllerchange` rather than firing straight after the message:
 * reloading before the new worker controls the page just re-loads the old one again.
 */
export async function applyUpdate(): Promise<void> {
    const registration = await navigator.serviceWorker?.getRegistration();
    const waiting = registration?.waiting;
    if (!waiting) { window.location.reload(); return; }

    // Guarded, because `controllerchange` can fire more than once and a reload loop on a tool that
    // talks to hardware would be worse than a stale build.
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded) return;
        reloaded = true;
        window.location.reload();
    });
    waiting.postMessage('skip-waiting');
}

/**
 * Whether this page is running as an installed app rather than in a browser tab.
 *
 * Worth knowing because a browser tab on Android can be evicted while backgrounded, and this app's
 * shortest useful operation runs for minutes.
 */
export function isInstalled(): boolean {
    if (typeof window === 'undefined') return false;
    return window.matchMedia?.('(display-mode: standalone)').matches === true
        || (navigator as { standalone?: boolean }).standalone === true;
}
