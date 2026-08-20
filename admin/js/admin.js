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

  function teamCard(t, match) {
    const squad = squadRows
      .filter((r) => r.team_id === t.id)
      .sort((a, b) => a.sort_order - b.sort_order);

    const rows = squad
      .map(
        (p) => `
        <li class="sq-player${match(p.player_name) ? " hit" : ""}">
          <span class="sq-cat c-${esc(p.category)}">${esc(p.category)}</span>
          <span class="sq-name">${esc(p.player_name)}</span>
          ${p.retained ? '<span class="sq-ret" title="Retained player">R</span>' : ""}
        </li>`
      )
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





  window.addEventListener("DOMContentLoaded", boot);
})();
