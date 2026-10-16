# Content: stories and vocabulary

## Starter stories

See `docs/SCOPE.md` for how each starter story fits the Grades 2–4 English learning path.

`src/content/starterStories.ts` holds six original short stories: four English
(grades 1–3) and two Filipino (grades 1–2). They are bundled with the app so a new
device can practise offline immediately. `npm run seed:generate` writes the same
stories, with the same IDs, into `supabase/seed.sql` as published library stories.

Story text is plain text. Paragraphs are separated by a blank line. The tokenizer
(`src/text/tokenize.ts`, version 1) assigns stable word and sentence IDs per immutable
story version.

## Vocabulary: review workflow

`src/content/starterVocabulary.ts` has 23 child-friendly definitions with examples,
written for the starter stories. **They have not been reviewed by an educator.** Every
entry is marked `draft`, and the app labels it "Draft definition — not yet checked by
a teacher". Syllable divisions are empty.

Teachers manage word meanings in the teacher workspace under **Word meanings**:

| State | Who sets it | Reaches devices? |
|---|---|---|
| draft | Any teacher creates or edits drafts. Any change to an entry makes it a draft again. | No |
| reviewed | A content editor or admin, after checking the definition and example | No |
| published | A content editor or admin, after review | Yes |

- Only content editors and admins can mark **syllables as verified**. A teacher's
  syllable entry stays hidden from learners until then, and the app never guesses
  syllables.
- Every write, including direct SQL, increments the entry's `version` and appends a
  row to `vocabulary_revisions` (who, when, full snapshot).
- Edits use the version as a check. A stale edit is refused, not silently overwritten.
- Devices download **published** entries only: on "Offline downloads → Download
  reviewed word meanings", and automatically when an account refreshes online. A
  published entry replaces the bundled draft for the same word and works offline.
- When a published entry is sent back to draft, devices keep the last published text
  until a new version is published.

Grant the reviewer role in SQL as described in `docs/SUPABASE_SETUP.md`.

## Recorded narration

Story editors add narration in the story editor, under **Recorded narration**:

- The recording is linked to the **published version** of the story, because word
  timings only fit that exact text. A new published version needs its own narration.
- Files: MP3, M4A, WebM or Ogg, up to 10 MB. Listen to the preview before saving.
- **Word timings are optional** and come only from a timings file made for this version:
  a JSON list of `{"w": word number from 0, "s": start ms, "e": end ms}`, in reading
  order. The browser and the server both check it against the version's word count and
  the recording length.
- Without timings, the recording plays with **no highlighting**, and the app says so.
  Tinig Turo never estimates timings from the audio or the text.
- In Listen mode, signed-in learners are offered the recording ("A teacher recorded
  this story… Download recording"). After downloading, it plays offline.
- Recordings live in the private `story-assets` bucket. Learners get short-lived links
  only for stories they are allowed to read.

## Filipino content

Filipino stories can be read, recorded and practised. Word checking stays off for
Filipino until a recognizer is verified on Filipino child speech (`docs/SPEECH.md`).
A Filipino speaker should review the Filipino stories and definitions before
classroom use.
