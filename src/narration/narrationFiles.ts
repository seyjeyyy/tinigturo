import type { NarrationTiming } from '../domain/types';

/**
 * Checks for uploaded narration, mirroring the server's rules in
 * register_story_narration so a teacher sees problems before uploading.
 * Word timings are accepted only when supplied with the recording; they are never
 * estimated from the audio or the text.
 */
export const MAX_NARRATION_BYTES = 10 * 1024 * 1024;

const TYPES: Record<string, { mimeType: string; extension: string }> = {
  'audio/mpeg': { mimeType: 'audio/mpeg', extension: 'mp3' },
  'audio/mp3': { mimeType: 'audio/mpeg', extension: 'mp3' },
  'audio/mp4': { mimeType: 'audio/mp4', extension: 'm4a' },
  'audio/x-m4a': { mimeType: 'audio/mp4', extension: 'm4a' },
  'audio/webm': { mimeType: 'audio/webm', extension: 'webm' },
  'audio/ogg': { mimeType: 'audio/ogg', extension: 'ogg' },
};

export type NarrationFileCheck =
  | { ok: true; mimeType: string; extension: string }
  | { ok: false; error: string };

export function checkNarrationFile(file: { type: string; size: number }): NarrationFileCheck {
  const type = TYPES[file.type.split(';')[0].trim().toLowerCase()];
  if (!type) return { ok: false, error: 'Use an MP3, M4A, WebM or Ogg audio file.' };
  if (file.size <= 0) return { ok: false, error: 'This file is empty.' };
  if (file.size > MAX_NARRATION_BYTES) return { ok: false, error: 'The recording must be 10 MB or smaller.' };
  return { ok: true, ...type };
}

/** Stored form: w = word index, s = start ms, e = end ms. */
export interface NarrationTimingInput { w: number; s: number; e: number }

export type TimingsCheck = { ok: true; timings: NarrationTimingInput[] } | { ok: false; error: string };

/**
 * Parses a timings file: a JSON array of { "w", "s", "e" } (or { "wordIndex",
 * "startMs", "endMs" }) for words of this exact story version, in reading order.
 */
export function parseNarrationTimings(text: string, wordCount: number, durationMs: number | null): TimingsCheck {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'The timings file is not valid JSON.' };
  }
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'The timings file must be a list of word timings.' };
  if (raw.length > wordCount) return { ok: false, error: `This story version has ${wordCount} words, but the file has ${raw.length} timings.` };
  const timings: NarrationTimingInput[] = [];
  let previousWord = -1;
  let previousStart = -1;
  for (const [i, item] of raw.entries()) {
    const o = (item ?? {}) as Record<string, unknown>;
    const w = o.w ?? o.wordIndex;
    const s = o.s ?? o.startMs;
    const e = o.e ?? o.endMs;
    const at = `Timing ${i + 1}`;
    if (typeof w !== 'number' || typeof s !== 'number' || typeof e !== 'number') return { ok: false, error: `${at} needs a word index, a start and an end in milliseconds.` };
    if (!Number.isInteger(w) || w < 0 || w >= wordCount) return { ok: false, error: `${at} names word ${w}, which is not in this story version.` };
    if (w <= previousWord) return { ok: false, error: `${at}: words must be in reading order, each once.` };
    if (s < 0 || s < previousStart || e <= s) return { ok: false, error: `${at}: times must go forward, and each word must end after it starts.` };
    if (durationMs !== null && e > durationMs + 500) return { ok: false, error: `${at} ends after the recording does.` };
    timings.push({ w, s: Math.round(s), e: Math.round(e) });
    previousWord = w;
    previousStart = s;
  }
  return { ok: true, timings };
}

export function toNarrationTimings(input: NarrationTimingInput[] | null): NarrationTiming[] {
  return (input ?? []).map((t) => ({ wordIndex: t.w, startMs: t.s, endMs: t.e }));
}
