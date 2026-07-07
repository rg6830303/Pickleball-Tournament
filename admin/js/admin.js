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

  function enterDash(user) {
    $("#authWrap").hidden = true;
    $("#dash").hidden = false;
    $("#whoami").textContent = user.email;

    // filter + modal option lists from config
    const fCat = $("#fCat");
    const mCat = $("#mCategory");
    CFG.EVENT.categories.forEach((c) => {
      fCat.insertAdjacentHTML("beforeend", `<option>${esc(c)}</option>`);
      mCat.insertAdjacentHTML("beforeend", `<option>${esc(c)}</option>`);
    });
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

    $("#lnkSupabase").href = `https://supabase.com/dashboard/project/${
      new URL(CFG.SUPABASE_URL).hostname.split(".")[0]
    }`;

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
    const cat = $("#fCat").value;
    const pay = $("#fPay").value;
    const st = $("#fStatus").value;
    return rows.filter((r) => {
      if (cat && r.category !== cat) return false;
      if (pay && r.payment_method !== pay) return false;
      if (st && r.status !== st) return false;
      if (q) {
        const hay = `${r.full_name} ${r.phone} ${r.reg_code} ${r.partner_name || ""} ${r.email || ""} ${r.jersey_name || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }
  ["q", "fCat", "fPay", "fStatus"].forEach((id) =>
    $("#" + id).addEventListener("input", render)
  );

  function renderStats() {
    const total = rows.length;
    const online = rows.filter((r) => r.payment_method === "Online").length;
    const verified = rows.filter((r) => r.status === "verified" || r.status === "checked-in").length;
    const pending = rows.filter((r) => r.status === "pending").length;
    const doubles = rows.filter((r) => (r.category || "").includes("Doubles")).length;
    $("#stats").innerHTML = `
      <div class="stat red"><div class="n">${total}</div><div class="l">Total entries</div></div>
      <div class="stat"><div class="n">${online}</div><div class="l">Paid online</div></div>
      <div class="stat ok"><div class="n">${verified}</div><div class="l">Verified</div></div>
      <div class="stat warn"><div class="n">${pending}</div><div class="l">Pending review</div></div>
      <div class="stat"><div class="n">${doubles}</div><div class="l">Doubles entries</div></div>`;
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
          <td>${esc(r.category)}${r.partner_name ? `<div class="partner">w/ ${esc(r.partner_name)}</div>` : ""}</td>
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
    $("#mCategory").value = row?.category || CFG.EVENT.categories[0];
    $("#mPartner").value = row?.partner_name || "";
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
      category: $("#mCategory").value,
      partner_name: $("#mPartner").value.trim() || null,
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
  function confirmDialog(msg, action) {
    $("#confirmMsg").textContent = msg;
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
      "category", "partner_name", "jersey_size", "jersey_name",
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

  window.addEventListener("DOMContentLoaded", boot);
})();
