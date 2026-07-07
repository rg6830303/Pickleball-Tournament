# 🥒 Monsoon Pickle League — Registration Site

A polished, deployment-ready registration website for **Monsoon Pickle League · Season 1**
(22–23 August 2026 · Sportsplex, Kolkata).

- **Cinematic loading preview** — the official tournament poster with an animated
  progress bar, ambient rain, and a seamless transition into the form
- **Full registration form** — player details, **DUPR rating**, event category
  (with partner field for doubles), **jersey size + name-on-jersey** with a live
  jersey preview, **profile picture upload**, and Cash/Online payment with
  **Scan & Pay QR + payment-screenshot upload**
- **Success "ticket" page** — animated check, confetti, and a match-day ticket
  with the player's registration code
- **Organiser admin panel** (`/admin.html`) — password-protected dashboard to
  view every entry with photos & payment screenshots, verify payments, mark
  check-ins, filter/search, and **export CSV**
- **Zero build step** — plain HTML/CSS/JS. Deploys anywhere in one click.

Data + image storage is powered by **[Supabase](https://supabase.com)** (free tier
is plenty): registrations land in a Postgres table you fully own, and both images
per player are stored in a Supabase Storage bucket.

---

## 1 · Run it locally

No build tools needed:

```bash
# any static server works
npx serve .
# or
python3 -m http.server 8000
```

Open `http://localhost:8000`. Until Supabase is configured the site runs in
**demo mode** — the full flow works, and entries are saved to the browser's
localStorage so you can test everything end-to-end.

## 2 · Go live with Supabase (~5 minutes)

1. Create a free project at [supabase.com](https://supabase.com).
2. In the dashboard open **SQL Editor → New query**, paste the contents of
   [`supabase/schema.sql`](supabase/schema.sql), and click **Run**.
   This creates the `registrations` table, the `registrations` storage bucket,
   and safe row-level-security policies (public can *submit*, only staff can *read*).
3. Go to **Project Settings → API** and copy:
   - **Project URL**
   - **anon public key**
4. Paste both into [`js/config.js`](js/config.js):

   ```js
   SUPABASE_URL: "https://xxxx.supabase.co",
   SUPABASE_ANON_KEY: "eyJhbGciOi...",
   ```

5. Create your organiser login: **Authentication → Users → Add user**
   (your email + a strong password).

> The anon key is designed to be public — RLS policies ensure visitors can only
> **insert** registrations and **upload** images, never read other players' data.

## 3 · Add your payment QR

Drop your UPI QR image at **`assets/qr.png`** — it appears automatically inside
the white *Scan & Pay* frame. Optionally set `upiId` in `js/config.js` to show
your UPI ID below the QR.

## 4 · Deploy (pick one)

| Platform | How |
|---|---|
| **Vercel** | Import the repo at [vercel.com/new](https://vercel.com/new) → Framework: *Other* → Deploy |
| **Netlify** | Import at [app.netlify.com](https://app.netlify.com) → no build command, publish dir `/` |
| **GitHub Pages** | Repo → Settings → Pages → Deploy from branch → `main` / root |
| **Cloudflare Pages** | Create project → no build command, output dir `/` |

Everything is static, so there are no environment variables or build steps.

## 5 · Manage registrations

- **Admin panel** — visit `/admin.html` on your deployed site and sign in with
  the organiser account. Verify payments (tap any screenshot to zoom), change
  entry statuses (`pending → verified → checked-in`), filter by category or
  payment method, and export a CSV for draws/jersey orders.
- **Supabase dashboard** — the same data is always available under
  **Table Editor → registrations** and **Storage → registrations**.

## Customising

Everything editable lives in [`js/config.js`](js/config.js):

- event name, season, dates, venue, contact numbers
- categories (add/remove; `partner: true` shows the partner-name field)
- jersey sizes
- entry-fee note shown in the payment card
- max upload size

Colours/typography are CSS variables at the top of [`css/style.css`](css/style.css).

## Project structure

```
├── index.html          # splash → registration form → success ticket
├── admin.html          # organiser dashboard (Supabase auth)
├── css/
│   ├── style.css       # design system + form + motion
│   └── admin.css       # dashboard styles
├── js/
│   ├── config.js       # ← the only file you need to edit
│   ├── app.js          # splash, validation, uploads, submission
│   └── admin.js        # dashboard logic, filters, CSV export
├── assets/
│   ├── poster.jpg      # tournament poster (splash screen)
│   └── qr.png          # ← add your UPI QR here
└── supabase/
    └── schema.sql      # one-shot database + storage setup
```
