-- ============================================================
-- CREATE **OR REPAIR** THE ORGANISER LOGIN
--
-- NO PASSWORD IS STORED IN THIS REPOSITORY (it is public).
-- The password is read from the session setting `mpl.admin_password`.
--
--   • GitHub Actions  → set the repository secret ADMIN_PASSWORD;
--                       the workflow injects it automatically.
--   • Supabase SQL Editor → run this first, in the same query window:
--
--         set mpl.admin_password = 'your-chosen-password';
--
--     (or just skip it — you can create the organiser login from the
--      console's "Set up my login" panel instead.)
--
-- If the setting is absent this block does nothing and says so, so the
-- rest of the setup still completes.
--
-- Email can be overridden with `mpl.admin_email`.
-- ============================================================

do $$
declare
  admin_email text := coalesce(
    nullif(current_setting('mpl.admin_email', true), ''),
    'ishanvashistha.1993@gmail.com'
  );
  admin_pass  text := nullif(current_setting('mpl.admin_password', true), '');
  uid uuid;
begin
  if admin_pass is null then
    raise notice 'Organiser login SKIPPED - no mpl.admin_password set. Create it from the console''s "Set up my login" panel, or re-run with: set mpl.admin_password = ''...'';';
    return;
  end if;

  if length(admin_pass) < 6 then
    raise exception 'mpl.admin_password must be at least 6 characters';
  end if;

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
      uid, 'authenticated', 'authenticated', admin_email,
      crypt(admin_pass, gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}',
      '{}',
      now(), now(),
      '', '', '', '', '', '', '', '',
      false
    );

    raise notice 'Organiser login CREATED for %', admin_email;
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

    raise notice 'Organiser login REPAIRED - password reset for %', admin_email;
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
      gen_random_uuid(), uid, uid::text,
      jsonb_build_object('sub', uid::text, 'email', admin_email, 'email_verified', true),
      'email', now(), now(), now()
    );
    raise notice 'Email identity created for %', admin_email;
  end if;

  ------------------------------------------------------------------
  -- Put the organiser on the staff allow-list.
  -- Staff is an explicit allow-list (public.app_staff), so an organiser
  -- who is not listed can see nothing in the console. Skip quietly when
  -- the auction module has not been installed yet.
  ------------------------------------------------------------------
  if to_regclass('public.app_staff') is not null then
    insert into public.app_staff (user_id, email, note)
    values (uid, admin_email, 'organiser account')
    on conflict (user_id) do nothing;
    raise notice 'Organiser % added to the staff allow-list', admin_email;
  end if;
end $$;
