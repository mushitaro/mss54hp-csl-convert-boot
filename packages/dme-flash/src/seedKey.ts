/**
 * MSS54 login (DS2 command 0x90): the seed/key exchange that raises the access level a
 * programming session needs.
 *
 * This corrects an earlier note in the repo that called cmd 0x91 a "fixed password". Cmd 0x91
 * is the baud switch; the three-byte table at flash 0x3FB8 (00 25 80 / 00 96 00 / 01 E8 48) is
 * the set of DS2 baud rates (9600 / 38400 / 125000), not credentials. The actual unlock is a
 * seed/key on cmd 0x90.
 *
 * The algorithm is a direct port of the reference tuner's `Mss54SeedKeyCalculator`, which is
 * proven against a real DME:
 *
 *   request : command 0x90, payload "BMW" + accessLevel      (42 4D 57 <level>)
 *   response: a 46-byte frame carrying the seed
 *   key     : four bytes, key[i] = seed[(level+i) % seed[1]] + seed[18+i] + seed[41+i]
 *   send    : command 0x90, payload = the four key bytes
 *
 * Pure arithmetic over the seed frame. No transport - the caller does the two round trips and
 * hands the seed frame in.
 */

/** Access level the reference implementation uses for a programming session. */
export const DEFAULT_ACCESS_LEVEL = 5;

/** DS2 command byte for both the seed request and the key response. */
export const LOGIN_COMMAND = 0x90;

/** The seed response is a fixed-length frame; anything else is not a seed. */
export const SEED_RESPONSE_LENGTH = 46;

const KEY_LENGTH = 4;
const FIRST_FIXED_OFFSET = 18;
const SECOND_FIXED_OFFSET = 41;

/** Payload for the seed request: "BMW" followed by the access level. */
export function buildSeedRequestPayload(accessLevel = DEFAULT_ACCESS_LEVEL): Uint8Array {
    return new Uint8Array([LOGIN_COMMAND, 0x42, 0x4d, 0x57, accessLevel & 0xff]);
}

/**
 * Compute the 32-bit key from the seed frame.
 *
 * `seedFrame` is the entire response frame as received (address, length, ..., checksum) - the
 * algorithm indexes into it directly, including using `seedFrame[1]` (the length byte) as the
 * modulus, exactly as the reference does.
 */
export function calculateKey(accessLevel: number, seedFrame: Uint8Array): number {
    if (seedFrame.length !== SEED_RESPONSE_LENGTH) {
        throw new Error(`seed frame must be ${SEED_RESPONSE_LENGTH} bytes, got ${seedFrame.length}`);
    }
    const modulus = seedFrame[1] ?? 0;
    if (modulus === 0) throw new Error('seed frame length byte is zero; cannot form the key modulus');
    let key = 0;
    for (let i = 0; i < KEY_LENGTH; i++) {
        const idx = (accessLevel + i) % modulus;
        const sum = (seedFrame[idx] ?? 0) + (seedFrame[FIRST_FIXED_OFFSET + i] ?? 0) + (seedFrame[SECOND_FIXED_OFFSET + i] ?? 0);
        key = ((key << 8) | (sum & 0xff)) >>> 0;
    }
    return key >>> 0;
}

/** The four key bytes, big-endian - the payload body for the key response (after command 0x90). */
export function keyBytes(key: number): Uint8Array {
    return new Uint8Array([(key >>> 24) & 0xff, (key >>> 16) & 0xff, (key >>> 8) & 0xff, key & 0xff]);
}

/** Payload for the key response: command 0x90 followed by the four key bytes. */
export function buildKeyPayload(key: number): Uint8Array {
    return new Uint8Array([LOGIN_COMMAND, ...keyBytes(key)]);
}
