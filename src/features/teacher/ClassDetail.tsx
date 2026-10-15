import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { Download, UserPlus } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import {
  addRosterLearner, archiveAssignment, classAttempts, classProgress, createAssignment, decideEnrollment, getClass, listAssignableStories,
  listAssignments, listRoster, regenerateJoinCode, removeMember, setJoinCodeEnabled, setRecordingPolicy,
} from '../../backend/teacherApi';
import { useAsync } from '../../lib/useAsync';
import { toCsv, downloadText } from '../../lib/csv';
import { ATTEMPT_CSV_HEADER, attemptCsvRow } from './attemptExport';
import { formatDate, formatDateTime, formatDuration, percent } from '../../lib/format';
import { uuid } from '../../lib/ids';
import { AVATARS, avatarById, type AvatarId } from '../../domain/types';
import { Alert, Card, EmptyState, Loading, PageHeader, StatusBadge } from '../../ui/feedback';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { SelectField, TextField, Toggle } from '../../ui/fields';
import { AvatarChooser } from '../learners/LearnerPicker';

type Tab = 'roster' | 'assignments' | 'progress' | 'settings';
const TABS: { id: Tab; label: string }[] = [
  { id: 'roster', label: 'Learners' },
  { id: 'assignments', label: 'Assignments' },
  { id: 'progress', label: 'Progress' },
  { id: 'settings', label: 'Class settings' },
];

export function ClassDetail() {
  const { classId = '' } = useParams();
  const klass = useAsync(() => getClass(classId), [classId]);
  const [tab, setTab] = useState<Tab>('roster');
  if (klass.loading) return <Loading />;
  if (klass.error || !klass.data) return <Alert tone="error">This class could not be loaded, or you are not one of its teachers.</Alert>;
  const c = klass.data;
  return (
    <div>
      <PageHeader title={c.name} description={<Link to="/teacher" className="underline">All classes</Link>} />
      <div role="tablist" aria-label="Class sections" className="mb-5 flex gap-1 overflow-x-auto">
        {TABS.map((t) => (
          <button key={t.id} role="tab" type="button" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} onClick={() => setTab(t.id)}
            className={`min-h-11 rounded-lg px-4 font-semibold ${tab === t.id ? 'bg-teal-brand text-white' : 'bg-white text-ink'}`}>
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'roster' ? <RosterTab classId={classId} /> : null}
        {tab === 'assignments' ? <AssignmentsTab classId={classId} /> : null}
        {tab === 'progress' ? <ProgressTab classId={classId} className={c.name} /> : null}
        {tab === 'settings' ? <SettingsTab klass={c} onChange={klass.reload} /> : null}
      </div>
    </div>
  );
}

function RosterTab({ classId }: { classId: string }) {
  const roster = useAsync(() => listRoster(classId), [classId]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState<AvatarId>(AVATARS[0].id);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      roster.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (roster.loading) return <Loading />;
  if (roster.error) return <Alert tone="error">{roster.error.message}</Alert>;
  const pending = roster.data!.filter((r) => r.status === 'pending');
  const active = roster.data!.filter((r) => r.status === 'active');

  return (
    <div className="space-y-5">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Card>
        <h2 className="mb-2 text-lg font-bold">Requests to join ({pending.length})</h2>
        {pending.length === 0 ? <p className="text-ink-soft">No requests waiting. Parents send requests with the class code.</p> : (
          <ul className="divide-y divide-line">
            {pending.map((r) => (
              <li key={r.learner_id} className="flex flex-wrap items-center gap-2 py-2">
                <span aria-hidden="true">{avatarById(r.learners?.avatar ?? 'owl').emoji}</span>
                <span className="font-semibold">{r.learners?.display_name ?? 'Learner'}</span>
                <span className="text-sm text-ink-soft">asked {formatDate(r.created_at)}</span>
                <span className="ml-auto flex gap-2">
                  <Button size="sm" onClick={() => void act(() => decideEnrollment(classId, r.learner_id, true))}>Approve</Button>
                  <Button size="sm" variant="secondary" onClick={() => void act(() => decideEnrollment(classId, r.learner_id, false))}>Decline</Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-bold">Learners ({active.length})</h2>
          <Button size="sm" variant="secondary" icon={<UserPlus size={18} />} onClick={() => setAdding(true)}>Add learner for a classroom device</Button>
        </div>
        {active.length === 0 ? <EmptyState icon="🧒" title="No learners yet" /> : (
          <ul className="divide-y divide-line">
            {active.map((r) => (
              <li key={r.learner_id} className="flex flex-wrap items-center gap-2 py-2">
                <span aria-hidden="true">{avatarById(r.learners?.avatar ?? 'owl').emoji}</span>
                <span className="font-semibold">{r.learners?.display_name}</span>
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setRemoving(r.learner_id)}>Remove from class</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Dialog open={adding} onClose={() => setAdding(false)} title="Add a learner" size="lg">
        <form className="space-y-4" onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return setError('Type a first name or nickname.');
          void act(() => addRosterLearner(classId, { id: uuid(), displayName: name.trim(), avatar, gradeLevel: null })).then(() => {
            setAdding(false);
            setName('');
          });
        }}>
          <TextField label="First name or nickname" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} hint="Use first names or nicknames only." />
          <AvatarChooser value={avatar} onChange={setAvatar} />
          <p className="text-sm text-ink-soft">For learners who read on a classroom device you manage. Parents can instead request to join with the class code.</p>
          <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setAdding(false)}>Cancel</Button><Button type="submit">Add learner</Button></div>
        </form>
      </Dialog>
      <Dialog open={removing !== null} onClose={() => setRemoving(null)} title="Remove from class?"
        footer={<><Button variant="secondary" onClick={() => setRemoving(null)}>Cancel</Button><Button variant="danger" onClick={() => { void act(() => removeMember(classId, removing!)); setRemoving(null); }}>Remove</Button></>}>
        <p>You will no longer see this learner’s readings. Their own records are kept for their guardian.</p>
      </Dialog>
    </div>
  );
}

function AssignmentsTab({ classId }: { classId: string }) {
  const { auth } = useApp();
  const assignments = useAsync(() => listAssignments(classId), [classId]);
  const stories = useAsync(listAssignableStories, []);
  const [storyId, setStoryId] = useState('');
  const [due, setDue] = useState('');
  const [instructions, setInstructions] = useState('');
  const [error, setError] = useState<string | null>(null);

  const assign = async (event: React.FormEvent) => {
    event.preventDefault();
    const story = stories.data?.find((s) => s.id === storyId);
    if (!story?.published_version_id) return setError('Choose a published story.');
    try {
      await createAssignment({ classId, storyId: story.id, storyVersionId: story.published_version_id, dueAt: due ? new Date(due).toISOString() : null, instructions, userId: auth.userId! });
      setStoryId('');
      setInstructions('');
      assignments.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="space-y-5">
      <Card>
        <h2 className="mb-3 text-lg font-bold">Assign a story</h2>
        <form onSubmit={assign} className="grid gap-3 md:grid-cols-3">
          <SelectField label="Story" value={storyId} onChange={(e) => setStoryId(e.target.value)}>
            <option value="">Choose a published story</option>
            {stories.data?.map((s) => <option key={s.id} value={s.id}>{s.draft_title} (Grade {s.grade_level})</option>)}
          </SelectField>
          <TextField label="Due (optional)" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          <TextField label="Note for learners (optional)" value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={300} />
          <div className="md:col-span-3"><Button type="submit">Assign</Button></div>
        </form>
        <p className="mt-2 text-sm text-ink-soft">The assignment uses the story’s current published version. Later edits do not change it.</p>
        {error ? <Alert tone="error" className="mt-3">{error}</Alert> : null}
      </Card>
      <Card>
        <h2 className="mb-2 text-lg font-bold">Assignments</h2>
        {assignments.loading ? <Loading /> : assignments.error ? <Alert tone="error">{assignments.error.message}</Alert> : assignments.data!.length === 0 ? <p className="text-ink-soft">Nothing assigned yet.</p> : (
          <ul className="divide-y divide-line">
            {assignments.data!.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="font-semibold">{a.story_versions?.title}</span>
                <StatusBadge>Version {a.story_versions?.version_number}</StatusBadge>
                {a.due_at ? <span className="text-sm text-ink-soft">due {formatDate(a.due_at)}</span> : null}
                {a.archived_at ? <StatusBadge tone="sun" icon="🗄">Archived</StatusBadge> : (
                  <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void archiveAssignment(a).then(assignments.reload, (e) => setError((e as Error).message))}>Archive</Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function ProgressTab({ classId, className }: { classId: string; className: string }) {
  const progress = useAsync(() => classProgress(classId), [classId]);
  const [exporting, setExporting] = useState(false);
  if (progress.loading) return <Loading />;
  if (progress.error) return <Alert tone="error">{progress.error.message}</Alert>;
  const rows = progress.data!;
  const slug = className.replace(/[^\w-]+/g, '-').toLowerCase();

  const exportProgress = () => {
    downloadText(`${slug}-progress.csv`, toCsv(
      ['Learner', 'Sessions', 'Assessed sessions', 'Last session', 'Latest CWPM (complete, assessed)', 'Best CWPM', 'Latest coverage', 'Needs review'],
      rows.map((r) => [r.display_name, r.sessions, r.assessed_sessions, r.last_session_at, r.latest_cwpm, r.best_cwpm, r.latest_coverage, r.needs_review]),
    ));
  };
  const exportAttempts = async () => {
    setExporting(true);
    try {
      const attempts = await classAttempts(rows.map((r) => r.learner_id));
      downloadText(`${slug}-attempts.csv`, toCsv(ATTEMPT_CSV_HEADER, attempts.map(attemptCsvRow)));
    } finally {
      setExporting(false);
    }
  };

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold">Progress</h2>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" icon={<Download size={16} />} onClick={exportProgress} disabled={!rows.length}>Export summary (CSV)</Button>
          <Button size="sm" variant="secondary" icon={<Download size={16} />} onClick={() => void exportAttempts()} busy={exporting} disabled={!rows.length}>Export all attempts (CSV)</Button>
        </div>
      </div>
      {rows.length === 0 ? <p className="text-ink-soft">No learners in this class yet.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-left">
            <caption className="sr-only">Progress by learner</caption>
            <thead><tr className="border-b-2 border-line text-sm"><th className="py-2">Learner</th><th>Sessions</th><th>Assessed</th><th>Last practice</th><th>Latest CWPM</th><th>Best CWPM</th><th>Latest coverage</th><th>To review</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.learner_id} className="border-b border-line">
                  <td className="py-2 font-semibold">{avatarById(r.avatar).emoji} {r.display_name}</td>
                  <td>{r.sessions}</td>
                  <td>{r.assessed_sessions}</td>
                  <td>{r.last_session_at ? formatDateTime(r.last_session_at) : '—'}</td>
                  <td>{r.latest_cwpm ?? '—'}</td>
                  <td>{r.best_cwpm ?? '—'}</td>
                  <td>{percent(r.latest_coverage)}</td>
                  <td>{r.needs_review ? <Link to="/teacher/review" className="underline">{r.needs_review}</Link> : 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-sm text-ink-soft">CWPM is shown only for complete, assessed readings: correctly matched words divided by assessed reading time ({formatDuration(60_000)} = 1 minute). Matching is transcript-based, not a pronunciation score.</p>
    </Card>
  );
}

function SettingsTab({ klass, onChange }: { klass: NonNullable<Awaited<ReturnType<typeof getClass>>>; onChange: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [retention, setRetention] = useState(String(klass.audio_retention_days));
  const code = klass.class_join_codes;
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      onChange();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="space-y-5">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Card>
        <h2 className="mb-2 text-lg font-bold">Class code</h2>
        <p className="font-mono text-3xl tracking-widest">{code?.code ?? '—'}</p>
        <p className="mt-1 text-sm text-ink-soft">Parents use this code to <em>request</em> that their child joins. You approve every request. The code does not show your class list or any records.</p>
        <div className="mt-3 flex flex-wrap gap-3">
          <Toggle label="Accept new requests" checked={code?.enabled ?? false} onChange={(v) => void run(() => setJoinCodeEnabled(klass.id, v))} />
          <Button variant="secondary" onClick={() => void run(() => regenerateJoinCode(klass.id))}>Make a new code</Button>
        </div>
      </Card>
      <Card>
        <h2 className="mb-2 text-lg font-bold">Recording policy</h2>
        <Toggle
          label="Collect reading recordings from classroom devices"
          checked={klass.audio_upload_enabled}
          onChange={(v) => void run(() => setRecordingPolicy(klass.id, v, Number(retention)))}
          description="Off by default. When on, recordings made on devices you set up for this class can be uploaded for your review. Recordings from family devices also need a guardian’s consent. Only teachers of this class and the learner’s guardians can listen."
        />
        <div className="mt-4 max-w-xs">
          <SelectField label="Delete recordings after" value={retention} onChange={(e) => { setRetention(e.target.value); void run(() => setRecordingPolicy(klass.id, klass.audio_upload_enabled, Number(e.target.value))); }}>
            {[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{d} days</option>)}
          </SelectField>
        </div>
      </Card>
    </div>
  );
}
