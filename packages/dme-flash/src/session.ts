/**
 * A diagnostic session with the DME: the read-only operations, wired end to end.
 *
 * This is what makes the first milestone executable. Everything here is non-destructive, and
 * that is not a coincidence - the full-flash capture below is both the backup that a bootloader
 * replacement depends on and the experiment that proves the addressing, using an operation that
 * cannot damage anything. A dangerous hypothesis, tried with a harmless operation.
 *
 * The capture it produces is the only one that includes SA0, SA1 and SA2: the bootloader, and
 * the car-specific service block holding the VIN, the AIF log, the flash counter and the
 * application entry vector. No distributable image contains those - every published full binary
 * has 0x4000-0x7FFF blanked - so this file is the only thing that could ever restore them.
 *
 * Two independent passes, compared byte for byte, is the difference between a file and a backup.
 */
import { Ds2Link, TIMEOUTS, type ByteTransport, type Ds2LinkOptions } from './transport';
import { Ds2Status, statusOf, describeDs2Status, type Ds2Response } from './ds2';
import {
    buildReadTelegram, buildEncodingChecksumTelegram, decodeEncodingChecksum,
    buildRecyclingTelegram, buildFinishTelegram, buildBaudRateTelegram, parseWriteAcknowledgement,
    buildEraseTelegram, buildWriteTelegram,
    type EncodingChecksumReport,
} from './telegrams';
import {
    DEFAULT_ACCESS_LEVEL, SEED_RESPONSE_LENGTH,
    buildSeedRequestPayload, buildKeyPayload, calculateKey,
} from './seedKey';
import {
    planFullSpaceRead, planWholeDmeRead, processorImageBase, compareReads,
    PROCESSOR_FLASH_LENGTH, CENSORED_RANGE, type RawReadPlan,
} from './fullSpaceRead';
import { READ_CHUNK_MAX } from './backupPlan';
import { FULL_IMAGE_LENGTH, type Processor } from './imageLayout';
import { extractSa0, verifyBootloaderCrc, identifyBootloader, masterProgramNumbers } from './bootloaderImage';
import {
    FREE_IDENTIFIERS, ServiceBlock, FAST_ENTRY_PREP_MARKER, FAST_READ_BAUD,
    RECYCLE_ONLY_ADDRESS, RECYCLE_OFF_ADDRESS,
    buildPreservationPlan, serviceBlockMatches, toDs2Address, planBytes, chunkSpan,
    buildFastEntryEraseTelegram, buildFastEntryWriteTelegram,
    type Span, type VerifiedBackup,
} from './fastEntry';
import { assertWriteUnlocked } from './writeLock';

export class SessionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SessionError';
    }
}

/** Throw unless the DME acknowledged. */
function requireAck(response: Ds2Response, what: string): Ds2Response {
    const status = statusOf(response);
    if (status !== Ds2Status.Ack) {
        throw new SessionError(`${what}: DME answered ${describeDs2Status(status ?? -1)}`);
    }
    return response;
}

export interface FullBackupProgress {
    readonly processor: Processor;
    readonly pass: 1 | 2;
    readonly bytesRead: number;
    readonly totalBytes: number;
}

export interface FullBackup {
    /** 1 MiB: master at 0x00000, slave at 0x80000. */
    readonly image: Uint8Array;
    /** True when both passes agreed everywhere outside the censored window. */
    readonly verified: boolean;
    readonly differingOffsets: readonly number[];
}

export interface BootloaderReport {
    readonly processor: Processor;
    readonly flavour: ReturnType<typeof identifyBootloader>;
    readonly crc: ReturnType<typeof verifyBootloaderCrc>;
    /** Master only; the slave bootloader carries no program number. */
    readonly programNumbers?: readonly string[];
}

/**
 * What one risk-free pass over a DME learned.
 *
 * `master` and `slave` are nullable because they depend on something that can fail on its own: the
 * bootloader read uses the linear 24-bit segments, and command 0x06 dispatches those to a branch
 * gated on bit 2 of 0xFFD003 - an access bit command 0x90 grants, answering 0xA2 when it is clear
 * (see `fullSpaceRead.ts`). So a refused login really does cost the bootloader read and the backup,
 * and a record that pretended otherwise would be describing a different ECU.
 *
 * `ident` is not nullable, because command 0x00 is not gated: a DME that answers it is alive,
 * addressed correctly and talking at the right rate. That is worth having on its own when nothing
 * else is possible.
 */
export interface EcuSurvey {
    readonly ident: string;
    readonly master: BootloaderReport | null;
    readonly slave: BootloaderReport | null;
    readonly checksum: EncodingChecksumReport | null;
    /** Whether the seed/key exchange was accepted. Everything below `ident` depends on it. */
    readonly loggedIn: boolean;
    /** Why the login was refused, when it was. */
    readonly loginError?: string;
}

export class Ds2Session {
    private readonly link: Ds2Link;

    /** Kept as well as the link, because fast entry has to change the line speed under it. */
    constructor(private readonly transport: ByteTransport, options: Ds2LinkOptions = {}) {
        this.link = new Ds2Link(transport, options);
    }

    /** Identification string, and proof the link works at all. */
    async ident(): Promise<string> {
        const response = await this.link.transceiveIdempotent(new Uint8Array([0x00]));
        requireAck(response, 'IDENT');
        const data = response.data ?? new Uint8Array();
        return Array.from(data.subarray(1), (b) => String.fromCharCode(b)).join('').trim();
    }

    /**
     * Log in with the seed/key exchange on command 0x90.
     *
     * This is the real security access. Command 0x91 is the baud-rate switch, despite an earlier
     * note in this repository having read the table at flash 0x3FB8 as passwords - it is the
     * list of supported baud rates, and it is identical across every image we have.
     */
    async login(accessLevel = DEFAULT_ACCESS_LEVEL): Promise<void> {
        const seed = await this.link.transceiveIdempotent(buildSeedRequestPayload(accessLevel));
        requireAck(seed, 'login seed request');

        // The key algorithm indexes the whole response frame, including its length byte.
        const frame = new Uint8Array(SEED_RESPONSE_LENGTH);
        frame[0] = seed.address ?? 0;
        frame[1] = seed.length ?? 0;
        frame.set(seed.data ?? new Uint8Array(), 2);
        frame[SEED_RESPONSE_LENGTH - 1] = seed.checksum ?? 0;
        if ((seed.length ?? 0) !== SEED_RESPONSE_LENGTH) {
            throw new SessionError(
                `login seed response was ${seed.length} bytes, expected ${SEED_RESPONSE_LENGTH}`);
        }

        const key = calculateKey(accessLevel, frame);
        const reply = await this.link.transceive(buildKeyPayload(key));
        requireAck(reply, 'login key');
    }

    /**
     * Everything that can be learned about a DME without changing a byte of it.
     *
     * ## What a refused login costs, exactly
     *
     * It costs the bootloader read and the backup, and there is no way around that: command 0x06
     * dispatches the linear 24-bit segments to a branch gated on bit 2 of 0xFFD003, an access bit
     * command 0x90 grants, and answers 0xA2 when it is clear (`fullSpaceRead.ts`). Those segments
     * are the only ones that reach SA0, SA1 and SA2, so without the login there is no capture that
     * includes the bootloader - which is the capture this whole job depends on.
     *
     * It does NOT cost the identification. Command 0x00 is not gated, and it answers before any of
     * this, so a DME that gets that far is alive, correctly addressed and framing at the right rate.
     * That is genuinely useful when nothing else is: it separates "the cable and the ECU are fine
     * and the access is refused" from "nothing is talking", and those need different next steps.
     *
     * So the survey returns what it actually got rather than throwing the identification away with
     * the rest. It stops at the refusal instead of firing eight thousand read telegrams that the
     * firmware will reject one at a time.
     */
    async survey(onStep?: (done: number, total: number) => void): Promise<EcuSurvey> {
        const identText = await this.ident();
        onStep?.(1, 4);

        try {
            await this.login();
        } catch (error) {
            // Reported, not thrown. The caller has an identification worth showing and a reason
            // worth showing next to it.
            return {
                ident: identText, master: null, slave: null, checksum: null,
                loggedIn: false, loginError: describe(error),
            };
        }
        onStep?.(2, 4);

        const master = (await this.readBootloader('master')).report;
        onStep?.(3, 4);
        const slave = (await this.readBootloader('slave')).report;

        // A report, not a gate: not every DME answers it, and a missing answer is not a fault.
        let checksum: EncodingChecksumReport | null = null;
        try { checksum = await this.encodingChecksum(); } catch { /* left null */ }

        onStep?.(4, 4);
        return { ident: identText, master, slave, checksum, loggedIn: true };
    }

    /**
     * The DME's own verdict on its flash integrity. A SET bit means that area is FAULTED.
     *
     * Worth reading before and after a bootloader replacement: it is the one place the ECU will
     * tell us whether it thinks its own boot sector is intact.
     */
    async encodingChecksum(): Promise<EncodingChecksumReport> {
        const response = await this.link.transceiveIdempotent(buildEncodingChecksumTelegram());
        requireAck(response, 'encoding checksum');
        return decodeEncodingChecksum(response.data?.[1] ?? 0);
    }

    /** One read chunk. Returns exactly `count` bytes or throws. */
    async readChunk(segment: number, address: number, count: number): Promise<Uint8Array> {
        const response = await this.link.transceiveIdempotent(
            buildReadTelegram(segment, address, count), TIMEOUTS.response);
        requireAck(response, `read ${count} bytes at 0x${address.toString(16)}`);
        const payload = (response.data ?? new Uint8Array()).subarray(1);
        if (payload.length !== count) {
            throw new SessionError(
                `read at 0x${address.toString(16)} returned ${payload.length} bytes, expected ${count}`);
        }
        return payload;
    }

    /**
     * Refresh the access level, without making a caller care whether it had lapsed.
     *
     * Idempotent and cheap - two telegrams - so the honest thing is to do it rather than to guess
     * whether enough time has passed. A refusal here is a real failure and is not swallowed: if the
     * DME will not grant access, the read that follows cannot work either.
     */
    async ensureAccess(): Promise<void> {
        await this.login();
    }

    /** Execute one linear-read plan. */
    async runPlan(plan: RawReadPlan, onChunk?: (bytesRead: number) => void): Promise<Uint8Array> {
        const bytes = new Uint8Array(plan.totalBytes).fill(0xff);
        let read = 0;
        for (const chunk of plan.chunks) {
            const got = await this.readChunk(chunk.segment, chunk.address, chunk.count);
            bytes.set(got, chunk.address - plan.start);
            read += got.length;
            onChunk?.(read);
        }
        return bytes;
    }

    /**
     * Capture both processors' flash, twice, and compare.
     *
     * A single pass is not a backup: a link that drops or duplicates a chunk produces a file that
     * looks entirely plausible. Two passes that agree everywhere outside the window the firmware
     * censors is the cheapest evidence that the read path is faithful, and it costs only time.
     *
     * **This has no fast-entry option, and the absence is the design.** Fast entry reaches 125000
     * by erasing the Free Identifiers sector - the sector this capture exists to preserve, and the
     * only one no distributable image can replace. Taking the backup faster by erasing what the
     * backup is for is circular, so the option is not offered rather than offered and defaulted
     * off: a flag can be set by a caller in a hurry, a missing parameter cannot. Once a verified
     * capture exists, `enterFastRead` restores from it and every later read can be boosted.
     *
     * At 9600 this is about half an hour for the two passes. That is the correct price.
     *
     * ## It logs in first, and that is not belt-and-braces
     *
     * Found on a car: IDENT logged in and read both SA0 sectors fine, and the backup pressed a
     * minute later was refused at its very first chunk with 0xA2. The linear 24-bit segments are
     * gated on an access bit command 0x90 grants, and the DME lets that lapse while nobody is
     * asking it for anything - which is exactly the gap between finishing IDENT and a person
     * deciding to tap BACKUP.
     *
     * The reference tuner opens EVERY bulk operation with its own `login()` - the bulk read, the
     * write, the flash-counter reset and the service-block restore all do it. This port logged in
     * once during identification and never again. Same defect as the write-chunk retry and the
     * fast-entry recovery: the policy was ported and its neighbour was not.
     */
    async fullBackup(
        onProgress?: (p: FullBackupProgress) => void,
        options: { chunkSize?: number; refreshAccess?: boolean } = {},
    ): Promise<FullBackup> {
        const { chunkSize = READ_CHUNK_MAX, refreshAccess = true } = options;

        /**
         * See the note above: the access level lapses while the operator is deciding, and every
         * chunk of this read needs it.
         *
         * `refreshAccess: false` is for the one caller that has just come through `enterFastRead`.
         * Two reasons, and the second is the one that matters. The access level cannot have lapsed
         * - fast entry is minutes of authenticated exchanges that finished a moment ago. And the
         * reference tool logs in BEFORE fast entry and never again: it switches to 125000 and
         * continues the read it was already inside. Sending 0x90 at 125000, in a programming
         * session, to a DME whose service block was erased and restored seconds earlier is an
         * ordering the reference has never performed - and this port has no business inventing one
         * on a path where the sector has already been open.
         */
        if (refreshAccess) await this.login();

        const capture = async (pass: 1 | 2): Promise<Uint8Array> => {
            const image = new Uint8Array(FULL_IMAGE_LENGTH).fill(0xff);
            for (const plan of planWholeDmeRead(chunkSize)) {
                const bytes = await this.runPlan(plan, (bytesRead) => {
                    onProgress?.({ processor: plan.processor, pass, bytesRead, totalBytes: plan.totalBytes });
                });
                image.set(bytes, processorImageBase(plan.processor));
            }
            return image;
        };

        const first = await capture(1);
        const second = await capture(2);
        const comparison = compareReads(first, second);
        return { image: first, verified: comparison.identical, differingOffsets: comparison.differingOffsets };
    }

    /**
     * Read one processor's bootloader sector and report what it is.
     *
     * This is the operation that settles, for any given car, which bootloader it is running -
     * and for anyone with a genuine CSL DME, it is how the community can publish an
     * authoritative SA0 without touching a single cell.
     */
    async readBootloader(processor: Processor): Promise<{ sa0: Uint8Array; report: BootloaderReport }> {
        const plan = planFullSpaceRead(processor, 0, 0x4000);
        const sa0 = await this.runPlan(plan);
        const report: BootloaderReport = {
            processor,
            flavour: identifyBootloader(sa0, processor),
            crc: verifyBootloaderCrc(sa0, processor),
            ...(processor === 'master' ? { programNumbers: masterProgramNumbers(sa0) } : {}),
        };
        return { sa0, report };
    }

    /**
     * Read one processor's whole 8 KiB service block. Non-destructive, and the evidence that a
     * backup is a current copy of THIS ECU.
     */
    async readServiceBlock(processor: Processor): Promise<Uint8Array> {
        const base = toDs2Address(processor, FREE_IDENTIFIERS.start);
        const block = new Uint8Array(FREE_IDENTIFIERS.length).fill(0xff);
        for (let offset = 0; offset < FREE_IDENTIFIERS.length; offset += READ_CHUNK_MAX) {
            const count = Math.min(READ_CHUNK_MAX, FREE_IDENTIFIERS.length - offset);
            block.set(await this.readChunk(0x00, base + offset, count), offset);
        }
        return block;
    }

    /**
     * FAST ENTRY: erase the Free Identifiers sector, put it straight back, and switch to 125000.
     *
     * Read `fastEntry.ts` before this. The short version is that 125000 is reachable only from
     * inside a programming session, the only door into one is a valid erase, and this 8 KiB sector
     * is the cheapest thing to erase. The contents are read live, restored, and verified byte for
     * byte before the switch is even attempted.
     *
     * ## The order is the safety property
     *
     *   1. **Reversible.** Check the plan, prove the backup is current, read the spans live.
     *      Nothing on the ECU has changed and any failure here is just "read at 9600 instead".
     *   2. **Destructive.** Prep marker, recycle-only, erase both, restore, verify. `eraseStarted`
     *      marks the door: past it a failure is not a shrug, it is an operator who has to be told
     *      that the sector holding their car's identity is not intact.
     *   3. **Free.** Close the session, then switch. The sector is back and *proven* back, so a
     *      refused switch costs the speed and nothing else.
     *
     * That last point is what makes this the safer of the two possible boosts even though it erases
     * more: on a write path the switch necessarily happens with the target already erased.
     *
     * Returns whether the link is now at 125000. Before the erase it never throws - the caller's
     * job is to read, and reading slowly beats not reading.
     */
    async enterFastRead(backup: VerifiedBackup | null, onEvent?: (line: string) => void): Promise<boolean> {
        // Before the first byte, not before the erase. A guard that runs later runs too late.
        assertWriteUnlocked(
            'fast entry (erases and restores the Free Identifiers sector)', 'reversible');
        const say = (line: string): void => { onEvent?.(line); };

        // --- Phase 1: reversible ----------------------------------------------------------------
        const plan = buildPreservationPlan(backup);
        if (!plan.safe) { say(`FAST ENTRY skipped: ${plan.reason}`); return false; }

        for (const processor of ['master', 'slave'] as const) {
            const live = await this.readServiceBlock(processor);
            const match = serviceBlockMatches(backup!, live, processor);
            if (!match.same) { say(`FAST ENTRY skipped: ${match.reason}`); return false; }
        }
        say(`FAST ENTRY plan: ${plan.spans.length} span(s), ${planBytes(plan.spans)} byte(s)`);

        // Live, every time. The backup contributed addresses; these are the bytes that go back.
        const live: { span: Span; data: Uint8Array }[] = [];
        try {
            for (const span of plan.spans) {
                live.push({ span, data: await this.readRange(span) });
            }
        } catch (error) {
            say(`FAST ENTRY skipped: could not read the spans to preserve (${describe(error)})`);
            return false;
        }

        // --- Phase 2: destructive ---------------------------------------------------------------
        let eraseStarted = false;
        // What the run got through before it failed. The recovery needs all three: which spans are
        // already back (so it does not rewrite what is already right), and whether the programming
        // session was closed (so it can close it rather than leaving the DME mid-session).
        const restored = new Set<number>();
        let recycleOffSent = false;
        let finishSent = false;
        try {
            // The marker the DME wants before it will permit this erase. Read first: a DME that has
            // had fast entry run before already carries it, and programming an already-programmed
            // cell is exactly what the write acknowledgement's verify byte rejects.
            for (const processor of ['master', 'slave'] as const) {
                const at = FREE_IDENTIFIERS.start + ServiceBlock.prepMarkerOffset;
                const present = await this.readChunk(
                    0x00, toDs2Address(processor, at), FAST_ENTRY_PREP_MARKER.length);
                if (present.every((b) => b === 0xff)) {
                    await this.writeServiceBlock(processor, at, FAST_ENTRY_PREP_MARKER);
                    say(`FAST ENTRY ${processor} prep marker written`);
                } else {
                    say(`FAST ENTRY ${processor} prep marker already present`);
                }
            }

            // Recycle-only suppresses the tail-guard erase, so the 8 KiB block is all that goes.
            await this.control(buildRecyclingTelegram(RECYCLE_ONLY_ADDRESS), TIMEOUTS.write, 'recycle-only');

            eraseStarted = true;
            for (const processor of ['master', 'slave'] as const) {
                await this.control(buildFastEntryEraseTelegram(processor), TIMEOUTS.erase, `erase ${processor}`);
            }
            say('FAST ENTRY erased both Free Identifiers sectors');

            for (const [index, { span, data }] of live.entries()) {
                await this.restoreSpan(span, data);
                restored.add(index);
            }

            // Byte for byte, span by span, and BEFORE the session is closed. A mismatch here is the
            // one failure worth stopping everything for: identity records cannot be rebuilt.
            for (const { span, data } of live) {
                const back = await this.readRange(span);
                if (!sameBytes(back, data)) {
                    throw new SessionError(
                        `restore verify failed for ${span.processor} 0x${span.start.toString(16)}+${span.length}`);
                }
            }
            say('FAST ENTRY restore verified');

            // --- Phase 3: free ------------------------------------------------------------------
            await this.control(buildRecyclingTelegram(RECYCLE_OFF_ADDRESS), TIMEOUTS.write, 'recycle-off');
            recycleOffSent = true;
            await this.control(buildFinishTelegram(0), TIMEOUTS.write, 'finish');
            finishSent = true;
        } catch (error) {
            if (!eraseStarted) { say(`FAST ENTRY skipped before the erase: ${describe(error)}`); return false; }

            // Past the erase. The sector holding the VIN, the AIF and the flash counter is open,
            // and this is the only moment anything can be done about it - see `recoverFastEntry`.
            const recovery = await this.recoverFastEntry(live, restored, recycleOffSent, finishSent, say);

            throw new SessionError(
                `Fast entry failed after the erase started: ${describe(error)}.`
                + (recovery.serviceBlockIntact
                    ? ' Recovery put the Free Identifiers sector back and it verifies byte for byte'
                      + `${recovery.sessionClosed ? ' with the programming session closed' : ''}.`
                      + ' Re-read the service block and compare it with the backup before writing'
                      + ' anything to this DME.'
                    : ' RECOVERY DID NOT RESTORE THE SECTOR'
                      + `${recovery.failed.length > 0 ? ` (${recovery.failed.join('; ')})` : ''}.`
                      + ' The VIN, the AIF and the flash counter may be gone. Do NOT write anything'
                      + ' to this DME. Restore the service block from the backup before continuing.'));
        }

        // The switch, last, and best effort. Everything above is committed and verified.
        if (!this.transport.setBaudRate) {
            say('FAST ENTRY: this transport cannot change baud; reading at 9600');
            return false;
        }
        try {
            await this.link.transceive(buildBaudRateTelegram(FAST_READ_BAUD), TIMEOUTS.response);
            await this.transport.setBaudRate(FAST_READ_BAUD);
            await this.ident(); // proof it actually held, before a single data byte is trusted
            say(`FAST ENTRY complete: link at ${FAST_READ_BAUD}`);
            return true;
        } catch (error) {
            say(`FAST ENTRY switch did not hold (${describe(error)}); falling back to 9600`);
            try { await this.transport.setBaudRate(9600); } catch { /* best effort */ }
            try { await this.transport.drain?.(); } catch { /* best effort */ }
            return false;
        }
    }

    /**
     * Put the Free Identifiers sector back after a failure past the erase.
     *
     * ## Why this is worth having, and why only here
     *
     * The window it covers is the one between "erase SA1" and "restore verified", and everything in
     * it happens at 9600 - the switch to 125000 comes afterwards, so this does not depend on the
     * boost having worked. Inside that window the DME is running its ordinary firmware and answering
     * DS2 normally, and SA1 is a sector this tool is allowed to write (nibble 0/8). Both of those
     * are what make writing the bytes back a thing that can work at all.
     *
     * **Neither holds for the bootloader replacement, which is why there is no equivalent there.**
     * Past the arming step a DME that fails does not answer DS2 at all - the reset handler tests the
     * magic before the K-line comes up - and SA0 is nibble 1/9, which the firmware refuses to erase
     * or write. A host-side recovery has neither a device to talk to nor a legal telegram to send.
     * That path's mitigations live inside the loader instead (clear the magic first, move VBR to a
     * RAM halt table, retry the erase-and-program in RAM) and in the bench supply requirement.
     *
     * ## What it does
     *
     * Best effort throughout, and it never throws: the caller is about to report the ORIGINAL cause
     * and a recovery that replaced it with its own error would hide the thing that went wrong. A
     * span that cannot be restored is recorded and the next one is still attempted, because the
     * spans are independent and getting three of four back is better than getting none.
     *
     * It also closes the programming session if the run did not get that far. Leaving the DME with
     * recycling on and no finalize is a state the proven procedure never leaves it in.
     *
     * ## It says whether it worked
     *
     * The reference implementation restores and returns, leaving the operator's real question -
     * "is my VIN still there?" - unanswered. This re-reads every span afterwards and compares it
     * byte for byte, so the message the caller throws can say which of the two situations this is.
     * They call for opposite next steps: one is "carry on carefully", the other is "restore from
     * the backup before touching anything".
     */
    private async recoverFastEntry(
        live: readonly { span: Span; data: Uint8Array }[],
        restored: ReadonlySet<number>,
        recycleOffSent: boolean,
        finishSent: boolean,
        say: (line: string) => void,
    ): Promise<{ serviceBlockIntact: boolean; sessionClosed: boolean; failed: string[] }> {
        say('FAST ENTRY recovery started');
        const failed: string[] = [];
        const name = (span: Span): string =>
            `${span.processor} 0x${span.start.toString(16)}+${span.length}`;

        for (const [index, { span, data }] of live.entries()) {
            try {
                // A span the run already wrote is usually fine; reading first avoids a second write
                // to cells that are already right, which on NOR is not free.
                if (restored.has(index) && sameBytes(await this.readRange(span), data)) continue;
                await this.restoreSpan(span, data);
            } catch (error) {
                failed.push(`${name(span)}: ${describe(error)}`);
                say(`FAST ENTRY recovery could not restore ${name(span)}`);
            }
        }

        let sessionClosed = recycleOffSent && finishSent;
        try {
            if (!recycleOffSent) {
                await this.control(buildRecyclingTelegram(RECYCLE_OFF_ADDRESS), TIMEOUTS.write, 'recycle-off');
            }
            if (!finishSent) {
                await this.control(buildFinishTelegram(0), TIMEOUTS.write, 'finish');
            }
            sessionClosed = true;
        } catch (error) {
            say(`FAST ENTRY recovery could not close the programming session: ${describe(error)}`);
        }

        // The answer the operator actually needs, and it is only trustworthy read back off the DME.
        let serviceBlockIntact = failed.length === 0;
        if (serviceBlockIntact) {
            for (const { span, data } of live) {
                try {
                    if (sameBytes(await this.readRange(span), data)) continue;
                    failed.push(`${name(span)}: still differs after recovery`);
                } catch (error) {
                    failed.push(`${name(span)}: could not be read back (${describe(error)})`);
                }
            }
            serviceBlockIntact = failed.length === 0;
        }

        say(serviceBlockIntact
            ? 'FAST ENTRY recovery finished: the sector reads back as it was'
            : 'FAST ENTRY recovery finished: the sector is NOT back');
        return { serviceBlockIntact, sessionClosed, failed };
    }

    /** Read one span of the service block, live. */
    private async readRange(span: Span): Promise<Uint8Array> {
        const out = new Uint8Array(span.length);
        for (let offset = 0; offset < span.length; offset += READ_CHUNK_MAX) {
            const count = Math.min(READ_CHUNK_MAX, span.length - offset);
            out.set(await this.readChunk(0x00, toDs2Address(span.processor, span.start + offset), count), offset);
        }
        return out;
    }

    /** Write one span back, in even-aligned telegram-sized chunks. */
    private async restoreSpan(span: Span, data: Uint8Array): Promise<void> {
        for (const chunk of chunkSpan(span)) {
            const from = chunk.start - span.start;
            const bytes = new Uint8Array(chunk.length).fill(0xff);
            for (let i = 0; i < chunk.length; i++) {
                const source = from + i;
                if (source >= 0 && source < data.length) bytes[i] = data[source]!;
            }
            await this.writeServiceBlock(span.processor, chunk.start, bytes);
        }
    }

    /**
     * One write telegram into a service block, validated by its acknowledgement.
     *
     * Not retried, and that is deliberate: a write that round-tripped and was refused means the
     * device tried and could not, and re-sending it papers over failing flash. Only a transport
     * failure would be idempotent, and this layer cannot tell the two apart - so it does neither.
     */
    private async writeServiceBlock(processor: Processor, imageAddress: number, bytes: Uint8Array): Promise<void> {
        const telegram = buildFastEntryWriteTelegram(processor, imageAddress, bytes);
        // Retried for the same reason as writeChunk, and with more at stake: this is the restore of
        // the Free Identifiers sector during fast entry, so it always runs with that sector erased.
        // A telegram lost here loses the VIN and the flash counter, and it is the one sector no
        // distributable image can put back.
        const response = await this.link.transceiveWrite(telegram, TIMEOUTS.write);
        const ack = parseWriteAcknowledgement(
            response, toDs2Address(processor, imageAddress), bytes.length);
        if (!ack.ok) {
            throw new SessionError(
                `write to ${processor} 0x${imageAddress.toString(16)} was not acknowledged: ${ack.reason}`);
        }
    }

    /** One programming-control telegram, checked for an ACK. */
    private async control(telegram: Uint8Array, timeoutMs: number, what: string): Promise<void> {
        requireAck(await this.link.transceive(telegram, timeoutMs), what);
    }

    // ---------------------------------------------------------------------------------------
    // The destructive primitives
    //
    // Each one builds through `telegrams.ts` (which refuses while the build gate is shut) and
    // sends through `Ds2Link` (which refuses unless the transport declares itself a simulator).
    // Neither gate is here, on purpose: a guard duplicated into every caller is a guard that will
    // eventually be forgotten in one of them.
    // ---------------------------------------------------------------------------------------

    /** Erase one window. The address selects the sector; the firmware decides how much goes. */
    async eraseWindow(ds2Address: number): Promise<void> {
        await this.control(buildEraseTelegram(ds2Address), TIMEOUTS.erase,
            `erase at 0x${ds2Address.toString(16)}`);
    }

    /**
     * Program one chunk, validated by its acknowledgement.
     *
     * The TELEGRAM is retried; the ACKNOWLEDGEMENT never is, and the line between them is the whole
     * design. `transceiveWrite` retries only a transport failure - a timeout, a break - which means
     * the telegram never landed and re-sending the same bytes to the same address is idempotent.
     * The check below runs on a telegram that round-tripped: a refusal there means the DME received
     * it, tried, and could not, and re-sending that would paper over failing flash and then report
     * success.
     *
     * This split is what the reference implementation does, and the reason the retry half of it is
     * not optional: this call runs AFTER an erase. Without it, one lost telegram failed the entire
     * flash on an ECU whose program window was already gone.
     */
    async writeChunk(ds2Address: number, bytes: Uint8Array): Promise<void> {
        const response = await this.link.transceiveWrite(buildWriteTelegram(ds2Address, bytes), TIMEOUTS.write);
        const ack = parseWriteAcknowledgement(response, ds2Address, bytes.length);
        if (!ack.ok) {
            throw new SessionError(
                `write of ${bytes.length} B to 0x${ds2Address.toString(16)} was not acknowledged: ${ack.reason}`);
        }
    }

    /** Read a window back through the ordinary windowed read, for a byte-for-byte verify. */
    async readWindow(ds2Address: number, length: number): Promise<Uint8Array> {
        const out = new Uint8Array(length).fill(0xff);
        for (let offset = 0; offset < length; offset += READ_CHUNK_MAX) {
            const count = Math.min(READ_CHUNK_MAX, length - offset);
            out.set(await this.readChunk(0x00, ds2Address + offset, count), offset);
        }
        return out;
    }

    /**
     * Describe a captured image, so an operator sees what they got rather than a filename.
     */
    static describe(image: Uint8Array): string {
        if (image.length !== FULL_IMAGE_LENGTH) return `image is ${image.length} bytes, not a full capture`;
        const lines: string[] = [];
        for (const processor of ['master', 'slave'] as const) {
            const sa0 = extractSa0(image, processor);
            const crc = verifyBootloaderCrc(sa0, processor);
            lines.push(
                `${processor}: bootloader ${identifyBootloader(sa0, processor)}`
                + `, CRC 0x${crc.stored.toString(16).padStart(4, '0')} ${crc.valid ? 'valid' : 'INVALID'}`);
        }
        lines.push(`master program number: ${masterProgramNumbers(extractSa0(image, 'master')).join(', ')}`);
        const serviceBlock = image.subarray(0x4000, 0x8000);
        const written = serviceBlock.reduce((n, b) => n + (b !== 0xff ? 1 : 0), 0);
        lines.push(`master service block: ${written} bytes of car-specific data`
            + ` (0 would mean this capture cannot restore VIN/AIF/flash counter)`);
        return lines.join('\n');
    }
}

/** Re-exported so a caller can size a progress bar before starting. */
export { PROCESSOR_FLASH_LENGTH, CENSORED_RANGE };

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}
