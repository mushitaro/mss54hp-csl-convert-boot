/**
 * A small, strict CPU32 assembler - enough to write a flash loader, and nothing more.
 *
 * Why assemble in TypeScript rather than shell out to binutils: the loader has to be assembled,
 * run on the emulator and asserted about in the same test run. A checked-in generated blob would
 * let the source and the bytes drift apart, and the one thing this project cannot afford is a
 * loader whose reviewed source is not the loader that gets written to an ECU.
 *
 * The same rule as the CPU core applies here: **anything it does not understand is an error.**
 * No silent skipping, no "best effort" encoding. A typo in the loader source must fail the build,
 * not assemble into something plausible.
 *
 * Syntax is Motorola-ish and deliberately small:
 *
 *     label:                      a label definition
 *     move.w  #$2700,sr           immediate to SR
 *     move.l  #$00FFE000,$FFFB44  immediate to absolute long
 *     lea     $00FFE800,a7        absolute long to address register
 *     lea     stub(pc),a0         PC-relative
 *     move.w  (a0)+,(a1)+         postincrement
 *     dbra    d0,copy             loop
 *     bra.b   halt / beq.w done   explicit branch width
 *     dc.w    $1234               literal data
 */

export interface AssembledProgram {
    readonly bytes: Uint8Array;
    /** Label name to absolute address. */
    readonly labels: ReadonlyMap<string, number>;
    /** Source line for each emitted address, for readable failures. */
    readonly lineOf: ReadonlyMap<number, number>;
}

export class AssemblyError extends Error {
    constructor(message: string, readonly line: number, readonly text: string) {
        super(`line ${line}: ${message}\n    ${text.trim()}`);
        this.name = 'AssemblyError';
    }
}

interface Ea {
    mode: number;
    reg: number;
    /** Extension words, in order. */
    ext: number[];
    /** True for PC-relative, whose displacement depends on where the extension lands. */
    pcRelativeTo?: string;
}

const CONDITIONS: Record<string, number> = {
    ra: 0, sr_: 1, hi: 2, ls: 3, cc: 4, cs: 5, ne: 6, eq: 7,
    vc: 8, vs: 9, pl: 10, mi: 11, ge: 12, lt: 13, gt: 14, le: 15,
};

function parseAtom(text: string, labels: ReadonlyMap<string, number>): number | undefined {
    const t = text.trim();
    if (t.startsWith('$')) {
        const v = parseInt(t.slice(1), 16);
        return Number.isNaN(v) ? undefined : v >>> 0;
    }
    if (/^-?\d+$/.test(t)) return parseInt(t, 10);
    return labels.get(t);
}

/**
 * Evaluate a small integer expression: labels and numbers combined with + - * /.
 *
 * This exists so a loader can say `#(stub_end-stub)/2-1` instead of a hardcoded word count.
 * A stub length that drifts out of step with the stub is exactly the kind of silent error that
 * would copy half a routine into RAM and jump to it.
 */
export function evaluate(expression: string, labels: ReadonlyMap<string, number>): number | undefined {
    const tokens = expression.replace(/\s+/g, '').match(/\(|\)|[+\-*/]|\$[0-9a-fA-F]+|[A-Za-z_][A-Za-z0-9_]*|\d+/g);
    if (!tokens) return undefined;
    let pos = 0;
    const peek = (): string | undefined => tokens[pos];
    const parseFactor = (): number | undefined => {
        const t = peek();
        if (t === undefined) return undefined;
        if (t === '(') { pos++; const v = parseSum(); if (peek() !== ')') return undefined; pos++; return v; }
        if (t === '-') { pos++; const v = parseFactor(); return v === undefined ? undefined : -v; }
        pos++;
        return parseAtom(t, labels);
    };
    const parseProduct = (): number | undefined => {
        let left = parseFactor();
        if (left === undefined) return undefined;
        for (;;) {
            const t = peek();
            if (t !== '*' && t !== '/') return left;
            pos++;
            const right = parseFactor();
            if (right === undefined) return undefined;
            left = t === '*' ? left * right : Math.trunc(left / right);
        }
    };
    const parseSum = (): number | undefined => {
        let left = parseProduct();
        if (left === undefined) return undefined;
        for (;;) {
            const t = peek();
            if (t !== '+' && t !== '-') return left;
            pos++;
            const right = parseProduct();
            if (right === undefined) return undefined;
            left = t === '+' ? left + right : left - right;
        }
    };
    const value = parseSum();
    return pos === tokens.length ? value : undefined;
}

/** Size suffix to (bytes, MOVE size field, standard size field). */
function sizeOf(suffix: string | undefined, line: number, text: string): 1 | 2 | 4 {
    if (suffix === 'b') return 1;
    if (suffix === 'w' || suffix === undefined) return 2;
    if (suffix === 'l') return 4;
    throw new AssemblyError(`unknown size suffix ".${suffix}"`, line, text);
}

export function assemble(source: string): AssembledProgram {
    const lines = source.split(/\r?\n/);
    const labels = new Map<string, number>();
    const lineOf = new Map<number, number>();

    interface Item {
        line: number;
        text: string;
        mnemonic: string;
        size: 1 | 2 | 4;
        operands: string[];
        address: number;
        length: number;
    }

    // ---- pass 1: measure, and record label addresses -------------------------------------
    const items: Item[] = [];
    let address = 0;
    lines.forEach((raw, i) => {
        const line = i + 1;
        const stripped = raw.replace(/;.*$/, '').trim();
        if (stripped === '') return;

        let rest = stripped;

        // NAME equ <expression> - a named constant. Evaluated immediately, so it can only
        // refer to things already defined; that keeps constants from depending on layout.
        const equMatch = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+equ\s+(.+)$/i);
        if (equMatch) {
            const name = equMatch[1]!;
            if (labels.has(name)) throw new AssemblyError(`duplicate symbol "${name}"`, line, raw);
            const value = evaluate(equMatch[2]!, labels);
            if (value === undefined) throw new AssemblyError(`cannot evaluate "${equMatch[2]}"`, line, raw);
            labels.set(name, value);
            return;
        }

        const labelMatch = rest.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*/);
        if (labelMatch) {
            const name = labelMatch[1]!;
            if (labels.has(name)) throw new AssemblyError(`duplicate label "${name}"`, line, raw);
            labels.set(name, address);
            rest = rest.slice(labelMatch[0].length).trim();
            if (rest === '') return;
        }

        const parts = rest.match(/^(\S+)\s*(.*)$/);
        if (!parts) throw new AssemblyError('cannot parse', line, raw);
        const [mnemonicRaw, operandText] = [parts[1]!.toLowerCase(), parts[2]!];
        const dot = mnemonicRaw.indexOf('.');
        const mnemonic = dot === -1 ? mnemonicRaw : mnemonicRaw.slice(0, dot);
        const suffix = dot === -1 ? undefined : mnemonicRaw.slice(dot + 1);
        const operands = operandText.trim() === ''
            ? []
            : splitOperands(operandText).map((o) => o.trim());

        const size = mnemonic === 'dc' ? sizeOf(suffix, line, raw)
            : sizeOf(suffix === 'b' || suffix === 'w' || suffix === 'l' ? suffix : undefined, line, raw);

        const item: Item = { line, text: raw, mnemonic, size, operands, address, length: 0 };
        item.length = measure(item, suffix);
        items.push(item);
        address += item.length;
    });

    // ---- pass 2: encode ------------------------------------------------------------------
    const out: number[] = [];
    for (const item of items) {
        lineOf.set(item.address, item.line);
        const words = encode(item, labels);
        if (words.length * 2 !== item.length) {
            throw new AssemblyError(
                `internal: measured ${item.length} bytes but encoded ${words.length * 2}`,
                item.line, item.text);
        }
        for (const w of words) { out.push((w >>> 8) & 0xff, w & 0xff); }
    }

    return { bytes: Uint8Array.from(out), labels, lineOf };

    // --------------------------------------------------------------------------------------

    function splitOperands(text: string): string[] {
        const parts: string[] = [];
        let depth = 0, current = '';
        for (const ch of text) {
            if (ch === '(') depth++;
            if (ch === ')') depth--;
            if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
            current += ch;
        }
        if (current.trim() !== '') parts.push(current);
        return parts;
    }

    /** Bytes an instruction occupies. Must agree exactly with encode(). */
    function measure(item: Item, suffix: string | undefined): number {
        const { mnemonic, operands, size, line, text } = item;
        switch (mnemonic) {
            case 'rts': case 'nop': case 'reset': return 2;
            case 'dc': return operands.length * size;
            case 'moveq': return 2;
            case 'dbra': case 'dbf': return 4;
            case 'bra': case 'bsr': case 'beq': case 'bne': case 'bmi': case 'bpl':
            case 'bcc': case 'bcs': case 'bhi': case 'bls': case 'bge': case 'blt':
            case 'bgt': case 'ble': case 'bvc': case 'bvs':
                return suffix === 'b' ? 2 : 4;
            case 'movec': return 4;
            case 'addq': case 'subq':
                return 2 + eaLength(operands[1] ?? '', size, line, text) * 2;
            default: break;
        }
        // Everything else is opcode + operand extensions.
        let words = 1;
        for (const operand of operands) {
            words += eaLength(operand, size, line, text);
        }
        if (mnemonic === 'andi' || mnemonic === 'ori' || mnemonic === 'cmpi'
            || mnemonic === 'eori' || mnemonic === 'addi' || mnemonic === 'subi') {
            // The immediate is counted by eaLength for the "#..." operand already.
        }
        return words * 2;
    }

    function eaLength(operand: string, size: 1 | 2 | 4, line: number, text: string): number {
        const t = operand.trim().toLowerCase();
        if (/^[da][0-7]$/.test(t) || t === 'sp' || t === 'sr' || t === 'usp' || t === 'vbr') return 0;
        if (/^\(a[0-7]\)\+?$/.test(t) || /^-\(a[0-7]\)$/.test(t) || /^\(sp\)\+?$/.test(t)) return 0;
        if (t.startsWith('#')) return size === 4 ? 2 : 1;
        if (/\(pc\)$/.test(t)) return 1;
        // Absolute width is syntactic, never inferred from the value - so pass 1 can measure
        // without resolving labels, and an instruction can never change length in pass 2.
        return t.endsWith('.w') ? 1 : 2;
    }

    function parseEa(operand: string, size: 1 | 2 | 4, item: Item, extAddress: number): Ea {
        const t = operand.trim();
        const lower = t.toLowerCase();

        let m = lower.match(/^d([0-7])$/);
        if (m) return { mode: 0, reg: Number(m[1]), ext: [] };
        m = lower.match(/^a([0-7])$/);
        if (m) return { mode: 1, reg: Number(m[1]), ext: [] };
        if (lower === 'sp') return { mode: 1, reg: 7, ext: [] };
        m = lower.match(/^\(a([0-7])\)$/);
        if (m) return { mode: 2, reg: Number(m[1]), ext: [] };
        m = lower.match(/^\(a([0-7])\)\+$/);
        if (m) return { mode: 3, reg: Number(m[1]), ext: [] };
        m = lower.match(/^-\(a([0-7])\)$/);
        if (m) return { mode: 4, reg: Number(m[1]), ext: [] };
        if (lower === '(sp)+') return { mode: 3, reg: 7, ext: [] };
        if (lower === '-(sp)') return { mode: 4, reg: 7, ext: [] };

        if (t.startsWith('#')) {
            const body = t.slice(1);
            const value = evaluate(body, labels);
            if (value === undefined) throw new AssemblyError(`cannot resolve immediate "${body}"`, item.line, item.text);
            if (size === 4) return { mode: 7, reg: 4, ext: [(value >>> 16) & 0xffff, value & 0xffff] };
            return { mode: 7, reg: 4, ext: [value & 0xffff] };
        }

        m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)\(pc\)$/i);
        if (m) {
            const target = labels.get(m[1]!);
            if (target === undefined) throw new AssemblyError(`unknown label "${m[1]}"`, item.line, item.text);
            const disp = target - extAddress;
            if (disp < -0x8000 || disp > 0x7fff) {
                throw new AssemblyError(`PC-relative displacement ${disp} out of range`, item.line, item.text);
            }
            return { mode: 7, reg: 2, ext: [disp & 0xffff] };
        }

        const isWord = /\.w$/i.test(t);
        const bare = t.replace(/\.[wWlL]$/, '');
        const value = evaluate(bare, labels);
        if (value === undefined) throw new AssemblyError(`cannot resolve operand "${t}"`, item.line, item.text);
        if (isWord) return { mode: 7, reg: 0, ext: [value & 0xffff] };
        return { mode: 7, reg: 1, ext: [(value >>> 16) & 0xffff, value & 0xffff] };
    }

    function encode(item: Item, _labels: ReadonlyMap<string, number>): number[] {
        const { mnemonic, operands, size, line, text } = item;
        const words: number[] = [];

        const ea = (operand: string, s: 1 | 2 | 4, precedingWords: number): Ea =>
            parseEa(operand, s, item, item.address + 2 + precedingWords * 2);

        switch (mnemonic) {
            case 'rts': return [0x4e75];
            case 'nop': return [0x4e71];
            case 'reset': return [0x4e70];

            case 'dc': {
                for (const operand of operands) {
                    const value = evaluate(operand, labels);
                    if (value === undefined) throw new AssemblyError(`cannot resolve "${operand}"`, line, text);
                    if (size === 4) { words.push((value >>> 16) & 0xffff, value & 0xffff); }
                    else words.push(value & 0xffff);
                }
                return words;
            }

            case 'moveq': {
                const [imm, dst] = operands;
                const value = evaluate((imm ?? '').replace('#', ''), labels);
                const d = (dst ?? '').match(/^d([0-7])$/i);
                if (value === undefined || !d) throw new AssemblyError('moveq #imm,Dn', line, text);
                return [0x7000 | (Number(d[1]) << 9) | (value & 0xff)];
            }

            case 'movec': {
                const [src, dst] = operands;
                if ((dst ?? '').toLowerCase() !== 'vbr') throw new AssemblyError('only movec <reg>,vbr', line, text);
                const s = (src ?? '').toLowerCase();
                const dm = s.match(/^d([0-7])$/); const am = s.match(/^a([0-7])$/);
                if (!dm && !am) throw new AssemblyError('movec Rn,vbr', line, text);
                const reg = Number((dm ?? am)![1]);
                const ext = (am ? 0x8000 : 0) | (reg << 12) | 0x801;
                return [0x4e7b, ext];
            }

            case 'dbra': case 'dbf': {
                const [reg, label] = operands;
                const d = (reg ?? '').match(/^d([0-7])$/i);
                const target = labels.get((label ?? '').trim());
                if (!d || target === undefined) throw new AssemblyError('dbra Dn,label', line, text);
                const disp = target - (item.address + 2);
                return [0x51c8 | Number(d[1]), disp & 0xffff];
            }

            case 'addq': case 'subq': {
                const [imm, dst] = operands;
                const raw = evaluate((imm ?? '').replace('#', ''), labels);
                if (raw === undefined || raw < 1 || raw > 8) {
                    throw new AssemblyError(`${mnemonic} takes an immediate 1..8`, line, text);
                }
                const count = raw === 8 ? 0 : raw;
                const sizeField = size === 1 ? 0 : size === 2 ? 1 : 2;
                const e = ea(dst ?? '', size, 0);
                const isSub = mnemonic === 'subq' ? 0x0100 : 0;
                return [0x5000 | (count << 9) | isSub | (sizeField << 6) | (e.mode << 3) | e.reg, ...e.ext];
            }

            case 'lea': {
                const [src, dst] = operands;
                const a = (dst ?? '').match(/^a([0-7])$/i);
                if (!a) throw new AssemblyError('lea <ea>,An', line, text);
                const e = ea(src ?? '', 4, 0);
                return [0x41c0 | (Number(a[1]) << 9) | (e.mode << 3) | e.reg, ...e.ext];
            }

            case 'jsr': case 'jmp': {
                const e = ea(operands[0] ?? '', 4, 0);
                const base = mnemonic === 'jsr' ? 0x4e80 : 0x4ec0;
                return [base | (e.mode << 3) | e.reg, ...e.ext];
            }

            case 'clr': case 'tst': {
                const sizeField = size === 1 ? 0 : size === 2 ? 1 : 2;
                const e = ea(operands[0] ?? '', size, 0);
                const base = mnemonic === 'clr' ? 0x4200 : 0x4a00;
                return [base | (sizeField << 6) | (e.mode << 3) | e.reg, ...e.ext];
            }

            case 'andi': case 'ori': case 'cmpi': case 'eori': case 'addi': case 'subi': {
                const family = { ori: 0x0000, andi: 0x0200, subi: 0x0400, addi: 0x0600, eori: 0x0a00, cmpi: 0x0c00 }[mnemonic]!;
                const sizeField = size === 1 ? 0 : size === 2 ? 1 : 2;
                const immEa = ea(operands[0] ?? '', size, 0);
                if (immEa.mode !== 7 || immEa.reg !== 4) throw new AssemblyError(`${mnemonic} needs an immediate first`, line, text);
                const dstEa = ea(operands[1] ?? '', size, immEa.ext.length);
                return [family | (sizeField << 6) | (dstEa.mode << 3) | dstEa.reg, ...immEa.ext, ...dstEa.ext];
            }

            case 'eor': {
                const [src, dst] = operands;
                const d = (src ?? '').match(/^d([0-7])$/i);
                if (!d) throw new AssemblyError('eor Dn,<ea>', line, text);
                const opmode = size === 1 ? 4 : size === 2 ? 5 : 6;
                const e = ea(dst ?? '', size, 0);
                return [0xb000 | (Number(d[1]) << 9) | (opmode << 6) | (e.mode << 3) | e.reg, ...e.ext];
            }

            case 'cmp': {
                const [src, dst] = operands;
                const d = (dst ?? '').match(/^d([0-7])$/i);
                if (!d) throw new AssemblyError('cmp <ea>,Dn', line, text);
                const opmode = size === 1 ? 0 : size === 2 ? 1 : 2;
                const e = ea(src ?? '', size, 0);
                return [0xb000 | (Number(d[1]) << 9) | (opmode << 6) | (e.mode << 3) | e.reg, ...e.ext];
            }

            case 'move': case 'movea': {
                const [src, dst] = operands;
                if ((dst ?? '').toLowerCase() === 'sr') {
                    const e = ea(src ?? '', 2, 0);
                    return [0x46c0 | (e.mode << 3) | e.reg, ...e.ext];
                }
                const srcEa = ea(src ?? '', size, 0);
                const dstEa = ea(dst ?? '', size, srcEa.ext.length);
                const sizeField = size === 1 ? 1 : size === 2 ? 3 : 2;
                return [
                    (sizeField << 12) | (dstEa.reg << 9) | (dstEa.mode << 6) | (srcEa.mode << 3) | srcEa.reg,
                    ...srcEa.ext, ...dstEa.ext,
                ];
            }

            default: break;
        }

        // --- branches -----------------------------------------------------------------
        const branch = mnemonic.match(/^b(ra|sr|eq|ne|mi|pl|cc|cs|hi|ls|ge|lt|gt|le|vc|vs)$/);
        if (branch) {
            const key = branch[1] === 'sr' ? 'sr_' : branch[1]!;
            const condition = CONDITIONS[key];
            if (condition === undefined) throw new AssemblyError(`unknown branch ${mnemonic}`, line, text);
            const target = labels.get((operands[0] ?? '').trim());
            if (target === undefined) throw new AssemblyError(`unknown label "${operands[0]}"`, line, text);
            const isShort = item.length === 2;
            const disp = target - (item.address + 2);
            if (isShort) {
                if (disp < -128 || disp > 127 || disp === 0) {
                    throw new AssemblyError(`short branch displacement ${disp} out of range`, line, text);
                }
                return [0x6000 | (condition << 8) | (disp & 0xff)];
            }
            if (disp < -0x8000 || disp > 0x7fff) throw new AssemblyError(`branch displacement ${disp} out of range`, line, text);
            return [0x6000 | (condition << 8), disp & 0xffff];
        }

        throw new AssemblyError(`unknown mnemonic "${mnemonic}"`, line, text);
    }
}
