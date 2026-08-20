/* ============================================================
   MPL LIVE SCOREBOARD — CONFIG
   Public surface. The anon key below is meant to be public: the
   scoreboard reads only the public_* views, and RLS lets anon see
   nothing else. There is no login on this page and there must not be.
   ============================================================ */

window.MPL_STATS_CONFIG = {
  SUPABASE_URL: "https://hcfiatjdlhhtybqxovvf.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhjZmlhdGpkbGhodHlicXhvdnZmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0MjUyNzEsImV4cCI6MjA5OTAwMTI3MX0.Zej_qzmdQ-WCYyeZEv8BqKMOCNF4qYxBhEIoK-lBPv0",

  EVENT: {
    name: "Monsoon Pickle League",
    season: "Season 1",
    when: "Sunday 23 August 2026",
    venue: "Sportsplex, Kolkata",
    firstServe: "First serve 9:00 AM",
  },

  /* Realtime carries the day; this is the belt to its braces. If a socket
     is blocked by a venue firewall the board still moves every 30s. */
  POLL_MS: 30000,
};
