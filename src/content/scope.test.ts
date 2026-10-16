import { describe, expect, it } from 'vitest';
import { inLearningPath, outsidePathReason, readingLevelLabel, schoolGradeOption } from './scope';
import { STARTER_STORIES } from './starterStories';
import { waveformColumns } from '../recording/waveform';

describe('Grade 2–4 English learning path', () => {
  it('includes only English stories written for Grades 2–4', () => {
    expect(inLearningPath({ language: 'en', gradeLevel: 2 })).toBe(true);
    expect(inLearningPath({ language: 'en', gradeLevel: 4 })).toBe(true);
    expect(inLearningPath({ language: 'en', gradeLevel: 1 })).toBe(false);
    expect(inLearningPath({ language: 'en', gradeLevel: 5 })).toBe(false);
    expect(inLearningPath({ language: 'fil', gradeLevel: 3 })).toBe(false);
  });

  it('keeps out-of-path starter stories and says why they are outside the path', () => {
    const outside = STARTER_STORIES.filter((s) => !inLearningPath(s));
    expect(outside.length).toBeGreaterThan(0); // nothing was deleted
    for (const story of outside) expect(outsidePathReason(story)).toMatch(/Grade 1 level|Filipino story/);
    expect(outsidePathReason({ language: 'en', gradeLevel: 3 })).toBeNull();
  });

  it('labels a story’s reading level separately from a learner’s school grade', () => {
    expect(readingLevelLabel(3)).toBe('Grade 3 reading level');
    expect(schoolGradeOption(3)).toBe('Grade 3');
    expect(schoolGradeOption(6)).toBe('Grade 6 (outside the Grade 2–4 path)');
  });
});

describe('live waveform geometry', () => {
  it('draws silence as a flat line and never exceeds the canvas', () => {
    const silence = waveformColumns(new Float32Array(1024), 48);
    expect(silence).toHaveLength(48);
    expect(silence.every((c) => c.low === 0 && c.high === 0)).toBe(true);
    const loud = waveformColumns(Float32Array.from({ length: 1024 }, (_, i) => (i % 2 ? 0.9 : -0.9)), 48);
    expect(loud.every((c) => c.high === 1 && c.low === -1)).toBe(true); // clipped, not overflowing
  });
});
