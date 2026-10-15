import { featureFlags } from '../backend/config';
import { selectAudioFormat } from '../recording/recorder';
import { LANGUAGES, type LanguageCode } from '../text/language';
import { configuredModels, isModelDownloaded } from './models';
import { getWebSpeechConstructor, onDeviceStatus, type OnDeviceStatus } from './webSpeech';

export type MicrophonePermission = 'granted' | 'prompt' | 'denied' | 'unsupported' | 'unknown';

export interface SpeechCapabilities {
  secureContext: boolean;
  microphone: MicrophonePermission;
  recording: { supported: boolean; mimeType: string | null };
  /** The browser exposes speech recognition (online, processed by the browser vendor). */
  onlineRecognition: boolean;
  /** Browser on-device recognition for the language's preferred locale. */
  onDeviceRecognition: { locale: string; status: OnDeviceStatus };
  /** Optional WASM engine (experimental). */
  wasmEngine: { enabled: boolean; modelConfigured: boolean; modelDownloaded: boolean };
  speechSynthesis: { supported: boolean; voiceAvailable: boolean };
}

export async function microphonePermission(): Promise<MicrophonePermission> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return 'unsupported';
  try {
    const status = await navigator.permissions?.query({ name: 'microphone' as PermissionName });
    if (!status) return 'unknown';
    return status.state as MicrophonePermission;
  } catch {
    return 'unknown';
  }
}

export function voicesFor(language: LanguageCode): SpeechSynthesisVoice[] {
  if (typeof speechSynthesis === 'undefined') return [];
  const prefix = language === 'fil' ? ['fil', 'tl'] : ['en'];
  return speechSynthesis.getVoices().filter((v) => prefix.some((p) => v.lang.toLowerCase().startsWith(p)));
}

/** Detects what this browser and device can do for a passage language. */
export async function detectSpeechCapabilities(language: LanguageCode): Promise<SpeechCapabilities> {
  const locale = LANGUAGES[language].speechLocales[0];
  const mimeType = selectAudioFormat();
  const models = configuredModels();
  const model = models.find((m) => m.language === language);
  return {
    secureContext: typeof window !== 'undefined' && window.isSecureContext,
    microphone: await microphonePermission(),
    recording: { supported: mimeType !== null, mimeType },
    onlineRecognition: getWebSpeechConstructor() !== null,
    // Only languages with verified assessment can use on-device recognition, so others are not probed.
    onDeviceRecognition: { locale, status: LANGUAGES[language].assessmentVerified ? await onDeviceStatus(locale) : 'unavailable' },
    wasmEngine: {
      enabled: featureFlags.voskEnabled && typeof AudioWorkletNode !== 'undefined' && typeof WebAssembly !== 'undefined',
      modelConfigured: Boolean(model),
      modelDownloaded: model ? await isModelDownloaded(language) : false,
    },
    speechSynthesis: { supported: typeof speechSynthesis !== 'undefined', voiceAvailable: voicesFor(language).length > 0 },
  };
}
