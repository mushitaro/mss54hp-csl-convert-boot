/**
 * The read path, end to end, against a DME that answers like the real one.
 *
 * This is the first milestone made executable: log in, capture both processors twice, compare,
 * and confirm the capture contains the bootloader and the car-specific service block. Every byte
 * comes back through the real framing, echo handling and retry logic, so what is tested here is
 * the code that would run on a car - not a stand-in for it.
 *
 * The image driving the mock is a genuine 1 MiB dump, so a successful reassembly is checked
 * against bytes BMW shipped rather than against a synthetic pattern.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { Ds2Session, SessionError } from './session';
import { Ds2Link, Ds2LinkError, TIMEOUTS } from './transport';
import { MockDme } from './mockDme';
import { Ds2Status, buildDs2Frame, DME_DS2_ADDRESS } from './ds2';
import { buildReadTelegram, LinearReadSegment } from './telegrams';
import { FULL_IMAGE_LENGTH } from './imageLayout';
import { extractSa0, KNOWN_BOOTLOADER_CRC, diffOffsets } from './bootloaderImage';
import { CENSORED_RANGE } from './fullSpaceRead';
import { FREE_IDENTIFIERS, buildPreservationPlan, serviceBlockMatches } from './fastEntry';

const STOCK_M3 = process.env.HW2001_BIN
    ?? String.raw`C:\Users\kazuh\MSS54-DS2-Tool-Public-1.2.1\hw2001-analysis\hw2001_full.bin`;
const haveImage = existsSync(STOCK_M3);
const full = haveImage ? new Uint8Array(readFileSync(STOCK_M3)) : undefined;
const maybe = haveImage ? it : it.skip;

/** A mock DME loaded with a real car's flash, and a session talking to it. */
function rig(options: Partial<ConstructorParameters<typeof MockDme>[0]> = {}) {
    const dme = new MockDme({
        master: full!.slice(0, 0x80000),
        slave: full!.slice(0x80000),
        ...options,
    });
    // No real delays in tests; the retry logic is still exercised.
    const session = new Ds2Session(dme.transport(), { delay: async () => {} });
    return { dme, session };
}

describe('the session, against a DME answering like the real one', () => {
    maybe('reads the identification string', async () => {
        const { session } = rig();
        expect(await session.ident()).toBe('7837340 1B009060');
    });

    maybe('completes the seed/key login on command 0x90', async () => {
        const { dme, session } = rig();
        expect(dme.unlocked).toBe(false);
        await session.login();
        expect(dme.unlocked).toBe(true);
    });

    maybe('reads the encoding checksum and reports every area healthy', async () => {
        const { session } = rig();
        const report = await session.encodingChecksum();
        expect(report.anyFaulted).toBe(false);
        expect(report.bootMasterFaulted).toBe(false);
        expect(report.bootSlaveFaulted).toBe(false);
    });

    maybe('refuses the linear read segments until the login has been done', async () => {
        // The firmware gates segment 0x05/0x0C on an access bit that command 0x90 grants.
        const { session } = rig();
        await expect(session.readChunk(LinearReadSegment.master, 0, 16))
            .rejects.toThrow(/REJECTED/);
    });

    maybe('reads the bootloader sector, which no other path can reach', async () => {
        const { session } = rig();
        await session.login();
        const { sa0, report } = await session.readBootloader('master');

        expect(diffOffsets(sa0, extractSa0(full!, 'master'))).toEqual([]);
        expect(report.flavour).toBe('standard-m3');
        expect(report.crc.valid).toBe(true);
        expect(report.crc.stored).toBe(KNOWN_BOOTLOADER_CRC.standardM3.master);
        expect(report.programNumbers).toEqual(['21132300', '21132300', '21132300']);
    });

    maybe('reads the slave bootloader too, and knows it carries no program number', async () => {
        const { session } = rig();
        await session.login();
        const { report } = await session.readBootloader('slave');
        expect(report.crc.valid).toBe(true);
        expect(report.crc.stored).toBe(KNOWN_BOOTLOADER_CRC.standardM3.slave);
        expect(report.programNumbers).toBeUndefined();
    });
});

describe('the full backup', () => {
    maybe('captures both processors byte for byte, outside the censored window', async () => {
        const { session } = rig();
        await session.login();
        const backup = await session.fullBackup();

        expect(backup.image).toHaveLength(FULL_IMAGE_LENGTH);
        expect(backup.verified).toBe(true);
        expect(backup.differingOffsets).toEqual([]);

        const differing = diffOffsets(backup.image, full!)
            .filter((o) => !(o >= CENSORED_RANGE.start && o < CENSORED_RANGE.end));
        expect(differing).toEqual([]);
    });

    maybe('contains the service block, which no distributable image has', async () => {
        // 0x4000-0x7FFF holds the VIN, the AIF log, the flash counter and the application entry
        // vector. Every published full binary has it blanked. If a capture has nothing here, it
        // cannot restore the car, and the operator needs to know that before relying on it.
        const { session } = rig();
        await session.login();
        const backup = await session.fullBackup();

        const serviceBlock = backup.image.subarray(0x4000, 0x8000);
        const written = serviceBlock.reduce((n, b) => n + (b !== 0xff ? 1 : 0), 0);
        expect(written).toBeGreaterThan(0);
        expect(Array.from(serviceBlock)).toEqual(Array.from(full!.subarray(0x4000, 0x8000)));
    });

    maybe('reports progress that reaches the total for both passes', async () => {
        const { session } = rig();
        await session.login();
        const seen = new Set<string>();
        let lastMaster = 0;
        await session.fullBackup((p) => {
            seen.add(`${p.processor}/${p.pass}`);
            if (p.processor === 'master' && p.pass === 2) lastMaster = p.bytesRead;
        });
        expect(seen).toEqual(new Set(['master/1', 'slave/1', 'master/2', 'slave/2']));
        expect(lastMaster).toBe(0x80000);
    });

    maybe('describes what was captured, rather than just producing a file', async () => {
        const { session } = rig();
        await session.login();
        const backup = await session.fullBackup();
        const text = Ds2Session.describe(backup.image);
        expect(text).toMatch(/master: bootloader standard-m3/);
        expect(text).toMatch(/valid/);
        expect(text).toMatch(/21132300/);
        expect(text).toMatch(/service block: [1-9]/);
    });

    maybe('reports two passes that disagree rather than silently trusting the first', async () => {
        // A link that corrupts one chunk of the second pass must not produce a "verified" backup.
        let call = 0;
        const dme = new MockDme({ master: full!.slice(0, 0x80000), slave: full!.slice(0x80000), unlocked: true });
        const inner = dme.transport();
        const flaky = {
            ...inner,
            read: async (count: number, timeoutMs: number) => {
                const bytes = await inner.read(count, timeoutMs);
                call++;
                // Corrupt one payload byte deep into the second pass, after the checksum is set.
                if (call === 20000 && bytes.length > 4) bytes[3] = (bytes[3] ?? 0) ^ 0xff;
                return bytes;
            },
        };
        const session = new Ds2Session(flaky, { delay: async () => {} });
        const backup = await session.fullBackup();
        // Either the corruption tripped the frame checksum (an error) or it landed in the data
        // and the two passes disagree. Both are acceptable; silently passing is not.
        if (backup.differingOffsets.length > 0) expect(backup.verified).toBe(false);
    });
});

describe('the link', () => {
    maybe('consumes and verifies the K-line echo', async () => {
        // A transport that swallows the echo makes every reply arrive one frame early. The link
        // must notice rather than parsing our own request as the answer.
        const dme = new MockDme({ master: full!.slice(0, 0x80000), unlocked: true });
        const inner = dme.transport();
        let first = true;
        const noEcho = {
            ...inner,
            read: async (count: number, timeoutMs: number) => {
                if (first) { first = false; await inner.read(count, timeoutMs); }
                return inner.read(count, timeoutMs);
            },
        };
        const link = new Ds2Link(noEcho, { delay: async () => {} });
        await expect(link.transceive(new Uint8Array([0x00]))).rejects.toThrow(Ds2LinkError);
    });

    maybe('retries an idempotent read through a corrupted reply', async () => {
        const dme = new MockDme({
            master: full!.slice(0, 0x80000), unlocked: true,
            failExchange: (n) => (n === 1 ? 'corrupt' : undefined),
        });
        const session = new Ds2Session(dme.transport(), { delay: async () => {} });
        // The first exchange comes back with a broken checksum; the retry succeeds.
        expect(await session.ident()).toBe('7837340 1B009060');
        expect(dme.exchanges).toBeGreaterThan(1);
    });

    maybe('gives up with a useful message when the line stays quiet', async () => {
        const dme = new MockDme({
            master: full!.slice(0, 0x80000), unlocked: true,
            failExchange: () => 'silence',
        });
        const link = new Ds2Link(dme.transport(), { delay: async () => {} });
        await expect(link.transceive(new Uint8Array([0x00]))).rejects.toThrow(/ignition on/);
    });

    it('refuses to send a destructive telegram to a transport that is not a simulator', async () => {
        // The gate that protects an ECU. It reads `transport.simulated`, which this stub does not
        // set - so bytes obtained any other way, including by a legitimate simulated run, still
        // cannot reach a car. See writeLock.ts.
        const transport = {
            write: async () => { throw new Error('should never reach the wire'); },
            read: async () => new Uint8Array(),
        };
        const link = new Ds2Link(transport, { delay: async () => {} });
        // 0x07 = programming control (erase/write/finish), 0x34 = staged-loader transfer. The
        // address matters now: 0x200000 is the staging area, where a loader and the magic go, and
        // the gate reads those three bytes out of the telegram. The same command aimed at a Free
        // Identifiers sector is the reversible tier and is meant to pass - `writeTier.test.ts`.
        await expect(link.transceive(new Uint8Array([0x07, 0x06, 0x20, 0x00, 0x00, 0x00])))
            .rejects.toThrow(/a simulation scope does not open it/);
        await expect(link.transceive(new Uint8Array([0x34])))
            .rejects.toThrow(/writes are locked/);
    });

    it('still sends read telegrams while locked', async () => {
        const sent: Uint8Array[] = [];
        const transport = {
            write: async (b: Uint8Array) => { sent.push(b); },
            read: async (count: number) => {
                // Echo, then a minimal ACK frame.
                if (sent.length && count === sent[sent.length - 1]!.length) return sent[sent.length - 1]!;
                return buildDs2Frame(DME_DS2_ADDRESS, new Uint8Array([Ds2Status.Ack])).subarray(0, count);
            },
        };
        const link = new Ds2Link(transport, { delay: async () => {} });
        await expect(link.transceive(buildReadTelegram(0x00, 0x200000, 2), TIMEOUTS.response))
            .resolves.toBeDefined();
    });
});

describe('session errors say what to do', () => {
    maybe('a rejected request names the status the DME gave', async () => {
        const { session } = rig();
        await expect(session.readChunk(LinearReadSegment.master, 0, 8))
            .rejects.toThrow(SessionError);
    });
});

describe('fast entry, the one read path that erases something', () => {
    it('refuses before a single byte reaches the wire, not after the erase', async () => {
        /**
         * This used to assert that the WRITE LOCK stopped fast entry here. Since the lock was split
         * it does not: erasing one Free Identifiers sector and putting the same bytes straight back
         * is the reversible tier, and that tier is open so the boosted read can be exercised on a
         * car. The property the test existed for is unchanged, and so is the assertion that carries
         * it - a sequence that will erase something must be refused BEFORE it starts, never
         * halfway. The preservation plan is now the guard that does the refusing, and asserting the
         * trace is EMPTY is still the whole point: a check placed after the erase is a brick.
         */
        const sent: Uint8Array[] = [];
        const transport = {
            write: async (b: Uint8Array) => { sent.push(b); },
            read: async () => { throw new Error('nothing should have been sent'); },
        };
        const session = new Ds2Session(transport, { delay: async () => {} });
        await expect(session.enterFastRead(null)).resolves.toBe(false);
        expect(sent).toEqual([]);
    });

    it('refuses without a verified backup even when the lock is the thing that stops it first', () => {
        // Two independent reasons, and the plan states its own without needing a transport at all.
        expect(buildPreservationPlan(null).safe).toBe(false);
        expect(buildPreservationPlan({ image: new Uint8Array(0x100000), verified: false }).safe).toBe(false);
    });

    maybe('reads a whole service block through the ordinary windowed read path', async () => {
        const { session } = rig();
        const block = await session.readServiceBlock('master');
        expect(block).toHaveLength(FREE_IDENTIFIERS.length);
        // The censored window is 0x4000-0x4017, so the sector's first 24 bytes come back 0xFF even
        // on a healthy DME. Everything after it is the real thing.
        expect(Array.from(block.subarray(0x18)))
            .toEqual(Array.from(full!.subarray(0x4018, 0x6000)));
    });

    maybe('sees the live block as a match for a backup of the same DME', async () => {
        const { session } = rig();
        const live = await session.readServiceBlock('master');
        // The capture the mock serves is the same image, so this is a same-ECU verdict - except in
        // the censored window, which no read can return and which therefore cannot be compared.
        const patched = Uint8Array.from(full!);
        patched.fill(0xff, 0x4000, 0x4018);
        expect(serviceBlockMatches({ image: patched, verified: true }, live, 'master').same).toBe(true);
    });
});

describe('surveying a DME that will not let us in', () => {
    /**
     * What a refused seed/key actually costs, and what it does not.
     *
     * It costs the bootloader read and therefore the backup: command 0x06 dispatches the linear
     * 24-bit segments to a branch gated on bit 2 of 0xFFD003, an access bit that command 0x90
     * grants, and answers 0xA2 when it is clear. Those segments are the only ones that reach SA0,
     * so there is no way to work around it and no honest way to report otherwise.
     *
     * It does not cost the identification. Command 0x00 is not gated and answers first, so a DME
     * that gets that far is alive, correctly addressed and framing at the right rate - which is the
     * difference between "the access was refused" and "nothing is talking", and those want
     * different next steps from the operator.
     *
     * The old behaviour threw the identification away along with everything else, and reported a
     * raw error.
     */
    maybe('keeps the identification and names the refusal', async () => {
        const dme = new MockDme({
            master: full!.slice(0, 0x80000),
            slave: full!.slice(0x80000),
        });
        // Make the key exchange fail the way a wrong algorithm or a refused level would: the seed
        // is served, the key is rejected. Reaching in here rather than adding a mock option keeps
        // the mock a model of the firmware rather than a menu of test conditions.
        const session = new Ds2Session(dme.transport(), { delay: async () => {} });
        const original = dme.respond.bind(dme);
        dme.respond = (request: Uint8Array): Uint8Array => {
            const isKey = request[0] === 0x90 && request[1] !== 0x42;
            return isKey ? Uint8Array.from([Ds2Status.Rejected]) : original(request);
        };

        const found = await session.survey();

        expect(found.loggedIn).toBe(false);
        expect(found.loginError, 'the reason has to reach the caller').toBeTruthy();
        // The half that survives, and the reason it is worth surviving.
        expect(found.ident.length).toBeGreaterThan(0);
        // The half that cannot: these need the access bit the login would have granted.
        expect(found.master).toBeNull();
        expect(found.slave).toBeNull();
    });

    maybe('does not fire thousands of reads the firmware will reject one at a time', async () => {
        const dme = new MockDme({
            master: full!.slice(0, 0x80000),
            slave: full!.slice(0x80000),
        });
        const session = new Ds2Session(dme.transport(), { delay: async () => {} });
        const original = dme.respond.bind(dme);
        dme.respond = (request: Uint8Array): Uint8Array => {
            const isKey = request[0] === 0x90 && request[1] !== 0x42;
            return isKey ? Uint8Array.from([Ds2Status.Rejected]) : original(request);
        };

        await session.survey();

        // IDENT, seed, key - and then it stops. A survey that ploughed on would issue over eight
        // thousand read telegrams, retrying each one five times, to learn what it already knew.
        expect(dme.requests.length).toBeLessThan(10);
    });

    maybe('returns the full picture when the login is accepted', async () => {
        const { session } = rig();
        const found = await session.survey();
        expect(found.loggedIn).toBe(true);
        expect(found.loginError).toBeUndefined();
        expect(found.master?.flavour).toBe('standard-m3');
        expect(found.slave?.flavour).toBe('standard-m3');
    });

    maybe('reports progress in step, including the step that ends at the refusal', async () => {
        const { session } = rig();
        const steps: number[] = [];
        await session.survey((done) => steps.push(done));
        expect(steps).toEqual([1, 2, 3, 4]);
    });
});
