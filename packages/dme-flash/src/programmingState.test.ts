import { describe, expect, it, vi } from 'vitest';
import { inspectProgrammingCounter, requireProgrammingCounter } from './programmingState';
import { Ds2Session } from './session';
import { practiceEcuImage, practiceProgrammingTransport } from './practiceEcu';
import { withSimulatedEcu } from './writeLock';
import { runFlash } from './flashExecute';
import { planFlash } from './flashSequence';

const counter = (used: number, marker = 0) => {
    const bytes = new Uint8Array(128).fill(255); bytes.fill(0, 0, used * 2);
    if (used) bytes.set([marker >>> 8, marker & 255], used * 2 - 2);
    return bytes;
};
describe('read-only live programming preflight', () => {
    it('covers every counter position and both programming markers', () => {
        for (let used = 0; used <= 64; used++) for (const marker of [0, 255, 0xff00]) {
            const bytes = counter(used, marker);
            expect(inspectProgrammingCounter(bytes).remaining).toBe(64 - used);
            const kind = marker === 0xff00 ? 'program' : 'calibration';
            if (64 - used < (kind === 'program' ? 8 : used && marker === 255 ? 9 : 10)) expect(() => requireProgrammingCounter(bytes, kind)).toThrow(/capacity/);
            else expect(() => requireProgrammingCounter(bytes, kind)).not.toThrow();
        }
    });
    it.each([0xf500, 0x00f5, 0x1234])('refuses unknown/special marker %i', marker => {
        expect(() => requireProgrammingCounter(counter(4, marker), 'program')).toThrow(/marker/);
    });
    it('rejects holes and uncleared older markers', () => {
        const bytes = counter(4); bytes[2] = 255; bytes[3] = 255;
        expect(() => inspectProgrammingCounter(bytes)).toThrow(/noncanonical/);
        bytes[3] = 0;
        expect(() => inspectProgrammingCounter(bytes)).toThrow(/noncanonical/);
    });
    it.each(['mismatch', 'full', 'mode'])('stops before login/erase on %s', async fault => {
        const image = practiceEcuImage();
        const { transport } = practiceProgrammingTransport(image, { batchMs: 0 });
        const session = new Ds2Session(transport, { delay: async () => {} });
        const read = vi.spyOn(session, 'readWindow');
        const bytes = counter(fault === 'full' ? 60 : 4, fault === 'mode' ? 255 : 0);
        read.mockResolvedValue(bytes);
        if (fault === 'mismatch') read.mockResolvedValueOnce(counter(5));
        const login = vi.spyOn(session, 'login'); const erase = vi.spyOn(session, 'eraseWindow');
        await expect(runFlash(session, planFlash({ image, windowKinds: ['program', 'calibration'] }), image)).rejects.toThrow();
        expect(login).not.toHaveBeenCalled(); expect(erase).not.toHaveBeenCalled();
    });
    it('retains data mode across key OFF/ON and refuses program entry without a mode handoff', async () => {
        const image = practiceEcuImage();
        const { transport, dme } = practiceProgrammingTransport(image, { batchMs: 0 });
        const session = new Ds2Session(transport, { delay: async () => {} });
        await withSimulatedEcu(async () => {
            await session.login(); await session.eraseWindow(0xa02000);
            dme.powerCycle();
            const before = image.slice();
            await expect(session.preflightProgramming('program')).rejects.toThrow(/remains in calibration/);
            expect(image).toEqual(before);
        });
    });
});
