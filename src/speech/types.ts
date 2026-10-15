import type { EngineInfo } from '../assessment/scoring';

/**
 * Engine-independent speech-recognition interface. The reading UI and the aligner
 * only see segment updates: a segment's text may be revised until it is final.
 */
export interface SegmentUpdate {
  segmentId: string;
  text: string;
  isFinal: boolean;
}

export type SpeechErrorKind =
  | 'not_allowed'
  | 'no_microphone'
  | 'network'
  | 'language_unsupported'
  | 'service_unavailable'
  | 'model_missing'
  | 'unknown';

export interface SpeechHandlers {
  onSegment(update: SegmentUpdate): void;
  /** Whether audio is currently being recognized (false while restarting or paused). */
  onListeningChange(listening: boolean): void;
  /** Recognition cannot continue. Recording continues without word following. */
  onFatalError(kind: SpeechErrorKind, message: string): void;
}

export interface SpeechStartOptions {
  locale: string;
  /** The microphone stream used for recording, for engines that can share it. */
  stream: MediaStream | null;
  /** Passage words, for engines that accept a vocabulary hint. */
  phraseHints?: string[];
}

export interface SpeechProvider {
  readonly engine: EngineInfo;
  readonly supportsPartialResults: boolean;
  start(options: SpeechStartOptions, handlers: SpeechHandlers): Promise<void>;
  /** Stop listening but keep the session (reader pressed Pause). */
  pause(): void;
  resume(): void;
  /** Close the current segment so later speech starts a new one. */
  newSegment(): void;
  /** Flush final results and stop. */
  stop(): Promise<void>;
  dispose(): void;
}
