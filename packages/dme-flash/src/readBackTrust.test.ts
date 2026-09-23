/**
 * Whether a read-back is allowed to certify a write.
 *
 * `fullBackup` reads the DME twice and compares the passes with each other, because a single pass
 * that dropped or duplicated a chunk produces a capture that looks entirely plausible. `runFlash`
 * took that function's `image` and threw its verdict away - so a read that contradicted itself, and
 * happened to agree with the intended image on pass one, was reported to the operator as a verified
 * write.
 *
 * The scenario below is exactly that, and it is not contrived: it is one byte reading differently
 * between two passes over the same DME, which is the precise failure the two-pass design exists to
 * catch everywhere else in this app.
 */
import { describe, it, expect, vi } from 'vitest';
import { Ds2Session } from './session';
import { runFlash } from './flashExecute';
import { planFlash } from './flashSequence';
import { PracticeDme, practiceEcuImage } from './practiceEcu';
import { withSimulatedEcu } from './writeLock';
import { IMAGE_WINDOWS } from './imageLayout';
import { planWholeDmeRead } from './fullSpaceRead';
import { buildDs2Frame, parseDs2Frame, DME_DS2_ADDRESS } from './ds2';
import type { ByteTransport } from './transport';

vi.setConfig({ testTimeout: 120_000 });

/** The image the plan writes: different from the ECU everywhere a window lands. */
function targetImage(): Uint8Array {
    const image = practiceEcuImage();
    for (const window of IMAGE_WINDOWS) {
        for (let i = 0; i < window.length; i++) {
            image[window.imageOffset + i] = (i * 7 + window.imageOffset) & 0xff;
        }
    }
    for (const base of [0, 0x80000]) image.fill(0xff, base + 0x50000, base + 0x80000);
    return image;
}

/**
 * A practice DME whose flash changes ONE byte partway through the read-back.
 *
 * `flipAfterReads` is counted in read telegrams, so the flip is placed after the first pass has
 * already been served. Pass one therefore matches the intended image exactly and pass two does not
 * - the shape that used to produce a confident "VERIFIED".
 *
 * The frame stays well-formed: the byte is changed in the array the DME reads from, so the response
 * carries a correct checksum and the link has no reason to retry. A corrupted frame would be caught
 * by the DS2 layer and is a different failure entirely.
 */
function flakyTransport(image: Uint8Array, flipAfterReads: number, flipAt: number): ByteTransport {
    const dme = new PracticeDme(image);
    let buffer: number[] = [];
    let reads = 0;
    let flipped = false;

    return {
        simulated: true,
        write: async (bytes) => {
            buffer.push(...bytes);
            const parsed = parseDs2Frame(bytes);
            if (!parsed.ok || !parsed.data) return;
            // 0x06 is the read command; count only those, so writes do not move the trigger.
            if (parsed.data[0] === 0x06 && ++reads === flipAfterReads && !flipped) {
                flipped = true;
                image[flipAt] = (image[flipAt]! ^ 0xff) & 0xff;
            }
            buffer.push(...buildDs2Frame(DME_DS2_ADDRESS, dme.respond(parsed.data)));
        },
        read: async (count) => {
            if (buffer.length < count) throw new Error('practice DME underran');
            return Uint8Array.from(buffer.splice(0, count));
        },
        drain: async () => { buffer = []; },
    };
}

describe('a read-back that contradicts itself', () => {
    it('cannot report the write as verified, even when pass one matches', async () => {
        const image = targetImage();
        const ecu = practiceEcuImage();

        /**
         * Placed from the plan's own chunk count, not from a guessed number.
         *
         * The trigger has to land after pass one has served every chunk and before pass two reaches
         * the flipped byte. Guessing a round number got that backwards the first time - the flip
         * fired after pass two had already read the offset, so both passes agreed and the test
         * quietly proved nothing. The plan knows how many chunks a pass is; ask it.
         *
         * The byte is in the SLAVE window because each pass reads master first, so a slave offset is
         * the last thing pass two touches - the widest possible margin after the trigger.
         */
        const chunksPerPass = planWholeDmeRead().reduce((n, p) => n + p.chunks.length, 0);
        const window = IMAGE_WINDOWS.find((w) => w.kind === 'program' && w.processor === 'slave')!;
        const flipAt = window.imageOffset + 0x100;

        const transport = flakyTransport(ecu, chunksPerPass + 1, flipAt);
        const session = new Ds2Session(transport, { delay: async () => {} });

        const outcome = await withSimulatedEcu(async () => {
            const plan = planFlash({ image, windowKinds: ['program', 'calibration'] });
            return runFlash(session, plan, image, { verifyReadBack: true });
        });

        expect(outcome.readBackAgreed, 'the two passes must be reported as disagreeing').toBe(false);
        expect(outcome.readBackDisagreements.length).toBeGreaterThan(0);
        // The old bug in one line: pass one DID match the image, and that was taken as proof.
        expect(outcome.differingOffsets, 'pass one matched, which is exactly the trap').toEqual([]);
        expect(outcome.verified, 'a self-contradicting read cannot certify anything').toBe(false);
    });

    it('reports a clean read-back as verified, so the guard is not just refusing everything', async () => {
        const image = targetImage();
        const ecu = practiceEcuImage();
        // No flip: the trigger is past any read this run makes.
        const transport = flakyTransport(ecu, Number.MAX_SAFE_INTEGER, 0);
        const session = new Ds2Session(transport, { delay: async () => {} });

        const outcome = await withSimulatedEcu(async () => {
            const plan = planFlash({ image, windowKinds: ['program', 'calibration'] });
            return runFlash(session, plan, image, { verifyReadBack: true });
        });

        expect(outcome.readBackAgreed).toBe(true);
        expect(outcome.verified).toBe(true);
        expect(outcome.comparedBytes).toBe(outcome.writeBytes);
    });
});
