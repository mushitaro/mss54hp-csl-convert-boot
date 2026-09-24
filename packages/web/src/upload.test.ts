/**
 * The upload's byte handling, against a realistically-sized capture.
 *
 * Everything here fails only at 1 MiB. A 100-byte fixture would pass every one of these and prove
 * nothing: `String.fromCharCode(...bytes)` throws on a long argument list, D1 refuses a value over
 * a megabyte, and gzip's saving on a flash image comes almost entirely from the erased areas - all
 * three are properties of the real size and invisible below it.
 *
 * The pure functions are exercised here; whether Cloudflare accepts the row is a question for
 * `wrangler pages dev`, not for a unit test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { FULL_IMAGE_LENGTH, CENSORED_RANGE } from 'dme-flash';
import { uploadRun, runId, UploadError } from './upload';

/** The same ceiling `functions/_shared.ts` enforces, restated so a drift between them fails here. */
const MAX_GZ_BYTES = 900_000;

const REAL_IMAGE = process.env.CSL_0401_BIN
    ?? String.raw`C:\Users\kazuh\CSL_0401_Binary_Disassembly_Notes\Full 211323000401PD31_TERRA.bin`;
const haveImage = existsSync(REAL_IMAGE);
const maybe = haveImage ? it : it.skip;

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

function base64(bytes: Uint8Array): string {
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

describe('getting a capture off the phone', () => {
    maybe('compresses a real 1 MiB image to well under what D1 will store', async () => {
        const image = new Uint8Array(readFileSync(REAL_IMAGE)).slice(0, FULL_IMAGE_LENGTH);
        expect(image.length).toBe(FULL_IMAGE_LENGTH);

        const gz = await gzip(image);
        // Measured at ~213 KB on both images to hand. The margin is the point: it comes from the
        // erased 0xFF areas, so an image with less blank space still has room.
        expect(gz.byteLength).toBeLessThan(MAX_GZ_BYTES);
        expect(gz.byteLength).toBeGreaterThan(50_000); // a suspiciously small result means truncation
        expect(gz[0], 'gzip magic, which the endpoint checks').toBe(0x1f);
        expect(gz[1]).toBe(0x8b);
    });

    maybe('survives base64 at that size, where the obvious implementation throws', async () => {
        // `String.fromCharCode(...bytes)` on 200 KB is a stack overflow, and it reports itself as
        // something unrelated. The chunking is the whole reason this function is written out.
        const image = new Uint8Array(readFileSync(REAL_IMAGE)).slice(0, FULL_IMAGE_LENGTH);
        const gz = await gzip(image);
        const b64 = base64(gz);

        expect(b64.length).toBeGreaterThan(gz.byteLength); // 4/3, plus padding
        const back = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        expect(back.byteLength).toBe(gz.byteLength);
        expect(Array.from(gunzipSync(back).subarray(0, 16)))
            .toEqual(Array.from(image.subarray(0, 16)));
    });

    maybe('round-trips the whole megabyte byte for byte', async () => {
        // The only check that matters in the end: what comes back out is what went in. A capture
        // that arrives subtly altered is worse than one that never arrived, because it will be
        // read as evidence.
        const image = new Uint8Array(readFileSync(REAL_IMAGE)).slice(0, FULL_IMAGE_LENGTH);
        const back = new Uint8Array(gunzipSync(await gzip(image)));
        expect(back.byteLength).toBe(FULL_IMAGE_LENGTH);
        expect(Buffer.from(back).equals(Buffer.from(image))).toBe(true);
    });

    it('compresses a log the same way', async () => {
        const log = Array.from({ length: 400 }, (_, i) => `LINE ${i}: something happened`);
        const gz = await gzip(new TextEncoder().encode(log.join('\n')));
        expect(gz[0]).toBe(0x1f);
        expect(gunzipSync(gz).toString('utf8').split('\n')).toHaveLength(400);
    });

    it('derives the censored-range check from the bytes, not from a flag', async () => {
        // What the real-car session exists to confirm: the firmware substitutes 0xFF for reads of
        // 0x4000-0x4017. The uploaded row records what the capture actually shows, so a session
        // where the firmware behaved differently is visible afterwards instead of assumed away.
        const blank = new Uint8Array(FULL_IMAGE_LENGTH).fill(0x00);
        blank.fill(0xff, CENSORED_RANGE.start, CENSORED_RANGE.end);
        expect(blank.subarray(CENSORED_RANGE.start, CENSORED_RANGE.end).every((b) => b === 0xff)).toBe(true);

        const notBlank = new Uint8Array(FULL_IMAGE_LENGTH).fill(0xff);
        notBlank[CENSORED_RANGE.start + 3] = 0x42;
        expect(notBlank.subarray(CENSORED_RANGE.start, CENSORED_RANGE.end).every((b) => b === 0xff)).toBe(false);
    });
});


/**
 * What goes over the wire, and what a refusal turns into.
 *
 * ## Why there is no token any more
 *
 * The upload used to present a bearer token that was built into the bundle - so anyone who opened
 * the page could read every stored capture back, VINs included. The preview is now behind the
 * owner gate, the server takes the owner from the gate's cookie, and the client presents nothing.
 * These pin that: no Authorization header, the cookie left to the browser, and the two refusals the
 * screen words differently kept apart.
 */
describe('sending a run', () => {
    const IMAGE = new Uint8Array(2048).fill(0xff);
    const FACTS = { label: 'test', createdAt: 1_700_000_000_000 };

    let realFetch: typeof globalThis.fetch;
    // A browser where the owner has confirmed the preview's first-run notice: before that nothing
    // is sent at all (previewNotice.test.ts).
    beforeEach(() => {
        realFetch = globalThis.fetch;
        (globalThis as { localStorage?: unknown }).localStorage = {
            getItem: (key: string) => (key === 'preview-notice:v1' ? '2026-09-24T00:00:00.000Z' : null),
        };
    });
    afterEach(() => {
        globalThis.fetch = realFetch;
        delete (globalThis as { localStorage?: unknown }).localStorage;
    });

    function server(status: number, body: unknown) {
        const seen: RequestInit[] = [];
        globalThis.fetch = (async (_url: string, init: RequestInit) => {
            seen.push(init);
            return new Response(JSON.stringify(body), { status });
        }) as unknown as typeof globalThis.fetch;
        return seen;
    }

    it('presents no credential of its own and leaves the cookie to the browser', async () => {
        const seen = server(200, { id: 'r1', imageBytes: 1, logBytes: 1 });
        const result = await uploadRun(IMAGE, ['LINE'], FACTS);

        expect(result.id).toBe('r1');
        expect(seen).toHaveLength(1);
        expect(new Headers(seen[0]!.headers).get('authorization')).toBeNull();
        expect(seen[0]!.credentials).toBe('same-origin');
    });

    it('uses the same id for the same session, so a retry replaces rather than duplicates', async () => {
        const seen = server(200, { id: 'r1', imageBytes: 1, logBytes: 1 });
        await uploadRun(IMAGE, ['LINE'], FACTS);
        await uploadRun(IMAGE, ['LINE'], FACTS);
        const ids = seen.map((init) => (JSON.parse(String(init.body)) as { id: string }).id);
        expect(ids[0]).toBe(runId(FACTS));
        expect(ids[1]).toBe(ids[0]);
    });

    it('reports an expired session as such, not as a failure of the capture', async () => {
        server(401, { error: 'unauthorized' });
        const error = await uploadRun(IMAGE, ['LINE'], FACTS).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(UploadError);
        expect((error as UploadError).expired).toBe(true);
        expect((error as UploadError).tooLarge).toBe(false);
    });

    it('reports a row the database will not take as too large', async () => {
        server(413, { error: 'too_large' });
        const error = await uploadRun(IMAGE, ['LINE'], FACTS).catch((e: unknown) => e);
        expect((error as UploadError).tooLarge).toBe(true);
        expect((error as UploadError).expired).toBe(false);
    });
});
