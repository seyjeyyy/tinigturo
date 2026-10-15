import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check, RotateCcw, Trash2, Volume2 } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { listLearnerWords, lookupVocabulary, recordPractice, removeWord } from '../../data/words';
import type { LearnerWord, VocabularyEntry } from '../../domain/types';
import { speakWord } from '../../narration/narrator';
import { voicesFor } from '../../speech/capabilities';
import { Button, ButtonLink, IconButton } from '../../ui/Button';
import { Card, EmptyState, Loading, PageHeader, StatusBadge } from '../../ui/feedback';
import { Dialog } from '../../ui/Dialog';

function useEntries(words: LearnerWord[] | undefined) {
  const { db } = useApp();
  const [entries, setEntries] = useState<Record<string, VocabularyEntry | null>>({});
  useEffect(() => {
    if (!words) return;
    let cancelled = false;
    void Promise.all(words.map(async (w) => [w.id, await lookupVocabulary(db, w.language, w.word)] as const)).then((pairs) => {
      if (!cancelled) setEntries(Object.fromEntries(pairs));
    });
    return () => {
      cancelled = true;
    };
  }, [db, words]);
  return entries;
}

export function MyWords() {
  const { db, learner } = useApp();
  const words = useLiveQuery(() => listLearnerWords(db, learner!.id), [db, learner!.id]);
  const entries = useEntries(words);
  const [removing, setRemoving] = useState<LearnerWord | null>(null);

  if (!words) return <Loading label="Loading your words…" />;
  return (
    <div>
      <PageHeader
        title="My Words"
        description="Words you saved while reading. Tap a word in any story to save it."
        actions={words.length ? <ButtonLink to="/words/practice" icon={<RotateCcw size={20} />}>Practice my words</ButtonLink> : undefined}
      />
      {words.length === 0 ? (
        <EmptyState icon="📒" title="No saved words yet" action={<ButtonLink to="/stories">Find a story</ButtonLink>}>
          While reading, tap a word you don’t know and choose “Save to My Words”.
        </EmptyState>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2" aria-label="Saved words">
          {words.map((w) => {
            const entry = entries[w.id];
            return (
              <Card as="li" key={w.id}>
                <div className="flex items-start justify-between gap-2">
                  <h2 className="text-2xl font-bold" lang={w.language === 'fil' ? 'fil' : 'en'}>{w.word}</h2>
                  <div className="flex gap-1">
                    <IconButton label={`Hear ${w.word}`} icon={<Volume2 size={20} />} disabled={!voicesFor(w.language).length} onClick={() => void speakWord(w.word, w.language)} />
                    <IconButton label={`Remove ${w.word} from My Words`} icon={<Trash2 size={20} />} onClick={() => setRemoving(w)} />
                  </div>
                </div>
                {entry === undefined ? <p className="text-ink-soft">…</p> : entry ? (
                  <>
                    <p>{entry.definition}</p>
                    {entry.example ? <p className="text-ink-soft">“{entry.example}”</p> : null}
                    {entry.reviewStatus === 'draft' ? <p className="mt-1"><StatusBadge tone="sun" icon="✎">Draft definition</StatusBadge></p> : null}
                  </>
                ) : (
                  <p className="text-ink-soft">No meaning available on this device yet.</p>
                )}
                <p className="mt-2 text-sm text-ink-soft">Practiced {w.practiceCount} {w.practiceCount === 1 ? 'time' : 'times'}</p>
              </Card>
            );
          })}
        </ul>
      )}
      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={`Remove “${removing?.word}”?`}
        footer={<><Button variant="secondary" onClick={() => setRemoving(null)}>Keep it</Button><Button variant="danger" onClick={() => { void removeWord(db, removing!.id); setRemoving(null); }}>Remove</Button></>}
      >
        <p>The word will be removed from My Words on every device after syncing.</p>
      </Dialog>
    </div>
  );
}

/** Flashcard practice: see the word, try reading it, then check the meaning. */
export function WordPractice() {
  const { db, learner } = useApp();
  const words = useLiveQuery(() => listLearnerWords(db, learner!.id), [db, learner!.id]);
  const entries = useEntries(words);
  const order = useMemo(() => (words ? [...words].sort((a, b) => a.practiceCount - b.practiceCount || a.savedAt.localeCompare(b.savedAt)) : []), [words]);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [done, setDone] = useState(0);

  if (!words) return <Loading />;
  if (!order.length) {
    return <EmptyState icon="📒" title="Save some words first" action={<ButtonLink to="/stories">Find a story</ButtonLink>} />;
  }
  if (index >= order.length) {
    return (
      <EmptyState icon="🎉" title={`You practiced ${done} ${done === 1 ? 'word' : 'words'}!`} action={<><Button onClick={() => { setIndex(0); setDone(0); setRevealed(false); }}>Practice again</Button><ButtonLink variant="secondary" to="/words">Back to My Words</ButtonLink></>} />
    );
  }
  const word = order[index];
  const entry = entries[word.id];
  const next = async (practiced: boolean) => {
    if (practiced) {
      await recordPractice(db, word.id);
      setDone((d) => d + 1);
    }
    setRevealed(false);
    setIndex((i) => i + 1);
  };

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title="Word practice" description={`Word ${index + 1} of ${order.length}`} />
      <Card className="text-center">
        <p className="my-6 text-5xl font-bold" lang={word.language === 'fil' ? 'fil' : 'en'}>{word.word}</p>
        <p className="mb-4 text-ink-soft">Read the word out loud. Then check what it means.</p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="secondary" icon={<Volume2 size={20} />} disabled={!voicesFor(word.language).length} onClick={() => void speakWord(word.word, word.language)}>Hear it</Button>
          {!revealed ? <Button onClick={() => setRevealed(true)}>Show the meaning</Button> : null}
        </div>
        {revealed ? (
          <div className="mt-5 rounded-xl bg-paper p-4 text-left" aria-live="polite">
            {entry ? <><p className="text-lg">{entry.definition}</p>{entry.example ? <p className="text-ink-soft">“{entry.example}”</p> : null}</> : <p className="text-ink-soft">No meaning available on this device yet. Ask a grown-up!</p>}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button icon={<Check size={20} />} onClick={() => void next(true)}>I practiced it</Button>
              <Button variant="ghost" onClick={() => void next(false)}>Skip</Button>
            </div>
          </div>
        ) : null}
      </Card>
      <p className="mt-4 text-center"><Link to="/words" className="underline">Back to My Words</Link></p>
    </div>
  );
}
