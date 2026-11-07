// The check every span passes before it is kept or logged: K-08 v1's `span` definition, written as code.
// The Worker cannot run Ajv (it compiles schemas with new Function, which Workers refuse), so the rules are repeated
// here; validate.test.ts holds this check to the contract's own schema (Ajv 2020) on every fixture and every refusal.
//
// What it keeps out of a log line (K-08: "never the raw number or words"; arch 10 line 516): a handle is named by its
// id, and what a hop got or decided is a count, a yes or no, none, a label or a list of labels. A label is letters,
// digits and _ . : / # - only, never spaces, "+" or "@", and never a run of digits and phone punctuation seven or
// more long, so a phone number, an email address and a person's sentence cannot pass. Keys, tokens and card numbers
// have no field to ride in: no free string exists in a span.

import {
  HOPS,
  LIMIT_RESULTS,
  MODEL_OUTCOMES,
  MODEL_PURPOSES,
  MODEL_ROLES,
  OUTCOMES,
  PROVIDERS,
  type Hop,
} from "./types";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/#-]*$/u;
const LOOKS_LIKE_NUMBER = /^[0-9().+ -]{7,}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$/u;
const FACT_NAME = /^[a-z][A-Za-z0-9]*$/u;
const TABLE_NAME = /^[a-z][a-z0-9_]*$/u;
const MODEL_ID = /^claude-[a-z0-9-]+$/u;

const SPAN_KEYS = new Set([
  "trace_id",
  "span_id",
  "seq",
  "hop",
  "at",
  "ms",
  "bundle_id",
  "turn_id",
  "job_id",
  "event_id",
  "handle_ref",
  "business_id",
  "provider",
  "call",
  "attempt",
  "got",
  "decided",
  "limits",
  "rows",
  "model_calls",
  "outcome",
  "error_code",
]);

const REQUIRED_KEYS = [
  "trace_id",
  "span_id",
  "seq",
  "hop",
  "at",
  "ms",
  "bundle_id",
  "turn_id",
  "handle_ref",
  "outcome",
] as const;

const OUTSIDE_CALL_HOPS: readonly Hop[] = ["effectRun", "portCall"];
const PROVIDER_MESSAGE_HOPS: readonly Hop[] = ["receive", "providerAccepted", "delivered", "providerWebhook"];
const MODEL_HOPS: readonly Hop[] = ["safetyRead", "decideReads", "reread", "planner", "compose"];
const SENDS_NOTHING = ["dropped", "held", "refused"];

type Problems = string[];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCount = (value: unknown, minimum: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= minimum;

const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);

/** An id that is never a number, an address or words (K-08 v1 `safeId`; also the form of a `label`). */
export function isLabel(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value) && !LOOKS_LIKE_NUMBER.test(value);
}

function checkLabel(problems: Problems, path: string, value: unknown): void {
  if (!isLabel(value))
    problems.push(
      `${path} is not a label (letters, digits and _ . : / # - only; no number, address or words)`,
    );
}

function checkLabelOrNull(problems: Problems, path: string, value: unknown): void {
  if (value !== null) checkLabel(problems, path, value);
}

function checkFacts(problems: Problems, path: string, value: unknown): void {
  if (!isRecord(value)) {
    problems.push(`${path} is not an object of named values`);
    return;
  }
  for (const [name, fact] of Object.entries(value)) {
    if (!FACT_NAME.test(name) || name === "provider") {
      problems.push(`${path}.${name} is not an allowed name (camelCase, never provider)`);
    }
    const here = `${path}.${name}`;
    if (typeof fact === "boolean" || fact === null) continue;
    if (typeof fact === "number") {
      if (!Number.isInteger(fact)) problems.push(`${here} is a number that is not a whole count`);
    } else if (typeof fact === "string") {
      checkLabel(problems, here, fact);
    } else if (Array.isArray(fact)) {
      fact.forEach((item: unknown, index) => {
        checkLabel(problems, `${here}[${String(index)}]`, item);
      });
    } else {
      problems.push(`${here} is not a count, a yes or no, none, a label or a list of labels`);
    }
  }
}

function checkClosed(
  problems: Problems,
  path: string,
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) problems.push(`${path}.${key} is not a field of the contract`);
  }
}

function checkBundleId(problems: Problems, path: string, value: unknown): void {
  if (!isRecord(value)) {
    problems.push(`${path} is missing: every span carries the bundle id`);
    return;
  }
  checkClosed(problems, path, value, ["hash", "build"]);
  if (typeof value.hash !== "string" || !SHA256.test(value.hash)) {
    problems.push(`${path}.hash is not 64 lowercase hex characters`);
  }
  if (!isCount(value.build, 1)) problems.push(`${path}.build is not a build number from 1`);
}

/** Every way `value` is not K-01's bundle id (a 64-hex hash and a build from 1). */
export function bundleIdProblems(value: unknown): string[] {
  const problems: Problems = [];
  checkBundleId(problems, "bundle_id", value);
  return problems;
}

function checkLimits(problems: Problems, path: string, value: unknown): void {
  if (!Array.isArray(value)) {
    problems.push(`${path} is not a list`);
    return;
  }
  value.forEach((entry: unknown, index) => {
    const here = `${path}[${String(index)}]`;
    if (!isRecord(entry)) {
      problems.push(`${here} is not a limit result`);
      return;
    }
    checkClosed(problems, here, entry, ["limit", "result", "outcome"]);
    if (!isCount(entry.limit, 1) || entry.limit > 8) problems.push(`${here}.limit is not 1 to 8`);
    if (!oneOf(LIMIT_RESULTS, entry.result)) problems.push(`${here}.result is not pass, fail or notChecked`);
    if (!("outcome" in entry)) problems.push(`${here}.outcome is missing (null when none)`);
    else checkLabelOrNull(problems, `${here}.outcome`, entry.outcome);
  });
}

function checkRows(problems: Problems, path: string, value: unknown): void {
  if (!Array.isArray(value)) {
    problems.push(`${path} is not a list`);
    return;
  }
  value.forEach((entry: unknown, index) => {
    const here = `${path}[${String(index)}]`;
    if (!isRecord(entry)) {
      problems.push(`${here} is not a row reference`);
      return;
    }
    checkClosed(problems, here, entry, ["table", "id"]);
    if (typeof entry.table !== "string" || !TABLE_NAME.test(entry.table))
      problems.push(`${here}.table is not a table name`);
    checkLabel(problems, `${here}.id`, entry.id);
  });
}

const MODEL_CALL_COUNTS = [
  "input_tokens",
  "cached_tokens",
  "cache_write_tokens",
  "output_tokens",
  "cost_micro_usd",
  "ms",
];

function checkModelCalls(problems: Problems, path: string, value: unknown): void {
  if (!Array.isArray(value)) {
    problems.push(`${path} is not a list`);
    return;
  }
  value.forEach((entry: unknown, index) => {
    const here = `${path}[${String(index)}]`;
    if (!isRecord(entry)) {
      problems.push(`${here} is not a model call`);
      return;
    }
    checkClosed(problems, here, entry, ["model", "role", "purpose", "outcome", ...MODEL_CALL_COUNTS]);
    if (typeof entry.model !== "string" || !MODEL_ID.test(entry.model))
      problems.push(`${here}.model is not a claude model id`);
    if (!oneOf(MODEL_ROLES, entry.role)) problems.push(`${here}.role is not haiku or sonnet`);
    if (!oneOf(MODEL_PURPOSES, entry.purpose)) problems.push(`${here}.purpose is not a model-call purpose`);
    if (!oneOf(MODEL_OUTCOMES, entry.outcome)) problems.push(`${here}.outcome is not ok, timedOut or failed`);
    for (const key of MODEL_CALL_COUNTS) {
      if (!isCount(entry[key], 0)) problems.push(`${here}.${key} is not a whole number from 0`);
    }
  });
}

/**
 * Every way `value` breaks K-08 v1's span definition, one readable line each; an empty list means the span is valid.
 * Takes `unknown` so a span from anywhere (a fixture, a hop's own fields) is held to the same rules.
 */
export function spanProblems(value: unknown): string[] {
  const problems: Problems = [];
  if (!isRecord(value)) return ["span is not an object"];

  for (const key of Object.keys(value)) {
    if (!SPAN_KEYS.has(key)) problems.push(`${key} is not a field of the contract`);
  }
  for (const key of REQUIRED_KEYS) {
    if (!(key in value)) problems.push(`${key} is missing`);
  }

  if ("trace_id" in value && (typeof value.trace_id !== "string" || value.trace_id === "")) {
    problems.push("trace_id is not an id");
  }
  if ("span_id" in value) checkLabel(problems, "span_id", value.span_id);
  if ("seq" in value && !isCount(value.seq, 1)) problems.push("seq is not a place from 1");
  if ("hop" in value && !oneOf(HOPS, value.hop)) problems.push("hop is not a hop of the contract");
  if ("at" in value && (typeof value.at !== "string" || !UTC.test(value.at)))
    problems.push("at is not an instant in UTC");
  if ("ms" in value && !isCount(value.ms, 0))
    problems.push("ms is not a whole number of milliseconds from 0");
  if ("bundle_id" in value) checkBundleId(problems, "bundle_id", value.bundle_id);
  if (
    "turn_id" in value &&
    value.turn_id !== null &&
    (typeof value.turn_id !== "string" || value.turn_id === "")
  ) {
    problems.push("turn_id is not an id or null");
  }
  for (const key of ["job_id", "event_id", "handle_ref", "business_id"] as const) {
    if (key in value) checkLabelOrNull(problems, key, value[key]);
  }
  if ("provider" in value && !oneOf(PROVIDERS, value.provider))
    problems.push("provider is not on the closed list");
  if ("call" in value) checkLabel(problems, "call", value.call);
  if ("attempt" in value && !isCount(value.attempt, 1)) problems.push("attempt is not a try from 1");
  if ("got" in value) checkFacts(problems, "got", value.got);
  if ("decided" in value) checkFacts(problems, "decided", value.decided);
  if ("limits" in value) checkLimits(problems, "limits", value.limits);
  if ("rows" in value) checkRows(problems, "rows", value.rows);
  if ("model_calls" in value) checkModelCalls(problems, "model_calls", value.model_calls);
  if ("outcome" in value && !oneOf(OUTCOMES, value.outcome))
    problems.push("outcome is not an outcome of the contract");
  if ("error_code" in value) checkLabelOrNull(problems, "error_code", value.error_code);

  const hop = value.hop;
  const needs = (keys: readonly string[], why: string): void => {
    for (const key of keys) {
      if (!(key in value)) problems.push(`${key} is required on ${why}`);
    }
  };
  if (oneOf(OUTSIDE_CALL_HOPS, hop))
    needs(["provider", "call", "attempt"], `the ${hop} hop (an outside call)`);
  if (hop === "dispatch" && typeof value.outcome === "string" && !SENDS_NOTHING.includes(value.outcome)) {
    needs(["provider", "call", "attempt"], "a dispatch that sends");
  }
  if (oneOf(PROVIDER_MESSAGE_HOPS, hop)) needs(["provider"], `the ${hop} hop (a provider's message)`);
  if (oneOf(MODEL_HOPS, hop) && !(Array.isArray(value.model_calls) && value.model_calls.length >= 1)) {
    problems.push(`model_calls needs at least one call on the ${hop} hop`);
  }
  if (hop === "gate" && !(Array.isArray(value.limits) && value.limits.length >= 1)) {
    problems.push("limits needs at least one result on the gate hop");
  }
  return problems;
}
