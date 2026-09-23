/**
 * The two write tiers, and the line between them.
 *
 * ## Why there are two
 *
 * One switch used to cover both halves of "writing". That meant the only way to exercise the write
 * path on a real car - FAST ENTRY, which erases one 8 KiB sector and puts the same bytes straight
 * back, and which the reference tool has done on real cars more than twenty times - was to also
 * authorise programming the magic at 0xFFFC, which is the point of no return and has no rehearsal.
 * Two operations, consequences orders of magnitude apart, one gate.
 *
 * ## What these tests are actually protecting
 *
 * Splitting a safety gate is the kind of change that makes a tool less safe while looking like it
 * made it more configurable. The property that keeps it honest is that **the tier is derived from
 * the DS2 address**, never passed in: a caller cannot label an arming telegram reversible, because
 * nothing asks it to. So what is checked here is the derivation, at its edges, and by exhaustion -
 * and that the irreversible half is still shut.
 */
import { describe, it, expect } from 'vitest';
import {
    tierForAddress, tierEnabled, assertWriteUnlocked, WriteLockedError,
    HARDWARE_WRITE_ENABLED, FAST_ENTRY_WRITE_ENABLED,
} from './writeLock';
import {
    SERVICE_BLOCK_DS2, FREE_IDENTIFIERS, RECYCLE_ONLY_ADDRESS, RECYCLE_OFF_ADDRESS,
    buildFastEntryEraseTelegram, buildFastEntryWriteTelegram,
} from './fastEntry';
import { STAGING_DS2_ADDRESS, buildProbeSector, buildStagedSector } from './blLoader';
import { buildJumpTelegram } from './telegrams';
import { Ds2Link } from './transport';

const PROCESSORS = ['master', 'slave'] as const;

describe('which addresses are recoverable', () => {
    /**
     * `writeLock.ts` cannot import these - `telegrams.ts` needs `tierForAddress` and `fastEntry.ts`
     * imports `telegrams.ts` - so it mirrors the numbers. This is the test that stops the mirror
     * from drifting: move the sector or change its length on either side and the window stops
     * lining up here, rather than quietly widening what counts as reversible.
     */
    it.each(PROCESSORS)('covers exactly the %s Free Identifiers sector', (processor) => {
        const base = SERVICE_BLOCK_DS2[processor];
        expect(tierForAddress(base)).toBe('reversible');
        expect(tierForAddress(base + FREE_IDENTIFIERS.length - 1)).toBe('reversible');
        expect(tierForAddress(base + FREE_IDENTIFIERS.length)).toBe('irreversible');
        if (base > 0) expect(tierForAddress(base - 1)).toBe('irreversible');
    });

    it.each(PROCESSORS)('does not cover the %s staging area, which is where arming happens', (p) => {
        // 0x200000 / 0xA00000: the sector a loader and the magic are staged into. If this ever came
        // back reversible, the split would have re-opened the exact gate it exists to keep shut.
        expect(tierForAddress(STAGING_DS2_ADDRESS[p])).toBe('irreversible');
        expect(tierForAddress(STAGING_DS2_ADDRESS[p] + 0x7ffc)).toBe('irreversible');
    });

    it('admits the two fast-entry control addresses by value, not by range', () => {
        expect(tierForAddress(RECYCLE_ONLY_ADDRESS)).toBe('reversible');
        expect(tierForAddress(RECYCLE_OFF_ADDRESS)).toBe('reversible');
        // Neighbours are not. An interval here would be something a later change could grow into.
        expect(tierForAddress(RECYCLE_ONLY_ADDRESS - 1)).toBe('irreversible');
        expect(tierForAddress(RECYCLE_OFF_ADDRESS + 1)).toBe('irreversible');
    });

    it('calls nothing else in the whole 24-bit space reversible', () => {
        // Exhaustive rather than sampled, because "which addresses did we accidentally let
        // through" is a question with 16.7 million answers and no interesting middle ground.
        let reversible = 0;
        for (let a = 0; a <= 0xffffff; a++) if (tierForAddress(a) === 'reversible') reversible++;
        expect(reversible).toBe(2 * FREE_IDENTIFIERS.length + 2);
    });
});

describe('what each tier is allowed to do on this build', () => {
    it('has the irreversible tier shut', () => {
        // The standing constraint. If this ever fails, the build can arm a real ECU.
        expect(HARDWARE_WRITE_ENABLED).toBe(false);
        expect(tierEnabled('irreversible')).toBe(false);
    });

    it('has the reversible tier open, which is the point of the split', () => {
        expect(FAST_ENTRY_WRITE_ENABLED).toBe(true);
        expect(tierEnabled('reversible')).toBe(true);
    });

    it.each(PROCESSORS)('builds fast-entry telegrams for the %s', (processor) => {
        const erase = buildFastEntryEraseTelegram(processor);
        expect(erase[0]).toBe(0x07);
        const write = buildFastEntryWriteTelegram(processor, FREE_IDENTIFIERS.start, new Uint8Array([1, 2]));
        expect(write.length).toBe(7);
    });

    it('still refuses to build a probe sector', () => {
        // The probe is the smallest thing that arms - and arming is the whole of what is locked.
        // Loader bytes are a placeholder: the gate is the first statement in the function.
        expect(() => buildProbeSector('master', new Uint8Array(16))).toThrow(WriteLockedError);
    });

    it('still refuses to build a replacement sector', () => {
        expect(() => buildStagedSector('master', new Uint8Array(16), new Uint8Array(0x4000)))
            .toThrow(WriteLockedError);
    });

    it('still refuses the staged-loader transfer', () => {
        expect(() => buildJumpTelegram()).toThrow(WriteLockedError);
    });

    it('treats a telegram too short to carry an address as irreversible', async () => {
        // Reading a missing byte as zero would classify a truncated `07 ..` as DS2 0x000000 - the
        // master Free Identifiers sector, and the most permissive answer available. Found by a
        // test that kept passing for the wrong reason after the split.
        const sent: Uint8Array[] = [];
        const link = new Ds2Link(
            { write: async (b: Uint8Array) => { sent.push(b); }, read: async () => new Uint8Array() },
            { delay: async () => {} });
        await expect(link.transceive(new Uint8Array([0x07, 0x00])))
            .rejects.toThrow(/writes are locked/);
        expect(sent).toEqual([]);
    });

    it('defaults an unlabelled call to the locked tier', () => {
        // The direction that matters: a call site nobody updated stays at the strictest tier, so
        // widening is something a person has to write down rather than something they can forget.
        expect(() => assertWriteUnlocked('something new')).toThrow(WriteLockedError);
        expect(() => assertWriteUnlocked('something new', 'reversible')).not.toThrow();
    });
});
