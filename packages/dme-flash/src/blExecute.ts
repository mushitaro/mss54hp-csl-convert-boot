/**
 * Executing a staged loader - a probe, or a bootloader replacement.
 *
 * **One executor, two kinds of ECU.** Practice runs this exact function against a simulated DME;
 * a real conversion will run it against a cable. Nothing branches on which - the difference lives
 * entirely in the transport, and in the hardware gate that reads `transport.simulated`. A practice
 * mode driving a different code path would rehearse a sequence that does not exist.
 *
 * ## The shape of the risk, restated where the code is
 *
 * `planBlReplace` produces the steps and marks `pointOfNoReturn`. Everything before it can be
 * abandoned: the calibration sector is erased and rewritten by the ordinary conversion path all the
 * time. From the arming step onward the DME jumps to 0x8000 on every power-up until the loader
 * clears the magic, and OBD cannot undo that.
 *
 * So this function does three things the plan cannot:
 *
 *  1. **Verifies the staged sector before arming**, byte for byte, while the ECU still boots.
 *  2. **Stops at the power cycle and waits for a person.** The ignition is a physical act; nothing
 *     here can perform it, and pretending otherwise would be the one place a simulation lied.
 *  3. **Leaves ambiguous WRITE recovery to the session.** It reads the target twice, accepts
 *     matching bytes, and retries only an entirely erased range. A negative ACK is never replayed.
 *
 * ## Probe and replacement are the same run up to the power cycle
 *
 * Same login, same erase, same 32 KiB, same verify, same magic, same irreversibility. They differ
 * in what the DME does when it next wakes up, and therefore in what success looks like:
 *
 *   - a **replacement** is judged by SA0 reading back as the image that was staged;
 *   - a **probe** is judged by SA0 being UNCHANGED and the magic being gone.
 *
 * The probe's result has a property worth naming, because it makes the check almost free. The
 * reset handler tests the magic before the SIM, the stack or the K-line are up - so a DME that
 * answers DS2 at all has already cleared its own magic and reached its ordinary firmware. Reading
 * the magic back confirms it directly, but the connection itself is the first evidence.
 */
import type { Ds2Session } from './session';
import { SessionError } from './session';
import type { BlPlan, BlStep } from './blReplace';
import { assertBlReplaceable } from './blReplace';
import { SA0_LENGTH, BOOTLOADER_DIFF_OFFSETS, extractSa0, identifyBootloader, verifyBootloaderCrc } from './bootloaderImage';
import { STAGED_SECTOR_LENGTH, MAGIC_OFFSET, MAGIC_CLEARED, BOOTLOADER_IMAGE_OFFSET, sectorIsArmed, type LoaderPurpose } from './blLoader';
import type { Processor } from './imageLayout';

export type BlPhase =
    | 'login' | 'read-before' | 'erase-calibration' | 'write-staged' | 'verify-staged'
    | 'arm' | 'power-cycle' | 'read-after' | 'done';

export interface BlProgress {
    readonly phase: BlPhase;
    readonly note: string;
    /** Bytes of the staged sector written so far, for a progress bar. */
    readonly written: number;
    readonly total: number;
    /** True once arming was dispatched: the ECU may be armed even if its ACK was lost. */
    readonly armed: boolean;
}

export interface BlHooks {
    readonly onProgress?: (p: BlProgress) => void;
    readonly onEvent?: (line: string) => void;
    /**
     * Called when the ECU has to be power-cycled, and awaited until it has been.
     *
     * The ECU is armed by this point. There is no cancel: resolving means "I have done it",
     * and rejecting only means the run reports where it stopped - the DME is still armed either
     * way, and the loader still runs at the next power-up.
     */
    readonly onPowerCycle: () => Promise<void>;
}

export interface BlOutcome {
    readonly processor: Processor;
    readonly purpose: LoaderPurpose;
    /** SA0 as read back afterwards. */
    readonly sa0: Uint8Array;
    readonly flavour: ReturnType<typeof identifyBootloader>;
    readonly crcValid: boolean;
    /**
     * True when SA0 reads back as `intendedSa0`.
     *
     * For a replacement that means the new bootloader is installed. For a probe it means the
     * opposite thing with the same test: `intendedSa0` is the SA0 that was already there, so
     * matching means the probe changed nothing - which is the whole result.
     */
    readonly matchesIntended: boolean;
    /**
     * How many bytes differ, in total.
     *
     * Separate from `differingOffsets` because that list is a SAMPLE - eight entries at most, which
     * is enough to diagnose and short enough to show. The screen used to report the sample's length
     * as though it were the count, so a bootloader that read back entirely wrong said "8 bytes
     * differ" - a number small enough to look like a glitch, on the one screen where the operator
     * decides whether to keep going.
     */
    readonly differingCount: number;
    /** Up to eight differing offsets, for diagnosis. NOT the count - see `differingCount`. */
    readonly differingOffsets: readonly number[];
    /** The magic must be cleared after either type of loader has run. */
    readonly magicAfter?: number;
    readonly magicCleared?: boolean;
}

/**
 * Run one processor's replacement.
 *
 * `intendedSa0` is the image that was staged, kept separately from the plan so the read-back is
 * compared against what was meant rather than against whatever the plan happens to contain.
 */
export async function runBlReplace(
    session: Ds2Session,
    plan: BlPlan,
    intendedSa0: Uint8Array,
    hooks: BlHooks,
): Promise<BlOutcome> {
    // Typed arrays remain mutable despite readonly fields. Own the validated bytes across awaits
    // and callbacks, so UI changes cannot turn a checked plan into a different write.
    plan = { ...plan, steps: plan.steps.map(s => ({ ...s, data: s.data?.slice() })) };
    intendedSa0 = intendedSa0.slice();
    // Before the first byte. A plan that would erase outside the calibration window, or arm before
    // verifying, must not get as far as a login.
    assertBlReplaceable(plan);
    if (typeof hooks.onPowerCycle !== 'function') throw new SessionError('manual ignition-cycle handler is required before staging');
    if (intendedSa0.length !== SA0_LENGTH) {
        throw new SessionError(`intended SA0 is ${intendedSa0.length} bytes, expected ${SA0_LENGTH}`);
    }
    if (plan.purpose === 'replace') {
        const sector = new Uint8Array(STAGED_SECTOR_LENGTH);
        for (const s of plan.steps) {
            if (s.kind === 'write-staged') sector.set(s.data!, s.ds2Address! - plan.ds2Address);
        }
        if (compareBytes(sector.subarray(BOOTLOADER_IMAGE_OFFSET,
            BOOTLOADER_IMAGE_OFFSET + SA0_LENGTH), intendedSa0).count !== 0) {
            throw new SessionError('staged bootloader does not match the intended SA0');
        }
    }

    const say = (line: string): void => hooks.onEvent?.(line);
    let written = 0;
    let armed = false;
    const report = (phase: BlPhase, note: string): void =>
        hooks.onProgress?.({ phase, note, written, total: STAGED_SECTOR_LENGTH, armed });

    const staged = new Uint8Array(STAGED_SECTOR_LENGTH).fill(0xff);
    const peerAddress = plan.processor === 'master' ? 0xa00000 : 0x200000;
    let peerBefore: Uint8Array | null = null;

    for (const step of plan.steps) {
        switch (step.kind) {
            case 'login':
                report('login', step.note);
                await session.login();
                say('LOGIN accepted');
                break;

            case 'read-before': {
                report('read-before', 'checking the currently connected bootloader before erasing');
                const first = (await session.readBootloader(plan.processor)).sa0.slice();
                const second = (await session.readBootloader(plan.processor)).sa0;
                if (compareBytes(first, second).count !== 0 || !verifyBootloaderCrc(first, plan.processor).valid) {
                    throw new SessionError('live bootloader reads disagree or its CRC is invalid; nothing erased');
                }
                // A valid CRC and one identifying operand do not establish a compatible reset
                // handler. All bytes except the measured M3/CSL differences must match the target.
                const allowed = plan.purpose === 'replace' ? BOOTLOADER_DIFF_OFFSETS[plan.processor] : [];
                if (first.some((b, i) => b !== intendedSa0[i] && !allowed.includes(i))) {
                    throw new SessionError('live bootloader differs from the intended compatible SA0; nothing erased');
                }
                say('LIVE SA0 confirmed twice and compatible; full recovery backup remains the caller\'s responsibility');
                await session.preflightProgramming('calibration');
                peerBefore = (await session.readWindow(peerAddress, STAGED_SECTOR_LENGTH)).slice();
                const peerAgain = await session.readWindow(peerAddress, STAGED_SECTOR_LENGTH);
                if (compareBytes(peerBefore, peerAgain).count !== 0) {
                    throw new SessionError('peer calibration reads disagree; nothing erased');
                }
                if (sectorIsArmed(peerBefore)) {
                    throw new SessionError('peer CPU is already armed; refusing to erase either calibration');
                }
                break;
            }

            case 'erase-calibration':
                report('erase-calibration', step.note);
                await session.eraseWindow(step.ds2Address!);
                say(`ERASED calibration at 0x${step.ds2Address!.toString(16)}`);
                // A data-session erase can affect BOTH CPUs. Restore the peer before staging or
                // arming the target, and never infer its contents from a distributable image.
                if (!peerBefore) throw new SessionError('missing peer snapshot');
                {
                    const peerAfter = await session.readWindow(peerAddress, STAGED_SECTOR_LENGTH);
                    if (compareBytes(peerAfter, peerBefore).count !== 0) {
                        if (!peerAfter.every(b => b === 0xff)) {
                            throw new SessionError('peer calibration was partially changed by erase; no loader armed');
                        }
                        for (let offset = 0; offset < peerBefore.length; offset += 122) {
                            const bytes = peerBefore.slice(offset, offset + 122);
                            if (!bytes.every(b => b === 0xff)) await session.writeChunk(peerAddress + offset, bytes);
                        }
                    }
                    for (let pass = 0; pass < 2; pass++) {
                        if (compareBytes(await session.readWindow(peerAddress, STAGED_SECTOR_LENGTH), peerBefore).count !== 0) {
                            throw new SessionError('peer calibration restore did not verify; no loader armed');
                        }
                    }
                    say('PEER calibration preserved and verified twice before target staging');
                }
                break;

            case 'write-staged': {
                if (step.armsTheEcu) {
                    // The magic completes here. Everything before it has been verified; from the
                    // moment this acknowledgement comes back the ECU boots into the loader.
                    report('arm', step.note);
                    // An ACK can be lost after the magic lands. From dispatch onward treat the
                    // ECU as potentially armed, even when the exchange subsequently fails.
                    armed = true;
                    report('arm', 'arming dispatched; the ECU may now be armed');
                    try {
                        await session.writeChunk(step.ds2Address!, step.data!);
                    } catch (error) {
                        throw new SessionError('The arming write was dispatched but not confirmed. '
                            + 'The ECU may already be armed: the staged loader can run at the next power-up. '
                            + `Do not assume that the failed acknowledgement cancelled it. ${error instanceof Error ? error.message : String(error)}`);
                    }
                    written += step.data!.length;
                    say('ARMED: the magic is in flash. Every power-up now runs the loader.');
                    break;
                }
                await session.writeChunk(step.ds2Address!, step.data!);
                written += step.data!.length;
                staged.set(step.data!, step.ds2Address! - plan.ds2Address);
                report('write-staged', step.note);
                break;
            }

            case 'verify-staged': {
                report('verify-staged', step.note);
                const back = await session.readWindow(plan.ds2Address, STAGED_SECTOR_LENGTH);
                // Pending bytes must still be erased, including the magic itself. Skipping the
                // arming chunk hid failed erases and could leave a partially armed sector.
                const differing = compareBytes(back, staged);
                if (differing.count > 0) {
                    throw new SessionError(
                        `the staged sector does not read back as written`
                        + ` (${differing.count} byte(s), first at 0x${differing.first[0]!.toString(16)}).`
                        + ' Nothing has been armed; the calibration can be rewritten through the'
                        + ' ordinary path and no bootloader was touched.');
                }
                say('STAGED sector verified byte for byte - last reversible moment');
                break;
            }

            case 'arm':
                // The bytes went out with the final write chunk above; this step is the plan's
                // marker for the transition, not a second telegram.
                report('arm', step.note);
                break;

            case 'power-cycle':
                report('power-cycle', step.note);
                say('WAITING for the ignition to be cycled');
                await hooks.onPowerCycle();
                say('POWER CYCLED');
                await session.resumeAfterPowerCycle();
                break;

            case 'read-after': {
                report('read-after', step.note);

                const { sa0, report: after } = await session.readBootloader(plan.processor);
                say('DS2 ANSWERS - the DME reached its diagnostic firmware');
                const differing = compareBytes(sa0, intendedSa0);

                // DS2 is served by the master; an answer alone does not prove the slave reset.
                // Confirm the target processor's magic explicitly for both loader purposes.
                const bytes = await session.readWindow(plan.ds2Address + MAGIC_OFFSET, 4);
                if (bytes.length !== 4) throw new SessionError('incomplete post-cycle magic read');
                const magicAfter = ((bytes[0]! << 24) | (bytes[1]! << 16)
                    | (bytes[2]! << 8) | bytes[3]!) >>> 0;

                const outcome: BlOutcome = {
                    processor: plan.processor,
                    purpose: plan.purpose,
                    sa0,
                    flavour: after.flavour,
                    crcValid: after.crc.valid,
                    matchesIntended: differing.count === 0,
                    differingCount: differing.count,
                    differingOffsets: differing.first,
                    magicAfter,
                    magicCleared: magicAfter === MAGIC_CLEARED,
                };

                if (plan.purpose === 'probe') {
                    say(`MAGIC now 0x${(magicAfter ?? 0).toString(16).padStart(8, '0')}`
                        + ` (${outcome.magicCleared ? 'cleared by the loader' : 'NOT CLEARED'})`);
                    say(`SA0 still ${outcome.flavour}, CRC ${outcome.crcValid ? 'valid' : 'INVALID'},`
                        + ` ${outcome.matchesIntended ? 'unchanged' : 'CHANGED - it should not have been'}`);
                    report('done', 'probe complete');
                } else {
                    if (plan.processor === 'master' && outcome.matchesIntended && outcome.magicCleared && outcome.crcValid) {
                        await session.preflightProgramming('program', true);
                        say('MASTER program-mode handoff confirmed in live AIF twice');
                    }
                    say(`SA0 now ${outcome.flavour}, CRC ${outcome.crcValid ? 'valid' : 'INVALID'},`
                        + ` ${outcome.matchesIntended ? 'matches' : 'DOES NOT MATCH'} the staged image`);
                    report('done', 'replacement complete');
                }
                return outcome;
            }

            case 'restore-calibration':
                // Left to the caller: putting a real calibration back is the ordinary conversion,
                // and it is a separate stage of the job with its own source image and its own
                // confirmation. Doing it silently here would hide a second flash inside the first.
                say('CALIBRATION still holds the loader - restore it in the program stage');
                break;
        }
    }
    throw new SessionError('the plan ended without reading the bootloader back');
}

/**
 * How many bytes differ, and where the first few of them are.
 *
 * Both, and returned together, because they answer different questions and one used to be given as
 * the answer to the other. The count is what decides whether this is a glitch or a failed write;
 * the offsets are what says where to look. Stopping the scan at eight - which is what happened when
 * the sample WAS the answer - made every large failure report the same small number.
 */
function compareBytes(
    a: Uint8Array, b: Uint8Array,
): { count: number; first: number[] } {
    const first: number[] = [];
    let count = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        if (a[i] === b[i]) continue;
        count++;
        if (first.length < 8) first.push(i);
    }
    // A length mismatch is a difference too, and silently comparing the shorter of the two would
    // report a truncated read-back as a perfect match.
    if (a.length !== b.length) {
        count += Math.abs(a.length - b.length);
        if (first.length < 8) first.push(n);
    }
    return { count, first };
}

/** Re-exported so a caller can report what it was aiming at without importing three modules. */
export { extractSa0, verifyBootloaderCrc };
export type { BlStep };
