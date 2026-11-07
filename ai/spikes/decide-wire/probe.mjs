#!/usr/bin/env node
// T-1068 spike probe (CQ-25): which wire form carries decide to claude-haiku-5-5 and claude-sonnet-5-5 so that the
// answer maps by code into K-02 v1's decideRead unchanged? ES module; Node 22 built-in fetch; ajv and (if present)
// prettier from the root manifest. Built on T-360's probe (ai/spikes/structured-outputs/probe.mjs), which it does
// not change.
//
//   node ai/spikes/decide-wire/probe.mjs --dry-run   builds every request, lints its schemas, and maps every decide
//                                                    fixture through each candidate offline; no network, no key
//   node ai/spikes/decide-wire/probe.mjs --live      the lead's one run, with ANTHROPIC_API_KEY in the environment
//                                                    (never from a file this script opens)
//   node ai/spikes/decide-wire/probe.mjs --live --round two-step-sonnet
//                                                    round two for (c): the two-step candidate on claude-sonnet-5-5
//                                                    (stage 1, then stage 2 for each part: 3 calls for the
//                                                    two-requests case), appended to results.jsonl and samples/
//
// Live rules (DL-027, NQ-R2, hard rule 7): only https://api.anthropic.com/v1/messages; at most 12 calls in total,
// counting every line already in this folder's results.jsonl, so a second run can never pass 12; refuses to start
// when CI is set or the key is missing; never prints, logs or writes the key or any request header. Per call it
// appends one line to results.jsonl and saves the request body and the response body (no headers) under samples/.
//
// Exit code: 0 done, 1 a dry-run check failed, 2 refused to start.

import { isDeepStrictEqual } from "node:util";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  API_URL,
  API_VERSION,
  CANDIDATES,
  FOLLOW_UPS,
  MAX_CALLS,
  MODELS,
  ONE_CALL,
  ROUND_TWO,
  agreementKey,
  buildCalls,
  buildFollowUps,
  buildSonnetTwoStep,
  buildStage2Calls,
  chooseStrongest,
  checkWire,
  compileDecideRead,
  compileWire,
  contractJson,
  expectedRead,
  lintRequest,
  mapAndValidate,
  resultLine,
  toEnvelope,
  toToolBlocks,
  toTwoStep,
  wireSchemas,
} from "./lib.mjs";
import { lintSchema } from "../../../contracts/scripts/structured-subset-lint.mjs";

const USAGE = `Usage: node ai/spikes/decide-wire/probe.mjs --dry-run | --live | --live --round ${ROUND_TWO}`;
const DEFAULT_OUT = new URL("./", import.meta.url);
const REQUEST_TIMEOUT_MS = 200_000; // the compile timeout is 180 s (Anthropic, "Structured outputs")
const RETRY_WAIT_MS = 20_000;
const MAX_RETRY_WAIT_MS = 60_000;
const BANNED_BODY_WORDS = ["temperature", "top_p", "top_k", "x-api-key", "headers", "undefined", "[object"];

function existingCalls(resultsPath) {
  if (!existsSync(resultsPath)) return 0;
  return readFileSync(resultsPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "").length;
}

/** The ids already logged in results.jsonl (a line that is not JSON or has no id counts as a call, not an id). */
function loggedIds(resultsPath) {
  if (!existsSync(resultsPath)) return new Set();
  const ids = new Set();
  for (const line of readFileSync(resultsPath, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const id = JSON.parse(line)?.id;
      if (typeof id === "string") ids.add(id);
    } catch {
      // not JSON: counted by existingCalls, carries no id
    }
  }
  return ids;
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
/** A key or account problem: no later call can do better, so the run stops. */
const fatal = (status) => status === 401 || status === 403;

// ---------------------------------------------------------------------------------------------------------
// Dry run.

/**
 * No K-02 fixture holds an enter part, or an integer, boolean or time value. This made-up read (no real person:
 * hard rule 9) covers them, so every verb and every fieldValue branch goes through each wire form offline.
 */
const MADE_UP_READS = [
  {
    name: "made-up enter (no K-02 fixture has one)",
    read: {
      language: "en",
      parts: [
        {
          verb: "enter",
          quote: "new haircut for two friday at 3, first time here",
          choice: "c-09",
          fields: [
            {
              name: "time_saved",
              value: { utc: "2026-11-13T20:00:00Z", zone: "America/New_York" },
              words: "friday at 3",
            },
            { name: "party_size", value: 2, words: "for two" },
            { name: "first_visit", value: true, words: "first time here" },
          ],
        },
        { verb: "no_op", quote: "thanks" },
      ],
    },
  },
];

/** Every decide fixture's reads, a made-up enter read, and the two invalid decideRead fixtures, as sample answers. */
export function sampleReads() {
  const index = contractJson("model/fixtures/index.json").fixtures;
  const valid = index
    .filter((entry) => entry.def === "decideResult" && entry.expect === "accept")
    .flatMap((entry) =>
      contractJson(`model/fixtures/${entry.file}`).reads.map((read, k) => ({
        name: `${entry.file.replace(/\.json$/, "")}#${k + 1}`,
        read: read.output,
      })),
    );
  const invalid = index
    .filter((entry) => entry.def === "decideRead" && entry.expect === "refuse")
    .map((entry) => ({
      name: entry.file.replace(/\.json$/, ""),
      read: contractJson(`model/fixtures/${entry.file}`),
    }));
  return { valid: [...valid, ...MADE_UP_READS], invalid };
}

const ENCODE = {
  tools: (read) => toToolBlocks(read),
  "tools-flat": (read) => toToolBlocks(read, { flat: true }),
  envelope: toEnvelope,
  "two-step": toTwoStep,
};

/** Is the wire form of `read` valid against the candidate's wire schemas? */
function wireValid(candidate, wire, encoded) {
  if (candidate === "tools")
    return encoded.every((block) => wire[`tool:${block.name}`]?.(block.input) === true);
  if (candidate === "tools-flat") {
    return encoded.every((block) => wire[`tool-flat:${block.name}`]?.(block.input) === true);
  }
  if (candidate === "envelope") return wire.envelope(encoded) === true;
  return (
    wire.stage1(encoded.stage1) === true &&
    encoded.stage2.every(
      (rest, k) => rest === null || wire[`stage2:${encoded.stage1.parts[k].verb}`]?.(rest) === true,
    )
  );
}

/**
 * One fixture read through one candidate: encode it in the wire form, check it against the wire schemas, map it
 * back, validate against the frozen decideRead, and compare with the original.
 * @returns {{ wireValid: boolean, mappedValid: boolean, same: boolean, error?: string }}
 */
export function roundTrip(candidate, read, { wire, decideRead }) {
  let encoded;
  try {
    encoded = ENCODE[candidate](read);
  } catch (error) {
    return { wireValid: false, mappedValid: false, same: false, error: error.message };
  }
  const valid = wireValid(candidate, wire, encoded);
  const mapped = mapAndValidate(candidate, encoded, decideRead);
  return { wireValid: valid, mappedValid: mapped.valid, same: isDeepStrictEqual(mapped.read, read) };
}

function dryRun(write, outDir) {
  const already = existingCalls(fileURLToPath(new URL("results.jsonl", outDir)));
  const calls = buildCalls();
  const wire = compileWire();
  const decideRead = compileDecideRead();
  let failed = 0;
  const fail = (line) => {
    failed += 1;
    write(`FAIL ${line}`);
  };
  const expected = expectedRead("two-requests");
  const stage2 = buildStage2Calls(
    calls.find((c) => c.candidate === "two-step"),
    toTwoStep(expected).stage1,
  );
  const planned = calls.length + stage2.length + 2 * FOLLOW_UPS;
  write(
    `dry run: ${planned} live calls planned (${calls.length} first-round, ${stage2.length} two-step stage 2 for two parts, ` +
      `${2 * FOLLOW_UPS} second-round), ${MAX_CALLS - planned} left for retries (limit ${MAX_CALLS}; results.jsonl logs ${already}); no network, no key`,
  );
  if (planned >= MAX_CALLS) fail(`the plan leaves no retry slot under ${MAX_CALLS}`);
  // Round two for (c): the two-step candidate on Sonnet (stage 1, then stage 2 for each part of the expected read).
  const roundTwoHead = buildSonnetTwoStep();
  const roundTwoStage2 = buildStage2Calls(roundTwoHead, toTwoStep(expected).stage1);
  const roundTwoCalls = 1 + roundTwoStage2.length;
  write(
    `round two (--live --round ${ROUND_TWO}): ${roundTwoCalls} live calls planned on ${roundTwoHead.model} ` +
      `(1 stage 1, ${roundTwoStage2.length} stage 2); results.jsonl logs ${already}, so ${MAX_CALLS - already - roundTwoCalls} would be left for retries`,
  );
  if (roundTwoCalls >= MAX_CALLS) fail(`round two leaves no retry slot under ${MAX_CALLS}`);
  write(`wire schemas compiled with Ajv 2020 strict: ${Object.keys(wire).join(", ")}`);
  for (const [name, schema] of Object.entries(wireSchemas())) {
    const { errors } = lintSchema(schema);
    if (errors.length > 0 || "$schema" in schema || "$id" in schema) fail(`${name}: ${errors.join("; ")}`);
  }

  // 1. Each request (every second-round call any choice could make): models, banned fields, the subset lint and
  //    the per-request limits.
  const followUps = buildFollowUps(ONE_CALL, calls.length + 1);
  for (const call of [...calls, ...stage2, ...followUps, roundTwoHead, ...roundTwoStage2]) {
    const lint = lintRequest(call.body);
    const wireText = JSON.stringify(call.body);
    const banned = BANNED_BODY_WORDS.filter((word) => wireText.includes(word));
    const problems = [...lint.errors, ...banned.map((word) => `the body carries ${word}`)];
    if (!MODELS.includes(call.model)) problems.push(`model ${call.model}`);
    const line =
      `${String(call.n).padStart(3)} ${call.id.padEnd(36)} ${lint.schemaBytes} schema bytes; strict tools ${lint.strictTools}, ` +
      `optional ${lint.optionalProperties}, unions ${lint.unionParameters}`;
    if (problems.length > 0) fail(`${line}; ${problems.join("; ")}`);
    else write(`ok   ${line}`);
  }

  // 2. Every decide fixture's reads through every candidate, there and back.
  const { valid, invalid } = sampleReads();
  for (const candidate of CANDIDATES) {
    let passed = 0;
    for (const sample of valid) {
      const result = roundTrip(candidate, sample.read, { wire, decideRead });
      if (result.wireValid && result.mappedValid && result.same) passed += 1;
      else fail(`${candidate} ${sample.name}: ${JSON.stringify(result)}`);
    }
    // The invalid reads must be refused somewhere: by the encoder (no such verb), the wire schema or decideRead.
    let refused = 0;
    for (const sample of invalid) {
      const result = roundTrip(candidate, sample.read, { wire, decideRead });
      if (!result.wireValid || !result.mappedValid) refused += 1;
      else fail(`${candidate} accepted ${sample.name}`);
    }
    write(
      `${candidate}: ${passed} of ${valid.length} fixture reads map back to the same decideRead, valid; ${refused} of ${invalid.length} invalid reads refused`,
    );
  }
  write(failed === 0 ? "dry run: passed" : `dry run: FAILED (${failed})`);
  return failed === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------------------
// Live run.

async function live({ env, fetchImpl, write, outDir, sleep, round }) {
  if (env.CI) {
    write("refused: CI is set; this probe never runs in CI (T-1068, NQ-R2).");
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
      `refused: results.jsonl already logs ${already} calls; this probe's limit is ${MAX_CALLS} in total.`,
    );
    return 2;
  }
  const roundTwoHead = buildSonnetTwoStep();
  if (round === ROUND_TWO && loggedIds(resultsPath).has(roundTwoHead.id)) {
    write(`refused: results.jsonl already logs ${roundTwoHead.id}; round ${ROUND_TWO} runs once.`);
    return 2;
  }
  mkdirSync(samplesDir, { recursive: true });
  const scrub = scrubber(key);
  const wire = compileWire();
  const decideRead = compileDecideRead();
  const calls = buildCalls();
  const lines = [];
  let made = 0;
  let stopped = false;
  write(
    round === ROUND_TWO
      ? `live, round ${ROUND_TWO}: the two-step candidate on ${roundTwoHead.model}, stage 1 then stage 2 for each part; ${remaining} of ${MAX_CALLS} left (${already} already logged)`
      : `live: ${calls.length} first-round calls and their stage 2, then ${2 * FOLLOW_UPS} second-round calls; ${remaining} of ${MAX_CALLS} left (${already} already logged)`,
  );

  const record = async (call, attempt, outcome, checks) => {
    const line = { ...resultLine(call, outcome, checks), attempt, call_number: already + made };
    lines.push(line);
    appendFileSync(resultsPath, `${scrub(JSON.stringify(line))}\n`);
    const stem = `${String(line.call_number).padStart(2, "0")}-${call.id}${attempt > 1 ? `-try${attempt}` : ""}`;
    const requestPath = `${samplesDir}${stem}.request.json`;
    const responsePath = `${samplesDir}${stem}.response.json`;
    writeFileSync(requestPath, scrub(await formatJson(JSON.stringify(call.body), requestPath)));
    const responseBody = outcome.response ?? { transport_error: outcome.error ?? null };
    writeFileSync(responsePath, scrub(await formatJson(JSON.stringify(responseBody), responsePath)));
    write(
      `${String(line.call_number).padStart(2)} ${call.id.padEnd(36)} HTTP ${line.http_status} ` +
        `${line.accepted ? "accepted" : "refused "} stop ${line.stop_reason ?? "-"} wire ${line.wire_valid ?? "-"} ` +
        `mapped ${line.mapped_valid ?? "-"} tokens ${line.input_tokens ?? "-"}/${line.output_tokens ?? "-"}` +
        (line.refusal_or_error ? ` :: ${scrub(JSON.stringify(line.refusal_or_error)).slice(0, 300)}` : ""),
    );
  };

  /** Sends one call (and once more after an outside failure), records it, and returns the last outcome and checks. */
  const run = async (call, finish) => {
    if (stopped) return undefined;
    if (made >= remaining) {
      write(`stopped: the ${MAX_CALLS}-call limit is reached before ${call.id}`);
      stopped = true;
      return undefined;
    }
    made += 1;
    let outcome = await send(fetchImpl, key, call.body);
    let attempt = 1;
    // An outside failure (429, 5xx, network) is not a finding: wait, then once more if the limit allows (7.8).
    if (retryable(outcome.status) && made < remaining) {
      await record(call, attempt, outcome, {});
      const wait =
        Number.isFinite(outcome.retryAfter) && outcome.retryAfter > 0 ? outcome.retryAfter * 1000 : 0;
      await sleep(Math.min(Math.max(wait, RETRY_WAIT_MS), MAX_RETRY_WAIT_MS));
      made += 1;
      attempt = 2;
      outcome = await send(fetchImpl, key, call.body);
    }
    const checks = outcome.status === 200 ? finish(outcome.response) : {};
    await record(call, attempt, outcome, checks);
    if (fatal(outcome.status)) {
      write(`stopped: HTTP ${outcome.status} is a key or account problem; no further call is made`);
      stopped = true;
    }
    return { outcome, checks };
  };

  const compare = (caseName, read) =>
    read === undefined ? null : agreementKey(read) === agreementKey(expectedRead(caseName));

  const runOne = async (call) => {
    if (call.candidate !== "two-step") {
      await run(call, (response) => {
        const checked = checkWire(call, response, wire);
        const answer = call.candidate.startsWith("tools") ? response?.content : checked.output;
        const mapped = mapAndValidate(call.candidate, answer, decideRead);
        return {
          wireValid: checked.valid,
          wireErrors: checked.errors,
          mappedValid: mapped.valid,
          mappedErrors: mapped.errors,
          mappingErrors: mapped.mappingErrors.length > 0 ? mapped.mappingErrors : null,
          sameAsFixture: compare(call.caseName, mapped.read),
        };
      });
      return;
    }
    // (c) Stage 1, then one stage-2 call per part; the last call's line carries the mapped read's result.
    let stage1Output;
    const first = await run(call, (response) => {
      const checked = checkWire(call, response, wire);
      stage1Output = checked.valid ? checked.output : undefined;
      return { wireValid: checked.valid, wireErrors: checked.errors };
    });
    if (first === undefined || stage1Output === undefined) return;
    const stage2Calls = buildStage2Calls(call, stage1Output);
    const stage2 = [];
    for (const [k, part] of stage1Output.parts.entries())
      stage2[k] = part.verb === "no_op" ? null : undefined;
    for (const [j, second] of stage2Calls.entries()) {
      const last = j === stage2Calls.length - 1;
      await run(second, (response) => {
        const checked = checkWire(second, response, wire);
        if (checked.valid) stage2[second.partIndex] = checked.output;
        if (!last) return { wireValid: checked.valid, wireErrors: checked.errors };
        const mapped = mapAndValidate("two-step", { stage1: stage1Output, stage2 }, decideRead);
        return {
          wireValid: checked.valid,
          wireErrors: checked.errors,
          mappedValid: mapped.valid,
          mappedErrors: mapped.errors,
          mappingErrors: mapped.mappingErrors.length > 0 ? mapped.mappingErrors : null,
          sameAsFixture: compare(call.caseName, mapped.read),
        };
      });
    }
  };

  // Round two for (c), asked for by flag: only the two-step candidate, on Sonnet (the lead's round 1 found no
  // one-call form accepted, so nothing else is sent).
  if (round === ROUND_TWO) {
    await runOne(roundTwoHead);
    write(
      `live: ${made} calls made; ${already + made} of ${MAX_CALLS} used. Results: results.jsonl, samples/`,
    );
    return 0;
  }

  // First round: every candidate on Haiku. Second round: the strongest one-call candidates on Sonnet, then on Haiku
  // with the second case. Compiling is per schema, so a form Haiku refuses is not sent to Sonnet.
  for (const call of calls) await runOne(call);
  const chosen = chooseStrongest(lines);
  write(
    `second round: ${chosen.length > 0 ? chosen.join(", ") : "none (no one-call candidate was accepted)"}`,
  );
  for (const call of buildFollowUps(chosen, calls.length + 1)) await runOne(call);
  // When only (c) was accepted, it is the one candidate left to try on Sonnet: the same as round two by flag.
  const twoStepAccepted = lines.some(
    (line) =>
      line.candidate === "two-step" &&
      line.stage === 1 &&
      line.model === MODELS[0] &&
      line.wire_valid === true,
  );
  if (chosen.length === 0 && twoStepAccepted) {
    write(
      `only the two-step candidate was accepted: sending it on ${roundTwoHead.model} (round ${ROUND_TWO})`,
    );
    await runOne(roundTwoHead);
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
  const plain = argv.length === 1 && ["--dry-run", "--live"].includes(argv[0]);
  const roundTwo =
    argv.length === 3 && argv[0] === "--live" && argv[1] === "--round" && argv[2] === ROUND_TWO;
  if (!plain && !roundTwo) {
    write(USAGE);
    return 2;
  }
  if (argv[0] === "--dry-run") return dryRun(write, outDir);
  return live({ env, fetchImpl, write, outDir, sleep, round: roundTwo ? ROUND_TWO : undefined });
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
