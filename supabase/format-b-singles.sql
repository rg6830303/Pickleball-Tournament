-- ============================================================
--  THE TIE GOES BACK TO A FIXED SHAPE
--
--  It was: singles played by the A or a B, and match 1 either A+B or
--  B+B depending on which. The organiser has settled it — the singles
--  is a B, always, and match 1 is the A with a B, always:
--
--    1  Doubles  A + B
--    2  Doubles  B + C
--    3  SINGLES  one B
--    4  Doubles  B + C
--    5  Doubles  C + C
--
--  Nine players, each used once: 1 A, 4 B, 4 C. There is now exactly one
--  legal shape, so the server can say plainly what is wrong instead of
--  explaining a branch.
--
--  Idempotent: safe to run more than once.
-- ============================================================

update public.tournament_format set
  label = 'AB Doubles',
  note  = 'Your Category A player with a Category B player'
 where slot = 1;

update public.tournament_format set
  label = 'B Singles',
  note  = 'A single Category B player'
 where slot = 3;

-- ------------------------------------------------------------
--  THE VALIDATOR
--  Only the two composition rules change. Everything else —
--  the identity checks, the clock, the trump, the nine-distinct-
--  players rule — is exactly as it was.
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
  v_staff  boolean;
  v_mine   int;
begin
  v_staff := public.is_auction_staff();
  if p_as_staff and not v_staff then
    raise exception 'Only tournament staff can file for a team';
  end if;

  if not p_as_staff then
    v_mine := public.auction_team_of(auth.uid());
    if v_mine is null then
      raise exception 'This login is not linked to a team';
    end if;
    if v_mine is distinct from p_team_id then
      raise exception 'You can only file your own team sheet';
    end if;
  end if;

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

  create temporary table if not exists _picks (
    slot int, position int, squad_id uuid, category text
  ) on commit drop;
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

  -- ---- the singles is a B. not the A, not a C ----
  select category into v_singles from _picks where slot = 3;
  if v_singles <> 'B' then
    raise exception 'The singles must be played by a Category B player';
  end if;

  -- ---- match 1 is the A with a B, always ----
  select count(*) filter (where category = 'A'),
         count(*) filter (where category = 'B')
    into v_slot1_a, v_slot1_b
    from _picks where slot = 1;

  if v_slot1_a <> 1 or v_slot1_b <> 1 then
    raise exception 'Match 1 must be your Category A player with a Category B player';
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

  update public.match_results r set
    home_trump = case when v_tie.home_team_id = p_team_id then r.slot = p_trump else r.home_trump end,
    away_trump = case when v_tie.away_team_id = p_team_id then r.slot = p_trump else r.away_trump end
  where r.tie_id = p_tie_id;

  return v_sheet;
end $$;

-- the internal helper stays unreachable; sheet_submit is the door
revoke all on function public.sheet_file(int,int,jsonb,int,boolean) from public, anon, authenticated;
