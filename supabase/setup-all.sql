-- ============================================================
--  MONSOON PICKLE LEAGUE — COMPLETE ONE-PASTE SETUP
--
--  Paste this entire file into Supabase → SQL Editor → Run.
--  It is idempotent: safe to run again at any time.
--
--  It installs, in order:
--    1. Registration schema  (registrations, event_settings, storage, RLS)
--    2. Auction schema       (teams, lots, state, bids, credentials, RPCs)
--    3. Organiser login      ishanvashistha.1993@gmail.com / Pickle2026
--    4. All 16 captain logins Team1…Team16 with their passwords
--
--  The last statement prints a verification table — every row should
--  read "OK".
--
--  GENERATED FILE — edit the sources and re-run build-setup-all.sh:
--    schema.sql · auction-schema.sql · create-admin.sql · team-logins.sql
-- ============================================================

-- pgcrypto provides crypt()/gen_salt() used to hash the login passwords.
-- Supabase keeps it in the "extensions" schema; a plain psql connection
-- does not have that on its search_path, so make it reachable either way.
do $$
begin
  create extension if not exists pgcrypto with schema extensions;
exception when others then
  begin
    create extension if not exists pgcrypto;
  exception when others then null;
  end;
end $$;

select set_config('search_path', current_setting('search_path') || ', extensions', false);



-- ############################################################
-- ### schema.sql
-- ############################################################

-- ============================================================
-- MONSOON PICKLE LEAGUE — SUPABASE SCHEMA
-- Run this once in your Supabase project's SQL Editor.
-- (Dashboard → SQL Editor → New query → paste → Run)
-- Safe to re-run: everything is IF NOT EXISTS / idempotent.
-- ============================================================

-- 1) Registrations table ---------------------------------------------------
create table if not exists public.registrations (
  id                      uuid primary key default gen_random_uuid(),
  created_at              timestamptz not null default now(),
  reg_code                text not null unique,
  full_name               text not null,
  phone                   text not null,
  email                   text,
  gender                  text not null,
  dupr                    numeric(5,3),
  jersey_size             text not null,
  jersey_name             text not null,
  payment_method          text not null check (payment_method in ('Cash','Online')),
  profile_pic_url         text,
  payment_screenshot_url  text,
  status                  text not null default 'pending'
                          check (status in ('pending','verified','checked-in','rejected'))
);

alter table public.registrations enable row level security;

-- Hardening: bound every column the anonymous role can write, so the
-- public insert policy can't be abused to stuff megabytes of junk.
do $$
begin
  alter table public.registrations
    add constraint reg_full_name_len     check (char_length(full_name)    between 1 and 120),
    add constraint reg_phone_len         check (char_length(phone)        between 7 and 20),
    add constraint reg_email_len         check (email is null or char_length(email) <= 160),
    add constraint reg_gender_valid      check (gender in ('Male','Female','Other')),
    add constraint reg_dupr_range        check (dupr is null or (dupr >= 0 and dupr <= 8)),
    add constraint reg_jersey_size_valid check (jersey_size in ('XS','S','M','L','XL','XXL')),
    add constraint reg_jersey_name_len   check (char_length(jersey_name)  between 1 and 12),
    add constraint reg_code_len          check (char_length(reg_code)     between 6 and 24),
    add constraint reg_pic_url_len       check (profile_pic_url is null or char_length(profile_pic_url) <= 500),
    add constraint reg_shot_url_len      check (payment_screenshot_url is null or char_length(payment_screenshot_url) <= 500);
exception when duplicate_object then null;
end $$;

-- Migration: earlier versions also collected an event category + partner name.
-- Those fields were removed from the registration form; drop the columns (and
-- their constraints) if an older database still has them. Safe to re-run.
alter table public.registrations drop column if exists category;
alter table public.registrations drop column if exists partner_name;

-- Anyone (the public form) may INSERT a registration…
drop policy if exists "public can register" on public.registrations;
create policy "public can register"
  on public.registrations for insert
  to anon
  with check (true);

-- …but only signed-in staff can read / manage entries.
drop policy if exists "staff can read" on public.registrations;
create policy "staff can read"
  on public.registrations for select
  to authenticated
  using (true);

drop policy if exists "staff can insert" on public.registrations;
create policy "staff can insert"
  on public.registrations for insert
  to authenticated
  with check (true);

drop policy if exists "staff can update" on public.registrations;
create policy "staff can update"
  on public.registrations for update
  to authenticated
  using (true);

drop policy if exists "staff can delete" on public.registrations;
create policy "staff can delete"
  on public.registrations for delete
  to authenticated
  using (true);

-- 2) Event settings (admin console → Event Controls) ------------------------
create table if not exists public.event_settings (
  id                 int primary key check (id = 1),
  registration_open  boolean not null default true,
  banner_message     text check (banner_message is null or char_length(banner_message) <= 200),
  updated_at         timestamptz not null default now()
);

insert into public.event_settings (id, registration_open)
values (1, true)
on conflict (id) do nothing;

alter table public.event_settings enable row level security;

-- The public form reads settings (open/closed + banner)…
drop policy if exists "public can read settings" on public.event_settings;
create policy "public can read settings"
  on public.event_settings for select
  to anon, authenticated
  using (true);

-- …only staff can change them.
drop policy if exists "staff can update settings" on public.event_settings;
create policy "staff can update settings"
  on public.event_settings for update
  to authenticated
  using (true);

drop policy if exists "staff can insert settings" on public.event_settings;
create policy "staff can insert settings"
  on public.event_settings for insert
  to authenticated
  with check (true);

-- 3) Realtime — new registrations appear live in the admin console ----------
do $$
begin
  alter publication supabase_realtime add table public.registrations;
exception when duplicate_object then null;
end $$;

-- 4) Storage bucket for profile photos + payment screenshots ---------------
-- Hardened: 8 MB cap per file, images only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'registrations', 'registrations', true,
  8388608,
  array['image/jpeg','image/png','image/webp','image/heic','image/heif']
)
on conflict (id) do update
  set file_size_limit   = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- The public form may upload into profile/ and payment/ folders only.
drop policy if exists "public can upload registration images" on storage.objects;
create policy "public can upload registration images"
  on storage.objects for insert
  to anon
  with check (
    bucket_id = 'registrations'
    and (storage.foldername(name))[1] in ('profile', 'payment')
  );

-- Staff may upload/replace images from the admin console.
drop policy if exists "staff can upload registration images" on storage.objects;
create policy "staff can upload registration images"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'registrations');

drop policy if exists "staff can replace registration images" on storage.objects;
create policy "staff can replace registration images"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'registrations');

-- Image reads: the bucket's `public` flag already serves any *known* object URL
-- (that's how the admin panel loads thumbnails), so we do NOT grant the anon role
-- a blanket SELECT here. Without it, an anonymous visitor cannot LIST/enumerate
-- the bucket — so profile photos and payment screenshots can't be scraped, even
-- though staff and known direct URLs keep working. Only signed-in staff may list.
drop policy if exists "public can view registration images" on storage.objects;
drop policy if exists "staff can view registration images" on storage.objects;
create policy "staff can view registration images"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'registrations');

-- Staff may clean up images.
drop policy if exists "staff can delete registration images" on storage.objects;
create policy "staff can delete registration images"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'registrations');

-- ============================================================
-- NEXT: create the organiser login.
-- Easiest: Dashboard → Authentication → Users → "Add user"
-- Or run supabase/create-admin.sql for a ready-made account.
-- ============================================================


-- ############################################################
-- ### auction-schema.sql
-- ############################################################

-- ============================================================
-- MONSOON PICKLE LEAGUE — TEAM AUCTION SCHEMA
--
-- Run ONCE in Supabase → SQL Editor, AFTER supabase/schema.sql.
-- Safe to re-run: every statement is idempotent.
--
-- This file only ADDS auction objects. It does not modify the
-- registrations table used by the live registration form, except
-- to tighten who may READ it (team captains are excluded).
-- ============================================================

-- ------------------------------------------------------------
-- 0) Helpers — who is a team captain, who is staff?
--    Staff = any signed-in user that is NOT one of the 16 teams.
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- 1) Seed the 16 teams (only if they don't exist yet)
-- ------------------------------------------------------------
insert into public.auction_teams (id, name)
select g, 'Team ' || g from generate_series(1, 16) g
on conflict (id) do nothing;

-- ------------------------------------------------------------
-- 2) Auction lots — one row per player who can be auctioned.
--    Player details are COPIED here so team captains never need
--    read access to the registrations table (no phone / email /
--    payment screenshots are exposed to captains).
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- 3) Auction state — single row that drives every live screen
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- 3b) Team login credentials — STAFF ONLY.
--     Supabase stores only a bcrypt hash of each password, so it can
--     never be read back. The organiser still needs to look up and
--     re-issue captain credentials during the event, so the console
--     keeps the current password here. RLS makes this table invisible
--     to captains and to the public — only staff can read or write it.
-- ------------------------------------------------------------
create table if not exists public.auction_team_logins (
  team_id     int primary key references public.auction_teams(id) on delete cascade,
  username    text not null,
  email       text not null,
  password    text not null,
  updated_at  timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 4) Bid log — audit trail + live ticker
-- ------------------------------------------------------------
create table if not exists public.auction_bids (
  id          bigserial primary key,
  lot_id      uuid not null references public.auction_lots(id) on delete cascade,
  team_id     int  not null references public.auction_teams(id) on delete cascade,
  amount      numeric(12,2) not null check (amount >= 0),
  created_at  timestamptz not null default now()
);

create index if not exists auction_bids_lot_idx on public.auction_bids (lot_id, id desc);

-- ============================================================
-- 5) ROW LEVEL SECURITY
-- ============================================================
alter table public.auction_teams enable row level security;
alter table public.auction_lots  enable row level security;
alter table public.auction_state enable row level security;
alter table public.auction_bids  enable row level security;

-- Teams table: every signed-in user may read (auction transparency);
-- only staff may change purses, captains, squad limits.
drop policy if exists "auth can read teams" on public.auction_teams;
create policy "auth can read teams"
  on public.auction_teams for select to authenticated using (true);

drop policy if exists "staff manage teams" on public.auction_teams;
create policy "staff manage teams"
  on public.auction_teams for all to authenticated
  using (public.is_auction_staff()) with check (public.is_auction_staff());

-- Lots: readable by everyone signed in; only staff may write directly
-- (sales go through the RPCs below so wallets stay in sync).
drop policy if exists "auth can read lots" on public.auction_lots;
create policy "auth can read lots"
  on public.auction_lots for select to authenticated using (true);

drop policy if exists "staff manage lots" on public.auction_lots;
create policy "staff manage lots"
  on public.auction_lots for all to authenticated
  using (public.is_auction_staff()) with check (public.is_auction_staff());

-- State: readable by all signed in; only staff may write.
drop policy if exists "auth can read state" on public.auction_state;
create policy "auth can read state"
  on public.auction_state for select to authenticated using (true);

drop policy if exists "staff manage state" on public.auction_state;
create policy "staff manage state"
  on public.auction_state for all to authenticated
  using (public.is_auction_staff()) with check (public.is_auction_staff());

-- Team logins: STAFF ONLY — captains must never see another team's password
-- (or their own, via the API). No policy exists for anon, so it is unreachable
-- from the public site.
alter table public.auction_team_logins enable row level security;

drop policy if exists "staff manage team logins" on public.auction_team_logins;
create policy "staff manage team logins"
  on public.auction_team_logins for all to authenticated
  using (public.is_auction_staff()) with check (public.is_auction_staff());

-- Bids: readable by all signed in; inserts happen through auction_bid().
drop policy if exists "auth can read bids" on public.auction_bids;
create policy "auth can read bids"
  on public.auction_bids for select to authenticated using (true);

drop policy if exists "staff manage bids" on public.auction_bids;
create policy "staff manage bids"
  on public.auction_bids for all to authenticated
  using (public.is_auction_staff()) with check (public.is_auction_staff());

-- ------------------------------------------------------------
-- 5b) Keep captains OUT of the registrations table.
--     Staff (the organiser console) keeps full access exactly as
--     before; the public form's INSERT policy is untouched.
-- ------------------------------------------------------------
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

-- ============================================================
-- 6) RPCs — all money movement is atomic and server-validated
-- ============================================================

-- Copy registered players into the auction pool (staff only).
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

-- Put a player on the block (staff only).
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

  -- any previously live lot goes back to the pool
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

-- Place a bid (team captains; staff may bid on a team's behalf).
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

  -- first bid meets the base price; later bids step up by the increment
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

-- Finalise a sale: assign the player and deduct the wallet atomically.
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

-- Mark the live lot unsold and clear the block (staff only).
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

-- Undo a sale: refund the wallet and return the player to the pool.
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

-- Full reset: return every player to the pool and refill all purses.
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

-- ============================================================
-- 7) Realtime — live updates on every auction screen
-- ============================================================
do $$
begin
  alter publication supabase_realtime add table public.auction_lots;
exception when duplicate_object then null; when undefined_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.auction_teams;
exception when duplicate_object then null; when undefined_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.auction_state;
exception when duplicate_object then null; when undefined_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.auction_bids;
exception when duplicate_object then null; when undefined_object then null;
end $$;

-- ============================================================
-- NEXT: create the 16 team logins.
-- Easiest: Organiser Console → Auction tab → "Create 16 team logins"
-- (paste the Supabase secret key once).
-- Or run supabase/auction-team-logins.sql in this SQL Editor.
-- ============================================================


-- ############################################################
-- ### create-admin.sql
-- ############################################################

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
end $$;


-- ############################################################
-- ### team-logins.sql
-- ############################################################

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
