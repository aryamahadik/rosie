// Bundle v2 (T-1477; DL-999 (g), card 8 of ops/reviews/s1-04-design/check-merge.json; DL-1033 ruling 2; K-01 v1): bundle
// v1's six steps of flow A byte for byte (S1-01 and S1-02 bundle v0 …/2's; S1-11, S1-04, S1-03 and S1-74 bundle v1's),
// plus S1-08 and S1-09, the steps S1-04's answer walks to (S1-04.next is S1-08, S1-08.next is S1-09), and every trade's
// plug-in overlay, cut from the compiler's whole build. Its prompts, models and routing are bundle v1.1's (decide-2, not
// v1's decide-1, which would bring back the silent second text: DL-1014, DL-1033), and its fixed lines are bundle v1.1's
// plus one, signUpOpener (DL-1033 ruling 1; Lead note 1 of ops/cards/T-1477.md), carried here as data: T-1510 writes its
// K-01 README default and T-1511 makes finalize insert it.
//
// It is made in three runs, from the repository root, as bundles/v1/build.mjs makes bundle v1:
//
//   1. node bundles/v2/build.mjs prompts
//        writes bundles/v2/prompts.json, the file `compiler build --prompts` reads: each prompt bundle v1.1 packs, its
//        version and text as its own module gives it (bundles/v1.1/build.mjs promptsFromModules: bundle v1's safetyRead,
//        planner stand-in and composer, and decide-2, ai/src/decide/prompt.ts DECIDE_2_PROMPT, T-1500); and
//        bundles/v2/models.json, bundle v1.1's models.json byte for byte (Q-26's routing, the two ids the router accepts).
//   2. npm run cli -w @rosie/compiler -- build --out <full> --build 1 --built-at <utc>
//        --prompts bundles/v2/prompts.json --models bundles/v2/models.json
//        the compiler's whole build of fixture set v1 (T-149, T-150): both flows and every trade, Master Corrections in
//        the run's order, each trade's overlay with C5's fills, as bundles/v1/build.mjs's run 2.
//   3. node bundles/v2/build.mjs cut <full> [--replace]
//        writes bundles/v2/bundle/, bundle v2 (below), into a new or empty folder, and checks it as `compiler build`
//        checks what it writes. --replace cuts bundle v2 anew over the one bundles/v2 holds: that folder and its KV bulk
//        file bundles/v2/bundle.kv.json are removed first, and the cut is refused if it would give the same bundle id
//        with other bytes (K-01 "Storage": keys are written once per bundle id).
// Then `npm run cli -w @rosie/compiler -- publish bundles/v2/bundle` (T-152) writes PostgreSQL's copy and the KV bulk
// file bundles/v2/bundle.kv.json, and bundles/v2/check.mjs proves the card's checks. On staging the deploy publishes it
// and makes it active (`npm run deploy:staging -- --bundle bundles/v2`, step 3: infra/scripts/publish-bundle.sh).
//
// What the cut keeps, and the only things it writes itself (K-01 v1 "Storage": one manifest, one graph per flow, one
// overlay per trade, each its own value under the bundle id):
//   flow/A.json      the build's flow A graph as compiled, its steps cut to S1-01, S1-02, S1-11, S1-04, S1-03, S1-74,
//                    S1-08 and S1-09 in the build's page order, each byte for byte the build's but its `lint`: the rules
//                    it fails, its own marks with T-160's master failures for it (bundles/v1/build.mjs's rule). Its
//                    sections, routing tables, record and the rest are the build's (a step the bundle does not hold is
//                    not reachable: K-01 README, "Fixtures"; manifest.partial). S1-01 and S1-02 must be bundle v0 …/2's
//                    byte for byte and S1-11, S1-04, S1-03 and S1-74 bundle v1's (lint included), so a question asked
//                    under v0, v1 or v1.1 keeps its options, its card and its buttons (DL-961; DL-999 (a): S1-04 stays
//                    v1's, no compiler change on this path): the cut stops, naming each field that differs, when the
//                    build no longer gives them.
//   trade/<id>.json  every trade overlay the build holds, byte for byte (K-01 tradeOverlay under .../trade/<id>).
//   manifest.json    the build's manifest (inputs, prompts, models, policy, shared lists, built at, compiler) with
//                    partial: true; its storage, flow/A and every trade, each as the build lists it; its lint summary,
//                    every rule the emitter's marks and T-160's lint (compiler/src/lint/report.ts) ran, counted on the
//                    eight steps, in the master's flow A and in every trade's; no journey, as bundles v0, v1 and v1.1
//                    list none; its fixed lines, bundle v1.1's (compiler/src/fixed-lines buildFixedLines() for staging's
//                    base path /test, as bundle v0 …/2's and v1's) with SIGN_UP_OPENER last; and its bundle id, the
//                    content hash of its stored values with build BUILD (T-150's numberBundle). The prompts, models and
//                    policy the build copied from prompts.json and models.json must be bundle v1.1's manifest's.
// Nothing reads a clock: the same full build gives the same bytes.
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUNDLE_DIR as V1_DIR,
  ROOT,
  V0_DIR,
  V0_STEPS,
  fixedLinesOfStaging,
  load,
  stepDifferences,
} from "../v1/build.mjs";
import {
  BUNDLE_DIR as V11_DIR,
  MODELS_FILE as V11_MODELS_FILE,
  PROMPT_KINDS,
  label,
  promptsFromModules,
  sha256,
} from "../v1.1/build.mjs";

export {
  PROMPT_KINDS,
  ROOT,
  V0_DIR,
  V0_STEPS,
  V11_DIR,
  V11_MODELS_FILE,
  V1_DIR,
  fixedLinesOfStaging,
  label,
  load,
  promptsFromModules,
  sha256,
  stepDifferences,
};

/** bundles/v2/. */
export const HERE = dirname(fileURLToPath(import.meta.url));

/** The bundle folder this script writes, its KV bulk file (the publish's default), and the two files run 1 writes. */
export const BUNDLE_DIR = join(HERE, "bundle");
export const KV_FILE = `${BUNDLE_DIR}.kv.json`;
export const PROMPTS_FILE = join(HERE, "prompts.json");
export const MODELS_FILE = join(HERE, "models.json");

/** What bundle v2 holds: these steps of this flow (DL-999 (g); card 8), and every trade's overlay. */
export const FLOW = "A";
export const STEPS = ["S1-01", "S1-02", "S1-11", "S1-04", "S1-03", "S1-74", "S1-08", "S1-09"];

/** The steps bundle v1 holds, which bundle v2 holds byte for byte (lint included), and those bundle v1 holds as v0's. */
export const V1_HELD = ["S1-01", "S1-02", "S1-11", "S1-04", "S1-03", "S1-74"];
export const V1_STEPS = V1_HELD.filter((id) => !V0_STEPS.includes(id));

/** The two steps bundle v2 adds: S1-04's next and S1-08's next. */
export const NEW_STEPS = ["S1-08", "S1-09"];

/**
 * The build number of v2's id (K-01 manifest.bundleId.build counts publishes from 1): its first publish. Its flow A
 * holds two steps more than bundle v1's, so its content hash is new and no earlier bundle has its keys.
 */
export const BUILD = 1;

/** The environment bundle v2 is for (staging: the user's `deploy:staging -- --bundle bundles/v2`). */
export const ENVIRONMENT = "staging";

/**
 * The one fixed line bundle v2 adds to bundle v1.1's, word for word as Lead note 1 of ops/cards/T-1477.md (DL-1033
 * ruling 1) writes it: the master's S1-02 first words (MASTER-FLOW-A.md:28), so no new words and no Jay item. A fixed
 * line's id is an open pattern and each id is listed once (contracts/bundle/bundle.v1.schema.json $defs/fixedLine,
 * fixedLines).
 */
export const SIGN_UP_OPENER = Object.freeze({
  id: "signUpOpener",
  text: "Hi! I'm Rosie, an automated assistant.",
  lang: "en",
  status: "asWritten",
  use: "On Rosie's first text to an owner in sign-up, read by the sign-up line, on a step that does not need business, in place of opener, with the privacy-notice link.",
  source:
    "MASTER-FLOW-A.md:28 (S1-02's first words); arch 07 line 361 (S1-02's opener before there is a business); RULES 1.11, 4.3; K-09 v1 finalize-pass.json",
});

function fail(message) {
  throw new Error(message);
}

// ---- 1. the prompts ---------------------------------------------------------------------------------------------

async function writePrompts() {
  const given = await promptsFromModules();
  const file = {};
  for (const kind of PROMPT_KINDS) file[kind] = { version: given[kind].prompt.version, text: given[kind].prompt.text };
  writeFileSync(PROMPTS_FILE, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  copyFileSync(V11_MODELS_FILE, MODELS_FILE);
  for (const kind of PROMPT_KINDS) {
    const { prompt, from } = given[kind];
    console.log(`prompt ${kind}: ${prompt.version}, sha256 ${prompt.sha256}, from ${from}`);
  }
  console.log(`wrote ${PROMPTS_FILE}`);
  console.log(`wrote ${MODELS_FILE}, bundle v1.1's ${V11_MODELS_FILE} byte for byte`);
}

/** prompts.json as run 1 wrote it. */
export function readPromptsFile() {
  return JSON.parse(readFileSync(PROMPTS_FILE, "utf8"));
}

// ---- 3. the cut -------------------------------------------------------------------------------------------------

/** The rules a step fails, as K-01 orders them: its own marks and the lint's. */
function inOrder(order, rules) {
  const set = new Set(rules);
  const unknown = [...set].filter((rule) => !order.includes(rule));
  if (unknown.length > 0) fail(`not K-01 v1 lint rules: ${unknown.join(", ")}`);
  return order.filter((rule) => set.has(rule));
}

/** Bundle v1.1's fixed lines with SIGN_UP_OPENER last (DL-1033 ruling 1). */
export function withSignUpOpener(fixedLines) {
  if (fixedLines.lines.some((line) => line.id === SIGN_UP_OPENER.id))
    fail(`the fixed lines already hold ${SIGN_UP_OPENER.id}: each id is listed once`);
  return { ...structuredClone(fixedLines), lines: [...structuredClone(fixedLines.lines), { ...SIGN_UP_OPENER }] };
}

/** A bundle folder read back and checked as the publish checks one (compiler/src/publish readPublishable). */
function readSound(emit, ids, dir, name) {
  const problems = emit.checkBundleDir(dir);
  if (problems.length > 0) fail(`${dir} is not a sound bundle: ${problems.slice(0, 5).join("; ")}`);
  const read = emit.readBundleDir(dir);
  const idProblems = ids.bundleIdProblems(read.bundle.manifest);
  if (idProblems.length > 0) fail(`${name} ${dir}: its bundle id does not hold (${idProblems.join("; ")})`);
  return read;
}

/**
 * Bundle v2 cut from the full build in `full` (see the top of this file): its K-01 root, its files, and what the cut
 * found on the way (the lint run, the full build's id, the ids of the bundles it holds steps of, the base path).
 */
export async function cutBundle(full) {
  const emit = await load("compiler/src/emit/index.ts");
  const ids = await load("compiler/src/bundle-id/index.ts");
  const lint = await load("compiler/src/lint/report.ts");
  const { basePath, fixedLines: staging } = await fixedLinesOfStaging();

  // The full build, read back and checked as `compiler build --build <n>` and the publish check it.
  const read = readSound(emit, ids, full, "the full build");
  const manifest = read.bundle.manifest;
  if (manifest.partial !== undefined) fail(`${full} is a partial bundle; the cut reads a whole build`);
  const graph = read.bundle.flows[FLOW];
  if (graph === undefined) fail(`${full} holds no flow ${FLOW}`);
  for (const id of STEPS) if (graph.steps[id] === undefined) fail(`${full}: flow ${FLOW} has no step ${id}`);
  const tradeFiles = read.files.filter((file) => file.path.startsWith("trade/"));
  const tradeIds = tradeFiles.map((file) => file.path.slice("trade/".length, -".json".length));
  if (tradeIds.length === 0) fail(`${full} holds no trade overlay`);
  const tradeEntries = manifest.storage.values.filter((value) => value.kind === "trade");
  if (tradeEntries.length !== tradeIds.length)
    fail(`${full}: its manifest lists ${String(tradeEntries.length)} trade values for ${String(tradeIds.length)} files`);

  // Bundles v0 …/2, v1 and v1.1, read back and checked: v2 holds steps of v0 and v1 and v1.1's manifest lines.
  const v0 = readSound(emit, ids, V0_DIR, "bundle v0").bundle;
  const v1 = readSound(emit, ids, V1_DIR, "bundle v1").bundle;
  const v11 = readSound(emit, ids, V11_DIR, "bundle v1.1").bundle;

  // The prompts, models and routing the build copied from prompts.json and models.json: bundle v1.1's.
  for (const kind of PROMPT_KINDS)
    if (JSON.stringify(manifest.prompts[kind]) !== JSON.stringify(v11.manifest.prompts[kind]))
      fail(`the full build's prompt ${kind} is not bundle v1.1's: build it with --prompts ${PROMPTS_FILE}`);
  if (
    JSON.stringify(manifest.models) !== JSON.stringify(v11.manifest.models) ||
    JSON.stringify(manifest.policy) !== JSON.stringify(v11.manifest.policy)
  )
    fail(`the full build's models or routing are not bundle v1.1's: build it with --models ${MODELS_FILE}`);

  // The fixed lines: bundle v1.1's, which are compiler/src/fixed-lines's for staging, and signUpOpener.
  if (JSON.stringify(v11.manifest.lists.fixedLines) !== JSON.stringify(staging))
    fail(`bundle v1.1's fixed lines are not compiler/src/fixed-lines's for ${ENVIRONMENT} today`);
  const fixedLines = withSignUpOpener(v11.manifest.lists.fixedLines);

  // T-160's lint of the master's flows and of every trade's flows the bundle holds, as the build reads them (Master
  // Corrections applied): the failures of the eight steps in flow A, the master's and each trade's.
  const run = lint.lintFixtureSet(tradeIds);
  const report = lint.lintReport(run.results);
  const linted = report.failures.filter((failure) => failure.flow === FLOW && STEPS.includes(failure.step));

  const order = emit.lintRuleOrder();
  const steps = {};
  for (const [id, built] of Object.entries(graph.steps)) {
    if (!STEPS.includes(id)) continue;
    const step = structuredClone(built);
    step.lint = inOrder(order, [
      ...step.lint,
      ...linted.filter((failure) => failure.step === id && failure.trade === null).map((failure) => failure.rule),
    ]);
    steps[id] = step;
  }
  const held = [
    ...V0_STEPS.map((id) => ({ id, theirs: v0.flows[FLOW]?.steps?.[id], name: "bundle v0 …/2", why: "DL-961" })),
    ...V1_STEPS.map((id) => ({ id, theirs: v1.flows[FLOW]?.steps?.[id], name: "bundle v1", why: "DL-999 (g)" })),
  ];
  for (const { id, theirs, name, why } of held) {
    const differ = stepDifferences(steps[id], theirs);
    if (differ.length > 0)
      fail(
        `NEED: the whole build no longer gives ${name}'s bytes for ${id} (${why}: a question asked under it keeps its options): ${differ.join("; ")}`,
      );
  }
  const flow = { ...graph, steps };
  const failures = [
    ...STEPS.flatMap((id) =>
      steps[id].lint.map((rule) => {
        const found = linted.find((failure) => failure.step === id && failure.trade === null && failure.rule === rule);
        return found ?? { rule, flow: FLOW, step: id, trade: null, message: `${id} fails ${rule}` };
      }),
    ),
    ...linted.filter((failure) => failure.trade !== null),
  ];
  const rules = inOrder(order, [
    ...manifest.lint.rules.map((entry) => entry.rule),
    ...report.rules.map((entry) => entry.rule),
  ]);

  const text = JSON.stringify(flow);
  const provisional = { ...ids.PROVISIONAL_BUNDLE_ID };
  const prefix = ids.keyPrefix(provisional);
  const fullPrefix = ids.keyPrefix(manifest.bundleId);
  const cut = structuredClone(manifest);
  cut.bundleId = provisional;
  cut.lists = { ...cut.lists, fixedLines };
  cut.lint = {
    rules: rules.map((rule) => ({ rule, failures: failures.filter((failure) => failure.rule === rule).length })),
    failures,
  };
  cut.journeys = [];
  cut.storage = {
    manifestKey: `${prefix}manifest`,
    values: [
      {
        key: `${prefix}flow/${FLOW}`,
        kind: "flow",
        flow: FLOW,
        bytes: emit.byteLength(text),
        sha256: sha256(text),
      },
      ...tradeEntries.map((entry) => ({ ...entry, key: `${prefix}${entry.key.slice(fullPrefix.length)}` })),
    ],
  };
  cut.partial = true;
  const trades = {};
  for (const id of tradeIds) trades[id] = read.bundle.trades[id];
  const bundle = { manifest: cut, flows: { [FLOW]: flow }, trades };
  const refused = emit.checkBundlePart(bundle);
  if (refused.length > 0) fail(`the cut bundle is not K-01 v1's: ${refused.slice(0, 5).join("; ")}`);
  const files = [
    { path: `flow/${FLOW}.json`, text },
    { path: "manifest.json", text: JSON.stringify(cut) },
    ...tradeFiles.map((file) => ({ path: file.path, text: file.text })),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const numbered = ids.numberBundle({ bundle, files }, BUILD);
  return {
    ...numbered,
    linted,
    ruleCount: report.rules.length,
    lintedTrades: (run.results.length - 2) / 2,
    fullId: manifest.bundleId,
    v0Id: v0.manifest.bundleId,
    v1Id: v1.manifest.bundleId,
    v11Id: v11.manifest.bundleId,
    basePath,
    tradeIds,
  };
}

/**
 * Before a cut with --replace: the bundle bundles/v2 holds now, if any, and whether the new cut may take its place. The
 * same bundle id with other bytes is refused (K-01 "Storage": keys are written once per bundle id); another id, or the
 * same bytes, may.
 */
function replaceable(emit, ids, cut) {
  if (!existsSync(BUNDLE_DIR) || readdirSync(BUNDLE_DIR).length === 0) return null;
  const old = emit.readBundleDir(BUNDLE_DIR);
  const id = old.bundle.manifest.bundleId;
  const same = id.hash === cut.bundleId.hash && id.build === cut.bundleId.build;
  if (same) {
    const byPath = new Map(cut.files.map((file) => [file.path, file.text]));
    const changed = old.files.filter((file) => byPath.get(file.path) !== file.text).map((file) => file.path);
    if (changed.length > 0 || old.files.length !== cut.files.length)
      fail(
        `bundles/v2 holds bundle ${label(id)} with other bytes (${changed.join(", ") || "other files"}): a bundle with other bytes takes another build number (BUILD in this file)`,
      );
  }
  return ids.keyPrefix(id);
}

async function writeCut(fullArg, replace) {
  if (fullArg === undefined) fail("usage: node bundles/v2/build.mjs cut <full build folder> [--replace]");
  const full = isAbsolute(fullArg) ? fullArg : resolve(process.cwd(), fullArg);
  if (!replace && existsSync(BUNDLE_DIR) && readdirSync(BUNDLE_DIR).length > 0)
    fail(`${BUNDLE_DIR} is not empty: a bundle is written into a new or empty folder (--replace cuts bundle v2 anew)`);
  const emit = await load("compiler/src/emit/index.ts");
  const ids = await load("compiler/src/bundle-id/index.ts");
  const cut = await cutBundle(full);
  const replaced = replace ? replaceable(emit, ids, cut) : null;
  if (replaced !== null) {
    // Bundle v2's own folder and its KV bulk file only: the publish writes the new KV file for the new id.
    rmSync(BUNDLE_DIR, { recursive: true });
    rmSync(KV_FILE, { force: true });
    console.log(`replaced the bundle bundles/v2 held (${replaced}) and its KV bulk file ${KV_FILE}`);
  }
  emit.writeBundle(BUNDLE_DIR, cut.files);

  // Read back from disk, as `compiler build --build <n>` checks what it wrote.
  const problems = emit.checkBundleDir(BUNDLE_DIR);
  const back = emit.readBundleDir(BUNDLE_DIR);
  problems.push(...ids.bundleIdProblems(back.bundle.manifest));
  const hash = ids.contentHashOfFiles(back.files);
  if (hash !== cut.bundleId.hash) problems.push(`the content hash of the files read back is ${hash}`);
  if (problems.length > 0) fail(`the bundle written to ${BUNDLE_DIR} is not sound: ${problems.join("; ")}`);

  console.log(`cut from the full build ${label(cut.fullId)} in ${full}`);
  console.log(
    `bundle v2: ${label(cut.bundleId)}, flow ${FLOW} steps ${Object.keys(back.bundle.flows[FLOW].steps).join(", ")}, and ${String(cut.tradeIds.length)} trade overlays, partial`,
  );
  console.log(`${V0_STEPS.join(" and ")} are bundle v0 ${label(cut.v0Id)}'s byte for byte (${V0_DIR})`);
  console.log(`${V1_STEPS.join(", ")} are bundle v1 ${label(cut.v1Id)}'s byte for byte, lint included (${V1_DIR})`);
  console.log(
    `T-160's lint of the master's flows and ${String(cut.lintedTrades)} trades' flows (${String(cut.ruleCount)} K-01 rules run): ${String(cut.linted.length)} failures on ${STEPS.join(", ")}`,
  );
  const manifest = back.bundle.manifest;
  console.log(
    `prompts, models and routing: bundle v1.1 ${label(cut.v11Id)}'s (${PROMPT_KINDS.map((kind) => `${kind} ${manifest.prompts[kind].version}`).join(", ")})`,
  );
  const lines = manifest.lists.fixedLines.lines;
  console.log(
    `fixed lines: bundle v1.1's (compiler/src/fixed-lines for ${ENVIRONMENT}, BASE_PATH ${cut.basePath || '""'}) and ${SIGN_UP_OPENER.id} last, ${String(lines.length)} lines: ${lines.map((line) => `${line.id} (${line.lang})`).join(", ")}`,
  );
  const tradeBytes = back.files
    .filter((file) => file.path.startsWith("trade/"))
    .reduce((sum, file) => sum + emit.byteLength(file.text), 0);
  for (const file of back.files)
    if (!file.path.startsWith("trade/"))
      console.log(`wrote ${file.path} (${String(emit.byteLength(file.text))} bytes, sha256 ${sha256(file.text)})`);
  console.log(
    `wrote ${String(cut.tradeIds.length)} trade overlays in trade/ (${String(tradeBytes)} bytes), each the build's byte for byte`,
  );
  console.log(
    `read back from ${BUNDLE_DIR} and validated against K-01 v1; its bundle id is the content hash of its stored values`,
  );
}

// ---- the command line -------------------------------------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cutArgs = rest.filter((arg) => arg !== "--replace");
  const cutOk = command === "cut" && cutArgs.length <= 1 && rest.filter((arg) => arg === "--replace").length <= 1;
  const run =
    command === "prompts" && rest.length === 0
      ? writePrompts()
      : cutOk
        ? writeCut(cutArgs[0], rest.includes("--replace"))
        : null;
  if (run === null) {
    console.error("usage: node bundles/v2/build.mjs prompts | cut <full build folder> [--replace]");
    process.exitCode = 2;
  } else {
    run.catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
