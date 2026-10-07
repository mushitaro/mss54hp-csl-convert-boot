import { describe, expect, it } from 'vitest';
import { runFlash } from './flashExecute';
import { planFlash, validateSequence } from './flashSequence';
import { practiceEcuImage } from './practiceEcu';
import { ds2ToImageOffset } from './imageLayout';
import type { Ds2Session } from './session';

describe('deterministic host interruption campaign', () => {
    it('stops at every programming command boundary without replaying, continuing, or reporting done', async () => {
        const image = practiceEcuImage();
        const plan = planFlash({ image, windowKinds: ['program', 'calibration'] });
        const commands = plan.steps.filter(s => ['login', 'erase', 'write', 'finish'].includes(s.kind));
        // Exhaust every command, rather than representative first/middle/last chunks.
        for (let fault = 0; fault < commands.length; fault++) {
            if (fault % 64 === 0) await new Promise<void>(resolve => setImmediate(resolve));
            let calls = 0;
            let done = false;
            const command = async () => { if (calls++ === fault) throw new Error(`cut ${fault}`); };
            const session = { readWindow: async (a: number, n: number) => image.slice(ds2ToImageOffset(a)!, ds2ToImageOffset(a)! + n), login: command, eraseWindow: command, writeChunk: command,
                preflightProgramming: async () => {}, finishProgramming: command } as unknown as Ds2Session;
            await expect(runFlash(session, plan, image, {
                onProgress: p => { if (p.phase === 'done') done = true; },
            })).rejects.toThrow(`cut ${fault}`);
            expect(calls, `no command after boundary ${fault}`).toBe(fault + 1);
            expect(done).toBe(false);
        }
        console.info(`Interrupted all ${commands.length} full-flash command boundaries`);
    }, 120_000);

    it('rejects removal of every individual write and every erase/Finish before execution', async () => {
        const plan = planFlash({ image: practiceEcuImage(), windowKinds: ['program', 'calibration'] });
        let count = 0;
        for (let i = 0; i < plan.steps.length; i++) {
            if (i % 64 === 0) await new Promise<void>(resolve => setImmediate(resolve));
            if (!['write', 'erase', 'finish'].includes(plan.steps[i]!.kind)) continue;
            const steps = plan.steps.filter((_, index) => index !== i);
            expect(validateSequence({ ...plan, steps }).length, `missing step ${i}`).toBeGreaterThan(0);
            count++;
        }
        console.info(`Rejected all ${count} single-step deletion mutations`);
    }, 120_000);
});
