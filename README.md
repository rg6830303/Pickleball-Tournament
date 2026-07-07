# 🥒 Monsoon Pickle League — Registration Site + Organiser Console

A polished, deployment-ready registration platform for **Monsoon Pickle League · Season 1**
(22–23 August 2026 · Sportsplex, Kolkata). One repo, one Vercel project, **two domains**:

| Domain | Serves | Folder |
|---|---|---|
| **monsoonpickleleague.vercel.app** | 🎟 Public registration site | `site/` |
| **monsoonadmin.vercel.app** | 🛡 Organiser console (login-protected) | `admin/` |

Host-based rewrites in [`vercel.json`](vercel.json) route each domain to its app —
no extra Vercel projects or build settings needed. Both apps are plain HTML/CSS/JS
(zero build step) and talk to the same **Supabase** backend, whose URL + anon key
are already configured in `site/js/config.js` and `admin/js/config.js`.

## Highlights

**Registration site**
- Cinematic **poster loading screen** with progress bar, ambient monsoon rain, and
  a seamless transition into the form
- Player details, **DUPR rating**, categories with partner field for doubles,
  **jersey size + name-on-jersey** with live jersey preview,
  **profile-picture upload**, Cash/Online payment with **Scan & Pay UPI QR**
  (`site/assets/qr.png`) and required **payment-screenshot upload**
- Animated success **ticket** with unique registration code + confetti
- Obeys live **event controls**: close registrations or show an announcement
  banner instantly from the console
- Hardened for iOS / Android / desktop; Supabase client is **vendored locally**
  (`js/vendor/supabase.js`) — no third-party CDN at runtime

**Organiser console**
- Supabase **email + password login**
- **Realtime dashboard** — new registrations appear live with a toast + highlight
- Stats, search, filters, payment-screenshot lightbox
- **Full database control: add, edit, delete entries** (incl. replacing photos /
  screenshots) — every action writes straight to Supabase
- Status workflow `pending → verified → checked-in / rejected`
- **Event Controls**: open/close registrations + announcement banner
- CSV export (filtered or full backup), bulk-delete rejected entries

## One-time database setup

Open your Supabase project → **SQL Editor** and run, in order:

1. [`supabase/schema.sql`](supabase/schema.sql) — creates the `registrations` and
   `event_settings` tables, the storage bucket, the realtime feed, and all
   row-level-security policies.
2. [`supabase/create-admin.sql`](supabase/create-admin.sql) — creates the
   organiser login. **Change this password after your first sign-in**
   (Authentication → Users → ⋯ → Reset password).

That's it — the deployed site starts writing registrations immediately, and the
console can manage them.

## Security model

- **RLS is enabled on every table.** The public (anon) role can only **INSERT**
  registrations and **read** event settings — it can never read, modify, or
  delete entries. All management requires an authenticated staff session.
- **Column constraints** bound everything the public can write (lengths,
  allowed values, DUPR range) so the insert policy can't be abused.
- **Storage bucket** accepts only images, max 8 MB, and anonymous uploads are
  restricted to the `profile/` and `payment/` folders.
- The **anon key in the client configs is public by design** — it grants only
  what RLS allows. Keep the `service_role` key, JWT secret, and database
  password strictly private (server-side only, never in this repo). If they are
  ever exposed, rotate them: Project Settings → API / Database.
- Security headers (nosniff, frame-deny, referrer policy) ship via `vercel.json`;
  the console is `noindex` on both paths and domains.

## Managing & downloading your data

- **Console** (monsoonadmin.vercel.app): view/verify/edit everything, export
  **CSV** of the filtered view or a full backup.
- **Supabase dashboard**: Table Editor → `registrations` (also exports CSV),
  Storage → `registrations` for the raw images.

## Local development

```bash
python3 -m http.server 8090
# site  → http://localhost:8090/site/
# admin → http://localhost:8090/admin/
```

(The domain routing in `vercel.json` only applies on Vercel; locally, use the
folder paths.)

## Project structure

```
├── vercel.json             # host routing (2 domains) + security headers
├── site/                   # public registration app
│   ├── index.html          # splash → form → success ticket
│   ├── css/style.css
│   ├── js/config.js        # event info + Supabase keys
│   ├── js/app.js
│   ├── js/vendor/supabase.js
│   └── assets/{poster.jpg, qr.png}
├── admin/                  # organiser console
│   ├── index.html
│   ├── css/admin.css
│   ├── js/config.js        # Supabase keys + option lists
│   ├── js/admin.js
│   └── js/vendor/supabase.js
└── supabase/
    ├── schema.sql          # tables + RLS + storage + realtime (idempotent)
    └── create-admin.sql    # organiser login seed
```

## Customising

- Event info, categories, jersey sizes, fee note, UPI id → `site/js/config.js`
- Console option lists → `admin/js/config.js`
- Payment QR → replace `site/assets/qr.png`
- Colours & typography → CSS variables in `site/css/style.css` / `admin/css/admin.css`
