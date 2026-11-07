#!/usr/bin/env node
// T-360 spike probe: are the K-02 and K-03 candidate schemas accepted as structured outputs by claude-haiku-5-5
// and claude-sonnet-5-5? ES module; Node 22 built-in fetch; ajv and (if present) prettier from the root manifest.
//
//   node ai/spikes/structured-outputs/probe.mjs --dry-run   builds and checks every request; no network, no key
//   node ai/spikes/structured-outputs/probe.mjs --live      the lead's one run, with ANTHROPIC_API_KEY in the
//                                                           environment (never from a file this script opens)
//
// T-1066 adds --frozen (with --dry-run or --live): the last 4 of the 20 calls, one on claude-haiku-5-5 for each
// frozen model-facing schema (K-02 decide read, safety read, planner output; K-03 plan), each built by
// bundleSchema() from the contract files (frozen.mjs). It plans exactly 4 and refuses to go live with fewer than 4
// calls left under the limit.
//
// Live rules (DL-027, Q-20, hard rule 7): only https://api.anthropic.com; at most 20 calls in total, counting
// every line already in results.jsonl, so a second run can never pass 20; refuses to start when CI is set or
// the key is missing; never prints, logs or writes the key or any request header. Per call it appends one line
// to results.jsonl and saves the request body and the response body (no headers) under samples/ for T-004's
// recorded-model double.
//
// Exit code: 0 done, 1 a dry-run check failed, 2 refused to start.

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  API_URL,
  API_VERSION,
  MAX_CALLS,
  MODELS,
  buildCalls,
  checkSubset,
  compileCandidates,
  resultLine,
} from "./lib.mjs";
import {
  FROZEN_CALLS,
  FROZEN_MODEL,
  FROZEN_TARGETS,
  buildFrozenCalls,
  compileFrozen,
  frozenSamples,
} from "./frozen.mjs";
import { lintSchema } from "../../../contracts/scripts/structured-subset-lint.mjs";

const USAGE = "Usage: node ai/spikes/structured-outputs/probe.mjs [--frozen] --dry-run | [--frozen] --live";
const DEFAULT_OUT = new URL("./", import.meta.url);
const REQUEST_TIMEOUT_MS = 120_000;
const RETRY_WAIT_MS = 20_000;
const MAX_RETRY_WAIT_MS = 60_000;

function existingCalls(resultsPath) {
  if (!existsSync(resultsPath)) return 0;
  return readFileSync(resultsPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "").length;
}

/** Removes the key from any text before it is written, in case a service ever echoed it. */
function scrubber(key) {
  return (text) => (key.length >= 8 ? text.split(key).join("[redacted]") : text);
}

async function formatJson(text, filePath) {
  try {
    const prettier = await import("prettier");
    const options = (await prettier.resolveConfig(filePath)) ?? {};
    return await prettier.format(text, { ...options, parser: "json" });
  } catch {
    return text;
  }
}

function describeError(error) {
  const cause = error?.cause?.code ?? error?.cause?.message;
  return `${error?.name ?? "Error"}: ${error?.message ?? String(error)}${cause ? ` (${cause})` : ""}`;
}

async function send(fetchImpl, key, body) {
  const started = Date.now();
  try {
    const res = await fetchImpl(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": API_VERSION },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let response;
    try {
      response = JSON.parse(text);
    } catch {
      response = { unparsed_body: text.slice(0, 4000) };
    }
    const retryAfter = Number(res.headers?.get?.("retry-after"));
    return { status: res.status, response, elapsedMs: Date.now() - started, retryAfter };
  } catch (error) {
    return { status: 0, response: undefined, error: describeError(error), elapsedMs: Date.now() - started };
  }
}

const retryable = (status) => status === 0 || status === 429 || status >= 500;

function dryRun(write) {
  const calls = buildCalls();
  const validators = compileCandidates();
  let failed = 0;
  write(`dry run: ${calls.length} calls planned (limit ${MAX_CALLS}); no network, no key`);
  if (calls.length > MAX_CALLS) {
    failed += 1;
    write(`FAIL more than ${MAX_CALLS} calls planned`);
  }
  write(`candidates compiled with Ajv 2020 strict: ${Object.keys(validators).join(", ")}`);
  for (const call of calls) {
    const schema = call.body.output_config.format.schema;
    const subset = checkSubset(schema);
    const outside = subset.problems.length;
    let ok = MODELS.includes(call.model);
    if (call.expect === "accept" && outside > 0) ok = false;
    if (call.expect === "refuse" && outside === 0) ok = false;
    if (!ok) failed += 1;
    write(
      `${ok ? "ok  " : "FAIL"} ${String(call.n).padStart(2)} ${call.id.padEnd(28)} ${call.model.padEnd(18)} expect ${call.expect.padEnd(7)} ` +
        `${JSON.stringify(schema).length} schema bytes; optional ${subset.optionalProperties}, unions ${subset.unionParameters}` +
        (outside > 0 ? `; outside the subset: ${subset.problems.join("; ")}` : ""),
    );
  }
  write(failed === 0 ? "dry run: passed" : `dry run: FAILED (${failed})`);
  return failed === 0 ? 0 : 1;
}

/** Builds the 4 frozen requests and checks each offline: the subset, the contracts' own lint, a fixture output. */
function dryRunFrozen(write, outDir) {
  const already = existingCalls(fileURLToPath(new URL("results.jsonl", outDir)));
  const remaining = MAX_CALLS - already;
  // With fewer than 4 left a live run refuses; the dry run still checks the requests, numbered as slots 17 to 20.
  const calls = buildFrozenCalls(remaining >= FROZEN_CALLS ? { firstN: already + 1 } : {});
  const validators = compileFrozen();
  const samples = frozenSamples();
  let failed = 0;
  write(
    `dry run (frozen): ${calls.length} calls planned on ${FROZEN_MODEL} (limit ${MAX_CALLS}; results.jsonl logs ${already}, ${Math.max(remaining, 0)} left); no network, no key`,
  );
  if (calls.length !== FROZEN_CALLS) {
    failed += 1;
    write(`FAIL ${FROZEN_CALLS} calls are planned, not ${calls.length}`);
  }
  if (remaining < FROZEN_CALLS) {
    write(
      `note: --frozen --live would refuse now (fewer than ${FROZEN_CALLS} of the ${MAX_CALLS} calls are left)`,
    );
  }
  write(`frozen schemas compiled with Ajv 2020 strict: ${FROZEN_TARGETS.map((t) => t.def).join(", ")}`);
  for (const call of calls) {
    const schema = call.body.output_config.format.schema;
    const subset = checkSubset(schema);
    const lint = lintSchema(schema);
    const problems = [...subset.problems, ...lint.errors];
    const sampleValid = validators[call.schemaName](samples[call.schemaName]) === true;
    const ok =
      call.model === FROZEN_MODEL &&
      problems.length === 0 &&
      sampleValid &&
      schema.$schema === undefined &&
      schema.$id === undefined;
    if (!ok) failed += 1;
    write(
      `${ok ? "ok  " : "FAIL"} ${String(call.n).padStart(2)} ${call.id.padEnd(32)} ${call.model.padEnd(17)} expect ${call.expect.padEnd(7)} ` +
        `${JSON.stringify(schema).length} schema bytes; optional ${subset.optionalProperties}, unions ${subset.unionParameters}; ` +
        `fixture output valid ${sampleValid}` +
        (problems.length > 0 ? `; outside the subset: ${problems.join("; ")}` : ""),
    );
  }
  write(failed === 0 ? "dry run (frozen): passed" : `dry run (frozen): FAILED (${failed})`);
  return failed === 0 ? 0 : 1;
}

async function live({ env, fetchImpl, write, outDir, sleep, frozen = false }) {
  if (env.CI) {
    write("refused: CI is set; this probe never runs in CI (T-360, Q-20).");
    return 2;
  }
  const key = env.ANTHROPIC_API_KEY;
  if (typeof key !== "string" || key.trim() === "") {
    write("refused: ANTHROPIC_API_KEY is not set in the environment (it is never read from a file).");
    return 2;
  }
  const resultsPath = fileURLToPath(new URL("results.jsonl", outDir));
  const samplesDir = fileURLToPath(new URL("samples/", outDir));
  const already = existingCalls(resultsPath);
  const remaining = MAX_CALLS - already;
  if (remaining <= 0) {
    write(
      `refused: results.jsonl already logs ${already} calls; the spike's limit is ${MAX_CALLS} in total.`,
    );
    return 2;
  }
  if (frozen && remaining < FROZEN_CALLS) {
    write(
      `refused: results.jsonl logs ${already} calls, so only ${remaining} of the ${MAX_CALLS} are left; the frozen check needs ${FROZEN_CALLS}.`,
    );
    return 2;
  }
  mkdirSync(samplesDir, { recursive: true });
  const scrub = scrubber(key);
  const validators = frozen ? compileFrozen() : compileCandidates();
  const calls = frozen ? buildFrozenCalls({ firstN: already + 1 }) : buildCalls();
  const skippedModels = new Set();
  let made = 0;
  write(`live: ${calls.length} calls planned, ${remaining} of ${MAX_CALLS} left (${already} already logged)`);

  const record = async (call, attempt, outcome) => {
    const line = { ...resultLine(call, { ...outcome, validators }), attempt, call_number: already + made };
    appendFileSync(resultsPath, `${scrub(JSON.stringify(line))}\n`);
    const stem = `${String(call.n).padStart(2, "0")}-${call.id}${attempt > 1 ? `-try${attempt}` : ""}`;
    const requestPath = `${samplesDir}${stem}.request.json`;
    const responsePath = `${samplesDir}${stem}.response.json`;
    writeFileSync(requestPath, scrub(await formatJson(JSON.stringify(call.body), requestPath)));
    const responseBody = outcome.response ?? { transport_error: outcome.error ?? null };
    writeFileSync(responsePath, scrub(await formatJson(JSON.stringify(responseBody), responsePath)));
    write(
      `${String(line.call_number).padStart(2)} ${call.id.padEnd(28)} HTTP ${line.http_status} ` +
        `${line.accepted ? "accepted" : "refused "} stop ${line.stop_reason ?? "-"} valid ${line.output_valid ?? "-"} ` +
        `tokens ${line.input_tokens ?? "-"}/${line.output_tokens ?? "-"}` +
        (line.refusal_or_error ? ` :: ${scrub(JSON.stringify(line.refusal_or_error)).slice(0, 300)}` : ""),
    );
    return line;
  };

  for (const call of calls) {
    if (skippedModels.has(call.model)) {
      write(`   ${call.id.padEnd(28)} skipped: ${call.model}'s control call was not accepted`);
      continue;
    }
    if (made >= remaining) {
      write(`stopped: the ${MAX_CALLS}-call limit is reached`);
      break;
    }
    made += 1;
    let outcome = await send(fetchImpl, key, call.body);
    let line = await record(call, 1, outcome);
    // An outside failure (429, 5xx, network) is not a finding: wait, then once more if the limit allows (7.8).
    if (retryable(outcome.status) && made < remaining) {
      const wait =
        Number.isFinite(outcome.retryAfter) && outcome.retryAfter > 0 ? outcome.retryAfter * 1000 : 0;
      await sleep(Math.min(Math.max(wait, RETRY_WAIT_MS), MAX_RETRY_WAIT_MS));
      made += 1;
      outcome = await send(fetchImpl, key, call.body);
      line = await record(call, 2, outcome);
    }
    if (call.variant === "control" && !line.accepted) skippedModels.add(call.model);
  }
  write(`live: ${made} calls made; ${already + made} of ${MAX_CALLS} used. Results: results.jsonl, samples/`);
  return 0;
}

/** Runs the probe; returns the exit code. */
export async function main(
  argv,
  {
    env = process.env,
    fetchImpl = globalThis.fetch,
    write = (line) => console.log(line),
    outDir = DEFAULT_OUT,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  const flags = new Set(argv);
  const frozen = flags.has("--frozen");
  const mode = ["--dry-run", "--live"].filter((flag) => flags.has(flag));
  if (flags.size !== argv.length || mode.length !== 1 || flags.size !== mode.length + (frozen ? 1 : 0)) {
    write(USAGE);
    return 2;
  }
  if (mode[0] === "--dry-run") return frozen ? dryRunFrozen(write, outDir) : dryRun(write);
  return live({ env, fetchImpl, write, outDir, sleep, frozen });
}

function runAsScript() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (runAsScript()) process.exitCode = await main(process.argv.slice(2));
