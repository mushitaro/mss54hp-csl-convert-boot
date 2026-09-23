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
 */
import type { ReactNode } from 'react';
import type { CloudDiagnostic, CloudRun } from './sync';
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
