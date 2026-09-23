/**
 * The numbers the app puts in front of an operator, checked against what the code actually did.
 *
 * Every case here was a sentence that was true-sounding and wrong. They are grouped in one file
 * because they are one kind of defect: a screen reporting a quantity it did not measure. That is
 * worse than a missing number - the operator uses it to decide whether to carry on, and a small
 * wrong number reads as "this is fine".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Ds2Session, runBlReplace, planProbe, buildProbeSector, VANOS_OFFSETS,
    practiceEcuImage, practiceProgrammingTransport, practiceSa0, withSimulatedEcu,
    CENSORED_RANGE, SA0_LENGTH } from 'dme-flash';
import { assemble } from '../../dme-flash/src/emulator/asm68k';
import { t } from './copy';

const probe = assemble(readFileSync('tools/loader/probe.s', 'utf8'));

describe('how many bytes differ', () => {
    /**
     * The screen said "8 bytes differ" for a bootloader that read back entirely wrong.
     *
     * `differingOffsets` is a diagnostic sample capped at eight, and its length was being reported
     * as the count - on the screen where the operator decides whether to go on to the processor
     * that speaks DS2. Eight bytes reads as a glitch. Sixteen thousand does not.
     */
    it('is the count, not the length of the eight-entry sample', async () => {
        const image = practiceEcuImage();
        const { transport, dme } = practiceProgrammingTransport(image, { batchMs: 0 });
        const session = new Ds2Session(transport, { delay: async () => {} });

        const outcome = await withSimulatedEcu(async () => {
            const plan = planProbe(buildProbeSector('slave', probe.bytes));
            // Compare the read-back against an SA0 that is wrong everywhere, which is what a failed
            // replacement looks like. The count must describe all of it.
            const nothingLikeIt = new Uint8Array(SA0_LENGTH).fill(0x5a);
            return runBlReplace(session, plan, nothingLikeIt, {
                onPowerCycle: async () => { dme.powerCycle(); },
            });
        });

        expect(outcome.matchesIntended).toBe(false);
        expect(outcome.differingOffsets.length, 'the sample stays small enough to show').toBe(8);
        expect(outcome.differingCount, 'the count describes the whole failure')
            .toBeGreaterThan(1000);
        expect(outcome.differingCount).not.toBe(outcome.differingOffsets.length);
    });

    it('is zero when nothing differs, and the probe leaves nothing differing', async () => {
        const image = practiceEcuImage();
        const { transport, dme } = practiceProgrammingTransport(image, { batchMs: 0 });
        const session = new Ds2Session(transport, { delay: async () => {} });
        const before = practiceSa0('slave');

        const outcome = await withSimulatedEcu(async () => {
            const plan = planProbe(buildProbeSector('slave', probe.bytes));
            return runBlReplace(session, plan, before, {
                onPowerCycle: async () => { dme.powerCycle(); },
            });
        });
        expect(outcome.differingCount).toBe(0);
        expect(outcome.matchesIntended).toBe(true);
    });
});

describe('what a wrong camshaft answer looks like on the car', () => {
    /**
     * The check told the operator to look for 5.0 deg KW. There are two offsets and they differ by
     * different amounts, so an operator who happened to measure the other bank saw 3.0, did not see
     * the number they were told to look for, and concluded the setting was right.
     *
     * This is the only way a wrong answer is ever detectable - it stores no fault code and lights
     * no lamp - so the instruction being half right made it worse than useless.
     */
    it('is two different numbers, and the copy names both', () => {
        const a = Math.abs(VANOS_OFFSETS.m3[0] - VANOS_OFFSETS.csl[0]) / 10;
        const b = Math.abs(VANOS_OFFSETS.m3[1] - VANOS_OFFSETS.csl[1]) / 10;

        expect(a).not.toBe(b);
        expect([a, b].sort()).toEqual([3, 5]);

        const text = t().patchCamCheck(a, b);
        expect(text).toContain('5.0');
        expect(text).toContain('3.0');
    });
});

describe('naming the phase on the progress bar', () => {
    it('translates the executor ids and leaves the app own short ones alone', () => {
        const c = t();
        // The ids that were being shown raw during the most dangerous minutes of the job.
        for (const id of ['erase-calibration', 'write-staged', 'verify-staged', 'read-after']) {
            expect(c.phaseName(id), id).not.toBe(id.toUpperCase());
            expect(c.phaseName(id), id).not.toContain('-');
        }
        // Chrome stays chrome: the app sets these itself and they are the same in both languages.
        expect(c.phaseName('CONNECT')).toBe('CONNECT');
        expect(c.phaseName('BACKUP PASS 1')).toBe('BACKUP PASS 1');
    });
});

describe('the 24 bytes no capture can hold', () => {
    /**
     * The backup screen calls the file the only way back. Twenty-four bytes of it are not real: the
     * firmware answers 0xFF for reads of 0x4000-0x4017 whoever asks, so they are absent from the
     * capture, excluded from the two-pass comparison, and unrecoverable from the file.
     *
     * The screen said "1,048,576 bytes, two passes agree" and nothing else.
     */
    it('is disclosed with its real address and size', () => {
        const n = CENSORED_RANGE.end - CENSORED_RANGE.start;
        expect(n).toBe(24);

        const text = t().backupCensored(CENSORED_RANGE.start, CENSORED_RANGE.end, n);
        expect(text).toContain('4000');
        expect(text).toContain('4017');
        expect(text).toContain('24');
    });
});
