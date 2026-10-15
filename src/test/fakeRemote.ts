import { RemoteError } from '../backend/errors';
import type {
  AccessSummary, AuthCheck, RemoteApi, ServerAward, SessionSubmitPayload, StoryServerState, StoryUpdateFields,
} from '../backend/remoteApi';

/**
 * In-memory server used only by tests. It mirrors the idempotency rules implemented in
 * SQL (op IDs, unique session IDs, unique award keys) so the client's retry logic can
 * be exercised deterministically, including lost acknowledgements.
 */
export class FakeRemote implements RemoteApi {
  auth: 'ok' | 'expired' | 'signed_out' = 'ok';
  userId: string;
  offline = false;
  learnerIds = new Set<string>();
  processedOps = new Map<string, unknown>();
  sessions = new Map<string, SessionSubmitPayload>();
  awards = new Map<string, ServerAward>();
  words = new Map<string, { archivedAt: string | null; savedAt: string; practiceCount: number }>();
  storage = new Map<string, { size: number }>();
  confirmedAudio = new Set<string>();
  stories = new Map<string, StoryServerState>();
  calls: string[] = [];
  /** Apply the next N operations but lose the response (simulates a dropped connection). */
  dropResponses = 0;
  /** Expire the session after this many successful calls. */
  expireAfterCalls: number | null = null;
  failWith: RemoteError | null = null;

  constructor(userId: string) {
    this.userId = userId;
  }

  private gate(name: string) {
    this.calls.push(name);
    if (this.offline) throw new RemoteError('network', 'offline');
    if (this.failWith) {
      const error = this.failWith;
      this.failWith = null;
      throw error;
    }
    if (this.expireAfterCalls !== null) {
      if (this.expireAfterCalls <= 0) this.auth = 'expired';
      this.expireAfterCalls--;
    }
    if (this.auth !== 'ok') throw new RemoteError('auth', 'JWT expired');
  }

  private respond<T>(value: T): T {
    if (this.dropResponses > 0) {
      this.dropResponses--;
      throw new RemoteError('network', 'connection lost after the server applied the change');
    }
    return value;
  }

  private once<T>(opId: string, apply: () => T): T {
    if (this.processedOps.has(opId)) return this.respond(this.processedOps.get(opId) as T);
    const result = apply();
    this.processedOps.set(opId, result);
    return this.respond(result);
  }

  private award(learnerId: string, badge: string, sourceKey: string, sessionId: string | null) {
    const key = `${learnerId}|${badge}|${sourceKey}`;
    if (!this.awards.has(key)) {
      this.awards.set(key, { badge_code: badge, source_key: sourceKey, session_id: sessionId, awarded_at: new Date().toISOString() });
    }
    return this.awards.get(key)!;
  }

  async checkAuth(): Promise<AuthCheck> {
    if (this.offline) throw new RemoteError('network', 'offline');
    if (this.auth === 'ok') return { status: 'ok', userId: this.userId };
    return { status: this.auth };
  }

  async fetchAccess(): Promise<AccessSummary> {
    this.gate('fetchAccess');
    return { userId: this.userId, roles: [], learnerIds: new Set(this.learnerIds), staffClassIds: new Set() };
  }

  async createLearner(opId: string, learner: { id: string }) {
    this.gate('createLearner');
    this.once(opId, () => {
      this.learnerIds.add(learner.id);
      return {};
    });
  }

  async submitSession(opId: string, payload: SessionSubmitPayload) {
    this.gate('submitSession');
    if (!this.learnerIds.has(payload.learner_id)) throw new RemoteError('forbidden', 'not authorized for this learner');
    return this.once(opId, () => {
      if (!this.sessions.has(payload.id)) this.sessions.set(payload.id, payload);
      const awards = [
        this.award(payload.learner_id, 'first_practice', 'once', payload.id),
        this.award(payload.learner_id, 'practice_day', `day:${payload.local_day}`, payload.id),
      ];
      const a = payload.assessment as { status?: string; completion?: string };
      if (payload.mode === 'read_aloud' && a.status === 'assessed' && a.completion === 'complete') {
        awards.push(this.award(payload.learner_id, 'story_finisher', `story:${payload.story_version_id}`, payload.id));
      }
      return { awards, audioStatus: payload.audio_status };
    });
  }

  async uploadAudio(learnerId: string, sessionId: string, blob: Blob) {
    this.gate('uploadAudio');
    const path = `${learnerId}/${sessionId}.webm`;
    if (!this.storage.has(path)) this.storage.set(path, { size: blob.size });
    return this.respond({ path });
  }

  async confirmAudio(opId: string, sessionId: string, path: string) {
    this.gate('confirmAudio');
    if (!this.storage.has(path)) throw new RemoteError('conflict', 'recording not found in storage');
    this.once(opId, () => {
      this.confirmedAudio.add(sessionId);
      return {};
    });
  }

  reviewRequests = new Set<string>();

  async requestReview(opId: string, sessionId: string) {
    this.gate('requestReview');
    if (!this.sessions.has(sessionId)) throw new RemoteError('validation', 'session not found');
    this.once(opId, () => {
      this.reviewRequests.add(sessionId);
      return {};
    });
  }

  async saveWord(opId: string, word: { learnerId: string; normalized: string; savedAt: string }) {
    this.gate('saveWord');
    return this.once(opId, () => {
      const key = `${word.learnerId}|${word.normalized}`;
      const existing = this.words.get(key);
      if (!existing) this.words.set(key, { archivedAt: null, savedAt: word.savedAt, practiceCount: 0 });
      else if (existing.archivedAt && word.savedAt > existing.archivedAt) existing.archivedAt = null;
      return { awards: [] as ServerAward[] };
    });
  }

  async archiveWord(opId: string, word: { learnerId: string; normalized: string; archivedAt: string }) {
    this.gate('archiveWord');
    this.once(opId, () => {
      const existing = this.words.get(`${word.learnerId}|${word.normalized}`);
      if (existing && existing.savedAt <= word.archivedAt) existing.archivedAt = word.archivedAt;
      return {};
    });
  }

  async recordWordPractice(opId: string, word: { learnerId: string; normalized: string }) {
    this.gate('recordWordPractice');
    this.once(opId, () => {
      const existing = this.words.get(`${word.learnerId}|${word.normalized}`);
      if (existing) existing.practiceCount++;
      return {};
    });
  }

  async fetchStory(storyId: string) {
    this.gate('fetchStory');
    return this.stories.get(storyId) ?? null;
  }

  async updateStory(storyId: string, expectedRevision: number, fields: StoryUpdateFields) {
    this.gate('updateStory');
    const story = this.stories.get(storyId);
    if (!story) throw new RemoteError('forbidden', 'cannot edit');
    if (story.revision !== expectedRevision) throw new RemoteError('conflict', 'changed elsewhere', { ...story });
    const updated = { ...story, ...fields, revision: story.revision + 1, updated_at: new Date().toISOString() };
    this.stories.set(storyId, updated);
    return this.respond(updated);
  }
}
