/* ==========================================================================
   SOLD

   The moment a player goes is the loudest moment in the room, and the screen
   was answering it by going blank.

   This mounts to the BODY, not to the stage. The stage is re-rendered the
   instant a sale lands — the board reloads, the card is cleared — and an
   overlay living inside it gets thrown away with everything else. Sitting on
   the body it cannot be wiped by a repaint. In projector mode it mounts to
   the full-screen element instead, because that is the only subtree the
   screen is painting.
   ========================================================================== */
(function () {
  'use strict';

  var HOLD = 3000;         // the gavel, the words, and out of the way
  var timer = null;

  function money(n) {
    var v = Number(n);
    if (!isFinite(v)) return '';
    return '₹' + v.toLocaleString('en-IN', { maximumFractionDigits: 0 });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* Whatever the screen is actually painting right now. */
  function target() {
    var fs = document.fullscreenElement || document.webkitFullscreenElement;
    if (fs && fs !== document.documentElement && fs !== document.body) return fs;
    return document.querySelector('.is-blownup') || document.body;
  }

  var GAVEL =
    '<svg class="mn-sold-gavel" viewBox="0 0 120 96" aria-hidden="true">' +
      '<g class="mn-gavel-head">' +
        '<rect x="30" y="6" width="52" height="26" rx="6" transform="rotate(-38 56 19)"/>' +
        '<rect x="52" y="26" width="9" height="42" rx="4.5" transform="rotate(-38 56 47)"/>' +
      '</g>' +
      '<rect class="mn-gavel-block" x="16" y="76" width="88" height="13" rx="6.5"/>' +
    '</svg>';

  function show(_ignoredHost, d) {
    d = d || {};
    hide();

    var host = target();
    var wrap = document.createElement('div');
    wrap.className = 'mn-sold' + (host === document.body ? ' is-page' : '');
    wrap.setAttribute('role', 'status');
    wrap.setAttribute('aria-live', 'polite');

    var unsold = d.unsold === true;
    if (unsold) wrap.classList.add('is-unsold');

    var line = unsold
      ? '<p class="mn-sold-to">No bids — back to the pool</p>'
      : '<p class="mn-sold-to">to <b>' + esc(d.team || '') + '</b></p>' +
        '<p class="mn-sold-price">' + money(d.price) + '</p>';

    wrap.innerHTML =
      '<div class="mn-sold-in">' +
        GAVEL +
        '<p class="mn-sold-word">' + (unsold ? 'Unsold' : 'Player Sold') + '</p>' +
        '<p class="mn-sold-name">' + esc(d.name || '') + '</p>' +
        line +
      '</div>';

    host.appendChild(wrap);

    clearTimeout(timer);
    timer = setTimeout(hide, HOLD);
  }

  function hide() {
    clearTimeout(timer);
    timer = null;
    var all = document.querySelectorAll('.mn-sold');
    for (var i = 0; i < all.length; i++) all[i].remove();
  }

  /* If the screen goes full screen (or comes back) while it is up, move it to
     whatever is being painted now. */
  function follow() {
    var el = document.querySelector('.mn-sold');
    if (!el) return;
    var host = target();
    if (el.parentElement === host) return;
    el.classList.toggle('is-page', host === document.body);
    host.appendChild(el);
  }
  document.addEventListener('fullscreenchange', follow);
  document.addEventListener('webkitfullscreenchange', follow);

  window.MNSold = { show: show, hide: hide };
})();
