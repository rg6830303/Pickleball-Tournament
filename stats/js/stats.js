/* ============================================================
   MPL LIVE SCOREBOARD — mplstats.vercel.app
   Public, no login, read-only. Everything on this page comes out
   of the public_* views with the anon key; nothing is ever written.
   Realtime on match_results + tournament_ties keeps it moving, and
   a 30s poll covers the case where a venue network eats websockets.
   ============================================================ */
(() => {
  "use strict";

  const CFG = window.MPL_STATS_CONFIG;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  /* Kolkata time wherever the page is opened — a parent watching from
     another zone still reads the same start time as the court. */
  const IST_TIME = { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true };
  const IST_CLOCK = { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false };
  const timeOf = (iso) =>
    iso ? new Intl.DateTimeFormat("en-IN", IST_TIME).format(new Date(iso)).toUpperCase() : "TBC";
  const clockNow = () => new Intl.DateTimeFormat("en-GB", IST_CLOCK).format(new Date());

  const GROUPS = ["A", "B", "C", "D"];
  const PHASES = [
    { key: "qf", head: "Quarter-finals", tag: "QF" },
    { key: "sf", head: "Semi-finals", tag: "SF" },
    { key: "final", head: "The Final", tag: "Final" },
  ];

  let sb = null;
  let channel = null;
  let live = false;              // realtime socket actually subscribed
  let firstPaint = true;

  const D = { teams: [], standings: [], fixtures: [], results: [], squads: [], format: [], ledger: [], lineups: [], sheets: [], phase: null };
  const openLedger = new Set();  // team ids whose working is showing
  const openTies = new Set();    // tie ids the reader has expanded
  const openSquads = new Set();  // team ids the reader has expanded
  const lastScore = new Map();   // tie id -> "h-a", so a changed tie can flash

  /* ---------------- data ---------------- */

  async function load() {
    const q = [
      sb.from("public_teams").select("*").order("group_code").order("id"),
      sb.from("public_standings").select("*").order("group_code").order("rank"),
      sb.from("public_fixtures").select("*").order("sort_order"),
      sb.from("public_results").select("*").order("tie_id").order("slot"),
      sb.from("public_squads").select("*").order("team_id").order("sort_order"),
      sb.from("tournament_format").select("*").order("slot"),
      sb.from("points_ledger").select("*").order("team_id").order("tie_id"),
      sb.from("public_lineups").select("*").order("tie_id").order("slot").order("position"),
      sb.from("public_sheet_status").select("*"),
      sb.from("public_phase").select("*").maybeSingle(),
    ];
    const [teams, standings, fixtures, results, squads, format, ledger, lineups, sheets, phase] = await Promise.all(q);
    const bad = [teams, standings, fixtures, results, squads, format, ledger, lineups, sheets, phase].find((r) => r.error);
    if (bad) throw bad.error;

    D.teams = teams.data || [];
    D.standings = standings.data || [];
    D.fixtures = fixtures.data || [];
    D.results = results.data || [];
    D.squads = squads.data || [];
    D.format = format.data || [];
    D.ledger = ledger.data || [];
    D.lineups = lineups.data || [];
    D.sheets = sheets.data || [];
    D.phase = phase.data || null;
  }

  let refreshing = false;
  let queued = false;

  async function refresh() {
    // One score entry can fire three realtime events (the insert, then the
    // tie recount). Collapse them into a single read instead of stampeding.
    if (refreshing) { queued = true; return; }
    refreshing = true;
    try {
      await load();
      renderAll();
      stamp(true);
    } catch (err) {
      stamp(false, err.message || String(err));
    } finally {
      refreshing = false;
      if (queued) { queued = false; refresh(); }
    }
  }

  let bumpTimer = null;
  const bump = () => {
    clearTimeout(bumpTimer);
    bumpTimer = setTimeout(refresh, 250);
  };

  /* ---------------- shared bits ---------------- */

  const resultsOf = (tieId) => D.results.filter((r) => r.tie_id === tieId);
  const isUpcoming = (t) => t.status === "scheduled" && !resultsOf(t.id).length;
  const signed = (n) => (Number(n) > 0 ? "+" + n : String(Number(n) || 0));

  function stamp(ok, msg) {
    const el = $("#stamp");
    if (!ok) {
      el.className = "stamp bad";
      el.textContent = "Could not reach the scoreboard — retrying. " + (msg || "");
      return;
    }
    el.className = "stamp";
    el.innerHTML =
      `updated <b>${esc(clockNow())}</b> <span class="stamp-sep">·</span> ` +
      (live ? `<span class="stamp-live">live</span>` : `<span class="stamp-poll">refreshing every 30s</span>`);
  }

  /* ---------------- 1. hero ---------------- */

  function renderHero() {
    $("#heroSeason").textContent = `${CFG.EVENT.season} — Live Scoreboard`;

    setCount("#cTeams", D.teams.length);
    setCount("#cPlayers", D.squads.length);
    setCount("#cTies", D.fixtures.length);
    setCount("#cMatches", D.results.length);

    const liveTies = D.fixtures.filter((t) => t.status === "live");
    const box = $("#heroLive");
    box.hidden = liveTies.length === 0;
    if (liveTies.length === 1) {
      const t = liveTies[0];
      $("#heroLiveText").textContent =
        `Live now — ${t.home_name} v ${t.away_name}${t.court ? " · Court " + t.court : ""}`;
    } else if (liveTies.length > 1) {
      $("#heroLiveText").textContent = `${liveTies.length} ties live now`;
    }
  }

  function setCount(sel, n) {
    const el = $(sel);
    const was = el.textContent;
    el.textContent = String(n);
    // A venue screen is read from across the room: a number that moves has to
    // announce itself. Never on the first paint, or the whole row blinks.
    if (!firstPaint && was !== String(n)) {
      el.classList.remove("tick");
      void el.offsetWidth;
      el.classList.add("tick");
    }
  }

  /* ---------------- 2. the scoreboard ---------------- */

  const COLS = [
    ["MP", "Matches played"],
    ["W", "Matches won"],
    ["L", "Matches lost"],
    ["PS", "Points scored"],
    ["PC", "Points conceded"],
    ["PD", "Point difference"],
  ];

  function renderStandings() {
    const host = $("#groups");
    if (!D.standings.length) {
      host.innerHTML = `<p class="empty">The tables open when the first score is entered.</p>`;
      return;
    }

    host.innerHTML = GROUPS.map((g) => {
      const rows = D.standings.filter((s) => s.group_code === g);
      if (!rows.length) return "";
      return `
        <article class="grp">
          <div class="grp-head">
            <span class="grp-badge">${esc(g)}</span>
            <h3 class="grp-name">Group ${esc(g)}</h3>
            <span class="grp-note">Top 2 qualify</span>
          </div>
          <div class="tbl-wrap">
            <table class="tbl">
              <thead>
                <tr>
                  <th class="c-grp">Group</th>
                  <th class="c-rank">Rank</th>
                  <th class="c-team">Team</th>
                  ${COLS.map(([k, t]) => `<th class="c-n"><abbr title="${esc(t)}">${k}</abbr></th>`).join("")}
                  <th class="c-pts">Pts</th>
                </tr>
              </thead>
              <tbody>${rows.map(teamRow).join("")}</tbody>
            </table>
          </div>
          <p class="tbl-hint">Swipe the table sideways for W · L · PS · PC · PD · Pts</p>
        </article>`;
    }).join("");

    // A tap anywhere on the row opens its working; the caret is only a hint.
    $$("tr.can-open", host).forEach((tr) => {
      const toggle = () => {
        const id = Number(tr.dataset.team);
        openLedger.has(id) ? openLedger.delete(id) : openLedger.add(id);
        renderStandings();
      };
      tr.addEventListener("click", toggle);
      tr.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
      });
    });
  }

  function teamRow(s) {
    const q = Number(s.rank) <= 2;
    const pd = Number(s.point_diff);
    const open = openLedger.has(s.team_id);
    const lines = D.ledger.filter((l) => l.team_id === s.team_id);
    return `
      <tr class="${q ? "q" : ""}${lines.length ? " can-open" : ""}${open ? " open" : ""}"
          data-team="${s.team_id}"${lines.length ? ' tabindex="0" role="button" aria-expanded="' + open + '"' : ""}>
        <td class="c-grp"><span class="mini-badge">${esc(s.group_code)}</span></td>
        <td class="c-rank"><span class="rank">${esc(s.rank)}</span>${
          q ? `<span class="qchip" title="In a qualifying place">Q</span>` : ""
        }</td>
        <td class="c-team">
          <span class="tname">${esc(s.team_name)}</span>
          <span class="tcap">${esc(s.captain_name || "")}</span>
        </td>
        <td class="c-n">${esc(s.matches_played)}</td>
        <td class="c-n win">${esc(s.won)}</td>
        <td class="c-n">${esc(s.lost)}</td>
        <td class="c-n">${esc(s.points_for)}</td>
        <td class="c-n">${esc(s.points_against)}</td>
        <td class="c-n pd ${pd > 0 ? "up" : pd < 0 ? "down" : ""}">${esc(signed(pd))}</td>
        <td class="c-pts"><b>${esc(s.points)}</b>${
          lines.length ? `<i class="pts-caret" aria-hidden="true">▾</i>` : ""
        }</td>
      </tr>${lines.length ? ledgerRow(s, lines, open) : ""}`;
  }

  /* The working, on the public page: anyone can check a total without
     taking anyone's word for it. */
  function ledgerRow(s, lines, open) {
    const total = lines.reduce((n, l) => n + Number(l.points), 0);
    return `
      <tr class="led-row${open ? "" : " hide"}" data-led="${s.team_id}">
        <td colspan="10">
          <p class="led-h">How ${esc(s.team_name)} reached ${esc(s.points)} points</p>
          <ul class="led-lines">
            ${lines
              .map(
                (l) => `
              <li class="${Number(l.points) < 0 ? "neg" : ""}">
                <span class="led-when">${esc(
                  l.group_code ? "G" + l.group_code + " R" + l.round : String(l.phase).toUpperCase()
                )} v ${esc(l.opponent_name || "—")}</span>
                <span class="led-what">${esc(l.slot_label)}</span>
                <span class="led-why">${esc(l.detail)}</span>
                <b class="led-p">${Number(l.points) > 0 ? "+" : ""}${esc(l.points)}</b>
              </li>`
              )
              .join("")}
          </ul>
          <p class="led-total">Total ${total}</p>
        </td>
      </tr>`;
  }

  const LEGEND = [
    { v: "3", t: "Win a match", tone: "red" },
    { v: "1", t: "Lose by 2 points or less" },
    { v: "0", t: "Lose by more than 2" },
    { v: "+2", t: "Clean sweep — all 5 matches", tone: "red" },
    { v: "+2", t: "Win your trump match", tone: "red" },
    { v: "−2", t: "Lose a trump both teams called", tone: "down" },
    { v: "11", t: "Every game is to 11" },
  ];

  function renderLegend() {
    $("#legend").innerHTML =
      `<p class="legend-h">How points are won</p>
       <ul class="legend-list">
         ${LEGEND.map((l) => `<li><b class="${l.tone || ""}">${l.v}</b><span>${esc(l.t)}</span></li>`).join("")}
       </ul>`;
  }

  /* ---------------- 3. run of show ---------------- */

  function renderTies() {
    const host = $("#ties");
    const group = D.fixtures.filter((t) => t.phase === "group");
    if (!group.length) {
      host.innerHTML = `<p class="empty">The schedule will appear here.</p>`;
      return;
    }
    host.innerHTML = group.map(tieBlock).join("");
    // <details> toggle does not bubble, so it cannot be delegated; the nodes
    // are replaced on every render anyway, so re-binding costs nothing.
    $$("details.tie", host).forEach((d) => {
      d.addEventListener("toggle", () => {
        const id = Number(d.dataset.tie);
        if (d.open) openTies.add(id); else openTies.delete(id);
      });
    });
  }

  function tieBlock(t) {
    const up = isUpcoming(t);
    const rs = resultsOf(t.id);
    const hs = Number(t.home_score || 0);
    const as = Number(t.away_score || 0);

    const key = up ? "" : `${hs}-${as}`;
    const changed = !firstPaint && lastScore.has(t.id) && lastScore.get(t.id) !== key;
    lastScore.set(t.id, key);

    const homeWon = Boolean(t.winner_team_id) && t.winner_team_id === t.home_team_id;
    const awayWon = Boolean(t.winner_team_id) && t.winner_team_id === t.away_team_id;

    // All five played and still nobody ahead: the rules send it to a 7-point
    // shootout, so say that rather than leaving a blank winner.
    const level = !up && t.status === "done" && !t.winner_team_id;
    const state = up
      ? `<span class="chip up">Upcoming</span>`
      : t.status === "live"
      ? `<span class="chip live"><i class="pulse"></i>Live</span>`
      : level
      ? `<span class="chip lvl" title="Level on matches — decided by a 7-point shootout">Level</span>`
      : `<span class="chip done">Full time</span>`;

    // A tie with no scores must never read as 0–0, so it shows a "v" instead.
    const score = up
      ? `<span class="tie-score v">v</span>`
      : `<span class="tie-score"><b class="${homeWon ? "w" : ""}">${hs}</b><i>–</i><b class="${
          awayWon ? "w" : ""
        }">${as}</b></span>`;

    return `
      <details class="tie${up ? " is-up" : ""}${t.status === "live" ? " is-live" : ""}${changed ? " fresh" : ""}"
               data-tie="${t.id}"${openTies.has(t.id) ? " open" : ""}>
        <summary class="tie-sum">
          <span class="tie-when">
            <b>${esc(timeOf(t.starts_at))}</b>
            <span>${t.court ? "Court " + esc(t.court) : "Court TBC"}</span>
          </span>
          <span class="tie-tag">Group ${esc(t.group_code)} <i>·</i> R${esc(t.round)}</span>
          <span class="tie-teams">
            <span class="side home${homeWon ? " won" : ""}">${esc(t.home_name)}</span>
            ${score}
            <span class="side away${awayWon ? " won" : ""}">${esc(t.away_name)}</span>
          </span>
          <span class="tie-state">${state}${
            t.decided_by === "shootout" ? `<span class="chip so">Shootout</span>` : ""
          }</span>
          <span class="tie-caret" aria-hidden="true"></span>
        </summary>
        <div class="tie-body">${matchTable(t, rs)}${lineupBlock(t)}</div>
      </details>`;
  }

  /* Who actually took the court, once it is safe to say.
     A filed sheet is sealed until nobody is still waiting to name their
     team — otherwise this page would hand a captain the opposition. */
  function lineupBlock(t) {
    const rows = D.lineups.filter((l) => l.tie_id === t.id);
    const status = D.sheets.find((s) => s.tie_id === t.id);

    if (!rows.length) {
      if (!status || !status.filed) return "";
      return `
        <div class="lu lu-sealed">
          <p class="lu-h">Team sheets</p>
          <p class="lu-note">${esc(status.filed)} of ${esc(status.required)} filed${
            status.window_open ? " — the window is still open" : ""
          }. Line-ups are published once both captains are in.</p>
        </div>`;
    }

    const sides = ["home", "away"].map((side) => {
      const mine = rows.filter((r) => r.side === side);
      if (!mine.length) return "";
      const name = mine[0].team_name;
      const slots = [...new Set(mine.map((r) => r.slot))].sort((a, b) => a - b);
      return `
        <div class="lu-side">
          <p class="lu-team">${esc(name)}</p>
          <ol class="lu-slots">
            ${slots
              .map((slot) => {
                const players = mine.filter((r) => r.slot === slot);
                const trump = players[0].is_trump;
                return `
                <li class="lu-slot${trump ? " is-trump" : ""}">
                  <span class="lu-no">${esc(slot)}</span>
                  <span class="lu-what">${esc(players[0].slot_label)}${
                  trump ? `<em class="lu-trump">Trump</em>` : ""
                }</span>
                  <span class="lu-who">${players
                    .map(
                      (p) =>
                        `<span class="lu-p"><i class="lu-cat c-${esc(p.category)}">${esc(
                          p.category
                        )}</i>${esc(p.player_name)}</span>`
                    )
                    .join("")}</span>
                </li>`;
              })
              .join("")}
          </ol>
        </div>`;
    });

    return `
      <div class="lu">
        <p class="lu-h">Team sheets as filed</p>
        <div class="lu-grid">${sides.join("")}</div>
      </div>`;
  }

  function matchTable(t, rs) {
    const slots = D.format.length
      ? D.format
      : [1, 2, 3, 4, 5].map((slot) => ({ slot, label: "Match " + slot, kind: "" }));
    const bySlot = new Map(rs.map((r) => [r.slot, r]));

    const rows = slots.map((f) => {
      const r = bySlot.get(f.slot);
      const label = esc(r?.slot_label || f.label || "Match " + f.slot);
      const kind = esc(r?.kind || f.kind || "");
      if (!r) {
        return `
          <div class="m pending">
            <span class="m-no">${esc(f.slot)}</span>
            <span class="m-label">${label}${kind ? `<em>${kind}</em>` : ""}</span>
            <span class="m-pt none">—</span>
            <span class="m-pt none">—</span>
          </div>`;
      }
      const hp = Number(r.home_points);
      const ap = Number(r.away_points);
      return `
        <div class="m">
          <span class="m-no">${esc(f.slot)}</span>
          <span class="m-label">${label}${kind ? `<em>${kind}</em>` : ""}${
            r.note ? `<small class="m-note">${esc(r.note)}</small>` : ""
          }</span>
          <span class="m-pt${hp > ap ? " win" : ""}">${hp}${
            r.home_trump ? `<i class="trump" title="Declared trump">Trump</i>` : ""
          }</span>
          <span class="m-pt${ap > hp ? " win" : ""}">${ap}${
            r.away_trump ? `<i class="trump" title="Declared trump">Trump</i>` : ""
          }</span>
        </div>`;
    });

    return `
      <div class="m-head">
        <span class="m-no">#</span>
        <span class="m-label">Match</span>
        <span class="m-pt">${esc(t.home_name)}</span>
        <span class="m-pt">${esc(t.away_name)}</span>
      </div>
      ${rows.join("")}
      ${
        rs.length
          ? ""
          : `<p class="m-empty">Not played yet — the five matches land here as the organiser enters them.</p>`
      }`;
  }

  /* ---------------- 4. the ladder ---------------- */

  function renderLadder() {
    const host = $("#ladder");
    const ko = D.fixtures.filter((t) => t.phase !== "group");
    if (!ko.length) {
      host.innerHTML = `<p class="empty">The knockout ladder is drawn once the groups are done.</p>`;
      return;
    }
    host.innerHTML = PHASES.map((p) => {
      const ties = ko.filter((t) => t.phase === p.key);
      if (!ties.length) return "";
      return `
        <div class="lad-col">
          <p class="lad-col-h">${esc(p.head)}</p>
          ${ties.map((t, i) => ladBox(t, i, p)).join("")}
        </div>`;
    }).join("");
  }

  function ladBox(t, i, p) {
    const up = isUpcoming(t);
    const homeWon = Boolean(t.winner_team_id) && t.winner_team_id === t.home_team_id;
    const awayWon = Boolean(t.winner_team_id) && t.winner_team_id === t.away_team_id;
    const tag = p.key === "final" ? "Final" : `${p.tag}${i + 1}`;
    const num = (v, won) => `<b class="lad-n${won ? " w" : ""}">${esc(Number(v || 0))}</b>`;

    return `
      <div class="lad-tie${p.key === "final" ? " final" : ""}${t.status === "live" ? " is-live" : ""}">
        <p class="lad-tag">${esc(tag)}${
          t.starts_at
            ? `<span>${esc(timeOf(t.starts_at))}${t.court ? " · Court " + esc(t.court) : ""}</span>`
            : ""
        }</p>
        <p class="lad-row${homeWon ? " won" : ""}">
          <span class="lad-side${t.home_team_id ? "" : " pending"}">${esc(t.home_name || "TBC")}</span>
          ${up ? `<b class="lad-n none">—</b>` : num(t.home_score, homeWon)}
        </p>
        <p class="lad-row${awayWon ? " won" : ""}">
          <span class="lad-side${t.away_team_id ? "" : " pending"}">${esc(t.away_name || "TBC")}</span>
          ${up ? `<b class="lad-n none">—</b>` : num(t.away_score, awayWon)}
        </p>
      </div>`;
  }

  /* ---------------- 5. squads ---------------- */

  function renderSquads() {
    const host = $("#squads");
    if (!D.squads.length) {
      host.innerHTML = `<p class="empty">Squads appear once the auction is settled.</p>`;
      return;
    }

    const byTeam = new Map();
    for (const p of D.squads) {
      if (!byTeam.has(p.team_id)) byTeam.set(p.team_id, []);
      byTeam.get(p.team_id).push(p);
    }

    // Group order first, then the group-table order, so a reader hunting for
    // "the team second in Group C" finds it where they expect it.
    const rankOf = new Map(D.standings.map((s) => [s.team_id, Number(s.rank)]));
    const teams = Array.from(byTeam.keys()).sort((a, b) => {
      const A = byTeam.get(a)[0];
      const B = byTeam.get(b)[0];
      return (
        String(A.group_code).localeCompare(String(B.group_code)) ||
        (rankOf.get(a) || 99) - (rankOf.get(b) || 99) ||
        String(A.team_name).localeCompare(String(B.team_name))
      );
    });

    const capOf = new Map(D.teams.map((t) => [t.id, t.captain_name]));

    host.innerHTML = teams
      .map((id) => {
        const list = byTeam.get(id);
        const t = list[0];
        return `
          <details class="squad" data-team="${id}"${openSquads.has(id) ? " open" : ""}>
            <summary class="squad-sum">
              <span class="mini-badge">${esc(t.group_code)}</span>
              <span class="squad-name">${esc(t.team_name)}</span>
              <span class="squad-cap">${esc(capOf.get(id) || "")}</span>
              <span class="squad-n">${list.length}</span>
              <span class="tie-caret" aria-hidden="true"></span>
            </summary>
            <ol class="squad-list">
              ${list
                .map(
                  (p) => `
                <li>
                  <span class="cat cat-${esc(p.category)}">${esc(p.category)}</span>
                  <span class="pname">${esc(p.player_name)}</span>
                  ${p.retained ? `<span class="tag-r" title="Retained player">R</span>` : ""}
                </li>`
                )
                .join("")}
            </ol>
          </details>`;
      })
      .join("");

    $$("details.squad", host).forEach((d) => {
      d.addEventListener("toggle", () => {
        const id = Number(d.dataset.team);
        if (d.open) openSquads.add(id); else openSquads.delete(id);
      });
    });
  }

  /* ---------------- paint ---------------- */

  /* The group stage ends and the day changes shape: the knockouts stop
     being a promise and become the thing everyone is watching. The page
     rearranges itself to say so — nobody should have to scroll past four
     finished tables to find out who is in the semi-final. */
  function renderPhase() {
    const ph = D.phase;
    const body = document.body;
    if (!ph) return;

    const done = Boolean(ph.group_complete);
    body.classList.toggle("playoffs", done);

    const ladder = $("#sec-ladder");
    const standings = $("#sec-standings");
    if (done && ladder && standings && ladder.compareDocumentPosition(standings) & Node.DOCUMENT_POSITION_PRECEDING) {
      standings.parentNode.insertBefore(ladder, standings);
    }

    const sub = $("#h-ladder")?.parentElement?.querySelector(".sec-sub");
    const champ = ph.champion_name;
    if (sub) {
      sub.innerHTML = champ
        ? `<b class="champ-line">${esc(champ)} are the champions of Season 1.</b>`
        : done
        ? `Group stage complete — the top two of every group are through. ` +
          `${esc(ph.knockouts_done)} of 7 knockout ties played.`
        : `Quarter-finals, semi-finals and the final. The bracket fills in the moment the last group tie is scored ` +
          `(${esc(ph.group_ties_done)} of ${esc(ph.group_ties)} done).`;
    }

    const banner = $("#phaseBanner");
    if (banner) {
      if (champ) {
        banner.hidden = false;
        banner.className = "phase-banner champ";
        banner.innerHTML = `<span class="pb-k">Champions</span><b>${esc(champ)}</b>`;
      } else if (done) {
        banner.hidden = false;
        banner.className = "phase-banner";
        const qs = D.standings.filter((x) => Number(x.rank) <= 2).map((x) => x.team_name);
        banner.innerHTML =
          `<span class="pb-k">Knockouts</span><b>Group stage complete</b>` +
          `<span class="pb-q">${qs.map((n) => `<i>${esc(n)}</i>`).join("")}</span>`;
      } else {
        banner.hidden = true;
      }
    }
  }

  function renderAll() {
    renderHero();
    renderStandings();
    renderTies();
    renderLadder();
    renderPhase();
    renderSquads();
    firstPaint = false;
    document.body.dataset.ready = "1";
  }

  /* ---------------- boot ---------------- */

  function boot() {
    renderLegend();
    // Each fact stays whole; the spaces around the dots are the only places
    // the line is allowed to break, so a phone never splits "9:00 AM".
    $("#heroMeta").innerHTML = [CFG.EVENT.when, CFG.EVENT.venue, CFG.EVENT.firstServe]
      .map((f) => `<span>${esc(f)}</span>`)
      .join(` <i>·</i> `);

    if (!window.supabase || !CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) {
      stamp(false, "The scoreboard is not wired to a database yet.");
      return;
    }

    // No session, no storage, no login — this page must never hold a token.
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });

    refresh();

    channel = sb
      .channel("mpl-stats")
      .on("postgres_changes", { event: "*", schema: "public", table: "match_results" }, bump)
      .on("postgres_changes", { event: "*", schema: "public", table: "tournament_ties" }, bump)
      .subscribe((status) => {
        const was = live;
        live = status === "SUBSCRIBED";
        if (live && !was) refresh();
        else stamp(true);
      });

    setInterval(refresh, CFG.POLL_MS || 30000);

    // A phone that has been in a pocket for an hour should not show an
    // hour-old table for the next thirty seconds.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refresh();
    });
  }

  document.readyState === "loading"
    ? document.addEventListener("DOMContentLoaded", boot)
    : boot();
})();
