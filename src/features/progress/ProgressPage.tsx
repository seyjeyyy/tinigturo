import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useApp } from '../../app/AppContext';
import { deleteLocalRecording, listSavedSessions } from '../../data/sessions';
import { BADGES } from '../../rewards/rules';
import type { ReadingSessionRecord } from '../../domain/types';
import { tokenizePassage } from '../../text/tokenize';
import { formatDateTime, formatDuration, percent } from '../../lib/format';
import { Card, EmptyState, Loading, PageHeader, StatusBadge } from '../../ui/feedback';
import { Button, ButtonLink } from '../../ui/Button';
import { Measures, RewardList } from '../reading/ResultPanel';
import { Passage, WordLegend, type WordVisual } from '../reading/Passage';
import { DEFAULT_READING_PREFERENCES } from '../../domain/types';
import { Dialog } from '../../ui/Dialog';
import { fetchFeedback, type TeacherFeedbackRow } from '../../backend/accountApi';
import { getRubric, getSessionGrades, type GradeRow, type RubricRow } from '../../backend/teacherToolsApi';

export function SessionStatusBadges({ session }: { session: ReadingSessionRecord }) {
  const a = session.assessment;
  return (
    <span className="flex flex-wrap gap-1.5">
      {session.mode === 'listen' ? <StatusBadge icon="🎧">Listening</StatusBadge> : null}
      {a?.status === 'unassessed' && session.mode === 'read_aloud' ? <StatusBadge icon="○">Words not checked</StatusBadge> : null}
      {a?.completion === 'complete' ? <StatusBadge tone="teal" icon="✓">Whole story</StatusBadge> : null}
      {a?.completion === 'partial' ? <StatusBadge tone="sun" icon="◐">Partial</StatusBadge> : null}
      {a?.status === 'needs_review' ? <StatusBadge tone="blue" icon="👀">Teacher may check</StatusBadge> : null}
      {session.sync === 'pending' ? <StatusBadge icon="⇡">Waiting to sync</StatusBadge> : null}
      {session.sync === 'failed' ? <StatusBadge tone="danger" icon="!">Not synced</StatusBadge> : null}
      {session.recovered ? <StatusBadge icon="↺">Recovered</StatusBadge> : null}
    </span>
  );
}

export function ProgressPage() {
  const { db, learner } = useApp();
  const learnerId = learner!.id;
  const sessions = useLiveQuery(() => listSavedSessions(db, learnerId), [db, learnerId]);
  const rewards = useLiveQuery(() => db.rewards.where('learnerId').equals(learnerId).filter((r) => r.status !== 'not_confirmed').toArray(), [db, learnerId], []);
  const stories = useLiveQuery(() => db.stories.toArray(), [db], []);
  if (!sessions) return <Loading label="Loading your progress…" />;

  const read = sessions.filter((s) => s.mode === 'read_aloud');
  const days = new Set(sessions.map((s) => s.localDay)).size;
  const totalMs = sessions.reduce((sum, s) => sum + s.timing.activeMs, 0);
  const title = (id: string) => stories.find((s) => s.id === id)?.title ?? 'Story (removed from this device)';
  const participation = rewards.filter((r) => BADGES.find((b) => b.code === r.badgeCode)?.kind === 'participation');
  const performance = rewards.filter((r) => BADGES.find((b) => b.code === r.badgeCode)?.kind === 'performance');

  return (
    <div className="space-y-6">
      <PageHeader title="My progress" description="Only you and your grown-ups and teachers can see this." />
      {sessions.length === 0 ? (
        <EmptyState icon="🌱" title="No readings yet" action={<ButtonLink to="/stories">Start reading</ButtonLink>}>Your readings and badges will appear here.</EmptyState>
      ) : (
        <>
          <Card>
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div><dt className="text-sm text-ink-soft">Practice sessions</dt><dd className="text-2xl font-bold">{sessions.length}</dd></div>
              <div><dt className="text-sm text-ink-soft">Days you practiced</dt><dd className="text-2xl font-bold">{days}</dd></div>
              <div><dt className="text-sm text-ink-soft">Total practice time</dt><dd className="text-2xl font-bold">{formatDuration(totalMs)}</dd></div>
            </dl>
          </Card>
          <Card>
            <h2 className="mb-2 text-lg font-bold">Badges for practicing</h2>
            {participation.length ? <RewardList awards={participation} /> : <p className="text-ink-soft">Keep practicing to earn badges.</p>}
            <h2 className="mb-2 mt-4 text-lg font-bold">Badges for reading with word checking</h2>
            {performance.length ? <RewardList awards={performance} /> : <p className="text-ink-soft">These come from finished readings where the words were checked.</p>}
          </Card>
          <Card>
            <h2 className="mb-3 text-lg font-bold">Your readings</h2>
            <ul className="divide-y divide-line">
              {sessions.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
                  <Link to={`/progress/${s.id}`} className="font-semibold underline">{title(s.storyVersionId)}</Link>
                  <span className="text-sm text-ink-soft">{formatDateTime(s.startedAt)} · {formatDuration(s.timing.activeMs)}</span>
                  <SessionStatusBadges session={s} />
                  {s.mode === 'read_aloud' && s.assessment?.status !== 'unassessed' && s.assessment ? (
                    <span className="text-sm">
                      {s.assessment.correctWords} of {s.assessment.evaluatedWords} words matched · {percent(s.assessment.coverage)} covered
                      {s.assessment.cwpm !== null ? ` · ${s.assessment.cwpm} correct words/min` : ''}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            {read.length > 0 ? <p className="mt-3 text-sm text-ink-soft">“Matched” compares the speech recognizer’s transcript with the story. It is not a pronunciation score.</p> : null}
          </Card>
        </>
      )}
    </div>
  );
}

export function AttemptDetail() {
  const { sessionId = '' } = useParams();
  const { db, partition, online } = useApp();
  const session = useLiveQuery(() => db.sessions.get(sessionId), [db, sessionId]);
  const story = useLiveQuery(async () => (session ? (await db.stories.get(session.storyVersionId)) ?? null : undefined), [db, session?.storyVersionId]);
  const recording = useLiveQuery(() => db.recordings.get(sessionId), [db, sessionId]);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [feedback, setFeedback] = useState<TeacherFeedbackRow[]>([]);
  const [grades, setGrades] = useState<{ grade: GradeRow; rubric: RubricRow | null }[]>([]);
  const scrollRef = { current: null as HTMLElement | null };

  useEffect(() => {
    if (!recording) return;
    const url = URL.createObjectURL(recording.blob);
    setAudioUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [recording]);

  useEffect(() => {
    if (!session || partition === 'device' || !online || session.sync !== 'synced') return;
    fetchFeedback(session.learnerId).then((rows) => setFeedback(rows.filter((r) => r.session_id === session.id)), () => undefined);
    // Only published grades are visible to families (enforced by the server).
    getSessionGrades(session.id)
      .then((rows) => Promise.all(rows.filter((g) => g.status === 'published').map(async (grade) => ({ grade, rubric: await getRubric(grade.rubric_id).catch(() => null) }))))
      .then(setGrades, () => undefined);
  }, [session, partition, online]);

  const passage = useMemo(() => (story ? tokenizePassage(story.body, story.language) : null), [story]);
  if (session === undefined || story === undefined) return <Loading />;
  if (!session) return <EmptyState title="Reading not found" action={<ButtonLink to="/progress">Back</ButtonLink>} />;

  const visuals: (WordVisual[] | null)[] = passage ? new Array(passage.words.length).fill(null) : [];
  for (const w of session.wordResults ?? []) {
    if (w.status === 'correct' || w.status === 'self_corrected') visuals[w.index] = ['matched'];
    else if (w.status === 'uncertain' || w.status === 'substituted' || w.status === 'skipped') visuals[w.index] = ['review'];
    else if (w.status === 'unassessed') visuals[w.index] = ['unassessed'];
  }

  return (
    <div className="space-y-5">
      <PageHeader title={story?.title ?? 'Reading'} description={formatDateTime(session.startedAt)} actions={<ButtonLink variant="secondary" to="/progress">Back</ButtonLink>} />
      <SessionStatusBadges session={session} />
      {session.assessment && session.assessment.status !== 'unassessed' ? (
        <Card><Measures a={session.assessment} /></Card>
      ) : (
        <Card><p className="font-semibold">Practice saved—word assessment unavailable.</p><p className="text-ink-soft">Reading time: {formatDuration(session.timing.activeMs)}</p></Card>
      )}
      {grades.map(({ grade, rubric }) => (
        <Card key={grade.id}>
          <h2 className="mb-1 text-lg font-bold">Teacher’s grade: {grade.final_level}</h2>
          <p className="text-sm text-ink-soft">
            {rubric ? `${rubric.name} (version ${rubric.version})` : 'Rubric'} · published {formatDateTime(grade.published_at)}
            {grade.revision > 1 ? ' · updated by the teacher' : ''}
          </p>
          {rubric ? (
            <ul className="mt-2 space-y-1">
              {rubric.criteria.map((c) => (
                <li key={c.key}><strong>{c.label}:</strong> {c.levels.find((l) => l.value === grade.criterion_levels[c.key])?.label ?? '—'}</li>
              ))}
            </ul>
          ) : null}
          {grade.feedback ? <p className="mt-2 rounded-xl bg-paper p-3">{grade.feedback}</p> : null}
          <p className="mt-2 text-sm text-ink-soft">This grade is your teacher’s judgement. Badges are separate and do not affect it.</p>
        </Card>
      ))}
      {feedback.length ? (
        <Card>
          <h2 className="mb-2 text-lg font-bold">From your teacher</h2>
          <ul className="space-y-2">{feedback.map((f) => <li key={f.id} className="rounded-xl bg-paper p-3">{f.body}</li>)}</ul>
        </Card>
      ) : null}
      {audioUrl ? (
        <Card>
          <h2 className="mb-2 text-lg font-bold">Your recording</h2>
          <audio controls src={audioUrl} className="w-full" />
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-ink-soft">
            <span>{session.audio.status === 'uploaded' ? 'A copy is shared with your teacher.' : 'Saved on this device only.'}</span>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>Delete from this device</Button>
          </div>
        </Card>
      ) : null}
      {passage && session.wordResults ? (
        <Card>
          <div className="mb-3"><WordLegend mode="result" /></div>
          <Passage passage={passage} visuals={visuals} focusIndex={null} onWordSelect={() => undefined} textSize={DEFAULT_READING_PREFERENCES.textSize} lineSpacing="relaxed" scrollContainer={scrollRef} label="Story with word results" />
        </Card>
      ) : null}
      {!story ? <p className="text-ink-soft">The story text is no longer on this device, but the results are kept.</p> : null}
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this recording from this device?"
        footer={<><Button variant="secondary" onClick={() => setConfirmDelete(false)}>Keep it</Button><Button variant="danger" onClick={() => { void deleteLocalRecording(db, session.id); setConfirmDelete(false); }}>Delete</Button></>}
      >
        <p>The reading results stay. {session.audio.status === 'uploaded' ? 'The copy shared with your teacher is kept according to the class recording policy.' : 'If the recording was waiting to be shared, it will not be shared.'}</p>
      </Dialog>
    </div>
  );
}
