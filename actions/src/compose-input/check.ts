// The input's own check before it goes (T-309, T-1165): K-03 v1's `$defs/composeInput`, whose additionalProperties false
// is what refuses a frontier (arch 07 line 397: "never the frontier"; refuse-frontier-in-input.json), and K-03's code
// check that <conversation> holds at most 6 messages. Problem lines name a path and what the schema wants, never a value.
//
// The base checks the answer against K-09 again after the handler; this check is the call's own, so an input that
// carries anything K-03 does not name is refused here, by name, before it can reach the base or the composer.
//
// Two ways to run the same check, one answer (T-1165; DL-345, DL-357), as the Tool API's validator and the frontier's
// checks run theirs (tool-api/validator.ts):
//   - In Node, Ajv's compiler with the validator's strict options (definitionChecks), on the frozen K-03 files read from
//     contracts/ on disk: COMPOSE_INPUT_SCHEMA_FILES, the files K-03 v1's and v1.1's composeInput reach.
//   - Inside the Worker (workerd), the prebuilt code: Ajv compiles a schema with new Function, which the Workers runtime
//     refuses, so `npm run build:validators` (infra/build/tool-api-validators.mjs) compiles both versions' composeInput
//     ahead of time, with the same options, into compose-input-validators.js (tool-api/generated/, git-ignored) and
//     checks that the code gives the compiler's answer to each K-03 input on the contracts' fixtures. Nothing is
//     evaluated at run time (check.worker.test.ts).
// K-03 v1 is the input compose input checks; K-03 v1.1, whose facts may also be term facts, is prebuilt too, because
// T-1174 moves compose input to it (DL-355): a checker made for v1.1 checks it, in Node and in the Worker alike.

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  build as prebuilt,
  definitions as prebuiltDefinitions,
} from "../tool-api/generated/compose-input-validators";
import {
  AJV_OPTIONS,
  CONTRACTS_DIR,
  RUNS_IN_WORKERD,
  definitionChecks,
  formatProblems,
  type DefinitionChecks,
  type Validate,
} from "../tool-api/validator";
import { MAX_CONVERSATION } from "./build";
import { ComposeInputRefusedError } from "./errors";
import type { ComposeInput } from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The $id of K-03 v1, whose composeInput compose input checks (contracts/README.md convention 2). */
export const MESSAGE_PLAN_SCHEMA_ID =
  "https://rosie.invalid/contracts/message-plan/message-plan.v1.schema.json";

/**
 * The $id of K-03 v1.1, whose composeInput's facts may also be term facts (K-03 README "v1.1"): T-1174 moves compose
 * input to it (DL-355).
 */
export const MESSAGE_PLAN_V1_1_SCHEMA_ID =
  "https://rosie.invalid/contracts/message-plan/message-plan.v1.1.schema.json";

/** The K-03 versions whose composeInput a checker can check, in the build's order (its MESSAGE_PLAN_FILES). */
export const COMPOSE_INPUT_SCHEMA_IDS = [MESSAGE_PLAN_SCHEMA_ID, MESSAGE_PLAN_V1_1_SCHEMA_ID] as const;

/** One of the K-03 versions whose composeInput a checker can check. */
export type ComposeInputSchemaId = (typeof COMPOSE_INPUT_SCHEMA_IDS)[number];

/**
 * The frozen schema files the check holds, relative to contracts/: K-03 v1 and v1.1 and every file their $refs reach
 * (a test checks that the list is exactly that closure).
 */
export const COMPOSE_INPUT_SCHEMA_FILES = [
  "common/formats.v1.schema.json",
  "bundle/bundle.v1.schema.json",
  "message-plan/message-plan.v1.schema.json",
  "message-plan/message-plan.v1.1.schema.json",
] as const;

/** The K-03 definition the check reads. */
const COMPOSE_INPUT = "composeInput";

export interface ComposeInputChecker {
  /**
   * The problems K-03's composeInput (K-03 v1's, or the version the checker was made for) finds in `value` as a
   * composer input, one line each; empty when accepted.
   */
  check(value: unknown): string[];
}

/** Reads the check's frozen schema files from `contractsDir` (default: this repository's contracts/); Node only. */
export function loadComposeInputSchemas(contractsDir: string = CONTRACTS_DIR): object[] {
  if (RUNS_IN_WORKERD) {
    throw new Error(
      "workerd has no contracts/ on disk: createComposeInputChecker() uses the prebuilt validators there",
    );
  }
  return COMPOSE_INPUT_SCHEMA_FILES.map(
    (file) => JSON.parse(readFileSync(path.join(contractsDir, ...file.split("/")), "utf8")) as object,
  );
}

/** Whether two lists hold the same strings, in any order. */
function sameList(a: readonly string[], b: readonly string[]): boolean {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/**
 * The prebuilt code (tool-api/generated/compose-input-validators.js), once it is shown to hold exactly these K-03
 * versions, from exactly these files, with the validator's options: code built for others throws rather than check
 * against the wrong contract.
 */
function prebuiltChecks(): DefinitionChecks {
  const options = Object.entries(AJV_OPTIONS);
  const stale =
    !sameList(prebuilt.messagePlanSchemaIds, COMPOSE_INPUT_SCHEMA_IDS) ||
    !sameList(prebuilt.schemaFiles, COMPOSE_INPUT_SCHEMA_FILES) ||
    Object.keys(prebuilt.options).length !== options.length ||
    options.some(([name, value]) => prebuilt.options[name] !== value);
  if (stale) {
    throw new Error(
      "the prebuilt compose input validators hold other schemas or options than check.ts: run npm run " +
        "build:validators (after changing check.ts's contracts, infra/build/tool-api-validators.mjs's first)",
    );
  }
  return (schemaId, definition) => {
    const validate = prebuiltDefinitions[`${schemaId}#/$defs/${definition}`];
    if (validate === undefined) throw new Error(`${schemaId} has no definition ${definition}`);
    return validate;
  };
}

/**
 * The checker of K-03's composeInput: K-03 v1's unless `schemaId` names v1.1's. In Node: Ajv's compiler with the Tool API
 * validator's options, holding `schemas` (default: the frozen files from disk, COMPOSE_INPUT_SCHEMA_FILES). Inside
 * workerd: the prebuilt code; workerd cannot compile, so passing `schemas` there throws. A version that is none of
 * COMPOSE_INPUT_SCHEMA_IDS throws in both, rather than check against a definition the Worker does not hold.
 */
export function createComposeInputChecker(
  schemas?: readonly object[],
  schemaId: ComposeInputSchemaId = MESSAGE_PLAN_SCHEMA_ID,
): ComposeInputChecker {
  if (!(COMPOSE_INPUT_SCHEMA_IDS as readonly string[]).includes(schemaId)) {
    throw new Error("not a K-03 version whose composeInput compose input checks");
  }
  if (RUNS_IN_WORKERD && schemas !== undefined) {
    throw new Error(
      "Ajv's compiler cannot run inside workerd (new Function): call createComposeInputChecker() there",
    );
  }
  const checks = RUNS_IN_WORKERD ? prebuiltChecks() : definitionChecks(schemas ?? loadComposeInputSchemas());
  let validate: Validate | undefined;
  return {
    check(value) {
      validate ??= checks(schemaId, COMPOSE_INPUT);
      const problems = validate(value) ? [] : formatProblems(validate.errors);
      const conversation = isRecord(value) ? value.conversation : undefined;
      if (Array.isArray(conversation) && conversation.length > MAX_CONVERSATION) {
        problems.push(`/conversation holds more than ${String(MAX_CONVERSATION)} messages`);
      }
      return problems;
    },
  };
}

let shared: ComposeInputChecker | undefined;

/** One checker per isolate, made on first use: K-03 v1's. */
export function defaultComposeInputChecker(): ComposeInputChecker {
  shared ??= createComposeInputChecker();
  return shared;
}

/**
 * The input, once the checker's K-03 version accepts it; refused (thrown, with the count of problems and never a value)
 * when it does not: an input with a frontier, or any field K-03 does not name, never goes.
 */
export function admitInput(value: unknown, checker: ComposeInputChecker): ComposeInput {
  const problems = checker.check(value);
  if (problems.length > 0) throw new ComposeInputRefusedError("inputRefused", problems.length);
  return value as ComposeInput;
}
