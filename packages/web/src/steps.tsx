/**
 * The seven questions, one per screen.
 *
 * Each is a pure component: it renders what the state says and calls back. None of them decides
 * what comes next - `App.tsx` derives that from the same data - so a step cannot get out of step
 * with the workspace it is describing.
 */
import type { ReactNode } from 'react';
import {
    SA0_LENGTH, STAGED_MAGIC, MAGIC_OFFSET, STAGING_DS2_ADDRESS, FREE_IDENTIFIERS,
    HARDWARE_WRITE_ENABLED, CENSORED_RANGE, VANOS_OFFSETS,
    type BootloaderReport, type EncodingChecksumReport, type PatchedBootloader, type Processor,
} from 'dme-flash';
import { Card, Choice, Readout, Warning } from './components';
import type {
    SpDatenSet, SpDatenVariant, VariantChoice, PatchedProgram, ProgramEdit,
} from 'dme-flash';

/** Which program a conversion writes. Two answers, and they do not interact with the six builds. */
export type ProgramChoice = 'factory' | 'patched';
import { t } from './copy';
import type { StageKind } from './wizard';
import type { LinkBlock } from './platform';

const hex = (n: number, width = 4): string => `0x${n.toString(16).toUpperCase().padStart(width, '0')}`;

// -------------------------------------------------------------------------------------------

export function LinkStep(
    { blocked, installed }: { blocked: LinkBlock | null; installed: boolean },
): ReactNode {
    const c = t();
    const body = blocked === 'not-android' ? c.linkBlockedNotAndroid
        : blocked === 'no-webusb' ? c.linkUsbUnsupported
            : c.linkBody;

    /**
     * On a blocked device the checklist is not shown.
     *
     * It is four instructions for connecting to a car, on a screen that has just said this device
     * cannot connect to a car. Rendering both makes the refusal look like an obstacle to work
     * around - which, on Windows, means rebinding the cable's driver and breaking INPA.
     */
    return (
        <Card title={c.linkTitle} body={body}>
            {blocked === 'not-android' && (
                <div className="rounded-lg bg-slate-900 p-3">
                    <div className="flex items-center gap-1.5">
                        <span className="w-1 h-3 bg-red-500 rounded-sm" aria-hidden="true" />
                        <span className="text-[9px] font-bold tracking-widest uppercase text-red-400">
                            {c.linkBlockedTitle}
                        </span>
                    </div>
                    <p className="mt-2 text-[10px] leading-[1.6] text-slate-300">{c.linkBlockedWhy}</p>
                    <p className="mt-2 text-[10px] leading-[1.6] text-slate-500">{c.linkBlockedPractice}</p>
                </div>
            )}

            {/* Concrete, numbered, and here rather than in a warning at the end - every one of
                these is cheaper to do now than to discover halfway through a 30-minute read. */}
            {blocked !== 'not-android' && <div className="rounded-lg bg-slate-900 p-3">
                <span className="text-[9px] font-bold tracking-widest uppercase text-slate-500">
                    {c.linkChecklist}
                </span>
                <ol className="mt-2 space-y-1.5">
                    {[c.linkCheck1, c.linkCheck2, c.linkCheck3, c.linkCheck4].map((line, i) => (
                        <li key={line} className="flex gap-2 text-[10px] leading-[1.5] text-slate-400">
                            <span className="font-mono text-slate-600 shrink-0">{i + 1}</span>
                            <span>{line}</span>
                        </li>
                    ))}
                </ol>
            </div>}
            {/* Only when it applies: an installed app has already taken this advice, and a line
                that is true every time carries no information. */}
            {!installed && blocked !== 'not-android' && (
                <p className="text-[10px] leading-[1.6] text-amber-400">{c.linkInstall}</p>
            )}
            {/* The offer, not the control. PRACTICE is a sub-action under the hub, because the hub
                holds the main sequence and practice is a detour from it. This says it exists. */}
            <p className="text-[10px] leading-[1.6] text-slate-600">{c.practiceOffer}</p>
        </Card>
    );
}

// -------------------------------------------------------------------------------------------

export interface IdentView {
    ident: string;
    master: BootloaderReport;
    slave: BootloaderReport;
    checksum: EncodingChecksumReport | null;
}

export function IdentStep({ view, practice }: { view: IdentView | null; practice?: boolean }): ReactNode {
    const c = t();
    if (!view) return <Card title={c.identTitle} body={c.identBody} />;

    const flavour = view.master.flavour;
    const crcOk = view.master.crc.valid && view.slave.crc.valid;
    const verdict = !crcOk ? c.identCrcBad
        : flavour === 'standard-m3' ? c.identStandardM3
            : flavour === 'csl' ? c.identCsl : c.identUnknown;

    return (
        <Card title={c.identTitle}>
            <div className="rounded-lg bg-slate-900 p-3 grid grid-cols-2 gap-x-3 gap-y-3">
                <Readout label="IDENT" value={view.ident || '-'} tone="key" />
                <Readout label="PROGRAM" value={view.master.programNumbers?.[0] ?? '-'} tone="key" />
                <Readout
                    label="MASTER SA0"
                    value={view.master.flavour}
                    tone={view.master.flavour === 'unknown' ? 'bad' : 'default'}
                />
                <Readout
                    label="MASTER CRC"
                    value={hex(view.master.crc.stored)}
                    tone={view.master.crc.valid ? 'ok' : 'bad'}
                />
                <Readout
                    label="SLAVE SA0"
                    value={view.slave.flavour}
                    tone={view.slave.flavour === 'unknown' ? 'bad' : 'default'}
                />
                <Readout
                    label="SLAVE CRC"
                    value={hex(view.slave.crc.stored)}
                    tone={view.slave.crc.valid ? 'ok' : 'bad'}
                />
                {view.checksum && (
                    <Readout
                        label="ECU SELF-CHECK"
                        value={view.checksum.anyFaulted ? 'FAULTED' : 'CLEAN'}
                        tone={view.checksum.anyFaulted ? 'bad' : 'ok'}
                    />
                )}
                <Readout label="SA0 SIZE" value={`${SA0_LENGTH.toLocaleString()} B`} />
            </div>
            <p className={`text-[11px] leading-[1.6] ${crcOk && flavour === 'standard-m3' ? 'text-slate-400' : 'text-amber-400'}`}>
                {verdict}
            </p>
            {/* Said here rather than only in the header, because this is the screen that reports
                a program number and a CRC as facts about a DME - and on this run they are not. */}
            {practice && <p className="text-[10px] leading-[1.6] text-amber-400">{c.practiceEcu}</p>}
        </Card>
    );
}

// -------------------------------------------------------------------------------------------

/**
 * Two ways to get a capture, and there is deliberately no third.
 *
 * A single-pass option used to sit between these. It could not work: the conversion needs a capture
 * whose two passes agreed, so a single pass had nowhere to go - the wizard would not advance, no
 * file was written, and the result was reported through the two-pass mismatch message, which said
 * "the passes disagreed at 0 offsets" about a comparison that never ran. Three separate ways of
 * being wrong, all downstream of offering a choice that could not take effect.
 */
export type BackupMode = 'two-pass' | 'load';

/**
 * What the capture is, reported by how it was actually verified.
 *
 * `how` is not decoration. A capture verified against a file was compared once, to a reference;
 * one verified by two passes was compared to a second read. Reporting the first as "two passes
 * agree" describes a run that did not happen - and it also told the operator to save a file they
 * had just loaded from disk.
 */
export interface BackupResultView {
    bytes: number;
    seconds: number;
    verified: boolean;
    differing: number;
    how: BackupMode;
}

export function BackupStep(
    { mode, onMode, result }:
    { mode: BackupMode; onMode: (m: BackupMode) => void; result: BackupResultView | null },
): ReactNode {
    const c = t();
    const verdict = !result ? null
        : result.verified
            ? (result.how === 'load'
                ? c.backupFileVerified(result.bytes, result.seconds)
                : c.backupDone(result.bytes, result.seconds))
            : (result.how === 'load' ? null : c.backupMismatch(result.differing));

    return (
        <Card title={c.backupTitle} body={c.backupBody}>
            <Choice label={c.backupTwoPass} why={c.backupTwoPassWhy} selected={mode === 'two-pass'} onSelect={() => onMode('two-pass')} />
            <Choice label={c.backupSkip} why={c.backupSkipWhy} selected={mode === 'load'} onSelect={() => onMode('load')} />
            {verdict && (
                <div className="rounded-lg bg-slate-900 p-3">
                    <p className={`text-[10px] leading-[1.6] ${result?.verified ? 'text-emerald-400' : 'text-red-400'}`}>
                        {verdict}
                    </p>
                    {/* Only for a capture this app just took. A loaded file is already on the
                        phone, and telling someone to save it again is advice about nothing. */}
                    {result?.verified && result.how === 'two-pass' && (
                        <p className="mt-2 text-[10px] leading-[1.6] text-slate-500">{c.backupSave}</p>
                    )}
                    {/* On the same screen that calls this file the only way back, because that is
                        the claim it qualifies. These 24 bytes are not in the capture, were not in
                        the two-pass comparison, and cannot be restored from it - the firmware
                        answers 0xFF for that range no matter who asks. */}
                    {result?.verified && (
                        <p className="mt-2 text-[10px] leading-[1.6] text-amber-400">
                            {c.backupCensored(CENSORED_RANGE.start, CENSORED_RANGE.end,
                                CENSORED_RANGE.end - CENSORED_RANGE.start)}
                        </p>
                    )}
                </div>
            )}
        </Card>
    );
}

// -------------------------------------------------------------------------------------------

/**
 * The whole job, and which stage is next - reported, not asked.
 *
 * This used to be two Choice rows, MASTER or SLAVE, which framed them as alternatives. They are
 * not. The end state is both processors on the CSL bootloader AND the CSL program written, so this
 * is three stages of one job. The order among the bootloaders is forced (`conversionStages`), and
 * the program goes last because there is no point writing it onto a bootloader that is about to be
 * replaced.
 *
 * Nothing here is a control. The bootloader stages are read off SA0, which the app has already
 * captured; offering them as a choice could only have added a way to get it wrong.
 */
export interface JobStage {
    id: string;
    kind: StageKind;
    processor?: Processor | undefined;
    done: boolean;
}

/**
 * What a stage is called, in the one place that decides it.
 *
 * Every screen that names a stage calls this. It exists because the two that did it themselves
 * wrote `kind === 'bootloader' ? ... : programLabel` - correct while there were two kinds, and
 * silently wrong the moment there were three: the RUN screen titled the probe stage "CSL program
 * and parameters" while the rail above it correctly said PROBE. The operator would have been
 * looking at a FLASH button under the name of the wrong operation.
 *
 * A fallthrough `:` is the bug. A `switch` over the union is not, because adding a fourth kind
 * fails the build instead of picking the last branch.
 */
export function stageName(stage: JobStage): string {
    const c = t();
    switch (stage.kind) {
        case 'probe': return c.planStageProbe;
        case 'bootloader': return c.planStageBootloader(stage.processor ?? '');
        case 'program': return c.planStageProgram;
    }
}

export function PlanStep(
    {
        stages, next, blocked, spDaten, variant, onVariant,
        programChoice = 'factory', patchedProgram, onProgramChoice,
    }:
    {
        stages: readonly JobStage[]; next: JobStage | null; blocked: boolean;
        spDaten: SpDatenSet | null; variant: SpDatenVariant | null;
        onVariant?: ((v: SpDatenVariant) => void) | undefined;
        programChoice?: ProgramChoice;
        patchedProgram?: PatchedProgram | null;
        onProgramChoice?: ((choice: ProgramChoice) => void) | undefined;
    },
): ReactNode {
    const c = t();

    return (
        <Card title={c.planTitle} body={c.planBody}>
            <div className="space-y-2">
                {stages.map((stage, i) => {
                    const isNext = next?.id === stage.id;
                    return (
                        <div
                            key={stage.id}
                            className={`flex items-center gap-3 rounded-lg p-3 ${isNext ? 'bg-slate-800' : 'bg-slate-900'}`}
                        >
                            <span className="w-4 shrink-0 text-center font-mono text-[10px] text-slate-600">{i + 1}</span>
                            <span className={`flex-1 truncate text-[10px] font-bold uppercase tracking-widest
                                ${stage.done ? 'text-emerald-400' : isNext ? 'text-blue-400' : 'text-slate-500'}`}>
                                {stageName(stage)}
                            </span>
                            <span className={`shrink-0 font-mono text-[9px] uppercase tracking-wider
                                ${stage.done ? 'text-emerald-400' : isNext ? 'text-blue-400' : 'text-slate-600'}`}>
                                {stage.done ? c.planStageDone : isNext ? c.planStageNext : c.planStagePending}
                            </span>
                        </div>
                    );
                })}
            </div>

            {blocked && <p className="text-[11px] leading-[1.6] text-red-400">{c.targetUnknownBl}</p>}

            {/* Why the probe is first, said on the screen where the operator is looking at a list
                that puts it there. A stage nobody understands the point of is a stage that gets
                skipped, and this one cannot be skipped without giving up the only rehearsal the
                design allows. */}
            {next?.kind === 'probe' && (
                <p className="text-[11px] leading-[1.6] text-slate-400">{c.planWhyProbeFirst}</p>
            )}

            {next?.kind === 'bootloader' && (
                <p className="text-[11px] leading-[1.6] text-slate-400">
                    {next.processor === 'slave' ? c.targetWhySlaveFirst : c.targetWhyMasterSecond}
                </p>
            )}

            {/* Only while the two processors really are carrying different bootloaders - which is
                after exactly one of them is done. Rendered on both stages it fired when the claim
                was not yet true, and a warning that shows every time says nothing. */}
            {next?.kind === 'bootloader' && stages.filter((x) => x.kind === 'bootloader' && x.done).length === 1 && (
                <Warning title={c.targetMixedTitle}>{c.targetMixedUnproven}</Warning>
            )}

            {/* Which PROGRAM, before which build - they are two questions and the answers do not
                interact. The patch's two integrity words do not move with the calibration, so
                every one of the six composes with either program. */}
            {next?.kind === 'program' && spDaten?.program && (
                <div className="space-y-2">
                    <span className="text-[9px] font-bold uppercase tracking-widest text-slate-500">
                        {c.programWhichTitle}
                    </span>
                    <p className="text-[10px] leading-[1.6] text-slate-500">{c.programWhichWhy}</p>
                    <Choice
                        label={c.programFactory}
                        why={c.programFactoryWhy}
                        selected={programChoice === 'factory'}
                        onSelect={() => onProgramChoice?.('factory')}
                    />
                    <Choice
                        label={c.programPatched}
                        why={patchedProgram
                            ? c.programPatchedVerified(patchedProgram.edits.length, patchedProgram.changedBytes)
                            : c.programPatchedWhy}
                        selected={programChoice === 'patched'}
                        onSelect={() => onProgramChoice?.('patched')}
                    />
                    {programChoice === 'patched' && (
                        <Warning title={c.programPatchedWarnTitle}>{c.programPatchedWarn}</Warning>
                    )}
                </div>
            )}

            {/* One section, one heading. The six builds are named by the text BMW wrote in each
                file rather than by a table in this repo, so a label here cannot drift from what it
                selects. */}
            {next?.kind === 'program' && (
                <div className="space-y-2">
                    <span className="text-[9px] font-bold uppercase tracking-widest text-slate-500">
                        {c.programSourceTitle}
                    </span>
                    <p className="text-[10px] leading-[1.6] text-slate-500">{c.programSourceWhy}</p>
                    {!spDaten && (
                        <p className="text-[10px] leading-[1.6] text-slate-500">{c.programNeedsSource}</p>
                    )}
                    {spDaten && spDaten.variants.length === 0 && (
                        <p className="text-[10px] leading-[1.6] text-red-400">{c.programNoVariants}</p>
                    )}
                    {spDaten && spDaten.variants.length > 0 && !spDaten.program && (
                        <p className="text-[10px] leading-[1.6] text-red-400">{c.programNoProgram}</p>
                    )}
                    {(spDaten?.variants ?? []).map((v) => (
                        <Choice
                            key={v.reference}
                            label={v.name || v.reference}
                            why={`${c.programVariantOf(v.stand, v.zb)} · ${v.file}`}
                            selected={variant?.reference === v.reference}
                            onSelect={() => onVariant?.(v)}
                            lockedReason={v.checksumValid ? undefined : c.programChecksumBad(v.file)}
                        />
                    ))}
                </div>
            )}

            {/* Said where it applies rather than as a footnote: this is the one stage whose state
                the app cannot read back off the ECU. */}
            <p className="text-[10px] leading-[1.6] text-slate-600">{c.planProgramNotDerived}</p>
        </Card>
    );
}

// -------------------------------------------------------------------------------------------

/**
 * How far each cam moves if the answer is wrong, in degrees KW.
 *
 * The difference between the two answers, per word - not a constant in the copy. 5.0 on one and
 * 3.0 on the other, which is exactly why the operator must be told both: one bank alone cannot
 * distinguish "the setting is right" from "you are looking at the smaller of the two".
 *
 * Absolute values: the sign depends on which way round the offsets are applied, and this project
 * has not established that. Telling someone to look for a signed number it cannot justify would be
 * a worse answer than telling them the magnitude.
 */
const CAM_CHECK_DELTAS: [number, number] = [
    Math.abs(VANOS_OFFSETS.m3[0] - VANOS_OFFSETS.csl[0]) / 10,
    Math.abs(VANOS_OFFSETS.m3[1] - VANOS_OFFSETS.csl[1]) / 10,
];

/**
 * What the car actually has bolted to it.
 *
 * Genuine CSL ships a MAP sensor and an active snorkel flap; the standard M3 this tool converts
 * has neither. Writing genuine parameters onto a car without them is a legitimate choice - it just
 * stores the corresponding faults - and so is editing them out. Neither is safe to assume, so
 * neither is the default: both start unanswered and the step will not advance until both are set.
 */
export function PatchStep(
    { choice, onChoice, edits, error }: {
        choice: Partial<VariantChoice>;
        onChoice: (v: Partial<VariantChoice>) => void;
        edits: { places: number; bytes: number } | null;
        error: string | null;
    },
): ReactNode {
    const c = t();
    // Half an answer is still a choice worth keeping, so each group edits its own field and
    // leaves the other alone. Defaults only appear once the operator has touched that group.
    // Merge, never fill. Supplying a default for a question the operator has not reached is how
    // the step used to advance with two of the three unanswered.
    const set = (part: Partial<VariantChoice>): void => onChoice({ ...choice, ...part });

    return (
        <Card title={c.patchTitle} body={c.patchBody}>
            <div className="space-y-2">
                <span className="text-[9px] font-bold uppercase tracking-widest text-slate-500">
                    {c.patchMapTitle}
                </span>
                <Choice
                    label={c.patchMapUse} why={c.patchMapUseWhy}
                    selected={choice.map === 'use'} onSelect={() => set({ map: 'use' })}
                />
                <Choice
                    label={c.patchMapOff} why={c.patchMapOffWhy}
                    selected={choice.map === 'off'} onSelect={() => set({ map: 'off' })}
                />
            </div>

            <div className="space-y-2">
                <span className="text-[9px] font-bold uppercase tracking-widest text-slate-500">
                    {c.patchFlapTitle}
                </span>
                <Choice
                    label={c.patchFlapPresent} why={c.patchFlapPresentWhy}
                    selected={choice.flap === 'present'} onSelect={() => set({ flap: 'present' })}
                />
                <Choice
                    label={c.patchFlapAbsent} why={c.patchFlapAbsentWhy}
                    selected={choice.flap === 'absent'} onSelect={() => set({ flap: 'absent' })}
                />
            </div>

            <div className="space-y-2">
                <span className="text-[9px] font-bold uppercase tracking-widest text-slate-500">
                    {c.patchCamTitle}
                </span>
                <Choice
                    label={c.patchCamCsl} why={c.patchCamCslWhy}
                    selected={choice.cams === 'csl'} onSelect={() => set({ cams: 'csl' })}
                />
                <Choice
                    label={c.patchCamM3} why={c.patchCamM3Why} tone="caution"
                    selected={choice.cams === 'm3'} onSelect={() => set({ cams: 'm3' })}
                />
            </div>

            {/* What the answers cost, in bytes, before the operator commits to them. */}
            {edits && (
                <div className="rounded-lg bg-slate-900 p-3">
                    <p className={`text-[10px] leading-[1.6] ${edits.places === 0 ? 'text-emerald-400' : 'text-slate-400'}`}>
                        {edits.places === 0 ? c.patchGenuine : c.patchEdits(edits.places, edits.bytes)}
                    </p>
                </div>
            )}

            {/* Consequences of the answers given, not of the answers available. Shown here rather
                than at REVIEW because this is the screen where changing the answer is one tap. */}
            {choice.map === 'off' && <Warning title={c.patchMapDtcTitle}>{c.patchMapDtcStays}</Warning>}
            {choice.flap === 'absent' && <Warning title={c.patchFlapPartialTitle}>{c.patchFlapPartial}</Warning>}
            {/* The cam answer earns a warning whichever way it goes, because both directions have a
                consequence: one runs offset cam phase, the other writes bytes no BMW file carries. */}
            {choice.cams !== undefined && (
                <Warning title={c.patchCamNoDtcTitle}>
                    {c.patchCamNoDtc}
                    {' '}
                    {/* Derived from the two offsets rather than written into the copy, because
                        there are two of them and they differ by different amounts. The sentence
                        used to quote one number, so an operator who checked the other bank saw a
                        smaller discrepancy and read it as agreement. */}
                    {c.patchCamCheck(...CAM_CHECK_DELTAS)}
                </Warning>
            )}
            {choice.cams === 'csl' && <Warning title={c.patchCamCslWarnTitle}>{c.patchCamCslWarn}</Warning>}
            {choice.cams === 'm3' && <Warning title={c.patchCamM3WarnTitle}>{c.patchCamM3Warn}</Warning>}
            {error && <Warning title={c.patchFailedTitle}>{c.patchFailed(error)}</Warning>}
        </Card>
    );
}

/**
 * The end of the job.
 *
 * Reached when every stage is done, and it exists because the alternative was the planning screen
 * with nothing left to plan - a list of finished stages, an inert control, and no statement that
 * the work was over.
 */
export function DoneStep({ practice }: { practice: boolean }): ReactNode {
    const c = t();
    return (
        <Card title={c.doneTitle} body={c.doneBody}>
            <div className="rounded-lg bg-slate-900 p-3 space-y-2">
                <p className="text-[10px] leading-[1.6] text-blue-400">{c.doneNext}</p>
                <p className="text-[10px] leading-[1.6] text-slate-400">{c.doneKeepBackup}</p>
            </div>
            {practice && <p className="text-[10px] leading-[1.6] text-amber-400">{c.doneRestart}</p>}
        </Card>
    );
}

export type Speed = 'slow' | 'fast';

export function SpeedStep(
    { speed, onSpeed, fastLocked, restoreBytes, slowSeconds, fastSeconds }:
    {
        speed: Speed | null; onSpeed: (s: Speed) => void; fastLocked: string | undefined;
        restoreBytes: number; slowSeconds: number; fastSeconds: number;
    },
): ReactNode {
    const c = t();
    return (
        <Card title={c.speedTitle} body={c.speedBody}>
            <Choice label={c.speedSlow} why={c.speedSlowWhy} selected={speed === 'slow'} onSelect={() => onSpeed('slow')} />
            <Choice
                label={c.speedFast}
                why={`${c.speedFastWhy} ${c.speedFastCost}`}
                selected={speed === 'fast'}
                onSelect={() => onSpeed('fast')}
                lockedReason={fastLocked}
                tone="caution"
            />
            <div className="rounded-lg bg-slate-900 p-3">
                <p className="text-[10px] leading-[1.6] text-slate-500">{c.speedEstimate(slowSeconds, fastSeconds)}</p>
                <div className="mt-3 grid grid-cols-2 gap-3">
                    <Readout label="ERASED" value={`${FREE_IDENTIFIERS.length.toLocaleString()} B`} tone="warn" />
                    <Readout label="PUT BACK" value={`${restoreBytes.toLocaleString()} B`} tone="warn" />
                </div>
            </div>
        </Card>
    );
}

// -------------------------------------------------------------------------------------------

/**
 * What REVIEW states, per stage kind.
 *
 * A discriminated union rather than optional fields, because the two stages have genuinely
 * different consequences and the screen must not be able to show a bootloader warning over a
 * program write. The previous shape required `processor`, so the program stage produced `null`
 * facts and REVIEW rendered nothing at all - a blank screen with an inert FLASH button and no way
 * forward.
 */
export type ReviewFacts =
    | {
        /**
         * The probe's review.
         *
         * It carries less than the bootloader one because there is genuinely less: no SA0 image,
         * no CRC, no program number changing. What it must NOT carry less of is the warning - the
         * arming is identical and so is the consequence of a loader that does not run.
         */
        kind: 'probe';
        processor: Processor;
        loaderBytes: number;
    }
    | {
        kind: 'bootloader';
        processor: Processor;
        patched: PatchedBootloader;
        loaderBytes: number;
        /**
         * What this processor calls itself now and afterwards, and what that identity IS.
         *
         * Split out because the two processors do not answer the same question. The program number
         * ("21132300") is an ASCII string inside the MASTER's SA0; the slave has no such field, and
         * `readBootloader` does not even look for one there. The slave's REVIEW showed the master's
         * number anyway - a readout labelled PROGRAM, on the slave stage, reporting a value read
         * from the other processor.
         */
        identityLabel: string;
        identityBefore: string;
        identityAfter: string;
    }
    | {
        kind: 'program';
        speed: Speed;
        variant: SpDatenVariant;
        patch: VariantChoice;
        patchLabel: string;
        patchPlaces: number;
        patchBytes: number;
        program: string;
        /** Present only when the conversion writes the community-patched program. */
        programPatch: {
            readonly file: string;
            readonly edits: readonly ProgramEdit[];
            readonly changedBytes: number;
        } | null;
        writeBytes: number;
    };

export function ReviewStep(
    { facts, acked, onAck }: { facts: ReviewFacts; acked: boolean; onAck: (v: boolean) => void },
): ReactNode {
    const c = t();
    if (facts.kind === 'program') return <ReviewProgram facts={facts} acked={acked} onAck={onAck} />;
    if (facts.kind === 'probe') return <ReviewProbe facts={facts} acked={acked} onAck={onAck} />;
    const stage = STAGING_DS2_ADDRESS[facts.processor];
    return (
        <Card title={c.reviewTitle} body={c.reviewBody}>
            <div className="rounded-lg bg-slate-900 p-3 grid grid-cols-2 gap-x-3 gap-y-3">
                <Readout label="PROCESSOR" value={facts.processor.toUpperCase()} tone="key" />
                <Readout label="LINK" value="9600" />
                <Readout
                    label={facts.identityLabel}
                    value={`${facts.identityBefore} -> ${facts.identityAfter}`}
                    tone="key"
                />
                <Readout label="SA0 CRC" value={hex(facts.patched.crc.stored)} tone="ok" />
                <Readout label="STAGE AT" value={hex(stage, 6)} />
                <Readout label="MAGIC AT" value={hex(stage + MAGIC_OFFSET, 6)} tone="bad" />
                <Readout label="LOADER" value={`${facts.loaderBytes} B`} />
                <Readout label="MAGIC" value={hex(STAGED_MAGIC, 8)} tone="bad" />
            </div>

            <div className="rounded-lg bg-slate-900 p-3">
                <span className="text-[9px] font-bold tracking-widest uppercase text-slate-500">SA0 EDITS</span>
                <div className="mt-2 space-y-1.5">
                    {facts.patched.edits.map((e) => (
                        <div key={e.offset} className="flex items-baseline gap-2">
                            <span className="text-[10px] font-mono text-slate-400 shrink-0 selectable">{hex(e.offset)}</span>
                            <span className="text-[10px] font-mono text-slate-600 shrink-0">
                                {e.before.toString(16).padStart(2, '0')}&rarr;{e.after.toString(16).padStart(2, '0')}
                            </span>
                            <span className="text-[9px] leading-[1.4] text-slate-600 min-w-0">{e.note}</span>
                        </div>
                    ))}
                </div>
            </div>

            {/* Above the point-of-no-return warning, because it is a fact about THIS ECU and the
                operator should read it before the generic danger. */}
            {facts.patched.anomalies.length > 0 && (
                <Warning title={c.reviewSa0AnomalyTitle(facts.patched.anomalies.length)}>
                    {c.reviewSa0Anomaly}
                    <div className="mt-2 space-y-1">
                        {facts.patched.anomalies.map((a) => (
                            <div key={a.offset} className="flex items-baseline gap-2 font-mono text-[10px]">
                                <span className="text-slate-400 selectable">{hex(a.offset)}</span>
                                <span className="text-slate-600">
                                    {a.derived.toString(16).padStart(2, '0')}&rarr;{a.reference.toString(16).padStart(2, '0')}
                                </span>
                                {a.outsideCrc && <span className="text-[9px] text-slate-600">{c.reviewSa0OutsideCrc}</span>}
                            </div>
                        ))}
                    </div>
                </Warning>
            )}

            <Warning title={c.reviewPointOfNoReturn}>{c.reviewMagic}</Warning>

            <div className="rounded-lg bg-slate-900 p-3">
                <span className="text-[9px] font-bold tracking-widest uppercase text-slate-500">{c.reviewNeeds}</span>
                <ul className="mt-2 space-y-1.5">
                    {[c.reviewNeedsPower, c.reviewNeedsCable].map((line) => (
                        <li key={line} className="flex gap-2 text-[10px] leading-[1.5] text-slate-400">
                            <span className="text-red-500 shrink-0" aria-hidden="true">&bull;</span>
                            <span>{line}</span>
                        </li>
                    ))}
                </ul>
            </div>

            {/* Recovery, kept as its own block. It is not a shopping list for the job - the job is
                done over OBD - it is what the failure would cost, which is a different question and
                deserves to be read as one. */}
            <div className="rounded-lg bg-slate-900 p-3">
                <span className="text-[9px] font-bold tracking-widest uppercase text-amber-500">
                    {c.reviewIfItFails}
                </span>
                <p className="mt-2 text-[10px] leading-[1.5] text-slate-400">{c.reviewNeedsBdm}</p>
            </div>

            {/* The switch that arms the hub. Disabled controls elsewhere derive their value from
                the condition that disables them; this one has no such condition - it is the
                operator's own statement, and nothing else may set it. */}
            <label className="flex items-center gap-3 rounded-lg bg-slate-900 p-3 min-h-[56px]">
                <input
                    type="checkbox"
                    checked={acked}
                    onChange={(e) => onAck(e.target.checked)}
                    className="w-4 h-4 accent-red-500 bg-slate-700 shrink-0"
                />
                <span className={`text-[10px] font-bold tracking-widest uppercase ${acked ? 'text-red-400' : 'text-slate-400'}`}>
                    {c.reviewAck}
                </span>
            </label>
        </Card>
    );
}

/**
 * The probe's review.
 *
 * ## Why this warns exactly as hard as the bootloader one
 *
 * Everything up to the power cycle is the same operation: the same calibration erase, the same
 * 32 KiB, the same magic at the same address, the same acknowledgement that cannot be taken back.
 * The reset handler checks that magic before the SIM, the stack or the K-line come up, so a loader
 * that does not run leaves a DME that cannot be reached over OBD again - **with SA0 completely
 * intact**. That failure is available to the probe on exactly the same terms as to a replacement.
 *
 * What the probe changes is not the risk of arming. It is what gets armed: the smallest program
 * that can prove the machine setup works, whose first flash operation is to clear its own magic,
 * and which never writes a byte of SA0. Softening the warning here to match the smaller payload
 * would teach the operator to read past it on the stage where the payload is larger - and the
 * warning is about the arming, which does not get smaller.
 *
 * So the readouts differ (there is no SA0 image and no CRC to show) and the warning does not.
 */
function ReviewProbe(
    { facts, acked, onAck }:
    { facts: Extract<ReviewFacts, { kind: 'probe' }>; acked: boolean; onAck: (v: boolean) => void },
): ReactNode {
    const c = t();
    const stage = STAGING_DS2_ADDRESS[facts.processor];
    return (
        <Card title={c.reviewProbeTitle} body={c.reviewProbeBody}>
            <div className="rounded-lg bg-slate-900 p-3 grid grid-cols-2 gap-x-3 gap-y-3">
                <Readout label="PROCESSOR" value={facts.processor.toUpperCase()} tone="key" />
                <Readout label="LINK" value="9600" />
                <Readout label="LOADER" value={`${facts.loaderBytes} B`} />
                <Readout label="SA0" value={c.reviewProbeSa0Untouched} tone="ok" />
                <Readout label="STAGE AT" value={hex(stage, 6)} />
                <Readout label="MAGIC AT" value={hex(stage + MAGIC_OFFSET, 6)} tone="bad" />
                <Readout label="MAGIC" value={hex(STAGED_MAGIC, 8)} tone="bad" />
                <Readout label="CLEARS TO" value={hex(0, 8)} tone="ok" />
            </div>

            {/* What it proves, listed - because "a probe" means nothing on its own, and these four
                are precisely the things the replacement loader gets one chance to be right about. */}
            <div className="rounded-lg bg-slate-900 p-3">
                <span className="text-[9px] font-bold tracking-widest uppercase text-slate-500">
                    {c.reviewProbeProves}
                </span>
                <ul className="mt-2 space-y-1.5">
                    {[c.reviewProbeProvesEntry, c.reviewProbeProvesRam,
                        c.reviewProbeProvesStub, c.reviewProbeProvesFlash].map((line) => (
                        <li key={line} className="flex gap-2 text-[10px] leading-[1.5] text-slate-400">
                            <span className="text-blue-500 shrink-0" aria-hidden="true">&bull;</span>
                            <span>{line}</span>
                        </li>
                    ))}
                </ul>
            </div>

            <Warning title={c.reviewPointOfNoReturn}>{c.reviewProbeMagic}</Warning>

            <div className="rounded-lg bg-slate-900 p-3">
                <span className="text-[9px] font-bold tracking-widest uppercase text-slate-500">
                    {c.reviewNeeds}
                </span>
                <ul className="mt-2 space-y-1.5">
                    {[c.reviewNeedsPower, c.reviewNeedsCable].map((line) => (
                        <li key={line} className="flex gap-2 text-[10px] leading-[1.5] text-slate-400">
                            <span className="text-red-500 shrink-0" aria-hidden="true">&bull;</span>
                            <span>{line}</span>
                        </li>
                    ))}
                </ul>
            </div>

            <div className="rounded-lg bg-slate-900 p-3">
                <span className="text-[9px] font-bold uppercase tracking-widest text-amber-500">
                    {c.reviewIfItFails}
                </span>
                <p className="mt-2 text-[10px] leading-[1.5] text-slate-400">{c.reviewNeedsBdm}</p>
            </div>

            <label className="flex items-center gap-3 rounded-lg bg-slate-900 p-3 min-h-[56px]">
                <input
                    type="checkbox"
                    checked={acked}
                    onChange={(e) => onAck(e.target.checked)}
                    className="w-4 h-4 accent-red-500 bg-slate-700 shrink-0"
                />
                <span className={`text-[10px] font-bold tracking-widest uppercase ${acked ? 'text-red-400' : 'text-slate-400'}`}>
                    {c.reviewAck}
                </span>
            </label>
        </Card>
    );
}

/**
 * The program stage's review.
 *
 * Deliberately not the bootloader one with fields blanked. This stage is the ordinary conversion:
 * it erases and writes windows the firmware was built to accept, and a failure leaves a DME that
 * still answers DS2. Showing the point-of-no-return warning here would train the operator to click
 * past it on the stage where it is real.
 */
function ReviewProgram(
    { facts, acked, onAck }:
    { facts: Extract<ReviewFacts, { kind: 'program' }>; acked: boolean; onAck: (v: boolean) => void },
): ReactNode {
    const c = t();
    return (
        <Card title={c.reviewProgramTitle} body={c.reviewBody}>
            <div className="rounded-lg bg-slate-900 p-3 grid grid-cols-2 gap-x-3 gap-y-3">
                <Readout label="VERSION" value={facts.variant.name || facts.variant.reference} tone="key" />
                {/* What will be attempted, not what holds. The switch happens inside the run and
                    can decline before it erases, so this is the request - the log reports the
                    outcome, and a fall back to 9600 costs the speed and nothing else. */}
                <Readout
                    label={facts.speed === 'fast' ? 'LINK (要求)' : 'LINK'}
                    value={facts.speed === 'fast' ? '125000' : '9600'}
                    tone={facts.speed === 'fast' ? 'warn' : undefined}
                />
                <Readout label="REFERENCE" value={facts.variant.reference} tone="key" />
                <Readout label="STAND" value={facts.variant.stand} />
                <Readout label="ZB" value={facts.variant.zb} />
                <Readout
                    label="MAP"
                    value={facts.patch.map === 'use' ? 'FITTED' : 'NOT FITTED'}
                    tone={facts.patch.map === 'use' ? undefined : 'warn'}
                />
                <Readout
                    label="FLAP"
                    value={facts.patch.flap === 'present' ? 'FITTED' : 'NOT FITTED'}
                    tone={facts.patch.flap === 'present' ? undefined : 'warn'}
                />
                <Readout
                    label="CAMS"
                    value={facts.patch.cams === 'csl' ? 'CSL' : 'STANDARD M3'}
                    tone={facts.patch.cams === 'csl' ? undefined : 'warn'}
                />
                <Readout
                    label="EDITS"
                    value={facts.patchPlaces === 0 ? 'NONE' : `${facts.patchPlaces} / ${facts.patchBytes} B`}
                    tone={facts.patchPlaces === 0 ? 'ok' : 'warn'}
                />
                <Readout
                    label="PROGRAM"
                    value={facts.programPatch ? 'COMMUNITY PATCH v1' : facts.program}
                    tone={facts.programPatch ? 'warn' : undefined}
                />
                <Readout label="WRITES" value={`${facts.writeBytes.toLocaleString()} B`} tone="warn" />
                <Readout
                    label="FILE CRC"
                    value={facts.variant.checksumValid ? 'VALID' : 'INVALID'}
                    tone={facts.variant.checksumValid ? 'ok' : 'bad'}
                />
            </div>

            {/* Listed, not summarised. This is the only screen where the operator can see that
                the program being written is not BMW's, and how far from it it is. */}
            {facts.programPatch && (
                <div className="rounded-lg bg-slate-900 p-3">
                    <span className="text-[9px] font-bold tracking-widest uppercase text-slate-500">
                        {c.reviewProgramPatchTitle(facts.programPatch.changedBytes)}
                    </span>
                    <div className="mt-2 space-y-1.5">
                        {facts.programPatch.edits.map((e) => (
                            <div key={e.id} className="flex items-baseline gap-2">
                                <span className="text-[10px] font-mono text-slate-400 shrink-0 selectable">
                                    {hex(e.offset)}
                                </span>
                                <span className="text-[10px] font-mono text-slate-600 shrink-0">{e.length} B</span>
                                <span className="text-[9px] leading-[1.4] text-slate-600 min-w-0">{e.note}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            <p className="text-[11px] leading-[1.6] text-slate-400">{c.reviewProgramWarn}</p>

            <label className="flex items-center gap-3 rounded-lg bg-slate-900 p-3 min-h-[56px]">
                <input
                    type="checkbox"
                    checked={acked}
                    onChange={(e) => onAck(e.target.checked)}
                    className="w-4 h-4 accent-blue-500 bg-slate-700 shrink-0"
                />
                <span className={`text-[10px] font-bold tracking-widest uppercase ${acked ? 'text-blue-400' : 'text-slate-400'}`}>
                    {c.reviewAck}
                </span>
            </label>
        </Card>
    );
}

// -------------------------------------------------------------------------------------------

/**
 * The stage running, and the one moment it stops for a person.
 *
 * The power-cycle prompt is not a confirmation - the decision was made at REVIEW and the ECU is
 * already armed by the time this appears. It is an instruction plus an acknowledgement that it has
 * been carried out, and it says plainly that abandoning it does not undo anything.
 */
export function RunStep(
    { stage, running, awaitingPowerCycle, practice }:
    { stage: JobStage | null; running: boolean; awaitingPowerCycle: boolean; practice?: boolean },
): ReactNode {
    const c = t();
    const title = stage ? stageName(stage) : c.flashTitle;

    if (awaitingPowerCycle) {
        return (
            <Card title={c.powerCycleTitle} body={c.powerCycleBody}>
                <Warning title={c.reviewPointOfNoReturn}>{c.powerCycleNoCancel}</Warning>
            </Card>
        );
    }

    return (
        <Card title={title} body={running ? c.flashNoCancel : c.flashArmed}>
            {practice && !running && (
                <p className="text-[10px] leading-[1.6] text-amber-400">{c.practiceRuns}</p>
            )}
            {!HARDWARE_WRITE_ENABLED && !practice && !running && (
                <div className="rounded-lg bg-slate-900 p-3">
                    <div className="flex items-center gap-1.5">
                        <span className="w-1 h-3 bg-indigo-400 rounded-sm" aria-hidden="true" />
                        <span className="text-[9px] font-bold tracking-widest uppercase text-indigo-400">
                            {c.lockedTitle}
                        </span>
                    </div>
                    <p className="mt-2 text-[10px] leading-[1.6] text-slate-300">{c.lockedBody}</p>
                    <p className="mt-2 text-[10px] leading-[1.6] text-slate-500">{c.lockedHow}</p>
                </div>
            )}
        </Card>
    );
}
