// The S1-09 eval slice's live run (T-1555 Gives 7; skill run-evals): each item of slice.ts read by a real model, both
// reads, once, on bundle v3 with decide-3 in decide-2's place (bundle cut v3.1, T-1556), behind the real router, decide's
// one read, the AI gateway (its retry, fallback and prompt cache), the comparison and the backstop. It writes the report
// lines to stdout and the result to evals/src/slices/s1-09/result.json.
//
//   node --experimental-transform-types evals/src/slices/s1-09/run.mjs --candidate <commit>
//
// (--experimental-transform-types: limit 6's value readers, which score each item, use TypeScript parameter properties,
// which Node's default type stripping refuses.)
//
// The model key comes from the run's environment (ANTHROPIC_API_KEY), never from a file (rule 7); without it the run
// refuses before any call. Nothing here prints, logs or writes the key, and the gateway puts it only in the x-api-key
// header. Each item runs once: an unchanged candidate is never run again for a better number (BP 7.9). A turn the models
// did not answer (modelsDown: a 429 or 5xx after the gateway's retry and fallback) is not a miss (BP 7.8): the report
// names it, and the run may be made once more.
//
// Beside each score it records, from each step-2 answer as the model sent it (before the backstop), whether the model's
// own business value already equalled its words: what decide-3's rule d did on its own. Only the item's test words are
// recorded, never a key or a header.

import { readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..", "..");
const RESULT_FILE = join(HERE, "result.json");
const KEY_VARIABLE = "ANTHROPIC_API_KEY";

// Lets Node complete the repository's extensionless relative imports from a .ts file (`./core` is `./core.ts`,
// `../path` `../path/index.ts`), as bundles/v1/build.mjs does for the AI layer's modules.
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
  // A repository .ts module imports a JSON schema with no import attribute, as its bundler allows: load it as JSON.
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && url.endsWith(".json"))
      return nextLoad(url, { ...context, importAttributes: { ...context.importAttributes, type: "json" } });
    return nextLoad(url, context);
  },
});

const load = (path) => import(pathToFileURL(join(ROOT, ...path.split("/"))).href);

function argOf(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? null : (process.argv[at + 1] ?? null);
}

const percent = (x) => `${(100 * x).toFixed(1)}%`;

/** The step a request asked for, from its user message's last tag: 1, or 2 with its part (1-based). */
function stepOfRequest(init) {
  try {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const content = body.messages?.[0]?.content ?? "";
    const match = /<step n="([12])"(?: part="([0-9]+)")?><\/step>$/u.exec(content);
    if (match === null) return null;
    return match[1] === "1" ? { n: 1 } : { n: 2, part: Number(match[2]) };
  } catch {
    return null;
  }
}

/**
 * A fetch that passes each call through and keeps, for each step-2 answer, the business field's value and words as the
 * model wrote them (its text block's JSON), before the AI layer maps or sets them.
 */
function capturingFetch(seen) {
  return async (url, init) => {
    const response = await fetch(url, init);
    const step = stepOfRequest(init);
    if (step?.n === 2 && response.ok) {
      try {
        const body = await response.clone().json();
        const block = (body.content ?? []).find((item) => item?.type === "text");
        const output = JSON.parse(block?.text ?? "null");
        for (const field of output?.fields ?? [])
          if (field?.name === "business") seen.push({ value: field.value, words: field.words });
      } catch {
        seen.push({ value: null, words: null, unreadable: true });
      }
    }
    return response;
  };
}

async function main() {
  const candidate = argOf("--candidate");
  if (candidate === null) {
    console.error(
      "usage: node --experimental-transform-types evals/src/slices/s1-09/run.mjs --candidate <commit>",
    );
    process.exitCode = 2;
    return;
  }
  // Everything but the calls first, so a run with no key still proves the slice loads and lays out each item's turn.
  const slice = await load("evals/src/slices/s1-09/slice.ts");
  const { createPromptCache } = await load("ai/src/cache/index.ts");
  const { buildContextPrompt } = await load("ai/src/context/index.ts");
  const { createDecider, DECIDE_3_PROMPT } = await load("ai/src/decide/index.ts");
  const { wilsonInterval } = await load("evals/src/stats/index.ts");

  const v3 = slice.readBundleV3(ROOT);
  const prompts = createPromptCache(slice.cacheBundleV31(v3));
  const bundle = slice.routingBundleV3(v3);
  for (const item of slice.S1_09_ITEMS)
    buildContextPrompt(prompts, slice.s1_09Context(v3, item), { purpose: "decideFirst", seed: 1 });
  console.log(
    `ready: ${String(slice.S1_09_ITEMS.length)} items laid out on bundle v3 ${v3.manifest.bundleId.hash.slice(0, 8)} with ${DECIDE_3_PROMPT.version} (sha256 ${DECIDE_3_PROMPT.sha256})`,
  );

  const key = process.env[KEY_VARIABLE];
  if (typeof key !== "string" || key.trim() === "") {
    console.error(
      `refused: ${KEY_VARIABLE} is not set in the environment (it is never read from a file). No call made.`,
    );
    process.exitCode = 3;
    return;
  }
  const items = [];
  for (const item of slice.S1_09_ITEMS) {
    const seen = [];
    const decider = createDecider({ bundle, prompts, env: process.env, fetch: capturingFetch(seen) });
    const answer = await decider.decide(slice.s1_09Context(v3, item));
    const score = slice.scoreItem(item, answer);
    const reads =
      answer.status === "decided"
        ? answer.result.reads.map((read) => ({ role: read.role, model: read.model, output: read.output }))
        : [];
    items.push({
      ...score,
      text: item.text,
      form: item.form,
      expectedWords: item.details,
      modelValues: seen,
      modelValuesAreWords: seen.length > 0 && seen.every((each) => each.value === each.words),
      reads,
      models: answer.modelCalls.map((call) => call.model),
    });
  }

  const down = items.filter((item) => item.status === "modelsDown");
  const counted = items.filter((item) => item.status !== "modelsDown");
  const right = counted.filter((item) => item.right).length;
  const costMicroUsd = items.reduce((sum, item) => sum + item.costMicroUsd, 0);
  const calls = items.reduce((sum, item) => sum + item.calls, 0);
  const interval = counted.length > 0 ? wilsonInterval(right, counted.length) : null;
  const ownRight = counted.filter((item) => item.modelValuesAreWords).length;

  const result = {
    slice: slice.SLICE,
    candidate,
    bundle: `bundle v3 ${v3.manifest.bundleId.hash.slice(0, 8)} with ${DECIDE_3_PROMPT.version} (sha256 ${DECIDE_3_PROMPT.sha256})`,
    baseline: "bundle v3 with decide-2 (the Nov 23 phone test, DL-1213: S1-09 asked again)",
    ranAt: new Date().toISOString(),
    right,
    total: counted.length,
    modelsDown: down.map((item) => item.id),
    interval,
    modelValuesEqualWords: { right: ownRight, total: counted.length },
    costMicroUsd,
    costUsd: costMicroUsd / 1e6,
    calls,
    items,
  };
  writeFileSync(RESULT_FILE, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  const lines = [
    `Eval · smoke slice ${slice.SLICE} · candidate ${candidate}, ${result.bundle} · baseline ${result.baseline}`,
    interval === null
      ? "S1-09 right: none counted"
      : `S1-09 right (both reads agree, c-01, business words as typed, value = words, limit 6's id rule passes): ${String(right)} of ${String(counted.length)} (${percent(right / counted.length)}; 95% interval ${percent(interval.lower)}–${percent(interval.upper)}; not yet proven at this size)`,
    `Model's own value equal to its words before the backstop (decide-3's rule d alone): ${String(ownRight)} of ${String(counted.length)} items`,
    ...items.map(
      (item) =>
        `  ${item.id} (${item.form}): ${item.right ? "RIGHT" : "WRONG"} · status ${item.status} · agreed ${String(item.agreed)} · choice ${String(item.choice)} · words ${JSON.stringify(item.words)} · value = words ${String(item.valueIsWords)} · limit 6 ${item.limit6Passes ? "pass" : "fail"} · settler's first try ${JSON.stringify(item.settlerFirstTry)} · model values ${JSON.stringify(item.modelValues.map((each) => each.value))} · ${String(item.calls)} calls, $${(item.costMicroUsd / 1e6).toFixed(6)}`,
    ),
    `Models down (not a miss, BP 7.8): ${down.length === 0 ? "none" : down.map((item) => item.id).join(", ")}`,
    `Cost: $${(costMicroUsd / 1e6).toFixed(6)} for ${String(calls)} model calls (the gateway's K-08 cost_micro_usd, ai/src/gateway/prices.ts)`,
    `Result: ${RESULT_FILE}`,
  ];
  console.log(lines.join("\n"));
  // The slice's own words never hold the key; a last guard that nothing written carries it.
  if (readFileSync(RESULT_FILE, "utf8").includes(key)) throw new Error("the result must never hold the key");
}

await main();
