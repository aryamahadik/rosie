// What the compose-input call throws (T-309). Each message names a fault or a port: never a value, a step's words or a
// text. A throw inside composeInput's handler rolls the call's transaction back (the Tool API base), which records a
// failed span and passes the throw on, so no composer input goes out (fail closed).

import { NotBuiltError } from "../tool-api/errors";

/** A port of the compose-input call not built yet (types.ts ComposeInputPorts). */
export type ComposeInputSeam = "readRow";

/**
 * Something the compose-input call needs is not built yet: the Tool API base answers composeInput `notBuilt` and rolls
 * the call back, so nothing is composed (fail closed).
 */
export class ComposeInputNotBuiltError extends NotBuiltError {
  override name = "ComposeInputNotBuiltError";
  readonly seam: ComposeInputSeam;

  constructor(seam: ComposeInputSeam) {
    super("composeInput");
    this.message = `composeInput: ${seam} is not built yet; nothing was composed`;
    this.seam = seam;
  }
}

/**
 * Why the compose-input call refused a request it cannot answer with one of K-09 v1's errors (fail closed):
 *   - rowMismatch: the row read names another row than the request's;
 *   - fixedLineRow: the row carries a fixed line code writes word for word, so it is never composed (STATE note 17);
 *   - rowNotComposable: the row holds no plan but is neither planned nor stale (K-07 v1), so nothing may compose it;
 *   - copyNotEmail: a row that names a text row to copy goes on a text channel (K-05 v1 outboxRowNew: only an email row
 *     is a copy);
 *   - noReader: the recipient's role reads as no reader (readerOf: own_business, or a role K-04 does not name), so limit
 *     7 could show them nothing;
 *   - bundleMissing: the row's bundle is in neither KV nor PostgreSQL's copy;
 *   - stepMissing: the row's step is in none of the bundle's flow graphs;
 *   - noMasterLine: the step prints no line from Rosie to this reader at the row's index, so there is no master text;
 *   - inputRefused: the input built breaks K-03 v1's composeInput (a frontier among it, say), so it never goes.
 */
export type ComposeInputFault =
  | "rowMismatch"
  | "fixedLineRow"
  | "rowNotComposable"
  | "copyNotEmail"
  | "noReader"
  | "bundleMissing"
  | "stepMissing"
  | "noMasterLine"
  | "inputRefused";

/** The compose-input call refused the request: nothing was composed. */
export class ComposeInputRefusedError extends Error {
  override name = "ComposeInputRefusedError";
  readonly fault: ComposeInputFault;
  /** How many problems K-03 v1 found, for inputRefused (a count, never a value); else 0. */
  readonly problems: number;

  constructor(fault: ComposeInputFault, problems = 0) {
    super(`composeInput: refused (${fault}); nothing was composed`);
    this.fault = fault;
    this.problems = problems;
  }
}
