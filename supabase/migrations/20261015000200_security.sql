-- Authorization helpers, Row Level Security, and table privileges.
--
-- Principles:
--  * Every exposed table has RLS enabled. anon gets no table access at all.
--  * Authorization is derived only from server-owned tables (user_roles,
--    learner_access, class_staff, class_memberships), never from user metadata.
--  * Writes that create relationships (learner access, enrollment, sessions,
--    awards) happen only through security-definer functions (next migration).
--  * Column-level grants restrict which columns direct updates may touch.

-- ---------------------------------------------------------------------------
-- Helper functions (security definer so they can read the access tables without
-- recursive RLS evaluation; they only ever answer about auth.uid()).
-- ---------------------------------------------------------------------------

create function private.has_role(p_role public.app_role) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.role = p_role
  );
$$;

create function private.is_class_staff(p_class_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.class_staff cs
    join public.classes c on c.id = cs.class_id
    where cs.class_id = p_class_id and cs.user_id = auth.uid()
  );
$$;

create function private.is_guardian_of(p_learner_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.learner_access la
    where la.learner_id = p_learner_id and la.user_id = auth.uid()
  );
$$;

-- A teacher can act for a learner only while the learner is an active member of a
-- class the teacher staffs.
create function private.teaches_learner(p_learner_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.class_memberships m
    join public.class_staff cs on cs.class_id = m.class_id
    where m.learner_id = p_learner_id and m.status = 'active' and cs.user_id = auth.uid()
  );
$$;

create function private.can_access_learner(p_learner_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_guardian_of(p_learner_id) or private.teaches_learner(p_learner_id);
$$;

-- Staff of a class with a pending request may see the requesting learner's name.
create function private.has_pending_request_for(p_learner_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.class_memberships m
    join public.class_staff cs on cs.class_id = m.class_id
    where m.learner_id = p_learner_id and m.status = 'pending' and cs.user_id = auth.uid()
  );
$$;

create function private.can_edit_story(p_story_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.stories s
    where s.id = p_story_id
      and (
        s.owner_id = auth.uid()
        or exists (select 1 from public.story_editors e where e.story_id = s.id and e.user_id = auth.uid())
        or private.has_role('content_editor')
        or private.has_role('admin')
      )
  );
$$;

-- Who may read a story:
--  * editors of the story;
--  * any signed-in user for published library stories;
--  * staff of, and guardians of active members of, a class the story is assigned to.
create function private.can_read_story(p_story_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.can_edit_story(p_story_id)
    or exists (
      select 1 from public.stories s
      where s.id = p_story_id and s.visibility = 'library' and s.status = 'published'
    )
    or exists (
      select 1 from public.assignments a
      where a.story_id = p_story_id and a.archived_at is null
        and (
          private.is_class_staff(a.class_id)
          or exists (
            select 1 from public.class_memberships m
            join public.learner_access la on la.learner_id = m.learner_id
            where m.class_id = a.class_id and m.status = 'active' and la.user_id = auth.uid()
          )
        )
    );
$$;

-- Versions are readable with their story, and also whenever the reader can see a
-- reading attempt that used the version (so history survives archiving).
create function private.can_read_story_version(p_version_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.story_versions v
    where v.id = p_version_id and private.can_read_story(v.story_id)
  )
  or exists (
    select 1 from public.reading_sessions rs
    where rs.story_version_id = p_version_id and private.can_access_learner(rs.learner_id)
  );
$$;

create function private.can_access_session(p_session_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.reading_sessions rs
    where rs.id = p_session_id and private.can_access_learner(rs.learner_id)
  );
$$;

create function private.can_review_session(p_session_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.reading_sessions rs
    where rs.id = p_session_id and private.teaches_learner(rs.learner_id)
  );
$$;

-- Recording uploads are allowed only under a recording policy: a guardian consented
-- for this learner, or the learner is in a class whose teacher enabled uploads and
-- the uploader staffs that class.
create function private.audio_upload_allowed(p_learner_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select (
      private.is_guardian_of(p_learner_id)
      and exists (select 1 from public.learners l where l.id = p_learner_id and l.audio_sharing_consent)
    )
    or exists (
      select 1
      from public.class_memberships m
      join public.classes c on c.id = m.class_id
      join public.class_staff cs on cs.class_id = c.id
      where m.learner_id = p_learner_id and m.status = 'active'
        and c.audio_upload_enabled and c.archived_at is null
        and cs.user_id = auth.uid()
    );
$$;

grant usage on schema private to authenticated;
revoke all on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated;

-- ---------------------------------------------------------------------------
-- Guard triggers
-- ---------------------------------------------------------------------------

-- Every story edit must advance revision by exactly one; a stale client loses.
create function private.enforce_revision() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.revision <> old.revision + 1 then
    raise exception 'revision must advance from % to %', old.revision, old.revision + 1
      using errcode = 'PT409';
  end if;
  return new;
end;
$$;

create trigger stories_revision before update of draft_title, draft_body, draft_summary, language, grade_level, topic, revision
  on public.stories for each row execute function private.enforce_revision();
create trigger assignments_revision before update of due_at, instructions, archived_at, revision
  on public.assignments for each row execute function private.enforce_revision();
create trigger classes_revision before update of name, grade_level, revision
  on public.classes for each row execute function private.enforce_revision();

-- Reading attempts are immutable. Only the audio columns and the review request may
-- change, and only from
-- security-definer functions (which run as the table owner).
create function private.protect_reading_session() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'reading sessions cannot be deleted' using errcode = 'PT403';
  end if;
  if (to_jsonb(new) - array['audio_status', 'audio_path', 'audio_mime', 'audio_bytes', 'audio_uploaded_at', 'audio_expires_at', 'review_requested'])
     is distinct from (to_jsonb(old) - array['audio_status', 'audio_path', 'audio_mime', 'audio_bytes', 'audio_uploaded_at', 'audio_expires_at', 'review_requested']) then
    raise exception 'reading sessions are immutable' using errcode = 'PT403';
  end if;
  return new;
end;
$$;

create trigger reading_sessions_immutable before update or delete on public.reading_sessions
  for each row execute function private.protect_reading_session();

create function private.protect_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '% rows are immutable', tg_table_name using errcode = 'PT403';
end;
$$;

create trigger story_versions_immutable before update or delete on public.story_versions
  for each row execute function private.protect_immutable();
create trigger assessments_immutable before update on public.session_assessments
  for each row execute function private.protect_immutable();
create trigger word_results_immutable before update on public.word_results
  for each row execute function private.protect_immutable();
create trigger corrections_immutable before update or delete on public.assessment_corrections
  for each row execute function private.protect_immutable();
create trigger reviews_immutable before update or delete on public.session_reviews
  for each row execute function private.protect_immutable();
create trigger audit_immutable before update or delete on public.audit_events
  for each row execute function private.protect_immutable();

-- Only content editors may put stories in the shared library.
create function private.guard_story_visibility() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.visibility = 'library' and (tg_op = 'INSERT' or old.visibility <> 'library')
     and auth.uid() is not null
     and not (private.has_role('content_editor') or private.has_role('admin')) then
    raise exception 'only content editors can publish to the library' using errcode = 'PT403';
  end if;
  return new;
end;
$$;

create trigger stories_visibility before insert or update of visibility on public.stories
  for each row execute function private.guard_story_visibility();

-- ---------------------------------------------------------------------------
-- Audit trail
-- ---------------------------------------------------------------------------

create function private.audit(
  p_action text, p_entity_type text, p_entity_id text,
  p_class_id uuid default null, p_learner_id uuid default null, p_details jsonb default '{}'::jsonb
) returns void
language sql security definer set search_path = '' as $$
  insert into public.audit_events (actor_id, action, entity_type, entity_id, class_id, learner_id, details)
  values (auth.uid(), p_action, p_entity_type, p_entity_id, p_class_id, p_learner_id, coalesce(p_details, '{}'::jsonb));
$$;

create function private.audit_trigger() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_row jsonb := to_jsonb(coalesce(new, old));
  v_id text := coalesce(v_row ->> 'id', v_row ->> 'session_id', concat_ws(':', v_row ->> 'class_id', v_row ->> 'learner_id', v_row ->> 'user_id'));
begin
  insert into public.audit_events (actor_id, action, entity_type, entity_id, class_id, learner_id, details)
  values (
    auth.uid(),
    lower(tg_op),
    tg_table_name,
    v_id,
    nullif(v_row ->> 'class_id', '')::uuid,
    nullif(v_row ->> 'learner_id', '')::uuid,
    case when tg_op = 'UPDATE' then jsonb_build_object('before', to_jsonb(old), 'after', to_jsonb(new)) else v_row end
  );
  return coalesce(new, old);
end;
$$;

create trigger audit_corrections after insert on public.assessment_corrections
  for each row execute function private.audit_trigger();
create trigger audit_reviews after insert on public.session_reviews
  for each row execute function private.audit_trigger();
create trigger audit_feedback after insert or update on public.teacher_feedback
  for each row execute function private.audit_trigger();
create trigger audit_memberships after insert or update on public.class_memberships
  for each row execute function private.audit_trigger();
create trigger audit_roles after insert or update or delete on public.user_roles
  for each row execute function private.audit_trigger();
create trigger audit_staff after insert or delete on public.class_staff
  for each row execute function private.audit_trigger();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;
alter table public.app_settings enable row level security;
alter table public.learners enable row level security;
alter table public.learner_access enable row level security;
alter table public.classes enable row level security;
alter table public.class_join_codes enable row level security;
alter table public.class_staff enable row level security;
alter table public.class_memberships enable row level security;
alter table public.stories enable row level security;
alter table public.story_versions enable row level security;
alter table public.story_editors enable row level security;
alter table public.assignments enable row level security;
alter table public.reading_sessions enable row level security;
alter table public.session_assessments enable row level security;
alter table public.word_results enable row level security;
alter table public.assessment_corrections enable row level security;
alter table public.teacher_feedback enable row level security;
alter table public.session_reviews enable row level security;
alter table public.vocabulary_entries enable row level security;
alter table public.learner_vocabulary enable row level security;
alter table public.badge_definitions enable row level security;
alter table public.badge_awards enable row level security;
alter table public.audit_events enable row level security;
alter table public.processed_sync_ops enable row level security;

-- profiles: own row only. Display name is the only updatable column.
create policy profiles_select_own on public.profiles for select to authenticated
  using (id = (select auth.uid()));
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- user_roles: a user can see their own roles. No one can write through the API.
create policy user_roles_select_own on public.user_roles for select to authenticated
  using (user_id = (select auth.uid()));

-- app_settings, processed_sync_ops: no policies -> no direct access.

-- learners
create policy learners_select on public.learners for select to authenticated
  using (private.can_access_learner(id) or private.has_pending_request_for(id));
create policy learners_update_guardian on public.learners for update to authenticated
  using (private.is_guardian_of(id) or private.teaches_learner(id))
  with check (private.is_guardian_of(id) or private.teaches_learner(id));

create policy learner_access_select_own on public.learner_access for select to authenticated
  using (user_id = (select auth.uid()));

-- classes: staff see their classes; guardians see classes their learner belongs to.
create policy classes_select on public.classes for select to authenticated
  using (
    private.is_class_staff(id)
    or exists (
      select 1 from public.class_memberships m
      where m.class_id = classes.id and m.status in ('active', 'pending') and private.is_guardian_of(m.learner_id)
    )
  );
create policy classes_update_staff on public.classes for update to authenticated
  using (private.is_class_staff(id)) with check (private.is_class_staff(id));

create policy join_codes_select_staff on public.class_join_codes for select to authenticated
  using (private.is_class_staff(class_id));

create policy class_staff_select on public.class_staff for select to authenticated
  using (private.is_class_staff(class_id));

create policy memberships_select on public.class_memberships for select to authenticated
  using (private.is_class_staff(class_id) or private.is_guardian_of(learner_id));

-- stories
create policy stories_select on public.stories for select to authenticated
  using (private.can_read_story(id));
create policy stories_insert on public.stories for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and status = 'draft'
    and published_version_id is null
    and (private.has_role('teacher') or private.has_role('content_editor') or private.has_role('admin'))
  );
create policy stories_update on public.stories for update to authenticated
  using (private.can_edit_story(id)) with check (private.can_edit_story(id));

create policy story_versions_select on public.story_versions for select to authenticated
  using (private.can_read_story_version(id));

create policy story_editors_select on public.story_editors for select to authenticated
  using (user_id = (select auth.uid()) or private.can_edit_story(story_id));

-- assignments
create policy assignments_select on public.assignments for select to authenticated
  using (
    private.is_class_staff(class_id)
    or exists (
      select 1 from public.class_memberships m
      where m.class_id = assignments.class_id and m.status = 'active' and private.is_guardian_of(m.learner_id)
    )
  );
create policy assignments_insert on public.assignments for insert to authenticated
  with check (
    private.is_class_staff(class_id)
    and created_by = (select auth.uid())
    and private.can_read_story(story_id)
    and exists (
      select 1 from public.story_versions v where v.id = story_version_id and v.story_id = assignments.story_id
    )
  );
create policy assignments_update on public.assignments for update to authenticated
  using (private.is_class_staff(class_id)) with check (private.is_class_staff(class_id));

-- reading attempts and results: read-only through the API.
create policy sessions_select on public.reading_sessions for select to authenticated
  using (private.can_access_learner(learner_id));
create policy assessments_select on public.session_assessments for select to authenticated
  using (private.can_access_session(session_id));
create policy word_results_select on public.word_results for select to authenticated
  using (private.can_access_session(session_id));
create policy corrections_select on public.assessment_corrections for select to authenticated
  using (private.can_access_session(session_id));

create policy reviews_select on public.session_reviews for select to authenticated
  using (private.can_access_session(session_id));

create policy feedback_select on public.teacher_feedback for select to authenticated
  using (private.can_access_learner(learner_id));
create policy feedback_insert on public.teacher_feedback for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and private.teaches_learner(learner_id)
    and (session_id is null or exists (
      select 1 from public.reading_sessions rs where rs.id = session_id and rs.learner_id = teacher_feedback.learner_id
    ))
  );
create policy feedback_update_author on public.teacher_feedback for update to authenticated
  using (author_id = (select auth.uid())) with check (author_id = (select auth.uid()));

-- vocabulary: shared reference content.
create policy vocabulary_select on public.vocabulary_entries for select to authenticated using (true);
create policy vocabulary_write on public.vocabulary_entries for all to authenticated
  using (private.has_role('content_editor') or private.has_role('admin'))
  with check (private.has_role('content_editor') or private.has_role('admin'));

create policy learner_vocab_select on public.learner_vocabulary for select to authenticated
  using (private.can_access_learner(learner_id));

create policy badges_select on public.badge_definitions for select to authenticated using (true);
create policy awards_select on public.badge_awards for select to authenticated
  using (private.can_access_learner(learner_id));

-- audit events: teachers see events for their classes; everyone sees their own.
create policy audit_select on public.audit_events for select to authenticated
  using (
    actor_id = (select auth.uid())
    or (class_id is not null and private.is_class_staff(class_id))
    or private.has_role('admin')
  );

-- ---------------------------------------------------------------------------
-- Table privileges. Supabase grants broad defaults; we narrow them explicitly.
-- ---------------------------------------------------------------------------

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on all tables in schema public to authenticated;
revoke select on public.app_settings, public.processed_sync_ops from authenticated;

grant update (display_name) on public.profiles to authenticated;
grant update (display_name, avatar, grade_level) on public.learners to authenticated;
grant update (name, grade_level, revision) on public.classes to authenticated;
grant insert (id, owner_id, visibility, draft_title, draft_body, draft_summary, language, grade_level, topic)
  on public.stories to authenticated;
grant update (draft_title, draft_body, draft_summary, language, grade_level, topic, revision)
  on public.stories to authenticated;
grant insert (class_id, story_id, story_version_id, instructions, due_at, created_by) on public.assignments to authenticated;
grant update (instructions, due_at, archived_at, revision) on public.assignments to authenticated;
grant insert (session_id, learner_id, author_id, body) on public.teacher_feedback to authenticated;
grant update (archived_at) on public.teacher_feedback to authenticated;
grant insert, update, delete on public.vocabulary_entries to authenticated;

-- Remove default execute on future functions for anon.
alter default privileges in schema public revoke execute on functions from public, anon;
