import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import {
  listVocabulary, saveVocabularyEntry, setVocabularyStatus, type VocabularyRow, type VocabularyStatus,
} from '../../backend/teacherToolsApi';
import { RemoteError } from '../../backend/errors';
import { useAsync } from '../../lib/useAsync';
import { formatDateTime } from '../../lib/format';
import { LANGUAGES, type LanguageCode } from '../../text/language';
import { normalizeWord } from '../../text/normalize';
import { Alert, Card, EmptyState, Loading, PageHeader, StatusBadge } from '../../ui/feedback';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { SelectField, TextArea, TextField } from '../../ui/fields';

const STATUS_LABEL: Record<VocabularyStatus, string> = { draft: 'Draft', reviewed: 'Reviewed', published: 'Published' };
const STATUS_TONE: Record<VocabularyStatus, 'sun' | 'blue' | 'teal'> = { draft: 'sun', reviewed: 'blue', published: 'teal' };

function friendly(error: unknown): string {
  if (error instanceof RemoteError && error.kind === 'conflict') return 'Someone else changed this entry, or the word already has an entry. Reload the list and try again.';
  return (error as Error).message;
}

/**
 * Word meanings for the Word Coach. Teachers write and edit drafts; a content editor
 * reviews, verifies syllables and publishes. Only published entries reach devices.
 */
export function VocabularyPage() {
  const { roles } = useApp();
  const isEditor = roles.includes('content_editor') || roles.includes('admin');
  const [status, setStatus] = useState<VocabularyStatus | 'all'>('all');
  const [language, setLanguage] = useState<LanguageCode | 'all'>('en');
  const [search, setSearch] = useState('');
  const list = useAsync(() => listVocabulary({ status, search, language }), [status, search, language]);
  const [editing, setEditing] = useState<VocabularyRow | 'new' | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const changeStatus = async (row: VocabularyRow, next: VocabularyStatus) => {
    setMessage(null);
    try {
      await setVocabularyStatus(row.id, next, row.version);
      setMessage({ tone: 'success', text: `“${row.headword}” is now ${STATUS_LABEL[next].toLowerCase()}.` });
      list.reload();
    } catch (e) {
      setMessage({ tone: 'error', text: friendly(e) });
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Word meanings"
        description="Definitions, examples and syllables used by the Word Coach. Devices download published entries only."
        actions={<Button icon={<Plus size={20} />} onClick={() => setEditing('new')}>New word</Button>}
      />
      <p className="text-sm text-ink-soft">
        {isEditor
          ? 'As a content editor you review entries, verify syllables, and publish. An entry goes from draft to reviewed to published; any change sends it back to draft.'
          : 'Teachers write and improve drafts. A content editor reviews and publishes them. Syllables are shown to learners only after a content editor verifies them.'}
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <TextField label="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
        <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value as VocabularyStatus | 'all')}>
          <option value="all">All</option>
          <option value="draft">Draft</option>
          <option value="reviewed">Reviewed</option>
          <option value="published">Published</option>
        </SelectField>
        <SelectField label="Language" value={language} onChange={(e) => setLanguage(e.target.value as LanguageCode | 'all')}>
          <option value="all">All</option>
          {Object.values(LANGUAGES).map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
        </SelectField>
      </div>
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      {list.loading ? <Loading /> : list.error ? <Alert tone="error">{list.error.message}</Alert> : !list.data?.length ? (
        <EmptyState icon="🔤" title="No words match">Add a word, or change the filters.</EmptyState>
      ) : (
        <ul className="space-y-2">
          {list.data.map((row) => (
            <Card as="li" key={row.id}>
              <div className="flex flex-wrap items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-lg font-bold">{row.headword} <span className="text-sm font-normal text-ink-soft">{row.part_of_speech} · {LANGUAGES[row.language].label}</span></p>
                  <p>{row.definition}</p>
                  {row.example ? <p className="text-sm text-ink-soft">Example: “{row.example}”</p> : null}
                  <p className="text-sm text-ink-soft">
                    Syllables: {row.syllables ? `${row.syllables} ${row.syllables_verified ? '(verified)' : '(not verified — hidden from learners)'}` : 'none'} ·
                    version {row.version} · updated {formatDateTime(row.updated_at)}
                  </p>
                </div>
                <StatusBadge tone={STATUS_TONE[row.review_status]} icon={row.review_status === 'published' ? '✓' : '✎'}>{STATUS_LABEL[row.review_status]}</StatusBadge>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {isEditor || row.review_status === 'draft' ? <Button size="sm" variant="secondary" onClick={() => setEditing(row)}>Edit</Button> : null}
                {isEditor && row.review_status === 'draft' ? <Button size="sm" onClick={() => void changeStatus(row, 'reviewed')}>Mark reviewed</Button> : null}
                {isEditor && row.review_status === 'reviewed' ? <Button size="sm" onClick={() => void changeStatus(row, 'published')}>Publish to devices</Button> : null}
                {isEditor && row.review_status !== 'draft' ? <Button size="sm" variant="ghost" onClick={() => void changeStatus(row, 'draft')}>Back to draft</Button> : null}
              </div>
            </Card>
          ))}
        </ul>
      )}
      {editing ? (
        <EntryDialog
          entry={editing === 'new' ? null : editing}
          isEditor={isEditor}
          onClose={() => setEditing(null)}
          onSaved={(text) => { setEditing(null); setMessage({ tone: 'success', text }); list.reload(); }}
        />
      ) : null}
    </div>
  );
}

function EntryDialog({ entry, isEditor, onClose, onSaved }: { entry: VocabularyRow | null; isEditor: boolean; onClose: () => void; onSaved: (text: string) => void }) {
  const [language, setLanguage] = useState<LanguageCode>(entry?.language ?? 'en');
  const [headword, setHeadword] = useState(entry?.headword ?? '');
  const [partOfSpeech, setPartOfSpeech] = useState(entry?.part_of_speech ?? '');
  const [definition, setDefinition] = useState(entry?.definition ?? '');
  const [example, setExample] = useState(entry?.example ?? '');
  const [syllables, setSyllables] = useState(entry?.syllables ?? '');
  const [verified, setVerified] = useState(entry?.syllables_verified ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const normalized = normalizeWord(headword, language);
    if (!normalized || /\s/.test(normalized)) return setError('Enter a single word.');
    if (!definition.trim()) return setError('Write a child-friendly definition.');
    setBusy(true);
    setError(null);
    try {
      await saveVocabularyEntry({
        id: entry?.id ?? null, language, headword: headword.trim(), normalized, partOfSpeech, definition, example,
        syllables, syllablesVerified: isEditor && verified && Boolean(syllables.trim()), expectedVersion: entry?.version ?? 0,
      });
      onSaved(`“${headword.trim()}” saved as a draft. A content editor reviews it before it reaches devices.`);
    } catch (e) {
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={entry ? `Edit “${entry.headword}”` : 'New word'}
      size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button busy={busy} onClick={() => void save()}>Save draft</Button></>}
    >
      <div className="space-y-3">
        {entry && entry.review_status !== 'draft' ? <Alert tone="warning">Saving a change sends this entry back to draft. Devices keep the last published meaning until it is published again.</Alert> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Word" value={headword} onChange={(e) => setHeadword(e.target.value)} maxLength={60} />
          <SelectField label="Language" value={language} onChange={(e) => setLanguage(e.target.value as LanguageCode)}>
            {Object.values(LANGUAGES).map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </SelectField>
        </div>
        <TextField label="Part of speech (optional)" value={partOfSpeech} onChange={(e) => setPartOfSpeech(e.target.value)} maxLength={20} />
        <TextArea label="Child-friendly definition" value={definition} onChange={(e) => setDefinition(e.target.value)} maxLength={400} rows={2} />
        <TextField label="Example sentence (optional)" value={example} onChange={(e) => setExample(e.target.value)} maxLength={300} />
        <TextField label="Syllables (optional), e.g. pud·dle" value={syllables} onChange={(e) => setSyllables(e.target.value)} maxLength={80}
          hint="Never guessed by the app. Learners see syllables only after a content editor verifies them." />
        {isEditor ? (
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1 h-5 w-5" checked={verified} onChange={(e) => setVerified(e.target.checked)} disabled={!syllables.trim()} />
            <span>I checked these syllables against a dictionary or with a reading specialist.</span>
          </label>
        ) : null}
        {error ? <Alert tone="error">{error}</Alert> : null}
      </div>
    </Dialog>
  );
}
