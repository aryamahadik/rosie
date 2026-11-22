// Bundle v3 (T-1526; S1-09 design card 4, ops/reviews/s1-09-design/rule-s1-09.json, and the S1-10 slice,
// rule-s1-10.json; DL-1128; K-01 v1): bundle v2's eight steps of flow A byte for byte (S1-01, S1-02, S1-11, S1-04, S1-03,
// S1-74, S1-08 and S1-09, lint included), plus S1-77, S1-76 and S1-10, the steps S1-09's three branches walk to (S1-77
// is the helper's branch's own step, S1-76 the no-match branch's, and every branch rejoins at S1-10, S1-09.next), and
// every trade's plug-in overlay, cut from the compiler's whole build as bundle v2 was. Its prompts (decide-2; decide-3,
// T-1507, is not in v3), models, routing and fixed lines are bundle v2's byte for byte (bundle v1.1's lines plus
// signUpOpener). It holds no writer: what S1-09, S1-76, S1-77 and S1-10 write is the action layer's (card 3, S10-3).
//
// It is made in three runs, from the repository root, as bundles/v2/build.mjs makes bundle v2:
//
//   1. node bundles/v3/build.mjs prompts
//        writes bundles/v3/prompts.json and bundles/v3/models.json, bundle v2's files byte for byte (the files `compiler
//        build --prompts` and `--models` read), after holding each prompt they give to what its own module gives today
//        (bundles/v1.1/build.mjs promptsFromModules: decide is ai/src/decide/prompt.ts DECIDE_2_PROMPT).
//   2. npm run cli -w @rosie/compiler -- build --out <full> --build 1 --built-at <utc>
//        --prompts bundles/v3/prompts.json --models bundles/v3/models.json
//        the compiler's whole build of fixture set v1 (T-149, T-150): both flows and every trade, Master Corrections in
//        the run's order, each trade's overlay with C5's fills, as bundles/v2/build.mjs's run 2.
//   3. node bundles/v3/build.mjs cut <full> [--replace]
//        writes bundles/v3/bundle/, bundle v3 (below), into a new or empty folder, and checks it as `compiler build`
//        checks what it writes. --replace cuts bundle v3 anew over the one bundles/v3 holds: that folder and its KV bulk
//        file bundles/v3/bundle.kv.json are removed first, and the cut is refused if it would give the same bundle id
//        with other bytes (K-01 "Storage": keys are written once per bundle id).
// Then `npm run cli -w @rosie/compiler -- publish bundles/v3/bundle` (T-152) writes PostgreSQL's copy and the KV bulk
// file bundles/v3/bundle.kv.json, and bundles/v3/check.mjs proves the card's checks. Making v3 staging's default bundle
// is not this card's (T-1524's default moves after the S1-09/S1-10 slice); on staging it is deployed by name
// (`npm run deploy:staging -- --bundle bundles/v3`).
//
// What the cut keeps, and the only things it writes itself (K-01 v1 "Storage": one manifest, one graph per flow, one
// overlay per trade, each its own value under the bundle id):
//   flow/A.json      the build's flow A graph as compiled, its steps cut to the eight of bundle v2 and S1-77, S1-76 and
//                    S1-10, in the build's page order, each byte for byte the build's but its `lint`: the rules it
//                    fails, its own marks with T-160's master failures for it (bundles/v1/build.mjs's rule). Its
//                    sections, routing tables, record and the rest are the build's (a step the bundle does not hold is
//                    not reachable: K-01 README, "Fixtures"; manifest.partial). The eight steps must be bundle v2's byte
//                    for byte, lint included, so a question asked under v0, v1, v1.1 or v2 keeps its options, its card
//                    and its buttons (DL-961; DL-999 (a), (g)): the cut stops, naming each field that differs, when the
//                    build no longer gives them.
//   trade/<id>.json  every trade overlay the build holds, byte for byte (K-01 tradeOverlay under .../trade/<id>), which
//                    must be bundle v2's overlays byte for byte.
//   manifest.json    the build's manifest (inputs, prompts, models, policy, shared lists, built at, compiler) with
//                    partial: true; its storage, flow/A and every trade, each as the build lists it; its lint summary,
//                    every rule the emitter's marks and T-160's lint (compiler/src/lint/report.ts) ran, counted on the
//                    eleven steps, in the master's flow A and in every trade's; no journey, as bundles v0 to v2 list
//                    none; its fixed lines, bundle v2's byte for byte (compiler/src/fixed-lines buildFixedLines() for
//                    staging's base path /test, with SIGN_UP_OPENER last); and its bundle id, the content hash of its
//                    stored values with build BUILD (T-150's numberBundle). The prompts, models and policy the build
//                    copied from prompts.json and models.json must be bundle v2's manifest's.
// Nothing reads a clock: the same full build gives the same bytes.
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUNDLE_DIR as V2_DIR,
  MODELS_FILE as V2_MODELS_FILE,
  PROMPTS_FILE as V2_PROMPTS_FILE,
  PROMPT_KINDS,
  ROOT,
  SIGN_UP_OPENER,
  STEPS as V2_STEPS,
  V0_DIR,
  V11_DIR,
  V1_DIR,
  fixedLinesOfStaging,
  label,
  load,
  promptsFromModules,
  sha256,
  stepDifferences,
  withSignUpOpener,
} from "../v2/build.mjs";

export {
  PROMPT_KINDS,
  ROOT,
  SIGN_UP_OPENER,
  V0_DIR,
  V11_DIR,
  V1_DIR,
  V2_DIR,
  V2_MODELS_FILE,
  V2_PROMPTS_FILE,
  V2_STEPS,
  fixedLinesOfStaging,
  label,
  load,
  promptsFromModules,
  sha256,
  stepDifferences,
  withSignUpOpener,
};

/** bundles/v3/. */
export const HERE = dirname(fileURLToPath(import.meta.url));

/** The bundle folder this script writes, its KV bulk file (the publish's default), and the two files run 1 writes. */
export const BUNDLE_DIR = join(HERE, "bundle");
export const KV_FILE = `${BUNDLE_DIR}.kv.json`;
export const PROMPTS_FILE = join(HERE, "prompts.json");
export const MODELS_FILE = join(HERE, "models.json");

/**
 * The three steps bundle v3 adds (MASTER-FLOW-A.md:136-188): S1-77, the helper's branch's own step; S1-76, the no-match
 * branch's; and S1-10, where every S1-09 branch rejoins (S1-09.next).
 */
export const NEW_STEPS = ["S1-77", "S1-76", "S1-10"];

/** What bundle v3 holds: these steps of this flow (card 4 of rule-s1-09.json), and every trade's overlay. */
export const FLOW = "A";
export const STEPS = [...V2_STEPS, ...NEW_STEPS];

/**
 * The build number of v3's id (K-01 manifest.bundleId.build counts publishes from 1): its first publish. Its flow A holds
 * three steps more than bundle v2's, so its content hash is new and no earlier bundle has its keys.
 */
export const BUILD = 1;

/** The environment bundle v3 is for (staging: the user's `deploy:staging -- --bundle bundles/v3`). */
export const ENVIRONMENT = "staging";

function fail(message) {
  throw new Error(message);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- 1. the prompts ---------------------------------------------------------------------------------------------

/**
 * Where the prompts a prompts.json file gives differ from what their own modules give today (version and text), each
 * kind once; none: they are the modules' own.
 */
export async function promptsNotAsModules(file) {
  const given = await promptsFromModules();
  return PROMPT_KINDS.filter(
    (kind) => file[kind]?.version !== given[kind].prompt.version || file[kind]?.text !== given[kind].prompt.text,
  );
}

async function writePrompts() {
  const v2 = JSON.parse(readFileSync(V2_PROMPTS_FILE, "utf8"));
  const differ = await promptsNotAsModules(v2);
  if (differ.length > 0)
    fail(`bundles/v2/prompts.json's ${differ.join(", ")} is not what its module gives today: bundle v3 carries v2's prompts`);
  copyFileSync(V2_PROMPTS_FILE, PROMPTS_FILE);
  copyFileSync(V2_MODELS_FILE, MODELS_FILE);
  for (const kind of PROMPT_KINDS)
    console.log(`prompt ${kind}: ${String(v2[kind].version)}, sha256 ${sha256(v2[kind].text)}, as its module gives it`);
  console.log(`wrote ${PROMPTS_FILE}, bundle v2's ${V2_PROMPTS_FILE} byte for byte`);
  console.log(`wrote ${MODELS_FILE}, bundle v2's ${V2_MODELS_FILE} byte for byte`);
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
 * Bundle v3 cut from the full build in `full` (see the top of this file): its K-01 root, its files, and what the cut
 * found on the way (the lint run, the full build's id, bundle v2's id, the base path).
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

  // Bundle v2, read back and checked: v3 holds its eight steps, its overlays and its manifest lines.
  const v2Read = readSound(emit, ids, V2_DIR, "bundle v2");
  const v2 = v2Read.bundle;

  // The prompts, models and routing the build copied from prompts.json and models.json: bundle v2's.
  for (const kind of PROMPT_KINDS)
    if (!same(manifest.prompts[kind], v2.manifest.prompts[kind]))
      fail(`the full build's prompt ${kind} is not bundle v2's: build it with --prompts ${PROMPTS_FILE}`);
  if (!same(manifest.models, v2.manifest.models) || !same(manifest.policy, v2.manifest.policy))
    fail(`the full build's models or routing are not bundle v2's: build it with --models ${MODELS_FILE}`);

  // The fixed lines: bundle v2's, which are compiler/src/fixed-lines's for staging with signUpOpener last.
  if (!same(v2.manifest.lists.fixedLines, withSignUpOpener(staging)))
    fail(`bundle v2's fixed lines are not compiler/src/fixed-lines's for ${ENVIRONMENT} today with signUpOpener last`);
  const fixedLines = structuredClone(v2.manifest.lists.fixedLines);

  // Every trade overlay: the build's, which must be bundle v2's byte for byte.
  const v2Trades = new Map(v2Read.files.filter((file) => file.path.startsWith("trade/")).map((f) => [f.path, f.text]));
  const otherTrades = tradeFiles.filter((file) => v2Trades.get(file.path) !== file.text).map((file) => file.path);
  if (otherTrades.length > 0 || v2Trades.size !== tradeFiles.length)
    fail(`NEED: the whole build's trade overlays are not bundle v2's: ${otherTrades.slice(0, 5).join(", ") || "another set"}`);

  // T-160's lint of the master's flows and of every trade's flows the bundle holds, as the build reads them (Master
  // Corrections applied): the failures of the eleven steps in flow A, the master's and each trade's.
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
  for (const id of V2_STEPS) {
    const differ = stepDifferences(steps[id], v2.flows[FLOW]?.steps?.[id]);
    if (differ.length > 0)
      fail(
        `NEED: the whole build no longer gives bundle v2's bytes for ${id} (a question asked under it keeps its options): ${differ.join("; ")}`,
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
    v2Id: v2.manifest.bundleId,
    basePath,
    tradeIds,
  };
}

/**
 * Before a cut with --replace: the bundle bundles/v3 holds now, if any, and whether the new cut may take its place. The
 * same bundle id with other bytes is refused (K-01 "Storage": keys are written once per bundle id); another id, or the
 * same bytes, may.
 */
function replaceable(emit, ids, cut) {
  if (!existsSync(BUNDLE_DIR) || readdirSync(BUNDLE_DIR).length === 0) return null;
  const old = emit.readBundleDir(BUNDLE_DIR);
  const id = old.bundle.manifest.bundleId;
  const sameId = id.hash === cut.bundleId.hash && id.build === cut.bundleId.build;
  if (sameId) {
    const byPath = new Map(cut.files.map((file) => [file.path, file.text]));
    const changed = old.files.filter((file) => byPath.get(file.path) !== file.text).map((file) => file.path);
    if (changed.length > 0 || old.files.length !== cut.files.length)
      fail(
        `bundles/v3 holds bundle ${label(id)} with other bytes (${changed.join(", ") || "other files"}): a bundle with other bytes takes another build number (BUILD in this file)`,
      );
  }
  return ids.keyPrefix(id);
}

async function writeCut(fullArg, replace) {
  if (fullArg === undefined) fail("usage: node bundles/v3/build.mjs cut <full build folder> [--replace]");
  const full = isAbsolute(fullArg) ? fullArg : resolve(process.cwd(), fullArg);
  if (!replace && existsSync(BUNDLE_DIR) && readdirSync(BUNDLE_DIR).length > 0)
    fail(`${BUNDLE_DIR} is not empty: a bundle is written into a new or empty folder (--replace cuts bundle v3 anew)`);
  const emit = await load("compiler/src/emit/index.ts");
  const ids = await load("compiler/src/bundle-id/index.ts");
  const cut = await cutBundle(full);
  const replaced = replace ? replaceable(emit, ids, cut) : null;
  if (replaced !== null) {
    // Bundle v3's own folder and its KV bulk file only: the publish writes the new KV file for the new id.
    rmSync(BUNDLE_DIR, { recursive: true });
    rmSync(KV_FILE, { force: true });
    console.log(`replaced the bundle bundles/v3 held (${replaced}) and its KV bulk file ${KV_FILE}`);
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
    `bundle v3: ${label(cut.bundleId)}, flow ${FLOW} steps ${Object.keys(back.bundle.flows[FLOW].steps).join(", ")}, and ${String(cut.tradeIds.length)} trade overlays, partial`,
  );
  console.log(`${V2_STEPS.join(", ")} are bundle v2 ${label(cut.v2Id)}'s byte for byte, lint included (${V2_DIR})`);
  console.log(
    `T-160's lint of the master's flows and ${String(cut.lintedTrades)} trades' flows (${String(cut.ruleCount)} K-01 rules run): ${String(cut.linted.length)} failures on ${STEPS.join(", ")}`,
  );
  const manifest = back.bundle.manifest;
  console.log(
    `prompts, models and routing: bundle v2 ${label(cut.v2Id)}'s (${PROMPT_KINDS.map((kind) => `${kind} ${manifest.prompts[kind].version}`).join(", ")})`,
  );
  const lines = manifest.lists.fixedLines.lines;
  console.log(
    `fixed lines: bundle v2's (compiler/src/fixed-lines for ${ENVIRONMENT}, BASE_PATH ${cut.basePath || '""'}, and ${SIGN_UP_OPENER.id} last), ${String(lines.length)} lines`,
  );
  const tradeBytes = back.files
    .filter((file) => file.path.startsWith("trade/"))
    .reduce((sum, file) => sum + emit.byteLength(file.text), 0);
  for (const file of back.files)
    if (!file.path.startsWith("trade/"))
      console.log(`wrote ${file.path} (${String(emit.byteLength(file.text))} bytes, sha256 ${sha256(file.text)})`);
  console.log(
    `wrote ${String(cut.tradeIds.length)} trade overlays in trade/ (${String(tradeBytes)} bytes), each the build's and bundle v2's byte for byte`,
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
    console.error("usage: node bundles/v3/build.mjs prompts | cut <full build folder> [--replace]");
    process.exitCode = 2;
  } else {
    run.catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
