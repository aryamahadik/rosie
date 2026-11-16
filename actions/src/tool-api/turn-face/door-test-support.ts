// What the keyword door's tests use (T-1413): K-09 v1's stop-recorded.json and start-recorded.json, and Ben's START
// carried as the core actions of his own turn, as T-1163's proofs carry it (commit/core/core-flags.test.ts startTurn).
// Never imported by the Worker. Values come only from the contracts' fixtures and the master's sample cast, in the
// 555-01xx range (rule 9).

import type * as K09 from "../../../../contracts/generated/tool-api/tool-api.v1.5";
import type { CommitTurnResponse, Committed, CoreAction, GateAndCommitRequest } from "../../commit";
import type { StopOrStartRequest, StopOrStartResponse } from "../../domain/flags";
import { k09Fixture } from "../../domain/flags/test-support";
import { copy, gateExchange } from "../../gate/framework/test-support";

/** Ben's mobile as K-09 v1's stop-recorded.json and start-recorded.json name it, in the 555-01xx range (rule 9). */
export const BEN = "+15555550131";

/** Its digits: no run of four or more of them may leave the door (DL-877 C4). */
export const BEN_DIGITS = "15555550131";

/** The consent words of Ben's STOP and START (K-29 exact_words): never in a log line, a span, an answer or a throw. */
export const CONSENT_WORDS: readonly string[] = ["STOP", "START"];

/** The turn the tests carry start-recorded.json's START in (T-1163's proofs carry it the same way). */
export const START_TURN = "turn-ben-start";

/** stop-recorded.json (K-09 v1): Ben's core-only turn (his text's record, then his STOP) and its committed outcome. */
export function stopRecorded(): { request: GateAndCommitRequest; outcome: Committed } {
  const { request, outcome } = gateExchange("stop-recorded.json");
  if (!("result" in outcome) || outcome.result !== "committed") throw new Error("stop-recorded.json commits");
  return { request, outcome };
}

/** start-recorded.json (K-09 v1): Ben's START, written on return by the handle actor, made alone. */
export function startRecorded(): { request: StopOrStartRequest; outcome: StopOrStartResponse } {
  return copy(
    k09Fixture("start-recorded.json") as { request: StopOrStartRequest; outcome: StopOrStartResponse },
  );
}

/** What K-05 answered for stop-recorded.json's commit, as its outcome states it. */
export function k05AnswerOf(outcome: Committed): CommitTurnResponse {
  return {
    result: "committed",
    turnId: outcome.turnId,
    committedAt: outcome.committedAt,
    repeated: false,
    committed: copy(outcome.written),
  };
}

/**
 * Ben's START as the core actions of his own turn after stop-recorded.json (T-1163's startTurn): start-recorded.json's
 * text (his phone, his word, his text's event and trace), his turn's caller naming no business as his STOP's does, at the
 * time it came, carrying his text's record first (K-09 README default 5: stop-recorded.json's record, for this text) and
 * then the START, which carries no actor's send (the turn's commit writes its reply).
 */
export function startTurn(): GateAndCommitRequest {
  const stop = stopRecorded().request;
  const { request } = startRecorded();
  const eventId = request.inboundEventId;
  if (eventId === null || request.sentByActor === null || stop.turn === null) {
    throw new Error("start-recorded.json's text and stop-recorded.json's turn");
  }
  const caller: K09.Caller = {
    kind: "turn",
    turnId: START_TURN,
    requestId: START_TURN,
    businessId: null,
    personId: request.caller.personId,
    traceId: request.caller.traceId,
  };
  const [record] = stop.core;
  if (record?.call !== "recordSafetyOutcome") {
    throw new Error("stop-recorded.json's turn carries its text's record first");
  }
  const recordAction: CoreAction = {
    call: "recordSafetyOutcome",
    request: { ...record.request, caller, safety: { ...record.request.safety, eventId } },
  };
  return {
    caller,
    turn: { ...stop.turn, id: START_TURN, eventIds: [eventId], traceId: caller.traceId },
    input: { kind: "coreOnly" },
    core: [recordAction, { call: "recordStopOrStart", request: { ...request, caller, sentByActor: null } }],
    now: request.sentByActor.at,
  };
}

/** Every run of four or more of Ben's number's digits a text holds: none may leave the door (DL-877 C4). */
export function numberRunsIn(text: string): string[] {
  const found: string[] = [];
  for (const run of text.match(/[0-9]{4,}/gu) ?? []) {
    for (let from = 0; from + 4 <= run.length; from += 1) {
      const piece = run.slice(from, from + 4);
      if (BEN_DIGITS.includes(piece)) found.push(piece);
    }
  }
  return found;
}

/** What one text of the door's output holds that it never may: a run of the number's digits, the address, the words. */
export function leaksIn(text: string): string[] {
  return [
    ...numberRunsIn(text),
    ...(text.includes(BEN) ? [BEN] : []),
    ...CONSENT_WORDS.filter((words) => text.includes(words)),
  ];
}
