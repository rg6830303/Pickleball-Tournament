/* ==========================================================================
   THE PLAYER CARD — one renderer, both apps.

   The card is the supplied artwork, used as-is. Nothing about it is redrawn
   in CSS: the PNG is the background, and the only things this file adds are
   the player's photo inside the left panel and text inside the boxes the
   artwork already draws. Swap the player key and only those change.

   Every position below is a percentage of the artwork, so the same numbers
   hold whether the card is 360px wide on a captain's phone or filling a
   projector.

   Data arrives already joined: the pool row carries name, category and base
   price; the photo, sex and DUPR come through the player key from the live
   registration table.
   ========================================================================== */
(function () {
  'use strict';

  /* Where things sit on the artwork, measured off the file itself.
     Percentages of the card's width and height. */
  var T = {
    src: 'assets/card.jpeg',
    ratio: 1.5,

    /* the red-bordered panel on the left: the photo goes inside it */
    stand: { x: 4.4922, y: 7.8125, w: 35.026, h: 85.2539 },

    /* the name sits in the clear space above the four boxes */
    name: { x: 41.9271, y: 34.5703, w: 52.1484, h: 11.8164 },

    /* the four boxes. The first one is genuinely 11px wider than the other
       three in the artwork, so these are the measured widths, not four
       equal columns. */
    tiles: [
      { x: 41.9271, y: 52.0508, w: 13.0859, h: 20.6055 },
      { x: 55.7292, y: 52.0508, w: 12.3698, h: 20.6055 },
      { x: 68.8151, y: 52.0508, w: 12.3047, h: 20.6055 },
      { x: 81.8359, y: 52.0508, w: 12.2396, h: 20.6055 }
    ],
    tileRule: 29.86,          /* % down a box where the artwork's red line sits */

    /* the wide box underneath */
    price: { x: 41.9271, y: 74.2188, w: 52.1484, h: 16.6016 }
  };

  var CAT_LABEL = { A: 'Advance', B: 'Intermediate', C: 'Beginner' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function money(n) {
    var v = Number(n);
    if (!isFinite(v)) return '—';
    return '₹' + v.toLocaleString('en-IN', { maximumFractionDigits: 0 });
  }

  /* DUPR is published to two decimals; the database keeps three. */
  function dupr(v) {
    if (v == null || v === '') return null;
    var n = Number(v);
    return isFinite(n) ? n.toFixed(2) : null;
  }

  function sex(v) {
    if (!v) return null;
    var s = String(v).trim().toUpperCase();
    if (s === 'M') return 'MALE';
    if (s === 'F') return 'FEMALE';
    return s;
  }

  /* Long names must not spill out of the artwork, and hand-tuning 144 of them
     is not a plan. Three steps, chosen on length. */
  function nameStep(name) {
    var n = String(name || '').length;
    if (n > 26) return 'xlong';
    if (n > 17) return 'long';
    return 'short';
  }

  function box(r) {
    return 'left:' + r.x + '%;top:' + r.y + '%;width:' + r.w + '%;height:' + r.h + '%';
  }

  function tile(i, label, value, caption) {
    var empty = value == null || value === '';
    return '<div class="mplc-tile" style="' + box(T.tiles[i]) + ';--rule:' + T.tileRule + '%">' +
      '<span class="mplc-tile-k">' + esc(label) + '</span>' +
      '<span class="mplc-tile-v' + (empty ? ' is-empty' : '') + '">' +
        (empty ? '—' : esc(value)) +
        (caption && !empty ? '<i>' + esc(caption) + '</i>' : '') +
      '</span></div>';
  }

  function html(d, opts) {
    d = d || {};
    opts = opts || {};
    var base = opts.base || '';                 /* path prefix for the artwork */
    var cat = (d.category || '').toUpperCase();
    var name = d.name || 'Unnamed';

    var photo = d.photo_url
      ? '<img class="mplc-photo" src="' + esc(d.photo_url) + '" alt="" ' +
        'crossorigin="anonymous" loading="eager" fetchpriority="high" decoding="async" ' +
        'onerror="this.classList.add(\'is-broken\')">'
      : '<span class="mplc-initial">' + esc((name.trim()[0] || '?').toUpperCase()) + '</span>';

    /* The artwork has no slot for auction state, so it stays out of the
       composition — a corner tab, and only when there is something to say. */
    var flag = '';
    if (d.status === 'sold') {
      flag = '<div class="mplc-flag">Sold' + (d.sold_price ? ' · ' + money(d.sold_price) : '') + '</div>';
    } else if (d.status === 'unsold') {
      flag = '<div class="mplc-flag mplc-flag--unsold">Unsold</div>';
    }

    return '' +
      '<div class="mplc" style="--ratio:' + T.ratio + '">' +
        '<img class="mplc-art" src="' + esc(base + T.src) + '" alt="" decoding="async">' +
        '<div class="mplc-stand" style="' + box(T.stand) + '">' + photo + '</div>' +
        '<div class="mplc-name" data-step="' + nameStep(name) + '" style="' + box(T.name) + '">' +
          esc(name) +
        '</div>' +
        tile(0, 'Category', cat || null, CAT_LABEL[cat] || d.category_label) +
        tile(1, 'Age', d.age) +
        tile(2, 'Sex', sex(d.sex)) +
        tile(3, 'DUPR', dupr(d.dupr)) +
        '<div class="mplc-price" style="' + box(T.price) + ';--rule:' + T.tileRule + '%">' +
          '<span class="mplc-tile-k">Base Price</span>' +
          '<span class="mplc-price-v">' + money(d.base_price) + '</span>' +
        '</div>' +
        flag +
      '</div>';
  }

  /* ------------------------------------------------------------------------
     MAKING ANY PHOTO WORK

     These come off 144 different phones. Some are lit, some are dark, some
     are wide shots, some are tight crops. The panel is a tall portrait slot
     lit from above, and a photo has to sit in it convincingly without anyone
     retouching 144 files.

     Two passes, both from the pixels themselves:

       Framing — where the subject sits vertically depends on the shape of
       the photo. A tall phone portrait has the head near the top; a
       landscape group shot has it near the middle. Pick the anchor from the
       aspect ratio so heads do not get cropped off.

       Exposure — measure mean brightness and spread on a 48px thumbnail and
       nudge both toward what reads well on a projector in a dark hall. A
       dim photo is lifted, a blown-out one is pulled back, and a flat one
       gets its contrast opened up. Everything is clamped so nothing is
       pushed far enough to look processed.
     ---------------------------------------------------------------------- */
  var TARGET_LUM = 118;      /* 0-255, a touch above mid so faces read */
  var TARGET_SPREAD = 52;    /* standard deviation that looks alive, not flat */

  function frame(img) {
    var w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) return '50% 20%';
    var tall = h / w;
    if (tall >= 1.45) return '50% 14%';      /* phone portrait: head high up */
    if (tall >= 1.10) return '50% 17%';
    if (tall >= 0.85) return '50% 20%';      /* square-ish */
    return '50% 28%';                        /* landscape: subject sits lower */
  }

  function expose(img) {
    var c = document.createElement('canvas');
    var n = 48;
    c.width = n; c.height = n;
    var g = c.getContext('2d', { willReadFrequently: true });
    var px;
    try {
      g.drawImage(img, 0, 0, n, n);
      px = g.getImageData(0, 0, n, n).data;
    } catch (e) {
      return null;                            /* tainted canvas: leave it alone */
    }
    var sum = 0, sum2 = 0, count = 0;
    for (var i = 0; i < px.length; i += 4) {
      var l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      sum += l; sum2 += l * l; count++;
    }
    if (!count) return null;
    var mean = sum / count;
    var sd = Math.sqrt(Math.max(0, sum2 / count - mean * mean));

    var bright = mean > 4 ? TARGET_LUM / mean : 1;
    var contrast = sd > 4 ? TARGET_SPREAD / sd : 1;
    bright = Math.max(0.75, Math.min(1.55, bright));
    contrast = Math.max(0.88, Math.min(1.35, contrast));
    /* the artwork is cool and steely; pulling a little saturation out of the
       photo keeps it from fighting that */
    return 'brightness(' + bright.toFixed(3) + ') contrast(' + contrast.toFixed(3) + ') saturate(.9)';
  }

  function fit(img) {
    if (!img || img.dataset.fitted) return;
    img.dataset.fitted = '1';
    img.style.objectPosition = frame(img);
    var f = expose(img);
    if (f) img.style.filter = f;
  }

  function fitAll(root) {
    (root || document).querySelectorAll('img.mplc-photo').forEach(function (img) {
      if (img.complete && img.naturalWidth) fit(img);
      else img.addEventListener('load', function () { fit(img); }, { once: true });
    });
  }

  function render(el, d, opts) {
    if (!el) return;
    el.innerHTML = html(d, opts);
    fitAll(el);
  }

  window.MNCard = {
    html: html, render: render, fitAll: fitAll,
    money: money, geometry: T
  };
})();
