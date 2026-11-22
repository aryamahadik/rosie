// The checks of bundle v3 (T-1526's "Proves it with"; S1-09 design card 4, DL-1128), run from the repository root:
//
//   node bundles/v3/check.mjs [--full <full build folder>] [--db]
//
//   --full  also hold the cut against the compiler's whole build it was cut from (build.mjs's run 2): each step and
//           every trade overlay byte for byte the build's (a step but its lint), the rest of flow A and the manifest the
//           build's but the fields the cut writes.
//   --db    also read the published bundle back from PostgreSQL (DATABASE_URL, else the local database when CI is
//           unset; db/repo/client.ts): K-05's readActiveBundle, then readBundleValue for every part.
//
// What it checks, each printed as one line, ok or FAIL (exit 1 on any FAIL); a line starting with spaces is a note:
//   1. bundles/v3/bundle/ validates against K-01 v1 and passes `compiler build`'s own checks on what it wrote (the
//      compiler's checkBundleDir: the whole bundle, and each file the value its manifest's storage lists; each file
//      against its own definition), and holds flow/A.json, manifest.json and trade/<id>.json for each trade of fixture
//      set v1: flow A's eleven steps alone (bundle v2's eight, S1-77, S1-76 and S1-10), marked partial.
//   2. Bundle v2's eight steps are bundle v2's byte for byte, lint included (card, words, branches, options and their
//      order), so a question asked under v0, v1, v1.1 or v2 keeps its options, its card and its buttons; they sit in
//      bundle v2's order; every trade overlay is bundle v2's byte for byte.
//   3. S1-09: the options the frontier offers for its card (actions/src/frontier open-questions.ts cardChoices: one per
//      message branch its Means lines define), each with its fields and its stakes (bundle.ts ownStakes), on bundle v3
//      and, as a note, on bundle v2; S1-09.next, where each branch goes, and what the commit's walk
//      (actions/src/commit/walk walk.ts) does on bundle v3 from each branch chosen.
//   4. S1-10's compiled shape as the walk reads it (walked: a plain message step with no buttons; asked: a split with a
//      message branch, or a plain step whose message carries buttons; waiting: a split a clock settles), whether it waits
//      on an event (S1-32's result or the upload's), S1-10.next and the walk from S1-10; then S1-77's and S1-76's shapes
//      and their next.
//   5. T-160's lint (compiler/src/lint/report.ts) of the master's flows and of every trade's flows the bundle holds, with
//      the emitter's own marks, finds on bundle v2's eight steps exactly bundle v2's two marks and on S1-77, S1-76 and
//      S1-10 exactly NEW_MARKS (below), and no other; the manifest's lint summary counts exactly the failures the steps'
//      marks and the lint give the eleven steps.
//   6. For each line Rosie sends in S1-77, S1-76 and S1-10 (each message from "san", its plain form), the slots it names,
//      printed; and the slots of their cards, end texts and fallback texts, as notes.
//   7. The manifest: prompts equal bundles/v2's byte for byte (decide is decide-2, as ai/src/decide/prompt.ts
//      DECIDE_2_PROMPT gives it today, not v1's decide-1); prompts.json and models.json are bundle v2's byte for byte and
//      the manifest's models and routing; the fixed lines are bundle v2's byte for byte (bundle v1.1's plus
//      signUpOpener); no journey.
//   8. The bundle id is the content hash of the stored values (T-150) with build 1, and no earlier bundle's id.
//   9. The KV bulk file bundles/v3/bundle.kv.json holds one entry per part, every key under the bundle id, each value
//      the part's bytes.
//  10. With --full: the cut against the whole build (above).
//  11. With --db: readActiveBundle answers, and readBundleValue gives back every part byte for byte.
// No model is called. bundles/v3/check.test.mjs runs checks 1 to 9 (`node --test bundles/v3/check.test.mjs`).
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { kvProblems, sentLines, slotsOf } from "../v2/check.mjs";
import {
  BUILD,
  BUNDLE_DIR,
  FLOW,
  KV_FILE,
  MODELS_FILE,
  NEW_STEPS,
  PROMPTS_FILE,
  PROMPT_KINDS,
  STEPS,
  V0_DIR,
  V11_DIR,
  V1_DIR,
  V2_DIR,
  V2_MODELS_FILE,
  V2_PROMPTS_FILE,
  V2_STEPS,
  label,
  load,
  promptsFromModules,
  readPromptsFile,
  sha256,
  stepDifferences,
} from "./build.mjs";

export { kvProblems, sentLines, slotsOf };

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The key prefix of a bundle id (K-01 kvKey): bundle/<hash>/<build>/. */
function prefixOf(id) {
  return `bundle/${id.hash}/${String(id.build)}/`;
}

/**
 * The two marks the whole build gives bundle v2's eight steps, its own and not the cut's (DL-965; bundles/v2/check.mjs
 * V1_MARKS: S1-08 and S1-09 brought none): notary's S1-02 record-lint L7 and S1-04 unknown-slot. Bundle v3 holds those
 * eight steps byte for byte.
 */
export const V2_MARKS = ["notary's S1-02 record-lint L7", "S1-04 unknown-slot"];

/**
 * The marks S1-77, S1-76 and S1-10 bring, the whole build's own and not the cut's (the card: "the exact lint marks the
 * three steps bring"): each of T-160's failing hits by its trade (or the master), step, K-01 rule and own rule, and each
 * rule a step's own lint names (the emitter's marks, with T-160's master failures the cut adds). T-160 finds none on the
 * three; the emitter marks S1-77 and S1-10 unknown-slot, as it marks S1-04 (DL-965): their messages' words name
 * {{biz.name}} (and Rosie's helper {{name.staff}}, the owner's lines {{owner.name}} and {{biz.phone}}), names K-03's
 * vocabulary holds (compiler/src/slots/vocabulary.ts) but K-01's older slot list does not (bundle.v1.schema.json
 * messagesWithUnknownSlot). S1-76 names no slot and brings none.
 */
export const NEW_MARKS = ["S1-77 unknown-slot", "S1-10 unknown-slot"];

// ---- the pure checks (each gives its problems, one line each; none: it holds) --------------------------------------

/** Check 3: what is wrong with where S1-09's branches go in the steps `steps` (flow A's, by id). */
export function branchProblems(steps) {
  const s109 = steps["S1-09"];
  if (s109 === undefined) return ["S1-09 is not held"];
  const out = [];
  if (s109.type !== "split") out.push(`S1-09 is not a split (type ${String(s109.type)})`);
  for (const branch of s109.branches ?? []) {
    const goes = [...(branch.steps ?? []), ...(branch.end === "end" ? [] : [branch.rejoinAt ?? s109.next])];
    const missing = goes.filter((id) => typeof id !== "string" || steps[id] === undefined);
    if (missing.length > 0)
      out.push(`S1-09's "${String(branch.label)}" goes to ${missing.map(String).join(", ")}, which bundle v3 does not hold`);
  }
  return out;
}

/**
 * Check 4: a step's compiled shape as the commit's walk reads it (actions/src/commit/walk walk.ts visit and atSplit,
 * from graph.ts's narrowing): a step with its own gate is not walked yet; a split asks (a message branch), waits (a clock
 * branch) or is settled by code (lookups); a plain step whose message carries buttons asks; any other plain step is
 * walked. `graphStep` is graph.ts's GraphStep, or null when the bundle does not hold the step.
 */
export function shapeOf(graphStep) {
  if (graphStep === null) return { kind: "notHeld", words: "not held by the bundle" };
  if (graphStep.gated) return { kind: "gated", words: "gated: it has its own gate (K-01 step.when), which the walk does not read yet" };
  if (graphStep.split) {
    const tags = graphStep.branches.map((branch) => branch.tag);
    if (tags.includes("message")) return { kind: "asked", words: "asked: a split with a message branch, a question" };
    if (tags.includes("clock")) return { kind: "waits", words: "waiting: a split a clock settles" };
    return { kind: "lookup", words: "settled by code: a split whose branches are all lookups" };
  }
  if (graphStep.buttons > 0)
    return {
      kind: "asked",
      words: `asked: a plain message step whose message carries ${String(graphStep.buttons)} buttons (${graphStep.buttonLabels.join(" | ")}), a question`,
    };
  return { kind: "walked", words: "walked: a plain message step with no buttons" };
}

/**
 * A walk's result in words: the steps it read from the graph, in turn, then its moves and where it stopped, or what it
 * refused or did not build.
 */
export function walkWords(result) {
  const read = (result.looked ?? []).length > 0 ? `reads ${result.looked.join(", ")} in turn; ` : "";
  if (result.error !== undefined) {
    const error = result.error;
    const why = "fault" in error ? `refused ${String(error.fault)}` : `notBuilt ${String(error.seam)}`;
    return `${read}${why}${error.ids.length > 0 ? ` at ${error.ids.join(", ")}` : ""}`;
  }
  const moves = result.moves.map((move) =>
    move.kind === "branch" ? `takes "${move.branch.label}"` : `walks ${move.step.id}${move.answered === undefined ? "" : " (answered)"}`,
  );
  const { stop } = result;
  const where =
    stop.kind === "ends"
      ? `ends at ${stop.split.id}'s "${stop.branch.label}"`
      : stop.kind === "journeyEnds"
        ? `the journey ends after ${stop.step.id}`
        : `${stop.kind} at ${stop.step.id}`;
  return `${read}${moves.join(", ")}${moves.length > 0 ? ", then " : ""}stops: ${where}`;
}

/** Check 7: where `lines` differ from bundle v2's fixed lines `v2Lines` (each in order, byte for byte). */
export function fixedLineDifferences(lines, v2Lines) {
  if (!Array.isArray(lines)) return ["no fixed lines"];
  const out = [];
  for (let k = 0; k < Math.max(lines.length, v2Lines.length); k += 1) {
    const got = lines[k];
    const expected = v2Lines[k];
    if (same(got, expected)) continue;
    if (got === undefined) out.push(`${String(expected?.id)} (${String(expected?.lang)}) is missing`);
    else if (expected === undefined) out.push(`${String(got.id)} (${String(got.lang)}) is added`);
    else out.push(`line ${String(k + 1)} is ${String(got.id)} (${String(got.lang)}), not bundle v2's ${String(expected.id)} (${String(expected.lang)}) as written`);
  }
  return out;
}

/** Check 7: the prompt kinds whose manifest entry is not bundle v2's (version, sha256 and text, in its field order). */
export function promptDifferences(manifest, v2Manifest) {
  return PROMPT_KINDS.filter((kind) => !same(manifest?.prompts?.[kind], v2Manifest.prompts[kind])).map(
    (kind) => `prompts.${kind} is not bundle v2's`,
  );
}

/** Check 5: the marks found that are not expected, and the expected ones not found. */
export function markProblems(given, expected) {
  const others = given.filter((mark) => !expected.includes(mark));
  const missing = expected.filter((mark) => !given.includes(mark));
  return [
    ...(others.length === 0 ? [] : [`other marks: ${others.join(", ")}`]),
    ...(missing.length === 0 ? [] : [`not found: ${missing.join(", ")}`]),
  ];
}

// ---- what the frontier and the walk read --------------------------------------------------------------------------

/**
 * The options the frontier offers for the card of step `stepId` on `bundle` (open-questions.ts cardChoices): one per
 * means entry whose branch is a message branch with a definition, each with the branch's label, the definition, its fields
 * (the branch's answer fields; with none listed, the step's gives keys as text fields: fieldsOf) and the stakes of its
 * own walk (bundle.ts ownStakes); an entry the frontier leaves out (frontier_option_unusable) is offered: false. Null
 * when the step or its card is not read.
 */
export async function cardOptions(bundle, stepId) {
  const frontier = await load("actions/src/frontier/assemble/bundle.ts");
  const view = frontier.flowViewOf(bundle.flows[FLOW], FLOW);
  if (view === null) return null;
  const read = { bundleId: bundle.manifest.bundleId, partial: bundle.manifest.partial === true, flows: { [FLOW]: view } };
  const found = frontier.findStep(read, stepId, FLOW);
  if (found === null || found.step.card === null) return null;
  return found.step.card.means.map((means) => {
    const branch = found.step.branches.find((each) => each.label === means.branch);
    if (branch?.tag !== "message" || means.from === "none" || means.text === undefined)
      return { option: means.branch, offered: false, definition: null, fields: [], stakes: null, stakesFrom: [] };
    const reasons = frontier.ownStakes(read, found.flow, found.step, branch);
    const fields =
      branch.answerFields.length > 0
        ? branch.answerFields.map((field) => ({ ...field }))
        : found.step.gives.map((name) => ({ name, type: "text" }));
    return {
      option: branch.label,
      offered: true,
      definition: means.text,
      fields,
      stakes: reasons.length > 0 ? "high" : "low",
      stakesFrom: reasons,
    };
  });
}

/** One option in words: its label, fields, stakes (and why), and definition. */
function optionWords(entry) {
  if (!entry.offered) return `"${entry.option}": not offered (no message branch or no definition)`;
  const fields = entry.fields.map((field) => `${field.name}:${field.type}`).join(", ") || "none";
  const from = entry.stakesFrom.map(
    (reason) => `${reason.why}${reason.step === null ? "" : ` at ${reason.step}`}${reason.ref === null ? "" : ` (${reason.ref})`}`,
  );
  return `"${entry.option}" (fields ${fields}; stakes ${String(entry.stakes)}${from.length === 0 ? "" : `, from ${from.join(", ")}`}; definition "${String(entry.definition)}")`;
}

/**
 * The commit's walk (actions/src/commit/walk walk.ts walkFrom) on flow A of `bundle` from `start`: its moves and stop, or
 * its error, with `looked`, each step id the walk read from the graph, in turn (the graph's own step read, unchanged:
 * only noted).
 */
export async function walkOn(bundle, start) {
  const graphs = await load("actions/src/commit/walk/graph.ts");
  const walk = await load("actions/src/commit/walk/walk.ts");
  const errors = await load("actions/src/commit/walk/errors.ts");
  const looked = [];
  try {
    const graph = graphs.flowGraphOf(bundle.flows[FLOW], FLOW);
    const noted = {
      flow: graph.flow,
      step: (id) => {
        looked.push(id);
        return graph.step(id);
      },
      onMainPath: (id) => graph.onMainPath(id),
      enclosing: (id) => graph.enclosing(id),
    };
    return { ...walk.walkFrom(noted, start), looked };
  } catch (error) {
    if (error instanceof errors.WalkRefusedError || error instanceof errors.WalkNotBuiltError) return { error, looked };
    throw error;
  }
}

/** The step `id` of flow A of `bundle` as the commit's walk narrows it (graph.ts GraphStep), or null when not held. */
export async function graphStepOf(bundle, id) {
  const graphs = await load("actions/src/commit/walk/graph.ts");
  return graphs.flowGraphOf(bundle.flows[FLOW], FLOW).step(id);
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

  // 2. Bundle v2's eight steps, its order and its overlays.
  const v2Problems = emit.checkBundleDir(V2_DIR);
  const v2Read = emit.readBundleDir(V2_DIR);
  const v2 = v2Read.bundle;
  report(
    2,
    v2Problems.length === 0,
    `bundle v2 ${label(v2.manifest.bundleId)} read back from bundles/v2/bundle${v2Problems.length === 0 ? ", sound" : `: ${v2Problems.slice(0, 3).join("; ")}`}`,
  );
  for (const id of V2_STEPS) {
    const ours = steps[id];
    const differ = stepDifferences(ours, v2.flows[FLOW]?.steps?.[id]);
    const text = JSON.stringify(ours) ?? "";
    report(
      2,
      differ.length === 0,
      `${id} is bundle v2's byte for byte, lint included (${String(Buffer.byteLength(text, "utf8"))} bytes, sha256 ${sha256(text)})${differ.length === 0 ? "" : `: ${differ.join("; ")}`}`,
    );
  }
  const v2Order = Object.keys(v2.flows[FLOW].steps);
  report(
    2,
    same(
      held.filter((id) => V2_STEPS.includes(id)),
      v2Order,
    ),
    `the eight steps sit in bundle v2's order (${v2Order.join(", ")}), with ${NEW_STEPS.join(", ")} where the build's page order puts them`,
  );
  const otherFields = Object.keys(flows[FLOW] ?? {}).filter(
    (key) => key !== "steps" && !same(flows[FLOW][key], v2.flows[FLOW][key]),
  );
  note(
    2,
    `flow A's other fields (sections, routing, record, …): ${otherFields.length === 0 ? "bundle v2's byte for byte" : `${otherFields.join(", ")} differ from bundle v2's (the whole build's today)`}`,
  );
  const v2Trades = new Map(v2Read.files.filter((file) => file.path.startsWith("trade/")).map((file) => [file.path, file.text]));
  const ourTrades = read.files.filter((file) => file.path.startsWith("trade/"));
  const sameTrades = ourTrades.filter((file) => v2Trades.get(file.path) === file.text).length;
  report(
    2,
    sameTrades === ourTrades.length && ourTrades.length === v2Trades.size,
    `${String(sameTrades)} of ${String(ourTrades.length)} trade overlays are bundle v2's byte for byte (bundle v2 holds ${String(v2Trades.size)})`,
  );

  // 3. S1-09: its options, their fields and stakes; its next and where each branch goes; the walk from each.
  await checkS109(report, note, read.bundle, v2, steps);

  // 4. S1-10's compiled shape and next; S1-77's and S1-76's.
  await checkShapes(report, note, read.bundle, steps);

  // 5. T-160's lint on the eleven steps.
  await checkLint(report, note, read.bundle, tradeIds);

  // 6. The slots of each line Rosie sends in S1-77, S1-76 and S1-10.
  for (const id of NEW_STEPS) {
    const sent = sentLines(steps[id]);
    report(
      6,
      steps[id] !== undefined && sent.length > 0,
      `${id}: ${String(sent.length)} line${sent.length === 1 ? "" : "s"} Rosie sends: ${sent.map((line) => `say[${String(line.at)}] to ${String(line.to)} names ${line.slots.length === 0 ? "no slot" : line.slots.join(" ")}`).join("; ") || "none"}`,
    );
    for (const line of sent) note(6, `${id} say[${String(line.at)}] to ${String(line.to)}: "${String(line.text)}"`);
    const card = steps[id]?.card;
    if (card !== undefined)
      note(6, `${id}'s question card (decide reads it; Rosie does not send it) names ${slotsOf(JSON.stringify(card)).join(" ") || "no slot"}`);
    const ends = (steps[id]?.branches ?? []).filter((branch) => typeof branch.endText === "string");
    for (const branch of ends)
      note(6, `${id} "${branch.label}" end text names ${slotsOf(branch.endText).join(" ") || "no slot"}: "${branch.endText}"`);
    if (typeof steps[id]?.fallbackText === "string")
      note(6, `${id}'s fallback text names ${slotsOf(steps[id].fallbackText).join(" ") || "no slot"}: "${steps[id].fallbackText}"`);
    const marked = (steps[id]?.say ?? []).filter((said) => said.elements?.stop !== undefined);
    note(6, `${id}'s messages carry the opt-out marker: ${marked.length === 0 ? "none" : marked.map((said) => JSON.stringify(said.elements.stop)).join(", ")}`);
  }

  // 7. The manifest: prompts, prompts.json, models.json, fixed lines, journeys.
  const promptDiffer = promptDifferences(manifest, v2.manifest);
  report(
    7,
    promptDiffer.length === 0,
    `prompts equal bundles/v2's byte for byte: ${PROMPT_KINDS.map((kind) => `${kind} ${String(manifest.prompts?.[kind]?.version)} (sha256 ${String(manifest.prompts?.[kind]?.sha256).slice(0, 8)}…)`).join(", ")}${promptDiffer.length === 0 ? "" : `: ${promptDiffer.join("; ")}`}`,
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
    7,
    modules.length === 0 && decideOk,
    `each prompt as its module gives it today, its sha256 its text's: decide is ai/src/decide/prompt.ts DECIDE_2_PROMPT (${String(manifest.prompts?.decide?.version)}, sha256 ${String(manifest.prompts?.decide?.sha256)}), not v1's decide-1 (sha256 ${decide.DECIDE_PROMPT.sha256}), and no decide-3${modules.length === 0 ? "" : `; not as today: ${modules.join(", ")}`}`,
  );
  const file = readPromptsFile();
  report(
    7,
    readFileSync(PROMPTS_FILE).equals(readFileSync(V2_PROMPTS_FILE)) &&
      PROMPT_KINDS.every((kind) => file[kind]?.version === manifest.prompts?.[kind]?.version && file[kind]?.text === manifest.prompts?.[kind]?.text),
    `prompts.json is bundles/v2/prompts.json byte for byte and what the manifest packs (${PROMPT_KINDS.map((kind) => `${kind} ${String(file[kind]?.version)}`).join(", ")})`,
  );
  const models = JSON.parse(readFileSync(MODELS_FILE, "utf8"));
  report(
    7,
    readFileSync(MODELS_FILE).equals(readFileSync(V2_MODELS_FILE)) &&
      same(manifest.models, models.models) &&
      same(manifest.policy, models.policy) &&
      same(manifest.models, v2.manifest.models) &&
      same(manifest.policy, v2.manifest.policy),
    `models.json is bundles/v2/models.json byte for byte, and the manifest's models ${JSON.stringify(manifest.models)} and policy ${JSON.stringify(manifest.policy)} are bundle v2's`,
  );
  const fixed = manifest.lists?.fixedLines?.lines;
  const v2Lines = v2.manifest.lists.fixedLines.lines;
  const fixedDiffer = fixedLineDifferences(fixed, v2Lines);
  report(
    7,
    fixedDiffer.length === 0 && same(manifest.lists.fixedLines, v2.manifest.lists.fixedLines),
    `the fixed lines are bundle v2's ${String(v2Lines.length)} byte for byte, signUpOpener last (${String(fixed?.at(-1)?.id)}: "${String(fixed?.at(-1)?.text)}")${fixedDiffer.length === 0 ? "" : `: ${fixedDiffer.join("; ")}`}`,
  );
  report(7, same(manifest.journeys, []), "journeys: none, as bundles v0, v1, v1.1 and v2 list none");
  for (const list of ["keywords", "keyMap", "outOfScope"])
    note(7, `lists.${list}: the build's, ${same(manifest.lists[list], v2.manifest.lists[list]) ? "the same as bundle v2's" : "not bundle v2's"}`);
  const manifestDiffer = Object.keys(manifest).filter(
    (key) => !["bundleId", "lint", "storage"].includes(key) && !same(manifest[key], v2.manifest[key]),
  );
  note(
    7,
    `the manifest's other fields (contract, builtAt, compiler, inputs, …): ${manifestDiffer.length === 0 ? "bundle v2's byte for byte; only bundleId, lint and storage differ" : `${manifestDiffer.join(", ")} differ from bundle v2's`}`,
  );

  // 8. The bundle id.
  const v0 = emit.readBundleDir(V0_DIR).bundle;
  const v1 = emit.readBundleDir(V1_DIR).bundle;
  const v11 = emit.readBundleDir(V11_DIR).bundle;
  const id = manifest.bundleId;
  const idProblems = ids.bundleIdProblems(manifest);
  const hash = ids.contentHashOfFiles(read.files);
  const earlier = [v0.manifest.bundleId, v1.manifest.bundleId, v11.manifest.bundleId, v2.manifest.bundleId];
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
    `KV bulk file ${kvFile === KV_FILE ? "bundles/v3/bundle.kv.json" : kvFile}: ${String(Array.isArray(entries) ? entries.length : 0)} entries, one per part, every key under ${prefixOf(id)}, each value the part's bytes${kvDiffer.length === 0 ? "" : `: ${kvDiffer.slice(0, 5).join("; ")}`}`,
  );

  // 10 and 11.
  if (full !== null) checkFull(report, emit, read, full);
  if (db) await checkDb(report, read);
  return lines;
}

// ---- 3. S1-09 -----------------------------------------------------------------------------------------------------

async function checkS109(report, note, bundle, v2, steps) {
  const s109 = steps["S1-09"];
  const ours = await cardOptions(bundle, "S1-09");
  const theirs = await cardOptions(v2, "S1-09");
  report(
    3,
    ours !== null && ours.length === 3 && ours.every((entry) => entry.offered && entry.stakes !== null),
    `S1-09's offered options on bundle v3, as the frontier offers its card (open-questions.ts cardChoices; stakes from bundle.ts ownStakes): ${ours === null ? "S1-09 or its card not read" : ours.map(optionWords).join("; ")}`,
  );
  note(
    3,
    `on bundle v2: ${theirs === null ? "S1-09 or its card not read" : theirs.map((entry) => `"${entry.option}" ${String(entry.stakes)}${entry.stakesFrom.length === 0 ? "" : ` (${entry.stakesFrom.map((reason) => reason.why).join(", ")})`}`).join("; ")}`,
  );
  const high = (ours ?? []).filter((entry) => entry.stakes === "high");
  note(
    3,
    high.length === 0
      ? "no option's own walk is high, so the assembler's sibling rule (assemble.ts: an option of a question with a high option is high) raises none"
      : `the assembler's sibling rule (assemble.ts) makes every option of S1-09 high, from ${high.map((entry) => `"${entry.option}"`).join(", ")}`,
  );
  const buttons = (s109?.say ?? []).flatMap((said) => (said.from === "san" ? (said.elements?.buttons ?? []) : []));
  note(
    3,
    `S1-09's own message carries ${String(buttons.length)} buttons (${buttons.join(" | ")}); its card has ${String(s109?.card?.means?.length ?? 0)} options, so decide is offered the card's options, not the buttons; its safe default: "${String(s109?.card?.safeDefault)}"; its clock: ${JSON.stringify(s109?.card?.clock ?? null)}`,
  );
  const goes = branchProblems(steps);
  const branchLines = (s109?.branches ?? []).map(
    (branch) =>
      `"${branch.label}" (${branch.tag}; its own steps ${(branch.steps ?? []).join(", ") || "none"}; ${branch.end === "end" ? "ends" : `rejoins at ${String(branch.rejoinAt ?? s109?.next)}`}; effects ${(branch.effects ?? []).map((effect) => `${effect.kind} ${String(effect.ref)}`).join(", ") || "none"})`,
  );
  report(
    3,
    s109?.next === "S1-10" && goes.length === 0,
    `S1-09.next is ${String(s109?.next)}; its branches: ${branchLines.join(", ")}; each target held by bundle v3${goes.length === 0 ? "" : `: ${goes.join("; ")}`}`,
  );
  for (const branch of s109?.branches ?? []) {
    const walked = await walkOn(bundle, { kind: "branch", step: "S1-09", branch: branch.label });
    note(3, `the commit's walk (walk.ts walkFrom) on bundle v3 from S1-09's "${branch.label}": ${walkWords(walked)}`);
  }
}

// ---- 4. the shapes of S1-10, S1-77 and S1-76 ----------------------------------------------------------------------

/** A step's K-01 fields in words: lane, via, its gives and needs, its gate, its card. */
function fieldsWords(step) {
  return `${String(step?.who)} to ${String(step?.to)} by ${String(step?.via)}; type ${step?.type === "split" ? "split" : "plain"}; needs ${(step?.needs ?? []).join(" ") || "nothing"}; gives ${(step?.gives ?? []).join(" ") || "nothing"}; tells ${(step?.tells ?? []).join(" ") || "nobody"}; ${step?.when === undefined ? "no gate" : "a gate (when)"}; ${step?.card === undefined ? "no card" : "a card"}`;
}

async function checkShapes(report, note, bundle, steps) {
  const s110 = steps["S1-10"];
  const graphStep = await graphStepOf(bundle, "S1-10");
  const shape = shapeOf(graphStep);
  report(
    4,
    graphStep !== null && shape.kind !== "notHeld",
    `S1-10's compiled shape, as the commit's walk reads it: ${shape.words} (${fieldsWords(s110)}); S1-10.next is ${String(s110?.next)}${typeof s110?.next === "string" && steps[s110.next] === undefined ? ", which bundle v3 does not hold (not reachable in a partial bundle)" : ""}`,
  );
  const eventWords = (s110?.more ?? []).filter((line) => /S1-32|uploads/u.test(line));
  note(
    4,
    `waiting on an event: no. K-01 v1 has no step field that waits on an event, and the walk stops only where a step asks, a clock settles a split, a branch ends or the journey ends (walk.ts Stop; arch 03 line 191 names an event wait the walk does not have). S1-10's own words name the event only as text: ${eventWords.map((line) => `"${line}"`).join(" ") || "none"}`,
  );
  const fromS110 = await walkOn(bundle, { kind: "step", step: "S1-10" });
  note(4, `the commit's walk (walk.ts walkFrom) on bundle v3 from S1-10 entered: ${walkWords(fromS110)}`);
  for (const id of ["S1-77", "S1-76"]) {
    const step = steps[id];
    const its = shapeOf(await graphStepOf(bundle, id));
    const holders = (steps["S1-09"]?.branches ?? []).filter((branch) => (branch.steps ?? []).includes(id));
    report(
      4,
      step !== undefined && its.kind !== "notHeld",
      `${id}'s compiled shape: ${its.words} (${fieldsWords(step)}); ${id}.next is ${String(step?.next)}${step?.next === null ? `: its list ends with it, so the walk goes where ${holders.map((branch) => `S1-09's "${branch.label}"`).join(", ") || "its branch"} goes (${holders.map((branch) => (branch.end === "end" ? "ends" : `rejoins at ${String(branch.rejoinAt ?? steps["S1-09"]?.next)}`)).join(", ")})` : ""}`,
    );
  }
}

// ---- 5. T-160's lint ----------------------------------------------------------------------------------------------

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
  const eightGiven = given.filter((mark) => !isNew(mark));
  const newGiven = given.filter(isNew);
  const eight = markProblems(eightGiven, V2_MARKS);
  const three = markProblems(newGiven, NEW_MARKS);
  report(
    5,
    eight.length === 0,
    `on bundle v2's eight steps, T-160's lint finds exactly bundle v2's two marks, the whole build's own (${V2_MARKS.join("; ")}), and no other${eight.length === 0 ? "" : `: ${eight.join("; ")}`}`,
  );
  report(
    5,
    three.length === 0,
    `the marks S1-77, S1-76 and S1-10 bring, exactly: ${NEW_MARKS.length === 0 ? "none" : NEW_MARKS.join("; ")} (T-160's lint, compiler/src/lint/report.ts, ${String(run.rules.length)} rules, Master Corrections ${run.corrections.join(", ")}: ${String(master.length)} failures in the master's flows and ${String(traded.length)} in the ${String((run.results.length - 2) / 2)} trades' flows on the eleven steps; the steps' own marks ${marks.length === 0 ? "none" : marks.map((mark) => `${mark.id} ${mark.rule}`).join(", ")}); found on S1-77, S1-76 and S1-10: ${newGiven.length === 0 ? "none" : newGiven.join(", ")}${three.length === 0 ? "" : `: ${three.join("; ")}`}`,
  );
  const named = (list) =>
    list.map((failure) => `${failure.trade ?? "the master"}'s ${failure.step} ${failure.rule}: ${failure.message}`).join(" | ");
  if (found.length > 0) note(5, `T-160's failures on the eleven steps: ${named(found)}`);
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
    5,
    same(listed, expected) && counted,
    `the manifest's lint summary counts the eleven steps' failures, as the marks and the lint give them: ${summary.rules.filter((entry) => entry.failures > 0).map((entry) => `${entry.rule} ${String(entry.failures)}`).join(", ") || "none"} (${String(summary.rules.length)} rules listed); failing: ${String(summary.failures.length)}`,
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
  report(10, differ.length === 0, `the eleven steps are the build's byte for byte but their lint${differ.length === 0 ? "" : `: ${differ.join(", ")} differ`}`);
  const order = Object.keys(flows[FLOW].steps).filter((id) => STEPS.includes(id));
  report(10, same(Object.keys(ours.steps), order), `the eleven steps in the build's page order: ${order.join(", ")}`);
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
    "the manifest's storage lists each trade overlay as the build lists it (kind, trade, bytes, sha256), under v3's id",
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
        ? `${label(active.bundleId)} since ${active.activatedAt}${label(active.bundleId) === label(id) ? " (bundle v3)" : ""}`
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
  const usage = "usage: node bundles/v3/check.mjs [--full <full build folder>] [--db]";
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
