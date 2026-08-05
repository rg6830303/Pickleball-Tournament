-- ============================================================
-- CREATE (OR REPAIR) THE 16 TEAM CAPTAIN LOGINS
--
-- Run AFTER auction-schema.sql. Safe to run repeatedly:
--   • account missing → created, email pre-confirmed
--   • account exists  → password reset, email confirmed, unbanned
-- It also links each account to its team and records the password in
-- the staff-only auction_team_logins table so the console can show it.
--
-- Usernames are Team1 … Team16. Captains sign in at
-- https://monsoonpickleauction.vercel.app by picking their team.
--
-- ⚠ Change these passwords after the event, or from
--   Organiser Console → Auction → Team Logins.
-- ============================================================

do $$
declare
  r        record;
  uid      uuid;
  v_email  text;
begin
  for r in
    select * from (values
      ( 1, 'Dink2481'),     ( 2, 'Rally3960'),   ( 3, 'Volley5127'),   ( 4, 'Smash7314'),
      ( 5, 'Lob4682'),      ( 6, 'Ace9053'),     ( 7, 'Drive2769'),    ( 8, 'Slice6135'),
      ( 9, 'Spin8420'),     (10, 'Serve3517'),   (11, 'Court7948'),    (12, 'NetPlay5203'),
      (13, 'Kitchen6871'),  (14, 'Paddle4396'),  (15, 'Baseline2754'), (16, 'Topspin9182')
    ) as t(team_no, pw)
  loop
    v_email := 'team' || r.team_no || '@monsoonpickleleague.in';

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
        crypt(r.pw, gen_salt('bf')), now(),
        '{"provider":"email","providers":["email"]}',
        jsonb_build_object('team_no', r.team_no, 'username', 'Team' || r.team_no),
        now(), now(),
        '', '', '', '', '', '', '', '',
        false
      );
    else
      ----------------------------------------------------------
      -- REPAIR: reset password, confirm email, clear NULL tokens
      ----------------------------------------------------------
      update auth.users set
        encrypted_password         = crypt(r.pw, gen_salt('bf')),
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
        raw_user_meta_data         = jsonb_build_object('team_no', r.team_no, 'username', 'Team' || r.team_no),
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
    update public.auction_teams set auth_user_id = uid where id = r.team_no;

    -- record the credential so the console can display / reissue it
    insert into public.auction_team_logins (team_id, username, email, password, updated_at)
    values (r.team_no, 'Team' || r.team_no, v_email, r.pw, now())
    on conflict (team_id) do update
      set username = excluded.username,
          email    = excluded.email,
          password = excluded.password,
          updated_at = now();
  end loop;

  raise notice 'All 16 captain logins are ready.';
end $$;

-- ------------------------------------------------------------
-- Verification — every row should read "OK"
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
