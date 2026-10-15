# Project status, audit and plan

Last updated 2026-10-15 on branch `enhance/stage-1-reliability`. This file records what
was checked and how, so claims elsewhere in the docs can be traced. "Verified" below
means verified by the named automated tests in emulated browsers. **Nothing has been
verified on a physical phone or tablet, or against a staging Supabase project.**

## What is deployed

| Item | Finding |
|---|---|
| Repository | `github.com/seyjeyyy/tinigturo` (`seyjeyyy` remote; `main` = `06cdf4c`). The `origin` remote (`Sheshseyjey/tinigturo`) is one commit behind. |
| Production web app | `https://tinigturo-green.vercel.app`, deployed with the Vercel CLI from an **uncommitted working tree**: it serves the Android download page, which was in no commit. That working tree is now commit `247d76e` on this branch. |
| Deployment URL given for review | `tinigturo-k3687rmyv-…vercel.app` is behind Vercel Authentication (login page). Not accessed. |
| Supabase | The production app and `.env.local` use the same hosted project. Its migrations are applied (RPCs exist; anonymous calls are refused). It is the production backend, so no test data was written to it. |
| Android | A Trusted Web Activity APK (`com.tinigturo.app` 1.0.0) is served at `/download/tinigturo.apk`. It is a shell around the website, not a separate app build. See `docs/ANDROID.md`. |

## Requirement status

Classification: **Verified** (working and covered by tests here), **Unverified**
(implemented, not tested here), **Defective**, **Incomplete**, **Missing**. "Fixed"
means it was defective and is fixed on this branch with tests.

| Area | Status | Notes |
|---|---|---|
| Mobile PWA shell: bottom nav, safe areas, touch targets, no sideways scroll | Verified (Pixel 7 emulation) | `e2e/mobile.spec.ts`. Real devices unverified. |
| Service-worker update never interrupts a recording | Verified | `e2e/update.spec.ts`. |
| Installation guidance and Android APK | Unverified | APK built and signed; never installed on a phone here. |
| Grade 2–4 English scope | **Incomplete** | Only 2 of 6 starter stories are in scope (English Grade 2 and 3). Filters and learner grades offer Grades 1–6. Planned for stage 3 (nothing deleted). |
| Learner pages without a selected reader | **Fixed** | Explain and return, instead of silently redirecting. |
| Reading screen: passage space, Pause/Continue/Finish/Help | Verified (emulation) | Controls could be more compact on small phones (stage 3). |
| Word Coach discoverability | **Incomplete** | Only by tapping a word; no explicit button or long-press (stage 3). |
| Listen and Follow, narration highlighting | Verified (no-voice path); Unverified with voices | Word timing from speech-synthesis boundaries or recorded timings; sentence fallback is labelled. |
| Aligner: partial revisions, repeats, skips, substitutions, self-corrections, manual repositioning | Verified with transcript fixtures | Real children's speech unverified. |
| Final recognizer text after Pause/Finish | **Fixed** | It was dropped and left later words "tentative". |
| Recording lifecycle: one session, double taps, stale callbacks | Verified | |
| Leaving during the permission prompt | **Fixed** | The microphone stayed on and an orphaned attempt was saved. |
| Blocked-microphone recovery | **Fixed** | No repeated prompts; device-specific steps. |
| Recording vs recognition failure | **Fixed** | A recorder failure now says why; a recognizer failure is never blamed on the reader. |
| Assessment measures and honesty | Verified | CSV no longer exports unassessed attempts as zeros (fixed). Later on-device assessment of saved recordings: Missing. |
| Classes, enrollment, assignments, review queue, corrections, CSV | Verified in PGlite | Hosted unverified. |
| Gradebook: rubrics, draft/published grades, audited revisions | **Missing** | Stage 5. |
| Device-only reader → account linking | **Missing** | Still a documented limitation. Stage 4. |
| Vocabulary editor, review states, sync to devices | **Missing** | Draft/reviewed flag only; bundled list only. Stage 5. |
| Narration upload, preview, offline download | **Missing** | Player and data model exist. Stage 5. |
| Waveform from microphone input | **Missing** | Only a small level bar. Stage 3. |
| Pitch/rhythm feedback | Not implemented | Not claimed anywhere. Only if required, as experimental and outside grading. |
| Offline speech engines | Unverified | Vosk disabled by default; nothing benchmarked on devices. Filipino assessment off. |
| Offline storage and sync: atomic writes, op IDs, retries, auth expiry, conflicts | Verified (unit + PGlite) | Background sync only wakes an open app. |
| RLS, storage policies, no self-promotion, private audio | Verified in PGlite | Hosted unverified. |

## Plan

1. **Baseline**: deployed source identified, tests run, branch created. *Done.*
2. **Recording, navigation and assessment defects**: the fixes listed above. *Done
   on this branch* (see `docs/TESTING.md` for the tests).
3. **Mobile reading and word tracking**: compact reading controls; an explicit Word
   Coach button with long-press as a shortcut; a waveform drawn from the real
   microphone signal (not a score); Grade 2–4 English as the default path, with
   Grade 1, 5, 6 and Filipino content kept and labelled as outside it.
4. **Device-only reader linking**: a confirmed, resumable, server-authorized import of
   device-only readers into an account, with an explicit ID mapping. Needs an additive
   migration.
5. **Teacher tools**: versioned rubrics, draft/published grades with audited revisions,
   kept separate from rewards; vocabulary editor with draft/reviewed/published states
   and device sync; narration upload linked to exact story versions.
6. **Release readiness**: speech-engine benchmarks on target phones, accessibility pass,
   staging Supabase verification, release docs.

## Rollback

Stage 2 changes no database schema, migration, IndexedDB schema or sync payload shape.
New attempts carry `scoring_version = 'score-1.1.0'`, which the server stores as text.
To roll back, redeploy the previous build; attempts saved by this version stay valid
and readable by the old one.

Later stages that add migrations will each list their own rollback steps here before
they are deployed.
