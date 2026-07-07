/* ============================================================
   MPL ADMIN CONSOLE — CONFIG
   The admin console is fully standalone so it can be deployed
   as its own Vercel project (Root Directory: admin) on a
   separate domain from the public registration site.

   Paste the SAME Supabase credentials you used in the main
   site's js/config.js.
   ============================================================ */

window.MPL_ADMIN_CONFIG = {
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: "",

  STORAGE_BUCKET: "registrations",

  /* Prefilled on the login screen (password is never stored here) */
  ADMIN_EMAIL: "ishanvashistha.1993@gmail.com",

  EVENT: {
    name: "Monsoon Pickle League",
    season: "Season 1",
    categories: [
      "Men's Singles",
      "Women's Singles",
      "Men's Doubles",
      "Women's Doubles",
      "Mixed Doubles",
    ],
  },

  JERSEY_SIZES: ["XS", "S", "M", "L", "XL", "XXL"],
  STATUSES: ["pending", "verified", "checked-in", "rejected"],
};
