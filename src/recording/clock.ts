import type { AttemptTiming } from '../assessment/scoring';
import type { PauseReason } from './machine';

/**
 * Tracks the time measures used for scoring:
 *  - active: recording time, excluding explicit pauses and interruptions;
 *  - paused: explicit pauses by the reader;
 *  - interrupted: app-generated gaps (app hidden, recognizer restarting);
 *  - assessed: time the recognizer was listening while recording. Transcript
 *    events are stamped with this clock, so pauses never count as reading time.
 * Natural hesitation while recording is kept in all of them.
 */
export class SessionClock {
  private activeMs = 0;
  private pausedMs = 0;
  private interruptedMs = 0;
  private assessedMs = 0;
  private mode: 'stopped' | 'active' | PauseReason = 'stopped';
  private since = 0;
  private listening = false;
  private listeningSince = 0;
  /** Recognizer-down time while active (counted as interruption). */
  private gapSince: number | null = null;

  constructor(private readonly now: () => number = () => performance.now()) {}

  static fromTiming(timing: AttemptTiming, now?: () => number): SessionClock {
    const clock = new SessionClock(now);
    clock.activeMs = timing.activeMs;
    clock.pausedMs = timing.pausedMs;
    clock.interruptedMs = timing.interruptedMs;
    clock.assessedMs = timing.assessedMs;
    return clock;
  }

  private flush(): void {
    const t = this.now();
    const elapsed = t - this.since;
    if (this.mode === 'active') this.activeMs += elapsed;
    else if (this.mode === 'user') this.pausedMs += elapsed;
    else if (this.mode === 'interruption') this.interruptedMs += elapsed;
    this.since = t;
    if (this.mode === 'active' && this.listening) {
      this.assessedMs += t - this.listeningSince;
    }
    this.listeningSince = t;
    if (this.gapSince !== null && this.mode === 'active') {
      this.interruptedMs += t - this.gapSince;
    }
    if (this.gapSince !== null) this.gapSince = t;
  }

  start(): void {
    if (this.mode !== 'stopped') return;
    this.since = this.now();
    this.listeningSince = this.since;
    this.mode = 'active';
  }

  pause(reason: PauseReason): void {
    if (this.mode !== 'active') return;
    this.flush();
    this.mode = reason;
  }

  resume(): void {
    if (this.mode !== 'user' && this.mode !== 'interruption') return;
    this.flush();
    this.mode = 'active';
  }

  /** Tells the clock whether speech recognition is currently listening. */
  setListening(listening: boolean, expected = true): void {
    this.flush();
    this.listening = listening;
    // A recognizer that should be listening but is not (e.g. restarting) is an
    // app-generated interruption of assessment.
    this.gapSince = !listening && expected ? this.now() : null;
  }

  stop(): AttemptTiming {
    if (this.mode !== 'stopped') this.flush();
    this.mode = 'stopped';
    this.listening = false;
    this.gapSince = null;
    return this.timing;
  }

  /** Current assessment-clock time; used to stamp transcript events. */
  assessedNow(): number {
    if (this.mode === 'active' && this.listening) return this.assessedMs + (this.now() - this.listeningSince);
    return this.assessedMs;
  }

  get timing(): AttemptTiming {
    const t = this.now();
    const elapsed = t - this.since;
    const recognizerGap = this.gapSince !== null && this.mode === 'active' ? t - this.gapSince : 0;
    return {
      activeMs: Math.round(this.activeMs + (this.mode === 'active' ? elapsed : 0)),
      pausedMs: Math.round(this.pausedMs + (this.mode === 'user' ? elapsed : 0)),
      interruptedMs: Math.round(this.interruptedMs + (this.mode === 'interruption' ? elapsed : 0) + recognizerGap),
      assessedMs: Math.round(this.assessedNow()),
    };
  }
}
