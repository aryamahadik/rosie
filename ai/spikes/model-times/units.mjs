// What the spike measures (T-362), built from the production code alone: the AI layer's own readers (ai/src), on
// staging's own bundle (bundles/v0/bundle, the bundle staging runs: its manifest's prompts, models and routing policy,
// and its flow A graph), each call through the AI gateway's client and its K-08 spans (T-361), as
// runtime/src/wiring/staging/models.ts builds the three readers on staging. Nothing here changes a prompt, a model, a
// timeout or a route: the spike only times them.
//
// The units (one turn's piece each, run one at a time, in rounds, so a slow minute at Anthropic falls on every stage):
//
//   safety-haiku    one safety read (createSafetyReader, its own path outside the gateway: Haiku, one 2 s try)
//   safety-sonnet   one safety read whose Haiku try is answered here as overloaded (wire.mjs), so its Sonnet try runs
//                   for real, as when Haiku fails on staging
//   decide-pair     decide on the S1-02 turn (createDecider): two Haiku reads side by side (bundle v0's low-stakes
//                   route), each step 1 then step 2: four calls; the unit's time is the decide stage's
//   decide-sonnet   one decide read on Sonnet (createDecideReader, purpose decideFirst: a high-stakes turn's first read)
//   reread-sonnet   the turn's one re-read (the same read, purpose reread, on Sonnet: bundle v0's policy.reread)
//   compose-haiku   one composer call (createComposer) for S1-02's outbox row (K-03 v1.1 input-s1-02-v1.1.json)
//   compose-sonnet  the same call with both Haiku attempts answered here as overloaded, so the gateway's fallback, Sonnet,
//                   runs for real
//   rewrite-haiku   the composer's one rewrite (A7-17's row and its two-question plan, told what check-two-questions.json
//                   tells: the rewrite tests' own case)
//
// Every value is fiction from the contracts' fixtures and the master's sample cast (rule 9); a writer's handle is a
// 555-01xx number. No unit keeps a word of a prompt or an answer: only labels, counts and times leave this file.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "..", "..", "..");

/** Staging's bundle, as the repository holds it (bundles/v0: T-163, T-1146). */
export const BUNDLE_DIR = "bundles/v0/bundle";
const PROMPT_KINDS = ["safetyRead", "decide", "planner", "composer"];

let hooked = false;

/**
 * Lets Node complete the repository's extensionless relative imports from a .ts file (`./core` is `./core.ts`,
 * `../path` `../path/index.ts`), as bundles/v0/build.mjs does to load the AI layer's own modules, and load a JSON file a
 * .ts file imports with no import attribute (the contracts' schemas, as the bundler and Vitest load them) as a module
 * whose default export is the file's value.
 */
export function completeImports() {
  if (hooked) return;
  hooked = true;
  registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith("file:") && url.endsWith(".json") && context.importAttributes?.type !== "json") {
        const text = readFileSync(fileURLToPath(url), "utf8");
        return {
          format: "module",
          source: `export default ${JSON.stringify(JSON.parse(text))};`,
          shortCircuit: true,
        };
      }
      return nextLoad(url, context);
    },
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

const fromRoot = (path) => join(ROOT, ...path.split("/"));

/** A repository module, loaded once the resolve hook is in place. */
export async function load(path) {
  completeImports();
  return import(pathToFileURL(fromRoot(path)).href);
}

export const readText = (path) => readFileSync(fromRoot(path), "utf8");
export const readJson = (path) => JSON.parse(readText(path));

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** The production modules the units run (the AI layer's own, and the runtime's trace for their spans). */
export async function loadProduction() {
  return {
    gateway: await load("ai/src/gateway/index.ts"),
    cache: await load("ai/src/cache/index.ts"),
    safety: await load("ai/src/safety/index.ts"),
    decide: await load("ai/src/decide/index.ts"),
    composer: await load("ai/src/composer/index.ts"),
    rewriteCase: await load("ai/src/composer/rewrite/test-support.ts"),
    trace: await load("runtime/src/trace/index.ts"),
  };
}

/**
 * Bundle v0 as staging's readers take it (runtime/src/wiring/staging/models.ts): the manifest's id, models, routing
 * policy and four prompts, and flow A's always-on rules and step cards. Flow A must be the bytes the manifest lists.
 */
export function readBundleV0() {
  const manifest = readJson(`${BUNDLE_DIR}/manifest.json`);
  const listed = (manifest.storage?.values ?? []).find(
    (value) => value.kind === "flow" && value.flow === "A",
  );
  const text = readText(`${BUNDLE_DIR}/flow/A.json`);
  if (
    listed === undefined ||
    listed.sha256 !== sha256(text) ||
    listed.bytes !== Buffer.byteLength(text, "utf8")
  )
    throw new Error(`${BUNDLE_DIR}/flow/A.json is not the flow A its manifest lists`);
  const graph = JSON.parse(text);
  const steps = Object.fromEntries(
    Object.entries(graph.steps).map(([id, step]) => [
      id,
      step?.card === undefined ? {} : { card: step.card },
    ]),
  );
  const prompts = Object.fromEntries(
    PROMPT_KINDS.map((kind) => {
      const { version, sha256: hash, text: words } = manifest.prompts[kind];
      return [kind, { version, sha256: hash, text: words }];
    }),
  );
  return {
    bundleId: { hash: manifest.bundleId.hash, build: manifest.bundleId.build },
    models: { haiku: manifest.models.haiku, sonnet: manifest.models.sonnet },
    policy: manifest.policy,
    partial: manifest.partial === true,
    prompts,
    flowA: { flow: "A", steps, routing: { alwaysOn: graph.routing.alwaysOn } },
    promptVersions: Object.fromEntries(PROMPT_KINDS.map((kind) => [kind, manifest.prompts[kind].version])),
  };
}

/** K-02 v1's S1-02 context (context-s1-02.json) on bundle v0: its id, flow A's always-on rules and S1-02's own card. */
export function decideContext(bundle, turnId) {
  const fixture = readJson("contracts/model/fixtures/context-s1-02.json");
  const card = bundle.flowA.steps["S1-02"]?.card;
  if (card === undefined) throw new Error("bundle v0 holds no S1-02 card");
  return {
    ...fixture,
    turnId,
    bundleId: { ...bundle.bundleId },
    alwaysOn: { flow: "A", prefixSha256: bundle.flowA.routing.alwaysOn.prefixSha256 },
    cards: [{ step: "S1-02", card }],
  };
}

/** The ordinary texts the safety reads take, in turn: S1-02's owner answer and the JOIN-time first text (K-02, K-03). */
export function safetyTexts() {
  const context = readJson("contracts/model/fixtures/context-s1-02.json");
  const input = readJson("contracts/message-plan/fixtures/input-s1-02-v1.1.json");
  return [context.texts[0].words, input.inbound.text];
}

/** The inputs of the composer's two units: S1-02's row, and the rewrite tests' A7-17 case. */
export function composerCases(production) {
  const check = readJson("contracts/message-plan/fixtures/check-two-questions.json");
  const told = check.checks
    .filter((entry) => entry.passed === false)
    .map((entry) => ({ check: entry.check, detail: entry.detail }));
  return {
    composeInput: readJson("contracts/message-plan/fixtures/input-s1-02-v1.1.json"),
    rewriteRequest: {
      input: production.rewriteCase.A7_17_INPUT,
      plan: production.rewriteCase.TWO_QUESTIONS_PLAN,
      attempt: "composed",
      told,
    },
  };
}

/** The readers, as staging builds them from a bundle (runtime/src/wiring/staging/models.ts), over the run's fetch. */
export function buildReaders(production, bundle, { fetch, env }) {
  const { createPromptCache } = production.cache;
  const cacheBundle = (flows) => ({
    manifest: { bundleId: bundle.bundleId, prompts: bundle.prompts, partial: bundle.partial },
    flows,
  });
  const gatewayBundle = { bundleId: bundle.bundleId, models: bundle.models };
  const decidePrompts = createPromptCache(cacheBundle({ A: bundle.flowA }));
  return {
    safetyReader: production.safety.createSafetyReader({
      bundle: gatewayBundle,
      prompts: createPromptCache(cacheBundle({})),
      env,
      fetch,
    }),
    decider: production.decide.createDecider({
      bundle: { ...gatewayBundle, policy: bundle.policy },
      prompts: decidePrompts,
      env,
      fetch,
    }),
    reader: production.decide.createDecideReader({
      bundle: gatewayBundle,
      prompts: decidePrompts,
      env,
      fetch,
    }),
    composer: production.composer.createComposer({
      bundle: gatewayBundle,
      prompts: createPromptCache(cacheBundle({})),
      env,
      fetch,
    }),
  };
}

/**
 * Names a request body's kind by its structured-output schema (the stages' own static schemas): safety, step1,
 * step2:<verb>, or plan (compose and the rewrite share K-03's plan schema). Null for anything else.
 */
export function classifier(production) {
  const known = new Map([
    [JSON.stringify(production.safety.SAFETY_READ_SCHEMA), "safety"],
    [JSON.stringify(production.decide.STAGE1_SCHEMA), "step1"],
    ...Object.entries(production.decide.STAGE2_SCHEMAS).map(([verb, schema]) => [
      JSON.stringify(schema),
      `step2:${verb}`,
    ]),
    [JSON.stringify(production.composer.PLAN_SCHEMA), "plan"],
  ]);
  return (body) => {
    try {
      const parsed = JSON.parse(body);
      return known.get(JSON.stringify(parsed?.output_config?.format?.schema)) ?? null;
    } catch {
      return null;
    }
  };
}

/**
 * The units' kinds: the stage each times, the live calls one takes when every call answers first time, which bundle
 * roles its calls to are answered here as overloaded (the fallback on purpose), and the production call it makes.
 */
export const UNIT_KINDS = Object.freeze({
  "safety-haiku": { stage: "safety", calls: 1, inject: [] },
  "safety-sonnet": { stage: "safety", calls: 1, inject: ["haiku"] },
  "decide-pair": { stage: "decide", calls: 4, inject: [] },
  "decide-sonnet": { stage: "decide", calls: 2, inject: [] },
  "reread-sonnet": { stage: "reread", calls: 2, inject: [] },
  "compose-haiku": { stage: "compose", calls: 1, inject: [] },
  "compose-sonnet": { stage: "compose", calls: 1, inject: ["haiku"] },
  "rewrite-haiku": { stage: "rewrite", calls: 1, inject: [] },
});

/** How many units of each kind one run makes: 35 calls when every call answers first time, 5 under the cap of 40. */
export const PLAN = Object.freeze([
  ["safety-haiku", 5],
  ["decide-pair", 3],
  ["reread-sonnet", 2],
  ["compose-haiku", 3],
  ["rewrite-haiku", 2],
  ["safety-sonnet", 3],
  ["decide-sonnet", 2],
  ["compose-sonnet", 2],
]);

/** The card's limit: at most 40 smoke-size live calls in all (T-362; DL-027; DL-860). */
export const CALL_LIMIT = 40;

/** The plan's units in rounds: one of each kind still owed per round, in the plan's order. */
export function schedule(plan = PLAN) {
  const owed = plan.map(([kind, count]) => ({ kind, count, made: 0 }));
  const units = [];
  while (owed.some((entry) => entry.made < entry.count)) {
    for (const entry of owed) {
      if (entry.made >= entry.count) continue;
      entry.made += 1;
      units.push({ kind: entry.kind, i: entry.made, unit: `${entry.kind}-${String(entry.made)}` });
    }
  }
  return units;
}

/** The live calls a plan takes when every call answers first time. */
export function plannedCalls(plan = PLAN) {
  return plan.reduce((sum, [kind, count]) => sum + UNIT_KINDS[kind].calls * count, 0);
}

/** The stage each K-08 model-call purpose belongs to, as the tables name it. */
export const STAGE_OF_PURPOSE = Object.freeze({
  safetyRead: "safety read",
  decideFirst: "decide",
  decideCheck: "decide",
  reread: "re-read",
  compose: "compose",
  rewrite: "rewrite",
});

/** The unit's production call: what it hands the reader, and the label of what came back (never its words). */
async function call(kind, readers, inputs, unit, options) {
  switch (kind) {
    case "safety-haiku":
    case "safety-sonnet": {
      const texts = inputs.safetyTexts;
      const text = texts[(unit.i - 1) % texts.length];
      const answer = await readers.safetyReader.read(
        { eventId: `evt-spike-${unit.unit}`, source: "text", text },
        options,
      );
      return answer.result.timedOut ? "noVerdict" : "verdict";
    }
    case "decide-pair":
      return (await readers.decider.decide(inputs.context(unit), options)).status;
    case "decide-sonnet":
      return (
        await readers.reader.read(inputs.context(unit), { purpose: "decideFirst", model: "sonnet" }, options)
      ).status;
    case "reread-sonnet":
      return (
        await readers.reader.read(inputs.context(unit), { purpose: "reread", model: "sonnet" }, options)
      ).status;
    case "compose-haiku":
    case "compose-sonnet":
      return (await readers.composer.compose(inputs.composeInput, options)).status;
    case "rewrite-haiku":
      return (await readers.composer.rewrite(inputs.rewriteRequest, options)).status;
    default:
      throw new Error(`no unit kind ${String(kind)}`);
  }
}

/**
 * One model call of a unit, from its K-08 portCall span: labels, counts and times only. `injected` marks a call
 * answered here as a fallback on purpose; `capped`, one answered here past the cap: neither went out.
 */
export function rowsOfSpans(spans, unit, injectModels) {
  return spans
    .filter((span) => span.hop === "portCall" && Array.isArray(span.model_calls))
    .flatMap((span) =>
      span.model_calls.map((modelCall) => ({
        unit: unit.unit,
        kind: unit.kind,
        purpose: modelCall.purpose,
        stage: STAGE_OF_PURPOSE[modelCall.purpose] ?? modelCall.purpose,
        model: modelCall.model,
        attempt: span.attempt ?? null,
        at: span.at,
        ms: modelCall.ms,
        outcome: modelCall.outcome,
        errorCode: span.error_code ?? null,
        tokens: {
          input: modelCall.input_tokens,
          cachedRead: modelCall.cached_tokens,
          cacheWrite: modelCall.cache_write_tokens,
          output: modelCall.output_tokens,
        },
        costMicroUsd: modelCall.cost_micro_usd,
        injected: injectModels.includes(modelCall.model) && span.error_code === "http_529",
        capped: span.error_code === "http_599",
      })),
    );
}

/** A call that wrote the prompt cache (its prefix was not cached yet: a cold call). */
export const wroteCache = (row) => (row.tokens?.cacheWrite ?? 0) > 0;

/** A call that answered and read its prefix from the cache: a warm call. A call with no answer has no usage: neither. */
export const warmCall = (row) => row.outcome === "ok" && !wroteCache(row);

/**
 * Each read's time in a unit, by purpose: from its first call's start to its last call's end (the spans' at and ms); its
 * model is the last-ending call's. It is cold when any of its calls wrote the cache, and warm when every call that went
 * out was warm (a call answered here as a fallback on purpose is not one of them).
 */
export function readTimes(rows) {
  const byPurpose = new Map();
  for (const row of rows) {
    const start = Date.parse(row.at);
    const end = start + row.ms;
    const wentOut = !row.injected && !row.capped;
    const seen = byPurpose.get(row.purpose);
    if (seen === undefined) {
      byPurpose.set(row.purpose, {
        start,
        end,
        model: row.model,
        cold: wroteCache(row),
        warm: !wentOut || warmCall(row),
      });
    } else {
      seen.start = Math.min(seen.start, start);
      if (end >= seen.end) seen.model = row.model;
      seen.end = Math.max(seen.end, end);
      seen.cold = seen.cold || wroteCache(row);
      seen.warm = seen.warm && (!wentOut || warmCall(row));
    }
  }
  return [...byPurpose.entries()].map(([purpose, read]) => ({
    purpose,
    stage: STAGE_OF_PURPOSE[purpose] ?? purpose,
    model: read.model,
    ms: read.end - read.start,
    cold: read.cold,
    warm: read.warm,
  }));
}

/**
 * Runs one unit through the production code on its own trace (one trace per unit, as one turn has one), and returns
 * its wall time, what came back (a label), its calls' rows and its reads' times.
 */
export async function runUnit({
  production,
  bundle,
  readers,
  inputs,
  wire,
  unit,
  now = () => performance.now(),
}) {
  const spec = UNIT_KINDS[unit.kind];
  const injectModels = spec.inject.map((role) => bundle.models[role]);
  wire.setUnit({ unit: unit.unit, kind: unit.kind, inject: injectModels });
  const trace = new production.trace.TraceContext({ openedBy: "textWebhook", bundleId: bundle.bundleId });
  const started = now();
  let status;
  try {
    status = await call(unit.kind, readers, inputs, unit, { trace });
  } catch (error) {
    status = `threw:${error?.name ?? "Error"}`;
  } finally {
    wire.setUnit({});
  }
  const wallMs = Math.round(now() - started);
  const rows = rowsOfSpans(trace.spans, unit, injectModels);
  return {
    unit: unit.unit,
    kind: unit.kind,
    stage: spec.stage,
    status,
    wallMs,
    rows,
    reads: readTimes(rows),
  };
}
