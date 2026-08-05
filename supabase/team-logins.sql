-- ============================================================
-- CREATE (OR REPAIR) THE 16 TEAM CAPTAIN LOGINS
--
-- Run AFTER auction-schema.sql. Safe to run repeatedly.
--
-- NO PASSWORD IS STORED IN THIS REPOSITORY.
-- On the first run a fresh, readable password (word + 4 digits) is
-- generated for each team and written to the staff-only table
-- public.auction_team_logins. Read them in
--   Organiser Console → Auction → Team Logins.
--
-- Re-running does NOT churn passwords: a team that already has a
-- stored credential keeps it, so credentials you have handed out
-- stay valid. The account is still repaired (email confirmed,
-- unbanned, relinked) on every run.
--
-- To force new passwords for everyone:
--   delete from public.auction_team_logins;   -- then re-run this file
-- or use "Generate new passwords" in the console.
-- ============================================================

do $$
declare
  words   text[] := array[
    'Dink','Rally','Volley','Smash','Lob','Ace','Drive','Slice',
    'Spin','Serve','Court','NetPlay','Kitchen','Paddle','Baseline','Topspin',
    'Backhand','Forehand','Poach','Stack','Erne','Flick','Punch','Carry'
  ];
  team_no int;
  uid     uuid;
  v_email text;
  v_pw    text;
  used    text[] := array[]::text[];
  tries   int;
begin
  -- keep any passwords that already exist so handed-out credentials stay valid
  select coalesce(array_agg(password), array[]::text[]) into used
    from public.auction_team_logins;

  for team_no in 1..16 loop
    v_email := 'team' || team_no || '@monsoonpickleleague.in';

    -- reuse the stored password if there is one, else mint a unique one
    select password into v_pw
      from public.auction_team_logins where team_id = team_no;

    if v_pw is null then
      tries := 0;
      loop
        v_pw := words[1 + floor(random() * array_length(words, 1))::int]
                || lpad((1000 + floor(random() * 9000))::int::text, 4, '0');
        tries := tries + 1;
        exit when not (v_pw = any(used)) or tries > 200;
      end loop;
      used := used || v_pw;
    end if;

    select id into uid from auth.users where email = v_email;

    if uid is null then
      ----------------------------------------------------------
      -- CREATE (all GoTrue token columns must be '', never NULL)
      ----------------------------------------------------------
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
        uid, 'authenticated', 'authenticated', v_email,
        crypt(v_pw, gen_salt('bf')), now(),
        '{"provider":"email","providers":["email"]}',
        jsonb_build_object('team_no', team_no, 'username', 'Team' || team_no),
        now(), now(),
        '', '', '', '', '', '', '', '',
        false
      );
    else
      ----------------------------------------------------------
      -- REPAIR: reset password, confirm email, clear NULL tokens
      ----------------------------------------------------------
      update auth.users set
        encrypted_password         = crypt(v_pw, gen_salt('bf')),
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
        raw_user_meta_data         = jsonb_build_object('team_no', team_no, 'username', 'Team' || team_no),
        banned_until               = null,
        updated_at                 = now()
      where id = uid;
    end if;

    -- email identity row (required for password sign-in)
    if not exists (select 1 from auth.identities where user_id = uid and provider = 'email') then
      insert into auth.identities (
        id, user_id, provider_id, identity_data, provider,
        last_sign_in_at, created_at, updated_at
      ) values (
        gen_random_uuid(), uid, uid::text,
        jsonb_build_object('sub', uid::text, 'email', v_email, 'email_verified', true),
        'email', now(), now(), now()
      );
    end if;

    -- link the account to its team
    update public.auction_teams set auth_user_id = uid where id = team_no;

    -- record the credential (staff-only table) so the console can show it
    insert into public.auction_team_logins (team_id, username, email, password, updated_at)
    values (team_no, 'Team' || team_no, v_email, v_pw, now())
    on conflict (team_id) do update
      set username   = excluded.username,
          email      = excluded.email,
          password   = excluded.password,
          updated_at = now();
  end loop;

  raise notice 'All 16 captain logins are ready. Read the passwords in Organiser Console -> Auction -> Team Logins.';
end $$;

-- ------------------------------------------------------------
-- Verification — every row should read "OK".
-- Passwords are deliberately NOT selected here: on a public repo the
-- workflow logs are public, so they must never be printed.
-- ------------------------------------------------------------
select
  l.username,
  l.email,
  case
    when u.id is null                                   then 'MISSING ACCOUNT'
    when u.email_confirmed_at is null                   then 'EMAIL NOT CONFIRMED'
    when t.auth_user_id is distinct from u.id           then 'NOT LINKED TO TEAM'
    when u.encrypted_password <> crypt(l.password, u.encrypted_password)
                                                        then 'PASSWORD MISMATCH'
    else 'OK'
  end as status
from public.auction_team_logins l
left join auth.users u on u.email = l.email
left join public.auction_teams t on t.id = l.team_id
order by l.team_id;
