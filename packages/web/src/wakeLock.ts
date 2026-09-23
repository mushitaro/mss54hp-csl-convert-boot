/**
 * Keeping the screen on while the link is working.
 *
 * ## Why this is not a comfort feature
 *
 * The WebUSB transport drains the FT232R's 256-byte RX FIFO from a loop on this thread. At 9600
 * that FIFO is about 267 ms of headroom, and the shortest useful operation here runs for an hour.
 * When Android blanks the screen the tab is backgrounded, and a backgrounded tab is throttled and
 * may be frozen outright - at which point nothing is servicing the endpoint and the chip overruns.
 * So this does not merely slow the transfer down, it corrupts it.
 *
 * The reader itself no longer waits on a timer - it parks and is woken by the pump - so the
 * measured 946 ms timer clamp is not the mechanism any more. What remains is simpler and not
 * fixable from here: the pump is main-thread work, and a page the system has stopped running does
 * no work at all.
 *
 * So the screen staying on is a precondition of the read completing, not a convenience. It is
 * requested for exactly as long as something is running, because a lock held while idle is a lock
 * the operator did not ask for and a battery cost with nothing to show for it.
 *
 * ## What it cannot promise
 *
 * The API is absent on some browsers, the request is refused when the page is not visible, and the
 * lock is released by the system whenever the page is hidden - by the power button, by another app,
 * by anything. None of those are errors this app can fix, so none of them fail anything: the lock
 * is best effort throughout, and `App` already detects and reports the case where the transfer
 * really did run in the background. A held lock is not evidence that it never happened.
 */
import { useEffect, useRef } from 'react';

/** The bit of the Screen Wake Lock API this uses, declared so no DOM lib version is required. */
interface WakeLockSentinelLike {
    released: boolean;
    release(): Promise<void>;
    addEventListener(type: 'release', listener: () => void): void;
}
interface WakeLockLike {
    request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

function wakeLockApi(): WakeLockLike | null {
    if (typeof navigator === 'undefined') return null;
    const lock = (navigator as { wakeLock?: WakeLockLike }).wakeLock;
    return lock && typeof lock.request === 'function' ? lock : null;
}

export function wakeLockSupported(): boolean {
    return wakeLockApi() !== null;
}

/**
 * Hold a screen wake lock while `active`.
 *
 * Re-acquires when the page becomes visible again, because the system drops the lock on hide and
 * does not give it back on its own - without that, backgrounding the app once disarms the
 * protection for the rest of a run that may have fifty minutes left.
 */
export function useScreenWakeLock(active: boolean): void {
    const sentinel = useRef<WakeLockSentinelLike | null>(null);

    useEffect(() => {
        const api = wakeLockApi();
        if (!api) return;

        let disposed = false;

        const acquire = async (): Promise<void> => {
            if (disposed || !active) return;
            if (sentinel.current && !sentinel.current.released) return;
            if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
            try {
                const held = await api.request('screen');
                if (disposed || !active) { void held.release().catch(() => {}); return; }
                sentinel.current = held;
                // The system releases on hide. Dropping the reference here keeps `acquire` honest
                // about whether one is actually held.
                held.addEventListener('release', () => {
                    if (sentinel.current === held) sentinel.current = null;
                });
            } catch {
                // Refused - not visible, battery saver, policy. Best effort, and the transfer's
                // own background detection is what actually reports a run that went dark.
            }
        };

        const release = (): void => {
            const held = sentinel.current;
            sentinel.current = null;
            if (held && !held.released) void held.release().catch(() => {});
        };

        const onVisibility = (): void => {
            if (document.visibilityState === 'visible') void acquire();
        };

        if (active) {
            void acquire();
            document.addEventListener('visibilitychange', onVisibility);
        } else {
            release();
        }

        return () => {
            disposed = true;
            document.removeEventListener('visibilitychange', onVisibility);
            release();
        };
    }, [active]);
}
