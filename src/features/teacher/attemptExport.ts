import type { AttemptRow } from '../../backend/teacherApi';
import type { CsvValue } from '../../lib/csv';

export const ATTEMPT_CSV_HEADER = [
  'Learner', 'Story', 'Started', 'Mode', 'Practice time (s)', 'Assessment status', 'Completion', 'Method', 'Engine', 'Scoring version',
  'Total words', 'Evaluated words', 'Correct words', 'Uncertain', 'Substituted', 'Skipped', 'Coverage', 'Assessed time (s)', 'CWPM', 'Audio',
];

/**
 * One attempt as a CSV row. An unassessed attempt has no word measures, so those cells
 * stay empty: an unavailable assessment must never read as a score of zero.
 */
export function attemptCsvRow(a: AttemptRow): CsvValue[] {
  const s = a.session_assessments;
  const m = s && s.status !== 'unassessed' ? s : null;
  const measures: CsvValue[] = m
    ? [m.evaluated_words, m.correct_words, m.uncertain_words, m.substituted_words, m.skipped_words, m.coverage,
        m.assessed_ms != null ? Math.round(m.assessed_ms / 1000) : null, m.cwpm]
    : [null, null, null, null, null, null, null, null];
  return [
    a.learners?.display_name, a.story_versions?.title, a.started_at, a.mode, Math.round(a.active_ms / 1000),
    s?.status, s?.completion, s?.method, s?.engine_id ? `${s.engine_id} ${s.engine_version ?? ''}`.trim() : '', s?.scoring_version,
    s?.total_words, ...measures, a.audio_status,
  ];
}
