import { useMemo, useState } from 'react';
import { FileUp } from 'lucide-react';
import { BOOK_FILE_ACCEPT, BookImportError, composeStoryText, readBookFile, type BookDocument } from '../../bookImport';
import { MAX_STORY_CHARS, sanitizeStoryText, tokenizePassage } from '../../text/tokenize';
import type { LanguageCode } from '../../text/language';
import { Alert, ProgressBar } from '../../ui/feedback';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { SelectField } from '../../ui/fields';

export interface ImportedText {
  body: string;
  /** Book title, offered when the story has no title yet. */
  title: string;
}

/**
 * Imports story text from a book file (PDF, EPUB or plain text). Everything happens in
 * this browser; the text reaches the server only when the teacher saves the draft.
 * The teacher picks the pages or chapters, reviews the cleaned text and confirms they
 * may use it with their class.
 */
export function BookImportDialog({ open, onClose, language, currentBody, onUse }: {
  open: boolean;
  onClose: () => void;
  language: LanguageCode;
  currentBody: string;
  onUse: (text: ImportedText, mode: 'replace' | 'append') => void;
}) {
  const [doc, setDoc] = useState<BookDocument | null>(null);
  const [reading, setReading] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(0);
  const [allowed, setAllowed] = useState(false);

  const reset = () => {
    setDoc(null);
    setError(null);
    setReading(null);
    setAllowed(false);
  };
  const close = () => {
    reset();
    onClose();
  };

  const choose = async (file: File | null) => {
    reset();
    if (!file) return;
    setReading({ done: 0, total: 0 });
    try {
      const book = await readBookFile(file, { onProgress: (done, total) => setReading({ done, total }) });
      const first = Math.max(0, book.sections.findIndex((s) => s.paragraphs.length));
      setDoc(book);
      setFrom(first);
      setTo(Math.min(book.sections.length - 1, first + (book.kind === 'pdf' ? 2 : 0)));
    } catch (e) {
      setError(e instanceof BookImportError ? e.message : 'This file could not be read.');
    } finally {
      setReading(null);
    }
  };

  const composed = useMemo(() => (doc ? composeStoryText(doc.sections.slice(from, to + 1)) : null), [doc, from, to]);
  const words = useMemo(() => (composed ? tokenizePassage(composed.body, language).words.length : 0), [composed, language]);
  const existing = sanitizeStoryText(currentBody);
  const appendTooLong = Boolean(composed && existing && existing.length + 2 + composed.chars > MAX_STORY_CHARS);
  const canUse = Boolean(composed?.body && !composed.overLimit && allowed);

  return (
    <Dialog open={open} onClose={close} title="Import story text from a book" size="lg"
      footer={doc ? (
        <>
          <Button variant="secondary" onClick={close}>Cancel</Button>
          {existing ? (
            <Button variant="secondary" disabled={!canUse || appendTooLong} onClick={() => { onUse({ body: composed!.body, title: doc.title }, 'append'); close(); }}>Add after the current text</Button>
          ) : null}
          <Button disabled={!canUse} onClick={() => { onUse({ body: composed!.body, title: doc.title }, 'replace'); close(); }}>
            {existing ? 'Replace the story text' : 'Use this text'}
          </Button>
        </>
      ) : <Button variant="secondary" onClick={close}>Cancel</Button>}
    >
      <div className="space-y-3">
        <p className="text-sm text-ink-soft">
          PDF (with selectable text), EPUB e-books without DRM, and plain text files. The file is read on this device; only the
          text you save becomes part of the story. Pictures are not imported.
        </p>
        <label className="block font-semibold" htmlFor="book-file">Book file</label>
        <input id="book-file" type="file" accept={BOOK_FILE_ACCEPT} disabled={reading !== null} onChange={(e) => void choose(e.target.files?.[0] ?? null)} />
        {reading ? (
          reading.total ? <ProgressBar value={reading.done / reading.total} label={`Reading page ${reading.done} of ${reading.total}`} /> : <p role="status">Reading the file…</p>
        ) : null}
        {error ? <Alert tone="error">{error}</Alert> : null}

        {doc ? (
          <>
            <p className="font-semibold">“{doc.title}” · {doc.sections.length} {doc.kind === 'pdf' ? 'pages' : doc.kind === 'epub' ? 'sections' : 'parts'}</p>
            {doc.warnings.map((w) => <Alert key={w} tone="warning">{w}</Alert>)}
            <div className="grid gap-3 sm:grid-cols-2">
              <SelectField label="From" value={String(from)} onChange={(e) => { const v = Number(e.target.value); setFrom(v); if (to < v) setTo(v); }}>
                {doc.sections.map((s, i) => <option key={i} value={i}>{s.label}{s.paragraphs.length ? '' : ' (no text)'}</option>)}
              </SelectField>
              <SelectField label="To" value={String(to)} onChange={(e) => setTo(Number(e.target.value))}>
                {doc.sections.map((s, i) => (i >= from ? <option key={i} value={i}>{s.label}{s.paragraphs.length ? '' : ' (no text)'}</option> : null))}
              </SelectField>
            </div>
            <div>
              <p className="mb-1 text-sm">
                <strong>{words} words</strong> · {composed?.chars.toLocaleString()} of {MAX_STORY_CHARS.toLocaleString()} characters
              </p>
              {composed?.overLimit ? <Alert tone="error">This is too long for one story. Choose fewer {doc.kind === 'pdf' ? 'pages' : 'sections'}, or import the rest as another story.</Alert> : null}
              {appendTooLong && !composed?.overLimit ? <Alert tone="warning">Added to the current text it would be too long; replace the text instead, or choose less.</Alert> : null}
              <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-xl border border-line bg-paper p-3 font-[family-name:var(--font-reading)] text-base" aria-label="Text to import">
                {composed?.body || '(No text in this selection.)'}
              </pre>
              <p className="mt-1 text-sm text-ink-soft">
                Check the text before saving: books can split words across lines, mix up two-column pages, or include headers. You can edit
                everything in the story editor afterwards.
              </p>
            </div>
            <label className="flex items-start gap-2 rounded-xl border-2 border-sun bg-sun-tint p-3">
              <input type="checkbox" className="mt-1 h-5 w-5" checked={allowed} onChange={(e) => setAllowed(e.target.checked)} />
              <span>I may use this text with my class: for example it is in the public domain, my school is licensed to use it this way, or I wrote it.</span>
            </label>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}

export function BookImportButton(props: { onClick: () => void }) {
  return <Button variant="secondary" size="sm" icon={<FileUp size={18} />} onClick={props.onClick}>Import from a book (PDF, EPUB, text)</Button>;
}
