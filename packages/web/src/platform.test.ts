/**
 * Where the app will open a cable.
 *
 * The rule is not a preference about form factors. On Windows, making a K+DCAN cable visible to
 * WebUSB means rebinding it away from `ftdibus.sys`, which removes the COM port and breaks INPA,
 * Tool32 and ISTA - so a desktop user who gets this working has broken the other BMW tools on that
 * machine and will not connect the two events. Android has no VCP driver to displace, and WebUSB is
 * the only way to reach a USB cable there at all.
 *
 * The tests cover both halves of the enforcement, because the important one is easy to leave out:
 * a disabled button is a UI state, and the refusal has to hold at the one function that can reach a
 * device regardless of what any screen believes.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { isAndroid, webUsbAvailable, linkBlock } from './platform';
import { openFtdiLink, LinkNotSupported } from './usb';

/** Replace `navigator` for one test. jsdom is not in play here - this suite runs in node. */
function pretend(nav: Record<string, unknown>): void {
    vi.stubGlobal('navigator', nav);
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('deciding the platform', () => {
    it('believes Chromium structured data over the user agent string', () => {
        // `userAgentData.platform` is not subject to the UA-freezing games, so it wins when present.
        pretend({ userAgentData: { platform: 'Android' }, userAgent: 'Mozilla/5.0 (Windows NT 10.0)' });
        expect(isAndroid()).toBe(true);

        pretend({ userAgentData: { platform: 'Windows' }, userAgent: 'Mozilla/5.0 (Linux; Android 14)' });
        expect(isAndroid()).toBe(false);
    });

    it('falls back to the user agent when the structured answer is absent', () => {
        pretend({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/138' });
        expect(isAndroid()).toBe(true);

        pretend({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/138' });
        expect(isAndroid()).toBe(false);
    });
});

describe('why the link is unavailable', () => {
    /**
     * The order matters, and it is the whole point of reporting a reason rather than a boolean.
     *
     * Desktop Chrome HAS WebUSB. Answering "no WebUSB" there would send someone looking for a
     * browser flag, and what they would actually find is the driver rebind that breaks INPA. The
     * platform answer has to come first so the message can be about the platform.
     */
    it('names the platform on a desktop that does have WebUSB', () => {
        pretend({ userAgentData: { platform: 'Windows' }, userAgent: 'Chrome', usb: {} });
        expect(webUsbAvailable()).toBe(true);
        expect(linkBlock()).toBe('not-android');
    });

    it('names WebUSB only when the platform is right and the API is missing', () => {
        pretend({ userAgentData: { platform: 'Android' }, userAgent: 'Chrome' });
        expect(linkBlock()).toBe('no-webusb');
    });

    it('allows it on Android with WebUSB, and nowhere else', () => {
        pretend({ userAgentData: { platform: 'Android' }, userAgent: 'Chrome', usb: {} });
        expect(linkBlock()).toBeNull();
    });
});

describe('the refusal that is not a UI state', () => {
    /**
     * The hub disables CONNECT, but a disabled control is something a re-render, a stale memo or a
     * future caller can get wrong. `openFtdiLink` is the only function in the app that can reach a
     * device, so the guard belongs on its first line - before a chooser appears and invites someone
     * to go and rebind a driver.
     */
    it('throws before touching navigator.usb on a blocked platform', async () => {
        let touched = false;
        pretend({
            userAgentData: { platform: 'Windows' },
            userAgent: 'Chrome',
            get usb() { touched = true; return { getDevices: async () => [] }; },
        });

        await expect(openFtdiLink()).rejects.toBeInstanceOf(LinkNotSupported);
        expect(touched, 'the device API must not be reached at all').toBe(false);
    });

    it('carries the reason, so the screen can say the right thing', async () => {
        pretend({ userAgentData: { platform: 'macOS' }, userAgent: 'Chrome', usb: {} });
        const error = await openFtdiLink().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(LinkNotSupported);
        expect((error as LinkNotSupported).reason).toBe('not-android');
    });
});
