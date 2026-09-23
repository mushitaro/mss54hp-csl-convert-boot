/**
 * Where the DME's flash windows live inside a 1 MiB full image, and which of them a CSL
 * conversion has to write.
 *
 * Every number here was measured, not assumed (docs/region-map.md, docs/image-layout.md):
 *
 *  - The genuine SP-DATEN CSL 0401 program (`7837340A.0PA`) matches a real 0401 image
 *    byte-for-byte at these offsets - 100.0000% on two of its eight sections and 99.57% on the
 *    worst, the shortfall being exactly the 487 bytes of a known third-party modification.
 *  - The calibration windows are confirmed independently: the CRC-16/ARC slots at full-image
 *    0x0BFFC and 0x8BFFC validate over the 32 KiB halves found at 0x08000 and 0x88000.
 *
 * The ECU's own acceptance rules are a separate question and live in regionMap.ts. This module
 * says where bytes ARE; that one says what the bootloader will TAKE.
 */
import { Segment, resolveFlashAddress } from './regionMap';

export type Processor = 'master' | 'slave';
export type WindowKind = 'program' | 'calibration';

export interface ImageWindow {
    readonly kind: WindowKind;
    readonly processor: Processor;
    /** Base address in DS2 space - hand this straight to the flasher. */
    readonly ds2Address: number;
    /** Byte offset of the same data inside a 1 MiB full image. */
    readonly imageOffset: number;
    /** Bytes of real content. The ECU's addressable window can be larger - see regionMap. */
    readonly length: number;
}

export const FULL_IMAGE_LENGTH = 0x100000;

/**
 * The four windows a standard-to-CSL conversion writes.
 *
 * Program is 256 KiB of content inside a 448 KiB addressable window; the rest of the window is
 * not carried by the SP-DATEN file and must not be invented.
 */
export const IMAGE_WINDOWS: readonly ImageWindow[] = [
    { kind: 'calibration', processor: 'master', ds2Address: 0x200000, imageOffset: 0x008000, length: 0x8000 },
    { kind: 'program', processor: 'master', ds2Address: 0x500000, imageOffset: 0x010000, length: 0x40000 },
    { kind: 'calibration', processor: 'slave', ds2Address: 0xa00000, imageOffset: 0x088000, length: 0x8000 },
    { kind: 'program', processor: 'slave', ds2Address: 0xd00000, imageOffset: 0x090000, length: 0x40000 },
] as const;

/**
 * The first 32 KiB of each processor: bootloader, AIF, service block, identity.
 *
 * Not a conversion target and not addressable for erase through the programming path - the
 * firmware's own region_table disables the segments that reach the guard sector. Listed so that
 * "is this address inside something I must never touch" has one answer instead of several.
 */
export const PROTECTED_IMAGE_RANGES: readonly { readonly processor: Processor; readonly start: number; readonly end: number; readonly what: string }[] = [
    { processor: 'master', start: 0x00000, end: 0x08000, what: 'master bootloader / AIF / service block' },
    { processor: 'slave', start: 0x80000, end: 0x88000, what: 'slave bootloader / AIF / service block' },
] as const;

/** True when a full-image offset falls in a range this tool must never erase or write. */
export function isProtectedImageOffset(offset: number): boolean {
    return PROTECTED_IMAGE_RANGES.some((r) => offset >= r.start && offset < r.end);
}

/** Translate a DS2 address to a full-image offset, or undefined when no window covers it. */
export function ds2ToImageOffset(ds2Address: number): number | undefined {
    for (const w of IMAGE_WINDOWS) {
        const delta = ds2Address - w.ds2Address;
        if (delta >= 0 && delta < w.length) return w.imageOffset + delta;
    }
    return undefined;
}

/** Translate a full-image offset to a DS2 address, or undefined when it is outside every window. */
export function imageOffsetToDs2(offset: number): number | undefined {
    for (const w of IMAGE_WINDOWS) {
        const delta = offset - w.imageOffset;
        if (delta >= 0 && delta < w.length) return w.ds2Address + delta;
    }
    return undefined;
}

export function windowFor(kind: WindowKind, processor: Processor): ImageWindow {
    const w = IMAGE_WINDOWS.find((x) => x.kind === kind && x.processor === processor);
    if (!w) throw new Error(`no ${kind} window for ${processor}`);
    return w;
}

/**
 * Load-time invariant: every window this module claims must be one the ECU would actually accept
 * for reading, writing and erasing - checked against the firmware's own table.
 *
 * This runs at import so a wrong constant cannot reach a programming session. It covers the first
 * and last byte of each window, which is where an off-by-one lands.
 */
function assertWindowsAreAddressable(): void {
    for (const w of IMAGE_WINDOWS) {
        for (const segment of [Segment.Read, Segment.Write, Segment.Erase]) {
            for (const address of [w.ds2Address, w.ds2Address + w.length - 1]) {
                const r = resolveFlashAddress(segment, address);
                if (!r.accepted) {
                    throw new Error(
                        `${w.kind}/${w.processor} address 0x${address.toString(16)} is not accepted`
                        + ` for segment 0x${segment.toString(16)}: ${r.reason}`);
                }
            }
        }
        if (w.imageOffset + w.length > FULL_IMAGE_LENGTH) {
            throw new Error(`${w.kind}/${w.processor} runs past the end of a full image`);
        }
        if (isProtectedImageOffset(w.imageOffset)) {
            throw new Error(`${w.kind}/${w.processor} starts inside a protected range`);
        }
    }
}
assertWindowsAreAddressable();

/**
 * The sector each full-image offset belongs to, named the way an operator would say it.
 *
 * This exists so a comparison failure can say *what* diverged rather than only where. The
 * distinction is the difference between two completely different situations:
 *
 *  - the **service block** differs -> this capture is from another ECU, and nothing else matters;
 *  - the **bootloader** differs -> it is from an ECU with a different bootloader, which is the one
 *    thing this tool must be certain about before it plans a replacement;
 *  - **calibration or program** differ -> same car, but it has been reflashed since the capture was
 *    taken, so the file is stale as a restore source.
 *
 * All three are refusals. Only the third is one the operator can fix by taking a fresh capture,
 * and they cannot know which they are looking at unless the tool says so.
 */
export function describeImageOffset(offset: number): string {
    const processor: Processor = offset >= 0x80000 ? 'slave' : 'master';
    const within = offset - (processor === 'slave' ? 0x80000 : 0);
    if (within < 0x4000) return `${processor} bootloader (SA0)`;
    if (within < 0x6000) return `${processor} service block (SA1)`;
    if (within < 0x8000) return `${processor} tail guard (SA2)`;
    if (within < 0x10000) return `${processor} calibration (SA3)`;
    return `${processor} program (SA4-SA10)`;
}

/** The distinct sectors a set of differing offsets touches, in image order. */
export function describeImageOffsets(offsets: readonly number[]): string[] {
    const seen: string[] = [];
    for (const offset of offsets) {
        const name = describeImageOffset(offset);
        if (!seen.includes(name)) seen.push(name);
    }
    return seen;
}
