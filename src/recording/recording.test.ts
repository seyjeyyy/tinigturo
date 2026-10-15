import { describe, expect, it } from 'vitest';
import { INITIAL_RECORDING_STATE, mapMediaError, recordingError, recordingReducer, type RecordingEvent, type RecordingState } from './machine';
import { SessionClock } from './clock';
import { selectAudioFormat } from './recorder';

function run(events: RecordingEvent[], start: RecordingState = INITIAL_RECORDING_STATE) {
  return events.reduce(recordingReducer, start);
}

describe('recording state machine', () => {
  it('follows idle -> requesting permission -> ready -> recording -> paused -> processing -> result', () => {
    const states = [
      { type: 'REQUEST', token: 1 }, { type: 'GRANTED', token: 1 }, { type: 'START', token: 1 },
      { type: 'PAUSE', token: 1, reason: 'user' }, { type: 'RESUME', token: 1 }, { type: 'FINISH', token: 1 }, { type: 'DONE', token: 1 },
    ].reduce<RecordingState[]>((acc, e) => [...acc, recordingReducer(acc[acc.length - 1], e as RecordingEvent)], [INITIAL_RECORDING_STATE]);
    expect(states.map((s) => s.status)).toEqual([
      'idle', 'requesting_permission', 'ready', 'recording', 'paused', 'recording', 'processing', 'result',
    ]);
  });

  it('allows only one active attempt and ignores duplicate actions', () => {
    const recording = run([{ type: 'REQUEST', token: 1 }, { type: 'GRANTED', token: 1 }, { type: 'START', token: 1 }]);
    expect(recordingReducer(recording, { type: 'REQUEST', token: 2 })).toBe(recording);
    expect(recordingReducer(recording, { type: 'START', token: 1 })).toBe(recording);
    const processing = recordingReducer(recording, { type: 'FINISH', token: 1 });
    expect(recordingReducer(processing, { type: 'FINISH', token: 1 })).toBe(processing);
    expect(recordingReducer(processing, { type: 'PAUSE', token: 1, reason: 'user' })).toBe(processing);
  });

  it('ignores callbacks from an older attempt', () => {
    const first = run([{ type: 'REQUEST', token: 1 }, { type: 'FAIL', token: 1, error: recordingError('permission_denied') }]);
    const second = run([{ type: 'REQUEST', token: 2 }, { type: 'GRANTED', token: 2 }], first);
    // A late failure and a late grant from attempt 1 arrive:
    expect(recordingReducer(second, { type: 'FAIL', token: 1, error: recordingError('recorder_failure') })).toBe(second);
    expect(recordingReducer(second, { type: 'DONE', token: 1 })).toBe(second);
    expect(second.status).toBe('ready');
  });

  it('a microphone denial is recoverable and a valid retry clears the error', () => {
    const denied = run([{ type: 'REQUEST', token: 1 }, { type: 'FAIL', token: 1, error: mapMediaError({ name: 'NotAllowedError' }) }]);
    expect(denied).toMatchObject({ status: 'error', error: { kind: 'permission_denied' } });
    const retry = recordingReducer(denied, { type: 'REQUEST', token: 2 });
    expect(retry).toEqual({ status: 'requesting_permission', token: 2 });
    expect('error' in retry).toBe(false);
  });

  it('cancels from any active state', () => {
    for (const events of [
      [{ type: 'REQUEST', token: 1 }],
      [{ type: 'REQUEST', token: 1 }, { type: 'GRANTED', token: 1 }],
      [{ type: 'REQUEST', token: 1 }, { type: 'GRANTED', token: 1 }, { type: 'START', token: 1 }],
      [{ type: 'REQUEST', token: 1 }, { type: 'GRANTED', token: 1 }, { type: 'START', token: 1 }, { type: 'PAUSE', token: 1, reason: 'interruption' }],
    ] as RecordingEvent[][]) {
      expect(recordingReducer(run(events), { type: 'CANCEL', token: 1 }).status).toBe('idle');
    }
  });

  it('distinguishes microphone failures', () => {
    expect(mapMediaError({ name: 'NotAllowedError' }).kind).toBe('permission_denied');
    expect(mapMediaError({ name: 'NotFoundError' }).kind).toBe('no_microphone');
    expect(mapMediaError({ name: 'NotReadableError' }).kind).toBe('microphone_busy');
    expect(mapMediaError({ name: 'NotSupportedError' }).kind).toBe('unsupported_format');
    expect(mapMediaError({ name: 'NotSupportedError' }, 'acquire').kind).toBe('unsupported');
    expect(mapMediaError(new Error('boom')).kind).toBe('recorder_failure');
  });
});

describe('audio format selection', () => {
  it('chooses the first supported format at runtime', () => {
    expect(selectAudioFormat((t) => t === 'audio/mp4')).toBe('audio/mp4');
    expect(selectAudioFormat((t) => t.startsWith('audio/webm'))).toBe('audio/webm;codecs=opus');
    expect(selectAudioFormat(() => false)).toBeNull();
  });
});

describe('SessionClock — pause and resume timing', () => {
  function fakeTime() {
    let t = 0;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  }

  it('excludes explicit pauses and interruptions but keeps hesitation', () => {
    const time = fakeTime();
    const clock = new SessionClock(time.now);
    clock.start();
    clock.setListening(true);
    time.advance(10_000); // reading, including natural hesitation
    clock.pause('user');
    time.advance(30_000); // explicit pause: excluded
    clock.resume();
    time.advance(5_000);
    clock.pause('interruption'); // app went to the background
    time.advance(60_000);
    clock.resume();
    time.advance(5_000);
    expect(clock.stop()).toEqual({ activeMs: 20_000, pausedMs: 30_000, interruptedMs: 60_000, assessedMs: 20_000 });
  });

  it('does not count time while the recognizer restarts as assessed time', () => {
    const time = fakeTime();
    const clock = new SessionClock(time.now);
    clock.start();
    clock.setListening(true);
    time.advance(8_000);
    clock.setListening(false); // recognizer restarting
    time.advance(1_500);
    clock.setListening(true);
    time.advance(2_000);
    const timing = clock.stop();
    expect(timing.activeMs).toBe(11_500);
    expect(timing.assessedMs).toBe(10_000);
    expect(timing.interruptedMs).toBe(1_500);
  });

  it('stamps transcript events with the assessment clock, which stops while paused', () => {
    const time = fakeTime();
    const clock = new SessionClock(time.now);
    clock.start();
    clock.setListening(true);
    time.advance(4_000);
    expect(clock.assessedNow()).toBe(4_000);
    clock.pause('user');
    time.advance(10_000);
    expect(clock.assessedNow()).toBe(4_000);
    clock.resume();
    time.advance(1_000);
    expect(clock.assessedNow()).toBe(5_000);
  });

  it('restores from a saved timing after an app reload', () => {
    const time = fakeTime();
    const clock = SessionClock.fromTiming({ activeMs: 5_000, pausedMs: 1_000, interruptedMs: 0, assessedMs: 4_000 }, time.now);
    clock.start();
    clock.setListening(true);
    time.advance(2_000);
    expect(clock.stop()).toEqual({ activeMs: 7_000, pausedMs: 1_000, interruptedMs: 0, assessedMs: 6_000 });
  });
});
