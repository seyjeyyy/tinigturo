import { useState } from 'react';
import { Link } from 'react-router';
import { Plus } from 'lucide-react';
import { createClass, listClasses } from '../../backend/teacherApi';
import { useAsync } from '../../lib/useAsync';
import { Alert, Card, EmptyState, Loading, PageHeader, StatusBadge } from '../../ui/feedback';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { SelectField, TextField } from '../../ui/fields';

export function ClassesPage() {
  const classes = useAsync(listClasses, []);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [grade, setGrade] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return setError('Give the class a name.');
    setBusy(true);
    try {
      await createClass(name.trim(), grade ? Number(grade) : null);
      setOpen(false);
      setName('');
      classes.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader title="Classes" actions={<Button icon={<Plus size={20} />} onClick={() => setOpen(true)}>New class</Button>} />
      {classes.loading ? <Loading /> : classes.error ? (
        <Alert tone="error" action={<Button size="sm" onClick={classes.reload}>Try again</Button>}>Could not load classes: {classes.error.message}</Alert>
      ) : classes.data!.length === 0 ? (
        <EmptyState icon="🏫" title="No classes yet" action={<Button onClick={() => setOpen(true)}>Create your first class</Button>}>
          Create a class, then share its code with parents or set up a classroom device.
        </EmptyState>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {classes.data!.map((c) => (
            <Card as="li" key={c.id}>
              <Link to={`/teacher/classes/${c.id}`} className="text-xl font-bold underline">{c.name}</Link>
              <div className="mt-2 flex flex-wrap gap-2">
                {c.grade_level ? <StatusBadge>Grade {c.grade_level}</StatusBadge> : null}
                <StatusBadge tone={c.audio_upload_enabled ? 'blue' : 'neutral'} icon={c.audio_upload_enabled ? '🎙' : '○'}>{c.audio_upload_enabled ? 'Recordings shared' : 'Recordings stay on devices'}</StatusBadge>
                {c.archived_at ? <StatusBadge tone="sun" icon="🗄">Archived</StatusBadge> : null}
              </div>
            </Card>
          ))}
        </ul>
      )}
      <Dialog open={open} onClose={() => setOpen(false)} title="New class">
        <form onSubmit={create} className="space-y-4">
          <TextField label="Class name" value={name} onChange={(e) => { setName(e.target.value); setError(null); }} maxLength={80} error={error} />
          <SelectField label="Grade" value={grade} onChange={(e) => setGrade(e.target.value)}>
            <option value="">Mixed or not set</option>
            {[1, 2, 3, 4, 5, 6].map((g) => <option key={g} value={g}>Grade {g}</option>)}
          </SelectField>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" busy={busy}>Create class</Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
