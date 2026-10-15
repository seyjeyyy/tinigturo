import { classifyError } from './errors';
import { requireSupabase } from './supabaseClient';
import { STARTER_STORIES } from '../content/starterStories';
import type { LanguageCode } from '../text/language';
import type { LocalAssignment, StoryVersionRecord } from '../domain/types';

async function unwrap<T>(promise: PromiseLike<{ data: unknown; error: unknown; status?: number }>): Promise<T> {
  try {
    const { data, error, status } = await promise;
    if (error) throw classifyError(error, status);
    return data as T;
  } catch (error) {
    throw classifyError(error);
  }
}

export type AccountType = 'guardian' | 'teacher';

export async function signUp(input: { email: string; password: string; displayName: string; accountType: AccountType }) {
  const supabase = requireSupabase();
  const { data, error } = await supabase.auth.signUp({
    email: input.email,
    password: input.password,
    options: {
      data: { display_name: input.displayName, account_type: input.accountType },
      emailRedirectTo: `${window.location.origin}/account`,
    },
  });
  if (error) throw error;
  return { needsConfirmation: !data.session };
}

export async function signIn(email: string, password: string) {
  const { error } = await requireSupabase().auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function signOut() {
  // Local sign-out also works offline; it clears this browser's session.
  await requireSupabase().auth.signOut({ scope: 'local' });
}

export async function requestPasswordReset(email: string) {
  const { error } = await requireSupabase().auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/account/update-password`,
  });
  if (error) throw error;
}

export async function updatePassword(password: string) {
  const { error } = await requireSupabase().auth.updateUser({ password });
  if (error) throw error;
}

export async function fetchMyRoles(): Promise<string[]> {
  const rows = await unwrap<{ role: string }[]>(requireSupabase().from('user_roles').select('role'));
  return rows.map((r) => r.role);
}

export async function requestEnrollment(joinCode: string, learnerId: string) {
  return unwrap<{ status: 'pending' | 'active' | 'not_found' | 'declined' | 'removed'; class_name?: string; class_id?: string }>(
    requireSupabase().rpc('request_class_enrollment', { p_join_code: joinCode, p_learner_id: learnerId }),
  );
}

export async function setAudioConsent(learnerId: string, consent: boolean) {
  await unwrap(requireSupabase().rpc('set_learner_audio_consent', { p_learner_id: learnerId, p_consent: consent }));
}

export interface ServerLearner {
  id: string;
  display_name: string;
  avatar: string;
  grade_level: number | null;
  audio_sharing_consent: boolean;
  archived_at: string | null;
}

export async function fetchAccessibleLearners(): Promise<ServerLearner[]> {
  return unwrap(requireSupabase().from('learners').select('id, display_name, avatar, grade_level, audio_sharing_consent, archived_at'));
}

export interface MembershipRow {
  class_id: string;
  learner_id: string;
  status: string;
  classes: { name: string; audio_upload_enabled: boolean } | null;
}

export async function fetchMemberships(): Promise<MembershipRow[]> {
  return unwrap(requireSupabase().from('class_memberships').select('class_id, learner_id, status, classes(name, audio_upload_enabled)'));
}

interface VersionRow {
  id: string;
  story_id: string;
  version_number: number;
  title: string;
  body: string;
  summary: string;
  language: LanguageCode;
  grade_level: number;
  topic: string;
  tokenizer_version: number;
  word_count: number;
}

export interface RemoteStorySummary {
  versionId: string;
  storyId: string;
  title: string;
  summary: string;
  language: LanguageCode;
  gradeLevel: number;
  topic: string;
  wordCount: number;
  versionNumber: number;
}

const BUNDLED_IDS = new Set(STARTER_STORIES.map((s) => s.id));

/** Published stories this account may read (library stories and assigned stories). */
export async function fetchRemoteLibrary(): Promise<RemoteStorySummary[]> {
  const rows = await unwrap<{ published_version_id: string | null; story_versions: VersionRow | null }[]>(
    requireSupabase()
      .from('stories')
      .select('published_version_id, story_versions!stories_published_version_fk(id, story_id, version_number, title, summary, language, grade_level, topic, word_count)')
      .eq('status', 'published'),
  );
  return rows
    .map((r) => r.story_versions)
    .filter((v): v is VersionRow => Boolean(v) && !BUNDLED_IDS.has(v!.id))
    .map((v) => ({
      versionId: v.id, storyId: v.story_id, title: v.title, summary: v.summary, language: v.language,
      gradeLevel: v.grade_level, topic: v.topic, wordCount: v.word_count, versionNumber: v.version_number,
    }));
}

export async function fetchStoryVersion(versionId: string): Promise<Omit<StoryVersionRecord, 'source' | 'downloadedAt' | 'sizeBytes'>> {
  const v = await unwrap<VersionRow & { narration_audio_path: string | null; narration_timings: unknown }>(
    requireSupabase().from('story_versions').select('*').eq('id', versionId).single(),
  );
  return {
    id: v.id, storyId: v.story_id, versionNumber: v.version_number, title: v.title, body: v.body, summary: v.summary,
    language: v.language, gradeLevel: v.grade_level, topic: v.topic, tokenizerVersion: v.tokenizer_version, narration: null,
  };
}

export async function fetchAssignments(): Promise<LocalAssignment[]> {
  const rows = await unwrap<{
    id: string; class_id: string; story_id: string; story_version_id: string; due_at: string | null; revision: number; archived_at: string | null;
    classes: { name: string } | null; story_versions: { title: string } | null;
  }[]>(
    requireSupabase().from('assignments').select('id, class_id, story_id, story_version_id, due_at, revision, archived_at, classes(name), story_versions(title)'),
  );
  return rows.map((r) => ({
    id: r.id, classId: r.class_id, className: r.classes?.name ?? 'Class', storyId: r.story_id, storyVersionId: r.story_version_id,
    title: r.story_versions?.title ?? 'Story', dueAt: r.due_at, revision: r.revision, archivedAt: r.archived_at,
  }));
}

export interface TeacherFeedbackRow {
  id: string;
  session_id: string | null;
  learner_id: string;
  body: string;
  created_at: string;
}

export async function fetchFeedback(learnerId: string): Promise<TeacherFeedbackRow[]> {
  return unwrap(
    requireSupabase().from('teacher_feedback').select('id, session_id, learner_id, body, created_at')
      .eq('learner_id', learnerId).is('archived_at', null).order('created_at', { ascending: false }),
  );
}
