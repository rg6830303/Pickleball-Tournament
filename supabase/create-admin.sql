-- ============================================================
-- CREATE **OR REPAIR** THE ORGANISER LOGIN
--
--   email:    ishanvashistha.1993@gmail.com
--   password: Pickle2026
--
-- Run this in Supabase → SQL Editor → New query → Run.
-- Safe to run repeatedly:
--   • account missing  → it is created, email pre-confirmed
--   • account exists   → password is reset to Pickle2026 and any
--     broken/NULL auth fields are repaired
--
-- ⚠ SECURITY: this file contains the initial password in plain
--   text. After signing in, change it (Authentication → Users →
--   ⋯ → Reset password) or delete this file from the repo.
-- ============================================================

do $$
declare
  admin_email text := 'ishanvashistha.1993@gmail.com';
  admin_pass  text := 'Pickle2026';
  uid uuid;
begin
  select id into uid from auth.users where email = admin_email;

  if uid is null then
    ------------------------------------------------------------------
    -- CREATE — every token column set to '' (GoTrue rejects NULLs)
    ------------------------------------------------------------------
    uid := gen_random_uuid();

    insert into auth.users (
      instance_id, id, aud, role, email,
      encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at,
      confirmation_token, recovery_token,
      email_change_token_new, email_change,
      email_change_token_current,
      phone_change, phone_change_token,
      reauthentication_token,
      is_sso_user
    ) values (
      '00000000-0000-0000-0000-000000000000',
      uid,
      'authenticated',
      'authenticated',
      admin_email,
      crypt(admin_pass, gen_salt('bf')),
      now(),
      '{"provider":"email","providers":["email"]}',
      '{}',
      now(), now(),
      '', '',
      '', '',
      '',
      '', '',
      '',
      false
    );

    raise notice 'Admin user CREATED: %', admin_email;
  else
    ------------------------------------------------------------------
    -- REPAIR — reset password, confirm email, fix NULL token fields
    ------------------------------------------------------------------
    update auth.users set
      encrypted_password         = crypt(admin_pass, gen_salt('bf')),
      email_confirmed_at         = coalesce(email_confirmed_at, now()),
      confirmation_token         = coalesce(confirmation_token, ''),
      recovery_token             = coalesce(recovery_token, ''),
      email_change_token_new     = coalesce(email_change_token_new, ''),
      email_change               = coalesce(email_change, ''),
      email_change_token_current = coalesce(email_change_token_current, ''),
      phone_change               = coalesce(phone_change, ''),
      phone_change_token         = coalesce(phone_change_token, ''),
      reauthentication_token     = coalesce(reauthentication_token, ''),
      raw_app_meta_data          = coalesce(raw_app_meta_data, '{"provider":"email","providers":["email"]}'),
      banned_until               = null,
      updated_at                 = now()
    where id = uid;

    raise notice 'Admin user REPAIRED — password reset for %', admin_email;
  end if;

  ------------------------------------------------------------------
  -- Ensure the email identity row exists (required for sign-in)
  ------------------------------------------------------------------
  if not exists (
    select 1 from auth.identities where user_id = uid and provider = 'email'
  ) then
    insert into auth.identities (
      id, user_id, provider_id, identity_data,
      provider, last_sign_in_at, created_at, updated_at
    ) values (
      gen_random_uuid(),
      uid,
      uid::text,
      jsonb_build_object('sub', uid::text, 'email', admin_email, 'email_verified', true),
      'email',
      now(), now(), now()
    );
    raise notice 'Email identity created for %', admin_email;
  end if;
end $$;

-- Sanity check — should return exactly one row with a confirmed email:
select id, email, email_confirmed_at, created_at
from auth.users
where email = 'ishanvashistha.1993@gmail.com';
