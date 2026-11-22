// The Tool API's turn face (T-315, T-1141; C-074; K-09 v1.5 README "The turn face (called by the handle actor and the AI
// layer)"): the calls the handle actor makes in a turn, each through the Tool API base (T-290), so each is checked against
// K-09 v1.5, refused before any read when it names no business, run inside one transaction scoped to its caller's
// business, held to its response or errors, and given its one K-08 span on the trace it is handed. In turn order:
//
//   1. buildFrontier (T-315): the frontier (T-291, T-295) over the turn's stored state read through K-05 v1.2
//      readTurnState under the call's business scope (pg/frontier.ts on PostgreSQL, as rosie_job), with the frontier's
//      sources as main's registry has them (frontier/assemble/registry.ts), never a stand-in. The bundles are injected
//      as the frontier takes them (FrontierBundles: KV, or PostgreSQL's copy on a miss).
//   2. gateAndCommit (T-1141): T-305's gate and one commit per turn, with the runtime's commit-time context (the lease's
//      CommitContext: the holds open and the texts not read yet at commit time) handed on unchanged, which the commit's
//      openHolds port joins with K-05's read (commit.ts).
//   3. composeInput (T-1141): T-309's compose input over the committed row (rows.ts).
//   4. finalizeMessage (T-1141): T-313's finalize with T-314's fixed lines over the same row (rows.ts).
// S1-10's secure link rides between calls 2 and 4 in the face's memory alone (T-1533; held.ts HeldLinks; K-09 README
// default 211; DL-1167 (3)): gateAndCommit drops the turn's staged links before and after its gate runs and holds those
// of the rows a committed answer with repeated false lists; finalizeMessage lets a row's link go once it answers send,
// sendAndLog or passedOn.
// Calls 2 to 4 run under the Tool API's own business scope (`calls.scope`: rosie_app on PostgreSQL, never the frontier's
// rosie_job scope: T-315's security note b), and each K-05 call that needs the runtime side runs in a transaction of its
// own (STATE note 59). Without `calls`, each of them answers notBuilt and nothing is read (fail closed).
//
// The same base carries the paging service's six calls made alone (T-1443; domain/paging pagingHandlers: pageTeam,
// acknowledgePage, handOff, answerHandOff, openReviewItem and decideReviewItem, each under the call's business scope),
// with the paging ports the wiring binds (`calls.paging`: the runtime's PagingReader, T-1444). Left out, each answers
// notBuilt, as every call with no handler does. A call made alone commits through K-05's commit with no turn (the paging
// ports' commitAlone), which K-05 has no call for yet (CQ-44, CQ-28): with none bound, each answers notBuilt after its
// reads and writes nothing. A turn's own call is refused there (the paging service's turnRidesInCommit), since it rides
// in its turn's commit (runCore's paging core actions, commit/core/core.ts). A binding reaches the six through this base
// as callHandlers builds it.
//
// Spans: K-08's hop check fails a hop recorded twice, and the actor's turn records its own spans around its ports
// (runtime/src/turn). The frontier's span is the base's, on the trace it is handed, since it names where each bundle part
// came from; the turn records none for it (CQ-159, T-557: TurnFace.recordsFrontierSpan). For the three calls after it,
// the turn records the hops itself: the gate (one span per part, with its limits) and the commit around gateAndCommit,
// and one fillAndChecks span per row (around the row's finalize), the hop composeInput and finalizeMessage take. So the
// face tells the base so on each of those calls (CallOptions.callerRecordsHop: TURN_RECORDS_GATE,
// TURN_RECORDS_FILL_AND_CHECKS), and the base records no span for them; their checks, answers and errors are as without
// it (T-1193; DL-376).

import {
  frontierHandlers,
  type FrontierBundles,
  type FrontierChecker,
  type FrontierLogSink,
  type FrontierRepo,
} from "../../frontier";
import type { CommitDeps } from "../../commit";
import { gateAndCommitHandler } from "../../commit";
import { createComposeInputHandler, type ComposeInputDeps } from "../../compose-input";
import { pagingHandlers, type PagingDeps } from "../../domain/paging";
import { finalizeMessage, type FinalizeDeps } from "../../finalize";
import type { AnswerOf } from "../calls";
import type { BaseRefusal } from "../errors";
import type { BusinessScope } from "../scope";
import {
  createToolApi,
  notBuiltHandlers,
  type CallOptions,
  type CallTrace,
  type Handlers,
  type SpanRefusedReport,
  type ToolApi,
} from "../tool-api";
import { createToolApiValidator, type ToolApiValidator } from "../validator";
import type { CommitAt } from "./commit";
import { heldTurnOf, type HeldLinks, type HeldTurns } from "./held";

/** What buildFrontier answers through the turn face: K-09's response or one of its errors, or the base's refusal. */
export type BuildFrontierCallAnswer = AnswerOf<"buildFrontier"> | BaseRefusal;
/** What gateAndCommit answers through the turn face. */
export type GateAndCommitCallAnswer = AnswerOf<"gateAndCommit"> | BaseRefusal;
/** What composeInput answers through the turn face. */
export type ComposeInputCallAnswer = AnswerOf<"composeInput"> | BaseRefusal;
/** What finalizeMessage answers through the turn face. */
export type FinalizeCallAnswer = AnswerOf<"finalizeMessage"> | BaseRefusal;

/** The turn face: the four calls of a turn, in turn order. */
export interface TurnFace {
  /**
   * K-09 buildFrontier: the turn, its texts and the guard's targets give K-02's context. The request comes as the caller
   * sends it and is checked against K-09 first; the call reads only (a repeat is safe: K-09 README).
   */
  buildFrontier(request: unknown, trace: CallTrace): Promise<BuildFrontierCallAnswer>;
  /**
   * K-09 gateAndCommit, behind the lease: `at` is the lease's CommitContext (the safety holds open and the texts not read
   * yet at commit time), handed on unchanged; the commit's openHolds joins it with K-05's read. A repeat of the same
   * turn id answers the first commit and writes nothing (K-05 v1 item 1). The base records no span: the turn records the
   * gate and the commit itself (TURN_RECORDS_GATE).
   */
  gateAndCommit(request: unknown, at: CommitAt, trace: CallTrace): Promise<GateAndCommitCallAnswer>;
  /**
   * K-09 composeInput: a committed row's K-03 composer input, with only what limit 7 lets its reader see. A read. The base
   * records no span: the turn records the row's fillAndChecks itself (TURN_RECORDS_FILL_AND_CHECKS).
   */
  composeInput(request: unknown, trace: CallTrace): Promise<ComposeInputCallAnswer>;
  /**
   * K-09 finalizeMessage: the row's options, fixed lines, slots and checks on the plan, written with it when it sends. The
   * base records no span: the turn records the row's fillAndChecks itself (TURN_RECORDS_FILL_AND_CHECKS).
   */
  finalizeMessage(request: unknown, trace: CallTrace): Promise<FinalizeCallAnswer>;
}

/** What gate and commit, compose input and finalize run with (T-1141): their scope and each call's deps. */
export interface TurnFaceCalls<Repo> {
  /** The business scope the three run under: the Tool API's own (rosie_app on PostgreSQL), one transaction per call. */
  readonly scope: BusinessScope<Repo>;
  /** The commit's deps for one call, given the runtime's commit-time context (commit.ts turnCommitDeps). */
  readonly commit: (at: CommitAt) => CommitDeps<Repo>;
  /** Compose input's deps (rows.ts). Omitted: composeInput answers notBuilt. */
  readonly compose?: ComposeInputDeps<Repo>;
  /** Finalize's deps (rows.ts). Omitted: finalizeMessage answers notBuilt. */
  readonly finalize?: FinalizeDeps<Repo>;
  /**
   * Where the face holds each committed turn's texts and language as the runtime handed them in gateAndCommit's request
   * (held.ts; K-05 v1.3 default 47), which compose input's row binding reads. Omitted: nothing is held, so no row is
   * given an inbound text.
   */
  readonly held?: HeldTurns;
  /**
   * Where the face holds S1-10's secure link between the turn's commit and its row's finalize (T-1533; held.ts
   * HeldLinks; K-09 README default 211): S1-10's writer stages it (the binding hands the writer this same object as its
   * LinkStage), the face moves it into the hold only on a committed answer with repeated false, and lets it go once the
   * row's finalize answered send, sendAndLog or passedOn; finalize's row binding reads it (rows.ts RowBinding.links).
   * Omitted: nothing is staged, held or let go.
   */
  readonly links?: HeldLinks;
  /**
   * The paging service's ports for its six calls made alone on this base (T-1443; pagingHandlers): its reads (the
   * runtime's PagingReader: T-1444), ids, ENVIRONMENT, staging's roster, its commit with no turn and its clock. Omitted:
   * each of the six answers notBuilt and nothing is read.
   */
  readonly paging?: PagingDeps<Repo>;
}

export interface TurnFaceOptions<Repo extends FrontierRepo, CallRepo = unknown> {
  /** The business scope the frontier reads under: on PostgreSQL, pg/frontier.ts pgFrontierScope (rosie_job). */
  readonly scope: BusinessScope<Repo>;
  /** The bundles, read under their ids (KV, or PostgreSQL's copy on a miss). */
  readonly bundles: FrontierBundles;
  /** Gate and commit, compose input and finalize (T-1141). Omitted: each answers notBuilt (fail closed). */
  readonly calls?: TurnFaceCalls<CallRepo>;
  /**
   * K-09's checks. Default: the validator over the frozen schemas read from contracts/ (the Worker passes its prebuilt
   * validators: T-1144).
   */
  readonly validator?: ToolApiValidator;
  /** K-02's checks of the frontier. Default: one per isolate. */
  readonly checker?: FrontierChecker;
  /** Where the frontier's log lines go (labels only). Default: one JSON line each on console.warn. */
  readonly log?: FrontierLogSink;
  /** Told when the trace refuses a call's span. Default: one JSON line on console.warn. */
  readonly onSpanRefused?: (report: SpanRefusedReport) => void;
}

/**
 * The handle actor's turn records the gate (one span per part, with its limits) and the commit around gateAndCommit
 * (runtime/src/turn/turn.ts sendCommit), so the face's gateAndCommit tells the base it records the gate hop itself.
 */
export const TURN_RECORDS_GATE: CallOptions = { callerRecordsHop: "gate" };

/**
 * The turn records one fillAndChecks span per row, around the row's finalize (runtime/src/turn/compose.ts), the hop
 * composeInput and finalizeMessage take, so the face's two calls tell the base it records that hop itself.
 */
export const TURN_RECORDS_FILL_AND_CHECKS: CallOptions = { callerRecordsHop: "fillAndChecks" };

/**
 * The base's handlers for the three calls after the frontier, gateAndCommit's deps those of one call's context, and the
 * paging service's six calls made alone when the calls carry its ports (T-1443). Exported so a test, or a binding that
 * makes a paging call alone (T-1444), can run the same handlers on a base called as any other caller calls it.
 */
export function callHandlers<Repo>(calls: TurnFaceCalls<Repo>, at: CommitAt | null): Handlers<Repo> {
  const handlers = notBuiltHandlers() as Handlers<Repo>;
  return {
    ...handlers,
    ...(at === null ? {} : { gateAndCommit: gateAndCommitHandler<Repo>(calls.commit(at)) }),
    ...(calls.compose === undefined ? {} : { composeInput: createComposeInputHandler<Repo>(calls.compose) }),
    ...(calls.finalize === undefined ? {} : { finalizeMessage: finalizeMessage<Repo>(calls.finalize) }),
    ...(calls.paging === undefined ? {} : pagingHandlers<Repo>(calls.paging)),
  };
}

/** The turn face: every call through a Tool API base (see the top of this file). */
export function createTurnFace<Repo extends FrontierRepo, CallRepo = unknown>(
  options: TurnFaceOptions<Repo, CallRepo>,
): TurnFace {
  const validator = options.validator ?? createToolApiValidator();
  const spanRefused = options.onSpanRefused === undefined ? {} : { onSpanRefused: options.onSpanRefused };
  const frontier = createToolApi<Repo>({
    validator,
    scope: options.scope,
    handlers: frontierHandlers<Repo>({
      bundles: options.bundles,
      ...(options.checker === undefined ? {} : { checker: options.checker }),
      ...(options.log === undefined ? {} : { log: options.log }),
    }),
    ...spanRefused,
  });
  const { calls } = options;
  /** The base for the calls after the frontier: gateAndCommit's handler holds one call's commit-time context. */
  const callsApi = (at: CommitAt | null): ToolApi =>
    calls === undefined
      ? createToolApi<unknown>({
          validator,
          scope: { withBusiness: (_businessId, work) => work(undefined) },
          handlers: notBuiltHandlers(),
          ...spanRefused,
        })
      : createToolApi<CallRepo>({
          validator,
          scope: calls.scope,
          handlers: callHandlers(calls, at),
          ...spanRefused,
        });
  const steady = callsApi(null);
  return {
    // The base holds each answer to its call's response or errors, or answers one of its own refusals. The frontier's
    // span is the base's; for the three calls after it the turn records the hop, so the base records none (T-1193).
    buildFrontier: (request, trace) =>
      frontier.call("buildFrontier", request, trace) as Promise<BuildFrontierCallAnswer>,
    async gateAndCommit(request, at, trace) {
      // S1-10's secure link (held.ts HeldLinks): nothing staged for the turn before its gate runs, and nothing after.
      const links = calls?.links;
      const turnId = turnIdOf(request);
      if (turnId !== null) links?.dropStaged(turnId);
      try {
        const answer = (await callsApi(at).call(
          "gateAndCommit",
          request,
          trace,
          TURN_RECORDS_GATE,
        )) as GateAndCommitCallAnswer;
        // A committed turn (first or repeated): its texts and language, as the runtime handed them, held for its rows.
        if ("result" in answer && answer.result === "committed") {
          const held = heldTurnOf(request);
          if (held !== null && held.turnId === answer.turnId) calls?.held?.hold(held.turnId, held.turn);
          // Only a fresh commit's links are held, each for a row the commit wrote (K-05 v1 item 1: a repeat wrote none).
          if (turnId !== null && answer.turnId === turnId && !answer.repeated) {
            links?.keep(
              turnId,
              answer.written.outboxRows.map((row) => row.id),
            );
          }
        }
        return answer;
      } finally {
        if (turnId !== null) links?.dropStaged(turnId);
      }
    },
    composeInput: (request, trace) =>
      steady.call(
        "composeInput",
        request,
        trace,
        TURN_RECORDS_FILL_AND_CHECKS,
      ) as Promise<ComposeInputCallAnswer>,
    async finalizeMessage(request, trace) {
      const answer = (await steady.call(
        "finalizeMessage",
        request,
        trace,
        TURN_RECORDS_FILL_AND_CHECKS,
      )) as FinalizeCallAnswer;
      // The row's secure link goes once its finalize has answered for good (held.ts HeldLinks); a rewrite keeps it.
      const rowId = outboxRowIdOf(request);
      if (rowId !== null && "outcome" in answer && LETS_LINK_GO.includes(answer.outcome)) {
        calls?.links?.letGo(rowId);
      }
      return answer;
    },
  };
}

/** The finalize outcomes after which a row's held link is let go (K-09 README default 211): every one but rewrite. */
const LETS_LINK_GO: readonly string[] = ["send", "sendAndLog", "passedOn"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The turn id a gateAndCommit request names (K-09 v1.5 gateAndCommit.turn.id), or null when it names none. */
function turnIdOf(request: unknown): string | null {
  if (!isRecord(request) || !isRecord(request.turn)) return null;
  const { id } = request.turn;
  return typeof id === "string" && id !== "" ? id : null;
}

/** The outbox row a finalizeMessage request names (K-09 v1 finalizeMessage.outboxRowId), or null. */
function outboxRowIdOf(request: unknown): string | null {
  if (!isRecord(request)) return null;
  const { outboxRowId } = request;
  return typeof outboxRowId === "string" && outboxRowId !== "" ? outboxRowId : null;
}
