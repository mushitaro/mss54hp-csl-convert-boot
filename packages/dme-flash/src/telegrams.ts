/**
 * DME command telegrams: the byte layouts, and the guards that decide which ones may exist.
 *
 * Every layout here was taken from BMW's own SGBD (12MSS54.PRG, telegram templates extracted
 * by XOR-0xF7 decoding) and cross-checked against the firmware handlers in the 0401 image:
 *
 *     FLASH_LOESCHEN            12 09 07 06 <a2 a1 a0> 00 <xor>     erase
 *     FLASH_SCHREIBEN           12 09 07 02 <a2 a1 a0> ..data..     write (no count byte)
 *     FLASH_SCHREIBEN_ENDE      12 09 07 0f <a2 a1 a0> 00 <xor>     finish
 *     DATENBEREICH_LOESCHEN_0E  12 09 07 0e 42 41 50 00 <xor>       recycling
 *     SEED_KEY                  12 08 90 42 4d 57 05 <xor>          login, "BMW" + level
 *     BAUDRATEN_UMSTELLUNG      12 08 91 00 25 80 03 <xor>          baud rate, not a password
 *     (read)                    12 09 06 <seg> <a2 a1 a0> <count>   read
 *
 * Note what cmd 0x91 actually is. An earlier reading of this project treated the three-entry
 * table at flash 0x3FB8 as a password table and cmd 0x91 as security access. It is neither: the
 * entries are 0x002580 / 0x009600 / 0x01E848 = 9600 / 38400 / 125000 baud, the SGBD job is named
 * BAUDRATEN_UMSTELLUNG, and the table is byte-identical across a CSL image, a standard M3 image
 * and a real-car dump - which a per-ECU secret could not be. The real login is cmd 0x90 with a
 * seed/key exchange (seedKey.ts).
 *
 * ## The two nibble allowlists
 *
 * These are the load-bearing safety property of this module, and they are not the same list.
 * Both were read out of the firmware, and the difference between them is exactly the hazard:
 *
 *  - **Erase** (0x2464 / 0x2516 / 0x2590) accepts only nibbles {0,2,5,8,A,D}. The bootloader
 *    nibble 0x1 is absent, so the bootloader sector can never be erased over DS2.
 *  - **Write** (0x2730-0x2798) is *more permissive*. In session state 0xFFD00E == 0xC3 -
 *    which is what a Finish (segment 0x0F) leaves behind - it accepts nibbles
 *    {0x00,0x10,0x40,0x80,0x90,0xC0}, and 0x10/0x90 are the bootloader.
 *
 * So the ECU will accept an over-program into its own bootloader, NOR programming can only clear
 * bits, and the sector can never be erased back. One stray bit there is permanent and needs BDM.
 * That is why writeNibbleAllowed exists as its own check rather than reusing the erase list,
 * and why both refuse nibble 0x1/0x9 unconditionally.
 */
import { Segment, WRITE_CHUNK_MAX, resolveFlashAddress } from './regionMap';
import { assertWriteUnlocked, tierForAddress } from './writeLock';
import { Ds2Status, type Ds2Response, statusOf } from './ds2';

/** DME command bytes, as they appear in the firmware's dispatch table at master 0x37A2. */
export const Command = {
    /** Identification. `12 04 00 16`. */
    Ident: 0x00,
    /** Memory read. Handler 0x1F44 - a READ, despite an earlier note in this repo calling it a write. */
    ReadMemory: 0x06,
    /** Programming control: erase / write / recycling / finish. Handler 0x216C. */
    ProgramControl: 0x07,
    /** Encoding checksum - reports per-area flash integrity. Handler 0x135A. */
    EncodingChecksum: 0x0a,
    /** Arm the staged-loader transfer. Handler 0x1B44. Does NOT itself jump - see the note below. */
    Jump: 0x34,
    /** Login (seed/key). Handler 0x16B0. */
    Login: 0x90,
    /** Baud rate change. Handler 0x19DC. */
    BaudRate: 0x91,
    /** Keep-alive. */
    KeepAlive: 0x9e,
    /** End diagnostic session. */
    EndDiagnostics: 0x9f,
} as const;
export type CommandValue = (typeof Command)[keyof typeof Command];

/**
 * Linear 24-bit read segments, from the reference tool's Ds2MemorySegment enum.
 *
 * These reach the whole address space including the bootloader sector, which is how a full
 * backup of SA0/SA1/SA2 is possible at all. Read-only: they are deliberately NOT in Segment
 * (the conversion segment set) so that no write or erase path can iterate onto them.
 */
export const LinearReadSegment = { master: 0x05, slave: 0x0c } as const;

/** Top nibble of a DS2 address - the window selector the firmware dispatches on. */
export function nibbleOf(ds2Address: number): number {
    return (ds2Address >>> 20) & 0xf;
}

/**
 * Nibbles this tool will emit an ERASE for: the two calibration and two program windows.
 *
 * The firmware would also accept 0x0/0x8 (Free Identifiers - the service block holding the VIN,
 * the AIF log, the flash counter and the application entry vector at 0x4884). This tool does not
 * erase that, because losing it is unrecoverable from any distributable image: every published
 * full binary has 0x4000-0x7FFF blanked, so there is nothing to restore it from except the car's
 * own backup.
 */
export const ERASE_ALLOWED_NIBBLES: readonly number[] = [0x2, 0x5, 0xa, 0xd] as const;

/** Nibbles this tool will emit a WRITE for. Same four windows - see the module note above. */
export const WRITE_ALLOWED_NIBBLES: readonly number[] = [0x2, 0x5, 0xa, 0xd] as const;

/** The bootloader sector's nibbles. Never writable by this tool, on either processor. */
export const BOOTLOADER_NIBBLES: readonly number[] = [0x1, 0x9] as const;

function describeNibble(nibble: number): string {
    switch (nibble) {
        case 0x0: case 0x8: return 'Free Identifiers / service block (VIN, AIF, flash counter, app entry vector)';
        case 0x1: case 0x9: return 'BOOTLOADER (SA0)';
        case 0x2: case 0xa: return 'calibration (SA3)';
        case 0x3: case 0xb: return 'DPRAM';
        case 0x4: case 0xc: return 'EEPROM emulation / tail guard (SA2)';
        case 0x5: case 0xd: return 'program (SA4-SA10)';
        case 0x6: case 0xe: return 'RAM';
        default: return 'unreachable window';
    }
}

/** Why an address may not be erased, or undefined when it may. */
export function eraseNibbleRefusal(ds2Address: number): string | undefined {
    const n = nibbleOf(ds2Address);
    if (BOOTLOADER_NIBBLES.includes(n)) {
        return `nibble 0x${n.toString(16).toUpperCase()} is the ${describeNibble(n)};`
            + ' the firmware refuses to erase it and the resident erase routine could not survive doing so';
    }
    if (!ERASE_ALLOWED_NIBBLES.includes(n)) {
        return `nibble 0x${n.toString(16).toUpperCase()} is ${describeNibble(n)}, which this tool never erases`;
    }
    return undefined;
}

/** Why an address may not be written, or undefined when it may. */
export function writeNibbleRefusal(ds2Address: number): string | undefined {
    const n = nibbleOf(ds2Address);
    if (BOOTLOADER_NIBBLES.includes(n)) {
        return `nibble 0x${n.toString(16).toUpperCase()} is the ${describeNibble(n)}.`
            + ' The firmware WOULD accept this over-program in session state 0xC3, NOR programming only'
            + ' clears bits, and the sector can never be erased back over DS2 - so any bit cleared here'
            + ' is permanent and recoverable only with BDM.';
    }
    if (!WRITE_ALLOWED_NIBBLES.includes(n)) {
        return `nibble 0x${n.toString(16).toUpperCase()} is ${describeNibble(n)}, which this tool never writes`;
    }
    return undefined;
}

export function eraseNibbleAllowed(ds2Address: number): boolean {
    return eraseNibbleRefusal(ds2Address) === undefined;
}

export function writeNibbleAllowed(ds2Address: number): boolean {
    return writeNibbleRefusal(ds2Address) === undefined;
}

function addressBytes(ds2Address: number): [number, number, number] {
    if (ds2Address < 0 || ds2Address > 0xffffff) {
        throw new Error(`DS2 address 0x${ds2Address.toString(16)} does not fit in 24 bits`);
    }
    return [(ds2Address >>> 16) & 0xff, (ds2Address >>> 8) & 0xff, ds2Address & 0xff];
}

/** Reject an address the ECU itself would refuse, before it costs a session. */
function assertResolvable(segment: number, ds2Address: number, length: number, what: string): void {
    const r = resolveFlashAddress(segment, ds2Address, length);
    if (!r.accepted) {
        throw new Error(`${what}: the ECU would refuse 0x${ds2Address.toString(16)} - ${r.reason}`);
    }
    if (r.maxLength < length) {
        throw new Error(
            `${what}: the ECU would clamp this request to ${r.maxLength} of ${length} bytes`
            + ' (a silently short write is how a window ends up partly programmed)');
    }
}

/**
 * Read telegram data: [0x06, segment, a2, a1, a0, count].
 *
 * Not gated by the write lock - reads cannot modify an ECU, and being able to read while locked
 * is the whole point of the locked state.
 */
export function buildReadTelegram(segment: number, ds2Address: number, count: number): Uint8Array {
    if (count <= 0 || count > 0xff) throw new Error(`read count ${count} outside 1..255`);
    return new Uint8Array([Command.ReadMemory, segment & 0xff, ...addressBytes(ds2Address), count & 0xff]);
}

/** Erase telegram data: [0x07, 0x06, a2, a1, a0, 0x00]. */
export function buildEraseTelegram(ds2Address: number): Uint8Array {
    assertWriteUnlocked(`erase at 0x${ds2Address.toString(16)}`, tierForAddress(ds2Address));
    const refusal = eraseNibbleRefusal(ds2Address);
    if (refusal) throw new Error(`refusing to build an erase: ${refusal}`);
    assertResolvable(Segment.Erase, ds2Address, 1, 'erase');
    return new Uint8Array([Command.ProgramControl, Segment.Erase, ...addressBytes(ds2Address), 0x00]);
}

/** Write telegram data: [0x07, 0x02, a2, a1, a0, ...bytes]. The count is implied by the frame length. */
export function buildWriteTelegram(ds2Address: number, bytes: Uint8Array): Uint8Array {
    assertWriteUnlocked(
        `write ${bytes.length} bytes at 0x${ds2Address.toString(16)}`, tierForAddress(ds2Address));
    const refusal = writeNibbleRefusal(ds2Address);
    if (refusal) throw new Error(`refusing to build a write: ${refusal}`);
    if (bytes.length === 0 || bytes.length > WRITE_CHUNK_MAX) {
        throw new Error(`write length ${bytes.length} outside 1..${WRITE_CHUNK_MAX}`);
    }
    if (bytes.length % 2 !== 0) throw new Error(`write length ${bytes.length} must be even (flash programs in words)`);
    if (ds2Address % 2 !== 0) throw new Error(`write address 0x${ds2Address.toString(16)} must be even`);
    assertResolvable(Segment.Write, ds2Address, bytes.length, 'write');
    return new Uint8Array([Command.ProgramControl, Segment.Write, ...addressBytes(ds2Address), ...bytes]);
}

/** Finish telegram data: [0x07, 0x0F, a2, a1, a0, 0x00]. */
export function buildFinishTelegram(ds2Address: number): Uint8Array {
    assertWriteUnlocked(`finish at 0x${ds2Address.toString(16)}`, tierForAddress(ds2Address));
    return new Uint8Array([Command.ProgramControl, Segment.Finish, ...addressBytes(ds2Address), 0x00]);
}

/**
 * Recycling telegram data: [0x07, 0x0E, a2, a1, a0, 0x00].
 *
 * The address is a state key, not a location. The firmware's handler at 0x3126 maps 0x424150+n
 * onto a state byte at 0xFFD150: 0x424150 -> 0xC6, 0x424151 ("BAQ") -> 0xC7, and a chained
 * sequence 0x42415F -> 0x1A -> ... -> 0x66 where each step requires the previous value. State
 * 0xC7 is what suppresses the tail-guard sector erase.
 */
export function buildRecyclingTelegram(ds2Address: number): Uint8Array {
    assertWriteUnlocked(
        `recycling control at 0x${ds2Address.toString(16)}`, tierForAddress(ds2Address));
    assertResolvable(Segment.Recycling, ds2Address, 1, 'recycling');
    return new Uint8Array([Command.ProgramControl, Segment.Recycling, ...addressBytes(ds2Address), 0x00]);
}

/**
 * Arm the staged-loader transfer: [0x34].
 *
 * The most dangerous telegram this package can produce, and not for the reason the name suggests.
 * The handler at 0x1B44 validates the magic at flash 0xFFFC and sets a state byte - it does not
 * jump. The jump routine (0x1BDE) is reached from the RESET handler at 0x256, which checks the
 * same magic on every power-up before the SIM, the stack or the K-line are initialised. So the
 * point of no return is programming that magic, not sending this command.
 */
export function buildJumpTelegram(): Uint8Array {
    assertWriteUnlocked('staged-loader transfer (cmd 0x34)');
    return new Uint8Array([Command.Jump]);
}

/** The three baud rates the DME implements, as their 24-bit encodings at flash 0x3FB8. */
export const BAUD_RATES = { 9600: 0x002580, 38400: 0x009600, 125000: 0x01e848 } as const;
export type BaudRate = keyof typeof BAUD_RATES;

/**
 * Baud rate telegram data: [0x91, r2, r1, r0, trailer].
 *
 * The trailer is compared against 0x19 by the handler (req[6] <= 0x19); the reference tuner
 * sends 0x19 and BMW's own template sends 0x03. Both are accepted. 125000 is only reachable
 * inside a programming session.
 */
export function buildBaudRateTelegram(rate: BaudRate, trailer = 0x19): Uint8Array {
    const encoded = BAUD_RATES[rate];
    if (trailer > 0x19) throw new Error(`baud trailer 0x${trailer.toString(16)} exceeds the firmware's cap of 0x19`);
    return new Uint8Array([Command.BaudRate, ...addressBytes(encoded), trailer & 0xff]);
}

/**
 * Encoding-checksum request. The whole frame is `12 04 0A 1C`: command 0x0A with no operand,
 * where 0x1C is the frame's XOR checksum (0x12 ^ 0x04 ^ 0x0A), not a payload byte.
 *
 * Read-only integrity report - see decodeEncodingChecksum.
 */
export function buildEncodingChecksumTelegram(): Uint8Array {
    return new Uint8Array([Command.EncodingChecksum]);
}

/**
 * Per-area flash integrity, as reported by the DME itself. A SET bit means that area is FAULTED.
 *
 * This is the one place the ECU will tell us whether it thinks its own bootloader is intact,
 * which makes it both a pre-flight check and the acceptance test after a bootloader replacement.
 */
export const ENCODING_CHECKSUM_BITS = {
    bootMaster: 0, programMaster: 1, dataMaster: 2,
    bootSlave: 4, programSlave: 5, dataSlave: 6,
} as const;

export interface EncodingChecksumReport {
    readonly raw: number;
    readonly bootMasterFaulted: boolean;
    readonly programMasterFaulted: boolean;
    readonly dataMasterFaulted: boolean;
    readonly bootSlaveFaulted: boolean;
    readonly programSlaveFaulted: boolean;
    readonly dataSlaveFaulted: boolean;
    readonly anyFaulted: boolean;
}

export function decodeEncodingChecksum(raw: number): EncodingChecksumReport {
    const bit = (n: number): boolean => (raw & (1 << n)) !== 0;
    return {
        raw,
        bootMasterFaulted: bit(ENCODING_CHECKSUM_BITS.bootMaster),
        programMasterFaulted: bit(ENCODING_CHECKSUM_BITS.programMaster),
        dataMasterFaulted: bit(ENCODING_CHECKSUM_BITS.dataMaster),
        bootSlaveFaulted: bit(ENCODING_CHECKSUM_BITS.bootSlave),
        programSlaveFaulted: bit(ENCODING_CHECKSUM_BITS.programSlave),
        dataSlaveFaulted: bit(ENCODING_CHECKSUM_BITS.dataSlave),
        anyFaulted: raw !== 0,
    };
}

/**
 * Verify byte in a write response. Only 1 means the bytes are in flash.
 *
 * Value 3 ("cells not erased") is how an unerased target announces itself, and is the reason a
 * positive DS2 status alone is never treated as success.
 */
export const WRITE_VERIFY = {
    ok: 1, verifyFailed: 2, notErased: 3, bootFieldManagementError: 6,
    programSessionActive: 7, dataSessionActive: 8, programIncomplete: 12, dataIncomplete: 15,
} as const;

export function describeWriteVerify(v: number): string {
    switch (v) {
        case WRITE_VERIFY.ok: return 'OK';
        case WRITE_VERIFY.verifyFailed: return 'verify failed';
        case WRITE_VERIFY.notErased: return 'cells not erased';
        case WRITE_VERIFY.bootFieldManagementError: return 'boot-mode field management error';
        case WRITE_VERIFY.programSessionActive: return 'program programming session active';
        case WRITE_VERIFY.dataSessionActive: return 'data programming session active';
        case WRITE_VERIFY.programIncomplete: return 'program incomplete';
        case WRITE_VERIFY.dataIncomplete: return 'data incomplete';
        default: return `unknown verify byte ${v}`;
    }
}

export interface WriteAcknowledgement {
    readonly segment: number;
    readonly nextAddress: number;
    readonly writtenCount: number;
    readonly verify: number;
}

export type WriteAckResult =
    | { readonly ok: true; readonly ack: WriteAcknowledgement }
    | { readonly ok: false; readonly reason: string };

/**
 * Validate a write response against what was actually sent.
 *
 * All four of status, segment, echoed next address and written count must agree, plus a verify
 * byte of 1. The reference implementation learned this the hard way: a positive status alone
 * does not mean the bytes landed.
 */
export function parseWriteAcknowledgement(
    response: Ds2Response, sentAddress: number, sentLength: number,
): WriteAckResult {
    if (!response.ok) return { ok: false, reason: response.error ?? 'malformed response frame' };
    const data = response.data;
    if (!data || data.length < 7) {
        return { ok: false, reason: `write response carries ${data?.length ?? 0} data bytes, expected 7` };
    }
    const status = statusOf(response);
    if (status !== Ds2Status.Ack) return { ok: false, reason: `status 0x${(status ?? 0).toString(16)} is not ACK` };
    const segment = data[1] ?? -1;
    const nextAddress = ((data[2] ?? 0) << 16) | ((data[3] ?? 0) << 8) | (data[4] ?? 0);
    const writtenCount = data[5] ?? -1;
    const verify = data[6] ?? -1;
    const ack: WriteAcknowledgement = { segment, nextAddress, writtenCount, verify };
    if (segment !== Segment.Write) {
        return { ok: false, reason: `echoed segment 0x${segment.toString(16)} is not the write segment` };
    }
    if (nextAddress !== sentAddress + sentLength) {
        return {
            ok: false,
            reason: `echoed next address 0x${nextAddress.toString(16)} != 0x${(sentAddress + sentLength).toString(16)}`,
        };
    }
    if (writtenCount !== sentLength) return { ok: false, reason: `wrote ${writtenCount} of ${sentLength} bytes` };
    if (verify !== WRITE_VERIFY.ok) return { ok: false, reason: `verify byte ${verify}: ${describeWriteVerify(verify)}` };
    return { ok: true, ack };
}

/**
 * Load-time invariant: the bootloader nibbles must never appear in either allowlist, and
 * writeNibbleAllowed must actually refuse them.
 *
 * Checked at import so an edit that widens a list fails the package rather than a car.
 */
function assertBootloaderIsUnreachable(): void {
    for (const n of BOOTLOADER_NIBBLES) {
        if (ERASE_ALLOWED_NIBBLES.includes(n)) {
            throw new Error(`erase allowlist must never contain bootloader nibble 0x${n.toString(16)}`);
        }
        if (WRITE_ALLOWED_NIBBLES.includes(n)) {
            throw new Error(`write allowlist must never contain bootloader nibble 0x${n.toString(16)}`);
        }
        const address = n << 20;
        if (writeNibbleAllowed(address)) throw new Error(`writeNibbleAllowed accepted bootloader 0x${address.toString(16)}`);
        if (eraseNibbleAllowed(address)) throw new Error(`eraseNibbleAllowed accepted bootloader 0x${address.toString(16)}`);
    }
}
assertBootloaderIsUnreachable();
