// The Tool API's turn face (T-315; C-074; K-09 v1 README "The turn face (called by the handle actor and the AI layer)"):
// the calls the handle actor makes in a turn, each through the Tool API base (T-290), so each is checked against K-09 v1,
// refused before any read when it names no business, run inside one transaction scoped to its caller's business, held
// to its response or errors, and given its one K-08 span on the trace it is handed.
//
// This round builds the frontier hop only (DL-319): buildFrontier, the frontier (T-291, T-295) over the turn's stored
// state read through K-05 v1.2 readTurnState under the call's business scope (pg/frontier.ts on PostgreSQL), with the
// frontier's sources as main's registry has them (frontier/assemble/registry.ts), never a stand-in. The bundles are
// injected as the frontier takes them (FrontierBundles: KV, or PostgreSQL's copy on a miss), which join 6 (T-557) wires.
// Gate and commit, compose input and finalize are T-1141's (turn face, part 2).
//
// The base records the call's span (hop frontier) on the trace it is handed. The actor's turn also records a frontier span
// around its port (runtime/src/turn/turn.ts), and K-08's hop check fails a hop recorded twice, so which of the two the
// skeleton's trace keeps is for join 6 (T-557) to wire (T-315's handoff).

import {
  frontierHandlers,
  type FrontierBundles,
  type FrontierChecker,
  type FrontierLogSink,
  type FrontierRepo,
} from "../../frontier";
import type { AnswerOf } from "../calls";
import type { BaseRefusal } from "../errors";
import type { BusinessScope } from "../scope";
import { createToolApi, type CallTrace, type SpanRefusedReport } from "../tool-api";
import { createToolApiValidator, type ToolApiValidator } from "../validator";

/** What buildFrontier answers through the turn face: K-09 v1's response or one of its errors, or the base's refusal. */
export type BuildFrontierCallAnswer = AnswerOf<"buildFrontier"> | BaseRefusal;

/** The turn face, as far as it is built: the frontier hop (DL-319). */
export interface TurnFace {
  /**
   * K-09 v1 buildFrontier: the turn, its texts and the guard's targets give K-02 v1's context. The request comes as the
   * caller sends it and is checked against K-09 v1 first; the call reads only (a repeat is safe: K-09 README).
   */
  buildFrontier(request: unknown, trace: CallTrace): Promise<BuildFrontierCallAnswer>;
}

export interface TurnFaceOptions<Repo extends FrontierRepo> {
  /** The business scope the frontier reads under: on PostgreSQL, pg/frontier.ts pgFrontierScope (rosie_job). */
  readonly scope: BusinessScope<Repo>;
  /** The bundles, read under their ids (KV, or PostgreSQL's copy on a miss). */
  readonly bundles: FrontierBundles;
  /**
   * K-09 v1's checks. Default: the validator over the frozen schemas read from contracts/, which the Worker cannot run
   * yet (actions/README.md, open point "Ajv in the Worker").
   */
  readonly validator?: ToolApiValidator;
  /** K-02 v1's checks of the frontier. Default: one per isolate (the same open point). */
  readonly checker?: FrontierChecker;
  /** Where the frontier's log lines go (labels only). Default: one JSON line each on console.warn. */
  readonly log?: FrontierLogSink;
  /** Told when the trace refuses a call's span. Default: one JSON line on console.warn. */
  readonly onSpanRefused?: (report: SpanRefusedReport) => void;
}

/** The turn face over a business scope: every call through one Tool API base, buildFrontier built. */
export function createTurnFace<Repo extends FrontierRepo>(options: TurnFaceOptions<Repo>): TurnFace {
  const api = createToolApi<Repo>({
    validator: options.validator ?? createToolApiValidator(),
    scope: options.scope,
    handlers: frontierHandlers<Repo>({
      bundles: options.bundles,
      ...(options.checker === undefined ? {} : { checker: options.checker }),
      ...(options.log === undefined ? {} : { log: options.log }),
    }),
    ...(options.onSpanRefused === undefined ? {} : { onSpanRefused: options.onSpanRefused }),
  });
  return {
    // The base holds the answer to buildFrontier's response or errors, or answers one of its own refusals.
    buildFrontier: (request, trace) =>
      api.call("buildFrontier", request, trace) as Promise<BuildFrontierCallAnswer>,
  };
}
