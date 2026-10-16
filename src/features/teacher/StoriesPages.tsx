import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Archive, ArchiveRestore, Eye, Plus, Save, Send } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import {
  archiveStory, createStory, getStory, listMyStories, publishStory, restoreStory, saveStoryDraft, type TeacherStoryRow,
} from '../../backend/teacherApi';
import { RemoteError } from '../../backend/errors';
import type { StoryServerState, StoryUpdateFields } from '../../backend/remoteApi';
import { useAsync } from '../../lib/useAsync';
import { newOp } from '../../sync/outbox';
import { nowIso } from '../../lib/ids';
import { LANGUAGES, type LanguageCode } from '../../text/language';
import { MAX_STORY_CHARS, sanitizeStoryText, tokenizePassage } from '../../text/tokenize';
import { formatDateTime } from '../../lib/format';
import { Alert, Card, EmptyState, Loading, PageHeader, StatusBadge } from '../../ui/feedback';
import { Button, ButtonLink } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { SelectField, TextArea, TextField } from '../../ui/fields';
import { Passage } from '../reading/Passage';
import { ALL_GRADES, readingLevelLabel } from '../../content/scope';

const STATUS_BADGE: Record<TeacherStoryRow['status'], { tone: 'neutral' | 'teal' | 'sun'; icon: string; text: string }> = {
  draft: { tone: 'neutral', icon: '✎', text: 'Draft' },
  published: { tone: 'teal', icon: '✓', text: 'Published' },
  archived: { tone: 'sun', icon: '🗄', text: 'Archived' },
};

export function TeacherStoriesPage() {
  const { auth } = useApp();
  const stories = useAsync(() => listMyStories(auth.userId!), [auth.userId]);
  return (
    <div>
      <PageHeader title="My stories" actions={<ButtonLink to="/teacher/stories/new" icon={<Plus size={20} />}>New story</ButtonLink>} />
      {stories.loading ? <Loading /> : stories.error ? <Alert tone="error">{stories.error.message}</Alert> : stories.data!.length === 0 ? (
        <EmptyState icon="✍️" title="No stories yet" action={<ButtonLink to="/teacher/stories/new">Write a story</ButtonLink>}>
          The starter library is available to all classes. Write your own stories to assign them.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line rounded-2xl border-2 border-line bg-white">
          {stories.data!.map((s) => {
            const badge = STATUS_BADGE[s.status];
            return (
              <li key={s.id} className="flex flex-wrap items-center gap-2 p-3">
                <Link to={`/teacher/stories/${s.id}`} className="font-semibold underline">{s.draft_title}</Link>
                <StatusBadge tone={badge.tone} icon={badge.icon}>{badge.text}</StatusBadge>
                <span className="text-sm text-ink-soft">{readingLevelLabel(s.grade_level)} · {LANGUAGES[s.language].label} · edited {formatDateTime(s.updated_at)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const EMPTY: StoryUpdateFields = { draft_title: '', draft_body: '', draft_summary: '', language: 'en', grade_level: 1, topic: '' };

function fieldsOf(story: TeacherStoryRow | StoryServerState): StoryUpdateFields {
  return {
    draft_title: story.draft_title, draft_body: story.draft_body, draft_summary: story.draft_summary,
    language: story.language, grade_level: story.grade_level, topic: story.topic,
  };
}

export function StoryEditorPage() {
  const { storyId } = useParams();
  const isNew = !storyId || storyId === 'new';
  const { db, auth, online } = useApp();
  const navigate = useNavigate();
  const [story, setStory] = useState<TeacherStoryRow | null>(null);
  const [fields, setFields] = useState<StoryUpdateFields>(EMPTY);
  const [baseRevision, setBaseRevision] = useState(1);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(!isNew);
  const [message, setMessage] = useState<{ tone: 'success' | 'error' | 'info' | 'warning'; text: string } | null>(null);
  const [conflict, setConflict] = useState<StoryServerState | null>(null);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const previewScroll = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isNew) return;
    let cancelled = false;
    void (async () => {
      const draft = await db.storyDrafts.get(storyId!);
      let server: TeacherStoryRow | null = null;
      try {
        server = online ? await getStory(storyId!) : null;
      } catch {
        server = null;
      }
      if (cancelled) return;
      setStory(server);
      if (draft && (draft.pendingOpId || !server || draft.baseRevision >= server.revision)) {
        setFields({ draft_title: draft.title, draft_body: draft.body, draft_summary: draft.summary, language: draft.language, grade_level: draft.gradeLevel, topic: draft.topic });
        setBaseRevision(draft.baseRevision);
        if (draft.pendingOpId) setMessage({ tone: 'info', text: 'You have changes saved on this device that are waiting to sync.' });
      } else if (server) {
        setFields(fieldsOf(server));
        setBaseRevision(server.revision);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [db, storyId, isNew, online]);

  const passage = useMemo(() => tokenizePassage(fields.draft_body, fields.language), [fields.draft_body, fields.language]);
  const update = (patch: Partial<StoryUpdateFields>) => {
    setFields((f) => ({ ...f, ...patch }));
    setDirty(true);
  };

  const validation = (): string | null => {
    if (!fields.draft_title.trim()) return 'Add a title.';
    if (!sanitizeStoryText(fields.draft_body)) return 'Add the story text.';
    if (fields.draft_body.length > MAX_STORY_CHARS) return `Keep the story under ${MAX_STORY_CHARS} characters.`;
    if (passage.words.length > 5000) return 'The story is too long.';
    return null;
  };

  const cleanFields = (): StoryUpdateFields => ({ ...fields, draft_title: fields.draft_title.trim(), draft_body: sanitizeStoryText(fields.draft_body), draft_summary: fields.draft_summary.trim(), topic: fields.topic.trim() });

  const saveLocalDraft = async (pendingOpId: string | null, revision = baseRevision) => {
    if (!storyId || isNew) return;
    await db.storyDrafts.put({
      storyId, title: fields.draft_title, body: fields.draft_body, summary: fields.draft_summary, language: fields.language,
      gradeLevel: fields.grade_level, topic: fields.topic, baseRevision: revision, updatedAt: nowIso(), pendingOpId,
    });
  };

  const save = async (expected = baseRevision) => {
    const problem = validation();
    if (problem) return setMessage({ tone: 'error', text: problem });
    setBusy(true);
    setMessage(null);
    try {
      if (isNew) {
        if (!online) return setMessage({ tone: 'warning', text: 'Creating a new story needs the internet. Your text is still here; save when you are online.' });
        const created = await createStory(auth.userId!, cleanFields());
        setDirty(false);
        navigate(`/teacher/stories/${created.id}`, { replace: true });
        return;
      }
      if (!online) {
        // Queue the edit; the sync engine checks the revision and reports conflicts.
        const op = newOp('story.update', storyId!, null, { storyId, expectedRevision: expected, fields: cleanFields() });
        await db.transaction('rw', db.outbox, db.storyDrafts, async () => {
          const previous = await db.storyDrafts.get(storyId!);
          if (previous?.pendingOpId) await db.outbox.delete(previous.pendingOpId);
          await db.outbox.add(op);
          await saveLocalDraft(op.opId, expected);
        });
        setDirty(false);
        setMessage({ tone: 'info', text: 'Saved on this device. It will sync when you are online, and you will be asked if someone else changed the story meanwhile.' });
        return;
      }
      const saved = await saveStoryDraft(storyId!, expected, cleanFields());
      setBaseRevision(saved.revision);
      setStory((s) => (s ? { ...s, ...saved } : s));
      await db.storyDrafts.delete(storyId!);
      setDirty(false);
      setMessage({ tone: 'success', text: 'Draft saved. Learners see changes only after you publish.' });
    } catch (error) {
      if (error instanceof RemoteError && error.kind === 'conflict') {
        setConflict(error.details as StoryServerState);
        await saveLocalDraft(null);
      } else {
        setMessage({ tone: 'error', text: (error as Error).message });
      }
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (!story || dirty) return setMessage({ tone: 'warning', text: 'Save your changes before publishing.' });
    setBusy(true);
    try {
      const result = await publishStory({ id: story.id, revision: baseRevision, draft_body: fields.draft_body, language: fields.language });
      setStory({ ...story, status: 'published', published_version_id: result.version_id });
      setMessage({ tone: 'success', text: `Published as version ${result.version_number}. Earlier readings keep the version they used.` });
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof RemoteError && error.kind === 'conflict' ? 'The story changed since you opened it. Reload before publishing.' : (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const toggleArchive = async () => {
    if (!story) return;
    setBusy(true);
    try {
      if (story.status === 'archived') await restoreStory(story.id);
      else await archiveStory(story.id);
      const fresh = await getStory(story.id);
      setStory(fresh);
      setMessage({ tone: 'success', text: story.status === 'archived' ? 'Story restored.' : 'Story archived. Past readings and their results are kept.' });
    } catch (error) {
      setMessage({ tone: 'error', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Loading />;
  const badge = story ? STATUS_BADGE[story.status] : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title={isNew ? 'New story' : 'Edit story'}
        description={<span className="flex flex-wrap items-center gap-2"><Link to="/teacher/stories" className="underline">My stories</Link>{badge ? <StatusBadge tone={badge.tone} icon={badge.icon}>{badge.text}</StatusBadge> : null}{dirty ? <StatusBadge tone="sun" icon="●">Unsaved changes</StatusBadge> : null}</span>}
        actions={
          <>
            <Button variant="secondary" icon={<Eye size={20} />} onClick={() => setPreview(true)}>Preview</Button>
            <Button icon={<Save size={20} />} onClick={() => void save()} busy={busy}>{online || isNew ? 'Save draft' : 'Save on this device'}</Button>
            {story ? <Button variant="sun" icon={<Send size={20} />} onClick={() => void publish()} disabled={!online || busy || story.status === 'archived'}>Publish</Button> : null}
            {story ? <Button variant="ghost" icon={story.status === 'archived' ? <ArchiveRestore size={20} /> : <Archive size={20} />} onClick={() => void toggleArchive()} disabled={!online || busy}>{story.status === 'archived' ? 'Restore' : 'Archive'}</Button> : null}
          </>
        }
      />
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      <Card className="space-y-4">
        <TextField label="Title" value={fields.draft_title} onChange={(e) => update({ draft_title: e.target.value })} maxLength={120} />
        <TextField label="Short summary" value={fields.draft_summary} onChange={(e) => update({ draft_summary: e.target.value })} maxLength={300} />
        <div className="grid gap-3 sm:grid-cols-3">
          <SelectField label="Language" value={fields.language} onChange={(e) => update({ language: e.target.value as LanguageCode })}>
            {Object.values(LANGUAGES).map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </SelectField>
          <SelectField label="Reading level" value={String(fields.grade_level)} onChange={(e) => update({ grade_level: Number(e.target.value) })} hint="The grade this story is written for. Grades 2–4 in English form the learning path; other levels are extra practice.">
            {ALL_GRADES.map((g) => <option key={g} value={g}>{readingLevelLabel(g)}</option>)}
          </SelectField>
          <TextField label="Topic" value={fields.topic} onChange={(e) => update({ topic: e.target.value })} maxLength={40} />
        </div>
        <TextArea
          label="Story text"
          hint="Plain text. Leave a blank line between paragraphs. Text is shown exactly as typed; HTML and formatting codes are not used."
          value={fields.draft_body}
          onChange={(e) => update({ draft_body: e.target.value })}
          rows={14}
        />
        <p className="text-sm text-ink-soft">{passage.words.length} words · {passage.sentences.length} sentences · {passage.paragraphs.length} paragraphs</p>
      </Card>

      <Dialog open={preview} onClose={() => setPreview(false)} title={`Preview: ${fields.draft_title || 'Untitled'}`} size="lg">
        <div ref={previewScroll} className="max-h-[60dvh] overflow-y-auto rounded-xl bg-paper p-4">
          {passage.words.length ? (
            <Passage passage={passage} visuals={[]} focusIndex={null} onWordSelect={() => undefined} textSize="lg" lineSpacing="relaxed" scrollContainer={previewScroll} label="Story preview" />
          ) : <p className="text-ink-soft">Nothing to preview yet.</p>}
        </div>
      </Dialog>

      <Dialog
        open={conflict !== null}
        onClose={() => setConflict(null)}
        title="Someone else changed this story"
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => {
              if (conflict) {
                setFields(fieldsOf(conflict));
                setBaseRevision(conflict.revision);
                setDirty(false);
                void db.storyDrafts.delete(storyId!);
              }
              setConflict(null);
              setMessage({ tone: 'info', text: 'Loaded the other version. Your changes were discarded.' });
            }}>Use their version</Button>
            <Button onClick={() => {
              const revision = conflict!.revision;
              setConflict(null);
              void save(revision);
            }}>Replace with my version</Button>
          </>
        }
      >
        <p className="mb-3">The story was saved somewhere else after you opened it. Nothing was overwritten. Choose which version to keep.</p>
        {conflict ? (
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-line p-3"><p className="font-semibold">Their version</p><p className="font-semibold">{conflict.draft_title}</p><p className="max-h-48 overflow-y-auto whitespace-pre-wrap text-sm">{conflict.draft_body}</p></div>
            <div className="rounded-xl border border-teal-brand p-3"><p className="font-semibold">Your version</p><p className="font-semibold">{fields.draft_title}</p><p className="max-h-48 overflow-y-auto whitespace-pre-wrap text-sm">{fields.draft_body}</p></div>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
