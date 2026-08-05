/* ============================================================
   MPL ADMIN CONSOLE — CONFIG
   The admin console is fully standalone so it can be deployed
   as its own Vercel project (Root Directory: admin) on a
   separate domain from the public registration site.

   Paste the SAME Supabase credentials you used in the main
   site's js/config.js.
   ============================================================ */

window.MPL_ADMIN_CONFIG = {
  SUPABASE_URL: "https://hcfiatjdlhhtybqxovvf.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhjZmlhdGpkbGhodHlicXhvdnZmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0MjUyNzEsImV4cCI6MjA5OTAwMTI3MX0.Zej_qzmdQ-WCYyeZEv8BqKMOCNF4qYxBhEIoK-lBPv0",

  STORAGE_BUCKET: "registrations",

  EVENT: {
    name: "Monsoon Pickle League",
    season: "Season 1",
  },

  JERSEY_SIZES: ["XS", "S", "M", "L", "XL", "XXL"],
  STATUSES: ["pending", "verified", "checked-in", "rejected"],

  /* ---- Team auction (auction/ app + Auction tab) ---- */
  AUCTION: {
    TEAM_COUNT: 16,
    TEAM_EMAIL_DOMAIN: "monsoonpickleleague.in",
    /* Captain passwords are NOT stored in this repository (it is public).
       They live only in the staff-only auction_team_logins table and are
       shown in Console -> Auction -> Team Logins. */
    CURRENCY: "\u20b9",
    LOCALE: "en-IN",
  },
};
