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
--    3. Organiser login      ishanvashistha.1993@gmail.com / Pickle2026
--    4. All 16 captain logins Team1…Team16 with their passwords
--
--  The last statement prints a verification table — every row should
--  read "OK".
--
--  GENERATED FILE — edit the sources and re-run build-setup-all.sh:
--    schema.sql · auction-schema.sql · create-admin.sql · team-logins.sql
-- ============================================================

HDR
  for f in schema.sql auction-schema.sql create-admin.sql team-logins.sql; do
    printf '\n\n-- ############################################################\n'
    printf -- '-- ### %s\n' "$f"
    printf -- '-- ############################################################\n\n'
    cat "$f"
  done
} > setup-all.sql
echo "setup-all.sql regenerated ($(wc -l < setup-all.sql) lines)"
