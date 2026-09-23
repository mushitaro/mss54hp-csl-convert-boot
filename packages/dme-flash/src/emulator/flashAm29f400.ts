/**
 * A behavioural model of the Am29F400BB NOR flash, faithful to the properties that decide
 * whether a bootloader loader survives.
 *
 * This is not a general-purpose simulator. It models the handful of behaviours that a wrong
 * loader would violate, and it makes each violation *loud* rather than silently permissive:
 *
 *  1. **Programming can only clear bits.** A 0 -> 1 attempt is not a write that quietly fails;
 *     the device latches an error and reports it on DQ5, as the datasheet describes. This is
 *     what makes "write 0xFF into the untouched half" a real bug rather than a style choice,
 *     and why BMW's own routine reads the current word and ANDs it in.
 *
 *  2. **The whole device is unreadable during an embedded operation.** Am29F400B is a single
 *     bank with no read-while-write. While an erase or program runs, a read of ANY address
 *     returns status bits, not array data. That is precisely why the resident firmware copies
 *     its inner loop to RAM - and a loader that fetches instructions or source data from flash
 *     mid-operation will read status and execute it as opcodes.
 *
 *  3. **Sector geometry.** Bottom boot: 16K / 8K / 8K / 32K / 7x64K. An erase clears the whole
 *     sector containing the address, which is why "erase the bootloader" and "erase 16 KiB" are
 *     the same act, and why the calibration sector can be erased without touching SA0.
 *
 *  4. **The DQ7 / DQ5 status protocol**, including the datasheet's requirement to re-read DQ7
 *     after seeing DQ5, because a naive poller can otherwise declare failure on an operation
 *     that actually completed.
 *
 * Time is modelled as a poll count rather than nanoseconds: an operation completes after a
 * configurable number of status reads. That keeps the model deterministic and lets a polling
 * loop terminate, while still exercising the busy path.
 *
 * The model is validated by driving it with BMW's own erase and program routines, lifted
 * verbatim from the firmware image - see `bmwStubs.test.ts`. If those proven routines drive it
 * correctly, the model is a reasonable stand-in for the real part.
 */

/** Bottom-boot sector map, as byte offsets. Sum = 512 KiB. */
export const SECTOR_LAYOUT: readonly { readonly start: number; readonly length: number }[] = [
    { start: 0x00000, length: 0x4000 },  // SA0  16K - bootloader
    { start: 0x04000, length: 0x2000 },  // SA1   8K - Free Identifiers
    { start: 0x06000, length: 0x2000 },  // SA2   8K - tail guard
    { start: 0x08000, length: 0x8000 },  // SA3  32K - calibration
    { start: 0x10000, length: 0x10000 }, // SA4  64K - program
    { start: 0x20000, length: 0x10000 }, // SA5
    { start: 0x30000, length: 0x10000 }, // SA6
    { start: 0x40000, length: 0x10000 }, // SA7
    { start: 0x50000, length: 0x10000 }, // SA8
    { start: 0x60000, length: 0x10000 }, // SA9
    { start: 0x70000, length: 0x10000 }, // SA10
] as const;

export const FLASH_LENGTH = 0x80000;

/** Status bit positions, as they appear in each byte lane of a word read. */
export const DQ7 = 0x80;
export const DQ6 = 0x40;
export const DQ5 = 0x20;

type Mode = 'read-array' | 'autoselect' | 'busy-program' | 'busy-erase' | 'error';

export interface FlashOptions {
    /** Status reads before a program completes. */
    readonly programPolls?: number;
    /** Status reads before a sector erase completes. */
    readonly erasePolls?: number;
    /** Inject a byte that refuses to take its new value, to exercise a loader's failure path. */
    readonly stuckByteOffset?: number;
}

export type ViolationKind =
    | 'read-while-busy' | 'fetch-while-busy' | 'program-sets-bit'
    | 'write-outside-device' | 'bad-command';

export interface FlashViolation {
    readonly kind: ViolationKind;
    readonly address: number;
    readonly detail: string;
}

/**
 * One Am29F400BB device.
 *
 * `violations` records things a correct driver would never do. They do not throw, because the
 * device would not throw either - it would misbehave. The harness inspects them, so a loader
 * bug surfaces as a recorded violation rather than as a mysteriously passing run.
 */
export class Am29F400 {
    readonly array: Uint8Array;
    readonly violations: FlashViolation[] = [];

    private mode: Mode = 'read-array';
    /**
     * Position in the AMD command sequence.
     *   0 -> 1 -> 2 : AA@555, 55@2AA
     *   2 -> 3      : A0@555          (program setup; next write is the data cycle)
     *   2 -> 4      : 80@555          (erase setup; a second unlock pair follows)
     *   4 -> 5 -> 6 : AA@555, 55@2AA
     *   6           : 30@sector or 10@555
     */
    private step = 0;
    private pollsRemaining = 0;
    private operationAddress = 0;
    private programTarget = 0;
    private toggle = false;
    /** Set when the operation in progress is going to abort rather than complete. */
    private willFail = false;
    /** Which kind of operation the error state refers to - DQ7 differs between them. */
    private lastOperation: 'program' | 'erase' = 'program';

    private readonly programPolls: number;
    private readonly erasePolls: number;
    private readonly stuckByteOffset: number | undefined;

    constructor(initial?: Uint8Array, options: FlashOptions = {}) {
        this.array = new Uint8Array(FLASH_LENGTH).fill(0xff);
        if (initial) {
            if (initial.length !== FLASH_LENGTH) {
                throw new Error(`initial image must be ${FLASH_LENGTH} bytes, got ${initial.length}`);
            }
            this.array.set(initial);
        }
        this.programPolls = options.programPolls ?? 3;
        this.erasePolls = options.erasePolls ?? 8;
        this.stuckByteOffset = options.stuckByteOffset;
    }

    /** True while an embedded algorithm is running - i.e. while the device cannot be read. */
    get busy(): boolean {
        return this.mode === 'busy-program' || this.mode === 'busy-erase';
    }

    /** True once an operation has failed; cleared only by a reset command. */
    get inError(): boolean {
        return this.mode === 'error';
    }

    /** The sector containing an address. */
    static sectorOf(address: number): { start: number; length: number } {
        const sector = SECTOR_LAYOUT.find((s) => address >= s.start && address < s.start + s.length);
        if (!sector) throw new Error(`address 0x${address.toString(16)} is outside the device`);
        return sector;
    }

    /**
     * A 16-bit read.
     *
     * `isFetch` marks an instruction fetch. A fetch while busy is the specific catastrophe this
     * model exists to catch: the CPU would execute status bits as code.
     */
    readWord(address: number, isFetch = false): number {
        if (this.busy || this.mode === 'error') {
            if (isFetch) {
                this.violations.push({
                    kind: 'fetch-while-busy', address,
                    detail: 'INSTRUCTION FETCH from flash while an embedded algorithm is running:'
                        + ' the CPU would execute status bits as opcodes.'
                        + ' The erase/program loop must run from RAM.',
                });
            } else if (this.busy && !this.isStatusPollFor(address)) {
                this.violations.push({
                    kind: 'read-while-busy', address,
                    detail: 'array read while an embedded algorithm is running returns status, not data',
                });
            }
            return this.statusWord();
        }
        return ((this.array[address] ?? 0xff) << 8) | (this.array[address + 1] ?? 0xff);
    }

    /** An 8-bit read. The device is word-oriented, so this narrows a word read. */
    readByte(address: number, isFetch = false): number {
        const word = this.readWord(address & ~1, isFetch);
        return (address & 1) === 0 ? (word >>> 8) & 0xff : word & 0xff;
    }

    /**
     * Polling the operation's own address is the documented way to read status, so it is not a
     * violation. Polling a *different* address during an operation is a driver bug.
     */
    private isStatusPollFor(address: number): boolean {
        if (this.mode === 'busy-program') return (address & ~1) === (this.operationAddress & ~1);
        if (this.mode === 'busy-erase') {
            const sector = Am29F400.sectorOf(this.operationAddress);
            return address >= sector.start && address < sector.start + sector.length;
        }
        return false;
    }

    /**
     * A 16-bit write: a command cycle, or the data cycle of a program.
     *
     * Unlock cycles are decoded from A10-A0 of the *word* address, as the device does - which is
     * why BMW's byte addresses 0xAAAA and 0x5554 are the correct 0x555 / 0x2AA pair.
     */
    writeWord(address: number, value: number): void {
        if (address < 0 || address >= FLASH_LENGTH) {
            this.violations.push({
                kind: 'write-outside-device', address,
                detail: `write of 0x${value.toString(16)} outside the 512 KiB device`,
            });
            return;
        }
        const data = value & 0xffff;
        const command = data & 0xff;
        const wordAddress = (address >>> 1) & 0x7ff;

        // A reset command is honoured from any state, including the error state.
        if (command === 0xf0 && this.step !== 3) {
            this.mode = this.busy ? this.mode : 'read-array';
            this.step = 0;
            return;
        }

        // The data cycle of a program names its own address.
        if (this.step === 3) {
            this.step = 0;
            this.beginProgram(address, data);
            return;
        }

        // Writes during an embedded operation are ignored by the device.
        if (this.busy) return;

        switch (this.step) {
            case 0:
                this.step = wordAddress === 0x555 && command === 0xaa ? 1 : 0;
                return;
            case 1:
                this.step = wordAddress === 0x2aa && command === 0x55 ? 2 : 0;
                return;
            case 2:
                if (wordAddress !== 0x555) { this.step = 0; return; }
                if (command === 0xa0) { this.step = 3; return; }
                if (command === 0x80) { this.step = 4; return; }
                if (command === 0x90) { this.mode = 'autoselect'; this.step = 0; return; }
                this.violations.push({
                    kind: 'bad-command', address,
                    detail: `unrecognised command 0x${command.toString(16)} after a valid unlock`,
                });
                this.step = 0;
                return;
            case 4:
                this.step = wordAddress === 0x555 && command === 0xaa ? 5 : 0;
                return;
            case 5:
                this.step = wordAddress === 0x2aa && command === 0x55 ? 6 : 0;
                return;
            case 6:
                this.step = 0;
                if (command === 0x30) { this.beginErase(address); return; }
                if (command === 0x10) {
                    this.violations.push({
                        kind: 'bad-command', address,
                        detail: 'chip erase requested - this would take the bootloader with it',
                    });
                    this.array.fill(0xff);
                    return;
                }
                this.violations.push({
                    kind: 'bad-command', address,
                    detail: `unrecognised erase confirm 0x${command.toString(16)}`,
                });
                return;
            default:
                this.step = 0;
                return;
        }
    }

    private beginProgram(address: number, data: number): void {
        const current = ((this.array[address] ?? 0xff) << 8) | (this.array[address + 1] ?? 0xff);
        // NOR programming can only clear bits.
        const wantsToSet = data & ~current & 0xffff;
        if (wantsToSet !== 0) {
            this.violations.push({
                kind: 'program-sets-bit', address,
                detail: `program of 0x${data.toString(16).padStart(4, '0')} over`
                    + ` 0x${current.toString(16).padStart(4, '0')} would set bit(s)`
                    + ` 0x${wantsToSet.toString(16).padStart(4, '0')};`
                    + ' NOR can only clear bits, so the device aborts and raises DQ5',
            });
            this.mode = 'error';
            this.programTarget = data;
            this.operationAddress = address;
            return;
        }
        const stuck = this.stuckByteOffset !== undefined
            && (this.stuckByteOffset === address || this.stuckByteOffset === address + 1);
        this.mode = 'busy-program';
        this.lastOperation = 'program';
        this.operationAddress = address;
        this.programTarget = data;
        // A stuck cell aborts: the device raises DQ5 and stops. It does NOT stay busy forever -
        // an aborted operation still accepts the reset command, which is how a driver recovers.
        this.willFail = stuck;
        this.pollsRemaining = stuck ? Math.min(3, this.programPolls) : this.programPolls;
    }

    private beginErase(address: number): void {
        const sector = Am29F400.sectorOf(address);
        this.mode = 'busy-erase';
        this.lastOperation = 'erase';
        this.operationAddress = sector.start;
        this.programTarget = 0;
        // MAX_SAFE_INTEGER is the harness's way of saying "this sector will not erase".
        this.willFail = this.erasePolls >= Number.MAX_SAFE_INTEGER;
        this.pollsRemaining = this.willFail ? 3 : this.erasePolls;
    }

    /**
     * Status presented while busy or in error, duplicated into both byte lanes.
     *
     * During a program, DQ7 is the complement of the target's DQ7 until it completes; during an
     * erase DQ7 reads 0. DQ6 toggles on every read. DQ5 sets when the operation has exceeded its
     * time limit, which in this model means it will never complete.
     */
    private statusWord(): number {
        this.toggle = !this.toggle;
        let status = this.toggle ? DQ6 : 0;

        if (this.mode === 'error') {
            // An aborted operation: DQ5 stays set, and DQ7 keeps showing what it showed while
            // busy - the complement of the target for a program, 0 for an erase. Getting that
            // wrong would let a failed erase look successful to a correct polling loop.
            status |= DQ5;
            if (this.lastOperation === 'program') status |= (this.programTarget & 0x80) ? 0 : DQ7;
            return (status << 8) | status;
        }

        if (this.pollsRemaining > 0) {
            this.pollsRemaining--;
            if (this.mode === 'busy-program') status |= (this.programTarget & 0x80) ? 0 : DQ7;
            return (status << 8) | status;
        }

        if (this.willFail) {
            // The device stops here and waits for a reset command. It is no longer busy, so a
            // driver can issue 0xF0 and read the array again - which is exactly how it recovers.
            this.willFail = false;
            this.mode = 'error';
            status |= DQ5;
            if (this.lastOperation === 'program') status |= (this.programTarget & 0x80) ? 0 : DQ7;
            return (status << 8) | status;
        }

        this.complete();
        return ((this.array[this.operationAddress] ?? 0xff) << 8)
            | (this.array[this.operationAddress + 1] ?? 0xff);
    }

    private complete(): void {
        if (this.mode === 'busy-program') {
            this.array[this.operationAddress] = (this.programTarget >>> 8) & 0xff;
            this.array[this.operationAddress + 1] = this.programTarget & 0xff;
        } else if (this.mode === 'busy-erase') {
            const sector = Am29F400.sectorOf(this.operationAddress);
            this.array.fill(0xff, sector.start, sector.start + sector.length);
        }
        this.mode = 'read-array';
    }

    /** Reset to read-array, as a power cycle would. Keeps the array contents. */
    powerCycle(): void {
        this.mode = 'read-array';
        this.step = 0;
        this.pollsRemaining = 0;
        this.willFail = false;
    }
}
