/**
 * What a stage is called.
 *
 * This exists because of a bug the test suite could not have found and the browser did in about
 * ten seconds: the RUN screen titled the probe stage "CSL program and parameters" while the rail
 * directly above it correctly said PROBE. The operator would have been looking at a FLASH button
 * under the name of a different operation - and it is the one screen where knowing which operation
 * you are about to start is the entire point.
 *
 * The cause was a two-way ternary (`kind === 'bootloader' ? ... : programLabel`) written when there
 * were two kinds of stage and left alone when a third arrived. Correct code that quietly became
 * wrong, in two places, with nothing failing.
 *
 * So the check is not "does the probe have the right title" alone - it is that EVERY kind gets its
 * own name and no two share one. A new kind that forgets to add itself now fails here rather than
 * inheriting the last branch.
 */
import { describe, it, expect } from 'vitest';
import { stageName, type JobStage } from './steps';
import { STEPS, stageSteps, type StageKind } from './wizard';

const KINDS: readonly StageKind[] = ['probe', 'bootloader', 'program'];

function stageOf(kind: StageKind): JobStage {
    return { id: kind, kind, processor: 'slave', done: false };
}

describe('naming a stage', () => {
    it('gives every kind its own name', () => {
        const names = KINDS.map((kind) => stageName(stageOf(kind)));
        expect(new Set(names).size, `two stages share a name: ${names.join(' / ')}`)
            .toBe(KINDS.length);
        for (const name of names) expect(name.length).toBeGreaterThan(0);
    });

    it('does not call the probe by the program stage name', () => {
        // The exact regression. Named on its own so the failure says what it is.
        expect(stageName(stageOf('probe'))).not.toBe(stageName(stageOf('program')));
    });

    it('names each bootloader stage after its processor', () => {
        const slave = stageName({ id: 'a', kind: 'bootloader', processor: 'slave', done: false });
        const master = stageName({ id: 'b', kind: 'bootloader', processor: 'master', done: false });
        expect(slave).not.toBe(master);
        expect(slave.toUpperCase()).toContain('SLAVE');
        expect(master.toUpperCase()).toContain('MASTER');
    });
});

describe('a stage kind is complete the moment it is added', () => {
    it('has a step list, and one made only of real steps', () => {
        // The other half of the same failure mode: a kind that exists but is not in every mapping.
        for (const kind of KINDS) {
            const steps = stageSteps(kind);
            expect(steps.length, kind).toBeGreaterThan(0);
            for (const step of steps) expect(STEPS, `${kind}/${step}`).toContain(step);
            expect(steps[steps.length - 1], `${kind} must end on RUN`).toBe('RUN');
            expect(steps[0], `${kind} must start at PLAN`).toBe('PLAN');
        }
    });
});
