-- ============================================================
--  MONSOON PICKLE LEAGUE — HOW EVERY POINT WAS EARNED
--
--  The organiser types in two numbers per match and nothing else.
--  Everything below derives the league points from those numbers, and
--  shows its working, so any total on the board can be checked line by
--  line without anyone re-adding it by hand.
--
--  THE RULES, VERBATIM
--    every game is played to 11
--    win a match ................................................ +3
--    lose by 2 or less (11-9, 10-12, any deuce) ................. +1
--    lose by more than 2 ......................................... 0
--    win all five matches of a tie (clean sweep) ................ +2
--    win the match you declared as your trump ................... +2  (on top of the +3)
--    both teams trumped the same match — the loser of it ........ -2  (the winner takes +3 and +2)
--    ranking is on these points across every group
--
--  Two things are recorded:
--    points_ledger  — one row per scoring event, with its arithmetic
--    score_audit    — every score the organiser typed, changed or removed
--
--  Idempotent: safe to run more than once.
-- ============================================================

-- ------------------------------------------------------------
-- 1) THE LEDGER — every point traced back to a match
-- ------------------------------------------------------------
create or replace view public.points_ledger as
with base as (
  select t.id as tie_id, t.phase, t.group_code, t.round, t.starts_at, t.court,
         t.home_team_id, t.away_team_id,
         r.slot, r.home_points, r.away_points, r.home_trump, r.away_trump, r.recorded_at
    from public.tournament_ties t
    join public.match_results r on r.tie_id = t.id
),
sides as (
  select tie_id, phase, group_code, round, starts_at, court, slot, recorded_at,
         home_team_id as team_id, away_team_id as opp_id,
         home_points as pf, away_points as pa,
         home_trump as my_trump, away_trump as opp_trump
    from base where home_team_id is not null
  union all
  select tie_id, phase, group_code, round, starts_at, court, slot, recorded_at,
         away_team_id, home_team_id,
         away_points, home_points,
         away_trump, home_trump
    from base where away_team_id is not null
),
lines as (
  select s.*,
         s.pf - s.pa as margin,
         case when s.pf > s.pa then 'won'
              when s.pf < s.pa then 'lost'
              else 'drawn' end as outcome,
         case when s.pf > s.pa then 3
              when s.pa - s.pf <= 2 then 1
              else 0 end as match_points,
         case when s.my_trump and s.pf > s.pa then 2
              when s.my_trump and s.opp_trump and s.pf < s.pa then -2
              else 0 end as trump_points
    from sides s
),
-- a sweep is a property of the whole tie, so it gets its own line
sweeps as (
  select tie_id, phase, group_code, round, starts_at, court, team_id, opp_id,
         max(recorded_at) as recorded_at
    from lines
   group by 1,2,3,4,5,6,7,8
  having count(*) = 5 and count(*) filter (where outcome = 'won') = 5
)
select l.tie_id, l.phase, l.group_code, l.round, l.starts_at, l.court,
       l.team_id, tm.name as team_name,
       l.opp_id as opponent_team_id, op.name as opponent_name,
       'match'::text                        as kind,
       l.slot,
       coalesce(f.label, 'Match ' || l.slot) as slot_label,
       l.pf, l.pa, l.margin, l.outcome,
       l.my_trump, l.opp_trump,
       l.match_points, l.trump_points,
       l.match_points + l.trump_points      as points,
       -- the working, in words, so a captain can check it without a rulebook
       concat_ws(' · ',
         case l.outcome
           when 'won'   then format('Won %s-%s → +3', l.pf, l.pa)
           when 'drawn' then format('Level %s-%s → +1 (nothing between them)', l.pf, l.pa)
           else format('Lost %s-%s by %s → %s', l.pf, l.pa, l.pa - l.pf,
                       case when l.pa - l.pf <= 2 then '+1 (within 2)' else '0 (more than 2)' end)
         end,
         case
           when l.my_trump and l.opp_trump and l.pf > l.pa then 'trump clash won → +2'
           when l.my_trump and l.opp_trump and l.pf < l.pa then 'trump clash lost → −2'
           when l.my_trump and l.pf > l.pa                 then 'trump won → +2'
           when l.my_trump and l.pf < l.pa                 then 'trump lost — no penalty, the other side had not trumped it'
           when l.my_trump                                 then 'trump match drawn → no bonus'
           else null
         end
       ) as detail,
       l.recorded_at
  from lines l
  join public.auction_teams tm on tm.id = l.team_id
  left join public.auction_teams op on op.id = l.opp_id
  left join public.tournament_format f on f.slot = l.slot
union all
select s.tie_id, s.phase, s.group_code, s.round, s.starts_at, s.court,
       s.team_id, tm.name,
       s.opp_id, op.name,
       'sweep'::text, null, 'Clean sweep',
       null, null, null, 'won',
       false, false,
       0, 0, 2,
       'All five matches of the tie won → +2',
       s.recorded_at
  from sweeps s
  join public.auction_teams tm on tm.id = s.team_id
  left join public.auction_teams op on op.id = s.opp_id;

-- A team's total, straight from its own ledger lines. If this and
-- public_standings ever disagree, something is wrong with one of them —
-- so the console shows both and compares.
create or replace view public.points_ledger_totals as
  select team_id, phase, group_code,
         count(*) filter (where kind = 'match')                    as matches,
         sum(match_points)                                         as match_points,
         sum(trump_points)                                         as trump_points,
         sum(case when kind = 'sweep' then points else 0 end)      as sweep_points,
         sum(points)                                               as points
    from public.points_ledger
   group by 1,2,3;

-- ------------------------------------------------------------
-- 2) THE AUDIT — what the organiser actually typed, and when
-- ------------------------------------------------------------
create table if not exists public.score_audit (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  actor       uuid,
  action      text not null check (action in ('insert','update','delete')),
  tie_id      int  not null,
  slot        int  not null,
  old_home    int, old_away int,
  new_home    int, new_away int,
  old_home_trump boolean, old_away_trump boolean,
  new_home_trump boolean, new_away_trump boolean
);

create index if not exists score_audit_tie_idx on public.score_audit(tie_id, slot, at desc);
create index if not exists score_audit_at_idx  on public.score_audit(at desc);

create or replace function public.match_results_audit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.score_audit (actor, action, tie_id, slot,
      new_home, new_away, new_home_trump, new_away_trump)
    values (auth.uid(), 'insert', new.tie_id, new.slot,
      new.home_points, new.away_points, new.home_trump, new.away_trump);
    return new;
  elsif tg_op = 'UPDATE' then
    -- a re-save with identical numbers is not worth a line in the log
    if new.home_points is distinct from old.home_points
       or new.away_points is distinct from old.away_points
       or new.home_trump is distinct from old.home_trump
       or new.away_trump is distinct from old.away_trump then
      insert into public.score_audit (actor, action, tie_id, slot,
        old_home, old_away, new_home, new_away,
        old_home_trump, old_away_trump, new_home_trump, new_away_trump)
      values (auth.uid(), 'update', new.tie_id, new.slot,
        old.home_points, old.away_points, new.home_points, new.away_points,
        old.home_trump, old.away_trump, new.home_trump, new.away_trump);
    end if;
    return new;
  else
    insert into public.score_audit (actor, action, tie_id, slot,
      old_home, old_away, old_home_trump, old_away_trump)
    values (auth.uid(), 'delete', old.tie_id, old.slot,
      old.home_points, old.away_points, old.home_trump, old.away_trump);
    return old;
  end if;
end $$;

drop trigger if exists match_results_audit on public.match_results;
create trigger match_results_audit after insert or update or delete on public.match_results
  for each row execute function public.match_results_audit();

-- readable form, with the names filled in
create or replace view public.score_audit_log as
  select a.id, a.at, a.action, a.tie_id, a.slot,
         coalesce(f.label, 'Match ' || a.slot) as slot_label,
         h.name as home_name, w.name as away_name,
         a.old_home, a.old_away, a.new_home, a.new_away,
         a.new_home_trump, a.new_away_trump,
         s.email as actor_email
    from public.score_audit a
    left join public.tournament_ties t on t.id = a.tie_id
    left join public.auction_teams h on h.id = t.home_team_id
    left join public.auction_teams w on w.id = t.away_team_id
    left join public.tournament_format f on f.slot = a.slot
    left join public.app_staff s on s.user_id = a.actor
   order by a.at desc;

-- ------------------------------------------------------------
-- 3) A TRUMP THE ORGANISER RECORDS BY HAND
--    Normally the trump arrives with the filed team sheet. When a tie is
--    played without the form — declared on paper at the net — staff can
--    still set it, and the ledger picks it up like any other.
-- ------------------------------------------------------------
create or replace function public.result_trump(
  p_tie_id int, p_slot int, p_home boolean, p_away boolean
)
returns public.match_results
language plpgsql security definer set search_path = public as $$
declare v_row public.match_results;
begin
  if not public.is_auction_staff() then
    raise exception 'Only tournament staff can set a trump';
  end if;
  if p_slot not in (1,2,4,5) then
    raise exception 'The trump can only sit on one of the four doubles (1, 2, 4 or 5)';
  end if;

  update public.match_results
     set home_trump = coalesce(p_home, false),
         away_trump = coalesce(p_away, false)
   where tie_id = p_tie_id and slot = p_slot
  returning * into v_row;

  if not found then
    raise exception 'Score that match first — a trump needs a result to sit on';
  end if;
  return v_row;
end $$;

-- ------------------------------------------------------------
-- 4) WHO MAY READ THE WORKING
--    The ledger is public: anyone can check the table. The audit log is
--    staff only — it names who typed what.
-- ------------------------------------------------------------
alter table public.score_audit enable row level security;

drop policy if exists "staff read audit" on public.score_audit;
create policy "staff read audit"
  on public.score_audit for select to authenticated
  using (public.is_auction_staff());

grant select on public.points_ledger, public.points_ledger_totals to anon, authenticated;
grant select on public.score_audit, public.score_audit_log to authenticated;
grant execute on function public.result_trump(int,int,boolean,boolean) to authenticated;
