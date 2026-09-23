/**
 * Shared pieces for the run and diagnostics API.
 *
 * ## Why this exists at all
 *
 * The app works with nothing behind it. These endpoints exist for a specific job: a real-car
 * session happens in a garage, on a phone, and produces a 1 MiB capture plus a log that together
 * are the only evidence of what the DME actually did. Getting them off the phone by hand - find the
 * file, remember which log line mattered, transcribe it - is where evidence gets lost, and the
 * sessions this is for are the ones that decide whether an irreversible operation is safe to
 * attempt.
 *
 * What lives here rather than in the routes is the part that has to behave identically across
 * them, because "the owner check is slightly different on this route" is the shape of the bug
 * nobody finds.
 *
 * ## Whose rows these are
 *
 * The owner gate (`functions/_middleware.ts`) runs before every route. It resolves the m3 account
 * behind the request's session cookie and puts it on `context.data.owner`; nothing reaches a
 * handler without one. The owner of a row is that account and never anything the client sent, so
 * every query here carries `owner = ?`, and an id that already belongs to someone else is refused
 * rather than overwritten.
 *
 * There is no token and no CORS. The app and this API share an origin, the browser sends the
 * gate's cookie on its own, and nothing else is meant to call these routes.
 */
import { json, ownerOf, unauthorized, type Owner } from './_owner-gate/owner';

export interface Env {
    RUNS_DB?: D1Database;
}

/**
 * D1 refuses a single value over 1,000,000 bytes. Stop short of it and say so, rather than letting
 * the caller believe a run was saved: this endpoint's whole job is to be the place a capture
 * survives the walk back from the car, and a row that failed to insert looks exactly like one that
 * did. The whole row is separately held under `MAX_ROW_BYTES` (owner.ts) before it is written.
 *
 * Measured headroom: a real MSS54HP 1 MiB image gzips to about 213 KB - roughly a fifth, because
 * a fifth of the flash is erased 0xFF. So one row is comfortable, and it is worth knowing that the
 * margin comes from the blank areas rather than from luck.
 */
export const MAX_GZ_BYTES = 900_000;

export const ok = (body: unknown) => json(body, 200);
export const bad = (message: string, status = 400) => json({ error: message }, status);

/**
 * The owner and the database, or the Response that says why not.
 *
 * 401 first: a request with no owner learns nothing about how this deployment is configured. A
 * missing binding is a 503, never a fall-through - a route that answers without its database looks
 * like it is working and stores nothing.
 */
export function ownerAndDb(data: Record<string, unknown>, env: Env): { owner: Owner; db: D1Database } | Response {
    const owner = ownerOf(data);
    if (!owner) return unauthorized();
    if (!env.RUNS_DB) return bad('This deployment has no database bound.', 503);
    return { owner, db: env.RUNS_DB };
}

/** An id the client chose: short, URL-safe, and nothing a path or a filename could be confused by. */
export const isId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{4,80}$/.test(id);

/**
 * A stored BLOB, back out as base64.
 *
 * D1 hands a BLOB back as a plain `number[]`, not an ArrayBuffer, and both shapes are declared in
 * the wild depending on version. Assuming the wrong one fails silently - the stream errors after
 * the headers are on the wire and the client gets 200 with an empty body - so all three are
 * handled. The 0x8000 chunking matters at this size: `String.fromCharCode(...bytes)` on 213 KB
 * throws.
 */
export function blobToBase64(value: ArrayBuffer | number[] | Uint8Array | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    const bytes = value instanceof Uint8Array ? value
        : Array.isArray(value) ? Uint8Array.from(value)
            : new Uint8Array(value);
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

/** base64 to bytes. */
export function decodeBase64(b64: string): Uint8Array {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

/**
 * gzip starts 1f 8b.
 *
 * Checked because a payload that will not inflate months from now is indistinguishable from one
 * that was never uploaded - and the entire point of the row is to still be readable later.
 */
export const isGzip = (b: Uint8Array) => b.byteLength >= 3 && b[0] === 0x1f && b[1] === 0x8b;
