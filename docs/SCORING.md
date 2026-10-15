# Scoring and alignment rules

Versioned as `score-1.1.0` (scoring), `align-1.0.0` (aligner) and normalizer `1`.
(Attempts saved before 1.1.0 keep `score-1.0.0`; see the change log at the end.)
Every stored assessment records these versions, the recognition engine and its
version, and the full transcript log, so a result can be reproduced exactly
(`StreamingAligner.fromLog(...).finish()`).

**What this measures:** agreement between the speech recognizer's transcript and the
passage. It is **not** a pronunciation score and has not been clinically validated.
Recognizers mishear children, accents and noisy rooms; uncertain results go to a
teacher for review.

## Alignment (live voice following)

Source: `src/alignment/aligner.ts`. Tests and fixtures: `src/alignment/aligner.test.ts`.

1. **Normalization** (`src/text/normalize.ts`). Words are compared with a
   language-aware key. The key is lower-cased with locale rules, with apostrophes,
   diacritics and punctuation removed, and with digits 0–20 (English) or 0–10
   (Filipino) spelled out. Homophones and spelling variants (to/too/two, colour/color,
   ng/nang) count as the same word, because a transcript cannot tell them apart. The
   displayed text is never changed.
2. **Bounded window.** A heard word can match the expected word, up to 8 words ahead,
   or up to 3 words behind. A jump further than that needs a unique three-word phrase
   match, or the reader's own **Continue from here**.
3. **Common words need confirmation.** A very common word ("the", "a", "sa", "ng")
   never moves the position ahead by itself. The next heard word must confirm it. This
   stops jumps to a distant "the".
4. **Skips.** If a non-common word lands one position ahead, the word in between is
   *skipped*. Larger gaps need a distinctive landing word (four or more letters, used
   once in the window) or confirmation from the next word.
5. **Substitutions.** Unmatched heard words before a match are paired with the gap
   words in order. A pair whose spelling is close (≥ 75% similar for words of four or
   more letters) is marked *uncertain*. Otherwise it is *substituted*.
6. **Repetitions** of words just behind the position are ignored: no credit, no
   penalty. They never count a position twice.
7. **Self-corrections.** Re-reading a recently substituted, uncertain or skipped word
   correctly upgrades it to *self-corrected*, which counts as correct. A false start
   that resembles the word ("ca… cat") also marks the word self-corrected.
8. **Insertions and fillers** ("um", "uh", extra words) are counted for information
   only.
9. **Partial results.** Only *final* recognizer segments enter the confirmed
   checkpoint. Partial text is re-aligned from the checkpoint on every update, so
   revisions never corrupt confirmed progress. A final segment is frozen.
10. **Continue from here** moves the position. Words jumped over become
    *unassessed*; they are never marked correct.
11. **Pause.** When the reader pauses (or stops speaking), nothing advances.
    Recognition is suspended while the app itself speaks a word.
12. **Late final text.** After Pause or Finish the recognizer stops listening and may
    still deliver the *final* text of speech heard before that moment. That text may
    complete a phrase already on screen; a new phrase arriving then is ignored. When
    the reader continues, any phrase the recognizer never finalized is closed as final,
    so it cannot keep later words "tentative". Every closed segment is stored in the
    transcript log, so replaying the log reproduces the result.
13. **Finish** stops the clocks at the moment it is pressed. The recognizer's final
    flush afterwards is not reading time.

## Word outcomes

| Status | Meaning | Counted as |
|---|---|---|
| correct | Transcript matched | evaluated, correct |
| self_corrected | Matched after a correction | evaluated, correct |
| uncertain | Close but not exact | evaluated, *not* correct, *not* an error; flagged for review |
| substituted | A different word was transcribed | evaluated, "word to practice" |
| skipped | No transcript for this word | evaluated, "word to practice" |
| unassessed | Jumped over manually | not evaluated |
| not_reached | After the last word reached | not evaluated |

The UI calls skipped and substituted words "words to practice" and never "mistakes",
because recognizer errors look the same.

## Measures stored and shown

- **Total passage words**: words in the story version read.
- **Evaluated words**: correct + self-corrected + uncertain + substituted + skipped.
- **Correct words**: correct + self-corrected.
- **Skipped or substituted** and **uncertain**: reported separately.
- **Coverage** = evaluated ÷ total. A reading is **complete** at ≥ 95% coverage;
  otherwise it is visibly **partial**.
  - *Why 95% and not 100%:* recognizers often drop a word at the very start (before
    they are listening) or the last word (cut off by pressing Finish). 95% tolerates
    that on a 60–120-word Grade 2–4 passage while never calling an attempt that stopped
    part-way "whole story read".
  - *What it is not:* coverage says how much of the passage the reader got through. It
    is **not** accuracy, mastery, a pass mark, or a grade. It only decides the "Whole
    story" / "Partial" label, eligibility for the Story Finisher badge, and which
    attempts count for "latest CWPM (complete)" in the teacher view. 95% is a proposed
    default of this app, not a school or curriculum benchmark.
- **Practice duration** = active recording time (excludes explicit pauses and the app
  being in the background).
- **Assessed time** = the assessment clock: time the recognizer was listening while
  recording. Explicit pauses, the app being in the background, recognizer restart
  gaps and pronunciation playback are excluded. Natural hesitation is kept. For
  complete readings the clock stops when the last passage word was reached.
- **CWPM** = correct words ÷ assessed minutes, computed only when assessed time is
  ≥ 10 s.
- **Status**: `assessed`, `needs_review`, or `unassessed` (with a reason).

Duration never determines accuracy or completion. The server recomputes coverage and
CWPM in `submit_reading_session` and rejects inconsistent counts.

## Needs-review rules

An attempt is `needs_review` when any of these is true:
- fewer than 5 words were evaluated;
- uncertain words are ≥ 20% of evaluated words;
- skipped plus substituted words are ≥ 50% of evaluated words (with at least 5
  evaluated), which suggests noise or microphone trouble;
- recognition was interrupted for more than 2 s, or stopped and did not recover
  (from 1.1.0, however short the gap).

Teachers can record word-level corrections. Corrections are appended with the teacher
and time, the machine result is never modified, and the reviewed view is recomputed
with `rescoreWithCorrections`.

## Unassessed attempts

When no suitable recognizer is available, the language is not verified, or no words
were recognized, the attempt is saved with status `unassessed`, completion `unknown`
and no CWPM. Its stored word counts are zero only because nothing was evaluated; every
screen and export shows them as *not checked* (empty), never as a score of 0. The
learner sees "Practice saved—word assessment unavailable." Nothing is estimated.

The reason tells recognition problems apart from a silent reader:

| Reason | When |
|---|---|
| `recognition_unavailable` | No allowed recognizer on this device (or cloud checking not allowed / offline). |
| `language_not_verified` | The story language has no verified recognizer (Filipino). |
| `recognition_failed` | The recognizer failed, **or** (from 1.1.0) no words were recognized although the microphone picked up voice for at least 3 s. The learner is told this is a word-checking problem, not their reading. |
| `no_speech_detected` | No words were recognized and the microphone picked up little or no voice. The message suggests the microphone may be too far or too quiet; it does not say the child did not read. |
| `listen_mode` | Listening practice; never assessed. |

**What happens next.** The attempt and its recording are kept. For a reader linked to
an account, "Ask my teacher to review" queues a review request; the teacher can listen
when recordings are shared and record word-level corrections. A device-only reader's
attempt stays on the device. Saved recordings are not transcribed later on the device
(see the README's known limitations).

## Rewards

Source: `src/rewards/rules.ts`, mirrored in SQL `private.evaluate_session_awards`.

Participation rewards:
- First Steps (`once`)
- Reading Day (`day:YYYY-MM-DD`)
- Three Reading Days and Seven Reading Days (`once`)
- Word Collector, for 5 saved words (`once`)

Performance rewards (assessed, complete read-aloud attempts only):
- Story Finisher (`story:<id>`)
- Personal Best: at least 3 CWPM above the best earlier assessed, complete reading
  of the same story version (`session:<id>`)

A unique `(learner, badge, source_key)` key makes awards idempotent. Rewards computed
on the device are shown as "waiting to be checked" until the server confirms them.
There are no rankings or comparisons between learners.

## Change log

- **score-1.1.0** (2026-10-15):
  - Recognition that stopped and did not recover always adds `recognition_interrupted`
    (before: only when the measured gap exceeded 2 s).
  - With no recognized words, the reason is `recognition_failed` when the recognizer
    failed or voice was picked up for ≥ 3 s (before: always `no_speech_detected`).
  - The controller now accepts the recognizer's final text for phrases already on
    screen after Pause/Finish, and closes unfinalized phrases when reading continues.
    The aligner rules (`align-1.0.0`) are unchanged.
- **score-1.0.0**: initial rules.
