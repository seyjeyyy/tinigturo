import { classifyError, RemoteError } from './errors';
import { requireSupabase } from './supabaseClient';
import { SupabaseRemote, AUDIO_BUCKET } from './supabaseRemote';
import type { StoryServerState, StoryUpdateFields } from './remoteApi';
import type { FinalWordStatus } from '../alignment/aligner';
import type { LanguageCode } from '../text/language';
import { TOKENIZER_VERSION, tokenizePassage } from '../text/tokenize';

async function unwrap<T>(promise: PromiseLike<{ data: unknown; error: unknown; status?: number }>): Promise<T> {
  try {
    const { data, error, status } = await promise;
    if (error) throw classifyError(error, status);
    return data as T;
  } catch (error) {
    throw classifyError(error);
  }
}

const db = () => requireSupabase();

export interface ClassRow {
  id: string;
  name: string;
  grade_level: number | null;
  audio_upload_enabled: boolean;
  audio_retention_days: number;
  archived_at: string | null;
  class_join_codes: { code: string; enabled: boolean } | null;
}

export async function listClasses(): Promise<ClassRow[]> {
  return unwrap(db().from('classes').select('id, name, grade_level, audio_upload_enabled, audio_retention_days, archived_at, class_join_codes(code, enabled)').order('name'));
}

export async function getClass(classId: string): Promise<ClassRow | null> {
  return unwrap(db().from('classes').select('id, name, grade_level, audio_upload_enabled, audio_retention_days, archived_at, class_join_codes(code, enabled)').eq('id', classId).maybeSingle());
}

export async function createClass(name: string, gradeLevel: number | null) {
  return unwrap<{ class_id: string; join_code: string }>(db().rpc('create_class', { p_name: name, p_grade_level: gradeLevel }));
}

export async function regenerateJoinCode(classId: string) {
  return unwrap<string>(db().rpc('regenerate_join_code', { p_class_id: classId }));
}

export async function setJoinCodeEnabled(classId: string, enabled: boolean) {
  await unwrap(db().rpc('set_join_code_enabled', { p_class_id: classId, p_enabled: enabled }));
}

export async function setRecordingPolicy(classId: string, enabled: boolean, retentionDays: number) {
  await unwrap(db().rpc('set_class_recording_policy', { p_class_id: classId, p_audio_upload_enabled: enabled, p_retention_days: retentionDays }));
}

export interface RosterRow {
  learner_id: string;
  status: 'pending' | 'active' | 'declined' | 'removed';
  created_at: string;
  learners: { display_name: string; avatar: string; grade_level: number | null } | null;
}

export async function listRoster(classId: string): Promise<RosterRow[]> {
  return unwrap(db().from('class_memberships').select('learner_id, status, created_at, learners(display_name, avatar, grade_level)').eq('class_id', classId).in('status', ['pending', 'active']));
}

export async function decideEnrollment(classId: string, learnerId: string, approve: boolean) {
  return unwrap<string>(db().rpc('decide_enrollment', { p_class_id: classId, p_learner_id: learnerId, p_approve: approve }));
}

export async function removeMember(classId: string, learnerId: string) {
  await unwrap(db().rpc('remove_class_member', { p_class_id: classId, p_learner_id: learnerId }));
}

export async function addRosterLearner(classId: string, learner: { id: string; displayName: string; avatar: string; gradeLevel: number | null }) {
  await unwrap(db().rpc('teacher_add_learner', {
    p_class_id: classId, p_learner_id: learner.id, p_display_name: learner.displayName, p_avatar: learner.avatar, p_grade_level: learner.gradeLevel,
  }));
}

export interface ProgressRow {
  learner_id: string;
  display_name: string;
  avatar: string;
  membership_status: string;
  sessions: number;
  assessed_sessions: number;
  last_session_at: string | null;
  latest_cwpm: number | null;
  best_cwpm: number | null;
  latest_coverage: number | null;
  needs_review: number;
}

export async function classProgress(classId: string): Promise<ProgressRow[]> {
  return unwrap(db().rpc('class_progress', { p_class_id: classId }));
}

export interface AttemptRow {
  id: string;
  learner_id: string;
  started_at: string;
  mode: string;
  active_ms: number;
  audio_status: string;
  review_requested: boolean;
  learners: { display_name: string } | null;
  story_versions: { title: string; language: string } | null;
  session_assessments: {
    status: string; completion: string; method: string; total_words: number; evaluated_words: number; correct_words: number;
    uncertain_words: number; substituted_words: number; skipped_words: number; coverage: number; cwpm: number | null;
    assessed_ms: number | null; scoring_version: string; engine_id: string | null; engine_version: string | null;
  } | null;
}

export async function classAttempts(learnerIds: string[]): Promise<AttemptRow[]> {
  if (!learnerIds.length) return [];
  return unwrap(
    db().from('reading_sessions')
      .select('id, learner_id, started_at, mode, active_ms, audio_status, review_requested, learners(display_name), story_versions(title, language), session_assessments(status, completion, method, total_words, evaluated_words, correct_words, uncertain_words, substituted_words, skipped_words, coverage, cwpm, assessed_ms, scoring_version, engine_id, engine_version)')
      .in('learner_id', learnerIds)
      .order('started_at', { ascending: false })
      .limit(2000),
  );
}

export interface AssignmentRow {
  id: string;
  class_id: string;
  story_id: string;
  story_version_id: string;
  instructions: string;
  due_at: string | null;
  revision: number;
  archived_at: string | null;
  story_versions: { title: string; version_number: number } | null;
}

export async function listAssignments(classId: string): Promise<AssignmentRow[]> {
  return unwrap(db().from('assignments').select('id, class_id, story_id, story_version_id, instructions, due_at, revision, archived_at, story_versions(title, version_number)').eq('class_id', classId).order('created_at', { ascending: false }));
}

export async function createAssignment(input: { classId: string; storyId: string; storyVersionId: string; dueAt: string | null; instructions: string; userId: string }) {
  await unwrap(db().from('assignments').insert({
    class_id: input.classId, story_id: input.storyId, story_version_id: input.storyVersionId,
    due_at: input.dueAt, instructions: input.instructions, created_by: input.userId,
  }));
}

/** Archives with a version check; a stale revision is reported as a conflict. */
export async function archiveAssignment(assignment: Pick<AssignmentRow, 'id' | 'revision'>) {
  const rows = await unwrap<unknown[]>(db().from('assignments').update({ archived_at: new Date().toISOString(), revision: assignment.revision + 1 }).eq('id', assignment.id).eq('revision', assignment.revision).select('id'));
  if (!rows.length) throw new RemoteError('conflict', 'This assignment was changed by someone else. Reload and try again.');
}

export interface TeacherStoryRow {
  id: string;
  owner_id: string | null;
  visibility: 'library' | 'class';
  status: 'draft' | 'published' | 'archived';
  draft_title: string;
  draft_body: string;
  draft_summary: string;
  language: LanguageCode;
  grade_level: number;
  topic: string;
  revision: number;
  published_version_id: string | null;
  updated_at: string;
  archived_at: string | null;
}

const STORY_SELECT = 'id, owner_id, visibility, status, draft_title, draft_body, draft_summary, language, grade_level, topic, revision, published_version_id, updated_at, archived_at';

export async function listMyStories(userId: string): Promise<TeacherStoryRow[]> {
  return unwrap(db().from('stories').select(STORY_SELECT).eq('owner_id', userId).order('updated_at', { ascending: false }));
}

export async function listAssignableStories(): Promise<TeacherStoryRow[]> {
  return unwrap(db().from('stories').select(STORY_SELECT).eq('status', 'published').order('draft_title'));
}

export async function getStory(storyId: string): Promise<TeacherStoryRow | null> {
  return unwrap(db().from('stories').select(STORY_SELECT).eq('id', storyId).maybeSingle());
}

export async function createStory(userId: string, fields: StoryUpdateFields): Promise<TeacherStoryRow> {
  return unwrap(db().from('stories').insert({ owner_id: userId, ...fields }).select(STORY_SELECT).single());
}

/** Saves a draft with optimistic concurrency; throws RemoteError('conflict', ..., serverState). */
export async function saveStoryDraft(storyId: string, expectedRevision: number, fields: StoryUpdateFields): Promise<StoryServerState> {
  return new SupabaseRemote(db()).updateStory(storyId, expectedRevision, fields);
}

export async function publishStory(story: Pick<TeacherStoryRow, 'id' | 'revision' | 'draft_body' | 'language'>) {
  const wordCount = tokenizePassage(story.draft_body, story.language).words.length;
  return unwrap<{ version_id: string; version_number: number }>(db().rpc('publish_story', {
    p_story_id: story.id, p_expected_revision: story.revision, p_tokenizer_version: TOKENIZER_VERSION, p_word_count: wordCount,
  }));
}

export async function archiveStory(storyId: string) {
  await unwrap(db().rpc('archive_story', { p_story_id: storyId }));
}

export async function restoreStory(storyId: string) {
  await unwrap(db().rpc('restore_story', { p_story_id: storyId }));
}

export interface ReviewQueueRow {
  session_id: string;
  learner_id: string;
  learner_name: string;
  story_title: string;
  started_at: string;
  status: string;
  completion: string;
  review_requested: boolean;
  review_reasons: string[];
  audio_status: string;
  class_id: string;
  class_name: string;
}

export async function reviewQueue(): Promise<ReviewQueueRow[]> {
  return unwrap(db().rpc('review_queue'));
}

export interface SessionDetail {
  id: string;
  learner_id: string;
  started_at: string;
  ended_at: string;
  mode: string;
  active_ms: number;
  paused_ms: number;
  assessed_ms: number;
  recognition_plan: string;
  audio_status: string;
  audio_path: string | null;
  audio_expires_at: string | null;
  review_requested: boolean;
  learners: { display_name: string } | null;
  story_versions: { title: string; body: string; language: LanguageCode } | null;
  session_assessments: AttemptRow['session_assessments'] & { review_reasons: string[]; aligner_version: string | null; normalizer_version: number | null; insertions: number; repetitions: number };
  word_results: { word_index: number; status: FinalWordStatus; heard: string | null }[];
  assessment_corrections: { id: string; word_index: number | null; previous_status: string | null; corrected_status: FinalWordStatus; reason: string; created_at: string; corrected_by: string }[];
  teacher_feedback: { id: string; body: string; created_at: string; author_id: string }[];
  session_reviews: { id: string; note: string; created_at: string }[];
}

export async function getSessionDetail(sessionId: string): Promise<SessionDetail | null> {
  return unwrap(
    db().from('reading_sessions')
      .select('id, learner_id, started_at, ended_at, mode, active_ms, paused_ms, assessed_ms, recognition_plan, audio_status, audio_path, audio_expires_at, review_requested, learners(display_name), story_versions(title, body, language), session_assessments(*), word_results(word_index, status, heard), assessment_corrections(id, word_index, previous_status, corrected_status, reason, created_at, corrected_by), teacher_feedback(id, body, created_at, author_id), session_reviews(id, note, created_at)')
      .eq('id', sessionId)
      .maybeSingle(),
  );
}

/** A short-lived signed URL; only issued when Storage policies allow this user to read it. */
export async function signedAudioUrl(path: string): Promise<string> {
  const { data, error } = await db().storage.from(AUDIO_BUCKET).createSignedUrl(path, 120);
  if (error || !data) throw classifyError(error ?? new Error('No URL'));
  return data.signedUrl;
}

export async function addCorrection(sessionId: string, wordIndex: number, status: FinalWordStatus, reason: string) {
  return unwrap<string>(db().rpc('add_assessment_correction', { p_session_id: sessionId, p_word_index: wordIndex, p_corrected_status: status, p_reason: reason }));
}

export async function markReviewed(sessionId: string, note: string) {
  return unwrap<string>(db().rpc('mark_session_reviewed', { p_session_id: sessionId, p_note: note }));
}

export async function addFeedback(input: { sessionId: string | null; learnerId: string; authorId: string; body: string }) {
  await unwrap(db().from('teacher_feedback').insert({ session_id: input.sessionId, learner_id: input.learnerId, author_id: input.authorId, body: input.body }));
}

export async function fetchRosterForDevice(classId: string) {
  return unwrap<{ learner_id: string; learners: { display_name: string; avatar: string; grade_level: number | null } | null }[]>(
    db().from('class_memberships').select('learner_id, learners(display_name, avatar, grade_level)').eq('class_id', classId).eq('status', 'active'),
  );
}
