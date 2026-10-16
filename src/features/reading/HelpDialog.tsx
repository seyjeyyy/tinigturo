import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { WordLegend } from './Passage';

export function HelpDialog({ open, onClose, mode, planText, onDiscard }: { open: boolean; onClose: () => void; mode: 'read' | 'listen'; planText: string; onDiscard?: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="How reading works" footer={<Button onClick={onClose}>Got it</Button>}>
      <div className="space-y-4">
        {mode === 'read' ? (
          <>
            <ol className="list-decimal space-y-1 pl-5">
              <li>Press <strong>Start</strong> and read the story out loud at your own pace.</li>
              <li>The <strong>underlined</strong> word is the next word. The <strong>blue</strong> word is the one we just heard.</li>
              <li>If you stop reading, the highlight waits for you. Press <strong>Pause</strong> to take a break.</li>
              <li><strong>Lost your place?</strong> Press <strong>Word Coach</strong>, tap the word where you are, and choose <em>Continue reading from here</em>.</li>
              <li>Press <strong>Finish</strong> when you are done. Reading part of the story is fine.</li>
            </ol>
            <WordLegend mode="read" />
            <p className="text-sm text-ink-soft">
              While you record, the small moving line shows the sound the microphone hears. It shows that the microphone is
              working. It does not check your words or how you say them.
            </p>
          </>
        ) : (
          <>
            <p>The story is read to you while the words light up. This is listening practice — your voice is not checked.</p>
            <WordLegend mode="listen" />
          </>
        )}
        <p className="rounded-xl bg-paper p-3 text-sm">{planText}</p>
        <p className="text-sm text-ink-soft">
          <strong>Word Coach:</strong> press Word Coach, then tap a word — or touch and hold a word — to hear it, see what it
          means, or save it to My Words. Reading pauses while the Word Coach is open and continues when you close it.
        </p>
        {onDiscard ? (
          <div className="border-t border-line pt-3">
            <Button variant="danger" size="sm" onClick={onDiscard}>Throw away this reading…</Button>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
