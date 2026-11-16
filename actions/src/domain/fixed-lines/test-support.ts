// Doubles and fixtures for the fixed-lines tests (T-1414). Never imported by the Worker. No database: T-317's in-memory
// record of the frozen contracts' seeds (K-04 v1's people, handles and phones; K-29 v1's consent rows), read as the
// runtime side reads it (domain/flags/test-support.ts), and K-09 v1's stop-recorded.json for a keyword turn's shape.
// Doubles stand in for ports only, never for the service under test. Values come only from the contracts' fixtures
// and the master's sample cast, in the 555-01xx range (rule 9).

import type * as K09 from "../../../../contracts/generated/tool-api/tool-api.v1.5";
import type { CommitTurnContext, CoreAction, GateAndCommitRequest } from "../../commit";
import { copy, gateExchange } from "../../gate/framework/test-support";
import { HELP_REPLY, type FixedLineAction } from "./fixed-lines";

/** K-04 seed-business-head's barbershop: the business a test's call runs under. */
export const BARBERSHOP = "biz-lees-barbershop";

/** The guard's replies' caller for a keyword turn (replies.ts replyToKeywords): kind turn, no business. */
export function keywordCaller(
  turnId: string,
  personId: string | null,
  traceId = `trace-${turnId}`,
): K09.Caller {
  return { kind: "turn", turnId, requestId: turnId, businessId: null, personId, traceId };
}

/** One HELP text's action as the replies build it (replies.ts actionFor): helpReply, quick_reply, no actor's send. */
export function helpAction(caller: K09.Caller, recipientHandleId: string): FixedLineAction {
  return {
    call: "sendFixedLine",
    request: {
      caller: copy(caller),
      fixedLineId: HELP_REPLY,
      recipientHandleId,
      sendClass: "quick_reply",
      sentByActor: null,
    },
  };
}

/**
 * A core-only keyword turn on a handle (stop-recorded.json's turn, re-keyed to the caller's turn and trace), over its
 * texts, carrying these core actions in this order (each the request's own object, as the commit runs them).
 */
export function keywordTurn(input: {
  readonly caller: K09.Caller;
  readonly handleId: string;
  readonly eventIds: readonly string[];
  readonly core: readonly CoreAction[];
}): GateAndCommitRequest {
  const { request } = gateExchange("stop-recorded.json");
  const [first, ...rest] = input.eventIds;
  if (request.turn === null || input.caller.turnId === null || first === undefined) {
    throw new Error("a turn's call, over at least one text");
  }
  return {
    caller: copy(input.caller),
    turn: {
      ...request.turn,
      id: input.caller.turnId,
      handleId: input.handleId,
      eventIds: [first, ...rest],
      traceId: input.caller.traceId,
    },
    input: { kind: "coreOnly" },
    core: [...input.core],
    now: request.now,
  };
}

/** The turn as the commit hands it to its core actions, one context for the run (commit.ts runCoreActions). */
export function contextOf(request: GateAndCommitRequest, businessId = BARBERSHOP): CommitTurnContext {
  if (request.turn === null) throw new Error("the request carries its turn");
  return { request, turn: copy(request.turn), repo: { name: "fixed-lines-test-repo" }, businessId };
}

/** The request's sendFixedLine actions, in its order, as the request holds them. */
export function fixedLineActionsOf(request: GateAndCommitRequest): FixedLineAction[] {
  return request.core.filter((each): each is FixedLineAction => each.call === "sendFixedLine");
}
