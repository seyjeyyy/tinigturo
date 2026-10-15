import type { EngineInfo } from '../assessment/scoring';
import type { LanguageCode } from '../text/language';
import { modelObjectUrl } from './models';
import type { SpeechHandlers, SpeechProvider, SpeechStartOptions } from './types';

/**
 * EXPERIMENTAL on-device recognition with Vosk (Kaldi compiled to WebAssembly, via the
 * `vosk-browser` package). Recognition runs in the package's own Web Worker; audio is
 * captured with an AudioWorklet off the main thread. Disabled unless VITE_ENABLE_VOSK
 * is true and a model has been downloaded.
 *
 * Status: not yet benchmarked on target low-cost devices (docs/SPEECH.md). The package
 * has not been updated since 2022, so treat it as a candidate under evaluation.
 */
export const VOSK_ENGINE_VERSION = 'vosk-browser-0.0.8';

const WORKLET_SOURCE = `
class TinigTap extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new Float32Array(4096); this.length = 0; }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.buffer[this.length++] = channel[i];
        if (this.length === this.buffer.length) { this.port.postMessage(this.buffer.slice(0)); this.length = 0; }
      }
    }
    return true;
  }
}
registerProcessor('tinig-tap', TinigTap);
`;

type VoskModule = typeof import('vosk-browser');
type VoskModel = Awaited<ReturnType<VoskModule['createModel']>>;
type VoskRecognizer = InstanceType<VoskModel['KaldiRecognizer']>;

let modelPromise: Promise<VoskModel> | null = null;
let modelLanguage: LanguageCode | null = null;

async function loadModel(language: LanguageCode): Promise<VoskModel> {
  if (modelPromise && modelLanguage === language) return modelPromise;
  modelLanguage = language;
  modelPromise = (async () => {
    const url = await modelObjectUrl(language);
    if (!url) throw new Error('The speech model has not been downloaded.');
    const vosk = await import('vosk-browser');
    return vosk.createModel(url);
  })();
  modelPromise.catch(() => {
    modelPromise = null;
  });
  return modelPromise;
}

export interface VoskBenchmark {
  modelLoadMs: number;
  audioSeconds: number;
  processingMs: number;
  realTimeFactor: number;
  transcript: string;
  heapUsedMb: number | null;
}

/**
 * Runs the engine over decoded audio as fast as possible, for the device benchmark
 * screen. A real-time factor below 1 means it keeps up with live speech.
 */
export async function benchmarkVosk(language: LanguageCode, audio: AudioBuffer): Promise<VoskBenchmark> {
  const t0 = performance.now();
  const model = await loadModel(language);
  const modelLoadMs = performance.now() - t0;
  const recognizer = new model.KaldiRecognizer(audio.sampleRate);
  const parts: string[] = [];
  const done = new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    recognizer.on('result', (message) => {
      if (message.event === 'result' && message.result.text) parts.push(message.result.text);
      if (timer) clearTimeout(timer);
      timer = setTimeout(resolve, 1500); // the final result has arrived when results stop
    });
  });
  const samples = audio.getChannelData(0);
  const chunk = 4096;
  const t1 = performance.now();
  for (let i = 0; i < samples.length; i += chunk) recognizer.acceptWaveformFloat(samples.slice(i, i + chunk), audio.sampleRate);
  recognizer.retrieveFinalResult();
  await done;
  const processingMs = performance.now() - t1 - 1500;
  recognizer.remove();
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return {
    modelLoadMs: Math.round(modelLoadMs),
    audioSeconds: Math.round(audio.duration * 10) / 10,
    processingMs: Math.round(processingMs),
    realTimeFactor: Math.round((processingMs / 1000 / audio.duration) * 100) / 100,
    transcript: parts.join(' '),
    heapUsedMb: memory ? Math.round(memory.usedJSHeapSize / 2 ** 20) : null,
  };
}

export class VoskProvider implements SpeechProvider {
  readonly supportsPartialResults = true;
  readonly engine: EngineInfo = { id: 'vosk-wasm', version: VOSK_ENGINE_VERSION, processing: 'on_device' };
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private recognizer: VoskRecognizer | null = null;
  private utterance = 0;
  private paused = false;
  private handlers: SpeechHandlers | null = null;

  constructor(private readonly language: LanguageCode) {}

  async start(options: SpeechStartOptions, handlers: SpeechHandlers): Promise<void> {
    this.handlers = handlers;
    if (!options.stream) {
      handlers.onFatalError('no_microphone', 'No microphone stream for on-device recognition.');
      return;
    }
    let model: VoskModel;
    try {
      model = await loadModel(this.language);
    } catch (error) {
      handlers.onFatalError('model_missing', (error as Error).message);
      return;
    }
    this.context = new AudioContext();
    const sampleRate = this.context.sampleRate;
    const recognizer = new model.KaldiRecognizer(sampleRate);
    this.recognizer = recognizer;
    recognizer.on('partialresult', (message) => {
      if (message.event !== 'partialresult') return;
      const text = message.result.partial;
      if (text) this.handlers?.onSegment({ segmentId: `vk${this.utterance}`, text, isFinal: false });
    });
    recognizer.on('result', (message) => {
      if (message.event !== 'result') return;
      this.handlers?.onSegment({ segmentId: `vk${this.utterance}`, text: message.result.text, isFinal: true });
      this.utterance++;
    });
    recognizer.on('error', (message) => {
      if (message.event === 'error') this.handlers?.onFatalError('unknown', message.error);
    });

    const workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
    await this.context.audioWorklet.addModule(workletUrl);
    URL.revokeObjectURL(workletUrl);
    this.source = this.context.createMediaStreamSource(options.stream);
    this.node = new AudioWorkletNode(this.context, 'tinig-tap');
    this.node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (!this.paused) this.recognizer?.acceptWaveformFloat(event.data, sampleRate);
    };
    this.source.connect(this.node);
    handlers.onListeningChange(true);
  }

  pause(): void {
    this.paused = true;
    this.recognizer?.retrieveFinalResult();
    this.handlers?.onListeningChange(false);
  }

  resume(): void {
    this.paused = false;
    this.handlers?.onListeningChange(true);
  }

  newSegment(): void {
    this.recognizer?.retrieveFinalResult();
  }

  async stop(): Promise<void> {
    this.paused = true;
    this.recognizer?.retrieveFinalResult();
    // Give the worker a moment to deliver the final result.
    await new Promise((resolve) => setTimeout(resolve, 400));
    this.handlers?.onListeningChange(false);
  }

  dispose(): void {
    this.paused = true;
    this.source?.disconnect();
    this.node?.disconnect();
    if (this.node) this.node.port.onmessage = null;
    void this.context?.close().catch(() => undefined);
    try {
      this.recognizer?.remove();
    } catch {
      // ignore
    }
    this.recognizer = null;
    this.context = null;
    this.handlers = null;
  }
}
