// The frontier's checks against K-02 v1 (T-291): each source's choices, open questions and cards before they join the
// frontier, and the whole context before it is answered. One strict Ajv 2020-12 instance over the frozen schemas the
// Tool API's validator holds (tool-api/validator.ts: K-02 v1 and every schema its $refs reach), so the frontier and the
// base read the same files. Problem lines name a path and what the schema wants, never a value.
//
// Ajv compiles with new Function, which the Workers runtime refuses: the Tool API base's open point (actions/README.md,
// "Ajv in the Worker") covers these checks too.

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

import { formatProblems, loadToolApiSchemas } from "../../tool-api/validator";

/** The $id of K-02 v1 (contracts/README.md convention 2). */
export const MODEL_SCHEMA_ID = "https://rosie.invalid/contracts/model/model.v1.schema.json";

/** The K-02 v1 definitions the frontier checks. */
export type K02Part = "choice" | "openQuestion" | "stepCard" | "context";

export interface FrontierChecker {
  /** The problems K-02 v1's `$defs/<part>` finds in `value`, one line each; empty when accepted. */
  check(part: K02Part, value: unknown): string[];
}

export function createFrontierChecker(schemas: readonly object[] = loadToolApiSchemas()): FrontierChecker {
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  for (const schema of schemas) ajv.addSchema(schema);
  const compiled = new Map<K02Part, ValidateFunction>();
  const validatorOf = (part: K02Part): ValidateFunction => {
    const known = compiled.get(part);
    if (known !== undefined) return known;
    const validate = ajv.getSchema(`${MODEL_SCHEMA_ID}#/$defs/${part}`);
    if (validate === undefined) throw new Error(`K-02 v1 has no definition ${part}`);
    compiled.set(part, validate);
    return validate;
  };
  return {
    check(part, value) {
      const validate = validatorOf(part);
      return validate(value) ? [] : formatProblems(validate.errors);
    },
  };
}

let shared: FrontierChecker | undefined;

/** One checker per isolate, made on first use. */
export function defaultChecker(): FrontierChecker {
  shared ??= createFrontierChecker();
  return shared;
}
