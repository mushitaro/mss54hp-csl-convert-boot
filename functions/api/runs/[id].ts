/**
 * GET    /api/runs/:id - one of the owner's runs, with its blobs.
 * DELETE /api/runs/:id - remove it.
 *
 * `?part=image` and `?part=log` hand the gzip back as a file download instead of JSON, which is
 * what makes the capture usable: the whole point of storing it is to open the actual bytes later,
 * and base64 inside a JSON envelope is a step between here and doing that.
 *
 * Another owner's id answers exactly like an id that does not exist - 404 - so a guessed id tells
 * the caller nothing about whether it is taken.
 */
import { Env, bad, blobToBase64, isId, ok, ownerAndDb } from '../../_shared';

export const onRequestGet: PagesFunction<Env> = async ({ request, env, params, data }) => {
    const who = ownerAndDb(data, env);
    if (who instanceof Response) return who;

    const id = String(params.id ?? '');
    if (!isId(id)) return bad('No such run.', 404);

    const row = await who.db
        .prepare('SELECT * FROM runs WHERE id = ? AND owner = ?')
        .bind(id, who.owner.id)
        .first<Record<string, unknown>>();
    if (!row) return bad('No such run.', 404);
    delete row.owner;

    const part = new URL(request.url).searchParams.get('part');
    if (part === 'image' || part === 'log') {
        const blob = row[part === 'image' ? 'image_gz' : 'log_gz'];
        if (blob === null || blob === undefined) return bad(`This run has no ${part}.`, 404);
        const b64 = blobToBase64(blob as ArrayBuffer | number[]);
        const bytes = Uint8Array.from(atob(b64!), (c) => c.charCodeAt(0));
        // Served as the gzip it is stored as. The caller gunzips - the browser will not do it for
        // a download, and decompressing here would only mean sending five times the bytes.
        return new Response(bytes, {
            headers: {
                'content-type': 'application/gzip',
                'content-disposition':
                    `attachment; filename="${id}_${part}.${part === 'image' ? 'bin' : 'txt'}.gz"`,
                'cache-control': 'private, no-store',
                'x-content-type-options': 'nosniff',
            },
        });
    }

    return ok({
        run: { ...row, image_gz: blobToBase64(row.image_gz as ArrayBuffer), log_gz: blobToBase64(row.log_gz as ArrayBuffer) },
    });
};

/**
 * The owner deleting their own run. Gone from D1 when this returns; there is no bin to empty.
 * Scoped by owner in the statement itself, so a foreign id deletes nothing and reads as 404.
 */
export const onRequestDelete: PagesFunction<Env> = async ({ env, params, data }) => {
    const who = ownerAndDb(data, env);
    if (who instanceof Response) return who;

    const id = String(params.id ?? '');
    if (!isId(id)) return bad('No such run.', 404);

    const result = await who.db
        .prepare('DELETE FROM runs WHERE id = ? AND owner = ?')
        .bind(id, who.owner.id)
        .run();
    if (!result.meta.changes) return bad('No such run.', 404);
    return ok({ id, deleted: true });
};
