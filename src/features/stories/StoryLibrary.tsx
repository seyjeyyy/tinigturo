import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { CloudDownload, Headphones, HardDrive, Mic } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { listLocalStories, saveDownloadedStory } from '../../data/stories';
import { fetchRemoteLibrary, fetchStoryVersion, type RemoteStorySummary } from '../../backend/accountApi';
import { LANGUAGES, type LanguageCode } from '../../text/language';
import { Alert, Card, EmptyState, Loading, PageHeader, StatusBadge } from '../../ui/feedback';
import { Button, ButtonLink } from '../../ui/Button';
import { SelectField } from '../../ui/fields';
import { StorageFullError } from '../../db/errors';
import { tokenizePassage } from '../../text/tokenize';
import { ALL_GRADES, LEARNING_PATH, inLearningPath, outsidePathReason, readingLevelLabel } from '../../content/scope';

type StatusFilter = 'all' | 'downloaded' | 'available';
type View = 'path' | 'all';

export function StoryLibrary() {
  const { db, online, partition, cloud, learner } = useApp();
  const [params, setParams] = useSearchParams();
  const language = (params.get('language') ?? 'all') as LanguageCode | 'all';
  const grade = params.get('grade') ?? 'all';
  // The Grade 2–4 English path is the default. Asking for another language or grade
  // explicitly shows all stories.
  const explicitOutside = (language !== 'all' && language !== LEARNING_PATH.language)
    || (grade !== 'all' && !(LEARNING_PATH.grades as readonly number[]).includes(Number(grade)));
  const view: View = (params.get('view') as View | null) ?? (explicitOutside ? 'all' : 'path');
  const topic = params.get('topic') ?? 'all';
  const status = (params.get('status') ?? 'all') as StatusFilter;
  const local = useLiveQuery(() => listLocalStories(db), [db]);
  const assignments = useLiveQuery(() => db.assignments.filter((a) => !a.archivedAt).toArray(), [db], []);
  const [remote, setRemote] = useState<RemoteStorySummary[] | null>(null);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const canFetchRemote = cloud.status === 'configured' && partition !== 'device' && online;

  useEffect(() => {
    if (!canFetchRemote) {
      setRemote(null);
      return;
    }
    let cancelled = false;
    setRemoteError(null);
    fetchRemoteLibrary().then(
      (rows) => !cancelled && setRemote(rows),
      () => !cancelled && setRemoteError('Could not load more stories from the server right now.'),
    );
    return () => {
      cancelled = true;
    };
  }, [canFetchRemote]);

  const setFilter = (key: string, value: string) =>
    setParams((p) => {
      if (value === 'all') p.delete(key);
      else p.set(key, value);
      return p;
    }, { replace: true });

  if (!local) return <Loading label="Loading stories…" />;

  const localIds = new Set(local.map((s) => s.id));
  const available = (remote ?? []).filter((r) => !localIds.has(r.versionId));
  const topics = [...new Set([...local.map((s) => s.topic), ...available.map((s) => s.topic)])].filter(Boolean).sort();
  // A teacher's assignment is shown whatever its level: the teacher chose it.
  const assigned = new Set(assignments.filter((a) => learner?.classIds.includes(a.classId)).map((a) => a.storyVersionId));
  const match = (s: { id?: string; versionId?: string; language: LanguageCode; gradeLevel: number; topic: string }) => {
    const isAssigned = assigned.has(s.id ?? s.versionId ?? '');
    if (view === 'path' && !inLearningPath(s) && !isAssigned) return false;
    return (language === 'all' || s.language === language) && (grade === 'all' || String(s.gradeLevel) === grade) && (topic === 'all' || s.topic === topic);
  };
  const gradeOptions: readonly number[] = view === 'path' ? LEARNING_PATH.grades : ALL_GRADES;

  const shownLocal = status === 'available' ? [] : local.filter(match);
  const shownRemote = status === 'downloaded' ? [] : available.filter(match);

  const download = async (story: RemoteStorySummary) => {
    setDownloading(story.versionId);
    setDownloadError(null);
    try {
      const version = await fetchStoryVersion(story.versionId);
      await saveDownloadedStory(db, version);
    } catch (error) {
      setDownloadError(error instanceof StorageFullError ? 'There is not enough space on this device. Remove some downloads first.' : 'The story could not be downloaded. Check your internet connection and try again.');
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div>
      <PageHeader title="Stories" description="Pick a story to read aloud or listen to." />
      <div role="group" aria-label="Which stories" className="mb-4 flex rounded-xl border-2 border-line bg-white p-0.5 sm:inline-flex">
        {([['path', `${LEARNING_PATH.label} (learning path)`], ['all', 'All stories']] as [View, string][]).map(([v, text]) => (
          <button
            key={v}
            type="button"
            aria-pressed={view === v}
            onClick={() => setParams(() => {
              const next = new URLSearchParams();
              if (v === 'all') next.set('view', 'all');
              if (status !== 'all') next.set('status', status);
              return next;
            }, { replace: true })}
            className={`min-h-11 flex-1 rounded-lg px-3 text-sm font-semibold ${view === v ? 'bg-teal-brand text-white' : 'text-ink'}`}
          >
            {text}
          </button>
        ))}
      </div>
      {view === 'all' ? (
        <p className="mb-4 text-sm text-ink-soft">
          Stories outside the {LEARNING_PATH.label} path are kept for extra practice and are labelled. Filipino stories are read and recorded without word checking.
        </p>
      ) : null}
      <form className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4" aria-label="Filter stories" onSubmit={(e) => e.preventDefault()}>
        <SelectField label="Reading level" value={grade} onChange={(e) => setFilter('grade', e.target.value)}>
          <option value="all">{view === 'path' ? 'Grades 2–4' : 'All levels'}</option>
          {gradeOptions.map((g) => <option key={g} value={g}>Grade {g}</option>)}
        </SelectField>
        {view === 'all' ? (
          <SelectField label="Language" value={language} onChange={(e) => setFilter('language', e.target.value)}>
            <option value="all">All languages</option>
            {Object.values(LANGUAGES).map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </SelectField>
        ) : null}
        <SelectField label="Topic" value={topic} onChange={(e) => setFilter('topic', e.target.value)}>
          <option value="all">All topics</option>
          {topics.map((t) => <option key={t} value={t}>{t}</option>)}
        </SelectField>
        <SelectField label="Where" value={status} onChange={(e) => setFilter('status', e.target.value)}>
          <option value="all">All stories</option>
          <option value="downloaded">On this device</option>
          <option value="available">Available to download</option>
        </SelectField>
      </form>

      {downloadError ? <Alert tone="error" className="mb-4">{downloadError}</Alert> : null}
      {remoteError ? <Alert tone="warning" className="mb-4">{remoteError}</Alert> : null}
      {status === 'available' && !canFetchRemote ? (
        <Alert tone="offline" className="mb-4">
          {!online ? 'Downloading new stories needs the internet.' : 'Sign in to see stories from your library and teacher.'}
        </Alert>
      ) : null}

      {shownLocal.length === 0 && shownRemote.length === 0 ? (
        <EmptyState
          icon="🔎"
          title={view === 'path' ? `No ${LEARNING_PATH.label} stories match` : 'No stories match these filters'}
          action={
            <>
              <Button variant="secondary" onClick={() => setParams(view === 'all' ? { view: 'all' } : {}, { replace: true })}>Clear filters</Button>
              {view === 'path' ? <Button variant="ghost" onClick={() => setParams({ view: 'all' }, { replace: true })}>Show all stories</Button> : null}
            </>
          }
        >
          {view === 'path' && !online ? 'More stories can be downloaded when you are online.' : null}
        </EmptyState>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2" aria-label="Stories">
          {shownLocal.map((s) => (
            <Card as="li" key={s.id} className="flex flex-col">
              <div className="mb-2 flex flex-wrap gap-2">
                <StatusBadge tone="teal" icon={<HardDrive size={14} />}>On this device</StatusBadge>
                {assigned.has(s.id) ? <StatusBadge tone="blue" icon="📋">Assigned</StatusBadge> : null}
                <StatusBadge>{readingLevelLabel(s.gradeLevel)}</StatusBadge>
                <StatusBadge>{LANGUAGES[s.language].label}</StatusBadge>
                {s.topic ? <StatusBadge>{s.topic}</StatusBadge> : null}
                {outsidePathReason(s) ? <StatusBadge tone="sun" icon="+">Extra practice · {outsidePathReason(s)}</StatusBadge> : null}
              </div>
              <h2 className="text-xl font-bold" lang={s.language === 'fil' ? 'fil' : 'en'}>{s.title}</h2>
              <p className="mb-1 text-ink-soft" lang={s.language === 'fil' ? 'fil' : 'en'}>{s.summary}</p>
              <p className="mb-3 text-sm text-ink-soft">{tokenizePassage(s.body, s.language).words.length} words</p>
              <div className="mt-auto flex flex-wrap gap-2">
                <ButtonLink to={`/read/${s.id}?mode=read`} icon={<Mic size={20} />}>Read aloud</ButtonLink>
                <ButtonLink to={`/read/${s.id}?mode=listen`} variant="secondary" icon={<Headphones size={20} />}>Listen</ButtonLink>
              </div>
            </Card>
          ))}
          {shownRemote.map((s) => (
            <Card as="li" key={s.versionId} className="flex flex-col">
              <div className="mb-2 flex flex-wrap gap-2">
                <StatusBadge icon={<CloudDownload size={14} />}>Needs download</StatusBadge>
                {assigned.has(s.versionId) ? <StatusBadge tone="blue" icon="📋">Assigned</StatusBadge> : null}
                <StatusBadge>{readingLevelLabel(s.gradeLevel)}</StatusBadge>
                <StatusBadge>{LANGUAGES[s.language].label}</StatusBadge>
                {outsidePathReason(s) ? <StatusBadge tone="sun" icon="+">Extra practice · {outsidePathReason(s)}</StatusBadge> : null}
              </div>
              <h2 className="text-xl font-bold">{s.title}</h2>
              <p className="mb-1 text-ink-soft">{s.summary}</p>
              <p className="mb-3 text-sm text-ink-soft">{s.wordCount} words</p>
              <div className="mt-auto">
                <Button variant="secondary" icon={<CloudDownload size={20} />} busy={downloading === s.versionId} disabled={!online} onClick={() => void download(s)}>
                  {online ? 'Download for offline' : 'Needs internet to download'}
                </Button>
              </div>
            </Card>
          ))}
        </ul>
      )}
    </div>
  );
}
