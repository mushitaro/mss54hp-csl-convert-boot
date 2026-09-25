/**
 * The preview's first-run notice: what it sends, when, what for and who can see it - confirmed by
 * the owner before it sends any of it.
 *
 * ## Why it is here and not on m3
 *
 * The notice used to be a page on m3.tsunagi.app that a first visit passed through before the app
 * was given its session. The operator decided (2026-09-24) that it belongs in the app, as TUNER's
 * disclaimer does: one screen fewer between the owner and the tool, and the notice is shown by the
 * code that does the sending. m3 keeps no record of it any more; this browser does.
 *
 * ## The rule
 *
 * Nothing leaves the device until the owner has pressed 「確認して続ける」 (Confirm and continue) in
 * the dialog (`PreviewNotice` in cloud.tsx). The dialog is one half of that and is not trusted to be
 * the whole: the send paths ask `noticeAcknowledged()` themselves. UPLOAD refuses (upload.ts), a
 * failure record waits in the outbox the way it waits for a signal (sync.ts), and nothing flushes
 * the outbox before then.
 *
 * ## One key, versioned
 *
 * `preview-notice:v1` in localStorage, holding when it was confirmed. The version is in the key so
 * that a notice which says something new - a new kind of record, a new destination - can be put in
 * front of every owner again by moving to `v2`, rather than being taken as read because an older
 * one was.
 *
 * Storage that is missing or throws (a private window, site data blocked) counts as not confirmed:
 * the dialog is shown, and a confirmation given then holds for this page only. The alternative -
 * reading a failure as consent - would send from exactly the browsers that can never remember the
 * answer.
 *
 * Production never shows it and never asks: it sends nothing, so there is nothing to confirm.
 */
import { isPreviewBuild } from './owner-sync';

/** The localStorage key. Change the version when what the notice says changes. */
export const NOTICE_KEY = 'preview-notice:v1';

/** Confirmed on this page when storage could not keep it. Never persisted, never read by another tab. */
let acknowledgedHere = false;

/** Whether the owner has confirmed the notice in this browser - or on this page, if storage failed. */
export function noticeAcknowledged(): boolean {
    if (acknowledgedHere) return true;
    try {
        return localStorage.getItem(NOTICE_KEY) !== null;
    } catch {
        return false;
    }
}

/** The owner confirmed the notice. Recorded for next time where storage allows; never throws. */
export function acknowledgeNotice(): void {
    acknowledgedHere = true;
    try {
        localStorage.setItem(NOTICE_KEY, new Date().toISOString());
    } catch {
        // Nowhere to keep it: confirmed for this page, and asked again on the next launch.
    }
}

/** Whether this page must show the notice before anything else: the preview, not yet confirmed. */
export function noticeRequired(): boolean {
    return isPreviewBuild() && !noticeAcknowledged();
}

/** A send refused because the notice has not been confirmed. Nothing was sent. */
export class NoticeNotAcknowledged extends Error {
    constructor() {
        super('The notice has not been confirmed in this browser, so nothing was sent.');
        this.name = 'NoticeNotAcknowledged';
    }
}
