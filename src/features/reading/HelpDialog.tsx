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
              <li><strong>Lost your place?</strong> Tap the word where you are and choose <em>Continue reading from here</em>.</li>
              <li>Press <strong>Finish</strong> when you are done. Reading part of the story is fine.</li>
            </ol>
            <WordLegend mode="read" />
          </>
        ) : (
          <>
            <p>The computer voice reads the story while the words light up. This is listening practice — your voice is not checked.</p>
            <WordLegend mode="listen" />
          </>
        )}
        <p className="rounded-xl bg-paper p-3 text-sm">{planText}</p>
        <p className="text-sm text-ink-soft">Tap any word to hear it, see what it means, or save it to My Words.</p>
        {onDiscard ? (
          <div className="border-t border-line pt-3">
            <Button variant="danger" size="sm" onClick={onDiscard}>Throw away this reading…</Button>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
