// Bundle v3.1 (T-1556; DL-1214; K-01 v1): bundle v3 byte for byte with decide-3 as its decide prompt, so a turn that
// pins it reads a typed answer with decide-3's rules (T-1555: ai/src/decide/prompt.ts DECIDE_3_PROMPT: rule b's
// whole-quote span, S1-09's name-and-town span, rule c whatever the text says, rule d widened to id fields), while every
// step, word, branch, overlay, model, route and fixed line stays bundle v3's. A turn takes its prompt and its cards from
// the bundle it pins, and a card must equal the pinned bundle's copy or the read throws (ai/src/cache/layout.ts); an
// open question's options come from the bundle it was asked under (actions/src/frontier/sources/open-questions). So,
// as bundle v1.1 was cut from bundle v1 (T-1501), only a prompt-only cut is safe: a question asked under bundle v0, v1,
// v1.1, v2 or v3 keeps its options, its card and its buttons (DL-961).
//
// It is made in two runs, from the repository root:
//
//   1. node bundles/v3.1/build.mjs prompts
//        writes bundles/v3.1/prompts.json, bundle v3's prompts.json (bundles/v3/prompts.json, each prompt as its own
//        module gives it today: bundles/v3/build.mjs promptsFromModules) but decide, which is ai/src/decide/prompt.ts
//        DECIDE_3_PROMPT (decide-3, T-1555) in place of DECIDE_2_PROMPT (decide-2), in the same form and key order; and
//        bundles/v3.1/models.json, bundle v3's models.json byte for byte.
//   2. node bundles/v3.1/build.mjs cut [--replace]
//        writes bundles/v3.1/bundle/, bundle v3.1 (below), from bundle v3's folder bundles/v3/bundle/ and prompts.json,
//        into a new or empty folder, and checks it as `compiler build` checks what it writes. --replace makes bundle
//        v3.1 anew over the one bundles/v3.1 holds: that folder and its KV bulk file bundles/v3.1/bundle.kv.json are
//        removed first, and it is refused if it would give the same bundle id with other bytes (K-01 "Storage": keys
//        are written once per bundle id).
// Then `npm run cli -w @rosie/compiler -- publish bundles/v3.1/bundle` (T-152) writes PostgreSQL's copy and the KV bulk
// file bundles/v3.1/bundle.kv.json, and bundles/v3.1/check.mjs proves the card's checks. It is staging's default bundle
// (infra/scripts/deploy-staging.sh, T-1556): `npm run deploy:staging` publishes it and makes it active (step 3:
// infra/scripts/publish-bundle.sh); `--bundle` still names any other folder.
//
// Why derived from bundle v3 and not cut anew from the whole build: nothing the compiler compiles changes. K-01 v1's
// bundle id hashes the stored values alone (the flow graph and the trade overlays, never the manifest:
// compiler/src/bundle-id/content-hash.ts), and the prompts sit in the manifest alone. So a cut with decide-3 would give
// bundle v3's stored values and bundle v3's manifest but prompts.decide; reading them from bundle v3, whose checks
// (bundles/v3/check.mjs) hold them to the whole build and to bundle v2, gives those bytes without the whole build
// (minutes, and a master copy) and cannot drift from bundle v3.
//
// What it writes:
//   flow/A.json, trade/<id>.json  bundle v3's files byte for byte: flow A's eleven steps (bundle v2's eight, S1-77,
//                                 S1-76 and S1-10), and every trade's overlay.
//   manifest.json                 bundle v3's manifest but prompts.decide, which is decide-3 (its version, sha256 and
//                                 text, in bundle v3's field order), and what follows from it: the bundle id and the
//                                 storage keys under it. Its built at, inputs, models, routing, lists (the fixed lines
//                                 with signUpOpener last), lint summary, partial and storage table (each value's kind,
//                                 size and sha256) are bundle v3's.
// Its bundle id is the content hash of its stored values (T-150's numberBundle), which are bundle v3's, so bundle v3's
// hash, with build BUILD: 2. K-01 counts a hash's publishes from 1 and writes keys once per bundle id, so …/1 is bundle
// v3's and this second publish of the same values, with another manifest, is …/2, as bundle v1.1 is bundle v1's hash
// …/2 (T-1501, DL-1027) and bundle v0's second publish is baefa1e9…/2 (T-1146).
// Nothing reads a clock: the same bundle v3 and the same prompt modules give the same bytes.
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILD as V3_BUILD,
  BUNDLE_DIR as V3_DIR,
  FLOW,
  KV_FILE as V3_KV_FILE,
  MODELS_FILE as V3_MODELS_FILE,
  NEW_STEPS,
  PROMPTS_FILE as V3_PROMPTS_FILE,
  PROMPT_KINDS,
  ROOT,
  STEPS,
  V0_DIR,
  V11_DIR,
  V1_DIR,
  V2_DIR,
  V2_STEPS,
  label,
  load,
  promptsFromModules as v3PromptsFromModules,
  sha256,
} from "../v3/build.mjs";

export {
  FLOW,
  NEW_STEPS,
  PROMPT_KINDS,
  ROOT,
  STEPS,
  V0_DIR,
  V11_DIR,
  V1_DIR,
  V2_DIR,
  V2_STEPS,
  V3_BUILD,
  V3_DIR,
  V3_KV_FILE,
  V3_MODELS_FILE,
  V3_PROMPTS_FILE,
  label,
  load,
  sha256,
  v3PromptsFromModules,
};

/** bundles/v3.1/. */
export const HERE = dirname(fileURLToPath(import.meta.url));

/** The bundle folder this script writes, its KV bulk file (the publish's default), and the two files run 1 writes. */
export const BUNDLE_DIR = join(HERE, "bundle");
export const KV_FILE = `${BUNDLE_DIR}.kv.json`;
export const PROMPTS_FILE = join(HERE, "prompts.json");
export const MODELS_FILE = join(HERE, "models.json");

/**
 * The build number of v3.1's id (K-01 manifest.bundleId.build counts publishes from 1): the second publish of bundle
 * v3's stored values, whose first, …/1, is bundle v3 and stays readable under its own keys.
 */
export const BUILD = 2;

/** The one prompt kind bundle v3.1 changes (K-01 manifest.prompts), and the version it carries. */
export const CHANGED = "decide";
export const DECIDE_3_VERSION = "decide-3";

function fail(message) {
  throw new Error(message);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- 1. the prompts ---------------------------------------------------------------------------------------------

/**
 * Each prompt as bundle v3.1 packs it: bundle v3's (bundles/v3/build.mjs promptsFromModules: decide-2, and the other
 * three as their modules give them), but decide, which is decide-3. Refused when decide-3 is not a prompt (version,
 * text, the text's sha256), is not version decide-3, or is bundle v3's decide prompt.
 */
export async function promptsFromModules() {
  const v3 = await v3PromptsFromModules();
  const decide = await load("ai/src/decide/prompt.ts");
  const given = {
    ...v3,
    [CHANGED]: {
      prompt: decide.DECIDE_3_PROMPT,
      from: "ai/src/decide/prompt.ts DECIDE_3_PROMPT (decide-3, T-1555)",
    },
  };
  const { prompt, from } = given[CHANGED];
  if (typeof prompt?.version !== "string" || typeof prompt.text !== "string" || prompt.text === "")
    fail(`${from}: no version and text`);
  if (prompt.sha256 !== sha256(prompt.text)) fail(`${from}: its sha256 is not its text's`);
  if (prompt.version !== DECIDE_3_VERSION) fail(`${from} is version ${prompt.version}, not ${DECIDE_3_VERSION}`);
  if (prompt.version === v3[CHANGED].prompt.version || prompt.sha256 === v3[CHANGED].prompt.sha256)
    fail(`${from} is bundle v3's ${CHANGED} prompt (${v3[CHANGED].prompt.version}), not a new one`);
  return given;
}

/** bundles/v3/prompts.json's text with `prompt` as its decide entry, in the same form and key order. */
export function promptsText(v3Text, prompt) {
  const file = JSON.parse(v3Text);
  if (`${JSON.stringify(file, null, 2)}\n` !== v3Text)
    fail(`${V3_PROMPTS_FILE} is not in the form JSON.stringify(…, null, 2) and a newline gives`);
  if (!same(Object.keys(file[CHANGED] ?? {}), ["version", "text"]))
    fail(`${V3_PROMPTS_FILE}'s ${CHANGED} has the fields ${Object.keys(file[CHANGED] ?? {}).join(", ")}, not version and text`);
  file[CHANGED] = { version: prompt.version, text: prompt.text };
  return `${JSON.stringify(file, null, 2)}\n`;
}

async function writePrompts() {
  const given = await promptsFromModules();
  const v3Text = readFileSync(V3_PROMPTS_FILE, "utf8");
  const v3 = JSON.parse(v3Text);
  for (const kind of PROMPT_KINDS) {
    const want = (await v3PromptsFromModules())[kind];
    if (v3[kind]?.version !== want.prompt.version || v3[kind]?.text !== want.prompt.text)
      fail(`bundles/v3/prompts.json's ${kind} is not ${want.from} as it is today: bundle v3.1 carries v3's prompts`);
  }
  writeFileSync(PROMPTS_FILE, promptsText(v3Text, given[CHANGED].prompt), "utf8");
  copyFileSync(V3_MODELS_FILE, MODELS_FILE);
  for (const kind of PROMPT_KINDS) {
    const { prompt, from } = given[kind];
    console.log(`prompt ${kind}: ${prompt.version}, sha256 ${prompt.sha256}, from ${from}`);
  }
  console.log(`wrote ${PROMPTS_FILE}, bundle v3's ${V3_PROMPTS_FILE} but ${CHANGED}`);
  console.log(`wrote ${MODELS_FILE}, bundle v3's ${V3_MODELS_FILE} byte for byte`);
}

/** prompts.json as run 1 wrote it. */
export function readPromptsFile() {
  return JSON.parse(readFileSync(PROMPTS_FILE, "utf8"));
}

// ---- 2. the cut -------------------------------------------------------------------------------------------------

/**
 * Bundle v3's manifest with `prompt` as its decide prompt, in bundle v3's field order (version, sha256, text). The
 * bundle id and the storage keys stay bundle v3's here; numberBundle() puts bundle v3.1's in their place.
 */
export function withDecide(v3Manifest, prompt) {
  const manifest = structuredClone(v3Manifest);
  const fields = Object.keys(v3Manifest.prompts[CHANGED]);
  if (JSON.stringify([...fields].sort()) !== JSON.stringify(["sha256", "text", "version"]))
    fail(`bundle v3's prompts.${CHANGED} has the fields ${fields.join(", ")}, not version, sha256 and text`);
  manifest.prompts[CHANGED] = Object.fromEntries(fields.map((field) => [field, prompt[field]]));
  return manifest;
}

/**
 * Bundle v3.1 derived from bundle v3 (see the top of this file): its K-01 root, its files and its bundle id, with what
 * the derivation found on the way (bundle v3's id, the two decide prompts).
 */
export async function deriveBundle() {
  const emit = await load("compiler/src/emit/index.ts");
  const ids = await load("compiler/src/bundle-id/index.ts");

  // Bundle v3, read back and checked as the publish checks a bundle folder (compiler/src/publish readPublishable).
  const problems = emit.checkBundleDir(V3_DIR);
  if (problems.length > 0) fail(`${V3_DIR} is not a sound bundle: ${problems.slice(0, 5).join("; ")}`);
  const v3 = emit.readBundleDir(V3_DIR);
  const v3Manifest = v3.bundle.manifest;
  const idProblems = ids.bundleIdProblems(v3Manifest);
  if (idProblems.length > 0) fail(`${V3_DIR}: its bundle id does not hold (${idProblems.join("; ")})`);
  if (ids.contentHashOfFiles(v3.files) !== v3Manifest.bundleId.hash)
    fail(`${V3_DIR}: the content hash of its files is not its bundle id's hash`);
  if (v3Manifest.bundleId.build !== V3_BUILD)
    fail(`${V3_DIR} holds bundle ${label(v3Manifest.bundleId)}, not build ${String(V3_BUILD)}`);

  // The prompts: bundle v3's are what their modules give today, and prompts.json is what they give bundle v3.1 (run 1).
  const before = await v3PromptsFromModules();
  const given = await promptsFromModules();
  for (const kind of PROMPT_KINDS) {
    const want = before[kind].prompt;
    const got = v3Manifest.prompts[kind];
    if (got?.version !== want.version || got.sha256 !== want.sha256 || got.text !== want.text)
      fail(`bundle v3's prompt ${kind} is not ${before[kind].from} as it is today`);
  }
  const file = readPromptsFile();
  for (const kind of PROMPT_KINDS)
    if (file[kind]?.version !== given[kind].prompt.version || file[kind]?.text !== given[kind].prompt.text)
      fail(`${PROMPTS_FILE}'s ${kind} is not ${given[kind].from}: run node bundles/v3.1/build.mjs prompts`);
  if (!readFileSync(MODELS_FILE).equals(readFileSync(V3_MODELS_FILE)))
    fail(`${MODELS_FILE} is not bundle v3's models.json: run node bundles/v3.1/build.mjs prompts`);
  const prompt = { ...given[CHANGED].prompt };
  if (prompt.sha256 !== sha256(file[CHANGED].text)) fail(`${PROMPTS_FILE}'s ${CHANGED} text is not decide-3's`);

  // Bundle v3's root and files with the new manifest, under bundle v3.1's own id.
  const manifest = withDecide(v3Manifest, prompt);
  const bundle = { ...v3.bundle, manifest };
  const refused = emit.checkBundlePart(manifest, "manifest");
  if (refused.length > 0) fail(`bundle v3.1's manifest is not K-01 v1's: ${refused.slice(0, 5).join("; ")}`);
  const files = v3.files.map((each) =>
    each.path === "manifest.json" ? { path: each.path, text: JSON.stringify(manifest) } : each,
  );
  const numbered = ids.numberBundle({ bundle, files }, BUILD);
  if (numbered.bundleId.hash !== v3Manifest.bundleId.hash)
    fail(`the content hash ${numbered.bundleId.hash} is not bundle v3's: a stored value is not bundle v3's`);
  if (numbered.bundleId.build === v3Manifest.bundleId.build)
    fail(`bundle v3.1 would take bundle v3's id ${label(v3Manifest.bundleId)} with other bytes`);
  return {
    ...numbered,
    v3Id: v3Manifest.bundleId,
    decide2: before[CHANGED].prompt,
    decide3: prompt,
    from: given[CHANGED].from,
  };
}

/**
 * Before a cut with --replace: the bundle bundles/v3.1 holds now, if any, and whether the new cut may take its place.
 * The same bundle id with other bytes is refused (K-01 "Storage": keys are written once per bundle id); another id, or
 * the same bytes, may.
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
        `bundles/v3.1 holds bundle ${label(id)} with other bytes (${changed.join(", ") || "other files"}): a bundle with other bytes takes another build number (BUILD in this file)`,
      );
  }
  return ids.keyPrefix(id);
}

async function writeCut(replace) {
  if (!replace && existsSync(BUNDLE_DIR) && readdirSync(BUNDLE_DIR).length > 0)
    fail(`${BUNDLE_DIR} is not empty: a bundle is written into a new or empty folder (--replace makes bundle v3.1 anew)`);
  const emit = await load("compiler/src/emit/index.ts");
  const ids = await load("compiler/src/bundle-id/index.ts");
  const cut = await deriveBundle();
  const replaced = replace ? replaceable(emit, ids, cut) : null;
  if (replaced !== null) {
    // Bundle v3.1's own folder and its KV bulk file only: the publish writes the new KV file for the new id.
    rmSync(BUNDLE_DIR, { recursive: true });
    rmSync(KV_FILE, { force: true });
    console.log(`replaced the bundle bundles/v3.1 held (${replaced}) and its KV bulk file ${KV_FILE}`);
  }
  emit.writeBundle(BUNDLE_DIR, cut.files);

  // Read back from disk, as `compiler build --build <n>` checks what it wrote.
  const problems = emit.checkBundleDir(BUNDLE_DIR);
  const back = emit.readBundleDir(BUNDLE_DIR);
  problems.push(...ids.bundleIdProblems(back.bundle.manifest));
  const hash = ids.contentHashOfFiles(back.files);
  if (hash !== cut.bundleId.hash) problems.push(`the content hash of the files read back is ${hash}`);
  if (problems.length > 0) fail(`the bundle written to ${BUNDLE_DIR} is not sound: ${problems.join("; ")}`);

  console.log(`derived from bundle v3 ${label(cut.v3Id)} in ${V3_DIR}`);
  console.log(
    `bundle v3.1: ${label(cut.bundleId)}, flow ${FLOW} steps ${Object.keys(back.bundle.flows[FLOW].steps).join(", ")}, and ${String(Object.keys(back.bundle.trades).length)} trade overlays, partial`,
  );
  console.log(
    `prompts.${CHANGED}: ${cut.decide2.version} (sha256 ${cut.decide2.sha256}) -> ${cut.decide3.version} (sha256 ${cut.decide3.sha256}), as ${cut.from}`,
  );
  const v3Files = new Map(emit.readBundleDir(V3_DIR).files.map((file) => [file.path, file.text]));
  const kept = back.files.filter((file) => file.path !== "manifest.json" && v3Files.get(file.path) === file.text);
  console.log(
    `${String(kept.length)} of ${String(back.files.length - 1)} stored values bundle v3's byte for byte (flow/A.json and trade/<id>.json)`,
  );
  const manifestText = back.files.find((file) => file.path === "manifest.json")?.text ?? "";
  console.log(
    `wrote manifest.json (${String(emit.byteLength(manifestText))} bytes, sha256 ${sha256(manifestText)}): bundle v3's but prompts.${CHANGED}, the bundle id and the storage keys under it`,
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
    console.error("usage: node bundles/v3.1/build.mjs prompts | cut [--replace]");
    process.exitCode = 2;
  } else {
    run.catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
