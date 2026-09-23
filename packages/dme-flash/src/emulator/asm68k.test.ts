/**
 * The assembler, validated the same way the emulator was: by reproducing BMW's own bytes.
 *
 * Writing BMW's sector-erase routine in this assembler's syntax and getting back the exact 0x62
 * bytes that sit at master 0x35DA is a much stronger check than any hand-written encoding test,
 * because it exercises every addressing mode the loader will use against a reference that was
 * produced by a real toolchain and runs on real silicon.
 *
 * If this test passes, the loader's source can be trusted to mean what it says.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { assemble, AssemblyError } from './asm68k';

const IMAGE = process.env.CSL_0401_BIN
    ?? String.raw`C:\Users\kazuh\CSL_0401_Binary_Disassembly_Notes\Full 211323000401PD31_TERRA.bin`;
const haveImage = existsSync(IMAGE);
const firmware = haveImage ? new Uint8Array(readFileSync(IMAGE)) : undefined;
const maybe = haveImage ? it : it.skip;

const hex = (b: Uint8Array): string =>
    Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');

/**
 * BMW's flash_erase_sector, transcribed from the disassembly at master 0x35DA.
 *
 * Entry: A5 = sector address. Exit: D0 = 0 on success, 4 or 6 on failure.
 */
const BMW_ERASE_STUB = `
        move.w  #$f0,(a5)              ; reset / read-array
        moveq   #4,d0                  ; default error code
        movea.l a5,a0
        move.w  #$aa,$0000aaaa         ; unlock 1
        move.w  #$55,$5554.w           ; unlock 2
        move.w  #$80,$0000aaaa         ; erase setup
        move.w  #$aa,$0000aaaa         ; unlock 1
        move.w  #$55,$5554.w           ; unlock 2
        move.w  #$30,(a5)              ; sector erase confirm
poll:   move.w  (a5),d2
        move.b  #$55,$00fffa27         ; service the watchdog inside the loop
        move.b  #$aa,$00fffa27
        tst.b   d2
        bmi.w   done                   ; DQ7 set -> finished
        andi.w  #$20,d2
        beq.b   poll                   ; DQ5 clear -> keep polling
        move.w  (a5),d2
        tst.b   d2
        bmi.w   done                   ; DQ7 after DQ5 -> finished after all
        moveq   #6,d0
        bra.w   out
done:   clr.l   d0
        movea.l d0,a0
out:    rts
`;

describe('the assembler, checked against BMW machine code', () => {
    maybe("reproduces flash_erase_sector byte for byte", () => {
        const expected = firmware!.subarray(0x35da, 0x35da + 0x62);
        const { bytes } = assemble(BMW_ERASE_STUB);
        expect(hex(bytes)).toBe(hex(expected));
    });

    maybe('assembles to exactly the length the firmware wrapper copies', () => {
        // The wrapper at 0x35AC copies 0x62 bytes; a longer or shorter stub would be truncated
        // or would drag unrelated bytes into RAM.
        expect(assemble(BMW_ERASE_STUB).bytes).toHaveLength(0x62);
    });
});

describe('addressing modes', () => {
    const encodes = (source: string, expected: string): void => {
        expect(hex(assemble(source).bytes)).toBe(expected);
    };

    it('immediate to absolute long, absolute word, and register indirect', () => {
        encodes('move.w #$aa,$0000aaaa', '33 fc 00 aa 00 00 aa aa');
        encodes('move.w #$55,$5554.w', '31 fc 00 55 55 54');
        encodes('move.w #$f0,(a5)', '3a bc 00 f0');
        encodes('move.b #$55,$00fffa27', '13 fc 00 55 00 ff fa 27');
    });

    it('long immediate to absolute long', () => {
        encodes('move.l #$00ffe000,$00fffb44', '23 fc 00 ff e0 00 00 ff fb 44');
    });

    it('lea with absolute long and PC-relative', () => {
        encodes('lea $00ffe800,a7', '4f f9 00 ff e8 00');
        encodes('here:\n lea here(pc),a0', '41 fa ff fe');
    });

    it('postincrement move, dbra, moveq, clr, tst', () => {
        encodes('move.w (a0)+,(a1)+', '32 d8');
        encodes('loop: dbra d0,loop', '51 c8 ff fe');
        encodes('moveq #4,d0', '70 04');
        encodes('clr.l d0', '42 80');
        encodes('clr.w $00fffb40', '42 79 00 ff fb 40');
        encodes('tst.b d2', '4a 02');
    });

    it('movec to VBR, jsr, rts, reset', () => {
        encodes('movec a0,vbr', '4e 7b 88 01');
        encodes('jsr $00ffe900', '4e b9 00 ff e9 00');
        encodes('rts', '4e 75');
        encodes('reset', '4e 70');
        encodes('move.w #$2700,sr', '46 fc 27 00');
    });

    it('eor, andi, cmpi', () => {
        encodes('eor.w d1,d2', 'b3 42');
        encodes('andi.w #$80,d2', '02 42 00 80');
        encodes('cmpi.l #$5aa556c9,$0000fffc', '0c b9 5a a5 56 c9 00 00 ff fc');
    });

    it('short and word branches', () => {
        encodes('a: bra.b a', '60 fe');
        encodes('a: bra.w a', '60 00 ff fe');
        encodes('a: beq.b a', '67 fe');
        encodes('a: bmi.w a', '6b 00 ff fe');
    });
});

describe('what the assembler refuses', () => {
    it('an unknown mnemonic, rather than emitting something plausible', () => {
        expect(() => assemble('frobnicate d0,d1')).toThrow(AssemblyError);
        expect(() => assemble('frobnicate d0,d1')).toThrow(/unknown mnemonic/);
    });

    it('an unresolved label', () => {
        expect(() => assemble('bra.w nowhere')).toThrow(/unknown label/);
        expect(() => assemble('lea missing(pc),a0')).toThrow(/unknown label/);
    });

    it('a duplicate label', () => {
        expect(() => assemble('a: rts\na: rts')).toThrow(/duplicate label/);
    });

    it('a short branch that cannot reach', () => {
        const far = ['a: rts', ...Array.from({ length: 200 }, () => ' nop'), ' bra.b a'].join('\n');
        expect(() => assemble(far)).toThrow(/out of range/);
    });

    it('an unparseable operand', () => {
        expect(() => assemble('move.w d0,@@@')).toThrow(/cannot resolve/);
    });
});

describe('labels and layout', () => {
    it('reports label addresses so a harness can place a stub', () => {
        const { labels } = assemble('start: nop\n nop\nstub: rts');
        expect(labels.get('start')).toBe(0);
        expect(labels.get('stub')).toBe(4);
    });

    it('ignores comments and blank lines', () => {
        expect(assemble('; a comment\n\n  rts  ; trailing\n').bytes).toEqual(new Uint8Array([0x4e, 0x75]));
    });
});
