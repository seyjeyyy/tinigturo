import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadAloudController, type RecorderLike, type ReadAloudDeps } from './readAloudController';
import { deletePartition, getDb, type TinigDb } from '../db/localDb';
import { ensureBundledContent } from '../data/bootstrap';
import { createLearner } from '../data/learners';
import { recoverSession } from '../data/sessions';
import { STARTER_STORIES } from '../content/starterStories';
import { tokenizePassage } from '../text/tokenize';
import { mapMediaError, recordingError, type RecordingError } from '../recording/machine';
import type { RecorderCallbacks } from '../recording/recorder';
import type { SpeechHandlers, SpeechProvider } from '../speech/types';
import type { RecognitionPlan } from '../speech/plan';

class FakeRecorder implements RecorderLike {
  readonly mimeType = 'audio/webm';
  mediaStream: MediaStream | null = null;
  callbacks: RecorderCallbacks | null = null;
  acquire: () => Promise<MediaStream>;
  released = false;
  constructor(private readonly deny: unknown = null) {
    this.acquire = async () => {
      if (this.deny) throw mapMediaError(this.deny);
      this.mediaStream = {} as MediaStream;
      return this.mediaStream;
    };
  }
  start(callbacks: RecorderCallbacks) {
    this.callbacks = callbacks;
    callbacks.onChunk(new Blob(['chunk-0'], { type: 'audio/webm' }), 0);
  }
  pause() {}
  resume() {}
  async stop() {
    return new Blob(['full-recording'], { type: 'audio/webm' });
  }
  release() {
    this.released = true;
  }
}

class FakeProvider implements SpeechProvider {
  readonly supportsPartialResults = true;
  readonly engine = { id: 'fake', version: '1', processing: 'on_device' as const };
  handlers: SpeechHandlers | null = null;
  paused = false;
  async start(_: unknown, handlers: SpeechHandlers) {
    this.handlers = handlers;
    handlers.onListeningChange(true);
  }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  newSegment() {}
  async stop() {}
  dispose() { this.handlers = null; }
  say(id: string, text: string, isFinal = true) {
    this.handlers?.onSegment({ segmentId: id, text, isFinal });
  }
}

const story = STARTER_STORIES[0]; // "Pip is a little puppy. ..."
const passage = tokenizePassage(story.body, story.language);
const onDevice: RecognitionPlan = { kind: 'on_device', engine: 'web_speech_local', locale: 'en-US' };
let db: TinigDb;
let learnerId: string;
let time: number;

function make(overrides: Partial<ReadAloudDeps> & { recorder?: () => RecorderLike; provider?: FakeProvider | null } = {}) {
  const provider = overrides.provider === undefined ? new FakeProvider() : overrides.provider;
  const recorders: RecorderLike[] = [];
  const controller = new ReadAloudController({
    db, story, passage, learnerId, assignmentId: null, plan: onDevice, audioFormat: 'audio/webm',
    createRecorder: () => {
      const r = overrides.recorder?.() ?? new FakeRecorder();
      recorders.push(r);
      return r;
    },
    createProvider: () => provider,
    shareAudio: () => false,
    now: () => time,
    checkpointIntervalMs: 60_000,
    ...overrides,
  });
  return { controller, provider, recorders };
}

beforeEach(async () => {
  time = 0;
  db = getDb('device');
  await ensureBundledContent(db);
  learnerId = (await createLearner(db, { displayName: 'Ana', avatar: 'owl', gradeLevel: 1 })).id;
});

afterEach(async () => {
  await deletePartition('device');
});

describe('ReadAloudController', () => {
  it('follows the voice, saves the attempt, and releases the microphone', async () => {
    const { controller, provider, recorders } = make();
    await controller.begin();
    expect(controller.getSnapshot().recording.status).toBe('recording');

    time += 2_000;
    provider!.say('a', 'pip is a', false);
    expect(controller.getSnapshot().alignment?.current).toBe(2);
    expect(controller.getSnapshot().alignment?.words[2]?.tentative).toBe(true);
    time += 20_000;
    provider!.say('a', story.body.replace(/\n+/g, ' '), true);
    time += 1_000;
    await controller.finish();

    const snap = controller.getSnapshot();
    expect(snap.recording.status).toBe('result');
    const session = snap.result!.session;
    expect(session.status).toBe('saved');
    expect(session.assessment).toMatchObject({ status: 'assessed', completion: 'complete', correctWords: passage.words.length });
    expect(session.assessment?.cwpm).toBeGreaterThan(0);
    expect(session.audio.status).toBe('local');
    expect(await db.recordings.get(session.id)).toBeDefined();
    expect(await db.audioChunks.where('sessionId').equals(session.id).count()).toBe(0);
    expect((recorders[0] as FakeRecorder).released).toBe(true);
    expect(snap.result!.awards.map((a) => a.badgeCode)).toContain('story_finisher');
  });

  it('microphone denial shows one clear error and a retry clears it', async () => {
    let deny: unknown = { name: 'NotAllowedError' };
    const { controller } = make({ recorder: () => new FakeRecorder(deny) });
    await controller.begin();
    const denied = controller.getSnapshot().recording;
    expect(denied.status).toBe('error');
    expect((denied as { error: RecordingError }).error.kind).toBe('permission_denied');
    expect(controller.getSnapshot().notice).toBeNull();

    deny = null;
    await controller.begin();
    expect(controller.getSnapshot().recording.status).toBe('recording');
    expect('error' in controller.getSnapshot().recording).toBe(false);
    await controller.cancel();
  });

  it('without recognition: practice is saved and word assessment is clearly unavailable', async () => {
    const plan: RecognitionPlan = { kind: 'none', reason: 'recognition_unavailable', explanation: 'x' };
    const { controller } = make({ plan, provider: null });
    await controller.begin();
    expect(controller.getSnapshot().following).toBe(false);
    expect(controller.getSnapshot().alignment).toBeNull();
    time += 30_000;
    await controller.finish();
    const session = controller.getSnapshot().result!.session;
    expect(session.assessment).toMatchObject({ status: 'unassessed', cwpm: null, correctWords: 0, completion: 'unknown' });
    expect(session.wordResults).toBeNull();
    expect(session.audio.status).toBe('local');
    // Participation is rewarded; performance is not.
    const codes = controller.getSnapshot().result!.awards.map((a) => a.badgeCode);
    expect(codes).toContain('first_practice');
    expect(codes).not.toContain('story_finisher');
  });

  it('pausing freezes the highlight and the clock', async () => {
    const { controller, provider } = make();
    await controller.begin();
    time += 3_000;
    provider!.say('a', 'pip is', true);
    controller.pause();
    expect(provider!.paused).toBe(true);
    time += 60_000;
    provider!.say('b', 'a little puppy', true); // late result while paused is ignored
    expect(controller.getSnapshot().alignment?.current).toBe(1);
    controller.resume();
    time += 2_000;
    provider!.say('c', 'a little', true);
    expect(controller.getSnapshot().alignment?.current).toBe(3);
    await controller.finish();
    const timing = controller.getSnapshot().result!.session.timing;
    expect(timing.pausedMs).toBe(60_000);
    expect(timing.activeMs).toBe(5_000);
  });

  it('keeps recording when recognition fails mid-way and says so', async () => {
    const { controller, provider } = make();
    await controller.begin();
    time += 2_000;
    provider!.say('a', 'pip is a little puppy', true);
    provider!.handlers!.onFatalError('network', 'lost');
    expect(controller.getSnapshot().recording.status).toBe('recording');
    expect(controller.getSnapshot().notice?.kind).toBe('recognition_lost');
    time += 10_000;
    await controller.finish();
    const assessment = controller.getSnapshot().result!.session.assessment!;
    expect(assessment.completion).toBe('partial');
    expect(assessment.reviewReasons).toContain('recognition_interrupted');
  });

  it('hints about silence and about noise without stopping', async () => {
    const { controller, recorders } = make({ silenceAfterMs: 8_000 });
    await controller.begin();
    time += 9_000;
    (recorders[0] as FakeRecorder).callbacks!.onLevel!(0.01);
    expect(controller.getSnapshot().notice?.kind).toBe('silence');
    // Loud sound but no words recognized for a long time: noise.
    time += 5_000;
    (recorders[0] as FakeRecorder).callbacks!.onLevel!(0.6);
    expect(controller.getSnapshot().notice?.kind).toBe('noise');
    expect(controller.getSnapshot().recording.status).toBe('recording');
    await controller.cancel();
  });

  it('"Continue from here" moves on without crediting skipped words', async () => {
    const { controller, provider } = make();
    await controller.begin();
    provider!.say('a', 'pip is', true);
    controller.continueFrom(10);
    provider!.say('b', passage.words.slice(10, 13).map((w) => w.core).join(' '), true);
    time += 15_000;
    await controller.finish();
    const words = controller.getSnapshot().result!.session.wordResults!;
    expect(words.slice(2, 10).every((w) => w.status === 'unassessed')).toBe(true);
    expect(words.slice(10, 13).every((w) => w.status === 'correct')).toBe(true);
  });

  it('suspends recognition while the app pronounces a word', async () => {
    const { controller, provider } = make();
    await controller.begin();
    provider!.say('a', 'pip', true);
    await controller.withRecognitionSuspended(async () => {
      expect(provider!.paused).toBe(true);
      provider!.say('b', 'is a little puppy', true); // the app's own voice
      expect(controller.getSnapshot().notice).toBeNull();
    });
    expect(controller.getSnapshot().recording.status).toBe('recording');
    expect(controller.getSnapshot().alignment?.current).toBe(0);
    await controller.cancel();
  });

  it('cancelling discards the attempt and its audio', async () => {
    const { controller } = make();
    await controller.begin();
    const sessions = await db.sessions.toArray();
    expect(sessions).toHaveLength(1);
    await controller.cancel();
    expect(await db.sessions.count()).toBe(0);
    expect(await db.audioChunks.count()).toBe(0);
    expect(controller.getSnapshot().recording.status).toBe('idle');
  });

  it('an interrupted attempt survives an app reload and can be recovered', async () => {
    const { controller, provider } = make({ checkpointIntervalMs: 10 });
    await controller.begin();
    time += 5_000;
    provider!.say('a', 'pip is a little puppy', true);
    await new Promise((r) => setTimeout(r, 40)); // a checkpoint is written
    controller.dispose(); // tab closed / navigated away
    await new Promise((r) => setTimeout(r, 20));

    // "Reload": open the database fresh.
    db.close();
    db = getDb('device');
    await db.open();
    const pending = await db.sessions.where('status').equals('in_progress').toArray();
    expect(pending).toHaveLength(1);
    expect(await db.audioChunks.where('sessionId').equals(pending[0].id).count()).toBe(1);

    const recovered = await recoverSession(db, pending[0].id, false);
    expect(recovered?.session.recovered).toBe(true);
    expect(recovered?.session.assessment?.completion).toBe('partial');
    expect(recovered?.session.wordResults?.slice(0, 5).every((w) => w.status === 'correct')).toBe(true);
    expect(await db.recordings.get(pending[0].id)).toBeDefined();
  });

  it('a storage-quota failure while saving keeps the recording available', async () => {
    const { controller } = make();
    await controller.begin();
    time += 12_000;
    const quota = Object.assign(new Error('QuotaExceededError'), { name: 'QuotaExceededError' });
    const spy = vi.spyOn(db.sessions, 'put').mockRejectedValueOnce(quota);
    await controller.finish();
    spy.mockRestore();
    const snap = controller.getSnapshot();
    expect(snap.recording.status).toBe('error');
    expect((snap.recording as { error: RecordingError }).error.kind).toBe('storage_full');
    expect(snap.unsavedRecording).toBeInstanceOf(Blob);
    // The atomic save left no half-saved attempt or orphaned sync op behind.
    expect(await db.outbox.count()).toBe(0);
    expect((await db.sessions.toArray())[0].status).toBe('in_progress');
  });

  it('leaving the screen while the permission prompt is open does not leave the microphone on', async () => {
    let grant!: () => void;
    const recorder = new FakeRecorder();
    recorder.acquire = () => new Promise<MediaStream>((resolve) => { grant = () => resolve({} as MediaStream); });
    const { controller } = make({ recorder: () => recorder });
    const starting = controller.begin();
    await Promise.resolve();
    controller.dispose(); // navigated away while the browser asks
    grant(); // the adult allows the microphone afterwards
    await starting;
    expect(recorder.released).toBe(true);
    expect(recorder.callbacks).toBeNull(); // never started recording
    expect(await db.sessions.count()).toBe(0);
  });

  it('cancelling while the attempt is being created leaves no unfinished attempt behind', async () => {
    const { controller, recorders } = make();
    const unsubscribe = controller.subscribe(() => {
      if (controller.getSnapshot().recording.status === 'ready') void controller.cancel();
    });
    await controller.begin();
    unsubscribe();
    await new Promise((r) => setTimeout(r, 20));
    expect(controller.getSnapshot().recording.status).toBe('idle');
    expect((recorders[0] as FakeRecorder).released).toBe(true);
    expect(await db.sessions.count()).toBe(0);
  });

  it('a blocked microphone is explained without asking the browser again', async () => {
    const { controller, recorders } = make({ checkMicrophone: async () => 'denied' });
    await controller.begin();
    const state = controller.getSnapshot().recording;
    expect(state.status).toBe('error');
    expect((state as { error: RecordingError }).error.kind).toBe('permission_denied');
    expect(recorders).toHaveLength(0); // getUserMedia was never called
  });

  it('the final text of speech heard before Pause completes the phrase, but new speech while paused does not', async () => {
    const { controller, provider } = make();
    await controller.begin();
    time += 2_000;
    provider!.say('a', 'pip is a', false);
    controller.pause();
    provider!.say('a', 'pip is a little', true); // recognizer flush after Pause
    provider!.say('b', 'puppy pip likes', true); // a new phrase while paused
    let snap = controller.getSnapshot().alignment!;
    expect(snap.current).toBe(3);
    expect(snap.words.slice(0, 4).every((w) => w && !w.tentative)).toBe(true);
    expect(snap.words[4]).toBeNull();
    controller.resume();
    provider!.say('c', 'puppy', true);
    snap = controller.getSnapshot().alignment!;
    expect(snap.current).toBe(4);
    expect(snap.confirmedThrough).toBe(4);
    await controller.cancel();
  });

  it('text a recognizer never finalized before a pause stops being tentative after Continue', async () => {
    const { controller, provider } = make();
    await controller.begin();
    provider!.say('a', 'pip is a', false);
    controller.pause(); // the engine stops without finalizing segment "a"
    controller.resume();
    provider!.say('b', 'little puppy', true);
    const snap = controller.getSnapshot().alignment!;
    expect(snap.words.slice(0, 5).every((w) => w && !w.tentative)).toBe(true);
    expect(snap.confirmedThrough).toBe(4);
    await controller.cancel();
  });

  it('counts the final words the recognizer delivers after Finish, timed at the moment reading stopped', async () => {
    const { controller, provider } = make();
    await controller.begin();
    time += 12_000;
    provider!.say('a', 'pip is a little', false);
    provider!.stop = async () => {
      time += 1_500; // flushing takes a moment; it is not reading time
      provider!.say('a', 'pip is a little puppy', true);
    };
    await controller.finish();
    const session = controller.getSnapshot().result!.session;
    expect(session.wordResults!.slice(0, 5).every((w) => w.status === 'correct')).toBe(true);
    expect(session.timing.activeMs).toBe(12_000);
    expect(session.assessment?.assessedMs).toBeLessThanOrEqual(12_000);
  });

  it('a recognizer that fails before recognizing any words is not reported as a silent reader', async () => {
    const { controller, provider } = make();
    await controller.begin();
    provider!.handlers!.onFatalError('not_allowed', 'speech service blocked');
    time += 20_000;
    await controller.finish();
    const assessment = controller.getSnapshot().result!.session.assessment!;
    expect(assessment).toMatchObject({ status: 'unassessed', unassessedReason: 'recognition_failed', cwpm: null, completion: 'unknown' });
  });

  it('voice picked up with no recognized words is a recognition problem; a silent attempt is not', async () => {
    const loud = make();
    await loud.controller.begin();
    const callbacks = (loud.recorders[0] as FakeRecorder).callbacks!;
    for (let i = 0; i < 25; i++) {
      time += 200;
      callbacks.onLevel!(0.5);
    }
    await loud.controller.finish();
    expect(loud.controller.getSnapshot().result!.session.assessment?.unassessedReason).toBe('recognition_failed');

    const quiet = make();
    await quiet.controller.begin();
    time += 15_000;
    await quiet.controller.finish();
    expect(quiet.controller.getSnapshot().result!.session.assessment?.unassessedReason).toBe('no_speech_detected');
  });

  it('a microphone that disconnects saves what was recorded and says why the reading stopped', async () => {
    const { controller, provider, recorders } = make();
    await controller.begin();
    time += 6_000;
    provider!.say('a', 'pip is a little puppy', true);
    (recorders[0] as FakeRecorder).callbacks!.onError(recordingError('microphone_disconnected'));
    await vi.waitFor(() => expect(controller.getSnapshot().recording.status).toBe('result'));
    const result = controller.getSnapshot().result!;
    expect(result.stoppedBy?.kind).toBe('microphone_disconnected');
    expect(result.session.status).toBe('saved');
    expect(result.session.audio.status).toBe('local');
    expect(result.session.wordResults!.slice(0, 5).every((w) => w.status === 'correct')).toBe(true);
  });

  it('shows no silence hint when the device cannot report input levels', async () => {
    const { controller, provider } = make({ silenceAfterMs: 8_000 });
    await controller.begin();
    time += 30_000;
    provider!.say('a', 'hmm', false); // any update re-evaluates the notice
    expect(controller.getSnapshot().notice).toBeNull();
    await controller.cancel();
  });

  it('ignores callbacks from a previous attempt', async () => {
    const { controller, provider } = make();
    await controller.begin();
    const oldHandlers = provider!.handlers!;
    await controller.cancel();
    await controller.begin();
    oldHandlers.onSegment({ segmentId: 'old', text: 'pip is a little', isFinal: true });
    expect(controller.getSnapshot().alignment?.current).toBeNull();
    await controller.cancel();
  });
});
