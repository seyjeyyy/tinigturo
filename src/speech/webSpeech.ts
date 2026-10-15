import type { EngineInfo } from '../assessment/scoring';
import type { SpeechErrorKind, SpeechHandlers, SpeechProvider, SpeechStartOptions } from './types';

/* Minimal typings for the Web Speech API, which is not in TypeScript's DOM lib. */
interface RecognitionAlternative { transcript: string }
interface RecognitionResult { readonly isFinal: boolean; readonly length: number; [index: number]: RecognitionAlternative }
interface RecognitionResultList { readonly length: number; [index: number]: RecognitionResult }
interface RecognitionEvent extends Event { readonly resultIndex: number; readonly results: RecognitionResultList }
interface RecognitionErrorEvent extends Event { readonly error: string; readonly message?: string }

export interface WebSpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  processLocally?: boolean;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  start(track?: MediaStreamTrack): void;
  stop(): void;
  abort(): void;
}

export type OnDeviceStatus = 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unsupported';

export interface WebSpeechConstructor {
  new (): WebSpeechRecognition;
  available?: (options: { langs: string[]; processLocally: boolean }) => Promise<string>;
  install?: (options: { langs: string[]; processLocally: boolean }) => Promise<boolean>;
  availableOnDevice?: (lang: string) => Promise<string>;
  installOnDevice?: (lang: string) => Promise<boolean>;
}

export function getWebSpeechConstructor(): WebSpeechConstructor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: WebSpeechConstructor; webkitSpeechRecognition?: WebSpeechConstructor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/*
 * Crash guard for the on-device availability check. In testing, calling
 * SpeechRecognition.available({ processLocally: true }) crashed the renderer of a
 * Chromium build without the on-device speech component. Before each check we write
 * an "in progress" marker synchronously; if a later page load finds a marker that was
 * never cleared, the previous check crashed the page, so on-device recognition is
 * recorded as unavailable and not checked automatically again.
 */
const PROBE_KEY = 'tinigturo:ondevice-probe';
const FRESH_MS: Record<OnDeviceStatus, number> = {
  available: 24 * 3600_000, downloadable: 3600_000, downloading: 60_000, unavailable: 7 * 24 * 3600_000, unsupported: 30 * 24 * 3600_000,
};

interface ProbeCache {
  inFlight?: { locale: string; at: number } | null;
  results?: Record<string, { status: OnDeviceStatus; at: number; crashed?: boolean }>;
}

function readProbeCache(): ProbeCache {
  try {
    return JSON.parse(localStorage.getItem(PROBE_KEY) ?? '{}') as ProbeCache;
  } catch {
    return {};
  }
}

function writeProbeCache(cache: ProbeCache): void {
  try {
    localStorage.setItem(PROBE_KEY, JSON.stringify(cache));
  } catch {
    // storage unavailable: the check simply is not cached
  }
}

/** Forgets cached on-device results (used by "Check again" on the downloads screen). */
export function resetOnDeviceCheck(): void {
  try {
    localStorage.removeItem(PROBE_KEY);
  } catch {
    // ignore
  }
}

/** Whether an earlier on-device check crashed this browser. */
export function onDeviceCheckCrashed(locale: string): boolean {
  return Boolean(readProbeCache().results?.[locale]?.crashed);
}

/**
 * Asks the browser whether on-device recognition is available for a locale. Only a
 * browser that implements this check is trusted to keep audio on the device.
 */
export async function onDeviceStatus(locale: string, now: () => number = Date.now): Promise<OnDeviceStatus> {
  const Ctor = getWebSpeechConstructor();
  if (!Ctor) return 'unsupported';
  if (typeof Ctor.available !== 'function' && typeof Ctor.availableOnDevice !== 'function') return 'unsupported';

  const cache = readProbeCache();
  const results = cache.results ?? {};
  if (cache.inFlight) {
    // A check started before this page loaded never finished: it took that page down.
    // (A check started by this page is still running; another tab checking at the very
    // same moment is treated the same way, which fails safe.)
    const pageStart = typeof performance !== 'undefined' ? performance.timeOrigin : 0;
    if (cache.inFlight.at < pageStart || now() - cache.inFlight.at > 10_000) {
      results[cache.inFlight.locale] = { status: 'unavailable', at: now(), crashed: true };
      writeProbeCache({ inFlight: null, results });
    } else {
      return results[locale]?.status ?? 'unavailable'; // another check is running right now
    }
  }
  const cached = results[locale];
  if (cached && (cached.crashed || now() - cached.at < FRESH_MS[cached.status])) return cached.status;

  writeProbeCache({ inFlight: { locale, at: now() }, results });
  let status: OnDeviceStatus = 'unavailable';
  try {
    let raw: string | undefined;
    if (typeof Ctor.available === 'function') raw = await Ctor.available({ langs: [locale], processLocally: true });
    else raw = await Ctor.availableOnDevice!(locale);
    if (raw === 'available' || raw === 'downloadable' || raw === 'downloading' || raw === 'unavailable') status = raw;
  } catch {
    status = 'unavailable';
  }
  const latest = readProbeCache();
  writeProbeCache({ inFlight: null, results: { ...(latest.results ?? {}), [locale]: { status, at: now() } } });
  return status;
}

/** Downloads the browser's on-device language pack (requires internet once). */
export async function installOnDeviceLanguage(locale: string): Promise<boolean> {
  const Ctor = getWebSpeechConstructor();
  if (!Ctor) return false;
  try {
    if (typeof Ctor.install === 'function') return await Ctor.install({ langs: [locale], processLocally: true });
    if (typeof Ctor.installOnDevice === 'function') return await Ctor.installOnDevice(locale);
  } catch {
    return false;
  }
  return false;
}

function browserVersion(): string {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent;
  const match = ua.match(/(Edg|Chrome|CriOS|Firefox|Version)\/(\d+)/);
  const safari = /Safari/.test(ua) && !/Chrome|CriOS|Edg/.test(ua);
  if (!match) return 'unknown';
  const name = safari ? 'safari' : match[1].toLowerCase().replace('crios', 'chrome').replace('edg', 'edge');
  return `${name}-${match[2]}`;
}

const MAX_RESTARTS_PER_MINUTE = 20;

/**
 * Browser speech recognition. With `processLocally`, audio stays on the device (only
 * used when the browser confirms on-device support); otherwise the browser sends audio
 * to its vendor's speech service, which the UI discloses before use.
 */
export class WebSpeechProvider implements SpeechProvider {
  readonly supportsPartialResults = true;
  readonly engine: EngineInfo;
  private recognition: WebSpeechRecognition | null = null;
  private handlers: SpeechHandlers | null = null;
  private options: SpeechStartOptions | null = null;
  private run = 0;
  private wanted = false; // should be listening
  private partials = new Map<string, string>();
  private restarts: number[] = [];
  private stopWaiters: (() => void)[] = [];
  private disposed = false;

  constructor(private readonly processing: 'on_device' | 'cloud') {
    this.engine = { id: processing === 'on_device' ? 'web-speech-on-device' : 'web-speech-cloud', version: browserVersion(), processing };
  }

  async start(options: SpeechStartOptions, handlers: SpeechHandlers): Promise<void> {
    if (!getWebSpeechConstructor()) {
      handlers.onFatalError('service_unavailable', 'Speech recognition is not available in this browser.');
      return;
    }
    this.options = options;
    this.handlers = handlers;
    this.wanted = true;
    this.startRun();
  }

  private startRun(): void {
    const Ctor = getWebSpeechConstructor();
    if (!Ctor || !this.options || !this.handlers || this.disposed) return;
    const runId = ++this.run;
    const recognition = new Ctor();
    recognition.lang = this.options.locale;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    if (this.processing === 'on_device') recognition.processLocally = true;

    recognition.onstart = () => {
      if (runId === this.run) this.handlers?.onListeningChange(true);
    };
    recognition.onresult = (event) => {
      if (runId !== this.run) return;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const segmentId = `ws${runId}:${i}`;
        const text = result[0]?.transcript ?? '';
        if (result.isFinal) this.partials.delete(segmentId);
        else this.partials.set(segmentId, text);
        this.handlers?.onSegment({ segmentId, text, isFinal: result.isFinal });
      }
    };
    recognition.onerror = (event) => {
      if (runId !== this.run) return;
      const fatal = this.fatalKind(event.error);
      if (fatal) {
        this.wanted = false;
        this.handlers?.onFatalError(fatal, event.message || event.error);
      }
    };
    recognition.onend = () => {
      if (runId !== this.run) return;
      this.finalizePartials();
      this.handlers?.onListeningChange(false);
      for (const resolve of this.stopWaiters.splice(0)) resolve();
      if (this.wanted && !this.disposed) this.restart();
    };
    this.recognition = recognition;
    try {
      const track = this.options.stream?.getAudioTracks()[0];
      // Recent Chrome accepts the recording's track; others ignore the argument.
      if (track) recognition.start(track);
      else recognition.start();
    } catch {
      try {
        recognition.start();
      } catch {
        this.handlers.onFatalError('unknown', 'Speech recognition could not start.');
      }
    }
  }

  private restart(): void {
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < 60_000);
    this.restarts.push(now);
    if (this.restarts.length > MAX_RESTARTS_PER_MINUTE) {
      this.wanted = false;
      this.handlers?.onFatalError('service_unavailable', 'Speech recognition keeps stopping.');
      return;
    }
    setTimeout(() => {
      if (this.wanted && !this.disposed) this.startRun();
    }, 150);
  }

  private fatalKind(error: string): SpeechErrorKind | null {
    switch (error) {
      case 'no-speech':
      case 'aborted':
        return null;
      case 'not-allowed':
      case 'service-not-allowed':
        return 'not_allowed';
      case 'audio-capture':
        return 'no_microphone';
      case 'network':
        return 'network';
      case 'language-not-supported':
        return 'language_unsupported';
      default:
        return 'unknown';
    }
  }

  /** Text that never became final when a run ended is treated as final. */
  private finalizePartials(): void {
    for (const [segmentId, text] of this.partials) this.handlers?.onSegment({ segmentId, text, isFinal: true });
    this.partials.clear();
  }

  pause(): void {
    this.wanted = false;
    this.recognition?.stop();
  }

  resume(): void {
    if (this.wanted || this.disposed) return;
    this.wanted = true;
    this.startRun();
  }

  newSegment(): void {
    // Ending the run closes every open segment; onend starts a fresh run.
    this.recognition?.stop();
  }

  stop(): Promise<void> {
    this.wanted = false;
    const recognition = this.recognition;
    if (!recognition) return Promise.resolve();
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.finalizePartials();
        resolve();
      }, 1500);
      this.stopWaiters.push(() => {
        clearTimeout(timeout);
        resolve();
      });
      recognition.stop();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.wanted = false;
    const recognition = this.recognition;
    this.recognition = null;
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.onstart = null;
      try {
        recognition.abort();
      } catch {
        // ignore
      }
    }
    for (const resolve of this.stopWaiters.splice(0)) resolve();
    this.handlers = null;
  }
}
