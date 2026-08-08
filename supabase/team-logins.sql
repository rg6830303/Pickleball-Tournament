
-- ============================================================
-- 16 CAPTAIN LOGINS (SQL fallback)
--
-- Preferred path is Organiser Console -> Auction -> Team Logins ->
-- "Create 16 team logins", which goes through the Supabase Admin API
-- and is the most robust option. This block exists so the whole
-- install can still be done from one paste in the SQL Editor.
--
-- No password is stored in this repository: a fresh one is generated
-- per team on first run and written to the staff-only table
-- public.auction_team_logins. Re-running KEEPS existing passwords so
-- credentials already handed out stay valid.
--
-- Captains are never added to public.app_staff, so they can never
-- read registrations, payment screenshots or each other's passwords.
-- ============================================================
do $$
declare
  words   text[] := array[
    'Dink','Rally','Volley','Smash','Lob','Ace','Drive','Slice',
    'Spin','Serve','Court','NetPlay','Kitchen','Paddle','Baseline','Topspin'
  ];
  alpha   text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  -- no O/0/I/1/l
  team_no int;
  uid     uuid;
  v_email text;
  v_pw    text;
  v_tail  text;
  k       int;
begin
  for team_no in 1..16 loop
    v_email := 'team' || team_no || '@monsoonpickleleague.in';

    select password into v_pw
      from public.auction_team_logins where team_id = team_no;

    if v_pw is null then
      v_tail := '';
      for k in 1..6 loop
        v_tail := v_tail || substr(alpha, 1 + floor(random() * length(alpha))::int, 1);
      end loop;
      v_pw := words[team_no] || '-' || v_tail;
    end if;

    select id into uid from auth.users where email = v_email;

    if uid is null then
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
        -- cost 10 matches what GoTrue itself writes (gen_salt('bf') alone is cost 6)
        extensions.crypt(v_pw, extensions.gen_salt('bf', 10)), now(),
        '{"provider":"email","providers":["email"]}',
        jsonb_build_object('team_no', team_no, 'username', 'Team' || team_no, 'role', 'captain'),
        now(), now(),
        '', '', '', '', '', '', '', '',
        false
      );
    else
      update auth.users set
        encrypted_password         = extensions.crypt(v_pw, extensions.gen_salt('bf', 10)),
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
        raw_user_meta_data         = jsonb_build_object('team_no', team_no, 'username', 'Team' || team_no, 'role', 'captain'),
        banned_until               = null,
        updated_at                 = now()
      where id = uid;
    end if;

    -- email identity row (required for password sign-in).
    -- identities.email is GENERATED from identity_data - never insert it.
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

    -- Clear any stale link before claiming it: auth_user_id is UNIQUE, and a
    -- blind assignment could abort the whole loop.
    update public.auction_teams set auth_user_id = null
     where auth_user_id = uid and id <> team_no;
    update public.auction_teams set auth_user_id = uid where id = team_no;

    -- A captain must never be staff.
    delete from public.app_staff where user_id = uid;

    insert into public.auction_team_logins (team_id, username, email, password, updated_at)
    values (team_no, 'Team' || team_no, v_email, v_pw, now())
    on conflict (team_id) do update
      set username   = excluded.username,
          email      = excluded.email,
          password   = excluded.password,
          updated_at = now();
  end loop;

  raise notice 'All 16 captain logins ready. Read them in Organiser Console -> Auction -> Team Logins.';
end $$;

notify pgrst, 'reload schema';

-- Verification. Every row should read OK. Passwords are deliberately not
-- selected: on a public repo the CI logs would leak them.
select
  l.username,
  l.email,
  case
    when u.id is null                              then 'MISSING ACCOUNT'
    when u.encrypted_password is null              then 'NO PASSWORD SET'
    when u.email_confirmed_at is null              then 'EMAIL NOT CONFIRMED'
    when t.auth_user_id is distinct from u.id      then 'NOT LINKED TO TEAM'
    when not exists (select 1 from auth.identities i
                      where i.user_id = u.id and i.provider = 'email')
                                                   then 'NO EMAIL IDENTITY'
    when exists (select 1 from public.app_staff s where s.user_id = u.id)
                                                   then 'WRONGLY MARKED STAFF'
    when u.encrypted_password <> extensions.crypt(l.password, u.encrypted_password)
                                                   then 'PASSWORD MISMATCH'
    else 'OK'
  end as status
from public.auction_team_logins l
left join auth.users u on u.email = l.email
left join public.auction_teams t on t.id = l.team_id
order by l.team_id;
