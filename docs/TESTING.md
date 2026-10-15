# Testing

## Commands

```bash
npm run typecheck        # TypeScript project references, strict mode
npm test                 # Vitest: unit + component (jsdom) and database (PGlite) projects
npm run test:unit        # unit and component tests only
npm run test:db          # SQL migrations, RLS, RPCs, Storage policies, seed (PGlite)
npm run test:e2e         # Playwright: builds, serves dist/, runs Chromium desktop + mobile
npm run check            # all of the above plus the production build
node scripts/bench-alignment.mjs   # alignment performance on this machine
```

`npx playwright install chromium` is needed once before the browser tests.

## Results

Each run below was executed on this branch; earlier counts are history, not current
results. Environment: Windows 11, Node 24.14, Vitest 5.0.4, Playwright 1.64 (Chromium).

| Suite | Baseline before changes (commit 06cdf4c + deployed working tree) | Stage 2 (this branch) |
|---|---|---|
| `npm run typecheck` | no errors | no errors |
| `npm test` | 156 passed, 14 files | **180 passed**, 15 files (145 unit/component, 35 database) |
| `npm run test:e2e` | 13 passed (desktop 11, mobile 2) | **15 passed** (desktop 13, mobile 2) |
| `npm run build` | passes | passes |

The baseline already had 156 tests although the earlier docs said 155.

Unit and component tests per file (stage 2):

| File | Tests |
|---|---|
| `src/alignment/aligner.test.ts` | 35 |
| `src/reading/readAloudController.test.ts` | 22 |
| `src/sync/engine.test.ts` | 14 |
| `src/recording/recording.test.ts` | 12 |
| `src/assessment/scoring.test.ts`, `src/lib/lib.test.ts` | 10 each |
| `src/features/components.test.tsx` | 9 |
| `src/text/text.test.ts`, `src/data/data.test.ts` | 8 each |
| `src/speech/plan.test.ts`, `src/rewards/rules.test.ts` | 5 each |
| `src/speech/webSpeech.test.ts` | 4 |
| `src/recording/permissions.test.ts` | 3 |

Database tests: `supabase/tests/security.test.ts` (31) and `supabase/tests/seed.test.ts` (4).

### Defects found in the stage-2 audit, each with a test that fails on the old code

All ten new controller tests were run against the previous controller and scoring code
and failed there; they pass with the fixes.

| Defect | Test |
|---|---|
| Leaving the reading screen while the permission prompt was open left the microphone recording after the adult allowed it, and saved an orphaned attempt | `readAloudController.test.ts` "leaving the screen while the permission prompt is open…" |
| Cancelling while the attempt was being created left an unfinished attempt on Home | "cancelling while the attempt is being created…" |
| A blocked microphone was requested again on every retry; guidance pointed to an address bar that installed apps do not have | "a blocked microphone is explained…"; `permissions.test.ts`; `e2e/microphone-denied.spec.ts` (2 tests) |
| The recognizer's final text after Pause/Finish was dropped, and an unfinalized phrase kept every later word "tentative" | "the final text of speech heard before Pause…", "text a recognizer never finalized…", "counts the final words … after Finish"; `aligner.test.ts` "segments a recognizer never finalizes" |
| A recognizer failure with no words was reported as "We did not hear any reading… try louder" | "a recognizer that fails before recognizing any words…", "voice picked up with no recognized words…"; `scoring.test.ts`; `components.test.tsx` |
| A disconnected microphone saved the attempt but never said why it stopped | "a microphone that disconnects…"; `components.test.tsx` "says why a recording stopped early" |
| A "can't hear you" hint appeared on devices that cannot measure input level | "shows no silence hint when the device cannot report input levels" |
| A recorder that never reports stopping could hang "Saving your reading…" | `recording.test.ts` "stopping never hangs…" |
| Reader-only pages silently redirected to Home | `components.test.tsx` "RequireLearner…"; `e2e/learners.spec.ts` "a reader-only page explains…" |
| Teacher CSV exported unassessed attempts as 0 words / 0% coverage | `lib.test.ts` "teacher attempt export" |

Fixed without a dedicated automated test (covered by review and the e2e flow):
- "Save and leave" now leaves only after the reading is saved.
- Home shows only assignments for the reader's own classes (a reader with no class saw
  every class's assignments) and says "Practised" instead of "Done".
- Saving an unfinished reading from Home shows progress and errors instead of failing
  silently.

Problems found and fixed in the original build (history):
- An ordering bug in the outbox. A save and a remove created in the same millisecond
  could sync in the wrong order; op timestamps are now strictly increasing.
- A loading race that redirected deep links before the reader had loaded.
- A tokenizer spacing bug: "Run — fast" was displayed as "Run—".
- A renderer crash in Chromium's on-device speech check, now guarded. See
  `docs/SPEECH.md`.
- A flaky e2e assertion that raced React's re-render.

The SQL tests were also checked by mutation: replacing the learner and session read
policies with `using (true)` made 5 tests fail, as expected.

## Coverage of the required scenarios

| Requirement | Where it is tested |
|---|---|
| Offline launch after installation | `e2e/offline.spec.ts`: SW controls the page, network off, reload, app opens |
| Offline reading, recording and local saving | `e2e/offline.spec.ts`: records offline, saves, shows in Progress, survives reload |
| Reconnection and synchronization | `src/sync/engine.test.ts`: offline keeps everything, then syncs on reconnect |
| Duplicate retries without duplicate records or rewards | `engine.test.ts` (lost acknowledgement); `security.test.ts` (same op id, same session id, award uniqueness) |
| Expired authentication during sync | `engine.test.ts`: pauses as `auth_required`, nothing failed or lost, resumes after sign-in |
| Story-edit conflicts | `engine.test.ts` (conflict surfaced; keep theirs / overwrite); `security.test.ts` (stale revision updates 0 rows; forced revision rejected) |
| Storage-quota failures | `readAloudController.test.ts` (save fails atomically, recording kept for download); `data.test.ts` (download refused cleanly) |
| Account and learner switching | `data.test.ts` (separate partitions; deleting one keeps the other); `e2e/learners.spec.ts` (two readers on one device); `engine.test.ts` (no sync under another account) |
| Microphone denial and recording retry | `recording.test.ts` (state machine, distinct errors, retry clears error); `e2e/microphone-denied.spec.ts` (one clear error, retry works; denial simulated, see below) |
| Silence and background noise | `aligner.test.ts` (silence, noise and off-script talk fabricate no progress); `readAloudController.test.ts` (silence and noise hints; no speech means unassessed) |
| Repeated words and revised partial transcripts | `aligner.test.ts` (stutters, repeated phrases, passages with repeated words, partial revisions, frozen finals) |
| Manual reading-position recovery | `aligner.test.ts` and `readAloudController.test.ts` ("Continue from here" never credits skipped words) |
| Pause and resume timing | `recording.test.ts` (`SessionClock`: pauses, interruptions, recognizer gaps); `readAloudController.test.ts` (highlight and clock freeze while paused) |
| App reload after a saved session | `e2e/offline.spec.ts` (reload offline); `readAloudController.test.ts` and `e2e/learners.spec.ts` (interrupted attempt recovered after reload) |
| Cross-user and cross-class access denial | `security.test.ts`: strangers, other teachers, removed members, pending requests, anon |
| Private audio access | `security.test.ts`: no upload without policy, exact path only, no overwrite, strangers cannot read, teacher only after approval, confirm requires the object |
| Mobile layouts and keyboard navigation | `e2e/mobile.spec.ts` (Pixel 7: bottom nav, touch targets, no horizontal scroll, largest text); `e2e/learners.spec.ts` and `components.test.tsx` (skip link, passage arrows and Enter, dialog focus trap and return, visible focus) |
| Service-worker update during a session | `e2e/update.spec.ts` (real new SW installed mid-recording; not applied, offered after saving); `lib.test.ts` and `components.test.tsx` (update gate) |

## What automated tests cannot show

- **Real speech quality.** Chromium's fake microphone plays a tone, and headless
  Chromium has no on-device recognizer or voices. Alignment is tested with
  deterministic transcript fixtures. Recognition accuracy, latency and alignment on
  real children's voices must be measured on target devices (`docs/SPEECH.md`).
- **Microphone denial** in headless Chromium surfaces as `NotSupportedError`, so the
  e2e test simulates the `NotAllowedError` that real browsers raise. Real denial must
  be checked on devices.
- **Hosted Supabase.** The SQL is tested in PGlite with a stand-in for Supabase's
  `auth` and `storage` schemas. On 2026-10-15 a read-only, unauthenticated check of
  the hosted project used by the live site showed the migrations are applied (the RPCs
  exist and refuse anonymous callers with `42501`) and email sign-in is enabled.
  **That project is the production backend**, so the end-to-end checks (sign-up and
  email confirmation, password recovery, enrollment approval, attempt sync, audio
  upload, signed-URL playback and expiry, cross-class denial, retention) were not run:
  they would create real accounts and data. Run them on a separate staging project.
- **Physical devices.** Nothing in this report was run on a phone or tablet. "Mobile"
  results are Playwright's Pixel 7 emulation in desktop Chromium.

### Kinds of verification in this report

| Kind | What was done |
|---|---|
| Automated tests | Vitest (unit, component, PGlite database) and Playwright, results above. |
| Browser observations | Headless Chromium only (desktop and Pixel 7 emulation). No Safari, Firefox or real Android Chrome. |
| Hosted backend | Read-only reachability and schema check only (see above). |
| Physical devices | None. The manual checklist below is still required. |
| Live deployment | The production URL is public and serves this app; the per-deployment preview URL is behind Vercel Authentication and was not accessed. |

## Manual device checklist

Run on each target device (for example a low-cost Android phone, an iPad, and a
Chromebook):

1. Install the app; turn on airplane mode; open it; read and record a story.
2. Grant and deny the microphone; unplug a headset mid-recording.
3. With an on-device engine available: read a passage at normal pace, slowly, with
   skips and repetitions; check that the highlight follows and pauses when you pause.
4. Read in a quiet room and in a noisy one; compare results with a teacher's hand count.
5. Background the app during a recording; return; continue.
6. Fill storage close to full; try saving a reading and downloading a story.
7. Against a staging Supabase project:
   - sign up, confirm the email, sign in, and recover the password;
   - join a class with a code, approve it, sync a reading;
   - upload a recording with consent and play it back from the teacher review screen;
   - edit the same story on two devices and resolve the conflict.
8. Screen reader pass (TalkBack, VoiceOver, NVDA) through reader selection, reading,
   Word Coach and results.
