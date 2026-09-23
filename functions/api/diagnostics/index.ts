/**
 * POST /api/diagnostics - store one error record for the signed-in owner.
 * GET  /api/diagnostics - list that owner's records, newest first, without their logs.
 *
 * ## Why this is not a run
 *
 * A run needs a capture, and the failures most worth reading happen before one exists: a refused
 * login, a cable that never opened, a pass that died at 40%. Those used to leave nothing but a log
 * the operator could save by hand - on a phone, in a garage, just after something went wrong, which
 * is when nobody does. So the app sends a record of every failure by itself, and this is where it
 * lands: which stage, what the error said, the tail of the event log, and what build and mode it
 * happened in.
 *
 * The app sends these without being asked and retries them from a local outbox, so the same record
 * can arrive twice; its id is the client's, and a second arrival replaces the first.
 */
import { MAX_ROW_BYTES, conflict, rowBytes, tooLarge } from '../../_owner-gate/owner';
import { Env, bad, isId, ok, ownerAndDb } from '../../_shared';

/** Everything but the log, which is the only large column. */
const LIST_COLUMNS = `
    id, created_at, received_at, stage, error, app_build, practice, ident, run_id, user_agent,
    length(log_excerpt) AS log_bytes
`;

export const onRequestGet: PagesFunction<Env> = async ({ request, env, data }) => {
    const who = ownerAndDb(data, env);
    if (who instanceof Response) return who;

    const limit = Math.min(200, Math.max(1, Number(new URL(request.url).searchParams.get('limit') ?? 50) || 50));
    const { results } = await who.db
        .prepare(`SELECT ${LIST_COLUMNS} FROM diagnostics WHERE owner = ? ORDER BY created_at DESC LIMIT ?`)
        .bind(who.owner.id, limit)
        .all();
    return ok({ diagnostics: results });
};

interface DiagnosticBody {
    id: string;
    /** When it happened, on the phone. `received_at` is when it got here - often much later. */
    createdAt: number;
    /** Which operation failed, as the caller names it (CONNECT, IDENT, BACKUP, VERIFY, RUN ...). */
    stage: string;
    error: string;
    /** The last lines of the event log at the moment of failure. */
    log?: string;
    appBuild?: string;
    /** PRACTICE: the failure was against the simulator, not a car. Mixed in unmarked, it misleads. */
    practice?: boolean;
    ident?: string;
    /** The uploaded run this belongs to, when there was one. */
    runId?: string;
    userAgent?: string;
}

/** Cut rather than refused: a record that is merely long is still worth having. */
const clip = (v: unknown, n: number): string | null => (typeof v === 'string' && v.length > 0 ? v.slice(0, n) : null);

export const onRequestPost: PagesFunction<Env> = async ({ request, env, data }) => {
    const who = ownerAndDb(data, env);
    if (who instanceof Response) return who;

    let body: DiagnosticBody;
    try {
        body = await request.json<DiagnosticBody>();
    } catch {
        return bad('Body is not JSON.');
    }
    if (!isId(body.id)) return bad('id is required.');
    if (!Number.isFinite(body.createdAt)) return bad('createdAt must be a number.');
    const stage = clip(body.stage, 40);
    const error = clip(body.error, 4000);
    if (!stage || !error) return bad('stage and error are both required.');

    const values = [
        body.id,
        who.owner.id,
        Math.trunc(body.createdAt),
        Date.now(),
        stage,
        error,
        clip(body.log, 1_000_000),
        clip(body.appBuild, 80),
        body.practice === undefined ? null : body.practice ? 1 : 0,
        clip(body.ident, 200),
        isId(body.runId) ? body.runId : null,
        clip(body.userAgent, 400),
    ];
    const bytes = rowBytes(values);
    if (bytes > MAX_ROW_BYTES) return tooLarge(bytes);

    const result = await who.db.prepare(`
        INSERT INTO diagnostics (
            id, owner, created_at, received_at, stage, error, log_excerpt,
            app_build, practice, ident, run_id, user_agent
        ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
        ON CONFLICT(id) DO UPDATE SET
            received_at = excluded.received_at,
            stage = excluded.stage,
            error = excluded.error,
            log_excerpt = excluded.log_excerpt,
            app_build = excluded.app_build,
            practice = excluded.practice,
            ident = excluded.ident,
            run_id = excluded.run_id,
            user_agent = excluded.user_agent
        WHERE diagnostics.owner = excluded.owner
    `).bind(...values).run();

    if (!result.meta.changes) return conflict();
    return ok({ id: body.id });
};
