// The effects runner's own errors (T-323). Messages name labels and effect ids, never a value of a row (K-08 v1 README
// "Never the raw number or words").

import type { RowReport } from "./types";

/** A runner made with what it cannot run under: a claimer that is not a label, or a claim limit outside 1 to 100. */
export class EffectsRunnerConfigError extends Error {
  override name = "EffectsRunnerConfigError";
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`cannot make the effects runner: ${problems.join("; ")}`);
    this.problems = problems;
  }
}

/** One row whose run threw (its zone read, or K-05's call itself), so its result is not known to be recorded. */
export interface RowFailure {
  readonly effectId: string;
  readonly error: unknown;
}

/**
 * Some rows' runs threw. Thrown once every row of the run has ended, so no row is cut short by another's failure; it
 * carries the rows that ended and each failure. A failed row's claim lapses and the row is claimed and run again on its
 * same idempotency key.
 */
export class EffectsRunnerError extends Error {
  override name = "EffectsRunnerError";
  readonly rows: readonly RowReport[];
  readonly failures: readonly RowFailure[];

  constructor(rows: readonly RowReport[], failures: readonly RowFailure[]) {
    super(
      `${String(failures.length)} effect row(s) failed: ${failures.map((failure) => failure.effectId).join(", ")}`,
    );
    this.rows = rows;
    this.failures = failures;
  }
}
