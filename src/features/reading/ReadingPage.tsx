import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useBlocker, useNavigate, useParams, useSearchParams, Link } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowLeft, BookA, CircleHelp, Flag, Headphones, Mic, Minus, Pause, Play, Plus, RotateCcw, Square, Rows3,
} from 'lucide-react';
import { useApp } from '../../app/AppContext';
import type { LineSpacing, StoryVersionRecord, TextSize } from '../../domain/types';
import { DEFAULT_READING_PREFERENCES } from '../../domain/types';
import { tokenizePassage } from '../../text/tokenize';
import { LANGUAGES } from '../../text/language';
import { detectSpeechCapabilities, type SpeechCapabilities } from '../../speech/capabilities';
import { chooseRecognitionPlan, describePlan, type RecognitionPlan } from '../../speech/plan';
import { updatePreferences } from '../../data/learners';
import { saveListenSession } from '../../data/sessions';
import { NARRATION_RATES, TtsNarrator, AudioNarrator, type Narrator, type NarrationState } from '../../narration/narrator';
import type { WordResult } from '../../assessment/scoring';
import type { AlignmentSnapshot } from '../../alignment/aligner';
import { Passage, WordLegend, type WordVisual } from './Passage';
import { WordCoach } from './WordCoach';
import { HelpDialog } from './HelpDialog';
import { ResultPanel } from './ResultPanel';
import { MicrophoneBlockedSteps } from './MicrophoneHelp';
import { LiveWaveform } from './LiveWaveform';
import { useReadAloud } from './useReadAloud';
import { UpdateBanner } from '../../pwa/UpdateBanner';
import { Button, IconButton } from '../../ui/Button';
import { Alert, EmptyState, Loading } from '../../ui/feedback';
import { Dialog } from '../../ui/Dialog';
import { downloadBlob } from '../../lib/csv';
import { formatBytes } from '../../lib/format';
import { activeNarration, narrationUrl, type NarrationRow } from '../../backend/teacherToolsApi';
import { narrationKey, saveNarration } from '../../data/teacherContent';
import { StorageFullError } from '../../db/errors';
import type { RecordingError } from '../../recording/machine';

type Mode = 'read' | 'listen';
const SIZES: TextSize[] = ['md', 'lg', 'xl', '2xl'];
const SPACINGS: LineSpacing[] = ['normal', 'relaxed', 'loose'];

function liveVisuals(alignment: AlignmentSnapshot | null, size: number): (WordVisual[] | null)[] {
  const out: (WordVisual[] | null)[] = new Array(size).fill(null);
  if (!alignment) return out;
  alignment.words.forEach((state, i) => {
    if (!state) return;
    if (state.status === 'correct' || state.status === 'self_corrected') out[i] = [state.tentative ? 'tentative' : 'matched'];
    else if (!state.tentative) out[i] = ['review'];
  });
  if (alignment.current !== null) out[alignment.current] = [...(out[alignment.current] ?? []), 'current'];
  if (alignment.nextExpected !== null) out[alignment.nextExpected] = [...(out[alignment.nextExpected] ?? []), 'next'];
  return out;
}

function resultVisuals(words: WordResult[] | null, size: number): (WordVisual[] | null)[] {
  const out: (WordVisual[] | null)[] = new Array(size).fill(null);
  for (const w of words ?? []) {
    if (w.status === 'correct' || w.status === 'self_corrected') out[w.index] = ['matched'];
    else if (w.status === 'uncertain' || w.status === 'substituted' || w.status === 'skipped') out[w.index] = ['review'];
    else if (w.status === 'unassessed') out[w.index] = ['unassessed'];
  }
  return out;
}

export function ReadingPage() {
  const { versionId = '' } = useParams();
  const { db } = useApp();
  const story = useLiveQuery(async () => (await db.stories.get(versionId)) ?? null, [db, versionId], undefined);
  if (story === undefined) return <div className="p-6"><Loading label="Opening the story…" /></div>;
  if (story === null) {
    return (
      <div className="mx-auto max-w-xl p-6">
        <EmptyState icon="📚" title="This story is not on this device" action={<Link className="underline" to="/stories">Back to stories</Link>}>
          It may have been removed from Offline downloads. Download it again while you are online.
        </EmptyState>
      </div>
    );
  }
  return <Reader key={story.id} story={story} />;
}

function Reader({ story: liveStory }: { story: StoryVersionRecord }) {
  // Story versions are immutable; freeze the object so a live-query refresh can never
  // recreate the reading controller in the middle of a recording.
  const [story] = useState(liveStory);
  const { db, learner, settings, online, activity } = useApp();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const mode: Mode = params.get('mode') === 'listen' ? 'listen' : 'read';
  const assignmentId = params.get('assignment');
  const startFrom = Number(params.get('from') ?? '0') || 0;
  const passage = useMemo(() => tokenizePassage(story.body, story.language), [story.body, story.language]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [caps, setCaps] = useState<SpeechCapabilities | null>(null);
  const [coachIndex, setCoachIndex] = useState<number | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [showResultWords, setShowResultWords] = useState(false);
  /** "Word help" was pressed: the next tapped word opens the Word Coach. */
  const [picking, setPicking] = useState(false);
  const [tapHint, setTapHint] = useState(false);
  /** The Word Coach paused the reading, so closing it continues the reading. */
  const resumeAfterCoach = useRef(false);
  const prefs = learner?.preferences ?? DEFAULT_READING_PREFERENCES;

  useEffect(() => {
    let cancelled = false;
    void detectSpeechCapabilities(story.language).then((c) => !cancelled && setCaps(c));
    return () => {
      cancelled = true;
    };
  }, [story.language]);

  const plan: RecognitionPlan | null = useMemo(
    () => (caps ? chooseRecognitionPlan({ language: story.language, capabilities: caps, online, allowCloudRecognition: settings.allowCloudRecognition }) : null),
    // Re-plan only between attempts: `online` changes mid-reading must not swap engines.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [caps, story.language, settings.allowCloudRecognition],
  );

  const setRecordingActive = activity.setRecordingActive;
  const { controller, snapshot, unsaved } = useReadAloud({
    db, story, passage, learnerId: learner!.id, assignmentId, plan,
    shareAudio: settings.shareRecordings, onActiveChange: setRecordingActive,
  });

  // ---- navigation guard -------------------------------------------------
  const blocker = useBlocker(({ currentLocation, nextLocation }) => unsaved && currentLocation.pathname !== nextLocation.pathname);

  const setPrefs = (patch: Partial<typeof prefs>) => learner && void updatePreferences(db, learner.id, { ...prefs, ...patch });

  const status = snapshot?.recording.status ?? 'idle';
  const result = snapshot?.result ?? null;
  const attemptActive = unsaved || status === 'requesting_permission';

  const begin = async () => {
    setShowResultWords(false);
    await controller?.begin();
    if (startFrom > 0) controller?.continueFrom(startFrom);
  };

  // Picking a word ends when the reading ends.
  useEffect(() => {
    if (status === 'processing' || status === 'result' || status === 'error') setPicking(false);
  }, [status]);

  useEffect(() => {
    if (!tapHint) return;
    const timer = setTimeout(() => setTapHint(false), 5_000);
    return () => clearTimeout(timer);
  }, [tapHint]);

  /** Stepping out of the reading for word help pauses it, so that time is not reading time. */
  const pauseForWordHelp = () => {
    if (mode === 'read' && controller?.getSnapshot().recording.status === 'recording') {
      controller.pause('user');
      resumeAfterCoach.current = true;
    }
  };
  const resumeAfterWordHelp = () => {
    if (resumeAfterCoach.current && controller?.getSnapshot().recording.status === 'paused') controller.resume();
    resumeAfterCoach.current = false;
  };
  const openCoach = (index: number) => {
    pauseForWordHelp();
    setPicking(false);
    setTapHint(false);
    setCoachIndex(index);
  };
  const closeCoach = () => {
    setCoachIndex(null);
    resumeAfterWordHelp();
  };
  const toggleWordHelp = () => {
    if (picking) {
      setPicking(false);
      resumeAfterWordHelp();
      return;
    }
    pauseForWordHelp();
    setTapHint(false);
    setPicking(true);
  };
  const onWordTap = (index: number) => {
    // While the reader is reading, a tap is usually a finger following the text: it
    // must not cover the story with a dialog. Word help or touch-and-hold opens it.
    if (!picking && mode === 'read' && status === 'recording') {
      setTapHint(true);
      return;
    }
    openCoach(index);
  };

  // Listen mode narrator.
  const [narrator, setNarrator] = useState<Narrator | null>(null);
  /** Bumped when a narration recording is downloaded, so Listen mode switches to it. */
  const [narrationLoaded, setNarrationLoaded] = useState(0);
  useEffect(() => {
    if (mode !== 'listen') return;
    let disposed = false;
    let instance: Narrator | null = null;
    void (async () => {
      // The recording is stored per story version, with its word timings if it has any.
      const narration = (await db.stories.get(story.id))?.narration ?? null;
      if (narration) {
        const blob = await db.recordings.get(narrationKey(story.id));
        if (blob) instance = new AudioNarrator(passage, URL.createObjectURL(blob.blob), narration.timings);
      }
      if (!instance) {
        await TtsNarrator.waitForVoices();
        instance = new TtsNarrator(passage, story.language);
      }
      if (!disposed) setNarrator(instance);
    })();
    return () => {
      disposed = true;
      instance?.dispose();
      setNarrator(null);
    };
  }, [mode, passage, story, db, narrationLoaded]);

  const playSuspended = useCallback(async (play: () => Promise<void>) => {
    narrator?.pause();
    if (controller) await controller.withRecognitionSuspended(play);
    else await play();
  }, [controller, narrator]);

  const visuals = useMemo(() => {
    if (mode === 'listen') return new Array(passage.words.length).fill(null);
    if (result && showResultWords) return resultVisuals(result.session.wordResults, passage.words.length);
    if (status === 'recording' || status === 'paused' || status === 'processing') return liveVisuals(snapshot?.alignment ?? null, passage.words.length);
    return new Array(passage.words.length).fill(null);
  }, [mode, result, showResultWords, status, snapshot?.alignment, passage.words.length]);

  const focusIndex = mode === 'read' ? (snapshot?.alignment?.current ?? snapshot?.alignment?.nextExpected ?? null) : null;
  const canContinueFromHere = mode === 'read' && (status === 'recording' || status === 'paused') && Boolean(snapshot?.following);
  const planText = plan ? describePlan(plan) : 'Checking what this device can do…';
  const showingResult = Boolean(mode === 'read' && result && !showResultWords);

  const modeToggle = (className: string) => (
    <div role="group" aria-label="Reading mode" className={`rounded-xl border-2 border-line bg-white p-0.5 ${className}`}>
      {(['read', 'listen'] as Mode[]).map((m) => (
        <button
          key={m}
          type="button"
          aria-pressed={mode === m}
          disabled={attemptActive}
          onClick={() => setParams((p) => { p.set('mode', m); return p; }, { replace: true })}
          className={`inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-sm font-semibold disabled:opacity-50 ${mode === m ? 'bg-teal-brand text-white' : 'text-ink'}`}
        >
          {m === 'read' ? <Mic size={16} aria-hidden="true" /> : <Headphones size={16} aria-hidden="true" />}
          {m === 'read' ? 'Read aloud' : 'Listen'}
        </button>
      ))}
    </div>
  );

  return (
    <div className="flex h-dvh flex-col bg-paper">
      <a href="#passage" className="skip-link">Skip to story</a>
      <UpdateBanner hideWhileRecording />
      <header className="border-b-2 border-line px-2 py-1.5 sm:px-3 sm:py-2">
        <div className="flex items-center gap-1 sm:gap-2">
          <IconButton label="Back to stories" icon={<ArrowLeft size={22} />} onClick={() => navigate('/stories')} />
          <h1 className="line-clamp-2 min-w-0 flex-1 text-base font-bold leading-tight sm:text-xl">{story.title}</h1>
          {modeToggle('hidden sm:flex')}
          <div className="flex items-center" role="group" aria-label="Text size and spacing">
            <IconButton size="sm" label="Smaller text" icon={<Minus size={18} />} disabled={prefs.textSize === SIZES[0]} onClick={() => setPrefs({ textSize: SIZES[Math.max(0, SIZES.indexOf(prefs.textSize) - 1)] })} />
            <span aria-hidden="true" className="px-0.5 font-bold">A</span>
            <IconButton size="sm" label="Bigger text" icon={<Plus size={18} />} disabled={prefs.textSize === SIZES[SIZES.length - 1]} onClick={() => setPrefs({ textSize: SIZES[Math.min(SIZES.length - 1, SIZES.indexOf(prefs.textSize) + 1)] })} />
            <IconButton size="sm" label={`Line spacing: ${prefs.lineSpacing}. Change`} icon={<Rows3 size={18} />} onClick={() => setPrefs({ lineSpacing: SPACINGS[(SPACINGS.indexOf(prefs.lineSpacing) + 1) % SPACINGS.length] })} />
          </div>
        </div>
        {/* On phones the mode switch gets its own row, and only while it can be used. */}
        {!attemptActive ? modeToggle('mt-1.5 flex sm:hidden') : null}
      </header>

      <div ref={scrollRef} id="passage" className="relative flex-1 overflow-y-auto px-4 py-4 sm:px-8 sm:py-6" tabIndex={-1}>
        {showingResult && result ? (
          <div className="mx-auto max-w-2xl">
            <ResultPanel
              session={result.session}
              awards={result.awards}
              stoppedBy={result.stoppedBy}
              onReadAgain={() => controller?.reset()}
              onReviewWords={() => setShowResultWords(true)}
            />
          </div>
        ) : (
          <>
          {mode === 'read' && (status === 'recording' || status === 'paused' || showResultWords) ? (
            <div className="mx-auto mb-3 max-w-[44rem]"><WordLegend mode={showResultWords ? 'result' : 'read'} /></div>
          ) : null}
          <Passage
            passage={passage}
            visuals={visuals}
            selectedIndex={coachIndex ?? cursor}
            focusIndex={mode === 'listen' ? null : focusIndex}
            onWordSelect={onWordTap}
            onWordLongPress={openCoach}
            picking={picking}
            onCursorChange={setCursor}
            textSize={prefs.textSize}
            lineSpacing={prefs.lineSpacing}
            scrollContainer={scrollRef}
            label={`Story: ${story.title}`}
          />
          </>
        )}
        {mode === 'listen' && narrator ? <NarrationHighlighter narrator={narrator} scrollRef={scrollRef} /> : null}
      </div>

      <footer className="border-t-2 border-line bg-white px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1.5 sm:px-3 sm:pt-2">
        <div className="mx-auto max-w-4xl">
          {picking ? (
            <div className="mb-1.5 flex items-center gap-2 rounded-xl border-2 border-sun bg-sun-tint px-3 py-1" role="status">
              <p className="flex-1 text-sm font-semibold">Tap the word you want help with.</p>
              <Button size="sm" variant="secondary" onClick={toggleWordHelp}>Cancel</Button>
            </div>
          ) : tapHint ? (
            <p className="mb-1.5 rounded-xl bg-paper px-3 py-1.5 text-sm" role="status">
              To get help with a word, press <strong>Word help</strong>, or touch and hold the word.
            </p>
          ) : null}
          {mode === 'read' ? (
            <ReadAloudBar
              status={status}
              snapshot={snapshot}
              controller={controller}
              plan={plan}
              resultShowingWords={Boolean(result && showResultWords)}
              showingResult={showingResult}
              picking={picking}
              onStart={() => void begin()}
              onPause={() => controller?.pause()}
              onContinue={() => controller?.resume()}
              onFinish={() => void controller?.finish()}
              onRetry={() => void begin()}
              onBackToResult={() => setShowResultWords(false)}
              onWordHelp={toggleWordHelp}
              onHelp={() => setHelpOpen(true)}
              language={story.language}
            />
          ) : (
            <>
            <NarrationOffer story={story} onDownloaded={() => setNarrationLoaded((n) => n + 1)} />
            <ListenBar
              narrator={narrator}
              picking={picking}
              onWordHelp={toggleWordHelp}
              onHelp={() => setHelpOpen(true)}
              onFinished={(ms, startedAt) => learner && void saveListenSession(db, { learnerId: learner.id, story, assignmentId, startedAt, listenedMs: ms })}
            />
            </>
          )}
        </div>
      </footer>

      <WordCoach
        word={coachIndex !== null ? passage.words[coachIndex] : null}
        story={story}
        open={coachIndex !== null}
        onClose={closeCoach}
        playSuspended={playSuspended}
        onContinueFromHere={canContinueFromHere ? (i) => {
          controller?.continueFrom(i);
          closeCoach();
        } : undefined}
      />
      <HelpDialog
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        mode={mode}
        planText={planText}
        onDiscard={unsaved ? () => { setHelpOpen(false); setDiscardOpen(true); } : undefined}
      />
      <Dialog
        open={discardOpen}
        onClose={() => setDiscardOpen(false)}
        title="Throw away this reading?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDiscardOpen(false)}>Keep reading</Button>
            <Button variant="danger" onClick={() => { setDiscardOpen(false); void controller?.cancel(); }}>Throw it away</Button>
          </>
        }
      >
        <p>The recording and progress from this reading will be deleted from this device.</p>
      </Dialog>
      <Dialog
        open={blocker.state === 'blocked'}
        onClose={() => blocker.reset?.()}
        title="Leave this reading?"
        footer={
          <>
            <Button variant="secondary" onClick={() => blocker.reset?.()}>Keep reading</Button>
            <Button variant="danger" onClick={async () => { await controller?.cancel(); blocker.proceed?.(); }}>Throw away and leave</Button>
            <Button
              onClick={async () => {
                await controller?.finish();
                // Leave only once the reading is saved; otherwise stay so the reader sees
                // the problem (the attempt stays recoverable from Home either way).
                if (controller?.getSnapshot().recording.status === 'result') blocker.proceed?.();
                else blocker.reset?.();
              }}
            >
              Save and leave
            </Button>
          </>
        }
      >
        <p>You are in the middle of reading. Save what you have read so far, or throw it away?</p>
      </Dialog>
    </div>
  );
}

/** Applies narration highlighting directly to the word elements (avoids re-rendering the passage). */
function NarrationHighlighter({ narrator, scrollRef }: { narrator: Narrator; scrollRef: React.RefObject<HTMLDivElement | null> }) {
  const state = useSyncExternalStore(narrator.subscribe.bind(narrator), narrator.getState.bind(narrator));
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    root.querySelectorAll('.word--narrating').forEach((el) => el.classList.remove('word--narrating'));
    root.querySelectorAll('.sentence--narrating').forEach((el) => el.classList.remove('sentence--narrating'));
    let target: Element | null = null;
    if (state.status === 'playing' || state.status === 'paused') {
      if (state.granularity === 'word' && state.wordIndex !== null) {
        target = root.querySelector(`[data-w="${state.wordIndex}"]`);
        target?.classList.add('word--narrating');
      } else if (state.sentenceIndex !== null) {
        const first = root.querySelector(`[data-w]`)?.closest('article');
        const sentences = first?.querySelectorAll('p > span');
        target = sentences?.[state.sentenceIndex] ?? null;
        target?.classList.add('sentence--narrating');
      }
    }
    if (target) {
      const box = root.getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      if (rect.bottom > box.bottom - 60 || rect.top < box.top) {
        const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        root.scrollTo({ top: root.scrollTop + rect.top - box.top - box.height / 3, behavior: reduced ? 'auto' : 'smooth' });
      }
    }
  }, [state, scrollRef]);
  return null;
}

/**
 * Offers a teacher's recorded narration for this exact story version when one exists
 * and is not on the device yet. Downloading is a choice: recordings can be several MB.
 */
function NarrationOffer({ story, onDownloaded }: { story: StoryVersionRecord; onDownloaded: () => void }) {
  const { db, online, partition, cloud } = useApp();
  const [row, setRow] = useState<NarrationRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const localPath = useLiveQuery(async () => (await db.stories.get(story.id))?.narration?.audioPath ?? null, [db, story.id]);
  const canAsk = online && partition !== 'device' && cloud.status === 'configured';
  useEffect(() => {
    if (!canAsk) return;
    let cancelled = false;
    activeNarration(story.id).then((r) => !cancelled && setRow(r), () => !cancelled && setRow(null));
    return () => {
      cancelled = true;
    };
  }, [canAsk, story.id]);
  if (!row || localPath === undefined || localPath === row.audio_path) return null;
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(await narrationUrl(row.audio_path));
      if (!response.ok) throw new Error(String(response.status));
      await saveNarration(db, story, row, await response.blob());
      onDownloaded();
    } catch (e) {
      setError(e instanceof StorageFullError ? 'There is not enough space on this device.' : 'The recording could not be downloaded. Try again when the connection is better.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-2 rounded-xl border-2 border-teal-brand/40 bg-teal-tint px-3 py-1.5 text-sm" role="status">
      <span className="flex-1">
        A teacher recorded this story ({formatBytes(row.size_bytes)}{row.timings ? ', with word timings' : ', without word timings'}).
        {error ? <strong className="block">{error}</strong> : null}
      </span>
      <Button size="sm" variant="secondary" busy={busy} onClick={() => void download()}>Download recording</Button>
    </div>
  );
}

function Notice({ text, tone = 'info' }: { text: string; tone?: 'info' | 'warning' | 'error' }) {
  return <Alert tone={tone} className="mb-1.5 py-1.5 text-sm">{text}</Alert>;
}

/** A one-line notice whose explanation opens on request, so it does not take the passage's space. */
function CompactNotice({ summary, details }: { summary: string; details: React.ReactNode }) {
  return (
    <details className="mb-1.5 rounded-xl border-2 border-teal-brand/40 bg-teal-tint px-3 py-1.5 text-sm">
      <summary className="cursor-pointer font-semibold">
        {summary} <span className="font-normal underline">Why?</span>
      </summary>
      <div className="mt-1">{details}</div>
    </details>
  );
}

/** Secondary reading tools: icon over a short label on phones, side by side on larger screens. */
function ToolButton({ label, icon, onClick, pressed }: { label: string; icon: React.ReactNode; onClick: () => void; pressed?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      className={`inline-flex min-h-12 min-w-14 shrink-0 flex-col items-center justify-center gap-0.5 rounded-xl px-1.5 text-xs font-semibold text-teal-deep hover:bg-teal-tint sm:min-h-14 sm:flex-row sm:gap-2 sm:px-3 sm:text-base ${pressed ? 'bg-sun-tint ring-2 ring-sun' : ''}`}
    >
      <span aria-hidden="true">{icon}</span>
      {label}
    </button>
  );
}

/** Primary reading buttons: 48 px tall on phones, larger on bigger screens. */
const PRIMARY = 'sm:min-h-14 sm:px-6 sm:text-lg';

function ReadAloudBar(props: {
  status: string;
  snapshot: ReturnType<typeof useReadAloud>['snapshot'];
  controller: ReturnType<typeof useReadAloud>['controller'];
  plan: RecognitionPlan | null;
  resultShowingWords: boolean;
  showingResult: boolean;
  picking: boolean;
  onStart: () => void;
  onPause: () => void;
  onContinue: () => void;
  onFinish: () => void;
  onRetry: () => void;
  onBackToResult: () => void;
  onWordHelp: () => void;
  onHelp: () => void;
  language: StoryVersionRecord['language'];
}) {
  const { status, snapshot, plan } = props;
  const { settings } = useApp();
  // Exactly one message at a time, chosen by priority.
  let message: React.ReactNode = null;
  const error = status === 'error' && snapshot?.recording.status === 'error' ? (snapshot.recording as { error: RecordingError }).error : null;
  const blocked = error?.kind === 'permission_denied';
  if (error && snapshot) {
    message = (
      <Alert tone="error" title={error.message} className="mb-1.5 max-h-[45dvh] overflow-y-auto">
        {error.help}
        {blocked ? <MicrophoneBlockedSteps /> : null}
        {snapshot.unsavedRecording ? (
          <div className="mt-2">
            <Button size="sm" variant="secondary" onClick={() => downloadBlob('tinig-turo-reading.webm', snapshot.unsavedRecording!)}>Download the recording</Button>
          </div>
        ) : null}
      </Alert>
    );
  } else if (status === 'requesting_permission') {
    message = <Notice text="Please allow the microphone when your browser asks." />;
  } else if (snapshot?.notice) {
    message = <Notice text={snapshot.notice.text} tone={snapshot.notice.kind === 'backup_failed' ? 'warning' : 'info'} />;
  } else if (status === 'idle' && plan?.kind === 'none') {
    // The first sentence stays visible ("Word checking is not available on this
    // device."); the rest opens on request.
    const [summary, ...rest] = plan.explanation.split(/(?<=\.)\s+/);
    message = (
      <CompactNotice
        summary={summary}
        details={`${rest.join(' ')}${plan.reason === 'recognition_unavailable' && !settings.allowCloudRecognition ? ' A grown-up can allow online word checking in Settings.' : ''}`}
      />
    );
  } else if (status === 'idle' && plan?.kind === 'cloud') {
    message = (
      <CompactNotice
        summary="Online word checking is on."
        details="Your voice is sent to the browser’s speech service while you read. A grown-up can turn this off in Settings."
      />
    );
  }

  const live = snapshot?.alignment;
  const progress = live && live.confirmedThrough >= 0 ? `${live.confirmedThrough + 1} words followed` : null;
  const reading = status === 'recording' || status === 'paused';
  const wordCoach = <ToolButton label="Word Coach" icon={<BookA size={22} />} onClick={props.onWordHelp} pressed={props.picking} />;
  const help = <ToolButton label="Help" icon={<CircleHelp size={22} />} onClick={props.onHelp} />;

  return (
    <div>
      <div aria-live="polite">{message}</div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:gap-2">
        {reading ? (
          // Phones: a thin row above the buttons. Larger screens: inline, before the tools.
          <div className="mb-1 flex min-h-7 items-center gap-2 text-sm text-ink-soft sm:order-2 sm:mb-0 sm:ml-auto">
            {status === 'recording' ? (
              <>
                <span className="inline-flex h-2.5 w-2.5 shrink-0 rounded-full bg-danger" aria-hidden="true" />
                <span>Recording</span>
                {snapshot?.following ? <span className="hidden min-[400px]:inline">· following your voice</span> : null}
              </>
            ) : <span>Paused</span>}
            {progress ? <span className="hidden lg:inline">· {progress}</span> : null}
            <span className="ml-auto flex items-center sm:ml-2">
              <LiveWaveform source={props.controller} active={status === 'recording'} level={snapshot?.level ?? 0} />
            </span>
          </div>
        ) : null}
        {/* One row of buttons on phones; on larger screens its children join the row above. */}
        <div className="flex items-center gap-1.5 sm:contents">
        {status === 'idle' || status === 'error' ? (
          <Button icon={<Mic size={22} />} onClick={status === 'error' ? props.onRetry : props.onStart} disabled={!plan} className={`flex-1 sm:flex-none ${PRIMARY}`}>
            {status === 'error' ? (blocked ? 'Check again' : 'Try again') : 'Start'}
          </Button>
        ) : null}
        {status === 'requesting_permission' ? <Button busy disabled className={`flex-1 sm:flex-none ${PRIMARY}`}>Starting…</Button> : null}
        {status === 'recording' ? (
          <>
            <Button variant="secondary" icon={<Pause size={22} />} onClick={props.onPause} className={`px-3 ${PRIMARY}`}>Pause</Button>
            <Button icon={<Flag size={22} />} onClick={props.onFinish} className={`px-3 ${PRIMARY}`}>Finish</Button>
          </>
        ) : null}
        {status === 'paused' ? (
          <>
            <Button icon={<Play size={22} />} onClick={props.onContinue} className={`px-3 ${PRIMARY}`}>Continue</Button>
            <Button variant="secondary" icon={<Flag size={22} />} onClick={props.onFinish} className={`px-3 ${PRIMARY}`}>Finish</Button>
          </>
        ) : null}
        {status === 'processing' ? <Button busy disabled className={`flex-1 sm:flex-none ${PRIMARY}`}>Saving your reading…</Button> : null}
        {status === 'result' && props.resultShowingWords ? (
          <Button variant="secondary" icon={<Square size={20} />} onClick={props.onBackToResult} className={`flex-1 sm:flex-none ${PRIMARY}`}>Back to results</Button>
        ) : null}
        <span className={`ml-auto flex items-center gap-0.5 sm:order-3 ${reading ? 'sm:ml-0' : ''}`}>
          {!props.showingResult && status !== 'processing' && status !== 'requesting_permission' ? wordCoach : null}
          {help}
        </span>
        </div>
      </div>
      {status === 'idle' && props.language === 'fil' && !LANGUAGES.fil.assessmentVerified ? (
        <p className="mt-1 text-xs text-ink-soft">Filipino word checking is turned off until it has been tested with Filipino speech.</p>
      ) : null}
    </div>
  );
}

function ListenBar({ narrator, picking, onWordHelp, onHelp, onFinished }: {
  narrator: Narrator | null; picking: boolean; onWordHelp: () => void; onHelp: () => void; onFinished: (ms: number, startedAt: Date) => void;
}) {
  const state: NarrationState | null = useSyncExternalStore(
    narrator ? narrator.subscribe.bind(narrator) : () => () => undefined,
    narrator ? narrator.getState.bind(narrator) : () => null,
  );
  const startedAt = useRef<Date | null>(null);
  const playedMs = useRef(0);
  const playingSince = useRef<number | null>(null);
  const savedFor = useRef<Date | null>(null);

  useEffect(() => {
    if (!state) return;
    if (state.status === 'playing') {
      startedAt.current ??= new Date();
      playingSince.current ??= performance.now();
    } else if (playingSince.current !== null) {
      playedMs.current += performance.now() - playingSince.current;
      playingSince.current = null;
    }
    if (state.status === 'ended' && startedAt.current && savedFor.current !== startedAt.current && playedMs.current >= 5_000) {
      savedFor.current = startedAt.current;
      onFinished(Math.round(playedMs.current), startedAt.current);
      startedAt.current = null;
      playedMs.current = 0;
    }
  }, [state, onFinished]);

  const tools = (
    <span className="ml-auto flex items-center gap-0.5">
      <ToolButton label="Word Coach" icon={<BookA size={22} />} onClick={onWordHelp} pressed={picking} />
      <ToolButton label="Help" icon={<CircleHelp size={22} />} onClick={onHelp} />
    </span>
  );
  if (!narrator || !state) return <Loading label="Getting the voice ready…" />;
  if (state.status === 'unavailable') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Alert tone="info" className="flex-1 py-1.5 text-sm">{state.message}</Alert>
        {tools}
      </div>
    );
  }
  return (
    <div>
      <p className="mb-1 text-xs text-ink-soft sm:text-sm" aria-live="polite">
        {state.source === 'recording'
          ? state.granularity === 'word'
            ? 'Recorded narration. Words light up using the recording’s word timings.'
            : 'Recorded narration. This recording has no word timings, so no words light up.'
          : state.granularity === 'sentence'
            ? 'Computer voice. This voice does not report word timing, so whole sentences light up.'
            : 'Computer voice. Words light up as the voice reads them. Your voice is not checked in Listen mode.'}
      </p>
      {state.status === 'error' ? <Alert tone="error" className="mb-1.5 py-1.5 text-sm">{state.message}</Alert> : null}
      <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
        {state.status === 'playing' ? (
          <Button variant="secondary" icon={<Pause size={22} />} onClick={() => narrator.pause()} className={`px-3 ${PRIMARY}`}>Pause</Button>
        ) : state.status === 'paused' ? (
          <Button icon={<Play size={22} />} onClick={() => narrator.resume()} className={`px-3 ${PRIMARY}`}>Continue</Button>
        ) : (
          <Button icon={<Play size={22} />} onClick={() => narrator.play(0)} className={`px-3 ${PRIMARY}`}>Play</Button>
        )}
        <IconButton variant="secondary" label="Replay from the start" icon={<RotateCcw size={20} />} onClick={() => narrator.play(0)} />
        <div role="group" aria-label="Speed" className="flex rounded-xl border-2 border-line bg-white p-0.5">
          {NARRATION_RATES.map((rate) => (
            <button key={rate} type="button" aria-pressed={state.rate === rate} onClick={() => narrator.setRate(rate)} className={`min-h-10 rounded-lg px-2 text-xs font-semibold sm:px-3 sm:text-sm ${state.rate === rate ? 'bg-teal-brand text-white' : ''}`}>
              {rate === 1 ? 'Normal' : rate < 1 ? 'Slower' : 'Faster'}
            </button>
          ))}
        </div>
        {tools}
      </div>
    </div>
  );
}
