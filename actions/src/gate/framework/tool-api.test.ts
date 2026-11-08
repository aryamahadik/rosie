// T-298: the gate as a Tool API call on the T-290 base. gateAndCommit's handler runs the gate inside the call's business
// scope (a recording scope fake, no database); a stand-in for the commit (T-305's) writes nothing and answers each part
// as K-09 v1 does, so the base's own validator holds every answer to K-09 v1, every refusal rolls the call back, and the
// gate span logs limits 1 to 6 as K-08 v1.1 accepts them, with no quote's or value's words.

import { describe, expect, it } from "vitest";

import type { Span } from "../../../../runtime/src/trace";
import {
  recordingHandlers,
  recordingScope,
  traceFor,
  type HandlerCall,
  type ScopeEvent,
} from "../../tool-api/test-support";
import { createToolApi } from "../../tool-api/tool-api";
import { createToolApiValidator } from "../../tool-api/validator";
import { partResultOf, runGate } from "./gate";
import {
  DECIDED_GATE_FIXTURES,
  copy,
  decidedOf,
  fixtureScript,
  gateExchange,
  gateRequest,
  modelFixture,
  refusedDecideOutputs,
  samKinds,
  scriptedLimits,
  stubLimits,
  twoRequests,
  wordsIn,
  type LimitCall,
  type Script,
} from "./test-support";
import type { Context, Decided, GateRequest, GatedPart, LimitRegistry } from "./types";

const validator = createToolApiValidator();

/** A stand-in for the commit (T-305): it writes nothing and answers each gated part as K-09 v1 `partResult`. */
function committedStandIn(request: GateRequest, parts: readonly GatedPart[]): unknown {
  return {
    result: "committed",
    turnId: request.caller.turnId,
    committedAt: request.now,
    repeated: false,
    parts: parts.map((part) => partResultOf(part)),
    planner: null,
    core: [],
    written: { written: [], outboxRows: [], promoted: [] },
    effects: [],
    openQuestions: { opened: [], closed: [] },
  };
}

interface Called {
  answer: unknown;
  events: ScopeEvent[];
  seen: HandlerCall[];
  spans: Span[];
}

/** One gateAndCommit call through the Tool API base, its handler running the gate with `limits`. */
async function callGate(request: unknown, limits: LimitRegistry): Promise<Called> {
  const scope = recordingScope();
  const seen: HandlerCall[] = [];
  const handlers = recordingHandlers(
    "gateAndCommit",
    async (given, context) => {
      const gateRequest = given as GateRequest;
      const verdict = await runGate(gateRequest, context, limits);
      return verdict.verdict === "refused" ? verdict.error : committedStandIn(gateRequest, verdict.parts);
    },
    seen,
  );
  const api = createToolApi({ validator, scope, handlers });
  const { trace, spans } = traceFor(request);
  const answer = await api.call("gateAndCommit", request, trace);
  return { answer, events: scope.events, seen, spans };
}

/** The one span a call left, checked against K-08 v1.1 and for the pair's words. */
function gateSpan(called: Called, decided: Decided): Span {
  expect(called.spans).toHaveLength(1);
  const [span] = called.spans;
  if (span === undefined) throw new Error("no span");
  expect(span.hop).toBe("gate");
  expect(validator.checkSpan(span)).toEqual([]);
  const line = JSON.stringify(span);
  for (const words of wordsIn(decided).filter((each) => each.length >= 3)) {
    expect(line.includes(words), `the span holds "${words}"`).toBe(false);
  }
  return span;
}

const whats = (events: readonly ScopeEvent[]): string[] => events.map((event) => event.what);

describe("the gate on the Tool API base: gateAndCommit's handler", () => {
  it("decide-two-requests.json: part 2 stopped by limit 2, part 1 committed; the answer passes K-09 v1", async () => {
    const decided = twoRequests();
    const request = gateRequest(decided);
    expect(validator.check("gateAndCommit", "request", request)).toEqual([]);
    const script: Script = {
      1: { 2: { result: "fail", outcome: { limit: 2, outcome: "refuse", action: "saidWhatRuleAllows" } } },
    };
    const called = await callGate(request, scriptedLimits(script));
    expect(validator.check("gateAndCommit", "response", called.answer)).toEqual([]);
    expect(called.answer).toMatchObject({
      result: "committed",
      parts: [
        { part: 0, choiceId: "c-01", result: "committed", stoppedBy: null, dependsOnPart: null },
        {
          part: 1,
          choiceId: "c-04",
          result: "stopped",
          stoppedBy: { limit: 2, outcome: "refuse", action: "saidWhatRuleAllows" },
          dependsOnPart: null,
        },
      ],
    });
    expect(whats(called.events)).toEqual(["begin", "scope", "read", "commit"]);
    expect(gateSpan(called, decided).limits).toEqual([
      { limit: 1, result: "pass", outcome: null },
      { limit: 2, result: "fail", outcome: "saidWhatRuleAllows" },
      { limit: 3, result: "pass", outcome: null },
      { limit: 4, result: "pass", outcome: null },
      { limit: 5, result: "pass", outcome: null },
      { limit: 6, result: "pass", outcome: null },
    ]);
  });

  it.each(DECIDED_GATE_FIXTURES)(
    "%s: the gate's answer passes K-09 v1 as the fixture states it",
    async (file) => {
      const exchange = gateExchange(file);
      const called = await callGate(exchange.request, scriptedLimits(fixtureScript(exchange)));
      const { outcome } = exchange;
      if ("error" in outcome) {
        expect(called.answer).toEqual(outcome);
        expect(whats(called.events).at(-1)).toBe("rollback");
        return;
      }
      if (outcome.result !== "committed") throw new Error("a committed fixture expected");
      expect(validator.check("gateAndCommit", "response", called.answer)).toEqual([]);
      // The stand-in writes nothing, so no part names keys its step gave (the commit's, T-305).
      expect((called.answer as { parts: unknown }).parts).toEqual(
        outcome.parts.map((part) => ({ ...part, gives: [] })),
      );
      gateSpan(called, decidedOf(exchange));
    },
  );
});

/** The refused decide reads K-02 v1's schema refuses (`decideRead`); the other two pass it and break a named rule. */
const SCHEMA_REFUSED = new Set(["refuse-unknown-verb.json", "refuse-value-without-words.json"]);

describe("every K-02 v1 refused fixture is refused before any limit runs, through the Tool API", () => {
  it.each(refusedDecideOutputs())("%s", async (file, decided, rule) => {
    const request = gateRequest(decided);
    const calls: LimitCall[] = [];
    const called = await callGate(request, scriptedLimits({}, calls));
    expect(calls).toEqual([]);
    if (SCHEMA_REFUSED.has(file)) {
      // K-09's request holds K-02's schema, which refuses it: the base answers before the handler, so before the gate.
      expect(validator.check("gateAndCommit", "request", request).length).toBeGreaterThan(0);
      expect(called.answer).toMatchObject({ error: "invalidRequest", call: "gateAndCommit" });
      expect(called.seen).toEqual([]);
      expect(called.events).toEqual([]);
      return;
    }
    // A named rule refuses it: the gate answers decideRefused, and the call is rolled back.
    expect(validator.check("gateAndCommit", "request", request)).toEqual([]);
    expect(called.answer).toEqual({ error: "decideRefused", rule, parts: [0] });
    expect(whats(called.events)).toEqual(["begin", "scope", "read", "rollback"]);
    expect(gateSpan(called, decided).limits?.every((limit) => limit.result === "notChecked")).toBe(true);
  });

  it("refuse-over-60-choices.json and refuse-planner-books.json are refused before the handler", async () => {
    const overSixty: Decided = {
      ...samKinds(),
      context: modelFixture("invalid/refuse-over-60-choices.json") as Context,
    };
    const plannerBooks = gateRequest(twoRequests()) as unknown as { input: Record<string, unknown> };
    plannerBooks.input.planner = { output: modelFixture("invalid/refuse-planner-books.json"), parts: [0] };
    for (const request of [gateRequest(overSixty), plannerBooks]) {
      const calls: LimitCall[] = [];
      const called = await callGate(request, scriptedLimits({}, calls));
      expect(called.answer).toMatchObject({ error: "invalidRequest", call: "gateAndCommit" });
      expect(called.seen).toEqual([]);
      expect(calls).toEqual([]);
    }
  });
});

describe("with no limit module built, the call answers notBuilt: rolled back, nothing passes", () => {
  it("decide-two-requests.json", async () => {
    const decided = twoRequests();
    const calls: LimitCall[] = [];
    const called = await callGate(gateRequest(decided), stubLimits(calls));
    expect(called.answer).toEqual({ error: "notBuilt", call: "gateAndCommit" });
    expect(whats(called.events)).toEqual(["begin", "scope", "read", "rollback"]);
    expect(calls).toEqual([
      { limit: 1, part: 0 },
      { limit: 1, part: 1 },
    ]);
    expect(gateSpan(called, decided).limits?.[0]).toEqual({ limit: 1, result: "fail", outcome: "notBuilt" });
  });

  it.each(DECIDED_GATE_FIXTURES)("%s", async (file) => {
    const exchange = gateExchange(file);
    const called = await callGate(copy(exchange.request), stubLimits());
    expect(called.answer).toEqual({ error: "notBuilt", call: "gateAndCommit" });
    expect(whats(called.events).at(-1)).toBe("rollback");
  });
});
