/**
 * Explicit recording state machine:
 *
 *   idle -> requesting_permission -> ready -> recording <-> paused -> processing -> result
 *
 * plus `error` (recoverable: a new REQUEST starts a clean attempt) and CANCEL from any
 * active state back to idle. Every event carries the session token of the attempt it
 * belongs to; events from an older attempt are ignored, so late callbacks can never
 * change a newer attempt. Events that are not valid in the current state are ignored,
 * which also makes double-taps harmless.
 */

export type RecordingErrorKind =
  | 'permission_denied'
  | 'no_microphone'
  | 'microphone_disconnected'
  | 'microphone_busy'
  | 'insecure_context'
  | 'unsupported'
  | 'unsupported_format'
  | 'recorder_failure'
  | 'storage_full';

export interface RecordingError {
  kind: RecordingErrorKind;
  message: string;
  /** Guidance for the adult helping the reader. */
  help: string;
}

export type PauseReason = 'user' | 'interruption';

export type RecordingState =
  | { status: 'idle'; token: number }
  | { status: 'requesting_permission'; token: number }
  | { status: 'ready'; token: number }
  | { status: 'recording'; token: number }
  | { status: 'paused'; token: number; reason: PauseReason }
  | { status: 'processing'; token: number }
  | { status: 'result'; token: number }
  | { status: 'error'; token: number; error: RecordingError };

export type RecordingEvent =
  | { type: 'REQUEST'; token: number }
  | { type: 'GRANTED'; token: number }
  | { type: 'FAIL'; token: number; error: RecordingError }
  | { type: 'START'; token: number }
  | { type: 'PAUSE'; token: number; reason: PauseReason }
  | { type: 'RESUME'; token: number }
  | { type: 'FINISH'; token: number }
  | { type: 'DONE'; token: number }
  | { type: 'CANCEL'; token: number }
  | { type: 'RESET'; token: number };

export const INITIAL_RECORDING_STATE: RecordingState = { status: 'idle', token: 0 };

export function isActive(state: RecordingState): boolean {
  return state.status === 'requesting_permission' || state.status === 'ready' || state.status === 'recording' || state.status === 'paused' || state.status === 'processing';
}

/** States in which leaving the page would lose an unfinished attempt. */
export function hasUnsavedAttempt(state: RecordingState): boolean {
  return state.status === 'recording' || state.status === 'paused' || state.status === 'processing';
}

export function recordingReducer(state: RecordingState, event: RecordingEvent): RecordingState {
  if (event.type === 'REQUEST') {
    // Only one attempt at a time; a new one can start from idle, a result, or an error.
    if (state.status === 'idle' || state.status === 'result' || state.status === 'error') {
      if (event.token <= state.token) return state;
      return { status: 'requesting_permission', token: event.token };
    }
    return state;
  }
  if (event.token !== state.token) return state;

  switch (event.type) {
    case 'GRANTED':
      return state.status === 'requesting_permission' ? { status: 'ready', token: state.token } : state;
    case 'START':
      return state.status === 'ready' ? { status: 'recording', token: state.token } : state;
    case 'PAUSE':
      return state.status === 'recording' ? { status: 'paused', token: state.token, reason: event.reason } : state;
    case 'RESUME':
      return state.status === 'paused' ? { status: 'recording', token: state.token } : state;
    case 'FINISH':
      return state.status === 'recording' || state.status === 'paused' ? { status: 'processing', token: state.token } : state;
    case 'DONE':
      return state.status === 'processing' ? { status: 'result', token: state.token } : state;
    case 'FAIL':
      return isActive(state) ? { status: 'error', token: state.token, error: event.error } : state;
    case 'CANCEL':
      return isActive(state) ? { status: 'idle', token: state.token } : state;
    case 'RESET':
      return state.status === 'result' || state.status === 'error' ? { status: 'idle', token: state.token } : state;
    default:
      return state;
  }
}

export const RECORDING_ERRORS: Record<RecordingErrorKind, Omit<RecordingError, 'kind'>> = {
  permission_denied: {
    message: 'Tinig Turo is not allowed to use the microphone.',
    help: 'A grown-up can allow the microphone in the settings for this app or website. You can still read without recording.',
  },
  no_microphone: {
    message: 'No microphone was found.',
    help: 'Plug in or turn on a microphone or headset, then try again.',
  },
  microphone_disconnected: {
    message: 'The microphone stopped working during the reading.',
    help: 'What was recorded before it stopped has been saved. Check the headset or microphone, then start a new reading.',
  },
  microphone_busy: {
    message: 'The microphone is being used by another app.',
    help: 'Close other apps or tabs that use the microphone (calls, recorders), then try again.',
  },
  insecure_context: {
    message: 'The microphone only works on a secure (https) page.',
    help: 'Open Tinig Turo from its https address or from the installed app.',
  },
  unsupported: {
    message: 'This browser cannot record audio.',
    help: 'You can still read and practice. Try a recent version of Chrome, Edge, Safari or Firefox to record.',
  },
  unsupported_format: {
    message: 'This browser cannot save recordings in a supported format.',
    help: 'You can still read and practice. Try a recent version of Chrome, Edge, Safari or Firefox to record.',
  },
  recorder_failure: {
    message: 'The recording stopped unexpectedly.',
    help: 'What was recorded so far has been kept. Try again; if it keeps happening, restart the browser.',
  },
  storage_full: {
    message: 'This device is out of space, so the recording could not be saved.',
    help: 'Remove downloaded stories you no longer need on the Offline downloads screen, then try again.',
  },
};

export function recordingError(kind: RecordingErrorKind): RecordingError {
  return { kind, ...RECORDING_ERRORS[kind] };
}

/**
 * Maps getUserMedia / MediaRecorder failures to distinct, explainable errors.
 * NotSupportedError means the browser cannot capture audio at all when it comes from
 * getUserMedia, and an unsupported recording format when it comes from MediaRecorder.
 */
export function mapMediaError(error: unknown, phase: 'acquire' | 'record' = 'record'): RecordingError {
  const name = (error as { name?: string })?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return recordingError('permission_denied');
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return recordingError('no_microphone');
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return recordingError('microphone_busy');
    case 'NotSupportedError':
      return recordingError(phase === 'acquire' ? 'unsupported' : 'unsupported_format');
    case 'QuotaExceededError':
      return recordingError('storage_full');
    default:
      return recordingError('recorder_failure');
  }
}
