-- ============================================================
--  MONSOON PICKLE LEAGUE — MATCH DAY OPERATIONS
--
--  Everything that happens once the schedule exists:
--    * team sheets — the 9-player line-up a captain files per tie,
--      opened by the organiser on a 15-minute clock
--    * match results — the five games of a tie, scored
--    * standings   — the league table, straight from the rules
--    * public_*    — read-only views for the open scoreboard site
--
--  Idempotent: safe to run more than once.
--
--  THE SHAPE OF A TIE (9 players a side: 1×A, 4×B, 4×C)
--    Slot 1  Doubles  A+B, or B+B when the A plays the singles
--    Slot 2  Doubles  B+C
--    Slot 3  Singles  A or B
--    Slot 4  Doubles  B+C
--    Slot 5  Doubles  C+C
--  Every squad member plays exactly once. The trump may be declared
--  on any one of the four doubles — never on the singles.
-- ============================================================

-- ------------------------------------------------------------
-- 0) THE FORMAT, RESTATED
-- ------------------------------------------------------------
alter table public.tournament_format add column if not exists kind text;
alter table public.tournament_format add column if not exists trumpable boolean not null default true;

insert into public.tournament_format (slot, label, note, kind, trumpable) values
  (1, 'AB / BB Doubles', 'Your A with a B — or two B players when the A takes the singles', 'doubles', true),
  (2, 'BC Doubles',      'One Category B player with a Category C player',                   'doubles', true),
  (3, 'Singles',         'A single player — your A or a B',                                  'singles', false),
  (4, 'BC Doubles',      'A second B + C pair — different players',                          'doubles', true),
  (5, 'CC Doubles',      'Two Category C players',                                           'doubles', true)
on conflict (slot) do update
  set label = excluded.label, note = excluded.note,
      kind = excluded.kind, trumpable = excluded.trumpable;

-- ------------------------------------------------------------
-- 1) RESULT COLUMNS ON THE TIE
-- ------------------------------------------------------------
alter table public.tournament_ties add column if not exists winner_team_id int
  references public.auction_teams(id) on delete set null;
alter table public.tournament_ties add column if not exists decided_by text
  check (decided_by is null or decided_by in ('matches','shootout'));
alter table public.tournament_ties add column if not exists shootout_winner_team_id int
  references public.auction_teams(id) on delete set null;

-- ------------------------------------------------------------
-- 2) TEAM SHEETS
-- ------------------------------------------------------------
create table if not exists public.team_sheets (
  id           uuid primary key default gen_random_uuid(),
  tie_id       int not null references public.tournament_ties(id) on delete cascade,
  team_id      int not null references public.auction_teams(id)   on delete cascade,
  status       text not null default 'open'
               check (status in ('open','submitted','void')),
  opens_at     timestamptz,
  deadline     timestamptz,
  submitted_at timestamptz,
  submitted_by uuid,
  filed_by_staff boolean not null default false,
  trump_slot   int check (trump_slot is null or trump_slot in (1,2,4,5)),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint team_sheets_uniq unique (tie_id, team_id)
);

create index if not exists team_sheets_team_idx on public.team_sheets(team_id);
create index if not exists team_sheets_tie_idx  on public.team_sheets(tie_id);

create table if not exists public.team_sheet_picks (
  sheet_id  uuid not null references public.team_sheets(id) on delete cascade,
  slot      int  not null check (slot between 1 and 5),
  position  int  not null check (position in (1,2)),
  squad_id  uuid not null references public.team_squads(id) on delete cascade,
  primary key (sheet_id, slot, position),
  -- a player can only be in one line-up slot
  constraint team_sheet_picks_once unique (sheet_id, squad_id)
);

create or replace function public.team_sheets_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists team_sheets_touch on public.team_sheets;
create trigger team_sheets_touch before update on public.team_sheets
  for each row execute function public.team_sheets_touch();

-- ------------------------------------------------------------
-- 3) MATCH RESULTS — five rows to a tie
-- ------------------------------------------------------------
create table if not exists public.match_results (
  id          uuid primary key default gen_random_uuid(),
  tie_id      int not null references public.tournament_ties(id) on delete cascade,
  slot        int not null check (slot between 1 and 5),
  home_points int not null check (home_points >= 0 and home_points <= 99),
  away_points int not null check (away_points >= 0 and away_points <= 99),
  home_trump  boolean not null default false,
  away_trump  boolean not null default false,
  note        text,
  recorded_at timestamptz not null default now(),
  recorded_by uuid,
  constraint match_results_uniq unique (tie_id, slot)
);

create index if not exists match_results_tie_idx on public.match_results(tie_id);

-- ------------------------------------------------------------
-- 4) A TIE'S OWN SCORE, KEPT IN STEP WITH ITS MATCHES
--    home_score / away_score are matches won, not game points.
--    The winner is whoever took more matches; level ties wait for
--    the 7-point Open Doubles shootout the organiser records.
-- ------------------------------------------------------------
create or replace function public.tie_recount(p_tie_id int)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_home int; v_away int; v_played int; v_tie public.tournament_ties;
begin
  select * into v_tie from public.tournament_ties where id = p_tie_id;
  if not found then return; end if;

  select count(*) filter (where home_points > away_points),
         count(*) filter (where away_points > home_points),
         count(*)
    into v_home, v_away, v_played
  from public.match_results where tie_id = p_tie_id;

  update public.tournament_ties t set
    home_score = v_home,
    away_score = v_away,
    status = case when v_played = 0 then 'scheduled'
                  when v_played < 5 then 'live'
                  else 'done' end,
    winner_team_id = case
      when v_played < 5 then null
      when v_home > v_away then t.home_team_id
      when v_away > v_home then t.away_team_id
      else t.shootout_winner_team_id end,
    decided_by = case
      when v_played < 5 then null
      when v_home = v_away then case when t.shootout_winner_team_id is null then null else 'shootout' end
      else 'matches' end
  where t.id = p_tie_id;
end $$;

create or replace function public.match_results_sync()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.tie_recount(coalesce(new.tie_id, old.tie_id));
  return coalesce(new, old);
end $$;

drop trigger if exists match_results_sync on public.match_results;
create trigger match_results_sync after insert or update or delete on public.match_results
  for each row execute function public.match_results_sync();

-- a shootout call also settles the tie
create or replace function public.ties_shootout_sync()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.shootout_winner_team_id is distinct from old.shootout_winner_team_id then
    perform public.tie_recount(new.id);
  end if;
  return new;
end $$;

drop trigger if exists ties_shootout_sync on public.tournament_ties;
create trigger ties_shootout_sync after update on public.tournament_ties
  for each row execute function public.ties_shootout_sync();

-- ------------------------------------------------------------
-- 5) THE LEAGUE TABLE, EXACTLY AS THE RULES READ IT
--      win a match ................................ 3
--      lose by 2 or less .......................... 1
--      lose by more than 2 ........................ 0
--      clean sweep, all 5 matches of a tie ....... +2
--      trump won .................................. +2
--      both teams trumped the same match, and lost −2
-- ------------------------------------------------------------
create or replace view public.standings_v as
with sides as (
  select t.id as tie_id, t.phase, t.group_code,
         t.home_team_id as team_id, r.slot,
         r.home_points as pf, r.away_points as pa,
         r.home_trump  as my_trump, r.away_trump as opp_trump
    from public.tournament_ties t
    join public.match_results r on r.tie_id = t.id
   where t.home_team_id is not null
  union all
  select t.id, t.phase, t.group_code,
         t.away_team_id, r.slot,
         r.away_points, r.home_points,
         r.away_trump, r.home_trump
    from public.tournament_ties t
    join public.match_results r on r.tie_id = t.id
   where t.away_team_id is not null
),
scored as (
  select s.*,
         case when pf > pa then 3
              when pa - pf <= 2 then 1
              else 0 end as match_pts,
         case when my_trump and pf > pa then 2
              when my_trump and opp_trump and pf < pa then -2
              else 0 end as trump_pts,
         (pf > pa) as won,
         (pf < pa) as lost
    from sides s
),
per_tie as (
  select team_id, tie_id, phase, group_code,
         count(*) as played,
         count(*) filter (where won)  as w,
         count(*) filter (where lost) as l,
         sum(pf) as pf, sum(pa) as pa,
         sum(match_pts) as match_pts,
         sum(trump_pts) as trump_pts,
         case when count(*) = 5 and count(*) filter (where won) = 5 then 2 else 0 end as sweep
    from scored
   group by 1,2,3,4
)
select team_id,
       phase,
       group_code,
       count(*)                                   as ties_played,
       sum(played)                                as matches_played,
       sum(w)                                     as won,
       sum(l)                                     as lost,
       sum(pf)                                    as points_for,
       sum(pa)                                    as points_against,
       sum(pf) - sum(pa)                          as point_diff,
       sum(match_pts)                             as match_points,
       sum(trump_pts)                             as trump_points,
       sum(sweep)                                 as sweep_points,
       sum(match_pts) + sum(trump_pts) + sum(sweep) as points
  from per_tie
 group by 1,2,3;

-- ------------------------------------------------------------
-- 6) PUBLIC READ MODELS
--    The open scoreboard reads only these. auction_teams stays
--    private — a purse is nobody's business but the organiser's.
-- ------------------------------------------------------------
create or replace view public.public_teams as
  select id, name, captain_name, group_code, group_rank
    from public.auction_teams;

create or replace view public.public_standings as
  select t.group_code,
         rank() over (
           partition by t.group_code
           order by coalesce(s.points,0) desc,
                    coalesce(s.point_diff,0) desc,
                    coalesce(s.points_for,0) desc,
                    coalesce(s.won,0) desc,
                    t.name
         )                                   as rank,
         t.id                                as team_id,
         t.name                              as team_name,
         t.captain_name,
         coalesce(s.ties_played,0)           as ties_played,
         coalesce(s.matches_played,0)        as matches_played,
         coalesce(s.won,0)                   as won,
         coalesce(s.lost,0)                  as lost,
         coalesce(s.points_for,0)            as points_for,
         coalesce(s.points_against,0)        as points_against,
         coalesce(s.point_diff,0)            as point_diff,
         coalesce(s.points,0)                as points
    from public.auction_teams t
    left join public.standings_v s
      on s.team_id = t.id and s.phase = 'group'
   where t.group_code is not null;

create or replace view public.public_fixtures as
  select t.id, t.phase, t.group_code, t.round, t.slot_no, t.court,
         t.starts_at, t.ends_at, t.status,
         t.home_team_id, t.away_team_id,
         coalesce(h.name, t.home_label) as home_name,
         coalesce(a.name, t.away_label) as away_name,
         t.home_score, t.away_score, t.winner_team_id, t.decided_by,
         t.sort_order
    from public.tournament_ties t
    left join public.auction_teams h on h.id = t.home_team_id
    left join public.auction_teams a on a.id = t.away_team_id;

create or replace view public.public_results as
  select r.tie_id, r.slot, f.label as slot_label, f.kind,
         r.home_points, r.away_points, r.home_trump, r.away_trump, r.note
    from public.match_results r
    left join public.tournament_format f on f.slot = r.slot;

create or replace view public.public_squads as
  select s.team_id, t.name as team_name, t.group_code,
         s.sort_order, s.player_name, s.category, s.retained
    from public.team_squads s
    join public.auction_teams t on t.id = s.team_id;

-- ------------------------------------------------------------
-- 7) ROW LEVEL SECURITY
-- ------------------------------------------------------------
alter table public.team_sheets      enable row level security;
alter table public.team_sheet_picks enable row level security;
alter table public.match_results    enable row level security;

drop policy if exists "staff manage sheets"   on public.team_sheets;
drop policy if exists "captain reads sheet"   on public.team_sheets;
drop policy if exists "staff manage picks"    on public.team_sheet_picks;
drop policy if exists "captain reads picks"   on public.team_sheet_picks;
drop policy if exists "staff manage results"  on public.match_results;
drop policy if exists "auth can read results" on public.match_results;
drop policy if exists "anon can read results" on public.match_results;

-- Sheets are written only through sheet_submit()/sheet_open(), which are
-- security definer. A captain may look at their own sheet and nothing else:
-- the opposition's line-up stays sealed.
create policy "staff manage sheets"
  on public.team_sheets for all to authenticated
  using (public.is_auction_staff()) with check (public.is_auction_staff());
create policy "captain reads sheet"
  on public.team_sheets for select to authenticated
  using (team_id = public.auction_team_of(auth.uid()));

create policy "staff manage picks"
  on public.team_sheet_picks for all to authenticated
  using (public.is_auction_staff()) with check (public.is_auction_staff());
create policy "captain reads picks"
  on public.team_sheet_picks for select to authenticated
  using (exists (
    select 1 from public.team_sheets s
     where s.id = sheet_id and s.team_id = public.auction_team_of(auth.uid())
  ));

-- Scores are public the moment they are entered.
create policy "staff manage results"
  on public.match_results for all to authenticated
  using (public.is_auction_staff()) with check (public.is_auction_staff());
create policy "auth can read results"
  on public.match_results for select to authenticated using (true);
create policy "anon can read results"
  on public.match_results for select to anon using (true);

-- The fixture list is public too, so the open scoreboard can follow along.
drop policy if exists "anon can read ties" on public.tournament_ties;
create policy "anon can read ties"
  on public.tournament_ties for select to anon using (true);

drop policy if exists "anon can read format" on public.tournament_format;
create policy "anon can read format"
  on public.tournament_format for select to anon using (true);

drop policy if exists "anon can read squads" on public.team_squads;
create policy "anon can read squads"
  on public.team_squads for select to anon using (true);

grant select, insert, update, delete on public.team_sheets, public.team_sheet_picks, public.match_results to authenticated;
grant select on public.tournament_ties, public.tournament_format, public.team_squads, public.match_results to anon;
grant select on public.public_teams, public.public_standings, public.public_fixtures,
                public.public_results, public.public_squads to anon, authenticated;
grant select on public.standings_v to authenticated;

do $$
declare t text;
begin
  foreach t in array array['team_sheets','team_sheet_picks','match_results'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ------------------------------------------------------------
-- 8) OPENING AND RESETTING THE FORM  (organiser)
-- ------------------------------------------------------------
create or replace function public.sheet_open(
  p_tie_id  int,
  p_minutes int default 15,
  p_team_id int default null      -- null = both sides
)
returns setof public.team_sheets
language plpgsql security definer set search_path = public as $$
declare
  v_tie public.tournament_ties;
  v_deadline timestamptz;
begin
  if not public.is_auction_staff() then
    raise exception 'Only tournament staff can open a team sheet';
  end if;

  select * into v_tie from public.tournament_ties where id = p_tie_id;
  if not found then raise exception 'No such tie'; end if;
  if v_tie.home_team_id is null or v_tie.away_team_id is null then
    raise exception 'Both teams must be known before the sheets can open';
  end if;
  if p_minutes is null or p_minutes < 1 or p_minutes > 240 then
    raise exception 'The clock must be between 1 and 240 minutes';
  end if;

  v_deadline := now() + make_interval(mins => p_minutes);

  insert into public.team_sheets (tie_id, team_id, status, opens_at, deadline)
  select p_tie_id, tid, 'open', now(), v_deadline
    from (select v_tie.home_team_id as tid union all select v_tie.away_team_id) x
   where p_team_id is null or tid = p_team_id
  on conflict (tie_id, team_id) do update
    set status = 'open', opens_at = now(), deadline = v_deadline,
        submitted_at = null, submitted_by = null, trump_slot = null,
        filed_by_staff = false;

  -- reopening wipes the old line-up: a fresh clock means a fresh sheet
  delete from public.team_sheet_picks p
   using public.team_sheets s
   where p.sheet_id = s.id and s.tie_id = p_tie_id
     and (p_team_id is null or s.team_id = p_team_id);

  return query select * from public.team_sheets
                where tie_id = p_tie_id
                  and (p_team_id is null or team_id = p_team_id);
end $$;

create or replace function public.sheet_reset(
  p_tie_id  int,
  p_team_id int default null,
  p_minutes int default 15
)
returns setof public.team_sheets
language plpgsql security definer set search_path = public as $$
begin
  -- Reset is the same act as opening: clear what was filed and restart
  -- the clock. Kept as its own name because that is what the organiser
  -- is looking for when a captain fluffs it.
  return query select * from public.sheet_open(p_tie_id, p_minutes, p_team_id);
end $$;

create or replace function public.sheet_close(p_tie_id int, p_team_id int default null)
returns setof public.team_sheets
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_auction_staff() then
    raise exception 'Only tournament staff can close a team sheet';
  end if;
  update public.team_sheets set status = 'void'
   where tie_id = p_tie_id and (p_team_id is null or team_id = p_team_id)
     and status = 'open';
  return query select * from public.team_sheets
                where tie_id = p_tie_id and (p_team_id is null or team_id = p_team_id);
end $$;

-- ------------------------------------------------------------
-- 9) FILING A LINE-UP  (captain, or staff on their behalf)
--    p_picks: [{"slot":1,"position":1,"squad_id":"…"}, …]  9 rows
-- ------------------------------------------------------------
create or replace function public.sheet_file(
  p_tie_id  int,
  p_team_id int,
  p_picks   jsonb,
  p_trump   int,
  p_as_staff boolean
)
returns public.team_sheets
language plpgsql security definer set search_path = public as $$
declare
  v_sheet  public.team_sheets;
  v_tie    public.tournament_ties;
  v_count  int;
  v_singles text;
  v_slot1_a int;
  v_slot1_b int;
  v_bad    text;
begin
  select * into v_tie from public.tournament_ties where id = p_tie_id;
  if not found then raise exception 'No such tie'; end if;
  if p_team_id is distinct from v_tie.home_team_id
     and p_team_id is distinct from v_tie.away_team_id then
    raise exception 'That team is not playing this tie';
  end if;

  select * into v_sheet from public.team_sheets
   where tie_id = p_tie_id and team_id = p_team_id;
  if not found then
    raise exception 'The organiser has not opened the team sheet for this tie yet';
  end if;

  if not p_as_staff then
    if v_sheet.status = 'void' then
      raise exception 'This team sheet has been closed by the organiser';
    end if;
    if v_sheet.status = 'submitted' then
      raise exception 'Your line-up is already in. Ask the organiser to reset it if it needs changing';
    end if;
    if v_sheet.deadline is not null and now() > v_sheet.deadline then
      raise exception 'The 15-minute window has closed. Ask the organiser to reset your sheet';
    end if;
  end if;

  -- ---- the picks must be nine of this team's own players, each once ----
  create temporary table if not exists _picks (
    slot int, position int, squad_id uuid, category text
  ) on commit drop;
  -- TRUNCATE, not DELETE: Supabase runs pg_safeupdate for the API roles, and a
  -- DELETE with no WHERE is refused there ("DELETE requires a WHERE clause")
  -- even inside a security-definer function.
  truncate table _picks;

  insert into _picks (slot, position, squad_id)
  select (e->>'slot')::int, (e->>'position')::int, (e->>'squad_id')::uuid
    from jsonb_array_elements(coalesce(p_picks, '[]'::jsonb)) e;

  select count(*) into v_count from _picks;
  if v_count <> 9 then
    raise exception 'A line-up needs all 9 players — got %', v_count;
  end if;
  if (select count(distinct squad_id) from _picks) <> 9 then
    raise exception 'Each player can only be named once';
  end if;

  update _picks p set category = s.category
    from public.team_squads s
   where s.id = p.squad_id and s.team_id = p_team_id;

  select string_agg(squad_id::text, ', ') into v_bad from _picks where category is null;
  if v_bad is not null then
    raise exception 'Those players are not in your squad: %', v_bad;
  end if;

  -- ---- the slots must be the five the format asks for ----
  if (select count(*) from _picks where slot = 3 and position = 1) <> 1
     or (select count(*) from _picks where slot = 3) <> 1 then
    raise exception 'The singles needs exactly one player';
  end if;
  if (select count(*) from _picks where slot in (1,2,4,5)) <> 8
     or (select count(*) from _picks where slot in (1,2,4,5) and position in (1,2)) <> 8
     or (select count(*) from (
           select slot from _picks where slot in (1,2,4,5) group by slot having count(*) = 2
         ) z) <> 4 then
    raise exception 'Each doubles needs exactly two players';
  end if;

  -- ---- categories, per the format ----
  select category into v_singles from _picks where slot = 3;
  if v_singles not in ('A','B') then
    raise exception 'The singles must be played by your A or a B — not a C';
  end if;

  select count(*) filter (where category = 'A'),
         count(*) filter (where category = 'B')
    into v_slot1_a, v_slot1_b
    from _picks where slot = 1;

  if v_singles = 'A' then
    if v_slot1_b <> 2 then
      raise exception 'Your A is playing the singles, so match 1 must be two B players';
    end if;
  else
    if v_slot1_a <> 1 or v_slot1_b <> 1 then
      raise exception 'Match 1 must be your A with a B (your A is not in the singles)';
    end if;
  end if;

  if (select count(*) from _picks
       where slot in (2,4)
       group by slot
      having count(*) filter (where category = 'B') <> 1
          or count(*) filter (where category = 'C') <> 1
       limit 1) is not null then
    raise exception 'Matches 2 and 4 must each be one B with one C';
  end if;

  if (select count(*) filter (where category = 'C') from _picks where slot = 5) <> 2 then
    raise exception 'Match 5 must be two C players';
  end if;

  -- ---- the trump: one of the four doubles, never the singles ----
  if p_trump is null or p_trump not in (1,2,4,5) then
    raise exception 'Declare your trump on one of the four doubles (1, 2, 4 or 5)';
  end if;

  delete from public.team_sheet_picks where sheet_id = v_sheet.id;
  insert into public.team_sheet_picks (sheet_id, slot, position, squad_id)
  select v_sheet.id, slot, position, squad_id from _picks;

  update public.team_sheets set
    status = 'submitted',
    submitted_at = now(),
    submitted_by = auth.uid(),
    filed_by_staff = p_as_staff,
    trump_slot = p_trump
  where id = v_sheet.id
  returning * into v_sheet;

  -- keep any score already entered honest about who trumped what
  update public.match_results r set
    home_trump = case when v_tie.home_team_id = p_team_id then r.slot = p_trump else r.home_trump end,
    away_trump = case when v_tie.away_team_id = p_team_id then r.slot = p_trump else r.away_trump end
  where r.tie_id = p_tie_id;

  return v_sheet;
end $$;

-- captain files their own
create or replace function public.sheet_submit(p_tie_id int, p_picks jsonb, p_trump int)
returns public.team_sheets
language plpgsql security definer set search_path = public as $$
declare v_team int;
begin
  v_team := public.auction_team_of(auth.uid());
  if v_team is null then
    raise exception 'This login is not linked to a team';
  end if;
  return public.sheet_file(p_tie_id, v_team, p_picks, p_trump, false);
end $$;

-- organiser files on a team's behalf, clock or no clock
create or replace function public.sheet_submit_for(p_tie_id int, p_team_id int, p_picks jsonb, p_trump int)
returns public.team_sheets
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_auction_staff() then
    raise exception 'Only tournament staff can file for a team';
  end if;
  return public.sheet_file(p_tie_id, p_team_id, p_picks, p_trump, true);
end $$;

-- ------------------------------------------------------------
-- 10) WHAT A CAPTAIN NEEDS ON THEIR PHONE
--     One call: the tie, the clock, and the line-up as filed.
-- ------------------------------------------------------------
create or replace function public.my_sheets()
returns table (
  sheet_id     uuid,
  tie_id       int,
  team_id      int,
  status       text,
  opens_at     timestamptz,
  deadline     timestamptz,
  submitted_at timestamptz,
  trump_slot   int,
  opponent     text,
  court        int,
  starts_at    timestamptz,
  group_code   text,
  round        int,
  phase        text,
  picks        jsonb
)
language sql stable security definer set search_path = public as $$
  with me as (select public.auction_team_of(auth.uid()) as team_id)
  select s.id, s.tie_id, s.team_id, s.status, s.opens_at, s.deadline,
         s.submitted_at, s.trump_slot,
         coalesce(
           case when t.home_team_id = s.team_id then a.name else h.name end,
           case when t.home_team_id = s.team_id then t.away_label else t.home_label end
         ) as opponent,
         t.court, t.starts_at, t.group_code, t.round, t.phase,
         coalesce((
           select jsonb_agg(jsonb_build_object(
                    'slot', p.slot, 'position', p.position,
                    'squad_id', p.squad_id, 'player_name', q.player_name,
                    'category', q.category)
                  order by p.slot, p.position)
             from public.team_sheet_picks p
             join public.team_squads q on q.id = p.squad_id
            where p.sheet_id = s.id
         ), '[]'::jsonb) as picks
    from public.team_sheets s
    join me on me.team_id = s.team_id
    join public.tournament_ties t on t.id = s.tie_id
    left join public.auction_teams h on h.id = t.home_team_id
    left join public.auction_teams a on a.id = t.away_team_id
   order by t.sort_order;
$$;

-- everything the organiser's sheet board needs, in one call
create or replace function public.sheet_board()
returns table (
  tie_id       int,
  team_id      int,
  team_name    text,
  side         text,
  sheet_id     uuid,
  status       text,
  opens_at     timestamptz,
  deadline     timestamptz,
  submitted_at timestamptz,
  filed_by_staff boolean,
  trump_slot   int,
  picks        jsonb
)
language sql stable security definer set search_path = public as $$
  select s.tie_id, s.team_id, tm.name,
         case when t.home_team_id = s.team_id then 'home' else 'away' end,
         s.id, s.status, s.opens_at, s.deadline, s.submitted_at,
         s.filed_by_staff, s.trump_slot,
         coalesce((
           select jsonb_agg(jsonb_build_object(
                    'slot', p.slot, 'position', p.position,
                    'squad_id', p.squad_id, 'player_name', q.player_name,
                    'category', q.category)
                  order by p.slot, p.position)
             from public.team_sheet_picks p
             join public.team_squads q on q.id = p.squad_id
            where p.sheet_id = s.id
         ), '[]'::jsonb)
    from public.team_sheets s
    join public.tournament_ties t on t.id = s.tie_id
    join public.auction_teams tm on tm.id = s.team_id
   where public.is_auction_staff()
   order by t.sort_order, 4;
$$;

-- ------------------------------------------------------------
-- 11) SCORING A MATCH  (organiser)
--     Trump flags come from the filed sheets so the table cannot
--     disagree with what the captains declared.
-- ------------------------------------------------------------
create or replace function public.result_set(
  p_tie_id int,
  p_slot   int,
  p_home   int,
  p_away   int,
  p_note   text default null
)
returns public.match_results
language plpgsql security definer set search_path = public as $$
declare
  v_tie public.tournament_ties;
  v_home_trump boolean;
  v_away_trump boolean;
  v_row public.match_results;
begin
  if not public.is_auction_staff() then
    raise exception 'Only tournament staff can record a score';
  end if;
  if p_slot not between 1 and 5 then raise exception 'A tie has five matches'; end if;
  if p_home is null or p_away is null or p_home < 0 or p_away < 0 then
    raise exception 'Both scores are needed';
  end if;

  select * into v_tie from public.tournament_ties where id = p_tie_id;
  if not found then raise exception 'No such tie'; end if;

  select coalesce(bool_or(trump_slot = p_slot) filter (where team_id = v_tie.home_team_id), false),
         coalesce(bool_or(trump_slot = p_slot) filter (where team_id = v_tie.away_team_id), false)
    into v_home_trump, v_away_trump
    from public.team_sheets where tie_id = p_tie_id and status = 'submitted';

  insert into public.match_results (tie_id, slot, home_points, away_points,
                                    home_trump, away_trump, note, recorded_by)
  values (p_tie_id, p_slot, p_home, p_away, v_home_trump, v_away_trump, p_note, auth.uid())
  on conflict (tie_id, slot) do update
    set home_points = excluded.home_points,
        away_points = excluded.away_points,
        home_trump  = excluded.home_trump,
        away_trump  = excluded.away_trump,
        note        = excluded.note,
        recorded_at = now(),
        recorded_by = auth.uid()
  returning * into v_row;

  return v_row;
end $$;

create or replace function public.result_clear(p_tie_id int, p_slot int default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_auction_staff() then
    raise exception 'Only tournament staff can clear a score';
  end if;
  delete from public.match_results
   where tie_id = p_tie_id and (p_slot is null or slot = p_slot);
  perform public.tie_recount(p_tie_id);
end $$;

-- the organiser seats a team in a knockout tie once the groups decide it
create or replace function public.tie_set_teams(p_tie_id int, p_home int default null, p_away int default null)
returns public.tournament_ties
language plpgsql security definer set search_path = public as $$
declare v_row public.tournament_ties;
begin
  if not public.is_auction_staff() then
    raise exception 'Only tournament staff can seat a knockout tie';
  end if;
  update public.tournament_ties
     set home_team_id = p_home, away_team_id = p_away
   where id = p_tie_id
  returning * into v_row;
  perform public.tie_recount(p_tie_id);
  return v_row;
end $$;

grant execute on function
  public.sheet_open(int,int,int),
  public.sheet_reset(int,int,int),
  public.sheet_close(int,int),
  public.sheet_submit(int,jsonb,int),
  public.sheet_submit_for(int,int,jsonb,int),
  public.my_sheets(),
  public.sheet_board(),
  public.result_set(int,int,int,int,text),
  public.result_clear(int,int),
  public.tie_set_teams(int,int,int),
  public.tie_recount(int)
to authenticated;
