/**
 * The DS2 link's recovery behaviour, against a transport that can be made to misbehave on cue.
 *
 * Everything here was found by reading this port against the reference tuner rather than by a
 * failing test, which is the uncomfortable part: this file is the whole link layer's first direct
 * coverage, and four of the six cases below are regressions the port introduced by collapsing
 * structure the reference had already paid for.
 *
 * The transport is faked, not the link. `Ds2Link` does its own framing, its own echo check and its
 * own retry loop in every case.
 */
import { describe, it, expect } from 'vitest';
import { Ds2Link, Ds2LinkError, EchoMismatchError, type ByteTransport } from './transport';
import { buildDs2Frame, classifyEchoMismatch, DME_DS2_ADDRESS, Ds2Status } from './ds2';

/** A well-formed ACK frame with no payload beyond the status byte. */
function ack(): Uint8Array {
    return buildDs2Frame(DME_DS2_ADDRESS, new Uint8Array([Ds2Status.Ack]));
}

/** What the transport was asked to do, in order, so a test can assert on the ORDER. */
type Event = 'write' | 'read' | 'drain' | 'recoverRead' | `delay:${number}`;

interface Script {
    /** Bytes to hand back, in order. A `null` entry makes that read reject instead. */
    readonly responses: readonly (Uint8Array | null)[];
}

/**
 * A transport with a script and a log.
 *
 * `faulted` is settable so a test can put the link in the state a real break produces - the one
 * where `drain` is the wrong repair - without needing a real FTDI chip to produce it.
 */
class ScriptedTransport implements ByteTransport {
    readonly events: Event[] = [];
    faulted = false;
    private buffer: number[] = [];
    private turn = 0;

    constructor(private readonly script: Script) {}

    async write(bytes: Uint8Array): Promise<void> {
        this.events.push('write');
        // The K-line echo, which the link consumes before the response.
        for (const b of bytes) this.buffer.push(b);
        const next = this.script.responses[this.turn++];
        if (next === null) { this.failNext = true; return; }
        if (next) for (const b of next) this.buffer.push(b);
    }

    private failNext = false;

    async read(count: number, _timeoutMs: number): Promise<Uint8Array> {
        this.events.push('read');
        if (this.failNext && this.buffer.length < count) {
            this.failNext = false;
            this.faulted = true;
            throw new Error('Parity error');
        }
        if (this.buffer.length < count) throw new Error('timed out');
        return Uint8Array.from(this.buffer.splice(0, count));
    }

    async drain(): Promise<void> {
        this.events.push('drain');
        this.buffer = [];
    }

    hasReadError(): boolean { return this.faulted; }
    peekReadError(): Error | null { return this.faulted ? new Error('Parity error') : null; }
    async recoverRead(): Promise<void> {
        this.events.push('recoverRead');
        this.buffer = [];
        this.faulted = false;
    }
}

function linkOver(t: ScriptedTransport): Ds2Link {
    return new Ds2Link(t, { delay: async (ms) => { t.events.push(`delay:${ms}`); } });
}

describe('choosing the repair that fits the damage', () => {
    it('drops a stale tail with drain, and rebuilds the reader only when one is broken', async () => {
        // The collapsed version could only do one of these, and it did the cheap one - so a
        // latched break left the reader stopped and every later read blamed a timeout.
        const t = new ScriptedTransport({ responses: [null, ack()] });
        const link = linkOver(t);

        await link.transceiveIdempotent(new Uint8Array([0x00]));

        expect(t.events).toContain('recoverRead');
        expect(t.events, 'a broken reader must not be "repaired" by a buffer clear')
            .not.toContain('drain');
    });

    it('uses the cheap repair when nothing is broken', async () => {
        // A response that merely arrived late needs the buffer dropped, not the reader torn down
        // and a settle period paid. Doing the expensive one every time is its own bug.
        const t = new ScriptedTransport({ responses: [undefined as unknown as Uint8Array, ack()] });
        const link = linkOver(t);

        await link.transceiveIdempotent(new Uint8Array([0x00]));

        expect(t.events).toContain('drain');
        expect(t.events).not.toContain('recoverRead');
    });
});

describe('the order of a retry', () => {
    it('settles before it resynchronizes, not after', async () => {
        // Clearing the buffer first lets the DME's late response land in the freshly emptied
        // buffer, which desyncs the very attempt the clear was meant to protect. This port had the
        // two the wrong way round.
        const t = new ScriptedTransport({ responses: [undefined as unknown as Uint8Array, ack()] });
        await linkOver(t).transceiveIdempotent(new Uint8Array([0x00]));

        const delayAt = t.events.findIndex((e) => e.startsWith('delay:'));
        const clearAt = t.events.findIndex((e) => e === 'drain' || e === 'recoverRead');
        expect(delayAt).toBeGreaterThanOrEqual(0);
        expect(delayAt, 'delay must come before the resync').toBeLessThan(clearAt);
    });

    it('gives a disturbed line longer than a late one, and escalates', async () => {
        // Re-acquiring the reader does not repair a disturbed line; only silence does. A flat
        // backoff is what let every automatic retry burn in almost no time after a glitch.
        const broken = new ScriptedTransport({ responses: [null, null, ack()] });
        await linkOver(broken).transceiveIdempotent(new Uint8Array([0x00]));
        const brokenDelays = broken.events.filter((e) => e.startsWith('delay:'));

        const late = new ScriptedTransport({
            responses: [undefined as unknown as Uint8Array, undefined as unknown as Uint8Array, ack()],
        });
        await linkOver(late).transceiveIdempotent(new Uint8Array([0x00]));
        const lateDelays = late.events.filter((e) => e.startsWith('delay:'));

        expect(brokenDelays).toEqual(['delay:400', 'delay:800']);
        expect(lateDelays).toEqual(['delay:300', 'delay:600']);
    });
});

describe('a write telegram', () => {
    /**
     * The asymmetry that pointed the wrong way.
     *
     * The read path has had five attempts since it was written. The write path had none - and the
     * write path is the one that runs after an erase, so one lost telegram failed an entire flash
     * on an ECU whose program window was already gone.
     */
    it('is retried when the telegram is lost on the wire', async () => {
        const t = new ScriptedTransport({ responses: [null, ack()] });
        const response = await linkOver(t).transceiveWrite(new Uint8Array([0x00]));
        expect(response.ok).toBe(true);
    });

    it('still refuses to be sent while the write lock is shut, on every attempt', async () => {
        // A retry loop must never become a route around the gate.
        const t = new ScriptedTransport({ responses: [null, ack()] });
        await expect(linkOver(t).transceiveWrite(new Uint8Array([0x07, 0x00])))
            .rejects.toMatchObject({ kind: 'refused-by-write-lock' });
        // Refused before anything reached the wire, and not tried again.
        expect(t.events).not.toContain('write');
    });
});

describe('a response that is out of frame', () => {
    it('is rejected on its address rather than believed and read past', async () => {
        // A bogus length byte makes the link consume up to 253 further bytes, swallowing the
        // response that was actually coming and leaving every exchange after it one frame behind.
        // The guard that used to stand here tested `declared > 0xff` on a value read out of one
        // byte, so it could never fire.
        const bogus = Uint8Array.from([0x99, 0xfe, 0x00, 0x00]);
        const t = new ScriptedTransport({ responses: [bogus] });

        await expect(linkOver(t).transceive(new Uint8Array([0x00])))
            .rejects.toThrow(/out of frame: expected address 0x12/);
    });
});

describe('telling the two echo failures apart', () => {
    /**
     * Bit direction is the discriminator, and it is physics rather than a heuristic: another
     * driver on a K-line can only pull it LOW, so an interfering device turns 1 bits into 0 bits
     * and never the reverse.
     *
     * The two answers lead to opposite advice, which is why the distinction is worth code. A
     * desync is repaired by clearing the buffer, and sending someone to check their cable is a
     * wasted trip. An electrical fault is not repaired by retrying at all.
     */
    it('calls it electrical when every corrupted bit went 1 to 0', () => {
        const sent = Uint8Array.from([0x12, 0x04, 0xff, 0xa5, 0x5a]);
        const got = Uint8Array.from([0x12, 0x04, 0xfe, 0xa1, 0x0a]);
        const a = classifyEchoMismatch(sent, got);
        expect(a.kind).toBe('electrical');
        expect(a.flips0to1).toBe(0);
        expect(a.verdict).toMatch(/Retrying cannot repair this/);
    });

    it('calls it a desync when a DS2 response was read where the echo belonged', () => {
        const sent = Uint8Array.from([0x12, 0x05, 0x0b, 0x00, 0x1c]);
        const stale = buildDs2Frame(DME_DS2_ADDRESS, new Uint8Array([Ds2Status.Ack, 0x00]));
        const a = classifyEchoMismatch(sent, stale);
        expect(a.kind).toBe('desync');
        expect(a.verdict).toMatch(/software can repair/);
    });

    it('calls a line held low electrical even without a clean bit story', () => {
        const sent = Uint8Array.from([0x12, 0x05, 0x0b, 0x00, 0x1c]);
        const a = classifyEchoMismatch(sent, Uint8Array.from([0x12, 0x05, 0x00, 0x00, 0x00]));
        expect(a.kind).toBe('electrical');
        expect(a.trailingZeroRun).toBe(3);
    });

    it('reaches the operator through the error, as data and not only as prose', async () => {
        const t = new ScriptedTransport({ responses: [] });
        // Answer the echo read with something that is not our frame.
        t.events.length = 0;
        const link = new Ds2Link({
            write: async () => {},
            read: async (count) => Uint8Array.from({ length: count }, () => 0x00),
        }, { delay: async () => {} });

        const error = await link.transceive(new Uint8Array([0x00])).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(EchoMismatchError);
        expect(error).toBeInstanceOf(Ds2LinkError);
        expect((error as Ds2LinkError).kind, 'existing catches keep working').toBe('echo-mismatch');
        expect((error as EchoMismatchError).analysis.kind).toBe('electrical');
    });
});

describe('one frame on the wire at a time', () => {
    /**
     * The K-line is half duplex and every exchange is write-echo-header-body. Two overlapping
     * exchanges do not make two conversations, they make one stream of interleaved bytes in which
     * each side reads the other's echo - and the symptom is an echo mismatch indistinguishable
     * from a failing cable.
     *
     * The transport's parked reader also depends on this: it keeps a single waiter, which is only
     * enough because `read` is never re-entered. That was a comment until now.
     */
    it('refuses a second exchange instead of interleaving it', async () => {
        let release: (() => void) | undefined;
        const held = new Promise<void>((r) => { release = r; });
        const frame = buildDs2Frame(DME_DS2_ADDRESS, new Uint8Array([0x00]));
        const reply = ack();
        const stream = [...frame, ...reply];
        let at = 0;

        const link = new Ds2Link({
            write: async () => { await held; },
            read: async (count) => Uint8Array.from(stream.slice(at, at += count)),
        }, { delay: async () => {} });

        const first = link.transceive(new Uint8Array([0x00]));
        await expect(link.transceive(new Uint8Array([0x00])))
            .rejects.toMatchObject({ kind: 'concurrent-exchange' });

        release!();
        expect((await first).ok).toBe(true);
    });

    it('lets the next exchange through once the wire is free, including after a failure', async () => {
        const t = new ScriptedTransport({ responses: [ack(), ack()] });
        const link = linkOver(t);
        expect((await link.transceive(new Uint8Array([0x00]))).ok).toBe(true);

        const bad = new ScriptedTransport({ responses: [Uint8Array.from([0x99, 0x04, 0x00, 0x00])] });
        const failing = linkOver(bad);
        await expect(failing.transceive(new Uint8Array([0x00]))).rejects.toThrow();
        // The gate must be released by the failure too, or one bad frame ends the session.
        bad.events.length = 0;
        await expect(failing.transceive(new Uint8Array([0x00])))
            .rejects.not.toMatchObject({ kind: 'concurrent-exchange' });
    });
});
