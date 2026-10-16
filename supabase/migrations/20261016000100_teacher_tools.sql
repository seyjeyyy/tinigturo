-- Teacher tools (2026-10-16):
--   1. grading rubrics and teacher-validated grades (draft -> published, audited revisions);
--   2. a vocabulary review workflow (draft -> reviewed -> published, versions, revision log);
--   3. recorded narration linked to exact story versions.
--
-- Additive and backward compatible: new tables, functions, policies, and new columns with
-- defaults. The only changed constraint widens vocabulary_entries.review_status to allow
-- 'published'; every existing row stays valid. Nothing is deleted or rewritten.
-- Rollback steps: docs/STATUS.md ("Rollback").

-- ===========================================================================
-- 1. Grading rubrics and grades
-- ===========================================================================

-- A rubric is defined by the school or teacher. The app ships no official criteria,
-- weights or benchmarks. Each version is immutable; a new version retires the previous
-- one for new grades, and existing grades keep the version they used.
create table public.grading_rubrics (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes (id),
  family_id uuid not null,
  version integer not null check (version > 0),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  description text not null default '' check (char_length(description) <= 500),
  -- [{ "key": "accuracy", "label": "Accuracy", "levels": [{ "value": 1, "label": "Beginning" }, ...] }, ...]
  criteria jsonb not null check (jsonb_typeof(criteria) = 'array'),
  -- Allowed final grades, e.g. ["Beginning", "Developing", "Proficient", "Advanced"].
  final_levels jsonb not null check (jsonb_typeof(final_levels) = 'array'),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  unique (family_id, version)
);
create index grading_rubrics_class_idx on public.grading_rubrics (class_id);

-- One grade per attempt per class. The automated assessment is never changed: it stays
-- in session_assessments; the grade is the teacher's own judgement.
create table public.session_grades (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.reading_sessions (id),
  learner_id uuid not null references public.learners (id),
  class_id uuid not null references public.classes (id),
  rubric_id uuid not null references public.grading_rubrics (id),
  status text not null check (status in ('draft', 'published')),
  criterion_levels jsonb not null default '{}'::jsonb check (jsonb_typeof(criterion_levels) = 'object'),
  final_level text check (char_length(final_level) <= 40),
  feedback text not null default '' check (char_length(feedback) <= 1000),
  revision integer not null default 1 check (revision > 0),
  graded_by uuid not null references auth.users (id),
  graded_at timestamptz not null default now(),
  published_by uuid references auth.users (id),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  unique (session_id, class_id),
  check (status = 'draft' or (final_level is not null and published_by is not null and published_at is not null))
);
create index session_grades_class_idx on public.session_grades (class_id);
create index session_grades_learner_idx on public.session_grades (learner_id);

-- Every save is kept: who changed what, when and why.
create table public.session_grade_revisions (
  id uuid primary key default gen_random_uuid(),
  grade_id uuid not null references public.session_grades (id),
  session_id uuid not null,
  revision integer not null,
  status text not null,
  rubric_id uuid not null,
  criterion_levels jsonb not null,
  final_level text,
  feedback text not null,
  reason text not null default '' check (char_length(reason) <= 300),
  changed_by uuid not null references auth.users (id),
  changed_at timestamptz not null default now(),
  unique (grade_id, revision)
);

create function private.valid_rubric(p_criteria jsonb, p_final_levels jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  c jsonb;
  l jsonb;
  v_keys text[] := '{}';
  v_values int[];
  v_labels text[] := '{}';
begin
  if jsonb_typeof(p_criteria) is distinct from 'array' or jsonb_array_length(p_criteria) not between 1 and 10 then return false; end if;
  for c in select value from jsonb_array_elements(p_criteria) loop
    if jsonb_typeof(c) is distinct from 'object' or coalesce(c ->> 'key', '') !~ '^[a-z0-9_]{1,30}$' or (c ->> 'key') = any (v_keys) then return false; end if;
    if char_length(btrim(coalesce(c ->> 'label', ''))) not between 1 and 60 then return false; end if;
    if jsonb_typeof(c -> 'levels') is distinct from 'array' or jsonb_array_length(c -> 'levels') not between 2 and 6 then return false; end if;
    v_values := '{}';
    for l in select value from jsonb_array_elements(c -> 'levels') loop
      if jsonb_typeof(l -> 'value') is distinct from 'number' then return false; end if;
      if (l ->> 'value')::numeric <> trunc((l ->> 'value')::numeric) or (l ->> 'value')::int = any (v_values) then return false; end if;
      if char_length(btrim(coalesce(l ->> 'label', ''))) not between 1 and 40 then return false; end if;
      v_values := v_values || (l ->> 'value')::int;
    end loop;
    v_keys := v_keys || (c ->> 'key');
  end loop;
  if jsonb_typeof(p_final_levels) is distinct from 'array' or jsonb_array_length(p_final_levels) not between 1 and 10 then return false; end if;
  for l in select value from jsonb_array_elements(p_final_levels) loop
    if jsonb_typeof(l) is distinct from 'string' or char_length(btrim(l #>> '{}')) not between 1 and 40 or (l #>> '{}') = any (v_labels) then return false; end if;
    v_labels := v_labels || (l #>> '{}');
  end loop;
  return true;
end;
$$;

-- Rubric versions are immutable; only retiring is allowed.
create function private.protect_rubric() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'rubric versions cannot be deleted' using errcode = 'PT403';
  end if;
  if (to_jsonb(new) - 'retired_at') is distinct from (to_jsonb(old) - 'retired_at')
     or (old.retired_at is not null and new.retired_at is distinct from old.retired_at) then
    raise exception 'rubric versions are immutable' using errcode = 'PT403';
  end if;
  return new;
end;
$$;
create trigger grading_rubrics_immutable before update or delete on public.grading_rubrics
  for each row execute function private.protect_rubric();
create trigger grade_revisions_immutable before update or delete on public.session_grade_revisions
  for each row execute function private.protect_immutable();

create function public.create_grading_rubric(
  p_class_id uuid, p_name text, p_criteria jsonb, p_final_levels jsonb,
  p_description text default '', p_family_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_user();
  v_family uuid := coalesce(p_family_id, gen_random_uuid());
  v_version integer;
  v_id uuid;
begin
  if not private.is_class_staff(p_class_id) then
    raise exception 'only staff of this class can manage its rubrics' using errcode = 'PT403';
  end if;
  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 80 or char_length(coalesce(p_description, '')) > 500 then
    raise exception 'rubric name or description is not valid' using errcode = 'PT422';
  end if;
  if not private.valid_rubric(p_criteria, p_final_levels) then
    raise exception 'rubric criteria or final levels are not valid' using errcode = 'PT422';
  end if;
  if p_family_id is not null and not exists (
    select 1 from public.grading_rubrics where family_id = p_family_id and class_id = p_class_id
  ) then
    raise exception 'rubric not found in this class' using errcode = 'PT404';
  end if;
  select coalesce(max(version), 0) + 1 into v_version from public.grading_rubrics where family_id = v_family;
  update public.grading_rubrics set retired_at = now() where family_id = v_family and retired_at is null;
  insert into public.grading_rubrics (class_id, family_id, version, name, description, criteria, final_levels, created_by)
  values (p_class_id, v_family, v_version, btrim(p_name), coalesce(p_description, ''), p_criteria, p_final_levels, v_uid)
  returning id into v_id;
  perform private.audit('rubric_version_created', 'grading_rubric', v_id::text, p_class_id, null,
    jsonb_build_object('family_id', v_family, 'version', v_version));
  return jsonb_build_object('id', v_id, 'family_id', v_family, 'version', v_version);
end;
$$;

-- Saves a draft or published grade for one attempt. A stale client is refused
-- (expected revision), a published grade can only change with a reason, and every save
-- is appended to session_grade_revisions.
create function public.save_session_grade(
  p_session_id uuid, p_rubric_id uuid, p_criterion_levels jsonb, p_final_level text, p_feedback text,
  p_publish boolean, p_reason text default '', p_expected_revision integer default 0
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_user();
  v_learner uuid;
  v_rubric public.grading_rubrics%rowtype;
  v_grade public.session_grades%rowtype;
  v_levels jsonb := coalesce(p_criterion_levels, '{}'::jsonb);
  v_key text;
  v_complete boolean := true;
  v_publish boolean;
  c jsonb;
begin
  select learner_id into v_learner from public.reading_sessions where id = p_session_id;
  if v_learner is null or not private.can_review_session(p_session_id) then
    raise exception 'only a teacher of this learner can grade this attempt' using errcode = 'PT403';
  end if;
  select * into v_rubric from public.grading_rubrics where id = p_rubric_id;
  if not found or not private.is_class_staff(v_rubric.class_id) then
    raise exception 'this rubric is not available' using errcode = 'PT403';
  end if;
  if not exists (
    select 1 from public.class_memberships m
    where m.class_id = v_rubric.class_id and m.learner_id = v_learner and m.status = 'active'
  ) then
    raise exception 'the learner is not in this rubric''s class' using errcode = 'PT403';
  end if;
  if jsonb_typeof(v_levels) <> 'object' or char_length(coalesce(p_feedback, '')) > 1000 or char_length(coalesce(p_reason, '')) > 300 then
    raise exception 'grade details are not valid' using errcode = 'PT422';
  end if;
  for v_key in select jsonb_object_keys(v_levels) loop
    if not exists (
      select 1 from jsonb_array_elements(v_rubric.criteria) cr
      where cr ->> 'key' = v_key
        and exists (select 1 from jsonb_array_elements(cr -> 'levels') lv where lv -> 'value' = v_levels -> v_key)
    ) then
      raise exception 'level for "%" is not part of this rubric', v_key using errcode = 'PT422';
    end if;
  end loop;
  for c in select value from jsonb_array_elements(v_rubric.criteria) loop
    if not (v_levels ? (c ->> 'key')) then v_complete := false; end if;
  end loop;
  if p_final_level is not null and not (v_rubric.final_levels @> to_jsonb(p_final_level)) then
    raise exception 'final grade is not one of this rubric''s levels' using errcode = 'PT422';
  end if;

  select * into v_grade from public.session_grades where session_id = p_session_id and class_id = v_rubric.class_id for update;
  if found then
    if v_grade.revision <> coalesce(p_expected_revision, -1) then
      raise exception 'this grade was changed by someone else' using errcode = 'PT409';
    end if;
    if v_grade.status = 'published' and char_length(btrim(coalesce(p_reason, ''))) = 0 then
      raise exception 'a reason is required to change a published grade' using errcode = 'PT422';
    end if;
  elsif coalesce(p_expected_revision, 0) <> 0 then
    raise exception 'this grade was changed by someone else' using errcode = 'PT409';
  end if;
  -- Once published, a grade stays published; revisions keep it complete.
  v_publish := coalesce(p_publish, false) or (found and v_grade.status = 'published');
  if v_publish and (not v_complete or p_final_level is null) then
    raise exception 'every criterion and the final grade are needed to publish' using errcode = 'PT422';
  end if;

  if v_grade.id is not null then
    update public.session_grades set
      rubric_id = p_rubric_id, criterion_levels = v_levels, final_level = p_final_level,
      feedback = coalesce(p_feedback, ''), status = case when v_publish then 'published' else 'draft' end,
      revision = v_grade.revision + 1, graded_by = v_uid, graded_at = now(),
      published_by = case when v_publish and v_grade.status <> 'published' then v_uid else v_grade.published_by end,
      published_at = case when v_publish and v_grade.status <> 'published' then now() else v_grade.published_at end
    where id = v_grade.id
    returning * into v_grade;
  else
    insert into public.session_grades (
      session_id, learner_id, class_id, rubric_id, status, criterion_levels, final_level, feedback,
      revision, graded_by, published_by, published_at
    ) values (
      p_session_id, v_learner, v_rubric.class_id, p_rubric_id, case when v_publish then 'published' else 'draft' end,
      v_levels, p_final_level, coalesce(p_feedback, ''), 1, v_uid,
      case when v_publish then v_uid end, case when v_publish then now() end
    )
    returning * into v_grade;
  end if;

  insert into public.session_grade_revisions (
    grade_id, session_id, revision, status, rubric_id, criterion_levels, final_level, feedback, reason, changed_by
  ) values (
    v_grade.id, p_session_id, v_grade.revision, v_grade.status, v_grade.rubric_id, v_grade.criterion_levels,
    v_grade.final_level, v_grade.feedback, coalesce(p_reason, ''), v_uid
  );
  perform private.audit(case when v_grade.status = 'published' then 'grade_published' else 'grade_draft_saved' end,
    'session_grade', v_grade.id::text, v_grade.class_id, v_grade.learner_id,
    jsonb_build_object('session_id', p_session_id, 'revision', v_grade.revision, 'reason', coalesce(p_reason, '')));
  return jsonb_build_object('id', v_grade.id, 'revision', v_grade.revision, 'status', v_grade.status);
end;
$$;

-- Attempts and grades for one class (RLS still applies). Word measures of unassessed
-- attempts are returned as null, never 0.
create function public.class_gradebook(p_class_id uuid)
returns table (
  session_id uuid, learner_id uuid, learner_name text, story_title text, started_at timestamptz,
  assessment_status text, completion text, coverage numeric, cwpm numeric,
  grade_id uuid, grade_status text, final_level text, criterion_levels jsonb, feedback text,
  rubric_id uuid, rubric_name text, rubric_version integer, graded_at timestamptz, published_at timestamptz, revision integer
)
language sql stable security invoker set search_path = '' as $$
  select rs.id, l.id, l.display_name, sv.title, rs.started_at,
    sa.status, sa.completion,
    case when sa.status = 'unassessed' then null else sa.coverage end,
    case when sa.status = 'unassessed' then null else sa.cwpm end,
    g.id, g.status, g.final_level, g.criterion_levels, g.feedback,
    r.id, r.name, r.version, g.graded_at, g.published_at, g.revision
  from public.class_memberships m
  join public.learners l on l.id = m.learner_id
  join public.reading_sessions rs on rs.learner_id = l.id and rs.mode = 'read_aloud'
  join public.story_versions sv on sv.id = rs.story_version_id
  left join public.session_assessments sa on sa.session_id = rs.id
  left join public.session_grades g on g.session_id = rs.id and g.class_id = p_class_id
  left join public.grading_rubrics r on r.id = g.rubric_id
  where m.class_id = p_class_id and m.status = 'active' and private.is_class_staff(p_class_id)
  order by l.display_name, rs.started_at desc
  limit 5000;
$$;

alter table public.grading_rubrics enable row level security;
alter table public.session_grades enable row level security;
alter table public.session_grade_revisions enable row level security;

-- Staff of the class see its rubrics; a family sees a rubric only through a published grade.
create policy rubrics_select on public.grading_rubrics for select to authenticated
  using (
    private.is_class_staff(class_id)
    or exists (
      select 1 from public.session_grades g
      where g.rubric_id = grading_rubrics.id and g.status = 'published' and private.is_guardian_of(g.learner_id)
    )
  );
-- Grades are visible to staff of the grading class only (never across classes), and to
-- the learner's guardians once published. Drafts stay with the teacher.
create policy grades_select on public.session_grades for select to authenticated
  using (private.is_class_staff(class_id) or (status = 'published' and private.is_guardian_of(learner_id)));
create policy grade_revisions_select on public.session_grade_revisions for select to authenticated
  using (exists (select 1 from public.session_grades g where g.id = grade_id and private.is_class_staff(g.class_id)));

-- ===========================================================================
-- 2. Vocabulary review workflow
-- ===========================================================================

do $$
declare
  v_name text;
begin
  select conname into v_name from pg_constraint
  where conrelid = 'public.vocabulary_entries'::regclass and contype = 'c'
    and pg_get_constraintdef(oid) like '%review_status%' and pg_get_constraintdef(oid) like '%draft%';
  if v_name is not null then
    execute format('alter table public.vocabulary_entries drop constraint %I', v_name);
  end if;
end;
$$;

alter table public.vocabulary_entries
  add constraint vocabulary_entries_review_status_check check (review_status in ('draft', 'reviewed', 'published')),
  add column version integer not null default 1 check (version > 0),
  add column updated_by uuid references auth.users (id),
  add column published_by uuid references auth.users (id),
  add column published_at timestamptz;

-- New and changed rows must name their reviewer and publisher (existing rows untouched).
alter table public.vocabulary_entries
  add constraint vocabulary_entries_reviewer_check
    check (review_status = 'draft' or reviewed_by is not null) not valid,
  add constraint vocabulary_entries_publisher_check
    check (review_status <> 'published' or (published_by is not null and published_at is not null)) not valid;

create table public.vocabulary_revisions (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.vocabulary_entries (id) on delete cascade,
  version integer not null,
  action text not null,
  snapshot jsonb not null,
  changed_by uuid references auth.users (id),
  changed_at timestamptz not null default now()
);
create index vocabulary_revisions_entry_idx on public.vocabulary_revisions (entry_id, version);

create function private.vocabulary_versioning() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.version := old.version + 1;
  new.updated_by := auth.uid();
  return new;
end;
$$;
create trigger vocabulary_entries_version before update on public.vocabulary_entries
  for each row execute function private.vocabulary_versioning();

-- Every write, including direct SQL by content editors, leaves a revision.
create function private.vocabulary_revision_log() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.vocabulary_revisions (entry_id, version, action, snapshot, changed_by)
  values (new.id, new.version, lower(tg_op), to_jsonb(new), auth.uid());
  return new;
end;
$$;
create trigger vocabulary_entries_revisions after insert or update on public.vocabulary_entries
  for each row execute function private.vocabulary_revision_log();
create trigger vocabulary_revisions_immutable before update on public.vocabulary_revisions
  for each row execute function private.protect_immutable();

-- Teachers write drafts; content editors (and admins) may also edit reviewed or
-- published entries and are the only ones who can mark syllables as verified. Any
-- content change needs review again.
create function public.save_vocabulary_entry(
  p_id uuid, p_language text, p_headword text, p_normalized text, p_part_of_speech text,
  p_definition text, p_example text, p_syllables text, p_syllables_verified boolean,
  p_expected_version integer default 0
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_user();
  v_editor boolean := private.has_role('content_editor') or private.has_role('admin');
  v_entry public.vocabulary_entries%rowtype;
  v_syllables text := nullif(btrim(coalesce(p_syllables, '')), '');
  v_verified boolean;
begin
  if not (v_editor or private.has_role('teacher')) then
    raise exception 'only teachers and content editors can edit word meanings' using errcode = 'PT403';
  end if;
  if p_language not in ('en', 'fil')
     or p_normalized is null or p_normalized <> lower(p_normalized) or p_normalized ~ '\s'
     or char_length(p_normalized) not between 1 and 60
     or char_length(btrim(coalesce(p_headword, ''))) not between 1 and 60
     or char_length(btrim(coalesce(p_definition, ''))) not between 1 and 400
     or char_length(coalesce(p_example, '')) > 300 or char_length(coalesce(v_syllables, '')) > 80 then
    raise exception 'word details are not valid' using errcode = 'PT422';
  end if;
  v_verified := coalesce(p_syllables_verified, false) and v_editor and v_syllables is not null;

  if p_id is null then
    begin
      insert into public.vocabulary_entries (
        language, headword, normalized, part_of_speech, definition, example, syllables, syllables_verified, review_status, updated_by
      ) values (
        p_language, btrim(p_headword), p_normalized, nullif(btrim(coalesce(p_part_of_speech, '')), ''), btrim(p_definition),
        nullif(btrim(coalesce(p_example, '')), ''), v_syllables, v_verified, 'draft', v_uid
      )
      returning * into v_entry;
    exception when unique_violation then
      raise exception 'this word already has an entry; edit that entry instead' using errcode = 'PT409';
    end;
  else
    select * into v_entry from public.vocabulary_entries where id = p_id for update;
    if not found then
      raise exception 'word entry not found' using errcode = 'PT404';
    end if;
    if v_entry.version <> coalesce(p_expected_version, -1) then
      raise exception 'this entry was changed by someone else' using errcode = 'PT409';
    end if;
    if not v_editor and v_entry.review_status <> 'draft' then
      raise exception 'only a content editor can change a reviewed or published entry' using errcode = 'PT403';
    end if;
    update public.vocabulary_entries set
      language = p_language, headword = btrim(p_headword), normalized = p_normalized,
      part_of_speech = nullif(btrim(coalesce(p_part_of_speech, '')), ''), definition = btrim(p_definition),
      example = nullif(btrim(coalesce(p_example, '')), ''), syllables = v_syllables, syllables_verified = v_verified,
      review_status = 'draft', reviewed_by = null, reviewed_at = null, published_by = null, published_at = null
    where id = p_id
    returning * into v_entry;
  end if;
  return jsonb_build_object('id', v_entry.id, 'version', v_entry.version, 'review_status', v_entry.review_status);
end;
$$;

-- draft -> reviewed -> published, or back to draft. Content editors and admins only.
create function public.set_vocabulary_status(p_id uuid, p_status text, p_expected_version integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_user();
  v_entry public.vocabulary_entries%rowtype;
begin
  if not (private.has_role('content_editor') or private.has_role('admin')) then
    raise exception 'only a content editor can review or publish word meanings' using errcode = 'PT403';
  end if;
  select * into v_entry from public.vocabulary_entries where id = p_id for update;
  if not found then
    raise exception 'word entry not found' using errcode = 'PT404';
  end if;
  if v_entry.version <> coalesce(p_expected_version, -1) then
    raise exception 'this entry was changed by someone else' using errcode = 'PT409';
  end if;
  if p_status = 'reviewed' and v_entry.review_status = 'draft' then
    update public.vocabulary_entries set review_status = 'reviewed', reviewed_by = v_uid, reviewed_at = now()
    where id = p_id returning * into v_entry;
  elsif p_status = 'published' and v_entry.review_status = 'reviewed' then
    update public.vocabulary_entries set review_status = 'published', published_by = v_uid, published_at = now()
    where id = p_id returning * into v_entry;
  elsif p_status = 'draft' and v_entry.review_status <> 'draft' then
    update public.vocabulary_entries set review_status = 'draft', reviewed_by = null, reviewed_at = null,
      published_by = null, published_at = null
    where id = p_id returning * into v_entry;
  else
    raise exception 'an entry goes from draft to reviewed to published' using errcode = 'PT422';
  end if;
  return jsonb_build_object('id', v_entry.id, 'version', v_entry.version, 'review_status', v_entry.review_status);
end;
$$;

alter table public.vocabulary_revisions enable row level security;
create policy vocabulary_revisions_select on public.vocabulary_revisions for select to authenticated
  using (private.has_role('teacher') or private.has_role('content_editor') or private.has_role('admin'));

-- ===========================================================================
-- 3. Recorded narration for exact story versions
-- ===========================================================================

-- Audio lives in story-assets/<story_id>/narration/<story_version_id>/<id>.<ext>.
-- Word timings are optional and only stored when supplied with the recording; the app
-- never estimates them.
create table public.story_narrations (
  id uuid primary key default gen_random_uuid(),
  story_version_id uuid not null references public.story_versions (id),
  story_id uuid not null references public.stories (id),
  audio_path text not null unique,
  mime_type text not null check (mime_type in ('audio/mpeg', 'audio/mp4', 'audio/webm', 'audio/ogg')),
  size_bytes integer not null check (size_bytes between 1 and 10485760),
  duration_ms integer check (duration_ms between 1 and 3600000),
  timings jsonb check (timings is null or jsonb_typeof(timings) = 'array'),
  timings_source text check (timings_source is null or timings_source = 'uploaded_file'),
  note text not null default '' check (char_length(note) <= 200),
  status text not null default 'active' check (status in ('active', 'retired')),
  uploaded_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  check ((timings is null) = (timings_source is null))
);
create unique index story_narrations_one_active on public.story_narrations (story_version_id) where status = 'active';

-- Timings: [{ "w": word index, "s": start ms, "e": end ms }], words in reading order.
create function private.valid_narration_timings(p_timings jsonb, p_word_count integer, p_duration_ms integer) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  t jsonb;
  v_prev_w integer := -1;
  v_prev_s integer := -1;
begin
  if p_timings is null then return true; end if;
  if jsonb_typeof(p_timings) <> 'array' or jsonb_array_length(p_timings) not between 1 and p_word_count then return false; end if;
  for t in select value from jsonb_array_elements(p_timings) loop
    if jsonb_typeof(t -> 'w') is distinct from 'number' or jsonb_typeof(t -> 's') is distinct from 'number'
       or jsonb_typeof(t -> 'e') is distinct from 'number' then return false; end if;
    if (t ->> 'w')::numeric <> trunc((t ->> 'w')::numeric) or (t ->> 'w')::int not between 0 and p_word_count - 1 then return false; end if;
    if (t ->> 'w')::int <= v_prev_w or (t ->> 's')::numeric < 0 or (t ->> 's')::numeric < v_prev_s
       or (t ->> 'e')::numeric <= (t ->> 's')::numeric then return false; end if;
    if p_duration_ms is not null and (t ->> 'e')::numeric > p_duration_ms + 500 then return false; end if;
    v_prev_w := (t ->> 'w')::int;
    v_prev_s := (t ->> 's')::numeric;
  end loop;
  return true;
end;
$$;

create function public.register_story_narration(
  p_story_version_id uuid, p_path text, p_mime_type text, p_size_bytes integer,
  p_duration_ms integer default null, p_timings jsonb default null, p_note text default ''
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_user();
  v_story uuid;
  v_words integer;
  v_id uuid;
begin
  select story_id, word_count into v_story, v_words from public.story_versions where id = p_story_version_id;
  if v_story is null then
    raise exception 'story version not found' using errcode = 'PT404';
  end if;
  if not private.can_edit_story(v_story) then
    raise exception 'only an editor of this story can add narration' using errcode = 'PT403';
  end if;
  if p_path !~ ('^' || v_story::text || '/narration/' || p_story_version_id::text || '/[0-9a-f-]{36}\.(mp3|m4a|webm|ogg)$') then
    raise exception 'narration path does not match this story version' using errcode = 'PT422';
  end if;
  if not exists (select 1 from storage.objects where bucket_id = 'story-assets' and name = p_path) then
    raise exception 'upload the recording before registering it' using errcode = 'PT409';
  end if;
  if not private.valid_narration_timings(p_timings, v_words, p_duration_ms) then
    raise exception 'word timings are not valid for this story version' using errcode = 'PT422';
  end if;
  update public.story_narrations set status = 'retired' where story_version_id = p_story_version_id and status = 'active';
  insert into public.story_narrations (
    story_version_id, story_id, audio_path, mime_type, size_bytes, duration_ms, timings, timings_source, note, uploaded_by
  ) values (
    p_story_version_id, v_story, p_path, p_mime_type, p_size_bytes, p_duration_ms, p_timings,
    case when p_timings is null then null else 'uploaded_file' end, coalesce(p_note, ''), v_uid
  )
  returning id into v_id;
  perform private.audit('narration_registered', 'story_version', p_story_version_id::text, null, null,
    jsonb_build_object('narration_id', v_id, 'timings', p_timings is not null));
  return v_id;
end;
$$;

create function public.retire_story_narration(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_story uuid;
begin
  perform private.require_user();
  select story_id into v_story from public.story_narrations where id = p_id;
  if v_story is null or not private.can_edit_story(v_story) then
    raise exception 'only an editor of this story can remove narration' using errcode = 'PT403';
  end if;
  update public.story_narrations set status = 'retired' where id = p_id;
  perform private.audit('narration_retired', 'story_narration', p_id::text);
end;
$$;

alter table public.story_narrations enable row level security;
create policy narrations_select on public.story_narrations for select to authenticated
  using (private.can_read_story_version(story_version_id));

-- ===========================================================================
-- Privileges: new tables are read-only through the API; writes go through the RPCs.
-- (Supabase grants broad defaults on new tables; narrow them explicitly.)
-- ===========================================================================

revoke all on public.grading_rubrics, public.session_grades, public.session_grade_revisions,
  public.vocabulary_revisions, public.story_narrations from anon, authenticated;
grant select on public.grading_rubrics, public.session_grades, public.session_grade_revisions,
  public.vocabulary_revisions, public.story_narrations to authenticated;

revoke execute on function
  public.create_grading_rubric(uuid, text, jsonb, jsonb, text, uuid),
  public.save_session_grade(uuid, uuid, jsonb, text, text, boolean, text, integer),
  public.class_gradebook(uuid),
  public.save_vocabulary_entry(uuid, text, text, text, text, text, text, text, boolean, integer),
  public.set_vocabulary_status(uuid, text, integer),
  public.register_story_narration(uuid, text, text, integer, integer, jsonb, text),
  public.retire_story_narration(uuid)
from public, anon;
grant execute on function
  public.create_grading_rubric(uuid, text, jsonb, jsonb, text, uuid),
  public.save_session_grade(uuid, uuid, jsonb, text, text, boolean, text, integer),
  public.class_gradebook(uuid),
  public.save_vocabulary_entry(uuid, text, text, text, text, text, text, text, boolean, integer),
  public.set_vocabulary_status(uuid, text, integer),
  public.register_story_narration(uuid, text, text, integer, integer, jsonb, text),
  public.retire_story_narration(uuid)
to authenticated;

revoke execute on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated;
