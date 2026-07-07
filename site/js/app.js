/* ============================================================
   MONSOON PICKLE LEAGUE — APP
   Splash choreography · form logic · uploads · Supabase submit
   ============================================================ */
(() => {
  "use strict";

  const CFG = window.MPL_CONFIG;
  const EV = CFG.EVENT;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const LIVE = Boolean(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
  let sb = null;

  const state = {
    gender: "",
    category: "",
    categoryLabel: "",
    needsPartner: false,
    jerseySize: "",
    payment: "Online",
    profileFile: null,
    paymentFile: null,
  };

  /* ------------------------------------------------------------
     POPULATE EVENT COPY FROM CONFIG
     ------------------------------------------------------------ */
  $("#heroPresents").textContent = `${EV.presenter} presents`;
  $("#heroSeason").textContent = EV.season;
  $("#metaDates").textContent = EV.dates;
  $("#metaVenue").textContent = EV.venue;
  $("#metaTagline").textContent = EV.tagline;
  $("#payNote").textContent = EV.feeNote;
  $("#ticketSeason").textContent = EV.season;
  $("#footerFine").textContent = `${EV.name} · ${EV.season} · ${EV.venue}`;

  if (EV.upiId) {
    const upi = $("#upiId");
    upi.hidden = false;
    upi.innerHTML = `UPI ID&ensp;<b>${EV.upiId}</b>`;
  }

  $("#footerPhones").innerHTML = EV.phones
    .map(
      (p) => `<a href="tel:${p.replace(/\s/g, "")}">
        <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.13.96.36 1.9.7 2.8a2 2 0 0 1-.45 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.45c.9.34 1.84.57 2.8.7A2 2 0 0 1 22 16.9Z"/></svg>
        ${p}</a>`
    )
    .join("");

  /* categories */
  const catGrid = $("#catGrid");
  EV.categories.forEach((c) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cat";
    btn.dataset.value = c.id;
    btn.dataset.label = c.label;
    btn.dataset.partner = c.partner ? "1" : "";
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", "false");
    btn.innerHTML = `<span class="dot"></span><span>${c.label}</span>`;
    catGrid.appendChild(btn);
  });

  /* jersey sizes */
  const sizePills = $("#sizePills");
  CFG.JERSEY_SIZES.forEach((s) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pill";
    b.dataset.value = s;
    b.textContent = s;
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", "false");
    sizePills.appendChild(b);
  });

  /* ------------------------------------------------------------
     SUPABASE / DEMO MODE
     ------------------------------------------------------------ */
  function initBackend() {
    if (LIVE && window.supabase) {
      sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
      loadEventSettings();
    } else if (!LIVE) {
      $("#demoNote").classList.add("show");
    }
  }

  /* organiser controls from the admin console (event_settings table) */
  async function loadEventSettings() {
    try {
      const { data } = await sb
        .from("event_settings")
        .select("registration_open, banner_message")
        .eq("id", 1)
        .maybeSingle();
      if (!data) return;
      if (data.banner_message) {
        const b = $("#formBanner");
        b.textContent = data.banner_message;
        b.hidden = false;
      }
      if (!data.registration_open) {
        $("#closedNote").hidden = false;
        const btn = $("#btnSubmit");
        btn.disabled = true;
        $(".btn-label", btn).textContent = "Registrations Closed";
      }
    } catch {
      /* settings are optional — the form still works without them */
    }
  }

  /* ------------------------------------------------------------
     SPLASH — poster as loading preview
     ------------------------------------------------------------ */
  const splash = $("#splash");
  const barFill = $("#splashBarFill");
  const splashStatus = $("#splashStatus");
  let entered = false;

  const statusLines = [
    "Loading the court",
    "Chalking the lines",
    "Rain check: approved",
    "Ready to serve",
  ];

  function runSplash() {
    let p = 0;
    let i = 0;
    const tick = setInterval(() => {
      p = Math.min(p + 8 + Math.random() * 16, 100);
      barFill.style.width = p + "%";
      if (p > (i + 1) * 25 && i < statusLines.length - 1) {
        splashStatus.textContent = statusLines[++i];
      }
      if (p >= 100) {
        clearInterval(tick);
        splashStatus.textContent = "Ready to serve";
        splash.classList.add("ready");
        // auto-enter shortly after ready; button allows instant entry
        setTimeout(() => enterApp(), 1600);
      }
    }, 180);
  }

  function enterApp() {
    if (entered) return;
    entered = true;
    splash.classList.add("gone");
    const app = $("#app");
    app.classList.add("on");
    setTimeout(() => splash.remove(), 1100);
  }

  $("#btnEnter").addEventListener("click", enterApp);

  /* ------------------------------------------------------------
     AMBIENT RAIN
     ------------------------------------------------------------ */
  function startRain() {
    const cv = $("#rain");
    const ctx = cv.getContext("2d");
    let drops = [];
    const DPR = Math.min(window.devicePixelRatio || 1, 2);

    function resize() {
      cv.width = innerWidth * DPR;
      cv.height = innerHeight * DPR;
      const n = Math.floor(innerWidth / 14);
      drops = Array.from({ length: n }, () => spawn(true));
    }
    function spawn(anyY) {
      return {
        x: Math.random() * cv.width,
        y: anyY ? Math.random() * cv.height : -30,
        l: (9 + Math.random() * 18) * DPR,
        v: (5.5 + Math.random() * 7) * DPR,
        o: 0.05 + Math.random() * 0.13,
      };
    }
    function frame() {
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.lineWidth = 1 * DPR;
      ctx.lineCap = "round";
      for (const d of drops) {
        ctx.strokeStyle = `rgba(200,205,215,${d.o})`;
        ctx.beginPath();
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(d.x - d.l * 0.12, d.y + d.l);
        ctx.stroke();
        d.y += d.v;
        d.x -= d.v * 0.12;
        if (d.y > cv.height + 30) Object.assign(d, spawn(false));
      }
      requestAnimationFrame(frame);
    }
    resize();
    addEventListener("resize", resize);
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) frame();
  }

  /* ------------------------------------------------------------
     SCROLL REVEAL
     ------------------------------------------------------------ */
  const io = new IntersectionObserver(
    (entries) =>
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
      }),
    { threshold: 0.12 }
  );
  $$(".reveal").forEach((el) => io.observe(el));

  /* ------------------------------------------------------------
     PICKERS
     ------------------------------------------------------------ */
  function bindRadioGroup(container, onPick) {
    container.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-value]");
      if (!btn) return;
      $$("[data-value]", container).forEach((b) => {
        b.classList.toggle("on", b === btn);
        b.setAttribute("aria-checked", b === btn ? "true" : "false");
      });
      onPick(btn);
      clearError(container.closest(".field"));
    });
  }

  bindRadioGroup($("#genderPills"), (b) => (state.gender = b.dataset.value));

  bindRadioGroup(catGrid, (b) => {
    state.category = b.dataset.value;
    state.categoryLabel = b.dataset.label;
    state.needsPartner = Boolean(b.dataset.partner);
    $("#partnerSlide").classList.toggle("open", state.needsPartner);
    if (!state.needsPartner) {
      $("#partnerName").value = "";
      clearError($("[data-field='partner_name']"));
    }
  });

  bindRadioGroup(sizePills, (b) => {
    state.jerseySize = b.dataset.value;
    $("#jPrevSize").textContent = b.dataset.value;
  });

  /* payment segmented toggle */
  bindRadioGroup($("#paySeg"), (b) => {
    state.payment = b.dataset.value;
    const online = state.payment === "Online";
    $("#payOnline").hidden = !online;
    $("#payCash").hidden = online;
    if (!online) clearError($("[data-field='payment_screenshot']"));
  });

  /* jersey live preview */
  $("#jerseyName").addEventListener("input", (e) => {
    const v = e.target.value.trim().toUpperCase();
    $("#jPrevName").textContent = v || "NAME";
    const len = Math.max(v.length, 4);
    $("#jPrevName").setAttribute("font-size", len > 8 ? 13 - (len - 8) * 0.8 : 13);
  });

  /* QR image fallback (also covers errors fired before this script ran) */
  function qrFallback() {
    $("#qrFrame").innerHTML =
      '<p class="qr-missing">Add <b>assets/qr.png</b> to show your UPI QR here.</p>';
  }
  const qrImg = $("#qrImg");
  qrImg.addEventListener("error", qrFallback);
  if (qrImg.complete && qrImg.naturalWidth === 0) qrFallback();

  /* ------------------------------------------------------------
     FILE UPLOADS (attach, preview, remove, drag & drop)
     ------------------------------------------------------------ */
  function bindUpload(boxId, inputId, key) {
    const box = $(boxId);
    const input = $(inputId);
    const thumbImg = $(".thumb img", box);
    const fname = $(".fname", box);

    function setFile(file) {
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        showAlert("That file isn't an image — please attach a JPG or PNG.");
        return;
      }
      if (file.size > CFG.MAX_UPLOAD_MB * 1024 * 1024) {
        showAlert(`Image is too large — keep it under ${CFG.MAX_UPLOAD_MB} MB.`);
        return;
      }
      state[key] = file;
      const url = URL.createObjectURL(file);
      thumbImg.src = url;
      fname.textContent = file.name;
      box.classList.add("filled");
      clearError(box.closest(".field"));
    }

    input.addEventListener("change", () => setFile(input.files[0]));

    $(".rm", box).addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      state[key] = null;
      input.value = "";
      thumbImg.removeAttribute("src");
      box.classList.remove("filled");
    });

    ["dragover", "dragenter"].forEach((ev) =>
      box.addEventListener(ev, (e) => {
        e.preventDefault();
        box.classList.add("drag");
      })
    );
    ["dragleave", "drop"].forEach((ev) =>
      box.addEventListener(ev, (e) => {
        e.preventDefault();
        box.classList.remove("drag");
        if (ev === "drop" && e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
      })
    );
  }

  bindUpload("#upProfile", "#fileProfile", "profileFile");
  bindUpload("#upPayment", "#filePayment", "paymentFile");

  /* client-side compression → keeps uploads fast on stadium wifi */
  async function compressImage(file, maxDim = 1600, quality = 0.85) {
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
      if (scale === 1 && file.size < 900 * 1024) return file;
      const cv = document.createElement("canvas");
      cv.width = Math.round(bmp.width * scale);
      cv.height = Math.round(bmp.height * scale);
      cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
      const blob = await new Promise((res) => cv.toBlob(res, "image/jpeg", quality));
      return blob || file;
    } catch {
      return file; // HEIC etc. — upload original
    }
  }

  /* ------------------------------------------------------------
     VALIDATION
     ------------------------------------------------------------ */
  function fieldEl(name) {
    return $(`[data-field='${name}']`);
  }
  function setError(name, msg) {
    const f = fieldEl(name);
    if (!f) return;
    f.classList.add("error");
    if (msg) $(".ferr", f).textContent = msg;
  }
  function clearError(f) {
    if (f) f.classList.remove("error");
  }
  function showAlert(msg) {
    const a = $("#formAlert");
    a.textContent = msg;
    a.classList.remove("show");
    void a.offsetWidth; // restart shake
    a.classList.add("show");
  }
  function hideAlert() {
    $("#formAlert").classList.remove("show");
  }

  $$("#regForm input").forEach((i) =>
    i.addEventListener("input", () => clearError(i.closest(".field")))
  );

  function validate() {
    $$(".field.error").forEach(clearError);
    const problems = [];

    const name = $("#fullName").value.trim();
    if (!name) {
      setError("full_name");
      problems.push("Please enter the player's name.");
    }

    const phone = $("#phone").value.replace(/[\s\-()]/g, "");
    if (!/^(\+?91)?[6-9]\d{9}$/.test(phone)) {
      setError("phone");
      problems.push("Please enter a valid 10-digit mobile number.");
    }

    const email = $("#email").value.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      setError("email");
      problems.push("That email doesn't look right.");
    }

    if (!state.gender) {
      setError("gender");
      problems.push("Please select a gender.");
    }

    const dupr = $("#dupr").value.trim();
    if (dupr && (Number(dupr) < 0 || Number(dupr) > 8)) {
      setError("dupr");
      problems.push("DUPR ratings range from 2.000 to 8.000.");
    }

    if (!state.category) {
      setError("category");
      problems.push("Please pick your event category.");
    }
    if (state.needsPartner && !$("#partnerName").value.trim()) {
      setError("partner_name");
      problems.push("Doubles needs a partner — enter their name.");
    }

    if (!state.jerseySize) {
      setError("jersey_size");
      problems.push("Please pick a jersey size.");
    }
    if (!$("#jerseyName").value.trim()) {
      setError("jersey_name");
      problems.push("What should we print on the back of your jersey?");
    }

    if (!state.profileFile) {
      fieldEl("profile_pic").classList.add("error");
      $("#upProfile").classList.add("error");
      problems.push("Please attach a profile picture.");
    } else {
      $("#upProfile").classList.remove("error");
    }

    if (state.payment === "Online" && !state.paymentFile) {
      fieldEl("payment_screenshot").classList.add("error");
      $("#upPayment").classList.add("error");
      problems.push("Please attach the payment screenshot.");
    } else {
      $("#upPayment").classList.remove("error");
    }

    if (problems.length) {
      showAlert(problems[0]);
      const first = $(".field.error");
      if (first) first.scrollIntoView({ behavior: "smooth", block: "center" });
      return false;
    }
    hideAlert();
    return true;
  }

  /* ------------------------------------------------------------
     SUBMIT
     ------------------------------------------------------------ */
  function regId() {
    const n = Math.floor(1000 + Math.random() * 9000);
    return `MPL-S1-${Date.now().toString(36).toUpperCase().slice(-4)}${n}`;
  }

  async function uploadImage(file, path) {
    const compressed = await compressImage(file);
    const { error } = await sb.storage
      .from(CFG.STORAGE_BUCKET)
      .upload(path, compressed, { contentType: "image/jpeg", upsert: false });
    if (error) throw error;
    const { data } = sb.storage.from(CFG.STORAGE_BUCKET).getPublicUrl(path);
    return data.publicUrl;
  }

  async function submit(e) {
    e.preventDefault();
    if (!validate()) return;

    const btn = $("#btnSubmit");
    const label = $(".btn-label", btn);
    btn.disabled = true;
    btn.classList.add("busy");
    label.textContent = "Locking your spot…";

    const id = regId();
    const record = {
      reg_code: id,
      full_name: $("#fullName").value.trim(),
      phone: $("#phone").value.trim(),
      email: $("#email").value.trim() || null,
      gender: state.gender,
      dupr: $("#dupr").value ? Number($("#dupr").value) : null,
      category: state.categoryLabel,
      partner_name: state.needsPartner ? $("#partnerName").value.trim() : null,
      jersey_size: state.jerseySize,
      jersey_name: $("#jerseyName").value.trim().toUpperCase(),
      payment_method: state.payment,
      profile_pic_url: null,
      payment_screenshot_url: null,
      status: "pending",
    };

    try {
      // late-init safety net: never silently demo-save when configured LIVE
      if (LIVE && !sb && window.supabase) {
        sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
      }
      if (LIVE && !sb) {
        throw new Error("Supabase client failed to load");
      }
      if (LIVE && sb) {
        const stamp = Date.now();
        record.profile_pic_url = await uploadImage(
          state.profileFile,
          `profile/${id}-${stamp}.jpg`
        );
        if (state.payment === "Online" && state.paymentFile) {
          record.payment_screenshot_url = await uploadImage(
            state.paymentFile,
            `payment/${id}-${stamp}.jpg`
          );
        }
        const { error } = await sb.from("registrations").insert(record);
        if (error) throw error;
      } else {
        // demo mode: persist locally so the flow is fully testable
        await new Promise((r) => setTimeout(r, 1400));
        const store = JSON.parse(localStorage.getItem("mpl_demo") || "[]");
        store.push({ ...record, created_at: new Date().toISOString() });
        localStorage.setItem("mpl_demo", JSON.stringify(store));
      }
      showSuccess(record);
    } catch (err) {
      console.error(err);
      showAlert(
        "Something went wrong while locking your spot — please try again. " +
          "If it keeps failing, WhatsApp us on " + EV.phones[0] + "."
      );
    } finally {
      btn.disabled = false;
      btn.classList.remove("busy");
      label.textContent = "Lock In My Spot";
    }
  }

  $("#regForm").addEventListener("submit", submit);

  /* ------------------------------------------------------------
     SUCCESS PAGE + PAGE TRANSITIONS
     ------------------------------------------------------------ */
  function switchPage(fromId, toId) {
    const from = $(fromId);
    const to = $(toId);
    from.classList.add("leave");
    setTimeout(() => {
      from.classList.remove("active", "leave");
      to.classList.add("active", "enter");
      window.scrollTo({ top: 0, behavior: "instant" });
      setTimeout(() => to.classList.remove("enter"), 800);
    }, 380);
  }

  function showSuccess(r) {
    $("#successSub").innerHTML = state.payment === "Online"
      ? `Your registration is in, <b>${r.full_name}</b>. We'll verify your payment and confirm on WhatsApp shortly.`
      : `Your registration is in, <b>${r.full_name}</b>. Pay the entry fee in cash at the venue desk to confirm your spot.`;

    const rows = [
      ["Reg. Code", r.reg_code, "mono"],
      ["Player", r.full_name],
      ["Category", r.category],
      r.partner_name ? ["Partner", r.partner_name] : null,
      r.dupr != null ? ["DUPR", r.dupr.toFixed(3)] : ["DUPR", "Unrated"],
      ["Jersey", `${r.jersey_size} · “${r.jersey_name}”`],
      ["Payment", r.payment_method === "Online" ? "Online · screenshot received" : "Cash at venue"],
    ].filter(Boolean);

    $("#ticketBody").innerHTML = rows
      .map(
        ([k, v, cls]) =>
          `<div class="t-row"><span class="k">${k}</span><span class="v ${cls || ""}">${v}</span></div>`
      )
      .join("");
    $("#ticketFoot").textContent = `${EV.dates} · ${EV.venue} · See you on court 🏆`;

    switchPage("#page-form", "#page-success");
    setTimeout(fireConfetti, 500);
  }

  $("#btnAnother").addEventListener("click", () => {
    resetForm();
    switchPage("#page-success", "#page-form");
  });

  function resetForm() {
    $("#regForm").reset();
    $$(".pill.on, .cat.on").forEach((b) => {
      b.classList.remove("on");
      b.setAttribute("aria-checked", "false");
    });
    $$(".upload.filled").forEach((u) => u.classList.remove("filled"));
    $$(".field.error").forEach(clearError);
    Object.assign(state, {
      gender: "",
      category: "",
      categoryLabel: "",
      needsPartner: false,
      jerseySize: "",
      profileFile: null,
      paymentFile: null,
    });
    $("#partnerSlide").classList.remove("open");
    $("#jPrevName").textContent = "NAME";
    $("#jPrevSize").textContent = "—";
    hideAlert();
  }

  /* ------------------------------------------------------------
     CONFETTI (tiny, dependency-free)
     ------------------------------------------------------------ */
  function fireConfetti() {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const cv = $("#confetti");
    const ctx = cv.getContext("2d");
    cv.width = innerWidth;
    cv.height = innerHeight;
    const colors = ["#e5262d", "#ff5a5f", "#f4f2ef", "#2fbf71", "#a1121a"];
    const parts = Array.from({ length: 130 }, () => ({
      x: innerWidth / 2 + (Math.random() - 0.5) * 120,
      y: innerHeight * 0.32,
      vx: (Math.random() - 0.5) * 13,
      vy: -6 - Math.random() * 9,
      w: 5 + Math.random() * 6,
      h: 3 + Math.random() * 5,
      r: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      c: colors[(Math.random() * colors.length) | 0],
    }));
    let t = 0;
    (function frame() {
      ctx.clearRect(0, 0, cv.width, cv.height);
      for (const p of parts) {
        p.vy += 0.28;
        p.x += p.vx;
        p.y += p.vy;
        p.r += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.r);
        ctx.fillStyle = p.c;
        ctx.globalAlpha = Math.max(0, 1 - t / 130);
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (++t < 140) requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, cv.width, cv.height);
    })();
  }

  /* ------------------------------------------------------------
     BOOT
     ------------------------------------------------------------ */
  window.addEventListener("DOMContentLoaded", () => {
    initBackend();
    startRain();
    runSplash();
  });
})();
