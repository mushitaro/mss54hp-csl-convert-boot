/**
 * The wizard: one question per screen, one hub, and a workspace that decides what comes next.
 *
 * ## Why the step is stored but nothing else is
 *
 * `step` is navigation - where the operator is looking - and storing it is legitimate. Everything
 * *about* a step is derived on every render from the workspace: whether a step can be reached, what
 * the hub says and does, whether a choice is available and why not. So the hub cannot say the wrong
 * thing, and a step whose data disappears bounces the operator back rather than sitting there
 * describing something that is no longer true.
 *
 * ## One write path
 *
 * Exactly one function sends bytes that modify the ECU, and it is reached from exactly one control.
 * The confirm gate, the safety copy and the aftermath all exist once. There is no second route
 * that arms an ECU with its own copy of the warnings.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PlugZap, Fingerprint, HardDriveDownload, ShieldCheck, ArrowRight, Flame, Check } from 'lucide-react';
import {
    Ds2Session, WriteLockedError, HARDWARE_WRITE_ENABLED, FAST_ENTRY_WRITE_ENABLED,
    FAST_READ_BAUD, buildPreservationPlan, serviceBlockMatches, planBytes,
    estimateRead, patchToCsl, extractSa0, assertLoaderCodeIsStageable, buildStagedSector,
    referenceCslSa0,
    conversionStages, practiceEcuImage, practiceProgrammingTransport,
    collectSpDaten, buildConversionImage, conversionWriteBytes,
    readPatchedProgram, type PatchedProgram,
    buildVariant, variantLabel, type VariantChoice,
    type SpDatenSet, type SpDatenVariant,
    realSecondsFor, runBlReplace, runFlash, planFlash, withSimulatedEcu,
    planBlReplace, assertBlReplaceable, buildProbeSector, planProbe,
    FULL_IMAGE_LENGTH, planWholeDmeRead, processorImageBase,
    compareReads, describeImageOffsets, CENSORED_RANGE,
    type PatchedBootloader,
} from 'dme-flash';
import { assemble } from '../../dme-flash/src/emulator/asm68k';
import replaceSource from '../../../tools/loader/replace.s?raw';
import probeSource from '../../../tools/loader/probe.s?raw';
import { Led, Wordmark, Notice, Hub, SubActions, SubAction, Progress, EventLog, type HubConfig, type LinkState, type NoticeKind } from './components';
import { SETUP_STEPS, isSetupStep, stageSteps, walkOrder, type StepId } from './wizard';
import { useScreenWakeLock } from './wakeLock';
import {
    LinkStep, IdentStep, BackupStep, PlanStep, PatchStep, SpeedStep, ReviewStep, RunStep, DoneStep,
    type BackupMode, type Speed, type IdentView, type ReviewFacts,
} from './steps';
import { t } from './copy';
import {
    openFtdiLink, downloadBytes, downloadLog, backupFilename, logFilename,
    UsbCancelled, LinkNotSupported, type OpenLink,
} from './usb';
import { linkBlock } from './platform';
import { uploadRun, uploadSupported } from './upload';
import { BUILD_ID, applyUpdate, isInstalled, setLinkBusy } from './pwa';


interface BackupResult {
    image: Uint8Array;
    verified: boolean;
    differingOffsets: readonly number[];
    seconds: number;
    /** How this capture came to be trusted - two passes against each other, or one against a file. */
    how: BackupMode;
}

interface Busy {
    phase: string;
    done: number;
    total: number;
}

/**
 * How often the progress bar is allowed to re-render.
 *
 * 100 ms is under a tenth of what a person perceives as a stall and comfortably above a frame, so
 * the bar still looks continuous. See `showProgress` for why the number exists at all.
 */
const PROGRESS_INTERVAL_MS = 100;

export interface AppProps {
    /** Handed a callback the entry point calls when a newer build has installed and is waiting. */
    onUpdateAvailable?: (handler: () => void) => void;
}

/**
 * The factory files bundled with the app, by name.
 *
 * A list rather than a glob because the service worker precaches these exact paths - a file added
 * to `public/spdaten/` and not added here would be fetched over the network and fail offline, in
 * the one place this app is meant to work.
 */
const BUNDLED_SP_DATEN = [
    '7837340A.0PA',
    'A7837329.0DA', 'A7837331.0DA', 'A7837333.0DA',
    'A7837335.0DA', 'A7837337.0DA', 'A7837339.0DA',
];

/**
 * The community-patched program, bundled on the same terms and precached the same way.
 *
 * Fetched only when the operator asks for it. It is verified against the SP-DATEN `.0PA` that is
 * already loaded, so it cannot be read before that is - and a file that does not verify never
 * becomes the program: `program` below falls back to the factory one and the failure is shown.
 */
const BUNDLED_PATCHED_PROGRAM = '211325000401PD31_Community_Patch_v1.bin';

/**
 * The CSL bootloader itself, 32 KiB: master SA0 then slave SA0.
 *
 * Fetched for the bootloader stages rather than derived from the car alone. `patchToCsl` still
 * derives - that is the provenance argument and it is kept - but what gets programmed is this,
 * so that a defect in one car's boot sector cannot be carried into the replacement. A real car
 * has already turned up carrying six bytes at slave 0x3FE4 that no reference image of either
 * flavour has, in a region the slave CRC does not cover.
 */
const BUNDLED_CSL_SA0 = 'csl-sa0.bin';

export default function App({ onUpdateAvailable }: AppProps = {}) {
    const c = t();
    /**
     * Why this device may not open a cable, or null when it may.
     *
     * Computed once: neither the platform nor `navigator.usb` can change while the tab is open.
     * The hub reads it to disable CONNECT, but it is not what enforces the rule - `openFtdiLink`
     * refuses on its own, so a screen that got this wrong still cannot reach a device.
     */
    const blocked = useMemo(() => linkBlock(), []);
    const usbAvailable = blocked === null;
    const installed = useMemo(() => isInstalled(), []);

    const linkRef = useRef<OpenLink | null>(null);
    const sessionRef = useRef<Ds2Session | null>(null);
    /** Resolves when the operator confirms they have cycled the ignition. */
    const powerCycleRef = useRef<(() => void) | null>(null);
    /** The simulated ECU, in practice only - so its reset handler can be run on a power cycle. */
    const practiceDmeRef = useRef<{ powerCycle: () => unknown[] } | null>(null);

    const [step, setStep] = useState<StepId>('LINK');
    const [connected, setConnected] = useState(false);
    const [ident, setIdent] = useState<IdentView | null>(null);
    const [backup, setBackup] = useState<BackupResult | null>(null);
    const [backupMode, setBackupMode] = useState<BackupMode>('two-pass');
    const [speed, setSpeed] = useState<Speed | null>(null);
    const [acked, setAcked] = useState(false);
    const [busy, setBusy] = useState<Busy | null>(null);
    const [notice, setNotice] = useState<{ kind: NoticeKind; text: string } | null>(null);
    const [events, setEvents] = useState<string[]>([]);
    /**
     * Whether this backup is a current copy of the DME on the cable.
     *
     * `null` means NOT YET CHECKED, and it is a separate value from "checked and matching" on
     * purpose. The previous shape used `string | null` where null meant both, and that ambiguity is
     * exactly how a file loaded from another ECU reached the review screen: everything downstream
     * read "not a failure" as "confirmed".
     */
    const [ecuMatch, setEcuMatch] = useState<{ same: boolean; reason: string } | null>(null);
    const [updateWaiting, setUpdateWaiting] = useState(false);
    /**
     * The factory software the program stage writes, and which of its six builds was chosen.
     *
     * SP-DATEN rather than a prepared 1 MiB blob: the six CSL variants differ only in calibration,
     * every one of them names itself in its own header, and the image is assembled here. That
     * makes the choice a choice between things BMW shipped instead of between filenames. Nothing
     * is bundled - the operator supplies their own package.
     */
    const [spDaten, setSpDaten] = useState<SpDatenSet | null>(null);
    const [variant, setVariant] = useState<SpDatenVariant | null>(null);
    /**
     * Which program the conversion writes.
     *
     * A separate axis from the six builds, because it is one: the two integrity words the patch
     * carries do not move with the calibration (three genuine dumps with three different
     * calibrations agree on both), so any of the six composes with either program.
     */
    const [programChoice, setProgramChoice] = useState<'factory' | 'patched'>('factory');
    const [patchedProgram, setPatchedProgram] = useState<PatchedProgram | null>(null);
    const [cslSa0, setCslSa0] = useState<Uint8Array | null>(null);

    /**
     * What the car has, one answer at a time.
     *
     * `Partial`, and the completed choice is derived - because a whole `VariantChoice` cannot
     * represent "two of three answered". Holding one meant that answering a single question
     * produced a complete object with the other two silently filled in as genuine CSL, and the
     * step advanced. The operator was never asked, and the screen that says there is no default
     * had quietly supplied one.
     *
     * There is no default on purpose. Genuine CSL is wrong for the car this tool exists to convert
     * - a standard M3 has neither part and, if the community values are right, not the cams either
     * - while defaulting the other way would edit BMW's parameters without anyone asking.
     */
    const [patch, setPatch] = useState<Partial<VariantChoice>>({});

    /** The choice, once every question has an answer. Null while any of them does not. */
    const patchChoice = useMemo((): VariantChoice | null => (
        patch.map && patch.flap && patch.cams
            ? { map: patch.map, flap: patch.flap, cams: patch.cams }
            : null
    ), [patch]);
    /** Set when the program stage has been run in THIS session - see the note on `job`. */
    const [programDone, setProgramDone] = useState(false);
    /**
     * Set when the probe has been run in THIS session.
     *
     * Session-scoped for the same reason the program stage is, and for a sharper one: a successful
     * probe leaves the DME byte-for-byte as it found it, so there is deliberately nothing on the
     * ECU that records it. A stored claim would be a claim nothing could check.
     */
    const [probeDone, setProbeDone] = useState(false);
    /** True while the run is stopped waiting for a human to cycle the ignition. */
    const [awaitingPowerCycle, setAwaitingPowerCycle] = useState(false);
    /** True while the session is talking to a simulator instead of a car. */
    const [practice, setPractice] = useState(false);

    useEffect(() => { onUpdateAvailable?.(() => setUpdateWaiting(true)); }, [onUpdateAvailable]);
    // What the service worker is told when it asks whether an update may download now. Connected
    // counts as well as running: between two operations a reload would still drop the link and
    // everything read over it.
    useEffect(() => { setLinkBusy(connected || busy !== null); }, [connected, busy]);

    const log = useCallback((line: string) => setEvents((prev) => [...prev, line]), []);

    /**
     * Whether this screen was backgrounded while something was running.
     *
     * Measured on the deployed build: with the tab hidden, `setTimeout(8)` returns after about
     * 946 ms. That is Chrome clamping background timers, and it applies to the WebUSB backend's
     * receive poll as well - a read waiting on 2 ms ticks with a 2000 ms budget gets two attempts
     * instead of a thousand, so a hidden tab does not slow a transfer down, it fails it.
     *
     * The app already told people not to background it. This notices when they did anyway, which is
     * the part that matters: they were not looking at the screen while it happened, so the fact has
     * to still be there when they come back.
     */
    const [wentHidden, setWentHidden] = useState(false);

    /**
     * The screen stays on while the link is working.
     *
     * Not comfort: the chip's receive FIFO is ~267 ms of headroom at 9600 and the only thing
     * draining it is a loop on this thread, so a backgrounded - or frozen - page overruns the cable
     * during an hour-long read. Tied to `busy` so it is held only while there is
     * something to protect - and note the power-cycle prompt is a `busy` state where the operator
     * is at the car with the app in hand, which is precisely when the screen must not blank.
     */
    useScreenWakeLock(busy !== null);
    const busyRef = useRef(false);
    useEffect(() => {
        const onVisibility = (): void => {
            if (document.visibilityState === 'hidden' && busyRef.current) setWentHidden(true);
        };
        document.addEventListener('visibilitychange', onVisibility);
        return () => document.removeEventListener('visibilitychange', onVisibility);
    }, []);

    /**
     * Which processor is next, read off what IDENT found rather than asked for.
     *
     * The rule and the reasons behind it live in `conversionStages` - it is knowledge about these
     * bootloaders, not about this screen, and it is tested against real dumps there. All this does
     * is hold the answer while there is no ECU to ask.
     */
    const conversion = useMemo(
        () => (ident
            ? conversionStages(ident.master.flavour, ident.slave.flavour)
            : { next: null, stage: 0, total: 0, done: [], blocked: false }),
        [ident]);

    /**
     * The whole job, as stages, with the one that is next.
     *
     * Three stages, not two, and the third is the one the wizard used to be missing: replacing the
     * bootloaders changes what the DME says it is, and writing the program is what makes the car a
     * CSL. A flow that stopped after the bootloaders would have converted nothing.
     *
     * Only the bootloader stages can be derived from the ECU - `identifyBootloader` reads an operand
     * out of SA0. There is no equivalent for the program: its identity lives in the calibration, and
     * this app has not read it. So that stage is marked done by having been run here, and if it was
     * run in an earlier session the operator runs it again - which costs time and writes the same
     * bytes, rather than claiming a state nothing checked.
     */
    const job = useMemo(() => {
        const stages = [
            /**
             * The probe, first and not optional.
             *
             * Arming is the irreversible act, and there is no rehearsal for it: the magic is checked
             * by the reset handler before the SIM, the stack or the K-line come up, so the first
             * arming is the first execution. What can be chosen is WHAT gets armed first - and the
             * smallest program that proves the machine setup works, touches no bootloader, and
             * clears its own magic is a far better first thing than a 16 KiB SA0 rewrite.
             *
             * Marked done by having been run in this session, like the program stage and for the
             * same reason: the probe deliberately leaves the ECU exactly as it found it, so there
             * is nothing on the DME to read back that would say it happened. Re-running it costs a
             * couple of minutes and proves the same thing again, which is better than claiming a
             * state nothing checked.
             */
            { id: 'probe', kind: 'probe' as const, processor: 'slave' as const, done: probeDone },
            ...(['slave', 'master'] as const).map((processor) => ({
                id: `bootloader-${processor}`,
                kind: 'bootloader' as const,
                processor,
                done: conversion.done.includes(processor),
            })),
            { id: 'program', kind: 'program' as const, processor: undefined, done: programDone },
        ];
        return { stages, next: stages.find((stage) => !stage.done) ?? null, blocked: conversion.blocked };
    }, [conversion, programDone, probeDone]);

    /**
     * The 1 MiB the program stage writes: the chosen factory build, edited for the car's hardware.
     *
     * Returns the failure instead of swallowing it. A `null` here used to mean both "not chosen
     * yet" and "cannot be built", and the second one reached REVIEW as a blank screen with no way
     * forward - the operator could see no reason and had nothing to act on.
     */
    const program = useMemo((): {
        image: Uint8Array; label: string; places: number; bytes: number;
    } | { error: string } | null => {
        if (!spDaten?.program || !variant || !patchChoice) return null;
        // The patched program is used only once it has been read AND verified against this very
        // .0PA. Until then the factory program stands, so a verification that failed can never
        // quietly become "wrote something else".
        const chosen = programChoice === 'patched' ? patchedProgram : spDaten.program;
        if (!chosen) return null;
        try {
            const built = buildVariant(variant.pair, patchChoice);
            return {
                image: buildConversionImage(chosen, { ...variant, pair: built.pair }),
                label: variantLabel(patchChoice),
                places: built.manifest.edits.length,
                bytes: built.manifest.changedBytes,
            };
        } catch (error) {
            return { error: message(error) };
        }
    }, [spDaten, variant, patchChoice, programChoice, patchedProgram]);

    const programSource = program && 'image' in program ? program.image : null;

    const stage = job.next;

    /**
     * Progress updates, rate-limited to one every PROGRESS_INTERVAL_MS.
     *
     * Found by watching a practice backup: the read callback fires once per chunk, which is ~8,250
     * times per pass, and every one of them was a `setState` and a re-render. That is not a
     * cosmetic waste on this app - the WebUSB backend drains the FT232R's 256-byte RX FIFO from the
     * main thread, and at 9600 baud that FIFO is about 267 ms of headroom. Rendering sixteen
     * thousand times during a transfer is exactly how a main-thread stall turns into an overrun.
     *
     * A progress bar cannot show more than the display refreshes anyway, so nothing is lost. The
     * final update is forced through so the bar always lands on its total rather than stopping at
     * whatever the last tick happened to catch.
     */
    useEffect(() => {
        busyRef.current = busy !== null;
        // Sampled on every busy transition as well as on visibilitychange, because that event only
        // fires on a CHANGE: an operation started from an already-backgrounded page never raises
        // one. It also has to live here rather than in showProgress - not every operation reports
        // progress, and IDENT (which sets busy directly) was the one that slipped through.
        if (busy !== null && document.hidden) setWentHidden(true);
    }, [busy]);

    const lastProgress = useRef(0);
    const showProgress = useCallback((next: Busy, force = false) => {
        const now = performance.now();
        if (!force && now - lastProgress.current < PROGRESS_INTERVAL_MS) return;
        lastProgress.current = now;
        setBusy(next);
    }, []);

    // --- what each step needs, stated once ---------------------------------------------------
    const reachable = useCallback((id: StepId): boolean => {
        switch (id) {
            case 'LINK': return true;
            case 'IDENT': return connected;
            case 'BACKUP': return connected && ident !== null;
            // Two things, and the second is not redundant. `verified` says the read was faithful;
            // `ecuMatch` says it is a copy of THIS ECU. A file loaded from another car can satisfy
            // the first and not the second, and it is this step that starts using the capture as
            // the source of the bootloader that would be written.
            case 'PLAN': return backup !== null && backup.verified && ecuMatch?.same === true;
            // Both belong to the program stage only - see the note on the step lists.
            case 'PATCH': return stage?.kind === 'program' && variant !== null;
            case 'SPEED': return stage?.kind === 'program' && patchChoice !== null;
            case 'REVIEW': return stage !== null
                && (stage.kind !== 'program' || (patchChoice !== null && speed !== null));
            case 'RUN': return stage !== null && acked
                && (stage.kind !== 'program' || (patchChoice !== null && speed !== null));
        }
    }, [connected, ident, backup, stage, speed, acked, ecuMatch, variant, patchChoice]);

    /** Every stage is finished. There is no next thing to plan, and saying so is the screen. */
    const allDone = job.stages.length > 0 && job.stages.every((x) => x.done);

    /**
     * The whole job in one indicator: every step of every stage, at once.
     *
     * A counter scoped to the current phase was worse than the flat 1..7 it replaced. Both hid the
     * same thing - how much of the job is left - and the phase-scoped one hid it while looking like
     * it was answering the question. This shows all of it: the ticks are grouped by stage, they
     * fill left to right, and the number is an absolute position that only ever goes up.
     */
    const rail = useMemo(() => {
        const groups = [
            { key: 'setup', label: c.railSetup, steps: SETUP_STEPS as readonly StepId[] },
            ...job.stages.map((x) => ({
                key: x.id,
                label: x.kind === 'program' ? c.railProgram
                    : x.kind === 'probe' ? c.railProbe
                        : c.railBootloader(x.processor ?? ''),
                // From the same function the walking order comes from. Two places deciding which
                // steps a stage has is how the rail and the BACK button come to disagree.
                steps: stageSteps(x.kind),
            })),
        ];
        const total = groups.reduce((n, g) => n + g.steps.length, 0);

        // Which group the operator is standing in. Once every stage is done there is no current
        // group, and the bar reads as complete rather than parking at the start of the last one.
        const key = isSetupStep(step) ? 'setup' : stage?.id;
        const at = Math.max(0, groups.findIndex((g) => g.key === key));
        const before = groups.slice(0, at).reduce((n, g) => n + g.steps.length, 0);
        const index = allDone ? total : before + Math.max(0, groups[at]!.steps.indexOf(step));

        let n = 0;
        return {
            label: allDone ? c.railProgram : groups[at]!.label,
            position: Math.min(index + (allDone ? 0 : 1), total),
            total,
            groups: groups.map((g) => ({
                key: g.key,
                ticks: g.steps.map((id) => {
                    const state = n < index ? 'done' : n === index ? 'now' : 'todo';
                    n++;
                    return { key: `${g.key}:${id}`, state };
                }),
            })),
            sequence: walkOrder(stage?.kind),
        };
    }, [step, stage, job, allDone, c]);

    const goNext = useCallback(() => {
        const order = rail.sequence;
        const next = order[order.indexOf(step) + 1];
        if (next && reachable(next)) setStep(next);
    }, [step, reachable, rail]);

    /**
     * The previous step that still exists.
     *
     * Walks back past steps that are no longer reachable rather than stepping onto one and letting
     * the guard clean up. Stepping first was visible: BACK from a finished run landed on a stage's
     * REVIEW, which no longer had a stage, and the recovery dropped the operator on the backup
     * screen - two screens away from where they pressed it, with the job already complete.
     */
    const goBack = useCallback(() => {
        const order = rail.sequence;
        for (let i = order.indexOf(step) - 1; i >= 0; i--) {
            const previous = order[i]!;
            if (reachable(previous)) { setStep(previous); return; }
        }
    }, [step, rail, reachable]);

    // The guard. A step whose data went away (a cable pulled mid-backup) must not stay on screen
    // describing a workspace that no longer exists.
    useEffect(() => {
        if (!reachable(step)) {
            const fallback = [...rail.sequence].reverse().find(reachable) ?? 'LINK';
            setStep(fallback);
        }
    }, [reachable, step, rail]);

    // --- fast entry: available, and if not, why ----------------------------------------------
    /**
     * Why FAST ENTRY cannot be chosen, when it cannot.
     *
     * One reason, not two. By the time this screen renders, `reachable('PLAN')` has already
     * required a verified capture that matches this ECU - so "no backup" and "wrong ECU" are both
     * unreachable here, and naming them would be offering the operator a diagnosis that cannot be
     * true. What remains is the plan refusing because the capture's service block is blank.
     */
    const fastLocked: string | undefined = useMemo(() => {
        // The reversible tier, not the master switch. Fast entry erases and restores one 8 KiB
        // sector and never goes near the magic, so it is gated separately from arming - and it is
        // open on this build. Offering it while it could not run meant the session died at the
        // first control telegram with an error about an erase nobody had reason to expect.
        if (!FAST_ENTRY_WRITE_ENABLED && !practice) return c.speedFastLockedByWriteLock;
        return buildPreservationPlan(backup).safe ? undefined : c.speedFastLockedBlankBlock;
    }, [backup, practice, c]);

    const restoreBytes = useMemo(() => {
        const plan = buildPreservationPlan(backup);
        return plan.safe ? planBytes(plan.spans) : 0;
    }, [backup]);

    // --- actions -----------------------------------------------------------------------------

    const connect = useCallback(async () => {
        setNotice(null);
        setBusy({ phase: 'CONNECT', done: 0, total: 1 });
        try {
            const link = await openFtdiLink();
            linkRef.current = link;
            sessionRef.current = new Ds2Session(link.transport, { onTraffic: undefined });
            setConnected(true);
            log(`USB link open at ${link.transport.baudRate} baud, 8E1`);
            setStep('IDENT');
        } catch (error) {
            if (error instanceof UsbCancelled) {
                setNotice({ kind: 'info', text: c.linkPickerCancelled });
            } else if (error instanceof LinkNotSupported) {
                // Reached only if a caller got past the disabled control. Say the same thing the
                // LINK screen says, rather than the transport's internal wording.
                setNotice({ kind: 'error', text: c.linkBlockedNotAndroid });
            } else {
                // The transport's own message is raw English engineering text ("No bulk endpoint
                // pair on this USB device") and the notice is a two-line clamp - interpolating it
                // clipped the actionable half. It goes to the log, which scrolls.
                log(`USB ${message(error)}`);
                setNotice({ kind: 'error', text: c.linkNotFtdi });
            }
        } finally {
            setBusy(null);
        }
    }, [c, log]);

    /**
     * Enter practice: the same session class, pointed at a simulated DME.
     *
     * Nothing about the flow is special-cased downstream. The framing, the login, the addressing,
     * the two-pass comparison and every refusal are the production paths - only the bytes on the
     * other end are synthetic, and they are synthetic in a way that is obvious in the capture.
     */
    const startPractice = useCallback(() => {
        // The programming-capable simulator, not the read-only one. Practice runs the whole
        // sequence including the erase and the writes, so a mock that refuses programming control
        // would stop it at the first destructive telegram with a session-access error - which is
        // what it did, and which reads like a real ECU problem rather than a wiring mistake.
        const { transport, dme } = practiceProgrammingTransport(practiceEcuImage());
        practiceDmeRef.current = dme;
        sessionRef.current = new Ds2Session(transport);
        linkRef.current = null;
        setPractice(true);
        setConnected(true);
        setNotice(null);
        log('PRACTICE started: simulated DME, synthetic image, no cable');
        setStep('IDENT');
    }, [log]);

    const identify = useCallback(async () => {
        const session = sessionRef.current;
        if (!session) return;
        setNotice(null);
        setBusy({ phase: 'IDENT', done: 0, total: 3 });
        try {
            // The sequence lives in `Ds2Session.survey` - it is knowledge about what can be asked
            // of a DME without changing it, not about this screen, and putting it there is what
            // makes the login-refused path testable rather than only clickable.
            const found = await session.survey((done, total) =>
                setBusy({ phase: 'IDENT', done, total }));

            log(`IDENT ${found.ident}`);

            /**
             * A refused login ends the operation, but not the way it used to.
             *
             * It genuinely does end it: the bootloader read uses the linear 24-bit segments, and
             * the firmware gates those on an access bit only command 0x90 grants. There is no
             * version of this that reads SA0 without it.
             *
             * What changed is what the operator is left holding. Command 0x00 is not gated, so the
             * identification already succeeded - which means the cable, the address and the baud
             * rate are all fine and the ECU is alive. That is a different problem from "nothing is
             * talking", and it used to be reported as the same raw error.
             */
            if (!found.master || !found.slave) {
                log(`LOGIN refused: ${found.loginError ?? 'no reason given'}`);
                log('STOPPING: the full-space read needs the access bit cmd 0x90 grants');
                setNotice({ kind: 'error', text: c.identLoginRefused });
                return;
            }

            log('LOGIN accepted (cmd 0x90 seed/key)');
            const { master, slave } = found;
            setIdent({ ident: found.ident, master, slave, checksum: found.checksum });
            log(`SA0 master ${master.flavour} crc ${master.crc.stored.toString(16)} ${master.crc.valid ? 'ok' : 'BAD'}`);
            log(`SA0 slave ${slave.flavour} crc ${slave.crc.stored.toString(16)} ${slave.crc.valid ? 'ok' : 'BAD'}`);
        } catch (error) {
            setNotice({ kind: 'error', text: message(error) });
        } finally {
            setBusy(null);
        }
    }, [c, log]);

    /**
     * Capture, optionally at 125000.
     *
     * ## Why `boost` is here and not only in the program stage
     *
     * FAST ENTRY was wired to the SPEED step, and the SPEED step only appears for the program
     * write - which is behind the probe, which is behind the arming gate. So on a build where
     * arming is locked, the whole reversible tier was unreachable: the split that opened it could
     * not be exercised on a car at all, and telling the operator to "choose FAST ENTRY" pointed at
     * a screen they could not get to.
     *
     * A re-capture is the honest place for it. It needs a verified capture to work out what must
     * survive the erase, which a first backup by definition does not have and a second one does.
     *
     * ## What it costs
     *
     * One flash-counter slot, permanently - the counter only ever counts up. That is the normal
     * price of fast entry rather than a fault, and it is why this is a deliberate second action
     * instead of a faster default.
     */
    const runBackup = useCallback(async (boost = false) => {
        const session = sessionRef.current;
        if (!session) return;

        if (backupMode === 'load' && !boost) {
            document.getElementById('load-backup')?.click();
            return;
        }

        // Captured before the passes overwrite it. Fast entry reads the bytes that go back live off
        // the DME every time; what this file supplies is only WHICH spans have to survive.
        const restoreFrom = backup?.verified ? backup : null;
        if (boost && !restoreFrom) return;

        setNotice(null);
        setWentHidden(false);
        const started = performance.now();
        setBusy({ phase: 'BACKUP', done: 0, total: FULL_IMAGE_LENGTH * 2 });
        try {
            if (boost) {
                // The reference's order, kept: log in, THEN fast entry, then read on at 125000
                // without logging in again. Fast entry needs the programming session this grants,
                // and `fullBackup` is told below not to send a second 0x90 at the boosted rate.
                await session.ensureAccess();

                // Before the passes, so all of both run at whatever rate this settles on. A `false`
                // is a normal outcome that costs the speed and nothing else - it refuses everything
                // it finds wrong BEFORE the erase. A throw means the erase already happened, and
                // the message it carries says whether the service block came back.
                const boosted = await session.enterFastRead(restoreFrom, log);
                setNotice(boosted
                    ? { kind: 'ok', text: c.speedEngaged(FAST_READ_BAUD) }
                    : { kind: 'warn', text: c.speedFellBack });
            }

            const result = await session.fullBackup((p) => {
                const base = (p.pass - 1) * FULL_IMAGE_LENGTH + (p.processor === 'slave' ? p.totalBytes : 0);
                showProgress({
                    phase: `BACKUP PASS ${p.pass}`,
                    done: base + p.bytesRead,
                    total: FULL_IMAGE_LENGTH * 2,
                });
            }, { refreshAccess: !boost });
            const seconds = (performance.now() - started) / 1000;
            setBackup({
                image: result.image,
                verified: result.verified,
                differingOffsets: result.differingOffsets,
                seconds,
                how: 'two-pass',
            });
            log(`BACKUP ${result.image.length} bytes, `
                + `${result.verified ? 'two passes agree' : `DISAGREE at ${result.differingOffsets.length}`}, `
                + `${seconds.toFixed(0)} s`);

            if (result.verified) {
                // Captured through this session, so provenance is not in question - it came off the
                // ECU still on the other end of the cable. Only a loaded file has to prove that,
                // and it proves it against this same value.
                setEcuMatch({ same: true, reason: 'captured from this DME' });
                downloadBytes(result.image, backupFilename(
                    ident?.master.programNumbers?.[0] ?? 'unknown', true, new Date(), practice));
                setNotice({ kind: 'ok', text: c.backupSave });
            } else {
                setEcuMatch(null);
                setNotice({ kind: 'error', text: c.backupMismatch(result.differingOffsets.length) });
            }
        } catch (error) {
            setNotice({ kind: 'error', text: message(error) });
        } finally {
            setBusy(null);
        }
    // `backupMode` belongs here. Without it this callback kept whichever mode was selected when the
    // other dependencies last changed, so switching between two-pass and compare-with-a-file on
    // screen changed nothing about what BACKUP actually did - reported from a car, and exactly the
    // class of bug the wizard module was extracted to stop.
    }, [ident, backupMode, backup, c, log, practice, showProgress]);

    /**
     * Take a saved capture. It is not a backup of anything until the DME agrees with it.
     *
     * `verified: false` on arrival, deliberately. The flag means "this app watched a comparison
     * succeed", and nothing has been compared yet - a file carries no evidence about itself, and
     * the filename's own `_verified_` refers to a run on somebody else's screen.
     */
    const loadBackup = useCallback(async (file: File) => {
        const image = new Uint8Array(await file.arrayBuffer());
        if (image.length !== FULL_IMAGE_LENGTH) {
            setNotice({ kind: 'error', text: `${file.name}: ${image.length} bytes, a full capture is 1 MiB` });
            return;
        }
        setBackup({ image, verified: false, differingOffsets: [], seconds: 0, how: 'load' });
        setEcuMatch(null);
        setNotice({ kind: 'info', text: c.hubCheckingEcu });
        log(`LOADED ${file.name} (${image.length} bytes) - not verified yet`);
    }, [c, log]);

    /**
     * Verify a loaded file against the ECU: one full read, compared to the file.
     *
     * **This is what a single pass is for.** A read on its own proves nothing; a read is a
     * verification only when it has a reference. Two passes make the second read the reference.
     * Here the reference is the file - which was itself verified when it was made - so one read is
     * enough, and it costs half as long as capturing afresh.
     *
     * It also answers a question the previous version never asked. That one compared the 8 KiB
     * service block and nothing else: 0.76% of the file, enough to say "same car" and not remotely
     * enough to say "this file is what is on that car". The other 99.2% - the bootloader this tool
     * is about to read its replacement out of, and every byte anyone would ever restore - went
     * unchecked.
     *
     * The service block is still compared first, on its own, because it is thirty seconds against
     * thirteen minutes: the wrong car should be caught before committing to the full read.
     */
    const verifyAgainstFile = useCallback(async () => {
        const session = sessionRef.current;
        const loaded = backup;
        if (!session || !loaded) return;

        setNotice({ kind: 'info', text: c.backupPreCheck });
        setWentHidden(false);
        setBusy({ phase: 'PRE-CHECK', done: 0, total: 1 });
        const started = performance.now();
        try {
            // Same reason as `fullBackup`: the linear segments need the access bit, and it lapses
            // while the operator is picking a file. Both read paths refresh it, because the one
            // that did not is the one that failed on a car.
            await session.ensureAccess();

            const block = await session.readServiceBlock('master');
            const provenance = serviceBlockMatches(loaded, block, 'master');
            log(`SERVICE BLOCK ${provenance.reason}`);
            if (!provenance.same) {
                setEcuMatch(provenance);
                setNotice({ kind: 'error', text: c.backupWrongEcu(provenance.reason) });
                return;
            }
            setNotice({ kind: 'info', text: c.backupPreCheckOk });

            // The full single pass. Same read path as a capture; only the reference differs.
            const live = new Uint8Array(FULL_IMAGE_LENGTH).fill(0xff);
            let read = 0;
            for (const plan of planWholeDmeRead()) {
                const bytes = await session.runPlan(plan, (n) =>
                    showProgress({ phase: c.backupVerifying, done: read + n, total: FULL_IMAGE_LENGTH }));
                live.set(bytes, processorImageBase(plan.processor));
                read += bytes.length;
            }

            const comparison = compareReads(loaded.image, live);
            const seconds = (performance.now() - started) / 1000;
            log(`VERIFY ${comparison.identical ? 'file matches the DME' : `${comparison.differingOffsets.length} bytes differ`}`
                + `, ${seconds.toFixed(0)} s`);

            if (comparison.identical) {
                setBackup({ ...loaded, verified: true, seconds, how: 'load' });
                setEcuMatch({ same: true, reason: 'the whole image matches this DME' });
                setNotice({ kind: 'ok', text: c.backupFileVerified(FULL_IMAGE_LENGTH, seconds) });
                return;
            }

            // Same car - the service block already agreed - so the divergence is elsewhere, which
            // means the flash has been rewritten since. Naming the sectors is what separates
            // "wrong file" from "right file, out of date", and only the operator can act on that.
            const where = describeImageOffsets(comparison.differingOffsets).join(', ');
            setBackup({ ...loaded, verified: false, differingOffsets: comparison.differingOffsets, seconds, how: 'load' });
            setEcuMatch({ same: false, reason: where });
            // The count goes to the log; the notice leads with what to do, then names the sectors.
            // Concatenating both put ~245 characters into a two-line clamp, and the instruction -
            // the only part the operator can act on - was the half that clipped.
            log(c.backupFileDiffers(comparison.differingOffsets.length));
            setNotice({ kind: 'error', text: c.backupFileStale(where) });
        } catch (error) {
            setEcuMatch({ same: false, reason: message(error) });
            setNotice({ kind: 'error', text: message(error) });
        } finally {
            setBusy(null);
        }
    }, [backup, c, log, showProgress]);

    /**
     * The one write path.
     *
     * Everything above it is planning and reading. This is the only function in the app that could
     * change an ECU, and while `HARDWARE_WRITE_ENABLED` is false it does not get past the first
     * step that would - `buildStagedSector` throws before a byte is on the wire.
     */
    const runStage = useCallback(async () => {
        const session = sessionRef.current;
        if (!session || !stage || !backup) return;
        setNotice(null);
        setWentHidden(false);

        const hooks = {
            onEvent: log,
            onProgress: (p: { phase: string; note: string; written: number; total: number }) =>
                // Through the copy module, not `.toUpperCase()`. The executor's ids are internal
                // ('erase-calibration', 'write-staged') and were being shown verbatim, so the
                // Japanese UI narrated the most dangerous minutes of the job in English.
                showProgress({ phase: c.phaseName(p.phase), done: p.written, total: p.total }),
        };

        /**
         * The ignition is a physical act. Nothing here can perform it, so the run stops and waits -
         * and there is no cancel, because by this point the ECU is armed and the loader runs at the
         * next power-up whether this app is still open or not.
         */
        const onPowerCycle = (): Promise<void> => new Promise<void>((resolve) => {
            powerCycleRef.current = resolve;
            setAwaitingPowerCycle(true);
        });

        const execute = async (): Promise<void> => {
            if (stage.kind === 'probe') {
                const processor = stage.processor!;
                const loader = assemble(probeSource);
                assertLoaderCodeIsStageable(processor, loader.bytes);
                log(`PROBE assembled, ${loader.bytes.length} bytes`);

                const sector = buildProbeSector(processor, loader.bytes);
                const plan = planProbe(sector);
                assertBlReplaceable(plan);
                log(`PLAN ${plan.steps.length} steps, point of no return at ${plan.pointOfNoReturn}`);

                // The SA0 that is already there. For a probe this is also what must still be there
                // afterwards - the same comparison the replacement makes, meaning the opposite.
                const before = extractSa0(backup.image, processor);
                const outcome = await runBlReplace(session, plan, before, { ...hooks, onPowerCycle });

                if (!outcome.magicCleared) throw new Error(c.stageProbeMagicLeft);
                if (!outcome.matchesIntended) {
                    // The COUNT, not the length of the eight-entry sample beside it.
                    throw new Error(c.stageProbeTouchedSa0(outcome.differingCount));
                }
                setProbeDone(true);
                setNotice({ kind: 'ok', text: c.stageProbeDone(processor) });
                setAcked(false);
                setStep('PLAN');
                return;
            }

            if (stage.kind === 'bootloader') {
                const processor = stage.processor!;
                const patched = patchToCsl(
                    extractSa0(backup.image, processor), processor, cslSa0 ? referenceCslSa0(cslSa0, processor) : undefined);
                for (const a of patched.anomalies) {
                    log(`SA0 ANOMALY 0x${a.offset.toString(16)}: this ECU has`
                        + ` 0x${a.derived.toString(16).padStart(2, '0')}, every reference has`
                        + ` 0x${a.reference.toString(16).padStart(2, '0')}`
                        + `${a.outsideCrc ? ' (outside the CRC, so BMW never checked it)' : ''}`
                        + ' - the reference value will be written');
                }
                const loader = assemble(replaceSource);
                assertLoaderCodeIsStageable(processor, loader.bytes);
                log(`LOADER assembled, ${loader.bytes.length} bytes`);

                const sector = buildStagedSector(processor, loader.bytes, patched.sa0);
                const plan = planBlReplace(sector);
                assertBlReplaceable(plan);
                log(`PLAN ${plan.steps.length} steps, point of no return at ${plan.pointOfNoReturn}`);

                const outcome = await runBlReplace(session, plan, patched.sa0, { ...hooks, onPowerCycle });
                if (!outcome.matchesIntended || !outcome.crcValid) {
                    // `differingOffsets` is capped at eight examples. Reporting its length said
                    // "8 bytes differ" for a bootloader that read back entirely wrong - a number
                    // small enough to look like a glitch, where the operator decides whether to
                    // carry on to the processor that speaks DS2.
                    throw new Error(c.stageBlFailed(outcome.differingCount));
                }
                setNotice({ kind: 'ok', text: c.stageBlDone(processor) });
                return;
            }

            if (!programSource) throw new Error(c.programNeedsSource);

            /**
             * The speed the operator chose, actually taken.
             *
             * Before the plan, so everything after it - the erases, the writes and the read-back -
             * runs at whatever rate this settles on. `enterFastRead` is written to make that safe:
             * it refuses and returns false for anything it finds wrong BEFORE it erases, and only
             * throws once the Free Identifiers sector is already open. So a false is a normal
             * outcome that costs the speed and nothing else, and a throw must stop the stage - the
             * message it carries says the service block may not be intact, and writing a program
             * over a DME in that state is exactly what must not happen next.
             */
            if (speed === 'fast') {
                const boosted = await session.enterFastRead(backup, log);
                if (boosted) setNotice({ kind: 'ok', text: c.speedEngaged(FAST_READ_BAUD) });
                else setNotice({ kind: 'warn', text: c.speedFellBack });
            }

            const plan = planFlash({ image: programSource, windowKinds: ['program', 'calibration'] });
            log(`PLAN ${plan.steps.length} steps, ${plan.writeBytes} bytes, ${plan.eraseCount} erases`);
            const outcome = await runFlash(session, plan, programSource, {
                ...hooks,
                verifyReadBack: true,
            });
            /**
             * Two different failures, with opposite remedies.
             *
             * A read-back whose two passes disagree says nothing about the write - the DME may hold
             * exactly the right bytes. Telling the operator to write again would erase and rewrite a
             * DME because the cable glitched while checking it, which is the more dangerous of the
             * two actions and the one that does not address the fault.
             */
            if (!outcome.readBackAgreed) {
                throw new Error(c.stageProgramReadUnreliable(outcome.readBackDisagreements.length));
            }
            if (!outcome.verified) throw new Error(c.stageProgramFailed(outcome.differingOffsets.length));
            setProgramDone(true);
            setNotice({ kind: 'ok', text: c.stageProgramDone(outcome.comparedBytes) });
            // The job is over. Leaving the operator on a finished RUN with an inert DONE gave them
            // nothing that said so, and a BACK that walked into stages that no longer existed.
            setAcked(false);
            setStep('PLAN');
        };

        setBusy({ phase: 'RUN', done: 0, total: 1 });
        try {
            // The simulation scope opens the BUILD gate only. Whether these bytes reach anything is
            // decided by the transport, which a practice session made and a real one never can.
            if (practice) await withSimulatedEcu(execute);
            else await execute();
        } catch (error) {
            if (error instanceof WriteLockedError) {
                setNotice({ kind: 'warn', text: c.lockedTitle });
                log(`REFUSED: ${error.message}`);
            } else {
                setNotice({ kind: 'error', text: message(error) });
            }
            return;
        } finally {
            setBusy(null);
            setAwaitingPowerCycle(false);
            powerCycleRef.current = null;
        }

        // Back to the plan for whatever is left. Re-reading the bootloaders is what moves the job
        // on: the next stage is derived from the ECU, so it cannot disagree with the ECU.
        setAcked(false);
        await identify();
        setStep('PLAN');
    }, [stage, backup, programSource, practice, speed, c, log, showProgress, identify, cslSa0]);

    /**
     * Send this session to the project's D1, for judging afterwards.
     *
     * A test instrument, not a step of the job. It is behind an explicit control, because the
     * capture carries the VIN, the AIF and the flash counter of a specific car - that leaves the
     * phone when someone says so and not before. It is filed under the owner the gate signed in,
     * and nobody else can list or read it.
     *
     * Nothing here can fail a session: it runs only after a capture exists, and its failure is a
     * notice about an upload rather than anything about the DME.
     */
    const uploadSession = useCallback(async () => {
        if (!backup) return;
        setNotice(null);
        setBusy({ phase: 'UPLOAD', done: 0, total: 1 });
        try {
            // Read off the bytes rather than passed in: this is the check the whole real-car
            // session exists to make, and deriving it here means the stored answer describes the
            // capture rather than what the app believed at the time.
            const censoredBlank = backup.image
                .subarray(CENSORED_RANGE.start, CENSORED_RANGE.end)
                .every((b) => b === 0xff);

            const result = await uploadRun(backup.image, events, {
                label: ident?.ident ?? 'unidentified',
                createdAt: Date.now(),
                appBuild: BUILD_ID,
                ...(ident ? {
                    ident: ident.ident,
                    masterFlavour: String(ident.master.flavour),
                    masterCrc: ident.master.crc.stored.toString(16),
                    masterCrcValid: ident.master.crc.valid,
                    slaveFlavour: String(ident.slave.flavour),
                    slaveCrc: ident.slave.crc.stored.toString(16),
                    slaveCrcValid: ident.slave.crc.valid,
                } : {}),
                verified: backup.verified,
                differingCount: backup.differingOffsets.length,
                censoredBlank,
                elapsedSeconds: backup.seconds,
                wentHidden,
                ...(practice ? { note: 'PRACTICE - simulated DME, not a car' } : {}),
            });

            log(`UPLOADED ${result.id}: image ${(result.imageBytes / 1024).toFixed(0)} KB gz,`
                + ` log ${(result.logBytes / 1024).toFixed(0)} KB gz`);
            setNotice({ kind: 'ok', text: c.uploadDone(result.imageBytes) });
        } catch (error) {
            log(`UPLOAD failed: ${message(error)}`);
            setNotice({ kind: 'error', text: c.uploadFailed(message(error)) });
        } finally {
            setBusy(null);
        }
    }, [backup, events, ident, practice, wentHidden, c, log]);

    /** The operator says the ignition has been cycled. Resolves the promise the run is waiting on. */
    const confirmPowerCycle = useCallback(() => {
        // In practice, cycling the ignition is what makes the simulated ECU run its reset handler
        // and, if it is armed, the loader. Doing it here rather than inside the executor keeps the
        // executor identical for a real car, where this line has no counterpart because the ECU
        // does it by itself.
        const ran = practiceDmeRef.current?.powerCycle();
        if (ran && ran.length > 0) log(`RESET HANDLER ran the loader on: ${ran.join(', ')}`);
        const resolve = powerCycleRef.current;
        powerCycleRef.current = null;
        setAwaitingPowerCycle(false);
        resolve?.();
    }, [log]);

    /**
     * Read a set of SP-DATEN files - typically the whole MSS54 folder - and find the CSL builds.
     *
     * Everything that is not a CSL build is reported as rejected rather than filtered away: a
     * folder selection hands over every E46 build BMW ships, and quietly narrowing it to six would
     * leave the operator unable to tell whether their package was the right one.
     */
    const ingestSpDaten = useCallback((
        read: readonly { name: string; bytes: Uint8Array }[], source: string,
    ) => {
        const set = collectSpDaten(read);
        setSpDaten(set);
        setVariant(null);
        // A different package means the patch was verified against a program that is no longer
        // loaded. Drop it rather than carry a proof about bytes that have been replaced.
        setPatchedProgram(null);
        setProgramChoice('factory');
        log(`SP-DATEN (${source}) ${set.variants.length} CSL calibration(s), `
            + `program ${set.program?.file ?? 'MISSING'}, ${set.rejected.length} other file(s)`);
        for (const variantFound of set.variants) {
            log(`  ${variantFound.reference}  ${variantFound.name}  (${variantFound.file})`);
        }
        setNotice(set.variants.length === 0
            ? { kind: 'error', text: c.programNoVariants }
            : !set.program
                ? { kind: 'error', text: c.programNoProgram }
                : { kind: 'ok', text: c.programPickPrompt });
    }, [c, log]);

    /**
     * The factory files that ship with the app.
     *
     * Loaded without being asked for, because the alternative was asking someone standing at a car
     * to find an SP-DATEN package on their phone. They are precached by the service worker, so
     * this resolves with no signal - which is the launch this app is actually for.
     */
    const loadBundledSpDaten = useCallback(async () => {
        setBusy({ phase: 'SP-DATEN', done: 0, total: 1 });
        try {
            const manifest: string[] = BUNDLED_SP_DATEN;
            const read = await Promise.all(manifest.map(async (name) => {
                const response = await fetch(`/spdaten/${name}`);
                if (!response.ok) throw new Error(`${name}: ${response.status}`);
                return { name, bytes: new Uint8Array(await response.arrayBuffer()) };
            }));
            ingestSpDaten(read, 'bundled');
        } catch (error) {
            setNotice({ kind: 'error', text: message(error) });
        } finally {
            setBusy(null);
        }
    }, [ingestSpDaten]);

    /**
     * Read the community-patched program and prove it is the patch this tool knows.
     *
     * Verification needs the factory program, so this can only run once SP-DATEN is loaded - and
     * that is the point: what gets checked is the DIFFERENCE between the two files, which is the
     * only part of the patched program that is not BMW's. A file that fails goes nowhere; the
     * choice snaps back to the factory program so that a refusal cannot read as an acceptance.
     */
    const loadPatchedProgram = useCallback(async () => {
        if (!spDaten?.program) return;
        setBusy({ phase: 'PATCH', done: 0, total: 1 });
        try {
            const response = await fetch(`/program/${BUNDLED_PATCHED_PROGRAM}`);
            if (!response.ok) throw new Error(`${BUNDLED_PATCHED_PROGRAM}: ${response.status}`);
            const verified = readPatchedProgram(
                BUNDLED_PATCHED_PROGRAM,
                new Uint8Array(await response.arrayBuffer()),
                spDaten.program);
            setPatchedProgram(verified);
            setProgramChoice('patched');
            setNotice(null);
            log(`PROGRAM ${verified.patchId} verified against ${spDaten.program.file}: `
                + `${verified.edits.length} span(s), ${verified.changedBytes} byte(s) differ`);
            for (const edit of verified.edits) {
                log(`  ${edit.id} @ 0x${edit.offset.toString(16)} (${edit.length} B)`);
            }
        } catch (error) {
            setPatchedProgram(null);
            setProgramChoice('factory');
            setNotice({ kind: 'error', text: message(error) });
            log(`PROGRAM patch REFUSED: ${message(error)}`);
        } finally {
            setBusy(null);
        }
    }, [spDaten, log]);

    /**
     * Fetch the reference CSL bootloader before the first bootloader stage needs it.
     *
     * A failure here is not fatal and must not be: `patchToCsl` without a reference is the
     * behaviour this tool had all along, and it still produces a correct sector for every car
     * whose own SA0 is intact. What is lost is the check, so it is logged rather than swallowed.
     */
    const loadCslSa0 = useCallback(async () => {
        if (cslSa0) return;
        try {
            const response = await fetch(`/bootloader/${BUNDLED_CSL_SA0}`);
            if (!response.ok) throw new Error(`${BUNDLED_CSL_SA0}: ${response.status}`);
            const bytes = new Uint8Array(await response.arrayBuffer());
            setCslSa0(bytes);
            log(`SA0 reference loaded, ${bytes.length} bytes`);
        } catch (error) {
            log(`SA0 reference unavailable (${message(error)}); deriving from this ECU only`);
        }
    }, [cslSa0, log]);

    /** An override, for a package other than the bundled one. */
    const loadSpDatenFiles = useCallback(async (files: FileList) => {
        const read = await Promise.all(Array.from(files).map(async (f) => ({
            name: f.name,
            bytes: new Uint8Array(await f.arrayBuffer()),
        })));
        ingestSpDaten(read, 'selected by the operator');
    }, [ingestSpDaten]);

    // Fetched when the program stage becomes the one in front of the operator, not at launch:
    // the two bootloader stages have no use for it, and the offline copy is already on the device.
    useEffect(() => {
        if (stage?.kind === 'program' && !spDaten && !busy) void loadBundledSpDaten();
        if ((stage?.kind === 'bootloader' || stage?.kind === 'probe') && !cslSa0) void loadCslSa0();
    }, [stage, spDaten, busy, loadBundledSpDaten, cslSa0, loadCslSa0]);

    /**
     * Tear the workspace down, whichever kind of link it was.
     *
     * Everything derived from the old ECU goes with it - the capture especially. A backup taken in
     * practice must not still be sitting there when a real cable is plugged in, or the next screen
     * would offer to plan a bootloader replacement from a synthetic image.
     */
    const disconnect = useCallback(async () => {
        const wasPractice = practice;
        await linkRef.current?.close();
        linkRef.current = null;
        sessionRef.current = null;
        setConnected(false);
        setPractice(false);
        setIdent(null);
        setBackup(null);
        setSpeed(null);
        setAcked(false);
        setEcuMatch(null);
        setSpDaten(null);
        setVariant(null);
        setPatchedProgram(null);
        setProgramChoice('factory');
        setPatch({});
        setProgramDone(false);
        practiceDmeRef.current = null;
        setStep('LINK');
        setNotice(null);
        // The log goes too, and that is the point rather than tidiness: a log describing a practice
        // run, left sitting under a fresh session with a real cable in it, is a record of something
        // that did not happen to this car. Same rule as the backup - clear at the start of an
        // attempt, so "no history" can only ever mean "nothing has happened yet".
        setEvents([wasPractice ? 'PRACTICE ended; workspace and log cleared' : 'USB link closed']);
    }, [practice]);

    useEffect(() => () => { void linkRef.current?.close(); }, []);

    // --- the hub, derived --------------------------------------------------------------------
    const hub: HubConfig = useMemo((): HubConfig => {
        // `awaitingPowerCycle` beats `busy`, and the distinction is the point: while the run waits
        // for a human to turn a key, the app is not working - it is stopped. Showing the busy face
        // here left the only control that can continue the run unreachable, with the ECU armed.
        if (busy && !awaitingPowerCycle) {
            return { label: busy.phase.split(' ')[0] ?? 'BUSY', Icon: PlugZap, onClick: () => {}, busy: true };
        }
        switch (step) {
            case 'LINK':
                return { label: 'CONNECT', Icon: PlugZap, onClick: () => void connect(), disabled: !usbAvailable };
            case 'IDENT':
                return ident
                    ? { label: 'NEXT', Icon: ArrowRight, onClick: goNext }
                    : { label: 'IDENTIFY', Icon: Fingerprint, onClick: () => void identify() };
            case 'BACKUP':
                // Three faces, and each label is a promise about what pressing it produces.
                // NEXT needs both questions answered: the bytes were compared against something,
                // and that something belongs to this ECU.
                if (backup?.verified && ecuMatch?.same === true) {
                    return { label: 'NEXT', Icon: ArrowRight, onClick: goNext };
                }
                if (backupMode === 'load' && backup) {
                    return { label: 'VERIFY', Icon: ShieldCheck, onClick: () => void verifyAgainstFile() };
                }
                return {
                    label: backupMode === 'load' ? 'LOAD' : 'BACKUP',
                    Icon: HardDriveDownload,
                    onClick: () => void runBackup(),
                };
            case 'PLAN':
                // Nothing left to plan. Not a disabled NEXT - there is no next, and a greyed arrow
                // would suggest one exists and is being withheld.
                if (allDone) return { label: 'DONE', Icon: Check, onClick: () => {}, disabled: true };
                // No LOAD face: the factory files ship with the app, so by the time this screen
                // renders the six builds are already on it. Choosing one is the only thing left.
                // Gated on the version, not the assembled image - the image also needs the
                // hardware answers, and those are asked on the step after this one.
                if (stage?.kind === 'program' && !variant) {
                    return { label: 'NEXT', Icon: ArrowRight, onClick: goNext, disabled: true };
                }
                return { label: 'NEXT', Icon: ArrowRight, onClick: goNext, disabled: stage === null };
            case 'PATCH':
                return {
                    label: 'NEXT', Icon: ArrowRight, onClick: goNext,
                    disabled: patchChoice === null || (program !== null && 'error' in program),
                };
            case 'SPEED':
                return { label: 'NEXT', Icon: ArrowRight, onClick: goNext, disabled: speed === null };
            case 'REVIEW':
                return { label: 'FLASH', Icon: Flame, onClick: goNext, disabled: !acked, danger: true };
            case 'RUN':
                // The one face that is not an action: the run is stopped, waiting for a person to
                // do the one thing software cannot. Not danger-red - the danger already happened,
                // and pressing this is how the operator gets out of it.
                if (awaitingPowerCycle) {
                    return { label: 'POWER CYCLED', Icon: Check, onClick: confirmPowerCycle };
                }
                if (!job.next) return { label: 'DONE', Icon: Check, onClick: () => {}, disabled: true };
                return { label: 'FLASH', Icon: Flame, onClick: () => void runStage(), danger: true };
            default:
                return { label: 'WAIT', Icon: PlugZap, onClick: () => {}, disabled: true };
        }
    }, [busy, step, usbAvailable, ident, backup, backupMode, ecuMatch, stage, job, variant,
        patchChoice, program, allDone, speed, acked, awaitingPowerCycle, connect, identify,
        runBackup, verifyAgainstFile, goNext, runStage, confirmPowerCycle]);

    /**
     * Why the hub cannot act, in one sentence, derived from the same condition that disables it.
     *
     * This is the other half of a disabled control: the reason has to be on screen. A `title` is a
     * mouse convenience, and on a phone it does not exist at all - the reference project lost two
     * complete test drives to a locked control whose explanation was reachable only by hovering.
     */
    const hubReason: string | null = useMemo(() => {
        if (busy) return null;
        if (step === 'LINK' && blocked === 'not-android') return c.hubNeedsAndroid;
        if (step === 'LINK' && blocked === 'no-webusb') return c.hubNeedsUsb;
        if (step === 'PLAN' && job.blocked) return c.targetUnknownBl;
        if (step === 'PLAN' && allDone) return c.doneNext;
        if (step === 'PLAN' && stage === null) return c.hubNothingToConvert;
        if (step === 'PLAN' && stage?.kind === 'program' && spDaten && !variant) return c.programPickPrompt;
        if (step === 'PATCH' && program !== null && 'error' in program) return c.patchFailed(program.error);
        if (step === 'PATCH' && patchChoice === null) return c.patchPickBoth;
        if (step === 'RUN' && awaitingPowerCycle) return c.powerCycleNoCancel;
        if (step === 'SPEED' && speed === null) return c.hubPickOne;
        if (step === 'REVIEW' && !acked) return c.hubScrollToAck;
        // A loaded capture that has not been checked, or has been checked and is not from this ECU,
        // stops here. Rendered rather than left to a tooltip: there is no hover on a phone.
        if (step === 'BACKUP' && backup && !backup.verified && ecuMatch === null) return c.hubCheckingEcu;
        if (step === 'BACKUP' && ecuMatch?.same === false) return c.hubWrongEcu;
        return null;
    }, [busy, step, blocked, stage, job, allDone, spDaten, variant, patchChoice, program,
        speed, acked, backup, ecuMatch, awaitingPowerCycle, c]);

    const linkState: LinkState =
        (busy && !awaitingPowerCycle) ? 'busy' : notice?.kind === 'error' ? 'error'
            : practice ? 'practice' : connected ? 'ok' : 'disconnected';

    /**
     * One line in the reserved slot, chosen by priority rather than stacked.
     *
     * An error the operator has not dismissed outranks the standing reason a control is inert,
     * which outranks a background fact about the build. Three messages in a 34px box would be
     * three truncated messages.
     */
    const slot: { kind: NoticeKind; text: string } | null =
        // Outranks even an error, because it casts doubt on what the error - or the success - is
        // describing. Shown DURING the run as well as after it: the operator reads this at the
        // moment they come back, and what they see then is a progress bar crawling for no visible
        // reason. Gating it on the run being over would hide it exactly when it explains something.
        wentHidden ? { kind: 'error', text: c.wentHidden }
            : notice ?? (hubReason ? { kind: 'info', text: hubReason }
                : updateWaiting ? { kind: 'warn', text: c.updateWaiting } : null);

    const reviewFacts: ReviewFacts | null = useMemo(() => {
        // `speed` is required by the program stage and does not exist for a bootloader one, so it
        // is checked in the branch that needs it. Demanding it up front is what made this return
        // null and REVIEW render nothing - the same failure the program stage had, arriving from
        // the other direction once SPEED stopped being a step every stage walks through.
        if (!stage) return null;

        if (stage.kind === 'program') {
            if (!spDaten?.program || !variant || !patchChoice || !speed) return null;
            if (!program || 'error' in program) return null;
            return {
                kind: 'program',
                speed,
                variant,
                patch: patchChoice,
                patchLabel: program.label,
                patchPlaces: program.places,
                patchBytes: program.bytes,
                program: spDaten.program.reference,
                programPatch: programChoice === 'patched' && patchedProgram
                    ? {
                        file: patchedProgram.file,
                        edits: patchedProgram.edits,
                        changedBytes: patchedProgram.changedBytes,
                    }
                    : null,
                writeBytes: conversionWriteBytes(),
            };
        }

        const processor = stage.processor;
        if (!backup || !processor) return null;

        if (stage.kind === 'probe') {
            let loaderBytes: number;
            try { loaderBytes = assemble(probeSource).bytes.length; } catch { return null; }
            return { kind: 'probe', processor, loaderBytes };
        }

        let patched: PatchedBootloader;
        let loaderBytes: number;
        try {
            patched = patchToCsl(
                extractSa0(backup.image, processor), processor, cslSa0 ? referenceCslSa0(cslSa0, processor) : undefined);
            loaderBytes = assemble(replaceSource).bytes.length;
        } catch { return null; }
        /**
         * What this processor calls itself, asked of the right processor.
         *
         * The program number is an ASCII field inside the MASTER's SA0 and `readBootloader` reads
         * it for the master only - the slave has none. This screen showed the master's number on
         * the slave stage regardless, under a readout labelled PROGRAM: a value from the other CPU,
         * presented as this one's identity, on the screen where the operator confirms what they are
         * about to change.
         *
         * The slave has an identity that is true and readable - which of the two bootloaders it is
         * carrying - so that is what its own stage shows.
         */
        const identity = processor === 'master'
            ? {
                identityLabel: 'PROGRAM',
                identityBefore: ident?.master.programNumbers?.[0] ?? '21132300',
                identityAfter: '21132500',
            }
            : {
                identityLabel: 'SA0',
                identityBefore: ident?.slave.flavour ?? 'standard-m3',
                identityAfter: 'csl',
            };

        return { kind: 'bootloader', processor, patched, loaderBytes, ...identity };
    }, [stage, backup, speed, ident, spDaten, variant, patchChoice, program,
        programChoice, patchedProgram, cslSa0]);

    /**
     * What the choice is worth, over the read it actually applies to.
     *
     * That read is `runFlash`'s read-back, and `fullBackup` takes TWO passes - so the number is
     * doubled. It used to be one pass at a chunk size nothing sends, which made the screen quote a
     * little over a third of the real time on the step where the operator decides whether the wait
     * is worth an erase. An estimate that flatters the slow option biases the decision it exists
     * to inform.
     */
    const estimates = useMemo(() => ({
        slow: 2 * estimateRead(FULL_IMAGE_LENGTH, 9600).seconds,
        fast: 2 * estimateRead(FULL_IMAGE_LENGTH, FAST_READ_BAUD).seconds,
    }), []);

    return (
        <main className="mx-auto flex h-full w-full max-w-[430px] flex-col overflow-hidden bg-slate-950">
            {/* App header (48). The tricolour stripe replaces its bottom rule from inside the
                48px, so nothing below it shifts. */}
            <header className="relative flex h-[48px] shrink-0 items-center gap-2 bg-slate-950/80 px-4 backdrop-blur-md">
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5"
                    style={{ background: 'linear-gradient(to right, #0A9BDB 0 33.333%, #9B84E8 33.333% 66.667%, #F11A22 66.667% 100%)' }}
                />
                <Led state={linkState} />
                <Wordmark />
                {/* Identity readouts, mono, right-aligned. The build id is here so the answer to
                    "which version is on that phone" is on the phone rather than in a changelog. */}
                <div className="ml-auto flex shrink-0 flex-col items-end gap-0.5 leading-none">
                    {/* One readout, three mutually exclusive facts. PRACTICE outranks the lock
                        because in practice the lock is not what is stopping anything - there is no
                        ECU on the other end at all, and that is the more important thing to know. */}
                    <span className={`font-mono text-[9px] font-bold tracking-wider
                        ${practice ? 'text-amber-400'
                            : HARDWARE_WRITE_ENABLED ? 'text-red-400'
                                : FAST_ENTRY_WRITE_ENABLED ? 'text-indigo-400' : 'text-slate-500'}`}>
                        {/* Three states, because there are three: a build that can erase the
                            service block but cannot arm is neither LOCKED nor ARMED.

                            It says SA1 ONLY and not FAST ENTRY. This badge reports what the build
                            may write; FAST ENTRY is a speed the operator chooses. Giving them the
                            same word made a permanent header read as a mode that was already
                            running - reported the first time anyone saw it. The badge names the
                            sector, which is a thing only it can be about. */}
                        {practice ? 'PRACTICE'
                            : HARDWARE_WRITE_ENABLED ? 'ARMED'
                                : FAST_ENTRY_WRITE_ENABLED ? 'SA1 ONLY' : 'LOCKED'}
                    </span>
                    <span className="selectable font-mono text-[8px] text-slate-700">{BUILD_ID}</span>
                </div>
            </header>

            {/* Step rail (26). Where you are, and how far there is to go. */}
            {/* Where you are, in the shape the job really has: the setup once, then a stage at a
                time. The ticks count the current phase, so they fill left to right and never jump
                backwards - moving to the next stage relabels the counter instead. */}
            <nav className="flex h-[26px] shrink-0 items-center gap-1.5 bg-slate-950/60 px-4">
                <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-blue-400">
                    {rail.label}
                </span>
                {/* One tick per step of the whole job. The gaps are the stage boundaries, so the
                    shape of the work is visible without reading anything. */}
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    {rail.groups.map((g) => (
                        <div key={g.key} className="flex flex-1 items-center gap-0.5">
                            {g.ticks.map((tick) => (
                                <span
                                    key={tick.key}
                                    aria-hidden="true"
                                    className={`h-0.5 flex-1 rounded-full transition
                                        ${tick.state === 'done' ? 'bg-blue-600'
                                            : tick.state === 'now' ? 'bg-blue-400' : 'bg-slate-800'}`}
                                />
                            ))}
                        </div>
                    ))}
                </div>
                <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-slate-600">
                    {c.railPosition(rail.position, rail.total)}
                </span>
            </nav>

            {/* φ — the guide and the controls, 61.8 : 38.2 of what the bars leave behind.
                Two things follow from putting the larger share on top. The guide is where the
                reading happens, and the review screen is the longest thing in the app. And the
                control band lands under the thumb: on a phone the bottom third is where a hand
                already is, which is where an app that runs 30-minute operations wants its one
                control to be. */}
            <div className="flex min-h-0 flex-1 flex-col">
            {/* The question. The only scrolling region. */}
            <div className="h-[61.8%] min-h-0 overflow-y-auto">
                {step === 'LINK' && <LinkStep blocked={blocked} installed={installed} />}
                {step === 'IDENT' && <IdentStep view={ident} practice={practice} />}
                {step === 'BACKUP' && (
                    <BackupStep
                        mode={backupMode}
                        onMode={setBackupMode}
                        result={backup ? {
                            bytes: backup.image.length,
                            seconds: backup.seconds,
                            verified: backup.verified,
                            differing: backup.differingOffsets.length,
                            how: backup.how,
                        } : null}
                    />
                )}
                {step === 'PLAN' && allDone && <DoneStep practice={practice} />}
                {step === 'PLAN' && !allDone && (
                    <PlanStep
                        stages={job.stages}
                        next={stage}
                        blocked={job.blocked}
                        spDaten={spDaten}
                        variant={variant}
                        programChoice={programChoice}
                        patchedProgram={patchedProgram}
                        onProgramChoice={(choice) => {
                            if (choice === 'factory') {
                                setProgramChoice('factory');
                                setNotice(null);
                                log('PROGRAM factory 0401, unmodified');
                                return;
                            }
                            if (patchedProgram) {
                                setProgramChoice('patched');
                                setNotice(null);
                                return;
                            }
                            void loadPatchedProgram();
                        }}
                        onVariant={(v) => {
                            setVariant(v);
                            // The "choose a version" notice has been obeyed; leaving it up would
                            // be a status that outlived the condition it described.
                            setNotice(null);
                            log(`VERSION ${v.reference}  ${v.name}  (${v.file})`);
                        }}
                    />
                )}
                {step === 'PATCH' && (
                    <PatchStep
                        choice={patch}
                        onChoice={setPatch}
                        edits={program && 'image' in program
                            ? { places: program.places, bytes: program.bytes } : null}
                        error={program && 'error' in program ? program.error : null}
                    />
                )}
                {step === 'SPEED' && (
                    <SpeedStep
                        speed={speed}
                        onSpeed={setSpeed}
                        fastLocked={fastLocked}
                        restoreBytes={restoreBytes}
                        slowSeconds={estimates.slow}
                        fastSeconds={estimates.fast}
                    />
                )}
                {step === 'REVIEW' && reviewFacts && (
                    <ReviewStep facts={reviewFacts} acked={acked} onAck={setAcked} />
                )}
                {step === 'RUN' && (
                    <RunStep
                        stage={stage}
                        running={busy !== null}
                        awaitingPowerCycle={awaitingPowerCycle}
                        practice={practice}
                    />
                )}

                {busy && (
                    <Progress
                        phase={busy.phase}
                        done={busy.done}
                        total={busy.total}
                        // Practice runs at a pace nobody would sit through the real version of, so
                        // it says what it is standing in for. A bar that fills in twenty seconds
                        // teaches the opposite of the lesson if it is left to imply a duration.
                        note={practice && busy.total > 0x10000
                            ? c.practiceRealTime(realSecondsFor(Math.ceil(busy.total / 0xfe)))
                            : undefined}
                    />
                )}
                <EventLog lines={events} />
            </div>

            {/* The control band: 38.2%. Its two fixed rows are the reserved slots, and the hub
                takes whatever is between them - so the hub moves with the viewport but never with
                the state, which is the property that matters. */}
            <div className="flex h-[38.2%] min-h-0 flex-col">
                {/* Reserved notice slot (34) - always here, empty or not. */}
                <Notice kind={slot?.kind ?? 'info'}>{slot?.text}</Notice>

                <div className="flex min-h-0 flex-1 items-center justify-center">
                    <Hub {...hub} />
                </div>

                {/* Reserved sub-action row (46). Never an overflow area for the main sequence. */}
                <SubActions>
                    {/* During the point of no return there is no dismiss at all - once the ECU has
                        acknowledged, there is no honest way to offer a cancel. */}
                    {!busy && step === 'LINK' && !connected && (
                        <SubAction label={c.practiceStart} onClick={startPractice} />
                    )}
                    {!busy && step !== 'LINK' && !allDone && (
                        <SubAction label={c.back} onClick={goBack} />
                    )}
                    {!busy && connected && (
                        <SubAction
                            label={practice ? c.practiceExit : 'DISCONNECT'}
                            tone="danger"
                            onClick={() => void disconnect()}
                        />
                    )}
                    {!busy && backup && !backup.verified && (
                        <SubAction label={c.retry} onClick={() => { setBackup(null); void runBackup(); }} />
                    )}
                    {/* The only way to exercise the reversible write tier on a car. Offered solely
                        when there is a verified capture to take the span map from and nothing else
                        is stopping fast entry - `fastLocked` carries both the write-lock reason and
                        the blank-sector one, and an inert control with an unexplained reason is
                        worse than no control. */}
                    {!busy && backup?.verified && !fastLocked && (
                        <SubAction
                            label={c.backupBoost}
                            onClick={() => {
                                if (window.confirm(c.backupBoostConfirm)) void runBackup(true);
                            }}
                        />
                    )}
                    {/* Needs no network and no token, so it is offered as soon as there is
                        anything to save - including after a session that failed, which is the one
                        whose log matters most. */}
                    {!busy && events.length > 0 && (
                        <SubAction
                            label={c.saveLog}
                            onClick={() => downloadLog(events, logFilename(new Date(), practice))}
                        />
                    )}
                    {/* Offered whether or not the two passes agreed: a capture that disagreed with
                        itself is the MOST interesting one to look at afterwards, and refusing to
                        send it would lose the only evidence of the failure. */}
                    {!busy && backup && uploadSupported() && (
                        <SubAction label={c.uploadRun} onClick={() => void uploadSession()} />
                    )}
                    {/* Only while nothing is running and nothing is connected - the whole row is
                        hidden during a transfer, which is exactly the guarantee the no-skipWaiting
                        rule needs, and a reload with a cable in would drop the link. */}
                    {!busy && !connected && updateWaiting && (
                        <SubAction label={c.updateApply} onClick={() => void applyUpdate()} />
                    )}
                </SubActions>
            </div>
            </div>

            {/* The file input for a saved capture. Off screen, driven by the hub, so there is one
                control for "get me a backup" rather than two that look like one. */}
            <input
                id="load-program"
                type="file"
                accept=".0PA,.0DA"
                className="hidden"
                multiple
                onChange={(e) => { const f = e.target.files; if (f && f.length) void loadSpDatenFiles(f); }}
            />
            <input
                id="load-backup"
                type="file"
                accept=".bin"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void loadBackup(f); }}
            />
        </main>
    );
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : t().unknownError;
}
