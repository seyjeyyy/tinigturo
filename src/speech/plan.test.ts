import { describe, expect, it } from 'vitest';
import { chooseRecognitionPlan } from './plan';
import type { SpeechCapabilities } from './capabilities';

function caps(overrides: Partial<SpeechCapabilities> = {}): SpeechCapabilities {
  return {
    secureContext: true,
    microphone: 'prompt',
    recording: { supported: true, mimeType: 'audio/webm' },
    onlineRecognition: true,
    onDeviceRecognition: { locale: 'en-US', status: 'unavailable' },
    wasmEngine: { enabled: false, modelConfigured: false, modelDownloaded: false },
    speechSynthesis: { supported: true, voiceAvailable: true },
    ...overrides,
  };
}

describe('chooseRecognitionPlan', () => {
  it('prefers on-device recognition', () => {
    const plan = chooseRecognitionPlan({ language: 'en', capabilities: caps({ onDeviceRecognition: { locale: 'en-US', status: 'available' } }), online: true, allowCloudRecognition: true });
    expect(plan).toEqual({ kind: 'on_device', engine: 'web_speech_local', locale: 'en-US' });
  });

  it('never silently falls back to cloud processing', () => {
    const plan = chooseRecognitionPlan({ language: 'en', capabilities: caps(), online: true, allowCloudRecognition: false });
    expect(plan.kind).toBe('none');
  });

  it('uses cloud recognition only when explicitly allowed and online', () => {
    expect(chooseRecognitionPlan({ language: 'en', capabilities: caps(), online: true, allowCloudRecognition: true }).kind).toBe('cloud');
    const offline = chooseRecognitionPlan({ language: 'en', capabilities: caps(), online: false, allowCloudRecognition: true });
    expect(offline).toMatchObject({ kind: 'none', reason: 'recognition_unavailable' });
  });

  it('does not assess Filipino until an engine is verified, even if one exists', () => {
    const plan = chooseRecognitionPlan({ language: 'fil', capabilities: caps({ onDeviceRecognition: { locale: 'fil-PH', status: 'available' } }), online: true, allowCloudRecognition: true });
    expect(plan).toMatchObject({ kind: 'none', reason: 'language_not_verified' });
  });

  it('uses the downloaded WASM engine when enabled', () => {
    const plan = chooseRecognitionPlan({ language: 'en', capabilities: caps({ wasmEngine: { enabled: true, modelConfigured: true, modelDownloaded: true } }), online: false, allowCloudRecognition: false });
    expect(plan).toMatchObject({ kind: 'on_device', engine: 'vosk' });
  });
});
