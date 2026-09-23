/**
 * The DS2 link: frames on and off a K-line, with the two things that make that line different
 * from a normal serial port.
 *
 * **It is half duplex and everything you send comes back.** A K+DCAN interface echoes each byte
 * you transmit. Code that does not consume the echo reads its own request as if it were the
 * ECU's reply, and then every subsequent exchange is off by one frame - which looks exactly like
 * a flaky cable. The reference tuner consumes and *verifies* the echo; the diagnosis PWA does
 * not, and that is the one place its transport cannot be reused as-is.
 *
 * **A response's length is in its second byte.** So a reader knows when to stop rather than
 * waiting for a timeout. That is what keeps a slow-but-healthy link from being mistaken for a
 * dead one - and on this ECU a healthy link really is slow: a sector erase can take a minute.
 *
 * Everything here is transport-agnostic. `ByteTransport` is the only thing a caller has to
 * provide, so the whole stack runs against a simulated DME in tests and against Web Serial on a
 * car without either side knowing the difference.
 */
import {
    DME_DS2_ADDRESS, buildDs2Frame, parseDs2Frame, expectedDs2Length, toHex,
    classifyEchoMismatch,
    type Ds2Response, type EchoMismatchAnalysis,
} from './ds2';
import { assertHardwareWriteUnlocked, tierForAddress, type WriteTier } from './writeLock';
import { Command } from './telegrams';

/** Bytes in, bytes out. Implemented by Web Serial, by a mock, or by anything else. */
export interface ByteTransport {
    write(bytes: Uint8Array): Promise<void>;
    /** Read exactly `count` bytes, or reject when `timeoutMs` elapses first. */
    read(count: number, timeoutMs: number): Promise<Uint8Array>;
    /**
     * Discard anything buffered, on both sides. Cheap, and deliberately NOT a repair.
     *
     * This clears a stale tail - the previous response still trickling in - and nothing else. A
     * transport whose reader has latched a line fault is not fixed by it, which is why
     * `recoverRead` exists separately and why `Ds2Link.resync` chooses between them. The reference
     * tuner keeps exactly this split (`purge` vs `recoverRead`, chosen by `resyncTransport`); this
     * port collapsed the two into one method, and the collapse is what let a single parity glitch
     * leave the cable deaf for a whole session.
     */
    drain?(): Promise<void>;
    /**
     * Whether the read path has latched a line fault that only `recoverRead` can clear.
     *
     * The link needs this to make two decisions it cannot otherwise make: whether a retry should
     * repair the reader or merely drop a stale tail, and how long to let the line settle first. A
     * transport that does not implement it is treated as never faulted, which is correct for a
     * simulator and the reason this is optional.
     */
    hasReadError?(): boolean;
    /**
     * The latched fault WITHOUT clearing it.
     *
     * Non-consuming by contract, and that is the whole point. If reading the fault cleared it,
     * `hasReadError` would answer false immediately afterwards and the link would drop a stale
     * tail where it needed to restart a dead reader - strictly worse than never looking. Only
     * `recoverRead`, `open` and `setBaudRate` may clear it.
     */
    peekReadError?(): Error | null;
    /**
     * Repair the read path: tear the reader down, let the line settle, flush, and start it again.
     *
     * Expensive and rarely needed, which is why it is not what an ordinary retry calls. A latched
     * break or overrun stops the reader, and no amount of buffer clearing brings it back.
     */
    recoverRead?(): Promise<void>;
    /** Change line speed. Only 9600 / 38400 / 125000 are implemented by this ECU. */
    setBaudRate?(rate: number): Promise<void>;
    /**
     * Set only by a transport with no ECU behind it.
     *
     * This is the key to the hardware write gate: a transport declares its own nature, and one
     * that drives a cable never sets this. No flag, argument or scope in the layers above can make
     * a real transport claim it, which is what keeps destructive telegrams off a car while
     * `HARDWARE_WRITE_ENABLED` is false - see `writeLock.ts`.
     */
    readonly simulated?: true;
}

export type Ds2ErrorKind =
    | 'timeout' | 'echo-mismatch' | 'checksum' | 'malformed' | 'refused-by-write-lock'
    | 'concurrent-exchange';

export class Ds2LinkError extends Error {
    constructor(readonly kind: Ds2ErrorKind, message: string) {
        super(message);
        this.name = 'Ds2LinkError';
    }
}

/**
 * An echo mismatch, carrying the diagnosis as data rather than only as prose.
 *
 * Still a `Ds2LinkError` of kind `echo-mismatch`, so every existing catch and every test that
 * matches on the kind keeps working. What it adds is `analysis`, which lets a caller offer the
 * physical checklist for an electrical fault instead of the "clear it and retry" advice that
 * cannot work when something is pulling the line down.
 */
export class EchoMismatchError extends Ds2LinkError {
    constructor(readonly analysis: EchoMismatchAnalysis, message: string) {
        super('echo-mismatch', message);
        this.name = 'EchoMismatchError';
    }
}

/**
 * Timeouts, taken from the reference implementation's measurements on a real car rather than
 * from a specification.
 *
 * The erase timeout is not a mistake: a 32 KiB sector erase genuinely takes tens of seconds, and
 * a shorter timeout would abandon a healthy ECU in the middle of one.
 */
export const TIMEOUTS = {
    /** An ordinary read or status request. */
    response: 2000,
    /** A write telegram, which the DME acknowledges only after programming the bytes. */
    write: 15000,
    /** A sector erase. */
    erase: 65000,
    /** The echo of our own request - it comes straight back, so this is generous. */
    echo: 2000,
} as const;

/** Read retries, matching the reference tuner's `CHUNK_RETRY_ATTEMPTS`. */
export const READ_RETRY_ATTEMPTS = 5;

/**
 * Write-telegram retries, matching the reference tuner's `WRITE_CHUNK_RETRY_ATTEMPTS`.
 *
 * Same count as the read path, and it must be: `transceiveWrite` retries only the transport
 * failure, and a lost telegram on the write path costs more than one on the read path, not less.
 */
export const WRITE_RETRY_ATTEMPTS = 5;

/** Base backoff between attempts, escalated by attempt number. */
const RETRY_BACKOFF_MS = 300;

/**
 * Base backoff after a LATCHED LINE FAULT, escalated the same way. Longer, and deliberately.
 *
 * Re-acquiring the reader does not repair a disturbed line - only silence does. At 300 ms a
 * failing chunk got about 1.2 s of total settling across all its attempts; at 400 ms it gets 4 s,
 * which is what the reference's `Ds2MemoryReader` gives (1 s x 4) and what made automatic retries
 * start succeeding where a manual retry seconds later already did.
 */
const BREAK_SETTLE_MS = 400;

export interface Ds2LinkOptions {
    readonly address?: number;
    /** Injected so tests do not actually wait. */
    readonly delay?: (ms: number) => Promise<void>;
    /** Called with every frame in each direction, for logging a session. */
    readonly onTraffic?: (direction: 'tx' | 'rx', bytes: Uint8Array) => void;
}

const defaultDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class Ds2Link {
    private readonly address: number;
    private readonly delay: (ms: number) => Promise<void>;
    private readonly onTraffic: ((direction: 'tx' | 'rx', bytes: Uint8Array) => void) | undefined;

    /**
     * Whether a frame is on the wire right now. One at a time, and it is enforced rather than
     * assumed.
     *
     * The K-line is half duplex and every exchange is write-echo-header-body. Two overlapping
     * exchanges do not produce two conversations, they produce one stream of interleaved bytes in
     * which each side reads the other's echo - and the symptom is an echo mismatch that looks
     * exactly like a failing cable. The reference tuner added its `CommandGate` after finding a
     * UI-level guard standing in for a link-level one, and noted that a UI guard holds only while
     * every request comes from a user action.
     *
     * The transport depends on this too: its reader parks a single waiter, which is only sufficient
     * because `read` is never re-entered. That was a comment; this makes it a fact.
     *
     * Scope is deliberately one exchange, not one operation. Sequencing whole operations - not
     * interleaving a read into the middle of an erase-then-write - is the caller's job, and the
     * gate cannot do it: it would deadlock the first operation that legitimately makes several
     * exchanges. What this stops is the corruption that has no other guard.
     */
    private exchanging = false;

    constructor(private readonly transport: ByteTransport, options: Ds2LinkOptions = {}) {
        this.address = options.address ?? DME_DS2_ADDRESS;
        this.delay = options.delay ?? defaultDelay;
        this.onTraffic = options.onTraffic;
    }

    /**
     * Send one telegram and read its reply.
     *
     * `data` starts with the command byte. The frame, the echo and the reply are all handled
     * here; callers deal in telegram payloads and parsed responses.
     */
    async transceive(data: Uint8Array, timeoutMs: number = TIMEOUTS.response): Promise<Ds2Response> {
        this.guardWriteLock(data);
        if (this.exchanging) {
            // Refused rather than queued. A caller that reaches here has a sequencing bug, and
            // queueing would hide it behind an intermittent one - the frames would come out in
            // whatever order the microtasks resolved, which is not an order anyone chose.
            throw new Ds2LinkError('concurrent-exchange',
                'another DS2 exchange is already on the wire; the K-line carries one at a time');
        }
        this.exchanging = true;
        try {
            return await this.exchange(data, timeoutMs);
        } finally {
            this.exchanging = false;
        }
    }

    private async exchange(data: Uint8Array, timeoutMs: number): Promise<Ds2Response> {
        const frame = buildDs2Frame(this.address, data);
        this.onTraffic?.('tx', frame);
        await this.transport.write(frame);

        // The K-line echoes our own bytes back. Consuming them is mandatory; checking them is
        // cheap and turns a bus collision into a clear error instead of a corrupt response.
        const echo = await this.readOrThrow(frame.length, TIMEOUTS.echo, 'echo');
        if (!sameBytes(echo, frame)) {
            // Say WHICH of the two failures this is rather than leaving it to be guessed. A desync
            // is repaired by clearing the buffer; an electrical fault is not repaired by retrying
            // at all, and its operator needs to be under the dashboard rather than tapping retry.
            // The analysis rides along on the error so a caller can act on the verdict as data.
            const a = classifyEchoMismatch(frame, echo);
            const latched = this.transport.peekReadError?.() ?? null;
            throw new EchoMismatchError(a,
                `K-line echo does not match what was sent.\n  sent: ${toHex(frame)}\n  echo: ${toHex(echo)}`
                + `\n  ${a.verdict}`
                + `\n  [lag +${a.lag}, ${a.flips1to0} bit(s) 1->0, ${a.flips0to1} bit(s) 0->1,`
                + ` ${a.trailingZeroRun}-byte zero tail`
                + `${latched ? `, latched ${latched.name}` : ''}]`);
        }

        // The reply's length lives in its second byte, so read the header first and then exactly
        // as much as it declares.
        const header = await this.readOrThrow(2, timeoutMs, 'response header');
        // The address comes first, and it is checked BEFORE the length byte is believed.
        //
        // Out of frame, a bogus length is not a harmless bad read: it makes the next line consume
        // up to 253 further bytes, which swallows the response that was actually coming and leaves
        // every exchange after it one frame behind. Checking the address costs one comparison and
        // turns that cascade into a single clear error. (The guard that used to stand here tested
        // `declared > 0xff` on a value read out of one byte, so it could never fire.)
        if (header[0] !== this.address) {
            throw new Ds2LinkError('malformed',
                'response out of frame: expected address'
                + ` 0x${this.address.toString(16).padStart(2, '0')}, got ${toHex(header)}`);
        }
        const declared = expectedDs2Length(header);
        if (declared < 3) {
            throw new Ds2LinkError('malformed',
                `response declared a length of ${declared}, which cannot be a DS2 frame`);
        }
        const rest = await this.readOrThrow(declared - 2, timeoutMs, 'response body');

        const full = new Uint8Array(declared);
        full.set(header, 0);
        full.set(rest, 2);
        this.onTraffic?.('rx', full);

        const parsed = parseDs2Frame(full);
        if (!parsed.ok) {
            throw new Ds2LinkError(parsed.error?.includes('checksum') ? 'checksum' : 'malformed',
                `${parsed.error}\n  frame: ${toHex(full)}`);
        }
        return parsed;
    }

    /**
     * Ready the read side for a fresh attempt, choosing the repair that fits the damage.
     *
     * A latched break or overrun has STOPPED the reader, and no amount of buffer clearing brings
     * it back; a plain stale tail only needs the buffer dropped, and tearing the reader down for
     * one would cost a settle period on every ordinary retry. The reference tuner makes exactly
     * this choice in `resyncTransport`, and it is the piece this port had lost - `drain` was being
     * asked to do both jobs and could only do one.
     */
    private async resync(): Promise<void> {
        if (this.transport.hasReadError?.()) await this.transport.recoverRead?.();
        else await this.transport.drain?.();
    }

    /**
     * How long to let the line settle before the next attempt.
     *
     * Escalating, and longer after a latched fault. A flat delay is what made every automatic
     * retry burn in almost no time once the line had glitched, while a manual retry seconds later
     * worked - the retries were not giving the wire the one thing it needed, which is silence.
     */
    private settleFor(attempt: number): number {
        const base = this.transport.hasReadError?.() ? BREAK_SETTLE_MS : RETRY_BACKOFF_MS;
        return base * attempt;
    }

    /**
     * Send a telegram that is safe to repeat, retrying on a link fault.
     *
     * Only for reads and status requests. A write goes through `transceiveWrite`, which retries a
     * strictly narrower thing.
     */
    async transceiveIdempotent(
        data: Uint8Array,
        timeoutMs: number = TIMEOUTS.response,
        attempts = READ_RETRY_ATTEMPTS,
    ): Promise<Ds2Response> {
        let lastError: unknown;
        for (let attempt = 1; attempt <= attempts; attempt++) {
            try {
                return await this.transceive(data, timeoutMs);
            } catch (error) {
                if (error instanceof Ds2LinkError && error.kind === 'refused-by-write-lock') throw error;
                lastError = error;
                if (attempt === attempts) break;
                // Delay FIRST, then resync. The other order clears the buffer while the DME's late
                // response is still arriving, so those bytes land in the freshly emptied buffer and
                // desync the very attempt the clear was meant to protect. This port had the two the
                // wrong way round; the reference has delayed-then-resynced since the bug that
                // taught it.
                await this.delay(this.settleFor(attempt));
                await this.resync();
            }
        }
        throw lastError;
    }

    /**
     * Send one WRITE telegram, retrying the telegram - and only the telegram - on a link fault.
     *
     * Ported from the reference's `writeChunkTelegramWithRetry`, whose absence here was an
     * asymmetry pointing the wrong way. The read path has had five attempts since it was written;
     * the write path had none, and the write path is the one that runs **after an erase**. A single
     * lost telegram - one break, one timeout - therefore failed an entire flash on an ECU whose
     * program window was already gone, with nothing to catch it.
     *
     * **Validation deliberately stays in the caller, outside this loop.** A timeout means the
     * telegram never landed and re-sending it is right. An acknowledgement carrying "verify failed"
     * or "cells not erased" means the DME received it, tried, and could not; re-sending that would
     * paper over failing flash on a twenty-year-old ECU and then report success. The reference
     * splits it the same way and catches only the transport failure, for the same reason.
     *
     * Re-sending is safe because a DS2 write is one telegram: the DME either processed it or did
     * not, and writing the same bytes to the same address twice is idempotent. The acknowledgement's
     * next-address field, checked by the caller, catches any desync afterwards.
     *
     * The write lock is re-checked on every attempt, because `transceive` checks it - a retry
     * cannot become a route around the gate.
     */
    async transceiveWrite(
        data: Uint8Array,
        timeoutMs: number = TIMEOUTS.write,
        attempts = WRITE_RETRY_ATTEMPTS,
    ): Promise<Ds2Response> {
        let lastError: unknown;
        for (let attempt = 1; attempt <= attempts; attempt++) {
            try {
                return await this.transceive(data, timeoutMs);
            } catch (error) {
                if (error instanceof Ds2LinkError && error.kind === 'refused-by-write-lock') throw error;
                lastError = error;
                if (attempt === attempts) break;
                // `resync` only touches the READ side - it drops a stale tail or restarts a stopped
                // reader - so it sends nothing to the DME and cannot disturb the programming session
                // this is running inside.
                await this.delay(this.settleFor(attempt));
                await this.resync();
            }
        }
        throw lastError;
    }

    /**
     * The gate that actually protects an ECU.
     *
     * `telegrams.ts` refuses to *build* a destructive telegram; this refuses to *send* one, so a
     * byte sequence obtained some other way - a literal, a log, a test fixture, a simulation that
     * built it legitimately - still cannot reach a car.
     *
     * The decision reads `this.transport.simulated`, which only a transport with no ECU behind it
     * sets. That is deliberate and it is the whole design: practice mode needs to send these
     * telegrams, and the way it is allowed to is by there being nothing on the other end - not by
     * anyone up the stack passing a flag.
     */
    private guardWriteLock(data: Uint8Array): void {
        const command = data[0];
        if (command !== Command.ProgramControl && command !== Command.Jump) return;

        /**
         * The tier comes out of the telegram, not out of an argument.
         *
         * A ProgramControl telegram is `07 <segment> <addr hi mid lo> ...`, and those three bytes
         * are the whole reason one of these is recoverable and another is not. Reading them here
         * means this gate cannot be widened by any caller, any scope or any mislabelled plan up
         * the stack - the bytes about to go out on the cable say which tier they are.
         *
         * Command 0x34 carries no flash address: it is the staged-loader transfer, which exists
         * only to arm. It is never reversible.
         *
         * Neither is anything too short to carry an address. Reading a missing byte as zero would
         * have made a truncated `07 ..` telegram look like DS2 0x000000 - the master Free
         * Identifiers sector, the most permissive answer there is. A gate that resolves missing
         * data in the direction of "allowed" is the wrong gate, whatever it is guarding.
         */
        const tier: WriteTier = command === Command.Jump || data.length < 5
            ? 'irreversible'
            : tierForAddress((data[2]! << 16) | (data[3]! << 8) | data[4]!);

        try {
            assertHardwareWriteUnlocked(
                `command 0x${(command ?? 0).toString(16)} (${tier})`,
                this.transport.simulated === true, tier);
        } catch (error) {
            throw new Ds2LinkError('refused-by-write-lock',
                error instanceof Error ? error.message : String(error));
        }
    }

    private async readOrThrow(count: number, timeoutMs: number, what: string): Promise<Uint8Array> {
        try {
            const bytes = await this.transport.read(count, timeoutMs);
            if (bytes.length !== count) {
                throw new Ds2LinkError('timeout',
                    `${what}: got ${bytes.length} of ${count} bytes before the link went quiet`);
            }
            return bytes;
        } catch (error) {
            if (error instanceof Ds2LinkError) throw error;
            throw new Ds2LinkError('timeout',
                `${what}: no reply within ${timeoutMs} ms`
                + ' (ignition on? correct ECU address? interface in K-line mode?)');
        }
    }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}
