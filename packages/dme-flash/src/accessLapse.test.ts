/**
 * Refreshing the access level before a bulk read.
 *
 * ## The session this came from
 *
 * On a car: IDENT logged in, read both SA0 sectors, reported them correctly. The operator tapped
 * BACKUP a minute later and the very first chunk came back
 *
 *     read 122 bytes at 0x0: DME answered REJECTED (0xA2 - session or access level)
 *
 * The same address, the same segment and the same chunk size that had worked sixty seconds earlier.
 * What changed was time: the linear 24-bit read segments are gated on an access bit that command
 * 0x90 grants, and the DME lets it lapse while nothing is asking it for anything - which is exactly
 * the gap between an identification finishing and a person deciding to start an hour-long read.
 *
 * The reference tuner opens every bulk operation with its own `login()`: the bulk read, the write,
 * the flash-counter reset and the service-block restore. This port logged in once during
 * identification and never again.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { Ds2Session } from './session';
import { MockDme } from './mockDme';
import { Command } from './telegrams';
import { FULL_IMAGE_LENGTH } from './imageLayout';

const STOCK = process.env.HW2001_BIN
    ?? String.raw`C:\Users\kazuh\MSS54-DS2-Tool-Public-1.2.1\hw2001-analysis\hw2001_full.bin`;
const haveImage = existsSync(STOCK);
const full = haveImage ? new Uint8Array(readFileSync(STOCK)) : undefined;
const maybe = haveImage ? it : it.skip;

/**
 * A DME that drops its access level the moment nobody is asking, which is what a real one does.
 *
 * Modelled by revoking on any gap the test declares rather than on a clock: what matters is the
 * behaviour - reads are refused until 0x90 is sent again - and a timer would make the test slow and
 * flaky for no extra fidelity.
 */
function lapsingDme() {
    const dme = new MockDme({ master: full!.slice(0, 0x80000), slave: full!.slice(0x80000) });
    return {
        dme,
        /** What the operator's thinking time does to the ECU. */
        lapse: () => { dme.unlocked = false; },
    };
}

describe('a DME that has let the access level lapse', () => {
    maybe('refuses the linear read, which is the failure seen on the car', async () => {
        // The control: without a refresh, this is exactly the 0xA2 the session reported.
        const { dme, lapse } = lapsingDme();
        const session = new Ds2Session(dme.transport(), { delay: async () => {} });
        await session.login();
        lapse();

        await expect(session.readChunk(0x05, 0x0, 122)).rejects.toThrow(/REJECTED|0xa2/i);
    });

    maybe('is refreshed by fullBackup before the first chunk goes out', async () => {
        const { dme, lapse } = lapsingDme();
        const session = new Ds2Session(dme.transport(), { delay: async () => {} });

        // Everything IDENT does, then the operator thinking about it.
        await session.login();
        await session.readBootloader('master');
        lapse();

        const backup = await session.fullBackup();
        expect(backup.image.length).toBe(FULL_IMAGE_LENGTH);
        expect(backup.verified).toBe(true);
    }, 120_000);

    maybe('is refreshed by ensureAccess, which the file-compare path uses', async () => {
        const { dme, lapse } = lapsingDme();
        const session = new Ds2Session(dme.transport(), { delay: async () => {} });
        await session.login();
        lapse();

        await session.ensureAccess();
        const bytes = await session.readChunk(0x05, 0x0, 122);
        expect(bytes.length).toBe(122);
    });

    maybe('can be told to skip the refresh, for the one caller that just logged in', async () => {
        /**
         * The boosted re-capture: log in, run fast entry, then read on at 125000. The reference
         * tool does exactly that and never sends 0x90 after the switch, so neither does this - the
         * access level cannot have lapsed across minutes of authenticated exchanges, and inventing
         * a login at a boosted rate on a path where the service block has already been erased and
         * restored is not a thing to find out about on a car.
         */
        const { dme } = lapsingDme();
        const session = new Ds2Session(dme.transport(), { delay: async () => {} });
        await session.login();

        const before = dme.requests.filter((r) => r[0] === Command.Login).length;
        const backup = await session.fullBackup(undefined, { refreshAccess: false });
        const after = dme.requests.filter((r) => r[0] === Command.Login).length;

        expect(backup.image.length).toBe(FULL_IMAGE_LENGTH);
        expect(after - before, 'no 0x90 went out').toBe(0);
    }, 120_000);

    maybe('sends 0x90 again rather than assuming the first one still holds', async () => {
        // Named separately because the observable behaviour above could also be produced by a mock
        // that never really lapsed. This checks the telegram itself went out a second time.
        const { dme, lapse } = lapsingDme();
        const session = new Ds2Session(dme.transport(), { delay: async () => {} });
        await session.login();
        lapse();

        const before = dme.requests.filter((r) => r[0] === Command.Login).length;
        await session.ensureAccess();
        const after = dme.requests.filter((r) => r[0] === Command.Login).length;
        // Seed request and key response: two telegrams per login.
        expect(after - before).toBe(2);
    });
});
