/**
 * Telegram byte layouts against BMW's own templates, and the nibble guards against the firmware.
 *
 * The layout tests compare with the telegram templates extracted from BMW's `12MSS54.PRG` SGBD -
 * so a passing test means "this is the shape the factory tool sends", not "this is what we think
 * it should be".
 *
 * The guard tests are the ones that matter. The bootloader sector cannot be erased over DS2, but
 * it CAN be over-programmed, and NOR programming only clears bits - so a single stray write there
 * is permanent and needs BDM to undo. These tests state that this package will not emit one.
 */
import { describe, it, expect } from 'vitest';
import {
    Command, LinearReadSegment, BAUD_RATES, WRITE_VERIFY,
    ERASE_ALLOWED_NIBBLES, WRITE_ALLOWED_NIBBLES, BOOTLOADER_NIBBLES,
    nibbleOf, eraseNibbleAllowed, writeNibbleAllowed, eraseNibbleRefusal, writeNibbleRefusal,
    buildReadTelegram, buildBaudRateTelegram, buildEncodingChecksumTelegram,
    decodeEncodingChecksum, describeWriteVerify, parseWriteAcknowledgement,
} from './telegrams';
import { buildDs2Frame, DME_DS2_ADDRESS, parseDs2Frame, Ds2Status, toHex } from './ds2';
import { Segment } from './regionMap';
import { buildReadPayload } from './backupPlan';

/** Hex string of a complete DS2 frame carrying `data`, for comparison with SGBD templates. */
function frameHex(data: Uint8Array): string {
    return toHex(buildDs2Frame(DME_DS2_ADDRESS, data));
}

describe('telegram layouts match the templates extracted from BMW 12MSS54.PRG', () => {
    it('read: 12 09 06 <seg> <a2 a1 a0> <count> <xor>', () => {
        // The SGBD template with its placeholder operands: segment 0, address 0, count 2.
        expect(frameHex(buildReadTelegram(0x00, 0x000000, 2))).toBe('12 09 06 00 00 00 00 02 1F');
    });

    it('baud rate: BAUDRATEN_UMSTELLUNG 12 08 91 00 25 80 03 2D', () => {
        expect(frameHex(buildBaudRateTelegram(9600, 0x03))).toBe('12 08 91 00 25 80 03 2D');
    });

    it('encodes the three baud rates the DME implements, and nothing else', () => {
        expect(BAUD_RATES).toEqual({ 9600: 0x002580, 38400: 0x009600, 125000: 0x01e848 });
    });

    it('rejects a baud trailer above the firmware cap of 0x19', () => {
        expect(() => buildBaudRateTelegram(125000, 0x20)).toThrow(/0x19/);
    });

    it('encoding checksum request is 12 04 0A 1C', () => {
        expect(frameHex(buildEncodingChecksumTelegram())).toBe('12 04 0A 1C');
    });

    it('agrees with the older inner-payload read builder in backupPlan', () => {
        const inner = buildReadPayload({ segment: Segment.Read, ds2Address: 0xd3f2a0, count: 122, imageOffset: 0 });
        const full = buildReadTelegram(Segment.Read, 0xd3f2a0, 122);
        expect(Array.from(full)).toEqual([Command.ReadMemory, ...Array.from(inner)]);
    });
});

describe('the nibble guards', () => {
    it('reads a DS2 address nibble the way the firmware dispatches on it', () => {
        expect(nibbleOf(0x200000)).toBe(0x2);
        expect(nibbleOf(0xd6ffff)).toBe(0xd);
        expect(nibbleOf(0x100000)).toBe(0x1);
    });

    it('permits exactly the four conversion windows for erase and for write', () => {
        expect([...ERASE_ALLOWED_NIBBLES]).toEqual([0x2, 0x5, 0xa, 0xd]);
        expect([...WRITE_ALLOWED_NIBBLES]).toEqual([0x2, 0x5, 0xa, 0xd]);
    });

    it('NEVER permits the bootloader nibbles, on either processor, for either operation', () => {
        for (const nibble of BOOTLOADER_NIBBLES) {
            const address = nibble << 20;
            expect(eraseNibbleAllowed(address)).toBe(false);
            expect(writeNibbleAllowed(address)).toBe(false);
        }
        expect(writeNibbleAllowed(0x100000)).toBe(false);
        expect(writeNibbleAllowed(0x900000)).toBe(false);
    });

    it('explains WHY a bootloader write is refused, in terms of what it would cost', () => {
        const why = writeNibbleRefusal(0x100000);
        expect(why).toMatch(/BOOTLOADER/);
        expect(why).toMatch(/permanent/);
        expect(why).toMatch(/BDM/);
        // The firmware really would accept it - that is the point of the guard.
        expect(why).toMatch(/WOULD accept/);
    });

    it('refuses the service block and the tail guard too, and says which is which', () => {
        expect(eraseNibbleRefusal(0x000000)).toMatch(/Free Identifiers/);
        expect(writeNibbleRefusal(0x400000)).toMatch(/EEPROM emulation|tail guard/);
        expect(writeNibbleRefusal(0x600000)).toMatch(/RAM/);
    });

    it('permits the calibration and program windows on both processors', () => {
        for (const address of [0x200000, 0x500000, 0xa00000, 0xd00000]) {
            expect(eraseNibbleAllowed(address)).toBe(true);
            expect(writeNibbleAllowed(address)).toBe(true);
        }
    });
});

describe('the linear read segments', () => {
    it('are the reference tool values, and are not in the conversion segment set', () => {
        expect(LinearReadSegment).toEqual({ master: 0x05, slave: 0x0c });
        expect(Object.values(Segment)).not.toContain(LinearReadSegment.master);
        expect(Object.values(Segment)).not.toContain(LinearReadSegment.slave);
    });
});

describe('the write acknowledgement', () => {
    /** Build a write response frame the way the DME does: status, segment, next address, count, verify. */
    function ack(segment: number, next: number, count: number, verify: number): Uint8Array {
        return buildDs2Frame(DME_DS2_ADDRESS, new Uint8Array([
            Ds2Status.Ack, segment, (next >>> 16) & 0xff, (next >>> 8) & 0xff, next & 0xff, count, verify,
        ]));
    }

    it('accepts a response where status, segment, address, count and verify all agree', () => {
        const r = parseWriteAcknowledgement(parseDs2Frame(ack(Segment.Write, 0x20007a, 122, 1)), 0x200000, 122);
        expect(r.ok).toBe(true);
    });

    it('rejects a positive status whose verify byte says the cells were not erased', () => {
        const r = parseWriteAcknowledgement(
            parseDs2Frame(ack(Segment.Write, 0x20007a, 122, WRITE_VERIFY.notErased)), 0x200000, 122);
        expect(r.ok).toBe(false);
        expect(r.ok === false && r.reason).toMatch(/cells not erased/);
    });

    it('rejects a short write even when the DME says ACK', () => {
        const r = parseWriteAcknowledgement(parseDs2Frame(ack(Segment.Write, 0x20007a, 100, 1)), 0x200000, 122);
        expect(r.ok).toBe(false);
        expect(r.ok === false && r.reason).toMatch(/wrote 100 of 122/);
    });

    it('rejects an echoed address that does not follow the bytes sent', () => {
        const r = parseWriteAcknowledgement(parseDs2Frame(ack(Segment.Write, 0x200080, 122, 1)), 0x200000, 122);
        expect(r.ok).toBe(false);
        expect(r.ok === false && r.reason).toMatch(/next address/);
    });

    it('names every verify byte the reference implementation documents', () => {
        expect(describeWriteVerify(WRITE_VERIFY.ok)).toBe('OK');
        expect(describeWriteVerify(WRITE_VERIFY.verifyFailed)).toMatch(/verify failed/);
        expect(describeWriteVerify(99)).toMatch(/unknown/);
    });
});

describe('the encoding checksum report', () => {
    it('treats a set bit as FAULTED, not as healthy', () => {
        const clean = decodeEncodingChecksum(0x00);
        expect(clean.anyFaulted).toBe(false);
        expect(clean.bootMasterFaulted).toBe(false);

        const bootMasterBad = decodeEncodingChecksum(0x01);
        expect(bootMasterBad.bootMasterFaulted).toBe(true);
        expect(bootMasterBad.anyFaulted).toBe(true);
    });

    it('places the boot-sector bits where the reference implementation found them', () => {
        expect(decodeEncodingChecksum(1 << 0).bootMasterFaulted).toBe(true);
        expect(decodeEncodingChecksum(1 << 4).bootSlaveFaulted).toBe(true);
        expect(decodeEncodingChecksum(1 << 2).dataMasterFaulted).toBe(true);
        expect(decodeEncodingChecksum(1 << 6).dataSlaveFaulted).toBe(true);
    });
});
