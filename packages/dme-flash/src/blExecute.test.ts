/**
 * The bootloader replacement, executed end to end over DS2 against a simulated ECU.
 *
 * `emulator/replaceLoader.test.ts` proves the loader does the right thing once it is running on the
 * CPU. This proves the other half: that the telegrams which get it there are sent in an order that
 * survives, and that the two gates behave the way the design claims.
 *
 * The ECU is `PracticeDme`, which models NOR properly - erase sets 0xFF, programming only clears
 * bits, and SA0 refuses an erase. That last one matters: it is the constraint that makes a loader
 * necessary at all, so a simulator without it would let a wrong sequence pass.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { Ds2Session } from './session';
import { runBlReplace } from './blExecute';
import { planBlReplace } from './blReplace';
import { buildStagedSector, STAGING_DS2_ADDRESS, MAGIC_OFFSET, STAGED_MAGIC } from './blLoader';
import { practiceEcuImage, practiceProgrammingTransport, practiceSa0 } from './practiceEcu';
import { patchToCsl, extractSa0, SA0_LENGTH } from './bootloaderImage';
import { withSimulatedEcu, HARDWARE_WRITE_ENABLED } from './writeLock';
import { assemble } from './emulator/asm68k';
import type { Processor } from './imageLayout';

const loader = assemble(readFileSync('tools/loader/replace.s', 'utf8'));

/** A run against a simulated ECU, with the ignition cycled by a stub. */
async function convert(processor: Processor, options: { failPowerCycle?: boolean } = {}) {
    const image = practiceEcuImage();
    const { transport, dme } = practiceProgrammingTransport(image, { batchMs: 0 });
    const session = new Ds2Session(transport, { delay: async () => {} });
    const events: string[] = [];
    const phases: string[] = [];

    const intended = patchToCsl(practiceSa0(processor), processor).sa0;

    return withSimulatedEcu(async () => {
        const sector = buildStagedSector(processor, loader.bytes, intended);
        const plan = planBlReplace(sector);
        const outcome = await runBlReplace(session, plan, intended, {
            onEvent: (line) => events.push(line),
            onProgress: (p) => { if (phases[phases.length - 1] !== p.phase) phases.push(p.phase); },
            onPowerCycle: async () => {
                if (options.failPowerCycle) throw new Error('operator gave up');
                // What the reset handler does: find the magic, run the loader. The loader's own
                // behaviour is proven on the CPU emulator; here it is applied directly so this test
                // stays about the telegram sequence.
                runLoader(image, processor, intended);
            },
        });
        return { outcome, events, phases, image, dme, plan, intended };
    });
}

/**
 * What the loader does once the reset handler reaches it: clear the magic FIRST, then replace SA0.
 *
 * The order is the loader's most important property (`tools/loader/replace.s`) - disarming before
 * touching anything means a loader that then fails leaves an ECU that boots normally rather than
 * one that re-enters a broken loader forever.
 */
function runLoader(image: Uint8Array, processor: Processor, intended: Uint8Array): void {
    const base = processor === 'master' ? 0 : 0x80000;
    const magicAt = base + 0x8000 + MAGIC_OFFSET;
    image.fill(0x00, magicAt, magicAt + 4);
    image.set(intended, base);
}

describe('replacing a bootloader over DS2, against a simulated ECU', () => {
    it('leaves the slave carrying the CSL bootloader, byte for byte', async () => {
        const { outcome } = await convert('slave');
        expect(outcome.matchesIntended).toBe(true);
        expect(outcome.flavour).toBe('csl');
        expect(outcome.crcValid).toBe(true);
        expect(outcome.differingOffsets).toEqual([]);
    });

    it('does the master too', async () => {
        const { outcome } = await convert('master');
        expect(outcome.flavour).toBe('csl');
        expect(outcome.crcValid).toBe(true);
        expect(outcome.matchesIntended).toBe(true);
    });

    it('verifies the staged sector BEFORE it arms anything', async () => {
        const { phases } = await convert('slave');
        expect(phases.indexOf('verify-staged')).toBeGreaterThan(-1);
        expect(phases.indexOf('verify-staged')).toBeLessThan(phases.indexOf('arm'));
        expect(phases.indexOf('arm')).toBeLessThan(phases.indexOf('power-cycle'));
        expect(phases.indexOf('power-cycle')).toBeLessThan(phases.indexOf('read-after'));
    });

    it('waits for a person at the power cycle rather than pretending to do it', async () => {
        const { events } = await convert('slave');
        expect(events).toContain('WAITING for the ignition to be cycled');
        expect(events).toContain('POWER CYCLED');
    });

    it('clears the magic, so the converted ECU boots normally afterwards', async () => {
        const { image } = await convert('slave');
        const magicAt = 0x80000 + 0x8000 + MAGIC_OFFSET;
        const magic = ((image[magicAt]! << 24) | (image[magicAt + 1]! << 16)
            | (image[magicAt + 2]! << 8) | image[magicAt + 3]!) >>> 0;
        expect(magic).not.toBe(STAGED_MAGIC);
        expect(magic).toBe(0);
    });

    it('touches nothing outside the bootloader and the staging sector', async () => {
        const before = practiceEcuImage();
        const { image } = await convert('slave');
        const stagingStart = 0x80000 + 0x8000;
        for (let i = 0; i < image.length; i++) {
            if (i >= 0x80000 && i < 0x80000 + SA0_LENGTH) continue;          // SA0: the target
            if (i >= stagingStart && i < stagingStart + 0x8000) continue;    // the staged sector
            if (image[i] !== before[i]) throw new Error(`disturbed 0x${i.toString(16)}`);
        }
    });

    it('leaves the service block - VIN, AIF, flash counter - exactly as it found it', async () => {
        const before = practiceEcuImage();
        const { image } = await convert('slave');
        for (let i = 0x84000; i < 0x86000; i++) expect(image[i], `0x${i.toString(16)}`).toBe(before[i]);
    });

    it('reports where the run stopped when the operator abandons the power cycle', async () => {
        // The ECU is armed by then. The run failing is not the ECU being safe - the loader still
        // runs at the next power-up - and the test exists to pin that this is an error, not a
        // quiet return.
        await expect(convert('slave', { failPowerCycle: true })).rejects.toThrow('operator gave up');
    });

    it('refuses before a single telegram when the staged sector cannot be verified', async () => {
        // A staged sector that reads back wrong must stop while the ECU still boots normally.
        const image = practiceEcuImage();
        const { transport } = practiceProgrammingTransport(image, { batchMs: 0 });
        const session = new Ds2Session(transport, { delay: async () => {} });
        const intended = patchToCsl(practiceSa0('slave'), 'slave').sa0;

        await withSimulatedEcu(async () => {
            const sector = buildStagedSector('slave', loader.bytes, intended);
            const plan = planBlReplace(sector);
            // Corrupt the sector under the executor after it has been written: the read-back will
            // not match what the executor believes it sent.
            const original = session.readWindow.bind(session);
            let calls = 0;
            (session as unknown as { readWindow: typeof original }).readWindow = async (a, l) => {
                const bytes = await original(a, l);
                if (calls++ === 0) bytes[0x40] = (bytes[0x40] ?? 0) ^ 0xff;
                return bytes;
            };
            await expect(runBlReplace(session, plan, intended, { onPowerCycle: async () => {} }))
                .rejects.toThrow(/does not read back as written/);
        });
    });
});

describe('the gates, on the path that would actually brick a car', () => {
    it('cannot even build the staged sector outside a simulation scope', () => {
        expect(HARDWARE_WRITE_ENABLED).toBe(false);
        const intended = patchToCsl(practiceSa0('slave'), 'slave').sa0;
        expect(() => buildStagedSector('slave', loader.bytes, intended))
            .toThrow(/hardware writes are locked/);
    });

    it('refuses to send the sequence to a transport that is not a simulator', async () => {
        // A transport that answers exactly like the simulator, minus the one declaration. So the
        // login and the reads all succeed and the run gets as far as the erase - which is where the
        // hardware gate fires. Testing this with a dead stub would only have proven that a dead
        // stub fails.
        const sent: Uint8Array[] = [];
        const { transport: sim } = practiceProgrammingTransport(practiceEcuImage(), { batchMs: 0 });
        const real = {
            write: async (b: Uint8Array) => { sent.push(b); await sim.write(b); },
            read: (n: number, t: number) => sim.read(n, t),
            drain: async () => { await sim.drain?.(); },
            // No `simulated` marker. That single absence is the entire difference.
        };
        const session = new Ds2Session(real, { delay: async () => {} });
        const intended = patchToCsl(practiceSa0('slave'), 'slave').sa0;

        await withSimulatedEcu(async () => {
            const sector = buildStagedSector('slave', loader.bytes, intended);
            const plan = planBlReplace(sector);
            // The build gate is open. The hardware gate is not, and it is keyed on the transport.
            await expect(runBlReplace(session, plan, intended, { onPowerCycle: async () => {} }))
                .rejects.toThrow(/writes are locked/);
        });
        // Whatever it managed before the refusal, no PROGRAMMING telegram went out.
        expect(sent.some((f) => f[2] === 0x07 || f[2] === 0x34)).toBe(false);
    });

    it('stages to the calibration window and never to the bootloader nibble', async () => {
        const { plan } = await convert('slave');
        expect(plan.ds2Address).toBe(STAGING_DS2_ADDRESS.slave);
        for (const step of plan.steps) {
            if (step.ds2Address === undefined || step.ds2Address === 0) continue;
            expect((step.ds2Address >>> 20) & 0x7, step.note).not.toBe(0x1);
        }
    });
});

/** The genuine images, when they are present, are a stronger target than a synthetic one. */
const HW2001 = process.env.HW2001_BIN
    ?? String.raw`C:\Users\kazuh\MSS54-DS2-Tool-Public-1.2.1\hw2001-analysis\hw2001_full.bin`;
const maybe = existsSync(HW2001) ? it : it.skip;

describe('against a real car dump', () => {
    maybe('converts a genuine standard-M3 SA0 into the genuine CSL one', async () => {
        const stock = new Uint8Array(readFileSync(HW2001));
        const image = practiceEcuImage();
        // Put the real bootloaders on the simulated ECU.
        for (const [processor, base] of [['master', 0], ['slave', 0x80000]] as const) {
            image.set(extractSa0(stock, processor), base);
        }
        const { transport } = practiceProgrammingTransport(image, { batchMs: 0 });
        const session = new Ds2Session(transport, { delay: async () => {} });
        const intended = patchToCsl(extractSa0(stock, 'slave'), 'slave').sa0;

        const outcome = await withSimulatedEcu(async () => {
            const plan = planBlReplace(buildStagedSector('slave', loader.bytes, intended));
            return runBlReplace(session, plan, intended, {
                onPowerCycle: async () => { runLoader(image, 'slave', intended); },
            });
        });
        expect(outcome.flavour).toBe('csl');
        expect(outcome.crcValid).toBe(true);
        expect(outcome.matchesIntended).toBe(true);
    });
});
