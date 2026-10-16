import { memo, useCallback, useEffect, useRef, type CSSProperties } from 'react';
import type { Passage as PassageModel } from '../../text/tokenize';
import type { LineSpacing, TextSize } from '../../domain/types';

export const TEXT_SIZES: Record<TextSize, string> = { md: '1.3rem', lg: '1.6rem', xl: '1.95rem', '2xl': '2.4rem' };
export const LINE_SPACINGS: Record<LineSpacing, string> = { normal: '1.7', relaxed: '2.1', loose: '2.5' };

export type WordVisual =
  | 'next'
  | 'current'
  | 'matched'
  | 'tentative'
  | 'review'
  | 'unassessed'
  | 'narrating'
  | null;

interface PassageProps {
  passage: PassageModel;
  /** Visual state per word index (may combine e.g. matched + next). */
  visuals: (WordVisual[] | null)[];
  narratingSentence?: number | null;
  selectedIndex?: number | null;
  /** Word to keep in view (current / next / narrated). */
  focusIndex: number | null;
  /** A word was tapped/clicked, or Enter was pressed on the keyboard cursor. */
  onWordSelect: (index: number) => void;
  /** Optional shortcut: a word was touched and held. The following click is ignored. */
  onWordLongPress?: (index: number) => void;
  /** Words are being picked (e.g. for the Word Coach): show them as tappable. */
  picking?: boolean;
  /** Moves the keyboard word cursor. */
  onCursorChange?: (index: number) => void;
  textSize: TextSize;
  lineSpacing: LineSpacing;
  scrollContainer: React.RefObject<HTMLElement | null>;
  label: string;
}

const VISUAL_CLASS: Record<Exclude<WordVisual, null>, string> = {
  next: 'word--next',
  current: 'word--current',
  matched: 'word--matched',
  tentative: 'word--tentative',
  review: 'word--review',
  unassessed: 'word--unassessed',
  narrating: 'word--narrating',
};

const SR_LABEL: Partial<Record<Exclude<WordVisual, null>, string>> = {
  current: 'reading now',
  next: 'next word',
  review: 'check this word',
};

const Word = memo(function Word({ index, text, visuals, selected, onSelect }: {
  index: number; text: string; visuals: WordVisual[] | null; selected: boolean; onSelect: (i: number) => void;
}) {
  const classes = ['word', ...(visuals ?? []).filter(Boolean).map((v) => VISUAL_CLASS[v as Exclude<WordVisual, null>])];
  if (selected) classes.push('word--selected');
  const srState = (visuals ?? []).map((v) => (v ? SR_LABEL[v] : undefined)).filter(Boolean)[0];
  return (
    <span
      data-w={index}
      id={`passage-word-${index}`}
      className={classes.join(' ')}
      onClick={() => onSelect(index)}
      aria-current={visuals?.includes('current') || visuals?.includes('narrating') ? 'true' : undefined}
    >
      {text}
      {srState ? <span className="sr-only"> ({srState})</span> : null}
    </span>
  );
});

/**
 * The story text. Words are rendered as plain text nodes (never HTML), with original
 * punctuation and spelling. Each word is clickable for the Word Coach; keyboard users
 * reach the same actions through the word list in the Word Coach and the toolbar.
 */
export const LONG_PRESS_MS = 550;

export function Passage({
  passage, visuals, narratingSentence, selectedIndex, focusIndex, onWordSelect, onWordLongPress, picking = false, onCursorChange, textSize, lineSpacing, scrollContainer, label,
}: PassageProps) {
  // Stable callbacks keep the memoized words from re-rendering on every parent render.
  const latest = useRef({ onWordSelect, onWordLongPress });
  latest.current = { onWordSelect, onWordLongPress };
  const press = useRef<{ timer: ReturnType<typeof setTimeout> | null; x: number; y: number; fired: boolean }>({ timer: null, x: 0, y: 0, fired: false });
  const cancelPress = () => {
    if (press.current.timer) clearTimeout(press.current.timer);
    press.current.timer = null;
  };
  useEffect(() => cancelPress, []);
  const select = useCallback((index: number) => {
    if (press.current.fired) {
      press.current.fired = false; // the click that ends a long press
      return;
    }
    latest.current.onWordSelect(index);
  }, []);
  const wordAt = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>('[data-w]') : null);
  const onPointerDown = (event: React.PointerEvent) => {
    const word = wordAt(event.target);
    if (!word || !latest.current.onWordLongPress || (event.pointerType === 'mouse' && event.button !== 0)) return;
    cancelPress();
    const index = Number(word.dataset.w);
    press.current = {
      x: event.clientX, y: event.clientY, fired: false,
      timer: setTimeout(() => {
        press.current.timer = null;
        press.current.fired = true;
        latest.current.onWordLongPress?.(index);
      }, LONG_PRESS_MS),
    };
  };
  const onPointerMove = (event: React.PointerEvent) => {
    // Moving the finger means scrolling, not holding a word.
    if (press.current.timer && (Math.abs(event.clientX - press.current.x) > 10 || Math.abs(event.clientY - press.current.y) > 10)) cancelPress();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const last = passage.words.length - 1;
    const current = selectedIndex ?? focusIndex ?? 0;
    const sentence = passage.sentences[passage.words[current]?.sentenceIndex ?? 0];
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = Math.min(last, current + 1);
    else if (event.key === 'ArrowLeft') next = Math.max(0, current - 1);
    else if (event.key === 'ArrowDown') next = Math.min(last, sentence ? sentence.wordEnd : current + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, sentence ? (passage.sentences[sentence.index - 1]?.wordStart ?? 0) : current - 1);
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      latest.current.onWordSelect(current);
      return;
    }
    if (next !== null) {
      event.preventDefault();
      onCursorChange?.(next);
      document.getElementById(`passage-word-${next}`)?.scrollIntoView({ block: 'nearest' });
    }
  };
  const manualScrollAt = useRef(0);
  const reducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  // Respect the reader's own scrolling for a few seconds.
  useEffect(() => {
    const container = scrollContainer.current;
    if (!container) return;
    const mark = () => {
      manualScrollAt.current = Date.now();
    };
    const onKey = (e: KeyboardEvent) => {
      if (['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '].includes(e.key)) mark();
    };
    container.addEventListener('wheel', mark, { passive: true });
    container.addEventListener('touchmove', mark, { passive: true });
    container.addEventListener('keydown', onKey);
    return () => {
      container.removeEventListener('wheel', mark);
      container.removeEventListener('touchmove', mark);
      container.removeEventListener('keydown', onKey);
    };
  }, [scrollContainer]);

  // Scroll only when the focus word's line is near the edge, keeping whole lines visible.
  useEffect(() => {
    const container = scrollContainer.current;
    if (focusIndex === null || !container) return;
    if (Date.now() - manualScrollAt.current < 4000) return;
    const element = container.querySelector<HTMLElement>(`[data-w="${focusIndex}"]`);
    if (!element) return;
    const box = container.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    const lineHeight = rect.height || 40;
    const tooLow = rect.bottom > box.bottom - lineHeight * 1.5;
    const tooHigh = rect.top < box.top + lineHeight * 0.5;
    if (!tooLow && !tooHigh) return;
    const target = container.scrollTop + (rect.top - box.top) - box.height / 3;
    container.scrollTo({ top: Math.max(0, target), behavior: reducedMotion ? 'auto' : 'smooth' });
  }, [focusIndex, scrollContainer, reducedMotion]);

  const style = { '--reading-size': TEXT_SIZES[textSize], '--reading-leading': LINE_SPACINGS[lineSpacing] } as CSSProperties;

  return (
    <article
      className={`passage${picking ? ' passage--picking' : ''}${onWordLongPress ? ' passage--hold' : ''}`}
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onPointerLeave={cancelPress}
      onContextMenu={(event) => {
        // Holding a word is the Word Coach shortcut, not a text menu.
        if (onWordLongPress && wordAt(event.target)) event.preventDefault();
      }}
      aria-label={label}
      aria-describedby="passage-keyboard-help"
      lang={passage.language === 'fil' ? 'fil' : 'en'}
      role="group"
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-activedescendant={selectedIndex !== null && selectedIndex !== undefined ? `passage-word-${selectedIndex}` : undefined}
    >
      <span id="passage-keyboard-help" className="sr-only">Use the arrow keys to move between words and press Enter to open the word helper.</span>
      {passage.paragraphs.map((paragraph) => (
        <p key={paragraph.index}>
          {passage.sentences.slice(paragraph.sentenceStart, paragraph.sentenceEnd).map((sentence) => (
            <span key={sentence.id} className={narratingSentence === sentence.index ? 'sentence--narrating' : undefined}>
              {passage.words.slice(sentence.wordStart, sentence.wordEnd).map((word) => (
                <span key={word.id}>
                  <Word
                    index={word.index}
                    text={word.leading + word.core + word.trailing}
                    visuals={visuals[word.index] ?? null}
                    selected={selectedIndex === word.index}
                    onSelect={select}
                  />
                  {word.lineBreakAfter ? <br /> : word.spaceAfter ? ' ' : ''}
                </span>
              ))}
            </span>
          ))}
        </p>
      ))}
    </article>
  );
}

export function WordLegend({ mode }: { mode: 'read' | 'result' | 'listen' }) {
  const items =
    mode === 'listen'
      ? [['word--narrating', 'Word the computer voice is reading']]
      : mode === 'read'
        ? [['word--next', 'Next word'], ['word--current', 'Word we just heard'], ['word--matched', 'Matched']]
        : [['word--matched', 'Matched'], ['word--review', 'Check or practice this word'], ['word--unassessed', 'Not checked']];
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-soft" aria-label="What the word markings mean">
      {items.map(([cls, text]) => (
        <li key={cls} className="flex items-center gap-1.5">
          <span className={`word ${cls} text-ink`} aria-hidden="true">word</span>
          {text}
        </li>
      ))}
    </ul>
  );
}
