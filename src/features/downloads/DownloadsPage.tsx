import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { CloudDownload, HardDrive, Lock, Trash2 } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { removeStoryDownload } from '../../data/stories';
import { configuredModels, downloadModel, isModelDownloaded, modelSize, removeModel, type ModelInfo } from '../../speech/models';
import { detectSpeechCapabilities, type SpeechCapabilities } from '../../speech/capabilities';
import { installOnDeviceLanguage, onDeviceCheckCrashed, resetOnDeviceCheck } from '../../speech/webSpeech';
import { LANGUAGES, type LanguageCode } from '../../text/language';
import { formatBytes, formatDate } from '../../lib/format';
import { Alert, Card, PageHeader, ProgressBar, StatusBadge } from '../../ui/feedback';
import { Button } from '../../ui/Button';
import { featureFlags } from '../../backend/config';
import { fetchPublishedVocabulary } from '../../backend/teacherToolsApi';
import { savePublishedVocabulary } from '../../data/teacherContent';
import { StorageFullError } from '../../db/errors';

interface StorageInfo {
  usage: number | null;
  quota: number | null;
  persisted: boolean | null;
}

async function readStorage(): Promise<StorageInfo> {
  const info: StorageInfo = { usage: null, quota: null, persisted: null };
  try {
    const estimate = await navigator.storage?.estimate?.();
    info.usage = estimate?.usage ?? null;
    info.quota = estimate?.quota ?? null;
    info.persisted = (await navigator.storage?.persisted?.()) ?? null;
  } catch {
    // unavailable in this browser
  }
  return info;
}

export function DownloadsPage() {
  const { db, online, sync, partition, cloud } = useApp();
  const [vocabBusy, setVocabBusy] = useState(false);
  const [vocabMessage, setVocabMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const canFetchVocabulary = cloud.status === 'configured' && partition !== 'device';
  const downloadVocabulary = async () => {
    setVocabBusy(true);
    setVocabMessage(null);
    try {
      const count = await savePublishedVocabulary(db, await fetchPublishedVocabulary());
      setVocabMessage({ tone: 'success', text: count ? `${count} reviewed word meanings are on this device.` : 'No word meanings have been published by a reviewer yet.' });
    } catch (error) {
      setVocabMessage({ tone: 'error', text: error instanceof StorageFullError ? 'There is not enough space on this device.' : 'The word meanings could not be downloaded. Check the internet connection and try again.' });
    } finally {
      setVocabBusy(false);
    }
  };
  const unsyncedTotal = sync.unsynced.total;
  const stories = useLiveQuery(() => db.stories.toArray(), [db], []);
  const downloads = useLiveQuery(() => db.downloads.toArray(), [db], []);
  const recordings = useLiveQuery(() => db.recordings.toArray(), [db], []);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'error' | 'info'; text: string } | null>(null);

  const refresh = useCallback(() => void readStorage().then(setStorage), []);
  useEffect(refresh, [refresh, stories.length, recordings.length]);

  const requestPersist = async () => {
    try {
      const granted = await navigator.storage?.persist?.();
      setMessage(granted
        ? { tone: 'success', text: 'The browser agreed to keep Tinig Turo’s data unless you clear it yourself.' }
        : { tone: 'info', text: 'The browser did not agree to keep the data permanently. It may still remove it if the device runs low on space. Installing the app can help.' });
    } catch {
      setMessage({ tone: 'info', text: 'This browser does not support keeping data permanently.' });
    }
    refresh();
  };

  const remove = async (id: string) => {
    const result = await removeStoryDownload(db, id);
    setMessage(result.removed ? { tone: 'success', text: 'Story removed from this device. Readings and saved words were kept.' } : { tone: 'info', text: result.reason ?? 'Could not remove.' });
    refresh();
  };

  const recordingBytes = recordings.reduce((sum, r) => sum + r.blob.size, 0);
  const downloaded = stories.filter((s) => s.source === 'downloaded');
  const bundled = stories.filter((s) => s.source === 'bundled');

  return (
    <div className="space-y-5">
      <PageHeader title="Offline downloads" description="What is saved on this device for reading without internet." />
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}

      <Card>
        <h2 className="mb-2 flex items-center gap-2 text-lg font-bold"><HardDrive size={20} aria-hidden="true" />Storage on this device</h2>
        {storage?.usage != null && storage.quota ? (
          <ProgressBar value={storage.usage / storage.quota} label={`${formatBytes(storage.usage)} used of about ${formatBytes(storage.quota)} available to the app`} />
        ) : (
          <p className="text-ink-soft">This browser does not report storage use.</p>
        )}
        <p className="mt-2 text-sm">Recordings on this device: {recordings.length} ({formatBytes(recordingBytes)}). Items waiting to sync: {unsyncedTotal}.</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {storage?.persisted ? (
            <StatusBadge tone="teal" icon={<Lock size={14} />}>Protected from automatic clean-up</StatusBadge>
          ) : (
            <Button variant="secondary" onClick={() => void requestPersist()}>Ask the browser to keep this data</Button>
          )}
        </div>
        <p className="mt-2 text-sm text-ink-soft">
          Data saved in the browser can still be deleted if someone clears the browser’s site data, or uninstalls the app. Sync regularly so work is also saved on the server.
        </p>
      </Card>

      <Card>
        <h2 className="mb-3 text-lg font-bold">Stories</h2>
        <ul className="divide-y divide-line">
          {[...downloaded, ...bundled].map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2 py-2">
              <span className="font-semibold">{s.title}</span>
              <span className="text-sm text-ink-soft">{formatBytes(s.sizeBytes)} · {s.source === 'bundled' ? 'part of the app' : `downloaded ${formatDate(s.downloadedAt)}`}</span>
              {s.source === 'downloaded' ? (
                <Button size="sm" variant="ghost" className="ml-auto" icon={<Trash2 size={16} />} onClick={() => void remove(s.id)} aria-label={`Remove ${s.title} from this device`}>Remove</Button>
              ) : <StatusBadge tone="teal" icon="✓">Always available</StatusBadge>}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-sm text-ink-soft">Removing a story never deletes readings, recordings, saved words or anything waiting to sync. <Link to="/stories?status=available" className="underline">Download more stories</Link> (needs internet).</p>
      </Card>

      <Card>
        <h2 className="mb-3 text-lg font-bold">Word lists</h2>
        <ul className="space-y-1">
          {downloads.filter((d) => d.kind === 'vocabulary').map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-2">
              <span>{d.label}</span>
              <StatusBadge tone={d.status === 'ready' ? 'teal' : d.status === 'error' ? 'danger' : 'sun'} icon={d.status === 'ready' ? '✓' : '!'}>{d.status === 'ready' ? 'Ready' : d.status}</StatusBadge>
              <span className="text-sm text-ink-soft">{formatBytes(d.bytes)}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-sm text-ink-soft">
          Starter definitions are drafts until a teacher reviews them. Reviewed meanings published by your school replace the draft for the same word.
        </p>
        {vocabMessage ? <Alert tone={vocabMessage.tone} className="mt-2">{vocabMessage.text}</Alert> : null}
        {canFetchVocabulary ? (
          <Button className="mt-2" variant="secondary" icon={<CloudDownload size={18} />} busy={vocabBusy} disabled={!online} onClick={() => void downloadVocabulary()}>
            {online ? 'Download reviewed word meanings' : 'Needs internet to download word meanings'}
          </Button>
        ) : (
          <p className="mt-2 text-sm text-ink-soft">Sign in to download word meanings reviewed by your school.</p>
        )}
      </Card>

      <SpeechPanel online={online} />
    </div>
  );
}

function SpeechPanel({ online }: { online: boolean }) {
  const [caps, setCaps] = useState<Partial<Record<LanguageCode, SpeechCapabilities>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const models = configuredModels();

  const refresh = useCallback(async () => {
    const entries = await Promise.all((Object.keys(LANGUAGES) as LanguageCode[]).map(async (l) => [l, await detectSpeechCapabilities(l)] as const));
    setCaps(Object.fromEntries(entries));
  }, []);
  useEffect(() => void refresh(), [refresh]);

  const install = async (language: LanguageCode) => {
    setBusy(`pack:${language}`);
    setError(null);
    const ok = await installOnDeviceLanguage(LANGUAGES[language].speechLocales[0]);
    resetOnDeviceCheck();
    if (!ok) setError('The browser could not download its speech language pack. Check the internet connection and try again.');
    setBusy(null);
    void refresh();
  };

  return (
    <Card>
      <h2 className="mb-1 text-lg font-bold">Word checking (speech recognition)</h2>
      <p className="mb-3 text-sm text-ink-soft">Word checking follows the reader’s voice. It works offline only when this device has an on-device speech engine for the language.</p>
      {error ? <Alert tone="error" className="mb-3">{error}</Alert> : null}
      <ul className="space-y-3">
        {(Object.keys(LANGUAGES) as LanguageCode[]).map((language) => {
          const c = caps[language];
          const info = LANGUAGES[language];
          return (
            <li key={language} className="rounded-xl border border-line p-3">
              <p className="font-semibold">{info.label}</p>
              {!info.assessmentVerified ? (
                <p className="text-sm">
                  <StatusBadge icon="○">Not available yet</StatusBadge> Word checking for {info.label} stays off until a speech engine has been tested with {info.label} speech. Reading and recording still work.
                </p>
              ) : !c ? <p className="text-sm text-ink-soft">Checking…</p> : (
                <ul className="space-y-1 text-sm">
                  <li>Microphone: <strong>{c.microphone === 'granted' ? 'allowed' : c.microphone === 'denied' ? 'blocked' : c.microphone === 'unsupported' ? 'not supported' : 'will ask'}</strong>; recording: <strong>{c.recording.supported ? `yes (${c.recording.mimeType})` : 'not supported'}</strong></li>
                  <li>
                    Browser on-device engine: <strong>{({ available: 'ready offline', downloadable: 'can be downloaded', downloading: 'downloading…', unavailable: 'not available', unsupported: 'not supported by this browser' } as const)[c.onDeviceRecognition.status]}</strong>
                    {c.onDeviceRecognition.status === 'downloadable' ? (
                      <Button size="sm" variant="secondary" className="ml-2" icon={<CloudDownload size={16} />} disabled={!online} busy={busy === `pack:${language}`} onClick={() => void install(language)}>
                        {online ? 'Download language pack' : 'Needs internet'}
                      </Button>
                    ) : null}
                  </li>
                  {c.onDeviceRecognition.status === 'unavailable' ? (
                    <li>
                      {onDeviceCheckCrashed(c.onDeviceRecognition.locale) ? 'Checking for the on-device engine stopped this browser earlier, so it is not checked automatically. ' : ''}
                      <Button size="sm" variant="ghost" onClick={() => { resetOnDeviceCheck(); void refresh(); }}>Check again</Button>
                    </li>
                  ) : null}
                  <li>Online speech service: <strong>{c.onlineRecognition ? 'available (sends voice to the browser maker; off unless allowed in Settings)' : 'not available'}</strong></li>
                  <li>Computer voice for listening: <strong>{c.speechSynthesis.voiceAvailable ? 'available' : 'not available'}</strong></li>
                  {featureFlags.voskEnabled ? (
                    <li>Experimental on-device engine (Vosk): <strong>{c.wasmEngine.modelDownloaded ? 'model downloaded' : c.wasmEngine.modelConfigured ? 'model not downloaded' : 'no model configured'}</strong></li>
                  ) : null}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {models.map((model) => <ModelRow key={model.language} model={model} online={online} onChange={() => void refresh()} />)}
      {featureFlags.voskEnabled ? <p className="mt-3 text-sm"><Link to="/benchmark" className="underline">For testers: benchmark the on-device engine on this device</Link></p> : null}
    </Card>
  );
}

function ModelRow({ model, online, onChange }: { model: ModelInfo; online: boolean; onChange: () => void }) {
  const [ready, setReady] = useState<boolean | null>(null);
  const [size, setSize] = useState(0);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void isModelDownloaded(model.language).then(setReady);
    void modelSize(model.language).then(setSize);
  }, [model.language, progress]);

  const start = async () => {
    setError(null);
    setProgress(0);
    try {
      // Fetch the engine code too, so it is cached for offline use.
      await import('vosk-browser');
      const bytes = await downloadModel(model, setProgress);
      setSize(bytes);
    } catch (e) {
      setError(/quota/i.test(String(e)) ? 'Not enough space on this device for the speech model.' : `Download failed: ${(e as Error).message}`);
    } finally {
      setProgress(null);
      onChange();
    }
  };

  return (
    <div className="mt-3 rounded-xl border border-sun bg-sun-tint p-3">
      <p className="font-semibold">{model.label} <StatusBadge tone="sun" icon="⚗">Experimental</StatusBadge></p>
      <p className="text-sm">License: {model.license}. Not yet benchmarked on classroom devices; see the project’s speech notes.</p>
      {progress !== null ? <ProgressBar value={progress} label="Downloading speech model" /> : null}
      {error ? <Alert tone="error" className="mt-2">{error}</Alert> : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {ready ? (
          <>
            <StatusBadge tone="teal" icon="✓">Downloaded ({formatBytes(size)})</StatusBadge>
            <Button size="sm" variant="ghost" icon={<Trash2 size={16} />} onClick={() => void removeModel(model.language).then(() => { setReady(false); onChange(); })}>Remove model</Button>
          </>
        ) : (
          <Button size="sm" variant="secondary" icon={<CloudDownload size={16} />} disabled={!online || progress !== null} onClick={() => void start()}>
            {online ? 'Download model' : 'Needs internet'}
          </Button>
        )}
      </div>
    </div>
  );
}
