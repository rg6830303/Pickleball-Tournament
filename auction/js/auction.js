/* ============================================================
   MPL TEAM AUCTION — captain app
   Login → live block → bid → auto wallet deduction → squad
   ============================================================ */
(() => {
  "use strict";

  const CFG = window.MPL_AUCTION_CONFIG;
  const $ = (s, r = document) => r.querySelector(s);
  const LIVE = Boolean(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);

  // Captains see the auction room only while it is switched on. When it is
  // off they get their final squad instead — see SHOW_AUCTION in config.js.
  // Everything below the flag (bidding, wallet, ticker) stays in the file so
  // the room can be reopened without a rewrite.
  const SHOW_AUCTION = CFG.SHOW_AUCTION !== false;

  let sb = null;
  let myTeamId = null;
  let teams = [];
  let lots = [];
  let state = null;
  let bids = [];
  let cards = {};          // pool id -> card resolved against the registration
  // Base price per category, refreshed from auction_categories. The reserve
  // in the max-bid formula is priced off these.
  let BASE = { A: 50000, B: 30000, C: 20000 };
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
    // Numbered placeholders first, so the form works even if the roster call
    // fails; the real names replace them a moment later. The option value stays
    // the team id either way, because the login is still team<id>@…
    for (let i = 1; i <= CFG.TEAM_COUNT; i++) {
      pick.insertAdjacentHTML("beforeend", `<option value="${i}">Team ${i}</option>`);
    }
    $("#brandSeason").textContent = CFG.EVENT.season;

    // The sign-in screen promises an auction room. With the room closed it has
    // to promise the squad instead, or captains sit waiting for a lot that is
    // never called. Restored automatically when SHOW_AUCTION goes back to true.
    if (!SHOW_AUCTION) {
      document.title = "MPL Squad — Team Captain";
      const title = document.querySelector(".auth-title");
      if (title) title.textContent = "Team Squad";
      const label = document.querySelector("#btnLogin .btn-label");
      if (label) label.textContent = "View My Squad";
      const fine = document.querySelector(".auth-fine");
      if (fine) fine.textContent = "Captains only. Sign in to see the nine players in your franchise.";
    }

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

    // auction_teams is readable only once signed in, so the login screen asks
    // for the roster on its own — names and captains, nothing else
    sb.rpc("auction_team_roster").then(({ data }) => {
      if (!data || !data.length) return;
      const chosen = pick.value;
      pick.innerHTML = data
        .map((t) => `<option value="${t.id}">${esc(t.name)}</option>`)
        .join("");
      pick.value = chosen || data[0].id;
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
    $("#brandMark").textContent = String(myTeamId);

    if (!SHOW_AUCTION) {
      await enterSquadOnly();
      return;
    }

    $("#brandTeam").textContent = teamName(myTeamId);
    renderWelcome();

    await refreshAll();
    startRealtime();
  }

  /* ============================================================
     SQUAD-ONLY MODE
     No purse, no lot, no bidding — just the nine names the
     captain finished the auction with, read from team_squads.
     ============================================================ */
  async function enterSquadOnly() {
    document.querySelector(".wallet")?.setAttribute("hidden", "");
    document.querySelector(".stage")?.setAttribute("hidden", "");
    document.querySelector(".cols")?.setAttribute("hidden", "");
    $("#roster").hidden = false;
    const sub = document.querySelector(".brand-sub");
    if (sub) sub.textContent = `Squad · ${CFG.EVENT.season}`;

    // The realtime badge would sit there saying "connecting…" forever with no
    // auction channel open, so it goes with the rest of the auction chrome.
    $("#liveDot")?.setAttribute("hidden", "");

    const [t, s] = await Promise.all([
      sb.from("auction_teams").select("id,name,captain_name,group_code,group_rank").eq("id", myTeamId).maybeSingle(),
      sb.from("team_squads").select("*").eq("team_id", myTeamId).order("sort_order"),
    ]);

    const team = t.data || { id: myTeamId, name: `Team ${myTeamId}` };
    $("#brandTeam").textContent = team.name;
    $("#rosterTeam").textContent = team.name;
    $("#rosterCap").textContent = team.captain_name ? `Captain · ${team.captain_name}` : "";
    $("#rosterGroup").textContent = team.group_code
      ? `Group ${team.group_code} · ${String(team.group_rank ?? "").padStart(2, "0")}`
      : "The Franchises";

    const list = $("#rosterList");
    if (s.error) {
      list.innerHTML = "";
      $("#rosterNote").textContent =
        "Couldn't load your squad: " + (s.error.message || s.error);
      return;
    }

    const squad = s.data || [];
    if (!squad.length) {
      list.innerHTML = "";
      $("#rosterNote").textContent =
        "Your squad hasn't been published yet. It will appear here the moment the organiser posts it.";
      return;
    }

    list.innerHTML = squad
      .map(
        (p, i) => `
        <li class="roster-row">
          <span class="rr-no">${String(i + 1).padStart(2, "0")}</span>
          <span class="rr-cat c-${esc(p.category)}">${esc(p.category)}</span>
          <span class="rr-name">${esc(p.player_name)}</span>
          ${p.retained ? '<span class="rr-ret" title="Retained player">R</span>' : ""}
        </li>`
      )
      .join("");

    $("#rosterNote").textContent = `${squad.length} players · 9 per squad`;

    await loadMatchDay(team);
  }

  /* ---------------- match day: the ties this team plays ---------------- */
  const FMT = window.MPL_FORMAT;

  async function loadMatchDay(team) {
    $("#capTabs").hidden = false;
    $("#capFormat").innerHTML = FMT.tieStrip();
    $("#capRuleBlocks").innerHTML = FMT.rules();
    $("#mdayWhen").textContent = FMT.DATA.when;
    $("#mdayWhere").textContent = `${FMT.DATA.where} · ${FMT.DATA.firstServe}`;

    // Groups A & B are on court first, so they are called in early; C & D are
    // told relative to their own tie rather than to the start of the day.
    $("#mdayReport").textContent = ["A", "B"].includes(team.group_code)
      ? "Group A & B report at 8:30 AM."
      : "Report 30 minutes before your scheduled tie.";

    const [ti, tr] = await Promise.all([
      sb.from("tournament_ties").select("*").order("sort_order"),
      sb.rpc("auction_team_roster"),
    ]);

    if (ti.error) {
      $("#fixtures").innerHTML = "";
      $("#fixNote").textContent = "Couldn't load the schedule: " + (ti.error.message || ti.error);
      return;
    }

    const names = {};
    (tr.data || []).forEach((t) => (names[t.id] = t.name));
    const nameOf = (id) => (id ? names[id] || null : null);

    const all = ti.data || [];
    const mine = all.filter((t) => t.home_team_id === myTeamId || t.away_team_id === myTeamId);
    $("#capLadder").innerHTML = FMT.ladder(all, nameOf);

    if (!mine.length) {
      $("#fixtures").innerHTML = "";
      $("#fixNote").textContent = "Your fixtures haven't been published yet.";
      return;
    }

    // "Up next" is the first tie that has not finished; once the day is over
    // nothing is highlighted rather than the last tie pretending to be next.
    const now = Date.now();
    const nextId = mine.find((t) => t.ends_at && new Date(t.ends_at).getTime() > now)?.id;

    $("#fixtures").innerHTML = mine
      .map((t) => {
        const home = t.home_team_id === myTeamId;
        const oppId = home ? t.away_team_id : t.home_team_id;
        const opp = nameOf(oppId) || (home ? t.away_label : t.home_label);
        return `
        <article class="fx${t.id === nextId ? " next" : ""}">
          <div class="fx-when">
            <p class="fx-time">${esc(FMT.timeOf(t.starts_at))}</p>
            <p class="fx-till">to ${esc(FMT.timeOf(t.ends_at))}</p>
            <p class="fx-court">${t.court ? "Court " + t.court : "Court TBC"}</p>
          </div>
          <div class="fx-who">
            <p class="fx-tag">${
              t.group_code ? `<b>Group ${esc(t.group_code)}</b> Round ${t.round}` : esc(t.phase.toUpperCase())
            }${t.id === nextId ? ' <span class="fx-next">Up next</span>' : ""}</p>
            <p class="fx-vs">vs</p>
            <p class="fx-opp">${esc(opp)}</p>
          </div>
        </article>`;
      })
      .join("");

    const courts = [...new Set(mine.map((t) => t.court).filter(Boolean))].sort();
    $("#fixNote").textContent =
      `${mine.length} ties · ${mine.length * 5} matches` +
      (courts.length ? ` · ${courts.length > 1 ? "Courts" : "Court"} ${courts.join(" & ")}` : "");
  }

  /* squad / matches / rules — one at a time on a phone */
  document.querySelectorAll(".cap-tab").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll(".cap-tab").forEach((x) => {
        x.classList.toggle("on", x === b);
        x.setAttribute("aria-selected", x === b ? "true" : "false");
      });
      const pane = { squad: "roster", matches: "capMatches", rules: "capRules" }[b.dataset.cap];
      document.querySelectorAll(".cappane").forEach((p) => (p.hidden = p.id !== pane));
    })
  );

  async function refreshAll() {
    const [t, l, s, b, cd, cat] = await Promise.all([
      sb.from("auction_teams").select("*").order("id"),
      sb.from("auction_pool").select("*"),
      sb.from("auction_state").select("*").eq("id", 1).maybeSingle(),
      sb.from("auction_bids").select("*").order("id", { ascending: false }).limit(12),
      // resolved cards (pool joined to registrations) for photos everywhere
      sb.rpc("auction_cards"),
      sb.from("auction_categories").select("code,base_price"),
    ]);
    if (!cd.error && cd.data) {
      cards = {};
      cd.data.forEach((c) => (cards[c.id] = c));
    }
    if (!cat.error && cat.data) {
      cat.data.forEach((c) => (BASE[c.code] = Number(c.base_price)));
    }

    // Never fall back to an empty wallet: renderStage() reads purse_left to
    // decide whether the bid button is affordable, so silently keeping the
    // old (or an empty) teams list would let a captain bid past their purse.
    const failed = [t, l, s, b].find((r) => r.error);
    if (failed) {
      $("#bidMsg").textContent =
        "Lost contact with the auction server — reconnecting.";
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
    // A captain watching on a second screen gets the same announcement the
    // room does, rather than the block simply going empty.
    if (window.MNSold)
      MNSold.show(stageEl(), {
        name: lot.name,
        team: teamName(lot.sold_to_team_id),
        price: lot.sold_price,
      });
  }

  /* ---------------- render ---------------- */
  function renderAll() {
    $("#brandTeam").textContent = teamName(myTeamId);
    renderWelcome();
    renderWallet();
    renderStage();
    renderSquad();
    renderTeams();
    renderTicker();
  }

  function squadOf(id) {
    return lots.filter((l) => l.sold_to_team_id === id && l.status === "sold");
  }

  /* Slots this team still has to fill, per category. */
  function unfilled(t) {
    const have = { A: 0, B: 0, C: 0 };
    squadOf(t.id).forEach((l) => {
      const cat = (cards[l.id] || l).category;
      if (have[cat] != null) have[cat]++;
    });
    return {
      A: Math.max((t.max_a ?? 1) - have.A, 0),
      B: Math.max((t.max_b ?? 4) - have.B, 0),
      C: Math.max((t.max_c ?? 4) - have.C, 0),
    };
  }

  /* The most this team may commit to one player of category `cat`.
       R = purse remaining
       F = reserve for EVERY unfilled slot at its base price
       max = R − F + base(cat)
     i.e. hold back enough to still buy the rest of the squad at base. */
  function maxBidFor(t, cat) {
    if (!t) return 0;
    const u = unfilled(t);
    const F = u.A * BASE.A + u.B * BASE.B + u.C * BASE.C;
    return Math.max(Number(t.purse_left) - F + (BASE[cat] || 0), 0);
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

    // All three maxima, always. A single figure meant the number changed
    // meaning depending on who was on screen, which read as simply wrong when
    // a captain was thinking about a different category.
    const u = unfilled(t);
    const lot = state && state.current_lot_id ? lots.find((l) => l.id === state.current_lot_id) : null;
    const liveCat = lot ? (cards[lot.id] || lot).category : null;

    ["A", "B", "C"].forEach((k) => {
      const cell = $("#wMax" + k);
      if (!cell) return;
      const val = cell.querySelector("span");
      if (u[k] > 0) {
        val.textContent = money(maxBidFor(t, k));
        cell.classList.remove("is-full");
      } else {
        val.textContent = "full";
        cell.classList.add("is-full");
      }
      cell.classList.toggle("is-live", k === liveCat);
    });

    const note = $("#wMaxBidNote");
    const reserve = u.A * BASE.A + u.B * BASE.B + u.C * BASE.C;
    if (note) {
      note.textContent = !slotsLeft
        ? "Squad full"
        : `${u.A}A · ${u.B}B · ${u.C}C to buy · ${money(reserve)} reserved`;
    }
    const label = $("#wMaxBidLabel");
    if (label) label.textContent = liveCat ? `Max bid · ${liveCat} on the block` : "Max bid";
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

    // Bidding is called in the room and the auctioneer's screen carries the
    // running price, so repeating it here only competed with the one number a
    // captain actually needs: their own ceiling for THIS player.
    const t = myTeam();
    const cat = (cards[lot.id] || lot).category;
    const u = t ? unfilled(t) : null;
    const msg = $("#bidMsg");
    msg.classList.remove("ok");

    if (!t) {
      msg.textContent = "";
    } else if (squadOf(myTeamId).length >= t.max_squad) {
      msg.textContent = "Your squad is full — you can no longer buy players.";
    } else if (u && u[cat] === 0) {
      msg.textContent = `Your ${cat} quota is full — you cannot take this player.`;
    } else {
      const cap = maxBidFor(t, cat);
      msg.textContent =
        price > cap
          ? `Above your limit of ${money(cap)} for a category ${cat} player.`
          : `You can go up to ${money(cap)} for this player.`;
      if (price <= cap) msg.classList.add("ok");
    }
  }

  /* ---------------- player card ----------------
     The pool row carries only what the organiser typed. Photo, sex and DUPR
     usually live on the player's registration and are joined server-side by
     Player Key, so paint what we have, then upgrade when the card arrives. */
  const CAT_LABEL = { A: "Advance", B: "Intermediate", C: "Beginner" };
  let cardFor = null;

  /* The card is the supplied artwork with the player laid onto it; the
     renderer lives in mn-card.js so the console and every captain's app
     draw an identical card. */
  function paintCard(c) {
    const el = $("#lotCard");
    if (el) MNCard.render(el, c);
  }

  /* The captains walk in and log in on their phones; the first thing the
     screen should do is know who they are. Sits above the block so it never
     competes with the player card. */
  function renderWelcome() {
    const el = $("#welcome");
    if (!el) return;
    const t = myTeam();
    if (!t) { el.hidden = true; return; }
    el.hidden = false;
    $("#welcomeWho").textContent = t.captain_name || teamName(myTeamId);
    $("#welcomeTeam").textContent = teamName(myTeamId);
  }

  /* ---------------- projector mode ----------------
     Captains watch on a phone or a second screen, so the card gets the same
     full-screen treatment as the auctioneer's console. */
  function stageEl() { return document.getElementById("stage"); }

  function syncFullBtn(on) {
    const b = $("#btnFull");
    if (!b) return;
    b.setAttribute("aria-pressed", on ? "true" : "false");
    const l = b.querySelector(".mn-fs-label");
    if (l) l.textContent = on ? "Exit" : "Full screen";
  }

  function setBlownUp(on) {
    const el = stageEl();
    if (!el) return;
    el.classList.toggle("is-blownup", on);
    document.body.classList.toggle("mn-blownup", on);
    syncFullBtn(on);
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
      if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: "hide" });
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      else setBlownUp(true);
    } catch {
      // refused by policy or missing a user gesture — fill the window instead
      setBlownUp(true);
    }
  }

  $("#btnFull") && $("#btnFull").addEventListener("click", toggleFullscreen);
  document.addEventListener("fullscreenchange", () => syncFullBtn(document.fullscreenElement === stageEl()));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const el = stageEl();
      if (el && el.classList.contains("is-blownup")) setBlownUp(false);
      return;
    }
    if (e.key !== "f" && e.key !== "F") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if ($("#app").hidden) return;
    e.preventDefault();
    toggleFullscreen();
  });

  // renderStage() runs on every price tick and every realtime event. Only
  // repaint when the player actually changes, otherwise the pool-row fallback
  // (which has no photo) would overwrite the resolved card each time.
  function renderCard(lot) {
    if (cardFor === lot.id) return;
    cardFor = lot.id;
    paintCard(cards[lot.id] || lot);    // resolved card if we have it
    if (!cards[lot.id]) fetchCard(lot); // otherwise go and get it
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





  window.addEventListener("DOMContentLoaded", boot);
})();
