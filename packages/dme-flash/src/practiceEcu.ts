/**
 * A simulated MSS54HP, for walking the flow without a car.
 *
 * This lives in `dme-flash` rather than in the app because it is driven by production code and the
 * app package has no test runner pointed at it. While it sat in the UI, a practice run hung at
 * "2 of 3" and there was no way to ask whether the fixture or the transport was at fault without
 * guessing - and a broken one of either looks exactly like a slow one, since a failing read retries
 * five times with backoff before it gives up. Now both are covered by practiceImage.test.ts.
 *
 * ## Why the ECU is synthetic rather than a real dump
 *
 * Shipping a real capture would put someone's VIN and AIF history in the bundle, and worse: it
 * would make a practice capture indistinguishable from a real one. This image is mostly 0xFF with
 * only the fields the flow actually reads filled in.
 *
 * What is real is everything except the bytes. The DS2 framing, the K-line echo, the seed/key
 * login, the nibble map, the censored window, the two-pass comparison and every refusal are the
 * production paths running against `MockDme`. Practice cannot teach a flow that does not exist,
 * because there is only one flow.
 */
import { MockDme } from './mockDme';
import { Command } from './telegrams';
import { Segment } from './regionMap';
import { DME_DS2_ADDRESS, Ds2Status, buildDs2Frame, parseDs2Frame } from './ds2';
import { FULL_IMAGE_LENGTH, type Processor } from './imageLayout';
import { SA0_LENGTH, SA0_IMAGE_OFFSET, correctBootloaderCrc } from './bootloaderImage';
import { FREE_IDENTIFIERS, ServiceBlock } from './fastEntry';
import {
    MAGIC_OFFSET, BOOTLOADER_IMAGE_OFFSET, STAGED_MAGIC, carriesNoBootloaderImage,
    STAGED_SECTOR_LENGTH,
} from './blLoader';
import type { ByteTransport } from './transport';

/**
 * How the practice run is paced, and why it is paced at all.
 *
 * Not zero: a 1 MiB capture finishing in a blink would teach the opposite of the lesson - that this
 * is quick, that backgrounding the tab is fine. Not the real 197 ms either: nobody would sit
 * through half an hour of pretend.
 *
 * The pause is taken once per batch rather than once per exchange because `setTimeout` has a floor.
 * Asking for 2 ms sixteen thousand times measured at 82 s for a two-pass capture, not the ~33 s the
 * arithmetic promised, because each call was clamped to roughly double. 8 ms every fourth exchange
 * is the same nominal rate and delivers it: a two-pass capture runs in about 38 s, roughly a
 * fortieth of real time. The UI states the real duration beside the bar rather than letting this
 * imply one.
 */
export const PRACTICE_BATCH_MS = 8;
export const PRACTICE_BATCH_SIZE = 4;

/** What one exchange really costs on a car, so practice can say what it is standing in for. */
export const REAL_EXCHANGE_MS = 197;

/**
 * A standard-M3 bootloader sector, built rather than copied.
 *
 * Only the bytes the tool reads are set: the operand that decides the flavour, the three
 * program-number strings, the build tag, and a CRC computed over the result so it validates. That
 * is enough for IDENT to be truthful about what it is looking at, and nowhere near enough to be
 * mistaken for BMW's.
 */
export function practiceSa0(processor: Processor): Uint8Array {
    const sa0 = new Uint8Array(SA0_LENGTH).fill(0xff);

    // The operand `identifyBootloader` reads. 0xE0 master / 0xE1 slave is the standard M3.
    sa0[0x12ae] = processor === 'master' ? 0xe0 : 0xe1;

    if (processor === 'master') {
        // Three copies of the program number; the digit that differs sits at index 5 of eight.
        for (const asciiOffset of [0x3fd7, 0x3fdf, 0x3fe7]) {
            const start = asciiOffset - 5;
            for (const [i, ch] of Array.from('21132300').entries()) sa0[start + i] = ch.charCodeAt(0);
        }
        sa0[0x3ffc] = 0x4d; // 'M'
        sa0[0x3ffd] = 0x4d; // 'M'
    } else {
        sa0[0x3fe0] = 0x53; // 'S'
        sa0[0x3fe1] = 0x53; // 'S'
    }

    correctBootloaderCrc(sa0, processor);
    return sa0;
}

/**
 * A service block with the two things the flow inspects.
 *
 * The flash counter, so `buildPreservationPlan` finds something to preserve unconditionally, and a
 * short identity record so the block is not blank - a blank one is a refusal, which would make
 * practice teach that fast entry is never available.
 *
 * The record is packed bytes rather than an ASCII VIN, because that is what a real capture holds.
 * A fixture shaped like the convenient version would let a check that depends on it pass.
 */
export function practiceServiceBlock(seed: number): Uint8Array {
    const block = new Uint8Array(FREE_IDENTIFIERS.length).fill(0xff);
    block.set([0x00, 0xff, 0xff, 0x00, 0x00, 0xff, 0xff, 0x00], ServiceBlock.counterOffset);
    for (let i = 0; i < 0x28; i++) block[ServiceBlock.identityOffset + i] = (seed + i * 37) & 0xff;
    return block;
}

/**
 * A 1 MiB image for the simulator.
 *
 * Calibration and program carry a deterministic pattern rather than 0xFF, so the two-pass
 * comparison has something to compare - a dropped chunk in a blank region would match by accident.
 */
export function practiceEcuImage(): Uint8Array {
    const image = new Uint8Array(FULL_IMAGE_LENGTH).fill(0xff);
    for (const processor of ['master', 'slave'] as const) {
        const base = SA0_IMAGE_OFFSET[processor];
        image.set(practiceSa0(processor), base);
        image.set(practiceServiceBlock(processor === 'master' ? 0x20 : 0x60), base + FREE_IDENTIFIERS.start);
        for (let offset = 0x8000; offset < 0x80000; offset++) {
            image[base + offset] = ((offset >>> 3) ^ (offset * 31) ^ base) & 0xff;
        }
    }
    return image;
}

/**
 * A transport that speaks to a simulated DME, at a visible pace.
 *
 * Every method delegates explicitly rather than being assembled with a spread and a conditional
 * `drain`. That is a readability preference, not a fix: the spread version was suspected of causing
 * a hang in the practice run and was tested directly - it behaves identically. The hang was stale
 * dev-server module state, and the honest record of that is here rather than in a changelog nobody
 * reads, because the next person to see a mysterious practice hang should not re-suspect this.
 */
export function practiceTransport(image: Uint8Array): { transport: ByteTransport; dme: MockDme } {
    const dme = new MockDme({
        master: image.slice(0, 0x80000),
        slave: image.slice(0x80000),
    });
    const inner = dme.transport();
    let sinceLastPause = 0;

    const transport: ByteTransport = {
        // The declaration the hardware gate reads. Only a transport with no ECU behind it sets it,
        // and this is the only place in the package that does.
        simulated: true,
        // The pause goes on write, not read: a DS2 exchange is one write and several reads, so this
        // is once per exchange. Pausing per read would triple it and make the bar's shape wrong.
        write: async (bytes) => {
            if (++sinceLastPause >= PRACTICE_BATCH_SIZE) {
                sinceLastPause = 0;
                await new Promise((resolve) => setTimeout(resolve, PRACTICE_BATCH_MS));
            }
            await inner.write(bytes);
        },
        read: async (count, timeoutMs) => inner.read(count, timeoutMs),
        drain: async () => { await inner.drain?.(); },
        // No setBaudRate, and that is accurate rather than lazy: nothing about a simulator makes
        // 125000 reachable, so fast entry reports that this link cannot change rate - the same
        // sentence a real transport without in-place baud change would produce.
    };
    return { transport, dme };
}

/** Roughly how long the same run would take on a car, for the UI to state beside the bar. */
export function realSecondsFor(exchanges: number): number {
    return (exchanges * REAL_EXCHANGE_MS) / 1000;
}

// ---------------------------------------------------------------------------------------------
// Programming, for practice only
// ---------------------------------------------------------------------------------------------

/**
 * A simulated DME that also accepts erase and program, so practice can walk the whole sequence.
 *
 * This is deliberately NOT in `MockDme`. That mock refuses programming control on purpose, and the
 * reason is worth keeping: a mock that accepts writes lets a bug in the write path look tested when
 * nothing has been proven. The test suite keeps the strict mock; practice gets this one, and the
 * difference is visible in which class a caller reaches for.
 *
 * What it models is what NOR flash actually does, because the point of practising is to meet the
 * real failure modes rather than a friendly version of them:
 *
 *  - **Erase sets a sector to 0xFF.** Nothing else clears a bit back to one.
 *  - **Programming can only clear bits.** A write is `existing AND incoming`, so writing 0xFF over
 *    programmed data is a no-op rather than an erase, and re-writing a cell that already holds a
 *    different value silently fails to produce what was asked for - which the verify catches.
 *  - **The write acknowledgement echoes the address and count**, because that is what the real one
 *    does and what `parseWriteAcknowledgement` insists on.
 */
export class PracticeDme {
    private readonly mock: MockDme;
    /** DS2 window base -> the flash array and offset it addresses. */
    constructor(private readonly image: Uint8Array) {
        this.mock = new MockDme({
            master: image.subarray(0, 0x80000),
            slave: image.subarray(0x80000),
        });
    }

    get unlocked(): boolean { return this.mock.unlocked; }

    /**
     * Where a DS2 address lands in the 1 MiB image, or null when the firmware would refuse it.
     *
     * The nibble map, same as the read path: 0/8 service block, 1/9 bootloader, 2/A calibration,
     * 4/C tail guard, 5/D program. The bootloader is included because the whole point of the
     * exercise is the sector that cannot be erased - a practice run must meet that refusal.
     */
    private locate(ds2Address: number): { offset: number; erasable: boolean } | null {
        const nibble = (ds2Address >>> 20) & 0xf;
        const offset = ds2Address & 0xfffff;
        const base: Record<number, number | undefined> = {
            0x0: 0x4000, 0x1: 0x0000, 0x2: 0x8000, 0x4: 0x6000, 0x5: 0x10000,
        };
        const within = base[nibble & 0x7];
        if (within === undefined) return null;
        const processorBase = nibble >= 0x8 ? 0x80000 : 0;
        // Nibble 1/9 is SA0. The firmware accepts a PROGRAM there and never an erase - which is the
        // asymmetry that makes a bootloader replacement need a loader in the first place.
        return { offset: processorBase + within + offset, erasable: (nibble & 0x7) !== 0x1 };
    }

    respond(request: Uint8Array): Uint8Array {
        const command = request[0];
        if (command !== Command.ProgramControl && command !== Command.Jump) {
            return this.mock.respond(request);
        }
        if (command === Command.Jump) return new Uint8Array([Ds2Status.Ack]);

        const segment = request[1] ?? 0;
        const address = ((request[2] ?? 0) << 16) | ((request[3] ?? 0) << 8) | (request[4] ?? 0);

        if (segment === Segment.Recycling || segment === Segment.Finish) {
            return new Uint8Array([Ds2Status.Ack]);
        }

        if (segment === Segment.Erase) {
            const at = this.locate(address);
            if (!at || !at.erasable) return new Uint8Array([Ds2Status.Rejected]);
            const length = eraseLengthFor(address);
            this.image.fill(0xff, at.offset, at.offset + length);
            return new Uint8Array([Ds2Status.Ack]);
        }

        if (segment === Segment.Write) {
            const at = this.locate(address);
            const data = request.subarray(5);
            if (!at) return new Uint8Array([Ds2Status.Rejected]);
            for (let i = 0; i < data.length; i++) {
                // AND, not assignment. NOR programming only clears bits.
                this.image[at.offset + i] = (this.image[at.offset + i] ?? 0xff) & (data[i] ?? 0xff);
            }
            const next = address + data.length;
            const wrote = data.every((b, i) => this.image[at.offset + i] === b);
            return new Uint8Array([
                Ds2Status.Ack, Segment.Write,
                (next >>> 16) & 0xff, (next >>> 8) & 0xff, next & 0xff,
                data.length & 0xff,
                wrote ? 0x01 : 0x02, // 0x01 = ok; anything else is what a real verify byte reports
            ]);
        }
        return new Uint8Array([Ds2Status.ParameterError]);
    }

    /**
     * What happens when the ignition is cycled: the reset handler, and the loader if it is armed.
     *
     * This is the ECU's own behaviour, not a convenience for the app. The reset handler at 0x24A
     * compares flash 0xFFFC against the magic before the SIM is configured or the K-line is up; if
     * it matches, it jumps to 0x8000 and the staged loader runs. The loader clears the magic FIRST
     * and only then replaces SA0 - the ordering that means a loader which fails afterwards leaves an
     * ECU that boots normally instead of one that re-enters a broken loader forever.
     *
     * Practice models it so that the power-cycle prompt is a real step with a real consequence.
     * Without this the run would stop, the operator would confirm, and nothing would have changed -
     * which would teach that the ignition cycle is ceremony.
     *
     * ## Which loader ran
     *
     * There is no 68k interpreter here, so this cannot execute whatever happens to be staged. It
     * models the two loaders this tool actually ships, told apart the same way the plan validator
     * tells them apart - by whether the sector carries a bootloader image:
     *
     *   - **probe** (region erased): clears the magic and stops. SA0 is not touched. That is
     *     exactly what `tools/loader/probe.s` does, and the reason it exists.
     *   - **replace** (region carries SA0): clears the magic, then writes that image over SA0.
     *
     * Copying the region unconditionally, as this used to, would have let a practice probe program
     * 16 KiB of erased flash over SA0 and report it as a bootloader - teaching the operator that a
     * probe destroys the bootloader, on the one screen built to say it does not.
     *
     * Returns which processors ran their loader, so a caller can report it.
     */
    powerCycle(): Processor[] {
        const ran: Processor[] = [];
        for (const processor of ['master', 'slave'] as const) {
            const base = processor === 'master' ? 0 : 0x80000;
            const sector = base + CALIBRATION_OFFSET;
            const magicAt = sector + MAGIC_OFFSET;
            const magic = (((this.image[magicAt] ?? 0) << 24) | ((this.image[magicAt + 1] ?? 0) << 16)
                | ((this.image[magicAt + 2] ?? 0) << 8) | (this.image[magicAt + 3] ?? 0)) >>> 0;
            if (magic !== STAGED_MAGIC) continue;

            // Disarm first. Everything after this can fail and the ECU still boots.
            this.image.fill(0x00, magicAt, magicAt + 4);

            const probe = carriesNoBootloaderImage(
                this.image.subarray(sector, sector + STAGED_SECTOR_LENGTH));
            if (!probe) {
                const staged = this.image.subarray(
                    sector + BOOTLOADER_IMAGE_OFFSET, sector + BOOTLOADER_IMAGE_OFFSET + SA0_LENGTH);
                // SA0 is the one sector DS2 cannot erase; the loader running on the CPU can.
                this.image.set(staged, base);
            }
            ran.push(processor);
        }
        return ran;
    }

    /** The image as it now stands, so a practice run can be inspected afterwards. */
    snapshot(): Uint8Array {
        return Uint8Array.from(this.image);
    }
}

/** Where the calibration sector - the one a loader is staged into - sits in each half. */
const CALIBRATION_OFFSET = 0x8000;

/**
 * How much one erase control clears.
 *
 * Per sector, from the flash's own map: the service block and the tail guard are 8 KiB, the
 * calibration 32 KiB, the program window the rest of the half. A practice erase that cleared the
 * wrong amount would teach the wrong thing about what is recoverable.
 */
function eraseLengthFor(ds2Address: number): number {
    switch ((ds2Address >>> 20) & 0x7) {
        case 0x0: return 0x2000;   // service block (SA1)
        case 0x2: return 0x8000;   // calibration (SA3)
        case 0x4: return 0x2000;   // tail guard (SA2)
        case 0x5: return 0x70000;  // program (SA4-SA10)
        default: return 0;
    }
}

/**
 * A transport onto a programming-capable simulator.
 *
 * `batchMs` exists because the pacing is a property of the *user interface*, not of the protocol:
 * it is there so a practice run feels like the real thing rather than finishing in a blink. A test
 * asserting the telegram sequence wants the sequence, not the theatre, and a 640 KiB program write
 * at UI pace takes tens of seconds. Passing 0 skips the pause entirely rather than asking for a
 * zero-length timer, which still costs a clamped tick per batch.
 */
export function practiceProgrammingTransport(
    image: Uint8Array,
    options: { batchMs?: number } = {},
): { transport: ByteTransport; dme: PracticeDme } {
    const batchMs = options.batchMs ?? PRACTICE_BATCH_MS;
    const dme = new PracticeDme(image);
    let buffer: number[] = [];
    let sinceLastPause = 0;

    const transport: ByteTransport = {
        simulated: true,
        write: async (bytes) => {
            if (batchMs > 0 && ++sinceLastPause >= PRACTICE_BATCH_SIZE) {
                sinceLastPause = 0;
                await new Promise((resolve) => setTimeout(resolve, batchMs));
            }
            buffer.push(...bytes); // the K-line echo
            const parsed = parseDs2Frame(bytes);
            if (!parsed.ok || !parsed.data) return;
            buffer.push(...buildDs2Frame(DME_DS2_ADDRESS, dme.respond(parsed.data)));
        },
        read: async (count) => {
            if (buffer.length < count) {
                throw new Error(`practice DME has ${buffer.length} bytes buffered, ${count} requested`);
            }
            return Uint8Array.from(buffer.splice(0, count));
        },
        drain: async () => { buffer = []; },
    };
    return { transport, dme };
}
