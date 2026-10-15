import { StreamingAligner, type AlignmentSnapshot } from '../alignment/aligner';
import { assessAttempt, unassessedSummary, type AttemptTiming } from '../assessment/scoring';
import type { LocalReward, ReadingSessionRecord, RecognitionInfo, StoryVersionRecord } from '../domain/types';
import { StorageFullError } from '../db/errors';
import type { TinigDb } from '../db/localDb';
import { appendAudioChunk, checkpointSession, discardSession, finalizeSession, startSession } from '../data/sessions';
import { SessionClock } from '../recording/clock';
import {
  INITIAL_RECORDING_STATE, recordingError, recordingReducer,
  type PauseReason, type RecordingError, type RecordingEvent, type RecordingState,
} from '../recording/machine';
import type { RecorderCallbacks } from '../recording/recorder';
import type { RecognitionPlan } from '../speech/plan';
import type { SpeechProvider } from '../speech/types';
import type { Passage } from '../text/tokenize';

export interface RecorderLike {
  readonly mimeType: string;
  readonly mediaStream: MediaStream | null;
  acquire(): Promise<MediaStream>;
  start(callbacks: RecorderCallbacks): void;
  pause(): void;
  resume(): void;
  stop(): Promise<Blob | null>;
  release(): void;
}

export interface ReadAloudDeps {
  db: TinigDb;
  story: StoryVersionRecord;
  passage: Passage;
  learnerId: string;
  assignmentId: string | null;
  plan: RecognitionPlan;
  /** Selected at runtime from what the browser supports; null if it cannot record. */
  audioFormat: string | null;
  createRecorder: (mimeType: string) => RecorderLike;
  createProvider: (plan: RecognitionPlan) => SpeechProvider | null;
  shareAudio: () => boolean;
  now?: () => number;
  checkpointIntervalMs?: number;
  silenceAfterMs?: number;
}

/** One message at a time: the UI shows the most important current notice only. */
export type ReadAloudNotice =
  | { kind: 'paused_by_app'; text: string }
  | { kind: 'recognition_lost'; text: string }
  | { kind: 'silence'; text: string }
  | { kind: 'noise'; text: string }
  | { kind: 'backup_failed'; text: string };

export interface ReadAloudSnapshot {
  recording: RecordingState;
  alignment: AlignmentSnapshot | null;
  following: boolean;
  timing: AttemptTiming;
  level: number;
  notice: ReadAloudNotice | null;
  result: { session: ReadingSessionRecord; awards: LocalReward[] } | null;
  /** Kept in memory if saving failed, so the reader can still download it. */
  unsavedRecording: Blob | null;
}

const SPEECH_LEVEL = 0.08;

export class ReadAloudController {
  private state: RecordingState = INITIAL_RECORDING_STATE;
  private tokenCounter = 0;
  private recorder: RecorderLike | null = null;
  private provider: SpeechProvider | null = null;
  private aligner: StreamingAligner | null = null;
  private clock: SessionClock;
  private session: ReadingSessionRecord | null = null;
  private snapshot: ReadAloudSnapshot;
  private listeners = new Set<() => void>();
  private checkpointTimer: ReturnType<typeof setInterval> | null = null;
  private lastVoiceAt = 0;
  private lastHeardWords = 0;
  private lastWordsAt = 0;
  private following = false;
  private recognitionLost = false;
  private backupFailed = false;
  private suppressed = 0;
  private chunkWrites: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ReadAloudDeps) {
    this.clock = new SessionClock(deps.now);
    this.snapshot = this.buildSnapshot();
  }

  private now(): number {
    return this.deps.now?.() ?? performance.now();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ReadAloudSnapshot => this.snapshot;

  private buildSnapshot(extra: Partial<ReadAloudSnapshot> = {}): ReadAloudSnapshot {
    return {
      recording: this.state,
      alignment: this.aligner?.snapshot() ?? null,
      following: this.following,
      timing: this.clock.timing,
      level: this.snapshot?.level ?? 0,
      notice: this.currentNotice(),
      result: this.snapshot?.result ?? null,
      unsavedRecording: this.snapshot?.unsavedRecording ?? null,
      ...extra,
    };
  }

  private emit(extra: Partial<ReadAloudSnapshot> = {}): void {
    this.snapshot = this.buildSnapshot(extra);
    for (const listener of this.listeners) listener();
  }

  private dispatch(event: RecordingEvent): boolean {
    const next = recordingReducer(this.state, event);
    if (next === this.state) return false;
    this.state = next;
    this.emit();
    return true;
  }

  private currentNotice(): ReadAloudNotice | null {
    const status = this.state.status;
    if (this.suppressed > 0) return null;
    if (status === 'paused' && this.state.reason === 'interruption') {
      return { kind: 'paused_by_app', text: 'Paused while the app was in the background. Press Continue when you are ready.' };
    }
    if (status !== 'recording') return null;
    if (this.backupFailed) return { kind: 'backup_failed', text: 'This device is almost out of space. Finish soon so your reading can be saved.' };
    if (this.recognitionLost) return { kind: 'recognition_lost', text: 'Word following stopped. Keep reading — your recording is still being saved.' };
    const now = this.now();
    const silenceAfter = this.deps.silenceAfterMs ?? 8_000;
    if (now - this.lastVoiceAt > silenceAfter) return { kind: 'silence', text: 'We can’t hear you yet. Read a little louder, or move closer to the microphone.' };
    if (this.following && now - this.lastWordsAt > 12_000 && now - this.lastVoiceAt < 2_000) {
      return { kind: 'noise', text: 'It’s noisy here, so it’s hard to follow your voice. Try a quieter spot.' };
    }
    return null;
  }

  /** Starts a new attempt: microphone permission, then recording and voice following. */
  async begin(): Promise<void> {
    const token = ++this.tokenCounter;
    if (!this.dispatch({ type: 'REQUEST', token })) return;
    this.recognitionLost = false;
    this.backupFailed = false;
    this.snapshot = { ...this.snapshot, result: null, unsavedRecording: null };

    if (!this.deps.audioFormat) {
      this.dispatch({ type: 'FAIL', token, error: recordingError('unsupported_format') });
      return;
    }
    const recorder = this.deps.createRecorder(this.deps.audioFormat);
    try {
      await recorder.acquire();
    } catch (error) {
      recorder.release();
      this.dispatch({ type: 'FAIL', token, error: error as RecordingError });
      return;
    }
    if (this.state.token !== token || this.state.status !== 'requesting_permission') {
      recorder.release(); // cancelled while waiting for permission
      return;
    }
    this.recorder = recorder;
    this.dispatch({ type: 'GRANTED', token });

    const provider = this.deps.createProvider(this.deps.plan);
    const recognition: RecognitionInfo = {
      plan: this.deps.plan.kind,
      engine: provider?.engine ?? null,
      reason: this.deps.plan.kind === 'none' ? this.deps.plan.reason : null,
    };
    try {
      this.session = await startSession(this.deps.db, {
        learnerId: this.deps.learnerId, story: this.deps.story, assignmentId: this.deps.assignmentId,
        mode: 'read_aloud', recognition,
      });
    } catch (error) {
      this.teardown();
      this.dispatch({ type: 'FAIL', token, error: recordingError(error instanceof StorageFullError ? 'storage_full' : 'recorder_failure') });
      return;
    }
    if (this.state.token !== token) return;

    this.aligner = provider ? new StreamingAligner(this.deps.passage.words, this.deps.story.language) : null;
    this.clock = new SessionClock(this.deps.now);
    const sessionId = this.session.id;
    const now = this.now();
    this.lastVoiceAt = now;
    this.lastWordsAt = now;
    this.lastHeardWords = 0;

    try {
      recorder.start({
        onChunk: (blob, seq) => {
          if (this.state.token !== token) return;
          this.chunkWrites = this.chunkWrites
            .then(() => appendAudioChunk(this.deps.db, sessionId, seq, blob, recorder.mimeType))
            .catch(() => {
              this.backupFailed = true;
              this.emit();
            });
        },
        onLevel: (level) => {
          if (this.state.token !== token) return;
          if (level > SPEECH_LEVEL) this.lastVoiceAt = this.now();
          this.emit({ level });
        },
        onError: (error) => {
          if (this.state.token !== token) return;
          void this.failWhileRecording(token, error);
        },
      });
    } catch (error) {
      this.teardown();
      this.dispatch({ type: 'FAIL', token, error: error as RecordingError });
      return;
    }

    this.clock.start();
    this.dispatch({ type: 'START', token });
    this.startCheckpoints(token);

    if (provider) {
      this.provider = provider;
      this.following = true;
      await provider.start(
        { locale: this.deps.plan.kind === 'none' ? '' : this.deps.plan.locale, stream: recorder.mediaStream, phraseHints: this.deps.passage.words.map((w) => w.norm) },
        {
          onSegment: (update) => {
            if (this.state.token !== token || !this.aligner || this.suppressed > 0) return;
            if (this.state.status !== 'recording') return;
            this.aligner.update(update.segmentId, update.text, update.isFinal, this.clock.assessedNow());
            const heard = this.aligner.snapshot().heardWords;
            if (heard !== this.lastHeardWords) {
              this.lastHeardWords = heard;
              this.lastWordsAt = this.now();
            }
            this.emit();
          },
          onListeningChange: (listening) => {
            if (this.state.token !== token) return;
            this.clock.setListening(listening, this.state.status === 'recording' && !this.recognitionLost);
            this.emit();
          },
          onFatalError: () => {
            if (this.state.token !== token) return;
            this.recognitionLost = true;
            this.following = false;
            this.clock.setListening(false, true);
            this.emit();
          },
        },
      );
    }
  }

  private startCheckpoints(token: number): void {
    this.stopCheckpoints();
    this.checkpointTimer = setInterval(() => {
      if (this.state.token !== token || !this.session) return;
      void checkpointSession(this.deps.db, this.session.id, this.clock.timing, this.aligner?.log() ?? null).catch(() => {
        this.backupFailed = true;
      });
      this.emit();
    }, this.deps.checkpointIntervalMs ?? 3_000);
  }

  private stopCheckpoints(): void {
    if (this.checkpointTimer) clearInterval(this.checkpointTimer);
    this.checkpointTimer = null;
  }

  pause(reason: PauseReason = 'user'): void {
    if (this.state.status !== 'recording') return;
    this.recorder?.pause();
    this.provider?.pause();
    this.clock.setListening(false, false);
    this.clock.pause(reason);
    this.dispatch({ type: 'PAUSE', token: this.state.token, reason });
  }

  resume(): void {
    if (this.state.status !== 'paused') return;
    this.recorder?.resume();
    this.clock.resume();
    this.lastVoiceAt = this.now();
    this.lastWordsAt = this.now();
    this.dispatch({ type: 'RESUME', token: this.state.token });
    if (!this.recognitionLost) this.provider?.resume();
  }

  /** "Continue from here": moves the reading position. Skipped words are not marked correct. */
  continueFrom(wordIndex: number): void {
    if (!this.aligner || (this.state.status !== 'recording' && this.state.status !== 'paused')) return;
    this.aligner.reposition(wordIndex, this.clock.assessedNow());
    this.provider?.newSegment();
    this.emit();
  }

  /**
   * Runs `play` (e.g. pronouncing a word) with recognition suspended, so the app's
   * own voice is never assessed as the reader's speech.
   */
  async withRecognitionSuspended<T>(play: () => Promise<T>): Promise<T> {
    const wasRecording = this.state.status === 'recording';
    this.suppressed++;
    if (wasRecording) this.pause('interruption');
    try {
      return await play();
    } finally {
      // A short tail so the end of the playback is not picked up.
      await new Promise((resolve) => setTimeout(resolve, 300));
      this.suppressed--;
      if (wasRecording && this.state.status === 'paused') this.resume();
    }
  }

  /** The app went to the background (or came back). */
  setHidden(hidden: boolean): void {
    if (hidden) this.pause('interruption');
    else this.emit();
  }

  private async failWhileRecording(token: number, error: RecordingError): Promise<void> {
    // Keep what was recorded: save the attempt as far as it got, then report the error.
    if (this.state.status === 'recording' || this.state.status === 'paused') {
      await this.finish();
    }
    if (this.state.token === token && this.state.status !== 'result') {
      this.dispatch({ type: 'FAIL', token, error });
    }
  }

  /** Ends the attempt, assesses it (if voice following ran) and saves everything. */
  async finish(): Promise<void> {
    const token = this.state.token;
    if (!this.dispatch({ type: 'FINISH', token })) return;
    this.stopCheckpoints();
    await this.provider?.stop();
    const timing = this.clock.stop();
    const blob = (await this.recorder?.stop()) ?? null;
    await this.chunkWrites;
    this.teardown();
    if (!this.session) return;

    let assessment;
    let wordResults = null;
    if (this.aligner && this.deps.plan.kind !== 'none' && this.session.recognition.engine) {
      const result = this.aligner.finish();
      const assessed = assessAttempt({
        result, timing, method: 'transcript_alignment_live', engine: this.session.recognition.engine,
      });
      assessment = assessed.summary;
      wordResults = assessed.words.length ? assessed.words : null;
    } else {
      assessment = unassessedSummary(
        this.deps.passage.words.length,
        timing,
        this.deps.plan.kind === 'none' ? this.deps.plan.reason : 'recognition_failed',
      );
    }

    try {
      const saved = await finalizeSession(this.deps.db, {
        sessionId: this.session.id,
        timing,
        transcript: this.aligner?.log() ?? null,
        assessment,
        wordResults,
        recording: blob ? { blob, mimeType: this.deps.audioFormat ?? blob.type } : null,
        shareAudio: this.deps.shareAudio(),
      });
      if (this.state.token !== token) return;
      this.snapshot = { ...this.snapshot, result: saved };
      this.dispatch({ type: 'DONE', token });
    } catch (error) {
      this.snapshot = { ...this.snapshot, unsavedRecording: blob };
      this.dispatch({ type: 'FAIL', token, error: recordingError(error instanceof StorageFullError ? 'storage_full' : 'recorder_failure') });
    }
  }

  /** Discards the current attempt (the UI confirms with the reader first). */
  async cancel(): Promise<void> {
    const token = this.state.token;
    const sessionId = this.session?.id;
    this.stopCheckpoints();
    this.provider?.dispose();
    this.provider = null;
    this.clock.stop();
    this.teardown();
    this.dispatch({ type: 'CANCEL', token });
    await this.chunkWrites;
    if (sessionId) await discardSession(this.deps.db, sessionId);
    this.session = null;
    this.aligner = null;
    this.emit();
  }

  reset(): void {
    this.dispatch({ type: 'RESET', token: this.state.token });
    this.aligner = null;
    this.session = null;
    this.snapshot = { ...this.snapshot, result: null, unsavedRecording: null };
    this.emit();
  }

  private teardown(): void {
    this.provider?.dispose();
    this.provider = null;
    this.recorder?.release();
    this.recorder = null;
    this.following = false;
  }

  /**
   * Leaving the screen without finishing: release the microphone. The in-progress
   * attempt stays in IndexedDB with its audio chunks and can be recovered later.
   */
  dispose(): void {
    this.stopCheckpoints();
    if (this.session && (this.state.status === 'recording' || this.state.status === 'paused')) {
      void checkpointSession(this.deps.db, this.session.id, this.clock.timing, this.aligner?.log() ?? null).catch(() => undefined);
    }
    this.teardown();
    this.listeners.clear();
  }
}
