// The checks of bundle v1 (T-1460's "Proves it with"), run from the repository root:
//
//   node bundles/v1/check.mjs --step-js <step.js of a master copy> [--full <full build folder>] [--db]
//
//   --step-js  the master's step.js, in a read-only copy of the master (never the handover folder: rule 2), such as
//              scratch/fixture-v1-copy/engine/work/build/step.js; it is run as `node <step.js> A <step>` for each step.
//   --full     also hold the cut against the compiler's whole build it was cut from (build.mjs's run 2): each step and
//              every trade overlay byte for byte the build's (a step but its lint), the rest of flow A and the manifest
//              the build's but the fields the cut writes.
//   --db       also read the published bundle back from PostgreSQL (DATABASE_URL, else the local database when CI is
//              unset; db/repo/client.ts): K-05's readActiveBundle, then readBundleValue for every part.
//
// What it checks, each printed as one line, ok or FAIL (exit 1 on any FAIL); a line starting with spaces is a note:
//   1. bundles/v1/bundle/ validates against K-01 v1 and passes `compiler build`'s own checks on what it wrote (the
//      compiler's checkBundleDir, each file against its own definition, its bundle id the content hash of its stored
//      values, T-150), and holds flow A's S1-01, S1-02, S1-11, S1-04, S1-03 and S1-74 alone, with every trade of fixture
//      set v1's overlay, marked partial.
//   2. S1-01 and S1-02 are bundle v0 …/2's byte for byte (card fields, words, branches, options and their order), so a
//      question asked under v0 keeps its options (DL-961).
//   3. Each step's words equal what step.js prints for it, apart from slotted sample values: each step is written in
//      step.js's own lines (its title, lines, follows, does, more, each message's plain form, its screen, its rule box,
//      its plug-in slot and each branch), a slot {{...}} standing for any words, and compared line by line.
//   4. S1-02's branches: "All on the list" leads to S1-11, then S1-04; "One isn't on the list yet" leads to S1-03;
//      "Not a service we book" leads to S1-74 and its end text. Each step the walk reads there is held.
//   5. S1-11 is automatic (no question: no card, no split, no message) and its next is S1-04.
//   6. The opt-out marker: S1-02's question carries it, on Rosie's first reply in the chat the owner opened (T-141,
//      Q-30); the owner's texts and the four new steps' messages carry none (the line renders once in a chat).
//   7. Every trade overlay: K-01 v1's tradeOverlay, its 11 pf text blocks each the trade file's own value as JSON text
//      (MC R3; K-01 default 3) as the build compiles it, with the corrections the emitter applies to the trade itself
//      (C5; C7's marks, the only change to a block's words, each carrying C7's "business's own word"); C5's fills
//      (insurance's facts, cpa.json's list; the trades with no pf.settings at arrive window and an empty cutoff in both
//      flows); plumbing (plumber), electrical (electrician) and barber read back with all 11 pf keys from the bundle
//      folder and the KV bulk file (and PostgreSQL with --db).
//   8. T-160's lint (compiler/src/lint/report.ts) of the master's flows and of every trade's flows the bundle holds,
//      with the emitter's own marks, finds exactly the two marks the whole build gives the six steps, its own and not
//      the cut's (DL-965), and no other: notary's S1-02 record-lint L7 (notary's flow A words op at S1-02 drops "Safe
//      default:") and S1-04 unknown-slot (its owner sample reply names {{biz.name}}, outside K-01 v1's slot list); the
//      manifest's lint summary counts exactly the failures the steps' marks and the lint give the six steps.
//   9. The manifest: bundle v0 …/2's prompts, models, routing and fixed lines (staging's base path /test), the prompts as
//      their modules give them today and prompts.json and models.json as the build read them; no journey, as v0 lists
//      none.
//  10. The KV bulk file bundles/v1/bundle.kv.json holds one entry per part, every key under the bundle id, each value
//      the part's bytes.
//  11. With --full: the cut against the whole build (above).
//  12. With --db: readActiveBundle answers, and readBundleValue gives back every part byte for byte; the three trades'
//      overlays read back from PostgreSQL with all 11 pf keys.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  BUILD,
  BUNDLE_DIR,
  ENVIRONMENT,
  FLOW,
  HERE,
  KV_FILE,
  PROMPTS_FILE,
  ROOT,
  STEPS,
  V0_DIR,
  V0_STEPS,
  fixedLinesOfStaging,
  load,
  promptsFromModules,
  stepDifferences,
} from "./build.mjs";

const K01_FIXED_LINES = join(ROOT, "contracts/bundle/fixtures/fixed-lines.json");
const PROMPT_KINDS = ["safetyRead", "decide", "planner", "composer"];
const PF_KEYS = [
  "pf.license",
  "pf.services",
  "pf.questions",
  "pf.safety",
  "pf.first_steps",
  "pf.visit",
  "pf.money",
  "pf.messages",
  "pf.staff",
  "pf.rules",
  "pf.edges",
];
/** The kinds of work the card names, by their trade ids in fixture set v1 (engine/work/prof/<id>.json). */
const READ_BACK = [
  ["plumbing", "plumber"],
  ["electrical", "electrician"],
  ["barber", "barber"],
];
/** The manifest fields the cut writes itself (build.mjs); every other is the whole build's. */
const CUT_FIELDS = ["bundleId", "lint", "journeys", "storage", "partial", "lists"];

let failed = 0;

function report(ok, what) {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
}

function note(what) {
  console.log(`     ${what}`);
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function args() {
  const usage = "usage: node bundles/v1/check.mjs --step-js <step.js> [--full <full build folder>] [--db]";
  const given = process.argv.slice(2);
  const out = { stepJs: null, full: null, db: false };
  const path = (text) => (isAbsolute(text) ? text : resolve(process.cwd(), text));
  for (let k = 0; k < given.length; k += 1) {
    if (given[k] === "--db") out.db = true;
    else if ((given[k] === "--step-js" || given[k] === "--full") && given[k + 1] !== undefined) {
      out[given[k] === "--step-js" ? "stepJs" : "full"] = path(given[k + 1]);
      k += 1;
    } else throw new Error(`${usage} (not "${given[k]}")`);
  }
  if (out.stepJs === null) throw new Error(usage);
  return out;
}

// ---- 1. K-01 v1, the build's own checks, what it holds ------------------------------------------------------------

async function checkBundle(emit, ids, tradeIds) {
  const problems = emit.checkBundleDir(BUNDLE_DIR);
  report(
    problems.length === 0,
    `K-01 v1 (checkBundleDir, Ajv 2020-12 strict: the whole bundle, and each file the value its manifest's storage lists): ${problems.length === 0 ? "valid" : problems.slice(0, 5).join("; ")}`,
  );
  const read = emit.readBundleDir(BUNDLE_DIR);
  const { manifest, flows, trades } = read.bundle;
  const own = [
    ...emit.checkBundlePart(manifest, "manifest").map((p) => `manifest ${p}`),
    ...Object.entries(flows).flatMap(([flow, graph]) =>
      emit.checkBundlePart(graph, "flowGraph").map((p) => `flow ${flow} ${p}`),
    ),
    ...Object.entries(trades).flatMap(([trade, overlay]) =>
      emit.checkBundlePart(overlay, "tradeOverlay").map((p) => `trade ${trade} ${p}`),
    ),
  ];
  report(
    own.length === 0,
    `each file against its own definition (manifest, flowGraph, ${String(Object.keys(trades).length)} tradeOverlay): ${own.length === 0 ? "valid" : own.slice(0, 5).join("; ")}`,
  );
  const idProblems = ids.bundleIdProblems(manifest);
  const hash = ids.contentHashOfFiles(read.files);
  const idOk = idProblems.length === 0 && hash === manifest.bundleId.hash && manifest.bundleId.build === BUILD;
  report(
    idOk,
    `bundle id ${manifest.bundleId.hash}/${String(manifest.bundleId.build)}: ${idOk ? `the content hash of its ${String(read.files.length - 1)} stored values (T-150), build ${String(BUILD)}` : [...idProblems, `files hash to ${hash}`].join("; ")}`,
  );
  const paths = read.files.map((file) => file.path);
  const want = ["flow/A.json", "manifest.json", ...tradeIds.map((id) => `trade/${id}.json`)].sort();
  report(
    same(paths, want),
    `files: flow/A.json, manifest.json and trade/<id>.json for each of fixture set v1's ${String(tradeIds.length)} trades (${String(paths.length)} files)`,
  );
  report(
    manifest.partial === true && same(Object.keys(flows), [FLOW]) && same(Object.keys(trades).sort(), tradeIds),
    `partial: ${String(manifest.partial)}; flows: ${Object.keys(flows).join(", ")}; trades: ${String(Object.keys(trades).length)}`,
  );
  const held = Object.keys(flows[FLOW].steps);
  report(
    same([...held].sort(), [...STEPS].sort()),
    `steps of flow ${FLOW}: ${held.join(", ")} (the build's page order; S1-03 and S1-74 sit in S1-02's branches)`,
  );
  return read;
}

// ---- 2. bundle v0 …/2's S1-01 and S1-02 ---------------------------------------------------------------------------

function checkV0(emit, bundle) {
  const problems = emit.checkBundleDir(V0_DIR);
  const v0 = emit.readBundleDir(V0_DIR).bundle;
  const id = v0.manifest.bundleId;
  report(
    problems.length === 0 && id.build === 2,
    `bundle v0 read back from bundles/v0/bundle: ${id.hash}/${String(id.build)}${problems.length === 0 ? ", sound" : `: ${problems.slice(0, 3).join("; ")}`}`,
  );
  for (const step of V0_STEPS) {
    const ours = bundle.flows[FLOW].steps[step];
    const theirs = v0.flows[FLOW]?.steps?.[step];
    const differ = stepDifferences(ours, theirs);
    const text = JSON.stringify(ours);
    const options = ours?.card?.means?.map((means) => means.branch) ?? [];
    const labels = (ours?.branches ?? []).map((branch) => branch.label);
    report(
      differ.length === 0,
      `${step} is bundle v0 …/2's byte for byte (${String(Buffer.byteLength(text, "utf8"))} bytes, sha256 ${sha256(text)})${options.length > 0 ? `; its card's options in order: ${options.join(" | ")}; its branches in order: ${labels.join(" | ")}` : ""}${differ.length === 0 ? "" : `: ${differ.join("; ")}`}`,
    );
  }
  return v0;
}

// ---- 3. step.js's words -------------------------------------------------------------------------------------------

/** A line with slots: its literal parts escaped, each {{...}} any words (at least one character). */
function pattern(line) {
  const parts = line.split(/(\{\{[^{}]+\}\})/);
  return new RegExp(
    `^${parts.map((part) => (/^\{\{[^{}]+\}\}$/.test(part) ? "(.+?)" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("")}$`,
    "s",
  );
}

/**
 * The step written as step.js writes it (step.js lines 49 to 62 and 74; the fields the six steps use): its title, lines,
 * follows, does, more, messages, screen rows, screen table, rule box, plug-in slot and branches. A field step.js prints
 * that this leaves out shows as a line step.js has and this does not, so the comparison fails.
 */
function asStepJs(step, homes) {
  const lines = [];
  lines.push(`### ${step.id} · ${step.title}${step.type === "split" ? `  ◆ ${step.q}` : ""}`);
  lines.push(
    `- lines ${(step.lines ?? []).join(", ")} · ${step.who}${step.to ? ` → ${step.to}` : ""} · ${step.via}${step.t ? ` · ${step.t}` : ""} · needs ${(step.needs ?? []).join(" ")} · gives ${(step.gives ?? []).join(" ")}`,
  );
  if (Array.isArray(step.reads) && step.reads.length > 0)
    lines.push(`- follows: ${step.reads.map((r) => r + (homes[r] ? ` (${homes[r]})` : "")).join(" · ")}`);
  if (step.does) lines.push(`- ${step.does}`);
  for (const more of step.more ?? []) lines.push(`  - ${more}`);
  for (const said of step.say ?? []) lines.push(`    ${said.from} → ${said.to}: ${said.plainText.replace(/\n/g, " / ")}`);
  for (const [label, value] of step.form ?? []) lines.push(`  [screen] ${label}: ${value}`);
  if (step.table)
    lines.push(`  [screen table] ${step.table.head.join(" | ")} / ${step.table.rows.map((row) => row.join(" | ")).join(" / ")}`);
  if (step.rule) lines.push(`- RULE: ${step.rule}`);
  if (step.slot) lines.push(`- PLUG-IN: ${JSON.stringify(step.slot)}`);
  for (const b of step.branches ?? [])
    lines.push(`  > branch: ${b.label}${b.end === "end" ? ` → ends: ${b.endText}` : " → rejoins"} · first step ${b.steps[0] ?? "undefined"}`);
  return lines;
}

function checkWords(bundle, stepJs) {
  if (!existsSync(stepJs)) {
    report(false, `step.js not found at ${stepJs}`);
    return;
  }
  const graph = bundle.flows[FLOW];
  const homes = graph.record?.homes ?? {};
  for (const id of STEPS) {
    const printed = execFileSync(process.execPath, [stepJs, FLOW, id], { encoding: "utf8" }).replace(/\n+$/, "").split("\n");
    const ours = asStepJs(graph.steps[id], homes);
    const fills = [];
    const differ = [];
    const count = Math.max(printed.length, ours.length);
    for (let k = 0; k < count; k += 1) {
      const want = ours[k];
      const got = printed[k];
      const match = want === undefined || got === undefined ? null : pattern(want).exec(got);
      if (match === null) differ.push(`line ${String(k + 1)}: bundle "${want ?? "(none)"}" vs step.js "${got ?? "(none)"}"`);
      else {
        const slots = want.match(/\{\{[^{}]+\}\}/g) ?? [];
        slots.forEach((slot, n) => fills.push(`${slot} = "${match[n + 1]}"`));
      }
    }
    report(
      differ.length === 0,
      `${id}'s words equal \`node step.js ${FLOW} ${id}\`, ${String(printed.length)} lines${fills.length === 0 ? ", no slot" : `, apart from the slotted sample values ${fills.join(", ")}`}${differ.length === 0 ? "" : `: ${differ.join(" | ")}`}`,
    );
  }
}

// ---- 4 and 5. the branches, S1-11 ---------------------------------------------------------------------------------

function checkBranches(bundle) {
  const steps = bundle.flows[FLOW].steps;
  const s102 = steps["S1-02"];
  const branch = (label) => s102.branches.find((b) => b.label === label);
  const all = branch("All on the list");
  const notListed = branch("One isn't on the list yet");
  const notBooked = branch("Not a service we book");
  // The walk's reading (actions/src/commit/walk/walk.ts after()): a merging branch rejoins at its rejoinAt, else its
  // split's next; an end left out merges (K-01 README).
  const rejoin = (b) => b?.rejoinAt ?? s102.next;
  const s111 = steps["S1-11"];
  report(
    all !== undefined &&
      all.tag === "message" &&
      same(all.steps, []) &&
      (all.end ?? "merge") === "merge" &&
      rejoin(all) === "S1-11" &&
      s111 !== undefined &&
      s111.next === "S1-04" &&
      steps["S1-04"] !== undefined,
    `S1-02 "All on the list" leads to S1-11, then S1-04: no steps of its own, end ${String(all?.end ?? "merge")}, rejoins at ${String(rejoin(all))} (held: ${String(s111 !== undefined)}), whose next is ${String(s111?.next)} (held: ${String(steps["S1-04"] !== undefined)})`,
  );
  report(
    notListed !== undefined &&
      notListed.tag === "message" &&
      same(notListed.steps, ["S1-03"]) &&
      steps["S1-03"] !== undefined &&
      (notListed.end ?? "merge") === "merge",
    `S1-02 "One isn't on the list yet" leads to ${String(notListed?.steps?.join(", "))} (held: ${String(steps["S1-03"] !== undefined)}; end ${String(notListed?.end ?? "merge")}, rejoins at ${String(rejoin(notListed))}; S1-03's next ${String(steps["S1-03"]?.next)})`,
  );
  report(
    notBooked !== undefined &&
      notBooked.tag === "message" &&
      same(notBooked.steps, ["S1-74"]) &&
      steps["S1-74"] !== undefined &&
      notBooked.end === "end" &&
      typeof notBooked.endText === "string" &&
      notBooked.endText !== "",
    `S1-02 "Not a service we book" leads to ${String(notBooked?.steps?.join(", "))} (held: ${String(steps["S1-74"] !== undefined)}) and ends (end: ${String(notBooked?.end)}) with its end text: "${String(notBooked?.endText)}"`,
  );
  report(
    s111 !== undefined &&
      s111.via === "auto" &&
      s111.who === "san" &&
      s111.card === undefined &&
      s111.type === undefined &&
      s111.q === undefined &&
      s111.branches === undefined &&
      (s111.say ?? []).length === 0 &&
      s111.next === "S1-04",
    `S1-11 is automatic (via ${String(s111?.via)}, ${String(s111?.who)}; no card, no split, no message) and its next is ${String(s111?.next)}; it gives ${(s111?.gives ?? []).join(" ")}`,
  );
  const s104 = steps["S1-04"];
  const buttons = (s104?.say ?? []).flatMap((said) => (said.from === "san" ? (said.elements?.buttons ?? []) : []));
  note(
    `S1-04 as the build compiles it: ${s104?.type === "split" ? "a split" : "a plain step (no type split, no branches)"}, ${s104?.card === undefined ? "no card" : "a card"}; Rosie's message carries the buttons ${buttons.join(" | ")}; its next is ${String(s104?.next)}, which bundle v1 ${steps[s104?.next] === undefined ? "does not hold" : "holds"}`,
  );
}

// ---- 6. the opt-out marker ----------------------------------------------------------------------------------------

function checkStop(bundle) {
  const steps = bundle.flows[FLOW].steps;
  const first = steps["S1-02"].say[0];
  const owners = [...steps["S1-01"].say, ...steps["S1-02"].say.slice(1)];
  report(
    first.from === "san" && first.to === "owner" && (first.elements?.stop === true || first.elements?.stop === "first"),
    `S1-02's question (Rosie to the owner, her first reply in the chat S1-01 opened) carries the opt-out marker: stop ${JSON.stringify(first.elements?.stop)} (T-141, Q-30)`,
  );
  report(
    owners.every((said) => said.from === "owner" && said.elements?.stop === undefined),
    "the owner's own texts (S1-01, S1-02's reply) carry no marker",
  );
  const later = ["S1-11", "S1-04", "S1-03", "S1-74"].flatMap((id) => (steps[id].say ?? []).map((said) => ({ id, said })));
  const marked = later.filter(({ said }) => said.elements?.stop !== undefined);
  report(
    marked.length === 0,
    `the four new steps' ${String(later.length)} messages carry no marker: the line renders once in the chat, on S1-02's question${marked.length === 0 ? "" : ` (marked: ${marked.map(({ id }) => id).join(", ")})`}`,
  );
}

// ---- 7. the trade overlays ----------------------------------------------------------------------------------------

function rawTrade(dir, id) {
  return JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8"));
}

/**
 * The 11 pf text blocks a trade's overlay is compiled with: the trade file's own values, written as JSON text (K-01
 * default 3), with the Master Corrections the emitter applies to the trade itself before compiling it (emit.ts
 * emitBundle: C5's fill, then C7's marks, which make a text that says Rosie checks a paper the business's own word).
 */
async function correctedBlocks() {
  const loader = await load("compiler/src/load/trade.ts");
  const c5 = await load("compiler/src/corrections/c5.ts");
  const c7 = await load("compiler/src/corrections/c7.ts");
  return {
    ownWord: c7.OWN_WORD,
    of: (id) => c7.markClaims(c5.correctTrade(loader.loadTrade(id)).trade).trade.pluginText,
  };
}

/** The 11 pf text blocks of an overlay against those the build compiles the trade with (correctedBlocks). */
function pfProblems(overlay, expected) {
  const blocks = overlay?.pluginText ?? {};
  const problems = [];
  if (!same(Object.keys(blocks), PF_KEYS)) problems.push(`its pf keys are ${Object.keys(blocks).join(", ")}`);
  for (const key of PF_KEYS) {
    if (typeof blocks[key] !== "string" || blocks[key] === "") problems.push(`${key} is not a text block`);
    else if (blocks[key] !== expected[key]) problems.push(`${key} is not the trade file's value with C5 and C7 applied`);
  }
  return problems;
}

async function checkTrades(read, tradeDir, kv) {
  const { trades } = read.bundle;
  const corrected = await correctedBlocks();
  const bad = [];
  const strays = [];
  let marked = 0;
  const markedTrades = new Set();
  for (const [id, overlay] of Object.entries(trades)) {
    const problems = pfProblems(overlay, corrected.of(id));
    if (overlay.trade?.id !== id) problems.push(`its trade id is ${String(overlay.trade?.id)}`);
    if (problems.length > 0) bad.push(`${id}: ${problems.join(", ")}`);
    // A block that is not the file's own value as written differs by C7's marks alone: it carries C7's words.
    const raw = rawTrade(tradeDir, id);
    for (const key of PF_KEYS) {
      if (overlay.pluginText?.[key] === JSON.stringify(raw.plugin?.[key])) continue;
      marked += 1;
      markedTrades.add(id);
      if (!String(overlay.pluginText?.[key]).includes(corrected.ownWord)) strays.push(`${id} ${key}`);
    }
  }
  report(
    bad.length === 0,
    `every trade overlay (${String(Object.keys(trades).length)}) holds the 11 pf text blocks whole, each the trade file's own value as JSON text (MC R3; K-01 default 3) as the build compiles it, C5 and C7 applied${bad.length === 0 ? "" : `: ${bad.slice(0, 5).join("; ")}`}`,
  );
  report(
    strays.length === 0,
    `the ${String(marked)} pf blocks of ${String(markedTrades.size)} trades that are not their file's words as written differ by C7's marks: each carries "${corrected.ownWord}"${strays.length === 0 ? "" : `; not: ${strays.slice(0, 5).join(", ")}`}`,
  );

  // C5's fills: insurance's facts are cpa.json's list; a trade with no pf.settings starts at window and an empty cutoff.
  const cpa = rawTrade(tradeDir, "cpa").plugin?.["pf.facts"];
  const insurance = trades.insurance;
  report(
    insurance !== undefined &&
      rawTrade(tradeDir, "insurance").plugin?.["pf.facts"] === undefined &&
      same(insurance.facts, cpa) &&
      same([...(insurance.facts ?? [])].sort(), ["documents", "firststeps", "forms", "video"]),
    `C5: insurance's facts, which its file leaves out, are cpa.json's list: ${JSON.stringify(insurance?.facts)}`,
  );
  const unset = Object.keys(trades).filter((id) => rawTrade(tradeDir, id).plugin?.["pf.settings"] === undefined);
  const wrong = unset.filter(
    (id) => !["A", "B"].every((flow) => same(trades[id].flows[flow].settings, { arrive: "window", cutoff: null })),
  );
  report(
    unset.length === 12 && wrong.length === 0,
    `C5: the ${String(unset.length)} trades with no pf.settings start at arrive window and an empty free-cancel time in both flows (${unset.join(", ")})${wrong.length === 0 ? "" : `; not: ${wrong.join(", ")}`}`,
  );

  // The three kinds the card names, read back from the bundle folder and from the KV bulk file.
  const id = read.bundle.manifest.bundleId;
  const prefix = `bundle/${id.hash}/${String(id.build)}/`;
  const byKey = new Map((Array.isArray(kv) ? kv : []).map((entry) => [entry.key, entry.value]));
  for (const [kind, trade] of READ_BACK) {
    const file = read.files.find((each) => each.path === `trade/${trade}.json`);
    const fromFile = file === undefined ? null : JSON.parse(file.text);
    const value = byKey.get(`${prefix}trade/${trade}`);
    const fromKv = value === undefined ? null : JSON.parse(value);
    const expected = corrected.of(trade);
    const problems = [
      ...pfProblems(fromFile, expected).map((p) => `folder: ${p}`),
      ...(value === file?.text ? [] : ["KV bulk file: not the folder's bytes"]),
      ...pfProblems(fromKv, expected).map((p) => `KV bulk file: ${p}`),
    ];
    report(
      problems.length === 0,
      `${kind} (trade ${trade}) reads back from bundles/v1/bundle/trade/${trade}.json and the KV bulk file's ${prefix}trade/${trade}: all 11 pf keys (${PF_KEYS.map((key) => `${key} ${String(fromFile?.pluginText?.[key]?.length ?? 0)} chars`).join(", ")})${problems.length === 0 ? "" : `: ${problems.join("; ")}`}`,
    );
  }
}

// ---- 8. T-160's lint on the six steps -----------------------------------------------------------------------------

/**
 * The two marks the whole build gives the six steps, its own and not the cut's, which bundle v1 keeps as K-01 v1 says
 * (DL-965; T-1460 round 2): T-160's lint fails notary's S1-02 under record-lint, the master's rule L7 (notary's flow A
 * words op at S1-02 drops "Safe default:"), and the emitter marks S1-04 unknown-slot (its owner sample reply names
 * {{biz.name}}, outside K-01 v1's slot list). Each is a card: the notary overlay's S1-02 words op (J-18), and a K-01
 * slot-list minor version. Any other mark on the six steps fails, and so does either of these two gone.
 */
const BUILD_MARKS = ["notary's S1-02 record-lint L7", "S1-04 unknown-slot"];

async function checkLint(bundle, tradeIds) {
  const lint = await load("compiler/src/lint/report.ts");
  const run = lint.lintFixtureSet(tradeIds);
  const onSteps = (entry) => entry.flow === FLOW && STEPS.includes(entry.step);
  const found = lint.lintReport(run.results).failures.filter(onSteps);
  const master = found.filter((failure) => failure.trade === null);
  const trades = found.filter((failure) => failure.trade !== null);
  // The hits the failures are made of (each an error the record's allow list does not exempt, as lintReport counts
  // them), by their rule's own id: L1 to L8 for record-lint.
  const hits = lint.lintFindings(run).hits.filter((hit) => onSteps(hit) && !hit.allowed && hit.level === "error");
  const steps = bundle.flows[FLOW].steps;
  const marks = STEPS.flatMap((id) => steps[id].lint.map((rule) => ({ id, rule })));
  const named = (list) => list.map((failure) => `${failure.trade ?? "the master"}'s ${failure.step} ${failure.rule}: ${failure.message}`).join(" | ");
  // Every mark on the six steps: each of T-160's failing hits by its trade, step, K-01 rule and own rule, and each
  // rule a step's own lint names (the emitter's marks, with T-160's master failures the cut adds).
  const given = [
    ...new Set(hits.map((hit) => `${hit.trade ?? "the master"}'s ${hit.step} ${hit.rule} ${hit.check}`)),
    ...marks.map((mark) => `${mark.id} ${mark.rule}`),
  ];
  const others = given.filter((mark) => !BUILD_MARKS.includes(mark));
  const missing = BUILD_MARKS.filter((mark) => !given.includes(mark));
  report(
    others.length === 0 && missing.length === 0,
    `T-160's lint finds exactly these two marks, the whole build's own (notary S1-02 record-lint L7; S1-04 unknown-slot), and no other (DL-965): on the six steps, T-160's lint (compiler/src/lint/report.ts, ${String(run.rules.length)} rules, Master Corrections ${run.corrections.join(", ")}) gives ${String(master.length)} failures in the master's flows and ${String(trades.length)} in the ${String((run.results.length - 2) / 2)} trades' flows the bundle holds, and the steps' own marks (the emitter's, K-01 v1's step checks, with T-160's master failures) are ${marks.length === 0 ? "none" : marks.map((mark) => `${mark.id} ${mark.rule}`).join(", ")}; the marks found: ${given.length === 0 ? "none" : given.join(", ")}${others.length === 0 ? "" : `; other marks: ${others.join(", ")}`}${missing.length === 0 ? "" : `; not found: ${missing.join(", ")}`}`,
  );
  if (found.length > 0) note(`T-160's failures on the six steps: ${named(found)}`);
  const slotted = (steps["S1-04"]?.say ?? []).map(
    (said) => `${said.from} → ${said.to}: ${(said.plainText.match(/\{\{[^{}]+\}\}/g) ?? []).join(" ") || "no slot"}`,
  );
  note(`S1-04's messages and the slots each names: ${slotted.join("; ")}`);
  const summary = bundle.manifest.lint;
  const expected = [
    ...marks.map((mark) => [mark.rule, FLOW, mark.id, null]),
    ...trades.map((failure) => [failure.rule, failure.flow, failure.step, failure.trade]),
  ];
  const listed = summary.failures.map((failure) => [failure.rule, failure.flow, failure.step, failure.trade]);
  const counted = summary.rules.every((entry) => entry.failures === summary.failures.filter((failure) => failure.rule === entry.rule).length);
  report(
    same(listed, expected) && counted,
    `the manifest's lint summary counts the six steps' failures, as the marks and the lint give them: ${summary.rules.map((entry) => `${entry.rule} ${String(entry.failures)}`).join(", ")}; failing: ${String(summary.failures.length)}`,
  );
}

// ---- 9. the manifest ----------------------------------------------------------------------------------------------

async function checkManifest(bundle, v0) {
  const manifest = bundle.manifest;
  const given = await promptsFromModules();
  for (const kind of PROMPT_KINDS) {
    const want = given[kind].prompt;
    const got = manifest.prompts[kind];
    report(
      got.version === want.version &&
        got.sha256 === want.sha256 &&
        got.text === want.text &&
        got.sha256 === sha256(got.text) &&
        same(got, v0.manifest.prompts[kind]),
      `prompt ${kind}: ${got.version}, sha256 ${got.sha256}, as ${given[kind].from}, and as bundle v0 …/2 packs it`,
    );
  }
  const file = JSON.parse(readFileSync(PROMPTS_FILE, "utf8"));
  report(
    PROMPT_KINDS.every((kind) => file[kind].version === given[kind].prompt.version && file[kind].text === given[kind].prompt.text),
    "prompts.json is what the prompt modules give today",
  );
  const models = JSON.parse(readFileSync(join(HERE, "models.json"), "utf8"));
  report(
    same(manifest.models, models.models) &&
      same(manifest.policy, models.policy) &&
      same(manifest.models, v0.manifest.models) &&
      same(manifest.policy, v0.manifest.policy),
    `models ${JSON.stringify(manifest.models)}; policy ${JSON.stringify(manifest.policy)}: models.json's, and bundle v0 …/2's`,
  );
  report(
    same(manifest.models, { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5" }) &&
      same(manifest.policy, { low: { first: "haiku", second: "haiku" }, high: { first: "sonnet", second: "haiku" }, reread: "sonnet" }),
    "routing is Q-26's default (high: Sonnet then Haiku; low: Haiku twice; re-read: Sonnet) with the two ids the router accepts (T-363)",
  );

  const { basePath, fixedLines } = await fixedLinesOfStaging();
  const lines = manifest.lists.fixedLines.lines;
  report(
    same(manifest.lists.fixedLines, fixedLines) && same(manifest.lists.fixedLines, v0.manifest.lists.fixedLines),
    `sharedLists.fixedLines are compiler/src/fixed-lines's for ${ENVIRONMENT} (wrangler.jsonc BASE_PATH ${basePath}), and bundle v0 …/2's: ${String(lines.length)} lines, ${lines.map((line) => `${line.id} (${line.lang})`).join(", ")}`,
  );
  const k01 = JSON.parse(readFileSync(K01_FIXED_LINES, "utf8")).lines;
  report(
    same(lines.slice(0, k01.length), k01),
    `K-01 v1's ${String(k01.length)} accepted lines first, each unchanged (contracts/bundle/fixtures/fixed-lines.json)`,
  );
  const keys = lines.map((line) => `${line.id} ${line.lang}`);
  report(new Set(keys).size === keys.length, "each fixed line's id once per language (optOutLine in English and in Spanish)");
  const privacy = lines.filter((line) => line.id === "privacyLink");
  const link = privacy[0];
  report(
    privacy.length === 1 &&
      link.lang === "en" &&
      link.status === "asWritten" &&
      typeof link.text === "string" &&
      link.text.endsWith(`rosfield.com${basePath}/privacy`) &&
      link.source.startsWith("Q-30's default, for Jay to confirm before production"),
    `sharedLists.fixedLines holds privacyLink "${String(link?.text)}", ${String(link?.status)} (never pendingJay), marked "${String(link?.source.split(":")[0])}"`,
  );
  const spanish = lines.find((line) => line.id === "optOutLine" && line.lang === "es");
  report(
    spanish?.status === "asWritten" && typeof spanish.text === "string" && spanish.source.startsWith("msgtext.js line 32 "),
    `optOutLine in Spanish "${String(spanish?.text)}" (${String(spanish?.source.split(";")[0])})`,
  );
  report(
    same(manifest.journeys, []) && same(v0.manifest.journeys, []),
    "journeys: none, as the emitter writes none and bundle v0 …/2 lists none",
  );
  for (const list of ["keywords", "keyMap", "outOfScope"])
    note(`lists.${list}: the build's, ${same(manifest.lists[list], v0.manifest.lists[list]) ? "the same as bundle v0 …/2's" : "not bundle v0 …/2's"}`);
}

// ---- 10. the KV bulk file -----------------------------------------------------------------------------------------

function readKv() {
  return existsSync(KV_FILE) ? JSON.parse(readFileSync(KV_FILE, "utf8")) : null;
}

function checkKv(read, entries) {
  if (entries === null) {
    report(false, `no KV bulk file ${KV_FILE} (run the publish)`);
    return;
  }
  const id = read.bundle.manifest.bundleId;
  const prefix = `bundle/${id.hash}/${String(id.build)}/`;
  const byPath = new Map(read.files.map((file) => [file.path, file.text]));
  const keys = new Set(entries.map((entry) => entry.key));
  const ok =
    Array.isArray(entries) &&
    entries.length === read.files.length &&
    keys.size === entries.length &&
    entries.every((entry) => entry.key.startsWith(prefix) && byPath.get(`${entry.key.slice(prefix.length)}.json`) === entry.value);
  report(ok, `KV bulk file: ${String(entries.length)} entries, one per part, every key under ${prefix}, each value the part's bytes`);
}

// ---- 11. the whole build it was cut from --------------------------------------------------------------------------

function checkFull(emit, read, full) {
  const problems = emit.checkBundleDir(full);
  const whole = emit.readBundleDir(full);
  const { manifest, flows } = whole.bundle;
  report(
    problems.length === 0 && manifest.partial === undefined,
    `the whole build ${manifest.bundleId.hash}/${String(manifest.bundleId.build)} in ${full}: ${problems.length === 0 ? "sound, not partial" : problems.slice(0, 3).join("; ")}; flows ${Object.keys(flows).join(", ")}, ${String(Object.keys(whole.bundle.trades).length)} trades`,
  );
  const ours = read.bundle.flows[FLOW];
  const differ = STEPS.filter((id) => {
    const { lint: _ours, ...a } = ours.steps[id];
    const { lint: _theirs, ...b } = flows[FLOW].steps[id];
    return !same(a, b);
  });
  report(differ.length === 0, `the six steps are the build's byte for byte but their lint${differ.length === 0 ? "" : `: ${differ.join(", ")} differ`}`);
  const order = Object.keys(flows[FLOW].steps).filter((id) => STEPS.includes(id));
  report(same(Object.keys(ours.steps), order), `the six steps in the build's page order: ${order.join(", ")}`);
  const fields = Object.keys(flows[FLOW]).filter((key) => key !== "steps");
  const otherFields = fields.filter((key) => !same(ours[key], flows[FLOW][key]));
  report(
    same(Object.keys(ours), Object.keys(flows[FLOW])) && otherFields.length === 0,
    `flow A's other fields are the build's (${fields.join(", ")})${otherFields.length === 0 ? "" : `: ${otherFields.join(", ")} differ`}`,
  );
  const theirTrades = new Map(whole.files.filter((file) => file.path.startsWith("trade/")).map((file) => [file.path, file.text]));
  const ourTrades = read.files.filter((file) => file.path.startsWith("trade/"));
  const changed = ourTrades.filter((file) => theirTrades.get(file.path) !== file.text).map((file) => file.path);
  report(
    ourTrades.length === theirTrades.size && changed.length === 0,
    `every trade overlay the build holds (${String(theirTrades.size)}) is in the cut byte for byte${changed.length === 0 ? "" : `: ${changed.slice(0, 5).join(", ")} differ`}`,
  );
  const cut = read.bundle.manifest;
  const keysDiffer = Object.keys(manifest).filter((key) => !CUT_FIELDS.includes(key) && !same(cut[key], manifest[key]));
  const listsDiffer = Object.keys(manifest.lists).filter((key) => key !== "fixedLines" && !same(cut.lists[key], manifest.lists[key]));
  report(
    keysDiffer.length === 0 && listsDiffer.length === 0 && same(Object.keys(cut).filter((key) => key !== "partial"), Object.keys(manifest)),
    `the manifest is the build's but ${CUT_FIELDS.join(", ")} (lists.fixedLines alone)${keysDiffer.length + listsDiffer.length === 0 ? "" : `: ${[...keysDiffer, ...listsDiffer.map((key) => `lists.${key}`)].join(", ")} differ`}`,
  );
  const fullPrefix = `bundle/${manifest.bundleId.hash}/${String(manifest.bundleId.build)}/`;
  const prefix = `bundle/${cut.bundleId.hash}/${String(cut.bundleId.build)}/`;
  const rekey = (entries, from) => entries.filter((entry) => entry.kind === "trade").map((entry) => ({ ...entry, key: entry.key.slice(from.length) }));
  report(
    same(rekey(cut.storage.values, prefix), rekey(manifest.storage.values, fullPrefix)),
    "the manifest's storage lists each trade overlay as the build lists it (kind, trade, bytes, sha256), under v1's id",
  );
}

// ---- 12. PostgreSQL -----------------------------------------------------------------------------------------------

async function checkDb(read) {
  const corrected = await correctedBlocks();
  const client = await load("db/repo/client.ts");
  const bundles = await load("db/repo/bundles.ts");
  const db = client.createClient({ max: 2 });
  try {
    const active = await bundles.readActiveBundle(db.primary);
    const id = read.bundle.manifest.bundleId;
    const label =
      "result" in active
        ? `${active.bundleId.hash}/${String(active.bundleId.build)} since ${active.activatedAt}${active.bundleId.hash === id.hash && active.bundleId.build === id.build ? " (bundle v1)" : ""}`
        : active.error === "noActiveBundle"
          ? "none is active (noActiveBundle): publishing never switches it; the release engineer's deploy step 3 sets it on staging"
          : `transient ${active.sqlstate}`;
    report(!("error" in active) || active.error === "noActiveBundle", `readActiveBundle: ${label}`);
    const storage = read.bundle.manifest.storage;
    const keys = [storage.manifestKey, ...storage.values.map((value) => value.key)];
    const prefix = `bundle/${id.hash}/${String(id.build)}/`;
    const byPath = new Map(read.files.map((file) => [file.path, file.text]));
    let good = 0;
    const texts = new Map();
    for (const key of keys) {
      const answer = await bundles.readBundleValue(db.primary, { key });
      const text = byPath.get(`${key.slice(prefix.length)}.json`);
      const okPart =
        "result" in answer &&
        answer.value.text === text &&
        answer.value.sha256 === sha256(text) &&
        answer.value.bytes === Buffer.byteLength(text, "utf8");
      if (okPart) {
        good += 1;
        texts.set(key, answer.value.text);
      } else console.log(`     ${key}: ${"error" in answer ? answer.error : "not the file's bytes"}`);
    }
    const kinds = { manifest: 1, flow: 0, trade: 0 };
    for (const value of storage.values) kinds[value.kind] += 1;
    report(
      good === keys.length,
      `readBundleValue by bundle id: ${String(good)} of ${String(keys.length)} parts byte-identical (the manifest, ${String(kinds.flow)} flow graph, ${String(kinds.trade)} trade overlays)`,
    );
    for (const [kind, trade] of READ_BACK) {
      const text = texts.get(`${prefix}trade/${trade}`);
      const problems = text === undefined ? ["not read back"] : pfProblems(JSON.parse(text), corrected.of(trade));
      report(
        problems.length === 0,
        `${kind} (trade ${trade}) reads back from PostgreSQL's copy with all 11 pf keys${problems.length === 0 ? "" : `: ${problems.join("; ")}`}`,
      );
    }
  } finally {
    await db.close();
  }
}

async function main() {
  const given = args();
  const emit = await load("compiler/src/emit/index.ts");
  const ids = await load("compiler/src/bundle-id/index.ts");
  const loader = await load("compiler/src/load/trade.ts");
  const tradeIds = loader.listTradeIds();
  const read = await checkBundle(emit, ids, tradeIds);
  const v0 = checkV0(emit, read.bundle);
  checkWords(read.bundle, given.stepJs);
  checkBranches(read.bundle);
  checkStop(read.bundle);
  const kv = readKv();
  await checkTrades(read, loader.TRADE_DIR, kv);
  await checkLint(read.bundle, tradeIds);
  await checkManifest(read.bundle, v0);
  checkKv(read, kv);
  if (given.full !== null) checkFull(emit, read, given.full);
  if (given.db) await checkDb(read);
  console.log(failed === 0 ? "all checks passed" : `${String(failed)} checks failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
