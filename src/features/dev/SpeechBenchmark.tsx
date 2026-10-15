import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useApp } from '../../app/AppContext';
import { featureFlags } from '../../backend/config';
import { benchmarkVosk, type VoskBenchmark } from '../../speech/vosk';
import { isModelDownloaded } from '../../speech/models';
import { StreamingAligner } from '../../alignment/aligner';
import { tokenizePassage } from '../../text/tokenize';
import { Alert, Card, PageHeader } from '../../ui/feedback';
import { Button } from '../../ui/Button';
import { SelectField } from '../../ui/fields';

interface Result extends VoskBenchmark {
  device: string;
  cores: number | null;
  deviceMemoryGb: number | null;
  storyTitle: string;
  matched: number;
  totalWords: number;
  alignMs: number;
  at: string;
}

/**
 * For testers: measures the experimental on-device engine on THIS device, using a
 * recording of someone reading one of the stories. Nothing is uploaded; results are
 * shown for copying into docs/SPEECH.md.
 */
export function SpeechBenchmarkPage() {
  const { db } = useApp();
  const stories = useLiveQuery(() => db.stories.where('language').equals('en').toArray(), [db], []);
  const [storyId, setStoryId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const modelReady = useLiveQuery(() => isModelDownloaded('en'), [], false);

  const run = async () => {
    const story = stories.find((s) => s.id === storyId);
    if (!story || !file) return setError('Choose a story and a recording of it being read.');
    setBusy(true);
    setError(null);
    try {
      const context = new AudioContext({ sampleRate: 16000 });
      const audio = await context.decodeAudioData(await file.arrayBuffer());
      await context.close();
      const bench = await benchmarkVosk('en', audio);
      const passage = tokenizePassage(story.body, story.language);
      const t0 = performance.now();
      const aligner = new StreamingAligner(passage.words, story.language);
      aligner.update('bench', bench.transcript, true, audio.duration * 1000);
      const aligned = aligner.finish();
      const nav = navigator as Navigator & { deviceMemory?: number };
      setResult({
        ...bench,
        device: navigator.userAgent,
        cores: navigator.hardwareConcurrency ?? null,
        deviceMemoryGb: nav.deviceMemory ?? null,
        storyTitle: story.title,
        matched: aligned.statuses.filter((s) => s === 'correct' || s === 'self_corrected').length,
        totalWords: passage.words.length,
        alignMs: Math.round((performance.now() - t0) * 100) / 100,
        at: new Date().toISOString(),
      });
    } catch (e) {
      setError(`Benchmark failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Speech engine benchmark" description="For testers evaluating on-device word checking on this device." />
      {!featureFlags.voskEnabled ? (
        <Alert tone="info">The experimental engine is turned off in this build (VITE_ENABLE_VOSK).</Alert>
      ) : !modelReady ? (
        <Alert tone="info">Download the speech model first on the Offline downloads screen.</Alert>
      ) : null}
      <Card className="space-y-3">
        <SelectField label="Story that was read" value={storyId} onChange={(e) => setStoryId(e.target.value)}>
          <option value="">Choose a story</option>
          {stories.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
        </SelectField>
        <label className="block">
          <span className="font-semibold">Recording (WAV, WebM, MP3 or M4A)</span>
          <input type="file" accept="audio/*" className="mt-1 block" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <p className="text-sm text-ink-soft">Use recordings made with consent. The file stays on this device.</p>
        <Button onClick={() => void run()} busy={busy} disabled={!featureFlags.voskEnabled || !modelReady}>Run benchmark</Button>
        {error ? <Alert tone="error">{error}</Alert> : null}
      </Card>
      {result ? (
        <Card>
          <h2 className="mb-2 text-lg font-bold">Result</h2>
          <ul className="space-y-1">
            <li>Model load: {result.modelLoadMs} ms</li>
            <li>Audio: {result.audioSeconds} s; processing: {result.processingMs} ms; real-time factor: {result.realTimeFactor} {result.realTimeFactor < 1 ? '(keeps up with live speech)' : '(too slow for live following)'}</li>
            <li>JS heap after run: {result.heapUsedMb ?? 'not reported by this browser'} MB</li>
            <li>Words matched: {result.matched} of {result.totalWords}; alignment {result.alignMs} ms</li>
          </ul>
          <textarea readOnly className="mt-3 h-40 w-full rounded-xl border border-line p-2 font-mono text-xs" value={JSON.stringify(result, null, 2)} aria-label="Benchmark result JSON" />
        </Card>
      ) : null}
    </div>
  );
}
