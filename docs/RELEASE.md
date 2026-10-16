# Release process

Tinig Turo has three parts that are released separately:

| Part | What a release changes | How it reaches users |
|---|---|---|
| Database (Supabase) | Tables, policies, functions (`supabase/migrations/`) | `npx supabase db push` against the project |
| Web app / PWA (Vercel) | Everything learners and teachers see | Installed apps show "A new version is ready → Update now"; it never applies during a recording |
| Android app (TWA) | Only the app shell: name, icon, version, package, trusted signing keys | A new APK must be built, distributed and installed (`docs/ANDROID.md`) |

A Vercel deploy does **not** update the installed Android package. It updates the web
app that the package shows.

## Order: database first, then the web app

The web app calls functions added by migrations. A frontend deployed before its
migration shows errors on the new screens (for example "Could not find the function
public.class_gradebook"). Always apply migrations first. They are additive, so the
current live app keeps working on the new schema.

### Pending migration in this branch

| Migration | What it adds | Needed by |
|---|---|---|
| `20261016000100_teacher_tools.sql` | Rubrics, grades and grade history; the vocabulary review workflow (adds `version`, `published_by`, `published_at`, `updated_by` and allows `published`); the revision log; story narration recordings | Grades and Rubrics tabs, grade panel, Word meanings editor, published vocabulary download, narration upload and download |

Stages 2–4 need no migration.

## Steps

1. **Staging first.** Create a separate Supabase project for staging; do not test on
   production data.
   1. `npx supabase link --project-ref <staging-ref>`, then `npx supabase db push`.
   2. Deploy a Vercel preview with the staging URL and key as Preview environment
      variables.
   3. Run the manual checks in `docs/TESTING.md` (accounts, enrollment, sync, uploads,
      signed URLs, grades, vocabulary, narration, linking).
2. **Automated checks:** `npm run check` (typecheck, unit/component/database tests,
   build, browser tests).
3. **Production database:** link the production project and run `npx supabase db push`.
   Read the plan it prints. It must list only the new migration file(s).
4. **Production web app:** deploy **from a commit**, so the live site can be traced to
   source:
   ```bash
   git status            # must be clean
   npx vercel deploy --prod
   ```
5. **Android:** rebuild only if the app shell changes (`docs/ANDROID.md`).
6. **Roles:** give reviewers the `content_editor` role (`docs/SUPABASE_SETUP.md`) so
   word meanings can be reviewed and published.

## Rollback

### Web app

Promote the previous deployment in Vercel, or redeploy the previous commit:

- Readings saved by the newer version (`score-1.1.0`) stay valid for the older one.
- Readers linked into accounts stay linked; the older version shows them as account
  readers.
- Teacher grades, vocabulary states and narrations stay in the database and are
  ignored by the older version.

### Database

`20261016000100_teacher_tools.sql` only adds objects. Prefer leaving it in place: the
older web app ignores the new tables. If it must be removed, first export the data you
want to keep:

```sql
copy (select * from public.session_grades) to stdout with csv header;
copy (select * from public.session_grade_revisions) to stdout with csv header;
```

Then, as the database owner, in this order:

```sql
drop function if exists public.class_gradebook(uuid), public.save_session_grade(uuid, uuid, jsonb, text, text, boolean, text, integer),
  public.create_grading_rubric(uuid, text, jsonb, jsonb, text, uuid), public.save_vocabulary_entry(uuid, text, text, text, text, text, text, text, boolean, integer),
  public.set_vocabulary_status(uuid, text, integer), public.register_story_narration(uuid, text, text, integer, integer, jsonb, text),
  public.retire_story_narration(uuid);
drop table if exists public.session_grade_revisions, public.session_grades, public.grading_rubrics, public.story_narrations, public.vocabulary_revisions;
drop trigger if exists vocabulary_entries_version on public.vocabulary_entries;
drop trigger if exists vocabulary_entries_revisions on public.vocabulary_entries;
update public.vocabulary_entries set review_status = 'reviewed' where review_status = 'published';
alter table public.vocabulary_entries drop constraint if exists vocabulary_entries_reviewer_check,
  drop constraint if exists vocabulary_entries_publisher_check, drop constraint if exists vocabulary_entries_review_status_check;
alter table public.vocabulary_entries add constraint vocabulary_entries_review_status_check check (review_status in ('draft', 'reviewed'));
```

The added vocabulary columns (`version`, `updated_by`, `published_by`, `published_at`)
can stay; the older app ignores them. Narration audio files in `story-assets` are not
deleted by this; remove them in the Storage dashboard if needed.

### Device data

No release in this branch changes the IndexedDB schema. Linking moves device readers
into the account partition on that device. It is not undone by a rollback, and it does
not need to be.
