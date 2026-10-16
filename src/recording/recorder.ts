import { mapMediaError, recordingError, type RecordingError } from './machine';

/** Formats in order of preference; the first one the browser supports is used. */
export const AUDIO_FORMAT_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/aac',
];

export function selectAudioFormat(isTypeSupported?: (type: string) => boolean): string | null {
  const check = isTypeSupported ?? (typeof MediaRecorder !== 'undefined' ? MediaRecorder.isTypeSupported.bind(MediaRecorder) : null);
  if (!check) return null;
  return AUDIO_FORMAT_CANDIDATES.find((type) => {
    try {
      return check(type);
    } catch {
      return false;
    }
  }) ?? null;
}

export interface RecorderCallbacks {
  onChunk: (blob: Blob, seq: number) => void;
  onLevel?: (level: number) => void;
  onError: (error: RecordingError) => void;
}

/**
 * Microphone capture with MediaRecorder. Chunks are emitted every second so they can
 * be stored as they arrive and recovered after an interruption.
 */
export class AudioRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  private stopResolvers: ((blob: Blob | null) => void)[] = [];
  private chunks: Blob[] = [];
  readonly mimeType: string;

  constructor(mimeType: string) {
    this.mimeType = mimeType;
  }

  get mediaStream(): MediaStream | null {
    return this.stream;
  }

  /** Requests the microphone. Throws a RecordingError describing what went wrong. */
  async acquire(): Promise<MediaStream> {
    if (typeof window !== 'undefined' && !window.isSecureContext) throw recordingError('insecure_context');
    if (!navigator.mediaDevices?.getUserMedia) throw recordingError('unsupported');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      return this.stream;
    } catch (error) {
      throw mapMediaError(error, 'acquire');
    }
  }

  start(callbacks: RecorderCallbacks): void {
    if (!this.stream) throw recordingError('recorder_failure');
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(this.stream, { mimeType: this.mimeType, audioBitsPerSecond: 32_000 });
    } catch (error) {
      throw mapMediaError(error);
    }
    this.recorder = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        this.chunks.push(event.data);
        callbacks.onChunk(event.data, this.seq++);
      }
    };
    recorder.onerror = () => callbacks.onError(recordingError('recorder_failure'));
    recorder.onstop = () => {
      const blob = this.chunks.length ? new Blob(this.chunks, { type: this.mimeType }) : null;
      for (const resolve of this.stopResolvers) resolve(blob);
      this.stopResolvers = [];
    };
    // A microphone that disappears mid-recording (unplugged, revoked) is a failure.
    for (const track of this.stream.getAudioTracks()) {
      track.onended = () => callbacks.onError(recordingError('microphone_disconnected'));
    }
    recorder.start(1000);
    this.startLevelMonitor(callbacks.onLevel);
  }

  private startLevelMonitor(onLevel?: (level: number) => void): void {
    if (!onLevel || !this.stream || typeof AudioContext === 'undefined') return;
    try {
      this.context = new AudioContext();
      const source = this.context.createMediaStreamSource(this.stream);
      const analyser = this.context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      this.analyser = analyser;
      const data = new Float32Array(analyser.fftSize);
      this.levelTimer = setInterval(() => {
        analyser.getFloatTimeDomainData(data);
        let sum = 0;
        for (const v of data) sum += v * v;
        onLevel(Math.min(1, Math.sqrt(sum / data.length) * 4));
      }, 200);
    } catch {
      // Level metering is optional; recording continues without it.
    }
  }

  /**
   * Copies the latest microphone samples (-1..1) into `target` for the live waveform.
   * Returns false when the browser offers no audio analysis.
   */
  readWaveform(target: Float32Array<ArrayBuffer>): boolean {
    if (!this.analyser) return false;
    this.analyser.getFloatTimeDomainData(target);
    return true;
  }

  pause(): void {
    if (this.recorder?.state === 'recording') this.recorder.pause();
  }

  resume(): void {
    if (this.recorder?.state === 'paused') this.recorder.resume();
  }

  private collected(): Blob | null {
    return this.chunks.length ? new Blob(this.chunks, { type: this.mimeType }) : null;
  }

  /**
   * Stops recording and resolves with the complete recording (or null if empty). If the
   * browser never reports the stop (a failed recorder), it resolves after `timeoutMs`
   * with the chunks received so far, so saving can never hang.
   */
  stop(timeoutMs = 4_000): Promise<Blob | null> {
    const recorder = this.recorder;
    if (!recorder || recorder.state === 'inactive') return Promise.resolve(this.collected());
    return new Promise((resolve) => {
      const done = (blob: Blob | null) => {
        clearTimeout(timer);
        this.stopResolvers = this.stopResolvers.filter((r) => r !== done);
        resolve(blob);
      };
      const timer = setTimeout(() => done(this.collected()), timeoutMs);
      this.stopResolvers.push(done);
      try {
        recorder.requestData?.();
      } catch {
        // ignore
      }
      try {
        recorder.stop();
      } catch {
        done(this.collected());
      }
    });
  }

  /** Releases the microphone, audio graph, timers and listeners. Safe to call twice. */
  release(): void {
    if (this.levelTimer) clearInterval(this.levelTimer);
    this.levelTimer = null;
    if (this.recorder) {
      this.recorder.ondataavailable = null;
      this.recorder.onerror = null;
      if (this.recorder.state !== 'inactive') {
        try {
          this.recorder.stop();
        } catch {
          // ignore
        }
      }
      this.recorder.onstop = null;
    }
    this.recorder = null;
    for (const track of this.stream?.getTracks() ?? []) {
      track.onended = null;
      track.stop();
    }
    this.stream = null;
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.analyser = null;
    for (const resolve of this.stopResolvers) resolve(null);
    this.stopResolvers = [];
  }
}
