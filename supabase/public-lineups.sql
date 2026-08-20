-- ============================================================
--  MONSOON PICKLE LEAGUE — LINE-UPS ON THE OPEN BOARD
--
--  A filed team sheet is a record: it says who played which match, and
--  it is the only answer to "who was on court 4 at 10:15". It belongs
--  on the public board next to the score.
--
--  But it is filed under a 15-minute seal. If a line-up went public the
--  moment it was filed, a captain would simply open the scoreboard and
--  read the opposition before naming their own team, and the seal would
--  be worth nothing.
--
--  So a line-up becomes public when it can no longer be used that way:
--    * both teams in the tie have filed, or
--    * the tie has started — a score exists
--  Until then the board says the sheet is in, and nothing more.
--
--  Idempotent: safe to run more than once.
-- ============================================================

create or replace view public.public_lineups as
with revealed as (
  select t.id as tie_id
    from public.tournament_ties t
   where exists (
     select 1 from public.team_sheets s
      where s.tie_id = t.id and s.status = 'submitted'
   )
   -- and nobody is still waiting to file. A live window is the whole point
   -- of the seal: while one captain can still name their team, the other
   -- team's sheet must not be readable from a public page. A window that
   -- has run out no longer protects anyone, so it does not hold the
   -- line-ups back.
   and not exists (
     select 1 from public.team_sheets s
      where s.tie_id = t.id
        and s.status = 'open'
        and (s.deadline is null or s.deadline > now())
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

-- How far along each tie's sheets are — safe to show at any time, because
-- it counts sheets without revealing a single name.
create or replace view public.public_sheet_status as
  select t.id as tie_id,
         count(*) filter (where s.status = 'submitted') as filed,
         2                                              as required,
         bool_or(s.status = 'open' and s.deadline > now()) as window_open,
         max(s.deadline) filter (where s.status = 'open')  as closes_at
    from public.tournament_ties t
    left join public.team_sheets s on s.tie_id = t.id
   group by t.id;

grant select on public.public_lineups, public.public_sheet_status to anon, authenticated;
