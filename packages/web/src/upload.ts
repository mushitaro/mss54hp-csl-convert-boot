/**
 * Sending a real-car session to the project's own D1, for judging afterwards.
 *
 * ## Why this exists, and why it is not part of the job
 *
 * A session against a real DME happens in a garage, on a phone, and produces a 1 MiB capture plus a
 * log that together are the only evidence of what the ECU actually did. Reading them at a desk is
 * how the questions that matter get answered - did the linear read segments work, did the firmware
 * really blank the censored range, did the two passes agree. Getting them off the phone by hand is
 * where that evidence gets lost.
 *
 * It is a test instrument, not a step of the conversion. Nothing in the flash sequence depends on
 * it, and no failure here can fail a session.
 *
 * ## It is explicit, and it is the owner's
 *
 * A capture carries the VIN, the AIF and the flash counter of a specific car. It leaves the phone
 * only when someone taps UPLOAD - never as a side effect of finishing a backup. Only the preview
 * build offers that control; the production build sends nothing anywhere.
 *
 * There is no token. The preview is served behind the owner gate, which put a session cookie on
 * this origin when the owner arrived from m3, and the request below is same-origin, so the browser
 * sends it. The server files the run under that account and no other.
 */

/** Where the run went, and how big it was once compressed. */
export interface UploadResult {
    readonly id: string;
    readonly imageBytes: number;
    readonly logBytes: number;
}

export interface RunFacts {
    readonly label: string;
    readonly createdAt: number;
    readonly appBuild?: string;
    readonly ident?: string;
    readonly masterFlavour?: string;
    readonly masterCrc?: string;
    readonly masterCrcValid?: boolean;
    readonly slaveFlavour?: string;
    readonly slaveCrc?: string;
    readonly slaveCrcValid?: boolean;
    readonly loggedIn?: boolean;
    readonly verified?: boolean;
    readonly differingCount?: number;
    readonly censoredBlank?: boolean;
    readonly elapsedSeconds?: number;
    readonly wentHidden?: boolean;
    readonly note?: string;
}

/** A refusal from the server, with the two cases the screen words differently kept apart. */
export class UploadError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
        this.name = 'UploadError';
    }
    /** 401: the owner's session has gone. The capture is still on this phone. */
    get expired(): boolean { return this.status === 401; }
    /** 413: the row would be more than the database takes. Sending again will not change that. */
    get tooLarge(): boolean { return this.status === 413; }
}

/** Whether the browser can compress at all. Without it there is nothing to send. */
export function uploadSupported(): boolean {
    return typeof CompressionStream !== 'undefined';
}

/**
 * gzip, in the browser.
 *
 * The capture is 1 MiB and gzips to about a fifth of that on a real image - most of the saving is
 * the erased 0xFF areas. Sending it uncompressed would be five times the bytes over a garage's
 * signal, and D1 would refuse the row.
 */
async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * base64 in 32 KiB slices.
 *
 * `String.fromCharCode(...bytes)` throws on an argument list this long - the compressed capture is
 * over 200 KB - and the failure is a stack overflow rather than anything that names the cause.
 */
function base64(bytes: Uint8Array): string {
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

/**
 * Send one run.
 *
 * Same origin as the app, which is the whole reason the endpoint lives on Pages rather than
 * somewhere else: no CORS preflight on a phone with two bars of signal in a garage, and the gate's
 * cookie goes with it without any code here touching a credential.
 */
export async function uploadRun(
    image: Uint8Array,
    log: readonly string[],
    facts: RunFacts,
): Promise<UploadResult> {
    if (!uploadSupported()) throw new Error('This browser cannot gzip, so there is nothing to send.');

    const [imageGz, logGz] = await Promise.all([
        gzip(image),
        gzip(new TextEncoder().encode(log.join('\n'))),
    ]);

    const response = await fetch('/api/runs', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            ...facts,
            id: runId(facts),
            userAgent: typeof navigator === 'undefined' ? undefined : navigator.userAgent,
            imageGz: base64(imageGz),
            logGz: base64(logGz),
        }),
    });
    if (response.ok) return await response.json() as UploadResult;

    const detail = await response.json().catch(() => ({})) as { error?: string };
    throw new UploadError(detail.error ?? `Upload failed (${response.status}).`, response.status);
}

/**
 * A stable id from the label and the timestamp.
 *
 * Stable so a retry replaces rather than duplicates - a phone in a garage retries, and two rows
 * from one session would look like independent evidence that agrees with itself.
 */
export function runId(facts: Pick<RunFacts, 'label' | 'createdAt'>): string {
    return `${facts.createdAt}-${Math.abs(hash(facts.label + facts.createdAt)).toString(36)}`;
}

function hash(text: string): number {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
    return h;
}
