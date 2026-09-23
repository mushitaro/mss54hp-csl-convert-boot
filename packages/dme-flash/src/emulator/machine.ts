/**
 * The MSS54HP processor board as far as a flash loader can tell: one Am29F400BB, the on-chip
 * RAM modules, and the SIM registers that decide whether a flash write reaches the device.
 *
 * The memory map is the one the firmware's own reset code establishes (docs/bootloader-replacement.md):
 *
 *   0x000000-0x07FFFF   flash, via CSBOOT (CSBARBT = 0x0006: base 0, 512 KiB block)
 *   0x080000-0x09FFFF   the same flash, aliased - the device decodes A18:A0 only, so an access
 *                       at 0x8E002 lands on flash offset 0xE002. This is why calibration reads
 *                       in the disassembly look like 0x8xxxx.
 *   0x00FFE000-...      SRAM array, once RAMBAH/RAMBAL and RAMMCR have been programmed
 *   0x00FFB00-0x00FFB47 TPURAM and SRAM control
 *   0x00FFA00-0x00FFA7F SIM
 *   0x00FFFF00-0x00FFFFFF TPU parameter RAM - real RAM, and not gated by RAMMCR
 *
 * **Addresses are decoded to 24 bits, because the part decodes 24.** That is not a detail: the
 * reset vector hands over SSP = 0, and BMW's bootloader calls the application's init at 0x10400
 * WITHOUT setting a stack first. So the first pushes of a real boot land at 0xFFFFFC, 0xFFFFF8,
 * 0xFFFFF4 - the top of the map, which on this part is TPU parameter RAM, so they survive and the
 * matching `rts` works. Modelled with 32-bit addresses those pushes went to 0xFFFFFFFC and were
 * lost, `rts` returned to 0, and the CPU walked the vector table and rebooted forever. That is
 * what made the real-car reset route look like a hang.
 *
 * Two behaviours are modelled because a loader that ignores them fails on a real ECU:
 *
 *  - **RAM does not exist until it is enabled.** After the RESET instruction the SRAM and TPURAM
 *    arrays are disabled. A loader that copies its stub into RAM without enabling it first is
 *    writing into nothing, and this machine records that instead of quietly accepting it.
 *
 *  - **Flash writes are gated by the chip-select R/W field.** The firmware flips CSBOOT to
 *    read-only and CS0 to write-only before every flash operation, and restores them after. A
 *    loader that copies only some of that will find its unlock cycles silently discarded - the
 *    single most likely way to arm an ECU and then be unable to talk to it.
 */
import { Am29F400, FLASH_LENGTH, type FlashOptions } from './flashAm29f400';
import type { Bus } from './cpu32';

/**
 * The part decodes 24 address lines, so 0xFFFFFFF4 and 0xFFFFF4 are the same location.
 *
 * Written as a function rather than inlined because getting it wrong is invisible: the unmasked
 * form still lands in the register range by comparison, but `address & ~1` coerces to a signed
 * int32 there, so a write keyed 4294967284 was read back as key -12 and returned 0.
 */
function busAddress(address: number): number {
    return address & 0xffffff;
}

/** TPU parameter RAM: 0xFFFF00-0xFFFFFF, the last 256 bytes of the module block. */
const TPU_PARAM_RAM_BASE = 0xffff00;

/** SIM register addresses used here (MC68336/376 user manual, appendix D). */
export const SIM = {
    SIMCR: 0xfffa00,
    SYNCR: 0xfffa04,
    SYPCR: 0xfffa21,
    SWSR: 0xfffa27,
    CSPAR0: 0xfffa44,
    CSPAR1: 0xfffa46,
    CSBARBT: 0xfffa48,
    CSORBT: 0xfffa4a,
    CSBAR0: 0xfffa4c,
    CSOR0: 0xfffa4e,
    /** TPURAM control. */
    TRAMMCR: 0xfffb00,
    TRAMTST: 0xfffb02,
    TRAMBAR: 0xfffb04,
    /** SRAM control. */
    RAMMCR: 0xfffb40,
    RAMTST: 0xfffb42,
    RAMBAH: 0xfffb44,
    RAMBAL: 0xfffb46,
} as const;

/** CSOR R/W field (bits 12-11): 00 disabled, 01 read only, 10 write only, 11 both. */
function csorAllowsWrite(csor: number): boolean {
    const rw = (csor >>> 11) & 3;
    return rw === 2 || rw === 3;
}
function csorAllowsRead(csor: number): boolean {
    const rw = (csor >>> 11) & 3;
    return rw === 1 || rw === 3;
}

/**
 * Reset values, MC68336/376 UM appendix D.2.20/21.
 *
 * CSORBT's reset row is 0 1 1 1 1 0 1 1 0 1 1 1 0 0 0 0 = 0x7B70, which decodes as
 * BYTE = both, **R/W = read AND write**, DSACK = 13 wait states. So out of reset the boot chip
 * select already permits flash writes, slowly. That matters: a loader entered through the RESET
 * instruction does NOT have to reconfigure the chip selects to program flash, and not touching
 * them is the safest option available to it.
 *
 * CSOR[0:10] reset to all zeros, i.e. BYTE = disabled: CS0 does nothing until programmed.
 */
const CSORBT_RESET = 0x7b70;
const CSOR0_RESET = 0x0000;

export type MachineViolationKind =
    | 'write-to-disabled-ram' | 'read-from-disabled-ram' | 'flash-write-blocked'
    | 'unmapped-access' | 'watchdog-reset';

export interface MachineViolation {
    readonly kind: MachineViolationKind;
    readonly address: number;
    readonly detail: string;
}

export interface MachineOptions extends FlashOptions {
    /**
     * Instructions the software watchdog tolerates between services. The real one is a timer;
     * an instruction count is deterministic and serves the same purpose - proving the loader
     * services it inside every polling loop.
     */
    readonly watchdogInstructions?: number;
}

export class Machine implements Bus {
    readonly flash: Am29F400;
    readonly violations: MachineViolation[] = [];

    /** SRAM array, 4 KiB, present only once RAMMCR/RAMBAH/RAMBAL say so. */
    readonly sram = new Uint8Array(0x1000);
    /** TPURAM array, 3.5 KiB. */
    readonly tpuram = new Uint8Array(0xe00);
    /**
     * TPU parameter RAM, the last 256 bytes of the module block.
     *
     * Present from reset and not gated by RAMMCR, which is why a stack can land here before any
     * RAM has been enabled - see the note in this file's header.
     */
    readonly tpuParamRam = new Uint8Array(0x100);

    sramBase = 0;
    sramEnabled = false;
    tpuramBase = 0;
    tpuramEnabled = false;

    csorbt = CSORBT_RESET;
    csor0 = CSOR0_RESET;

    /** Software watchdog: enabled out of reset via SYPCR, serviced by SWSR. */
    watchdogEnabled = true;
    watchdogArmed = false;
    private watchdogSequence = 0;
    private instructionsSinceService = 0;
    private readonly watchdogInstructions: number;

    /** Set when the watchdog would have reset the CPU. */
    watchdogFired = false;

    private readonly registers = new Map<number, number>();

    constructor(flashImage?: Uint8Array, options: MachineOptions = {}) {
        this.flash = new Am29F400(flashImage, options);
        this.watchdogInstructions = options.watchdogInstructions ?? 20000;
    }

    /** Apply the state the RESET instruction leaves behind (MC68376 UM tables 5-21/5-22). */
    applyResetInstruction(): void {
        this.csorbt = CSORBT_RESET;
        this.csor0 = CSOR0_RESET;
        this.sramEnabled = false;
        this.tpuramEnabled = false;
        this.watchdogEnabled = true;
        this.instructionsSinceService = 0;
        this.flash.powerCycle();
    }

    /** Called by the harness once per instruction so the watchdog can bite. */
    tick(): void {
        if (!this.watchdogEnabled) return;
        this.instructionsSinceService++;
        if (this.instructionsSinceService > this.watchdogInstructions) {
            if (!this.watchdogFired) {
                this.violations.push({
                    kind: 'watchdog-reset', address: 0,
                    detail: `the software watchdog was not serviced for ${this.instructionsSinceService}`
                        + ' instructions; on a real ECU this resets the CPU mid-operation',
                });
            }
            this.watchdogFired = true;
        }
    }

    /** Flash offset for an address, or undefined when the address is not flash. */
    private flashOffset(address: number): number | undefined {
        const a = address >>> 0;
        if (a < FLASH_LENGTH) return a;
        // The alias: the device decodes A18:A0, so 0x080000-0x0FFFFF repeats 0x000000-0x07FFFF.
        if (a >= 0x080000 && a < 0x100000) return a - 0x080000;
        return undefined;
    }

    private ramSlot(address: number): { array: Uint8Array; offset: number; enabled: boolean; which: string } | undefined {
        const a = address >>> 0;
        // Base 0 means "never programmed". Without this the unconfigured base would shadow
        // flash addresses 0x0-0xFFF, which is where the exception vectors live.
        if (this.sramBase !== 0 && a >= this.sramBase && a < this.sramBase + this.sram.length) {
            return { array: this.sram, offset: a - this.sramBase, enabled: this.sramEnabled, which: 'SRAM' };
        }
        if (this.tpuramBase !== 0 && a >= this.tpuramBase && a < this.tpuramBase + this.tpuram.length) {
            return { array: this.tpuram, offset: a - this.tpuramBase, enabled: this.tpuramEnabled, which: 'TPURAM' };
        }
        return undefined;
    }

    readWord(address: number, isFetch = false): number {
        const a = busAddress(address);
        if (a >= TPU_PARAM_RAM_BASE) {
            const o = a - TPU_PARAM_RAM_BASE;
            return ((this.tpuParamRam[o] ?? 0) << 8) | (this.tpuParamRam[o + 1] ?? 0);
        }
        if (a >= 0xfff000) return this.readRegister(a);

        const ram = this.ramSlot(a);
        if (ram) {
            if (!ram.enabled) {
                this.violations.push({
                    kind: 'read-from-disabled-ram', address: a,
                    detail: `${ram.which} is not enabled; after the RESET instruction the array is`
                        + ' disabled until RAMBAH/RAMBAL and the module control register are written',
                });
                return 0;
            }
            return ((ram.array[ram.offset] ?? 0) << 8) | (ram.array[ram.offset + 1] ?? 0);
        }

        const offset = this.flashOffset(a);
        if (offset !== undefined) {
            if (!csorAllowsRead(this.csorbt) && !csorAllowsRead(this.csor0)) {
                this.violations.push({
                    kind: 'flash-write-blocked', address: a,
                    detail: 'no chip select currently permits reads of flash',
                });
                return 0xffff;
            }
            return this.flash.readWord(offset, isFetch);
        }

        this.violations.push({ kind: 'unmapped-access', address: a, detail: 'read from unmapped address' });
        return 0xffff;
    }

    readByte(address: number, isFetch = false): number {
        const a = busAddress(address);
        const word = this.readWord(a & ~1, isFetch);
        return (a & 1) === 0 ? (word >>> 8) & 0xff : word & 0xff;
    }

    writeWord(address: number, value: number): void {
        const a = busAddress(address);
        if (a >= TPU_PARAM_RAM_BASE) {
            const o = a - TPU_PARAM_RAM_BASE;
            this.tpuParamRam[o] = (value >>> 8) & 0xff;
            this.tpuParamRam[o + 1] = value & 0xff;
            return;
        }
        if (a >= 0xfff000) { this.writeRegister(a, value & 0xffff, 2); return; }

        const ram = this.ramSlot(a);
        if (ram) {
            if (!ram.enabled) {
                this.violations.push({
                    kind: 'write-to-disabled-ram', address: a,
                    detail: `${ram.which} is not enabled, so this write goes nowhere.`
                        + ' A loader that copies its flash stub here without enabling RAM first'
                        + ' will jump into empty space.',
                });
                return;
            }
            ram.array[ram.offset] = (value >>> 8) & 0xff;
            ram.array[ram.offset + 1] = value & 0xff;
            return;
        }

        const offset = this.flashOffset(a);
        if (offset !== undefined) {
            if (!csorAllowsWrite(this.csorbt) && !csorAllowsWrite(this.csor0)) {
                this.violations.push({
                    kind: 'flash-write-blocked', address: a,
                    detail: `write of 0x${(value & 0xffff).toString(16)} discarded: neither CSBOOT`
                        + ` (0x${this.csorbt.toString(16)}) nor CS0 (0x${this.csor0.toString(16)})`
                        + ' permits writes. The firmware sets CSOR0 = 0x70F0 before flash work.',
                });
                return;
            }
            this.flash.writeWord(offset, value & 0xffff);
            return;
        }

        this.violations.push({ kind: 'unmapped-access', address: a, detail: 'write to unmapped address' });
    }

    writeByte(address: number, value: number): void {
        const a = busAddress(address);
        if (a >= TPU_PARAM_RAM_BASE) { this.tpuParamRam[a - TPU_PARAM_RAM_BASE] = value & 0xff; return; }
        if (a >= 0xfff000) { this.writeRegister(a, value & 0xff, 1); return; }

        const ram = this.ramSlot(a);
        if (ram) {
            if (!ram.enabled) {
                this.violations.push({
                    kind: 'write-to-disabled-ram', address: a,
                    detail: `${ram.which} is not enabled, so this write goes nowhere`,
                });
                return;
            }
            ram.array[ram.offset] = value & 0xff;
            return;
        }

        // A byte write to flash is a read-modify-write of the word on a 16-bit device; real
        // drivers never do it, so record it rather than pretending it works.
        const offset = this.flashOffset(a);
        if (offset !== undefined) {
            this.violations.push({
                kind: 'unmapped-access', address: a,
                detail: 'byte write to a 16-bit flash device; the AMD command set is word-oriented',
            });
            return;
        }
        this.violations.push({ kind: 'unmapped-access', address: a, detail: 'byte write to unmapped address' });
    }

    private readRegister(address: number): number {
        return this.registers.get(address & ~1) ?? 0;
    }

    private writeRegister(address: number, value: number, size: 1 | 2): void {
        const aligned = size === 2 ? address : address & ~1;
        if (size === 2) this.registers.set(aligned, value);
        else {
            const current = this.registers.get(aligned) ?? 0;
            const updated = (address & 1) ? (current & 0xff00) | value : (current & 0x00ff) | (value << 8);
            this.registers.set(aligned, updated);
        }

        // Watchdog service: SWSR takes 0x55 then 0xAA.
        if (address === SIM.SWSR) {
            if (value === 0x55) this.watchdogSequence = 1;
            else if (value === 0xaa && this.watchdogSequence === 1) {
                this.watchdogSequence = 0;
                this.instructionsSinceService = 0;
            } else this.watchdogSequence = 0;
            return;
        }
        // SYPCR is write-once; SWE is bit 7 of the low byte.
        if (address === SIM.SYPCR) {
            this.watchdogEnabled = (value & 0x80) !== 0;
            return;
        }
        if (aligned === SIM.CSORBT) { this.csorbt = value; return; }
        if (aligned === SIM.CSOR0) { this.csor0 = value; return; }

        // RAM enable. Writing a base address enables the array, as RAMBAR/RAMBAH do on the part.
        if (aligned === SIM.RAMBAH || aligned === SIM.RAMBAL) {
            const hi = this.registers.get(SIM.RAMBAH) ?? 0;
            const lo = this.registers.get(SIM.RAMBAL) ?? 0;
            this.sramBase = ((hi << 16) | lo) >>> 0;
            this.sramEnabled = true;
            return;
        }
        if (aligned === SIM.TRAMBAR) {
            this.tpuramBase = ((value & 0xfff0) | 0x00ff0000) >>> 0;
            this.tpuramEnabled = (value & 1) === 0;
            return;
        }
        if (aligned === SIM.RAMMCR) {
            // STOP bit (15) puts the array in low-power stop; clearing it enables normal access.
            if ((value & 0x8000) === 0 && this.sramBase !== 0) this.sramEnabled = true;
            return;
        }
    }

    /** Convenience for a harness: enable the RAM the way the firmware's reset code does. */
    enableRamLikeFirmware(): void {
        this.sramBase = 0x00ffe000;
        this.sramEnabled = true;
        this.tpuramBase = 0x00ffb800;
        this.tpuramEnabled = true;
    }

    /** Convenience: put the chip selects into the state the firmware uses for flash work. */
    enableFlashWritesLikeFirmware(): void {
        this.csorbt = 0x68f0;  // read only, 3 wait states
        this.csor0 = 0x70f0;   // write only, 3 wait states
    }
}
