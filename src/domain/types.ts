import type { TranscriptLog } from '../alignment/aligner';
import type { AssessmentSummary, AttemptTiming, EngineInfo, UnassessedReason, WordResult } from '../assessment/scoring';
import type { LanguageCode } from '../text/language';

export type ISODateString = string;

export const AVATARS = [
  { id: 'owl', emoji: '🦉', label: 'Owl' },
  { id: 'turtle', emoji: '🐢', label: 'Turtle' },
  { id: 'butterfly', emoji: '🦋', label: 'Butterfly' },
  { id: 'whale', emoji: '🐳', label: 'Whale' },
  { id: 'carabao', emoji: '🐃', label: 'Carabao' },
  { id: 'frog', emoji: '🐸', label: 'Frog' },
  { id: 'fox', emoji: '🦊', label: 'Fox' },
  { id: 'bird', emoji: '🐦', label: 'Bird' },
  { id: 'fish', emoji: '🐠', label: 'Fish' },
  { id: 'cat', emoji: '🐱', label: 'Cat' },
  { id: 'rocket', emoji: '🚀', label: 'Rocket' },
  { id: 'star', emoji: '🌟', label: 'Star' },
] as const;

export type AvatarId = (typeof AVATARS)[number]['id'];

export function avatarById(id: string) {
  return AVATARS.find((a) => a.id === id) ?? AVATARS[0];
}

export type TextSize = 'md' | 'lg' | 'xl' | '2xl';
export type LineSpacing = 'normal' | 'relaxed' | 'loose';

export interface ReadingPreferences {
  textSize: TextSize;
  lineSpacing: LineSpacing;
}

export const DEFAULT_READING_PREFERENCES: ReadingPreferences = { textSize: 'lg', lineSpacing: 'relaxed' };

export interface LearnerProfile {
  id: string;
  displayName: string;
  avatar: AvatarId;
  gradeLevel: number | null;
  createdAt: ISODateString;
  /**
   * device: created on this device, not linked to any account.
   * account: created by the signed-in guardian/learner account.
   * class_roster: provided by a teacher for a trusted shared classroom device.
   */
  origin: 'device' | 'account' | 'class_roster';
  /** Whether the server knows about this learner. */
  cloud: 'local_only' | 'pending' | 'synced';
  classIds: string[];
  preferences: ReadingPreferences;
  archivedAt: ISODateString | null;
}

export interface NarrationTiming {
  wordIndex: number;
  startMs: number;
  endMs: number;
}

export interface StoryVersionRecord {
  /** story_versions.id — immutable content snapshot. */
  id: string;
  storyId: string;
  versionNumber: number;
  title: string;
  body: string;
  summary: string;
  language: LanguageCode;
  gradeLevel: number;
  topic: string;
  tokenizerVersion: number;
  /** Recorded narration with real word timings, if the story provides it. */
  narration: { audioPath: string; timings: NarrationTiming[] } | null;
  source: 'bundled' | 'downloaded';
  downloadedAt: ISODateString | null;
  sizeBytes: number;
}

export type DownloadKind = 'story' | 'vocabulary' | 'speech_engine' | 'speech_model' | 'narration_audio';
export type DownloadStatus = 'queued' | 'downloading' | 'ready' | 'error';

export interface DownloadRecord {
  id: string;
  kind: DownloadKind;
  label: string;
  status: DownloadStatus;
  progress: number; // 0..1
  bytes: number;
  error: string | null;
  updatedAt: ISODateString;
  /** For stories: the story version this download contains. */
  refId: string | null;
}

export type AudioStatus =
  | 'none' // no audio captured
  | 'recording'
  | 'local' // saved on this device only
  | 'queued' // waiting for upload (sharing was enabled)
  | 'uploaded' // server acknowledged the upload
  | 'failed'
  | 'deleted';

export interface RecognitionInfo {
  plan: 'on_device' | 'cloud' | 'none';
  engine: EngineInfo | null;
  reason: UnassessedReason | null;
}

export interface ReadingSessionRecord {
  id: string;
  learnerId: string;
  storyId: string;
  storyVersionId: string;
  assignmentId: string | null;
  mode: 'read_aloud' | 'listen';
  status: 'in_progress' | 'saved';
  startedAt: ISODateString;
  endedAt: ISODateString | null;
  localDay: string;
  timing: AttemptTiming;
  recognition: RecognitionInfo;
  transcript: TranscriptLog | null;
  assessment: AssessmentSummary | null;
  wordResults: WordResult[] | null;
  audio: {
    status: AudioStatus;
    mimeType: string | null;
    sizeBytes: number | null;
    remotePath: string | null;
    error: string | null;
  };
  /** The learner or guardian asked for teacher review of this attempt. */
  reviewRequested: boolean;
  /** Whether the attempt ended because the app was interrupted and later recovered. */
  recovered: boolean;
  sync: 'local_only' | 'pending' | 'synced' | 'failed';
  updatedAt: ISODateString;
}

export interface AudioChunk {
  sessionId: string;
  seq: number;
  blob: Blob;
  mimeType: string;
}

export interface LocalRecording {
  sessionId: string;
  blob: Blob;
  mimeType: string;
  createdAt: ISODateString;
}

export interface VocabularyEntry {
  id: string;
  language: LanguageCode;
  headword: string;
  normalized: string;
  partOfSpeech: string | null;
  definition: string;
  example: string | null;
  /** Syllable division, shown only when verified by a reviewer. */
  syllables: string | null;
  syllablesVerified: boolean;
  /** draft: written but not yet reviewed by an educator. */
  reviewStatus: 'draft' | 'reviewed';
}

export interface LearnerWord {
  /** `${learnerId}|${language}|${normalized}` */
  id: string;
  learnerId: string;
  language: LanguageCode;
  word: string;
  normalized: string;
  vocabularyEntryId: string | null;
  storyVersionId: string | null;
  savedAt: ISODateString;
  practiceCount: number;
  lastPracticedAt: ISODateString | null;
  /** Tombstone so deletions synchronize instead of being lost. */
  archivedAt: ISODateString | null;
  sync: 'local_only' | 'pending' | 'synced';
}

export interface LocalReward {
  /** `${learnerId}|${badgeCode}|${sourceKey}` */
  id: string;
  learnerId: string;
  badgeCode: string;
  sourceKey: string;
  sessionId: string | null;
  awardedAt: ISODateString;
  /** pending: computed on this device; validated: confirmed by the server. */
  status: 'pending' | 'validated' | 'not_confirmed';
}

export interface LocalAssignment {
  id: string;
  classId: string;
  className: string;
  storyId: string;
  storyVersionId: string;
  title: string;
  dueAt: ISODateString | null;
  revision: number;
  archivedAt: ISODateString | null;
}

export interface StoryDraftRecord {
  storyId: string;
  title: string;
  body: string;
  summary: string;
  language: LanguageCode;
  gradeLevel: number;
  topic: string;
  /** Server revision this draft was based on (optimistic concurrency). */
  baseRevision: number;
  updatedAt: ISODateString;
  pendingOpId: string | null;
}

export type OutboxStatus = 'pending' | 'syncing' | 'synced' | 'conflict' | 'failed';

export type OutboxOpType =
  | 'learner.create'
  | 'session.submit'
  | 'session.review'
  | 'audio.upload'
  | 'word.save'
  | 'word.archive'
  | 'word.practice'
  | 'story.update';

export interface OutboxOp<P = unknown> {
  opId: string;
  type: OutboxOpType;
  entityId: string;
  learnerId: string | null;
  payload: P;
  status: OutboxStatus;
  attempts: number;
  /** Epoch ms when the op may be attempted next. */
  nextAttemptAt: number;
  lastError: string | null;
  /** Ops that must be synced before this one. */
  dependsOn: string[];
  conflict: unknown | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface KeyValue {
  key: string;
  value: unknown;
}
