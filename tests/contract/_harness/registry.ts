// The doubles that exist (T-003). Empty: no port has a double yet. The integrations engineer writes the doubles
// under adapters/ (M1 onward); when one merges, QA adds its DoubleSpec here (doubles.ts says what a spec holds).
// The sample double under sample/ is for the harness's own tests and is not listed.

import { createDoubleLoader, type DoubleLoader, type DoubleModule, type DoubleSpec } from "./doubles";

export const DOUBLE_SPECS: readonly DoubleSpec[] = [];

/** The loader over DOUBLE_SPECS. */
export const doubles: DoubleLoader = createDoubleLoader(DOUBLE_SPECS);

/** Loads the double of the named port. */
export function loadDouble(port: string): Promise<DoubleModule> {
  return doubles.load(port);
}
