// The checks of bundle v3.1 (T-1556's "Proves it with"; DL-1214), run from the repository root:
//
//   node bundles/v3.1/check.mjs [--full <full build folder>] [--db]
//
//   --full  also hold the folder against the compiler's whole build, as bundles/v3/check.mjs --full does (its check 10,
//           run on bundles/v3.1/bundle/): build it as bundles/v3/build.mjs's run 2 does, but with
//           --prompts bundles/v3.1/prompts.json, so its manifest packs decide-3.
//   --db    also read the published bundle back from PostgreSQL (DATABASE_URL, else the local database when CI is
//           unset; db/repo/client.ts): K-05's readActiveBundle, then readBundleValue for every part.
//
// What it checks, each printed as one line, ok or FAIL (exit 1 on any FAIL); a line starting with spaces is a note.
// Every check bundle v3's has, on bundles/v3.1/bundle/ and its KV bulk file, plus check 12:
//   1-6. bundles/v3/check.mjs's checks 1 to 6, its own code run on this folder: K-01 v1 and the compiler's
//        checkBundleDir, the files and the eleven steps of flow A, partial; bundle v2's eight steps byte for byte and
//        in its order, and every trade overlay bundle v2's; S1-09's options, branches and walks; the shapes of S1-10,
//        S1-77 and S1-76; T-160's lint marks and the manifest's lint summary; the slots of the lines Rosie sends.
//   7. The manifest (bundle v3's check 7 with decide-3 in place of decide-2): prompts.decide is ai/src/decide/prompt.ts
//      DECIDE_3_PROMPT (decide-3, its text, its sha256 the text's), not decide-2 or decide-1; the other three prompts
//      are bundle v3's, as their modules give them today; prompts.json is bundles/v3/prompts.json byte for byte but
//      decide, which is decide-3; models.json is bundle v3's byte for byte and the manifest's models and routing; the
//      fixed lines are bundle v3's byte for byte (signUpOpener last); no journey.
//   8. The bundle id is the content hash of the stored values (T-150): bundle v3's hash, since the stored values are
//      bundle v3's, with build 2, so not bundle v3's id …/1 (K-01 "Storage": keys are written once per bundle id), and
//      no hash of bundles v0, v1, v1.1 or v2.
//   9. bundles/v3/check.mjs's check 9 on bundles/v3.1/bundle.kv.json: one entry per part, every key under the bundle id,
//      each value the part's bytes.
//  10. With --full: bundles/v3/check.mjs's check 10 on this folder.
//  11. With --db: readActiveBundle answers, and readBundleValue gives back every part byte for byte.
//  12. Only the decide prompt differs from bundle v3: every part but the manifest is bundle v3's byte for byte, and the
//      manifest, with bundle v3's decide prompt and id put back (and so its storage keys), is
//      bundles/v3/bundle/manifest.json byte for byte.
// No model is called. bundles/v3.1/check.test.mjs runs checks 1 to 9 and 12 (`node --test bundles/v3.1/check.test.mjs`).
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runChecks as runV3Checks } from "../v3/check.mjs";
import {
  BUILD,
  BUNDLE_DIR,
  CHANGED,
  DECIDE_3_VERSION,
  KV_FILE,
  MODELS_FILE,
  PROMPTS_FILE,
  PROMPT_KINDS,
  V0_DIR,
  V11_DIR,
  V1_DIR,
  V2_DIR,
  V3_DIR,
  V3_MODELS_FILE,
  V3_PROMPTS_FILE,
  label,
  load,
  promptsFromModules,
  promptsText,
  readPromptsFile,
  sha256,
  v3PromptsFromModules,
} from "./build.mjs";

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The key prefix of a bundle id (K-01 kvKey): bundle/<hash>/<build>/. */
function prefixOf(id) {
  return `bundle/${id.hash}/${String(id.build)}/`;
}

/** Bundle v3's checks this script runs as they are, on bundles/v3.1's folder (7, 8 and 11 are this script's own). */
export const V3_CHECKS_AS_THEY_ARE = [1, 2, 3, 4, 5, 6, 9, 10];

// ---- the pure checks (each gives its problems, one line each; none: it holds) --------------------------------------

/** Check 12: the paths of `files` but manifest.json that are not bundle v3's file byte for byte, and v3's it lacks. */
export function partDifferences(files, v3Files) {
  const ours = new Map(files.filter((file) => file.path !== "manifest.json").map((file) => [file.path, file.text]));
  const theirs = new Map(v3Files.filter((file) => file.path !== "manifest.json").map((file) => [file.path, file.text]));
  const out = [];
  for (const [path, text] of ours) {
    if (!theirs.has(path)) out.push(`${path}: not in bundle v3`);
    else if (theirs.get(path) !== text) out.push(`${path}: other bytes than bundle v3's`);
  }
  for (const path of theirs.keys()) if (!ours.has(path)) out.push(`${path}: bundle v3's, missing`);
  return out;
}

/**
 * Check 12: `manifest` with bundle v3's decide prompt and bundle v3's id put back, its storage keys moved from its own
 * id to bundle v3's. Every field keeps its place, so it is JSON text that can equal bundle v3's manifest.json.
 */
export function restoredManifest(manifest, v3Manifest) {
  const restored = structuredClone(manifest);
  const from = prefixOf(manifest.bundleId);
  const to = prefixOf(v3Manifest.bundleId);
  const rekey = (key) => (key.startsWith(from) ? `${to}${key.slice(from.length)}` : `(not under ${from}) ${key}`);
  restored.prompts[CHANGED] = structuredClone(v3Manifest.prompts[CHANGED]);
  restored.bundleId = structuredClone(v3Manifest.bundleId);
  restored.storage.manifestKey = rekey(restored.storage.manifestKey);
  for (const value of restored.storage.values) value.key = rekey(value.key);
  return JSON.stringify(restored);
}

/** Check 12: where `manifest` differs from bundle v3's (its text `v3Text`) but in prompts.decide and the bundle id. */
export function manifestDifferences(manifest, v3Text) {
  const v3Manifest = JSON.parse(v3Text);
  const text = restoredManifest(manifest, v3Manifest);
  if (text === v3Text) return [];
  const restored = JSON.parse(text);
  const keys = [...new Set([...Object.keys(v3Manifest), ...Object.keys(restored)])];
  const fields = keys.filter((key) => !same(restored[key], v3Manifest[key]));
  if (!same(Object.keys(restored), Object.keys(v3Manifest))) fields.push("the order of its fields");
  for (const kind of Object.keys(v3Manifest.prompts ?? {}))
    if (kind !== CHANGED && !same(restored.prompts?.[kind], v3Manifest.prompts[kind])) fields.push(`prompts.${kind}`);
  return [`not bundle v3's manifest but prompts.${CHANGED} and the bundle id: ${fields.join(", ") || "its bytes"}`];
}

/**
 * Check 7: the manifest's prompts against the prompt modules: decide is `decide3` (version decide-3, sha256 and text,
 * the sha256 the text's), not bundle v3's (decide-2); every other kind is bundle v3's manifest's and what its module
 * gives (`v3Given`).
 */
export function promptProblems(manifest, v3Manifest, decide3, v3Given) {
  const out = [];
  const got = manifest.prompts?.[CHANGED];
  if (got?.version !== decide3.version || got.sha256 !== decide3.sha256 || got.text !== decide3.text)
    out.push(`prompts.${CHANGED} is ${String(got?.version)}, not ${decide3.version} as its module gives it`);
  else if (got.sha256 !== sha256(got.text)) out.push(`prompts.${CHANGED}'s sha256 is not its text's`);
  if (got !== undefined && got.version !== DECIDE_3_VERSION) out.push(`prompts.${CHANGED} is not ${DECIDE_3_VERSION}`);
  if (got !== undefined && same(got, v3Manifest.prompts[CHANGED])) out.push(`prompts.${CHANGED} is bundle v3's`);
  for (const kind of PROMPT_KINDS) {
    if (kind === CHANGED) continue;
    const want = v3Given[kind].prompt;
    const ours = manifest.prompts?.[kind];
    if (!same(ours, v3Manifest.prompts[kind])) out.push(`prompts.${kind} is not bundle v3's`);
    else if (ours.version !== want.version || ours.sha256 !== want.sha256 || ours.text !== want.text)
      out.push(`prompts.${kind} is not ${v3Given[kind].from} as it is today`);
  }
  return out;
}

// ---- the run ------------------------------------------------------------------------------------------------------

/**
 * Checks 1 to 9 and 12 (10 with `full`, 11 with `db`) on the bundle folder `dir` and its KV bulk file `kvFile`: each
 * line { ok, check, what }, a note with ok null.
 */
export async function runChecks({ dir = BUNDLE_DIR, kvFile = KV_FILE, full = null, db = false } = {}) {
  const lines = [];
  const report = (check, ok, what) => lines.push({ ok, check, what });
  const note = (check, what) => lines.push({ ok: null, check, what });
  const emit = await load("compiler/src/emit/index.ts");
  const ids = await load("compiler/src/bundle-id/index.ts");

  // 1 to 6, 9 and 10: bundle v3's own checks, on this folder and its KV bulk file.
  const v3Lines = await runV3Checks({ dir, kvFile, full, db: false });
  lines.push(...v3Lines.filter((line) => V3_CHECKS_AS_THEY_ARE.includes(line.check)));

  const read = emit.readBundleDir(dir);
  const { manifest } = read.bundle;
  const v3 = emit.readBundleDir(V3_DIR);
  const v3Manifest = v3.bundle.manifest;

  // 7. The manifest: decide-3, bundle v3's other prompts, prompts.json, models.json, fixed lines, journeys.
  const given = await promptsFromModules();
  const v3Given = await v3PromptsFromModules();
  const decide = await load("ai/src/decide/prompt.ts");
  const decide3 = given[CHANGED].prompt;
  const promptDiffer = promptProblems(manifest, v3Manifest, decide3, v3Given);
  const decideDiffer = promptDiffer.filter((line) => line.startsWith(`prompts.${CHANGED}`));
  const older = [decide.DECIDE_PROMPT, decide.DECIDE_2_PROMPT].filter(
    (prompt) => manifest.prompts?.[CHANGED]?.sha256 === prompt.sha256,
  );
  report(
    7,
    decideDiffer.length === 0 && older.length === 0 && decide3.sha256 === decide.DECIDE_3_PROMPT.sha256,
    `prompts.${CHANGED}: ${String(manifest.prompts?.[CHANGED]?.version)}, sha256 ${String(manifest.prompts?.[CHANGED]?.sha256)}, as ${given[CHANGED].from}, its sha256 its text's; not bundle v3's ${v3Manifest.prompts[CHANGED].version} (sha256 ${v3Manifest.prompts[CHANGED].sha256}) nor decide-1 (sha256 ${decide.DECIDE_PROMPT.sha256})${decideDiffer.length + older.length === 0 ? "" : `: ${[...decideDiffer, ...older.map((prompt) => `it is ${prompt.version}`)].join("; ")}`}`,
  );
  for (const kind of PROMPT_KINDS.filter((each) => each !== CHANGED)) {
    const ours = manifest.prompts?.[kind];
    report(
      7,
      !promptDiffer.some((line) => line.startsWith(`prompts.${kind} `)),
      `prompt ${kind}: ${String(ours?.version)}, sha256 ${String(ours?.sha256)}, bundle v3's, as ${v3Given[kind].from}`,
    );
  }
  const file = readPromptsFile();
  const promptsBytes = readFileSync(PROMPTS_FILE, "utf8");
  const v3PromptsBytes = readFileSync(V3_PROMPTS_FILE, "utf8");
  report(
    7,
    promptsBytes === promptsText(v3PromptsBytes, decide3) &&
      same(Object.keys(file), PROMPT_KINDS) &&
      PROMPT_KINDS.every(
        (kind) => file[kind]?.version === manifest.prompts?.[kind]?.version && file[kind]?.text === manifest.prompts?.[kind]?.text,
      ),
    `prompts.json is bundles/v3/prompts.json byte for byte but ${CHANGED}, and what the manifest packs (${PROMPT_KINDS.map((kind) => `${kind} ${String(file[kind]?.version)}`).join(", ")})`,
  );
  const models = JSON.parse(readFileSync(MODELS_FILE, "utf8"));
  report(
    7,
    readFileSync(MODELS_FILE).equals(readFileSync(V3_MODELS_FILE)) &&
      same(manifest.models, models.models) &&
      same(manifest.policy, models.policy) &&
      same(manifest.models, v3Manifest.models) &&
      same(manifest.policy, v3Manifest.policy),
    `models.json is bundles/v3/models.json byte for byte, and the manifest's models ${JSON.stringify(manifest.models)} and policy ${JSON.stringify(manifest.policy)} are bundle v3's`,
  );
  const fixed = manifest.lists?.fixedLines?.lines;
  report(
    7,
    same(manifest.lists?.fixedLines, v3Manifest.lists.fixedLines) && fixed?.at(-1)?.id === "signUpOpener",
    `the fixed lines are bundle v3's ${String(v3Manifest.lists.fixedLines.lines.length)} byte for byte, signUpOpener last (${String(fixed?.at(-1)?.id)})`,
  );
  report(7, same(manifest.journeys, []), "journeys: none, as bundles v0 to v3 list none");

  // 8. The bundle id.
  const earlier = [V0_DIR, V1_DIR, V11_DIR, V2_DIR].map((each) => emit.readBundleDir(each).bundle.manifest.bundleId);
  const id = manifest.bundleId;
  const idProblems = ids.bundleIdProblems(manifest);
  const hash = ids.contentHashOfFiles(read.files);
  const idOk =
    idProblems.length === 0 &&
    hash === id.hash &&
    id.build === BUILD &&
    id.hash === v3Manifest.bundleId.hash &&
    label(id) !== label(v3Manifest.bundleId) &&
    earlier.every((each) => each.hash !== id.hash);
  report(
    8,
    idOk,
    `bundle id ${label(id)}: the content hash of its ${String(read.files.length - 1)} stored values (T-150), bundle v3's hash as its stored values are bundle v3's, with build ${String(BUILD)}, so not bundle v3's ${label(v3Manifest.bundleId)}, and no hash of ${earlier.map(label).join(", ")}${idOk ? "" : `: ${[...idProblems, `files hash to ${hash}`].join("; ")}`}`,
  );

  // 11. PostgreSQL.
  if (db) await checkDb(read, report);

  // 12. Only the decide prompt differs from bundle v3.
  const v3Problems = emit.checkBundleDir(V3_DIR);
  report(
    12,
    v3Problems.length === 0,
    `bundle v3 read back from bundles/v3/bundle: ${label(v3Manifest.bundleId)}${v3Problems.length === 0 ? ", sound" : `: ${v3Problems.slice(0, 3).join("; ")}`}`,
  );
  const differ = partDifferences(read.files, v3.files);
  const parts = read.files.filter((file) => file.path !== "manifest.json");
  report(
    12,
    differ.length === 0,
    `every part but the manifest is bundle v3's byte for byte: ${String(parts.length - differ.length)} of ${String(v3.files.length - 1)} (flow/A.json, ${String(parts.filter((file) => file.path.startsWith("trade/")).length)} trade overlays)${differ.length === 0 ? "" : `: ${differ.slice(0, 5).join("; ")}`}`,
  );
  const v3Text = v3.files.find((each) => each.path === "manifest.json")?.text ?? "";
  const manifestDiffer = manifestDifferences(manifest, v3Text);
  report(
    12,
    manifestDiffer.length === 0,
    `only the ${CHANGED} prompt differs from bundle v3: with bundle v3's ${CHANGED} prompt and id put back (and its storage keys under it), the manifest is bundles/v3/bundle/manifest.json byte for byte (${String(Buffer.byteLength(v3Text, "utf8"))} bytes)${manifestDiffer.length === 0 ? "" : `: ${manifestDiffer.join("; ")}`}`,
  );
  if (!existsSync(kvFile)) note(12, `no KV bulk file at ${kvFile}: run the publish`);
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
        ? `${label(active.bundleId)} since ${active.activatedAt}${label(active.bundleId) === label(id) ? " (bundle v3.1)" : ""}`
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
      `readBundleValue by bundle id ${label(id)}: ${String(good)} of ${String(keys.length)} parts byte-identical (the manifest with decide-3, ${String(kinds.flow)} flow graph, ${String(kinds.trade)} trade overlays)${bad.length === 0 ? "" : `: ${bad.slice(0, 5).join("; ")}`}`,
    );
  } finally {
    await db.close();
  }
}

// ---- the command line -------------------------------------------------------------------------------------------

function args() {
  const usage = "usage: node bundles/v3.1/check.mjs [--full <full build folder>] [--db]";
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
