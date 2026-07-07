/* ============================================================
   MPL ADMIN — organiser dashboard
   Supabase auth + registrations table with filters & CSV export
   ============================================================ */
(() => {
  "use strict";

  const CFG = window.MPL_CONFIG;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const LIVE = Boolean(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
  let sb = null;
  let rows = [];

  const authAlert = $("#authAlert");

  function alertMsg(el, msg) {
    el.textContent = msg;
    el.classList.remove("show");
    void el.offsetWidth;
    el.classList.add("show");
  }

  /* ---------------- auth ---------------- */
  async function boot() {
    if (!LIVE || !window.supabase) {
      alertMsg(
        authAlert,
        "Supabase isn't configured. Add SUPABASE_URL and SUPABASE_ANON_KEY in js/config.js first (see README)."
      );
      $("#btnLogin").disabled = true;
      return;
    }
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
    const { data } = await sb.auth.getSession();
    if (data.session) enterDash();
  }

  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!sb) return;
    const btn = $("#btnLogin");
    btn.disabled = true;
    btn.classList.add("busy");
    const { error } = await sb.auth.signInWithPassword({
      email: $("#adminEmail").value.trim(),
      password: $("#adminPass").value,
    });
    btn.disabled = false;
    btn.classList.remove("busy");
    if (error) return alertMsg(authAlert, error.message);
    enterDash();
  });

  $("#btnLogout").addEventListener("click", async () => {
    await sb.auth.signOut();
    location.reload();
  });

  function enterDash() {
    $("#authWrap").hidden = true;
    $("#dash").hidden = false;
    // category filter options from config
    const fCat = $("#fCat");
    CFG.EVENT.categories.forEach((c) => {
      const o = document.createElement("option");
      o.textContent = c.label;
      fCat.appendChild(o);
    });
    load();
  }

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
  }
  $("#btnRefresh").addEventListener("click", load);

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
        const hay = `${r.full_name} ${r.phone} ${r.reg_code} ${r.partner_name || ""} ${r.email || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }
  ["q", "fCat", "fPay", "fStatus"].forEach((id) =>
    $("#" + id).addEventListener("input", render)
  );

  /* ---------------- render ---------------- */
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  function renderStats() {
    const total = rows.length;
    const online = rows.filter((r) => r.payment_method === "Online").length;
    const verified = rows.filter((r) => r.status === "verified" || r.status === "checked-in").length;
    const pending = rows.filter((r) => r.status === "pending").length;
    $("#stats").innerHTML = `
      <div class="stat"><div class="n red">${total}</div><div class="l">Total entries</div></div>
      <div class="stat"><div class="n">${online}</div><div class="l">Paid online</div></div>
      <div class="stat"><div class="n ok">${verified}</div><div class="l">Verified</div></div>
      <div class="stat"><div class="n">${pending}</div><div class="l">Pending review</div></div>`;
  }

  function render() {
    renderStats();
    const list = filtered();
    $("#emptyMsg").hidden = list.length > 0;
    $("#regBody").innerHTML = list
      .map((r) => {
        const avatar = r.profile_pic_url
          ? `<img class="avatar-sm" src="${esc(r.profile_pic_url)}" alt="" data-zoom="${esc(r.profile_pic_url)}" loading="lazy" />`
          : `<span class="avatar-sm none">🥒</span>`;
        const shot = r.payment_screenshot_url
          ? `<br /><span class="shot-link" data-zoom="${esc(r.payment_screenshot_url)}">view screenshot</span>`
          : "";
        return `<tr data-id="${esc(r.id)}">
          <td><div class="p-cell">${avatar}
            <div><div class="nm">${esc(r.full_name)}</div>
            <div class="code">${esc(r.reg_code)}</div></div></div></td>
          <td>${esc(r.phone)}${r.email ? `<div class="sub">${esc(r.email)}</div>` : ""}</td>
          <td>${esc(r.category)}${r.partner_name ? `<div class="partner">w/ ${esc(r.partner_name)}</div>` : ""}</td>
          <td>${r.dupr != null ? Number(r.dupr).toFixed(3) : "<span class='sub'>—</span>"}</td>
          <td><b>${esc(r.jersey_size)}</b><div class="sub">“${esc(r.jersey_name)}”</div></td>
          <td><span class="pay-chip ${r.payment_method === "Online" ? "online" : ""}">${esc(r.payment_method)}</span>${shot}</td>
          <td><select class="status s-${esc(r.status)}" data-status="${esc(r.id)}">
            ${["pending", "verified", "checked-in", "rejected"]
              .map((s) => `<option value="${s}" ${s === r.status ? "selected" : ""}>${s}</option>`)
              .join("")}
          </select></td>
        </tr>`;
      })
      .join("");
  }

  /* status updates + image zoom (event delegation) */
  document.addEventListener("change", async (e) => {
    const sel = e.target.closest("select.status");
    if (!sel) return;
    const id = sel.dataset.status;
    const value = sel.value;
    sel.className = `status s-${value}`;
    const { error } = await sb.from("registrations").update({ status: value }).eq("id", id);
    if (error) {
      alert("Couldn't update status: " + error.message);
    } else {
      const row = rows.find((r) => r.id === id);
      if (row) row.status = value;
      renderStats();
    }
  });

  document.addEventListener("click", (e) => {
    const z = e.target.closest("[data-zoom]");
    if (z) {
      $("#lightboxImg").src = z.dataset.zoom;
      $("#lightbox").hidden = false;
      return;
    }
    if (e.target.closest("#lightbox")) $("#lightbox").hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") $("#lightbox").hidden = true;
  });

  /* ---------------- CSV export ---------------- */
  $("#btnCsv").addEventListener("click", () => {
    const cols = [
      "reg_code", "created_at", "full_name", "phone", "email", "gender", "dupr",
      "category", "partner_name", "jersey_size", "jersey_name",
      "payment_method", "status", "profile_pic_url", "payment_screenshot_url",
    ];
    const csvCell = (v) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [
      cols.join(","),
      ...filtered().map((r) => cols.map((c) => csvCell(r[c])).join(",")),
    ].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `mpl-registrations-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  window.addEventListener("DOMContentLoaded", boot);
})();
