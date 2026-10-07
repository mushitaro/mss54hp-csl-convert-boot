import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Ds2Session } from './session';
import { PracticeDme, practiceEcuImage, practiceProgrammingTransport, practiceSa0 } from './practiceEcu';
import { runFlash } from './flashExecute';
import { planFlash, validateSequence } from './flashSequence';
import { runBlReplace } from './blExecute';
import { planBlReplace, assertBlReplaceable } from './blReplace';
import { buildStagedSector, MAGIC_OFFSET, STAGED_IMAGE_CRC_OFFSET } from './blLoader';
import { patchToCsl } from './bootloaderImage';
import { assemble } from './emulator/asm68k';
import { withSimulatedEcu } from './writeLock';
import { buildDs2Frame, DME_DS2_ADDRESS, parseDs2Frame } from './ds2';
import type { ByteTransport } from './transport';

function rig() {
    const image = practiceEcuImage();
    const { transport, dme } = practiceProgrammingTransport(image, { batchMs: 0 });
    const session = new Ds2Session(transport, { delay: async () => {} });
    return { image, transport, dme, session };
}

describe('manual ignition completion', () => {
    it('finishes, verifies, waits without sending, then reopens at 9600 and runs IDENT/login', async () => {
        const { image, transport, session } = rig();
        const events: string[] = [];
        vi.spyOn(session, 'finishProgramming').mockImplementation(async () => { events.push('finish'); });
        vi.spyOn(session, 'fullBackup').mockImplementation(async () => {
            events.push('read-back');
            return { image: image.slice(), verified: true, differingOffsets: [] };
        });
        vi.spyOn(session, 'encodingChecksum').mockImplementation(async () => {
            events.push('checksum');
            return { anyFaulted: false } as Awaited<ReturnType<Ds2Session['encodingChecksum']>>;
        });
        transport.setBaudRate = async rate => { events.push(`baud ${rate}`); };
        const ident = session.ident.bind(session);
        vi.spyOn(session, 'ident').mockImplementation(async () => { events.push('ident'); return ident(); });
        const login = session.login.bind(session);
        vi.spyOn(session, 'login').mockImplementation(async () => { events.push('login'); await login(); });
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        let prompt!: () => void;
        const prompted = new Promise<void>(resolve => { prompt = resolve; });
        const phases: string[] = [];
        const run = withSimulatedEcu(() => runFlash(session,
            planFlash({ image: image.slice(), windowKinds: ['calibration'] }), image.slice(), {
                verifyReadBack: true,
                onProgress: p => phases.push(p.phase),
                onPowerCycle: async () => { events.push('prompt'); prompt(); await held; events.push('key-on'); },
            }));
        await prompted;
        expect(events).toEqual(['login', 'finish', 'read-back', 'checksum', 'prompt']);
        expect(phases).not.toContain('done');
        release();
        const result = await run;
        expect(events.slice(-5)).toEqual(['key-on', 'baud 9600', 'ident', 'login', 'checksum']);
        expect(result.completed).toBe(true);
        expect(result.postCycleIdent).toBeTruthy();
        expect(phases.at(-1)).toBe('done');
    });

    it.each(['finish', 'read-back', 'post-ident', 'post-checksum', 'post-checksum-silent'] as const)(
        'never completes when %s fails', async failure => {
            const { image, session } = rig();
            const cycle = vi.fn(async () => {});
            const phases: string[] = [];
            vi.spyOn(session, 'fullBackup').mockResolvedValue({ image, verified: failure !== 'read-back', differingOffsets: [] });
            if (failure === 'finish') vi.spyOn(session, 'finishProgramming').mockRejectedValue(new Error('finish failed'));
            if (failure === 'post-ident') vi.spyOn(session, 'resumeAfterPowerCycle').mockRejectedValue(new Error('IDENT silent'));
            if (failure === 'post-checksum' || failure === 'post-checksum-silent') {
                const checksum = session.encodingChecksum.bind(session);
                let n = 0;
                vi.spyOn(session, 'encodingChecksum').mockImplementation(async () => {
                    if (++n === 2 && failure === 'post-checksum-silent') throw new Error('checksum silent');
                    return { ...await checksum(), anyFaulted: n === 2 };
                });
            }
            const result = await withSimulatedEcu(() => runFlash(session,
                planFlash({ image, windowKinds: ['calibration'] }), image, {
                    verifyReadBack: true, onPowerCycle: cycle, onProgress: p => phases.push(p.phase),
                })).catch(e => e as Error);
            expect(phases).not.toContain('done');
            if (!(result instanceof Error)) expect(result.completed).toBe(false);
            if (failure === 'finish' || failure === 'read-back') expect(cycle).not.toHaveBeenCalled();
        });

    it('does not call a read-back-only result complete', async () => {
        const { image, session } = rig();
        const result = await withSimulatedEcu(() => runFlash(session,
            planFlash({ image, windowKinds: ['calibration'] }), image, { verifyReadBack: true }));
        expect(result.verified).toBe(true);
        expect(result.completed).toBe(false);
    });
});

describe('paired erase sessions', () => {
    it('rejects starting calibration erase before program Finish, or a repeated peer erase', () => {
        const plan = planFlash({ image: practiceEcuImage(), windowKinds: ['program', 'calibration'] });
        expect(validateSequence(plan)).toEqual([]);
        expect(plan.eraseCount).toBe(2);
        const steps = plan.steps.slice();
        steps.splice(steps.findIndex(s => s.kind === 'finish'), 1);
        expect(validateSequence({ ...plan, steps }).some(v => /Finish/.test(v.reason))).toBe(true);
        const duplicated = plan.steps.slice();
        duplicated.splice(2, 0, plan.steps[1]!);
        expect(validateSequence({ ...plan, steps: duplicated }).length).toBeGreaterThan(0);
    });

    it('restores and verifies the other CPU before arming a bootloader', async () => {
        const { image, session, dme } = rig();
        const peerBefore = image.slice(0x8000, 0x10000);
        const intended = patchToCsl(practiceSa0('slave'), 'slave').sa0;
        const loader = assemble(readFileSync('tools/loader/replace.s', 'utf8'));
        await withSimulatedEcu(async () => {
            const plan = planBlReplace(buildStagedSector('slave', loader.bytes, intended));
            const cycle = async () => {
                expect(image.slice(0x8000, 0x10000)).toEqual(peerBefore);
                dme.powerCycle();
            };
            const result = await runBlReplace(session, plan, intended, { onPowerCycle: cycle });
            expect(result.matchesIntended).toBe(true);
        });
    });

    it('rejects a peer already armed before erasing anything', async () => {
        const { image, session } = rig();
        image.set([0x5a, 0xa5, 0x56, 0xc9], 0x8000 + MAGIC_OFFSET);
        const erase = vi.spyOn(session, 'eraseWindow');
        await withSimulatedEcu(async () => {
            const intended = patchToCsl(practiceSa0('slave'), 'slave').sa0;
            const plan = planBlReplace(buildStagedSector('slave', new Uint8Array([0x46, 0]), intended));
            await expect(runBlReplace(session, plan, intended, { onPowerCycle: async () => {} })).rejects.toThrow(/peer CPU is already armed/);
        });
        expect(erase).not.toHaveBeenCalled();
    });

    it('does not attempt a restoration write after a partially erased peer sector', async () => {
        const { image, session } = rig();
        const erase = session.eraseWindow.bind(session);
        vi.spyOn(session, 'eraseWindow').mockImplementation(async address => {
            await erase(address);
            image[0x8000] = 0; // peer is neither preserved nor entirely erased
        });
        const write = vi.spyOn(session, 'writeChunk');
        await withSimulatedEcu(async () => {
            const intended = patchToCsl(practiceSa0('slave'), 'slave').sa0;
            const plan = planBlReplace(buildStagedSector('slave', new Uint8Array([0x46, 0]), intended));
            await expect(runBlReplace(session, plan, intended, { onPowerCycle: async () => {} }))
                .rejects.toThrow(/peer calibration was partially changed/);
        });
        expect(write).not.toHaveBeenCalled();
    });

    it('validates the runtime CRC metadata before staging', async () => {
        await withSimulatedEcu(async () => {
            const intended = patchToCsl(practiceSa0('slave'), 'slave').sa0;
            const sector = buildStagedSector('slave', new Uint8Array([0x46, 0]), intended);
            sector.bytes[STAGED_IMAGE_CRC_OFFSET]! ^= 1;
            expect(() => assertBlReplaceable(planBlReplace(sector))).toThrow(/CRC/);
        });
    });
});

describe('ambiguous WRITE outcomes', () => {
    it.each(['landed', 'erased', 'partial', 'unreadable', 'disagree', 'negative'] as const)(
        'handles %s without blindly programming an existing cell', async state => {
            const image = practiceEcuImage();
            image.fill(0xff, 0x8000, 0x10000);
            const dme = new PracticeDme(image);
            let buffer: number[] = [];
            let writes = 0;
            let reads = 0;
            const transport: ByteTransport = {
                simulated: true,
                write: async frame => {
                    buffer.push(...frame);
                    const req = parseDs2Frame(frame).data!;
                    if (req[0] === 7 && req[1] === 2 && ++writes === 1) {
                        if (state === 'landed') dme.respond(req);
                        if (state === 'partial') image[0x8000] = 0x12;
                        if (state === 'negative') buffer.push(...buildDs2Frame(DME_DS2_ADDRESS, new Uint8Array([0xa2])));
                        return;
                    }
                    if (req[0] === 6) {
                        if (state === 'unreadable') return;
                        if (state === 'disagree' && ++reads === 2) image[0x8000] = 0;
                    }
                    buffer.push(...buildDs2Frame(DME_DS2_ADDRESS, dme.respond(req)));
                },
                read: async n => {
                    if (buffer.length < n) throw new Error('ACK lost');
                    return Uint8Array.from(buffer.splice(0, n));
                },
                drain: async () => { buffer = []; },
            };
            const session = new Ds2Session(transport, { delay: async () => {} });
            await session.login();
            const result = await withSimulatedEcu(() => session.writeChunk(0x200000, new Uint8Array([0x12, 0x34]))).catch(e => e);
            if (state === 'landed' || state === 'erased') {
                expect(result).toBeUndefined();
                expect(image.slice(0x8000, 0x8002)).toEqual(new Uint8Array([0x12, 0x34]));
            } else expect(result).toBeInstanceOf(Error);
            expect(writes).toBe(state === 'erased' ? 2 : 1);
        });

    it('does not send even a preparation marker to hardware for FAST ENTRY', async () => {
        const write = vi.fn(async () => {});
        const session = new Ds2Session({ write, read: async () => new Uint8Array() });
        await expect(session.enterFastRead({ image: practiceEcuImage(), verified: true })).resolves.toBe(false);
        expect(write).not.toHaveBeenCalled();
    });
});
