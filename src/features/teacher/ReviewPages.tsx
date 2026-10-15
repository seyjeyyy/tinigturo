import { useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Headphones } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import {
  addCorrection, addFeedback, getSessionDetail, markReviewed, reviewQueue, signedAudioUrl, type SessionDetail,
} from '../../backend/teacherApi';
import type { FinalWordStatus } from '../../alignment/aligner';
import { rescoreWithCorrections, type AssessmentSummary } from '../../assessment/scoring';
import { tokenizePassage } from '../../text/tokenize';
import { useAsync } from '../../lib/useAsync';
import { formatDateTime, formatDuration, percent } from '../../lib/format';
import { Alert, Card, EmptyState, Loading, PageHeader, StatusBadge } from '../../ui/feedback';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { SelectField, TextArea, TextField } from '../../ui/fields';
import { Passage, WordLegend, type WordVisual } from '../reading/Passage';

const REASONS: Record<string, string> = {
  many_uncertain_words: 'Many uncertain words',
  recognition_interrupted: 'Recognition was interrupted',
  low_match_rate: 'Low match rate (possible noise or mic issue)',
  too_few_words: 'Very few words checked',
};

const STATUS_LABEL: Record<FinalWordStatus, string> = {
  correct: 'Read correctly',
  self_corrected: 'Self-corrected',
  uncertain: 'Uncertain',
  substituted: 'Read as a different word',
  skipped: 'Skipped',
  unassessed: 'Not assessed',
  not_reached: 'Not reached',
};

export function ReviewQueuePage() {
  const queue = useAsync(reviewQueue, []);
  return (
    <div>
      <PageHeader title="Attempts to review" description="Readings with uncertain results, review requests, or recordings without word checking." />
      {queue.loading ? <Loading /> : queue.error ? <Alert tone="error">{queue.error.message}</Alert> : queue.data!.length === 0 ? (
        <EmptyState icon="✅" title="Nothing waiting for review" />
      ) : (
        <ul className="divide-y divide-line rounded-2xl border-2 border-line bg-white">
          {queue.data!.map((row) => (
            <li key={row.session_id} className="flex flex-wrap items-center gap-2 p-3">
              <Link to={`/teacher/review/${row.session_id}`} className="font-semibold underline">{row.learner_name} — {row.story_title}</Link>
              <span className="text-sm text-ink-soft">{row.class_name} · {formatDateTime(row.started_at)}</span>
              {row.review_requested ? <StatusBadge tone="blue" icon="✋">Review requested</StatusBadge> : null}
              {row.status === 'unassessed' ? <StatusBadge icon="○">Not checked automatically</StatusBadge> : null}
              {row.review_reasons.map((r) => <StatusBadge key={r} tone="sun" icon="⚠">{REASONS[r] ?? r}</StatusBadge>)}
              {row.audio_status === 'uploaded' ? <StatusBadge tone="teal" icon={<Headphones size={14} />}>Recording</StatusBadge> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function toSummary(d: SessionDetail): AssessmentSummary | null {
  const a = d.session_assessments;
  if (!a) return null;
  return {
    scoringVersion: a.scoring_version, alignerVersion: a.aligner_version, normalizerVersion: a.normalizer_version ?? 0,
    method: a.method as AssessmentSummary['method'], engine: a.engine_id ? { id: a.engine_id, version: a.engine_version ?? '', processing: 'on_device' } : null,
    status: a.status as AssessmentSummary['status'], completion: a.completion as AssessmentSummary['completion'], unassessedReason: null, reviewReasons: (a.review_reasons ?? []) as AssessmentSummary['reviewReasons'],
    totalWords: a.total_words, evaluatedWords: a.evaluated_words, correctWords: a.correct_words, selfCorrectedWords: 0, uncertainWords: a.uncertain_words,
    substitutedWords: a.substituted_words, skippedWords: a.skipped_words, unassessedWords: 0, notReachedWords: 0, insertions: a.insertions, repetitions: a.repetitions,
    coverage: Number(a.coverage), practiceMs: d.active_ms, assessedMs: a.assessed_ms, cwpm: a.cwpm === null ? null : Number(a.cwpm),
  };
}

export function ReviewSessionPage() {
  const { sessionId = '' } = useParams();
  const { auth } = useApp();
  const detail = useAsync(() => getSessionDetail(sessionId), [sessionId]);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [word, setWord] = useState<number | null>(null);
  const [newStatus, setNewStatus] = useState<FinalWordStatus>('correct');
  const [reason, setReason] = useState('');
  const [feedback, setFeedback] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const d = detail.data;
  const passage = useMemo(() => (d?.story_versions ? tokenizePassage(d.story_versions.body, d.story_versions.language) : null), [d]);
  const corrections = useMemo(() => {
    const map = new Map<number, FinalWordStatus>();
    for (const c of [...(d?.assessment_corrections ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
      if (c.word_index !== null) map.set(c.word_index, c.corrected_status);
    }
    return map;
  }, [d]);

  if (detail.loading) return <Loading />;
  if (detail.error || !d) return <Alert tone="error">This attempt could not be loaded, or you are not a teacher of this learner.</Alert>;

  const words = (d.word_results ?? []).map((w) => ({ index: w.word_index, status: w.status, heard: w.heard }));
  const machine = toSummary(d);
  const timing = { activeMs: d.active_ms, pausedMs: d.paused_ms, interruptedMs: 0, assessedMs: d.assessed_ms };
  const reviewed = machine && corrections.size && words.length ? rescoreWithCorrections(words, corrections, timing, machine) : null;
  const statusAt = (i: number) => corrections.get(i) ?? words.find((w) => w.index === i)?.status ?? 'not_reached';
  const visuals: (WordVisual[] | null)[] = passage ? passage.words.map((_, i) => {
    const s = statusAt(i);
    if (s === 'correct' || s === 'self_corrected') return ['matched'];
    if (s === 'uncertain' || s === 'substituted' || s === 'skipped') return ['review'];
    if (s === 'unassessed') return ['unassessed'];
    return null;
  }) : [];

  const run = async (fn: () => Promise<unknown>, success: string) => {
    setMessage(null);
    try {
      await fn();
      setMessage({ tone: 'success', text: success });
      detail.reload();
    } catch (e) {
      setMessage({ tone: 'error', text: (e as Error).message });
    }
  };

  const loadAudio = async () => {
    setAudioError(null);
    try {
      setAudioUrl(await signedAudioUrl(d.audio_path!));
    } catch {
      setAudioError('The recording could not be opened. It may have been deleted under the retention policy.');
    }
  };

  const heard = word !== null ? words.find((w) => w.index === word)?.heard : null;

  return (
    <div className="space-y-4">
      <PageHeader title={`${d.learners?.display_name} — ${d.story_versions?.title}`} description={<><Link to="/teacher/review" className="underline">Review queue</Link> · {formatDateTime(d.started_at)} · {d.mode === 'listen' ? 'Listening' : 'Read aloud'}</>} />
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mb-2 text-lg font-bold">Automatic result</h2>
          {machine && machine.status !== 'unassessed' ? (
            <ul className="space-y-1">
              <li>Status: <strong>{machine.status === 'needs_review' ? 'Needs review' : 'Assessed'}</strong>, {machine.completion === 'complete' ? 'whole story' : 'partial'}</li>
              <li>Matched {machine.correctWords} of {machine.evaluatedWords} checked words ({machine.totalWords} in story) · coverage {percent(machine.coverage)}</li>
              <li>Uncertain {machine.uncertainWords} · different word {machine.substitutedWords} · skipped {machine.skippedWords}</li>
              <li>CWPM: {machine.cwpm ?? 'not computed (too short)'} · practice {formatDuration(d.active_ms)}</li>
              <li className="text-sm text-ink-soft">Method: {d.session_assessments?.method}, engine {d.session_assessments?.engine_id} {d.session_assessments?.engine_version}, scoring {machine.scoringVersion}</li>
              {machine.reviewReasons.map((r) => <li key={r}><StatusBadge tone="sun" icon="⚠">{REASONS[r] ?? r}</StatusBadge></li>)}
            </ul>
          ) : <p>Not checked automatically ({d.recognition_plan === 'none' ? 'no speech recognition on the device' : 'no speech recognized'}).</p>}
          {reviewed ? (
            <div className="mt-3 rounded-xl border border-teal-brand bg-teal-tint p-3">
              <p className="font-semibold">After your corrections</p>
              <p>Matched {reviewed.correctWords} of {reviewed.evaluatedWords} · coverage {percent(reviewed.coverage)} · CWPM {reviewed.cwpm ?? '—'}</p>
              <p className="text-sm text-ink-soft">The automatic result is kept unchanged; corrections are recorded separately with your name and time.</p>
            </div>
          ) : null}
        </Card>
        <Card>
          <h2 className="mb-2 text-lg font-bold">Recording</h2>
          {d.audio_status === 'uploaded' && d.audio_path ? (
            audioUrl ? <audio controls src={audioUrl} className="w-full" /> : <Button variant="secondary" icon={<Headphones size={20} />} onClick={() => void loadAudio()}>Listen to the recording</Button>
          ) : <p className="text-ink-soft">{d.audio_status === 'deleted' ? 'The recording was deleted.' : 'No recording was shared for this attempt.'}</p>}
          {audioError ? <Alert tone="error" className="mt-2">{audioError}</Alert> : null}
          {d.audio_expires_at ? <p className="mt-2 text-sm text-ink-soft">Will be deleted after {formatDateTime(d.audio_expires_at)}.</p> : null}
        </Card>
      </div>

      {passage ? (
        <Card>
          <h2 className="mb-2 text-lg font-bold">Words</h2>
          <p className="mb-2 text-sm text-ink-soft">Select a word to see what the recognizer heard and to record a correction.</p>
          <div className="mb-3"><WordLegend mode="result" /></div>
          <div ref={scrollRef} className="max-h-[60dvh] overflow-y-auto">
            <Passage passage={passage} visuals={visuals} focusIndex={null} onWordSelect={(i) => { setWord(i); setNewStatus(statusAt(i) === 'correct' ? 'substituted' : 'correct'); }} textSize="md" lineSpacing="relaxed" scrollContainer={scrollRef} label="Story with results" selectedIndex={word} />
          </div>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mb-2 text-lg font-bold">Feedback for the learner</h2>
          <TextArea label="Message" value={feedback} onChange={(e) => setFeedback(e.target.value)} maxLength={1000} rows={3} />
          <Button className="mt-2" disabled={!feedback.trim()} onClick={() => void run(() => addFeedback({ sessionId: d.id, learnerId: d.learner_id, authorId: auth.userId!, body: feedback.trim() }).then(() => setFeedback('')), 'Feedback saved.')}>Send feedback</Button>
          <ul className="mt-3 space-y-2">{d.teacher_feedback.map((f) => <li key={f.id} className="rounded-xl bg-paper p-2 text-sm">{f.body} <span className="text-ink-soft">· {formatDateTime(f.created_at)}</span></li>)}</ul>
        </Card>
        <Card>
          <h2 className="mb-2 text-lg font-bold">Finish review</h2>
          <TextField label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
          <Button className="mt-2" onClick={() => void run(() => markReviewed(d.id, note), 'Marked as reviewed.')} disabled={d.session_reviews.length > 0}>
            {d.session_reviews.length ? 'Already reviewed' : 'Mark as reviewed'}
          </Button>
          {d.assessment_corrections.length ? (
            <>
              <h3 className="mb-1 mt-4 font-semibold">Correction history</h3>
              <ul className="space-y-1 text-sm">
                {d.assessment_corrections.map((c) => (
                  <li key={c.id}>Word {c.word_index !== null ? `“${passage?.words[c.word_index]?.core ?? c.word_index}”` : ''}: {c.previous_status ? STATUS_LABEL[c.previous_status as FinalWordStatus] : '—'} → {STATUS_LABEL[c.corrected_status]} · {formatDateTime(c.created_at)}{c.reason ? ` · ${c.reason}` : ''}</li>
                ))}
              </ul>
            </>
          ) : null}
        </Card>
      </div>

      <Dialog
        open={word !== null}
        onClose={() => setWord(null)}
        title={`Word: “${word !== null ? passage?.words[word]?.core : ''}”`}
        footer={<><Button variant="secondary" onClick={() => setWord(null)}>Cancel</Button><Button onClick={() => { const i = word!; setWord(null); void run(() => addCorrection(d.id, i, newStatus, reason).then(() => setReason('')), 'Correction recorded.'); }}>Record correction</Button></>}
      >
        <p>Automatic result: <strong>{word !== null ? STATUS_LABEL[words.find((w) => w.index === word)?.status ?? 'not_reached'] : ''}</strong>{heard ? <> (recognizer heard “{heard}”)</> : null}</p>
        {word !== null && corrections.has(word) ? <p>Current correction: <strong>{STATUS_LABEL[corrections.get(word)!]}</strong></p> : null}
        <div className="mt-3 space-y-3">
          <SelectField label="Change to" value={newStatus} onChange={(e) => setNewStatus(e.target.value as FinalWordStatus)}>
            {(['correct', 'self_corrected', 'substituted', 'skipped', 'uncertain', 'unassessed'] as FinalWordStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </SelectField>
          <TextField label="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} hint="For example: heard clearly on the recording." />
        </div>
      </Dialog>
    </div>
  );
}
