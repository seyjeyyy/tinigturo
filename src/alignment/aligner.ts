import type { LanguageCode } from '../text/language';
import {
  compareWords,
  isCommonWord,
  isFiller,
  normalizeTranscript,
  resembles,
} from '../text/normalize';
import type { PassageWord } from '../text/tokenize';

/**
 * Streaming transcript-to-passage alignment ("videoke" following).
 *
 * The aligner is a pure function of (passage, ordered transcript events). Final
 * transcript words are folded into a checkpointed, confirmed state; partial words are
 * re-aligned from that checkpoint on every update, so revisions to a partial
 * transcript can never corrupt confirmed progress or count a position twice.
 *
 * Rules (documented in docs/SCORING.md):
 *  - Matching is restricted to a bounded window around the cursor: up to LOOKAHEAD
 *    words ahead and LOOKBEHIND words behind. Larger jumps need a unique 3-word
 *    phrase match, or the reader's manual "Continue from here".
 *  - A common word alone never justifies skipping ahead; it needs the next heard word
 *    to confirm the new position.
 *  - Repetitions are neither credited nor penalized. Re-reading a word that was
 *    previously substituted or uncertain upgrades it to "self_corrected".
 *  - Insertions (extra words) are counted for information only.
 *  - Manual repositioning never marks skipped words as correct; they become "unassessed".
 */

export const ALIGNER_VERSION = 'align-1.0.0';

export type WordStatus = 'correct' | 'self_corrected' | 'uncertain' | 'substituted' | 'skipped';
export type FinalWordStatus = WordStatus | 'unassessed' | 'not_reached';

export interface AssignedWord {
  status: WordStatus;
  heard?: string;
}

export interface AlignerOptions {
  lookahead: number;
  lookbehind: number;
  maxPending: number;
  resyncNgram: number;
}

export const DEFAULT_ALIGNER_OPTIONS: AlignerOptions = {
  lookahead: 8,
  lookbehind: 3,
  maxPending: 4,
  resyncNgram: 3,
};

interface HypWord {
  norm: string;
  t: number;
}

interface AlignState {
  cursor: number;
  assigned: (AssignedWord | null)[];
  manualSkip: boolean[];
  pending: HypWord[];
  insertions: number;
  repetitions: number;
  fillers: number;
  /** Index of the word most recently heard (current highlight), or -1. */
  current: number;
  /** Highest assigned index, or -1. */
  furthest: number;
  /** Assessment-clock time when `furthest` was reached. */
  furthestAt: number | null;
  heardWords: number;
}

export interface TranscriptSegment {
  id: string;
  order: number;
  text: string;
  final: boolean;
  /** Assessment-clock milliseconds at the latest update of this segment. */
  t: number;
}

export interface RepositionMarker {
  toIndex: number;
  /** The marker applies before the segment with this order. */
  beforeOrder: number;
  t: number;
}

/** Everything needed to reproduce an alignment. Stored with each attempt. */
export interface TranscriptLog {
  alignerVersion: string;
  segments: TranscriptSegment[];
  repositions: RepositionMarker[];
}

export interface LiveWordState {
  status: WordStatus;
  /** True when the match depends on words that may still be revised. */
  tentative: boolean;
}

export interface AlignmentSnapshot {
  words: (LiveWordState | null)[];
  /** Word the reader most recently said (blue highlight). */
  current: number | null;
  /** Next expected word (underline), or null at the end of the passage. */
  nextExpected: number | null;
  confirmedThrough: number;
  heardWords: number;
}

export interface AlignmentResult {
  statuses: FinalWordStatus[];
  heard: (string | null)[];
  insertions: number;
  repetitions: number;
  fillers: number;
  heardWords: number;
  /** Assessment-clock time when the furthest word was reached, if any. */
  lastProgressAt: number | null;
  reachedEnd: boolean;
}

type Item = { kind: 'word'; word: HypWord; final: boolean } | { kind: 'reposition'; toIndex: number; final: true };

function initialState(size: number): AlignState {
  return {
    cursor: 0,
    assigned: new Array<AssignedWord | null>(size).fill(null),
    manualSkip: new Array<boolean>(size).fill(false),
    pending: [],
    insertions: 0,
    repetitions: 0,
    fillers: 0,
    current: -1,
    furthest: -1,
    furthestAt: null,
    heardWords: 0,
  };
}

function cloneState(s: AlignState): AlignState {
  return {
    ...s,
    assigned: s.assigned.slice(),
    manualSkip: s.manualSkip.slice(),
    pending: s.pending.slice(),
  };
}

const UPGRADABLE = new Set<WordStatus>(['substituted', 'uncertain', 'skipped']);

/** Core alignment engine over a fixed passage. */
export class AlignmentEngine {
  private readonly ref: string[];
  private readonly options: AlignerOptions;

  constructor(
    words: readonly Pick<PassageWord, 'norm'>[],
    private readonly language: LanguageCode,
    options: Partial<AlignerOptions> = {},
  ) {
    this.ref = words.map((w) => w.norm);
    this.options = { ...DEFAULT_ALIGNER_OPTIONS, ...options };
  }

  get size(): number {
    return this.ref.length;
  }

  createState(): AlignState {
    return initialState(this.ref.length);
  }

  clone(state: AlignState): AlignState {
    return cloneState(state);
  }

  apply(state: AlignState, item: Item, atEnd = false): void {
    if (item.kind === 'reposition') {
      this.reposition(state, item.toIndex);
      return;
    }
    state.heardWords++;
    if (isFiller(item.word.norm, this.language)) {
      state.fillers++;
      return;
    }
    state.pending.push(item.word);
    this.resolve(state, atEnd);
  }

  /** Resolves all remaining words as if no more speech will arrive. */
  finalize(state: AlignState): void {
    this.resolve(state, true);
  }

  private exact(word: string, position: number): boolean {
    return position >= 0 && position < this.ref.length && compareWords(word, this.ref[position], this.language) === 'exact';
  }

  private assign(state: AlignState, position: number, status: WordStatus, heard: HypWord | null): void {
    const previous = state.assigned[position];
    if (previous) {
      // Never count a position twice. Only a correct re-reading can improve a word.
      if (status === 'self_corrected' || ((status === 'correct') && UPGRADABLE.has(previous.status))) {
        state.assigned[position] = { status: 'self_corrected', heard: heard?.norm };
      } else {
        state.repetitions++;
      }
    } else {
      state.assigned[position] = heard ? { status, heard: heard.norm } : { status };
    }
    state.manualSkip[position] = false;
    if (status !== 'skipped') state.current = position;
    if (position > state.furthest) {
      state.furthest = position;
      state.furthestAt = heard?.t ?? state.furthestAt;
    }
  }

  private reposition(state: AlignState, toIndex: number): void {
    const target = Math.max(0, Math.min(this.ref.length, Math.floor(toIndex)));
    state.insertions += state.pending.length;
    state.pending = [];
    if (target > state.cursor) {
      for (let i = state.cursor; i < target; i++) {
        if (!state.assigned[i]) state.manualSkip[i] = true;
      }
    }
    state.cursor = target;
    state.current = -1;
  }

  private findAhead(word: string, cursor: number): number {
    for (let k = 1; k <= this.options.lookahead; k++) {
      if (this.exact(word, cursor + k)) return k;
    }
    return -1;
  }

  private findBehind(word: string, cursor: number): number {
    for (let j = 1; j <= this.options.lookbehind; j++) {
      if (this.exact(word, cursor - j)) return j;
    }
    return -1;
  }

  private isDistinctive(word: string, cursor: number): boolean {
    if (word.length < 4 || isCommonWord(word, this.language)) return false;
    let count = 0;
    const end = Math.min(this.ref.length, cursor + this.options.lookahead + 1);
    for (let i = Math.max(0, cursor - this.options.lookbehind); i < end; i++) {
      if (this.exact(word, i)) count++;
    }
    return count === 1;
  }

  /** Finds a unique exact n-gram match outside the normal window. */
  private findResync(words: HypWord[], cursor: number): number {
    const n = words.length;
    const matches: number[] = [];
    for (let p = 0; p + n <= this.ref.length; p++) {
      const insideWindow = p >= cursor - this.options.lookbehind && p <= cursor + this.options.lookahead;
      if (insideWindow) continue;
      let ok = true;
      for (let i = 0; i < n && ok; i++) ok = this.exact(words[i].norm, p + i);
      if (ok) matches.push(p);
    }
    if (matches.length !== 1) return -1;
    // Every word of the phrase must not be filler-like common words only.
    const allCommon = words.every((w) => isCommonWord(w.norm, this.language));
    return allCommon ? -1 : matches[0];
  }

  private resolve(state: AlignState, atEnd: boolean): void {
    const N = this.ref.length;
    const { maxPending, resyncNgram } = this.options;

    outer: while (state.pending.length > 0) {
      const c = state.cursor;

      if (c >= N) {
        // Past the end: only repetitions or self-corrections of recent words remain.
        for (const word of state.pending) {
          const j = this.findBehind(word.norm, c);
          if (j !== -1) this.assign(state, c - j, 'correct', word);
          else state.insertions++;
        }
        state.pending = [];
        break;
      }

      for (let u = 0; u < state.pending.length; u++) {
        const word = state.pending[u];
        const next = state.pending[u + 1];

        // A. The expected word.
        if (this.exact(word.norm, c)) {
          const falseStart = u > 0 && resembles(state.pending[u - 1].norm, this.ref[c]);
          state.insertions += u;
          this.assign(state, c, falseStart ? 'self_corrected' : 'correct', word);
          state.cursor = c + 1;
          state.pending.splice(0, u + 1);
          continue outer;
        }

        // A2. Compound splits and joins: "some one" ~ "someone", "cannot" ~ "can not".
        if (next && this.exact(word.norm + next.norm, c)) {
          state.insertions += u;
          this.assign(state, c, 'correct', next);
          state.cursor = c + 1;
          state.pending.splice(0, u + 2);
          continue outer;
        }
        if (c + 1 < N && word.norm === this.ref[c] + this.ref[c + 1]) {
          state.insertions += u;
          this.assign(state, c, 'correct', word);
          this.assign(state, c + 1, 'correct', word);
          state.cursor = c + 2;
          state.pending.splice(0, u + 1);
          continue outer;
        }

        // B. A word slightly ahead: earlier unmatched words pair with the gap.
        const k = this.findAhead(word.norm, c);
        const behind = this.findBehind(word.norm, c);
        if (k !== -1) {
          const uncovered = k - u;
          let accept: boolean | 'wait';
          // A common word is weak evidence for a new position: it needs the next heard
          // word to confirm it. Other words may close a gap of one word, or any gap
          // if they occur only once in the window.
          const commonWord = isCommonWord(word.norm, this.language);
          if (behind === -1 && !commonWord && (uncovered <= 1 || this.isDistinctive(word.norm, c))) accept = true;
          else if (next) accept = this.exact(next.norm, c + k + 1);
          else accept = atEnd ? false : 'wait';

          if (accept === 'wait') break outer;
          if (accept) {
            const pairCount = Math.min(u, k);
            state.insertions += u - pairCount;
            const paired = state.pending.slice(u - pairCount, u);
            for (let i = 0; i < k; i++) {
              const position = c + i;
              if (i < pairCount) {
                const heard = paired[i];
                const kind = compareWords(heard.norm, this.ref[position], this.language);
                this.assign(state, position, kind === 'close' ? 'uncertain' : 'substituted', heard);
              } else {
                this.assign(state, position, 'skipped', null);
              }
            }
            this.assign(state, c + k, 'correct', word);
            state.cursor = c + k + 1;
            state.pending.splice(0, u + 1);
            continue outer;
          }
        }

        // D. A word just behind: a repetition, possibly a self-correction.
        if (behind !== -1) {
          state.insertions += u;
          const position = c - behind;
          const previous = state.assigned[position];
          if (previous && UPGRADABLE.has(previous.status) && behind <= 2) {
            this.assign(state, position, 'self_corrected', word);
          } else {
            state.repetitions++;
            state.current = position;
          }
          state.pending.splice(0, u + 1);
          continue outer;
        }

        // C. Close to the expected word: uncertain, flagged for review.
        if (compareWords(word.norm, this.ref[c], this.language) === 'close') {
          state.insertions += u;
          this.assign(state, c, 'uncertain', word);
          state.cursor = c + 1;
          state.pending.splice(0, u + 1);
          continue outer;
        }
      }

      // Nothing in the pending words resolves against the window.
      const unmatched = state.pending.length;
      if (unmatched >= resyncNgram) {
        const phrase = state.pending.slice(unmatched - resyncNgram);
        const target = this.findResync(phrase, c);
        if (target !== -1) {
          state.insertions += unmatched - resyncNgram;
          if (target > c) {
            for (let i = c; i < target; i++) if (!state.assigned[i]) this.assign(state, i, 'skipped', null);
          }
          phrase.forEach((word, i) => this.assign(state, target + i, 'correct', word));
          state.cursor = target + resyncNgram;
          state.pending = [];
          continue outer;
        }
      }
      if (unmatched > maxPending) {
        state.pending.shift();
        state.insertions++;
        continue outer;
      }
      if (atEnd) {
        if (c === N - 1) {
          // A different word in place of the last passage word.
          const last = state.pending[state.pending.length - 1];
          state.insertions += unmatched - 1;
          this.assign(state, c, 'substituted', last);
          state.cursor = N;
        } else {
          state.insertions += unmatched;
        }
        state.pending = [];
      }
      break;
    }
  }

  result(state: AlignState): AlignmentResult {
    const statuses: FinalWordStatus[] = [];
    const heard: (string | null)[] = [];
    for (let i = 0; i < this.ref.length; i++) {
      const assigned = state.assigned[i];
      if (assigned) {
        statuses.push(assigned.status);
        heard.push(assigned.heard ?? null);
      } else if (state.manualSkip[i]) {
        statuses.push('unassessed');
        heard.push(null);
      } else if (i < state.furthest) {
        // Behind the furthest point but never matched (e.g. after moving back).
        statuses.push('unassessed');
        heard.push(null);
      } else {
        statuses.push('not_reached');
        heard.push(null);
      }
    }
    return {
      statuses,
      heard,
      insertions: state.insertions,
      repetitions: state.repetitions,
      fillers: state.fillers,
      heardWords: state.heardWords,
      lastProgressAt: state.furthestAt,
      reachedEnd: state.furthest === this.ref.length - 1 && this.ref.length > 0,
    };
  }
}

/**
 * Stateful wrapper that consumes live recognizer updates. Recognizers revise partial
 * text; only final segments enter the confirmed checkpoint.
 */
export class StreamingAligner {
  private readonly engine: AlignmentEngine;
  private segments = new Map<string, TranscriptSegment>();
  private repositions: RepositionMarker[] = [];
  private nextOrder = 0;
  private checkpoint: { state: AlignState; consumed: number };
  private live: AlignState;

  constructor(
    words: readonly Pick<PassageWord, 'norm'>[],
    private readonly language: LanguageCode,
    options: Partial<AlignerOptions> = {},
  ) {
    this.engine = new AlignmentEngine(words, language, options);
    const state = this.engine.createState();
    this.checkpoint = { state, consumed: 0 };
    this.live = this.engine.clone(state);
  }

  static fromLog(
    words: readonly Pick<PassageWord, 'norm'>[],
    language: LanguageCode,
    log: TranscriptLog,
    options: Partial<AlignerOptions> = {},
  ): StreamingAligner {
    const aligner = new StreamingAligner(words, language, options);
    const markers = [...log.repositions].sort((a, b) => a.beforeOrder - b.beforeOrder);
    const segments = [...log.segments].sort((a, b) => a.order - b.order);
    let m = 0;
    for (const segment of segments) {
      while (m < markers.length && markers[m].beforeOrder <= segment.order) {
        aligner.repositions.push({ ...markers[m], beforeOrder: aligner.nextOrder });
        m++;
      }
      aligner.segments.set(segment.id, { ...segment, order: aligner.nextOrder++ });
    }
    for (; m < markers.length; m++) aligner.repositions.push({ ...markers[m], beforeOrder: aligner.nextOrder });
    aligner.recompute();
    return aligner;
  }

  /** Adds or revises a recognizer segment. Final segments are frozen. */
  update(segmentId: string, text: string, isFinal: boolean, t: number): AlignmentSnapshot {
    const existing = this.segments.get(segmentId);
    if (existing?.final) return this.snapshot();
    if (existing) {
      existing.text = text;
      existing.final = isFinal;
      existing.t = t;
    } else {
      this.segments.set(segmentId, { id: segmentId, order: this.nextOrder++, text, final: isFinal, t });
    }
    this.recompute();
    return this.snapshot();
  }

  /** Whether the recognizer may still revise this segment. */
  hasOpenSegment(segmentId: string): boolean {
    const segment = this.segments.get(segmentId);
    return Boolean(segment && !segment.final);
  }

  /**
   * Treats every still-open segment as final. Used when the recognizer's listening run
   * has ended without finalizing them (for example after a pause), so tentative text
   * that will never be revised cannot hold back confirmed progress.
   */
  closeOpenSegments(): AlignmentSnapshot {
    let changed = false;
    for (const segment of this.segments.values()) {
      if (!segment.final) {
        segment.final = true;
        changed = true;
      }
    }
    if (changed) this.recompute();
    return this.snapshot();
  }

  /** "Continue from here": the reader moves the reading position manually. */
  reposition(toIndex: number, t: number): AlignmentSnapshot {
    // Any partial text from before the reposition is frozen as final so it cannot be
    // re-interpreted relative to the new position.
    for (const segment of this.segments.values()) segment.final = true;
    this.repositions.push({ toIndex, beforeOrder: this.nextOrder, t });
    this.recompute();
    return this.snapshot();
  }

  private items(): Item[] {
    const segments = [...this.segments.values()].sort((a, b) => a.order - b.order);
    const markers = [...this.repositions].sort((a, b) => a.beforeOrder - b.beforeOrder);
    const items: Item[] = [];
    let m = 0;
    for (const segment of segments) {
      while (m < markers.length && markers[m].beforeOrder <= segment.order) {
        items.push({ kind: 'reposition', toIndex: markers[m].toIndex, final: true });
        m++;
      }
      for (const norm of normalizeTranscript(segment.text, this.language)) {
        items.push({ kind: 'word', word: { norm, t: segment.t }, final: segment.final });
      }
    }
    for (; m < markers.length; m++) items.push({ kind: 'reposition', toIndex: markers[m].toIndex, final: true });
    return items;
  }

  private recompute(): void {
    const items = this.items();
    let state = this.engine.clone(this.checkpoint.state);
    let allFinal = true;
    let checkpoint = this.checkpoint;
    for (let i = checkpoint.consumed; i < items.length; i++) {
      const item = items[i];
      this.engine.apply(state, item);
      allFinal = allFinal && item.final;
      if (allFinal && state.pending.length === 0) {
        checkpoint = { state: this.engine.clone(state), consumed: i + 1 };
      }
    }
    this.checkpoint = checkpoint;
    this.live = state;
  }

  snapshot(): AlignmentSnapshot {
    const confirmed = this.checkpoint.state;
    const live = this.live;
    const words: (LiveWordState | null)[] = live.assigned.map((assigned, i) => {
      if (!assigned) return null;
      return { status: assigned.status, tentative: confirmed.assigned[i] === null };
    });
    return {
      words,
      current: live.current >= 0 ? live.current : null,
      nextExpected: live.cursor < this.engine.size ? live.cursor : null,
      confirmedThrough: confirmed.furthest,
      heardWords: live.heardWords,
    };
  }

  /** Ends the attempt: unresolved words are resolved and partial text is treated as final. */
  finish(): AlignmentResult {
    for (const segment of this.segments.values()) segment.final = true;
    const items = this.items();
    const state = this.engine.clone(this.checkpoint.state);
    for (let i = this.checkpoint.consumed; i < items.length; i++) this.engine.apply(state, items[i]);
    this.engine.finalize(state);
    return this.engine.result(state);
  }

  log(): TranscriptLog {
    return {
      alignerVersion: ALIGNER_VERSION,
      segments: [...this.segments.values()].sort((a, b) => a.order - b.order).map((s) => ({ ...s })),
      repositions: this.repositions.map((r) => ({ ...r })),
    };
  }

  /** Current reading position (where "Continue from here" moves from). */
  get cursor(): number {
    return this.live.cursor;
  }
}
