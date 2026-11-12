/* Rosie web chat. Vanilla JS, same-origin only (POST /api/chat, GET /api/chat/history). A saved session replays its
   conversation on load, so a reload keeps the chat (the memory lives on the server, per session). */
(() => {
  "use strict";

  const GREETING =
    "Hi! I’m Rosie. I can help you find and book a local pro, or get your business booked. What can I do for you?";
  const OFFLINE =
    "Sorry, I couldn’t reach the desk just now. Please try again in a moment, or text me on iMessage at ROSFIELD_TEST_IMESSAGE_NUMBER.";
  const SESSION_KEY = "rosfield_session";

  const $ = (id) => document.getElementById(id);
  const form = $("composer");
  const box = $("message");
  const send = $("send");
  const log = $("log");
  const scroll = $("scroll");
  const typing = $("typing");
  const suggest = $("suggest");
  if (!form || !box || !log || !scroll) return;

  const calm = matchMedia("(prefers-reduced-motion: reduce)");
  let busy = false;

  /* Session id: kept in localStorage when it is allowed, in memory when it is not */
  const makeId = () => {
    try {
      if (crypto && crypto.randomUUID) return "web-" + crypto.randomUUID();
    } catch (_) {}
    return "web-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  };
  let memorySession = null;
  /* The saved session id, without making one (null when there is none or storage is blocked). */
  const savedSession = () => {
    try {
      return localStorage.getItem(SESSION_KEY) || null;
    } catch (_) {
      return null;
    }
  };
  const getSession = () => {
    try {
      let id = localStorage.getItem(SESSION_KEY);
      if (!id) {
        id = makeId();
        localStorage.setItem(SESSION_KEY, id);
      }
      return id;
    } catch (_) {
      if (!memorySession) memorySession = makeId();
      return memorySession;
    }
  };

  /* Small DOM helpers. Everything is built with textContent, never innerHTML. */
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  };
  const safeUrl = (u) => {
    if (typeof u !== "string") return null;
    if (u.startsWith("/") && !u.startsWith("//")) return u;
    try {
      const x = new URL(u);
      return x.protocol === "https:" || x.protocol === "http:" ? x.href : null;
    } catch (_) {
      return null;
    }
  };
  const link = (href, text, cls, external) => {
    const a = el("a", cls, text);
    a.href = safeUrl(href) || "#";
    if (external) {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
    return a;
  };

  /* **bold** and bare links inside a text reply */
  const TOKEN = /\*\*([^*]+?)\*\*|(https?:\/\/[^\s<]+)/g;
  const richText = (text) => {
    const frag = document.createDocumentFragment();
    let last = 0;
    String(text).replace(TOKEN, (m, bold, url, idx) => {
      if (idx > last) frag.append(text.slice(last, idx));
      if (bold != null) {
        frag.append(el("strong", "", bold));
      } else {
        const tail = (url.match(/[.,;:!?)\]]+$/) || [""])[0];
        const clean = tail ? url.slice(0, -tail.length) : url;
        frag.append(link(clean, clean, "", true));
        if (tail) frag.append(tail);
      }
      last = idx + m.length;
      return m;
    });
    if (last < text.length) frag.append(text.slice(last));
    return frag;
  };

  const rowsOf = (pairs) => {
    const dl = el("dl", "card-rows");
    for (const [k, v] of pairs) {
      if (v == null || v === "") continue;
      const row = document.createElement("div");
      row.append(el("dt", "", k));
      const dd = el("dd");
      if (v instanceof Node) dd.append(v);
      else dd.textContent = String(v);
      row.append(dd);
      dl.append(row);
    }
    return dl;
  };

  /* Message containers */
  const shell = (who, label, cls) => {
    const m = el("div", "msg msg-" + who + " msg-in" + (cls ? " " + cls : ""));
    m.append(el("span", "sr-only", label));
    return m;
  };
  const youBubble = (text) => {
    const m = shell("you", "You: ");
    m.append(el("p", "", text));
    log.append(m);
    return m;
  };
  const textBubble = (text) => {
    const m = shell("rosie", "Rosie: ");
    const p = el("p");
    p.append(richText(text));
    m.append(p);
    log.append(m);
    return m;
  };

  const listingCard = (l) => {
    const m = shell("rosie", "Rosie shows a listing: ", "msg-card card-listing");
    m.append(el("span", "card-kicker", "Live listing"));
    m.append(el("h3", "", l.name));
    const addr =
      l.address && (!l.city || String(l.address).includes(l.city))
        ? l.address
        : [l.address, l.city, [l.state, l.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    m.append(el("p", "card-addr", addr));
    const services = el("ul");
    for (const s of l.services || []) {
      const li = el("li");
      li.append(el("span", "", s.name));
      if (s.price_text) {
        li.append(" ");
        li.append(el("span", "price", "— " + s.price_text));
      }
      services.append(li);
    }
    const team = el("ul");
    for (const t of l.team || []) team.append(el("li", "", t.role ? t.name + ", " + t.role : t.name));
    m.append(
      rowsOf([
        ["Services", services.childElementCount ? services : null],
        ["Hours", l.hours_text],
        ["Area", l.area_text],
        ["Team", team.childElementCount ? team : null],
      ]),
    );
    const actions = el("div", "card-actions");
    actions.append(link("/listing.html?slug=" + encodeURIComponent(l.slug), "View listing", "btn"));
    m.append(actions);
    log.append(m);
    return m;
  };

  const timesRow = (times) => {
    const wrap = el("div", "times");
    wrap.setAttribute("role", "group");
    wrap.setAttribute("aria-label", "Available times");
    for (const t of times) {
      const b = el("button", "chip time-btn", t.label);
      b.type = "button";
      b.addEventListener("click", () => {
        if (busy) return;
        for (const x of wrap.querySelectorAll("button")) {
          x.disabled = true;
          if (x === b) x.setAttribute("aria-pressed", "true");
        }
        submit(t.label);
      });
      wrap.append(b);
    }
    log.append(wrap);
    return wrap;
  };

  const bookedCard = (r) => {
    const b = r.booking || {};
    const m = shell("rosie", "Rosie confirms a booking: ", "msg-card card-booked");
    const kick = el("span", "card-kicker");
    const mark = el("span", "booked-mark");
    mark.setAttribute("aria-hidden", "true");
    mark.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
    kick.append(mark, "Booked");
    m.append(kick);
    m.append(el("h3", "", [b.service, b.business].filter(Boolean).join(" with ")));
    m.append(
      rowsOf([
        ["When", b.when_text],
        ["Where", b.address],
        ["For", b.customer_name],
        ["Tech", b.tech_name],
        ["Booking", b.id],
      ]),
    );
    const actions = el("div", "card-actions");
    if (safeUrl(r.google_url)) actions.append(link(r.google_url, "Add to Google Calendar", "btn btn-solid", true));
    if (safeUrl(r.ics_url)) actions.append(link(r.ics_url, "Add to Apple Calendar (.ics)", "btn", true));
    m.append(actions);
    log.append(m);
    return m;
  };

  const render = (reply) => {
    if (!reply || typeof reply !== "object") return null;
    switch (reply.kind) {
      case "text":
        return reply.text ? textBubble(reply.text) : null;
      case "listing":
        return reply.listing ? listingCard(reply.listing) : null;
      case "times":
        return Array.isArray(reply.times) && reply.times.length ? timesRow(reply.times) : null;
      case "booked":
        return reply.booking ? bookedCard(reply) : null;
      default:
        return null;
    }
  };

  /* Scrolling: follow the newest reply, but never hide the top of a tall card */
  const reveal = (first) => {
    const behavior = calm.matches ? "auto" : "smooth";
    const bottom = scroll.scrollHeight - scroll.clientHeight;
    let top = bottom;
    if (first) {
      const offset = first.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop - 12;
      top = Math.min(bottom, Math.max(0, offset));
    }
    scroll.scrollTo({ top, behavior });
  };
  const showTyping = (on) => {
    typing.hidden = !on;
    if (on) scroll.scrollTo({ top: scroll.scrollHeight, behavior: calm.matches ? "auto" : "smooth" });
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, calm.matches ? 0 : ms));

  const post = async (text) => {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ session: getSession(), text }),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    return Array.isArray(data && data.replies) ? data.replies : [];
  };

  async function submit(raw) {
    const text = String(raw == null ? box.value : raw).trim();
    if (!text || busy) return;
    busy = true;
    send.disabled = true;
    if (suggest) suggest.hidden = true;
    const mine = youBubble(text);
    reveal(mine);
    if (raw == null) box.value = "";
    showTyping(true);
    let replies;
    try {
      replies = await post(text);
    } catch (_) {
      replies = [{ kind: "text", text: OFFLINE }];
    }
    if (!replies.length) replies = [{ kind: "text", text: "Sorry, I didn’t catch that. Could you say it another way?" }];
    for (let i = 0; i < replies.length; i++) {
      if (i > 0) {
        showTyping(true);
        await wait(450);
      }
      showTyping(false);
      const node = render(replies[i]);
      if (node) reveal(node);
    }
    showTyping(false);
    busy = false;
    send.disabled = false;
    if (raw == null) box.focus();
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submit();
  });
  if (suggest) {
    suggest.addEventListener("click", (e) => {
      const chip = e.target.closest("[data-fill]");
      if (!chip) return;
      box.value = chip.dataset.fill;
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    });
  }

  /* On load: a saved session's conversation, replayed in order (the person's words too), then scrolled to the end.
     Old time chips stay visible but only the last one can still be tapped. Without one (or if it fails): the greeting. */
  const restore = async () => {
    const id = savedSession();
    if (!id) return false;
    let replies = [];
    try {
      const res = await fetch("/api/chat/history?session=" + encodeURIComponent(id), { headers: { Accept: "application/json" } });
      if (!res.ok) return false;
      const data = await res.json();
      replies = Array.isArray(data && data.replies) ? data.replies : [];
    } catch (_) {
      return false;
    }
    if (!replies.length) return false;
    if (suggest) suggest.hidden = true;
    let lastTimes = null;
    replies.forEach((r) => {
      if (r && r.kind === "user") {
        if (r.text) youBubble(r.text);
        return;
      }
      const node = render(r);
      if (node && r.kind === "times") lastTimes = node;
    });
    for (const row of log.querySelectorAll(".times")) {
      if (row === lastTimes && row === log.lastElementChild) continue;
      for (const b of row.querySelectorAll("button")) b.disabled = true;
    }
    for (const m of log.querySelectorAll(".msg-in")) m.classList.remove("msg-in");
    scroll.scrollTo({ top: scroll.scrollHeight, behavior: "auto" });
    return true;
  };

  restore().then((done) => {
    if (!done) textBubble(GREETING);
  });
})();
