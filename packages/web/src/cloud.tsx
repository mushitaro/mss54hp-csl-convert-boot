/**
 * The SYNC panel: what this owner has saved, which account it is saved to, and the way back in
 * when the sign-in has lapsed. Preview build only - App renders it behind `canSync()`.
 *
 * It sits on the LINK screen and nowhere else. That is the one screen where nothing is connected
 * and nothing is running, which is exactly when leaving the page (to sign in again) or opening a
 * file costs nothing, and it keeps the wizard's other screens about the car.
 *
 * Built from the same atoms as the steps: a `bg-slate-900` block, tiny uppercase labels, mono for
 * everything that came from a machine (times, idents, the account), neutral grey for controls
 * that describe no machine state.
 *
 * The preview's other surfaces live here too, behind the same bit: PRIVACY, and the notice of what
 * the preview sends, shown on its first launch before anything else (`PreviewNotice`).
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { Check, ExternalLink, Shield } from 'lucide-react';
import type { CloudDiagnostic, CloudRun } from './sync';
import { TripleSlash } from './components';
import { lang, t } from './copy';

export interface CloudPanelProps {
    /** The account label from the gate (`#XXXX`), or null while it is not known. */
    account: string | null;
    /** The gate says this browser's session has lapsed. */
    expired: boolean;
    /** Offered only when it is safe to leave the page; null otherwise. */
    onReauth: (() => void) | null;
    runs: readonly CloudRun[] | null;
    errors: readonly CloudDiagnostic[] | null;
    loading: boolean;
    failed: boolean;
    /** The id a request is in flight for; its row's controls are inert until it lands. */
    pending: string | null;
    onImage: (run: CloudRun) => void;
    onLog: (run: CloudRun) => void;
    onDeleteRun: (run: CloudRun) => void;
    onErrorLog: (record: CloudDiagnostic) => void;
    onDeleteError: (record: CloudDiagnostic) => void;
}

/** Where the preview's privacy text is, in the reader's language. Always a new tab: see PrivacyLink. */
export function privacyHref(): string {
    return lang() === 'ja'
        ? 'https://m3.tsunagi.app/privacy-policy#preview'
        : 'https://m3.tsunagi.app/en/privacy-policy#preview';
}

/** A time as a person reads it on a phone, local, to the minute. */
export function when(ms: number): string {
    return new Date(ms).toLocaleString('sv-SE', {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
}

export function CloudPanel(props: CloudPanelProps): ReactNode {
    const c = t();
    const { runs, errors } = props;
    return (
        <div className="px-4 pb-4">
            <div className="rounded-lg bg-slate-900 p-3">
                <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[9px] font-bold tracking-widest uppercase text-slate-400">SYNC</span>
                    <span className="min-w-0 truncate font-mono text-[9px] text-slate-500 selectable">
                        {c.syncAccount(props.account)}
                    </span>
                </div>
                <p className="mt-2 text-[10px] leading-[1.5] text-slate-500">{c.syncBody}</p>

                {props.expired && (
                    <div className="mt-2 flex items-center justify-between gap-2">
                        <p className="text-[10px] leading-[1.5] text-amber-400">{c.syncExpired}</p>
                        {props.onReauth && <RowAction label={c.syncReauth} onClick={props.onReauth} />}
                    </div>
                )}

                <Section label={c.syncRuns}>
                    {runs === null
                        ? <Quiet>{props.failed ? c.syncLoadFailed : props.loading ? c.syncLoading : ''}</Quiet>
                        : runs.length === 0
                            ? <Quiet>{c.syncEmpty}</Quiet>
                            : runs.map((run) => (
                                <Row
                                    key={run.id}
                                    time={when(run.created_at)}
                                    title={run.ident ?? run.label}
                                    tone={run.verified === 1 ? 'ok' : 'warn'}
                                    detail={`${run.verified === 1 ? 'VERIFIED' : 'UNVERIFIED'}`
                                        + `${(run.note ?? '').startsWith('PRACTICE') ? ` · ${c.syncPractice}` : ''}`
                                        + `${run.image_bytes ? ` · ${Math.round(run.image_bytes / 1024)} KB` : ''}`}
                                >
                                    <RowAction label="IMAGE" disabled={props.pending !== null} onClick={() => props.onImage(run)} />
                                    <RowAction label="LOG" disabled={props.pending !== null || !run.log_bytes} onClick={() => props.onLog(run)} />
                                    <RowAction label="DELETE" tone="danger" disabled={props.pending !== null} onClick={() => props.onDeleteRun(run)} />
                                </Row>
                            ))}
                </Section>

                <Section label={c.syncErrors}>
                    {errors === null
                        ? <Quiet>{props.failed ? c.syncLoadFailed : props.loading ? c.syncLoading : ''}</Quiet>
                        : errors.length === 0
                            ? <Quiet>{c.syncEmpty}</Quiet>
                            : errors.map((record) => (
                                <Row
                                    key={record.id}
                                    time={when(record.created_at)}
                                    title={record.stage}
                                    tone="bad"
                                    detail={`${record.practice === 1 ? `${c.syncPractice} · ` : ''}${record.error}`}
                                >
                                    <RowAction label="LOG" disabled={props.pending !== null || !record.log_bytes} onClick={() => props.onErrorLog(record)} />
                                    <RowAction label="DELETE" tone="danger" disabled={props.pending !== null} onClick={() => props.onDeleteError(record)} />
                                </Row>
                            ))}
                </Section>

                <div className="mt-2 flex justify-end">
                    <PrivacyLink />
                </div>
            </div>
        </div>
    );
}

/**
 * PRIVACY, to the preview's section of the policy.
 *
 * A new tab without exception: a same-tab navigation would drop the cable and whatever has been
 * read over it. Neutral grey - it describes no machine state, so it borrows no meaningful colour.
 */
export function PrivacyLink(): ReactNode {
    return (
        <a
            href={privacyHref()}
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-h-[44px] items-center px-2 text-[9px] font-bold uppercase tracking-widest text-slate-500 active:text-slate-300"
        >
            {t().privacy}
        </a>
    );
}

/**
 * The same PRIVACY, as the header carries it: the first of tsunagi-m-chrome's fixed links (this app
 * has only that one - no repository link, credits or guide of its own, and no menu sheet, since the
 * whole app is the phone layout). An icon at w-5 h-5 with its destination in `title`, neutral grey,
 * inside a 44 px tap target.
 *
 * It is in the header so that it is reachable from every screen and with the cable in, not only
 * from the SYNC panel on the LINK screen. That is safe while connected for the reason PrivacyLink
 * gives: it always opens a new tab. Preview build only - App renders it behind `canSync()`, the same
 * bit as the SYNC it describes.
 */
export function PrivacyHeaderLink(): ReactNode {
    const label = t().privacy;
    return (
        <a
            href={privacyHref()}
            target="_blank"
            rel="noopener noreferrer"
            title={label}
            aria-label={label}
            className="-mx-3 flex h-[44px] w-[44px] shrink-0 items-center justify-center text-slate-500 transition-colors hover:text-slate-300 active:text-slate-300"
        >
            <Shield className="h-5 w-5" aria-hidden="true" />
        </a>
    );
}

/**
 * What the preview sends, and why - on its first launch, before it sends any of it.
 *
 * m3's notice, word for word (copy.ts). It used to be a page on m3 that a first visit passed
 * through; it is here now, as TUNER's disclaimer is, so the code that sends is the code that says
 * what it sends. Whether it is shown, and what waits until it is confirmed, is previewNotice.ts;
 * App renders it only in the preview, over an app it has made `inert`.
 *
 * One way on: the button. No close control, no Escape, and the scrim closes nothing. The notice asks
 * for nothing but reading - and a dialog that goes away without its button goes away unread.
 *
 * Laid out for the phone the app runs on. The frame is capped to the screen with a 16 px gutter and
 * only its middle scrolls, so the button stays on screen however long the text runs: full width, at
 * the bottom of the frame where the thumb already is, 48 px tall. The geometry rule is TUNER's gate's
 * - if this does not fit, the app does not open.
 */
export function PreviewNotice({ onConfirm }: { onConfirm: () => void }): ReactNode {
    const c = t();
    const frame = useRef<HTMLDivElement>(null);
    // Into the dialog, so a screen reader starts at its title and Tab starts inside it. The app
    // behind is `inert`, so there is nowhere else for focus to be.
    useEffect(() => { frame.current?.focus(); }, []);
    return (
        <>
            {/* No onClick: it takes every touch and closes nothing. Blurred only on a wide screen - on
                a phone a full-screen backdrop-filter costs about a second of paint. */}
            <div aria-hidden="true" className="fixed inset-0 z-[100] bg-slate-950/70 min-[900px]:backdrop-blur-sm" />
            <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
                <div
                    ref={frame}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="preview-notice-title"
                    aria-describedby="preview-notice-lead"
                    lang={lang()}
                    tabIndex={-1}
                    className="flex max-h-full w-full max-w-[398px] flex-col rounded-lg border border-slate-700 bg-slate-900 shadow-xl outline-none"
                >
                    {/* The app's own name heads it: the header it would otherwise read is under the
                        scrim, and this is the first thing a new owner sees of the app. */}
                    <div className="flex shrink-0 items-center gap-2 border-b border-slate-800 px-4 py-3">
                        <Shield className="h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden="true" />
                        <h2
                            id="preview-notice-title"
                            className="text-[11px] font-bold uppercase leading-[1.4] tracking-wide text-slate-200"
                        >
                            MSS54HP CSL CONVERT{' '}
                            <TripleSlash />{' '}
                            <span className="text-slate-400">BOOT — PREVIEW</span>
                        </h2>
                    </div>

                    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pt-4 pb-1">
                        <p id="preview-notice-lead" className="text-[11px] leading-[1.6] text-slate-300">
                            {c.noticeLead}
                        </p>

                        {/* What leaves the phone, each in its own well: the two things this notice
                            is about, findable at a glance before any of the rest is read. */}
                        <dl className="space-y-2">
                            <Sent title={c.noticeSessionsTitle} what={c.noticeSessions} goes={c.noticeSessionsWhen} />
                            <Sent title={c.noticeRecordsTitle} what={c.noticeRecords} goes={c.noticeRecordsWhen} />
                        </dl>
                        <p className="text-[10px] leading-[1.6] text-slate-500">{c.noticeAlsoSent}</p>

                        <dl className="space-y-3">
                            <Term title={c.noticePurposeTitle}>{c.noticePurpose}</Term>
                            <Term title={c.noticeWhereTitle}>{c.noticeWhere}</Term>
                            <Term title={c.noticeDeleteTitle}>{c.noticeDelete}</Term>
                        </dl>

                        {/* A new tab, like every PRIVACY link here: see PrivacyLink. */}
                        <p>
                            <a
                                href={privacyHref()}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex min-h-[44px] items-center gap-1 text-[11px] text-blue-400 underline underline-offset-2 active:text-blue-300"
                            >
                                {c.noticePolicy}
                                <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
                            </a>
                        </p>
                    </div>

                    <div className="shrink-0 border-t border-slate-800 p-3">
                        <button
                            type="button"
                            onClick={onConfirm}
                            className="flex h-12 w-full items-center justify-center gap-1.5 rounded-lg bg-blue-600 text-[11px] font-bold uppercase tracking-widest text-slate-100 transition-colors hover:bg-blue-500 active:bg-blue-500"
                        >
                            <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            {c.noticeConfirm}
                        </button>
                    </div>
                </div>
            </div>
        </>
    );
}

/** One kind of thing the preview sends: what it is, then when it goes. */
function Sent({ title, what, goes }: { title: string; what: string; goes: string }): ReactNode {
    return (
        <div className="rounded-lg bg-slate-950 p-3">
            <dt className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{title}</dt>
            <dd className="mt-1.5 text-[11px] leading-[1.6] text-slate-300">{what}</dd>
            <dd className="mt-1 text-[10px] leading-[1.6] text-slate-500">{goes}</dd>
        </div>
    );
}

function Term({ title, children }: { title: string; children: ReactNode }): ReactNode {
    return (
        <div>
            <dt className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{title}</dt>
            <dd className="mt-1 text-[11px] leading-[1.6] text-slate-400">{children}</dd>
        </div>
    );
}

function Section({ label, children }: { label: string; children: ReactNode }): ReactNode {
    return (
        <div className="mt-3">
            <span className="text-[8px] font-mono uppercase tracking-wider text-slate-600 leading-none">{label}</span>
            <div className="mt-1 divide-y divide-slate-800">{children}</div>
        </div>
    );
}

function Quiet({ children }: { children: ReactNode }): ReactNode {
    return <p className="py-2 text-[10px] leading-[1.5] text-slate-600">{children}</p>;
}

function Row(
    { time, title, detail, tone, children }:
    { time: string; title: string; detail: string; tone: 'ok' | 'warn' | 'bad'; children: ReactNode },
): ReactNode {
    const paint = tone === 'ok' ? 'text-emerald-400' : tone === 'warn' ? 'text-amber-400' : 'text-red-400';
    return (
        <div className="flex items-center gap-2 py-1">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-mono text-[9px] leading-none text-slate-500 selectable">{time}</span>
                <span className="truncate font-mono text-[10px] font-bold leading-tight text-slate-300 selectable">{title}</span>
                <span className={`line-clamp-2 font-mono text-[9px] leading-[1.4] selectable ${paint}`}>{detail}</span>
            </div>
            <div className="flex shrink-0 items-center">{children}</div>
        </div>
    );
}

/** A 44px-tall control in a row. The label is small; the padding is what makes it tappable. */
function RowAction(
    { label, onClick, tone = 'default', disabled }:
    { label: string; onClick: () => void; tone?: 'default' | 'danger'; disabled?: boolean },
): ReactNode {
    const paint = disabled ? 'text-slate-700'
        : tone === 'danger' ? 'text-slate-600 active:text-red-400' : 'text-slate-400 active:text-blue-400';
    return (
        <button
            type="button"
            onClick={disabled ? undefined : onClick}
            disabled={disabled}
            className={`min-h-[44px] px-2 text-[9px] font-bold uppercase tracking-widest transition ${paint}`}
        >
            {label}
        </button>
    );
}
