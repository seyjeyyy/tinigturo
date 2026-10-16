import { useState } from 'react';
import { Link } from 'react-router';
import { Download, Plus } from 'lucide-react';
import {
  classGradebook, createRubric, getSessionGrades, gradeRevisions, listRubrics, saveGrade,
  type GradebookRow, type RubricCriterion, type RubricRow,
} from '../../backend/teacherToolsApi';
import { listClasses } from '../../backend/teacherApi';
import { RemoteError } from '../../backend/errors';
import { useAsync } from '../../lib/useAsync';
import { downloadText, toCsv, type CsvValue } from '../../lib/csv';
import { formatDateTime, percent } from '../../lib/format';
import { Alert, Card, EmptyState, Loading, StatusBadge } from '../../ui/feedback';
import { Button } from '../../ui/Button';
import { SelectField, TextArea, TextField } from '../../ui/fields';

/**
 * Grading: rubrics are written by the school or teacher (the app ships none), grades are
 * the teacher's own judgement recorded against a rubric version, and the automatic
 * word-checking result is shown beside them but never turned into a grade.
 * Badges and streaks are separate and never appear here.
 */

// ---- rubrics -----------------------------------------------------------------

interface DraftCriterion { label: string; levels: string }

/** An example only; shown as such. Schools replace it with their approved criteria. */
const EXAMPLE: { name: string; description: string; criteria: DraftCriterion[]; finals: string } = {
  name: 'Oral reading (example — replace with your school’s criteria)',
  description: 'Example rubric for a read-aloud passage. Not an official benchmark.',
  criteria: [
    { label: 'Reads words accurately', levels: 'Beginning, Developing, Proficient, Advanced' },
    { label: 'Phrasing and pace', levels: 'Beginning, Developing, Proficient, Advanced' },
    { label: 'Expression', levels: 'Beginning, Developing, Proficient, Advanced' },
  ],
  finals: 'Needs more support, Developing, Meets the class goal, Exceeds the class goal',
};

const splitList = (text: string) => text.split(',').map((t) => t.trim()).filter(Boolean);

export function toCriteria(rows: DraftCriterion[]): RubricCriterion[] {
  const used = new Set<string>();
  return rows.filter((r) => r.label.trim()).map((r) => {
    const base = r.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'criterion';
    let key = base;
    for (let n = 2; used.has(key); n++) key = `${base}_${n}`;
    used.add(key);
    return { key, label: r.label.trim(), levels: splitList(r.levels).map((label, i) => ({ value: i + 1, label })) };
  });
}

function RubricForm({ classId, base, onSaved, onCancel }: { classId: string; base: RubricRow | null; onSaved: () => void; onCancel: () => void }) {
  const [name, setName] = useState(base?.name ?? '');
  const [description, setDescription] = useState(base?.description ?? '');
  const [rows, setRows] = useState<DraftCriterion[]>(base ? base.criteria.map((c) => ({ label: c.label, levels: c.levels.map((l) => l.label).join(', ') })) : [{ label: '', levels: '' }]);
  const [finals, setFinals] = useState(base ? base.final_levels.join(', ') : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    const criteria = toCriteria(rows);
    const finalLevels = splitList(finals);
    if (!name.trim()) return setError('Give the rubric a name.');
    if (!criteria.length || criteria.some((c) => c.levels.length < 2 || c.levels.length > 6)) return setError('Each criterion needs 2 to 6 levels, separated by commas.');
    if (!finalLevels.length) return setError('List the final grades a teacher can give, separated by commas.');
    setBusy(true);
    try {
      await createRubric({ classId, name: name.trim(), description, criteria, finalLevels, familyId: base?.family_id ?? null });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <h3 className="mb-2 text-lg font-bold">{base ? `New version of “${base.name}”` : 'New rubric'}</h3>
      {base ? <p className="mb-3 text-sm text-ink-soft">Grades already given keep version {base.version}. New grades use the new version.</p> : (
        <Button size="sm" variant="ghost" className="mb-3" onClick={() => {
          setName(EXAMPLE.name); setDescription(EXAMPLE.description); setRows(EXAMPLE.criteria); setFinals(EXAMPLE.finals);
        }}>Fill in an example to edit</Button>
      )}
      <div className="space-y-3">
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        <TextArea label="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} rows={2} />
        <fieldset className="space-y-2">
          <legend className="font-semibold">Criteria</legend>
          {rows.map((row, i) => (
            <div key={i} className="grid gap-2 rounded-xl border border-line p-2 sm:grid-cols-2">
              <TextField label={`Criterion ${i + 1}`} value={row.label} onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, label: e.target.value } : r)))} maxLength={60} />
              <TextField label="Levels, lowest first (comma-separated)" value={row.levels} onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, levels: e.target.value } : r)))} />
            </div>
          ))}
          {rows.length < 10 ? <Button size="sm" variant="secondary" icon={<Plus size={16} />} onClick={() => setRows([...rows, { label: '', levels: '' }])}>Add a criterion</Button> : null}
        </fieldset>
        <TextField label="Final grades a teacher can give (comma-separated)" value={finals} onChange={(e) => setFinals(e.target.value)} hint="Use your school’s approved grading terms. Tinig Turo does not compute final grades or apply weights." />
        {error ? <Alert tone="error">{error}</Alert> : null}
        <div className="flex gap-2">
          <Button busy={busy} onClick={() => void save()}>{base ? 'Save new version' : 'Create rubric'}</Button>
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        </div>
      </div>
    </Card>
  );
}

export function RubricsTab({ classId }: { classId: string }) {
  const rubrics = useAsync(() => listRubrics(classId), [classId]);
  const [editing, setEditing] = useState<RubricRow | 'new' | null>(null);
  if (rubrics.loading) return <Loading />;
  if (rubrics.error) return <Alert tone="error">{rubrics.error.message}</Alert>;
  const current = (rubrics.data ?? []).filter((r) => !r.retired_at);
  return (
    <div className="space-y-4">
      <p className="text-ink-soft">
        Rubrics describe how you grade a reading. Write them with your school’s criteria and terms; Tinig Turo provides no official
        criteria, weights or benchmarks. Each change creates a new version, and grades keep the version they used.
      </p>
      {editing ? (
        <RubricForm classId={classId} base={editing === 'new' ? null : editing} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); rubrics.reload(); }} />
      ) : (
        <Button icon={<Plus size={20} />} onClick={() => setEditing('new')}>New rubric</Button>
      )}
      {current.length === 0 && !editing ? <EmptyState icon="📋" title="No rubrics yet">Create one to start grading readings.</EmptyState> : null}
      {current.map((r) => (
        <Card key={r.id}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="text-lg font-bold">{r.name} <span className="text-sm font-normal text-ink-soft">· version {r.version}</span></h3>
              {r.description ? <p className="text-sm text-ink-soft">{r.description}</p> : null}
            </div>
            <Button size="sm" variant="secondary" onClick={() => setEditing(r)}>New version</Button>
          </div>
          <ul className="mt-2 space-y-1 text-sm">
            {r.criteria.map((c) => <li key={c.key}><strong>{c.label}:</strong> {c.levels.map((l) => l.label).join(' · ')}</li>)}
            <li><strong>Final grades:</strong> {r.final_levels.join(' · ')}</li>
          </ul>
        </Card>
      ))}
    </div>
  );
}

// ---- gradebook ---------------------------------------------------------------

function wordCheck(row: GradebookRow): string {
  if (!row.assessment_status || row.assessment_status === 'unassessed') return 'Not checked';
  const parts = [row.completion === 'complete' ? 'whole story' : 'partial', `coverage ${percent(row.coverage)}`];
  if (row.cwpm !== null) parts.push(`${row.cwpm} CWPM`);
  return `${row.assessment_status === 'needs_review' ? 'Needs review' : 'Checked'} · ${parts.join(' · ')}`;
}

export const GRADEBOOK_CSV_HEADER = [
  'Learner', 'Story', 'Started', 'Word check status', 'Completion', 'Coverage', 'CWPM', 'Grade status', 'Final grade',
  'Rubric', 'Rubric version', 'Teacher feedback', 'Graded at', 'Published at', 'Revision',
];

export function gradebookCsvRow(r: GradebookRow): CsvValue[] {
  const assessed = r.assessment_status && r.assessment_status !== 'unassessed';
  return [
    r.learner_name, r.story_title, r.started_at, r.assessment_status, assessed ? r.completion : null, assessed ? r.coverage : null, assessed ? r.cwpm : null,
    r.grade_status ?? 'not graded', r.final_level, r.rubric_name, r.rubric_version, r.feedback, r.graded_at, r.published_at, r.revision,
  ];
}

export function GradebookTab({ classId, className }: { classId: string; className: string }) {
  const book = useAsync(() => classGradebook(classId), [classId]);
  const [onlyUngraded, setOnlyUngraded] = useState(false);
  if (book.loading) return <Loading />;
  if (book.error) return <Alert tone="error">{book.error.message}</Alert>;
  const rows = (book.data ?? []).filter((r) => !onlyUngraded || r.grade_status !== 'published');
  const slug = className.replace(/[^\w-]+/g, '-').toLowerCase();
  return (
    <div className="space-y-3">
      <p className="text-ink-soft">
        Grades are your judgement against a rubric. The automatic word check is shown for reference and is never turned into a grade.
        Families see a grade only after you publish it.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={onlyUngraded} onChange={(e) => setOnlyUngraded(e.target.checked)} />Only readings without a published grade</label>
        <Button size="sm" variant="secondary" icon={<Download size={16} />} disabled={!book.data?.length}
          onClick={() => downloadText(`${slug}-gradebook.csv`, toCsv(GRADEBOOK_CSV_HEADER, (book.data ?? []).map(gradebookCsvRow)))}>
          Export grades (CSV)
        </Button>
      </div>
      {rows.length === 0 ? <EmptyState icon="📒" title="Nothing to show">Readings by learners in this class appear here.</EmptyState> : (
        <div className="overflow-x-auto rounded-2xl border border-line bg-white">
          <table className="w-full min-w-[44rem] text-left">
            <thead><tr className="border-b-2 border-line text-sm"><th className="p-2">Learner</th><th>Story</th><th>Date</th><th>Word check</th><th>Grade</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.session_id} className="border-b border-line align-top">
                  <td className="p-2 font-semibold">{r.learner_name}</td>
                  <td className="py-2">{r.story_title}</td>
                  <td className="py-2 text-sm">{formatDateTime(r.started_at)}</td>
                  <td className="py-2 text-sm">{wordCheck(r)}</td>
                  <td className="py-2">
                    {r.grade_status === 'published' ? <StatusBadge tone="teal" icon="✓">{r.final_level}</StatusBadge>
                      : r.grade_status === 'draft' ? <StatusBadge tone="sun" icon="✎">Draft</StatusBadge>
                        : <span className="text-sm text-ink-soft">Not graded</span>}
                  </td>
                  <td className="py-2 pr-2"><Link className="font-semibold underline" to={`/teacher/review/${r.session_id}?class=${classId}`}>{r.grade_status ? 'Open' : 'Grade'}</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- grading one reading -------------------------------------------------------

export function GradePanel({ sessionId, initialClassId }: { sessionId: string; initialClassId: string | null }) {
  const classes = useAsync(() => listClasses(), []);
  const [classId, setClassId] = useState<string | null>(initialClassId);
  const effectiveClass = classId ?? (classes.data?.length === 1 ? classes.data[0].id : null);
  const data = useAsync(async () => {
    if (!effectiveClass) return null;
    const [rubrics, grades] = await Promise.all([listRubrics(effectiveClass), getSessionGrades(sessionId)]);
    const grade = grades.find((g) => g.class_id === effectiveClass) ?? null;
    const history = grade ? await gradeRevisions(grade.id) : [];
    return { rubrics, grade, history };
  }, [sessionId, effectiveClass]);

  return (
    <Card>
      <h2 className="mb-2 text-lg font-bold">Grade</h2>
      {!initialClassId ? (
        <SelectField label="Class" value={classId ?? effectiveClass ?? ''} onChange={(e) => setClassId(e.target.value || null)}>
          <option value="">Choose the class this grade belongs to</option>
          {classes.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </SelectField>
      ) : null}
      {!effectiveClass ? null : data.loading ? <Loading /> : data.error ? <Alert tone="error">{data.error.message}</Alert> : data.data ? (
        <GradeForm key={`${effectiveClass}:${data.data.grade?.revision ?? 0}`} sessionId={sessionId} {...data.data} onSaved={data.reload} />
      ) : null}
    </Card>
  );
}

function GradeForm({ sessionId, rubrics, grade, history, onSaved }: {
  sessionId: string;
  rubrics: RubricRow[];
  grade: Awaited<ReturnType<typeof getSessionGrades>>[number] | null;
  history: Awaited<ReturnType<typeof gradeRevisions>>;
  onSaved: () => void;
}) {
  const usable = rubrics.filter((r) => !r.retired_at || r.id === grade?.rubric_id);
  const [rubricId, setRubricId] = useState(grade?.rubric_id ?? usable[0]?.id ?? '');
  const [levels, setLevels] = useState<Record<string, number>>(grade?.criterion_levels ?? {});
  const [finalLevel, setFinalLevel] = useState<string>(grade?.final_level ?? '');
  const [feedback, setFeedback] = useState(grade?.feedback ?? '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const rubric = usable.find((r) => r.id === rubricId) ?? null;

  if (!usable.length) {
    return <Alert tone="info">This class has no rubric yet. Create one on the class’s <strong>Rubrics</strong> tab, then come back to grade.</Alert>;
  }
  const published = grade?.status === 'published';
  const complete = Boolean(rubric && rubric.criteria.every((c) => levels[c.key] !== undefined) && finalLevel);

  const save = async (publish: boolean) => {
    if (!rubric) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await saveGrade({
        sessionId, rubricId: rubric.id, levels, finalLevel: finalLevel || null, feedback, publish,
        reason, expectedRevision: grade?.revision ?? 0,
      });
      setMessage({ tone: 'success', text: result.status === 'published' ? 'Grade published. The family can now see it.' : 'Draft saved. Only teachers of this class can see it.' });
      onSaved();
    } catch (e) {
      const conflict = e instanceof RemoteError && e.kind === 'conflict';
      setMessage({ tone: 'error', text: conflict ? 'Someone else changed this grade. Reload the page to see the latest version before changing it.' : (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {grade ? (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          {published ? <StatusBadge tone="teal" icon="✓">Published</StatusBadge> : <StatusBadge tone="sun" icon="✎">Draft</StatusBadge>}
          <span className="text-ink-soft">Revision {grade.revision} · last saved {formatDateTime(grade.graded_at)}{grade.published_at ? ` · published ${formatDateTime(grade.published_at)}` : ''}</span>
        </p>
      ) : null}
      <SelectField label="Rubric" value={rubricId} onChange={(e) => { setRubricId(e.target.value); setLevels({}); setFinalLevel(''); }}>
        {usable.map((r) => <option key={r.id} value={r.id}>{r.name} (version {r.version}){r.retired_at ? ' — replaced' : ''}</option>)}
      </SelectField>
      {rubric?.criteria.map((c) => (
        <SelectField key={c.key} label={c.label} value={levels[c.key] === undefined ? '' : String(levels[c.key])}
          onChange={(e) => setLevels((current) => {
            const next = { ...current };
            if (e.target.value === '') delete next[c.key];
            else next[c.key] = Number(e.target.value);
            return next;
          })}>
          <option value="">Not decided</option>
          {c.levels.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
        </SelectField>
      ))}
      {rubric ? (
        <SelectField label="Final grade" value={finalLevel} onChange={(e) => setFinalLevel(e.target.value)}>
          <option value="">Not decided</option>
          {rubric.final_levels.map((f) => <option key={f} value={f}>{f}</option>)}
        </SelectField>
      ) : null}
      <TextArea label="Feedback for the learner and family" value={feedback} onChange={(e) => setFeedback(e.target.value)} maxLength={1000} rows={3} />
      {published ? (
        <TextField label="Reason for changing a published grade (required)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
      ) : null}
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        {published ? (
          <Button busy={busy} disabled={!complete || !reason.trim()} onClick={() => void save(true)}>Save change</Button>
        ) : (
          <>
            <Button variant="secondary" busy={busy} onClick={() => void save(false)}>Save draft</Button>
            <Button busy={busy} disabled={!complete} onClick={() => void save(true)}>Publish grade</Button>
          </>
        )}
      </div>
      {!complete ? <p className="text-sm text-ink-soft">To publish, choose a level for every criterion and a final grade.</p> : null}
      {history.length ? (
        <details className="rounded-xl border border-line p-2 text-sm">
          <summary className="cursor-pointer font-semibold">History ({history.length})</summary>
          <ul className="mt-2 space-y-1">
            {history.map((h) => (
              <li key={h.revision}>
                Revision {h.revision} · {h.status} · {h.final_level ?? 'no final grade'} · {formatDateTime(h.changed_at)}
                {h.reason ? <span className="text-ink-soft"> — {h.reason}</span> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
