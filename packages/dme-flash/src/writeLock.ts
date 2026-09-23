/**
 * The gate between "this tool can compute a destructive telegram" and "those bytes reach a cable".
 *
 * Why a module for this: every other safety property in the package is a *validator* - it decides
 * whether a plan is well formed. None of them stop a correct plan from being sent. For bootloader
 * work that distinction is the whole thing, because the dangerous operation is not a malformed
 * telegram, it is a perfectly well formed one issued before the loader has been proven on a bench.
 *
 * ## Two gates, and only one of them is the safety property
 *
 *   1. **The build gate** (`assertWriteUnlocked`, called by every destructive builder) stops the
 *      bytes from existing. It is defence in depth: bytes that were never produced cannot be
 *      logged, cached, pasted into a terminal, or reached by a second code path.
 *   2. **The hardware gate** (`assertHardwareWriteUnlocked`, called by the transport) stops the
 *      bytes from being transmitted. **This is the one that protects an ECU**, and it is the one
 *      that has no exceptions.
 *
 * ## Simulation
 *
 * Practice mode has to walk the whole sequence - erase, program, arm, power cycle, verify - or it
 * is not practice. Doing that requires building those telegrams, so the build gate opens inside
 * `withSimulatedEcu`.
 *
 * The hardware gate does not, and cannot: it is keyed on **the transport declaring itself a
 * simulator**, not on any flag a caller can set. A `ByteTransport` that talks to a cable never sets
 * `simulated`, so no scope, argument or mistake in the layers above can send a destructive telegram
 * to real hardware while `HARDWARE_WRITE_ENABLED` is false. The safety property is not "the builder
 * refused" - it is "the only transports that accept these bytes have no ECU behind them".
 *
 * `writeLock.test.ts` pins both halves.
 */

/**
 * Master switch for real hardware. While false, no destructive telegram reaches a cable, whatever
 * else is going on.
 *
 * **BDM is not a precondition of this switch, and saying it was misdescribed the tool.** The whole
 * point of this project is that the bootloader is replaced over OBD alone - no ECU is opened, no
 * probe is soldered, and BDM appears nowhere in the sequence that does the work. BDM is insurance
 * against a loader that fails after the magic is written, and whether to run without that insurance
 * is the owner's risk decision, not a technical gate this file gets to impose.
 *
 * What flipping this actually asserts is narrower: that the offline emulator run passes, that the
 * transport has been exercised against something, and that the operator intends to write to a real
 * ECU now. Do not flip it to make a test pass; practice mode does not need it flipped.
 */
export const HARDWARE_WRITE_ENABLED = false as const;

/**
 * How much of an ECU an operation can take away.
 *
 *  - `reversible`   FAST ENTRY, and nothing else: erase the Free Identifiers sector and put it
 *                   straight back. One 8 KiB sector, the bytes that go back were read off the same
 *                   DME moments earlier, `recoverFastEntry` exists for the failure in between, and
 *                   the reference tool has done it on real cars more than twenty times without
 *                   one. It never touches SA0 and it never touches the magic.
 *  - `irreversible` Arming, and the bootloader replacement. The magic at 0xFFFC is read by the
 *                   reset handler at 0x24A BEFORE the SIM, the stack or the K-line come up, so
 *                   from the moment it is programmed a loader that does not run cannot be reached
 *                   over OBD again - with SA0 perfectly intact. There is no rehearsal: the first
 *                   arming is the first execution.
 *
 * One switch used to cover both. That put a twenty-times-proven, recoverable operation behind the
 * same gate as the point of no return, so the only way to exercise the write path on a car at all
 * was to also authorise the one thing BDM insures against. The consequences differ by orders of
 * magnitude; the gates now do too.
 */
export type WriteTier = 'reversible' | 'irreversible';

/**
 * FAST ENTRY only. Open, so the boosted read can be exercised on a car.
 *
 * What this authorises is bounded by `tierForAddress` below, which reads the address out of the
 * telegram: only the two Free Identifiers sectors and the fast-entry control addresses are
 * reversible, and everything else - the staging area, the magic, SA0 - stays behind
 * `HARDWARE_WRITE_ENABLED`. It is not a general write permission and it cannot become one by
 * anybody labelling an operation differently.
 */
export const FAST_ENTRY_WRITE_ENABLED: boolean = true;

/**
 * The two Free Identifiers sectors, in DS2 address space.
 *
 * Mirrors `SERVICE_BLOCK_DS2` and `FREE_IDENTIFIERS.length` from `fastEntry.ts`, which cannot be
 * imported here: `telegrams.ts` needs this function and `fastEntry.ts` imports `telegrams.ts`.
 * `writeTier.test.ts` pins the mirror against the real constants, so a change on either side that
 * moved them apart fails there rather than quietly widening what "reversible" means.
 */
const SERVICE_BLOCK_WINDOWS: readonly (readonly [number, number])[] = [
    [0x000000, 0x002000], // master
    [0x800000, 0x802000], // slave
];

/**
 * `RECYCLE_ONLY_ADDRESS` / `RECYCLE_OFF_ADDRESS` from `fastEntry.ts`.
 *
 * These select a flash controller mode rather than modifying a cell, and they are part of the
 * fast-entry sequence, so they have to be reachable for it to run at all. Listing them by exact
 * value rather than by a range is the point: the irreversible flows are already stopped at their
 * builders and again at their flash addresses, and this admits two specific control telegrams
 * rather than an interval that something else could grow into.
 */
const RECYCLING_CONTROL: readonly number[] = [0x424151, 0x424152];

/**
 * What tier a telegram aimed at this DS2 address belongs to.
 *
 * Derived from the address because the address is what decides which cells change. A `tier`
 * parameter passed down from a caller would make the classification a claim, and the failure that
 * matters is precisely a claim that does not match the bytes - the same reason `validateBlReplace`
 * re-derives a sector's purpose instead of trusting its label.
 */
export function tierForAddress(ds2Address: number): WriteTier {
    if (RECYCLING_CONTROL.includes(ds2Address)) return 'reversible';
    for (const [start, end] of SERVICE_BLOCK_WINDOWS) {
        if (ds2Address >= start && ds2Address < end) return 'reversible';
    }
    return 'irreversible';
}

/** Whether a tier may reach hardware at all. Never call this instead of an assert. */
export function tierEnabled(tier: WriteTier): boolean {
    return tier === 'reversible' ? FAST_ENTRY_WRITE_ENABLED : HARDWARE_WRITE_ENABLED;
}

/** Thrown instead of returning a byte sequence that could modify an ECU. */
export class WriteLockedError extends Error {
    constructor(what: string) {
        super(
            `refusing to build "${what}": hardware writes are locked.`
            + ' Set HARDWARE_WRITE_ENABLED in packages/dme-flash/src/writeLock.ts to true when you'
            + ' intend to write to a real ECU.');
        this.name = 'WriteLockedError';
    }
}

/** Thrown when destructive bytes are handed to a transport that has an ECU on the other end. */
export class HardwareWriteLockedError extends Error {
    constructor(what: string) {
        super(
            `refusing to send ${what} to hardware: writes are locked.`
            + ' This is the gate that protects an ECU, and a simulation scope does not open it.');
        this.name = 'HardwareWriteLockedError';
    }
}

/**
 * Depth counter rather than a boolean, so nested scopes cannot close the gate early.
 *
 * Module-scoped mutable state is normally a smell. It is used here because the alternative -
 * threading a capability token through every builder - would put a parameter on each destructive
 * function whose *absence* is what keeps it safe, and a parameter that must never be passed by
 * accident is a worse shape than a scope that is only opened in one file.
 */
let simulationDepth = 0;

/**
 * Run `fn` with the BUILD gate open, for a simulated ECU.
 *
 * Called from exactly one place - the practice runner - and it does not, and cannot, open the
 * hardware gate. Restores the previous depth even if `fn` throws, which is the case that matters:
 * a failed practice run must not leave the builders unlocked for whatever runs next.
 */
export async function withSimulatedEcu<T>(fn: () => Promise<T>): Promise<T> {
    simulationDepth++;
    try {
        return await fn();
    } finally {
        simulationDepth--;
    }
}

/** True while a simulated run is building telegrams. For reporting; never to skip an assert. */
export function simulating(): boolean {
    return simulationDepth > 0;
}

/**
 * Call first in any function that RETURNS bytes capable of erasing, programming or transferring
 * control. Opens inside `withSimulatedEcu` - see the module note for why that is safe.
 */
export function assertWriteUnlocked(what: string, tier: WriteTier = 'irreversible'): void {
    if (tierEnabled(tier) || simulationDepth > 0) return;
    throw new WriteLockedError(what);
}

/**
 * Call before destructive bytes go out on a transport.
 *
 * `simulated` comes from the transport itself, so the caller cannot assert it on a real one. This
 * function deliberately ignores `withSimulatedEcu`: the scope says "a simulator asked for these
 * bytes", and only the transport can say "and there is no ECU here to receive them".
 */
export function assertHardwareWriteUnlocked(
    what: string, transportIsSimulated: boolean, tier: WriteTier = 'irreversible',
): void {
    if (transportIsSimulated || tierEnabled(tier)) return;
    throw new HardwareWriteLockedError(what);
}

/** True when a telegram may be sent to real hardware. For UI state, never to skip the assert. */
export function writesAreUnlocked(tier: WriteTier = 'irreversible'): boolean {
    return tierEnabled(tier);
}
