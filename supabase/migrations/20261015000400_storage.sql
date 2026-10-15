-- Private storage for reading recordings and story assets.
-- Buckets are private: files are read only through short-lived signed URLs, and the
-- policies below mirror the database ownership rules.
--
-- Object paths:
--   reading-audio/<learner_id>/<session_id>.<ext>
--   story-assets/<story_id>/<file>

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('reading-audio', 'reading-audio', false, 26214400,
    array['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/aac']),
  ('story-assets', 'story-assets', false, 10485760,
    array['audio/mpeg', 'audio/mp4', 'audio/webm', 'audio/ogg', 'image/png', 'image/jpeg', 'image/webp', 'application/json'])
on conflict (id) do nothing;

-- Parses a uuid from a path segment without raising on malformed input.
create function private.try_uuid(p_text text) returns uuid
language plpgsql immutable set search_path = '' as $$
begin
  if p_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return p_text::uuid;
  end if;
  return null;
end;
$$;

-- An upload must target an existing session of the learner named in the path, by
-- someone who can act for the learner, under an allowed recording policy.
create function private.can_upload_session_audio(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.reading_sessions rs
    where rs.learner_id = private.try_uuid(split_part(p_name, '/', 1))
      and rs.id = private.try_uuid(split_part(split_part(p_name, '/', 2), '.', 1))
      and array_length(string_to_array(p_name, '/'), 1) = 2
      and rs.audio_status in ('pending', 'local_only')
      and private.can_access_learner(rs.learner_id)
      and private.audio_upload_allowed(rs.learner_id)
  );
$$;

grant execute on function private.try_uuid(text), private.can_upload_session_audio(text) to authenticated;

create policy "reading audio: read if authorized for learner"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'reading-audio'
    and private.can_access_learner(private.try_uuid(split_part(name, '/', 1)))
  );

create policy "reading audio: upload under recording policy"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'reading-audio'
    and private.can_upload_session_audio(name)
  );

create policy "reading audio: delete if authorized for learner"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'reading-audio'
    and private.can_access_learner(private.try_uuid(split_part(name, '/', 1)))
  );

-- No update policy for recordings: an uploaded attempt is never replaced.

create policy "story assets: read with story"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'story-assets'
    and private.can_read_story(private.try_uuid(split_part(name, '/', 1)))
  );

create policy "story assets: editors upload"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'story-assets'
    and private.can_edit_story(private.try_uuid(split_part(name, '/', 1)))
  );

create policy "story assets: editors update"
  on storage.objects for update to authenticated
  using (bucket_id = 'story-assets' and private.can_edit_story(private.try_uuid(split_part(name, '/', 1))))
  with check (bucket_id = 'story-assets' and private.can_edit_story(private.try_uuid(split_part(name, '/', 1))));

create policy "story assets: editors delete"
  on storage.objects for delete to authenticated
  using (bucket_id = 'story-assets' and private.can_edit_story(private.try_uuid(split_part(name, '/', 1))));
