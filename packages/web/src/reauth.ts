/**
 * A lapsed sign-in: noticed, said, and renewed by itself when leaving the page costs nothing. The
 * WORKS build only - production has no gate, and nothing here asks or says anything there.
 *
 * ## Why the app has to notice
 *
 * The service worker hides the owner gate. A page load the gate answers with "sign in" falls back
 * to the cached build (sw-template.js), and the update check - the browser asking for `/sw.js` -
 * gets a 401 that no page ever sees. So a phone whose sign-in has lapsed keeps running the build it
 * has, with no update and no UPLOAD, and nothing on the screen says so. That is how the car's head
 * unit ran old builds in silence on 2026-10-29 (the header of functions/_owner-gate/gate.ts).
 *
 * A lapse is found three ways, and they all end in the same state in App: the gate's status
 * (`gateStatus`, at launch and when the network comes back), a 401 from SYNC or UPLOAD, and
 * `probeGate` below, which asks for what the update check asks for.
 *
 * ## When it goes through the gate by itself
 *
 * Only when leaving cannot cost anything on the car or in the workspace: nothing connected
 * (practice included), nothing running, no capture or log that would be lost, a network to go
 * through, and this device's clock agreeing with the gate's. Even then, once in ten minutes per tab
 * (`claimAutoReauth`), so a round trip that comes back still signed out ends on the notice instead
 * of in a loop. Otherwise the app says so in the notice slot, with SIGN IN under it whenever leaving
 * is safe - the same trip, by hand, with the unsaved log named first.
 *
 * ## Why the clock
 *
 * The gate sets no cookie while the device's clock is out: one dated by a clock in 2006 would die
 * the moment the clock was put right. Sent through the gate then, the owner would get its page that
 * waits for the clock, and the app would be gone from the screen until the clock came right. A head
 * unit fresh from boot reads 2006 for a while. So the app stays, says the clock is out, and asks the
 * gate again every minute (`CLOCK_RETRY_MS`); once the clock agrees, it goes by itself.
 */
import { clockAgrees, isPreviewBuild } from './owner-sync';

/** How long after one automatic trip through the gate this tab makes no other. */
export const AUTO_REAUTH_EVERY_MS = 10 * 60_000;

/** How often the gate is asked again while this device's clock is out. */
export const CLOCK_RETRY_MS = 60_000;

/** The sessionStorage key: when this tab last went through the gate by itself. */
export const AUTO_REAUTH_KEY = 'reauth:auto-at';

/** What the gate said when it was asked as the update check asks. */
export type GateProbe = { lapsed: true; clockOk: boolean } | { lapsed: false };

/**
 * Asks the gate for `/sw.js`, the file the service worker's update check fetches, and reads the
 * answer: a 401 is a lapsed sign-in, and its Date header says whether this device's clock agrees
 * with the gate's (`clockAgrees`). HEAD, so nothing is downloaded; and past the service worker,
 * which leaves everything but GET to the network.
 *
 * Null when the answer says neither - offline, m3 unavailable (503) - and always in production,
 * which makes no request.
 */
export async function probeGate(): Promise<GateProbe | null> {
    if (!isPreviewBuild()) return null;
    try {
        const r = await fetch('/sw.js', { method: 'HEAD', credentials: 'same-origin', cache: 'no-store' });
        if (r.status === 401) return { lapsed: true, clockOk: clockAgrees(r) };
        return r.ok ? { lapsed: false } : null;
    } catch {
        return null;
    }
}

/** What App knows when it decides. Every field is state it already holds. */
export interface ReauthFacts {
    /** The WORKS build. */
    preview: boolean;
    /** The gate has refused this browser: its status said so, or a request here came back 401. */
    lapsed: boolean;
    /** `clockAgrees` on the gate's 401; null until one has been read. */
    clockOk: boolean | null;
    /** `navigator.onLine`, as App tracks it. */
    online: boolean;
    /** A link is open - a cable, or practice. */
    connected: boolean;
    /** An operation is running, the wait for an ignition cycle included. */
    busy: boolean;
    /** A capture, or a log nobody has saved, that leaving the page would lose. */
    unsaved: boolean;
}

export interface ReauthMove {
    /** What the notice slot says: the sign-in has lapsed - and, for `clock`, that the clock is out. */
    notice: 'lapsed' | 'clock' | null;
    /** SIGN IN is offered: leaving the page cannot drop a link or stop an operation. */
    offer: boolean;
    /** Go through the gate now, without asking - if `claimAutoReauth` also allows it. */
    auto: boolean;
}

/**
 * The whole rule, from state. SIGN IN is offered with the clock out as well: the gate's page then
 * waits for the clock, and after two minutes lets the owner go on without it, which a device whose
 * clock never comes right needs. Only the app itself does not leave on that.
 */
export function reauthMove(f: ReauthFacts): ReauthMove {
    if (!f.preview || !f.lapsed) return { notice: null, offer: false, auto: false };
    const offer = f.online && !f.connected && !f.busy;
    return {
        notice: f.clockOk === false ? 'clock' : 'lapsed',
        offer,
        auto: offer && !f.unsaved && f.clockOk === true,
    };
}

/**
 * Takes this tab's automatic trip through the gate: true, and recorded, if none was taken in the
 * last ten minutes. False otherwise - and false where sessionStorage is refused, because a trip
 * that came back signed out could not be remembered and the next one would loop. Never throws.
 *
 * Distance either way, not "since": the device's clock is the thing that moves under this app.
 */
export function claimAutoReauth(now: number = Date.now()): boolean {
    try {
        const last = Number(sessionStorage.getItem(AUTO_REAUTH_KEY));
        if (last > 0 && Math.abs(now - last) < AUTO_REAUTH_EVERY_MS) return false;
        sessionStorage.setItem(AUTO_REAUTH_KEY, String(now));
        return sessionStorage.getItem(AUTO_REAUTH_KEY) === String(now);
    } catch {
        return false;
    }
}
