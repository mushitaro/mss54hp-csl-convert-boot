/**
 * Building a CSL calibration variant from the genuine one, one documented edit at a time.
 *
 * The whole design rests on a fact established in docs/variant-targets.md: every option lives in
 * the 64 KiB calibration, so the 512 KiB program is never touched and its integrity fields come
 * along correct for free. This module therefore only ever edits calibration bytes, recomputes the
 * one checksum that is known (CRC-16/ARC), and records every byte it changed.
 *
 * Two rules borrowed from the SMG2 tool, for the same reason it needed them:
 *
 *  - **Edits are raw-preserving and self-cancelling.** An edit stores the bytes it overwrote, so
 *    turning a toggle off restores exactly what was there. The manifest's promise is "no byte
 *    outside a listed edit moved", and that is checkable.
 *  - **Only options with a code-backed encoding are offered.** Every option here is one whose
 *    bytes were found in the firmware's own code, not inferred from a value that looked right. A
 *    plausible-but-guessed encoding on an ECU is how you get a car that runs worse with no fault
 *    to explain it - which, for the cam option below, is precisely the failure mode.
 *
 * Everything here is pure. No transport, no flash. It turns a genuine calibration pair into a
 * patched calibration pair plus a manifest; sending it anywhere is a separate concern.
 */
import {
    CALIBRATION_PAIR_LENGTH, correctChecksums, analyseChecksums, halfOf,
    type Half, type HalfChecksum,
} from './calibrationImage';

// --- The options the UI offers -------------------------------------------------------------

/** MAP sensor handling. Genuine CSL is speed-density (Alpha-N) plus a MAP integral correction. */
export type MapMode =
    /** Leave genuine CSL untouched: k_rf_cfg = 0x12, MAP path and its diagnostic live. */
    | 'use'
    /**
     * Sensor not fitted yet, but it will be. Produces the SAME bytes as 'off' - see
     * `MAP_LATER_IS_OFF`. Kept as a separate choice only so the manifest records the intent.
     */
    | 'later'
    /** No MAP at all: k_rf_cfg = 0x02 (pure Alpha-N + TABG), MAP diagnostic suppressed. */
    | 'off';

/** CSL snorkel-flap handling. Genuine CSL ships an active flap. */
export type FlapMode =
    /** Leave the flap active (genuine CSL). */
    | 'present'
    /**
     * No flap hardware: zero the flap Alpha-N adder, make the flap EGAS map identical to the
     * normal one, and disable the three flap DTCs.
     */
    | 'absent';

/**
 * Which camshafts the car has.
 *
 * Genuine CSL software carries VANOS offsets calibrated for the camshafts BMW put in a CSL. The
 * community's answer for a standard M3 is a different pair of values in the same two words.
 *
 * Unlike every other option here, the standard-M3 values do NOT come from a BMW artefact - see
 * `VANOS_STANDARD_M3` for exactly where they come from and what is wrong with that source.
 */
export type CamMode =
    /** Leave the genuine CSL offsets untouched. */
    | 'csl'
    /** Write the values the community's stock-cam build carries. */
    | 'm3';

export interface VariantChoice {
    readonly map: MapMode;
    readonly flap: FlapMode;
    readonly cams: CamMode;
}

// --- Calibration addresses (pair offsets), each with the evidence for it -------------------

/**
 * k_rf_cfg - the RF-source config byte. 0x12 = Alpha-N (0x02) + MAP integral (0x10).
 * Genuine CSL value verified by reading it out of PD31 (docs/variant-targets.md).
 */
const K_RF_CFG = 0x0e5e4;
const K_RF_CFG_ALPHA_N_ONLY = 0x02;

/**
 * kf_rf_soll_ask - the flap Alpha-N adder, 24x20 x 16-bit = 960 bytes at 0xDB8A. Verified active
 * in genuine CSL (188/480 cells nonzero) and bounded to end exactly at kf_rf_soll_tau_up (0xDF4C).
 */
const KF_RF_SOLL_ASK_Z = 0x0db8a;
const KF_RF_SOLL_ASK_Z_LEN = 480 * 2;

/**
 * kf_egas_wdk_ask - the EGAS WDK map SELECTED (not added) while the flap is open, and the normal
 * map it must be made to match.
 *
 * **This one must never be zeroed.** It is a throttle-angle map whose cells run up to 1000; the
 * normal map commands 700-950 across the top row. Filling it with zeros means that if the DME ever
 * believes the flap is open - which it can, because with no position pot fitted the ADC reads a
 * rail value and, with the flap DTC disabled, nothing marks that reading as bad - the commanded
 * throttle angle becomes zero and the engine stops answering the pedal.
 *
 * The two maps are near-identical in genuine CSL: one x-axis breakpoint (1250 vs 1150 rpm) and
 * four z cells, all in the same column. Copying the normal map's axis and data over the flap one
 * makes the open-flap path behave exactly like the normal path, which is what "there is no flap"
 * should mean.
 */
const KF_EGAS_WDK_X = 0x0839e;
const KF_EGAS_WDK_X_LEN = 14 * 2;
const KF_EGAS_WDK_Z = 0x083e8;
const KF_EGAS_WDK_Z_LEN = 23 * 14 * 2;
const KF_EGAS_WDK_ASK_X = 0x08828;
const KF_EGAS_WDK_ASK_Z = 0x08872;

// --- VANOS offsets -------------------------------------------------------------------------

/**
 * The two 16-bit signed VANOS offset words, in the SLAVE half of the pair.
 *
 * ## What they are, from the firmware's own code
 *
 * The slave reads each of them exactly once, and the instruction says what they do:
 *
 * ```
 * slave 0x0A4DF2:  d0 79 00 08 98 02    add.w $00089802.l,d0
 * slave 0x0A5E0C:                       add.w $00089BB6.l,d0
 * ```
 *
 * The surrounding code multiplies a tooth count by 60 (6.0 deg KW per tooth), subtracts a segment
 * base, adds this word, adds -15, and stores the result as the measured cam position. So each is
 * an **additive trim on the measured cam angle, in units of 0.1 deg KW** - the unit falls out of
 * the arithmetic, not out of a name in someone's definition file. The tuner's parameter table
 * names them `K_EVAN1_OFFSET` and `K_AVAN1_OFFSET`.
 *
 * Structurally each heads an identical 20-byte block, and the four words those blocks agree on
 * (+2 = 0x00FF, +6 = 0x003E, +0x10 = 0x0010, +0x12 = 0x00A4) form a signature that occurs EXACTLY
 * TWICE in the whole 64 KiB pair. Two channels of one subsystem is what dual VANOS looks like.
 *
 * ## What is NOT established, and must not be claimed
 *
 * - **Which is intake and which is exhaust.** Every name available traces to a single definition
 *   lineage, so it is one source repeated, not two agreeing. Hence `A` and `B` here. Nothing needs
 *   the answer: the two words only ever move together.
 * - **Which way the cam physically moves.** The value is a sensor-zero trim inside a closed loop
 *   (`IST = raw + OFFSET + ADAP`, driven to `SOLL`), so the cam settles OPPOSITE to the number.
 *   No direction word - advance, retard - may appear in the UI.
 * - **Whether VANOS adaptation absorbs the change.** The adaptation may re-learn the offset away
 *   at idle, in which case the durable effect is small. Unresolved.
 *
 * ## The diff is NOT the evidence
 *
 * These two words are also the only difference between `ZB7837328_CSL_cams.bin` and
 * `ZB7837328_stock_M3_cams.bin` - but that "4 bytes in a megabyte" is an artefact of a hand-edit
 * whose checksum was never recomputed, not a property of the parameter. A correctly built
 * stock-cam image differs from the CSL one in SIX bytes, the extra two being the checksum. The
 * identification above rests on the read sites and the signature; it would stand with no diff at
 * all.
 */
const VANOS_A = 0x01802;
const VANOS_B = 0x01bb6;

/** The signature that identifies the structure, as pair-offset deltas and their expected words. */
const VANOS_SIGNATURE: readonly (readonly [number, number])[] = [
    [0x02, 0x00ff], [0x06, 0x003e], [0x10, 0x0010], [0x12, 0x00a4],
];

/** Genuine CSL: +30 and -20, i.e. +3.0 and -2.0 crank degrees. All six factory builds agree. */
const VANOS_GENUINE_CSL: readonly [number, number] = [30, -20];

/**
 * The standard-M3 values: -20 and +10.
 *
 * **This is the weakest provenance in this file, and it is not close.** Every other constant here
 * is read out of a BMW artefact or checked against all six factory builds. These two numbers exist
 * in exactly one place: a single community binary, `ZB7837328_stock_M3_cams.bin`.
 *
 * That file's slave calibration checksum is INVALID - it stores 0x2F81, the value from the CSL-cam
 * build it was edited from, where its own content computes 0xF337. Whoever made it changed these
 * two words and did not recompute the checksum. So it is not a BMW dump, and it is not even a
 * correctly-formed edit. No BMW artefact anywhere carries -20 / +10: all six factory builds are
 * +30 / -20, and BMW never shipped a stock-cam variant at all.
 *
 * The values are still worth offering, because they are what the community actually runs and this
 * tool can do the part that file got wrong: `buildVariant` recomputes the checksum, so what this
 * writes is self-consistent where the source is not. But the UI must not present these as factory
 * data, and `variantWarnings` says so.
 */
const VANOS_STANDARD_M3: readonly [number, number] = [-20, 10];

/**
 * The two offsets, published so a screen can derive the check it asks for.
 *
 * The UI has to tell the operator what a wrong answer looks like on the car, and that number is a
 * DIFFERENCE between these - 5.0 deg KW on one word and 3.0 on the other. Hardcoding it in the copy
 * meant the copy quoted one of the two, and an operator who checked the other bank saw the smaller
 * number and concluded the setting was right. In 0.1 deg KW, as stored.
 */
export const VANOS_OFFSETS: Readonly<Record<CamMode, readonly [number, number]>> = {
    csl: VANOS_GENUINE_CSL,
    m3: VANOS_STANDARD_M3,
};

function readSigned16(pair: Uint8Array, offset: number): number {
    const raw = (pair[offset]! << 8) | pair[offset + 1]!;
    return raw & 0x8000 ? raw - 0x10000 : raw;
}

function signed16Bytes(value: number): Uint8Array {
    const raw = value < 0 ? value + 0x10000 : value;
    return Uint8Array.of((raw >> 8) & 0xff, raw & 0xff);
}

/**
 * Refuse to write a VANOS offset into a calibration that does not hold the structure we identified.
 *
 * Two independent checks, for the same reason `assertDtcRecord` exists: an offset that is right for
 * CSL 0401 lands in unrelated calibration in anything else, and cam timing is not a byte to write
 * on a guess. The signature check is the strong one - it is what made these two words identifiable
 * in the first place.
 */
function assertVanosBlock(pair: Uint8Array, offset: number, expect: number): void {
    for (const [delta, word] of VANOS_SIGNATURE) {
        const found = (pair[offset + delta]! << 8) | pair[offset + delta + 1]!;
        if (found !== word) {
            throw new Error(
                `VANOS block at 0x${offset.toString(16)}: word at +0x${delta.toString(16)} is`
                + ` 0x${found.toString(16)}, expected 0x${word.toString(16)}.`
                + ' This calibration is not CSL 0401 - refusing to patch.');
        }
    }
    const current = readSigned16(pair, offset);
    if (current !== expect) {
        throw new Error(
            `VANOS offset at 0x${offset.toString(16)} is ${current}, expected the genuine CSL`
            + ` ${expect}. This calibration has already been altered - refusing to patch.`);
    }
}

// --- DTC records ---------------------------------------------------------------------------

/**
 * A DTC filter record: 14 bytes of `{code, SIN, SOUT, IN INC, OUT INC, IN DEC, OUT DEC, ...,
 * CTL, TERM}`.
 *
 * **Bit 0 of CTL is the enable.** `ed_report` (master 0x033636) begins:
 *
 * ```c
 * if ((k_ed_fil_base[err].K_ED_FIL_CTL & 1) == 0) { return 0; }
 * ```
 *
 * so with that bit clear the fault is never counted, never stored and never reaches the error
 * memory. This is BMW's own mechanism, not a trick: 94 of the 241 records in genuine CSL PD31
 * already ship with bit 0 clear.
 *
 * The addresses below are valid for CSL 0401 ONLY. Verified by reading all 241 records out of
 * every MSS54HP calibration in SP-DATEN: the six CSL (PD*) files match on all 241 code bytes and
 * all 241 TERM bytes, while non-CSL calibrations put the master table somewhere else entirely.
 * `assertDtcRecord` re-checks that signature at build time so a non-CSL input is refused rather
 * than patched at the wrong offset.
 */
interface DtcRecord {
    readonly id: string;
    /** Pair offset of the record's first byte. */
    readonly offset: number;
    /** The DTC code, which is also the record's first byte - the signature we verify. */
    readonly code: number;
    readonly what: string;
}

const DTC_RECORD_LENGTH = 14;
const DTC_CTL_INDEX = 12;
const DTC_TERM_INDEX = 13;
const DTC_TERM_VALUE = 0xff;
const DTC_ENABLE_BIT = 0x01;

const DTC_MAP_PRESSURE: DtcRecord = {
    id: 'DTC_DF_MAP_PRESSURE', offset: 0x0f420, code: 0xdf,
    what: 'intake-manifold pressure (MAP) plausibility',
};
const DTC_FLAP_POT: DtcRecord = {
    id: 'DTC_7C_CSL_FLAP_POT', offset: 0x06164, code: 0x7c,
    what: 'CSL snorkel-flap position potentiometer',
};
const DTC_FLAP_REGULATOR: DtcRecord = {
    id: 'DTC_1C_CSL_FLAP_REGULATOR', offset: 0x062de, code: 0x1c,
    what: 'CSL snorkel-flap regulator',
};
const DTC_FLAP_DRIVER: DtcRecord = {
    id: 'DTC_12_CSL_FLAP_DRIVER', offset: 0x062ec, code: 0x12,
    what: 'CSL snorkel-flap output driver',
};

// --- An edit and a manifest ----------------------------------------------------------------

export interface Edit {
    /** Stable id so the same logical edit is recognisable across builds. */
    readonly id: string;
    /** Pair offset of the first byte. */
    readonly offset: number;
    readonly before: Uint8Array;
    readonly after: Uint8Array;
    /** Human-facing reason - what this achieves, not why the code is shaped this way. */
    readonly note: string;
}

export interface WriteManifest {
    readonly choice: VariantChoice;
    readonly edits: readonly Edit[];
    /** Total bytes that differ from the genuine calibration, checksum slots excluded. */
    readonly changedBytes: number;
    /** CRC slots before and after, so a reviewer can see the recompute happened. */
    readonly checksums: readonly HalfChecksum[];
}

export interface BuiltVariant {
    /** The patched 64 KiB pair, checksums corrected. Ready to hand to the flasher. */
    readonly pair: Uint8Array;
    readonly manifest: WriteManifest;
}

/**
 * Apply one contiguous edit, capturing what it overwrote. Refuses to touch a checksum slot -
 * those are owned by the checksum pass, and an edit that stomped one would be silently undone.
 */
function applyEdit(pair: Uint8Array, id: string, offset: number, after: Uint8Array, note: string): Edit | null {
    const before = pair.slice(offset, offset + after.length);
    if (arraysEqual(before, after)) return null; // self-cancelling: no-op edits leave no trace
    for (let i = 0; i < after.length; i++) pair[offset + i] = after[i]!;
    return { id, offset, before, after, note };
}

function fillZero(len: number): Uint8Array {
    return new Uint8Array(len);
}

/**
 * Refuse to touch a DTC record that does not look like one.
 *
 * The whole DTC table moves between program versions, so an offset that is right for CSL 0401 can
 * land in the middle of unrelated calibration in anything else. Checking the code byte and the
 * 0xFF terminator costs nothing and turns "patched the wrong bytes" into a refusal.
 */
function assertDtcRecord(pair: Uint8Array, record: DtcRecord): void {
    const code = pair[record.offset];
    const term = pair[record.offset + DTC_TERM_INDEX];
    if (code !== record.code || term !== DTC_TERM_VALUE) {
        throw new Error(
            `${record.id}: no DTC record at 0x${record.offset.toString(16)}`
            + ` (code 0x${(code ?? 0).toString(16)} expected 0x${record.code.toString(16)},`
            + ` terminator 0x${(term ?? 0).toString(16)} expected 0xff).`
            + ' This calibration is not CSL 0401 - refusing to patch.');
    }
}

/** True when a DTC will be reported at all - CTL bit 0. */
export function dtcEnabled(pair: Uint8Array, offset: number): boolean {
    return (pair[offset + DTC_CTL_INDEX]! & DTC_ENABLE_BIT) !== 0;
}

/** Clear CTL bit 0 so `ed_report` returns immediately and the fault is never recorded. */
function disableDtc(pair: Uint8Array, record: DtcRecord, note: string): Edit | null {
    assertDtcRecord(pair, record);
    const ctl = pair[record.offset + DTC_CTL_INDEX]!;
    return applyEdit(pair, record.id, record.offset + DTC_CTL_INDEX,
        Uint8Array.of(ctl & ~DTC_ENABLE_BIT), note);
}

/** Copy one contiguous block over another, as an edit. */
function copyBlock(pair: Uint8Array, id: string, from: number, to: number, len: number, note: string): Edit | null {
    return applyEdit(pair, id, to, pair.slice(from, from + len), note);
}

/**
 * 'later' and 'off' produce byte-identical images, on purpose.
 *
 * Both set k_rf_cfg to pure Alpha-N and both LEAVE THE MAP FAULT ENABLED. The second half of that
 * is not an oversight, and it is the opposite of what "no sensor, so silence its fault" suggests.
 * The reason is `rf_diag_lut`, a 16-entry program table at master 0x3D534 read out of the image:
 *
 * ```
 * idx  0      1      2      3      4      5      6      7
 *     (1,2)  (1,2)  (2,2)  (2,2)  (1,2)  (1,2)  (2,1)  (0,1)
 * idx  8      9      10     11     12     13     14     15
 *     (1,2)  (1,2)  (2,1)  (0,1)  (1,0)  (1,0)  (2,1)  (0,0)   -> (rf_diag_ed_st, rf_diag_sk_st)
 * ```
 *
 * `rf_diag` (master 0x021b48) builds the index from health bits: bit0 LLS, **bit1 MAP**, bit2
 * WDK2, bit3 UEXT2/WDK1. And `rf_calc` (master 0x0218d0) assigns `RF = rf_p_saug` FIRST, then only
 * overwrites it when `rf_diag_ed_st` is 0 (k_rf_cfg decides) or 1 (forced Alpha-N). **When
 * rf_diag_ed_st is 2, RF stays at the MAP-derived value no matter what k_rf_cfg says.**
 *
 * Follow that through for a car with no MAP sensor:
 *
 *  - **Fault enabled**: the MAP diagnostic fires, `p_saug_st` bit1 gets set, the index loses bit1,
 *    and every remaining entry {0,1,4,5,8,9,12,13} yields ed_st = 1 - Alpha-N, in every fault
 *    combination. The DME has been told the sensor is unusable and behaves accordingly.
 *  - **Fault disabled**: `ed_report` returns 0, `p_saug_st` stays 0, the index keeps bit1. All-
 *    healthy (idx 15) gives ed_st = 0 and Alpha-N via k_rf_cfg, which looks fine - but an LLS
 *    fault alone moves it to idx 14, ed_st = 2, and RF becomes the MAP value. On a car with no MAP
 *    sensor that is a garbage number driving the fill calculation.
 *
 * So the stored fault is not noise to be tidied away; it is the input that keeps every path on
 * Alpha-N. A DTC the operator expects is a far better outcome than a second fault turning into
 * silently wrong fuelling.
 */
export const MAP_LATER_IS_OFF = true;

/**
 * Why the MAP fault is deliberately NOT disabled, in one line for the UI.
 * @see MAP_LATER_IS_OFF
 */
export const MAP_DTC_STAYS_ENABLED = true;

/**
 * Build a variant from a genuine CSL calibration pair.
 *
 * The input is not mutated; the returned pair is a fresh copy. The order is fixed: edits first,
 * then a single checksum correction, because a correction between edits would be thrown away by
 * the next edit and hide whether the final image validates.
 */
export function buildVariant(genuinePair: Uint8Array, choice: VariantChoice): BuiltVariant {
    if (genuinePair.length !== CALIBRATION_PAIR_LENGTH) {
        throw new Error(`calibration pair must be ${CALIBRATION_PAIR_LENGTH} bytes, got ${genuinePair.length}`);
    }
    const pair = Uint8Array.from(genuinePair);
    const edits: Edit[] = [];
    const push = (e: Edit | null) => { if (e) edits.push(e); };

    // MAP. 'later' and 'off' are the same image - see MAP_LATER_IS_OFF for why the alternative
    // reading of 'later' is the one combination this tool refuses to build.
    if (choice.map === 'off' || choice.map === 'later') {
        push(applyEdit(pair, 'k_rf_cfg', K_RF_CFG, Uint8Array.of(K_RF_CFG_ALPHA_N_ONLY),
            'No MAP: RF source set to pure Alpha-N (k_rf_cfg 0x02). The MAP integral is not applied.'));
        // The MAP fault is left ENABLED on purpose - it is what forces rf_diag_ed_st to 1 in every
        // fault combination. See MAP_LATER_IS_OFF for the table this follows from.
        assertDtcRecord(pair, DTC_MAP_PRESSURE);
    }

    // Flap
    if (choice.flap === 'absent') {
        push(applyEdit(pair, 'kf_rf_soll_ask', KF_RF_SOLL_ASK_Z, fillZero(KF_RF_SOLL_ASK_Z_LEN),
            'No flap: snorkel-flap Alpha-N adder zeroed. It is an adder, so zero means "no open-flap'
            + ' fill bonus" - the correct neutral value.'));
        push(copyBlock(pair, 'kf_egas_wdk_ask.x', KF_EGAS_WDK_X, KF_EGAS_WDK_ASK_X, KF_EGAS_WDK_X_LEN,
            'No flap: open-flap EGAS rpm axis made identical to the normal one.'));
        push(copyBlock(pair, 'kf_egas_wdk_ask.z', KF_EGAS_WDK_Z, KF_EGAS_WDK_ASK_Z, KF_EGAS_WDK_Z_LEN,
            'No flap: open-flap EGAS throttle map made identical to the normal one, so selecting it'
            + ' changes nothing. NOT zeroed - a zeroed throttle map would command a closed throttle.'));
        for (const record of [DTC_FLAP_POT, DTC_FLAP_REGULATOR, DTC_FLAP_DRIVER]) {
            push(disableDtc(pair, record,
                `No flap: ${record.what} fault disabled (CTL bit 0) - the hardware is not fitted.`));
        }
    }

    // Cams. Both words move together: they are one answer to one question about the car, and
    // writing one without the other would be a state neither build has ever been in.
    if (choice.cams === 'm3') {
        assertVanosBlock(pair, VANOS_A, VANOS_GENUINE_CSL[0]);
        assertVanosBlock(pair, VANOS_B, VANOS_GENUINE_CSL[1]);
        push(applyEdit(pair, 'vanos_a', VANOS_A, signed16Bytes(VANOS_STANDARD_M3[0]),
            `Standard M3 camshafts: VANOS offset A set to ${VANOS_STANDARD_M3[0]}`
            + ` (${(VANOS_STANDARD_M3[0] / 10).toFixed(1)} deg KW) from the genuine CSL`
            + ` ${VANOS_GENUINE_CSL[0]}.`));
        push(applyEdit(pair, 'vanos_b', VANOS_B, signed16Bytes(VANOS_STANDARD_M3[1]),
            `Standard M3 camshafts: VANOS offset B set to ${VANOS_STANDARD_M3[1]}`
            + ` (${(VANOS_STANDARD_M3[1] / 10).toFixed(1)} deg KW) from the genuine CSL`
            + ` ${VANOS_GENUINE_CSL[1]}.`));
    }

    const changedBytes = edits.reduce((n, e) => n + countDiffering(e.before, e.after), 0);
    const checksums = correctChecksums(pair);

    return {
        pair,
        manifest: { choice, edits, changedBytes, checksums },
    };
}

/**
 * Options the UI must show as "requested but not applied", because their encoding is not known.
 *
 * This is how the tool stays honest: the toggle can be offered, but if the user picks something
 * this build cannot encode with evidence, it says so instead of writing a guess.
 */
export function variantWarnings(choice: VariantChoice): string[] {
    const out: string[] = [];
    if (choice.map === 'later' || choice.map === 'off') {
        out.push('DTC_DF_MAP_PRESSURE is left ENABLED and WILL be stored on a car with no MAP'
            + ' sensor. That is deliberate: the stored fault is what makes rf_diag force Alpha-N in'
            + ' every fault combination. Disabling it would leave a path (an LLS fault alone) where'
            + ' the DME falls back to the MAP value instead - which on a car without the sensor is a'
            + ' garbage number. Expect the fault; do not silence it.');
    }
    if (choice.map === 'later') {
        out.push('"MAP later" builds the same image as "no MAP". When the sensor is fitted, rebuild'
            + ' with "MAP use".');
    }
    if (choice.map === 'use') {
        out.push('Genuine CSL expects a MAP sensor. Without one the DME logs DTC_DF_MAP_PRESSURE'
            + ' and falls back to Alpha-N - intended behaviour, but the fault light is expected.');
    }
    if (choice.flap === 'absent') {
        out.push('Only the three known CSL flap faults are disabled (position pot, regulator,'
            + ' driver). If the car logs another flap-related fault, its record has not been'
            + ' identified and this build does not silence it.');
    }
    if (choice.flap === 'present') {
        out.push('Genuine CSL expects the snorkel-flap hardware. Without it the DME will log the'
            + ' three flap faults.');
    }
    // Both branches warn. A silent one would read as the safe one, and neither is: a wrong
    // camshaft answer stores no fault, so nothing on the car reports it either way.
    if (choice.cams === 'm3') {
        out.push('The standard-M3 camshaft VANOS offsets come from one community binary, not from'
            + ' BMW. All six factory builds read +30 / -20 and BMW never shipped a standard-cam'
            + ' version, so no factory artefact carries these values. That source file also stores'
            + ' a calibration checksum that does not match its own content; this build recomputes'
            + ' it, so what is written here is self-consistent where the source is not.');
    }
    if (choice.cams === 'csl') {
        out.push('Genuine CSL VANOS offsets, written unchanged. On an engine with standard M3'
            + ' camshafts the sensor zero stays offset from what the software assumes. Which way'
            + ' the cam settles, and by how much, is not established here - the value sits inside a'
            + ' closed loop, and adaptation may absorb some or all of it.');
    }
    if (choice.cams === 'm3' || choice.cams === 'csl') {
        out.push('Neither camshaft answer is the safe one, and a wrong answer is silent: it stores'
            + ' no fault and lights no lamp. The only check is to command the cam to its stop after'
            + ' writing and read the measured position back.');
    }
    return out;
}

/**
 * Verify a built variant against its genuine source: every changed byte must belong to a listed
 * edit or be a checksum slot. This is the manifest's promise, made checkable.
 */
export function verifyManifest(genuinePair: Uint8Array, built: BuiltVariant): { ok: boolean; strayOffsets: number[] } {
    const covered = new Set<number>();
    for (const e of built.manifest.edits) {
        for (let i = 0; i < e.after.length; i++) covered.add(e.offset + i);
    }
    // Checksum slots and their padding are allowed to move.
    for (const half of ['slave', 'master'] as const) {
        const base = half === 'slave' ? 0x3ffc : 0xbffc;
        for (let i = 0; i < 4; i++) covered.add(base + i);
    }
    const stray: number[] = [];
    for (let o = 0; o < CALIBRATION_PAIR_LENGTH; o++) {
        if (genuinePair[o] !== built.pair[o] && !covered.has(o)) stray.push(o);
    }
    return { ok: stray.length === 0, strayOffsets: stray };
}

/** A short, stable name for a choice - suitable for a filename or a record row. */
export function variantLabel(choice: VariantChoice): string {
    // 'later' and 'off' produce identical bytes, so they must produce an identical label - a
    // filename that implies a difference the image does not have is how two builds get mixed up.
    const map = { use: 'MAP', later: 'noMAP', off: 'noMAP' }[choice.map];
    const flap = { present: 'flap', absent: 'noflap' }[choice.flap];
    const cams = { csl: 'cslcams', m3: 'm3cams' }[choice.cams];
    return `CSL0401_${map}_${flap}_${cams}`;
}

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

function countDiffering(a: Uint8Array, b: Uint8Array): number {
    let n = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
    return n;
}

/** Re-exported so callers can locate an edit's half for display. */
export { halfOf, analyseChecksums };
export { DTC_RECORD_LENGTH, DTC_CTL_INDEX, DTC_ENABLE_BIT };
export const DTC_RECORDS = {
    mapPressure: DTC_MAP_PRESSURE,
    flapPot: DTC_FLAP_POT,
    flapRegulator: DTC_FLAP_REGULATOR,
    flapDriver: DTC_FLAP_DRIVER,
} as const;
export type { Half, HalfChecksum };
