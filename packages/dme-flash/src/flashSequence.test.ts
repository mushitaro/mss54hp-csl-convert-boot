/**
 * The write plan and its validator.
 *
 * The validator is the last line before an erase, so the tests that matter most are the ones that
 * deliberately build a *bad* plan and confirm it is caught. An unexercised guard is decoration; a
 * guard on the erase path that is only assumed to work is a brick waiting for one bad input.
 */
import { describe, it, expect } from 'vitest';
import {
    planFlash, validateSequence, assertFlashable, describePlan,
    type FlashPlan, type FlashStep,
} from './flashSequence';
import { WRITE_CHUNK_MAX, Segment } from './regionMap';
import { IMAGE_WINDOWS, FULL_IMAGE_LENGTH } from './imageLayout';

function fullImage(): Uint8Array {
    // Content is irrelevant to plan structure; use a recognisable fill.
    return new Uint8Array(FULL_IMAGE_LENGTH).fill(0xa5);
}

describe('a full conversion plan', () => {
    const plan = planFlash({ image: fullImage(), windowKinds: ['program', 'calibration'] });

    it('erases each of the four windows exactly once, before writing it', () => {
        expect(plan.eraseCount).toBe(4);
        // Every write is preceded (somewhere earlier) by an erase of its window.
        const erasedBefore = new Set<number>();
        for (const step of plan.steps) {
            if (step.kind === 'erase') erasedBefore.add(step.ds2Address!);
            if (step.kind === 'write') {
                const w = IMAGE_WINDOWS.find((x) => step.ds2Address! >= x.ds2Address && step.ds2Address! < x.ds2Address + x.length)!;
                expect(erasedBefore.has(w.ds2Address)).toBe(true);
            }
        }
    });

    it('writes exactly 576 KiB and passes validation', () => {
        expect(plan.writeBytes).toBe(0x90000);
        expect(validateSequence(plan)).toEqual([]);
        expect(() => assertFlashable(plan)).not.toThrow();
    });

    it('begins with login and ends with checksum-verify then reset', () => {
        expect(plan.steps[0]!.kind).toBe('login');
        expect(plan.steps.at(-2)!.kind).toBe('verify-checksum');
        expect(plan.steps.at(-1)!.kind).toBe('reset');
    });

    it('every write telegram is even-length and within the cap', () => {
        for (const s of plan.steps) {
            if (s.kind !== 'write') continue;
            const len = s.data!.length;
            expect(len % 2).toBe(0);
            expect(len).toBeGreaterThan(0);
            expect(len).toBeLessThanOrEqual(WRITE_CHUNK_MAX);
        }
    });

    it('uses the erase segment for erases and the write segment for writes', () => {
        for (const s of plan.steps) {
            if (s.kind === 'erase') expect(s.segment).toBe(Segment.Erase);
            if (s.kind === 'write') expect(s.segment).toBe(Segment.Write);
        }
    });
});

describe('a calibration-only reflash never touches a program window', () => {
    const plan = planFlash({ image: fullImage(), windowKinds: ['calibration'] });
    it('erases only the two calibration windows', () => {
        expect(plan.eraseCount).toBe(2);
        expect(plan.writeBytes).toBe(0x10000);
        for (const s of plan.steps) {
            if (s.kind !== 'erase' && s.kind !== 'write') continue;
            const w = IMAGE_WINDOWS.find((x) => s.ds2Address! >= x.ds2Address && s.ds2Address! < x.ds2Address + x.length)!;
            expect(w.kind).toBe('calibration');
        }
        expect(validateSequence(plan)).toEqual([]);
    });
});

describe('the validator catches every unsafe plan it is meant to', () => {
    const base = planFlash({ image: fullImage(), windowKinds: ['calibration'] });

    function mutate(fn: (steps: FlashStep[]) => void): FlashPlan {
        const steps = base.steps.map((s) => ({ ...s }));
        fn(steps);
        return { ...base, steps };
    }

    it('rejects a write that precedes its erase', () => {
        const plan = mutate((steps) => {
            // Drop the first erase entirely.
            const idx = steps.findIndex((s) => s.kind === 'erase');
            steps.splice(idx, 1);
        });
        const v = validateSequence(plan);
        expect(v.some((x) => /before its erase/.test(x.reason))).toBe(true);
        expect(() => assertFlashable(plan)).toThrow(/failed validation/);
    });

    it('rejects an over-length write chunk', () => {
        const plan = mutate((steps) => {
            const w = steps.find((s) => s.kind === 'write')!;
            (w as { data: Uint8Array }).data = new Uint8Array(WRITE_CHUNK_MAX + 2);
        });
        expect(validateSequence(plan).some((x) => /chunk rule/.test(x.reason))).toBe(true);
    });

    it('rejects an odd-length write chunk', () => {
        const plan = mutate((steps) => {
            const w = steps.find((s) => s.kind === 'write')!;
            (w as { data: Uint8Array }).data = new Uint8Array(121);
        });
        expect(validateSequence(plan).some((x) => /chunk rule/.test(x.reason))).toBe(true);
    });

    it('rejects an erase aimed at a protected sector', () => {
        const plan = mutate((steps) => {
            const e = steps.find((s) => s.kind === 'erase')!;
            // 0x000000 = master bootloader window nibble 0, which is not a conversion window.
            (e as { ds2Address: number }).ds2Address = 0x000000;
        });
        // It is in no known window, which is itself a violation, and it must never validate.
        expect(validateSequence(plan).length).toBeGreaterThan(0);
        expect(() => assertFlashable(plan)).toThrow();
    });

    it('rejects a write whose address the firmware would refuse', () => {
        const plan = mutate((steps) => {
            const w = steps.find((s) => s.kind === 'write')!;
            // Nibble 0x7 is absent from the region table - firmware answers 0xB0.
            (w as { ds2Address: number }).ds2Address = 0x700000;
        });
        expect(validateSequence(plan).some((x) => /in no known window|refused/.test(x.reason))).toBe(true);
    });

    it('rejects a non-contiguous write within a window', () => {
        const plan = mutate((steps) => {
            const writes = steps.filter((s) => s.kind === 'write');
            // Shift the second write forward by 2 bytes, opening a hole.
            (writes[1] as { ds2Address: number }).ds2Address += 2;
        });
        expect(validateSequence(plan).some((x) => /non-contiguous|only .* bytes covered/.test(x.reason))).toBe(true);
    });

    it('rejects a window left partially covered', () => {
        const plan = mutate((steps) => {
            // Remove the last write of the plan.
            const lastWrite = [...steps].reverse().find((s) => s.kind === 'write')!;
            steps.splice(steps.indexOf(lastWrite), 1);
        });
        expect(validateSequence(plan).some((x) => /bytes covered/.test(x.reason))).toBe(true);
    });
});

describe('describePlan', () => {
    it('summarises windows and reports PASS for a good plan', () => {
        const text = describePlan(planFlash({ image: fullImage(), windowKinds: ['program', 'calibration'] }));
        expect(text).toMatch(/4 erase/);
        expect(text).toMatch(/validation: PASS/);
    });
});
