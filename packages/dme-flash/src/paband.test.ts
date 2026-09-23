/**
 * The parser is checked against BMW's own declared checksums, over every MSS54 file in the
 * SP-DATEN package - 92 files, program and calibration, MSS54 and MSS54HP.
 *
 * That breadth is the point. An earlier version of this parser treated record type 0x10 as a
 * terminator, which dropped the last 16 bytes of every 64 KiB block. Section sizes still looked
 * plausible (65520 instead of 65536), addresses were still contiguous, and the dropped bytes were
 * real program code. Only the declared checksum caught it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseAustauschDatei, verifyDeclaredChecksum, crc16Arc } from './paband';

const SP_DATEN_MSS54 = process.env.SP_DATEN_MSS54
    ?? String.raw`C:\Users\kazuh\E46M3SMG2_TuningTool\E46_v74\data\MSS54`;
const CSL_0401_PA = join(SP_DATEN_MSS54, '7837340A.0PA');
const CSL_PD31_DA = join(SP_DATEN_MSS54, 'A7837331.0DA');

const havePackage = existsSync(SP_DATEN_MSS54);
const maybe = havePackage ? it : it.skip;

describe('crc16Arc', () => {
    it('matches the documented check value for CRC-16/ARC', () => {
        // "123456789" -> 0xBB3D, the standard check vector for this parameterisation.
        expect(crc16Arc(new TextEncoder().encode('123456789'))).toBe(0xbb3d);
    });
});

describe('every MSS54 SP-DATEN file validates against its own declared checksum', () => {
    maybe('parses all .0PA and .0DA files with zero failures', () => {
        const files = readdirSync(SP_DATEN_MSS54).filter((f) => /\.0[PD]A$/i.test(f));
        expect(files.length).toBeGreaterThan(80);

        const failures: string[] = [];
        for (const name of files) {
            const parsed = parseAustauschDatei(readFileSync(join(SP_DATEN_MSS54, name)));
            const verdict = verifyDeclaredChecksum(parsed);
            if (verdict.declared === undefined) failures.push(`${name}: no $CHECKSUMME`);
            else if (!verdict.valid) {
                failures.push(`${name}: declared 0x${verdict.declared.toString(16)}`
                    + ` computed 0x${verdict.computed.toString(16)}`);
            }
            // Payload must be whole 64 KiB blocks - the shape the 0x10 bug broke.
            if (parsed.payload.length % 0x8000 !== 0) {
                failures.push(`${name}: payload ${parsed.payload.length} is not a multiple of 32 KiB`);
            }
        }
        expect(failures).toEqual([]);
    });
});

describe('the genuine CSL 0401 program file', () => {
    maybe('is MSS54HP, stand 0401, and 512 KiB of payload in eight 64 KiB sections', () => {
        const pa = parseAustauschDatei(readFileSync(CSL_0401_PA));
        expect(pa.meta.get('ZL_System')).toBe('MSS54HP');
        expect(pa.meta.get('K_Stand')).toBe('0401');
        expect(pa.meta.get('ZL_REFERENZ')).toBe('211325000401');
        expect(pa.reference).toBe('211325000401');
        expect(pa.payload.length).toBe(524288);
        expect(pa.sections).toHaveLength(8);
        for (const s of pa.sections) expect(s.bytes.length).toBe(65536);
    });

    maybe('carries its sections at the DS2 program windows: nibble 0x5 master, 0xD slave', () => {
        const pa = parseAustauschDatei(readFileSync(CSL_0401_PA));
        const addresses = pa.sections.map((s) => s.address);
        expect(addresses).toEqual([
            0xd00000, 0xd10000, 0xd20000, 0xd30000, // slave
            0x500000, 0x510000, 0x520000, 0x530000, // master
        ]);
    });

    maybe('declares the checksum computed over the payload in file order, not address order', () => {
        const pa = parseAustauschDatei(readFileSync(CSL_0401_PA));
        expect(pa.declaredChecksum).toBe(0xa06a);
        expect(crc16Arc(pa.payload)).toBe(0xa06a);

        // Address order gives a different answer, so file order is a real property of the format.
        const byAddress = [...pa.sections].sort((a, b) => a.address - b.address);
        const reordered = new Uint8Array(pa.payload.length);
        let o = 0;
        for (const s of byAddress) { reordered.set(s.bytes, o); o += s.bytes.length; }
        expect(crc16Arc(reordered)).not.toBe(0xa06a);
    });
});

describe('record type 0x10 is data, not a terminator', () => {
    maybe('a non-empty 0x10 record contributes its 16 bytes to the block', () => {
        const pa = parseAustauschDatei(readFileSync(CSL_0401_PA));
        // The block-final record of the first slave block carries these bytes at 0xD0FFF0.
        const slave0 = pa.sections.find((s) => s.address === 0xd00000)!;
        expect([...slave0.bytes.subarray(0xfff0)])
            .toEqual([0x13, 0xc0, 0x00, 0xff, 0xd9, 0x30, 0x48, 0x78,
                0x00, 0x80, 0x48, 0x78, 0x00, 0xb0, 0x4e, 0xb9]);
    });

    it('a zero-length 0x10 record is accepted and adds nothing', () => {
        // :10000000 <16 bytes> then :00105010 83 - the terminator shape BMW emits.
        const body = '00'.repeat(16);
        const file = [
            ':10000000' + body + sumOf('10' + '0000' + '00' + body),
            ':001D5010' + sumOf('00' + '1D50' + '10'),
            ':00000001FF',
        ].join('\n');
        const parsed = parseAustauschDatei(file);
        expect(parsed.payload.length).toBe(16);
    });
});

describe('malformed input is refused rather than silently accepted', () => {
    it('rejects a bad record checksum', () => {
        expect(() => parseAustauschDatei(':0200000400D02B\n')).toThrow(/checksum mismatch/);
    });
    it('rejects an unknown record type', () => {
        expect(() => parseAustauschDatei(':00000005FB\n')).toThrow(/unknown record type/);
    });
    it('rejects a non-contiguous block instead of concatenating across the hole', () => {
        const a = ':10000000' + '00'.repeat(16) + sumOf('10' + '0000' + '00' + '00'.repeat(16));
        const b = ':10002000' + '00'.repeat(16) + sumOf('10' + '0020' + '00' + '00'.repeat(16));
        expect(() => parseAustauschDatei(`${a}\n${b}\n`)).toThrow(/non-contiguous/);
    });
});

describe('the genuine CSL calibration file (PD31)', () => {
    maybe('is the 64 KiB data pair, at the DS2 calibration windows', () => {
        const da = parseAustauschDatei(readFileSync(CSL_PD31_DA));
        expect(da.meta.get('ZL_System')).toBe('MSS54HP');
        expect(da.payload.length).toBe(65536);
        expect(da.sections.map((s) => s.address).sort((x, y) => x - y))
            .toEqual([0x200000, 0x204000, 0xa00000, 0xa04000]);
        expect(verifyDeclaredChecksum(da).valid).toBe(true);
    });
});

/** Intel HEX record checksum: two's complement of the sum of every byte before it. */
function sumOf(hex: string): string {
    let sum = 0;
    for (let i = 0; i < hex.length; i += 2) sum += parseInt(hex.slice(i, i + 2), 16);
    return (((~sum + 1) & 0xff)).toString(16).padStart(2, '0').toUpperCase();
}
