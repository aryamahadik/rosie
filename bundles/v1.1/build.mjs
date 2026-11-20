// Bundle v1.1 (T-1501; DL-1018 card 3; K-01 v1): bundle v1 byte for byte with decide-2 as its decide prompt, so a turn
// that pins it reads a typed answer with decide-2's rules (T-1500: ai/src/decide/prompt.ts DECIDE_2_PROMPT), while every
// step, word, branch and overlay stays bundle v1's. A turn takes its prompt and its cards from the bundle it pins, and a
// card must equal the pinned bundle's copy or the read throws (ai/src/cache/layout.ts lines 196-200, 225-229); an open
// question's options come from the bundle it was asked under (actions/src/frontier/sources/open-questions lines 91-126).
// So only a prompt-only cut is safe: a question asked under bundle v0 or v1 keeps its options and its card (DL-961; K-09
// v1.11 default 188). It is named v1.1, not v2, because frozen K-09 text and the board call T-1477's later cut "bundle
// v2" (DL-1018), and that cut must carry decide-2 too.
//
// It is made in two runs, from the repository root:
//
//   1. node bundles/v1.1/build.mjs prompts
//        writes bundles/v1.1/prompts.json, each prompt bundle v1.1 packs, its version and text as its own module gives
//        it: bundle v1's (bundles/v1/build.mjs promptsFromModules: SAFETY_READ_PROMPT, the planner's stand-in and
//        COMPOSER_PROMPT) but decide, which is ai/src/decide/prompt.ts DECIDE_2_PROMPT (decide-2, T-1500) in place of
//        DECIDE_PROMPT (decide-1); and bundles/v1.1/models.json, bundle v1's models.json byte for byte.
//   2. node bundles/v1.1/build.mjs cut [--replace]
//        writes bundles/v1.1/bundle/, bundle v1.1 (below), from bundle v1's folder bundles/v1/bundle/ and prompts.json,
//        into a new or empty folder, and checks it as `compiler build` checks what it writes. --replace makes bundle v1.1
//        anew over the one bundles/v1.1 holds: that folder and its KV bulk file bundles/v1.1/bundle.kv.json are removed
//        first, and it is refused if it would give the same bundle id with other bytes (K-01 "Storage": keys are written
//        once per bundle id).
// Then `npm run cli -w @rosie/compiler -- publish bundles/v1.1/bundle` (T-152) writes PostgreSQL's copy and the KV bulk
// file bundles/v1.1/bundle.kv.json, and bundles/v1.1/check.mjs proves the card's checks. On staging the deploy publishes
// it and makes it active (`npm run deploy:staging -- --bundle bundles/v1.1`, step 3: infra/scripts/publish-bundle.sh).
//
// Why derived from bundle v1 and not built anew: nothing the compiler compiles changes. K-01 v1's bundle id hashes the
// stored values alone (the flow graph and the trade overlays, never the manifest: compiler/src/bundle-id/content-hash.ts),
// and the prompts sit in the manifest alone, which the compiler's build copies from prompts.json. So the whole build with
// decide-2 would give bundle v1's stored values and bundle v1's manifest but prompts.decide; reading them from bundle v1,
// whose checks (bundles/v1/check.mjs) hold them to the whole build, the master's step.js and bundle v0, gives those
// bytes without the whole build (minutes, and a master copy) and cannot drift from bundle v1.
//
// What it writes:
//   flow/A.json, trade/<id>.json  bundle v1's files byte for byte: flow A with S1-01, S1-02, S1-11, S1-04, S1-03 and
//                                 S1-74 (S1-01 and S1-02 bundle v0 …/2's), and every trade's overlay.
//   manifest.json                 bundle v1's manifest but prompts.decide, which is decide-2 (its version, sha256 and
//                                 text, in bundle v1's field order), and what follows from it: the bundle id and the
//                                 storage keys under it. Its built at, inputs, models, routing, lists, lint summary,
//                                 partial and storage table (each value's kind, size and sha256) are bundle v1's.
// Its bundle id is the content hash of its stored values (T-150's numberBundle), which are bundle v1's, so bundle v1's
// hash, with build BUILD: 2. K-01 counts a hash's publishes from 1 and writes keys once per bundle id, so …/1 is bundle
// v1's and this second publish of the same values, with another manifest, is …/2, as bundle v0's second publish
// (T-1146: other fixed lines and composer-4, the same flow graph) is baefa1e9…/2.
// Nothing reads a clock: the same bundle v1 and the same prompt modules give the same bytes.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILD as V1_BUILD,
  BUNDLE_DIR as V1_DIR,
  FLOW,
  ROOT,
  STEPS,
  V0_DIR,
  V0_STEPS,
  load,
  promptsFromModules as v1PromptsFromModules,
  stepDifferences,
} from "../v1/build.mjs";

export { FLOW, ROOT, STEPS, V0_DIR, V0_STEPS, V1_BUILD, V1_DIR, load, stepDifferences, v1PromptsFromModules };

/** bundles/v1.1/, and bundle v1's folder bundles/v1/ (read only). */
export const HERE = dirname(fileURLToPath(import.meta.url));
export const V1_HERE = dirname(V1_DIR);

/** The bundle folder this script writes, its KV bulk file (the publish's default), and the two files run 1 writes. */
export const BUNDLE_DIR = join(HERE, "bundle");
export const KV_FILE = `${BUNDLE_DIR}.kv.json`;
export const PROMPTS_FILE = join(HERE, "prompts.json");
export const MODELS_FILE = join(HERE, "models.json");

/** Bundle v1's models.json, which bundle v1.1's is byte for byte. */
export const V1_MODELS_FILE = join(V1_HERE, "models.json");

/**
 * The build number of v1.1's id (K-01 manifest.bundleId.build counts publishes from 1): the second publish of bundle
 * v1's stored values, whose first, c2de3e90…/1, is bundle v1 and stays readable under its own keys.
 */
export const BUILD = 2;

/** The prompt kinds a bundle packs (K-01 manifest.prompts), and the one bundle v1.1 changes. */
export const PROMPT_KINDS = ["safetyRead", "decide", "planner", "composer"];
export const CHANGED = "decide";

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function fail(message) {
  throw new Error(message);
}

/** A bundle id as a label: <hash>/<build>. */
export function label(id) {
  return `${id.hash}/${String(id.build)}`;
}

// ---- 1. the prompts ---------------------------------------------------------------------------------------------

/**
 * Each prompt as bundle v1.1 packs it: bundle v1's (bundles/v1/build.mjs promptsFromModules), but decide, which is
 * decide-2. Refused when decide-2 is not a prompt (version, text, the text's sha256) or is decide-1.
 */
export async function promptsFromModules() {
  const v1 = await v1PromptsFromModules();
  const decide = await load("ai/src/decide/prompt.ts");
  const given = {
    ...v1,
    [CHANGED]: {
      prompt: decide.DECIDE_2_PROMPT,
      from: "ai/src/decide/prompt.ts DECIDE_2_PROMPT (decide-2, T-1500)",
    },
  };
  const { prompt, from } = given[CHANGED];
  if (typeof prompt?.version !== "string" || typeof prompt.text !== "string" || prompt.text === "")
    fail(`${from}: no version and text`);
  if (prompt.sha256 !== sha256(prompt.text)) fail(`${from}: its sha256 is not its text's`);
  if (prompt.version === v1[CHANGED].prompt.version || prompt.sha256 === v1[CHANGED].prompt.sha256)
    fail(`${from} is bundle v1's ${CHANGED} prompt (${v1[CHANGED].prompt.version}), not a new one`);
  return given;
}

async function writePrompts() {
  const given = await promptsFromModules();
  const file = {};
  for (const kind of PROMPT_KINDS) file[kind] = { version: given[kind].prompt.version, text: given[kind].prompt.text };
  writeFileSync(PROMPTS_FILE, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  copyFileSync(V1_MODELS_FILE, MODELS_FILE);
  for (const kind of PROMPT_KINDS) {
    const { prompt, from } = given[kind];
    console.log(`prompt ${kind}: ${prompt.version}, sha256 ${prompt.sha256}, from ${from}`);
  }
  console.log(`wrote ${PROMPTS_FILE}`);
  console.log(`wrote ${MODELS_FILE}, bundle v1's ${V1_MODELS_FILE} byte for byte`);
}

/** prompts.json as run 1 wrote it. */
export function readPromptsFile() {
  return JSON.parse(readFileSync(PROMPTS_FILE, "utf8"));
}

// ---- 2. the cut -------------------------------------------------------------------------------------------------

/**
 * Bundle v1's manifest with `prompt` as its decide prompt, in bundle v1's field order (version, sha256, text). The
 * bundle id and the storage keys stay bundle v1's here; numberBundle() puts bundle v1.1's in their place.
 */
export function withDecide(v1Manifest, prompt) {
  const manifest = structuredClone(v1Manifest);
  const fields = Object.keys(v1Manifest.prompts[CHANGED]);
  if (JSON.stringify([...fields].sort()) !== JSON.stringify(["sha256", "text", "version"]))
    fail(`bundle v1's prompts.${CHANGED} has the fields ${fields.join(", ")}, not version, sha256 and text`);
  manifest.prompts[CHANGED] = Object.fromEntries(fields.map((field) => [field, prompt[field]]));
  return manifest;
}

/**
 * Bundle v1.1 derived from bundle v1 (see the top of this file): its K-01 root, its files and its bundle id, with what
 * the derivation found on the way (bundle v1's id, the two decide prompts).
 */
export async function deriveBundle() {
  const emit = await load("compiler/src/emit/index.ts");
  const ids = await load("compiler/src/bundle-id/index.ts");

  // Bundle v1, read back and checked as the publish checks a bundle folder (compiler/src/publish readPublishable).
  const problems = emit.checkBundleDir(V1_DIR);
  if (problems.length > 0) fail(`${V1_DIR} is not a sound bundle: ${problems.slice(0, 5).join("; ")}`);
  const v1 = emit.readBundleDir(V1_DIR);
  const v1Manifest = v1.bundle.manifest;
  const idProblems = ids.bundleIdProblems(v1Manifest);
  if (idProblems.length > 0) fail(`${V1_DIR}: its bundle id does not hold (${idProblems.join("; ")})`);
  if (ids.contentHashOfFiles(v1.files) !== v1Manifest.bundleId.hash)
    fail(`${V1_DIR}: the content hash of its files is not its bundle id's hash`);
  if (v1Manifest.bundleId.build !== V1_BUILD)
    fail(`${V1_DIR} holds bundle ${label(v1Manifest.bundleId)}, not build ${String(V1_BUILD)}`);

  // The prompts: bundle v1's are what their modules give today, and prompts.json is what they give bundle v1.1 (run 1).
  const before = await v1PromptsFromModules();
  const given = await promptsFromModules();
  for (const kind of PROMPT_KINDS) {
    const want = before[kind].prompt;
    const got = v1Manifest.prompts[kind];
    if (got?.version !== want.version || got.sha256 !== want.sha256 || got.text !== want.text)
      fail(`bundle v1's prompt ${kind} is not ${before[kind].from} as it is today`);
  }
  const file = readPromptsFile();
  for (const kind of PROMPT_KINDS)
    if (file[kind]?.version !== given[kind].prompt.version || file[kind]?.text !== given[kind].prompt.text)
      fail(`${PROMPTS_FILE}'s ${kind} is not ${given[kind].from}: run node bundles/v1.1/build.mjs prompts`);
  if (!readFileSync(MODELS_FILE).equals(readFileSync(V1_MODELS_FILE)))
    fail(`${MODELS_FILE} is not bundle v1's models.json: run node bundles/v1.1/build.mjs prompts`);
  const prompt = { ...given[CHANGED].prompt };
  if (prompt.sha256 !== sha256(file[CHANGED].text)) fail(`${PROMPTS_FILE}'s ${CHANGED} text is not decide-2's`);

  // Bundle v1's root and files with the new manifest, under bundle v1.1's own id.
  const manifest = withDecide(v1Manifest, prompt);
  const bundle = { ...v1.bundle, manifest };
  const refused = emit.checkBundlePart(manifest, "manifest");
  if (refused.length > 0) fail(`bundle v1.1's manifest is not K-01 v1's: ${refused.slice(0, 5).join("; ")}`);
  const files = v1.files.map((each) =>
    each.path === "manifest.json" ? { path: each.path, text: JSON.stringify(manifest) } : each,
  );
  const numbered = ids.numberBundle({ bundle, files }, BUILD);
  if (numbered.bundleId.hash !== v1Manifest.bundleId.hash)
    fail(`the content hash ${numbered.bundleId.hash} is not bundle v1's: a stored value is not bundle v1's`);
  if (numbered.bundleId.build === v1Manifest.bundleId.build)
    fail(`bundle v1.1 would take bundle v1's id ${label(v1Manifest.bundleId)} with other bytes`);
  return {
    ...numbered,
    v1Id: v1Manifest.bundleId,
    decide1: before[CHANGED].prompt,
    decide2: prompt,
    from: given[CHANGED].from,
  };
}

/**
 * Before a cut with --replace: the bundle bundles/v1.1 holds now, if any, and whether the new cut may take its place.
 * The same bundle id with other bytes is refused (K-01 "Storage": keys are written once per bundle id); another id, or
 * the same bytes, may.
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
        `bundles/v1.1 holds bundle ${label(id)} with other bytes (${changed.join(", ") || "other files"}): a bundle with other bytes takes another build number (BUILD in this file)`,
      );
  }
  return ids.keyPrefix(id);
}

async function writeCut(replace) {
  if (!replace && existsSync(BUNDLE_DIR) && readdirSync(BUNDLE_DIR).length > 0)
    fail(`${BUNDLE_DIR} is not empty: a bundle is written into a new or empty folder (--replace makes bundle v1.1 anew)`);
  const emit = await load("compiler/src/emit/index.ts");
  const ids = await load("compiler/src/bundle-id/index.ts");
  const cut = await deriveBundle();
  const replaced = replace ? replaceable(emit, ids, cut) : null;
  if (replaced !== null) {
    // Bundle v1.1's own folder and its KV bulk file only: the publish writes the new KV file for the new id.
    rmSync(BUNDLE_DIR, { recursive: true });
    rmSync(KV_FILE, { force: true });
    console.log(`replaced the bundle bundles/v1.1 held (${replaced}) and its KV bulk file ${KV_FILE}`);
  }
  emit.writeBundle(BUNDLE_DIR, cut.files);

  // Read back from disk, as `compiler build --build <n>` checks what it wrote.
  const problems = emit.checkBundleDir(BUNDLE_DIR);
  const back = emit.readBundleDir(BUNDLE_DIR);
  problems.push(...ids.bundleIdProblems(back.bundle.manifest));
  const hash = ids.contentHashOfFiles(back.files);
  if (hash !== cut.bundleId.hash) problems.push(`the content hash of the files read back is ${hash}`);
  if (problems.length > 0) fail(`the bundle written to ${BUNDLE_DIR} is not sound: ${problems.join("; ")}`);

  console.log(`derived from bundle v1 ${label(cut.v1Id)} in ${V1_DIR}`);
  console.log(
    `bundle v1.1: ${label(cut.bundleId)}, flow ${FLOW} steps ${Object.keys(back.bundle.flows[FLOW].steps).join(", ")}, and ${String(Object.keys(back.bundle.trades).length)} trade overlays, partial`,
  );
  console.log(
    `prompts.${CHANGED}: ${cut.decide1.version} (sha256 ${cut.decide1.sha256}) -> ${cut.decide2.version} (sha256 ${cut.decide2.sha256}), as ${cut.from}`,
  );
  const v1Files = new Map(emit.readBundleDir(V1_DIR).files.map((file) => [file.path, file.text]));
  const kept = back.files.filter((file) => file.path !== "manifest.json" && v1Files.get(file.path) === file.text);
  console.log(
    `${String(kept.length)} of ${String(back.files.length - 1)} stored values bundle v1's byte for byte (flow/A.json and trade/<id>.json)`,
  );
  const manifestText = back.files.find((file) => file.path === "manifest.json")?.text ?? "";
  console.log(
    `wrote manifest.json (${String(emit.byteLength(manifestText))} bytes, sha256 ${sha256(manifestText)}): bundle v1's but prompts.${CHANGED}, the bundle id and the storage keys under it`,
  );
  console.log(
    `read back from ${BUNDLE_DIR} and validated against K-01 v1; its bundle id is the content hash of its stored values, with build ${String(BUILD)}`,
  );
}

// ---- the command line -------------------------------------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cutOk = command === "cut" && rest.every((arg) => arg === "--replace") && rest.length <= 1;
  const run =
    command === "prompts" && rest.length === 0 ? writePrompts() : cutOk ? writeCut(rest.includes("--replace")) : null;
  if (run === null) {
    console.error("usage: node bundles/v1.1/build.mjs prompts | cut [--replace]");
    process.exitCode = 2;
  } else {
    run.catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
