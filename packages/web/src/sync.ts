/**
 * The preview's SYNC: the owner's saved runs, and the error records the app sends by itself.
 *
 * ## Only the preview build talks to anything
 *
 * `canSync` is the variant and nothing else: `app-variant="preview"`, written by the build. The
 * production build has no such meta, so every function here returns before it makes a request -
 * production sends nothing anywhere, and the privacy policy says so. There is no token and no
 * setting; the owner gate's cookie is what identifies the owner (owner-sync.ts).
 *
 * ## Runs are sent on purpose; failures are sent by themselves
 *
 * A run carries a capture - the VIN, the AIF and the flash counter of one car - and leaves the
 * phone only when the owner taps UPLOAD (upload.ts). An error record is the opposite case: it is
 * worth something only if it is taken at the moment of failure, it is small, and nobody presses a
 * button for it. So `recordDiagnostic` is automatic, silent and best-effort. It never throws into
 * the operation it describes, and a record that cannot be sent (no signal, an expired session) is
 * kept in a small outbox and sent after the next send that works.
 *
 * ## There is no local store of captures
 *
 * The app keeps a capture in memory for the session and hands it to the operator as a file; it
 * has never kept one on the device. So "restore" here is the same thing: the saved image comes
 * back as a `.bin`, which the BACKUP step's compare-with-a-file mode takes as it is.
 */
import { api, gateStatus, isPreviewBuild, outbox, type ApiResult, type GateState } from './owner-sync';
import { BUILD_ID } from './pwa';

export { gateStatus, reauthHref, type GateState } from './owner-sync';

/** Whether this build syncs at all. Read once per call; the meta cannot change under a page. */
export function canSync(): boolean {
    return isPreviewBuild();
}

/** One saved run, as the listing describes it - without its bytes. */
export interface CloudRun {
    id: string;
    created_at: number;
    uploaded_at: number;
    label: string;
    ident: string | null;
    verified: number | null;
    differing_count: number | null;
    note: string | null;
    app_build: string | null;
    image_bytes: number | null;
    log_bytes: number | null;
}

/** One error record, as the listing describes it - without its log. */
export interface CloudDiagnostic {
    id: string;
    created_at: number;
    stage: string;
    error: string;
    practice: number | null;
    app_build: string | null;
    log_bytes: number | null;
}

const NOT_SYNCING: ApiResult<never> = { ok: false, status: 0, data: null, expired: false, tooLarge: false };

/**
 * A SYNC request the server answered with something other than success, carrying the status so
 * the caller can tell a lapsed sign-in (401 - offer SIGN IN) from anything else (say what failed).
 */
export class SyncRequestError extends Error {
    readonly status: number;
    constructor(what: string, status: number) {
        super(`${what}: ${status}`);
        this.name = 'SyncRequestError';
        this.status = status;
    }
    /** The gate refused: this browser's session has lapsed. */
    get expired(): boolean {
        return this.status === 401;
    }
}

export async function listRuns(): Promise<ApiResult<{ runs: CloudRun[] }>> {
    if (!canSync()) return NOT_SYNCING;
    return api<{ runs: CloudRun[] }>('/api/runs?limit=50');
}

export async function listDiagnostics(): Promise<ApiResult<{ diagnostics: CloudDiagnostic[] }>> {
    if (!canSync()) return NOT_SYNCING;
    return api<{ diagnostics: CloudDiagnostic[] }>('/api/diagnostics?limit=50');
}

export async function deleteRun(id: string): Promise<ApiResult<unknown>> {
    if (!canSync()) return NOT_SYNCING;
    return api(`/api/runs/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function deleteDiagnostic(id: string): Promise<ApiResult<unknown>> {
    if (!canSync()) return NOT_SYNCING;
    return api(`/api/diagnostics/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * A saved run's image or log, as the bytes that were captured.
 *
 * The server hands back the gzip it stored; it is inflated here, so what the operator gets is the
 * 1 MiB `.bin` - the same file a capture on this phone would have produced - and not a `.gz` that a
 * phone has nothing to open with.
 */
export async function fetchRunPart(id: string, part: 'image' | 'log'): Promise<Uint8Array> {
    if (!canSync()) throw new Error('This build does not sync.');
    const response = await fetch(`/api/runs/${encodeURIComponent(id)}?part=${part}`, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new SyncRequestError(part, response.status);
    const stream = (response.body ?? new Blob([]).stream()).pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A saved error record's log, as text. */
export async function fetchDiagnosticLog(id: string): Promise<string> {
    if (!canSync()) throw new Error('This build does not sync.');
    const r = await api<{ diagnostic: { log_excerpt: string | null } }>(`/api/diagnostics/${encodeURIComponent(id)}`);
    if (!r.ok || !r.data) throw new SyncRequestError('log', r.status);
    return r.data.diagnostic.log_excerpt ?? '';
}

/** The same stamp shape the app's own files use, marked as having come back from the cloud. */
export function cloudFilename(run: Pick<CloudRun, 'created_at' | 'verified' | 'note'>, part: 'image' | 'log'): string {
    const stamp = new Date(run.created_at).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const practice = (run.note ?? '').startsWith('PRACTICE');
    const outcome = run.verified === 1 ? 'verified' : 'UNVERIFIED';
    return part === 'image'
        ? `${practice ? 'PRACTICE_NOT-A-CAR_' : ''}MSS54HP_cloud_${outcome}_${stamp}.bin`
        : `${practice ? 'PRACTICE_NOT-A-CAR_' : ''}MSS54HP_cloud_log_${stamp}.txt`;
}

// --- error records -------------------------------------------------------------------------

export interface DiagnosticInput {
    /** Which operation failed, named by the caller - a record with no report still has a stage. */
    stage: string;
    error: string;
    /** The event log as it stood; the tail is kept. */
    log: readonly string[];
    practice: boolean;
    ident?: string | undefined;
}

/** How much of the event log a record carries. The failure is at the end of it. */
const LOG_TAIL = 200;

const box = outbox('boot-outbox');

/** The build as the page names it: `<meta name="build-id">`, which carries the source sha. */
function buildIdentity(): string {
    if (typeof document === 'undefined') return BUILD_ID;
    return document.querySelector('meta[name="build-id"]')?.getAttribute('content') || BUILD_ID;
}

function newId(): string {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return `d${Date.now().toString(36)}${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Whether the outbox is done with a record after this answer: sent, or refused for good
 * (malformed, too large, an id clash). Not done when trying later could work - no network, a
 * lapsed session, the server or m3 unavailable - so it waits.
 */
function settled(r: ApiResult<unknown>): boolean {
    if (r.ok) return true;
    return r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 408 && r.status !== 429;
}

const send = async (record: unknown): Promise<boolean> =>
    settled(await api('/api/diagnostics', { method: 'POST', body: record }));

/**
 * Record a failure. Returns at once; never throws; does nothing outside the preview build.
 *
 * The record is sent now if it can be, and after it anything the outbox was holding, oldest first.
 * If it cannot be, it joins the outbox (newest twenty kept).
 */
export function recordDiagnostic(input: DiagnosticInput): void {
    if (!canSync()) return;
    const record = {
        id: newId(),
        createdAt: Date.now(),
        stage: input.stage,
        error: input.error,
        log: input.log.slice(-LOG_TAIL).join('\n'),
        appBuild: buildIdentity(),
        practice: input.practice,
        ident: input.ident,
        userAgent: typeof navigator === 'undefined' ? undefined : navigator.userAgent,
    };
    void (async () => {
        try {
            const r = await api('/api/diagnostics', { method: 'POST', body: record });
            if (r.ok) await box.flush(send);
            else if (!settled(r)) await box.add(record);
        } catch {
            // Losing a record is better than breaking the operation it describes.
        }
    })();
}

/** Send whatever is waiting. Called after any sync request that worked. Never throws. */
export function flushDiagnostics(): void {
    if (!canSync()) return;
    void box.flush(send).catch(() => {});
}

/** The gate's view of this browser, or `unknown` outside the preview (which never asks). */
export async function currentGate(): Promise<{ state: GateState; label: string | null }> {
    if (!canSync()) return { state: 'unknown', label: null };
    return gateStatus();
}
