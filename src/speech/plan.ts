import type { UnassessedReason } from '../assessment/scoring';
import { LANGUAGES, type LanguageCode } from '../text/language';
import type { SpeechCapabilities } from './capabilities';
import type { SpeechProvider } from './types';
import { VoskProvider } from './vosk';
import { WebSpeechProvider } from './webSpeech';

export type RecognitionPlan =
  | { kind: 'on_device'; engine: 'vosk' | 'web_speech_local'; locale: string }
  | { kind: 'cloud'; engine: 'web_speech_cloud'; locale: string }
  | { kind: 'none'; reason: UnassessedReason; explanation: string };

export interface PlanInput {
  language: LanguageCode;
  capabilities: SpeechCapabilities;
  online: boolean;
  /** The adult responsible chose to allow the browser's online speech service. */
  allowCloudRecognition: boolean;
}

/**
 * Chooses how (and whether) to follow the reader's voice. On-device engines are
 * preferred. Cloud recognition is used only when explicitly allowed, and is never a
 * silent fallback. Unverified languages are never assessed.
 */
export function chooseRecognitionPlan({ language, capabilities, online, allowCloudRecognition }: PlanInput): RecognitionPlan {
  const info = LANGUAGES[language];
  if (!info.assessmentVerified) {
    return {
      kind: 'none',
      reason: 'language_not_verified',
      explanation: `Word checking for ${info.label} is not available yet. Your reading and recording are still saved.`,
    };
  }
  const locale = capabilities.onDeviceRecognition.locale;
  if (capabilities.wasmEngine.enabled && capabilities.wasmEngine.modelDownloaded) {
    return { kind: 'on_device', engine: 'vosk', locale };
  }
  if (capabilities.onDeviceRecognition.status === 'available') {
    return { kind: 'on_device', engine: 'web_speech_local', locale };
  }
  if (capabilities.onlineRecognition && online && allowCloudRecognition) {
    return { kind: 'cloud', engine: 'web_speech_cloud', locale };
  }
  if (capabilities.onlineRecognition && !online && allowCloudRecognition) {
    return {
      kind: 'none',
      reason: 'recognition_unavailable',
      explanation: 'Word checking needs the internet on this device right now. Your reading and recording are still saved.',
    };
  }
  return {
    kind: 'none',
    reason: 'recognition_unavailable',
    explanation: 'Word checking is not available on this device. Your reading and recording are still saved.',
  };
}

export function createProvider(plan: RecognitionPlan, language: LanguageCode): SpeechProvider | null {
  if (plan.kind === 'none') return null;
  if (plan.kind === 'on_device' && plan.engine === 'vosk') return new VoskProvider(language);
  return new WebSpeechProvider(plan.kind === 'on_device' ? 'on_device' : 'cloud');
}

export function describePlan(plan: RecognitionPlan): string {
  if (plan.kind === 'none') return plan.explanation;
  if (plan.kind === 'on_device') return 'Word checking runs on this device. Your voice is not sent anywhere.';
  return 'Word checking uses the browser’s online speech service. Your voice is sent to the browser maker (for example Google for Chrome or Apple for Safari) while you read.';
}
