// The input's own check before it goes (T-309): K-03 v1's `$defs/composeInput`, whose additionalProperties false is
// what refuses a frontier (arch 07 line 397: "never the frontier"; refuse-frontier-in-input.json), and K-03's code check
// that <conversation> holds at most 6 messages. One strict Ajv 2020-12 instance over the frozen schemas the Tool API's
// validator holds (tool-api/validator.ts: K-03 v1 is among them), as the frontier checks K-02 v1 (frontier/assemble/
// check.ts). Problem lines name a path and what the schema wants, never a value.
//
// The base checks the answer against K-09 v1 again after the handler; this check is the call's own, so an input that
// carries anything K-03 does not name is refused here, by name, before it can reach the base or the composer.
//
// Ajv compiles with new Function, which the Workers runtime refuses: the Tool API base's open point (actions/README.md,
// "Ajv in the Worker") covers this check too.

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

import { formatProblems, loadToolApiSchemas } from "../tool-api/validator";
import { MAX_CONVERSATION } from "./build";
import { ComposeInputRefusedError } from "./errors";
import type { ComposeInput } from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The $id of K-03 v1 (contracts/README.md convention 2). */
export const MESSAGE_PLAN_SCHEMA_ID =
  "https://rosie.invalid/contracts/message-plan/message-plan.v1.schema.json";

export interface ComposeInputChecker {
  /** The problems K-03 v1 finds in `value` as a composer input, one line each; empty when accepted. */
  check(value: unknown): string[];
}

export function createComposeInputChecker(
  schemas: readonly object[] = loadToolApiSchemas(),
): ComposeInputChecker {
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  for (const schema of schemas) ajv.addSchema(schema);
  let validate: ValidateFunction | undefined;
  return {
    check(value) {
      validate ??= ajv.getSchema(`${MESSAGE_PLAN_SCHEMA_ID}#/$defs/composeInput`);
      if (validate === undefined) throw new Error("K-03 v1 has no definition composeInput");
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

/** One checker per isolate, made on first use. */
export function defaultComposeInputChecker(): ComposeInputChecker {
  shared ??= createComposeInputChecker();
  return shared;
}

/**
 * The input, once K-03 v1 accepts it; refused (thrown, with the count of problems and never a value) when it does not:
 * an input with a frontier, or any field K-03 does not name, never goes.
 */
export function admitInput(value: unknown, checker: ComposeInputChecker): ComposeInput {
  const problems = checker.check(value);
  if (problems.length > 0) throw new ComposeInputRefusedError("inputRefused", problems.length);
  return value as ComposeInput;
}
