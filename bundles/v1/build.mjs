// Bundle v1 for the sign-up chain's next steps (T-1460; DL-961 ruling 1; C-058, C-072; K-01 v1): flow A's S1-01,
// S1-02, S1-11, S1-04, S1-03 and S1-74, and every trade's plug-in overlay, so the walk from S1-02's answer finds the
// steps it walks to (S1-11, then S1-04's question; S1-03 and S1-74 for the other two branches) and S1-11 can load any
// listed kind's 11 pf blocks from the pinned bundle (T-634).
//
// It is made in three runs, from the repository root, as bundles/v0/build.mjs makes bundle v0:
//
//   1. node bundles/v1/build.mjs prompts
//        writes bundles/v1/prompts.json, the file `compiler build --prompts` reads: each prompt one turn runs on, its
//        version and text as its own module gives it (the AI engineer's, C-119): ai/src/safety/prompt.ts
//        SAFETY_READ_PROMPT (T-365), ai/src/decide/prompt.ts DECIDE_PROMPT (T-368) and ai/src/composer/prompt/prompt.ts
//        COMPOSER_PROMPT (T-372, composer-4: T-375). No planner prompt exists yet, so the planner's is K-01 v1's sample
//        one (contracts/bundle/fixtures/manifest.json), the build's own stand-in. These are bundle v0 …/2's prompts
//        (T-1146): bundles/v1/check.mjs holds the two equal.
//   2. npm run cli -w @rosie/compiler -- build --out <full> --build 1 --built-at <utc>
//        --prompts bundles/v1/prompts.json --models bundles/v1/models.json
//        the compiler's whole build of fixture set v1 (T-149, T-150): both flows and every trade, Master Corrections in
//        the run's order (T-1132), each message carrying the opt-out marker every trade's walks give it (T-1116, T-141,
//        Q-30), and each trade's overlay with C5's fills (insurance's facts; the 12 trades with no pf.settings at arrive
//        window and an empty cutoff). models.json is bundle v0's: Q-26's routing with the two model ids the router
//        accepts (T-363, DL-318).
//   3. node bundles/v1/build.mjs cut <full> [--replace]
//        writes bundles/v1/bundle/, bundle v1 (below), into a new or empty folder, and checks it as `compiler build`
//        checks what it writes. --replace cuts bundle v1 anew over the one bundles/v1 holds: that folder and its KV bulk
//        file bundles/v1/bundle.kv.json are removed first, and the cut is refused if it would give the same bundle id
//        with other bytes (K-01 "Storage": keys are written once per bundle id).
// Then `npm run cli -w @rosie/compiler -- publish bundles/v1/bundle` (T-152) writes PostgreSQL's copy and the KV bulk
// file bundles/v1/bundle.kv.json, and bundles/v1/check.mjs proves the card's checks.
//
// What the cut keeps, and the only things it writes itself (K-01 v1 "Storage": one manifest, one graph per flow, one
// overlay per trade, each its own value under the bundle id):
//   flow/A.json      the build's flow A graph as compiled, its steps cut to S1-01, S1-02, S1-11, S1-04, S1-03 and S1-74
//                    in the build's page order, each byte for byte the build's but its `lint`: the rules it fails, its
//                    own marks with T-160's for it (none today). Its sections, routing tables, record and the rest are the
//                    build's: they name the master's steps, and a step the bundle does not hold is not reachable (K-01
//                    README, "Fixtures"; manifest.partial). S1-01 and S1-02 must be bundle v0 …/2's byte for byte (card,
//                    words, branches, options and their order), so a question asked under v0 keeps its options (DL-961):
//                    the cut stops, naming each field that differs, when the build no longer gives them.
//   trade/<id>.json  every trade overlay the build holds, byte for byte (K-01 tradeOverlay under .../trade/<id>): its
//                    trade, facts, the 11 pf text blocks whole (MC R3), and its two flows, with C5's fills applied at
//                    compile time. A partial bundle may hold trades (K-01 v1 manifest.partial; the sample bundles do).
//   manifest.json    the build's manifest (inputs, prompts, models, policy, shared lists, built at, compiler) with
//                    partial: true; its storage, flow/A and every trade, each as the build lists it; its lint summary,
//                    every rule the emitter's marks and T-160's lint (compiler/src/lint/report.ts) ran, counted on the
//                    six steps, in the master's flow A and in every trade's; no journey, as the emitter writes none and
//                    bundle v0 lists none; its fixed lines, compiler/src/fixed-lines's list for staging (below); and its
//                    bundle id, the content hash of its stored values with build BUILD (T-150's numberBundle).
// Its fixed lines are bundle v0 …/2's (T-1146; Q-30): compiler/src/fixed-lines buildFixedLines() for staging's base path
// (wrangler.jsonc env.staging BASE_PATH, /test), in place of the build's lists.fixedLines, which no module gives the
// emitter yet (K-01 v1's fixture as its stand-in, emit/standins.ts): K-01 v1's accepted lines unchanged, then optOutLine
// in Spanish (msgtext.js line 32) and privacyLink, Q-30's default stand-in naming the privacy notice at
// rosfield.com/test/privacy. Bundle v1 is staging's (card G: the release engineer sets it active there), hence staging's
// address. Nothing reads a clock: the same full build gives the same bytes.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** bundles/v1/, and the repository root. */
export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "..", "..");

/** The bundle folder this script writes, its KV bulk file (the publish's default), and the prompts file it writes. */
export const BUNDLE_DIR = join(HERE, "bundle");
export const KV_FILE = `${BUNDLE_DIR}.kv.json`;
export const PROMPTS_FILE = join(HERE, "prompts.json");

/** Bundle v0 …/2's folder (T-163, T-1146), read only: S1-01 and S1-02 must be its bytes. */
export const V0_DIR = join(ROOT, "bundles", "v0", "bundle");

/** What bundle v1 holds: these steps of this flow (DL-961 ruling 1; T-1460), and every trade's overlay. */
export const FLOW = "A";
export const STEPS = ["S1-01", "S1-02", "S1-11", "S1-04", "S1-03", "S1-74"];

/** The steps bundle v0 …/2 holds, which bundle v1 holds byte for byte (DL-961: a question asked under v0 keeps its options). */
export const V0_STEPS = ["S1-01", "S1-02"];

/**
 * The build number of v1's id (K-01 manifest.bundleId.build counts publishes from 1): its first publish. Its content
 * hash is new (flow A holds six steps and every trade's overlay rides beside it), so no earlier bundle has its keys.
 */
export const BUILD = 1;

/** The environment bundle v1 is for (card G: staging), whose base path the privacy link's address sits under. */
export const ENVIRONMENT = "staging";

const PROMPT_KINDS = ["safetyRead", "decide", "planner", "composer"];

/** A repository file as an import URL. */
export function at(path) {
  return pathToFileURL(join(ROOT, ...path.split("/"))).href;
}

let hooked = false;

/**
 * Lets Node complete the repository's extensionless relative imports from a .ts file (`./core` is `./core.ts`,
 * `../path` `../path/index.ts`), as compiler/src/cli/commands/build.ts does for the compiler's own commands.
 */
export function completeImports() {
  if (hooked) return;
  hooked = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        const parent = context.parentURL ?? "";
        const relative = specifier.startsWith("./") || specifier.startsWith("../");
        if (!relative || !parent.startsWith("file:") || !parent.endsWith(".ts")) throw error;
        for (const suffix of [".ts", "/index.ts"]) {
          try {
            return nextResolve(`${specifier}${suffix}`, context);
          } catch {
            // not this form: try the next one
          }
        }
        throw error;
      }
    },
  });
}

/** A repository module, loaded once the resolve hook is in place. */
export async function load(path) {
  completeImports();
  return import(at(path));
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function fail(message) {
  throw new Error(message);
}

// ---- 1. the prompts ---------------------------------------------------------------------------------------------

/** Each prompt as the bundle packs it: the AI layer's own constants, and K-01's sample for the planner. */
export async function promptsFromModules() {
  const safety = await load("ai/src/safety/prompt.ts");
  const decide = await load("ai/src/decide/prompt.ts");
  const composer = await load("ai/src/composer/prompt/prompt.ts");
  const sample = JSON.parse(readFileSync(join(ROOT, "contracts/bundle/fixtures/manifest.json"), "utf8")).prompts;
  const given = {
    safetyRead: { prompt: safety.SAFETY_READ_PROMPT, from: "ai/src/safety/prompt.ts SAFETY_READ_PROMPT (T-365)" },
    decide: { prompt: decide.DECIDE_PROMPT, from: "ai/src/decide/prompt.ts DECIDE_PROMPT (T-368)" },
    planner: {
      prompt: { ...sample.planner, sha256: sha256(sample.planner.text) },
      from: "contracts/bundle/fixtures/manifest.json prompts.planner (K-01 v1's sample: no planner prompt exists yet)",
    },
    composer: {
      prompt: composer.COMPOSER_PROMPT,
      from: "ai/src/composer/prompt/prompt.ts COMPOSER_PROMPT (T-372; composer-4, T-375)",
    },
  };
  for (const kind of PROMPT_KINDS) {
    const { prompt, from } = given[kind];
    if (typeof prompt?.version !== "string" || typeof prompt.text !== "string" || prompt.text === "")
      fail(`${from}: no version and text`);
    if (prompt.sha256 !== sha256(prompt.text)) fail(`${from}: its sha256 is not its text's`);
  }
  return given;
}

async function writePrompts() {
  const given = await promptsFromModules();
  const file = {};
  for (const kind of PROMPT_KINDS) file[kind] = { version: given[kind].prompt.version, text: given[kind].prompt.text };
  writeFileSync(PROMPTS_FILE, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  for (const kind of PROMPT_KINDS) {
    const { prompt, from } = given[kind];
    console.log(`prompt ${kind}: ${prompt.version}, sha256 ${prompt.sha256}, from ${from}`);
  }
  console.log(`wrote ${PROMPTS_FILE}`);
}

// ---- 3. the cut -------------------------------------------------------------------------------------------------

/** The rules a step fails, as K-01 orders them: its own marks and the lint's. */
function inOrder(order, rules) {
  const set = new Set(rules);
  const unknown = [...set].filter((rule) => !order.includes(rule));
  if (unknown.length > 0) fail(`not K-01 v1 lint rules: ${unknown.join(", ")}`);
  return order.filter((rule) => set.has(rule));
}

/**
 * Bundle v1's fixed lines, bundle v0 …/2's (see the top of this file): compiler/src/fixed-lines buildFixedLines() for
 * the base path wrangler.jsonc gives ENVIRONMENT, with that base path.
 */
export async function fixedLinesOfStaging() {
  const fixed = await load("compiler/src/fixed-lines/index.ts");
  const basePath = fixed.readBasePath(ENVIRONMENT);
  return { basePath, fixedLines: fixed.buildFixedLines({ basePath }) };
}

/** A value's text, cut short for a line that names a difference. */
function excerpt(value) {
  const text = value === undefined ? "(none)" : JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

/** Where two steps differ, field by field (the keys and their order, then each field's bytes); none when equal. */
export function stepDifferences(ours, theirs) {
  if (JSON.stringify(ours) === JSON.stringify(theirs)) return [];
  const keysA = Object.keys(ours ?? {});
  const keysB = Object.keys(theirs ?? {});
  const out = [];
  if (JSON.stringify(keysA) !== JSON.stringify(keysB))
    out.push(`its fields are ${keysA.join(", ")}; bundle v0's are ${keysB.join(", ")}`);
  for (const key of [...new Set([...keysB, ...keysA])])
    if (JSON.stringify(ours?.[key]) !== JSON.stringify(theirs?.[key]))
      out.push(`${key}: the build gives ${excerpt(ours?.[key])}, bundle v0 has ${excerpt(theirs?.[key])}`);
  return out;
}

/**
 * Bundle v1 cut from the full build in `full` (see the top of this file): its K-01 root, its files, and what the cut
 * found on the way (the lint run, the full build's id, the fixed lines' base path).
 */
export async function cutBundle(full) {
  const emit = await load("compiler/src/emit/index.ts");
  const ids = await load("compiler/src/bundle-id/index.ts");
  const lint = await load("compiler/src/lint/report.ts");
  const { basePath, fixedLines } = await fixedLinesOfStaging();

  // The full build, read back and checked as `compiler build --build <n>` and the publish check it.
  const problems = emit.checkBundleDir(full);
  if (problems.length > 0) fail(`${full} is not a sound bundle: ${problems.slice(0, 5).join("; ")}`);
  const read = emit.readBundleDir(full);
  const idProblems = ids.bundleIdProblems(read.bundle.manifest);
  if (idProblems.length > 0) fail(`${full}: its bundle id does not hold (${idProblems.join("; ")})`);
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

  // Bundle v0 …/2, read back and checked: S1-01 and S1-02 must be its bytes.
  const v0Problems = emit.checkBundleDir(V0_DIR);
  if (v0Problems.length > 0) fail(`${V0_DIR} is not a sound bundle: ${v0Problems.slice(0, 5).join("; ")}`);
  const v0 = emit.readBundleDir(V0_DIR).bundle;

  // T-160's lint of the master's flows and of every trade's flows the bundle holds, as the build reads them (Master
  // Corrections applied): the failures of the six steps in flow A, the master's and each trade's.
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
  for (const id of V0_STEPS) {
    const differ = stepDifferences(steps[id], v0.flows[FLOW]?.steps?.[id]);
    if (differ.length > 0)
      fail(
        `NEED: the whole build no longer gives bundle v0 …/2's bytes for ${id} (DL-961: a question asked under v0 keeps its options): ${differ.join("; ")}`,
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
  const fullLines = manifest.lists.fixedLines.lines.length;
  return {
    ...numbered,
    linted,
    ruleCount: report.rules.length,
    lintedTrades: (run.results.length - 2) / 2,
    fullId: manifest.bundleId,
    v0Id: v0.manifest.bundleId,
    basePath,
    fullLines,
    tradeIds,
  };
}

/**
 * Before a cut with --replace: the bundle bundles/v1 holds now, if any, and whether the new cut may take its place. The
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
        `bundles/v1 holds bundle ${id.hash}/${String(id.build)} with other bytes (${changed.join(", ") || "other files"}): a bundle with other bytes takes another build number (BUILD in this file)`,
      );
  }
  return ids.keyPrefix(id);
}

async function writeCut(fullArg, replace) {
  if (fullArg === undefined) fail("usage: node bundles/v1/build.mjs cut <full build folder> [--replace]");
  const full = isAbsolute(fullArg) ? fullArg : resolve(process.cwd(), fullArg);
  if (!replace && existsSync(BUNDLE_DIR) && readdirSync(BUNDLE_DIR).length > 0)
    fail(`${BUNDLE_DIR} is not empty: a bundle is written into a new or empty folder (--replace cuts bundle v1 anew)`);
  const emit = await load("compiler/src/emit/index.ts");
  const ids = await load("compiler/src/bundle-id/index.ts");
  const cut = await cutBundle(full);
  const replaced = replace ? replaceable(emit, ids, cut) : null;
  if (replaced !== null) {
    // Bundle v1's own folder and its KV bulk file only: the publish writes the new KV file for the new id.
    rmSync(BUNDLE_DIR, { recursive: true });
    rmSync(KV_FILE, { force: true });
    console.log(`replaced the bundle bundles/v1 held (${replaced}) and its KV bulk file ${KV_FILE}`);
  }
  emit.writeBundle(BUNDLE_DIR, cut.files);

  // Read back from disk, as `compiler build --build <n>` checks what it wrote.
  const problems = emit.checkBundleDir(BUNDLE_DIR);
  const back = emit.readBundleDir(BUNDLE_DIR);
  problems.push(...ids.bundleIdProblems(back.bundle.manifest));
  const hash = ids.contentHashOfFiles(back.files);
  if (hash !== cut.bundleId.hash) problems.push(`the content hash of the files read back is ${hash}`);
  if (problems.length > 0) fail(`the bundle written to ${BUNDLE_DIR} is not sound: ${problems.join("; ")}`);

  const { hash: fullHash, build: fullBuild } = cut.fullId;
  console.log(`cut from the full build ${fullHash}/${String(fullBuild)} in ${full}`);
  console.log(
    `bundle v1: ${cut.bundleId.hash}/${String(cut.bundleId.build)}, flow ${FLOW} steps ${Object.keys(back.bundle.flows[FLOW].steps).join(", ")}, and ${String(cut.tradeIds.length)} trade overlays, partial`,
  );
  console.log(
    `${V0_STEPS.join(" and ")} are bundle v0 ${cut.v0Id.hash}/${String(cut.v0Id.build)}'s byte for byte (${V0_DIR})`,
  );
  console.log(
    `T-160's lint of the master's flows and ${String(cut.lintedTrades)} trades' flows (${String(cut.ruleCount)} K-01 rules run): ${String(cut.linted.length)} failures on ${STEPS.join(", ")}`,
  );
  const lines = back.bundle.manifest.lists.fixedLines.lines;
  const privacy = lines.find((line) => line.id === "privacyLink");
  console.log(
    `fixed lines: compiler/src/fixed-lines for ${ENVIRONMENT} (BASE_PATH ${cut.basePath || '""'}), ${String(lines.length)} lines in place of the build's ${String(cut.fullLines)}: ${lines.map((line) => `${line.id} (${line.lang})`).join(", ")}; privacyLink "${String(privacy?.text)}"`,
  );
  const tradeBytes = back.files
    .filter((file) => file.path.startsWith("trade/"))
    .reduce((sum, file) => sum + emit.byteLength(file.text), 0);
  for (const file of back.files)
    if (!file.path.startsWith("trade/"))
      console.log(`wrote ${file.path} (${String(emit.byteLength(file.text))} bytes, sha256 ${sha256(file.text)})`);
  console.log(`wrote ${String(cut.tradeIds.length)} trade overlays in trade/ (${String(tradeBytes)} bytes), each the build's byte for byte`);
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
    console.error("usage: node bundles/v1/build.mjs prompts | cut <full build folder> [--replace]");
    process.exitCode = 2;
  } else {
    run.catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
