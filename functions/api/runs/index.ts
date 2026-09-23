/**
 * POST /api/runs  - store one real-car session for the signed-in owner.
 * GET  /api/runs  - list that owner's sessions, newest first.
 *
 * A "run" is one session against a real DME: the 1 MiB capture, the event log, and the handful of
 * facts that decide how to read them. It exists so a session in a garage can be judged afterwards
 * at a desk, against the actual bytes, rather than from what anyone remembered to write down.
 *
 * The row is deliberately wider than "two blobs". Every scalar here is something that changes how
 * the capture should be interpreted - whether the login was granted, whether the two passes agreed,
 * whether the screen went to the background - and a blob with no context is evidence of nothing.
 *
 * Every row belongs to the account the gate resolved (see `_shared.ts`). A capture carries the VIN,
 * the AIF and the flash counter of one car, so one owner never sees, replaces or learns of another's.
 */
import { MAX_ROW_BYTES, conflict, json, rowBytes, tooLarge } from '../../_owner-gate/owner';
import { Env, MAX_GZ_BYTES, bad, decodeBase64, isGzip, isId, ok, ownerAndDb } from '../../_shared';

/**
 * Everything except the two blobs.
 *
 * The list must never inflate a run to describe it: the capture is ~213 KB compressed, and a
 * listing that carried them would move a megabyte to answer "what do I have".
 */
const LIST_COLUMNS = `
    id, created_at, uploaded_at, label, app_build, ident,
    master_flavour, master_crc, master_crc_valid,
    slave_flavour, slave_crc, slave_crc_valid,
    logged_in, verified, differing_count, censored_blank,
    elapsed_seconds, went_hidden, user_agent, note,
    length(image_gz) AS image_bytes,
    length(log_gz)   AS log_bytes
`;

export const onRequestGet: PagesFunction<Env> = async ({ request, env, data }) => {
    const who = ownerAndDb(data, env);
    if (who instanceof Response) return who;

    const limit = Math.min(200, Math.max(1, Number(new URL(request.url).searchParams.get('limit') ?? 50) || 50));
    const { results } = await who.db
        .prepare(`SELECT ${LIST_COLUMNS} FROM runs WHERE owner = ? ORDER BY created_at DESC LIMIT ?`)
        .bind(who.owner.id, limit)
        .all();

    return ok({ runs: results });
};

interface RunBody {
    id: string;
    label: string;
    createdAt: number;
    appBuild?: string;
    ident?: string;
    masterFlavour?: string;
    masterCrc?: string;
    masterCrcValid?: boolean;
    slaveFlavour?: string;
    slaveCrc?: string;
    slaveCrcValid?: boolean;
    /** Whether the seed/key exchange was accepted. Everything read after it depends on the answer. */
    loggedIn?: boolean;
    /** Whether the two capture passes agreed with each other. */
    verified?: boolean;
    differingCount?: number;
    /** Whether 0x4000-0x4017 came back entirely 0xFF, as the firmware's read handler should make it. */
    censoredBlank?: boolean;
    elapsedSeconds?: number;
    wentHidden?: boolean;
    userAgent?: string;
    note?: string;
    /** base64 of gzipped bytes. JSON cannot carry bytes and multipart buys nothing here. */
    imageGz: string;
    logGz?: string | null;
}

const flag = (v: boolean | undefined) => (v === undefined ? null : v ? 1 : 0);

/**
 * Idempotent on the run's own id, for its own owner: re-uploading replaces.
 *
 * That is the behaviour a phone with two bars of signal in a garage needs. A retry that created a
 * second row would turn one session into two, and the pair would disagree about nothing while
 * looking like independent evidence.
 *
 * The replace only happens when the existing row is this owner's. An id someone else already holds
 * is a 409, never an overwrite: the upsert's `WHERE runs.owner = excluded.owner` makes the update a
 * no-op in that case, and `meta.changes` is how the handler finds out.
 */
export const onRequestPost: PagesFunction<Env> = async ({ request, env, data }) => {
    const who = ownerAndDb(data, env);
    if (who instanceof Response) return who;

    let body: RunBody;
    try {
        body = await request.json<RunBody>();
    } catch {
        return bad('Body is not JSON.');
    }

    if (!isId(body.id) || !body.label || !body.imageGz) {
        return bad('id, label and imageGz are all required.');
    }
    if (!Number.isFinite(body.createdAt)) return bad('createdAt must be a number.');

    const parts: { name: string; b64: string | null | undefined }[] = [
        { name: 'imageGz', b64: body.imageGz },
        { name: 'logGz', b64: body.logGz },
    ];
    const blobs: Record<string, Uint8Array | null> = {};
    for (const part of parts) {
        if (!part.b64) { blobs[part.name] = null; continue; }
        let bytes: Uint8Array;
        try { bytes = decodeBase64(part.b64); } catch { return bad(`${part.name} is not valid base64.`); }
        if (!isGzip(bytes)) return bad(`${part.name} is not gzip data.`);
        // Checked before the insert rather than caught after it: D1's own error for an oversized
        // value is generic, and the useful answer - which part, how far over - is only available
        // here. Each part has its own budget, which is why they are two columns and not one.
        if (bytes.byteLength > MAX_GZ_BYTES) {
            return json({ error: 'too_large', part: part.name, bytes: bytes.byteLength, limit: MAX_GZ_BYTES }, 413);
        }
        blobs[part.name] = bytes;
    }

    const values = [
        body.id,
        who.owner.id,
        Math.trunc(body.createdAt),
        Date.now(),
        body.label,
        body.appBuild ?? null,
        body.ident ?? null,
        body.masterFlavour ?? null,
        body.masterCrc ?? null,
        flag(body.masterCrcValid),
        body.slaveFlavour ?? null,
        body.slaveCrc ?? null,
        flag(body.slaveCrcValid),
        flag(body.loggedIn),
        flag(body.verified),
        body.differingCount ?? null,
        flag(body.censoredBlank),
        body.elapsedSeconds ?? null,
        flag(body.wentHidden),
        body.userAgent ?? null,
        body.note ?? null,
        blobs.imageGz ?? null,
        blobs.logGz ?? null,
    ];
    // The row as a whole, not only each blob: D1 refuses a row over 2 MB and says so only as a 500.
    const bytes = rowBytes(values);
    if (bytes > MAX_ROW_BYTES) return tooLarge(bytes);

    const result = await who.db.prepare(`
        INSERT INTO runs (
            id, owner, created_at, uploaded_at, label, app_build, ident,
            master_flavour, master_crc, master_crc_valid,
            slave_flavour, slave_crc, slave_crc_valid,
            logged_in, verified, differing_count, censored_blank,
            elapsed_seconds, went_hidden, user_agent, note, image_gz, log_gz
        ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23)
        ON CONFLICT(id) DO UPDATE SET
            uploaded_at = excluded.uploaded_at,
            label = excluded.label,
            app_build = excluded.app_build,
            ident = excluded.ident,
            master_flavour = excluded.master_flavour,
            master_crc = excluded.master_crc,
            master_crc_valid = excluded.master_crc_valid,
            slave_flavour = excluded.slave_flavour,
            slave_crc = excluded.slave_crc,
            slave_crc_valid = excluded.slave_crc_valid,
            logged_in = excluded.logged_in,
            verified = excluded.verified,
            differing_count = excluded.differing_count,
            censored_blank = excluded.censored_blank,
            elapsed_seconds = excluded.elapsed_seconds,
            went_hidden = excluded.went_hidden,
            user_agent = excluded.user_agent,
            note = excluded.note,
            image_gz = excluded.image_gz,
            log_gz = excluded.log_gz
        WHERE runs.owner = excluded.owner
    `).bind(...values).run();

    if (!result.meta.changes) return conflict();

    return ok({
        id: body.id,
        imageBytes: blobs.imageGz?.byteLength ?? 0,
        logBytes: blobs.logGz?.byteLength ?? 0,
    });
};

