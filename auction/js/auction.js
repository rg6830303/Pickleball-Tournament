/* ============================================================
   MPL TEAM AUCTION — captain app
   Login → live block → bid → auto wallet deduction → squad
   ============================================================ */
(() => {
  "use strict";

  const CFG = window.MPL_AUCTION_CONFIG;
  const $ = (s, r = document) => r.querySelector(s);
  const LIVE = Boolean(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);

  let sb = null;
  let myTeamId = null;
  let teams = [];
  let lots = [];
  let state = null;
  let bids = [];
  let lastPrice = null;
  let cards = {};          // pool id -> card resolved against the registration
  let openTeam = null;     // team id whose squad is expanded in League Purses

  /* ---------------- helpers ---------------- */
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  const money = (n) =>
    CFG.CURRENCY + Number(n || 0).toLocaleString(CFG.LOCALE, { maximumFractionDigits: 0 });

  function toast(msg, kind = "ok") {
    const t = document.createElement("div");
    t.className = `toast ${kind === "ok" ? "" : kind}`.trim();
    t.textContent = msg;
    $("#toasts").appendChild(t);
    setTimeout(() => t.classList.add("out"), 3400);
    setTimeout(() => t.remove(), 3900);
  }

  function alertBox(el, msg) {
    el.textContent = msg;
    el.classList.remove("show");
    void el.offsetWidth;
    el.classList.add("show");
  }

  const busy = (btn, on) => {
    btn.disabled = on;
    btn.classList.toggle("busy", on);
  };

  const myTeam = () => teams.find((t) => t.id === myTeamId) || null;
  const teamName = (id) => teams.find((t) => t.id === id)?.name || `Team ${id}`;

  /* ---------------- boot ---------------- */
  function boot() {
    const pick = $("#teamPick");
    for (let i = 1; i <= CFG.TEAM_COUNT; i++) {
      pick.insertAdjacentHTML("beforeend", `<option value="${i}">Team ${i}</option>`);
    }
    $("#brandSeason").textContent = CFG.EVENT.season;

    if (!LIVE || !window.supabase) {
      alertBox($("#authAlert"), "Auction backend isn't configured yet. Check auction/js/config.js.");
      $("#btnLogin").disabled = true;
      return;
    }
    $("#authProject").textContent = "Connected to " + new URL(CFG.SUPABASE_URL).hostname;

    // tab-scoped session: nothing persists once the tab closes
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
      auth: { storage: window.sessionStorage, persistSession: true, autoRefreshToken: true },
    });

    sb.auth.getSession().then(({ data }) => {
      if (data.session) enterApp();
    });
  }

  const teamEmail = (n) => `team${n}@${CFG.TEAM_EMAIL_DOMAIN}`;

  function friendlyAuthError(err) {
    const m = err.message || String(err);
    if (/invalid login credentials/i.test(m))
      return "Wrong team or password. Ask the organiser to confirm your team login has been created.";
    if (/email not confirmed/i.test(m))
      return "This team login isn't confirmed yet — ask the organiser to re-create the team logins.";
    if (/failed to fetch|network|load failed/i.test(m))
      return "Can't reach the auction server. Check your internet connection.";
    return m;
  }

  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!sb) return;
    const btn = $("#btnLogin");
    busy(btn, true);
    const { error } = await sb.auth.signInWithPassword({
      email: teamEmail($("#teamPick").value),
      password: $("#teamPass").value,
    });
    busy(btn, false);
    if (error) return alertBox($("#authAlert"), friendlyAuthError(error));
    enterApp();
  });

  $("#btnLogout").addEventListener("click", async () => {
    await sb.auth.signOut();
    sessionStorage.clear();
    location.reload();
  });

  /* ---------------- enter ---------------- */
  async function enterApp() {
    const { data, error } = await sb.rpc("my_auction_team");

    // A failed call and "you have no team" are different problems. Only the
    // second one is worth signing the captain out for — dropping the session
    // on a flaky stadium connection just makes them log in again for nothing.
    if (error) {
      alertBox(
        $("#authAlert"),
        /failed to fetch|network|load failed/i.test(error.message || "")
          ? "Signed in, but the auction server didn't answer. Check your connection and try again."
          : "Signed in, but the auction couldn't start: " + (error.message || error)
      );
      return;
    }
    if (!data) {
      alertBox(
        $("#authAlert"),
        "This login isn't linked to a team yet. Ask the organiser to run “Create 16 team logins” in the console."
      );
      await sb.auth.signOut();
      return;
    }
    myTeamId = data;
    $("#authWrap").hidden = true;
    $("#app").hidden = false;
    $("#brandTeam").textContent = teamName(myTeamId);
    $("#brandMark").textContent = String(myTeamId);

    await refreshAll();
    startRealtime();
  }

  async function refreshAll() {
    const [t, l, s, b, cd] = await Promise.all([
      sb.from("auction_teams").select("*").order("id"),
      sb.from("auction_pool").select("*"),
      sb.from("auction_state").select("*").eq("id", 1).maybeSingle(),
      sb.from("auction_bids").select("*").order("id", { ascending: false }).limit(12),
      // resolved cards (pool joined to registrations) for photos everywhere
      sb.rpc("auction_cards"),
    ]);
    if (!cd.error && cd.data) {
      cards = {};
      cd.data.forEach((c) => (cards[c.id] = c));
    }

    // Never fall back to an empty wallet: renderStage() reads purse_left to
    // decide whether the bid button is affordable, so silently keeping the
    // old (or an empty) teams list would let a captain bid past their purse.
    const failed = [t, l, s, b].find((r) => r.error);
    if (failed) {
      $("#bidMsg").textContent =
        "Lost contact with the auction server — reconnecting. Bidding is paused.";
      $("#btnBid").disabled = true;
      $("#liveDot").classList.remove("on");
      $("#liveLabel").textContent = "offline";
      return false;
    }

    teams = t.data || [];
    lots = l.data || [];
    state = s.data || null;
    bids = b.data || [];
    renderAll();
    return true;
  }

  /* ---------------- realtime ---------------- */
  function startRealtime() {
    try {
      sb.channel("auction-live")
        .on("postgres_changes", { event: "*", schema: "public", table: "auction_state" }, (p) => {
          const lotChanged = !state || state.current_lot_id !== p.new.current_lot_id;
          state = p.new;
          // A new player on the block means the old ticker and the "leading"
          // markers in the teams table are both stale.
          if (lotChanged) bids = bids.filter((b) => b.lot_id === state.current_lot_id);
          renderStage();
          renderWallet();
          renderTeams();
          renderTicker();
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "auction_teams" }, (p) => {
          const i = teams.findIndex((x) => x.id === p.new.id);
          if (i > -1) teams[i] = p.new;
          renderWallet();
          renderTeams();
          renderStage();
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "auction_pool" }, (p) => {
          if (p.eventType === "DELETE") {
            lots = lots.filter((x) => x.id !== p.old.id);
            delete cards[p.old.id];
          } else {
            const i = lots.findIndex((x) => x.id === p.new.id);
            if (i > -1) lots[i] = p.new;
            else lots.push(p.new);
            // Keep the cached card in step. Realtime only carries the pool row,
            // so merge it over the card and keep the resolved photo/sex/DUPR.
            if (cards[p.new.id]) {
              Object.assign(cards[p.new.id], {
                name: p.new.name,
                category: p.new.category,
                base_price: p.new.base_price,
                status: p.new.status,
                sold_to_team_id: p.new.sold_to_team_id,
                sold_price: p.new.sold_price,
              });
            } else {
              refreshCards();
            }
            if (p.eventType === "UPDATE" && p.new.status === "sold") announceSale(p.new);
          }
          renderSquad();
          renderTeams();
          renderStage();
        })
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "auction_bids" }, (p) => {
          bids.unshift(p.new);
          bids = bids.slice(0, 12);
          renderTicker();
        })
        .subscribe((st) => {
          const on = st === "SUBSCRIBED";
          $("#liveDot").classList.toggle("on", on);
          $("#liveLabel").textContent = on ? "live" : "offline";
          // Every gap in the socket is a gap in our copy of the auction.
          // Re-read the whole board on (re)connect so a captain can never
          // bid against a price that moved while they were disconnected.
          if (on) refreshAll();
        });
    } catch {
      $("#liveLabel").textContent = "offline";
    }
  }

  // Phones aggressively suspend background tabs and silently drop the socket.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && myTeamId !== null) refreshAll();
  });

  function announceSale(lot) {
    if (lot.sold_to_team_id === myTeamId) {
      toast(`🎉 You won ${lot.name} for ${money(lot.sold_price)}`, "gold");
    } else {
      toast(`${lot.name} → ${teamName(lot.sold_to_team_id)} (${money(lot.sold_price)})`, "info");
    }
  }

  /* ---------------- render ---------------- */
  function renderAll() {
    renderWallet();
    renderStage();
    renderSquad();
    renderTeams();
    renderTicker();
  }

  function squadOf(id) {
    return lots.filter((l) => l.sold_to_team_id === id && l.status === "sold");
  }

  function renderWallet() {
    const t = myTeam();
    if (!t) return;
    const left = Number(t.purse_left);
    const total = Number(t.purse_total) || 1;
    const squad = squadOf(myTeamId);
    const slotsLeft = Math.max(t.max_squad - squad.length, 0);

    $("#wLeft").textContent = money(left);
    $("#wSpent").textContent = money(t.purse_spent);
    $("#wSquad").textContent = `${squad.length} / ${t.max_squad}`;
    $("#wBar").style.width = Math.max(0, Math.min(100, (left / total) * 100)) + "%";

    // keep enough purse to fill remaining slots at the minimum base price
    $("#wMaxBid").textContent = slotsLeft > 0 ? money(left) : "Squad full";
  }

  function renderStage() {
    const live = state && state.status === "live" && state.current_lot_id;
    $("#stageIdle").hidden = !!live;
    $("#stageLive").hidden = !live;
    if (!live) return;

    const lot = lots.find((l) => l.id === state.current_lot_id);
    if (!lot) return;

    renderCard(lot);

    const price = Number(state.current_price);
    const el = $("#bidValue");
    el.textContent = money(price);
    if (lastPrice !== null && price !== lastPrice) {
      el.classList.remove("bump");
      void el.offsetWidth;
      el.classList.add("bump");
    }
    lastPrice = price;

    const holder = $("#bidHolder");
    const leadingMe = state.leading_team_id === myTeamId;
    holder.textContent = state.leading_team_id
      ? leadingMe
        ? "You are the highest bidder"
        : `Highest: ${teamName(state.leading_team_id)}`
      : "No bids yet — open at the base price";
    holder.classList.toggle("mine", leadingMe);

    // next bid the captain would place
    const t = myTeam();
    const next = state.leading_team_id
      ? price + Number(state.bid_increment)
      : price;
    const squadFull = t && squadOf(myTeamId).length >= t.max_squad;
    const tooRich = t && next > Number(t.purse_left);

    $("#bidNext").textContent = money(next);
    const btn = $("#btnBid");
    btn.disabled = leadingMe || squadFull || tooRich;
    $("#bidMsg").textContent = squadFull
      ? "Your squad is full — you can't bid on more players."
      : tooRich
      ? `Not enough purse left for ${money(next)}.`
      : leadingMe
      ? ""
      : "";
    $("#bidMsg").classList.remove("ok");
  }

  /* ---------------- player card ----------------
     The pool row carries only what the organiser typed. Photo, sex and DUPR
     usually live on the player's registration and are joined server-side by
     Player Key, so paint what we have, then upgrade when the card arrives. */
  const CAT_LABEL = { A: "Advance", B: "Intermediate", C: "Beginner" };
  let cardFor = null;

  function paintCard(c) {
    const img = $("#lotPhoto");
    const no = $("#lotNoImg");
    if (c.photo_url) {
      img.src = c.photo_url;
      img.hidden = false;
      no.hidden = true;
    } else {
      img.hidden = true;
      no.hidden = false;
      const why = $("#lotNoImgWhy");
      if (why) why.textContent = c.has_registration ? "registered, no photo" : "not registered yet";
    }
    $("#lotName").textContent = c.name || "—";
    $("#lotCat").textContent = c.category
      ? `${c.category} · ${c.category_label || CAT_LABEL[c.category] || ""}`
      : "—";
    $("#lotAge").textContent = c.age != null ? c.age : "NA";
    $("#lotSex").textContent = c.sex || "NA";
    $("#lotDupr").textContent = c.dupr != null ? Number(c.dupr).toFixed(3) : "NA";
    $("#lotBase").textContent = money(c.base_price);
  }

  // renderStage() runs on every price tick and every realtime event. Only
  // repaint the card when the player actually changes, otherwise the pool-row
  // fallback (which has no photo) would overwrite the resolved card each time.
  function renderCard(lot) {
    if (cardFor === lot.id) return;
    cardFor = lot.id;
    paintCard(cards[lot.id] || lot);   // resolved card if we have it, else the raw row
    if (!cards[lot.id]) fetchCard(lot); // only round-trip when we don't
  }

  // A player the cache has never seen (added to the pool mid-auction) needs
  // the registration join, which realtime cannot give us.
  let refreshingCards = false;
  async function refreshCards() {
    if (refreshingCards) return;
    refreshingCards = true;
    const { data, error } = await sb.rpc("auction_cards");
    refreshingCards = false;
    if (error || !data) return;
    cards = {};
    data.forEach((c) => (cards[c.id] = c));
    renderAll();
  }

  async function fetchCard(lot) {
    const { data, error } = await sb.rpc("auction_player_card", { p_pool_id: lot.id });
    if (error || cardFor !== lot.id) return;   // stale: a new player is already up
    const c = Array.isArray(data) ? data[0] : data;
    if (c) paintCard(c);
  }

  /* A squad row: photo, name, category, and the stats a captain compares on. */
  function squadRow(l) {
    const c = cards[l.id] || l;
    const bits = [
      c.dupr != null ? "DUPR " + Number(c.dupr).toFixed(3) : "Unrated",
      c.age != null ? c.age + "y" : null,
      c.sex || null,
    ].filter(Boolean);
    return `<div class="sq">
      ${
        c.photo_url
          ? `<img src="${esc(c.photo_url)}" alt="" loading="lazy" />`
          : `<span class="noimg">🥒</span>`
      }
      <div class="sq-main">
        <div class="nm">${esc(c.name || "—")} <span class="cat-chip c-${esc(c.category)}">${esc(
      c.category
    )}</span></div>
        <div class="meta">${esc(bits.join(" · "))}</div>
      </div>
      <span class="price">${money(l.sold_price)}</span>
    </div>`;
  }

  function renderSquad() {
    const squad = squadOf(myTeamId).sort((a, b) => (a.sold_at || "").localeCompare(b.sold_at || ""));
    const t = myTeam();
    $("#squadCount").textContent = squad.length;

    // category progress, so a captain can see at a glance what they still owe
    const need = t ? { A: t.max_a, B: t.max_b, C: t.max_c } : { A: 1, B: 4, C: 4 };
    const have = { A: 0, B: 0, C: 0 };
    squad.forEach((l) => {
      const cat = (cards[l.id] || l).category;
      if (have[cat] != null) have[cat]++;
    });
    const quota = $("#squadQuota");
    if (quota) {
      quota.innerHTML = ["A", "B", "C"]
        .map(
          (k) =>
            `<span class="qchip ${have[k] >= need[k] ? "full" : ""}"><b class="cat-chip c-${k}">${k}</b> ${
              have[k]
            }/${need[k]}</span>`
        )
        .join("");
    }

    $("#squad").innerHTML = squad.length
      ? squad.map(squadRow).join("")
      : `<p class="empty">No players yet — your squad will appear here the moment you win a bid.</p>`;
  }

  function renderTeams() {
    $("#teamsBody").innerHTML = teams
      .map((t) => {
        const roster = squadOf(t.id).sort((a, b) =>
          (a.sold_at || "").localeCompare(b.sold_at || "")
        );
        const leading = state && state.leading_team_id === t.id;
        const isMe = t.id === myTeamId;
        const open = openTeam === t.id;

        const head = `<tr class="tm-row ${isMe ? "me" : ""} ${leading ? "lead" : ""} ${
          open ? "open" : ""
        }" data-team="${t.id}" tabindex="0" role="button" aria-expanded="${open}">
          <td><span class="tm-caret">${open ? "▾" : "▸"}</span> ${esc(t.name)}${
          leading ? " ●" : ""
        }${isMe ? ` <span class="tm-you">you</span>` : ""}</td>
          <td>${roster.length}/${t.max_squad}</td>
          <td class="num">${money(t.purse_left)}</td>
        </tr>`;

        if (!open) return head;

        const body = roster.length
          ? roster.map(squadRow).join("")
          : `<p class="empty">No players bought yet.</p>`;
        return (
          head +
          `<tr class="tm-detail"><td colspan="3">
             <div class="tm-squad">${body}</div>
             <div class="tm-foot">Spent ${money(t.purse_spent)} of ${money(t.purse_total)}</div>
           </td></tr>`
        );
      })
      .join("");
  }

  /* Tap any team to see who they have bought and what it cost. */
  function toggleTeam(id) {
    openTeam = openTeam === id ? null : id;
    renderTeams();
  }
  document.addEventListener("click", (e) => {
    const r = e.target.closest(".tm-row");
    if (r) toggleTeam(Number(r.dataset.team));
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const r = e.target.closest && e.target.closest(".tm-row");
    if (r) {
      e.preventDefault();
      toggleTeam(Number(r.dataset.team));
    }
  });

  function renderTicker() {
    const lotId = state && state.current_lot_id;
    const list = bids.filter((b) => !lotId || b.lot_id === lotId).slice(0, 8);
    $("#ticker").innerHTML = list
      .map(
        (b) =>
          `<div class="tick"><b>${esc(teamName(b.team_id))}</b><span class="amt">${money(b.amount)}</span></div>`
      )
      .join("");
  }

  /* ---------------- bidding ---------------- */
  $("#btnBid").addEventListener("click", async () => {
    const btn = $("#btnBid");
    busy(btn, true);
    const { data, error } = await sb.rpc("auction_bid", { p_team_id: null, p_amount: null });
    busy(btn, false);
    const msg = $("#bidMsg");
    if (error) {
      msg.classList.remove("ok");
      msg.textContent = error.message.replace(/^.*?:\s*/, "");
      renderStage();
      return;
    }
    // Reflect our own bid immediately — don't wait for the realtime echo, and
    // re-lock the button so a double-tap can't bid against ourselves.
    if (state) {
      state.current_price = Number(data);
      state.leading_team_id = myTeamId;
    }
    renderStage();
    msg.classList.add("ok");
    msg.textContent = `Bid placed at ${money(data)}`;
  });

  window.addEventListener("DOMContentLoaded", boot);
})();
