import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { BookmarkCheck, BookmarkPlus, CornerDownRight, Volume2 } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { lookupVocabulary, learnerWordId, saveWord } from '../../data/words';
import type { StoryVersionRecord, VocabularyEntry } from '../../domain/types';
import { voicesFor } from '../../speech/capabilities';
import { speakWord } from '../../narration/narrator';
import { normalizeWord } from '../../text/normalize';
import type { PassageWord } from '../../text/tokenize';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Alert, StatusBadge } from '../../ui/feedback';
import { StorageFullError } from '../../db/errors';

/**
 * Word Coach: definition, pronunciation (computer voice, when the device has one),
 * verified syllables only, an example, and Save to My Words. Missing resources are
 * shown as missing; nothing is guessed.
 */
export function WordCoach({
  word, story, open, onClose, onContinueFromHere, playSuspended,
}: {
  word: PassageWord | null;
  story: StoryVersionRecord;
  open: boolean;
  onClose: () => void;
  onContinueFromHere?: (index: number) => void;
  /** Wraps pronunciation playback so it is never assessed as the reader's voice. */
  playSuspended: (play: () => Promise<void>) => Promise<void>;
}) {
  const { db, learner } = useApp();
  const [entry, setEntry] = useState<VocabularyEntry | null | undefined>(undefined);
  const [message, setMessage] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const language = story.language;
  const normalized = word ? normalizeWord(word.core, language) : '';
  const saved = useLiveQuery(
    async () => (learner && normalized ? db.learnerWords.get(learnerWordId(learner.id, language, normalized)) : undefined),
    [db, learner?.id, normalized, language],
  );
  const isSaved = Boolean(saved && !saved.archivedAt);
  const hasVoice = voicesFor(language).length > 0;

  useEffect(() => {
    setMessage(null);
    if (!word) return;
    setEntry(undefined);
    void lookupVocabulary(db, language, word.core).then(setEntry);
  }, [db, word, language]);

  if (!word) return null;

  const onSave = async () => {
    if (!learner) return;
    try {
      const { awards } = await saveWord(db, {
        learnerId: learner.id, language, word: word.core, vocabularyEntryId: entry?.id ?? null, storyVersionId: story.id,
      });
      setMessage(awards.length ? 'Saved! You earned the Word Collector badge (waiting to be checked).' : 'Saved to My Words.');
    } catch (error) {
      setMessage(error instanceof StorageFullError ? 'This device is out of space, so the word could not be saved.' : 'The word could not be saved.');
    }
  };

  const onHear = async () => {
    setSpeaking(true);
    try {
      await playSuspended(() => speakWord(word.core, language));
    } finally {
      setSpeaking(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={`Word helper: “${word.core}”`}>
      <div className="space-y-4">
        <p className="text-4xl font-bold" lang={language === 'fil' ? 'fil' : 'en'}>{word.core}</p>

        <section aria-labelledby="coach-meaning">
          <h3 id="coach-meaning" className="font-semibold">What it means</h3>
          {entry === undefined ? (
            <p className="text-ink-soft">Looking it up…</p>
          ) : entry ? (
            <div className="space-y-1">
              <p>{entry.partOfSpeech ? <em className="text-ink-soft">{entry.partOfSpeech}. </em> : null}{entry.definition}</p>
              {entry.example ? <p className="text-ink-soft">Example: “{entry.example}”</p> : null}
              {entry.reviewStatus === 'draft' ? (
                <StatusBadge tone="sun" icon="✎">Draft definition — not yet checked by a teacher</StatusBadge>
              ) : (
                <StatusBadge tone="teal" icon="✓">Checked by a teacher</StatusBadge>
              )}
            </div>
          ) : (
            <p className="text-ink-soft">There is no meaning for this word on this device yet. You can still save it and ask a grown-up.</p>
          )}
        </section>

        <section aria-labelledby="coach-syllables">
          <h3 id="coach-syllables" className="font-semibold">Syllables</h3>
          {entry?.syllables && entry.syllablesVerified ? (
            <p className="text-2xl tracking-wide">{entry.syllables}</p>
          ) : (
            <p className="text-ink-soft">Not available yet. Syllables are only shown after a teacher checks them.</p>
          )}
        </section>

        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" icon={<Volume2 size={20} />} onClick={() => void onHear()} disabled={!hasVoice} busy={speaking}>
            {hasVoice ? 'Hear it (computer voice)' : 'No voice on this device'}
          </Button>
          <Button variant={isSaved ? 'secondary' : 'primary'} icon={isSaved ? <BookmarkCheck size={20} /> : <BookmarkPlus size={20} />} onClick={() => void onSave()} disabled={isSaved || !learner}>
            {isSaved ? 'In My Words' : 'Save to My Words'}
          </Button>
          {onContinueFromHere ? (
            <Button variant="sun" icon={<CornerDownRight size={20} />} onClick={() => onContinueFromHere(word.index)}>
              Continue reading from here
            </Button>
          ) : null}
        </div>
        {onContinueFromHere ? (
          <p className="text-sm text-ink-soft">“Continue from here” moves your place. Words you skip over are not marked as read.</p>
        ) : null}
        {message ? <Alert tone="success">{message}</Alert> : null}
      </div>
    </Dialog>
  );
}
