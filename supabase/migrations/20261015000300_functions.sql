-- Privileged operations, exposed as RPCs. Each one:
--  * runs as security definer with an empty search_path (all names qualified);
--  * re-checks authorization against auth.uid() itself;
--  * is idempotent: sync operations carry a client op_id recorded in
--    processed_sync_ops, and entity IDs are client-generated with unique constraints.
--
-- Error codes (PostgREST maps PTxxx to HTTP status xxx):
--   PT401 not signed in, PT403 forbidden, PT404 not found, PT409 conflict,
--   PT422 invalid input, PT429 too many requests.

-- ---------------------------------------------------------------------------
-- Sign-up: create the profile. The teacher role is granted only when the server
-- setting allows self sign-up. Later edits to user metadata never change roles.
-- ---------------------------------------------------------------------------

create function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_type text := coalesce(new.raw_user_meta_data ->> 'account_type', 'guardian');
  v_self_signup boolean;
begin
  if v_type not in ('guardian', 'teacher') then
    v_type := 'guardian';
  end if;
  insert into public.profiles (id, display_name, requested_account_type)
  values (new.id, left(coalesce(new.raw_user_meta_data ->> 'display_name', ''), 80), v_type)
  on conflict (id) do nothing;

  select coalesce((s.value #>> '{}')::boolean, false) into v_self_signup
  from public.app_settings s where s.key = 'teacher_self_signup';

  if v_type = 'teacher' and coalesce(v_self_signup, false) then
    insert into public.user_roles (user_id, role) values (new.id, 'teacher') on conflict do nothing;
  end if;
  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

create function private.require_user() returns uuid
language plpgsql stable set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'sign in required' using errcode = 'PT401';
  end if;
  return v_uid;
end;
$$;

-- Serializes work on one op id and returns its stored result when already processed.
create function private.begin_op(p_op_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_result jsonb;
  v_owner uuid;
begin
  if p_op_id is null then
    raise exception 'op_id is required' using errcode = 'PT422';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_op_id::text, 0));
  select result, user_id into v_result, v_owner from public.processed_sync_ops where op_id = p_op_id;
  if found and v_owner <> auth.uid() then
    raise exception 'operation id already used' using errcode = 'PT409';
  end if;
  return v_result;
end;
$$;

create function private.finish_op(p_op_id uuid, p_type text, p_entity uuid, p_result jsonb) returns jsonb
language sql security definer set search_path = '' as $$
  insert into public.processed_sync_ops (op_id, user_id, op_type, entity_id, result)
  values (p_op_id, auth.uid(), p_type, p_entity, p_result)
  on conflict (op_id) do nothing;
  select p_result;
$$;

create function private.new_join_code() returns text
language plpgsql volatile set search_path = '' as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_bytes bytea := uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid());
  v_code text := '';
  v_positions constant int[] := array[0, 1, 2, 3, 4, 5, 16, 17];
  v_i int;
begin
  -- Bytes 6 and 8 of a v4 UUID carry version/variant bits, so only random bytes are used.
  foreach v_i in array v_positions loop
    v_code := v_code || substr(v_alphabet, (get_byte(v_bytes, v_i) % 32) + 1, 1);
  end loop;
  return v_code;
end;
$$;

create function private.awards_json(p_learner_id uuid, p_source_keys text[]) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'badge_code', b.badge_code, 'source_key', b.source_key,
    'session_id', b.session_id, 'awarded_at', b.awarded_at
  ) order by b.awarded_at), '[]'::jsonb)
  from public.badge_awards b
  where b.learner_id = p_learner_id and b.source_key = any (p_source_keys);
$$;

-- Server-side mirror of src/rewards/rules.ts.
create function private.evaluate_session_awards(p_session_id uuid) returns text[]
language plpgsql security definer set search_path = '' as $$
declare
  s record;
  a record;
  v_days int;
  v_prior_best numeric;
  v_keys text[];
begin
  select rs.*, sv.story_id into s
  from public.reading_sessions rs join public.story_versions sv on sv.id = rs.story_version_id
  where rs.id = p_session_id;
  select * into a from public.session_assessments where session_id = p_session_id;

  v_keys := array['once', 'day:' || to_char(s.local_day, 'YYYY-MM-DD'), 'story:' || s.story_id::text, 'session:' || s.id::text];

  insert into public.badge_awards (learner_id, badge_code, source_key, session_id)
  values (s.learner_id, 'first_practice', 'once', s.id),
         (s.learner_id, 'practice_day', 'day:' || to_char(s.local_day, 'YYYY-MM-DD'), s.id)
  on conflict (learner_id, badge_code, source_key) do nothing;

  select count(distinct local_day) into v_days from public.reading_sessions where learner_id = s.learner_id;
  if v_days >= 3 then
    insert into public.badge_awards (learner_id, badge_code, source_key, session_id)
    values (s.learner_id, 'three_days', 'once', s.id) on conflict do nothing;
  end if;
  if v_days >= 7 then
    insert into public.badge_awards (learner_id, badge_code, source_key, session_id)
    values (s.learner_id, 'seven_days', 'once', s.id) on conflict do nothing;
  end if;

  -- Performance awards need an assessed, complete read-aloud attempt.
  if s.mode = 'read_aloud' and a.status = 'assessed' and a.completion = 'complete' and a.cwpm is not null then
    insert into public.badge_awards (learner_id, badge_code, source_key, session_id)
    values (s.learner_id, 'story_finisher', 'story:' || s.story_id::text, s.id) on conflict do nothing;

    select max(a2.cwpm) into v_prior_best
    from public.reading_sessions r2
    join public.session_assessments a2 on a2.session_id = r2.id
    where r2.learner_id = s.learner_id and r2.story_version_id = s.story_version_id
      and r2.id <> s.id and r2.started_at < s.started_at and r2.mode = 'read_aloud'
      and a2.status = 'assessed' and a2.completion = 'complete' and a2.cwpm is not null;

    if v_prior_best is not null and a.cwpm >= v_prior_best + 3 then
      insert into public.badge_awards (learner_id, badge_code, source_key, session_id)
      values (s.learner_id, 'personal_best', 'session:' || s.id::text, s.id) on conflict do nothing;
    end if;
  end if;
  return v_keys;
end;
$$;

-- ---------------------------------------------------------------------------
-- Access summary (used by the client to revalidate before syncing)
-- ---------------------------------------------------------------------------

create function public.my_access() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_user();
begin
  return jsonb_build_object(
    'user_id', v_uid,
    'roles', coalesce((select jsonb_agg(role) from public.user_roles where user_id = v_uid), '[]'::jsonb),
    'guardian_learner_ids', coalesce((select jsonb_agg(learner_id) from public.learner_access where user_id = v_uid), '[]'::jsonb),
    'taught_learner_ids', coalesce((
      select jsonb_agg(distinct m.learner_id)
      from public.class_memberships m join public.class_staff cs on cs.class_id = m.class_id
      where cs.user_id = v_uid and m.status = 'active'
    ), '[]'::jsonb),
    'staff_class_ids', coalesce((select jsonb_agg(class_id) from public.class_staff where user_id = v_uid), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Learners
-- ---------------------------------------------------------------------------

create function public.create_learner(
  p_op_id uuid, p_learner_id uuid, p_display_name text, p_avatar text, p_grade_level smallint default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_user();
  v_prev jsonb := private.begin_op(p_op_id);
  v_owner uuid;
begin
  if v_prev is not null then return v_prev; end if;

  insert into public.learners (id, display_name, avatar, grade_level, created_by)
  values (p_learner_id, btrim(p_display_name), p_avatar, p_grade_level, v_uid)
  on conflict (id) do nothing;

  select created_by into v_owner from public.learners where id = p_learner_id;
  -- An existing learner ID can never be claimed by someone else.
  if v_owner <> v_uid or exists (
    select 1 from public.learner_access where learner_id = p_learner_id and user_id <> v_uid
  ) then
    raise exception 'learner id is not available' using errcode = 'PT403';
  end if;

  insert into public.learner_access (user_id, learner_id, relation, granted_by)
  values (v_uid, p_learner_id, 'guardian', v_uid)
  on conflict do nothing;

  return private.finish_op(p_op_id, 'learner.create', p_learner_id, jsonb_build_object('learner_id', p_learner_id));
end;
$$;

create function public.set_learner_audio_consent(p_learner_id uuid, p_consent boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_user();
begin
  if not private.is_guardian_of(p_learner_id) then
    raise exception 'only a guardian can change recording consent' using errcode = 'PT403';
  end if;
  update public.learners
  set audio_sharing_consent = p_consent, audio_consent_by = v_uid, audio_consent_at = now()
  where id = p_learner_id;
  perform private.audit('audio_consent_changed', 'learner', p_learner_id::text, null, p_learner_id,
    jsonb_build_object('consent', p_consent));
end;
$$;

create function public.archive_learner(p_learner_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_user();
  if not private.is_guardian_of(p_learner_id) then
    raise exception 'only a guardian can archive this learner' using errcode = 'PT403';
  end if;
  update public.learners set archived_at = coalesce(archived_at, now()) where id = p_learner_id;
  perform private.audit('learner_archived', 'learner', p_learner_id::text, null, p_learner_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Classes and controlled enrollment
-- ---------------------------------------------------------------------------

create function public.create_class(p_name text, p_grade_level smallint default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_user();
  v_class_id uuid;
  v_code text;
  v_attempt int := 0;
begin
  if not (private.has_role('teacher') or private.has_role('admin')) then
    raise exception 'a teacher role is required to create classes' using errcode = 'PT403';
  end if;
  insert into public.classes (name, grade_level, owner_id) values (btrim(p_name), p_grade_level, v_uid)
  returning id into v_class_id;
  insert into public.class_staff (class_id, user_id, role, added_by) values (v_class_id, v_uid, 'owner', v_uid);
  loop
    v_attempt := v_attempt + 1;
    v_code := private.new_join_code();
    begin
      insert into public.class_join_codes (class_id, code) values (v_class_id, v_code);
      exit;
    exception when unique_violation then
      if v_attempt > 5 then raise; end if;
    end;
  end loop;
  perform private.audit('class_created', 'class', v_class_id::text, v_class_id);
  return jsonb_build_object('class_id', v_class_id, 'join_code', v_code);
end;
$$;

create function public.regenerate_join_code(p_class_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_code text;
begin
  perform private.require_user();
  if not private.is_class_staff(p_class_id) then
    raise exception 'not a teacher of this class' using errcode = 'PT403';
  end if;
  loop
    v_code := private.new_join_code();
    begin
      update public.class_join_codes set code = v_code, created_at = now() where class_id = p_class_id;
      exit;
    exception when unique_violation then
      null;
    end;
  end loop;
  perform private.audit('join_code_regenerated', 'class', p_class_id::text, p_class_id);
  return v_code;
end;
$$;

create function public.set_join_code_enabled(p_class_id uuid, p_enabled boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_user();
  if not private.is_class_staff(p_class_id) then
    raise exception 'not a teacher of this class' using errcode = 'PT403';
  end if;
  update public.class_join_codes set enabled = p_enabled where class_id = p_class_id;
  perform private.audit('join_code_enabled_changed', 'class', p_class_id::text, p_class_id, null,
    jsonb_build_object('enabled', p_enabled));
end;
$$;

create function public.set_class_recording_policy(
  p_class_id uuid, p_audio_upload_enabled boolean, p_retention_days integer
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_user();
  if not private.is_class_staff(p_class_id) then
    raise exception 'not a teacher of this class' using errcode = 'PT403';
  end if;
  update public.classes
  set audio_upload_enabled = p_audio_upload_enabled, audio_retention_days = p_retention_days
  where id = p_class_id;
  perform private.audit('recording_policy_changed', 'class', p_class_id::text, p_class_id, null,
    jsonb_build_object('audio_upload_enabled', p_audio_upload_enabled, 'retention_days', p_retention_days));
end;
$$;

-- A guardian asks for their learner to join a class. The class code only routes the
-- request; it reveals nothing about the roster and grants no access by itself.
create function public.request_class_enrollment(p_join_code text, p_learner_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_user();
  v_recent int;
  v_class record;
  v_status text;
begin
  if not private.is_guardian_of(p_learner_id) then
    raise exception 'you can only enroll learners you look after' using errcode = 'PT403';
  end if;

  select count(*) into v_recent from public.audit_events
  where actor_id = v_uid and action = 'enrollment_request' and created_at > now() - interval '1 hour';
  if v_recent >= 10 then
    raise exception 'too many attempts, try again later' using errcode = 'PT429';
  end if;

  select c.id, c.name into v_class
  from public.class_join_codes j join public.classes c on c.id = j.class_id
  where j.code = upper(btrim(p_join_code)) and j.enabled and c.archived_at is null;

  -- Recorded even when the code is wrong so guessing is rate limited.
  perform private.audit('enrollment_request', 'class', v_class.id::text, v_class.id, p_learner_id,
    jsonb_build_object('matched', v_class.id is not null));

  if v_class.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  insert into public.class_memberships (class_id, learner_id, status, requested_by)
  values (v_class.id, p_learner_id, 'pending', v_uid)
  on conflict (class_id, learner_id) do update
    set status = case when public.class_memberships.status in ('declined', 'removed') then 'pending'
                      else public.class_memberships.status end,
        requested_by = excluded.requested_by
  returning status into v_status;

  return jsonb_build_object('status', v_status, 'class_id', v_class.id, 'class_name', v_class.name);
end;
$$;

create function public.decide_enrollment(p_class_id uuid, p_learner_id uuid, p_approve boolean) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_user();
  v_status text;
begin
  if not private.is_class_staff(p_class_id) then
    raise exception 'not a teacher of this class' using errcode = 'PT403';
  end if;
  update public.class_memberships
  set status = case when p_approve then 'active' else 'declined' end, decided_by = v_uid, decided_at = now()
  where class_id = p_class_id and learner_id = p_learner_id and status = 'pending'
  returning status into v_status;
  if v_status is null then
    raise exception 'no pending request for this learner' using errcode = 'PT404';
  end if;
  return v_status;
end;
$$;

create function public.remove_class_member(p_class_id uuid, p_learner_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_user();
begin
  if not private.is_class_staff(p_class_id) then
    raise exception 'not a teacher of this class' using errcode = 'PT403';
  end if;
  update public.class_memberships set status = 'removed', decided_by = v_uid, decided_at = now()
  where class_id = p_class_id and learner_id = p_learner_id;
end;
$$;

-- A teacher adds a roster learner for use on a trusted classroom device. The teacher
-- gets access through the class membership, not through learner_access.
create function public.teacher_add_learner(
  p_class_id uuid, p_learner_id uuid, p_display_name text, p_avatar text, p_grade_level smallint default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_user();
  v_owner uuid;
begin
  if not private.is_class_staff(p_class_id) then
    raise exception 'not a teacher of this class' using errcode = 'PT403';
  end if;
  insert into public.learners (id, display_name, avatar, grade_level, created_by)
  values (p_learner_id, btrim(p_display_name), p_avatar, p_grade_level, v_uid)
  on conflict (id) do nothing;
  select created_by into v_owner from public.learners where id = p_learner_id;
  if v_owner <> v_uid then
    raise exception 'learner id is not available' using errcode = 'PT403';
  end if;
  insert into public.class_memberships (class_id, learner_id, status, requested_by, decided_by, decided_at)
  values (p_class_id, p_learner_id, 'active', v_uid, v_uid, now())
  on conflict (class_id, learner_id) do update set status = 'active', decided_by = v_uid, decided_at = now();
  return jsonb_build_object('learner_id', p_learner_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Stories
-- ---------------------------------------------------------------------------

create function public.publish_story(
  p_story_id uuid, p_expected_revision integer, p_tokenizer_version smallint, p_word_count integer
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_user();
  s record;
  v_hash text;
  v_latest record;
  v_version_id uuid;
  v_number int;
begin
  if not private.can_edit_story(p_story_id) then
    raise exception 'you cannot publish this story' using errcode = 'PT403';
  end if;
  select * into s from public.stories where id = p_story_id for update;
  if s.revision <> p_expected_revision then
    raise exception 'the story changed since you opened it' using errcode = 'PT409';
  end if;
  if s.archived_at is not null then
    raise exception 'restore the story before publishing' using errcode = 'PT409';
  end if;
  if p_word_count is null or p_word_count < 1 or p_word_count > 5000 then
    raise exception 'invalid word count' using errcode = 'PT422';
  end if;

  v_hash := encode(sha256(convert_to(s.draft_title || E'\n' || s.draft_body, 'UTF8')), 'hex');
  select * into v_latest from public.story_versions where story_id = p_story_id order by version_number desc limit 1;

  if v_latest.id is not null and v_latest.content_sha256 = v_hash and v_latest.tokenizer_version = p_tokenizer_version
     and v_latest.language = s.language and v_latest.grade_level = s.grade_level and v_latest.topic = s.topic
     and v_latest.summary = s.draft_summary then
    v_version_id := v_latest.id;
    v_number := v_latest.version_number;
  else
    v_number := coalesce(v_latest.version_number, 0) + 1;
    insert into public.story_versions (
      story_id, version_number, title, body, summary, language, grade_level, topic,
      tokenizer_version, word_count, content_sha256, created_by
    ) values (
      p_story_id, v_number, s.draft_title, s.draft_body, s.draft_summary, s.language, s.grade_level, s.topic,
      p_tokenizer_version, p_word_count, v_hash, v_uid
    ) returning id into v_version_id;
  end if;

  update public.stories set status = 'published', published_version_id = v_version_id where id = p_story_id;
  perform private.audit('story_published', 'story', p_story_id::text, null, null,
    jsonb_build_object('version_id', v_version_id, 'version_number', v_number));
  return jsonb_build_object('version_id', v_version_id, 'version_number', v_number);
end;
$$;

create function public.archive_story(p_story_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_user();
  if not private.can_edit_story(p_story_id) then
    raise exception 'you cannot archive this story' using errcode = 'PT403';
  end if;
  update public.stories set status = 'archived', archived_at = coalesce(archived_at, now()) where id = p_story_id;
  perform private.audit('story_archived', 'story', p_story_id::text);
end;
$$;

create function public.restore_story(p_story_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_user();
  if not private.can_edit_story(p_story_id) then
    raise exception 'you cannot restore this story' using errcode = 'PT403';
  end if;
  update public.stories
  set status = case when published_version_id is null then 'draft' else 'published' end, archived_at = null
  where id = p_story_id;
  perform private.audit('story_restored', 'story', p_story_id::text);
end;
$$;

-- ---------------------------------------------------------------------------
-- Reading sessions (idempotent, immutable)
-- ---------------------------------------------------------------------------

create function public.submit_reading_session(p_op_id uuid, p_session jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_user();
  v_prev jsonb := private.begin_op(p_op_id);
  v_id uuid := (p_session ->> 'id')::uuid;
  v_learner uuid := (p_session ->> 'learner_id')::uuid;
  v_version uuid := (p_session ->> 'story_version_id')::uuid;
  v_assignment uuid := nullif(p_session ->> 'assignment_id', '')::uuid;
  v_mode text := p_session ->> 'mode';
  v_started timestamptz := (p_session ->> 'started_at')::timestamptz;
  v_ended timestamptz := (p_session ->> 'ended_at')::timestamptz;
  v_active int := (p_session ->> 'active_ms')::int;
  v_assessed int := (p_session ->> 'assessed_ms')::int;
  a jsonb := p_session -> 'assessment';
  v_status text := a ->> 'status';
  v_total int := (a ->> 'total_words')::int;
  v_correct int := coalesce((a ->> 'correct_words')::int, 0);
  v_self int := coalesce((a ->> 'self_corrected_words')::int, 0);
  v_uncertain int := coalesce((a ->> 'uncertain_words')::int, 0);
  v_substituted int := coalesce((a ->> 'substituted_words')::int, 0);
  v_skipped int := coalesce((a ->> 'skipped_words')::int, 0);
  v_unassessed int := coalesce((a ->> 'unassessed_words')::int, 0);
  v_not_reached int := coalesce((a ->> 'not_reached_words')::int, 0);
  v_assessment_ms int := (a ->> 'assessed_ms')::int;
  v_evaluated int;
  v_coverage numeric;
  v_cwpm numeric;
  v_completion text;
  v_word_count int;
  v_audio text := coalesce(p_session ->> 'audio_status', 'none');
  v_words jsonb := coalesce(p_session -> 'word_results', '[]'::jsonb);
  v_existing_learner uuid;
  v_keys text[];
  v_result jsonb;
begin
  if v_prev is not null then return v_prev; end if;

  -- A retry with a new op id but the same session id is also a duplicate.
  select learner_id into v_existing_learner from public.reading_sessions where id = v_id;
  if found then
    if not private.can_access_learner(v_existing_learner) then
      raise exception 'not authorized for this learner' using errcode = 'PT403';
    end if;
    v_keys := private.evaluate_session_awards(v_id);
    v_result := jsonb_build_object('session_id', v_id, 'duplicate', true,
      'awards', private.awards_json(v_existing_learner, v_keys));
    return private.finish_op(p_op_id, 'session.submit', v_id, v_result);
  end if;

  if not private.can_access_learner(v_learner) then
    raise exception 'not authorized for this learner' using errcode = 'PT403';
  end if;

  select word_count into v_word_count from public.story_versions where id = v_version;
  if not found then
    raise exception 'unknown story version' using errcode = 'PT422';
  end if;

  if v_assignment is not null and not exists (
    select 1 from public.assignments asg
    join public.class_memberships m on m.class_id = asg.class_id and m.learner_id = v_learner and m.status = 'active'
    where asg.id = v_assignment and asg.story_version_id = v_version
  ) then
    raise exception 'assignment does not match this learner and story' using errcode = 'PT422';
  end if;

  if v_mode not in ('read_aloud', 'listen') then
    raise exception 'invalid mode' using errcode = 'PT422';
  end if;
  if v_started > now() + interval '1 day' or v_ended < v_started or v_ended - v_started > interval '6 hours' then
    raise exception 'invalid session times' using errcode = 'PT422';
  end if;
  if v_active > extract(epoch from (v_ended - v_started)) * 1000 + 60000 or v_assessed > v_active + 1000 then
    raise exception 'invalid session durations' using errcode = 'PT422';
  end if;

  -- Validate the assessment. Coverage and CWPM are recomputed here, not trusted.
  if v_status = 'unassessed' then
    if v_correct + v_self + v_uncertain + v_substituted + v_skipped + v_unassessed + v_not_reached <> 0 then
      raise exception 'an unassessed attempt cannot carry word results' using errcode = 'PT422';
    end if;
    v_evaluated := 0;
    v_coverage := 0;
    v_cwpm := null;
    v_completion := 'unknown';
    v_assessment_ms := null;
  elsif v_status in ('assessed', 'needs_review') then
    if v_total <> v_word_count then
      raise exception 'word count does not match the story version' using errcode = 'PT422';
    end if;
    if v_correct + v_uncertain + v_substituted + v_skipped + v_unassessed + v_not_reached <> v_total
       or v_self > v_correct then
      raise exception 'word counts are inconsistent' using errcode = 'PT422';
    end if;
    if v_assessment_ms is null or v_assessment_ms > v_assessed + 1000 then
      raise exception 'invalid assessed time' using errcode = 'PT422';
    end if;
    v_evaluated := v_correct + v_uncertain + v_substituted + v_skipped;
    v_coverage := round(v_evaluated::numeric / greatest(v_total, 1), 4);
    v_completion := case when v_coverage >= 0.95 then 'complete' else 'partial' end;
    v_cwpm := case when v_assessment_ms >= 10000 then round(v_correct / (v_assessment_ms / 60000.0), 1) end;
  else
    raise exception 'invalid assessment status' using errcode = 'PT422';
  end if;

  if jsonb_typeof(v_words) <> 'array' or jsonb_array_length(v_words) > v_total then
    raise exception 'invalid word results' using errcode = 'PT422';
  end if;
  if jsonb_array_length(v_words) > 0 and (
    select count(*) from jsonb_array_elements(v_words) w where w ->> 's' in ('correct', 'self_corrected')
  ) <> v_correct then
    raise exception 'word results do not match the summary' using errcode = 'PT422';
  end if;

  -- Audio is only marked for upload when the recording policy allows it.
  if v_audio not in ('none', 'local_only', 'pending') then
    raise exception 'invalid audio status' using errcode = 'PT422';
  end if;
  if v_audio = 'pending' and not private.audio_upload_allowed(v_learner) then
    v_audio := 'local_only';
  end if;

  insert into public.reading_sessions (
    id, learner_id, story_version_id, assignment_id, mode, started_at, ended_at, local_day,
    active_ms, paused_ms, interrupted_ms, assessed_ms, recognition_plan, transcript,
    review_requested, recovered, audio_status, submitted_by, client_op_id
  ) values (
    v_id, v_learner, v_version, v_assignment, v_mode, v_started, v_ended, (p_session ->> 'local_day')::date,
    v_active, (p_session ->> 'paused_ms')::int, (p_session ->> 'interrupted_ms')::int, v_assessed,
    p_session ->> 'recognition_plan', p_session -> 'transcript',
    coalesce((p_session ->> 'review_requested')::boolean, false), coalesce((p_session ->> 'recovered')::boolean, false),
    v_audio, v_uid, p_op_id
  );

  insert into public.session_assessments (
    session_id, method, status, completion, unassessed_reason, review_reasons,
    engine_id, engine_version, engine_processing, scoring_version, aligner_version, normalizer_version,
    total_words, evaluated_words, correct_words, self_corrected_words, uncertain_words, substituted_words,
    skipped_words, unassessed_words, not_reached_words, insertions, repetitions, coverage, assessed_ms, cwpm
  ) values (
    v_id, a ->> 'method', v_status, v_completion, a ->> 'unassessed_reason',
    coalesce(array(select jsonb_array_elements_text(a -> 'review_reasons')), '{}'),
    a ->> 'engine_id', a ->> 'engine_version', a ->> 'engine_processing', a ->> 'scoring_version',
    a ->> 'aligner_version', (a ->> 'normalizer_version')::int,
    v_total, v_evaluated, v_correct, v_self, v_uncertain, v_substituted, v_skipped, v_unassessed, v_not_reached,
    coalesce((a ->> 'insertions')::int, 0), coalesce((a ->> 'repetitions')::int, 0),
    v_coverage, v_assessment_ms, v_cwpm
  );

  insert into public.word_results (session_id, word_index, status, heard)
  select v_id, (w ->> 'i')::int, w ->> 's', left(w ->> 'h', 60)
  from jsonb_array_elements(v_words) w
  where (w ->> 'i')::int < v_total;

  v_keys := private.evaluate_session_awards(v_id);
  v_result := jsonb_build_object('session_id', v_id, 'duplicate', false,
    'audio_status', v_audio, 'awards', private.awards_json(v_learner, v_keys));
  return private.finish_op(p_op_id, 'session.submit', v_id, v_result);
end;
$$;

-- Marks a recording as uploaded only after verifying the object exists in Storage.
create function public.confirm_audio_upload(p_op_id uuid, p_session_id uuid, p_path text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_user();
  v_prev jsonb := private.begin_op(p_op_id);
  s record;
  v_meta jsonb;
  v_retention int;
  v_result jsonb;
begin
  if v_prev is not null then return v_prev; end if;
  select * into s from public.reading_sessions where id = p_session_id;
  if not found or not private.can_access_learner(s.learner_id) then
    raise exception 'session not found' using errcode = 'PT404';
  end if;
  if not private.audio_upload_allowed(s.learner_id) then
    raise exception 'recording uploads are not allowed for this learner' using errcode = 'PT403';
  end if;
  if p_path not like s.learner_id::text || '/' || s.id::text || '.%' then
    raise exception 'unexpected recording path' using errcode = 'PT422';
  end if;
  select o.metadata into v_meta from storage.objects o where o.bucket_id = 'reading-audio' and o.name = p_path;
  if not found then
    raise exception 'recording not found in storage' using errcode = 'PT409';
  end if;

  select min(c.audio_retention_days) into v_retention
  from public.class_memberships m join public.classes c on c.id = m.class_id
  where m.learner_id = s.learner_id and m.status = 'active' and c.audio_upload_enabled;

  update public.reading_sessions
  set audio_status = 'uploaded', audio_path = p_path, audio_mime = v_meta ->> 'mimetype',
      audio_bytes = nullif(v_meta ->> 'size', '')::int, audio_uploaded_at = now(),
      audio_expires_at = now() + make_interval(days => coalesce(v_retention, 30))
  where id = p_session_id;

  v_result := jsonb_build_object('session_id', p_session_id, 'audio_path', p_path, 'uploaded', true);
  return private.finish_op(p_op_id, 'audio.upload', p_session_id, v_result);
end;
$$;

-- The learner's side asks a teacher to review an attempt (e.g. word checking was
-- unavailable). This is the only change allowed to a submitted attempt's content.
create function public.request_session_review(p_op_id uuid, p_session_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb := private.begin_op(p_op_id);
  v_learner uuid;
begin
  perform private.require_user();
  if v_prev is not null then return v_prev; end if;
  select learner_id into v_learner from public.reading_sessions where id = p_session_id;
  if v_learner is null or not private.can_access_learner(v_learner) then
    raise exception 'session not found' using errcode = 'PT404';
  end if;
  update public.reading_sessions set review_requested = true where id = p_session_id;
  return private.finish_op(p_op_id, 'session.review', p_session_id, jsonb_build_object('review_requested', true));
end;
$$;

-- Records that a recording was deleted from Storage (guardian request or retention).
create function public.mark_audio_deleted(p_session_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  s record;
begin
  select * into s from public.reading_sessions where id = p_session_id;
  if not found then
    raise exception 'session not found' using errcode = 'PT404';
  end if;
  if auth.uid() is not null and not private.can_access_learner(s.learner_id) then
    raise exception 'not authorized' using errcode = 'PT403';
  end if;
  if s.audio_path is not null and exists (
    select 1 from storage.objects o where o.bucket_id = 'reading-audio' and o.name = s.audio_path
  ) then
    raise exception 'delete the recording from storage first' using errcode = 'PT409';
  end if;
  update public.reading_sessions set audio_status = 'deleted' where id = p_session_id;
  perform private.audit('recording_deleted', 'reading_session', p_session_id::text, null, s.learner_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- My Words (idempotent; tombstones synchronize removals)
-- ---------------------------------------------------------------------------

create function public.save_learner_word(
  p_op_id uuid, p_learner_id uuid, p_language text, p_word text, p_normalized text,
  p_vocabulary_entry_id uuid, p_story_version_id uuid, p_saved_at timestamptz
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb := private.begin_op(p_op_id);
  v_count int;
  v_entry uuid;
  v_version uuid;
  v_result jsonb;
begin
  perform private.require_user();
  if v_prev is not null then return v_prev; end if;
  if not private.can_access_learner(p_learner_id) then
    raise exception 'not authorized for this learner' using errcode = 'PT403';
  end if;
  select id into v_entry from public.vocabulary_entries where id = p_vocabulary_entry_id;
  select id into v_version from public.story_versions where id = p_story_version_id;

  insert into public.learner_vocabulary (learner_id, language, word, normalized, vocabulary_entry_id, story_version_id, saved_at)
  values (p_learner_id, p_language, left(p_word, 60), left(p_normalized, 60), v_entry, v_version, p_saved_at)
  on conflict (learner_id, language, normalized) do update set
    -- A save newer than the removal brings the word back; an older one does not.
    archived_at = case
      when public.learner_vocabulary.archived_at is not null and excluded.saved_at > public.learner_vocabulary.archived_at then null
      else public.learner_vocabulary.archived_at end,
    saved_at = greatest(public.learner_vocabulary.saved_at, excluded.saved_at),
    vocabulary_entry_id = coalesce(public.learner_vocabulary.vocabulary_entry_id, excluded.vocabulary_entry_id);

  select count(*) into v_count from public.learner_vocabulary where learner_id = p_learner_id and archived_at is null;
  if v_count >= 5 then
    insert into public.badge_awards (learner_id, badge_code, source_key)
    values (p_learner_id, 'word_collector', 'once') on conflict do nothing;
  end if;

  v_result := jsonb_build_object('saved', true, 'awards', private.awards_json(p_learner_id, array['once']));
  return private.finish_op(p_op_id, 'word.save', p_learner_id, v_result);
end;
$$;

create function public.archive_learner_word(
  p_op_id uuid, p_learner_id uuid, p_language text, p_normalized text, p_archived_at timestamptz
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb := private.begin_op(p_op_id);
begin
  perform private.require_user();
  if v_prev is not null then return v_prev; end if;
  if not private.can_access_learner(p_learner_id) then
    raise exception 'not authorized for this learner' using errcode = 'PT403';
  end if;
  update public.learner_vocabulary
  set archived_at = p_archived_at
  where learner_id = p_learner_id and language = p_language and normalized = p_normalized
    and saved_at <= p_archived_at and (archived_at is null or archived_at < p_archived_at);
  return private.finish_op(p_op_id, 'word.archive', p_learner_id, jsonb_build_object('archived', true));
end;
$$;

create function public.record_word_practice(
  p_op_id uuid, p_learner_id uuid, p_language text, p_normalized text, p_practiced_at timestamptz
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev jsonb := private.begin_op(p_op_id);
begin
  perform private.require_user();
  if v_prev is not null then return v_prev; end if;
  if not private.can_access_learner(p_learner_id) then
    raise exception 'not authorized for this learner' using errcode = 'PT403';
  end if;
  update public.learner_vocabulary
  set practice_count = practice_count + 1,
      last_practiced_at = greatest(coalesce(last_practiced_at, p_practiced_at), p_practiced_at)
  where learner_id = p_learner_id and language = p_language and normalized = p_normalized;
  return private.finish_op(p_op_id, 'word.practice', p_learner_id, jsonb_build_object('recorded', true));
end;
$$;

-- ---------------------------------------------------------------------------
-- Teacher review
-- ---------------------------------------------------------------------------

create function public.add_assessment_correction(
  p_session_id uuid, p_word_index integer, p_corrected_status text, p_reason text default ''
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_user();
  v_previous text;
  v_total int;
  v_id uuid;
begin
  if not private.can_review_session(p_session_id) then
    raise exception 'only a teacher of this learner can correct results' using errcode = 'PT403';
  end if;
  select total_words into v_total from public.session_assessments where session_id = p_session_id;
  if p_word_index is not null and (p_word_index < 0 or p_word_index >= v_total) then
    raise exception 'word index out of range' using errcode = 'PT422';
  end if;
  select corrected_status into v_previous from public.assessment_corrections
  where session_id = p_session_id and word_index = p_word_index order by created_at desc limit 1;
  if v_previous is null then
    select status into v_previous from public.word_results where session_id = p_session_id and word_index = p_word_index;
  end if;
  insert into public.assessment_corrections (session_id, word_index, previous_status, corrected_status, reason, corrected_by)
  values (p_session_id, p_word_index, v_previous, p_corrected_status, coalesce(p_reason, ''), v_uid)
  returning id into v_id;
  return v_id;
end;
$$;

create function public.mark_session_reviewed(p_session_id uuid, p_note text default '') returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_user();
  v_id uuid;
begin
  if not private.can_review_session(p_session_id) then
    raise exception 'only a teacher of this learner can review this attempt' using errcode = 'PT403';
  end if;
  insert into public.session_reviews (session_id, reviewer_id, note) values (p_session_id, v_uid, coalesce(p_note, ''))
  returning id into v_id;
  return v_id;
end;
$$;

-- Class progress for the teacher dashboard and CSV export (RLS still applies).
create function public.class_progress(p_class_id uuid)
returns table (
  learner_id uuid, display_name text, avatar text, membership_status text,
  sessions bigint, assessed_sessions bigint, last_session_at timestamptz,
  latest_cwpm numeric, best_cwpm numeric, latest_coverage numeric, needs_review bigint
)
language sql stable security invoker set search_path = '' as $$
  select
    l.id, l.display_name, l.avatar, m.status,
    count(rs.id),
    count(rs.id) filter (where sa.status = 'assessed'),
    max(rs.started_at),
    (array_agg(sa.cwpm order by rs.started_at desc) filter (where sa.status = 'assessed' and sa.completion = 'complete' and sa.cwpm is not null))[1],
    max(sa.cwpm) filter (where sa.status = 'assessed' and sa.completion = 'complete'),
    (array_agg(sa.coverage order by rs.started_at desc) filter (where sa.status <> 'unassessed'))[1],
    count(rs.id) filter (where (sa.status = 'needs_review' or rs.review_requested)
      and not exists (select 1 from public.session_reviews r where r.session_id = rs.id))
  from public.class_memberships m
  join public.learners l on l.id = m.learner_id
  left join public.reading_sessions rs on rs.learner_id = l.id
  left join public.session_assessments sa on sa.session_id = rs.id
  where m.class_id = p_class_id and m.status = 'active' and private.is_class_staff(p_class_id)
  group by l.id, l.display_name, l.avatar, m.status
  order by l.display_name;
$$;

-- Attempts that need a teacher: uncertain results, explicit review requests, and
-- unassessed recordings shared with the teacher. RLS still applies.
create function public.review_queue()
returns table (
  session_id uuid, learner_id uuid, learner_name text, story_title text, started_at timestamptz,
  status text, completion text, review_requested boolean, review_reasons text[], audio_status text,
  class_id uuid, class_name text
)
language sql stable security invoker set search_path = '' as $$
  select distinct on (rs.id)
    rs.id, l.id, l.display_name, sv.title, rs.started_at, sa.status, sa.completion,
    rs.review_requested, sa.review_reasons, rs.audio_status, c.id, c.name
  from public.reading_sessions rs
  join public.learners l on l.id = rs.learner_id
  join public.story_versions sv on sv.id = rs.story_version_id
  join public.session_assessments sa on sa.session_id = rs.id
  join public.class_memberships m on m.learner_id = rs.learner_id and m.status = 'active'
  join public.class_staff cs on cs.class_id = m.class_id and cs.user_id = auth.uid()
  join public.classes c on c.id = m.class_id
  where (sa.status = 'needs_review' or rs.review_requested or (sa.status = 'unassessed' and rs.audio_status = 'uploaded'))
    and not exists (select 1 from public.session_reviews r where r.session_id = rs.id)
  order by rs.id, rs.started_at desc
  limit 500;
$$;

-- ---------------------------------------------------------------------------
-- Administration
-- ---------------------------------------------------------------------------

create function public.grant_role(p_user_id uuid, p_role public.app_role) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_user();
begin
  if not private.has_role('admin') then
    raise exception 'only an admin can grant roles' using errcode = 'PT403';
  end if;
  insert into public.user_roles (user_id, role, granted_by) values (p_user_id, p_role, v_uid) on conflict do nothing;
end;
$$;

create function public.grant_story_editor(p_story_id uuid, p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_user();
begin
  if not exists (select 1 from public.stories where id = p_story_id and owner_id = v_uid) and not private.has_role('admin') then
    raise exception 'only the story owner can share editing' using errcode = 'PT403';
  end if;
  insert into public.story_editors (story_id, user_id, granted_by) values (p_story_id, p_user_id, v_uid) on conflict do nothing;
  perform private.audit('story_editor_granted', 'story', p_story_id::text, null, null, jsonb_build_object('user_id', p_user_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- Function privileges: RPCs are for signed-in users only.
-- ---------------------------------------------------------------------------

revoke execute on all functions in schema public from public, anon;
grant execute on function
  public.my_access(),
  public.create_learner(uuid, uuid, text, text, smallint),
  public.set_learner_audio_consent(uuid, boolean),
  public.archive_learner(uuid),
  public.create_class(text, smallint),
  public.regenerate_join_code(uuid),
  public.set_join_code_enabled(uuid, boolean),
  public.set_class_recording_policy(uuid, boolean, integer),
  public.request_class_enrollment(text, uuid),
  public.decide_enrollment(uuid, uuid, boolean),
  public.remove_class_member(uuid, uuid),
  public.teacher_add_learner(uuid, uuid, text, text, smallint),
  public.publish_story(uuid, integer, smallint, integer),
  public.archive_story(uuid),
  public.restore_story(uuid),
  public.submit_reading_session(uuid, jsonb),
  public.confirm_audio_upload(uuid, uuid, text),
  public.request_session_review(uuid, uuid),
  public.mark_audio_deleted(uuid),
  public.save_learner_word(uuid, uuid, text, text, text, uuid, uuid, timestamptz),
  public.archive_learner_word(uuid, uuid, text, text, timestamptz),
  public.record_word_practice(uuid, uuid, text, text, timestamptz),
  public.add_assessment_correction(uuid, integer, text, text),
  public.mark_session_reviewed(uuid, text),
  public.class_progress(uuid),
  public.review_queue(),
  public.grant_role(uuid, public.app_role),
  public.grant_story_editor(uuid, uuid)
to authenticated;
grant execute on function public.mark_audio_deleted(uuid) to service_role;

revoke execute on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated;
