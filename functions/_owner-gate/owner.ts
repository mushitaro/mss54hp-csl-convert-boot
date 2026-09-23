// What a preview app's SYNC handlers need from the gate.
//
// CANONICAL COPY — see gate.ts. Copied into each app as functions/_owner-gate/owner.ts.
//
// The rule every handler keeps: the owner of a row is the account the gate
// resolved for THIS request (context.data.owner), never anything the client
// sent. Every SELECT, UPDATE and DELETE carries `owner = ?`, and an INSERT
// whose id already belongs to someone else is refused, not merged.

export interface Owner {
  id: string;
  label: string;
}

/** The owner the gate put on this request, or null (which a handler turns into 401). */
export function ownerOf(data: Record<string, unknown>): Owner | null {
  const o = data.owner as Owner | undefined;
  return o && typeof o.id === 'string' && /^[0-9a-zA-Z-]{8,64}$/.test(o.id) ? o : null;
}

/**
 * D1 refuses a row over 2,000,000 bytes, and says so only as a 500. A row is
 * checked against this before it is written, so the client can be told "too
 * large" in words instead of a sync that silently never happens.
 */
export const MAX_ROW_BYTES = 1_900_000;

/** The summed size of the values a row will hold (strings as UTF-8, blobs as bytes). */
export function rowBytes(values: readonly unknown[]): number {
  let n = 0;
  const enc = new TextEncoder();
  for (const v of values) {
    if (v == null) continue;
    if (typeof v === 'string') n += enc.encode(v).byteLength;
    else if (v instanceof ArrayBuffer) n += v.byteLength;
    else if (ArrayBuffer.isView(v)) n += v.byteLength;
    else n += 8;
  }
  return n;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

export const unauthorized = (): Response => json({ error: 'unauthorized' }, 401);
export const tooLarge = (bytes: number): Response => json({ error: 'too_large', bytes, limit: MAX_ROW_BYTES }, 413);
export const conflict = (): Response => json({ error: 'id_taken' }, 409);
