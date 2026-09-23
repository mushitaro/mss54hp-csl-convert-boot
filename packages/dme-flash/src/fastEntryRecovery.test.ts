/**
 * Putting the Free Identifiers sector back when fast entry fails past the erase.
 *
 * This is the one window in the whole app where a host-side recovery is both possible and worth
 * having, and the shape of that claim is worth stating because it is what decides where such code
 * belongs at all:
 *
 *   - the window runs entirely at 9600 (the switch to 125000 comes after the restore verifies), so
 *     recovery does not depend on the boost having worked;
 *   - the DME is running its ordinary firmware and answering DS2 throughout;
 *   - SA1 is nibble 0/8, which this tool is permitted to write.
 *
 * None of those hold past the bootloader arming step, which is why there is no equivalent there and
 * why the mitigations for that path live inside the loader instead.
 *
 * What is at stake here is the VIN, the AIF and the flash counter - the one part of a DME that no
 * distributable image can put back.
 */
import { describe, it, expect, vi } from 'vitest';
import { Ds2Session, SessionError } from './session';
import { practiceEcuImage, practiceProgrammingTransport, PracticeDme } from './practiceEcu';
import { withSimulatedEcu } from './writeLock';
import { buildPreservationPlan, FREE_IDENTIFIERS, extractServiceBlock } from './fastEntry';
import { Segment } from './regionMap';
import { FULL_IMAGE_LENGTH } from './imageLayout';
import { parseDs2Frame, buildDs2Frame, DME_DS2_ADDRESS } from './ds2';
import type { ByteTransport } from './transport';
import type { VerifiedBackup } from './fastEntry';

vi.setConfig({ testTimeout: 60_000 });

const COMMAND_PROGRAM = 0x07;

/**
 * A practice DME that refuses some WRITE telegrams, but only once the erase has gone out.
 *
 * The gate on `erased` is the whole reason this harness is written by hand rather than counting
 * telegrams: the prep marker is a write too, and it is sent BEFORE the erase. Refusing it produces
 * a run that skips fast entry cleanly with nothing destroyed - a correct outcome, and not the one
 * under test here.
 *
 * Refusing means the response is simply not produced, so the read underruns - a transport-level
 * failure, which is the kind `transceiveWrite` retries. A refusal shorter than the retry budget is
 * therefore invisible; these tests refuse for long enough to actually fail a chunk.
 */
function faultyTransport(
    image: Uint8Array,
    refuse: (address: number, nth: number) => boolean,
): { transport: ByteTransport; dme: PracticeDme } {
    const dme = new PracticeDme(image);
    let buffer: number[] = [];
    let writes = 0;
    let erased = false;

    const transport: ByteTransport = {
        simulated: true,
        write: async (bytes) => {
            buffer.push(...bytes); // the K-line echo, always
            const parsed = parseDs2Frame(bytes);
            if (!parsed.ok || !parsed.data) return;
            const data = parsed.data;
            if (data[0] === COMMAND_PROGRAM && data[1] === Segment.Erase) erased = true;
            if (erased && data[0] === COMMAND_PROGRAM && data[1] === Segment.Write) {
                const address = ((data[2] ?? 0) << 16) | ((data[3] ?? 0) << 8) | (data[4] ?? 0);
                if (refuse(address, ++writes)) return; // no response: the read will underrun
            }
            buffer.push(...buildDs2Frame(DME_DS2_ADDRESS, dme.respond(data)));
        },
        read: async (count) => {
            if (buffer.length < count) throw new Error('no response from the DME');
            return Uint8Array.from(buffer.splice(0, count));
        },
        drain: async () => { buffer = []; },
    };
    return { transport, dme };
}

/** A verified backup of the practice ECU, which fast entry requires before it will do anything. */
function backupOf(image: Uint8Array): VerifiedBackup {
    return { image: Uint8Array.from(image), verified: true };
}

function serviceBlocksOf(image: Uint8Array): { master: Uint8Array; slave: Uint8Array } {
    return {
        master: Uint8Array.from(extractServiceBlock(image, 'master')),
        slave: Uint8Array.from(extractServiceBlock(image, 'slave')),
    };
}

describe('fast entry failing after the erase', () => {
    it('puts the sector back, closes the session, and says it worked', async () => {
        const image = practiceEcuImage();
        expect(image.length).toBe(FULL_IMAGE_LENGTH);
        const before = serviceBlocksOf(image);
        const backup = backupOf(image);

        // Refuse the first restore chunk for longer than the retry budget, so the restore really
        // fails and the recovery is the thing that puts those bytes back.
        let refusals = 0;
        const { transport } = faultyTransport(image, () => (refusals < 6 ? (refusals++, true) : false));
        const session = new Ds2Session(transport, { delay: async () => {} });

        const events: string[] = [];
        const error = await withSimulatedEcu(async () =>
            session.enterFastRead(backup, (line) => events.push(line)),
        ).catch((e: unknown) => e);

        expect(error, 'the original failure must still be reported').toBeInstanceOf(SessionError);
        expect((error as Error).message).toMatch(/failed after the erase started/);
        expect((error as Error).message).toMatch(/Recovery put the Free Identifiers sector back/);
        expect(events.join('\n')).toMatch(/recovery finished: the sector reads back as it was/);

        // The claim the message makes, checked against the flash the DME actually holds.
        const after = serviceBlocksOf(image);
        expect(Array.from(after.master)).toEqual(Array.from(before.master));
        expect(Array.from(after.slave)).toEqual(Array.from(before.slave));
    });

    it('says so plainly when the sector did NOT come back', async () => {
        // The two outcomes need opposite next steps from the operator - "carry on carefully" versus
        // "restore from the backup before touching anything" - so reporting them the same way, or
        // reporting a recovery that did not recover as a recovery, is the failure that matters.
        const image = practiceEcuImage();
        const backup = backupOf(image);

        // One address that can never be written, so recovery cannot fix it either.
        let doomed: number | null = null;
        const { transport } = faultyTransport(image, (address) => {
            doomed ??= address;
            return address === doomed;
        });
        const session = new Ds2Session(transport, { delay: async () => {} });

        const events: string[] = [];
        const error = await withSimulatedEcu(async () =>
            session.enterFastRead(backup, (line) => events.push(line)),
        ).catch((e: unknown) => e);

        expect((error as Error).message).toMatch(/RECOVERY DID NOT RESTORE THE SECTOR/);
        expect((error as Error).message).toMatch(/Do NOT write anything to this DME/);
        expect(events.join('\n')).toMatch(/recovery finished: the sector is NOT back/);
    });

    it('leaves a failure BEFORE the erase as an ordinary skip, with no recovery at all', async () => {
        // Nothing has been destroyed, so there is nothing to put back and fast entry is simply not
        // taken. Running a recovery here would write to a sector that was never opened.
        const image = practiceEcuImage();
        const blank = Uint8Array.from(image);
        blank.fill(0xff, FREE_IDENTIFIERS.start, FREE_IDENTIFIERS.end);

        const { transport } = faultyTransport(image, () => false);
        const session = new Ds2Session(transport, { delay: async () => {} });

        const events: string[] = [];
        const boosted = await withSimulatedEcu(async () =>
            session.enterFastRead(backupOf(blank), (line) => events.push(line)));

        expect(boosted).toBe(false);
        expect(events.join('\n')).not.toMatch(/recovery/i);
    });

    it('refuses before touching anything when there is no verified backup to restore from', () => {
        // The precondition the whole procedure rests on: the spans are read live, but the decision
        // that they are the RIGHT spans comes from a capture that was confirmed twice.
        expect(buildPreservationPlan(null).safe).toBe(false);
        expect(buildPreservationPlan({
            image: practiceEcuImage(), verified: false,
        }).safe).toBe(false);
    });
});
