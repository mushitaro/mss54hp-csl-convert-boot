import { describe, it, expect } from 'vitest';
import {
    SETUP_STEPS, BOOTLOADER_STAGE_STEPS, PROGRAM_STAGE_STEPS, STEPS,
    isSetupStep, stageSteps, walkOrder, type StageKind, type StepId,
} from './wizard';

const KINDS: (StageKind | undefined)[] = ['probe', 'bootloader', 'program', undefined];

describe('the wizard walking order', () => {
    it('never lists a step twice', () => {
        for (const kind of KINDS) {
            const order = walkOrder(kind);
            expect(new Set(order).size, String(kind)).toBe(order.length);
        }
    });

    it('leaves the setup for the stage, not for the start', () => {
        // The regression: NEXT off the end of the setup went back to LINK, so a finished backup
        // returned the operator to the connection screen.
        for (const kind of KINDS) {
            const order = walkOrder(kind);
            const last = order.indexOf(SETUP_STEPS[SETUP_STEPS.length - 1]!);
            expect(order[last + 1], String(kind)).toBe('PLAN');
        }
    });

    it('starts at LINK and ends at RUN', () => {
        for (const kind of KINDS) {
            const order = walkOrder(kind);
            expect(order[0]).toBe('LINK');
            expect(order[order.length - 1]).toBe('RUN');
        }
    });

    it('walks forward and back over the same steps', () => {
        for (const kind of KINDS) {
            const order = walkOrder(kind);
            for (let i = 0; i < order.length - 1; i++) {
                const forward = order[i + 1]!;
                expect(order[order.indexOf(forward) - 1], `${kind} ${order[i]}`).toBe(order[i]);
            }
        }
    });

    it('only asks about hardware and speed where they exist', () => {
        // A bootloader has no calibration to patch and no bulk read to speed up. Both steps were
        // offered on every stage once, which is how the rail said seven and then said four.
        expect(BOOTLOADER_STAGE_STEPS).not.toContain('PATCH');
        expect(BOOTLOADER_STAGE_STEPS).not.toContain('SPEED');
        expect(PROGRAM_STAGE_STEPS).toContain('PATCH');
        expect(PROGRAM_STAGE_STEPS).toContain('SPEED');
    });

    it('covers every declared step across the two stage shapes', () => {
        const reachable = new Set<StepId>([...walkOrder('bootloader'), ...walkOrder('program')]);
        for (const step of STEPS) expect(reachable.has(step), step).toBe(true);
    });

    it('agrees with itself about what the setup is', () => {
        for (const step of STEPS) {
            expect(isSetupStep(step), step).toBe((SETUP_STEPS as readonly string[]).includes(step));
        }
        expect(stageSteps('program')).toBe(PROGRAM_STAGE_STEPS);
        expect(stageSteps('bootloader')).toBe(BOOTLOADER_STAGE_STEPS);
    });
});
