// T-305: one commit per turn. gateAndCommit's commit half on the gate (T-298), through the Tool API base (T-290) with a
// recording scope, the gate's scripted limits (never the stubs changed) and the commit's port doubles (test-support.ts),
// with K-05 v1.1 commitTurn as an in-memory fake (T-306 runs it on PostgreSQL). Every K-05 request is held to K-05 v1.1's
// schema, every event-log entry to K-08 v1.1's, and every answer to K-09 v1's by the base's own validator.

import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import type { Span } from "../../../runtime/src/trace";
import {
  becomes,
  callContext,
  changePart,
  copy,
  fixtureScript,
  gateExchange,
  gateRequest,
  modelFixture,
  samKinds,
  scriptedLimits,
  twoRequests,
  wordsIn,
  type LimitCall,
  type Script,
} from "../gate/framework/test-support";
import type { Choice, DecidePart, DecideResult, Decided, GateRequest } from "../gate/framework";
import { createToolApi, createToolApiValidator } from "../tool-api";
import {
  contractFile,
  recordingHandlers,
  recordingScope,
  traceFor,
  type ScopeEvent,
} from "../tool-api/test-support";
import { CommitNotBuiltError, CommitRefusedError, defaultCommitDeps, gateAndCommit } from "./index";
import { holdClassOf, isHeld } from "./hold";
import {
  S1_02,
  contractChecks,
  doublePorts,
  effectAtCommit,
  eventLogRowsOf,
  k05Exchange,
  k05Fake,
  noWrites,
  s1_02CoreRun,
  s1_02K05Answer,
  s1_02SafetyOutcome,
  samKindsWrites,
  type Doubles,
} from "./test-support";
import type {
  CommitDeps,
  CommitTurnError,
  CommitTurnRequest,
  CoreRun,
  OutboxRowNew,
  SafetyHold,
  StateWrite,
  UnitWrites,
} from "./types";

const validator = createToolApiValidator();

interface Called {
  answer: unknown;
  events: ScopeEvent[];
  spans: Span[];
}

/** One gateAndCommit call through the Tool API base, its handler the commit with `deps`. */
async function callCommit(request: unknown, deps: CommitDeps): Promise<Called> {
  const scope = recordingScope();
  const handlers = recordingHandlers("gateAndCommit", (given, context) =>
    gateAndCommit(given as GateRequest, context, deps),
  );
  const api = createToolApi({ validator, scope, handlers });
  const { trace, spans } = traceFor(request);
  const answer = await api.call("gateAndCommit", request, trace);
  return { answer, events: scope.events, spans };
}

const whats = (events: readonly ScopeEvent[]): string[] => events.map((event) => event.what);

/** The one K-05 request the fake was sent, checked against K-05 v1.1 and its entries against K-08 v1.1. */
function onlyRequest(requests: readonly CommitTurnRequest[]): CommitTurnRequest {
  expect(requests).toHaveLength(1);
  const [request] = requests;
  if (request === undefined) throw new Error("no request");
  expect(contractChecks().k05("commitTurn.request", request)).toEqual([]);
  const rows = eventLogRowsOf(request, "2026-10-19T14:05:06Z");
  for (const row of rows) expect(contractChecks().k08("eventLogRow", row), String(row.id)).toEqual([]);
  if (rows.length > 0) expect(contractChecks().k08("eventLogBatch", { rows })).toEqual([]);
  return request;
}

/** Every id a request writes or logs (rows of every list and event-log entries). */
function idsIn(request: CommitTurnRequest): string[] {
  const { writes } = request;
  return [
    ...writes.state.map((write) => String(write.op === "insert" ? write.values.id : write.key.id)),
    ...writes.openQuestions.open.map((question) => question.id),
    ...writes.openQuestions.close.map((close) => close.id),
    ...writes.clockRows.make.map((clock) => String(clock.id)),
    ...writes.clockRows.cancel.map((cancel) => cancel.id),
    ...writes.outboxRows.map((row) => row.id),
    ...writes.events.flatMap((entry) => [entry.id, entry.rowId ?? ""]),
    ...(writes.effects?.write ?? []).map((effect) => String(effect.effectId)),
  ];
}

/** S1-02 as commit-s1-02.json states it: limits as its outcome logs them, its writes, its core action. */
function s1_02Deps(
  doubles: Doubles = {},
  calls: LimitCall[] = [],
): ReturnType<typeof doublePorts> & CommitDeps {
  const exchange = gateExchange(S1_02);
  const ported = doublePorts({ writes: { 0: samKindsWrites() }, core: [s1_02CoreRun()], ...doubles });
  return { ...ported, limits: scriptedLimits(fixtureScript(exchange), calls) };
}

// ---------------------------------------------------------------------------------------------------------------
// commit-s1-02.json: exactly one K-05 commit request

/** The K-05 request S1-02's turn commits: K-05 commit-first.json's form, with S1-02's writes and their entries. */
const S1_02_EVENT_BASE = {
  zone: "America/New_York",
  businessId: "biz-lees-barbershop",
  sealed: null,
  why: { step: "S1-02", choice: "All on the list" },
  proofs: null,
} as const;
const ROSIE = { actorKind: "rosie", actorPersonId: null, actorRole: null, approvedBy: null } as const;

function expectedS1_02Request(): CommitTurnRequest {
  const writes = samKindsWrites();
  return {
    turn: copy(gateExchange(S1_02).request.turn ?? fail()),
    versionsRead: [],
    writes: {
      state: copy([...writes.state]),
      openQuestions: { open: [copy(writes.asks[0]?.question ?? fail())], close: copy([...writes.closes]) },
      clockRows: {
        make: [
          {
            id: "clock-oq-s1-04-sam",
            kind: "question",
            openQuestionId: "oq-s1-04-sam",
            reservationId: null,
            handleId: "handle-sam",
            businessId: "biz-lees-barbershop",
            bookingId: null,
            fires: { step: "S1-04", safeDefault: null },
          },
        ],
        cancel: [{ id: "clock-oq-s1-02", expectVersion: 2 }],
      },
      outboxRows: copy([...writes.messages]),
      reservations: { confirm: [], release: [] },
      events: [
        {
          ...S1_02_EVENT_BASE,
          id: "log-oq-s1-02-answered",
          kind: "open_question.answered",
          actorKind: "person",
          actorPersonId: "person-sam",
          actorRole: "owner",
          tableName: "open_questions",
          rowId: "oq-s1-02",
          oldValues: null,
          newValues: { status: "answered", answered_option_id: null },
          approvedBy: {
            kind: "answer",
            open_question_id: "oq-s1-02",
            option_id: null,
            event_id: "evt-sam-0001",
          },
        },
        {
          ...S1_02_EVENT_BASE,
          ...ROSIE,
          id: "log-clock-oq-s1-02-cancelled",
          kind: "clock_row.cancelled",
          tableName: "clock_rows",
          rowId: "clock-oq-s1-02",
          oldValues: null,
          newValues: { state: "cancelled" },
        },
        {
          ...S1_02_EVENT_BASE,
          ...ROSIE,
          id: "log-oq-s1-04-sam-opened",
          kind: "open_question.opened",
          tableName: "open_questions",
          rowId: "oq-s1-04-sam",
          oldValues: null,
          newValues: { step: "S1-04", status: "waiting" },
        },
        {
          ...S1_02_EVENT_BASE,
          ...ROSIE,
          id: "log-clock-oq-s1-04-sam-created",
          kind: "clock_row.created",
          tableName: "clock_rows",
          rowId: "clock-oq-s1-04-sam",
          oldValues: null,
          newValues: { kind: "question", state: "waiting", open_question_id: "oq-s1-04-sam" },
        },
        {
          ...S1_02_EVENT_BASE,
          ...ROSIE,
          id: "log-out-s1-04-sam-created",
          kind: "outbox_row.created",
          tableName: "outbox_rows",
          rowId: "out-s1-04-sam",
          oldValues: null,
          newValues: { state: "planned", channel: "imessage", send_class: "quick_reply" },
        },
      ],
    },
  };
}

function fail(): never {
  throw new Error("fixture missing a value");
}

describe("commit-s1-02.json: the passed part becomes exactly one K-05 commit request under the turn id", () => {
  it("one open question, its unarmed clock row, one outbox row, their event-log rows, one turn id", async () => {
    const exchange = gateExchange(S1_02);
    const deps = s1_02Deps({ k05: k05Fake({ answers: [s1_02K05Answer()] }) });
    const called = await callCommit(copy(exchange.request), deps);

    // The answer is exactly the fixture's outcome, held to K-09 v1 by the base.
    expect(called.answer).toEqual(exchange.outcome);
    expect(whats(called.events)).toEqual(["begin", "scope", "read", "commit"]);

    const request = onlyRequest(deps.k05.requests);
    expect(request).toEqual(expectedS1_02Request());
    const { writes } = request;
    // One turn id: the turn row's, which the caller, the context and decide name too.
    expect(request.turn.id).toBe("turn-s1-02-sam-kinds");
    expect(new Set(writes.events.map(() => request.turn.id)).size).toBe(1);
    expect(writes.openQuestions.open.map((question) => question.id)).toEqual(["oq-s1-04-sam"]);
    expect(writes.clockRows.make).toHaveLength(1);
    expect(writes.clockRows.make[0]).not.toHaveProperty("due");
    expect(writes.outboxRows.map((row) => row.id)).toEqual(["out-s1-04-sam"]);
    expect(writes.outboxRows[0]).not.toHaveProperty("plan");
    expect(writes).not.toHaveProperty("effects");
    // K-05 commit-first.json's form: the same request and write lists.
    const commitFirst = k05Exchange("commit-first.json").request;
    expect(Object.keys(request).sort()).toEqual(Object.keys(commitFirst).sort());
    expect(Object.keys(writes).sort()).toEqual(Object.keys(commitFirst.writes).sort());

    // The span keeps the rows written, tables and ids only, and no words of the text.
    const [span] = called.spans;
    expect(validator.checkSpan(span)).toEqual([]);
    expect(span?.rows).toEqual([
      { table: "picked_kinds", id: "pick-sam-barbershop" },
      { table: "picked_kinds", id: "pick-sam-plumbing" },
      { table: "picked_kinds", id: "pick-sam-electrical" },
      { table: "outbox_rows", id: "out-s1-04-sam" },
    ]);
    const decided = exchange.request.input.kind === "decided" ? exchange.request.input.decided : fail();
    for (const words of wordsIn(decided)) expect(JSON.stringify(span)).not.toContain(words);
  });

  it("the K-05 fake answers K-05 v1's own commit fixtures as the database does", async () => {
    for (const [file, nextCommitSeq] of [
      ["commit-first.json", 1],
      ["commit-opens-question.json", 1],
      ["commit-writes-effect.json", 1],
      ["commit-lets-go-outage-effect.json", 3],
    ] as const) {
      const exchange = k05Exchange(file);
      const fake = k05Fake({ now: exchange.given.now, nextCommitSeq });
      expect(await fake.commitTurn(exchange.request, callContext()), file).toEqual(exchange.outcome);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A repeated turn id

describe("repeating the same turn id returns the first result and writes nothing", () => {
  it("commit-repeat-same-turn.json against the K-05 fake", async () => {
    const first = k05Exchange("commit-first.json");
    const repeat = k05Exchange("commit-repeat-same-turn.json");
    const fake = k05Fake({ now: first.given.now });
    await fake.commitTurn(first.request, callContext());
    expect(await fake.commitTurn(repeat.request, callContext())).toEqual(repeat.outcome);
    expect(fake.commits).toHaveLength(1);
  });

  it("S1-02's turn run again (a lost reply): the same request, the first commit back, nothing written", async () => {
    const exchange = gateExchange(S1_02);
    const k05 = k05Fake();
    const firstRun = await callCommit(copy(exchange.request), s1_02Deps({ k05 }));
    const secondRun = await callCommit(copy(exchange.request), s1_02Deps({ k05 }));
    expect(k05.requests).toHaveLength(2);
    expect(k05.requests[1]).toEqual(k05.requests[0]);
    expect(k05.commits).toHaveLength(1);

    const first = firstRun.answer as { committedAt: string; written: { outboxRows: unknown } };
    expect(firstRun.answer).toMatchObject({ result: "committed", repeated: false });
    expect(secondRun.answer).toMatchObject({
      result: "committed",
      turnId: "turn-s1-02-sam-kinds",
      committedAt: first.committedAt,
      repeated: true,
      written: { written: [], outboxRows: first.written.outboxRows, promoted: [] },
      effects: [],
      openQuestions: { opened: [], closed: [] },
    });
    expect(validator.check("gateAndCommit", "response", secondRun.answer)).toEqual([]);
    // The span keeps the rows a call wrote: the first run's (as K-05 answered them), and none for the repeat.
    const written = k05.commits[0]?.written ?? fail();
    expect(firstRun.spans[0]?.rows).toEqual([
      ...written.map((row) => ({ table: row.table, id: row.rowId })),
      { table: "outbox_rows", id: "out-s1-04-sam" },
    ]);
    expect(secondRun.spans[0]?.rows).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A refused part writes no row of its own

/** What one owner-hub part of the two requests writes: a state write and a reply, under ids of its own. */
function hubWrites(choice: string, step: string): UnitWrites {
  const state: StateWrite = {
    op: "insert",
    table: "busy_blocks",
    values: { id: `state-${choice}`, business_id: "biz-lee-home-services" },
  };
  const row: OutboxRowNew = {
    id: `out-${choice}-sam`,
    recipientHandleId: "handle-test-0001",
    recipientPersonId: "person-sam",
    businessId: "biz-lee-home-services",
    bookingId: null,
    channel: "imessage",
    sendClass: "quick_reply",
    openQuestionId: null,
    copyOfRowId: null,
    versionsRead: [],
  };
  return { ...noWrites({ step, choice }), state: [state], messages: [row] };
}

describe("a part refused by the gate writes no row of its own while a passed part in the same turn commits", () => {
  it("decide-two-requests.json, part 2 stopped by limit 2", async () => {
    const request = gateRequest(twoRequests());
    const script: Script = {
      1: { 2: { result: "fail", outcome: { limit: 2, outcome: "refuse", action: "saidWhatRuleAllows" } } },
    };
    const writes = { 0: hubWrites("block", "S11-12"), 1: hubWrites("settings", "S11-12") };
    const ported = doublePorts({ writes });
    const called = await callCommit(request, { limits: scriptedLimits(script), ports: ported.ports });

    expect(called.answer).toMatchObject({
      result: "committed",
      parts: [
        { part: 0, result: "committed" },
        {
          part: 1,
          result: "stopped",
          stoppedBy: { limit: 2, outcome: "refuse", action: "saidWhatRuleAllows" },
        },
      ],
    });
    expect(ported.calls.writesOf).toEqual([0]);
    const sent = onlyRequest(ported.k05.requests);
    expect(sent.writes.outboxRows.map((row) => row.id)).toEqual(["out-block-sam"]);
    expect(idsIn(sent).filter((id) => id.includes("settings"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Effect rows and their keys

describe("every effect row carries an idempotency key", () => {
  it("refuse-effect-without-key.json is refused: nothing goes to K-05 and the call rolls back", async () => {
    const keyless = effectAtCommit("invalid/refuse-effect-without-key.json");
    expect(keyless).not.toHaveProperty("idempotencyKey");
    const writes = { ...samKindsWrites(), effects: { write: [keyless], letGo: [] } };
    const deps = s1_02Deps({ writes: { 0: writes } });

    const refused = gateAndCommit(copy(gateExchange(S1_02).request), callContext(), deps);
    await expect(refused).rejects.toMatchObject({
      name: "CommitRefusedError",
      fault: "effectWithoutKey",
      ids: ["eff-alex-grooms-deposit"],
    });
    const scope = recordingScope();
    const api = createToolApi({
      validator,
      scope,
      handlers: recordingHandlers("gateAndCommit", (given, context) =>
        gateAndCommit(given as GateRequest, context, s1_02Deps({ writes: { 0: writes }, k05: deps.k05 })),
      ),
    });
    const request = copy(gateExchange(S1_02).request);
    await expect(api.call("gateAndCommit", request, traceFor(request).trace)).rejects.toBeInstanceOf(
      CommitRefusedError,
    );
    expect(whats(scope.events).at(-1)).toBe("rollback");
    expect(deps.k05.requests).toEqual([]);

    // K-05 v1.1's schema refuses the same row: code and contract agree.
    const asSent = { ...expectedS1_02Request() };
    asSent.writes = { ...asSent.writes, effects: { write: [keyless], letGo: [] } };
    expect(contractChecks().k05("commitTurn.request", asSent)).not.toEqual([]);
  });

  it("effect-charge.json's row, on its key, is written pending with its entry, approved by the answer", async () => {
    const charge = effectAtCommit("effect-charge.json");
    const writes = { ...samKindsWrites(), effects: { write: [charge], letGo: [] } };
    const deps = s1_02Deps({ writes: { 0: writes } });
    const called = await callCommit(copy(gateExchange(S1_02).request), deps);

    expect(called.answer).toMatchObject({
      effects: [{ effectId: "eff-alex-grooms-deposit", kind: "stripe_charge" }],
    });
    const request = onlyRequest(deps.k05.requests);
    expect(request.writes.effects).toEqual({ write: [charge], letGo: [] });
    expect(request.writes.effects?.write[0]?.idempotencyKey).toBe("eff-alex-grooms-deposit");
    expect(request.writes.events.find((entry) => entry.kind === "effect.created")).toMatchObject({
      rowId: "eff-alex-grooms-deposit",
      newValues: { kind: "stripe_charge", state: "pending" },
      approvedBy: { kind: "answer", open_question_id: "oq-s1-02", event_id: "evt-sam-0001" },
    });
  });

  it("two effect rows on one key are refused", async () => {
    const charge = effectAtCommit("effect-charge.json");
    const twin = { ...charge, effectId: "eff-alex-grooms-deposit-2" };
    const writes = { ...samKindsWrites(), effects: { write: [charge, twin], letGo: [] } };
    const deps = s1_02Deps({ writes: { 0: writes } });
    await expect(gateAndCommit(copy(gateExchange(S1_02).request), callContext(), deps)).rejects.toMatchObject(
      {
        fault: "effectKeyTwice",
        ids: ["eff-alex-grooms-deposit-2"],
      },
    );
    expect(deps.k05.requests).toEqual([]);
  });

  it("K-05's refused commits are refused by code first: an outbox row with a plan, a state write to reservations", async () => {
    const withPlan = (
      contractFile("data-access/fixtures/invalid/refuse-commit-outbox-with-plan.json") as CommitTurnRequest
    ).writes.outboxRows[0];
    const toReservations = (
      contractFile(
        "data-access/fixtures/invalid/refuse-commit-state-write-to-reservations.json",
      ) as CommitTurnRequest
    ).writes.state[0];
    if (withPlan === undefined || toReservations === undefined) throw new Error("fixtures changed");
    for (const [writes, fault] of [
      [{ ...samKindsWrites(), messages: [withPlan] }, "outboxRowWithPlan"],
      [{ ...samKindsWrites(), state: [toReservations] }, "stateTable"],
    ] as const) {
      const deps = s1_02Deps({ writes: { 0: writes } });
      await expect(
        gateAndCommit(copy(gateExchange(S1_02).request), callContext(), deps),
      ).rejects.toMatchObject({
        fault,
      });
      expect(deps.k05.requests).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The time budget

/** Arch 04 line 223: "Gate and commit ≤ 300 ms". */
const GATE_AND_COMMIT_MS = 300;
/**
 * The database's share of it: no source gives one, so the default is the budget of a turn's other round of uncached
 * primary reads, "Build the frontier (uncached reads) ≤ 150 ms" (arch 04 line 215).
 */
const DATABASE_MS = 150;

describe("gate plus request building stays under 300 ms minus the database budget, on the fake", () => {
  it("commit-s1-02.json, 20 runs after a warm-up, each under 150 ms", async () => {
    const request = gateExchange(S1_02).request;
    const run = async (): Promise<number> => {
      const deps = s1_02Deps();
      const started = performance.now();
      await gateAndCommit(copy(request), callContext("biz-lees-barbershop"), deps);
      return performance.now() - started;
    };
    await run();
    const times: number[] = [];
    for (let each = 0; each < 20; each += 1) times.push(await run());
    expect(Math.max(...times)).toBeLessThan(GATE_AND_COMMIT_MS - DATABASE_MS);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The defaults T-305 holds to: the bundle pin, safety holds, one question first

describe("a commit naming another bundle than the turn's pin is refused (CQ-72's default 2)", () => {
  it("answers bundleMismatch before any limit runs, and nothing is written", async () => {
    const request = copy(gateExchange(S1_02).request);
    if (request.input.kind !== "decided") throw new Error("decided texts expected");
    request.input.decided.context.bundleId = {
      hash: "5bc63b09b605d99a676e32fd75a88ca0c72b921f3b5ccb50688db7a0e4f98f82",
      build: 1,
    };
    const calls: LimitCall[] = [];
    const deps = s1_02Deps({}, calls);
    const called = await callCommit(request, deps);
    expect(called.answer).toEqual({
      error: "bundleMismatch",
      turnBundleId: request.turn?.bundleId,
      givenBundleId: request.input.decided.context.bundleId,
    });
    expect(calls).toEqual([]);
    expect(deps.k05.requests).toEqual([]);
    expect(whats(called.events).at(-1)).toBe("rollback");
  });
});

/** A hold on Sam's routine actions, as K-09 v1's safety-outcome-hold.json gives one (A3-48: never released). */
const NEVER_HOLD: SafetyHold = { holdId: "hold-sam-0001", releaseRule: "never", blocksBooking: false };
const AFTER_SAFE_HOLD: SafetyHold = {
  holdId: "hold-sam-0002",
  releaseRule: "after_safe",
  blocksBooking: false,
};

/** Sam's text's safety outcome when it opens a hold: safety-outcome-hold.json's answer, with its checked line's row. */
function holdingSafetyOutcome(): CoreRun {
  const response = (contractFile("tool-api/fixtures/safety-outcome-hold.json") as { outcome: unknown })
    .outcome;
  const result = { ...s1_02SafetyOutcome(), response } as CoreRun["result"];
  const line: OutboxRowNew = {
    id: "out-alex-threat-line",
    recipientHandleId: "handle-alex",
    recipientPersonId: "person-alex",
    businessId: "biz-lees-barbershop",
    bookingId: "booking-alex-riley-nov14",
    channel: "imessage",
    sendClass: "safety",
    openQuestionId: null,
    copyOfRowId: null,
    versionsRead: [],
  };
  return { result, writes: { ...noWrites({ step: "A3-48", choice: null }), messages: [line] } };
}

describe("parts under a safety hold are held back before the gate (CQ-65's replaced default)", () => {
  it("a hold open on the handle, read at commit time: the routine part is held, no limit runs for it", async () => {
    const calls: LimitCall[] = [];
    const deps = s1_02Deps({ holds: [AFTER_SAFE_HOLD] }, calls);
    const called = await callCommit(copy(gateExchange(S1_02).request), deps);
    expect(called.answer).toMatchObject({
      result: "committed",
      parts: [{ part: 0, choiceId: "c-01", result: "held", stoppedBy: null, gives: [], dependsOnPart: null }],
      openQuestions: { opened: [], closed: [] },
    });
    const [part] = (called.answer as { parts: { limits: { result: string }[] }[] }).parts;
    expect(part?.limits.every((limit) => limit.result === "notChecked")).toBe(true);
    expect(calls).toEqual([]);
    expect(deps.calls.openHolds).toBe(1);
    expect(deps.calls.writesOf).toEqual([]);
    expect(idsIn(onlyRequest(deps.k05.requests))).toEqual([]);
  });

  it("a hold this turn's own safety outcome opens binds the same commit: its line commits, the routine part is held", async () => {
    const deps = s1_02Deps({ core: [holdingSafetyOutcome()] });
    const called = await callCommit(copy(gateExchange(S1_02).request), deps);
    expect(called.answer).toMatchObject({ parts: [{ part: 0, result: "held" }] });
    expect(deps.calls.writesOf).toEqual([]);
    const request = onlyRequest(deps.k05.requests);
    expect(request.writes.outboxRows.map((row) => row.id)).toEqual(["out-alex-threat-line"]);
    expect(request.writes.state).toEqual([]);
  });

  it("each core action is handed the holds in force: the handle's, and those the core actions before it opened", async () => {
    const request = copy(gateExchange(S1_02).request);
    const [safety] = request.core;
    if (safety === undefined) throw new Error("commit-s1-02 carries one core action");
    request.core = [safety, copy(safety)];
    const deps = s1_02Deps({ holds: [AFTER_SAFE_HOLD], core: [holdingSafetyOutcome(), s1_02CoreRun()] });
    await callCommit(request, deps);
    expect(deps.calls.coreHolds).toEqual([["hold-sam-0002"], ["hold-sam-0002", "hold-alex-0204"]]);
  });

  it("only protective changes pass a threat's hold; the safety flow passes every other hold", () => {
    const decided = samKinds();
    const [option, , , , danger] = decided.context.choices;
    if (danger === undefined) throw new Error("context-s1-02 changed");
    const stopRow: Choice = { ...danger, anytimeRow: "stop", step: "A7-11", choiceId: "c-90" };
    const weAreSafe: Choice = { ...option, step: "A3-24", choiceId: "c-91" };
    const threatPause: Choice = { ...option, step: "A3-48", choiceId: "c-92" };
    const { part } = decided.decide.parts[0];
    const enter: DecidePart = { verb: "enter", quote: part.quote, choice: danger.choiceId, fields: [] };
    const partOf = (file: string): DecidePart => (modelFixture(file) as DecideResult).parts[0].part;
    const table: [string, ReturnType<typeof holdClassOf>][] = [
      ["an open question's option", holdClassOf(part, option)],
      ["the danger row", holdClassOf(enter, danger)],
      ["the stop row", holdClassOf(enter, stopRow)],
      ["a 'we're safe' answer", holdClassOf(part, weAreSafe)],
      ["the threat's pause", holdClassOf(part, threatPause)],
      ["a hand-off", holdClassOf(partOf("decide-hand-off.json"), null)],
      ["a pass-on", holdClassOf(partOf("decide-pass-on.json"), null)],
      ["a no-op", holdClassOf(partOf("decide-no-op-thanks.json"), null)],
    ];
    expect(table).toEqual([
      ["an open question's option", "routine"],
      ["the danger row", "safetyFlow"],
      ["the stop row", "protective"],
      ["a 'we're safe' answer", "safetyFlow"],
      ["the threat's pause", "protective"],
      ["a hand-off", "protective"],
      ["a pass-on", "routine"],
      ["a no-op", "none"],
    ]);
    expect(isHeld("routine", [])).toBe(false);
    expect(isHeld("routine", [AFTER_SAFE_HOLD])).toBe(true);
    expect(isHeld("safetyFlow", [AFTER_SAFE_HOLD])).toBe(false);
    expect(isHeld("safetyFlow", [AFTER_SAFE_HOLD, NEVER_HOLD])).toBe(true);
    expect(isHeld("protective", [NEVER_HOLD])).toBe(false);
    expect(isHeld("none", [NEVER_HOLD])).toBe(false);
  });

  it("under a threat's hold, a STOP entered in the turn commits", async () => {
    const decided = samKinds();
    const danger = decided.context.choices[4] ?? fail();
    decided.context.choices[4] = { ...danger, anytimeRow: "stop", step: "A7-11" };
    const stop = changePart(decided, 0, (part) => {
      becomes(part, { verb: "enter", quote: part.quote, choice: danger.choiceId, fields: [] });
    });
    const request = gateRequest(stop);
    expect(validator.check("gateAndCommit", "request", request)).toEqual([]);
    const ported = doublePorts({ holds: [NEVER_HOLD] });
    const called = await callCommit(request, { limits: scriptedLimits(), ports: ported.ports });
    expect(called.answer).toMatchObject({
      parts: [{ part: 0, choiceId: danger.choiceId, result: "committed" }],
    });
    expect(ported.calls.writesOf).toEqual([0]);
  });
});

/** The two requests, both about one booking, with part 1 (or part 0) ended in one question. */
function twoOnOneBooking(bookingOfSecond: string): Decided {
  const decided = twoRequests();
  const target = { businessId: "biz-lees-barbershop", businessName: "Lee's Barbershop", visitAt: null };
  for (const choice of decided.context.choices) {
    choice.target = {
      ...target,
      bookingId: choice.choiceId === "c-04" ? bookingOfSecond : "booking-alex-haircut",
    };
  }
  decided.decide.parts[0].outcome = "oneQuestion";
  return decided;
}

describe("a go part on the booking of a part ended in one question waits (CQ-73's default)", () => {
  it("answered asked, never written; a part on another booking commits", async () => {
    for (const [booking, result, written] of [
      ["booking-alex-haircut", "asked", []],
      ["booking-alex-riley-nov14", "committed", [1]],
    ] as const) {
      const ported = doublePorts({ writes: { 1: hubWrites("settings", "S11-12") } });
      const called = await callCommit(gateRequest(twoOnOneBooking(booking)), {
        limits: scriptedLimits(),
        ports: ported.ports,
      });
      expect(called.answer, booking).toMatchObject({
        parts: [
          { part: 0, result: "asked" },
          { part: 1, result, gives: [] },
        ],
      });
      expect(ported.calls.writesOf, booking).toEqual(written);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Failing closed, and the rest of K-09's answers

describe("the commit fails closed", () => {
  it("the shipped wiring (the stub limits, no port built) answers notBuilt and writes nothing", async () => {
    const called = await callCommit(copy(gateExchange(S1_02).request), defaultCommitDeps());
    expect(called.answer).toEqual({ error: "notBuilt", call: "gateAndCommit" });
    expect(whats(called.events).at(-1)).toBe("rollback");

    const ported = doublePorts({ writes: { 0: samKindsWrites() }, core: [s1_02CoreRun()] });
    const stubs = await callCommit(copy(gateExchange(S1_02).request), {
      limits: defaultCommitDeps().limits,
      ports: ported.ports,
    });
    expect(stubs.answer).toEqual({ error: "notBuilt", call: "gateAndCommit" });
    expect(ported.k05.requests).toEqual([]);
  });

  it("a clock's firing and the planner's verbs are not built here", async () => {
    const clock = gateExchange("clock-staff-invite-48h.json").request;
    await expect(gateAndCommit(copy(clock), callContext(), s1_02Deps())).rejects.toMatchObject({
      seam: "clockFiring",
    });
    const called = await callCommit(copy(clock), s1_02Deps());
    expect(called.answer).toEqual({ error: "notBuilt", call: "gateAndCommit" });

    const planned = gateRequest(twoRequests()) as unknown as { input: { planner: unknown } };
    planned.input.planner = { output: modelFixture("planner-answer.json"), parts: [0] };
    expect(validator.check("gateAndCommit", "request", planned)).toEqual([]);
    const deps = s1_02Deps();
    await expect(gateAndCommit(planned as GateRequest, callContext(), deps)).rejects.toBeInstanceOf(
      CommitNotBuiltError,
    );
    expect(await callCommit(planned, deps)).toMatchObject({ answer: { error: "notBuilt" } });
    expect(deps.k05.requests).toEqual([]);
  });

  it("a call naming another turn than its turn row is refused", async () => {
    const request = copy(gateExchange(S1_02).request);
    request.caller.turnId = "turn-s1-01-sam";
    const deps = s1_02Deps();
    await expect(gateAndCommit(request, callContext(), deps)).rejects.toMatchObject({
      fault: "turnIdMismatch",
    });
    expect(deps.k05.requests).toEqual([]);
  });

  it("a version conflict reloads once and gates again; a second one commits nothing", async () => {
    const changed: CommitTurnError = {
      error: "versionChanged",
      changed: [{ table: "open_questions", rowId: "oq-s1-02", readVersion: 2, currentVersion: 3 }],
    };
    const calls: LimitCall[] = [];
    const once = s1_02Deps(
      { k05: k05Fake({ answers: [changed, null] }), core: [s1_02CoreRun(), s1_02CoreRun()] },
      calls,
    );
    const called = await callCommit(copy(gateExchange(S1_02).request), once);
    expect(called.answer).toMatchObject({ result: "committed", repeated: false });
    expect(calls.filter((call) => call.limit === 1)).toHaveLength(2);
    expect(once.k05.commits).toHaveLength(1);

    const twice = s1_02Deps({
      k05: k05Fake({ answers: [changed, changed] }),
      core: [s1_02CoreRun(), s1_02CoreRun()],
    });
    await expect(
      gateAndCommit(copy(gateExchange(S1_02).request), callContext(), twice),
    ).rejects.toMatchObject({
      fault: "stillChanged",
      ids: ["oq-s1-02"],
    });
    expect(twice.k05.commits).toEqual([]);
  });

  it("a parked turn, a database rule and a transient failure come back as K-09's errors, rolled back", async () => {
    for (const error of [
      { error: "turnParked", turnId: "turn-s1-02-sam-kinds", parkedAt: "2026-10-19T14:05:06Z" },
      { error: "constraint", sqlstate: "23505", constraint: "outbox_rows_pkey" },
      { error: "transient", sqlstate: "40001" },
    ] as const) {
      const called = await callCommit(
        copy(gateExchange(S1_02).request),
        s1_02Deps({ k05: k05Fake({ answers: [error] }) }),
      );
      expect(called.answer).toEqual(error);
      expect(whats(called.events).at(-1)).toBe("rollback");
    }
  });

  it("what the commit throws names faults and ids, never the text's words", async () => {
    const exchange = gateExchange(S1_02);
    const writes = {
      ...samKindsWrites(),
      effects: { write: [effectAtCommit("invalid/refuse-effect-without-key.json")], letGo: [] },
    };
    const error = await gateAndCommit(
      copy(exchange.request),
      callContext(),
      s1_02Deps({ writes: { 0: writes } }),
    ).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(CommitRefusedError);
    const decided = exchange.request.input.kind === "decided" ? exchange.request.input.decided : fail();
    for (const words of [...wordsIn(decided), "Barbershop", "plumbing", "electrical"]) {
      expect((error as Error).message).not.toContain(words);
    }
  });
});
