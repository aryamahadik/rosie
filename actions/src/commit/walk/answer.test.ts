// T-1461: the walk answers an option (the architect's ruling on the second turn, card C; DL-961; DL-965's lead note). A
// part that chooses an open question's option closes that question at the version its row is read at, names the row in
// versionsRead, and walks the turn's pinned graph from the chosen branch, each walked step that writes something written
// by its own read-only step writer, found by its step id. Proved on bundle v1 (bundles/v1, T-1460) with fakes of the
// bundle, the question read and the step writers, never of the walk: commit-s1-02.json's writes up to row ids ("All on
// the list": three picked kinds, S1-11 walked, S1-04's question and its outbox row, oq-s1-02 closed at its version);
// "One isn't on the list yet" reaches S1-03 and "Not a service we book" S1-74's end; a step that writes something with
// no writer is refused with nothing returned; the same part twice gives the same writes; a hold stops the walk; no trade
// overlay applies before a kind is known. T-1139's own cases stay in walk.test.ts, unchanged.

import { describe, expect, it } from "vitest";

import type { OpenQuestionRead } from "../../../../db/repo/targets";
import { copy } from "../../gate/framework/test-support";
import { buildCommitRequest } from "../build";
import { contractChecks, eventLogRowsOf, samKindsWrites } from "../test-support";
import type { Ask, OpenHolds, OutboxRowNew, PassedPart, UnitWrites } from "../types";
import {
  WalkNotBuiltError,
  WalkRefusedError,
  createWritesOf,
  flowGraphOf,
  walkFrom,
  type StepWriter,
  type WalkFault,
  type WalkSeam,
  type Walked,
} from "./index";
import {
  NOTHING_OPEN,
  SAM,
  allWriters,
  branchIn,
  bundleV1Bundles,
  bundleV1Id,
  decidedOf,
  flowAV1,
  hold,
  questionsOver,
  requestTurnFields,
  s1_02QuestionRow,
  s1_02Writer,
  stepIn,
  tradeOverlayV1,
  turnTwoOnV1,
  writersOf,
  type GraphValue,
  type WalkTestRepo,
} from "./test-support";

/** What the answer's walk is given: bundle v1's flow A (or a changed copy), the question rows and the step writers. */
interface Given {
  readonly graph?: GraphValue;
  readonly rows?: readonly OpenQuestionRead[];
  readonly sentTo?: string;
  readonly writers?: Readonly<Record<string, StepWriter<WalkTestRepo>>>;
}

/** The walk's writesOf on bundle v1, its question read and step writers fakes that write down each call. */
function answerWalk(given: Given = {}) {
  const { bundles, reads } = bundleV1Bundles({ A: given.graph ?? flowAV1() });
  const questions = questionsOver(given.rows, given.sentTo);
  const writers = writersOf(given.writers ?? allWriters());
  const writesOf = createWritesOf<WalkTestRepo>({
    bundles,
    turnKey: () => SAM,
    questions: questions.questions,
    writers: writers.writers,
  });
  return { writesOf, reads, questionReads: questions.reads, calls: writers.calls };
}

/** Turn 2's part choosing `choiceId`, answered by the walk `walk` with what is open. */
async function answer(choiceId: string, walk = answerWalk(), open: OpenHolds = NOTHING_OPEN) {
  const turn = turnTwoOnV1(choiceId);
  const writes = await walk.writesOf(turn.part, turn.context, open);
  return { ...turn, ...walk, writes };
}

/** What turn 2's part choosing `choiceId` threw on the walk `walk`, or null; with the walk's calls. */
async function refusal(choiceId: string, walk = answerWalk()) {
  const turn = turnTwoOnV1(choiceId);
  const error = await walk.writesOf(turn.part, turn.context, NOTHING_OPEN).then(
    () => null,
    (thrown: unknown) => thrown,
  );
  return { ...turn, ...walk, error };
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

/** The walk on bundle v1's flow A (or a changed copy) from S1-02's branch `branch`. */
function walkS1_02(branch: string, graph: GraphValue = flowAV1()): Walked {
  return walkFrom(flowGraphOf(graph, "A"), { kind: "branch", step: "S1-02", branch });
}

/** What a walk applies, in order: a branch by its label, a step by its id. */
function movesOf(walked: Walked): string[] {
  return walked.moves.map((move) => (move.kind === "branch" ? move.branch.label : move.step.id));
}

/** The step ids the stand-in writers were called for, in order. */
function stepsWritten(calls: readonly { stepId: string }[]): string[] {
  return calls.map((call) => call.stepId);
}

/** An asked question with no id, as two writes of the same question compare up to their row ids. */
function askUpToId(ask: Ask): Ask {
  return { ...ask, question: { ...ask.question, id: "" } };
}

/** An outbox row with no ids of its own or of the question it asks, as two writes compare up to their row ids. */
function rowUpToIds(row: OutboxRowNew): OutboxRowNew {
  return { ...row, id: "", openQuestionId: row.openQuestionId === null ? null : "" };
}

// ---------------------------------------------------------------------------------------------------------------
// commit-s1-02.json: turn 2, "All on the list"

describe("commit-s1-02.json's part on bundle v1: 'All on the list' is answered", () => {
  it("writes the fixture's rows up to row ids: three picked kinds, S1-04's question and its outbox row, oq-s1-02 closed", async () => {
    const { exchange, writes } = await answer("c-01");
    const { outcome } = exchange;
    // The state: the three picked kinds, inserted, as outcome.written lists them table by table.
    expect(writes.state.map((write) => write.op)).toEqual(["insert", "insert", "insert"]);
    expect(writes.state.map((write) => write.table)).toEqual(outcome.written.written.map((row) => row.table));
    expect(outcome.written.written.map((row) => row.version)).toEqual([1, 1, 1]);
    // The questions opened and closed, and the one outbox row asking the one opened.
    expect(writes.asks.map((ask) => ask.question.step)).toEqual(["S1-04"]);
    expect(writes.asks).toHaveLength(outcome.openQuestions.opened.length);
    expect(writes.closes.map((close) => close.id)).toEqual(outcome.openQuestions.closed);
    expect(writes.messages).toHaveLength(outcome.written.outboxRows.length);
    expect(writes.messages.map((row) => row.openQuestionId)).toEqual(
      writes.asks.map((ask) => ask.question.id),
    );
    // The keys: S1-02's kinds and S1-11's eleven pf keys, as the fixture states them and its outcome's part answers.
    expect(writes.gives).toEqual(exchange.given.stated.gives);
    expect(writes.gives).toEqual(outcome.parts[0]?.gives);
    // Up to row ids: the fixture names its rows by stand-ins (pick-sam-barbershop, oq-s1-04-sam, out-s1-04-sam); the
    // walk names them by default 131, with the turn key sam. The closed question keeps its own row's id.
    expect(outcome.written.written.map((row) => row.rowId)).toEqual([
      "pick-sam-barbershop",
      "pick-sam-plumbing",
      "pick-sam-electrical",
    ]);
    expect(writes.state.map((write) => (write.op === "insert" ? write.values.id : null))).toEqual([
      "pick-s1-02-sam-1",
      "pick-s1-02-sam-2",
      "pick-s1-02-sam-3",
    ]);
    expect(outcome.openQuestions.opened).toEqual(["oq-s1-04-sam"]);
    expect(writes.asks.map((ask) => ask.question.id)).toEqual(["oq-s1-04-sam-1"]);
    expect(outcome.written.outboxRows.map((row) => row.id)).toEqual(["out-s1-04-sam"]);
    expect(writes.messages.map((row) => row.id)).toEqual(["outbox-s1-04-sam-1"]);
    expect(writes.closes.map((close) => close.id)).toEqual(["oq-s1-02"]);
  });

  it("its rows field for field: the matcher's kinds, S1-04's question and quick reply as T-305's double writes them, the close at version 2", async () => {
    const { writes, context } = await answer("c-01");
    const double = samKindsWrites();
    expect(writes.why).toEqual({ step: "S1-02", choice: "All on the list" });
    // S1-02's writer's picked kinds, in the matcher's order (match-kinds.json), not placed yet.
    expect(writes.state).toEqual(
      [
        ["Barbershop", "barbershop"],
        ["plumbing", "plumbing"],
        ["electrical", "electrical"],
      ].map(([words, kindId], index) => ({
        op: "insert",
        table: "picked_kinds",
        values: {
          id: `pick-s1-02-sam-${String(index + 1)}`,
          owner_person_id: "person-sam",
          position: index + 1,
          words,
          outcome: "listed",
          kind_id: kindId,
          business_id: null,
          picked_at: context.request.now,
        },
      })),
    );
    // S1-04's question to Sam at Lee's Barbershop (no options, no read-back, no versions read, step 9's default clock,
    // no safe default) and the quick reply asking it on his text's service: T-305's double of the same fixture, up to
    // their row ids.
    expect(writes.asks.map(askUpToId)).toEqual(double.asks.map(askUpToId));
    expect(writes.messages.map(rowUpToIds)).toEqual(double.messages.map(rowUpToIds));
    expect(writes.asks).toEqual([
      {
        question: {
          id: "oq-s1-04-sam-1",
          handleId: "handle-sam",
          personId: "person-sam",
          businessId: "biz-lees-barbershop",
          bookingId: null,
          step: "S1-04",
          options: [],
          readback: null,
          versionsRead: [],
          clock: null,
        },
        safeDefault: null,
      },
    ]);
    expect(writes.messages).toEqual([
      {
        id: "outbox-s1-04-sam-1",
        recipientHandleId: "handle-sam",
        recipientPersonId: "person-sam",
        businessId: "biz-lees-barbershop",
        bookingId: null,
        channel: requestTurnFields(context.request).service,
        sendClass: "quick_reply",
        openQuestionId: "oq-s1-04-sam-1",
        copyOfRowId: null,
        versionsRead: [],
      },
    ]);
    // oq-s1-02 closed answered, with no option id, at the version its row was read at, as the double closes it.
    expect(writes.closes).toEqual(double.closes);
    expect(writes.closes).toEqual([
      { id: "oq-s1-02", expectVersion: 2, status: "answered", answeredOptionId: null },
    ]);
    expect(writes.versionsRead).toEqual([{ table: "open_questions", rowId: "oq-s1-02", version: 2 }]);
    // Nothing else: no state entry (K-08 has no kind for picked kinds: CQ-56), no reservation, no effect, and no clock
    // cancel (the double also cancels oq-s1-02's clock row, whose version no read the walk is given returns: the
    // card's open question 1).
    expect(writes).toEqual({
      why: writes.why,
      versionsRead: writes.versionsRead,
      state: writes.state,
      stateEvents: [],
      asks: writes.asks,
      closes: writes.closes,
      clockCancels: [],
      messages: writes.messages,
      reservations: { confirm: [], release: [] },
      effects: { write: [], letGo: [] },
      gives: writes.gives,
    });
  });

  it("writes each row in K-05's own shapes, and the question read's row is K-05 v1.2's openQuestionRead", async () => {
    const { writes } = await answer("c-01");
    const checks = contractChecks();
    for (const write of writes.state) expect(checks.k05("stateWrite", write)).toEqual([]);
    for (const ask of writes.asks) expect(checks.k05("openQuestionNew", ask.question)).toEqual([]);
    for (const row of writes.messages) expect(checks.k05("outboxRowNew", row)).toEqual([]);
    for (const close of writes.closes) expect(checks.k05("openQuestionClose", close)).toEqual([]);
    for (const ref of writes.versionsRead) expect(checks.k05("rowRef", ref)).toEqual([]);
    expect(checks.k05("openQuestionRead", s1_02QuestionRow())).toEqual([]);
  });

  it("goes into the commit's one K-05 request: K-05 and K-08 take it, and Sam's answer approves the close", async () => {
    const { exchange, context, writes } = await answer("c-01");
    const { people } = decidedOf(context.request).context.writer;
    const personId = context.request.caller.personId;
    const person = people.find((each) => each.personId === personId);
    const request = buildCommitRequest({
      turn: context.turn,
      zone: "America/New_York",
      businessId: context.businessId,
      actor: {
        personId,
        roleAt: (businessId) => person?.roles.find((role) => role.businessId === businessId)?.role ?? null,
      },
      // The answer commit.ts's answerOf gives a choose of an option of a question the context names.
      units: [{ writes, answer: { openQuestionId: "oq-s1-02", optionId: null, eventId: "evt-sam-0001" } }],
    });
    const checks = contractChecks();
    expect(checks.k05("commitTurn.request", request)).toEqual([]);
    const rows = eventLogRowsOf(request, exchange.request.now);
    for (const row of rows) expect(checks.k08("eventLogRow", row), String(row.id)).toEqual([]);
    expect(checks.k08("eventLogBatch", { rows })).toEqual([]);
    expect(request.versionsRead).toEqual([{ table: "open_questions", rowId: "oq-s1-02", version: 2 }]);
    expect(request.writes.openQuestions.close).toEqual(writes.closes);
    expect(request.writes.openQuestions.open.map((question) => question.id)).toEqual(["oq-s1-04-sam-1"]);
    expect(request.writes.clockRows.make.map((clock) => clock.id)).toEqual(["clock-oq-s1-04-sam-1"]);
    expect(request.writes.outboxRows.map((row) => row.id)).toEqual(["outbox-s1-04-sam-1"]);
    expect(request.writes.events.find((entry) => entry.rowId === "oq-s1-02")).toMatchObject({
      kind: "open_question.answered",
      actorKind: "person",
      actorPersonId: "person-sam",
      approvedBy: { kind: "answer", open_question_id: "oq-s1-02", option_id: null, event_id: "evt-sam-0001" },
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// S1-02's three branches on bundle v1, each step written by its own writer

describe("S1-02's branches on bundle v1, each walked step written by its own writer", () => {
  it("'All on the list' walks S1-11 (automatic) and stops at S1-04's question, never walking on to S1-08", async () => {
    const walked = walkS1_02("All on the list");
    expect(movesOf(walked)).toEqual(["All on the list", "S1-11"]);
    expect(walked.stop).toMatchObject({ kind: "asks", step: { id: "S1-04", split: false } });
    // S1-04's next is S1-08, which bundle v1 does not hold: the walk stops at S1-04's buttons before it.
    expect(stepIn(flowAV1(), "S1-04").next).toBe("S1-08");
    expect(flowGraphOf(flowAV1(), "A").step("S1-08")).toBeNull();
    const { writes, calls } = await answer("c-01");
    expect(stepsWritten(calls)).toEqual(["S1-02", "S1-11"]);
    for (const named of ["S1-08", "s1-08"]) expect(JSON.stringify(writes)).not.toContain(named);
  });

  it("calls each writer on the call's transaction with the part, its choice and the walk's writer context", async () => {
    const { calls, context } = await answer("c-01");
    expect(calls).toEqual([
      { stepId: "S1-02", repo: context.repo, part: 0, choiceId: "c-01", writerLane: "owner" },
      { stepId: "S1-11", repo: context.repo, part: 0, choiceId: "c-01", writerLane: "owner" },
    ]);
    for (const call of calls) expect(call.repo).toBe(context.repo);
  });

  it("'One isn't on the list yet' reaches S1-03 with its writer, rejoins at S1-11 and stops at S1-04's question", async () => {
    const walked = walkS1_02("One isn't on the list yet");
    expect(movesOf(walked)).toEqual(["One isn't on the list yet", "S1-03", "S1-11"]);
    expect(walked.stop).toMatchObject({ kind: "asks", step: { id: "S1-04" } });
    const { writes, calls, exchange } = await answer("c-02");
    expect(stepsWritten(calls)).toEqual(["S1-02", "S1-03", "S1-11"]);
    expect(writes.why).toEqual({ step: "S1-02", choice: "One isn't on the list yet" });
    // S1-03's message (its writer's) goes before S1-04's question, in the walk's order.
    expect(writes.messages.map((row) => [row.id, row.openQuestionId])).toEqual([
      ["outbox-s1-03-sam-1", null],
      ["outbox-s1-04-sam-1", "oq-s1-04-sam-1"],
    ]);
    expect(writes.asks.map((ask) => ask.question.id)).toEqual(["oq-s1-04-sam-1"]);
    expect(writes.closes.map((close) => close.id)).toEqual(["oq-s1-02"]);
    // The stand-ins give kinds (S1-02's) and the eleven pf keys (S1-11's), as on "All on the list".
    expect(writes.gives).toEqual(exchange.given.stated.gives);
  });

  it("'Not a service we book' reaches S1-74's end with its writer, and nothing after it", async () => {
    const walked = walkS1_02("Not a service we book");
    expect(movesOf(walked)).toEqual(["Not a service we book", "S1-74"]);
    expect(walked.stop).toMatchObject({
      kind: "ends",
      text: branchIn(flowAV1(), "S1-02", "Not a service we book").endText,
    });
    const { writes, calls } = await answer("c-03");
    expect(stepsWritten(calls)).toEqual(["S1-02", "S1-74"]);
    expect(writes.messages.map((row) => [row.id, row.openQuestionId])).toEqual([
      ["outbox-s1-74-sam-1", null],
    ]);
    expect(writes.asks).toEqual([]);
    expect(writes.closes.map((close) => close.id)).toEqual(["oq-s1-02"]);
    expect(writes.versionsRead).toEqual([{ table: "open_questions", rowId: "oq-s1-02", version: 2 }]);
    for (const later of ["S1-11", "S1-04", "s1-11", "s1-04"]) {
      expect(JSON.stringify(writes)).not.toContain(later);
    }
  });

  it("a plain step whose message carries no buttons is walked on as before: S1-04 without them meets S1-08", async () => {
    const graph = flowAV1();
    stepIn(graph, "S1-04").say = [{ from: "owner", to: "san" }];
    expectRefused(
      thrownBySync(() => walkS1_02("All on the list", graph)),
      "stepNotInBundle",
      ["S1-08"],
    );
    const { error, calls } = await refusal("c-01", answerWalk({ graph }));
    expectRefused(error, "stepNotInBundle", ["S1-08"]);
    expect(calls).toEqual([]);
  });

  it("a buttons question to another lane than the turn's writer is not built (recipient)", async () => {
    const graph = flowAV1();
    stepIn(graph, "S1-04").to = "staff";
    const { error } = await refusal("c-01", answerWalk({ graph }));
    expectNotBuilt(error, "recipient", ["S1-04"]);
  });

  it("a buttons step with a card of its own is asked as a split's: its card's safe default, and only step 9's default clock", async () => {
    const graph = flowAV1();
    const card = copy(stepIn(graph, "S1-02").card) as Record<string, unknown>;
    stepIn(graph, "S1-04").card = card;
    const { writes } = await answer("c-01", answerWalk({ graph }));
    expect(writes.asks.map((ask) => ask.safeDefault)).toEqual([card.safeDefault]);
    card.clock = { from: "clockLine", text: "24 h" };
    stepIn(graph, "S1-04").card = card;
    const { error } = await refusal("c-01", answerWalk({ graph }));
    expectNotBuilt(error, "clock", ["S1-04"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A step that writes something with no writer bound is refused

describe("a walked step that writes something with no writer bound is refused, with nothing returned", () => {
  it.each([
    ["S1-11, which gives the eleven pf keys", "c-01", "S1-11", "gives", ["S1-11", "pf.license"]],
    ["S1-02, the answered split, which gives kinds", "c-01", "S1-02", "gives", ["S1-02", "kinds"]],
    ["S1-03, which tells the owner", "c-02", "S1-03", "tells", ["S1-03"]],
    ["S1-74, which tells the owner", "c-03", "S1-74", "tells", ["S1-74"]],
  ] as const)(
    "%s: notBuilt naming it, before any writer is called or the question read",
    async (_, choiceId, missing, seam, ids) => {
      const writers = Object.fromEntries(Object.entries(allWriters()).filter(([step]) => step !== missing));
      const { error, calls, questionReads } = await refusal(choiceId, answerWalk({ writers }));
      expectNotBuilt(error, seam, ids);
      expect(calls).toEqual([]);
      expect(questionReads).toEqual([]);
    },
  );

  it("with no writer bound at all, the answer is refused at its first step that writes something", async () => {
    const { error, questionReads } = await refusal("c-01", answerWalk({ writers: {} }));
    expectNotBuilt(error, "gives", ["S1-02", "kinds"]);
    expect(questionReads).toEqual([]);
  });

  it("a step that writes nothing needs no writer, and none is called for it", async () => {
    const graph = flowAV1();
    stepIn(graph, "S1-11").gives = [];
    const { writes, calls } = await answer("c-01", answerWalk({ graph }));
    expect(stepsWritten(calls)).toEqual(["S1-02"]);
    expect(writes.gives).toEqual(["kinds"]);
    expect(writes.asks.map((ask) => ask.question.step)).toEqual(["S1-04"]);
  });

  it("a writer that gives a key its step does not give is refused", async () => {
    const writers = { ...allWriters(), "S1-11": s1_02Writer };
    const { error } = await refusal("c-01", answerWalk({ writers }));
    expectRefused(error, "givesNotStep", ["S1-11", "kinds"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The answered question: closed at the version its row is read at

describe("the answered question is closed at the version its row is read at, never the request's", () => {
  it("the close and versionsRead take the row's version, read on the call's transaction for the turn's handle", async () => {
    const walk = answerWalk({ rows: [{ ...s1_02QuestionRow(), version: 7 }] });
    const { writes, context, questionReads } = await answer("c-01", walk);
    expect(writes.closes).toEqual([
      { id: "oq-s1-02", expectVersion: 7, status: "answered", answeredOptionId: null },
    ]);
    expect(writes.versionsRead).toEqual([{ table: "open_questions", rowId: "oq-s1-02", version: 7 }]);
    expect(questionReads).toEqual([
      { repo: context.repo, handleId: "handle-sam", openQuestionId: "oq-s1-02" },
    ]);
    expect(questionReads[0]?.repo).toBe(context.repo);
    // The request names the question by its id alone: K-02's open question carries no version to take.
    const [asked] = decidedOf(context.request).context.openQuestions;
    expect(asked).toBeDefined();
    expect(Object.keys(asked ?? {})).not.toContain("version");
  });

  it.each([
    ["no live question of that id (closed, or gone)", { rows: [] }, "questionNotLive", ["S1-02"]],
    ["a question sent to another handle", { sentTo: "handle-alex" }, "questionNotLive", ["S1-02"]],
    [
      "a row at another step",
      { rows: [{ ...s1_02QuestionRow(), step: "S1-04" }] },
      "questionNotLive",
      ["S1-02"],
    ],
    [
      "a row of another business",
      { rows: [{ ...s1_02QuestionRow(), businessId: "biz-lee-home-services" }] },
      "businessNotInScope",
      [],
    ],
  ] as const)("%s is refused, with nothing written", async (_, given, fault, ids) => {
    const { error, calls } = await refusal("c-01", answerWalk(given));
    expectRefused(error, fault, ids);
    expect(stepsWritten(calls)).toEqual([]);
  });

  it("a question that went out with options is not answered yet (buttons): their option ids are K-03's", async () => {
    const rows = [{ ...s1_02QuestionRow(), options: [{ id: "S1-02/1", label: "All on the list" }] }];
    const { error } = await refusal("c-01", answerWalk({ rows }));
    expectNotBuilt(error, "buttons", ["S1-02"]);
  });

  it("with no question read bound, an answer is notBuilt as before (answer), nothing read or written", async () => {
    const { bundles, reads } = bundleV1Bundles();
    const writers = writersOf(allWriters());
    const writesOf = createWritesOf<WalkTestRepo>({ bundles, turnKey: () => SAM, writers: writers.writers });
    const { part, context } = turnTwoOnV1("c-01");
    const error = await writesOf(part, context, NOTHING_OPEN).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expectNotBuilt(error, "answer", ["S1-02"]);
    expect(writers.calls).toEqual([]);
    expect(reads).toEqual([{ bundleId: bundleV1Id(), flow: "A" }]);
  });

  it("a hub's case answers no open question: notBuilt (answer), even with the question read bound", async () => {
    const walk = answerWalk();
    const { part, choice, context } = turnTwoOnV1("c-01");
    const hub: PassedPart = { ...part, choice: { ...choice, kind: "hub" } };
    const error = await walk.writesOf(hub, context, NOTHING_OPEN).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expectNotBuilt(error, "answer", ["S1-02"]);
    expect(walk.questionReads).toEqual([]);
    expect(walk.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// What the answer's branch causes: its own steps' writes alone

describe("an answer writes what its branch causes through its own steps, and nothing it cannot write", () => {
  it("a branch effect no step writer writes (a flag) is not built (effect), nothing read", async () => {
    const graph = flowAV1();
    branchIn(graph, "S1-02", "All on the list").effects = [{ kind: "flag", ref: "S1-02", flag: "private" }];
    const { error, calls, questionReads } = await refusal("c-01", answerWalk({ graph }));
    expectNotBuilt(error, "effect", ["S1-02", "flag"]);
    expect(calls).toEqual([]);
    expect(questionReads).toEqual([]);
  });

  it("a branch step the bundle does not hold is refused at the answer: walk.ts default 1 tells where the path goes, never what it writes", async () => {
    const graph = flowAV1();
    Reflect.deleteProperty(graph.steps, "S1-74");
    expect(walkS1_02("Not a service we book", graph).stop).toMatchObject({ kind: "ends" });
    const { error, calls } = await refusal("c-03", answerWalk({ graph }));
    expectRefused(error, "stepNotInBundle", ["S1-74"]);
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The same part twice; a hold

describe("the same part twice gives the same writes, and a hold still stops the walk (STATE note 1)", () => {
  it("two runs give equal writes, read the graph and the question afresh, and change nothing they were given", async () => {
    const walk = answerWalk();
    const { part, context } = turnTwoOnV1("c-01");
    const given = copy({ part, request: context.request, turn: context.turn });
    const first = await walk.writesOf(part, context, NOTHING_OPEN);
    const second = await walk.writesOf(part, context, NOTHING_OPEN);
    expect(second).toEqual(first);
    expect(copy({ part, request: context.request, turn: context.turn })).toEqual(given);
    expect(walk.reads).toEqual([
      { bundleId: bundleV1Id(), flow: "A" },
      { bundleId: bundleV1Id(), flow: "A" },
    ]);
    expect(walk.questionReads).toHaveLength(2);
    expect(stepsWritten(walk.calls)).toEqual(["S1-02", "S1-11", "S1-02", "S1-11"]);
  });

  it.each([
    ["a threat's hold (never released)", { holds: [hold()], unreadEventIds: [] }],
    ["an after-safe hold", { holds: [hold("after_safe")], unreadEventIds: [] }],
    ["an at-once hold", { holds: [hold("at_once")], unreadEventIds: [] }],
    ["a text not yet read", { holds: [], unreadEventIds: ["evt-sam-0001"] }],
  ] as const)(
    "%s stops it at S1-02, its first routine row: nothing written or closed, no writer called, no question read",
    async (_, open) => {
      const walk = answerWalk();
      const { writes } = await answer("c-01", walk, {
        holds: [...open.holds],
        unreadEventIds: [...open.unreadEventIds],
      });
      expectNothingWritten(writes);
      expect(writes.why).toEqual({ step: "S1-02", choice: "All on the list" });
      expect(walk.calls).toEqual([]);
      expect(walk.questionReads).toEqual([]);
    },
  );

  it("a held answer needs no service or chat id: a part it writes nothing for never reads them", async () => {
    const walk = answerWalk();
    const { part, context } = turnTwoOnV1("c-01");
    const turn = requestTurnFields(context.request);
    Reflect.deleteProperty(turn, "service");
    Reflect.deleteProperty(turn, "chatId");
    expectNothingWritten(await walk.writesOf(part, context, { holds: [hold()], unreadEventIds: [] }));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// DL-965's lead note 5: no trade overlay before a kind is known

describe("S1-02's answer walks the master's steps alone: no trade overlay applies before a kind is known", () => {
  it("four trades turn 'One isn't on the list yet' off in their overlays, and the walk, reading flow A alone, still reaches S1-03", async () => {
    for (const trade of ["fertility", "lab", "obgyn", "sleep-clinic"]) {
      const overlay = tradeOverlayV1(trade) as { flows: { A: { ops: Record<string, unknown>[] } } };
      expect(overlay.flows.A.ops, trade).toContainEqual(
        expect.objectContaining({ op: "off", at: "S1-02", label: "One isn't on the list yet" }) as unknown,
      );
    }
    const { writes, calls, reads } = await answer("c-02");
    expect(reads).toEqual([{ bundleId: bundleV1Id(), flow: "A" }]);
    expect(stepsWritten(calls)).toEqual(["S1-02", "S1-03", "S1-11"]);
    expect(writes.messages.map((row) => row.id)).toEqual(["outbox-s1-03-sam-1", "outbox-s1-04-sam-1"]);
  });

  it("five trades' words ops at S1-02 change nothing it writes: every branch's writes are the master graph's alone", async () => {
    for (const trade of [
      "notary",
      "occupational-therapist",
      "pain-management",
      "property-manager",
      "sports-medicine",
    ]) {
      const overlay = tradeOverlayV1(trade) as { flows: { A: { ops: Record<string, unknown>[] } } };
      expect(overlay.flows.A.ops, trade).toContainEqual(
        expect.objectContaining({ op: "words", at: "S1-02" }) as unknown,
      );
    }
    for (const choiceId of ["c-01", "c-02", "c-03"]) {
      const { reads } = await answer(choiceId);
      expect(reads).toEqual([{ bundleId: bundleV1Id(), flow: "A" }]);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// What the new errors say

describe("the answer's errors name faults, steps and keys: never words, a branch label or the chat id", () => {
  it("no refusal or notBuilt message holds the text, a branch label or the chat id", async () => {
    const graph = flowAV1();
    branchIn(graph, "S1-02", "All on the list").effects = [{ kind: "flag", ref: "S1-02", flag: "private" }];
    const errors = [
      (await refusal("c-02", answerWalk({ writers: {} }))).error,
      (await refusal("c-01", answerWalk({ rows: [] }))).error,
      (await refusal("c-01", answerWalk({ writers: { ...allWriters(), "S1-11": s1_02Writer } }))).error,
      (await refusal("c-01", answerWalk({ graph }))).error,
    ];
    const chatId = String(requestTurnFields(turnTwoOnV1().context.request).chatId);
    for (const error of errors) {
      expect(error).toBeInstanceOf(Error);
      const message = error instanceof Error ? error.message : "";
      for (const words of [
        chatId,
        "Barbershop, plumbing, electrical",
        "All on the list",
        "One isn't on the list yet",
        "Not a service we book",
      ]) {
        expect(message).not.toContain(words);
      }
    }
  });
});
