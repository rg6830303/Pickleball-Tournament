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
    mySquad = squad;   // the team sheet form may name these nine and nobody else
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
    await loadSheets();
  }

  /* ---------------- match day: the ties this team plays ---------------- */
  const FMT = window.MPL_FORMAT;
  let mdNames = null;      // team id -> name, kept for the score refresh

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
    mdNames = names;
    const nameOf = (id) => (id ? names[id] || null : null);

    const all = ti.data || [];
    const mine = all.filter((t) => t.home_team_id === myTeamId || t.away_team_id === myTeamId);
    $("#capLadder").innerHTML = FMT.ladder(all, nameOf);

    if (!mine.length) {
      $("#fixtures").innerHTML = "";
      $("#fixNote").textContent = "Your fixtures haven't been published yet.";
      return;
    }

    renderFixtures(mine, nameOf);
  }

  /* The team's own ties, with the running match score once the organiser has
     recorded one. home_score/away_score are matches won, not game points —
     tie_recount() keeps them in step with match_results. */
  function renderFixtures(mine, nameOf) {
    // "Up next" is the first tie that has not finished; once the day is over
    // nothing is highlighted rather than the last tie pretending to be next.
    const now = Date.now();
    const nextId = mine.find((t) => t.ends_at && new Date(t.ends_at).getTime() > now)?.id;

    $("#fixtures").innerHTML = mine
      .map((t) => {
        const home = t.home_team_id === myTeamId;
        const oppId = home ? t.away_team_id : t.home_team_id;
        const opp = nameOf(oppId) || (home ? t.away_label : t.home_label);

        const scored = t.status === "live" || t.status === "done";
        const us = Number(home ? t.home_score : t.away_score) || 0;
        const them = Number(home ? t.away_score : t.home_score) || 0;
        let res = "In play", resCls = "live";
        if (t.status === "done") {
          if (t.winner_team_id === myTeamId) { res = "Won"; resCls = "won"; }
          else if (t.winner_team_id) { res = "Lost"; resCls = "lost"; }
          else { res = "Level"; resCls = ""; }
          if (t.decided_by === "shootout") res += " · shootout";
        }

        return `
        <article class="fx${t.id === nextId ? " next" : ""}${scored ? " scored" : ""}">
          <div class="fx-when">
            <p class="fx-time">${esc(FMT.timeOf(t.starts_at))}</p>
            <p class="fx-till">to ${esc(FMT.timeOf(t.ends_at))}</p>
            <p class="fx-court">${t.court ? "Court " + t.court : "Court TBC"}</p>
          </div>
          <div class="fx-who">
            <p class="fx-tag">${
              t.group_code ? `<b>Group ${esc(t.group_code)}</b> Round ${esc(t.round)}` : `<b>${esc(PHASE_WORD[t.phase] || t.phase)}</b>`
            }${t.id === nextId ? ' <span class="fx-next">Up next</span>' : ""}</p>
            <p class="fx-vs">vs</p>
            <p class="fx-opp">${esc(opp)}</p>
          </div>
          ${
            scored
              ? `<div class="fx-score">
                   <p class="fx-sc">${us}<i>–</i>${them}</p>
                   <p class="fx-res ${resCls}">${esc(res)}</p>
                 </div>`
              : ""
          }
        </article>`;
      })
      .join("");

    const courts = [...new Set(mine.map((t) => t.court).filter(Boolean))].sort();
    const played = mine.filter((t) => t.status === "live" || t.status === "done").length;
    $("#fixNote").textContent =
      `${mine.length} ties · ${mine.length * 5} matches` +
      (courts.length ? ` · ${courts.length > 1 ? "Courts" : "Court"} ${courts.join(" & ")}` : "") +
      (played ? ` · ${played} under way` : "");
  }

  /* Scores land while the captain is looking at another pane. Re-read just the
     ties rather than the whole match-day header. */
  async function refreshFixtures() {
    if (!mdNames) return;
    const { data, error } = await sb.from("tournament_ties").select("*").order("sort_order");
    if (error || !data) return;
    const mine = data.filter((t) => t.home_team_id === myTeamId || t.away_team_id === myTeamId);
    if (mine.length) renderFixtures(mine, (id) => (id ? mdNames[id] || null : null));
    $("#capLadder").innerHTML = FMT.ladder(data, (id) => (id ? mdNames[id] || null : null));
  }

  /* squad / matches / rules — one at a time on a phone */
  document.querySelectorAll(".cap-tab").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll(".cap-tab").forEach((x) => {
        x.classList.toggle("on", x === b);
        x.setAttribute("aria-selected", x === b ? "true" : "false");
      });
      const pane = { squad: "roster", sheet: "capSheet", matches: "capMatches", rules: "capRules" }[b.dataset.cap];
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





  /* ============================================================
     TEAM SHEET
     The nine names a captain files per tie, against the organiser's
     15-minute clock. The server (sheet_file) is the authority on every
     rule below — the form only exists so a captain never finds out they
     got it wrong by being rejected with 40 seconds left on the clock.
     ============================================================ */

  // The five matches in play order. tournament_format carries the wording the
  // organiser publishes; these are the fallback so the form still draws when
  // that read fails on stadium wifi.
  const TS_SLOTS = [
    { slot: 1, cells: 2, label: "AB / BB Doubles", note: "Your A with a B — or two B players when the A takes the singles" },
    { slot: 2, cells: 2, label: "BC Doubles",      note: "One Category B player with a Category C player" },
    { slot: 3, cells: 1, label: "Singles",         note: "A single player — your A or a B" },
    { slot: 4, cells: 2, label: "BC Doubles",      note: "A second B + C pair — different players" },
    { slot: 5, cells: 2, label: "CC Doubles",      note: "Two Category C players" },
  ];
  const TS_TRUMPABLE = [1, 2, 4, 5];
  const TS_TRUMP_LINE =
    "Win your trump match and it is +2. If both teams trump the same match: winner +2, loser −2.";

  let mySquad = [];      // team_squads rows for this team, in sort_order
  let sheetRows = [];    // my_sheets()
  let sheetDraft = {};   // tie_id -> { p: { "1.1": squad_id, … }, trump: int|null }
  let sheetSeen = {};    // tie_id -> the window we last painted, to spot a reopen
  let sheetSig = null;   // what is painted, so a repaint never lands mid-tap;
                         // null, not "", or an empty board would never paint
  let sheetTimer = null;
  let sheetTick = 0;

  const squadById = (id) => mySquad.find((p) => p.id === id) || null;
  const catOf = (id) => (id ? squadById(id)?.category || null : null);

  function draftOf(tieId) {
    if (!sheetDraft[tieId]) sheetDraft[tieId] = { p: {}, trump: null };
    return sheetDraft[tieId];
  }

  function mmss(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }

  /* An open sheet whose clock has run out is still 'open' in the database —
     only the organiser can change that — but it is dead to the captain. */
  function tsState(r) {
    if (r.status === "submitted") return "submitted";
    if (r.status === "void") return "void";
    if (r.deadline && Date.now() > new Date(r.deadline).getTime()) return "expired";
    return "open";
  }

  /* Which categories may still go in this cell, given everything else picked.
     Together with "already used elsewhere" this is what makes an illegal
     line-up unreachable rather than merely rejected. */
  function tsAllowed(d, slot, pos) {
    const other = (s, p) => catOf(d.p[`${s}.${p}`]);
    if (slot === 3) return ["A", "B"];
    if (slot === 5) return ["C"];
    if (slot === 2 || slot === 4) {
      const o = other(slot, pos === 1 ? 2 : 1);
      if (o === "B") return ["C"];
      if (o === "C") return ["B"];
      return ["B", "C"];
    }
    // slot 1 follows the singles: the A plays one or the other, never both
    const singles = other(3, 1);
    if (singles === "A") return ["B"];
    const o = other(1, pos === 1 ? 2 : 1);
    if (singles === "B") return o === "A" ? ["B"] : o === "B" ? ["A"] : ["A", "B"];
    return o === "A" ? ["B"] : ["A", "B"];
  }

  function tsNamed(d) {
    let n = 0;
    TS_SLOTS.forEach((s) => {
      for (let p = 1; p <= s.cells; p++) if (d.p[`${s.slot}.${p}`]) n++;
    });
    return n;
  }

  /* The one thing standing between this sheet and the submit button, in the
     words a captain would use. Mirrors sheet_file()'s checks, in its order. */
  function tsProblem(d) {
    const at = (s, p) => d.p[`${s}.${p}`] || null;

    for (const s of TS_SLOTS) {
      for (let p = 1; p <= s.cells; p++) {
        if (at(s.slot, p)) continue;
        if (s.slot === 3) return "Match 3 still needs your singles player";
        const partner = at(s.slot, p === 1 ? 2 : 1);
        return `Match ${s.slot} still needs ${partner ? "one more player" : "two players"}`;
      }
    }

    const ids = [];
    TS_SLOTS.forEach((s) => {
      for (let p = 1; p <= s.cells; p++) ids.push(at(s.slot, p));
    });
    if (new Set(ids).size !== 9) return "Each player can only be named once";

    const singles = catOf(at(3, 1));
    if (singles !== "A" && singles !== "B")
      return "The singles must be played by your A or a B — not a C";

    const one = [catOf(at(1, 1)), catOf(at(1, 2))];
    if (singles === "A") {
      if (one.filter((c) => c === "B").length !== 2)
        return "Your A is playing the singles, so match 1 must be two B players";
    } else if (!(one.includes("A") && one.includes("B"))) {
      return "Match 1 must be your A with a B — your A is not in the singles";
    }

    for (const s of [2, 4]) {
      const cs = [catOf(at(s, 1)), catOf(at(s, 2))];
      if (cs.filter((c) => c === "B").length !== 1 || cs.filter((c) => c === "C").length !== 1)
        return `Match ${s} must be one B with one C`;
    }
    if ([catOf(at(5, 1)), catOf(at(5, 2))].filter((c) => c === "C").length !== 2)
      return "Match 5 must be two C players";

    if (!TS_TRUMPABLE.includes(d.trump)) return "Declare your trump on match 1, 2, 4 or 5";
    return null;
  }

  /* ---------------- the form ---------------- */
  function tsSelect(tieId, d, slot, pos) {
    const key = `${slot}.${pos}`;
    const chosen = d.p[key] || "";
    const used = new Set(
      Object.keys(d.p).filter((k) => k !== key && d.p[k]).map((k) => d.p[k])
    );
    const allow = tsAllowed(d, slot, pos);
    const opts = mySquad
      .filter((p) => p.id === chosen || (!used.has(p.id) && allow.includes(p.category)))
      .map(
        (p) =>
          `<option value="${esc(p.id)}"${p.id === chosen ? " selected" : ""}>${esc(
            p.player_name
          )} · ${esc(p.category)}</option>`
      )
      .join("");
    const cat = catOf(chosen);
    return `<label class="ts-pick${chosen ? " filled" : ""}">
        <span class="ts-pos">${slot === 3 ? "Singles" : "Player " + pos}</span>
        <span class="ts-sel">
          <select data-tie="${tieId}" data-slot="${slot}" data-pos="${pos}"
                  aria-label="Match ${slot}${slot === 3 ? "" : " player " + pos}">
            <option value="">Choose a player…</option>${opts}
          </select>
          <i class="ts-cat${cat ? " c-" + esc(cat) : " none"}">${cat ? esc(cat) : "?"}</i>
        </span>
      </label>`;
  }

  function tsForm(r) {
    const d = draftOf(r.tie_id);
    const slots = TS_SLOTS.map((s) => {
      const cells = [];
      for (let p = 1; p <= s.cells; p++) cells.push(tsSelect(r.tie_id, d, s.slot, p));
      const trump = TS_TRUMPABLE.includes(s.slot)
        ? `<label class="ts-trump${d.trump === s.slot ? " on" : ""}">
             <input type="radio" name="trump-${r.tie_id}" value="${s.slot}" data-tie="${r.tie_id}"
                    aria-label="Trump match ${s.slot}"${d.trump === s.slot ? " checked" : ""} />
             <span>Trump</span>
           </label>`
        : `<span class="ts-notrump">No trump</span>`;
      return `<div class="ts-slot${d.trump === s.slot ? " trumped" : ""}">
          <div class="ts-slot-top">
            <span class="ts-no">${s.slot}</span>
            <span class="ts-label">${esc(s.label)}</span>
            ${trump}
          </div>
          <p class="ts-note">${esc(s.note)}</p>
          <div class="ts-picks">${cells.join("")}</div>
        </div>`;
    }).join("");

    const named = tsNamed(d);
    const prob = tsProblem(d);
    return `
      ${
        r.carried
          ? '<p class="ts-carry">The organiser reopened this sheet. The names you had are still here — change what you need, or start over.</p>'
          : ""
      }
      <p class="ts-trumpline"><b>Trump</b> ${esc(TS_TRUMP_LINE)}</p>
      <div class="ts-slots">${slots}</div>
      <p class="ts-progress${prob ? "" : " ok"}">
        <b>${named} of 9 named</b>${
          prob ? " · " + esc(prob) : " · trump on match " + d.trump + " · ready to file"
        }
      </p>
      <div class="ts-err" id="ts-err-${r.tie_id}"></div>
      <div class="ts-actions">
        <button type="button" class="btn-primary ts-submit" data-tie="${r.tie_id}"${
      prob ? " disabled" : ""
    }>
          <span class="spin" aria-hidden="true"></span><span class="btn-label">File this line-up</span>
        </button>
        <button type="button" class="btn-mini ghost ts-clear" data-tie="${r.tie_id}">Start over</button>
      </div>
      <p class="ts-fine">You can file once. After that only the organiser can reopen the sheet.</p>`;
  }

  /* ---------------- the filed line-up, read only ---------------- */
  function tsFiled(r) {
    const picks = Array.isArray(r.picks) ? r.picks : [];
    const rows = TS_SLOTS.map((s) => {
      const names = picks
        .filter((p) => Number(p.slot) === s.slot)
        .sort((a, b) => a.position - b.position)
        .map(
          (p) =>
            `<span class="ts-fname"><i class="ts-cat c-${esc(p.category)}">${esc(
              p.category
            )}</i>${esc(p.player_name)}</span>`
        )
        .join("");
      const isTrump = r.trump_slot === s.slot;
      return `<div class="ts-frow${isTrump ? " trumped" : ""}">
          <span class="ts-no">${s.slot}</span>
          <div class="ts-fmain">
            <p class="ts-flabel">${esc(s.label)}${
        isTrump ? ' <b class="ts-fchip">Trump +2</b>' : ""
      }</p>
            <div class="ts-fnames">${names || '<span class="ts-fname">—</span>'}</div>
          </div>
        </div>`;
    }).join("");

    return `
      <p class="ts-msg ok">Line-up filed${
        r.submitted_at ? " at " + esc(FMT.timeOf(r.submitted_at)) : ""
      }. Only the organiser can change it now — find them courtside and ask for a reset.</p>
      <div class="ts-filed">${rows}</div>`;
  }

  /* "QF" is what the database calls it; a captain wants the word. */
  const PHASE_WORD = { group: "Group", qf: "Quarter-final", sf: "Semi-final", final: "The final" };
  const tieTag = (r) =>
    r.group_code ? `Group ${esc(r.group_code)} · Round ${esc(r.round)}` : esc(PHASE_WORD[r.phase] || String(r.phase || "").toUpperCase());

  function sheetCardHTML(r) {
    const st = tsState(r);
    const tag = tieTag(r);
    const clock =
      st === "open"
        ? `<div class="ts-clockwrap">
             <p class="ts-clocklabel">Time left</p>
             <p class="ts-clock" data-deadline="${esc(r.deadline || "")}">${mmss(
            new Date(r.deadline || 0).getTime() - Date.now()
          )}</p>
           </div>`
        : `<span class="ts-badge s-${st}">${
            { submitted: "Filed", expired: "Closed", void: "Closed" }[st]
          }</span>`;

    const head = `<header class="ts-head">
        <div class="ts-headmain">
          <p class="ts-tag">${tag}</p>
          <p class="ts-opp">vs ${esc(r.opponent || "To be confirmed")}</p>
          <p class="ts-meta">${esc(FMT.timeOf(r.starts_at))}${
      r.court ? " · Court " + r.court : ""
    }</p>
        </div>
        ${clock}
      </header>`;

    if (st === "open") return head + tsForm(r);
    if (st === "submitted") return head + tsFiled(r);
    if (st === "expired")
      return head + `<p class="ts-msg warn">The window closed. Ask the organiser to reset your sheet.</p>`;
    return head + `<p class="ts-msg warn">The organiser closed this window.</p>`;
  }

  /* ---------------- painting ---------------- */
  function renderSheets() {
    const wrap = $("#sheetCards");
    if (!wrap) return;
    const sig = sheetRows
      .map((r) => `${r.tie_id}:${tsState(r)}:${r.deadline || ""}:${r.submitted_at || ""}`)
      .join("|");
    if (sig === sheetSig) return;
    sheetSig = sig;

    // Names already in a form the organiser has just reopened. Keyed off this
    // tie's own window changing, so a repaint caused by another card never
    // accuses a captain of carrying names they are typing right now.
    sheetRows.forEach((r) => {
      const st = tsState(r);
      const dl = r.deadline || "";
      const seen = r.tie_id in sheetSeen;
      const moved = seen && (sheetSeen[r.tie_id].st !== st || sheetSeen[r.tie_id].dl !== dl);
      sheetSeen[r.tie_id] = { st, dl };
      r.carried = moved && st === "open" && tsNamed(draftOf(r.tie_id)) > 0;
    });

    if (!sheetRows.length) {
      wrap.innerHTML = `<p class="empty">The organiser hasn't opened a team sheet yet. Leave this page open — it wakes up on its own the moment they do.</p>`;
      $("#sheetNote").textContent = "";
    } else {
      wrap.innerHTML = sheetRows
        .map(
          (r) => `<article class="ts is-${tsState(r)}" id="ts-${r.tie_id}">${sheetCardHTML(r)}</article>`
        )
        .join("");
      $("#sheetNote").textContent = "Your line-up is sealed — the opposition never sees it.";
    }

    // A captain in a noisy hall is not watching the tab strip; the dot is.
    document
      .querySelector('.cap-tab[data-cap="sheet"]')
      ?.classList.toggle("nag", sheetRows.some((r) => tsState(r) === "open"));
  }

  /* One card only, so choosing a player never disturbs the other ties. */
  function repaintSheet(tieId) {
    const r = sheetRows.find((x) => x.tie_id === tieId);
    const el = document.getElementById("ts-" + tieId);
    if (!r || !el) return;
    el.className = "ts is-" + tsState(r);
    el.innerHTML = sheetCardHTML(r);
  }

  /* ---------------- loading ---------------- */
  async function loadSheets() {
    const [ms, fm] = await Promise.all([
      sb.rpc("my_sheets"),
      sb.from("tournament_format").select("slot,label,note,kind").order("slot"),
    ]);
    if (!fm.error && fm.data) {
      fm.data.forEach((f) => {
        const s = TS_SLOTS.find((x) => x.slot === f.slot);
        if (!s) return;
        if (f.label) s.label = f.label;
        if (f.note) s.note = f.note;
      });
    }
    if (ms.error) {
      $("#sheetCards").innerHTML = "";
      $("#sheetNote").textContent =
        "Couldn't load your team sheets: " + (ms.error.message || ms.error);
      return;
    }
    sheetRows = ms.data || [];
    seedDrafts();
    sheetSig = null;
    renderSheets();
    if (!sheetTimer) sheetTimer = setInterval(tickSheets, 1000);
    startSheetRealtime();
  }

  let refreshingSheets = false;
  async function refreshSheets() {
    if (refreshingSheets) return;
    refreshingSheets = true;
    const { data, error } = await sb.rpc("my_sheets");
    refreshingSheets = false;
    if (error) return;
    sheetRows = data || [];
    seedDrafts();
    renderSheets();
  }

  /* A sheet the organiser filed, or one this phone filed before a reload,
     comes back with its picks. Pre-load them so a reset costs nine taps of
     correction rather than nine taps of retyping. */
  function seedDrafts() {
    sheetRows.forEach((r) => {
      if (sheetDraft[r.tie_id]) return;
      const picks = Array.isArray(r.picks) ? r.picks : [];
      if (!picks.length) return;
      const d = draftOf(r.tie_id);
      picks.forEach((p) => (d.p[`${p.slot}.${p.position}`] = p.squad_id));
      d.trump = r.trump_slot ?? null;
    });
  }

  function tickSheets() {
    if (!sheetRows.length) return;
    let flip = false;
    document.querySelectorAll("#capSheet .ts-clock").forEach((el) => {
      const left = new Date(el.dataset.deadline).getTime() - Date.now();
      if (left <= 0) {
        el.textContent = "00:00";
        flip = true;
        return;
      }
      el.textContent = mmss(left);
      el.classList.toggle("hot", left < 120000);
    });
    // The clock hitting zero locks the form without anyone touching the page.
    if (flip) renderSheets();
    // Stadium wifi drops the socket silently. A slow poll means an organiser's
    // reset still lands even when realtime has gone to sleep.
    if (++sheetTick % 30 === 0 && !document.hidden) {
      refreshSheets();
      refreshFixtures();
    }
  }

  let sheetChannel = null;
  function startSheetRealtime() {
    if (sheetChannel) return;
    try {
      sheetChannel = sb
        .channel("sheets-" + myTeamId)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "team_sheets", filter: `team_id=eq.${myTeamId}` },
          () => refreshSheets()
        )
        // the running score on My Matches, without the captain reloading
        .on("postgres_changes", { event: "*", schema: "public", table: "tournament_ties" }, () =>
          refreshFixtures()
        )
        .subscribe();
    } catch {
      // the slow poll in tickSheets still covers it
    }
  }

  /* ---------------- interaction ---------------- */
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (!el || !el.dataset || !el.dataset.tie || !el.closest || !el.closest("#capSheet")) return;
    const tie = Number(el.dataset.tie);
    const d = draftOf(tie);
    if (el.tagName === "SELECT") d.p[`${el.dataset.slot}.${el.dataset.pos}`] = el.value || null;
    else if (el.type === "radio") d.trump = Number(el.value);
    else return;
    const row = sheetRows.find((x) => x.tie_id === tie);
    if (row) row.carried = false;   // they have taken the hint
    repaintSheet(tie);
  });

  document.addEventListener("click", (e) => {
    const clr = e.target.closest && e.target.closest(".ts-clear");
    if (clr) {
      // Two taps to wipe nine names: a thumb in a crowd should not be able to
      // destroy a line-up by brushing the wrong button.
      if (clr.dataset.armed !== "1") {
        clr.dataset.armed = "1";
        clr.textContent = "Tap again to clear";
        clr.classList.add("armed");
        setTimeout(() => {
          if (!clr.isConnected || clr.dataset.armed !== "1") return;
          clr.dataset.armed = "";
          clr.textContent = "Start over";
          clr.classList.remove("armed");
        }, 4000);
        return;
      }
      const tie = Number(clr.dataset.tie);
      sheetDraft[tie] = { p: {}, trump: null };
      const row = sheetRows.find((x) => x.tie_id === tie);
      if (row) row.carried = false;
      repaintSheet(tie);
      return;
    }
    const sub = e.target.closest && e.target.closest(".ts-submit");
    if (sub) submitSheet(Number(sub.dataset.tie), sub);
  });

  async function submitSheet(tieId, btn) {
    const d = draftOf(tieId);
    const err = document.getElementById("ts-err-" + tieId);
    const show = (m) => {
      if (!err) return toast(m, "err");
      err.textContent = m;
      err.classList.remove("show");
      void err.offsetWidth;
      err.classList.add("show");
    };

    const prob = tsProblem(d);
    if (prob) return show(prob);

    const picks = [];
    TS_SLOTS.forEach((s) => {
      for (let p = 1; p <= s.cells; p++)
        picks.push({ slot: s.slot, position: p, squad_id: d.p[`${s.slot}.${p}`] });
    });

    busy(btn, true);
    const { data, error } = await sb.rpc("sheet_submit", {
      p_tie_id: tieId,
      p_picks: picks,
      p_trump: d.trump,
    });
    busy(btn, false);

    if (error) {
      // The server is the authority on the format. Say exactly what it said.
      show(error.message || String(error));
      toast("Line-up not accepted", "err");
      return;
    }

    const row = Array.isArray(data) ? data[0] : data;
    const i = sheetRows.findIndex((x) => x.tie_id === tieId);
    if (i > -1) {
      sheetRows[i] = Object.assign({}, sheetRows[i], {
        status: row?.status || "submitted",
        submitted_at: row?.submitted_at || new Date().toISOString(),
        trump_slot: row?.trump_slot ?? d.trump,
        picks: picks.map((p) => ({
          slot: p.slot,
          position: p.position,
          squad_id: p.squad_id,
          player_name: squadById(p.squad_id)?.player_name || "",
          category: catOf(p.squad_id) || "",
        })),
      });
    }
    renderSheets();
    toast("Line-up filed. Good luck.", "ok");
    refreshSheets();
  }

  // Phones suspend background tabs; coming back must not show a stale clock.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !SHOW_AUCTION && myTeamId !== null) {
      refreshSheets();
      refreshFixtures();
    }
  });


  window.addEventListener("DOMContentLoaded", boot);
})();
