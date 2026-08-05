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

---

## 🏆 Team Auction

A third app lives in `auction/` for the 16 team captains, served on its own
Vercel domain from this same project.

| Domain | Serves | Folder |
|---|---|---|
| monsoonpickleleague.vercel.app | Registration site | `site/` |
| monsoonadmin.vercel.app | Organiser console | `admin/` |
| **monsoonpickleauction.vercel.app** | **Team auction (16 captains)** | **`auction/`** |

### What it does
- **16 captain logins** — `Team1` … `Team16`, each with its **own** password
  (see `admin/js/config.js → AUCTION.TEAM_PASSWORDS`). Captains pick their team
  from a dropdown; the email is built for them.
- **Auto wallet deduction** — every sale atomically deducts the winning team's
  purse and adds the player to their squad. Purse, spend, squad count and
  "max bid possible" update live in every captain's tab.
- **Live bidding** — captains press one button to bid (base price first, then
  `+ increment`). Bids are rejected server-side if the purse is short or the
  squad is full, so a team can never overspend.
- **Admin master control** (Organiser Console → **Auction** tab): sync
  registered players into the pool, put players on the block one at a time,
  sell to the highest bidder *or* directly to any team at any price, mark
  unsold, undo a sale (auto-refund), reset the whole auction, export an
  auction CSV.
- **Wallet & squad control** — a card per team showing remaining/spent purse,
  the full player list with the price paid for each, inline captain / purse /
  max-squad editing, ± purse top-ups, and one-click release of a player
  (which refunds the team). A purse can never be cut below what a team has
  already spent.
- **Player privacy** — captains read only `auction_lots` (name, DUPR, gender,
  jersey, photo). RLS blocks them from `registrations` entirely, so phone
  numbers, emails and payment screenshots are never exposed to them.

### Activation (one time)
1. Run `supabase/auction-schema.sql` once in Supabase → SQL Editor
   (idempotent; safe to re-run — verified against PostgreSQL 16 with live data).
2. Organiser Console → **Auction** → **Create 16 team logins** (paste the
   Supabase secret key once). The full username/password list is printed
   on screen for you to hand out.

### Auction tables (all additive)
`auction_teams` · `auction_lots` · `auction_state` · `auction_bids`, plus
RPCs `auction_sync_players`, `auction_start_lot`, `auction_bid`, `auction_sell`,
`auction_mark_unsold`, `auction_undo_sale`, `auction_reset`. Money only ever
moves inside these `SECURITY DEFINER` functions, so wallets cannot drift.
