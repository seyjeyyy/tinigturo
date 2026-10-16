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
import type { MicrophonePermission } from '../recording/permissions';
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
  /** Latest microphone samples for the live waveform; false when unavailable. */
  readWaveform?(target: Float32Array<ArrayBuffer>): boolean;
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
  /** Reads the microphone permission without prompting; a blocked microphone is not requested again. */
  checkMicrophone?: () => Promise<MicrophonePermission>;
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
  result: ReadAloudResult | null;
  /** Kept in memory if saving failed, so the reader can still download it. */
  unsavedRecording: Blob | null;
}

export interface ReadAloudResult {
  session: ReadingSessionRecord;
  awards: LocalReward[];
  /** Set when a recording failure (not the reader) ended the attempt; what was recorded is saved. */
  stoppedBy: RecordingError | null;
}

const SPEECH_LEVEL = 0.08;
/** Voice picked up for this long with no recognized words points to a recognition problem. */
const VOICE_DETECTED_MS = 3_000;

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
  private disposed = false;
  /** Whether the recorder reports input levels at all (it cannot without Web Audio). */
  private levelSeen = false;
  private lastLevelAt = 0;
  private voicedMs = 0;
  private stoppedBy: RecordingError | null = null;

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
    // Without level readings there is no evidence of silence, so say nothing.
    if (this.levelSeen && now - this.lastVoiceAt > silenceAfter) return { kind: 'silence', text: 'We can’t hear you yet. Read a little louder, or move closer to the microphone.' };
    if (this.following && now - this.lastWordsAt > 12_000 && now - this.lastVoiceAt < 2_000) {
      return { kind: 'noise', text: 'It’s noisy here, so it’s hard to follow your voice. Try a quieter spot.' };
    }
    return null;
  }

  /** Whether `token`'s attempt is still the live one and in `status` (not cancelled or left). */
  private isCurrent(token: number, status: RecordingState['status']): boolean {
    return !this.disposed && this.state.token === token && this.state.status === status;
  }

  /** Starts a new attempt: microphone permission, then recording and voice following. */
  async begin(): Promise<void> {
    if (this.disposed) return;
    const token = ++this.tokenCounter;
    if (!this.dispatch({ type: 'REQUEST', token })) return;
    this.recognitionLost = false;
    this.backupFailed = false;
    this.levelSeen = false;
    this.voicedMs = 0;
    this.stoppedBy = null;
    this.snapshot = { ...this.snapshot, result: null, unsavedRecording: null };

    if (!this.deps.audioFormat) {
      this.dispatch({ type: 'FAIL', token, error: recordingError('unsupported_format') });
      return;
    }
    // A blocked microphone is explained, not requested again (see recording/permissions.ts).
    if (this.deps.checkMicrophone && (await this.deps.checkMicrophone()) === 'denied') {
      if (this.isCurrent(token, 'requesting_permission')) this.dispatch({ type: 'FAIL', token, error: recordingError('permission_denied') });
      return;
    }
    if (!this.isCurrent(token, 'requesting_permission')) return;
    const recorder = this.deps.createRecorder(this.deps.audioFormat);
    try {
      await recorder.acquire();
    } catch (error) {
      recorder.release();
      if (this.isCurrent(token, 'requesting_permission')) this.dispatch({ type: 'FAIL', token, error: error as RecordingError });
      return;
    }
    // Cancelled, or the reader left the screen, while the permission prompt was open:
    // the microphone must not stay on with nobody to stop it.
    if (!this.isCurrent(token, 'requesting_permission')) {
      recorder.release();
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
    let session: ReadingSessionRecord;
    try {
      session = await startSession(this.deps.db, {
        learnerId: this.deps.learnerId, story: this.deps.story, assignmentId: this.deps.assignmentId,
        mode: 'read_aloud', recognition,
      });
    } catch (error) {
      provider?.dispose();
      recorder.release();
      if (this.isCurrent(token, 'ready')) {
        this.recorder = null;
        this.dispatch({ type: 'FAIL', token, error: recordingError(error instanceof StorageFullError ? 'storage_full' : 'recorder_failure') });
      }
      return;
    }
    if (!this.isCurrent(token, 'ready')) {
      // Cancelled or left while the attempt was being created: leave nothing behind.
      provider?.dispose();
      recorder.release();
      if (this.recorder === recorder) this.recorder = null;
      await discardSession(this.deps.db, session.id).catch(() => undefined);
      return;
    }
    this.session = session;

    this.aligner = provider ? new StreamingAligner(this.deps.passage.words, this.deps.story.language) : null;
    this.clock = new SessionClock(this.deps.now);
    const sessionId = session.id;
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
          const at = this.now();
          if (level > SPEECH_LEVEL && this.state.status === 'recording') {
            if (this.levelSeen) this.voicedMs += Math.min(1_000, at - this.lastLevelAt);
            this.lastVoiceAt = at;
          }
          this.levelSeen = true;
          this.lastLevelAt = at;
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
            if (this.state.token !== token || !this.aligner || this.suppressed > 0 || this.disposed) return;
            const status = this.state.status;
            if (status !== 'recording') {
              // After Pause or Finish the recognizer has stopped listening. What still
              // arrives is its final text for speech heard before that moment: it may
              // complete a phrase already on screen, but a new phrase is ignored, so
              // nothing new advances while paused.
              if ((status !== 'paused' && status !== 'processing') || !this.aligner.hasOpenSegment(update.segmentId)) return;
            }
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
    // The recognizer's previous listening run has ended; text it never finalized will
    // not be revised any more, so it becomes final instead of staying tentative.
    this.aligner?.closeOpenSegments();
    this.recorder?.resume();
    this.clock.resume();
    this.lastVoiceAt = this.now();
    this.lastWordsAt = this.now();
    this.dispatch({ type: 'RESUME', token: this.state.token });
    if (!this.recognitionLost) this.provider?.resume();
  }

  /**
   * Fills `target` with what the microphone hears right now, for the live waveform.
   * Only while recording; it is display only and never used for assessment.
   */
  readWaveform(target: Float32Array<ArrayBuffer>): boolean {
    if (this.state.status !== 'recording' || this.disposed) return false;
    return this.recorder?.readWaveform?.(target) ?? false;
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
    if (this.state.token !== token) return;
    // A recording failure, not a recognition one: keep what was recorded by saving the
    // attempt as far as it got. The result then says why the recording stopped.
    if (this.state.status === 'recording' || this.state.status === 'paused') {
      this.stoppedBy = error;
      await this.finish();
      return;
    }
    // While saving, what was recorded is already being kept.
    if (this.state.status === 'processing' || this.state.status === 'result') return;
    this.dispatch({ type: 'FAIL', token, error });
  }

  /** Ends the attempt, assesses it (if voice following ran) and saves everything. */
  async finish(): Promise<void> {
    const token = this.state.token;
    if (!this.dispatch({ type: 'FINISH', token })) return;
    this.stopCheckpoints();
    // The reading ended when Finish was pressed: the recognizer's flush below is not
    // reading time, and its final text is stamped with the moment reading stopped.
    const timing = this.clock.stop();
    await this.provider?.stop();
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
        recognitionInterrupted: this.recognitionLost,
        voiceDetected: this.voicedMs >= VOICE_DETECTED_MS,
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
      this.snapshot = { ...this.snapshot, result: { ...saved, stoppedBy: this.stoppedBy } };
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
    this.disposed = true;
    this.stopCheckpoints();
    if (this.session && (this.state.status === 'recording' || this.state.status === 'paused')) {
      void checkpointSession(this.deps.db, this.session.id, this.clock.timing, this.aligner?.log() ?? null).catch(() => undefined);
    }
    this.teardown();
    this.listeners.clear();
  }
}
