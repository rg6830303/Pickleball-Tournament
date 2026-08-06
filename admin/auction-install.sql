-- MONSOON PICKLE LEAGUE — AUCTION INSTALL
-- Paste into Supabase → SQL Editor → Run. Safe to run more than once.
-- Creates the auction tables, the 16 captain accounts (with freshly
-- generated passwords) and refreshes the API cache.
-- Afterwards read the passwords in this console: Auction → Team Logins.
do $$ begin create extension if not exists pgcrypto with schema extensions;
exception when others then begin create extension if not exists pgcrypto; exception when others then null; end; end $$;
select set_config('search_path', current_setting('search_path') || ', extensions', false);

create table if not exists public.auction_teams (
  id            int primary key check (id between 1 and 64),
  name          text not null,
  captain_name  text,
  auth_user_id  uuid unique,
  purse_total   numeric(12,2) not null default 100000 check (purse_total >= 0),
  purse_spent   numeric(12,2) not null default 0 check (purse_spent >= 0),
  purse_left    numeric(12,2) generated always as (purse_total - purse_spent) stored,
  max_squad     int not null default 8 check (max_squad > 0),
  created_at    timestamptz not null default now()
);
create or replace function public.auction_team_of(p_uid uuid)
returns int
language sql stable security definer set search_path = public
as $$
  select t.id from public.auction_teams t where t.auth_user_id = p_uid limit 1;
$$;
create or replace function public.is_auction_staff()
returns boolean
language sql stable security definer set search_path = public
as $$
  select auth.uid() is not null
     and public.auction_team_of(auth.uid()) is null;
$$;
create or replace function public.my_auction_team()
returns int
language sql stable security definer set search_path = public
as $$
  select public.auction_team_of(auth.uid());
$$;
insert into public.auction_teams (id, name)
select g, 'Team ' || g from generate_series(1, 16) g
on conflict (id) do nothing;
create table if not exists public.auction_lots (
  id                uuid primary key default gen_random_uuid(),
  registration_id   uuid unique references public.registrations(id) on delete cascade,
  player_name       text not null,
  gender            text,
  dupr              numeric(5,3),
  jersey_size       text,
  jersey_name       text,
  photo_url         text,
  base_price        numeric(12,2) not null default 1000 check (base_price >= 0),
  lot_order         int,
  status            text not null default 'pool'
                    check (status in ('pool','live','sold','unsold')),
  sold_to_team_id   int references public.auction_teams(id) on delete set null,
  sold_price        numeric(12,2) check (sold_price is null or sold_price >= 0),
  sold_at           timestamptz,
  created_at        timestamptz not null default now()
);
create index if not exists auction_lots_status_idx on public.auction_lots (status);
create index if not exists auction_lots_team_idx   on public.auction_lots (sold_to_team_id);
create table if not exists public.auction_state (
  id               int primary key check (id = 1),
  status           text not null default 'idle'
                   check (status in ('idle','live','paused','done')),
  current_lot_id   uuid references public.auction_lots(id) on delete set null,
  current_price    numeric(12,2) not null default 0,
  leading_team_id  int references public.auction_teams(id) on delete set null,
  bid_increment    numeric(12,2) not null default 500 check (bid_increment > 0),
  message          text,
  updated_at       timestamptz not null default now()
);
insert into public.auction_state (id) values (1) on conflict (id) do nothing;
create table if not exists public.auction_team_logins (
  team_id     int primary key references public.auction_teams(id) on delete cascade,
  username    text not null,
  email       text not null,
  password    text not null,
  updated_at  timestamptz not null default now()
);
create table if not exists public.auction_bids (
  id          bigserial primary key,
  lot_id      uuid not null references public.auction_lots(id) on delete cascade,
  team_id     int  not null references public.auction_teams(id) on delete cascade,
  amount      numeric(12,2) not null check (amount >= 0),
  created_at  timestamptz not null default now()
);
create index if not exists auction_bids_lot_idx on public.auction_bids (lot_id, id desc);
alter table public.auction_teams enable row level security;
alter table public.auction_lots  enable row level security;
alter table public.auction_state enable row level security;
alter table public.auction_bids  enable row level security;
drop policy if exists "auth can read teams" on public.auction_teams;
create policy "auth can read teams"
  on public.auction_teams for select to authenticated using (true);
drop policy if exists "staff manage teams" on public.auction_teams;
create policy "staff manage teams"
  on public.auction_teams for all to authenticated
  using (public.is_auction_staff()) with check (public.is_auction_staff());
drop policy if exists "auth can read lots" on public.auction_lots;
create policy "auth can read lots"
  on public.auction_lots for select to authenticated using (true);
drop policy if exists "staff manage lots" on public.auction_lots;
create policy "staff manage lots"
  on public.auction_lots for all to authenticated
  using (public.is_auction_staff()) with check (public.is_auction_staff());
drop policy if exists "auth can read state" on public.auction_state;
create policy "auth can read state"
  on public.auction_state for select to authenticated using (true);
drop policy if exists "staff manage state" on public.auction_state;
create policy "staff manage state"
  on public.auction_state for all to authenticated
  using (public.is_auction_staff()) with check (public.is_auction_staff());
alter table public.auction_team_logins enable row level security;
drop policy if exists "staff manage team logins" on public.auction_team_logins;
create policy "staff manage team logins"
  on public.auction_team_logins for all to authenticated
  using (public.is_auction_staff()) with check (public.is_auction_staff());
drop policy if exists "auth can read bids" on public.auction_bids;
create policy "auth can read bids"
  on public.auction_bids for select to authenticated using (true);
drop policy if exists "staff manage bids" on public.auction_bids;
create policy "staff manage bids"
  on public.auction_bids for all to authenticated
  using (public.is_auction_staff()) with check (public.is_auction_staff());
drop policy if exists "staff can read" on public.registrations;
create policy "staff can read"
  on public.registrations for select to authenticated
  using (public.is_auction_staff());
drop policy if exists "staff can update" on public.registrations;
create policy "staff can update"
  on public.registrations for update to authenticated
  using (public.is_auction_staff());
drop policy if exists "staff can delete" on public.registrations;
create policy "staff can delete"
  on public.registrations for delete to authenticated
  using (public.is_auction_staff());
drop policy if exists "staff can insert" on public.registrations;
create policy "staff can insert"
  on public.registrations for insert to authenticated
  with check (public.is_auction_staff());
create or replace function public.auction_sync_players(p_only_verified boolean default false)
returns int
language plpgsql security definer set search_path = public
as $$
declare v_added int;
begin
  if not public.is_auction_staff() then
    raise exception 'Only tournament staff can sync players';
  end if;
  with inserted as (
    insert into public.auction_lots
      (registration_id, player_name, gender, dupr, jersey_size, jersey_name, photo_url, lot_order)
    select r.id, r.full_name, r.gender, r.dupr, r.jersey_size, r.jersey_name, r.profile_pic_url,
           row_number() over (order by r.created_at)
      from public.registrations r
     where (not p_only_verified or r.status in ('verified','checked-in'))
       and not exists (select 1 from public.auction_lots l where l.registration_id = r.id)
    returning 1
  )
  select count(*) into v_added from inserted;
  return v_added;
end $$;
create or replace function public.auction_start_lot(p_lot_id uuid, p_base numeric default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_base numeric;
begin
  if not public.is_auction_staff() then
    raise exception 'Only tournament staff can start a lot';
  end if;
  select coalesce(p_base, base_price) into v_base
    from public.auction_lots where id = p_lot_id;
  if not found then raise exception 'Lot not found'; end if;
  update public.auction_lots
     set status = 'pool'
   where status = 'live' and id <> p_lot_id;
  update public.auction_lots
     set status = 'live', base_price = v_base,
         sold_to_team_id = null, sold_price = null, sold_at = null
   where id = p_lot_id;
  update public.auction_state
     set status = 'live', current_lot_id = p_lot_id, current_price = v_base,
         leading_team_id = null, message = null, updated_at = now()
   where id = 1;
end $$;
create or replace function public.auction_bid(p_team_id int default null, p_amount numeric default null)
returns numeric
language plpgsql security definer set search_path = public
as $$
declare
  v_team    int;
  v_state   public.auction_state%rowtype;
  v_amount  numeric;
  v_left    numeric;
  v_squad   int;
  v_max     int;
begin
  v_team := coalesce(public.my_auction_team(), case when public.is_auction_staff() then p_team_id end);
  if v_team is null then raise exception 'No team is linked to this login'; end if;
  if public.my_auction_team() is not null
     and p_team_id is not null and p_team_id <> v_team then
    raise exception 'You can only bid for your own team';
  end if;
  select * into v_state from public.auction_state where id = 1 for update;
  if v_state.status <> 'live' or v_state.current_lot_id is null then
    raise exception 'No player is on the block right now';
  end if;
  if v_state.leading_team_id = v_team then
    raise exception 'Your team is already the highest bidder';
  end if;
  v_amount := coalesce(
    p_amount,
    case when v_state.leading_team_id is null
         then v_state.current_price
         else v_state.current_price + v_state.bid_increment end
  );
  if v_state.leading_team_id is not null and v_amount <= v_state.current_price then
    raise exception 'Bid must be higher than the current bid';
  end if;
  select purse_left, max_squad into v_left, v_max
    from public.auction_teams where id = v_team for update;
  if v_left is null then raise exception 'Team not found'; end if;
  if v_amount > v_left then
    raise exception 'Not enough purse left (wallet %, bid %)', v_left, v_amount;
  end if;
  select count(*) into v_squad from public.auction_lots
   where sold_to_team_id = v_team and status = 'sold';
  if v_squad >= v_max then
    raise exception 'Squad is already full (% players)', v_max;
  end if;
  insert into public.auction_bids (lot_id, team_id, amount)
  values (v_state.current_lot_id, v_team, v_amount);
  update public.auction_state
     set current_price = v_amount, leading_team_id = v_team, updated_at = now()
   where id = 1;
  return v_amount;
end $$;
create or replace function public.auction_sell(
  p_lot_id uuid default null,
  p_team_id int default null,
  p_price numeric default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_state  public.auction_state%rowtype;
  v_lot    uuid;
  v_team   int;
  v_price  numeric;
  v_left   numeric;
  v_squad  int;
  v_max    int;
begin
  if not public.is_auction_staff() then
    raise exception 'Only tournament staff can finalise a sale';
  end if;
  select * into v_state from public.auction_state where id = 1 for update;
  v_lot   := coalesce(p_lot_id,  v_state.current_lot_id);
  v_team  := coalesce(p_team_id, v_state.leading_team_id);
  v_price := coalesce(p_price,   v_state.current_price);
  if v_lot is null  then raise exception 'No player is on the block'; end if;
  if v_team is null then raise exception 'No team selected — nobody has bid yet'; end if;
  select purse_left, max_squad into v_left, v_max
    from public.auction_teams where id = v_team for update;
  if v_left is null then raise exception 'Team not found'; end if;
  if v_price > v_left then
    raise exception 'Team has only % left in the purse', v_left;
  end if;
  select count(*) into v_squad from public.auction_lots
   where sold_to_team_id = v_team and status = 'sold';
  if v_squad >= v_max then
    raise exception 'Squad is already full (% players)', v_max;
  end if;
  update public.auction_lots
     set status = 'sold', sold_to_team_id = v_team,
         sold_price = v_price, sold_at = now()
   where id = v_lot and status <> 'sold';
  if not found then raise exception 'That lot is already sold'; end if;
  update public.auction_teams
     set purse_spent = purse_spent + v_price
   where id = v_team;
  update public.auction_state
     set status = 'idle', current_lot_id = null, current_price = 0,
         leading_team_id = null, updated_at = now()
   where id = 1;
end $$;
create or replace function public.auction_mark_unsold(p_lot_id uuid default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_lot uuid;
begin
  if not public.is_auction_staff() then
    raise exception 'Only tournament staff can do that';
  end if;
  select coalesce(p_lot_id, current_lot_id) into v_lot
    from public.auction_state where id = 1;
  if v_lot is null then raise exception 'No player is on the block'; end if;
  update public.auction_lots set status = 'unsold' where id = v_lot and status <> 'sold';
  update public.auction_state
     set status = 'idle', current_lot_id = null, current_price = 0,
         leading_team_id = null, updated_at = now()
   where id = 1;
end $$;
create or replace function public.auction_undo_sale(p_lot_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_team int; v_price numeric;
begin
  if not public.is_auction_staff() then
    raise exception 'Only tournament staff can undo a sale';
  end if;
  select sold_to_team_id, sold_price into v_team, v_price
    from public.auction_lots where id = p_lot_id and status = 'sold' for update;
  if v_team is null then raise exception 'That lot is not sold'; end if;
  update public.auction_teams
     set purse_spent = greatest(purse_spent - v_price, 0)
   where id = v_team;
  update public.auction_lots
     set status = 'pool', sold_to_team_id = null, sold_price = null, sold_at = null
   where id = p_lot_id;
end $$;
create or replace function public.auction_reset()
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_auction_staff() then
    raise exception 'Only tournament staff can reset the auction';
  end if;
  update public.auction_lots
     set status = 'pool', sold_to_team_id = null, sold_price = null, sold_at = null;
  update public.auction_teams set purse_spent = 0;
  delete from public.auction_bids;
  update public.auction_state
     set status = 'idle', current_lot_id = null, current_price = 0,
         leading_team_id = null, message = null, updated_at = now()
   where id = 1;
end $$;
grant execute on function
  public.auction_sync_players(boolean),
  public.auction_start_lot(uuid, numeric),
  public.auction_bid(int, numeric),
  public.auction_sell(uuid, int, numeric),
  public.auction_mark_unsold(uuid),
  public.auction_undo_sale(uuid),
  public.auction_reset(),
  public.auction_team_of(uuid),
  public.is_auction_staff(),
  public.my_auction_team()
to authenticated;
do $$
declare t text;
begin
  foreach t in array array['auction_lots','auction_teams','auction_state','auction_bids'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when others then
      raise notice 'Realtime not enabled for % (%). The app still works.', t, sqlerrm;
    end;
  end loop;
end $$;
do $$
begin
  notify pgrst, 'reload schema';
exception when others then
  raise notice 'Could not notify PostgREST (%). Reload it from Settings -> API if the app cannot see the tables.', sqlerrm;
end $$;

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
  select coalesce(array_agg(password), array[]::text[]) into used
    from public.auction_team_logins;
  for team_no in 1..16 loop
    v_email := 'team' || team_no || '@monsoonpickleleague.in';
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
    update public.auction_teams set auth_user_id = uid where id = team_no;
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


notify pgrst, 'reload schema';

select l.username, 'created' as account,
  case when u.id is null then 'MISSING'
       when u.encrypted_password <> crypt(l.password, u.encrypted_password) then 'PASSWORD MISMATCH'
       when t.auth_user_id is distinct from u.id then 'NOT LINKED'
       else 'OK' end as status
from public.auction_team_logins l
left join auth.users u on u.email = l.email
left join public.auction_teams t on t.id = l.team_id
order by l.team_id;
