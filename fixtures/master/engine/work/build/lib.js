/* Shared rules for the two master flows (Oct 22, 2026). Used by check-part.js, build-master.js and check-master.js.
   - LINES: the 196 lines of design/LINES.md, by section.
   - The money model: three choices a service makes (price, money before, money after), the valid combinations,
     `when` on a branch (lit only for some choices) and `vary` on a step (other words for some choices).
   - The step schema and limits (design/PLAIN-WORDS.md), the plain-words score (reference-renderer/readable.js),
     and the per-combination walk: order (a step only needs what earlier steps gave) and a complete path.
   - Phase 3 (Oct 25): vary keys and plug-in switches come from the overlay core (overlay-core.js, shared with the
     page); a vary may carry form and table; switchTies() tries every switch setting; the free combination (nothing
     before, nothing after) is valid, but combos() leaves it out until the master covers it (freeCombos(),
     freeWordGaps() report it for the editors).
   - Tools C (Oct 25): the booking group privacy (open | private) is walked together with every reach value in pathsFor
     (calls only AND private), a value another implies (notsafe is always private; calls only is always taken
     "nothing") taken out; a group the allowed list leaves out has every value. stampFlow() stamps header.json's "took"
     (money words by what the booking took: STATE.md T1) and "layerLines" (lines no key removes: T2) on a flow's steps;
     headerLayerProblems() checks them; checkShape accepts the stamps.
   - Part B (Oct 25): booking keys are layer keys like switch keys (layerTies() tries every switch setting and every
     mix of the booking values a step's keys name); a variant may carry swap, addMore and addSay; a step's own `when`
     may also name money and booking choices (the step dims on other paths); relative times and auto-fill slots are
     checked (flowTimeProblems(), slot problems in checkShape); filled() gives the words with the slots filled;
     pathsFor() walks every mix of the booking groups a flow reads (up to MIX_CAP paths per money path).
   - Tools H (Oct 26; SIMPLIFY-PLAN TL-1, TL-2; D66, D67): the money ways. header.json "ways" ({ "before": [...],
     "restLater": false }; build-master writes it into each flow as money.ways; CORE.ways() is the one being read):
     validCombo() and combos() keep only the money-before ways it lists (no hold) and, with restLater false, no deposit
     with nothing after (28 money paths a flow on the D66 master); dimsFor() gives the money dims with those ways.
     waysProblems() (check-part, build-master): a vary key, a branch `when` or a step `when` that names a way the header
     leaves out (D66 #3: no hold) or fits only a removed path (D66 #7: no rest charged later), an "after:none" key that
     never fits where its step is lit (it only follows a deposit there), a {{hold}} slot: errors. waysHeaderProblems():
     an amounts row or example for a removed path, a malformed ways block. notsafeProblems(): reach notsafe ("stopped for
     safety") named outside a branch's sets scope (the reach card offering it, a key or `when` before the change): an
     error (D66 #6). No ways in the header: none of this runs, and every walk and check reads exactly as before.
   - Tools I (Oct 26; FIX7-PLAN TF-1; D75, D77): header.json "d75": true (CORE.d75(); build-master writes it into each flow
     as "d75": true): no not-safe mode. d75Problems() (check-part, build-master): any vary key naming booking notsafe, any
     `when.booking` (a step's, a branch's, a branch's whenIn) naming it, and any branch `sets: { reach: "notsafe" }`,
     anywhere in the flow (before or after a change): errors, "D75: no not-safe mode; use the change of where updates go
     (A7-98 / B7-88)"; notsafeProblems() (D66 #6) gives way to it. d75HeaderProblems(): a malformed "d75", and with it on
     a layer line whose `when` names notsafe or whose way has a notsafe entry (H7-1, H7-2). d75OverlayPlaces(): where a
     profession's overlay names notsafe (check-prof lists them, phase 4 rewords them). Without "d75": none of this runs.
   - Tools I, part 2 (Oct 26; FIX7-PLAN TF-4, TF-5; D73): severalPath(fl, combos) reads several services in one booking
     as ONE money path of the flow (D73: one payment of what's due now): before = full if every service is full, deposit
     if something is due now and something is left, card if nothing is due now and a service needs a card, else none;
     after = the services' shared after-way (a full-price service's "none" set aside), counter (A) or bill (B) when they
     differ; price = visit if any is priced at the visit, else photos if any is photo-quoted, else list. A free service
     (nothing before, nothing after) adds nothing unless all are free; a service paid by a credit ("credit") is left out:
     the paid part's path. switchWalkPaths(): the paths again with each header switch a `when` names turned on (the
     read-later switch), so check-part and build-master walk both of its branches.
   - Tools J, E1 (Oct 26; REDESIGN 2, work/phase3/redesign2/TOOL-SPEC.md 3, 8.2): THE BOOKING RECORD's walk. With a record
     table loaded for a flow (CORE.useRecord; header.json "record": true plus work/master/src/record.json), pathsFor()
     appends one path per record.json fixture that rides each money path given (fixturePaths(): a fixture's services
     added and read as the D73 path, its booking values laid on through CORE.withSets), after today's paths, deduped;
     opts.record === false leaves them out, opts.fl names the flow (else the first A or B step id). pathKey() names a
     fixture path "<money path it rode> +<fixture id>" (pathName() is the same name); parsePath() reads one back
     ("list|card|bill +switched booking=reach:callsonly pf=grief facts=packs"). stampFlow() stamps "ev" (from record.json
     "from" on: the event groups charge and contact are read there) and "rec" (a step whose words hold a record slot or a
     ledger amount; with the flow's amount table); recordProblems() checks record.json; recordSlotProblems() reports a
     record slot no row fits on a walked path (and dead rows); checkShape accepts the stamps, rec / recOff facts in a
     `when` and a branch's sets svcAdd. No record loaded: every walk, name and check exactly as before.
   - Tools J, E2 (Oct 26; REDESIGN 2, TOOL-SPEC 2.4, 4, 5): with header.json "record": true and work/master/src/record.json
     (recordOn): castStep() resolves the cast slots ({{biz}}, {{pro}}, {{place}}, {{cust}}, {{owner}}: header flows.<flow>
     .names) and {{ab:A words|B words}} for the flow being built; mergeShared(parts, fl) copies a part's "shared" texts
     into the steps that name them ("text": "<name>"; labels and endTexts onto the branches; addMore lines after the
     shared ones, each a named twin difference) and gives the L5 hits (a step setting a word its text sets: twin drift);
     sharedUseProblems() (a text no step uses, or two steps of one flow use: errors; one flow only: a warning);
     lintSteps(steps, fl, record, opts) the lint L1-L4 (record variants, record phrases outside a slot, pointer lines,
     a home node's line restated) and L6 (a name the cut list took out: record.json "live"), lintSort() its allow list; readsOf(step) what a step follows ("reads": money,
     contact, clock, who, stop), stamped by build-master; recordLintProblems() and recordHeaderProblems() check
     record.json's homes and lint blocks and the header's "record". Without "record" none of this runs. */
"use strict";
const fs = require("fs"), path = require("path");
const HERE = path.resolve(__dirname, "../..");
const MSG = require("./msgtext");
const CORE = require("./overlay-core"); /* the overlay core: vary keys, plug-in switches, applying an overlay (shared with the page) */

/* ---------------------------------------------------------------- the 196 lines */
function parseLines() {
  const md = fs.readFileSync(path.join(HERE, "design/LINES.md"), "utf8").split("\n");
  const sections = [], lines = [];
  let sec = null;
  for (const l of md) {
    let m = /^## (\d+)\. (.+?)(?: · NEW)?$/.exec(l);
    if (m) { sec = { n: +m[1], name: m[2].trim() }; sections.push(sec); continue; }
    m = /^(\d+)\.(\d+) (.+?) · (.+)$/.exec(l);
    if (m && sec) lines.push({ id: m[1] + "." + m[2], sec: +m[1], name: m[3].trim(), tags: m[4].trim() });
  }
  return { sections, lines, byId: Object.fromEntries(lines.map((x) => [x.id, x])) };
}
const LINES = parseLines();

/* ---------------------------------------------------------------- the money model */
const DIMS = {
  price: [
    { k: "list", label: "From the price list" },
    { k: "photos", label: "Quoted from photos first" },
    { k: "visit", label: "Quoted at the visit" }
  ],
  before: [
    { k: "none", label: "Nothing taken" },
    { k: "card", label: "Card saved" },
    { k: "hold", label: "A hold" },
    { k: "deposit", label: "A deposit" },
    { k: "full", label: "Full price" }
  ],
  after: [
    { k: "none", label: "Nothing more" },
    { k: "counter", label: "At the counter" },
    { k: "bill", label: "Rosie texts the bill" },
    { k: "card", label: "Saved card charged" },
    { k: "own", label: "Business's own way" }
  ]
};
/* which "money after" choices each flow has: at the business people pay at the counter; at the customer's place
   there's no counter, so the business picks the bill, the saved card or its own way */
const AFTER_IN = { A: ["none", "counter", "bill", "card"], B: ["none", "bill", "card", "own"] };
/* the rules that make a combination possible (FOUR-WAYS.md sections 2 and 3). Tools H: ways (a header "ways" block, or
   CORE.ways(), the master being read, when not given; null: before D66) keeps only the money-before ways it lists and,
   with restLater false, no deposit with nothing after (D66 #3, #7) */
function validCombo(flow, c, ways) {
  if (!AFTER_IN[flow].includes(c.after)) return false;
  if (c.before === "full" && c.after !== "none") return false;            /* paid in full: nothing more */
  if (c.after === "none" && !["full", "deposit", "none"].includes(c.before)) return false; /* deposit + nothing more = the rest on a set day; nothing + nothing = free */
  if (c.after === "card" && !["card", "hold", "deposit"].includes(c.before)) return false; /* needs a saved card */
  if (c.price === "visit" && !["none", "card", "hold", "deposit"].includes(c.before)) return false;  /* no full prepay on an unknown price; a deposit up to the starting price is fine (G26) */
  if (c.price === "visit" && c.after === "none") return false;  /* the final price comes at the visit, so something is due after */
  const W = ways === undefined ? CORE.ways() : CORE.normWays(ways);
  if (W && !W.before.includes(c.before)) return false;                     /* tools H: a way the header leaves out (D66 #3: no hold) */
  if (W && !W.restLater && c.after === "none" && !["full", "none"].includes(c.before)) return false; /* tools H: no rest charged later (D66 #7) */
  return true;
}
/* tools H: the ways a header or a flow names ({ before, restLater } as written), or null */
const waysOf = (x) => (!x || typeof x !== "object" ? null : x.money && typeof x.money === "object" ? x.money.ways || null : x.ways || null);
/* tools H: the money dims with the ways given (the header's: build-master writes them into each flow); no ways: DIMS */
function dimsFor(ways) {
  const W = CORE.normWays(ways);
  if (!W) return DIMS;
  return Object.assign({}, DIMS, { before: DIMS.before.filter((x) => W.before.includes(x.k)) });
}
/* the free combination (M-104): nothing before, nothing after (a free consult, tour, trial or $0 touch-up). It is a
   valid choice, but the master covers it only once its parts say so (a part file's "free": true; build-master then
   writes it into master-A/B.json money.combos). Until then the checkers walk it apart and report it as "not yet
   covered", and combos() leaves it out. */
const isFree = (c) => c.before === "none" && c.after === "none";
/* Tools F (T5, DECISIONS D7): the money paths a no-money business (switch nomoney) can have: nothing before, and after
   either nothing (free) or the business's own way (flow A: at the counter; flow B: its own way). Holds, saved cards,
   deposits, the full price, Rosfield's bill and a card charged at DONE all need money through Rosie. */
const NOMONEY_AFTER = { A: "counter", B: "own" };
const nomoneyOk = (flow, c) => c.before === "none" && (c.after === "none" || c.after === NOMONEY_AFTER[flow]);
function combos(flow, opts) {
  const out = [], W = opts && opts.ways !== undefined ? opts.ways : CORE.ways(); /* (tools H: the ways; null: every way) */
  for (const p of DIMS.price) for (const b of DIMS.before) for (const a of DIMS.after) {
    const c = { price: p.k, before: b.k, after: a.k };
    if (validCombo(flow, c, W) && (!isFree(c) || (opts && opts.free))) out.push(c);
  }
  return out;
}
/* the free combinations of a flow: list|none|none and photos|none|none */
const freeCombos = (flow) => combos(flow, { free: true }).filter(isFree);
const comboKey = (c) => c.price + "|" + c.before + "|" + c.after;
/* `when` on a branch: { price: [...], before: [...], after: [...] }; a missing dimension means any.
   `vary` keys: "before:hold", "after:bill", "price:visit", "pf:private" (a plug-in switch), joined with "+"; the most
   specific key that fits wins. These live in the overlay core (work/build/overlay-core.js), shared with the page. */
const lit = CORE.lit, parseVaryKey = CORE.parseVaryKey, resolveVary = CORE.resolveVary, keySpec = CORE.keySpec, keyFits = CORE.keyFits;
/* a path's name in messages: the money key, plus its booking choices and plug-in facts when it has them (so a plain
   money path reads exactly as before) */
function pathKey(c) {
  const b = Object.keys(CORE.BOOKING).filter((g) => c.booking && c.booking[g] && c.booking[g] !== CORE.BOOKING[g].values[0][0]).map((g) => c.booking[g]);
  const sw = Object.keys(c.pf || {}).filter((n) => c.pf[n] === true);
  return (c.fix ? (c.base || comboKey(c)) + " +" + c.fix : comboKey(c)) + (b.length ? " with booking " + b.join(" + ") : "") + (sw.length && c.pfLabel !== false ? " with the switch" + (sw.length > 1 ? "es " : " ") + sw.join(" + ") + " on" : "") +
    (c.facts ? (c.facts.length === 0 ? " with every plug-in fact off" : c.allFacts ? " with every plug-in fact on" : " with its plug-in facts") : "") +
    /* Tools G: a path changed mid-booking by a branch's "sets" names the branch (and what it kept: a pinned value) */
    (c.setBy && c.setBy.length ? " after " + c.setBy.join(" then ") + (c.pin ? " (kept: " + Object.keys(c.pin).map((g) => g + " " + c.pin[g]).join(", ") + ")" : "") : "");
}
/* the booking groups (timing, times, reach) a flow's branches and vary keys read */
function bookingGroupsUsed(steps) {
  const gs = new Set();
  eachStep(steps, (s) => {
    Object.keys(s.vary || {}).forEach((k) => { const cd = parseVaryKey(k); if (cd && cd.booking) CORE.bookingGroups(cd.booking).forEach((g) => gs.add(g)); });
    (s.branches || []).forEach((b) => [b.when].concat(Object.values(b.whenIn || {})).forEach((w) => { if (w && w.booking) CORE.bookingGroups(w.booking).forEach((g) => gs.add(g)); }));
    if (s.when && s.when.booking) CORE.bookingGroups(s.when.booking).forEach((g) => gs.add(g));
  });
  return [...gs];
}
/* the plug-in gates the steps use: { facts: true when any step or branch gates on a fact, switches: [names] } */
function gatesUsed(steps) {
  const out = { facts: false, switches: [] };
  const see = (w) => { if (!w) return; ["pf", "factOn", "factOff"].forEach((d) => { if (w[d]) out.facts = true; }); ["switchOn", "switchOff"].forEach((d) => (w[d] || []).forEach((n) => { if (!out.switches.includes(n)) out.switches.push(n); })); };
  eachStep(steps, (s) => { see(s.when); (s.branches || []).forEach((b) => [b.when].concat(Object.values(b.whenIn || {})).forEach(see)); });
  return out;
}
const factsUsed = (steps) => gatesUsed(steps).facts;
/* a `when`'s booking choices and plug-in gates in words (for the read files) */
function gateText(w) {
  const bl = (v) => (CORE.bookingLabel ? CORE.bookingLabel(v) : v);
  return [w.booking ? "booking: " + w.booking.map(bl).join(" or ") : "", (w.pf || w.factOn) ? "plug-in facts: " + [].concat(w.pf || [], w.factOn || []).join(" or ") : "",
    w.factOff ? "not for work with " + w.factOff.join(" or ") : "", w.switchOn ? "switch on: " + w.switchOn.join(" or ") : "", w.switchOff ? "not with the switch " + w.switchOff.join(" or ") : ""].filter(Boolean);
}
/* a step's own `when` in words (its money and booking choices, then its plug-in gates) */
function stepWhenText(w) {
  const lab = (d, k) => (DIMS[d].find((x) => x.k === k) || {}).label || k;
  return ["price", "before", "after"].filter((d) => w[d]).map((d) => d + ": " + w[d].map((v) => lab(d, v)).join(" or ")).concat(gateText(w));
}
/* the paths the checkers walk for some money combinations: each as it is (booking defaults, no switch on, every
   fact-gated branch shown); then each other value of every booking group the steps read (the others at their
   defaults); then, for the plug-in gates the steps use, each switch they name turned on alone and all of them on
   together, and every fact off and every fact on. allowed = { group: [values] } limits the booking values;
   fixed = true keeps the given switches and facts (a profession's own). */
/* Part B (item 7): every MIX of the booking groups the steps read is walked (timing x times x reach x paidby), as long
   as the mixes per money path stay at or under MIX_CAP; past it, each group's values are walked with the others at their
   defaults (as before) and the line "booking mixes: one group at a time" is printed once by the checker. */
const MIX_CAP = 64;
function bookingMixes(groups, allowed, read) {
  /* (Tools C: a group the allowed list leaves out has every value; bookingOf lists every group but privacy)
     (Tools F: a late value, times line, only where `read`, the values the steps name, has it) */
  const vals = groups.map((g) => { const all = CORE.groupValues(g, read), ok = all.filter((v) => !allowed || !allowed[g] || allowed[g].includes(v)); return ok.length ? ok : [all[0]]; });
  const n = vals.reduce((a, v) => a * v.length, 1);
  if (n > MIX_CAP) return null;
  let mixes = [{}];
  groups.forEach((g, i) => { const next = []; mixes.forEach((m) => vals[i].forEach((v) => next.push(Object.assign({}, m, { [g]: v })))); mixes = next; });
  return mixes;
}
/* a path that mixes two or more booking choices away from their first values (pathsFor's every-mix walk) */
const isMix = (c) => !!c.booking && Object.keys(c.booking).filter((g) => CORE.BOOKING[g] && c.booking[g] !== CORE.BOOKING[g].values[0][0]).length > 1;
/* a problem with its path's name taken out: a mix that only repeats a problem already found on a simpler path adds
   no line (the same tie on the same step is one problem, however many booking mixes meet it) */
const problemKey = (e) => String(e).replace(/ with booking [a-z]+(?: \+ [a-z]+)*/g, "");
function addProblems(list, errs, c, seen) {
  errs.forEach((e) => { if (list.includes(e)) return; const k = problemKey(e); if (isMix(c) && seen.has(k)) return; seen.add(k); list.push(e); });
}
function pathsFor(cs, steps, allowed, fixed, opts) {
  const out = [], groups = bookingGroupsUsed(steps), gates = fixed ? { facts: false, switches: [] } : gatesUsed(steps);
  /* Tools F (T4): the booking values the steps name; a late value (times line) is walked only where they name it */
  const read = CORE.valuesRead(steps), gv = (g) => CORE.groupValues(g, read);
  /* opts.mix === false: each booking group alone (the scans: a mix changes no clock and no money word they read) */
  const allFacts = Object.keys(CORE.FACTS), mixes = groups.length > 1 && !(opts && opts.mix === false) ? bookingMixes(groups, allowed, read) : null;
  if (groups.length > 1 && !mixes && !(opts && opts.mix === false)) pathsFor.capped = true;
  /* a group the profession doesn't use with its first value (it trimmed that branch, or listed other values): its
     paths start from the first value it does use */
  const firstOf = {};
  if (allowed) groups.forEach((g) => { const d = CORE.BOOKING[g].values[0][0]; if (allowed[g] && allowed[g].length && !allowed[g].includes(d)) firstOf[g] = allowed[g][0]; });
  if (Object.keys(firstOf).length) cs = cs.map((c) => Object.assign({}, c, { booking: Object.assign({}, firstOf, c.booking || {}) }));
  cs.forEach((c) => {
    out.push(c);
    /* each other value of each group alone (as before), then, with mixes, every mix of two or more groups */
    const dflt = (g) => firstOf[g] || CORE.BOOKING[g].values[0][0];
    const n0 = out.length;
    groups.forEach((g) => gv(g).filter((v, i) => (firstOf[g] ? v !== firstOf[g] : i > 0) && (!allowed || !allowed[g] || allowed[g].includes(v))).forEach((v) => out.push(Object.assign({}, c, { booking: Object.assign({}, c.booking || {}, { [g]: v }) }))));
    if (mixes) mixes.filter((m) => groups.filter((g) => m[g] !== dflt(g)).length > 1).forEach((m) => out.push(Object.assign({}, c, { booking: Object.assign({}, c.booking || {}, m) })));
    /* Tools C: privacy is walked with every way of reaching the person (calls only AND private: break-4 CU3), even when
       the groups are walked one at a time; a choice another implies (notsafe is always private) is taken out, and a path
       that reads the same as one before it is dropped. Only for steps that read privacy: other flows walk as before. */
    if (groups.some((g) => CORE.IMPLIED && CORE.IMPLIED[g]) || (CORE.ways && CORE.ways() && groups.includes("privacy") && groups.includes("reach"))) { /* (tools H: with the D66 ways nothing implies privacy, and it is still walked with every reach) */
      if (groups.includes("privacy") && !mixes && groups.includes("reach")) {
        const okv = (g) => gv(g).filter((v) => !allowed || !allowed[g] || allowed[g].includes(v));
        okv("reach").forEach((r) => okv("privacy").filter((p) => p !== dflt("privacy")).forEach((p) => out.push(Object.assign({}, c, { booking: Object.assign({}, c.booking || {}, { reach: r, privacy: p }) }))));
      }
      const bkey = (b) => JSON.stringify(Object.keys(b || {}).filter((g) => CORE.BOOKING[g] && b[g] !== CORE.BOOKING[g].values[0][0]).sort().map((g) => [g, b[g]]));
      /* (the paths after n0 are c's booking paths: same switches and facts as c) */
      const seen = new Set([bkey(CORE.bookingCanon(c.booking))]), keep = out.slice(n0).filter((x) => { x.booking = CORE.bookingCanon(x.booking); const k = bkey(x.booking); if (seen.has(k)) return false; seen.add(k); return true; });
      out.length = n0; keep.forEach((x) => out.push(x));
    }
    const sw = gates.switches.filter((n) => !(c.pf && c.pf[n]));
    sw.forEach((n) => out.push(Object.assign({}, c, { pf: Object.assign({}, c.pf || {}, { [n]: true }) })));
    if (sw.length > 1) out.push(Object.assign({}, c, { pf: Object.assign({}, c.pf || {}, Object.fromEntries(sw.map((n) => [n, true]))) }));
    if (gates.facts && !c.facts) { out.push(Object.assign({}, c, { facts: [] })); out.push(Object.assign({}, c, { facts: allFacts, allFacts: true })); }
  });
  /* Tools J (E1; TOOL-SPEC 3.2): with a record table loaded for the flow, one path per fixture that rides each money
     path given, after the paths above (deduped); opts.record === false leaves them out; opts.fl names the flow */
  if (!(opts && opts.record === false) && CORE.recordOn && CORE.recordOn()) {
    const fl = (opts && opts.fl) || flowOfSteps(steps), R = fl ? CORE.record(fl) : null;
    if (R && Array.isArray(R.fixtures) && R.fixtures.length) {
      const seen = new Set();
      cs.forEach((c) => fixturePaths(c, fl, R.fixtures, allowed).forEach((x) => { const k = fixSig(x); if (seen.has(k)) return; seen.add(k); out.push(x); }));
    }
  }
  return out;
}
/* ---------------------------------------------------------------- tools J, E1: the record's fixtures (TOOL-SPEC 3) */
/* the flow some steps belong to: the first A or B step id (S steps alone: null) */
function flowOfSteps(steps) {
  let f = null;
  const go = (ss) => { for (const s of ss || []) { if (f) return; const m = /^([AB])\d/.exec((s && s.id) || ""); if (m) { f = m[1]; return; } (s.branches || []).forEach((b) => go(b.steps)); } };
  go(steps);
  return f;
}
/* one fixture path, as pathsFor dedupes them: the fixture, the money path it rode and reads, its reading, switches, facts */
const fixSig = (x) => [x.fix, x.base, comboKey(x), CORE.pathSig(x), JSON.stringify(x.pf || null), JSON.stringify(x.facts || null), x.allFacts ? 1 : 0].join("~");
/* does a fixture ride money path c? on: "all" (default), "paid-or-card" (c takes a card, a deposit or the full price), or
   a list of money keys */
function ridesOn(on, c) {
  if (on === undefined || on === null || on === "all") return true;
  if (on === "paid-or-card") return ["card", "hold", "deposit", "full"].includes(c.before);
  if (Array.isArray(on)) return on.includes(comboKey(c));
  return false;
}
/* a service of the flow's record (record.json services, a profession's merged in by apply), with its id */
function recordService(R, id) { const s = R && R.services && typeof R.services === "object" ? R.services[id] : null; return s && typeof s === "object" ? Object.assign({ id }, s) : null; }
/* fixturePaths(c, fl, fixtures, allowed) -> the paths the fixtures make from money path c (TOOL-SPEC 3.1): each named
   c.fix (c.base = the money path it rode); "add" services join c's own (c.svc) and the money path becomes their D73 path
   (severalPath; a fixture whose services read as no path of the flow makes none: recordProblems reports it); "booking"
   values are laid on through CORE.withSets (so taken and implied values behave as for a branch's sets); "flows", "on",
   "facts" and "switches" pick the paths it rides (the master, with no facts list, walks every one; a switch-gated
   fixture turns its switches on for the master, and rides only a profession that has one on). allowed (a profession's
   booking values) leaves out a fixture naming a value it doesn't use. */
function fixturePaths(c, fl, fixtures, allowed) {
  const R = CORE.record(fl) || {}, list = fixtures || R.fixtures || [], out = [];
  if (!c || !c.before) return out;
  list.forEach((fx) => {
    if (!fx || typeof fx !== "object" || !fx.id) return;
    if (Array.isArray(fx.flows) && !fx.flows.includes(fl)) return;
    if (!ridesOn(fx.on, c)) return;
    if (Array.isArray(fx.facts) && fx.facts.length && Array.isArray(c.facts) && !fx.facts.some((f) => c.facts.includes(f))) return;
    let p = Object.assign({}, c, { fix: fx.id, base: comboKey(c) });
    if (Array.isArray(fx.switches) && fx.switches.length) {
      if (c.pf && typeof c.pf === "object") { if (!fx.switches.some((n) => c.pf[n] === true)) return; }
      else p.pf = Object.fromEntries(fx.switches.map((n) => [n, true]));
    }
    const asked = Array.isArray(fx.add) ? fx.add : [], add = asked.map((id) => recordService(R, id)).filter((s) => s && (s.flow === undefined || s.flow === fl));
    if (asked.length && !add.length) return;
    if (add.length) {
      const later = !!(fx.booking && (fx.booking.charge === "later" || fx.booking.charge === "failed"));
      const svcs = [{ id: "own", own: true, price: c.price, before: c.before, after: c.after }].concat(add.map((s) => (later ? Object.assign({}, s, { later: true }) : s)));
      const ownCredit = CORE.bookingValue(c, "paidby") === "credit";
      /* D91 (tools J E3 fix 6): a service added after booking takes nothing up front: it joins as a rest (overlay-core
         laterWay), so the path stays the booking's own */
      const sp = severalPath(fl, svcs.map((s) => ((s.own ? ownCredit : s.paidby === "credit") ? "credit" : s.later && CORE.laterWay ? CORE.laterWay(s, svcs, fl) : { price: s.price, before: s.before, after: s.after })));
      if (!sp.path) return;
      p = Object.assign(p, sp.path, { svc: svcs });
    }
    if (fx.booking && typeof fx.booking === "object" && Object.keys(fx.booking).length) {
      if (allowed && Object.keys(fx.booking).some((g) => Array.isArray(allowed[g]) && !allowed[g].includes(fx.booking[g]))) return;
      p = CORE.withSets(p, fx.booking);
      delete p.evSet; /* (a fixture seeds its events: read only from record.json "from" on, TOOL-SPEC change 16) */
    }
    out.push(p);
  });
  return out;
}
/* a path's name in every error and flag line (pathKey: "list|deposit|counter +two-card with booking later") */
const pathName = (c) => pathKey(c);
/* parsePath("list|card|bill +switched booking=reach:callsonly,privacy:private pf=grief facts=packs", "B") -> a path, or
   { problems }. "+two-card" alone rides the flow's main path (record.json "main"). */
function parsePath(text, fl) {
  const problems = [], parts = String(text || "").trim().split(/\s+/).filter(Boolean);
  /* (TOOL-SPEC change 12: "A list|deposit|counter +two-card" names its flow first; the path then carries it as p.fl) */
  if (parts.length && /^[AB]$/.test(parts[0])) { const f = parts.shift(); if (fl && fl !== f) return { problems: ["the path names flow " + f + ", but flow " + fl + " was asked"] }; fl = f; }
  const done = (c) => { if (c && !c.problems) Object.defineProperty(c, "fl", { value: fl, enumerable: false, configurable: true, writable: true }); return c; };
  let money = null, fix = null, booking = null, pf = null, facts = null;
  parts.forEach((x) => {
    if (/^[a-z]+\|[a-z]+\|[a-z]+$/.test(x)) { if (money) problems.push("two money paths ('" + money + "', '" + x + "')"); money = x; }
    else if (/^\+[a-z0-9][a-z0-9-]*$/.test(x)) { if (fix) problems.push("two fixtures ('+" + fix + "', '" + x + "')"); fix = x.slice(1); }
    else if (/^booking=/.test(x)) { booking = booking || {}; x.slice(8).split(",").filter(Boolean).forEach((kv) => { const [g, v] = kv.split(":"); if (!CORE.BOOKING[g]) problems.push("booking=" + kv + ": no booking group '" + g + "' (" + Object.keys(CORE.BOOKING).join(", ") + ")"); else if (CORE.GROUP_OF[v] !== g) problems.push("booking=" + kv + ": " + g + " is one of " + CORE.allValues(g).map((y) => y[0]).join(", ")); else booking[g] = v; }); }
    else if (/^pf=/.test(x)) { pf = pf || {}; x.slice(3).split(",").filter(Boolean).forEach((n) => { if (!CORE.NAME.test(n)) problems.push("pf=" + n + ": a switch name is lowercase letters and digits"); else pf[n] = true; }); }
    else if (/^facts=/.test(x)) { facts = x.slice(6).split(",").filter(Boolean); facts.forEach((f) => { if (!CORE.FACTS[f]) problems.push("facts=" + f + ": no plug-in fact '" + f + "'"); }); }
    else problems.push("can't read '" + x + "' (like: list|card|counter +two-card booking=reach:callsonly,privacy:private pf=grief facts=packs)");
  });
  if (!["A", "B"].includes(fl)) problems.push("the flow must be A or B");
  if (!money && !fix) problems.push("give a money path like list|card|counter, or +<fixture id>");
  const R = CORE.record(fl);
  if (!money) money = R && R.main ? (typeof R.main === "string" ? R.main : R.main[fl]) : null;
  if (!money) { problems.push("no money path given and no record.json main for flow " + fl); return { problems }; }
  const m = money.split("|"), c = { price: m[0], before: m[1], after: m[2] };
  if (["A", "B"].includes(fl) && !validCombo(fl, c)) problems.push("'" + money + "' isn't a money path of flow " + fl);
  if (booking && Object.keys(booking).length) c.booking = booking;
  if (pf) c.pf = pf;
  if (facts) c.facts = facts;
  if (problems.length) return { problems };
  if (!fix) return done(c);
  const fx = R && Array.isArray(R.fixtures) ? R.fixtures.find((x) => x && x.id === fix) : null;
  if (!fx) return { problems: ["no fixture '" + fix + "' in flow " + fl + "'s record" + (R && Array.isArray(R.fixtures) ? " (fixtures: " + R.fixtures.map((x) => x && x.id).join(", ") + ")" : " (no record table loaded)")] };
  const ps = fixturePaths(c, fl, [fx]);
  if (!ps.length) return { problems: ["the fixture '" + fix + "' doesn't ride " + money + " in flow " + fl + " (on: " + JSON.stringify(fx.on || "all") + (fx.flows ? ", flows: " + fx.flows.join(", ") : "") + (fx.add ? ", or its services read as no path of the flow" : "") + ")"] };
  return done(ps[0]);
}
/* record.json from a src folder (null when there is none) */
function loadRecord(src) {
  const f = path.join(src || path.join(HERE, "work/master/src"), "record.json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
}
/* a step with layer keys (plug-in switches, booking choices): every switch setting and every mix of the booking values
   its keys name, on every path given; a tie there is an error (walkCombo checks only the path's own setting). Returns
   the problems as text. (Kept as switchTies too: the old name.) */
function layerTies(s, cs, where) {
  const names = [], groups = [];
  Object.keys(s.vary || {}).forEach((k) => { CORE.keySwitches(k).forEach((n) => { if (!names.includes(n)) names.push(n); }); CORE.bookingGroups(CORE.keyBookings(k)).forEach((g) => { if (!groups.includes(g)) groups.push(g); }); });
  if (!names.length && !groups.length) return [];
  /* (Tools F: a late value is tried where the step's own keys name it) */
  const named = {}; Object.keys(s.vary || {}).forEach((k) => CORE.keyBookings(k).forEach((v) => { named[v] = true; }));
  let mixes = [null];
  groups.forEach((g) => { const next = []; mixes.forEach((m) => CORE.groupValues(g, named).forEach((v) => next.push(Object.assign({}, m || {}, { [g]: v })))); mixes = next; });
  const out = [], tieMsg = (v) => v.tie.join(", ") + "): add a joined key, like " + v.tie[0] + "+" + v.tie[1].split("+").filter((p) => !v.tie[0].split("+").includes(p)).join("+");
  for (let m = groups.length ? 0 : 1; m < (1 << Math.min(names.length, 10)); m++) {
    const pf = {}; names.forEach((n, i) => { if (m & (1 << i)) pf[n] = true; });
    for (const bm of mixes) {
      if (!m && bm && groups.every((g) => bm[g] === CORE.BOOKING[g].values[0][0])) continue; /* the plain path: walkCombo's */
      for (const c of cs) {
        if (c.pf && Object.keys(c.pf).length) continue; /* the switch settings are tried here, from the plain paths */
        const c2 = Object.assign({}, c, { pf }, bm ? { booking: CORE.bookingCanon(Object.assign({}, c.booking || {}, bm)) } : {}); /* (Tools C: a value another implies taken out) */
        const v = resolveVary(s, c2);
        if (v.tie) {
          const on = Object.keys(pf);
          out.push((where || "") + s.id + ": two variants fit " + pathKey(bm ? Object.assign({}, c2, { pf: {} }) : c) + (on.length ? " with the switch" + (on.length > 1 ? "es " : " ") + on.join(" + ") + " on" : "") + " (" + tieMsg(v));
          break;
        }
      }
    }
  }
  return out.filter((x, i, a) => a.indexOf(x) === i);
}
const switchTies = layerTies;
/* the free path in one flow: steps it lights whose words depend on money (they have money vary keys), but whose
   winning key isn't written for the free path (it doesn't name both before:none and after:none). The editors read
   each one and give it free words. Returns [{ id, shows }] (shows: the key that wins, or null for the base words). */
function freeWordGaps(steps, c) {
  const out = [];
  const go = (ss, ok) => (ss || []).forEach((s) => {
    if (!ok || !lit(s.when, c)) return;
    const money = Object.keys(s.vary || {}).filter((k) => { const cd = parseVaryKey(k); return cd && !CORE.isLayer(cd) && (cd.price || cd.before || cd.after); });
    if (money.length) {
      /* the money key that wins (layer keys, like a booking or switch key, are laid over it and don't count here) */
      const v = resolveVary(s, c), cd = v.choice ? parseVaryKey(v.choice) : null;
      if (!(cd && (cd.before || []).includes("none") && (cd.after || []).includes("none"))) out.push({ id: s.id, shows: v.choice });
    }
    (s.branches || []).forEach((b) => go(b.steps, lit(b.when, c)));
  });
  go(steps, true);
  return out;
}

/* ---------------------------------------------------------------- the parts, and what each gives the next */
const PF = ["pf.license", "pf.services", "pf.questions", "pf.safety", "pf.first_steps", "pf.visit", "pf.money", "pf.messages", "pf.staff", "pf.rules", "pf.edges"];
const SETUP = ["thread", "kinds", "business", "id_checked"].concat(PF).concat(["services", "ways", "price_oks", "booking_rules", "voice", "license", "calendar", "stripe", "terms", "live", "team", "staff_live"]);
const PARTS = {
  S12: { flows: ["A", "B"], sections: [1, 2], prefix: "S", shared: true },
  A36: { flows: ["A"], sections: [3, 4, 5, 6], prefix: "A" },
  B36: { flows: ["B"], sections: [3, 4, 5, 6], prefix: "B" },
  A710: { flows: ["A"], sections: [7, 8, 9, 10], prefix: "A" },
  B710: { flows: ["B"], sections: [7, 8, 9, 10], prefix: "B" },
  S1113: { flows: ["A", "B"], sections: [11, 12, 13], prefix: "S", shared: true }
};
/* the money keys a combination has once money before is done (section 5) */
function moneyKeys(c) {
  const k = ["money_before"];
  if (["card", "hold", "deposit"].includes(c.before)) k.push("card_saved");
  if (c.before === "hold") k.push("hold");
  if (c.before === "deposit") k.push("deposit_paid");
  if (c.before === "full") k.push("paid_full");
  k.push(c.price === "visit" ? "visit_fee" : "price_known");
  return k;
}
function booked(flow, c) { return ["request", "safe", "service", "customer", "answers", "booked", "code", "staff_told"].concat(flow === "B" ? ["address"] : []).concat(moneyKeys(c)); }
function exportsOf(part, flow, c) {
  if (part === "S12") return SETUP;
  if (part === "A36" || part === "B36") return booked(flow, c);
  if (part === "A710" || part === "B710") return ["visit_done", "settled"];
  return [];
}
function seedsOf(part, flow, c) {
  if (part === "S12") return [];
  if (part === "A36" || part === "B36") return SETUP;
  if (part === "A710" || part === "B710") return SETUP.concat(booked(flow, c));
  return SETUP.concat(booked(flow, c)).concat(["visit_done", "settled"]);
}

/* ---------------------------------------------------------------- the step schema and plain words */
const ACTORS = ["cust", "agent", "san", "owner", "staff", "pay", "out", "other"];
const VIAS = ["chat", "msg", "portal", "page", "sync", "auto", "visit", "call", "email"];
const STEP_KEYS = ["id", "type", "line", "prop", "who", "to", "via", "t", "title", "does", "more", "say", "rule", "needs", "gives", "tells", "slot", "as", "src", "q", "branches", "vary", "only", "kind", "form", "table", "own", "changed", "off", "phase", "sec", "gap", "inFlow", "when", "took", "layerAdd", "amounts", "timing", "timed", "rec", "ev", "wr", "visit", "text", "reads"];
const INFLOW_KEYS = ["title", "does", "more", "say", "rule", "vary", "as", "t"];
const BRANCH_KEYS_PROF = ["own", "off"];
const BRANCH_KEYS = ["label", "steps", "end", "endText", "when", "flow", "whenIn", "sets"];
const VARY_KEYS = ["does", "more", "say", "rule", "t", "form", "table", "swap", "addMore", "addSay"];
const LIM = { title: 48, does: 220, more: 140, msg: 260, msgPlain: 320, label: 34, endText: 110, q: 60, grade: 9.5, sentence: 22, ideas: 4, ruleGrade: 11, ruleSentence: 25, rule: 360 };

const syl = (w) => {
  w = w.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 1;
  if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
  const m = w.match(/[aeiouy]{1,2}/g);
  return Math.max(1, m ? m.length : 1);
};
const clean = (t) => String(t).replace(/santiago\.app\/\S+/g, "link").replace(/\b\d{1,2}(:\d\d)?\s?(am|pm)\b/gi, "time").replace(/[–—]/g, " to ").replace(/\s+/g, " ").trim();
const sentences = (t) => [].concat(...String(t).split(/\n+/).map((line) => clean(line).split(/(?<=[.!?])\s+(?=[A-Z0-9"'$])/))).map((x) => x.trim()).filter((x) => /[a-z0-9]/i.test(x));
const words = (t) => clean(t).split(/\s+/).filter((w) => /[a-z0-9]/i.test(w));
function grade(text) {
  const ss = sentences(text), ws = words(text);
  if (ws.length < 12) return null;
  const sy = ws.reduce((a, w) => a + syl(w), 0);
  return 0.39 * (ws.length / Math.max(1, ss.length)) + 11.8 * (sy / ws.length) - 15.59;
}
const longest = (text) => sentences(text).reduce((a, s) => Math.max(a, words(s).length), 0);
const CODE = /\b(F\d{1,2}|Q\d{1,2}|C\d{2}|E\d{2}|V\d{2}|P\d{1,2})\b|§ ?\d|fees\.json|FOUR-WAYS|PROGRAM\.md|LINES\.md|\bpf\.[a-z_]+|\bmaster rows?\b|\bway [1-4]\b|\be\.g\.|\bi\.e\./;
function scoreText(t) {
  const g = grade(t), lo = longest(t), why = [];
  if (g !== null && g > LIM.grade) why.push("grade " + g.toFixed(1));
  if (lo > LIM.sentence) why.push("a sentence of " + lo + " words");
  const dense = sentences(t).filter((x) => (x.match(/[,;()]/g) || []).length > LIM.ideas);
  if (dense.length) why.push(dense.length + " sentence(s) pack too many ideas");
  return why;
}
function scoreRule(r) {
  const t = String(r).replace(/\([^()]*(\([^()]*\)[^()]*)*\d[^()]*(\([^()]*\)[^()]*)*\)/g, ""), g = grade(t), lo = longest(t), why = [];
  if (g !== null && g > LIM.ruleGrade) why.push("rule box grade " + g.toFixed(1));
  if (lo > LIM.ruleSentence) why.push("rule box sentence of " + lo + " words");
  if (String(r).length > LIM.rule) why.push("rule box of " + String(r).length + " characters");
  return why;
}
/* plain words for one step (or one of its variants) */
function scoreStep(s) {
  const msgs = (s.say || []).map((m) => String(m[2] || ""));
  const all = [s.does || ""].concat(msgs).concat(s.more || []).join("\n");
  const g = grade(all), lo = longest(all), why = [];
  if (g !== null && g > LIM.grade) why.push("grade " + g.toFixed(1));
  if (lo > LIM.sentence) why.push("a sentence of " + lo + " words");
  if ((s.does || "").length > LIM.does) why.push("note " + s.does.length + " characters (limit " + LIM.does + ")");
  (s.more || []).forEach((x) => { if (String(x).length > LIM.more) why.push("a detail line of " + String(x).length + " characters"); });
  const dense = sentences(all).filter((x) => (x.match(/[,;()]/g) || []).length > LIM.ideas);
  if (dense.length) why.push(dense.length + " sentence(s) pack too many ideas");
  const text = all + "\n" + (s.title || "") + "\n" + (s.rule || "") + "\n" + JSON.stringify((s.say || []).map((m) => m[3] || null));
  const code = CODE.exec(text);
  if (code) why.push("an internal code (" + code[0] + ")");
  /* Jay, Oct 22: Rosie's only charge is the $2; no card-fee cut, and no rule is called "Jay's rule" */
  const gone = /3\.3% ?\+ ?30|\b0\.4%|Jay's rule|Jay's decision/i.exec(text);
  if (gone) why.push("words that must go (" + gone[0] + "): Rosie's only charge is the $2, and rules are Rosie's");
  if (s.slot) scoreText([s.slot.fills || ""].concat((s.slot.examples || []).map((x) => x[1])).join("\n")).forEach((w) => why.push("plug-in box: " + w));
  if (s.rule) scoreRule(s.rule).forEach((w) => why.push(w));
  (s.say || []).forEach((m) => {
    const t = String(m[2] || "");
    if (t.length > (m[3] ? LIM.msg : LIM.msgPlain)) why.push("a message of " + t.length + " characters");
    if (m[0] === "san" && !m[3] && (/\bReply 1\b.*\b2\b/.test(t) || /(^|\n)\s*[A-E]\)\s/.test(t))) why.push("options typed into a message");
    if (m[0] === "san" && /\breply [0-9A-J]\b/i.test(t) && !(m[3] && (m[3].buttons || m[3].times))) why.push("'reply N' typed into a message: use buttons");
  });
  return { g, why };
}

/* a plug-in gate in a `when`: a list of known facts (pf, factOn, factOff) or switches (switchOn, switchOff) */
function gateProblems(W, d, ctx) {
  const facts = ctx.facts || CORE.FACTS, sws = ctx.switches || CORE.SWITCHES, isFact = d !== "switchOn" && d !== "switchOff", p = [];
  if (!Array.isArray(W[d]) || !W[d].length) return ["when." + d + " must be a list of plug-in " + (isFact ? "facts" : "switches")];
  W[d].forEach((v) => {
    if (typeof v !== "string") p.push("when." + d + ": '" + v + "' must be a name");
    else if (isFact && !facts[v]) p.push("when." + d + ": no plug-in fact '" + v + "'" + (sws[v] ? " ('" + v + "' is a switch: use switchOn or switchOff)" : " (facts: " + Object.keys(facts).join(", ") + ")"));
    else if (!isFact && !sws[v]) p.push("when." + d + ": no plug-in switch '" + v + "'" + (facts[v] ? " ('" + v + "' is a fact: use pf (factOn) or factOff)" : " (switches: " + Object.keys(sws).join(", ") + ")"));
  });
  return p;
}
/* Tools J (E1; TOOL-SPEC 1.2): a `when`'s rec / recOff: a list of record facts */
function recWhenProblems(W, d) {
  if (!Array.isArray(W[d]) || !W[d].length) return ["when." + d + " must be a list of record facts (" + CORE.REC.join(", ") + ")"];
  return W[d].filter((n) => !CORE.REC.includes(n)).map((n) => "when." + d + ": '" + n + "' isn't a record fact: use " + ["paid", "card", "nothing", "full", "rest", "credit", "several", "keep", "written"].join(", "));
}
/* shape of one step; `ctx` = { part, flowIds, errors, warnings, ids } */
function checkShape(s, ctx, where) {
  const E = (m) => ctx.errors.push(where + " " + m), Wn = (m) => ctx.warnings.push(where + " " + m);
  /* a step's own `when`: plug-in gates, and (part B) money and booking choices: the step (and what's under it) is
     skipped where it fails, so a what-if that can't happen on a path dims there */
  if (s.when !== undefined) {
    if (!s.when || typeof s.when !== "object" || Array.isArray(s.when) || !Object.keys(s.when).length) E("'when' on a step must be an object of plug-in gates or money and booking choices");
    else Object.keys(s.when).forEach((d) => {
      if (CORE.GATES.includes(d)) gateProblems(s.when, d, ctx).forEach((p) => E(p));
      else if (d === "took") { if (!["A", "B"].includes(s.when.took)) E("when.took is stamped by the tools (\"A\" or \"B\"): don't write it by hand"); }
      else if (d === "wr") { if (s.when.wr !== false) E("when.wr is stamped by the tools (false): don't write it by hand"); }
      else if (d === "ev") { if (!["A", "B"].includes(s.when.ev)) E("when.ev is stamped by the tools (\"A\" or \"B\"): don't write it by hand"); }
      else if (d === "rec" || d === "recOff") recWhenProblems(s.when, d).forEach((p) => E(p));
      else if (d === "booking") { if (!Array.isArray(s.when.booking) || !s.when.booking.length) E("when.booking must be a list"); else s.when.booking.forEach((v) => { if (!CORE.GROUP_OF[v]) E("when.booking: no booking choice '" + v + "' (" + Object.keys(CORE.GROUP_OF).join(", ") + ")"); }); }
      else if (!DIMS[d]) E("a step's 'when' may name price, before, after, booking or a plug-in gate (" + CORE.GATES.join(", ") + "), not '" + d + "'");
      else if (!Array.isArray(s.when[d]) || !s.when[d].length) E("when." + d + " must be a list");
      else s.when[d].forEach((v) => { if (!DIMS[d].some((x) => x.k === v)) E("when." + d + ": no choice '" + v + "'"); });
    });
  }
  /* auto-fill slots: known names with their example words; never in a branch label (overlays turn branches off by label) */
  CORE.stepTexts(s).forEach((x) => CORE.slotProblems(x[1]).forEach((p) => E(x[0] + ": " + p)));
  (s.branches || []).forEach((b) => { if (/\{\{|\}\}/.test(String(b.label || ""))) E("branch '" + b.label + "': a label can't hold a slot (overlays turn branches off by their label)"); });
  Object.keys(s).forEach((k) => { if (!STEP_KEYS.includes(k)) E("unknown field '" + k + "'"); });
  if (!s.id) E("has no id");
  else {
    if (ctx.ids.has(s.id)) E("duplicate id " + s.id);
    ctx.ids.add(s.id);
    const want = PARTS[ctx.part] ? PARTS[ctx.part].prefix : null;
    const m = ctx.prof ? /^([SAB])(\d+)-(\d{2,3}|x\d{2,3})$/.exec(s.id) : /^([SAB])(\d+)-(\d{2,3})$/.exec(s.id);
    if (!m) E(ctx.prof ? "a profession's own step id looks like A4-x01 (flow letter, section, x, number)" : "id must look like A4-07 (flow letter, section, number)");
    else if (ctx.prof && s.own && !/^x/.test(m[3])) E("a profession's own step id needs the x: like " + m[1] + m[2] + "-x01");
    else if (want && m[1] !== want) E("id must start with " + want);
  }
  /* Tools C: "took" ("A"/"B" stamped by the tools; false keeps the service's words after the money step) and "layerAdd"
     (stamped layer lines) */
  if (s.took !== undefined && !["A", "B", false].includes(s.took)) E("'took' is stamped by the tools (\"A\" or \"B\"); write only \"took\": false, to keep the service's money words after the money step");
  /* Tools J (E1): "ev" (stamped from record.json "from"; write only "ev": false) and "rec" (stamped on a step with record slots) */
  if (s.visit !== undefined && !(typeof s.visit === "string" && CORE.parseAbsT(s.visit, null) && CORE.parseAbsT(s.visit, null).exact)) E("'visit' names the visit this step is about, with its day and time, like \"Fri Oct 23, 8:00am\" (its record rows' {{cutoff}} reads it)");
  if (s.wr !== undefined && s.wr !== false) E("'wr' is stamped by the tools (false: before the booking is written, record.json \"written\"): don't write it by hand");
  if (s.ev !== undefined && !["A", "B", false].includes(s.ev)) E("'ev' is stamped by the tools (\"A\" or \"B\") from record.json \"from\"; write only \"ev\": false, to keep this step on the events' defaults");
  if (s.rec !== undefined && !["A", "B"].includes(s.rec)) E("'rec' is stamped by the tools (\"A\" or \"B\") on a step whose words hold a record slot: don't write it by hand");
  if (s.layerAdd !== undefined && (!Array.isArray(s.layerAdd) || s.layerAdd.some((x) => !x || typeof x.line !== "string" || !Array.isArray(x.to)))) E("'layerAdd' is stamped by the tools from header.json layerLines");
  /* Tools F (T3): "timing" is stamped by the tools from header.json "timed" (write only "timing": false, to keep a step's
     time slots on the set-time words); "timed" is stamped when the slots are filled */
  if (s.timing !== undefined && !["A", "B", false].includes(s.timing)) E("'timing' is stamped by the tools (\"A\" or \"B\") from header.json timed; write only \"timing\": false, to keep this step's time slots on the set-time words");
  /* Tools J (E2): "text" names a shared text (merged in by the build); "reads" is stamped by build-master */
  if (s.text !== undefined && (typeof s.text !== "string" || !s.text)) E("'text' names a shared text (a part's \"shared\" block), like \"late-cancel-warn\"");
  if (s.reads !== undefined && (!Array.isArray(s.reads) || !s.reads.length || s.reads.some((k) => typeof k !== "string" || !/^[a-z][a-z0-9]*$/.test(k)))) E("'reads' is stamped by the build (what a step follows: the record's homes, like " + READS_KEYS.slice(0, 4).join(", ") + "): don't write it by hand");
  if (s.timed !== undefined && (!Array.isArray(s.timed) || s.timed.some((x) => !Array.isArray(x) || x.length !== 3 || x.some((y) => typeof y !== "string")))) E("'timed' is stamped by the tools when the time slots are filled");
  /* Tools D: "amounts" is stamped by the tools (from header.json flows.<flow>.amounts) on steps with amount slots */
  if (s.amounts !== undefined) CORE.amountTableProblems(s.amounts, "").forEach((p) => E("'amounts' (stamped by the tools from header.json flows.<flow>.amounts): " + p));
  if (!ACTORS.includes(s.who)) E("unknown 'who' " + s.who);
  if (s.to && !ACTORS.includes(s.to)) E("unknown 'to' " + s.to);
  if (!VIAS.includes(s.via)) E("unknown 'via' " + s.via);
  if (!s.title) E("has no title"); else if (s.title.length > LIM.title) E("title over " + LIM.title + " characters: " + s.title);
  if (!Array.isArray(s.line) || !s.line.length) E("needs 'line': the LINES.md lines it covers, like [\"4.11\"]");
  else s.line.forEach((l) => { if (!LINES.byId[l]) E("unknown line " + l); });
  if (s.only && !["A", "B"].includes(s.only)) E("'only' must be \"A\" or \"B\"");
  if (s.only && !(PARTS[ctx.part] || {}).shared) E("'only' is for shared parts (S12, S1113)");
  if (s.kind && s.kind !== "rule") E("'kind' can only be \"rule\"");
  if (s.inFlow) {
    if (!(PARTS[ctx.part] || {}).shared) E("'inFlow' is for shared parts (S12, S1113)");
    Object.keys(s.inFlow).forEach((fl) => {
      if (!["A", "B"].includes(fl)) E("inFlow keys are A and B");
      Object.keys(s.inFlow[fl] || {}).forEach((k) => { if (!INFLOW_KEYS.includes(k)) E("inFlow." + fl + " may only set " + INFLOW_KEYS.join(", ") + " (not " + k + ")"); });
      const t = (s.inFlow[fl] || {}).title; if (t && t.length > LIM.title) E("inFlow." + fl + " title over " + LIM.title + " characters: " + t);
      ((s.inFlow[fl] || {}).say || []).forEach((m, i) => { if (Array.isArray(m) && m.length === 4) MSG.uiProblems(m[3]).forEach((p) => E("inFlow." + fl + " message " + (i + 1) + ": " + p)); });
    });
  }
  if (!s.does && !s.say && !s.rule) Wn("says nothing beyond its title");
  (s.say || []).forEach((m, i) => {
    if (!Array.isArray(m) || (m.length !== 3 && m.length !== 4)) { E("message " + (i + 1) + " must be [from, to, text] or [from, to, text, element]"); return; }
    if (!ACTORS.includes(m[0]) || !ACTORS.includes(m[1])) E("message " + (i + 1) + " has an unknown sender or recipient");
    if (m.length === 4) MSG.uiProblems(m[3]).forEach((p) => E("message " + (i + 1) + ": " + p));
  });
  if (s.vary) {
    if (typeof s.vary !== "object" || Array.isArray(s.vary)) E("'vary' must be an object");
    else for (const k of Object.keys(s.vary)) {
      const conds = parseVaryKey(k);
      if (!conds) { E("bad vary key '" + k + "' (use before:hold, after:bill, price:visit, joined with +)"); continue; }
      for (const d of Object.keys(conds)) if (DIMS[d]) conds[d].forEach((v) => { if (!DIMS[d].some((x) => x.k === v)) E("vary key '" + k + "': no " + d + " choice '" + v + "'"); });
      (conds.booking || []).forEach((v) => { if (!CORE.GROUP_OF[v]) E("vary key '" + k + "': no booking choice '" + v + "' (" + Object.keys(CORE.GROUP_OF).join(", ") + ")"); });
      const known = ctx.switches || CORE.SWITCHES;
      (conds.pf || []).forEach((n) => { if (!known[n]) E("vary key '" + k + "': no plug-in switch '" + n + "' (switches: " + Object.keys(known).join(", ") + ")"); });
      Object.keys(s.vary[k] || {}).forEach((f) => { if (!VARY_KEYS.includes(f)) E("vary '" + k + "' may only change " + VARY_KEYS.join(", ") + " (not " + f + ")"); });
      ((s.vary[k] || {}).say || []).concat((s.vary[k] || {}).addSay || []).forEach((m, i) => { if (Array.isArray(m) && m.length === 4) MSG.uiProblems(m[3]).forEach((p) => E("vary '" + k + "' message " + (i + 1) + ": " + p)); });
      const v = s.vary[k] || {};
      if (v.swap !== undefined && (!Array.isArray(v.swap) || !v.swap.length || v.swap.some((p) => !Array.isArray(p) || p.length !== 2 || typeof p[0] !== "string" || !p[0] || typeof p[1] !== "string"))) E("vary '" + k + "': swap must be a list of [\"old words\", \"new words\"] pairs");
      if (v.addMore !== undefined && (!Array.isArray(v.addMore) || v.addMore.some((x) => typeof x !== "string" || !x))) E("vary '" + k + "': addMore must be a list of lines");
      if (v.addSay !== undefined && (!Array.isArray(v.addSay) || v.addSay.some((m) => !Array.isArray(m) || (m.length !== 3 && m.length !== 4) || !ACTORS.includes(m[0]) || !ACTORS.includes(m[1])))) E("vary '" + k + "': addSay must be a list of messages [from, to, text] or [from, to, text, element]");
    }
  }
  if (s.type === "split") {
    if (!s.q) E("split has no question 'q'"); else if (s.q.length > LIM.q) E("question over " + LIM.q + " characters: " + s.q);
    if (!Array.isArray(s.branches) || s.branches.length < 2) E("split needs 2 or more branches");
    (s.branches || []).forEach((b, bi) => {
      const bw = "branch " + (bi + 1) + " '" + (b.label || "") + "'";
      Object.keys(b).forEach((k) => { if (!BRANCH_KEYS.includes(k) && !(ctx.prof && BRANCH_KEYS_PROF.includes(k))) E(bw + " unknown field '" + k + "'"); });
      if (!b.label) E(bw + " has no label"); else if (b.label.length > LIM.label) E(bw + " label over " + LIM.label + " characters");
      if (!["merge", "end"].includes(b.end || "merge")) E(bw + " end must be merge or end");
      if (b.end === "end" && !b.endText) E(bw + " ends without endText");
      if (b.endText && b.endText.length > LIM.endText) E(bw + " endText over " + LIM.endText + " characters");
      if (b.flow && !["A", "B"].includes(b.flow)) E(bw + " 'flow' must be A or B");
      if (b.whenIn && !(PARTS[ctx.part] || {}).shared) E(bw + " 'whenIn' is for shared parts (S12, S1113)");
      if (b.whenIn) Object.keys(b.whenIn).forEach((f) => { if (!["A", "B"].includes(f)) E(bw + " whenIn keys are A and B"); });
      /* Tools D (#16): a booking value that changes mid-booking, from this branch on: { "privacy": "private" } */
      if (b.sets !== undefined) { if (!b.sets || typeof b.sets !== "object" || Array.isArray(b.sets) || !Object.keys(b.sets).length) E(bw + " 'sets' must be an object like { \"privacy\": \"private\" }"); else Object.keys(b.sets).forEach((g) => { if (g === "svcAdd" && CORE.recordOn && CORE.recordOn()) { if (typeof b.sets.svcAdd !== "string" || !CORE.findService(b.sets.svcAdd)) E(bw + " sets.svcAdd: no service '" + b.sets.svcAdd + "' in record.json services"); } else if (!CORE.BOOKING[g]) E(bw + " sets: no booking choice '" + g + "' (" + Object.keys(CORE.BOOKING).join(", ") + ")"); else if (CORE.GROUP_OF[b.sets[g]] !== g) E(bw + " sets." + g + " must be one of " + CORE.BOOKING[g].values.map((v) => v[0]).join(", ")); }); }
      [b.when].concat(Object.values(b.whenIn || {})).filter(Boolean).forEach((W) => Object.keys(W).forEach((d) => {
        if (d === "took") { if (!["A", "B"].includes(W.took)) E(bw + " when.took is stamped by the tools (\"A\" or \"B\"): don't write it by hand"); }
        else if (d === "wr") { if (W.wr !== false) E(bw + " when.wr is stamped by the tools (false): don't write it by hand"); }
        else if (d === "ev") { if (!["A", "B"].includes(W.ev)) E(bw + " when.ev is stamped by the tools (\"A\" or \"B\"): don't write it by hand"); }
        else if (d === "rec" || d === "recOff") recWhenProblems(W, d).forEach((p) => E(bw + " " + p));
        else if (d === "booking") { if (!Array.isArray(W.booking) || !W.booking.length) E(bw + " when.booking must be a list"); else W.booking.forEach((v) => { if (!CORE.GROUP_OF[v]) E(bw + " when.booking: no booking choice '" + v + "' (" + Object.keys(CORE.GROUP_OF).join(", ") + ")"); }); }
        else if (CORE.GATES.includes(d)) gateProblems(W, d, ctx).forEach((p) => E(bw + " " + p));
        else if (!DIMS[d]) E(bw + " when: unknown choice '" + d + "' (price, before, after, booking, or a plug-in gate: " + CORE.GATES.join(", ") + ")");
        else if (!Array.isArray(W[d]) || !W[d].length) E(bw + " when." + d + " must be a list");
        else W[d].forEach((v) => { if (!DIMS[d].some((x) => x.k === v)) E(bw + " when." + d + ": no choice '" + v + "'"); });
      }));
      if (false) Object.keys(b.when).forEach((d) => {
        if (!DIMS[d]) E(bw + " when: unknown choice '" + d + "' (price, before, after)");
        else if (!Array.isArray(b.when[d]) || !b.when[d].length) E(bw + " when." + d + " must be a list");
        else b.when[d].forEach((v) => { if (!DIMS[d].some((x) => x.k === v)) E(bw + " when." + d + ": no choice '" + v + "'"); });
      });
    });
  } else if (s.branches || s.q) E("only a split (type: \"split\") has q and branches");
}

/* a shared part's steps as one flow sees them: steps for the other flow drop out, and inFlow words apply */
function forFlow(steps, fl) {
  return (steps || []).filter((s) => !s.only || s.only === fl).map((s) => {
    const c = JSON.parse(JSON.stringify(s)); delete c.only;
    if (c.inFlow) { const w = c.inFlow[fl] || {}; Object.keys(w).forEach((k) => { if (k === "vary") c.vary = Object.assign({}, c.vary || {}, w.vary); else c[k] = w[k]; }); delete c.inFlow; }
    if (c.branches) c.branches = c.branches.map((b) => { if (b.whenIn) { if (b.whenIn[fl]) b.when = b.whenIn[fl]; delete b.whenIn; } return Object.assign(b, { steps: forFlow(b.steps, fl) }); });
    return c;
  });
}
/* walk every step (and branch steps), depth first, in the page's order */
function eachStep(steps, f, trail = []) {
  (steps || []).forEach((s) => { f(s, trail); (s.branches || []).forEach((b) => eachStep(b.steps, f, trail.concat([b.label]))); });
}

/* Part B helpers -------------------------------------------------------------------------------------------------- */
/* a step's words under one variant, as the page shows them (swap, the fields, the adds), for plain-words scoring */
const varyView = (s, k) => Object.assign(CORE.applyLayer(s, s.vary[k]), { slot: null });
/* a copy of some steps with their auto-fill slots filled (the master's own words; pf = switches to fill with, like
   { sensitive: true } for the privacy forms) */
function filled(steps, fl, pf) {
  if (!CORE.hasSlots(steps)) return steps;
  const c = JSON.parse(JSON.stringify(steps));
  CORE.fillSteps(c, CORE.slotCtx(null, fl, pf ? { pf } : null)); CORE.unkeepSteps(c);
  /* Tools D: amount slots read as their example words (or "$40") for plain words; per path they come from the table */
  if (JSON.stringify(c).search(CORE.AMOUNT_RE) >= 0) {
    const amt = (v) => typeof v === "string" ? v.replace(new RegExp(CORE.AMOUNT_RE.source, "g"), (m, n, ex) => (ex && ex.trim()) || "$40") : Array.isArray(v) ? v.map(amt) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).map((k) => [k, k === "amounts" ? v[k] : amt(v[k])])) : v;
    eachStep(c, (s) => { ["title", "does", "rule", "q", "more", "say", "form", "table", "vary", "inFlow"].forEach((k) => { if (s[k] !== undefined) s[k] = amt(s[k]); }); (s.branches || []).forEach((b) => { if (b.endText) b.endText = amt(b.endText); }); });
  }
  return c;
}
/* relative times in one flow: each must read, name a step of this flow, and not loop back to itself; the master's
   cutoff slots must match its own rule (else they need the visit they belong to) */
function flowTimeProblems(steps, fl) {
  const ids = {}, out = [], rel = {};
  eachStep(steps, (s) => { ids[s.id] = true; });
  eachStep(steps, (s) => {
    CORE.timeProblems(s, ids).forEach((p) => out.push((fl ? fl + ":" : "") + s.id + " " + p));
    const r = s.t ? CORE.parseRelT(s.t) : null; if (r && r.anchor) rel[s.id] = r.anchor;
    if (fl) CORE.cutoffChecks(s, fl).forEach((p) => out.push(fl + ":" + s.id + " " + p));
  });
  Object.keys(rel).forEach((id) => { const seen = [id]; let x = rel[id]; while (x && rel[x] && !seen.includes(x)) { seen.push(x); x = rel[x]; } if (x && seen.includes(x) && x === id) out.push((fl ? fl + ":" : "") + id + " its time and " + seen.slice(1).join(", ") + " are set from each other in a loop"); else if (x && rel[x] && seen.includes(x)) { /* a loop further on, reported at its own steps */ } });
  return out;
}
/* one combination: order and a complete path. Returns { given, terminal } and pushes errors. */
/* Review r5 (lines, finding 7): a variant that sets its own `more` replaces the whole base `more` on its paths, so it
   must still carry the step's decision lines (D3: "Means ..." lines, "Never ...", "Silence ...", the "judgment rule N"
   pointer with its safe default). Returns [{ id, key, missing: [lines] }]. */
const DECISION_LINE = /^\s*(?:Means\b|Never\b|Silence\b)|\bjudgment rules? \d|\bSafe default\b/i;
function decisionDrops(steps) {
  const out = [];
  eachStep(steps, (s) => {
    const want = (s.more || []).filter((x) => DECISION_LINE.test(String(x)));
    if (!want.length) return;
    Object.keys(s.vary || {}).forEach((k) => {
      const v = s.vary[k] || {};
      if (!Array.isArray(v.more)) return;
      const missing = want.filter((x) => !v.more.includes(x));
      if (missing.length) out.push({ id: s.id, key: k, missing });
    });
  });
  return out;
}
/* Review r5 (money): a switch-only variant ("pf:freeno") that leaves out a field the money variants on the step set
   lets those money words show with the switch on (unless a joined key, "pf:freeno+price:visit", sets it). Returns
   [{ id, key, fields, under: [money keys] }]. Fields read: does, more, say, rule, form, table (a swap or an add counts
   as setting the fields it changes). */
const COVER_FIELDS = ["does", "more", "say", "rule", "form", "table"];
function switchGaps(steps) {
  const out = [];
  eachStep(steps, (s) => {
    const keys = Object.keys(s.vary || {}), conds = {};
    keys.forEach((k) => { conds[k] = parseVaryKey(k); });
    const money = keys.filter((k) => conds[k] && !CORE.isLayer(conds[k]));
    const sw = keys.filter((k) => conds[k] && conds[k].pf && !conds[k].booking && !conds[k].price && !conds[k].before && !conds[k].after);
    if (!money.length || !sw.length) return;
    sw.forEach((p) => {
      const has = new Set(CORE.layerFields(s.vary[p])), miss = {}, under = new Set();
      money.forEach((m) => CORE.layerFields(s.vary[m]).filter((f) => COVER_FIELDS.includes(f) && !has.has(f)).forEach((f) => {
        /* a joined key with this switch (or more) and this money key's parts that sets the field covers it */
        const covered = keys.some((j) => { const c = conds[j]; if (!c || j === p || j === m) return false; const inc = (a, b) => Object.keys(a).every((d) => (b[d] || []).length && a[d].every((v) => (b[d] || []).includes(v))); return inc(conds[p], c) && inc(conds[m], c) && CORE.layerFields(s.vary[j]).includes(f); });
        if (!covered) { miss[f] = 1; under.add(m); }
      }));
      if (Object.keys(miss).length) out.push({ id: s.id, key: p, fields: Object.keys(miss), under: [...under] });
    });
  });
  return out;
}
/* D5 / D56 item 6: a step with money variants keyed by before: alone must cover every before choice lit on it (none,
   card, hold, deposit, full). Returns [{ id, have, missing }] for the steps that miss some (information for editors). */
function beforeCoverage(steps, paths) {
  const out = [];
  const go = (ss, ps) => (ss || []).forEach((s) => {
    const here = ps.filter((c) => !s.when || lit(s.when, c));
    const only = Object.keys(s.vary || {}).map((k) => parseVaryKey(k)).filter((cd) => cd && Object.keys(cd).length === 1 && cd.before);
    if (only.length && here.length) {
      const have = new Set(); only.forEach((cd) => cd.before.forEach((v) => have.add(v)));
      const litB = [...new Set(here.map((c) => c.before))];
      const missing = litB.filter((v) => !have.has(v) && !Object.keys(s.vary).some((k) => { const cd = parseVaryKey(k); return cd && !CORE.isLayer(cd) && (cd.before || []).includes(v); }));
      if (missing.length) out.push({ id: s.id, have: [...have], missing });
    }
    (s.branches || []).forEach((b) => go(b.steps, here.filter((c) => lit(b.when, c))));
  });
  go(steps, paths.filter((c) => !c.booking && !(c.pf && Object.keys(c.pf).length) && !c.facts));
  return out;
}
/* swap pairs that change nothing on every path where their variant applies (a dead pair: its words aren't under it) */
/* Tools G: the paths a step is also read with because a branch's "sets" reaches it (its own steps, and the steps after it
   rejoins): withSets(c, sets) for every path given, per step id. Empty with no sets branch in the flow. */
function setsPathsFor(steps, paths) {
  const out = new Map();
  const S = CORE.setsScopes(steps);
  if (!S.length) return out;
  S.forEach((x) => x.own.concat(x.after).forEach((id) => {
    const m = out.get(id) || new Map();
    paths.forEach((c) => { const p = CORE.withSets(c, x.sets, x.key); const k = CORE.pathSig(p) + "#" + JSON.stringify([c.price, c.before, c.after, c.pf || null, c.facts || null]); if (!m.has(k)) m.set(k, p); });
    out.set(id, m);
  }));
  const res = new Map(); out.forEach((m, id) => res.set(id, [...m.values()]));
  return res;
}
function deadSwaps(steps, paths, where) {
  const out = [], extra = setsPathsFor(steps, paths);
  eachStep(steps, (s) => {
    const ks = Object.keys(s.vary || {}).filter((k) => (s.vary[k] || {}).swap);
    if (!ks.length) return;
    const trace = {};
    paths.forEach((c) => resolveVary(s, c, trace));
    (extra.get(s.id) || []).forEach((c) => resolveVary(s, c, trace)); /* (Tools G: the paths a sets branch changes) */
    ks.forEach((k) => { if (!trace[k]) return; (s.vary[k].swap || []).forEach((p, i) => { if (!trace[k][i]) out.push((where || "") + s.id + " vary '" + k + "': the swap for '" + String(p[0]).slice(0, 50) + "' matches nothing on any path where this variant shows"); }); });
  });
  return out;
}
/* Tools G: the walk once a flow has a branch whose "sets" rejoins: each state is { g: the keys given, c: the path as it
   reads there }; inside a sets branch and after it rejoins, the path reads the change (CORE.withSets, setBy naming the
   branch); where other lit branches rejoin too, the later steps are walked with both. At a rejoin, the states that read
   the same (CORE.pathSig) are one, with the keys given on every way into it. Same checks and words as walkCombo0. */
function walkComboSets(steps, states, flow, errs, where) {
  const group = (list) => { const m = new Map(); list.forEach((x) => { const k = CORE.pathSig(x.c), y = m.get(k); if (!y) m.set(k, { g: x.g, c: x.c }); else y.g = new Set([...y.g].filter((q) => x.g.has(q))); }); return [...m.values()]; };
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.only && s.only !== flow) continue;
    const next = [];
    for (const st of states) {
      const c = st.c;
      if (s.when && !lit(s.when, c)) { next.push(st); continue; }
      const v = resolveVary(s, c);
      if (v.tie) errs.push(where + s.id + ": two variants fit " + pathKey(c) + " (" + v.tie.join(", ") + ")");
      (s.needs || []).forEach((k) => { if (!st.g.has(k)) errs.push(where + s.id + " needs '" + k + "', which no earlier step gives on the path " + pathKey(c)); });
      let g = st.g;
      if ((s.gives || []).length) { g = new Set(g); s.gives.forEach((k) => g.add(k)); }
      if (s.type !== "split") { next.push({ g, c }); continue; }
      const Lb = (s.branches || []).filter((b) => lit(b.when, c));
      if (!Lb.length) { errs.push(where + s.id + ": no branch is lit for " + pathKey(c)); continue; }
      const money = (s.branches || []).every((b) => b.when && CORE.chooses(b.when));
      const merged = [];
      Lb.forEach((b) => {
        const cb = b.sets && !b.off ? CORE.withSets(c, b.sets, CORE.setsKey(s, b)) : c;
        const r = walkComboSets(b.steps || [], [{ g, c: cb }], flow, errs, where);
        if ((b.end || "merge") !== "end" && !r.terminal) merged.push(...r.states);
      });
      if (money && Lb.length > 1 && !CORE.eventsUnderChoice(s)) errs.push(where + s.id + ": a money split must light one branch for " + pathKey(c) + ", but lights " + Lb.map((b) => b.label).join(" / "));
      if (!merged.length) { if (i < steps.length - 1) errs.push(where + s.id + ": every lit branch ends for " + pathKey(c) + ", so the path stops here"); continue; }
      group(merged).forEach((x) => next.push(x));
    }
    states = group(next);
    if (!states.length) return { states: [], terminal: true };
  }
  return { states, terminal: false };
}
/* the walk of one path: order (a step only needs what an earlier step gave), ties, a complete path. Tools G: once a
   branch's "sets" rejoins (CORE.lateSets), walkComboSets carries the changed path to the steps after it; given is then
   the keys given on every way to the end. Otherwise exactly as before (walkCombo0). */
function walkCombo(steps, given, c, flow, errs, where) {
  if (!(process.env.S2F_SETS_WALK === "1" || CORE.lateSets(steps))) return walkCombo0(steps, given, c, flow, errs, where);
  const r = walkComboSets(steps, [{ g: new Set(given), c }], flow, errs, where);
  if (r.terminal) return { given: new Set(given), terminal: true };
  return { given: new Set([...r.states[0].g].filter((k) => r.states.every((x) => x.g.has(k)))), terminal: false, states: r.states };
}
function walkCombo0(steps, given, c, flow, errs, where) {
  let g = new Set(given);
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.only && s.only !== flow) continue;
    if (s.when && !lit(s.when, c)) continue; /* a step gated on the plug-in (switches, facts) that this path doesn't have */
    const v = resolveVary(s, c);
    if (v.tie) errs.push(where + s.id + ": two variants fit " + pathKey(c) + " (" + v.tie.join(", ") + ")");
    (s.needs || []).forEach((k) => { if (!g.has(k)) errs.push(where + s.id + " needs '" + k + "', which no earlier step gives on the path " + pathKey(c)); });
    (s.gives || []).forEach((k) => g.add(k));
    if (s.type !== "split") continue;
    const L = (s.branches || []).filter((b) => lit(b.when, c));
    if (!L.length) { errs.push(where + s.id + ": no branch is lit for " + pathKey(c)); return { given: g, terminal: true }; }
    /* a choice split (money or booking): every branch carries a choice; a branch gated only on plug-in facts isn't one */
    const money = (s.branches || []).every((b) => b.when && CORE.chooses(b.when));
    const merged = [];
    L.forEach((b) => {
      const r = walkCombo0(b.steps || [], g, b.sets ? CORE.withSets(c, b.sets) : c, flow, errs, where); /* (Tools D #16: a mid-booking change) */
      if ((b.end || "merge") !== "end" && !r.terminal) merged.push(r.given);
    });
    /* (Tools D: events under one booking choice, like A3-01's ways in for madeby customer, may light several) */
    if (money && L.length > 1 && !CORE.eventsUnderChoice(s)) errs.push(where + s.id + ": a money split must light one branch for " + pathKey(c) + ", but lights " + L.map((b) => b.label).join(" / "));
    if (!merged.length) {
      if (i < steps.length - 1) errs.push(where + s.id + ": every lit branch ends for " + pathKey(c) + ", so the path stops here");
      return { given: g, terminal: true };
    }
    g = new Set([...merged[0]].filter((k) => merged.every((m) => m.has(k))));
  }
  return { given: g, terminal: false };
}

/* Tools C (STATE.md T1, T2): stamp one flow's steps from header.json. head.took = { A: "<money step id>", B: ... }:
   that step and every later one (page order) get "took": fl (unless "took": false), and so do their branches' and their
   own money whens. head.layerLines = [{ id, when, to, line, way, sections, more }]: stamped as "layerAdd" on the steps
   that message those people. mode (check-part, a part alone): "all" stamps took on every step (a part after the money
   step), "find" stamps from the money step if the part has it, "none" stamps no took. Returns the problems found. */
function stampFlow(steps, fl, head, mode, tmode0, more) {
  const out = [];
  const tid = head && head.took ? head.took[fl] : null;
  if (tid && mode !== "none") {
    let on = mode === "all", seen = false;
    eachStep(steps, (s) => {
      if (s.id === tid) { on = true; seen = true; }
      if (!on || s.took === false) return;
      s.took = fl;
      const st = (w) => { if (w && (w.price || w.before || w.after || w.rec || w.recOff)) w.took = fl; }; /* (tools J: record facts read what was taken too, TOOL-SPEC 1.2) */
      st(s.when); (s.branches || []).forEach((b) => st(b.when));
    });
    if (mode !== "all" && mode !== "find" && !seen) out.push("header took: " + fl + " names " + tid + ", which isn't a step of flow " + fl);
  }
  const LL = head && Array.isArray(head.layerLines) ? head.layerLines : [];
  if (LL.length) CORE.stampLayerLines(steps, LL.map((x) => Object.assign({}, x, { to: x.to || ["owner", "staff"] })), null);
  /* Tools D (DESIGN 9.2 #7): the flow's amount table (header flows.<flow>.amounts) on every step with an amount slot */
  const AT = head && head.flows && head.flows[fl] && head.flows[fl].amounts;
  if (AT) eachStep(steps, (s) => { if (CORE.amountsIn(s)) s.amounts = AT; });
  /* Tools F (T3): head.timed = { B: "<step where the timing is decided>" }: every A or B step after it and its branches
     (sections 3-10; "timing": false keeps a step out) gets "timing": fl, so its time slots follow sent now and a live line.
     tmode (check-part): "all" (a part after that step), "find" (the part has it), "none". */
  const xid = head && head.timed ? head.timed[fl] : null, tmode = mode === undefined && tmode0 === undefined ? undefined : (tmode0 || "none");
  if (xid && tmode !== "none") {
    let on = tmode === "all", seen = false, inside = null;
    const go = (ss) => (ss || []).forEach((s) => {
      if (s.id === xid) { seen = true; inside = s; (s.branches || []).forEach((b) => go(b.steps)); inside = null; on = true; return; }
      if (on && !inside && /^[AB]\d+-/.test(s.id || "") && s.timing !== false) s.timing = fl;
      (s.branches || []).forEach((b) => go(b.steps));
    });
    go(steps);
    if (tmode === undefined && !seen) out.push("header timed: " + fl + " names " + xid + ", which isn't a step of flow " + fl);
  }
  /* Tools J (E1; TOOL-SPEC 1.1, 2.2): header "record": true. more = { record: the flow's table (default CORE.record(fl)),
     emode: "all" | "find" | "none" (check-part, as for took; build-master leaves it out) }. From record.json "from"
     (the first step an event can follow) every later step in page order gets "ev": fl (unless "ev": false), and so do
     its own and its branches' whens that name booking or record facts; every step whose words hold a record slot or a
     ledger amount gets "rec": fl and the flow's amount table. */
  if (head && head.record === true) {
    const RT = (more && more.record) || CORE.record(fl), emode = mode === undefined && (!more || more.emode === undefined) ? undefined : ((more && more.emode) || "none");
    if (!RT) out.push("header record is on, but no record table (work/master/src/record.json) is loaded for flow " + fl);
    else {
      const eid = RT.from ? (typeof RT.from === "string" ? RT.from : RT.from[fl]) : null;
      if (!eid) out.push("record.json \"from\" names no step for flow " + fl + " (the first step an event can follow)");
      else if (emode !== "none") {
        let on = emode === "all", seen = false;
        eachStep(steps, (s) => {
          if (s.id === eid) { on = true; seen = true; }
          const sm = /^[SAB](\d+)-/.exec(s.id || "");
          if (!on || s.ev === false || (sm && +sm[1] > 12)) return; /* (sections up to 12: the section 13 rule nodes aren't walked) */
          s.ev = fl;
          const st = (w) => { if (w && (w.booking || w.rec || w.recOff)) w.ev = fl; };
          st(s.when); (s.branches || []).forEach((b) => st(b.when));
        });
        if (emode === undefined && !seen) out.push("record.json from: " + fl + " names " + eid + ", which isn't a step of flow " + fl);
      }
      eachStep(steps, (s) => { if (CORE.recordSlotsIn(s).length || CORE.ledgerIn(s)) { s.rec = fl; if (AT && !s.amounts) s.amounts = AT; } });
      /* E1 fix: money and credits count as taken only once the booking is written (record.json "written", default A6-10 /
         B6-10). A took step before it in page order (a request awaiting the OK, a time lost on the page, a decline) gets
         "wr": false, and so do its own and its branches' whens naming record facts; a part without that step: none */
      const WD = { A: "A6-10", B: "B6-10" }, wid = RT.written ? (typeof RT.written === "string" ? RT.written : RT.written[fl]) : WD[fl];
      let wseen = false; eachStep(steps, (s) => { if (s.id === wid) wseen = true; });
      if (wid && wseen) {
        /* E1 fix 2 (judge A H1): the money step itself (header took) and every step inside its branches are the page the
           customer agrees to: they show what WILL be taken when the booking is written, so they get no "wr": false */
        const agree = new Set(), mid = head.took && head.took[fl];
        eachStep(steps, (s) => { if (s.id === mid) { agree.add(s.id); (s.branches || []).forEach((b) => eachStep(b.steps || [], (x) => agree.add(x.id))); } });
        let past = false;
        eachStep(steps, (s) => {
          if (s.id === wid) past = true;
          if (past || s.took !== fl || s.wr !== undefined || agree.has(s.id)) return;
          s.wr = false;
          const st = (w) => { if (w && (w.rec || w.recOff)) w.wr = false; };
          st(s.when); (s.branches || []).forEach((b) => st(b.when));
        });
      } else if (RT.written && mode === undefined) out.push("record.json written: " + fl + " names " + wid + ", which isn't a step of flow " + fl);
      /* E1 fix 3 (lock-A36 M1): steps after the write step in page order that still run before the booking is written (the
         write step's [Taken a moment ago]: its offer and its "nothing booked" end; not the re-write, A6-12). record.json
         "unwritten": { "A": [ids], "B": [ids] }, default A6-11, A6-13 / B6-11, B6-12; each named took step gets "wr": false
         (and its own and branches' whens naming record facts); an id the part doesn't hold: nothing */
      const UD = { A: ["A6-11", "A6-13"], B: ["B6-11", "B6-12"] }, uw = RT.unwritten && typeof RT.unwritten === "object" && !Array.isArray(RT.unwritten) ? (RT.unwritten[fl] || []) : UD[fl];
      if (Array.isArray(uw) && uw.length) {
        const seenU = new Set();
        eachStep(steps, (s) => {
          if (!uw.includes(s.id) || s.took !== fl) return;
          seenU.add(s.id);
          if (s.wr !== undefined) return;
          s.wr = false;
          const st = (w) => { if (w && (w.rec || w.recOff)) w.wr = false; };
          st(s.when); (s.branches || []).forEach((b) => st(b.when));
        });
        if (RT.unwritten && mode === undefined) uw.filter((id) => !seenU.has(id)).forEach((id) => out.push("record.json unwritten: " + fl + " names " + id + ", which isn't a took step of flow " + fl));
      }
    }
  }
  return out;
}
/* does header.json give the stamps stampFlow writes for flow fl? (took, layerLines, amounts; tools J: the record) */
const headerStamps = (head, fl) => !!head && (!!(head.took && head.took[fl]) || Array.isArray(head.layerLines) || !!(head.flows && head.flows[fl] && head.flows[fl].amounts) || !!(head.timed && head.timed[fl]) || head.record === true);
/* problems with header.json's took and layerLines */
function headerLayerProblems(head) {
  const p = [];
  if (head.took !== undefined) {
    if (!head.took || typeof head.took !== "object" || Array.isArray(head.took)) p.push("header took must be { \"A\": \"<money step id>\", \"B\": \"<money step id>\" }");
    else Object.keys(head.took).forEach((f) => { if (!["A", "B"].includes(f)) p.push("header took: flows are A and B"); else if (!/^[AB]\d+-\d{2,3}$/.test(String(head.took[f]))) p.push("header took." + f + " must name a step id, like A5-04"); });
  }
  /* tools F (T3) */
  if (head.timed !== undefined) {
    if (!head.timed || typeof head.timed !== "object" || Array.isArray(head.timed)) p.push("header timed must be { \"B\": \"<the step where the timing is decided>\" }");
    else Object.keys(head.timed).forEach((f) => { if (!["A", "B"].includes(f)) p.push("header timed: flows are A and B"); else if (!/^[AB]\d+-\d{2,3}$/.test(String(head.timed[f]))) p.push("header timed." + f + " must name a step id, like B4-16"); });
  }
  if (head.layerLines !== undefined) {
    if (!Array.isArray(head.layerLines)) p.push("header layerLines must be a list");
    else head.layerLines.forEach((x, i) => {
      const w = "header layerLines " + (i + 1) + (x && x.id ? " (" + x.id + ")" : "") + ": ";
      if (!x || typeof x !== "object") { p.push(w + "must be an object"); return; }
      if (!x.id || !CORE.NAME.test(x.id)) p.push(w + "needs an id (lowercase letters and digits)");
      if (typeof x.line !== "string" || !x.line.trim()) p.push(w + "needs a line");
      else { const t = x.line.replace(/<way>/g, "by text"), sc = scoreText(t); if (sc.length) p.push(w + "plain words: " + sc.join("; ")); if (t.length > 160) p.push(w + "a line of " + t.length + " characters (keep it under 160)"); }
      if (x.to !== undefined && (!Array.isArray(x.to) || x.to.some((a) => !ACTORS.includes(a)))) p.push(w + "to must list people (" + ACTORS.join(", ") + ")");
      if (x.when !== undefined) { if (!x.when || typeof x.when !== "object") p.push(w + "when must be an object"); else Object.keys(x.when).forEach((d) => { if (d === "booking") (x.when.booking || []).forEach((v) => { if (!CORE.GROUP_OF[v]) p.push(w + "when.booking: no booking choice '" + v + "'"); }); else if (!DIMS[d] && !CORE.GATES.includes(d)) p.push(w + "when: unknown choice '" + d + "'"); }); }
      if (/<way>/.test(x.line || "") && (!x.way || typeof x.way !== "object")) p.push(w + "the line says <way>: give \"way\": { \"texts\": \"by text\", \"callsonly\": \"by phone call\", ... }");
      if (x.way) Object.keys(x.way).forEach((v) => { if (v !== "*" && CORE.GROUP_OF[v] !== "reach") p.push(w + "way: '" + v + "' isn't a reach value"); });
      if (x.sections !== undefined && !(Array.isArray(x.sections) && x.sections.length === 2 && x.sections.every((n) => Number.isInteger(n) && n >= 1 && n <= 13))) p.push(w + "sections must be [from, to], like [3, 12]");
    });
  }
  return p;
}
/* Tools G: each header layer line as it reads on every "way" (each way value filled in), checked like the line itself
   (plain words, under 160 characters): headerLayerProblems reads it only with "by text". A failure names the way. Only
   lines that read differently from the "by text" reading are checked here (that one is headerLayerProblems'). build-master
   counts these as errors (the header is joined there); check-part prints them as warnings (the header isn't the part's). */
function headerWayProblems(head) {
  const p = [];
  if (!head || !Array.isArray(head.layerLines)) return p;
  head.layerLines.forEach((x, i) => {
    if (!x || typeof x !== "object" || typeof x.line !== "string" || !/<way>/.test(x.line) || !x.way || typeof x.way !== "object") return;
    const w = "header layerLines " + (i + 1) + (x.id ? " (" + x.id + ")" : "") + ": ", seen = new Set([x.line.replace(/<way>/g, "by text")]);
    Object.keys(x.way).forEach((k) => {
      const t = CORE.layerLineText({ line: x.line, way: { "*": String(x.way[k]) } }, null);
      if (seen.has(t)) return; seen.add(t);
      const sc = scoreText(t);
      if (sc.length) p.push(w + "plain words (way " + k + "): " + sc.join("; "));
      if (t.length > 160) p.push(w + "a line of " + t.length + " characters (way " + k + ") (keep it under 160)");
    });
  });
  return p;
}
/* ---------------------------------------------------------------- Tools D (DESIGN.md 9.2) */
/* every step a path shows, in page order (lit steps, every lit branch): fn(step, holder split or null) */
function litSteps(steps, c, fn) {
  /* Tools G: once a branch has "sets", fn(step, the path as it reads there) for each path a step is reached with */
  if (process.env.S2F_SETS_WALK === "1" || CORE.setsScopes(steps).length) { CORE.walkSets(steps, c, (s, p, trail, b) => { if (!b) fn(s, p); }, { off: true }); return; }
  const go = (ss) => (ss || []).forEach((s) => {
    if (s.off || (s.when && !lit(s.when, c))) return;
    fn(s);
    (s.branches || []).forEach((b) => { if (!b.off && lit(b.when, c)) go(b.steps); });
  });
  go(steps);
}
/* #3 the empty-family check: a split whose branches ALL carry a `when`, at least one of them a plug-in gate (a family
   whose cases only some work has), must light a branch for every kind of work that reaches it. Tried over every set of
   the facts its cases and the gates above it name (no facts list too), every set of the switches they name, every value
   of the booking groups and every money path they name (sampled past 12 facts or 6 switches). Returns problems as text,
   each with the union gate to give the family's parent branch when every case is fact-gated. */
/* Tools E (Oct 26): which booking values a kind of work can have. The first booking choice split of a group in page
   order (every branch chooses values of that one group: the setter, A4-98 for approval) offers each value only to work
   its branch's plug-in gates (and the gates above it) let through, so a fact gate on a setter's branch (A4-98 'An expert
   reads the answers' with "pf": ["screening"]) takes the value out of the walk for work without the fact, the way a
   profession's off op or money.<flow>.booking does (overlay-core bookingFromSplits). Later splits on the group only read
   it: they must light a branch for every work the setter offers the value to (emptyFamilies still checks them).
   Returns { group: { value: [[gates], ...] } } for the groups whose setter gates a branch; offeredTo() is true when some
   offering branch is lit for the work. A value another value implies (privacy private from notsafe, taken nothing from
   calls only) can come without a split: always offered. */
function bookingOffers(steps) {
  const out = {}, seen = new Set();
  const gatesOnly = (ws) => ws.map((w) => CORE.gatesOf(w)).filter(Boolean);
  const go = (ss, anc) => (ss || []).forEach((s) => {
    const ancS = s.when ? anc.concat([s.when]) : anc, bs = s.branches || [];
    let g = null;
    const choice = s.type === "split" && bs.length > 1 && bs.every((b) => b.when && Array.isArray(b.when.booking) && b.when.booking.length && b.when.booking.every((v) => { const gv = CORE.GROUP_OF[v]; if (!gv) return false; if (g === null) g = gv; return gv === g; }));
    if (choice && g && !seen.has(g)) { seen.add(g); bs.forEach((b) => b.when.booking.forEach((v) => { ((out[g] = out[g] || {})[v] = out[g][v] || []).push(gatesOnly(ancS.concat([b.when]))); })); }
    bs.forEach((b) => go(b.steps, b.when ? ancS.concat([b.when]) : ancS));
  });
  go(steps, []);
  /* only the groups where some offering branch is gated change anything */
  Object.keys(out).forEach((g) => { if (!Object.values(out[g]).some((xs) => xs.some((gs) => gs.length))) delete out[g]; });
  return out;
}
function offeredTo(offers, g, v, c, read) {
  if (!offers[g]) return true;
  /* (Tools F: a value implied by a late value, timing sentnow by times line, comes only where the late value is walked
     (read) and offered to the work; the others, implied by a value always walked, are always offered, as before) */
  if (CORE.IMPLIED && CORE.IMPLIED[g] && Object.keys(CORE.IMPLIES || {}).some((h) => Object.keys(CORE.IMPLIES[h]).some((hv) => CORE.IMPLIES[h][hv][g] === v && (!(CORE.LATE_VALUES || {})[hv] || (!!read && !!read[hv] && offeredTo(offers, h, hv, c, read)))))) return true;
  return (offers[g][v] || []).some((gs) => gs.every((w) => lit(w, c)));
}
function emptyFamilies(steps, fl) {
  const out = [], CS = combos(fl, { free: true }), FACTD = ["pf", "factOn", "factOff"], OFFERS = bookingOffers(steps), READ = CORE.valuesRead(steps);
  const go = (ss, anc, parent) => (ss || []).forEach((s) => {
    const ancS = s.when ? anc.concat([s.when]) : anc;
    const bs = s.branches || [];
    if (s.type === "split" && bs.length > 1 && bs.every((b) => b.when && Object.keys(b.when).some((d) => d !== "took")) && bs.some((b) => Object.keys(b.when).some((d) => CORE.GATES.includes(d)))) {
      const ws = ancS.concat(bs.map((b) => b.when)), facts = new Set(), sws = new Set(), groups = new Set(), money = new Set();
      ws.forEach((w) => Object.keys(w).forEach((d) => {
        if (FACTD.includes(d)) (w[d] || []).forEach((f) => facts.add(f));
        else if (d === "switchOn" || d === "switchOff") (w[d] || []).forEach((n) => sws.add(n));
        else if (d === "booking") CORE.bookingGroups(w.booking).forEach((g) => groups.add(g));
        else if (DIMS[d]) money.add(d);
      }));
      /* tools E: the facts and switches the setter's gates name for these groups: a work the setter offers a value to */
      [...groups].forEach((g) => Object.values(OFFERS[g] || {}).forEach((xs) => xs.forEach((gs) => gs.forEach((w) => Object.keys(w).forEach((d) => {
        if (FACTD.includes(d)) (w[d] || []).forEach((f) => facts.add(f)); else if (d === "switchOn" || d === "switchOff") (w[d] || []).forEach((n) => sws.add(n));
      })))));
      const F = [...facts], W = [...sws], G = [...groups], M = [...money];
      const fsets = [null];
      if (F.length <= 12) { for (let m = 0; m < (1 << F.length); m++) fsets.push(F.filter((x, i) => m & (1 << i))); }
      else { fsets.push([], F.slice()); F.forEach((f) => { fsets.push([f]); fsets.push(F.filter((x) => x !== f)); }); }
      const wsets = [];
      if (W.length <= 6) { for (let m = 0; m < (1 << W.length); m++) wsets.push(W.filter((x, i) => m & (1 << i))); }
      else { wsets.push([], W.slice()); W.forEach((n) => wsets.push([n])); }
      let bm = [{}];
      G.forEach((g) => { const nx = []; bm.forEach((m) => CORE.groupValues(g, READ).forEach((v) => nx.push(Object.assign({}, m, { [g]: v })))); bm = nx; });
      const seen = new Map(); (M.length ? CS : CS.slice(0, 1)).forEach((c) => { const k = M.map((d) => c[d]).join("|"); if (!seen.has(k)) seen.set(k, c); });
      let bad = null;
      outer: for (const c0 of seen.values()) for (const b of bm) for (const wset of wsets) for (const fset of fsets) {
        const c = Object.assign({}, c0, { booking: b, pf: Object.fromEntries(wset.map((x) => [x, true])), facts: fset });
        if (!ancS.every((w) => lit(w, c))) continue;
        /* tools E: a booking value this work is never offered (its choice branch is gated out) isn't walked for it, as
           long as the work is offered some value of that group (else the setter itself is empty: still an error) */
        if (G.some((g) => !offeredTo(OFFERS, g, b[g], c, READ) && CORE.groupValues(g, READ).some((v) => offeredTo(OFFERS, g, v, c, READ)))) continue;
        if (!bs.some((br) => lit(br.when, c))) { bad = { c, fset, wset, b }; break outer; }
      }
      if (bad) {
        const how = [bad.fset ? (bad.fset.length ? "work with only the facts " + bad.fset.join(", ") : "work with none of its facts") : "", bad.wset.length ? "the switch" + (bad.wset.length > 1 ? "es " : " ") + bad.wset.join(" + ") + " on" : "", Object.keys(bad.b).length ? "booking " + Object.values(bad.b).join(" + ") : "", M.length ? comboKey(bad.c) : ""].filter(Boolean).join(", ");
        const allPf = bs.every((b) => Object.keys(b.when).every((d) => d === "pf" || d === "factOn" || d === "took"));
        const union = allPf ? [...new Set([].concat(...bs.map((b) => [].concat(b.when.pf || [], b.when.factOn || []))))] : null;
        out.push((fl ? fl + ":" : "") + s.id + ": the family '" + s.q + "' can be left with no lit branch (" + (how || "every setting") + "): " + (union ? "give its parent branch" + (parent ? " ('" + parent.label + "')" : "") + " the union of its cases' gates, \"when\": { \"pf\": " + JSON.stringify(union) + " }" : "give its parent branch a gate that holds only where some case is lit, or add a case that always shows"));
      }
    }
    bs.forEach((b) => go(b.steps, b.when ? ancS.concat([b.when]) : ancS, b));
  });
  go(steps, [], null);
  return out;
}
/* #6 the opt-out line once (D61, STATE C5): does any message (or variant) use the conditional element "stop": "first"? */
const usesStopFirst = (steps) => JSON.stringify(steps).indexOf('"stop":"first"') >= 0;
/* checks on every path given, once a flow uses "stop": "first": the first text each number gets must carry the line
   (stop: true or "first"); a "stop": true on a text that isn't the first that number gets on some path breaks D61;
   a "first" that is never the first text on any path can go. Returns { errors, warnings, infos } as text. */
function stopChecks(steps, fl, paths, known, names) {
  const out = { errors: [], warnings: [], infos: [] };
  if (!usesStopFirst(steps)) return out;
  const miss = new Map(), extra = new Map(), firstEver = new Set(), firsts = new Set();
  const note = (m, k, c) => { const x = m.get(k) || { n: 0, path: pathKey(c) }; x.n++; m.set(k, x); };
  /* each money path with each booking value alone (no mixes, switches or fact settings: they rarely change who is
     texted first, and every path would be a whole walk) */
  paths.filter((c) => !isMix(c) && !(c.pf && Object.keys(c.pf).length) && !c.facts).forEach((c) => {
    const F = CORE.firstTexts(steps, c, { known: known || null, names: names || null });
    Object.keys(F).forEach((id) => Object.keys(F[id]).forEach((i) => {
      const r = F[id][i], k = id + "|" + i + "|" + r.to;
      if (r.stop === "first") firsts.add(k);
      if (r.first) firstEver.add(k);
      if (r.first && !r.stop) note(miss, k, c);
      if (r.later && r.stop === true) note(extra, k, c);
    }));
  });
  const nm = (k) => { const [id, i, to] = k.split("|"); return (fl ? fl + ":" : "") + id + " message " + (+i + 1) + " (to " + to.replace(":", " ") + ")"; };
  miss.forEach((x, k) => out.errors.push(nm(k) + " is the first text this number gets on " + x.n + " path(s), like " + x.path + ", with no opt-out line: add \"stop\": \"first\" (D61)"));
  extra.forEach((x, k) => out.warnings.push(nm(k) + " has \"stop\": true but isn't the first text this number gets on " + x.n + " path(s), like " + x.path + ": use \"stop\": \"first\" (D61: the line goes only on a number's first text)"));
  firsts.forEach((k) => { if (!firstEver.has(k)) out.infos.push(nm(k) + " has \"stop\": \"first\" but is never the first text on any path walked: it can go"); });
  return out;
}
/* #7 amount slots: on every path given, an amount slot the path shows must get an amount (the step's table or its
   example words). Only for steps with amount slots. Returns problems as text. */
function amountChecks(steps, fl, paths) {
  const out = new Map();
  if (JSON.stringify(steps).search(CORE.AMOUNT_RE) < 0 && !(CORE.recordOn && CORE.recordOn())) return [];
  paths.forEach((c0) => litSteps(steps, c0, (s, c1) => {
    if (!CORE.amountsIn(s) && !s.rec) return; /* (tools J: a step with record slots, whose rows may hold amounts) */
    const c = c1 || c0, w = resolveVary(s, c).step, left = JSON.stringify([w.title, w.does, w.more, w.say, w.rule, w.form, w.table]).match(new RegExp(CORE.AMOUNT_RE.source, "g"));
    if (left) left.forEach((m) => { const k = s.id + "|" + m; if (!out.has(k)) out.set(k, pathKey(c)); });
  }));
  return [...out].map(([k, p]) => { const [id, m] = k.split("|"); return (fl ? fl + ":" : "") + id + ": the amount slot " + m + " has no amount on the path " + p + " (and no example words): add it to header.json flows." + (fl || "<flow>") + ".amounts, or write it like {{" + m.replace(/[{}\s]/g, "").split(":")[0] + ":$40}}"; });
}
/* the --amounts report: steps whose money variants pass the five before: choices, and how many stay distinct once the
   dollar amounts are set aside (what amount slots would leave: DESIGN 9.2 #7) */
function moneyKeyReport(steps, fl) {
  const out = [];
  eachStep(steps, (s) => {
    const ks = Object.keys(s.vary || {}).filter((k) => { const cd = parseVaryKey(k); return cd && !CORE.isLayer(cd); });
    if (ks.length <= 5) return;
    const norm = new Set(ks.map((k) => JSON.stringify(s.vary[k]).replace(/\$\d[\d,]*(?:\.\d\d)?/g, "$N")));
    out.push((fl ? fl + ":" : "") + s.id + " has " + ks.length + " money variants; " + norm.size + " stay different once the amounts are set aside" + (norm.size <= 5 ? " (amount slots would leave at most its five before: variants)" : ""));
  });
  return out;
}
/* Tools F (T3): the time slots ({{arrive}}, {{window}}, {{cutoff}}, {{day}}) on steps stamped "timing" (after the step the
   header's "timed" names) that read default words on sent-now and live-line paths, one line each, for check-part --timed
   and build-master --timed: where the default doesn't fit the sentence, the slot takes its own words after "|" */
function timedSlotReport(steps, fl) {
  const out = [];
  eachStep(steps, (s) => {
    if (!s.timing) return;
    const seen = new Set();
    CORE.stepTexts(s).forEach(([where, t]) => {
      const re = new RegExp(CORE.SLOT_RE.source, "g"); let m;
      while ((m = re.exec(t))) {
        if (!["arrive", "window", "cutoff", "day"].includes(m[1]) || m[3] !== undefined || seen.has(m[0])) continue;
        seen.add(m[0]);
        const a = CORE.timedAlt(m[1]);
        out.push(fl + ":" + s.id + " " + m[0] + " (" + where + ") reads '" + a[0] + "' when sent now" + (a[1] !== a[0] ? ", '" + a[1] + "' on a live line" : "") + ": where that doesn't fit the sentence, give it its own words after '|'");
      }
    });
  });
  return out;
}
/* ---------------------------------------------------------------- tools H: the D66 money ways (TL-1) and notsafe (TL-2) */
const WHY_HOLD = "D66 #3: no hold", WHY_REST = "D66 #7: no rest charged later", WAYS_MEMO = new Map();
const MONEY_D = ["price", "before", "after"];
/* why the money part of a key or a `when` (conds: { price?, before?, after? }) can't be on the ways W: names a way they
   leave out (hold), or fits only money paths they remove (a deposit with nothing after); null when fine */
function waysWhy(fl, conds, W) {
  if (!conds || !MONEY_D.some((d) => conds[d])) return null;
  const off = (conds.before || []).filter((b) => !W.before.includes(b));
  if (off.length) return off.includes("hold") ? WHY_HOLD : "D66: the header's ways leave out money before '" + off.join("', '") + "'";
  const fits = (c) => MONEY_D.every((d) => !conds[d] || conds[d].includes(c[d]));
  const mk = fl + JSON.stringify(W), C2 = WAYS_MEMO.get(mk) || WAYS_MEMO.set(mk, [combos(fl, { free: true, ways: null }), combos(fl, { free: true, ways: W })]).get(mk);
  const old = C2[0].filter(fits);
  if (!old.length || C2[1].some(fits)) return null;
  return old.every((c) => c.before === "deposit" && c.after === "none") ? WHY_REST : "D66: it fits only money paths the header's ways leave out (" + old.map(comboKey).join(", ") + ")";
}
const moneyPart = (cd) => { const x = {}; MONEY_D.forEach((d) => { if (cd && cd[d]) x[d] = cd[d]; }); return x; };
const HOLD_SLOT = /\{\{\s*hold\s*(?::[^}]*)?\}\}/;
/* every vary key, step `when` and branch `when` (whenIn too) of a flow's steps that the header's ways rule out, every
   {{hold}} slot once hold is out, and (restLater false) every "after:none" key that fits no path where its step is lit:
   it can only follow a deposit there. paths: the walked paths (for the last check). Errors as text; none without ways. */
function waysProblems(steps, fl, paths, where) {
  const W = CORE.ways();
  if (!W) return [];
  const out = [], w0 = where || "", cand = new Map();
  const say = (m) => { if (!out.includes(m)) out.push(m); };
  eachStep(steps, (s) => {
    if (s.only && s.only !== fl) return;
    Object.keys(s.vary || {}).forEach((k) => {
      const cd = parseVaryKey(k), why = cd ? waysWhy(fl, moneyPart(cd), W) : null;
      if (why) say(w0 + s.id + " vary '" + k + "': " + why + ": delete it (or move its words to a way that stays)");
      else if (cd && !W.restLater && (cd.after || []).includes("none") && !cd.before && !cd.price) { const x = cand.get(s.id) || { s, ks: [], fit: new Set(), lit: false }; x.ks.push(k); cand.set(s.id, x); }
    });
    if (s.when) { const why = waysWhy(fl, moneyPart(s.when), W); if (why) say(w0 + s.id + ": its own 'when' " + JSON.stringify(moneyPart(s.when)) + ": " + why + ": take that part out (or the step, if only that path had it)"); }
    (s.branches || []).forEach((b) => [["when", b.when]].concat(Object.keys(b.whenIn || {}).filter((f) => f === fl).map((f) => ["whenIn." + f, b.whenIn[f]])).forEach(([n, w]) => {
      const why = w ? waysWhy(fl, moneyPart(w), W) : null;
      if (why) say(w0 + s.id + " branch '" + b.label + "' " + n + " " + JSON.stringify(moneyPart(w)) + ": " + why + ": take that part out, or remove the branch (a MOVES.md line)");
    }));
    if (!W.before.includes("hold")) { const t = JSON.stringify([s.title, s.does, s.more, s.say, s.rule, s.form, s.table, s.vary, s.q, (s.branches || []).map((b) => [b.label, b.endText])]); const m = HOLD_SLOT.exec(t); if (m) say(w0 + s.id + ": the amount slot " + m[0] + " names a hold (" + WHY_HOLD + "): reword it as a card saved, or remove it"); }
  });
  if (cand.size && paths && paths.length) {
    paths.forEach((c) => litSteps(steps, c, (s, p) => {
      const x = cand.get(s.id); if (!x) return;
      x.lit = true;
      const pc = s.took ? CORE.tookPath(p || c, s.took) : (p || c);
      x.ks.forEach((k) => { if (keyFits(moneyPart(parseVaryKey(k)), pc)) x.fit.add(k); });
    }));
    cand.forEach((x) => { if (x.lit) x.ks.filter((k) => !x.fit.has(k)).forEach((k) => say(w0 + x.s.id + " vary '" + k + "': " + WHY_REST + ": 'after:none' fits no money path where this step is lit (here it only follows a deposit, whose rest is paid at the visit or on the bill): delete it")); });
  }
  return out;
}
/* the header's ways block, and its amounts rows and examples for money paths the ways remove (build-master: errors;
   check-part: warnings, the header being the main session's) */
function waysHeaderProblems(head) {
  if (!head || head.ways === undefined) return [];
  const out = [], w = head.ways;
  if (!w || typeof w !== "object" || Array.isArray(w)) return ["header ways must be { \"before\": [\"none\", \"card\", \"deposit\", \"full\"], \"restLater\": false }"];
  Object.keys(w).forEach((k) => { if (!["before", "restLater"].includes(k)) out.push("header ways: unknown field '" + k + "' (before, restLater)"); });
  if (w.before !== undefined && (!Array.isArray(w.before) || !w.before.length || w.before.some((b) => !CORE.BEFORE_WAYS.includes(b)))) out.push("header ways.before must list money-before ways from " + CORE.BEFORE_WAYS.join(", "));
  else if (Array.isArray(w.before) && !w.before.includes("none")) out.push("header ways.before must keep 'none' (nothing taken)");
  if (w.restLater !== undefined && typeof w.restLater !== "boolean") out.push("header ways.restLater must be true or false");
  if (out.length) return out;
  const W = CORE.normWays(w);
  ["A", "B"].forEach((fl) => {
    const H = (head.flows || {})[fl] || {}, all = combos(fl, { free: true, ways: null }), now = combos(fl, { free: true, ways: W });
    Object.keys(H.amounts || {}).forEach((k) => {
      if (k === "*") return;
      const p = k.split("|"); if (p.length !== 3) return;
      const m = (c) => MONEY_D.every((d, i) => p[i] === "*" || p[i] === c[d]);
      if (p[1] !== "*" && !W.before.includes(p[1])) out.push("header flows." + fl + ".amounts row '" + k + "': " + (p[1] === "hold" ? WHY_HOLD : "D66: the header's ways leave out '" + p[1] + "'") + ": delete the row");
      else if (all.some(m) && !now.some(m)) out.push("header flows." + fl + ".amounts row '" + k + "': " + (all.filter(m).every((c) => c.before === "deposit" && c.after === "none") ? WHY_REST : "D66: no money path of the header's ways") + ": delete the row");
    });
    Object.keys(H.examples || {}).forEach((k) => {
      const p = k.split("|"), c = { price: p[0], before: p[1], after: p[2] };
      if (p.length === 3 && validCombo(fl, c, null) && !validCombo(fl, c, W)) out.push("header flows." + fl + ".examples '" + k + "': " + (c.before === "hold" ? WHY_HOLD : c.before === "deposit" && c.after === "none" ? WHY_REST : "D66: not a money path of the header's ways") + ": delete it");
    });
  });
  return out;
}
/* tools H (TL-2, D66 #6, D67): with the ways, reach notsafe ("stopped for safety") is set only by a branch's sets (A7-97 /
   B7-94 [Says their phone isn't safe now]): a vary key, a step `when` or a branch `when` naming it outside every sets
   scope that sets it (the branch's own steps and, once it rejoins, the steps after it) can never show; the reach card
   (a split whose branches all choose reach) must not offer it. opts.allAfter: the part sits wholly after the change
   (S1113, checked alone): nothing to check. Errors as text. */
function notsafeProblems(steps, fl, where, opts) {
  if (!CORE.ways() || (opts && opts.allAfter) || (CORE.d75 && CORE.d75())) return [];
  const out = [], w0 = where || "", ok = new Set(), names = (vals) => (vals || []).includes("notsafe");
  CORE.setsScopes(steps).filter((x) => x.sets && x.sets.reach === "notsafe").forEach((x) => x.own.concat(x.after).forEach((id) => ok.add(id)));
  const WHY = "D66 #6: a number is stopped for safety only by a branch's sets after booking (A7-97 / B7-94 [Says their phone isn't safe now])";
  eachStep(steps, (s) => {
    if ((s.only && s.only !== fl) || ok.has(s.id)) return;
    Object.keys(s.vary || {}).forEach((k) => { if (names(CORE.keyBookings(k))) out.push(w0 + s.id + " vary '" + k + "': " + WHY + ", so this can never show here: delete it"); });
    if (s.when && names(s.when.booking)) out.push(w0 + s.id + ": its own 'when' names notsafe: " + WHY + ", so this step can never show here");
    const bs = s.branches || [], card = s.type === "split" && bs.length > 1 && bs.every((b) => b.when && Array.isArray(b.when.booking) && b.when.booking.length && b.when.booking.every((v) => CORE.GROUP_OF[v] === "reach"));
    bs.forEach((b) => [b.when].concat(Object.keys(b.whenIn || {}).filter((f) => f === fl).map((f) => b.whenIn[f])).forEach((w) => {
      if (!w || !names(w.booking)) return;
      out.push(w0 + s.id + " branch '" + b.label + "': " + (card ? "D66 #6: the reach card doesn't offer it (" + WHY.slice(8) + "): remove the branch (a MOVES.md line)" : WHY + ", so this branch can never light here"));
    }));
  });
  return out.filter((x, i, a) => a.indexOf(x) === i);
}
/* ---------------------------------------------------------------- tools I part 2: D73, several services (TF-4) */
/* severalPath(fl, list, ways) -> { path: { price, before, after } | null, services, why, problems }. list: money paths
   ("list|full|none" or { price, before, after }), and "credit" for a service paid by a credit (left out). */
function severalPath(fl, list, ways) {
  const W = ways === undefined ? CORE.ways() : ways, problems = [], services = [];
  let credits = 0;
  (Array.isArray(list) ? list : String(list || "").split(",")).forEach((x) => {
    if (typeof x === "string" && x.trim().toLowerCase() === "credit") { credits++; return; }
    const p = typeof x === "string" ? x.trim().split("|") : [x.price, x.before, x.after];
    const c = { price: p[0], before: p[1], after: p[2] };
    if (p.length !== 3 || !validCombo(fl, c, W)) { problems.push("'" + (typeof x === "string" ? x.trim() : comboKey(c)) + "' isn't a money path of flow " + fl); return; }
    services.push(c);
  });
  if (!services.length) { problems.push(credits ? "only services paid by a credit: there is no paid part to read (D73)" : "no money path given"); return { path: null, services, why: [], problems }; }
  const why = [];
  if (credits) why.push(credits + " paid by a credit: left out (the paid part's path)");
  const paid = services.filter((c) => !isFree(c));
  if (paid.length < services.length) why.push((services.length - paid.length) + " free: adds nothing" + (paid.length ? "" : " (all free)"));
  const S = paid.length ? paid : services;
  const price = S.some((c) => c.price === "visit") ? "visit" : S.some((c) => c.price === "photos") ? "photos" : "list";
  let before;
  if (S.every((c) => c.before === "full")) before = "full";
  else if (S.some((c) => c.before === "full" || c.before === "deposit")) before = "deposit";
  else if (S.some((c) => c.before === "card" || c.before === "hold")) before = "card";
  else before = "none";
  const afters = [...new Set(S.filter((c) => c.before !== "full").map((c) => c.after))];
  const after = !afters.length ? "none" : afters.length === 1 ? afters[0] : (fl === "A" ? "counter" : "bill");
  why.push("before " + before + (before === "full" ? " (every service paid in full now)" : before === "deposit" ? " (something due now, something left)" : before === "card" ? " (nothing due now; a card for a service)" : " (nothing due now, no card)"));
  why.push("after " + after + (afters.length > 1 ? " (the after-ways differ: " + afters.join(", ") + ")" : afters.length ? "" : " (all paid now)"));
  why.push("price " + price);
  const path = { price, before, after };
  if (!validCombo(fl, path, W)) { problems.push("D73 reads " + comboKey(path) + ", which isn't a money path of flow " + fl); return { path: null, services, why, problems }; }
  return { path, services, why, problems };
}
/* the paths again with each header switch (flow or header "switches") that a step or branch `when` names turned on, so
   a walk reads both of its branches (tools I, TF-5: readlater); [] when no `when` names one */
function switchWalkPaths(paths, steps, extra) {
  const names = Object.keys(extra || {}), gated = new Set();
  if (!names.length) return [];
  eachStep(steps, (s) => [s.when].concat((s.branches || []).map((b) => b.when)).forEach((w) => { if (w) (w.switchOn || []).concat(w.switchOff || []).forEach((n) => { if (names.includes(n)) gated.add(n); }); }));
  const out = [];
  [...gated].sort().forEach((n) => paths.forEach((c) => { if (!(c.pf && c.pf[n])) out.push(Object.assign({}, c, { pf: Object.assign({}, c.pf || {}, { [n]: true }) })); }));
  return out;
}
/* ---------------------------------------------------------------- tools I: D75, no not-safe mode (TF-1) */
const WHY_D75 = "D75: no not-safe mode; use the change of where updates go (A7-98 / B7-88)";
const namesNotsafe = (vals) => Array.isArray(vals) && vals.includes("notsafe");
/* with CORE.d75() (header "d75": true): every vary key naming booking notsafe, every `when.booking` naming it (a step's
   own, a branch's when and its whenIn for this flow) and every branch sets reach notsafe, wherever it sits (before or
   after a change: on the D75 master nothing sets it, so it can never show). Errors as text; none without d75. */
function d75Problems(steps, fl, where) {
  if (!(CORE.d75 && CORE.d75())) return [];
  const out = [], w0 = where || "", say = (m) => { if (!out.includes(m)) out.push(m); };
  eachStep(steps, (s) => {
    if (s.only && s.only !== fl) return;
    Object.keys(s.vary || {}).forEach((k) => { if (namesNotsafe(CORE.keyBookings(k))) say(w0 + s.id + " vary '" + k + "': " + WHY_D75 + ": delete it"); });
    if (s.when && namesNotsafe(s.when.booking)) say(w0 + s.id + ": its own 'when' names notsafe: " + WHY_D75 + ": take that part out (or the step)");
    (s.branches || []).forEach((b) => {
      [["when", b.when]].concat(Object.keys(b.whenIn || {}).filter((f) => f === fl).map((f) => ["whenIn." + f, b.whenIn[f]])).forEach(([n, w]) => {
        if (w && namesNotsafe(w.booking)) say(w0 + s.id + " branch '" + b.label + "' " + n + " names notsafe: " + WHY_D75 + ": take that part out, or remove the branch (a MOVES.md line)");
      });
      if (b.sets && typeof b.sets === "object" && b.sets.reach === "notsafe") say(w0 + s.id + " branch '" + b.label + "' sets reach notsafe: " + WHY_D75 + ": take the sets out (the branch moves or goes by a MOVES.md line)");
    });
  });
  return out;
}
/* the header's "d75" (true, false or left out), and with it on, layer lines that still name notsafe (build-master:
   errors; check-part: warnings, the header being the main session's) */
function d75HeaderProblems(head) {
  if (!head || head.d75 === undefined) return [];
  if (typeof head.d75 !== "boolean") return ["header d75 must be true (D75: no not-safe mode) or false, or left out"];
  if (!head.d75) return [];
  const out = [];
  (Array.isArray(head.layerLines) ? head.layerLines : []).forEach((x, i) => {
    if (!x || typeof x !== "object") return;
    const w = "header layerLines " + (i + 1) + (x.id ? " (" + x.id + ")" : "") + ": ";
    if (x.when && namesNotsafe(x.when.booking)) out.push(w + "its when names notsafe: " + WHY_D75 + ": delete the line");
    if (x.way && typeof x.way === "object" && Object.prototype.hasOwnProperty.call(x.way, "notsafe")) out.push(w + "its way 'notsafe': " + WHY_D75 + ": delete that way");
  });
  return out;
}
/* where a profession's overlay names reach notsafe: a vary key (booking:notsafe, joined or not), a booking list (a
   `when`, money.<flow>.booking.reach) or a sets. ["A ops[3] (words A6-14) vary 'booking:notsafe'", ...] */
function d75OverlayPlaces(ov) {
  const out = [], seen = new Set();
  const add = (x) => { if (!seen.has(x)) { seen.add(x); out.push(x); } };
  const go = (x, where) => {
    if (Array.isArray(x)) { x.forEach((y, i) => go(y, where + "[" + i + "]")); return; }
    if (!x || typeof x !== "object") return;
    Object.keys(x).forEach((k) => {
      const v = x[k], at = where + (where ? "." : "") + k;
      if (k === "vary" && v && typeof v === "object" && !Array.isArray(v)) Object.keys(v).forEach((vk) => { if (namesNotsafe(CORE.keyBookings(vk))) add(where + " vary '" + vk + "'"); });
      if ((k === "booking" || k === "reach") && namesNotsafe(v)) add(at + " lists 'notsafe'");
      if (k === "sets" && v && typeof v === "object" && v.reach === "notsafe") add(at + " sets reach notsafe");
      go(v, at);
    });
  };
  go(ov, "");
  return out;
}
/* ---------------------------------------------------------------- tools J, E1: record.json's check (TOOL-SPEC 8.2) */
const RECORD_KEYS = ["_about", "from", "main", "ways", "slots", "services", "fixtures", "homes", "lint", "onefee", "live", "ledger_rules", "written", "unwritten"];
const RECORD_AMOUNT_NAMES = ["price", "fee", "deposit", "rest", "hold", "paid"];
const RECORD_WHEN_KEYS = ["price", "before", "after", "booking", "rec", "recOff"];
const CAST_SLOTS = ["biz", "pro", "place", "cust", "owner", "ab"];
/* problems with a `when` in record.json (a slot row's): known dims, values, gates and record facts */
function recordWhenProblems(w, where, head) {
  const out = [];
  if (!w || typeof w !== "object" || Array.isArray(w)) return [where + "when must be an object"];
  const ctx = { facts: CORE.factList({ facts: head && head.facts }), switches: CORE.switchList({ switches: head && head.switches }) };
  Object.keys(w).forEach((d) => {
    if (CORE.GATES.includes(d)) gateProblems(w, d, ctx).forEach((p) => out.push(where + p));
    else if (d === "rec" || d === "recOff") recWhenProblems(w, d).forEach((p) => out.push(where + p));
    else if (d === "booking") { if (!Array.isArray(w.booking) || !w.booking.length) out.push(where + "when.booking must be a list"); else w.booking.forEach((v) => { if (!CORE.GROUP_OF[v] && !Object.keys(CORE.EVENT_GROUPS).some((g) => CORE.EVENT_GROUPS[g].values.some((x) => x[0] === v))) out.push(where + "when.booking: no booking choice '" + v + "'"); }); }
    else if (DIMS[d]) { if (!Array.isArray(w[d]) || !w[d].length) out.push(where + "when." + d + " must be a list"); else w[d].forEach((v) => { if (!DIMS[d].some((x) => x.k === v)) out.push(where + "when." + d + ": no choice '" + v + "'"); }); }
    else out.push(where + "when: unknown '" + d + "' (" + RECORD_WHEN_KEYS.concat(CORE.GATES).join(", ") + ")");
  });
  return out;
}
/* recordProblems(record, head) -> problems as text: unknown names (top-level keys, ways, slot names, row whens, record
   facts, services, fixture fields), a ways row naming an unknown amount, a slot with no last row (a row with no when),
   a slot row holding another record slot, a fixture whose services read as no money path of the flow (D73), a main
   path the flow doesn't have. head: header.json (its ways, switches and facts). */
function recordProblems(record, head) {
  const p = [], R = record, W = head && head.ways !== undefined ? head.ways : CORE.ways();
  if (!R || typeof R !== "object" || Array.isArray(R)) return ["record.json must be an object (" + RECORD_KEYS.join(", ") + ")"];
  Object.keys(R).forEach((k) => { if (!RECORD_KEYS.includes(k) && !/^_/.test(k)) p.push("record.json: unknown key '" + k + "' (" + RECORD_KEYS.join(", ") + "; a key starting with _ is a note)"); });
  if (R.ledger_rules !== undefined && typeof R.ledger_rules !== "string") p.push("record.json ledger_rules must be words (the ledger's rules, for readers: the tools hold them)");
  ["A", "B"].forEach((fl) => {
    if (!R.from || typeof R.from !== "object" || typeof R.from[fl] !== "string" || !/^[SAB]\d+-\d{2,3}$/.test(R.from[fl])) p.push("record.json from." + fl + " must name a step id (the first step an event can follow)");
    const mk = R.main && typeof R.main === "object" ? R.main[fl] : undefined;
    if (mk === undefined) p.push("record.json main." + fl + " must name the flow's main money path, like " + (fl === "A" ? "list|card|counter" : "list|card|bill"));
    else { const m = String(mk).split("|"); if (m.length !== 3 || !validCombo(fl, { price: m[0], before: m[1], after: m[2] }, W)) p.push("record.json main." + fl + ": '" + mk + "' isn't a money path of flow " + fl); }
  });
  /* ways: one row per way of paying the header keeps, plus credit */
  const wayNames = (CORE.normWays(W) ? CORE.normWays(W).before : ["none", "card", "hold", "deposit", "full"]).concat(["credit"]);
  if (R.ways !== undefined) {
    if (!R.ways || typeof R.ways !== "object" || Array.isArray(R.ways)) p.push("record.json ways must be an object of rows, like { \"card\": { \"now\": \"0\", \"card\": true, \"keep\": \"fee\", \"back\": \"0\" } }");
    else {
      Object.keys(R.ways).forEach((w) => {
        const row = R.ways[w], at = "record.json ways." + w + ": ";
        if (!wayNames.includes(w)) p.push("record.json ways: no way '" + w + "' (" + wayNames.join(", ") + ")");
        if (!row || typeof row !== "object" || Array.isArray(row)) { p.push(at + "must be an object"); return; }
        /* (TOOL-SPEC change 4: with "onefee", each way names its "fee" (a chain like "fee|deposit": the first known) in
           place of "keep") */
        const kf = R.onefee === true ? "fee" : row.keep !== undefined ? "keep" : "fee";
        Object.keys(row).forEach((f) => { if (!["now", "card", "back", kf].includes(f)) p.push(at + "unknown field '" + f + "' (now, card, " + kf + ", back)"); });
        ["now", kf, "back"].forEach((f) => { const v = row[f]; if (v === undefined) p.push(at + f + " is missing"); else if (!(v === "0" || (typeof v === "string" && v.split("|").every((x) => RECORD_AMOUNT_NAMES.includes(x))) || (v === "credit" && w === "credit"))) p.push(at + f + ": '" + v + "' isn't an amount (\"0\", " + RECORD_AMOUNT_NAMES.join(", ") + ", or a chain like fee|deposit" + (w === "credit" ? ", credit" : "") + ")"); });
        if (!(row.card === true || row.card === false || (row.card === "asis" && w === "credit"))) p.push(at + "card must be true or false" + (w === "credit" ? " or \"asis\"" : ""));
      });
      wayNames.forEach((w) => { if (!R.ways[w]) p.push("record.json ways: no row for '" + w + "'"); });
    }
  }
  /* slots */
  if (R.slots !== undefined) {
    if (!R.slots || typeof R.slots !== "object" || Array.isArray(R.slots)) p.push("record.json slots must be an object");
    else Object.keys(R.slots).forEach((n) => {
      const S = R.slots[n], at = "record.json slots." + n + ": ";
      if (!/^[a-z][a-z0-9]*\.[a-z][a-z0-9]*$/.test(n) || CORE.SLOTS[n]) { p.push("record.json slots: '" + n + "' must be a new name like pay.late (home.name)"); return; }
      if (!S || typeof S !== "object" || Array.isArray(S)) { p.push(at + "must be an object with home, means and rows"); return; }
      Object.keys(S).forEach((k) => { if (!["home", "means", "rows"].includes(k)) p.push(at + "unknown field '" + k + "' (home, means, rows)"); });
      if (typeof S.home !== "string" || !S.home) p.push(at + "home must name the rule's home node, like S13-55");
      if (typeof S.means !== "string" || !S.means) p.push(at + "means must say what the words are");
      if (!Array.isArray(S.rows) || !S.rows.length) { p.push(at + "rows must be a list"); return; }
      S.rows.forEach((r, i) => {
        const rw = at + "row " + (i + 1) + ": ";
        if (!r || typeof r !== "object" || Array.isArray(r)) { p.push(rw + "must be an object { when, text }"); return; }
        Object.keys(r).forEach((k) => { if (!["when", "text"].includes(k)) p.push(rw + "unknown field '" + k + "' (when, text)"); });
        if (typeof r.text !== "string") p.push(rw + "text must be words");
        if (r.when !== undefined) recordWhenProblems(r.when, rw, head).forEach((x) => p.push(x));
        const t = String(r.text || "");
        if (new RegExp(CORE.RECORD_SLOT_RE.source).test(t)) p.push(rw + "holds a record slot: a row's words can't hold another record slot");
        const re = new RegExp(CORE.SLOT_RE.source, "g"); let m;
        while ((m = re.exec(t))) { if (CAST_SLOTS.includes(m[1]) || CORE.LEDGER_AMOUNTS.includes(m[1]) || CORE.AMOUNTS.includes(m[1]) || /\./.test(m[1])) continue; CORE.slotProblems(m[0]).forEach((x) => p.push(rw + x)); }
        const plain = t.replace(new RegExp(CORE.SLOT_RE.source, "g"), (mm, nm, ex) => (ex && ex.trim()) || "$40");
        if (plain.trim()) scoreText(plain).forEach((x) => p.push(rw + "plain words: " + x));
      });
      if (S.rows.length && S.rows[S.rows.length - 1] && S.rows[S.rows.length - 1].when !== undefined) p.push(at + "no last row with no when: add one (the words when no other row fits)");
    });
  }
  /* services */
  const svcs = R.services && typeof R.services === "object" && !Array.isArray(R.services) ? R.services : {};
  if (R.services !== undefined && svcs !== R.services) p.push("record.json services must be an object of services");
  Object.keys(svcs).forEach((id) => {
    const v = svcs[id], at = "record.json services." + id + ": ";
    if (!v || typeof v !== "object") { p.push(at + "must be an object"); return; }
    Object.keys(v).forEach((k) => { if (!["flow", "name", "price", "before", "after", "paidby", "amounts"].includes(k)) p.push(at + "unknown field '" + k + "' (flow, name, price, before, after, paidby, amounts)"); });
    if (!["A", "B"].includes(v.flow)) p.push(at + "flow must be A or B");
    if (typeof v.name !== "string" || !v.name) p.push(at + "needs a name");
    if (v.paidby !== undefined && !["money", "credit"].includes(v.paidby)) p.push(at + "paidby must be money or credit");
    if (["A", "B"].includes(v.flow) && !validCombo(v.flow, { price: v.price, before: v.before, after: v.after }, W)) p.push(at + "'" + [v.price, v.before, v.after].join("|") + "' isn't a money path of flow " + v.flow);
    if (v.amounts !== undefined) { if (!v.amounts || typeof v.amounts !== "object" || Array.isArray(v.amounts)) p.push(at + "amounts must be an object like { \"price\": \"$20\" }"); else Object.keys(v.amounts).forEach((f) => { if (!RECORD_AMOUNT_NAMES.includes(f)) p.push(at + "amounts: no amount '" + f + "' (" + RECORD_AMOUNT_NAMES.join(", ") + ")"); else if (CORE.amountN(v.amounts[f]) === null) p.push(at + "amounts." + f + ": '" + v.amounts[f] + "' isn't an amount like $20 or free"); }); }
  });
  /* fixtures */
  if (R.fixtures !== undefined && !Array.isArray(R.fixtures)) p.push("record.json fixtures must be a list");
  const ids = new Set(), ev = {}; Object.keys(CORE.EVENT_GROUPS).forEach((g) => { ev[g] = CORE.EVENT_GROUPS[g].values.map((x) => x[0]); });
  const sw = CORE.switchList({ switches: head && head.switches }), fa = CORE.factList({ facts: head && head.facts });
  (Array.isArray(R.fixtures) ? R.fixtures : []).forEach((fx, i) => {
    const at = "record.json fixtures[" + i + "]" + (fx && fx.id ? " (" + fx.id + ")" : "") + ": ";
    if (!fx || typeof fx !== "object") { p.push(at + "must be an object"); return; }
    Object.keys(fx).forEach((k) => { if (!["id", "label", "add", "booking", "flows", "on", "facts", "switches", "later"].includes(k)) p.push(at + "unknown field '" + k + "' (id, label, add, booking, flows, on, facts, switches, later)"); });
    if (typeof fx.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(fx.id)) p.push(at + "id must be lowercase words joined by -");
    else if (ids.has(fx.id)) p.push(at + "the id is used twice"); else ids.add(fx.id);
    if (typeof fx.label !== "string" || !fx.label) p.push(at + "needs a label");
    if (fx.flows !== undefined && (!Array.isArray(fx.flows) || !fx.flows.length || fx.flows.some((f) => !["A", "B"].includes(f)))) p.push(at + "flows must list A and/or B");
    if (fx.add !== undefined && (!Array.isArray(fx.add) || fx.add.some((x) => !svcs[x]))) p.push(at + "add must list services of record.json services (" + Object.keys(svcs).join(", ") + ")");
    if (fx.later !== undefined && CORE.amountN(fx.later) === null) p.push(at + "later must be an amount like $20");
    if (fx.on !== undefined && !(fx.on === "all" || fx.on === "paid-or-card" || (Array.isArray(fx.on) && fx.on.every((k) => typeof k === "string" && /^[a-z]+\|[a-z]+\|[a-z]+$/.test(k))))) p.push(at + "on must be \"all\", \"paid-or-card\" or a list of money paths");
    if (fx.facts !== undefined && (!Array.isArray(fx.facts) || fx.facts.some((f) => !fa[f]))) p.push(at + "facts must list plug-in facts");
    if (fx.switches !== undefined && (!Array.isArray(fx.switches) || fx.switches.some((n) => !sw[n]))) p.push(at + "switches must list plug-in switches");
    if (fx.booking !== undefined) {
      if (!fx.booking || typeof fx.booking !== "object" || Array.isArray(fx.booking)) p.push(at + "booking must be an object like { \"reach\": \"callsonly\" }");
      else Object.keys(fx.booking).forEach((g) => {
        const vals = ev[g] || (CORE.BOOKING[g] ? CORE.allValues(g).map((x) => x[0]) : null);
        if (!vals) p.push(at + "booking: no booking group '" + g + "'"); else if (!vals.includes(fx.booking[g])) p.push(at + "booking." + g + " must be one of " + vals.join(", "));
      });
    }
    /* D73: on every money path it rides, its services must read as one path of the flow */
    if (Array.isArray(fx.add) && fx.add.every((x) => svcs[x])) ["A", "B"].forEach((fl) => {
      if (Array.isArray(fx.flows) && !fx.flows.includes(fl)) return;
      const add = fx.add.map((x) => svcs[x]).filter((v) => v.flow === fl);
      if (!add.length) return;
      const bad = combos(fl, { ways: W }).filter((c) => ridesOn(fx.on, c)).map((c) => [c, severalPath(fl, [c].concat(add.map((v) => (v.paidby === "credit" ? "credit" : { price: v.price, before: v.before, after: v.after }))), W)]).filter((x) => !x[1].path);
      if (bad.length) p.push(at + "flow " + fl + ": on " + comboKey(bad[0][0]) + (bad.length > 1 ? " (and " + (bad.length - 1) + " more paths)" : "") + " its services read as no money path (D73): " + bad[0][1].problems.join("; "));
    });
  });
  if (R.onefee !== undefined && typeof R.onefee !== "boolean") p.push("record.json onefee must be true (one late or no-show fee per booking: the largest) or false");
  /* the live set (TOOL-SPEC change 6; the lint's L6 reads it): switches and facts lists, values off per group, merged names */
  if (R.live !== undefined) {
    const lv = R.live, lw = "record.json live: ";
    if (!lv || typeof lv !== "object" || Array.isArray(lv)) p.push(lw + "must be an object (switches, facts, off, merged)");
    else {
      Object.keys(lv).forEach((k) => { if (!["switches", "facts", "off", "merged"].includes(k)) p.push(lw + "unknown key '" + k + "' (switches, facts, off, merged)"); });
      ["switches", "facts"].forEach((k) => { if (lv[k] !== undefined && (!Array.isArray(lv[k]) || lv[k].some((x) => typeof x !== "string" || !CORE.NAME.test(x)))) p.push(lw + k + " must be a list of names"); });
      (lv.switches || []).forEach((n) => { if (typeof n === "string" && !sw[n]) p.push(lw + "switches: no switch '" + n + "'"); });
      if (lv.off !== undefined) { if (!lv.off || typeof lv.off !== "object" || Array.isArray(lv.off)) p.push(lw + "off must be an object like { \"reach\": [\"notsafe\"] }"); else Object.keys(lv.off).forEach((g) => { const vals = ev[g] || (CORE.BOOKING[g] ? CORE.allValues(g).map((x) => x[0]) : null); if (!vals) p.push(lw + "off: no booking group '" + g + "'"); else if (!Array.isArray(lv.off[g]) || lv.off[g].some((v) => !vals.includes(v))) p.push(lw + "off." + g + " must list values of " + g + ": " + vals.join(", ")); }); }
      if (lv.merged !== undefined && (!lv.merged || typeof lv.merged !== "object" || Array.isArray(lv.merged) || Object.keys(lv.merged).some((k) => !["facts", "switches"].includes(k) || !lv.merged[k] || typeof lv.merged[k] !== "object"))) p.push(lw + "merged must be { \"facts\": { old: new }, \"switches\": { old: new } }");
    }
  }
  if (R.homes !== undefined && (!R.homes || typeof R.homes !== "object" || Array.isArray(R.homes) || Object.keys(R.homes).some((k) => typeof R.homes[k] !== "string"))) p.push("record.json homes must be an object of step ids, like { \"money\": \"S13-55\" }");
  if (R.lint !== undefined && (!R.lint || typeof R.lint !== "object" || Array.isArray(R.lint))) p.push("record.json lint must be an object (phrases, pointers, allow)");
  return p;
}
/* Tools J (E1; TOOL-SPEC 2.2): every record slot a lit step shows must fit a row on every path given (fixtures
   included), each walked with its branches' sets (CORE.walkSets): errors "<fl>:<id>: pay.late fits no row on <path>: add
   a last row with no when". opts.dead: also each row of a slot some step uses that no walked path used (warnings);
   opts.score: the step's plain words with its slots filled on the main path and on the first path of each fixture
   (errors). Returns { errors, warnings, used: Map(slot -> Set(row index)) }. */
function recordSlotProblems(steps, fl, paths, opts) {
  const errors = [], warnings = [], used = new Map(), R = CORE.record(fl), w0 = fl ? fl + ":" : "", seen = new Set();
  if (!R || !R.slots) return { errors, warnings, used };
  const firstFix = new Map(), scored = new Set();
  (paths || []).forEach((c0) => {
    if (c0.fix && !firstFix.has(c0.fix)) firstFix.set(c0.fix, c0);
    CORE.walkSets(steps, c0, (s, p, trail, b) => {
      if (b || !s.rec) return;
      const R0 = CORE.resolveVary(s, p);
      Object.keys(R0.rows || {}).forEach((n) => {
        const i = R0.rows[n];
        if (i === null) { const k = s.id + "|" + n; if (!seen.has(k)) { seen.add(k); errors.push(w0 + s.id + ": " + n + " fits no row on " + pathKey(p) + ": add a last row with no when"); } }
        else { if (!used.has(n)) used.set(n, new Set()); used.get(n).add(i); }
      });
    }, { off: true });
  });
  if (opts && opts.dead) Object.keys(R.slots).forEach((n) => {
    if (!used.has(n)) return;
    (R.slots[n].rows || []).forEach((r, i) => { if (!used.get(n).has(i)) warnings.push(w0 + " record.json slots." + n + " row " + (i + 1) + (r && r.when ? " (when " + JSON.stringify(r.when) + ")" : "") + " fits no walked path: move it up, or delete it"); });
  });
  if (opts && opts.score) eachStep(steps, (s) => {
    if (!s.rec) return;
    [[null, " (on the main path)"]].concat([...firstFix].map(([f, c]) => [c, " (on +" + f + ")"])).forEach(([c, tag]) => {
      const v = CORE.resolveVary(Object.assign({}, s, { layerAdd: undefined }), c).step, sc = scoreStep(v); /* (the step's own words: layer lines are scored where they are written) */
      if (sc.why.length) { const m = w0 + s.id + tag + " plain words: " + sc.why.join("; "), k = s.id + "|" + sc.why.join("; "); if (!scored.has(k)) { scored.add(k); errors.push(m); } }
    });
  });
  return { errors, warnings, used };
}
/* dead rows over both flows: the rows of a slot some step uses (in either flow) that no walked path of either flow used
   (useds: recordSlotProblems(...).used of each flow); warnings as text */
function recordDeadRows(R, useds) {
  const out = [], all = new Map();
  (useds || []).forEach((u) => u && u.forEach((set, n) => { if (!all.has(n)) all.set(n, new Set()); set.forEach((i) => all.get(n).add(i)); }));
  Object.keys((R && R.slots) || {}).forEach((n) => { if (!all.has(n)) return; (R.slots[n].rows || []).forEach((r, i) => { if (!all.get(n).has(i)) out.push("record.json slots." + n + " row " + (i + 1) + (r && r.when ? " (when " + JSON.stringify(r.when) + ")" : "") + " fits no walked path of either flow: move it up, or delete it"); }); });
  return out;
}
/* ---------------------------------------------------------------- tools J, E2 (REDESIGN 2; TOOL-SPEC 2.4, 4, 5) */
/* All of this runs only with header.json "record": true (recordOn) and work/master/src/record.json (build-master and
   check-part read it): cast slots and {{ab:A words|B words}} resolved per flow (castStep), the parts' "shared" texts
   merged into the steps that name them (mergeShared, with L5), the lint L1-L4 (lintSteps) and the build's "reads"
   (readsOf). Without "record" nothing here is called, so every output reads exactly as before. */
const recordOn = (head) => !!head && head.record === true;
const CAST_NAMES = ["biz", "pro", "place", "cust", "owner"];
const CAST_RE = /\{\{\s*(biz|pro|place|cust|owner)\s*(:[^{}]*)?\}\}/g;
/* {{ab:A words|B words}}: either side may hold a slot ({{fee}}, {{svc.intext:Haircut|visit}}), no deeper */
const AB_RE = /\{\{\s*ab\s*:((?:[^{}|]|\{\{[^{}]*\}\})*)\|((?:[^{}|]|\{\{[^{}]*\}\})*)\}\}/g;
const AB_LEFT = /\{\{\s*ab\s*:/;
const short = (t, n) => { const s = String(t); return s.length > (n || 70) ? s.slice(0, n || 70) + "..." : s; };
/* one text for flow fl: cast slots first (so an {{ab:}} side may hold one), then {{ab:}}. Problems pushed as text. */
function castText(t, names, fl, problems, where) {
  if (typeof t !== "string" || t.indexOf("{{") < 0) return t;
  let out = t.replace(CAST_RE, (m, n, ex) => {
    if (ex !== undefined) { problems.push((where || "") + "the cast slot {{" + n + "}} takes no example words: '" + short(t, 60) + "'"); return m; }
    const v = names && names[n];
    if (typeof v !== "string" || !v.trim()) { problems.push((where || "") + "{{" + n + "}}: header.json flows." + fl + ".names has no '" + n + "' (cast slots: " + CAST_NAMES.join(", ") + ")"); return m; }
    return v;
  });
  let emptied = false;
  out = out.replace(AB_RE, (m, a, b) => { const v = fl === "B" ? b : a; if (!v.trim()) emptied = true; return v; });
  if (AB_LEFT.test(out)) problems.push((where || "") + "an {{ab:A words|B words}} needs exactly one '|' between the A words and the B words: '" + short(t) + "'");
  /* (an empty side: the spaces around it close up; put a space inside the {{ab:}} when a side's words need one) */
  if (emptied) out = out.replace(/[ \t]{2,}/g, " ").trim();
  return out;
}
const CAST_SKIP = { link: 1, code: 1, photoLink: 1 };
function castDeep(v, names, fl, problems, where) {
  if (typeof v === "string") return castText(v, names, fl, problems, where);
  if (Array.isArray(v)) return v.map((x) => castDeep(x, names, fl, problems, where));
  if (v && typeof v === "object") { const o = {}; Object.keys(v).forEach((k) => { o[k] = CAST_SKIP[k] ? v[k] : castDeep(v[k], names, fl, problems, where); }); return o; }
  return v;
}
/* lines and messages: one that resolves to nothing (an empty {{ab:}} side) is dropped */
const castLines = (xs, names, fl, problems, where) => (Array.isArray(xs) ? xs.map((x) => [x, castText(x, names, fl, problems, where)]).filter(([x, y]) => !(typeof x === "string" && x.trim() && typeof y === "string" && !y.trim())).map((p) => p[1]) : xs);
const castSay = (ms, names, fl, problems, where) => (Array.isArray(ms) ? ms.map((m) => {
  if (!Array.isArray(m)) return m;
  const t = castText(m[2], names, fl, problems, where);
  if (typeof m[2] === "string" && m[2].trim() && typeof t === "string" && !t.trim()) return null;
  return m.length === 4 ? [m[0], m[1], t, castDeep(m[3], names, fl, problems, where)] : [m[0], m[1], t];
}).filter((m) => m !== null) : ms);
/* a step's (or a variant's) word fields for flow fl, in place */
function castWords(o, names, fl, problems, where) {
  ["title", "does", "rule", "q", "as"].forEach((k) => { if (typeof o[k] === "string") o[k] = castText(o[k], names, fl, problems, where + k + ": "); });
  ["more", "addMore"].forEach((k) => { if (o[k] !== undefined) o[k] = castLines(o[k], names, fl, problems, where + k + ": "); });
  ["say", "addSay"].forEach((k) => { if (o[k] !== undefined) o[k] = castSay(o[k], names, fl, problems, where + k + ": "); });
  ["form", "table", "swap", "slot"].forEach((k) => { if (o[k] !== undefined && o[k] !== null) o[k] = castDeep(o[k], names, fl, problems, where + k + ": "); });
  return o;
}
/* one step (and its branches' steps) for flow fl: its words, its variants', its endTexts; inFlow.<f> with flow f's names */
function castStep(s, namesBy, fl, problems, where) {
  eachStep([s], (x) => {
    const W = (where || "") + x.id + " ";
    castWords(x, namesBy[fl], fl, problems, W);
    Object.keys(x.vary || {}).forEach((k) => { if (x.vary[k] && typeof x.vary[k] === "object") castWords(x.vary[k], namesBy[fl], fl, problems, W + "vary '" + k + "' "); });
    Object.keys(x.inFlow || {}).forEach((f) => { const w = x.inFlow[f]; if (w && typeof w === "object" && namesBy[f]) { castWords(w, namesBy[f], f, problems, W + "inFlow." + f + " "); Object.keys(w.vary || {}).forEach((k) => { if (w.vary[k] && typeof w.vary[k] === "object") castWords(w.vary[k], namesBy[f], f, problems, W + "inFlow." + f + " vary '" + k + "' "); }); } });
    (x.branches || []).forEach((b) => { if (typeof b.label === "string") b.label = castText(b.label, namesBy[fl], fl, problems, W + "branch '" + b.label + "' label: "); if (typeof b.endText === "string") b.endText = castText(b.endText, namesBy[fl], fl, problems, W + "branch '" + b.label + "' endText: "); });
  });
  return s;
}

/* ---- shared text (TOOL-SPEC 5): an A/B twin's words written once, in a part's top-level "shared" block */
const SHARED_WORDS = ["title", "does", "more", "say", "rule", "q", "form", "table", "vary"];
const SHARED_KEYS = SHARED_WORDS.concat(["labels", "endTexts"]);
const twinFlowOf = (p) => (PARTS[p] && !PARTS[p].shared ? PARTS[p].prefix : null);
/* every shared text of the parts given: { name: { part, text } }, and the problems of the blocks themselves */
function sharedTexts(parts) {
  const out = {}, problems = [];
  Object.keys(PARTS).forEach((p) => {
    const sh = parts[p] && parts[p].shared;
    if (sh === undefined) return;
    if (!sh || typeof sh !== "object" || Array.isArray(sh)) { problems.push(p + ": \"shared\" must be an object of named texts"); return; }
    Object.keys(sh).forEach((n) => {
      const T = sh[n], w = p + " shared '" + n + "': ";
      if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(n)) problems.push(w + "a name is letters, digits and dashes: the A step's id (DESIGN 4: \"A7-06\") or a word like late-cancel-warn");
      if (out[n]) { problems.push(w + "the name is already used by " + out[n].part + " (names are unique across the six parts)"); return; }
      if (!T || typeof T !== "object" || Array.isArray(T)) { problems.push(w + "must be an object of word fields"); return; }
      Object.keys(T).forEach((k) => { if (!SHARED_KEYS.includes(k)) problems.push(w + "unknown field '" + k + "' (a shared text holds " + SHARED_KEYS.join(", ") + "; the step keeps its own id, line, who, to, via, t, needs, gives, when, sets and branches)"); });
      ["labels", "endTexts"].forEach((k) => { if (T[k] !== undefined && (!Array.isArray(T[k]) || T[k].some((x) => x !== null && typeof x !== "string"))) problems.push(w + k + " must be a list (one per branch, null for none)"); });
      if (T.more !== undefined && (!Array.isArray(T.more) || T.more.some((x) => typeof x !== "string"))) problems.push(w + "more must be a list of lines");
      if (T.vary !== undefined) {
        if (!T.vary || typeof T.vary !== "object" || Array.isArray(T.vary)) problems.push(w + "vary must be an object");
        else Object.keys(T.vary).forEach((k) => { const c = parseVaryKey(k); if (!c || Object.keys(c).some((d) => d !== "pf")) problems.push(w + "vary '" + k + "': a shared text's vary holds switch keys only (pf:grief); money and booking words come from the record (record slots)"); });
      }
      out[n] = { part: p, text: T };
    });
  });
  return { texts: out, problems };
}
/* the parts as flow fl reads them, with every step's "text" merged in and every cast slot and {{ab:}} resolved for fl.
   opts.names = { A: header flows.A.names, B: ... }. Returns { parts (a copy), errors, notes (the named twin differences),
   hits (L5 lint hits: { rule, level, id, field, text, fix }) }. The step keeps its own structure; "text" stays on it. */
function mergeShared(parts, fl, opts) {
  opts = opts || {};
  const namesBy = opts.names || {}, errors = [], notes = [], hits = [];
  const ST = sharedTexts(parts);
  ST.problems.forEach((p) => errors.push(p));
  const out = {};
  Object.keys(parts).forEach((p) => {
    const reads = PARTS[p] ? PARTS[p].flows.includes(fl) : true;
    if (!parts[p] || !reads) { out[p] = parts[p]; return; }
    const c = JSON.parse(JSON.stringify(parts[p]));
    (c.sections || []).forEach((sec) => eachStep(sec.steps, (s) => {
      if (s.addMore !== undefined && s.text === undefined) errors.push(p + ": " + s.id + " addMore is for a step with a shared text (\"text\"): write the lines in its more");
      if (s.text === undefined) return;
      const w = s.id + " text '" + s.text + "'";
      if (PARTS[p] && PARTS[p].shared) { errors.push(p + ": " + w + ": a shared text is for A/B twins; a shared part (" + p + ") uses only / inFlow"); return; }
      const E = ST.texts[s.text];
      if (typeof s.text !== "string" || !E) { errors.push(p + ": " + w + ": no shared text by that name" + (Object.keys(ST.texts).length ? " (" + Object.keys(ST.texts).slice(0, 12).join(", ") + ")" : "")); return; }
      const T = E.text;
      /* L5: the words live in the shared text; a step setting one of its fields would drift */
      SHARED_WORDS.forEach((k) => { if (T[k] !== undefined && s[k] !== undefined) hits.push({ rule: "L5", level: "error", id: s.id, field: k, text: s.text, fix: "the words live in the shared text " + s.text + ": take '" + k + "' off the step (a real twin difference: {{ab:A words|B words}} in the text, or addMore on the step)" }); });
      SHARED_WORDS.forEach((k) => { if (T[k] !== undefined) s[k] = JSON.parse(JSON.stringify(T[k])); });
      const B = s.branches || [];
      ["labels", "endTexts"].forEach((k) => { if (Array.isArray(T[k]) && T[k].length !== B.length) errors.push(p + ": " + w + ": the text has " + T[k].length + " " + (k === "labels" ? "labels" : "endTexts") + ", the step " + B.length + " branches (one each, in order)"); });
      B.forEach((b, i) => {
        const lab = Array.isArray(T.labels) ? T.labels[i] : undefined, et = Array.isArray(T.endTexts) ? T.endTexts[i] : undefined;
        if (typeof lab === "string") { if (b.label && b.label !== lab) hits.push({ rule: "L5", level: "error", id: s.id, field: "branch " + (i + 1) + " label", text: b.label, fix: "the shared text " + s.text + " names it '" + lab + "': leave the step's label empty (\"\")" }); b.label = lab; }
        if (typeof et === "string") { if (b.endText && b.endText !== et) hits.push({ rule: "L5", level: "error", id: s.id, field: "branch " + (i + 1) + " endText", text: b.endText, fix: "the shared text " + s.text + " has its endText: take it off the step" }); b.endText = et; }
      });
      if (s.addMore !== undefined) {
        if (!Array.isArray(s.addMore) || !s.addMore.length || s.addMore.some((x) => typeof x !== "string" || !x.trim())) errors.push(p + ": " + w + ": addMore must be a list of lines");
        else { s.more = (s.more || []).concat(s.addMore); notes.push(fl + ":" + s.id + " (" + s.text + "): a named twin difference, " + s.addMore.length + " line" + (s.addMore.length > 1 ? "s" : "") + " after the shared ones: " + s.addMore.map((x) => "'" + short(castText(x, namesBy[fl], fl, [], ""), 60) + "'").join(", ")); }
        delete s.addMore;
      }
    }));
    /* cast slots and {{ab:}} on every step this flow reads */
    (c.sections || []).forEach((sec) => (sec.steps || []).forEach((s) => castStep(s, namesBy, fl, errors, p + ": ")));
    out[p] = c;
  });
  return { parts: out, errors, notes, hits };
}
/* who uses each shared text, across both flows: none (an error), two steps of one flow (an error), one flow only (a
   warning: not a twin). Returns { errors, warnings } */
function sharedUseProblems(parts) {
  const ST = sharedTexts(parts), use = {}, errors = [], warnings = [];
  Object.keys(parts).forEach((p) => { const f = twinFlowOf(p); if (!parts[p] || !f) return; (parts[p].sections || []).forEach((sec) => eachStep(sec.steps, (s) => { if (typeof s.text === "string") ((use[s.text] = use[s.text] || { A: [], B: [] })[f]).push(s.id); })); });
  Object.keys(ST.texts).forEach((n) => {
    const u = use[n] || { A: [], B: [] }, from = ST.texts[n].part;
    if (!u.A.length && !u.B.length) errors.push(from + " shared '" + n + "': no step uses it (a step says \"text\": \"" + n + "\")");
    ["A", "B"].forEach((f) => { if (u[f].length > 1) errors.push(from + " shared '" + n + "': used by " + u[f].length + " steps of flow " + f + " (" + u[f].join(", ") + "): one step a flow"); });
    if ((u.A.length > 0) !== (u.B.length > 0)) warnings.push(from + " shared '" + n + "': used in flow " + (u.A.length ? "A" : "B") + " only (" + u.A.concat(u.B).join(", ") + "): not a twin, write it on the step");
  });
  return { errors, warnings };
}

/* ---- the lint (TOOL-SPEC 4): one home per rule */
const LINT_RULES = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8"];
const READS_KEYS = ["money", "two", "contact", "clock", "who", "stop", "proof", "safety", "change", "record"];
/* (TOOL-SPEC 8:20pm #7: the payer group, someone else pays, is the record's too) */
const REC_GROUPS = ["paidby", "taken", "reach", "privacy", "approval", "charge", "contact", "payer"];
const EVENT_VALUES = { charge: ["none", "later", "failed"], contact: ["kept", "switched", "stopped"], payer: ["self", "other"] };
/* a vary key's parts that name the record: a money choice, a booking value of a record group, pf:credit */
function recordKeyParts(k) {
  return String(k).split("+").map((p) => p.trim()).filter((p) => {
    if (/^(price|before|after):/.test(p)) return true;
    if (p === "pf:credit") return true;
    const m = /^booking:([a-z]+)$/.exec(p);
    if (!m) return false;
    const g = CORE.GROUP_OF[m[1]];
    return (g && REC_GROUPS.includes(g)) || (!g && Object.keys(EVENT_VALUES).some((x) => EVENT_VALUES[x].includes(m[1])) && m[1] !== "none");
  });
}
const timingKeyParts = (k) => String(k).split("+").map((p) => p.trim()).filter((p) => /^booking:(sentnow|line|shop)$/.test(p));
const secOf = (id) => +((/^[SAB](\d+)-/.exec(String(id || "")) || [0, 0])[1]);
/* the home a record slot's prefix belongs to: pay.* and two.* money, reach.* contact, who.* who, clock.* clock */
const slotHomeKey = (name) => { const h = String(name).split(".")[0]; return h === "pay" || h === "two" ? "money" : h === "reach" ? "contact" : h; };
const SLOT_ANY = "(?:\\{\\{[^{}]*\\}\\}|\\S+(?: \\S+){0,2})";
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const unq = (t) => String(t).replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
/* the record's phrases as patterns, for flow fl: each slot row of 4+ words (its slots match any words or a slot), and
   record.json lint.phrases. [{ re, slot, home, how }] */
function recordPhrases(rec, fl, names) {
  const out = [], homes = (rec && rec.homes) || {};
  Object.keys((rec && rec.slots) || {}).forEach((name) => {
    const S = rec.slots[name], home = (S && S.home) || homes[slotHomeKey(name)] || "";
    ((S && S.rows) || []).forEach((r, i) => {
      if (!r || typeof r.text !== "string") return;
      const t = unq(castText(r.text, names, fl, [], "")).trim().replace(/\s+/g, " ");
      const bits = t.split(/(\{\{[^{}]*\}\})/), lit = bits.filter((b, j) => j % 2 === 0).join(" ");
      if (words(lit).length < 4) return;
      const src = bits.map((b, j) => (j % 2 ? SLOT_ANY : reEsc(b).replace(/ /g, "\\s+"))).join("");
      try { out.push({ re: new RegExp("(?:^|[^A-Za-z0-9])" + src + "(?![A-Za-z0-9])", "i"), slot: name, home, how: "row " + (i + 1) + " of {{" + name + "}}", row: t }); } catch (e) { /* recordLintProblems reports it */ }
    });
  });
  const P = ((rec && rec.lint) || {}).phrases || {};
  Object.keys(P).forEach((h) => (Array.isArray(P[h]) ? P[h] : []).forEach((x) => { try { out.push({ re: new RegExp(x, "im"), slot: null, home: homes[h] || h, key: h, how: "the " + h + " phrase /" + x + "/" }); } catch (e) { /* reported */ } }));
  return out;
}
/* ripple parity's normalizer (work/phase3/tools/ripple/parity.js `norm`), copied: the cast, places, services, amounts,
   days and times evened out; tokens without the small words */
const N_CAST = /\b(?:alex(?: m\.)?|a\.m\.|riley|avery|jordan|casey|kim|ben|dee|morgan|sam|pat|omar|owen|rose|lin|nora|hugo|dana)\b/g;
const N_BIZ = /\b(?:lee's barbershop|lee home services|the shop|the business|the barbershop|the salon|the plumber|the barber|the pro|staff)\b/g;
const N_PLACE = /\b(?:at the chair|at the counter|at the door|at the shop|at the home|at home|in the chair|the chair|the counter|the door|the home|the house|the shop's phone|the pro's phone)\b/g;
const N_SVC = /\b(?:haircut|skin fade|beard trim|kids cut|signature cut(?: and hot towel shave)?|groom's package|color(?: and cut| correction| touch-up)?|kitchen drain clearing|drain clearing|water heater(?: replacement| flush)?|leak repair|valves?|drain trap|cut)\b/g;
function lintNorm(t) {
  return String(t || "").toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(N_CAST, "P").replace(N_BIZ, "BIZ").replace(N_PLACE, "PLACE").replace(N_SVC, "SVC")
    .replace(/\$\d[\d,.]*/g, "$N").replace(/\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/g, "DAY").replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2}\b/g, "DATE")
    .replace(/\b\d{1,2}(?::\d\d)?\s?(?:am|pm)\b(?:\s?(?:–|-|to)\s?\d{1,2}(?::\d\d)?\s?(?:am|pm))?/g, "TIME").replace(/\b[ab]\d{1,2}-\d{2,3}\b/g, "STEP")
    .replace(/[^a-z0-9$' ]+/g, " ").replace(/\s+/g, " ").trim();
}
const LINT_STOP = new Set("a an the and or of to in on at for by is are be it its it's this that with as if no not from then any each one their they them his her you your our we".split(" "));
const lintToks = (t) => new Set(lintNorm(t).split(" ").filter((w) => w.length > 1 && !LINT_STOP.has(w)));
function jaccard(a, b) { if (!a.size && !b.size) return 1; let i = 0; a.forEach((x) => { if (b.has(x)) i++; }); return i / (a.size + b.size - i); }
/* the home nodes' lines, for L4: [{ home, id, where, toks }] (8+ tokens) */
function homeLines(homeSteps) {
  const out = [];
  Object.keys(homeSteps || {}).forEach((h) => {
    const s = homeSteps[h]; if (!s) return;
    const add = (where, t) => { const k = lintToks(t); if (k.size >= 8) out.push({ home: h, id: s.id, where, toks: k }); };
    if (s.does) add("does", s.does);
    (s.more || []).forEach((x, i) => add("line " + (i + 1), x));
    if (s.rule) add("rule", s.rule);
  });
  return out;
}
/* the words L2 reads on a step (or a variant): Rosie's notes (does, more, rule), the messages Rosie, the owner and
   staff send (their text and their element's words: card lines, buttons), form values. [[field, text]] */
const L2_SENDERS = ["san", "owner", "staff"];
function lintWords(o, pre) {
  const out = [], deep = (f, v) => { if (typeof v === "string") out.push([f, v]); else if (Array.isArray(v)) v.forEach((x) => deep(f, x)); else if (v && typeof v === "object") Object.keys(v).forEach((k) => { if (!CAST_SKIP[k]) deep(f, v[k]); }); };
  if (typeof o.does === "string") out.push([pre + "does", o.does]);
  (o.more || []).concat(o.addMore || []).forEach((x, i) => { if (typeof x === "string") out.push([pre + "more " + (i + 1), x]); });
  if (typeof o.rule === "string") out.push([pre + "rule", o.rule]);
  (o.say || []).concat(o.addSay || []).forEach((m, i) => { if (!Array.isArray(m) || !L2_SENDERS.includes(m[0])) return; if (typeof m[2] === "string") out.push([pre + "message " + (i + 1), m[2]]); if (m[3]) deep(pre + "message " + (i + 1) + " card", m[3]); });
  if (o.form) deep(pre + "form", o.form);
  return out;
}
/* L3 (DESIGN-REVIEW-10 M1): a line is read sentence by sentence. A sentence is a pointer only when a record.json pointer
   pattern matches it and nothing of its own is left once the match, its label ("Clocks:"), step ids and "(judgment rules
   ...)" are taken out; a sentence with a Safe default, a Never, a Silence, a Means or a Clock is never one. So a line is
   "bare" (only pointers: delete it), "mixed" (pointers and the step's own words, like "... judgment rules 16 to 24. Safe
   default here: X.": keep "Safe default: X."), "partial" (a pattern inside a sentence of its own words) or "none". */
const OWN_RULE = /\b(?:safe default|never|silence|means|clock)\b/i;
const lineSentences = (t) => String(t).trim().split(/(?<=[.!?])\s+(?=[A-Z"'(])/).filter((x) => x.trim());
function pointerSentence(x, pointers) {
  if (OWN_RULE.test(x)) return false;
  let hit = false, rest = x;
  pointers.forEach((re) => { if (re.test(x)) { hit = true; rest = rest.replace(new RegExp(re.source, re.flags.replace("g", "") + "g"), " "); } });
  if (!hit) return false;
  rest = rest.replace(/\([^()]*\)/g, " ").replace(/\b[SAB]\d+-\d{2,3}\b/g, " ").replace(/\bjudgment rules? \d+(?:(?:,| to| and) \d+)*/gi, " ").replace(/^[^:]{0,80}:/, " ");
  return !/[A-Za-z0-9]/.test(rest);
}
function pointerLine(t, pointers) {
  if (typeof t !== "string" || !pointers.length) return { kind: "none" };
  const ss = lineSentences(t), ptr = ss.map((x) => pointerSentence(x, pointers));
  if (!ptr.some(Boolean)) return pointers.some((re) => re.test(t)) ? { kind: "partial" } : { kind: "none" };
  if (ptr.every(Boolean)) return { kind: "bare" };
  return { kind: "mixed", keep: ss.filter((x, i) => !ptr[i]).join(" ").replace(/\bSafe default here:/g, "Safe default:").trim() };
}
/* L7 (DESIGN-REVIEW-10 M1): a decision step (a split with a branch an answer picks: no when) must keep a "Safe default" line
   (in its does, more, rule or a variant's more), so a rebuild can't lose one */
const SAFE_DEFAULT = /\bsafe default\b/i;
function hasSafeDefault(s) {
  const own = [s.does, s.rule].concat(s.more || []);
  Object.keys(s.vary || {}).forEach((k) => { const v = s.vary[k] || {}; own.push(v.does, v.rule); (v.more || []).concat(v.addMore || []).forEach((x) => own.push(x)); });
  return own.some((x) => typeof x === "string" && SAFE_DEFAULT.test(x));
}
const isDecision = (s) => s.type === "split" && (s.branches || []).some((b) => !b.when);
/* L8 (TOOL-SPEC change 23 a): record.json lint.banned.phrases, the old words of rules the redesign changed. An entry is a
   pattern, or { "re": "<pattern>", "now": "<the rule that replaced it>" }. [{ re, src, now }] */
function bannedList(rec) {
  const B = ((rec && rec.lint) || {}).banned, out = [];
  ((B && Array.isArray(B.phrases)) ? B.phrases : []).forEach((x) => {
    const src = typeof x === "string" ? x : x && typeof x.re === "string" ? x.re : null, now = x && typeof x === "object" && typeof x.now === "string" ? x.now : null;
    if (!src) return;
    try { out.push({ re: new RegExp(src, "i"), src, now }); } catch (e) { /* recordLintProblems reports it */ }
  });
  return out;
}
/* L8's fix (DESIGN-REVIEW-10 W1, as L3 does for a mixed line): when the old words are only part of the line (another
   sentence holds none, or the line carries the step's own rule: a Means, Never, Silence, Safe default or Clock), "remove
   only these words: <match>; keep the rest of the line", never "delete the line"; when every sentence is old words, the
   rule that replaced it (record.json "now") or today's rule from its home, "or delete the line" */
function bannedFix(t, words, b, BAN) {
  const ss = lineSentences(unq(t)), clean = ss.some((x) => !BAN.some((y) => y.re.test(x)));
  const head = "an old rule's words, '" + words + "' (/" + b.src + "/): ";
  if (clean || OWN_RULE.test(t)) return head + "remove only these words: '" + words + "'; keep the rest of the line (its other words are this step's own)" + (b.now ? "; the rule now: " + b.now : "");
  return head + (b.now ? "the rule now: " + b.now + "; write that, or delete the line" : "the redesign changed this rule (record.json lint.banned, TOOL-SPEC 23): write today's rule from its home, or delete the line");
}
/* every line of a step for L8: its words, each more line and message (any sender, with its element's words), form, table,
   the plug-in box, each variant's (and inFlow's) the same way, branch labels and endTexts. [[field, text]] */
function stepLines(s) {
  const out = [], deep = (f, v) => { if (typeof v === "string") out.push([f, v]); else if (Array.isArray(v)) v.forEach((x) => deep(f, x)); else if (v && typeof v === "object") Object.keys(v).forEach((k) => { if (!CAST_SKIP[k]) deep(f, v[k]); }); };
  const words = (o, pre) => {
    ["title", "does", "rule", "q", "as"].forEach((k) => { if (typeof o[k] === "string") out.push([pre + k, o[k]]); });
    (o.more || []).concat(o.addMore || []).forEach((x, i) => { if (typeof x === "string") out.push([pre + "more " + (i + 1), x]); });
    (o.say || []).concat(o.addSay || []).forEach((m, i) => { if (!Array.isArray(m)) return; if (typeof m[2] === "string") out.push([pre + "message " + (i + 1), m[2]]); if (m[3]) deep(pre + "message " + (i + 1) + " card", m[3]); });
    ["form", "table", "slot", "swap"].forEach((k) => { if (o[k]) deep(pre + k, o[k]); });
  };
  words(s, "");
  Object.keys(s.vary || {}).forEach((k) => { if (s.vary[k] && typeof s.vary[k] === "object") words(s.vary[k], "vary '" + k + "' "); });
  Object.keys(s.inFlow || {}).forEach((f) => { if (s.inFlow[f] && typeof s.inFlow[f] === "object") words(s.inFlow[f], "inFlow." + f + " "); });
  (s.branches || []).forEach((b, i) => { if (typeof b.label === "string") out.push(["branch " + (i + 1) + " label", b.label]); if (typeof b.endText === "string") out.push(["branch " + (i + 1) + " endText", b.endText]); });
  return out;
}
/* the steps under the money step's branches (they set the record): ids */
function moneyStepIds(steps, mid) {
  const ids = new Set();
  if (!mid) return ids;
  eachStep(steps, (s) => { if (s.id === mid) { ids.add(s.id); eachStep((s.branches || []).reduce((a, b) => a.concat(b.steps || []), []), (x) => ids.add(x.id)); } });
  return ids;
}
/* the lint on one flow's stamped steps (a joined flow, or a part's per-flow copy). rec = record.json; opts = { homes:
   { money: <S13-55 step>, ... } (for L4), moneyStep: header took[fl] }. Returns { errors, warnings, allowed, hits }. */
function lintSteps(steps, fl, rec, opts) {
  opts = opts || {};
  const hits = [], homes = (rec && rec.homes) || {}, homeIds = new Set(Object.values(homes));
  const phrases = recordPhrases(rec, fl, opts.names);
  const pointers = (((rec && rec.lint) || {}).pointers || []).map((x) => { try { return new RegExp(x, "i"); } catch (e) { return null; } }).filter(Boolean);
  const LV = liveSet(rec), BAN = bannedList(rec);
  const HL = homeLines(opts.homes);
  const mids = moneyStepIds(steps, opts.moneyStep);
  const hit = (rule, level, s, field, text, fix) => hits.push({ rule, level, id: s.id, field, text, fix });
  eachStep(steps, (s) => {
    if (!s || !s.id || (s.only && s.only !== fl)) return;
    /* zone: after the money step (stamped took) and sections 11-12, the money step and its branches' steps aside (they
       set the record); early: sections 3-12 outside it (before the money step, the money step, "took": false) */
    const sec = secOf(s.id), took = !!s.took, zone = (took || sec === 11 || sec === 12) && !mids.has(s.id), early = !zone && sec >= 3 && sec <= 12;
    /* L1: record variants (and L1b: a branch reading money before: after the money step) */
    Object.keys(s.vary || {}).forEach((k) => {
      const rp = recordKeyParts(k);
      if (rp.length && zone) hit("L1", "error", s, "vary '" + k + "'", k, "the record carries these words (" + rp.join(", ") + "): use a record slot ({{pay.took}}, {{pay.late}}, {{reach.way}} ...) and drop the variant");
      else if (rp.length && early) hit("L1", "warning", s, "vary '" + k + "'", k, "prefer a slot: the record gives these words (" + rp.join(", ") + ")");
      const tp = timingKeyParts(k);
      if (tp.length && sec >= 3 && sec <= 12 && !(rp.length && zone)) hit("L1", "warning", s, "vary '" + k + "'", k, "prefer a slot: " + tp.join(", ") + " words can come from the record's rows");
    });
    if (zone) (s.branches || []).forEach((b) => { if (b.when && b.when.before) hit("L1", "warning", s, "branch '" + b.label + "' when", "before: " + b.when.before.join(", "), "use rec: (what was taken: paid, card, nothing ...), so mixes light right"); });
    /* L6: a key, when, gate or sets naming something the cut list took out (record.json "live"), anywhere */
    if (LV) cutHits(s, LV).forEach(([f, what]) => hit("L6", "error", s, f, what, "cut by CUT-LIST: " + what + ": take it out" + (/\(now: /.test(what) ? ", or use what replaced it" : "")));
    /* L8: a line holding an old rule's words (record.json lint.banned), anywhere: one hit a line and phrase */
    if (BAN.length) stepLines(s).forEach(([f, t]) => BAN.forEach((b) => { const m = b.re.exec(unq(t)); if (m) hit("L8", "error", s, f, t, bannedFix(t, m[0], b, BAN)); }));
    /* L7: a decision step with no safe default line, anywhere */
    if (isDecision(s) && !hasSafeDefault(s)) hit("L7", "error", s, "q", s.q || s.title || "", "add its safe default as one line, 'Safe default: ...' (what happens when the answer is unclear, late or off-topic)");
    /* L2: record phrases outside a slot (not the home nodes) */
    if (!homeIds.has(s.id) && sec >= 3 && sec <= 12) {
      const lv = zone && sec >= 5 ? "error" : "warning";
      const W = lintWords(s, "");
      Object.keys(s.vary || {}).forEach((k) => { if (!recordKeyParts(k).length) lintWords(s.vary[k] || {}, "vary '" + k + "' ").forEach((x) => W.push(x)); });
      /* (one hit a field, the first phrase it holds; a pointer line is L3's) */
      const seen = new Set();
      W.forEach(([f, t]) => phrases.forEach((P) => {
        const pl = /^(vary '[^']*' )?more \d+$/.test(f) ? pointerLine(t, pointers) : { kind: "none" };
        if (seen.has(f) || pl.kind === "bare") return;
        if (!P.re.test(unq(pl.kind === "mixed" ? pl.keep : t))) return;
        seen.add(f);
        hit("L2", lv, s, f, t, "this is " + (P.home || "the record") + "'s rule (" + P.how + "): " + (P.slot ? "use {{" + P.slot + "}}" : "use a record slot") + " / delete the line");
      }));
    }
    /* L3: a more line that only points to a home; L4: a more line or rule box that restates a home node's line */
    if (sec >= 3 && sec <= 12 && !homeIds.has(s.id)) {
      const lines = (s.more || []).map((x, i) => ["more " + (i + 1), x]);
      Object.keys(s.vary || {}).forEach((k) => ((s.vary[k] || {}).more || []).concat((s.vary[k] || {}).addMore || []).forEach((x, i) => lines.push(["vary '" + k + "' more " + (i + 1), x])));
      lines.forEach(([f, t]) => {
        const pl = pointerLine(t, pointers);
        if (pl.kind === "bare") hit("L3", "error", s, f, t, "delete it: the build lists what a step follows (reads)");
        else if (pl.kind === "mixed") hit("L3", "warning", s, f, t, "keep it as '" + pl.keep + "' and drop the pointer words (never delete the line: it holds this step's own words)");
        else if (pl.kind === "partial") hit("L3", "warning", s, f, t, "keep this step's own words and drop only the pointer words in it");
      });
      if (HL.length) lines.concat(typeof s.rule === "string" ? [["rule", s.rule]] : []).forEach(([f, t]) => {
        if (typeof t !== "string") return;
        const pl = f === "rule" ? { kind: "none" } : pointerLine(t, pointers);
        if (pl.kind === "bare") return;
        const k = lintToks(pl.kind === "mixed" ? pl.keep : t); if (k.size < 8) return;
        let best = null; HL.forEach((h) => { const j = jaccard(k, h.toks); if (j >= 0.8 && (!best || j > best.j)) best = { j, h }; });
        if (best) hit("L4", "error", s, f, t, "restates " + best.h.id + " " + best.h.where + " (" + best.h.home + "): delete it, or keep only this step's own part");
      });
    }
  });
  return lintSort(hits, rec, fl);
}
/* the allow list (record.json lint.allow: { "A7-06": { "rule": "L2", "why": "..." } }) and the lists */
function lintSort(hits, rec, fl) {
  const allow = (((rec && rec.lint) || {}).allow) || {}, errors = [], warnings = [], allowed = [];
  const okd = (h) => { const a = allow[h.id]; if (!a) return false; const rs = Array.isArray(a.rule) ? a.rule : [a.rule]; return rs.includes(h.rule); };
  hits.forEach((h) => {
    const m = fl + ":" + h.id + " " + h.rule + " " + LINT_NAMES[h.rule] + ": " + h.field + (String(h.field).indexOf(String(h.text)) >= 0 ? "" : " '" + short(h.text, 60) + "'") + ": " + h.fix;
    h.line = m;
    if (okd(h)) { h.allowed = true; allowed.push(m + " (allowed: " + allow[h.id].why + ")"); }
    else if (h.level === "error") { if (!errors.includes(m)) errors.push(m); }
    else if (!warnings.includes(m)) warnings.push(m);
  });
  return { errors, warnings, allowed, hits };
}
const LINT_NAMES = { L1: "record variant", L2: "record phrase", L3: "pointer line", L4: "restated rule", L5: "twin drift", L6: "cut", L7: "no safe default", L8: "banned old line" };
/* ---- L6 (TOOL-SPEC 8:20pm #6, #13): record.json "live": { switches, facts, off: { group: [values] }, merged: { facts, switches } } */
function liveSet(rec) {
  const lv = rec && rec.live;
  if (!lv || typeof lv !== "object" || Array.isArray(lv)) return null;
  return { switches: Array.isArray(lv.switches) ? new Set(lv.switches) : null, facts: Array.isArray(lv.facts) ? new Set(lv.facts) : null, off: lv.off && typeof lv.off === "object" ? lv.off : {}, merged: lv.merged && typeof lv.merged === "object" ? lv.merged : {} };
}
/* a name outside the live set: "switch grief (now: sensitive ...)", "fact memberships (now: packs)", "reach notsafe"; or null */
function cutWhat(LV, kind, n, g) {
  if (kind === "switch" || kind === "fact") {
    const set = kind === "switch" ? LV.switches : LV.facts, mg = (LV.merged[kind === "switch" ? "switches" : "facts"] || {})[n];
    return set && !set.has(n) ? kind + " " + n + (mg ? " (now: " + mg + ")" : "") : null;
  }
  const grp = g || CORE.GROUP_OF[n];
  return grp && Array.isArray(LV.off[grp]) && LV.off[grp].includes(n) ? grp + " " + n : null;
}
/* L6 on one step: its vary keys, its own and its branches' when (and whenIn), gates, and its branches' sets: [[field, what]] */
function cutHits(s, LV) {
  const out = [], add = (f, w) => { if (w && !out.some((x) => x[0] === f && x[1] === w)) out.push([f, w]); };
  Object.keys(s.vary || {}).forEach((k) => { const c = parseVaryKey(k) || {}; (c.pf || []).forEach((n) => add("vary '" + k + "'", cutWhat(LV, "switch", n))); (c.booking || []).forEach((v) => add("vary '" + k + "'", cutWhat(LV, "value", v))); });
  const W = (f, w) => { if (!w || typeof w !== "object") return; Object.keys(w).forEach((d) => { const vs = Array.isArray(w[d]) ? w[d] : []; if (d === "switchOn" || d === "switchOff") vs.forEach((n) => add(f + " " + d, cutWhat(LV, "switch", n))); else if (d === "pf" || d === "factOn" || d === "factOff") vs.forEach((n) => add(f + " " + d, cutWhat(LV, "fact", n))); else if (d === "booking") vs.forEach((v) => add(f + " booking", cutWhat(LV, "value", v))); }); };
  W("when", s.when);
  (s.branches || []).forEach((b) => {
    const bw = "branch '" + b.label + "'";
    W(bw + " when", b.when); Object.keys(b.whenIn || {}).forEach((f) => W(bw + " whenIn." + f, b.whenIn[f]));
    if (b.sets && typeof b.sets === "object") Object.keys(b.sets).forEach((g) => { if (g !== "svcAdd" && typeof b.sets[g] === "string") add(bw + " sets", cutWhat(LV, "value", b.sets[g], g)); });
  });
  return out;
}
/* L6 on record.json's own slot rows (their when): problems as text (build-master: errors) */
function liveRecordProblems(rec) {
  const LV = liveSet(rec), p = [];
  if (!LV) return p;
  Object.keys(rec.slots || {}).forEach((n) => ((rec.slots[n] || {}).rows || []).forEach((r, i) => { if (r && r.when) cutHits({ when: r.when }, LV).forEach(([f, w]) => p.push("record.json slots." + n + " row " + (i + 1) + " " + f + ": L6 cut by CUT-LIST: " + w)); }));
  return p;
}
/* record.json's own lint blocks (homes, lint.phrases / pointers / allow): problems as text (build-master: errors) */
function recordLintProblems(rec) {
  const p = [];
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return ["record.json must be an object"];
  if (rec.homes !== undefined) {
    if (!rec.homes || typeof rec.homes !== "object" || Array.isArray(rec.homes)) p.push("record.json homes must be { \"money\": \"S13-55\", ... }");
    else Object.keys(rec.homes).forEach((h) => { if (!/^[SAB]\d+-\d{2,3}$/.test(String(rec.homes[h]))) p.push("record.json homes." + h + " must name a step id, like S13-55"); });
  }
  if (rec.live !== undefined) {
    const lv = rec.live;
    if (!lv || typeof lv !== "object" || Array.isArray(lv)) p.push("record.json live must be { \"switches\": [...], \"facts\": [...], \"off\": {...}, \"merged\": {...} }");
    else {
      ["switches", "facts"].forEach((k) => { if (lv[k] !== undefined && (!Array.isArray(lv[k]) || lv[k].some((x) => typeof x !== "string"))) p.push("record.json live." + k + " must be a list of names"); });
      if (lv.off !== undefined) { if (!lv.off || typeof lv.off !== "object" || Array.isArray(lv.off)) p.push("record.json live.off must be { \"<group>\": [values] }"); else Object.keys(lv.off).forEach((g) => { if (!Array.isArray(lv.off[g])) p.push("record.json live.off." + g + " must be a list of values"); else lv.off[g].forEach((v) => { if (CORE.GROUP_OF[v] && CORE.GROUP_OF[v] !== g) p.push("record.json live.off." + g + ": '" + v + "' is a value of " + CORE.GROUP_OF[v]); }); }); }
    }
  }
  const Lt = rec.lint;
  if (Lt === undefined) return p;
  if (!Lt || typeof Lt !== "object" || Array.isArray(Lt)) return p.concat(["record.json lint must be { \"phrases\": {...}, \"pointers\": [...], \"allow\": {...} }"]);
  Object.keys(Lt).forEach((k) => { if (!["phrases", "pointers", "allow", "banned"].includes(k)) p.push("record.json lint: unknown field '" + k + "' (phrases, pointers, allow, banned)"); });
  const rx = (w, x) => { if (typeof x !== "string" || !x) { p.push(w + " must be a pattern (text)"); return; } try { new RegExp(x, "i"); } catch (e) { p.push(w + " isn't a pattern that reads: " + e.message); } };
  if (Lt.banned !== undefined) {
    const B = Lt.banned;
    if (!B || typeof B !== "object" || Array.isArray(B) || !Array.isArray(B.phrases)) p.push("record.json lint.banned must be { \"phrases\": [patterns, or { \"re\": pattern, \"now\": \"the rule that replaced it\" }] }");
    else {
      Object.keys(B).forEach((k) => { if (!["phrases", "about"].includes(k)) p.push("record.json lint.banned: unknown field '" + k + "' (phrases, about)"); });
      B.phrases.forEach((x, i) => { const w = "record.json lint.banned.phrases " + (i + 1); if (x && typeof x === "object" && !Array.isArray(x)) { rx(w + " re", x.re); if (x.now !== undefined && (typeof x.now !== "string" || !x.now.trim())) p.push(w + " now must be words (the rule that replaced it)"); } else rx(w, x); });
    }
  }
  if (Lt.phrases !== undefined) {
    if (!Lt.phrases || typeof Lt.phrases !== "object" || Array.isArray(Lt.phrases)) p.push("record.json lint.phrases must be { \"money\": [patterns], ... }");
    else Object.keys(Lt.phrases).forEach((h) => { if (!Array.isArray(Lt.phrases[h])) p.push("record.json lint.phrases." + h + " must be a list of patterns"); else Lt.phrases[h].forEach((x, i) => rx("record.json lint.phrases." + h + " " + (i + 1), x)); });
  }
  if (Lt.pointers !== undefined) { if (!Array.isArray(Lt.pointers)) p.push("record.json lint.pointers must be a list of patterns"); else Lt.pointers.forEach((x, i) => rx("record.json lint.pointers " + (i + 1), x)); }
  if (Lt.allow !== undefined) {
    if (!Lt.allow || typeof Lt.allow !== "object" || Array.isArray(Lt.allow)) p.push("record.json lint.allow must be { \"A7-06\": { \"rule\": \"L2\", \"why\": \"...\" } }");
    else Object.keys(Lt.allow).forEach((id) => {
      const a = Lt.allow[id], w = "record.json lint.allow." + id + ": ";
      if (!/^[SAB]\d+-\d{2,3}$/.test(id)) p.push(w + "the key is a step id, like A7-06");
      if (!a || typeof a !== "object") { p.push(w + "must be { \"rule\": \"L2\", \"why\": \"...\" }"); return; }
      const rs = Array.isArray(a.rule) ? a.rule : [a.rule];
      if (!rs.length || rs.some((r) => !LINT_RULES.includes(r))) p.push(w + "rule must be one of " + LINT_RULES.join(", ") + " (or a list of them)");
      if (typeof a.why !== "string" || a.why.trim().length < 8) p.push(w + "needs a why (a real reason)");
    });
  }
  return p;
}
/* the header's "record" (true, false or left out) and the cast names a record master's shared texts may use */
function recordHeaderProblems(head) {
  if (!head || head.record === undefined) return [];
  if (typeof head.record !== "boolean") return ["header record must be true (the booking record: work/master/src/record.json) or false, or left out"];
  return [];
}
/* what a step follows ("reads"), from what it uses (TOOL-SPEC 4): a pay.* or two.* slot, or a took stamp with money words
   -> money; a reach.* slot or a stamped layer line -> contact; a time slot, a timed / timing stamp or a relative t ->
   clock; a who.* slot -> who; a first text (stop: first) -> stop. In READS_KEYS order; [] when none. */
const MONEY_WORDS = /\$\d|\{\{\s*(?:price|fee|deposit|rest|paid|paidnow|due|keep|back|later)\b|\b(?:fees?|deposits?|paid|pays?|charge[sd]?|charges|refund(?:s|ed)?|prices?|credits?)\b/i;
const TIME_SLOT = /\{\{\s*(?:arrive|window|cutoff|day)\s*[:}]/;
function readsOf(s, rec) {
  const got = new Set(), texts = CORE.stepTexts(s).map((x) => x[1]).concat((s.branches || []).map((b) => b.endText).filter((x) => typeof x === "string")), all = texts.join("\n");
  const homes = (rec && rec.homes) || {}, slots = (rec && rec.slots) || {};
  const re = /\{\{\s*([a-z][a-z0-9]*)\.([a-z][a-z0-9]*)\s*\}\}/g; let m;
  /* a record slot: the homes key of its own home (record.json slots.<name>.home), else by its prefix */
  while ((m = re.exec(all))) {
    const n = m[1] + "." + m[2], hid = slots[n] && slots[n].home, hk = hid ? Object.keys(homes).find((k) => homes[k] === hid) : null;
    if (hk) got.add(hk); else if (slots[n] || ["pay", "two", "reach", "who", "clock"].includes(m[1])) got.add(slotHomeKey(n) === "two" ? "money" : slotHomeKey(n));
  }
  if (s.took && (MONEY_WORDS.test(all) || Object.keys(s.vary || {}).some((k) => /(^|\+)(price|before|after):/.test(k)))) got.add("money");
  if (Array.isArray(s.layerAdd) && s.layerAdd.length) got.add("contact");
  if (TIME_SLOT.test(all) || s.timed || s.timing || (s.t && CORE.parseRelT && (CORE.parseRelT(s.t) || {}).anchor)) got.add("clock");
  if ((s.say || []).some((x) => Array.isArray(x) && x[3] && x[3].stop === "first")) got.add("stop");
  return READS_KEYS.filter((k) => got.has(k)).concat([...got].filter((k) => !READS_KEYS.includes(k)).sort());
}
/* the line step.js, readthrough and the page print: "Follows: money (S13-55) · contact (S13-19)" */
const readsLine = (reads, homes) => (reads && reads.length ? "Follows: " + reads.map((k) => k + (homes && homes[k] ? " (" + homes[k] + ")" : "")).join(" · ") : "");
/* record.json as flow fl reads it (F.record): cast slots and {{ab:}} resolved in its words (its lint patterns as written) */
function recordFor(rec, fl, names, problems) {
  const o = {};
  Object.keys(rec || {}).forEach((k) => { o[k] = k === "lint" ? JSON.parse(JSON.stringify(rec[k])) : castDeep(rec[k], names, fl, problems || [], "record.json " + k + ": "); });
  return o;
}
module.exports = { recordOn, CAST_NAMES, castText, castStep, sharedTexts, mergeShared, sharedUseProblems, LINT_RULES, LINT_NAMES, READS_KEYS, recordKeyParts, recordPhrases, lintNorm, homeLines, lintSteps, lintSort, recordLintProblems, recordHeaderProblems, recordFor, readsOf, readsLine, liveSet, cutHits, liveRecordProblems, pointerLine, hasSafeDefault, bannedList, stepLines, bannedFix, recordDeadRows, recordProblems, recordSlotProblems, recordWhenProblems, fixturePaths, pathName, parsePath, loadRecord, flowOfSteps, ridesOn, recWhenProblems, severalPath, switchWalkPaths, WHY_D75, d75Problems, d75HeaderProblems, d75OverlayPlaces, waysOf, dimsFor, waysWhy, waysProblems, waysHeaderProblems, notsafeProblems, WHY_HOLD, WHY_REST, headerWayProblems, setsPathsFor, walkCombo0, walkComboSets, timedSlotReport, nomoneyOk, NOMONEY_AFTER, bookingOffers, offeredTo, litSteps, emptyFamilies, usesStopFirst, stopChecks, amountChecks, moneyKeyReport, headerStamps, stampFlow, headerLayerProblems, decisionDrops, switchGaps, DECISION_LINE, isMix, problemKey, addProblems, beforeCoverage, deadSwaps, varyView, filled, flowTimeProblems, stepWhenText, layerTies, bookingMixes, MIX_CAP, gateText, forFlow, HERE, MSG, CORE, LINES, DIMS, AFTER_IN, validCombo, combos, isFree, freeCombos, comboKey, pathKey, pathsFor, bookingGroupsUsed, factsUsed, gatesUsed, lit, keyFits, parseVaryKey, resolveVary, keySpec, switchTies, freeWordGaps, PF, SETUP, PARTS, moneyKeys, exportsOf, seedsOf, ACTORS, VIAS, LIM, grade, scoreStep, scoreText, checkShape, eachStep, walkCombo };
