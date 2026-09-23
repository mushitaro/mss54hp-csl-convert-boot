/**
 * GET    /api/diagnostics/:id - one of the owner's error records, with its log.
 * DELETE /api/diagnostics/:id - remove it.
 *
 * Same rule as the runs: another owner's id answers exactly like one that does not exist.
 */
import { Env, bad, isId, ok, ownerAndDb } from '../../_shared';

export const onRequestGet: PagesFunction<Env> = async ({ env, params, data }) => {
    const who = ownerAndDb(data, env);
    if (who instanceof Response) return who;

    const id = String(params.id ?? '');
    if (!isId(id)) return bad('No such record.', 404);

    const row = await who.db
        .prepare(`SELECT id, created_at, received_at, stage, error, log_excerpt, app_build, practice,
                         ident, run_id, user_agent
                  FROM diagnostics WHERE id = ? AND owner = ?`)
        .bind(id, who.owner.id)
        .first<Record<string, unknown>>();
    if (!row) return bad('No such record.', 404);
    return ok({ diagnostic: row });
};

export const onRequestDelete: PagesFunction<Env> = async ({ env, params, data }) => {
    const who = ownerAndDb(data, env);
    if (who instanceof Response) return who;

    const id = String(params.id ?? '');
    if (!isId(id)) return bad('No such record.', 404);

    const result = await who.db
        .prepare('DELETE FROM diagnostics WHERE id = ? AND owner = ?')
        .bind(id, who.owner.id)
        .run();
    if (!result.meta.changes) return bad('No such record.', 404);
    return ok({ id, deleted: true });
};
