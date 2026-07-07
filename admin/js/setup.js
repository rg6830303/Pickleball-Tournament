/* ============================================================
   MPL SETUP & DIAGNOSTICS
   Runs entirely in the organiser's browser. The secret key is
   held in memory for this tab only — never stored or logged.
   ============================================================ */
(() => {
  "use strict";

  const CFG = window.MPL_ADMIN_CONFIG;
  const $ = (s, r = document) => r.querySelector(s);
  const URL_BASE = CFG.SUPABASE_URL;

  $("#projHost").textContent = new URL(URL_BASE).hostname;

  const secret = () => $("#secretKey").value.trim();

  function looksLikeSecret(k) {
    return k.startsWith("sb_secret_") || k.startsWith("eyJ");
  }

  async function api(path, opts = {}) {
    const key = secret();
    return fetch(URL_BASE + path, {
      ...opts,
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        ...(opts.headers || {}),
      },
    });
  }

  /* ---------- check list rendering ---------- */
  function setCheck(id, state, msg) {
    const li = $("#" + id);
    li.className = state;
    const ic = $(".chk-ic", li);
    ic.innerHTML =
      state === "ok" ? "✓" :
      state === "fail" ? "✕" :
      state === "warn" ? "!" :
      state === "run" ? "<i></i>" : "·";
    $(".chk-msg", li).textContent = msg;
  }

  function banner(el, kind, msg) {
    el.className = "result-banner " + kind;
    el.textContent = msg;
  }

  function busy(btn, on) {
    btn.disabled = on;
    btn.classList.toggle("busy", on);
  }

  const RUN_SCHEMA =
    "Run supabase/schema.sql once in Supabase → SQL Editor, then re-run these checks.";

  /* ---------- STEP 2: checks ---------- */
  async function runChecks() {
    const btn = $("#btnRunChecks");
    const out = $("#checksBanner");
    out.className = "result-banner";

    if (!looksLikeSecret(secret())) {
      banner(out, "err", "Paste your secret key in Step 1 first (starts with sb_secret_ or eyJ).");
      return;
    }
    busy(btn, true);
    let fails = 0;

    /* 1 · reachability */
    setCheck("c-reach", "run", "Contacting project…");
    try {
      const r = await api("/auth/v1/health");
      if (r.ok) setCheck("c-reach", "ok", "Project is online and answering.");
      else if (r.status === 401 || r.status === 403) {
        setCheck("c-reach", "fail", "Project answered but rejected the key — copy the secret key again from Project Settings → API keys.");
        fails++;
      } else {
        setCheck("c-reach", "fail", `Unexpected response (${r.status}). Is the project paused?`);
        fails++;
      }
    } catch {
      setCheck("c-reach", "fail", "Could not reach the project — check your internet connection and the project URL.");
      busy(btn, false);
      banner(out, "err", "Stopped: the project isn't reachable from this browser.");
      return;
    }

    /* 2 · registrations table */
    setCheck("c-table", "run", "Checking table…");
    try {
      const r = await api("/rest/v1/registrations?select=id&limit=1");
      if (r.ok) {
        const rows = await r.json();
        setCheck("c-table", "ok", `Table exists (${rows.length ? "has entries" : "empty, ready for entries"}).`);
      } else {
        setCheck("c-table", "fail", "Table not found. " + RUN_SCHEMA);
        fails++;
      }
    } catch {
      setCheck("c-table", "fail", "Check failed to run — retry.");
      fails++;
    }

    /* 3 · event_settings + row (auto-heals the row) */
    setCheck("c-settings", "run", "Checking controls…");
    try {
      const r = await api("/rest/v1/event_settings?select=id&id=eq.1");
      if (!r.ok) {
        setCheck("c-settings", "fail", "Table not found. " + RUN_SCHEMA);
        fails++;
      } else {
        const rows = await r.json();
        if (rows.length) {
          setCheck("c-settings", "ok", "Event controls are in place.");
        } else {
          const ins = await api("/rest/v1/event_settings", {
            method: "POST",
            headers: { Prefer: "resolution=merge-duplicates" },
            body: JSON.stringify({ id: 1, registration_open: true }),
          });
          if (ins.ok) setCheck("c-settings", "ok", "Controls row was missing — created it for you.");
          else {
            setCheck("c-settings", "warn", "Table exists but the controls row couldn't be created. " + RUN_SCHEMA);
          }
        }
      }
    } catch {
      setCheck("c-settings", "fail", "Check failed to run — retry.");
      fails++;
    }

    /* 4 · storage bucket */
    setCheck("c-bucket", "run", "Checking storage…");
    try {
      const r = await api("/storage/v1/bucket/registrations");
      if (r.ok) setCheck("c-bucket", "ok", "Bucket exists — photo & screenshot uploads will work.");
      else {
        setCheck("c-bucket", "fail", "Bucket not found. " + RUN_SCHEMA);
        fails++;
      }
    } catch {
      setCheck("c-bucket", "fail", "Check failed to run — retry.");
      fails++;
    }

    /* 5 · organiser account */
    setCheck("c-user", "run", "Checking account…");
    try {
      const email = $("#fixEmail").value.trim().toLowerCase();
      const u = await findUser(email);
      if (!u) {
        setCheck("c-user", "warn", `No account for ${email} yet — create it in Step 3 below.`);
      } else if (!u.email_confirmed_at && !u.confirmed_at) {
        setCheck("c-user", "warn", "Account exists but the email is NOT confirmed — that blocks sign-in. Use Step 3 to repair it.");
      } else {
        setCheck("c-user", "ok", "Account exists and the email is confirmed.");
      }
    } catch (e) {
      setCheck("c-user", "fail", "Couldn't query users: " + (e.message || e));
      fails++;
    }

    busy(btn, false);
    if (fails === 0) {
      banner(out, "ok", "Backend verified ✓ — if the account check is yellow, finish Step 3, then test sign-in.");
    } else {
      banner(out, "err", `${fails} check${fails > 1 ? "s" : ""} failed — fix the red items above (usually one run of schema.sql) and re-run.`);
    }
  }

  async function findUser(email) {
    // GoTrue admin: page through users and match locally (works on all versions)
    for (let page = 1; page <= 10; page++) {
      const r = await api(`/auth/v1/admin/users?page=${page}&per_page=100`);
      if (!r.ok) throw new Error(`admin users API returned ${r.status} — is the key the secret key?`);
      const data = await r.json();
      const users = data.users || data || [];
      const hit = users.find((u) => (u.email || "").toLowerCase() === email);
      if (hit) return hit;
      if (users.length < 100) return null;
    }
    return null;
  }

  /* ---------- STEP 3: create / reset login ---------- */
  async function fixLogin() {
    const btn = $("#btnFixLogin");
    const out = $("#loginBanner");
    out.className = "result-banner";

    const email = $("#fixEmail").value.trim().toLowerCase();
    const pass = $("#fixPass").value;
    if (!looksLikeSecret(secret()))
      return banner(out, "err", "Paste your secret key in Step 1 first.");
    if (!email || !/@/.test(email))
      return banner(out, "err", "Enter the admin email.");
    if (pass.length < 6)
      return banner(out, "err", "Password must be at least 6 characters.");

    busy(btn, true);
    try {
      const existing = await findUser(email);
      if (existing) {
        const r = await api(`/auth/v1/admin/users/${existing.id}`, {
          method: "PUT",
          body: JSON.stringify({ password: pass, email_confirm: true }),
        });
        if (!r.ok) throw new Error((await r.json()).msg || `update failed (${r.status})`);
        banner(out, "ok", `Account repaired ✓ — password reset and email confirmed for ${email}. Now hit “Test sign-in”.`);
      } else {
        const r = await api("/auth/v1/admin/users", {
          method: "POST",
          body: JSON.stringify({ email, password: pass, email_confirm: true }),
        });
        if (!r.ok) throw new Error((await r.json()).msg || `create failed (${r.status})`);
        banner(out, "ok", `Account created ✓ for ${email}, email pre-confirmed. Now hit “Test sign-in”.`);
      }
      setCheck("c-user", "ok", "Account exists and the email is confirmed.");
    } catch (e) {
      banner(out, "err", "Couldn't create/reset the login: " + (e.message || e));
    } finally {
      busy(btn, false);
    }
  }

  /* ---------- real sign-in test (uses the public anon key) ---------- */
  async function testLogin() {
    const out = $("#loginBanner");
    out.className = "result-banner";
    const email = $("#fixEmail").value.trim().toLowerCase();
    const pass = $("#fixPass").value;
    if (!email || !pass)
      return banner(out, "err", "Fill in the email and password above, then test.");

    try {
      const r = await fetch(URL_BASE + "/auth/v1/token?grant_type=password", {
        method: "POST",
        headers: {
          apikey: CFG.SUPABASE_ANON_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, password: pass }),
      });
      const data = await r.json();
      if (r.ok && data.access_token) {
        banner(out, "ok", "Sign-in works ✓ — use these exact credentials on the console login page. You're all set.");
      } else {
        banner(out, "err", "Sign-in failed: " + (data.error_description || data.msg || r.status) + ". Run “Create / Reset Login” above, then test again.");
      }
    } catch {
      banner(out, "err", "Couldn't reach the auth service — check your connection.");
    }
  }

  $("#btnRunChecks").addEventListener("click", runChecks);
  $("#btnFixLogin").addEventListener("click", fixLogin);
  $("#btnTestLogin").addEventListener("click", testLogin);
})();
