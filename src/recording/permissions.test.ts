import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectDeviceContext, microphoneRecoverySteps, queryMicrophonePermission } from './permissions';

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

afterEach(() => vi.unstubAllGlobals());

describe('microphone permission', () => {
  it('reads the permission without asking, and reports unknown where the browser cannot tell', async () => {
    vi.stubGlobal('navigator', { permissions: { query: async () => ({ state: 'denied' }) } });
    expect(await queryMicrophonePermission()).toBe('denied');
    vi.stubGlobal('navigator', { permissions: { query: async () => { throw new TypeError('microphone is not a valid permission name'); } } });
    expect(await queryMicrophonePermission()).toBe('unknown');
    vi.stubGlobal('navigator', {});
    expect(await queryMicrophonePermission()).toBe('unknown');
  });

  it('recognizes the device and whether it runs as an installed app', () => {
    expect(detectDeviceContext({ userAgent: ANDROID, referrer: 'android-app://com.tinigturo.app/' })).toEqual({ platform: 'android', installed: true });
    expect(detectDeviceContext({ userAgent: ANDROID })).toEqual({ platform: 'android', installed: false });
    expect(detectDeviceContext({ userAgent: IPHONE, standalone: true })).toEqual({ platform: 'ios', installed: true });
    expect(detectDeviceContext({ userAgent: IPAD_DESKTOP_UA, maxTouchPoints: 5 }).platform).toBe('ios');
    expect(detectDeviceContext({ userAgent: WINDOWS, displayModeStandalone: true })).toEqual({ platform: 'desktop', installed: true });
  });

  it('never tells installed-app users to use an address bar they do not have', () => {
    for (const platform of ['android', 'ios', 'desktop'] as const) {
      const installed = microphoneRecoverySteps({ platform, installed: true }).join(' ');
      expect(installed).not.toMatch(/web address|address bar/i);
      const browser = microphoneRecoverySteps({ platform, installed: false }).join(' ');
      expect(browser).toMatch(/web address|address bar/i);
    }
  });
});
