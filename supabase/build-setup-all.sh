#!/usr/bin/env bash
# Regenerates supabase/setup-all.sql from the individual scripts so the
# one-paste installer can never drift from the sources.
set -euo pipefail
cd "$(dirname "$0")"
{
  cat <<'HDR'
-- ============================================================
--  MONSOON PICKLE LEAGUE — COMPLETE ONE-PASTE SETUP
--
--  Paste this entire file into Supabase → SQL Editor → Run.
--  It is idempotent: safe to run again at any time.
--
--  It installs, in order:
--    1. Registration schema  (registrations, event_settings, storage, RLS)
--    2. Auction schema       (teams, lots, state, bids, credentials, RPCs)
--                            plus the public.app_staff allow-list that
--                            decides who counts as staff
--    3. Organiser login      read from `set mpl.admin_password = '...'`
--                            (no password is stored in this repo)
--    4. All 16 captain logins Team1…Team16, passwords generated on first
--                            run and readable only in the console
--
--  The last statement prints a verification table — every row should
--  read "OK".
--
--  GENERATED FILE — edit the sources and re-run build-setup-all.sh:
--    schema.sql · auction-schema.sql · create-admin.sql · team-logins.sql
-- ============================================================

-- pgcrypto provides crypt()/gen_salt() used to hash the login passwords.
-- Supabase keeps it in the "extensions" schema; a plain psql connection
-- does not have that on its search_path, so make it reachable either way.
do $$
begin
  create extension if not exists pgcrypto with schema extensions;
exception when others then
  begin
    create extension if not exists pgcrypto;
  exception when others then null;
  end;
end $$;

select set_config('search_path', current_setting('search_path') || ', extensions', false);

HDR
  for f in schema.sql auction-schema.sql create-admin.sql team-logins.sql; do
    printf '\n\n-- ############################################################\n'
    printf -- '-- ### %s\n' "$f"
    printf -- '-- ############################################################\n\n'
    cat "$f"
  done
} > setup-all.sql
echo "setup-all.sql regenerated ($(wc -l < setup-all.sql) lines)"
