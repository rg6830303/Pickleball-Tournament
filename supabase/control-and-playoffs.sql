-- ============================================================
--  MONSOON PICKLE LEAGUE — CONTROL AND THE KNOCKOUTS
--
--  Three things the organiser needs that the day itself will demand:
--
--    1. RESET. Demo scores, a mis-typed tie, a rehearsal — one button
--       that puts the scoreboard back to nothing, and one that clears
--       every team sheet.
--
--    2. THE SQUAD LIST, EDITABLE. A player pulls out, a name is spelt
--       wrong, someone changes category. team_squads is the single
--       source every screen reads, so an edit there shows up in the
--       console, the captain's phone and the open board at once.
--
--    3. THE LADDER, FILLED IN BY ITSELF. When the last group tie is
--       scored, the top two of every group take their places in the
--       quarter-finals, and each knockout winner moves up. Nobody
--       should be typing names into a bracket at 4pm.
--
--  Idempotent: safe to run more than once.
-- ============================================================

-- ------------------------------------------------------------
-- 1) SQUAD DETAIL A ROSTER NEEDS
-- ------------------------------------------------------------
alter table public.team_squads add column if not exists phone text;
alter table public.team_squads add column if not exists note  text;

-- Fill the phone from the registration the pool player is linked to.
-- Only where it is still blank, so an organiser's correction is never
-- overwritten by a re-run.
update public.team_squads q
   set phone = r.phone
  from public.auction_pool p
  join public.registrations r on r.player_key = p.player_key
 where q.pool_id = p.id
   and q.phone is null
   and r.phone is not null;

-- Is a squad still 1 A, 4 B and 4 C? The console warns rather than
-- blocks: an organiser mid-edit is allowed a moment of imbalance.
create or replace view public.squad_balance as
  select t.id as team_id, t.name as team_name, t.group_code,
         count(q.id)                                as players,
         count(*) filter (where q.category = 'A')   as a_count,
         count(*) filter (where q.category = 'B')   as b_count,
         count(*) filter (where q.category = 'C')   as c_count,
         (count(q.id) = 9
          and count(*) filter (where q.category = 'A') = 1
          and count(*) filter (where q.category = 'B') = 4
          and count(*) filter (where q.category = 'C') = 4) as ok
    from public.auction_teams t
    left join public.team_squads q on q.team_id = t.id
   group by t.id, t.name, t.group_code;

grant select on public.squad_balance to authenticated;

-- Editing a player who is already named on a filed team sheet is legal,
-- but the organiser should know: that sheet now reads differently.
create or replace function public.squad_player_usage(p_squad_id uuid)
returns table (tie_id int, slot int, team_sheet_status text)
language sql stable security definer set search_path = public as $$
  select s.tie_id, p.slot, s.status
    from public.team_sheet_picks p
    join public.team_sheets s on s.id = p.sheet_id
   where p.squad_id = p_squad_id
   order by s.tie_id, p.slot;
$$;

grant execute on function public.squad_player_usage(uuid) to authenticated;

-- ------------------------------------------------------------
-- 2) RESET
--    (auto_seeded is declared here because the reset clears it)
alter table public.tournament_ties add column if not exists auto_seeded boolean not null default true;
-- ------------------------------------------------------------
create or replace function public.reset_scoreboard(
  p_clear_history boolean default false,
  p_tie_id        int     default null      -- null = the whole tournament
)
returns table (ties_reset int, results_removed int, history_removed int)
language plpgsql security definer set search_path = public as $$
declare v_res int; v_hist int := 0; v_ties int;
begin
  if not public.is_auction_staff() then
    raise exception 'Only tournament staff can reset the scoreboard';
  end if;

  delete from public.match_results
   where p_tie_id is null or tie_id = p_tie_id;
  get diagnostics v_res = row_count;

  if p_clear_history then
    delete from public.score_audit
     where p_tie_id is null or tie_id = p_tie_id;
    get diagnostics v_hist = row_count;
  end if;

  update public.tournament_ties
     set home_score = null, away_score = null,
         status = 'scheduled', winner_team_id = null, decided_by = null,
         shootout_winner_team_id = null
   where (p_tie_id is null or id = p_tie_id);
  get diagnostics v_ties = row_count;

  -- the bracket is derived from results, so it empties with them
  if p_tie_id is null then
    update public.tournament_ties
       set home_team_id = null, away_team_id = null, auto_seeded = true
     where phase <> 'group';
  end if;

  return query select v_ties, v_res, v_hist;
end $$;

create or replace function public.reset_team_sheets(p_tie_id int default null)
returns table (sheets_removed int, picks_removed int)
language plpgsql security definer set search_path = public as $$
declare v_sheets int; v_picks int;
begin
  if not public.is_auction_staff() then
    raise exception 'Only tournament staff can reset the team sheets';
  end if;

  delete from public.team_sheet_picks p
   using public.team_sheets s
   where p.sheet_id = s.id
     and (p_tie_id is null or s.tie_id = p_tie_id);
  get diagnostics v_picks = row_count;

  delete from public.team_sheets
   where p_tie_id is null or tie_id = p_tie_id;
  get diagnostics v_sheets = row_count;

  -- a sheet is what set the trump flags, so they go too
  update public.match_results
     set home_trump = false, away_trump = false
   where (p_tie_id is null or tie_id = p_tie_id)
     and (home_trump or away_trump);

  return query select v_sheets, v_picks;
end $$;

-- everything at once, for a clean start
create or replace function public.reset_everything(p_clear_history boolean default true)
returns text
language plpgsql security definer set search_path = public as $$
declare r record; s record;
begin
  if not public.is_auction_staff() then
    raise exception 'Only tournament staff can reset the tournament';
  end if;
  select * into s from public.reset_team_sheets(null);
  select * into r from public.reset_scoreboard(p_clear_history, null);
  return format('%s ties reset, %s scores removed, %s sheets and %s line-up rows cleared',
                r.ties_reset, r.results_removed, s.sheets_removed, s.picks_removed);
end $$;

-- ------------------------------------------------------------
-- 3) THE LADDER, FILLED IN BY ITSELF
--    A knockout tie the organiser seats by hand is left alone; the
--    flag records which is which.
-- ------------------------------------------------------------

create or replace view public.group_progress as
  select count(*)                                             as group_ties,
         count(*) filter (where status = 'done')              as group_ties_done,
         count(*) = count(*) filter (where status = 'done')   as group_complete
    from public.tournament_ties
   where phase = 'group';

create or replace function public.playoffs_sync()
returns void language plpgsql security definer set search_path = public as $$
declare
  v_complete boolean;
  v_qf1 int; v_qf2 int; v_qf3 int; v_qf4 int;
  v_sf1 int; v_sf2 int;
begin
  select group_complete into v_complete from public.group_progress;

  -- Until every group tie is scored the bracket stays empty. A half-built
  -- ladder is worse than none: it names teams that a later result unnames.
  if not coalesce(v_complete, false) then
    -- A knockout that has already been played keeps its teams. Correcting a
    -- group typo an hour later must not unname the side that won a
    -- quarter-final on court.
    update public.tournament_ties t
       set home_team_id = null, away_team_id = null
     where t.phase <> 'group' and t.auto_seeded
       and (t.home_team_id is not null or t.away_team_id is not null)
       and not exists (select 1 from public.match_results r where r.tie_id = t.id);
    return;
  end if;

  -- Group winner meets the runner-up of the paired group, never its own.
  -- A pairs with B, C pairs with D.
  update public.tournament_ties t set
    home_team_id = s.h, away_team_id = s.a
  from (
    select 25 as tie,
           (select team_id from public.public_standings where group_code='A' and rank=1) as h,
           (select team_id from public.public_standings where group_code='B' and rank=2) as a
    union all select 26,
           (select team_id from public.public_standings where group_code='B' and rank=1),
           (select team_id from public.public_standings where group_code='A' and rank=2)
    union all select 27,
           (select team_id from public.public_standings where group_code='C' and rank=1),
           (select team_id from public.public_standings where group_code='D' and rank=2)
    union all select 28,
           (select team_id from public.public_standings where group_code='D' and rank=1),
           (select team_id from public.public_standings where group_code='C' and rank=2)
  ) s
  where t.id = s.tie and t.auto_seeded
    -- likewise: a tie under way is not re-seated under the players' feet
    and not exists (select 1 from public.match_results r where r.tie_id = t.id);

  -- winners move up
  select winner_team_id into v_qf1 from public.tournament_ties where id = 25;
  select winner_team_id into v_qf2 from public.tournament_ties where id = 26;
  select winner_team_id into v_qf3 from public.tournament_ties where id = 27;
  select winner_team_id into v_qf4 from public.tournament_ties where id = 28;

  update public.tournament_ties t set home_team_id = v_qf1, away_team_id = v_qf2
   where t.id = 29 and t.auto_seeded
     and not exists (select 1 from public.match_results r where r.tie_id = 29);
  update public.tournament_ties t set home_team_id = v_qf3, away_team_id = v_qf4
   where t.id = 30 and t.auto_seeded
     and not exists (select 1 from public.match_results r where r.tie_id = 30);

  select winner_team_id into v_sf1 from public.tournament_ties where id = 29;
  select winner_team_id into v_sf2 from public.tournament_ties where id = 30;

  update public.tournament_ties t set home_team_id = v_sf1, away_team_id = v_sf2
   where t.id = 31 and t.auto_seeded
     and not exists (select 1 from public.match_results r where r.tie_id = 31);
end $$;

-- Every score can be the one that completes a group or a knockout, so the
-- bracket is re-derived after each. tie_recount has already run by then.
create or replace function public.playoffs_after_result()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.playoffs_sync();
  return null;
end $$;

drop trigger if exists playoffs_after_result on public.match_results;
create trigger playoffs_after_result
  after insert or update or delete on public.match_results
  for each statement execute function public.playoffs_after_result();

-- a hand-seated knockout opts out of the automatic bracket
create or replace function public.tie_set_teams(p_tie_id int, p_home int default null, p_away int default null)
returns public.tournament_ties
language plpgsql security definer set search_path = public as $$
declare v_row public.tournament_ties;
begin
  if not public.is_auction_staff() then
    raise exception 'Only tournament staff can seat a knockout tie';
  end if;
  update public.tournament_ties
     set home_team_id = p_home,
         away_team_id = p_away,
         -- clearing both hands the tie back to the automatic bracket
         auto_seeded = (p_home is null and p_away is null)
   where id = p_tie_id
  returning * into v_row;
  perform public.tie_recount(p_tie_id);
  return v_row;
end $$;

-- ------------------------------------------------------------
-- 4) WHAT THE OPEN BOARD NEEDS TO KNOW
-- ------------------------------------------------------------
create or replace view public.public_phase as
  select g.group_ties, g.group_ties_done, g.group_complete,
         (select count(*) from public.tournament_ties
           where phase <> 'group' and home_team_id is not null)     as knockouts_seated,
         (select count(*) from public.tournament_ties
           where phase <> 'group' and status = 'done')              as knockouts_done,
         (select winner_team_id from public.tournament_ties where id = 31) as champion_team_id,
         (select t.name from public.tournament_ties f
            join public.auction_teams t on t.id = f.winner_team_id
           where f.id = 31)                                          as champion_name
    from public.group_progress g;

grant select on public.public_phase, public.group_progress to anon, authenticated;

grant execute on function
  public.reset_scoreboard(boolean,int),
  public.reset_team_sheets(int),
  public.reset_everything(boolean),
  public.playoffs_sync(),
  public.tie_set_teams(int,int,int)
to authenticated;
