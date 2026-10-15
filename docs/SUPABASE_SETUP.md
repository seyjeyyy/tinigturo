# Supabase setup

Without Supabase, Tinig Turo still works fully on one device. Readers, reading,
recording, progress and My Words are stored in the browser. Accounts, classes, the
teacher workspace and sync need the steps below.

## 1. Create the project

1. Create a project at <https://supabase.com/dashboard>. Note the **project URL** and
   the **publishable key** (or legacy anon key) under *Project Settings → API keys*.
2. **Never** put the secret or service-role key in the browser, a `VITE_` variable, or
   source control. The app refuses to start its cloud client if it detects one.

## 2. Apply the migrations

With the Supabase CLI (`npx supabase`):

```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push          # applies supabase/migrations/*.sql
```

The migrations create:
- the schema, with RLS on every table;
- the security-definer RPCs;
- private Storage buckets `reading-audio` and `story-assets`, with their policies.

## 3. Load the development seed (optional)

`supabase/seed.sql` is generated from `src/content/*` with `npm run seed:generate`. It
contains the six starter stories and **draft** vocabulary, and **no learner activity**.
Run it once in the SQL editor, or with `npx supabase db reset` locally. Seeded story IDs
match the bundled stories, so readings of starter stories sync to valid rows.

## 4. Configure Auth

In *Authentication → URL Configuration*:

- **Site URL**: your deployed origin, e.g. `https://reading.example.org`.
- **Redirect URLs**: `https://reading.example.org/account` and
  `https://reading.example.org/account/update-password`. Add the `localhost:5173` and
  `localhost:4173` equivalents for development.

Email confirmation is recommended (it is on in `supabase/config.toml` for local use).

## 5. Teacher roles

Roles live in `public.user_roles` and can only be written by security-definer functions
or the service role.

- **Self sign-up:** with `app_settings.teacher_self_signup = true` (the default),
  choosing "Teacher" at sign-up grants the `teacher` role. A teacher can only create
  their own classes and stories; it gives no access to anyone else's data.
- **Admin-approved instead:**

  ```sql
  update public.app_settings set value = 'false' where key = 'teacher_self_signup';
  -- grant a role (run in the SQL editor as the service role / postgres):
  insert into public.user_roles (user_id, role) values ('<user uuid>', 'teacher');
  ```
- **Admins and content editors** (who can edit the shared library and vocabulary):

  ```sql
  insert into public.user_roles (user_id, role) values ('<user uuid>', 'admin');
  insert into public.user_roles (user_id, role) values ('<user uuid>', 'content_editor');
  ```

  An admin can then grant roles from the app's API with `grant_role`.

## 6. Recording retention (Edge Function)

Uploaded recordings expire after the class retention period (30 days by default).
Deploy the purge function and schedule it daily:

```bash
npx supabase functions deploy purge-expired-audio
npx supabase secrets set PURGE_AUDIO_SECRET=<long random string>
```

Schedule it with `pg_cron` + `pg_net` (*Database → Extensions*). The call carries the
publishable key as its JWT, and the shared secret authorizes the purge:

```sql
select cron.schedule('purge-expired-audio', '15 3 * * *', $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/purge-expired-audio',
    headers := jsonb_build_object(
      'Authorization', 'Bearer <publishable-or-anon-key>',
      'x-purge-secret', '<PURGE_AUDIO_SECRET>'
    )
  );
$$);
```

## 7. Configure the app

```bash
cp .env.example .env.local
# set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY
npm run dev
```

The production build adds a Content-Security-Policy that allows connections only to
this origin and `VITE_SUPABASE_URL`.

## Local development stack (needs Docker)

```bash
npx supabase start     # API on http://127.0.0.1:54321, applies migrations + seed
```

Use the printed local URL and publishable/anon key in `.env.local`.

## What has and has not been verified

- All migrations, RLS policies, RPCs, Storage policies and the seed are tested in
  PGlite 0.5.10 (PostgreSQL 18.6 compiled to WASM), against a stand-in for Supabase's
  `auth` and `storage` schemas: `npm run test:db`. The SQL uses only features available
  since PostgreSQL 13 (`gen_random_uuid`, `sha256`, `hashtextextended`), so it should
  also run on Supabase's Postgres 15 and 17.
- **Not yet run against a hosted Supabase project.** No credentials were available
  while building. Before production, run the migrations on a staging project, then
  repeat the manual checks in `docs/TESTING.md`: sign-up/sign-in/recovery email flows,
  a Storage upload and signed-URL playback, and the retention function.
