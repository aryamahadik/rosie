// T-1139: the commit's walk for bundle v0 (writesOf). ADR-013 section 6's proof: commit-s1-01.json's part (entering c-01,
// the sign-up door) gives exactly the rows its given.stated.writes states, field for field (K-09 v1.5 default 136), with
// default 131's ids for its turn key sam; it gives exactly thread; with no service and chatId on the request's turn it
// fails closed (default 135); the walk stops at S1-02's question; S1-02's branches walk only as far as bundle v0 holds
// them; an open safety hold stops the walk at its first routine row; the same part twice gives the same writes; a step
// or branch the bundle lacks is refused, never guessed. The walk reads K-01 v1's bundle-v0-skeleton.json through its
// bundles port (the one double), and every row is held to K-05 v1.1's and K-08 v1.1's schemas.

import { describe, expect, it } from "vitest";

import { copy } from "../../gate/framework/test-support";
import { buildCommitRequest, questionClock } from "../build";
import { contractChecks, eventLogRowsOf } from "../test-support";
import type { CommitTurnContext, OpenHolds, PassedPart, UnitWrites } from "../types";
import {
  MAX_WALK,
  WalkNotBuiltError,
  WalkRefusedError,
  createWritesOf,
  firstHeld,
  flowGraphOf,
  flowOfStep,
  walkFrom,
  type FlowLetter,
  type WalkFault,
  type WalkSeam,
} from "./index";
import {
  NOTHING_OPEN,
  SAM,
  branchIn,
  flowA,
  hold,
  requestTurnFields,
  skeletonBundles,
  stepIn,
  turnOne,
  turnTwo,
  type WalkTestRepo,
} from "./test-support";

type Graph = ReturnType<typeof flowA>;

/** The walk's writesOf over bundle v0 (or a changed copy of its flow A), with commit-s1-01.json's turn key, sam. */
function writesOf(graph: Graph = flowA()) {
  const { bundles, reads } = skeletonBundles({ A: graph });
  return { writesOf: createWritesOf<WalkTestRepo>({ bundles, turnKey: () => SAM }), reads };
}

/** Turn 1's writes: commit-s1-01.json's part on bundle v0. */
async function turnOneWrites(open: OpenHolds = NOTHING_OPEN, graph: Graph = flowA()): Promise<UnitWrites> {
  const { part, context } = turnOne();
  return writesOf(graph).writesOf(part, context, open);
}

/** What a run threw, or null. */
async function thrownBy(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => null,
    (error: unknown) => error,
  );
}

/** What turn 1's walk threw on a changed copy of flow A, or null. */
async function turnOneOn(change: (graph: Graph) => void): Promise<unknown> {
  const graph = flowA();
  change(graph);
  return thrownBy(turnOneWrites(NOTHING_OPEN, graph));
}

function thrownBySync(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

/** Expects a refusal with this fault and these ids. */
function expectRefused(error: unknown, fault: WalkFault, ids: readonly string[] = []): void {
  expect(error).toBeInstanceOf(WalkRefusedError);
  expect(error).toMatchObject({ fault, ids });
}

/** Expects notBuilt for this seam and these ids. */
function expectNotBuilt(error: unknown, seam: WalkSeam, ids: readonly string[] = []): void {
  expect(error).toBeInstanceOf(WalkNotBuiltError);
  expect(error).toMatchObject({ seam, ids, call: "gateAndCommit" });
}

/** Every list empty: the part writes nothing. */
function expectNothingWritten(writes: UnitWrites): void {
  expect(writes).toEqual({
    why: writes.why,
    versionsRead: [],
    state: [],
    stateEvents: [],
    asks: [],
    closes: [],
    clockCancels: [],
    messages: [],
    reservations: { confirm: [], release: [] },
    effects: { write: [], letGo: [] },
    gives: [],
  });
}

// ---------------------------------------------------------------------------------------------------------------
// commit-s1-01.json: turn 1, the sign-up door to S1-01

describe("commit-s1-01.json's part: the walk after entering the sign-up door", () => {
  it("gives exactly the rows its given.stated.writes states, field for field, with default 131's ids for sam", async () => {
    const { exchange } = turnOne();
    const stated = exchange.given.stated.writes;
    const writes = await turnOneWrites();
    expect(writes.state).toEqual(stated.state);
    expect(writes.asks.map((ask) => ask.question)).toEqual(stated.openQuestions);
    expect(writes.messages).toEqual(stated.outboxRows);
    // Nothing else: no close, no cancel, no reservation, no effect, no row read.
    expect(writes).toEqual({
      why: writes.why,
      versionsRead: [],
      state: stated.state,
      stateEvents: writes.stateEvents,
      asks: writes.asks,
      closes: [],
      clockCancels: [],
      messages: stated.outboxRows,
      reservations: { confirm: [], release: [] },
      effects: { write: [], letGo: [] },
      gives: writes.gives,
    });
    expect([
      ...writes.state.map((write) => (write.op === "insert" ? write.values.id : null)),
      ...writes.asks.map((ask) => ask.question.id),
      ...writes.messages.map((row) => row.id),
    ]).toEqual(["thread-s1-01-sam-1", "oq-s1-02-sam-1", "outbox-s1-02-sam-1"]);
  });

  it("writes each row in K-05 v1's own write shape", async () => {
    const writes = await turnOneWrites();
    const checks = contractChecks();
    for (const write of writes.state) expect(checks.k05("stateWrite", write)).toEqual([]);
    for (const ask of writes.asks) expect(checks.k05("openQuestionNew", ask.question)).toEqual([]);
    for (const row of writes.messages) expect(checks.k05("outboxRowNew", row)).toEqual([]);
  });

  it("its state: S1-01's thread insert (handle-sam, chat, no booking, the request turn's chatId, no reply address)", async () => {
    const { exchange, context } = turnOne();
    const writes = await turnOneWrites();
    expect(writes.state).toEqual([
      {
        op: "insert",
        table: "threads",
        values: {
          id: "thread-s1-01-sam-1",
          handle_id: context.turn.handleId,
          kind: "chat",
          booking_id: null,
          linq_chat_id: requestTurnFields(exchange.request).chatId,
          reply_address: null,
        },
      },
    ]);
    expect(context.turn.handleId).toBe("handle-sam");
  });

  it("its asked question: S1-02's (Sam, Lee's Barbershop, no options, clock null), with S1-02's safe default for its clock row", async () => {
    const { exchange } = turnOne();
    const writes = await turnOneWrites();
    expect(writes.asks).toHaveLength(1);
    const [ask] = writes.asks;
    if (ask === undefined) throw new Error("one ask");
    expect(ask.question).toEqual({
      id: "oq-s1-02-sam-1",
      handleId: "handle-sam",
      personId: "person-sam",
      businessId: "biz-lees-barbershop",
      bookingId: null,
      step: "S1-02",
      options: [],
      readback: null,
      versionsRead: [],
      clock: null,
    });
    // S1-02's card's safe default, as bundle v0 holds it.
    const card = stepIn(flowA(), "S1-02").card as { safeDefault: string };
    expect(ask.safeDefault).toBe(card.safeDefault);
    // The commit's own clock row for it (T-305's questionClock), which the fixture's commit wrote.
    expect(questionClock(ask.question, ask.safeDefault)).toEqual({
      id: "clock-oq-s1-02-sam-1",
      kind: "question",
      openQuestionId: "oq-s1-02-sam-1",
      reservationId: null,
      handleId: "handle-sam",
      businessId: "biz-lees-barbershop",
      bookingId: null,
      fires: { step: "S1-02", safeDefault: "draft it as new work, offline until Rosie's team reviews it." },
    });
    expect(exchange.outcome.written.written.map((row) => row.rowId)).toContain("clock-oq-s1-02-sam-1");
  });

  it("its message: outbox-s1-02-sam-1 to Sam at Lee's Barbershop, on the request turn's service, quick_reply, no plan", async () => {
    const { exchange } = turnOne();
    const writes = await turnOneWrites();
    expect(writes.messages).toEqual([
      {
        id: "outbox-s1-02-sam-1",
        recipientHandleId: "handle-sam",
        recipientPersonId: "person-sam",
        businessId: "biz-lees-barbershop",
        bookingId: null,
        channel: requestTurnFields(exchange.request).service,
        sendClass: "quick_reply",
        openQuestionId: "oq-s1-02-sam-1",
        copyOfRowId: null,
        versionsRead: [],
      },
    ]);
    // K-05 v1 outboxRowNew's fields and nothing else: no plan, no final parts (arch 01 line 41).
    expect(Object.keys(writes.messages[0] ?? {}).sort()).toEqual(
      [
        "id",
        "recipientHandleId",
        "recipientPersonId",
        "businessId",
        "bookingId",
        "channel",
        "sendClass",
        "openQuestionId",
        "copyOfRowId",
        "versionsRead",
      ].sort(),
    );
  });

  it("gives exactly thread, as the fixture states it and its outcome's part answers", async () => {
    const { exchange } = turnOne();
    const writes = await turnOneWrites();
    expect(writes.gives).toEqual(["thread"]);
    expect(writes.gives).toEqual(exchange.given.stated.gives);
    expect(writes.gives).toEqual(exchange.outcome.parts[0]?.gives);
  });

  it("logs the thread as thread.created, its values the kind alone, never the chat id; the unit's why is S1-01's door", async () => {
    const { exchange } = turnOne();
    const writes = await turnOneWrites();
    expect(writes.why).toEqual({ step: "S1-01", choice: "Business onboarding" });
    expect(writes.stateEvents).toEqual([
      {
        id: "log-thread-s1-01-sam-1-created",
        kind: "thread.created",
        zone: "America/New_York",
        businessId: null,
        actorKind: "rosie",
        actorPersonId: null,
        actorRole: null,
        tableName: "threads",
        rowId: "thread-s1-01-sam-1",
        oldValues: null,
        newValues: { kind: "chat" },
        sealed: null,
        why: { step: "S1-01", choice: "Business onboarding" },
        approvedBy: null,
        proofs: null,
      },
    ]);
    const chatId = String(requestTurnFields(exchange.request).chatId);
    expect(JSON.stringify(writes.stateEvents)).not.toContain(chatId);
  });

  it("stops at S1-02's question: S1-01 walked, then S1-02 asks, and nothing of the steps after it", async () => {
    const walked = walkFrom(flowGraphOf(flowA(), "A"), { kind: "step", step: "S1-01" });
    expect(walked.moves.map((move) => (move.kind === "step" ? move.step.id : move.split.id))).toEqual([
      "S1-01",
    ]);
    expect(walked.stop.kind).toBe("asks");
    expect(walked.stop.kind === "asks" ? walked.stop.step.id : null).toBe("S1-02");
    const writes = await turnOneWrites();
    expect(writes.asks.map((ask) => ask.question.step)).toEqual(["S1-02"]);
    expect(writes.messages.map((row) => row.openQuestionId)).toEqual(["oq-s1-02-sam-1"]);
    const steps = JSON.stringify(writes);
    for (const later of ["S1-11", "S1-04", "s1-11", "s1-04"]) expect(steps).not.toContain(later);
  });

  it("goes into the commit's one K-05 request as it is: K-05 v1.1 and K-08 v1.1 take it, and it writes the fixture's rows", async () => {
    const { exchange, context } = turnOne();
    const writes = await turnOneWrites();
    const request = buildCommitRequest({
      turn: context.turn,
      zone: "America/New_York",
      businessId: context.businessId,
      actor: { personId: exchange.request.caller.personId, roleAt: () => null },
      units: [{ writes, answer: null }],
    });
    const checks = contractChecks();
    expect(checks.k05("commitTurn.request", request)).toEqual([]);
    const rows = eventLogRowsOf(request, "2026-10-19T18:05:05Z");
    for (const row of rows) expect(checks.k08("eventLogRow", row), String(row.id)).toEqual([]);
    expect(checks.k08("eventLogBatch", { rows })).toEqual([]);
    // The rows commit-s1-01.json's commit wrote: the thread, the question, its clock row, and the one outbox row.
    const versioned = [
      ...request.writes.state.map((write) => String(write.op === "insert" ? write.values.id : write.key.id)),
      ...request.writes.openQuestions.open.map((question) => question.id),
      ...request.writes.clockRows.make.map((clock) => String(clock.id)),
    ];
    expect(versioned).toEqual(exchange.outcome.written.written.map((row) => row.rowId));
    expect(request.writes.outboxRows.map((row) => row.id)).toEqual(
      exchange.outcome.written.outboxRows.map((row) => row.id),
    );
    // The chat id's one home is the thread row (default 135): never an event-log entry's values.
    const chatId = String(requestTurnFields(exchange.request).chatId);
    expect(JSON.stringify(request.writes.events)).not.toContain(chatId);
    expect(JSON.stringify(request.writes.state)).toContain(chatId);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Default 135: the request turn's service and chat id

describe("the request turn's service and chat id (K-09 v1.5 default 135)", () => {
  /** commit-s1-01.json's turn 1 with its request turn changed. */
  async function withTurn(change: (turn: Record<string, unknown>) => void): Promise<unknown> {
    const { part, context } = turnOne();
    change(requestTurnFields(context.request));
    return thrownBy(writesOf().writesOf(part, context, NOTHING_OPEN));
  }

  it("with no service and chatId on the request's turn, the part fails closed, never guessed", async () => {
    const error = await withTurn((turn) => {
      Reflect.deleteProperty(turn, "service");
      Reflect.deleteProperty(turn, "chatId");
    });
    expectRefused(error, "noServiceOrChatId");
  });

  it.each([
    ["only the service", (turn: Record<string, unknown>) => Reflect.deleteProperty(turn, "chatId")],
    ["only the chat id", (turn: Record<string, unknown>) => Reflect.deleteProperty(turn, "service")],
    ["an empty chat id", (turn: Record<string, unknown>) => (turn.chatId = "")],
    ["no chat id (null, as for email)", (turn: Record<string, unknown>) => (turn.chatId = null)],
    ["a chat id that is not a string", (turn: Record<string, unknown>) => (turn.chatId = 7)],
    ["a service K-06 does not name", (turn: Record<string, unknown>) => (turn.service = "fax")],
    ["an empty service", (turn: Record<string, unknown>) => (turn.service = "")],
  ])("with %s, the part fails closed", async (_, change) => {
    expectRefused(await withTurn(change), "noServiceOrChatId");
  });

  it("an email turn's thread is not a Linq chat: not built, nothing written", async () => {
    const error = await withTurn((turn) => {
      turn.service = "email";
    });
    expectNotBuilt(error, "threadByEmail", ["S1-01"]);
  });

  it("takes each run's own service and chat id: the thread's chat id and the reply's channel follow them", async () => {
    const { part, context } = turnOne();
    const turn = requestTurnFields(context.request);
    turn.service = "sms";
    turn.chatId = "linq-chat-demo-alex";
    const writes = await writesOf().writesOf(part, context, NOTHING_OPEN);
    const [thread] = writes.state;
    expect(thread?.op === "insert" ? thread.values.linq_chat_id : null).toBe("linq-chat-demo-alex");
    expect(writes.messages.map((row) => row.channel)).toEqual(["sms"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// STATE note 1 and DL-128: an open safety hold stops the walk at its first routine row

describe("what is open stops the walk at its first routine row (STATE note 1; DL-128)", () => {
  it("a threat's hold (never released): the walk stops at S1-01, its first routine row, and writes nothing", async () => {
    const writes = await turnOneWrites({ holds: [hold()], unreadEventIds: [] });
    expectNothingWritten(writes);
    expect(writes.why).toEqual({ step: "S1-01", choice: "Business onboarding" });
  });

  it.each([
    ["an after-safe hold", { holds: [hold("after_safe")], unreadEventIds: [] }],
    ["an at-once hold", { holds: [hold("at_once")], unreadEventIds: [] }],
    ["a text not yet read", { holds: [], unreadEventIds: ["evt-sam-s1-01"] }],
  ] as const)("%s stops it there too: S1-01 and S1-02 are routine", async (_, open) => {
    expectNothingWritten(
      await turnOneWrites({ holds: [...open.holds], unreadEventIds: [...open.unreadEventIds] }),
    );
  });

  it("a stopped walk needs no service or chat id: a part it writes nothing for never reads them", async () => {
    const { part, context } = turnOne();
    const turn = requestTurnFields(context.request);
    Reflect.deleteProperty(turn, "service");
    Reflect.deleteProperty(turn, "chatId");
    expectNothingWritten(await writesOf().writesOf(part, context, { holds: [hold()], unreadEventIds: [] }));
  });

  it("the rule: a protective row passes every hold, a safety-flow row only an after-safe one, a routine row none", () => {
    const never = { holds: [hold()], unreadEventIds: [] };
    const afterSafe = { holds: [hold("after_safe")], unreadEventIds: [] };
    const unread = { holds: [], unreadEventIds: ["evt-sam-s1-01"] };
    // A3-50's private booking is protective, and its walk rejoins the booking (A3-51, routine): it stops there.
    expect(firstHeld(["A3-50", "A3-51"], "protective", never)).toBe(1);
    expect(firstHeld(["A3-50", "A3-51"], "protective", unread)).toBe(1);
    // Protective rows only: nothing is held.
    expect(firstHeld(["A7-11", "A7-81"], "protective", never)).toBeNull();
    // The safety flow (A3-24) passes an after-safe hold only, and its booking does not.
    expect(firstHeld(["A3-24", "A3-51"], "safetyFlow", afterSafe)).toBe(1);
    expect(firstHeld(["A3-24", "A3-51"], "safetyFlow", never)).toBe(0);
    // The part's own class decides its first row: a protective any-time row's step is protective.
    expect(firstHeld(["A3-51"], "protective", never)).toBeNull();
    // Nothing open: nothing is held.
    expect(firstHeld(["S1-01", "S1-02"], "routine", NOTHING_OPEN)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The same part twice; no outside effect

describe("the same part twice gives the same writes, with no outside effect (STATE note 1)", () => {
  it("two runs give equal writes, read the turn's pinned graph afresh each time, and change nothing they were given", async () => {
    const { part, context } = turnOne();
    const given = copy({ part, request: context.request, turn: context.turn, open: NOTHING_OPEN });
    const { writesOf: walk, reads } = writesOf();
    const first = await walk(part, context, NOTHING_OPEN);
    const second = await walk(part, context, NOTHING_OPEN);
    expect(second).toEqual(first);
    expect(copy({ part, request: context.request, turn: context.turn, open: NOTHING_OPEN })).toEqual(given);
    const pin = { hash: "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037", build: 1 };
    expect(reads).toEqual([
      { bundleId: pin, flow: "A" },
      { bundleId: pin, flow: "A" },
    ]);
  });

  it("each run hands back its own rows: changing one run's writes changes nothing of the next", async () => {
    const { part, context } = turnOne();
    const { writesOf: walk } = writesOf();
    const first = await walk(part, context, NOTHING_OPEN);
    const [row] = first.messages;
    if (row === undefined) throw new Error("one outbox row");
    Reflect.set(row, "channel", "sms");
    const second = await walk(part, context, NOTHING_OPEN);
    expect(second.messages.map((row) => row.channel)).toEqual(["imessage"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// S1-02's branches on bundle v0

describe("S1-02's branches walk only as far as bundle v0 holds them", () => {
  const graph = () => flowGraphOf(flowA(), "A");

  it("'Not a service we book' ends with its end text", () => {
    const walked = walkFrom(graph(), { kind: "branch", step: "S1-02", branch: "Not a service we book" });
    expect(walked.moves.map((move) => (move.kind === "branch" ? move.branch.label : move.step.id))).toEqual([
      "Not a service we book",
    ]);
    expect(walked.stop).toMatchObject({
      kind: "ends",
      text: "Not a service Rosie books: nothing is set up, and Rosie's team sees it. Other work goes on.",
    });
  });

  it("'One isn't on the list yet' needs S1-03, which bundle v0 does not hold: refused, never guessed", () => {
    const error = thrownBySync(() =>
      walkFrom(graph(), { kind: "branch", step: "S1-02", branch: "One isn't on the list yet" }),
    );
    expectRefused(error, "stepNotInBundle", ["S1-03"]);
  });

  it("'All on the list' needs S1-11, which bundle v0 does not hold: refused, never guessed", () => {
    const error = thrownBySync(() =>
      walkFrom(graph(), { kind: "branch", step: "S1-02", branch: "All on the list" }),
    );
    expectRefused(error, "stepNotInBundle", ["S1-11"]);
  });

  it("an ending branch's step the bundle lacks is accounted for only when its message effect names it", () => {
    const changed = flowA();
    branchIn(changed, "S1-02", "Not a service we book").effects = [];
    const error = thrownBySync(() =>
      walkFrom(flowGraphOf(changed, "A"), { kind: "branch", step: "S1-02", branch: "Not a service we book" }),
    );
    expectRefused(error, "stepNotInBundle", ["S1-74"]);
  });

  it.each([
    ["c-01", "All on the list", "stepNotInBundle", ["S1-11"]],
    ["c-02", "One isn't on the list yet", "stepNotInBundle", ["S1-03"]],
  ] as const)(
    "through writesOf, turn 2's %s (%s) is refused, nothing written",
    async (choiceId, label, fault, ids) => {
      const { part, context, choice } = turnTwo(choiceId);
      expect(choice.branch).toBe(label);
      expectRefused(await thrownBy(writesOf().writesOf(part, context, NOTHING_OPEN)), fault, ids);
    },
  );

  it("through writesOf, turn 2's c-03 (Not a service we book) walks to its end, and its answer's writes are journey 1's: notBuilt", async () => {
    const { part, context, choice } = turnTwo("c-03");
    expect(choice.branch).toBe("Not a service we book");
    const error = await thrownBy(writesOf().writesOf(part, context, NOTHING_OPEN));
    expectNotBuilt(error, "answer", ["S1-02"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Refused, never guessed

describe("a step or branch the bundle lacks is refused, never guessed", () => {
  it.each([
    ["c-04", "the door to S11-21", ["S11-21"]],
    ["c-05", "the any-time row to A3-22", ["A3-22"]],
  ] as const)("turn 2's %s, %s, is a step bundle v0 does not hold", async (choiceId, _, ids) => {
    const { part, context } = turnTwo(choiceId);
    expectRefused(await thrownBy(writesOf().writesOf(part, context, NOTHING_OPEN)), "stepNotInBundle", ids);
  });

  it("a branch S1-02 does not have is refused", async () => {
    const { part, context } = turnTwo("c-01");
    const changed: PassedPart = { ...part, choice: part.choice && { ...part.choice, branch: "Maybe later" } };
    expectRefused(await thrownBy(writesOf().writesOf(changed, context, NOTHING_OPEN)), "branchNotInBundle", [
      "S1-02",
    ]);
  });

  it("a branch of S1-01, which has none, is refused", () => {
    const error = thrownBySync(() =>
      walkFrom(flowGraphOf(flowA(), "A"), { kind: "branch", step: "S1-01", branch: "All on the list" }),
    );
    expectRefused(error, "branchNotInBundle", ["S1-01"]);
  });

  it("an option with no branch is refused", async () => {
    const { part, context } = turnTwo("c-01");
    const changed: PassedPart = { ...part, choice: part.choice && { ...part.choice, branch: null } };
    expectRefused(await thrownBy(writesOf().writesOf(changed, context, NOTHING_OPEN)), "branchNotInBundle", [
      "S1-02",
    ]);
  });

  it("a pin whose bundle the port does not hold, or a bundle with no graph of the flow, is refused", async () => {
    const { part, context } = turnOne();
    const other: CommitTurnContext<WalkTestRepo> = {
      ...context,
      turn: { ...context.turn, bundleId: { hash: "0".repeat(64), build: 1 } },
    };
    expectRefused(await thrownBy(writesOf().writesOf(part, other, NOTHING_OPEN)), "flowNotInBundle", ["A"]);
    const { bundles } = skeletonBundles({});
    const noFlow = createWritesOf<WalkTestRepo>({ bundles, turnKey: () => SAM });
    expectRefused(await thrownBy(noFlow(part, context, NOTHING_OPEN)), "flowNotInBundle", ["A"]);
  });

  it.each([
    ["not a K-01 graph", null],
    ["another contract's", { ...flowA(), contract: "bundle.v2" }],
    ["flow B's graph", { ...flowA(), flow: "B" }],
    ["a graph with no steps", { ...flowA(), steps: [] }],
  ])("a flow graph that is %s is refused", (_, value) => {
    expectRefused(
      thrownBySync(() => flowGraphOf(value, "A")),
      "flowNotInBundle",
      ["A"],
    );
  });

  it("a part whose choice is about another business than the call's is refused", async () => {
    const { part, context } = turnOne();
    expectRefused(
      await thrownBy(
        writesOf().writesOf(part, { ...context, businessId: "biz-lee-home-services" }, NOTHING_OPEN),
      ),
      "businessNotInScope",
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The graph's rules, on changed copies of bundle v0's flow A

describe("the walk's rules on the graph (arch 03 line 191)", () => {
  it("a walk that comes back to a step it walked is a loop: refused", () => {
    const graph = flowA();
    branchIn(graph, "S1-02", "All on the list").rejoinAt = "S1-01";
    stepIn(graph, "S1-01").next = "S1-02";
    const error = thrownBySync(() =>
      walkFrom(flowGraphOf(graph, "A"), { kind: "branch", step: "S1-02", branch: "All on the list" }),
    );
    expectRefused(error, "loop", ["S1-02"]);
  });

  it(`a walk longer than ${String(MAX_WALK)} steps is refused`, () => {
    const graph = flowA();
    const plain = stepIn(graph, "S1-01");
    const ids = Array.from({ length: MAX_WALK + 1 }, (_, n) => `S1-${String(100 + n)}`);
    ids.forEach((id, n) => {
      graph.steps[id] = { ...copy(plain), id, gives: [], next: ids[n + 1] ?? null };
    });
    const error = thrownBySync(() => walkFrom(flowGraphOf(graph, "A"), { kind: "step", step: "S1-100" }));
    expectRefused(error, "walkTooLong", [ids[MAX_WALK] ?? ""]);
  });

  it("the end of a section's main path ends the journey: S1-01's thread alone, no question", async () => {
    const graph = flowA();
    stepIn(graph, "S1-01").next = null;
    const walked = walkFrom(flowGraphOf(graph, "A"), { kind: "step", step: "S1-01" });
    expect(walked.stop).toMatchObject({ kind: "journeyEnds" });
    const writes = await turnOneWrites(NOTHING_OPEN, graph);
    expect(writes.state.map((write) => write.table)).toEqual(["threads"]);
    expect(writes.asks).toEqual([]);
    expect(writes.messages).toEqual([]);
    expect(writes.gives).toEqual(["thread"]);
  });

  it("a list's end the bundle cannot place (no main path and no branch holding it) is refused", () => {
    const graph = flowA();
    stepIn(graph, "S1-01").next = null;
    graph.sections = [];
    const error = thrownBySync(() => walkFrom(flowGraphOf(graph, "A"), { kind: "step", step: "S1-01" }));
    expectRefused(error, "pathNotInBundle", ["S1-01"]);
  });

  it("where a branch's list ends, the walk goes where the branch goes", () => {
    const graph = flowA();
    // S1-01 placed on S1-02's ending branch as its last step: its list's end ends the branch, with its end text.
    branchIn(graph, "S1-02", "Not a service we book").steps = ["S1-74", "S1-01"];
    stepIn(graph, "S1-01").next = null;
    graph.sections = [];
    const walked = walkFrom(flowGraphOf(graph, "A"), { kind: "step", step: "S1-01" });
    expect(walked.stop).toMatchObject({
      kind: "ends",
      text: expect.stringContaining("Not a service") as unknown,
    });
  });

  it.each([
    ["a split whose branches code settles (all lookups)", "lookup", ["S1-02"]],
    ["a split a clock settles (a clock branch)", "waits", ["S1-02"]],
  ] as const)("%s is not built", async (_, seam, ids) => {
    const error = await turnOneOn((graph) => {
      const branches = stepIn(graph, "S1-02").branches as Record<string, unknown>[];
      for (const branch of branches) {
        branch.tag = seam === "lookup" ? "lookup" : "clock";
        branch.reads = { from: "needs", key: "kinds" };
      }
    });
    expectNotBuilt(error, seam, ids);
  });

  /** Sets one field of a step of the graph's copy. */
  const setOn =
    (id: string, field: string, value: unknown) =>
    (graph: Graph): void => {
      stepIn(graph, id)[field] = value;
    };

  /** Sets (or, with undefined, removes) the clock of S1-02's card in the graph's copy. */
  const cardClock =
    (clock: unknown) =>
    (graph: Graph): void => {
      const card = stepIn(graph, "S1-02").card as Record<string, unknown>;
      if (clock === undefined) Reflect.deleteProperty(card, "clock");
      else card.clock = clock;
    };

  const BUTTONS = [
    { from: "san", to: "owner", text: "Pick", plainText: "Pick", elements: { buttons: ["1 Yes", "2 No"] } },
  ];

  it.each([
    ["a step with its own gate", "stepGate", ["S1-01"], setOn("S1-01", "when", { pf: ["x"] })],
    ["a step that tells someone", "tells", ["S1-01"], setOn("S1-01", "tells", ["owner"])],
    ["a gives key with no writer", "gives", ["S1-01", "kinds"], setOn("S1-01", "gives", ["kinds"])],
    ["a question to another lane", "recipient", ["S1-02"], setOn("S1-02", "to", "cust")],
    ["a question on a page", "recipient", ["S1-02"], setOn("S1-02", "via", "page")],
    ["a question from someone but Rosie", "recipient", ["S1-02"], setOn("S1-02", "who", "owner")],
    ["a question with buttons", "buttons", ["S1-02"], setOn("S1-02", "say", BUTTONS)],
    [
      "a card with a Clock line of its own",
      "clock",
      ["S1-02"],
      cardClock({ from: "clockLine", text: "24 h" }),
    ],
    ["a card with no Clock", "clock", ["S1-02"], cardClock(undefined)],
  ] as const)("%s is not built, nothing written", async (_, seam, ids, change) => {
    expectNotBuilt(await turnOneOn(change), seam, ids);
  });

  it("an entered step not written to Rosie names no writer: its question is not built", async () => {
    expectNotBuilt(await turnOneOn(setOn("S1-01", "to", "owner")), "recipient", ["S1-02"]);
  });

  it("a branch that continues in the other flow is not built", () => {
    const graph = flowA();
    branchIn(graph, "S1-02", "All on the list").flow = "B";
    const error = thrownBySync(() =>
      walkFrom(flowGraphOf(graph, "A"), { kind: "branch", step: "S1-02", branch: "All on the list" }),
    );
    expectNotBuilt(error, "otherFlow", ["S1-02"]);
  });

  /** Removes one field of a step of the graph's copy. */
  const dropFrom =
    (id: string, field: string) =>
    (graph: Graph): void => {
      Reflect.deleteProperty(stepIn(graph, id), field);
    };

  const unknownTag = (graph: Graph): void => {
    branchIn(graph, "S1-02", "All on the list").tag = "maybe";
  };

  it.each([
    ["an asked step with no card", dropFrom("S1-02", "card"), ["S1-02"]],
    ["a split with no branches", setOn("S1-02", "branches", []), ["S1-02"]],
    ["a plain step with branches", setOn("S1-01", "branches", []), ["S1-01"]],
    ["a step of another type", setOn("S1-01", "type", "rule"), ["S1-01"]],
    ["a step whose id is not its key", setOn("S1-01", "id", "S1-99"), ["S1-01"]],
    ["a step with no next", dropFrom("S1-01", "next"), ["S1-01"]],
    ["a step with no lane", dropFrom("S1-01", "who"), ["S1-01"]],
    ["a branch with an unknown tag", unknownTag, ["S1-02"]],
    ["a gives list that is not one", setOn("S1-01", "gives", "thread"), ["S1-01"]],
    ["a gives list holding an empty key", setOn("S1-01", "gives", [""]), ["S1-01"]],
    ["a say that is not a list", setOn("S1-02", "say", "Hi"), ["S1-02"]],
  ] as const)("%s is not K-01's shape: refused", async (_, change, ids) => {
    const graph = flowA();
    change(graph);
    expectRefused(await thrownBy(turnOneWrites(NOTHING_OPEN, graph)), "stepNotWellFormed", ids);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Parts the walk does not write

describe("parts the walk does not write: notBuilt, nothing written", () => {
  it("a part with no offered choice (pass_on, hand_off)", async () => {
    const { part, context } = turnOne();
    const passOn: PassedPart = {
      ...part,
      part: { verb: "pass_on", quote: part.part.quote, words: part.part.quote },
      choice: null,
    };
    expectNotBuilt(await thrownBy(writesOf().writesOf(passOn, context, NOTHING_OPEN)), "verb", ["pass_on"]);
  });

  it("the 'which booking?' choice", async () => {
    const { part, context } = turnOne();
    const which: PassedPart = { ...part, choice: part.choice && { ...part.choice, kind: "whichBooking" } };
    expectNotBuilt(await thrownBy(writesOf().writesOf(which, context, NOTHING_OPEN)), "whichBooking", [
      "S1-01",
    ]);
  });

  it("a request with no decided texts is refused", async () => {
    const { part, context } = turnOne();
    const coreOnly: CommitTurnContext<WalkTestRepo> = {
      ...context,
      request: { ...context.request, input: { kind: "coreOnly" } },
    };
    expectRefused(await thrownBy(writesOf().writesOf(part, coreOnly, NOTHING_OPEN)), "notDecided");
  });

  it("an empty turn key is refused: no row id is built from nothing", async () => {
    const { part, context } = turnOne();
    const { bundles } = skeletonBundles();
    const noKey = createWritesOf<WalkTestRepo>({ bundles, turnKey: () => "" });
    expectRefused(await thrownBy(noKey(part, context, NOTHING_OPEN)), "noTurnKey");
  });

  it("with no turn key given, the row ids are built from the turn's own id (default 131 in production)", async () => {
    const { part, context } = turnOne();
    const { bundles } = skeletonBundles();
    const writes = await createWritesOf<WalkTestRepo>({ bundles })(part, context, NOTHING_OPEN);
    expect(writes.asks.map((ask) => ask.question.id)).toEqual([`oq-s1-02-${context.turn.id}-1`]);
    expect(writes.messages.map((row) => row.id)).toEqual([`outbox-s1-02-${context.turn.id}-1`]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// What the walk's errors say

describe("the walk's errors name faults, steps and keys: never words, a branch label or the chat id", () => {
  it("no refusal or notBuilt message holds the text, a branch label or the chat id", async () => {
    const { exchange } = turnOne();
    const chatId = String(requestTurnFields(exchange.request).chatId);
    const errors = [
      await turnOneOn((graph) => (stepIn(graph, "S1-01").gives = ["kinds"])),
      await thrownBy(writesOf().writesOf(turnTwo("c-02").part, turnTwo("c-02").context, NOTHING_OPEN)),
      await thrownBy(writesOf().writesOf(turnTwo("c-03").part, turnTwo("c-03").context, NOTHING_OPEN)),
      thrownBySync(() =>
        walkFrom(flowGraphOf(flowA(), "A"), { kind: "branch", step: "S1-02", branch: "Not a label" }),
      ),
    ];
    for (const error of errors) {
      expect(error).toBeInstanceOf(Error);
      const message = error instanceof Error ? error.message : "";
      for (const words of [
        chatId,
        "Hi, I want to put my barbershop on Rosie",
        "Barbershop, plumbing, electrical",
        "Not a service we book",
        "One isn't on the list yet",
        "Not a label",
      ]) {
        expect(message).not.toContain(words);
      }
    }
  });
});

describe("the flow a step is read in: its own for an A or B step, the turn's for a shared one", () => {
  it.each([
    ["S1-01", "A", "A"],
    ["S1-01", "B", "B"],
    ["A3-22", "B", "A"],
    ["B3-17", "A", "B"],
  ] as const)("%s in a flow %s turn is read in flow %s", (step, turnFlow, read: FlowLetter) => {
    expect(flowOfStep(step, turnFlow)).toBe(read);
  });
});
