-- ============================================================
--  MONSOON PICKLE LEAGUE — COMPLETE ONE-PASTE SETUP
--
--  Paste this entire file into Supabase → SQL Editor → Run.
--  It is idempotent: safe to run again at any time.
--
--  It installs, in order:
--    1. Registration schema  (registrations, event_settings, storage, RLS)
--    2. Auction schema       (teams, lots, state, bids, credentials, RPCs)
--                            plus the public.app_staff allow-list that
--                            decides who counts as staff
--    3. Organiser login      read from `set mpl.admin_password = '...'`
--                            (no password is stored in this repo)
--    4. All 16 captain logins Team1…Team16, passwords generated on first
--                            run and readable only in the console
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
do $$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values (
    'registrations', 'registrations', true,
    8388608,
    array['image/jpeg','image/png','image/webp','image/heic','image/heif']
  )
  on conflict (id) do update
    set file_size_limit    = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
exception when others then
  raise notice 'Could not create the storage bucket (%). Create it manually in Storage if uploads fail.', sqlerrm;
end $$;

-- The public form may upload into profile/ and payment/ folders only.
do $$
begin
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
  
exception when others then
  raise notice 'Storage policies skipped (%). Set them in Storage -> Policies if uploads fail.', sqlerrm;
end $$;
-- ============================================================
-- NEXT: create the organiser login.
-- Easiest: Dashboard → Authentication → Users → "Add user"
-- Or run supabase/create-admin.sql for a ready-made account.
-- ============================================================

-- ------------------------------------------------------------
-- Do not undo the auction module's hardening.
--
-- The "staff can ..." policies above grant every signed-in user full
-- access. That was fine when the organiser was the only account, but
-- once the 16 captain logins exist it would hand them the registrant
-- list, the payment screenshots and the event controls. If the auction
-- module is installed, re-assert its allow-list policies here so that
-- re-running this file standalone can never reopen that hole.
-- ------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.is_auction_staff()') is null then
    return;
  end if;

  drop policy if exists "staff can read" on public.registrations;
  create policy "staff can read" on public.registrations
    for select to authenticated using (public.is_auction_staff());

  drop policy if exists "staff can insert" on public.registrations;
  create policy "staff can insert" on public.registrations
    for insert to authenticated with check (public.is_auction_staff());

  drop policy if exists "staff can update" on public.registrations;
  create policy "staff can update" on public.registrations
    for update to authenticated
    using (public.is_auction_staff()) with check (public.is_auction_staff());

  drop policy if exists "staff can delete" on public.registrations;
  create policy "staff can delete" on public.registrations
    for delete to authenticated using (public.is_auction_staff());

  drop policy if exists "staff can insert settings" on public.event_settings;
  create policy "staff can insert settings" on public.event_settings
    for insert to authenticated with check (public.is_auction_staff());

  drop policy if exists "staff can update settings" on public.event_settings;
  create policy "staff can update settings" on public.event_settings
    for update to authenticated
    using (public.is_auction_staff()) with check (public.is_auction_staff());

  begin
    drop policy if exists "staff can view registration images" on storage.objects;
    create policy "staff can view registration images" on storage.objects
      for select to authenticated
      using (bucket_id = 'registrations' and public.is_auction_staff());

    drop policy if exists "staff can upload registration images" on storage.objects;
    create policy "staff can upload registration images" on storage.objects
      for insert to authenticated
      with check (bucket_id = 'registrations' and public.is_auction_staff());

    drop policy if exists "staff can replace registration images" on storage.objects;
    create policy "staff can replace registration images" on storage.objects
      for update to authenticated
      using (bucket_id = 'registrations' and public.is_auction_staff());

    drop policy if exists "staff can delete registration images" on storage.objects;
    create policy "staff can delete registration images" on storage.objects
      for delete to authenticated
      using (bucket_id = 'registrations' and public.is_auction_staff());
  exception when insufficient_privilege then
    raise notice 'Could not re-harden storage policies (%). Apply them from the SQL Editor.', sqlerrm;
  end;

  raise notice 'Auction module detected - staff policies kept on the allow-list.';
end $$;

-- ------------------------------------------------------------
-- Tell PostgREST to reload its schema cache.
-- The Supabase SQL Editor does this for you; a direct psql/CI
-- connection does NOT, and without it the REST API keeps replying
-- "table not found" for everything created above.
-- ------------------------------------------------------------
do $$
begin
  notify pgrst, 'reload schema';
exception when others then
  raise notice 'Could not notify PostgREST (%). Reload it from Settings -> API if the app cannot see the tables.', sqlerrm;
end $$;


-- ############################################################
-- ### auction-schema.sql
-- ############################################################

-- ============================================================
-- MONSOON PICKLE LEAGUE — AUCTION: HARDENED PRODUCTION INSTALL
--
-- Additive. Does not touch the 77 live registrations, the public
-- registration form (anon INSERT), or event_settings data.
--
-- Differences vs supabase/auction-schema.sql (all deliberate fixes):
--   * staff is now an explicit ALLOW-LIST (public.app_staff), not
--     "anyone signed in who is not a team". Public signup is enabled
--     on this project, so the old deny-list handed staff rights to
--     any stranger who registered an account.
--   * event_settings + the registrations storage bucket are locked to
--     staff, so the 16 new captain logins cannot close registration
--     or list/delete payment screenshots.
--   * auction_bid enforces a server-side minimum on the FIRST bid.
--   * auction_start_lot refuses to re-list a sold lot.
--   * auction_sell is bound to the lot actually on the block.
--   * auction_undo_sale handles a NULL sold_price.
--   * purse_total can never be set below purse_spent.
--   * auction_sync_players continues lot_order instead of restarting.
--   * auction_lots.registration_id is ON DELETE SET NULL (was CASCADE,
--     which silently voided sold lots and corrupted team purses).
--   * every auction RPC is revoked from PUBLIC/anon.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 0) STAFF ALLOW-LIST
-- ------------------------------------------------------------
create table if not exists public.app_staff (
  user_id    uuid primary key,
  email      text,
  note       text,
  created_at timestamptz not null default now()
);

alter table public.app_staff enable row level security;
-- Deliberately NO policies: unreachable from anon and authenticated.
-- Only service_role and SECURITY DEFINER functions can see it.

-- Seed staff ONCE, from the accounts that already existed before the
-- captain logins were created (i.e. every auth user not linked to a team).
-- Runs only while the allow-list is empty, so re-installing never re-adds
-- an account you deliberately removed, and never promotes a captain.
insert into public.app_staff (user_id, email, note)
select u.id, u.email, 'seeded at auction install'
  from auth.users u
 where not exists (select 1 from public.app_staff)
   and not exists (select 1 from public.auction_teams t where t.auth_user_id = u.id)
on conflict (user_id) do nothing;

-- Abort the whole migration rather than lock the organiser out.
do $$
begin
  if (select count(*) from public.app_staff) = 0 then
    raise exception 'Refusing to continue: app_staff is empty, this would lock the admin console out';
  end if;
end $$;

-- ------------------------------------------------------------
-- 1) TEAMS
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

-- A team can never be over-committed: purse_total >= purse_spent.
alter table public.auction_teams drop constraint if exists auction_teams_purse_solvent;
alter table public.auction_teams
  add constraint auction_teams_purse_solvent check (purse_total >= purse_spent);

insert into public.auction_teams (id, name)
select g, 'Team ' || g from generate_series(1, 16) g
on conflict (id) do nothing;

-- ------------------------------------------------------------
-- 2) IDENTITY HELPERS  (allow-list based)
-- ------------------------------------------------------------
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
  select exists (
    select 1 from public.app_staff s where s.user_id = auth.uid()
  );
$$;

create or replace function public.my_auction_team()
returns int
language sql stable security definer set search_path = public
as $$
  select public.auction_team_of(auth.uid());
$$;

-- ------------------------------------------------------------
-- 3) LOTS / STATE / BIDS / LOGINS
-- ------------------------------------------------------------
create table if not exists public.auction_lots (
  id                uuid primary key default gen_random_uuid(),
  registration_id   uuid unique references public.registrations(id) on delete set null,
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

-- ------------------------------------------------------------
-- 4) RLS on the auction tables
-- ------------------------------------------------------------
alter table public.auction_teams       enable row level security;
alter table public.auction_lots        enable row level security;
alter table public.auction_state       enable row level security;
alter table public.auction_bids        enable row level security;
alter table public.auction_team_logins enable row level security;

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

drop policy if exists "auth can read bids" on public.auction_bids;
create policy "auth can read bids"
  on public.auction_bids for select to authenticated using (true);
drop policy if exists "staff manage bids" on public.auction_bids;
create policy "staff manage bids"
  on public.auction_bids for all to authenticated
  using (public.is_auction_staff()) with check (public.is_auction_staff());

-- Captain passwords: staff only, never captains, never anon.
drop policy if exists "staff manage team logins" on public.auction_team_logins;
create policy "staff manage team logins"
  on public.auction_team_logins for all to authenticated
  using (public.is_auction_staff()) with check (public.is_auction_staff());

-- ------------------------------------------------------------
-- 5) Lock the EXISTING surfaces down to staff.
--    The anon policies used by the public registration form are
--    deliberately left untouched.
-- ------------------------------------------------------------
drop policy if exists "staff can read" on public.registrations;
create policy "staff can read"
  on public.registrations for select to authenticated
  using (public.is_auction_staff());

drop policy if exists "staff can update" on public.registrations;
create policy "staff can update"
  on public.registrations for update to authenticated
  using (public.is_auction_staff()) with check (public.is_auction_staff());

drop policy if exists "staff can delete" on public.registrations;
create policy "staff can delete"
  on public.registrations for delete to authenticated
  using (public.is_auction_staff());

drop policy if exists "staff can insert" on public.registrations;
create policy "staff can insert"
  on public.registrations for insert to authenticated
  with check (public.is_auction_staff());

-- event_settings: public may still READ (the site shows the banner),
-- but only staff may change it. Previously any authenticated user
-- could close registration.
drop policy if exists "staff can insert settings" on public.event_settings;
create policy "staff can insert settings"
  on public.event_settings for insert to authenticated
  with check (public.is_auction_staff());

drop policy if exists "staff can update settings" on public.event_settings;
create policy "staff can update settings"
  on public.event_settings for update to authenticated
  using (public.is_auction_staff()) with check (public.is_auction_staff());

-- Storage: keep the anon upload path the registration form needs,
-- restrict listing / replacing / deleting to staff.
drop policy if exists "staff can view registration images" on storage.objects;
create policy "staff can view registration images"
  on storage.objects for select to authenticated
  using (bucket_id = 'registrations' and public.is_auction_staff());

drop policy if exists "staff can upload registration images" on storage.objects;
create policy "staff can upload registration images"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'registrations' and public.is_auction_staff());

drop policy if exists "staff can replace registration images" on storage.objects;
create policy "staff can replace registration images"
  on storage.objects for update to authenticated
  using (bucket_id = 'registrations' and public.is_auction_staff());

drop policy if exists "staff can delete registration images" on storage.objects;
create policy "staff can delete registration images"
  on storage.objects for delete to authenticated
  using (bucket_id = 'registrations' and public.is_auction_staff());

commit;


-- ============================================================
-- AUCTION RPCs (hardened)
-- ============================================================
begin;

-- Copy registered players into the pool. lot_order CONTINUES from the
-- current maximum instead of restarting at 1 on every incremental sync.
create or replace function public.auction_sync_players(p_only_verified boolean default false)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_added int;
  v_base  int;
begin
  if not public.is_auction_staff() then
    raise exception 'Only tournament staff can sync players';
  end if;

  select coalesce(max(lot_order), 0) into v_base from public.auction_lots;

  with inserted as (
    insert into public.auction_lots
      (registration_id, player_name, gender, dupr, jersey_size, jersey_name, photo_url, lot_order)
    select r.id, r.full_name, r.gender, r.dupr, r.jersey_size, r.jersey_name, r.profile_pic_url,
           v_base + row_number() over (order by r.created_at)
      from public.registrations r
     where (not p_only_verified or r.status in ('verified','checked-in'))
       and not exists (select 1 from public.auction_lots l where l.registration_id = r.id)
    returning 1
  )
  select count(*) into v_added from inserted;

  return v_added;
end $$;

-- Put a player on the block. Refuses to re-list a SOLD lot, which
-- previously wiped the sale while leaving the buyer's purse deducted.
create or replace function public.auction_start_lot(p_lot_id uuid, p_base numeric default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_base   numeric;
  v_status text;
begin
  if not public.is_auction_staff() then
    raise exception 'Only tournament staff can start a lot';
  end if;

  select status, coalesce(p_base, base_price)
    into v_status, v_base
    from public.auction_lots where id = p_lot_id for update;
  if not found then raise exception 'Lot not found'; end if;

  if v_status = 'sold' then
    raise exception 'That player is already sold — undo the sale first';
  end if;

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

-- Place a bid. The minimum is computed SERVER-SIDE for both the opening
-- bid and every raise, so a captain cannot POST p_amount = 0 and win a
-- player for nothing.
create or replace function public.auction_bid(p_team_id int default null, p_amount numeric default null)
returns numeric
language plpgsql security definer set search_path = public
as $$
declare
  v_team    int;
  v_state   public.auction_state%rowtype;
  v_amount  numeric;
  v_min     numeric;
  v_lotbase numeric;
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

  select base_price into v_lotbase
    from public.auction_lots where id = v_state.current_lot_id;

  v_min := case
             when v_state.leading_team_id is null
               then greatest(v_state.current_price, coalesce(v_lotbase, 0))
             else v_state.current_price + v_state.bid_increment
           end;

  v_amount := coalesce(p_amount, v_min);

  if v_amount < v_min then
    raise exception 'Bid must be at least %', v_min;
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

-- Finalise a sale. Bound to the lot actually on the block so a stale
-- click cannot sell a different player.
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

  if v_state.status <> 'live' or v_state.current_lot_id is null then
    raise exception 'No player is on the block';
  end if;

  v_lot := coalesce(p_lot_id, v_state.current_lot_id);
  if v_lot <> v_state.current_lot_id then
    raise exception 'That player is not the one on the block';
  end if;

  v_team  := coalesce(p_team_id, v_state.leading_team_id);
  v_price := coalesce(p_price,   v_state.current_price);

  if v_team is null then raise exception 'No team selected — nobody has bid yet'; end if;
  if v_price is null or v_price < 0 then raise exception 'Invalid price'; end if;

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
declare
  v_state public.auction_state%rowtype;
  v_lot   uuid;
begin
  if not public.is_auction_staff() then
    raise exception 'Only tournament staff can do that';
  end if;

  select * into v_state from public.auction_state where id = 1 for update;
  v_lot := coalesce(p_lot_id, v_state.current_lot_id);
  if v_lot is null then raise exception 'No player is on the block'; end if;

  update public.auction_lots set status = 'unsold' where id = v_lot and status <> 'sold';

  update public.auction_state
     set status = 'idle', current_lot_id = null, current_price = 0,
         leading_team_id = null, updated_at = now()
   where id = 1;
end $$;

-- Undo a sale. Refunds the exact sold_price; a NULL price is treated as
-- a data error rather than silently zeroing the team's whole spend.
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
  if v_price is null then raise exception 'That sale has no recorded price — fix it in the console first'; end if;

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

  -- Every statement needs an explicit WHERE: Supabase's safeupdate guard
  -- rejects an unqualified UPDATE/DELETE with SQLSTATE 21000.
  update public.auction_lots
     set status = 'pool', sold_to_team_id = null, sold_price = null, sold_at = null
   where status <> 'pool'
      or sold_to_team_id is not null
      or sold_price is not null
      or sold_at is not null;

  update public.auction_teams
     set purse_spent = 0
   where purse_spent <> 0;

  delete from public.auction_bids where id is not null;

  update public.auction_state
     set status = 'idle', current_lot_id = null, current_price = 0,
         leading_team_id = null, message = null, updated_at = now()
   where id = 1;
end $$;

-- ------------------------------------------------------------
-- Grants: authenticated only. Strip the implicit PUBLIC grant so the
-- anon key cannot reach any auction RPC.
-- ------------------------------------------------------------
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.auction_sync_players(boolean)',
    'public.auction_start_lot(uuid, numeric)',
    'public.auction_bid(int, numeric)',
    'public.auction_sell(uuid, int, numeric)',
    'public.auction_mark_unsold(uuid)',
    'public.auction_undo_sale(uuid)',
    'public.auction_reset()',
    'public.auction_team_of(uuid)',
    'public.is_auction_staff()',
    'public.my_auction_team()'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;

commit;

-- Realtime (best effort — never abort the install for it)
do $$
declare t text;
begin
  foreach t in array array['auction_lots','auction_teams','auction_state','auction_bids'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when others then
      raise notice 'Realtime not enabled for % (%)', t, sqlerrm;
    end;
  end loop;
end $$;

notify pgrst, 'reload schema';

-- Defence in depth: RLS is the only thing standing between anon and these
-- two tables, because Supabase grants anon/authenticated full DML on every
-- table in public by default. Drop those grants so that disabling RLS by
-- accident cannot expose the staff allow-list or the captain passwords.
revoke all on public.app_staff           from anon, authenticated;
revoke all on public.auction_team_logins from anon, authenticated;

-- The console reads and writes the captain passwords as a signed-in staff
-- user, so authenticated still needs table-level DML there; RLS then narrows
-- it to staff only. app_staff stays reachable only via SECURITY DEFINER.
grant select, insert, update, delete on public.auction_team_logins to authenticated;

notify pgrst, 'reload schema';


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


-- ############################################################
-- ### team-logins.sql
-- ############################################################


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
