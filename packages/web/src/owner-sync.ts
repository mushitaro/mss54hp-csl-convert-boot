// The browser half of a preview app's SYNC: talking to its own API through the
// owner gate, keeping error records that could not be sent, and knowing when the
// owner needs to sign in again.
//
// CANONICAL COPY — see ../server/gate.ts. Copied into each app (the path is the
// app's choice; its `gate:verify` script knows where) and checked for drift.
//
// No token, no configuration. The gate put a session cookie on this origin when
// the owner arrived from m3; every request here is same-origin and carries it.
// That is the whole of "SYNC works without setup".
//
// Framework-free on purpose: the five apps are Next and Vite, and all of them
// can import this.

/** Only the preview build syncs. Production is local-only, and its privacy text says so. */
export function isPreviewBuild(): boolean {
  if (typeof document === 'undefined') return false;
  return document.querySelector('meta[name="app-variant"]')?.getAttribute('content') === 'preview';
}

export type GateState = 'active' | 'expired' | 'unknown';

/**
 * Whether this browser's session with the app is still good. `unknown` — m3
 * down, offline, anything unexpected — is NOT `expired`: the app keeps working
 * and offers nothing, rather than sending the owner into an error page.
 */
export async function gateStatus(): Promise<{ state: GateState; label: string | null }> {
  try {
    const r = await fetch('/_gate/status', { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) return { state: 'unknown', label: null };
    const d = (await r.json()) as { state?: GateState; account_label?: string };
    const state = d.state === 'active' || d.state === 'expired' ? d.state : 'unknown';
    return { state, label: d.account_label ?? null };
  } catch {
    return { state: 'unknown', label: null };
  }
}

/**
 * Where "sign in again" goes: a same-tab navigation through m3 and back to
 * this page. Same tab, because m3 only sees its SameSite=Lax cookie on a
 * top-level navigation — and callers must only offer it while no cable is
 * connected and nothing unsaved would be lost.
 */
export function reauthHref(returnPath?: string): string {
  const here = returnPath ?? (typeof location === 'undefined' ? '/' : location.pathname + location.search);
  return '/_gate/start?return=' + encodeURIComponent(here);
}

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  /** 401: the session is gone. The caller keeps the work and says so. */
  expired: boolean;
  /** 413: the row would exceed what the database takes. */
  tooLarge: boolean;
}

/** A same-origin JSON call to the app's own API. Never throws. */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
  try {
    const r = await fetch(path, {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const data = (await r.json().catch(() => null)) as T | null;
    return { ok: r.ok, status: r.status, data, expired: r.status === 401, tooLarge: r.status === 413 };
  } catch {
    return { ok: false, status: 0, data: null, expired: false, tooLarge: false };
  }
}

// ── gzip + base64, for the blobs a session carries ──────────────────────────

export async function gzipB64(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  let s = '';
  for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode(...out.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function gunzipB64(b64: string): Promise<Uint8Array> {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ── the outbox: error records that could not be sent yet ────────────────────

const OUTBOX_LIMIT = 20;

function idb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('records', { keyPath: 'key', autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const r = run(db.transaction('records', mode).objectStore('records'));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/**
 * A small queue in IndexedDB for records a garage without signal, or an
 * expired session, would otherwise drop. Newest twenty kept; sent oldest first
 * the next time a send succeeds. Never throws — losing a record is better than
 * breaking the operation it describes.
 */
export function outbox(dbName: string) {
  return {
    async add(record: unknown): Promise<void> {
      try {
        const db = await idb(dbName);
        await tx(db, 'readwrite', (s) => s.add({ record, at: Date.now() }));
        const keys = (await tx(db, 'readonly', (s) => s.getAllKeys())) as IDBValidKey[];
        for (const k of keys.slice(0, Math.max(0, keys.length - OUTBOX_LIMIT))) await tx(db, 'readwrite', (s) => s.delete(k));
        db.close();
      } catch {
        // Nowhere to keep it: the record is lost, the operation is not.
      }
    },
    /** Send what is waiting, oldest first; stop at the first failure. Returns how many went. */
    async flush(send: (record: unknown) => Promise<boolean>): Promise<number> {
      let sent = 0;
      try {
        const db = await idb(dbName);
        const rows = (await tx(db, 'readonly', (s) => s.getAll())) as { key: IDBValidKey; record: unknown }[];
        for (const row of rows) {
          if (!(await send(row.record))) break;
          await tx(db, 'readwrite', (s) => s.delete(row.key));
          sent++;
        }
        db.close();
      } catch {
        // Try again next time.
      }
      return sent;
    },
    async count(): Promise<number> {
      try {
        const db = await idb(dbName);
        const n = await tx(db, 'readonly', (s) => s.count());
        db.close();
        return n;
      } catch {
        return 0;
      }
    },
  };
}
