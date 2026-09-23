/**
 * The lock, and the shape of the locked state.
 *
 * Two things are being tested. First, that the lock is engaged - a plain assertion that this
 * build cannot emit destructive bytes. Second, and more interesting, that the locked state is
 * still *useful*: planning, assembling and validating all have to keep working, because a lock
 * that stops development is a lock somebody turns off early.
 */
import { describe, it, expect } from 'vitest';
import {
    HARDWARE_WRITE_ENABLED, WriteLockedError, HardwareWriteLockedError,
    assertWriteUnlocked, assertHardwareWriteUnlocked, withSimulatedEcu, simulating, writesAreUnlocked,
} from './writeLock';
import { Ds2Link } from './transport';
import { practiceEcuImage, practiceProgrammingTransport } from './practiceEcu';
import {
    buildEraseTelegram, buildWriteTelegram, buildJumpTelegram, buildFinishTelegram,
    buildRecyclingTelegram, buildReadTelegram, buildBaudRateTelegram, buildEncodingChecksumTelegram,
} from './telegrams';
import { assertLoaderCodeIsStageable, buildStagedSector, LOADER_CODE_CAPACITY } from './blLoader';
import { planFullSpaceRead, buildRawReadTelegram } from './fullSpaceRead';
import { SA0_LENGTH } from './bootloaderImage';

describe('the hardware write lock', () => {
    it('is engaged in this build', () => {
        expect(HARDWARE_WRITE_ENABLED).toBe(false);
        expect(writesAreUnlocked()).toBe(false);
    });

    it('throws a named error that says where the switch is', () => {
        expect(() => assertWriteUnlocked('a test')).toThrow(WriteLockedError);
        expect(() => assertWriteUnlocked('a test')).toThrow(/writeLock\.ts/);
    });

    it('does not name BDM as a precondition of unlocking', () => {
        // It was named here, and that inverted what this tool is: the bootloader is replaced over
        // OBD alone, and BDM is insurance against a failure rather than equipment the job needs.
        // Pinned so the framing cannot drift back.
        expect(() => assertWriteUnlocked('a test')).not.toThrow(/BDM/);
    });
});

describe('while arming is locked, nothing irreversible produces bytes', () => {
    // 0x200000 is the staging area - a loader and the magic go there, and `tierForAddress` reads
    // that straight out of the address. The same three builders aimed at a Free Identifiers
    // sector are the reversible tier and are covered in `writeTier.test.ts`.
    const destructive: [string, () => unknown][] = [
        ['erase', () => buildEraseTelegram(0x200000)],
        ['write', () => buildWriteTelegram(0x200000, new Uint8Array(2))],
        ['finish', () => buildFinishTelegram(0x200000)],
        ['jump (cmd 0x34)', () => buildJumpTelegram()],
        ['staged sector', () => buildStagedSector('master', new Uint8Array(4), new Uint8Array(SA0_LENGTH))],
    ];

    for (const [name, build] of destructive) {
        it(`refuses to build a ${name} telegram`, () => {
            expect(build).toThrow(WriteLockedError);
        });
    }

    /**
     * The exception the split created, written down next to the rule it bends.
     *
     * Recycling control at 0x424151/0x424152 is part of the fast-entry sequence, so the reversible
     * tier has to be able to build it or fast entry cannot run at all. It selects a flash
     * controller mode rather than changing a cell - and everything that does change cells
     * irreversibly is refused above, by its address, which is the only reason letting this one
     * through is safe rather than merely convenient.
     */
    it('builds the fast-entry recycling telegrams, which the reversible tier needs', () => {
        expect(buildRecyclingTelegram(0x424151)[0]).toBe(0x07);
        expect(buildRecyclingTelegram(0x424152)[0]).toBe(0x07);
    });
});

describe('while locked, everything non-destructive still works', () => {
    it('builds read telegrams', () => {
        expect(buildReadTelegram(0x00, 0x200000, 122)).toHaveLength(6);
    });

    it('builds linear full-space read telegrams', () => {
        const plan = planFullSpaceRead('master');
        const first = plan.chunks[0];
        expect(first).toBeDefined();
        expect(buildRawReadTelegram(first!)).toHaveLength(6);
    });

    it('builds the read-only diagnostic telegrams', () => {
        expect(buildEncodingChecksumTelegram()).toEqual(new Uint8Array([0x0a]));
        expect(buildBaudRateTelegram(9600)).toHaveLength(5);
    });

    it('validates loader code without assembling a sector', () => {
        expect(() => assertLoaderCodeIsStageable('master', new Uint8Array([0x60, 0x00]))).not.toThrow();
        expect(() => assertLoaderCodeIsStageable('master', new Uint8Array(LOADER_CODE_CAPACITY + 2))).toThrow(/overruns/);
    });

    it('plans a full-space read of both processors', () => {
        expect(planFullSpaceRead('master').totalBytes).toBe(0x80000);
        expect(planFullSpaceRead('slave').totalBytes).toBe(0x80000);
    });
});

describe('the two gates, and which one is the safety property', () => {
    it('opens the BUILD gate inside a simulation scope', async () => {
        expect(() => assertWriteUnlocked('erase')).toThrow(WriteLockedError);
        await withSimulatedEcu(async () => {
            expect(() => assertWriteUnlocked('erase')).not.toThrow();
        });
        expect(() => assertWriteUnlocked('erase')).toThrow(WriteLockedError);
    });

    it('closes the build gate again when the simulated run throws', async () => {
        // The case that matters: a failed practice run must not leave the builders open for
        // whatever runs next.
        await expect(withSimulatedEcu(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
        expect(simulating()).toBe(false);
        expect(() => assertWriteUnlocked('erase')).toThrow(WriteLockedError);
    });

    it('restores the previous depth rather than clearing it, so nesting is safe', async () => {
        await withSimulatedEcu(async () => {
            await withSimulatedEcu(async () => { expect(simulating()).toBe(true); });
            // The inner scope ending must not close the outer one.
            expect(simulating()).toBe(true);
            expect(() => assertWriteUnlocked('erase')).not.toThrow();
        });
        expect(simulating()).toBe(false);
    });

    it('NEVER opens the hardware gate for a real transport, scope or no scope', async () => {
        // This is the whole safety property. A simulation scope says "a simulator asked for these
        // bytes"; only the transport can say "and there is no ECU here to receive them".
        expect(() => assertHardwareWriteUnlocked('erase', false)).toThrow(HardwareWriteLockedError);
        await withSimulatedEcu(async () => {
            expect(() => assertHardwareWriteUnlocked('erase', false)).toThrow(HardwareWriteLockedError);
        });
    });

    it('opens the hardware gate only for a transport that declares itself simulated', () => {
        expect(() => assertHardwareWriteUnlocked('erase', true)).not.toThrow();
    });

    it('refuses a destructive telegram on a real transport even while simulating', async () => {
        // End to end through Ds2Link: the link reads `transport.simulated`, which a real transport
        // never sets, so the scope cannot smuggle bytes onto a cable.
        const sent: Uint8Array[] = [];
        const real = { write: async (b: Uint8Array) => { sent.push(b); }, read: async () => new Uint8Array() };
        const link = new Ds2Link(real, { delay: async () => {} });
        await withSimulatedEcu(async () => {
            // 0x200000 is the staging area - where a loader and the magic go. Irreversible.
            await expect(link.transceive(new Uint8Array([0x07, 0x06, 0x20, 0x00, 0x00, 0x00])))
                .rejects.toThrow(/writes are locked/);
            await expect(link.transceive(new Uint8Array([0x34]))).rejects.toThrow(/writes are locked/);
        });
        expect(sent).toEqual([]);

        // And the other half of the split: the same command byte, aimed at the master Free
        // Identifiers sector, is NOT stopped here. It reaches the transport and then fails for
        // want of an answer, which is a transport problem and not a lock.
        const failure = await link.transceive(new Uint8Array([0x07, 0x06, 0, 0, 0, 0])).catch((e) => e);
        expect(String(failure)).not.toMatch(/writes are locked/);
        expect(sent.length, 'the reversible telegram went out').toBeGreaterThan(0);
    });

    it('lets a simulated transport through - which is what makes practice possible', async () => {
        const image = practiceEcuImage();
        const { transport } = practiceProgrammingTransport(image);
        expect(transport.simulated).toBe(true);
        const link = new Ds2Link(transport, { delay: async () => {} });
        // Recycling control: destructive by command byte, harmless against a simulator.
        const response = await link.transceive(new Uint8Array([0x07, 0x0e, 0x42, 0x41, 0x51, 0x00]));
        expect(response.ok).toBe(true);
    });

    it('is the only transport in the package that declares itself simulated', async () => {
        // A grep expressed as a test: if a second one appears, it should be a deliberate edit here.
        const { readFileSync, readdirSync } = await import('node:fs');
        const { join } = await import('node:path');
        const dir = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
        const offenders = readdirSync(dir)
            .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
            .filter((f) => /^\s*simulated:\s*true/m.test(readFileSync(join(dir, f), 'utf8')));
        expect(offenders).toEqual(['practiceEcu.ts']);
    });
});
