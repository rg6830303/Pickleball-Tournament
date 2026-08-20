-- ============================================================
--  MONSOON PICKLE LEAGUE — SEASON 1 MATCH DAY
--  Sunday 23 August 2026 · Sportsplex, Kolkata · first serve 9:00 AM
--
--  31 ties: 24 in the group stage (4 groups × 3 rounds × 2 courts),
--  then 4 quarter-finals, 2 semi-finals and the final.
--  Five matches to a tie, 9 players a side, every game to 11.
--
--  Idempotent: safe to run more than once.
-- ============================================================

-- ------------------------------------------------------------
-- 1) THE SHAPE OF A TIE
-- ------------------------------------------------------------
create table if not exists public.tournament_format (
  slot  int primary key,
  label text not null,
  note  text
);

insert into public.tournament_format (slot, label, note) values
  (1, 'AB Doubles', 'One Category A player with a Category B player'),
  (2, 'BC Doubles', 'One Category B player with a Category C player'),
  (3, 'B Singles',  'A single Category B player'),
  (4, 'BC Doubles', 'A second B + C pair — different players'),
  (5, 'CC Doubles', 'Two Category C players')
on conflict (slot) do update
  set label = excluded.label, note = excluded.note;

-- ------------------------------------------------------------
-- 2) THE FIXTURES
--    home_label / away_label carry the knockout wording ("Winner
--    Group A") for the ties whose teams are not known yet; the
--    team columns fill in as the day resolves them.
-- ------------------------------------------------------------
create table if not exists public.tournament_ties (
  id           int primary key,
  phase        text not null check (phase in ('group','qf','sf','final')),
  group_code   text check (group_code is null or group_code in ('A','B','C','D')),
  round        int,
  slot_no      int,
  court        int,
  starts_at    timestamptz,
  ends_at      timestamptz,
  home_team_id int references public.auction_teams(id) on delete set null,
  away_team_id int references public.auction_teams(id) on delete set null,
  home_label   text not null,
  away_label   text not null,
  home_score   int,
  away_score   int,
  status       text not null default 'scheduled'
               check (status in ('scheduled','live','done')),
  sort_order   int not null,
  updated_at   timestamptz not null default now()
);

create index if not exists tournament_ties_slot_idx on public.tournament_ties(sort_order);
create index if not exists tournament_ties_home_idx on public.tournament_ties(home_team_id);
create index if not exists tournament_ties_away_idx on public.tournament_ties(away_team_id);

create or replace function public.tournament_ties_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists tournament_ties_touch on public.tournament_ties;
create trigger tournament_ties_touch before update on public.tournament_ties
  for each row execute function public.tournament_ties_touch();

-- ------------------------------------------------------------
-- 3) ROW LEVEL SECURITY
--    Anyone signed in reads the schedule — captains need it.
--    Only staff may change a fixture or post a result.
-- ------------------------------------------------------------
alter table public.tournament_ties   enable row level security;
alter table public.tournament_format enable row level security;

drop policy if exists "auth can read ties"    on public.tournament_ties;
drop policy if exists "staff manage ties"     on public.tournament_ties;
drop policy if exists "auth can read format"  on public.tournament_format;
drop policy if exists "staff manage format"   on public.tournament_format;

create policy "auth can read ties"
  on public.tournament_ties for select to authenticated using (true);
create policy "staff manage ties"
  on public.tournament_ties for all to authenticated
  using (public.is_auction_staff()) with check (public.is_auction_staff());

create policy "auth can read format"
  on public.tournament_format for select to authenticated using (true);
create policy "staff manage format"
  on public.tournament_format for all to authenticated
  using (public.is_auction_staff()) with check (public.is_auction_staff());

grant select on public.tournament_ties, public.tournament_format to authenticated;
grant insert, update, delete on public.tournament_ties, public.tournament_format to authenticated;

do $$
declare t text;
begin
  foreach t in array array['tournament_ties','tournament_format'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ------------------------------------------------------------
-- 4) THE RUN OF SHOW
--    Group A & C play courts 1 and 3, Group B & D courts 4 and 6.
-- ------------------------------------------------------------
with sched(id, phase, group_code, round, slot_no, court, home_name, away_name) as (
  values
  -- 9:00 AM — group A + B, round 1
  ( 1,'group','A',1,1,1,'Holbrook Smashers','Picklers Den'),
  ( 2,'group','A',1,1,3,'Superpro','Poker Nova'),
  ( 3,'group','B',1,1,4,'Kee and Ka','Court Hustlers'),
  ( 4,'group','B',1,1,6,'Dink Slayers','TurfXL'),
  -- 10:15 AM — round 2
  ( 5,'group','A',2,2,1,'Holbrook Smashers','Superpro'),
  ( 6,'group','A',2,2,3,'Picklers Den','Poker Nova'),
  ( 7,'group','B',2,2,4,'Kee and Ka','Dink Slayers'),
  ( 8,'group','B',2,2,6,'Court Hustlers','TurfXL'),
  -- 11:30 AM — round 3
  ( 9,'group','A',3,3,1,'Holbrook Smashers','Poker Nova'),
  (10,'group','A',3,3,3,'Picklers Den','Superpro'),
  (11,'group','B',3,3,4,'Kee and Ka','TurfXL'),
  (12,'group','B',3,3,6,'Court Hustlers','Dink Slayers'),
  -- 12:45 PM — group C + D, round 1
  (13,'group','C',1,4,1,'Jamshedpur Smashers','Mavericks'),
  (14,'group','C',1,4,3,'Knight Dinkers','Baseline Bandits'),
  (15,'group','D',1,4,4,'Pickle Pirates','Rajwada Warriors'),
  (16,'group','D',1,4,6,'Ur Smile Matters','Sportsplex Smashers'),
  -- 2:00 PM — round 2
  (17,'group','C',2,5,1,'Jamshedpur Smashers','Knight Dinkers'),
  (18,'group','C',2,5,3,'Mavericks','Baseline Bandits'),
  (19,'group','D',2,5,4,'Pickle Pirates','Ur Smile Matters'),
  (20,'group','D',2,5,6,'Rajwada Warriors','Sportsplex Smashers'),
  -- 3:15 PM — round 3
  (21,'group','C',3,6,1,'Jamshedpur Smashers','Baseline Bandits'),
  (22,'group','C',3,6,3,'Mavericks','Knight Dinkers'),
  (23,'group','D',3,6,4,'Pickle Pirates','Sportsplex Smashers'),
  (24,'group','D',3,6,6,'Rajwada Warriors','Ur Smile Matters')
),
slots(slot_no, starts_at, ends_at) as (
  values
  (1, timestamptz '2026-08-23 09:00+05:30', timestamptz '2026-08-23 10:15+05:30'),
  (2, timestamptz '2026-08-23 10:15+05:30', timestamptz '2026-08-23 11:30+05:30'),
  (3, timestamptz '2026-08-23 11:30+05:30', timestamptz '2026-08-23 12:45+05:30'),
  (4, timestamptz '2026-08-23 12:45+05:30', timestamptz '2026-08-23 14:00+05:30'),
  (5, timestamptz '2026-08-23 14:00+05:30', timestamptz '2026-08-23 15:15+05:30'),
  (6, timestamptz '2026-08-23 15:15+05:30', timestamptz '2026-08-23 16:30+05:30')
),
resolved as (
  select s.id, s.phase, s.group_code, s.round, s.slot_no, s.court,
         sl.starts_at, sl.ends_at,
         h.id as home_team_id, a.id as away_team_id,
         s.home_name as home_label, s.away_name as away_label,
         s.id as sort_order
  from sched s
  join slots sl on sl.slot_no = s.slot_no
  join public.auction_teams h on h.name = s.home_name
  join public.auction_teams a on a.name = s.away_name
),
guard as (
  -- 24 group ties, every team name matched: anything less is a typo
  select case when (select count(*) from resolved) <> 24
              then (select 1 / 0 where true) else 0 end as ok
)
insert into public.tournament_ties
  (id, phase, group_code, round, slot_no, court, starts_at, ends_at,
   home_team_id, away_team_id, home_label, away_label, sort_order)
select id, phase, group_code, round, slot_no, court, starts_at, ends_at,
       home_team_id, away_team_id, home_label, away_label, sort_order
  from resolved, guard
on conflict (id) do update set
  phase = excluded.phase, group_code = excluded.group_code, round = excluded.round,
  slot_no = excluded.slot_no, court = excluded.court,
  starts_at = excluded.starts_at, ends_at = excluded.ends_at,
  home_team_id = excluded.home_team_id, away_team_id = excluded.away_team_id,
  home_label = excluded.home_label, away_label = excluded.away_label,
  sort_order = excluded.sort_order;

-- ------------------------------------------------------------
-- 5) THE CHAMPIONSHIP LADDER
--    Top two from every group qualify. A group winner meets the
--    runner-up of the paired group, never its own: A pairs with
--    B, C pairs with D. Teams fill in as the groups finish, so
--    these carry labels and no court or time.
-- ------------------------------------------------------------
insert into public.tournament_ties
  (id, phase, group_code, round, slot_no, court, starts_at, ends_at,
   home_label, away_label, sort_order)
values
  (25,'qf',   null, null, null, null, null, null, 'Winner Group A', 'Runner-up Group B', 25),
  (26,'qf',   null, null, null, null, null, null, 'Winner Group B', 'Runner-up Group A', 26),
  (27,'qf',   null, null, null, null, null, null, 'Winner Group C', 'Runner-up Group D', 27),
  (28,'qf',   null, null, null, null, null, null, 'Winner Group D', 'Runner-up Group C', 28),
  (29,'sf',   null, null, null, null, null, null, 'Winner QF1',     'Winner QF2',        29),
  (30,'sf',   null, null, null, null, null, null, 'Winner QF3',     'Winner QF4',        30),
  (31,'final',null, null, null, null, null, null, 'Winner SF1',     'Winner SF2',        31)
on conflict (id) do update set
  phase = excluded.phase,
  home_label = excluded.home_label,
  away_label = excluded.away_label,
  sort_order = excluded.sort_order;

-- nothing beyond the 31 ties on the schedule
delete from public.tournament_ties where id not between 1 and 31;
