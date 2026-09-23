/**
 * The probe stage, end to end over DS2 against a simulated ECU.
 *
 * `emulator/probeLoader.test.ts` proves the probe does the right thing once the CPU is executing
 * it. This proves the other half: the telegrams that get it there, the plan that refuses to let it
 * carry a bootloader, and the result the operator is shown afterwards.
 *
 * The property the whole probe exists for is narrow. The magic is checked by the reset handler
 * before the SIM, the stack or the K-line come up, so arming is irreversible over OBD and **the
 * first arming is the first execution** - there is no rehearsal. What the probe buys is that the
 * first thing ever armed is the smallest program that can prove the machine setup works, and that
 * it never touches SA0 while doing it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Ds2Session } from './session';
import { runBlReplace } from './blExecute';
import { planProbe, planBlReplace, validateBlReplace, assertBlReplaceable } from './blReplace';
import {
    buildProbeSector, buildStagedSector, carriesNoBootloaderImage,
    STAGING_DS2_ADDRESS, MAGIC_OFFSET, BOOTLOADER_IMAGE_OFFSET, STAGED_MAGIC, MAGIC_CLEARED,
    STAGED_SECTOR_LENGTH,
} from './blLoader';
import { practiceEcuImage, practiceProgrammingTransport, practiceSa0 } from './practiceEcu';
import { patchToCsl, SA0_LENGTH } from './bootloaderImage';
import { withSimulatedEcu } from './writeLock';
import { assemble } from './emulator/asm68k';
import type { Processor } from './imageLayout';

const probe = assemble(readFileSync('tools/loader/probe.s', 'utf8'));
const replace = assemble(readFileSync('tools/loader/replace.s', 'utf8'));

/** A probe run against a simulated ECU, with the ignition cycled for real by `PracticeDme`. */
async function runProbe(processor: Processor) {
    const image = practiceEcuImage();
    const { transport, dme } = practiceProgrammingTransport(image, { batchMs: 0 });
    const session = new Ds2Session(transport, { delay: async () => {} });
    const events: string[] = [];

    // What SA0 already is. For a probe this is also what it must still be afterwards - the same
    // comparison the replacement uses, meaning the opposite thing.
    const before = practiceSa0(processor);

    return withSimulatedEcu(async () => {
        const sector = buildProbeSector(processor, probe.bytes);
        const plan = planProbe(sector);
        const outcome = await runBlReplace(session, plan, before, {
            onEvent: (line) => events.push(line),
            // The simulated ECU runs its own reset handler; nothing is applied by hand here.
            onPowerCycle: async () => { dme.powerCycle(); },
        });
        return { outcome, events, image, dme, plan, before };
    });
}

describe('the probe sector', () => {
    it('carries the loader and the magic, and no bootloader image at all', async () => {
        await withSimulatedEcu(async () => {
            const sector = buildProbeSector('slave', probe.bytes);
            expect(sector.purpose).toBe('probe');
            expect(carriesNoBootloaderImage(sector.bytes)).toBe(true);
            // Erased, not zeroed: this region is never programmed, so it stays as the erase left it.
            expect(sector.bytes[BOOTLOADER_IMAGE_OFFSET]).toBe(0xff);
            expect(sector.bytes.slice(0, probe.bytes.length)).toEqual(probe.bytes);
        });
    });

    it('still refuses a first byte the processor will not run', async () => {
        // Both the reset path and cmd 0x34 test the top byte of the longword at 0x8000 and refuse
        // the value a genuine calibration starts with. A probe is not exempt from that.
        await withSimulatedEcu(async () => {
            expect(() => buildProbeSector('master', Uint8Array.from([0x01, 0x00, 0x4e, 0x71])))
                .toThrow(/refuses/);
            expect(() => buildProbeSector('slave', Uint8Array.from([0x02, 0x00, 0x4e, 0x71])))
                .toThrow(/refuses/);
        });
    });

    it('is gated by the write lock exactly like a replacement sector', () => {
        // Not a telegram, but it exists only to become one, and building it is where a mistake
        // turns into bytes.
        expect(() => buildProbeSector('slave', probe.bytes)).toThrow();
    });
});

describe('a probe plan', () => {
    it('arms the ECU the same way a replacement does, and says so', async () => {
        await withSimulatedEcu(async () => {
            const plan = planProbe(buildProbeSector('slave', probe.bytes));
            expect(validateBlReplace(plan)).toEqual([]);
            // The point of no return is not softened by the probe being small. Arming is arming.
            expect(plan.pointOfNoReturn).toBeGreaterThanOrEqual(0);
            expect(plan.steps[plan.pointOfNoReturn]?.armsTheEcu).toBe(true);
            expect(plan.steps.some((s) => s.kind === 'power-cycle')).toBe(true);
        });
    });

    it('never names a bootloader address', async () => {
        await withSimulatedEcu(async () => {
            const plan = planProbe(buildProbeSector('master', probe.bytes));
            const base = STAGING_DS2_ADDRESS.master;
            for (const step of plan.steps) {
                if (step.ds2Address === undefined || step.ds2Address === 0) continue;
                expect(step.ds2Address).toBeGreaterThanOrEqual(base);
                expect(step.ds2Address).toBeLessThan(base + STAGED_SECTOR_LENGTH);
            }
        });
    });

    /**
     * The mislabelling this validator exists for.
     *
     * A probe carrying a bootloader image would arm an SA0 rewrite behind a screen that promises
     * the bootloader will not be touched - the operator would consent to a different operation
     * from the one that ran. So the purpose is re-derived from the bytes that would go out, not
     * read off the label.
     */
    it('is rejected if it would carry a bootloader image after all', async () => {
        await withSimulatedEcu(async () => {
            const honest = buildProbeSector('slave', probe.bytes);
            const smuggled = Uint8Array.from(honest.bytes);
            smuggled.set(patchToCsl(practiceSa0('slave'), 'slave').sa0, BOOTLOADER_IMAGE_OFFSET);

            const plan = planBlReplace({ ...honest, bytes: smuggled });
            expect(plan.purpose).toBe('probe');
            expect(validateBlReplace(plan).map((v) => v.message).join('\n'))
                .toMatch(/labelled a probe but its staged sector carries a bootloader image/);
            expect(() => assertBlReplaceable(plan)).toThrow();
        });
    });

    it('is rejected the other way too: a replacement with nothing to install', async () => {
        // This one would program 16 KiB of erased flash over SA0 while its screen said a bootloader
        // was being installed.
        await withSimulatedEcu(async () => {
            const real = buildStagedSector('slave', replace.bytes,
                patchToCsl(practiceSa0('slave'), 'slave').sa0);
            const hollow = Uint8Array.from(real.bytes);
            hollow.fill(0xff, BOOTLOADER_IMAGE_OFFSET, BOOTLOADER_IMAGE_OFFSET + SA0_LENGTH);

            const plan = planBlReplace({ ...real, bytes: hollow });
            expect(validateBlReplace(plan).map((v) => v.message).join('\n'))
                .toMatch(/carries no bootloader image/);
        });
    });

    it('refuses to be built from a replacement sector', async () => {
        await withSimulatedEcu(async () => {
            const real = buildStagedSector('slave', replace.bytes,
                patchToCsl(practiceSa0('slave'), 'slave').sa0);
            expect(() => planProbe(real)).toThrow(/bootloader replacement/);
        });
    });
});

describe('a probe run, against a simulated DME', () => {
    it('clears its own magic and leaves SA0 exactly as it was', async () => {
        const { outcome, image, before } = await runProbe('slave');

        expect(outcome.purpose).toBe('probe');
        expect(outcome.magicCleared).toBe(true);
        expect(outcome.magicAfter).toBe(MAGIC_CLEARED);
        // The same comparison a replacement makes, meaning the opposite thing: SA0 is what it was.
        expect(outcome.matchesIntended).toBe(true);
        expect(outcome.differingOffsets).toEqual([]);

        const sa0AfterInImage = image.subarray(0x80000, 0x80000 + SA0_LENGTH);
        expect(Array.from(sa0AfterInImage)).toEqual(Array.from(before));
    });

    it('does it on the master too', async () => {
        const { outcome } = await runProbe('master');
        expect(outcome.magicCleared).toBe(true);
        expect(outcome.matchesIntended).toBe(true);
    });

    it('reports the connection itself as the first evidence', async () => {
        // The reset handler tests the magic before the K-line comes up, so a DME that answers DS2
        // has already cleared it. Worth saying out loud, because it is what makes the result
        // trustworthy even before the four bytes are read.
        const { events } = await runProbe('slave');
        expect(events.join('\n')).toMatch(/DS2 ANSWERS/);
        expect(events.join('\n')).toMatch(/ARMED/);
    });

    it('verifies the staged sector before the magic completes', async () => {
        const { events } = await runProbe('slave');
        const joined = events.join('\n');
        expect(joined.indexOf('STAGED sector verified')).toBeGreaterThanOrEqual(0);
        expect(joined.indexOf('STAGED sector verified')).toBeLessThan(joined.indexOf('ARMED'));
    });

    /**
     * The simulated ECU must model the probe loader, not "a loader".
     *
     * Copying the bootloader-image region over SA0 unconditionally - which is what the practice
     * ECU used to do - would let a probe program 16 KiB of erased flash over SA0 and report it as
     * a bootloader replacement, on the one screen built to say the bootloader is not touched.
     */
    it('leaves the practice ECU bootable, not holding an erased SA0', async () => {
        const { image } = await runProbe('slave');
        const sa0 = image.subarray(0x80000, 0x80000 + SA0_LENGTH);
        expect(sa0.every((b) => b === 0xff), 'SA0 must not have been erased by the probe').toBe(false);
    });

    it('leaves the loader in the calibration sector, for the program stage to overwrite', async () => {
        const { image } = await runProbe('slave');
        const sector = 0x80000 + 0x8000;
        expect(image[sector]).toBe(probe.bytes[0]);
        // Disarmed: the four bytes the loader programmed over its own magic.
        expect(Array.from(image.subarray(sector + MAGIC_OFFSET, sector + MAGIC_OFFSET + 4)))
            .toEqual([0, 0, 0, 0]);
        expect(STAGED_MAGIC).not.toBe(MAGIC_CLEARED);
    });
});
