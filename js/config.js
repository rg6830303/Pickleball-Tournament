/* ============================================================
   MONSOON PICKLE LEAGUE — SITE CONFIG
   Edit this file to wire up your backend & tweak event info.
   ============================================================ */

window.MPL_CONFIG = {
  /* ---- Supabase (data + image storage) ----------------------
     1. Create a free project at https://supabase.com
     2. Run supabase/schema.sql in the SQL editor
     3. Paste your Project URL + anon public key below
     While these are empty the site runs in DEMO mode:
     submissions are saved to this browser's localStorage only. */
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: "",

  /* Storage bucket name (created by schema.sql) */
  STORAGE_BUCKET: "registrations",

  /* ---- Event details ---------------------------------------- */
  EVENT: {
    name: "Monsoon Pickle League",
    season: "Season 1",
    presenter: "Kendu Entertainment, Proflex & Veloserve",
    dates: "22–23 August, 2026",
    venue: "Sportsplex, Kolkata",
    tagline: "Champion takes the glory",
    phones: ["+91 80176 72062", "+91 70032 68862"],

    /* Categories offered. `partner: true` reveals a partner-name field. */
    categories: [
      { id: "mens-singles",   label: "Men's Singles",   partner: false },
      { id: "womens-singles", label: "Women's Singles", partner: false },
      { id: "mens-doubles",   label: "Men's Doubles",   partner: true  },
      { id: "womens-doubles", label: "Women's Doubles", partner: true  },
      { id: "mixed-doubles",  label: "Mixed Doubles",   partner: true  },
    ],

    /* Entry fee text shown in the payment card. Edit freely,
       e.g. "₹999 per player · ₹1,798 per doubles team" */
    feeNote: "Pay the entry fee, then attach the screenshot below.",

    /* Optional UPI id shown under the QR (leave "" to hide) */
    upiId: "",
  },

  /* Jersey sizes offered */
  JERSEY_SIZES: ["XS", "S", "M", "L", "XL", "XXL"],

  /* Max upload size per image, in MB (images are auto-compressed) */
  MAX_UPLOAD_MB: 8,
};
