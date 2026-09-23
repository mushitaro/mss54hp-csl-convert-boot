/**
 * What fast entry is allowed to destroy, checked without a cable.
 *
 * The interesting assertions here are the refusals. This module's job is to decide whether an 8 KiB
 * erase of the sector holding a car's identity may go ahead, and the failure that matters is not a
 * crash - it is a plan that quietly omits a range and returns `safe: true`.
 */
import { describe, it, expect } from 'vitest';
import { READ_CHUNK_MAX } from './backupPlan';
import { readFileSync, existsSync } from 'node:fs';
import {
    FREE_IDENTIFIERS, SERVICE_BLOCK_DS2, FAST_ENTRY_NIBBLES, ServiceBlock, FAST_ENTRY_PREP_MARKER,
    FAST_READ_BAUD, DEVICE_TURNAROUND_MS,
    toDs2Address, serviceBlockImageRange, extractServiceBlock, computeNonErasedSpans, clipToWindow,
    mergeSpans, planBytes, identityText, buildPreservationPlan, serviceBlockMatches, estimateRead,
    chunkSpan, buildFastEntryEraseTelegram, buildFastEntryWriteTelegram,
    type Span, type VerifiedBackup,
} from './fastEntry';
import { HARDWARE_WRITE_ENABLED, WriteLockedError } from './writeLock';
import { assertDivisorTable } from './webUsbFtdiTransport';
import { eraseNibbleAllowed, ERASE_ALLOWED_NIBBLES } from './telegrams';
import { isProtectedImageOffset } from './imageLayout';

const STOCK_M3 = process.env.HW2001_BIN
    ?? String.raw`C:\Users\kazuh\MSS54-DS2-Tool-Public-1.2.1\hw2001-analysis\hw2001_full.bin`;
const haveImage = existsSync(STOCK_M3);
const full = haveImage ? new Uint8Array(readFileSync(STOCK_M3)) : undefined;
const maybe = haveImage ? it : it.skip;

/** A 1 MiB image whose two service blocks carry the given bytes and are 0xFF elsewhere. */
function imageWithServiceBlocks(master: Uint8Array, slave: Uint8Array): Uint8Array {
    const image = new Uint8Array(0x100000).fill(0xff);
    image.set(master, 0x4000);
    image.set(slave, 0x84000);
    return image;
}

function blockWith(entries: readonly (readonly [number, readonly number[]])[]): Uint8Array {
    const block = new Uint8Array(FREE_IDENTIFIERS.length).fill(0xff);
    for (const [offset, bytes] of entries) block.set(Uint8Array.from(bytes), offset);
    return block;
}

/**
 * The minimum a healthy DME carries: a flash counter, plus an identity record.
 *
 * The record is a packed byte run rather than an ASCII VIN, because that is what a real capture
 * holds - a fixture shaped like the convenient version would let a check that depends on the
 * convenient version pass.
 */
function healthyBlock(identity: readonly number[] = [0x20, 0x2d, 0xc2, 0xd5, 0x24, 0x20, 0x00, 0x01]): Uint8Array {
    return blockWith([
        [ServiceBlock.counterOffset, [0x00, 0xff, 0x00, 0xff]],
        [ServiceBlock.identityOffset, identity],
    ]);
}

function verified(image: Uint8Array): VerifiedBackup {
    return { image, verified: true };
}

describe('the sector fast entry erases', () => {
    it('is one 8 KiB erase block, and the smallest thing that trips programming mode', () => {
        expect(FREE_IDENTIFIERS.end - FREE_IDENTIFIERS.start).toBe(0x2000);
        expect(FREE_IDENTIFIERS.length).toBe(0x2000);
    });

    it('is a range imageLayout marks as never-erase, which is the whole tension here', () => {
        // Recorded deliberately. This is not a contradiction to fix by widening that rule: the
        // converter never erases it, and fast entry erases it only to put it straight back.
        expect(isProtectedImageOffset(FREE_IDENTIFIERS.start)).toBe(true);
        expect(isProtectedImageOffset(0x84000)).toBe(true);
    });

    it('sits at the DS2 nibbles the firmware accepts an erase for, which this tool otherwise does not', () => {
        expect(FAST_ENTRY_NIBBLES).toEqual([0x0, 0x8]);
        expect(SERVICE_BLOCK_DS2.master >>> 20).toBe(0x0);
        expect(SERVICE_BLOCK_DS2.slave >>> 20).toBe(0x8);
        // The narrow list stays narrow: authorising fast entry must not authorise the rest of the
        // package to erase a service block.
        for (const nibble of FAST_ENTRY_NIBBLES) {
            expect(ERASE_ALLOWED_NIBBLES).not.toContain(nibble);
            expect(eraseNibbleAllowed(nibble << 20)).toBe(false);
        }
    });

    it('maps sector offsets onto DS2 addresses that differ only by the processor base', () => {
        expect(toDs2Address('master', 0x4000)).toBe(0x000000);
        expect(toDs2Address('slave', 0x4000)).toBe(0x800000);
        expect(toDs2Address('master', 0x4000 + ServiceBlock.counterOffset)).toBe(0x000800);
        expect(toDs2Address('slave', 0x4000 + ServiceBlock.prepMarkerOffset)).toBe(0x800900);
        expect(() => toDs2Address('master', 0x6000)).toThrow(RangeError);
        expect(() => toDs2Address('master', 0x3fff)).toThrow(RangeError);
    });

    it('locates each processor block in a full image', () => {
        expect(serviceBlockImageRange('master')).toEqual({ start: 0x4000, end: 0x6000 });
        expect(serviceBlockImageRange('slave')).toEqual({ start: 0x84000, end: 0x86000 });
    });

    it('carries the prep marker the DME demands before it will permit the erase', () => {
        expect(Array.from(FAST_ENTRY_PREP_MARKER)).toEqual([0x50, 0x60, 0x70, 0x33]);
        // Not ASCII "K16." - that is the counter-clear marker at the same offset.
        expect(Array.from(FAST_ENTRY_PREP_MARKER)).not.toEqual([0x4b, 0x31, 0x36, 0x2e]);
    });
});

describe('finding what must survive', () => {
    it('reports each non-0xFF run as its own span, without merging across a gap', () => {
        const block = blockWith([[0x10, [1, 2, 3]], [0x20, [4, 5]]]);
        expect(computeNonErasedSpans(block, 'master')).toEqual([
            { processor: 'master', start: 0x4010, length: 3 },
            { processor: 'master', start: 0x4020, length: 2 },
        ]);
    });

    it('closes a run that reaches the end of the block', () => {
        const block = blockWith([[FREE_IDENTIFIERS.length - 2, [7, 8]]]);
        expect(computeNonErasedSpans(block, 'slave')).toEqual([
            { processor: 'slave', start: FREE_IDENTIFIERS.end - 2, length: 2 },
        ]);
    });

    it('treats a single 0xFF as a gap - it is data that decides, not convenience', () => {
        const block = blockWith([[0x10, [1, 0xff, 2]]]);
        expect(computeNonErasedSpans(block, 'master')).toHaveLength(2);
    });

    it('clips a span to the sector and drops one that misses it entirely', () => {
        expect(clipToWindow({ processor: 'master', start: 0x3f00, length: 0x200 }))
            .toEqual({ processor: 'master', start: 0x4000, length: 0x100 });
        expect(clipToWindow({ processor: 'master', start: 0x5f00, length: 0x400 }))
            .toEqual({ processor: 'master', start: 0x5f00, length: 0x100 });
        expect(clipToWindow({ processor: 'master', start: 0x7000, length: 0x10 })).toBeNull();
        expect(clipToWindow({ processor: 'master', start: 0x4000, length: 0 })).toBeNull();
    });

    it('coalesces touching and overlapping spans but keeps the processors apart', () => {
        const spans: Span[] = [
            { processor: 'slave', start: 0x4100, length: 0x10 },
            { processor: 'master', start: 0x4010, length: 0x10 },
            { processor: 'master', start: 0x4020, length: 0x10 }, // touches the one above
            { processor: 'master', start: 0x4025, length: 0x20 }, // overlaps it
        ];
        expect(mergeSpans(spans)).toEqual([
            { processor: 'master', start: 0x4010, length: 0x35 },
            { processor: 'slave', start: 0x4100, length: 0x10 },
        ]);
    });

    it('counts the bytes a plan will move', () => {
        expect(planBytes([
            { processor: 'master', start: 0x4000, length: 100 },
            { processor: 'slave', start: 0x4000, length: 56 },
        ])).toBe(156);
    });
});

describe('the plan, and the refusals that matter more', () => {
    it('refuses without a backup, because there would be nothing to restore from', () => {
        const plan = buildPreservationPlan(null);
        expect(plan.safe).toBe(false);
        expect(plan.safe === false && plan.reason).toMatch(/no verified backup/);
    });

    it('refuses an unverified backup - one pass that dropped a chunk still looks plausible', () => {
        const image = imageWithServiceBlocks(healthyBlock(), healthyBlock());
        const plan = buildPreservationPlan({ image, verified: false });
        expect(plan.safe).toBe(false);
        expect(plan.safe === false && plan.reason).toMatch(/second pass/);
    });

    it('refuses a short backup', () => {
        const plan = buildPreservationPlan(verified(new Uint8Array(0x80000)));
        expect(plan.safe).toBe(false);
        expect(plan.safe === false && plan.reason).toMatch(/1 MiB/);
    });

    it('refuses a backup whose service block is blank, on either processor', () => {
        const blank = new Uint8Array(FREE_IDENTIFIERS.length).fill(0xff);
        const masterBlank = buildPreservationPlan(verified(imageWithServiceBlocks(blank, healthyBlock())));
        expect(masterBlank.safe).toBe(false);
        expect(masterBlank.safe === false && masterBlank.reason).toMatch(/master service block is entirely blank/);

        const slaveBlank = buildPreservationPlan(verified(imageWithServiceBlocks(healthyBlock(), blank)));
        expect(slaveBlank.safe).toBe(false);
        expect(slaveBlank.safe === false && slaveBlank.reason).toMatch(/slave service block is entirely blank/);
    });

    it('always preserves the flash counter and boot handoff vector, map or no map', () => {
        // A block whose ONLY non-blank bytes are far from the counter. If the plan came from the
        // map alone, the counter would be erased and the bootloader would have nowhere to jump.
        const odd = blockWith([[0x1500, [1, 2, 3, 4]]]);
        const plan = buildPreservationPlan(verified(imageWithServiceBlocks(odd, odd)));
        expect(plan.safe).toBe(true);
        if (!plan.safe) return;

        for (const processor of ['master', 'slave'] as const) {
            const counter = FREE_IDENTIFIERS.start + ServiceBlock.counterOffset;
            const vector = FREE_IDENTIFIERS.start + ServiceBlock.bootHandoffVectorOffset;
            const covers = (address: number): boolean => plan.spans.some((s) =>
                s.processor === processor && address >= s.start && address < s.start + s.length);
            expect(covers(counter)).toBe(true);
            expect(covers(counter + ServiceBlock.counterLength - 1)).toBe(true);
            expect(covers(vector)).toBe(true);
            expect(covers(vector + 3)).toBe(true);
        }
    });

    it('covers every non-blank byte of both blocks - a missed one is an ECU that will not boot', () => {
        const master = blockWith([[0x10, [1, 2]], [0x900, [0x50, 0x60, 0x70, 0x33]], [0x1d50, [0x57, 0x42]]]);
        const slave = blockWith([[0x40, [9]], [0x1fff, [3]]]);
        const plan = buildPreservationPlan(verified(imageWithServiceBlocks(master, slave)));
        expect(plan.safe).toBe(true);
        if (!plan.safe) return;

        for (const [processor, block] of [['master', master], ['slave', slave]] as const) {
            for (let i = 0; i < block.length; i++) {
                if (block[i] === 0xff) continue;
                const address = FREE_IDENTIFIERS.start + i;
                const covered = plan.spans.some((s) =>
                    s.processor === processor && address >= s.start && address < s.start + s.length);
                expect(covered, `${processor} 0x${address.toString(16)} is not preserved`).toBe(true);
            }
        }
    });

    it('produces spans entirely inside the sector, so nothing else can be written back', () => {
        const plan = buildPreservationPlan(verified(imageWithServiceBlocks(healthyBlock(), healthyBlock())));
        expect(plan.safe).toBe(true);
        if (!plan.safe) return;
        for (const span of plan.spans) {
            expect(span.start).toBeGreaterThanOrEqual(FREE_IDENTIFIERS.start);
            expect(span.start + span.length).toBeLessThanOrEqual(FREE_IDENTIFIERS.end);
        }
    });

    it('names its sources, so an operator can see what the plan was built from', () => {
        const plan = buildPreservationPlan(verified(imageWithServiceBlocks(healthyBlock(), healthyBlock())));
        expect(plan.safe).toBe(true);
        if (!plan.safe) return;
        expect(plan.sources.join(' ')).toMatch(/master non-0xFF map/);
        expect(plan.sources.join(' ')).toMatch(/slave non-0xFF map/);
        expect(plan.sources.join(' ')).toMatch(/flash counter \+ boot handoff vector/);
    });
});

describe('proving the backup is a current copy of this ECU', () => {
    it('matches when the live block is byte-identical to the stored one', () => {
        const block = healthyBlock();
        const result = serviceBlockMatches(verified(imageWithServiceBlocks(block, block)), block, 'master');
        expect(result.same).toBe(true);
        expect(result.differingOffsets).toEqual([]);
    });

    it('refuses a block from a different ECU, and says where it diverged', () => {
        const mine = healthyBlock();
        const theirs = healthyBlock();
        theirs[ServiceBlock.identityOffset + 4] = 0x5a;
        const result = serviceBlockMatches(verified(imageWithServiceBlocks(mine, mine)), theirs, 'master');
        expect(result.same).toBe(false);
        expect(result.differingOffsets).toContain(FREE_IDENTIFIERS.start + ServiceBlock.identityOffset + 4);
        expect(result.reason).toMatch(/another ECU, or it is out of date/);
    });

    it('ignores the flash counter, which legitimately advances between sessions', () => {
        const stored = healthyBlock();
        const live = healthyBlock();
        // A programming session has been consumed since the backup was taken.
        live[ServiceBlock.counterOffset + 4] = 0x00;
        live[ServiceBlock.counterOffset + 5] = 0xff;
        const result = serviceBlockMatches(verified(imageWithServiceBlocks(stored, stored)), live, 'master');
        expect(result.same).toBe(true);
    });

    it('needs no field to be decoded, which is why a guessed VIN offset is not used', () => {
        // The same check on a capture whose identity area is a packed record with no readable VIN.
        if (!haveImage) return;
        const live = Uint8Array.from(extractServiceBlock(full!, 'master'));
        expect(serviceBlockMatches(verified(full!), live, 'master').same).toBe(true);
        live[ServiceBlock.identityOffset] = (live[ServiceBlock.identityOffset] ?? 0) ^ 0xff;
        expect(serviceBlockMatches(verified(full!), live, 'master').same).toBe(false);
    });

    it('refuses a live read of the wrong length rather than comparing a prefix', () => {
        const block = healthyBlock();
        const result = serviceBlockMatches(
            verified(imageWithServiceBlocks(block, block)), block.subarray(0, 0x100), 'master');
        expect(result.same).toBe(false);
        expect(result.reason).toMatch(/not the 8192/);
    });

    maybe('shows whatever text the identity record actually carries, and calls it nothing more', () => {
        const text = identityText(extractServiceBlock(full!, 'master'));
        // Deliberately no shape assertion: on this capture the readable part is a digit run, and a
        // test demanding a VIN here would be asserting the label rather than the bytes.
        expect(typeof text).toBe('string');
    });
});

describe('against a real capture', () => {
    maybe('plans from a genuine service block and preserves every byte of it', () => {
        const plan = buildPreservationPlan(verified(full!));
        expect(plan.safe).toBe(true);
        if (!plan.safe) return;

        for (const processor of ['master', 'slave'] as const) {
            const block = extractServiceBlock(full!, processor);
            for (let i = 0; i < block.length; i++) {
                if (block[i] === 0xff) continue;
                const address = FREE_IDENTIFIERS.start + i;
                expect(plan.spans.some((s) =>
                    s.processor === processor && address >= s.start && address < s.start + s.length)).toBe(true);
            }
        }
    });

    maybe('moves far less than the 16 KiB both blocks occupy, which is the point', () => {
        const plan = buildPreservationPlan(verified(full!));
        expect(plan.safe).toBe(true);
        if (!plan.safe) return;
        expect(planBytes(plan.spans)).toBeLessThan(2 * FREE_IDENTIFIERS.length);
        expect(planBytes(plan.spans)).toBeGreaterThan(0);
    });
});

describe('what the boost is actually worth', () => {
    it('estimates the read the code actually performs, not the protocol maximum', () => {
        // The default chunk used to be 0xfe - the protocol ceiling, which no plan sends - so every
        // estimate counted 4129 exchanges where 8595 happen and quoted a little over half the real
        // time. This asserts the exchange count against the plan's own constant so the two cannot
        // drift apart again; the seconds follow from it.
        const slow = estimateRead(0x100000, 9600);
        const fast = estimateRead(0x100000, FAST_READ_BAUD);
        expect(slow.exchanges).toBe(Math.ceil(0x100000 / READ_CHUNK_MAX));
        expect(slow.exchanges).toBe(fast.exchanges);
        expect(slow.seconds).toBeGreaterThan(30 * 60);   // 31.2 min for one pass
        expect(fast.seconds).toBeGreaterThan(9 * 60);    //  9.4 min - minutes, but not few
        expect(fast.seconds).toBeLessThan(10 * 60);
    });

    it('does not claim a 13x speedup, because the DME s own turnaround does not move', () => {
        // The honest number. 9600 -> 125000 is 13x on the wire, and the measured floor underneath
        // it is ~53 ms per chunk of the ECU thinking. Promising 13x would be promising something
        // no line rate can deliver.
        const slow = estimateRead(0x100000, 9600).seconds;
        const fast = estimateRead(0x100000, FAST_READ_BAUD).seconds;
        expect(slow / fast).toBeLessThan(13);
        expect(slow / fast).toBeGreaterThan(3);
        expect(DEVICE_TURNAROUND_MS).toBe(53);
    });

    it('is not worth an 8 KiB erase for a small read', () => {
        // A bootloader sector is 16 KiB. Saving under a minute is not worth a programming session
        // and a flash-counter slot, and the UI should not offer it as if it were.
        const saved = estimateRead(0x4000, 9600).seconds - estimateRead(0x4000, FAST_READ_BAUD).seconds;
        expect(saved).toBeLessThan(60);
    });
});

describe('the write lock, on the one path authorised to erase a service block', () => {
    /**
     * These two used to assert a refusal, and the change that made them assert the opposite is the
     * point rather than a regression: erasing a service block and putting it straight back is the
     * *reversible* tier, and it is open so the boosted read can be exercised on a car. Arming is
     * not, and `HARDWARE_WRITE_ENABLED` below is the switch that still governs it.
     *
     * What keeps this from being a hole is that neither builder can be pointed anywhere else -
     * `toDs2Address` is checked two tests down, and `tierForAddress` is checked exhaustively in
     * `writeTier.test.ts`.
     */
    it('builds the erase, because the sector it erases is recoverable', () => {
        expect(HARDWARE_WRITE_ENABLED, 'arming is still locked').toBe(false);
        expect(buildFastEntryEraseTelegram('master')[0]).toBe(0x07);
        expect(buildFastEntryEraseTelegram('slave')[0]).toBe(0x07);
    });

    it('builds the restore write, which is what makes the erase recoverable', () => {
        expect(buildFastEntryWriteTelegram('master', 0x4000, new Uint8Array(2))).toHaveLength(7);
    });

    it('would still refuse an address outside the sector even unlocked', () => {
        // The address check is not a nibble list: it is `toDs2Address`, which cannot express the
        // bootloader, the calibration or the program area at all.
        expect(() => toDs2Address('master', 0x8000)).toThrow(RangeError);
        expect(() => toDs2Address('master', 0x0000)).toThrow(RangeError);
    });
});

describe('splitting a span into telegrams', () => {
    it('never exceeds the write chunk cap and keeps every chunk even', () => {
        const chunks = chunkSpan({ processor: 'master', start: 0x4000, length: 300 });
        expect(chunks).toEqual([
            { start: 0x4000, length: 122 },
            { start: 0x407a, length: 122 },
            { start: 0x40f4, length: 56 },
        ]);
        for (const c of chunks) {
            expect(c.length % 2).toBe(0);
            expect(c.start % 2).toBe(0);
            expect(c.length).toBeLessThanOrEqual(122);
        }
    });

    it('backs an odd start onto an even address, because flash programs in words', () => {
        const [first] = chunkSpan({ processor: 'master', start: 0x4001, length: 3 });
        expect(first).toEqual({ start: 0x4000, length: 4 });
    });

    it('rounds an odd tail up rather than emitting an odd-length telegram', () => {
        const chunks = chunkSpan({ processor: 'slave', start: 0x4010, length: 5 });
        expect(chunks).toEqual([{ start: 0x4010, length: 6 }]);
    });

    it('covers every byte of the span it was given', () => {
        for (const [start, length] of [[0x4000, 1], [0x4001, 1], [0x4123, 500], [0x5fff, 1]] as const) {
            const chunks = chunkSpan({ processor: 'master', start, length });
            const covered = (a: number): boolean =>
                chunks.some((c) => a >= c.start && a < c.start + c.length);
            for (let a = start; a < start + length; a++) expect(covered(a)).toBe(true);
        }
    });
});

describe('the FTDI divisor table', () => {
    it('recomputes to the audited constants, at module load and again here', () => {
        expect(() => assertDivisorTable()).not.toThrow();
    });

    it('encodes 125000 exactly, which is the rate all of this exists to reach', () => {
        // A fractional-divisor error here is a garbled write to an ECU, not a slow link.
        expect(24_000_000 / FAST_READ_BAUD).toBe(192);
        expect(192 % 8).toBe(0);
    });
});
