# Tinig Turo

A reading fluency and vocabulary app for elementary learners. As a child reads aloud,
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

## What it does

**Learners** (simple navigation: Home, Stories, My Words, Progress):
- **Readers.** Choose an avatar and reader profile. Several readers can share one
  device without mixing their data.
- **Stories.** Browse by grade, language, topic and whether a story is on the device.
  Download stories for offline use.
- **Read aloud.** The passage takes most of the screen. Controls along the bottom:
  Start, Pause, Continue, Finish, Help.
  - Words are marked as next (underline), just heard (blue outline), matched (subtle
    bar) or worth checking (wavy).
  - "Continue from here" recovers a lost place, auto-scroll respects manual scrolling,
    and text size and spacing are adjustable.
- **Listen and follow.** Narration with highlighting from real word timings or
  speech-synthesis boundaries. Falls back to clearly labelled sentence highlighting.
  Pause, replay and speed controls.
- **Word Coach.**
  - A child-friendly definition, shown as a draft until reviewed.
  - The word spoken by the computer voice, when one is available.
  - Syllables only once a teacher has verified them.
  - An example sentence, save to My Words, and later flashcard practice.
- **Progress and rewards.** Separate measures for each attempt. Participation and
  performance badges, with no rankings.
- **Continuing and recovering.** Continue where you stopped; recover a reading
  interrupted by a crash or navigation.

**Teachers** (a separate, PIN-lockable workspace):
- Classes and enrollment:
  - Create classes. A class code lets parents *request* enrollment; the teacher
    approves each request.
  - Add roster learners for a trusted classroom device.
- Stories: create, edit (with conflict detection), preview, publish as immutable
  versions, archive and restore.
- Assignments: assign stories to classes.
- Progress and review:
  - Progress tables and CSV exports.
  - A review queue for uncertain or unassessed attempts.
  - Recording playback through short-lived signed URLs.
  - Word-level corrections with an audit trail, and feedback to learners.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): modules, offline-first data flow,
  outbox and sync, recording lifecycle, caching.
- [docs/SCORING.md](docs/SCORING.md): alignment and scoring rules, measures, rewards.
- [docs/SPEECH.md](docs/SPEECH.md): speech engine investigation, capability detection,
  browser/device and speech-capability matrix, benchmarks.
- [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md): backend setup, roles, retention.
- [docs/SECURITY_AND_PRIVACY.md](docs/SECURITY_AND_PRIVACY.md): RLS model, recordings
  policy, device privacy.
- [docs/OFFLINE_AND_PWA.md](docs/OFFLINE_AND_PWA.md): installing, offline downloads,
  storage, updates.
- [docs/CONTENT.md](docs/CONTENT.md): starter stories and the vocabulary review process.
- [docs/TESTING.md](docs/TESTING.md): commands, results, the requirement-to-test map,
  and the manual device checklist.

## Tests

| Command | Latest result |
|---|---|
| `npm run typecheck` | no errors |
| `npm test` | 155 passed (120 unit/component + 35 database tests against the real migrations in PGlite) |
| `npm run build` | passes |
| `npm run test:e2e` | 13 passed (Chromium desktop and mobile) |

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
- **Not run against a hosted Supabase project.** All SQL is tested in PGlite, but no
  credentials were available. Auth emails, Storage uploads, signed URLs and the Edge
  Function need a staging check.
- **Unassessed recordings cannot be assessed later on the device.** Live voice
  following works, but saved recordings can't be transcribed afterwards. The offered
  path is teacher review: the learner's side can request a review, and teachers listen
  when recording sharing is allowed.
- **Vocabulary.**
  - Starter definitions are drafts that need educator review.
  - No syllables are shipped.
  - The app does not yet download reviewed vocabulary from the server.
  - There is no in-app vocabulary editor; use SQL (see
    [docs/CONTENT.md](docs/CONTENT.md)).
- **Recorded narration** with word timings is supported by the player and data model,
  but there is no upload tool yet. Starter stories use speech synthesis, which needs a
  voice on the device (rare for Filipino).
- **Device-only readers** can't yet be moved into an account; they stay on the device.
- **Browser behaviour.**
  - Headless Chromium crashes in `SpeechRecognition.available()`. The app guards
    against this; release browsers are unverified.
  - Some Android builds may not allow recording and recognition together; the app
    keeps recording and flags the attempt.
- **Background Sync** only wakes an open app window. Without an open window nothing
  syncs until the app is opened.
- **Dependency advisory.** `vosk-browser` depends on `uuid@9`, which has a moderate
  advisory for v3/v5/v6 with caller buffers. Vosk doesn't use those code paths.
