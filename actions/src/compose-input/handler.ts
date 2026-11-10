// composeInput, the Tool API call (C-090, T-309, T-1174; K-09 v1.6 composeInput; arch 07 line 397: "After the commit,
// each outbox row gets its own composer call, in parallel, with its committed choices and only what limit 7 lets its
// recipient see, never the frontier; an email copy takes its text row's plan instead (DD)"). Registered on the T-290
// base (createToolApi), which checks the request against K-09 (v1.6's for composeInput: validator.ts), runs this handler
// inside one transaction scoped to the caller's business, holds the answer to composeInput's response or errors, and
// opens the call's one K-08 span (hop fillAndChecks). For one committed outbox row, in this order:
//
//   1. the row, read on the primary, uncached (readRow): its notFound and transient are composeInput's own errors;
//   2. a fixed-line row is never composed: it answers fixedLineRow with the fixed line's id (STATE note 17; K-09 README
//      v1.6 default 139); a row no longer to be sent answers rowClosed; a row that holds a plan answers alreadyPlanned
//      (after a crash only rows without a plan are composed: arch 11 line 576); a row neither planned nor stale is
//      thrown (K-07 v1); an email copy answers emailCopy with its text row (arch 07 lines 371, 397), and no composer
//      input;
//   3. the reader limit 7 reads, from the recipient's role at this business (T-311's readerOf; S13-31); a role that
//      reads as no one is thrown;
//   4. the step's master line from the bundle the row was committed under: the message's words alone, never its
//      plainText or stop marker (master-line.ts; DL-245), and its card's lines; a bundle, step or line that is missing
//      answers masterLineMissing, naming which (default 140);
//   5. the input, field by field (build.ts): the slot facts only as limit 7 lets this reader see them, then the card's
//      term facts with their source lines (term-facts.ts), the situation tag (situation.ts), never the frontier;
//   6. the input held to K-03 v1.1 (check.ts): one that K-03 refuses, a frontier among it, is thrown and never goes.
//
// Reads only: nothing is written, so a repeat is safe (K-09 README). No model is called here: the composer is the AI
// layer's (C-118), which T-252's turn loop calls with this input.

import { readerOf } from "../finalize/claim-check";
import { notBuiltHandlers, type CallContext, type Handler, type Handlers } from "../tool-api";
import { buildComposeInput } from "./build";
import { admitInput, defaultComposeInputChecker, type ComposeInputChecker } from "./check";
import { ComposeInputNotBuiltError, ComposeInputRefusedError } from "./errors";
import { readMasterLine } from "./master-line";
import type {
  ComposeBundles,
  ComposeInputAnswer,
  ComposeInputPorts,
  ComposeInputRequest,
  ComposeRow,
  MasterLineMissing,
  Missing,
  RowState,
} from "./types";

/** Rows no longer to be sent (K-07 v1; K-09 v1 rowClosed: dropped_stopped, withdrawn, superseded or failed). */
export const CLOSED_STATES: ReadonlySet<RowState> = new Set<RowState>([
  "dropped_stopped",
  "withdrawn",
  "superseded",
  "failed",
]);

/** The states a row without a plan is composed in (K-07 v1: planned; stale, its plan cleared, from today's record). */
export const COMPOSABLE_STATES: ReadonlySet<RowState> = new Set<RowState>(["planned", "stale"]);

/** What the compose-input call runs with. */
export interface ComposeInputDeps<Repo = unknown> {
  readonly ports: ComposeInputPorts<Repo>;
  /** The bundles the master line is read from (K-01 v1), the frontier's own port. */
  readonly bundles: ComposeBundles;
  /** The K-03 v1.1 check of the input. Default: one checker per isolate. */
  readonly checker?: ComposeInputChecker;
}

/** K-09 v1.6 masterLineMissing for a row: its row, the bundle its turn pinned, its step and what is missing (ids only). */
function masterLineMissing(row: ComposeRow, missing: Missing): MasterLineMissing {
  return {
    error: "masterLineMissing",
    outboxRowId: row.outboxRowId,
    bundleId: { hash: row.bundleId.hash, build: row.bundleId.build },
    step: row.step,
    missing,
  };
}

/** Every port of the compose-input call not built yet: each throws, so the call answers notBuilt and reads nothing. */
export function notBuiltComposeInputPorts<Repo = unknown>(): ComposeInputPorts<Repo> {
  return {
    readRow: () => Promise.reject(new ComposeInputNotBuiltError("readRow")),
  };
}

/** The compose-input call's steps for one request (see the top of this file). */
async function composeInput<Repo>(
  request: ComposeInputRequest,
  call: CallContext<Repo>,
  deps: ComposeInputDeps<Repo>,
): Promise<ComposeInputAnswer> {
  // 1. The row.
  const read = await deps.ports.readRow(request.outboxRowId, call);
  if ("error" in read) return read;
  const row = read;
  if (row.outboxRowId !== request.outboxRowId) throw new ComposeInputRefusedError("rowMismatch");

  // 2. What the row is.
  if (row.fixedLineId !== null) {
    return { error: "fixedLineRow", outboxRowId: row.outboxRowId, fixedLineId: row.fixedLineId };
  }
  if (CLOSED_STATES.has(row.state)) {
    return { error: "rowClosed", outboxRowId: row.outboxRowId, state: row.state };
  }
  if (row.hasPlan) return { error: "alreadyPlanned", outboxRowId: row.outboxRowId };
  if (!COMPOSABLE_STATES.has(row.state)) throw new ComposeInputRefusedError("rowNotComposable");
  if (row.copyOfRowId !== null) {
    if (row.channel !== "email") throw new ComposeInputRefusedError("copyNotEmail");
    return { result: "emailCopy", textRowId: row.copyOfRowId };
  }

  // 3. The reader.
  const reader = readerOf(row.role);
  if (reader === null) throw new ComposeInputRefusedError("noReader");

  // 4 to 6. The master line, the input, and its check.
  const master = await readMasterLine(deps.bundles, row, reader);
  if ("missing" in master) return masterLineMissing(row, master.missing);
  const input = buildComposeInput(row, reader, master.line);
  return { result: "compose", input: admitInput(input, deps.checker ?? defaultComposeInputChecker()) };
}

/** composeInput's handler on the Tool API base: its ports read inside the call's scoped transaction. */
export function createComposeInputHandler<Repo>(deps: ComposeInputDeps<Repo>): Handler<"composeInput", Repo> {
  return (request, call) => composeInput(request, call, deps);
}

/** Every call's handler for the base: composeInput built, every other call still its notBuilt stub. */
export function composeInputHandlers<Repo>(deps: ComposeInputDeps<Repo>): Handlers<Repo> {
  return { ...notBuiltHandlers(), composeInput: createComposeInputHandler<Repo>(deps) };
}
