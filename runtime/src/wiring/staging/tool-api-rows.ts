// Staging's row reads and plan calls (the D-017 path audit's P4b: ops/reviews/D-017-path-audit/order_d017.txt line 36;
// T-1399). T-1257 made this file with its final signature; T-1399 binds it and edits nothing else.
//
// T-1399 gives RootOptions.composeReads and finalizeData (the Tool API's scope on a HYPERDRIVE_APP client, part.db.toolApi;
// pgRowData's K-05 calls on HYPERDRIVE_JOB clients, part.db.runtime) and planCalls (K-05 v1 unplannedRows and writePlan,
// db/repo/outbox.ts, on HYPERDRIVE_JOB clients). Until then each is null, as the Worker's root has always handed: every
// compose input and finalize fails closed inside the Tool API base, and every plan call fails closed (../real.ts
// NoDatabaseError naming the call), so no row of a turn is listed, composed, finalized or planned. Nothing here reads a
// binding.

import type { ComposeReads, FinalizeData, PlanCalls } from "../real";
import type { StagingPart } from "./part";

/** What T-1399's builder is handed: the env and the root's handle. */
export type RowCallsPart = StagingPart;

/** The three RootOptions inputs for a turn's rows, each null where it is not bound. */
export interface RowInputs {
  readonly composeReads: ComposeReads | null;
  readonly finalizeData: FinalizeData | null;
  readonly planCalls: PlanCalls | null;
}

/** None of the three bound: each fails closed as its port does with nothing bound. */
export const NO_ROW_INPUTS: RowInputs = Object.freeze({
  composeReads: null,
  finalizeData: null,
  planCalls: null,
});

/** RootOptions.composeReads, finalizeData and planCalls for staging: all null until T-1399 binds them. */
export const stagingRowCalls: (part: RowCallsPart) => RowInputs = () => NO_ROW_INPUTS;
