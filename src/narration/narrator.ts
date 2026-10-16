import type { NarrationTiming } from '../domain/types';
import type { LanguageCode } from '../text/language';
import type { Passage } from '../text/tokenize';
import { voicesFor } from '../speech/capabilities';

/**
 * Listen-and-follow narration. Highlighting comes only from real signals:
 *  - recorded narration with word timings (AudioNarrator), or
 *  - speech-synthesis word boundary events (TtsNarrator).
 * When a voice reports no word boundaries, highlighting falls back to whole
 * sentences and says so. Narration is never presented as recognition of the reader.
 */
export type NarrationStatus = 'idle' | 'playing' | 'paused' | 'ended' | 'unavailable' | 'error';
export type HighlightGranularity = 'word' | 'sentence' | 'unknown';

export interface NarrationState {
  status: NarrationStatus;
  wordIndex: number | null;
  sentenceIndex: number | null;
  granularity: HighlightGranularity;
  rate: number;
  source: 'recording' | 'speech_synthesis' | 'none';
  message: string | null;
}

export interface Narrator {
  getState(): NarrationState;
  subscribe(listener: () => void): () => void;
  play(fromSentence?: number): void;
  pause(): void;
  resume(): void;
  stop(): void;
  setRate(rate: number): void;
  dispose(): void;
}

export const NARRATION_RATES = [0.75, 1, 1.25] as const;

abstract class BaseNarrator implements Narrator {
  protected state: NarrationState;
  private listeners = new Set<() => void>();

  constructor(initial: Partial<NarrationState>) {
    this.state = {
      status: 'idle', wordIndex: null, sentenceIndex: null, granularity: 'unknown', rate: 1, source: 'none', message: null, ...initial,
    };
  }

  getState(): NarrationState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  protected set(patch: Partial<NarrationState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  abstract play(fromSentence?: number): void;
  abstract pause(): void;
  abstract resume(): void;
  abstract stop(): void;
  abstract setRate(rate: number): void;
  dispose(): void {
    this.stop();
    this.listeners.clear();
  }
}

/** Speech synthesis, one utterance per sentence, highlighting from boundary events. */
export class TtsNarrator extends BaseNarrator {
  private voice: SpeechSynthesisVoice | null;
  private sentence = 0;
  private generation = 0;
  private sawWordBoundary = false;
  /** For each sentence: character offset of each word within the spoken text. */
  private offsets: { text: string; starts: number[]; firstWord: number }[];

  constructor(passage: Passage, language: LanguageCode) {
    super({ source: 'speech_synthesis' });
    this.voice = voicesFor(language)[0] ?? null;
    this.offsets = passage.sentences.map((sentence) => {
      const starts: number[] = [];
      let text = '';
      for (let i = sentence.wordStart; i < sentence.wordEnd; i++) {
        const word = passage.words[i];
        text += word.leading;
        starts.push(text.length);
        text += word.core + word.trailing + (word.spaceAfter ? ' ' : '');
      }
      return { text: text.trim(), starts, firstWord: sentence.wordStart };
    });
    if (typeof speechSynthesis === 'undefined') {
      this.set({ status: 'unavailable', message: 'This browser cannot read stories aloud.' });
    } else if (!this.voice) {
      this.set({
        status: 'unavailable',
        message: language === 'fil'
          ? 'There is no Filipino voice on this device, so the story cannot be read aloud here.'
          : 'There is no voice for this language on this device.',
      });
    }
  }

  static async waitForVoices(timeoutMs = 1500): Promise<void> {
    if (typeof speechSynthesis === 'undefined' || speechSynthesis.getVoices().length) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      speechSynthesis.addEventListener('voiceschanged', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  private wordAt(sentenceIndex: number, charIndex: number): number {
    const { starts, firstWord } = this.offsets[sentenceIndex];
    let found = 0;
    for (let i = 0; i < starts.length; i++) if (starts[i] <= charIndex) found = i;
    return firstWord + found;
  }

  private speak(sentenceIndex: number): void {
    const generation = this.generation;
    if (sentenceIndex >= this.offsets.length) {
      this.set({ status: 'ended', wordIndex: null, sentenceIndex: null });
      return;
    }
    this.sentence = sentenceIndex;
    const utterance = new SpeechSynthesisUtterance(this.offsets[sentenceIndex].text);
    if (this.voice) {
      utterance.voice = this.voice;
      utterance.lang = this.voice.lang;
    }
    utterance.rate = this.state.rate;
    utterance.onstart = () => {
      if (generation !== this.generation) return;
      this.set({ status: 'playing', sentenceIndex, wordIndex: this.sawWordBoundary ? this.offsets[sentenceIndex].firstWord : null });
    };
    utterance.onboundary = (event) => {
      if (generation !== this.generation) return;
      if (event.name && event.name !== 'word') return;
      this.sawWordBoundary = true;
      this.set({ wordIndex: this.wordAt(sentenceIndex, event.charIndex), granularity: 'word' });
    };
    utterance.onend = () => {
      if (generation !== this.generation) return;
      if (!this.sawWordBoundary) this.set({ granularity: 'sentence' });
      this.speak(sentenceIndex + 1);
    };
    utterance.onerror = (event) => {
      if (generation !== this.generation || event.error === 'interrupted' || event.error === 'canceled') return;
      this.set({ status: 'error', message: 'The story could not be read aloud.' });
    };
    speechSynthesis.speak(utterance);
  }

  play(fromSentence = 0): void {
    if (this.state.status === 'unavailable') return;
    this.generation++;
    speechSynthesis.cancel();
    this.set({ status: 'playing', sentenceIndex: fromSentence, wordIndex: null, message: null });
    this.speak(fromSentence);
  }

  /** Pausing cancels speech and resumes from the start of the current sentence (reliable across browsers). */
  pause(): void {
    if (this.state.status !== 'playing') return;
    this.generation++;
    speechSynthesis.cancel();
    this.set({ status: 'paused' });
  }

  resume(): void {
    if (this.state.status !== 'paused') return;
    this.play(this.sentence);
  }

  stop(): void {
    this.generation++;
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    if (this.state.status !== 'unavailable') this.set({ status: 'idle', wordIndex: null, sentenceIndex: null });
  }

  setRate(rate: number): void {
    const wasPlaying = this.state.status === 'playing';
    this.set({ rate });
    if (wasPlaying) this.play(this.sentence);
  }
}

/**
 * Recorded narration. Words light up only from word timings supplied with the
 * recording; without them it plays with no highlighting (granularity 'unknown'),
 * because sentence or word positions cannot be known from the audio alone.
 */
export class AudioNarrator extends BaseNarrator {
  private audio: HTMLAudioElement;
  private frame: number | null = null;
  private sorted: NarrationTiming[];

  constructor(private readonly passage: Passage, url: string, timings: NarrationTiming[]) {
    super({ source: 'recording', granularity: timings.length ? 'word' : 'unknown' });
    this.sorted = [...timings].sort((a, b) => a.startMs - b.startMs);
    this.audio = new Audio(url);
    this.audio.preload = 'auto';
    this.audio.onended = () => {
      this.stopLoop();
      this.set({ status: 'ended', wordIndex: null, sentenceIndex: null });
    };
    this.audio.onerror = () => this.set({ status: 'error', message: 'The narration recording could not be played.' });
  }

  private tick = () => {
    const ms = this.audio.currentTime * 1000;
    let lo = 0;
    let hi = this.sorted.length - 1;
    let found: NarrationTiming | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.sorted[mid].startMs <= ms) {
        found = this.sorted[mid];
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const wordIndex = found && ms <= found.endMs + 400 ? found.wordIndex : this.state.wordIndex;
    if (wordIndex !== this.state.wordIndex) {
      this.set({ wordIndex, sentenceIndex: wordIndex === null ? null : this.passage.words[wordIndex]?.sentenceIndex ?? null });
    }
    this.frame = requestAnimationFrame(this.tick);
  };

  private stopLoop() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  play(fromSentence = 0): void {
    const firstWord = this.passage.sentences[fromSentence]?.wordStart ?? 0;
    const timing = this.sorted.find((t) => t.wordIndex >= firstWord);
    this.audio.currentTime = timing ? timing.startMs / 1000 : 0;
    this.audio.playbackRate = this.state.rate;
    void this.audio.play().then(
      () => {
        this.set({ status: 'playing', message: null });
        this.stopLoop();
        this.frame = requestAnimationFrame(this.tick);
      },
      () => this.set({ status: 'error', message: 'The narration recording could not be played.' }),
    );
  }

  pause(): void {
    this.audio.pause();
    this.stopLoop();
    this.set({ status: 'paused' });
  }

  resume(): void {
    void this.audio.play().then(() => {
      this.set({ status: 'playing' });
      this.frame = requestAnimationFrame(this.tick);
    });
  }

  stop(): void {
    this.audio.pause();
    this.stopLoop();
    this.set({ status: 'idle', wordIndex: null, sentenceIndex: null });
  }

  setRate(rate: number): void {
    this.audio.playbackRate = rate;
    this.set({ rate });
  }

  dispose(): void {
    super.dispose();
    this.audio.src = '';
  }
}

/** Speaks a single word for the Word Coach (computer voice). */
export function speakWord(word: string, language: LanguageCode): Promise<void> {
  return new Promise((resolve) => {
    if (typeof speechSynthesis === 'undefined') return resolve();
    const voice = voicesFor(language)[0];
    if (!voice) return resolve();
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    utterance.rate = 0.8;
    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();
    speechSynthesis.speak(utterance);
    setTimeout(resolve, 4000);
  });
}
