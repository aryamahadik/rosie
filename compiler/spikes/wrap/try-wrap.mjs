// Spike T-131: apply one trade's overlay to a master flow with the master's own CommonJS scripts, loaded unchanged
// (wrap), and print one step the way the master's step.js prints it.
//
//   node compiler/spikes/wrap/try-wrap.mjs <trade> <flow A|B> <step id> [<step id> ...] [--path "<path>"]
//        [--against <file>]   compare the printed lines with a saved copy; the verdict goes to stderr
//   node compiler/spikes/wrap/try-wrap.mjs --bench [<trades>]   time the load, and the apply of the trades in both flows
//
// With no --path, the path is the card's: "A list|none|bill pf=sensitive,welfare" (what the reference run of
// `node work/build/step.js A A10-01 --prof aba --path ...` used).
// The printing below is step.js's, in the same order (read from the scratch copy; step.js itself is not vendored).
// The three scripts are not edited; fixtures/master/ is not touched.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { makeLoader } from "./cjs-load.mjs";

const DEFAULT_PATH = "A list|none|bill pf=sensitive,welfare";
const build = fileURLToPath(new URL("../../../fixtures/master/engine/work/build/", import.meta.url));

const t0 = performance.now();
const load = makeLoader();
const L = load(build + "lib.js"); // lib.js requires msgtext.js and overlay-core.js through the same loader
const CORE = L.CORE; // the overlay core, "the ONE place where a profession's overlay is applied"
const tLoad = performance.now() - t0;
const HERE = L.HERE;

const readJson = (rel) => JSON.parse(readFileSync(HERE + "/" + rel, "utf8"));

/** Apply a trade's overlay to a master flow. step.js: `F = O.apply(F, ov, fl).flow` (overlay.js's apply is CORE.apply). */
function applyTrade(trade, fl) {
  const r0 = performance.now();
  const master = readJson("work/master/master-" + fl + ".json");
  const ov = readJson("work/prof/" + trade + ".json");
  const a0 = performance.now();
  const flow = CORE.apply(master, ov, fl).flow;
  return { ov, flow, readMs: a0 - r0, applyMs: performance.now() - a0 };
}

if (process.argv[2] === "--bench") {
  // the second argument limits the sample to the first N trades (the whole set is 243 trades x 2 flows)
  const limit = Number(process.argv[3] ?? Infinity);
  const trades = readdirSync(HERE + "/work/prof")
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .slice(0, limit);
  console.log(`load of lib.js + msgtext.js + overlay-core.js: ${tLoad.toFixed(1)} ms (once per process)`);
  let failed = 0;
  const applies = [];
  const reads = [];
  const t = performance.now();
  for (const trade of trades) {
    for (const fl of ["A", "B"]) {
      try {
        const r = applyTrade(trade, fl);
        applies.push(r.applyMs);
        reads.push(r.readMs);
      } catch (e) {
        failed++;
        console.log(`apply failed ${trade} ${fl}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  const total = performance.now() - t;
  const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const max = (xs) => Math.max(...xs);
  console.log(
    `${applies.length + failed} applies (${trades.length} trades x 2 flows) in ${total.toFixed(0)} ms in all; failed ${failed}`,
  );
  console.log(`apply only:  median ${med(applies).toFixed(1)} ms, max ${max(applies).toFixed(1)} ms`);
  console.log(
    `JSON read:   median ${med(reads).toFixed(1)} ms, max ${max(reads).toFixed(1)} ms (master + trade file)`,
  );
  const first = applies[0] ?? 0;
  console.log(`first apply (cold): ${first.toFixed(1)} ms`);
  process.exit(0);
}

const args = process.argv.slice(2);
const take = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args.splice(i, 2)[1] : null;
};
const against = take("--against");
const pathText = take("--path") ?? DEFAULT_PATH;
const [trade, fl, ...ids] = args;
if (!trade || !fl || !ids.length) {
  console.error('usage: try-wrap.mjs <trade> <A|B> <step id> [...] [--path "<path>"] [--against <file>]');
  process.exit(2);
}

const out = [];
const log = (s) => out.push(s);

const { ov, flow: F, readMs, applyMs } = applyTrade(trade, fl);

// relative times: what each comes to on the paths (every branch)
let TIMES = null;
const timeText = (s) => {
  if (!s.t || !CORE.parseRelT(s.t)) return s.t;
  TIMES = TIMES || CORE.stepTimes(F.steps, null);
  const xs = TIMES[s.id] || [];
  return (
    s.t +
    (xs.length ? " = " + xs.map((x) => CORE.fmtTime(x.tm)).join(" or ") : " (no time before it to read)")
  );
};
const sw = CORE.switchesOf(ov, fl);
const offHere = (k) => (CORE.keySwitches(k).some((n) => !sw[n]) ? " (switch off here)" : "");
const msg = (m) => "    " + m[0] + " → " + m[1] + ": " + L.MSG.smsText(m).replace(/\n/g, " / ");
const REC = CORE.record ? CORE.record(fl) : null;
const PATH = L.parsePath(pathText, fl);
if (!PATH || PATH.problems) {
  console.log("--path '" + pathText + "': " + ((PATH && PATH.problems) || ["can't read it"]).join("; "));
  process.exit(1);
}
const pname = (c) => (L.pathName ? L.pathName(c) : L.pathKey(c));
const mainPath = () => {
  const k = REC && REC.main && REC.main[fl];
  if (!k) return null;
  const r = L.parsePath ? L.parsePath(k, fl) : null;
  return r && !r.problems ? r : null;
};
const slotsIn = (s) => (CORE.recordSlotsIn ? CORE.recordSlotsIn(s) || [] : []);
const slotWords = (s, n, c) => {
  const mini = { id: s.id, does: "{{" + n + "}}" };
  ["took", "ev", "rec", "amounts", "timed", "timing", "sec"].forEach((k) => {
    if (s[k] !== undefined) mini[k] = s[k];
  });
  return CORE.resolveVary(mini, c).step.does;
};
function recLine(r) {
  if (!r) return "none";
  const a = (k) => {
    const x = (r.ledger || {})[k];
    return x && x.text != null ? x.text : x && x.n != null ? "$" + x.n : "?";
  };
  return [
    (r.svc || []).length + " service" + ((r.svc || []).length === 1 ? "" : "s"),
    "now " + a("now"),
    "due " + a("due"),
    "keep " + a("keep"),
    "back " + a("back"),
  ]
    .concat(
      r.card ? ["card saved"] : ["no card"],
      r.credits ? [r.credits + " credit" + (r.credits > 1 ? "s" : "")] : [],
      r.charge && r.charge !== "none" ? ["charge " + r.charge] : [],
      r.contact && r.contact.state && r.contact.state !== "kept" ? ["contact " + r.contact.state] : [],
    )
    .join(" · ");
}

L.eachStep(F.steps, (s) => {
  if (!ids.includes(s.id)) return;
  log(
    "### " +
      s.id +
      " · " +
      s.title +
      (s.type === "split" ? "  ◆ " + s.q : "") +
      (s.own ? " [OWN]" : s.changed ? " [CHANGED]" : "") +
      (s.off ? " [OFF: " + s.off + "]" : ""),
  );
  log(
    "- lines " +
      (s.line || []).join(", ") +
      " · " +
      s.who +
      (s.to ? " → " + s.to : "") +
      " · " +
      s.via +
      (s.t ? " · " + timeText(s) : "") +
      " · needs " +
      (s.needs || []).join(" ") +
      " · gives " +
      (s.gives || []).join(" "),
  );
  if (s.when)
    log(
      "- only when: " +
        L.stepWhenText(s.when).join(" + ") +
        (!L.lit(s.when, { pf: CORE.switchesOf(ov, fl), facts: CORE.factsOf(ov) })
          ? " [not in this kind of work: its plug-in switches or facts]"
          : ""),
    );
  if (Array.isArray(s.reads) && s.reads.length)
    log(
      "- follows: " +
        s.reads
          .map((r) => r + (REC && REC.homes && REC.homes[r] ? " (" + REC.homes[r] + ")" : ""))
          .join(" · "),
    );
  if (s.text) log("- shared text: " + s.text + " (its words are written once for flow A and flow B)");
  if (REC)
    slotsIn(s).forEach((n) => {
      const sl = (REC.slots || {})[n],
        mp = mainPath();
      log(
        "- slot " +
          n +
          ": " +
          (sl
            ? (sl.rows || []).length + " rows" + (sl.home ? " (home " + sl.home + ")" : "")
            : "not in the record table") +
          (sl && mp ? "; on " + pname(mp) + ": '" + slotWords(s, n, mp) + "'" : "") +
          (sl && PATH ? "; on " + pname(PATH) + ": '" + slotWords(s, n, PATH) + "'" : ""),
      );
    });
  if (s.does) log("- " + s.does);
  (s.more || []).forEach((x) => log("  - " + x));
  (s.say || []).forEach((m) => log(msg(m)));
  (s.form || []).forEach((r) => log("  [screen] " + r[0] + ": " + r[1]));
  if (s.table)
    log(
      "  [screen table] " +
        s.table.head.join(" | ") +
        " / " +
        s.table.rows.map((r) => r.join(" | ")).join(" / "),
    );
  if (s.rule) log("- RULE: " + s.rule);
  if (s.slot) log("- PLUG-IN: " + JSON.stringify(s.slot));
  if (s.took) log("- money words follow what this booking took (flow " + s.took + ")");
  (s.layerAdd || []).forEach((x) =>
    log(
      "- layer line '" +
        x.id +
        "' (to " +
        (x.to || []).join(", ") +
        ", where " +
        JSON.stringify(x.when || {}) +
        "): " +
        x.line,
    ),
  );
  if (s.amounts)
    log(
      "- amounts its slots read, by money path: " +
        Object.keys(s.amounts)
          .map(
            (k) =>
              k +
              " " +
              Object.keys(s.amounts[k])
                .map((f) => f + " " + s.amounts[k][f])
                .join(", "),
          )
          .join(" · "),
    );
  Object.keys(s.vary || {}).forEach((k) => {
    const v = s.vary[k];
    log("- vary [" + k + "]" + offHere(k) + (v.does ? ": " + v.does : ""));
    (v.say || []).forEach((m) => log("  " + msg(m)));
    (v.more || []).forEach((x) => log("    - " + x));
    if (v.rule) log("    - RULE: " + v.rule);
    (v.form || []).forEach((r) => log("    [screen] " + r[0] + ": " + r[1]));
    if (v.table)
      log(
        "    [screen table] " +
          v.table.head.join(" | ") +
          " / " +
          v.table.rows.map((r) => r.join(" | ")).join(" / "),
      );
    (v.swap || []).forEach((p) => log("    swap: '" + p[0] + "' → '" + p[1] + "'"));
    (v.addMore || []).forEach((x) => log("    + line: " + x));
    (v.addSay || []).forEach((m) => log("    + " + msg(m).trim()));
  });
  (s.branches || []).forEach((b) =>
    log(
      "  > branch: " +
        b.label +
        (b.when ? " " + JSON.stringify(b.when) : "") +
        (CORE.gatesOf(b.when) &&
        !L.lit(CORE.gatesOf(b.when), { pf: CORE.switchesOf(ov, fl), facts: CORE.factsOf(ov) })
          ? " [not in this kind of work: its plug-in switches or facts]"
          : "") +
        (b.end === "end" ? " → ends: " + b.endText : " → rejoins") +
        " · first step " +
        ((b.steps || [])[0] || {}).id +
        (b.sets && typeof b.sets === "object" && Object.keys(b.sets).length
          ? " · sets " +
            CORE.setsWords(b.sets) +
            (b.end === "end"
              ? " (for its own steps)"
              : " (for its own steps and the rest of the path after it rejoins)")
          : ""),
    ),
  );
  const R = CORE.resolveVary(s, PATH),
    w = R.step;
  log(
    "- on " +
      pname(PATH) +
      " [keys: " +
      (R.keys.join(", ") || "base") +
      "]" +
      (CORE.recordOf && REC
        ? " · record: " +
          recLine(CORE.recordOf(!s.ev && CORE.noEvents ? CORE.noEvents(PATH) : PATH, fl, !!s.took, s.amounts))
        : ""),
  );
  if (w.does) log("  " + w.does);
  (w.more || []).forEach((x) => log("    - " + x));
  (w.say || []).forEach((m) => log("  " + msg(m)));
  (w.form || []).forEach((r) => log("    [screen] " + r[0] + ": " + r[1]));
  if (w.rule) log("  RULE: " + w.rule);
  (s.branches || []).forEach((b) => {
    if (CORE.lit(b.when, PATH)) log("    > " + b.label + (b.end === "end" ? " → ends: " + b.endText : ""));
  });
});

for (const line of out) console.log(line);

console.error(
  `[try-wrap] ${out.length} lines; load ${tLoad.toFixed(1)} ms; JSON read ${readMs.toFixed(1)} ms; apply ${trade} ${fl} ${applyMs.toFixed(1)} ms`,
);
if (against) {
  const want = readFileSync(against, "utf8").replace(/\n$/, "").split("\n");
  const same = want.length === out.length && want.every((line, i) => line === out[i]);
  console.error(
    same
      ? `[try-wrap] SAME as ${against} (${want.length} lines)`
      : `[try-wrap] DIFFERENT from ${against} (${want.length} lines there, ${out.length} here)`,
  );
  if (!same) process.exitCode = 1;
}
