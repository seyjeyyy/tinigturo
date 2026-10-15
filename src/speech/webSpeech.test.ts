import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onDeviceCheckCrashed, onDeviceStatus, resetOnDeviceCheck } from './webSpeech';

const w = window as unknown as { webkitSpeechRecognition?: unknown };

describe('on-device availability check', () => {
  let available: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    resetOnDeviceCheck();
    available = vi.fn(async () => 'available');
    w.webkitSpeechRecognition = Object.assign(function Recognition() {}, { available });
  });
  afterEach(() => {
    delete w.webkitSpeechRecognition;
    resetOnDeviceCheck();
  });

  it('reports unsupported when the browser has no check', async () => {
    delete w.webkitSpeechRecognition;
    expect(await onDeviceStatus('en-US')).toBe('unsupported');
  });

  it('checks once and caches the result', async () => {
    expect(await onDeviceStatus('en-US')).toBe('available');
    expect(await onDeviceStatus('en-US')).toBe('available');
    expect(available).toHaveBeenCalledTimes(1);
  });

  it('after a check that crashed the page, never checks automatically again', async () => {
    let t = 1_000_000;
    // Simulate a page that crashed mid-check: the marker was written but never cleared.
    localStorage.setItem('tinigturo:ondevice-probe', JSON.stringify({ inFlight: { locale: 'en-US', at: t }, results: {} }));
    t += 60_000;
    expect(await onDeviceStatus('en-US', () => t)).toBe('unavailable');
    expect(onDeviceCheckCrashed('en-US')).toBe(true);
    t += 30 * 24 * 3600_000;
    expect(await onDeviceStatus('en-US', () => t)).toBe('unavailable');
    expect(available).not.toHaveBeenCalled();
    // A manual "Check again" clears the guard.
    resetOnDeviceCheck();
    expect(await onDeviceStatus('en-US', () => t)).toBe('available');
  });

  it('treats a failing check as unavailable', async () => {
    available.mockRejectedValueOnce(new Error('boom'));
    expect(await onDeviceStatus('en-US')).toBe('unavailable');
  });
});
