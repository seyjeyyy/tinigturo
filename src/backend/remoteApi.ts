import type { LanguageCode } from '../text/language';

/**
 * The server operations the sync engine needs. The production implementation talks
 * to Supabase (supabaseRemote.ts). Tests provide an in-memory implementation that
 * enforces the same idempotency rules; the app itself never substitutes a fake.
 */
export interface ServerAward {
  badge_code: string;
  source_key: string;
  session_id: string | null;
  awarded_at: string;
}

export interface AccessSummary {
  userId: string;
  roles: string[];
  learnerIds: Set<string>;
  staffClassIds: Set<string>;
}

export type AuthCheck =
  | { status: 'ok'; userId: string }
  | { status: 'expired' }
  | { status: 'signed_out' };

export interface SessionSubmitPayload {
  id: string;
  learner_id: string;
  story_version_id: string;
  assignment_id: string | null;
  mode: 'read_aloud' | 'listen';
  started_at: string;
  ended_at: string;
  local_day: string;
  active_ms: number;
  paused_ms: number;
  interrupted_ms: number;
  assessed_ms: number;
  recognition_plan: 'on_device' | 'cloud' | 'none';
  transcript: unknown;
  review_requested: boolean;
  recovered: boolean;
  audio_status: 'none' | 'local_only' | 'pending';
  assessment: Record<string, unknown>;
  word_results: { i: number; s: string; h: string | null }[];
}

export interface StoryUpdateFields {
  draft_title: string;
  draft_body: string;
  draft_summary: string;
  language: LanguageCode;
  grade_level: number;
  topic: string;
}

export interface StoryServerState extends StoryUpdateFields {
  id: string;
  revision: number;
  updated_at: string;
}

export interface RemoteApi {
  checkAuth(): Promise<AuthCheck>;
  fetchAccess(): Promise<AccessSummary>;
  createLearner(opId: string, learner: { id: string; displayName: string; avatar: string; gradeLevel: number | null }): Promise<void>;
  submitSession(opId: string, payload: SessionSubmitPayload): Promise<{ awards: ServerAward[]; audioStatus: string | null }>;
  uploadAudio(learnerId: string, sessionId: string, blob: Blob, mimeType: string): Promise<{ path: string }>;
  confirmAudio(opId: string, sessionId: string, path: string): Promise<void>;
  requestReview(opId: string, sessionId: string): Promise<void>;
  saveWord(opId: string, word: {
    learnerId: string; language: LanguageCode; word: string; normalized: string;
    vocabularyEntryId: string | null; storyVersionId: string | null; savedAt: string;
  }): Promise<{ awards: ServerAward[] }>;
  archiveWord(opId: string, word: { learnerId: string; language: LanguageCode; normalized: string; archivedAt: string }): Promise<void>;
  recordWordPractice(opId: string, word: { learnerId: string; language: LanguageCode; normalized: string; practicedAt: string }): Promise<void>;
  /** Throws RemoteError('conflict', ..., serverState) when the revision moved on. */
  updateStory(storyId: string, expectedRevision: number, fields: StoryUpdateFields): Promise<StoryServerState>;
  fetchStory(storyId: string): Promise<StoryServerState | null>;
}
