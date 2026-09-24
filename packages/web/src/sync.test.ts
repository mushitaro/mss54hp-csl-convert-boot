/**
 * The SYNC client's two promises: the production build sends nothing, and a failure in the preview
 * build is recorded without anyone asking and without being able to break the operation.
 *
 * Both are about requests, so both are checked by counting requests rather than by reading code.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    canSync, cloudFilename, currentGate, deleteDiagnostic, deleteRun, fetchDiagnosticLog, fetchRunPart,
    flushDiagnostics, listDiagnostics, listRuns, recordDiagnostic, SyncRequestError,
} from './sync';

type Seen = { url: string; init: RequestInit | undefined };

let realFetch: typeof globalThis.fetch;
let seen: Seen[];

beforeEach(() => {
    realFetch = globalThis.fetch;
    seen = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
        seen.push({ url, init });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
    globalThis.fetch = realFetch;
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { localStorage?: unknown }).localStorage;
});

/** A page whose build wrote these metas - the only thing the client reads to decide. */
function page(meta: Record<string, string>) {
    (globalThis as { document?: unknown }).document = {
        querySelector: (selector: string) => {
            const name = /name="([^"]+)"/.exec(selector)?.[1] ?? '';
            return name in meta ? { getAttribute: () => meta[name] } : null;
        },
    };
}

/**
 * A browser where the owner has confirmed the preview's first-run notice. Before that the preview
 * sends nothing at all - previewNotice.test.ts is about that; these are about what it sends after.
 */
function confirmed() {
    const kept = new Map([['preview-notice:v1', '2026-09-24T00:00:00.000Z']]);
    (globalThis as { localStorage?: unknown }).localStorage = {
        getItem: (key: string) => kept.get(key) ?? null,
        setItem: (key: string, value: string) => { kept.set(key, value); },
    };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the production build', () => {
    it('makes no request at all, whatever is called', async () => {
        page({ 'app-variant': '' });
        expect(canSync()).toBe(false);

        await listRuns();
        await listDiagnostics();
        await deleteRun('abcd1234');
        await deleteDiagnostic('abcd1234');
        await currentGate();
        recordDiagnostic({ stage: 'IDENT', error: 'refused', log: ['x'], practice: false });
        flushDiagnostics();
        await tick();

        expect(seen).toEqual([]);
    });
});

describe('a failure in the preview build', () => {
    it('is sent by itself, with the build, the mode and the end of the log', async () => {
        page({ 'app-variant': 'preview', 'build-id': '20260923T000000Z.abc1234' });
        confirmed();
        const log = Array.from({ length: 300 }, (_, i) => `LINE ${i}`);

        recordDiagnostic({ stage: 'IDENT', error: 'login refused', log, practice: true, ident: 'MSS54HP' });
        await tick();
        await tick();

        const post = seen.find((s) => s.url === '/api/diagnostics');
        expect(post, 'one POST to the diagnostics route').toBeDefined();
        expect(post!.init?.method).toBe('POST');
        expect(new Headers(post!.init?.headers).get('authorization')).toBeNull();
        const body = JSON.parse(String(post!.init?.body)) as Record<string, unknown>;
        expect(body.stage).toBe('IDENT');
        expect(body.error).toBe('login refused');
        expect(body.practice).toBe(true);
        expect(body.appBuild).toBe('20260923T000000Z.abc1234');
        const lines = String(body.log).split('\n');
        expect(lines).toHaveLength(200);
        expect(lines.at(-1)).toBe('LINE 299');
    });

    it('sends nothing that was waiting until the gate says the session is active', async () => {
        page({ 'app-variant': 'preview' });
        confirmed();
        globalThis.fetch = (async (url: string, init?: RequestInit) => {
            seen.push({ url, init });
            return new Response(JSON.stringify({ state: 'expired', account_label: 'owner-a' }), { status: 200 });
        }) as unknown as typeof globalThis.fetch;

        flushDiagnostics();
        await tick();
        await tick();

        expect(seen.map((s) => s.url)).toEqual(['/_gate/status']);
    });

    it('never throws into the caller, even when the network does', () => {
        page({ 'app-variant': 'preview' });
        confirmed();
        globalThis.fetch = (async () => { throw new TypeError('offline'); }) as unknown as typeof globalThis.fetch;
        expect(() => recordDiagnostic({ stage: 'BACKUP', error: 'x', log: [], practice: false })).not.toThrow();
    });
});

describe('a download after the sign-in has lapsed', () => {
    const answer = (status: number) => {
        globalThis.fetch = (async (url: string, init?: RequestInit) => {
            seen.push({ url, init });
            return new Response(JSON.stringify({ error: 'x' }), { status });
        }) as unknown as typeof globalThis.fetch;
    };

    it('says so by its status, for IMAGE, LOG and an error record LOG, so the app can offer SIGN IN', async () => {
        page({ 'app-variant': 'preview' });
        answer(401);
        for (const attempt of [fetchRunPart('r1', 'image'), fetchRunPart('r1', 'log'), fetchDiagnosticLog('d1')]) {
            const error = await attempt.then(() => null, (e: unknown) => e);
            expect(error).toBeInstanceOf(SyncRequestError);
            expect((error as SyncRequestError).expired).toBe(true);
        }
    });

    it('is not confused with any other refusal', async () => {
        page({ 'app-variant': 'preview' });
        answer(404);
        const error = await fetchRunPart('r1', 'image').then(() => null, (e: unknown) => e);
        expect(error).toBeInstanceOf(SyncRequestError);
        expect((error as SyncRequestError).expired).toBe(false);
        expect((error as Error).message).toBe('image: 404');
    });
});

describe('a saved run, back on the phone', () => {
    it('is named like the app\'s own files, and says when it was practice', () => {
        const at = Date.UTC(2026, 8, 23, 1, 2, 3);
        expect(cloudFilename({ created_at: at, verified: 1, note: null }, 'image'))
            .toBe('MSS54HP_cloud_verified_2026-09-23T01-02-03.bin');
        expect(cloudFilename({ created_at: at, verified: 0, note: 'PRACTICE - simulated DME, not a car' }, 'log'))
            .toBe('PRACTICE_NOT-A-CAR_MSS54HP_cloud_log_2026-09-23T01-02-03.txt');
    });
});
