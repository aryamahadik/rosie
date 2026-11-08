// The Tool API's one validator (T-290; 02-contracts section 2 items 2 and 8; contracts/README.md convention 8): Ajv 8 with
// its 2020-12 class in strict mode, the setup of contracts/scripts/lib.mjs and the contract harness, holding the frozen
// schemas. Every call's request is checked against `$defs/<call>.request`, and its handler's answer against
// `$defs/<call>.response` or `$defs/<call>.errors`, of K-09 v1; a span against K-08 v1.1's `span`.
//
// The schemas are read from contracts/ on disk, as the other packages read frozen schemas (the contract harness, the AI
// layer's recorded double, the runtime's and the adapters' tests). Ajv compiles a schema with new Function, which the
// Workers runtime refuses (runtime/src/trace/validate.ts), so before the Tool API runs inside the Worker these checks need
// Ajv's standalone code, built ahead of time (README of this package, open points). Problem lines name a path and what
// the schema wants, never a value.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

import { CALL_NAMES, type CallName } from "./calls";

/** The $id of K-09 v1 (contracts/README.md convention 2). */
export const TOOL_API_SCHEMA_ID = "https://rosie.invalid/contracts/tool-api/tool-api.v1.schema.json";
/** The $id of K-08 v1.1, whose `span` is v1's, unchanged (event-trace README "v1.1"). */
export const EVENT_TRACE_SCHEMA_ID =
  "https://rosie.invalid/contracts/event-trace/event-trace.v1.1.schema.json";

/**
 * The frozen schema files the validator holds, relative to contracts/: K-09 v1, K-08 v1.1 and every file their $refs
 * reach (a test checks that the list is closed under $ref).
 */
export const SCHEMA_FILES = [
  "common/formats.v1.schema.json",
  "bundle/bundle.v1.schema.json",
  "model/model.v1.schema.json",
  "message-plan/message-plan.v1.schema.json",
  "data-access/data-access.v1.schema.json",
  "outbox-effects/outbox-effects.v1.schema.json",
  "event-trace/event-trace.v1.schema.json",
  "event-trace/event-trace.v1.1.schema.json",
  "tool-api/tool-api.v1.schema.json",
] as const;

/** The repository's contracts/ folder: this file is actions/src/tool-api/validator.ts. */
export const CONTRACTS_DIR = fileURLToPath(new URL("../../../contracts/", import.meta.url));

/** At most this many problem lines come back; one more line says how many were left out. */
const MAX_PROBLEMS = 20;

/** The three definitions every call has under `$defs` (02-contracts section 2 item 2). */
export type CallPart = "request" | "response" | "errors";

export interface ToolApiValidator {
  /** The problems the schema finds in `value` against `$defs/<call>.<part>` of K-09 v1, one line each; empty when accepted. */
  check(call: CallName, part: CallPart, value: unknown): string[];
  /** The problems K-08 v1.1's `span` finds in `value`, one line each; empty when accepted. */
  checkSpan(value: unknown): string[];
}

/** Reads the frozen schema files from `contractsDir` (default: this repository's contracts/). */
export function loadToolApiSchemas(contractsDir: string = CONTRACTS_DIR): object[] {
  return SCHEMA_FILES.map(
    (file) => JSON.parse(readFileSync(path.join(contractsDir, ...file.split("/")), "utf8")) as object,
  );
}

/** Ajv's errors as one line each: the place (the root as "(root)") and what the schema wants. */
export function formatProblems(errors: readonly ErrorObject[] | null | undefined): string[] {
  const lines = (errors ?? []).map((error) => {
    const where = error.instancePath === "" ? "(root)" : error.instancePath;
    let extra = "";
    if (error.keyword === "additionalProperties") {
      extra = ` (${String(error.params.additionalProperty)})`;
    } else if (error.keyword === "enum") {
      extra = ` (${(error.params.allowedValues as unknown[]).map(String).join(", ")})`;
    }
    return `${where} ${error.message ?? "is invalid"}${extra}`;
  });
  if (lines.length <= MAX_PROBLEMS) return lines;
  return [...lines.slice(0, MAX_PROBLEMS), `and ${String(lines.length - MAX_PROBLEMS)} more`];
}

/**
 * One strict Ajv 2020-12 instance holding `schemas` (default: the frozen files from disk). Each definition is compiled the
 * first time it is checked and kept; a definition the schemas do not hold throws, since the call list and the contract
 * must never drift apart.
 */
export function createToolApiValidator(schemas: readonly object[] = loadToolApiSchemas()): ToolApiValidator {
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  for (const schema of schemas) ajv.addSchema(schema);

  const validatorOf = (schemaId: string, definition: string): ValidateFunction => {
    const validate = ajv.getSchema(`${schemaId}#/$defs/${definition}`);
    if (validate === undefined) throw new Error(`${schemaId} has no definition ${definition}`);
    return validate;
  };
  const problemsOf = (validate: ValidateFunction, value: unknown): string[] =>
    validate(value) ? [] : formatProblems(validate.errors);

  return {
    check(call, part, value) {
      if (!(CALL_NAMES as readonly string[]).includes(call)) throw new Error("not a call of K-09 v1");
      return problemsOf(validatorOf(TOOL_API_SCHEMA_ID, `${call}.${part}`), value);
    },
    checkSpan(value) {
      return problemsOf(validatorOf(EVENT_TRACE_SCHEMA_ID, "span"), value);
    },
  };
}
