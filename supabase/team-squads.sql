-- ============================================================
--  MONSOON PICKLE LEAGUE — FINAL SQUADS ("Sixteen Squads")
--  Idempotent: safe to run more than once.
--
--  Adds:
--    * auction_teams.group_code / group_rank   (Group A–D, 01–04)
--    * public.team_squads                      (9 players per team)
--
--  Players are linked to auction_pool by sl_no, so the roster keeps
--  its category (A/B/C) and any photo the pool already holds.
--  Nothing in the auction tables is modified — this is an additive
--  layer that the console and the captain app read from.
-- ============================================================

-- ------------------------------------------------------------
-- 1) GROUPS ON THE TEAM ROW
-- ------------------------------------------------------------
alter table public.auction_teams add column if not exists group_code text;
alter table public.auction_teams add column if not exists group_rank int;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'auction_teams_group_code_chk'
  ) then
    alter table public.auction_teams
      add constraint auction_teams_group_code_chk
      check (group_code is null or group_code in ('A','B','C','D'));
  end if;
end $$;

-- ------------------------------------------------------------
-- 2) SQUAD TABLE
-- ------------------------------------------------------------
create table if not exists public.team_squads (
  id          uuid primary key default gen_random_uuid(),
  team_id     int  not null references public.auction_teams(id) on delete cascade,
  pool_id     uuid references public.auction_pool(id) on delete set null,
  player_name text not null,
  category    text not null check (category in ('A','B','C')),
  retained    boolean not null default false,
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint team_squads_slot_uniq unique (team_id, sort_order)
);

create index if not exists team_squads_team_idx on public.team_squads(team_id, sort_order);
create index if not exists team_squads_pool_idx on public.team_squads(pool_id);

create or replace function public.team_squads_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists team_squads_touch on public.team_squads;
create trigger team_squads_touch before update on public.team_squads
  for each row execute function public.team_squads_touch();

-- ------------------------------------------------------------
-- 3) ROW LEVEL SECURITY
--    Staff manage everything. A signed-in captain may read the
--    whole squad list (the line-ups are published on the poster),
--    but may never write.
-- ------------------------------------------------------------
alter table public.team_squads enable row level security;

drop policy if exists "auth can read squads"  on public.team_squads;
drop policy if exists "staff manage squads"   on public.team_squads;

create policy "auth can read squads"
  on public.team_squads for select to authenticated
  using (true);

create policy "staff manage squads"
  on public.team_squads for all to authenticated
  using (public.is_auction_staff())
  with check (public.is_auction_staff());

grant select on public.team_squads to authenticated;
grant insert, update, delete on public.team_squads to authenticated;

-- live updates in the console + captain app
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'team_squads'
  ) then
    alter publication supabase_realtime add table public.team_squads;
  end if;
end $$;

-- ------------------------------------------------------------
-- 4) THE SIXTEEN SQUADS
-- ------------------------------------------------------------
with poster(group_code, group_rank, team_name, slot, sl_no, player_name, retained) as (
  values
  -- ===== GROUP A =====
  ('A',1,'Holbrook Smashers',   1,  10,'Akash Joshi',           false),
  ('A',1,'Holbrook Smashers',   2,  23,'Ishan Goenka',          true ),
  ('A',1,'Holbrook Smashers',   3,  31,'Rishi Agarwal',         false),
  ('A',1,'Holbrook Smashers',   4,  29,'Shivam Patel',          false),
  ('A',1,'Holbrook Smashers',   5,  66,'Yash Agarwal',          false),
  ('A',1,'Holbrook Smashers',   6, 114,'Aliasagar Saleh',       false),
  ('A',1,'Holbrook Smashers',   7, 133,'Maanvardhan Baid',      false),
  ('A',1,'Holbrook Smashers',   8,  84,'Shaurya Agarwal',       true ),
  ('A',1,'Holbrook Smashers',   9, 123,'Priyanka Saklecha',     false),

  ('A',2,'Picklers Den',        1,  12,'Arup Mallick',          false),
  ('A',2,'Picklers Den',        2,  28,'Abhishek Dalmia',       false),
  ('A',2,'Picklers Den',        3,  26,'Puneet Gaggar',         false),
  ('A',2,'Picklers Den',        4,  54,'Mudit Pugalia',         false),
  ('A',2,'Picklers Den',        5,  14,'Saurabh Agarwal',       false),
  ('A',2,'Picklers Den',        6, 101,'Murtaza Kaukawala',     false),
  ('A',2,'Picklers Den',        7,  90,'Saurabh Damani',        false),
  ('A',2,'Picklers Den',        8, 138,'Avisek Kar',            false),
  ('A',2,'Picklers Den',        9,  81,'Swayam Pasari',         false),

  ('A',3,'Superpro',            1,   1,'Rahil Saraf',           true ),
  ('A',3,'Superpro',            2,  71,'Shaizan Alam',          false),
  ('A',3,'Superpro',            3,  48,'Ishaan Chetani',        true ),
  ('A',3,'Superpro',            4,  36,'Varun Dhariwal',        false),
  ('A',3,'Superpro',            5,  74,'Sourav Agarwal',        false),
  ('A',3,'Superpro',            6, 134,'Avishek Mehra',         false),
  ('A',3,'Superpro',            7, 136,'Vivek Bhasin',          false),
  ('A',3,'Superpro',            8, 105,'Raju Agarwal',          false),
  ('A',3,'Superpro',            9, 103,'Aditya Choudhary',      false),

  ('A',4,'Poker Nova',          1, 142,'Keshav Pachisia',       false),
  ('A',4,'Poker Nova',          2,  15,'Bhavya Kanoi',          true ),
  ('A',4,'Poker Nova',          3,  91,'Kush Jain',             false),
  ('A',4,'Poker Nova',          4, 144,'Vivek Kheria',          false),
  ('A',4,'Poker Nova',          5,  61,'Vishnu Jain',           false),
  ('A',4,'Poker Nova',          6,  80,'Tanish Kejriwal',       false),
  ('A',4,'Poker Nova',          7,  32,'Jatin Agarwal',         false),
  ('A',4,'Poker Nova',          8,  96,'Devanshi Bansal',       true ),
  ('A',4,'Poker Nova',          9, 115,'Lokesh Singh',          false),

  -- ===== GROUP B =====
  ('B',1,'Kee and Ka',          1,   2,'Lokendra Solanki',      true ),
  ('B',1,'Kee and Ka',          2,  87,'Suraj Garg',            false),
  ('B',1,'Kee and Ka',          3, 120,'Mayank Sonthalia',      false),
  ('B',1,'Kee and Ka',          4,  56,'Amar Jaiswal',          false),
  ('B',1,'Kee and Ka',          5,  64,'Nirvik Sharma',         false),
  ('B',1,'Kee and Ka',          6,  40,'Shubham Daga',          false),
  ('B',1,'Kee and Ka',          7, 139,'Srijoni Roy',           false),
  ('B',1,'Kee and Ka',          8, 141,'Vikash Gadia',          false),
  ('B',1,'Kee and Ka',          9, 119,'Ujjwal Mussadi',        false),

  ('B',2,'Court Hustlers',      1,   8,'Sudarshan Jagnani',     false),
  ('B',2,'Court Hustlers',      2,  70,'Aaryaman Singh Vats',   false),
  ('B',2,'Court Hustlers',      3,  57,'Vinay Bhalotia',        false),
  ('B',2,'Court Hustlers',      4,  76,'Arkam Zahid',           false),
  ('B',2,'Court Hustlers',      5,  88,'Naval Kala',            false),
  ('B',2,'Court Hustlers',      6,  95,'Shivangi Agarwal',      true ),
  ('B',2,'Court Hustlers',      7,  99,'Rahul Lohia',           false),
  ('B',2,'Court Hustlers',      8, 131,'Mudita Bagla',          false),
  ('B',2,'Court Hustlers',      9, 137,'Devang Ganatra',        false),

  ('B',3,'Dink Slayers',        1,  59,'Dewesh Kyal',           false),
  ('B',3,'Dink Slayers',        2,  39,'Ayush Chaturvedi',      false),
  ('B',3,'Dink Slayers',        3,  16,'Krishan Bachawat',      true ),
  ('B',3,'Dink Slayers',        4,  46,'Vivek Burman',          true ),
  ('B',3,'Dink Slayers',        5,  37,'Nishan Agarwal',        false),
  ('B',3,'Dink Slayers',        6,  38,'Aastha Seth',           false),
  ('B',3,'Dink Slayers',        7, 122,'Nisha Choudhary',       false),
  ('B',3,'Dink Slayers',        8,  82,'P. Radhakrishnan',      false),
  ('B',3,'Dink Slayers',        9, 110,'Sahil Saharia',         false),

  ('B',4,'TurfXL',              1,   5,'Avinash Kalyani',       true ),
  ('B',4,'TurfXL',              2,  33,'Manish Mandhyan',       false),
  ('B',4,'TurfXL',              3,  52,'Nikunj Keyal',          true ),
  ('B',4,'TurfXL',              4,  34,'Rudraksh Gupta',        false),
  ('B',4,'TurfXL',              5,  58,'Sandeep Garg',          false),
  ('B',4,'TurfXL',              6,  20,'Prateek Sonthalia',     false),
  ('B',4,'TurfXL',              7, 106,'Vatsal Sarawgi',        false),
  ('B',4,'TurfXL',              8, 100,'Aditya Behani',         false),
  ('B',4,'TurfXL',              9, 104,'Vishaal Manot',         false),

  -- ===== GROUP C =====
  ('C',1,'Jamshedpur Smashers', 1,  11,'Amit Nagrecha',         false),
  ('C',1,'Jamshedpur Smashers', 2,  43,'Amogh Agarwal',         false),
  ('C',1,'Jamshedpur Smashers', 3,  63,'Vaibhav Bosmia',        false),
  ('C',1,'Jamshedpur Smashers', 4,  25,'Anubhav Jain',          false),
  ('C',1,'Jamshedpur Smashers', 5,  51,'Chirag Jain',           false),
  ('C',1,'Jamshedpur Smashers', 6,  98,'Anshika Choudhary',     false),
  ('C',1,'Jamshedpur Smashers', 7, 102,'Saif Ali Haque',        false),
  ('C',1,'Jamshedpur Smashers', 8, 113,'Aditya Kabra',          false),
  ('C',1,'Jamshedpur Smashers', 9, 112,'Raghav Kabra',          false),

  ('C',2,'Mavericks',           1, 143,'Nandan Bhandari',       false),
  ('C',2,'Mavericks',           2,  68,'Nilesh Rathi',          false),
  ('C',2,'Mavericks',           3,  55,'Rohit Jhunjhunwala',    false),
  ('C',2,'Mavericks',           4,  77,'Aman Agarwal',          false),
  ('C',2,'Mavericks',           5,  19,'Kunal Dujari',          false),
  ('C',2,'Mavericks',           6,  83,'Harshit Dhanuka',       false),
  ('C',2,'Mavericks',           7, 107,'Vijay Kumar',           false),
  ('C',2,'Mavericks',           8,  79,'Rahul Kochar',          false),
  ('C',2,'Mavericks',           9, 108,'Kausal',                false),

  ('C',3,'Knight Dinkers',      1,  45,'Samarth Singhi',        false),
  ('C',3,'Knight Dinkers',      2,  53,'Divyansh Jhunjhunwala', false),
  ('C',3,'Knight Dinkers',      3,  27,'Umang Todi',            true ),
  ('C',3,'Knight Dinkers',      4,  65,'Anant Singh',           true ),
  ('C',3,'Knight Dinkers',      5,  44,'Devash Dhanania',       false),
  ('C',3,'Knight Dinkers',      6, 121,'Niharika Bhagat',       false),
  ('C',3,'Knight Dinkers',      7, 132,'Nikunj Bhaiyya',        false),
  ('C',3,'Knight Dinkers',      8,  94,'Vihaan Dhariwal',       false),
  ('C',3,'Knight Dinkers',      9, 135,'Bhaavya Gaour',         false),

  ('C',4,'Baseline Bandits',    1,   4,'Abhra Ghosh',           true ),
  ('C',4,'Baseline Bandits',    2,   9,'Eashan Chaudhary',      true ),
  ('C',4,'Baseline Bandits',    3,  67,'Aryan Baid',            false),
  ('C',4,'Baseline Bandits',    4,  35,'Piyush Jaiswal',        false),
  ('C',4,'Baseline Bandits',    5,  69,'Subham Kanoi',          false),
  ('C',4,'Baseline Bandits',    6, 129,'Krishna Behani',        false),
  ('C',4,'Baseline Bandits',    7, 116,'Abhishek Agarwal',      false),
  ('C',4,'Baseline Bandits',    8, 130,'Rahul Ghosh',           false),
  ('C',4,'Baseline Bandits',    9, 140,'Jayesh Choratia',       false),

  -- ===== GROUP D =====
  ('D',1,'Pickle Pirates',      1,   3,'Raghav Taparia',        true ),
  ('D',1,'Pickle Pirates',      2,  41,'CA Aakash Kumar',       false),
  ('D',1,'Pickle Pirates',      3,  60,'Ketan Patel',           false),
  ('D',1,'Pickle Pirates',      4,  72,'Navneet Manaksia',      false),
  ('D',1,'Pickle Pirates',      5,  30,'Ritwik Jhunjhunwala',   false),
  ('D',1,'Pickle Pirates',      6,  97,'Avani Jatia',           false),
  ('D',1,'Pickle Pirates',      7,  78,'Partha Ghoshal',        false),
  ('D',1,'Pickle Pirates',      8, 111,'Mohit Lakhotia',        false),
  ('D',1,'Pickle Pirates',      9,  93,'Sayan',                 false),

  ('D',2,'Rajwada Warriors',    1,   6,'Karan Juneja',          false),
  ('D',2,'Rajwada Warriors',    2,  75,'Raunak Jain',           false),
  ('D',2,'Rajwada Warriors',    3,  18,'Bikash Agarwal',        false),
  ('D',2,'Rajwada Warriors',    4,  42,'Kaustav Majumdar',      false),
  ('D',2,'Rajwada Warriors',    5,  49,'Mukul Agarwal',         false),
  ('D',2,'Rajwada Warriors',    6, 125,'Yash Damani',           false),
  ('D',2,'Rajwada Warriors',    7,  89,'Mustanzir Kothawala',   false),
  ('D',2,'Rajwada Warriors',    8,  86,'Aadarsh Sonthalia',     false),
  ('D',2,'Rajwada Warriors',    9, 127,'Aditya Shah',           false),

  ('D',3,'Ur Smile Matters',    1,   7,'Sahil Mehta',           false),
  ('D',3,'Ur Smile Matters',    2,  50,'Shalbh Agarwal',        false),
  ('D',3,'Ur Smile Matters',    3,  47,'Ashish Mandelia',       true ),
  ('D',3,'Ur Smile Matters',    4,  73,'Mufaddal Faizullabhoy', false),
  ('D',3,'Ur Smile Matters',    5,  22,'Niraj Goel',            false),
  ('D',3,'Ur Smile Matters',    6,  92,'Hetal Sonpal',          false),
  ('D',3,'Ur Smile Matters',    7, 117,'Harsh Maurya',          false),
  ('D',3,'Ur Smile Matters',    8, 128,'Dhiman Banerjee',       false),
  ('D',3,'Ur Smile Matters',    9, 126,'Tushar Saraogi',        false),

  ('D',4,'Sportsplex Smashers', 1,  13,'Sahotra Sengupta',      false),
  ('D',4,'Sportsplex Smashers', 2,  17,'Mikato',                false),
  ('D',4,'Sportsplex Smashers', 3,  21,'Jay Seta',              true ),
  ('D',4,'Sportsplex Smashers', 4,  24,'Mayank Parakh',         true ),
  ('D',4,'Sportsplex Smashers', 5,  62,'Keshav Jain',           false),
  ('D',4,'Sportsplex Smashers', 6,  85,'Arjun Jindal',          false),
  ('D',4,'Sportsplex Smashers', 7, 124,'Vaibhav Chowdhury',     false),
  ('D',4,'Sportsplex Smashers', 8, 109,'Mangalam Lakhotia',     false),
  ('D',4,'Sportsplex Smashers', 9, 118,'Kapol Sarkar',          false)
),
resolved as (
  select t.id  as team_id,
         p.id  as pool_id,
         poster.group_code,
         poster.group_rank,
         poster.slot,
         poster.player_name,
         poster.retained,
         p.category
  from poster
  join public.auction_teams t on t.name = poster.team_name
  join public.auction_pool  p on p.sl_no = poster.sl_no
),
guard as (
  -- fail loudly rather than seed a half-built league
  select case
    when (select count(*) from poster)   <> 144 then
      (select 1 / 0 where true)                       -- poster must list 144
    when (select count(*) from resolved) <> 144 then
      (select 1 / 0 where true)                       -- every team + player must resolve
    when (select count(distinct sl_no) from poster) <> 144 then
      (select 1 / 0 where true)                       -- no player on two teams
    else 0 end as ok
),
teams_upd as (
  update public.auction_teams t
     set group_code = r.group_code,
         group_rank = r.group_rank
    from (select distinct team_id, group_code, group_rank from resolved) r
   where t.id = r.team_id
  returning 1
)
insert into public.team_squads (team_id, pool_id, player_name, category, retained, sort_order)
select team_id, pool_id, player_name, category, retained, slot
  from resolved, guard
on conflict (team_id, sort_order) do update
  set pool_id     = excluded.pool_id,
      player_name = excluded.player_name,
      category    = excluded.category,
      retained    = excluded.retained;

-- drop any stale slot beyond the nine on the poster
delete from public.team_squads where sort_order not between 1 and 9;
