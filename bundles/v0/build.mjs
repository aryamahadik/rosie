// Bundle v0 for the walking skeleton (T-163; D-007; C-058, C-072; K-01 v1): S1-01 and S1-02 of flow A, nothing else.
//
// It is made in three runs, from the repository root:
//
//   1. node bundles/v0/build.mjs prompts
//        writes bundles/v0/prompts.json, the file `compiler build --prompts` reads: each prompt one turn runs on, its
//        version and text as its own module gives it (the AI engineer's, C-119): ai/src/safety/prompt.ts
//        SAFETY_READ_PROMPT (T-365), ai/src/decide/prompt.ts DECIDE_PROMPT (T-368) and ai/src/composer/prompt/prompt.ts
//        COMPOSER_PROMPT (T-372). No planner prompt exists yet, so the planner's is K-01 v1's sample one
//        (contracts/bundle/fixtures/manifest.json), the build's own stand-in.
//   2. npm run cli -w @rosie/compiler -- build --out <full> --build 1 --built-at <utc>
//        --prompts bundles/v0/prompts.json --models bundles/v0/models.json
//        the compiler's whole build of fixture set v1 (T-149, T-150): both flows and every trade, Master Corrections in
//        the run's order (T-1132), so each message carries the opt-out marker every trade's walks give it (T-1116,
//        T-141, Q-30). models.json is Q-26's routing with the two model ids the router accepts (T-363, DL-318).
//   3. node bundles/v0/build.mjs cut <full>
//        writes bundles/v0/bundle/, bundle v0 (below), into a new or empty folder, and checks it as `compiler build`
//        checks what it writes.
// Then `npm run cli -w @rosie/compiler -- publish bundles/v0/bundle` (T-152) writes PostgreSQL's copy and the KV bulk
// file bundles/v0/bundle.kv.json, and bundles/v0/check.mjs proves the card's checks.
//
// What the cut keeps, and the only things it writes itself (the bundle as bundle-v0-skeleton.json shapes it):
//   flow/A.json     the build's flow A graph as compiled, its steps cut to S1-01 and S1-02, each byte for byte the
//                   build's but its `lint`: the rules it fails, its own marks with T-160's for it (none today). Its
//                   sections, routing tables, record and the rest are the build's: they name the master's steps, and a
//                   step the bundle does not hold is not reachable (K-01 README, "Fixtures"; manifest.partial).
//   manifest.json   the build's manifest (inputs, prompts, models, policy, shared lists, built at, compiler) with
//                   partial: true; its storage, flow/A alone; its lint summary, every rule the emitter's marks and T-160's
//                   lint (compiler/src/lint/report.ts) ran, counted on the two steps; no journey, as the emitter writes
//                   none and the skeleton lists none; and its bundle id, the content hash of its one stored value with
//                   build 1 (T-150's numberBundle).
// Nothing reads a clock: the same full build gives the same bytes.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** bundles/v0/, and the repository root. */
export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "..", "..");

/** The bundle folder this script writes, and the prompts file it writes for `compiler build --prompts`. */
export const BUNDLE_DIR = join(HERE, "bundle");
export const PROMPTS_FILE = join(HERE, "prompts.json");

/** What bundle v0 holds: these steps of this flow (D-007; BP section 10, D-017's card). */
export const FLOW = "A";
export const STEPS = ["S1-01", "S1-02"];

/** The build number of v0's id: its first publish (K-01 manifest.bundleId.build counts publishes from 1). */
export const BUILD = 1;

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
      from: "ai/src/composer/prompt/prompt.ts COMPOSER_PROMPT (T-372)",
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

/** Bundle v0 cut from the full build in `full` (see the top of this file): its K-01 root and its two files. */
export async function cutBundle(full) {
  const emit = await load("compiler/src/emit/index.ts");
  const ids = await load("compiler/src/bundle-id/index.ts");
  const lint = await load("compiler/src/lint/report.ts");
  const flows = await load("compiler/src/load/flow.ts");

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

  // T-160's lint of the master's flows as the build reads them (Master Corrections applied; v0 holds no trade): the
  // failures of the steps v0 holds.
  const run = lint.lintMasterAndTrades(flows.loadMaster(), []);
  const report = lint.lintReport(run.results);
  const linted = report.failures.filter(
    (failure) => failure.flow === FLOW && failure.trade === null && STEPS.includes(failure.step),
  );

  const order = emit.lintRuleOrder();
  const steps = {};
  for (const id of STEPS) {
    const step = structuredClone(graph.steps[id]);
    step.lint = inOrder(order, [
      ...step.lint,
      ...linted.filter((failure) => failure.step === id).map((failure) => failure.rule),
    ]);
    steps[id] = step;
  }
  const flow = { ...graph, steps };
  const failures = STEPS.flatMap((id) =>
    steps[id].lint.map((rule) => {
      const found = linted.find((failure) => failure.step === id && failure.rule === rule);
      return found ?? { rule, flow: FLOW, step: id, trade: null, message: `${id} fails ${rule}` };
    }),
  );
  const rules = inOrder(order, [
    ...manifest.lint.rules.map((entry) => entry.rule),
    ...report.rules.map((entry) => entry.rule),
  ]);

  const text = JSON.stringify(flow);
  const provisional = { ...ids.PROVISIONAL_BUNDLE_ID };
  const prefix = ids.keyPrefix(provisional);
  const cut = structuredClone(manifest);
  cut.bundleId = provisional;
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
    ],
  };
  cut.partial = true;
  const bundle = { manifest: cut, flows: { [FLOW]: flow }, trades: {} };
  const refused = emit.checkBundlePart(bundle);
  if (refused.length > 0) fail(`the cut bundle is not K-01 v1's: ${refused.slice(0, 5).join("; ")}`);
  const files = [
    { path: `flow/${FLOW}.json`, text },
    { path: "manifest.json", text: JSON.stringify(cut) },
  ];
  const numbered = ids.numberBundle({ bundle, files }, BUILD);
  return { ...numbered, linted, ruleCount: report.rules.length, fullId: manifest.bundleId };
}

async function writeCut(fullArg) {
  if (fullArg === undefined) fail("usage: node bundles/v0/build.mjs cut <full build folder>");
  const full = isAbsolute(fullArg) ? fullArg : resolve(process.cwd(), fullArg);
  if (existsSync(BUNDLE_DIR) && readdirSync(BUNDLE_DIR).length > 0)
    fail(`${BUNDLE_DIR} is not empty: a bundle is written into a new or empty folder`);
  const emit = await load("compiler/src/emit/index.ts");
  const ids = await load("compiler/src/bundle-id/index.ts");
  const cut = await cutBundle(full);
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
  console.log(`bundle v0: ${cut.bundleId.hash}/${String(cut.bundleId.build)}, flow ${FLOW} steps ${STEPS.join(", ")}, partial`);
  console.log(
    `T-160's lint of the master's flows (${String(cut.ruleCount)} K-01 rules run): ${String(cut.linted.length)} failures on ${STEPS.join(", ")}`,
  );
  for (const file of back.files)
    console.log(`wrote ${file.path} (${String(emit.byteLength(file.text))} bytes, sha256 ${sha256(file.text)})`);
  console.log(
    `read back from ${BUNDLE_DIR} and validated against K-01 v1; its bundle id is the content hash of its stored value`,
  );
}

// ---- the command line -------------------------------------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const run = command === "prompts" ? writePrompts() : command === "cut" ? writeCut(rest[0]) : null;
  if (run === null) {
    console.error("usage: node bundles/v0/build.mjs prompts | cut <full build folder>");
    process.exitCode = 2;
  } else {
    run.catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
