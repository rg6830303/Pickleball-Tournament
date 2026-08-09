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


create table if not exists public.auction_state (
  id               int primary key check (id = 1),
  status           text not null default 'idle'
                   check (status in ('idle','live','paused','done')),
  current_lot_id   uuid,   -- FK added once auction_pool exists (below)
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
  lot_id      uuid not null,   -- FK added once auction_pool exists (below)
  team_id     int  not null references public.auction_teams(id) on delete cascade,
  amount      numeric(12,2) not null check (amount >= 0),
  created_at  timestamptz not null default now()
);
create index if not exists auction_bids_lot_idx on public.auction_bids (lot_id, id desc);

-- ------------------------------------------------------------
-- 4) RLS on the auction tables
-- ------------------------------------------------------------
alter table public.auction_teams       enable row level security;
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
-- ============================================================
-- AUCTION POOL — the auction now runs off the curated player list
-- (Sheet2 of "MPL TEAM LIST"), not off the registration form.
--
-- Registrations stay OPEN and untouched: players keep filling the form,
-- and each pool entry is joined to its registration by a Player Key that
-- the organiser types in by hand.
-- ============================================================
begin;

-- ------------------------------------------------------------
-- 0) NOTHING is cleared here on purpose.
--    This file is re-run by the console's install button and by CI, and
--    an auction may be half-finished when that happens. Zeroing purses or
--    deleting bids here would refund every team while leaving the players
--    they already bought assigned to them. Use the console's Reset button
--    (auction_reset()) when you actually want to start over.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 1) Player Key on registrations (manual, typed by the organiser).
--    Unique only where present, so the 77 existing rows stay valid.
-- ------------------------------------------------------------
alter table public.registrations add column if not exists player_key text;

create unique index if not exists registrations_player_key_uidx
  on public.registrations (player_key)
  where player_key is not null and player_key <> '';

-- ------------------------------------------------------------
-- 2) Team economics: 10 lakh purse, 9-player squad,
--    and the per-category quota 1 A + 4 B + 4 C.
-- ------------------------------------------------------------
alter table public.auction_teams add column if not exists max_a int not null default 1;
alter table public.auction_teams add column if not exists max_b int not null default 4;
alter table public.auction_teams add column if not exists max_c int not null default 4;

alter table public.auction_teams alter column purse_total set default 1000000;
alter table public.auction_teams alter column max_squad  set default 9;

update public.auction_teams
   set purse_total = 1000000, max_squad = 9, max_a = 1, max_b = 4, max_c = 4
 where purse_total <> 1000000 or max_squad <> 9
    or max_a <> 1 or max_b <> 4 or max_c <> 4;

-- ------------------------------------------------------------
-- 3) Category catalogue — one place that owns the base prices.
-- ------------------------------------------------------------
create table if not exists public.auction_categories (
  code       text primary key check (code in ('A','B','C')),
  label      text not null,
  base_price numeric(12,2) not null check (base_price >= 0),
  per_team   int not null check (per_team >= 0),
  sort_order int not null default 0
);

insert into public.auction_categories (code, label, base_price, per_team, sort_order) values
  ('A', 'Advance',      50000, 1, 1),
  ('B', 'Intermediate', 30000, 4, 2),
  ('C', 'Beginner',     20000, 4, 3)
on conflict (code) do update
  set label = excluded.label,
      base_price = excluded.base_price,
      per_team = excluded.per_team,
      sort_order = excluded.sort_order;

-- ------------------------------------------------------------
-- 4) The pool itself.
--    photo_url / sex / age / dupr are OVERRIDES: left null, the player
--    card falls back to the linked registration. Filled in, they win.
--    That is how a player with no registration still gets a card.
-- ------------------------------------------------------------
create table if not exists public.auction_pool (
  id              uuid primary key default gen_random_uuid(),
  sl_no           int unique,
  player_key      text,
  name            text not null default '',
  category        text not null references public.auction_categories(code),
  base_price      numeric(12,2) not null check (base_price >= 0),

  photo_url       text,
  sex             text check (sex is null or sex in ('Male','Female','Other')),
  age             int  check (age is null or (age between 5 and 100)),
  dupr            numeric(5,3) check (dupr is null or (dupr >= 0 and dupr <= 8)),
  notes           text,

  status          text not null default 'pool'
                  check (status in ('pool','live','sold','unsold')),
  sold_to_team_id int references public.auction_teams(id) on delete set null,
  sold_price      numeric(12,2) check (sold_price is null or sold_price >= 0),
  sold_at         timestamptz,
  created_at      timestamptz not null default now()
);

create unique index if not exists auction_pool_player_key_uidx
  on public.auction_pool (player_key)
  where player_key is not null and player_key <> '';

create index if not exists auction_pool_status_idx   on public.auction_pool (status);
create index if not exists auction_pool_category_idx on public.auction_pool (category);
create index if not exists auction_pool_team_idx     on public.auction_pool (sold_to_team_id);

-- ------------------------------------------------------------
-- 5) The live block now points at a pool entry, not a registration lot.
-- ------------------------------------------------------------
alter table public.auction_state
  drop constraint if exists auction_state_current_lot_id_fkey;
alter table public.auction_state
  add constraint auction_state_current_lot_id_fkey
  foreign key (current_lot_id) references public.auction_pool(id) on delete set null;

alter table public.auction_bids
  drop constraint if exists auction_bids_lot_id_fkey;
alter table public.auction_bids
  add constraint auction_bids_lot_id_fkey
  foreign key (lot_id) references public.auction_pool(id) on delete cascade;

-- ------------------------------------------------------------
-- 6) auction_lots was a copy of the registration table and is now
--    replaced by auction_pool. It holds no auction result worth keeping
--    (the sale above was reversed), so retire it rather than leave a
--    second, silently diverging source of truth.
-- ------------------------------------------------------------
drop table if exists public.auction_lots cascade;

-- ------------------------------------------------------------
-- 7) RLS
-- ------------------------------------------------------------
alter table public.auction_pool       enable row level security;
alter table public.auction_categories enable row level security;

drop policy if exists "auth can read pool" on public.auction_pool;
create policy "auth can read pool"
  on public.auction_pool for select to authenticated using (true);

drop policy if exists "staff manage pool" on public.auction_pool;
create policy "staff manage pool"
  on public.auction_pool for all to authenticated
  using (public.is_auction_staff()) with check (public.is_auction_staff());

drop policy if exists "auth can read categories" on public.auction_categories;
create policy "auth can read categories"
  on public.auction_categories for select to authenticated using (true);

drop policy if exists "staff manage categories" on public.auction_categories;
create policy "staff manage categories"
  on public.auction_categories for all to authenticated
  using (public.is_auction_staff()) with check (public.is_auction_staff());

commit;
-- ============================================================
-- AUCTION RPCs — rebuilt on auction_pool, with category quotas
-- ============================================================
begin;

-- How many players of one category a team already holds.
create or replace function public.auction_team_cat_count(p_team int, p_cat text)
returns int
language sql stable security definer set search_path = public
as $$
  select count(*)::int from public.auction_pool
   where sold_to_team_id = p_team and status = 'sold' and category = p_cat;
$$;

-- The quota for one category on one team.
create or replace function public.auction_team_cat_max(p_team int, p_cat text)
returns int
language sql stable security definer set search_path = public
as $$
  select case p_cat when 'A' then t.max_a when 'B' then t.max_b when 'C' then t.max_c else 0 end
    from public.auction_teams t where t.id = p_team;
$$;

-- The registration-form entry a pool player is joined to, if any.
-- SECURITY DEFINER on purpose: it must read public.registrations, which is
-- staff-only, but it returns ONLY the three columns a player card needs.
-- No phone, no email, no payment screenshot ever leaves this function.
create or replace function public.auction_player_card(p_pool_id uuid)
returns table (
  id uuid, sl_no int, player_key text, name text,
  category text, category_label text, base_price numeric,
  photo_url text, sex text, age int, dupr numeric,
  has_registration boolean, status text,
  sold_to_team_id int, sold_price numeric
)
language sql stable security definer set search_path = public
as $$
  select p.id, p.sl_no, p.player_key, p.name,
         p.category, c.label, p.base_price,
         coalesce(nullif(p.photo_url, ''), r.profile_pic_url),
         coalesce(nullif(p.sex, ''), r.gender),
         p.age,
         coalesce(p.dupr, r.dupr),
         (r.id is not null),
         p.status, p.sold_to_team_id, p.sold_price
    from public.auction_pool p
    join public.auction_categories c on c.code = p.category
    left join public.registrations r
           on p.player_key is not null and p.player_key <> ''
          and r.player_key = p.player_key
   where p.id = p_pool_id;
$$;

-- Put a player on the block.
create or replace function public.auction_start_lot(p_lot_id uuid, p_base numeric default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_base numeric; v_status text; v_name text;
begin
  if not public.is_auction_staff() then
    raise exception 'Only tournament staff can start a lot';
  end if;

  select status, name, coalesce(p_base, base_price)
    into v_status, v_name, v_base
    from public.auction_pool where id = p_lot_id for update;
  if not found then raise exception 'Player not found in the pool'; end if;

  if v_status = 'sold' then
    raise exception 'That player is already sold — undo the sale first';
  end if;
  if coalesce(trim(v_name), '') = '' then
    raise exception 'This pool slot has no player name yet — fill it in on the Auction Pool tab first';
  end if;

  update public.auction_pool set status = 'pool'
   where status = 'live' and id <> p_lot_id;

  update public.auction_pool
     set status = 'live', base_price = v_base,
         sold_to_team_id = null, sold_price = null, sold_at = null
   where id = p_lot_id;

  update public.auction_state
     set status = 'live', current_lot_id = p_lot_id, current_price = v_base,
         leading_team_id = null, message = null, updated_at = now()
   where id = 1;
end $$;

-- Place a bid. Enforces purse, total squad size AND the category quota,
-- so a team can never end up with two A players or a fifth B.
create or replace function public.auction_bid(p_team_id int default null, p_amount numeric default null)
returns numeric
language plpgsql security definer set search_path = public
as $$
declare
  v_team int; v_state public.auction_state%rowtype;
  v_amount numeric; v_min numeric; v_lotbase numeric; v_cat text; v_catlabel text;
  v_left numeric; v_squad int; v_max int; v_ccount int; v_cmax int;
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

  select p.base_price, p.category, c.label into v_lotbase, v_cat, v_catlabel
    from public.auction_pool p
    join public.auction_categories c on c.code = p.category
   where p.id = v_state.current_lot_id;

  v_min := case when v_state.leading_team_id is null
                then greatest(v_state.current_price, coalesce(v_lotbase, 0))
                else v_state.current_price + v_state.bid_increment end;
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

  select count(*) into v_squad from public.auction_pool
   where sold_to_team_id = v_team and status = 'sold';
  if v_squad >= v_max then
    raise exception 'Squad is already full (% players)', v_max;
  end if;

  v_ccount := public.auction_team_cat_count(v_team, v_cat);
  v_cmax   := public.auction_team_cat_max(v_team, v_cat);
  if v_ccount >= v_cmax then
    raise exception 'Your % quota is full (% of % players in category %)',
      v_catlabel, v_ccount, v_cmax, v_cat;
  end if;

  insert into public.auction_bids (lot_id, team_id, amount)
  values (v_state.current_lot_id, v_team, v_amount);

  update public.auction_state
     set current_price = v_amount, leading_team_id = v_team, updated_at = now()
   where id = 1;

  return v_amount;
end $$;

create or replace function public.auction_sell(
  p_lot_id uuid default null, p_team_id int default null, p_price numeric default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_state public.auction_state%rowtype;
  v_lot uuid; v_team int; v_price numeric; v_cat text; v_catlabel text;
  v_left numeric; v_squad int; v_max int; v_ccount int; v_cmax int;
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
  v_price := coalesce(p_price, v_state.current_price);
  if v_team is null then raise exception 'No team selected — nobody has bid yet'; end if;
  if v_price is null or v_price < 0 then raise exception 'Invalid price'; end if;

  select p.category, c.label into v_cat, v_catlabel
    from public.auction_pool p
    join public.auction_categories c on c.code = p.category
   where p.id = v_lot;

  select purse_left, max_squad into v_left, v_max
    from public.auction_teams where id = v_team for update;
  if v_left is null then raise exception 'Team not found'; end if;
  if v_price > v_left then
    raise exception 'Team has only % left in the purse', v_left;
  end if;

  select count(*) into v_squad from public.auction_pool
   where sold_to_team_id = v_team and status = 'sold';
  if v_squad >= v_max then
    raise exception 'Squad is already full (% players)', v_max;
  end if;

  v_ccount := public.auction_team_cat_count(v_team, v_cat);
  v_cmax   := public.auction_team_cat_max(v_team, v_cat);
  if v_ccount >= v_cmax then
    raise exception 'That team already has its % players (category % limit is %)',
      v_catlabel, v_cat, v_cmax;
  end if;

  update public.auction_pool
     set status = 'sold', sold_to_team_id = v_team,
         sold_price = v_price, sold_at = now()
   where id = v_lot and status <> 'sold';
  if not found then raise exception 'That player is already sold'; end if;

  update public.auction_teams set purse_spent = purse_spent + v_price where id = v_team;

  update public.auction_state
     set status = 'idle', current_lot_id = null, current_price = 0,
         leading_team_id = null, updated_at = now()
   where id = 1;
end $$;

create or replace function public.auction_mark_unsold(p_lot_id uuid default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_state public.auction_state%rowtype; v_lot uuid;
begin
  if not public.is_auction_staff() then
    raise exception 'Only tournament staff can do that';
  end if;
  select * into v_state from public.auction_state where id = 1 for update;
  v_lot := coalesce(p_lot_id, v_state.current_lot_id);
  if v_lot is null then raise exception 'No player is on the block'; end if;

  update public.auction_pool set status = 'unsold' where id = v_lot and status <> 'sold';
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
    from public.auction_pool where id = p_lot_id and status = 'sold' for update;
  if v_team is null then raise exception 'That player is not sold'; end if;
  if v_price is null then raise exception 'That sale has no recorded price — fix it on the Auction Pool tab first'; end if;

  update public.auction_teams
     set purse_spent = greatest(purse_spent - v_price, 0) where id = v_team;
  update public.auction_pool
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

  update public.auction_pool
     set status = 'pool', sold_to_team_id = null, sold_price = null, sold_at = null
   where status <> 'pool' or sold_to_team_id is not null
      or sold_price is not null or sold_at is not null;

  update public.auction_teams set purse_spent = 0 where purse_spent <> 0;
  delete from public.auction_bids where id is not null;

  update public.auction_state
     set status = 'idle', current_lot_id = null, current_price = 0,
         leading_team_id = null, message = null, updated_at = now()
   where id = 1;
end $$;

-- The auction is no longer sourced from the registration form, so copying
-- registrations into the lot list would corrupt the curated pool.
drop function if exists public.auction_sync_players(boolean);

commit;

-- Grants: authenticated only, never anon.
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.auction_start_lot(uuid, numeric)',
    'public.auction_bid(int, numeric)',
    'public.auction_sell(uuid, int, numeric)',
    'public.auction_mark_unsold(uuid)',
    'public.auction_undo_sale(uuid)',
    'public.auction_reset()',
    'public.auction_team_of(uuid)',
    'public.is_auction_staff()',
    'public.my_auction_team()',
    'public.auction_team_cat_count(int, text)',
    'public.auction_team_cat_max(int, text)',
    'public.auction_player_card(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;

do $$
declare t text;
begin
  foreach t in array array['auction_pool','auction_categories'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when others then
      raise notice 'Realtime not enabled for % (%)', t, sqlerrm;
    end;
  end loop;
end $$;

notify pgrst, 'reload schema';
-- Resolved cards for the WHOLE pool in one call.
--
-- The per-player auction_player_card() is fine for the block, but the captain
-- app also needs photos for its own squad and for every other team's squad;
-- one round trip per player would be 144 of them. SECURITY DEFINER for the
-- same reason as auction_player_card: it reads the staff-only registrations
-- table but returns ONLY the three display fields a card needs — never a
-- phone number, email address or payment screenshot.
create or replace function public.auction_cards()
returns table (
  id uuid, sl_no int, player_key text, name text,
  category text, category_label text, base_price numeric,
  photo_url text, sex text, age int, dupr numeric,
  has_registration boolean, status text,
  sold_to_team_id int, sold_price numeric
)
language sql stable security definer set search_path = public
as $$
  select p.id, p.sl_no, p.player_key, p.name,
         p.category, c.label, p.base_price,
         coalesce(nullif(p.photo_url, ''), r.profile_pic_url),
         coalesce(nullif(p.sex, ''), r.gender),
         p.age,
         coalesce(p.dupr, r.dupr),
         (r.id is not null),
         p.status, p.sold_to_team_id, p.sold_price
    from public.auction_pool p
    join public.auction_categories c on c.code = p.category
    left join public.registrations r
           on p.player_key is not null and p.player_key <> ''
          and r.player_key = p.player_key
   order by p.sl_no;
$$;

revoke all on function public.auction_cards() from public, anon;
grant execute on function public.auction_cards() to authenticated;

notify pgrst, 'reload schema';

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
