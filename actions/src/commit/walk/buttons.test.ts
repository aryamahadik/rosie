// T-1491: the buttons settler port in the commit's walk (K-09 README default 199, from T-1515; DL-1033 ruling 7;
// rule-onekind.json card 6 as check-onekind.json corrects it). Where the walk would stop at a plain step with no branches
// whose message has buttons (S1-04), a buttons settler is bound for that step and no hold keeps it back, the walk builds
// the rows before that step, then asks the settler once, handing it the call, the step, the turn and the rows built so
// far. "ask": the step is asked exactly as today. Rows: the step is written as walked and the walk goes on from its next
// (S1-08's row, then S1-09's question), holds re-checked, under one loop check and one MAX_WALK for both stretches. A
// refusal, a throw or any other answer writes nothing; a key the step does not give is refused; with none bound
// commit-s1-02.json's walk is unchanged. Proved on T-1491's test graph (bundle v1's flow A with S1-08 and S1-09) and on
// bundle v1 itself, with T-1461's doubles (the bundle port, the question read, the stand-in writers) and a stand-in
// settler, never a double of the walk. S1-04's own settler is T-1492's (journey-1/companies).
//
// T-1479: S1-08's row (T-1482's planWriter's stand-in) names S1-08 and line 0, S1-09's question's row S1-09 and line 0
// (K-05 v1.22 item 82; writes.ts defaults 15 and 16), held to K-05 v1.22; and S1-09 as bundle v2 compiles it, a split
// whose message carries two buttons, is asked with its card's safe default and no options (writes.ts default 10).

import { describe, expect, it } from "vitest";

import type { OpenQuestionRead } from "../../../../db/repo/targets";
import { buildCommitRequest } from "../build";
import { contractChecks, eventLogRowsOf } from "../test-support";
import type { OpenHolds, PassedPart, StateWrite, UnitWrites } from "../types";
import {
  MAX_WALK,
  WalkNotBuiltError,
  WalkRefusedError,
  createWritesOf,
  flowGraphOf,
  walkFrom,
  walkStretchFrom,
  type ButtonsSettled,
  type ButtonsSettler,
  type ButtonsSettlerCall,
  type StepWriter,
  type Stretch,
  type WalkFault,
} from "./index";
import {
  NOTHING_OPEN,
  S1_09_BRANCHES,
  S1_09_SAFE_DEFAULT,
  SAM,
  allWriters,
  bundleV1Bundles,
  decidedOf,
  flowAV1,
  flowAV2,
  flowAWithCompiledPlan,
  flowAWithPlan,
  hold,
  k05v122,
  planWriters,
  questionsOver,
  requestTurnFields,
  s1_02QuestionRow,
  s1_04SettledRows,
  skeletonBundles,
  stepIn,
  turnOne,
  turnTwoOnV1,
  type GraphValue,
  type WalkTestRepo,
} from "./test-support";

const ALL = "All on the list";
const ONE = "One isn't on the list yet";

/** What the walk is given: the stand-in settler's answer, the graph, the question rows, what is bound. */
interface Given {
  /** The stand-in settler's answer (any value, as a settler might answer it), or an Error it rejects with. */
  readonly answer?: unknown;
  /** Default: T-1491's test graph. */
  readonly graph?: GraphValue;
  readonly rows?: readonly OpenQuestionRead[];
  /** The step ids a buttons settler is bound to. Default: S1-04. */
  readonly buttonsAt?: readonly string[];
  /** Leave the buttons settlers out of the walk's deps entirely (today's walk). */
  readonly noButtons?: boolean;
  /** T-1502's split settler bound at S1-02, answering this label. Default: none bound. */
  readonly settledAtS1_02?: string;
  /** The stand-in writers by step id. Default: planWriters (S1-02, S1-11, S1-03, S1-74 and S1-08). */
  readonly writers?: Readonly<Record<string, StepWriter<WalkTestRepo>>>;
}

/** The walk with a stand-in buttons settler; every ask, question read and writer call written down in one log. */
function buttonsWalk(given: Given = {}) {
  const { bundles } = bundleV1Bundles({ A: given.graph ?? flowAWithPlan() });
  const log: string[] = [];
  const asks: ButtonsSettlerCall<WalkTestRepo>[] = [];
  const fake = questionsOver(given.rows);
  const bound = new Map(Object.entries(given.writers ?? planWriters()));
  const writers = (stepId: string): StepWriter<WalkTestRepo> | null => {
    const writer = bound.get(stepId);
    if (writer === undefined) return null;
    return (call) => {
      log.push(`write ${call.step.id}`);
      return writer(call);
    };
  };
  const answer = Object.hasOwn(given, "answer") ? given.answer : s1_04SettledRows();
  const settler: ButtonsSettler<WalkTestRepo> = (call) => {
    log.push(`settle ${call.step.id}`);
    asks.push(call);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer as ButtonsSettled);
  };
  const at = new Set(given.buttonsAt ?? ["S1-04"]);
  const { settledAtS1_02 } = given;
  const writesOf = createWritesOf<WalkTestRepo>({
    bundles,
    turnKey: () => SAM,
    questions: {
      liveQuestion(repo, handleId, id) {
        log.push("question");
        return fake.questions.liveQuestion(repo, handleId, id);
      },
    },
    writers,
    ...(given.noButtons === true
      ? {}
      : { buttonsSettlers: (stepId: string) => (at.has(stepId) ? settler : null) }),
    ...(settledAtS1_02 === undefined
      ? {}
      : {
          settlers: (stepId: string) => (stepId === "S1-02" ? () => Promise.resolve(settledAtS1_02) : null),
        }),
  });
  return { writesOf, log, asks };
}

type Walk = ReturnType<typeof buttonsWalk>;

/** Turn 2's part naming `choiceId` (or the part given), answered by the walk with what is open. */
async function answer(walk: Walk, choiceId: string, open: OpenHolds = NOTHING_OPEN, part?: PassedPart) {
  const turn = turnTwoOnV1(choiceId);
  const writes = await walk.writesOf(part ?? turn.part, turn.context, open);
  return { ...turn, writes };
}

/** What turn 2's part naming `choiceId` (or the part given) threw on the walk, or null. */
async function refusal(walk: Walk, choiceId: string, part?: PassedPart): Promise<unknown> {
  const turn = turnTwoOnV1(choiceId);
  return walk.writesOf(part ?? turn.part, turn.context, NOTHING_OPEN).then(
    () => null,
    (thrown: unknown) => thrown,
  );
}

/** The stretch after `stretch`, which must be able to walk on. */
function walkedOn(stretch: Stretch): Stretch {
  if (stretch.walkOn === null) throw new Error("the stretch walks on");
  return stretch.walkOn();
}

function thrownBySync(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

function expectRefused(error: unknown, fault: WalkFault, ids: readonly string[]): void {
  expect(error).toBeInstanceOf(WalkRefusedError);
  expect(error).toMatchObject({ fault, ids });
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

/** The step ids of the questions a part opens. */
function askedSteps(writes: UnitWrites): string[] {
  return writes.asks.map((ask) => ask.question.step);
}

/** The outbox rows a part writes, each as its id and the question it asks. */
function rowsOf(writes: UnitWrites): (string | null)[][] {
  return writes.messages.map((row) => [row.id, row.openQuestionId]);
}

/** A chain of `count` plain steps (S9-01 on) that write nothing, after S1-08 and before S1-09, in T-1491's test graph. */
function graphWithChain(count: number): GraphValue {
  const graph = flowAWithPlan();
  const ids = Array.from({ length: count }, (_, index) => `S9-${String(index + 1).padStart(2, "0")}`);
  ids.forEach((id, index) => {
    graph.steps[id] = { id, who: "san", to: "owner", via: "auto", next: ids[index + 1] ?? "S1-09" };
  });
  stepIn(graph, "S1-08").next = ids[0] ?? "S1-09";
  return graph;
}

// ---------------------------------------------------------------------------------------------------------------
// The one-kind path: S1-04 walked, not asked

describe("a bound buttons settler that answers S1-04's rows: S1-04 is walked, then S1-08's row, then S1-09's question", () => {
  it("'All on the list' writes S1-02's and S1-11's rows, the settler's rows (companies) and S1-08's row, then stops at S1-09's question, opening no S1-04 question", async () => {
    const walk = buttonsWalk();
    const today = await answer(buttonsWalk({ noButtons: true }), "c-01");
    const { writes, exchange } = await answer(walk, "c-01");
    const settled = s1_04SettledRows();
    // The question read, S1-02's and S1-11's writers, the settler once, then S1-08's writer.
    expect(walk.log).toEqual(["question", "write S1-02", "write S1-11", "settle S1-04", "write S1-08"]);
    // S1-02's three picks (today's rows), then the settler's company kind, in the walk's order.
    expect(writes.state).toEqual([...today.writes.state, ...settled.state]);
    expect(writes.state).toHaveLength(4);
    // S1-02's kinds and S1-11's eleven pf keys (commit-s1-02.json's), then the settler's companies.
    expect(writes.gives).toEqual([...exchange.given.stated.gives, "companies"]);
    // No S1-04 question: S1-08's row (no question), then S1-09's question and the row asking it.
    expect(askedSteps(today.writes)).toEqual(["S1-04"]);
    expect(askedSteps(writes)).toEqual(["S1-09"]);
    expect(rowsOf(writes)).toEqual([
      ["outbox-s1-08-sam-1", null],
      ["outbox-s1-09-sam-1", "oq-s1-09-sam-1"],
    ]);
    for (const named of ["oq-s1-04", "outbox-s1-04"]) expect(JSON.stringify(writes)).not.toContain(named);
    // oq-s1-02 closed at its row's version, as today.
    expect(writes.closes).toEqual(today.writes.closes);
    expect(writes.versionsRead).toEqual(today.writes.versionsRead);
    expect(writes.why).toEqual({ step: "S1-02", choice: ALL });
  });

  it("S1-08's row and S1-09's question field for field: the turn's handle and person, the call's business, step 9's default clock and S1-09's safe default, each row naming its step and line 0", async () => {
    const { writes, context } = await answer(buttonsWalk(), "c-01");
    const service = requestTurnFields(context.request).service;
    const row = {
      recipientHandleId: "handle-sam",
      recipientPersonId: "person-sam",
      businessId: "biz-lees-barbershop",
      bookingId: null,
      channel: service,
      sendClass: "quick_reply",
      copyOfRowId: null,
      versionsRead: [],
    };
    expect(writes.messages).toEqual([
      { id: "outbox-s1-08-sam-1", ...row, openQuestionId: null, step: "S1-08", lineNo: 0 },
      { id: "outbox-s1-09-sam-1", ...row, openQuestionId: "oq-s1-09-sam-1", step: "S1-09", lineNo: 0 },
    ]);
    expect(writes.asks).toEqual([
      {
        question: {
          id: "oq-s1-09-sam-1",
          handleId: "handle-sam",
          personId: "person-sam",
          businessId: "biz-lees-barbershop",
          bookingId: null,
          step: "S1-09",
          options: [],
          readback: null,
          versionsRead: [],
          clock: null,
        },
        safeDefault: S1_09_SAFE_DEFAULT,
      },
    ]);
    expect(writes.stateEvents).toEqual([]);
    expect(writes.clockCancels).toEqual([]);
  });

  it("asks the settler once, after the rows before S1-04, with the call, S1-04 as the pinned graph holds it, the part, its choice, the turn and copies of the rows built so far", async () => {
    const walk = buttonsWalk();
    const today = await answer(buttonsWalk({ noButtons: true }), "c-01");
    const { part, context, choice } = await answer(walk, "c-01");
    expect(walk.asks).toHaveLength(1);
    const [ask] = walk.asks;
    expect(ask?.repo).toBe(context.repo);
    expect(ask?.businessId).toBe(context.businessId);
    expect(ask?.turn).toBe(context);
    expect(ask?.part).toBe(part);
    expect(ask?.choice).toBe(choice);
    expect(ask?.step).toMatchObject({ id: "S1-04", split: false, branches: [], buttons: 3, next: "S1-08" });
    expect(ask?.step.gives).toEqual(["companies"]);
    // Every row today's walk builds before S1-04's question: the close, S1-02's picks and the keys given so far.
    expect(ask?.rows).toEqual({
      versionsRead: today.writes.versionsRead,
      state: today.writes.state,
      stateEvents: [],
      asks: [],
      closes: today.writes.closes,
      messages: [],
      gives: today.writes.gives,
    });
  });

  it("what the settler does with the lists it is handed never changes the part's rows", async () => {
    const turn = turnTwoOnV1("c-01");
    const writes = await createWritesOfMutating()(turn.part, turn.context, NOTHING_OPEN);
    const clean = await answer(buttonsWalk(), "c-01");
    expect(writes).toEqual(clean.writes);
  });

  it("'One isn't on the list yet' walks S1-03 and S1-11, then S1-04 settled, S1-08's row and S1-09's question", async () => {
    const walk = buttonsWalk();
    const { writes } = await answer(walk, "c-02");
    expect(walk.log).toEqual([
      "question",
      "write S1-02",
      "write S1-03",
      "write S1-11",
      "settle S1-04",
      "write S1-08",
    ]);
    expect(rowsOf(writes)).toEqual([
      ["outbox-s1-03-sam-1", null],
      ["outbox-s1-08-sam-1", null],
      ["outbox-s1-09-sam-1", "oq-s1-09-sam-1"],
    ]);
    expect(askedSteps(writes)).toEqual(["S1-09"]);
    expect(writes.why).toEqual({ step: "S1-02", choice: ONE });
  });

  it("with T-1502's split settler bound too, a settled S1-02 answer walks on the same way: c-02 named, settled 'All on the list'", async () => {
    const named = await answer(buttonsWalk(), "c-01");
    const walk = buttonsWalk({ settledAtS1_02: ALL });
    const { writes } = await answer(walk, "c-02");
    expect(writes).toEqual(named.writes);
    expect(walk.asks).toHaveLength(1);
  });

  it("the same part twice asks the settler once each run and gives the same writes", async () => {
    const walk = buttonsWalk();
    const turn = turnTwoOnV1("c-01");
    const first = await walk.writesOf(turn.part, turn.context, NOTHING_OPEN);
    const second = await walk.writesOf(turn.part, turn.context, NOTHING_OPEN);
    expect(second).toEqual(first);
    expect(walk.asks).toHaveLength(2);
  });

  it("writes each row in K-05's own shapes (its outbox rows K-05 v1.22's), and goes into the commit's one K-05 v1.22 request with S1-09's clock row", async () => {
    const { writes, context, exchange } = await answer(buttonsWalk(), "c-01");
    const checks = contractChecks();
    for (const write of writes.state) expect(checks.k05("stateWrite", write)).toEqual([]);
    for (const ask of writes.asks) expect(checks.k05("openQuestionNew", ask.question)).toEqual([]);
    for (const row of writes.messages) expect(k05v122("outboxRowNew", row)).toEqual([]);
    for (const close of writes.closes) expect(checks.k05("openQuestionClose", close)).toEqual([]);
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
      units: [{ writes, answer: { openQuestionId: "oq-s1-02", optionId: null, eventId: "evt-sam-0001" } }],
    });
    expect(k05v122("commitTurn.request", request)).toEqual([]);
    const logged = eventLogRowsOf(request, exchange.request.now);
    for (const row of logged) expect(checks.k08("eventLogRow", row), String(row.id)).toEqual([]);
    expect(request.writes.openQuestions.open.map((question) => question.id)).toEqual(["oq-s1-09-sam-1"]);
    expect(request.writes.openQuestions.close.map((close) => close.id)).toEqual(["oq-s1-02"]);
    expect(request.writes.clockRows.make.map((clock) => clock.id)).toEqual(["clock-oq-s1-09-sam-1"]);
    expect(request.writes.outboxRows.map((row) => row.id)).toEqual([
      "outbox-s1-08-sam-1",
      "outbox-s1-09-sam-1",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T-1479: S1-09 as bundle v2 compiles it, a split whose message carries buttons, is asked as any split is

describe("S1-09 as bundle v2 compiles it (two buttons) is asked with its card's safe default and no options (T-1479)", () => {
  /** S1-09's compiled card, as bundle v2 holds it. */
  const compiledCard = () => stepIn(flowAV2(), "S1-09").card as { safeDefault: string; clock: unknown };

  it("on T-1491's test graph with the compiled S1-08 and S1-09: S1-08's row, then S1-09's question and its row, exactly as with no buttons", async () => {
    const graph = flowAWithCompiledPlan();
    const s1_09 = flowGraphOf(graph, "A").step("S1-09");
    expect(s1_09).toMatchObject({ split: true, buttons: 2, card: { clock: { from: "step9Default" } } });
    const plain = await answer(buttonsWalk(), "c-01");
    const { writes } = await answer(buttonsWalk({ graph }), "c-01");
    // The buttons' option ids are K-03's: none is stored, so the rows are those of S1-09 with no buttons.
    expect(writes).toEqual(plain.writes);
    expect(writes.asks.map((ask) => [ask.question.step, ask.question.options, ask.question.clock])).toEqual([
      ["S1-09", [], null],
    ]);
    expect(writes.asks.map((ask) => ask.safeDefault)).toEqual([compiledCard().safeDefault]);
    expect(compiledCard().safeDefault).toBe(S1_09_SAFE_DEFAULT);
    expect(writes.messages.map((row) => [row.id, row.openQuestionId, row.step, row.lineNo])).toEqual([
      ["outbox-s1-08-sam-1", null, "S1-08", 0],
      ["outbox-s1-09-sam-1", "oq-s1-09-sam-1", "S1-09", 0],
    ]);
    for (const row of writes.messages) expect(k05v122("outboxRowNew", row)).toEqual([]);
  });

  it("on bundle v2's own flow A: 'All on the list' walks to S1-09 and asks it, never notBuilt (buttons)", async () => {
    const walk = buttonsWalk({ graph: flowAV2() });
    const { writes } = await answer(walk, "c-01");
    expect(walk.log).toEqual(["question", "write S1-02", "write S1-11", "settle S1-04", "write S1-08"]);
    expect(askedSteps(writes)).toEqual(["S1-09"]);
    expect(writes.asks.map((ask) => ask.safeDefault)).toEqual([compiledCard().safeDefault]);
    expect(writes.messages.map((row) => [row.id, row.step, row.lineNo])).toEqual([
      ["outbox-s1-08-sam-1", "S1-08", 0],
      ["outbox-s1-09-sam-1", "S1-09", 0],
    ]);
  });

  it("the compiled S1-09 with a Clock line of its own is still notBuilt (clock): only its buttons changed", async () => {
    const graph = flowAWithCompiledPlan();
    (stepIn(graph, "S1-09").card as Record<string, unknown>).clock = { from: "clockLine", text: "24 h" };
    const error = await refusal(buttonsWalk({ graph }), "c-01");
    expect(error).toBeInstanceOf(WalkNotBuiltError);
    expect(error).toMatchObject({ seam: "clock", ids: ["S1-09"] });
  });
});

/**
 * The walk's writesOf with a buttons settler that pushes onto every list it is handed before answering S1-04's rows:
 * what it pushes must never reach the part's rows.
 */
function createWritesOfMutating() {
  const { bundles } = bundleV1Bundles({ A: flowAWithPlan() });
  const [intruder] = s1_04SettledRows().state;
  if (intruder === undefined) throw new Error("the stand-in rows hold a state row");
  return createWritesOf<WalkTestRepo>({
    bundles,
    turnKey: () => SAM,
    questions: questionsOver().questions,
    writers: (stepId) => planWriters()[stepId] ?? null,
    buttonsSettlers: () => (call) => {
      (call.rows.state as StateWrite[]).push(intruder);
      (call.rows.gives as string[]).push("business");
      return Promise.resolve(s1_04SettledRows());
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// "ask", or none bound: today's walk, byte for byte

describe("a settler answering 'ask', or none bound, leaves the walk as today", () => {
  it.each([
    ["answering 'ask'", { answer: "ask" }],
    ["bound at other steps only", { buttonsAt: ["S1-02", "S1-08", "S1-09"] }],
    ["binding none", { buttonsAt: [] }],
  ] as const)("commit-s1-02.json's walk on bundle v1 is unchanged with a settler %s", async (_, given) => {
    const today = buttonsWalk({ graph: flowAV1(), noButtons: true });
    const walk = buttonsWalk({ graph: flowAV1(), ...given });
    const before = await answer(today, "c-01");
    const { writes, exchange } = await answer(walk, "c-01");
    expect(writes).toEqual(before.writes);
    // commit-s1-02.json's walk: the three picks, S1-04's question and its row, oq-s1-02 closed, its gives.
    expect(askedSteps(writes)).toEqual(["S1-04"]);
    expect(rowsOf(writes)).toEqual([["outbox-s1-04-sam-1", "oq-s1-04-sam-1"]]);
    expect(writes.closes.map((close) => close.id)).toEqual(exchange.outcome.openQuestions.closed);
    expect(writes.gives).toEqual(exchange.given.stated.gives);
    expect(writes.state).toHaveLength(3);
    // The same reads and writer calls in the same order; an "ask" settler adds its one ask, after the rows before S1-04.
    const asked = "answer" in given ? ["settle S1-04"] : [];
    expect(walk.log).toEqual([...today.log, ...asked]);
  });

  it("on T-1491's test graph, 'ask' asks S1-04 exactly as today and never walks on to S1-08", async () => {
    const today = await answer(buttonsWalk({ noButtons: true }), "c-01");
    const walk = buttonsWalk({ answer: "ask" });
    const { writes } = await answer(walk, "c-01");
    expect(writes).toEqual(today.writes);
    expect(askedSteps(writes)).toEqual(["S1-04"]);
    expect(walk.log).toEqual(["question", "write S1-02", "write S1-11", "settle S1-04"]);
  });

  it("each of S1-02's branches, with the settlers left out or binding none, gives the same writes", async () => {
    for (const choiceId of ["c-01", "c-02", "c-03"]) {
      const leftOut = await answer(buttonsWalk({ noButtons: true }), choiceId);
      const none = buttonsWalk({ buttonsAt: [] });
      const bindNone = await answer(none, choiceId);
      expect(bindNone.writes, choiceId).toEqual(leftOut.writes);
      expect(none.asks).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// What fails closed

describe("a refusal, a throw, any other answer or a foreign key: nothing written, S1-04 not asked either", () => {
  it.each([
    ["refuses", new Error("the settler refused")],
    ["whose read fails", new Error("the settler's read failed")],
  ] as const)(
    "a settler that %s: the walk rejects with what it threw, after the settler and before S1-08",
    async (_, thrown) => {
      const walk = buttonsWalk({ answer: thrown });
      const error = await refusal(walk, "c-01");
      expect(error).toBe(thrown);
      expect(walk.asks).toHaveLength(1);
      expect(walk.log).toEqual(["question", "write S1-02", "write S1-11", "settle S1-04"]);
    },
  );

  it.each([
    ["'ask' in another case", "Ask"],
    ["an empty answer", ""],
    ["a button's label", "All share one"],
    ["no answer at all", null],
    ["a number", 1],
    ["a list", []],
    ["rows missing a list", { state: [], stateEvents: [], gives: ["companies"], asks: [] }],
    ["rows with a list that is no list", { ...s1_04SettledRows(), messages: "none" }],
  ] as const)("%s is refused (settledNotRows), naming the step alone", async (_, answered) => {
    const walk = buttonsWalk({ answer: answered });
    const error = await refusal(walk, "c-01");
    expectRefused(error, "settledNotRows", ["S1-04"]);
    expect(walk.log.at(-1)).toBe("settle S1-04");
    if (typeof answered === "string" && answered !== "") {
      expect((error as Error).message).not.toContain(answered);
    }
  });

  it.each([
    ["kinds, S1-02's", "kinds"],
    ["business, S1-09's", "business"],
    ["pf.license, S1-11's", "pf.license"],
  ] as const)(
    "rows giving %s key are refused (givesNotStep): S1-04 gives companies alone",
    async (_, key) => {
      const rows = s1_04SettledRows();
      const walk = buttonsWalk({ answer: { ...rows, gives: ["companies", key] } });
      expectRefused(await refusal(walk, "c-01"), "givesNotStep", ["S1-04", key]);
      expect(walk.log.at(-1)).toBe("settle S1-04");
    },
  );

  it("on bundle v1, which holds no S1-08, a walked S1-04 meets S1-08 missing: refused (stepNotInBundle), nothing written", async () => {
    const walk = buttonsWalk({ graph: flowAV1() });
    expectRefused(await refusal(walk, "c-01"), "stepNotInBundle", ["S1-08"]);
    expect(walk.log).toEqual(["question", "write S1-02", "write S1-11", "settle S1-04"]);
  });

  it("S1-08, which tells the owner, with no writer bound: not built (tells), found before anything of its stretch is read", async () => {
    const walk = buttonsWalk({ writers: allWriters() });
    const error = await refusal(walk, "c-01");
    expect(error).toBeInstanceOf(WalkNotBuiltError);
    expect(error).toMatchObject({ seam: "tells", ids: ["S1-08"] });
    expect(walk.log).toEqual(["question", "write S1-02", "write S1-11", "settle S1-04"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// One walk across both stretches: the loop check and MAX_WALK

describe("the loop check and MAX_WALK span both stretches", () => {
  it.each([
    ["S1-11, walked before S1-04", "S1-11"],
    ["S1-04, the walked step itself", "S1-04"],
    ["S1-02, the answered split", "S1-02"],
  ] as const)("S1-08 leading back to %s is refused (loop), nothing written", async (_, back) => {
    const graph = flowAWithPlan();
    stepIn(graph, "S1-08").next = back;
    const walk = buttonsWalk({ graph });
    expectRefused(await refusal(walk, "c-01"), "loop", [back]);
    // The second stretch is walked before any of its rows is built: S1-08's writer is never called.
    expect(walk.log).toEqual(["question", "write S1-02", "write S1-11", "settle S1-04"]);
    // Each stretch alone holds no loop: the first stops at S1-04, and the loop needs the steps before it.
    expect(
      walkFrom(flowGraphOf(graph, "A"), { kind: "branch", step: "S1-02", branch: ALL }).stop,
    ).toMatchObject({
      kind: "asks",
      step: { id: "S1-04" },
    });
  });

  it(`walks ${String(MAX_WALK)} steps across both stretches and refuses the next (walkTooLong), though the second alone holds fewer`, async () => {
    // Before the walk on: S1-02, S1-11 and S1-04 entered (3); after it: S1-08, the chain and S1-09.
    const fits = graphWithChain(MAX_WALK - 5);
    const { writes } = await answer(buttonsWalk({ graph: fits }), "c-01");
    expect(askedSteps(writes)).toEqual(["S1-09"]);
    const tooLong = graphWithChain(MAX_WALK - 4);
    const walk = buttonsWalk({ graph: tooLong });
    expectRefused(await refusal(walk, "c-01"), "walkTooLong", ["S1-09"]);
    // The second stretch alone, from S1-08: S1-08, the chain and S1-09, under the cap.
    expect(walkFrom(flowGraphOf(tooLong, "A"), { kind: "step", step: "S1-08" }).stop).toMatchObject({
      kind: "asks",
      step: { id: "S1-09" },
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// When no buttons settler is asked

describe("when the walk asks no buttons settler", () => {
  it.each([
    ["a threat's hold (never released)", { holds: [hold()], unreadEventIds: [] }],
    ["an after-safe hold", { holds: [hold("after_safe")], unreadEventIds: [] }],
    ["an at-once hold", { holds: [hold("at_once")], unreadEventIds: [] }],
    ["a text not yet read", { holds: [], unreadEventIds: ["evt-sam-0001"] }],
  ] as const)(
    "%s keeps the answer back at S1-02: no settler asked, nothing read or written",
    async (_, open) => {
      const walk = buttonsWalk();
      const { writes } = await answer(walk, "c-01", {
        holds: [...open.holds],
        unreadEventIds: [...open.unreadEventIds],
      });
      expectNothingWritten(writes);
      expect(walk.log).toEqual([]);
    },
  );

  it("holds are re-checked past the walked step: on a made-up graph, a protective step settled under a threat's hold, the routine S1-08 after it is held back", async () => {
    // A protective split answered (A3-48), its branch rejoining at a protective plain step with buttons (A7-11), whose
    // next is S1-08: the threat's hold lets both protective steps through, and holds back every routine one.
    const graph = flowAWithPlan();
    graph.steps["A3-48"] = {
      id: "A3-48",
      who: "san",
      to: "owner",
      via: "msg",
      type: "split",
      branches: [{ label: "Yes", tag: "message", steps: [], rejoinAt: "A7-11", effects: [], end: "merge" }],
      card: { clock: { from: "step9Default" } },
      next: null,
    };
    graph.steps["A7-11"] = {
      id: "A7-11",
      who: "san",
      to: "owner",
      via: "msg",
      say: [{ from: "san", to: "owner", elements: { buttons: ["OK"] } }],
      next: "S1-08",
    };
    const turn = turnTwoOnV1("c-01");
    const part: PassedPart = { ...turn.part, choice: { ...turn.choice, step: "A3-48", branch: "Yes" } };
    const rows = [{ ...s1_02QuestionRow(), step: "A3-48" }];
    const threat: OpenHolds = { holds: [hold()], unreadEventIds: [] };
    const settledRows = { state: [], stateEvents: [], gives: [], asks: [], messages: [] };
    const open = buttonsWalk({ graph, rows, buttonsAt: ["A7-11"], answer: settledRows });
    const free = await open.writesOf(part, turn.context, NOTHING_OPEN);
    expect(rowsOf(free)).toEqual([
      ["outbox-s1-08-sam-1", null],
      ["outbox-s1-09-sam-1", "oq-s1-09-sam-1"],
    ]);
    const held = buttonsWalk({ graph, rows, buttonsAt: ["A7-11"], answer: settledRows });
    const writes = await held.writesOf(part, turn.context, threat);
    expect(held.log).toEqual(["question", "settle A7-11"]);
    expect(writes.closes.map((close) => close.id)).toEqual(["oq-s1-02"]);
    expect(writes.messages).toEqual([]);
    expect(writes.asks).toEqual([]);
  });

  it("an option named at S1-04 (an answered S1-04, default 181's path) asks no buttons settler: the walk is today's", async () => {
    const turn = turnTwoOnV1("c-01");
    const atS1_04: PassedPart = {
      ...turn.part,
      choice: { ...turn.choice, step: "S1-04", branch: "All share one" },
    };
    const today = await refusal(buttonsWalk({ noButtons: true }), "c-01", atS1_04);
    const walk = buttonsWalk();
    const bound = await refusal(walk, "c-01", atS1_04);
    expectRefused(today, "branchNotInBundle", ["S1-04"]);
    expect(bound).toEqual(today);
    expect(walk.asks).toEqual([]);
  });

  it("a part that enters a step (turn 1's sign-up door, on bundle v0) stops at S1-02, a split: no buttons settler asked, whatever is bound", async () => {
    const { part, context } = turnOne();
    const asked: string[] = [];
    const deps = { bundles: skeletonBundles().bundles, turnKey: () => SAM };
    const today = await createWritesOf<WalkTestRepo>(deps)(part, context, NOTHING_OPEN);
    const bound = await createWritesOf<WalkTestRepo>({
      ...deps,
      buttonsSettlers: (stepId) => () => {
        asked.push(stepId);
        return Promise.resolve("ask");
      },
    })(part, context, NOTHING_OPEN);
    expect(bound).toEqual(today);
    expect(askedSteps(bound)).toEqual(["S1-02"]);
    expect(asked).toEqual([]);
  });

  it("a step S1-04 with no buttons is walked on as before, with no settler asked", async () => {
    const graph = flowAWithPlan();
    stepIn(graph, "S1-04").say = [{ from: "owner", to: "san" }];
    stepIn(graph, "S1-04").tells = [];
    stepIn(graph, "S1-04").gives = [];
    const walk = buttonsWalk({ graph });
    const { writes } = await answer(walk, "c-01");
    expect(walk.asks).toEqual([]);
    expect(askedSteps(writes)).toEqual(["S1-09"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// walk.ts: the walk in stretches

describe("walk.ts's stretches: walkFrom is the first alone, and walkOn goes past a plain step with buttons", () => {
  const graph = () => flowGraphOf(flowAWithPlan(), "A");

  it.each([ALL, ONE, "Not a service we book"])(
    "'%s': walkFrom's moves and stop are the first stretch's",
    (branch) => {
      const start = { kind: "branch", step: "S1-02", branch } as const;
      const stretch = walkStretchFrom(graph(), start);
      expect(walkFrom(graph(), start)).toEqual({ moves: stretch.moves, stop: stretch.stop });
    },
  );

  it("the first stretch stops at S1-04 and can walk on; the next walks S1-08 and stops at S1-09, a split, with no walk on", () => {
    const first = walkStretchFrom(graph(), { kind: "branch", step: "S1-02", branch: ALL });
    expect(first.stop).toMatchObject({ kind: "asks", step: { id: "S1-04", split: false } });
    expect(first.walkOn).not.toBeNull();
    const next = walkedOn(first);
    expect(next.moves.map((move) => (move.kind === "step" ? move.step.id : move.branch.label))).toEqual([
      "S1-08",
    ]);
    expect(next.stop).toMatchObject({ kind: "asks", step: { id: "S1-09", split: true } });
    expect(next.stop.kind === "asks" ? next.stop.step.branches.map((each) => each.label) : []).toEqual(
      S1_09_BRANCHES,
    );
    expect(next.walkOn).toBeNull();
    // A second walk on from the same stretch meets S1-08 again: a loop.
    expectRefused(
      thrownBySync(() => walkedOn(first)),
      "loop",
      ["S1-08"],
    );
  });

  it("an ending branch, and a door's stop at a split, have no walk on", () => {
    expect(
      walkStretchFrom(graph(), { kind: "branch", step: "S1-02", branch: "Not a service we book" }).walkOn,
    ).toBeNull();
    expect(walkStretchFrom(graph(), { kind: "step", step: "S1-01" }).walkOn).toBeNull();
  });

  it("where the walked step's list ends, the walk on climbs as walkFrom does: S1-04 on the main path ends the journey", () => {
    const value = flowAWithPlan();
    stepIn(value, "S1-04").next = null;
    const first = walkStretchFrom(flowGraphOf(value, "A"), { kind: "branch", step: "S1-02", branch: ALL });
    const next = walkedOn(first);
    expect(next.moves).toEqual([]);
    expect(next.stop).toMatchObject({ kind: "journeyEnds", step: { id: "S1-04" } });
    expect(next.walkOn).toBeNull();
  });
});
