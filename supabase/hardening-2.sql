-- ============================================================
--  HARDENING, ROUND TWO
--  Everything below came out of an adversarial audit of the live
--  system. Each fix names the hole it closes.
--
--  Idempotent: safe to run more than once.
-- ============================================================

-- ------------------------------------------------------------
-- 1) 144 PHONE NUMBERS WERE PUBLIC
--    team_squads gained a phone column so the organiser could reach a
--    player. It already had an anon SELECT policy — added when the only
--    thing in the table was a name that is printed on a poster — so the
--    phone numbers went out with it, readable by anyone with the key.
--    The open board reads public_squads, which has never carried the
--    phone, so nothing on the public site needs this.
-- ------------------------------------------------------------
drop policy if exists "anon can read squads" on public.team_squads;
revoke select on public.team_squads from anon;

-- ------------------------------------------------------------
-- 2) CAPTAINS COULD READ EVERY TEAM'S PURSE AND AUTH USER ID
--    "auth can read teams USING (true)" dates from the auction, when
--    every captain watched every purse on purpose. With the auction
--    closed it only leaks: a login's auth.users id is the handle an
--    attacker wants. Captains now read public_teams (name, captain,
--    group, seed) and nothing else.
--
--    NOTE: if the auction room is ever switched back on (SHOW_AUCTION in
--    auction/js/config.js) its League Purses panel will need a view of
--    its own — it reads auction_teams directly today.
-- ------------------------------------------------------------
drop policy if exists "auth can read teams" on public.auction_teams;
create policy "staff can read teams"
  on public.auction_teams for select to authenticated
  using (public.is_auction_staff());

-- ------------------------------------------------------------
-- 3) THE SEAL COULD BE BROKEN BY AN ABSENT SHEET
--    The old rule revealed a tie once at least one sheet was submitted
--    and no sheet was still open. If the organiser opened the window for
--    one team only, the other team had no row at all — nothing was
--    "still open", so the filed line-up published while the opponent had
--    not even been asked. Now both sides must be in, or the tie must be
--    under way with no live window.
-- ------------------------------------------------------------
create or replace view public.public_lineups as
with revealed as (
  select t.id as tie_id
    from public.tournament_ties t
   where
     -- both captains are in: neither can gain by looking
     (select count(*) from public.team_sheets s
       where s.tie_id = t.id and s.status = 'submitted') >= 2
     or (
       -- or the tie is being played and nobody is still naming a team
       exists (select 1 from public.match_results r where r.tie_id = t.id)
       and not exists (
         select 1 from public.team_sheets s
          where s.tie_id = t.id and s.status = 'open'
            and (s.deadline is null or s.deadline > now())
       )
     )
)
select s.tie_id,
       s.team_id,
       tm.name              as team_name,
       case when t.home_team_id = s.team_id then 'home' else 'away' end as side,
       s.trump_slot,
       s.submitted_at,
       p.slot,
       coalesce(f.label, 'Match ' || p.slot) as slot_label,
       f.kind,
       p.position,
       q.player_name,
       q.category,
       (p.slot = s.trump_slot)               as is_trump
  from public.team_sheets s
  join revealed rv          on rv.tie_id = s.tie_id
  join public.tournament_ties t on t.id = s.tie_id
  join public.auction_teams tm  on tm.id = s.team_id
  join public.team_sheet_picks p on p.sheet_id = s.id
  join public.team_squads q      on q.id = p.squad_id
  left join public.tournament_format f on f.slot = p.slot
 where s.status = 'submitted';

grant select on public.public_lineups to anon, authenticated;

-- ------------------------------------------------------------
-- 4) THE BRACKET
--    Three faults, one rewrite:
--
--    a. A tie settled by the 7-point shootout never advanced. The
--       winner is written by tie_recount when the organiser records the
--       shootout, but only match_results fired playoffs_sync — so the
--       semi-final it fed stayed empty with no way forward.
--
--    b. Correcting a group score after a knockout had been played
--       re-seated the unplayed knockouts from the new table while the
--       played ones kept their teams. One side could end up in two
--       quarter-finals and the real group winner in none. Once a
--       knockout has been played the bracket is settled: a late
--       correction changes the league table, not who is on court.
--
--    c. Two scoring desks finishing the group stage at the same instant
--       could both read "not complete yet" and neither would seat the
--       bracket. One advisory lock per tournament serialises it.
-- ------------------------------------------------------------
create or replace function public.playoffs_sync()
returns void language plpgsql security definer set search_path = public as $$
declare
  v_complete boolean;
  v_started  boolean;
  v_qf1 int; v_qf2 int; v_qf3 int; v_qf4 int;
  v_sf1 int; v_sf2 int;
begin
  -- one bracket, one writer at a time
  perform pg_advisory_xact_lock(hashtext('mpl_playoffs'));

  select group_complete into v_complete from public.group_progress;

  select exists (
    select 1 from public.match_results r
      join public.tournament_ties t on t.id = r.tie_id
     where t.phase <> 'group'
  ) into v_started;

  -- The knockouts have begun: the bracket is what it is.
  if v_started then
    return;
  end if;

  if not coalesce(v_complete, false) then
    update public.tournament_ties t
       set home_team_id = null, away_team_id = null
     where t.phase <> 'group' and t.auto_seeded
       and (t.home_team_id is not null or t.away_team_id is not null);
    return;
  end if;

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
  where t.id = s.tie and t.auto_seeded;

  select winner_team_id into v_qf1 from public.tournament_ties where id = 25;
  select winner_team_id into v_qf2 from public.tournament_ties where id = 26;
  select winner_team_id into v_qf3 from public.tournament_ties where id = 27;
  select winner_team_id into v_qf4 from public.tournament_ties where id = 28;

  update public.tournament_ties t set home_team_id = v_qf1, away_team_id = v_qf2
   where t.id = 29 and t.auto_seeded;
  update public.tournament_ties t set home_team_id = v_qf3, away_team_id = v_qf4
   where t.id = 30 and t.auto_seeded;

  select winner_team_id into v_sf1 from public.tournament_ties where id = 29;
  select winner_team_id into v_sf2 from public.tournament_ties where id = 30;

  update public.tournament_ties t set home_team_id = v_sf1, away_team_id = v_sf2
   where t.id = 31 and t.auto_seeded;
end $$;

-- Once the knockouts are under way playoffs_sync returns early, so the
-- winners of played ties have to be carried forward on their own. This
-- runs after every result and after every shootout call.
create or replace function public.playoffs_advance()
returns void language plpgsql security definer set search_path = public as $$
declare v_a int; v_b int;
begin
  perform pg_advisory_xact_lock(hashtext('mpl_playoffs'));

  select winner_team_id into v_a from public.tournament_ties where id = 25;
  select winner_team_id into v_b from public.tournament_ties where id = 26;
  update public.tournament_ties t set home_team_id = v_a, away_team_id = v_b
   where t.id = 29 and t.auto_seeded
     and not exists (select 1 from public.match_results r where r.tie_id = 29)
     and (t.home_team_id is distinct from v_a or t.away_team_id is distinct from v_b);

  select winner_team_id into v_a from public.tournament_ties where id = 27;
  select winner_team_id into v_b from public.tournament_ties where id = 28;
  update public.tournament_ties t set home_team_id = v_a, away_team_id = v_b
   where t.id = 30 and t.auto_seeded
     and not exists (select 1 from public.match_results r where r.tie_id = 30)
     and (t.home_team_id is distinct from v_a or t.away_team_id is distinct from v_b);

  select winner_team_id into v_a from public.tournament_ties where id = 29;
  select winner_team_id into v_b from public.tournament_ties where id = 30;
  update public.tournament_ties t set home_team_id = v_a, away_team_id = v_b
   where t.id = 31 and t.auto_seeded
     and not exists (select 1 from public.match_results r where r.tie_id = 31)
     and (t.home_team_id is distinct from v_a or t.away_team_id is distinct from v_b);
end $$;

create or replace function public.playoffs_after_result()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.playoffs_sync();
  perform public.playoffs_advance();
  return null;
end $$;

-- A shootout is recorded on the tie, not on a match, so it never reached
-- the bracket. It does now.
create or replace function public.ties_shootout_sync()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.shootout_winner_team_id is distinct from old.shootout_winner_team_id then
    perform public.tie_recount(new.id);
    perform public.playoffs_advance();
  end if;
  return new;
end $$;

-- Seating a knockout by hand — and handing it back — both have to move
-- the bracket immediately, not at the next score.
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
         auto_seeded = (p_home is null and p_away is null)
   where id = p_tie_id
  returning * into v_row;
  perform public.tie_recount(p_tie_id);
  -- handing a tie back to the bracket should re-fill it on the spot
  perform public.playoffs_sync();
  perform public.playoffs_advance();
  select * into v_row from public.tournament_ties where id = p_tie_id;
  return v_row;
end $$;

-- ------------------------------------------------------------
-- 5) A SCOREBOARD RESET LEFT KNOCKOUT TEAM SHEETS BEHIND
--    Reset empties the bracket, so a quarter-final that later seats a
--    different pair inherited the old pair's filed line-up: their
--    players on the public board, and a captain told their sheet was
--    already in. The sheets go with the seats.
-- ------------------------------------------------------------
create or replace function public.reset_scoreboard(
  p_clear_history boolean default false,
  p_tie_id        int     default null
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

  if p_tie_id is null then
    -- the bracket empties with the results that built it, and the sheets
    -- filed against those seats go too
    delete from public.team_sheet_picks p
     using public.team_sheets s, public.tournament_ties t
     where p.sheet_id = s.id and t.id = s.tie_id and t.phase <> 'group';
    delete from public.team_sheets s
     using public.tournament_ties t
     where t.id = s.tie_id and t.phase <> 'group';

    update public.tournament_ties
       set home_team_id = null, away_team_id = null, auto_seeded = true
     where phase <> 'group';
  end if;

  return query select v_ties, v_res, v_hist;
end $$;

grant execute on function public.playoffs_advance() to authenticated;
revoke all on function public.playoffs_advance() from public, anon;
