/* rosfield.com/test: the bar opens into the conversation and closes back to the bar.
   The chat itself (send, replies, cards) is /assets/chat.js; this file only moves the furniture.
   CSP is script-src 'self': no inline script or style attributes, so motion uses the Web Animations API. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const sheet = $("sheet");
  const form = $("composer");
  const box = $("message");
  const log = $("log");
  const scroll = $("scroll");
  const closeBtn = $("close");
  const boot = $("boot");
  if (!sheet || !form || !box || !log || !scroll) return;

  const bg = sheet.querySelector(".sheet-bg");
  const head = sheet.querySelector(".sheet-head");
  const mark = sheet.querySelector(".head-mark");
  const foot = sheet.querySelector(".sheet-foot");
  const calm = matchMedia("(prefers-reduced-motion: reduce)");
  const phone = matchMedia("(max-width: 640px)");
  const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
  const OUT = "cubic-bezier(0.2, 0, 0, 1)";
  const GLYPHS = "01<>{}[]/\\=+*#%&$?;:._-~^|abcdefghkmnprstuvwxyz";

  let state = "rest"; // rest | opening | open | closing
  let running = [];
  let lastGesture = 0;
  let everClosed = false;

  const anim = (node, frames, opts) => {
    if (!node || !node.animate) return null;
    const a = node.animate(frames, Object.assign({ fill: "both" }, opts));
    running.push(a);
    return a;
  };
  const settle = () => {
    for (const a of running) {
      try {
        a.cancel();
      } catch (_) {}
    }
    running = [];
  };
  const rel = (r, base) => ({
    top: r.top - base.top,
    left: r.left - base.left,
    right: base.right - r.right,
    bottom: base.bottom - r.bottom,
  });
  const px = (n) => Math.round(n * 100) / 100 + "px";
  const radiusOf = (node) => parseFloat(getComputedStyle(node).borderTopLeftRadius) || 0;

  /* Empty composer: the send button rests until there is something to send */
  const syncEmpty = () => form.classList.toggle("is-empty", !box.value.trim());
  box.addEventListener("input", syncEmpty);
  form.addEventListener("submit", () => setTimeout(syncEmpty, 0));
  syncEmpty();

  /* Keyboard-safe sheet on phones (iOS ignores interactive-widget): follow the visual viewport */
  const vv = window.visualViewport;
  const fitViewport = () => {
    if (!vv || !phone.matches || state === "rest") {
      sheet.style.removeProperty("height");
      sheet.style.removeProperty("bottom");
      sheet.style.removeProperty("top");
      return;
    }
    sheet.style.top = px(vv.offsetTop);
    sheet.style.bottom = "auto";
    sheet.style.height = px(vv.height);
  };
  if (vv) {
    vv.addEventListener("resize", fitViewport);
    vv.addEventListener("scroll", fitViewport);
  }

  /* The opening "code": each line of the greeting first appears as shimmering pixel glyphs */
  let scrambleTimer = 0;
  const lineRects = (node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const rows = [];
    for (const r of range.getClientRects()) {
      if (r.width < 2) continue;
      const row = rows.find((x) => Math.abs(x.top - r.top) < 4);
      if (row) {
        row.left = Math.min(row.left, r.left);
        row.right = Math.max(row.right, r.right);
      } else rows.push({ top: r.top, left: r.left, right: r.right, height: r.height });
    }
    return rows;
  };
  const randomRun = (n) => {
    let s = "";
    const pick = () => GLYPHS[(Math.random() * GLYPHS.length) | 0];
    for (let i = 0; i < n; i++) s += i > 0 && i < n - 1 && s[i - 1] !== " " && Math.random() < 0.16 ? " " : pick();
    return s;
  };
  const startCode = () => {
    if (!boot) return false;
    const first = log.querySelector(".msg-rosie p");
    if (!first) return false;
    boot.textContent = "";
    const base = sheet.getBoundingClientRect();
    const rows = lineRects(first).slice(0, 4);
    if (!rows.length) return false;
    const lines = rows.map((r) => {
      const n = Math.max(6, Math.round((r.right - r.left) / 9.4));
      const s = document.createElement("span");
      s.className = "boot-line";
      s.style.left = px(r.left - base.left);
      s.style.top = px(r.top - base.top + (r.height - 15) / 2);
      s.style.width = px(r.right - r.left);
      s.style.overflow = "hidden";
      s.textContent = randomRun(n);
      s.dataset.n = String(n);
      boot.append(s);
      return s;
    });
    clearInterval(scrambleTimer);
    scrambleTimer = setInterval(() => {
      for (const s of lines) s.textContent = randomRun(+s.dataset.n);
    }, 60);
    lines.forEach((s, i) => {
      // Streams in left to right like code being written, with one light sweep through it
      anim(s, [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }], {
        duration: 300,
        delay: 150 + i * 90,
        easing: "cubic-bezier(0.4, 0, 0.2, 1)",
      });
      anim(s, [{ backgroundPosition: "100% 0" }, { backgroundPosition: "0% 0" }], {
        duration: 560,
        delay: 160 + i * 90,
        easing: "linear",
      });
    });
    return true;
  };
  const stopCode = () => {
    clearInterval(scrambleTimer);
    scrambleTimer = 0;
  };

  /* ---------- Open ---------- */
  function open() {
    if (state === "open" || state === "opening") return;
    settle();
    stopCode();
    const reduce = calm.matches;
    const fresh = log.childElementCount <= 1;

    const barFrom = form.getBoundingClientRect();
    const markFrom = mark.getBoundingClientRect();
    const radiusFrom = radiusOf(form);

    state = "opening";
    body.classList.remove("is-rest", "is-morph");
    body.classList.add("is-open");
    fitViewport();
    scroll.scrollTop = scroll.scrollHeight;

    const base = sheet.getBoundingClientRect();
    const barTo = form.getBoundingClientRect();
    const markTo = mark.getBoundingClientRect();
    const radiusTo = radiusOf(bg);
    const items = Array.from(log.children).slice(-4);
    const done = () => {
      if (state !== "opening") return;
      settle();
      stopCode();
      state = "open";
    };

    if (reduce) {
      anim(sheet, [{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: "linear" }).finished.then(done, () => {});
      return;
    }

    const D = 560;
    // 1. The white sheet grows out of the bar
    const r = rel(barFrom, base);
    anim(
      bg,
      [
        { top: px(r.top), left: px(r.left), right: px(r.right), bottom: px(r.bottom), borderRadius: px(radiusFrom) },
        { top: "0px", left: "0px", right: "0px", bottom: "0px", borderRadius: px(radiusTo) },
      ],
      { duration: D, easing: EASE },
    );
    // 2. The bar itself glides down to dock as the composer
    anim(
      form,
      [
        { transform: `translate(${px(barFrom.left - barTo.left)}, ${px(barFrom.top - barTo.top)})` },
        { transform: "none" },
      ],
      { duration: D, easing: EASE },
    );
    // 3. The mark lifts into the corner
    const s = markFrom.height / Math.max(1, markTo.height);
    anim(
      mark,
      [
        { transform: `translate(${px(markFrom.left - markTo.left)}, ${px(markFrom.top - markTo.top)}) scale(${s})` },
        { transform: "none" },
      ],
      { duration: D, easing: EASE },
    );
    anim(
      closeBtn,
      [
        { opacity: 0, transform: "scale(0.85)" },
        { opacity: 1, transform: "none" },
      ],
      {
        duration: 320,
        delay: 260,
        easing: OUT,
      },
    );
    anim(foot, [{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: 380, easing: "linear" });

    // 4. The code, then the conversation
    let contentDelay = 300;
    if (fresh && startCode()) {
      anim(boot, [{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.74 }, { opacity: 0 }], {
        duration: 660,
        delay: 140,
        easing: "linear",
      });
      contentDelay = 660;
    }
    anim(scroll, [{ opacity: 0 }, { opacity: 1 }], { duration: 1, delay: contentDelay - 1 });
    let last = null;
    items.forEach((node, i) => {
      last = anim(
        node,
        [
          { opacity: 0, transform: "translateY(6px)" },
          { opacity: 1, transform: "none" },
        ],
        {
          duration: 300,
          delay: contentDelay + i * 45,
          easing: OUT,
        },
      );
    });
    const tail = last ? last.finished : Promise.resolve();
    Promise.all([tail, running[0] && running[0].finished]).then(done, () => {});
  }

  /* ---------- Close ---------- */
  function close() {
    if (state === "rest" || state === "closing") return;
    settle();
    stopCode();
    everClosed = true;
    const reduce = calm.matches;
    if (document.activeElement && sheet.contains(document.activeElement)) document.activeElement.blur();

    const base = sheet.getBoundingClientRect();
    const barFrom = form.getBoundingClientRect();
    const markFrom = mark.getBoundingClientRect();
    const radiusFrom = radiusOf(bg);

    state = "closing";
    const finish = () => {
      if (state !== "closing") return;
      settle();
      body.classList.remove("is-morph");
      state = "rest";
      fitViewport();
    };

    if (reduce) {
      anim(sheet, [{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: "linear" }).finished.then(
        () => {
          settle();
          body.classList.remove("is-open");
          body.classList.add("is-rest");
          fitViewport();
          anim(sheet, [{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: "linear" }).finished.then(
            finish,
            () => {},
          );
        },
        () => {},
      );
      return;
    }

    body.classList.remove("is-open");
    body.classList.add("is-rest", "is-morph");
    fitViewport();
    const base2 = sheet.getBoundingClientRect();
    const barTo = form.getBoundingClientRect();
    const markTo = mark.getBoundingClientRect();
    const radiusTo = radiusOf(form);
    const D = 480;

    // The conversation leaves first; the classes have already hidden it, so draw it fading out
    const ghost = (node) =>
      anim(
        node,
        [
          { visibility: "visible", opacity: 1 },
          { visibility: "visible", opacity: 0 },
        ],
        {
          duration: 160,
          easing: "linear",
        },
      );
    ghost(scroll);
    ghost(foot);
    ghost(closeBtn);

    const r = rel(barTo, base2);
    const dy = base.top - base2.top;
    const a = anim(
      bg,
      [
        { top: px(dy), left: "0px", right: "0px", bottom: px(-dy), borderRadius: px(radiusFrom), opacity: 1 },
        {
          top: px(r.top),
          left: px(r.left),
          right: px(r.right),
          bottom: px(r.bottom),
          borderRadius: px(radiusTo),
          opacity: 1,
          offset: 0.92,
        },
        {
          top: px(r.top),
          left: px(r.left),
          right: px(r.right),
          bottom: px(r.bottom),
          borderRadius: px(radiusTo),
          opacity: 0,
        },
      ],
      { duration: D, delay: 60, easing: EASE },
    );
    anim(
      form,
      [
        { transform: `translate(${px(barFrom.left - barTo.left)}, ${px(barFrom.top - barTo.top)})` },
        { transform: "none" },
      ],
      { duration: D, delay: 60, easing: EASE },
    );
    const s = markFrom.height / Math.max(1, markTo.height);
    anim(
      mark,
      [
        { transform: `translate(${px(markFrom.left - markTo.left)}, ${px(markFrom.top - markTo.top)}) scale(${s})` },
        { transform: "none" },
      ],
      { duration: D, delay: 60, easing: EASE },
    );
    a.finished.then(finish, () => {});
  }

  /* ---------- Listings: photo cards, and a swipeable strip for two or more ----------
     chat.js draws each listing as its own card; this only dresses and groups them, so its markup stays its own.
     The photos are samples until businesses' own uploads reach the listing. */
  const PICS = {
    floor: ["floor-1", "floor-2", "floor-3", "floor-4"],
    barber: ["barber-1", "barber-2", "barber-3"],
    room: ["room-1", "plank-1"],
  };
  const used = { floor: 0, barber: 0, room: 0 };
  const kindOf = (t) =>
    /barber|haircut|hair cut|fade|beard|shave|salon/i.test(t)
      ? "barber"
      : /floor|hardwood|tile|vinyl|carpet|laminate|plank|refinish/i.test(t)
        ? "floor"
        : "room";
  const dress = (card) => {
    if (card.dataset.dressed) return;
    card.dataset.dressed = "1";
    const kind = kindOf(card.textContent || "");
    const pic = document.createElement("div");
    pic.className = "card-pic";
    const img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    img.src = "/assets/photos/" + PICS[kind][used[kind]++ % PICS[kind].length] + ".webp";
    pic.append(img);
    const kicker = card.querySelector(".card-kicker");
    const name = card.querySelector("h3");
    if (kicker) pic.append(kicker);
    if (name) pic.append(name);
    const label = card.querySelector(".sr-only");
    if (label) label.after(pic);
    else card.prepend(pic);
    // The whole photo is the listing's link: name it after the business, so each card says which one it opens
    const open = card.querySelector(".card-actions a");
    if (open && name) open.setAttribute("aria-label", "View listing: " + name.textContent.trim());
    const prev = card.previousElementSibling;
    if (prev && prev.classList.contains("results-wrap")) {
      const strip = prev.querySelector(".results");
      strip.append(card);
      requestAnimationFrame(() => strip.dispatchEvent(new Event("scroll")));
    } else if (prev && prev.classList.contains("card-listing")) {
      const wrap = document.createElement("div");
      wrap.className = "results-wrap at-start";
      const strip = document.createElement("div");
      strip.className = "results";
      const step = (dir, cls, text, d) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "rs-btn " + cls;
        b.setAttribute("aria-label", text);
        b.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="' +
          d +
          '"/></svg>';
        b.addEventListener("click", () => {
          const one = strip.querySelector(".card-listing");
          strip.scrollBy({ left: dir * ((one ? one.offsetWidth : 240) + 12), behavior: calm.matches ? "auto" : "smooth" });
        });
        return b;
      };
      const edges = () => {
        wrap.classList.toggle("at-start", strip.scrollLeft <= 1);
        wrap.classList.toggle("at-end", strip.scrollLeft >= strip.scrollWidth - strip.clientWidth - 1);
      };
      strip.addEventListener("scroll", edges, { passive: true });
      wrap.append(strip, step(-1, "rs-prev", "Previous", "M14.5 6 8.5 12l6 6"), step(1, "rs-next", "Next", "M9.5 6l6 6-6 6"));
      prev.before(wrap);
      strip.append(prev, card);
      requestAnimationFrame(edges);
    }
  };
  // A saved conversation replays through chat.js's own render path, then chat.js scrolls to the end and strips
  // msg-in from what it replayed. Cards dressed after that keep the thread at its end, as chat.js meant it.
  const dressAll = (cards, replayed) => {
    let changed = false;
    for (const c of cards) {
      if (c.dataset.dressed) continue;
      dress(c);
      changed = true;
    }
    if (changed && replayed) scroll.scrollTop = scroll.scrollHeight;
  };
  if (window.MutationObserver) {
    new MutationObserver((records) => {
      const cards = [];
      for (const r of records)
        for (const n of r.addedNodes) if (n.nodeType === 1 && n.classList.contains("card-listing")) cards.push(n);
      if (cards.length) dressAll(cards, cards.some((c) => !c.classList.contains("msg-in")));
    }).observe(log, { childList: true });
  }
  dressAll(log.querySelectorAll(".card-listing"), true);

  /* ---------- Wiring ---------- */
  const gesture = () => {
    lastGesture = Date.now();
  };
  document.addEventListener("pointerdown", gesture, true);
  document.addEventListener("keydown", gesture, true);

  // Focusing the bar opens it. A programmatic focus after the visitor closed the sheet does not.
  form.addEventListener("focusin", () => {
    if (state !== "rest" && state !== "closing") return;
    if (everClosed && Date.now() - lastGesture > 800) {
      box.blur();
      return;
    }
    open();
  });
  form.addEventListener("click", () => {
    if (state === "rest" || state === "closing") {
      open();
      box.focus();
    }
  });
  if (closeBtn) closeBtn.addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (state === "open" || state === "opening")) {
      e.preventDefault();
      close();
    }
  });
  // A hash of #chat opens straight away (links from the landing page)
  if (location.hash === "#chat" || location.hash === "#open") {
    requestAnimationFrame(() => box.focus());
  }

  // A small hook for automated checks
  window.__rosie = { open, close, state: () => state };
})();
