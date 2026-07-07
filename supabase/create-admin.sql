-- ============================================================
-- CREATE THE ORGANISER LOGIN (run AFTER schema.sql)
--
-- Preferred method: Dashboard → Authentication → Users →
-- "Add user" → email + password → check "Auto Confirm User".
--
-- This script does the same thing via SQL for convenience.
-- ⚠ SECURITY: this file contains the initial password in plain
--   text. After your first sign-in, change it (or delete this
--   file / rotate the password in Authentication → Users).
-- ============================================================

do $$
declare
  uid uuid := gen_random_uuid();
begin
  -- skip if the account already exists
  if exists (select 1 from auth.users where email = 'ishanvashistha.1993@gmail.com') then
    raise notice 'Admin user already exists — nothing to do.';
    return;
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email,
    encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at,
    confirmation_token, recovery_token,
    email_change_token_new, email_change
  ) values (
    '00000000-0000-0000-0000-000000000000',
    uid,
    'authenticated',
    'authenticated',
    'ishanvashistha.1993@gmail.com',
    crypt('Pickle2026', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    now(), now(),
    '', '', '', ''
  );

  insert into auth.identities (
    id, user_id, provider_id, identity_data,
    provider, last_sign_in_at, created_at, updated_at
  ) values (
    gen_random_uuid(),
    uid,
    uid::text,
    jsonb_build_object('sub', uid::text, 'email', 'ishanvashistha.1993@gmail.com', 'email_verified', true),
    'email',
    now(), now(), now()
  );

  raise notice 'Admin user created: ishanvashistha.1993@gmail.com';
end $$;
