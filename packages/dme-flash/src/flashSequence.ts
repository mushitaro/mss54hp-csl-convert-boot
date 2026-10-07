/**
 * The write sequence, as a plan that can be inspected and validated before a single byte reaches
 * the DME - and, in dry-run, without a DME at all.
 *
 * This module exists because the most dangerous thing this tool does is erase a program window
 * before writing it, and the reference implementation's hardest-won lesson is that everything that
 * can be checked must be checked *before* the device is touched (see the ///M
 * link-measurement-and-safety reference). So the flow is:
 *
 *     plan  ->  validate (pure, throws)  ->  [dry-run prints it]  or  [execute sends it]
 *
 * The plan is a list of steps. Erase steps come before their window's write steps; a write step
 * carries an address the firmware accepts and a length within the write cap. `validateSequence`
 * re-derives every safety property from the plan itself, so a plan that would erase a protected
 * sector, exceed the chunk cap, or write outside an accepted window cannot be executed - it fails
 * validation, which in dry-run is the whole point.
 *
 * Nothing here opens a session or sends a telegram. Execution is a separate, injected concern.
 */
import {
    Segment, resolveFlashAddress, WRITE_CHUNK_MAX, RESPONSE_ADDRESS_REJECTED,
} from './regionMap';
import {
    IMAGE_WINDOWS, FULL_IMAGE_LENGTH, isProtectedImageOffset, ds2ToImageOffset, type ImageWindow, type WindowKind,
} from './imageLayout';
import { sectorIsArmed } from './blLoader';

export type StepKind = 'login' | 'erase' | 'write' | 'finish' | 'reset' | 'verify-checksum';

export const ERASE_SESSION_ADDRESS = { program: 0xd00000, calibration: 0xa02000 } as const;

export interface FlashStep {
    readonly kind: StepKind;
    readonly segment?: number;
    readonly ds2Address?: number;
    /** For a write step: the bytes to program. Omitted on erase/login/reset. */
    readonly data?: Uint8Array;
    /** Full-image offset the data comes from, for the manifest and read-back verify. */
    readonly imageOffset?: number;
    readonly note: string;
}

export interface FlashPlan {
    readonly steps: readonly FlashStep[];
    readonly windows: readonly ImageWindow[];
    readonly writeBytes: number;
    readonly eraseCount: number;
}

export interface FlashSource {
    /** The full 1 MiB image to program from - genuine program windows + the built calibration. */
    readonly image: Uint8Array;
    /** Which windows to actually write. A conversion writes all four; a calibration-only reflash
     *  writes just the two calibration windows and never erases a program window. */
    readonly windowKinds: readonly WindowKind[];
}

/**
 * Build the write plan for a set of windows.
 *
 * One erase per kind affects both processors. Complete and Finish that pair before starting
 * another kind: the resident firmware distinguishes program (0x66) and data (0x3C) sessions.
 * Calibration uses TUNER's 0xA02000 entry. Program execution remains hardware-locked.
 */
export function planFlash(source: FlashSource, chunkSize = WRITE_CHUNK_MAX): FlashPlan {
    if (source.image.length !== FULL_IMAGE_LENGTH) throw new Error('flash source must be a full 1 MiB image');
    if (chunkSize <= 0 || chunkSize > WRITE_CHUNK_MAX || chunkSize % 2 !== 0) {
        throw new Error(`write chunk size ${chunkSize} must be positive, even, and <= ${WRITE_CHUNK_MAX}`);
    }
    const windows = IMAGE_WINDOWS.filter((w) => source.windowKinds.includes(w.kind));
    if (windows.length === 0) throw new Error('no windows selected to flash');
    for (const w of windows) {
        if (w.kind === 'calibration' && sectorIsArmed(source.image.subarray(w.imageOffset, w.imageOffset + w.length))) {
            throw new Error('ordinary calibration writes must never contain staged-loader magic');
        }
    }

    const steps: FlashStep[] = [
        { kind: 'login', note: 'Seed/key unlock at access level 5; refreshed immediately before the erase.' },
    ];
    let writeBytes = 0;
    let eraseCount = 0;

    for (const kind of ['program', 'calibration'] as const) {
        const pair = windows.filter(w => w.kind === kind).sort((a, b) => b.ds2Address - a.ds2Address);
        if (pair.length === 0) continue;
        steps.push({ kind: 'erase', segment: Segment.Erase, ds2Address: ERASE_SESSION_ADDRESS[kind],
            note: `Erase both ${kind} windows in one programming session.` });
        eraseCount++;
        for (const window of pair) {
            for (let done = 0; done < window.length; done += chunkSize) {
                const count = Math.min(chunkSize, window.length - done);
                const ds2Address = window.ds2Address + done;
                const imageOffset = window.imageOffset + done;
                steps.push({ kind: 'write', segment: Segment.Write, ds2Address, imageOffset,
                    data: source.image.slice(imageOffset, imageOffset + count),
                    note: `Write ${count} B to ${window.kind}/${window.processor}.` });
                writeBytes += count;
            }
        }
        steps.push({ kind: 'finish', segment: Segment.Finish, ds2Address: 0,
            note: `Finish the ${kind} session before changing the programming mode.` });
    }
    steps.push({ kind: 'verify-checksum', note: 'Confirm calibration CRC-16/ARC on the DME matches the image.' });
    steps.push({ kind: 'reset', note: 'After verification: key OFF, wait 10 seconds, key ON, then reconnect at 9600 and re-read IDENT.' });

    return { steps, windows, writeBytes, eraseCount };
}

export interface Violation {
    readonly stepIndex: number;
    readonly reason: string;
}

/**
 * Re-derive every safety property from the plan. Pure and total - returns violations rather than
 * throwing, so a dry-run can show all of them at once. `assertFlashable` is the throwing wrapper
 * the executor must call before touching the DME.
 *
 * Checks, each the counterpart of a way the reference tool has been bricked or nearly so:
 *  - no write or erase ever addresses a protected sector (bootloader / AIF / service block);
 *  - every erase and write address is one the firmware's region_table accepts;
 *  - no write chunk exceeds the cap or is odd-length;
 *  - every window is fully covered by contiguous writes with no gap and no overlap;
 *  - an erase for a window precedes all of that window's writes.
 */
export function validateSequence(plan: FlashPlan): Violation[] {
    const violations: Violation[] = [];
    const add = (reason: string): void => { violations.push({ stepIndex: -1, reason }); };
    if (plan.windows.length === 0) add('no windows selected');
    const bases = new Set<number>();
    for (const w of plan.windows) {
        const canonical = IMAGE_WINDOWS.find(c => c.ds2Address === w.ds2Address);
        if (!canonical || canonical.kind !== w.kind || canonical.processor !== w.processor
            || canonical.length !== w.length || canonical.imageOffset !== w.imageOffset
            || bases.has(w.ds2Address)) add('window definitions must be unique canonical image windows');
        bases.add(w.ds2Address);
    }
    // Both CPU windows are required when a kind is erased; a peer-wide erase must not strand it.
    for (const kind of ['program', 'calibration'] as const) {
        const count = plan.windows.filter(w => w.kind === kind).length;
        if (count !== 0 && count !== 2) add(`both ${kind} processor windows are required`);
    }
    const kinds = plan.steps.map(s => s.kind);
    if (kinds[0] !== 'login' || kinds.at(-2) !== 'verify-checksum' || kinds.at(-1) !== 'reset'
        || kinds.slice(1, -2).some(k => k !== 'erase' && k !== 'write' && k !== 'finish')) add('invalid flash phase order');
    const selectedKinds = new Set(plan.windows.map(w => w.kind));
    if (plan.eraseCount !== kinds.filter(k => k === 'erase').length
        || plan.eraseCount !== selectedKinds.size) add('erase count must match selected kinds exactly');
    if (kinds.filter(k => k === 'finish').length !== selectedKinds.size) add('each programming session needs Finish');
    if (plan.writeBytes !== plan.steps.reduce((n, s) => n + (s.kind === 'write' ? s.data?.length ?? 0 : 0), 0)) {
        add('write byte count does not match the steps');
    }
    let activeKind: WindowKind | null = null;
    const erasedKinds = new Set<WindowKind>();
    const erasedWindows = new Set<number>();
    const writtenByWindow = new Map<number, number>(); // ds2 base -> bytes written so far

    plan.steps.forEach((step, i) => {
        if (step.kind === 'erase' || step.kind === 'write') {
            if (!Number.isSafeInteger(step.ds2Address)) {
                violations.push({ stepIndex: i, reason: 'flash address must be an integer' });
                return;
            }
            if (step.segment !== (step.kind === 'erase' ? Segment.Erase : Segment.Write)) {
                violations.push({ stepIndex: i, reason: 'segment does not match step kind' });
            }
        }
        if (step.kind === 'erase') {
            const w = windowAt(plan, step.ds2Address!);
            if (!w) { violations.push({ stepIndex: i, reason: `erase address 0x${step.ds2Address!.toString(16)} is in no known window` }); return; }
            if (step.ds2Address !== ERASE_SESSION_ADDRESS[w.kind] || erasedKinds.has(w.kind) || activeKind !== null) {
                violations.push({ stepIndex: i, reason: 'erase each kind once; Finish both CPU writes before changing mode' });
            }
            activeKind = w.kind;
            erasedKinds.add(w.kind);
            if (isProtectedImageOffset(w.imageOffset)) {
                violations.push({ stepIndex: i, reason: `erase would clear a protected window at image 0x${w.imageOffset.toString(16)}` });
            }
            const r = resolveFlashAddress(Segment.Erase, step.ds2Address!);
            if (!r.accepted) violations.push({ stepIndex: i, reason: `erase address refused by firmware: ${r.reason}` });
            for (const peer of plan.windows.filter(peer => peer.kind === w.kind)) {
                erasedWindows.add(peer.ds2Address);
                writtenByWindow.set(peer.ds2Address, 0);
            }
        } else if (step.kind === 'finish') {
            if (activeKind === null || step.segment !== Segment.Finish || step.ds2Address !== 0
                || step.data !== undefined || plan.windows.filter(w => w.kind === activeKind)
                    .some(w => writtenByWindow.get(w.ds2Address) !== w.length)) {
                violations.push({ stepIndex: i, reason: 'Finish requires complete writes to both CPU windows of the active kind' });
            }
            activeKind = null;
        } else if (step.kind === 'write') {
            const w = windowAt(plan, step.ds2Address!);
            if (!w) { violations.push({ stepIndex: i, reason: `write address 0x${step.ds2Address!.toString(16)} is in no known window` }); return; }
            if (w.kind !== activeKind) violations.push({ stepIndex: i, reason: 'write outside its active programming session' });
            const off = ds2ToImageOffset(step.ds2Address!);
            if (step.imageOffset !== off) violations.push({ stepIndex: i, reason: 'source image offset does not match DS2 address' });
            if (off === undefined || isProtectedImageOffset(off)) {
                violations.push({ stepIndex: i, reason: `write into a protected or unmapped region at 0x${step.ds2Address!.toString(16)}` });
            }
            if (!erasedWindows.has(w.ds2Address)) {
                violations.push({ stepIndex: i, reason: `write to ${w.kind}/${w.processor} before its erase` });
            }
            const len = step.data?.length ?? 0;
            if (len === 0 || len > WRITE_CHUNK_MAX || len % 2 !== 0) {
                violations.push({ stepIndex: i, reason: `write length ${len} violates the flash chunk rule (even, 1..${WRITE_CHUNK_MAX})` });
            }
            const r = resolveFlashAddress(Segment.Write, step.ds2Address!, len);
            if (!r.accepted) {
                violations.push({ stepIndex: i, reason: `write address refused by firmware (answers 0x${RESPONSE_ADDRESS_REJECTED.toString(16)}): ${r.reason}` });
            } else if (r.maxLength < len) {
                violations.push({ stepIndex: i, reason: `write of ${len} B overruns the window; firmware would clamp to ${r.maxLength}` });
            }
            // Contiguity: this write must start exactly where the last one in this window ended.
            const expected = writtenByWindow.get(w.ds2Address) ?? 0;
            const delta = step.ds2Address! - w.ds2Address;
            if (delta !== expected) {
                violations.push({ stepIndex: i, reason: `non-contiguous write: window offset 0x${delta.toString(16)}, expected 0x${expected.toString(16)}` });
            }
            writtenByWindow.set(w.ds2Address, expected + len);
        }
    });

    if (activeKind !== null) add('programming session left open');

    // Every selected window must be fully covered.
    for (const w of plan.windows) {
        const written = writtenByWindow.get(w.ds2Address) ?? 0;
        if (written !== w.length) {
            violations.push({ stepIndex: -1, reason: `${w.kind}/${w.processor} window only ${written}/${w.length} bytes covered` });
        }
        if (w.kind === 'calibration' && w.length === 0x8000) {
            const sector = new Uint8Array(w.length).fill(0xff);
            for (const s of plan.steps) {
                const offset = (s.ds2Address ?? -1) - w.ds2Address;
                if (s.kind === 'write' && s.data && offset >= 0 && offset + s.data.length <= sector.length) {
                    sector.set(s.data, offset);
                }
            }
            if (sectorIsArmed(sector)) add('ordinary calibration plan contains staged-loader magic');
        }
    }
    return violations;
}

/** Throwing wrapper. Call this before opening a programming session; not after. */
export function assertFlashable(plan: FlashPlan): void {
    const v = validateSequence(plan);
    if (v.length > 0) {
        const lines = v.slice(0, 8).map((x) => `  step ${x.stepIndex}: ${x.reason}`).join('\n');
        throw new Error(`flash plan failed validation (${v.length} issue(s)):\n${lines}`);
    }
}

function windowAt(plan: FlashPlan, ds2Address: number): ImageWindow | undefined {
    return plan.windows.find((w) => ds2Address >= w.ds2Address && ds2Address < w.ds2Address + w.length);
}

/** A human-readable dry-run summary: the step list collapsed to something a person can audit. */
export function describePlan(plan: FlashPlan): string {
    const lines: string[] = [];
    lines.push(`Flash plan: ${plan.eraseCount} erase, ${plan.writeBytes} bytes written across ${plan.windows.length} window(s).`);
    for (const w of plan.windows) {
        const writes = plan.steps.filter((s) => s.kind === 'write' && windowAt(plan, s.ds2Address!) === w).length;
        lines.push(`  ${w.kind}/${w.processor} @ DS2 0x${w.ds2Address.toString(16)}: shared pair erase + ${writes} write telegram(s), ${w.length} B`);
    }
    const violations = validateSequence(plan);
    lines.push(violations.length === 0 ? '  validation: PASS' : `  validation: ${violations.length} violation(s)`);
    return lines.join('\n');
}
