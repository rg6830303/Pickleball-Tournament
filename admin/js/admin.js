/* ============================================================
   MPL ORGANISER CONSOLE
   Supabase auth · live registrations · full CRUD · event controls
   ============================================================ */
(() => {
  "use strict";

  const CFG = window.MPL_ADMIN_CONFIG;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const LIVE = Boolean(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
  let sb = null;
  let rows = [];
  let editingId = null;   // null = add mode
  let freshIds = new Set();
  let confirmAction = null;
  let gridFocused = false; // a spreadsheet cell currently has focus
  let gridDirty = false;   // a realtime change arrived while editing → re-render on blur

  /* ---------------- utilities ---------------- */
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  function toast(msg, kind = "ok") {
    const t = document.createElement("div");
    t.className = `toast ${kind === "ok" ? "" : kind}`.trim();
    t.textContent = msg;
    $("#toasts").appendChild(t);
    setTimeout(() => t.classList.add("out"), 3200);
    setTimeout(() => t.remove(), 3700);
  }

  function alertBox(el, msg) {
    el.textContent = msg;
    el.classList.remove("show");
    void el.offsetWidth;
    el.classList.add("show");
  }

  function busy(btn, on) {
    btn.disabled = on;
    btn.classList.toggle("busy", on);
  }

  function regCode() {
    const n = Math.floor(1000 + Math.random() * 9000);
    return `MPL-S1-${Date.now().toString(36).toUpperCase().slice(-4)}${n}`;
  }

  async function compressImage(file, maxDim = 1600, quality = 0.85) {
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
      if (scale === 1 && file.size < 900 * 1024) return file;
      const cv = document.createElement("canvas");
      cv.width = Math.round(bmp.width * scale);
      cv.height = Math.round(bmp.height * scale);
      cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
      const blob = await new Promise((res) => cv.toBlob(res, "image/jpeg", quality));
      return blob || file;
    } catch {
      return file;
    }
  }

  async function uploadImage(file, path) {
    const compressed = await compressImage(file);
    const { error } = await sb.storage
      .from(CFG.STORAGE_BUCKET)
      .upload(path, compressed, { contentType: "image/jpeg", upsert: true });
    if (error) throw error;
    return sb.storage.from(CFG.STORAGE_BUCKET).getPublicUrl(path).data.publicUrl;
  }

  /* ---------------- boot & auth ---------------- */
  async function boot() {
    $("#brandSeason").textContent = CFG.EVENT.season;

    if (!LIVE || !window.supabase) {
      alertBox(
        $("#authAlert"),
        "Supabase isn't configured. Paste SUPABASE_URL and SUPABASE_ANON_KEY into admin/js/config.js (see README)."
      );
      $("#btnLogin").disabled = true;
      return;
    }
    $("#authProject").textContent =
      "Connected to " + new URL(CFG.SUPABASE_URL).hostname;

    // Session lives in sessionStorage only — nothing persists after the
    // tab closes, and nothing is written to localStorage.
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
      auth: {
        storage: window.sessionStorage,
        persistSession: true,
        autoRefreshToken: true,
      },
    });
    const { data } = await sb.auth.getSession();
    if (data.session) enterDash(data.session.user);
  }

  function friendlyAuthError(error) {
    const m = error.message || String(error);
    const ref = new URL(CFG.SUPABASE_URL).hostname.split(".")[0];
    if (/invalid login credentials/i.test(m)) {
      return (
        "Invalid credentials. Confirm this exact user exists in project “" + ref +
        "” under Authentication → Users and the password matches. Running " +
        "supabase/create-admin.sql in the SQL Editor creates or resets the account."
      );
    }
    if (/email not confirmed/i.test(m)) {
      return (
        "Email not confirmed. In Supabase → Authentication → Users open the user " +
        "and confirm the email — or recreate it with “Auto Confirm User” ticked."
      );
    }
    if (/logins? (are )?disabled|signups? not allowed/i.test(m)) {
      return (
        "Email sign-in appears disabled. Enable the Email provider under " +
        "Supabase → Authentication → Sign In / Providers."
      );
    }
    if (/failed to fetch|network|load failed/i.test(m)) {
      return (
        "Can't reach Supabase from this browser. Check your connection and that " +
        "project “" + ref + "” isn't paused."
      );
    }
    return m;
  }

  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!sb) return;
    const btn = $("#btnLogin");
    busy(btn, true);
    const { data, error } = await sb.auth.signInWithPassword({
      email: $("#adminEmail").value.trim().toLowerCase(),
      password: $("#adminPass").value,
    });
    busy(btn, false);
    if (error) {
      alertBox($("#authAlert"), friendlyAuthError(error));
      // offer the one-time inline setup whenever sign-in is rejected
      $("#btnRepairToggle").hidden = false;
      return;
    }
    enterDash(data.user);
  });

  /* ---- inline first-time account setup (uses the secret key) ---- */
  $("#btnRepairToggle").addEventListener("click", () => {
    $("#repairPanel").hidden = false;
    $("#btnRepairToggle").hidden = true;
    $("#repairKey").focus();
  });

  async function adminApi(key, path, opts = {}) {
    return fetch(CFG.SUPABASE_URL + path, {
      ...opts,
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        ...(opts.headers || {}),
      },
    });
  }

  async function findAuthUser(key, email) {
    for (let page = 1; page <= 10; page++) {
      const r = await adminApi(key, `/auth/v1/admin/users?page=${page}&per_page=100`);
      if (!r.ok) {
        const body = await r.text();
        throw new Error(
          r.status === 401 || r.status === 403
            ? "That key was rejected. Use the service_role JWT or sb_secret_ key from Project Settings → API keys (not the anon key)."
            : `Auth admin API error ${r.status}: ${body.slice(0, 120)}`
        );
      }
      const data = await r.json();
      const users = data.users || data || [];
      const hit = users.find((u) => (u.email || "").toLowerCase() === email);
      if (hit) return hit;
      if (users.length < 100) return null;
    }
    return null;
  }

  $("#btnRepairRun").addEventListener("click", async () => {
    const btn = $("#btnRepairRun");
    const email = $("#adminEmail").value.trim().toLowerCase();
    const pass = $("#adminPass").value;
    const key = $("#repairKey").value.trim();

    if (!email || !/@/.test(email))
      return alertBox($("#repairAlert"), "Enter the admin email in the field above first.");
    if (pass.length < 6)
      return alertBox($("#repairAlert"), "Type the password you want (min 6 characters) in the field above first.");
    if (!(key.startsWith("sb_secret_") || key.startsWith("eyJ")))
      return alertBox($("#repairAlert"), "Paste your secret key (starts with sb_secret_ or eyJ).");

    busy(btn, true);
    try {
      const existing = await findAuthUser(key, email);
      if (existing) {
        const r = await adminApi(key, `/auth/v1/admin/users/${existing.id}`, {
          method: "PUT",
          body: JSON.stringify({ password: pass, email_confirm: true, ban_duration: "none" }),
        });
        if (!r.ok) throw new Error((await r.json()).msg || `reset failed (${r.status})`);
      } else {
        const r = await adminApi(key, "/auth/v1/admin/users", {
          method: "POST",
          body: JSON.stringify({ email, password: pass, email_confirm: true }),
        });
        if (!r.ok) throw new Error((await r.json()).msg || `create failed (${r.status})`);
      }

      // account is ready — sign in for real
      const { data, error } = await sb.auth.signInWithPassword({ email, password: pass });
      if (error) throw new Error("Account set up, but sign-in still failed: " + error.message);
      enterDash(data.user);
    } catch (err) {
      alertBox($("#repairAlert"), err.message || String(err));
    } finally {
      busy(btn, false);
    }
  });

  $("#btnLogout").addEventListener("click", async () => {
    await sb.auth.signOut();
    sessionStorage.clear();
    location.reload();
  });

  async function enterDash(user) {
    // Being signed in is not the same as being staff. Captains hold a valid
    // session for this same Supabase project, and RLS already returns them
    // nothing, but they should meet a clear message rather than an empty
    // console they are left to puzzle over.
    const { data: staff, error } = await sb.rpc("is_auction_staff");
    if (!error && staff !== true) {
      await sb.auth.signOut();
      sessionStorage.clear();
      $("#authWrap").hidden = false;
      $("#dash").hidden = true;
      alertBox(
        $("#authAlert"),
        `${user.email} is signed in but is not on the tournament staff list, so this console has nothing to show. ` +
          `Ask the organiser to add this account, or use the team auction app instead.`
      );
      return;
    }

    $("#authWrap").hidden = true;
    $("#dash").hidden = false;
    $("#whoami").textContent = user.email;

    // filter + modal option lists from config
    const fStatus = $("#fStatus");
    const mStatus = $("#mStatus");
    CFG.STATUSES.forEach((s) => {
      fStatus.insertAdjacentHTML("beforeend", `<option value="${s}">${s}</option>`);
      mStatus.insertAdjacentHTML("beforeend", `<option value="${s}">${s}</option>`);
    });
    const mSize = $("#mSize");
    CFG.JERSEY_SIZES.forEach((s) =>
      mSize.insertAdjacentHTML("beforeend", `<option>${esc(s)}</option>`)
    );

    load();
    loadSettings();
    startRealtime();
  }

  /* ---------------- tabs ---------------- */
  $$(".tab").forEach((t) =>
    t.addEventListener("click", () => {
      $$(".tab").forEach((x) => {
        x.classList.toggle("on", x === t);
        x.setAttribute("aria-selected", x === t ? "true" : "false");
      });
      $$(".tabpane").forEach((p) => (p.hidden = p.id !== `tab-${t.dataset.tab}`));
      if (t.dataset.tab === "grid") renderGrid();
      if (t.dataset.tab === "teams") loadTeams();
      if (t.dataset.tab === "tournament") loadTournament();
      if (t.dataset.tab === "sheets") loadSheets();
      if (t.dataset.tab === "scoreboard") loadScoreboard();
      // one countdown interval, and only while the sheets tab is up
      if (t.dataset.tab !== "sheets") stopSheetClock();
      if (t.dataset.tab === "pool") loadPool();
      if (t.dataset.tab === "auction") loadAuction();
    })
  );

  /* ---------------- data ---------------- */
  async function load() {
    const { data, error } = await sb
      .from("registrations")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) {
      $("#emptyMsg").hidden = false;
      $("#emptyMsg").textContent = "Couldn't load registrations: " + error.message;
      return;
    }
    rows = data || [];
    render();
    renderDbFacts();
    renderGrid();
  }
  $("#btnRefresh").addEventListener("click", () => {
    load();
    toast("Refreshed", "info");
  });

  /* realtime: new registrations appear instantly */
  function startRealtime() {
    try {
      sb.channel("regs-live")
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "registrations" },
          (payload) => {
            if (payload.eventType === "INSERT") {
              rows.unshift(payload.new);
              freshIds.add(payload.new.id);
              toast(`New registration: ${payload.new.full_name}`, "ok");
            } else if (payload.eventType === "UPDATE") {
              const i = rows.findIndex((r) => r.id === payload.new.id);
              if (i > -1) rows[i] = payload.new;
            } else if (payload.eventType === "DELETE") {
              rows = rows.filter((r) => r.id !== payload.old.id);
            }
            render();
            renderDbFacts();
            // don't rebuild the sheet under the user's cursor — defer if editing
            if (gridFocused) gridDirty = true;
            else renderGrid();
          }
        )
        .subscribe((status) => {
          const on = status === "SUBSCRIBED";
          $("#liveDot").classList.toggle("on", on);
          $("#liveLabel").textContent = on ? "live" : "offline";
        });
    } catch {
      $("#liveLabel").textContent = "offline";
    }
  }

  /* ---------------- filters & render ---------------- */
  function filtered() {
    const q = $("#q").value.trim().toLowerCase();
    const pay = $("#fPay").value;
    const st = $("#fStatus").value;
    return rows.filter((r) => {
      if (pay && r.payment_method !== pay) return false;
      if (st && r.status !== st) return false;
      if (q) {
        const hay = `${r.full_name} ${r.phone} ${r.reg_code} ${r.email || ""} ${r.jersey_name || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }
  ["q", "fPay", "fStatus"].forEach((id) =>
    $("#" + id).addEventListener("input", render)
  );

  function renderStats() {
    const total = rows.length;
    const online = rows.filter((r) => r.payment_method === "Online").length;
    const verified = rows.filter((r) => r.status === "verified" || r.status === "checked-in").length;
    const pending = rows.filter((r) => r.status === "pending").length;
    const cash = rows.filter((r) => r.payment_method === "Cash").length;
    $("#stats").innerHTML = `
      <div class="stat red"><div class="n">${total}</div><div class="l">Total entries</div></div>
      <div class="stat"><div class="n">${online}</div><div class="l">Paid online</div></div>
      <div class="stat ok"><div class="n">${verified}</div><div class="l">Verified</div></div>
      <div class="stat warn"><div class="n">${pending}</div><div class="l">Pending review</div></div>
      <div class="stat"><div class="n">${cash}</div><div class="l">Cash at venue</div></div>`;
  }

  function render() {
    renderStats();
    const list = filtered();
    $("#emptyMsg").hidden = list.length > 0;
    $("#emptyMsg").textContent = "No registrations match.";
    $("#regBody").innerHTML = list
      .map((r) => {
        const avatar = r.profile_pic_url
          ? `<img class="avatar-sm" src="${esc(r.profile_pic_url)}" alt="" data-zoom="${esc(r.profile_pic_url)}" loading="lazy" />`
          : `<span class="avatar-sm none">🥒</span>`;
        const shot = r.payment_screenshot_url
          ? `<br /><span class="shot-link" data-zoom="${esc(r.payment_screenshot_url)}">view screenshot</span>`
          : "";
        return `<tr data-id="${esc(r.id)}" class="${freshIds.has(r.id) ? "fresh" : ""}">
          <td><div class="p-cell">${avatar}
            <div><div class="nm">${esc(r.full_name)}</div>
            <div class="code">${esc(r.reg_code)}</div></div></div></td>
          <td>${esc(r.phone)}${r.email ? `<div class="sub">${esc(r.email)}</div>` : ""}</td>
          <td>${r.dupr != null ? Number(r.dupr).toFixed(3) : "<span class='sub'>—</span>"}</td>
          <td><b>${esc(r.jersey_size)}</b><div class="sub">“${esc(r.jersey_name)}”</div></td>
          <td><span class="pay-chip ${r.payment_method === "Online" ? "online" : ""}">${esc(r.payment_method)}</span>${shot}</td>
          <td><select class="status s-${esc(r.status)}" data-status="${esc(r.id)}" aria-label="Status">
            ${CFG.STATUSES.map((s) => `<option value="${s}" ${s === r.status ? "selected" : ""}>${s}</option>`).join("")}
          </select></td>
          <td><div class="row-actions">
            <button type="button" class="icon-btn" data-edit="${esc(r.id)}" title="Edit entry" aria-label="Edit">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
            </button>
            <button type="button" class="icon-btn del" data-del="${esc(r.id)}" title="Delete entry" aria-label="Delete">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
            </button>
          </div></td>
        </tr>`;
      })
      .join("");
    freshIds.clear();
  }

  function renderDbFacts() {
    const latest = rows[0];
    $("#dbFacts").innerHTML = `
      <li>Project <b>${esc(new URL(CFG.SUPABASE_URL).hostname)}</b></li>
      <li>Table <b>public.registrations</b></li>
      <li>Rows <b>${rows.length}</b></li>
      <li>Latest entry <b>${latest ? esc(latest.full_name) + " · " + new Date(latest.created_at).toLocaleString() : "—"}</b></li>`;
  }

  /* ---------------- FULL TABLE: live, Excel-style editable grid ---------------- */
  const GRID_COLS = [
    { key: "reg_code",             label: "Reg Code",   type: "code" },
    { key: "player_key",           label: "Player Key", type: "text" },
    { key: "created_at",           label: "Created",    type: "date" },
    { key: "full_name",            label: "Name",       type: "text" },
    { key: "phone",                label: "Phone",      type: "text" },
    { key: "email",                label: "Email",      type: "text" },
    { key: "gender",               label: "Gender",     type: "select", opts: ["Male", "Female", "Other"] },
    { key: "dupr",                 label: "DUPR",       type: "number" },
    { key: "jersey_size",          label: "Size",       type: "select", opts: CFG.JERSEY_SIZES },
    { key: "jersey_name",          label: "Jersey",     type: "text" },
    { key: "payment_method",       label: "Pay",        type: "select", opts: ["Online", "Cash"] },
    { key: "status",               label: "Status",     type: "status", opts: CFG.STATUSES },
    { key: "profile_pic_url",      label: "Photo",      type: "img" },
    { key: "payment_screenshot_url", label: "Screenshot", type: "img" },
  ];

  function gridFiltered() {
    const q = ($("#gq").value || "").trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      `${r.full_name} ${r.phone} ${r.reg_code} ${r.email || ""} ${r.jersey_name || ""}`
        .toLowerCase()
        .includes(q)
    );
  }

  function gridCell(r, col) {
    const v = r[col.key];
    const idf = `data-id="${esc(r.id)}" data-field="${col.key}"`;
    switch (col.type) {
      case "code":
        return `<span class="g-code">${esc(v)}</span>`;
      case "date":
        return `<span class="g-ro">${v ? new Date(v).toLocaleString() : "—"}</span>`;
      case "number":
        return `<input class="g-in g-num" type="number" step="0.001" min="0" max="8" value="${v ?? ""}" ${idf} />`;
      case "select":
        return `<select class="g-sel" ${idf}>${col.opts
          .map((o) => `<option ${o === v ? "selected" : ""}>${esc(o)}</option>`)
          .join("")}</select>`;
      case "status":
        return `<select class="g-sel g-status s-${esc(v)}" ${idf}>${col.opts
          .map((o) => `<option value="${o}" ${o === v ? "selected" : ""}>${o}</option>`)
          .join("")}</select>`;
      case "img":
        // Editable on purpose: a player card is only as good as its photo, and
        // plenty of entries arrive without one. Upload, replace or clear here.
        return `${
          v
            ? `<img class="g-thumb" src="${esc(v)}" alt="" data-zoom="${esc(v)}" loading="lazy" />`
            : `<span class="g-ro">—</span>`
        }<span class="g-imgbtns"><button type="button" class="btn-mini" data-regphoto="${esc(r.id)}" data-regfield="${
          col.key
        }" title="${v ? "Replace this photo" : "Upload a photo"}">⤒</button>${
          v
            ? `<button type="button" class="btn-mini danger" data-regphotodel="${esc(r.id)}" data-regfield="${esc(
                col.key
              )}" title="Remove this photo">✕</button>`
            : ""
        }</span>`;
      default:
        return `<input class="g-in" value="${esc(v ?? "")}" ${idf} autocomplete="off" spellcheck="false" />`;
    }
  }

  function renderGrid() {
    const head = $("#gridHead");
    if (!head) return;
    head.innerHTML =
      GRID_COLS.map((c) => `<th>${c.label}</th>`).join("") + `<th class="th-actions">·</th>`;
    const list = gridFiltered();
    $("#gridEmpty").hidden = list.length > 0;
    $("#gridEmpty").textContent = rows.length ? "No rows match your filter." : "No registrations yet.";
    $("#gridBody").innerHTML = list
      .map(
        (r) =>
          `<tr data-id="${esc(r.id)}">${GRID_COLS.map(
            (c) => `<td class="g-td g-${c.type}">${gridCell(r, c)}</td>`
          ).join("")}<td class="g-td g-actions">
            <button type="button" class="icon-btn del" data-del="${esc(r.id)}" title="Delete entry" aria-label="Delete">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
            </button></td></tr>`
      )
      .join("");
  }

  async function commitCell(el) {
    const id = el.dataset.id;
    const field = el.dataset.field;
    const row = rows.find((r) => r.id === id);
    if (!row) return;

    let value = el.value;
    if (field === "dupr") value = value === "" ? null : Number(value);
    else if (field === "email") value = value.trim() || null;
    // Store a cleared key as NULL, never "", so the uniqueness index does not
    // treat every blank row as a collision.
    else if (field === "player_key") value = value.trim().toUpperCase() || null;
    else if (field === "jersey_name") value = value.trim().toUpperCase();
    else if (typeof value === "string") value = value.trim();

    if ((row[field] ?? null) === (value ?? null)) return; // no change → skip write

    el.classList.add("g-saving");
    const { error } = await sb.from("registrations").update({ [field]: value }).eq("id", id);
    el.classList.remove("g-saving");
    if (error) {
      toast("Couldn't save: " + error.message, "err");
      el.value = row[field] ?? "";               // revert the cell to the stored value
      el.classList.add("g-err");
      setTimeout(() => el.classList.remove("g-err"), 1200);
      return;
    }
    row[field] = value;
    if (field === "jersey_name") el.value = value;                 // reflect UPPERCASE
    if (field === "player_key") el.value = value ?? "";            // reflect UPPERCASE / cleared
    if (el.classList.contains("g-status")) el.className = "g-sel g-status s-" + value;
    el.classList.add("g-ok");
    setTimeout(() => el.classList.remove("g-ok"), 900);
    renderStats();
    renderDbFacts();
  }

  const gridBody = $("#gridBody");
  if (gridBody) {
    gridBody.addEventListener("change", (e) => {
      const el = e.target.closest("[data-id][data-field]");
      if (el) commitCell(el);
    });
    gridBody.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.matches(".g-in")) {
        e.preventDefault();
        e.target.blur();               // commit on Enter, Excel-style
      }
    });
    gridBody.addEventListener("focusin", () => (gridFocused = true));
    gridBody.addEventListener("focusout", () => {
      gridFocused = false;
      // let focus settle: if the user simply tabbed to the next cell, stay put.
      // Only rebuild once focus has truly left the sheet and realtime changes
      // arrived while editing.
      setTimeout(() => {
        if (!gridFocused && gridDirty) {
          gridDirty = false;
          renderGrid();
        }
      }, 0);
    });
  }
  $("#gq").addEventListener("input", renderGrid);
  $("#btnGridAdd").addEventListener("click", () => openModal(null));
  $("#btnGridCsv").addEventListener("click", () =>
    exportCsv(gridFiltered(), `mpl-registrations-${stamp()}.csv`)
  );

  /* ---------------- inline status change ---------------- */
  document.addEventListener("change", async (e) => {
    const sel = e.target.closest("select.status");
    if (!sel) return;
    const id = sel.dataset.status;
    const value = sel.value;
    sel.className = `status s-${value}`;
    const { error } = await sb.from("registrations").update({ status: value }).eq("id", id);
    if (error) return toast("Status update failed: " + error.message, "err");
    const row = rows.find((r) => r.id === id);
    if (row) row.status = value;
    renderStats();
    toast(`Marked ${value}`, "ok");
  });

  /* ---------------- add / edit modal ---------------- */
  function openModal(row) {
    editingId = row ? row.id : null;
    $("#modalTitle").textContent = row ? `Edit · ${row.reg_code}` : "Add Entry";
    $("#mName").value = row?.full_name || "";
    $("#mPhone").value = row?.phone || "";
    $("#mEmail").value = row?.email || "";
    $("#mGender").value = row?.gender || "Male";
    $("#mDupr").value = row?.dupr ?? "";
    $("#mSize").value = row?.jersey_size || "M";
    $("#mJName").value = row?.jersey_name || "";
    $("#mPay").value = row?.payment_method || "Cash";
    $("#mStatus").value = row?.status || "pending";
    $("#mProfileFile").value = "";
    $("#mShotFile").value = "";
    setThumb("#mProfileThumb", row?.profile_pic_url);
    setThumb("#mShotThumb", row?.payment_screenshot_url);
    $("#modalAlert").classList.remove("show");
    $("#modalVeil").hidden = false;
    setTimeout(() => $("#mName").focus(), 60);
  }
  function setThumb(sel, url) {
    const img = $(sel);
    if (url) {
      img.src = url;
      img.hidden = false;
    } else {
      img.removeAttribute("src");
      img.hidden = true;
    }
  }
  function closeModal() {
    $("#modalVeil").hidden = true;
    editingId = null;
  }

  $("#btnAdd").addEventListener("click", () => openModal(null));
  $("#btnModalClose").addEventListener("click", closeModal);
  $("#btnModalCancel").addEventListener("click", closeModal);
  $("#modalVeil").addEventListener("mousedown", (e) => {
    if (e.target === e.currentTarget) closeModal();
  });

  ["#mProfileFile", "#mShotFile"].forEach((sel, i) =>
    $(sel).addEventListener("change", (e) => {
      const f = e.target.files[0];
      if (f) setThumb(i === 0 ? "#mProfileThumb" : "#mShotThumb", URL.createObjectURL(f));
    })
  );

  $("#entryForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#btnModalSave");

    const record = {
      full_name: $("#mName").value.trim(),
      phone: $("#mPhone").value.trim(),
      email: $("#mEmail").value.trim() || null,
      gender: $("#mGender").value,
      dupr: $("#mDupr").value ? Number($("#mDupr").value) : null,
      jersey_size: $("#mSize").value,
      jersey_name: $("#mJName").value.trim().toUpperCase(),
      payment_method: $("#mPay").value,
      status: $("#mStatus").value,
    };
    if (!record.full_name || !record.phone || !record.jersey_name) {
      return alertBox($("#modalAlert"), "Name, phone and jersey name are required.");
    }

    busy(btn, true);
    try {
      const code = editingId
        ? rows.find((r) => r.id === editingId)?.reg_code
        : regCode();
      const stamp = Date.now();

      const pf = $("#mProfileFile").files[0];
      if (pf) record.profile_pic_url = await uploadImage(pf, `profile/${code}-${stamp}.jpg`);
      const sf = $("#mShotFile").files[0];
      if (sf) record.payment_screenshot_url = await uploadImage(sf, `payment/${code}-${stamp}.jpg`);

      if (editingId) {
        const { error } = await sb.from("registrations").update(record).eq("id", editingId);
        if (error) throw error;
        toast("Entry updated", "ok");
      } else {
        record.reg_code = code;
        const { error } = await sb.from("registrations").insert(record);
        if (error) throw error;
        toast("Entry added", "ok");
      }
      closeModal();
      load();
    } catch (err) {
      alertBox($("#modalAlert"), err.message || String(err));
    } finally {
      busy(btn, false);
    }
  });

  /* ---------------- delete (single + bulk) ---------------- */
  // `label` is the wording on the confirm button. It used to be hard-coded to
  // "Delete", which read as destructive on confirmations that destroy nothing
  // — linking a player, reversing a sale, generating passwords.
  function confirmDialog(msg, action, label = "Delete", danger = true) {
    $("#confirmMsg").textContent = msg;
    const yes = $("#btnConfirmYes");
    yes.textContent = label;
    yes.classList.toggle("danger", danger);
    confirmAction = action;
    $("#confirmVeil").hidden = false;
  }
  $("#btnConfirmNo").addEventListener("click", () => {
    $("#confirmVeil").hidden = true;
    confirmAction = null;
  });
  $("#btnConfirmYes").addEventListener("click", async () => {
    $("#confirmVeil").hidden = true;
    if (confirmAction) await confirmAction();
    confirmAction = null;
  });

  document.addEventListener("click", (e) => {
    const edit = e.target.closest("[data-edit]");
    if (edit) {
      const row = rows.find((r) => r.id === edit.dataset.edit);
      if (row) openModal(row);
      return;
    }
    const del = e.target.closest("[data-del]");
    if (del) {
      const row = rows.find((r) => r.id === del.dataset.del);
      if (!row) return;
      confirmDialog(
        `Delete ${row.full_name}'s entry (${row.reg_code})? This cannot be undone.`,
        async () => {
          const { error } = await sb.from("registrations").delete().eq("id", row.id);
          if (error) return toast("Delete failed: " + error.message, "err");
          rows = rows.filter((r) => r.id !== row.id);
          render();
          renderDbFacts();
          toast("Entry deleted", "ok");
        }
      );
      return;
    }
    const z = e.target.closest("[data-zoom]");
    if (z) {
      $("#lightboxImg").src = z.dataset.zoom;
      $("#lightbox").hidden = false;
      return;
    }
    if (e.target.closest("#lightbox")) $("#lightbox").hidden = true;
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      $("#lightbox").hidden = true;
      $("#confirmVeil").hidden = true;
      if (!$("#modalVeil").hidden) closeModal();
    }
  });

  $("#btnPurgeRejected").addEventListener("click", () => {
    const n = rows.filter((r) => r.status === "rejected").length;
    if (!n) return toast("No rejected entries to delete", "info");
    confirmDialog(
      `Delete all ${n} rejected entr${n === 1 ? "y" : "ies"}? This cannot be undone.`,
      async () => {
        const { error } = await sb.from("registrations").delete().eq("status", "rejected");
        if (error) return toast("Bulk delete failed: " + error.message, "err");
        toast(`Deleted ${n} rejected entr${n === 1 ? "y" : "ies"}`, "ok");
        load();
      }
    );
  });

  /* ---------------- event controls (settings table) ---------------- */
  async function loadSettings() {
    const { data, error } = await sb
      .from("event_settings")
      .select("*")
      .eq("id", 1)
      .maybeSingle();
    if (error || !data) return;
    $("#setOpen").checked = data.registration_open;
    $("#setBanner").value = data.banner_message || "";
    syncOpenLabel();
  }
  function syncOpenLabel() {
    $("#setOpenLabel").textContent = $("#setOpen").checked
      ? "Registrations are open"
      : "Registrations are closed";
  }
  $("#setOpen").addEventListener("change", syncOpenLabel);

  $("#btnSaveSettings").addEventListener("click", async () => {
    const btn = $("#btnSaveSettings");
    busy(btn, true);
    const { error } = await sb.from("event_settings").upsert({
      id: 1,
      registration_open: $("#setOpen").checked,
      banner_message: $("#setBanner").value.trim() || null,
      updated_at: new Date().toISOString(),
    });
    busy(btn, false);
    if (error) return toast("Couldn't save controls: " + error.message, "err");
    toast("Event controls saved — live on the form now", "ok");
  });

  /* ---------------- CSV export ---------------- */
  function exportCsv(list, name) {
    const cols = [
      "reg_code", "created_at", "full_name", "phone", "email", "gender", "dupr",
      "jersey_size", "jersey_name",
      "payment_method", "status", "profile_pic_url", "payment_screenshot_url",
    ];
    const cell = (v) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cols.join(","), ...list.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  const stamp = () => new Date().toISOString().slice(0, 10);
  $("#btnCsv").addEventListener("click", () =>
    exportCsv(filtered(), `mpl-registrations-${stamp()}.csv`)
  );
  $("#btnCsvAll").addEventListener("click", () =>
    exportCsv(rows, `mpl-full-backup-${stamp()}.csv`)
  );

  /* ============================================================
     TEAMS — the sixteen squads, straight from team_squads.
     Read-only board: the auction writes the squads, this shows them.
     ============================================================ */
  let squadTeams = [];   // auction_teams rows, with group_code / group_rank
  let squadRows = [];    // team_squads rows
  let squadLive = false; // realtime channel opened once

  async function loadTeams() {
    const [t, s] = await Promise.all([
      sb.from("auction_teams").select("id,name,captain_name,group_code,group_rank").order("id"),
      sb.from("team_squads").select("*").order("team_id").order("sort_order"),
    ]);

    if (t.error || s.error) {
      const msg = (t.error || s.error).message || "";
      $("#squadBoard").innerHTML = "";
      $("#teamsEmpty").hidden = false;
      $("#teamsEmpty").innerHTML = /does not exist|schema cache/i.test(msg)
        ? 'The squad table is missing — run <code>supabase/team-squads.sql</code> in the Supabase SQL editor.'
        : "Couldn't load the squads: " + esc(msg);
      return;
    }

    squadTeams = t.data || [];
    squadRows = s.data || [];
    await loadSquadBalance();
    renderTeamsBoard();
    startSquadRealtime();
  }

  /* squads change rarely, but when they do the console should not need a reload */
  function startSquadRealtime() {
    if (squadLive) return;
    squadLive = true;
    try {
      sb.channel("squads-live")
        .on("postgres_changes", { event: "*", schema: "public", table: "team_squads" }, () => {
          sb.from("team_squads")
            .select("*")
            .order("team_id")
            .order("sort_order")
            .then(({ data, error }) => {
              if (error) return;
              squadRows = data || [];
              renderTeamsBoard();
            });
        })
        .subscribe();
    } catch {
      squadLive = false;
    }
  }

  const GROUPS = ["A", "B", "C", "D"];

  function teamsFiltered() {
    const q = ($("#teamsQ")?.value || "").trim().toLowerCase();
    if (!q) return { teams: squadTeams, match: () => false };
    const hit = (s) => String(s ?? "").toLowerCase().includes(q);
    const teams = squadTeams.filter(
      (t) =>
        hit(t.name) ||
        hit(t.captain_name) ||
        squadRows.some((r) => r.team_id === t.id && hit(r.player_name))
    );
    return { teams, match: (name) => hit(name) };
  }

  function renderTeamsBoard() {
    const board = $("#squadBoard");
    renderBalanceNote();
    const { teams, match } = teamsFiltered();

    $("#teamsEmpty").hidden = squadRows.length > 0;

    const players = squadRows.length;
    const retained = squadRows.filter((r) => r.retained).length;
    const short = squadTeams.filter(
      (t) => squadRows.filter((r) => r.team_id === t.id).length !== 9
    ).length;
    $("#teamsStats").innerHTML = [
      `<div class="stat"><p class="n">${squadTeams.length}</p><p class="l">Teams</p></div>`,
      `<div class="stat"><p class="n">${players}</p><p class="l">Players</p></div>`,
      `<div class="stat"><p class="n">${retained}</p><p class="l">Retained</p></div>`,
      short
        ? `<div class="stat warn"><p class="n">${short}</p><p class="l">Squads not at 9</p></div>`
        : `<div class="stat ok"><p class="n">9</p><p class="l">Per squad</p></div>`,
    ].join("");

    // Teams without a group still need a home, so anything unassigned is
    // gathered under a trailing column rather than silently dropped.
    const ungrouped = teams.filter((t) => !GROUPS.includes(t.group_code));
    const cols = GROUPS.map((g) => ({
      code: g,
      label: `Group ${g}`,
      list: teams
        .filter((t) => t.group_code === g)
        .sort((a, b) => (a.group_rank || 99) - (b.group_rank || 99)),
    }));
    if (ungrouped.length) cols.push({ code: "?", label: "Ungrouped", list: ungrouped });

    board.innerHTML = cols
      .map(
        (c) => `
      <div class="sq-col">
        <p class="sq-group">${esc(c.label)}</p>
        ${c.list.map((t) => teamCard(t, match)).join("") ||
          '<p class="sq-none">No teams in this group.</p>'}
      </div>`
      )
      .join("");
  }

  /* ============================================================
     EDITING A SQUAD
     team_squads is the one list every screen reads — the console, the
     captain's phone, the open board and every filed line-up. A name
     corrected here is corrected everywhere, which is exactly why the
     edit lives here and nowhere else.
     ============================================================ */
  let squadEditing = false;
  let squadBalance = [];

  const CATS = ["A", "B", "C"];

  function squadEditRow(p) {
    return `
      <li class="sq-player edit" data-sq="${esc(p.id)}">
        <select class="sq-in cat c-${esc(p.category)}" data-f="category" aria-label="Category">
          ${CATS.map((c) => `<option${c === p.category ? " selected" : ""}>${c}</option>`).join("")}
        </select>
        <input class="sq-in name" data-f="player_name" value="${esc(p.player_name)}" aria-label="Player name" />
        <input class="sq-in phone" data-f="phone" value="${esc(p.phone || "")}" placeholder="phone" aria-label="Phone" />
        <button class="sq-r${p.retained ? " on" : ""}" data-f="retained" type="button"
                title="Retained player">R</button>
      </li>`;
  }

  /* Saves on blur or Enter, one field at a time — the same feel as the
     spreadsheet tab, and nothing is lost if the page is closed mid-edit. */
  async function saveSquadField(el) {
    const li = el.closest("[data-sq]");
    if (!li) return;
    const id = li.dataset.sq;
    const field = el.dataset.f;
    const row = squadRows.find((r) => r.id === id);
    if (!row) return;

    let value = field === "retained" ? !row.retained : el.value;
    if (field === "player_name") {
      value = String(value).trim();
      if (!value) { el.value = row.player_name; return toast("A player needs a name", "err"); }
    }
    if (field === "phone") value = String(value).trim() || null;
    if (value === row[field]) return;

    const { error } = await sb.from("team_squads").update({ [field]: value }).eq("id", id);
    if (error) {
      el.value = row[field] ?? "";
      return toast("Couldn't save: " + error.message, "err");
    }
    row[field] = value;

    // A player already named on a filed sheet now reads differently there.
    if (field === "player_name" || field === "category") {
      const { data } = await sb.rpc("squad_player_usage", { p_squad_id: id });
      if (data && data.length) {
        toast(`Saved — ${row.player_name} is on ${data.length} filed team sheet${data.length > 1 ? "s" : ""}, now updated`, "info");
      } else {
        toast("Saved", "ok");
      }
    } else {
      toast("Saved", "ok");
    }
    loadSquadBalance().then(renderTeamsBoard);
  }

  document.addEventListener("change", (e) => {
    const el = e.target.closest("#tab-teams .sq-in");
    if (el && el.tagName === "SELECT") saveSquadField(el);
  });
  document.addEventListener("blur", (e) => {
    const el = e.target.closest && e.target.closest("#tab-teams input.sq-in");
    if (el) saveSquadField(el);
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const el = e.target.closest && e.target.closest("#tab-teams input.sq-in");
    if (el) { e.preventDefault(); el.blur(); }
  });
  document.addEventListener("click", (e) => {
    const r = e.target.closest("#tab-teams .sq-r");
    if (r) saveSquadField(r);
  });

  $("#btnTeamsEdit")?.addEventListener("click", () => {
    squadEditing = !squadEditing;
    const b = $("#btnTeamsEdit");
    b.setAttribute("aria-pressed", String(squadEditing));
    b.classList.toggle("on", squadEditing);
    b.textContent = squadEditing ? "✓ Done editing" : "✎ Edit squads";
    $("#teamsHint").textContent = squadEditing
      ? "Editing — changes save as you go and reach every screen at once"
      : "Live from the squad table — captains see the same list";
    renderTeamsBoard();
  });

  async function loadSquadBalance() {
    const { data, error } = await sb.from("squad_balance").select("*");
    if (!error) squadBalance = data || [];
  }

  function renderBalanceNote() {
    const el = $("#teamsBalance");
    if (!el) return;
    const off = squadBalance.filter((b) => !b.ok);
    el.textContent = !squadBalance.length
      ? ""
      : off.length
      ? `${off.length} squad${off.length > 1 ? "s" : ""} not 1A / 4B / 4C`
      : "Every squad is 1A / 4B / 4C";
    el.classList.toggle("bad", off.length > 0);
    el.classList.toggle("good", squadBalance.length > 0 && !off.length);
  }

  function teamCard(t, match) {
    const squad = squadRows
      .filter((r) => r.team_id === t.id)
      .sort((a, b) => a.sort_order - b.sort_order);

    const rows = squad
      .map((p) => (squadEditing ? squadEditRow(p) : `
        <li class="sq-player${match(p.player_name) ? " hit" : ""}">
          <span class="sq-cat c-${esc(p.category)}">${esc(p.category)}</span>
          <span class="sq-name">${esc(p.player_name)}</span>
          ${p.retained ? '<span class="sq-ret" title="Retained player">R</span>' : ""}
        </li>`))
      .join("");

    return `
      <article class="sq-card">
        <header class="sq-head">
          <span class="sq-rank">${String(t.group_rank ?? "").padStart(2, "0")}</span>
          <div class="sq-id">
            <h3 class="sq-team">${esc(t.name)}</h3>
            <p class="sq-cap">${esc(t.captain_name || "—")}</p>
          </div>
          <span class="sq-count${squad.length === 9 ? "" : " off"}">${squad.length}/9</span>
        </header>
        <ol class="sq-list">${rows || '<li class="sq-empty">No players yet.</li>'}</ol>
      </article>`;
  }

  $("#teamsQ")?.addEventListener("input", renderTeamsBoard);

  $("#btnTeamsCsv")?.addEventListener("click", () => {
    const byId = new Map(squadTeams.map((t) => [t.id, t]));
    const cell = (v) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = ["group,group_rank,team,captain,slot,player,category,retained"];
    squadRows
      .slice()
      .sort((a, b) => {
        const ta = byId.get(a.team_id) || {};
        const tb = byId.get(b.team_id) || {};
        return (
          String(ta.group_code).localeCompare(String(tb.group_code)) ||
          (ta.group_rank || 99) - (tb.group_rank || 99) ||
          a.sort_order - b.sort_order
        );
      })
      .forEach((r) => {
        const t = byId.get(r.team_id) || {};
        lines.push(
          [t.group_code, t.group_rank, t.name, t.captain_name, r.sort_order, r.player_name, r.category, r.retained ? "R" : ""]
            .map(cell)
            .join(",")
        );
      });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    a.download = `mpl-squads-${stamp()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  /* ============================================================
     TOURNAMENT — match day: the run of show, the ladder, the rules
     ============================================================ */
  const FMT = window.MPL_FORMAT;
  let ties = [];
  let tourLive = false;

  async function loadTournament() {
    const [tt, ti] = await Promise.all([
      squadTeams.length
        ? Promise.resolve({ data: squadTeams })
        : sb.from("auction_teams").select("id,name,captain_name,group_code,group_rank").order("id"),
      sb.from("tournament_ties").select("*").order("sort_order"),
    ]);
    if (tt.data) squadTeams = tt.data;

    if (ti.error) {
      const msg = ti.error.message || "";
      $("#tourEmpty").hidden = false;
      $("#tourEmpty").innerHTML = /does not exist|schema cache/i.test(msg)
        ? 'The fixture table is missing — run <code>supabase/tournament.sql</code> in the Supabase SQL editor.'
        : "Couldn't load the schedule: " + esc(msg);
      return;
    }

    ties = ti.data || [];
    renderTournament();
    startTourRealtime();
  }

  function startTourRealtime() {
    if (tourLive) return;
    tourLive = true;
    try {
      sb.channel("ties-live")
        .on("postgres_changes", { event: "*", schema: "public", table: "tournament_ties" }, () => {
          sb.from("tournament_ties")
            .select("*")
            .order("sort_order")
            .then(({ data, error }) => {
              if (error) return;
              ties = data || [];
              renderTournament();
            });
        })
        .subscribe();
    } catch {
      tourLive = false;
    }
  }

  const tourNameOf = (id) => (id ? squadTeams.find((t) => t.id === id)?.name || null : null);

  function renderTournament() {
    $("#tourEmpty").hidden = ties.length > 0;
    $("#tourWhen").textContent = `${FMT.DATA.when} · ${FMT.DATA.where} · ${FMT.DATA.firstServe}`;

    const group = ties.filter((t) => t.phase === "group");
    $("#tourStats").innerHTML = [
      `<div class="stat"><p class="n">${squadTeams.length}</p><p class="l">Teams</p></div>`,
      `<div class="stat"><p class="n">${squadTeams.length * 9}</p><p class="l">Players</p></div>`,
      `<div class="stat"><p class="n">${ties.length}</p><p class="l">Ties</p></div>`,
      `<div class="stat"><p class="n">${ties.length * 5}</p><p class="l">Games</p></div>`,
    ].join("");

    $("#tourFormat").innerHTML = FMT.tieStrip();
    $("#tourRules").innerHTML = FMT.rules();
    $("#tourLadder").innerHTML = FMT.ladder(ties, tourNameOf);

    renderRunOfShow(group);
  }

  function renderRunOfShow(group) {
    const q = ($("#tourQ")?.value || "").trim().toLowerCase();
    const gf = $("#tourGroup")?.value || "";
    const courts = [...new Set(group.map((t) => t.court))].sort((a, b) => a - b);
    const slots = [...new Set(group.map((t) => t.slot_no))].sort((a, b) => a - b);

    $("#runHead").innerHTML =
      `<th class="run-time">Time</th>` + courts.map((c) => `<th>Court ${c}</th>`).join("");

    const nameFor = (t, side) =>
      tourNameOf(side === "home" ? t.home_team_id : t.away_team_id) ||
      (side === "home" ? t.home_label : t.away_label);

    $("#runBody").innerHTML = slots
      .map((s) => {
        const row = group.filter((t) => t.slot_no === s);
        const first = row[0];
        const cells = courts
          .map((c) => {
            const t = row.find((x) => x.court === c);
            if (!t) return `<td class="run-none">—</td>`;

            const home = nameFor(t, "home");
            const away = nameFor(t, "away");
            const dim =
              (gf && t.group_code !== gf) ||
              (q && !`${home} ${away}`.toLowerCase().includes(q));

            return `
              <td class="run-cell${dim ? " dim" : ""}">
                <p class="run-tag"><b>Group ${esc(t.group_code)}</b> Round ${t.round}</p>
                <p class="run-team">${esc(home)}</p>
                <p class="run-vs">vs</p>
                <p class="run-team">${esc(away)}</p>
              </td>`;
          })
          .join("");
        return `<tr><th class="run-time"><b>${esc(FMT.timeOf(first?.starts_at))}</b><span>to ${esc(
          FMT.timeOf(first?.ends_at)
        )}</span></th>${cells}</tr>`;
      })
      .join("");
  }

  $("#tourQ")?.addEventListener("input", () => renderRunOfShow(ties.filter((t) => t.phase === "group")));
  $("#tourGroup")?.addEventListener("change", () => renderRunOfShow(ties.filter((t) => t.phase === "group")));

  $("#btnTourCsv")?.addEventListener("click", () => {
    const cell = (v) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = ["tie,phase,group,round,time,court,home,away"];
    ties.forEach((t) =>
      lines.push(
        [
          t.id,
          t.phase,
          t.group_code || "",
          t.round || "",
          t.starts_at ? FMT.windowOf(t.starts_at, t.ends_at) : "TBC",
          t.court || "",
          tourNameOf(t.home_team_id) || t.home_label,
          tourNameOf(t.away_team_id) || t.away_label,
        ]
          .map(cell)
          .join(",")
      )
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    a.download = `mpl-schedule-${stamp()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  /* ============================================================
     RESET
     A rehearsal, a demo, a tie typed against the wrong fixture — the day
     needs a way back to nothing. Both of these are staff-only in the
     database as well as here, and both say exactly what they will destroy
     before they do it.
     ============================================================ */
  $("#btnResetScores")?.addEventListener("click", async () => {
    const played = sbResults.length;
    const hist = sbAudit.length;
    confirmDialog(
      played
        ? `Clear all ${played} match score${played > 1 ? "s" : ""}? Every tie goes back to unplayed, the league table empties and the knockout bracket un-seats. ` +
          `The score history (${hist} entr${hist === 1 ? "y" : "ies"}) is kept so you can still see what was entered.`
        : "There are no scores to clear. Run it anyway to reset every tie to unplayed?",
      async () => {
        const { data, error } = await sb.rpc("reset_scoreboard", { p_clear_history: false, p_tie_id: null });
        if (error) return toast("Reset failed: " + error.message, "err");
        const r = Array.isArray(data) ? data[0] : data;
        toast(`Scoreboard reset — ${r?.results_removed ?? 0} scores cleared`, "ok");
        await sbReload();
      },
      "Reset the scoreboard"
    );
  });

  $("#btnResetSheets")?.addEventListener("click", async () => {
    const filed = shBoard.filter((r) => r.status === "submitted").length;
    confirmDialog(
      `Clear every team sheet in the tournament${filed ? `, including ${filed} already filed` : ""}? ` +
        `Captains will see no sheet until you open a new window, and the trump on any recorded score is cleared with them.`,
      async () => {
        const { error } = await sb.rpc("reset_team_sheets", { p_tie_id: null });
        if (error) return toast("Reset failed: " + error.message, "err");
        toast("Every team sheet cleared", "ok");
        await loadSheets();
        await sbReload();
      },
      "Reset the team sheets"
    );
  });

  /* ---- one-time auction install helper (shown when tables are missing) ---- */
  (() => {
    const btn = $("#btnCopyInstall");
    if (!btn) return;
    const ref = new URL(CFG.SUPABASE_URL).hostname.split(".")[0];
    const link = $("#lnkSqlEditor");
    if (link) link.href = `https://supabase.com/dashboard/project/${ref}/sql/new`;

    let cached = null;
    const load = async () => {
      if (cached) return cached;
      const r = await fetch("auction-install.sql", { cache: "no-store" });
      if (!r.ok) throw new Error("Could not load auction-install.sql (" + r.status + ")");
      cached = await r.text();
      return cached;
    };

    btn.addEventListener("click", async () => {
      busy(btn, true);
      try {
        const sql = await load();
        try {
          await navigator.clipboard.writeText(sql);
          toast("Setup SQL copied — paste it into the Supabase SQL Editor", "ok");
        } catch {
          // clipboard blocked (common on mobile without a user gesture chain):
          // show it so it can be selected manually
          const ta = $("#installSql");
          ta.value = sql;
          ta.hidden = false;
          ta.focus();
          ta.select();
          toast("Clipboard blocked — the SQL is shown below, select and copy it", "info");
        }
      } catch (e) {
        toast(e.message || String(e), "err");
      } finally {
        busy(btn, false);
      }
    });
  })();

  /* ============================================================
     AUCTION — master control for the team auction
     ============================================================ */
  const AUC = CFG.AUCTION || {};
  const aucMoney = (n) =>
    (AUC.CURRENCY || "₹") +
    Number(n || 0).toLocaleString(AUC.LOCALE || "en-IN", { maximumFractionDigits: 0 });

  let aTeams = [];
  let aLots = [];
  let aState = null;
  let aCats = [];
  let aucReady = false;
  let aucRealtime = false;

  async function loadAuction() {
    const [t, l, s, c, cd] = await Promise.all([
      sb.from("auction_teams").select("*").order("id"),
      sb.from("auction_pool").select("*").order("sl_no", { nullsFirst: false }),
      sb.from("auction_state").select("*").eq("id", 1).maybeSingle(),
      sb.from("auction_categories").select("*").order("sort_order"),
      // resolved against registrations, so the stage card and the sold list
      // show photos without waiting for the Auction Pool tab to be opened
      sb.rpc("auction_cards"),
    ]);
    if (c.data) aCats = c.data;
    if (!cd.error && cd.data) {
      pCards = {};
      cd.data.forEach((x) => (pCards[x.id] = x));
    }

    const err = t.error || l.error;
    if (err) {
      // Only a genuinely absent table means "not installed yet". A network
      // blip or an RLS denial hid the whole auctioneer screen behind a
      // "run the installer" message that made things worse when clicked.
      const missing =
        err.code === "42P01" || /does not exist|schema cache/i.test(err.message || "");
      $("#aucMissing").hidden = !missing;
      $("#aucBody").hidden = missing;
      aucReady = false;
      if (!missing) {
        toast(
          /permission|policy|denied/i.test(err.message || "")
            ? "This account isn't on the staff list — ask the organiser to add you."
            : "Couldn't load the auction: " + (err.message || err),
          "err"
        );
      }
      return;
    }
    $("#aucMissing").hidden = true;
    $("#aucBody").hidden = false;

    aTeams = t.data || [];
    aLots = l.data || [];
    aState = s.data || null;

    if (!aucReady) {
      aucReady = true;
      startAuctionRealtime();
    }
    renderAuction();
    loadLogins();
  }

  function startAuctionRealtime() {
    if (aucRealtime) return;
    aucRealtime = true;
    try {
      sb.channel("auction-admin")
        .on("postgres_changes", { event: "*", schema: "public", table: "auction_state" }, (p) => {
          aState = p.new;
          renderAucStage();
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "auction_teams" }, (p) => {
          const i = aTeams.findIndex((x) => x.id === p.new.id);
          if (i > -1) aTeams[i] = p.new;
          renderAucList();
          renderAucTeams();
          renderAucStage();
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "auction_pool" }, (p) => {
          if (p.eventType === "DELETE") aLots = aLots.filter((x) => x.id !== p.old.id);
          else {
            const i = aLots.findIndex((x) => x.id === p.new.id);
            if (i > -1) aLots[i] = p.new;
            else aLots.push(p.new);
          }
          renderAucTeams();
          renderAucStage();
        })
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "auction_bids" }, (p) => {
          const team = aTeams.find((x) => x.id === p.new.team_id);
          toast(`${team ? team.name : "Team " + p.new.team_id} bid ${aucMoney(p.new.amount)}`, "info");
        })
        .subscribe();
    } catch {
      /* realtime is a nicety — polling via Refresh still works */
    }
  }

  const aucSquad = (teamId) =>
    aLots.filter((l) => l.sold_to_team_id === teamId && l.status === "sold");

  function renderAuction() {
    renderAucStage();
    renderAucList();
    renderAucTeams();
    // Team name only. The purse was the same 10,00,000 on every line until a
    // team actually spends, so it read as noise beside sixteen identical rows.
    const sel = $("#aucSellTeam");
    const keep = sel.value;
    sel.innerHTML =
      `<option value="">— choose a team —</option>` +
      aTeams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("");
    if (keep) sel.value = keep;
  }

  function renderAucStage() {
    const live = aState && aState.status === "live" && aState.current_lot_id;
    const lot = live ? aLots.find((l) => l.id === aState.current_lot_id) : null;

    renderPlayerCard(lot);

    const empty = $("#aucEmptyStage");
    if (empty) empty.hidden = !!lot;

    // The final price defaults to the player's base, which is what the room
    // opens at; the auctioneer types over it with whatever it actually sold for.
    const price = $("#aucSellPrice");
    if (price) price.placeholder = lot ? aucMoney(lot.base_price) : "base price";

    ["btnAucSell", "btnAucUnsold"].forEach((id) => {
      const b = $("#" + id);
      if (b) b.disabled = !lot;
    });
  }

  /* ---- call a player up by Player Key ----
     The only way onto the screen. No list, no per-row buttons: the auctioneer
     reads the key off the sheet, types it, and the card appears. */
  async function callByKey() {
    const hint = $("#aucKeyHint");
    const raw = ($("#aucKey").value || "").trim().toUpperCase();
    hint.className = "auc-callhint";
    if (!raw) {
      hint.textContent = "Type a Player Key.";
      return;
    }

    // Opening the tab and typing straight away used to answer "no player has
    // that key", which is a lie — the pool simply had not arrived yet.
    if (!aLots.length) {
      hint.textContent = "Still loading the pool — try that key again in a second.";
      return;
    }

    const hit = aLots.find((l) => (l.player_key || "").toUpperCase() === raw);
    if (!hit) {
      hint.classList.add("bad");
      hint.textContent = `No player has the key ${raw}. Check it on the Auction Pool tab.`;
      // The projector shows the card and nothing else, so a bad key must take
      // the previous player down. Leaving them up would have the room looking
      // at someone who is not being auctioned, with the explanation sitting on
      // a screen they cannot see.
      renderPlayerCard(null);
      return;
    }
    if (hit.status === "sold") {
      hint.classList.add("bad");
      const t = aTeams.find((x) => x.id === hit.sold_to_team_id);
      hint.textContent = `${hit.name} is already sold to ${t ? t.name : "a team"} for ${aucMoney(
        hit.sold_price
      )}.`;
      return;
    }

    const btn = $("#btnAucCall");
    busy(btn, true);
    const { error } = await sb.rpc("auction_start_lot", { p_lot_id: hit.id, p_base: null });
    busy(btn, false);
    if (error) {
      hint.classList.add("bad");
      hint.textContent = error.message;
      return;
    }
    hint.classList.add("ok");
    hint.textContent = `${hit.name} · ${hit.category} · base ${aucMoney(hit.base_price)}`;
    $("#aucKey").value = "";
    loadAuction();
  }

  /* ---- projector mode ----
     Full-screens the stage only, so the Player Key box, Sell to and the
     price field go up with the card and the auctioneer can keep working
     without dropping out. Esc and the browser's own exit are honoured. */
  function stageEl() { return document.getElementById("aucStage"); }

  // Fallback for when the real Fullscreen API is refused — a locked-down
  // browser, a kiosk policy, an embedded frame. Losing the projector view on
  // auction night because of a permissions policy is not an acceptable
  // failure, so blow the stage up to fill the window instead.
  function setBlownUp(on) {
    const el = stageEl();
    if (!el) return;
    el.classList.toggle("is-blownup", on);
    document.body.classList.toggle("mn-blownup", on);
    syncFullscreenButton(on);
    if (on) setTimeout(() => $("#aucKey") && $("#aucKey").focus(), 60);
  }

  function syncFullscreenButton(on) {
    const b = $("#btnAucFull");
    if (!b) return;
    b.setAttribute("aria-pressed", on ? "true" : "false");
    const l = b.querySelector(".mn-fs-label");
    if (l) l.textContent = on ? "Exit" : "Full screen";
  }

  async function toggleFullscreen() {
    const el = stageEl();
    if (!el) return;

    if (el.classList.contains("is-blownup")) return setBlownUp(false);
    if (document.fullscreenElement) {
      try { await document.exitFullscreen(); } catch { /* already out */ }
      return;
    }

    try {
      if (el.requestFullscreen) {
        await el.requestFullscreen({ navigationUI: "hide" });
      } else if (el.webkitRequestFullscreen) {
        el.webkitRequestFullscreen();
      } else {
        setBlownUp(true);
      }
    } catch {
      // refused (no user gesture, kiosk policy, iframe) — use the fallback
      setBlownUp(true);
      toast("Full screen was blocked, so the stage is filling the window instead. Esc to exit.", "info");
    }
  }

  // Esc leaves the fallback, matching what Esc does in real full screen.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const el = stageEl();
    if (el && el.classList.contains("is-blownup")) setBlownUp(false);
  });

  $("#btnAucFull") && $("#btnAucFull").addEventListener("click", toggleFullscreen);

  document.addEventListener("fullscreenchange", () => {
    const on = document.fullscreenElement === stageEl();
    syncFullscreenButton(on);
    // Hand focus to the key box on the way in: the whole point of taking the
    // stage full screen is to keep calling players.
    if (on) setTimeout(() => $("#aucKey") && $("#aucKey").focus(), 60);
  });

  // F toggles it, but never while the operator is typing into a field.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "f" && e.key !== "F") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    const pane = $("#tab-auction");
    if (!pane || pane.hidden) return;
    e.preventDefault();
    toggleFullscreen();
  });

  $("#btnAucCall") && $("#btnAucCall").addEventListener("click", callByKey);
  $("#aucKey") &&
    $("#aucKey").addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      callByKey();
    });

  /* ---- digital player card ----
     The pool row only carries the organiser's overrides. The photo, sex and
     DUPR usually live on the player's registration, joined by Player Key, so
     ask the server to resolve the two into one card. */
  let cardFor = null;
  async function renderPlayerCard(lot) {
    const card = $("#aucCard");
    if (!lot) {
      card.hidden = true;
      cardFor = null;
      return;
    }
    card.hidden = false;
    if (cardFor === lot.id) return;                  // already showing this player
    cardFor = lot.id;

    // paint what we already know so the card never sits blank
    paintCard({
      name: lot.name,
      category: lot.category,
      category_label: catLabel(lot.category),
      base_price: lot.base_price,
      photo_url: lot.photo_url,
      sex: lot.sex,
      age: lot.age,
      dupr: lot.dupr,
      has_registration: false,
      player_key: lot.player_key,
    });

    const { data, error } = await sb.rpc("auction_player_card", { p_pool_id: lot.id });
    if (error || cardFor !== lot.id) return;         // stale response, a new player is up
    const c = Array.isArray(data) ? data[0] : data;
    if (c) paintCard(c);
  }

  /* The card is the supplied artwork with the player laid onto it; the
     renderer lives in mn-card.js so the console and every captain's app
     draw an identical card. */
  function paintCard(c) {
    const el = $("#aucCard");
    if (el) MNCard.render(el, c);
  }

  const catLabel = (code) =>
    aCats.find((x) => x.code === code)?.label ||
    ({ A: "Advance", B: "Intermediate", C: "Beginner" }[code] || "");

  /* ---- one table for the whole field ----
     Who is left, who went where, and for how much — the three questions the
     desk asks all evening, in a single list rather than three panels. */
  function renderAucList() {
    const body = $("#aucListBody");
    if (!body) return;

    const q = ($("#aucListQ")?.value || "").trim().toLowerCase();
    const st = $("#aucListStatus")?.value || "";
    const cat = $("#aucListCat")?.value || "";
    const team = $("#aucListTeam")?.value || "";

    // Every slot counts, including the four the sheet left blank — hiding them
    // made the total read 140 against a pool of 144 and there was no way to
    // see which slots still need a name.
    const all = aLots;
    const n = (s) => all.filter((l) => l.status === s).length;

    const list = all
      .filter((l) => {
        // "pool" in the filter means "not auctioned yet", which includes the
        // player currently on screen.
        if (st === "pool" && !(l.status === "pool" || l.status === "live")) return false;
        if (st && st !== "pool" && l.status !== st) return false;
        if (cat && l.category !== cat) return false;
        if (team && String(l.sold_to_team_id) !== team) return false;
        if (!q) return true;
        const t = aTeams.find((x) => x.id === l.sold_to_team_id);
        return `${l.name} ${l.player_key || ""} ${l.sl_no || ""} ${t ? t.name : ""}`
          .toLowerCase()
          .includes(q);
      })
      .sort((a, b) => (a.sl_no || 0) - (b.sl_no || 0));

    const filtered = list.length !== all.length;
    $("#aucListCount").textContent = filtered ? `${list.length} / ${all.length}` : all.length;

    const spend = all.reduce((s, l) => s + Number(l.sold_price || 0), 0);
    const blank = all.filter((l) => !String(l.name || "").trim()).length;
    const tally = $("#aucListTally");
    if (tally) {
      tally.innerHTML =
        `<span>${all.length} in pool</span>` +
        `<span class="t-pool">${n("pool") + n("live")} available</span>` +
        `<span class="t-sold">${n("sold")} sold</span>` +
        `<span class="t-unsold">${n("unsold")} unsold</span>` +
        ["A", "B", "C"]
          .map(
            (c) =>
              `<span>${all.filter((l) => l.category === c && l.status === "sold").length}/${all.filter(
                (l) => l.category === c
              ).length} ${c}</span>`
          )
          .join("") +
        `<span>${aucMoney(spend)} spent</span>` +
        (blank ? `<span class="t-unsold">${blank} slot${blank === 1 ? "" : "s"} unnamed</span>` : "");
    }

    const tsel = $("#aucListTeam");
    if (tsel) {
      const keep = tsel.value;
      tsel.innerHTML =
        `<option value="">All teams</option>` +
        aTeams
          .map((t) => {
            const c = all.filter((l) => l.sold_to_team_id === t.id).length;
            return `<option value="${t.id}">${esc(t.name)}${c ? ` · ${c}` : ""}</option>`;
          })
          .join("");
      tsel.value = keep;
    }

    const emptyEl = $("#aucListEmpty");
    emptyEl.hidden = list.length > 0;
    if (!list.length) {
      const bits = [];
      if (st) bits.push(st === "pool" ? "not yet auctioned" : st);
      if (cat) bits.push("category " + cat);
      if (team) bits.push(aTeams.find((x) => String(x.id) === team)?.name || "that team");
      if (q) bits.push(`matching “${q}”`);
      emptyEl.textContent = bits.length
        ? `No players ${bits.join(" · ")}.`
        : "No players in the pool yet.";
    }

    body.innerHTML = list
      .map((l) => {
        const t = aTeams.find((x) => x.id === l.sold_to_team_id);
        const isLive = aState && aState.current_lot_id === l.id;
        const status = isLive
          ? `<span class="pool-badge s-live">on screen</span>`
          : `<span class="pool-badge s-${esc(l.status)}">${esc(
              l.status === "pool" ? "available" : l.status
            )}</span>`;
        const actions =
          l.status === "sold"
            ? `<button class="icon-btn" data-auc-undo="${esc(l.id)}" title="Undo the sale and return this player to the pool">↺</button>
               <button class="icon-btn" data-auc-tounsold="${esc(l.id)}" title="Reverse the sale and mark this player unsold">⊘</button>`
            : "";
        return `<tr class="${l.status === "sold" ? "is-sold" : ""} ${isLive ? "is-live" : ""}">
          <td><span class="g-code">${esc(l.player_key || "—")}</span></td>
          <td class="al-name">${
            String(l.name || "").trim()
              ? esc(l.name)
              : `<i class="al-tbd">slot ${l.sl_no} · name not filled in</i>`
          }</td>
          <td><span class="cat-chip c-${esc(l.category)}">${esc(l.category)}</span></td>
          <td class="num">${aucMoney(l.base_price)}</td>
          <td>${status}</td>
          <td>${t ? `<span class="team-no">T${l.sold_to_team_id}</span> ${esc(t.name)}` : `<span class="g-ro">—</span>`}</td>
          <td class="num">${l.sold_price != null ? aucMoney(l.sold_price) : `<span class="g-ro">—</span>`}</td>
          <td class="g-actions">${actions}</td>
        </tr>`;
      })
      .join("");
  }

  ["aucListQ", "aucListStatus", "aucListCat", "aucListTeam"].forEach((id) => {
    const el = $("#" + id);
    if (!el) return;
    el.addEventListener("input", () => aucReady && renderAucList());
    el.addEventListener("change", () => aucReady && renderAucList());
  });

  const aucOpenTeams = new Set();

  function renderAucTeams() {
    const q = ($("#aucTeamQ")?.value || "").trim().toLowerCase();
    const list = aTeams.filter(
      (t) => !q || t.name.toLowerCase().includes(q)
    );
    $("#aucTeamCount").textContent = aTeams.length;

    $("#aucTeamCards").innerHTML = list
      .map((t) => {
        const squad = aucSquad(t.id);
        const open = aucOpenTeams.has(t.id);
        const pct = Math.max(0, Math.min(100, (Number(t.purse_left) / (Number(t.purse_total) || 1)) * 100));
        const leading = aState && aState.leading_team_id === t.id;

        const rows = squad.length
          ? squad
              .map(
                (l) => `<div class="tc-player">
                  ${l.photo_url ? `<img src="${esc(l.photo_url)}" alt="" loading="lazy" />` : `<span class="noimg">🥒</span>`}
                  <div class="tc-p-info">
                    <div class="tc-p-name">${esc(l.name)}</div>
                    <div class="tc-p-meta">${l.dupr != null ? "DUPR " + Number(l.dupr).toFixed(3) : "Unrated"}${
                  l.jersey_size ? " · " + esc(l.jersey_size) : ""
                }</div>
                  </div>
                  <span class="tc-p-price">${aucMoney(l.sold_price)}</span>
                  <button class="icon-btn del" data-auc-release="${esc(l.id)}" title="Release player (refunds the purse)">✕</button>
                </div>`
              )
              .join("")
          : `<p class="tc-empty">No players bought yet.</p>`;

        return `<div class="team-card ${leading ? "is-leading" : ""}" data-team="${t.id}">
          <div class="tc-head">
            <span class="tc-badge">${t.id}</span>
            <div class="tc-id">
              <div class="tc-name">${esc(t.name)}${leading ? ' <span class="tc-live">bidding</span>' : ""}</div>
              <div class="tc-login ${t.auth_user_id ? "" : "nolink"}">${
          t.auth_user_id ? "login active" : "no login yet"
        }</div>
            </div>
            <button class="tc-toggle" data-auc-toggle="${t.id}" aria-expanded="${open}">
              ${squad.length}/${t.max_squad} players ${open ? "▲" : "▼"}
            </button>
          </div>

          <div class="tc-wallet">
            <div>
              <p class="tc-w-label">Remaining</p>
              <p class="tc-w-value">${aucMoney(t.purse_left)}</p>
            </div>
            <div>
              <p class="tc-w-label">Spent</p>
              <p class="tc-w-value dim">${aucMoney(t.purse_spent)}</p>
            </div>
          </div>
          <div class="tc-bar"><i style="width:${pct}%"></i></div>

          <div class="tc-controls">
            <label class="tc-ctl">
              <span>Purse</span>
              <input type="number" data-tf="purse_total" value="${Number(t.purse_total)}" step="1000" />
            </label>
            <label class="tc-ctl narrow">
              <span>Max squad</span>
              <input type="number" data-tf="max_squad" value="${Number(t.max_squad)}" min="1" />
            </label>
            <div class="tc-topup">
              <input type="number" placeholder="+ / − ₹" data-topup="${t.id}" step="1000" />
              <button class="btn-mini" data-auc-topup="${t.id}">Adjust</button>
            </div>
          </div>

          <div class="tc-squad" ${open ? "" : "hidden"}>${rows}</div>
        </div>`;
      })
      .join("");
  }

  /* ---- delegated auction actions ---- */
  document.addEventListener("click", async (e) => {
    const undo = e.target.closest("[data-auc-undo]");
    if (undo) {
      const lot = aLots.find((l) => l.id === undo.dataset.aucUndo);
      confirmDialog(
        `Undo the sale of ${lot ? lot.name : "this player"}? The team's purse will be refunded.`,
        async () => {
          const { error } = await sb.rpc("auction_undo_sale", { p_lot_id: undo.dataset.aucUndo });
          if (error) return toast(error.message, "err");
          toast("Sale undone and purse refunded", "ok");
          loadAuction();
        },
        "Return to pool",
        false
      );
      return;
    }

    const tounsold = e.target.closest("[data-auc-tounsold]");
    if (tounsold) {
      const lot = aLots.find((l) => l.id === tounsold.dataset.aucTounsold);
      confirmDialog(
        `Reverse the sale of ${lot ? lot.name : "this player"} and mark them UNSOLD? ` +
          `The team's purse is refunded and the player leaves that squad. ` +
          `They stay out of the pool until you put them on the block again.`,
        async () => {
          const { error } = await sb.rpc("auction_undo_sale", {
            p_lot_id: tounsold.dataset.aucTounsold,
            p_to_status: "unsold",
          });
          if (error) return toast(error.message, "err");
          toast("Sale reversed — player marked unsold and purse refunded", "ok");
          loadAuction();
        },
        "Mark unsold",
        false
      );
      return;
    }

    const toggle = e.target.closest("[data-auc-toggle]");
    if (toggle) {
      const id = Number(toggle.dataset.aucToggle);
      aucOpenTeams.has(id) ? aucOpenTeams.delete(id) : aucOpenTeams.add(id);
      renderAucTeams();
      return;
    }

    const release = e.target.closest("[data-auc-release]");
    if (release) {
      const lot = aLots.find((l) => l.id === release.dataset.aucRelease);
      confirmDialog(
        `Release ${lot ? lot.name : "this player"} back to the pool? ` +
          `${lot ? aucMoney(lot.sold_price) : "The fee"} will be refunded to the team.`,
        async () => {
          const { error } = await sb.rpc("auction_undo_sale", { p_lot_id: release.dataset.aucRelease });
          if (error) return toast(error.message, "err");
          toast("Player released and purse refunded", "ok");
          loadAuction();
        },
        "Release",
        false
      );
      return;
    }

    const topup = e.target.closest("[data-auc-topup]");
    if (topup) {
      const id = Number(topup.dataset.aucTopup);
      const input = $(`[data-topup="${id}"]`);
      const delta = Number(input.value);
      if (!delta) return toast("Enter an amount to add (or a negative amount to remove)", "info");
      const team = aTeams.find((t) => t.id === id);
      const next = Number(team.purse_total) + delta;
      if (next < Number(team.purse_spent))
        return toast(`Can't drop below what ${team.name} has already spent (${aucMoney(team.purse_spent)})`, "err");
      const { error } = await sb.from("auction_teams").update({ purse_total: next }).eq("id", id);
      if (error) return toast(error.message, "err");
      input.value = "";
      toast(`${team.name} purse ${delta > 0 ? "topped up" : "reduced"} → ${aucMoney(next)}`, "ok");
      loadAuction();
      return;
    }
  });

  $("#aucTeamQ")?.addEventListener("input", () => aucReady && renderAucTeams());
  $("#btnAucExpandAll")?.addEventListener("click", () => {
    const allOpen = aTeams.every((t) => aucOpenTeams.has(t.id));
    aucOpenTeams.clear();
    if (!allOpen) aTeams.forEach((t) => aucOpenTeams.add(t.id));
    $("#btnAucExpandAll").textContent = allOpen ? "Expand all squads" : "Collapse all squads";
    renderAucTeams();
  });

  /* ---- inline team edits ---- */
  document.addEventListener("change", async (e) => {
    const inp = e.target.closest("[data-tf]");
    if (!inp) return;
    const host = inp.closest("[data-team]");
    if (!host) return;
    const id = Number(host.dataset.team);
    const field = inp.dataset.tf;
    const value = inp.type === "number" ? Number(inp.value) : inp.value.trim() || null;
    const { error } = await sb.from("auction_teams").update({ [field]: value }).eq("id", id);
    if (error) return toast(error.message, "err");
    toast("Team updated", "ok");
    loadAuction();
  });

  /* ---- stage controls ---- */
  $("#btnAucSell").addEventListener("click", async () => {
    const btn = $("#btnAucSell");
    const teamSel = $("#aucSellTeam").value;
    const priceIn = $("#aucSellPrice").value;
    // Read who is on the block BEFORE selling: the sale clears the block, and
    // realtime can null it out from under us before the call returns.
    const sold = aLots.find((l) => l.id === (aState && aState.current_lot_id));
    const team = aTeams.find((t) => t.id === Number(teamSel));
    busy(btn, true);
    const { error } = await sb.rpc("auction_sell", {
      p_lot_id: null,
      p_team_id: teamSel ? Number(teamSel) : null,
      p_price: priceIn ? Number(priceIn) : null,
    });
    busy(btn, false);
    if (error) return toast(error.message, "err");
    $("#aucSellPrice").value = "";
    $("#aucSellTeam").value = "";
    toast("Sold — wallet deducted and squad updated", "ok");
    // The room is watching the projector, not this panel.
    if (window.MNSold)
      MNSold.show($("#aucStage"), {
        name: sold ? sold.name : "",
        team: team ? team.name : "",
        price: priceIn ? Number(priceIn) : sold && sold.base_price,
      });
    loadAuction();
  });

  $("#btnAucUnsold").addEventListener("click", async () => {
    const { error } = await sb.rpc("auction_mark_unsold", { p_lot_id: null });
    if (error) return toast(error.message, "err");
    toast("Marked unsold", "info");
    loadAuction();
  });

  $("#btnAucClear").addEventListener("click", async () => {
    const { error } = await sb
      .from("auction_state")
      .update({ status: "idle", current_lot_id: null, current_price: 0, leading_team_id: null })
      .eq("id", 1);
    if (error) return toast(error.message, "err");
    const live = aLots.find((l) => aState && l.id === aState.current_lot_id);
    if (live && live.status === "live") {
      await sb.from("auction_pool").update({ status: "pool" }).eq("id", live.id);
    }
    const hint = $("#aucKeyHint");
    if (hint) {
      hint.className = "auc-callhint";
      hint.textContent = "";
    }
    const key = $("#aucKey");
    if (key) {
      key.value = "";
      key.focus();
    }
    toast("Screen cleared", "info");
    loadAuction();
  });

  $("#btnAucReset").addEventListener("click", () =>
    confirmDialog(
      "Reset the ENTIRE auction? Every player returns to the pool and all purses are refilled. This cannot be undone.",
      async () => {
        const { error } = await sb.rpc("auction_reset");
        if (error) return toast(error.message, "err");
        toast("Auction reset", "ok");
        loadAuction();
      },
      "Reset auction"
    )
  );

  /* ---- photos on the Full Table: upload, replace, remove ----
     Every player card falls back to the registration photo, so being able
     to fix a missing or wrong one here is what makes the cards complete. */
  let gPhotoTarget = null;   // { id, field } awaiting a file

  document.addEventListener("click", (e) => {
    const up = e.target.closest("[data-regphoto]");
    if (up) {
      gPhotoTarget = { id: up.dataset.regphoto, field: up.dataset.regfield };
      $("#gridPhotoInput").click();
      return;
    }
    const del = e.target.closest("[data-regphotodel]");
    if (!del) return;
    const id = del.dataset.regphotodel;
    const field = del.dataset.regfield;
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    confirmDialog(`Remove this photo from ${row.full_name}?`, async () => {
      const { error } = await sb.from("registrations").update({ [field]: null }).eq("id", id);
      if (error) return toast("Couldn't remove: " + error.message, "err");
      row[field] = null;
      renderGrid();
      toast("Photo removed", "ok");
    }, "Remove photo");
  });

  $("#gridPhotoInput") &&
    $("#gridPhotoInput").addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!file || !gPhotoTarget) return;
      const { id, field } = gPhotoTarget;
      gPhotoTarget = null;
      const row = rows.find((r) => r.id === id);
      if (!row) return;

      toast("Uploading photo…", "info");
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
      const folder = field === "profile_pic_url" ? "profile" : "payment";
      const path = `${folder}/${id}-${Date.now()}.${ext}`;
      const up = await sb.storage
        .from(CFG.STORAGE_BUCKET)
        .upload(path, file, { contentType: file.type || "image/jpeg", upsert: false });
      if (up.error) return toast("Upload failed: " + up.error.message, "err");

      const url = sb.storage.from(CFG.STORAGE_BUCKET).getPublicUrl(path).data.publicUrl;
      const { error } = await sb.from("registrations").update({ [field]: url }).eq("id", id);
      if (error) return toast("Couldn't save the photo: " + error.message, "err");
      row[field] = url;
      renderGrid();
      toast(`Photo updated for ${row.full_name}`, "ok");
    });

  /* ============================================================
     AUCTION POOL — the curated player list the auction runs on.
     This is NOT the registration table: registrations stay open and
     are joined to a pool entry by the Player Key typed in by hand.
     ============================================================ */
  let pRows = [];
  let pCards = {};           // pool id -> row resolved against its registration
  let pPhotoTarget = null;   // pool row id awaiting a file from #poolPhotoInput

  const POOL_COLS = [
    { key: "sl_no",      label: "#",           type: "ro" },
    { key: "player_key", label: "Player Key",  type: "text" },
    { key: "name",       label: "Name",        type: "text" },
    { key: "category",   label: "Cat",         type: "select", opts: ["A", "B", "C"] },
    { key: "base_price", label: "Base ₹",      type: "number", step: "100" },
    { key: "sex",        label: "Sex",         type: "select", opts: ["", "Male", "Female", "Other"] },
    { key: "age",        label: "Age",         type: "number", step: "1" },
    { key: "dupr",       label: "DUPR",        type: "number", step: "0.001" },
    { key: "photo_url",  label: "Photo",       type: "photo" },
    { key: "status",     label: "Status",      type: "badge" },
    { key: "sold",       label: "Sold To",     type: "sold" },
  ];

  async function loadPool() {
    const [p, c, t, cd] = await Promise.all([
      sb.from("auction_pool").select("*").order("sl_no", { nullsFirst: false }),
      sb.from("auction_categories").select("*").order("sort_order"),
      sb.from("auction_teams").select("id,name").order("id"),
      // the same rows resolved against registrations, so the grid can show
      // what each player will actually get on their card
      sb.rpc("auction_cards"),
    ]);
    pCards = {};
    if (!cd.error && cd.data) cd.data.forEach((x) => (pCards[x.id] = x));
    if (p.error) {
      $("#poolEmpty").hidden = false;
      $("#poolEmpty").textContent = /does not exist|schema cache/i.test(p.error.message || "")
        ? "The auction pool table isn't installed yet — run the auction install first."
        : "Couldn't load the pool: " + p.error.message;
      $("#poolBody").innerHTML = "";
      return;
    }
    pRows = p.data || [];
    if (c.data) aCats = c.data;
    if (t.data && !aTeams.length) aTeams = t.data;
    renderPool();
  }

  function poolFiltered() {
    const q = ($("#poolQ").value || "").trim().toLowerCase();
    const cat = $("#poolCatFilter").value;
    return pRows.filter((r) => {
      if (cat && r.category !== cat) return false;
      if (!q) return true;
      return `${r.name} ${r.player_key || ""} ${r.category} ${r.sl_no || ""}`.toLowerCase().includes(q);
    });
  }

  function poolCell(r, col) {
    const v = r[col.key];
    const card = pCards[r.id];
    // What the player card will show when this cell is left blank. The
    // spreadsheet carries no sex/age/DUPR at all, so for most players these
    // come from the registration the Player Key points at.
    const inherited = card ? card[col.key] : null;
    const idf = `data-pid="${esc(r.id)}" data-pfield="${col.key}"`;
    switch (col.type) {
      case "ro":
        return `<span class="g-ro">${esc(v ?? "—")}</span>`;
      case "number": {
        const ph = v == null && inherited != null ? ` placeholder="${esc(inherited)}" title="from the registration form"` : "";
        const cls = v == null && inherited != null ? " g-inherit" : "";
        return `<input class="g-in g-num${cls}" type="number" step="${col.step}" min="0" value="${v ?? ""}"${ph} ${idf} />`;
      }
      case "select": {
        const cls = !v && inherited ? " g-inherit" : "";
        return `<select class="g-sel${cls}" ${idf} ${
          !v && inherited ? `title="${esc(inherited)} — from the registration form"` : ""
        }>${col.opts
          .map(
            (o) =>
              `<option value="${esc(o)}" ${o === (v ?? "") ? "selected" : ""}>${esc(
                o || (inherited ? inherited + " ·" : "—")
              )}</option>`
          )
          .join("")}</select>`;
      }
      case "photo": {
        const shown = v || inherited;
        const own = !!v;
        return `${
          shown
            ? `<img class="g-thumb${own ? "" : " g-inherit"}" src="${esc(shown)}" alt="" data-zoom="${esc(
                shown
              )}" loading="lazy" title="${own ? "uploaded here" : "from the registration form"}" />`
            : `<span class="g-ro">—</span>`
        }<button type="button" class="btn-mini pool-up" data-pphoto="${esc(r.id)}" title="Upload a photo for this player">⤒</button>`;
      }
      case "badge":
        return `<span class="pool-badge s-${esc(v)}">${esc(v)}</span>`;
      case "sold": {
        if (r.status !== "sold") return `<span class="g-ro">—</span>`;
        const t = aTeams.find((x) => x.id === r.sold_to_team_id);
        return `<span class="g-ro">${esc(t ? t.name : "—")} · ${aucMoney(r.sold_price)}</span>`;
      }
      default:
        return `<input class="g-in" value="${esc(v ?? "")}" ${idf} autocomplete="off" spellcheck="false" />`;
    }
  }

  function renderPool() {
    const head = $("#poolHead");
    if (!head) return;
    head.innerHTML =
      POOL_COLS.map((c) => `<th>${c.label}</th>`).join("") + `<th class="th-actions">·</th>`;

    const list = poolFiltered();
    $("#poolEmpty").hidden = list.length > 0;
    $("#poolEmpty").textContent = pRows.length
      ? "No players match your filter."
      : "The auction pool is empty.";

    $("#poolBody").innerHTML = list
      .map(
        (r) =>
          `<tr data-pid="${esc(r.id)}" class="${r.status === "sold" ? "is-sold" : ""}">${POOL_COLS.map(
            (c) => `<td class="g-td g-${c.type}">${poolCell(r, c)}</td>`
          ).join("")}<td class="g-td g-actions">
            <button type="button" class="icon-btn del" data-pdel="${esc(r.id)}" title="Remove from pool" aria-label="Remove">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
            </button></td></tr>`
      )
      .join("");

    renderPoolStats();
    renderSuggestions();
  }

  function renderPoolStats() {
    const el = $("#poolStats");
    if (!el) return;
    const stat = (label, value, tone) =>
      `<div class="stat ${tone || ""}"><div class="n">${value}</div><div class="l">${label}</div></div>`;
    const named = pRows.filter((r) => String(r.name || "").trim());
    const blank = pRows.length - named.length;
    const linked = pRows.filter((r) => r.player_key && String(r.player_key).trim()).length;
    const byCat = ["A", "B", "C"].map((c) => {
      const all = pRows.filter((r) => r.category === c);
      return stat(`${c} · ${catLabel(c)}`, `${all.filter((r) => String(r.name || "").trim()).length}/${all.length}`);
    });
    // How many will actually have a full card. The spreadsheet has no photo,
    // sex, age or DUPR — those only arrive via the Player Key link.
    const res = Object.values(pCards);
    const withPhoto = res.filter((c) => c.photo_url).length;
    const withDupr = res.filter((c) => c.dupr != null).length;
    const withAge = res.filter((c) => c.age != null).length;

    el.innerHTML =
      stat("Pool slots", pRows.length) +
      byCat.join("") +
      stat("Player Keys set", `${linked}/${pRows.length}`, linked < pRows.length ? "warn" : "") +
      stat("With photo", `${withPhoto}/${pRows.length}`, withPhoto < pRows.length ? "warn" : "ok") +
      stat("With DUPR", `${withDupr}/${pRows.length}`, withDupr < pRows.length ? "warn" : "ok") +
      stat("With age", `${withAge}/${pRows.length}`, withAge < pRows.length ? "warn" : "ok") +
      stat("Slots needing a name", blank, blank ? "warn" : "");
  }

  /* ---- suggested links ----
     Exact-name auto-linking only gets the easy ones. The rest differ by a
     letter or two ("Mustanzir" vs "Mustansir"), which a person can settle at
     a glance but a script should not decide on its own. */
  function editDistance(a, b) {
    const m = [];
    for (let i = 0; i <= b.length; i++) m[i] = [i];
    for (let j = 0; j <= a.length; j++) m[0][j] = j;
    for (let i = 1; i <= b.length; i++)
      for (let j = 1; j <= a.length; j++)
        m[i][j] =
          b[i - 1] === a[j - 1]
            ? m[i - 1][j - 1]
            : Math.min(m[i - 1][j - 1] + 1, m[i][j - 1] + 1, m[i - 1][j] + 1);
    return m[b.length][a.length];
  }
  const normName = (s) =>
    String(s || "").toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();

  function poolSuggestions() {
    const freePool = pRows.filter((p) => String(p.name || "").trim() && !p.player_key);
    const freeRegs = rows.filter((r) => !r.player_key && String(r.full_name || "").trim());
    const out = [];
    for (const p of freePool) {
      const pk = normName(p.name);
      if (!pk) continue;
      let best = null;
      for (const r of freeRegs) {
        const rk = normName(r.full_name);
        if (!rk) continue;
        const sim = 1 - editDistance(pk, rk) / Math.max(pk.length, rk.length);
        if (sim > 0.72 && (!best || sim > best.sim)) best = { reg: r, sim };
      }
      if (best) out.push({ pool: p, reg: best.reg, sim: best.sim });
    }
    return out.sort((a, b) => b.sim - a.sim);
  }

  function renderSuggestions() {
    const box = $("#poolSuggest");
    if (!box) return;
    const list = poolSuggestions();
    box.hidden = list.length === 0;
    $("#poolSuggestCount").textContent = list.length;
    $("#poolSuggestList").innerHTML = list
      .map(
        (s) => `<div class="suggest-row" data-sg-pool="${esc(s.pool.id)}" data-sg-reg="${esc(s.reg.id)}">
          ${
            s.reg.profile_pic_url
              ? `<img src="${esc(s.reg.profile_pic_url)}" alt="" loading="lazy" />`
              : `<span class="noimg">🥒</span>`
          }
          <div class="suggest-main">
            <div class="suggest-names">
              <b>${esc(s.pool.name)}</b>
              <span class="cat-chip c-${esc(s.pool.category)}">${esc(s.pool.category)}</span>
              <span class="suggest-arrow">↔</span>
              <span>${esc(s.reg.full_name)}</span>
            </div>
            <div class="suggest-meta">
              ${Math.round(s.sim * 100)}% match ·
              ${s.reg.dupr != null ? "DUPR " + Number(s.reg.dupr).toFixed(3) : "no DUPR"} ·
              ${s.reg.profile_pic_url ? "has photo" : "no photo"}
            </div>
          </div>
          <button class="btn-mini" data-sg-link="1">Link</button>
        </div>`
      )
      .join("");
  }

  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-sg-link]");
    if (!btn) return;
    const row = btn.closest("[data-sg-pool]");
    const pool = pRows.find((p) => p.id === row.dataset.sgPool);
    const reg = rows.find((r) => r.id === row.dataset.sgReg);
    if (!pool || !reg) return;

    const key = `MPL-${pool.category}-${String(pool.sl_no || 0).padStart(3, "0")}`;
    btn.disabled = true;
    const a = await sb.from("auction_pool").update({ player_key: key }).eq("id", pool.id);
    if (a.error) {
      btn.disabled = false;
      return toast("Couldn't link: " + a.error.message, "err");
    }
    const b = await sb.from("registrations").update({ player_key: key }).eq("id", reg.id);
    if (b.error) {
      // don't leave a half-link behind
      await sb.from("auction_pool").update({ player_key: null }).eq("id", pool.id);
      btn.disabled = false;
      return toast("Couldn't link: " + b.error.message, "err");
    }
    pool.player_key = key;
    reg.player_key = key;
    await loadPool();
    toast(`${pool.name} linked to ${reg.full_name} as ${key}`, "ok");
  });

  /* ---- inline editing ---- */
  async function commitPoolCell(el) {
    const id = el.dataset.pid;
    const field = el.dataset.pfield;
    const row = pRows.find((r) => r.id === id);
    if (!row) return;

    let value = el.value;
    if (field === "player_key") value = value.trim().toUpperCase() || null;
    else if (field === "age") value = value === "" ? null : Number(value);
    else if (field === "dupr") value = value === "" ? null : Number(value);
    else if (field === "base_price") value = value === "" ? 0 : Number(value);
    else if (field === "sex") value = value || null;
    else if (typeof value === "string") value = value.trim();

    if ((row[field] ?? null) === (value ?? null)) return;

    const patch = { [field]: value };
    // Category owns the default base price, so moving a player between
    // categories should re-price them unless the organiser overrides it after.
    if (field === "category") {
      const cat = aCats.find((c) => c.code === value);
      if (cat) patch.base_price = cat.base_price;
    }

    el.classList.add("g-saving");
    const { error } = await sb.from("auction_pool").update(patch).eq("id", id);
    el.classList.remove("g-saving");
    if (error) {
      toast(
        /duplicate key|unique/i.test(error.message)
          ? `Player Key “${value}” is already used by another pool entry.`
          : "Couldn't save: " + error.message,
        "err"
      );
      el.value = row[field] ?? "";
      el.classList.add("g-err");
      setTimeout(() => el.classList.remove("g-err"), 1200);
      return;
    }
    Object.assign(row, patch);
    if (field === "player_key") el.value = value ?? "";
    el.classList.add("g-ok");
    setTimeout(() => el.classList.remove("g-ok"), 900);
    if (field === "category") renderPool();
    else renderPoolStats();
  }

  document.addEventListener("change", (e) => {
    const el = e.target.closest("[data-pfield]");
    if (el && el.tagName === "SELECT") commitPoolCell(el);
  });
  document.addEventListener("blur", (e) => {
    const el = e.target.closest && e.target.closest("[data-pfield]");
    if (el && el.tagName === "INPUT") commitPoolCell(el);
  }, true);
  document.addEventListener("keydown", (e) => {
    const el = e.target.closest && e.target.closest("[data-pfield]");
    if (el && e.key === "Enter" && el.tagName === "INPUT") {
      e.preventDefault();
      el.blur();
    }
  });

  $("#poolQ") && $("#poolQ").addEventListener("input", renderPool);
  $("#poolCatFilter") && $("#poolCatFilter").addEventListener("change", renderPool);

  /* ---- photo upload for a pool player ---- */
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-pphoto]");
    if (!b) return;
    pPhotoTarget = b.dataset.pphoto;
    $("#poolPhotoInput").click();
  });

  $("#poolPhotoInput") &&
    $("#poolPhotoInput").addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!file || !pPhotoTarget) return;
      const id = pPhotoTarget;
      pPhotoTarget = null;
      const row = pRows.find((r) => r.id === id);
      if (!row) return;

      toast("Uploading photo…", "info");
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
      const path = `pool/${id}-${Date.now()}.${ext}`;
      const up = await sb.storage
        .from(CFG.STORAGE_BUCKET)
        .upload(path, file, { contentType: file.type || "image/jpeg", upsert: false });
      if (up.error) return toast("Upload failed: " + up.error.message, "err");

      const { data } = sb.storage.from(CFG.STORAGE_BUCKET).getPublicUrl(path);
      const url = data.publicUrl;
      const { error } = await sb.from("auction_pool").update({ photo_url: url }).eq("id", id);
      if (error) return toast("Couldn't save the photo: " + error.message, "err");
      row.photo_url = url;
      renderPool();
      toast(`Photo set for ${row.name || "this player"}`, "ok");
    });

  /* ---- add / remove ---- */
  $("#btnPoolAdd") &&
    $("#btnPoolAdd").addEventListener("click", async () => {
      const cat = $("#poolCatFilter").value || "C";
      const base = aCats.find((c) => c.code === cat)?.base_price ?? 20000;
      const nextSl = pRows.reduce((m, r) => Math.max(m, r.sl_no || 0), 0) + 1;
      const { error } = await sb
        .from("auction_pool")
        .insert({ sl_no: nextSl, name: "", category: cat, base_price: base });
      if (error) return toast("Couldn't add: " + error.message, "err");
      await loadPool();
      toast(`Added slot ${nextSl} in category ${cat}`, "ok");
    });

  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-pdel]");
    if (!b) return;
    const row = pRows.find((r) => r.id === b.dataset.pdel);
    if (!row) return;
    if (row.status === "sold") return toast("That player is sold — undo the sale first.", "err");
    confirmDialog(
      `Remove ${row.name || `slot ${row.sl_no}`} from the auction pool?`,
      async () => {
        const { error } = await sb.from("auction_pool").delete().eq("id", row.id);
        if (error) return toast("Couldn't remove: " + error.message, "err");
        await loadPool();
        toast("Removed from the pool", "ok");
      },
      "Remove"
    );
  });

  /* ---- give every unambiguous name match a Player Key ---- */
  $("#btnPoolAutolink") &&
    $("#btnPoolAutolink").addEventListener("click", () => {
      confirmDialog(
        "Give a Player Key to every pool player whose name matches a registration exactly? " +
          "Only unambiguous one-to-one matches are linked, and no existing key is changed. " +
          "Linked players pick up their photo, sex and DUPR from the registration form.",
        async () => {
          const btn = $("#btnPoolAutolink");
          btn.disabled = true;
          const { data, error } = await sb.rpc("auction_pool_autolink");
          btn.disabled = false;
          if (error) return toast(error.message, "err");
          await loadPool();
          toast(
            data ? `Linked ${data} player${data === 1 ? "" : "s"} to their registration` : "No new matches to link",
            data ? "ok" : "info"
          );
        },
        "Link them",
        false
      );
    });

  $("#btnPoolCsv") &&
    $("#btnPoolCsv").addEventListener("click", () => {
      const cols = ["sl_no", "player_key", "name", "category", "base_price", "sex", "age", "dupr", "status", "sold_price"];
      const cell = (v) => {
        const s = String(v ?? "");
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const body = poolFiltered().map((r) => {
        const t = aTeams.find((x) => x.id === r.sold_to_team_id);
        return [...cols.map((c) => cell(r[c])), cell(t ? t.name : "")].join(",");
      });
      const csv = [[...cols, "sold_to"].join(","), ...body].join("\n");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      a.download = `mpl-auction-pool-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    });

  /* ============================================================
     TEAM LOGINS — check current credentials, reset any password
     ============================================================ */
  let aLogins = [];          // rows from auction_team_logins
  let aAuthStatus = {};      // teamId -> "missing" | "unconfirmed" | "ok"
  let loginsRevealed = false;

  const teamUsername = (i) => `Team${i}`;
  const teamEmail = (i) => `team${i}@${AUC.TEAM_EMAIL_DOMAIN}`;
  const loginKey = () => $("#aucLoginKey").value.trim();
  const keyLooksValid = (k) => k.startsWith("sb_secret_") || k.startsWith("eyJ");

  /* readable password: word + 4 digits, easy to type, not guessable across teams */
  const PW_WORDS = [
    "Dink", "Rally", "Volley", "Smash", "Lob", "Ace", "Drive", "Slice",
    "Spin", "Serve", "Court", "NetPlay", "Kitchen", "Paddle", "Baseline", "Topspin",
    "Backhand", "Forehand", "Poach", "Stack", "Erne", "Flick", "Reset", "Punch",
  ];
  function makePassword(used) {
    for (let tries = 0; tries < 200; tries++) {
      const w = PW_WORDS[Math.floor(Math.random() * PW_WORDS.length)];
      const n = Math.floor(1000 + Math.random() * 9000);
      const pw = `${w}${n}`;
      if (!used.has(pw)) { used.add(pw); return pw; }
    }
    return `Pickle${Date.now().toString().slice(-4)}`;
  }

  /* password shown for a team — the database is the only source of truth */
  function passwordFor(i) {
    const row = aLogins.find((l) => l.team_id === i);
    return row ? row.password : "";
  }

  async function loadLogins() {
    const { data, error } = await sb.from("auction_team_logins").select("*").order("team_id");
    aLogins = error ? [] : data || [];
    renderLogins();
  }

  function renderLogins() {
    const count = AUC.TEAM_COUNT || 16;
    $("#aucLoginCount").textContent = count;
    const mask = (p) => (loginsRevealed ? p : "•".repeat(Math.min(p.length, 10)));

    let html = "";
    for (let i = 1; i <= count; i++) {
      const pw = passwordFor(i) || "—  not set yet";
      const st = aAuthStatus[i];
      const team = aTeams.find((t) => t.id === i);
      const linked = team && team.auth_user_id;
      const badge =
        st === "ok"
          ? `<span class="lg-badge ok">active</span>`
          : st === "unconfirmed"
          ? `<span class="lg-badge warn">email unconfirmed</span>`
          : st === "missing"
          ? `<span class="lg-badge bad">not created</span>`
          : linked
          ? `<span class="lg-badge ok">linked</span>`
          : `<span class="lg-badge">unknown</span>`;

      html += `<tr data-login="${i}">
        <td><b>${teamUsername(i)}</b><div class="sub">${esc(teamEmail(i))}</div></td>
        <td><code class="lg-pw" data-pw="${i}">${esc(mask(pw))}</code></td>
        <td>${badge}</td>
        <td>
          <div class="lg-reset">
            <input type="text" class="lg-input" data-newpw="${i}" placeholder="new password" />
            <button class="btn-mini" data-login-reset="${i}">Reset</button>
          </div>
        </td>
      </tr>`;
    }
    $("#aucLoginBody").innerHTML = html;
    $("#btnLoginReveal").textContent = loginsRevealed ? "🙈 Hide passwords" : "👁 Show passwords";
  }

  /* persist a password to the staff-only table */
  async function storePassword(i, pw) {
    return sb.from("auction_team_logins").upsert({
      team_id: i,
      username: teamUsername(i),
      email: teamEmail(i),
      password: pw,
      updated_at: new Date().toISOString(),
    });
  }

  /* create-or-reset one team's auth account, link it, and record the password */
  async function applyLogin(key, i, pw) {
    const email = teamEmail(i);
    const existing = await findAuthUser(key, email);
    let uid;
    if (existing) {
      const r = await adminApi(key, `/auth/v1/admin/users/${existing.id}`, {
        method: "PUT",
        body: JSON.stringify({ password: pw, email_confirm: true }),
      });
      if (!r.ok) throw new Error(`Team ${i}: ${(await r.json()).msg || r.status}`);
      uid = existing.id;
    } else {
      const r = await adminApi(key, "/auth/v1/admin/users", {
        method: "POST",
        body: JSON.stringify({ email, password: pw, email_confirm: true }),
      });
      if (!r.ok) throw new Error(`Team ${i}: ${(await r.json()).msg || r.status}`);
      uid = (await r.json()).id;
    }
    const { error } = await sb.from("auction_teams").update({ auth_user_id: uid }).eq("id", i);
    if (error) throw new Error(`Team ${i} link failed: ${error.message}`);
    const { error: e2 } = await storePassword(i, pw);
    if (e2) throw new Error(`Team ${i} credential save failed: ${e2.message}`);
    aAuthStatus[i] = "ok";
  }

  /* ---- check every login against Supabase Auth ---- */
  $("#btnLoginCheck").addEventListener("click", async () => {
    const btn = $("#btnLoginCheck");
    const key = loginKey();
    await loadLogins();
    if (!keyLooksValid(key)) {
      alertBox(
        $("#aucLoginAlert"),
        "Paste the Supabase secret key above to check whether each account really exists. " +
          "Stored passwords are shown below regardless."
      );
      return;
    }
    busy(btn, true);
    try {
      const count = AUC.TEAM_COUNT || 16;
      for (let i = 1; i <= count; i++) {
        const u = await findAuthUser(key, teamEmail(i));
        aAuthStatus[i] = !u ? "missing" : u.email_confirmed_at || u.confirmed_at ? "ok" : "unconfirmed";
      }
      const missing = Object.values(aAuthStatus).filter((s) => s === "missing").length;
      $("#aucLoginAlert").classList.remove("show");
      toast(missing ? `${missing} login(s) not created yet` : "All team logins are active", missing ? "info" : "ok");
      renderLogins();
    } catch (err) {
      alertBox($("#aucLoginAlert"), err.message || String(err));
    } finally {
      busy(btn, false);
    }
  });

  /* ---- reset one team ---- */
  document.addEventListener("click", async (e) => {
    const rst = e.target.closest("[data-login-reset]");
    if (!rst) return;
    const i = Number(rst.dataset.loginReset);
    const key = loginKey();
    if (!keyLooksValid(key))
      return alertBox($("#aucLoginAlert"), "Paste the Supabase secret key above before resetting a password.");
    const input = $(`[data-newpw="${i}"]`);
    const pw = (input.value || "").trim() || passwordFor(i);
    if (!pw || pw.length < 6)
      return alertBox(
        $("#aucLoginAlert"),
        "Type a new password (at least 6 characters) for this team first."
      );
    rst.disabled = true;
    try {
      await applyLogin(key, i, pw);
      input.value = "";
      await loadLogins();
      toast(`${teamUsername(i)} password reset`, "ok");
      $("#aucLoginAlert").classList.remove("show");
    } catch (err) {
      alertBox($("#aucLoginAlert"), err.message || String(err));
    } finally {
      rst.disabled = false;
    }
  });

  /* ---- create / reset all 16 ---- */
  /* Has anything actually happened yet? Used to lock off the actions that are
     only ever safe before the first player goes under the hammer. */
  function auctionHasBegun() {
    return (
      aLots.some((l) => l.status === "sold") ||
      aTeams.some((t) => Number(t.purse_spent) > 0)
    );
  }

  $("#btnLoginApplyAll").addEventListener("click", () => {
    const key = loginKey();
    if (!keyLooksValid(key))
      return alertBox($("#aucLoginAlert"), "Paste the Supabase secret key above first.");
    // This resets every captain's password, and it sits a few pixels from the
    // auction controls. Once players have been sold there is no legitimate
    // reason to press it, and a mis-click would lock all sixteen captains out
    // in the middle of the room.
    if (auctionHasBegun())
      return alertBox(
        $("#aucLoginAlert"),
        "The auction has already started — resetting the logins now would sign every captain out. " +
          "Reset the auction first if you really need to re-issue passwords."
      );
    confirmDialog(
      "Create or reset all 16 captain logins to the passwords shown below? Captains using an old password will be signed out.",
      async () => {
        const btn = $("#btnLoginApplyAll");
        btn.disabled = true;
        try {
          const count = AUC.TEAM_COUNT || 16;
          const used = new Set(aLogins.map((l) => l.password));
          for (let i = 1; i <= count; i++) {
            await applyLogin(key, i, passwordFor(i) || makePassword(used));
          }
          await loadLogins();
          loadAuction();
          $("#aucLoginAlert").classList.remove("show");
          toast(`All ${count} captain logins are ready`, "ok");
        } catch (err) {
          alertBox($("#aucLoginAlert"), err.message || String(err));
        } finally {
          btn.disabled = false;
        }
      },
      "Create logins",
      false
    );
  });

  /* ---- generate fresh passwords AND push them to Auth in one step ----
     These two must never drift apart: a password stored here but not
     pushed to auth.users is one the console displays, the organiser hands
     out, and the captain cannot log in with. */
  $("#btnLoginRandom").addEventListener("click", () => {
    const key = loginKey();
    if (!keyLooksValid(key))
      return alertBox(
        $("#aucLoginAlert"),
        "Paste the Supabase secret key above first — new passwords have to be pushed to the captains' accounts, not just saved here."
      );
    confirmDialog(
      "Generate a brand-new password for all 16 teams and apply it to their accounts right away? Captains using an old password will be signed out.",
      async () => {
        const btn = $("#btnLoginRandom");
        btn.disabled = true;
        const count = AUC.TEAM_COUNT || 16;
        const used = new Set();
        try {
          for (let i = 1; i <= count; i++) {
            await applyLogin(key, i, makePassword(used));
          }
          await loadLogins();
          loginsRevealed = true;
          renderLogins();
          loadAuction();
          $("#aucLoginAlert").classList.remove("show");
          toast(`New passwords generated and applied to all ${count} accounts`, "ok");
        } catch (err) {
          await loadLogins();
          renderLogins();
          alertBox(
            $("#aucLoginAlert"),
            "Stopped part-way: " + (err.message || String(err)) +
              " — press “Create / reset all 16” to finish pushing the passwords shown below."
          );
        } finally {
          btn.disabled = false;
        }
      },
      "Generate & apply",
      false
    );
  });

  $("#btnLoginReveal").addEventListener("click", () => {
    loginsRevealed = !loginsRevealed;
    renderLogins();
  });

  function loginLines() {
    const count = AUC.TEAM_COUNT || 16;
    const out = ["Monsoon Pickle League — Team Auction", "https://monsoonpickleauction.vercel.app", "", "USERNAME   PASSWORD"];
    for (let i = 1; i <= count; i++) out.push(`${teamUsername(i).padEnd(10)} ${passwordFor(i) || "(not set)"}`);
    return out.join("\n");
  }

  $("#btnLoginCopy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(loginLines());
      toast("Credentials copied to clipboard", "ok");
    } catch {
      loginsRevealed = true;
      renderLogins();
      toast("Clipboard blocked — passwords revealed below instead", "info");
    }
  });

  $("#btnLoginCsv").addEventListener("click", () => {
    const count = AUC.TEAM_COUNT || 16;
    const rows = ["username,email,password"];
    for (let i = 1; i <= count; i++) rows.push(`${teamUsername(i)},${teamEmail(i)},${passwordFor(i)}`);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([rows.join("\n")], { type: "text/csv" }));
    a.download = `mpl-team-logins-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });





  /* ============================================================
     MATCH DAY — the team sheets desk and the scoreboard.
     Both tabs run off the same three tables, so the fixture rail,
     the tie lookup and the format labels are shared by the pair.
     ============================================================ */
  let mdTies = [];          // all 31 ties, in sort_order
  let mdFormat = [];        // tournament_format, slots 1..5
  let mdFormatLoaded = false;

  const mdSide = (t, side) =>
    tourNameOf(side === "home" ? t.home_team_id : t.away_team_id) ||
    (side === "home" ? t.home_label : t.away_label) ||
    "To be decided";

  const mdPhase = (t) =>
    t.phase === "group"
      ? `Group ${t.group_code} R${t.round}`
      : t.phase === "qf"
      ? "Quarter-final"
      : t.phase === "sf"
      ? "Semi-final"
      : "The final";

  const mdSeated = (t) => t.home_team_id != null && t.away_team_id != null;

  // The organiser's clock is the venue clock. FMT.timeOf prints 9:00 AM for the
  // poster; a submission stamp wants the flat 24-hour form so two of them can
  // be compared at a glance.
  const IST_HM = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const istHM = (iso) => (iso ? IST_HM.format(new Date(iso)) : "—");

  function mmss(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }

  /* Teams and fixtures are shared with the Tournament tab; the format table
     cannot change during the day, so it is fetched once and kept. */
  async function mdLoadCore() {
    const [ti, tt, fm] = await Promise.all([
      sb.from("tournament_ties").select("*").order("sort_order"),
      squadTeams.length
        ? Promise.resolve({ data: squadTeams })
        : sb.from("auction_teams").select("id,name,captain_name,group_code,group_rank").order("id"),
      mdFormatLoaded
        ? Promise.resolve({ data: mdFormat })
        : sb.from("tournament_format").select("*").order("slot"),
    ]);
    if (tt.data && tt.data.length) squadTeams = tt.data;
    if (fm.data && fm.data.length) {
      mdFormat = fm.data;
      mdFormatLoaded = true;
    }
    if (ti.error) return ti.error;
    mdTies = ti.data || [];
    // The five slots must exist even if tournament_format was never seeded,
    // or the score sheet would render zero rows and look broken.
    if (!mdFormat.length)
      mdFormat = [1, 2, 3, 4, 5].map((slot) => ({
        slot,
        label: `Match ${slot}`,
        note: "",
        kind: slot === 3 ? "singles" : "doubles",
      }));
    return null;
  }

  /* One fixture rail, used by both tabs. `badgeFor` decides the chip on the
     right and any state class (an open window, a finished tie). */
  function mdRail(list, selectedId, attr, badgeFor) {
    return list
      .map((t) => {
        const b = (badgeFor && badgeFor(t)) || {};
        return `<button type="button" class="md-fx${t.id === selectedId ? " on" : ""}${
          b.cls || ""
        }" ${attr}="${t.id}">
          <span class="md-fx-top">
            <b>${esc(FMT.timeOf(t.starts_at))}</b>
            <span class="md-fx-court">${t.court ? "Court " + t.court : "Court TBC"}</span>
            ${b.html || ""}
          </span>
          <span class="md-fx-tag">${esc(mdPhase(t))}</span>
          <span class="md-fx-team">${esc(mdSide(t, "home"))}</span>
          <span class="md-fx-team">${esc(mdSide(t, "away"))}</span>
        </button>`;
      })
      .join("");
  }

  function mdTieHead(t) {
    return `<header class="md-head">
      <p class="md-kick">${esc(mdPhase(t))} · Tie ${t.id}${
      t.court ? " · Court " + t.court : ""
    }</p>
      <h3 class="md-title"><span>${esc(mdSide(t, "home"))}</span><i>v</i><span>${esc(
      mdSide(t, "away")
    )}</span></h3>
      <p class="md-when">${esc(FMT.windowOf(t.starts_at, t.ends_at))}</p>
    </header>`;
  }

  /* ------------------------------------------------------------
     TAB: TEAM SHEETS — open the window, watch both line-ups land
     ------------------------------------------------------------ */
  let shBoard = [];         // sheet_board() rows, both sides of every tie
  let shTie = null;         // selected tie id
  let shMinutes = 15;
  let shTimer = null;       // the one and only countdown interval
  let shLive = false;
  let shSoon = null;

  async function loadSheets() {
    const err = await mdLoadCore();
    if (err) return shFail("Couldn't load the fixtures: " + err.message);

    const { data, error } = await sb.rpc("sheet_board");
    if (error) return shFail(shBoardError(error));
    shBoard = data || [];
    $("#shAlert").classList.remove("show");
    renderSheets();
    startSheetClock();
    startSheetRealtime();
  }

  function shFail(msg) {
    alertBox($("#shAlert"), msg);
    $("#shFixtures").innerHTML = "";
    $("#shPanel").innerHTML = "";
    $("#shEmpty").hidden = true;
  }

  // sheet_board() is staff-gated inside the function body, so a captain gets an
  // empty set rather than an error. A missing function or a denied call is what
  // actually shows up here, and both deserve plain words.
  function shBoardError(error) {
    const m = error.message || String(error);
    if (/does not exist|schema cache|not find the function/i.test(m))
      return "The match-day functions aren't installed — run supabase/match-day-ops.sql in the Supabase SQL editor.";
    if (/permission|denied|policy|staff/i.test(m))
      return "This account isn't on the tournament staff list, so the team sheets are sealed to it. Ask the organiser to add it.";
    return "Couldn't load the team sheets: " + m;
  }

  const shFor = (tieId, teamId) =>
    shBoard.find((s) => s.tie_id === tieId && s.team_id === teamId);

  function shBadge(t) {
    const sheets = shBoard.filter((s) => s.tie_id === t.id);
    const done = sheets.filter((s) => s.status === "submitted").length;
    const now = Date.now();
    const open = sheets.some((s) => s.status === "open" && new Date(s.deadline).getTime() > now);
    const late = sheets.some((s) => s.status === "open" && new Date(s.deadline).getTime() <= now);
    return {
      cls: open ? " is-open" : late ? " is-late" : "",
      html: `<span class="md-fx-badge${done === 2 ? " in" : ""}">${done}/2${
        done === 2 ? " in" : ""
      }</span>`,
    };
  }

  function renderSheets() {
    const q = ($("#shQ").value || "").trim().toLowerCase();
    const g = $("#shGroup").value || "";
    const seated = mdTies.filter(mdSeated);
    const list = seated.filter((t) => {
      if (g && t.group_code !== g) return false;
      if (!q) return true;
      return `${mdSide(t, "home")} ${mdSide(t, "away")}`.toLowerCase().includes(q);
    });

    $("#shEmpty").hidden = list.length > 0;
    $("#shEmpty").textContent = seated.length
      ? "No fixtures match that search."
      : "No fixtures with both teams known yet — seat the knockouts on the Scoreboard tab.";

    if (shTie != null && !list.some((t) => t.id === shTie) && !seated.some((t) => t.id === shTie))
      shTie = null;
    if (shTie == null && list.length) shTie = list[0].id;

    const openNow = shBoard.filter(
      (s) => s.status === "open" && new Date(s.deadline).getTime() > Date.now()
    ).length;
    $("#shHint").textContent = openNow
      ? `${openNow} sheet${openNow === 1 ? "" : "s"} open right now`
      : "Open a 15-minute window and watch both line-ups land";

    $("#shFixtures").innerHTML = mdRail(list, shTie, "data-sh-tie", shBadge);
    renderSheetPanel();
  }

  function shState(s) {
    if (!s) return { cls: "idle", html: "Not opened yet" };
    if (s.status === "submitted")
      return { cls: "in", html: `Submitted ${esc(istHM(s.submitted_at))}` };
    if (s.status === "void") return { cls: "shut", html: "Window closed" };
    const left = new Date(s.deadline).getTime() - Date.now();
    if (left <= 0) return { cls: "late", html: "Missed the deadline" };
    return {
      cls: "open",
      html: `Open — <span class="sh-clock${left < 120000 ? " urgent" : ""}" data-deadline="${esc(
        s.deadline
      )}">${mmss(left)}</span> left`,
    };
  }

  function shLineup(s) {
    const picks = Array.isArray(s && s.picks) ? s.picks : [];
    if (!picks.length)
      return `<p class="sh-none">${
        s && s.status === "open" ? "Waiting on the captain." : "No line-up filed."
      }</p>`;
    return (
      `<ol class="sh-slots">` +
      mdFormat
        .map((f) => {
          const on = picks
            .filter((p) => p.slot === f.slot)
            .sort((a, b) => a.position - b.position);
          const trump = s.trump_slot === f.slot;
          return `<li class="sh-slot${trump ? " is-trump" : ""}">
            <span class="sh-no">${f.slot}</span>
            <div class="sh-slot-main">
              <p class="sh-slot-label">${esc(f.label)}${
            trump ? `<span class="sh-trump">Trump</span>` : ""
          }</p>
              <p class="sh-players">${
                on
                  .map(
                    (p) =>
                      `<span class="sh-player"><i class="sq-cat c-${esc(p.category)}">${esc(
                        p.category
                      )}</i>${esc(p.player_name)}</span>`
                  )
                  .join("") || `<span class="sh-none">—</span>`
              }</p>
            </div>
          </li>`;
        })
        .join("") +
      `</ol>`
    );
  }

  function shCard(t, side) {
    const teamId = side === "home" ? t.home_team_id : t.away_team_id;
    const s = shFor(t.id, teamId);
    const st = shState(s);
    return `<article class="sh-card is-${st.cls}">
      <header class="sh-card-head">
        <span class="sh-side">${side}</span>
        <h4 class="sh-team">${esc(tourNameOf(teamId) || "—")}</h4>
        <p class="sh-state">${st.html}</p>
        ${
          s && s.filed_by_staff
            ? `<p class="sh-bystaff">filed by the organiser</p>`
            : ""
        }
      </header>
      <div class="sh-body">${shLineup(s)}</div>
      <footer class="sh-card-foot">
        <button type="button" class="btn-mini" data-sh-act="reset-team" data-sh-team="${teamId}">
          Reset this team
        </button>
      </footer>
    </article>`;
  }

  function renderSheetPanel() {
    const host = $("#shPanel");
    const t = mdTies.find((x) => x.id === shTie);
    if (!t) {
      host.innerHTML = `<p class="md-idle">Pick a fixture on the left to open its line-up window.</p>`;
      return;
    }
    host.innerHTML = `<div class="panel md-panel">
      ${mdTieHead(t)}
      <div class="md-actions">
        <label class="md-mins">
          <span>Minutes</span>
          <input type="number" id="shMinutes" min="1" max="240" step="1" value="${shMinutes}" />
        </label>
        <button type="button" class="btn-primary sm" data-sh-act="open">
          <span class="spin" aria-hidden="true"></span><span class="btn-label">Open both sheets</span>
        </button>
        <button type="button" class="btn-mini" data-sh-act="reset">Reset both</button>
        <button type="button" class="btn-mini danger" data-sh-act="close">Close the window</button>
      </div>
      <div class="sh-cards">${shCard(t, "home")}${shCard(t, "away")}</div>
    </div>`;
  }

  /* One interval for the whole tab. It only rewrites the digits, so nothing
     the organiser is typing into is rebuilt underneath them. */
  function startSheetClock() {
    if (shTimer) return;
    shTimer = setInterval(tickSheetClocks, 1000);
  }
  function stopSheetClock() {
    if (!shTimer) return;
    clearInterval(shTimer);
    shTimer = null;
  }
  function tickSheetClocks() {
    const clocks = $$(".sh-clock", $("#tab-sheets"));
    if (!clocks.length) return;
    let expired = false;
    clocks.forEach((el) => {
      const left = new Date(el.dataset.deadline).getTime() - Date.now();
      if (left <= 0) {
        expired = true;
        return;
      }
      el.textContent = mmss(left);
      el.classList.toggle("urgent", left < 120000);
    });
    // A window just ran out: repaint so "Open — 00:00 left" becomes the truth,
    // "Missed the deadline". After that there are no clocks left to expire.
    if (expired) renderSheets();
  }

  async function shReload() {
    const { data, error } = await sb.rpc("sheet_board");
    if (error) return;
    shBoard = data || [];
    if (!$("#tab-sheets").hidden) renderSheets();
    if (!$("#tab-scoreboard").hidden) renderScorePanel();
  }

  /* A captain pressing send writes one sheet row and nine pick rows. Firing a
     reload on each would be ten round trips for one submission. */
  function shRefreshSoon() {
    clearTimeout(shSoon);
    shSoon = setTimeout(shReload, 250);
  }

  function startSheetRealtime() {
    if (shLive) return;
    shLive = true;
    try {
      sb.channel("sheets-live")
        .on("postgres_changes", { event: "*", schema: "public", table: "team_sheets" }, shRefreshSoon)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "team_sheet_picks" },
          shRefreshSoon
        )
        .subscribe();
    } catch {
      shLive = false;
    }
  }

  function shReadMinutes() {
    const el = $("#shMinutes");
    const v = el ? Number(el.value) : shMinutes;
    if (!Number.isFinite(v) || v < 1 || v > 240) return null;
    return Math.round(v);
  }

  document.addEventListener("input", (e) => {
    if (e.target.id !== "shMinutes") return;
    const v = Number(e.target.value);
    if (Number.isFinite(v) && v >= 1 && v <= 240) shMinutes = Math.round(v);
  });

  ["shQ", "shGroup"].forEach((id) =>
    $("#" + id).addEventListener("input", () => {
      if (!$("#tab-sheets").hidden) renderSheets();
    })
  );
  $("#btnShRefresh").addEventListener("click", () => {
    loadSheets();
    toast("Team sheets refreshed", "info");
  });

  document.addEventListener("click", async (e) => {
    const fx = e.target.closest("[data-sh-tie]");
    if (fx) {
      shTie = Number(fx.dataset.shTie);
      renderSheets();
      return;
    }

    const act = e.target.closest("[data-sh-act]");
    if (!act) return;
    const kind = act.dataset.shAct;
    const t = mdTies.find((x) => x.id === shTie);
    if (!t) return;

    const mins = shReadMinutes();
    if (kind !== "close" && mins == null)
      return toast("The clock must be a whole number of minutes, 1 to 240", "err");

    const teamId = kind === "reset-team" ? Number(act.dataset.shTeam) : null;
    const run = async () => {
      busy(act, true);
      let res;
      if (kind === "open") res = await sb.rpc("sheet_open", { p_tie_id: t.id, p_minutes: mins });
      else if (kind === "reset")
        res = await sb.rpc("sheet_reset", { p_tie_id: t.id, p_team_id: null, p_minutes: mins });
      else if (kind === "close") res = await sb.rpc("sheet_close", { p_tie_id: t.id });
      else res = await sb.rpc("sheet_reset", { p_tie_id: t.id, p_team_id: teamId, p_minutes: mins });
      busy(act, false);
      if (res.error) return toast(res.error.message, "err");
      toast(
        kind === "close"
          ? "Window closed — neither captain can file now"
          : kind === "reset-team"
          ? `${tourNameOf(teamId) || "That team"} reset — ${mins} minutes on the clock`
          : `Both sheets open — ${mins} minutes on the clock`,
        kind === "close" ? "info" : "ok"
      );
      await shReload();
    };

    // Opening and resetting both wipe whatever was filed. That is the point,
    // but not when a captain has already sent a line-up in.
    const wiped = shBoard.filter(
      (s) =>
        s.tie_id === t.id &&
        s.status === "submitted" &&
        (teamId == null || s.team_id === teamId)
    );
    if (kind !== "close" && wiped.length) {
      confirmDialog(
        `${wiped.map((s) => s.team_name).join(" and ")} already filed a line-up. ` +
          `Restarting the clock deletes it and they must pick all nine again. Continue?`,
        run,
        "Restart the clock",
        false
      );
      return;
    }
    run();
  });

  /* ------------------------------------------------------------
     TAB: SCOREBOARD — the league table and the five-match score sheet
     ------------------------------------------------------------ */
  let sbStand = [];
  let sbResults = [];
  let sbTie = null;
  let sbLive = false;
  let sbSoon = null;
  let sbDirty = false;   // a refresh arrived while a score box had focus

  async function loadScoreboard() {
    const err = await mdLoadCore();
    if (err) return alertBox($("#sbAlert"), "Couldn't load the fixtures: " + err.message);

    const [st, rs, bd] = await Promise.all([
      sb.from("public_standings").select("*").order("group_code").order("rank"),
      sb.from("match_results").select("*").order("tie_id").order("slot"),
      sb.rpc("sheet_board"),
    ]);
    if (st.error) alertBox($("#sbAlert"), "Couldn't load the league table: " + st.error.message);
    else $("#sbAlert").classList.remove("show");
    sbStand = st.data || [];
    sbResults = rs.data || [];
    // Only used to preview which match each captain declared as their trump
    // before a score exists; a failure here must not take the tab down.
    if (!bd.error) shBoard = bd.data || [];

    await loadLedger();
    renderScoreboard();
    startScoreRealtime();
  }

  /* ---- the working: one line per match, plus the audit of what was typed ---- */
  let sbLedger = [];
  let sbLedTotals = [];
  let sbAudit = [];

  async function loadLedger() {
    const [lg, tt, au] = await Promise.all([
      sb.from("points_ledger").select("*").order("team_id").order("tie_id").order("slot", { nullsFirst: false }),
      sb.from("points_ledger_totals").select("*").eq("phase", "group"),
      sb.from("score_audit_log").select("*").limit(200),
    ]);
    sbLedger = lg.error ? [] : lg.data || [];
    sbLedTotals = tt.error ? [] : tt.data || [];
    sbAudit = au.error ? [] : au.data || [];
  }

  function renderScoreboard() {
    renderStandings();
    renderScoreRail();
    renderScorePanel();
    renderLedger();
    renderAudit();
  }

  /* The ledger adds up on its own. Showing it agree with the league table is
     the whole point — a silent total nobody can check is worth very little. */
  function renderLedger() {
    const host = $("#sbLedger");
    if (!host) return;

    const sel = $("#ledTeam");
    if (sel && sel.options.length <= 1 && squadTeams.length) {
      sel.insertAdjacentHTML(
        "beforeend",
        squadTeams
          .slice()
          .sort((a, b) => String(a.group_code).localeCompare(String(b.group_code)) || (a.group_rank || 9) - (b.group_rank || 9))
          .map((t) => `<option value="${t.id}">${esc(t.group_code || "?")}${t.group_rank || ""} · ${esc(t.name)}</option>`)
          .join("")
      );
    }

    const pick = sel && sel.value ? Number(sel.value) : null;
    const rows = pick ? sbLedger.filter((r) => r.team_id === pick) : sbLedger;
    $("#ledEmpty").hidden = rows.length > 0;

    // reconcile every team, not only the one on screen
    const disagree = sbLedTotals.filter((t) => {
      const s = sbStand.find((x) => x.team_id === t.team_id);
      return s && Number(s.points) !== Number(t.points);
    });
    const check = $("#ledCheck");
    if (check) {
      check.textContent = !sbLedTotals.length
        ? ""
        : disagree.length
        ? `${disagree.length} team${disagree.length > 1 ? "s" : ""} do not reconcile`
        : `All ${sbLedTotals.length} totals reconcile with the league table`;
      check.classList.toggle("bad", disagree.length > 0);
      check.classList.toggle("good", !disagree.length && sbLedTotals.length > 0);
    }

    if (!rows.length) return void (host.innerHTML = "");

    const byTeam = new Map();
    rows.forEach((r) => {
      if (!byTeam.has(r.team_id)) byTeam.set(r.team_id, []);
      byTeam.get(r.team_id).push(r);
    });

    host.innerHTML = [...byTeam.entries()]
      .map(([id, lines]) => {
        const name = lines[0].team_name;
        const total = lines.reduce((n, l) => n + Number(l.points), 0);
        const tablePts = sbStand.find((s) => s.team_id === id)?.points;
        const agrees = tablePts === undefined || Number(tablePts) === total;
        const body = lines
          .map(
            (l) => `
          <tr class="${Number(l.points) < 0 ? "neg" : ""}">
            <td class="led-tie">${esc(l.group_code ? "G" + l.group_code + " R" + l.round : String(l.phase).toUpperCase())}
              <span>v ${esc(l.opponent_name || "—")}</span></td>
            <td>${esc(l.slot_label)}</td>
            <td class="num">${l.pf === null ? "—" : `${l.pf}–${l.pa}`}</td>
            <td class="led-detail">${esc(l.detail)}</td>
            <td class="num led-pts">${Number(l.points) > 0 ? "+" : ""}${l.points}</td>
          </tr>`
          )
          .join("");
        return `
        <details class="led" ${pick ? "open" : ""}>
          <summary>
            <b>${esc(name)}</b>
            <span class="led-sum">${lines.filter((l) => l.kind === "match").length} matches</span>
            <span class="led-total ${agrees ? "" : "bad"}">${total} pts${
          agrees ? "" : ` · table says ${esc(tablePts)}`
        }</span>
          </summary>
          <div class="table-wrap">
            <table class="led-table">
              <thead><tr><th>Tie</th><th>Match</th><th class="num">Score</th><th>How it scored</th><th class="num">Pts</th></tr></thead>
              <tbody>${body}</tbody>
              <tfoot><tr><td colspan="4">Total</td><td class="num led-pts">${total}</td></tr></tfoot>
            </table>
          </div>
        </details>`;
      })
      .join("");
  }

  function renderAudit() {
    const body = $("#sbAudit");
    if (!body) return;
    $("#auditEmpty").hidden = sbAudit.length > 0;
    const when = (iso) =>
      new Intl.DateTimeFormat("en-IN", {
        timeZone: "Asia/Kolkata", day: "2-digit", month: "short",
        hour: "numeric", minute: "2-digit", hour12: true,
      }).format(new Date(iso));
    const pair = (h, a) => (h === null || h === undefined ? "—" : `${h}–${a}`);

    body.innerHTML = sbAudit
      .map(
        (a) => `
      <tr>
        <td class="aud-when">${esc(when(a.at))}</td>
        <td><span class="aud-tag ${esc(a.action)}">${esc(a.action)}</span></td>
        <td>${esc(a.home_name || "?")} v ${esc(a.away_name || "?")}</td>
        <td>${esc(a.slot_label)}</td>
        <td class="aud-change">${esc(pair(a.old_home, a.old_away))} → ${esc(pair(a.new_home, a.new_away))}</td>
        <td class="aud-by">${esc(a.actor_email || "—")}</td>
      </tr>`
      )
      .join("");
  }

  $("#ledTeam")?.addEventListener("change", renderLedger);

  $("#btnLedCsv")?.addEventListener("click", () => {
    const cell = (v) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = ["team,group,round,opponent,match,score_for,score_against,outcome,match_points,trump_points,points,working"];
    sbLedger.forEach((l) =>
      lines.push(
        [l.team_name, l.group_code, l.round, l.opponent_name, l.slot_label, l.pf, l.pa,
         l.outcome, l.match_points, l.trump_points, l.points, l.detail].map(cell).join(",")
      )
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    a.download = `mpl-points-ledger-${stamp()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  /* ---- the league table, exactly as public_standings ranked it ---- */
  const STD_COLS = [
    ["Group", 0], ["Rank", 0], ["Team", 0],
    ["MP", 1], ["W", 1], ["L", 1], ["PS", 1], ["PC", 1], ["PD", 1], ["Pts", 1],
  ];

  function renderStandings() {
    const host = $("#sbStandings");
    $("#sbStandEmpty").hidden = sbStand.length > 0;
    if (!sbStand.length) {
      host.innerHTML = "";
      $("#sbLegend").innerHTML = stdLegend();
      return;
    }
    host.innerHTML = GROUPS.map((g) => {
      const list = sbStand.filter((r) => r.group_code === g);
      if (!list.length) return "";
      return `<section class="std-block">
        <p class="std-h">Group ${g}</p>
        <div class="std-wrap">
          <table class="std">
            <thead><tr>${STD_COLS.map(
              ([l, num]) => `<th class="${num ? "num" : ""}">${l}</th>`
            ).join("")}</tr></thead>
            <tbody>${list.map(stdRow).join("")}</tbody>
          </table>
        </div>
      </section>`;
    }).join("");
    $("#sbLegend").innerHTML = stdLegend();
  }

  function stdRow(r) {
    // The counters come back as bigints; PostgREST may hand them over as
    // strings, and "10" < "9" would put the wrong two teams through.
    const n = (v) => Number(v ?? 0);
    const rank = n(r.rank);
    const q = rank <= 2;
    const diff = n(r.point_diff);
    return `<tr class="${q ? "is-q" : ""}">
      <td class="std-g">${esc(r.group_code)}</td>
      <td class="num std-rank">${rank}${
      q ? `<span class="std-q" title="Top two qualify for the quarter-finals">Q</span>` : ""
    }</td>
      <td class="std-team"><b>${esc(r.team_name)}</b><span>${esc(r.captain_name || "")}</span></td>
      <td class="num">${n(r.matches_played)}</td>
      <td class="num">${n(r.won)}</td>
      <td class="num">${n(r.lost)}</td>
      <td class="num">${n(r.points_for)}</td>
      <td class="num">${n(r.points_against)}</td>
      <td class="num">${diff > 0 ? "+" : ""}${diff}</td>
      <td class="num std-pts">${n(r.points)}</td>
    </tr>`;
  }

  const stdLegend = () => `
    <ul class="std-legend">
      <li><b>3</b><span>win a match</span></li>
      <li><b>1</b><span>lose by 2 points or less</span></li>
      <li><b>0</b><span>lose by more than 2</span></li>
      <li><b class="red">+2</b><span>clean sweep — all 5 matches of a tie</span></li>
      <li><b class="red">+2</b><span>win the match you trumped</span></li>
      <li><b class="red">−2</b><span>both teams trumped it and you lost</span></li>
      <li><b class="ok">Q</b><span>top two of every group reach the quarter-finals</span></li>
    </ul>`;

  /* ---- the fixture rail: all 31 ties, knockouts included ---- */
  function sbBadge(t) {
    const n = sbResults.filter((r) => r.tie_id === t.id).length;
    if (!n) return { cls: "", html: `<span class="md-fx-badge">0/5</span>` };
    const score = `${t.home_score ?? 0}–${t.away_score ?? 0}`;
    return {
      cls: n === 5 ? " is-done" : " is-open",
      html: `<span class="md-fx-badge ${n === 5 ? "in" : "live"}">${score}${
        n < 5 ? ` · ${n}/5` : ""
      }</span>`,
    };
  }

  function renderScoreRail() {
    const q = ($("#sbQ").value || "").trim().toLowerCase();
    const ph = $("#sbPhase").value || "";
    const list = mdTies.filter((t) => {
      if (ph && t.phase !== ph) return false;
      if (!q) return true;
      return `${mdSide(t, "home")} ${mdSide(t, "away")}`.toLowerCase().includes(q);
    });

    $("#sbEmpty").hidden = list.length > 0;
    $("#sbEmpty").textContent = mdTies.length
      ? "No ties match that search."
      : "No fixtures yet — run supabase/tournament.sql.";

    if (sbTie != null && !mdTies.some((t) => t.id === sbTie)) sbTie = null;
    if (sbTie == null && list.length) sbTie = list[0].id;

    $("#sbFixtures").innerHTML = mdRail(list, sbTie, "data-sb-tie", sbBadge);
  }

  /* ---- one tie: five matches, the running result, the shootout ---- */
  function renderScorePanel() {
    const host = $("#sbPanel");
    const t = mdTies.find((x) => x.id === sbTie);
    if (!t) {
      host.innerHTML = `<p class="md-idle">Pick a tie on the left to record its five matches.</p>`;
      return;
    }
    // Never rebuild a score box under the organiser's fingers — realtime fires
    // on every save, including their own.
    const a = document.activeElement;
    if (a && host.contains(a) && a.matches("input, select")) {
      sbDirty = true;
      return;
    }
    sbDirty = false;

    host.innerHTML = `<div class="panel md-panel">
      ${mdTieHead(t)}
      ${sbSeatRow(t)}
      ${
        mdSeated(t)
          ? `<div class="sc-rows">${mdFormat.map((f) => sbRow(t, f)).join("")}</div>${sbSummary(t)}`
          : `<p class="md-idle">Seat both teams above before scoring this tie.</p>`
      }
    </div>`;
  }

  // The knockout ties carry a poster label ("Winner Group A") until the groups
  // decide who fills them, so the label is the placeholder on the dropdown.
  function sbSeatRow(t) {
    if (t.phase === "group") return "";
    const opts = (sel) =>
      squadTeams
        .map((x) => `<option value="${x.id}"${x.id === sel ? " selected" : ""}>${esc(x.name)}</option>`)
        .join("");
    return `<div class="sc-seat">
      <p class="sc-seat-h">Seat the teams</p>
      <label class="sc-seat-f"><span>Home</span>
        <select data-seat="home"><option value="">${esc(t.home_label || "To be decided")}</option>${opts(
      t.home_team_id
    )}</select></label>
      <label class="sc-seat-f"><span>Away</span>
        <select data-seat="away"><option value="">${esc(t.away_label || "To be decided")}</option>${opts(
      t.away_team_id
    )}</select></label>
      <button type="button" class="btn-mini" data-sc-seat="${t.id}">Seat teams</button>
    </div>`;
  }

  function sbRow(t, f) {
    const r = sbResults.find((x) => x.tie_id === t.id && x.slot === f.slot);
    // Before a score exists the badges preview what the captains declared, so
    // the desk can see the trump coming; after it, they are the stored flags.
    const declared = (teamId) =>
      shBoard.some(
        (s) =>
          s.tie_id === t.id && s.team_id === teamId && s.status === "submitted" && s.trump_slot === f.slot
      );
    const hT = r ? !!r.home_trump : declared(t.home_team_id);
    const aT = r ? !!r.away_trump : declared(t.away_team_id);
    const pend = r ? "" : " pending";
    const why = r ? "" : " — declared on the team sheet, not yet scored";

    const trumps =
      f.kind === "singles"
        ? `<span class="sc-tr none" title="The singles can never be trumped">—</span>`
        : hT || aT
        ? `${
            hT
              ? `<span class="sc-tr home${pend}" title="${esc(mdSide(t, "home"))} trump${esc(why)}">T</span>`
              : ""
          }${
            aT
              ? `<span class="sc-tr away${pend}" title="${esc(mdSide(t, "away"))} trump${esc(why)}">T</span>`
              : ""
          }${
            hT && aT
              ? `<span class="sc-clash" title="Both teams trumped this match — winner +2, loser −2">clash</span>`
              : ""
          }`
        : `<span class="sc-tr none">—</span>`;

    return `<div class="sc-row${r ? " has" : ""}" data-slot="${f.slot}">
      <span class="sc-no">${f.slot}</span>
      <div class="sc-label"><b>${esc(f.label)}</b><span>${esc(f.note || "")}</span></div>
      <div class="sc-scores">
        <label class="sc-side">
          <span class="sc-team">${esc(mdSide(t, "home"))}</span>
          <input type="number" min="0" max="99" step="1" inputmode="numeric"
                 data-sc-home="${f.slot}" value="${r ? r.home_points : ""}"
                 aria-label="${esc(mdSide(t, "home"))} points, match ${f.slot}" />
        </label>
        <span class="sc-dash">–</span>
        <label class="sc-side away">
          <input type="number" min="0" max="99" step="1" inputmode="numeric"
                 data-sc-away="${f.slot}" value="${r ? r.away_points : ""}"
                 aria-label="${esc(mdSide(t, "away"))} points, match ${f.slot}" />
          <span class="sc-team">${esc(mdSide(t, "away"))}</span>
        </label>
      </div>
      <div class="sc-trumps">${trumps}</div>
      <div class="sc-acts">
        <button type="button" class="btn-mini" data-sc-save="${f.slot}">Save</button>
        <button type="button" class="btn-mini ghost" data-sc-clear="${f.slot}"${
      r ? "" : " disabled"
    }>Clear</button>
      </div>
    </div>`;
  }

  function sbSummary(t) {
    const rs = sbResults.filter((x) => x.tie_id === t.id);
    const h = rs.filter((x) => x.home_points > x.away_points).length;
    const a = rs.filter((x) => x.away_points > x.home_points).length;
    const home = mdSide(t, "home");
    const away = mdSide(t, "away");

    let verdict;
    let shoot = "";
    if (rs.length < 5) {
      const left = 5 - rs.length;
      verdict = `<p class="sc-verdict wait">${left} match${
        left === 1 ? "" : "es"
      } still to score.</p>`;
    } else if (h !== a) {
      verdict = `<p class="sc-verdict win">${esc(h > a ? home : away)} win the tie ${Math.max(
        h,
        a
      )}–${Math.min(h, a)}.</p>`;
    } else {
      // Five matches cannot split 2.5–2.5, so a level tie means at least one
      // match finished dead level. The shootout is the only way out.
      const w = t.shootout_winner_team_id;
      verdict = w
        ? `<p class="sc-verdict win">Level at ${h}–${a} — ${esc(
            tourNameOf(w) || "the shootout winner"
          )} take it on the 7-point Open Doubles shootout.</p>`
        : `<p class="sc-verdict warn">Level at ${h}–${a}. A 7-point Open Doubles shootout decides this tie.</p>`;
      shoot = `<div class="sc-shoot">
        <label for="sbShoot">7-point Open Doubles shootout</label>
        <select id="sbShoot" data-sc-shoot="${t.id}">
          <option value="">— who won the shootout? —</option>
          <option value="${t.home_team_id}"${
        w === t.home_team_id ? " selected" : ""
      }>${esc(home)}</option>
          <option value="${t.away_team_id}"${
        w === t.away_team_id ? " selected" : ""
      }>${esc(away)}</option>
        </select>
      </div>`;
    }

    return `<div class="sc-summary">
      <p class="sc-line"><b>${esc(home)}</b> <em>${h}</em>–<em>${a}</em> <b>${esc(
      away
    )}</b> <span>(matches won)</span></p>
      ${verdict}${shoot}
    </div>`;
  }

  async function sbReload() {
    const [st, rs, ti] = await Promise.all([
      sb.from("public_standings").select("*").order("group_code").order("rank"),
      sb.from("match_results").select("*").order("tie_id").order("slot"),
      sb.from("tournament_ties").select("*").order("sort_order"),
    ]);
    if (st.data) sbStand = st.data;
    if (rs.data) sbResults = rs.data;
    if (ti.data) mdTies = ti.data;
    // the working and the audit move with the score that caused them
    await loadLedger();
    if (!$("#tab-scoreboard").hidden) renderScoreboard();
    if (!$("#tab-sheets").hidden) renderSheets();
  }

  function sbRefreshSoon() {
    clearTimeout(sbSoon);
    sbSoon = setTimeout(sbReload, 250);
  }

  function startScoreRealtime() {
    if (sbLive) return;
    sbLive = true;
    try {
      sb.channel("scoreboard-live")
        .on("postgres_changes", { event: "*", schema: "public", table: "match_results" }, sbRefreshSoon)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "tournament_ties" },
          sbRefreshSoon
        )
        .subscribe();
    } catch {
      sbLive = false;
    }
  }

  // The guard in renderScorePanel skips the repaint while a box has focus;
  // this is where the skipped repaint is paid back.
  $("#sbPanel").addEventListener("focusout", () => {
    setTimeout(() => {
      const a = document.activeElement;
      if (a && $("#sbPanel").contains(a)) return;
      if (sbDirty) renderScorePanel();
    }, 0);
  });

  ["sbQ", "sbPhase"].forEach((id) =>
    $("#" + id).addEventListener("input", () => {
      if (!$("#tab-scoreboard").hidden) {
        renderScoreRail();
        renderScorePanel();
      }
    })
  );

  function sbScoreInputs(slot) {
    const host = $("#sbPanel");
    return [$(`[data-sc-home="${slot}"]`, host), $(`[data-sc-away="${slot}"]`, host)];
  }

  async function sbSave(slot, btn) {
    const t = mdTies.find((x) => x.id === sbTie);
    if (!t) return;
    const [hi, ai] = sbScoreInputs(slot);
    if (!hi || !ai) return;
    const h = Number(hi.value);
    const a = Number(ai.value);
    const bad = (v, raw) => raw === "" || !Number.isInteger(v) || v < 0 || v > 99;
    if (bad(h, hi.value.trim()) || bad(a, ai.value.trim()))
      return toast("Both scores are needed, as whole numbers from 0 to 99", "err");

    if (btn) busy(btn, true);
    const { data, error } = await sb.rpc("result_set", {
      p_tie_id: t.id,
      p_slot: slot,
      p_home: h,
      p_away: a,
    });
    if (btn) busy(btn, false);
    if (error) return toast(error.message, "err");

    // Paint the saved row from the server's own copy, then let the reload
    // rebuild the table behind it.
    const row = Array.isArray(data) ? data[0] : data;
    if (row) {
      const i = sbResults.findIndex((x) => x.tie_id === t.id && x.slot === slot);
      if (i > -1) sbResults[i] = row;
      else sbResults.push(row);
    }
    toast(`Match ${slot} saved — ${h}–${a}`, "ok");
    hi.blur();
    ai.blur();
    sbReload();
  }

  document.addEventListener("click", async (e) => {
    const fx = e.target.closest("[data-sb-tie]");
    if (fx) {
      sbTie = Number(fx.dataset.sbTie);
      sbDirty = false;
      renderScoreRail();
      renderScorePanel();
      return;
    }

    const save = e.target.closest("[data-sc-save]");
    if (save) return sbSave(Number(save.dataset.scSave), save);

    const clear = e.target.closest("[data-sc-clear]");
    if (clear) {
      const slot = Number(clear.dataset.scClear);
      const t = mdTies.find((x) => x.id === sbTie);
      if (!t) return;
      busy(clear, true);
      const { error } = await sb.rpc("result_clear", { p_tie_id: t.id, p_slot: slot });
      busy(clear, false);
      if (error) return toast(error.message, "err");
      sbResults = sbResults.filter((x) => !(x.tie_id === t.id && x.slot === slot));
      toast(`Match ${slot} cleared`, "info");
      sbReload();
      return;
    }

    const seat = e.target.closest("[data-sc-seat]");
    if (seat) {
      const id = Number(seat.dataset.scSeat);
      const host = $("#sbPanel");
      const home = $('[data-seat="home"]', host).value;
      const away = $('[data-seat="away"]', host).value;
      if (home && away && home === away) return toast("A team cannot play itself", "err");
      busy(seat, true);
      const { error } = await sb.rpc("tie_set_teams", {
        p_tie_id: id,
        p_home: home ? Number(home) : null,
        p_away: away ? Number(away) : null,
      });
      busy(seat, false);
      if (error) return toast(error.message, "err");
      toast("Teams seated", "ok");
      sbReload();
      return;
    }
  });

  document.addEventListener("change", async (e) => {
    const sel = e.target.closest("[data-sc-shoot]");
    if (!sel) return;
    const id = Number(sel.dataset.scShoot);
    const winner = sel.value ? Number(sel.value) : null;
    // Plain update: staff RLS on tournament_ties allows it, and the table's own
    // trigger re-decides the tie from the new shootout winner.
    const { error } = await sb
      .from("tournament_ties")
      .update({ shootout_winner_team_id: winner })
      .eq("id", id);
    if (error) return toast(error.message, "err");
    toast(winner ? `${tourNameOf(winner)} win the shootout` : "Shootout winner cleared", "ok");
    sbReload();
  });

  // Enter commits the row the organiser is on, the way a scorer expects.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const el = e.target.closest && e.target.closest("[data-sc-home], [data-sc-away]");
    if (!el) return;
    e.preventDefault();
    sbSave(Number(el.dataset.scHome || el.dataset.scAway), null);
  });

  /* ---- CSV: the table, and every score recorded so far ---- */
  const csvCell = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  function csvDownload(lines, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  $("#btnSbStandCsv").addEventListener("click", () => {
    if (!sbStand.length) return toast("No standings to export yet", "info");
    const lines = ["group,rank,team,captain,ties_played,matches_played,won,lost,points_for,points_against,point_diff,points"];
    sbStand.forEach((r) =>
      lines.push(
        [r.group_code, r.rank, r.team_name, r.captain_name, r.ties_played, r.matches_played,
          r.won, r.lost, r.points_for, r.points_against, r.point_diff, r.points]
          .map(csvCell)
          .join(",")
      )
    );
    csvDownload(lines, `mpl-standings-${stamp()}.csv`);
  });

  $("#btnSbResCsv").addEventListener("click", () => {
    if (!sbResults.length) return toast("No scores recorded yet", "info");
    const byTie = new Map(mdTies.map((t) => [t.id, t]));
    const lines = ["tie,phase,group,round,court,slot,match,home,home_points,away_points,away,home_trump,away_trump"];
    sbResults.forEach((r) => {
      const t = byTie.get(r.tie_id);
      const f = mdFormat.find((x) => x.slot === r.slot);
      if (!t) return;
      lines.push(
        [t.id, t.phase, t.group_code || "", t.round || "", t.court || "", r.slot,
          f ? f.label : "", mdSide(t, "home"), r.home_points, r.away_points, mdSide(t, "away"),
          r.home_trump ? "T" : "", r.away_trump ? "T" : ""]
          .map(csvCell)
          .join(",")
      );
    });
    csvDownload(lines, `mpl-results-${stamp()}.csv`);
  });


  window.addEventListener("DOMContentLoaded", boot);
})();
