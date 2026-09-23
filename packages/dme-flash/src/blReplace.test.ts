/**
 * The replacement sequence, and the adversarial cases its validator exists to catch.
 *
 * Every negative test here is a mistake that would have cost an ECU: a telegram aimed at the
 * bootloader, a plan that arms before it verifies, an incomplete staging. The validator is the
 * only thing standing between a plausible-looking plan and a DME that needs BDM.
 */
import { describe, it, expect, vi } from 'vitest';
import { WRITE_CHUNK_MAX } from './regionMap';
import { SA0_LENGTH, correctBootloaderCrc } from './bootloaderImage';
import { STAGED_SECTOR_LENGTH, STAGING_DS2_ADDRESS } from './blLoader';
import type { Processor } from './imageLayout';

vi.mock('./writeLock', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./writeLock')>();
    return { ...actual, assertWriteUnlocked: () => { /* unlocked for planning tests only */ } };
});

const { buildStagedSector } = await import('./blLoader');
const {
    planBlReplace, validateBlReplace, assertBlReplaceable, describeBlPlan, planArmsTheEcu,
} = await import('./blReplace');

type BlPlan = Awaited<ReturnType<typeof planBlReplace>>;

function sectorFor(processor: Processor) {
    const image = new Uint8Array(SA0_LENGTH).fill(0xa5);
    correctBootloaderCrc(image, processor);
    const loader = new Uint8Array(64).fill(0x4e);
    loader[0] = 0x60;
    return buildStagedSector(processor, loader, image);
}

/** Structural clone of a plan, so a test can corrupt one step without touching the original. */
function mutate(plan: BlPlan, index: number, patch: Record<string, unknown>): BlPlan {
    const steps = plan.steps.map((s, i) => (i === index ? { ...s, ...patch } : s));
    return { ...plan, steps };
}

describe('the plan', () => {
    it('validates cleanly for both processors', () => {
        for (const processor of ['master', 'slave'] as const) {
            const plan = planBlReplace(sectorFor(processor));
            expect(validateBlReplace(plan)).toEqual([]);
            expect(() => assertBlReplaceable(plan)).not.toThrow();
        }
    });

    it('starts with a login and a two-pass backup before anything is erased', () => {
        const plan = planBlReplace(sectorFor('master'));
        const kinds = plan.steps.map((s) => s.kind);
        expect(kinds[0]).toBe('login');
        expect(kinds[1]).toBe('read-before');
        expect(kinds.indexOf('read-before')).toBeLessThan(kinds.indexOf('erase-calibration'));
    });

    it('verifies the staged sector before the magic completes', () => {
        const plan = planBlReplace(sectorFor('master'));
        const kinds = plan.steps.map((s) => s.kind);
        const verify = kinds.indexOf('verify-staged');
        const armingWrite = plan.steps.findIndex((s) => s.kind === 'write-staged' && s.armsTheEcu);
        expect(verify).toBeGreaterThan(0);
        expect(verify).toBeLessThan(armingWrite);
    });

    it('marks the point of no return at the arming write, not at the erase', () => {
        const plan = planBlReplace(sectorFor('master'));
        const pointOfNoReturn = plan.steps[plan.pointOfNoReturn];
        expect(pointOfNoReturn?.armsTheEcu).toBe(true);
        // Everything before it must still be recoverable over OBD alone.
        for (const step of plan.steps.slice(0, plan.pointOfNoReturn)) expect(step.reversible).toBe(true);
        // And nothing after it is.
        for (const step of plan.steps.slice(plan.pointOfNoReturn)) expect(step.reversible).toBe(false);
    });

    it('covers the whole staged sector, contiguously, in write-cap chunks', () => {
        const plan = planBlReplace(sectorFor('slave'));
        const writes = plan.steps.filter((s) => s.kind === 'write-staged');
        expect(writes.reduce((n, s) => n + (s.data?.length ?? 0), 0)).toBe(STAGED_SECTOR_LENGTH);
        let expected = STAGING_DS2_ADDRESS.slave;
        for (const w of writes) {
            expect(w.ds2Address).toBe(expected);
            expected += w.data?.length ?? 0;
        }
    });

    it('ends by restoring a real calibration, because the staged sector is not one', () => {
        const plan = planBlReplace(sectorFor('master'));
        expect(plan.steps[plan.steps.length - 1]?.kind).toBe('restore-calibration');
    });

    it('refuses a sector staged at the wrong address', () => {
        const sector = { ...sectorFor('master'), ds2Address: 0x500000 };
        expect(() => planBlReplace(sector)).toThrow(/must target 0x200000/);
    });

    it('describes itself with the point of no return named', () => {
        const text = describeBlPlan(planBlReplace(sectorFor('master')));
        expect(text).toMatch(/point of no return/);
        expect(text).toMatch(/validation: PASS/);
    });

    it('reports that the staged sector would arm the ECU', () => {
        expect(planArmsTheEcu(sectorFor('master'))).toBe(true);
    });
});

describe('the validator catches plans that would cost an ECU', () => {
    const base = (): BlPlan => planBlReplace(sectorFor('master'));

    it('a write aimed at the bootloader window', () => {
        const plan = base();
        const idx = plan.steps.findIndex((s) => s.kind === 'write-staged');
        const broken = mutate(plan, idx, { ds2Address: 0x100000 });
        const messages = validateBlReplace(broken).map((v) => v.message).join('\n');
        expect(messages).toMatch(/bootloader/);
        expect(() => assertBlReplaceable(broken)).toThrow(/not safe to execute/);
    });

    it('an erase aimed anywhere but the calibration window', () => {
        const plan = base();
        const idx = plan.steps.findIndex((s) => s.kind === 'erase-calibration');
        const messages = validateBlReplace(mutate(plan, idx, { ds2Address: 0x500000 }))
            .map((v) => v.message).join('\n');
        expect(messages).toMatch(/not the calibration window/);
    });

    it('a plan that arms without verifying first', () => {
        const plan = base();
        const idx = plan.steps.findIndex((s) => s.kind === 'verify-staged');
        const withoutVerify: BlPlan = { ...plan, steps: plan.steps.filter((_, i) => i !== idx) };
        const messages = validateBlReplace(withoutVerify).map((v) => v.message).join('\n');
        expect(messages).toMatch(/must be verified before the magic completes/);
    });

    it('a staging that does not cover the whole sector', () => {
        const plan = base();
        const idx = plan.steps.findIndex((s) => s.kind === 'write-staged');
        const short: BlPlan = { ...plan, steps: plan.steps.filter((_, i) => i !== idx) };
        const messages = validateBlReplace(short).map((v) => v.message).join('\n');
        expect(messages).toMatch(/staged writes cover/);
    });

    it('a non-contiguous write', () => {
        const plan = base();
        const writes = plan.steps.map((s, i) => ({ s, i })).filter((x) => x.s.kind === 'write-staged');
        const second = writes[1];
        expect(second).toBeDefined();
        const messages = validateBlReplace(mutate(plan, second!.i, { ds2Address: STAGING_DS2_ADDRESS.master + 0x1000 }))
            .map((v) => v.message).join('\n');
        expect(messages).toMatch(/not contiguous/);
    });

    it('an over-length or odd-length write chunk', () => {
        const plan = base();
        const idx = plan.steps.findIndex((s) => s.kind === 'write-staged');
        expect(validateBlReplace(mutate(plan, idx, { data: new Uint8Array(WRITE_CHUNK_MAX + 2) }))
            .map((v) => v.message).join('\n')).toMatch(/outside 1\.\./);
        expect(validateBlReplace(mutate(plan, idx, { data: new Uint8Array(121) }))
            .map((v) => v.message).join('\n')).toMatch(/must be even/);
    });

    it('a write that runs off the end of the staged sector', () => {
        const plan = base();
        const idx = plan.steps.findIndex((s) => s.kind === 'write-staged');
        const messages = validateBlReplace(mutate(plan, idx, { ds2Address: STAGING_DS2_ADDRESS.master + 0x7ffe }))
            .map((v) => v.message).join('\n');
        expect(messages).toMatch(/outside the staged sector/);
    });
});
