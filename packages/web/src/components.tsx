/**
 * The ///M atoms this app is built from.
 *
 * Two departures from the desktop reference, both forced by the phone and both deliberate:
 *
 *  - **Reserved slots are two lines, not one.** The system reserves a 14px line for a transient
 *    notice. At 430px a sentence explaining why a control is locked does not fit in one line, and
 *    the rule that matters more is that the reason must be *rendered* - a `title` is a mouse
 *    convenience and does not exist on a touch screen. So the slot is `h-[34px]` and the sentences
 *    are written to fit it.
 *  - **Touch targets are 44px minimum.** A `text-[10px]` button is legible and untappable; the
 *    padding around it is what makes it a control.
 *
 * Everything else follows the system: fixed heights so nothing reflows, `transition` and never
 * `transition-all`, one colour one meaning, mono for machine data and sans for chrome.
 */
import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

// -------------------------------------------------------------------------------------------
// Status LED
// -------------------------------------------------------------------------------------------

export type LinkState = 'disconnected' | 'ok' | 'busy' | 'error' | 'practice';

/**
 * The app's state language, reused verbatim from the system.
 *
 * Busy is the one that moves, and the pulse is load-bearing rather than decorative: with the
 * palette down to three hues, motion is what separates "busy" from "armed" on an 8px dot.
 */
export function Led({ state }: { state: LinkState }): ReactNode {
    // Practice is steady violet where busy is pulsing violet: the two share a hue because they are
    // both "not a finished, trustworthy state", and motion is what separates them - the same reason
    // busy pulses in the first place.
    const paint = state === 'disconnected' ? 'bg-slate-600'
        : state === 'busy' ? 'bg-amber-500 shadow-[0_0_8px_rgba(155,132,232,0.6)] animate-pulse'
            : state === 'practice' ? 'bg-amber-500 shadow-[0_0_8px_rgba(155,132,232,0.6)]'
                : state === 'error' ? 'bg-red-500 shadow-[0_0_8px_rgba(241,26,34,0.6)]'
                    : 'bg-emerald-500 shadow-[0_0_8px_rgba(143,216,242,0.6)]';
    return <div className={`w-2 h-2 rounded-full shrink-0 ${paint}`} aria-label={state} />;
}

// -------------------------------------------------------------------------------------------
// Wordmark
// -------------------------------------------------------------------------------------------

/**
 * The triple-slash in the tricolour - the mark, not punctuation.
 *
 * `tracking-wide` rather than the system's `tracking-widest`: the full name is 28 characters and
 * at 430px the widest tracking pushes BOOT off the end. The heading's authority comes from being
 * bold, uppercase and tracked at all; losing the last word to prove a point about letter-spacing
 * would be the wrong trade.
 */
export function Wordmark(): ReactNode {
    return (
        <h1 className="truncate text-[10px] font-bold uppercase tracking-wide text-slate-200">
            MSS54HP CSL CONVERT{' '}
            <TripleSlash />{' '}
            <span className="text-slate-400">BOOT</span>
        </h1>
    );
}

/**
 * The `///` itself, for wherever the app's name is drawn - the wordmark, and the preview's notice.
 *
 * One definition so the three colours cannot drift between the two. `aria-hidden`, because read
 * aloud it is "slash slash slash", which is noise.
 */
export function TripleSlash(): ReactNode {
    return (
        <span className="tracking-tight" aria-hidden="true">
            <span className="text-blue-500">/</span>
            <span className="text-indigo-400">/</span>
            <span className="text-red-500">/</span>
        </span>
    );
}

// -------------------------------------------------------------------------------------------
// Reserved notice slot
// -------------------------------------------------------------------------------------------

export type NoticeKind = 'info' | 'warn' | 'error' | 'ok';

/**
 * A transient line that lives inside a box which is always there.
 *
 * Empty or not, it occupies the same height, so a state change recolours and relabels without
 * moving anything below it. On a tool driving hardware a layout that twitches reads as
 * untrustworthy.
 */
export function Notice({ kind = 'info', children }: { kind?: NoticeKind; children?: ReactNode }): ReactNode {
    const paint = kind === 'error' ? 'text-red-400'
        : kind === 'warn' ? 'text-amber-400'
            : kind === 'ok' ? 'text-emerald-400' : 'text-slate-500';
    return (
        <div className="h-[34px] shrink-0 px-4 flex items-center">
            <p className={`text-[10px] leading-[1.35] line-clamp-2 ${paint}`}>{children}</p>
        </div>
    );
}

// -------------------------------------------------------------------------------------------
// Label + value readout
// -------------------------------------------------------------------------------------------

/** The recurring atom: a tiny uppercase label over a mono value coloured by state. */
export function Readout(
    { label, value, tone = 'default' }:
    { label: string; value: ReactNode; tone?: 'default' | 'key' | 'ok' | 'warn' | 'bad' },
): ReactNode {
    const paint = tone === 'key' ? 'text-blue-400'
        : tone === 'ok' ? 'text-emerald-400'
            : tone === 'warn' ? 'text-amber-400'
                : tone === 'bad' ? 'text-red-400' : 'text-slate-300';
    return (
        <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-[8px] font-mono uppercase tracking-wider text-slate-600 leading-none">{label}</span>
            <span className={`text-[11px] font-mono font-bold leading-none truncate selectable ${paint}`}>{value}</span>
        </div>
    );
}

// -------------------------------------------------------------------------------------------
// Choice row
// -------------------------------------------------------------------------------------------

export interface ChoiceProps {
    label: string;
    why: string;
    selected: boolean;
    onSelect: () => void;
    /** When set, the row cannot be chosen and this sentence says why - rendered, not a tooltip. */
    lockedReason?: string | undefined;
    tone?: 'primary' | 'caution';
}

/**
 * One answer to the question this step is asking.
 *
 * A locked row is dimmed, unselectable **and** shows its reason. Leaving the reason in a `title`
 * cost the reference project two complete test drives: touch has no hover, so a sentence that only
 * a mouse can reach does not exist on a phone.
 */
export function Choice({ label, why, selected, onSelect, lockedReason, tone = 'primary' }: ChoiceProps): ReactNode {
    const locked = lockedReason !== undefined;
    const accent = tone === 'caution' ? 'text-amber-400' : 'text-blue-400';
    return (
        <button
            type="button"
            onClick={locked ? undefined : onSelect}
            disabled={locked}
            aria-pressed={selected}
            className={`w-full text-left rounded-lg p-3 min-h-[56px] transition
                ${locked ? 'bg-slate-900/40 opacity-40 cursor-not-allowed'
                    : selected ? 'bg-slate-800' : 'bg-slate-900 active:bg-slate-800'}`}
        >
            <div className="flex items-center gap-2">
                <span className={`w-3 h-3 rounded-full shrink-0 border transition
                    ${selected && !locked ? 'border-blue-400 bg-blue-500' : 'border-slate-700'}`} />
                <span className={`text-[10px] font-bold tracking-widest uppercase truncate
                    ${locked ? 'text-slate-500' : selected ? accent : 'text-slate-300'}`}>{label}</span>
            </div>
            <p className="mt-1.5 pl-5 text-[10px] leading-[1.45] text-slate-500">{why}</p>
            {locked && (
                <p className="mt-1.5 pl-5 text-[10px] leading-[1.45] text-amber-400">{lockedReason}</p>
            )}
        </button>
    );
}

// -------------------------------------------------------------------------------------------
// The hub
// -------------------------------------------------------------------------------------------

export interface HubConfig {
    label: string;
    Icon: React.ComponentType<{ className?: string }>;
    onClick: () => void;
    busy?: boolean;
    disabled?: boolean;
    /** The one state that paints red: the action that cannot be undone. */
    danger?: boolean;
}

/**
 * One control, many faces, always showing the one right next action.
 *
 * Its label and handler are derived from state on every render, so the button cannot say the wrong
 * thing. Busy **disables** rather than hides it: it stays visibly the same control, occupied.
 */
export function Hub({ label, Icon, onClick, busy, disabled, danger }: HubConfig): ReactNode {
    const inert = busy || disabled;
    // Disabled beats danger, deliberately. A FLASH button that is red and glowing while it cannot
    // act reads as armed, which is the one thing this control must never lie about: the system's
    // rule is that a switch which cannot take effect must not look like it will.
    const ring = busy ? 'border-amber-500/50 animate-pulse'
        : disabled ? 'border-slate-800'
            : danger ? 'border-red-500/40' : 'border-blue-500/30';
    const face = disabled ? 'text-slate-700 border-slate-800'
        : danger ? 'text-red-400 border-red-900 active:bg-slate-800'
            : 'text-blue-500 border-slate-700 active:bg-slate-800';
    return (
        <div className="relative">
            <div className={`absolute -inset-1 rounded-full border pointer-events-none ${ring}`} />
            <button
                type="button"
                onClick={inert ? undefined : onClick}
                disabled={inert}
                className={`relative w-20 h-20 rounded-full flex flex-col items-center justify-center gap-1
                            bg-slate-900 border shadow-2xl transition ${face}`}
            >
                {busy
                    ? <Loader2 className="w-5 h-5 stroke-[1.5] animate-spin" />
                    : <Icon className="w-5 h-5 stroke-[1.5]" />}
                <span className="text-[8px] font-bold tracking-widest uppercase">{label}</span>
            </button>
        </div>
    );
}

// -------------------------------------------------------------------------------------------
// Sub-action row
// -------------------------------------------------------------------------------------------

/**
 * A fixed-height row under the hub for the one or two actions that make sense in this state.
 *
 * Fixed, so showing or hiding an action never moves the hub out from under a thumb already on its
 * way down. It is not an overflow area: a step that belongs to the main sequence belongs in the
 * hub as another derived face, even if that means the hub has seven of them.
 */
export function SubActions({ children }: { children?: ReactNode }): ReactNode {
    return <div className="h-[46px] shrink-0 flex items-center justify-center gap-6 px-4">{children}</div>;
}

export function SubAction(
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
            className={`px-3 py-2 text-[10px] font-bold uppercase tracking-widest transition ${paint}`}
        >
            {label}
        </button>
    );
}

// -------------------------------------------------------------------------------------------
// Step content frame
// -------------------------------------------------------------------------------------------

/** The question this step asks, and the answers under it. */
export function Card({ title, body, children }: { title: string; body?: string; children?: ReactNode }): ReactNode {
    return (
        <div className="px-4 pt-4 pb-2">
            <h2 className="text-sm font-bold tracking-widest uppercase text-slate-200">{title}</h2>
            {body && <p className="mt-2 text-[11px] leading-[1.6] text-slate-400">{body}</p>}
            {children && <div className="mt-4 space-y-2">{children}</div>}
        </div>
    );
}

/** A block of prose that is a warning rather than an explanation. */
export function Warning({ title, children }: { title: string; children: ReactNode }): ReactNode {
    return (
        <div className="rounded-lg bg-slate-900 p-3">
            <div className="flex items-center gap-1.5">
                <span className="w-1 h-3 bg-red-500 rounded-sm" aria-hidden="true" />
                <span className="text-[9px] font-bold tracking-widest uppercase text-red-400">{title}</span>
            </div>
            <p className="mt-2 text-[10px] leading-[1.6] text-slate-300">{children}</p>
        </div>
    );
}

// -------------------------------------------------------------------------------------------
// Progress
// -------------------------------------------------------------------------------------------

/**
 * A bar whose width is a fraction of work actually done.
 *
 * `aria-valuetext` carries the phase as well as the number, because "62%" of a flash is not the
 * information the reader wants - which phase it is in decides whether unplugging is survivable.
 */
export function Progress(
    { done, total, phase, note }:
    { done: number; total: number; phase: string; note?: string | undefined },
): ReactNode {
    const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
    return (
        <div className="px-4 py-3">
            <div className="flex items-baseline justify-between gap-2">
                <span className="text-[9px] font-bold tracking-widest uppercase text-slate-400 truncate">{phase}</span>
                <span className="text-[10px] font-mono text-blue-400 shrink-0">{pct.toFixed(1)}%</span>
            </div>
            <div
                role="progressbar"
                aria-valuenow={Math.round(pct)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuetext={`${phase}, ${pct.toFixed(0)}%`}
                className="mt-2 h-1 rounded-full bg-slate-700 overflow-hidden"
            >
                <div className="h-full bg-blue-500 transition-[width] duration-200" style={{ width: `${pct}%` }} />
            </div>
            <div className="mt-1.5 font-mono text-[9px] text-slate-600">
                {done.toLocaleString()} / {total.toLocaleString()}
            </div>
            {note && <p className="mt-1.5 text-[9px] leading-[1.5] text-amber-400">{note}</p>}
        </div>
    );
}

// -------------------------------------------------------------------------------------------
// Event log
// -------------------------------------------------------------------------------------------

/** What the tool actually did, newest last, mono because every line is machine data. */
export function EventLog({ lines }: { lines: readonly string[] }): ReactNode {
    if (lines.length === 0) return null;
    return (
        <div className="px-4 pb-4">
            <div className="rounded-lg bg-slate-900 p-3 max-h-[180px] overflow-y-auto">
                {lines.map((line, i) => (
                    <p key={i} className="text-[9px] font-mono leading-[1.6] text-slate-500 selectable break-all">
                        {line}
                    </p>
                ))}
            </div>
        </div>
    );
}
