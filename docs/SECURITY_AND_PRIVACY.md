# Security and privacy

## Authorization model (server)

Every table in `public` has Row Level Security enabled, and `anon` has no table or RPC
access. Authorization comes only from server-owned tables:

| Who | Can access | Source of truth |
|---|---|---|
| Guardian (or a learner's own account) | Learners they created | `learner_access` (rows written only by `create_learner`) |
| Teacher | Learners while they are **active** members of a class the teacher staffs | `class_staff` + `class_memberships.status = 'active'` |
| Teacher, pending request | Only the requesting learner's name and avatar | `has_pending_request_for` |
| Story editor | Their own stories, stories explicitly shared with them, or all stories with the `content_editor` role | `stories.owner_id`, `story_editors`, `user_roles` |
| Any signed-in user | Published library stories and shared vocabulary | `stories.visibility = 'library'` |

Key rules, each covered by `supabase/tests/security.test.ts`:

- **No self-promotion.** Roles live in `user_roles`, which has no write policy. Only
  `display_name` on `profiles` is updatable. Later changes to user metadata never grant
  roles.
- **No attaching to arbitrary learners.** `learner_access` has no insert policy.
  `create_learner` refuses an existing learner ID that belongs to someone else.
- **Class codes route requests; they grant nothing.**
  - `request_class_enrollment` only creates a *pending* request, for a learner the
    caller already looks after.
  - It returns only the class name, never the roster.
  - Codes live in `class_join_codes`, which only class staff can read.
  - Wrong codes are rate limited (10 per hour per user, audited).
- **Cross-class isolation.** Teachers see nothing from classes they do not staff, and
  removing a learner revokes the teacher's access.
- **Immutable records.** Reading sessions, assessments, word results, story versions,
  corrections, reviews and audit events cannot be edited or deleted through the API,
  and triggers block it even for the table owner. Corrections are appended, attributed
  and audited.
- **Optimistic concurrency.** A trigger forces story, assignment and class edits to
  move the revision from N to N + 1, so stale clients cannot overwrite silently.
  Grades and vocabulary entries carry a revision or version too. Their RPCs refuse a
  stale one.
- **Grades.**
  - Visible to staff of the class that gave them, never to other classes.
  - A learner's guardians see a grade only once it is **published**; drafts and the
    revision history stay with the class's teachers.
  - Only a teacher who teaches the learner, using a rubric of a class the learner is
    actively in, can grade.
  - Changing a published grade needs a reason. Every save is appended to an immutable
    history with the teacher and time, and audited.
  - The automated assessment is never changed by grading.
- **Vocabulary.** Teachers write drafts. Only content editors and admins verify
  syllables, review and publish. Every write leaves a revision row.
- **Narration.**
  - Only editors of a story can upload or register narration.
  - The server checks that the file exists at the exact story-version path and that
    any word timings fit that version.
  - Readers of the story read it through short-lived signed URLs (300 s).
- **Privileged operations** are security-definer functions with an empty `search_path`
  that re-check `auth.uid()`. Helper functions live in the unexposed `private` schema.
- **Idempotency.** Every sync RPC records its `op_id` in `processed_sync_ops`. Session
  IDs, award keys and word keys are unique.
- **Server-side validation.** Session payloads are bounds-checked, and word counts must
  match the story version. Coverage and CWPM are recomputed on the server, and audio
  upload status depends on the recording policy.

## Recordings

- Recording uploads are **off by default**. A recording is uploaded only when *both* of
  these hold:
  1. the adult on the device turned on "Share recordings with the teacher"; and
  2. the server allows it: a guardian gave consent for that learner
     (`set_learner_audio_consent`), or the learner is in a class whose teacher enabled
     uploads and the uploader staffs that class.
- Storage policies enforce the same rules. An upload must target
  `reading-audio/<learner_id>/<session_id>.<ext>` for an existing session of that
  learner. Recordings cannot be overwritten. Reading requires access to the learner.
- Teachers play recordings through **short-lived signed URLs** (120 s).
- An upload is reported complete only after `confirm_audio_upload` has verified the
  object exists.
- Retention follows the class setting (default 30 days). The
  `purge-expired-audio` Edge Function deletes expired files.
- Recordings on the device can be played back and deleted by the learner's adult at
  any time.

## Speech processing

On-device recognition is preferred. Browser cloud recognition sends the child's voice
to the browser vendor while reading, so it is off until an adult enables it and the
UI says so. No audio is ever uploaded as a silent fallback.

## Browser and device

- The microphone is requested only when the reader presses Start. If it has been
  blocked, the app shows how to allow it and does not request it again until the
  permission changes. Leaving the reading screen releases the microphone, including
  while the browser's permission prompt is still open.
- Only the project URL and the publishable key are used in the browser. Service-role
  or secret keys are detected and refused.
- Story text is rendered as text nodes; HTML in stories is shown literally. The
  production build adds a strict Content-Security-Policy.
- Local data is partitioned per identity. Sign-out shows unsynced items and offers
  "sync now", "keep on this device" or "delete from this device". Deleting with
  unsynced work requires typing DELETE.
- **Linking device-only readers into an account** never happens on sign-in by itself:
  - The Grown-ups page lists the readers and what each has. The adult picks readers,
    confirms the destination account and their relationship to the children.
  - The app asks the server (`auth.getUser`) to confirm that account is signed in.
  - IDs are kept. `create_learner` refuses an ID that belongs to another account; the
    reader then stays on the device, marked not synced.
  - Recordings stay on the device unless sharing is turned on and allowed.
  - An interrupted link resumes from a journal, without duplicates.
- The teacher **PIN** is a PBKDF2-SHA-256 hash (150,000 iterations, random salt) in the
  device's metadata DB. It only unlocks the local teacher screens; it is not a security
  boundary against someone who controls the device. Every server request still uses
  the signed-in session and RLS.
- **Offline access is not authorization.** Downloaded data stays readable offline, but
  every sync revalidates the session, the account identity and current learner access
  first.
- **Shared classroom devices** load only the roster of the chosen class, set up by a
  signed-in teacher who has set a PIN. Personal devices show only the account's own
  readers.

## Book import

- Book files (PDF, EPUB, text) are read in the teacher's browser; only the story text
  the teacher saves is sent to the server.
- PDF.js runs in a Web Worker with `isEvalSupported: false`, so it does not compile
  code from the PDF. EPUB scripts are discarded, and text is read only through the DOM
  text content, never inserted as HTML.
- Files over 50 MB, ZIP entries over 20 MB, and PDFs over 400 pages are refused.
- DRM-protected or password-protected books are refused rather than worked around.

## Data minimisation

- Learners need only a first name or nickname, an avatar and an optional grade.
- No ages, birthdays, photos or contact details are collected for children.
- Children do not need accounts.
