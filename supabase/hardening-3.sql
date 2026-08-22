-- ============================================================
--  HARDENING, ROUND THREE
--  The sceptic pass on the audit. Four confirmed faults.
--  Idempotent: safe to run more than once.
-- ============================================================

-- ------------------------------------------------------------
-- 1) THE AUDIT LOG WAS READABLE BY EVERY CAPTAIN
--    score_audit has a staff-only policy, but score_audit_log is a view
--    owned by postgres, and a view runs with its owner's rights unless
--    told otherwise — so RLS on the base table never applied. Any
--    signed-in captain could read every score edit and the organiser's
--    email. security_invoker makes the view read as whoever queries it,
--    which is what the comment always claimed.
-- ------------------------------------------------------------
-- security_invoker looked right, but the view reads app_staff and
-- auction_teams, which the authenticated role has no grant on — it locked
-- the organiser out too. The pattern used elsewhere works here: the view
-- keeps its owner's rights and answers nobody who is not staff.
alter view public.score_audit_log set (security_invoker = false);

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
   where public.is_auction_staff()
   order by a.at desc;

grant select on public.score_audit_log to authenticated;
revoke all on public.score_audit_log from anon;

-- ------------------------------------------------------------
-- 2) A LEVEL GAME PAID +1 TO BOTH SIDES — A RULE THAT DOES NOT EXIST
--    The rules cover a win, a loss by two or less, and a loss by more.
--    Nothing covers 11-11, and every game is played to a winner, so an
--    equal score is a typo. It is refused at the point of entry rather
--    than quietly invented into a point apiece.
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
  v_old public.match_results;
  v_row public.match_results;
begin
  if not public.is_auction_staff() then
    raise exception 'Only tournament staff can record a score';
  end if;
  if p_slot not between 1 and 5 then raise exception 'A tie has five matches'; end if;
  if p_home is null or p_away is null or p_home < 0 or p_away < 0 then
    raise exception 'Both scores are needed';
  end if;
  if p_home = p_away then
    raise exception 'Every game is played to a winner — % - % cannot be right', p_home, p_away;
  end if;

  select * into v_tie from public.tournament_ties where id = p_tie_id;
  if not found then raise exception 'No such tie'; end if;

  select * into v_old from public.match_results where tie_id = p_tie_id and slot = p_slot;

  -- The trump comes from the filed sheets. If a sheet has since been reset
  -- — the organiser fixing a wrong name — its trump_slot is null again, and
  -- re-saving the score must NOT quietly delete a declaration the teams
  -- actually made. A missing sheet leaves whatever was already stamped.
  select bool_or(trump_slot = p_slot) filter (where team_id = v_tie.home_team_id),
         bool_or(trump_slot = p_slot) filter (where team_id = v_tie.away_team_id)
    into v_home_trump, v_away_trump
    from public.team_sheets where tie_id = p_tie_id and status = 'submitted';

  v_home_trump := coalesce(v_home_trump, v_old.home_trump, false);
  v_away_trump := coalesce(v_away_trump, v_old.away_trump, false);

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

-- ------------------------------------------------------------
-- 3) RE-SEATING A KNOCKOUT LEFT THE OLD PAIR'S LINE-UP BEHIND
--    Sheets are keyed on (tie, team). Change who is playing a
--    quarter-final and the previous team's filed sheet stayed attached
--    to it — published on the open board as that tie's line-up. A team
--    that is no longer in the tie loses its sheet with its seat.
-- ------------------------------------------------------------
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

  delete from public.team_sheet_picks p
   using public.team_sheets s
   where p.sheet_id = s.id
     and s.tie_id = p_tie_id
     and s.team_id is distinct from p_home
     and s.team_id is distinct from p_away;
  delete from public.team_sheets s
   where s.tie_id = p_tie_id
     and s.team_id is distinct from p_home
     and s.team_id is distinct from p_away;

  perform public.tie_recount(p_tie_id);
  perform public.playoffs_sync();
  perform public.playoffs_advance();
  select * into v_row from public.tournament_ties where id = p_tie_id;
  return v_row;
end $$;

-- ------------------------------------------------------------
-- 4) THE "WORKING" MIXED KNOCKOUT POINTS INTO A LEAGUE TOTAL
--    points_ledger covers every tie. The league table counts the group
--    stage only, so from the quarter-finals onward a team's ledger added
--    up to more than its table total — on a public page whose whole
--    purpose is "check the arithmetic yourself". The ledger keeps every
--    line; the league view of it is now explicit.
-- ------------------------------------------------------------
create or replace view public.public_points_ledger as
  select * from public.points_ledger where phase = 'group';

grant select on public.public_points_ledger to anon, authenticated;
-- ============================================================
--  A GROUP TIE CANNOT BE RE-SEATED
--
--  tie_set_teams exists so the organiser can seat a knockout. Pointed
--  at a group tie it would move a team into another group's fixture,
--  and public_standings joins on team id without checking the group —
--  so that team appears in two group tables at once, one of them under
--  a group it does not belong to. The console never offers this (the
--  seat control is drawn for knockouts only), but the RPC allowed it.
-- ============================================================
create or replace function public.tie_set_teams(p_tie_id int, p_home int default null, p_away int default null)
returns public.tournament_ties
language plpgsql security definer set search_path = public as $$
declare v_row public.tournament_ties; v_phase text;
begin
  if not public.is_auction_staff() then
    raise exception 'Only tournament staff can seat a knockout tie';
  end if;

  select phase into v_phase from public.tournament_ties where id = p_tie_id;
  if v_phase is null then raise exception 'No such tie'; end if;
  if v_phase = 'group' then
    raise exception 'Group fixtures are fixed — only a knockout tie can be seated';
  end if;
  if p_home is not null and p_home = p_away then
    raise exception 'A team cannot play itself';
  end if;

  update public.tournament_ties
     set home_team_id = p_home,
         away_team_id = p_away,
         auto_seeded = (p_home is null and p_away is null)
   where id = p_tie_id
  returning * into v_row;

  delete from public.team_sheet_picks p
   using public.team_sheets s
   where p.sheet_id = s.id
     and s.tie_id = p_tie_id
     and s.team_id is distinct from p_home
     and s.team_id is distinct from p_away;
  delete from public.team_sheets s
   where s.tie_id = p_tie_id
     and s.team_id is distinct from p_home
     and s.team_id is distinct from p_away;

  perform public.tie_recount(p_tie_id);
  perform public.playoffs_sync();
  perform public.playoffs_advance();
  select * into v_row from public.tournament_ties where id = p_tie_id;
  return v_row;
end $$;
