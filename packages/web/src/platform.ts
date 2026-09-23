/**
 * Where this app is allowed to drive a cable, and why that is one platform only.
 *
 * ## The reason is not "it was designed for phones"
 *
 * On Windows, Chromium claims USB devices through WinUSB. A K+DCAN cable is bound to
 * `ftdibus.sys`, so for WebUSB to see it at all the driver has to be rebound - with Zadig or
 * similar - and **that removes the COM port and breaks INPA, Tool32 and ISTA**. A desktop user who
 * gets this app working has broken the other BMW tools on that machine, and will not connect the
 * two events. The same reasoning applies to macOS and Linux in weaker form: nothing there has been
 * tested against a car, and this app's only backend is the FTDI vendor protocol.
 *
 * None of that exists on Android. There is no VCP driver to displace and no other BMW tool sharing
 * the cable, and WebUSB is not merely permitted there - it is the only option, because Chrome for
 * Android's `navigator.serial` enumerates Bluetooth RFCOMM only and a USB cable never appears in
 * its picker.
 *
 * So the block is a safety property, not a product decision, and it is enforced in `openFtdiLink`
 * rather than only on the button. A disabled control is a UI state; a refusal at the one function
 * that touches `navigator.usb` is a property of the code.
 *
 * ## What this is not
 *
 * It is not a security boundary. A user agent string can be changed, and someone determined to run
 * this on a desktop can. The guard exists so that nobody does it **by accident** - which is the
 * only way it was ever going to happen.
 *
 * PRACTICE is deliberately still available everywhere. It builds telegrams against a simulated DME
 * inside `withSimulatedEcu` and cannot reach `navigator.usb` by any path, so there is nothing for
 * this gate to protect. Removing it would only stop people reading the flow before they are at the
 * car, which is the one place it is worth reading.
 */

/** Why the hardware link is unavailable, or `null` when it is available. */
export type LinkBlock = 'not-android' | 'no-webusb';

/**
 * True on Android.
 *
 * `userAgentData.platform` is Chromium's own structured answer and is not subject to the UA-string
 * freezing games; the regex is the fallback for engines that do not expose it. Asked by name rather
 * than by capability because no capability distinguishes the case: desktop Chrome has WebUSB too,
 * and it is precisely the platform where using it is harmful.
 */
export function isAndroid(): boolean {
    if (typeof navigator === 'undefined') return false;
    const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
    if (uaData?.platform) return uaData.platform === 'Android';
    return /android/i.test(navigator.userAgent);
}

export function webUsbAvailable(): boolean {
    return typeof navigator !== 'undefined' && 'usb' in navigator && navigator.usb !== undefined;
}

/**
 * Whether this browser may open a cable, and what stops it.
 *
 * Platform first, because it is the answer that matters: a desktop with WebUSB is the dangerous
 * case, and reporting "no WebUSB" there would send someone looking for a browser flag that would
 * make things worse if they found it.
 */
export function linkBlock(): LinkBlock | null {
    if (!isAndroid()) return 'not-android';
    if (!webUsbAvailable()) return 'no-webusb';
    return null;
}
