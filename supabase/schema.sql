-- ============================================================
-- MONSOON PICKLE LEAGUE — SUPABASE SCHEMA
-- Run this once in your Supabase project's SQL Editor.
-- (Dashboard → SQL Editor → New query → paste → Run)
-- Safe to re-run: everything is IF NOT EXISTS / idempotent.
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
drop policy if exists "public can register" on public.registrations;
create policy "public can register"
  on public.registrations for insert
  to anon
  with check (true);

-- …but only signed-in staff can read / manage entries.
drop policy if exists "staff can read" on public.registrations;
create policy "staff can read"
  on public.registrations for select
  to authenticated
  using (true);

drop policy if exists "staff can insert" on public.registrations;
create policy "staff can insert"
  on public.registrations for insert
  to authenticated
  with check (true);

drop policy if exists "staff can update" on public.registrations;
create policy "staff can update"
  on public.registrations for update
  to authenticated
  using (true);

drop policy if exists "staff can delete" on public.registrations;
create policy "staff can delete"
  on public.registrations for delete
  to authenticated
  using (true);

-- 2) Event settings (admin console → Event Controls) ------------------------
create table if not exists public.event_settings (
  id                 int primary key check (id = 1),
  registration_open  boolean not null default true,
  banner_message     text,
  updated_at         timestamptz not null default now()
);

insert into public.event_settings (id, registration_open)
values (1, true)
on conflict (id) do nothing;

alter table public.event_settings enable row level security;

-- The public form reads settings (open/closed + banner)…
drop policy if exists "public can read settings" on public.event_settings;
create policy "public can read settings"
  on public.event_settings for select
  to anon, authenticated
  using (true);

-- …only staff can change them.
drop policy if exists "staff can update settings" on public.event_settings;
create policy "staff can update settings"
  on public.event_settings for update
  to authenticated
  using (true);

drop policy if exists "staff can insert settings" on public.event_settings;
create policy "staff can insert settings"
  on public.event_settings for insert
  to authenticated
  with check (true);

-- 3) Realtime — new registrations appear live in the admin console ----------
do $$
begin
  alter publication supabase_realtime add table public.registrations;
exception when duplicate_object then null;
end $$;

-- 4) Storage bucket for profile photos + payment screenshots ---------------
insert into storage.buckets (id, name, public)
values ('registrations', 'registrations', true)
on conflict (id) do nothing;

-- The public form may upload into profile/ and payment/ folders only.
drop policy if exists "public can upload registration images" on storage.objects;
create policy "public can upload registration images"
  on storage.objects for insert
  to anon
  with check (
    bucket_id = 'registrations'
    and (storage.foldername(name))[1] in ('profile', 'payment')
  );

-- Staff may upload/replace images from the admin console.
drop policy if exists "staff can upload registration images" on storage.objects;
create policy "staff can upload registration images"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'registrations');

drop policy if exists "staff can replace registration images" on storage.objects;
create policy "staff can replace registration images"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'registrations');

-- Bucket is public-read so image URLs work in the admin panel & player cards.
drop policy if exists "public can view registration images" on storage.objects;
create policy "public can view registration images"
  on storage.objects for select
  to public
  using (bucket_id = 'registrations');

-- Staff may clean up images.
drop policy if exists "staff can delete registration images" on storage.objects;
create policy "staff can delete registration images"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'registrations');

-- ============================================================
-- NEXT: create the organiser login.
-- Easiest: Dashboard → Authentication → Users → "Add user"
-- Or run supabase/create-admin.sql for a ready-made account.
-- ============================================================
