# Tinig Turo

An English reading fluency and vocabulary app for elementary learners in Grades 2–4
(see [docs/SCOPE.md](docs/SCOPE.md)). As a child reads aloud,
the app follows their voice and highlights the matching words in the passage
("videoke-style" reading). It works offline after installation and syncs to Supabase
when online.

Built with React 19, TypeScript, Vite, React Router, Tailwind CSS, Dexie (IndexedDB),
a Workbox service worker, and Supabase (Postgres with RLS, Auth, Storage, Edge
Functions). Tested with Vitest, React Testing Library, PGlite and Playwright.

## Quick start

```bash
npm install
npm run dev                      # http://localhost:5173, works without any backend
```

With no configuration, the app runs entirely on the device: readers, stories,
reading, recording, progress and My Words. To enable accounts, classes, the teacher
workspace and sync:

```bash
cp .env.example .env.local       # set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY
```

Then follow [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md): link the project, run
`npx supabase db push`, optionally load the seed, set the auth redirect URLs, and
deploy the retention function.

## Get the app

- **Web:** <https://tinigturo-green.vercel.app>. Install it from the browser for offline use.
- **Android:** [download the APK](https://tinigturo-green.vercel.app/download/tinigturo.apk) (Android 7.0+, about 1 MB). It is a Trusted Web Activity: a signed shell that opens this same web app in Chrome. A Vercel deploy updates the web app inside it, not the Android package itself. See [docs/ANDROID.md](docs/ANDROID.md) for building, signing and Google Play.

## What it does

**Learners** (simple navigation: Home, Stories, My Words, Progress):
- **Readers.** Choose an avatar and reader profile. Several readers can share one
  device without mixing their data. Pages that need a reader explain why and come back
  after one is chosen.
- **Stories.** The list opens on the **Grades 2–4 English** learning path. All stories
  stay available, with out-of-path ones (Grade 1, 5, 6, Filipino) labelled as extra
  practice. Teacher assignments always show. Download stories for offline use.
- **Read aloud.** The passage takes most of the screen, including on small phones.
  Compact controls: Start, Pause, Continue, Finish, Word Coach, Help.
  - Words are marked as next (underline), just heard (blue outline), matched (subtle
    bar) or worth checking (wavy).
  - A live waveform shows that the microphone hears the reader. It is not a score.
  - Auto-scroll respects manual scrolling; text size and spacing are adjustable.
  - A blocked microphone gets device-specific steps, without repeated prompts.
- **Word Coach.** Press **Word Coach**, then tap a word, or touch and hold a word. The
  reading pauses while it is open and continues after. It shows:
  - a child-friendly definition (a draft until a reviewer publishes it);
  - the word spoken by the computer voice;
  - syllables, only when verified by a content editor;
  - "Continue reading from here" to recover a lost place;
  - a button to save the word to My Words.
- **Listen and follow.** A teacher's recorded narration (highlighting only from word
  timings supplied with it) or the computer voice (word or sentence highlighting).
- **Progress.** Separate measures for each attempt, never zeros for unchecked readings.
  Published teacher grades with feedback. Participation and performance badges, with no
  rankings, kept separate from grades.

**Families and accounts:**
- Readers saved only on a device can be **added to an account**, deliberately: the
  adult confirms which readers and which account. IDs are kept, and an interrupted move
  resumes safely.

**Teachers** (a separate, PIN-lockable workspace at `/teacher`, reached from **Grown-ups → Teachers → Teacher sign in** or **Settings → Teacher workspace**; it needs an account with the teacher role):
- Classes, enrollment by request and approval, and roster learners for shared devices.
- Stories: create, edit with conflict detection, **import text from a book** (PDF with
  selectable text, DRM-free EPUB, or plain text, read in the browser and reviewed before
  saving), publish immutable versions, and add
  **recorded narration** (with optional verified word timings) to a published version.
- Assignments, progress tables and CSV exports.
- Review: a queue of uncertain or unassessed attempts, recording playback through
  short-lived signed URLs, and word-level corrections with an audit trail.
- **Grades:**
  - Rubrics written by the school, versioned and immutable.
  - Draft and published grades per attempt; families see only published ones.
  - Changing a published grade needs a reason, and every change is kept.
  - A class gradebook with CSV export.
- **Word meanings:** teachers write drafts; content editors review, verify syllables
  and publish. Devices download published meanings for offline use.

## Documentation

- [docs/STATUS.md](docs/STATUS.md): what is deployed, the audit of every requirement
  (verified, unverified, fixed, done, missing), the stages, and what still needs
  verification.
- [docs/SCOPE.md](docs/SCOPE.md): Grades 2–4 English scope, how other content is
  categorised, SDG 4 alignment, and what is kept apart (grade, level, performance,
  rewards).
- [docs/RELEASE.md](docs/RELEASE.md): release order (database first), staging,
  production steps, rollback.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): modules, offline-first data flow,
  outbox and sync, recording lifecycle, caching.
- [docs/SCORING.md](docs/SCORING.md): alignment and scoring rules, measures, rewards.
- [docs/SPEECH.md](docs/SPEECH.md): speech engine investigation, capability detection,
  browser/device and speech-capability matrix, benchmarks.
- [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md): backend setup, roles, retention.
- [docs/SECURITY_AND_PRIVACY.md](docs/SECURITY_AND_PRIVACY.md): RLS model, recordings
  policy, device privacy.
- [docs/ANDROID.md](docs/ANDROID.md): Android app (Trusted Web Activity), signing key,
  new versions, Google Play.
- [docs/OFFLINE_AND_PWA.md](docs/OFFLINE_AND_PWA.md): installing, offline downloads,
  storage, updates.
- [docs/CONTENT.md](docs/CONTENT.md): starter stories, the vocabulary review workflow,
  and recorded narration.
- [docs/TESTING.md](docs/TESTING.md): commands, results, the requirement-to-test map,
  and the manual device checklist.

## Tests

Results from the latest run (2026-10-16, branch `enhance/book-import`). Details,
and what these tests cannot show, are in [docs/TESTING.md](docs/TESTING.md).

| Command | Result |
|---|---|
| `npm run typecheck` | no errors |
| `npm test` | 229 passed (185 unit/component + 44 database tests against the real migrations in PGlite) |
| `npm run build` | passes |
| `npm run test:e2e` | 19 passed (headless Chromium: desktop, Pixel 7 and 360×640 emulation, axe-core accessibility rules) |

None of these run on a physical device or against a hosted Supabase project.

## Known limitations and unresolved issues

- **No speech engine is verified on target devices.**
  - Browser on-device recognition is used automatically where the browser reports it
    available.
  - Vosk is included as an experimental, disabled-by-default engine. It is
    unmaintained since 2022 and has not been benchmarked on low-cost devices.
  - Cloud recognition is opt-in.
  - Recognition accuracy on children's speech is unmeasured. See
    [docs/SPEECH.md](docs/SPEECH.md) for the evaluation plan and the benchmark screen
    (`/benchmark`).
- **Filipino is not assessed.** No suitable verified recognizer was found. Filipino
  stories are read, recorded and practised without scoring.
- **Hosted Supabase end-to-end flows are unverified.** All SQL is tested in PGlite.
  The hosted project used by the live site has the migrations applied (checked
  read-only), but it is the production backend, so sign-up emails, enrollment, Storage
  uploads, signed URLs and the retention function still need a check on a separate
  staging project.
- **The teacher-tools migration is not applied to production.**
  `20261016000100_teacher_tools.sql` must be applied before a web app using grades,
  word meanings or narration goes live ([docs/RELEASE.md](docs/RELEASE.md)).
- **Unassessed recordings cannot be assessed later on the device.** Live voice
  following works, but saved recordings can't be transcribed afterwards. The offered
  path is teacher review and grading. Teachers can listen when recording sharing is
  allowed; device-only readers must first be added to an account.
- **Content.**
  - Starter definitions are unreviewed drafts until a content editor publishes reviewed
    meanings. No syllables are shipped.
  - Only two bundled stories are in the Grades 2–4 English path, and there is no Grade 4
    story. Teachers add stories in the workspace.
- **Narration timings** are only as good as the timings file a teacher supplies. The app
  never estimates them; without one, narration plays with no highlighting. The computer
  voice needs a voice on the device (rare for Filipino).
- **Pitch and rhythm feedback is not implemented.** The waveform shows the microphone
  signal only and is not a pronunciation score.
- **Browser behaviour.**
  - Headless Chromium crashes in `SpeechRecognition.available()`. The app guards
    against this; release browsers are unverified.
  - Some Android builds may not allow recording and recognition together; the app
    keeps recording and flags the attempt.
- **Background Sync** only wakes an open app window. Without an open window nothing
  syncs until the app is opened.
- **Dependency advisory.** `vosk-browser` depends on `uuid@9`, which has a moderate
  advisory for v3/v5/v6 with caller buffers. Vosk doesn't use those code paths.
