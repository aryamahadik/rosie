// The safety calls as they run (T-318): recordSafetyOutcome and releaseSafetyHold (K-09 v1), each either
//   - a core action of a turn, in the turn's one commit (gateAndCommit's runCore, C-087: T-1140 dispatches to
//     recordSafetyOutcomeCore and releaseSafetyHoldCore, handing each what is open in force); or
//   - made alone: free text from a page or an outside AI (arch 02 line 129), or a release a page or the actor asks for,
//     committed through K-05's commit with no turn under the call's key (QUESTIONS.md CQ-44), which is a port: K-05 has no
//     such call yet, so by default a call made alone answers notBuilt and writes nothing (T-317's NO_ALONE_COMMIT).
// Both only read and hand back what the commit is to write, with no outside effect: a repeated turn runs them again before
// K-05 answers `repeated` (STATE note 1; ../../commit/types.ts CommitPorts).
//
// Defaults used (for ops/QUESTIONS.md):
//  16. A record made alone whose commit finds a booking head moved under its private flag answers transient (SQLSTATE
//      40001, nothing written), since K-09 v1 lists no versionChanged for recordSafetyOutcome: the call is tried again.

import type { ClockNew, CommitTurnContext, CoreAction, CoreRun, OpenHolds } from "../../commit";
import { NotBuiltError, type Handler } from "../../tool-api";
import {
  KEYED_IDS,
  NO_ALONE_COMMIT,
  NO_VISIT_TIMES,
  aloneWritesOf,
  databaseOf,
  flagsReaderOf,
  unitWritesOf,
  writesNothing,
  type AloneCommit,
  type AloneCommitAnswer,
  type FlagIds,
  type FlagsReader,
  type FlagWrites,
  type VisitsCovered,
} from "../flags";
import {
  NO_REACH_CARDS,
  createMessagesConsent,
  messagesReaderOf,
  type MessagesConsent,
  type MessagesReader,
  type ReachCards,
} from "../messages-consent";
import { KEYED_SAFETY_IDS, type SafetyIds } from "./ids";
import {
  FIXED_SAFETY_LINES,
  NOT_TOLD_YET,
  STOP_WORDS_NOT_WIRED,
  noSafetyReads,
  type SafetyLines,
  type SafetyReader,
  type SafetyTelling,
  type SafetyWords,
  type StopWords,
  type WordsSealer,
} from "./ports";
import {
  planRecordSafetyOutcome,
  type CarryingTurn,
  type RecordAnswer,
  type RecordLine,
  type RecordPorts,
  type RecordRequest,
} from "./record";
import { planReleaseSafetyHold, type ReleaseAnswer, type ReleaseRequest } from "./release";

/** What the safety calls run with; each port defaults to the Worker's, or to failing closed until its task lands. */
export interface SafetyDeps<Repo> {
  /** K-34's reads on the call's transaction. Default: none built (K-05 open gap 26), so every call answers notBuilt. */
  readonly reader?: (repo: Repo) => SafetyReader;
  /** T-317's K-04 reads (handles, people, booking heads, pauses). Default: the data-access calls on the call's repo. */
  readonly flagsReader?: (repo: Repo) => FlagsReader;
  /** T-307's reads, for the checked line's rows. Default: the data-access calls on the call's repo. */
  readonly messagesReader?: (repo: Repo) => MessagesReader;
  /** The reach cards on file. Default none: a line goes back the way the person writes (T-307 default 1). */
  readonly reachCards?: ReachCards;
  /** Seals the read's words on the call's transaction. Default none: a record with words answers notBuilt. */
  readonly sealer?: (repo: Repo) => WordsSealer;
  readonly ids?: SafetyIds;
  /** T-317's ids, for the pause and private rows. */
  readonly flagIds?: FlagIds;
  /** The booked visits a pause covers. Default none known (T-317's default 7). */
  readonly visits?: VisitsCovered;
  /** The checked lines of the pinned bundle. Default: K-01 v1's own fixed lines only. */
  readonly lines?: SafetyLines;
  /**
   * The plug-in's stop words (A3-26). Default: not wired, so a record answers notBuilt (STOP_WORDS_NOT_WIRED); a plug-in
   * known to list none is wired by name (PLUGIN_LISTS_NO_STOP_WORDS).
   */
  readonly stopWords?: StopWords;
  /** Hand-offs and pages (T-319). Default: none, so an outcome that must tell someone answers notBuilt. */
  readonly telling?: SafetyTelling;
  /**
   * K-01's fixed lines' words from the pinned bundle, for the danger question a record's line carries (record.ts default
   * 18; T-1176). Default: none, so a record whose line asks it answers notBuilt; a line that asks nothing never reads it.
   */
  readonly words?: SafetyWords;
  /** K-05's commit with no turn. Default NO_ALONE_COMMIT. */
  readonly commitAlone?: AloneCommit<Repo>;
  /** The call's now, UTC ending in Z, for a call made alone. Default: the clock, to the whole second. */
  readonly now?: () => string;
}

/** A recordSafetyOutcome core action's run: its K-09 v1 coreResult and what it writes. */
export interface RecordCoreRun extends CoreRun {
  readonly result: Extract<CoreRun["result"], { call: "recordSafetyOutcome" }>;
}

/** A releaseSafetyHold core action's run. */
export interface ReleaseCoreRun extends CoreRun {
  readonly result: Extract<CoreRun["result"], { call: "releaseSafetyHold" }>;
}

/** A core action's run, with the clock rows it arms that the turn's UnitWrites has no list for yet (T-317's pattern). */
export interface SafetyCoreRun<Run extends CoreRun = CoreRun> {
  readonly run: Run;
  /** Clock rows armed at the commit that no question owns: a pause's call-off (S11-62), a hand-off's escalation (T-319). */
  readonly clocks: readonly ClockNew[];
}

/** A recordSafetyOutcome core action's run, with the record's own line and the danger question it carries (T-1176). */
export interface RecordSafetyCoreRun extends SafetyCoreRun<RecordCoreRun> {
  /** The line of the row its commit writes (record.ts RecordLine), or of the first record's on a repeat; null for none. */
  readonly line: RecordLine | null;
}

const clockNow = (): string => new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");

/**
 * K-09 v1.1's record or release on arrival (arrivalCaller, caller.kind actorOnArrival: the handle actor, before batching;
 * README default 36), which v1.5's requests take beside v1's. Neither is built here (journey 3's lane), so each answers
 * notBuilt before anything is read or written, never run as v1's request (fail closed).
 */
function onArrival<Request extends { readonly caller: { readonly kind: string } }>(
  request: Request,
): request is Extract<Request, { readonly caller: { readonly kind: "actorOnArrival" } }> {
  return request.caller.kind === "actorOnArrival";
}

function recordPortsOf<Repo>(deps: SafetyDeps<Repo>, repo: Repo, businessId: string | null): RecordPorts {
  const messages: MessagesConsent | null =
    businessId === null
      ? null
      : createMessagesConsent({
          businessId,
          reader:
            deps.messagesReader === undefined
              ? messagesReaderOf(databaseOf(repo))
              : deps.messagesReader(repo),
          reachCards: deps.reachCards ?? NO_REACH_CARDS,
        });
  return {
    reader: deps.reader === undefined ? noSafetyReads("recordSafetyOutcome") : deps.reader(repo),
    ids: deps.ids ?? KEYED_SAFETY_IDS,
    flags: {
      reader: flagsReaderOn(deps, repo),
      ids: deps.flagIds ?? KEYED_IDS,
      visits: deps.visits ?? NO_VISIT_TIMES,
    },
    messages,
    sealer: deps.sealer === undefined ? null : deps.sealer(repo),
    lines: deps.lines ?? FIXED_SAFETY_LINES,
    stopWords: deps.stopWords ?? STOP_WORDS_NOT_WIRED,
    telling: deps.telling ?? NOT_TOLD_YET,
    words: deps.words ?? null,
  };
}

function flagsReaderOn<Repo>(deps: SafetyDeps<Repo>, repo: Repo): FlagsReader {
  return deps.flagsReader === undefined ? flagsReaderOf(databaseOf(repo)) : deps.flagsReader(repo);
}

/** The turn as a record or release reads it: its id, handle, texts and the core actions it carries. */
function carryingTurnOf<Repo>(turn: CommitTurnContext<Repo>): CarryingTurn {
  return {
    id: turn.turn.id,
    handleId: turn.turn.handleId,
    eventIds: [...turn.turn.eventIds],
    core: turn.request.core,
  };
}

/** A call's writes as the turn's unit, with its clock rows beside it (UnitWrites has no list for them yet). */
function unitAndClocks(writes: FlagWrites): { unit: CoreRun["writes"]; clocks: readonly ClockNew[] } {
  return { unit: unitWritesOf({ ...writes, clocks: [] }), clocks: writes.clocks };
}

// ---- recordSafetyOutcome --------------------------------------------------------------------------------------------

/**
 * recordSafetyOutcome as a core action of a turn (gateAndCommit's runCore): its result and what the turn's commit writes.
 * Its answer's hold binds the core actions and parts after it (the commit adds it to what is open in force). Every text
 * of the turn carries one, No included (K-09 README default 5). Its `line` is the record's own line, carrying the danger
 * question when a label's tense is unknown (record.ts default 18).
 */
export async function recordSafetyOutcomeCore<Repo>(
  action: Extract<CoreAction, { call: "recordSafetyOutcome" }>,
  turn: CommitTurnContext<Repo>,
  open: OpenHolds,
  deps: SafetyDeps<Repo> = {},
): Promise<RecordSafetyCoreRun> {
  const plan = await planRecordSafetyOutcome(
    {
      request: action.request,
      turn: carryingTurnOf(turn),
      businessId: turn.businessId,
      now: turn.request.now,
      open: open.holds,
    },
    recordPortsOf(deps, turn.repo, turn.businessId),
  );
  const refused = "error" in plan.answer;
  const { unit, clocks } = unitAndClocks(plan.writes);
  return {
    run: {
      result: {
        call: "recordSafetyOutcome",
        response: "error" in plan.answer ? null : plan.answer,
        error: "error" in plan.answer ? plan.answer : null,
      },
      writes: unit,
    },
    clocks: refused ? [] : clocks,
    line: refused ? null : plan.line,
  };
}

/** K-05's refusals of a commit with no turn: a version that moved, or a transient failure (nothing written). */
type AloneRefusal = Exclude<AloneCommitAnswer, { committed: true }>;

/** The writes of a call made alone, committed under its key; the answer it gives once they are in. */
async function commitAlone<Repo, Answer extends { repeated: boolean }>(
  deps: SafetyDeps<Repo>,
  repo: Repo,
  call: "recordSafetyOutcome" | "releaseSafetyHold",
  plan: { key: string; answer: Answer; writes: FlagWrites },
  businessId: string | null,
): Promise<Answer | AloneRefusal> {
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

/**
 * recordSafetyOutcome made alone: free text from a page or an outside AI (arch 02 line 129), under the call's business
 * scope. A text's outcome rides in its turn and is refused here (textNeedsTurn).
 */
export async function recordSafetyOutcomeAlone<Repo>(
  request: RecordRequest,
  repo: Repo,
  businessId: string | null,
  deps: SafetyDeps<Repo> = {},
): Promise<RecordAnswer> {
  const plan = await planRecordSafetyOutcome(
    { request, turn: null, businessId, now: (deps.now ?? clockNow)(), open: [] },
    recordPortsOf(deps, repo, businessId),
  );
  if ("error" in plan.answer) return plan.answer;
  const answer = await commitAlone(
    deps,
    repo,
    "recordSafetyOutcome",
    { ...plan, answer: plan.answer },
    businessId,
  );
  // K-09 v1 lists no versionChanged for a record: a booking head that moved under its private flag is tried again, as a
  // transient failure with nothing written (serialization_failure; default 16).
  if ("error" in answer && answer.error === "versionChanged")
    return { error: "transient", sqlstate: "40001" };
  return answer;
}

/**
 * recordSafetyOutcome as the Tool API base's handler (a page's or an outside AI's free text). A record on arrival answers
 * notBuilt (onArrival): recordSafetyOutcomeAlone takes K-09 v1's request only (record.ts RecordRequest).
 */
export function recordSafetyOutcomeHandler<Repo>(
  deps: SafetyDeps<Repo> = {},
): Handler<"recordSafetyOutcome", Repo> {
  return (request, context) =>
    onArrival(request)
      ? Promise.reject(new NotBuiltError("recordSafetyOutcome"))
      : recordSafetyOutcomeAlone(request, context.repo, context.businessId, deps);
}

// ---- releaseSafetyHold ----------------------------------------------------------------------------------------------

function releasePortsOf<Repo>(deps: SafetyDeps<Repo>, repo: Repo) {
  return {
    reader: deps.reader === undefined ? noSafetyReads("releaseSafetyHold") : deps.reader(repo),
    flagsReader: flagsReaderOn(deps, repo),
    ids: deps.ids ?? KEYED_SAFETY_IDS,
  };
}

/** releaseSafetyHold as a core action of a turn: a clear "we're safe" in the held chat, or the booking made private. */
export async function releaseSafetyHoldCore<Repo>(
  action: Extract<CoreAction, { call: "releaseSafetyHold" }>,
  turn: CommitTurnContext<Repo>,
  open: OpenHolds,
  deps: SafetyDeps<Repo> = {},
): Promise<SafetyCoreRun<ReleaseCoreRun>> {
  const plan = await planReleaseSafetyHold(
    {
      request: action.request,
      turn: carryingTurnOf(turn),
      businessId: turn.businessId,
      now: turn.request.now,
      open: open.holds,
    },
    releasePortsOf(deps, turn.repo),
  );
  const { unit } = unitAndClocks(plan.writes);
  return {
    run: {
      result: {
        call: "releaseSafetyHold",
        response: "error" in plan.answer ? null : plan.answer,
        error: "error" in plan.answer ? plan.answer : null,
      },
      writes: unit,
    },
    clocks: [],
  };
}

/**
 * releaseSafetyHold made alone (a page, the actor's at-once release after handing its line on), under the call's scope. A
 * release on arrival answers notBuilt (onArrival), so its handler and any other caller fail closed: release.ts's
 * ReleaseRequest is v1.5's, which takes it.
 */
export async function releaseSafetyHoldAlone<Repo>(
  request: ReleaseRequest,
  repo: Repo,
  businessId: string | null,
  deps: SafetyDeps<Repo> = {},
): Promise<ReleaseAnswer> {
  if (onArrival(request)) throw new NotBuiltError("releaseSafetyHold");
  const plan = await planReleaseSafetyHold(
    { request, turn: null, businessId, now: (deps.now ?? clockNow)(), open: [] },
    releasePortsOf(deps, repo),
  );
  if ("error" in plan.answer) return plan.answer;
  return commitAlone(deps, repo, "releaseSafetyHold", { ...plan, answer: plan.answer }, businessId);
}

/** releaseSafetyHold as the Tool API base's handler. */
export function releaseSafetyHoldHandler<Repo>(
  deps: SafetyDeps<Repo> = {},
): Handler<"releaseSafetyHold", Repo> {
  return (request, context) => releaseSafetyHoldAlone(request, context.repo, context.businessId, deps);
}
