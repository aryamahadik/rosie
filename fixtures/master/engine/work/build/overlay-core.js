/* The overlay core (phase 3, Oct 25, 2026): the ONE place where a profession's overlay is applied to a master flow,
   where a branch is lit for a path, and where a step's words are picked for a path. Used by work/build/lib.js and
   overlay.js (node), and by the page: site/build.js inlines this file before site/src/app.js, so the page and the
   scripts can never apply an overlay differently. Plain JavaScript (no require, ES5 style): node and any browser.

   A PATH ("combination") is { price, before, after, booking, pf, facts }:
     price / before / after   the money choices (lib.js DIMS)
     booking                  booking choices set once per booking: { timing: "sentnow", times: "setstart" } (BOOKING
                              below; a group left out has its first value)
     pf                       the plug-in switches the profession turns on: { sensitive: true } (SWITCHES; missing = off)
     facts                    the plug-in facts the profession lists: ["rents", "weather"], or null when it lists none
                              (then every fact-gated branch shows, as before facts existed)

   A branch's `when` (which paths light it): { price: [...], before: [...], after: [...] } as before, plus
     booking: ["sentnow"]       a booking choice (several values: any of them, per group)
   and GATES on the plug-in (they never make a split a choice split, which is one whose branches all carry money or
   booking choices):
     pf: ["rents"] (= factOn)   shown when the work has any of these FACTS; a work with no facts list: shown
     factOff: ["nomoney"]       hidden when the work has any of these facts; no facts list: shown
     switchOn: ["standin"]      shown when any of these SWITCHES is on (a switch with no plug-in value is off)
     switchOff: ["fixeddate"]   hidden when any of these switches is on
   A STEP can carry a `when` too: the step (and its branches) is skipped where it fails, like S1-27 with
   { "factOff": ["nomoney"] }; since part B it may also name money and booking choices ({ "price": ["photos", "visit"] }),
   so a what-if that can't happen on a path dims there. With no switch and no facts list set, every gate but switchOn
   shows.

   A step's `vary` keys (other words for some paths):
     "before:hold", "after:bill", "price:visit", "booking:sentnow"   CHOICE keys: the most specific that fits wins
                                                                     (each money choice or booking group named = 1)
     "pf:sensitive", "pf:credit+before:deposit"                       SWITCH keys (any key naming a pf: switch): laid
                              over the choice words AFTER them, field by field, least specific first, when every
                              part fits (all its switches on). Two switch keys of the same specificity that both fit
                              and set the same field are a tie (add a joined key, "pf:no2+pf:sensitive").
   A variant may set does, more, say, rule, t, form, table (never the title, ids or keys).

   Plug-in switches and facts live in the plug-in: "plugin": { ..., "pf.switches": { "sensitive": true },
   "pf.facts": ["rents", "weather"] } (a switch may also be { "A": true, "B": false }). Every switch is OFF unless the
   profession turns it on, so the base and choice words are the safe default. The master's header can add switches
   and facts (header.json "switches" / "facts": { "name": { "label", "means" } }).

   Part B (Oct 25, tool editor B):
   - BOOKING keys are laid over the money words like switch keys: "booking:callsonly" adds or replaces only the fields
     it gives, on every money path (so one variant per step carries calls-only words). Choice keys are money only now
     ("before:hold", "price:list+after:bill"); every key naming pf: or booking: is a LAYER key. A new booking group,
     paidby (money | credit), lets later steps pick "paid by a credit" words per booking ("booking:credit").
   - A variant may also carry "swap": [["old words", "new words"], ...] (whole words, like renames, run on the words
     under it), "addMore": [...] and "addSay": [[...], ...] (lines and messages added after the words under it), so a
     switch can change one line of a money path's message without replacing it. Order in one layer: swap, then the
     fields it sets, then the adds.
   - A step's `t` may be RELATIVE: "right after", "right after A6-26", "4 days after A9-02", "2 hours before B8-04",
     "the next morning", "the next morning, 10am", "the next day after A8-01", "the same day, 6pm", "later that day",
     "the day before A8-03, 6pm", "the day of A8-01, 7am" (no step id = the timed step before it on the path).
     parseRelT reads one; stepTimes() resolves every step's time(s) on a path (the page draws them; the clock scan has
     its own walk).
   - AUTO-FILL SLOTS in any text: {{alex.staff}} / {{alex.staff:Alex M.}} / {{name.staff:Dee W.}} (initials when the
     switch sensitive is on: "A.M."), {{svc.intext:Skin fade}} (the service name, or nothing when sensitive is on; an
     empty fill takes one separator next to it, " · " or ", "; {{svc.intext:Skin fade|visit}} gives "visit" instead),
     {{arrive:8–10am}} ("arriving 8–10am", or "starts at 8:00am" for a set-start business), {{window:8–10am}} (the same
     without the verb), {{cutoff:Fri 11am}} (the free-cancel cutoff from the business's sign-up setting; "@<visit>"
     after the example names the visit it belongs to), {{keep:words}} (renames never change these words). A slot
     shows its example words unless the profession's plug-in says otherwise ("pf.switches", "pf.settings": { "arrive":
     "setstart" | "window" | { "window": 3 }, "cutoff": "24 hours before" | "7am the day of" | "6pm the day before" }).
     Slots are filled when an overlay is applied, BEFORE its renames, so rename pairs see the words as before.
   - pf:no2 is DERIVED from the profession's choice at the $2 split (flow A: S1-65, flow B: S1-62, else the other one):
     the "Yes, $2" branch turned off means no2 is on (DECISIONS D8). A "pf.switches" no2 that disagrees is a problem.
   - The plug-in slot's own examples (S1-11 slot.examples) are never renamed.

   Tools C (Oct 25, tool editor C; break-4 CU3):
   - PRIVACY is its own booking group, privacy: open | private, read like the others ("booking:private" keys,
     "when": { "booking": ["private"] }), so one booking can be calls only AND private ("booking:callsonly+booking:private").
   - Implied values (IMPLIES): reach notsafe ("texts aren't safe") always reads privacy "private"; bookingValue() gives
     the implied value first, bookingCanon() takes implied (or contradicting) values out of a path's choices, and
     withImplied() writes them in (the page's picker). lib.js pathsFor walks privacy together with every reach value.
   - A profession can't limit privacy (bookingOf keeps both values; money.<flow>.booking.privacy is a problem).
   - T1 (STATE.md): money words by what this booking TOOK. header.json "took": { "A": "A5-04", "B": "B5-02" } names the
     money step; build-master and check-part stamp that step and every later one "took": "<flow>" (a step can keep the
     service's words with "took": false), and its branches' money whens too. Stamped, resolveVary and lit read the money
     through tookPath(): calls only or taken "nothing" read nothing before and the rest at the visit; a credit reads a
     deposit or the full price as nothing, a hold as a saved card, and nothing after (with nothing taken too: tools E). New booking group taken: asked | nothing (calls only
     implies nothing). No "took" in the header: nothing is stamped and every word reads as before.
   - T2 (STATE.md): layer lines. header.json "layerLines": [{ "id", "when", "to": ["owner","staff"], "line", "way",
     "sections", "more" }]: stamped on the steps that message those people ("layerAdd"), added to each such message
     last on every path where `when` fits, so no key removes it.

   Tools D (Oct 25, tool editor D; DESIGN.md 9.2):
   - Two booking groups: approval (now | ownerok | expert: booked now, the owner's OK first, an expert's read first; set by
     A4-98 / B4-115) and madeby (customer | shop: the business booked it for its own customer). Like privacy and taken,
     each is listed for a profession only once a flow reads it.
   - eventsUnderChoice(): a split whose branches all carry booking choices, two of them the very same ones (A3-01's ways
     in, each lit for madeby customer, beside "The business books it" for shop): events under one choice, so more than
     one may light on a path (at least one must).
   - A fact photos (the plug-in shows work photos: B4-69, A4-65's photos question).
   - pf:no2 is read from S1-62 first in both flows (S1-65 merges into it; DESIGN 9.2 #11).
   - AMOUNT SLOTS {{price}}, {{fee}}, {{deposit}}, {{rest}}, {{hold}}, {{paid}} (or with example words, {{price:$35}}):
     filled per path by resolveVary from the amount table stamped on the step ("amounts", from header.json
     flows.<flow>.amounts: rows keyed "list|card|counter", "list|*|*" or "*", the most specific row winning field by
     field; a profession's money.<flow>.amounts lays its own rows over it), else the example words. With no path, the
     example words.
   - firstTexts() and applyStops(): the conditional opt-out element ("stop": "first") shows only on the first text a
     number gets on the walked path (D61, STATE C5).
   - A branch may carry "sets": { "privacy": "private" }: a booking value that changes mid-booking ("made private after
     booking"); the branch's own steps read the path with that value (withSets).

   Tools F (Oct 26, tool editor F; FIX-PLAN T4):
   - A LATE VALUE: times "line" (A place in a live line: B4-83's sixth branch). Kept in BOOKING.times.late, not in
     values, so it is walked, listed and offered only once a flow names it (a `when` or a key: valuesRead()); a flow that
     never names it reads exactly as before. groupValues(g, read) gives a group's values with the late ones the flow
     reads; bookingLabel(v) gives any value's words. A profession uses it only when it lists it
     (money.<flow>.booking.times: ["window", "line"]): a live line is an extra the business turns on.
   - times "line" implies timing "sentnow" (IMPLIES): staying in the line books a job sent now, so every sent-now
     branch and key fits a live-line path, and a line path is never walked with "a set time".
   Tools F (FIX-PLAN T3): TIME SLOTS READ THE BOOKING'S TIMING. header.json "timed": { "B": "B4-16" } names the step where
     the booking's timing is decided; build-master and check-part stamp every flow step after it (after its branches; A or B
     ids, sections 3-10; a step can say "timing": false) with "timing": "<flow>". {{arrive}}, {{window}}, {{cutoff}} and the
     new {{day}} (the visit's day: {{day:Thu Oct 22}}) are filled as before (the set-time words); on a step stamped
     "timing" the fill also stamps "timed": [[set words, sent-now words, live-line words], ...]. On a path
     whose timing is sent now (a live line implies it), resolveVary puts the sent-now words (the live-line words on a line
     path) in place of the set words, after every key. Sent-now words: what the slot says after "|" ({{arrive:8–10am|about
     8:03pm}}, {{cutoff:7am Thu|Jordan is on the way}}, {{day:Thu Oct 22|Mon Oct 19}}; a second "|" gives the live-line
     words), else "in about 60 to 90 minutes" (arrive: "arriving in about 60 to 90 minutes"), "the pro is on the way"
     (cutoff), "today" (day); live line: "when your place in line comes up" (arrive: "arriving when ..."), the same cutoff,
     "today". Renames reach the stamped words too. No "timed" in the header: nothing is stamped, every word as before.

   Tools G (Oct 26, tool editor G; break-5 CU1, BA1, BA4, CU3):
   - A branch's "sets" ({ "reach": "notsafe" }, any booking group) now holds for the REST OF THE PATH: its own steps, and,
     when the branch rejoins, every step after its split (climbing out through each enclosing branch that rejoins), so
     their words, layer lines, money (T1) and time slots (T3) read the new value. walkSets() walks a path in page order
     with the path(s) each step is reached with: after a lit sets branch rejoins, the later steps are reached with the
     changed path (setBy names the branch) and, where another lit branch rejoins too, with the path as it was. A path
     that already had the value reads the same (one path). setsScopes() gives each sets branch's steps (own) and the
     steps after it (after), for the tools that read a step at a time (the page, ripple, the read files); lateSets() is
     true once a flow has a sets branch that rejoins (none: every walker reads exactly as before).
   - withSets keeps what the booking already took: a group in HISTORIC (taken) keeps the path's value unless the sets
     names it (a calls-only booking that took nothing still took nothing after "this phone isn't safe"; a booking that
     took a card keeps it after a change to calls only, held by "pin", which bookingValue reads first). The values a
     sets implies apply (notsafe reads private, tools C).
   - Layer lines go only on Rosie's messages to the people named (a message from someone else to the owner is that
     person's own words: no line is added to it, nor stamped for it).

   Tools H (Oct 26, tool editor H; SIMPLIFY-PLAN.md section 6 TL-1, TL-2; DECISIONS D66, D67):
   - THE MONEY WAYS. header.json "ways": { "before": ["none", "card", "deposit", "full"], "restLater": false } marks the
     D66 master (build-master writes it into each flow as money.ways). useWays(w) sets it for what a tool reads; fillFlow,
     apply and forPage set it from the flow they are given (a flow with a money block: its money.ways, or none), so every
     tool follows the master it reads, and ways() gives it (null: every master before D66, which reads exactly as before).
     lib.js combos() and validCombo() read it (no hold path; with restLater false, no deposit with nothing after).
   - With ways (TL-2): reach "notsafe" means "Stopped for safety": a number stopped for safety by a branch's "sets"
     (A7-97 / B7-94 [Says their phone isn't safe now]). It no longer implies privacy "private" (IMPLIES loses it), and it
     is a SETS-ONLY value: kept out of the group's values, so no walk starts with it, no picker or profession list offers
     it, and only a branch's sets (withSets) puts it on a path; allValues() and bookingLabel() still know it. textTo()
     still sends the customer no text on it. Without ways, notsafe is the old "Not safe to contact", implying private.

   Tools I (Oct 26, tool editor I; FIX7-PLAN.md section 6 TF-1; DECISIONS D75, D77):
   - D75: NO NOT-SAFE MODE. header.json "d75": true marks the master after D75 (a customer changes where updates go from
     their own chat, A7-98 / B7-88; nothing is "stopped for safety"). build-master writes it into each flow as "d75": true;
     useD75(on) sets it for what a tool reads, syncWays() also reads it from the flow it is given (fillFlow, apply,
     forPage), and d75() gives it. reach notsafe stays known but DORMANT: a sets-only value (as with the ways: no walk
     starts with it, no picker or profession list offers it; it implies nothing), so overlays, vary keys and ripple's
     rules that name it still parse; on the fixed master no branch sets it, so it is never walked. lib.js d75Problems()
     makes any key, `when` or sets naming it an error. No "d75": every table and every output exactly as before.

   Tools J, E1 (Oct 26, REDESIGN 2; work/phase3/redesign2/TOOL-SPEC.md 1.1-1.4, 2.1-2.3, 3): THE BOOKING RECORD.
   - useRecord(tbl, fl, amounts) loads a flow's record table (work/master/src/record.json, carried by the joined flow as
     F.record; syncWays(F) calls it with F.record, F.id and F.amounts), record(fl) gives it, recordOn() says whether any
     is loaded. With none loaded, every table and every output is exactly as before.
   - While a record is loaded there are two more booking groups, EVENTS: charge (none | later | failed) and contact
     (kept | switched | stopped), late groups (a profession lists them only once a flow reads them). They are read only
     on a step or a `when` stamped "ev" (lib.js stampFlow, from record.json "from" on): anywhere else bookingValue() gives
     their default (noEvents), so a failed charge never reaches the booking page.
   - A path may carry services: c.svc = [{ id, price, before, after, paidby, amounts, later, own }] (a fixture's or a
     branch's "sets": { "svcAdd": "<service id>" }); c.fix names the fixture that made it, c.base the money path it rode.
     withSets() handles svcAdd: the service is added (the path's own service first), the path's price / before / after
     become the D73 combined path (severalOf, the same reading as lib.js severalPath) and, when the added service takes
     money now, charge reads later.
   - recordOf(c, fl, took, amounts) -> { svc, ledger: { now, due, keep, back, later } (each { n, text }), card, credits,
     several, charge, contact: { reach, privacy, state }, who: { madeby, approval }, facts }: the record's ways table
     (record.json "ways", else RECORD_WAYS) summed over the services, by what the booking took (took) or what the services
     ask (not took: taken and calls only ignored). A failed charge took nothing from the services it charged.
   - REC, the eight record facts (nothing, card, paid, full, rest, credit, several, keep), usable in any `when` as
     { "rec": [...] } (any holds) and { "recOff": [...] } (none holds); recFits(list, c, fl, took). chooses() counts them.
   - RECORD SLOTS {{pay.late}} (RECORD_SLOT_RE, recordSlotsIn(step)): on a step stamped "rec" (lib.js stampFlow),
     fillRecord(step, c, fl) puts in the first row of record.json slots.<name>.rows whose `when` fits the path (read as the
     step's keys read it: what was taken on a took step, the events on an ev step); no path: the flow's main path
     (record.json "main"). Order in resolveVary: keys, then record slots, then amount slots (with the LEDGER AMOUNTS
     {{paidnow}}, {{due}}, {{keep}} (bare: {{keep:words}} is still the words-renames-never-change slot), {{back}},
     {{later}}), then time slots. A slot no row fits stays as written (the checkers report it). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.OverlayCore = factory();
})(this, function () {
  "use strict";
  var MONEY = ["price", "before", "after"];
  /* the plug-in switches (DECISIONS.md D16; all off by default; header.json may add more) */
  var SWITCHES = {
    sensitive: { label: "Sensitive work", means: "Owner and staff texts use initials; no text, email, receipt or reminder names the service or why; prep and aftercare always a link; no rating texts (D16, D41)." },
    no2: { label: "No Rosie $2", means: "Every $2 line reads: this work pays no Rosie $2 (human health practices and law firms by default; D8)." },
    standin: { label: "Stand-in on no reply", means: "A stand-in with the skill and license may keep the time when the customer doesn't answer (routes, seats, spaces, interchangeable crews). Never a booking that named a person, a child or someone in care. Off: Sam reaches the customer; nobody moves on silence." },
    credit: { label: "Paid by a credit", means: "The booking was paid by a credit (a pack, package or membership session): fee, cancel, no-show and refund words speak of the credit (D12)." },
    fixeddate: { label: "The date can't move", means: "No new-time choices; a stand-in with the skill or a cancel with everything paid back; a late count or missing paper never moves the date." },
    cancelright: { label: "Written cancel right", means: "Work sold at the customer's place where the state form gives a written cancel period: the notice with its last day, nothing starts inside it. Off: no cancel period for work already given." },
    grief: { label: "Grief or end of life", means: "No fees asked, nothing sold, no rating, gentle words; marked passed stops every text about that person or pet (D39)." },
    welfare: { label: "Welfare check", means: "The person served may be unable to answer: nobody answering runs a safety check before any no-show words (M-059)." },
    reservedfull: { label: "Reserved time paid in full", means: "Leaving early still pays the full reserved time (a boat, a tour seat, a room). Off: only the part done is charged." },
    freeno: { label: "Free on-site estimate", means: "A no at the visit owes nothing; a hold is only for a late cancel or nobody there. Off: the visit fee is owed." },
    nomoney: { label: "No money through Rosie", means: "Nothing is ever paid through Rosie: every service is free or the business's own way (D7). Also list the fact nomoney." },
    business: { label: "Business customers", means: "Customers are businesses (an office, a store, a site): flow B speaks of the place, not the home. (Tool addition, used by check-prof.)" }
  };
  /* the plug-in facts (DECISIONS.md D17): kinds of work a what-if branch can be about */
  var FACT_LIST = [
    ["rents", "rented items, damage holds, items come back"], ["weather", "outdoor work or weather limits"], ["plans", "repeat plans"],
    ["memberships", "memberships"], ["packs", "packs, packages, credits, make-ups"], ["series", "a series of sessions"], ["groups", "groups"],
    ["classes", "sessions, seats, a minimum to run"], ["firststeps", "patch tests, consults, estimates, meet-and-greets"], ["forms", "forms and waivers to sign"],
    ["permits", "permits, inspections, outside checks"], ["contracts", "signed contracts and estimates"], ["landlord", "the place's owner matters"],
    ["sentnow", "work sent now"], ["oncall", "on call for a client in care"], ["results", "results or reports later; pass or fail"],
    ["planbill", "a health or warranty plan pays"], ["claims", "the customer's own insurance claim"], ["parts", "ordered parts, orders that can be late"],
    ["stock", "items held or counted"], ["dropoff", "items left with the business; mail-in"], ["delivery", "delivery and setup"], ["multiday", "jobs over several days"],
    ["crews", "crews"], ["spaces", "spaces or rooms"], ["children", "children served"], ["incare", "people who can't be left alone"], ["animals", "animals"],
    ["video", "video visits"], ["hosts", "visit days at a host's place"], ["proposals", "proposals"], ["aftercare", "aftercare"], ["returnleg", "return legs, will call"],
    ["events", "business events, recitals"], ["storage", "items not picked up"], ["nomoney", "no money through Rosie (also the switch nomoney)"],
    /* Tools D (DESIGN 9.2 #10) */
    ["photos", "work photos the plug-in shows (the photos question on the booking page)"]
  ];
  var FACTS = {};
  FACT_LIST.forEach(function (f) { FACTS[f[0]] = { label: f[0], means: f[1] }; });
  /* booking choices (DECISIONS.md D18): set once per booking, read later like money. The first value is the default. */
  var BOOKING = {
    timing: { label: "When it's booked for", values: [["settime", "A set time"], ["sentnow", "Sent now"]] },
    times: { label: "How times read", values: [["window", "An arrival window"], ["setstart", "A set start"], ["stay", "A stay"], ["seat", "A seat"], ["noperson", "No person"]],
      /* Tools F (T4): a late value, walked and listed only once a flow names it (groupValues); a profession lists it */
      late: [["line", "A place in a live line"]] },
    reach: { label: "How the customer is reached", values: [["texts", "Texts"], ["callsonly", "Calls only"], ["textsonly", "Texts only"], ["email", "Email"], ["notsafe", "Not safe to contact"]] },
    paidby: { label: "How this booking is paid", values: [["money", "As its money choice says"], ["credit", "Paid by a credit"]] },
    /* Tools C (Oct 25, break-4 CU3): a private booking is its own setting, on top of any way of reaching the person
       (texts, calls only, texts only, email), so "calls only" and "private" can both hold on one booking */
    privacy: { label: "Private booking", values: [["open", "Not private"], ["private", "Private booking"]] },
    /* Tools C (STATE.md T1): what this booking took when nothing was (the owner's "Book it with no card?" yes, a
       shop-added booking, paid outside Rosie); calls only implies it */
    taken: { label: "What this booking took", values: [["asked", "As the service asks"], ["nothing", "Nothing taken"]] },
    /* Tools D (DESIGN 9.2 #1): who must say yes before the booking stands, decided once (A4-98 / B4-115) and followed
       later (A6-01 / B6-03's branches; the words of A4-42 and A5-04 / B5-02): never decided again */
    approval: { label: "Who OKs the booking", values: [["now", "Booked now"], ["ownerok", "The owner's OK first"], ["expert", "An expert's read first"]] },
    /* Tools D (DESIGN 9.2 #2): who made the booking: the customer, or the business for its own customer (the business's
       booking skips the chat questions its read-back already answered: steps gated { "booking": ["customer"] }) */
    madeby: { label: "Who made the booking", values: [["customer", "The customer"], ["shop", "The business"]] }
  };
  /* groups added after part B: listed for a profession (bookingOf) only once a flow reads them, so a flow that doesn't
     reads exactly as before */
  var LATE_GROUPS = ["privacy", "taken", "approval", "madeby"];
  var GROUP_OF = {};
  Object.keys(BOOKING).forEach(function (g) { BOOKING[g].values.forEach(function (v) { GROUP_OF[v[0]] = g; }); });
  /* Tools F (T4): late values (a group's values kept out of its walk until a flow names them) */
  var LATE_VALUES = {};
  Object.keys(BOOKING).forEach(function (g) { (BOOKING[g].late || []).forEach(function (v) { GROUP_OF[v[0]] = g; LATE_VALUES[v[0]] = g; }); });
  /* a group's values, every one (the late ones last; tools H: then the sets-only ones): for labels and checks */
  function allValues(g) { return BOOKING[g] ? BOOKING[g].values.concat(BOOKING[g].late || [], BOOKING[g].setsOnly || []) : []; }
  /* a group's values to walk or list: its values, then the late ones `read` names (an array, an object of names, or true
     for all); with no late value read, exactly BOOKING[g].values */
  function groupValues(g, read) {
    var out = BOOKING[g] ? BOOKING[g].values.map(function (v) { return v[0]; }) : [];
    (BOOKING[g] && BOOKING[g].late || []).forEach(function (v) {
      var on = read === true || (Array.isArray(read) ? read.indexOf(v[0]) >= 0 : !!(read && typeof read === "object" && (typeof read.has === "function" ? read.has(v[0]) : read[v[0]])));
      if (on) out.push(v[0]);
    });
    /* Tools J (E1 fix): a value the loaded record cuts (record.json live.off) is never walked or offered */
    return liveOn(g) ? out.filter(function (v) { return !isLiveOff(g, v); }) : out;
  }
  /* a booking value's words ("A place in a live line"), or the value itself */
  function bookingLabel(v) { var g = GROUP_OF[v], x = g ? allValues(g).filter(function (y) { return y[0] === v; })[0] : null; return x ? x[1] : v; }
  /* Tools C: booking values another value implies. "Texts aren't safe" (reach notsafe) is always a private booking, so a
     path with reach notsafe reads privacy "private" whatever else it says (an "open" there can't happen). */
  var IMPLIES = { reach: { notsafe: { privacy: "private" }, callsonly: { taken: "nothing" } },
    /* Tools F (T4): a place in a live line is a job sent now (B3-09: staying books it as a job sent now) */
    times: { line: { timing: "sentnow" } } };
  var IMPLIED = {};
  Object.keys(IMPLIES).forEach(function (h) { Object.keys(IMPLIES[h]).forEach(function (v) { Object.keys(IMPLIES[h][v]).forEach(function (g) { IMPLIED[g] = true; }); }); });
  /* Tools H (TL-1, TL-2; D66): the master's money ways (null before D66). With ways, reach notsafe is "Stopped for safety":
     a sets-only value (BOOKING.reach.setsOnly, out of the walked values) that implies no private booking. The tables are
     changed in place (lib.js and the page hold them), and put back exactly when the ways go. */
  var WAYS = null, BEFORE_WAYS = ["none", "card", "hold", "deposit", "full"];
  var NOTSAFE_OLD = BOOKING.reach.values.filter(function (v) { return v[0] === "notsafe"; })[0], NOTSAFE_AT = BOOKING.reach.values.indexOf(NOTSAFE_OLD);
  var NOTSAFE_D66 = ["notsafe", "Stopped for safety"], REACH_IMPLIES0 = Object.keys(IMPLIES.reach).map(function (k) { return [k, IMPLIES.reach[k]]; });
  /* a header "ways" block read: { before: [...], restLater: true|false }, or null (no block, or not an object) */
  function normWays(w) {
    if (!w || typeof w !== "object" || Array.isArray(w)) return null;
    return { before: Array.isArray(w.before) ? w.before.filter(function (b) { return BEFORE_WAYS.indexOf(b) >= 0; }) : BEFORE_WAYS.slice(), restLater: w.restLater !== false };
  }
  function ways() { return WAYS; }
  /* Tools I (TF-1, D75): the master after D75 (header "d75": true; false before). With it, notsafe is sets-only too. */
  var D75 = false;
  function d75() { return D75; }
  /* the reach tables for the ways and D75 read now: notsafe sets-only and implying nothing with either, as before with neither */
  function reachTables() {
    var R = BOOKING.reach, i = R.values.indexOf(NOTSAFE_OLD);
    if (WAYS || D75) { if (i >= 0) R.values.splice(i, 1); R.setsOnly = [NOTSAFE_D66]; delete IMPLIES.reach.notsafe; }
    else { if (i < 0) R.values.splice(NOTSAFE_AT, 0, NOTSAFE_OLD); delete R.setsOnly; Object.keys(IMPLIES.reach).forEach(function (k) { delete IMPLIES.reach[k]; }); REACH_IMPLIES0.forEach(function (x) { IMPLIES.reach[x[0]] = x[1]; }); }
    /* Tools J (TOOL-SPEC change 5): with a record loaded, calls only never changes money (no taken "nothing" implied) */
    var co = REACH_IMPLIES0.filter(function (x) { return x[0] === "callsonly"; })[0];
    if (EVENTS) delete IMPLIES.reach.callsonly; else if (co && !IMPLIES.reach.callsonly) IMPLIES.reach.callsonly = co[1];
    Object.keys(IMPLIED).forEach(function (g) { delete IMPLIED[g]; });
    Object.keys(IMPLIES).forEach(function (h) { Object.keys(IMPLIES[h]).forEach(function (v) { Object.keys(IMPLIES[h][v]).forEach(function (g) { IMPLIED[g] = true; }); }); });
  }
  function useWays(w) {
    var nw = normWays(w);
    if (JSON.stringify(nw) === JSON.stringify(WAYS)) return WAYS;
    WAYS = nw;
    reachTables();
    return WAYS;
  }
  function useD75(on) {
    var nv = on === true;
    if (nv === D75) return D75;
    D75 = nv;
    reachTables();
    return D75;
  }
  /* the ways of the flow a tool is given: a flow with a money block sets them (its money.ways, or none); anything else
     (a list of steps, a made-up part) leaves them as they are. Tools I: and its D75 mark (the flow's "d75": true, or none) */
  function syncWays(F) { if (F && typeof F === "object" && F.money && typeof F.money === "object" && !Array.isArray(F.money)) { useWays(F.money.ways || null); useD75(F.d75 === true); useRecord(F.record || null, F.id, F.amounts); } }
  /* Tools J (E1; TOOL-SPEC 1.1): the event groups, booking groups only while a record table is loaded (so a master
     without one reads every table, list and message exactly as before); changed in place, like the reach tables */
  var EVENT_GROUPS = {
    charge: { label: "A charge after booking", values: [["none", "No charge after booking"], ["later", "A charge after booking went through"], ["failed", "A charge failed, not paid yet"]] },
    contact: { label: "Where updates go", values: [["kept", "As booked"], ["switched", "Updates go to a new phone or email"], ["stopped", "Texts stopped by STOP"]] },
    /* (TOOL-SPEC change 7: someone else pays, set by a branch's sets (A4-24 / B4-32); not an event: read on every step) */
    payer: { label: "Who pays", values: [["self", "The customer pays"], ["other", "Someone else pays"]] }
  };
  /* the event groups proper (read only on an "ev" step); payer is a record group read everywhere */
  var EV_GROUPS = ["charge", "contact"];
  var EVENTS = false, PRIVATE0 = BOOKING.privacy.values[1], PRIVACY_LABEL0 = BOOKING.privacy.label;
  function eventTables(on) {
    if (on === EVENTS) return;
    EVENTS = on;
    Object.keys(EVENT_GROUPS).forEach(function (g) {
      var i = LATE_GROUPS.indexOf(g);
      if (on) { BOOKING[g] = EVENT_GROUPS[g]; EVENT_GROUPS[g].values.forEach(function (v) { GROUP_OF[v[0]] = g; }); if (i < 0) LATE_GROUPS.push(g); }
      else { delete BOOKING[g]; EVENT_GROUPS[g].values.forEach(function (v) { if (GROUP_OF[v[0]] === g) delete GROUP_OF[v[0]]; }); if (i >= 0) LATE_GROUPS.splice(i, 1); }
    });
    /* TOOL-SPEC change 8: privacy is the discreet mark, set only by a branch's sets (a sets-only value, as notsafe is
       with the ways: no walk starts with it, no picker or profession list offers it) */
    var P = BOOKING.privacy, j = P.values.indexOf(PRIVATE0);
    if (on) { if (j >= 0) P.values.splice(j, 1); P.setsOnly = [PRIVATE0]; P.label = "Discreet"; }
    else { if (j < 0) P.values.splice(1, 0, PRIVATE0); delete P.setsOnly; P.label = PRIVACY_LABEL0; }
    reachTables();
  }
  /* the record tables per flow: { A: { tbl, amounts }, B: ... }; useRecord(tbl, fl, amounts) sets one flow's (no flow:
     both), a table that isn't an object clears it; record(fl) gives it, or null */
  var RECORDS = {};
  function useRecord(tbl, fl, amounts) {
    var ok = !!tbl && typeof tbl === "object" && !Array.isArray(tbl), fs = fl === "A" || fl === "B" ? [fl] : ["A", "B"];
    fs.forEach(function (f) { if (ok) RECORDS[f] = { tbl: tbl, amounts: amounts && typeof amounts === "object" ? amounts : null }; else delete RECORDS[f]; });
    eventTables(!!(RECORDS.A || RECORDS.B));
    return ok ? tbl : null;
  }
  function record(fl) { return RECORDS[fl] ? RECORDS[fl].tbl : null; }
  /* Tools J (E1 fix, after the rebuild's A36 / B36): record.json "live": { "off": { "<group>": [values] } } of the tables
     loaded (either flow): those values are cut, so no walk, list, mix, scan or picker gives them (overlays still parse them;
     the lint names them) */
  function liveOff() {
    var out = {};
    ["A", "B"].forEach(function (f) { var t = record(f), off = t && t.live && t.live.off; if (off && typeof off === "object" && !Array.isArray(off)) Object.keys(off).forEach(function (g) { (Array.isArray(off[g]) ? off[g] : []).forEach(function (v) { (out[g] = out[g] || []); if (out[g].indexOf(v) < 0) out[g].push(v); }); }); });
    return out;
  }
  function liveOn(g) { return !!(RECORDS.A || RECORDS.B) && !!liveOff()[g]; }
  function isLiveOff(g, v) { var o = liveOff()[g]; return !!o && o.indexOf(v) >= 0; }
  function recordOn() { return !!(RECORDS.A || RECORDS.B); }
  /* the record slot names of the tables loaded (either flow) */
  function recordSlotNames() { var out = []; ["A", "B"].forEach(function (f) { var t = record(f); if (t && t.slots && typeof t.slots === "object") Object.keys(t.slots).forEach(function (n) { if (out.indexOf(n) < 0) out.push(n); }); }); return out; }
  /* a path with the event groups at their defaults (a step or `when` not stamped "ev"), or the path itself */
  /* (a service added after booking, "later", is an event too: before it the path reads its other services' money path).
     TOOL-SPEC change 16: only what a fixture (or a walk from the first step) seeded goes back to its default; a value a
     branch's sets put on the path (c.evSet, a service added by svcAdd) is read on every later step, stamped or not. */
  function noEvents(c) {
    if (!EVENTS || !c) return c;
    var es = c.evSet || [], fx = function (g) { return es.indexOf(g) < 0; };
    var b = c.booking, p = c.pin, hb = !!b && ((fx("charge") && has(b, "charge") && b.charge !== "none") || (fx("contact") && has(b, "contact") && b.contact !== "kept")), hp = !!p && ((fx("charge") && has(p, "charge")) || (fx("contact") && has(p, "contact")));
    var hl = !!c.svc && c.svc.some(function (x) { return x && x.later && !x.bySets; });
    if (!hb && !hp && !hl) return c;
    var out = Object.assign({}, c);
    if (hb) { out.booking = Object.assign({}, b); EV_GROUPS.forEach(function (g) { if (fx(g)) delete out.booking[g]; }); }
    if (hp) { out.pin = Object.assign({}, p); EV_GROUPS.forEach(function (g) { if (fx(g)) delete out.pin[g]; }); if (!Object.keys(out.pin).length) delete out.pin; }
    if (hl) {
      var keep = c.svc.filter(function (x) { return !x.later || x.bySets; }), fl = (c.svc.filter(function (x) { return x.later && (x.flow === "A" || x.flow === "B"); })[0] || {}).flow || "A";
      if (keep.length === 1 && keep[0].own) { delete out.svc; out.price = keep[0].price; out.before = keep[0].before; out.after = keep[0].after; }
      else { out.svc = keep; var sp = severalOf(fl, keep, c); if (sp) { out.price = sp.price; out.before = sp.before; out.after = sp.after; } }
    }
    return out;
  }
  /* is a booking value sets-only (only a branch's sets puts it on a path)? */
  function setsOnly(v) { var g = GROUP_OF[v]; return !!(g && BOOKING[g].setsOnly && BOOKING[g].setsOnly.some(function (x) { return x[0] === v; })); }
  var NAME = /^[a-z][a-z0-9]*$/;
  var has = function (o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); };

  /* ------------------------------------------------------------ paths, branches and keys */
  function switchOn(c, name) { return !!(c && c.pf && has(c.pf, name) && c.pf[name] === true); }
  /* a value another group's value implies on this path (IMPLIES), or null */
  function impliedValue(c, g) {
    if (!IMPLIED[g]) return null;
    var out = null;
    Object.keys(IMPLIES).some(function (h) {
      if (h === g) return false;
      var v = (c && c.booking && c.booking[h]) || (BOOKING[h] ? BOOKING[h].values[0][0] : null), imp = IMPLIES[h][v];
      if (imp && imp[g]) { out = imp[g]; return true; }
      return false;
    });
    return out;
  }
  /* the path's value for a booking group: an implied value first, then what it says, or the group's first value */
  function bookingValue(c, g) { return (c && c.pin && c.pin[g]) || impliedValue(c, g) || (c && c.booking && c.booking[g]) || (BOOKING[g] ? BOOKING[g].values[0][0] : null); }
  /* a path's booking choices with the implied ones taken out (a value implied by another, or one that contradicts it):
     two paths that read the same have the same canonical choices (pathsFor drops the repeat) */
  function bookingCanon(b) {
    if (!b) return b;
    var out = {};
    Object.keys(b).forEach(function (g) { if (!impliedValue({ booking: b }, g)) out[g] = b[g]; });
    return out;
  }
  /* a path's booking choices with the implied ones written in, for the groups given (the page's picker) */
  function withImplied(b, groups) {
    var out = Object.assign({}, b || {});
    (groups || Object.keys(BOOKING)).forEach(function (g) { var v = impliedValue({ booking: out }, g); if (v) out[g] = v; });
    return out;
  }
  /* booking values listed (any of them, per group): every group named must match */
  function bookingFits(vals, c) {
    var by = {};
    (vals || []).forEach(function (v) { var g = GROUP_OF[v]; if (!g) g = "?" + v; (by[g] = by[g] || []).push(v); });
    return Object.keys(by).every(function (g) { return by[g].indexOf(bookingValue(c, g)) >= 0; });
  }
  /* plug-in facts: does the work have any of them? (no facts list on the path: treated as having them all for an
     "on" gate and none for an "off" gate, so the branch shows) */
  function factsFit(list, c) { if (!c || !c.facts) return true; return (list || []).some(function (f) { return c.facts.indexOf(f) >= 0; }); }
  function factsClear(list, c) { if (!c || !c.facts) return true; return !(list || []).some(function (f) { return c.facts.indexOf(f) >= 0; }); }
  var GATES = ["pf", "factOn", "factOff", "switchOn", "switchOff"];
  /* is a branch (or a step) with this `when` lit on path c? No path (the page's "every path"): lit. */
  function lit(when, c) {
    if (!when || !c) return true;
    /* Tools J (E1): the events only on a `when` stamped "ev"; record facts read the flow the stamps name */
    return litOn(when, c, when.took, EVENTS ? !!when.ev : true, when.took || when.ev || null, when.wr === false ? false : undefined);
  }
  /* a `when` on path c read as a step stamped took / ev reads it (fillRecord reads slot rows this way) */
  function litOn(when, c, took, ev, fl, written) {
    if (!when || !c) return true;
    if (!ev) c = noEvents(c);
    var c0 = c;
    /* Tools C (T1): a when stamped "took" (after the money step) reads the money of what this booking took */
    if (took) c = tookPath(c, took);
    return Object.keys(when).every(function (d) {
      if (d === "took" || d === "ev" || d === "wr") return true;
      /* Tools J (E1; TOOL-SPEC 1.2): record facts, from the record of the path (by what it took, on a took when) */
      if (d === "rec") return recFits(when.rec, c0, fl, !!took, written);
      if (d === "recOff") return !recFits(when.recOff, c0, fl, !!took, written);
      if (d === "pf" || d === "factOn") return factsFit(when[d], c);
      if (d === "factOff") return factsClear(when[d], c);
      if (d === "switchOn") return (when[d] || []).some(function (n) { return switchOn(c, n); });
      if (d === "switchOff") return !(when[d] || []).some(function (n) { return switchOn(c, n); });
      if (d === "booking") return bookingFits(when.booking, c);
      return (when[d] || []).indexOf(c[d]) >= 0;
    });
  }
  /* does a `when` choose between paths (money or booking), rather than only gate on the plug-in? */
  function chooses(when) { return !!when && Object.keys(when).some(function (d) { return GATES.indexOf(d) < 0 && d !== "took" && d !== "ev" && d !== "wr"; }); }
  /* Tools D (DESIGN 9.2 #16): a path with a branch's mid-booking change laid on ({ group: value }).
     Tools G: the values it implies apply (notsafe reads private), but a HISTORIC group (taken: what the booking took)
     keeps the path's value unless the sets names it; from (optional) names the branch, kept in the path's setBy list. */
  var HISTORIC = ["taken"];
  function withSets(c, sets, from) {
    if (!c || !sets || typeof sets !== "object") return c;
    /* Tools J (E1; TOOL-SPEC 1.4): "svcAdd" adds a service (not a booking group) */
    var add = has(sets, "svcAdd") ? sets.svcAdd : undefined;
    if (add !== undefined) { sets = Object.assign({}, sets); delete sets.svcAdd; }
    var b = Object.assign({}, c.booking || {}, sets), out = Object.assign({}, c, { booking: b });
    HISTORIC.forEach(function (g) {
      if (has(sets, g)) { if (out.pin && out.pin[g]) { out.pin = Object.assign({}, out.pin); delete out.pin[g]; if (!Object.keys(out.pin).length) delete out.pin; } return; }
      var was = bookingValue(c, g);
      if (bookingValue(out, g) === was) return;
      if (impliedValue(out, g)) { var pn = Object.assign({}, out.pin || {}); pn[g] = was; out.pin = pn; } else b[g] = was;
    });
    if (add !== undefined) out = addService(out, add);
    /* Tools J (change 16): an event value a branch sets is read on every later step (noEvents keeps it) */
    if (EVENTS) { var eg = EV_GROUPS.filter(function (g) { return (has(sets, g) || (add !== undefined && g === "charge" && bookingValue(out, g) !== bookingValue(c, g))) && (!c.evSet || c.evSet.indexOf(g) < 0); }); if (eg.length) out.evSet = (c.evSet || []).concat(eg); }
    if (from) out.setBy = (c.setBy || []).concat([from]);
    return out;
  }
  /* Tools G: a path's reading of every booking group (two paths with the same reading read every step the same).
     Tools J: and its services, when it has a list (a fixture's or an added service) */
  function pathSig(c) { return Object.keys(BOOKING).map(function (g) { return bookingValue(c, g); }).join("|") + (c && c.svc && c.svc.length ? "#" + c.svc.map(function (s) { return (s.own ? "own:" + s.price + "|" + s.before + "|" + s.after : s.id) + (s.later ? "+later" : ""); }).join(",") + "#" + c.price + "|" + c.before + "|" + c.after : "") + (c && c.evSet && c.evSet.length ? "!" + c.evSet.join(",") : ""); }
  /* Tools G: a sets branch as a reader names it ("A7-97 [Says their phone isn't safe now]") and its change in words
     ("How the customer is reached: Not safe to contact") */
  function setsKey(s, b) { return s.id + " [" + b.label + "]"; }
  function setsWords(sets) { return Object.keys(sets || {}).map(function (g) { if (g === "svcAdd") { var f = findService(sets[g]); return "Adds a service: " + (f && f.svc.name ? f.svc.name : sets[g]); } return (BOOKING[g] ? BOOKING[g].label : g) + ": " + bookingLabel(sets[g]); }).join(" + "); }
  var okSets = function (b) { return !!b && !b.off && !!b.sets && typeof b.sets === "object" && !Array.isArray(b.sets) && Object.keys(b.sets).length > 0; };
  /* Tools G: does any branch with "sets" rejoin (so its change reaches steps after its split)? */
  function lateSets(steps) {
    var list = Array.isArray(steps) ? steps : (steps && steps.steps) || [], y = false;
    eachStep(list, function (s) { if (!y) (s.branches || []).forEach(function (b) { if (okSets(b) && (b.end || "merge") !== "end") y = true; }); });
    return y;
  }
  /* Tools G: every sets branch (not off) with the steps it reaches: own (the branch's steps, any depth) and after (when the
     branch rejoins: the steps after its split, any depth, climbing out through each enclosing branch that rejoins; a
     later split whose branches all end stops the climb, as ripple's downstream reads it). [{ key, split, label, sets,
     words, own: [ids], after: [ids], whens: [the gates and choices on the way to the branch, its own when last] }] */
  function setsScopes(steps) {
    var list = Array.isArray(steps) ? steps : (steps && steps.steps) || [], out = [], ix = null;
    eachStep(list, function (s) {
      (s.branches || []).forEach(function (b) {
        if (!okSets(b)) return;
        ix = ix || index(list);
        var own = [], after = [], seen = {}, whens = [];
        eachStep(b.steps || [], function (x) { if (!seen[x.id]) { seen[x.id] = 1; own.push(x.id); } });
        for (var h = ix[s.id]; h; h = h.holder ? ix[h.holder.split.id] : null) {
          if (h.s.when) whens.unshift(h.s.when);
          if (h.holder && h.holder.branch.when) whens.unshift(h.holder.branch.when);
        }
        if (b.when) whens.push(b.when);
        if ((b.end || "merge") !== "end") {
          var cur = ix[s.id];
          for (;;) {
            var ls = cur.list, i = ls.indexOf(cur.s), stopped = false;
            for (var j = i + 1; j < ls.length; j++) {
              eachStep([ls[j]], function (x) { if (!seen[x.id]) { seen[x.id] = 1; after.push(x.id); } });
              var t = ls[j];
              if (t.type === "split" && (t.branches || []).length && t.branches.every(function (y) { return (y.end || "merge") === "end"; })) { stopped = true; break; }
            }
            if (stopped || !cur.holder || (cur.holder.branch.end || "merge") === "end") break;
            cur = ix[cur.holder.split.id];
          }
        }
        out.push({ key: setsKey(s, b), split: s.id, label: b.label, sets: b.sets, words: setsWords(b.sets), own: own, after: after, whens: whens });
      });
    });
    return out;
  }
  /* Tools G: walk path c in page order. fn(s, p, trail) for each lit step, then fn(s, p, trail, b) for each of its lit
     branches (before the branch's steps), where p is the path as it reads there: c, or, inside a lit branch with "sets"
     and on every step after it rejoins, withSets(c, sets) (setBy names the branch); where other lit branches rejoin too,
     the later steps are reached with both (each once per distinct reading, pathSig). opts.off: skip steps and branches
     marked off. Like a plain lit walk, a split none of whose lit branches rejoins lets the walk go on with the paths it
     came with. Returns the paths that reach the end. */
  function walkSets(steps, c, fn, opts) {
    var skipOff = !!(opts && opts.off);
    var dedupe = function (ps) { var m = {}, o = []; ps.forEach(function (p) { var k = pathSig(p); if (!m[k]) { m[k] = 1; o.push(p); } }); return o; };
    var go = function (list, states, trail) {
      for (var i = 0; i < (list || []).length; i++) {
        var s = list[i];
        if (skipOff && s.off) continue;
        var here = states.filter(function (p) { return !(s.when && !lit(s.when, p)); });
        if (!here.length) continue;
        here.forEach(function (p) { fn(s, p, trail); });
        if (!(s.branches || []).length) continue;
        var merged = [];
        s.branches.forEach(function (b) {
          if (skipOff && b.off) return;
          var into = here.filter(function (p) { return lit(b.when, p); });
          if (!into.length) return;
          if (okSets(b)) into = dedupe(into.map(function (p) { return withSets(p, b.sets, setsKey(s, b)); }));
          into.forEach(function (p) { fn(s, p, trail, b); });
          var r = go(b.steps || [], into, trail.concat([b.label]));
          if ((b.end || "merge") !== "end") merged = merged.concat(r);
        });
        var rest = states.filter(function (p) { return here.indexOf(p) < 0; });
        states = merged.length ? dedupe(rest.concat(merged)) : states;
      }
      return states;
    };
    return go(steps || [], [c], []);
  }
  /* Tools D: a split whose branches all carry booking choices (no money), two of them the very same choices, is events
     under one choice (A3-01's ways in for madeby customer beside "The business books it" for shop): more than one branch
     may light on a path, and at least one must. Any other split whose branches all choose lights exactly one. */
  function eventsUnderChoice(s) {
    var bs = (s && s.branches) || [];
    if (bs.length < 2 || !bs.every(function (b) { return b.when && b.when.booking && chooses(b.when) && !MONEY.some(function (d) { return b.when[d]; }); })) return false;
    var seen = {};
    return bs.some(function (b) { var k = b.when.booking.slice().sort().join(","); if (seen[k]) return true; seen[k] = 1; return false; });
  }
  /* Tools C (STATE.md T1, layer L2): the money a path reads AFTER the money step is what this booking took, not what the
     service asks. Calls only, or nothing taken (taken: nothing): nothing before, and the rest at the visit (flow A: at
     the counter; flow B: the business's own way); a free service stays free. Paid by a credit: a deposit or the full
     price reads as nothing taken, a hold as a saved card (for extras and damage only: nothing is held, DESIGN DD1, L2.4),
     a card stays a card, and nothing after for the visit. Tools E (Oct 26, review r6-money H1, H3): a credit turns a hold
     into a saved card, and with nothing taken (calls only, the owner's no-card yes) a credit still means nothing after:
     the credit paid the visit. fl: "A" or "B". */
  function tookPath(c, fl) {
    if (!c || !c.before) return c;
    var free = c.before === "none" && c.after === "none", credit = bookingValue(c, "paidby") === "credit";
    if (bookingValue(c, "taken") === "nothing") return free ? c : Object.assign({}, c, { before: "none", after: credit ? "none" : (fl === "B" ? "own" : "counter") });
    if (credit) return Object.assign({}, c, { before: c.before === "deposit" || c.before === "full" ? "none" : (c.before === "hold" ? "card" : c.before), after: "none" });
    /* Tools F (FIXED-A36 "For tools"): grief and end-of-life work asks no fee, so there is nothing to hold: a hold service
       saves a card only (no hold placed, no day-before hold), as for a credit */
    if (switchOn(c, "grief") && c.before === "hold") return Object.assign({}, c, { before: "card" });
    return c;
  }

  /* ------------------------------------------------------------ the booking record (Tools J, E1; TOOL-SPEC 1, 3.1) */
  /* (E1 fix: "written", the booking is written: from the write step, A6-10 / B6-10, on) */
  var REC = ["nothing", "card", "paid", "full", "rest", "credit", "several", "keep", "written"];
  /* (TOOL-SPEC change 4: backlate, what a late cancel or no-show gives back with one fee per booking) */
  var LEDGER_AMOUNTS = ["paidnow", "due", "keep", "back", "later", "backlate"];
  /* what each way of paying puts in the ledger (record.json "ways" wins): an amount of the service ("deposit", "paid",
     "fee", "price", "rest"), "0", or "credit" (counts in credits); card "asis" keeps the service's own card setting */
  var RECORD_WAYS = {
    none: { now: "0", card: false, keep: "0", back: "0" },
    card: { now: "0", card: true, keep: "fee", back: "0" },
    hold: { now: "0", card: true, keep: "fee", back: "0" },
    deposit: { now: "deposit", card: true, keep: "deposit", back: "deposit" },
    full: { now: "paid", card: false, keep: "fee", back: "paid" },
    credit: { now: "0", card: "asis", keep: "credit", back: "credit" }
  };
  /* "$140" -> 140, "$1,200.50" -> 1200.5, "free" / "$0" -> 0; anything else null */
  function amountN(t) {
    if (t === null || t === undefined) return null;
    if (typeof t === "number") return isFinite(t) ? t : null;
    var s = String(t).trim().toLowerCase();
    if (s === "free" || s === "0") return 0;
    var m = /^\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(s);
    return m ? +(m[1].replace(/,/g, "") + (m[2] ? "." + m[2] : "")) : null;
  }
  /* 140 -> "$140", 12.5 -> "$12.50"; null -> null */
  function amountText(n) { if (n === null || n === undefined) return null; var r = Math.round(n * 100) / 100; return "$" + (r % 1 ? r.toFixed(2) : String(r)); }
  /* a service of the record.json tables loaded (any flow): { svc, fl }, or null */
  function findService(id) {
    var out = null;
    ["A", "B"].some(function (f) { var t = record(f), s = t && t.services && typeof t.services === "object" ? t.services[id] : null; if (s && typeof s === "object") { out = { svc: s, fl: s.flow === "A" || s.flow === "B" ? s.flow : f }; return true; } return false; });
    return out;
  }
  /* the path's own service, as the first entry of a list */
  function ownService(c) { return { id: "own", own: true, price: c.price, before: c.before, after: c.after }; }
  function servicesOf(c) { return c && c.svc && c.svc.length ? c.svc : [ownService(c || {})]; }
  function paidbyOf(s, c) { return s.own ? (bookingValue(c, "paidby") === "credit" ? "credit" : "money") : (s.paidby === "credit" ? "credit" : "money"); }
  /* D73 (DECISIONS; lib.js severalPath, the same reading, without its validity check): several services read as one
     money path; a service paid by a credit is left out (the paid part's path); null when only credits are left */
  /* D91 (tools J E3 fix 6): a service added after booking takes nothing new before the visit: it's paid like any rest, at
     the visit or on the bill (the booking's own way after the visit, else the counter in A / the bill in B), and adds no fee.
     E3 fix 7: never the added service's own way (a profession's add-on set to "card" would charge a card the booking never
     saved, A9-12 / B9-xx): only the booking's own rest way */
  function laterWay(s, list, fl) {
    var own = (list || []).filter(function (x) { return !x.later; })[0], oa = own && own.after && own.after !== "none" ? own.after : null;
    return { price: s.price, before: "none", after: oa || (fl === "B" ? "bill" : "counter") };
  }
  function severalOf(fl, list, c) {
    var S0 = (list || []).filter(function (s) { return paidbyOf(s, c || {}) !== "credit"; }).map(function (s) { return s.later ? laterWay(s, list, fl) : { price: s.price, before: s.before, after: s.after }; }); /* (D91: an added service as a rest) */
    if (!S0.length) return null;
    var paid = S0.filter(function (x) { return !(x.before === "none" && x.after === "none"); }), S = paid.length ? paid : S0;
    var price = S.some(function (x) { return x.price === "visit"; }) ? "visit" : S.some(function (x) { return x.price === "photos"; }) ? "photos" : "list";
    var before = S.every(function (x) { return x.before === "full"; }) ? "full" : S.some(function (x) { return x.before === "full" || x.before === "deposit"; }) ? "deposit" : S.some(function (x) { return x.before === "card" || x.before === "hold"; }) ? "card" : "none";
    var afters = []; S.filter(function (x) { return x.before !== "full"; }).forEach(function (x) { if (afters.indexOf(x.after) < 0) afters.push(x.after); });
    var after = !afters.length ? "none" : afters.length === 1 ? afters[0] : (fl === "A" ? "counter" : "bill");
    return { price: price, before: before, after: after };
  }
  function oneFee(fl) { var t = record(fl); return !!t && t.onefee === true; }
  function waysOfRecord(fl) { var t = record(fl); return t && t.ways && typeof t.ways === "object" ? t.ways : RECORD_WAYS; }
  /* does a service take money now (its way's "now" isn't "0")? */
  function takesNow(s, fl, c) { if (paidbyOf(s, c || {}) === "credit") return false; var w = waysOfRecord(fl)[s.before] || RECORD_WAYS[s.before]; return !!w && String(w.now) !== "0"; }
  /* a branch's sets { "svcAdd": "<id>" } (TOOL-SPEC 1.4): the service joins the path's list (its own service first), the
     money path becomes the combined one. D91 (tools J E3 fix 6): it takes nothing new before the visit, so no charge "later" */
  function addService(c, id) {
    var f = findService(id);
    if (!f) return c;
    var sv = Object.assign({ id: id }, f.svc, { later: true, bySets: true }), list = servicesOf(c).slice().concat([sv]);
    var p = severalOf(f.fl, list, c), out = Object.assign({}, c, { svc: list }, p || {});
    return out;
  }
  /* the record of one booking at a step (TOOL-SPEC 1.1, 1.3; DESIGN-REVIEW-2: keep is at most what was paid now, when
     something was; a service paid by a credit adds nothing to due or to paid now). took: from the money step on (what the booking took);
     else what the services ask (taken and calls only ignored). amounts: the flow's amount table (default: the one
     useRecord was given for fl); a fixture service's own amounts win field by field. */
  /* written (E1 fix; default true): false on a step stamped "wr": false, between the money step and the write (A6-10 /
     B6-10: a request awaiting the OK, a time lost on the page, a decline): nothing counts as taken there (paid now 0, no
     credit used, keep 0, back 0; a card saved stays saved; a pack bought on the page is its own charge, not in the ledger) */
  function recordOf(c, fl, took, amounts, written) {
    c = c || {};
    var unwritten = !!took && written === false;
    var W = waysOfRecord(fl), table = amounts !== undefined ? amounts : (RECORDS[fl] ? RECORDS[fl].amounts : null);
    var nothingTaken = !!took && bookingValue(c, "taken") === "nothing", charge = EVENTS ? bookingValue(c, "charge") : "none";
    var list = servicesOf(c), hasLater = list.some(function (s) { return s.later; });
    var rows = list.map(function (s) {
      var credit = paidbyOf(s, c) === "credit", p = { price: s.price, before: s.before, after: s.after };
      /* D91 (tools J E3 fix 6): a service added after booking takes nothing now, is due its price at the visit or on the
         bill, and its fee doesn't join the booking's one fee (its way reads as nothing taken) */
      if (s.later && !credit && !nothingTaken) p = laterWay(s, list, fl);
      else if (nothingTaken) { if (!(p.before === "none" && p.after === "none")) p = { price: p.price, before: "none", after: credit ? "none" : (fl === "B" ? "own" : "counter") }; }
      else if (credit) p = { price: p.price, before: p.before === "deposit" || p.before === "full" ? "none" : (p.before === "hold" ? "card" : p.before), after: "none" };
      else if (took && switchOn(c, "grief") && p.before === "hold") p = { price: p.price, before: "card", after: p.after };
      var way = credit ? "credit" : p.before, w = W[way] || RECORD_WAYS[way] || RECORD_WAYS.none;
      var am = Object.assign({}, amountRow(table, { price: s.price, before: s.before, after: s.after }), s.own ? {} : (s.amounts || {}));
      /* an amount named by a ways field: "0", "credit", an amount ("deposit"), or a chain "fee|deposit" (the first known) */
      var pick = function (name) { var xs = String(name).split("|"), v; for (var k = 0; k < xs.length; k++) { v = am[xs[k]]; if (v !== undefined && v !== null && amountN(v) !== null) return v; } return xs.length > 1 ? undefined : am[xs[0]]; };
      var amt = function (name) { var x = String(name); return x === "0" || x === "credit" ? 0 : amountN(pick(x)); };
      var pos = function (name) { var x = String(name); if (x === "0" || x === "credit") return false; var n = amountN(pick(x)); return n === null ? true : n > 0; };
      var feeOf = w.fee !== undefined ? w.fee : w.keep, keepOf = w.keep !== undefined ? w.keep : w.fee;
      var r = { id: s.id, name: s.name || null, price: s.price, before: s.before, after: s.after, paidby: credit ? "credit" : "money", way: way, took: p, amounts: am, later: !!s.later,
        now: amt(w.now), nowPos: pos(w.now), keep: amt(keepOf), keepPos: pos(keepOf) || String(keepOf) === "credit", back: amt(w.back), backPos: pos(w.back) || String(w.back) === "credit",
        fee: amt(feeOf), feePos: pos(feeOf),
        card: w.card === "asis" ? p.before === "card" : w.card === true, credit: credit };
      r.charged = { n: r.now, pos: r.nowPos };
      return r;
    });
    /* a failed charge took nothing from the services it charged (the ones added later, else every one that took money) */
    if (charge === "failed") rows.forEach(function (r) { if (hasLater ? r.later : r.nowPos) { r.failed = true; r.now = 0; r.nowPos = false; r.keep = 0; r.keepPos = false; r.back = 0; r.backPos = false; } });
    if (unwritten) rows.forEach(function (r) { r.unwritten = true; r.now = 0; r.nowPos = false; r.keep = 0; r.keepPos = false; r.back = 0; r.backPos = false; r.fee = 0; r.feePos = false; });
    rows.forEach(function (r) {
      var dn, dp, pr = amountN(r.amounts.price);
      if (r.took.after === "none") { dn = 0; dp = false; }
      else if (r.price === "visit") { dn = null; dp = true; }
      else if (!r.failed && !r.unwritten && r.took.before === r.before && r.amounts.rest !== undefined && amountN(r.amounts.rest) !== null) { dn = amountN(r.amounts.rest); dp = dn > 0; }
      else { dn = pr === null || r.now === null ? null : Math.max(0, pr - r.now); dp = dn === null ? true : dn > 0; }
      r.due = dn; r.duePos = dp;
    });
    var sum = function (f) { var n = 0, ok = true; rows.forEach(function (r) { if (r[f] === null) ok = false; else n += r[f]; }); return ok ? n : null; };
    var amtOf = function (n) { return { n: n, text: amountText(n) }; };
    var fix = c.fix && record(fl) && Array.isArray(record(fl).fixtures) ? record(fl).fixtures.filter(function (x) { return x && x.id === c.fix; })[0] : null;
    var laterN = fix && fix.later !== undefined ? amountN(fix.later) : (function () { var n = 0, ok = true; rows.forEach(function (r) { if (!r.later) return; if (r.charged.n === null) ok = false; else n += r.charged.n; }); return ok ? n : null; })();
    var card = rows.some(function (r) { return r.card; }), creditSvc = rows.some(function (r) { return r.credit; }), credits = unwritten ? 0 : rows.filter(function (r) { return r.credit; }).length;
    var paid = rows.some(function (r) { return r.nowPos; }), rest = rows.some(function (r) { return r.duePos; });
    var nowN = sum("now"), keepN, keepPos;
    if (oneFee(fl)) {
      /* TOOL-SPEC change 4: one fee per booking: the largest service fee, only when a card is saved or money was paid now */
      var held = card || paid, known = true, mx = 0;
      rows.forEach(function (r) { if (r.fee === null) known = false; else if (r.fee > mx) mx = r.fee; });
      keepN = !held ? 0 : known ? mx : null;
      keepPos = held && (known ? mx > 0 : rows.some(function (r) { return r.feePos; }));
    } else { keepN = sum("keep"); keepPos = rows.some(function (r) { return r.keepPos; }); }
    /* DESIGN-REVIEW-2 M1 (S13-55 rule 5): when money was paid now, what may be kept comes out of it: never more than paid now */
    if (paid && nowN !== null && nowN > 0 && keepN !== null && keepN > nowN) keepN = nowN;
    var ledger = { now: amtOf(nowN), due: amtOf(sum("due")), keep: amtOf(keepN), back: amtOf(sum("back")), later: amtOf(laterN),
      backlate: amtOf(nowN === null || keepN === null ? null : Math.max(0, nowN - keepN)) };
    if (unwritten) { keepN = 0; keepPos = false; }
    var facts = { nothing: !paid && !card && credits === 0, card: card, paid: paid, full: paid && !rest, rest: rest, credit: creditSvc, several: rows.length >= 2,
      keep: credits > 0 || keepPos, written: !!took && !unwritten };
    return {
      svc: rows.map(function (r) { return { id: r.id, name: r.name, price: r.price, before: r.before, after: r.after, paidby: r.paidby, way: r.way, took: r.took, amounts: r.amounts, later: r.later, failed: !!r.failed, now: r.now, due: r.due, keep: r.keep, back: r.back }; }),
      ledger: ledger, card: card, credits: credits, several: rows.length >= 2, charge: charge,
      contact: { reach: bookingValue(c, "reach"), privacy: bookingValue(c, "privacy"), state: EVENTS ? bookingValue(c, "contact") : "kept" },
      who: { madeby: bookingValue(c, "madeby"), approval: bookingValue(c, "approval") }, facts: facts
    };
  }
  /* does any of the record facts listed hold on path c? (an unknown name never holds: lib.js checkShape reports it) */
  function recFits(list, c, fl, took, written) { var f = recordOf(c, fl, !!took, undefined, written).facts; return (list || []).some(function (n) { return f[n] === true; }); }
  /* the flow's main path for a reader with no path (record.json "main") */
  function mainPath(fl) {
    var t = record(fl), k = t && t.main ? (typeof t.main === "string" ? t.main : t.main[fl]) : null, p = String(k || (fl === "B" ? "list|card|bill" : "list|card|counter")).split("|");
    return { price: p[0], before: p[1], after: p[2], booking: {} };
  }
  /* ------------------------------------------------------------ record slots (Tools J, E1; TOOL-SPEC 2) */
  var DOTTED_SLOTS = ["alex.staff", "name.staff", "svc.intext"];
  var RECORD_SLOT_RE = new RegExp("\\{\\{\\s*(?!(?:" + DOTTED_SLOTS.map(function (n) { return n.replace(".", "\\."); }).join("|") + ")\\s*[:|}])([a-z][a-z0-9]*\\.[a-z][a-z0-9]*)\\s*\\}\\}", "g");
  var LEDGER_RE = /\{\{\s*(?:(paidnow|due|backlate|back|later|name)\s*(?::[^{}|]*)?|keep\s*)\}\}/;
  var RECORD_FIELDS = ["title", "does", "rule", "q", "more", "say", "form", "table", "vary"];
  /* the record slots a step's own words hold (not its branches' steps), in order, each once */
  function recordSlotsIn(s) {
    var out = [];
    if (!s || typeof s !== "object") return out;
    var see = function (v) { if (v === undefined) return; var t = typeof v === "string" ? v : JSON.stringify(v); if (t.indexOf("{{") < 0) return; var re = new RegExp(RECORD_SLOT_RE.source, "g"), m; while ((m = re.exec(t))) if (out.indexOf(m[1]) < 0) out.push(m[1]); };
    RECORD_FIELDS.forEach(function (k) { see(s[k]); });
    (s.branches || []).forEach(function (b) { see(b.endText); });
    return out;
  }
  /* does a step's own words hold a ledger amount ({{due}}, a bare {{keep}} ...)? */
  function ledgerIn(s) {
    if (!s || typeof s !== "object") return false;
    var y = false;
    RECORD_FIELDS.forEach(function (k) { var v = s[k]; if (!y && v !== undefined && LEDGER_RE.test(typeof v === "string" ? v : JSON.stringify(v))) y = true; });
    (s.branches || []).forEach(function (b) { if (!y && b.endText && LEDGER_RE.test(b.endText)) y = true; });
    return y;
  }
  /* the row of a record slot that fits a path, read as step s reads it: { i, text } or null (no row fits) */
  function slotRow(name, c, fl, s) {
    var t = record(fl), S = t && t.slots && typeof t.slots === "object" ? t.slots[name] : null;
    if (!S || !Array.isArray(S.rows)) return null;
    var took = s && s.took ? s.took : undefined, ev = EVENTS ? !!(s && s.ev) : true;
    for (var i = 0; i < S.rows.length; i++) { var r = S.rows[i]; if (r && (!r.when || litOn(r.when, c, took, ev, fl, s && s.wr === false ? false : undefined))) return { i: i, text: String(r.text == null ? "" : r.text) }; }
    return null;
  }
  /* a copy of a step's words with its record slots filled for path c (null: the flow's main path). info (optional)
     collects { rows: { name: row index | null }, timed: [[set, sent-now, line], ...] } */
  function fillRecord(s, c, fl, info) {
    if (!s || !record(fl)) return s;
    var path = c || mainPath(fl), rows = {}, col = s.timing ? [] : null;
    /* (E1 fix 3, T3: a row's time slots are filled as the step's own are: the profession's settings (apply() keeps them on
       its record table as "_settings") and the step's own visit (a "visit" on the step, or the visit its own cutoff slot
       names after "@"): a row's {{cutoff}} names that visit, read by the business's rule, else the master's own) */
    var tb = record(fl), st0 = tb && tb._settings && typeof tb._settings === "object" && !Array.isArray(tb._settings) ? tb._settings : {};
    var va = s.visit || visitAnchorOf(s, fl), mv = CUTOFF_MASTER[fl] ? parseAbsT(CUTOFF_MASTER[fl].visit, null) : null, pv = va ? parseAbsT(va, null) : null;
    var moved = !!(pv && pv.exact && mv && pv.lo !== mv.lo);
    var ctx = { pf: (path && path.pf) || {}, settings: moved && st0.cutoff === undefined ? Object.assign({}, st0, { cutoff: MASTER_RULE[fl] }) : st0, fl: fl, problems: [], collect: col, t: s.t };
    var anchorTx = function (t) { return moved ? t.replace(/\{\{\s*cutoff\s*:([^{}|@]*)(\|[^{}]*)?\}\}/g, function (m, ex, rest) { return "{{cutoff:" + ex.trim() + "@" + va + (rest || "") + "}}"; }) : t; };
    var tx = function (t) {
      if (typeof t !== "string" || t.indexOf("{{") < 0) return t;
      return t.replace(new RegExp(RECORD_SLOT_RE.source, "g"), function (m, name) {
        if (!has(rows, name)) { var r = slotRow(name, path, fl, s); rows[name] = r; }
        var row = rows[name];
        return row ? unkeepText(fillText(anchorTx(row.text), ctx)) : m;
      });
    };
    var deep = function (v, k) { if (k === "link" || k === "code") return v; if (typeof v === "string") return tx(v); if (Array.isArray(v)) return v.map(function (x) { return deep(x); }); if (v && typeof v === "object") { var o = {}; Object.keys(v).forEach(function (kk) { o[kk] = deep(v[kk], kk); }); return o; } return v; };
    var o = Object.assign({}, s);
    ["title", "does", "rule", "q"].forEach(function (k) { if (typeof o[k] === "string") o[k] = tx(o[k]); });
    ["more", "say", "form", "table"].forEach(function (k) { if (o[k] !== undefined) o[k] = deep(o[k]); });
    if (o.branches) o.branches = o.branches.map(function (b) { return b.endText && b.endText.indexOf("{{") >= 0 ? Object.assign({}, b, { endText: tx(b.endText) }) : b; });
    if (info) { info.rows = {}; Object.keys(rows).forEach(function (n) { info.rows[n] = rows[n] ? rows[n].i : null; }); if (col && col.length) info.timed = col; }
    return o;
  }
  /* the ledger amounts of a step on a path, for the amount fill ({ paidnow: "$40", ... }; unknown: left out) */
  function ledgerRow(s, c, fl) {
    var R = recordOf(EVENTS && !s.ev ? noEvents(c) : c, fl, !!s.took, s.amounts !== undefined ? s.amounts : undefined, s.wr === false ? false : undefined), out = {};
    [["paidnow", "now"], ["due", "due"], ["keep", "keep"], ["back", "back"], ["later", "later"], ["backlate", "backlate"]].forEach(function (x) { var t = R.ledger[x[1]].text; if (t !== null) out[x[0]] = t; });
    /* {{name}} on a path with several services: each one's name (TOOL-SPEC change 10; the own one's from the amount table) */
    if (R.svc.length > 1 && R.svc.every(function (x) { return x.amounts && x.amounts.name || x.name; })) out.name = R.svc.map(function (x) { return x.name || x.amounts.name; }).join(" + ");
    return out;
  }
  /* Tools C (STATE.md T2): layer lines. A step stamped with "layerAdd" (build-master and check-part stamp it from
     header.json "layerLines") gets each line whose `when` fits the path added to every message to its recipients, after
     every variant, so no key removes it; "<way>" reads the way the person picked (the line's "way" map, by reach). */
  function layerLineText(L, c) { var way = (L.way && L.way[bookingValue(c, "reach")]) || (L.way && L.way["*"]) || ""; return String(L.line || "").replace(/<way>/g, way).replace(/\s+([,.;:])/g, "$1").replace(/\s{2,}/g, " ").trim(); }
  function addLayerLines(out, adds, c) {
    var o = out, ids = [];
    (adds || []).forEach(function (L) {
      if (!L || !lit(L.when, c)) return;
      var text = layerLineText(L, c), to = L.to || [], said = false;
      if (!text) return;
      if (Array.isArray(o.say)) {
        var ns = o.say.map(function (m) {
          if (!Array.isArray(m) || to.indexOf(m[1]) < 0 || m[0] !== "san") return m; /* (Tools G: Rosie's own messages only) */
          said = true;
          var t = String(m[2] || "");
          if (t.indexOf(text) >= 0) return m;
          var n = m.slice(); n[2] = t ? t + "\n" + text : text; return n;
        });
        if (said) o = Object.assign({}, o, { say: ns });
      }
      if (L.more && !said && to.indexOf(o.to) >= 0 && (o.more || []).indexOf(text) < 0) o = Object.assign({}, o, { more: (o.more || []).concat([text]) });
      if (said || (L.more && to.indexOf(o.to) >= 0)) ids.push(L.id || "line");
    });
    return { step: o, ids: ids };
  }
  /* the gate part of a `when` (its plug-in conditions), or null */
  function gatesOf(when) { var g = null; Object.keys(when || {}).forEach(function (d) { if (GATES.indexOf(d) >= 0) (g = g || {})[d] = when[d]; }); return g; }
  /* a vary key: "before:hold+booking:sentnow+pf:credit" -> { before: ["hold"], booking: ["sentnow"], pf: ["credit"] };
     null if any part is malformed. (Which names exist is checked by lib.js checkShape.) */
  function parseVaryKey(k) {
    var conds = {}, ok = true;
    String(k).split("+").forEach(function (part) {
      var p = part.trim(), m = /^(price|before|after|booking):([a-z]+)$/.exec(p), s = /^pf:([a-z][a-z0-9]*)$/.exec(p);
      if (m) (conds[m[1]] = conds[m[1]] || []).push(m[2]);
      else if (s) (conds.pf = conds.pf || []).push(s[1]);
      else ok = false;
    });
    return ok ? conds : null;
  }
  /* does a parsed vary key fit path c? Money and booking parts like a `when`; every switch named must be on */
  function keyFits(conds, c) {
    if (!conds) return false;
    if (!c) return true;
    return Object.keys(conds).every(function (d) {
      if (d === "pf") return conds.pf.every(function (n) { return switchOn(c, n); });
      if (d === "booking") return bookingFits(conds.booking, c);
      return conds[d].indexOf(c[d]) >= 0;
    });
  }
  /* how specific a parsed key is: one per money choice, one per booking group, one per switch */
  function keySpec(conds) {
    if (!conds) return 0;
    var n = 0;
    Object.keys(conds).forEach(function (d) {
      if (d === "pf") n += conds.pf.length;
      else if (d === "booking") { var gs = {}; conds.booking.forEach(function (v) { gs[GROUP_OF[v] || v] = 1; }); n += Object.keys(gs).length; }
      else n += 1;
    });
    return n;
  }
  /* a LAYER key names a plug-in switch or a booking choice: it is laid over the money words, field by field */
  function isLayer(conds) { return !!conds && !!(conds.pf || conds.booking); }
  /* the fields a variant sets once laid down (swap, addMore and addSay change the words under them: they count as the
     fields they change) */
  var EXTRA = { swap: ["does", "more", "say", "rule", "form", "table"], addMore: ["more"], addSay: ["say"] };
  function layerFields(v) {
    var out = [];
    Object.keys(v || {}).forEach(function (f) { (EXTRA[f] || [f]).forEach(function (g) { if (out.indexOf(g) < 0) out.push(g); }); });
    return out;
  }
  /* whole-word find and replace, the way renames work (a pair that starts or ends with a space or a mark needs no word
     edge there: "Skin fade, " matches before "Sat") */
  function swapRes(pairs) {
    return (pairs || []).filter(function (p) { return Array.isArray(p) && typeof p[0] === "string" && p[0]; }).map(function (p) {
      var a = p[0], pre = /^[A-Za-z0-9]/.test(a) ? "(^|[^A-Za-z0-9])" : "()", post = /[A-Za-z0-9]$/.test(a) ? "(?![A-Za-z0-9])" : "";
      return [new RegExp(pre + a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + post, "g"), String(p[1] == null ? "" : p[1])];
    });
  }
  function swapDeep(v, res, hits) {
    if (typeof v === "string") return res.reduce(function (x, r, i) { return x.replace(r[0], function (m, pre) { hits[i] = (hits[i] || 0) + 1; return pre + r[1]; }); }, v);
    if (Array.isArray(v)) return v.map(function (x) { return swapDeep(x, res, hits); });
    if (v && typeof v === "object") { var o = {}; Object.keys(v).forEach(function (k) { o[k] = (k === "link" || k === "code") ? v[k] : swapDeep(v[k], res, hits); }); return o; }
    return v;
  }
  /* lay one variant over some words (a copy): swap first, then the fields it sets, then the lines and messages it adds.
     hits (optional) counts each swap pair's matches. A variant with none of swap/addMore/addSay is a plain field copy. */
  function applyLayer(out, v, hits) {
    out = Object.assign({}, out);
    if (!v) return out;
    if (v.swap) { var res = swapRes(v.swap), h = hits || []; EXTRA.swap.forEach(function (f) { if (out[f] !== undefined) out[f] = swapDeep(out[f], res, h); }); }
    Object.keys(v).forEach(function (f) { if (!EXTRA[f]) out[f] = v[f]; });
    if (v.addMore) out.more = (out.more || []).concat(v.addMore);
    if (v.addSay) out.say = (out.say || []).concat(v.addSay);
    return out;
  }
  /* the words a step shows on path c: the most specific CHOICE key (money only) that fits, then every LAYER key that
     fits (a key naming a plug-in switch or a booking choice) laid over it field by field, least specific first.
     Returns { step, key, keys, choice, tie }: key = the last key applied (null for the base words), keys = every key
     applied, in order, choice = the money key applied (or null), tie = two keys that fit equally well (two choice keys,
     or two layer keys of the same specificity setting the same field, with none more specific over them). */
  function resolveVary(step, c, trace) {
    /* Tools D: amount slots ({{price}}) are filled last, from the step's amount table for this path (the service's own
       money choices, before what was taken), or with their example words when no path is given */
    var R0 = resolveVary0(step, c, trace), amt = amountsIn(step), tm = step.timed;
    /* (Tools J: amounts read the path as the step reads it: an added-later service only from the events step on) */
    if (EVENTS && c && !step.ev) c = noEvents(c);
    /* Tools J (E1; TOOL-SPEC 2.2): record slots after the keys, from the record of this path (the main path with none) */
    if (step.rec && record(step.rec)) {
      var info = {}, w0 = R0.step;
      R0.step = fillRecord(w0, c || null, step.rec, info);
      R0.rows = info.rows;
      if (info.timed) tm = (tm || []).concat(info.timed);
      if (!amt && R0.step !== w0 && amountsIn(R0.step)) amt = true;
      /* (no path: the main path's amounts, so a reader sees the words the main path reads) */
      if (amt) { var cm = c || mainPath(step.rec); R0.step = fillAmounts(R0.step, step.amounts, cm, undefined, ledgerRow(step, cm, step.rec)); }
    } else if (amt) R0.step = fillAmounts(R0.step, step.amounts, c || null);
    /* Tools F (T3): the time slots' words follow the booking's timing (sent now, a live line), after every key */
    if (tm && c) { var md = timedMode(c); if (md) { R0.step = applyTimed(R0.step, tm, md); R0.timed = md; } }
    return R0;
  }
  function resolveVary0(step, c, trace) {
    if (!c) return { step: step, key: null, keys: [], choice: null, tie: null };
    /* Tools J (E1): the event groups only on a step stamped "ev" */
    if (EVENTS && !step.ev) c = noEvents(c);
    /* Tools C (T1): a step after the money step (stamped "took") picks its words by what this booking took */
    if (step.took) c = tookPath(c, step.took);
    if (!step.vary) {
      if (!step.layerAdd) return { step: step, key: null, keys: [], choice: null, tie: null };
      var A0 = addLayerLines(step, step.layerAdd, c);
      return { step: A0.step, key: null, keys: [], choice: null, tie: null, lines: A0.ids };
    }
    var best = null, bestN = -1, tie = null, layers = [];
    Object.keys(step.vary).forEach(function (k, i) {
      var conds = parseVaryKey(k);
      if (!conds || !keyFits(conds, c)) return;
      var n = keySpec(conds);
      if (isLayer(conds)) { layers.push({ k: k, n: n, i: i }); return; }
      if (n > bestN) { best = k; bestN = n; tie = null; } else if (n === bestN) tie = k;
    });
    /* trace (optional, for the checkers): { key: [matches per swap pair] }, added up over the calls */
    var hitsOf = function (k) { return trace ? (trace[k] = trace[k] || []) : undefined; };
    var out = best ? applyLayer(step, step.vary[best], hitsOf(best)) : step, keys = best ? [best] : [], tied = tie ? [best, tie] : null;
    if (layers.length) {
      layers.sort(function (a, b) { return a.n - b.n || a.i - b.i; });
      layers.forEach(function (L) { out = applyLayer(out, step.vary[L.k], hitsOf(L.k)); keys.push(L.k); });
      /* a field two equally specific layer keys both set, with no more specific one setting it over them, is a tie */
      if (!tied) {
        var top = {};
        layers.forEach(function (L) { layerFields(step.vary[L.k]).forEach(function (f) { if (!top[f] || L.n > top[f].n) top[f] = { n: L.n, ks: [L.k] }; else if (L.n === top[f].n) top[f].ks.push(L.k); }); });
        Object.keys(top).some(function (f) { if (top[f].ks.length > 1) { tied = top[f].ks.slice(0, 2); return true; } return false; });
      }
    }
    /* Tools C (T2): layer lines go on last, after every key */
    var lines;
    if (step.layerAdd) { var A1 = addLayerLines(out, step.layerAdd, c); out = A1.step; lines = A1.ids; }
    var res = { step: out, key: keys.length ? keys[keys.length - 1] : null, keys: keys, choice: best, tie: tied };
    if (lines) res.lines = lines;
    return res;
  }
  /* the switches a key names */
  function keySwitches(k) { var c = parseVaryKey(k); return (c && c.pf) || []; }
  /* the booking groups a key or a `when` names */
  function bookingGroups(vals) { var gs = []; (vals || []).forEach(function (v) { var g = GROUP_OF[v]; if (g && gs.indexOf(g) < 0) gs.push(g); }); return gs; }

  /* the booking values a key names */
  function keyBookings(k) { var c = parseVaryKey(k); return (c && c.booking) || []; }

  /* ------------------------------------------------------------ amount slots (Tools D; DESIGN 9.2 #7) */
  /* {{price}}, {{fee}}, {{deposit}}, {{rest}}, {{hold}}, {{paid}}, each optionally with example words ({{price:$35}}):
     the amount on this money path from the flow's amount table (header.json flows.<flow>.amounts, stamped on the steps
     that use a slot as "amounts"), else the example words. So one before: variant can carry every price. */
  var AMOUNTS = ["price", "fee", "deposit", "rest", "hold", "paid", "name"]; /* (tools J: name, the service's example name per path, TOOL-SPEC change 10) */
  /* (Tools J: and the ledger amounts paidnow, due, back, later and a bare keep; {{keep:words}} is the keep slot) */
  var AMOUNT_RE = /\{\{\s*(price|fee|deposit|rest|hold|paidnow|paid|due|backlate|back|later|name|keep(?=\s*\}\}))\s*(?::([^{}|]*))?\}\}/g;
  var AMOUNT_FIELDS = ["title", "does", "rule", "q", "more", "say", "form", "table", "vary"];
  /* does a step's own words (not its branches' steps) hold an amount slot? (cached on the object, out of JSON) */
  function amountsIn(s) {
    if (!s || typeof s !== "object") return false;
    if (Object.prototype.hasOwnProperty.call(s, "__amt")) return s.__amt;
    var y = false;
    for (var i = 0; i < AMOUNT_FIELDS.length && !y; i++) { var v = s[AMOUNT_FIELDS[i]]; if (v !== undefined && JSON.stringify(v).indexOf("{{") >= 0 && new RegExp(AMOUNT_RE.source).test(JSON.stringify(v))) y = true; }
    if (!y) (s.branches || []).forEach(function (b) { if (b.endText && new RegExp(AMOUNT_RE.source).test(b.endText)) y = true; });
    try { Object.defineProperty(s, "__amt", { value: y, enumerable: false, configurable: true }); } catch (e) {}
    return y;
  }
  /* the row of an amount table for a path: rows keyed "list|card|counter", "list|*|*" (a "*" fits any choice) or "*";
     less specific rows first, so a more specific row's field wins */
  function amountRow(table, c) {
    var out = {};
    if (!table || typeof table !== "object" || !c || !c.before) return out;
    Object.keys(table).map(function (k) { var p = k === "*" ? ["*", "*", "*"] : String(k).split("|"); return { k: k, p: p, n: p.filter(function (x) { return x !== "*"; }).length }; })
      .filter(function (r) { return r.p.length === 3 && (r.p[0] === "*" || r.p[0] === c.price) && (r.p[1] === "*" || r.p[1] === c.before) && (r.p[2] === "*" || r.p[2] === c.after); })
      .sort(function (a, b) { return a.n - b.n; })
      .forEach(function (r) { var row = table[r.k]; if (row && typeof row === "object") Object.keys(row).forEach(function (f) { out[f] = row[f]; }); });
    return out;
  }
  /* one text with its amount slots filled; missing (optional) collects the slots with no amount and no example */
  function fillAmountText(t, row, missing) {
    if (typeof t !== "string" || t.indexOf("{{") < 0) return t;
    var out = t.replace(new RegExp(AMOUNT_RE.source, "g"), function (m, name, ex) {
      var v = row ? row[name] : undefined;
      if (v !== undefined && v !== null && String(v) !== "") return String(v);
      if (ex !== undefined && ex.trim()) return ex.trim();
      if (missing && missing.indexOf(name) < 0) missing.push(name);
      return m;
    });
    if (out.indexOf(EMPTY) >= 0) out = out.replace(/(\s+·\s+|,\s+|\s+[–—-]\s+)\u0002/g, "").replace(/\u0002(\s+·\s+|,\s+|\s+[–—-]\s+)/g, "").replace(/\s?\u0002/g, "");
    return out;
  }
  function fillAmountDeep(v, row, missing) {
    if (typeof v === "string") return fillAmountText(v, row, missing);
    if (Array.isArray(v)) return v.map(function (x) { return fillAmountDeep(x, row, missing); });
    if (v && typeof v === "object") { var o = {}; Object.keys(v).forEach(function (k) { o[k] = (k === "link" || k === "code") ? v[k] : fillAmountDeep(v[k], row, missing); }); return o; }
    return v;
  }
  /* a copy of a step's words with its amount slots filled for path c (null: the example words); the branches' own
     steps are left as they are (each is filled when its own words are picked) */
  function fillAmounts(s, table, c, missing, ledger) {
    if (!s) return s;
    var row = c ? amountRow(table, c) : (table && table["*"]) || null, o = Object.assign({}, s);
    /* Tools J (E1): the ledger amounts of the record ({{due}} ...), laid over the row; {{name}} reads nothing with the
       switch sensitive on (one separator next to it goes too, as for {{svc.intext}}) */
    if (ledger) row = Object.assign({}, row || {}, ledger);
    if (c && c.pf && c.pf.sensitive === true && row && row.name !== undefined) row = Object.assign({}, row, { name: EMPTY });
    ["title", "does", "rule", "q"].forEach(function (k) { if (typeof o[k] === "string") o[k] = fillAmountText(o[k], row, missing); });
    ["more", "say", "form", "table"].forEach(function (k) { if (o[k] !== undefined) o[k] = fillAmountDeep(o[k], row, missing); });
    if (o.branches) o.branches = o.branches.map(function (b) { return b.endText && b.endText.indexOf("{{") >= 0 ? Object.assign({}, b, { endText: fillAmountText(b.endText, row, missing) }) : b; });
    try { Object.defineProperty(o, "__amt", { value: false, enumerable: false, configurable: true }); } catch (e) {}
    return o;
  }
  /* tools J E3 fix 8: a profession's own amount rows, as a table of their own (a copy) */
  function ownAmounts(extra) { return mergeAmounts({}, extra); }
  /* lay a profession's amount rows over a table, row by row (its own words win field by field) */
  function mergeAmounts(base, extra) {
    var out = {};
    Object.keys(base || {}).forEach(function (k) { out[k] = Object.assign({}, base[k]); });
    Object.keys(extra || {}).forEach(function (k) { out[k] = Object.assign({}, out[k] || {}, extra[k]); });
    return out;
  }
  /* problems with an amount table: row keys and fields */
  function amountTableProblems(table, where) {
    var p = [], vals = { price: ["list", "photos", "visit"], before: ["none", "card", "hold", "deposit", "full"], after: ["none", "counter", "bill", "card", "own"] };
    if (!table || typeof table !== "object" || Array.isArray(table)) return [where + "amounts must be an object of rows, like { \"list|card|counter\": { \"price\": \"$35\", \"fee\": \"$20\" } }"];
    Object.keys(table).forEach(function (k) {
      var parts = k === "*" ? null : String(k).split("|");
      if (parts && (parts.length !== 3 || !parts.every(function (x, i) { return x === "*" || vals[MONEY[i]].indexOf(x) >= 0; }))) p.push(where + "amounts row '" + k + "' must be a money path like list|card|counter (a part may be *), or *");
      var row = table[k];
      if (!row || typeof row !== "object" || Array.isArray(row)) { p.push(where + "amounts row '" + k + "' must be an object like { \"price\": \"$35\" }"); return; }
      Object.keys(row).forEach(function (f) { if (AMOUNTS.indexOf(f) < 0) p.push(where + "amounts row '" + k + "': no amount '" + f + "' (amounts: " + AMOUNTS.join(", ") + ")"); else if (typeof row[f] !== "string" || !row[f].trim()) p.push(where + "amounts row '" + k + "': " + f + " must be words, like \"$35\""); });
    });
    return p;
  }

  /* ------------------------------------------------------------ the opt-out line once (Tools D; D61, STATE C5) */
  /* A TEXT is a message from Rosie to a person with a number (the customer, the owner, a team member, someone else)
     in a step that isn't a chat, a call, a page, an email or system to system: via msg, auto or portal (a portal action
     that texts). One number is one person on a lane, told apart by "as". firstTexts(steps, c) walks path c (null: every
     branch) like the clock walk and returns { id: { i: { first, later, to } } } for each text: first = on some walk to it,
     it is the first text that number gets; later = on some walk it isn't. A section-13 rule node is never walked. On a
     path whose customer is reached by calls only, email or not at this number, the booking customer gets no texts.
     opts.known(k): numbers already texted before these steps (a part checked alone: the team was texted at sign-up).
     opts.names: the flow's names per lane ({ staff: "Riley" }): "as": "Riley" is the lane's own person, the same number. */
  var TEXT_VIA = ["msg", "auto", "portal"], NUMBER = ["cust", "owner", "staff", "other"];
  function textTo(s, m, c, names) {
    if (!Array.isArray(m) || m[0] !== "san" || NUMBER.indexOf(m[1]) < 0 || TEXT_VIA.indexOf(s.via) < 0 || s.kind === "rule") return null;
    var as = (m[3] && m[3].as) || (s.as && (m[1] === s.to || m[1] === s.who) && (m[1] === "cust" || m[1] === "staff") ? s.as : "");
    if (as && names && names[m[1]] === as) as = "";
    if (c && m[1] === "cust" && !as && ["callsonly", "email", "notsafe"].indexOf(bookingValue(c, "reach")) >= 0) return null;
    return m[1] + (as ? ":" + as : "");
  }
  function firstTexts(steps, c, opts) {
    var out = {}, CAP = (opts && opts.cap) || 48, known = (opts && opts.known) || null, names = (opts && opts.names) || null;
    var dedupe = function (sts) { var m = {}, o = []; sts.forEach(function (st) { var k = Object.keys(st).sort().join(","); if (!m[k]) { m[k] = 1; o.push(st); } }); return o.slice(0, CAP); };
    var go = function (list, states) {
      for (var i = 0; i < (list || []).length; i++) {
        var s = list[i];
        if (s.off || s.kind === "rule" || (s.when && !lit(s.when, c))) continue;
        var R = TEXT_VIA.indexOf(s.via) >= 0 ? (c ? resolveVary(s, c).step : s) : null;
        if (R && Array.isArray(R.say)) {
          var rec = null;
          states = dedupe(states.map(function (st) {
            var set = st;
            R.say.forEach(function (m, mi) {
              var k = textTo(s, m, c, names);
              if (!k) return;
              if (known && known(k) && !set[k]) { set = Object.assign({}, set); set[k] = 1; }
              rec = rec || out[s.id] || (out[s.id] = {});
              var r = rec[mi] || (rec[mi] = { first: false, later: false, to: k, stop: (m[3] && m[3].stop) || null });
              if (set[k]) r.later = true; else { r.first = true; set = Object.assign({}, set); set[k] = 1; }
            });
            return set;
          }));
        }
        if (s.type !== "split") continue;
        var merged = [];
        (s.branches || []).forEach(function (b) {
          if (b.off || !lit(b.when, c)) return;
          var r = go(b.steps || [], states);
          if ((b.end || "merge") !== "end") merged = merged.concat(r);
        });
        if (!merged.length) return [];
        states = dedupe(merged);
      }
      return states;
    };
    go(steps, [{}]);
    return out;
  }
  /* a step's words with each conditional opt-out element ("stop": "first") settled for a walked path: kept as the line
     (stop: true) where it is the first text that number gets on every walk to it, left "first" where that depends on
     the walk, and taken out where it never is. rec = firstTexts(...)[step id]; no rec: as written. */
  function applyStops(s, rec) {
    if (!s || !Array.isArray(s.say) || !s.say.some(function (m) { return Array.isArray(m) && m[3] && m[3].stop === "first"; })) return s;
    return Object.assign({}, s, { say: s.say.map(function (m, i) {
      if (!Array.isArray(m) || !m[3] || m[3].stop !== "first") return m;
      var r = rec && rec[i], u = Object.assign({}, m[3]);
      if (!rec) return m;
      if (r && r.first && !r.later) u.stop = true; else if (r && r.first) u.stop = "first"; else delete u.stop;
      var n = m.slice(); n[3] = u; return n;
    }) });
  }

  /* ------------------------------------------------------------ times: absolute and relative `t` (part B) */
  /* The story's calendar (as the clock scan reads it): days count from Thu Jan 1, 2026; a date in Jan to Sep is next
     year's unless its weekday says otherwise. */
  var YEAR = 2026, MDAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31], JAN1_WD = 4;
  var WD3 = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"], WDN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MON3 = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], MONN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function dayIndexY(y, m, d) { var n = 0; for (var i = 0; i < m; i++) n += MDAYS[i]; return (y - YEAR) * 365 + n + d - 1; }
  function wdOf(di) { return (((JAN1_WD + di) % 7) + 7) % 7; }
  function dateDay(m, d, wd, year) {
    if (year) return dayIndexY(+year, m, d);
    var di = dayIndexY(m < 9 ? YEAR + 1 : YEAR, m, d);
    if (!wd) return di;
    var want = WD3.indexOf(String(wd).toLowerCase().slice(0, 3));
    if (wdOf(di) === want || m >= 9) return di;
    for (var y = YEAR; y <= YEAR + 1; y++) { var x = dayIndexY(y, m, d); if (wdOf(x) === want) return x; }
    return di;
  }
  function clockMin(s) {
    s = String(s || "").trim().toLowerCase();
    if (s === "noon") return 720;
    var m = /^(\d{1,2})(?::(\d\d))?\s?(am|pm)$/.exec(s);
    if (!m) return null;
    var h = +m[1] % 12; if (m[3] === "pm") h += 12;
    return h * 60 + (+m[2] || 0);
  }
  var CLOCK = "(?:\\d{1,2}(?::\\d\\d)?\\s?(?:am|pm)|noon)";
  var ABS_RE = new RegExp("^\\s*(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\\.?,?\\s+)?(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?\\s+(\\d{1,2})(?:,?\\s+(20\\d\\d))?)?(?:,?\\s*(?:at\\s+)?(" + CLOCK + "))?\\s*$", "i");
  /* an absolute `t` ("Wed Oct 21, 7:22pm", "7:22pm" on ctxDay) -> { lo, hi, exact, day } in minutes since Jan 1, or null */
  function parseAbsT(t, ctxDay) {
    var m = ABS_RE.exec(String(t || ""));
    if (!m || (!m[2] && !m[5] && !m[1])) return null;
    var di;
    if (m[2]) { var mo = MON3.indexOf(m[2].toLowerCase().slice(0, 3)), d = +m[3]; if (d < 1 || d > MDAYS[mo]) return null; di = dateDay(mo, d, m[1], m[4]); }
    else if (m[1]) { if (ctxDay == null) return null; var want = WD3.indexOf(m[1].toLowerCase().slice(0, 3)); di = ctxDay; while (wdOf(di) !== want) di++; }
    else { if (ctxDay == null) return null; di = ctxDay; }
    if (m[5]) { var c = clockMin(m[5]); return { lo: di * 1440 + c, hi: di * 1440 + c, exact: true, day: di, timeOnly: !m[2] && !m[1] }; }
    return { lo: di * 1440, hi: di * 1440 + 1439, exact: false, day: di };
  }
  function dayName(di) { var m = 0, d = ((di % 365) + 365) % 365; while (m < 11 && d >= MDAYS[m]) { d -= MDAYS[m]; m++; } return WDN[wdOf(di)] + " " + MONN[m] + " " + (d + 1) + (di >= 365 ? " " + (YEAR + Math.floor(di / 365)) : ""); }
  function clockText(mi, short) { var h = Math.floor(mi / 60), mm = mi % 60, ap = h >= 12 ? "pm" : "am", h12 = ((h + 11) % 12) + 1; return h12 + (short && !mm ? "" : ":" + (mm < 10 ? "0" : "") + mm) + ap; }
  /* a time for a reader: "Wed Oct 21, 7:22pm", or the day, or "Thu Oct 22, 8:00–11:59am" for a part of a day */
  function fmtTime(tm) {
    if (!tm) return "?";
    var di = Math.floor(tm.lo / 1440);
    if (tm.exact) return dayName(di) + ", " + clockText(tm.lo % 1440);
    if (tm.hi - tm.lo >= 1439 && tm.lo % 1440 === 0) return dayName(di);
    return dayName(di) + ", " + clockText(tm.lo % 1440) + " to " + clockText(tm.hi % 1440);
  }
  var UNIT = { minute: 1, minutes: 1, min: 1, mins: 1, hour: 60, hours: 60, hr: 60, hrs: 60, day: 1440, days: 1440, week: 10080, weeks: 10080 };
  var RID = "([SAB]\\d+-x?\\d{2,3})", RCLK = "(?:,?\\s+(?:at\\s+)?(" + CLOCK + "))?";
  var PARTS = { morning: [480, 719], afternoon: [720, 1019], evening: [1020, 1259], day: [0, 1439] };
  var REL = [
    [new RegExp("^(?:right|just)\\s+after(?:\\s+(?:the step before|the last step)|\\s+" + RID + ")?" + RCLK + "$", "i"), function (m) { return { kind: "offset", mins: 1, anchor: m[1] || null, clock: m[2] }; }],
    [new RegExp("^\\+?\\s*(\\d+)\\s*(minutes?|mins?|hours?|hrs?|days?|weeks?)\\s+(after|before|later)(?:\\s+" + RID + ")?" + RCLK + "$", "i"), function (m) {
      var n = +m[1] * UNIT[m[2].toLowerCase()], sign = /before/i.test(m[3]) ? -1 : 1;
      if (/later/i.test(m[3]) && m[4]) return null;
      if (n >= 1440 && m[5]) return { kind: "dayrel", days: sign * n / 1440, anchor: m[4] || null, clock: m[5] };
      if (m[5]) return null; /* "2 hours after X, 10am" says two things */
      return { kind: "offset", mins: sign * n, anchor: m[4] || null };
    }],
    [new RegExp("^(?:the\\s+)?next\\s+(morning|day|afternoon|evening)(?:\\s+after\\s+" + RID + ")?" + RCLK + "$", "i"), function (m) { return { kind: "dayrel", days: 1, part: m[1].toLowerCase(), anchor: m[2] || null, clock: m[3] }; }],
    [new RegExp("^(?:the\\s+)?same\\s+day(?:\\s+as\\s+" + RID + ")?" + RCLK + "$", "i"), function (m) { return { kind: "dayrel", days: 0, anchor: m[1] || null, clock: m[2], later: !m[2] }; }],
    [new RegExp("^later\\s+that\\s+day" + RCLK + "$", "i"), function (m) { return { kind: "dayrel", days: 0, anchor: null, clock: m[1], later: !m[1] }; }],
    [new RegExp("^(?:on\\s+)?the\\s+day\\s+(before|after|of)\\s+" + RID + RCLK + "$", "i"), function (m) { return { kind: "dayrel", days: m[1].toLowerCase() === "before" ? -1 : m[1].toLowerCase() === "after" ? 1 : 0, anchor: m[2], clock: m[3] }; }]
  ];
  /* a relative `t` -> { rel: true, kind: "offset" | "dayrel", mins, days, part, later, anchor (a step id, or null for the
     timed step before it on the path), clock (minutes) }, or null when it isn't one */
  function parseRelT(t) {
    var s = String(t || "").trim().replace(/\s+/g, " ");
    for (var i = 0; i < REL.length; i++) {
      var m = REL[i][0].exec(s);
      if (!m) continue;
      var r = REL[i][1](m);
      if (!r) return null;
      r.rel = true; r.text = s; r.clock = r.clock ? clockMin(r.clock) : null;
      return r;
    }
    return null;
  }
  /* does a `t` look like it meant to be relative? (then it must read as one) */
  function looksRelative(t) { return /^\s*(?:\+|right\b|just\b|\d+\s*(?:min|hour|hr|day|week)|(?:the\s+)?next\b|(?:the\s+)?same\s+day|later\s+that\b|(?:on\s+)?the\s+day\b)/i.test(String(t || "")); }
  /* a relative time from its base (the anchor's time, or the time before it) */
  function resolveRel(r, base) {
    if (!r || !base) return null;
    if (r.kind === "offset") { var lo = base.lo + r.mins, hi = base.hi + r.mins; return { lo: lo, hi: hi, exact: base.exact, day: Math.floor(lo / 1440) }; }
    var day = base.day + r.days;
    if (r.clock != null) return { lo: day * 1440 + r.clock, hi: day * 1440 + r.clock, exact: true, day: day };
    if (r.later) return { lo: base.lo + 1, hi: day * 1440 + 1439, exact: false, day: day };
    var p = PARTS[r.part || "day"];
    return { lo: day * 1440 + p[0], hi: day * 1440 + p[1], exact: false, day: day };
  }
  /* every step's time(s) on path c (null: every branch), walking the paths like the clock scan: an absolute `t` as
     written; a relative one from its anchor (a step met earlier on the path, else the anchor's own written time) or from
     the timed step before it. A time anchored to a step further on (a what-if on the visit day) is a jump ahead: when
     its branch rejoins, the clock goes back to where it was. Returns { id: [{ tm, after, rel, ahead }] } with one entry
     per distinct time. */
  function stepTimes(steps, c, opts) {
    var out = {}, order = {}, byId = {}, n = 0, seen = {}, CAP = (opts && opts.cap) || 12;
    eachStep(steps, function (s) { order[s.id] = n++; byId[s.id] = s; });
    var words = function (s) { return c ? resolveVary(s, c).step : s; };
    var written = function (id) { var s = byId[id]; if (!s) return null; var t = words(s).t; return t ? parseAbsT(t, null) : null; };
    var record = function (id, x) { var L = out[id] || (out[id] = []); if (!L.some(function (y) { return y.tm.lo === x.tm.lo && y.tm.hi === x.tm.hi; })) L.push(x); (seen[id] = seen[id] || []).push(x.tm); };
    var dedupe = function (sts) { var m = {}, o = []; sts.forEach(function (st) { var k = (st.last ? st.last.lo + "-" + st.last.hi : "") + "|" + (st.step || "") + "|" + (st.before ? 1 : 0); if (!m[k]) { m[k] = 1; o.push(st); } }); return o.slice(0, CAP); };
    var go = function (list, states) {
      for (var i = 0; i < (list || []).length; i++) {
        var s = list[i];
        if (s.off || (s.when && !lit(s.when, c))) continue;
        var R = words(s);
        if (R.t) {
          var rel = parseRelT(R.t), next = [];
          states.forEach(function (st) {
            var tm = null, ahead = false, after = st.step;
            if (!rel) tm = parseAbsT(R.t, st.last ? st.last.day : null);
            else if (rel.anchor) { var a = seen[rel.anchor] && seen[rel.anchor][0]; if (!a) { a = written(rel.anchor); ahead = order[rel.anchor] > order[s.id]; } tm = resolveRel(rel, a); after = rel.anchor; }
            else tm = resolveRel(rel, st.last);
            if (!tm) { next.push(st); return; }
            record(s.id, { tm: tm, after: after, rel: !!rel, ahead: ahead });
            next.push({ last: tm, step: s.id, before: ahead && !st.before ? st : st.before });
          });
          states = dedupe(next);
        }
        if (s.type !== "split") continue;
        var merged = [];
        (s.branches || []).forEach(function (b) {
          if (b.off || !lit(b.when, c)) return;
          var r = go(b.steps || [], states);
          if ((b.end || "merge") !== "end") r.forEach(function (st) { merged.push(st.before ? st.before : st); });
        });
        if (!merged.length) return [];
        states = dedupe(merged);
      }
      return states;
    };
    go(steps, [{ last: null, step: null, before: null }]);
    return out;
  }
  /* problems with a step's `t` (and its variants'): a relative time that can't be read, or an anchor that isn't a step
     of this flow. ids = { id: true } for the flow. */
  function timeProblems(s, ids) {
    var p = [], one = function (t, where) {
      if (!t) return;
      var r = parseRelT(t);
      if (!r) { if (looksRelative(t)) p.push(where + "can't read the relative time '" + t + "' (like: right after A6-26 · 4 days after A9-02 · the next morning, 10am · the day of A8-01, 7am)"); return; }
      if (r.anchor && ids && !ids[r.anchor]) p.push(where + "the time '" + t + "' names " + r.anchor + ", which isn't a step of this flow");
      if (r.anchor && r.anchor === s.id) p.push(where + "the time '" + t + "' names its own step");
    };
    one(s.t, "");
    Object.keys(s.vary || {}).forEach(function (k) { one((s.vary[k] || {}).t, "vary '" + k + "': "); });
    return p;
  }

  /* ------------------------------------------------------------ auto-fill slots (part B; autofill-words.md, D41, D48) */
  var SLOT_RE = /\{\{\s*([a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)?)\s*(?::([^{}|]*))?(?:\|([^{}]*))?\}\}/g;
  var SLOTS = {
    "alex.staff": { label: "The customer's name in owner and staff texts", means: "'Alex M.', or the initials 'A.M.' when the switch sensitive is on (D41).", example: "Alex M." },
    "name.staff": { label: "Another person's name in owner and staff texts", means: "The name written, like {{name.staff:Dee W.}}, or the initials 'D.W.' when the switch sensitive is on." },
    "svc.intext": { label: "The service in a customer text", means: "The service written, like {{svc.intext:Skin fade}}, or nothing when the switch sensitive is on (one ' · ' or ', ' next to it goes too); {{svc.intext:Skin fade|visit}} says 'visit' instead (D41)." },
    arrive: { label: "When the pro arrives", means: "{{arrive:8–10am}} reads 'arriving 8–10am', or 'starts at 8:00am' for a business whose sign-up setting is a set start (D48)." },
    window: { label: "The arrival time alone", means: "{{window:8–10am}} reads '8–10am', or '8:00am' for a set-start business." },
    cutoff: { label: "The free-cancel cutoff", means: "{{cutoff:Fri 11am}} reads as written, or the business's own cutoff ('pf.settings' cutoff) for the same visit. For another booking's visit, name it: {{cutoff:Fri Nov 20@Sat Nov 21, 10:00am}} (D48)." },
    /* Tools F (T3): the visit's day, which a sent-now or live-line booking reads as today */
    day: { label: "The visit's day", means: "{{day:Thu Oct 22}} reads as written; on a sent-now or live-line booking 'today' (or the words after '|': {{day:Thu Oct 22|Mon Oct 19}})." },
    keep: { label: "Words renames never change", means: "{{keep:massage}} reads 'massage' in every profession: an example of another kind of work on purpose (E12, E17)." },
    /* Tools D (DESIGN 9.2 #7): amount slots, filled per money path (resolveVary), never when an overlay is applied */
    price: { label: "The price on this money path", means: "{{price}} or {{price:$35}}: the amount from the flow's amount table for the path (header flows.<flow>.amounts), else the example words.", amount: true },
    fee: { label: "The fee on this money path", means: "{{fee}} or {{fee:$20}}: the late-cancel or no-show fee from the amount table, else the example words.", amount: true },
    deposit: { label: "The deposit on this money path", means: "{{deposit}} or {{deposit:$40}}: the deposit from the amount table, else the example words.", amount: true },
    rest: { label: "What is left to pay", means: "{{rest}} or {{rest:$100}}: the price less what was paid before, from the amount table, else the example words.", amount: true },
    hold: { label: "The amount held", means: "{{hold}} or {{hold:$40}}: the amount held on the card, from the amount table, else the example words.", amount: true },
    paid: { label: "The amount paid", means: "{{paid}} or {{paid:$55}}: what was paid (in full, or so far), from the amount table, else the example words.", amount: true }
  };
  /* the master's own cutoff rule and main visit in each flow (what the examples are written for) */
  var CUTOFF_MASTER = { A: { rule: { hours: 24 }, visit: "Sat Oct 24, 11:00am" }, B: { rule: { days: 0, clock: 420 }, visit: "Thu Oct 22, 8:00am" } };
  function cutoffRule(v) {
    if (v && typeof v === "object" && !Array.isArray(v)) { if (typeof v.hours === "number" && v.hours > 0) return { hours: v.hours }; return null; }
    var s = String(v || "").trim().toLowerCase(), m;
    if ((m = /^(\d+)\s*hours?\s+before$/.exec(s))) return { hours: +m[1] };
    if ((m = /^(\d+)\s*days?\s+before$/.exec(s))) return { hours: 24 * +m[1] };
    if ((m = new RegExp("^(" + CLOCK + ")\\s+the\\s+day\\s+(of|before)$").exec(s))) return { days: m[2] === "of" ? 0 : -1, clock: clockMin(m[1]) };
    return null;
  }
  function cutoffProblem(v) { return cutoffRule(v) ? null : "use words like \"24 hours before\", \"2 days before\", \"7am the day of\" or \"6pm the day before\" (or { \"hours\": 24 })"; }
  function arriveProblem(v) {
    if (v === "window" || v === "setstart") return null;
    if (v && typeof v === "object" && !Array.isArray(v) && typeof v.window === "number" && v.window >= 1 && v.window <= 12 && Object.keys(v).length === 1) return null;
    return "use \"window\", \"setstart\" or { \"window\": <hours> }";
  }
  var DAYP = "(Mon|Tue|Wed|Thu|Fri|Sat|Sun)", MONP = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
  /* a cutoff time written the way the example is written ("Fri 11am", "7am Thu", "11am today", "Fri Nov 20", "Fri Oct 23 ·
     3:00pm", "11am Wed Oct 21"); null when the example's shape isn't one of these */
  function fmtLike(ex, mi, stepDay) {
    var day = Math.floor(mi / 1440), cl = mi % 1440, e = String(ex).trim(), m;
    var ck = function (sample) { return clockText(cl, !/:/.test(sample)); };
    var wd = WDN[wdOf(day)], dn = dayName(day).replace(/^\w+ /, "");
    if ((m = new RegExp("^" + DAYP + "\\s+(" + CLOCK + ")$", "i").exec(e))) return wd + " " + ck(m[2]);
    if ((m = new RegExp("^(" + CLOCK + ")\\s+" + DAYP + "$", "i").exec(e))) return ck(m[1]) + " " + wd;
    if ((m = new RegExp("^(" + CLOCK + ")\\s+(today|tomorrow)$", "i").exec(e))) return stepDay == null ? null : day === stepDay ? ck(m[1]) + " today" : day === stepDay + 1 ? ck(m[1]) + " tomorrow" : ck(m[1]) + " " + wd;
    if ((m = new RegExp("^" + DAYP + "\\s+" + MONP + "\\s+(\\d{1,2})$", "i").exec(e))) return wd + " " + dn;
    if ((m = new RegExp("^" + DAYP + "\\s+" + MONP + "\\s+(\\d{1,2})\\s*·\\s*(" + CLOCK + ")$", "i").exec(e))) return wd + " " + dn + " · " + ck(m[4]);
    if ((m = new RegExp("^(" + CLOCK + ")\\s+" + DAYP + "\\s+" + MONP + "\\s+(\\d{1,2})$", "i").exec(e))) return ck(m[1]) + " " + wd + " " + dn;
    return null;
  }
  /* the cutoff for one slot under a rule: { text, problem } */
  function cutoffFill(ex, rule, fl, stepT) {
    var parts = String(ex).split("@"), e = parts[0].trim(), v = parseAbsT(parts[1] ? parts[1].trim() : (CUTOFF_MASTER[fl] || {}).visit, null);
    if (!v || !v.exact) return { text: e, problem: "the cutoff slot '" + ex + "' needs a visit with a day and a time after '@'" };
    var mi = rule.hours != null ? v.lo - rule.hours * 60 : (v.day + rule.days) * 1440 + rule.clock;
    var st = stepT ? parseAbsT(stepT, null) : null, text = fmtLike(e, mi, st ? st.day : null);
    if (text == null) return { text: e, problem: "the cutoff slot '" + e + "' isn't written like 'Fri 11am', '7am Thu', '11am today', 'Fri Nov 20' or 'Fri Oct 23 · 3:00pm'" };
    if (st && st.exact && mi < st.lo) return { text: text, problem: "the cutoff '" + text + "' is already past when this step happens (" + stepT + ")" };
    return { text: text, problem: null };
  }
  /* a window "8–10am" -> { a: start minutes, b: end minutes } or null */
  function parseWindow(w) {
    var m = /^(\d{1,2})(?::(\d\d))?\s?(am|pm)?\s?[–-]\s?(\d{1,2})(?::(\d\d))?\s?(am|pm)$/i.exec(String(w).trim());
    if (!m) return null;
    var apB = m[6].toLowerCase(), apA = m[3] ? m[3].toLowerCase() : (apB === "pm" && +m[4] !== 12 && !(+m[1] > +m[4] && +m[1] !== 12) ? "pm" : apB === "pm" && +m[1] === 12 ? "pm" : "am");
    var a = clockMin(m[1] + (m[2] ? ":" + m[2] : "") + apA), b = clockMin(m[4] + (m[5] ? ":" + m[5] : "") + apB);
    return a == null || b == null ? null : { a: a, b: b };
  }
  function windowText(a, b) {
    var apA = a >= 720 ? "pm" : "am", apB = b >= 720 ? "pm" : "am", t = function (x) { var h = ((Math.floor(x / 60) + 11) % 12) + 1, mm = x % 60; return h + (mm ? ":" + (mm < 10 ? "0" : "") + mm : ""); };
    return apA === apB ? t(a) + "–" + t(b) + apB : t(a) + apA + "–" + t(b) + apB;
  }
  function initials(e) { return String(e).split(/\s+/).filter(Boolean).map(function (w) { var c = (/[A-Za-z]/.exec(w) || [""])[0]; return c ? c.toUpperCase() + "." : ""; }).join(""); }
  /* one slot's words, or null to leave it as written (keep, or a slot that can't be filled) */
  /* Tools F (T3): the sent-now and live-line words of a time slot ("|" words, else the defaults) */
  var TIMED_SLOTS = { arrive: 1, window: 1, cutoff: 1, day: 1 };
  var TIMED_WORDS = { sentnow: { window: "in about 60 to 90 minutes", cutoff: "the pro is on the way", day: "today" }, line: { window: "when your place in line comes up", cutoff: "the pro is on the way", day: "today" } };
  function timedAlt(name, other) {
    var alt = other === undefined ? [] : String(other).split("|").map(function (x) { return x.trim(); });
    var base = name === "arrive" ? "window" : name, verb = name === "arrive" ? function (w) { return /^arriv/i.test(w) ? w : "arriving " + w; } : function (w) { return w; };
    var sn = alt[0] || TIMED_WORDS.sentnow[base], ln = alt[1] || (alt[0] ? alt[0] : TIMED_WORDS.line[base]);
    return [verb(sn), verb(ln)];
  }
  function fillOne(name, ex, other, ctx) {
    var v = fillOne0(name, ex, other, ctx);
    if (TIMED_SLOTS[name] && ctx.collect && v != null && v !== "") { var a = timedAlt(name, other); if (a[0] !== v || a[1] !== v) ctx.collect.push([v, a[0], a[1]]); }
    return v;
  }
  function fillOne0(name, ex, other, ctx) {
    var sens = !!(ctx.pf && ctx.pf.sensitive), st = ctx.settings || {};
    var e = ex === undefined ? undefined : String(ex).trim();
    if (name === "keep") return null;
    if (name === "alex.staff" || name === "name.staff") {
      if (e === undefined || e === "") e = name === "alex.staff" ? SLOTS["alex.staff"].example : null;
      if (e == null) return null;
      return sens ? (other !== undefined ? String(other).trim() : initials(e)) : e;
    }
    if (name === "svc.intext") { if (e === undefined) return null; return sens ? (other !== undefined ? String(other).trim() : "") : e; }
    if (name === "arrive" || name === "window") {
      if (!e) return null;
      var how = st.arrive, w = parseWindow(e), verb = name === "arrive";
      if (how === "setstart") { if (!w) { (ctx.problems || []).push("the slot {{" + name + ":" + e + "}} needs a window like 8–10am"); return verb ? "arriving " + e : e; } return (verb ? "starts at " : "") + clockText(w.a); }
      if (how && typeof how === "object" && how.window && w) return (verb ? "arriving " : "") + windowText(w.a, Math.min(w.a + Math.round(how.window * 60), 1439));
      return (verb ? "arriving " : "") + e;
    }
    if (name === "cutoff") {
      if (!e) return null;
      if (st.cutoff === undefined) return e.split("@")[0].trim();
      var rule = cutoffRule(st.cutoff);
      if (!rule) return e.split("@")[0].trim();
      var r = cutoffFill(e, rule, ctx.fl, ctx.t);
      if (r.problem && ctx.problems) ctx.problems.push(r.problem);
      return r.text;
    }
    if (name === "day") { if (!e) return null; return e; }
    return null;
  }
  var EMPTY = "\u0002";
  /* a text with its slots filled (keep markers stay until unkeep) */
  function fillText(t, ctx) {
    if (typeof t !== "string" || t.indexOf("{{") < 0) return t;
    var out = t.replace(SLOT_RE, function (m, name, ex, other) { var v = fillOne(name, ex, other, ctx || {}); return v === null ? m : v === "" ? EMPTY : v; });
    if (out.indexOf(EMPTY) >= 0) out = out.replace(/(\s+·\s+|,\s+|\s+[–—-]\s+)\u0002/g, "").replace(/\u0002(\s+·\s+|,\s+|\s+[–—-]\s+)/g, "").replace(/\s?\u0002/g, "");
    return out;
  }
  function fillDeep(v, ctx) {
    if (typeof v === "string") return fillText(v, ctx);
    if (Array.isArray(v)) return v.map(function (x) { return fillDeep(x, ctx); });
    if (v && typeof v === "object") { var o = {}; Object.keys(v).forEach(function (k) { o[k] = fillDeep(v[k], ctx); }); return o; }
    return v;
  }
  /* fill every step's slots in place: the fields renames read, a variant with its own `t` for the cutoff */
  /* the master's own cutoff rule per flow, as a setting (a row on a step about another visit reads it) */
  var MASTER_RULE = { A: "24 hours before", B: "7am the day of" };
  /* E1 fix 3 (T3): the visit a step's own words name: its cutoff slot's "@<visit>" (exact), else null */
  function visitAnchorOf(s, fl) {
    if (!s || typeof s !== "object") return null;
    var t = JSON.stringify([s.title, s.does, s.more, s.say, s.rule, s.form, s.table]);
    if (t.indexOf("{{") < 0) return null;
    var re = new RegExp(SLOT_RE.source, "g"), m;
    while ((m = re.exec(t))) if (m[1] === "cutoff" && m[2] && m[2].indexOf("@") >= 0) { var v = m[2].split("@")[1].trim(), p = parseAbsT(v, null); if (p && p.exact) return v; }
    return null;
  }
  function fillSteps(steps, ctx0) {
    eachStep(steps, function (s) {
      /* (E1 fix 3, T3: with a record loaded, a step with record slots keeps the visit its own cutoff slot names, before the
         slots are filled, so its rows' cutoff names the same visit) */
      if (s.visit === undefined && (RECORDS.A || RECORDS.B) && recordSlotsIn(s).length) { var vaf = visitAnchorOf(s, ctx0 && ctx0.fl); if (vaf) s.visit = vaf; }
      /* Tools F (T3): on a step after the timing is decided (stamped "timing"), the time slots' other words ("timed") */
      var col = s.timing ? [] : null, ctx = col ? Object.assign({}, ctx0, { collect: col }) : ctx0;
      var c0 = Object.assign({}, ctx, { t: s.t });
      ["title", "does", "rule", "q", "as"].forEach(function (k) { if (typeof s[k] === "string") s[k] = fillText(s[k], c0); });
      ["more", "say", "form", "table"].forEach(function (k) { if (s[k]) s[k] = fillDeep(s[k], c0); });
      if (s.slot) Object.keys(s.slot).forEach(function (k) { if (k !== "examples") s.slot[k] = fillDeep(s.slot[k], c0); });
      if (s.vary) Object.keys(s.vary).forEach(function (k) { var v = s.vary[k]; s.vary[k] = fillDeep(v, Object.assign({}, ctx, { t: (v && v.t) || s.t })); });
      /* a shared part's per-flow words (only in the part files; joined flows have none) */
      if (s.inFlow) Object.keys(s.inFlow).forEach(function (f) { var w = s.inFlow[f] || {}; s.inFlow[f] = fillDeep(w, Object.assign({}, ctx, { t: w.t || s.t, fl: f === "A" || f === "B" ? f : ctx.fl })); });
      (s.branches || []).forEach(function (b) { b.label = fillText(b.label, c0); if (b.endText) b.endText = fillText(b.endText, c0); });
      if (col && col.length) { var seen = {}, all = (s.timed || []).concat(col).filter(function (x) { var k = JSON.stringify(x); if (seen[k]) return false; seen[k] = 1; return true; }); s.timed = all; }
    });
    return steps;
  }
  /* Tools F (T3): does a flow read sent now or a live line (so its time slots get their other words)? */
  function readsTiming(flowOrSteps) { var v = valuesRead(flowOrSteps); return !!(v.sentnow || v.line); }
  /* the timing a path reads for the time slots: "line", "sentnow" or null (a set time) */
  function timedMode(c) { if (!c) return null; if (bookingValue(c, "times") === "line") return "line"; return bookingValue(c, "timing") === "sentnow" ? "sentnow" : null; }
  /* the step's words with each stamped set-time phrase replaced by its sent-now (or live-line) words; longest first */
  function applyTimed(st, timed, mode) {
    if (!mode || !timed || !timed.length) return st;
    var pairs = timed.map(function (x) { return [x[0], mode === "line" ? x[2] : x[1]]; }).filter(function (p) { return p[0] && p[0] !== p[1]; }).sort(function (a, b) { return b[0].length - a[0].length; });
    if (!pairs.length) return st;
    var tx = function (t) { if (typeof t !== "string") return t; var out = t; pairs.forEach(function (p) { if (out.indexOf(p[0]) >= 0) out = out.split(p[0]).join("\u0001" + pairs.indexOf(p) + "\u0001"); }); return out.indexOf("\u0001") < 0 ? t : out.replace(/\u0001(\d+)\u0001/g, function (m, i) { return pairs[+i][1]; }); };
    var deep = function (v, k) { if (k === "link" || k === "code" || k === "photoLink") return v; if (typeof v === "string") return tx(v); if (Array.isArray(v)) return v.map(function (x) { return deep(x); }); if (v && typeof v === "object") { var o = {}; Object.keys(v).forEach(function (kk) { o[kk] = deep(v[kk], kk); }); return o; } return v; };
    var o = {}; Object.keys(st).forEach(function (k) { o[k] = st[k]; });
    ["title", "does", "rule", "q"].forEach(function (k) { if (typeof o[k] === "string") o[k] = tx(o[k]); });
    ["more", "say", "form", "table"].forEach(function (k) { if (o[k]) o[k] = deep(o[k]); });
    return o;
  }
  var KEEP_RE = /\{\{\s*keep\s*:([^{}|]*)\}\}/g;
  var unkeepText = function (t) { return typeof t === "string" && t.indexOf("{{") >= 0 ? t.replace(KEEP_RE, function (m, x) { return x.trim(); }) : t; };
  function unkeepDeep(v) { if (typeof v === "string") return unkeepText(v); if (Array.isArray(v)) return v.map(unkeepDeep); if (v && typeof v === "object") { var o = {}; Object.keys(v).forEach(function (k) { o[k] = unkeepDeep(v[k]); }); return o; } return v; }
  function unkeepSteps(steps) {
    eachStep(steps, function (s) {
      ["title", "does", "rule", "q", "as"].forEach(function (k) { if (typeof s[k] === "string") s[k] = unkeepText(s[k]); });
      ["more", "say", "form", "table", "vary", "slot", "inFlow"].forEach(function (k) { if (s[k]) s[k] = unkeepDeep(s[k]); });
      (s.branches || []).forEach(function (b) { b.label = unkeepText(b.label); if (b.endText) b.endText = unkeepText(b.endText); });
    });
    return steps;
  }
  /* does a flow (or a list of steps) hold any slot? (cached on the object, out of JSON) */
  function hasSlots(x) {
    if (!x || typeof x !== "object") return false;
    if (Object.prototype.hasOwnProperty.call(x, "__slots")) return x.__slots;
    var y = JSON.stringify(x.steps || x).indexOf("{{") >= 0;
    try { Object.defineProperty(x, "__slots", { value: y, enumerable: false }); } catch (e) {}
    return y;
  }
  /* the fill for a profession in one flow (no overlay: the master's own words, every switch off) */
  function slotCtx(ov, fl, extra) { var c = { pf: ov ? switchesOf(ov, fl) : {}, settings: ov ? settingsOf(ov, fl) : {}, fl: fl, problems: [] }; return extra ? Object.assign(c, extra) : c; }
  /* a filled copy of a master flow, as one profession (or, with no overlay, the master itself) reads it */
  function fillFlow(flow, ov, fl, extra) {
    syncWays(flow); /* (tools H: the ways of the master read) */
    if (!hasSlots(flow)) return flow;
    var F = clone(flow), ctx = slotCtx(ov, fl, extra);
    fillSteps(F.steps, ctx); unkeepSteps(F.steps);
    return F;
  }
  /* problems with the slots in some text: unknown names, a missing example, braces that don't close */
  function slotProblems(t) {
    if (typeof t !== "string" || (t.indexOf("{{") < 0 && t.indexOf("}}") < 0)) return [];
    var p = [], m, re = new RegExp(SLOT_RE.source, "g"), rest = t.replace(re, "");
    if (rest.indexOf("{{") >= 0 || rest.indexOf("}}") >= 0) p.push("braces that aren't a slot like {{svc.intext:Skin fade}}: '" + t.slice(0, 60) + "'");
    while ((m = re.exec(t))) {
      var name = m[1], ex = m[2] === undefined ? undefined : m[2].trim();
      /* Tools J (E1): the ledger amounts ({{due}}, {{due:$100}}, a bare {{keep}}) and, with a record loaded, record slots */
      if (LEDGER_AMOUNTS.indexOf(name) >= 0 && (name !== "keep" || (m[2] === undefined && m[3] === undefined))) { if (m[3] !== undefined) p.push("the slot {{" + name + "}} takes no '|' words"); continue; }
      /* (E1 fix: {{name}} / {{name:Haircut}}, the service's name from the amount table, TOOL-SPEC change 10) */
      if (name === "name") { if (m[3] !== undefined) p.push("the slot {{name}} takes no '|' words"); continue; }
      if (!SLOTS[name] && name.indexOf(".") > 0 && recordOn()) {
        var known = recordSlotNames();
        if (known.indexOf(name) < 0) p.push("no record slot '" + name + "' (record slots: " + (known.join(", ") || "none") + ")");
        else if (m[2] !== undefined || m[3] !== undefined) p.push("the record slot {{" + name + "}} takes no example or '|' words: its words come from record.json");
        continue;
      }
      if (!SLOTS[name]) { p.push("no slot '" + name + "' (slots: " + Object.keys(SLOTS).join(", ") + ")"); continue; }
      if (name !== "alex.staff" && !SLOTS[name].amount && !ex) p.push("the slot {{" + name + "}} needs its example words, like {{" + name + ":" + (name === "svc.intext" ? "Skin fade" : name === "arrive" || name === "window" ? "8–10am" : name === "cutoff" ? "Fri 11am" : name === "keep" ? "massage" : name === "day" ? "Thu Oct 22" : "Dee W.") + "}}");
      if ((name === "arrive" || name === "window") && ex && !parseWindow(ex)) p.push("the slot {{" + name + ":" + ex + "}} needs a window like 8–10am");
      if (m[3] !== undefined && ["alex.staff", "name.staff", "svc.intext", "arrive", "window", "cutoff", "day"].indexOf(name) < 0) p.push("the slot {{" + name + "}} takes no '|' words");
      if (m[3] !== undefined && TIMED_SLOTS[name] && String(m[3]).split("|").length > 2) p.push("the slot {{" + name + "}} takes at most two '|' parts: the sent-now words, then the live-line words");
    }
    return p;
  }
  /* every text field of a step, for checks: [[where, text]] (labels apart: a label must not hold a slot) */
  function stepTexts(s) {
    var out = [], grab = function (where, v) { if (typeof v === "string") out.push([where, v]); else if (Array.isArray(v)) v.forEach(function (x) { grab(where, x); }); else if (v && typeof v === "object") Object.keys(v).forEach(function (k) { grab(where, v[k]); }); };
    ["title", "does", "rule", "q", "as"].forEach(function (k) { grab(k, s[k]); });
    ["more", "say", "form", "table"].forEach(function (k) { grab(k, s[k]); });
    if (s.slot) Object.keys(s.slot).forEach(function (k) { if (k !== "examples") grab("slot", s.slot[k]); });
    Object.keys(s.vary || {}).forEach(function (k) { grab("vary '" + k + "'", s.vary[k]); });
    Object.keys(s.inFlow || {}).forEach(function (f) { grab("inFlow." + f, s.inFlow[f]); });
    return out;
  }
  /* the master's cutoff slots, checked against its own rule: each must name the visit it belongs to when it isn't the
     main visit (else a business's own cutoff would be computed from the wrong visit) */
  function cutoffChecks(s, fl) {
    var p = [], R = CUTOFF_MASTER[fl];
    if (!R) return p;
    stepTexts(s).forEach(function (x) {
      var re = new RegExp(SLOT_RE.source, "g"), m;
      while ((m = re.exec(x[1]))) {
        if (m[1] !== "cutoff" || !m[2]) continue;
        var t = x[0].indexOf("vary '") === 0 ? ((s.vary[x[0].slice(6, -1)] || {}).t || s.t) : s.t;
        var r = cutoffFill(m[2].trim(), R.rule, fl, t), e = m[2].split("@")[0].trim();
        if (r.problem && !/already past/.test(r.problem)) p.push(x[0] + ": " + r.problem);
        else if (r.text.toLowerCase() !== e.toLowerCase()) p.push(x[0] + ": the cutoff slot '" + e + "' isn't " + (fl === "A" ? "24 hours before" : "7am the day of") + " the main visit (" + R.visit + "), the master's own rule: name its visit, like {{cutoff:" + e + "@Sat Nov 21, 10:00am}}");
      }
    });
    return p;
  }

  /* ------------------------------------------------------------ the profession's switches, facts and booking choices */
  /* the $2 split that decides pf:no2 in each flow (DECISIONS D8): the business's own company's split first */
  /* Tools D (DESIGN 9.2 #11): S1-62 first in both flows (S1-65 merges into it in the redesign; S11-92 and S11-94 go). The
     four splits must agree (no2Disagree), so the order changes nothing for an overlay that makes the choice twice. */
  var NO2_SPLITS = { A: ["S1-62", "S1-65"], B: ["S1-62", "S1-65"] };
  /* the choice an off op makes at a $2 split: true = no $2 (it turned off the "Yes, $2" branch), false = the $2 */
  function no2Choice(label) { return typeof label !== "string" ? undefined : /\bNo \$2\b/i.test(label) ? false : /\bYes\b|\$2 a\b/i.test(label) ? true : undefined; }
  /* every $2 split decides the same way (D8: S1-62, S1-65, S11-92, S11-94): the splits that disagree, or [] */
  function no2Disagree(ov, fl) {
    var seen = {};
    (((ov && ov[fl]) || {}).ops || []).forEach(function (o) { if (o.op === "off" && ["S1-62", "S1-65", "S11-92", "S11-94"].indexOf(o.at) >= 0) { var d = no2Choice(o.label); if (d !== undefined) seen[o.at] = d; } });
    var ks = Object.keys(seen); return ks.some(function (k) { return seen[k] !== seen[ks[0]]; }) ? ks.map(function (k) { return k + (seen[k] ? " (no $2)" : " (the $2)"); }) : [];
  }
  /* no2 from the profession's own choice at the $2 split: true when it turns off the "Yes, $2" branch, false when it
     turns off the "No $2" branch, undefined when it makes no choice there */
  function derivedNo2(ov, fl) {
    var ops = ((ov && ov[fl]) || {}).ops || [], out;
    (NO2_SPLITS[fl] || []).some(function (at) {
      ops.forEach(function (o) {
        if (o.op !== "off" || o.at !== at || typeof o.label !== "string" || out !== undefined) return;
        if (/\bNo \$2\b/i.test(o.label)) out = false; else if (/\bYes\b|\$2 a\b/i.test(o.label)) out = true;
      });
      return out !== undefined;
    });
    return out;
  }
  function switchesOf(ov, fl) {
    var raw = ((ov && ov.plugin) || {})["pf.switches"], out = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) Object.keys(raw).forEach(function (n) { var v = raw[n]; if (v && typeof v === "object" && !Array.isArray(v)) v = v[fl]; if (v === true) out[n] = true; });
    /* no2 follows the profession's choice at the $2 split, when it made one */
    var d = derivedNo2(ov, fl);
    if (d === true) out.no2 = true; else if (d === false) delete out.no2;
    return out;
  }
  /* the business's sign-up settings the slots read ("pf.settings": { "arrive": ..., "cutoff": ... }, or per flow:
     { "arrive": { "A": "window", "B": "setstart" } }) */
  var SETTINGS = ["arrive", "cutoff"];
  function settingsOf(ov, fl) {
    var raw = ((ov && ov.plugin) || {})["pf.settings"], out = {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    Object.keys(raw).forEach(function (n) { var v = raw[n]; if (v && typeof v === "object" && !Array.isArray(v) && (has(v, "A") || has(v, "B"))) v = v[fl]; if (v !== undefined && v !== null) out[n] = v; });
    return out;
  }
  /* its facts, or null when it lists none (then every fact-gated branch shows) */
  function factsOf(ov) {
    var raw = ((ov && ov.plugin) || {})["pf.facts"];
    return Array.isArray(raw) ? raw.slice() : null;
  }
  /* the booking values it uses per group (money.<flow>.booking: { "times": ["setstart"] }); a group left out: all */
  /* Part B: with the profession's joined flow (apply's output, off marks set), a booking choice split it trims tells
     which values it uses: a branch it turns off drops that value (like the $2 split gives no2). So the master can make
     B4-83 or B4-16 a booking split and every overlay's existing off ops still fit. money.<flow>.booking, when given,
     wins. The values keep the master's order; the first one left is the profession's default. */
  function bookingFromSplits(flow, ov, fl) {
    var keep = {};
    if (!flow || !flow.steps) return keep;
    /* a branch its plug-in switches or facts rule out counts as turned off too */
    var who = { pf: ov ? switchesOf(ov, fl) : {}, facts: ov ? factsOf(ov) : null };
    var isOff = function (b) { var g = gatesOf(b.when); return !!b.off || !!(g && !lit(g, who)); };
    eachStep(flow.steps, function (s) {
      if (s.type !== "split" || s.off || !(s.branches || []).length) return;
      var g = null, okSplit = s.branches.every(function (b) {
        if (!b.when || !Array.isArray(b.when.booking) || !b.when.booking.length) return false;
        return b.when.booking.every(function (v) { var gv = GROUP_OF[v]; if (!gv) return false; if (g === null) g = gv; return gv === g; });
      });
      if (!okSplit || !g || !s.branches.some(isOff)) return;
      var vals = {}; s.branches.forEach(function (b) { if (!isOff(b)) b.when.booking.forEach(function (v) { vals[v] = 1; }); });
      keep[g] = keep[g] ? keep[g].filter(function (v) { return vals[v]; }) : BOOKING[g].values.map(function (v) { return v[0]; }).filter(function (v) { return vals[v]; });
    });
    return keep;
  }
  /* the booking groups a flow's steps read (vary keys, branch and step whens) */
  function groupsRead(flow) {
    if (!flow || typeof flow !== "object") return [];
    var gs = [], add = function (vals) { bookingGroups(vals).forEach(function (g) { if (gs.indexOf(g) < 0) gs.push(g); }); };
    eachStep(flow.steps || [], function (s) {
      Object.keys(s.vary || {}).forEach(function (k) { add(keyBookings(k)); });
      if (s.when && s.when.booking) add(s.when.booking);
      (s.branches || []).forEach(function (b) { [b.when].concat(Object.keys(b.whenIn || {}).map(function (f) { return b.whenIn[f]; })).forEach(function (w) { if (w && w.booking) add(w.booking); }); if (okSets(b)) add(Object.keys(b.sets).map(function (g) { return b.sets[g]; })); });
    });
    return gs;
  }
  /* Tools F (T4): the booking values a flow's steps name (vary keys, step and branch whens), as an object of names; a
     flow (with steps) or a list of steps. A late value is walked only where this names it. */
  function valuesRead(flow) {
    var out = {}, steps = Array.isArray(flow) ? flow : (flow && flow.steps) || [], add = function (vals) { (vals || []).forEach(function (v) { if (GROUP_OF[v]) out[v] = true; }); };
    eachStep(steps, function (s) {
      Object.keys(s.vary || {}).forEach(function (k) { add(keyBookings(k)); });
      if (s.when && s.when.booking) add(s.when.booking);
      (s.branches || []).forEach(function (b) { [b.when].concat(Object.keys(b.whenIn || {}).map(function (f) { return b.whenIn[f]; })).forEach(function (w) { if (w && w.booking) add(w.booking); }); if (okSets(b)) add(Object.keys(b.sets).map(function (g) { return b.sets[g]; })); });
    });
    return out;
  }
  function bookingOf(ov, fl, flow) {
    var raw = (((ov && ov.money) || {})[fl] || {}).booking || {}, out = {}, facts = factsOf(ov), trimmed = bookingFromSplits(flow, ov, fl);
    /* (Tools C: the groups tools C added are listed only for a flow that reads them, so every other flow's list reads
       exactly as before) */
    var read = flow ? groupsRead(flow) : [];
    Object.keys(BOOKING).forEach(function (g) { if (LATE_GROUPS.indexOf(g) >= 0 && read.indexOf(g) < 0) return; if (g === "privacy") return; out[g] = Array.isArray(raw[g]) && raw[g].length ? raw[g].slice() : trimmed[g] && trimmed[g].length ? trimmed[g] : BOOKING[g].values.map(function (v) { return v[0]; });
      /* (tools J, E1 fix: a value record.json live.off cuts is never listed; a list left empty reads the group's first value) */
      if (liveOn(g)) { var kept = out[g].filter(function (v) { return !isLiveOff(g, v); }); out[g] = kept.length ? kept : [BOOKING[g].values[0][0]]; } });
    /* paid by a credit: only for work that sells packs or memberships (a work with no facts list may) */
    if (!(Array.isArray(raw.paidby) && raw.paidby.length) && facts && facts.indexOf("packs") < 0 && facts.indexOf("memberships") < 0) out.paidby = ["money"];
    /* Tools C: a private booking is a safety choice every business keeps: a profession never limits it (a privacy split
       it turns off is still walked, so check-prof shows the path it breaks; money.<flow>.booking.privacy is an error).
       Listed only for a flow that reads privacy, so a flow that doesn't reads exactly as before. */
    if (read.indexOf("privacy") >= 0) out.privacy = BOOKING.privacy.values.map(function (v) { return v[0]; });
    return out;
  }
  /* problems with a profession's switches, facts and booking choices; known = { switches, facts } registries */
  function pluginProblems(ov, known, fl) {
    var pl = (ov && ov.plugin) || {}, p = [];
    var raw = pl["pf.switches"];
    if (raw !== undefined) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) p.push("plugin \"pf.switches\" must be an object like { \"sensitive\": true }");
      else Object.keys(raw).forEach(function (n) {
        if (!known.switches[n]) p.push("plugin \"pf.switches\": no switch '" + n + "' (switches: " + Object.keys(known.switches).join(", ") + ")");
        var v = raw[n], okv = typeof v === "boolean" || (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every(function (f) { return (f === "A" || f === "B") && typeof v[f] === "boolean"; }));
        if (!okv) p.push("plugin \"pf.switches\": '" + n + "' must be true, false, or { \"A\": true, \"B\": false }");
      });
    }
    var facts = pl["pf.facts"];
    if (facts !== undefined) {
      if (!Array.isArray(facts) || facts.some(function (f) { return typeof f !== "string"; })) p.push("plugin \"pf.facts\" must be a list of fact names, like [\"rents\", \"weather\"]");
      else facts.forEach(function (f) { if (!known.facts[f]) p.push("plugin \"pf.facts\": no fact '" + f + "' (facts: " + Object.keys(known.facts).join(", ") + ")"); });
      /* a name that is both a switch and a fact (nomoney) must agree: the switch changes words, the fact hides branches */
      if (Array.isArray(facts)) Object.keys(known.switches).filter(function (n) { return known.facts[n]; }).forEach(function (n) {
        ["A", "B"].forEach(function (f) { if (!!switchesOf(ov, f)[n] !== (facts.indexOf(n) >= 0)) p.push("'" + n + "' is a switch and a fact: turn on the switch (flow " + f + ") and list the fact together, or neither"); });
      });
    }
    /* no2 comes from the choice at the $2 split (S1-62 / S1-65): a "pf.switches" no2 must agree with it */
    if (raw && typeof raw === "object" && !Array.isArray(raw) && raw.no2 !== undefined) ["A", "B"].forEach(function (f) {
      var d = derivedNo2(ov, f), v = raw.no2; if (v && typeof v === "object") v = v[f];
      if (d !== undefined && (v === true) !== d) p.push("plugin \"pf.switches\": no2 (flow " + f + ") says " + (v === true ? "on" : "off") + ", but the choice at the $2 split (" + NO2_SPLITS[f].join(" / ") + ") says " + (d ? "no $2" : "the $2") + ": no2 follows that choice, so drop it from pf.switches");
    });
    ["A", "B"].forEach(function (f) { var d = no2Disagree(ov, f); if (d.length) p.push("flow " + f + ": the $2 splits disagree (" + d.join(", ") + "): each one must make the same choice, since no2 follows it"); });
    /* the sign-up settings the slots read */
    var st = pl["pf.settings"];
    if (st !== undefined) {
      if (!st || typeof st !== "object" || Array.isArray(st)) p.push("plugin \"pf.settings\" must be an object like { \"arrive\": \"setstart\", \"cutoff\": \"24 hours before\" }");
      else Object.keys(st).forEach(function (n) {
        if (SETTINGS.indexOf(n) < 0) { p.push("plugin \"pf.settings\": no setting '" + n + "' (settings: " + SETTINGS.join(", ") + ")"); return; }
        var v = st[n], vs = v && typeof v === "object" && !Array.isArray(v) && (has(v, "A") || has(v, "B")) ? ["A", "B"].filter(function (f) { return has(v, f); }).map(function (f) { return v[f]; }) : [v];
        vs.forEach(function (x) { var why = n === "arrive" ? arriveProblem(x) : cutoffProblem(x); if (why) p.push("plugin \"pf.settings\": " + n + ": " + why); });
      });
    }
    ["A", "B"].forEach(function (f) {
      var b = (((ov && ov.money) || {})[f] || {}).booking;
      if (b === undefined) return;
      if (!b || typeof b !== "object" || Array.isArray(b)) { p.push("money." + f + ".booking must be an object like { \"times\": [\"setstart\"] }"); return; }
      Object.keys(b).forEach(function (g) {
        if (!BOOKING[g]) p.push("money." + f + ".booking: no booking choice '" + g + "' (" + Object.keys(BOOKING).join(", ") + ")");
        else if (g === "privacy") p.push("money." + f + ".booking.privacy: a profession can't limit private bookings (every business keeps them; leave privacy out)");
        else if (!Array.isArray(b[g]) || !b[g].length || b[g].some(function (v) { return GROUP_OF[v] !== g; })) p.push("money." + f + ".booking." + g + " must list values of " + g + ": " + allValues(g).map(function (v) { return v[0]; }).join(", "));
      });
    });
    return p;
  }
  /* registries for a flow: the core's, plus the master header's additions (written into each flow by build-master) */
  function merged(base, extra) { var out = {}; Object.keys(base).forEach(function (k) { out[k] = base[k]; }); Object.keys(extra || {}).forEach(function (k) { out[k] = extra[k]; }); return out; }
  function switchList(flow) { return merged(SWITCHES, flow && flow.switches); }
  function factList(flow) { return merged(FACTS, flow && flow.facts); }

  /* ------------------------------------------------------------ steps */
  var clone = function (x) { return JSON.parse(JSON.stringify(x)); };
  function eachStep(steps, f, trail) {
    trail = trail || [];
    (steps || []).forEach(function (s) { f(s, trail); (s.branches || []).forEach(function (b) { eachStep(b.steps, f, trail.concat([b.label])); }); });
  }
  function index(steps, out, holder) {
    out = out || {};
    (steps || []).forEach(function (s) { out[s.id] = { s: s, list: steps, holder: holder || null }; (s.branches || []).forEach(function (b) { b.steps = b.steps || []; index(b.steps, out, { split: s, branch: b }); }); });
    return out;
  }
  /* the profession's own example names on every master step's words (whole words only), in order */
  /* Part B: words inside {{keep:...}} are never renamed, and neither are the plug-in slot's own examples (S1-11's
     "Plug in any profession" box: other kinds of work on purpose; DECISIONS E12). */
  function renameAll(steps, pairs) {
    if (!pairs || !pairs.length) return;
    var res = pairs.map(function (p) { return [new RegExp("(^|[^A-Za-z0-9])" + p[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![A-Za-z0-9])", "g"), p[1]]; });
    var run = function (t) { return res.reduce(function (x, r) { return x.replace(r[0], function (m, pre) { return pre + r[1]; }); }, t); };
    var fix = function (t) {
      if (typeof t !== "string") return t;
      if (t.indexOf("{{") < 0 || !/\{\{\s*keep\s*:/.test(t)) return run(t);
      return t.split(/(\{\{\s*keep\s*:[^{}|]*\}\})/).map(function (x, i) { return i % 2 ? x : run(x); }).join("");
    };
    var deep = function (v) { if (Array.isArray(v)) return v.map(deep); if (v && typeof v === "object") { var o = {}; Object.keys(v).forEach(function (k) { o[k] = deep(v[k]); }); return o; } return fix(v); };
    eachStep(steps, function (s) {
      ["title", "does", "rule", "q", "t", "as"].forEach(function (k) { if (s[k]) s[k] = fix(s[k]); });
      ["more", "say", "vary", "form", "table"].forEach(function (k) { if (s[k]) s[k] = deep(s[k]); });
      if (s.slot) { var o = {}; Object.keys(s.slot).forEach(function (k) { o[k] = k === "examples" ? s.slot[k] : deep(s.slot[k]); }); s.slot = o; }
      /* Tools D: the amounts a step's slots read are the profession's example words too */
      if (s.amounts) s.amounts = deep(s.amounts);
      /* Tools F (T3): the time slots' stamped words, so they still match the renamed text */
      if (s.timed) s.timed = deep(s.timed);
      (s.branches || []).forEach(function (b) { b.label = fix(b.label); if (b.endText) b.endText = fix(b.endText); });
    });
  }

  /* ------------------------------------------------------------ the overlay */
  var WORDS_FIELDS = ["does", "more", "say", "t", "form", "table", "rule", "title", "who", "to"];
  var OP_FIELDS = {
    words: ["op", "at", "vary"].concat(WORDS_FIELDS),
    more: ["op", "at", "more"],
    after: ["op", "at", "steps"],
    before: ["op", "at", "steps"],
    branch: ["op", "at", "branch"],
    off: ["op", "at", "label", "why"]
  };
  /* Tools C: own steps added next to (or under) a stamped master step take its "took", and the flow's layer lines (the
     flow's "layerLines", written by build-master) are stamped on them as on master steps */
  function inheritStamps(list, anchor, F) {
    eachStep(list, function (x) {
      if (anchor.took && x.took === undefined) { x.took = anchor.took; if (x.when && x.when.took === undefined && (x.when.price || x.when.before || x.when.after || x.when.rec || x.when.recOff)) x.when.took = anchor.took; (x.branches || []).forEach(function (b) { if (b.when && b.when.took === undefined && (b.when.price || b.when.before || b.when.after || b.when.rec || b.when.recOff)) b.when.took = anchor.took; }); }
    });
    if (F && Array.isArray(F.layerLines) && F.layerLines.length) stampLayerLines(list, F.layerLines, anchor.sec);
    /* Tools D: own steps with amount slots read the flow's amount table (with the profession's rows laid over it) */
    if (F && F.amounts) eachStep(list, function (x) { if (!x.amounts && amountsIn(x)) x.amounts = F.amounts; });
    /* Tools F (T3): own steps after the timing is decided read it too */
    if (anchor.timing) eachStep(list, function (x) { if (x.timing === undefined) x.timing = anchor.timing; });
    /* Tools J (E1): own steps after the events step read the events; own steps with record slots read the record */
    if (anchor.wr === false) eachStep(list, function (x) { if (x.wr === undefined && x.took) { x.wr = false; var st = function (w) { if (w && (w.rec || w.recOff)) w.wr = false; }; st(x.when); (x.branches || []).forEach(function (b) { st(b.when); }); } });
    if (anchor.ev) eachStep(list, function (x) {
      if (x.ev !== undefined) return;
      x.ev = anchor.ev;
      var st = function (w) { if (w && (w.booking || w.rec || w.recOff)) w.ev = anchor.ev; };
      st(x.when); (x.branches || []).forEach(function (b) { st(b.when); });
    });
    var rf = F && F.record ? (F.id === "A" || F.id === "B" ? F.id : anchor.rec || anchor.took || anchor.ev) : null;
    if (rf) eachStep(list, function (x) { if (!x.rec && (recordSlotsIn(x).length || ledgerIn(x))) { x.rec = rf; if (!x.amounts && F.amounts) x.amounts = F.amounts; } });
  }
  /* stamp layer lines on the steps that message a line's recipients (or, with "more", whose "to" is one), inside the
     line's sections (default 3 to 12); sec = the section of steps whose id doesn't say it (own steps: their anchor's) */
  function stampLayerLines(steps, decls, sec) {
    eachStep(steps, function (s) {
      var m = /^[SAB](\d+)-/.exec(s.id || ""), n = m ? +m[1] : sec;
      decls.forEach(function (L) {
        var r = L.sections || [3, 12], to = L.to || [];
        if (n == null || n < r[0] || n > r[1]) return;
        /* (Tools G: a message from Rosie; a person's own message to the owner gets no line) */
        var msg = (s.say || []).some(function (x) { return Array.isArray(x) && to.indexOf(x[1]) >= 0 && x[0] === "san"; }) ||
          Object.keys(s.vary || {}).some(function (k) { return [].concat((s.vary[k] || {}).say || [], (s.vary[k] || {}).addSay || []).some(function (x) { return Array.isArray(x) && to.indexOf(x[1]) >= 0 && x[0] === "san"; }); });
        if (!msg && !(L.more && to.indexOf(s.to) >= 0)) return;
        s.layerAdd = (s.layerAdd || []).filter(function (x) { return x.id !== L.id; }).concat([L]);
      });
    });
    return steps;
  }
  /* apply(master, overlay, "A") -> { flow, errors }: new steps carry own: true, changed steps changed: true, unused
     ones off: "<why>" */
  function apply(master, ov, fl) {
    syncWays(master); /* (tools H: the ways of the master read) */
    var F = clone(master), errs = [];
    /* the slots first, with this profession's switches and settings, so its rename pairs see the words as before */
    var ctx = slotCtx(ov, fl), slotted = hasSlots(master);
    if (slotted) fillSteps(F.steps, ctx);
    renameAll(F.steps, ((ov.rename || {})[fl]) || []);
    /* Tools J (E3; REDESIGN 2 TOOL-SPEC 6.2): on the record master (the flow's "record" table) the profession's rename
       pairs run on the master's slot rows too, its own rows (ov.slots.<flow>) go before the master's, slot by slot, and its
       own services (money.<flow>.services) join the record's; syncWays(F) at the end reads this table */
    if (F.record && typeof F.record === "object") F.record = profRecord(F.record, ov, fl);
    if (ov.cast && ov.cast[fl]) F.cast = Object.assign({}, F.cast, ov.cast[fl]);
    if (ov.names && ov.names[fl]) F.names = Object.assign({}, F.names, ov.names[fl]);
    if (ov.story && ov.story[fl]) F.story = ov.story[fl];
    var lab = ((ov.money || {})[fl] || {}).labels;
    if (lab) F.money = Object.assign({}, F.money, { labels: lab });
    /* Tools D: the profession's own amounts (money.<flow>.amounts). Tools J E3 fix 8: ANY row the profession gives for a
       flow beats the header's example rows for that flow: its rows replace them (the most specific of its own rows wins, as
       amountRow reads); the header's example amounts apply only when it gives no amounts for that flow */
    var am = ((ov.money || {})[fl] || {}).amounts;
    if (am && typeof am === "object" && !Array.isArray(am) && Object.keys(am).length) { F.amounts = ownAmounts(am); eachStep(F.steps, function (s) { if (s.amounts) s.amounts = ownAmounts(am); }); }
    var ops = ((ov[fl] || {}).ops) || [];
    var I = index(F.steps);
    ops.forEach(function (o, n) {
      var where = fl + " op " + (n + 1) + " (" + o.op + " " + o.at + ")";
      var hit = I[o.at];
      if (!hit) { errs.push(where + ": no master step " + o.at + " in flow " + fl); return; }
      var s = hit.s;
      if (o.op === "words") {
        WORDS_FIELDS.forEach(function (k) { if (o[k] !== undefined) s[k] = o[k]; });
        /* a variant is merged field by field: the profession's words replace only the fields it gives */
        if (o.vary) { s.vary = Object.assign({}, s.vary || {}); Object.keys(o.vary).forEach(function (k) { s.vary[k] = Object.assign({}, s.vary[k] || {}, o.vary[k]); }); }
        s.changed = true;
      } else if (o.op === "more") {
        s.more = (s.more || []).concat(o.more || []);
        Object.keys(s.vary || {}).forEach(function (k) { var v = s.vary[k]; if (v.more) v.more = v.more.concat(o.more || []); });
        s.changed = true;
      } else if (o.op === "after" || o.op === "before") {
        if (!Array.isArray(o.steps) || !o.steps.length) { errs.push(where + ": needs steps"); return; }
        var add = o.steps.map(function (x) { return Object.assign(clone(x), { own: true }); });
        eachStep(add, function (x) { x.own = true; });
        /* Tools C: a profession's own steps after the money step follow what was taken, and get the layer lines */
        inheritStamps(add, s, F);
        var i = hit.list.indexOf(s);
        hit.list.splice.apply(hit.list, [o.op === "after" ? i + 1 : i, 0].concat(add));
        if (add[0] && s.phase && o.op === "before") { add[0].phase = s.phase; add[0].sec = s.sec; delete s.phase; }
        add.forEach(function (x) { if (x.sec == null) x.sec = s.sec; });
      } else if (o.op === "branch") {
        if (s.type !== "split") { errs.push(where + ": " + o.at + " isn't a decision"); return; }
        if (!o.branch || !o.branch.label) { errs.push(where + ": needs a branch with a label"); return; }
        var b = clone(o.branch); b.own = true; b.steps = b.steps || []; eachStep(b.steps, function (x) { x.own = true; });
        if (s.took && b.when && b.when.took === undefined && (b.when.price || b.when.before || b.when.after || b.when.rec || b.when.recOff)) b.when.took = s.took;
        inheritStamps(b.steps, s, F);
        s.branches.push(b); s.changed = true;
      } else if (o.op === "off") {
        if (!o.why) errs.push(where + ": say why");
        if (o.label) {
          var br = (s.branches || []).filter(function (x) { return x.label === o.label; })[0];
          if (!br) errs.push(where + ": no branch '" + o.label + "'"); else { br.off = o.why; eachStep(br.steps, function (x) { x.off = o.why; }); }
        } else s.off = o.why;
      } else errs.push(where + ": unknown op");
      I = index(F.steps);
    });
    /* slots in the profession's own words, then the keep markers go */
    if (slotted || JSON.stringify(ops).indexOf("{{") >= 0) { fillSteps(F.steps, ctx); unkeepSteps(F.steps); }
    if (F.record && typeof F.record === "object") syncWays(F); /* (tools J, E3: the profession's record table read) */
    var out = { flow: F, errors: errs };
    if (ctx.problems.length) out.slotProblems = ctx.problems.filter(function (x, i, a) { return a.indexOf(x) === i; });
    return out;
  }
  /* Tools J (E3): a flow's record table as one profession reads it (a copy; the master's table is never changed): the
     master's rows renamed with its pairs, its own rows first (each marked own: true), its own services added. A slot name
     the master doesn't have is left out here (check-prof reports it). */
  function profRecord(R0, ov, fl) {
    var R = clone(R0), pairs = ((ov.rename || {})[fl]) || [], own = (ov.slots && typeof ov.slots === "object" && ov.slots[fl]) || null;
    /* (E1 fix 3, T3: the profession's settings, for its rows' time slots; a key starting with _ is a note in record.json) */
    var sto = settingsOf(ov, fl); if (Object.keys(sto).length) R._settings = sto;
    var svc = (((ov.money || {})[fl] || {}).services) || null;
    if (R.slots && typeof R.slots === "object") Object.keys(R.slots).forEach(function (n) {
      var sl = R.slots[n]; if (!sl || !Array.isArray(sl.rows)) return;
      if (pairs.length) { var tmp = sl.rows.map(function (r) { return { does: r && typeof r.text === "string" ? r.text : "" }; }); renameAll(tmp, pairs); sl.rows.forEach(function (r, i) { if (r && typeof r.text === "string") r.text = tmp[i].does; }); }
      if (own && Array.isArray(own[n]) && own[n].length) sl.rows = own[n].map(function (r) { return Object.assign(clone(r), { own: true }); }).concat(sl.rows);
    });
    var given = svc && typeof svc === "object" && !Array.isArray(svc) ? svc : null;
    /* (E4: the example services this profession doesn't give take its own amounts rows' names and prices) */
    if (R.services && typeof R.services === "object" && !Array.isArray(R.services)) R.services = ownServices(R.services, R, ov, fl, given);
    if (given) R.services = Object.assign({}, R.services || {}, clone(given));
    return R;
  }
  /* Tools J (E4, Oct 27): a profession that gives amounts rows for a flow (money.<flow>.amounts) shows its OWN names and
     prices in the record's example services (the mixed-booking fixtures: two-full, two-calls, added-later, credit), never
     the master's example shop's ("Beard trim", "$55"). For each service of the flow that money.<flow>.services doesn't give
     (the profession's own services win; the caller lays them over): the row of its amounts for the service's combo
     (amountRow: the most fixed parts wins, "*" least, as E3 fix 8 reads amounts); where no row fits, the row of its main
     path (money.<flow>.main, else the record's); where none fits, its first row. The service keeps its way (price, before,
     after, paidby); its name and its amounts (price, deposit, rest, hold, paid, fee) come from that row, and a name the
     row lacks, and a price or fee it lacks, from its main path's row. A service paid in full whose row has a price but no
     paid takes paid = price. A profession with no fee on any row of the flow has no fee: the service's fee is $0 (S13-55, E4
     round 2). Without
     amounts rows for the flow: the master's example services, as before. */
  function ownServices(S0, R, ov, fl, given) {
    var m = (ov.money || {})[fl] || {}, am = m.amounts;
    if (!am || typeof am !== "object" || Array.isArray(am) || !Object.keys(am).length) return S0;
    var mk = String(m.main || (R.main && (typeof R.main === "string" ? R.main : R.main[fl])) || (fl === "B" ? "list|card|bill" : "list|card|counter")).split("|");
    var mainRow = amountRow(am, { price: mk[0], before: mk[1], after: mk[2] }), first = null, out = {};
    /* S13-55: one late-cancel and no-show fee per booking, set by the business: no fee on any row of the flow = no fee ($0) */
    var noFee = !Object.keys(am).some(function (k) { return am[k] && typeof am[k] === "object" && am[k].fee !== undefined; });
    Object.keys(am).some(function (k) { if (am[k] && typeof am[k] === "object" && !Array.isArray(am[k])) { first = am[k]; return true; } return false; });
    Object.keys(S0).forEach(function (id) {
      var s = S0[id];
      if ((given && Object.prototype.hasOwnProperty.call(given, id)) || !s || typeof s !== "object" || Array.isArray(s) || (s.flow && s.flow !== fl)) { out[id] = s; return; }
      var row = amountRow(am, { price: s.price, before: s.before, after: s.after });
      if (!Object.keys(row).length) row = mainRow;
      if (!Object.keys(row).length) row = first || {};
      var n = Object.assign({}, s), a = {}, nm = row.name !== undefined ? row.name : mainRow.name;
      AMOUNTS.forEach(function (f) { if (f !== "name" && row[f] !== undefined) a[f] = row[f]; });
      ["price", "fee"].forEach(function (f) { if (a[f] === undefined && mainRow[f] !== undefined) a[f] = mainRow[f]; }); /* (the profession's own price and fee, when this combo's rows give none) */
      /* paid in full is its price: a service whose way is full and whose row gives a price but no paid takes paid = price
         (a profession needs no "full" row of its own for a made-up two-full example) */
      if (s.before === "full" && a.paid === undefined && a.price !== undefined) a.paid = a.price;
      if (noFee && a.fee === undefined) a.fee = "$0";
      delete n.name; if (nm !== undefined) n.name = nm;
      n.amounts = a;
      out[id] = n;
    });
    return out;
  }
  function ignoredFields(ov, fl) {
    var out = [];
    (((ov[fl] || {}).ops) || []).forEach(function (o, n) {
      var known = OP_FIELDS[o.op]; if (!known) return;
      var extra = Object.keys(o).filter(function (k) { return known.indexOf(k) < 0; });
      if (extra.length) out.push({ n: n + 1, op: o.op, at: o.at, fields: extra });
    });
    return out;
  }

  /* ------------------------------------------------------------ what a profession shows */
  var parseCombo = function (k) { var p = String(k).split("|"); return { price: p[0], before: p[1], after: p[2] }; };
  /* the paths a profession lists, each with its switches and facts (booking: the defaults; checkers walk the rest) */
  function useCombos(F, ov, fl) {
    var m = (ov.money || {})[fl] || {}, sw = switchesOf(ov, fl), facts = factsOf(ov);
    return (m.combos || (F.money || {}).combos || []).map(function (k) { var c = parseCombo(k); c.pf = sw; c.facts = facts; return c; });
  }
  /* is a booking value one the profession uses? (any booking `when` or key is lit if one of its values is used) */
  function bookingUsed(vals, allowed) { var by = {}; (vals || []).forEach(function (v) { var g = GROUP_OF[v]; if (g) (by[g] = by[g] || []).push(v); }); return Object.keys(by).every(function (g) { return by[g].some(function (v) { return (allowed[g] || []).indexOf(v) >= 0; }); }); }
  /* the page's profession view: only the money paths, booking choices, switches and facts this profession uses. Other
     words drop out, branches its facts rule out and steps no path of it reaches are marked not used. */
  function forPage(F, ov, fl) {
    syncWays(F); /* (tools H) */
    var m = (ov.money || {})[fl] || {};
    F.money = Object.assign({}, F.money, { combos: m.combos || F.money.combos, main: m.main || F.money.main, examples: Object.assign({}, F.money.examples, m.examples || {}), labels: m.labels || null });
    var sw = switchesOf(ov, fl), facts = factsOf(ov), allowed = bookingOf(ov, fl, F);
    /* (Tools F: where the flow names a late value, times line, the profession's list is given, so the picker offers line
       only to a profession that lists it) */
    var lateRead = Object.keys(valuesRead(F)).some(function (v) { return !!LATE_VALUES[v]; });
    F.pf = sw; F.facts = facts; F.bookingAllowed = m.booking || Object.keys(bookingFromSplits(F, ov, fl)).length || lateRead ? allowed : null;
    var useC = F.money.combos.map(function (k) { var c = parseCombo(k); c.pf = sw; return c; });
    /* money only here (booking choices and plug-in gates are judged apart) */
    var litMoney = function (w, c) { var x = {}; Object.keys(w || {}).forEach(function (d) { if (d !== "booking" && GATES.indexOf(d) < 0) x[d] = w[d]; }); return lit(x, c); };
    /* why a `when` rules a branch or step out for this profession, or null */
    var gateWhy = function (w) {
      var g = gatesOf(w);
      if (g && !lit(g, { pf: sw, facts: facts })) return "not in this kind of work (its plug-in switches or facts)";
      if (w && w.booking && !bookingUsed(w.booking, allowed)) return "not a booking choice this profession uses";
      return null;
    };
    (function hide(ss, whens, gated) {
      (ss || []).forEach(function (s) {
        /* a step's own `when` may name money choices too (part B): they count for it and what's under it */
        var ws = s.when ? whens.concat([s.when]) : whens;
        var shown = useC.some(function (c) { return ws.every(function (w) { return litMoney(w, c); }); });
        var own = gated || (s.when ? gateWhy(s.when) : null);
        if (own && !s.off) s.off = own;
        else if (!shown && !s.off) s.off = "not on a money path this profession uses";
        if (s.vary) {
          Object.keys(s.vary).forEach(function (k) {
            var cd = parseVaryKey(k), x = {};
            if (cd) Object.keys(cd).forEach(function (d) { if (d !== "booking") x[d] = cd[d]; });
            if (!cd || !useC.some(function (c) { return keyFits(x, c); }) || (cd.booking && !bookingUsed(cd.booking, allowed))) delete s.vary[k];
          });
          if (!Object.keys(s.vary).length) delete s.vary;
        }
        (s.branches || []).forEach(function (b) { hide(b.steps, b.when ? ws.concat([b.when]) : ws, own || gateWhy(b.when)); });
      });
    })(F.steps, [], null);
    return F;
  }

  return {
    ways: ways, useWays: useWays, d75: d75, useD75: useD75, syncWays: syncWays, normWays: normWays, setsOnly: setsOnly, BEFORE_WAYS: BEFORE_WAYS,
    LATE_VALUES: LATE_VALUES, allValues: allValues, groupValues: groupValues, bookingLabel: bookingLabel, valuesRead: valuesRead,
    MONEY: MONEY, SWITCHES: SWITCHES, FACTS: FACTS, BOOKING: BOOKING, GROUP_OF: GROUP_OF, NAME: NAME, WORDS_FIELDS: WORDS_FIELDS, OP_FIELDS: OP_FIELDS,
    GATES: GATES, withSets: withSets, HISTORIC: HISTORIC, pathSig: pathSig, setsKey: setsKey, setsWords: setsWords, lateSets: lateSets, setsScopes: setsScopes, walkSets: walkSets, LATE_GROUPS: LATE_GROUPS, eventsUnderChoice: eventsUnderChoice, AMOUNTS: AMOUNTS, AMOUNT_RE: AMOUNT_RE, amountsIn: amountsIn, amountRow: amountRow, fillAmounts: fillAmounts, fillAmountText: fillAmountText, mergeAmounts: mergeAmounts, amountTableProblems: amountTableProblems,
    firstTexts: firstTexts, applyStops: applyStops, textTo: textTo, TEXT_VIA: TEXT_VIA, switchOn: switchOn, bookingValue: bookingValue, impliedValue: impliedValue, bookingCanon: bookingCanon, groupsRead: groupsRead, withImplied: withImplied, IMPLIES: IMPLIES, IMPLIED: IMPLIED, tookPath: tookPath, addLayerLines: addLayerLines, layerLineText: layerLineText, stampLayerLines: stampLayerLines, lit: lit, chooses: chooses, gatesOf: gatesOf, parseVaryKey: parseVaryKey, keyFits: keyFits, keySpec: keySpec,
    resolveVary: resolveVary, keySwitches: keySwitches, bookingGroups: bookingGroups, keyBookings: keyBookings, isLayer: isLayer, applyLayer: applyLayer, layerFields: layerFields, swapRes: swapRes, swapDeep: swapDeep, EXTRA: EXTRA,
    parseAbsT: parseAbsT, parseRelT: parseRelT, looksRelative: looksRelative, resolveRel: resolveRel, stepTimes: stepTimes, timeProblems: timeProblems, fmtTime: fmtTime, clockMin: clockMin,
    readsTiming: readsTiming, timedMode: timedMode, applyTimed: applyTimed, TIMED_WORDS: TIMED_WORDS, timedAlt: timedAlt,
    SLOTS: SLOTS, SLOT_RE: SLOT_RE, fillText: fillText, fillSteps: fillSteps, fillFlow: fillFlow, unkeepSteps: unkeepSteps, hasSlots: hasSlots, slotCtx: slotCtx, slotProblems: slotProblems, stepTexts: stepTexts, cutoffChecks: cutoffChecks, cutoffRule: cutoffRule, CUTOFF_MASTER: CUTOFF_MASTER,
    switchesOf: switchesOf, derivedNo2: derivedNo2, no2Disagree: no2Disagree, bookingFromSplits: bookingFromSplits, NO2_SPLITS: NO2_SPLITS, settingsOf: settingsOf, SETTINGS: SETTINGS, factsOf: factsOf, bookingOf: bookingOf, pluginProblems: pluginProblems, switchList: switchList, factList: factList,
    clone: clone, eachStep: eachStep, index: index, renameAll: renameAll, apply: apply, ignoredFields: ignoredFields, profRecord: profRecord, laterWay: laterWay,
    parseCombo: parseCombo, useCombos: useCombos, forPage: forPage,
    /* Tools J (E1; TOOL-SPEC 8.2) */
    recordOf: recordOf, REC: REC, recFits: recFits, litOn: litOn, useRecord: useRecord, record: record, recordOn: recordOn, recordSlotNames: recordSlotNames, EVENT_GROUPS: EVENT_GROUPS, noEvents: noEvents,
    RECORD_SLOT_RE: RECORD_SLOT_RE, recordSlotsIn: recordSlotsIn, ledgerIn: ledgerIn, LEDGER_RE: LEDGER_RE, slotRow: slotRow, fillRecord: fillRecord, ledgerRow: ledgerRow, LEDGER_AMOUNTS: LEDGER_AMOUNTS, RECORD_WAYS: RECORD_WAYS,
    amountN: amountN, amountText: amountText, visitAnchorOf: visitAnchorOf, MASTER_RULE: MASTER_RULE, liveOff: liveOff, isLiveOff: isLiveOff, oneFee: oneFee, EV_GROUPS: EV_GROUPS, findService: findService, severalOf: severalOf, addService: addService, servicesOf: servicesOf, mainPath: mainPath
  };
});
