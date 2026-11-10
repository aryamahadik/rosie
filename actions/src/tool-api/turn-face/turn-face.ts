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
// Calls 2 to 4 run under the Tool API's own business scope (`calls.scope`: rosie_app on PostgreSQL, never the frontier's
// rosie_job scope: T-315's security note b), and each K-05 call that needs the runtime side runs in a transaction of its
// own (STATE note 59). Without `calls`, each of them answers notBuilt and nothing is read (fail closed).
//
// The base records the call's span (frontier, gate, fillAndChecks) on the trace it is handed. The actor's turn records
// its own spans around its ports (runtime/src/turn/turn.ts), and K-08's hop check fails a hop recorded twice, so which of
// the two the skeleton's trace keeps is for each join to wire (T-315's handoff).

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
import { finalizeMessage, type FinalizeDeps } from "../../finalize";
import type { AnswerOf } from "../calls";
import type { BaseRefusal } from "../errors";
import type { BusinessScope } from "../scope";
import {
  createToolApi,
  notBuiltHandlers,
  type CallTrace,
  type Handlers,
  type SpanRefusedReport,
  type ToolApi,
} from "../tool-api";
import { createToolApiValidator, type ToolApiValidator } from "../validator";
import type { CommitAt } from "./commit";
import { heldTurnOf, type HeldTurns } from "./held";

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
   * turn id answers the first commit and writes nothing (K-05 v1 item 1).
   */
  gateAndCommit(request: unknown, at: CommitAt, trace: CallTrace): Promise<GateAndCommitCallAnswer>;
  /** K-09 composeInput: a committed row's K-03 composer input, with only what limit 7 lets its reader see. A read. */
  composeInput(request: unknown, trace: CallTrace): Promise<ComposeInputCallAnswer>;
  /** K-09 finalizeMessage: the row's options, fixed lines, slots and checks on the plan, written with it when it sends. */
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

/** The base's handlers for the three calls after the frontier, gateAndCommit's deps those of one call's context. */
function callHandlers<Repo>(calls: TurnFaceCalls<Repo>, at: CommitAt | null): Handlers<Repo> {
  const handlers = notBuiltHandlers() as Handlers<Repo>;
  return {
    ...handlers,
    ...(at === null ? {} : { gateAndCommit: gateAndCommitHandler<Repo>(calls.commit(at)) }),
    ...(calls.compose === undefined ? {} : { composeInput: createComposeInputHandler<Repo>(calls.compose) }),
    ...(calls.finalize === undefined ? {} : { finalizeMessage: finalizeMessage<Repo>(calls.finalize) }),
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
    // The base holds each answer to its call's response or errors, or answers one of its own refusals.
    buildFrontier: (request, trace) =>
      frontier.call("buildFrontier", request, trace) as Promise<BuildFrontierCallAnswer>,
    async gateAndCommit(request, at, trace) {
      const answer = (await callsApi(at).call("gateAndCommit", request, trace)) as GateAndCommitCallAnswer;
      // A committed turn (first or repeated): its texts and language, as the runtime handed them, held for its rows.
      if ("result" in answer && answer.result === "committed") {
        const held = heldTurnOf(request);
        if (held !== null && held.turnId === answer.turnId) calls?.held?.hold(held.turnId, held.turn);
      }
      return answer;
    },
    composeInput: (request, trace) =>
      steady.call("composeInput", request, trace) as Promise<ComposeInputCallAnswer>,
    finalizeMessage: (request, trace) =>
      steady.call("finalizeMessage", request, trace) as Promise<FinalizeCallAnswer>,
  };
}
