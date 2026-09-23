/**
 * The synthetic ECU the practice mode drives, checked against the real session.
 *
 * It exists to be read by production code, so the thing worth testing is not its bytes but whether
 * `Ds2Session` can actually walk it - identify both bootloaders, capture it, compare it. A practice
 * mode that hangs teaches nothing, and it hangs silently: a failing read retries five times with
 * backoff, so a broken fixture looks like a slow one.
 */
import { describe, it, expect } from 'vitest';
import { Ds2Session } from './session';
import { MockDme } from './mockDme';
import { FULL_IMAGE_LENGTH } from './imageLayout';
import { identifyBootloader, verifyBootloaderCrc } from './bootloaderImage';
import {
    practiceEcuImage, practiceSa0, practiceTransport, practiceProgrammingTransport,
} from './practiceEcu';
import { withSimulatedEcu } from './writeLock';

/**
 * The rig drives the SHIPPED transport, not a bare mock.
 *
 * That distinction is the whole point of this file. The image was never the problem - the wrapper
 * around the mock was, and a test that skipped it passed while the app hung.
 */
function rig() {
    const image = practiceEcuImage();
    const { transport, dme } = practiceTransport(image);
    return { image, dme, session: new Ds2Session(transport, { delay: async () => {} }) };
}

describe('the practice ECU, driven by the real session', () => {
    it('identifies as a standard M3 on BOTH processors', async () => {
        // The slave half is the one that broke: a fixture that satisfies the master and not the
        // slave produces a practice run that reaches 2/3 and then retries until it is abandoned.
        const { session } = rig();
        await session.login();
        for (const processor of ['master', 'slave'] as const) {
            const { report } = await session.readBootloader(processor);
            expect(report.flavour, processor).toBe('standard-m3');
            expect(report.crc.valid, processor).toBe(true);
        }
    });

    it('has a self-consistent CRC on each processor', () => {
        for (const processor of ['master', 'slave'] as const) {
            const sa0 = practiceSa0(processor);
            expect(verifyBootloaderCrc(sa0, processor).valid).toBe(true);
            expect(identifyBootloader(sa0, processor)).toBe('standard-m3');
        }
    });

    it('captures in two passes that agree', async () => {
        const { session, image } = rig();
        await session.login();
        const backup = await session.fullBackup();
        expect(backup.verified).toBe(true);
        // Outside the censored window the capture is the image.
        for (let i = 0x4018; i < FULL_IMAGE_LENGTH; i++) {
            if (backup.image[i] !== image[i]) throw new Error(`differs at 0x${i.toString(16)}`);
        }
        // ~38 s of deliberate pacing: this is the run whose length the practice mode exists to
        // convey, so it cannot be sped up for the test without testing something else.
    }, 90_000);

    it('serves a service block that is not blank, on both processors', async () => {
        const { session } = rig();
        await session.login();
        for (const processor of ['master', 'slave'] as const) {
            const block = await session.readServiceBlock(processor);
            expect(block.some((b) => b !== 0xff), processor).toBe(true);
        }
    });
});

/**
 * Fast entry, driven end to end against the simulator.
 *
 * The SPEED step used to be scenery: it offered a choice, and nothing in the app ever called
 * `enterFastRead`. Now that the run does call it, this pins what practice actually exercises - the
 * whole destructive half, up to and including the restore verify - and pins the one part it
 * honestly cannot do.
 */
describe('fast entry against the practice ECU', () => {
    it('erases, restores, verifies, and then declines the rate change it cannot make', async () => {
        const image = practiceEcuImage();
        const { transport } = practiceProgrammingTransport(image, { batchMs: 0 });
        const session = new Ds2Session(transport);
        const lines: string[] = [];

        const boosted = await withSimulatedEcu(() =>
            session.enterFastRead({ image, verified: true }, (line) => lines.push(line)));

        // False, because a simulator has no line to re-clock - not because it refused to work.
        expect(boosted).toBe(false);
        const log = lines.join('\n');
        expect(log, 'the erase must have happened').toContain('erased both Free Identifiers sectors');
        expect(log, 'and the restore must have been checked').toContain('restore verified');
        expect(log, 'and the only thing it could not do is the rate').toContain('cannot change baud');
    });

    it('declines before erasing when the capture cannot say what to put back', async () => {
        // The reversible half. A blank service block means the restore has no source, and the
        // contract is that this costs the speed and nothing else.
        const image = practiceEcuImage();
        const { transport } = practiceProgrammingTransport(image, { batchMs: 0 });
        const session = new Ds2Session(transport);
        const lines: string[] = [];

        const blank = new Uint8Array(image.length).fill(0xff);
        const boosted = await withSimulatedEcu(() =>
            session.enterFastRead({ image: blank, verified: true }, (line) => lines.push(line)));

        expect(boosted).toBe(false);
        const log = lines.join('\n');
        expect(log).toMatch(/FAST ENTRY skipped/);
        expect(log, 'nothing may have been erased').not.toContain('erased both Free Identifiers');
    });
});
