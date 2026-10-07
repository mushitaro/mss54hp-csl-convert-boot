import { describe, expect, it, vi } from 'vitest';
import { buildStagedSector, MAGIC_OFFSET, STAGED_SECTOR_LENGTH } from './blLoader';
import { planBlReplace, validateBlReplace, type BlPlan } from './blReplace';
import { runBlReplace } from './blExecute';
import { planFlash, validateSequence } from './flashSequence';
import { runFlash } from './flashExecute';
import { practiceEcuImage, practiceSa0, practiceProgrammingTransport } from './practiceEcu';
import { patchToCsl } from './bootloaderImage';
import { correctBootloaderCrc } from './bootloaderImage';
import { Ds2Session } from './session';
import { Ds2Link } from './transport';
import { withSimulatedEcu } from './writeLock';
import { readProgram, readVariant, buildConversionImage, type SpDatenVariant } from './spDaten';
import { IMAGE_WINDOWS } from './imageLayout';
import { calibrationPairFrom, correctChecksums } from './calibrationImage';
import { parseAustauschDatei } from './paband';
import { buildVariant } from './variant';
import { assembleProgramImage, type ProgramSource } from './programVariant';

async function bootPlan(): Promise<BlPlan> {
    return withSimulatedEcu(async () => planBlReplace(buildStagedSector(
        'slave', new Uint8Array([0x60, 0xfe]), patchToCsl(practiceSa0('slave'), 'slave').sa0)));
}

describe('boot plan safety at the execution boundary', () => {
    it('refuses a different live bootloader even when its own CRC is valid', async () => {
        const plan = await bootPlan();
        const sa0 = practiceSa0('slave');
        sa0[0x250]! ^= 1; // reset-handler code outside the known M3/CSL differences
        correctBootloaderCrc(sa0, 'slave');
        const eraseWindow = vi.fn();
        const session = { login: async () => {}, readBootloader: async () => ({ sa0 }), eraseWindow } as unknown as Ds2Session;
        await expect(runBlReplace(session, plan, patchToCsl(practiceSa0('slave'), 'slave').sa0,
            { onPowerCycle: async () => {} })).rejects.toThrow(/live bootloader/);
        expect(eraseWindow).not.toHaveBeenCalled();
    });

    it('reports possibly armed state when the final write ACK is lost', async () => {
        const plan = await bootPlan();
        const staged = new Uint8Array(STAGED_SECTOR_LENGTH).fill(0xff);
        const progress: boolean[] = [];
        const session = {
            preflightProgramming: async () => {}, finishProgramming: async () => {}, login: async () => {}, eraseWindow: async () => {},
            readBootloader: async () => ({ sa0: practiceSa0('slave') }),
            writeChunk: async (address: number, bytes: Uint8Array) => {
                staged.set(bytes, address - plan.ds2Address);
                if (address === plan.steps[plan.pointOfNoReturn]!.ds2Address) throw new Error('lost ACK');
            },
            readWindow: async () => staged.slice(),
        } as unknown as Ds2Session;
        await expect(runBlReplace(session, plan, patchToCsl(practiceSa0('slave'), 'slave').sa0,
            { onPowerCycle: async () => {}, onProgress: p => progress.push(p.armed) })).rejects.toThrow('lost ACK');
        expect(progress.at(-1)).toBe(true);
    });

    it('rejects verification before staging has finished', async () => {
        const plan = await bootPlan();
        const steps = [...plan.steps];
        const [verify] = steps.splice(steps.findIndex(s => s.kind === 'verify-staged'), 1);
        steps.splice(3, 0, verify!);
        expect(validateBlReplace({ ...plan, steps })).not.toEqual([]);
    });

    it.each(['erase-calibration', 'power-cycle', 'read-after'] as const)(
        'rejects a missing %s step', async kind => {
            const plan = await bootPlan();
            expect(validateBlReplace({ ...plan, steps: plan.steps.filter(s => s.kind !== kind) }))
                .not.toEqual([]);
        });

    it('rejects a forged staging base and point of no return', async () => {
        const plan = await bootPlan();
        expect(validateBlReplace({ ...plan, ds2Address: 0x200000 })).not.toEqual([]);
        expect(validateBlReplace({ ...plan, pointOfNoReturn: 0 })).not.toEqual([]);
    });

    it('rejects damaged bootloader bytes even if they are not all erased', async () => {
        const plan = await bootPlan();
        const steps = plan.steps.map(s => ({ ...s, data: s.data?.slice() }));
        const step = steps.find(s => s.data && s.ds2Address! <= plan.ds2Address + 0x1000
            && s.ds2Address! + s.data.length > plan.ds2Address + 0x1000)!;
        step.data![plan.ds2Address + 0x1000 - step.ds2Address!]! ^= 1;
        expect(validateBlReplace({ ...plan, steps })).not.toEqual([]);
    });

    it('refuses a different intended SA0 before even logging in', async () => {
        const plan = await bootPlan();
        const session = { login: vi.fn() } as unknown as Ds2Session;
        await expect(runBlReplace(session, plan, practiceSa0('slave'), {
            onPowerCycle: async () => {},
        })).rejects.toThrow(/intended|staged/i);
        expect(session.login).not.toHaveBeenCalled();
    });

    it('checks erased bytes in the pending arming chunk before writing magic', async () => {
        const plan = await bootPlan();
        const staged = new Uint8Array(STAGED_SECTOR_LENGTH).fill(0xff);
        const writeChunk = vi.fn(async (address: number, data: Uint8Array) => {
            staged.set(data, address - plan.ds2Address);
        });
        const session = {
            preflightProgramming: async () => {}, finishProgramming: async () => {}, login: async () => {}, eraseWindow: async () => {}, writeChunk,
            readBootloader: async () => ({ sa0: practiceSa0('slave') }),
            readWindow: async () => {
                const back = staged.slice();
                back[MAGIC_OFFSET] = 0; // failed erase in bytes the old verifier skipped
                return back;
            },
        } as unknown as Ds2Session;
        const cycle = vi.fn(async () => {});
        await expect(runBlReplace(session, plan, patchToCsl(practiceSa0('slave'), 'slave').sa0,
            { onPowerCycle: cycle })).rejects.toThrow(/read back|staged/i);
        expect(cycle).not.toHaveBeenCalled();
        expect(writeChunk.mock.calls.some(([address]) => address === plan.steps[plan.pointOfNoReturn]!.ds2Address))
            .toBe(false);
    });
});

describe('ordinary flash safety', () => {
    it('preserves both calibration halves even when each erase also erases its peer', async () => {
        const image = practiceEcuImage();
        const intended = image.slice();
        const { transport, dme } = practiceProgrammingTransport(image, { batchMs: 0 });
        const original = dme.respond.bind(dme);
        vi.spyOn(dme, 'respond').mockImplementation(request => {
            if (request[0] === 0x07 && request[1] === 0x06) {
                image.fill(0xff, 0x8000, 0x10000);
                image.fill(0xff, 0x88000, 0x90000);
            }
            return original(request);
        });
        const session = new Ds2Session(transport, { delay: async () => {} });
        await withSimulatedEcu(async () => runFlash(session,
            planFlash({ image: intended, windowKinds: ['calibration'] }), intended));
        for (const base of [0x8000, 0x88000]) {
            expect(image.slice(base, base + 0x8000)).toEqual(intended.slice(base, base + 0x8000));
        }
    });

    it('does not report verification success when the ECU reports an integrity fault', async () => {
        const image = practiceEcuImage();
        const session = {
            preflightProgramming: async () => {}, finishProgramming: async () => {}, login: async () => {}, eraseWindow: async () => {}, writeChunk: async () => {},
            fullBackup: async () => ({ image, verified: true, differingOffsets: [] }),
            encodingChecksum: async () => ({ anyFaulted: true }),
        } as unknown as Ds2Session;
        const outcome = await runFlash(session, planFlash({ image, windowKinds: ['calibration'] }),
            image, { verifyReadBack: true });
        expect(outcome.differingOffsets).toEqual([]);
        expect(outcome.verified).toBe(false);
        expect(outcome.encodingFaulted).toBe(true);
    });

    it('refuses a truncated source while planning', () => {
        expect(() => planFlash({ image: new Uint8Array(1), windowKinds: ['calibration'] })).toThrow();
    });

    it('does not trust a caller-supplied shorter window', () => {
        const plan = planFlash({ image: practiceEcuImage(), windowKinds: ['calibration'] });
        expect(validateSequence({ ...plan, windows: [] })).not.toEqual([]);
        expect(validateSequence({ ...plan, steps: [] })).not.toEqual([]);
    });

    it('refuses plan/image disagreement before login or erase', async () => {
        const image = practiceEcuImage();
        const plan = planFlash({ image, windowKinds: ['calibration'] });
        const different = image.slice();
        different[0x8000]! ^= 1;
        const login = vi.fn();
        await expect(runFlash({ login } as unknown as Ds2Session, plan, different))
            .rejects.toThrow(/image|source/i);
        expect(login).not.toHaveBeenCalled();
    });

    it('never arms a loader through an ordinary calibration write', () => {
        const image = practiceEcuImage();
        image.set([0x5a, 0xa5, 0x56, 0xc9], 0x8000 + MAGIC_OFFSET);
        expect(() => planFlash({ image, windowKinds: ['calibration'] })).toThrow(/magic|loader/i);
    });

    it('does not let hooks change the bytes after validation', async () => {
        const image = practiceEcuImage();
        const plan = planFlash({ image, windowKinds: ['calibration'] });
        const first = plan.steps.find(s => s.kind === 'write')!;
        const expected = first.data!.slice();
        const writes: Uint8Array[] = [];
        const session = {
            login: async () => { first.data!.fill(0); image.fill(0); },
            eraseWindow: async () => {}, writeChunk: async (_: number, b: Uint8Array) => { writes.push(b.slice()); },
            preflightProgramming: async () => {}, finishProgramming: async () => {},
            encodingChecksum: async () => ({ anyFaulted: false }),
        } as unknown as Ds2Session;
        await runFlash(session, plan, image);
        expect(writes[0]).toEqual(expected);
    });
});

describe('conversion input integrity', () => {
    const variant = (): SpDatenVariant => {
        const pair = new Uint8Array(0x10000).fill(0xff);
        correctChecksums(pair);
        return { file: 'test.0DA', reference: '211325000401PD31', name: '', stand: '', zb: '',
            pair, checksumValid: true };
    };
    const program = (): ProgramSource => ({
        file: 'test.0PA', reference: '211325000401', sections: IMAGE_WINDOWS
            .filter(w => w.kind === 'program')
            .map(w => ({ address: w.ds2Address, bytes: new Uint8Array(w.length).fill(0xff) })),
    });

    it.each([undefined, 'FFFF'])('refuses absent/incorrect file checksum %s', checksum => {
        const content = '$REFERENZ 211325000401PD31\n:020000000000FE\n'
            + (checksum ? `$CHECKSUMME ${checksum}\n` : '');
        expect(() => readProgram('bad.0PA', content)).toThrow(/checksum/);
        expect(() => readVariant('bad.0DA', content)).toThrow(/checksum/);
    });

    it('rejects incomplete, duplicate and misaddressed program sections', () => {
        const p = program();
        expect(() => assembleProgramImage({ ...p, sections: p.sections.slice(0, 1) })).toThrow(/incomplete|checksum/);
        expect(() => assembleProgramImage({ ...p, sections: [...p.sections, p.sections[0]!] })).toThrow(/overlap/);
        expect(() => assembleProgramImage({ ...p, sections: [{ ...p.sections[0]!, address: 0x200000 }] }))
            .toThrow(/program window/);
    });

    it('rejects content with the right size and reference but an unknown program checksum', () => {
        expect(() => buildConversionImage(program(), variant())).toThrow(/checksum/);
    });

    it('rejects truncated or corrupted calibration before generating an image', () => {
        const v = variant();
        expect(() => buildConversionImage(program(), { ...v, pair: v.pair.slice(0, -1) })).toThrow(/calibration/);
        v.pair[10]! ^= 1;
        expect(() => buildConversionImage(program(), v)).toThrow(/calibration/);
        expect(() => buildVariant(v.pair, { map: 'use', flap: 'present', cams: 'csl' })).toThrow(/checksum/);
    });

    it('does not permit a slave calibration section to spill into the master half', () => {
        const file = parseAustauschDatei('');
        expect(() => calibrationPairFrom({ ...file, sections: [
            { address: 0xa00000, bytes: new Uint8Array(0x10000) },
        ] })).toThrow(/past/);
    });

    it('rejects calibration sections that overwrite earlier data', () => {
        const file = parseAustauschDatei('');
        expect(() => calibrationPairFrom({ ...file, sections: [
            { address: 0xa00000, bytes: new Uint8Array(0x8000) },
            { address: 0x200000, bytes: new Uint8Array(0x8000) },
            { address: 0xa00000, bytes: new Uint8Array(2) },
        ] })).toThrow(/overlap/);
    });
});

describe('hardware gate checks the operation as well as its address', () => {
    it('never retries an erase through either retry API', async () => {
        const write = vi.fn(async () => {});
        const link = new Ds2Link({ simulated: true, write, read: async () => new Uint8Array() });
        const erase = new Uint8Array([0x07, 0x06, 0x20, 0, 0, 0]);
        await expect(link.transceiveIdempotent(erase)).rejects.toThrow(/retry/);
        await expect(link.transceiveWrite(erase)).rejects.toThrow(/WRITE/);
        expect(write).not.toHaveBeenCalled();
    });

    it('does not resynchronise the reader belonging to an active exchange', async () => {
        let release!: () => void;
        const wait = new Promise<void>(resolve => { release = resolve; });
        const delay = vi.fn(async () => {});
        const drain = vi.fn(async () => {});
        const link = new Ds2Link({ write: async () => wait, read: async () => new Uint8Array(), drain }, { delay });
        const active = link.transceive(new Uint8Array([0])).catch(() => {});
        await expect(link.transceiveIdempotent(new Uint8Array([0])))
            .rejects.toMatchObject({ kind: 'concurrent-exchange' });
        expect(delay).not.toHaveBeenCalled();
        expect(drain).not.toHaveBeenCalled();
        release();
        await active;
    });

    it('does not give a traffic callback access to the outgoing frame', async () => {
        const { transport } = practiceProgrammingTransport(practiceEcuImage(), { batchMs: 0 });
        const write = vi.spyOn(transport, 'write');
        const link = new Ds2Link(transport, { onTraffic: (_, bytes) => { bytes.fill(0); } });
        const response = await link.transceive(new Uint8Array([0]));
        expect(response.ok).toBe(true);
        expect(write.mock.calls[0]![0][0]).toBe(0x12);
    });

    it.each([
        [0x07, 0x02, 0x42, 0x41, 0x51, 0, 0], // recycling key used as write address
        [0x07, 0x02, 0, 0x1f, 0xfe, 0, 0, 0, 0], // crosses service block end
        [0x07, 0x55, 0, 0, 0, 0], // unknown segment
        [0x07, 0x02, 0, 0, 1, 0, 0], // odd address
    ])('refuses malformed or misclassified programming payload %j', async (...bytes) => {
        const write = vi.fn(async () => {});
        const link = new Ds2Link({ write, read: async () => new Uint8Array() });
        await expect(link.transceive(Uint8Array.from(bytes))).rejects.toThrow();
        expect(write).not.toHaveBeenCalled();
    });
});

describe('FAST ENTRY preservation', () => {
    it('refuses a counter-clear marker before writing or erasing either processor', async () => {
        const image = practiceEcuImage();
        image.set([0x4b, 0x31, 0x36, 0x2e], 0x84900);
        const { transport, dme } = practiceProgrammingTransport(image, { batchMs: 0 });
        const respond = vi.spyOn(dme, 'respond');
        const session = new Ds2Session(transport, { delay: async () => {} });
        await withSimulatedEcu(() => session.enterFastRead({ image: image.slice(), verified: true }));
        expect(respond.mock.calls.some(([r]) => r[0] === 0x07)).toBe(false);
    });

    it('restores baud and access after a power cycle', async () => {
        const { transport } = practiceProgrammingTransport(practiceEcuImage(), { batchMs: 0 });
        const events: string[] = [];
        const session = new Ds2Session({ ...transport,
            setBaudRate: async rate => { events.push(`baud ${rate}`); },
            drain: async () => { events.push('drain'); },
        });
        vi.spyOn(session, 'login').mockImplementation(async () => { events.push('login'); });
        await session.resumeAfterPowerCycle();
        expect(events).toEqual(['baud 9600', 'drain', 'login']);
    });

    it('refuses an inconsistent live counter before any programming control', async () => {
        const image = practiceEcuImage();
        const { transport, dme } = practiceProgrammingTransport(image, { batchMs: 0 });
        const respond = vi.spyOn(dme, 'respond');
        const session = new Ds2Session(transport, { delay: async () => {} });
        const original = session.readServiceBlock.bind(session);
        let reads = 0;
        vi.spyOn(session, 'readServiceBlock').mockImplementation(async processor => {
            const bytes = await original(processor);
            if (++reads === 2) bytes[0x884]! ^= 1;
            return bytes;
        });
        await withSimulatedEcu(() => session.enterFastRead({ image: image.slice(), verified: true }));
        expect(respond.mock.calls.some(([r]) => r[0] === 0x07)).toBe(false);
    });
});
