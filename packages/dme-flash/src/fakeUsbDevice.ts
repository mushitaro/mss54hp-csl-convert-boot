/**
 * A fake FTDI cable, so the real transport can be driven without one.
 *
 * This simulates the **device**, not the transport. `WebUsbFtdiTransport` is the class under test
 * in every case that uses this: it does its own control transfers, its own packet-header stripping
 * and its own read loop, against something that behaves like an FT232R rather than against a stub
 * of itself. A mock transport would prove the app compiles; this proves the link works.
 *
 * The module header of `webUsbFtdiTransport.ts` has said "lets a fake device drive it in tests"
 * since it was written. This is that fake, and the first bug it found was a dead read loop that
 * one line fault produced and nothing ever restarted.
 */
import type {
    UsbDeviceLike, UsbControlSetup, UsbInResult, UsbConfigurationLike,
} from './webUsbFtdiTransport';

/** One bulk IN transfer's worth of bytes, or a fault instead of them. */
type Pending =
    | { kind: 'packet'; lineStatus: number; payload: Uint8Array }
    | { kind: 'stall' }
    | { kind: 'babble' }
    | { kind: 'reject'; error: Error };

export interface ControlRecord {
    readonly request: number;
    readonly value: number;
    readonly index: number;
}

const PACKET_SIZE = 64;
const HEADER = 2;

/**
 * The FT232R's two status bytes, as the chip actually sends them.
 *
 * Byte 0 is modem status, byte 1 is line status. `0x01` in byte 0 and `0x60` in byte 1 are what an
 * idle FT232R reports; the tests care only that the transport strips both and reads the error bits
 * out of the second.
 */
function header(lineStatus: number): [number, number] {
    return [0x01, 0x60 | lineStatus];
}

export class FakeFtdiDevice implements UsbDeviceLike {
    readonly vendorId = 0x0403;
    readonly deviceVersionMajor: number;

    /** Every control transfer, in order. The order is part of what the transport must get right. */
    readonly controls: ControlRecord[] = [];
    /** Everything the transport wrote, concatenated. */
    readonly written: number[] = [];

    opened = false;
    interfaceClaimed: number | null = null;
    halted = 0;

    private readonly queue: Pending[] = [];
    private readonly idleLineStatus = 0;
    private closed = false;

    constructor(options: { deviceVersionMajor?: number } = {}) {
        this.deviceVersionMajor = options.deviceVersionMajor ?? 6;
    }

    // --- what the tests drive ----------------------------------------------------------------

    /**
     * Queue bytes as the chip would deliver them: split into 64-byte packets, each with its own
     * 2-byte status header. Multi-packet transfers are the case the transport's own comment calls
     * its worst possible failure, so the fake must produce them rather than one flat buffer.
     */
    deliver(bytes: Uint8Array | number[]): void {
        const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
        const perPacket = PACKET_SIZE - HEADER;
        for (let at = 0; at < data.length; at += perPacket) {
            this.queue.push({
                kind: 'packet',
                lineStatus: this.idleLineStatus,
                payload: data.subarray(at, Math.min(at + perPacket, data.length)),
            });
        }
    }

    /** Raise a line-status error on the next transfer, with whatever bytes arrived before it. */
    faultAfter(bytes: Uint8Array | number[], lineStatus: number): void {
        const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
        this.queue.push({ kind: 'packet', lineStatus, payload: data });
    }

    stallOnce(): void { this.queue.push({ kind: 'stall' }); }
    babbleOnce(): void { this.queue.push({ kind: 'babble' }); }
    rejectOnce(error = new Error('transfer failed')): void {
        this.queue.push({ kind: 'reject', error });
    }

    /** How many bulk IN transfers the transport has issued. */
    transfersIn = 0;

    // --- UsbDeviceLike -----------------------------------------------------------------------

    get configuration(): UsbConfigurationLike | null {
        return {
            interfaces: [{
                interfaceNumber: 0,
                alternate: {
                    endpoints: [
                        { direction: 'in', type: 'bulk', endpointNumber: 1, packetSize: PACKET_SIZE },
                        { direction: 'out', type: 'bulk', endpointNumber: 2, packetSize: PACKET_SIZE },
                    ],
                },
            }],
        };
    }

    async open(): Promise<void> { this.opened = true; }
    async close(): Promise<void> { this.opened = false; this.closed = true; }
    async selectConfiguration(): Promise<void> { /* the getter above already reports one */ }
    async claimInterface(n: number): Promise<void> { this.interfaceClaimed = n; }
    async releaseInterface(): Promise<void> { this.interfaceClaimed = null; }
    async clearHalt(): Promise<void> { this.halted++; }

    async controlTransferOut(setup: UsbControlSetup): Promise<{ status?: string }> {
        this.controls.push({ request: setup.request, value: setup.value, index: setup.index });
        // SIO_RESET with purge (value 2) empties whatever is queued, exactly as the chip does.
        if (setup.request === 0x00 && setup.value === 2) this.queue.length = 0;
        return { status: 'ok' };
    }

    async transferOut(_endpoint: number, data: Uint8Array): Promise<{ status?: string }> {
        for (const b of data) this.written.push(b);
        return { status: 'ok' };
    }

    async transferIn(_endpoint: number, _length: number): Promise<UsbInResult> {
        this.transfersIn++;
        const next = this.queue.shift();
        if (!next) {
            // An idle chip still answers, with a header and no payload. Returning nothing instead
            // would let a test pass because the loop was starved rather than because it worked.
            if (this.closed) throw new Error('device closed');
            await new Promise((resolve) => setTimeout(resolve, 1));
            return { status: 'ok', data: view(header(this.idleLineStatus), new Uint8Array(0)) };
        }
        if (next.kind === 'reject') throw next.error;
        if (next.kind === 'stall') return { status: 'stall' };
        if (next.kind === 'babble') return { status: 'babble' };
        return { status: 'ok', data: view(header(next.lineStatus), next.payload) };
    }
}

/** Build the DataView a bulk IN transfer would carry: status header, then payload. */
function view(head: [number, number], payload: Uint8Array): DataView {
    const out = new Uint8Array(HEADER + payload.length);
    out[0] = head[0];
    out[1] = head[1];
    out.set(payload, HEADER);
    return new DataView(out.buffer);
}

/** Build one transfer carrying several packets, to exercise interior status headers. */
export function multiPacket(packets: readonly (Uint8Array | number[])[]): DataView {
    const out = new Uint8Array(packets.length * PACKET_SIZE);
    packets.forEach((p, i) => {
        const data = p instanceof Uint8Array ? p : Uint8Array.from(p);
        const at = i * PACKET_SIZE;
        out[at] = 0x01;
        out[at + 1] = 0x60;
        out.set(data.subarray(0, PACKET_SIZE - HEADER), at + HEADER);
    });
    return new DataView(out.buffer);
}
