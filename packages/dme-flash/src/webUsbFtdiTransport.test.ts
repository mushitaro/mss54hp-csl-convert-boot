/**
 * The FTDI transport, driven against a fake cable.
 *
 * Until this file existed, every line in `webUsbFtdiTransport.ts` was code that had never run
 * outside a browser with a real cable in it - the one path in the package with no coverage at all,
 * and the one that a real ECU session begins with.
 */
import { describe, it, expect } from 'vitest';
import { WebUsbFtdiTransport, FtdiLineError } from './webUsbFtdiTransport';
import { FakeFtdiDevice } from './fakeUsbDevice';

const SIO_RESET = 0x00;
const SIO_SET_MODEM_CTRL = 0x01;
const SIO_SET_FLOW_CTRL = 0x02;
const SIO_SET_BAUD_RATE = 0x03;
const SIO_SET_DATA = 0x04;
const SIO_SET_LATENCY_TIMER = 0x09;

const LSR_PARITY = 0x04;
const LSR_OVERRUN = 0x02;

async function opened(): Promise<{ device: FakeFtdiDevice; transport: WebUsbFtdiTransport }> {
    const device = new FakeFtdiDevice();
    const transport = new WebUsbFtdiTransport(device);
    await transport.open();
    return { device, transport };
}

describe('opening the link', () => {
    it('configures the chip in the order the chip requires', async () => {
        const { device } = await opened();
        const requests = device.controls.map((c) => c.request);

        // SIO_RESET clears modem-control state, so DTR/RTS must come after it. A wrong order here
        // is a link that enumerates, configures cleanly, and never receives a byte.
        expect(requests.indexOf(SIO_RESET)).toBeLessThan(requests.indexOf(SIO_SET_MODEM_CTRL));
        expect(requests).toContain(SIO_SET_LATENCY_TIMER);
        expect(requests).toContain(SIO_SET_FLOW_CTRL);
        expect(requests).toContain(SIO_SET_BAUD_RATE);
    });

    it('sets 8E1, not 8N1', async () => {
        // DS2 is 8E1. An 8N1 receiver faults on every byte with even popcount, which includes the
        // 0x12 that starts every telegram - the whole protocol looks broken.
        const { device } = await opened();
        const data = device.controls.find((c) => c.request === SIO_SET_DATA);
        expect(data?.value).toBe(0x0208);
    });

    it('claims an interface and refuses a chip family it cannot clock', async () => {
        const { device } = await opened();
        expect(device.interfaceClaimed).toBe(0);

        const hSeries = new FakeFtdiDevice({ deviceVersionMajor: 9 });
        await expect(new WebUsbFtdiTransport(hSeries).open()).rejects.toThrow(/Unsupported FTDI chip/);
    });
});

describe('reading', () => {
    it('strips the status header from every packet, not just the first', async () => {
        // The failure this guards is the one the module calls its worst: stripping only at offset 0
        // yields a capture that looks entirely plausible with two bytes of garbage every 64.
        const { device, transport } = await opened();
        const payload = Uint8Array.from({ length: 200 }, (_, i) => i & 0xff);
        device.deliver(payload);

        const got = await transport.read(200, 2000);
        expect(Array.from(got)).toEqual(Array.from(payload));
        await transport.close();
    });

    it('times out with a count, not silently', async () => {
        const { transport } = await opened();
        await expect(transport.read(4, 60)).rejects.toThrow(/timed out after 60 ms with 0 of 4/);
        await transport.close();
    });
});

describe('a line fault, and getting back from it', () => {
    it('reports the fault in preference to the bytes that arrived with it', async () => {
        const { device, transport } = await opened();
        device.faultAfter([0x12, 0x04], LSR_PARITY);

        // Past a parity error the buffered bytes are of unknown provenance. The link's retry path
        // is the right place to decide what to do, so the fault wins even though bytes are there.
        await expect(transport.read(2, 500)).rejects.toThrow(FtdiLineError);
        await transport.close();
    });

    /**
     * The regression this file was written for, and the contract that repairs it.
     *
     * Every fault path in the pump latched and returned while the flag saying it was running
     * stayed true. One parity glitch in a 62-minute read therefore left the cable deaf for the
     * rest of the session, because the only repair the transport offered cleared the error and
     * restarted nothing.
     *
     * The fix is the reference tuner's split: `drain` drops a stale tail, `recoverRead` rebuilds
     * the reader, and the link asks `hasReadError` which one this is.
     */
    it('restarts the reader on recoverRead, so the retry path actually recovers', async () => {
        const { device, transport } = await opened();
        device.faultAfter([0xaa], LSR_OVERRUN);

        await expect(transport.read(1, 500)).rejects.toThrow(FtdiLineError);
        expect(transport.hasReadError()).toBe(true);
        await transport.recoverRead();
        expect(transport.hasReadError()).toBe(false);

        device.deliver([0x12, 0x34, 0x56]);
        const got = await transport.read(3, 2000);
        expect(Array.from(got)).toEqual([0x12, 0x34, 0x56]);
        await transport.close();
    });

    it('does not report a fault healed by drain alone', async () => {
        // drain drops a tail. It is not a repair, and a transport that claimed otherwise is what
        // let the link pick the cheap fix for the expensive damage.
        const { device, transport } = await opened();
        device.faultAfter([0xaa], LSR_PARITY);
        await expect(transport.read(1, 500)).rejects.toThrow(FtdiLineError);

        await transport.drain();
        expect(transport.hasReadError(), 'drain must not clear a latched line fault').toBe(true);

        await transport.recoverRead();
        expect(transport.hasReadError()).toBe(false);
        await transport.close();
    });

    it('keeps the latch when it is read, so the link can still ask what happened', async () => {
        // The anti-pattern the reference documents against: a latch consumed by the first reader
        // to notice it answers "healthy" about a loop that is not running.
        const { device, transport } = await opened();
        device.faultAfter([0xaa], LSR_PARITY);

        await expect(transport.read(1, 500)).rejects.toThrow(FtdiLineError);
        expect(transport.hasReadError()).toBe(true);
        expect(transport.peekReadError()?.name).toBe('ParityError');
        // Twice, because non-consuming means non-consuming.
        expect(transport.peekReadError()?.name).toBe('ParityError');
        await transport.close();
    });

    it('fails fast instead of waiting out the timeout when the reader is stopped', async () => {
        // Without this the caller pays the full timeout to be told the wrong thing.
        const { device, transport } = await opened();
        device.faultAfter([0xaa], LSR_PARITY);
        await expect(transport.read(1, 500)).rejects.toThrow(FtdiLineError);
        await transport.drain(); // clears the buffer, deliberately not the fault

        const started = Date.now();
        await expect(transport.read(1, 5000)).rejects.toThrow(/Parity error/);
        expect(Date.now() - started).toBeLessThan(1000);
        await transport.close();
    });

    it('recovers from a stall by clearing the halt rather than dying', async () => {
        const { device, transport } = await opened();
        device.stallOnce();
        device.deliver([0x77]);

        const got = await transport.read(1, 2000);
        expect(Array.from(got)).toEqual([0x77]);
        expect(device.halted).toBe(1);
        await transport.close();
    });

    it('survives a rejected transfer the same way', async () => {
        const { device, transport } = await opened();
        device.rejectOnce(new Error('device busy'));
        await expect(transport.read(1, 500)).rejects.toThrow(/device busy/);

        await transport.recoverRead();
        device.deliver([0x99]);
        expect(Array.from(await transport.read(1, 2000))).toEqual([0x99]);
        await transport.close();
    });

    it('does not leave two loops racing on one endpoint after two recoveries', async () => {
        const { device, transport } = await opened();
        device.faultAfter([0x01], LSR_PARITY);
        await expect(transport.read(1, 500)).rejects.toThrow(FtdiLineError);

        await transport.recoverRead();
        await transport.recoverRead();

        device.deliver([0x11, 0x22, 0x33, 0x44]);
        const got = await transport.read(4, 2000);
        // Two readers would each take some of these and neither would see all four in order.
        expect(Array.from(got)).toEqual([0x11, 0x22, 0x33, 0x44]);
        await transport.close();
    });
});

describe('waiting for bytes', () => {
    /**
     * The parked reader, measured.
     *
     * The loop this replaced polled a 2 ms timer, and browsers clamp nested timers to about 4 ms -
     * paid three times per DS2 exchange, for the echo, the header and the body. At 9600 the wire
     * hides it. At the 125000 that FAST ENTRY exists to reach it does not, which is how the
     * reference found that raising the baud had stopped producing a speed-up.
     *
     * Measuring the wake latency directly is the only way to tell the two designs apart: both
     * return the right bytes.
     */
    it('wakes on arrival rather than on the next timer tick', async () => {
        const { device, transport } = await opened();

        const started = Date.now();
        const pending = transport.read(4, 2000);
        device.deliver([0xde, 0xad, 0xbe, 0xef]);
        expect(Array.from(await pending)).toEqual([0xde, 0xad, 0xbe, 0xef]);
        // Generous enough to survive a loaded CI box and still fail a design that sleeps out a
        // clamped poll interval before looking.
        expect(Date.now() - started).toBeLessThan(120);
        await transport.close();
    });

    it('does not strand a parked reader when the transport closes under it', async () => {
        const { transport } = await opened();
        // The expectation is attached before the close, not after: the read rejects while `close`
        // is still awaiting, and a handler added later is one Node has already called unhandled.
        const settled = expect(transport.read(8, 30_000)).rejects.toThrow(/closed/);
        await transport.close();
        // Without releasing the waiter this sits for the full 30 s to learn something already true,
        // so the 5 s test timeout is itself the assertion that it does not.
        await settled;
    });
});

describe('changing rate in place', () => {
    it('is one control transfer, with no reopen and no modem-control change', async () => {
        // This is the whole reason the Android backend exists: Web Serial must close() and open()
        // to change rate, which pulses DTR/RTS mid-session - least affordable exactly when fast
        // entry uses it, with something on the ECU already erased.
        const { device, transport } = await opened();
        device.controls.length = 0;

        await transport.setBaudRate(125000);

        expect(device.controls.filter((c) => c.request === SIO_SET_BAUD_RATE)).toHaveLength(1);
        expect(device.controls.some((c) => c.request === SIO_SET_MODEM_CTRL)).toBe(false);
        expect(device.opened, 'the handle must stay open').toBe(true);
        await transport.close();
    });

    it('refuses a rate it has no divisor for rather than sending a wrong one', async () => {
        const { transport } = await opened();
        await expect(transport.setBaudRate(19200)).rejects.toThrow(/Unsupported baud rate/);
        await transport.close();
    });

    it('keeps reading after the switch', async () => {
        const { device, transport } = await opened();
        await transport.setBaudRate(125000);
        device.deliver([0xde, 0xad]);
        expect(Array.from(await transport.read(2, 2000))).toEqual([0xde, 0xad]);
        await transport.close();
    });
});

describe('closing', () => {
    it('stops the reader and releases the device', async () => {
        const { device, transport } = await opened();
        await transport.close();

        expect(device.opened).toBe(false);
        expect(device.interfaceClaimed).toBeNull();
        await expect(transport.read(1, 200)).rejects.toThrow(/transport closed/);
    });
});
