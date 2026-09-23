/**
 * The program / calibration write, executed over DS2 against a simulated ECU.
 *
 * This is the stage that makes a car a CSL, and unlike the bootloader stage it is the ordinary
 * path: every telegram is one the firmware was built to accept, and a failure leaves a DME that
 * still answers DS2 with an erased program area. The tests below are about proving that claim -
 * that the sequence erases before it writes, stays inside the accepted windows, and reads back as
 * what was sent.
 */
import { describe, it, expect, vi } from 'vitest';
import { Ds2Session } from './session';
import { runFlash } from './flashExecute';
import { planFlash } from './flashSequence';
import { practiceEcuImage, practiceProgrammingTransport } from './practiceEcu';
import { withSimulatedEcu } from './writeLock';
import {
    IMAGE_WINDOWS, FULL_IMAGE_LENGTH, isProtectedImageOffset, type WindowKind,
} from './imageLayout';
import type { FlashHooks } from './flashExecute';

/**
 * These write 512 KiB of program through the real telegram path - ~4,300 write exchanges, each
 * built, framed, acknowledged and applied to a NOR model - then compare a megabyte byte by byte.
 * That is seconds of genuine work, not a hang, and vitest's 5 s default is the wrong budget for
 * it. Raised per file rather than globally, so a test that really does hang elsewhere still
 * fails fast.
 */
vi.setConfig({ testTimeout: 60_000 });

/**
 * A 1 MiB image shaped like a real one, differing from the ECU everywhere the plan writes.
 *
 * The tail of each program window is left blank, because that is what every real image looks like -
 * see the test below. Getting this wrong the first time is what surfaced the erase asymmetry: the
 * fixture had a pattern there, the erase cleared it, nothing wrote it back, and the read-back
 * verify correctly said the DME did not match.
 */
function targetImage(): Uint8Array {
    const image = practiceEcuImage();
    for (const window of IMAGE_WINDOWS) {
        for (let i = 0; i < window.length; i++) {
            // Deliberately CLEARS bits relative to the ECU's pattern in some places and sets them
            // in others, so the run only succeeds if the erase actually happened first.
            image[window.imageOffset + i] = (i * 7 + window.imageOffset) & 0xff;
        }
    }
    // The 192 KiB the program erase clears and no SP-DATEN file carries.
    for (const base of [0, 0x80000]) image.fill(0xff, base + 0x50000, base + 0x80000);
    return image;
}

/** Every full-image offset one erase in this plan will clear, written back or not. */
function erasedRanges(windowKinds: readonly WindowKind[]): { start: number; end: number }[] {
    const ranges: { start: number; end: number }[] = [];
    for (const base of [0, 0x80000]) {
        // The firmware's own sector sizes, which are larger than the windows an image carries.
        if (windowKinds.includes('calibration')) ranges.push({ start: base + 0x8000, end: base + 0x10000 });
        if (windowKinds.includes('program')) ranges.push({ start: base + 0x10000, end: base + 0x80000 });
    }
    return ranges;
}

async function flash(windowKinds: readonly WindowKind[], options: FlashHooks = {}) {
    const ecu = practiceEcuImage();
    const { transport } = practiceProgrammingTransport(ecu, { batchMs: 0 });
    const session = new Ds2Session(transport, { delay: async () => {} });
    const image = targetImage();
    const events: string[] = [];
    const phases: string[] = [];

    return withSimulatedEcu(async () => {
        const plan = planFlash({ image, windowKinds });
        const outcome = await runFlash(session, plan, image, {
            onEvent: (line) => events.push(line),
            onProgress: (p) => { if (phases[phases.length - 1] !== p.phase) phases.push(p.phase); },
            ...options,
        });
        return { outcome, events, phases, ecu, image, plan };
    });
}

describe('writing the CSL program and calibration', () => {
    it('lands every byte of all four windows on the ECU', async () => {
        const { ecu, image, plan } = await flash(['program', 'calibration']);
        expect(plan.eraseCount).toBe(4);
        for (const window of IMAGE_WINDOWS) {
            for (let i = 0; i < window.length; i++) {
                const at = window.imageOffset + i;
                if (ecu[at] !== image[at]) throw new Error(`0x${at.toString(16)} not written`);
            }
        }
    });

    it('erases before it writes - without that, half these bytes could not be programmed', async () => {
        // NOR only clears bits. The target image sets bits the ECU's pattern does not have, so a
        // run that skipped the erase would leave them clear and the comparison above would fail.
        const { phases } = await flash(['calibration']);
        expect(phases.indexOf('erase')).toBeGreaterThan(-1);
        expect(phases.indexOf('erase')).toBeLessThan(phases.indexOf('write'));
        expect(phases[0]).toBe('login');
    });

    it('touches nothing outside the sectors it erases', async () => {
        // The ERASED ranges, not the written windows. The program erase clears the whole 448 KiB
        // the firmware addresses, while an SP-DATEN image only carries 256 KiB of it - so the tail
        // is blanked and never written back. That is not a bug; it is what the sector map says, and
        // the next test is the evidence that it costs nothing.
        const before = practiceEcuImage();
        const { ecu } = await flash(['program', 'calibration']);
        const erased = erasedRanges(['program', 'calibration']);
        const wasErased = (at: number): boolean => erased.some((r) => at >= r.start && at < r.end);
        for (let at = 0; at < FULL_IMAGE_LENGTH; at++) {
            if (wasErased(at)) continue;
            if (ecu[at] !== before[at]) throw new Error(`disturbed 0x${at.toString(16)}`);
        }
    });

    it('leaves the program tail blank, which is what it already was on every real image', async () => {
        const { ecu } = await flash(['program']);
        for (const base of [0, 0x80000]) {
            for (let at = base + 0x50000; at < base + 0x80000; at++) {
                expect(ecu[at], `0x${at.toString(16)}`).toBe(0xff);
            }
        }
    });

    it('leaves the bootloader and the service block alone', async () => {
        const before = practiceEcuImage();
        const { ecu } = await flash(['program', 'calibration']);
        for (let at = 0; at < FULL_IMAGE_LENGTH; at++) {
            if (!isProtectedImageOffset(at)) continue;
            expect(ecu[at], `0x${at.toString(16)}`).toBe(before[at]);
        }
    });

    it('can write the calibration alone without erasing a program window', async () => {
        // The reflash-only case: a calibration change must not cost the program area.
        const before = practiceEcuImage();
        const { ecu, plan } = await flash(['calibration']);
        expect(plan.eraseCount).toBe(2);
        const program = IMAGE_WINDOWS.filter((w) => w.kind === 'program');
        for (const window of program) {
            for (let i = 0; i < window.length; i++) {
                const at = window.imageOffset + i;
                expect(ecu[at], `0x${at.toString(16)}`).toBe(before[at]);
            }
        }
    });

    it('reports NOT verified when the read-back was skipped', async () => {
        // A run nobody checked must not be reported as one that passed.
        const { outcome } = await flash(['calibration']);
        expect(outcome.verified).toBe(false);
        expect(outcome.differingOffsets).toEqual([]);
    });

    it('says so in the log, so "not verified" is visible and not just a field', async () => {
        const { events } = await flash(['calibration']);
        expect(events.some((l) => l.includes('not verified'))).toBe(true);
    });

    it('verifies by reading the DME back when asked', async () => {
        const { outcome, events } = await flash(['program', 'calibration'], { verifyReadBack: true });
        expect(outcome.verified).toBe(true);
        expect(outcome.differingOffsets).toEqual([]);
        expect(events.some((l) => l.includes('byte for byte'))).toBe(true);
    });

    it('verifies the windows it wrote, not the whole megabyte', async () => {
        // The case the fixture above cannot catch, because it starts from the ECU's own image and
        // so already agrees everywhere outside the windows. A real conversion image is 0xFF there
        // while the ECU still holds its bootloader and service block - and comparing all 1 MiB
        // reported every successful write as a failure.
        const ecu = practiceEcuImage();
        const { transport } = practiceProgrammingTransport(ecu, { batchMs: 0 });
        const session = new Ds2Session(transport, { delay: async () => {} });

        // Exactly what buildConversionImage produces: content in the windows, 0xFF everywhere else.
        const image = new Uint8Array(FULL_IMAGE_LENGTH).fill(0xff);
        for (const window of IMAGE_WINDOWS) {
            for (let i = 0; i < window.length; i++) {
                image[window.imageOffset + i] = (i * 7 + window.imageOffset) & 0xff;
            }
        }
        for (const base of [0, 0x80000]) image.fill(0xff, base + 0x50000, base + 0x80000);

        const outcome = await withSimulatedEcu(async () => {
            const plan = planFlash({ image, windowKinds: ['program', 'calibration'] });
            return runFlash(session, plan, image, { verifyReadBack: true });
        });

        expect(outcome.verified).toBe(true);
        expect(outcome.differingOffsets).toEqual([]);
        // And the ECU really does still hold what the plan never wrote.
        const before = practiceEcuImage();
        expect(ecu[0x100]).toBe(before[0x100]);        // master bootloader
        expect(ecu[0x4800]).toBe(before[0x4800]);      // master flash counter
    });

    it('counts the bytes it actually wrote', async () => {
        const { outcome, plan } = await flash(['program', 'calibration']);
        const expected = IMAGE_WINDOWS.reduce((n, w) => n + w.length, 0);
        expect(plan.writeBytes).toBe(expected);
        expect(outcome.writeBytes).toBe(expected);
    });
});

describe('the gate, on the ordinary write path too', () => {
    it('refuses to send the sequence to a transport that is not a simulator', async () => {
        const sent: Uint8Array[] = [];
        const { transport: sim } = practiceProgrammingTransport(practiceEcuImage(), { batchMs: 0 });
        const real = {
            write: async (b: Uint8Array) => { sent.push(b); await sim.write(b); },
            read: (n: number, t: number) => sim.read(n, t),
            drain: async () => { await sim.drain?.(); },
        };
        const session = new Ds2Session(real, { delay: async () => {} });
        const image = targetImage();

        await withSimulatedEcu(async () => {
            const plan = planFlash({ image, windowKinds: ['calibration'] });
            await expect(runFlash(session, plan, image)).rejects.toThrow(/writes are locked/);
        });
        expect(sent.some((f) => f[2] === 0x07)).toBe(false);
    });
});
