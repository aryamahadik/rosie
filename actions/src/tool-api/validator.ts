// The Tool API's one validator (T-290, T-1150; 02-contracts section 2 items 2 and 8; contracts/README.md convention 8):
// Ajv 8 with its 2020-12 class in strict mode, the setup of contracts/scripts/lib.mjs and the contract harness, holding
// the frozen schemas. The Tool API registers K-09 v1's 29 calls (calls.ts); every call's request is checked against K-09
// v1.5's definition of the same name, `$defs/<call>.request`, and its handler's answer against `$defs/<call>.response`
// or `$defs/<call>.errors`. v1.5 holds every v1 definition under its own name, the unchanged ones by $ref back to v1.4
// to v1, and accepts every v1 exchange (README "v1.5"; DL-340), so gateAndCommit's turn may carry the service and the
// chat id of the turn's last text (default 135) and buildFrontier's context may offer the sign-up door (K-02 v1.1). A
// span is checked against K-08 v1.1's `span`. The frontier's checks (frontier/assemble/check.ts) read K-02 v1.1's
// choice, openQuestion, stepCard and context through the same checks (definitionChecks).
//
// Two ways to run the same checks, one answer (T-1144; DL-327):
//   - In Node, Ajv's compiler: the schemas are read from contracts/ on disk, as the other packages read frozen schemas
//     (the contract harness, the AI layer's recorded double, the runtime's and the adapters' tests), and each definition
//     is compiled the first time it is checked.
//   - Inside the Worker (workerd), the prebuilt code: Ajv compiles a schema with new Function, which the Workers runtime
//     refuses, and the Worker has no contracts/ on disk. So `npm run build:validators` (infra/build/tool-api-validators.mjs)
//     compiles these same definitions ahead of time, with these options, into Ajv's standalone code in ./generated/
//     (git-ignored, built before the type check, the tests and any Worker bundle). Nothing is evaluated at run time.
// The build checks that the code gives the compiler's answer to every check on the contracts' fixtures, and
// validator.worker.test.ts and the frontier's check.worker.test.ts check it again inside workerd. Problem lines name a
// path and what the schema wants, never a value.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ErrorObject } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

import { CALL_NAMES, type CallName } from "./calls";
import { build as prebuilt, definitions as prebuiltDefinitions } from "./generated/validators";

/** The $id of K-09 v1.5, whose definitions of K-09 v1's calls the validator checks (contracts/README.md convention 2). */
export const TOOL_API_SCHEMA_ID = "https://rosie.invalid/contracts/tool-api/tool-api.v1.5.schema.json";
/** The $id of K-08 v1.1, whose `span` is v1's, unchanged (event-trace README "v1.1"). */
export const EVENT_TRACE_SCHEMA_ID =
  "https://rosie.invalid/contracts/event-trace/event-trace.v1.1.schema.json";
/**
 * The $id of K-02 v1.1, whose choice, openQuestion, stepCard and context the frontier checks (frontier/assemble/check.ts):
 * the context K-09 v1.5's buildFrontier answers, whose doors also take signUp (K-02 README "v1.1").
 */
export const MODEL_SCHEMA_ID = "https://rosie.invalid/contracts/model/model.v1.1.schema.json";

/**
 * The frozen schema files the validator holds, relative to contracts/: every file K-09 v1.5's and K-08 v1.1's $refs reach,
 * K-09 v1 to v1.4, K-02 v1 and v1.1 and K-06 v1 (gateAndCommit.turn's service) among them (a test checks that the list is
 * exactly that closure).
 */
export const SCHEMA_FILES = [
  "common/formats.v1.schema.json",
  "bundle/bundle.v1.schema.json",
  "model/model.v1.schema.json",
  "model/model.v1.1.schema.json",
  "message-plan/message-plan.v1.schema.json",
  "data-access/data-access.v1.schema.json",
  "inbound-event/inbound-event.v1.schema.json",
  "outbox-effects/outbox-effects.v1.schema.json",
  "event-trace/event-trace.v1.schema.json",
  "event-trace/event-trace.v1.1.schema.json",
  "tool-api/tool-api.v1.schema.json",
  "tool-api/tool-api.v1.1.schema.json",
  "tool-api/tool-api.v1.2.schema.json",
  "tool-api/tool-api.v1.3.schema.json",
  "tool-api/tool-api.v1.4.schema.json",
  "tool-api/tool-api.v1.5.schema.json",
] as const;

/** Ajv's options, for the compiler here and for the prebuilt code (infra/build/tool-api-validators.mjs). */
export const AJV_OPTIONS = { strict: true, strictRequired: false, allErrors: true } as const;

/** True inside the Workers runtime (workerd), whose navigator names it; Node's names Node.js. */
export const RUNS_IN_WORKERD = navigator.userAgent === "Cloudflare-Workers";

/**
 * The repository's contracts/ folder: this file is actions/src/tool-api/validator.ts. Empty inside workerd, which has no
 * contracts/ on disk (its checks are the prebuilt code).
 */
export const CONTRACTS_DIR = RUNS_IN_WORKERD
  ? ""
  : fileURLToPath(new URL("../../../contracts/", import.meta.url));

/** At most this many problem lines come back; one more line says how many were left out. */
const MAX_PROBLEMS = 20;

/** The three definitions every call has under `$defs` (02-contracts section 2 item 2). */
export type CallPart = "request" | "response" | "errors";

export interface ToolApiValidator {
  /** The problems K-09 v1.5's `$defs/<call>.<part>` finds in `value`, one line each; empty when accepted. */
  check(call: CallName, part: CallPart, value: unknown): string[];
  /** The problems K-08 v1.1's `span` finds in `value`, one line each; empty when accepted. */
  checkSpan(value: unknown): string[];
}

/** One definition's check, compiled or prebuilt: true when the value passes; when not, its errors are on `errors`. */
export interface Validate {
  (data: unknown): boolean;
  errors?: ErrorObject[] | null;
}

/**
 * The checks of the frozen definitions, by a schema's $id and a definition's name; a definition the checks do not hold
 * throws.
 */
export type DefinitionChecks = (schemaId: string, definition: string) => Validate;

/** Reads the frozen schema files from `contractsDir` (default: this repository's contracts/); Node only. */
export function loadToolApiSchemas(contractsDir: string = CONTRACTS_DIR): object[] {
  if (RUNS_IN_WORKERD) {
    throw new Error(
      "workerd has no contracts/ on disk: createToolApiValidator() uses the prebuilt validators there",
    );
  }
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

/** `$defs/<definition>` of the schema whose $id is `schemaId`, as a $ref. */
const refOf = (schemaId: string, definition: string): string => `${schemaId}#/$defs/${definition}`;

/** One strict Ajv 2020-12 instance holding `schemas`: each definition compiled the first time it is checked, and kept. */
function compiledValidators(schemas: readonly object[]): DefinitionChecks {
  const ajv = new Ajv2020(AJV_OPTIONS);
  for (const schema of schemas) ajv.addSchema(schema);
  return (schemaId, definition) => {
    const validate = ajv.getSchema(refOf(schemaId, definition));
    if (validate === undefined) throw new Error(`${schemaId} has no definition ${definition}`);
    return validate;
  };
}

/** Whether two lists hold the same strings, in any order. */
function sameList(a: readonly string[], b: readonly string[]): boolean {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/**
 * The prebuilt code (./generated/validators.js), once it is shown to hold exactly these schemas with these options:
 * code built for other schemas or options throws rather than check against the wrong contract.
 */
function prebuiltValidators(): DefinitionChecks {
  const options = Object.entries(AJV_OPTIONS);
  const stale =
    prebuilt.toolApiSchemaId !== TOOL_API_SCHEMA_ID ||
    prebuilt.eventTraceSchemaId !== EVENT_TRACE_SCHEMA_ID ||
    prebuilt.modelSchemaId !== MODEL_SCHEMA_ID ||
    !sameList(prebuilt.schemaFiles, SCHEMA_FILES) ||
    Object.keys(prebuilt.options).length !== options.length ||
    options.some(([name, value]) => prebuilt.options[name] !== value);
  if (stale) {
    throw new Error(
      "the prebuilt validators hold other schemas or options than validator.ts: run npm run build:validators " +
        "(after changing validator.ts's contracts or options, infra/build/tool-api-validators.mjs's first)",
    );
  }
  return (schemaId, definition) => {
    const validate = prebuiltDefinitions[refOf(schemaId, definition)];
    if (validate === undefined) throw new Error(`${schemaId} has no definition ${definition}`);
    return validate;
  };
}

/**
 * The checks the Tool API's validator and the frontier's checker run on. In Node: one strict Ajv 2020-12 instance
 * holding `schemas` (default: the frozen files from disk). Inside workerd: the prebuilt code, which holds the frozen
 * files as the build read them; workerd cannot compile, so passing `schemas` there throws.
 */
export function definitionChecks(schemas?: readonly object[]): DefinitionChecks {
  if (!RUNS_IN_WORKERD) return compiledValidators(schemas ?? loadToolApiSchemas());
  if (schemas !== undefined) {
    throw new Error(
      "Ajv's compiler cannot run inside workerd (new Function): the prebuilt validators check there, so pass no schemas",
    );
  }
  return prebuiltValidators();
}

/**
 * The one validator, over definitionChecks(schemas). Either way, a definition the validator does not hold throws, since
 * the call list and the contract must never drift apart; a name that is no call of K-09 v1 throws before any check.
 */
export function createToolApiValidator(schemas?: readonly object[]): ToolApiValidator {
  if (RUNS_IN_WORKERD && schemas !== undefined) {
    throw new Error(
      "Ajv's compiler cannot run inside workerd (new Function): call createToolApiValidator() there",
    );
  }
  const validatorOf = definitionChecks(schemas);
  const problemsOf = (validate: Validate, value: unknown): string[] =>
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
