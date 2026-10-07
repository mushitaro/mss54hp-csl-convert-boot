import { describe, it, expect, vi } from 'vitest';
import { runFlash } from './flashExecute';
import { planFlash } from './flashSequence';
import { Ds2Session } from './session';
import { practiceEcuImage, practiceProgrammingTransport } from './practiceEcu';
import { withSimulatedEcu } from './writeLock';

describe('program-to-calibration handoff', () => {
    it.each([0, 1, 2, 3])('stops before calibration erase if intermediate program read %i differs', async failedRead => {
        const source = practiceEcuImage(); const live = source.slice();
        const { transport } = practiceProgrammingTransport(live, { batchMs: 0 });
        const session = new Ds2Session(transport, { delay: async () => {} });
        const original = session.readWindow.bind(session);
        let programReads = 0;
        vi.spyOn(session, 'readWindow').mockImplementation(async (address, length) => {
            const result = await original(address, length);
            if (address === 0x500000 || address === 0xd00000) {
                if (programReads++ === failedRead) result[0] = result[0]! ^ 1;
            }
            return result;
        });
        const erase = vi.spyOn(session, 'eraseWindow');
        const finish = vi.spyOn(session, 'finishProgramming');
        await expect(withSimulatedEcu(() => runFlash(session,
            planFlash({ image: source, windowKinds: ['program', 'calibration'] }), source)))
            .rejects.toThrow(/intermediate program read-back/);
        expect(finish.mock.calls).toEqual([[true]]);
        expect(erase.mock.calls).toEqual([[0xd00000]]);
        expect(live.slice(0x8000, 0x10000)).toEqual(source.slice(0x8000, 0x10000));
    });
});
