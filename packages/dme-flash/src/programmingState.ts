/** Read-only interpretation of resident 2E0C/2D16's 64-word AIF counter.
 * Reject noncanonical histories rather than inferring a repair to vehicle data. */
export function inspectProgrammingCounter(bytes: Uint8Array) {
    if (bytes.length !== 128) throw new Error('programming counter must contain 128 bytes');
    const words = Array.from({ length: 64 }, (_, i) => bytes[2 * i]! << 8 | bytes[2 * i + 1]!);
    const firstFree = words.indexOf(0xffff);
    const used = firstFree < 0 ? 64 : firstFree;
    if (words.slice(used).some(w => w !== 0xffff)
        || words.slice(0, Math.max(0, used - 1)).some(w => w !== 0)) {
        throw new Error('noncanonical programming counter; inspect the live backup before writing');
    }
    const last = used ? words[used - 1]! : 0;
    if (![0, 0x00ff, 0xff00].includes(last)) {
        throw new Error('unknown or FAST ENTRY programming marker; no ordinary flash is safe to start');
    }
    return { used, remaining: 64 - used, mode: last === 0x00ff ? 'calibration' as const
        : last === 0xff00 ? 'program' as const : 'normal' as const };
}

export function requireProgrammingCounter(bytes: Uint8Array, kind: 'program' | 'calibration', enforceMode = true) {
    const state = inspectProgrammingCounter(bytes);
    // 2D16 reserves the final four words for special operations. Keep four more
    // words for the requested pair/Finish transitions; never recycle SA1 here.
    const minimum = kind === 'program' ? 8 : state.mode === 'normal' ? 10 : 9;
    if (state.remaining < minimum) throw new Error('insufficient programming counter capacity; nothing erased');
    if (enforceMode && state.mode !== 'normal' && state.mode !== kind) {
        throw new Error(`DME remains in ${state.mode} programming mode; cannot start ${kind}; nothing erased`);
    }
    return state;
}
