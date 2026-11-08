// T-290's proofs (the card's "Proves it with"), on K-09 v1's own fixtures and a recording repo fake, never a database:
//   - an invalid request for every K-09 v1 call is refused with the contract's error shape, before its handler and before
//     any read;
//   - a valid fixture request reaches its handler, inside its business scope, and the handler's answer comes back held to
//     the call's response and errors;
//   - a call made without a business scope is refused before any read;
//   - each call opens one K-08 span with the trace's id and bundle id, which never carries a raw phone number or a
//     person's words, checked against K-08 v1.1's span schema, which refuses refuse-raw-phone-in-span.json.
// Values come only from the contracts' fixtures (the master's sample cast, the 555-01xx range: rule 9).

import { describe, expect, it } from "vitest";

import type { Span } from "../../../runtime/src/trace";
import type { Tx } from "../../../db/repo/scope";
import { CALL_HOPS, CALL_NAMES, hopOf, type CallName, type CallerKind } from "./calls";
import { NotBuiltError, ToolApiContractError } from "./errors";
import { businessScopeOf } from "./scope";
import {
  BUNDLE,
  HANDLE_REF,
  acceptedExchanges,
  callerOf,
  contractFile,
  fixture,
  fixtureEntries,
  recordingHandlers,
  recordingScope,
  stringsIn,
  traceFor,
  type Exchange,
  type HandlerCall,
  type RecordingRepo,
} from "./test-support";
import { createToolApi, notBuiltHandlers, type CallContext } from "./tool-api";
import { createToolApiValidator } from "./validator";

type Json = Record<string, unknown>;

const validator = createToolApiValidator();

/** A Tool API over a recording scope, `call`'s handler recording what it sees and answering `answer`. */
function setup(call: CallName, answer: (request: unknown, context: CallContext<RecordingRepo>) => unknown) {
  const scope = recordingScope();
  const seen: HandlerCall[] = [];
  const api = createToolApi({ validator, scope, handlers: recordingHandlers(call, answer, seen) });
  return { api, scope, seen };
}

/** The one span a call left; fails the test when there is not exactly one. */
function onlySpan(spans: readonly Span[]): Span {
  expect(spans).toHaveLength(1);
  const [span] = spans;
  if (span === undefined) throw new Error("no span");
  return span;
}

const never = (): unknown => {
  throw new Error("the handler must not run");
};

/** A valid plannerVerbs request: K-02's planner-answer.json for part 0 (plannerVerbs has no exchange of its own). */
const PLANNER_REQUEST: Json = { output: contractFile("model/fixtures/planner-answer.json"), parts: [0] };

/** One accepted request for each call that has one, from a fixture whose caller names a business. */
const VALID: Partial<Record<CallName, Json>> = {};
for (const { exchange } of acceptedExchanges()) {
  if (VALID[exchange.call] === undefined && typeof callerOf(exchange.request)?.businessId === "string") {
    VALID[exchange.call] = exchange.request;
  }
}

/** The team console, acting for Lee's Barbershop: the caller of the requests built below. */
const CONSOLE_CALLER = {
  kind: "console",
  turnId: null,
  requestId: "req-console-team-0003",
  businessId: "biz-lees-barbershop",
  personId: "person-rosie-team-1",
  traceId: "trace-console-0003",
};
const AT = "2026-10-21T19:40:00Z";

/**
 * A request for each of the 11 calls that take a caller and have no accepted fixture, built from the sample cast; a test
 * checks each against the frozen schema first, so each is one the contract accepts.
 */
const BUILT: [CallName, Json][] = [
  [
    "releaseSafetyHold",
    {
      caller: CONSOLE_CALLER,
      holdId: "hold-alex-1",
      expectVersion: 1,
      why: "outcome_message_sent",
      releasedByOutcomeId: null,
    },
  ],
  [
    "handOff",
    {
      caller: CONSOLE_CALLER,
      kind: "other",
      about: "other",
      safetyOutcomeId: null,
      bookingId: null,
      aboutPersonId: null,
      summary: "Alex M. asked to talk to Sam.",
    },
  ],
  [
    "answerHandOff",
    { caller: CONSOLE_CALLER, handOffId: "hand-off-alex-1", expectVersion: 1, via: "console_tap" },
  ],
  [
    "acknowledgePage",
    { caller: CONSOLE_CALLER, pageId: "page-alex-1", expectVersion: 1, via: "console_tap" },
  ],
  ["enterDoor", { caller: CONSOLE_CALLER, door: "S11-12", by: "decide" }],
  [
    "sendFixedLine",
    {
      caller: CONSOLE_CALLER,
      fixedLineId: "optOutLine",
      recipientHandleId: "handle-ben",
      sendClass: "quick_reply",
      sentByActor: null,
    },
  ],
  ["sendsFailing", { caller: CONSOLE_CALLER, outboxRowId: "outbox-ben-1", failingSince: AT }],
  ["textingBack", { caller: CONSOLE_CALLER, recipientHandleId: "handle-ben", outageStartedAt: AT }],
  [
    "calendarLinkDropped",
    {
      caller: CONSOLE_CALLER,
      calendarLinkId: "calendar-link-sam-1",
      personId: "person-sam",
      why: "tokenRevoked",
      droppedAt: AT,
    },
  ],
  ["calendarLinkBack", { caller: CONSOLE_CALLER, calendarLinkId: "calendar-link-sam-1", backAt: AT }],
  ["readSetup", { caller: CONSOLE_CALLER, businessId: "biz-lees-barbershop" }],
];

/** A page's caller from flag-paused.json: Sam, signed in on the portal. */
const PAGE_CALLER = callerOf((fixture("flag-paused.json") as Exchange).request) ?? {};

/** A copy of `request` without one field. */
function without(request: Json, field: string): Json {
  return Object.fromEntries(Object.entries(request).filter(([key]) => key !== field));
}

/** The answer's problem lines, for a refusal that has them. */
function problemsOf(answer: unknown): string[] {
  return (answer as { problems: string[] }).problems;
}

/**
 * The base's invalidRequest, in the contract's error shape (02-contracts section 2 item 2: a JSON object with its own
 * "error" code): exactly the code, the call and at least one problem line.
 */
function expectInvalidRequest(answer: unknown, call: CallName, what: string): void {
  expect(answer, what).toMatchObject({ error: "invalidRequest", call });
  expect(Object.keys(answer as object).sort(), what).toEqual(["call", "error", "problems"]);
  const problems = problemsOf(answer);
  expect(problems.length, what).toBeGreaterThan(0);
  expect(
    problems.every((line) => typeof line === "string" && line !== ""),
    what,
  ).toBe(true);
}

describe("an invalid request for every K-09 v1 call is refused with the contract's error shape", () => {
  it("covers all 29 calls: 17 have an accepted fixture request to break as well, plannerVerbs one built from K-02", () => {
    expect(CALL_NAMES).toHaveLength(29);
    expect(Object.keys(VALID)).toHaveLength(17);
    expect(validator.check("plannerVerbs", "request", PLANNER_REQUEST)).toEqual([]);
  });

  for (const call of CALL_NAMES) {
    it(`${call}: invalidRequest, an object with its own error code, before its handler and any read`, async () => {
      const valid = call === "plannerVerbs" ? PLANNER_REQUEST : VALID[call];
      const invalid: [string, unknown][] = [
        ["no fields", {}],
        ["null", null],
        ["a list", []],
        ["words", "please book Ben T. in at 3"],
        ["only a caller", { caller: PAGE_CALLER }],
      ];
      if (valid !== undefined) {
        invalid.push(["a field v1 does not have", { ...valid, phone: "+15555550131" }]);
        const someField = Object.keys(valid).find((key) => key !== "caller") ?? "caller";
        invalid.push([`no ${someField}`, without(valid, someField)]);
        if (call !== "plannerVerbs") {
          invalid.push([
            "a caller kind off the list",
            { ...valid, caller: { ...callerOf(valid), kind: "robot" } },
          ]);
        }
      }
      for (const [what, request] of invalid) {
        const { api, scope, seen } = setup(call, never);
        const { trace, spans } = traceFor(request);
        const answer = await api.call(call, request, trace);
        expectInvalidRequest(answer, call, what);
        expect(JSON.stringify(answer), what).not.toContain("+15555550131");
        expect(seen, what).toEqual([]);
        expect(scope.events, what).toEqual([]);
        const span = onlySpan(spans);
        expect(span, what).toMatchObject({ outcome: "refused", error_code: "invalidRequest" });
        expect(span.decided, what).toEqual({
          answered: "invalidRequest",
          problems: problemsOf(answer).length,
        });
        expect(validator.checkSpan(span), what).toEqual([]);
      }
    });
  }

  const refusedRequests = fixtureEntries().filter(
    (entry) => entry.expect === "refuse" && entry.def.endsWith(".request"),
  );
  for (const entry of refusedRequests) {
    it(`${entry.file}, the contract's own refused request, is refused the same way`, async () => {
      const call = entry.def.replace(/[.]request$/u, "") as CallName;
      const request = fixture(entry.file);
      const { api, scope, seen } = setup(call, never);
      const { trace, spans } = traceFor(request);
      const answer = await api.call(call, request, trace);
      expectInvalidRequest(answer, call, entry.file);
      expect(seen).toEqual([]);
      expect(scope.events).toEqual([]);
      expect(onlySpan(spans)).toMatchObject({ outcome: "refused", error_code: "invalidRequest" });
    });
  }

  it("a request that names another trace than the one the call runs in is refused, before any read", async () => {
    const { request } = fixture("flag-paused.json") as Exchange;
    const { api, scope, seen } = setup("setRecordFlag", never);
    const { trace, spans } = traceFor(request, "trace-page-sam-9999");
    const answer = await api.call("setRecordFlag", request, trace);
    expect(answer).toEqual({
      error: "invalidRequest",
      call: "setRecordFlag",
      problems: ["/caller/traceId is not the trace the call runs in"],
    });
    expect(seen).toEqual([]);
    expect(scope.events).toEqual([]);
    expect(onlySpan(spans)).toMatchObject({ trace_id: "trace-page-sam-9999", outcome: "refused" });
  });

  it("a name that is no call of K-09 v1 is refused, and the name is neither echoed nor put in the span", async () => {
    const { request } = fixture("flag-paused.json") as Exchange;
    const { api, scope } = setup("setRecordFlag", never);
    const { trace, spans } = traceFor(request);
    const answer = await api.call("cancel every booking for Ben", request, trace);
    expect(answer).toEqual({ error: "unknownCall" });
    expect(scope.events).toEqual([]);
    const span = onlySpan(spans);
    expect(span).toMatchObject({ hop: "pageRequest", outcome: "refused", error_code: "unknownCall" });
    expect(span.got).toEqual({ callerKind: "page" });
    expect(JSON.stringify(span)).not.toContain("cancel every");
    expect(validator.checkSpan(span)).toEqual([]);
  });
});

describe("a valid fixture request reaches its handler, inside its business scope", () => {
  const exchanges = acceptedExchanges();
  const scoped = exchanges.filter(
    ({ exchange }) => typeof callerOf(exchange.request)?.businessId === "string",
  );

  it("57 of K-09 v1's 59 accepted exchanges name a business; the other two are a STOP and a START for every business", () => {
    expect(scoped).toHaveLength(57);
    const others = exchanges.filter((one) => !scoped.includes(one)).map(({ file }) => file);
    expect(others).toEqual(["stop-recorded.json", "start-recorded.json"]);
  });

  for (const { file, exchange } of scoped) {
    it(`${file}: ${exchange.call}'s handler gets the request; its answer comes back as the fixture's outcome`, async () => {
      const businessId = callerOf(exchange.request)?.businessId as string;
      const { api, scope, seen } = setup(exchange.call, () => exchange.outcome);
      const { trace, spans } = traceFor(exchange.request);
      const answer = await api.call(exchange.call, structuredClone(exchange.request), trace);

      expect(seen).toEqual([{ call: exchange.call, request: exchange.request, businessId }]);
      expect(answer).toEqual(exchange.outcome);
      // The contract's errors are each "Refused, nothing written": an error answer rolls the transaction back.
      const isError = validator.check(exchange.call, "response", exchange.outcome).length > 0;
      expect(scope.events).toEqual([
        { what: "begin" },
        { what: "scope", businessId },
        { what: "read", table: "businesses", rowId: businessId, scope: businessId },
        { what: isError ? "rollback" : "commit" },
      ]);
      const span = onlySpan(spans);
      const code = isError ? (exchange.outcome as { error: string }).error : null;
      expect(span.decided).toEqual({ answered: code ?? "response" });
      expect(span.error_code).toBe(code);
    });
  }
});

describe("every call that takes a caller reaches its handler with a validated request", () => {
  it("covers every call but plannerVerbs (it has no caller), with the fixtures' requests", () => {
    const covered = [...Object.keys(VALID), ...BUILT.map(([call]) => call)].sort();
    expect(covered).toEqual(CALL_NAMES.filter((call) => call !== "plannerVerbs").sort());
  });

  for (const [call, request] of BUILT) {
    it(`${call}: a request built from the sample cast passes the schema and reaches the handler, scope first`, async () => {
      expect(validator.check(call, "request", request)).toEqual([]);
      const transient = { error: "transient", sqlstate: "40001" };
      const { api, scope, seen } = setup(call, () => transient);
      const { trace, spans } = traceFor(request);
      expect(await api.call(call, structuredClone(request), trace)).toEqual(transient);
      expect(seen).toEqual([{ call, request, businessId: "biz-lees-barbershop" }]);
      expect(scope.events.map((event) => event.what)).toEqual(["begin", "scope", "read", "rollback"]);
      expect(onlySpan(spans)).toMatchObject({ trace_id: "trace-console-0003", error_code: "transient" });
    });
  }
});

describe("a call made without a business scope is refused before any read", () => {
  const stop = fixture("stop-recorded.json") as Exchange;
  const start = fixture("start-recorded.json") as Exchange;
  const paused = fixture("flag-paused.json") as Exchange;
  const unscoped: [string, CallName, Json][] = [
    ["stop-recorded.json (a STOP for every business: caller.businessId null)", "gateAndCommit", stop.request],
    [
      "start-recorded.json (a START written on return: caller.businessId null)",
      "recordStopOrStart",
      start.request,
    ],
    [
      "flag-paused.json with caller.businessId null",
      "setRecordFlag",
      { ...paused.request, caller: { ...callerOf(paused.request), businessId: null } },
    ],
    ["plannerVerbs alone (no caller at all: it rides inside gateAndCommit)", "plannerVerbs", PLANNER_REQUEST],
  ];

  for (const [what, call, request] of unscoped) {
    it(`${what}: noBusinessScope, no transaction, no read, the handler never run`, async () => {
      // The contract accepts the request: it is the missing scope, not the schema, that refuses it.
      expect(validator.check(call, "request", request)).toEqual([]);
      const { api, scope, seen } = setup(call, never);
      const { trace, spans } = traceFor(request);
      const answer = await api.call(call, request, trace);
      expect(answer).toEqual({ error: "noBusinessScope", call });
      expect(seen).toEqual([]);
      expect(scope.events).toEqual([]);
      const span = onlySpan(spans);
      expect(span).toMatchObject({ outcome: "refused", error_code: "noBusinessScope" });
      expect(span.business_id).toBeUndefined();
      expect(validator.checkSpan(span)).toEqual([]);
    });
  }

  it("with a business, the scope is set before the handler's first read, and the read runs under it", async () => {
    const { api, scope } = setup("setRecordFlag", () => ({
      rowId: "pause-alex-1",
      version: 1,
      callOffClockRowIds: [],
      repeated: false,
    }));
    const { trace } = traceFor(paused.request);
    await api.call("setRecordFlag", paused.request, trace);
    const scopeAt = scope.events.findIndex((event) => event.what === "scope");
    const readAt = scope.events.findIndex((event) => event.what === "read");
    expect(scopeAt).toBeGreaterThanOrEqual(0);
    expect(readAt).toBeGreaterThan(scopeAt);
    expect(scope.events[readAt]).toMatchObject({ scope: "biz-lees-barbershop" });
  });
});

describe("each call opens one K-08 span: the trace's id and bundle id, never a phone number or a person's words", () => {
  it("the check is not vacuous: K-08 v1.1's span schema refuses refuse-raw-phone-in-span.json", () => {
    const refused = contractFile("event-trace/fixtures/invalid/refuse-raw-phone-in-span.json");
    expect(validator.checkSpan(refused)).not.toEqual([]);
  });

  for (const { file, exchange } of acceptedExchanges()) {
    it(`${file}: ${exchange.call}`, async () => {
      const caller = callerOf(exchange.request) ?? {};
      const { api } = setup(exchange.call, () => exchange.outcome);
      const { trace, spans } = traceFor(exchange.request);
      await api.call(exchange.call, exchange.request, trace);
      const span = onlySpan(spans);

      expect(span.trace_id).toBe(caller.traceId);
      expect(span.bundle_id).toEqual(BUNDLE);
      expect(span.handle_ref).toBe(HANDLE_REF);
      expect(span.turn_id).toBe(caller.turnId);
      expect(span.hop).toBe(hopOf(exchange.call, caller.kind as CallerKind));
      expect(span.got).toEqual({ toolCall: exchange.call, callerKind: caller.kind });
      expect(validator.checkSpan(span)).toEqual([]);

      // Nothing of the request reaches the span but its caller's trace, turn, business and kind (and the pinned bundle).
      const allowed = new Set([caller.traceId, caller.turnId, caller.businessId, caller.kind, BUNDLE.hash]);
      const inSpan = new Set(stringsIn(span));
      expect(stringsIn(exchange.request).filter((value) => !allowed.has(value) && inSpan.has(value))).toEqual(
        [],
      );
      // So no phone number, no email address and no words: no string of the span has a space, a + or an @.
      expect(stringsIn(span).filter((value) => /[\s+@]/u.test(value))).toEqual([]);

      // And the same check refuses the span once a raw number or words are put in it.
      const phone = stringsIn(exchange.request).find((value) => /^\+[1-9][0-9]{6,14}$/u.test(value));
      if (phone !== undefined) expect(validator.checkSpan({ ...span, handle_ref: phone })).not.toEqual([]);
      expect(validator.checkSpan({ ...span, got: { ...span.got, words: "STOP texting me" } })).not.toEqual(
        [],
      );
    });
  }

  it("a business id that reads as a phone number runs under its scope but never reaches the span", async () => {
    const paused = fixture("flag-paused.json") as Exchange;
    const request = { ...paused.request, caller: { ...callerOf(paused.request), businessId: "15555550131" } };
    expect(validator.check("setRecordFlag", "request", request)).toEqual([]);
    const { api, scope } = setup("setRecordFlag", () => paused.outcome);
    const { trace, spans } = traceFor(request);
    await api.call("setRecordFlag", request, trace);
    expect(scope.events[1]).toEqual({ what: "scope", businessId: "15555550131" });
    const span = onlySpan(spans);
    expect(span.business_id).toBeUndefined();
    expect(JSON.stringify(span)).not.toContain("15555550131");
  });

  it("names the business when it is a label", async () => {
    const paused = fixture("flag-paused.json") as Exchange;
    const { api } = setup("setRecordFlag", () => paused.outcome);
    const { trace, spans } = traceFor(paused.request);
    await api.call("setRecordFlag", paused.request, trace);
    expect(onlySpan(spans).business_id).toBe("biz-lees-barbershop");
  });
});

describe("the hop of each call's span", () => {
  it("a page's call is a pageRequest and an outside AI's an agentApiRequest, whatever the call", () => {
    for (const call of CALL_NAMES) {
      expect(hopOf(call, "page")).toBe("pageRequest");
      expect(hopOf(call, "agent")).toBe("agentApiRequest");
    }
  });

  it("any other caller's call takes the call's own hop: the turn face its own, writes the commit", () => {
    for (const kind of ["turn", "console", "job", "clockFiring", "actorOnReturn"] as const) {
      for (const call of CALL_NAMES) expect(hopOf(call, kind)).toBe(CALL_HOPS[call]);
    }
    expect(CALL_HOPS.buildFrontier).toBe("frontier");
    expect(CALL_HOPS.closestEntries).toBe("search");
    expect(CALL_HOPS.gateAndCommit).toBe("gate");
    expect(CALL_HOPS.finalizeMessage).toBe("fillAndChecks");
    expect(CALL_HOPS.recordStopOrStart).toBe("commit");
    expect(hopOf(undefined, "turn")).toBe("commit");
  });

  it("a gate span logs limits 1 to 6 as notChecked when its handler gave none", async () => {
    const exchange = fixture("commit-s1-02.json") as Exchange;
    const { api } = setup("gateAndCommit", () => exchange.outcome);
    const { trace, spans } = traceFor(exchange.request);
    await api.call("gateAndCommit", exchange.request, trace);
    const span = onlySpan(spans);
    expect(span.hop).toBe("gate");
    expect(span.limits).toEqual(
      [1, 2, 3, 4, 5, 6].map((limit) => ({ limit, result: "notChecked", outcome: null })),
    );
  });
});

describe("the handler's answer is held to its call's response and errors", () => {
  const paused = fixture("flag-paused.json") as Exchange;

  it("an error of the call comes back as it is, rolled back; a transient one is a failed span", async () => {
    const transient = { error: "transient", sqlstate: "40001" };
    const { api, scope } = setup("setRecordFlag", () => transient);
    const { trace, spans } = traceFor(paused.request);
    expect(await api.call("setRecordFlag", paused.request, trace)).toEqual(transient);
    expect(scope.events.at(-1)).toEqual({ what: "rollback" });
    expect(onlySpan(spans)).toMatchObject({ outcome: "failed", error_code: "transient" });
  });

  it("a refusal of the call (notFound) comes back as it is, rolled back, as a refused span", async () => {
    const notFound = { error: "notFound", table: "pauses", rowId: "pause-alex-1" };
    const { api, scope } = setup("setRecordFlag", () => notFound);
    const { trace, spans } = traceFor(paused.request);
    expect(await api.call("setRecordFlag", paused.request, trace)).toEqual(notFound);
    expect(scope.events.at(-1)).toEqual({ what: "rollback" });
    expect(onlySpan(spans)).toMatchObject({ outcome: "refused", error_code: "notFound" });
  });

  it("an answer outside the contract is never passed on: rolled back and thrown", async () => {
    const { api, scope } = setup("setRecordFlag", () => ({ rowId: 7, phone: "+15555550131" }));
    const { trace, spans } = traceFor(paused.request);
    await expect(api.call("setRecordFlag", paused.request, trace)).rejects.toBeInstanceOf(
      ToolApiContractError,
    );
    expect(scope.events.at(-1)).toEqual({ what: "rollback" });
    const span = onlySpan(spans);
    expect(span).toMatchObject({ outcome: "failed", error_code: "invalidResponse" });
    expect(JSON.stringify(span)).not.toContain("+15555550131");
  });

  it("an error that is not one of the call's errors is outside the contract too", async () => {
    const { api } = setup("setRecordFlag", () => ({ error: "searchedAlready", turnId: "turn-x" }));
    const { trace } = traceFor(paused.request);
    await expect(api.call("setRecordFlag", paused.request, trace)).rejects.toThrow(ToolApiContractError);
  });

  it("a handler that throws: rolled back, the error passed on, and a failed span naming only its kind", async () => {
    const { api, scope } = setup("setRecordFlag", () => {
      throw new TypeError("Alex M. at +15555550101 broke it");
    });
    const { trace, spans } = traceFor(paused.request);
    await expect(api.call("setRecordFlag", paused.request, trace)).rejects.toThrow(TypeError);
    expect(scope.events.at(-1)).toEqual({ what: "rollback" });
    const span = onlySpan(spans);
    expect(span).toMatchObject({
      outcome: "failed",
      error_code: "TypeError",
      decided: { answered: "thrown" },
    });
    expect(JSON.stringify(span)).not.toContain("Alex");
  });

  it("every call's stub answers notBuilt until its task, inside its scope, rolled back", async () => {
    const scope = recordingScope();
    const api = createToolApi({ validator, scope, handlers: notBuiltHandlers() });
    const requests = [...Object.entries(VALID), ...BUILT] as [CallName, Json][];
    expect(requests).toHaveLength(28);
    for (const [call, request] of requests) {
      scope.events.length = 0;
      const { trace, spans } = traceFor(request);
      expect(await api.call(call, request, trace)).toEqual({ error: "notBuilt", call });
      expect(scope.events.map((event) => event.what)).toEqual(["begin", "scope", "rollback"]);
      expect(onlySpan(spans)).toMatchObject({ outcome: "refused", error_code: "notBuilt" });
    }
    await expect(notBuiltHandlers().readSetup({} as never, {} as never)).rejects.toBeInstanceOf(
      NotBuiltError,
    );
  });
});

describe("what a handler notes on its span", () => {
  const commit = fixture("commit-s1-02.json") as Exchange;

  it("its limits and the rows it wrote, the rows only when the call commits", async () => {
    const limits = [1, 2, 3, 4, 5, 6].map((limit) => ({ limit, result: "pass" as const, outcome: null }));
    const rows = [{ table: "picked_kinds", id: "picked-kind-sam-1" }];
    const note = (context: CallContext<RecordingRepo>): void => {
      context.span.limits.push(...limits);
      context.span.rows.push(...rows);
    };
    const ok = setup("gateAndCommit", (_request, context) => {
      note(context);
      return commit.outcome;
    });
    const okTrace = traceFor(commit.request);
    await ok.api.call("gateAndCommit", commit.request, okTrace.trace);
    expect(onlySpan(okTrace.spans)).toMatchObject({ limits, rows });

    const refused = setup("gateAndCommit", (_request, context) => {
      note(context);
      return { error: "transient", sqlstate: "40P01" };
    });
    const refusedTrace = traceFor(commit.request);
    await refused.api.call("gateAndCommit", commit.request, refusedTrace.trace);
    const span = onlySpan(refusedTrace.spans);
    expect(span.limits).toEqual(limits);
    expect(span.rows).toBeUndefined();
  });

  it("a note that breaks K-08 is dropped, never the span, and never logged as it was", async () => {
    const { api } = setup("gateAndCommit", (_request, context) => {
      context.span.rows.push({ table: "phones", id: "+15555550100" });
      return commit.outcome;
    });
    const { trace, spans } = traceFor(commit.request);
    await api.call("gateAndCommit", commit.request, trace);
    const span = onlySpan(spans);
    expect(span.rows).toBeUndefined();
    expect(span.decided).toEqual({ answered: "response", notesRefused: true });
    expect(JSON.stringify(span)).not.toContain("+15555550100");
    expect(validator.checkSpan(span)).toEqual([]);
  });

  it("a span the trace refuses never changes the answer: it is reported by labels only", async () => {
    const reports: unknown[] = [];
    const scope = recordingScope();
    const paused = fixture("flag-paused.json") as Exchange;
    const api = createToolApi({
      validator,
      scope,
      handlers: recordingHandlers("setRecordFlag", () => paused.outcome),
      onSpanRefused: (report) => reports.push(report),
    });
    const { trace } = traceFor(paused.request);
    trace.end();
    expect(await api.call("setRecordFlag", paused.request, trace)).toEqual(paused.outcome);
    expect(reports).toEqual([{ traceId: "trace-page-sam-0140", call: "setRecordFlag", error: "TraceError" }]);
  });
});

describe("businessScopeOf", () => {
  it("runs the call's work in the database client's scoped transaction, on the primary", async () => {
    const tx = {} as Tx;
    const asked: unknown[] = [];
    const client = {
      withBusiness: <T>(businessId: string, fn: (inner: Tx) => Promise<T>, options?: unknown): Promise<T> => {
        asked.push({ businessId, options });
        return fn(tx);
      },
    };
    const result = await businessScopeOf(client).withBusiness("biz-lees-barbershop", (inner) =>
      Promise.resolve(inner === tx),
    );
    expect(result).toBe(true);
    expect(asked).toEqual([{ businessId: "biz-lees-barbershop", options: undefined }]);
  });
});
