import { LANGUAGES, type LanguageCode } from '../text/language';

/**
 * The school project's learning path: English reading for Grades 2–4. Content outside it
 * (Grade 1, 5 or 6 levels, or Filipino) is kept and can still be read, but it is not
 * part of the default path and is labelled as extra practice.
 *
 * Four things are kept apart and never derived from one another:
 *  - a learner's school grade (LearnerProfile.gradeLevel, optional);
 *  - a story's reading level (StoryVersionRecord.gradeLevel: the grade it is written for);
 *  - academic performance (assessments and teacher-published grades);
 *  - rewards (participation and performance badges, never grades).
 */
export const LEARNING_PATH = {
  language: 'en' as LanguageCode,
  grades: [2, 3, 4] as const,
  label: 'Grades 2–4 English',
};

/** Every grade the data model accepts (kept for existing records). */
export const ALL_GRADES = [1, 2, 3, 4, 5, 6] as const;

export function inLearningPath(story: { language: LanguageCode; gradeLevel: number }): boolean {
  return story.language === LEARNING_PATH.language && (LEARNING_PATH.grades as readonly number[]).includes(story.gradeLevel);
}

/** Why a story is outside the learning path, for its label; null when it is inside. */
export function outsidePathReason(story: { language: LanguageCode; gradeLevel: number }): string | null {
  if (inLearningPath(story)) return null;
  if (story.language !== LEARNING_PATH.language) return `${LANGUAGES[story.language].label} story`;
  return `Grade ${story.gradeLevel} level`;
}

/** How a story's reading level is shown (never as the reader's own grade). */
export function readingLevelLabel(gradeLevel: number): string {
  return `Grade ${gradeLevel} reading level`;
}

/** Labels for a learner's (optional) school grade. */
export function schoolGradeOption(grade: number): string {
  return (LEARNING_PATH.grades as readonly number[]).includes(grade) ? `Grade ${grade}` : `Grade ${grade} (outside the Grade 2–4 path)`;
}
