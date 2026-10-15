import type { AssessmentStatus, Completion } from '../assessment/scoring';

/**
 * Reward rules. Mirrored server-side in supabase/migrations/*_functions.sql
 * (private.evaluate_session_awards). Each award is unique per
 * (learner, badge, source key) so retries and replays can never award twice.
 *
 * Participation rewards recognize regular practice. Performance rewards require an
 * assessed, complete attempt; unassessed recordings never earn them.
 */
export const REWARDS_VERSION = 'rewards-1.0.0';
export const PERSONAL_BEST_MIN_GAIN = 3;

export type BadgeKind = 'participation' | 'performance';

export interface BadgeDefinition {
  code: string;
  kind: BadgeKind;
  title: string;
  description: string;
  icon: string;
}

export const BADGES: readonly BadgeDefinition[] = [
  { code: 'first_practice', kind: 'participation', title: 'First Steps', description: 'Finished your first reading practice.', icon: '🌱' },
  { code: 'practice_day', kind: 'participation', title: 'Reading Day', description: 'Practiced reading on this day.', icon: '⭐' },
  { code: 'three_days', kind: 'participation', title: 'Three Reading Days', description: 'Practiced reading on 3 different days.', icon: '📅' },
  { code: 'seven_days', kind: 'participation', title: 'Seven Reading Days', description: 'Practiced reading on 7 different days.', icon: '🏕️' },
  { code: 'word_collector', kind: 'participation', title: 'Word Collector', description: 'Saved 5 words to My Words.', icon: '📒' },
  { code: 'story_finisher', kind: 'performance', title: 'Story Finisher', description: 'Read a whole story aloud with word checking turned on.', icon: '📖' },
  { code: 'personal_best', kind: 'performance', title: 'Personal Best', description: `Read at least ${PERSONAL_BEST_MIN_GAIN} more correct words per minute than your best on this story.`, icon: '🚀' },
];

export function badgeByCode(code: string): BadgeDefinition | undefined {
  return BADGES.find((b) => b.code === code);
}

export interface SessionForRewards {
  id: string;
  storyId: string;
  storyVersionId: string;
  localDay: string; // YYYY-MM-DD in the learner's time zone
  mode: 'read_aloud' | 'listen';
  assessmentStatus: AssessmentStatus | null;
  completion: Completion | null;
  cwpm: number | null;
}

export interface AwardCandidate {
  badgeCode: string;
  sourceKey: string;
  sessionId: string | null;
}

function isAssessedComplete(s: SessionForRewards): boolean {
  return s.mode === 'read_aloud' && s.assessmentStatus === 'assessed' && s.completion === 'complete' && s.cwpm !== null;
}

/** Awards earned by `session`, given the learner's earlier saved sessions. */
export function evaluateSessionAwards(previous: readonly SessionForRewards[], session: SessionForRewards): AwardCandidate[] {
  const awards: AwardCandidate[] = [];
  const others = previous.filter((s) => s.id !== session.id);
  awards.push({ badgeCode: 'first_practice', sourceKey: 'once', sessionId: session.id });
  awards.push({ badgeCode: 'practice_day', sourceKey: `day:${session.localDay}`, sessionId: session.id });

  const days = new Set([...others.map((s) => s.localDay), session.localDay]);
  if (days.size >= 3) awards.push({ badgeCode: 'three_days', sourceKey: 'once', sessionId: session.id });
  if (days.size >= 7) awards.push({ badgeCode: 'seven_days', sourceKey: 'once', sessionId: session.id });

  if (isAssessedComplete(session)) {
    awards.push({ badgeCode: 'story_finisher', sourceKey: `story:${session.storyId}`, sessionId: session.id });
    const priorBest = others
      .filter((s) => s.storyVersionId === session.storyVersionId && isAssessedComplete(s))
      .reduce<number | null>((best, s) => (best === null || (s.cwpm as number) > best ? (s.cwpm as number) : best), null);
    if (priorBest !== null && (session.cwpm as number) >= priorBest + PERSONAL_BEST_MIN_GAIN) {
      awards.push({ badgeCode: 'personal_best', sourceKey: `session:${session.id}`, sessionId: session.id });
    }
  }
  return awards;
}

export function evaluateWordAwards(savedWordCount: number): AwardCandidate[] {
  return savedWordCount >= 5 ? [{ badgeCode: 'word_collector', sourceKey: 'once', sessionId: null }] : [];
}

export function rewardId(learnerId: string, badgeCode: string, sourceKey: string): string {
  return `${learnerId}|${badgeCode}|${sourceKey}`;
}
