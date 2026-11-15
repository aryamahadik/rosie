// Staging's gate reads (the D-017 path audit's P4a: ops/reviews/D-017-path-audit/order_d017.txt line 35; T-1398; the
// lead's notes DL-397, DL-757, DL-760, DL-761, DL-768 and DL-776; T-1242's architect's note N3). T-1257 made this file with
// its final signature (DL-757); T-1398 binds it and edits nothing else (./options.ts hands it its part).
//
// RootOptions.gateReads (../real.ts GateReads) from @rosie/actions' PostgreSQL pieces, each on the side ADR-014 and
// @rosie/actions' turn-face/pg/calls.ts lines 5 to 12 give it, every call through the root's handle (./part.ts StagingDb
// over T-1254's ./db.ts): one short-lived client per call, its guard the first statement, ended after the call, also when
// it throws. No code here sets a role, a search path or a scope of its own: the login is the binding's (ADR-014 sections
// 1 and 3), and the scope is db/repo's (scope.ts withBusiness).
//
//   scope        @rosie/actions' pgCallScope over a Tool API client (part.db.toolApi: HYPERDRIVE_APP, the login
//                rosie_worker_app, rosie_app's rights only), opened for that one gate call and held until its transaction
//                ends, with rosie.business_id set to the caller's business first and checked again at the end. At most
//                GATE_CLIENTS_AT_ONCE gate calls hold such a client at once; another waits for one to end (DL-761).
//   readOpenHolds  K-05 v1.3 item 34, db/repo's readOpenHoldsIn on the call's transaction (rosie_app), its eventIds copied
//                as calls.ts line 100 copies them.
//   safetyReads  K-05 v1.4's seven reads as pgSafetyReads binds them (calls.ts lines 45 to 55): items 37 to 41 and 43
//                (readSafetyOutcomeOfEventIn, readSafetyOutcomeIn, readSafetyHoldIn, readSafetyHoldOfOutcomeIn,
//                readOutboxRowWrittenIn, readBusinessZoneIn) on the call's transaction, and item 42 (readBusinessOwner) on
//                a runtime-side client of its own (part.db.runtime: HYPERDRIVE_JOB, the login rosie_worker_job, which
//                inherits rosie_job), in its own read-only transaction under the business, after requireBusinessScope().
//                pgSafetyReads takes one runtime-side client for the binding's whole life, which the handle never gives
//                (one client per call), so its seven lines are bound here as it binds them, the owner's over the client
//                opened for that read.
//   sealer       @rosie/actions' pgReadOnlySealer over a runtime-side client opened for each seal, with the
//                SEALING_WRAP_KEY-only resolver this part is handed (./secrets.ts): the key row is read by name at each
//                seal and the wrapping key's value is read from the env then, never kept; it never makes a key (a person
//                with none: noSealingKey), its transaction is read only, and every error it raises leaves scrubbed
//                (sealer.ts lines 13 to 27).
//   words        SafetyDeps.words (actions domain/safety/handlers.ts lines 89 to 93) from the one BundleSafety adapter
//                ./options.ts hands in (./bundle-safety.ts, T-1397), read at each call: a fixed line's id and words as
//                SafetyWords gives them (ports.ts lines 195 to 203), only from a bundle that adapter's own check passed (its
//                three reads answer only then: T-1242's note N3), and null for a line it holds no words for. Before any
//                check has passed in the isolate the adapter's read throws NoStateReadError, which is answered here as the
//                service's own notBuilt (NotBuiltError), so a record whose line asks the danger question answers notBuilt
//                with nothing written, and one that asks nothing never reads it. No adapter: left out, the service's own
//                default, notBuilt for such a record too.
//   flagsReader and messagesReader are left out: the safety service's own, on the call's transaction (../real.ts GateReads).
//
// The gate's one commitTurn (K-05 v1.1 item 1) is never this input's: it goes through the root's turn-row port, T-1395's
// binding on the job side (./k05-turn.ts turnRows; critic_collisions N5), with ../real.ts's turn id check in front.
//
// Connections (ADR-014 Consequences, "Connections inside one call"; critic_collisions N2; critic_size N6; DL-760, DL-761):
// a gate call holds its Tool API client's one connection while each of its runtime-side calls (the bundle reads, the
// owner's read, a seal, the commit) opens and ends a client of its own, one after another, so it holds 2 connections at
// most. At most 3 gate calls hold a Tool API client at once, so the gates hold 6 at most, the Worker's limit
// (infra/spikes/hyperdrive-host/worker.mjs line 77); a 4th waits for a slot before its client is opened, and nothing that
// holds a slot ever waits for one, so no gate waits for a connection another gate holds while that gate waits for one.
//
//   bound    staging, with both HYPERDRIVE_APP (the scope) and HYPERDRIVE_JOB (the owner's read, the sealer and the
//            commit) present. Only their presence is read as the root is built (DL-768): no connection string, secret,
//            KV or other binding. Each connection string is the handle's to read, and SEALING_WRAP_KEY the resolver's,
//            at each call.
//   unbound  any environment but staging, checked before anything else is read, or a binding missing: null, as the
//            Worker's root has always handed, so every gate fails closed inside the Tool API base before anything is read
//            or written (../real.ts NO_GATE_SCOPE: NoDatabaseError naming gateAndCommit), and nothing commits. In
//            production ./options.ts builds no part, and ../picks.ts keeps the gate closed besides.
//   failing  bound, and a call cannot be made (the handle's refusal, a connect that fails, DB_SCHEMA set, a database
//            error, SEALING_WRAP_KEY missing): it throws, and the gate fails closed with nothing written. The handle's own
//            errors name the call, the side, the binding and a reason, a check's label or a SQLSTATE (./db.ts); db/repo's
//            reads answer K-05's errors or throw scrubbed (the call's name and a SQLSTATE or the client's code), and the
//            commit binding throws on every error answer, never reading one as none (K-05 v1.4 default 61; turn-face
//            commit.ts lines 256 to 260); the sealer's errors leave scrubbed (its own noSealingKey, sealing.ts's
//            SealingError with its code, a database's as the call's name and a code).
//
// Nothing is logged here, and nothing is put in a span: the handle writes each call's timing, labels and numbers only
// (./part.ts dbCallLine; these seams carry no trace id, so each line's trace_id is null), and the guard's refusal its one
// line. No word of a text or a fixed line, no number, address, key, wrapping key's value, token or hash is in a log line
// or an error.
//
// pgCallScope and pgReadOnlySealer are imported by their own files, as ./tool-api-rows.ts imports pgCallScope (critic_size
// N5): no change to @rosie/actions.

import { NotBuiltError } from "@rosie/actions/src/tool-api/errors";
import type { BusinessScope } from "@rosie/actions/src/tool-api/scope";
import type { SafetyReads } from "@rosie/actions/src/tool-api/turn-face/commit";
import { pgCallScope } from "@rosie/actions/src/tool-api/turn-face/pg/calls";
import { pgReadOnlySealer } from "@rosie/actions/src/tool-api/turn-face/pg/sealer";
import type { SafetyWords, WordsSealer } from "@rosie/actions/src/domain/safety";
import {
  readBusinessOwner,
  readBusinessZoneIn,
  readOutboxRowWrittenIn,
  readSafetyHoldIn,
  readSafetyHoldOfOutcomeIn,
  readSafetyOutcomeIn,
  readSafetyOutcomeOfEventIn,
} from "@rosie/db/repo/safety-reads";
import type { Tx } from "@rosie/db/repo/scope";
import type { WrappingKeys } from "@rosie/db/repo/sealing";
import { readOpenHoldsIn } from "@rosie/db/repo/turn-face-reads";

import { environmentOf } from "../picks";
import { NoStateReadError, type BundleSafetyLines, type GateReads } from "../real";
import type { StagingDb, StagingPart } from "./part";

/** What T-1398's builder is handed (DL-757): the env, the root's handle, the resolver and the one BundleSafety adapter. */
export interface GatePart extends StagingPart {
  /** The SEALING_WRAP_KEY-only resolver (./secrets.ts), for the read-only sealer. */
  readonly keys: WrappingKeys;
  /** The one BundleSafety adapter (./bundle-safety.ts), the same instance as RootOptions.bundleSafety: null until made. */
  readonly bundleSafety: BundleSafetyLines | null;
}

/**
 * How many gate calls may hold a Tool API client at once (DL-761): each holds 2 connections at most, so 3 hold the 6 a
 * Worker may hold open at once. A gate call past them waits until one has ended.
 */
export const GATE_CLIENTS_AT_ONCE = 3;

/**
 * Each call's name on the handle: on its timing line, and on every error of the handle's that leaves it. The scope's is
 * K-09's name for the call its transaction is opened for, the owner's K-05's, and the sealer's its own (sealer.ts).
 */
export const GATE_CALLS = Object.freeze({
  scope: "gateAndCommit",
  businessOwner: "readBusinessOwner",
  seal: "seal",
} as const);

/** A binding is present when the env holds a value for it; its connection string is never read here. */
const present = (binding: unknown): boolean => binding !== undefined && binding !== null;

/**
 * The slots of the gate calls that may hold a Tool API client at once: `take` answers once one is free, with the
 * function that frees it again, in the order the calls asked. A slot is taken before the client is opened and freed once
 * the call's client has ended, whatever the call answered or threw.
 */
class ClientSlots {
  private free: number;
  private readonly waiting: (() => void)[] = [];

  constructor(slots: number) {
    this.free = slots;
  }

  take(): Promise<() => void> {
    let freed = false;
    const freeIt = (): void => {
      if (freed) return;
      freed = true;
      const next = this.waiting.shift();
      if (next === undefined) this.free += 1;
      else next();
    };
    if (this.free > 0) {
      this.free -= 1;
      return Promise.resolve(freeIt);
    }
    return new Promise((resolve) => {
      this.waiting.push(() => {
        resolve(freeIt);
      });
    });
  }
}

/**
 * The Tool API's own business scope for each gate call: pgCallScope over a Tool API client opened for that call
 * (HYPERDRIVE_APP, rosie_worker_app), which the handle guards first and ends once the call's transaction has ended, taken
 * only while one of the slots is free.
 */
function gateScope(db: StagingDb, slots: ClientSlots): BusinessScope<Tx> {
  return {
    async withBusiness(businessId, work) {
      const freeSlot = await slots.take();
      try {
        return await db.toolApi(GATE_CALLS.scope, (sql) => pgCallScope(sql).withBusiness(businessId, work));
      } finally {
        freeSlot();
      }
    },
  };
}

/**
 * K-05 v1.4's safety reads, line for line as pgSafetyReads binds them (calls.ts lines 47 to 53): the six In reads on the
 * call's transaction, the owner on a runtime-side client of its own (HYPERDRIVE_JOB, rosie_worker_job).
 */
function safetyReadsOn(db: StagingDb): SafetyReads<Tx> {
  return {
    outcomeOfEvent: (tx, request) => readSafetyOutcomeOfEventIn(tx, request),
    outcome: (tx, request) => readSafetyOutcomeIn(tx, request),
    hold: (tx, request) => readSafetyHoldIn(tx, request),
    holdOfOutcome: (tx, request) => readSafetyHoldOfOutcomeIn(tx, request),
    outboxRowWritten: (tx, request) => readOutboxRowWrittenIn(tx, request),
    businessZone: (tx, request) => readBusinessZoneIn(tx, request),
    businessOwner: (request) =>
      db.runtime(GATE_CALLS.businessOwner, (sql) => readBusinessOwner(sql, request)),
  };
}

/** pgReadOnlySealer over a runtime-side client opened for each seal (HYPERDRIVE_JOB, rosie_worker_job). */
function sealerOn(db: StagingDb, keys: WrappingKeys): WordsSealer {
  return {
    seal: (plaintext, forPersonId) =>
      db.runtime(GATE_CALLS.seal, (sql) => pgReadOnlySealer(sql, keys).seal(plaintext, forPersonId)),
  };
}

/**
 * SafetyDeps.words over the one BundleSafety adapter, read at each call: the line's id and words from the bundle the
 * adapter's own check passed and answers for, a copy, or null for a line it holds no words for. Before any check passed
 * the adapter's read throws NoStateReadError: no bundle's words are known, which the record takes as its port not built.
 */
function wordsOf(lines: BundleSafetyLines): SafetyWords {
  return {
    fixedLine(id) {
      let line: ReturnType<BundleSafetyLines["fixedLine"]>;
      try {
        line = lines.fixedLine(id);
      } catch (error) {
        if (error instanceof NoStateReadError) throw new NotBuiltError("recordSafetyOutcome");
        throw error;
      }
      return line === null ? null : { id: line.id, text: line.text };
    },
  };
}

/** The gate's reads over db/repo's transaction, as ../real.ts takes them: the call's repo is the transaction its scope opened. */
const asGateReads = (reads: GateReads<Tx>): GateReads => reads as GateReads;

/**
 * RootOptions.gateReads for staging: the gate's reads and seals, each call on one guarded client of the root's handle, the
 * scope's on HYPERDRIVE_APP and the owner's and the sealer's on HYPERDRIVE_JOB, and SafetyDeps.words from the one
 * BundleSafety adapter. Null anywhere but staging (nothing read but ENVIRONMENT) and while either binding is missing, so
 * every gate fails closed.
 */
export const stagingGateReads: (part: GatePart) => GateReads | null = ({ env, db, keys, bundleSafety }) => {
  if (environmentOf(env) !== "staging") return null;
  // Each binding's presence, once, as the root is built; its connection string is the handle's to read, at each call.
  const job = present(env.HYPERDRIVE_JOB);
  const app = present(env.HYPERDRIVE_APP);
  if (!job || !app) return null;
  return asGateReads({
    scope: gateScope(db, new ClientSlots(GATE_CLIENTS_AT_ONCE)),
    readOpenHolds: (tx, request) => readOpenHoldsIn(tx, { ...request, eventIds: [...request.eventIds] }),
    safetyReads: safetyReadsOn(db),
    sealer: sealerOn(db, keys),
    ...(bundleSafety === null ? {} : { words: wordsOf(bundleSafety) }),
  });
};
