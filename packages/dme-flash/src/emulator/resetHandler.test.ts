/**
 * The jump this whole project rests on, executed instead of assumed.
 *
 * Every other test about the loader starts by writing `cpu.pc = 0x8000` - it constructs the state
 * that exists AFTER the reset handler has decided to run the staged code. That decision is the one
 * irreversible act in the tool: the moment the magic is programmed, either the DME jumps to 0x8000
 * on every power-up or it does not, and if the disassembly was read wrong in either direction the
 * consequence is an ECU that cannot be reached over OBD again.
 *
 *     reset vector 0x000000/0x000004  ->  BMW's init  ->  0x24A:
 *         cmpi.l #$5AA556C9, $0000FFFC   ->  jsr $1BDE  ->  lea $8000,a0 ; jmp (a0)
 *
 * So this starts the CPU where the silicon starts it - fetching SSP and PC out of flash - and runs
 * BMW's own reset code. It is the same technique `bmwStubs.test.ts` used to validate the emulator:
 * execute code known to work on the real part, and see whether the model reproduces it.
 *
 * Both directions matter equally. Reaching 0x8000 with the magic present proves the arming works;
 * NOT reaching it with the magic absent proves that arming is what causes it, rather than the ECU
 * jumping there anyway. A test that only checked the first would pass on a machine that always
 * jumped to 0x8000, which would mean every DME on earth was already armed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { Cpu32 } from './cpu32';
import { Machine } from './machine';
import { FLASH_LENGTH } from './flashAm29f400';

const IMAGE = process.env.CSL_0401_BIN
    ?? String.raw`C:\Users\kazuh\CSL_0401_Binary_Disassembly_Notes\Full 211323000401PD31_TERRA.bin`;
const haveImage = existsSync(IMAGE);
const master = haveImage ? new Uint8Array(readFileSync(IMAGE)).slice(0, FLASH_LENGTH) : undefined;
const maybe = haveImage ? it : it.skip;

const MAGIC = 0x5aa556c9;
const MAGIC_AT = 0xfffc;
const LOADER_ENTRY = 0x8000;
/** The dispatcher the reset handler calls once the magic matches. */
const STAGED_ENTRY_TRAMPOLINE = 0x1bde;
/** The comparison itself, per the disassembly notes. */
const MAGIC_CHECK = 0x24a;
/** Where the two paths part company: taken to 0x256 when the magic matches, to 0x25C when it does not. */
const MAGIC_BRANCH = 0x254;
/**
 * Where the resident bootloader writes SYPCR - AFTER the magic check.
 *
 * `probe.s` depends on this: SYPCR is write-once after a reset, the RESET instruction inside 0x1BDE
 * reopens that window, and the probe uses it to ask for the longest watchdog timeout. That is only
 * true if the firmware has not already claimed the write by the time the loader runs, and this
 * address is what makes it true.
 */
const SYPCR_WRITE = 0x276;

interface Run {
    /** Every address the CPU fetched an instruction from, in order. */
    readonly trace: number[];
    readonly reachedLoader: boolean;
    readonly reachedTrampoline: boolean;
    readonly reachedMagicCheck: boolean;
    readonly stoppedBecause: string;
}

/**
 * The AIF boot-mode area the reset handler reads before it ever looks at the magic.
 *
 * **This is the difference between a distributed file and a car**, and until it was parameterised
 * every test below ran the wrong one. A file that has been through SP-DATEN or a forum post has
 * SA1 blanked to 0xFF, so the word at 0x4800 is non-zero immediately and `0x21A` branches straight
 * to the magic check. A real DME has eight zero bytes there and the handler walks past them, finds
 * 0xFFFF at 0x4808, and goes to `0x22A: jsr $10400` - BMW's application init - first.
 *
 * Verified on four combinations: a real standard-M3 dump and the CSL 0401 reference image, each
 * with its own AIF and with the other one's. The program makes no difference; the AIF decides.
 */
type AifState = 'blanked' | 'real-car';
const AIF_AT = 0x4800;

function setAif(image: Uint8Array, state: AifState): void {
    if (state === 'blanked') image.fill(0xff, AIF_AT, AIF_AT + 8);
    else image.fill(0x00, AIF_AT, AIF_AT + 8);
}

/**
 * Boot the machine exactly as the silicon does and run until it reaches the loader or gives up.
 *
 * No PC is set by hand: SSP and PC come out of flash 0x000000 and 0x000004, which is how a 68k
 * starts. The watchdog is given a large budget because BMW's init is long and services it on its
 * own schedule; a bite would be reported rather than silently ending the run.
 */
function boot(options: { armed: boolean; budget?: number; aif?: AifState }): Run {
    const image = Uint8Array.from(master!);
    if (options.aif) setAif(image, options.aif);
    if (options.armed) {
        image[MAGIC_AT] = (MAGIC >>> 24) & 0xff;
        image[MAGIC_AT + 1] = (MAGIC >>> 16) & 0xff;
        image[MAGIC_AT + 2] = (MAGIC >>> 8) & 0xff;
        image[MAGIC_AT + 3] = MAGIC & 0xff;
    } else {
        // Cleared exactly as the loader clears it: programmed to zero, not erased.
        image.fill(0x00, MAGIC_AT, MAGIC_AT + 4);
    }

    const machine = new Machine(image, { watchdogInstructions: 5_000_000 });
    const cpu = new Cpu32({
        readWord: (a, f) => { machine.tick(); return machine.readWord(a, f); },
        readByte: (a, f) => machine.readByte(a, f),
        writeWord: (a, v) => machine.writeWord(a, v),
        writeByte: (a, v) => machine.writeByte(a, v),
    });

    // What the part does on power-up: fetch the supervisor stack pointer and the program counter
    // from the first two longwords of flash.
    cpu.a[7] = (machine.readWord(0x000000) << 16) | machine.readWord(0x000002);
    cpu.pc = (machine.readWord(0x000004) << 16) | machine.readWord(0x000006);
    cpu.vbr = 0;
    cpu.sr = 0x2700;

    const trace: number[] = [];
    let reachedLoader = false;
    let reachedTrampoline = false;
    let reachedMagicCheck = false;
    let stoppedBecause = 'budget exhausted';

    const budget = options.budget ?? 2_000_000;
    for (let step = 0; step < budget; step++) {
        const pc = cpu.pc >>> 0;
        if (trace.length < 4000) trace.push(pc);
        if (pc === MAGIC_CHECK) reachedMagicCheck = true;
        if (pc === STAGED_ENTRY_TRAMPOLINE) reachedTrampoline = true;
        if (pc === LOADER_ENTRY) { reachedLoader = true; stoppedBecause = 'reached the loader'; break; }
        try {
            cpu.step();
        } catch (error) {
            stoppedBecause = `CPU stopped: ${error instanceof Error ? error.message : String(error)}`;
            break;
        }
        if (machine.watchdogFired) { stoppedBecause = 'watchdog fired'; break; }
    }
    return { trace, reachedLoader, reachedTrampoline, reachedMagicCheck, stoppedBecause };
}

/** Boot an image that has already been prepared, for cases that need a magic of their own. */
function runImage(image: Uint8Array): Run {
    const machine = new Machine(image, { watchdogInstructions: 200_000 });
    const cpu = new Cpu32({
        readWord: (a, f) => { machine.tick(); return machine.readWord(a, f); },
        readByte: (a, f) => machine.readByte(a, f),
        writeWord: (a, v) => machine.writeWord(a, v),
        writeByte: (a, v) => machine.writeByte(a, v),
    });
    cpu.a[7] = (machine.readWord(0x000000) << 16) | machine.readWord(0x000002);
    cpu.pc = (machine.readWord(0x000004) << 16) | machine.readWord(0x000006);
    cpu.vbr = 0;
    cpu.sr = 0x2700;

    const trace: number[] = [];
    let reachedLoader = false;
    let reachedTrampoline = false;
    let reachedMagicCheck = false;
    let stoppedBecause = 'budget exhausted';
    for (let step = 0; step < 400_000; step++) {
        const pc = cpu.pc >>> 0;
        if (trace.length < 4000) trace.push(pc);
        if (pc === MAGIC_CHECK) reachedMagicCheck = true;
        if (pc === STAGED_ENTRY_TRAMPOLINE) reachedTrampoline = true;
        if (pc === LOADER_ENTRY) { reachedLoader = true; stoppedBecause = 'reached the loader'; break; }
        try { cpu.step(); } catch (error) {
            stoppedBecause = `CPU stopped: ${error instanceof Error ? error.message : String(error)}`;
            break;
        }
        if (machine.watchdogFired) { stoppedBecause = 'watchdog fired'; break; }
    }
    return { trace, reachedLoader, reachedTrampoline, reachedMagicCheck, stoppedBecause };
}

describe('the reset handler, run from the reset vector', () => {
    maybe('starts where the silicon starts it', () => {
        // Before anything else: the vectors have to be real. A blank or aliased first longword
        // would make every result below meaningless.
        const machine = new Machine(Uint8Array.from(master!));
        const ssp = (machine.readWord(0x000000) << 16) | machine.readWord(0x000002);
        const pc = (machine.readWord(0x000004) << 16) | machine.readWord(0x000006);
        expect(ssp, 'the reset SSP must not be blank flash').not.toBe(0xffffffff);
        expect(pc, 'the reset PC must not be blank flash').not.toBe(0xffffffff);
        expect(pc).toBeLessThan(FLASH_LENGTH);
        expect(pc % 2, 'an odd reset PC would address-error immediately').toBe(0);
        // `probe.s` documents its entry state as "A7 unreliable (0 on the reset path)". That is a
        // claim about this longword, and it is why the loader sets its own stack before using one.
        expect(ssp, 'the reset path really does hand over a zero SSP').toBe(0);
    });

    maybe('reaches the magic check at 0x24A', () => {
        // The disassembly says the comparison lives there. If BMW's own init does not get there,
        // every claim built on top of it is about code that never runs.
        const run = boot({ armed: true });
        expect(run.reachedMagicCheck, `never reached 0x24A (${run.stoppedBecause})`).toBe(true);
    });

    maybe('jumps to the staged loader when the magic is present', () => {
        const run = boot({ armed: true });
        expect(run.reachedTrampoline, `never reached 0x1BDE (${run.stoppedBecause})`).toBe(true);
        expect(run.reachedLoader, `never reached 0x8000 (${run.stoppedBecause})`).toBe(true);
    });

    maybe('takes the documented route and nothing else', () => {
        // Not just "arrived" but "arrived this way". A jump to 0x8000 that got there through some
        // other path would mean the mechanism is not the one every safety argument is written about.
        const run = boot({ armed: true });
        const route = run.trace.slice(run.trace.indexOf(MAGIC_CHECK));
        expect(route[0]).toBe(MAGIC_CHECK);
        expect(route).toContain(MAGIC_BRANCH);
        expect(route.indexOf(STAGED_ENTRY_TRAMPOLINE)).toBeGreaterThan(route.indexOf(MAGIC_BRANCH));
        expect(route[route.length - 1]).toBe(LOADER_ENTRY);
        // Short, and that matters: this is the whole distance between power-up and running the
        // staged code, and everything in it is BMW's, not ours.
        expect(route.length).toBeLessThan(20);
    });

    /**
     * The claim `probe.s` builds its watchdog handling on, executed.
     *
     * SYPCR is write-once after a reset. The probe asks for the longest software watchdog timeout,
     * and that request only lands if the resident firmware has not already made it. The armed path
     * leaves for 0x8000 before 0x276 is ever reached, so the window is still open; the normal boot
     * goes straight through it.
     */
    maybe('leaves SYPCR unwritten on the armed path, which is what lets the loader set it', () => {
        expect(boot({ armed: true }).trace, 'the armed path must branch away before SYPCR')
            .not.toContain(SYPCR_WRITE);
        expect(boot({ armed: false }).trace, 'a normal boot does reach it')
            .toContain(SYPCR_WRITE);
    });

    /**
     * The negative control, and it carries as much weight as the positive one.
     *
     * If the ECU jumped to 0x8000 regardless of the magic, the positive test would still pass -
     * and it would mean every DME is permanently armed, which is the opposite of what the design
     * assumes. This is what separates "the magic causes the jump" from "the jump happens".
     */
    maybe('does NOT jump there once the magic has been cleared', () => {
        const run = boot({ armed: false });
        expect(run.reachedMagicCheck, `never reached 0x24A (${run.stoppedBecause})`).toBe(true);
        expect(run.reachedLoader, 'a cleared magic must leave the DME booting normally').toBe(false);
        expect(run.reachedTrampoline, 'the staged-entry trampoline must not run either').toBe(false);
        // It carries on into the ordinary firmware rather than stopping at the comparison.
        expect(run.trace).toContain(MAGIC_BRANCH);
        expect(run.trace).toContain(SYPCR_WRITE);
    });

    maybe('is decided by the magic alone, byte for byte', () => {
        // One bit wrong in the magic must not arm the ECU. This is the difference between a
        // comparison and a coincidence, and it is also what makes a partially written magic safe -
        // the ordering rule in `stagedWriteOrder` depends on it.
        const almost = boot({ armed: true, budget: 200_000 });
        expect(almost.reachedLoader).toBe(true);

        const image = Uint8Array.from(master!);
        image[MAGIC_AT] = 0x5a;
        image[MAGIC_AT + 1] = 0xa5;
        image[MAGIC_AT + 2] = 0x56;
        image[MAGIC_AT + 3] = 0xff; // the last byte never landed
        expect(runImage(image).reachedLoader, 'a partial magic must not arm the ECU').toBe(false);
    });

    maybe('takes the application-init route when the AIF looks like a real car', () => {
        // The route, not the outcome. Which branch `0x21A` takes is decided by data, and this is
        // the one thing about the real-car path that is settled: a blanked AIF goes straight to
        // the magic check, a real one goes through BMW's application init first.
        //
        // Every other test in this file boots a distributed image, so every other test takes the
        // short route. On the car it will be the long one.
        const blanked = boot({ armed: true, aif: 'blanked' });
        expect(blanked.reachedMagicCheck).toBe(true);
        expect(blanked.trace, 'a blanked AIF must not reach application init').not.toContain(0x10400);

        const realCar = boot({ armed: true, aif: 'real-car', budget: 200_000 });
        expect(realCar.trace, 'a real-car AIF must go through 0x22A: jsr $10400').toContain(0x10400);
    });

    /**
     * A harness limit, pinned. **Not an open safety question** - that one is settled elsewhere.
     *
     * Whether the real-car route reaches 0x24A is answered by the bootloader's own code, not by
     * this emulator. `jsr $10400` returns to 0x230, which falls through `cmpi.w #$f500,(a2)` and
     * `cmpi.w #$00f5,(a2)` to `0x23A: bne.w $24a`. That runs on EVERY start, with or without the
     * magic - `0x254: bne.b $25c` is what sends an unarmed DME on to its normal boot. So every
     * time any of these cars has ever started, this route called 0x10400, returned, and reached
     * the magic check. Arming changes the result of the comparison, not the path to it.
     * See docs/bootloader-replacement.md §5.2.
     *
     * What remains true is that this harness cannot execute it. Application init is outside the
     * envelope the emulator was validated in (`bmwStubs.test.ts` runs BMW's flash stubs - small,
     * self-contained routines). Three real modelling defects were found and fixed by trying:
     * 24-bit address decoding, TPU parameter RAM at 0xFFFF00, and LINK/UNLK in the core. What
     * stops it now is the next missing piece - MOVEM with displacement addressing, and the DPRAM
     * at 0x13F800 that the application touches.
     *
     * **A failure here is good news**: it means the harness got further. Re-derive what it now
     * proves before deleting the test.
     */
    maybe('cannot be executed all the way here - HARNESS LIMIT, the route itself is settled', () => {
        const run = boot({ armed: true, aif: 'real-car', budget: 5_000_000 });
        expect(run.trace).toContain(0x10400);
        expect(
            run.reachedMagicCheck,
            'the harness got further than it could - re-derive what it proves, then delete this',
        ).toBe(false);
        expect(run.reachedLoader).toBe(false);
    });
});
