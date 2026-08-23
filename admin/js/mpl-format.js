/* ============================================================
   MPL SEASON 1 — MATCH FORMAT & RULES
   The wording printed on the Match Day pack, kept in one place so
   the console and the captain app can never drift apart. Copied
   byte-for-byte into auction/js/ — edit both, or neither.
   ============================================================ */
(() => {
  "use strict";

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  const DATA = {
    when: "Sunday 23 August 2026",
    where: "Sportsplex, Kolkata",
    firstServe: "First serve 9:00 AM",

    headline: "5 matches · 9 players a side · service game to 11",

    /* the five matches of every tie, in the order they are played */
    tie: [
      { slot: 1, label: "AB Doubles", note: "Your Category A player with a Category B player" },
      { slot: 2, label: "BC Doubles", note: "One Category B player with a Category C player" },
      { slot: 3, label: "B Singles",  note: "A single Category B player" },
      { slot: 4, label: "BC Doubles", note: "A second B + C pair — different players" },
      { slot: 5, label: "CC Doubles", note: "Two Category C players" },
    ],

    scoring: [
      { what: "Win the match", value: "3 points", tone: "red" },
      { what: "Lose by 2 points or less", value: "1 point" },
      { what: "Lose by more than 2 points", value: "0 points" },
      { what: "Clean sweep — all 5 matches of the tie", value: "+2 bonus", tone: "red" },
      { what: "Every game — group stage to the final", value: "Game to 11", tone: "red" },
    ],

    levers: [
      {
        title: "The Trump Match",
        value: "+2 points",
        body:
          "Declare any 1 doubles match of the tie as your TRUMP before the tie begins. " +
          "Win it and the bonus is yours. If both teams trump the same match: winner +2, loser −2.",
      },
      {
        title: "Mixed Doubles Advantage",
        value: "−3 start",
        body:
          "A mixed pair (male + female) against a men's pair starts the opposing men's pair " +
          "at −3 points. Applies to any doubles match in the tie.",
      },
    ],

    replacements: [
      {
        title: "In-tournament injury",
        points: [
          "Injured mid-tournament: the opponent offers 2 players from the same category and the affected owner picks 1.",
          "Exception: for an injured Category A player, replacements are offered from the B category.",
        ],
      },
      {
        title: "After a disqualification",
        points: [
          "The match in progress is awarded to the opposing team.",
          "For every remaining tie the opposition nominates 2 players of the same category — B in place of an A — and the penalised team picks 1.",
        ],
      },
    ],

    general: [
      "Only players who have completed their registration are eligible. No refunds for backouts.",
      "Groups A & B report at 8:30 AM. Groups C & D report 30 minutes before their scheduled tie.",
      "Team sheets to be submitted before every tie, as directed by the organisers.",
      "No demands for scheduling will be entertained.",
      "Any tie is decided by a 7-point Open Doubles shootout.",
    ],

    conduct: [
      "Fun banter is welcome — abusive language and intimidation are not.",
      "Match-fixing of any kind — immediate elimination.",
      "Show sportsmanship at all times — respect opponents, referees and volunteers.",
      "Referee's decision is final on court. Organisers' call is final on all disputes.",
      "Misconduct: one warning, then disqualification for the rest of the tournament, no refund of the player fee and a ban from further MPL editions.",
    ],

    ladderNote:
      "Top two from every group qualify. A group winner meets the runner-up of the paired group, " +
      "never its own. Group A pairs with B, Group C with D. Knockouts run back to back — " +
      "quarter-finals, semi-finals and the final all to 11.",

    courtsByGroup: { A: "Courts 1 & 3", B: "Courts 4 & 6", C: "Courts 1 & 3", D: "Courts 4 & 6" },
  };

  /* ---- the five matches, as a strip ---- */
  function tieStrip() {
    return `
      <div class="fmt-strip">
        <p class="fmt-strip-head">Every tie <span>${esc(DATA.headline)}</span></p>
        <ol class="fmt-slots">
          ${DATA.tie
            .map(
              (m) => `
            <li class="fmt-slot">
              <span class="fmt-no">${m.slot}</span>
              <span class="fmt-label">${esc(m.label)}</span>
              <span class="fmt-note">${esc(m.note)}</span>
            </li>`
            )
            .join("")}
        </ol>
      </div>`;
  }

  /* ---- scoring, levers, replacements, conduct ---- */
  function rules() {
    return `
      <div class="fmt-rules">
        <section class="fmt-block">
          <h3 class="fmt-h">How points are won</h3>
          <ul class="fmt-score">
            ${DATA.scoring
              .map(
                (s) => `
              <li><span>${esc(s.what)}</span><b class="${s.tone === "red" ? "red" : ""}">${esc(s.value)}</b></li>`
              )
              .join("")}
          </ul>
        </section>

        <section class="fmt-block">
          <h3 class="fmt-h">The two levers</h3>
          <div class="fmt-levers">
            ${DATA.levers
              .map(
                (l) => `
              <div class="fmt-lever">
                <p class="fmt-lever-top"><b>${esc(l.title)}</b><span>${esc(l.value)}</span></p>
                <p class="fmt-lever-body">${esc(l.body)}</p>
              </div>`
              )
              .join("")}
          </div>
        </section>

        <section class="fmt-block">
          <h3 class="fmt-h">Replacements</h3>
          <div class="fmt-two">
            ${DATA.replacements
              .map(
                (r) => `
              <div>
                <p class="fmt-sub">${esc(r.title)}</p>
                <ul class="fmt-list">${r.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>
              </div>`
              )
              .join("")}
          </div>
        </section>

        <section class="fmt-block">
          <h3 class="fmt-h">General rules &amp; code of conduct</h3>
          <div class="fmt-two">
            <div>
              <p class="fmt-sub">General rules</p>
              <ul class="fmt-list">${DATA.general.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>
            </div>
            <div>
              <p class="fmt-sub">Code of conduct</p>
              <ul class="fmt-list">${DATA.conduct.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
            </div>
          </div>
        </section>
      </div>`;
  }

  /* ---- the knockout ladder, drawn from the qf/sf/final ties ---- */
  function ladder(ties, nameOf) {
    const of = (phase) => ties.filter((t) => t.phase === phase).sort((a, b) => a.sort_order - b.sort_order);
    const side = (t, which) =>
      esc((which === "home" ? nameOf(t.home_team_id) : nameOf(t.away_team_id)) ||
          (which === "home" ? t.home_label : t.away_label));

    const box = (t, i, tag) => `
      <div class="lad-tie">
        <p class="lad-tag">${esc(tag)} ${i + 1}</p>
        <p class="lad-side">${side(t, "home")}</p>
        <p class="lad-v">v</p>
        <p class="lad-side">${side(t, "away")}</p>
      </div>`;

    const qf = of("qf"), sf = of("sf"), fi = of("final");
    if (!qf.length && !sf.length && !fi.length) return "";

    return `
      <div class="ladder">
        <div class="lad-col">
          <p class="lad-col-h">Quarter-finals</p>
          ${qf.map((t, i) => box(t, i, "QF")).join("")}
        </div>
        <div class="lad-col">
          <p class="lad-col-h">Semi-finals</p>
          ${sf.map((t, i) => box(t, i, "SF")).join("")}
        </div>
        <div class="lad-col">
          <p class="lad-col-h">The final</p>
          ${fi.map((t) => `
            <div class="lad-tie final">
              <p class="lad-tag">Final</p>
              <p class="lad-side">${side(t, "home")}</p>
              <p class="lad-v">vs</p>
              <p class="lad-side">${side(t, "away")}</p>
            </div>`).join("")}
        </div>
      </div>
      <p class="lad-note">${esc(DATA.ladderNote)}</p>`;
  }

  /* Times are printed in Kolkata time wherever the page is opened —
     a captain on a phone set to another zone still reads the poster. */
  const IST = { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true };
  function timeOf(iso) {
    if (!iso) return "TBC";
    return new Intl.DateTimeFormat("en-IN", IST).format(new Date(iso)).toUpperCase();
  }
  function windowOf(a, b) {
    if (!a) return "To be called";
    return b ? `${timeOf(a)} – ${timeOf(b)}` : timeOf(a);
  }

  window.MPL_FORMAT = { DATA, tieStrip, rules, ladder, timeOf, windowOf, esc };
})();
