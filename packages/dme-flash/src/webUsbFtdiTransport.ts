/**
 * The FTDI vendor protocol over WebUSB - the Android backend, and the only one a phone has.
 *
 * ## Why this exists
 *
 * Chrome for Android exposes `navigator.serial`, but it enumerates Bluetooth RFCOMM only: a USB
 * K+DCAN cable never appears in its picker. WebUSB is not a preference here, it is the sole route.
 *
 * On Windows the reverse holds and this file must never be used there - Chromium claims USB
 * devices through WinUSB, an FTDI cable is bound to `ftdibus.sys`, and rebinding it removes the COM
 * port and breaks INPA / Tool32 / ISTA. There is no desktop backend: this app is Android only,
 * and `platform.ts` refuses to open a cable anywhere else.
 *
 * ## The one thing that is genuinely better here
 *
 * **Baud changes in place.** One vendor control transfer on the still-open handle; the read loop
 * never stops and DTR/RTS never move. Web Serial has no such call, so its `setBaudRate` must
 * `close()` then `open()`, which pulses the control lines mid-session - a disturbance no other DS2
 * tool produces, and the first thing to suspect whenever a fault appears only after a rate switch.
 *
 * That difference is not cosmetic for this project. The 125000 boost is only reachable from inside
 * a programming session, i.e. with something on the ECU already erased, and it is exactly there
 * that a port transition is least affordable. The phone is the safer place to do it.
 *
 * ## The one thing that is worse
 *
 * With Web Serial the browser process drains the endpoint for us. Here the only thing draining the
 * FT232R's 256-byte RX FIFO is the loop below, on the same thread as the UI. At 9600 that FIFO is
 * ~267 ms of headroom, so a long main-thread stall can overrun the chip. It is detected rather than
 * silent - the OE bit arrives in a status header and latches a `BufferOverrunError` - and the link's
 * retry path recovers by calling `drain`, which puts the reader back.
 *
 * ## Two repairs, not one
 *
 * `drain` drops a stale tail. `recoverRead` rebuilds a reader that a line fault stopped. They are
 * separate because they cost different amounts and fix different things, and the link picks between
 * them by asking `hasReadError`.
 *
 * This file used to have only `drain`, doing both jobs and succeeding at one: every fault path in
 * the pump latched and returned, leaving the loop dead, and `drain` cleared the error and restarted
 * nothing. One parity glitch in a 62-minute read left the cable deaf for the rest of the session.
 * The reference tuner has had `purge` and `recoverRead` as distinct methods since before this port
 * was written, along with the rule that makes them work - `peekReadError` does not consume the
 * latch, because a transport that forgets its own fault the moment anyone looks reports a healthy
 * reader that is not running.
 *
 * This module deliberately references no DOM globals. The caller obtains a device (which is where
 * `navigator.usb` lives) and hands it in rather than reaching for the global. That
 * keeps the package compiling under `lib: ES2022` and lets a fake device drive it in tests.
 */
import type { ByteTransport } from './transport';

/** The subset of WebUSB this needs, declared so the package does not depend on DOM types. */
export interface UsbDeviceLike {
    readonly vendorId: number;
    /** bcdDevice major. 2 = FT232AM, 4 = FT232BM, 6 = FT232R. */
    readonly deviceVersionMajor: number;
    readonly configuration: UsbConfigurationLike | null;
    open(): Promise<void>;
    close(): Promise<void>;
    selectConfiguration(value: number): Promise<void>;
    claimInterface(n: number): Promise<void>;
    releaseInterface(n: number): Promise<void>;
    clearHalt(direction: 'in' | 'out', endpointNumber: number): Promise<void>;
    controlTransferOut(setup: UsbControlSetup): Promise<{ status?: string }>;
    transferIn(endpointNumber: number, length: number): Promise<UsbInResult>;
    transferOut(endpointNumber: number, data: Uint8Array): Promise<{ status?: string }>;
}
export interface UsbControlSetup {
    requestType: 'vendor';
    recipient: 'device';
    request: number;
    value: number;
    index: number;
}
export interface UsbInResult {
    readonly status?: string;
    readonly data?: { readonly byteLength: number; getUint8(offset: number): number };
}
export interface UsbConfigurationLike {
    readonly interfaces: readonly UsbInterfaceLike[];
}
export interface UsbInterfaceLike {
    readonly interfaceNumber: number;
    readonly alternate: { readonly endpoints: readonly UsbEndpointLike[] };
}
export interface UsbEndpointLike {
    readonly endpointNumber: number;
    readonly direction: string;
    readonly type: string;
    readonly packetSize: number;
}

/** FTDI's USB vendor ID. Use it as the chooser filter: a CH340 cable can then never reach here. */
export const FTDI_VENDOR_ID = 0x0403;

const SIO_RESET = 0x00;
const SIO_SET_MODEM_CTRL = 0x01;
const SIO_SET_FLOW_CTRL = 0x02;
const SIO_SET_BAUD_RATE = 0x03;
const SIO_SET_DATA = 0x04;
const SIO_SET_LATENCY_TIMER = 0x09;

const SIO_RESET_SIO = 0;
/**
 * Flush the *receive* buffer.
 *
 * The polarity is a known trap: libftdi <= 1.4 exposed `SIO_RESET_PURGE_RX = 1`, but 1.5 deprecated
 * those and shipped `ftdi_tciflush()` - the input flush - using 2, because the old naming had RX
 * and TX swapped. 2 is the corrected value.
 */
const SIO_RESET_PURGE_RX = 2;

/** Port A. libftdi passes 1 for single-channel parts, ftdi_sio passes 0; the firmware takes both.
 *  Written down so nobody "fixes" it in one direction and creates a difference to chase. */
const FTDI_PORT_INDEX = 1;

/**
 * 8 data bits, even parity, 1 stop bit: `8 | (2 << 8)`.
 *
 * **Mandatory.** DS2/MSS54 is even-parity; an 8N1 receiver faults on every byte
 * with even popcount, and both `0x12` and `0xA0` qualify, so nothing would ever be received.
 */
const FTDI_DATA_8E1 = 0x0208;

/** DTR and RTS both de-asserted in one request: state bits 0/1, enable-mask bits 8/9.
 *  Some K+DCAN cables gate the K-line transceiver with these, so the polarity has to be exact. */
const FTDI_MODEM_DTR_LOW_RTS_LOW = 0x0300;

/**
 * Latency timer, ms. **16 - the chip default - and deliberately not lower.**
 *
 * It is not a throughput lever: the reference tool swept it on a car and 135 -> 14 wakeups per
 * chunk changed nothing, with 16 ms measuring 5.7% *faster*. And the chip emits a 2-byte status
 * packet on every expiry whether or not it has data, each one a `transferIn` resolution on the UI
 * thread - 62.5/s here against 1000/s at 1 ms. FTDI's AN_107 advises against 1 ms because it equals
 * the USB frame length, and the Linux kernel reverted exactly that change in ftdi_sio.
 */
const FTDI_LATENCY_MS = 16;

/** Line-status (16550 LSR) bits, in byte 1 of every packet header. */
const LSR_OVERRUN = 0x02;
const LSR_PARITY = 0x04;
const LSR_FRAMING = 0x08;
const LSR_BREAK = 0x10;
const LSR_ANY_ERROR = LSR_OVERRUN | LSR_PARITY | LSR_FRAMING | LSR_BREAK;

/** Chip families using the 3 MHz / fractional divisor encoding below: AM=2, BM=4, R=6. The H parts
 *  and FT-X use a 12 MHz base and different index packing, so they are refused rather than silently
 *  mis-clocked by a tool that writes to an ECU. */
const SUPPORTED_CHIP_VERSIONS = new Set([2, 4, 6]);

/**
 * Baud divisors, precomputed and audited.
 *
 * Working in eighths (24 MHz = 3 MHz x 8): `d8 = 24e6 / baud`,
 * `fracCode = [0,3,2,4,1,5,6,7][d8 & 7]`, `encoded = (d8 >> 3) | (fracCode << 14)`.
 *
 * A three-entry table rather than a general converter, because the ECU implements exactly these
 * three rates. Three audited constants cannot be subtly wrong; a converter can. `0x4138` and
 * `0xC04E` match FTDI's published AN232B-05 table, which is the independent check on the
 * derivation. All three are exact - zero baud error, 125000 included.
 */
const FTDI_DIVISORS: Readonly<Record<number, { value: number; index: number }>> = {
    9600: { value: 0x4138, index: 0 },   // d8=2500 -> int 312, frac 4/8 -> code 1
    38400: { value: 0xc04e, index: 0 },  // d8=625  -> int 78,  frac 1/8 -> code 3
    125000: { value: 0x0018, index: 0 }, // d8=192  -> int 24,  frac 0
};

/**
 * Recompute the table at module load.
 *
 * A wrong divisor is not a subtle bug in this package - it is a garbled write to an ECU - and a
 * constant checked only where it is used gets checked *after* the erase. This fails at import.
 */
export function assertDivisorTable(): void {
    const FRAC_CODE = [0, 3, 2, 4, 1, 5, 6, 7] as const;
    for (const [baudText, expected] of Object.entries(FTDI_DIVISORS)) {
        const baud = Number(baudText);
        const d8 = 24_000_000 / baud;
        if (!Number.isInteger(d8)) throw new Error(`FTDI divisor table: ${baud} is not an exact 1/8 divisor`);
        const encoded = (d8 >> 3) | ((FRAC_CODE[d8 & 7] ?? 0) << 14);
        if ((encoded & 0xffff) !== expected.value || encoded >>> 16 !== expected.index) {
            throw new Error(
                `FTDI divisor table wrong for ${baud}: table says 0x${expected.value.toString(16)}`
                + `/${expected.index}, computed 0x${(encoded & 0xffff).toString(16)}/${encoded >>> 16}`);
        }
    }
    if (FTDI_DATA_8E1 !== 0x0208) throw new Error('FTDI 8E1 constant is wrong');
    if (FTDI_MODEM_DTR_LOW_RTS_LOW !== 0x0300) throw new Error('FTDI modem-control constant is wrong');
}
assertDivisorTable();

/**
 * The rates the ECU implements, which is also every rate this transport can encode.
 *
 * Named for this backend, because these are bounded by
 * different things: that list is what the ECU accepts, this one is additionally what the divisor
 * table above can produce. They are the same three today and only one of them can move.
 */
export const FTDI_BAUD_RATES = [9600, 38400, 125000] as const;

/**
 * A line fault reported through a status header.
 *
 * The `name` is deliberately the Web Serial spelling of the same condition, so a triage table
 * written against one backend reads the other.
 */
export class FtdiLineError extends Error {
    constructor(name: string, message: string) {
        super(message);
        this.name = name;
    }
}

export class WebUsbFtdiTransport implements ByteTransport {
    private interfaceNumber = 0;
    private inEndpoint = 0;
    private outEndpoint = 0;
    private packetSize = 64;
    /** Bytes received and not yet consumed by a read(). */
    private buffer: number[] = [];
    /**
     * Whether the pump SHOULD be running - intent, set by `open` and cleared by `close`.
     *
     * Not the same thing as whether it is, which is why `pumpRunning` exists next to it. Deciding
     * anything from this one alone is what made a dead reader look like a live one.
     */
    private pumpActive = false;

    /** Whether the pump loop is actually alive. Fact, maintained by the loop itself. */
    private pumpRunning = false;
    private pumpExited: Promise<void> = Promise.resolve();
    /**
     * A line fault or transfer error.
     *
     * Held until `recoverRead`, `open` or `setBaudRate` clears it - NOT until someone reads it.
     * `read` and `peekReadError` both leave it in place, so `hasReadError` keeps answering the
     * question the link needs answered: is the reader stopped? A latch consumed by the first
     * reader to notice it is a latch that says "healthy" about a dead loop.
     */
    private latched: Error | null = null;
    /**
     * The single reader parked in `read`, woken the moment its bytes arrive.
     *
     * This replaces a `setTimeout(2)` polling loop, and the replacement is not a tidy-up. Browsers
     * clamp nested timers to about 4 ms, so the loop could sit on bytes that had already arrived
     * for a full clamp period - and a DS2 exchange pays that three times, once each for the echo,
     * the header and the body. At 9600 the wire dominates and it hides. The faster the line, the
     * larger that fixed cost looms: the reference tuner found it was why raising the baud stopped
     * producing a speed-up, which matters here because reaching 125000 is the entire purpose of
     * FAST ENTRY. A boost that the reader gives back in timer clamp is not a boost.
     *
     * One waiter is enough - the link serialises exchanges, so `read` is never re-entered.
     */
    private waiter: { need: number; wake: () => void } | null = null;
    private deviceGone = false;
    /**
     * LSR bits are latched-since-last-read, so the first packet after a (re)start can report a
     * condition that predates us. Ignoring line status on exactly one packet stops a recovery from
     * immediately re-latching the fault it just repaired.
     */
    private skipLineStatusOnce = false;
    private baud = 9600;

    constructor(private readonly device: UsbDeviceLike) {}

    /** The rate the chip is currently clocked at. Reported by the UI, so it must be the truth. */
    get baudRate(): number {
        return this.baud;
    }

    /**
     * Call from the caller's `navigator.usb` `disconnect` listener.
     *
     * More reliable than probing the device: a pending `transferIn` on a yanked cable can reject
     * with anything, and this is what turns that into an honest "the cable was unplugged".
     */
    markDeviceGone(): void {
        this.deviceGone = true;
        this.latch(new FtdiLineError('NetworkError', 'The device was disconnected'));
    }

    async open(): Promise<void> {
        await this.device.open();
        if (!this.device.configuration) await this.device.selectConfiguration(1);

        this.selectEndpoints();
        this.assertSupportedChipFamily();
        await this.device.claimInterface(this.interfaceNumber);

        // Order matters: SIO_RESET clears modem-control state, so DTR/RTS must be set after it.
        await this.sio(SIO_RESET, SIO_RESET_SIO);
        await this.sio(SIO_SET_LATENCY_TIMER, FTDI_LATENCY_MS);
        await this.sio(SIO_SET_FLOW_CTRL, 0, FTDI_PORT_INDEX); // mode 0 = none, in the high byte
        await this.setBaudRate(9600);
        await this.sio(SIO_SET_DATA, FTDI_DATA_8E1);
        await this.sio(SIO_SET_MODEM_CTRL, FTDI_MODEM_DTR_LOW_RTS_LOW);
        await this.purgeReceive();

        this.buffer = [];
        this.latched = null;
        this.deviceGone = false;
        this.skipLineStatusOnce = true;
        this.pumpActive = true;
        this.startPump();
    }

    /** Endpoint numbers are never hardcoded. They are 0x81/0x02 on every FT232R seen so far, and a
     *  wrong guess is a silently dead link rather than an error. */
    private selectEndpoints(): void {
        for (const iface of this.device.configuration?.interfaces ?? []) {
            const inEp = iface.alternate.endpoints.find((e) => e.direction === 'in' && e.type === 'bulk');
            const outEp = iface.alternate.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk');
            if (inEp && outEp) {
                this.interfaceNumber = iface.interfaceNumber;
                this.inEndpoint = inEp.endpointNumber;
                this.outEndpoint = outEp.endpointNumber;
                this.packetSize = inEp.packetSize || 64;
                return;
            }
        }
        throw new Error('No bulk endpoint pair on this USB device - is it really an FTDI cable?');
    }

    private assertSupportedChipFamily(): void {
        const version = this.device.deviceVersionMajor;
        if (!SUPPORTED_CHIP_VERSIONS.has(version)) {
            throw new Error(
                `Unsupported FTDI chip (bcdDevice major ${version}). This transport implements the `
                + '3 MHz divisor encoding used by FT232AM/BM/R; H-series and FT-X parts clock differently.');
        }
    }

    private async sio(request: number, value: number, index = FTDI_PORT_INDEX): Promise<void> {
        const result = await this.device.controlTransferOut({
            requestType: 'vendor', recipient: 'device', request, value, index,
        });
        if (result.status !== 'ok') {
            throw new Error(`FTDI control request 0x${request.toString(16)} failed (${result.status})`);
        }
    }

    private async purgeReceive(): Promise<void> {
        await this.sio(SIO_RESET, SIO_RESET_PURGE_RX);
    }

    /**
     * The read loop.
     *
     * Every bulk IN **packet** carries a 2-byte status prefix - not every transfer - so with a
     * multi-packet transfer those headers are *interior*. Stripping only at offset 0 would produce
     * a plausible-looking capture with two bytes of garbage every 64, which is the worst failure
     * this design can have because it does not announce itself.
     *
     * Exactly one transfer is in flight. Queueing several is the usual WebUSB throughput trick and
     * they almost certainly complete in order - but "almost certainly" reorders a flash payload.
     */
    private startPump(): void {
        this.pumpRunning = true;
        this.pumpExited = (async () => {
            const scratch = new Uint8Array(8 * this.packetSize);
            try {
                while (this.pumpActive) {
                    let result: UsbInResult;
                    try {
                        result = await this.device.transferIn(this.inEndpoint, 8 * this.packetSize);
                    } catch (error) {
                        if (!this.pumpActive) return;
                        this.latch(this.classifyTransferError(error));
                        return;
                    }
                    if (!this.pumpActive) return;
                    if (result.status === 'stall') {
                        try { await this.device.clearHalt('in', this.inEndpoint); continue; }
                        catch (error) { this.latch(this.classifyTransferError(error)); return; }
                    }
                    if (result.status === 'babble') {
                        this.latch(new FtdiLineError('BabbleError', 'The device returned more data than requested'));
                        return;
                    }

                    const view = result.data;
                    if (!view) continue;
                    let payload = 0;
                    let fault: number | null = null;
                    for (let offset = 0; offset + 2 <= view.byteLength; offset += this.packetSize) {
                        const lineStatus = view.getUint8(offset + 1);
                        if ((lineStatus & LSR_ANY_ERROR) !== 0 && !this.skipLineStatusOnce) {
                            fault = lineStatus;
                            break;
                        }
                        const available = Math.min(this.packetSize, view.byteLength - offset) - 2;
                        for (let i = 0; i < available; i++) scratch[payload++] = view.getUint8(offset + 2 + i);
                    }
                    this.skipLineStatusOnce = false;
                    // Deliver before latching: bytes that arrived cleanly ahead of the fault in the same
                    // transfer are real, and dropping them desyncs the frame being read.
                    for (let i = 0; i < payload; i++) this.buffer.push(scratch[i] ?? 0);
                    // Wake a parked reader the instant its bytes are here. This is the half of the
                    // waiter that makes it worth having: without it the reader still sleeps out its
                    // timer and nothing has been gained.
                    if (payload > 0) this.signalWaiter();
                    if (fault !== null) { this.latch(this.classifyLineStatus(fault)); return; }
                }
            } finally {
                // Every exit runs through here - the deliberate one from `close`, and the eight
                // `return`s above that leave because something went wrong on the line.
                this.pumpRunning = false;
            }
        })();
    }

    private latch(error: Error): void {
        this.latched ??= error;
        // A latched fault must wake the reader too, or it waits out its whole timeout for bytes
        // that can no longer arrive - turning a break into a multi-second stall.
        this.signalWaiter();
    }

    /** Wake the parked reader once its byte count can be met, or once it can only fail. */
    private signalWaiter(): void {
        const w = this.waiter;
        if (w && (this.buffer.length >= w.need || this.latched)) {
            this.waiter = null;
            w.wake();
        }
    }

    /** Release a parked reader unconditionally, where the pump it waits on is being torn down.
     *  After that point no byte can wake it, so leaving it parked costs a full timeout for nothing. */
    private releaseWaiter(): void {
        const w = this.waiter;
        if (w) { this.waiter = null; w.wake(); }
    }

    private classifyLineStatus(lineStatus: number): Error {
        // A break implies the framing garbage that accompanies it, so it wins.
        if (lineStatus & LSR_BREAK) return new FtdiLineError('BreakError', 'Break received');
        if (lineStatus & LSR_FRAMING) return new FtdiLineError('FramingError', 'Framing error');
        if (lineStatus & LSR_PARITY) return new FtdiLineError('ParityError', 'Parity error');
        return new FtdiLineError('BufferOverrunError', 'Receive buffer overrun');
    }

    private classifyTransferError(error: unknown): Error {
        if (this.deviceGone) return new FtdiLineError('NetworkError', 'The device was disconnected');
        return error instanceof Error ? error : new Error(String(error));
    }

    async write(bytes: Uint8Array): Promise<void> {
        const result = await this.device.transferOut(this.outEndpoint, bytes);
        if (result.status !== 'ok') throw new Error(`USB write failed (${result.status})`);
    }

    /**
     * Read exactly `count` bytes, or reject once `timeoutMs` has passed.
     *
     * A latched line fault is reported in preference to a timeout even when enough bytes are
     * buffered: past a parity or overrun error the buffered bytes are of unknown provenance, and
     * the link's retry path is the right place to decide what to do about that.
     */
    async read(count: number, timeoutMs: number): Promise<Uint8Array> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            // Reported, NOT consumed. The link asks `hasReadError` straight after this throw to
            // decide between dropping a tail and rebuilding the reader, and clearing the latch here
            // would answer that question wrongly - the expensive way round.
            if (this.latched) throw this.latched;
            if (this.buffer.length >= count) return Uint8Array.from(this.buffer.splice(0, count));
            if (!this.pumpActive) throw new Error('transport closed while waiting for data');
            // The reader stopped on a fault and nothing has restarted it. Waiting out the deadline
            // would report a timeout, which names the wrong cause and costs the whole timeout doing
            // it. `recoverRead` is what puts the loop back.
            if (!this.pumpRunning) {
                throw new FtdiLineError('ReaderStopped',
                    'the read loop stopped after a line fault and has not been restarted');
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                throw new Error(`timed out after ${timeoutMs} ms with ${this.buffer.length} of ${count} bytes`);
            }
            // Park until the pump says the bytes are here, or the deadline passes - whichever comes
            // first. The loop re-checks everything afterwards, so a spurious wake costs a compare.
            await new Promise<void>((resolve) => {
                const wake = (): void => { clearTimeout(timer); resolve(); };
                const timer = setTimeout(() => {
                    if (this.waiter?.wake === wake) this.waiter = null;
                    resolve();
                }, remaining);
                this.waiter = { need: count, wake };
            });
        }
    }

    /** Whether a line fault has stopped the reader. The link's repair decision turns on this. */
    hasReadError(): boolean {
        return this.latched !== null;
    }

    /** The latched fault, left in place. See `latched` for why it is not consumed. */
    peekReadError(): Error | null {
        return this.latched;
    }

    /**
     * Drop a stale tail: the chip's FIFO and our buffer, nothing else.
     *
     * Deliberately does NOT clear the latch or restart the reader. Between ordinary retries this is
     * all that is needed and it is cheap; a transport that tore its reader down here would pay a
     * settle period every time a response merely arrived late.
     */
    async drain(): Promise<void> {
        try { await this.purgeReceive(); } catch { /* the buffer clear below is the part that matters */ }
        this.buffer = [];
    }

    /**
     * Rebuild the read path after a line fault.
     *
     * Stop the loop, wait for it to actually exit, let the wire settle, flush the chip, clear the
     * latch, start again. Awaiting `pumpExited` before starting is what stops two recoveries from
     * leaving two loops racing on one endpoint.
     *
     * The 100 ms is sized to the break / idle condition on the wire rather than to anything about
     * the host API, which is why it is the same number the reference uses on a different backend.
     */
    async recoverRead(): Promise<void> {
        this.pumpActive = false;
        this.releaseWaiter();
        try { await this.pumpExited; } catch { /* its error is already latched */ }
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (this.deviceGone) {
            throw new FtdiLineError('NetworkError',
                'the USB device disconnected - unplug and replug the cable, then reconnect');
        }
        try { await this.purgeReceive(); } catch { /* the reader restart below is what matters */ }
        this.buffer = [];
        this.latched = null;
        this.skipLineStatusOnce = true;
        this.pumpActive = true;
        this.startPump();
    }

    /**
     * Change line speed **in place**: one control transfer, no close, no reopen, no restarted pump,
     * and DTR/RTS never move. This is what the reference desktop tool does over the vendor driver
     * and what Web Serial cannot do at all.
     *
     * The receive buffer is purged either side of it, because anything still in flight was framed
     * at the old rate and would decode as garbage at the new one.
     */
    async setBaudRate(rate: number): Promise<void> {
        const divisor = FTDI_DIVISORS[rate];
        if (!divisor) {
            throw new Error(
                `Unsupported baud rate ${rate} for the FTDI transport `
                + `(supported: ${Object.keys(FTDI_DIVISORS).join(', ')})`);
        }
        await this.sio(SIO_SET_BAUD_RATE, divisor.value, divisor.index);
        this.baud = rate;
        await this.purgeReceive();
        this.buffer = [];
        this.latched = null;
        this.skipLineStatusOnce = true;
    }

    async close(): Promise<void> {
        this.pumpActive = false;
        // Nothing can wake a reader after this point, so a parked one would pay its whole timeout
        // to be told the transport is closed. Release it and let its own loop report that.
        this.releaseWaiter();
        try { await this.pumpExited; } catch { /* the loop's own error is already latched */ }
        try { await this.device.releaseInterface(this.interfaceNumber); } catch { /* already gone */ }
        try { await this.device.close(); } catch { /* already closed */ }
        this.buffer = [];
    }
}
