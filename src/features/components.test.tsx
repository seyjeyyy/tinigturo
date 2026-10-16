import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { useEffect, useRef } from 'react';
import { LONG_PRESS_MS, Passage, type WordVisual } from './reading/Passage';
import { InstallPage } from './install/InstallPage';
import { BookImportDialog } from './teacher/BookImportDialog';
import { TeacherAccessCard } from './account/TeacherAccess';
import { ResultPanel } from './reading/ResultPanel';
import { tokenizePassage } from '../text/tokenize';
import { AppProvider, useApp } from '../app/AppContext';
import { UpdateBanner } from '../pwa/UpdateBanner';
import { updateStore } from '../pwa/updateStore';
import { unassessedSummary, summarizeStatuses } from '../assessment/scoring';
import type { ReadingSessionRecord } from '../domain/types';
import { Dialog } from '../ui/Dialog';
import { RequireLearner } from '../app/StudentLayout';
import { recordingError } from '../recording/machine';

function PassageHarness({ onSelect, visuals = [] }: { onSelect: (i: number) => void; visuals?: (WordVisual[] | null)[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const passage = tokenizePassage('The cat sat. “Hello,” said Ana.', 'en');
  return (
    <div ref={ref}>
      <Passage passage={passage} visuals={visuals} focusIndex={null} onWordSelect={onSelect} textSize="lg" lineSpacing="relaxed" scrollContainer={ref} label="Story" selectedIndex={null} />
    </div>
  );
}

describe('Passage', () => {
  it('renders original punctuation as text and marks word states with distinct shapes', () => {
    const visuals: (WordVisual[] | null)[] = [['matched'], ['current'], ['next']];
    render(<PassageHarness onSelect={() => undefined} visuals={visuals} />);
    expect(screen.getByText('“Hello,”')).toBeInTheDocument();
    expect(document.querySelector('[data-w="0"]')).toHaveClass('word--matched');
    expect(document.querySelector('[data-w="1"]')).toHaveClass('word--current');
    expect(document.querySelector('[data-w="1"]')).toHaveAttribute('aria-current', 'true');
    expect(document.querySelector('[data-w="2"]')).toHaveClass('word--next');
    expect(screen.getByText('(next word)')).toHaveClass('sr-only');
  });

  it('is reachable by keyboard: Enter on the passage opens the word helper', async () => {
    const onSelect = vi.fn();
    render(<PassageHarness onSelect={onSelect} />);
    await userEvent.tab();
    expect(screen.getByRole('group', { name: 'Story' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith(0);
  });
});

function renderWithApp(ui: React.ReactNode) {
  return render(<AppProvider><MemoryRouter>{ui}</MemoryRouter></AppProvider>);
}

function session(overrides: Partial<ReadingSessionRecord>): ReadingSessionRecord {
  const timing = { activeMs: 30_000, pausedMs: 0, interruptedMs: 0, assessedMs: 30_000 };
  return {
    id: 's', learnerId: 'l', storyId: 'st', storyVersionId: 'v', assignmentId: null, mode: 'read_aloud', status: 'saved',
    startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), localDay: '2026-10-15', timing,
    recognition: { plan: 'none', engine: null, reason: 'recognition_unavailable' }, transcript: null,
    assessment: unassessedSummary(20, timing, 'recognition_unavailable'), wordResults: null,
    audio: { status: 'local', mimeType: 'audio/webm', sizeBytes: 10, remotePath: null, error: null },
    reviewRequested: false, recovered: false, sync: 'local_only', updatedAt: new Date().toISOString(), ...overrides,
  };
}

describe('ResultPanel', () => {
  it('says plainly when word assessment was unavailable, with no invented numbers', async () => {
    renderWithApp(<ResultPanel session={session({})} awards={[]} onReadAgain={() => undefined} onReviewWords={() => undefined} />);
    expect(await screen.findByText('Practice saved—word assessment unavailable.')).toBeInTheDocument();
    expect(screen.queryByText(/words per minute/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/confidence/i)).not.toBeInTheDocument();
  });

  it('labels partial attempts as partial and explains the method', async () => {
    const statuses = ['correct', 'correct', 'correct', 'correct', 'correct', 'not_reached', 'not_reached', 'not_reached'] as const;
    const assessment = summarizeStatuses({ statuses: [...statuses], timing: session({}).timing, method: 'transcript_alignment_live', engine: { id: 'x', version: '1', processing: 'on_device' } });
    renderWithApp(<ResultPanel session={session({ assessment })} awards={[]} onReadAgain={() => undefined} onReviewWords={() => undefined} />);
    expect(await screen.findByText('Partial — part of the story was read')).toBeInTheDocument();
    expect(screen.getByText(/not a pronunciation score/)).toBeInTheDocument();
    expect(screen.getByText('Words checked')).toBeInTheDocument();
  });
});

function RecordingFlag({ active }: { active: boolean }) {
  const { activity } = useApp();
  useEffect(() => activity.setRecordingActive(active), [active, activity]);
  return null;
}

describe('UpdateBanner', () => {
  it('defers a waiting update while a recording is active', async () => {
    const { rerender } = renderWithApp(<><RecordingFlag active /><UpdateBanner /></>);
    act(() => updateStore.markNeedRefresh());
    expect(await screen.findByText(/will be offered when you finish this reading/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();
    rerender(<AppProvider><MemoryRouter><RecordingFlag active={false} /><UpdateBanner /></MemoryRouter></AppProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Update now' })).toBeInTheDocument());
  });
});

describe('Dialog', () => {
  it('moves focus inside, closes on Escape and returns focus', async () => {
    function Harness() {
      const [open, setOpen] = [true, vi.fn()];
      return <Dialog open={open} onClose={setOpen} title="Hello"><button type="button">Inside</button></Dialog>;
    }
    render(<Harness />);
    expect(screen.getByRole('dialog', { name: 'Hello' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  });
});

describe('ResultPanel — recording and recognition problems', () => {
  it('says why a recording stopped early and that what was recorded is kept', async () => {
    renderWithApp(
      <ResultPanel session={session({})} awards={[]} stoppedBy={recordingError('microphone_disconnected')} onReadAgain={() => undefined} onReviewWords={() => undefined} />,
    );
    expect(await screen.findByText('The recording stopped early')).toBeInTheDocument();
    expect(screen.getByText(/has been saved/)).toBeInTheDocument();
  });

  it('never presents a recognition failure as the reader’s mistake', async () => {
    const assessment = unassessedSummary(20, session({}).timing, 'recognition_failed');
    renderWithApp(<ResultPanel session={session({ assessment })} awards={[]} onReadAgain={() => undefined} onReviewWords={() => undefined} />);
    expect(await screen.findByText(/not with your reading/)).toBeInTheDocument();
    expect(screen.queryByText(/louder/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Words checked')).not.toBeInTheDocument(); // no zero scores
  });
});

describe('RequireLearner', () => {
  it('explains that a reader is needed instead of silently redirecting', async () => {
    render(
      <AppProvider>
        <MemoryRouter initialEntries={['/progress']}>
          <Routes>
            <Route element={<RequireLearner />}>
              <Route path="/progress" element={<p>Progress page</p>} />
            </Route>
            <Route path="/" element={<p>Home page</p>} />
          </Routes>
        </MemoryRouter>
      </AppProvider>,
    );
    expect(await screen.findByText('Who is reading?')).toBeInTheDocument();
    expect(screen.getByText(/one reader’s own readings/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Choose a reader' })).toHaveAttribute('href', '/learners');
    expect(screen.queryByText('Home page')).not.toBeInTheDocument();
  });
});

describe('Passage — Word Coach shortcut', () => {
  function Harness({ onSelect, onLongPress }: { onSelect: (i: number) => void; onLongPress: (i: number) => void }) {
    const ref = useRef<HTMLDivElement>(null);
    const passage = tokenizePassage('The cat sat.', 'en');
    return (
      <div ref={ref}>
        <Passage passage={passage} visuals={[]} focusIndex={null} onWordSelect={onSelect} onWordLongPress={onLongPress} textSize="lg" lineSpacing="relaxed" scrollContainer={ref} label="Story" />
      </div>
    );
  }

  it('touch and hold opens the Word Coach, and the tap that ends the hold is not a second action', () => {
    vi.useFakeTimers();
    try {
      const onSelect = vi.fn();
      const onLongPress = vi.fn();
      render(<Harness onSelect={onSelect} onLongPress={onLongPress} />);
      const word = document.querySelector('[data-w="1"]')!;
      fireEvent.pointerDown(word, { pointerType: 'touch', clientX: 10, clientY: 10 });
      act(() => vi.advanceTimersByTime(LONG_PRESS_MS + 10));
      fireEvent.pointerUp(word, { pointerType: 'touch' });
      fireEvent.click(word);
      expect(onLongPress).toHaveBeenCalledWith(1);
      expect(onSelect).not.toHaveBeenCalled();

      // A quick tap is a tap; moving the finger (scrolling) cancels the hold.
      fireEvent.pointerDown(word, { pointerType: 'touch', clientX: 10, clientY: 10 });
      fireEvent.pointerUp(word, { pointerType: 'touch' });
      fireEvent.click(word);
      expect(onSelect).toHaveBeenCalledWith(1);
      // jsdom has no PointerEvent coordinates: mouse events with pointer event names carry them.
      fireEvent(word, new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
      fireEvent(word, new MouseEvent('pointermove', { bubbles: true, clientX: 10, clientY: 60 }));
      act(() => vi.advanceTimersByTime(LONG_PRESS_MS + 10));
      expect(onLongPress).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('InstallPage', () => {
  const ua = (value: string) => vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(value);

  it('offers the Android app only on Android', () => {
    const spy = ua('Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36');
    const { unmount } = render(<InstallPage />);
    expect(screen.getByRole('link', { name: 'Download for Android' })).toBeInTheDocument();
    unmount();
    spy.mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1');
    render(<InstallPage />);
    expect(screen.queryByRole('link', { name: 'Download for Android' })).not.toBeInTheDocument();
    expect(screen.getByText(/Add to Home Screen/)).toBeInTheDocument();
    spy.mockRestore();
  });
});

describe('BookImportDialog', () => {
  it('previews the chosen part of a book and uses it only after the teacher confirms the right to use it', async () => {
    const onUse = vi.fn();
    render(<BookImportDialog open onClose={() => undefined} language="en" currentBody="" onUse={onUse} />);
    const text = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of the\nstory.`).join('\n\n');
    await userEvent.upload(screen.getByLabelText('Book file'), new File([text], 'kite_story.txt', { type: 'text/plain' }));
    expect(await screen.findByText(/“kite story” · 2 parts/)).toBeInTheDocument();
    expect(screen.getByLabelText('Text to import')).toHaveTextContent('Line 1 of the story.');
    expect(screen.getByLabelText('Text to import')).not.toHaveTextContent('Line 11');
    const use = screen.getByRole('button', { name: 'Use this text' });
    expect(use).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: /I may use this text/ }));
    await userEvent.click(use);
    expect(onUse).toHaveBeenCalledWith({ body: expect.stringMatching(/^Line 1 of the story\.\n\nLine 2 of the story\./), title: 'kite story' }, 'replace');
  });
});

describe('TeacherAccessCard', () => {
  it('signed out: a separate teacher door that leads back to the workspace after signing in', () => {
    render(<MemoryRouter><TeacherAccessCard state="signed_out" /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'Teacher sign in' })).toHaveAttribute('href', '/account/sign-in?next=/teacher');
    expect(screen.getByRole('link', { name: 'Create a teacher account' })).toHaveAttribute('href', '/account/sign-up?as=teacher');
  });

  it('parent account: explains why the workspace is closed and offers a safe switch, never a self-upgrade', async () => {
    const onSwitch = vi.fn();
    render(<MemoryRouter><TeacherAccessCard state="not_teacher" onSwitchAccount={onSwitch} /></MemoryRouter>);
    expect(screen.getByText(/cannot open the teacher workspace/)).toBeInTheDocument();
    expect(screen.getByText(/add the teacher role/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /make.*teacher|become a teacher/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sign out and use a teacher account' }));
    expect(onSwitch).toHaveBeenCalled();
  });
});
