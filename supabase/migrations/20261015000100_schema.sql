-- Tinig Turo core schema.
-- All application tables live in `public` (exposed through the Data API) and have Row
-- Level Security enabled in the next migration. Helper functions live in `private`,
-- which is not exposed through the API.

create schema if not exists private;

-- ---------------------------------------------------------------------------
-- Identity and trusted roles
-- ---------------------------------------------------------------------------

create type public.app_role as enum ('teacher', 'content_editor', 'admin');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 80),
  -- The account type the person asked for at sign-up. It is informational only and is
  -- never used for authorization; trusted roles live in user_roles.
  requested_account_type text not null default 'guardian'
    check (requested_account_type in ('guardian', 'teacher')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.user_roles (
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.app_role not null,
  granted_by uuid references auth.users (id),
  granted_at timestamptz not null default now(),
  primary key (user_id, role)
);

-- Server-side settings, readable only by security-definer functions.
create table public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

insert into public.app_settings (key, value) values
  -- When true, someone who signs up as a teacher receives the teacher role. A teacher
  -- can only create their own classes and stories; it grants no access to anyone
  -- else's data. Set to false to require an admin to grant the role.
  ('teacher_self_signup', 'true'::jsonb);

-- ---------------------------------------------------------------------------
-- Learners and who may act for them
-- ---------------------------------------------------------------------------

create table public.learners (
  -- Client-generated so a learner created offline keeps the same ID when synced.
  id uuid primary key,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 40),
  avatar text not null check (avatar ~ '^[a-z_]{1,20}$'),
  grade_level smallint check (grade_level between 1 and 6),
  created_by uuid not null references auth.users (id),
  -- Whether a guardian has agreed to share this learner's recordings with teachers.
  audio_sharing_consent boolean not null default false,
  audio_consent_by uuid references auth.users (id),
  audio_consent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

-- Explicit user-to-learner access (guardians, or a learner's own account).
-- Rows are created only by security-definer functions; nobody can insert a row to
-- attach themselves to an arbitrary learner.
create table public.learner_access (
  user_id uuid not null references auth.users (id) on delete cascade,
  learner_id uuid not null references public.learners (id) on delete cascade,
  relation text not null check (relation in ('guardian', 'self')),
  granted_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  primary key (user_id, learner_id)
);
create index learner_access_learner_idx on public.learner_access (learner_id);

-- ---------------------------------------------------------------------------
-- Classes
-- ---------------------------------------------------------------------------

create table public.classes (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  grade_level smallint check (grade_level between 1 and 6),
  owner_id uuid not null references auth.users (id),
  -- Recording policy. Uploads are off unless the teacher enables them.
  audio_upload_enabled boolean not null default false,
  audio_retention_days integer not null default 30 check (audio_retention_days between 1 and 365),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create index classes_owner_idx on public.classes (owner_id);

-- Join codes are kept apart from classes so that people who can see a class (for
-- example a guardian of an enrolled learner) never see its code.
create table public.class_join_codes (
  class_id uuid primary key references public.classes (id) on delete cascade,
  code text not null unique check (code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.class_staff (
  class_id uuid not null references public.classes (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'co_teacher')),
  added_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  primary key (class_id, user_id)
);
create index class_staff_user_idx on public.class_staff (user_id);

-- Controlled enrollment: a request starts as pending and a teacher approves it.
create table public.class_memberships (
  class_id uuid not null references public.classes (id) on delete cascade,
  learner_id uuid not null references public.learners (id) on delete cascade,
  status text not null check (status in ('pending', 'active', 'declined', 'removed')),
  requested_by uuid references auth.users (id),
  decided_by uuid references auth.users (id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (class_id, learner_id)
);
create index class_memberships_learner_idx on public.class_memberships (learner_id) where status = 'active';
create index class_memberships_pending_idx on public.class_memberships (class_id) where status = 'pending';

-- ---------------------------------------------------------------------------
-- Stories and immutable versions
-- ---------------------------------------------------------------------------

create table public.stories (
  id uuid primary key default gen_random_uuid(),
  -- null for the shared starter library maintained by content editors.
  owner_id uuid references auth.users (id),
  visibility text not null default 'class' check (visibility in ('library', 'class')),
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  draft_title text not null check (char_length(btrim(draft_title)) between 1 and 120),
  draft_body text not null check (char_length(draft_body) between 1 and 20000),
  draft_summary text not null default '' check (char_length(draft_summary) <= 300),
  language text not null check (language in ('en', 'fil')),
  grade_level smallint not null check (grade_level between 1 and 6),
  topic text not null default '' check (char_length(topic) <= 40),
  -- Optimistic concurrency: every edit must move revision from N to N + 1.
  revision integer not null default 1 check (revision > 0),
  published_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create index stories_owner_idx on public.stories (owner_id);

create table public.story_versions (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.stories (id),
  version_number integer not null check (version_number > 0),
  title text not null check (char_length(title) between 1 and 120),
  body text not null check (char_length(body) between 1 and 20000),
  summary text not null default '',
  language text not null check (language in ('en', 'fil')),
  grade_level smallint not null check (grade_level between 1 and 6),
  topic text not null default '',
  tokenizer_version smallint not null check (tokenizer_version > 0),
  word_count integer not null check (word_count between 1 and 5000),
  content_sha256 text not null,
  narration_audio_path text,
  narration_timings jsonb,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  unique (story_id, version_number)
);

alter table public.stories
  add constraint stories_published_version_fk
  foreign key (published_version_id) references public.story_versions (id);

-- An explicitly granted right to edit someone else's story.
create table public.story_editors (
  story_id uuid not null references public.stories (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  granted_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  primary key (story_id, user_id)
);

create table public.assignments (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes (id) on delete cascade,
  story_id uuid not null references public.stories (id),
  -- Pinned to the exact version assigned, so later edits never change an assignment.
  story_version_id uuid not null references public.story_versions (id),
  instructions text not null default '' check (char_length(instructions) <= 300),
  due_at timestamptz,
  created_by uuid not null references auth.users (id),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create index assignments_class_idx on public.assignments (class_id);

-- ---------------------------------------------------------------------------
-- Reading attempts (immutable) and assessments
-- ---------------------------------------------------------------------------

create table public.reading_sessions (
  -- Client-generated; doubles as the idempotency key for retries.
  id uuid primary key,
  learner_id uuid not null references public.learners (id),
  story_version_id uuid not null references public.story_versions (id),
  assignment_id uuid references public.assignments (id),
  mode text not null check (mode in ('read_aloud', 'listen')),
  started_at timestamptz not null,
  ended_at timestamptz not null,
  local_day date not null,
  active_ms integer not null check (active_ms >= 0),
  paused_ms integer not null check (paused_ms >= 0),
  interrupted_ms integer not null check (interrupted_ms >= 0),
  assessed_ms integer not null check (assessed_ms >= 0),
  recognition_plan text not null check (recognition_plan in ('on_device', 'cloud', 'none')),
  transcript jsonb,
  review_requested boolean not null default false,
  recovered boolean not null default false,
  -- Audio upload is tracked separately from the session metadata.
  audio_status text not null default 'none'
    check (audio_status in ('none', 'local_only', 'pending', 'uploaded', 'deleted')),
  audio_path text,
  audio_mime text,
  audio_bytes integer,
  audio_uploaded_at timestamptz,
  audio_expires_at timestamptz,
  submitted_by uuid not null references auth.users (id),
  client_op_id uuid not null unique,
  created_at timestamptz not null default now(),
  check (ended_at >= started_at)
);
create index reading_sessions_learner_idx on public.reading_sessions (learner_id, started_at desc);
create index reading_sessions_assignment_idx on public.reading_sessions (assignment_id) where assignment_id is not null;
create index reading_sessions_audio_expiry_idx on public.reading_sessions (audio_expires_at) where audio_status = 'uploaded';

create table public.session_assessments (
  session_id uuid primary key references public.reading_sessions (id) on delete cascade,
  method text not null check (method in ('transcript_alignment_live', 'transcript_alignment_recording', 'none')),
  status text not null check (status in ('assessed', 'needs_review', 'unassessed')),
  completion text not null check (completion in ('complete', 'partial', 'unknown')),
  unassessed_reason text,
  review_reasons text[] not null default '{}',
  engine_id text,
  engine_version text,
  engine_processing text check (engine_processing in ('on_device', 'cloud')),
  scoring_version text not null,
  aligner_version text,
  normalizer_version integer,
  total_words integer not null check (total_words >= 0),
  evaluated_words integer not null check (evaluated_words >= 0),
  correct_words integer not null check (correct_words >= 0),
  self_corrected_words integer not null check (self_corrected_words >= 0),
  uncertain_words integer not null check (uncertain_words >= 0),
  substituted_words integer not null check (substituted_words >= 0),
  skipped_words integer not null check (skipped_words >= 0),
  unassessed_words integer not null check (unassessed_words >= 0),
  not_reached_words integer not null check (not_reached_words >= 0),
  insertions integer not null default 0 check (insertions >= 0),
  repetitions integer not null default 0 check (repetitions >= 0),
  coverage numeric(5, 4) not null check (coverage between 0 and 1),
  assessed_ms integer check (assessed_ms >= 0),
  cwpm numeric(6, 1) check (cwpm >= 0),
  created_at timestamptz not null default now(),
  check (evaluated_words <= total_words),
  check (correct_words <= evaluated_words),
  check (self_corrected_words <= correct_words)
);

-- Word-level outcomes are kept so teachers can review exactly which words were
-- uncertain or not matched, and to reproduce scores.
create table public.word_results (
  session_id uuid not null references public.reading_sessions (id) on delete cascade,
  word_index integer not null check (word_index >= 0),
  status text not null check (status in ('correct', 'self_corrected', 'uncertain', 'substituted', 'skipped', 'unassessed', 'not_reached')),
  heard text check (char_length(heard) <= 60),
  primary key (session_id, word_index)
);

-- Manual corrections never modify the machine assessment; they are appended.
create table public.assessment_corrections (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.reading_sessions (id) on delete cascade,
  word_index integer check (word_index >= 0),
  previous_status text,
  corrected_status text not null check (corrected_status in ('correct', 'self_corrected', 'uncertain', 'substituted', 'skipped', 'unassessed', 'not_reached')),
  reason text not null default '' check (char_length(reason) <= 300),
  corrected_by uuid not null references auth.users (id),
  created_at timestamptz not null default now()
);
create index assessment_corrections_session_idx on public.assessment_corrections (session_id, created_at);

-- A teacher marking an attempt as reviewed removes it from the review queue.
create table public.session_reviews (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.reading_sessions (id) on delete cascade,
  reviewer_id uuid not null references auth.users (id),
  note text not null default '' check (char_length(note) <= 300),
  created_at timestamptz not null default now()
);
create index session_reviews_session_idx on public.session_reviews (session_id);

create table public.teacher_feedback (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references public.reading_sessions (id) on delete cascade,
  learner_id uuid not null references public.learners (id) on delete cascade,
  author_id uuid not null references auth.users (id),
  body text not null check (char_length(btrim(body)) between 1 and 1000),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
create index teacher_feedback_learner_idx on public.teacher_feedback (learner_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Vocabulary
-- ---------------------------------------------------------------------------

create table public.vocabulary_entries (
  id uuid primary key default gen_random_uuid(),
  language text not null check (language in ('en', 'fil')),
  headword text not null check (char_length(headword) between 1 and 60),
  normalized text not null check (char_length(normalized) between 1 and 60),
  part_of_speech text,
  definition text not null check (char_length(definition) between 1 and 400),
  example text check (char_length(example) <= 300),
  syllables text check (char_length(syllables) <= 80),
  syllables_verified boolean not null default false,
  review_status text not null default 'draft' check (review_status in ('draft', 'reviewed')),
  reviewed_by uuid references auth.users (id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (language, normalized),
  check (syllables_verified = false or syllables is not null)
);

create table public.learner_vocabulary (
  id uuid primary key default gen_random_uuid(),
  learner_id uuid not null references public.learners (id) on delete cascade,
  language text not null check (language in ('en', 'fil')),
  word text not null check (char_length(word) between 1 and 60),
  normalized text not null check (char_length(normalized) between 1 and 60),
  vocabulary_entry_id uuid references public.vocabulary_entries (id),
  story_version_id uuid references public.story_versions (id),
  saved_at timestamptz not null,
  practice_count integer not null default 0 check (practice_count >= 0),
  last_practiced_at timestamptz,
  -- Tombstone: removal is synchronized, not lost.
  archived_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (learner_id, language, normalized)
);

-- ---------------------------------------------------------------------------
-- Rewards
-- ---------------------------------------------------------------------------

create table public.badge_definitions (
  code text primary key check (code ~ '^[a-z_]{1,40}$'),
  kind text not null check (kind in ('participation', 'performance')),
  title text not null,
  description text not null,
  active boolean not null default true
);

insert into public.badge_definitions (code, kind, title, description) values
  ('first_practice', 'participation', 'First Steps', 'Finished your first reading practice.'),
  ('practice_day', 'participation', 'Reading Day', 'Practiced reading on this day.'),
  ('three_days', 'participation', 'Three Reading Days', 'Practiced reading on 3 different days.'),
  ('seven_days', 'participation', 'Seven Reading Days', 'Practiced reading on 7 different days.'),
  ('word_collector', 'participation', 'Word Collector', 'Saved 5 words to My Words.'),
  ('story_finisher', 'performance', 'Story Finisher', 'Read a whole story aloud with word checking turned on.'),
  ('personal_best', 'performance', 'Personal Best', 'Read at least 3 more correct words per minute than your best on this story.');

create table public.badge_awards (
  id uuid primary key default gen_random_uuid(),
  learner_id uuid not null references public.learners (id) on delete cascade,
  badge_code text not null references public.badge_definitions (code),
  -- The unique event that earned the badge, e.g. "once", "day:2026-10-15",
  -- "story:<uuid>", "session:<uuid>". Prevents double awards on retry.
  source_key text not null check (char_length(source_key) <= 80),
  session_id uuid references public.reading_sessions (id) on delete set null,
  awarded_at timestamptz not null default now(),
  unique (learner_id, badge_code, source_key)
);

-- ---------------------------------------------------------------------------
-- Audit and synchronization bookkeeping
-- ---------------------------------------------------------------------------

create table public.audit_events (
  id bigint generated always as identity primary key,
  actor_id uuid,
  action text not null,
  entity_type text not null,
  entity_id text,
  class_id uuid,
  learner_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_events_entity_idx on public.audit_events (entity_type, entity_id);
create index audit_events_class_idx on public.audit_events (class_id, created_at desc) where class_id is not null;

-- Each client operation ID is processed once; retries get the stored result.
create table public.processed_sync_ops (
  op_id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  op_type text not null,
  entity_id uuid,
  result jsonb not null default '{}'::jsonb,
  processed_at timestamptz not null default now()
);
create index processed_sync_ops_user_idx on public.processed_sync_ops (user_id, processed_at desc);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

create function private.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_touch before update on public.profiles for each row execute function private.touch_updated_at();
create trigger learners_touch before update on public.learners for each row execute function private.touch_updated_at();
create trigger classes_touch before update on public.classes for each row execute function private.touch_updated_at();
create trigger memberships_touch before update on public.class_memberships for each row execute function private.touch_updated_at();
create trigger stories_touch before update on public.stories for each row execute function private.touch_updated_at();
create trigger assignments_touch before update on public.assignments for each row execute function private.touch_updated_at();
create trigger vocab_touch before update on public.vocabulary_entries for each row execute function private.touch_updated_at();
create trigger learner_vocab_touch before update on public.learner_vocabulary for each row execute function private.touch_updated_at();
