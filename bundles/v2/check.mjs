// The checks of bundle v2 (T-1477's "Proves it with", with Lead note 1, DL-1033), run from the repository root:
//
//   node bundles/v2/check.mjs [--full <full build folder>] [--db]
//
//   --full  also hold the cut against the compiler's whole build it was cut from (build.mjs's run 2): each step and
//           every trade overlay byte for byte the build's (a step but its lint), the rest of flow A and the manifest the
//           build's but the fields the cut writes.
//   --db    also read the published bundle back from PostgreSQL (DATABASE_URL, else the local database when CI is
//           unset; db/repo/client.ts): K-05's readActiveBundle, then readBundleValue for every part.
//
// What it checks, each printed as one line, ok or FAIL (exit 1 on any FAIL); a line starting with spaces is a note:
//   1. bundles/v2/bundle/ validates against K-01 v1 and passes `compiler build`'s own checks on what it wrote (the
//      compiler's checkBundleDir: the whole bundle, and each file the value its manifest's storage lists; each file
//      against its own definition), and holds flow/A.json, manifest.json and trade/<id>.json for each trade of fixture
//      set v1: flow A's S1-01, S1-02, S1-11, S1-04, S1-03, S1-74, S1-08 and S1-09 alone, marked partial.
//   2. S1-01 and S1-02 are bundle v0 …/2's byte for byte (card, words, branches, options and their order), and S1-11,
//      S1-04, S1-03 and S1-74 bundle v1's (lint included), so a question asked under v0, v1 or v1.1 keeps its options,
//      its card and its buttons (DL-961; DL-999 (a), (g)).
//   3. The walk from S1-04's answer: S1-04.next is S1-08 and S1-08.next is S1-09; S1-09 is a split with three message
//      branches and a card with a safe default, each of the card's options one of its branches.
//   4. T-160's lint (compiler/src/lint/report.ts) of the master's flows and of every trade's flows the bundle holds, with
//      the emitter's own marks, finds on the six steps exactly bundle v1's two marks (DL-965) and on S1-08 and S1-09
//      exactly NEW_MARKS (below), and no other; the manifest's lint summary counts exactly the failures the steps'
//      marks and the lint give the eight steps.
//   5. For each line Rosie sends in S1-08 and S1-09 (each message from "san", its plain form), the slots it names,
//      printed; and the slots of S1-08's and S1-09's cards and end texts, as notes.
//   6. The manifest: prompts equal bundles/v1.1's byte for byte (decide is decide-2, as ai/src/decide/prompt.ts
//      DECIDE_2_PROMPT gives it today, not v1's decide-1; the others as their modules give them), prompts.json and
//      models.json are bundle v1.1's byte for byte and the manifest's models and routing; the fixed lines are bundle
//      v1.1's plus signUpOpener alone (Lead note 1's words, last), each id once per language; no journey.
//   7. The stakes the frontier computes for S1-02's three options on bundle v2 (actions/src/frontier/assemble/bundle.ts
//      ownStakes, as open-questions.ts reads them; T-1502's architect note (e)), and on bundle v1.1 beside them.
//   8. The bundle id is the content hash of the stored values (T-150) with build 1, and no earlier bundle's id.
//   9. The KV bulk file bundles/v2/bundle.kv.json holds one entry per part, every key under the bundle id, each value
//      the part's bytes.
//  10. With --full: the cut against the whole build (above).
//  11. With --db: readActiveBundle answers, and readBundleValue gives back every part byte for byte.
// bundles/v2/check.test.mjs runs checks 1 to 9 (`node --test bundles/v2/check.test.mjs`).
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { kvProblems } from "../v1.1/check.mjs";
import {
  BUILD,
  BUNDLE_DIR,
  FLOW,
  KV_FILE,
  MODELS_FILE,
  NEW_STEPS,
  PROMPTS_FILE,
  PROMPT_KINDS,
  SIGN_UP_OPENER,
  STEPS,
  V0_DIR,
  V0_STEPS,
  V11_DIR,
  V11_MODELS_FILE,
  V1_DIR,
  V1_HELD,
  V1_STEPS,
  label,
  load,
  promptsFromModules,
  readPromptsFile,
  sha256,
  stepDifferences,
} from "./build.mjs";

export { kvProblems };

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The key prefix of a bundle id (K-01 kvKey): bundle/<hash>/<build>/. */
function prefixOf(id) {
  return `bundle/${id.hash}/${String(id.build)}/`;
}

/** bundles/v1.1's prompts.json, which bundle v2's is byte for byte. */
const V11_PROMPTS_FILE = resolve(V11_DIR, "..", "prompts.json");

/**
 * The two marks the whole build gives bundle v1's six steps, its own and not the cut's (DL-965; bundles/v1/check.mjs
 * BUILD_MARKS): notary's S1-02 record-lint L7 and S1-04 unknown-slot. Bundle v2 holds those six steps byte for byte.
 */
export const V1_MARKS = ["notary's S1-02 record-lint L7", "S1-04 unknown-slot"];

/**
 * The marks S1-08 and S1-09 bring, the whole build's own and not the cut's (the card: "check.mjs states the exact lint
 * marks S1-08 and S1-09 bring"): each of T-160's failing hits by its trade (or the master), step, K-01 rule and own
 * rule, and each rule a step's own lint names (the emitter's marks, with T-160's master failures the cut adds).
 */
export const NEW_MARKS = [];

// ---- the pure checks (each gives its problems, one line each; none: it holds) --------------------------------------

/** Check 3: what is wrong with the walk from S1-04's answer in the steps `steps` (flow A's, by id). */
export function walkProblems(steps) {
  const out = [];
  const s104 = steps["S1-04"];
  const s108 = steps["S1-08"];
  const s109 = steps["S1-09"];
  if (s104?.next !== "S1-08") out.push(`S1-04.next is ${String(s104?.next)}, not S1-08`);
  if (s108 === undefined) out.push("S1-08 is not held");
  else if (s108.next !== "S1-09") out.push(`S1-08.next is ${String(s108.next)}, not S1-09`);
  if (s109 === undefined) return [...out, "S1-09 is not held"];
  const branches = s109.branches ?? [];
  if (s109.type !== "split") out.push(`S1-09 is not a split (type ${String(s109.type)})`);
  if (branches.length !== 3) out.push(`S1-09 has ${String(branches.length)} branches, not three`);
  const notMessage = branches.filter((branch) => branch.tag !== "message").map((branch) => branch.label);
  if (notMessage.length > 0) out.push(`S1-09's branches ${notMessage.join(", ")} are not message branches`);
  const card = s109.card;
  if (card === undefined) out.push("S1-09 has no card");
  else {
    if (typeof card.safeDefault !== "string" || card.safeDefault === "") out.push("S1-09's card has no safe default");
    const labels = branches.map((branch) => branch.label);
    const means = (card.means ?? []).map((entry) => entry.branch);
    if (!same([...means].sort(), [...labels].sort()))
      out.push(`S1-09's card's options (${means.join(" | ")}) are not its branches (${labels.join(" | ")})`);
  }
  return out;
}

/** The slots a text names, in order ({{...}}); none: an empty list. */
export function slotsOf(text) {
  return typeof text === "string" ? (text.match(/\{\{[^{}]+\}\}/g) ?? []) : [];
}

/** Check 5: each line Rosie sends in `step` (a message from "san"), whom to, and the slots its plain form names. */
export function sentLines(step) {
  return (step?.say ?? [])
    .map((said, at) => ({ at, said }))
    .filter(({ said }) => said.from === "san")
    .map(({ at, said }) => ({ at, to: said.to, slots: slotsOf(said.plainText), text: said.plainText }));
}

/** Check 6: where `lines` differ from bundle v1.1's fixed lines `v11Lines` with SIGN_UP_OPENER last. */
export function fixedLineDifferences(lines, v11Lines) {
  const out = [];
  const want = [...v11Lines, SIGN_UP_OPENER];
  if (!Array.isArray(lines)) return ["no fixed lines"];
  for (let k = 0; k < Math.max(lines.length, want.length); k += 1) {
    const got = lines[k];
    const expected = want[k];
    if (same(got, expected)) continue;
    if (got === undefined) out.push(`${String(expected?.id)} (${String(expected?.lang)}) is missing`);
    else if (expected === undefined) out.push(`${String(got.id)} (${String(got.lang)}) is added beyond signUpOpener`);
    else out.push(`line ${String(k + 1)} is ${String(got.id)} (${String(got.lang)}), not ${String(expected.id)} (${String(expected.lang)}) as written`);
  }
  const keys = lines.map((line) => `${String(line?.id)} ${String(line?.lang)}`);
  if (new Set(keys).size !== keys.length) out.push("a fixed line's id is listed twice in one language");
  return out;
}

/** Check 6: the prompt kinds whose manifest entry is not bundle v1.1's (version, sha256 and text, in its field order). */
export function promptDifferences(manifest, v11Manifest) {
  return PROMPT_KINDS.filter((kind) => !same(manifest?.prompts?.[kind], v11Manifest.prompts[kind])).map(
    (kind) => `prompts.${kind} is not bundle v1.1's`,
  );
}

/** Check 4: the marks found that are not expected, and the expected ones not found. */
export function markProblems(given, expected) {
  const others = given.filter((mark) => !expected.includes(mark));
  const missing = expected.filter((mark) => !given.includes(mark));
  return [
    ...(others.length === 0 ? [] : [`other marks: ${others.join(", ")}`]),
    ...(missing.length === 0 ? [] : [`not found: ${missing.join(", ")}`]),
  ];
}

// ---- the run ------------------------------------------------------------------------------------------------------

/**
 * Checks 1 to 9 (10 with `full`, 11 with `db`) on the bundle folder `dir` and its KV bulk file `kvFile`: each line
 * { ok, check, what }, a note with ok null.
 */
export async function runChecks({ dir = BUNDLE_DIR, kvFile = KV_FILE, full = null, db = false } = {}) {
  const lines = [];
  const report = (check, ok, what) => lines.push({ ok, check, what });
  const note = (check, what) => lines.push({ ok: null, check, what });
  const emit = await load("compiler/src/emit/index.ts");
  const ids = await load("compiler/src/bundle-id/index.ts");
  const loader = await load("compiler/src/load/trade.ts");
  const tradeIds = loader.listTradeIds();

  // 1. K-01 v1, the compiler's checks, what it holds.
  const problems = emit.checkBundleDir(dir);
  report(
    1,
    problems.length === 0,
    `K-01 v1 (checkBundleDir, Ajv 2020-12 strict: the whole bundle, and each file the value its manifest's storage lists): ${problems.length === 0 ? "valid" : problems.slice(0, 5).join("; ")}`,
  );
  const read = emit.readBundleDir(dir);
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
    1,
    own.length === 0,
    `each file against its own definition (manifest, flowGraph, ${String(Object.keys(trades).length)} tradeOverlay): ${own.length === 0 ? "valid" : own.slice(0, 5).join("; ")}`,
  );
  const paths = read.files.map((file) => file.path);
  const want = ["flow/A.json", "manifest.json", ...tradeIds.map((id) => `trade/${id}.json`)].sort();
  report(
    1,
    same(paths, want),
    `files: flow/A.json, manifest.json and trade/<id>.json for each of fixture set v1's ${String(tradeIds.length)} trades (${String(paths.length)} files)`,
  );
  const steps = flows[FLOW]?.steps ?? {};
  const held = Object.keys(steps);
  report(
    1,
    manifest.partial === true &&
      same(Object.keys(flows), [FLOW]) &&
      same(Object.keys(trades).sort(), tradeIds) &&
      same([...held].sort(), [...STEPS].sort()),
    `partial: ${String(manifest.partial)}; flows: ${Object.keys(flows).join(", ")}; steps of flow ${FLOW}: ${held.join(", ")} (the build's page order); trades: ${String(Object.keys(trades).length)}`,
  );

  // 2. Bundle v0 …/2's S1-01 and S1-02; bundle v1's S1-11, S1-04, S1-03 and S1-74.
  const v0Problems = emit.checkBundleDir(V0_DIR);
  const v0 = emit.readBundleDir(V0_DIR).bundle;
  const v1Problems = emit.checkBundleDir(V1_DIR);
  const v1Read = emit.readBundleDir(V1_DIR);
  const v1 = v1Read.bundle;
  report(
    2,
    v0Problems.length === 0 && v0.manifest.bundleId.build === 2 && v1Problems.length === 0,
    `bundle v0 ${label(v0.manifest.bundleId)} read back from bundles/v0/bundle and bundle v1 ${label(v1.manifest.bundleId)} from bundles/v1/bundle${v0Problems.length + v1Problems.length === 0 ? ", both sound" : `: ${[...v0Problems, ...v1Problems].slice(0, 3).join("; ")}`}`,
  );
  const heldAs = [
    ...V0_STEPS.map((id) => ({ id, theirs: v0.flows[FLOW]?.steps?.[id], name: `bundle v0 ${label(v0.manifest.bundleId)}` })),
    ...V1_STEPS.map((id) => ({ id, theirs: v1.flows[FLOW]?.steps?.[id], name: `bundle v1 ${label(v1.manifest.bundleId)}` })),
  ];
  for (const { id, theirs, name } of heldAs) {
    const ours = steps[id];
    const differ = stepDifferences(ours, theirs);
    const text = JSON.stringify(ours) ?? "";
    const options = ours?.card?.means?.map((means) => means.branch) ?? [];
    const labels = (ours?.branches ?? []).map((branch) => branch.label);
    const buttons = (ours?.say ?? []).flatMap((said) => (said.from === "san" ? (said.elements?.buttons ?? []) : []));
    report(
      2,
      differ.length === 0,
      `${id} is ${name}'s byte for byte (${String(Buffer.byteLength(text, "utf8"))} bytes, sha256 ${sha256(text)})${options.length > 0 ? `; its card's options in order: ${options.join(" | ")}` : ""}${labels.length > 0 ? `; its branches in order: ${labels.join(" | ")}` : ""}${buttons.length > 0 ? `; Rosie's buttons: ${buttons.join(" | ")}` : ""}${differ.length === 0 ? "" : `: ${differ.join("; ")}`}`,
    );
  }
  const v1Order = Object.keys(v1.flows[FLOW].steps);
  report(
    2,
    same(
      held.filter((id) => V1_HELD.includes(id)),
      v1Order,
    ),
    `the six steps sit in bundle v1's order (${v1Order.join(", ")}), with ${NEW_STEPS.join(" and ")} where the build's page order puts them`,
  );
  const otherFields = Object.keys(flows[FLOW] ?? {}).filter(
    (key) => key !== "steps" && !same(flows[FLOW][key], v1.flows[FLOW][key]),
  );
  note(
    2,
    `flow A's other fields (sections, routing, record, …): ${otherFields.length === 0 ? "bundle v1's byte for byte" : `${otherFields.join(", ")} differ from bundle v1's (the whole build's today)`}`,
  );
  const v1Trades = new Map(v1Read.files.filter((file) => file.path.startsWith("trade/")).map((file) => [file.path, file.text]));
  const ourTrades = read.files.filter((file) => file.path.startsWith("trade/"));
  const sameTrades = ourTrades.filter((file) => v1Trades.get(file.path) === file.text).length;
  note(2, `${String(sameTrades)} of ${String(ourTrades.length)} trade overlays are bundle v1's byte for byte`);

  // 3. The walk from S1-04's answer.
  const walk = walkProblems(steps);
  const s108 = steps["S1-08"];
  const s109 = steps["S1-09"];
  report(
    3,
    !walk.some((line) => line.startsWith("S1-04") || line.startsWith("S1-08")),
    `S1-04.next is ${String(steps["S1-04"]?.next)} and S1-08.next is ${String(s108?.next)}; S1-08 is ${s108?.type === "split" ? "a split" : "a plain step"} (${String(s108?.via)}, ${String(s108?.who)} to ${String(s108?.to)}), ${s108?.card === undefined ? "no card" : "a card"}, gives ${(s108?.gives ?? []).join(" ") || "nothing"}`,
  );
  const branchLines = (s109?.branches ?? []).map(
    (branch) =>
      `"${branch.label}" (${branch.tag}; steps ${(branch.steps ?? []).join(", ") || "none"}${branch.end === "end" ? "; ends" : `; rejoins at ${String(branch.rejoinAt ?? s109?.next)}`})`,
  );
  report(
    3,
    !walk.some((line) => line.startsWith("S1-09")),
    `S1-09 is ${s109?.type === "split" ? "a split" : "not a split"} with ${String(s109?.branches?.length ?? 0)} branches, ${branchLines.join(", ")}; its card's options in order: ${(s109?.card?.means ?? []).map((entry) => entry.branch).join(" | ")}; its safe default: "${String(s109?.card?.safeDefault)}"${walk.length === 0 ? "" : `: ${walk.join("; ")}`}`,
  );
  const notHeld = (s109?.branches ?? []).flatMap((branch) => [...(branch.steps ?? []), branch.rejoinAt ?? s109?.next]).filter((id) => typeof id === "string" && steps[id] === undefined);
  note(
    3,
    `S1-09's branches walk to ${[...new Set(notHeld)].join(", ") || "nothing"}, which bundle v2 does not hold (not reachable in a partial bundle), so S1-09 is asked but not answerable (card 8)`,
  );

  // 4. T-160's lint on the eight steps.
  await checkLint(report, note, read.bundle, tradeIds);

  // 5. The slots of each line Rosie sends in S1-08 and S1-09.
  for (const id of NEW_STEPS) {
    const sent = sentLines(steps[id]);
    report(
      5,
      steps[id] !== undefined && sent.length > 0,
      `${id}: ${String(sent.length)} line${sent.length === 1 ? "" : "s"} Rosie sends: ${sent.map((line) => `say[${String(line.at)}] to ${String(line.to)} names ${line.slots.length === 0 ? "no slot" : line.slots.join(" ")}`).join("; ") || "none"}`,
    );
    for (const line of sent) note(5, `${id} say[${String(line.at)}] to ${String(line.to)}: "${String(line.text)}"`);
    const card = steps[id]?.card;
    if (card !== undefined) {
      const cardText = JSON.stringify(card);
      note(5, `${id}'s question card (decide reads it; Rosie does not send it) names ${slotsOf(cardText).join(" ") || "no slot"}`);
    }
    const ends = (steps[id]?.branches ?? []).filter((branch) => typeof branch.endText === "string");
    for (const branch of ends)
      note(5, `${id} "${branch.label}" end text names ${slotsOf(branch.endText).join(" ") || "no slot"}: "${branch.endText}"`);
    if (typeof steps[id]?.fallbackText === "string")
      note(5, `${id}'s fallback text names ${slotsOf(steps[id].fallbackText).join(" ") || "no slot"}`);
    const marked = (steps[id]?.say ?? []).filter((said) => said.elements?.stop !== undefined);
    note(5, `${id}'s messages carry the opt-out marker: ${marked.length === 0 ? "none (the line renders once in a chat, on S1-02's question)" : marked.map((said) => JSON.stringify(said.elements.stop)).join(", ")}`);
  }

  // 6. The manifest: prompts, prompts.json, models.json, fixed lines, journeys.
  const v11Problems = emit.checkBundleDir(V11_DIR);
  const v11 = emit.readBundleDir(V11_DIR).bundle;
  report(
    6,
    v11Problems.length === 0,
    `bundle v1.1 ${label(v11.manifest.bundleId)} read back from bundles/v1.1/bundle${v11Problems.length === 0 ? ", sound" : `: ${v11Problems.slice(0, 3).join("; ")}`}`,
  );
  const promptDiffer = promptDifferences(manifest, v11.manifest);
  report(
    6,
    promptDiffer.length === 0,
    `prompts equal bundles/v1.1's byte for byte: ${PROMPT_KINDS.map((kind) => `${kind} ${String(manifest.prompts?.[kind]?.version)} (sha256 ${String(manifest.prompts?.[kind]?.sha256).slice(0, 8)}…)`).join(", ")}${promptDiffer.length === 0 ? "" : `: ${promptDiffer.join("; ")}`}`,
  );
  const given = await promptsFromModules();
  const decide = await load("ai/src/decide/prompt.ts");
  const modules = PROMPT_KINDS.filter((kind) => {
    const ours = manifest.prompts?.[kind];
    const mod = given[kind].prompt;
    return ours?.version !== mod.version || ours?.sha256 !== mod.sha256 || ours?.text !== mod.text || ours?.sha256 !== sha256(ours?.text ?? "");
  });
  const decideOk =
    manifest.prompts?.decide?.version === "decide-2" &&
    manifest.prompts.decide.sha256 === decide.DECIDE_2_PROMPT.sha256 &&
    manifest.prompts.decide.sha256 !== decide.DECIDE_PROMPT.sha256;
  report(
    6,
    modules.length === 0 && decideOk,
    `each prompt as its module gives it today, its sha256 its text's: decide is ai/src/decide/prompt.ts DECIDE_2_PROMPT (${String(manifest.prompts?.decide?.version)}, sha256 ${String(manifest.prompts?.decide?.sha256)}), not v1's decide-1 (sha256 ${decide.DECIDE_PROMPT.sha256})${modules.length === 0 ? "" : `; not as today: ${modules.join(", ")}`}`,
  );
  const file = readPromptsFile();
  report(
    6,
    readFileSync(PROMPTS_FILE).equals(readFileSync(V11_PROMPTS_FILE)) &&
      PROMPT_KINDS.every((kind) => file[kind]?.version === manifest.prompts?.[kind]?.version && file[kind]?.text === manifest.prompts?.[kind]?.text),
    `prompts.json is bundles/v1.1/prompts.json byte for byte and what the manifest packs (${PROMPT_KINDS.map((kind) => `${kind} ${String(file[kind]?.version)}`).join(", ")})`,
  );
  const models = JSON.parse(readFileSync(MODELS_FILE, "utf8"));
  report(
    6,
    readFileSync(MODELS_FILE).equals(readFileSync(V11_MODELS_FILE)) &&
      same(manifest.models, models.models) &&
      same(manifest.policy, models.policy) &&
      same(manifest.models, v11.manifest.models) &&
      same(manifest.policy, v11.manifest.policy),
    `models.json is bundles/v1.1/models.json byte for byte, and the manifest's models ${JSON.stringify(manifest.models)} and policy ${JSON.stringify(manifest.policy)} are bundle v1.1's`,
  );
  const fixed = manifest.lists?.fixedLines?.lines;
  const v11Lines = v11.manifest.lists.fixedLines.lines;
  const fixedDiffer = fixedLineDifferences(fixed, v11Lines);
  report(
    6,
    fixedDiffer.length === 0 && same(Object.keys(manifest.lists.fixedLines), ["lines"]),
    `the fixed lines are bundle v1.1's ${String(v11Lines.length)} byte for byte (${v11Lines.map((line) => `${line.id} (${line.lang})`).join(", ")}) plus ${SIGN_UP_OPENER.id} alone, last: "${String(fixed?.at(-1)?.text)}" (${String(fixed?.at(-1)?.status)}; ${String(fixed?.at(-1)?.source).split(";")[0]})${fixedDiffer.length === 0 ? "" : `: ${fixedDiffer.join("; ")}`}`,
  );
  report(6, same(manifest.journeys, []), "journeys: none, as bundles v0, v1 and v1.1 list none");
  for (const list of ["keywords", "keyMap", "outOfScope"])
    note(6, `lists.${list}: the build's, ${same(manifest.lists[list], v11.manifest.lists[list]) ? "the same as bundle v1.1's" : "not bundle v1.1's"}`);

  // 7. S1-02's option stakes, on bundle v2 and on bundle v1.1.
  await checkStakes(report, note, read.bundle, v11);

  // 8. The bundle id.
  const id = manifest.bundleId;
  const idProblems = ids.bundleIdProblems(manifest);
  const hash = ids.contentHashOfFiles(read.files);
  const earlier = [v0.manifest.bundleId, v1.manifest.bundleId, v11.manifest.bundleId];
  const idOk = idProblems.length === 0 && hash === id.hash && id.build === BUILD && earlier.every((each) => each.hash !== id.hash);
  report(
    8,
    idOk,
    `bundle id ${label(id)}: the content hash of its ${String(read.files.length - 1)} stored values (T-150), build ${String(BUILD)}, a hash no earlier bundle has (${earlier.map(label).join(", ")})${idOk ? "" : `: ${[...idProblems, `files hash to ${hash}`].join("; ")}`}`,
  );

  // 9. The KV bulk file.
  const entries = existsSync(kvFile) ? JSON.parse(readFileSync(kvFile, "utf8")) : null;
  const kvDiffer = kvProblems(entries, read.files, id);
  report(
    9,
    kvDiffer.length === 0,
    `KV bulk file ${kvFile === KV_FILE ? "bundles/v2/bundle.kv.json" : kvFile}: ${String(Array.isArray(entries) ? entries.length : 0)} entries, one per part, every key under ${prefixOf(id)}, each value the part's bytes${kvDiffer.length === 0 ? "" : `: ${kvDiffer.slice(0, 5).join("; ")}`}`,
  );

  // 10 and 11.
  if (full !== null) checkFull(report, emit, read, full);
  if (db) await checkDb(report, read);
  return lines;
}

// ---- 4. T-160's lint ----------------------------------------------------------------------------------------------

async function checkLint(report, note, bundle, tradeIds) {
  const lint = await load("compiler/src/lint/report.ts");
  const run = lint.lintFixtureSet(tradeIds);
  const onSteps = (entry) => entry.flow === FLOW && STEPS.includes(entry.step);
  const found = lint.lintReport(run.results).failures.filter(onSteps);
  const master = found.filter((failure) => failure.trade === null);
  const traded = found.filter((failure) => failure.trade !== null);
  // The hits the failures are made of (each an error the record's allow list does not exempt, as lintReport counts
  // them), by their rule's own id: L1 to L8 for record-lint.
  const hits = lint.lintFindings(run).hits.filter((hit) => onSteps(hit) && !hit.allowed && hit.level === "error");
  const steps = bundle.flows[FLOW].steps;
  const marks = STEPS.flatMap((id) => (steps[id]?.lint ?? []).map((rule) => ({ id, rule })));
  const given = [
    ...new Set(hits.map((hit) => `${hit.trade ?? "the master"}'s ${hit.step} ${hit.rule} ${hit.check}`)),
    ...marks.map((mark) => `${mark.id} ${mark.rule}`),
  ];
  const isNew = (mark) => NEW_STEPS.some((id) => mark.startsWith(`${id} `) || mark.includes(`'s ${id} `));
  const sixGiven = given.filter((mark) => !isNew(mark));
  const newGiven = given.filter(isNew);
  const six = markProblems(sixGiven, V1_MARKS);
  const two = markProblems(newGiven, NEW_MARKS);
  report(
    4,
    six.length === 0,
    `on the six steps, T-160's lint finds exactly bundle v1's two marks, the whole build's own (${V1_MARKS.join("; ")}), and no other (DL-965)${six.length === 0 ? "" : `: ${six.join("; ")}`}`,
  );
  report(
    4,
    two.length === 0,
    `the marks S1-08 and S1-09 bring, exactly: ${NEW_MARKS.length === 0 ? "none" : NEW_MARKS.join("; ")} (T-160's lint, compiler/src/lint/report.ts, ${String(run.rules.length)} rules, Master Corrections ${run.corrections.join(", ")}: ${String(master.length)} failures in the master's flows and ${String(traded.length)} in the ${String((run.results.length - 2) / 2)} trades' flows on the eight steps; the steps' own marks ${marks.length === 0 ? "none" : marks.map((mark) => `${mark.id} ${mark.rule}`).join(", ")}); found on S1-08 and S1-09: ${newGiven.length === 0 ? "none" : newGiven.join(", ")}${two.length === 0 ? "" : `: ${two.join("; ")}`}`,
  );
  const named = (list) =>
    list.map((failure) => `${failure.trade ?? "the master"}'s ${failure.step} ${failure.rule}: ${failure.message}`).join(" | ");
  if (found.length > 0) note(4, `T-160's failures on the eight steps: ${named(found)}`);
  const summary = bundle.manifest.lint;
  const expected = [
    ...marks.map((mark) => [mark.rule, FLOW, mark.id, null]),
    ...traded.map((failure) => [failure.rule, failure.flow, failure.step, failure.trade]),
  ];
  const listed = summary.failures.map((failure) => [failure.rule, failure.flow, failure.step, failure.trade]);
  const counted = summary.rules.every(
    (entry) => entry.failures === summary.failures.filter((failure) => failure.rule === entry.rule).length,
  );
  report(
    4,
    same(listed, expected) && counted,
    `the manifest's lint summary counts the eight steps' failures, as the marks and the lint give them: ${summary.rules.filter((entry) => entry.failures > 0).map((entry) => `${entry.rule} ${String(entry.failures)}`).join(", ") || "none"} (${String(summary.rules.length)} rules listed); failing: ${String(summary.failures.length)}`,
  );
}

// ---- 7. S1-02's option stakes -------------------------------------------------------------------------------------

/** The stakes the frontier computes for each option of S1-02's card on `bundle` (open-questions.ts askedOf). */
export async function s102Stakes(bundle) {
  const frontier = await load("actions/src/frontier/assemble/bundle.ts");
  const view = frontier.flowViewOf(bundle.flows[FLOW], FLOW);
  if (view === null) return null;
  const read = { bundleId: bundle.manifest.bundleId, partial: bundle.manifest.partial === true, flows: { [FLOW]: view } };
  const found = frontier.findStep(read, "S1-02", FLOW);
  if (found === null || found.step.card === null) return null;
  return found.step.card.means.map((means) => {
    const branch = found.step.branches.find((each) => each.label === means.branch);
    if (branch === undefined || branch.tag !== "message") return { option: means.branch, stakes: null, stakesFrom: [] };
    const reasons = frontier.ownStakes(read, found.flow, found.step, branch);
    return { option: means.branch, stakes: reasons.length > 0 ? "high" : "low", stakesFrom: reasons };
  });
}

/** One option's stakes in words. */
function stakesText(entry) {
  if (entry.stakes === null) return `"${entry.option}": not offered (no message branch)`;
  const from = entry.stakesFrom.map((reason) => `${reason.why}${reason.step === null ? "" : ` at ${reason.step}`}${reason.ref === null ? "" : ` (${reason.ref})`}`);
  return `"${entry.option}": ${entry.stakes}${from.length === 0 ? "" : ` (${from.join(", ")})`}`;
}

async function checkStakes(report, note, bundle, v11) {
  const ours = await s102Stakes(bundle);
  const theirs = await s102Stakes(v11);
  report(
    7,
    ours !== null && ours.length === 3 && ours.every((entry) => entry.stakes !== null),
    `the stakes the frontier computes for S1-02's three options on bundle v2 (actions/src/frontier/assemble/bundle.ts ownStakes, as open-questions.ts:110-124 reads them): ${ours === null ? "S1-02 or its card not read" : ours.map(stakesText).join("; ")}`,
  );
  note(7, `on bundle v1.1: ${theirs === null ? "S1-02 or its card not read" : theirs.map(stakesText).join("; ")}`);
  const high = (ours ?? []).filter((entry) => entry.stakes === "high");
  note(
    7,
    high.length === 0
      ? "no option's own walk is high, so the assembler's sibling rule (assemble.ts:102-111: an option of a question with a high option is high) raises none; the three options carry the same stakes, so T-1502's open gap 170 answer holds on v2"
      : `the assembler's sibling rule (assemble.ts:102-111) makes every option of S1-02 high, from ${high.map((entry) => `"${entry.option}"`).join(", ")}; re-check T-1502's open gap 170 answer (architect note (e))`,
  );
}

// ---- 10. the whole build it was cut from --------------------------------------------------------------------------

/** The manifest fields the cut writes itself (build.mjs); every other is the whole build's. */
const CUT_FIELDS = ["bundleId", "lint", "journeys", "storage", "partial", "lists"];

function checkFull(report, emit, read, fullArg) {
  const full = isAbsolute(fullArg) ? fullArg : resolve(process.cwd(), fullArg);
  const problems = emit.checkBundleDir(full);
  const whole = emit.readBundleDir(full);
  const { manifest, flows } = whole.bundle;
  report(
    10,
    problems.length === 0 && manifest.partial === undefined,
    `the whole build ${label(manifest.bundleId)} in ${full}: ${problems.length === 0 ? "sound, not partial" : problems.slice(0, 3).join("; ")}; flows ${Object.keys(flows).join(", ")}, ${String(Object.keys(whole.bundle.trades).length)} trades`,
  );
  const ours = read.bundle.flows[FLOW];
  const differ = STEPS.filter((id) => {
    const { lint: _ours, ...a } = ours.steps[id] ?? {};
    const { lint: _theirs, ...b } = flows[FLOW].steps[id] ?? {};
    return !same(a, b);
  });
  report(10, differ.length === 0, `the eight steps are the build's byte for byte but their lint${differ.length === 0 ? "" : `: ${differ.join(", ")} differ`}`);
  const order = Object.keys(flows[FLOW].steps).filter((id) => STEPS.includes(id));
  report(10, same(Object.keys(ours.steps), order), `the eight steps in the build's page order: ${order.join(", ")}`);
  const fields = Object.keys(flows[FLOW]).filter((key) => key !== "steps");
  const otherFields = fields.filter((key) => !same(ours[key], flows[FLOW][key]));
  report(
    10,
    same(Object.keys(ours), Object.keys(flows[FLOW])) && otherFields.length === 0,
    `flow A's other fields are the build's (${fields.join(", ")})${otherFields.length === 0 ? "" : `: ${otherFields.join(", ")} differ`}`,
  );
  const theirTrades = new Map(whole.files.filter((file) => file.path.startsWith("trade/")).map((file) => [file.path, file.text]));
  const ourTrades = read.files.filter((file) => file.path.startsWith("trade/"));
  const changed = ourTrades.filter((file) => theirTrades.get(file.path) !== file.text).map((file) => file.path);
  report(
    10,
    ourTrades.length === theirTrades.size && changed.length === 0,
    `every trade overlay the build holds (${String(theirTrades.size)}) is in the cut byte for byte${changed.length === 0 ? "" : `: ${changed.slice(0, 5).join(", ")} differ`}`,
  );
  const cut = read.bundle.manifest;
  const keysDiffer = Object.keys(manifest).filter((key) => !CUT_FIELDS.includes(key) && !same(cut[key], manifest[key]));
  const listsDiffer = Object.keys(manifest.lists).filter((key) => key !== "fixedLines" && !same(cut.lists[key], manifest.lists[key]));
  report(
    10,
    keysDiffer.length === 0 &&
      listsDiffer.length === 0 &&
      same(
        Object.keys(cut).filter((key) => key !== "partial"),
        Object.keys(manifest),
      ),
    `the manifest is the build's but ${CUT_FIELDS.join(", ")} (lists.fixedLines alone)${keysDiffer.length + listsDiffer.length === 0 ? "" : `: ${[...keysDiffer, ...listsDiffer.map((key) => `lists.${key}`)].join(", ")} differ`}`,
  );
  const fullPrefix = prefixOf(manifest.bundleId);
  const prefix = prefixOf(cut.bundleId);
  const rekey = (entries, from) =>
    entries.filter((entry) => entry.kind === "trade").map((entry) => ({ ...entry, key: entry.key.slice(from.length) }));
  report(
    10,
    same(rekey(cut.storage.values, prefix), rekey(manifest.storage.values, fullPrefix)),
    "the manifest's storage lists each trade overlay as the build lists it (kind, trade, bytes, sha256), under v2's id",
  );
}

// ---- 11. PostgreSQL -----------------------------------------------------------------------------------------------

async function checkDb(report, read) {
  const client = await load("db/repo/client.ts");
  const bundles = await load("db/repo/bundles.ts");
  const db = client.createClient({ max: 2 });
  try {
    const active = await bundles.readActiveBundle(db.primary);
    const id = read.bundle.manifest.bundleId;
    const name =
      "result" in active
        ? `${label(active.bundleId)} since ${active.activatedAt}${label(active.bundleId) === label(id) ? " (bundle v2)" : ""}`
        : active.error === "noActiveBundle"
          ? "none is active (noActiveBundle): publishing never switches it; the deploy's step 3 sets it on staging"
          : `transient ${active.sqlstate}`;
    report(11, !("error" in active) || active.error === "noActiveBundle", `readActiveBundle: ${name}`);
    const storage = read.bundle.manifest.storage;
    const keys = [storage.manifestKey, ...storage.values.map((value) => value.key)];
    const prefix = prefixOf(id);
    const byPath = new Map(read.files.map((file) => [file.path, file.text]));
    let good = 0;
    const bad = [];
    for (const key of keys) {
      const answer = await bundles.readBundleValue(db.primary, { key });
      const text = byPath.get(`${key.slice(prefix.length)}.json`);
      const okPart =
        "result" in answer &&
        answer.value.text === text &&
        answer.value.sha256 === sha256(text) &&
        answer.value.bytes === Buffer.byteLength(text, "utf8");
      if (okPart) good += 1;
      else bad.push(`${key}: ${"error" in answer ? answer.error : "not the file's bytes"}`);
    }
    const kinds = { flow: 0, trade: 0 };
    for (const value of storage.values) kinds[value.kind] += 1;
    report(
      11,
      good === keys.length,
      `readBundleValue by bundle id ${label(id)}: ${String(good)} of ${String(keys.length)} parts byte-identical (the manifest, ${String(kinds.flow)} flow graph, ${String(kinds.trade)} trade overlays)${bad.length === 0 ? "" : `: ${bad.slice(0, 5).join("; ")}`}`,
    );
  } finally {
    await db.close();
  }
}

// ---- the command line -------------------------------------------------------------------------------------------

function args() {
  const usage = "usage: node bundles/v2/check.mjs [--full <full build folder>] [--db]";
  const given = process.argv.slice(2);
  const out = { full: null, db: false };
  for (let k = 0; k < given.length; k += 1) {
    if (given[k] === "--db" && !out.db) out.db = true;
    else if (given[k] === "--full" && out.full === null && given[k + 1] !== undefined) {
      out.full = given[k + 1];
      k += 1;
    } else throw new Error(`${usage} (not "${given[k]}")`);
  }
  return out;
}

async function main() {
  const given = args();
  const lines = await runChecks({ full: given.full, db: given.db });
  for (const line of lines)
    console.log(line.ok === null ? `     ${line.what}` : `${line.ok ? "ok  " : "FAIL"} ${line.what}`);
  const failed = lines.filter((line) => line.ok === false).length;
  console.log(failed === 0 ? "all checks passed" : `${String(failed)} checks failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
