import { classifyError } from './errors';
import { requireSupabase } from './supabaseClient';
import type { LanguageCode } from '../text/language';
import type { NarrationTimingInput } from '../narration/narrationFiles';

/** Server calls for rubrics and grades, vocabulary review, and narration recordings. */

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
export const STORY_ASSETS_BUCKET = 'story-assets';

// ---- rubrics and grades ------------------------------------------------------

export interface RubricLevel { value: number; label: string }
export interface RubricCriterion { key: string; label: string; levels: RubricLevel[] }

export interface RubricRow {
  id: string;
  class_id: string;
  family_id: string;
  version: number;
  name: string;
  description: string;
  criteria: RubricCriterion[];
  final_levels: string[];
  created_at: string;
  retired_at: string | null;
}

const RUBRIC_SELECT = 'id, class_id, family_id, version, name, description, criteria, final_levels, created_at, retired_at';

export async function listRubrics(classId: string): Promise<RubricRow[]> {
  return unwrap(db().from('grading_rubrics').select(RUBRIC_SELECT).eq('class_id', classId).order('created_at', { ascending: false }));
}

export async function getRubric(id: string): Promise<RubricRow | null> {
  return unwrap(db().from('grading_rubrics').select(RUBRIC_SELECT).eq('id', id).maybeSingle());
}

export async function createRubric(input: {
  classId: string; name: string; description: string; criteria: RubricCriterion[]; finalLevels: string[]; familyId?: string | null;
}) {
  return unwrap<{ id: string; family_id: string; version: number }>(db().rpc('create_grading_rubric', {
    p_class_id: input.classId, p_name: input.name, p_criteria: input.criteria, p_final_levels: input.finalLevels,
    p_description: input.description, p_family_id: input.familyId ?? null,
  }));
}

export interface GradeRow {
  id: string;
  session_id: string;
  learner_id: string;
  class_id: string;
  rubric_id: string;
  status: 'draft' | 'published';
  criterion_levels: Record<string, number>;
  final_level: string | null;
  feedback: string;
  revision: number;
  graded_by: string;
  graded_at: string;
  published_by: string | null;
  published_at: string | null;
}

const GRADE_SELECT = 'id, session_id, learner_id, class_id, rubric_id, status, criterion_levels, final_level, feedback, revision, graded_by, graded_at, published_by, published_at';

/** Grades this user may see for an attempt (staff of the grading class, or published ones for a guardian). */
export async function getSessionGrades(sessionId: string): Promise<GradeRow[]> {
  return unwrap(db().from('session_grades').select(GRADE_SELECT).eq('session_id', sessionId));
}

export interface GradeRevisionRow {
  revision: number;
  status: string;
  final_level: string | null;
  criterion_levels: Record<string, number>;
  feedback: string;
  reason: string;
  changed_by: string;
  changed_at: string;
}

export async function gradeRevisions(gradeId: string): Promise<GradeRevisionRow[]> {
  return unwrap(db().from('session_grade_revisions')
    .select('revision, status, final_level, criterion_levels, feedback, reason, changed_by, changed_at')
    .eq('grade_id', gradeId).order('revision', { ascending: false }));
}

export async function saveGrade(input: {
  sessionId: string; rubricId: string; levels: Record<string, number>; finalLevel: string | null; feedback: string;
  publish: boolean; reason: string; expectedRevision: number;
}) {
  return unwrap<{ id: string; revision: number; status: 'draft' | 'published' }>(db().rpc('save_session_grade', {
    p_session_id: input.sessionId, p_rubric_id: input.rubricId, p_criterion_levels: input.levels, p_final_level: input.finalLevel,
    p_feedback: input.feedback, p_publish: input.publish, p_reason: input.reason, p_expected_revision: input.expectedRevision,
  }));
}

export interface GradebookRow {
  session_id: string;
  learner_id: string;
  learner_name: string;
  story_title: string;
  started_at: string;
  assessment_status: string | null;
  completion: string | null;
  coverage: number | null;
  cwpm: number | null;
  grade_id: string | null;
  grade_status: 'draft' | 'published' | null;
  final_level: string | null;
  criterion_levels: Record<string, number> | null;
  feedback: string | null;
  rubric_id: string | null;
  rubric_name: string | null;
  rubric_version: number | null;
  graded_at: string | null;
  published_at: string | null;
  revision: number | null;
}

export async function classGradebook(classId: string): Promise<GradebookRow[]> {
  return unwrap(db().rpc('class_gradebook', { p_class_id: classId }));
}

// ---- vocabulary -------------------------------------------------------------

export type VocabularyStatus = 'draft' | 'reviewed' | 'published';

export interface VocabularyRow {
  id: string;
  language: LanguageCode;
  headword: string;
  normalized: string;
  part_of_speech: string | null;
  definition: string;
  example: string | null;
  syllables: string | null;
  syllables_verified: boolean;
  review_status: VocabularyStatus;
  version: number;
  reviewed_at: string | null;
  published_at: string | null;
  updated_at: string;
}

const VOCAB_SELECT = 'id, language, headword, normalized, part_of_speech, definition, example, syllables, syllables_verified, review_status, version, reviewed_at, published_at, updated_at';

export async function listVocabulary(filter: { status: VocabularyStatus | 'all'; search: string; language: LanguageCode | 'all' }): Promise<VocabularyRow[]> {
  let query = db().from('vocabulary_entries').select(VOCAB_SELECT).order('headword').limit(300);
  if (filter.status !== 'all') query = query.eq('review_status', filter.status);
  if (filter.language !== 'all') query = query.eq('language', filter.language);
  const search = filter.search.trim().replace(/[%_,()]/g, '');
  if (search) query = query.ilike('headword', `%${search}%`);
  return unwrap(query);
}

/** Entries a reviewer has published: what devices download for offline use. */
export async function fetchPublishedVocabulary(): Promise<VocabularyRow[]> {
  return unwrap(db().from('vocabulary_entries').select(VOCAB_SELECT).eq('review_status', 'published').limit(5000));
}

export async function saveVocabularyEntry(input: {
  id: string | null; language: LanguageCode; headword: string; normalized: string; partOfSpeech: string; definition: string;
  example: string; syllables: string; syllablesVerified: boolean; expectedVersion: number;
}) {
  return unwrap<{ id: string; version: number; review_status: VocabularyStatus }>(db().rpc('save_vocabulary_entry', {
    p_id: input.id, p_language: input.language, p_headword: input.headword, p_normalized: input.normalized,
    p_part_of_speech: input.partOfSpeech, p_definition: input.definition, p_example: input.example,
    p_syllables: input.syllables, p_syllables_verified: input.syllablesVerified, p_expected_version: input.expectedVersion,
  }));
}

export async function setVocabularyStatus(id: string, status: VocabularyStatus, expectedVersion: number) {
  return unwrap<{ id: string; version: number; review_status: VocabularyStatus }>(db().rpc('set_vocabulary_status', {
    p_id: id, p_status: status, p_expected_version: expectedVersion,
  }));
}

// ---- narration ---------------------------------------------------------------

export interface NarrationRow {
  id: string;
  story_version_id: string;
  story_id: string;
  audio_path: string;
  mime_type: string;
  size_bytes: number;
  duration_ms: number | null;
  timings: NarrationTimingInput[] | null;
  note: string;
  status: 'active' | 'retired';
  created_at: string;
}

const NARRATION_SELECT = 'id, story_version_id, story_id, audio_path, mime_type, size_bytes, duration_ms, timings, note, status, created_at';

export async function listNarrations(versionId: string): Promise<NarrationRow[]> {
  return unwrap(db().from('story_narrations').select(NARRATION_SELECT).eq('story_version_id', versionId).order('created_at', { ascending: false }));
}

export async function activeNarration(versionId: string): Promise<NarrationRow | null> {
  return unwrap(db().from('story_narrations').select(NARRATION_SELECT).eq('story_version_id', versionId).eq('status', 'active').maybeSingle());
}

/** Uploads the audio first, then registers it; the server checks the file exists. */
export async function uploadNarration(input: {
  storyId: string; versionId: string; file: Blob; mimeType: string; extension: string; durationMs: number | null;
  timings: NarrationTimingInput[] | null; note: string;
}): Promise<string> {
  const path = `${input.storyId}/narration/${input.versionId}/${crypto.randomUUID()}.${input.extension}`;
  const { error } = await db().storage.from(STORY_ASSETS_BUCKET).upload(path, input.file, { contentType: input.mimeType, upsert: false });
  if (error) throw classifyError(error);
  return unwrap<string>(db().rpc('register_story_narration', {
    p_story_version_id: input.versionId, p_path: path, p_mime_type: input.mimeType, p_size_bytes: input.file.size,
    p_duration_ms: input.durationMs, p_timings: input.timings, p_note: input.note,
  }));
}

export async function retireNarration(id: string) {
  await unwrap(db().rpc('retire_story_narration', { p_id: id }));
}

/** A short-lived link to play or download a narration the user may read. */
export async function narrationUrl(path: string): Promise<string> {
  const { data, error } = await db().storage.from(STORY_ASSETS_BUCKET).createSignedUrl(path, 300);
  if (error || !data) throw classifyError(error ?? new Error('No URL'));
  return data.signedUrl;
}
