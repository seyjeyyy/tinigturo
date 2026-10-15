import { useState } from 'react';
import { Link } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { BookOpen, ClipboardList, History, PlayCircle } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { LearnerPicker } from '../learners/LearnerPicker';
import { avatarById } from '../../domain/types';
import { discardSession, findRecoverableSessions, listSavedSessions, recoverSession } from '../../data/sessions';
import { Alert, Card, EmptyState, PageHeader, StatusBadge } from '../../ui/feedback';
import { Button, ButtonLink } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { formatDateTime, formatDuration } from '../../lib/format';
import { RewardList } from '../reading/ResultPanel';

export function HomePage() {
  const { learner } = useApp();
  return learner ? <StudentHome /> : <LearnerPicker />;
}

function StudentHome() {
  const { db, learner, settings } = useApp();
  const learnerId = learner!.id;
  const recoverable = useLiveQuery(() => findRecoverableSessions(db, learnerId), [db, learnerId], []);
  const sessions = useLiveQuery(() => listSavedSessions(db, learnerId), [db, learnerId], []);
  const stories = useLiveQuery(() => db.stories.toArray(), [db], []);
  const assignments = useLiveQuery(() => db.assignments.filter((a) => !a.archivedAt).toArray(), [db], []);
  const rewards = useLiveQuery(() => db.rewards.where('learnerId').equals(learnerId).reverse().sortBy('awardedAt'), [db, learnerId], []);
  const [discardId, setDiscardId] = useState<string | null>(null);

  const storyTitle = (versionId: string) => stories.find((s) => s.id === versionId)?.title ?? 'A story';
  const last = sessions[0];
  const lastPartial = last?.mode === 'read_aloud' && last.assessment?.completion === 'partial' && last.wordResults
    ? Math.max(0, ...last.wordResults.filter((w) => w.status !== 'not_reached' && w.status !== 'unassessed').map((w) => w.index + 1))
    : 0;

  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const thisWeek = sessions.filter((s) => new Date(s.startedAt).getTime() > weekAgo);
  const weekMs = thisWeek.reduce((sum, s) => sum + s.timing.activeMs, 0);
  const myAssignments = assignments.filter((a) => learner!.classIds.length === 0 || learner!.classIds.includes(a.classId));

  return (
    <div className="space-y-6">
      <PageHeader title={`Hi, ${learner!.displayName}! ${avatarById(learner!.avatar).emoji}`} description="What would you like to read today?" />

      {recoverable.length ? (
        <Alert tone="warning" title="You have an unfinished reading">
          {recoverable.map((s) => (
            <div key={s.id} className="mt-2 flex flex-wrap items-center gap-2">
              <span>{storyTitle(s.storyVersionId)} · started {formatDateTime(s.startedAt)}</span>
              <Button size="sm" onClick={() => void recoverSession(db, s.id, settings.shareRecordings)}>Save what was read</Button>
              <Button size="sm" variant="ghost" onClick={() => setDiscardId(s.id)}>Throw it away</Button>
            </div>
          ))}
        </Alert>
      ) : null}

      {last ? (
        <Card>
          <h2 className="mb-2 flex items-center gap-2 text-lg font-bold"><History size={20} aria-hidden="true" />Continue reading</h2>
          <p className="mb-3">{storyTitle(last.storyVersionId)} · {formatDateTime(last.startedAt)}</p>
          <div className="flex flex-wrap gap-2">
            {lastPartial > 0 && lastPartial < (last.wordResults?.length ?? 0) ? (
              <ButtonLink to={`/read/${last.storyVersionId}?mode=read&from=${lastPartial}`} icon={<PlayCircle size={20} />}>Continue where you stopped</ButtonLink>
            ) : null}
            <ButtonLink to={`/read/${last.storyVersionId}?mode=${last.mode === 'listen' ? 'listen' : 'read'}`} variant={lastPartial ? 'secondary' : 'primary'} icon={<BookOpen size={20} />}>Read it again</ButtonLink>
          </div>
        </Card>
      ) : null}

      <Card>
        <h2 className="mb-2 flex items-center gap-2 text-lg font-bold"><ClipboardList size={20} aria-hidden="true" />From your teacher</h2>
        {myAssignments.length === 0 ? (
          <p className="text-ink-soft">No assigned stories right now. {learner!.origin === 'device' ? 'Assignments appear when a reader is linked to a class.' : ''}</p>
        ) : (
          <ul className="space-y-2">
            {myAssignments.map((a) => {
              const done = sessions.some((s) => s.assignmentId === a.id);
              const downloaded = stories.some((s) => s.id === a.storyVersionId);
              return (
                <li key={a.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-line p-2">
                  <span className="font-semibold">{a.title}</span>
                  <span className="text-sm text-ink-soft">{a.className}{a.dueAt ? ` · due ${formatDateTime(a.dueAt)}` : ''}</span>
                  {done ? <StatusBadge tone="teal" icon="✓">Done</StatusBadge> : <StatusBadge tone="sun" icon="○">To do</StatusBadge>}
                  <span className="ml-auto">
                    {downloaded
                      ? <ButtonLink size="sm" to={`/read/${a.storyVersionId}?assignment=${a.id}`}>Read</ButtonLink>
                      : <ButtonLink size="sm" variant="secondary" to="/stories?status=available">Download first</ButtonLink>}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className="mb-2 text-lg font-bold">This week</h2>
        {thisWeek.length === 0 ? (
          <EmptyState icon="🌱" title="No reading yet this week" action={<ButtonLink to="/stories">Find a story</ButtonLink>} />
        ) : (
          <p className="text-lg">You practiced <strong>{thisWeek.length}</strong> {thisWeek.length === 1 ? 'time' : 'times'} for <strong>{formatDuration(weekMs)}</strong>.</p>
        )}
        {rewards.length ? <div className="mt-3"><RewardList awards={rewards.slice(0, 4)} /></div> : null}
        <p className="mt-3"><Link to="/progress" className="font-semibold underline">See all your progress</Link></p>
      </Card>

      <Dialog
        open={discardId !== null}
        onClose={() => setDiscardId(null)}
        title="Throw away the unfinished reading?"
        footer={<><Button variant="secondary" onClick={() => setDiscardId(null)}>Keep it</Button><Button variant="danger" onClick={() => { void discardSession(db, discardId!); setDiscardId(null); }}>Throw it away</Button></>}
      >
        <p>The recording of this unfinished reading will be deleted from this device.</p>
      </Dialog>
    </div>
  );
}
