/**
 * The bootloader replacement sequence: what would be done, in what order, and why each step is
 * where it is.
 *
 * This mirrors `flashSequence.ts` - plan, then validate, both pure - but for a different and far
 * more dangerous operation, so it is a separate module with its own validator rather than a
 * `WindowKind` added to the existing one. The conversion path cannot reach this code, and this
 * code cannot widen the conversion path's guards.
 *
 * ## The sequence, and the one ordering that matters
 *
 *   login                  cmd 0x90 seed/key
 *   read-before            capture SA0 (and ideally all 512 KiB) twice, compare
 *   erase-calibration      segment 0x06 at the calibration window
 *   write-staged           segment 0x02, ascending, the magic in the LAST chunk
 *   verify-staged          read the sector back and compare byte for byte
 *   arm                    (the magic is already written; this step names the moment)
 *   power-cycle            the reset handler runs the loader
 *   read-after             capture SA0 again and compare against the intended image
 *   restore-calibration    put a real calibration back through the ordinary path
 *
 * `verify-staged` sits between the write and the arming for a reason. The magic is checked by
 * the RESET handler at 0x24A, before the SIM, the stack or the K-line come up - so once it is
 * in flash, every power-up runs the loader and a defective loader can never be reached over OBD
 * again. Verifying the staged sector while the ECU still boots normally is the last moment at
 * which the operation is reversible.
 *
 * ## What this module refuses
 *
 * A plan may only ever erase or write the calibration window. The bootloader is reprogrammed by
 * the loader running inside the ECU, never by a telegram - so any plan that names a bootloader
 * address is a bug, and `validateBlReplace` says so rather than trusting the caller.
 */
import { WRITE_CHUNK_MAX } from './regionMap';
import { isProtectedImageOffset, type Processor } from './imageLayout';
import {
    STAGED_SECTOR_LENGTH, STAGING_DS2_ADDRESS, MAGIC_OFFSET,
    stagedWriteOrder, sectorIsArmed, carriesNoBootloaderImage,
    type StagedSector, type LoaderPurpose,
} from './blLoader';
import { SA0_LENGTH } from './bootloaderImage';
import { eraseNibbleAllowed, writeNibbleAllowed, nibbleOf, BOOTLOADER_NIBBLES } from './telegrams';
import { DEFAULT_ACCESS_LEVEL } from './seedKey';

export type BlStepKind =
    | 'login' | 'read-before' | 'erase-calibration' | 'write-staged' | 'verify-staged'
    | 'arm' | 'power-cycle' | 'read-after' | 'restore-calibration';

export interface BlStep {
    readonly kind: BlStepKind;
    readonly note: string;
    /** Present for steps that put an address on the wire. */
    readonly ds2Address?: number;
    /** Present for write steps. */
    readonly data?: Uint8Array;
    /** True for the single step after which the ECU boots into the loader. */
    readonly armsTheEcu?: boolean;
    /** True while the ECU can still be restored over OBD alone. */
    readonly reversible: boolean;
}

export interface BlPlan {
    readonly processor: Processor;
    /**
     * Whether this plan replaces a bootloader or only proves the loader entry works.
     *
     * The two are identical up to the power cycle - same erase, same sector, same magic, same
     * irreversibility - and differ entirely in what runs afterwards and in what counts as success.
     * Carried here so the executor and the screens do not each decide it for themselves.
     */
    readonly purpose: LoaderPurpose;
    readonly ds2Address: number;
    readonly steps: readonly BlStep[];
    /** Index of the step after which recovery needs BDM. */
    readonly pointOfNoReturn: number;
}

export interface BlViolation {
    readonly step: number;
    readonly message: string;
}

/**
 * Build the plan for one processor.
 *
 * One processor at a time is not a limitation, it is the design. The reset handler is the
 * trigger, so arming is per-processor: staging only the slave leaves the master booting normally
 * and keeping DS2 alive, which means the result can be observed and the master is still there if
 * the slave's loader misbehaves. Arming both at once gives up that.
 */
export function planBlReplace(sector: StagedSector, chunkSize = WRITE_CHUNK_MAX): BlPlan {
    const { processor, ds2Address, purpose } = sector;
    const probing = purpose === 'probe';
    if (ds2Address !== STAGING_DS2_ADDRESS[processor]) {
        throw new Error(
            `staged sector for the ${processor} must target 0x${STAGING_DS2_ADDRESS[processor].toString(16)},`
            + ` not 0x${ds2Address.toString(16)}`);
    }

    const steps: BlStep[] = [
        {
            kind: 'login',
            note: `cmd 0x90 seed/key at access level ${DEFAULT_ACCESS_LEVEL}`,
            reversible: true,
        },
        {
            kind: 'read-before',
            note: 'capture all 512 KiB twice with the linear read segment and compare;'
                + ' this is the only backup that includes SA0, SA1 and SA2',
            ds2Address: 0,
            reversible: true,
        },
        {
            kind: 'erase-calibration',
            note: 'segment 0x06 at the calibration window - the ordinary, real-car-proven erase',
            ds2Address,
            reversible: true,
        },
    ];

    for (const step of stagedWriteOrder(sector, chunkSize)) {
        steps.push({
            kind: 'write-staged',
            note: step.armsTheEcu
                ? 'final chunk: completes the magic at 0xFFFC and arms the reset handler'
                : 'staged loader and bootloader image',
            ds2Address: step.ds2Address,
            data: step.bytes,
            armsTheEcu: step.armsTheEcu,
            reversible: !step.armsTheEcu,
        });
    }

    // The verify belongs before the arming chunk, but the arming chunk is the sector's last
    // bytes - so the honest placement is: verify everything that is not the magic, then arm.
    const armIndex = steps.findIndex((s) => s.armsTheEcu);
    const verify: BlStep = {
        kind: 'verify-staged',
        note: 'read the staged sector back and compare byte for byte, while the ECU still boots'
            + ' normally - the last reversible moment',
        ds2Address,
        reversible: true,
    };
    steps.splice(armIndex, 0, verify);

    steps.push(
        {
            kind: 'arm',
            note: 'the magic is now in flash: every power-up jumps to 0x8000 until the loader clears it',
            armsTheEcu: true,
            reversible: false,
        },
        {
            kind: 'power-cycle',
            note: 'the reset handler at 0x24A finds the magic and runs the loader;'
                + ' the loader clears the magic first, then replaces SA0',
            reversible: false,
        },
        {
            kind: 'read-after',
            note: probing
                ? 'a DS2 answer at all is the result: the reset handler runs before the K-line'
                  + ' comes up, so a DME that talks has already cleared its own magic. Read the'
                  + ' magic to confirm it directly, and SA0 to confirm nothing touched it.'
                : `re-read SA0 (${SA0_LENGTH} bytes) and compare against the intended image;`
                  + ' also read the encoding checksum and require the boot-sector bit to be clear',
            ds2Address: 0,
            reversible: false,
        },
        {
            kind: 'restore-calibration',
            note: 'write a real calibration back through the ordinary conversion path',
            ds2Address,
            reversible: false,
        },
    );

    const pointOfNoReturn = steps.findIndex((s) => s.armsTheEcu === true);
    return { processor, purpose, ds2Address, steps, pointOfNoReturn };
}

/**
 * Build a probe plan.
 *
 * The same function, named for what it does, because the sector already carries the purpose and
 * choosing the plan by the sector is what keeps the two from disagreeing. This exists so a caller
 * reads `planProbe(sector)` at the call site rather than `planBlReplace` on a probe, which is a
 * line that would have to be read twice.
 */
export function planProbe(sector: StagedSector, chunkSize = WRITE_CHUNK_MAX): BlPlan {
    if (sector.purpose !== 'probe') {
        throw new Error('planProbe was given a sector built for a bootloader replacement');
    }
    return planBlReplace(sector, chunkSize);
}

/**
 * Check a plan. Returns findings rather than throwing, so a caller can show all of them.
 *
 * The rules encode the two things that make this operation survivable: every telegram stays in
 * the calibration window, and the sector is verified before the magic completes.
 */
export function validateBlReplace(plan: BlPlan): BlViolation[] {
    const violations: BlViolation[] = [];
    const expectedAddress = STAGING_DS2_ADDRESS[plan.processor];

    let armCount = 0;
    let verifiedBeforeArming = false;
    let writtenBytes = 0;
    let lastWriteEnd: number | undefined;
    // Reassembled from the write steps, so the purpose is checked against the bytes that would
    // actually go out rather than against the label on the plan.
    const sector = new Uint8Array(STAGED_SECTOR_LENGTH).fill(0xff);

    plan.steps.forEach((step, index) => {
        const add = (message: string): void => { violations.push({ step: index, message }); };

        if (step.kind === 'verify-staged' && armCount === 0) verifiedBeforeArming = true;
        if (step.armsTheEcu) armCount++;

        if (step.kind === 'erase-calibration') {
            if (step.ds2Address !== expectedAddress) {
                add(`erase targets 0x${(step.ds2Address ?? 0).toString(16)}, not the calibration window`);
            }
            if (step.ds2Address !== undefined && !eraseNibbleAllowed(step.ds2Address)) {
                add(`erase at 0x${step.ds2Address.toString(16)} is not an address this tool may erase`);
            }
        }

        if (step.kind === 'write-staged') {
            const address = step.ds2Address;
            const data = step.data;
            if (address === undefined || data === undefined) {
                add('a write step must carry both an address and data');
                return;
            }
            if (!writeNibbleAllowed(address)) {
                add(`write at 0x${address.toString(16)} is not an address this tool may write`);
            }
            if (BOOTLOADER_NIBBLES.includes(nibbleOf(address))) {
                add(`write at 0x${address.toString(16)} targets the bootloader;`
                    + ' the bootloader is replaced by the loader inside the ECU, never by a telegram');
            }
            if (address < expectedAddress || address + data.length > expectedAddress + STAGED_SECTOR_LENGTH) {
                add(`write at 0x${address.toString(16)} falls outside the staged sector`);
            }
            if (data.length === 0 || data.length > WRITE_CHUNK_MAX) {
                add(`write length ${data.length} outside 1..${WRITE_CHUNK_MAX}`);
            }
            if (data.length % 2 !== 0) add(`write length ${data.length} must be even`);
            if (address % 2 !== 0) add(`write address 0x${address.toString(16)} must be even`);
            if (lastWriteEnd !== undefined && address !== lastWriteEnd) {
                add(`write at 0x${address.toString(16)} is not contiguous with the previous chunk`);
            }
            const offset = address - expectedAddress;
            if (offset >= 0 && offset + data.length <= STAGED_SECTOR_LENGTH) sector.set(data, offset);
            lastWriteEnd = address + data.length;
            writtenBytes += data.length;
        }

        if (step.ds2Address !== undefined && step.kind !== 'read-before' && step.kind !== 'read-after') {
            const offset = step.ds2Address - expectedAddress;
            if (offset >= 0 && offset < STAGED_SECTOR_LENGTH && isProtectedImageOffset(step.ds2Address)) {
                add(`step targets a protected image offset`);
            }
        }
    });

    if (armCount !== 2) {
        // One on the final write chunk, one on the explicit 'arm' step that names the moment.
        violations.push({ step: -1, message: `expected exactly one arming write and one arm step, found ${armCount}` });
    }
    if (!verifiedBeforeArming) {
        violations.push({
            step: -1,
            message: 'the staged sector must be verified before the magic completes -'
                + ' after that the ECU cannot be recovered over OBD',
        });
    }
    if (writtenBytes !== STAGED_SECTOR_LENGTH) {
        violations.push({ step: -1, message: `staged writes cover ${writtenBytes} of ${STAGED_SECTOR_LENGTH} bytes` });
    }
    if (plan.pointOfNoReturn < 0) {
        violations.push({ step: -1, message: 'a plan must identify its point of no return' });
    }

    /**
     * The purpose, checked against the bytes.
     *
     * A probe that carries a bootloader image is the worst mislabelling this tool could produce: it
     * would arm an SA0 rewrite behind a screen that promises the bootloader will not be touched,
     * and the operator would consent to the wrong operation. So the claim is not trusted - the
     * region a replacement uses is re-examined here, in the same pass that checks every address.
     *
     * The converse is checked too. A replacement whose bootloader region is erased would arm the
     * ECU to program 16 KiB of 0xFF over SA0, and its screen would say a bootloader was being
     * installed.
     */
    if (writtenBytes === STAGED_SECTOR_LENGTH) {
        const carriesImage = !carriesNoBootloaderImage(sector);
        if (plan.purpose === 'probe' && carriesImage) {
            violations.push({
                step: -1,
                message: 'this plan is labelled a probe but its staged sector carries a bootloader'
                    + ' image; a probe must never be able to rewrite SA0',
            });
        }
        if (plan.purpose === 'replace' && !carriesImage) {
            violations.push({
                step: -1,
                message: 'this plan is labelled a bootloader replacement but its staged sector'
                    + ' carries no bootloader image; it would program erased flash over SA0',
            });
        }
    }

    return violations;
}

/** Throw when a plan is not safe to execute, listing what is wrong. */
export function assertBlReplaceable(plan: BlPlan): void {
    const violations = validateBlReplace(plan);
    if (violations.length === 0) return;
    const shown = violations.slice(0, 8).map((v) => `  step ${v.step}: ${v.message}`).join('\n');
    const more = violations.length > 8 ? `\n  ...and ${violations.length - 8} more` : '';
    throw new Error(`bootloader replacement plan is not safe to execute:\n${shown}${more}`);
}

/** A human-readable summary, with the point of no return marked. */
export function describeBlPlan(plan: BlPlan): string {
    const lines: string[] = [
        `${plan.purpose === 'probe' ? 'loader probe' : 'bootloader replacement'}, ${plan.processor},`
        + ` staging at 0x${plan.ds2Address.toString(16)}`,
    ];
    const writes = plan.steps.filter((s) => s.kind === 'write-staged').length;
    lines.push(`  ${plan.steps.length} steps, of which ${writes} are staged-sector write telegrams`);
    lines.push(`  point of no return: step ${plan.pointOfNoReturn} (${plan.steps[plan.pointOfNoReturn]?.kind})`);
    const violations = validateBlReplace(plan);
    lines.push(violations.length === 0 ? '  validation: PASS' : `  validation: ${violations.length} violation(s)`);
    return lines.join('\n');
}

/** True when this sector, once written, would arm the ECU. */
export function planArmsTheEcu(sector: StagedSector): boolean {
    return sectorIsArmed(sector.bytes);
}

/** Offset of the magic within the staged sector, re-exported so callers need not reach into blLoader. */
export const STAGED_MAGIC_OFFSET = MAGIC_OFFSET;

/** Load-time invariant: this module plans calibration-window work and nothing else. */
function assertStagingStaysInCalibration(): void {
    for (const processor of ['master', 'slave'] as const) {
        const address = STAGING_DS2_ADDRESS[processor];
        if (!eraseNibbleAllowed(address) || !writeNibbleAllowed(address)) {
            throw new Error(`staging address 0x${address.toString(16)} is not one this tool may erase and write`);
        }
        if (BOOTLOADER_NIBBLES.includes(nibbleOf(address))) {
            throw new Error('staging must never target the bootloader window');
        }
    }
}
assertStagingStaysInCalibration();
