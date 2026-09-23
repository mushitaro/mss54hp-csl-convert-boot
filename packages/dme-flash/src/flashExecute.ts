/**
 * Executing a program / calibration write - the stage that actually makes the car a CSL.
 *
 * The bootloader replacement (`blExecute.ts`) changes what the DME *says it is*. This changes what
 * it *does*: the 0401 program and its calibration. It is the step the community already performs
 * today on a standard bootloader, and it is the last stage of the job here.
 *
 * ## Why this is the ordinary path and the other one is not
 *
 * Everything below goes through erase and write telegrams the firmware was built to accept, at
 * windows its own region table permits, and a failure is recoverable: the DME sits with an erased
 * program area, still answers DS2, and the write can simply be run again. No magic is written, no
 * reset handler is armed, and no loader runs. That is the whole difference in risk between this
 * stage and the bootloader one, and it is why this stage does not ask for a BDM recovery path.
 *
 * ## What it refuses
 *
 * `validateSequence` re-derives the safety properties from the plan itself - every erase inside an
 * accepted window, every write within the chunk cap, nothing addressed at a protected sector - and
 * this refuses to send a plan that fails it. Checked before the login, not before the erase: an
 * ordering that is obviously correct as the function grows.
 */
import type { Ds2Session } from './session';
import { SessionError } from './session';
import type { FlashPlan } from './flashSequence';
import { assertFlashable } from './flashSequence';
import { FULL_IMAGE_LENGTH } from './imageLayout';
import { CENSORED_RANGE } from './fullSpaceRead';

export type FlashPhase = 'login' | 'erase' | 'write' | 'verify' | 'reset' | 'done';

export interface FlashProgress {
    readonly phase: FlashPhase;
    readonly note: string;
    readonly written: number;
    readonly total: number;
}

export interface FlashHooks {
    readonly onProgress?: (p: FlashProgress) => void;
    readonly onEvent?: (line: string) => void;
    /**
     * Read the whole DME back and compare it against the image that was written.
     *
     * Optional because it doubles the wall clock, and because the caller may already be doing a
     * full capture for its own reasons. When it is skipped, `verified` comes back false rather
     * than absent - a run that was not checked must not be reported as one that passed.
     */
    readonly verifyReadBack?: boolean;
}

export interface FlashOutcome {
    readonly writeBytes: number;
    readonly eraseCount: number;
    /**
     * True only when a read-back was performed, its two passes agreed with each other, AND the
     * result matched the image.
     *
     * All three, because the middle one used to be missing and it is the one that makes the third
     * mean anything.
     */
    readonly verified: boolean;
    readonly differingOffsets: readonly number[];
    /**
     * Bytes the read-back actually compared.
     *
     * Smaller than the megabyte the image spans - the bootloader and the service block are never
     * written, so they are never checked - and smaller than `writeBytes`, because 24 bytes of the
     * Free Identifiers sector can never be read back at all. A caller reporting "the whole image
     * matches" is claiming two things this number contradicts.
     */
    readonly comparedBytes: number;
    /**
     * Whether the read-back's two passes agreed with EACH OTHER.
     *
     * A separate question from whether they matched the image, and it has to be asked first,
     * because it decides whether the other answer means anything. `fullBackup` reads the DME twice
     * precisely so a dropped or duplicated chunk cannot pass as a faithful capture - and this
     * function used to take its `image` and throw the verdict away. A read that contradicted itself
     * and happened to agree with the image on pass one was reported as a verified write.
     *
     * The two failures also want opposite remedies: a disagreement here means read again, and
     * rewriting a DME because the cable glitched while checking it is the wrong move.
     */
    readonly readBackAgreed: boolean;
    /** Where the two read-back passes disagreed. Empty when they agreed. */
    readonly readBackDisagreements: readonly number[];
    /** The DME's own integrity verdict afterwards, when it answered. */
    readonly encodingFaulted: boolean | null;
}

/**
 * Run a program / calibration write.
 *
 * `image` is the full 1 MiB the plan's write steps were built from, kept alongside the plan so the
 * read-back compares against what was meant rather than against the plan's own step data.
 */
export async function runFlash(
    session: Ds2Session,
    plan: FlashPlan,
    image: Uint8Array,
    hooks: FlashHooks = {},
): Promise<FlashOutcome> {
    // Before the first byte. A plan that would erase a protected sector must not reach a login.
    assertFlashable(plan);
    if (image.length !== FULL_IMAGE_LENGTH) {
        throw new SessionError(`image is ${image.length} bytes, expected a full ${FULL_IMAGE_LENGTH}`);
    }

    const say = (line: string): void => hooks.onEvent?.(line);
    let written = 0;
    const report = (phase: FlashPhase, note: string): void =>
        hooks.onProgress?.({ phase, note, written, total: plan.writeBytes });

    for (const step of plan.steps) {
        switch (step.kind) {
            case 'login':
                report('login', step.note);
                await session.login();
                say('LOGIN accepted');
                break;

            case 'erase':
                report('erase', step.note);
                await session.eraseWindow(step.ds2Address!);
                say(`ERASED 0x${step.ds2Address!.toString(16)}`);
                break;

            case 'write':
                await session.writeChunk(step.ds2Address!, step.data!);
                written += step.data!.length;
                report('write', step.note);
                break;

            case 'verify-checksum':
                // The DME's own verdict, which is cheap and is not the same thing as a read-back:
                // it reports whether the ECU thinks its areas are intact, not whether they hold the
                // bytes that were sent.
                report('verify', step.note);
                break;

            case 'reset':
                report('reset', step.note);
                break;
        }
    }

    let verified = false;
    let differingOffsets: readonly number[] = [];
    /**
     * How many bytes the read-back actually compared.
     *
     * Reported because it is smaller than both numbers a caller might assume: smaller than the
     * megabyte the image spans (the bootloader and service block are never written, so they are
     * never checked) and smaller than the bytes written (24 of them can never be read back). A
     * screen that says "the 1 MiB matches" is claiming both of those were checked.
     */
    let comparedBytes = 0;
    let readBackAgreed = true;
    let readBackDisagreements: readonly number[] = [];
    if (hooks.verifyReadBack) {
        report('verify', 'reading the DME back and comparing the windows that were written');
        const back = await session.fullBackup();

        // The read's own verdict comes first. `fullBackup` reads twice for exactly this reason, and
        // ignoring the answer meant a self-contradicting read could still certify a write.
        readBackAgreed = back.verified;
        readBackDisagreements = back.differingOffsets;

        const compared = compareWrittenWindows(plan, image, back.image);
        differingOffsets = compared.differing;
        comparedBytes = compared.comparedBytes;
        verified = readBackAgreed && differingOffsets.length === 0;

        if (!readBackAgreed) {
            say(`READ-BACK UNRELIABLE: the two passes disagree at ${back.differingOffsets.length}`
                + ' offsets, so nothing they say about the write can be trusted');
        } else {
            say(verified
                ? 'VERIFIED: every window written reads back byte for byte'
                : `VERIFY FAILED: ${differingOffsets.length} bytes differ`);
        }
    } else {
        say('READ-BACK skipped, so this write is not verified');
    }

    let encodingFaulted: boolean | null = null;
    try {
        encodingFaulted = (await session.encodingChecksum()).anyFaulted;
        say(`ECU self-check reports ${encodingFaulted ? 'a FAULTED area' : 'every area clean'}`);
    } catch {
        // Not every DME answers this, and it is a report rather than a gate.
    }

    report('done', 'program write complete');
    return {
        writeBytes: plan.writeBytes, eraseCount: plan.eraseCount, verified, differingOffsets,
        comparedBytes, readBackAgreed, readBackDisagreements, encodingFaulted,
    };
}


/**
 * Compare only the windows this plan actually wrote.
 *
 * Comparing the whole megabyte was wrong, and wrong in the direction that matters: a conversion
 * image carries 0xFF everywhere the plan does not write, while the ECU still holds its bootloader,
 * its service block and the blank tail of the program window. So a *successful* write reported
 * hundreds of thousands of differing bytes and called itself a failure.
 *
 * The censored window is skipped for the same reason `compareReads` skips it - the firmware
 * substitutes 0xFF over 0x4000-0x4017 on every read, so no capture can ever agree with an image
 * there.
 */
function compareWrittenWindows(
    plan: FlashPlan, intended: Uint8Array, actual: Uint8Array,
): { differing: number[]; comparedBytes: number } {
    const differing: number[] = [];
    let comparedBytes = 0;
    for (const window of plan.windows) {
        for (let i = 0; i < window.length; i++) {
            const at = window.imageOffset + i;
            if (at >= CENSORED_RANGE.start && at < CENSORED_RANGE.end) continue;
            comparedBytes++;
            if (intended[at] !== actual[at]) differing.push(at);
        }
    }
    return { differing, comparedBytes };
}
