// The frontier's checks against K-02 v1.1 (T-291, T-1150): each source's choices, open questions and cards before they
// join the frontier, and the whole context before it is answered, against K-02 v1.1's choice, openQuestion, stepCard
// and context. v1.1's doors also take signUp, the door to S1-01 (K-02 README "v1.1", default 9), and every K-02 v1 value
// is a v1.1 value. The checks are the Tool API validator's own (tool-api/validator.ts, definitionChecks: the frozen
// schemas K-09 v1.5 reaches, K-02 v1.1 among them, with the same strict options), so the frontier and the base read the
// same files: in Node, Ajv's compiler; inside the Worker (workerd), the prebuilt code `npm run build:validators` compiles
// for these four definitions beside the Tool API's (infra/build/tool-api-validators.mjs), so no code is made at run
// time (check.worker.test.ts). Problem lines name a path and what the schema wants, never a value.

import { MODEL_SCHEMA_ID, RUNS_IN_WORKERD, definitionChecks, formatProblems } from "../../tool-api/validator";

export { MODEL_SCHEMA_ID };

/** The K-02 v1.1 definitions the frontier checks, which the build compiles for the Worker (its MODEL_PARTS). */
export const K02_PARTS = ["choice", "openQuestion", "stepCard", "context"] as const;

/** One of the K-02 v1.1 definitions the frontier checks. */
export type K02Part = (typeof K02_PARTS)[number];

export interface FrontierChecker {
  /** The problems K-02 v1.1's `$defs/<part>` finds in `value`, one line each; empty when accepted. */
  check(part: K02Part, value: unknown): string[];
}

/**
 * The frontier's checker. In Node: one strict Ajv 2020-12 instance holding `schemas` (default: the frozen files the Tool
 * API's validator reads from disk). Inside workerd: the prebuilt code; workerd cannot compile, so passing `schemas`
 * there throws. A name that is none of K02_PARTS throws in both, rather than check against a definition the Worker does
 * not hold.
 */
export function createFrontierChecker(schemas?: readonly object[]): FrontierChecker {
  if (RUNS_IN_WORKERD && schemas !== undefined) {
    throw new Error(
      "Ajv's compiler cannot run inside workerd (new Function): call createFrontierChecker() there",
    );
  }
  const checks = definitionChecks(schemas);
  return {
    check(part, value) {
      if (!(K02_PARTS as readonly string[]).includes(part)) {
        throw new Error("not a K-02 v1.1 definition the frontier checks");
      }
      const validate = checks(MODEL_SCHEMA_ID, part);
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
