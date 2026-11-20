// Staging's gate reads (the D-017 path audit's P4a: ops/reviews/D-017-path-audit/order_d017.txt line 35; T-1398; the
// lead's notes DL-397, DL-757, DL-760, DL-761, DL-768 and DL-776; T-1242's architect's note N3). T-1257 made this file with
// its final signature (DL-757); T-1398 binds it and edits nothing else (./options.ts hands it its part). T-1415 adds the
// keyword door's runtime-side pieces beside it (the CQ-335 ruling's NEW-3; DL-864, DL-877, DL-883).
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
//                GATE_CLIENTS_AT_ONCE gate calls hold such a client at once; another waits for one to end (DL-761). The
//                call the Tool API base names (its ScopeCall: gateAndCommit, and its transient answer) is handed on to
//                pgCallScope as it comes (T-1410).
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
//                default, notBuilt for such a record too. With the adapter they carry its check (T-1453; ../real.ts
//                GateWords.checkPin), which ../real.ts realGate awaits for the run's pinned bundle before its face runs, so
//                a rerun in a fresh isolate (its pin keeps the stored id and runs no check) has that bundle's words: kept
//                already, nothing is read; refused, the words answer as before; unreadable, the gate fails as for a read.
//   flagsReader and messagesReader are left out: the safety service's own, on the call's transaction (../real.ts GateReads).
//   keywordDoor  the keyword door's runtime-side pieces (T-1415; ../real.ts KeywordDoorReads; T-1413's door, the CQ-335
//                ruling's NEW-3, DL-864, DL-877), as @rosie/actions' pgKeywordDoor binds them, for a keyword turn whose
//                caller names no business (../real.ts routes it there): its one transaction for each call on a
//                runtime-side client opened for that call (part.db.runtime: HYPERDRIVE_JOB, rosie_worker_job, which
//                inherits rosie_job), through pgDoorRuntime, which clears the business scope, checks the door's side and
//                makes the transaction read only before the first read (db/repo/targets.ts enterKeywordDoorSide: no
//                business scope, no person, not the Tool API's role), taken only while one of the gate's slots is free;
//                readOpenHolds (readOpenHoldsIn, as pgKeywordDoor reads it) and K-05 v1.4's five record reads in their
//                no-business forms (pgNoBusinessSafetyReads) on that transaction, and runCore's flags port over it
//                (pgDoorFlags). Its sealer, its one commitTurn and its bundles are the gate's own (../real.ts). Nothing of
//                a business-scoped call changes: its flags calls stay unbound (notBuilt portNotWired; DL-877 C5).
//   questions    the walk's question read (T-1470, card F2; ../real.ts GateReads.questions; DL-961 card F, DL-994):
//                @rosie/actions' pgWalkQuestions on the call's transaction (rosie_app, the call's business), K-05 v1.2's
//                read of the handle's live questions, the one with that id as its row stands, with its version; under
//                rosie_app it reads through 0037's open_questions_went_out and names no table that spans businesses.
//   kinds        what the sign-up steps' writers read with (T-1470; ../real.ts GateReads.kinds; @rosie/actions'
//                KindsWriterDeps, T-633), its `reads` alone, through kindsReadsOf, each read on a client of its own that
//                the root's handle opens, guards and ends for that one read, while the call's own client is held:
//                  item 78  K-05 v1.19 readKindCatalog on a second Tool API client (part.db.toolApi: HYPERDRIVE_APP,
//                           rosie_worker_app), db/repo's standalone read in its own read-only transaction at repeatable
//                           read. It is opened straight from the handle, never through the scope or the slots: a read
//                           inside a call that holds a slot must never wait for one. Never pgKindsReads over the gate's
//                           own client, whose one connection the call's transaction holds (./db.ts CONNECTIONS_PER_CLIENT
//                           is 1; @rosie/actions' journey-1/kinds/reads.ts).
//                  item 79  K-05 v1.19 readPickedKinds on a runtime-side client (part.db.runtime: HYPERDRIVE_JOB,
//                           rosie_worker_job, which inherits rosie_job): the one role that reads persons and sees a pick
//                           with no business; db/repo refuses it as rosie_app before any table is read.
//                No `stop` is bound at rung 1 (K-05 open gap 29; CQ-360), so S1-03's and S1-74's messages answer notBuilt
//                (stopNotWired) and "One isn't on the list yet" and "Not a service we book" write nothing: their
//                messages ask no question and cannot be composed yet, and a row left with no plan would hold back every
//                later reply to that phone. "All on the list" needs no stop read. A failed read is thrown as
//                KindsReadError and fails the call closed; its `answer` holds a SQLSTATE or a person's or a business's
//                row id, and nothing here catches, wraps or logs it.
//
// The gate's one commitTurn (K-05 v1.1 item 1) is never this input's: it goes through the root's turn-row port, T-1395's
// binding on the job side (./k05-turn.ts turnRows; critic_collisions N5), with ../real.ts's turn id check in front.
//
// Connections (ADR-014 Consequences, "Connections inside one call"; critic_collisions N2; critic_size N6; DL-760, DL-761):
// a gate call holds its Tool API client's one connection while each of its other calls (the bundle reads, the owner's
// read, a seal, the commit on the runtime side; and, for an answer to S1-02's question, the catalog on a second Tool API
// client, item 79 and S1-11's one trade overlay on the runtime side: T-1470) opens and ends a client of its own, one
// after another, so it holds 2 connections at most; a keyword door's call holds its runtime-side transaction's one
// connection the same way while its bundle reads, seal and commit open theirs (T-1415), 2 at most too. At most 3 such
// calls, the gate's and the door's together, hold their call's client at once, so the gates hold 6 at most, the Worker's
// limit (infra/spikes/hyperdrive-host/worker.mjs line 77); a 4th waits for a slot before its client is opened, and
// nothing that holds a slot ever waits for one (the catalog's client takes no slot), so no call waits for a connection
// another call holds while that call waits for one.
//
//   bound    staging, with both HYPERDRIVE_APP (the scope, the question read on it, and the catalog's own client) and
//            HYPERDRIVE_JOB (the owner's read, the sealer, the keyword door, item 79 and the commit) present. Only their presence is read as the root is built (DL-768): no connection
//            string, secret, KV or other binding. Each connection string is the handle's to read, and SEALING_WRAP_KEY
//            the resolver's, at each call.
//   unbound  any environment but staging, checked before anything else is read, or a binding missing: null, as the
//            Worker's root has always handed, so every gate fails closed inside the Tool API base before anything is read
//            or written (../real.ts NO_GATE_SCOPE: NoDatabaseError naming gateAndCommit; a keyword turn naming no business
//            the base's noBusinessScope, with no door), and nothing commits. In production ./options.ts builds no part,
//            and ../picks.ts keeps the gate closed besides.
//   failing  bound, and a call cannot be made (the handle's refusal, a connect that fails, DB_SCHEMA set, a database
//            error, SEALING_WRAP_KEY missing): it throws, and the gate fails closed with nothing written. The handle's own
//            errors name the call, the side, the binding and a reason, a check's label or a SQLSTATE (./db.ts); db/repo's
//            reads answer K-05's errors or throw scrubbed (the call's name and a SQLSTATE or the client's code), and the
//            commit binding throws on every error answer, never reading one as none (K-05 v1.4 default 61; turn-face
//            commit.ts lines 256 to 260); the sealer's errors leave scrubbed (its own noSealingKey, sealing.ts's
//            SealingError with its code, a database's as the call's name and a code). The scope's start, once the guard
//            has passed, is db/repo's withBusiness's for gateAndCommit (T-1410): a connection lost or never opened answers
//            K-09's transient with nothing written, and any other failure of it is thrown scrubbed under gateAndCommit.
//
// Nothing is logged here, and nothing is put in a span: the handle writes each call's timing, labels and numbers only
// (./part.ts dbCallLine; these seams carry no trace id, so each line's trace_id is null), and the guard's refusal its one
// line. No word of a text or a fixed line, no number, address, key, wrapping key's value, token or hash is in a log line
// or an error.
//
// pgCallScope, the door's pieces, pgWalkQuestions, kindsReadsOf and pgReadOnlySealer are imported by their own files, as
// ./tool-api-rows.ts imports pgCallScope (critic_size N5): no change to @rosie/actions.

import { NotBuiltError } from "@rosie/actions/src/tool-api/errors";
import { kindsReadsOf, type KindsReads } from "@rosie/actions/src/tool-api/journey-1/kinds/reads";
import type { BusinessScope, ScopeCall } from "@rosie/actions/src/tool-api/scope";
import type { SafetyReads } from "@rosie/actions/src/tool-api/turn-face/commit";
import type { DoorRuntime } from "@rosie/actions/src/tool-api/turn-face/door";
import {
  pgCallScope,
  pgDoorFlags,
  pgDoorRuntime,
  pgNoBusinessSafetyReads,
  pgWalkQuestions,
} from "@rosie/actions/src/tool-api/turn-face/pg/calls";
import { pgReadOnlySealer } from "@rosie/actions/src/tool-api/turn-face/pg/sealer";
import type { WordsSealer } from "@rosie/actions/src/domain/safety";
import { readKindCatalog, readPickedKinds } from "@rosie/db/repo/kinds-reads";
import {
  readBusinessOwner,
  readBusinessZoneIn,
  readOutboxRowWrittenIn,
  readSafetyHoldIn,
  readSafetyHoldOfOutcomeIn,
  readSafetyOutcomeIn,
  readSafetyOutcomeOfEventIn,
} from "@rosie/db/repo/safety-reads";
import type { Sql, Tx } from "@rosie/db/repo/scope";
import type { WrappingKeys } from "@rosie/db/repo/sealing";
import { readOpenHoldsIn } from "@rosie/db/repo/turn-face-reads";

import { environmentOf } from "../picks";
import {
  NoStateReadError,
  type BundleSafetyLines,
  type GateReads,
  type GateWords,
  type KeywordDoorReads,
} from "../real";
import { BundleRefusedError } from "./bundle-safety";
import type { StagingDb, StagingPart } from "./part";

/** What T-1398's builder is handed (DL-757): the env, the root's handle, the resolver and the one BundleSafety adapter. */
export interface GatePart extends StagingPart {
  /** The SEALING_WRAP_KEY-only resolver (./secrets.ts), for the read-only sealer. */
  readonly keys: WrappingKeys;
  /** The one BundleSafety adapter (./bundle-safety.ts), the same instance as RootOptions.bundleSafety: null until made. */
  readonly bundleSafety: BundleSafetyLines | null;
}

/**
 * How many gate calls may hold their call's client at once (DL-761; T-1415): a business-scoped call's Tool API client or
 * a keyword door's runtime-side one, from the same slots. Each holds 2 connections at most, so 3 hold the 6 a Worker may
 * hold open at once. A call past them waits until one has ended.
 */
export const GATE_CLIENTS_AT_ONCE = 3;

/**
 * Each call's name on the handle: on its timing line, and on every error of the handle's that leaves it. The scope's and
 * the keyword door's are K-09's name for the call their transaction is opened for (the scope's on the Tool API's side,
 * the door's on the runtime side), the owner's K-05's, the sealer's its own (sealer.ts), and the two kinds reads' K-05's
 * (T-1470: item 78 on the Tool API's side, item 79 on the runtime side).
 */
export const GATE_CALLS = Object.freeze({
  scope: "gateAndCommit",
  door: "gateAndCommit",
  businessOwner: "readBusinessOwner",
  seal: "seal",
  kindCatalog: "readKindCatalog",
  pickedKinds: "readPickedKinds",
} as const);

/** A binding is present when the env holds a value for it; its connection string is never read here. */
const present = (binding: unknown): boolean => binding !== undefined && binding !== null;

/**
 * The slots of the gate calls that may hold their call's client at once, a Tool API client or a keyword door's
 * runtime-side one: `take` answers once one is free, with the function that frees it again, in the order the calls asked.
 * A slot is taken before the client is opened and freed once the call's client has ended, whatever the call answered or
 * threw.
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
 * only while one of the slots is free. The call the Tool API base names (its ScopeCall: K-09's gateAndCommit, and its
 * transient answer) goes on to pgCallScope as it is handed (T-1410), so a start the database could not make once the
 * guard has passed answers K-09's transient, and any other failure of the start is thrown scrubbed under that name.
 */
function gateScope(db: StagingDb, slots: ClientSlots): BusinessScope<Tx> {
  return {
    async withBusiness(businessId, work, call) {
      const freeSlot = await slots.take();
      try {
        return await db.toolApi(GATE_CALLS.scope, (sql) =>
          pgCallScope(sql).withBusiness(businessId, work, call),
        );
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
 * K-05 v1.19's two kinds reads for the sign-up steps' writers (T-1470; @rosie/actions' kindsReadsOf over KindsK05Reads),
 * each on a client of its own that the handle opens, guards and ends for that one read:
 *   - item 78, the catalog, on a second Tool API client (HYPERDRIVE_APP, rosie_worker_app), straight from the handle:
 *     never through gateScope or the slots, since the gate call that asks it already holds its own client and a slot;
 *   - item 79, the owner's kinds so far, on a runtime-side client (HYPERDRIVE_JOB, rosie_worker_job).
 * The writers await one read before the next, so the call holds its own client and one of these at a time. A K-05
 * error answer is thrown by kindsReadsOf as KindsReadError, and whatever the handle or db/repo throws leaves as thrown;
 * nothing here catches or logs either.
 */
function kindsReadsOn(db: StagingDb): KindsReads {
  return kindsReadsOf({
    readKindCatalog: (request) => db.toolApi(GATE_CALLS.kindCatalog, (sql) => readKindCatalog(sql, request)),
    readPickedKinds: (request) => db.runtime(GATE_CALLS.pickedKinds, (sql) => readPickedKinds(sql, request)),
  });
}

/**
 * The keyword door's one transaction for each call (T-1415): @rosie/actions' pgDoorRuntime over a runtime-side client
 * opened for that call (HYPERDRIVE_JOB, rosie_worker_job), which the handle guards first and ends once the transaction
 * has ended, taken only while one of the gate's slots is free. pgDoorRuntime checks the door's side and makes the
 * transaction read only before `work` gets it, and answers a start the database could not make as the call's transient
 * (the door's ScopeCall, handed on as it comes); the handle's own refusal or failed connect leaves as the handle throws it.
 */
function doorRuntimeOn(db: StagingDb, slots: ClientSlots): DoorRuntime<Sql> {
  return {
    async withRuntime<T>(work: (repo: Sql) => Promise<T>, call: ScopeCall<T>): Promise<T> {
      const freeSlot = await slots.take();
      try {
        return await db.runtime(GATE_CALLS.door, (sql) => pgDoorRuntime(sql).withRuntime(work, call));
      } finally {
        freeSlot();
      }
    },
  };
}

/**
 * The keyword door's runtime-side pieces (T-1415; ../real.ts KeywordDoorReads), as pgKeywordDoor binds them: the door's
 * transaction for each call in one of the gate's slots, and on it readOpenHolds, the five record reads in their
 * no-business forms and runCore's flags port.
 */
function keywordDoorOn(db: StagingDb, slots: ClientSlots): KeywordDoorReads<Sql> {
  return {
    runtime: doorRuntimeOn(db, slots),
    readOpenHolds: (tx, request) => readOpenHoldsIn(tx, { ...request, eventIds: [...request.eventIds] }),
    safetyReads: pgNoBusinessSafetyReads<Sql>(),
    flags: pgDoorFlags<Sql>(),
  };
}

/**
 * SafetyDeps.words over the one BundleSafety adapter, read at each call: the line's id and words from the bundle the
 * adapter's own check passed and answers for, a copy, or null for a line it holds no words for. Before any check passed
 * the adapter's read throws NoStateReadError: no bundle's words are known, which the record takes as its port not built.
 *
 * With them, the adapter's check (../real.ts GateWords.checkPin, T-1453), which the gate awaits for the run's pinned bundle
 * before its face runs: a bundle kept already passes at once, with nothing read, and any other is read and checked, then
 * kept. A bundle the check refuses (BundleRefusedError) is kept nowhere and resolves, so the words answer as before; a
 * check that cannot read the bundle rejects as the adapter rejects (BundleUnreadableError), and the gate fails with it.
 */
function wordsOf(lines: BundleSafetyLines): GateWords {
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
    async checkPin(request) {
      try {
        await lines.checkPin(request);
      } catch (error) {
        if (error instanceof BundleRefusedError) return;
        throw error;
      }
    },
  };
}

/**
 * The gate's reads over db/repo's transactions, as ../real.ts takes them: the call's repo is the transaction its scope
 * opened, and the keyword door's the connection its transaction holds.
 */
const asGateReads = (reads: GateReads<Tx, Sql>): GateReads => reads as GateReads;

/**
 * RootOptions.gateReads for staging: the gate's reads and seals, each call on one guarded client of the root's handle, the
 * scope's on HYPERDRIVE_APP and the owner's, the sealer's and the keyword door's on HYPERDRIVE_JOB, the scope and the door
 * sharing one set of slots, and SafetyDeps.words from the one BundleSafety adapter; and, for an answer to S1-02's
 * question (T-1470), the walk's question read on the call's transaction and the kinds reads, the catalog on a Tool API
 * client of its own (no slot) and item 79 on a runtime-side one, with no stop port. Null anywhere but staging (nothing
 * read but ENVIRONMENT) and while either binding is missing, so every gate fails closed, a keyword turn naming no
 * business with the base's noBusinessScope.
 */
export const stagingGateReads: (part: GatePart) => GateReads | null = ({ env, db, keys, bundleSafety }) => {
  if (environmentOf(env) !== "staging") return null;
  // Each binding's presence, once, as the root is built; its connection string is the handle's to read, at each call.
  const job = present(env.HYPERDRIVE_JOB);
  const app = present(env.HYPERDRIVE_APP);
  if (!job || !app) return null;
  // One set of slots for the root: a business-scoped gate's Tool API client and a keyword door's runtime-side one alike.
  const slots = new ClientSlots(GATE_CLIENTS_AT_ONCE);
  return asGateReads({
    scope: gateScope(db, slots),
    readOpenHolds: (tx, request) => readOpenHoldsIn(tx, { ...request, eventIds: [...request.eventIds] }),
    safetyReads: safetyReadsOn(db),
    sealer: sealerOn(db, keys),
    keywordDoor: keywordDoorOn(db, slots),
    questions: pgWalkQuestions<Tx>(),
    // No `stop` at rung 1: S1-03's and S1-74's messages answer notBuilt, so those two branches write nothing.
    kinds: { reads: kindsReadsOn(db) },
    ...(bundleSafety === null ? {} : { words: wordsOf(bundleSafety) }),
  });
};
