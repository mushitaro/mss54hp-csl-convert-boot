/**
 * The wizard's shape: which steps exist, and the order they are walked in.
 *
 * Separate from `App.tsx` because it is the part that can be wrong without looking wrong. A step
 * list is easy to read and easy to get right; the *walking order* derived from it is neither, and
 * an error there does not render as a mistake - it renders as the app quietly moving to the wrong
 * screen. That has happened twice. Here it is data, and `wizard.test.ts` checks it.
 */

/**
 * The steps, in the two shapes the job actually has.
 *
 * Not one flat list. The setup happens once; then a stage runs, and the wizard returns to PLAN for
 * the next one. A single 1..N counter described that as going backwards at every stage boundary.
 *
 * A bootloader stage has no SPEED step, and that is not a simplification. Fast entry exists to make
 * a *bulk* read quicker, and the only bulk read left after the backup is the program stage's
 * read-back; a bootloader stage reads 32 KiB of staged sector and 16 KiB of SA0, where the boost
 * would save under a minute and cost an 8 KiB erase. Offering the choice there offered one that
 * could not pay. Nor does it have PATCH: there is no calibration in a bootloader.
 *
 * The PROBE stage walks the same three steps as a bootloader stage, because it is the same
 * operation minus its payload: same erase, same 32 KiB, same magic, same power cycle, same
 * irreversibility. Giving it a shorter or gentler walk would be the wrong lesson - the arming is
 * the dangerous act, and the probe performs it in full.
 */
export const SETUP_STEPS = ['LINK', 'IDENT', 'BACKUP'] as const;
export const BOOTLOADER_STAGE_STEPS = ['PLAN', 'REVIEW', 'RUN'] as const;
export const PROBE_STAGE_STEPS = BOOTLOADER_STAGE_STEPS;
export const PROGRAM_STAGE_STEPS = ['PLAN', 'PATCH', 'SPEED', 'REVIEW', 'RUN'] as const;

export const STEPS = [
    'LINK', 'IDENT', 'BACKUP', 'PLAN', 'PATCH', 'SPEED', 'REVIEW', 'RUN',
] as const;
export type StepId = (typeof STEPS)[number];

/**
 * The kinds of stage a job is made of, in the order they can occur.
 *
 * `probe` comes first and is not optional. It is the only way to learn, on THIS ECU rather than on
 * an emulator, that the loader entry at 0x8000 is reached, that the SRAM array can be enabled from
 * the state the RESET instruction leaves, and that a flash program cycle succeeds at the reset
 * chip-select timings. Every one of those is something a replacement loader must also get right,
 * and the replacement gets to be wrong about them only once.
 */
export type StageKind = 'probe' | 'bootloader' | 'program';

export function isSetupStep(step: StepId): boolean {
    return (SETUP_STEPS as readonly string[]).includes(step);
}

/** The steps one stage of the given kind is made of. */
export function stageSteps(kind: StageKind | undefined): readonly StepId[] {
    switch (kind) {
        case 'program': return PROGRAM_STAGE_STEPS;
        case 'probe': return PROBE_STAGE_STEPS;
        default: return BOOTLOADER_STAGE_STEPS;
    }
}

/**
 * The order BACK and NEXT walk while the given stage is the one in front of the operator.
 *
 * The setup followed by that stage - never the current *group's* steps. Deriving it from the group
 * meant that on a setup step the order read [LINK, IDENT, BACKUP, LINK, IDENT, BACKUP], so NEXT
 * from the last setup step went to LINK: the backup was taken, and the app returned to the
 * connection screen as though nothing had happened.
 */
export function walkOrder(kind: StageKind | undefined): readonly StepId[] {
    return [...SETUP_STEPS, ...stageSteps(kind)];
}
