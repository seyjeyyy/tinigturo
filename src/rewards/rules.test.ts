import { describe, expect, it } from 'vitest';
import { evaluateSessionAwards, evaluateWordAwards, type SessionForRewards } from './rules';

const base: SessionForRewards = {
  id: 's1', storyId: 'story', storyVersionId: 'v1', localDay: '2026-10-01', mode: 'read_aloud',
  assessmentStatus: 'assessed', completion: 'complete', cwpm: 40,
};

describe('reward rules', () => {
  it('participation awards use unique source keys', () => {
    const codes = evaluateSessionAwards([], base).map((a) => `${a.badgeCode}|${a.sourceKey}`);
    expect(codes).toEqual(['first_practice|once', 'practice_day|day:2026-10-01', 'story_finisher|story:story']);
  });

  it('unassessed or partial readings never earn performance awards', () => {
    for (const s of [
      { ...base, assessmentStatus: 'unassessed' as const, completion: 'unknown' as const, cwpm: null },
      { ...base, completion: 'partial' as const },
      { ...base, assessmentStatus: 'needs_review' as const },
      { ...base, mode: 'listen' as const },
    ]) {
      const codes = evaluateSessionAwards([], s).map((a) => a.badgeCode);
      expect(codes).not.toContain('story_finisher');
      expect(codes).not.toContain('personal_best');
      expect(codes).toContain('first_practice');
    }
  });

  it('personal best needs a real improvement over an earlier assessed reading', () => {
    const earlier = { ...base, id: 's0', cwpm: 40 };
    expect(evaluateSessionAwards([earlier], { ...base, cwpm: 42 }).map((a) => a.badgeCode)).not.toContain('personal_best');
    expect(evaluateSessionAwards([earlier], { ...base, cwpm: 43 }).map((a) => a.badgeCode)).toContain('personal_best');
    expect(evaluateSessionAwards([], { ...base, cwpm: 90 }).map((a) => a.badgeCode)).not.toContain('personal_best');
  });

  it('counts distinct practice days', () => {
    const history = ['2026-10-01', '2026-10-02'].map((d, i) => ({ ...base, id: `h${i}`, localDay: d }));
    expect(evaluateSessionAwards(history, { ...base, localDay: '2026-10-02' }).map((a) => a.badgeCode)).not.toContain('three_days');
    expect(evaluateSessionAwards(history, { ...base, localDay: '2026-10-03' }).map((a) => a.badgeCode)).toContain('three_days');
  });

  it('word collector after five saved words', () => {
    expect(evaluateWordAwards(4)).toEqual([]);
    expect(evaluateWordAwards(5)).toEqual([{ badgeCode: 'word_collector', sourceKey: 'once', sessionId: null }]);
  });
});
