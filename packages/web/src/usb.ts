/**
 * The only file that touches `navigator.usb`.
 *
 * `WebUsbFtdiTransport` deliberately takes a device rather than reaching for the global, so this is
 * where the browser API lives and where a chooser cancellation is told apart from a failure. The
 * distinction matters: dismissing the picker is somebody changing their mind, and rendering it as a
 * red error line on a tool that flashes ECUs teaches people to ignore red error lines.
 */
import { WebUsbFtdiTransport, FTDI_VENDOR_ID, type UsbDeviceLike } from 'dme-flash';
import { linkBlock } from './platform';

export class UsbCancelled extends Error {
    constructor() {
        super('device chooser dismissed');
        this.name = 'UsbCancelled';
    }
}

/**
 * Refused when this platform must not drive a cable.
 *
 * Thrown, and thrown HERE, before `navigator.usb` is touched at all. The hub disables its button
 * too, but a disabled button is a UI state that a re-render, a stale memo or a future caller can
 * get wrong; this is the single function in the app that can reach a device, so a refusal at its
 * first line is a property of the code rather than of the screen.
 */
export class LinkNotSupported extends Error {
    constructor(readonly reason: NonNullable<ReturnType<typeof linkBlock>>) {
        super(`this platform cannot open a K+DCAN cable (${reason})`);
        this.name = 'LinkNotSupported';
    }
}

export interface OpenLink {
    readonly transport: WebUsbFtdiTransport;
    readonly close: () => Promise<void>;
}

/**
 * Pick a cable and open it at 9600.
 *
 * A device this origin has already been granted is preferred over showing the chooser again -
 * WebUSB permissions persist, and a returning user should not have to find the same cable twice.
 * That lookup has to happen before `requestDevice`, while the transient user activation from the
 * tap is still alive.
 */
export async function openFtdiLink(): Promise<OpenLink> {
    // Before anything else. On Windows this path only works once the cable has been rebound away
    // from ftdibus.sys, which removes the COM port and breaks INPA / Tool32 / ISTA - so the useful
    // moment to refuse is before a chooser appears and invites someone to go and do that.
    const blocked = linkBlock();
    if (blocked) throw new LinkNotSupported(blocked);
    const usb = navigator.usb;

    const granted = (await usb.getDevices()).filter((d) => d.vendorId === FTDI_VENDOR_ID);
    let device: USBDevice;
    if (granted[0]) {
        device = granted[0];
    } else {
        try {
            device = await usb.requestDevice({ filters: [{ vendorId: FTDI_VENDOR_ID }] });
        } catch (error) {
            // NotFoundError is what a dismissed chooser rejects with. Anything else is real.
            if (error instanceof Error && error.name === 'NotFoundError') throw new UsbCancelled();
            throw error;
        }
    }

    const transport = new WebUsbFtdiTransport(device as unknown as UsbDeviceLike);
    const onDisconnect = (event: USBConnectionEvent): void => {
        if (event.device === device) transport.markDeviceGone();
    };
    usb.addEventListener('disconnect', onDisconnect);

    try {
        await transport.open();
    } catch (error) {
        usb.removeEventListener('disconnect', onDisconnect);
        throw error;
    }

    return {
        transport,
        close: async () => {
            usb.removeEventListener('disconnect', onDisconnect);
            await transport.close();
        },
    };
}

/** Offer a captured image as a file. The only thing this app ever writes to the phone. */
export function downloadBytes(bytes: Uint8Array, filename: string): void {
    const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    // Revoking immediately can cancel the download on some Android builds; one frame is enough.
    requestAnimationFrame(() => URL.revokeObjectURL(url));
}

/**
 * Offer the session log as a text file.
 *
 * The log is the other half of the evidence - what the DME answered, in order, with the timings -
 * and it has now twice left a garage as a photograph of a phone screen, because the upload was the
 * only way off the device. An upload needs a network and a signed-in session. This needs neither, so
 * the record of a session survives even when the session is the kind worth recording.
 *
 * CRLF: the likeliest place these are opened is Windows Notepad, where LF alone is one long line.
 */
export function downloadLog(lines: readonly string[], filename: string): void {
    downloadBytes(new TextEncoder().encode(lines.join('\r\n')), filename);
}

/** The same stamp shape as the capture, so a log and the bin it belongs to sort together. */
export function logFilename(when: Date, practice = false): string {
    const stamp = when.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `${practice ? 'PRACTICE_NOT-A-CAR_' : ''}MSS54HP_log_${stamp}.txt`;
}

/**
 * A backup filename that says what the file is without opening it.
 *
 * Name the outcome, not just the subject. Two of these matter and for the same reason - the file
 * is dangerous precisely because it looks identical to the real thing:
 *
 *  - a capture whose two passes disagreed is not a backup and must not be filed as one, and
 *  - a capture taken in practice is of a simulator, and would restore nothing.
 *
 * The prefix leads rather than trails so it survives a truncating file list.
 */
export function backupFilename(
    programNumber: string, verified: boolean, when: Date, practice = false,
): string {
    const stamp = when.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outcome = verified ? 'verified' : 'UNVERIFIED';
    return `${practice ? 'PRACTICE_NOT-A-CAR_' : ''}MSS54HP_${programNumber}_${outcome}_${stamp}.bin`;
}
