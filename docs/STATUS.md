# Project status, audit and plan

Last updated 2026-10-16. Work is on branches `enhance/stage-1-reliability` (stages 1–2)
and `enhance/stage-3-reading-ux` (stages 3–6, built on top). This file records what was
checked and how, so claims elsewhere in the docs can be traced.

"Verified" means verified by the named automated tests in emulated browsers or PGlite.
**Nothing has been verified on a physical phone or tablet, or against a staging Supabase
project.** Test results are in `docs/TESTING.md`.

## What is deployed

| Item | Finding |
|---|---|
| Repository | `github.com/seyjeyyy/tinigturo`. `main` = `06cdf4c`. The `origin` remote (`Sheshseyjey/tinigturo`) is one commit behind. |
| Production web app | `https://tinigturo-green.vercel.app`, deployed with the Vercel CLI from an **uncommitted working tree**: it served the Android download page, which was in no commit. That tree is now commit `247d76e`. **This work has not been deployed to production.** |
| Review deployments | Vercel **preview** deployments of the branches, behind Vercel Authentication. |
| Supabase | The production app and `.env.local` use the same hosted project. Migrations up to `20261015000400` are applied (checked read-only). **`20261016000100_teacher_tools.sql` is not applied.** No test data was written to production. |
| Android | A Trusted Web Activity APK (`com.tinigturo.app` 1.0.0) served at `/download/tinigturo.apk`. It is a shell around the website. See `docs/ANDROID.md`. |

## Requirement status

Classification:
- **Verified**: working and covered by tests here.
- **Unverified**: implemented, but not tested here.
- **Fixed**: was defective; fixed with tests.
- **Done**: was missing or incomplete; implemented with tests.
- **Incomplete**, **Missing**: as written.

| Area | Status | Notes |
|---|---|---|
| Mobile PWA shell: bottom nav, safe areas, touch targets, no sideways scroll | Verified (emulation) | Pixel 7 and 360×640 viewports. Real devices unverified. |
| Reading screen layout on phones | **Fixed** | At 360×640 the passage gets 482 px while recording (was 384 px), and the title is readable (was cut to "The …"). |
| Service-worker update never interrupts a recording | Verified | `e2e/update.spec.ts`. |
| Installation guidance by device | **Done** | APK offered only on Android. The APK was never installed on a phone here. |
| Grades 2–4 English scope | **Done** | Default learning path, out-of-path content kept and labelled (`docs/SCOPE.md`). Content gap: 2 in-path bundled stories, no Grade 4. |
| Learner pages without a selected reader | **Fixed** | Explain and return, instead of silently redirecting. |
| Word Coach discoverability | **Done** | Explicit button that pauses the reading; touch-and-hold shortcut; taps during recording no longer open a dialog. |
| Listen and Follow, narration highlighting | Verified (no-voice path) | Recorded narration highlights only with supplied timings; otherwise no highlighting, labelled. |
| Aligner: partial revisions, repeats, skips, substitutions, self-corrections, manual repositioning, recognizers that resend earlier text | Verified with transcript fixtures | Real children's speech unverified. |
| Recognizer's final text after Pause/Finish | **Fixed** | |
| Recording lifecycle and permission prompt | **Fixed** | Microphone no longer left on after leaving the screen; no orphaned attempts; blocked microphone not re-requested. |
| Recording vs recognition failure | **Fixed** | |
| Live waveform | **Done** | Drawn from the real microphone signal; display only; still bar with reduced motion. |
| Pitch/rhythm feedback | Not implemented | Not claimed anywhere. If required: experimental, outside grading, validated against reviewed recordings first. |
| Assessment measures and honesty | Verified | No zero scores for unassessed attempts in the CSV or the gradebook. Later on-device assessment of saved recordings: **Missing**. |
| Classes, enrollment, assignments, review queue, corrections, CSV | Verified in PGlite | Hosted unverified. |
| Gradebook: rubrics, draft/published grades, audited revisions, CSV | **Done** | Verified in PGlite (`supabase/tests/teacherTools.test.ts`). The UI has no automated test against a backend; it needs the staging check. |
| Device-only reader → account linking | **Done** | `src/data/linking.test.ts`; the hosted `create_learner` path needs the staging check. |
| Vocabulary editor, review states, device sync | **Done** | SQL in PGlite, device download in unit tests. Starter definitions are still unreviewed drafts. |
| Narration upload, preview, offline download | **Done** | SQL in PGlite, file and timing checks in unit tests. Upload against hosted Storage unverified. |
| Offline speech engines | Unverified | Vosk disabled by default; nothing benchmarked on devices. Filipino assessment off. |
| Offline storage and sync | Verified (unit + PGlite) | Background sync only wakes an open app. |
| RLS, storage policies, no self-promotion, private audio | Verified in PGlite | New tables locked down explicitly. Hosted unverified. |
| Accessibility (automated rules) | Verified | axe-core finds no serious or critical WCAG 2.1 A/AA violations on 12 student screens. A screen-reader pass is still needed. |

## Stages

1. **Baseline.** Deployed source identified, tests run, branch created. *Done.*
2. **Recording, navigation and assessment defects.** *Done.*
3. **Mobile reading and word tracking.** Compact controls, Word Coach button and
   shortcut, live waveform, Grade 2–4 path, device-aware install page. *Done.*
4. **Device-only reader linking.** *Done* (no migration needed).
5. **Teacher tools.** Gradebook, vocabulary workflow, narration upload. *Done* (migration
   `20261016000100_teacher_tools.sql`).
6. **Release readiness.** Automated accessibility checks, package check, release and
   scope docs. *Done in code.* Device benchmarks and the staging Supabase checks remain
   (below).

## Still needs verification (blocked here)

- **Staging Supabase.** Create a separate project and run every hosted check in
  `docs/TESTING.md`: email flows, enrollment, sync, linking, audio and narration
  uploads, signed-URL expiry, grades visibility across classes, retention. Blocked: the
  only project available is production.
- **Physical devices.** The manual checklist in `docs/TESTING.md` on a low-cost
  Android phone, an iPad and a Chromebook, including the APK install and microphone
  permission recovery.
- **Speech engines.** Benchmarks in `docs/SPEECH.md` on target phones, and accuracy
  against teacher-reviewed transcripts.
- **Content.** Educator review of the starter vocabulary and Filipino content. More
  Grade 2–4 English stories, especially Grade 4.

## Rollback

`docs/RELEASE.md` has the steps. In short:
- **Stages 2–4** change no database schema, IndexedDB schema or sync payload shape.
  Redeploying the previous web build is enough.
- **Stage 5's migration** only adds objects. The older web app ignores them. A full
  database rollback script, with data export first, is in `docs/RELEASE.md`.
