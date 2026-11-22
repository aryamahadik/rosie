// The turn face's calls after the frontier on PostgreSQL (T-1141; C-074): gate and commit, compose input and finalize,
// each run under the Tool API's own business scope, and each K-05 call that needs the runtime side in a transaction of its
// own (T-315's security note b; STATE notes 5 and 59).
//
// Who runs what (0012, 0016; K-05 v1.3 items 34 to 36 and v1.4 items 37 to 43):
//   - the call's transaction: one per call on `toolApi`, whose connections run as rosie_app, with rosie.business_id set to
//     the caller's business before the handler gets its repo and checked again at the end (db/repo/scope.ts
//     withBusiness), opened for the K-09 call the Tool API base names (T-1410: below). Every limit, the walk's reads,
//     readOpenHolds and six of the seven safety reads run on it, each naming the call's business;
//   - K-05's runtime-side calls on `runtime` (rosie_job), each its own transaction: commitTurn (T-306: unique on the turn
//     id, all or nothing), readBusinessOwner (person_handles and handles are the runtime's tables), the sealer's read
//     of the person's key (sealing_keys is the runtime's table: sealer.ts), and the walk's chat read (T-1519: K-05 v1.10
//     item 51 readChatHandle, threads and handles being the runtime's tables), each scoped as its call says.
// Nothing here logs; what a call throws names a read, a fault or a SQLSTATE, never a value.
//
// The keyword door's runtime-side binding (T-1413; DL-864; DL-877 C1, C2; ../door.ts): pgKeywordDoor runs the door's
// commit in one transaction on `runtime` (pgDoorRuntime), never on the Tool API's client:
//   - the transaction is db/repo's inRuntimeTransaction (as sign-in-send.ts's calls run): a reserved connection of the
//     runtime client, on the primary, read committed (so the commit's one reload reads what changed, as the base's call
//     transaction does), with rosie.business_id set empty for the transaction and rosie.person_id never set;
//   - before the first read, db/repo's enterKeywordDoorSide (db/repo/targets.ts; DL-883: the door sends no statement of
//     its own): assertRuntimeSide (no business scope), then one statement that reads no table, which refuses a session
//     acting for a person (rosie.person_id set) and a role that holds rosie_app's rights and not rosie_job's (rosie_app
//     sees no row with no business and holds no grant on phones: K-05 v1.4 default 1's rule, as the no-business safety
//     reads and readOpenHolds refuse it), then SET TRANSACTION READ ONLY: every write is commitTurn's own transaction,
//     so the door's never writes;
//   - runCore's flags port (pgDoorFlags) and the safety and hold reads run on that one transaction, the repo the door
//     hands the commit (C1, C2): T-317's flagsReaderOf and T-307's messagesReaderOf over it, never over a pooled
//     connection or rosie_app; the sealer and commitTurn keep their own runtime transactions, as in the business-scoped
//     binding (DL-877 lead note 7: the sealer's T-182 read stands);
//   - a start the database could not make answers K-09's transient through the door; any other failure leaving the
//     transaction is thrown scrubbed under gateAndCommit (db/repo/clocks.ts scrubbed: the call's name and a SQLSTATE or
//     the client's code, never a statement's values), the door's and db/repo's own errors as they are.
// Open, for a later card: the door's transaction waits for the bundles, the sealer and commitTurn between its own
// statements, and no close watch keeps a statement off its connection if that connection closes meanwhile (T-1367's guard
// is withBusiness's, which needs a business; the frontier's watches its own repo only).
//
// The one-kind path's reads on PostgreSQL (T-1493, H1a; K-09 README default 199 item (4); T-1492's CompaniesReads):
// pgCompaniesReads binds item 79 and K-24's catalog by id (readTurnState's setup facts) on `runtime` (rosie_job) and item
// 72 on `toolApi` (rosie_app), each in a read-only transaction of its own beside the call's (T-1492's
// pgCompaniesK05Reads), handed the call's transaction as CompaniesReads' repo and never reading through it: item 72 runs
// only in a read-only transaction at repeatable read (db/repo/catalog-reads.ts enterSide), which the call's own read-write
// transaction is not, and readTurnState reads the turn's handle, on which rosie_app holds no grant (0012), so neither can
// run on the call's transaction without a 42501 or a refusal. So the call's client needs a second connection beside the
// call's (as item 78's read does: DL-931), and the runtime's client one more. The caller hands it in as
// SignUpWriterDeps.companies, with S1-08's stop reads as SignUpWriterDeps.plan, and asks for signUpSteps (settleSignUp).
// The same reads serve S1-04's writer (T-1484, H1b; T-1481's companiesWriter, which also reads kinds' names by id through
// readTurnState on `runtime`) where the caller also hands in SignUpWriterDeps.s1_04Writer, so an answer to an S1-04 that
// was asked is written in the turn's one commit; its party rule's flag (s1_04Writer.partyRuleLive) is off unless the
// caller sets it true.

import {
  cancelClock,
  DataAccessDatabaseError,
  scrubbed,
  transientOrScrubbed,
} from "../../../../../db/repo/clocks";
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
import {
  enterKeywordDoorSide,
  inRuntimeTransaction,
  liveOpenQuestionsOfHandle,
  type TransientError,
} from "../../../../../db/repo/targets";
import { readChatHandle } from "../../../../../db/repo/threads";
import { readFixedLineFacts, readOpenHoldsIn, readOutboxRow } from "../../../../../db/repo/turn-face-reads";
import type { CoreFlagsDeps } from "../../../commit/core";
import { pgCommitTurn } from "../../../commit/pg";
import type { WalkQuestions } from "../../../commit/walk";
import { KEYED_IDS, NO_EVENT_SOURCES, flagsReaderOf } from "../../../domain/flags";
import { messagesReaderOf } from "../../../domain/messages-consent";
import type { PagingDeps } from "../../../domain/paging";
import type { StopWords, TellingPort } from "../../../domain/safety";
import type { FrontierBundles } from "../../../frontier";
import { companiesReadsOf, pgCompaniesK05Reads, type CompaniesReads } from "../../journey-1/companies";
import type { BusinessScope, ScopeCall } from "../../scope";
import type { SpanRefusedReport } from "../../tool-api";
import type { ToolApiValidator } from "../../validator";
import {
  keywordCommitDeps,
  signUpStepWriters,
  signUpSteps,
  turnCommitDeps,
  type NoBusinessSafetyReads,
  type SafetyReads,
  type SignUpWriterDeps,
  type TurnCommitBinding,
} from "../commit";
import { createKeywordDoor, type DoorRuntime, type KeywordDoor } from "../door";
import { HeldTurns } from "../held";
import { composeInputDeps, finalizeDeps, type RowBinding, type RowData } from "../rows";
import type { TurnFaceCalls } from "../turn-face";
import { pgReadOnlySealer } from "./sealer";

/** withBusiness's `call` and `transient` options (db/repo/scope.ts): the call its transaction is opened for. */
interface StartOptions<T> {
  readonly call?: string;
  readonly transient?: (answer: TransientError) => T;
}

/**
 * withBusiness's start options for the call the Tool API base names (scope.ts ScopeCall; T-1410): its K-09 name, and its
 * transient answer only where the base gave one. Nothing else is taken from it: the transaction is the call's own on the
 * primary, read-write, as it always was. With no call named, withBusiness keeps its own name.
 */
function startOf<T>(call: ScopeCall<T> | undefined): StartOptions<T> {
  if (call === undefined) return {};
  const { transient } = call;
  return transient === undefined ? { call: call.call } : { call: call.call, transient };
}

/**
 * The Tool API's own business scope on `toolApi` (rosie_app): one transaction per call (db/repo/scope.ts withBusiness),
 * opened for the call the Tool API base names (T-1410; T-1368's new task a). Its ScopeCall goes on to withBusiness as its
 * `call` and, where given, its `transient`: a start the database could not make (a connection that never opened or was
 * lost) answers K-09's transient where that call's errors have it, and any other failure of the start (a session refused
 * at its start, 3D000, 42501 and 55000 among them) is thrown scrubbed under the K-09 call's own name, never under
 * "withBusiness". Once `work` has begun, nothing changes: what it throws, and the end's scope check and commit, leave as
 * they always have.
 */
export function pgCallScope(toolApi: Sql): BusinessScope<Tx> {
  return {
    withBusiness: (businessId, work, call) => withBusiness(toolApi, businessId, work, startOf(call)),
  };
}

/**
 * K-05 v1.4's five record reads in their no-business forms (T-1413), on the keyword door's runtime-side transaction:
 * the same In reads, each with businessId null, which refuse a business scope and the Tool API's role before any read.
 */
export function pgNoBusinessSafetyReads<Repo extends Sql | Tx>(): NoBusinessSafetyReads<Repo> {
  return {
    outcomeOfEvent: (tx, request) => readSafetyOutcomeOfEventIn(tx, request),
    outcome: (tx, request) => readSafetyOutcomeIn(tx, request),
    hold: (tx, request) => readSafetyHoldIn(tx, request),
    holdOfOutcome: (tx, request) => readSafetyHoldOfOutcomeIn(tx, request),
    outboxRowWritten: (tx, request) => readOutboxRowWrittenIn(tx, request),
  };
}

/**
 * K-05 v1.4's safety reads (T-1161): the In reads on the call's transaction, the owner on the runtime side. `Repo` is
 * the call's transaction (Tx).
 */
export function pgSafetyReads<Repo extends Sql | Tx = Tx>(runtime: Sql): SafetyReads<Repo> {
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

/**
 * The walk's question read on PostgreSQL (T-1468; commit/walk WalkQuestions, default 11): K-05 v1.2's read of a handle's
 * live questions (db/repo/targets.ts liveOpenQuestionsOfHandle, as limit 3 reads them) on the call's own transaction
 * `tx`, and of those rows the one with that id, as it is, with the version its row is read at; else null. On the Tool
 * API's side (rosie_app, the call's business scope) it reads the scope's business's questions through 0037's
 * open_questions_went_out and names no table that spans businesses; on the runtime side (rosie_job) it reads them
 * directly. It reads through `tx` alone and never writes.
 */
export function pgWalkQuestions<Repo extends Sql | Tx>(): WalkQuestions<Repo> {
  return {
    async liveQuestion(tx, handleId, openQuestionId) {
      const live = await liveOpenQuestionsOfHandle(tx, handleId);
      return live.find((question) => question.id === openQuestionId) ?? null;
    },
  };
}

/**
 * The one-kind path's reads on PostgreSQL (T-1493; the top of this file), for SignUpWriterDeps.companies: T-1492's
 * pgCompaniesK05Reads through companiesReadsOf, so a K-05 error answer is thrown as CompaniesReadError and never read as
 * none. Item 79 and the catalog by id run on `runtime` (rosie_job), item 72 on `toolApi` (rosie_app), each in a read-only
 * transaction of its own; the call's transaction, handed in as the repo, is never read through. `toolApi` must never be
 * a client of one connection whose transaction the call holds.
 */
export function pgCompaniesReads(toolApi: Sql, runtime: Sql): CompaniesReads<Tx> {
  return companiesReadsOf<Tx>(pgCompaniesK05Reads(toolApi, runtime));
}

export interface PgTurnCallsOptions {
  /** The bundles, read under their ids (KV, or PostgreSQL's copy on a miss): the frontier's port. */
  readonly bundles: FrontierBundles;
  /**
   * The sign-up steps' ports (T-1468; ../commit signUpStepWriters), both handed in by the caller: the kinds reads (item
   * 78 on a rosie_app client that is never one whose only connection holds the call's transaction, item 79 on the runtime
   * side: journey-1/kinds reads.ts) with the stop home's reads where the runtime side binds them, and the pinned bundle's
   * trade overlays. Given, the commit binds the walk's question read on the call's transaction (pgWalkQuestions) and the
   * sign-up steps' writers, so an answer to S1-02's question is written. Left out, neither is bound, and every answer to
   * an open question is notBuilt, as before. Its `companies` (pgCompaniesReads), `s1_04Writer` and `plan` (S1-08's stop
   * reads) are read only with `settleSignUp` (T-1493, T-1484: signUpSteps alone binds them).
   */
  readonly signUp?: SignUpWriterDeps<Tx>;
  /**
   * Whether the walk is also handed S1-02's settler (T-1502; K-09 README default 191; ../commit signUpSteps): true, with
   * `signUp` given, binds the sign-up steps' writers and settlers together over one catalog read per walk, so the owner's
   * words settle S1-02's branch whichever option decide named, and, where `signUp` carries them (T-1493), the one-kind
   * path (S1-02's one-kind wrapper and S1-04's buttons settler, from `signUp.companies`), S1-04's writer (T-1484: from
   * `signUp.companies` with `signUp.s1_04Writer`) and S1-08's writer (from `signUp.plan`). Left out or false, no settler
   * is bound and the walk is as before; without `signUp` it binds nothing.
   */
  readonly settleSignUp?: boolean;
  /** The wrapping key the sealer opens a person's data key with, read by name from the environment (T-182). */
  readonly wrappingKeys: WrappingKeys;
  /** The plug-in's stop words, named (PLUGIN_LISTS_NO_STOP_WORDS for the barbershop: DL-344). */
  readonly stopWords: StopWords;
  /**
   * Who is told (DL-344; T-1443): the paging telling port (commit/core pagingTellingPort, built on each call's transaction),
   * or NOT_TOLD_YET, the default until the runtime binds the port (T-1444).
   */
  readonly telling: TellingPort<Tx>;
  /**
   * The paging service's ports (T-1443; commit/core pagingDepsOf): runCore's, for the paging core actions a turn carries,
   * and the Tool API base's paging handlers', for the six paging calls made alone. Left out, as until T-1444, each answers
   * notBuilt.
   */
  readonly paging?: PagingDeps<Tx>;
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
 * What the commit binding on PostgreSQL is built from: the options both the turn face's calls and the door take, who is
 * told named on the call's own repo (`Repo`: the call's transaction, or the door's).
 */
type PgCommitBindingOptions<Repo> = Pick<
  PgTurnCallsOptions,
  "bundles" | "wrappingKeys" | "stopWords" | "now" | "turnKey"
> & { readonly telling: TellingPort<Repo> };

/**
 * The commit's binding on PostgreSQL (T-1141), for a call whose repo is `Repo`: the Tool API's call transaction (Tx) for
 * the turn face's gate and commit, or the keyword door's runtime-side transaction (its reserved connection, Sql). K-05's
 * commitTurn and the read-only sealer each run in a runtime transaction of their own on `runtime`; readOpenHolds and the
 * safety reads on `Repo`, the owner's on the runtime side.
 */
function pgCommitBinding<Repo extends Sql | Tx>(
  runtime: Sql,
  options: PgCommitBindingOptions<Repo>,
): TurnCommitBinding<Repo> {
  return {
    bundles: options.bundles,
    commitTurn: pgCommitTurn<Repo>(runtime, options.now === undefined ? {} : { now: options.now }),
    readOpenHolds: (tx, request) => readOpenHoldsIn(tx, { ...request, eventIds: [...request.eventIds] }),
    safetyReads: pgSafetyReads<Repo>(runtime),
    sealer: pgReadOnlySealer(runtime, options.wrappingKeys),
    stopWords: options.stopWords,
    telling: options.telling,
    ...(options.turnKey === undefined ? {} : { turnKey: options.turnKey }),
  };
}

/**
 * Gate and commit, compose input and finalize on PostgreSQL: `runtime` is a client whose connections run as rosie_job,
 * `toolApi` one whose connections run as rosie_app, both on the primary, uncached (arch 10 lines 504, 538).
 */
export function pgTurnCalls(runtime: Sql, toolApi: Sql, options: PgTurnCallsOptions): TurnFaceCalls<Tx> {
  const { paging, signUp } = options;
  // The walk's question read, the sign-up steps' writers and, where asked, their settlers are this binding's own (T-1468,
  // T-1502), never pgCommitBinding's, which the keyword door shares; and so are, where signUpSteps gives it (T-1493: the
  // signUp deps carry `companies`), S1-04's buttons settler, and the walk's chat read (T-1519), K-05 v1.10 item 51 on
  // the runtime side in a read-only transaction of its own, so S1-01 reuses a handle's own chat thread.
  const binding: TurnCommitBinding<Tx> = {
    ...pgCommitBinding<Tx>(runtime, options),
    readChatHandle: (request) => readChatHandle(runtime, { linqChatId: request.linqChatId }),
    ...(options.safetyExtra === undefined ? {} : { safetyExtra: options.safetyExtra }),
    ...(paging === undefined ? {} : { paging }),
    ...(signUp === undefined
      ? {}
      : {
          questions: pgWalkQuestions<Tx>(),
          ...(options.settleSignUp === true
            ? signUpSteps<Tx>(signUp)
            : { writers: signUpStepWriters<Tx>(signUp) }),
        }),
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
    ...(paging === undefined ? {} : { paging }),
  };
}

// ---- the keyword door on the runtime side (T-1413) ------------------------------------------------------------------

/**
 * The keyword door's one transaction on `runtime` (the top of this file): inRuntimeTransaction's reserved connection, read
 * committed, rosie.business_id set empty and rosie.person_id unset, its side checked and the transaction made read only
 * by db/repo's enterKeywordDoorSide before `work` gets the connection. A start the database could not make answers
 * `call.transient` where given, else is thrown scrubbed; every other failure leaves scrubbed under `call.call`, the door's
 * and db/repo's own errors as they are.
 */
export function pgDoorRuntime(runtime: Sql): DoorRuntime<Sql> {
  return {
    async withRuntime<T>(work: (repo: Sql) => Promise<T>, call: ScopeCall<T>): Promise<T> {
      const state = { working: false };
      try {
        return await inRuntimeTransaction(runtime, { readOnly: false }, async (tx) => {
          await enterKeywordDoorSide(tx, call.call);
          state.working = true;
          return work(tx);
        });
      } catch (error) {
        if (!state.working) {
          // A refused side is the door's own error (BusinessScopeError, or assertRuntimeSide's): never transient.
          const answer = transientOrScrubbed(call.call, error);
          if (call.transient !== undefined) return call.transient(answer);
          throw new DataAccessDatabaseError(call.call, answer.sqlstate, null, null);
        }
        throw scrubbed(call.call, error);
      }
    },
  };
}

/**
 * runCore's flags port for the keyword door (CoreDeps.flags; DL-872 item 4; DL-877 C1, C2), each of its four ports by
 * name: T-317's reads (flagsReaderOf) and T-307's (messagesReaderOf) over the repo the commit hands runCore, which is the
 * door's own runtime-side transaction; the Worker's keyed ids; and no replayed text's handle, since the door takes a
 * turn's own call only, whose STOP or START binds to the turn's own handle and texts (domain/flags/stop-start.ts
 * fromThatPhone), so the event sources are never read. A pause's visits and its address sealer keep T-317's defaults.
 */
export function pgDoorFlags<Repo extends Sql | Tx>(): CoreFlagsDeps<Repo> {
  return {
    reader: (tx) => flagsReaderOf(tx),
    messagesReader: (tx) => messagesReaderOf(tx),
    ids: KEYED_IDS,
    events: NO_EVENT_SOURCES,
  };
}

export interface PgKeywordDoorOptions {
  /** The bundles, read under their ids (KV, or PostgreSQL's copy on a miss): the frontier's port. */
  readonly bundles: FrontierBundles;
  /** The wrapping key the sealer opens a person's data key with, read by name from the environment (T-182). */
  readonly wrappingKeys: WrappingKeys;
  /** The plug-in's stop words, named (no business has a plug-in: PLUGIN_LISTS_NO_STOP_WORDS answers none). */
  readonly stopWords: StopWords;
  /**
   * Who is told (T-1443): NOT_TOLD_YET, the default until the runtime binds the paging telling port (T-1444), or that
   * port, built on the door's transaction. The door's lines answer notBuilt for every danger outcome (commit.ts default
   * 5), so no record of the door's tells anyone either way.
   */
  readonly telling: TellingPort<Sql>;
  /** The commit's moment, read once per commit: a test's fake clock. Default: the database's now() (T-306). */
  readonly now?: () => Date;
  /** K-09's checks. Default: the validator over the frozen schemas read from contracts/. */
  readonly validator?: ToolApiValidator;
  /** Told when the trace refuses the call's span twice. Default: one JSON line on console.warn. */
  readonly onSpanRefused?: (report: SpanRefusedReport) => void;
}

/**
 * The keyword door on PostgreSQL (../door.ts; the top of this file): `runtime` is a client whose connections run as
 * rosie_job, on the primary, uncached (arch 10 lines 504, 538). Its commit runs in pgDoorRuntime's one transaction with
 * keywordCommitDeps over the commit binding (the record reads in their no-business forms) and pgDoorFlags; commitTurn and
 * the sealer each in their own on `runtime`.
 */
export function pgKeywordDoor(runtime: Sql, options: PgKeywordDoorOptions): KeywordDoor {
  const binding = { ...pgCommitBinding<Sql>(runtime, options), safetyReads: pgNoBusinessSafetyReads<Sql>() };
  return createKeywordDoor<Sql>({
    runtime: pgDoorRuntime(runtime),
    commit: keywordCommitDeps<Sql>(binding, pgDoorFlags<Sql>()),
    ...(options.validator === undefined ? {} : { validator: options.validator }),
    ...(options.onSpanRefused === undefined ? {} : { onSpanRefused: options.onSpanRefused }),
  });
}
