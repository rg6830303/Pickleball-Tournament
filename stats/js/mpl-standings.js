/* ============================================================
   MPL LEAGUE TABLE — one renderer, two apps

   The organiser's console and the open board must show the same
   table, so they share this file. It is copied byte-for-byte into
   stats/js/ — edit both, or neither.

   A ten-column table does not fit a phone. The old markup put the
   columns in a <table> inside a horizontal scroller, which meant the
   Points column — the only number anyone actually looks for — sat
   off-screen behind a swipe. This renders one DOM that lays itself
   out two ways: full columns on a laptop, and on a phone a row per
   team with the points kept where the eye lands first.
   ============================================================ */
(() => {
  "use strict";

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  const GROUPS = ["A", "B", "C", "D"];

  /* label, key, and the long form a screen reader (or a tooltip) should get */
  const COLS = [
    ["MP", "matches_played", "Matches played"],
    ["W", "won", "Won"],
    ["L", "lost", "Lost"],
    ["PS", "points_for", "Points scored"],
    ["PC", "points_against", "Points conceded"],
    ["PD", "point_diff", "Point difference"],
  ];

  const signed = (n) => (Number(n) > 0 ? `+${n}` : String(n));

  function row(s, opts) {
    const rank = Number(s.rank);
    const q = rank <= (opts.qualify || 2);
    const pd = Number(s.point_diff);
    const open = opts.isOpen && opts.isOpen(s.team_id);

    const nums = COLS.map(([label, key]) => {
      const raw = key === "point_diff" ? signed(pd) : s[key];
      const tone = key === "won" ? " win" : key === "point_diff" ? (pd > 0 ? " up" : pd < 0 ? " down" : "") : "";
      return `<span class="st-n${tone}" data-k="${label}"><i>${label}</i>${esc(raw)}</span>`;
    }).join("");

    return `
      <div class="st-row${q ? " q" : ""}${open ? " open" : ""}${opts.clickable ? " tap" : ""}"
           ${opts.clickable ? `data-team="${esc(s.team_id)}" role="button" tabindex="0" aria-expanded="${Boolean(open)}"` : ""}>
        <span class="st-rank"><b>${esc(s.rank)}</b>${q ? `<i class="st-q" title="In a qualifying place">Q</i>` : ""}</span>
        <span class="st-team">
          <b>${esc(s.team_name)}</b>
          ${s.captain_name ? `<small>${esc(s.captain_name)}</small>` : ""}
        </span>
        <span class="st-nums">${nums}</span>
        <span class="st-pts"><b>${esc(s.points)}</b><i>pts</i>${
          opts.clickable ? `<em class="st-caret" aria-hidden="true">▾</em>` : ""
        }</span>
      </div>`;
  }

  /* rows: public_standings, already ranked and ordered.
     opts.clickable  — rows open a breakdown (the open board)
     opts.isOpen(id) — which rows are currently open
     opts.extra(s)   — HTML appended under an open row              */
  function render(rows, opts) {
    opts = opts || {};
    if (!rows || !rows.length) return "";

    return GROUPS.map((g) => {
      const list = rows.filter((s) => s.group_code === g);
      if (!list.length) return "";
      return `
        <section class="st-group" aria-label="Group ${g}">
          <header class="st-head">
            <span class="st-badge">${g}</span>
            <h3 class="st-title">Group ${g}</h3>
            <span class="st-qnote">Top 2 qualify</span>
          </header>
          <div class="st-table">
            <div class="st-hrow" aria-hidden="true">
              <span class="st-rank">#</span>
              <span class="st-team">Team</span>
              <span class="st-nums">${COLS.map(([l, , t]) => `<span class="st-n" title="${t}">${l}</span>`).join("")}</span>
              <span class="st-pts">Pts</span>
            </div>
            ${list
              .map((s) => {
                const body = row(s, opts);
                const extra = opts.extra && opts.isOpen && opts.isOpen(s.team_id) ? opts.extra(s) : "";
                return body + extra;
              })
              .join("")}
          </div>
        </section>`;
    }).join("");
  }

  /* The scoring rules, printed under the table in both apps. */
  const LEGEND = [
    { v: "3", t: "Win a match", tone: "red" },
    { v: "1", t: "Lose by 2 points or less" },
    { v: "0", t: "Lose by more than 2" },
    { v: "+2", t: "Clean sweep — all 5 matches", tone: "red" },
    { v: "+2", t: "Win your trump match", tone: "red" },
    { v: "−2", t: "Lose a trump both teams called", tone: "down" },
    { v: "11", t: "Every game is to 11" },
  ];

  function legend() {
    return `
      <div class="st-legend">
        <p class="st-legend-h">How points are won</p>
        <ul>${LEGEND.map((l) => `<li><b class="${l.tone || ""}">${l.v}</b><span>${esc(l.t)}</span></li>`).join("")}</ul>
      </div>`;
  }

  window.MPL_STANDINGS = { render, legend, COLS, esc };
})();
