// What the safety read's model answers in, and the check its answer passes before it counts as a verdict (T-365).
//
// The schema is K-02 v1's `safetyRead` (contracts/model/model.v1.schema.json), bundled as the model API's structured
// outputs need it: external `$ref` is refused, so every definition it refers to is copied into its own `$defs`
// (contracts/model/README.md "Model-facing schemas", item 1). It is read from the frozen contract file itself, so what
// is sent cannot drift from the contract; the tests hold it to contracts/scripts/structured-subset-lint.mjs's own
// bundled form and lint. Live, the frozen safety read is accepted and valid on both models (DL-083).
//
// Structured outputs keep a model to the schema, but a refusal or a cut-off answer may not match it (K-02 README item
// 5), so code checks every answer before it is a verdict: an answer that is not a K-02 `safetyRead` is a failed try.
// The Worker cannot run Ajv (it compiles schemas with new Function), so the check is written here; the tests hold it
// to Ajv over the contract.

import modelContract from "../../../contracts/model/model.v1.schema.json";
import type { JsonObject } from "../recorded-double/types";
import { SAFETY_OUTCOMES, TENSES, type SafetyRead } from "./types";

/** The definition the model answers in. */
export const SAFETY_READ_DEF = "safetyRead";

const LOCAL_REF = "#/$defs/";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The `$defs` names a schema node refers to, in the order met. Refuses a `$ref` outside the same file. */
function localRefs(node: unknown, found: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) localRefs(item, found);
    return;
  }
  if (!isRecord(node)) return;
  for (const [keyword, value] of Object.entries(node)) {
    if (keyword === "$ref") {
      if (typeof value !== "string" || !value.startsWith(LOCAL_REF))
        throw new Error(`a $ref outside K-02's own $defs cannot be bundled here: ${JSON.stringify(value)}`);
      found.push(value.slice(LOCAL_REF.length));
    } else {
      localRefs(value, found);
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/**
 * One definition of a schema whose `$ref`s all point into its own `$defs`, as a standalone schema: the definition, with
 * every definition it reaches copied into `$defs`, in the order they are first met (the order the subset lint's
 * `bundleSchema` gives them). A reference back to the definition itself is refused, since structured outputs refuse a
 * recursive schema; the subset lint, which the tests run on the result, refuses any other cycle.
 */
export function bundleLocalDefinition(defs: Readonly<Record<string, unknown>>, name: string): JsonObject {
  const root = defs[name];
  if (!isRecord(root)) throw new Error(`K-02 has no definition ${name}`);
  const bundled: Record<string, unknown> = {};
  // Visited in order; each definition first met is appended, and the loop reaches it in turn.
  const queue: string[] = [name];
  for (const current of queue) {
    const refs: string[] = [];
    localRefs(defs[current], refs);
    for (const ref of refs) {
      if (ref === name) throw new Error(`${name} refers to itself: a recursive schema`);
      if (ref in bundled) continue;
      const target = defs[ref];
      if (target === undefined) throw new Error(`${name} refers to ${ref}, which K-02 does not define`);
      bundled[ref] = structuredClone(target);
      queue.push(ref);
    }
  }
  const schema: JsonObject = structuredClone(root);
  return Object.keys(bundled).length === 0 ? schema : { ...schema, $defs: bundled };
}

const CONTRACT_DEFS: Readonly<Record<string, unknown>> = modelContract.$defs;

/** K-02 v1's `safetyRead`, bundled: the structured-output schema every safety read call sends. */
export const SAFETY_READ_SCHEMA: JsonObject = deepFreeze(
  bundleLocalDefinition(CONTRACT_DEFS, SAFETY_READ_DEF),
);

const LABEL_FIELDS: readonly string[] = ["outcome", "tense", "evidence", "atRisk", "writer"];
const TEXT_FIELDS = ["evidence", "atRisk", "writer"] as const;

const oneOf = (list: readonly string[], value: unknown): boolean =>
  typeof value === "string" && list.includes(value);

/**
 * Every way `value` is not a K-02 v1 `safetyRead`, one line each, naming fields and never their words; empty when it is
 * one: an object with exactly `labels`, at least one label, each with exactly its outcome (one of the 8 or Unsure), its
 * tense, and its evidence, who is at risk and who wrote it as text.
 */
export function safetyReadProblems(value: unknown): string[] {
  if (!isRecord(value)) return ["the read is not an object"];
  const problems: string[] = [];
  for (const key of Object.keys(value)) {
    if (key !== "labels") problems.push(`${key} is not a field of the read`);
  }
  const labels = value.labels;
  if (!Array.isArray(labels)) {
    problems.push("labels is not a list");
    return problems;
  }
  if (labels.length === 0) problems.push("labels is empty: a text with no danger reads No");
  labels.forEach((label: unknown, index) => {
    const at = `labels[${String(index)}]`;
    if (!isRecord(label)) {
      problems.push(`${at} is not a label`);
      return;
    }
    for (const key of Object.keys(label)) {
      if (!LABEL_FIELDS.includes(key)) problems.push(`${at}.${key} is not a field of a label`);
    }
    if (!oneOf(SAFETY_OUTCOMES, label.outcome))
      problems.push(`${at}.outcome is not one of the 8 outcomes or Unsure`);
    if (!oneOf(TENSES, label.tense))
      problems.push(`${at}.tense is not now, could restart, over, joke or unknown`);
    for (const field of TEXT_FIELDS) {
      if (typeof label[field] !== "string") problems.push(`${at}.${field} is not text`);
    }
  });
  return problems;
}

/** True when `value` is a K-02 v1 `safetyRead`. */
export function isSafetyRead(value: unknown): value is SafetyRead {
  return safetyReadProblems(value).length === 0;
}
