/* ============================================================
   MPL TEAM AUCTION — CONFIG
   Standalone app for the 16 team captains.
   Uses the SAME Supabase project as the registration site.
   ============================================================ */

window.MPL_AUCTION_CONFIG = {
  SUPABASE_URL: "https://hcfiatjdlhhtybqxovvf.supabase.co",
  SUPABASE_ANON_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhjZmlhdGpkbGhodHlicXhvdnZmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0MjUyNzEsImV4cCI6MjA5OTAwMTI3MX0.Zej_qzmdQ-WCYyeZEv8BqKMOCNF4qYxBhEIoK-lBPv0",

  /* Team logins are team1@… … team16@… on this domain.
     Captains only ever type "Team 7" — the email is built for them. */
  TEAM_EMAIL_DOMAIN: "monsoonpickleleague.in",
  TEAM_COUNT: 16,

  EVENT: {
    name: "Monsoon Pickle League",
    season: "Season 1",
  },

  /* Currency formatting for purse / bid amounts */
  CURRENCY: "₹",
  LOCALE: "en-IN",

  /* ------------------------------------------------------------
     AUCTION VISIBILITY

     false → captains see only their final squad. The purse strip,
             the lot on the block, the bid button, the ticker and
     the league purse table are all hidden, and no auction data is
     fetched at all.

     The auction engine itself is untouched — every table, policy
     and RPC is still in place, and the organiser console still
     runs the room. Flip this back to true to reopen the auction
     for captains; nothing else needs changing.
     ------------------------------------------------------------ */
  SHOW_AUCTION: false,
};
