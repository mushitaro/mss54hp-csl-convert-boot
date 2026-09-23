/**
 * FAST ENTRY - how a DS2 link gets to 125000 baud, and what it costs.
 *
 * ## The mechanism
 *
 * The DME accepts a baud switch (command 0x91) only from **inside a programming session**, and its
 * bootloader offers no way into one except through a valid flash erase. karter16's observation
 * (journal #385, and the basis of the reference tuner's implementation) is that it does not have to
 * be an erase of anything you care about: the Free Identifiers sector is exactly one 8 KiB erase
 * block - the smallest thing on the device that will trip the mode - so you can erase THAT, put its
 * contents straight back, and then run the bulk transfer thirteen times faster.
 *
 * 1 MiB at 9600 is about half an hour. At 125000 it is a few minutes.
 *
 * ## Why this module is stricter than the tuner's
 *
 * The sector it erases is the one this project exists to protect. `imageLayout.ts` lists
 * 0x4000-0x7FFF as a range the converter must never erase or write, because it holds the VIN, the
 * AIF service history, the flash counter and the application entry vector - and, uniquely, because
 * **no distributable image contains it.** Every published full binary has it blanked. If it is lost
 * there is nothing to restore it from except a capture of this specific car.
 *
 * That produces a rule the reference does not need and this project cannot do without:
 *
 * > **The first full backup is never boosted.** Erasing the sector that a backup exists to capture,
 * > in order to take that backup faster, is circular. `Ds2Session.fullBackup` therefore has no
 * > boost option at all - not a flag defaulting to off, no option - and fast entry becomes
 * > available only once a verified two-pass capture of this ECU exists to restore from.
 *
 * The 8 KiB erase is also not free in a second currency: the flash counter has ~30 slots per
 * processor and this consumes a programming session. Fast entry is worth it for a 1 MiB read, and
 * is not worth it for a 200-byte one.
 *
 * ## What the risk actually is, and where it sits
 *
 * The phases below are ordered so that the dangerous window is as short as it can be:
 *
 *   1. **Reversible** - read the spans to preserve, live. Nothing has changed on the ECU.
 *   2. **Destructive** - prep marker, erase, restore, verify byte for byte. From the erase onward a
 *      failure means the sector is not intact and the operator has to be told immediately.
 *   3. **Free** - close the session, then switch baud. By this point the sector is back and
 *      *proven* back, so a refused or silent switch costs the speed and nothing else.
 *
 * That last ordering is what makes this the safer of the two boosts despite erasing more. On a
 * write path the switch necessarily happens with the target area already erased.
 *
 * Everything in this file is pure: no transport, no clock, no I/O. This module decides what is
 * allowed to be destroyed on someone's ECU, and that decision deserves to be checkable without a
 * cable in the loop.
 */
import type { Processor } from './imageLayout';
import { READ_CHUNK_MAX } from './backupPlan';
import { Command } from './telegrams';
import { Segment, WRITE_CHUNK_MAX } from './regionMap';
import { assertWriteUnlocked } from './writeLock';

/** The Free Identifiers sector in per-processor coordinates - one Am29F400 8 KiB erase block. */
export const FREE_IDENTIFIERS = { start: 0x4000, end: 0x6000, length: 0x2000 } as const;

/**
 * DS2 base address of the sector on each processor.
 *
 * `(nibble << 20) | offset`, Free Identifiers being nibble 0 with the slave adding 8. The offset
 * within the sector is the same on both.
 */
export const SERVICE_BLOCK_DS2: Readonly<Record<Processor, number>> = {
    master: 0x000000,
    slave: 0x800000,
} as const;

/**
 * Nibbles fast entry is permitted to erase, kept **separate** from the general
 * `ERASE_ALLOWED_NIBBLES` in `telegrams.ts` rather than merged into it.
 *
 * The firmware's own allowlist accepts these (erase handler 0x2516/0x2590 takes 0x00 and 0x80), so
 * the general list being narrower is a tool policy, not a firmware fact. Widening that list would
 * silently authorise every erase path in the package to touch the service block. This constant
 * authorises exactly one caller.
 */
export const FAST_ENTRY_NIBBLES: readonly number[] = [0x0, 0x8] as const;

/** Offsets inside the sector, from the reference implementation and the 0401 disassembly. */
export const ServiceBlock = {
    /** The flash counter: 256 bytes of 2-byte big-endian markers. */
    counterOffset: 0x800,
    counterLength: 256,
    /**
     * The boot-handoff vector, 0x84 into the counter block.
     *
     * `if (*aif_entry == 0xf500 || *aif_entry == 0xf5) { (*DAT_00004884)(); }` - consulted when the
     * counter's marker says a programming session is open. Lose it and the bootloader has nowhere
     * to jump. This is why the whole 256 bytes are preserved unconditionally rather than because
     * some map said they were non-blank.
     */
    bootHandoffVectorOffset: 0x884,
    /** Where the marker that permits this erase is written. */
    prepMarkerOffset: 0x900,
    /**
     * The identity record area, at full-image 0x5D50.
     *
     * Named for where it starts rather than for what it contains, because what it contains is a
     * structured record and not a 13-byte ASCII VIN: on a real capture this run holds packed
     * part-number and identity fields with only fragments of printable text. Community notes
     * describe it as "VIN at 0x5D50"; the bytes say the VIN is a field *within* a record there.
     * Nothing in this module depends on decoding it - see `serviceBlockMatches`.
     */
    identityOffset: 0x1d50,
    identityLength: 0x40,
    /** Known slots per processor. One programming session consumes one. */
    flashCounterSlots: 30,
} as const;

/**
 * `50 60 70 33` - the marker the DME wants at `prepMarkerOffset` before it will permit this erase.
 *
 * Not to be confused with ASCII `K16.` at the same offset, which prepares a counter *clear*. Same
 * address, different payload, different operation.
 *
 * Written only when those four bytes are still erased: a DME that has had fast entry run before
 * already carries it, and programming an already-programmed cell is what the verify byte rejects.
 */
export const FAST_ENTRY_PREP_MARKER = new Uint8Array([0x50, 0x60, 0x70, 0x33]);

/** The rate fast entry exists to reach. The other two the ECU implements need no erase to select. */
export const FAST_READ_BAUD = 125000;

/** A run of bytes on one processor, in per-processor image coordinates. */
export interface Span {
    readonly processor: Processor;
    readonly start: number;
    readonly length: number;
}

export type PreservationPlan =
    | { readonly safe: true; readonly spans: readonly Span[]; readonly sources: readonly string[] }
    | { readonly safe: false; readonly reason: string };

/** DS2 address for a per-processor image address inside the sector. */
export function toDs2Address(processor: Processor, imageAddress: number): number {
    const offset = imageAddress - FREE_IDENTIFIERS.start;
    if (offset < 0 || offset >= FREE_IDENTIFIERS.length) {
        throw new RangeError(
            `fast-entry address 0x${imageAddress.toString(16)} is outside `
            + `0x${FREE_IDENTIFIERS.start.toString(16)}-0x${(FREE_IDENTIFIERS.end - 1).toString(16)}`);
    }
    return SERVICE_BLOCK_DS2[processor] + offset;
}

/** Where a processor's service block sits inside a 1 MiB full image. */
export function serviceBlockImageRange(processor: Processor): { start: number; end: number } {
    const base = processor === 'master' ? 0 : 0x80000;
    return { start: base + FREE_IDENTIFIERS.start, end: base + FREE_IDENTIFIERS.end };
}

/** Extract one processor's 8 KiB service block from a 1 MiB capture. */
export function extractServiceBlock(image: Uint8Array, processor: Processor): Uint8Array {
    const { start, end } = serviceBlockImageRange(processor);
    if (image.length < end) {
        throw new RangeError(`image is ${image.length} bytes; a full capture is 0x100000`);
    }
    return image.subarray(start, end);
}

/**
 * Byte-granular runs of non-0xFF in one processor's 8 KiB block.
 *
 * No gap tolerance: two runs separated by a single 0xFF stay separate here, and are merged later
 * only if they actually touch. Merging across gaps is a size/round-trip trade, and the place to
 * make that trade is not the place that decides what counts as data.
 */
export function computeNonErasedSpans(block: Uint8Array, processor: Processor): Span[] {
    const spans: Span[] = [];
    let start = -1;
    for (let i = 0; i < block.length; i++) {
        const erased = block[i] === 0xff;
        if (!erased && start < 0) start = i;
        else if (erased && start >= 0) {
            spans.push({ processor, start: FREE_IDENTIFIERS.start + start, length: i - start });
            start = -1;
        }
    }
    if (start >= 0) {
        spans.push({ processor, start: FREE_IDENTIFIERS.start + start, length: block.length - start });
    }
    return spans;
}

/** Clip a span to the sector, or drop it entirely. */
export function clipToWindow(span: Span): Span | null {
    if (span.length <= 0) return null;
    const start = Math.max(span.start, FREE_IDENTIFIERS.start);
    const end = Math.min(span.start + span.length, FREE_IDENTIFIERS.end);
    return start >= end ? null : { processor: span.processor, start, length: end - start };
}

/** Sort and coalesce touching or overlapping spans, per processor. Adjacency only. */
export function mergeSpans(spans: readonly Span[]): Span[] {
    if (spans.length === 0) return [];
    const sorted = [...spans].sort((a, b) =>
        a.processor === b.processor ? a.start - b.start : (a.processor === 'master' ? -1 : 1));
    const first = sorted[0]!;
    const out: Span[] = [];
    let current = { ...first };
    for (let i = 1; i < sorted.length; i++) {
        const next = sorted[i]!;
        const currentEnd = current.start + current.length;
        if (next.processor === current.processor && next.start <= currentEnd) {
            current.length = Math.max(currentEnd, next.start + next.length) - current.start;
        } else {
            out.push(current);
            current = { ...next };
        }
    }
    out.push(current);
    return out;
}

/** Bytes a plan will read live and write back - what decides whether entry costs seconds or a minute. */
export function planBytes(spans: readonly Span[]): number {
    return spans.reduce((n, s) => n + s.length, 0);
}

/**
 * Printable fragments of the identity record, **for display only**.
 *
 * Deliberately not called `vin()`. On a real capture this area is a packed record and the only
 * readable part is a short digit run; presenting that as "the VIN" would be a label making a
 * promise the bytes do not keep. Nothing safety-relevant reads this - the same-ECU proof is a byte
 * comparison (`serviceBlockMatches`), which needs no field to be decoded correctly.
 */
export function identityText(block: Uint8Array): string {
    const raw = block.subarray(ServiceBlock.identityOffset, ServiceBlock.identityOffset + ServiceBlock.identityLength);
    const parts: string[] = [];
    let current = '';
    for (const byte of raw) {
        if (byte >= 0x20 && byte < 0x7f) current += String.fromCharCode(byte);
        else { if (current.length >= 3) parts.push(current); current = ''; }
    }
    if (current.length >= 3) parts.push(current);
    return parts.join(' ');
}

/**
 * A capture this module is willing to plan against.
 *
 * `verified` is not decoration. A single-pass read that dropped or duplicated a chunk produces a
 * file that looks entirely plausible, and the whole value of the backup here is that it is what the
 * sector gets restored from if phase 2 goes wrong.
 */
export interface VerifiedBackup {
    readonly image: Uint8Array;
    readonly verified: boolean;
}

/**
 * Everything that must survive the erase, or a refusal.
 *
 * Two sources, deliberately overlapping - belt and braces on purpose, because preserving a range
 * twice costs a few milliseconds and missing one costs an ECU that will not boot:
 *
 *   1. every non-0xFF run in the backup's copy of the sector, on both processors, and
 *   2. the flash counter and boot-handoff vector, unconditionally, on both processors.
 *
 * The backup contributes **addresses only**. Every byte written back is read live from the DME
 * seconds before the erase - see the caller. A stale map can therefore only cause the tool to
 * preserve a range that has since become 0xFF, which costs a few milliseconds; it can never cause
 * it to write yesterday's identity over today's.
 *
 * Every refusal below means "we cannot enumerate what must survive", and the honest response to
 * that is to read at 9600.
 */
export function buildPreservationPlan(backup: VerifiedBackup | null): PreservationPlan {
    if (!backup) {
        return { safe: false, reason: 'no verified backup of this DME exists yet, so there would be nothing to restore from' };
    }
    if (!backup.verified) {
        return { safe: false, reason: 'the backup was not confirmed by a second pass, so it cannot be relied on to restore the sector' };
    }
    if (backup.image.length < 0x100000) {
        return { safe: false, reason: `the backup is ${backup.image.length} bytes; a full capture is 1 MiB` };
    }

    const spans: Span[] = [];
    const sources: string[] = [];
    const add = (label: string, candidates: readonly (Span | null)[]): void => {
        const kept = candidates.filter((s): s is Span => s !== null);
        spans.push(...kept);
        sources.push(`${label}: ${kept.length} span(s)`);
    };

    const processors = ['master', 'slave'] as const;
    for (const processor of processors) {
        const block = extractServiceBlock(backup.image, processor);
        if (block.every((b) => b === 0xff)) {
            return {
                safe: false,
                reason: `the backup's ${processor} service block is entirely blank, which cannot be right`
                    + ' for a healthy DME - that capture never reached it',
            };
        }
        add(`${processor} non-0xFF map`, computeNonErasedSpans(block, processor).map(clipToWindow));
    }

    add('flash counter + boot handoff vector', processors.map((processor) => clipToWindow({
        processor,
        start: FREE_IDENTIFIERS.start + ServiceBlock.counterOffset,
        length: ServiceBlock.counterLength,
    })));

    const merged = mergeSpans(spans);
    if (merged.length === 0) {
        return { safe: false, reason: 'nothing to preserve was found, which cannot be right for a healthy DME' };
    }
    return { safe: true, spans: merged, sources };
}

/**
 * Is this backup a current, faithful copy of the sector on the other end of the cable?
 *
 * The operator is never asked to promise it, and no field has to be decoded to answer it: compare
 * the whole 8 KiB block, live against stored. That covers the VIN, the AIF history, the ZIF/BRIF
 * records and everything else in one check, and it needs none of them to be understood.
 *
 * A first attempt used a VIN at a documented offset. A real capture showed why that was the wrong
 * shape: the area is a packed record, the "VIN" is a field inside it, and a check built on a
 * guessed offset would have compared two runs of padding and called them equal.
 *
 * **The flash counter is excluded**, and only the flash counter. It legitimately advances between
 * the backup and now - every programming session consumes a slot - so a difference there is not
 * evidence of a different car. A difference anywhere else is.
 */
export function serviceBlockMatches(
    backup: VerifiedBackup,
    live: Uint8Array,
    processor: Processor,
): { same: boolean; reason: string; differingOffsets: readonly number[] } {
    const stored = extractServiceBlock(backup.image, processor);
    if (live.length !== stored.length) {
        return {
            same: false,
            differingOffsets: [],
            reason: `the live read returned ${live.length} bytes, not the ${stored.length} of a service block`,
        };
    }

    const counterStart = ServiceBlock.counterOffset;
    const counterEnd = counterStart + ServiceBlock.counterLength;
    const differing: number[] = [];
    for (let i = 0; i < stored.length; i++) {
        if (i >= counterStart && i < counterEnd) continue;
        if (stored[i] !== live[i]) differing.push(FREE_IDENTIFIERS.start + i);
        if (differing.length >= 16) break;
    }

    if (differing.length > 0) {
        const where = differing.slice(0, 4).map((o) => `0x${o.toString(16)}`).join(', ');
        return {
            same: false,
            differingOffsets: differing,
            reason: `the ${processor} service block on this DME differs from the backup at ${where}`
                + `${differing.length >= 16 ? ' and more' : ''}`
                + ' - either the backup is from another ECU, or it is out of date',
        };
    }
    return {
        same: true,
        differingOffsets: [],
        reason: `the ${processor} service block matches the backup byte for byte, flash counter aside`,
    };
}

/** How long a transfer of `bytes` takes at a rate, from the measured per-exchange cost. */
export interface TransferEstimate {
    readonly seconds: number;
    readonly exchanges: number;
}

/**
 * Estimate a bulk read, from measurement rather than from arithmetic on the baud rate alone.
 *
 * A DS2 read exchange is a 9-byte request, its echo, and a `count + 4` byte response. On the wire
 * that is `(bytes x 11 bits) / baud` at 8E1 - eleven bits, not ten, because the parity bit is
 * carried. On top of it sits the DME's own turnaround, which was measured at ~53 ms per chunk on a
 * real car and which **no baud rate recovers**: it is the ECU thinking, and it is the reason a 13x
 * increase in line speed does not make the read 13x faster.
 *
 * The default chunk is the one the read plans actually use. It used to be 0xfe - the protocol
 * maximum, which nothing sends - so every estimate counted half the exchanges that really happen
 * and the app told the operator a number a little over half the truth. A default that disagrees
 * with the only caller is not a default, it is a second, wrong, source of truth.
 */
export function estimateRead(
    bytes: number, baud: number, chunk: number = READ_CHUNK_MAX,
): TransferEstimate {
    const exchanges = Math.ceil(bytes / chunk);
    const wireBytes = 9 + 9 + (chunk + 4); // request, its echo, the response
    const perExchange = (wireBytes * 11 * 1000) / baud + DEVICE_TURNAROUND_MS;
    return { seconds: (exchanges * perExchange) / 1000, exchanges };
}

/**
 * The DME's own per-exchange thinking time, measured: 196.9 ms total per chunk at 9600 = 141.7 ms
 * wire (theory 144.4) + ~53 ms turnaround + ~2 ms host.
 *
 * It is stated as a constant because it is the floor. Once the wire time is gone this is all that
 * is left, and no further optimisation reaches it.
 */
export const DEVICE_TURNAROUND_MS = 53;

// ---------------------------------------------------------------------------------------------
// Telegrams, authorised here and nowhere else
// ---------------------------------------------------------------------------------------------

/**
 * Recycling-control addresses used by fast entry.
 *
 * The address is a state key, not a location: handler 0x3126 maps `0x424150 + n` onto a state byte
 * at 0xFFD150. `0x424151` ("BAQ") gives 0xC7, which is what suppresses the tail-guard sector erase
 * so the 8 KiB block is the only thing that goes. `0x424152` closes it again; the reference tool
 * sends both and this does the same rather than guessing that one is optional.
 */
export const RECYCLE_ONLY_ADDRESS = 0x424151;
export const RECYCLE_OFF_ADDRESS = 0x424152;

/**
 * Erase telegram for one processor's service block.
 *
 * Deliberately NOT `buildEraseTelegram` from `telegrams.ts`. That function consults
 * `ERASE_ALLOWED_NIBBLES`, which does not contain 0x0 or 0x8, and it is right not to: the general
 * erase path in this package must never be able to reach a service block. Fast entry is the single
 * authorised exception, so it builds its own telegram here, next to the plan that justifies it.
 */
export function buildFastEntryEraseTelegram(processor: Processor): Uint8Array {
    assertWriteUnlocked(`fast-entry erase of the ${processor} service block`, 'reversible');
    return new Uint8Array([
        Command.ProgramControl, Segment.Erase, ...addressBytes(SERVICE_BLOCK_DS2[processor]), 0x00,
    ]);
}

/**
 * Write telegram inside one processor's service block.
 *
 * The address is checked against the sector rather than against a nibble list, which is the
 * stronger check: `toDs2Address` throws for anything outside `0x4000-0x5FFF`, so this cannot be
 * pointed at the bootloader, the calibration or the program area even by a caller trying to.
 */
export function buildFastEntryWriteTelegram(
    processor: Processor, imageAddress: number, bytes: Uint8Array,
): Uint8Array {
    assertWriteUnlocked(
        `fast-entry write of ${bytes.length} bytes to the ${processor} service block`, 'reversible');
    if (bytes.length === 0 || bytes.length > WRITE_CHUNK_MAX) {
        throw new Error(`fast-entry write of ${bytes.length} bytes is outside 1..${WRITE_CHUNK_MAX}`);
    }
    const address = toDs2Address(processor, imageAddress);
    toDs2Address(processor, imageAddress + bytes.length - 1); // throws if the run leaves the sector
    return new Uint8Array([Command.ProgramControl, Segment.Write, ...addressBytes(address), ...bytes]);
}

/** 24-bit big-endian, as every DS2 address telegram carries it. */
function addressBytes(ds2Address: number): [number, number, number] {
    if (ds2Address < 0 || ds2Address > 0xffffff) {
        throw new Error(`DS2 address 0x${ds2Address.toString(16)} does not fit in 24 bits`);
    }
    return [(ds2Address >>> 16) & 0xff, (ds2Address >>> 8) & 0xff, ds2Address & 0xff];
}

/**
 * Split a span into telegram-sized chunks.
 *
 * `WRITE_CHUNK_MAX` is 122 and even, because flash programming needs an even length at an even
 * address. A span that starts odd is extended backwards by one byte so every chunk lands on an even
 * address; the extra byte is read live along with the rest, so re-writing it is a no-op.
 */
export function chunkSpan(span: Span, chunk = WRITE_CHUNK_MAX): readonly { start: number; length: number }[] {
    const start = span.start & 1 ? span.start - 1 : span.start;
    const end = span.start + span.length;
    const total = end - start;
    const out: { start: number; length: number }[] = [];
    for (let offset = 0; offset < total; offset += chunk) {
        const length = Math.min(chunk, total - offset);
        out.push({ start: start + offset, length: length & 1 ? length + 1 : length });
    }
    return out;
}
