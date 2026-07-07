-- ============================================================
-- MONSOON PICKLE LEAGUE — SUPABASE SCHEMA
-- Run this once in your Supabase project's SQL Editor.
-- (Dashboard → SQL Editor → New query → paste → Run)
-- ============================================================

-- 1) Registrations table ---------------------------------------------------
create table if not exists public.registrations (
  id                      uuid primary key default gen_random_uuid(),
  created_at              timestamptz not null default now(),
  reg_code                text not null unique,
  full_name               text not null,
  phone                   text not null,
  email                   text,
  gender                  text not null,
  dupr                    numeric(5,3),
  category                text not null,
  partner_name            text,
  jersey_size             text not null,
  jersey_name             text not null,
  payment_method          text not null check (payment_method in ('Cash','Online')),
  profile_pic_url         text,
  payment_screenshot_url  text,
  status                  text not null default 'pending'
                          check (status in ('pending','verified','checked-in','rejected'))
);

alter table public.registrations enable row level security;

-- Anyone (the public form) may INSERT a registration…
create policy "public can register"
  on public.registrations for insert
  to anon
  with check (true);

-- …but only signed-in staff can read / manage entries.
create policy "staff can read"
  on public.registrations for select
  to authenticated
  using (true);

create policy "staff can update"
  on public.registrations for update
  to authenticated
  using (true);

create policy "staff can delete"
  on public.registrations for delete
  to authenticated
  using (true);

-- 2) Storage bucket for profile photos + payment screenshots ---------------
insert into storage.buckets (id, name, public)
values ('registrations', 'registrations', true)
on conflict (id) do nothing;

-- The public form may upload into profile/ and payment/ folders only.
create policy "public can upload registration images"
  on storage.objects for insert
  to anon
  with check (
    bucket_id = 'registrations'
    and (storage.foldername(name))[1] in ('profile', 'payment')
  );

-- Bucket is public-read so image URLs work in the admin panel & player cards.
create policy "public can view registration images"
  on storage.objects for select
  to public
  using (bucket_id = 'registrations');

-- Staff may clean up images.
create policy "staff can delete registration images"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'registrations');

-- ============================================================
-- 3) Create your admin login (no SQL needed):
--    Dashboard → Authentication → Users → "Add user"
--    → enter your email + a strong password → Create.
--    Then sign in at /admin.html on your deployed site.
-- ============================================================
