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
  jersey_size             text not null,
  jersey_name             text not null,
  payment_method          text not null check (payment_method in ('Cash','Online')),
  profile_pic_url         text,
  payment_screenshot_url  text,
  status                  text not null default 'pending'
                          check (status in ('pending','verified','checked-in','rejected'))
);

alter table public.registrations enable row level security;

-- Hardening: bound every column the anonymous role can write, so the
-- public insert policy can't be abused to stuff megabytes of junk.
do $$
begin
  alter table public.registrations
    add constraint reg_full_name_len     check (char_length(full_name)    between 1 and 120),
    add constraint reg_phone_len         check (char_length(phone)        between 7 and 20),
    add constraint reg_email_len         check (email is null or char_length(email) <= 160),
    add constraint reg_gender_valid      check (gender in ('Male','Female','Other')),
    add constraint reg_dupr_range        check (dupr is null or (dupr >= 0 and dupr <= 8)),
    add constraint reg_jersey_size_valid check (jersey_size in ('XS','S','M','L','XL','XXL')),
    add constraint reg_jersey_name_len   check (char_length(jersey_name)  between 1 and 12),
    add constraint reg_code_len          check (char_length(reg_code)     between 6 and 24),
    add constraint reg_pic_url_len       check (profile_pic_url is null or char_length(profile_pic_url) <= 500),
    add constraint reg_shot_url_len      check (payment_screenshot_url is null or char_length(payment_screenshot_url) <= 500);
exception when duplicate_object then null;
end $$;

-- Migration: earlier versions also collected an event category + partner name.
-- Those fields were removed from the registration form; drop the columns (and
-- their constraints) if an older database still has them. Safe to re-run.
alter table public.registrations drop column if exists category;
alter table public.registrations drop column if exists partner_name;

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
  banner_message     text check (banner_message is null or char_length(banner_message) <= 200),
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
-- Hardened: 8 MB cap per file, images only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'registrations', 'registrations', true,
  8388608,
  array['image/jpeg','image/png','image/webp','image/heic','image/heif']
)
on conflict (id) do update
  set file_size_limit   = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

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

-- Image reads: the bucket's `public` flag already serves any *known* object URL
-- (that's how the admin panel loads thumbnails), so we do NOT grant the anon role
-- a blanket SELECT here. Without it, an anonymous visitor cannot LIST/enumerate
-- the bucket — so profile photos and payment screenshots can't be scraped, even
-- though staff and known direct URLs keep working. Only signed-in staff may list.
drop policy if exists "public can view registration images" on storage.objects;
drop policy if exists "staff can view registration images" on storage.objects;
create policy "staff can view registration images"
  on storage.objects for select
  to authenticated
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
