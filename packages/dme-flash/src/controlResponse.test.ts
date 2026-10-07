import { describe, expect, it } from 'vitest';
import { Ds2Session } from './session';
import { withSimulatedEcu } from './writeLock';
import { buildDs2Frame, DME_DS2_ADDRESS } from './ds2';

describe('programming-control reply validation', () => {
    it.each([1, 8, 12, 13, 14, 15, 255])('intermediate Finish allows only success/data-incomplete, verify=%i', async verify => {
        let buffer: number[] = [];
        const session = new Ds2Session({ simulated: true,
            write: async frame => { buffer = [...frame, ...buildDs2Frame(DME_DS2_ADDRESS,
                Uint8Array.from([0xa0, 15, 0, 0, 0, 0, verify]))]; },
            read: async count => Uint8Array.from(buffer.splice(0, count)),
        });
        const result = await withSimulatedEcu(() => session.finishProgramming(true)).catch(e => e);
        if (verify === 1 || verify === 15) expect(result).toBeUndefined();
        else expect(result).toBeInstanceOf(Error);
    });
    for (const segment of [6, 15]) {
        it.each([undefined, 1, 8, 2, 3, 6, 7, 12, 13, 14, 15, 255])(
            `segment ${segment}, outer ACK and verify=%s`, async verify => {
                let buffer: number[] = [];
                let sent = 0;
                const session = new Ds2Session({simulated: true,
                    write: async frame => {
                        sent++;
                        const payload = verify === undefined ? [0xa0] : [0xa0, segment,
                            segment === 6 ? 0xa0 : 0, segment === 6 ? 0x20 : 0, 0, 0, verify];
                        buffer = [...frame, ...buildDs2Frame(DME_DS2_ADDRESS, Uint8Array.from(payload))];
                    },
                    read: async count => Uint8Array.from(buffer.splice(0, count)),
                });
                const result = await withSimulatedEcu(() => segment === 6
                    ? session.eraseWindow(0xa02000) : session.finishProgramming()).catch(error => error);
                if (verify === undefined || verify === 1) expect(result).toBeUndefined();
                else expect(result).toBeInstanceOf(Error);
                expect(sent).toBe(1);
            });
    }
    it.each([{payload: [0xa0, 15]}, {payload: [0xa0, 6, 0, 0, 0, 0, 1]},
        {payload: [0xa0, 15, 0xa0, 0, 0, 0, 1]}, {payload: [0xa0, 15, 0, 0, 0, 1, 1]}])('rejects malformed/wrong-segment Finish $payload', async ({payload}) => {
        let buffer: number[] = [];
        const session = new Ds2Session({simulated: true,
            write: async frame => { buffer = [...frame, ...buildDs2Frame(DME_DS2_ADDRESS, Uint8Array.from(payload))]; },
            read: async count => Uint8Array.from(buffer.splice(0, count)),
        });
        await expect(withSimulatedEcu(() => session.finishProgramming())).rejects.toThrow(/programming-control/);
    });
});
