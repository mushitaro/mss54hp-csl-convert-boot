/**
 * Any /api/* path no handler owns: 404, as JSON.
 *
 * Without this, Pages answers an unknown path with the SPA fallback — the app's index.html, 200 —
 * and a client asking an API that does not exist would be handed a page, which it then fails to
 * parse as data. The gate has already run by the time this is reached, so it answers only a
 * signed-in owner; the answer is the same either way.
 */
import { bad } from '../_shared';

export const onRequest: PagesFunction = () => bad('not_found', 404);
