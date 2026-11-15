// Staging's row reads and plan calls (the D-017 path audit's P4b: ops/reviews/D-017-path-audit/order_d017.txt line 36;
// T-1399; the lead's notes DL-414, DL-438 to DL-468, DL-476, DL-757 and DL-768). T-1257 made this file with its final
// signature; T-1399 binds it and edits nothing else (./options.ts hands it its part).
//
// Three RootOptions inputs (../real.ts ComposeReads, FinalizeData and PlanCalls), each call through the root's handle
// (./part.ts StagingDb over T-1254's ./db.ts): one short-lived client per call, its guard the first statement, ended after
// the call, also when it throws. No code here sets a role, a search path or a scope of its own: the login is the
// binding's (ADR-014 sections 1 and 3), and the scope is db/repo's (scope.ts withBusiness; turn-face-reads.ts).
//
//   composeReads  `scope`: @rosie/actions' pgCallScope over a Tool API client (part.db.toolApi: HYPERDRIVE_APP, the login
//                 rosie_worker_app, rosie_app's rights only), opened for that one compose input and held until it ends, so
//                 the call runs in one transaction under its own business (rosie.business_id set first, checked again at
//                 the end). `readOutboxRow`: pgRowData's, K-05 v1.3 item 35 as v1.6 answers it (item 45's switch always
//                 stated), on a runtime-side client of its own (part.db.runtime: HYPERDRIVE_JOB, rosie_worker_job), a
//                 read-only transaction under the request's business.
//   finalizeData  the same scope for each finalize, and pgRowData's four calls, each on a runtime-side client of its own:
//                 readOutboxRow, readFixedLineFacts (K-05 v1.3 item 36), writePlan (K-05 v1 item 2: the plan and the final
//                 parts written together) and cancelClock (K-05 v1 item 5: the passed-on path's withdrawal).
//   planCalls     db/repo/outbox.ts's K-05 v1 unplannedRows and writePlan, `(request) => unplannedRows(sql, request)` and
//                 `(request) => writePlan(sql, request)`, each on a runtime-side client of its own (../real.ts, the seams'
//                 table).
//
// A compose input or a finalize holds its Tool API client's one connection while each of its runtime-side calls opens and
// ends a client of its own, so it holds 2 connections at most, and two of them side by side 4, under the 6 a Worker may
// hold (./db.ts CONNECTIONS_PER_CLIENT; ADR-014 Consequences, "Connections inside one call"; critic_collisions N2). No
// client is shared between calls, so none waits for a connection another call holds.
//
// Each answer goes back as K-05 gives it, a transient one included: the Tool API base, finalize and the turn check it
// (../real.ts realComposeInput, realFinalize and realDataAccess). Nothing is remembered between calls.
//
//   bound    staging, with the bindings an input needs present. composeReads and finalizeData need both HYPERDRIVE_APP
//            (the scope) and HYPERDRIVE_JOB (the row calls); planCalls needs HYPERDRIVE_JOB. Only their presence is read
//            as the root is built; each connection string is the handle's to read, at each call.
//   unbound  any environment but staging, checked before anything else is read; or a binding an input needs is missing:
//            that input is null, as the Worker's root has always handed, so it fails closed as its port does with nothing
//            bound, before anything is read or written: compose input and finalize inside the Tool API base, unplannedRows
//            and writePlan at once (../real.ts NoDatabaseError, naming the call). With neither binding present every input
//            is null (DL-768). In production ./options.ts builds no part, and the three ports stay closed (../picks.ts).
//   failing  bound, and a call cannot be made (the handle's refusal, a connect that fails, DB_SCHEMA set, a database
//            error): it throws, with nothing written. The handle's own errors name the call, the side, the binding and a
//            reason, a check's label or a SQLSTATE (./db.ts). db/repo's five calls answer K-05's transient or throw
//            scrubbed, the call's name and a SQLSTATE or the client's code alone (db/repo/clocks.ts transientOrScrubbed).
//            A failure of the scope's own start, once the handle's guard has passed, is thrown scrubbed too, under
//            db/repo's own name for it, withBusiness, since pgCallScope names no call (db/repo/scope.ts).
//
// Nothing is logged here, and nothing is put in a span: the handle writes each call's timing, labels and numbers only
// (./part.ts dbCallLine; these seams carry no trace id, so each line's trace_id is null), and the guard's refusal its one
// line. No word of a text, a plan or final parts, no number, address or connection string is in a log line or an error.
//
// pgRowData is not among @rosie/actions' turn-face/pg/index.ts exports (critic_size N5): it is imported by its own file.

import type { BusinessScope } from "@rosie/actions/src/tool-api/scope";
import { pgCallScope, pgRowData } from "@rosie/actions/src/tool-api/turn-face/pg/calls";
import { unplannedRows, writePlan } from "@rosie/db/repo/outbox";
import type { Tx } from "@rosie/db/repo/scope";

import { environmentOf } from "../picks";
import type { ComposeReads, FinalizeData, PlanCalls } from "../real";
import type { StagingDb, StagingPart } from "./part";

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

/**
 * Each call's name on the handle: on its timing line, and on every error of the handle's that leaves it. The scope's are
 * K-09's names for the call each transaction is opened for; the others K-05's.
 */
export const ROW_CALLS = Object.freeze({
  composeScope: "composeInput",
  finalizeScope: "finalizeMessage",
  readOutboxRow: "readOutboxRow",
  readFixedLineFacts: "readFixedLineFacts",
  writePlan: "writePlan",
  cancelClock: "cancelClock",
  unplannedRows: "unplannedRows",
} as const);

/** A binding is present when the env holds a value for it; its connection string is never read here. */
const present = (binding: unknown): boolean => binding !== undefined && binding !== null;

/**
 * The Tool API's own business scope for one call: pgCallScope over a Tool API client opened for that call (HYPERDRIVE_APP,
 * rosie_worker_app), which the handle guards first and ends when the call's transaction has ended.
 */
function scopeFor(db: StagingDb, call: string): BusinessScope<Tx> {
  return {
    withBusiness: (businessId, work) =>
      db.toolApi(call, (sql) => pgCallScope(sql).withBusiness(businessId, work)),
  };
}

/** pgRowData's four K-05 calls, each on a runtime-side client of its own (HYPERDRIVE_JOB, rosie_worker_job). */
function rowDataOn(
  db: StagingDb,
): Pick<FinalizeData, "readOutboxRow" | "readFixedLineFacts" | "writePlan" | "cancelClock"> {
  return {
    readOutboxRow: (request) =>
      db.runtime(ROW_CALLS.readOutboxRow, (sql) => pgRowData(sql).readOutboxRow(request)),
    readFixedLineFacts: (request) =>
      db.runtime(ROW_CALLS.readFixedLineFacts, (sql) => pgRowData(sql).readFixedLineFacts(request)),
    writePlan: (request) => db.runtime(ROW_CALLS.writePlan, (sql) => pgRowData(sql).writePlan(request)),
    cancelClock: (request) => db.runtime(ROW_CALLS.cancelClock, (sql) => pgRowData(sql).cancelClock(request)),
  };
}

/**
 * RootOptions.composeReads, finalizeData and planCalls for staging, each call on one guarded client of the root's handle:
 * the Tool API's scope on HYPERDRIVE_APP, K-05's row reads and plan calls on HYPERDRIVE_JOB. Anywhere but staging every
 * input is null and no binding is read; on staging an input is null while a binding it needs is missing.
 */
export const stagingRowCalls: (part: RowCallsPart) => RowInputs = ({ env, db }) => {
  if (environmentOf(env) !== "staging") return NO_ROW_INPUTS;
  // Each binding's presence, once, as the root is built; its connection string is the handle's to read, at each call.
  const job = present(env.HYPERDRIVE_JOB);
  const app = present(env.HYPERDRIVE_APP);
  if (!job) return NO_ROW_INPUTS;
  const rows = rowDataOn(db);
  return {
    composeReads: app
      ? { scope: scopeFor(db, ROW_CALLS.composeScope), readOutboxRow: rows.readOutboxRow }
      : null,
    finalizeData: app ? { scope: scopeFor(db, ROW_CALLS.finalizeScope), ...rows } : null,
    planCalls: {
      unplannedRows: (request) => db.runtime(ROW_CALLS.unplannedRows, (sql) => unplannedRows(sql, request)),
      writePlan: (request) => db.runtime(ROW_CALLS.writePlan, (sql) => writePlan(sql, request)),
    },
  };
};
