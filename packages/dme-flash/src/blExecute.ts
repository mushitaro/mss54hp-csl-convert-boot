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
 *  3. **Leaves retry to the link.** A lost telegram is retried there, on the transport failure
 *     only; a write that round-tripped and came back refused means the device tried and could not,
 *     and that is never repeated. This is the one path where the distinction is not academic:
 *     every write here happens with the calibration sector already erased.
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
import { SA0_LENGTH, extractSa0, identifyBootloader, verifyBootloaderCrc } from './bootloaderImage';
import { STAGED_SECTOR_LENGTH, MAGIC_OFFSET, MAGIC_CLEARED, type LoaderPurpose } from './blLoader';
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
    /** True once the ECU will boot into the loader - i.e. past the point of no return. */
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
    /**
     * The magic longword as read back, and whether the loader cleared it.
     *
     * Populated for a probe, where it IS the result. Undefined for a replacement, whose staged
     * sector is about to be overwritten by a real calibration anyway.
     */
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
    // Before the first byte. A plan that would erase outside the calibration window, or arm before
    // verifying, must not get as far as a login.
    assertBlReplaceable(plan);
    if (intendedSa0.length !== SA0_LENGTH) {
        throw new SessionError(`intended SA0 is ${intendedSa0.length} bytes, expected ${SA0_LENGTH}`);
    }

    const say = (line: string): void => hooks.onEvent?.(line);
    let written = 0;
    let armed = false;
    const report = (phase: BlPhase, note: string): void =>
        hooks.onProgress?.({ phase, note, written, total: STAGED_SECTOR_LENGTH, armed });

    const staged = new Uint8Array(STAGED_SECTOR_LENGTH).fill(0xff);

    for (const step of plan.steps) {
        switch (step.kind) {
            case 'login':
                report('login', step.note);
                await session.login();
                say('LOGIN accepted');
                break;

            case 'read-before':
                // The capture is taken by the wizard before this runs - repeating half an hour of
                // reading here would be the wrong place for it. Recorded so the plan and the run
                // stay in step rather than silently diverging.
                say('BACKUP already captured and verified by the caller');
                break;

            case 'erase-calibration':
                report('erase-calibration', step.note);
                await session.eraseWindow(step.ds2Address!);
                say(`ERASED calibration at 0x${step.ds2Address!.toString(16)}`);
                break;

            case 'write-staged': {
                if (step.armsTheEcu) {
                    // The magic completes here. Everything before it has been verified; from the
                    // moment this acknowledgement comes back the ECU boots into the loader.
                    report('arm', step.note);
                    await session.writeChunk(step.ds2Address!, step.data!);
                    armed = true;
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
                const differing = compareBytes(back, staged, magicRange(plan));
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
                break;

            case 'read-after': {
                report('read-after', step.note);

                // Reaching this line is already the probe's first result: the reset handler checks
                // the magic before the K-line comes up, so a DME that answers has cleared it.
                if (plan.purpose === 'probe') {
                    say('DS2 ANSWERS - the DME reached its ordinary firmware, so the magic is gone');
                }

                const { sa0, report: after } = await session.readBootloader(plan.processor);
                const differing = compareBytes(sa0, intendedSa0);

                let magicAfter: number | undefined;
                if (plan.purpose === 'probe') {
                    // Read it directly too. The inference above is sound but it is an inference,
                    // and this is four bytes.
                    const bytes = await session.readWindow(plan.ds2Address + MAGIC_OFFSET, 4);
                    magicAfter = (((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16)
                        | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)) >>> 0;
                }

                const outcome: BlOutcome = {
                    processor: plan.processor,
                    purpose: plan.purpose,
                    sa0,
                    flavour: after.flavour,
                    crcValid: after.crc.valid,
                    matchesIntended: differing.count === 0,
                    differingCount: differing.count,
                    differingOffsets: differing.first,
                    ...(magicAfter === undefined ? {} : {
                        magicAfter,
                        magicCleared: magicAfter === MAGIC_CLEARED,
                    }),
                };

                if (plan.purpose === 'probe') {
                    say(`MAGIC now 0x${(magicAfter ?? 0).toString(16).padStart(8, '0')}`
                        + ` (${outcome.magicCleared ? 'cleared by the loader' : 'NOT CLEARED'})`);
                    say(`SA0 still ${outcome.flavour}, CRC ${outcome.crcValid ? 'valid' : 'INVALID'},`
                        + ` ${outcome.matchesIntended ? 'unchanged' : 'CHANGED - it should not have been'}`);
                    report('done', 'probe complete');
                } else {
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

/** Where the magic lives, so the pre-arm verify does not fail on bytes not yet written. */
function magicRange(plan: BlPlan): { start: number; end: number } {
    const arming = plan.steps.find((s) => s.armsTheEcu === true && s.kind === 'write-staged');
    if (!arming?.ds2Address || !arming.data) return { start: 0, end: 0 };
    const start = arming.ds2Address - plan.ds2Address;
    return { start, end: start + arming.data.length };
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
    a: Uint8Array, b: Uint8Array, skip?: { start: number; end: number },
): { count: number; first: number[] } {
    const first: number[] = [];
    let count = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        if (skip && i >= skip.start && i < skip.end) continue;
        if (a[i] === b[i]) continue;
        count++;
        if (first.length < 8) first.push(i);
    }
    // A length mismatch is a difference too, and silently comparing the shorter of the two would
    // report a truncated read-back as a perfect match.
    if (a.length !== b.length) count += Math.abs(a.length - b.length);
    return { count, first };
}

/** Re-exported so a caller can report what it was aiming at without importing three modules. */
export { extractSa0, verifyBootloaderCrc };
export type { BlStep };
