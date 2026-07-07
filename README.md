# 🥒 Monsoon Pickle League — Registration Site + Organiser Console

A polished, deployment-ready registration platform for **Monsoon Pickle League · Season 1**
(22–23 August 2026 · Sportsplex, Kolkata). One repo, two deployable apps:

| App | Folder | Deploy as |
|---|---|---|
| 🎟 **Registration site** (public) | repo root | Vercel project #1 → `yourevent.vercel.app` |
| 🛡 **Organiser console** (login-protected) | `admin/` | Vercel project #2 → `yourevent-admin.vercel.app` |

## Highlights

**Registration site**
- Cinematic **poster loading screen** with progress bar, ambient monsoon rain, and a
  seamless transition into the form
- Player details, **DUPR rating**, categories with partner field for doubles,
  **jersey size + name-on-jersey** with a live jersey preview,
  **profile-picture upload**, Cash/Online payment with **Scan & Pay UPI QR**
  (`assets/qr.png`) and **payment-screenshot upload**
- Animated success **ticket** with unique registration code + confetti
- Reads live **event controls**: organisers can close registrations or show an
  announcement banner instantly from the console
- Hardened for **iOS / Android / desktop** — no zoom-on-focus, safe-area aware,
  `svh` viewport units, reduced-motion support

**Organiser console** (`admin/`)
- Supabase **email + password login**
- **Live dashboard** — new registrations appear in realtime with a toast + row highlight
- Stats, search, filters (category / payment / status), payment-screenshot lightbox
- **Full database control: add, edit, and delete entries** (including replacing
  profile photos / payment screenshots) — every action writes straight to Supabase
- Inline status workflow: `pending → verified → checked-in / rejected`
- **Event Controls**: open/close registrations + announcement banner (live on the form)
- CSV export (filtered view or full backup), bulk-delete rejected entries,
  direct link to your Supabase dashboard

---

## Setup

### 1 · Create the Supabase backend (~5 minutes)

1. Create a free project at [supabase.com](https://supabase.com).
2. **SQL Editor → New query** → paste [`supabase/schema.sql`](supabase/schema.sql) → **Run**.
   Creates the `registrations` table, `event_settings` table, storage bucket,
   realtime feed, and row-level-security policies
   (public can only *submit*; only staff can *read/manage*).
3. Create the organiser login — either:
   - **Dashboard → Authentication → Users → Add user** (check *Auto Confirm User*), or
   - run [`supabase/create-admin.sql`](supabase/create-admin.sql) in the SQL Editor
     (creates `ishanvashistha.1993@gmail.com` with the initial password).
     **⚠ Change the password after first sign-in** — Authentication → Users → … → Reset password.
4. **Project Settings → API** → copy the **Project URL** and **anon public key**, then paste them into **both**:
   - [`js/config.js`](js/config.js) (registration site)
   - [`admin/js/config.js`](admin/js/config.js) (organiser console)

> The anon key is designed to be public — RLS ensures visitors can only insert
> registrations and upload images. Reading or changing data requires the staff login.

### 2 · Deploy on Vercel — two domains from this one repo

**Project 1 — registration site**
1. [vercel.com/new](https://vercel.com/new) → import this repo
2. Framework preset: **Other** · Root Directory: *(leave as repo root)* → **Deploy**

**Project 2 — organiser console**
1. [vercel.com/new](https://vercel.com/new) → import **the same repo** again
2. Framework preset: **Other** · **Root Directory: `admin`** → **Deploy**

Each project gets its own `*.vercel.app` domain (attach custom domains per project
if you like). Both redeploy automatically on every push to `main`.

> Note: the console also exists at `<main-site>/admin/` since it lives in the same
> repo — it's login-protected either way. If you want it *only* on the second
> domain, add a redirect for `/admin/(.*)` in the root `vercel.json`.

### 3 · Payment QR

Your UPI QR ships at [`assets/qr.png`](assets/qr.png) and renders inside the white
*Scan & Pay* frame. Replace that file anytime to change it. Optionally set `upiId`
in `js/config.js` to print the UPI ID under the QR.

---

## Run locally

```bash
npx serve .            # registration site → http://localhost:3000
npx serve admin        # organiser console → http://localhost:3001
```

Until Supabase keys are configured the registration site runs in **demo mode**
(entries persist in the browser's localStorage so the full flow is testable);
the console requires real keys since it operates on the live database.

## Project structure

```
├── index.html            # splash → registration form → success ticket
├── css/style.css         # design system + motion
├── js/
│   ├── config.js         # ← event info + Supabase keys (site)
│   └── app.js            # splash, validation, uploads, submission
├── assets/
│   ├── poster.jpg        # tournament poster (loading screen)
│   └── qr.png            # UPI payment QR
├── admin/                # ← standalone organiser console (own Vercel project)
│   ├── index.html
│   ├── css/admin.css
│   └── js/
│       ├── config.js     # ← Supabase keys (console)
│       └── admin.js      # CRUD, realtime, controls, CSV
├── supabase/
│   ├── schema.sql        # one-shot database + storage + realtime setup
│   └── create-admin.sql  # optional: seed the organiser login
├── vercel.json           # root deploy config (site)
└── admin/vercel.json     # admin deploy config (console)
```

## Customising

- Event info, categories, jersey sizes, fee note → `js/config.js`
- Console option lists → `admin/js/config.js`
- Colours & typography → CSS variables at the top of `css/style.css` / `admin/css/admin.css`
