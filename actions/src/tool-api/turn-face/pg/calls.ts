// The turn face's calls after the frontier on PostgreSQL (T-1141; C-074): gate and commit, compose input and finalize,
// each run under the Tool API's own business scope, and each K-05 call that needs the runtime side in a transaction of its
// own (T-315's security note b; STATE notes 5 and 59).
//
// Who runs what (0012, 0016; K-05 v1.3 items 34 to 36 and v1.4 items 37 to 43):
//   - the call's transaction: one per call on `toolApi`, whose connections run as rosie_app, with rosie.business_id set to
//     the caller's business before the handler gets its repo and checked again at the end (db/repo/scope.ts
//     withBusiness). Every limit, the walk's reads, readOpenHolds and six of the seven safety reads run on it, each naming
//     the call's business;
//   - K-05's runtime-side calls on `runtime` (rosie_job), each its own transaction: commitTurn (T-306: unique on the turn
//     id, all or nothing), readBusinessOwner (person_handles and handles are the runtime's tables), and the sealer's read
//     of the person's key (sealing_keys is the runtime's table: sealer.ts), each scoped as its call says.
// Nothing here logs; what a call throws names a read, a fault or a SQLSTATE, never a value.

import { cancelClock } from "../../../../../db/repo/clocks";
import { writePlan } from "../../../../../db/repo/outbox";
import {
  readBusinessOwner,
  readBusinessZoneIn,
  readOutboxRowWrittenIn,
  readSafetyHoldIn,
  readSafetyHoldOfOutcomeIn,
  readSafetyOutcomeIn,
  readSafetyOutcomeOfEventIn,
} from "../../../../../db/repo/safety-reads";
import { withBusiness, type Sql, type Tx } from "../../../../../db/repo/scope";
import type { WrappingKeys } from "../../../../../db/repo/sealing";
import { readFixedLineFacts, readOpenHoldsIn, readOutboxRow } from "../../../../../db/repo/turn-face-reads";
import { pgCommitTurn } from "../../../commit/pg";
import type { SafetyTelling, StopWords } from "../../../domain/safety";
import type { FrontierBundles } from "../../../frontier";
import type { BusinessScope } from "../../scope";
import { turnCommitDeps, type SafetyReads, type TurnCommitBinding } from "../commit";
import { HeldTurns } from "../held";
import { composeInputDeps, finalizeDeps, type RowBinding, type RowData } from "../rows";
import type { TurnFaceCalls } from "../turn-face";
import { pgReadOnlySealer } from "./sealer";

/** The Tool API's own business scope on `toolApi` (rosie_app): one transaction per call (db/repo/scope.ts withBusiness). */
export function pgCallScope(toolApi: Sql): BusinessScope<Tx> {
  return { withBusiness: (businessId, work) => withBusiness(toolApi, businessId, work) };
}

/** K-05 v1.4's safety reads (T-1161): the In reads on the call's transaction, the owner on the runtime side. */
export function pgSafetyReads(runtime: Sql): SafetyReads<Tx> {
  return {
    outcomeOfEvent: (tx, request) => readSafetyOutcomeOfEventIn(tx, request),
    outcome: (tx, request) => readSafetyOutcomeIn(tx, request),
    hold: (tx, request) => readSafetyHoldIn(tx, request),
    holdOfOutcome: (tx, request) => readSafetyHoldOfOutcomeIn(tx, request),
    outboxRowWritten: (tx, request) => readOutboxRowWrittenIn(tx, request),
    businessZone: (tx, request) => readBusinessZoneIn(tx, request),
    businessOwner: (request) => readBusinessOwner(runtime, request),
  };
}

export interface PgTurnCallsOptions {
  /** The bundles, read under their ids (KV, or PostgreSQL's copy on a miss): the frontier's port. */
  readonly bundles: FrontierBundles;
  /** The wrapping key the sealer opens a person's data key with, read by name from the environment (T-182). */
  readonly wrappingKeys: WrappingKeys;
  /** The plug-in's stop words, named (PLUGIN_LISTS_NO_STOP_WORDS for the barbershop: DL-344). */
  readonly stopWords: StopWords;
  /** Who is told (NOT_TOLD_YET until T-319: DL-344). */
  readonly telling: SafetyTelling;
  /** The commit's moment, read once per commit: a test's fake clock. Default: the database's now() (T-306). */
  readonly now?: () => Date;
  /** The walk's turn key (K-09 v1.5 default 131). Default: the turn's own id. */
  readonly turnKey?: TurnCommitBinding<Tx>["turnKey"];
  /** The safety service's other ports (ids, readers, visits). Default: the service's own on the call's transaction. */
  readonly safetyExtra?: TurnCommitBinding<Tx>["safetyExtra"];
  /** Now, in UTC ending in Z, for a passed-on question's withdrawal. Default: the clock. */
  readonly finalizeNow?: RowBinding["now"];
  /** Where finalize's notes go (labels only). Default: finalize's own JSON line. */
  readonly finalizeLog?: RowBinding["log"];
}

/**
 * K-05 v1.3's two row reads and finalize's two K-05 writes, each in a transaction of its own on `runtime` (rosie_job):
 * the reads under the request's business, set and confirmed before the first read (T-1138), the writes on the runtime
 * side as K-05 runs them (T-196, T-197).
 */
export function pgRowData(runtime: Sql): RowData {
  return {
    readOutboxRow: (request) => readOutboxRow(runtime, request),
    readFixedLineFacts: (request) => readFixedLineFacts(runtime, request),
    writePlan: (request) => writePlan(runtime, request),
    cancelClock: (request) => cancelClock(runtime, request),
  };
}

/**
 * Gate and commit, compose input and finalize on PostgreSQL: `runtime` is a client whose connections run as rosie_job,
 * `toolApi` one whose connections run as rosie_app, both on the primary, uncached (arch 10 lines 504, 538).
 */
export function pgTurnCalls(runtime: Sql, toolApi: Sql, options: PgTurnCallsOptions): TurnFaceCalls<Tx> {
  const binding: TurnCommitBinding<Tx> = {
    bundles: options.bundles,
    commitTurn: pgCommitTurn<Tx>(runtime, options.now === undefined ? {} : { now: options.now }),
    readOpenHolds: (tx, request) => readOpenHoldsIn(tx, { ...request, eventIds: [...request.eventIds] }),
    safetyReads: pgSafetyReads(runtime),
    sealer: pgReadOnlySealer(runtime, options.wrappingKeys),
    stopWords: options.stopWords,
    telling: options.telling,
    ...(options.turnKey === undefined ? {} : { turnKey: options.turnKey }),
    ...(options.safetyExtra === undefined ? {} : { safetyExtra: options.safetyExtra }),
  };
  const held = new HeldTurns();
  const rows: RowBinding = {
    data: pgRowData(runtime),
    bundles: options.bundles,
    held,
    ...(options.finalizeNow === undefined ? {} : { now: options.finalizeNow }),
    ...(options.finalizeLog === undefined ? {} : { log: options.finalizeLog }),
  };
  return {
    scope: pgCallScope(toolApi),
    commit: turnCommitDeps(binding),
    compose: composeInputDeps<Tx>(rows),
    finalize: finalizeDeps<Tx>(rows),
    held,
  };
}
