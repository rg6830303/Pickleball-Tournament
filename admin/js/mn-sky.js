/* ==========================================================================
   MONSOON SKY — the whole storm, drawn into one canvas.

   The previous version was DOM: 250 raindrop elements each carrying
   `will-change: transform, opacity`, five cloud divs under an *animated*
   `filter: blur(14/22/34px)`, an SVG bolt with blurred strokes, and two
   `mix-blend-mode: screen` layers. That is roughly three hundred composited
   layers, and a blur on a moving element has to be recomputed every single
   frame. That is what made the auction lag.

   It also could not be made to look right. A filtered element is clipped by
   its parent's box, and `.mn-clouds` was `overflow: hidden` at 66% height —
   so the cloud bank ended in a hard grey rectangle. Those were the "blurred
   boxes".

   Canvas fixes both at once:

     - Clouds are rendered ONCE into offscreen sprites whose alpha falls to
       zero top and bottom, so there is no edge to see. Per frame they cost
       one bitmap copy each. The sprites tile horizontally, so the bank
       scrolls forever with no seam.
     - Rain is a particle array drawn in a handful of batched stroke calls.
     - Lightning only costs anything during the ~800ms it is on screen, and
       it is now a real forked channel with additive glow, a backlit cloud
       base and a room flash.
     - One element, one compositor layer, one requestAnimationFrame loop,
       and it stops dead when the tab is hidden.

   It also watches its own frame time. If the machine driving the projector
   cannot keep up, it sheds work — fewer drops, no shadow blur, fewer cloud
   planes — rather than dropping frames. The auction staying smooth matters
   more than the weather looking its best.
   ========================================================================== */
(function () {
  'use strict';

  var REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  var cv, ctx;
  var W = 0, H = 0, DPR = 1;
  var host = null, nested = false;
  var raf = 0, prev = 0, clock = 0, alive = false;

  /* ---- quality ladder --------------------------------------------------
     Index 2 is what a normal laptop runs. It steps down on its own if
     frames start costing too much, and back up if the machine recovers. */
  var LADDER = [
    { dpr: 1,    drops: 0.40, planes: 2, splash: false, shadow: false },
    { dpr: 1,    drops: 0.70, planes: 3, splash: true,  shadow: false },
    { dpr: 1.25, drops: 1.00, planes: 3, splash: true,  shadow: true  }
  ];
  var qi = 2, ema = 16.7, slowRun = 0, fastRun = 0;
  function Q() { return LADDER[qi]; }

  /* ---- deterministic noise, so a sprite always builds the same way ---- */
  function rng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ======================================================================
     CLOUD SPRITES
     A storm cloud billows upward and hangs flat and heavy underneath, so
     the blobs are packed along a wavy baseline with the tall ones reaching
     up from it. Then holes are torn out so the mass wisps at its edges
     instead of reading as a row of soft circles.

     Everything is drawn three times side by side and only the middle tile
     is kept. That way the one blur pass has real neighbours to sample and
     the sprite still tiles seamlessly in x.
     ====================================================================== */
  function cloudSprite(seed, tone, blobs, holes) {
    var w = 640, h = 240;
    var raw = document.createElement('canvas');
    raw.width = w * 3; raw.height = h;
    var g = raw.getContext('2d');
    var r = rng(seed);

    function puff(cx, cy, rad, a, mode, col) {
      col = col || (mode === 'destination-out' ? '0,0,0' : tone);
      var grd = g.createRadialGradient(cx, cy, rad * 0.12, cx, cy, rad);
      grd.addColorStop(0.00, 'rgba(' + col + ',' + a.toFixed(4) + ')');
      grd.addColorStop(0.42, 'rgba(' + col + ',' + (a * 0.62).toFixed(4) + ')');
      grd.addColorStop(0.74, 'rgba(' + col + ',' + (a * 0.20).toFixed(4) + ')');
      grd.addColorStop(1.00, 'rgba(' + col + ',0)');
      g.globalCompositeOperation = mode;
      g.fillStyle = grd;
      g.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
    }

    /* the mass: big soft bodies packed along a wavy baseline */
    for (var i = 0; i < blobs; i++) {
      var t = r();
      var bx = t * w;
      var wave = Math.sin(t * 6.2832 * 1.7 + seed) * h * 0.11 +
                 Math.sin(t * 6.2832 * 4.3 + seed * 1.7) * h * 0.05;
      var by = h * 0.66 + wave - r() * h * 0.44;
      var rad = h * (0.13 + r() * 0.31);
      var a = 0.075 + r() * 0.115;
      for (var k = 0; k < 3; k++) puff(bx + k * w, by, rad, a, 'source-over');
    }

    /* Detail. Without this a cloud is a smudge: what makes one read as
       cloud is the small stuff riding on the big stuff. These are tighter
       and brighter, sitting on the upper faces where the light would
       catch, which is what gives the bank its billows. */
    var detail = Math.round(blobs * 1.35);
    for (var d2 = 0; d2 < detail; d2++) {
      var dt = r();
      var dx = dt * w;
      var dw2 = Math.sin(dt * 6.2832 * 1.7 + seed) * h * 0.11 +
                Math.sin(dt * 6.2832 * 4.3 + seed * 1.7) * h * 0.05;
      var dy = h * 0.60 + dw2 - r() * h * 0.46;
      var drad = h * (0.045 + r() * 0.105);
      var da = 0.085 + r() * 0.13;
      var lit = r() < 0.42;                    /* a few catch the light */
      for (var k2 = 0; k2 < 3; k2++) {
        puff(dx + k2 * w, dy, drad, da, 'source-over', lit ? '186,194,214' : null);
      }
    }

    /* tear it open so it wisps at the edges instead of reading as circles */
    for (var j = 0; j < holes; j++) {
      var ex = r() * w;
      var ey = h * (0.14 + r() * 0.78);
      var er = h * (0.05 + r() * 0.19);
      var ea = 0.20 + r() * 0.42;
      for (var k3 = 0; k3 < 3; k3++) puff(ex + k3 * w, ey, er, ea, 'destination-out');
    }

    /* fade top and bottom to nothing so it is a bank, not a box.
       Left and right tile, so they are left alone. */
    g.globalCompositeOperation = 'destination-in';
    var vg = g.createLinearGradient(0, 0, 0, h);
    vg.addColorStop(0.00, 'rgba(0,0,0,0)');
    vg.addColorStop(0.14, 'rgba(0,0,0,0.45)');
    vg.addColorStop(0.40, 'rgba(0,0,0,1)');
    vg.addColorStop(0.74, 'rgba(0,0,0,0.86)');
    vg.addColorStop(1.00, 'rgba(0,0,0,0)');
    g.fillStyle = vg;
    g.fillRect(0, 0, w * 3, h);
    g.globalCompositeOperation = 'source-over';

    var out = document.createElement('canvas');
    out.width = w; out.height = h;
    var o = out.getContext('2d');
    /* Barely any blur now. The old 3px was smearing the detail back into the
       smudge it was added to fix; this only takes the hard edge off. */
    try { o.filter = 'blur(1.1px) contrast(1.22) saturate(.9)'; } catch (e) {}
    o.drawImage(raw, -w, 0);
    try { o.filter = 'none'; } catch (e) {}
    return out;
  }

  /* three planes at different depth, drift speed and weight */
  var PLANE = [
    { img: null, seed: 11, tone: '150,158,180', blobs: 74, holes: 34, y: -0.14, h: 0.52, w: 1.45, sp: 5.5,  a: 0.34 },
    { img: null, seed: 37, tone: '142,150,172', blobs: 92, holes: 44, y: -0.10, h: 0.44, w: 1.30, sp: 10.5, a: 0.46 },
    { img: null, seed: 73, tone: '132,140,164', blobs: 108, holes: 54, y: -0.05, h: 0.36, w: 1.18, sp: 17.0, a: 0.60 }
  ];
  function buildClouds() {
    for (var i = 0; i < PLANE.length; i++) {
      if (!PLANE[i].img) PLANE[i].img = cloudSprite(PLANE[i].seed, PLANE[i].tone, PLANE[i].blobs, PLANE[i].holes);
    }
  }

  /* ======================================================================
     RAIN
     Three depth planes. Slow enough that the eye can follow one drop all
     the way down, which is what the organiser asked for; the near plane
     gets a bright head on a faint tail so a drop reads as a drop.
     ====================================================================== */
  var SLANT = -0.13;
  var PLANES = [
    { speed: [140, 220], len: [30, 58],  w: 1.0, col: '190,208,240', a: [0.14, 0.30], share: 0.40, head: false },
    { speed: [250, 370], len: [56, 98],  w: 1.5, col: '206,222,252', a: [0.26, 0.50], share: 0.34, head: false },
    { speed: [410, 600], len: [84, 148], w: 2.0, col: '228,240,255', a: [0.48, 0.88], share: 0.26, head: true  }
  ];
  var drops = [];

  function seedDrops() {
    var target = Math.round(Math.max(70, Math.min(300, (W * H) / 11000)) * Q().drops);
    if (drops.length === target) return;
    while (drops.length > target) drops.pop();
    while (drops.length < target) drops.push(newDrop(pickPlane(drops.length), true));
  }
  function pickPlane(i) {
    var f = (i % 100) / 100;
    return f < PLANES[0].share ? 0 : (f < PLANES[0].share + PLANES[1].share ? 1 : 2);
  }
  function newDrop(p, anywhere) {
    var L = PLANES[p];
    return {
      p: p,
      x: Math.random() * (W * 1.2) - W * 0.1,
      y: anywhere ? Math.random() * H : -Math.random() * 120 - 20,
      v: L.speed[0] + Math.random() * (L.speed[1] - L.speed[0]),
      l: L.len[0] + Math.random() * (L.len[1] - L.len[0]),
      a: L.a[0] + Math.random() * (L.a[1] - L.a[0]),
      b: Math.floor(Math.random() * 3)          // alpha bucket, so we can batch
    };
  }

  var ripples = [];
  function stepRain(dt) {
    var floor = H;
    for (var i = 0; i < drops.length; i++) {
      var d = drops[i];
      d.y += d.v * dt;
      d.x += d.v * dt * SLANT;
      if (d.y - d.l > floor || d.x < -W * 0.25) {
        if (Q().splash && d.p === 2 && ripples.length < 46 && Math.random() < 0.5) {
          ripples.push({ x: d.x, y: floor - Math.random() * H * 0.05, t: 0, life: 0.55 + Math.random() * 0.5 });
        }
        var nd = newDrop(d.p, false);
        d.x = nd.x; d.y = nd.y; d.v = nd.v; d.l = nd.l; d.a = nd.a;
      }
    }
    for (var j = ripples.length - 1; j >= 0; j--) {
      ripples[j].t += dt;
      if (ripples[j].t > ripples[j].life) ripples.splice(j, 1);
    }
  }

  function drawRain() {
    ctx.lineCap = 'butt';
    for (var p = 0; p < PLANES.length; p++) {
      var L = PLANES[p];
      for (var b = 0; b < 3; b++) {
        var alpha = L.a[0] + (L.a[1] - L.a[0]) * (b / 2);
        ctx.strokeStyle = 'rgba(' + L.col + ',' + alpha.toFixed(3) + ')';
        ctx.lineWidth = L.w;
        ctx.beginPath();
        var any = false;
        for (var i = 0; i < drops.length; i++) {
          var d = drops[i];
          if (d.p !== p || d.b !== b) continue;
          ctx.moveTo(d.x - d.l * SLANT, d.y - d.l);
          ctx.lineTo(d.x, d.y);
          any = true;
        }
        if (any) ctx.stroke();
      }
      /* the bright tip that makes the near plane read as falling water */
      if (L.head) {
        ctx.strokeStyle = 'rgba(240,248,255,0.95)';
        ctx.lineWidth = L.w;
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (var m = 0; m < drops.length; m++) {
          var e = drops[m];
          if (e.p !== p) continue;
          ctx.moveTo(e.x - e.l * 0.16 * SLANT, e.y - e.l * 0.16);
          ctx.lineTo(e.x, e.y);
        }
        ctx.stroke();
        ctx.lineCap = 'butt';
      }
    }
  }

  function drawRipples() {
    if (!ripples.length) return;
    ctx.lineWidth = 1;
    for (var i = 0; i < ripples.length; i++) {
      var r = ripples[i];
      var k = r.t / r.life;
      var rad = 3 + k * 22;
      ctx.strokeStyle = 'rgba(198,216,250,' + (0.5 * (1 - k) * (1 - k)).toFixed(3) + ')';
      ctx.beginPath();
      ctx.ellipse(r.x, r.y, rad, rad * 0.30, 0, 0, 6.2832);
      ctx.stroke();
    }
  }

  /* ======================================================================
     LIGHTNING
     A strike is not one flash. The channel re-strikes several times over a
     few hundred milliseconds, and that stutter is most of what makes it
     read as lightning rather than as a light being switched on.
     ====================================================================== */
  var storm = { next: 2.2, pulses: [], t: 9e9, close: false, ox: 0.5, bolts: [], again: -1 };

  function pulses(n) {
    var out = [], at = 0;
    for (var i = 0; i < n; i++) {
      out.push({ at: at, amp: i === 0 ? 1 : 0.32 + Math.random() * 0.62, dec: 0.045 + Math.random() * 0.13 });
      at += 0.028 + Math.random() * 0.115;
    }
    return out;
  }
  function envelope(ps, t) {
    var v = 0;
    for (var i = 0; i < ps.length; i++) {
      var d = t - ps[i].at;
      if (d < 0) continue;
      var a = d < 0.012 ? d / 0.012 : Math.exp(-(d - 0.012) / ps[i].dec);
      if (ps[i].amp * a > v) v = ps[i].amp * a;
    }
    return v > 1 ? 1 : v;
  }

  /* Descend until it lands. A fixed segment count with a randomised step
     leaves a large share of bolts hanging in mid-air. */
  function makeBolt(x0, y0, y1) {
    var pts = [[x0, y0]], forks = [];
    var x = x0, y = y0, i = 0;
    while (y < y1 && i < 26) {
      var t = (y - y0) / (y1 - y0);
      var spread = W * 0.052 * (1 - t) + W * 0.011;
      x += (Math.random() - 0.5) * spread * 2;
      y += (y1 - y0) * (0.055 + Math.random() * 0.055);
      if (y > y1) y = y1;
      pts.push([x, y]);
      if (i > 1 && t < 0.80 && Math.random() < 0.36) {
        var fx = x, fy = y, f = [[fx, fy]];
        var dir = Math.random() < 0.5 ? -1 : 1;
        var n = 2 + Math.floor(Math.random() * 3);
        for (var j = 0; j < n; j++) {
          fx += dir * (W * 0.012 + Math.random() * W * 0.035);
          fy += (y1 - y0) * (0.035 + Math.random() * 0.07);
          f.push([fx, fy]);
        }
        forks.push(f);
      }
      i++;
    }
    if (pts[pts.length - 1][1] < y1) pts.push([x, y1]);
    return { pts: pts, forks: forks };
  }

  function trace(pts) {
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  }

  function paintBolt(b, k) {
    if (k <= 0.02) return;
    var shadow = Q().shadow;
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    function pass(width, col, alpha, blur, withForks) {
      ctx.strokeStyle = 'rgba(' + col + ',' + (alpha * k).toFixed(3) + ')';
      ctx.lineWidth = width;
      if (shadow) { ctx.shadowColor = 'rgba(' + col + ',1)'; ctx.shadowBlur = blur; }
      ctx.beginPath();
      trace(b.pts);
      if (withForks) for (var i = 0; i < b.forks.length; i++) trace(b.forks[i]);
      ctx.stroke();
    }

    /* outer bleed, then halo, then the white-hot channel. On the reduced
       tier there is no shadow blur, so the bleed is faked with two extra
       wide low-alpha passes instead — cheaper, and close enough. */
    if (shadow) {
      pass(W * 0.017, '92,148,255', 0.11, 44, false);
      pass(9, '150,192,255', 0.26, 20, true);
    } else {
      pass(W * 0.020, '92,148,255', 0.045, 0, false);
      pass(W * 0.009, '120,170,255', 0.075, 0, false);
      pass(9, '150,192,255', 0.22, 0, true);
    }
    if (shadow) { ctx.shadowBlur = 8; ctx.shadowColor = 'rgba(220,236,255,1)'; }
    pass(2.4, '255,255,255', 0.95, 8, true);

    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = 'source-over';
  }

  function fireStrike() {
    storm.close = Math.random() < 0.45;                 // near strikes are frequent here on purpose
    storm.ox = 0.12 + Math.random() * 0.76;
    storm.pulses = pulses(storm.close ? 3 + Math.floor(Math.random() * 4) : 2 + Math.floor(Math.random() * 2));
    storm.t = 0;
    storm.bolts = [];
    if (storm.close) {
      var y0 = H * 0.10 + Math.random() * H * 0.06;
      storm.bolts.push(makeBolt(storm.ox * W, y0, H * (0.95 + Math.random() * 0.10)));
      /* real lightning often restrikes the same channel a beat later */
      storm.again = Math.random() < 0.45 ? 0.16 + Math.random() * 0.22 : -1;
    } else {
      storm.again = -1;
    }
  }

  function stepStorm(dt) {
    storm.next -= dt;
    if (storm.next <= 0) {
      fireStrike();
      storm.next = 4.5 + Math.random() * 7.5;
    }
    storm.t += dt;
    if (storm.again > 0 && storm.t >= storm.again) {
      storm.again = -1;
      var y0 = H * 0.10 + Math.random() * H * 0.06;
      storm.bolts.push(makeBolt((storm.ox + (Math.random() - 0.5) * 0.10) * W, y0, H * (0.95 + Math.random() * 0.10)));
      storm.pulses = storm.pulses.concat(pulses(2).map(function (p) { return { at: storm.t + p.at, amp: p.amp * 0.9, dec: p.dec }; }));
    }
  }

  /* ======================================================================
     FRAME
     ====================================================================== */
  var floorGrad = null, bloomGrad = null;
  function cacheGradients() {
    floorGrad = ctx.createLinearGradient(0, H * 0.62, 0, H);
    floorGrad.addColorStop(0, 'rgba(0,0,0,0)');
    floorGrad.addColorStop(1, 'rgba(0,0,0,0.55)');
    bloomGrad = ctx.createRadialGradient(W * 0.22, H * 1.04, 0, W * 0.22, H * 1.04, Math.max(W, H) * 0.62);
    bloomGrad.addColorStop(0.00, 'rgba(214,36,36,0.20)');
    bloomGrad.addColorStop(0.42, 'rgba(170,26,26,0.075)');
    bloomGrad.addColorStop(1.00, 'rgba(190,30,30,0)');
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    var dt = prev ? (now - prev) / 1000 : 0.016;
    prev = now;
    if (dt > 0.05) dt = 0.05;                       // never teleport after a stall
    clock += dt;

    stepStorm(dt);
    stepRain(dt);

    var flash = storm.pulses.length ? envelope(storm.pulses, storm.t) : 0;
    if (!storm.close) flash *= 0.55;

    ctx.clearRect(0, 0, W, H);

    /* light behind the bank first, so the cloud is silhouetted against it */
    if (flash > 0.01) {
      ctx.globalCompositeOperation = 'lighter';
      var gy = H * 0.14;
      var gr = Math.max(W, H) * (storm.close ? 0.72 : 0.95);
      var bg = ctx.createRadialGradient(storm.ox * W, gy, 0, storm.ox * W, gy, gr);
      bg.addColorStop(0.00, 'rgba(206,228,255,' + (0.50 * flash).toFixed(3) + ')');
      bg.addColorStop(0.34, 'rgba(160,190,238,' + (0.22 * flash).toFixed(3) + ')');
      bg.addColorStop(1.00, 'rgba(120,150,205,0)');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
    }

    var planes = Q().planes;
    for (var i = 3 - planes; i < 3; i++) {
      var P = PLANE[i];
      if (!P.img) continue;
      var dw = W * P.w, dh = H * P.h;
      var x = -((clock * P.sp) % dw);
      ctx.globalAlpha = Math.min(1, P.a * (1 + flash * 0.85));
      ctx.drawImage(P.img, x, P.y * H, dw, dh);
      ctx.drawImage(P.img, x + dw, P.y * H, dw, dh);
    }
    ctx.globalAlpha = 1;

    /* and light the cloud mass itself, so the glow takes the cloud's shape */
    if (flash > 0.02) {
      var F = PLANE[2];
      if (F.img) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = Math.min(0.65, flash * 0.55);
        var fdw = W * F.w, fdh = H * F.h;
        var fx = -((clock * F.sp) % fdw);
        ctx.drawImage(F.img, fx, F.y * H, fdw, fdh);
        ctx.drawImage(F.img, fx + fdw, F.y * H, fdw, fdh);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
    }

    drawRain();
    if (Q().splash) drawRipples();

    /* Haze on the floor, so rain has somewhere to arrive. It goes down before
       the bolt: lightning is the brightest thing in the room and has to punch
       through the murk, not sit behind it. */
    ctx.fillStyle = floorGrad;
    ctx.fillRect(0, H * 0.62, W, H * 0.38);

    for (var b = 0; b < storm.bolts.length; b++) paintBolt(storm.bolts[b], flash);

    /* the monsoon red, breathing */
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.80 + 0.20 * Math.sin(clock * 0.55);
    ctx.fillStyle = bloomGrad;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;

    /* the room flash, over everything */
    if (flash > 0.01) {
      var f = flash * (storm.close ? 0.30 : 0.14);
      var wg = ctx.createLinearGradient(0, 0, 0, H);
      wg.addColorStop(0.00, 'rgba(196,220,255,' + f.toFixed(3) + ')');
      wg.addColorStop(0.52, 'rgba(150,178,232,' + (f * 0.34).toFixed(3) + ')');
      wg.addColorStop(1.00, 'rgba(120,145,200,0)');
      ctx.fillStyle = wg;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.globalCompositeOperation = 'source-over';

    /* ---- shed work rather than drop frames ---- */
    ema += (dt * 1000 - ema) * 0.05;
    if (ema > 26) { slowRun++; fastRun = 0; } else if (ema < 14) { fastRun++; slowRun = 0; }
    if (slowRun > 40 && qi > 0) { qi--; slowRun = 0; ema = 16.7; apply(); }
    else if (fastRun > 900 && qi < 2) { qi++; fastRun = 0; ema = 16.7; apply(); }
  }

  function apply() {
    resize();
    seedDrops();
  }

  /* ======================================================================
     MOUNTING, SIZING, LIFECYCLE
     ====================================================================== */
  function resize() {
    var w, h;
    if (nested && host) { w = host.clientWidth; h = host.clientHeight; }
    else { w = window.innerWidth; h = window.innerHeight; }
    if (!w || !h) return;
    DPR = Math.min(window.devicePixelRatio || 1, Q().dpr);
    W = w; H = h;
    cv.width = Math.round(w * DPR);
    cv.height = Math.round(h * DPR);
    cv.style.width = w + 'px';
    cv.style.height = h + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    cacheGradients();
    seedDrops();
  }

  function mount(el) {
    nested = !!el;
    host = el || document.body;
    if (nested) {
      cv.style.position = 'absolute';
      cv.style.zIndex = '-1';               // above the panel's own background,
      host.insertBefore(cv, host.firstChild); // below every child of it
    } else {
      cv.style.position = 'fixed';
      cv.style.zIndex = '0';
      document.body.insertBefore(cv, document.body.firstChild);
    }
    cv.style.left = '0'; cv.style.top = '0';
    cv.style.pointerEvents = 'none';
    resize();
  }

  function start() {
    if (alive || REDUCED) return;
    alive = true; prev = 0;
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    alive = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function init() {
    if (cv) return;
    cv = document.createElement('canvas');
    cv.className = 'mn-sky';
    cv.setAttribute('aria-hidden', 'true');
    ctx = cv.getContext('2d', { alpha: true, desynchronized: true });
    if (!ctx) return;

    buildClouds();
    mount(null);

    if (REDUCED) { drawStill(); return; }
    start();

    var rt;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(resize, 140);
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop(); else start();
    });
    document.addEventListener('fullscreenchange', relocate);
    document.addEventListener('webkitfullscreenchange', relocate);
  }

  /* In projector mode the stage goes full screen, and only that subtree is
     painted — so the sky has to travel with it. */
  function relocate() {
    var fs = document.fullscreenElement || document.webkitFullscreenElement;
    if (fs && fs !== document.documentElement && fs !== document.body) mount(fs);
    else mount(null);
    /* the element is not always at its final size the instant the event
       fires, and this is the projector path — measure again once it has
       settled rather than leave the sky the wrong size on the big screen */
    requestAnimationFrame(resize);
    setTimeout(resize, 260);
  }

  /* one painted frame for people who asked the OS for less motion */
  function drawStill() {
    seedDrops();
    ctx.clearRect(0, 0, W, H);
    for (var i = 0; i < PLANE.length; i++) {
      var P = PLANE[i];
      if (!P.img) continue;
      ctx.globalAlpha = P.a;
      ctx.drawImage(P.img, 0, P.y * H, W * P.w, H * P.h);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = bloomGrad;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = floorGrad;
    ctx.fillRect(0, H * 0.62, W, H * 0.38);
  }

  window.MNSky = {
    mount: mount,
    start: start,
    stop: stop,
    relocate: relocate,
    stats: function () {
      return {
        quality: qi, dpr: DPR, w: W, h: H,
        drops: drops.length, ripples: ripples.length,
        planes: Q().planes, shadow: Q().shadow,
        clouds: PLANE.filter(function (p) { return !!p.img; }).length,
        nested: nested, running: alive, frameMs: Math.round(ema * 10) / 10,
        flash: storm.pulses.length ? envelope(storm.pulses, storm.t) : 0,
        bolts: storm.bolts.length, nextStrike: Math.round(storm.next * 10) / 10
      };
    },
    strikeNow: fireStrike        // used by the console's "test the sky" check
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
