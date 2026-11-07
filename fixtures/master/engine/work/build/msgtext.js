/* Rich messages (Jay, Oct 21, 2026, night): a message can carry one chat element as its 4th part, so the blueprint
   shows it the way iMessage, WhatsApp and RCS show it (buttons, a table, a card, a time picker, a code, photos, a form,
   stars), not as a wall of text. Customers on plain SMS get the same message as text: smsText() writes it.
   A message is [from, to, text] or [from, to, text, ui]. The text stays short; the element carries the structure.
     ui.card    { title, lines: [], button: "Book", link: "rosfield.com/..." }  a card with one action
     ui.pay     { amount: "$55", what: "Signature cut", link }                  a pay card
     ui.list    { head: [], rows: [[...], ...], numbers: true, plain: true }     a table; rows lettered A, B, C (numbered, or plain)
     ui.times   ["Sat Oct 24 · 10:00am · Riley", ...]                           a time picker, lettered A, B, C
     ui.buttons ["Accept", "Another time", "Decline"]                           taps, numbered 1, 2, 3 (letters: true for A, B)
     ui.code    "4821"                                                          the check-in code, big
     ui.photos  ["Jordan, from Lee Home Services", ...]                         photos side by side
     ui.form    ["Name", "Address", "Card"]                                     the fields of a secure page
     ui.stars   true                                                            a 1 to 5 star rating
     ui.stop    true                                                            ends with S13-02's line: "Reply STOP to opt out. Msg & data
                                                                                rates may apply. Reply HELP for help." (part B, Oct 25; the
                                                                                rates and HELP parts are left out when the text already says them)
     ui.stop    "first"                                                         the same line, but only when this is the first text the number
                                                                                gets on the walked path (tools D, D61: the overlay core's
                                                                                firstTexts/applyStops settle it per path; read alone, it shows)
     ui.lang    "es"                                                            the words around the element in Spanish
     ui.as      "Lucia"                                                         the one person on a shared lane this message is to or from
     ui.en      "She's told: …"                                                 English for the reader, under a message in another language (never sent)
     ui.photoLink "rosfield.com/m/o12"                                          where plain SMS finds the photo (the pro's photo is the door check)
   Used by build/check.js, build/lint.js, program/<prof>/messages-gen.js and (inlined) the page. */
(function (root) {
  "use strict";
  var KEYS = ["card", "pay", "list", "times", "buttons", "letters", "code", "photos", "photoLink", "form", "stars", "stop", "lang", "as", "en"];
  var L = function (i) { return String.fromCharCode(65 + i); };
  var OPTOUT = ["STOP", "STOPALL", "CANCEL", "END", "QUIT", "UNSUBSCRIBE", "REVOKE", "OPTOUT", "OPT OUT", "CANCELAR", "PARA", "PARAR", "ALTO", "BASTA", "DETENER", "FIN"];
  /* the words around the element, in the message's language (English, or lang: "es") */
  var WORDS = { en: { reply: "Reply", or: "or", code: "Your check-in code: ", page: "On the secure page: ", photo: "photo", photoOf: "Photo of ", stars: "Tap a star on the page, 1 to 5.", starsReply: "Reply with a number, 1 to 5.", stop: "Reply STOP to opt out.", rates: "Msg & data rates may apply.", help: "Reply HELP for help.", pay: "Pay", for: "for", codeLabel: "Check-in code" },
    es: { reply: "Responda", or: "o", code: "Su código de llegada: ", page: "En la página segura: ", photo: "foto", photoOf: "Foto de ", stars: "Toque una estrella en la página, del 1 al 5.", starsReply: "Responda con un número, del 1 al 5.", stop: "Responda STOP para no recibir más.", rates: "Pueden aplicarse tarifas de mensajes y datos.", help: "Responda HELP para recibir ayuda.", pay: "Pagar", for: "por", codeLabel: "Código de llegada" } };
  /* a button is a label (numbered 1, 2, 3 or lettered A, B, C) or [its own key, label], like ["3", "I'm here"] */
  var bKey = function (b, i, letters) { return Array.isArray(b) ? String(b[0]) : letters ? L(i) : String(i + 1); };
  var bLab = function (b) { return Array.isArray(b) ? b[1] : b; };
  var words = function (u) { return WORDS[(u && u.lang) || "en"] || WORDS.en; };
  /* a closing period, unless the words already end a sentence ("Call A.M." stays "Call A.M.", not "Call A.M..") */
  var dot = function (t) { return /[.!?]$/.test(t) ? t : t + "."; };

  /* the opt-out line a first text ends with (S13-02): STOP, then the rates and HELP parts unless the text says them */
  function stopLine(u, text) {
    var w = words(u), t = String(text || ""), parts = [w.stop];
    if (!/msg\s*(?:&|and)\s*data rates|tarifas de mensajes/i.test(t)) parts.push(w.rates);
    if (!/\bHELP\b|\bAYUDA\b/.test(t)) parts.push(w.help);
    return parts.join(" ");
  }
  /* what a customer on plain SMS gets */
  function smsText(m) {
    var t = String(m[2] || ""), u = m[3];
    if (!u) return t;
    var w = words(u), orList = function (xs) { return xs.length < 2 ? xs.join("") : xs.slice(0, -1).join(", ") + " " + w.or + " " + xs[xs.length - 1]; };
    var out = t ? [t] : [];
    if (u.card) { var c = u.card; out.push([c.title].concat(c.lines || []).filter(Boolean).join("\n") + (c.link ? "\n" + (c.button ? c.button + ": " : "") + c.link : "")); }
    if (u.pay) out.push(w.pay + " " + u.pay.amount + (u.pay.what ? " " + w.for + " " + u.pay.what : "") + (u.pay.link ? ": " + u.pay.link : ""));
    if (u.list) {
      out.push((u.list.rows || []).map(function (r, i) { return (u.list.plain ? "" : (u.list.numbers ? i + 1 : L(i)) + ") ") + r.join(" · "); }).join("\n"));
      if (u.list.pick) out.push(w.reply + " " + orList(u.list.rows.map(function (r, i) { return String(u.list.numbers ? i + 1 : L(i)); })) + ".");
    }
    if (u.times) out.push(u.times.map(function (x, i) { return L(i) + ") " + x; }).join("\n") + "\n" + w.reply + " " + orList(u.times.map(function (x, i) { return L(i); })) + ".");
    if (u.code) out.push(w.code + u.code);
    if (u.form) out.push(dot(w.page + u.form.join(", ")));
    if (u.photos) out.push(u.photoLink ? (u.photos.length === 1 ? w.photoOf + u.photos[0] : u.photos.join(", ")) + ": " + u.photoLink : u.photos.map(function (p) { return "[" + w.photo + ": " + p + "]"; }).join(" "));
    if (u.stars) out.push(u.card && u.card.link ? w.stars : w.starsReply);
    if (u.buttons) out.push(dot(w.reply + " " + u.buttons.map(function (b, i) { return bKey(b, i, u.letters) + " " + bLab(b); }).join(", ")));
    if (u.stop) out.push(stopLine(u, t));
    return out.join("\n");
  }

  /* the label a short reply stands for: "1" after buttons ["Accept", ...] is "Accept" */
  function pickLabel(u, reply) {
    if (!u) return null;
    var r = String(reply).trim(), mN = /^([1-9])$/.exec(r), mL = /^([A-Ja-j])$/.exec(r);
    if (u.buttons) { for (var bi = 0; bi < u.buttons.length; bi++) if (bKey(u.buttons[bi], bi, u.letters).toUpperCase() === r.toUpperCase()) return bLab(u.buttons[bi]); }
    if (mN && u.list && u.list.numbers) return (u.list.rows[+mN[1] - 1] || []).join(" · ") || null;
    if (mL) {
      var i = mL[1].toUpperCase().charCodeAt(0) - 65;
      if (u.times && u.times[i]) return u.times[i];
      if (u.buttons && u.letters && u.buttons[i]) return u.buttons[i];
      if (u.list && !u.list.numbers && u.list.rows[i]) return u.list.rows[i].join(" · ");
    }
    return null;
  }

  /* shape problems, for check.js */
  function uiProblems(u) {
    var p = [];
    if (!u || typeof u !== "object" || Array.isArray(u)) return ["the 4th part of a message must be an object"];
    Object.keys(u).forEach(function (k) { if (KEYS.indexOf(k) < 0) p.push("unknown message element '" + k + "'"); });
    var strs = function (k, x) { if (!Array.isArray(x) || !x.length || x.some(function (y) { return typeof y !== "string" || !y; })) p.push("'" + k + "' must be a list of words"); };
    if (u.buttons) {
      if (!Array.isArray(u.buttons) || !u.buttons.length || u.buttons.some(function (b) { return Array.isArray(b) ? b.length !== 2 || !b[1] || !/^[1-9A-J]$/.test(String(b[0])) : typeof b !== "string" || !b; })) p.push("'buttons' must be labels, or [key, label] with a key 1-9 or A-J");
      if (u.buttons.length > 5) p.push("more than 5 buttons");
      u.buttons.forEach(function (b) { if (String(bLab(b)).length > 24) p.push("button '" + bLab(b) + "' is over 24 characters"); });
      /* a chat app may send a button's words: a button that is only an opt-out word would stop texts instead (say "Cancel visit") */
      u.buttons.forEach(function (b) { if (OPTOUT.indexOf(String(bLab(b)).trim().toUpperCase()) >= 0) p.push("button '" + bLab(b) + "' is an opt-out word; say what it does, like 'Cancel visit'"); });
    }
    if (u.times) { strs("times", u.times); if (u.times.length > 6) p.push("more than 6 times"); }
    if (u.photos) strs("photos", u.photos);
    if (u.form) strs("form", u.form);
    if (u.card && (!u.card.title || (u.card.lines && !Array.isArray(u.card.lines)))) p.push("a card needs a title, and lines as a list");
    if (u.card && u.card.button && String(u.card.button).length > 24) p.push("card button '" + u.card.button + "' is over 24 characters");
    if (u.pay && !u.pay.amount) p.push("a pay card needs an amount");
    if (u.list && (!Array.isArray(u.list.rows) || !u.list.rows.length || u.list.rows.some(function (r) { return !Array.isArray(r); }))) p.push("a list needs rows, each a list");
    if (u.list && u.list.rows && u.list.rows.length > 10) p.push("a list has more than 10 rows");
    if (u.code && !/^\d{4}$/.test(String(u.code))) p.push("a check-in code is 4 digits");
    if (u.stop !== undefined && u.stop !== true && u.stop !== "first") p.push("'stop' must be true (always) or \"first\" (only on the first text a number gets)");
    if (u.as !== undefined && (typeof u.as !== "string" || !u.as)) p.push("'as' must be a name");
    if (u.en !== undefined && (typeof u.en !== "string" || !u.en)) p.push("'en' must be the English words");
    if (u.en && !u.lang) p.push("'en' goes with a message in another language (lang)");
    if (u.photoLink && !u.photos) p.push("'photoLink' goes with photos");
    return p;
  }
  /* does the message carry a chat element, beyond who it's for and its language? */
  function hasElement(u) { return !!u && Object.keys(u).some(function (k) { return k !== "as" && k !== "lang" && k !== "en"; }); }

  var api = { smsText: smsText, stopLine: stopLine, pickLabel: pickLabel, uiProblems: uiProblems, words: words, hasElement: hasElement, bKey: bKey, bLab: bLab, KEYS: KEYS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MSG = api;
})(this);
