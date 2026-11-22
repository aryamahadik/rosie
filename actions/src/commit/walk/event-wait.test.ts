// T-1532: the wait at an event step (K-09 README default 209; S1-10 slice card S10-2, DL-1151). A walked plain step whose
// gives hold a key a turn never gives (walk.ts EVENT_ONLY_KEYS: id_checked) ends the walk right after its own rows
// (waitsOnEvent): its next is never read, so a next the graph lacks is not refused; no question, no question row and no
// clock row are written for it. A writer (or a buttons settler) that gives id_checked is refused (eventKeyAtWalk), with
// nothing written. Every other stop is unchanged (a gate, a split, a step with buttons), a step the walk does reach that
// the bundle lacks is still refused, and the rule holds on a chosen branch and after a buttons settler's stretch.
//
// Proved on test graphs (bundle v0's flow A with bundle v3's compiled S1-10 placed after S1-01; bundle v1's and T-1491's
// with a step changed to give id_checked) and on bundle v3's own flow A (bundles/v3, T-1526), from S1-09's three
// branches: the owner's ends at S1-10, the no-match one after S1-76 then S1-10, and the helper's is refused notBuilt
// (tells) at S1-77 (README default 214), never stepNotInBundle at S1-75. The doubles are test-support's (the bundles
// port, the question read, stand-in writers and settlers), never a double of the walk.

import { describe, expect, it } from "vitest";

import type { SetupKey } from "../../gate/framework";
import { buildCommitRequest } from "../build";
import type { OpenHolds, PassedPart, UnitWrites } from "../types";
import {
  EVENT_ONLY_KEYS,
  WalkNotBuiltError,
  WalkRefusedError,
  createWritesOf,
  eventKeysIn,
  flowGraphOf,
  walkFrom,
  walkStretchFrom,
  type ButtonsSettler,
  type FlowGraph,
  type StepRows,
  type StepSettler,
  type StepWriter,
  type Stretch,
  type WalkFault,
  type WalkSeam,
  type Walked,
} from "./index";
import {
  NOTHING_OPEN,
  S1_09_BRANCHES,
  S1_09_QUESTION,
  SAM,
  bundleV1Bundles,
  bundleV3Bundles,
  flowA,
  flowAV1,
  flowAV2,
  flowAV3,
  flowAWithPlan,
  hold,
  k05v122,
  planWriters,
  questionsOver,
  s1_04SettledRows,
  s1_09QuestionRow,
  s1_10Writer,
  skeletonBundles,
  stepIn,
  turnOne,
  turnS1_09OnV3,
  turnTwoOnV1,
  waitWriters,
  writersOf,
  type GraphValue,
  type WalkTestRepo,
} from "./test-support";

const [OWNER, HELPER, NO_MATCH] = S1_09_BRANCHES as [string, string, string];

/** The table's one key (README default 209). */
const ID_CHECKED: SetupKey = "id_checked";

/** What a run threw, or null. */
async function thrownBy(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => null,
    (error: unknown) => error,
  );
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

function expectNotBuilt(error: unknown, seam: WalkSeam, ids: readonly string[]): void {
  expect(error).toBeInstanceOf(WalkNotBuiltError);
  expect(error).toMatchObject({ seam, ids, call: "gateAndCommit" });
}

/** A walk's moves by name: a step walked by its id, a branch taken by its label. */
function movesOf(walked: Walked): string[] {
  return walked.moves.map((move) => (move.kind === "step" ? move.step.id : `take ${move.branch.label}`));
}

/** A flow graph that writes down every step id the walk reads from it, in order, and every enclosing look. */
function recorded(graph: FlowGraph): { graph: FlowGraph; read: string[] } {
  const read: string[] = [];
  return {
    read,
    graph: {
      flow: graph.flow,
      step: (id) => {
        read.push(id);
        return graph.step(id);
      },
      onMainPath: (id) => graph.onMainPath(id),
      enclosing: (id) => {
        read.push(`enclosing ${id}`);
        return graph.enclosing(id);
      },
    },
  };
}

/**
 * The test graph: bundle v0's flow A with bundle v3's compiled S1-10 (a plain message step, san to owner, giving
 * id_checked and mobile, telling the owner) placed right after S1-01, its next `next` (bundle v3's own: S1-75, which no
 * test graph holds).
 */
function waitGraph(next: string | null = "S1-75"): GraphValue {
  const graph = flowA();
  graph.steps["S1-10"] = { ...stepIn(flowAV3(), "S1-10"), next };
  stepIn(graph, "S1-01").next = "S1-10";
  return graph;
}

/** The walk's writesOf over a test graph under bundle v0's pin, with stand-in writers, each call written down. */
function turnOneWalk(
  graph: GraphValue,
  writers: Readonly<Record<string, StepWriter<WalkTestRepo>>> = { "S1-10": s1_10Writer },
) {
  const { bundles } = skeletonBundles({ A: graph });
  const fake = writersOf(writers);
  return {
    writesOf: createWritesOf<WalkTestRepo>({ bundles, turnKey: () => SAM, writers: fake.writers }),
    calls: fake.calls,
  };
}

/** Turn 1 (commit-s1-01.json's part: the sign-up door to S1-01) on the walk, with what is open. */
async function turnOneOn(walk: ReturnType<typeof turnOneWalk>, open: OpenHolds = NOTHING_OPEN) {
  const turn = turnOne();
  const writes = await walk.writesOf(turn.part, turn.context, open);
  return { ...turn, writes };
}

/** A stand-in writer that gives `gives` and writes nothing else. */
function givingWriter(gives: readonly SetupKey[]): StepWriter<WalkTestRepo> {
  return () => Promise.resolve({ state: [], stateEvents: [], gives: [...gives], asks: [], messages: [] });
}

// ---------------------------------------------------------------------------------------------------------------
// walk.ts: the stop

describe("walk.ts: a walked plain step that gives id_checked ends the walk after it (waitsOnEvent)", () => {
  it("the table holds id_checked alone, and a step's table keys are read in its gives' order", () => {
    expect(EVENT_ONLY_KEYS).toEqual([ID_CHECKED]);
    expect(eventKeysIn(["mobile", ID_CHECKED])).toEqual([ID_CHECKED]);
    expect(eventKeysIn(["mobile", "thread", "business"])).toEqual([]);
  });

  it("walks S1-10 as a move, then stops waitsOnEvent naming S1-10 and id_checked; its next, S1-75, is never read", () => {
    const { graph, read } = recorded(flowGraphOf(waitGraph(), "A"));
    const walked = walkFrom(graph, { kind: "step", step: "S1-01" });
    expect(movesOf(walked)).toEqual(["S1-01", "S1-10"]);
    expect(walked.stop).toMatchObject({ kind: "waitsOnEvent", step: { id: "S1-10" }, keys: [ID_CHECKED] });
    expect(read).toEqual(["S1-01", "S1-10"]);
  });

  it("the rule is what stops it: the same S1-10 giving mobile alone walks on to S1-75, which the graph lacks: refused", () => {
    const graph = waitGraph();
    stepIn(graph, "S1-10").gives = ["mobile"];
    const error = thrownBySync(() => walkFrom(flowGraphOf(graph, "A"), { kind: "step", step: "S1-01" }));
    expectRefused(error, "stepNotInBundle", ["S1-75"]);
  });

  it("a next the graph holds is not walked either: S1-02 after S1-10 is never read or asked", () => {
    const { graph, read } = recorded(flowGraphOf(waitGraph("S1-02"), "A"));
    const walked = walkFrom(graph, { kind: "step", step: "S1-01" });
    expect(walked.stop).toMatchObject({ kind: "waitsOnEvent", step: { id: "S1-10" } });
    expect(read).not.toContain("S1-02");
  });

  it("a list that ends at the step (next null) still waits: where its list ends is not looked up", () => {
    const { graph, read } = recorded(flowGraphOf(waitGraph(null), "A"));
    const walked = walkFrom(graph, { kind: "step", step: "S1-01" });
    expect(walked.stop).toMatchObject({ kind: "waitsOnEvent", step: { id: "S1-10" } });
    expect(read).toEqual(["S1-01", "S1-10"]);
  });

  it("a stretch that waits on an event has no walk on", () => {
    const stretch = walkStretchFrom(flowGraphOf(waitGraph(), "A"), { kind: "step", step: "S1-01" });
    expect(stretch.stop.kind).toBe("waitsOnEvent");
    expect(stretch.walkOn).toBeNull();
  });

  it("an entered step that gives id_checked waits at once: its own move alone", () => {
    const walked = walkFrom(flowGraphOf(waitGraph(), "A"), { kind: "step", step: "S1-10" });
    expect(movesOf(walked)).toEqual(["S1-10"]);
    expect(walked.stop).toMatchObject({ kind: "waitsOnEvent", step: { id: "S1-10" }, keys: [ID_CHECKED] });
  });

  it("on a chosen branch: its own step that gives id_checked waits, and where the branch rejoins (S1-11) is never read", () => {
    const value = flowAV1();
    stepIn(value, "S1-03").gives = [ID_CHECKED];
    const { graph, read } = recorded(flowGraphOf(value, "A"));
    const walked = walkFrom(graph, { kind: "branch", step: "S1-02", branch: "One isn't on the list yet" });
    expect(movesOf(walked)).toEqual(["take One isn't on the list yet", "S1-03"]);
    expect(walked.stop).toMatchObject({ kind: "waitsOnEvent", step: { id: "S1-03" }, keys: [ID_CHECKED] });
    expect(read).not.toContain("S1-11");
  });

  it("after a buttons settler's stretch (default 199): the walk on from S1-04 waits at S1-08 when it gives id_checked, and S1-09 is never asked", () => {
    const value = flowAWithPlan();
    stepIn(value, "S1-08").gives = [ID_CHECKED];
    const first = walkStretchFrom(flowGraphOf(value, "A"), {
      kind: "branch",
      step: "S1-02",
      branch: "All on the list",
    });
    expect(first.stop).toMatchObject({ kind: "asks", step: { id: "S1-04" } });
    if (first.walkOn === null) throw new Error("S1-04's stretch walks on");
    const second: Stretch = first.walkOn();
    expect(movesOf(second)).toEqual(["S1-08"]);
    expect(second.stop).toMatchObject({ kind: "waitsOnEvent", step: { id: "S1-08" } });
    expect(second.walkOn).toBeNull();
  });

  it("after a button start (default 181): the walk on from the answered S1-04 waits at S1-08 when it gives id_checked", () => {
    const value = flowAV2();
    stepIn(value, "S1-08").gives = [ID_CHECKED];
    const walked = walkFrom(flowGraphOf(value, "A"), {
      kind: "button",
      step: "S1-04",
      branch: "All share one",
    });
    expect(movesOf(walked)).toEqual(["S1-04", "S1-08"]);
    expect(walked.stop).toMatchObject({ kind: "waitsOnEvent", step: { id: "S1-08" } });
  });
});

describe("walk.ts: every other stop is unchanged where a step gives id_checked (walk.ts default 4)", () => {
  it("a gated step that gives id_checked is still notBuilt (stepGate)", () => {
    const graph = waitGraph();
    stepIn(graph, "S1-10").when = { pf: ["x"] };
    const error = thrownBySync(() => walkFrom(flowGraphOf(graph, "A"), { kind: "step", step: "S1-01" }));
    expectNotBuilt(error, "stepGate", ["S1-10"]);
  });

  it("a plain step with buttons that gives id_checked still asks: the buttons are its question", () => {
    const graph = waitGraph();
    stepIn(graph, "S1-10").say = [
      { from: "san", to: "owner", text: "Pick", plainText: "Pick", elements: { buttons: ["Yes", "No"] } },
    ];
    const walked = walkFrom(flowGraphOf(graph, "A"), { kind: "step", step: "S1-01" });
    expect(movesOf(walked)).toEqual(["S1-01"]);
    expect(walked.stop).toMatchObject({ kind: "asks", step: { id: "S1-10" } });
  });

  it("a split that gives id_checked still asks (S1-02 here)", () => {
    const graph = flowA();
    stepIn(graph, "S1-02").gives = ["kinds", ID_CHECKED];
    const walked = walkFrom(flowGraphOf(graph, "A"), { kind: "step", step: "S1-01" });
    expect(walked.stop).toMatchObject({ kind: "asks", step: { id: "S1-02" } });
  });

  it("the answered step of a button start that gives id_checked is no wait: the walk goes on to S1-09's question", () => {
    const value = flowAV2();
    stepIn(value, "S1-04").gives = ["companies", ID_CHECKED];
    const walked = walkFrom(flowGraphOf(value, "A"), {
      kind: "button",
      step: "S1-04",
      branch: "All share one",
    });
    expect(movesOf(walked)).toEqual(["S1-04", "S1-08"]);
    expect(walked.stop).toMatchObject({ kind: "asks", step: { id: "S1-09" } });
  });

  it("with no step giving id_checked, the walk is today's: turn 1 stops at S1-02's question", () => {
    const walked = walkFrom(flowGraphOf(flowA(), "A"), { kind: "step", step: "S1-01" });
    expect(movesOf(walked)).toEqual(["S1-01"]);
    expect(walked.stop).toMatchObject({ kind: "asks", step: { id: "S1-02" } });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// writes.ts: the rows

describe("writes.ts: the wait writes the walked steps' rows and nothing for the stop", () => {
  it("turn 1 on the test graph: S1-01's thread, then S1-10's rows by its writer, and no question, no clock; gives thread and mobile", async () => {
    const walk = turnOneWalk(waitGraph());
    const { writes, exchange, context } = await turnOneOn(walk);
    expect(writes.state).toEqual(exchange.given.stated.writes.state);
    expect(writes.stateEvents.map((entry) => [entry.kind, entry.rowId])).toEqual([
      ["thread.created", "thread-s1-01-sam-1"],
    ]);
    expect(writes.asks).toEqual([]);
    expect(writes.closes).toEqual([]);
    expect(writes.versionsRead).toEqual([]);
    expect(writes.messages).toEqual([
      {
        id: "outbox-s1-10-sam-1",
        recipientHandleId: context.turn.handleId,
        recipientPersonId: exchange.request.caller.personId,
        businessId: "biz-lees-barbershop",
        bookingId: null,
        channel: "imessage",
        sendClass: "quick_reply",
        openQuestionId: null,
        copyOfRowId: null,
        versionsRead: [],
        step: "S1-10",
        lineNo: 2,
      },
    ]);
    expect(writes.gives).toEqual(["thread", "mobile"]);
    expect(writes.gives).not.toContain(ID_CHECKED);
    expect(walk.calls.map((call) => call.stepId)).toEqual(["S1-10"]);
  });

  it("the commit's one K-05 request from it opens no question and makes no clock row, and K-05 v1.22 takes it", async () => {
    const { writes, exchange, context } = await turnOneOn(turnOneWalk(waitGraph()));
    const request = buildCommitRequest({
      turn: context.turn,
      zone: "America/New_York",
      businessId: context.businessId,
      actor: { personId: exchange.request.caller.personId, roleAt: () => null },
      units: [{ writes, answer: null }],
    });
    expect(k05v122("commitTurn.request", request)).toEqual([]);
    expect(request.writes.openQuestions.open).toEqual([]);
    expect(request.writes.clockRows.make).toEqual([]);
    expect(
      request.writes.outboxRows.map((row) => [row.id, row.openQuestionId, row.step, row.lineNo]),
    ).toEqual([["outbox-s1-10-sam-1", null, "S1-10", 2]]);
  });

  it("nothing is written past the wait: S1-02 after S1-10 is not asked, and no row names it", async () => {
    const { writes } = await turnOneOn(turnOneWalk(waitGraph("S1-02")));
    expect(writes.asks).toEqual([]);
    expect(writes.messages.map((row) => row.step)).toEqual(["S1-10"]);
    expect(JSON.stringify(writes)).not.toMatch(/s1-02/iu);
  });

  it("with no writer bound for S1-10 the part is refused as today: notBuilt (tells), or (gives) when it tells no one", async () => {
    expectNotBuilt(await thrownBy(turnOneOn(turnOneWalk(waitGraph(), {}))), "tells", ["S1-10"]);
    const silent = waitGraph();
    stepIn(silent, "S1-10").tells = [];
    expectNotBuilt(await thrownBy(turnOneOn(turnOneWalk(silent, {}))), "gives", ["S1-10", ID_CHECKED]);
  });

  it("a hold stops it at its first routine row as before: nothing written, S1-10's writer never called", async () => {
    const walk = turnOneWalk(waitGraph());
    const { writes } = await turnOneOn(walk, { holds: [hold()], unreadEventIds: [] });
    expect(writes.state).toEqual([]);
    expect(writes.messages).toEqual([]);
    expect(writes.gives).toEqual([]);
    expect(walk.calls).toEqual([]);
  });

  it("the same part twice gives the same writes", async () => {
    const walk = turnOneWalk(waitGraph());
    const first = await turnOneOn(walk);
    const second = await turnOneOn(walk);
    expect(second.writes).toEqual(first.writes);
  });
});

describe("writes.ts: a writer never gives id_checked (eventKeyAtWalk)", () => {
  it("S1-10's writer giving id_checked beside mobile is refused, naming the step and the key, with nothing written", async () => {
    const error = await thrownBy(
      turnOneOn(turnOneWalk(waitGraph(), { "S1-10": givingWriter(["mobile", ID_CHECKED]) })),
    );
    expectRefused(error, "eventKeyAtWalk", ["S1-10", ID_CHECKED]);
  });

  it("a writer giving id_checked at a step that does not give it is refused eventKeyAtWalk, not givesNotStep", async () => {
    const error = await thrownBy(
      turnOneOn(turnOneWalk(waitGraph(), { "S1-01": givingWriter([ID_CHECKED]), "S1-10": s1_10Writer })),
    );
    expectRefused(error, "eventKeyAtWalk", ["S1-01", ID_CHECKED]);
    // A key its step does not give that is no table key is still givesNotStep.
    const other = await thrownBy(
      turnOneOn(turnOneWalk(waitGraph(), { "S1-01": givingWriter(["kinds"]), "S1-10": s1_10Writer })),
    );
    expectRefused(other, "givesNotStep", ["S1-01", "kinds"]);
  });

  it("the refusal names no words, no row id and no chat id", async () => {
    const error = await thrownBy(
      turnOneOn(turnOneWalk(waitGraph(), { "S1-10": givingWriter(["mobile", ID_CHECKED]) })),
    );
    const message = error instanceof Error ? error.message : "";
    expect(message).toContain("eventKeyAtWalk: S1-10, id_checked");
    for (const words of ["linq-chat", "outbox-", "Hi, I want"]) expect(message).not.toContain(words);
  });

  it("a buttons settler (default 199) whose rows give id_checked is refused eventKeyAtWalk, with nothing written", async () => {
    const { bundles } = bundleV1Bundles({ A: flowAWithPlan() });
    const settled: StepRows = { ...s1_04SettledRows(), gives: ["companies", ID_CHECKED] };
    const settler: ButtonsSettler<WalkTestRepo> = () => Promise.resolve(settled);
    const writesOf = createWritesOf<WalkTestRepo>({
      bundles,
      turnKey: () => SAM,
      questions: questionsOver().questions,
      writers: writersOf(planWriters()).writers,
      buttonsSettlers: (stepId) => (stepId === "S1-04" ? settler : null),
    });
    const turn = turnTwoOnV1("c-01");
    expectRefused(await thrownBy(writesOf(turn.part, turn.context, NOTHING_OPEN)), "eventKeyAtWalk", [
      "S1-04",
      ID_CHECKED,
    ]);
  });

  it("after a buttons settler's stretch, a walked S1-08 that gives id_checked ends the part's rows with its own: no S1-09 question", async () => {
    const value = flowAWithPlan();
    stepIn(value, "S1-08").gives = [ID_CHECKED];
    const { bundles } = bundleV1Bundles({ A: value });
    const settler: ButtonsSettler<WalkTestRepo> = () => Promise.resolve(s1_04SettledRows());
    const fake = writersOf(planWriters());
    const writesOf = createWritesOf<WalkTestRepo>({
      bundles,
      turnKey: () => SAM,
      questions: questionsOver().questions,
      writers: fake.writers,
      buttonsSettlers: (stepId) => (stepId === "S1-04" ? settler : null),
    });
    const turn = turnTwoOnV1("c-01");
    const writes = await writesOf(turn.part, turn.context, NOTHING_OPEN);
    expect(fake.calls.map((call) => call.stepId)).toEqual(["S1-02", "S1-11", "S1-08"]);
    expect(writes.asks).toEqual([]);
    expect(writes.messages.map((row) => [row.id, row.step, row.lineNo])).toEqual([
      ["outbox-s1-08-sam-1", "S1-08", 0],
    ]);
    expect(writes.gives).not.toContain(ID_CHECKED);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Bundle v3's own flow A, from S1-09's three branches

describe("bundle v3's own flow from S1-09's three branches: never stepNotInBundle at S1-75", () => {
  it("bundle v3 compiles S1-10 as the wait needs: a plain step with no gate and no buttons, giving id_checked and mobile, next S1-75, which it does not hold", () => {
    const graph = flowGraphOf(flowAV3(), "A");
    const s1_10 = graph.step("S1-10");
    expect(s1_10).toMatchObject({
      split: false,
      gated: false,
      buttons: 0,
      gives: [ID_CHECKED, "mobile"],
      tells: ["owner"],
      next: "S1-75",
    });
    expect(graph.step("S1-75")).toBeNull();
    expect(graph.step("S1-09")?.branches.map((branch) => branch.label)).toEqual(S1_09_BRANCHES);
  });

  it.each([
    [OWNER, ["take " + OWNER, "S1-10"], ["S1-09", "S1-10"]],
    [HELPER, ["take " + HELPER, "S1-77", "S1-10"], ["S1-09", "S1-77", "S1-10"]],
    [NO_MATCH, ["take " + NO_MATCH, "S1-76", "S1-10"], ["S1-09", "S1-76", "S1-10"]],
  ] as const)("walk.ts from %j: %j, then waitsOnEvent at S1-10; S1-75 never read", (branch, moves, read) => {
    const recording = recorded(flowGraphOf(flowAV3(), "A"));
    const walked = walkFrom(recording.graph, { kind: "branch", step: "S1-09", branch });
    expect(movesOf(walked)).toEqual(moves);
    expect(walked.stop).toMatchObject({ kind: "waitsOnEvent", step: { id: "S1-10" }, keys: [ID_CHECKED] });
    expect(recording.read).toEqual(read);
  });

  /** The walk over bundle v3 with S1-09's question read and the stand-in writers, each call written down. */
  function v3Walk(
    writers: Readonly<Record<string, StepWriter<WalkTestRepo>>> = waitWriters(),
    settler?: StepSettler<WalkTestRepo>,
  ) {
    const { bundles, reads } = bundleV3Bundles();
    const fake = writersOf(writers);
    const questions = questionsOver([s1_09QuestionRow()]);
    const writesOf = createWritesOf<WalkTestRepo>({
      bundles,
      turnKey: () => SAM,
      questions: questions.questions,
      writers: fake.writers,
      ...(settler === undefined
        ? {}
        : { settlers: (stepId: string) => (stepId === "S1-09" ? settler : null) }),
    });
    return { writesOf, reads, calls: fake.calls, questionReads: questions.reads };
  }

  /** The S1-09 turn naming `branch` (or the part given), on the walk. */
  async function answerOn(
    walk: ReturnType<typeof v3Walk>,
    branch: string,
    part?: PassedPart,
  ): Promise<UnitWrites> {
    const turn = turnS1_09OnV3(branch);
    return walk.writesOf(part ?? turn.part, turn.context, NOTHING_OPEN);
  }

  it("the owner's branch: S1-09's question closed, S1-09's rows then S1-10's, no question, gives business and mobile", async () => {
    const walk = v3Walk();
    const writes = await answerOn(walk, OWNER);
    expect(walk.calls.map((call) => call.stepId)).toEqual(["S1-09", "S1-10"]);
    expect(writes.closes).toEqual([
      { id: S1_09_QUESTION, expectVersion: 1, status: "answered", answeredOptionId: null },
    ]);
    expect(writes.versionsRead).toEqual([{ table: "open_questions", rowId: S1_09_QUESTION, version: 1 }]);
    expect(writes.asks).toEqual([]);
    expect(writes.messages.map((row) => [row.id, row.openQuestionId, row.step, row.lineNo])).toEqual([
      ["outbox-s1-10-sam-1", null, "S1-10", 2],
    ]);
    expect(writes.gives).toEqual(["business", "mobile"]);
    expect(writes.why).toEqual({ step: "S1-09", choice: OWNER });
  });

  it("the no-match branch: S1-09's rows, S1-76's, then S1-10's, and no question", async () => {
    const walk = v3Walk();
    const writes = await answerOn(walk, NO_MATCH);
    expect(walk.calls.map((call) => call.stepId)).toEqual(["S1-09", "S1-76", "S1-10"]);
    expect(writes.asks).toEqual([]);
    expect(writes.messages.map((row) => [row.id, row.step, row.lineNo])).toEqual([
      ["outbox-s1-76-sam-1", "S1-76", 0],
      ["outbox-s1-10-sam-1", "S1-10", 2],
    ]);
    expect(writes.gives).toEqual(["business", "mobile"]);
  });

  it("the helper's branch (a match): refused notBuilt (tells) at S1-77, which has no writer (default 214), before any read or writer", async () => {
    const walk = v3Walk();
    expectNotBuilt(await thrownBy(answerOn(walk, HELPER)), "tells", ["S1-77"]);
    expect(walk.calls).toEqual([]);
    expect(walk.questionReads).toEqual([]);
  });

  it("the owner's path's K-05 request: one close, no question opened, no clock row, and K-05 v1.22 takes it", async () => {
    const writes = await answerOn(v3Walk(), OWNER);
    const { context } = turnS1_09OnV3(OWNER);
    const request = buildCommitRequest({
      turn: context.turn,
      zone: "America/New_York",
      businessId: context.businessId,
      actor: { personId: context.request.caller.personId, roleAt: () => null },
      units: [
        { writes, answer: { openQuestionId: S1_09_QUESTION, optionId: null, eventId: "evt-sam-0001" } },
      ],
    });
    expect(k05v122("commitTurn.request", request)).toEqual([]);
    expect(request.writes.openQuestions.open).toEqual([]);
    expect(request.writes.openQuestions.close.map((close) => close.id)).toEqual([S1_09_QUESTION]);
    expect(request.writes.clockRows.make).toEqual([]);
  });

  it.each([OWNER, NO_MATCH])(
    "a bound S1-09 settler (default 191) answering %j writes what the option naming it writes",
    async (label) => {
      const named = await answerOn(v3Walk(), label);
      const settler: StepSettler<WalkTestRepo> = () => Promise.resolve(label);
      // The option decide named is the helper's: the settler's label is walked, never the named one.
      const settled = await answerOn(v3Walk(waitWriters(), settler), HELPER);
      expect(settled).toEqual(named);
    },
  );

  it("S1-10's writer giving id_checked is refused eventKeyAtWalk on bundle v3 too, on both paths that reach it", async () => {
    const writers = { ...waitWriters(), "S1-10": givingWriter(["mobile", ID_CHECKED]) };
    for (const branch of [OWNER, NO_MATCH]) {
      expectRefused(await thrownBy(answerOn(v3Walk(writers), branch)), "eventKeyAtWalk", [
        "S1-10",
        ID_CHECKED,
      ]);
    }
  });

  it("with no writer bound for S1-10, both paths that reach it are refused notBuilt (tells) at S1-10, before any read", async () => {
    const writers = waitWriters();
    Reflect.deleteProperty(writers, "S1-10");
    for (const branch of [OWNER, NO_MATCH]) {
      const walk = v3Walk(writers);
      expectNotBuilt(await thrownBy(answerOn(walk, branch)), "tells", ["S1-10"]);
      expect(walk.calls).toEqual([]);
      expect(walk.questionReads).toEqual([]);
    }
  });

  it("a bundle that lacks S1-10 still refuses it: stepNotInBundle at S1-10, never guessed", async () => {
    const value = flowAV3();
    Reflect.deleteProperty(value.steps, "S1-10");
    const { bundles } = bundleV3Bundles({ A: value });
    const writesOf = createWritesOf<WalkTestRepo>({
      bundles,
      turnKey: () => SAM,
      questions: questionsOver([s1_09QuestionRow()]).questions,
      writers: writersOf(waitWriters()).writers,
    });
    const turn = turnS1_09OnV3(OWNER);
    expectRefused(await thrownBy(writesOf(turn.part, turn.context, NOTHING_OPEN)), "stepNotInBundle", [
      "S1-10",
    ]);
  });

  it("each run reads the turn's pinned graph, bundle v3's, once, and the same part twice gives the same writes", async () => {
    const walk = v3Walk();
    const first = await answerOn(walk, OWNER);
    const second = await answerOn(walk, OWNER);
    expect(second).toEqual(first);
    expect(walk.reads.map((read) => read.flow)).toEqual(["A", "A"]);
  });
});
