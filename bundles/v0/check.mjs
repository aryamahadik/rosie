// The checks of bundle v0 (T-163's "Proves it with"), run from the repository root:
//
//   node bundles/v0/check.mjs --step-js <step.js of a master copy> [--db]
//
//   --step-js  the master's step.js, in a read-only copy of the master (never the handover folder: rule 2), such as
//              scratch/fixture-v1-copy/engine/work/build/step.js; it is run as `node <step.js> A S1-01` and `A S1-02`.
//   --db       also read the published bundle back from PostgreSQL (DATABASE_URL, else the local database when CI is
//              unset; db/repo/client.ts): K-05's readActiveBundle, then readBundleValue for every part.
//
// What it checks, each printed as one line, ok or FAIL (exit 1 on any FAIL):
//   1. bundles/v0/bundle/ validates against K-01 v1 (the compiler's checkBundleDir, and each file against its own
//      definition), its bundle id is the content hash of its stored value (T-150), and it holds only S1-01 and S1-02 of
//      flow A, marked partial.
//   2. It matches contracts/bundle/fixtures/bundle-v0-skeleton.json's structure: the same flows, trades and step ids,
//      the same card fields (the card's keys, each meaning's branch and source, the never lines' count, the safe
//      default and the clock) and the same branch labels, in order.
//   3. S1-01's and S1-02's words equal what step.js prints for them, apart from slotted sample values: each step is
//      written in step.js's own lines (its title, lines, follows, does, more, each message's plain form and each
//      branch), a slot {{...}} standing for any words, and compared line by line with step.js's output.
//   4. S1-02's branch "Not a service we book" ends with its end text, and "One isn't on the list yet" leads to S1-03.
//   5. S1-02's question carries the opt-out marker, on Rosie's first reply in the chat the owner opened (T-141, Q-30);
//      the owner's own text carries none.
//   6. The manifest packs the AI layer's prompts as their modules give them, and models.json's routing (Q-26's default
//      with the two ids T-363's router accepts); prompts.json is what the modules give today.
//   7. The KV bulk file bundles/v0/bundle.kv.json holds one entry per part, every key under the bundle id, each value
//      the part's bytes.
//   8. With --db: readActiveBundle answers, and readBundleValue gives back every part byte for byte.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { BUNDLE_DIR, FLOW, HERE, PROMPTS_FILE, ROOT, STEPS, load, promptsFromModules } from "./build.mjs";

const SKELETON = join(ROOT, "contracts/bundle/fixtures/bundle-v0-skeleton.json");
const KV_FILE = `${BUNDLE_DIR}.kv.json`;
const PROMPT_KINDS = ["safetyRead", "decide", "planner", "composer"];

let failed = 0;

function report(ok, what) {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function args() {
  const given = process.argv.slice(2);
  const out = { stepJs: null, db: false };
  for (let k = 0; k < given.length; k += 1) {
    if (given[k] === "--db") out.db = true;
    else if (given[k] === "--step-js" && given[k + 1] !== undefined) {
      out.stepJs = isAbsolute(given[k + 1]) ? given[k + 1] : resolve(process.cwd(), given[k + 1]);
      k += 1;
    } else throw new Error(`usage: node bundles/v0/check.mjs --step-js <step.js> [--db] (not "${given[k]}")`);
  }
  if (out.stepJs === null) throw new Error("usage: node bundles/v0/check.mjs --step-js <step.js> [--db]");
  return out;
}

// ---- 1. K-01 v1, the id, what it holds ----------------------------------------------------------------------------

async function checkBundle(emit, ids) {
  const problems = emit.checkBundleDir(BUNDLE_DIR);
  report(problems.length === 0, `K-01 v1 (checkBundleDir, Ajv 2020-12 strict): ${problems.length === 0 ? "valid" : problems.slice(0, 5).join("; ")}`);
  const read = emit.readBundleDir(BUNDLE_DIR);
  const { manifest, flows, trades } = read.bundle;
  const own = [
    ...emit.checkBundlePart(manifest, "manifest").map((p) => `manifest ${p}`),
    ...Object.entries(flows).flatMap(([flow, graph]) => emit.checkBundlePart(graph, "flowGraph").map((p) => `flow ${flow} ${p}`)),
  ];
  report(own.length === 0, `each file against its own definition (manifest, flowGraph): ${own.length === 0 ? "valid" : own.join("; ")}`);
  const idProblems = ids.bundleIdProblems(manifest);
  const hash = ids.contentHashOfFiles(read.files);
  report(
    idProblems.length === 0 && hash === manifest.bundleId.hash,
    `bundle id ${manifest.bundleId.hash}/${String(manifest.bundleId.build)}: ${idProblems.length === 0 && hash === manifest.bundleId.hash ? "the content hash of its stored values (T-150)" : [...idProblems, `files hash to ${hash}`].join("; ")}`,
  );
  const paths = read.files.map((file) => file.path);
  report(same(paths, ["flow/A.json", "manifest.json"]), `files: ${paths.join(", ")}`);
  report(
    manifest.partial === true && same(Object.keys(flows), [FLOW]) && Object.keys(trades).length === 0,
    `partial: ${String(manifest.partial)}; flows: ${Object.keys(flows).join(", ")}; trades: ${String(Object.keys(trades).length)}`,
  );
  report(same(Object.keys(flows[FLOW].steps), STEPS), `steps of flow ${FLOW}: ${Object.keys(flows[FLOW].steps).join(", ")}`);
  const lint = manifest.lint;
  report(
    lint.failures.length === 0 && lint.rules.every((rule) => rule.failures === 0) && STEPS.every((id) => flows[FLOW].steps[id].lint.length === 0),
    `lint summary: ${lint.rules.map((rule) => `${rule.rule} ${String(rule.failures)}`).join(", ")}; failing steps: ${String(lint.failures.length)}`,
  );
  return read;
}

// ---- 2. the skeleton's structure ----------------------------------------------------------------------------------

/** A card's fields: the set of its keys (a JSON object's key order means nothing), each meaning's branch and source. */
function cardFields(card) {
  if (card === undefined) return null;
  return {
    keys: Object.keys(card).sort(),
    means: card.means.map((meaning) => ({ branch: meaning.branch, from: meaning.from, text: meaning.text !== undefined })),
    never: card.never.length,
    safeDefault: card.safeDefault !== undefined,
    clock: card.clock === undefined ? null : Object.keys(card.clock).sort(),
  };
}

/** JSON with every object's keys sorted, so two values compare equal whatever their key order. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function checkSkeleton(bundle) {
  const skeleton = JSON.parse(readFileSync(SKELETON, "utf8"));
  report(
    same(Object.keys(bundle.flows), Object.keys(skeleton.flows)) && same(Object.keys(bundle.trades), Object.keys(skeleton.trades)),
    `flows and trades as the skeleton's: flows ${Object.keys(skeleton.flows).join(", ")}, trades ${String(Object.keys(skeleton.trades).length)}`,
  );
  const ours = bundle.flows[FLOW].steps;
  const theirs = skeleton.flows[FLOW].steps;
  report(same(Object.keys(ours), Object.keys(theirs)), `step ids as the skeleton's: ${Object.keys(theirs).join(", ")}`);
  for (const id of Object.keys(theirs)) {
    const a = cardFields(ours[id]?.card);
    const b = cardFields(theirs[id].card);
    report(same(a, b), `${id} card fields as the skeleton's: ${b === null ? "no card" : `${b.keys.join(", ")}; means ${b.means.map((m) => `${m.branch} (${m.from})`).join(", ")}`}`);
    if (theirs[id].card !== undefined)
      report(
        canonical(ours[id]?.card) === canonical(theirs[id].card),
        `${id} card's words and values as the skeleton's (question, means, never, safe default, clock)`,
      );
    const labels = (step) => (step?.branches ?? []).map((branch) => branch.label);
    report(same(labels(ours[id]), labels(theirs[id])), `${id} branch labels as the skeleton's: ${labels(theirs[id]).join(" | ") || "none"}`);
    const shape = (step) => (step?.branches ?? []).map((b) => [b.label, b.tag, b.steps, b.end ?? null, b.endText ?? null, b.rejoinAt ?? null]);
    report(same(shape(ours[id]), shape(theirs[id])), `${id} branches' tags, steps, ends, end texts and rejoins as the skeleton's`);
    const keysA = Object.keys(ours[id] ?? {});
    const keysB = Object.keys(theirs[id]);
    const extra = keysA.filter((key) => !keysB.includes(key));
    const missing = keysB.filter((key) => !keysA.includes(key));
    console.log(`     ${id} fields beside the skeleton's: ${extra.length === 0 ? "none added" : `added ${extra.join(", ")}`}; ${missing.length === 0 ? "none left out" : `left out ${missing.join(", ")}`}`);
  }
  // The sections list the master's steps (they are not v0's: a step v0 does not hold is not reachable). The skeleton was
  // written before Master Corrections' C2 (T-138): a compiled section leaves out a step a correction switched off.
  const listed = (graph) => graph.sections.flatMap((section) => section.steps);
  const ourIds = listed(bundle.flows[FLOW]);
  const theirIds = listed(skeleton.flows[FLOW]);
  report(
    same(bundle.flows[FLOW].sections.map((s) => [s.n, s.title]), skeleton.flows[FLOW].sections.map((s) => [s.n, s.title])),
    `sections as the skeleton's: ${String(skeleton.flows[FLOW].sections.length)} sections, the same numbers and titles`,
  );
  const gone = theirIds.filter((id) => !ourIds.includes(id));
  const added = ourIds.filter((id) => !theirIds.includes(id));
  console.log(
    `     the sections' steps beside the skeleton's: ${String(ourIds.length)} listed; ${gone.length === 0 ? "none left out" : `left out ${gone.join(", ")}`}; ${added.length === 0 ? "none added" : `added ${added.join(", ")}`}`,
  );
}

// ---- 3 and 4. step.js's words, and the branches ---------------------------------------------------------------------

/** A line with slots: its literal parts escaped, each {{...}} any words (at least one character). */
function pattern(line) {
  const parts = line.split(/(\{\{[^{}]+\}\})/);
  return new RegExp(
    `^${parts.map((part) => (/^\{\{[^{}]+\}\}$/.test(part) ? "(.+?)" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("")}$`,
    "s",
  );
}

/** The step written as step.js writes it (step.js lines 49 to 58 and 74; the fields S1-01 and S1-02 use). */
function asStepJs(step, homes) {
  const lines = [];
  lines.push(`### ${step.id} · ${step.title}${step.type === "split" ? `  ◆ ${step.q}` : ""}`);
  lines.push(
    `- lines ${(step.lines ?? []).join(", ")} · ${step.who}${step.to ? ` → ${step.to}` : ""} · ${step.via}${step.t ? ` · ${step.t}` : ""} · needs ${(step.needs ?? []).join(" ")} · gives ${(step.gives ?? []).join(" ")}`,
  );
  if (Array.isArray(step.reads) && step.reads.length > 0)
    lines.push(`- follows: ${step.reads.map((r) => r + (homes[r] ? ` (${homes[r]})` : "")).join(" · ")}`);
  if (step.does) lines.push(`- ${step.does}`);
  for (const more of step.more ?? []) lines.push(`  - ${more}`);
  for (const said of step.say ?? []) lines.push(`    ${said.from} → ${said.to}: ${said.plainText.replace(/\n/g, " / ")}`);
  for (const b of step.branches ?? [])
    lines.push(`  > branch: ${b.label}${b.end === "end" ? ` → ends: ${b.endText}` : " → rejoins"} · first step ${b.steps[0] ?? "undefined"}`);
  return lines;
}

function checkWords(bundle, stepJs) {
  if (!existsSync(stepJs)) {
    report(false, `step.js not found at ${stepJs}`);
    return;
  }
  const graph = bundle.flows[FLOW];
  const homes = graph.record?.homes ?? {};
  for (const id of STEPS) {
    const printed = execFileSync(process.execPath, [stepJs, FLOW, id], { encoding: "utf8" }).replace(/\n+$/, "").split("\n");
    const ours = asStepJs(graph.steps[id], homes);
    const fills = [];
    const differ = [];
    const count = Math.max(printed.length, ours.length);
    for (let k = 0; k < count; k += 1) {
      const want = ours[k];
      const got = printed[k];
      const match = want === undefined || got === undefined ? null : pattern(want).exec(got);
      if (match === null) differ.push(`line ${String(k + 1)}: bundle "${want ?? "(none)"}" vs step.js "${got ?? "(none)"}"`);
      else {
        const slots = want.match(/\{\{[^{}]+\}\}/g) ?? [];
        slots.forEach((slot, n) => fills.push(`${slot} = "${match[n + 1]}"`));
      }
    }
    report(
      differ.length === 0,
      `${id}'s words equal \`node step.js ${FLOW} ${id}\`, ${String(printed.length)} lines${fills.length === 0 ? ", no slot" : `, apart from the slotted sample values ${fills.join(", ")}`}${differ.length === 0 ? "" : `: ${differ.join(" | ")}`}`,
    );
  }
  const s102 = graph.steps["S1-02"];
  const branch = (label) => s102.branches.find((b) => b.label === label);
  const notBooked = branch("Not a service we book");
  const notListed = branch("One isn't on the list yet");
  report(
    notBooked?.end === "end" && typeof notBooked.endText === "string" && notBooked.endText !== "",
    `S1-02 "Not a service we book" ends (end: ${String(notBooked?.end)}) with its end text: "${String(notBooked?.endText)}"`,
  );
  report(
    same(notListed?.steps, ["S1-03"]),
    `S1-02 "One isn't on the list yet" leads to ${String(notListed?.steps?.join(", "))} (end: ${String(notListed?.end)}, rejoins at ${String(notListed?.rejoinAt)})`,
  );
}

// ---- 5. the opt-out marker ------------------------------------------------------------------------------------------

function checkStop(bundle) {
  const steps = bundle.flows[FLOW].steps;
  const first = steps["S1-02"].say[0];
  const owners = [...steps["S1-01"].say, ...steps["S1-02"].say.slice(1)];
  report(
    first.from === "san" && first.to === "owner" && (first.elements?.stop === true || first.elements?.stop === "first"),
    `S1-02's question (Rosie to the owner, her first reply in the chat S1-01 opened) carries the opt-out marker: stop ${JSON.stringify(first.elements?.stop)} (T-141, Q-30); its plain form ends with the line msgtext.js writes for it`,
  );
  report(
    owners.every((said) => said.from === "owner" && said.elements?.stop === undefined),
    "the owner's own texts (S1-01, S1-02's reply) carry no marker",
  );
}

// ---- 6. prompts and routing -----------------------------------------------------------------------------------------

async function checkManifest(bundle) {
  const manifest = bundle.manifest;
  const given = await promptsFromModules();
  for (const kind of PROMPT_KINDS) {
    const want = given[kind].prompt;
    const got = manifest.prompts[kind];
    report(
      got.version === want.version && got.sha256 === want.sha256 && got.text === want.text && got.sha256 === sha256(got.text),
      `prompt ${kind}: ${got.version}, sha256 ${got.sha256}, as ${given[kind].from}`,
    );
  }
  const file = JSON.parse(readFileSync(PROMPTS_FILE, "utf8"));
  report(
    PROMPT_KINDS.every((kind) => file[kind].version === given[kind].prompt.version && file[kind].text === given[kind].prompt.text),
    "prompts.json is what the prompt modules give today",
  );
  const models = JSON.parse(readFileSync(join(HERE, "models.json"), "utf8"));
  report(
    same(manifest.models, models.models) && same(manifest.policy, models.policy),
    `models ${JSON.stringify(manifest.models)}; policy ${JSON.stringify(manifest.policy)}`,
  );
  report(
    same(manifest.models, { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5" }) &&
      same(manifest.policy, { low: { first: "haiku", second: "haiku" }, high: { first: "sonnet", second: "haiku" }, reread: "sonnet" }),
    "routing is Q-26's default (high: Sonnet then Haiku; low: Haiku twice; re-read: Sonnet) with the two ids the router accepts (T-363)",
  );
}

// ---- 7. the KV bulk file --------------------------------------------------------------------------------------------

function checkKv(read) {
  if (!existsSync(KV_FILE)) {
    report(false, `no KV bulk file ${KV_FILE} (run the publish)`);
    return;
  }
  const entries = JSON.parse(readFileSync(KV_FILE, "utf8"));
  const id = read.bundle.manifest.bundleId;
  const prefix = `bundle/${id.hash}/${String(id.build)}/`;
  const byPath = new Map(read.files.map((file) => [file.path, file.text]));
  const ok =
    Array.isArray(entries) &&
    entries.length === read.files.length &&
    entries.every((entry) => entry.key.startsWith(prefix) && byPath.get(`${entry.key.slice(prefix.length)}.json`) === entry.value);
  report(ok, `KV bulk file: ${String(entries.length)} entries, one per part, every key under ${prefix}, each value the part's bytes`);
}

// ---- 8. PostgreSQL --------------------------------------------------------------------------------------------------

async function checkDb(read) {
  const client = await load("db/repo/client.ts");
  const bundles = await load("db/repo/bundles.ts");
  const db = client.createClient({ max: 2 });
  try {
    const active = await bundles.readActiveBundle(db.primary);
    const id = read.bundle.manifest.bundleId;
    const label =
      "result" in active
        ? `${active.bundleId.hash}/${String(active.bundleId.build)} since ${active.activatedAt}${active.bundleId.hash === id.hash && active.bundleId.build === id.build ? " (bundle v0)" : ""}`
        : active.error === "noActiveBundle"
          ? "none is active (noActiveBundle): publishing never switches it; the release engineer's deploy step 3 sets it on staging"
          : `transient ${active.sqlstate}`;
    report(!("error" in active) || active.error === "noActiveBundle", `readActiveBundle: ${label}`);
    const storage = read.bundle.manifest.storage;
    const keys = [storage.manifestKey, ...storage.values.map((value) => value.key)];
    const prefix = `bundle/${id.hash}/${String(id.build)}/`;
    const byPath = new Map(read.files.map((file) => [file.path, file.text]));
    let good = 0;
    for (const key of keys) {
      const answer = await bundles.readBundleValue(db.primary, { key });
      const text = byPath.get(`${key.slice(prefix.length)}.json`);
      const okPart =
        "result" in answer &&
        answer.value.text === text &&
        answer.value.sha256 === sha256(text) &&
        answer.value.bytes === Buffer.byteLength(text, "utf8");
      if (okPart) good += 1;
      else console.log(`     ${key}: ${"error" in answer ? answer.error : "not the file's bytes"}`);
    }
    report(good === keys.length, `readBundleValue by bundle id: ${String(good)} of ${String(keys.length)} parts byte-identical (${keys.map((key) => key.slice(prefix.length)).join(", ")})`);
  } finally {
    await db.close();
  }
}

async function main() {
  const given = args();
  const emit = await load("compiler/src/emit/index.ts");
  const ids = await load("compiler/src/bundle-id/index.ts");
  const read = await checkBundle(emit, ids);
  checkSkeleton(read.bundle);
  checkWords(read.bundle, given.stepJs);
  checkStop(read.bundle);
  await checkManifest(read.bundle);
  checkKv(read);
  if (given.db) await checkDb(read);
  console.log(failed === 0 ? "all checks passed" : `${String(failed)} checks failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
