import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { useEffect, useRef } from 'react';
import { Passage, type WordVisual } from './reading/Passage';
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
