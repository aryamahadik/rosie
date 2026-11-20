// The checks of bundle v1.1 (T-1501's "Proves it with"), run from the repository root:
//
//   node bundles/v1.1/check.mjs [--db]
//
//   --db  also read the published bundle back from PostgreSQL (DATABASE_URL, else the local database when CI is unset;
//         db/repo/client.ts): K-05's readActiveBundle, then readBundleValue for every part.
//
// What it checks, each printed as one line, ok or FAIL (exit 1 on any FAIL); a line starting with spaces is a note:
//   1. bundles/v1.1/bundle/ validates against K-01 v1 and passes `compiler build`'s own checks on what it wrote (the
//      compiler's checkBundleDir: the whole bundle, and each file the value its manifest's storage lists), and holds
//      flow/A.json, manifest.json and trade/<id>.json for each trade of fixture set v1, flow A's six steps, partial.
//   2. Every part but the manifest is bundle v1's byte for byte (bundles/v1/bundle/: flow A and every trade overlay),
//      and S1-01 and S1-02 are bundle v0 …/2's byte for byte, so a question asked under v0 or v1 keeps its options and
//      its card (DL-961; K-09 v1.11 default 188).
//   3. The manifest is bundle v1's but prompts.decide and the bundle id: with bundle v1's decide prompt and bundle v1's
//      id put back (and so its storage keys), it is bundles/v1/bundle/manifest.json byte for byte.
//   4. prompts.decide is ai/src/decide/prompt.ts DECIDE_2_PROMPT (its version decide-2, its text, its sha256 the
//      text's), not bundle v1's decide-1; the other three prompts are bundle v1's, as their modules give them today;
//      prompts.json is what the modules give bundle v1.1, and models.json is bundle v1's byte for byte and the
//      manifest's models and routing.
//   5. The bundle id is the content hash of the stored values (T-150): bundle v1's hash, since the stored values are
//      bundle v1's, with build 2, so not bundle v1's id …/1 (K-01 "Storage": keys are written once per bundle id).
//   6. The KV bulk file bundles/v1.1/bundle.kv.json holds one entry per part, every key under the bundle id, each value
//      the part's bytes.
//   7. With --db: readActiveBundle answers, and readBundleValue gives back every part byte for byte.
// bundles/v1.1/check.test.mjs runs checks 1 to 6 (`node --test bundles/v1.1/check.test.mjs`).
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BUILD,
  BUNDLE_DIR,
  CHANGED,
  FLOW,
  KV_FILE,
  MODELS_FILE,
  PROMPT_KINDS,
  STEPS,
  V0_DIR,
  V0_STEPS,
  V1_DIR,
  V1_MODELS_FILE,
  label,
  load,
  promptsFromModules,
  readPromptsFile,
  sha256,
  stepDifferences,
  v1PromptsFromModules,
} from "./build.mjs";

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The key prefix of a bundle id (K-01 kvKey): bundle/<hash>/<build>/. */
function prefixOf(id) {
  return `bundle/${id.hash}/${String(id.build)}/`;
}

// ---- the pure checks (each gives its problems, one line each; none: it holds) --------------------------------------

/** Check 2: the paths of `files` but manifest.json that are not bundle v1's file byte for byte, and v1's it lacks. */
export function partDifferences(files, v1Files) {
  const ours = new Map(files.filter((file) => file.path !== "manifest.json").map((file) => [file.path, file.text]));
  const theirs = new Map(v1Files.filter((file) => file.path !== "manifest.json").map((file) => [file.path, file.text]));
  const out = [];
  for (const [path, text] of ours) {
    if (!theirs.has(path)) out.push(`${path}: not in bundle v1`);
    else if (theirs.get(path) !== text) out.push(`${path}: other bytes than bundle v1's`);
  }
  for (const path of theirs.keys()) if (!ours.has(path)) out.push(`${path}: bundle v1's, missing`);
  return out;
}

/**
 * Check 3: `manifest` with bundle v1's decide prompt and bundle v1's id put back, its storage keys moved from its own
 * id to bundle v1's. Every field keeps its place, so it is JSON text that can equal bundle v1's manifest.json.
 */
export function restoredManifest(manifest, v1Manifest) {
  const restored = structuredClone(manifest);
  const from = prefixOf(manifest.bundleId);
  const to = prefixOf(v1Manifest.bundleId);
  const rekey = (key) => (key.startsWith(from) ? `${to}${key.slice(from.length)}` : `(not under ${from}) ${key}`);
  restored.prompts[CHANGED] = structuredClone(v1Manifest.prompts[CHANGED]);
  restored.bundleId = structuredClone(v1Manifest.bundleId);
  restored.storage.manifestKey = rekey(restored.storage.manifestKey);
  for (const value of restored.storage.values) value.key = rekey(value.key);
  return JSON.stringify(restored);
}

/** Check 3: where `manifest` differs from bundle v1's (its text `v1Text`) but in prompts.decide and the bundle id. */
export function manifestDifferences(manifest, v1Text) {
  const v1Manifest = JSON.parse(v1Text);
  const text = restoredManifest(manifest, v1Manifest);
  if (text === v1Text) return [];
  const restored = JSON.parse(text);
  const keys = [...new Set([...Object.keys(v1Manifest), ...Object.keys(restored)])];
  const fields = keys.filter((key) => !same(restored[key], v1Manifest[key]));
  if (!same(Object.keys(restored), Object.keys(v1Manifest))) fields.push("the order of its fields");
  for (const kind of Object.keys(v1Manifest.prompts ?? {}))
    if (kind !== CHANGED && !same(restored.prompts?.[kind], v1Manifest.prompts[kind])) fields.push(`prompts.${kind}`);
  return [`not bundle v1's manifest but prompts.${CHANGED} and the bundle id: ${fields.join(", ") || "its bytes"}`];
}

/**
 * Check 4: the manifest's prompts against the prompt modules: decide is `decide2` (version, sha256 and text, the sha256
 * the text's), not bundle v1's; every other kind is bundle v1's manifest's and what its module gives (`v1Given`).
 */
export function promptProblems(manifest, v1Manifest, decide2, v1Given) {
  const out = [];
  const got = manifest.prompts?.[CHANGED];
  if (got?.version !== decide2.version || got.sha256 !== decide2.sha256 || got.text !== decide2.text)
    out.push(`prompts.${CHANGED} is ${String(got?.version)}, not ${decide2.version} as its module gives it`);
  else if (got.sha256 !== sha256(got.text)) out.push(`prompts.${CHANGED}'s sha256 is not its text's`);
  if (got !== undefined && same(got, v1Manifest.prompts[CHANGED])) out.push(`prompts.${CHANGED} is bundle v1's`);
  for (const kind of PROMPT_KINDS) {
    if (kind === CHANGED) continue;
    const want = v1Given[kind].prompt;
    const ours = manifest.prompts?.[kind];
    if (!same(ours, v1Manifest.prompts[kind])) out.push(`prompts.${kind} is not bundle v1's`);
    else if (ours.version !== want.version || ours.sha256 !== want.sha256 || ours.text !== want.text)
      out.push(`prompts.${kind} is not ${v1Given[kind].from} as it is today`);
  }
  return out;
}

/** Check 6: what is wrong with the KV bulk file's entries for the bundle `files` make under bundle id `id`. */
export function kvProblems(entries, files, id) {
  if (!Array.isArray(entries)) return ["no KV bulk file entries (run the publish)"];
  const prefix = prefixOf(id);
  const byPath = new Map(files.map((file) => [file.path, file.text]));
  const out = [];
  if (entries.length !== files.length)
    out.push(`${String(entries.length)} entries for ${String(files.length)} parts`);
  if (new Set(entries.map((entry) => entry.key)).size !== entries.length) out.push("a key is listed twice");
  for (const entry of entries) {
    if (typeof entry?.key !== "string" || !entry.key.startsWith(prefix)) out.push(`${String(entry?.key)}: not under ${prefix}`);
    else if (byPath.get(`${entry.key.slice(prefix.length)}.json`) !== entry.value) out.push(`${entry.key}: not the part's bytes`);
  }
  return out;
}

// ---- the run ------------------------------------------------------------------------------------------------------

/**
 * Checks 1 to 6 (and 7 with `db`) on the bundle folder `dir` and its KV bulk file `kvFile`: each line { ok, check,
 * what }, a note with ok null.
 */
export async function runChecks({ dir = BUNDLE_DIR, kvFile = KV_FILE, db = false } = {}) {
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
  const paths = read.files.map((file) => file.path);
  const want = ["flow/A.json", "manifest.json", ...tradeIds.map((id) => `trade/${id}.json`)].sort();
  report(
    1,
    same(paths, want),
    `files: flow/A.json, manifest.json and trade/<id>.json for each of fixture set v1's ${String(tradeIds.length)} trades (${String(paths.length)} files)`,
  );
  const held = Object.keys(flows[FLOW]?.steps ?? {});
  report(
    1,
    manifest.partial === true &&
      same(Object.keys(flows), [FLOW]) &&
      same(Object.keys(trades).sort(), tradeIds) &&
      same([...held].sort(), [...STEPS].sort()),
    `partial: ${String(manifest.partial)}; flows: ${Object.keys(flows).join(", ")}; steps of flow ${FLOW}: ${held.join(", ")}; trades: ${String(Object.keys(trades).length)}`,
  );

  // 2. Bundle v1's parts byte for byte; bundle v0 …/2's S1-01 and S1-02.
  const v1Problems = emit.checkBundleDir(V1_DIR);
  const v1 = emit.readBundleDir(V1_DIR);
  const v1Manifest = v1.bundle.manifest;
  report(
    2,
    v1Problems.length === 0,
    `bundle v1 read back from bundles/v1/bundle: ${label(v1Manifest.bundleId)}${v1Problems.length === 0 ? ", sound" : `: ${v1Problems.slice(0, 3).join("; ")}`}`,
  );
  const differ = partDifferences(read.files, v1.files);
  const parts = read.files.filter((file) => file.path !== "manifest.json");
  report(
    2,
    differ.length === 0,
    `every part but the manifest is bundle v1's byte for byte: ${String(parts.length)} of ${String(v1.files.length - 1)} (flow/A.json, ${String(parts.filter((file) => file.path.startsWith("trade/")).length)} trade overlays)${differ.length === 0 ? "" : `: ${differ.slice(0, 5).join("; ")}`}`,
  );
  const v0 = emit.readBundleDir(V0_DIR).bundle;
  for (const step of V0_STEPS) {
    const ours = flows[FLOW]?.steps?.[step];
    const stepDiffer = stepDifferences(ours, v0.flows[FLOW]?.steps?.[step]);
    const text = JSON.stringify(ours);
    const options = ours?.card?.means?.map((means) => means.branch) ?? [];
    report(
      2,
      stepDiffer.length === 0,
      `${step} is bundle v0 ${label(v0.manifest.bundleId)}'s byte for byte (${String(Buffer.byteLength(text ?? "", "utf8"))} bytes, sha256 ${sha256(text ?? "")})${options.length > 0 ? `; its card's options in order: ${options.join(" | ")}` : ""}${stepDiffer.length === 0 ? "" : `: ${stepDiffer.join("; ")}`}`,
    );
  }
  const carded = STEPS.filter((id) => flows[FLOW]?.steps?.[id]?.card !== undefined);
  note(
    2,
    `the steps with a card (a question whose options decide reads): ${carded.join(", ") || "none"}; ${STEPS.filter((id) => !carded.includes(id)).join(", ")} have none`,
  );

  // 3. The manifest: bundle v1's but prompts.decide and the bundle id.
  const v1Text = v1.files.find((file) => file.path === "manifest.json")?.text ?? "";
  const manifestDiffer = manifestDifferences(manifest, v1Text);
  report(
    3,
    manifestDiffer.length === 0,
    `the manifest is bundle v1's but prompts.${CHANGED} and the bundle id: with bundle v1's ${CHANGED} prompt and id put back (and its storage keys under it), it is bundles/v1/bundle/manifest.json byte for byte (${String(Buffer.byteLength(v1Text, "utf8"))} bytes)${manifestDiffer.length === 0 ? "" : `: ${manifestDiffer.join("; ")}`}`,
  );

  // 4. The prompts, prompts.json and models.json.
  const given = await promptsFromModules();
  const v1Given = await v1PromptsFromModules();
  const decide2 = given[CHANGED].prompt;
  const promptDiffer = promptProblems(manifest, v1Manifest, decide2, v1Given);
  const decideDiffer = promptDiffer.filter((line) => line.startsWith(`prompts.${CHANGED}`));
  report(
    4,
    decideDiffer.length === 0,
    `prompts.${CHANGED}: ${String(manifest.prompts?.[CHANGED]?.version)}, sha256 ${String(manifest.prompts?.[CHANGED]?.sha256)}, as ${given[CHANGED].from}, its sha256 its text's (bundle v1's: ${v1Manifest.prompts[CHANGED].version}, sha256 ${v1Manifest.prompts[CHANGED].sha256})${decideDiffer.length === 0 ? "" : `: ${decideDiffer.join("; ")}`}`,
  );
  for (const kind of PROMPT_KINDS.filter((each) => each !== CHANGED)) {
    const ours = manifest.prompts?.[kind];
    report(
      4,
      !promptDiffer.some((line) => line.startsWith(`prompts.${kind} `)),
      `prompt ${kind}: ${String(ours?.version)}, sha256 ${String(ours?.sha256)}, bundle v1's, as ${v1Given[kind].from}`,
    );
  }
  const file = readPromptsFile();
  report(
    4,
    PROMPT_KINDS.every(
      (kind) => file[kind]?.version === given[kind].prompt.version && file[kind]?.text === given[kind].prompt.text,
    ) && same(Object.keys(file), PROMPT_KINDS),
    `prompts.json is what the prompt modules give bundle v1.1 (${PROMPT_KINDS.map((kind) => `${kind} ${String(file[kind]?.version)}`).join(", ")})`,
  );
  const models = JSON.parse(readFileSync(MODELS_FILE, "utf8"));
  report(
    4,
    readFileSync(MODELS_FILE).equals(readFileSync(V1_MODELS_FILE)) &&
      same(manifest.models, models.models) &&
      same(manifest.policy, models.policy),
    `models.json is bundle v1's byte for byte, and the manifest's models ${JSON.stringify(manifest.models)} and policy ${JSON.stringify(manifest.policy)}`,
  );

  // 5. The bundle id.
  const id = manifest.bundleId;
  const idProblems = ids.bundleIdProblems(manifest);
  const hash = ids.contentHashOfFiles(read.files);
  const idOk =
    idProblems.length === 0 &&
    hash === id.hash &&
    id.build === BUILD &&
    id.hash === v1Manifest.bundleId.hash &&
    label(id) !== label(v1Manifest.bundleId);
  report(
    5,
    idOk,
    `bundle id ${label(id)}: the content hash of its ${String(read.files.length - 1)} stored values (T-150), bundle v1's hash as its stored values are bundle v1's, with build ${String(BUILD)}, so not bundle v1's ${label(v1Manifest.bundleId)}${idOk ? "" : `: ${[...idProblems, `files hash to ${hash}`].join("; ")}`}`,
  );

  // 6. The KV bulk file.
  const entries = existsSync(kvFile) ? JSON.parse(readFileSync(kvFile, "utf8")) : null;
  const kvDiffer = kvProblems(entries, read.files, id);
  report(
    6,
    kvDiffer.length === 0,
    `KV bulk file ${kvFile === KV_FILE ? "bundles/v1.1/bundle.kv.json" : kvFile}: ${String(Array.isArray(entries) ? entries.length : 0)} entries, one per part, every key under ${prefixOf(id)}, each value the part's bytes${kvDiffer.length === 0 ? "" : `: ${kvDiffer.slice(0, 5).join("; ")}`}`,
  );

  // 7. PostgreSQL.
  if (db) await checkDb(read, report);
  return lines;
}

async function checkDb(read, report) {
  const client = await load("db/repo/client.ts");
  const bundles = await load("db/repo/bundles.ts");
  const db = client.createClient({ max: 2 });
  try {
    const active = await bundles.readActiveBundle(db.primary);
    const id = read.bundle.manifest.bundleId;
    const name =
      "result" in active
        ? `${label(active.bundleId)} since ${active.activatedAt}${label(active.bundleId) === label(id) ? " (bundle v1.1)" : ""}`
        : active.error === "noActiveBundle"
          ? "none is active (noActiveBundle): publishing never switches it; the deploy's step 3 sets it on staging"
          : `transient ${active.sqlstate}`;
    report(7, !("error" in active) || active.error === "noActiveBundle", `readActiveBundle: ${name}`);
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
      7,
      good === keys.length,
      `readBundleValue by bundle id ${label(id)}: ${String(good)} of ${String(keys.length)} parts byte-identical (the manifest with decide-2, ${String(kinds.flow)} flow graph, ${String(kinds.trade)} trade overlays)${bad.length === 0 ? "" : `: ${bad.slice(0, 5).join("; ")}`}`,
    );
  } finally {
    await db.close();
  }
}

async function main() {
  const given = process.argv.slice(2);
  if (given.some((arg) => arg !== "--db") || given.length > 1)
    throw new Error(`usage: node bundles/v1.1/check.mjs [--db] (not "${given.join(" ")}")`);
  const lines = await runChecks({ db: given.includes("--db") });
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
