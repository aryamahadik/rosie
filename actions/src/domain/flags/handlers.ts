// The flags calls as they run (T-317): recordStopOrStart and setRecordFlag (K-09 v1), each either
//   - a core action of a turn, in the turn's one commit (gateAndCommit's runCore, C-087: stopOrStartCore, recordFlagCore),
//     or
//   - made alone (the handle actor writing on return, a page's STOP for the caller's own number, the owner portal's
//     pause: flag-paused.json), committed through K-05's commit with no turn under the call's key (QUESTIONS.md CQ-44),
//     which is a port: K-05 has no such call yet (open gap 16), so by default a call made alone answers notBuilt and
//     writes nothing, and the handle actor keeps its record until it lands (T-269's queue).
// A STOP or START covers every business: K-09's caller names no business for it, the Tool API base refuses a call with
// none (noBusinessScope), and a consent row with no business is refused under a business scope (0013; T-307's security
// note N4). So it runs on the runtime side, with no business scope (runtimeStopCall), held to K-09 v1's schema as the base
// holds every call: the request before anything is read, the answer before it is given.

import type { RowRef, Writes } from "../../commit";
import type { CommitTurnContext, CoreAction, CoreRun } from "../../commit";
import type { Sql, Tx } from "../../../../db/repo/scope";
import {
  NotBuiltError,
  ToolApiContractError,
  type CallName,
  type ErrorsOf,
  type Handler,
  type InvalidRequestRefusal,
  type ToolApiValidator,
} from "../../tool-api";
import { messagesReaderOf, type MessagesReader } from "../messages-consent";
import { FlagRefusedError } from "./errors";
import { KEYED_IDS, type FlagIds } from "./ids";
import { flagsReaderOf, NO_VISIT_TIMES, type FlagsReader, type VisitsCovered } from "./reads";
import {
  planRecordFlag,
  type AddressSealer,
  type RecordFlagAnswer,
  type RecordFlagRequest,
} from "./record-flag";
import {
  NO_EVENT_SOURCES,
  planStopOrStart,
  type EventSources,
  type StopOrStartAnswer,
  type StopOrStartRequest,
} from "./stop-start";
import { aloneWritesOf, unitWritesOf, writesNothing, type FlagWrites } from "./writes";

// ---- K-05's commit with no turn (CQ-44) -------------------------------------------------------------------------------

/** One call made alone, as K-05's commit with no turn would take it: unique on its key, all or nothing, once. */
export interface AloneCommitRequest {
  /** The key a repeat is known by: the caller's request id, or for a write on return the text's event id (ids.ts). */
  readonly key: string;
  /** The business it is written under, or null: the runtime side (a STOP or START covers every business). */
  readonly businessId: string | null;
  /** Every row the call's decision rests on, at the version read (limit 4). */
  readonly versionsRead: readonly RowRef[];
  readonly writes: Writes;
}

type CommitRefusal = Extract<ErrorsOf<"recordStopOrStart">, { error: "versionChanged" | "transient" }>;

/** Committed (a repeated key writes nothing and answers repeated), or refused with nothing written. */
export type AloneCommitAnswer = { readonly committed: true; readonly repeated: boolean } | CommitRefusal;

export interface AloneCommit<Repo> {
  commit(request: AloneCommitRequest, repo: Repo, call: CallName): Promise<AloneCommitAnswer>;
}

/** No commit with no turn yet (CQ-44's default: such writes wait for that call): a call made alone answers notBuilt. */
export const NO_ALONE_COMMIT: AloneCommit<unknown> = {
  commit: (_request, _repo, call) => Promise.reject(new NotBuiltError(call)),
};

// ---- what the calls run with -------------------------------------------------------------------------------------------

export interface FlagsDeps<Repo> {
  /** The K-04 and K-29 reads on the call's transaction. Default: the data-access calls on the call's database repo. */
  readonly reader?: (repo: Repo) => FlagsReader;
  /** T-307's reads, for the reply rows. Default: messagesReaderOf on the call's database repo. */
  readonly messagesReader?: (repo: Repo) => MessagesReader;
  readonly ids?: FlagIds;
  /** The handle each replayed text's event came from (the handle actor's own record). Default: none known. */
  readonly events?: EventSources;
  /** The booked visits a pause covers. Default: none known (record-flag.ts default 7). */
  readonly visits?: VisitsCovered;
  /** Seals an address pause's address. Default: none (an address pause answers notBuilt). */
  readonly sealer?: AddressSealer | null;
  /** K-05's commit with no turn. Default NO_ALONE_COMMIT. */
  readonly commitAlone?: AloneCommit<Repo>;
  /** The call's now, UTC ending in Z, for a call made alone. Default: the clock, to the whole second. */
  readonly now?: () => string;
}

/** The call's repo as the data-access calls take it (a postgres.js transaction is a tagged-template function). */
export function databaseOf(repo: unknown): Sql | Tx {
  if (typeof repo !== "function")
    throw new TypeError("the flags calls read through the call's database transaction");
  return repo as Sql | Tx;
}

const clockNow = (): string => new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");

function readerOf<Repo>(deps: FlagsDeps<Repo>, repo: Repo): FlagsReader {
  return deps.reader === undefined ? flagsReaderOf(databaseOf(repo)) : deps.reader(repo);
}

function messagesOf<Repo>(deps: FlagsDeps<Repo>, repo: Repo): MessagesReader {
  return deps.messagesReader === undefined ? messagesReaderOf(databaseOf(repo)) : deps.messagesReader(repo);
}

/** The writes of a call made alone, committed under its key; the answer it gives once they are in. */
async function commitAlone<Repo, Answer extends { repeated: boolean }>(
  deps: FlagsDeps<Repo>,
  repo: Repo,
  call: CallName,
  plan: { key: string; answer: Answer; writes: FlagWrites },
  businessId: string | null,
): Promise<Answer | CommitRefusal> {
  if (plan.answer.repeated || writesNothing(plan.writes)) return plan.answer;
  const committer = (deps.commitAlone ?? NO_ALONE_COMMIT) as AloneCommit<Repo>;
  const answer = await committer.commit(
    {
      key: plan.key,
      businessId,
      versionsRead: [...plan.writes.versionsRead],
      writes: aloneWritesOf(plan.writes, null),
    },
    repo,
    call,
  );
  if ("error" in answer) return answer;
  return answer.repeated ? { ...plan.answer, repeated: true } : plan.answer;
}

// ---- recordStopOrStart ----------------------------------------------------------------------------------------------

/** recordStopOrStart made alone, on the repo it is given (the runtime side's for a STOP or START: runtimeStopCall). */
export async function recordStopOrStartAlone<Repo>(
  request: StopOrStartRequest,
  repo: Repo,
  deps: FlagsDeps<Repo> = {},
): Promise<StopOrStartAnswer> {
  if (request.caller.kind === "turn") throw new FlagRefusedError("turnRidesInCommit");
  const plan = await planStopOrStart(
    { request, turn: null, now: (deps.now ?? clockNow)() },
    {
      reader: readerOf(deps, repo),
      messages: messagesOf(deps, repo),
      ids: deps.ids ?? KEYED_IDS,
      events: deps.events ?? NO_EVENT_SOURCES,
    },
  );
  if ("error" in plan.answer) return plan.answer;
  return commitAlone(deps, repo, "recordStopOrStart", { ...plan, answer: plan.answer }, null);
}

/** recordStopOrStart as the Tool API base's handler (a call made alone under a business: a page's STOP, say). */
export function recordStopOrStartHandler<Repo>(
  deps: FlagsDeps<Repo> = {},
): Handler<"recordStopOrStart", Repo> {
  return (request, context) => recordStopOrStartAlone(request, context.repo, deps);
}

/** A core action's run, with the reply row it built: the one row the stopped flag lets through for it (stopped.ts). */
export interface FlagCoreRun extends CoreRun {
  readonly result: Extract<CoreRun["result"], { call: "recordStopOrStart" }>;
  /** The stop or start reply this action built as an outbox row, or null. */
  readonly replyRowId: string | null;
}

/** recordStopOrStart as a core action of a turn (gateAndCommit's runCore): its result and what the turn's commit writes. */
export async function stopOrStartCore<Repo>(
  action: Extract<CoreAction, { call: "recordStopOrStart" }>,
  turn: CommitTurnContext<Repo>,
  deps: FlagsDeps<Repo> = {},
): Promise<FlagCoreRun> {
  const plan = await planStopOrStart(
    {
      request: action.request,
      turn: { id: turn.turn.id, handleId: turn.turn.handleId, eventIds: [...turn.turn.eventIds] },
      now: turn.request.now,
    },
    {
      reader: readerOf(deps, turn.repo),
      messages: messagesOf(deps, turn.repo),
      ids: deps.ids ?? KEYED_IDS,
      events: deps.events ?? NO_EVENT_SOURCES,
    },
  );
  const refused = "error" in plan.answer;
  return {
    result: {
      call: "recordStopOrStart",
      response: "error" in plan.answer ? null : plan.answer,
      error: "error" in plan.answer ? plan.answer : null,
    },
    writes: unitWritesOf(plan.writes),
    replyRowId: refused ? null : plan.replyRowId,
  };
}

// ---- setRecordFlag ---------------------------------------------------------------------------------------------------

/** setRecordFlag made alone (the owner portal's pause: flag-paused.json), under the call's business scope. */
export async function setRecordFlagAlone<Repo>(
  request: RecordFlagRequest,
  repo: Repo,
  deps: FlagsDeps<Repo> = {},
): Promise<RecordFlagAnswer> {
  if (request.caller.kind === "turn") throw new FlagRefusedError("turnRidesInCommit");
  const plan = await planRecordFlag(
    { request, now: (deps.now ?? clockNow)() },
    {
      reader: readerOf(deps, repo),
      ids: deps.ids ?? KEYED_IDS,
      visits: deps.visits ?? NO_VISIT_TIMES,
      sealer: deps.sealer ?? null,
    },
  );
  if ("error" in plan.answer) return plan.answer;
  return commitAlone(
    deps,
    repo,
    "setRecordFlag",
    { ...plan, answer: plan.answer },
    request.caller.businessId,
  );
}

/** setRecordFlag as the Tool API base's handler. */
export function setRecordFlagHandler<Repo>(deps: FlagsDeps<Repo> = {}): Handler<"setRecordFlag", Repo> {
  return (request, context) => setRecordFlagAlone(request, context.repo, deps);
}

/** A flag set in a turn: its core run, and the call-off clocks it arms, which the turn's UnitWrites has no list for yet. */
export interface RecordFlagCoreRun {
  readonly run: CoreRun;
  /** The clock rows armed and due at the commit (S11-62): the runCore wiring writes them beside the unit. */
  readonly clocks: FlagWrites["clocks"];
}

/** setRecordFlag as a core action of a turn (gateAndCommit's runCore: a threat's pause, A3-48; A3-50's private). */
export async function recordFlagCore<Repo>(
  action: Extract<CoreAction, { call: "setRecordFlag" }>,
  turn: CommitTurnContext<Repo>,
  deps: FlagsDeps<Repo> = {},
): Promise<RecordFlagCoreRun> {
  const plan = await planRecordFlag(
    { request: action.request, now: turn.request.now },
    {
      reader: readerOf(deps, turn.repo),
      ids: deps.ids ?? KEYED_IDS,
      visits: deps.visits ?? NO_VISIT_TIMES,
      sealer: deps.sealer ?? null,
    },
  );
  return {
    run: {
      result: {
        call: "setRecordFlag",
        response: "error" in plan.answer ? null : plan.answer,
        error: "error" in plan.answer ? plan.answer : null,
      },
      writes: unitWritesOf({ ...plan.writes, clocks: [] }),
    },
    clocks: plan.writes.clocks,
  };
}

// ---- the runtime side ------------------------------------------------------------------------------------------------

/** The runtime side's transaction: plain, never business-scoped (db/repo/scope.ts), committed when `work` resolves. */
export interface RuntimeSide<Repo> {
  withRuntime<T>(work: (repo: Repo) => Promise<T>): Promise<T>;
}

/**
 * recordStopOrStart on the runtime side (a STOP or START covers every business: T-307's security note N4), for the handle
 * actor writing on return and a page's STOP for the caller's own number: the request is held to K-09 v1's schema before
 * anything is read (invalidRequest otherwise, naming paths, never values), and the answer to its response or errors
 * before it is given (ToolApiContractError otherwise).
 */
export function runtimeStopCall<Repo>(options: {
  readonly validator: ToolApiValidator;
  readonly runtime: RuntimeSide<Repo>;
  readonly deps?: FlagsDeps<Repo>;
}): (request: unknown) => Promise<StopOrStartAnswer | InvalidRequestRefusal> {
  const { validator, runtime } = options;
  const call = "recordStopOrStart";
  return async (request) => {
    const problems = validator.check(call, "request", request);
    if (problems.length > 0) return { error: "invalidRequest", call, problems };
    const answer = await runtime.withRuntime((repo) =>
      recordStopOrStartAlone(request as StopOrStartRequest, repo, options.deps ?? {}),
    );
    const asResponse = validator.check(call, "response", answer);
    if (asResponse.length > 0 && validator.check(call, "errors", answer).length > 0) {
      throw new ToolApiContractError(call, asResponse);
    }
    return answer;
  };
}
