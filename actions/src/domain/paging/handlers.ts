// The paging and hand-offs calls as they run (T-319): handOff, answerHandOff, pageTeam, acknowledgePage, openReviewItem
// and decideReviewItem (K-09 v1), each either
//   - a core action of a turn, in the turn's one commit (gateAndCommit's runCore, C-087: K-09 v1 coreAction holds every
//     one of them but decideReviewItem, the console's alone), handed back as a CoreRun whose UnitWrites carries its clock
//     rows and cancels (T-1156), for the commit core's dispatch to bind (commit/core/core.ts, outside this card); or
//   - made alone: a page's, the console's, a job's or a clock firing's call (the minute sweep firing a hand-off's
//     escalation or a page's next page: hand-off.ts escalationRequest, page.ts repeatPageRequest), committed through
//     K-05's commit with no turn under the call's key (QUESTIONS.md CQ-44), which is T-317's AloneCommit port: K-05 has no
//     such call yet, so by default a call made alone answers notBuilt and writes nothing (NO_ALONE_COMMIT).
// Each only reads, through its ports, and hands back what the commit is to write: a repeated turn runs a core action again
// before K-05 answers `repeated` (../../commit/types.ts CommitPorts).
//
// Defaults used (for ops/QUESTIONS.md):
//  26. A call made alone is committed under `<call>:<caller's request id>` (a page's next page under its clock row's id),
//      so a decision's wait and its later decision are two commits; the rows' ids stay keyed as each plan keys them.
//  27. K-09 v1 lists no versionChanged for pageTeam, handOff or openReviewItem: a commit with no turn that finds a row
//      moved answers transient (SQLSTATE 40001, nothing written), and the call is tried again, as T-318's default 16.
//  28. Who is paged is resolved for the Worker's ENVIRONMENT (recipients.ts): with none given, as staging (fail closed,
//      recipients.ts default 1), so the wiring passes "production" in production alone.

import type { CommitTurnContext, CoreAction, CoreRun } from "../../commit";
import type { CallName, Caller, Handler } from "../../tool-api";
import { NO_ALONE_COMMIT, type AloneCommit, type AloneCommitAnswer } from "../flags";
import { PagingRefusedError } from "./errors";
import {
  planAnswerHandOff,
  planHandOff,
  type AnswerHandOffAnswer,
  type AnswerHandOffRequest,
  type HandOffAnswer,
  type HandOffRequest,
} from "./hand-off";
import { KEYED_PAGING_IDS, type PagingIds } from "./ids";
import {
  planAcknowledgePage,
  planPageTeam,
  type AcknowledgePageAnswer,
  type AcknowledgePageRequest,
  type PageTeamAnswer,
  type PageTeamRequest,
  type PagingPlan,
  type PagingPorts,
} from "./page";
import { NO_TEST_PHONES, noPagingReads, type PagingReader, type TestRoster } from "./ports";
import {
  planDecideReviewItem,
  planOpenReviewItem,
  type DecideReviewItemAnswer,
  type DecideReviewItemRequest,
  type OpenReviewItemAnswer,
  type OpenReviewItemRequest,
} from "./review";
import { createPagingTelling, type PagingTelling } from "./telling";
import { noPagingWrites, pagingAloneWritesOf, pagingUnitWritesOf, pagingWritesNothing } from "./writes";

/** What the paging calls run with; each port defaults to failing closed until its task binds it. */
export interface PagingDeps<Repo> {
  /** K-36's, K-37's and K-04's reads (ports.ts). Default: none bound, so every call answers notBuilt. */
  readonly reader?: (repo: Repo) => PagingReader;
  readonly ids?: PagingIds;
  /** The Worker's ENVIRONMENT: "production" pages real people; anything else, roster test phones alone (default 28). */
  readonly environment?: string;
  /** Staging's roster test phones, by handle id. Default: none, so outside production everything waits in the console. */
  readonly roster?: TestRoster;
  /** K-05's commit with no turn. Default NO_ALONE_COMMIT. */
  readonly commitAlone?: AloneCommit<Repo>;
  /** The call's now, UTC ending in Z, for a call made alone. Default: the clock, to the whole second. */
  readonly now?: () => string;
}

const clockNow = (): string => new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");

/** The ports one call reads with. */
export function pagingPortsOf<Repo>(deps: PagingDeps<Repo>, repo: Repo, call: CallName): PagingPorts {
  return {
    reader: deps.reader === undefined ? noPagingReads(call) : deps.reader(repo),
    ids: deps.ids ?? KEYED_PAGING_IDS,
    recipients: { environment: deps.environment ?? "", roster: deps.roster ?? NO_TEST_PHONES },
  };
}

/** The telling port the safety service takes (its SafetyDeps.telling), over the paging reads on the call's repo. */
export function pagingTellingOf<Repo>(deps: PagingDeps<Repo>, repo: Repo): PagingTelling {
  return createPagingTelling(pagingPortsOf(deps, repo, "handOff"));
}

// ---- made alone -------------------------------------------------------------------------------------------------------

/** K-05's refusals of a commit with no turn: a version that moved, or a transient failure (nothing written). */
type AloneRefusal = Exclude<AloneCommitAnswer, { committed: true }>;

/** A refusal answer (K-09's errors each carry their own "error" code; no response has one). */
function isRefusal(answer: object): answer is { readonly error: string } {
  return "error" in answer;
}

/** A call made alone: refused when its caller is a turn, whose commit carries it (arch 02 line 121). */
function checkAlone(caller: Caller): void {
  if (caller.kind === "turn") throw new PagingRefusedError("turnRidesInCommit");
}

/** The writes of a call made alone, committed under its key (default 26); the answer it gives once they are in. */
async function commitPlan<Repo, Answer extends object>(
  deps: PagingDeps<Repo>,
  repo: Repo,
  call: CallName,
  caller: Caller,
  plan: PagingPlan<Answer>,
  businessId: string | null,
): Promise<Answer | AloneRefusal> {
  const { answer } = plan;
  if (isRefusal(answer) || pagingWritesNothing(plan.writes)) return answer;
  if ("repeated" in answer && answer.repeated === true) return answer;
  const committer = (deps.commitAlone ?? NO_ALONE_COMMIT) as AloneCommit<Repo>;
  const committed = await committer.commit(
    {
      key: `${call}:${caller.requestId}`,
      businessId,
      versionsRead: [...plan.writes.versionsRead],
      writes: pagingAloneWritesOf(plan.writes, null),
    },
    repo,
    call,
  );
  if ("error" in committed) return committed;
  return committed.repeated ? { ...answer, repeated: true } : answer;
}

/**
 * A moved row for a call whose errors list no versionChanged (pageTeam, handOff, openReviewItem, each of which lists
 * transient): transient, nothing written (default 27). Every other answer is the call's own, or K-05's transient, which
 * each of the three lists.
 */
function noVersionChanged<Answer extends object>(answer: Answer | AloneRefusal): Answer {
  const moved = isRefusal(answer) && answer.error === "versionChanged";
  return (moved ? { error: "transient", sqlstate: "40001" } : answer) as Answer;
}

const nowOf = <Repo>(deps: PagingDeps<Repo>): string => (deps.now ?? clockNow)();

/** pageTeam made alone: a page's, a job's or a clock firing's call (a hand-off's escalation, a page's next page). */
export async function pageTeamAlone<Repo>(
  request: PageTeamRequest,
  repo: Repo,
  businessId: string | null,
  deps: PagingDeps<Repo> = {},
): Promise<PageTeamAnswer> {
  checkAlone(request.caller);
  const plan = await planPageTeam({ request, now: nowOf(deps) }, pagingPortsOf(deps, repo, "pageTeam"));
  return noVersionChanged<PageTeamAnswer>(
    await commitPlan(deps, repo, "pageTeam", request.caller, plan, businessId),
  );
}

/** acknowledgePage made alone: a tap in the team console. */
export async function acknowledgePageAlone<Repo>(
  request: AcknowledgePageRequest,
  repo: Repo,
  businessId: string | null,
  deps: PagingDeps<Repo> = {},
): Promise<AcknowledgePageAnswer> {
  checkAlone(request.caller);
  const plan = await planAcknowledgePage(
    { request, now: nowOf(deps) },
    pagingPortsOf(deps, repo, "acknowledgePage"),
  );
  return commitPlan(deps, repo, "acknowledgePage", request.caller, plan, businessId);
}

/** handOff made alone, under the call's business. */
export async function handOffAlone<Repo>(
  request: HandOffRequest,
  repo: Repo,
  businessId: string,
  deps: PagingDeps<Repo> = {},
): Promise<HandOffAnswer> {
  checkAlone(request.caller);
  const plan = await planHandOff(
    { request, businessId, now: nowOf(deps) },
    pagingPortsOf(deps, repo, "handOff"),
  );
  return noVersionChanged<HandOffAnswer>(
    await commitPlan(deps, repo, "handOff", request.caller, plan, businessId),
  );
}

/** answerHandOff made alone: a tap on the owner console. */
export async function answerHandOffAlone<Repo>(
  request: AnswerHandOffRequest,
  repo: Repo,
  businessId: string | null,
  deps: PagingDeps<Repo> = {},
): Promise<AnswerHandOffAnswer> {
  checkAlone(request.caller);
  const plan = await planAnswerHandOff(
    { request, now: nowOf(deps) },
    pagingPortsOf(deps, repo, "answerHandOff"),
  );
  return commitPlan(deps, repo, "answerHandOff", request.caller, plan, businessId);
}

/** openReviewItem made alone: a page's, the console's or a job's call. */
export async function openReviewItemAlone<Repo>(
  request: OpenReviewItemRequest,
  repo: Repo,
  businessId: string | null,
  deps: PagingDeps<Repo> = {},
): Promise<OpenReviewItemAnswer> {
  checkAlone(request.caller);
  const plan = await planOpenReviewItem(
    { request, now: nowOf(deps) },
    pagingPortsOf(deps, repo, "openReviewItem"),
  );
  return noVersionChanged<OpenReviewItemAnswer>(
    await commitPlan(deps, repo, "openReviewItem", request.caller, plan, businessId),
  );
}

/** decideReviewItem, the team console's alone (K-09 v1: "alone (console)"). */
export async function decideReviewItemAlone<Repo>(
  request: DecideReviewItemRequest,
  repo: Repo,
  businessId: string | null,
  deps: PagingDeps<Repo> = {},
): Promise<DecideReviewItemAnswer> {
  checkAlone(request.caller);
  const plan = await planDecideReviewItem(
    { request, now: nowOf(deps) },
    pagingPortsOf(deps, repo, "decideReviewItem"),
  );
  return commitPlan(deps, repo, "decideReviewItem", request.caller, plan, businessId);
}

/** The six calls as the Tool API base's handlers, each made alone under the call's business scope. */
export function pagingHandlers<Repo>(deps: PagingDeps<Repo> = {}): {
  readonly pageTeam: Handler<"pageTeam", Repo>;
  readonly acknowledgePage: Handler<"acknowledgePage", Repo>;
  readonly handOff: Handler<"handOff", Repo>;
  readonly answerHandOff: Handler<"answerHandOff", Repo>;
  readonly openReviewItem: Handler<"openReviewItem", Repo>;
  readonly decideReviewItem: Handler<"decideReviewItem", Repo>;
} {
  return {
    pageTeam: (request, context) => pageTeamAlone(request, context.repo, context.businessId, deps),
    acknowledgePage: (request, context) =>
      acknowledgePageAlone(request, context.repo, context.businessId, deps),
    handOff: (request, context) => handOffAlone(request, context.repo, context.businessId, deps),
    answerHandOff: (request, context) => answerHandOffAlone(request, context.repo, context.businessId, deps),
    openReviewItem: (request, context) =>
      openReviewItemAlone(request, context.repo, context.businessId, deps),
    decideReviewItem: (request, context) =>
      decideReviewItemAlone(request, context.repo, context.businessId, deps),
  };
}

// ---- in a turn ----------------------------------------------------------------------------------------------------------

/** A core action's caller is the turn's own, under the turn's business (as commit/core/core.ts's default 3 checks). */
function checkTurn<Repo>(caller: Caller, turn: CommitTurnContext<Repo>): void {
  if (caller.kind !== "turn" || caller.turnId !== turn.turn.id || caller.traceId !== turn.turn.traceId) {
    throw new PagingRefusedError("notTheTurn");
  }
  if (caller.businessId !== null && caller.businessId !== turn.businessId) {
    throw new PagingRefusedError("otherBusiness");
  }
}

/** The answer and writes of one core action: a refusal writes nothing (K-09 v1 coreResult: it stops only itself). */
function unitOf<Answer extends object>(
  plan: PagingPlan<Answer>,
): { readonly refused: boolean; readonly writes: CoreRun["writes"] } {
  const refused = isRefusal(plan.answer);
  return {
    refused,
    writes: pagingUnitWritesOf(refused ? noPagingWrites(plan.writes.why.step) : plan.writes),
  };
}

/** pageTeam as a core action of a turn (a passed-on reply's page in the turn's commit, say). */
export async function pageTeamCore<Repo>(
  action: Extract<CoreAction, { call: "pageTeam" }>,
  turn: CommitTurnContext<Repo>,
  deps: PagingDeps<Repo> = {},
): Promise<CoreRun> {
  checkTurn(action.request.caller, turn);
  const plan = await planPageTeam(
    { request: action.request, now: turn.request.now },
    pagingPortsOf(deps, turn.repo, "pageTeam"),
  );
  const { writes } = unitOf(plan);
  const { answer } = plan;
  return {
    result:
      "error" in answer
        ? { call: "pageTeam", response: null, error: answer }
        : { call: "pageTeam", response: answer, error: null },
    writes,
  };
}

/** acknowledgePage as a core action of a paged person's turn (their reply: K-09 open gap 7, CQ-32). */
export async function acknowledgePageCore<Repo>(
  action: Extract<CoreAction, { call: "acknowledgePage" }>,
  turn: CommitTurnContext<Repo>,
  deps: PagingDeps<Repo> = {},
): Promise<CoreRun> {
  checkTurn(action.request.caller, turn);
  const plan = await planAcknowledgePage(
    { request: action.request, now: turn.request.now },
    pagingPortsOf(deps, turn.repo, "acknowledgePage"),
  );
  const { writes } = unitOf(plan);
  const { answer } = plan;
  return {
    result:
      "error" in answer
        ? { call: "acknowledgePage", response: null, error: answer }
        : { call: "acknowledgePage", response: answer, error: null },
    writes,
  };
}

/** handOff as a core action of a turn (the planner's hand_off, S11-19's other hand-off). */
export async function handOffCore<Repo>(
  action: Extract<CoreAction, { call: "handOff" }>,
  turn: CommitTurnContext<Repo>,
  deps: PagingDeps<Repo> = {},
): Promise<CoreRun> {
  checkTurn(action.request.caller, turn);
  const plan = await planHandOff(
    { request: action.request, businessId: turn.businessId, now: turn.request.now },
    pagingPortsOf(deps, turn.repo, "handOff"),
  );
  const { writes } = unitOf(plan);
  const { answer } = plan;
  return {
    result:
      "error" in answer
        ? { call: "handOff", response: null, error: answer }
        : { call: "handOff", response: answer, error: null },
    writes,
  };
}

/** answerHandOff as a core action of the told person's turn (their reply). */
export async function answerHandOffCore<Repo>(
  action: Extract<CoreAction, { call: "answerHandOff" }>,
  turn: CommitTurnContext<Repo>,
  deps: PagingDeps<Repo> = {},
): Promise<CoreRun> {
  checkTurn(action.request.caller, turn);
  const plan = await planAnswerHandOff(
    { request: action.request, now: turn.request.now },
    pagingPortsOf(deps, turn.repo, "answerHandOff"),
  );
  const { writes } = unitOf(plan);
  const { answer } = plan;
  return {
    result:
      "error" in answer
        ? { call: "answerHandOff", response: null, error: answer }
        : { call: "answerHandOff", response: answer, error: null },
    writes,
  };
}

/** openReviewItem as a core action of a turn (S1-75's control check by text, say). */
export async function openReviewItemCore<Repo>(
  action: Extract<CoreAction, { call: "openReviewItem" }>,
  turn: CommitTurnContext<Repo>,
  deps: PagingDeps<Repo> = {},
): Promise<CoreRun> {
  checkTurn(action.request.caller, turn);
  const plan = await planOpenReviewItem(
    { request: action.request, now: turn.request.now },
    pagingPortsOf(deps, turn.repo, "openReviewItem"),
  );
  const { writes } = unitOf(plan);
  const { answer } = plan;
  return {
    result:
      "error" in answer
        ? { call: "openReviewItem", response: null, error: answer }
        : { call: "openReviewItem", response: answer, error: null },
    writes,
  };
}
