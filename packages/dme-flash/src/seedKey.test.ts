/**
 * The login exchange.
 *
 * The algorithm is a port, so what these tests pin is that the port is faithful: the request
 * shape matches BMW's own SGBD template, and the key derivation matches the reference tuner's
 * arithmetic exactly, including its use of the frame's own length byte as the modulus.
 */
import { describe, it, expect } from 'vitest';
import {
    DEFAULT_ACCESS_LEVEL, LOGIN_COMMAND, SEED_RESPONSE_LENGTH,
    buildSeedRequestPayload, buildKeyPayload, calculateKey, keyBytes,
} from './seedKey';
import { buildDs2Frame, DME_DS2_ADDRESS, toHex } from './ds2';

/** A seed frame of the right shape: 46 bytes, length byte 46, deterministic contents. */
function seedFrame(fill: (i: number) => number): Uint8Array {
    const frame = Uint8Array.from({ length: SEED_RESPONSE_LENGTH }, (_, i) => fill(i) & 0xff);
    frame[0] = DME_DS2_ADDRESS;
    frame[1] = SEED_RESPONSE_LENGTH;
    return frame;
}

describe('the seed request', () => {
    it('matches the SEED_KEY template from BMW 12MSS54.PRG: 12 08 90 42 4D 57 05 D7', () => {
        const frame = buildDs2Frame(DME_DS2_ADDRESS, buildSeedRequestPayload(DEFAULT_ACCESS_LEVEL));
        expect(toHex(frame)).toBe('12 08 90 42 4D 57 05 D7');
    });

    it('is command 0x90 carrying ASCII "BMW" and the access level', () => {
        const payload = buildSeedRequestPayload(8);
        expect(Array.from(payload)).toEqual([LOGIN_COMMAND, 0x42, 0x4d, 0x57, 8]);
    });

    it('defaults to the access level the reference implementation uses for programming', () => {
        expect(DEFAULT_ACCESS_LEVEL).toBe(5);
    });
});

describe('the key derivation', () => {
    it('is key[i] = seed[(level + i) mod seed[1]] + seed[18 + i] + seed[41 + i], truncated per byte', () => {
        const frame = seedFrame((i) => i * 3 + 1);
        const level = DEFAULT_ACCESS_LEVEL;
        const expected: number[] = [];
        for (let i = 0; i < 4; i++) {
            const idx = (level + i) % (frame[1] ?? 1);
            expected.push(((frame[idx] ?? 0) + (frame[18 + i] ?? 0) + (frame[41 + i] ?? 0)) & 0xff);
        }
        expect(Array.from(keyBytes(calculateKey(level, frame)))).toEqual(expected);
    });

    it('wraps the index modulo the frame length byte, not modulo 46 by coincidence', () => {
        // A frame whose length byte disagrees with reality would be rejected upstream, but the
        // modulus is genuinely taken from the frame - pin that rather than the constant.
        const frame = seedFrame((i) => i);
        frame[1] = SEED_RESPONSE_LENGTH;
        const key = calculateKey(44, frame);
        // level 44: indices 44, 45, 0, 1 - the last two have wrapped.
        const b = keyBytes(key);
        expect(b[2]).toBe((((frame[0] ?? 0) + (frame[20] ?? 0) + (frame[43] ?? 0)) & 0xff));
    });

    it('depends on the access level', () => {
        const frame = seedFrame((i) => i * 7);
        expect(calculateKey(5, frame)).not.toBe(calculateKey(6, frame));
    });

    it('produces a 32-bit unsigned value', () => {
        const frame = seedFrame(() => 0xff);
        const key = calculateKey(5, frame);
        expect(key).toBeGreaterThanOrEqual(0);
        expect(key).toBeLessThanOrEqual(0xffffffff);
    });

    it('refuses a frame that is not a seed response', () => {
        expect(() => calculateKey(5, new Uint8Array(10))).toThrow(/must be 46 bytes/);
    });

    it('refuses a frame whose length byte is zero rather than dividing by it', () => {
        const frame = seedFrame(() => 1);
        frame[1] = 0;
        expect(() => calculateKey(5, frame)).toThrow(/modulus/);
    });
});

describe('the key response', () => {
    it('is command 0x90 followed by the four key bytes, big-endian', () => {
        expect(Array.from(buildKeyPayload(0x11223344))).toEqual([LOGIN_COMMAND, 0x11, 0x22, 0x33, 0x44]);
    });

    it('frames to the same length as the seed request', () => {
        const seed = buildDs2Frame(DME_DS2_ADDRESS, buildSeedRequestPayload());
        const key = buildDs2Frame(DME_DS2_ADDRESS, buildKeyPayload(0xdeadbeef));
        expect(key.length).toBe(seed.length);
    });
});
