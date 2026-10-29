/**
 * A lapsed sign-in: when the app goes through the gate by itself, when it only says so, and the
 * production build, which does neither.
 *
 * The rule is a function of state (`reauthMove`), so it is checked as one, fact by fact: each of
 * the things that keep the app on the screen is turned on alone, and each must be enough. The
 * request it makes, and the once-in-ten-minutes, are checked the way sync.test.ts checks sends -
 * by what reaches `fetch` and storage.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    AUTO_REAUTH_EVERY_MS, AUTO_REAUTH_KEY, claimAutoReauth, probeGate, reauthMove, type ReauthFacts,
} from './reauth';

/** Lapsed, with everything clear: online, nothing connected or running or unsaved, the clock right. */
const CLEAR: ReauthFacts = {
    preview: true, lapsed: true, clockOk: true, online: true, connected: false, busy: false, unsaved: false,
};

describe('the rule', () => {
    it('goes through the gate by itself when everything is clear', () => {
        expect(reauthMove(CLEAR)).toEqual({ notice: 'lapsed', offer: true, auto: true });
    });

    it('says nothing and does nothing in production, whatever else is true', () => {
        for (const clockOk of [true, false, null]) {
            expect(reauthMove({ ...CLEAR, preview: false, clockOk })).toEqual({ notice: null, offer: false, auto: false });
        }
    });

    it('says nothing and does nothing while the sign-in holds', () => {
        expect(reauthMove({ ...CLEAR, lapsed: false })).toEqual({ notice: null, offer: false, auto: false });
    });

    it('stays on the screen, offering nothing, while a link is open, an operation runs, or there is no network', () => {
        for (const held of [{ connected: true }, { busy: true }, { online: false }]) {
            expect(reauthMove({ ...CLEAR, ...held }), JSON.stringify(held)).toEqual({ notice: 'lapsed', offer: false, auto: false });
        }
    });

    it('stays on the screen, offering SIGN IN, with something unsaved or the clock not yet read', () => {
        for (const held of [{ unsaved: true }, { clockOk: null }]) {
            expect(reauthMove({ ...CLEAR, ...held }), JSON.stringify(held)).toEqual({ notice: 'lapsed', offer: true, auto: false });
        }
    });

    it('says the clock is out, and still offers SIGN IN, while the clock disagrees', () => {
        expect(reauthMove({ ...CLEAR, clockOk: false })).toEqual({ notice: 'clock', offer: true, auto: false });
        expect(reauthMove({ ...CLEAR, clockOk: false, connected: true })).toEqual({ notice: 'clock', offer: false, auto: false });
    });
});

describe('the automatic trip', () => {
    let kept: Map<string, string>;
    const T = Date.UTC(2026, 9, 30, 9, 0, 0);

    beforeEach(() => {
        kept = new Map();
        vi.stubGlobal('sessionStorage', {
            getItem: (key: string) => kept.get(key) ?? null,
            setItem: (key: string, value: string) => { kept.set(key, String(value)); },
        });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('is taken once, and not again for ten minutes', () => {
        expect(claimAutoReauth(T)).toBe(true);
        expect(kept.get(AUTO_REAUTH_KEY)).toBe(String(T));
        expect(claimAutoReauth(T + 1_000)).toBe(false);
        expect(claimAutoReauth(T + AUTO_REAUTH_EVERY_MS - 1)).toBe(false);
        expect(claimAutoReauth(T + AUTO_REAUTH_EVERY_MS)).toBe(true);
    });

    it('measures the ten minutes either way, since the clock is what moves', () => {
        expect(claimAutoReauth(T)).toBe(true);
        expect(claimAutoReauth(T - 60_000), 'a minute back').toBe(false);
        expect(claimAutoReauth(Date.UTC(2006, 11, 18)), 'twenty years back').toBe(true);
    });

    it('is not taken where storage is refused or does not keep it, since a loop could not be stopped', () => {
        vi.stubGlobal('sessionStorage', {
            getItem: () => { throw new DOMException('The operation is insecure.', 'SecurityError'); },
            setItem: () => { throw new DOMException('The operation is insecure.', 'SecurityError'); },
        });
        expect(claimAutoReauth(T)).toBe(false);

        vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => {} });
        expect(claimAutoReauth(T)).toBe(false);
    });
});

describe('asking the gate', () => {
    type Seen = { url: string; init: RequestInit | undefined };
    let seen: Seen[];
    let realFetch: typeof globalThis.fetch;

    /** A gate that answers every request with `status`, dated `serverAt` as Cloudflare dates it. */
    const gate = (status: number, serverAt: number = Date.now()) => {
        globalThis.fetch = (async (url: string, init?: RequestInit) => {
            seen.push({ url, init });
            return new Response(null, { status, headers: { date: new Date(serverAt).toUTCString() } });
        }) as unknown as typeof globalThis.fetch;
    };

    /** The page the build wrote: `app-variant` is all the client reads. */
    const page = (variant: '' | 'preview') => {
        (globalThis as { document?: unknown }).document = {
            querySelector: () => ({ getAttribute: () => variant }),
        };
    };

    beforeEach(() => {
        realFetch = globalThis.fetch;
        seen = [];
    });
    afterEach(() => {
        globalThis.fetch = realFetch;
        vi.useRealTimers();
        delete (globalThis as { document?: unknown }).document;
    });

    it('makes no request at all in production', async () => {
        page('');
        gate(401);
        expect(await probeGate()).toBeNull();
        expect(seen).toEqual([]);
    });

    it('asks for what the update check asks for, without downloading it', async () => {
        page('preview');
        gate(401);
        await probeGate();
        expect(seen).toHaveLength(1);
        expect(seen[0]!.url).toBe('/sw.js');
        expect(seen[0]!.init).toMatchObject({ method: 'HEAD', credentials: 'same-origin', cache: 'no-store' });
    });

    it('reads a 401 as a lapse, and its date against this device\'s clock', async () => {
        page('preview');
        gate(401);
        expect(await probeGate()).toEqual({ lapsed: true, clockOk: true });

        // The head unit fresh from boot: its clock at 2006-12-18, the gate's at today.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.UTC(2006, 11, 18, 0, 0, 0));
        gate(401, Date.UTC(2026, 9, 30, 9, 0, 0));
        expect(await probeGate()).toEqual({ lapsed: true, clockOk: false });
    });

    it('reads being let in as no lapse, and anything else as nothing known', async () => {
        page('preview');
        gate(200);
        expect(await probeGate()).toEqual({ lapsed: false });
        gate(503);
        expect(await probeGate()).toBeNull();
        globalThis.fetch = (async () => { throw new TypeError('offline'); }) as unknown as typeof globalThis.fetch;
        expect(await probeGate()).toBeNull();
    });
});
