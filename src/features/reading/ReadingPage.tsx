import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useBlocker, useNavigate, useParams, useSearchParams, Link } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowLeft, CircleHelp, Flag, Headphones, Mic, Minus, Pause, Play, Plus, RotateCcw, Square, Rows3,
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
import { useReadAloud } from './useReadAloud';
import { UpdateBanner } from '../../pwa/UpdateBanner';
import { Button, IconButton } from '../../ui/Button';
import { Alert, EmptyState, Loading } from '../../ui/feedback';
import { Dialog } from '../../ui/Dialog';
import { downloadBlob } from '../../lib/csv';
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

  const begin = async () => {
    setShowResultWords(false);
    await controller?.begin();
    if (startFrom > 0) controller?.continueFrom(startFrom);
  };

  // Listen mode narrator.
  const [narrator, setNarrator] = useState<Narrator | null>(null);
  useEffect(() => {
    if (mode !== 'listen') return;
    let disposed = false;
    let instance: Narrator | null = null;
    void (async () => {
      if (story.narration?.timings.length) {
        const blob = await db.recordings.get(`narration:${story.id}`);
        if (blob) instance = new AudioNarrator(passage, URL.createObjectURL(blob.blob), story.narration.timings);
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
  }, [mode, passage, story, db]);

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

  return (
    <div className="flex h-dvh flex-col bg-paper">
      <a href="#passage" className="skip-link">Skip to story</a>
      <UpdateBanner hideWhileRecording />
      <header className="flex flex-wrap items-center gap-2 border-b-2 border-line px-3 py-2">
        <IconButton label="Back to stories" icon={<ArrowLeft size={22} />} onClick={() => navigate('/stories')} />
        <h1 className="mr-auto min-w-0 flex-1 truncate text-lg font-bold sm:text-xl">{story.title}</h1>
        <div role="group" aria-label="Reading mode" className="flex rounded-xl border-2 border-line bg-white p-0.5">
          {(['read', 'listen'] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              disabled={unsaved || status === 'requesting_permission'}
              onClick={() => setParams((p) => { p.set('mode', m); return p; }, { replace: true })}
              className={`inline-flex min-h-10 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold disabled:opacity-50 ${mode === m ? 'bg-teal-brand text-white' : 'text-ink'}`}
            >
              {m === 'read' ? <Mic size={16} aria-hidden="true" /> : <Headphones size={16} aria-hidden="true" />}
              {m === 'read' ? 'Read aloud' : 'Listen'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1" role="group" aria-label="Text size and spacing">
          <IconButton size="sm" label="Smaller text" icon={<Minus size={18} />} disabled={prefs.textSize === SIZES[0]} onClick={() => setPrefs({ textSize: SIZES[Math.max(0, SIZES.indexOf(prefs.textSize) - 1)] })} />
          <span aria-hidden="true" className="font-bold">A</span>
          <IconButton size="sm" label="Bigger text" icon={<Plus size={18} />} disabled={prefs.textSize === SIZES[SIZES.length - 1]} onClick={() => setPrefs({ textSize: SIZES[Math.min(SIZES.length - 1, SIZES.indexOf(prefs.textSize) + 1)] })} />
          <IconButton size="sm" label={`Line spacing: ${prefs.lineSpacing}. Change`} icon={<Rows3 size={18} />} onClick={() => setPrefs({ lineSpacing: SPACINGS[(SPACINGS.indexOf(prefs.lineSpacing) + 1) % SPACINGS.length] })} />
        </div>
      </header>

      <div ref={scrollRef} id="passage" className="relative flex-1 overflow-y-auto px-4 py-6 sm:px-8" tabIndex={-1}>
        {mode === 'read' && result && !showResultWords ? (
          <div className="mx-auto max-w-2xl">
            <ResultPanel
              session={result.session}
              awards={result.awards}
              onReadAgain={() => controller?.reset()}
              onReviewWords={() => setShowResultWords(true)}
            />
          </div>
        ) : (
          <>
          {mode === 'read' && (status === 'recording' || status === 'paused' || showResultWords) ? (
            <div className="mx-auto mb-4 max-w-[44rem]"><WordLegend mode={showResultWords ? 'result' : 'read'} /></div>
          ) : null}
          <Passage
            passage={passage}
            visuals={visuals}
            selectedIndex={coachIndex ?? cursor}
            focusIndex={mode === 'listen' ? null : focusIndex}
            onWordSelect={(i) => setCoachIndex(i)}
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

      <footer className="border-t-2 border-line bg-white px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
        <div className="mx-auto max-w-4xl">
          {mode === 'read' ? (
            <ReadAloudBar
              status={status}
              snapshot={snapshot}
              plan={plan}
              planText={planText}
              resultShowingWords={Boolean(result && showResultWords)}
              onStart={() => void begin()}
              onPause={() => controller?.pause()}
              onContinue={() => controller?.resume()}
              onFinish={() => void controller?.finish()}
              onRetry={() => void begin()}
              onBackToResult={() => setShowResultWords(false)}
              onHelp={() => setHelpOpen(true)}
              language={story.language}
            />
          ) : (
            <ListenBar
              narrator={narrator}
              onHelp={() => setHelpOpen(true)}
              onFinished={(ms, startedAt) => learner && void saveListenSession(db, { learnerId: learner.id, story, assignmentId, startedAt, listenedMs: ms })}
            />
          )}
        </div>
      </footer>

      <WordCoach
        word={coachIndex !== null ? passage.words[coachIndex] : null}
        story={story}
        open={coachIndex !== null}
        onClose={() => setCoachIndex(null)}
        playSuspended={playSuspended}
        onContinueFromHere={canContinueFromHere ? (i) => {
          controller?.continueFrom(i);
          setCoachIndex(null);
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
            <Button onClick={async () => { await controller?.finish(); blocker.proceed?.(); }}>Save and leave</Button>
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

function Notice({ text, tone = 'info' }: { text: string; tone?: 'info' | 'warning' | 'error' }) {
  return <Alert tone={tone} className="mb-2 py-2">{text}</Alert>;
}

function ReadAloudBar(props: {
  status: string;
  snapshot: ReturnType<typeof useReadAloud>['snapshot'];
  plan: RecognitionPlan | null;
  planText: string;
  resultShowingWords: boolean;
  onStart: () => void;
  onPause: () => void;
  onContinue: () => void;
  onFinish: () => void;
  onRetry: () => void;
  onBackToResult: () => void;
  onHelp: () => void;
  language: StoryVersionRecord['language'];
}) {
  const { status, snapshot, plan } = props;
  const { settings } = useApp();
  // Exactly one message at a time, chosen by priority.
  let message: React.ReactNode = null;
  if (status === 'error' && snapshot?.recording.status === 'error') {
    const error = (snapshot.recording as { error: RecordingError }).error;
    message = (
      <Alert tone="error" title={error.message} className="mb-2">
        {error.help}
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
    message = (
      <Notice
        text={`${plan.explanation}${plan.reason === 'recognition_unavailable' && !settings.allowCloudRecognition ? ' A grown-up can allow online word checking in Settings.' : ''}`}
      />
    );
  } else if (status === 'idle' && plan?.kind === 'cloud') {
    message = <Notice text="Online word checking is on: your voice is sent to the browser’s speech service while you read." />;
  }

  const live = snapshot?.alignment;
  const progress = live && live.confirmedThrough >= 0 ? `${live.confirmedThrough + 1} words followed` : null;

  return (
    <div>
      <div aria-live="polite">{message}</div>
      <div className="flex flex-wrap items-center gap-2">
        {status === 'idle' || status === 'error' ? (
          <Button size="lg" icon={<Mic size={22} />} onClick={status === 'error' ? props.onRetry : props.onStart} disabled={!plan}>
            {status === 'error' ? 'Try again' : 'Start'}
          </Button>
        ) : null}
        {status === 'requesting_permission' ? <Button size="lg" busy disabled>Starting…</Button> : null}
        {status === 'recording' ? (
          <>
            <Button size="lg" variant="secondary" icon={<Pause size={22} />} onClick={props.onPause}>Pause</Button>
            <Button size="lg" icon={<Flag size={22} />} onClick={props.onFinish}>Finish</Button>
          </>
        ) : null}
        {status === 'paused' ? (
          <>
            <Button size="lg" icon={<Play size={22} />} onClick={props.onContinue}>Continue</Button>
            <Button size="lg" variant="secondary" icon={<Flag size={22} />} onClick={props.onFinish}>Finish</Button>
          </>
        ) : null}
        {status === 'processing' ? <Button size="lg" busy disabled>Saving your reading…</Button> : null}
        {status === 'result' && props.resultShowingWords ? (
          <Button size="lg" variant="secondary" icon={<Square size={20} />} onClick={props.onBackToResult}>Back to results</Button>
        ) : null}
        <Button size="lg" variant="ghost" icon={<CircleHelp size={22} />} onClick={props.onHelp}>Help</Button>
        <div className="ml-auto flex items-center gap-3 text-sm text-ink-soft">
          {status === 'recording' ? (
            <span className="flex items-center gap-2">
              <span className="relative inline-flex h-3 w-3 rounded-full bg-danger" aria-hidden="true" />
              <span>Recording{snapshot?.following ? ' · following your voice' : ''}</span>
            </span>
          ) : status === 'paused' ? <span>Paused</span> : null}
          {progress && (status === 'recording' || status === 'paused') ? <span className="hidden sm:inline">{progress}</span> : null}
          {status === 'recording' ? (
            <span className="h-2 w-16 overflow-hidden rounded-full bg-line" aria-hidden="true">
              <span className="level-meter block h-full bg-teal-brand" style={{ width: `${Math.round((snapshot?.level ?? 0) * 100)}%` }} />
            </span>
          ) : null}
        </div>
      </div>
      {status === 'idle' && props.language === 'fil' && !LANGUAGES.fil.assessmentVerified ? (
        <p className="mt-1 text-xs text-ink-soft">Filipino word checking is turned off until it has been tested with Filipino speech.</p>
      ) : null}
    </div>
  );
}

function ListenBar({ narrator, onHelp, onFinished }: { narrator: Narrator | null; onHelp: () => void; onFinished: (ms: number, startedAt: Date) => void }) {
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

  if (!narrator || !state) return <Loading label="Getting the voice ready…" />;
  if (state.status === 'unavailable') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Alert tone="info" className="flex-1">{state.message}</Alert>
        <Button size="lg" variant="ghost" icon={<CircleHelp size={22} />} onClick={onHelp}>Help</Button>
      </div>
    );
  }
  return (
    <div>
      <p className="mb-2 text-sm text-ink-soft" aria-live="polite">
        {state.source === 'recording'
          ? 'Recorded narration. Words light up using the recording’s word timings.'
          : state.granularity === 'sentence'
            ? 'Computer voice. This voice does not report word timing, so whole sentences light up.'
            : 'Computer voice. Words light up as the voice reads them. Your voice is not checked in Listen mode.'}
      </p>
      {state.status === 'error' ? <Alert tone="error" className="mb-2">{state.message}</Alert> : null}
      <div className="flex flex-wrap items-center gap-2">
        {state.status === 'playing' ? (
          <Button size="lg" variant="secondary" icon={<Pause size={22} />} onClick={() => narrator.pause()}>Pause</Button>
        ) : state.status === 'paused' ? (
          <Button size="lg" icon={<Play size={22} />} onClick={() => narrator.resume()}>Continue</Button>
        ) : (
          <Button size="lg" icon={<Play size={22} />} onClick={() => narrator.play(0)}>Play</Button>
        )}
        <Button size="lg" variant="secondary" icon={<RotateCcw size={20} />} onClick={() => narrator.play(0)}>Replay</Button>
        <div role="group" aria-label="Speed" className="flex rounded-xl border-2 border-line bg-white p-0.5">
          {NARRATION_RATES.map((rate) => (
            <button key={rate} type="button" aria-pressed={state.rate === rate} onClick={() => narrator.setRate(rate)} className={`min-h-10 rounded-lg px-3 text-sm font-semibold ${state.rate === rate ? 'bg-teal-brand text-white' : ''}`}>
              {rate === 1 ? 'Normal' : rate < 1 ? 'Slower' : 'Faster'}
            </button>
          ))}
        </div>
        <Button size="lg" variant="ghost" icon={<CircleHelp size={22} />} onClick={onHelp}>Help</Button>
      </div>
    </div>
  );
}

