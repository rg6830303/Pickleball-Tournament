/* ==========================================================================
   SOLD

   The moment a player goes is the loudest moment in the room, and the screen
   was answering it by going blank. This is the announcement: the hammer
   word, who bought them, and for how much, held long enough for the room to
   read it and then clearing itself so the desk can call the next player.

   It mounts inside the stage rather than over the page, so it fills the
   projector in full screen exactly as the card does.
   ========================================================================== */
(function () {
  'use strict';

  var HOLD = 6200;         // long enough to read across a hall, short enough
  var timer = null;        // that the desk is never waiting on it

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

  /* host: the element the card lives in, so full screen carries it too */
  function show(host, d) {
    if (!host) return;
    d = d || {};
    hide(host);

    var wrap = document.createElement('div');
    wrap.className = 'mn-sold';
    wrap.setAttribute('role', 'status');
    wrap.setAttribute('aria-live', 'polite');

    var unsold = d.unsold === true;
    wrap.classList.toggle('is-unsold', unsold);

    wrap.innerHTML =
      '<div class="mn-sold-in">' +
        '<p class="mn-sold-word">' + (unsold ? 'Unsold' : 'Sold') + '</p>' +
        '<p class="mn-sold-name">' + esc(d.name || '') + '</p>' +
        (unsold
          ? '<p class="mn-sold-to">No bids — back to the pool</p>'
          : '<p class="mn-sold-to">to <b>' + esc(d.team || '') + '</b></p>' +
            '<p class="mn-sold-price">' + money(d.price) + '</p>') +
      '</div>';

    host.appendChild(wrap);

    clearTimeout(timer);
    timer = setTimeout(function () { hide(host); }, HOLD);
  }

  function hide(host) {
    clearTimeout(timer);
    timer = null;
    var el = (host || document).querySelector('.mn-sold');
    if (el) el.remove();
  }

  window.MNSold = { show: show, hide: hide };
})();
