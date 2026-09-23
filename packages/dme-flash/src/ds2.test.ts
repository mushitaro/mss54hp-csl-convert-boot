/**
 * DS2 framing, against real captured telegrams.
 *
 * Framing is the layer where a mistake looks like a hardware fault, so the vectors here are all
 * bytes that actually went down a K-line: request templates extracted from BMW's 12MSS54.PRG,
 * and a genuine IDENT exchange captured from a real MSS54 in the diagnosis PWA's trace.
 */
import { describe, it, expect } from 'vitest';
import {
    DME_DS2_ADDRESS, DS2_MAX_DATA_LENGTH,
    ds2Checksum, buildDs2Frame, parseDs2Frame, expectedDs2Length, statusOf, isPositive,
    Ds2Status, describeDs2Status, toHex,
} from './ds2';

function bytes(hex: string): Uint8Array {
    return Uint8Array.from(hex.trim().split(/\s+/), (h) => parseInt(h, 16));
}

describe('DS2 framing', () => {
    it('builds the IDENT request captured from a real car: 12 04 00 16', () => {
        expect(toHex(buildDs2Frame(DME_DS2_ADDRESS, new Uint8Array([0x00])))).toBe('12 04 00 16');
    });

    it('builds the seed request from BMW SGBD: 12 08 90 42 4D 57 05 D7', () => {
        expect(toHex(buildDs2Frame(DME_DS2_ADDRESS, bytes('90 42 4D 57 05')))).toBe('12 08 90 42 4D 57 05 D7');
    });

    it('builds the recycling control from BMW SGBD: 12 09 07 0E 42 41 50 00 41', () => {
        expect(toHex(buildDs2Frame(DME_DS2_ADDRESS, bytes('07 0E 42 41 50 00')))).toBe('12 09 07 0E 42 41 50 00 41');
    });

    it('sets LENGTH to the total frame length, not the payload length', () => {
        const frame = buildDs2Frame(DME_DS2_ADDRESS, new Uint8Array(10));
        expect(frame[1]).toBe(13);
        expect(frame).toHaveLength(13);
    });

    it('checksums with an XOR over every preceding byte', () => {
        expect(ds2Checksum(bytes('12 04 00'))).toBe(0x16);
        const frame = buildDs2Frame(DME_DS2_ADDRESS, bytes('07 06 00 00 00 00'));
        expect(frame[frame.length - 1]).toBe(ds2Checksum(frame.subarray(0, frame.length - 1)));
    });

    it('refuses data too long for the length byte to describe', () => {
        expect(() => buildDs2Frame(DME_DS2_ADDRESS, new Uint8Array(DS2_MAX_DATA_LENGTH + 1))).toThrow(/length byte/);
    });
});

describe('DS2 parsing', () => {
    it('parses a genuine MSS54 IDENT response and finds the ACK', () => {
        // Captured: 12 2E A0 37 38 33 37 33 34 30 31 ... (ASCII "7837340 1B009060")
        const data = bytes('A0 37 38 33 37 33 34 30 31 42 30 30 39 30 36 30');
        const frame = buildDs2Frame(DME_DS2_ADDRESS, data);
        const parsed = parseDs2Frame(frame);
        expect(parsed.ok).toBe(true);
        expect(parsed.address).toBe(DME_DS2_ADDRESS);
        expect(statusOf(parsed)).toBe(Ds2Status.Ack);
        expect(isPositive(parsed)).toBe(true);
    });

    it('round-trips anything it builds', () => {
        for (const len of [0, 1, 6, 122, DS2_MAX_DATA_LENGTH]) {
            const data = Uint8Array.from({ length: len }, (_, i) => (i * 7) & 0xff);
            const parsed = parseDs2Frame(buildDs2Frame(DME_DS2_ADDRESS, data));
            expect(parsed.ok).toBe(true);
            expect(Array.from(parsed.data ?? [])).toEqual(Array.from(data));
        }
    });

    it('reports a checksum mismatch as data rather than throwing', () => {
        const frame = buildDs2Frame(DME_DS2_ADDRESS, bytes('A0 01'));
        frame[frame.length - 1] = (frame[frame.length - 1] ?? 0) ^ 0xff;
        const parsed = parseDs2Frame(frame);
        expect(parsed.ok).toBe(false);
        expect(parsed.error).toMatch(/checksum mismatch/);
    });

    it('reports an incomplete frame with how much is missing', () => {
        const frame = buildDs2Frame(DME_DS2_ADDRESS, bytes('A0 01 02 03'));
        const parsed = parseDs2Frame(frame.subarray(0, 4));
        expect(parsed.ok).toBe(false);
        expect(parsed.error).toMatch(/incomplete frame \(4\/7 bytes\)/);
    });

    it('refuses a frame whose declared length is below the minimum', () => {
        expect(parseDs2Frame(bytes('12 01 00')).error).toMatch(/below the minimum/);
    });

    it('never throws, whatever it is handed', () => {
        for (const buf of [new Uint8Array(0), bytes('12'), bytes('12 FF'), bytes('00 00 00')]) {
            expect(() => parseDs2Frame(buf)).not.toThrow();
        }
    });
});

describe('reading a response off the wire', () => {
    it('learns the expected length from the second byte, and says so until then', () => {
        expect(expectedDs2Length(new Uint8Array(0))).toBe(-1);
        expect(expectedDs2Length(bytes('12'))).toBe(-1);
        expect(expectedDs2Length(bytes('12 2E'))).toBe(0x2e);
    });
});

describe('status bytes', () => {
    it('names each one the reference implementation observed on a car', () => {
        expect(describeDs2Status(Ds2Status.Ack)).toBe('ACK');
        expect(describeDs2Status(Ds2Status.Rejected)).toMatch(/access level/);
        expect(describeDs2Status(Ds2Status.ParameterError)).toMatch(/address or value refused/);
        expect(describeDs2Status(0x42)).toMatch(/unknown status 0x42/);
    });

    it('treats only ACK as positive', () => {
        for (const status of [Ds2Status.Busy, Ds2Status.Rejected, Ds2Status.ParameterError, Ds2Status.Nak]) {
            expect(isPositive(parseDs2Frame(buildDs2Frame(DME_DS2_ADDRESS, new Uint8Array([status]))))).toBe(false);
        }
    });
});
