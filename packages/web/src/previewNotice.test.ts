/**
 * The preview's first-run notice, and the promise it carries: nothing leaves the phone before the
 * owner has confirmed what does. And the other half of it - the production build, which sends
 * nothing, shows nothing new.
 *
 * The sends are checked by counting requests, as in sync.test.ts. The screen is checked by rendering
 * the whole app: "production shows nothing" is a claim about App, not about a helper App happens to
 * call, and a helper test would still pass the day App opened the dialog from some other branch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import App from './App';
import { t } from './copy';
import { noticeRequired } from './previewNotice';

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/140.0.0.0 Mobile Safari/537.36';
const IMAGE = new Uint8Array(2048).fill(0xff);
const FACTS = { label: 'test', createdAt: 1_700_000_000_000 };
const FAILURE = { stage: 'IDENT', error: 'login refused', log: ['LINE'], practice: false };

type Seen = { method: string; url: string };
let seen: Seen[];
let realFetch: typeof globalThis.fetch;

beforeEach(() => {
    realFetch = globalThis.fetch;
    seen = [];
    // A server that takes everything, behind a gate that knows this browser as owner-a.
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
        seen.push({ method: init?.method ?? 'GET', url });
        const body = url === '/_gate/status' ? { state: 'active', account_label: 'owner-a' }
            : url === '/api/runs' ? { id: 'r1', imageBytes: 1, logBytes: 1 }
                : { ok: true };
        return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    vi.stubGlobal('navigator', { language: 'ja-JP', userAgent: ANDROID });
});

afterEach(() => {
    globalThis.fetch = realFetch;
    vi.unstubAllGlobals();
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { localStorage?: unknown }).localStorage;
});

/**
 * The page the build wrote. `app-variant` is the only thing the app reads to know which it is;
 * `app-label` is only what it is called, and production carries none (vite.config.ts).
 */
function page(variant: '' | 'preview') {
    const metas: Record<string, string> = variant ? { 'app-variant': variant, 'app-label': 'WORKS' } : { 'app-variant': '' };
    (globalThis as { document?: unknown }).document = {
        querySelector: (selector: string) => {
            const content = metas[/name="([^"]+)"/.exec(selector)?.[1] ?? ''];
            return content === undefined ? null : { getAttribute: () => content };
        },
    };
}

/**
 * This browser's localStorage, holding `kept`. `'blocked'` is a browser that refuses it - a private
 * window, site data blocked - where, as in Chrome, even reaching for `localStorage` throws.
 */
function storage(kept: Record<string, string> | 'blocked'): Map<string, string> {
    const map = new Map(kept === 'blocked' ? [] : Object.entries(kept));
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get() {
            if (kept === 'blocked') throw new DOMException('The operation is insecure.', 'SecurityError');
            return {
                getItem: (key: string) => map.get(key) ?? null,
                setItem: (key: string, value: string) => { map.set(key, String(value)); },
                removeItem: (key: string) => { map.delete(key); },
            };
        },
    });
    return map;
}

/**
 * Just enough IndexedDB for the outbox in owner-sync.ts - one store, keyPath `key`, autoIncrement -
 * so that a record which waits can be seen waiting. Requests answer on a microtask, after their
 * handlers are attached, as real ones do.
 */
function fakeIndexedDb(): { rows: (name: string) => Record<string, unknown>[] } {
    type Req<T> = { result?: T; error?: unknown; onsuccess?: () => void; onerror?: () => void; onupgradeneeded?: () => void };
    const databases = new Map<string, Map<number, Record<string, unknown>>>();
    let nextKey = 1;
    const answer = <T>(run: () => T): Req<T> => {
        const req: Req<T> = {};
        queueMicrotask(() => {
            try {
                req.result = run();
                req.onsuccess?.();
            } catch (error) {
                req.error = error;
                req.onerror?.();
            }
        });
        return req;
    };
    vi.stubGlobal('indexedDB', {
        open(name: string): Req<unknown> {
            const req: Req<unknown> = {};
            queueMicrotask(() => {
                const created = !databases.has(name);
                const rows = databases.get(name) ?? new Map<number, Record<string, unknown>>();
                databases.set(name, rows);
                req.result = {
                    createObjectStore: () => ({}),
                    close: () => {},
                    transaction: () => ({
                        objectStore: () => ({
                            add: (value: Record<string, unknown>) => answer(() => {
                                const key = nextKey++;
                                rows.set(key, { ...value, key });
                                return key;
                            }),
                            getAll: () => answer(() => [...rows.values()]),
                            getAllKeys: () => answer(() => [...rows.keys()]),
                            delete: (key: number) => answer(() => { rows.delete(key); }),
                            count: () => answer(() => rows.size),
                        }),
                    }),
                };
                if (created) req.onupgradeneeded?.();
                req.onsuccess?.();
            });
            return req;
        },
    });
    return { rows: (name) => [...(databases.get(name)?.values() ?? [])] };
}

/**
 * The send path as a page that has just been opened has it. A confirmation given while storage is
 * refused lives in the module, for that page only - so each of these starts from a fresh load, the
 * way a relaunch does, instead of inheriting the previous test's page.
 */
async function launch() {
    vi.resetModules();
    const notice = await import('./previewNotice');
    const sync = await import('./sync');
    const upload = await import('./upload');
    return { ...notice, ...sync, ...upload };
}

/** Let every pending promise, fake IndexedDB request and response body run out. */
async function settle() {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The whole app, as the first render of a page draws it. */
const render = () => renderToStaticMarkup(createElement(App));

/** Everything the notice draws. It is App's last element, so it runs to the end of the markup. */
const dialogIn = (html: string) => html.slice(html.indexOf('role="dialog"'));

describe('the production build', () => {
    it('opens on the app, with no notice and nothing inert, whatever this browser has kept', () => {
        page('');
        for (const kept of [{}, 'blocked'] as const) {
            storage(kept);
            expect(noticeRequired()).toBe(false);
            const html = render();
            expect(html, 'the app itself rendered').toContain('CONNECT');
            expect(html).not.toContain('role="dialog"');
            expect(html).not.toContain(t().noticeLead);
            expect(html).not.toMatch(/<main[^>]*\binert/);
            expect(html, 'no build badge').not.toContain('>WORKS</span>');
        }
    });
});

describe('the preview, on its first launch', () => {
    it('opens on the notice, over an app that cannot be operated', () => {
        page('preview');
        storage({});
        const c = t();
        const html = render();

        expect(html).toMatch(/<main inert=""/);
        expect(html, 'the header badge names the build').toContain('>WORKS</span>');
        const dialog = dialogIn(html);
        expect(dialog).toContain('aria-modal="true"');
        expect(dialog).toContain('aria-labelledby="preview-notice-title"');
        expect(dialog).toMatch(/id="preview-notice-title"[^>]*>MSS54HP CSL CONVERT .*BOOT — WORKS<\/span><\/h2>/);
        for (const text of [
            c.noticeLead,
            c.noticeSessionsTitle, c.noticeSessions, c.noticeSessionsWhen,
            c.noticeRecordsTitle, c.noticeRecords, c.noticeRecordsWhen,
            c.noticeAlsoSent,
            c.noticePurposeTitle, c.noticePurpose,
            c.noticeWhereTitle, c.noticeWhere,
            c.noticeDeleteTitle, c.noticeDelete,
            c.noticePolicy,
        ]) expect(dialog).toContain(text);

        // One way on, and it says what it does. No close control of any other kind.
        expect(dialog).toContain(`${c.noticeConfirm}</button>`);
        expect(dialog.match(/<button/g)).toHaveLength(1);

        // The policy in a new tab, so the cable and whatever was read over it stay where they are.
        const link = /<a [^>]*href="https:\/\/m3\.tsunagi\.app\/privacy-policy#preview"[^>]*>/.exec(dialog)?.[0];
        expect(link).toBeDefined();
        expect(link).toContain('target="_blank"');
        expect(link).toContain('rel="noopener noreferrer"');
    });

    it('says it in English to an English browser, and links the English policy', () => {
        vi.stubGlobal('navigator', { language: 'en-US', userAgent: ANDROID });
        page('preview');
        storage({});
        const dialog = dialogIn(render());
        expect(dialog).toContain('lang="en"');
        expect(dialog).toContain(t().noticeLead);
        expect(dialog).toContain('So that what you save opens on your other devices');
        expect(dialog).toContain('Confirm and continue</button>');
        expect(dialog).toContain('href="https://m3.tsunagi.app/en/privacy-policy#preview"');
    });

    it('asks where storage is refused, since the answer could not have been kept', () => {
        page('preview');
        storage('blocked');
        expect(noticeRequired()).toBe(true);
        expect(render()).toContain('role="dialog"');
    });

    it('does not ask again once this browser has confirmed it', () => {
        page('preview');
        storage({ 'preview-notice:v1': '2026-09-24T00:00:00.000Z' });
        expect(noticeRequired()).toBe(false);
        const html = render();
        expect(html).not.toContain('role="dialog"');
        expect(html).not.toMatch(/<main[^>]*\binert/);
    });
});

describe('the preview, before the notice is confirmed', () => {
    it('sends nothing: a failure waits in the outbox, nothing flushes, and UPLOAD refuses', async () => {
        page('preview');
        // A browser whose gate has already said who it is, so a waiting record is filed to someone.
        storage({ 'owner-sync:account': 'owner-a' });
        const idb = fakeIndexedDb();
        const app = await launch();

        app.recordDiagnostic(FAILURE);
        app.flushDiagnostics();
        const refused = await app.uploadRun(IMAGE, ['LINE'], FACTS).then(() => null, (e: unknown) => e);
        await settle();

        expect(seen, 'not a record, not a run, not even the gate check a flush starts with').toEqual([]);
        expect(refused).toBeInstanceOf(app.NoticeNotAcknowledged);
        const waiting = idb.rows('boot-outbox');
        expect(waiting).toHaveLength(1);
        expect(waiting[0]).toMatchObject({ account: 'owner-a', record: { stage: 'IDENT', error: 'login refused' } });
    });
});

describe('the preview, once the notice is confirmed', () => {
    it('keeps the confirmation, sends what waited, and sends what comes after', async () => {
        page('preview');
        const kept = storage({ 'owner-sync:account': 'owner-a' });
        const idb = fakeIndexedDb();
        const app = await launch();
        app.recordDiagnostic(FAILURE);
        await settle();
        expect(idb.rows('boot-outbox')).toHaveLength(1);

        app.acknowledgeNotice();
        expect(kept.get('preview-notice:v1'), 'versioned, and when').toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
        expect(app.noticeRequired()).toBe(false);

        app.flushDiagnostics();
        await vi.waitFor(() => expect(idb.rows('boot-outbox')).toHaveLength(0));
        expect(seen).toEqual([
            { method: 'GET', url: '/_gate/status' },
            { method: 'POST', url: '/api/diagnostics' },
        ]);

        await app.uploadRun(IMAGE, ['LINE'], FACTS);
        expect(seen.at(-1)).toEqual({ method: 'POST', url: '/api/runs' });
    });
});

describe('a browser that cannot keep the confirmation', () => {
    it('sends after it is given on this page, and asks again on the next launch', async () => {
        page('preview');
        storage('blocked');
        fakeIndexedDb();
        let app = await launch();
        expect(app.noticeRequired()).toBe(true);

        expect(() => app.acknowledgeNotice()).not.toThrow();
        expect(app.noticeRequired()).toBe(false);
        app.recordDiagnostic(FAILURE);
        await vi.waitFor(() => expect(seen).toContainEqual({ method: 'POST', url: '/api/diagnostics' }));

        app = await launch();
        expect(app.noticeRequired()).toBe(true);
    });
});
