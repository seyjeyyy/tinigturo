import { useEffect, useState } from 'react';
import { Upload } from 'lucide-react';
import { requireSupabase } from '../../backend/supabaseClient';
import { listNarrations, narrationUrl, retireNarration, uploadNarration } from '../../backend/teacherToolsApi';
import { checkNarrationFile, parseNarrationTimings, type NarrationTimingInput } from '../../narration/narrationFiles';
import { useAsync } from '../../lib/useAsync';
import { formatBytes, formatDateTime, formatDuration } from '../../lib/format';
import { Alert, Card, Loading, StatusBadge } from '../../ui/feedback';
import { Button } from '../../ui/Button';
import { TextField } from '../../ui/fields';

/** Reads a recording's length in the browser (null when the browser cannot tell). */
function readDuration(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => resolve(Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : null);
    audio.onerror = () => resolve(null);
    audio.src = url;
  });
}

/**
 * Recorded narration for the published version of a story. The recording is linked to
 * that exact version; word timings are optional and only accepted from a timings file
 * made for this version, never estimated.
 */
export function NarrationPanel({ storyId, versionId }: { storyId: string; versionId: string }) {
  const version = useAsync(async () => {
    const { data, error } = await requireSupabase().from('story_versions').select('id, version_number, word_count').eq('id', versionId).maybeSingle();
    if (error) throw error;
    return data as { id: string; version_number: number; word_count: number } | null;
  }, [versionId]);
  const narrations = useAsync(() => listNarrations(versionId), [versionId]);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [timings, setTimings] = useState<NarrationTimingInput[] | null>(null);
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [playUrl, setPlayUrl] = useState<string | null>(null);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  if (version.loading || narrations.loading) return <Card><Loading /></Card>;
  if (version.error || !version.data) return <Card><Alert tone="error">The published version could not be loaded.</Alert></Card>;
  const v = version.data;
  const active = narrations.data?.find((n) => n.status === 'active') ?? null;
  const check = file ? checkNarrationFile(file) : null;

  const chooseFile = async (chosen: File | null) => {
    setProblem(null);
    setMessage(null);
    setTimings(null);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    setDuration(null);
    setFile(chosen);
    if (!chosen) return;
    const result = checkNarrationFile(chosen);
    if (!result.ok) return setProblem(result.error);
    const url = URL.createObjectURL(chosen);
    setPreview(url);
    setDuration(await readDuration(url));
  };

  const chooseTimings = async (chosen: File | null) => {
    setProblem(null);
    if (!chosen) return setTimings(null);
    const parsed = parseNarrationTimings(await chosen.text(), v.word_count, duration);
    if (!parsed.ok) {
      setTimings(null);
      return setProblem(parsed.error);
    }
    setTimings(parsed.timings);
  };

  const upload = async () => {
    if (!file || !check?.ok) return;
    setBusy(true);
    setProblem(null);
    try {
      await uploadNarration({ storyId, versionId, file, mimeType: check.mimeType, extension: check.extension, durationMs: duration, timings, note });
      setMessage('Narration saved. Learners can download it in Listen mode.');
      void chooseFile(null);
      setNote('');
      narrations.reload();
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-3">
      <h2 className="text-lg font-bold">Recorded narration</h2>
      <p className="text-sm text-ink-soft">
        For version {v.version_number} of this story ({v.word_count} words). A new published version needs its own narration, because
        word timings would no longer match. Without a timings file the recording plays with no highlighting; Tinig Turo never estimates timings.
      </p>
      {active ? (
        <div className="rounded-xl border border-line p-3">
          <p className="flex flex-wrap items-center gap-2">
            <StatusBadge tone="teal" icon="✓">In use</StatusBadge>
            <span>{formatBytes(active.size_bytes)}{active.duration_ms ? ` · ${formatDuration(active.duration_ms)}` : ''} · {active.timings ? `${active.timings.length} word timings` : 'no word timings'} · {formatDateTime(active.created_at)}</span>
          </p>
          {active.note ? <p className="text-sm text-ink-soft">{active.note}</p> : null}
          <div className="mt-2 flex flex-wrap gap-2">
            {playUrl ? <audio controls src={playUrl} className="w-full" /> : (
              <Button size="sm" variant="secondary" onClick={async () => setPlayUrl(await narrationUrl(active.audio_path).catch(() => null))}>Play</Button>
            )}
            <Button size="sm" variant="ghost" onClick={async () => { await retireNarration(active.id); setPlayUrl(null); narrations.reload(); }}>Stop using this recording</Button>
          </div>
        </div>
      ) : <p className="text-ink-soft">No narration yet. Listen mode uses the device’s computer voice.</p>}

      <div className="space-y-2 rounded-xl border-2 border-dashed border-line p-3">
        <label className="block font-semibold" htmlFor="narration-file">{active ? 'Replace with a new recording' : 'Upload a recording'} (MP3, M4A, WebM or Ogg, up to 10 MB)</label>
        <input id="narration-file" type="file" accept="audio/mpeg,audio/mp4,audio/x-m4a,audio/webm,audio/ogg" onChange={(e) => void chooseFile(e.target.files?.[0] ?? null)} />
        {preview ? (
          <>
            <audio controls src={preview} className="w-full" />
            <p className="text-sm text-ink-soft">{formatBytes(file?.size)}{duration ? ` · ${formatDuration(duration)}` : ''}. Listen to it before saving.</p>
            <label className="block font-semibold" htmlFor="narration-timings">Word timings file (optional, JSON)</label>
            <input id="narration-timings" type="file" accept="application/json,.json" onChange={(e) => void chooseTimings(e.target.files?.[0] ?? null)} />
            <p className="text-sm text-ink-soft">A list like <code>{'[{"w":0,"s":120,"e":480}, …]'}</code>: word number (from 0), start and end in milliseconds, made for this exact version.</p>
            {timings ? <p className="text-sm">{timings.length} word timings checked.</p> : null}
            <TextField label="Note (optional), e.g. who read it" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
          </>
        ) : null}
        {problem ? <Alert tone="error">{problem}</Alert> : null}
        {message ? <Alert tone="success">{message}</Alert> : null}
        <Button icon={<Upload size={18} />} busy={busy} disabled={!file || !check?.ok || Boolean(problem)} onClick={() => void upload()}>Save narration</Button>
      </div>
    </Card>
  );
}
