import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Play, RotateCcw, UserCheck } from 'lucide-react';
import type { AssessmentSummary } from '../../assessment/scoring';
import type { LocalReward, ReadingSessionRecord } from '../../domain/types';
import { badgeByCode } from '../../rewards/rules';
import { formatDuration, percent } from '../../lib/format';
import { Alert, StatusBadge } from '../../ui/feedback';
import { Button, ButtonLink } from '../../ui/Button';
import { useApp } from '../../app/AppContext';
import { requestTeacherReview } from '../../data/sessions';
import { useLiveQuery } from 'dexie-react-hooks';

const UNASSESSED_TEXT: Record<string, string> = {
  recognition_unavailable: 'Word checking was not available on this device, so we did not check the words.',
  language_not_verified: 'Word checking is not available for this language yet, so we did not check the words.',
  no_speech_detected: 'We did not hear any reading, so there is nothing to check. Try again a little louder.',
  recognition_failed: 'Word following stopped working, so we could not check the words.',
  listen_mode: 'This was listening practice.',
};

const REVIEW_TEXT: Record<string, string> = {
  many_uncertain_words: 'Many words were hard to hear clearly.',
  recognition_interrupted: 'Word following stopped for part of the reading.',
  low_match_rate: 'Many words did not match. The microphone or a noisy room may be the cause.',
  too_few_words: 'Only a few words were checked.',
};

export function Measures({ a }: { a: AssessmentSummary }) {
  const rows: [string, string, string?][] = [
    ['Words in the story', String(a.totalWords)],
    ['Words checked', String(a.evaluatedWords)],
    ['Words matched', String(a.correctWords), a.selfCorrectedWords ? `including ${a.selfCorrectedWords} you fixed yourself` : undefined],
    ['Words to practice', String(a.skippedWords + a.substitutedWords), 'skipped or read differently'],
    ['Unsure words', String(a.uncertainWords), 'hard to hear; a grown-up can check'],
    ['Story covered', percent(a.coverage)],
    ['Reading time', formatDuration(a.practiceMs)],
    ['Correct words per minute', a.cwpm === null ? 'Not enough reading time' : String(a.cwpm)],
  ];
  return (
    <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {rows.map(([label, value, note]) => (
        <div key={label} className="rounded-xl border border-line bg-paper px-3 py-2">
          <dt className="text-sm text-ink-soft">{label}</dt>
          <dd className="text-xl font-bold">{value}{note ? <span className="ml-2 text-sm font-normal text-ink-soft">({note})</span> : null}</dd>
        </div>
      ))}
    </dl>
  );
}

export function RewardList({ awards }: { awards: LocalReward[] }) {
  if (!awards.length) return null;
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Badges">
      {awards.map((award) => {
        const badge = badgeByCode(award.badgeCode);
        return (
          <li key={award.id} className="flex items-center gap-2 rounded-xl border-2 border-sun bg-sun-tint px-3 py-2">
            <span aria-hidden="true" className="text-2xl">{badge?.icon ?? '⭐'}</span>
            <span>
              <span className="block font-semibold">{badge?.title ?? award.badgeCode}</span>
              <span className="text-sm text-ink-soft">
                {award.status === 'validated' ? 'Earned' : award.status === 'pending' ? 'Earned on this device · waiting to be checked' : 'Not confirmed'}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function ResultPanel({ session, awards, onReadAgain, onReviewWords }: { session: ReadingSessionRecord; awards: LocalReward[]; onReadAgain: () => void; onReviewWords: () => void }) {
  const { db, partition } = useApp();
  const a = session.assessment;
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const recording = useLiveQuery(() => db.recordings.get(session.id), [db, session.id]);
  const current = useLiveQuery(() => db.sessions.get(session.id), [db, session.id]) ?? session;

  useEffect(() => {
    if (!recording) return;
    const url = URL.createObjectURL(recording.blob);
    setAudioUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [recording]);

  return (
    <section aria-labelledby="result-title" className="space-y-4">
      <h2 id="result-title" className="text-2xl font-bold" tabIndex={-1}>
        {a?.status === 'unassessed' ? 'Practice saved' : 'Nice reading!'}
      </h2>

      {a?.status === 'unassessed' ? (
        <Alert tone="info" title="Practice saved—word assessment unavailable.">
          {UNASSESSED_TEXT[a.unassessedReason ?? 'recognition_unavailable']}
        </Alert>
      ) : a ? (
        <>
          <div className="flex flex-wrap gap-2">
            {a.completion === 'complete' ? (
              <StatusBadge tone="teal" icon="✓">Whole story read</StatusBadge>
            ) : (
              <StatusBadge tone="sun" icon="◐">Partial — part of the story was read</StatusBadge>
            )}
            {a.status === 'needs_review' ? <StatusBadge tone="blue" icon="👀">A teacher may check this reading</StatusBadge> : null}
          </div>
          {a.status === 'needs_review' && a.reviewReasons.length ? (
            <ul className="list-disc pl-5 text-ink-soft">{a.reviewReasons.map((r) => <li key={r}>{REVIEW_TEXT[r] ?? r}</li>)}</ul>
          ) : null}
          <Measures a={a} />
          <p className="text-sm text-ink-soft">
            Checked by matching what the speech recognizer heard ({a.engine?.processing === 'cloud' ? 'online service' : 'on this device'}) with the story.
            This is not a pronunciation score, and the recognizer can mishear words.
          </p>
        </>
      ) : null}

      <RewardList awards={awards} />

      {audioUrl ? (
        <div>
          <p className="mb-1 font-semibold">Listen to your reading</p>
          <audio controls src={audioUrl} className="w-full" />
          <p className="mt-1 text-sm text-ink-soft">
            {current.audio.status === 'uploaded' ? 'Shared with your teacher.' : current.audio.status === 'queued' ? 'Will be shared with your teacher when synced.' : 'Saved only on this device.'}
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button icon={<RotateCcw size={20} />} onClick={onReadAgain}>Read again</Button>
        {a && a.status !== 'unassessed' ? <Button variant="secondary" icon={<Play size={20} />} onClick={onReviewWords}>See the words to practice</Button> : null}
        {partition !== 'device' && !current.reviewRequested ? (
          <Button variant="secondary" icon={<UserCheck size={20} />} onClick={() => void requestTeacherReview(db, session.id)}>Ask my teacher to review</Button>
        ) : current.reviewRequested ? <StatusBadge tone="blue" icon="✓">Teacher review requested</StatusBadge> : null}
        <ButtonLink to="/stories" variant="ghost">Back to stories</ButtonLink>
      </div>
      {partition === 'device' ? (
        <p className="text-sm text-ink-soft">This reader is saved only on this device. <Link to="/account" className="underline">Sign in</Link> to share progress with a teacher.</p>
      ) : null}
    </section>
  );
}
