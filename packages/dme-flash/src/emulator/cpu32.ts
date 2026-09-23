/**
 * A CPU32 (68k) interpreter covering the instruction subset a flash loader uses.
 *
 * ## The one rule that makes this trustworthy
 *
 * **An opcode this core does not implement throws.** It is never treated as a no-op and never
 * skipped. A verification harness whose CPU silently ignores what it does not understand will
 * happily "prove" a broken loader correct, which is worse than having no harness at all. So the
 * coverage is narrow and the failure is loud.
 *
 * The subset is not chosen from a datasheet; it is exactly what BMW's own erase and program
 * stubs use, plus what a loader needs to set up the machine (MOVEC for VBR, MOVE to SR, LEA,
 * JSR/RTS, DBRA, and the usual arithmetic). `bmwStubs.test.ts` runs the firmware's real routines
 * on this core, so the decoder is validated against code that is known to work on the actual
 * silicon rather than against my reading of a manual.
 *
 * Condition codes are computed only where the implemented instructions set them, and only the
 * flags those instructions actually produce. Everything here is 32-bit two's complement with
 * explicit masking, because JavaScript bitwise operators are signed.
 */

export interface Bus {
    /** `isFetch` distinguishes an instruction fetch, which some devices must refuse. */
    readWord(address: number, isFetch?: boolean): number;
    readByte(address: number, isFetch?: boolean): number;
    writeWord(address: number, value: number): void;
    writeByte(address: number, value: number): void;
}

export class UnimplementedOpcodeError extends Error {
    constructor(readonly opcode: number, readonly pc: number) {
        super(`unimplemented opcode 0x${opcode.toString(16).padStart(4, '0')}`
            + ` at 0x${pc.toString(16).padStart(6, '0')}`
            + ' - this core refuses to guess rather than silently skipping');
        this.name = 'UnimplementedOpcodeError';
    }
}

export class CpuFaultError extends Error {
    constructor(message: string, readonly pc: number) {
        super(`${message} (pc=0x${pc.toString(16).padStart(6, '0')})`);
        this.name = 'CpuFaultError';
    }
}

const u32 = (v: number): number => v >>> 0;
const u16 = (v: number): number => v & 0xffff;
const u8 = (v: number): number => v & 0xff;
const s8 = (v: number): number => (v & 0x80) ? (v & 0xff) - 0x100 : v & 0xff;
const s16 = (v: number): number => (v & 0x8000) ? (v & 0xffff) - 0x10000 : v & 0xffff;
const s32 = (v: number): number => v | 0;

export interface CpuFlags { c: boolean; v: boolean; z: boolean; n: boolean; x: boolean }

export class Cpu32 {
    /** D0-D7 */
    readonly d = new Uint32Array(8);
    /** A0-A7; a[7] is the active stack pointer. */
    readonly a = new Uint32Array(8);
    pc = 0;
    vbr = 0;
    /** Interrupt mask level from SR bits 10-8. */
    interruptMask = 7;
    supervisor = true;
    flags: CpuFlags = { c: false, v: false, z: false, n: false, x: false };

    /** Set when the program executes RESET, so a harness can observe it. */
    resetExecuted = 0;
    /** Instructions retired, for loop-limit enforcement. */
    instructions = 0;
    /** Set by STOP or by a deliberate halt loop detector. */
    halted = false;

    constructor(private readonly bus: Bus) {}

    get sr(): number {
        const { c, v, z, n, x } = this.flags;
        return (this.supervisor ? 0x2000 : 0)
            | ((this.interruptMask & 7) << 8)
            | (x ? 0x10 : 0) | (n ? 0x08 : 0) | (z ? 0x04 : 0) | (v ? 0x02 : 0) | (c ? 0x01 : 0);
    }

    set sr(value: number) {
        this.supervisor = (value & 0x2000) !== 0;
        this.interruptMask = (value >>> 8) & 7;
        this.flags = {
            x: (value & 0x10) !== 0, n: (value & 0x08) !== 0, z: (value & 0x04) !== 0,
            v: (value & 0x02) !== 0, c: (value & 0x01) !== 0,
        };
    }

    private fetch16(): number {
        const word = this.bus.readWord(this.pc, true);
        this.pc = u32(this.pc + 2);
        return u16(word);
    }

    private fetch32(): number {
        const hi = this.fetch16();
        const lo = this.fetch16();
        return u32((hi << 16) | lo);
    }

    private read(size: 1 | 2 | 4, address: number): number {
        if (size === 1) return this.bus.readByte(address);
        if (size === 2) return this.bus.readWord(address);
        return u32((this.bus.readWord(address) << 16) | this.bus.readWord(address + 2));
    }

    private write(size: 1 | 2 | 4, address: number, value: number): void {
        if (size === 1) { this.bus.writeByte(address, u8(value)); return; }
        if (size === 2) { this.bus.writeWord(address, u16(value)); return; }
        this.bus.writeWord(address, u16(value >>> 16));
        this.bus.writeWord(address + 2, u16(value));
    }

    private setLogicFlags(size: 1 | 2 | 4, value: number): void {
        const bits = size * 8;
        const masked = size === 4 ? u32(value) : value & ((1 << bits) - 1);
        const signBit = size === 4 ? 0x80000000 : 1 << (bits - 1);
        this.flags.n = (masked & signBit) !== 0;
        this.flags.z = masked === 0;
        this.flags.v = false;
        this.flags.c = false;
    }

    private setSubFlags(size: 1 | 2 | 4, dst: number, src: number, result: number): void {
        const bits = size * 8;
        const mask = size === 4 ? 0xffffffff : (1 << bits) - 1;
        const signBit = size === 4 ? 0x80000000 : 1 << (bits - 1);
        const r = u32(result) & mask;
        const d = dst & mask;
        const s = src & mask;
        this.flags.n = (r & signBit) !== 0;
        this.flags.z = r === 0;
        this.flags.c = (s >>> 0) > (d >>> 0);
        const dn = (d & signBit) !== 0, sn = (s & signBit) !== 0, rn = (r & signBit) !== 0;
        this.flags.v = (dn !== sn) && (rn !== dn);
    }

    /** Effective address for mode/register, advancing PC over any extension words. */
    private ea(mode: number, reg: number, size: 1 | 2 | 4): { address?: number; kind: 'd' | 'a' | 'mem'; index: number } {
        switch (mode) {
            case 0: return { kind: 'd', index: reg };
            case 1: return { kind: 'a', index: reg };
            case 2: return { kind: 'mem', index: reg, address: u32(this.a[reg] ?? 0) };
            case 3: {
                const address = u32(this.a[reg] ?? 0);
                const step = (reg === 7 && size === 1) ? 2 : size;
                this.a[reg] = u32(address + step);
                return { kind: 'mem', index: reg, address };
            }
            case 4: {
                const step = (reg === 7 && size === 1) ? 2 : size;
                const address = u32((this.a[reg] ?? 0) - step);
                this.a[reg] = address;
                return { kind: 'mem', index: reg, address };
            }
            case 5: {
                const disp = s16(this.fetch16());
                return { kind: 'mem', index: reg, address: u32((this.a[reg] ?? 0) + disp) };
            }
            case 6: {
                const ext = this.fetch16();
                const disp = s8(ext & 0xff);
                const idxReg = (ext >>> 12) & 7;
                const isAddress = (ext & 0x8000) !== 0;
                const isLong = (ext & 0x0800) !== 0;
                const raw = isAddress ? (this.a[idxReg] ?? 0) : (this.d[idxReg] ?? 0);
                const index = isLong ? s32(raw) : s16(raw);
                return { kind: 'mem', index: reg, address: u32((this.a[reg] ?? 0) + disp + index) };
            }
            case 7:
                switch (reg) {
                    case 0: return { kind: 'mem', index: reg, address: u32(s16(this.fetch16())) };
                    case 1: return { kind: 'mem', index: reg, address: this.fetch32() };
                    case 2: {
                        const base = this.pc;
                        const disp = s16(this.fetch16());
                        return { kind: 'mem', index: reg, address: u32(base + disp) };
                    }
                    case 4:
                        // Immediates are read-only and are consumed by readEa before it calls
                        // this. Reaching here means something tried to use one as a destination.
                        throw new CpuFaultError('immediate operand used as a destination', this.pc);
                    default: throw new CpuFaultError(`unsupported addressing mode 7/${reg}`, this.pc);
                }
            default: throw new CpuFaultError(`unsupported addressing mode ${mode}`, this.pc);
        }
    }

    /** Read through an effective address, handling immediates. */
    private readEa(mode: number, reg: number, size: 1 | 2 | 4): number {
        if (mode === 7 && reg === 4) {
            const value = size === 4 ? this.fetch32() : this.fetch16();
            return size === 1 ? u8(value) : value;
        }
        const ea = this.ea(mode, reg, size);
        if (ea.kind === 'd') {
            const v = this.d[ea.index] ?? 0;
            return size === 4 ? u32(v) : size === 2 ? u16(v) : u8(v);
        }
        if (ea.kind === 'a') {
            const v = this.a[ea.index] ?? 0;
            return size === 4 ? u32(v) : size === 2 ? u16(v) : u8(v);
        }
        return this.read(size, ea.address!);
    }

    private writeEa(mode: number, reg: number, size: 1 | 2 | 4, value: number): void {
        const ea = this.ea(mode, reg, size);
        if (ea.kind === 'd') { this.setDataRegister(ea.index, size, value); return; }
        if (ea.kind === 'a') { this.a[ea.index] = u32(size === 2 ? s16(value) : value); return; }
        this.write(size, ea.address!, value);
    }

    private setDataRegister(index: number, size: 1 | 2 | 4, value: number): void {
        const old = this.d[index] ?? 0;
        if (size === 4) this.d[index] = u32(value);
        else if (size === 2) this.d[index] = u32((old & 0xffff0000) | u16(value));
        else this.d[index] = u32((old & 0xffffff00) | u8(value));
    }

    private testCondition(code: number): boolean {
        const { c, v, z, n } = this.flags;
        switch (code) {
            case 0: return true;                       // T
            case 1: return false;                      // F
            case 2: return !c && !z;                   // HI
            case 3: return c || z;                     // LS
            case 4: return !c;                         // CC
            case 5: return c;                          // CS
            case 6: return !z;                         // NE
            case 7: return z;                          // EQ
            case 8: return !v;                         // VC
            case 9: return v;                          // VS
            case 10: return !n;                        // PL
            case 11: return n;                         // MI
            case 12: return n === v;                   // GE
            case 13: return n !== v;                   // LT
            case 14: return !z && (n === v);           // GT
            case 15: return z || (n !== v);            // LE
            default: return false;
        }
    }

    /** Execute one instruction. Throws on anything unimplemented. */
    step(): void {
        const pc0 = this.pc;
        const op = this.fetch16();
        this.instructions++;

        // --- RTS / RESET / NOP / STOP -------------------------------------------------
        if (op === 0x4e75) { // RTS
            const sp = u32(this.a[7] ?? 0);
            this.pc = u32((this.bus.readWord(sp) << 16) | this.bus.readWord(sp + 2));
            this.a[7] = u32(sp + 4);
            return;
        }
        if (op === 0x4e70) { this.resetExecuted++; return; }   // RESET
        if (op === 0x4e71) return;                              // NOP
        if (op === 0x4e72) { this.sr = this.fetch16(); this.halted = true; return; } // STOP

        // --- MOVE to/from SR/CCR, MOVEC ----------------------------------------------
        if ((op & 0xffc0) === 0x46c0) { // MOVE <ea>,SR
            this.sr = this.readEa((op >>> 3) & 7, op & 7, 2);
            return;
        }
        if ((op & 0xffc0) === 0x40c0) { // MOVE SR,<ea>
            this.writeEa((op >>> 3) & 7, op & 7, 2, this.sr);
            return;
        }
        if (op === 0x4e7a || op === 0x4e7b) { // MOVEC
            const ext = this.fetch16();
            const control = ext & 0xfff;
            const isAddress = (ext & 0x8000) !== 0;
            const reg = (ext >>> 12) & 7;
            if (control !== 0x801) throw new UnimplementedOpcodeError(op, pc0); // only VBR
            if (op === 0x4e7b) this.vbr = u32(isAddress ? (this.a[reg] ?? 0) : (this.d[reg] ?? 0));
            else if (isAddress) this.a[reg] = u32(this.vbr);
            else this.d[reg] = u32(this.vbr);
            return;
        }
        // --- LINK / UNLK --------------------------------------------------------------
        // Standard C-style frame setup. BMW's flash stubs never use it, which is why this core
        // went so long without it - and why the application's own code stopped dead at 0x11820
        // the first time the real-car reset route was executed far enough to reach it.
        if ((op & 0xfff8) === 0x4e50) { // LINK An,#<displacement.w>
            const reg = op & 7;
            const displacement = (this.fetch16() << 16) >> 16;
            const sp = u32((this.a[7] ?? 0) - 4);
            const value = u32(this.a[reg] ?? 0);
            this.bus.writeWord(sp, (value >>> 16) & 0xffff);
            this.bus.writeWord(sp + 2, value & 0xffff);
            this.a[reg] = sp;
            this.a[7] = u32(sp + displacement);
            return;
        }
        if ((op & 0xfff8) === 0x4e58) { // UNLK An
            const reg = op & 7;
            const sp = u32(this.a[reg] ?? 0);
            this.a[reg] = u32((this.bus.readWord(sp) << 16) | this.bus.readWord(sp + 2));
            this.a[7] = u32(sp + 4);
            return;
        }

        if ((op & 0xfff8) === 0x4e60) { this.usp = u32(this.a[op & 7] ?? 0); return; }  // MOVE An,USP
        if ((op & 0xfff8) === 0x4e68) { this.a[op & 7] = u32(this.usp); return; }        // MOVE USP,An

        // --- JMP / JSR ----------------------------------------------------------------
        if ((op & 0xffc0) === 0x4ec0) { // JMP <ea>
            this.pc = this.controlEa((op >>> 3) & 7, op & 7);
            return;
        }
        if ((op & 0xffc0) === 0x4e80) { // JSR <ea>
            const target = this.controlEa((op >>> 3) & 7, op & 7);
            const sp = u32((this.a[7] ?? 0) - 4);
            this.a[7] = sp;
            this.bus.writeWord(sp, u16(this.pc >>> 16));
            this.bus.writeWord(sp + 2, u16(this.pc));
            this.pc = target;
            return;
        }

        // --- LEA / PEA ----------------------------------------------------------------
        if ((op & 0xf1c0) === 0x41c0) { // LEA <ea>,An
            this.a[(op >>> 9) & 7] = this.controlEa((op >>> 3) & 7, op & 7);
            return;
        }
        if ((op & 0xffc0) === 0x4840) { // PEA <ea>
            const address = this.controlEa((op >>> 3) & 7, op & 7);
            const sp = u32((this.a[7] ?? 0) - 4);
            this.a[7] = sp;
            this.write(4, sp, address);
            return;
        }

        // --- MOVEM --------------------------------------------------------------------
        if ((op & 0xfb80) === 0x4880) { this.movem(op, pc0); return; }

        // --- Branches -----------------------------------------------------------------
        if ((op & 0xf000) === 0x6000) {
            const condition = (op >>> 8) & 0xf;
            let disp = s8(op & 0xff);
            let target: number;
            if ((op & 0xff) === 0x00) { const d = s16(this.fetch16()); target = u32(pc0 + 2 + d); }
            else if ((op & 0xff) === 0xff) { const d = this.fetch32(); target = u32(pc0 + 2 + d); }
            else target = u32(pc0 + 2 + disp);
            if (condition === 1) { // BSR
                const sp = u32((this.a[7] ?? 0) - 4);
                this.a[7] = sp;
                this.bus.writeWord(sp, u16(this.pc >>> 16));
                this.bus.writeWord(sp + 2, u16(this.pc));
                this.pc = target;
                return;
            }
            if (this.testCondition(condition)) this.pc = target;
            return;
        }

        // --- DBcc ---------------------------------------------------------------------
        if ((op & 0xf0f8) === 0x50c8) {
            const condition = (op >>> 8) & 0xf;
            const reg = op & 7;
            const disp = s16(this.fetch16());
            if (!this.testCondition(condition)) {
                const next = u16((this.d[reg] ?? 0) - 1);
                this.setDataRegister(reg, 2, next);
                if (next !== 0xffff) this.pc = u32(pc0 + 2 + disp);
            }
            return;
        }

        // --- ADDQ / SUBQ --------------------------------------------------------------
        if ((op & 0xf000) === 0x5000 && ((op >>> 6) & 3) !== 3) {
            const size = ([1, 2, 4] as const)[(op >>> 6) & 3]!;
            let value = (op >>> 9) & 7;
            if (value === 0) value = 8;
            const isSub = (op & 0x0100) !== 0;
            const mode = (op >>> 3) & 7, reg = op & 7;
            if (mode === 1) { // address register: full 32-bit, no flags
                const cur = u32(this.a[reg] ?? 0);
                this.a[reg] = u32(isSub ? cur - value : cur + value);
                return;
            }
            const ea = this.ea(mode, reg, size);
            const cur = ea.kind === 'd' ? (this.d[ea.index] ?? 0) : this.read(size, ea.address!);
            const masked = size === 4 ? u32(cur) : size === 2 ? u16(cur) : u8(cur);
            const result = isSub ? masked - value : masked + value;
            const bits = size * 8;
            const mask = size === 4 ? 0xffffffff : (1 << bits) - 1;
            const stored = u32(result) & mask;
            if (isSub) this.setSubFlags(size, masked, value, stored);
            else {
                const signBit = size === 4 ? 0x80000000 : 1 << (bits - 1);
                this.flags.n = (stored & signBit) !== 0;
                this.flags.z = stored === 0;
                this.flags.c = (u32(result) >>> 0) > (mask >>> 0) || (size === 4 && result > 0xffffffff);
                this.flags.v = false;
            }
            this.flags.x = this.flags.c;
            if (ea.kind === 'd') this.setDataRegister(ea.index, size, stored);
            else this.write(size, ea.address!, stored);
            return;
        }

        // --- MOVE / MOVEA -------------------------------------------------------------
        // The top nibble must be 1, 2 or 3. Masking with 3 instead of 0xF would also match
        // 0xB (EOR/CMP) and 0x7 (MOVEQ), which is a decoding bug that turns arithmetic into
        // stores - caught here by running BMW's own routines through this core.
        const topNibble = (op >>> 12) & 0xf;
        if (topNibble === 1 || topNibble === 2 || topNibble === 3) {
            const size: 1 | 2 | 4 = topNibble === 1 ? 1 : topNibble === 3 ? 2 : 4;
            const srcMode = (op >>> 3) & 7, srcReg = op & 7;
            const dstMode = (op >>> 6) & 7, dstReg = (op >>> 9) & 7;
            const value = this.readEa(srcMode, srcReg, size);
            if (dstMode === 1) { // MOVEA - sign extends, sets no flags
                this.a[dstReg] = u32(size === 2 ? s16(value) : value);
                return;
            }
            this.setLogicFlags(size, value);
            this.writeEa(dstMode, dstReg, size, value);
            return;
        }

        // --- MOVEQ --------------------------------------------------------------------
        if ((op & 0xf100) === 0x7000) {
            const value = u32(s8(op & 0xff));
            this.d[(op >>> 9) & 7] = value;
            this.setLogicFlags(4, value);
            return;
        }

        // --- Immediate group: ORI / ANDI / SUBI / ADDI / EORI / CMPI -------------------
        if ((op & 0xff00) === 0x0000 || (op & 0xff00) === 0x0200 || (op & 0xff00) === 0x0400
            || (op & 0xff00) === 0x0600 || (op & 0xff00) === 0x0a00 || (op & 0xff00) === 0x0c00) {
            const sizeBits = (op >>> 6) & 3;
            if (sizeBits !== 3) {
                const size = ([1, 2, 4] as const)[sizeBits]!;
                const immediate = size === 4 ? this.fetch32() : (size === 2 ? this.fetch16() : u8(this.fetch16()));
                const mode = (op >>> 3) & 7, reg = op & 7;
                const family = (op >>> 8) & 0xf;
                // ORI/ANDI/EORI to CCR/SR are encoded with mode 7 reg 4; not used by our code.
                const ea = this.ea(mode, reg, size);
                const cur = ea.kind === 'd' ? (this.d[ea.index] ?? 0) : this.read(size, ea.address!);
                const masked = size === 4 ? u32(cur) : size === 2 ? u16(cur) : u8(cur);
                let result: number;
                switch (family) {
                    case 0x0: result = masked | immediate; this.setLogicFlags(size, result); break;
                    case 0x2: result = masked & immediate; this.setLogicFlags(size, result); break;
                    case 0x4: result = masked - immediate; this.setSubFlags(size, masked, immediate, result); this.flags.x = this.flags.c; break;
                    case 0x6: {
                        result = masked + immediate;
                        const bits = size * 8;
                        const mask = size === 4 ? 0xffffffff : (1 << bits) - 1;
                        const signBit = size === 4 ? 0x80000000 : 1 << (bits - 1);
                        const stored = u32(result) & mask;
                        this.flags.n = (stored & signBit) !== 0;
                        this.flags.z = stored === 0;
                        this.flags.c = result > mask;
                        this.flags.v = false;
                        this.flags.x = this.flags.c;
                        result = stored;
                        break;
                    }
                    case 0xa: result = masked ^ immediate; this.setLogicFlags(size, result); break;
                    case 0xc: { // CMPI - compare only
                        const diff = masked - immediate;
                        this.setSubFlags(size, masked, immediate, diff);
                        return;
                    }
                    default: throw new UnimplementedOpcodeError(op, pc0);
                }
                const bits = size * 8;
                const mask = size === 4 ? 0xffffffff : (1 << bits) - 1;
                const stored = u32(result) & mask;
                if (ea.kind === 'd') this.setDataRegister(ea.index, size, stored);
                else this.write(size, ea.address!, stored);
                return;
            }
        }

        // --- BTST / BCLR / BSET / BCHG with immediate bit number -----------------------
        if ((op & 0xff00) === 0x0800) {
            const kind = (op >>> 6) & 3;
            const bitNumber = this.fetch16() & 0xff;
            const mode = (op >>> 3) & 7, reg = op & 7;
            const isRegister = mode === 0;
            const size: 1 | 2 | 4 = isRegister ? 4 : 1;
            const bit = isRegister ? (bitNumber & 31) : (bitNumber & 7);
            const ea = this.ea(mode, reg, size);
            const cur = ea.kind === 'd' ? u32(this.d[ea.index] ?? 0) : this.read(size, ea.address!);
            this.flags.z = (cur & (1 << bit)) === 0;
            if (kind === 0) return; // BTST
            let result = cur;
            if (kind === 1) result = cur ^ (1 << bit);        // BCHG
            else if (kind === 2) result = cur & ~(1 << bit);  // BCLR
            else result = cur | (1 << bit);                    // BSET
            if (ea.kind === 'd') this.setDataRegister(ea.index, size, result);
            else this.write(size, ea.address!, result & 0xff);
            return;
        }

        // --- TST / CLR ----------------------------------------------------------------
        if ((op & 0xff00) === 0x4a00 && ((op >>> 6) & 3) !== 3) {
            const size = ([1, 2, 4] as const)[(op >>> 6) & 3]!;
            const value = this.readEa((op >>> 3) & 7, op & 7, size);
            this.setLogicFlags(size, value);
            return;
        }
        if ((op & 0xff00) === 0x4200 && ((op >>> 6) & 3) !== 3) {
            const size = ([1, 2, 4] as const)[(op >>> 6) & 3]!;
            this.writeEa((op >>> 3) & 7, op & 7, size, 0);
            this.flags = { ...this.flags, n: false, z: true, v: false, c: false };
            return;
        }

        // --- Register-operand group: OR / SUB / AND / ADD / CMP / EOR ------------------
        const family = (op >>> 12) & 0xf;
        if (family === 0x8 || family === 0x9 || family === 0xb || family === 0xc || family === 0xd) {
            const opmode = (op >>> 6) & 7;
            const dn = (op >>> 9) & 7;
            const mode = (op >>> 3) & 7, reg = op & 7;

            if (opmode === 3 || opmode === 7) { // ADDA / SUBA / CMPA
                const size: 1 | 2 | 4 = opmode === 3 ? 2 : 4;
                const value = this.readEa(mode, reg, size);
                const extended = size === 2 ? u32(s16(value)) : u32(value);
                const cur = u32(this.a[dn] ?? 0);
                if (family === 0xd) { this.a[dn] = u32(cur + extended); return; }         // ADDA
                if (family === 0x9) { this.a[dn] = u32(cur - extended); return; }         // SUBA
                if (family === 0xb) { this.setSubFlags(4, cur, extended, u32(cur - extended)); return; } // CMPA
                throw new UnimplementedOpcodeError(op, pc0);
            }

            const size = ([1, 2, 4] as const)[opmode & 3];
            if (size === undefined) throw new UnimplementedOpcodeError(op, pc0);
            const toMemory = (opmode & 4) !== 0;

            if (family === 0xb && !toMemory) { // CMP Dn
                const value = this.readEa(mode, reg, size);
                const cur = this.maskReg(dn, size);
                this.setSubFlags(size, cur, value, cur - value);
                return;
            }
            if (family === 0xb && toMemory) { // EOR Dn,<ea>
                const ea = this.ea(mode, reg, size);
                const cur = ea.kind === 'd' ? this.maskReg(ea.index, size) : this.read(size, ea.address!);
                const result = cur ^ this.maskReg(dn, size);
                this.setLogicFlags(size, result);
                if (ea.kind === 'd') this.setDataRegister(ea.index, size, result);
                else this.write(size, ea.address!, result);
                return;
            }

            if (!toMemory) {
                const value = this.readEa(mode, reg, size);
                const cur = this.maskReg(dn, size);
                let result: number;
                if (family === 0x8) { result = cur | value; this.setLogicFlags(size, result); }
                else if (family === 0xc) { result = cur & value; this.setLogicFlags(size, result); }
                else if (family === 0x9) { result = cur - value; this.setSubFlags(size, cur, value, result); this.flags.x = this.flags.c; }
                else { // ADD
                    result = cur + value;
                    const bits = size * 8;
                    const mask = size === 4 ? 0xffffffff : (1 << bits) - 1;
                    const signBit = size === 4 ? 0x80000000 : 1 << (bits - 1);
                    const stored = u32(result) & mask;
                    this.flags.n = (stored & signBit) !== 0;
                    this.flags.z = stored === 0;
                    this.flags.c = result > mask;
                    this.flags.v = false;
                    this.flags.x = this.flags.c;
                    result = stored;
                }
                const bits = size * 8;
                const mask = size === 4 ? 0xffffffff : (1 << bits) - 1;
                this.setDataRegister(dn, size, u32(result) & mask);
                return;
            }

            const ea = this.ea(mode, reg, size);
            const cur = ea.kind === 'd' ? this.maskReg(ea.index, size) : this.read(size, ea.address!);
            const value = this.maskReg(dn, size);
            let result: number;
            if (family === 0x8) { result = cur | value; this.setLogicFlags(size, result); }
            else if (family === 0xc) { result = cur & value; this.setLogicFlags(size, result); }
            else if (family === 0x9) { result = cur - value; this.setSubFlags(size, cur, value, result); this.flags.x = this.flags.c; }
            else {
                result = cur + value;
                const bits = size * 8;
                const mask = size === 4 ? 0xffffffff : (1 << bits) - 1;
                const stored = u32(result) & mask;
                this.flags.n = (stored & (size === 4 ? 0x80000000 : 1 << (bits - 1))) !== 0;
                this.flags.z = stored === 0;
                this.flags.c = result > mask;
                this.flags.v = false;
                this.flags.x = this.flags.c;
                result = stored;
            }
            const bits = size * 8;
            const mask = size === 4 ? 0xffffffff : (1 << bits) - 1;
            const stored = u32(result) & mask;
            if (ea.kind === 'd') this.setDataRegister(ea.index, size, stored);
            else this.write(size, ea.address!, stored);
            return;
        }

        // --- Shifts: LSL / LSR / ASL / ASR by immediate or register -------------------
        if ((op & 0xf000) === 0xe000 && ((op >>> 6) & 3) !== 3) {
            const size = ([1, 2, 4] as const)[(op >>> 6) & 3]!;
            const reg = op & 7;
            const isLeft = (op & 0x0100) !== 0;
            const kind = (op >>> 3) & 3;
            const byRegister = (op & 0x0020) !== 0;
            let count = (op >>> 9) & 7;
            if (byRegister) count = u32(this.d[count] ?? 0) % 64;
            else if (count === 0) count = 8;
            if (kind !== 0 && kind !== 1) throw new UnimplementedOpcodeError(op, pc0); // ASx/LSx only
            const bits = size * 8;
            const mask = size === 4 ? 0xffffffff : (1 << bits) - 1;
            let value = this.maskReg(reg, size);
            let carry = false;
            for (let i = 0; i < count; i++) {
                if (isLeft) {
                    carry = (value & (size === 4 ? 0x80000000 : 1 << (bits - 1))) !== 0;
                    value = u32(value << 1) & mask;
                } else {
                    carry = (value & 1) !== 0;
                    if (kind === 0) { // ASR - arithmetic, preserve sign
                        const signBit = size === 4 ? 0x80000000 : 1 << (bits - 1);
                        const sign = value & signBit;
                        value = ((value >>> 1) | sign) & mask;
                    } else {
                        value = (value >>> 1) & mask;
                    }
                }
            }
            this.setDataRegister(reg, size, value);
            this.flags.n = (value & (size === 4 ? 0x80000000 : 1 << (bits - 1))) !== 0;
            this.flags.z = value === 0;
            this.flags.v = false;
            if (count > 0) { this.flags.c = carry; this.flags.x = carry; }
            else this.flags.c = false;
            return;
        }

        throw new UnimplementedOpcodeError(op, pc0);
    }

    private usp = 0;

    private maskReg(index: number, size: 1 | 2 | 4): number {
        const v = this.d[index] ?? 0;
        return size === 4 ? u32(v) : size === 2 ? u16(v) : u8(v);
    }

    /** Effective address for control operands (JMP/JSR/LEA/PEA) - no size, no post-increment. */
    private controlEa(mode: number, reg: number): number {
        switch (mode) {
            case 2: return u32(this.a[reg] ?? 0);
            case 5: { const disp = s16(this.fetch16()); return u32((this.a[reg] ?? 0) + disp); }
            case 6: {
                const ext = this.fetch16();
                const disp = s8(ext & 0xff);
                const idxReg = (ext >>> 12) & 7;
                const isAddress = (ext & 0x8000) !== 0;
                const isLong = (ext & 0x0800) !== 0;
                const raw = isAddress ? (this.a[idxReg] ?? 0) : (this.d[idxReg] ?? 0);
                const index = isLong ? s32(raw) : s16(raw);
                return u32((this.a[reg] ?? 0) + disp + index);
            }
            case 7:
                switch (reg) {
                    case 0: return u32(s16(this.fetch16()));
                    case 1: return this.fetch32();
                    case 2: { const base = this.pc; const disp = s16(this.fetch16()); return u32(base + disp); }
                    case 3: {
                        const base = this.pc;
                        const ext = this.fetch16();
                        const disp = s8(ext & 0xff);
                        const idxReg = (ext >>> 12) & 7;
                        const isAddress = (ext & 0x8000) !== 0;
                        const isLong = (ext & 0x0800) !== 0;
                        const raw = isAddress ? (this.a[idxReg] ?? 0) : (this.d[idxReg] ?? 0);
                        const index = isLong ? s32(raw) : s16(raw);
                        return u32(base + disp + index);
                    }
                    default: throw new CpuFaultError(`unsupported control mode 7/${reg}`, this.pc);
                }
            default: throw new CpuFaultError(`unsupported control mode ${mode}`, this.pc);
        }
    }

    private movem(op: number, pc0: number): void {
        const size: 2 | 4 = (op & 0x0040) ? 4 : 2;
        const toRegisters = (op & 0x0400) !== 0;
        const mode = (op >>> 3) & 7, reg = op & 7;
        const mask = this.fetch16();

        if (!toRegisters && mode === 4) { // predecrement: mask is reversed
            let address = u32(this.a[reg] ?? 0);
            for (let i = 0; i < 16; i++) {
                if ((mask & (1 << i)) === 0) continue;
                const which = 15 - i;
                const value = which < 8 ? u32(this.d[which] ?? 0) : u32(this.a[which - 8] ?? 0);
                address = u32(address - size);
                this.write(size, address, value);
            }
            this.a[reg] = address;
            return;
        }
        if (toRegisters && mode === 3) { // postincrement
            let address = u32(this.a[reg] ?? 0);
            for (let i = 0; i < 16; i++) {
                if ((mask & (1 << i)) === 0) continue;
                const value = this.read(size, address);
                const extended = size === 2 ? u32(s16(value)) : u32(value);
                if (i < 8) this.d[i] = extended; else this.a[i - 8] = extended;
                address = u32(address + size);
            }
            this.a[reg] = address;
            return;
        }
        throw new UnimplementedOpcodeError(op, pc0);
    }

    /** Run until `predicate` is true, halted, or the instruction budget is exhausted. */
    run(predicate: () => boolean, maxInstructions = 5_000_000): void {
        const limit = this.instructions + maxInstructions;
        while (!predicate() && !this.halted) {
            if (this.instructions >= limit) {
                throw new CpuFaultError(`instruction budget of ${maxInstructions} exhausted - the code is looping`, this.pc);
            }
            this.step();
        }
    }
}
