import type { SupabaseClient } from '@supabase/supabase-js';
import { classifyError, RemoteError } from './errors';
import type { AccessSummary, AuthCheck, RemoteApi, ServerAward, StoryServerState, StoryUpdateFields } from './remoteApi';

export const AUDIO_BUCKET = 'reading-audio';

function extensionFor(mimeType: string): string {
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mp4') || mimeType.includes('aac')) return 'mp4';
  if (mimeType.includes('mpeg')) return 'mp3';
  if (mimeType.includes('wav')) return 'wav';
  return 'bin';
}

export function audioPathFor(learnerId: string, sessionId: string, mimeType: string): string {
  return `${learnerId}/${sessionId}.${extensionFor(mimeType)}`;
}

async function call<T>(promise: PromiseLike<{ data: unknown; error: unknown; status?: number }>): Promise<T> {
  let response: { data: unknown; error: unknown; status?: number };
  try {
    response = await promise;
  } catch (error) {
    throw classifyError(error);
  }
  if (response.error) throw classifyError(response.error, response.status);
  return response.data as T;
}

const STORY_COLUMNS = 'id, draft_title, draft_body, draft_summary, language, grade_level, topic, revision, updated_at';

export class SupabaseRemote implements RemoteApi {
  constructor(private readonly supabase: SupabaseClient) {}

  async checkAuth(): Promise<AuthCheck> {
    try {
      const { data, error } = await this.supabase.auth.getSession();
      if (error) throw error;
      if (!data.session) return { status: 'signed_out' };
      const expiresAtMs = (data.session.expires_at ?? 0) * 1000;
      if (expiresAtMs && expiresAtMs < Date.now() + 30_000) {
        const refreshed = await this.supabase.auth.refreshSession();
        if (refreshed.error || !refreshed.data.session) {
          const classified = classifyError(refreshed.error ?? new Error('refresh failed'));
          if (classified.kind === 'network') throw classified;
          return { status: 'expired' };
        }
        return { status: 'ok', userId: refreshed.data.session.user.id };
      }
      return { status: 'ok', userId: data.session.user.id };
    } catch (error) {
      const classified = classifyError(error);
      if (classified.kind === 'auth') return { status: 'expired' };
      throw classified;
    }
  }

  async fetchAccess(): Promise<AccessSummary> {
    const data = await call<{
      user_id: string; roles: string[]; guardian_learner_ids: string[]; taught_learner_ids: string[]; staff_class_ids: string[];
    }>(this.supabase.rpc('my_access'));
    return {
      userId: data.user_id,
      roles: data.roles ?? [],
      learnerIds: new Set([...(data.guardian_learner_ids ?? []), ...(data.taught_learner_ids ?? [])]),
      staffClassIds: new Set(data.staff_class_ids ?? []),
    };
  }

  async createLearner(opId: string, learner: { id: string; displayName: string; avatar: string; gradeLevel: number | null }) {
    await call(this.supabase.rpc('create_learner', {
      p_op_id: opId, p_learner_id: learner.id, p_display_name: learner.displayName,
      p_avatar: learner.avatar, p_grade_level: learner.gradeLevel,
    }));
  }

  async submitSession(opId: string, payload: Parameters<RemoteApi['submitSession']>[1]) {
    const data = await call<{ awards: ServerAward[]; audio_status?: string }>(
      this.supabase.rpc('submit_reading_session', { p_op_id: opId, p_session: payload }),
    );
    return { awards: data.awards ?? [], audioStatus: data.audio_status ?? null };
  }

  async uploadAudio(learnerId: string, sessionId: string, blob: Blob, mimeType: string) {
    const path = audioPathFor(learnerId, sessionId, mimeType);
    const { error } = await this.supabase.storage.from(AUDIO_BUCKET).upload(path, blob, {
      contentType: mimeType.split(';')[0],
      upsert: false,
      cacheControl: 'private, max-age=0',
    });
    if (error) {
      const status = (error as { statusCode?: string }).statusCode;
      // A retry after a lost response finds the object already there: confirm instead.
      if (status === '409' || /already exists|Duplicate/i.test(error.message)) return { path };
      throw classifyError(error, status ? Number(status) : undefined);
    }
    return { path };
  }

  async confirmAudio(opId: string, sessionId: string, path: string) {
    await call(this.supabase.rpc('confirm_audio_upload', { p_op_id: opId, p_session_id: sessionId, p_path: path }));
  }

  async requestReview(opId: string, sessionId: string) {
    await call(this.supabase.rpc('request_session_review', { p_op_id: opId, p_session_id: sessionId }));
  }

  async saveWord(opId: string, word: Parameters<RemoteApi['saveWord']>[1]) {
    const data = await call<{ awards: ServerAward[] }>(this.supabase.rpc('save_learner_word', {
      p_op_id: opId, p_learner_id: word.learnerId, p_language: word.language, p_word: word.word,
      p_normalized: word.normalized, p_vocabulary_entry_id: word.vocabularyEntryId,
      p_story_version_id: word.storyVersionId, p_saved_at: word.savedAt,
    }));
    return { awards: data.awards ?? [] };
  }

  async archiveWord(opId: string, word: Parameters<RemoteApi['archiveWord']>[1]) {
    await call(this.supabase.rpc('archive_learner_word', {
      p_op_id: opId, p_learner_id: word.learnerId, p_language: word.language,
      p_normalized: word.normalized, p_archived_at: word.archivedAt,
    }));
  }

  async recordWordPractice(opId: string, word: Parameters<RemoteApi['recordWordPractice']>[1]) {
    await call(this.supabase.rpc('record_word_practice', {
      p_op_id: opId, p_learner_id: word.learnerId, p_language: word.language,
      p_normalized: word.normalized, p_practiced_at: word.practicedAt,
    }));
  }

  async fetchStory(storyId: string): Promise<StoryServerState | null> {
    return call<StoryServerState | null>(this.supabase.from('stories').select(STORY_COLUMNS).eq('id', storyId).maybeSingle());
  }

  async updateStory(storyId: string, expectedRevision: number, fields: StoryUpdateFields): Promise<StoryServerState> {
    const rows = await call<StoryServerState[]>(
      this.supabase
        .from('stories')
        .update({ ...fields, revision: expectedRevision + 1 })
        .eq('id', storyId)
        .eq('revision', expectedRevision)
        .select(STORY_COLUMNS),
    );
    if (rows.length === 1) return rows[0];
    // Zero rows: either the revision moved on (conflict) or we may not edit it.
    const server = await this.fetchStory(storyId);
    if (!server) throw new RemoteError('forbidden', 'You can no longer edit this story.');
    throw new RemoteError('conflict', 'This story was changed somewhere else.', server);
  }
}
