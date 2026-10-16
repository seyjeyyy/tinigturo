# Architecture

```
src/
  content/       starter stories and vocabulary, the Grades 2–4 English learning path
  text/          language metadata, normalization, tokenization (stable word/sentence IDs)
  alignment/     streaming transcript-to-passage aligner (pure, deterministic)
  assessment/    scoring rules and measures
  rewards/       participation and performance reward rules (mirrored in SQL)
  speech/        provider interface, Web Speech + Vosk adapters, capability detection, plan
  narration/     Listen-and-follow: speech synthesis and recorded narration (word timings
                 only when supplied), narration file and timings checks
  recording/     recording state machine, session clock, MediaRecorder wrapper,
                 microphone permission (no re-prompting), live waveform geometry
  reading/       ReadAloudController: orchestrates recorder + recognizer + aligner + storage
  db/            Dexie databases (one per identity), metadata DB, quota handling
  data/          local repositories (learners, stories, sessions, words, server refresh),
                 device-reader linking, published vocabulary and narration downloads
  sync/          persistent outbox, payload mapping, SyncEngine
  backend/       Supabase client, remote API (sync), account, teacher and teacher-tools
                 (rubrics, grades, vocabulary, narration) APIs, error mapping
  pwa/           service-worker registration and update gate
  ui/            accessible building blocks (Button, Dialog, fields, alerts, badges)
  features/      screens: home, stories, reading, words, progress, downloads, settings,
                 sync, account, teacher workspace, install, benchmark
supabase/
  migrations/    schema, security (RLS, grants, triggers), functions (RPCs), storage
  functions/     purge-expired-audio Edge Function
  tests/         PGlite-based tests of the real SQL
  seed.sql       generated starter library (no learner activity)
e2e/             Playwright browser tests against the production build
```

The UI depends on interfaces, not engines. The reading screen uses
`ReadAloudController` and `Narrator`. The controller depends on `SpeechProvider`,
`RecorderLike`, the aligner and the local repositories. Each layer is tested on its
own.

## Offline-first data flow

```
learner action ─▶ IndexedDB (partition for this identity)
                    ├─ record (session / word / learner …)
                    └─ outbox op            ◀── same transaction
                                 │
                 SyncEngine (launch, reconnect, "Sync now", retry timer, optional
                 Background Sync nudge)
                                 │  checkAuth → identity check → my_access()
                                 ▼
                 Supabase RPC (idempotent by op_id + unique keys) ─▶ server acknowledgement
                                 │
                 local record marked synced; server-validated rewards applied
```

- **Partitions.** Each signed-in account has its own IndexedDB database
  (`tinigturo:user:<id>`). Readers created without an account live in
  `tinigturo:device`. A small `tinigturo-meta` database stores which partitions exist,
  device settings and teacher PIN hashes. Signing out can keep the partition, locked to
  that account, or delete it.
- **Atomic saves.** A finished attempt, its recording, its outbox ops and its pending
  rewards are written in one IndexedDB transaction (`finalizeSession`).
- **Immutable attempts.** Sessions are submitted once. The only later changes are the
  audio upload status (after the server confirms the object exists in Storage) and a
  teacher-review request, each through its own RPC.
- **Outbox states:** `pending` → `syncing` → `synced`, or `conflict` / `failed`.
  - Network errors back off exponentially with jitter (5 s doubling to 30 min).
  - Expired sign-in pauses sync without counting an attempt.
  - Validation and permission errors are marked `failed` with a reason. "Sync now"
    retries them.
  - Ops left `syncing` by a crash are retried; the server deduplicates them.
- **Dependencies.** `audio.upload` waits for `session.submit`, and both wait for
  `learner.create`.
- **Conflicts.** Story drafts carry a revision. A stale save updates no rows and is
  surfaced with both versions; the user picks "keep theirs" or "replace with mine".
  Assignments and classes use the same revision trigger.
- **Deletions** are tombstones (`learner_vocabulary.archived_at`, story and assignment
  `archived_at`, `class_memberships.status = removed`), so they synchronize instead of
  vanishing.
- **Revalidation.** Before sending learner data, the engine confirms the stored session
  belongs to the partition's user and asks the server which learners are still
  accessible. Work for revoked learners is kept locally and marked failed.

## Reading and recording

`ReadAloudController` (`src/reading/readAloudController.ts`) owns one attempt:

1. `REQUEST`: choose an audio format at runtime, then read the microphone permission
   *without prompting* (`src/recording/permissions.ts`). If it is blocked, the app shows
   steps for this kind of device (installed Android app, Android browser, iPhone/iPad,
   desktop, or a device-level block) and does not call `getUserMedia` again until the
   permission changes. Otherwise it requests the microphone. Denied, missing, busy,
   disconnected, insecure and unsupported cases each have their own message.
2. `GRANTED`: an in-progress session row is written immediately.
3. `START`:
   - MediaRecorder emits a 1 s chunk each second, saved to IndexedDB.
   - The speech provider starts.
   - The session clock starts.
   - Timing and the transcript log are checkpointed every 3 s.
4. Pause and resume affect the recorder, recognizer and clock together. When the app
   is hidden it pauses automatically, and the reader resumes.
5. `FINISH` → `processing`:
   1. stop the clock (the reading ended when Finish was pressed);
   2. flush the recognizer: its final text for phrases already on screen is still
      accepted, new phrases are not;
   3. stop the recorder (with a timeout, so a broken recorder cannot hang "Saving…");
   4. assess (or mark unassessed);
   5. `finalizeSession` saves everything atomically.

   The state then moves to `result`.
   - A **recording failure** (microphone unplugged, recorder error) saves the attempt as
     far as it got and the result says why it stopped. A **recognition failure** keeps
     recording; word following stops, and the attempt goes to review or is unassessed
     as `recognition_failed`. The two are never confused.
6. Cancel discards the attempt after confirmation. Leaving the page releases the
   microphone; the in-progress attempt stays recoverable from Home ("Save what was
   read").

Every event carries the attempt's token, so callbacks from an earlier attempt are
ignored. The state machine ignores invalid transitions, which makes double-taps
harmless. After every `await` in `begin()` the controller re-checks that its attempt is
still current and the screen still open: leaving while the permission prompt is shown
releases the microphone instead of recording with nobody watching, and cancelling while
the attempt is being created leaves no unfinished attempt behind.

## Service worker and caching

- `vite-plugin-pwa` (`generateSW`, `registerType: 'prompt'`) precaches only the app
  shell (≈ 940 KB).
- Story content lives in IndexedDB. Speech models live in the
  `tinigturo-speech-models` cache. The 5.8 MB Vosk bundle is cached only when the
  learner downloads the engine.
- Supabase API, Auth and Storage responses are never cached by the service worker.
- A new service worker waits. The app offers "Update now" only when no recording is
  active; on the reading screen the banner is hidden during a recording (tested in
  `e2e/update.spec.ts`).

## Security model

See `docs/SECURITY_AND_PRIVACY.md`.

## Teacher content and grades

- **Grades** are teacher judgements stored in `session_grades`: one per attempt per
  class, draft or published, with a revision check. Every save is appended to
  `session_grade_revisions`. They reference an immutable `grading_rubrics` version.
  Assessments, grades and badges are separate tables, and no code derives one from
  another.
- **Vocabulary** entries move draft → reviewed → published. A trigger versions every
  write and logs it to `vocabulary_revisions`. Devices download published entries
  into their local `vocabulary` table (`data/teacherContent.ts`).
- **Narration** recordings are rows in `story_narrations` linked to one story version,
  with the audio in `story-assets`. Devices store a downloaded recording under
  `recordings['narration:<versionId>']` and its timings on the local story version.

## Linking device-only readers

`data/linking.ts` copies a reader from the `device` partition into `user:<id>`:

1. The reader and all its records go into the account partition with their sync ops,
   in **one transaction**, keeping every ID.
2. Only then is the device copy deleted.
3. A journal in `tinigturo-meta` lets an interrupted link resume. A reader already in
   the account is only removed from the device, never copied twice.
4. The server's `create_learner` rule (an ID can belong to one account) prevents
   attaching to someone else's learner.
