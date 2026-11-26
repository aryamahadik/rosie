// T-1562: the walk on the text path (ruling T-1543 card B6, its Gives (a) to (d); K-01 v1.1's stop; K-09 v1.14 defaults
// 223 and 226 to 229, 234 and 235, its Gives (e) to (i)). Proved on the text path's test graph (test-support flowARest:
// bundle v3's flow A with the sign-up steps after S1-10 in K-01 v1.1's shape, S1-23 and S1-12 being K-01 v1.1's own
// fixtures) and on bundle v3 itself (no stop field), with the doubles test-support gives: the bundles port, the question
// read, stand-in writers and stand-in reach settlers, each call written down, never a double of the walk.
//
//   - the stop field (graph.ts, walk.ts): asksByWords stops as an asked step with no options, read before the step's
//     buttons (S1-12's later read-back buttons ask nothing and are no labels); waitsOnEvent stops as default 209 does,
//     naming the field's keys; a step with no stop keeps default 209's table and default 214 (S1-77 still refused);
//   - reach settlers (default 227): asked where the walk reaches the split, before atSplit, with no part or choice, after
//     the rows before it are built; a label is written as walked (no question closed, its tells kept), "wait" a
//     waitsOnEvent stop on the table's key (S1-32 alone), "ask" the split asked (S1-32's refused, recipient: default
//     225); a label the split lacks, or any other answer, refused with nothing written; with none bound, today's stop;
//   - asks-by-words answers (default 228) and owner-lane asks and answers (default 229);
//   - the event table (default 223) and the waiting-step starts (defaults 226, 234 and 235).

import { describe, expect, it } from "vitest";

import type { Choice, SetupKey } from "../../gate/framework";
import type { OpenHolds, PassedPart, UnitWrites } from "../types";
import {
  EVENT_ONLY_KEYS,
  EVENT_TABLE,
  REACH_ASKS,
  REACH_WAITS,
  WalkNotBuiltError,
  WalkRefusedError,
  createWritesOf,
  flowGraphOf,
  waitingKeyAt,
  walkFrom,
  walkStretchFrom,
  type FlowGraph,
  type OpenStepWriter,
  type OpenStepWriterCall,
  type ReachAnswer,
  type StartedWriterCall,
  type StepWriter,
  type Stretch,
  type WaitingStart,
  type WalkFault,
  type WalkSeam,
  type Walked,
} from "./index";
import {
  NOTHING_OPEN,
  S1_09_BRANCHES,
  S1_09_QUESTION,
  S1_29_BRANCHES,
  S1_32_BRANCHES,
  S1_35_BRANCHES,
  S1_60_BRANCHES,
  S1_71_BRANCHES,
  S1_75_BRANCHES,
  SAM,
  bundleV3Bundles,
  contextOf,
  flowARest,
  flowARestPastTheWait,
  flowAV3,
  givingOnlyWriter,
  hold,
  questionRowAt,
  questionsOver,
  reachSettlersOf,
  restWriters,
  s1_09QuestionRow,
  stepIn,
  tellingWriter,
  turnAnswering,
  turnS1_09OnV3,
  waitWriters,
  writersOf,
  type GraphValue,
  type WalkTestRepo,
} from "./test-support";

const [OWNER_MATCH, HELPER] = S1_09_BRANCHES as [string, string, string];
const [CODE_PATH, TEAM_CHECKS] = S1_75_BRANCHES;
const [NO_AGREEMENT] = S1_71_BRANCHES;
const [A_LICENSE] = S1_60_BRANCHES;
const [NOTHING_LEFT] = S1_29_BRANCHES;
const [CONFIRMED] = S1_32_BRANCHES;
const [, , ONE_KIND] = S1_35_BRANCHES;

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

/** A walk's moves by name: a step walked by its id (an answered one marked), a branch taken by its label. */
function movesOf(walked: Walked): string[] {
  return walked.moves.map((move) => {
    if (move.kind === "step") return move.answered === undefined ? move.step.id : `answer ${move.step.id}`;
    return `${move.reached === true ? "reach" : "take"} ${move.branch.label}`;
  });
}

/** The text path's test graph as the walk reads it (flow A), or another graph value given. */
function restGraph(value: GraphValue = flowARest()): FlowGraph {
  return flowGraphOf(value, "A");
}

/** The stretch's walk on past the split it stops at, as its reach settler answered. */
function reachOn(stretch: Stretch, answer: ReachAnswer): Stretch {
  if (stretch.reach === null) throw new Error("the stretch stops at a split a reach settler is asked at");
  return stretch.reach(answer);
}

const branch = (label: string): ReachAnswer => ({ kind: "branch", label });

/** The walk's options for the splits `bound` (a reach settler bound for each). */
const reachingAt = (...bound: string[]) => ({ reaches: (id: string) => bound.includes(id) });

/** The question ids of the rows a unit writes, by kind: the questions asked, closed and the rows' steps and lines. */
function shapeOf(writes: UnitWrites) {
  return {
    asked: writes.asks.map((ask) => [ask.question.step, ask.question.options, ask.question.readback]),
    closed: writes.closes.map((close) => [close.id, close.status, close.answeredOptionId]),
    rows: writes.messages.map((row) => [row.step, row.lineNo, row.openQuestionId]),
    gives: writes.gives,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// graph.ts: the stop field and line 0

describe("graph.ts: K-01 v1.1's stop is read per step from the pinned graph, before the step's buttons", () => {
  it("S1-23 (stop-ask-s1-23.json) asks by words with its license field; line 0 is Rosie's to the owner", () => {
    const s1_23 = restGraph().step("S1-23");
    expect(s1_23?.stop).toEqual({ kind: "asksByWords", answerFields: [{ name: "license", type: "text" }] });
    expect(s1_23?.firstLine).toEqual({ from: "san", to: "owner" });
    expect(s1_23?.buttonLabels).toEqual([]);
  });

  it("S1-12's later line from Rosie carries the read-back's buttons: counted, yet never its first ask's labels (R38)", () => {
    const s1_12 = restGraph().step("S1-12");
    expect(s1_12?.stop?.kind).toBe("asksByWords");
    expect(s1_12?.buttons).toBe(2);
    expect(s1_12?.buttonLabels).toEqual([]);
  });

  it("a step with no stop carries none (bundle v3, which K-01 v1 wrote): S1-10 and S1-77 read as before", () => {
    const graph = flowGraphOf(flowAV3(), "A");
    for (const id of ["S1-10", "S1-77", "S1-04"]) expect(graph.step(id)).not.toHaveProperty("stop");
    expect(graph.step("S1-04")?.buttonLabels.length).toBeGreaterThan(0);
  });

  it("waitsOnEvent is read with its keys; the manifest's contract value stays bundle.v1 (R34)", () => {
    const value = flowAV3();
    stepIn(value, "S1-10").stop = { waitsOnEvent: { keys: ["id_checked"] } };
    expect(value.contract).toBe("bundle.v1");
    expect(flowGraphOf(value, "A").step("S1-10")?.stop).toEqual({
      kind: "waitsOnEvent",
      keys: ["id_checked"],
    });
  });

  it.each([
    ["a stop on a split", "S1-75", { asksByWords: { answerFields: [] } }],
    ["both kinds", "S1-23", { asksByWords: { answerFields: [] }, waitsOnEvent: { keys: ["id_checked"] } }],
    ["neither kind", "S1-23", {}],
    ["a kind not K-01 v1.1's", "S1-23", { asksByPage: {} }],
    ["a choice field", "S1-23", { asksByWords: { answerFields: [{ name: "license", type: "choice" }] } }],
    ["a wait with no key", "S1-10", { waitsOnEvent: { keys: [] } }],
  ])("%s is refused stepNotWellFormed, never read in part", (_, id, stop) => {
    const value = flowARest();
    stepIn(value, id).stop = stop;
    expectRefused(
      thrownBySync(() => restGraph(value).step(id)),
      "stepNotWellFormed",
      [id],
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
// walk.ts: the event table, the stop field, reach settlers and the waiting-step starts

describe("walk.ts: the event table holds id_checked and control_proven, each with its one waiting step (default 223)", () => {
  it("EVENT_ONLY_KEYS is still a list of keys, and each key's waiting step stands beside it", () => {
    expect(EVENT_ONLY_KEYS).toEqual(["id_checked", "control_proven"]);
    expect(EVENT_TABLE).toEqual([
      { key: "id_checked", step: "S1-10" },
      { key: "control_proven", step: "S1-32" },
    ]);
    expect([waitingKeyAt("S1-10"), waitingKeyAt("S1-32"), waitingKeyAt("S1-75")]).toEqual([
      "id_checked",
      "control_proven",
      null,
    ]);
  });
});

describe("walk.ts: asksByWords stops as an asked step; waitsOnEvent as default 209; no stop keeps the table", () => {
  it("S1-12 stops asked though its later line carries buttons: no buttons settler's walk on, no reach", () => {
    const stretch = walkStretchFrom(restGraph(), { kind: "step", step: "S1-12" });
    expect(stretch.stop).toMatchObject({ kind: "asks", step: { id: "S1-12" } });
    expect(stretch.moves).toEqual([]);
    expect([stretch.walkOn, stretch.reach]).toEqual([null, null]);
  });

  it("a waitsOnEvent field names its own keys and is read over the table: S1-10 giving mobile alone still waits", () => {
    const value = flowARest();
    Object.assign(stepIn(value, "S1-10"), {
      gives: ["mobile"],
      stop: { waitsOnEvent: { keys: ["id_checked"] } },
    });
    const walked = walkFrom(restGraph(value), { kind: "step", step: "S1-10" });
    expect(movesOf(walked)).toEqual(["S1-10"]);
    expect(walked.stop).toMatchObject({ kind: "waitsOnEvent", step: { id: "S1-10" }, keys: ["id_checked"] });
  });

  it("a graph with no stop field keeps default 209's table: S1-10 waits on the id_checked it gives", () => {
    const walked = walkFrom(restGraph(), { kind: "step", step: "S1-10" });
    expect(movesOf(walked)).toEqual(["S1-10"]);
    expect(walked.stop).toMatchObject({ kind: "waitsOnEvent", keys: ["id_checked"] });
  });
});

describe("walk.ts: a split a reach settler is bound for stops the walk before atSplit (reaches), then goes on as it answers", () => {
  it("bound at S1-75 alone: the walk stops reaching S1-75, nothing of it a move; unbound, S1-75 is notBuilt lookup", () => {
    const start = { kind: "event", step: "S1-10", key: "id_checked", ref: "upload-1" } as const;
    const stretch = walkStretchFrom(restGraph(), start, reachingAt("S1-75"));
    expect(stretch.stop).toMatchObject({ kind: "reaches", step: { id: "S1-75" } });
    expect(stretch.moves).toEqual([]);
    expectNotBuilt(
      thrownBySync(() => walkStretchFrom(restGraph(), start)),
      "lookup",
      ["S1-75"],
    );
  });

  it("S1-75, S1-71 and S1-60 settled by their answers: each branch reached (written as walked), S1-23 then asked", () => {
    const graph = restGraph();
    const start = { kind: "resume", step: "S1-10", key: "id_checked" } as const;
    const first = walkStretchFrom(graph, start, reachingAt("S1-75", "S1-71", "S1-60"));
    const second = reachOn(first, branch(TEAM_CHECKS));
    expect(movesOf(second)).toEqual([`reach ${TEAM_CHECKS}`]);
    expect(second.stop).toMatchObject({ kind: "reaches", step: { id: "S1-71" } });
    const third = reachOn(second, branch(NO_AGREEMENT));
    expect(movesOf(third)).toEqual([`reach ${NO_AGREEMENT}`]);
    const last = reachOn(third, branch(A_LICENSE));
    expect(movesOf(last)).toEqual([`reach ${A_LICENSE}`]);
    expect(last.stop).toMatchObject({ kind: "asks", step: { id: "S1-23" } });
  });

  it("'ask' stops asking the split; 'wait' only where the table lists it; a label the split lacks: settledNotInBundle", () => {
    const graph = restGraph();
    const at75 = walkStretchFrom(
      graph,
      { kind: "resume", step: "S1-10", key: "id_checked" },
      reachingAt("S1-75"),
    );
    expect(reachOn(at75, { kind: "ask" }).stop).toMatchObject({ kind: "asks", step: { id: "S1-75" } });
    expectRefused(
      thrownBySync(() => reachOn(at75, { kind: "wait" })),
      "settledNotInBundle",
      ["S1-75"],
    );
    expectRefused(
      thrownBySync(() => reachOn(at75, branch("2 Yes: sign it now"))),
      "settledNotInBundle",
      ["S1-75"],
    );
  });
});

describe("walk.ts: the waiting-step starts (WalkStart event and resume: defaults 226, 234 (1) and 235)", () => {
  const starts: WaitingStart[] = [
    { kind: "event", step: "S1-10", key: "id_checked", ref: "upload-demo-owner-1" },
    { kind: "resume", step: "S1-10", key: "id_checked" },
  ];

  it.each(starts)(
    "a $kind start at S1-10 walks on from S1-75, with nothing of S1-10 walked again",
    (start) => {
      const stretch = walkStretchFrom(restGraph(), start, reachingAt("S1-75", "S1-71", "S1-60"));
      expect(stretch.stop).toMatchObject({ kind: "reaches", step: { id: "S1-75" } });
      const walked = [stretch, reachOn(stretch, branch(CODE_PATH))];
      expect(walked.flatMap((each) => movesOf(each))).toEqual([`reach ${CODE_PATH}`]);
      expect(JSON.stringify(walked.map((each) => each.moves))).not.toContain('"id":"S1-10"');
    },
  );

  it.each([
    { kind: "event", step: "S1-32", key: "control_proven", ref: "item-demo-owner-1" },
    { kind: "resume", step: "S1-32", key: "control_proven" },
  ] as WaitingStart[])(
    "a $kind start at S1-32 asks its reach settler again; 'wait' again waits, nothing walked",
    (start) => {
      const stretch = walkStretchFrom(restGraph(), start, reachingAt("S1-32", "S1-35"));
      expect(stretch.stop).toMatchObject({ kind: "reaches", step: { id: "S1-32" } });
      const again = reachOn(stretch, { kind: "wait" });
      expect(again.moves).toEqual([]);
      expect(again.stop).toMatchObject({
        kind: "waitsOnEvent",
        step: { id: "S1-32" },
        keys: ["control_proven"],
      });
      expect([again.walkOn, again.reach]).toEqual([null, null]);
      const confirmed = reachOn(stretch, branch(CONFIRMED));
      expect(confirmed.stop).toMatchObject({ kind: "reaches", step: { id: "S1-35" } });
    },
  );

  it("a start whose step and key are no pair of the event table is refused notWaitingStep, naming them alone", () => {
    for (const [step, key] of [
      ["S1-10", "control_proven"],
      ["S1-32", "id_checked"],
      ["S1-75", "id_checked"],
    ] as const) {
      expectRefused(
        thrownBySync(() => walkFrom(restGraph(), { kind: "resume", step, key })),
        "notWaitingStep",
        [step, key],
      );
    }
  });

  it("a waiting split with no reach settler bound stops as today: S1-32, all lookup, notBuilt", () => {
    expectNotBuilt(
      thrownBySync(() => walkFrom(restGraph(), { kind: "resume", step: "S1-32", key: "control_proven" })),
      "lookup",
      ["S1-32"],
    );
  });
});

describe("walk.ts: an asks-by-words answer starts at its step, applied as answered, then its next (default 228)", () => {
  it("S1-23 answered: its move answers it (no label), then the walk climbs past S1-60 to S1-12, asked", () => {
    const walked = walkFrom(restGraph(), { kind: "words", step: "S1-23" });
    expect(movesOf(walked)).toEqual(["answer S1-23"]);
    expect(walked.moves[0]).toMatchObject({ kind: "step", answered: null });
    expect(walked.stop).toMatchObject({ kind: "asks", step: { id: "S1-12" } });
  });

  it("a words start at a step that does not ask by words is refused branchNotInBundle", () => {
    for (const id of ["S1-21", "S1-75", "S1-10"]) {
      expectRefused(
        thrownBySync(() => walkFrom(restGraph(), { kind: "words", step: id })),
        "branchNotInBundle",
        [id],
      );
    }
  });

  it("a read-back's button never answers the first ask: 'That's right' at S1-12 is branchNotInBundle", () => {
    expectRefused(
      thrownBySync(() => walkFrom(restGraph(), { kind: "button", step: "S1-12", branch: "That's right" })),
      "branchNotInBundle",
      ["S1-12"],
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
// writes.ts: the walk's rows

/** The walk's writesOf over the text path's test graph under bundle v3's pin, with stand-ins, each call written down. */
function restWalk(
  options: {
    graph?: GraphValue;
    reach?: Parameters<typeof reachSettlersOf>[0];
    writers?: Readonly<Record<string, StepWriter<WalkTestRepo>>>;
    questions?: Parameters<typeof questionsOver>[0];
  } = {},
) {
  const { bundles } = bundleV3Bundles({ A: options.graph ?? flowARestPastTheWait() });
  const writers = writersOf(options.writers ?? restWriters());
  const reach = reachSettlersOf(options.reach ?? {});
  const questions = questionsOver(options.questions ?? [s1_09QuestionRow()]);
  return {
    writesOf: createWritesOf<WalkTestRepo>({
      bundles,
      turnKey: () => SAM,
      questions: questions.questions,
      writers: writers.writers,
      reachSettlers: reach.reachSettlers,
    }),
    writerCalls: writers.calls,
    reachCalls: reach.calls,
  };
}

/** A turn's one part through a walk, with what is open. */
async function run(
  walk: ReturnType<typeof restWalk>,
  turn: { part: PassedPart; context: ReturnType<typeof contextOf> },
  open: OpenHolds = NOTHING_OPEN,
): Promise<UnitWrites> {
  return walk.writesOf(turn.part, turn.context, open);
}

/** Reach settlers answering the sign-up's code-settled splits up to S1-23 as the ruling's defaults do (R4, R7, R8). */
const TO_S1_23 = { "S1-75": TEAM_CHECKS, "S1-71": NO_AGREEMENT, "S1-60": A_LICENSE };

describe("writes.ts: reach settlers, asked where the walk reaches a split (default 227; R1)", () => {
  it("S1-75's stub settles it, written as walked; S1-71 and S1-60 settled and walked through; S1-23 asked of the owner", async () => {
    const walk = restWalk({ reach: TO_S1_23 });
    const writes = await run(walk, turnS1_09OnV3(OWNER_MATCH));
    expect(walk.reachCalls.map((call) => call.stepId)).toEqual(["S1-75", "S1-71", "S1-60"]);
    // S1-75's writer runs as a walked step's, with its tells kept (its row), and no question but S1-09's is closed.
    expect(walk.writerCalls.map((call) => [call.stepId, call.writerLane])).toEqual([
      ["S1-09", "owner"],
      ["S1-75", "owner"],
    ]);
    expect(shapeOf(writes)).toEqual({
      asked: [["S1-23", [], null]],
      closed: [[S1_09_QUESTION, "answered", null]],
      rows: [
        ["S1-75", 0, null],
        ["S1-23", 0, "oq-s1-23-sam-1"],
      ],
      gives: ["business"],
    });
    expect(writes.versionsRead).toEqual([{ table: "open_questions", rowId: S1_09_QUESTION, version: 1 }]);
    // S1-23's question goes to the turn's own handle and person.
    const [asked] = writes.asks;
    const turn = turnS1_09OnV3(OWNER_MATCH);
    expect(asked?.question).toMatchObject({
      handleId: turn.context.turn.handleId,
      personId: turn.context.request.caller.personId,
      clock: null,
    });
    expect(writes.messages.at(-1)).toMatchObject({
      recipientHandleId: turn.context.turn.handleId,
      sendClass: "quick_reply",
    });
  });

  it("a reach settler is called with no part or choice: the call, the split, the turn and the rows built so far", async () => {
    const walk = restWalk({ reach: TO_S1_23 });
    await run(walk, turnS1_09OnV3(OWNER_MATCH));
    for (const call of walk.reachCalls) {
      expect(call.keys).toEqual(["businessId", "repo", "rows", "step", "turn"]);
      expect(call.businessId).toBe(turnS1_09OnV3(OWNER_MATCH).context.businessId);
    }
    // S1-75's settler reads the rows before it (S1-09's), S1-71's S1-75's row too.
    expect(walk.reachCalls.map((call) => [call.stepId, call.rowsSoFar, call.givesSoFar])).toEqual([
      ["S1-75", 0, ["business"]],
      ["S1-71", 1, ["business"]],
      ["S1-60", 1, ["business"]],
    ]);
  });

  it("an unbound auto split: notBuilt lookup, nothing written; with none bound, S1-75 itself", async () => {
    const one = restWalk({ reach: { "S1-75": TEAM_CHECKS } });
    expectNotBuilt(await thrownBy(run(one, turnS1_09OnV3(OWNER_MATCH))), "lookup", ["S1-71"]);
    const none = restWalk();
    expectNotBuilt(await thrownBy(run(none, turnS1_09OnV3(OWNER_MATCH))), "lookup", ["S1-75"]);
    expect(none.reachCalls).toEqual([]);
  });

  it.each([
    ["a label the split lacks", "2 No license: registration only", "settledNotInBundle"],
    ["'wait' at a split the event table does not list", REACH_WAITS, "settledNotInBundle"],
  ] as const)("%s is refused, nothing written", async (_, answer, fault) => {
    const walk = restWalk({ reach: { ...TO_S1_23, "S1-71": answer } });
    expectRefused(await thrownBy(run(walk, turnS1_09OnV3(OWNER_MATCH))), fault, ["S1-71"]);
    expect(walk.reachCalls.map((call) => call.stepId)).toEqual(["S1-75", "S1-71"]);
  });

  it("an answer that is no text is refused settledNotRows; a settler's own refusal fails the call as thrown", async () => {
    const odd = restWalk({
      reach: { ...TO_S1_23, "S1-71": () => Promise.resolve(JSON.parse("7") as string) },
    });
    expectRefused(await thrownBy(run(odd, turnS1_09OnV3(OWNER_MATCH))), "settledNotRows", ["S1-71"]);
    const refusal = new Error("the plug-in read failed");
    const failing = restWalk({ reach: { ...TO_S1_23, "S1-71": () => Promise.reject(refusal) } });
    expect(await thrownBy(run(failing, turnS1_09OnV3(OWNER_MATCH)))).toBe(refusal);
  });

  it("'ask' at S1-75 asks it as any split is asked: its card's safe default, no options, its row naming S1-75 and line 0", async () => {
    const walk = restWalk({ reach: { "S1-75": REACH_ASKS } });
    const writes = await run(walk, turnS1_09OnV3(OWNER_MATCH));
    expect(walk.writerCalls.map((call) => call.stepId)).toEqual(["S1-09"]);
    expect(shapeOf(writes).asked).toEqual([["S1-75", [], null]]);
    expect(writes.asks[0]?.safeDefault).toBe(
      "Rosie's team checks, and that company stays offline until then.",
    );
    expect(shapeOf(writes).rows).toEqual([["S1-75", 0, "oq-s1-75-sam-1"]]);
  });

  it("a hold that keeps the walk back asks no reach settler and writes nothing of the split or after it", async () => {
    const walk = restWalk({ reach: TO_S1_23 });
    const writes = await run(walk, turnS1_09OnV3(OWNER_MATCH), { holds: [hold()], unreadEventIds: [] });
    expect(walk.reachCalls).toEqual([]);
    expect(writes.messages).toEqual([]);
    expect(writes.asks).toEqual([]);
  });

  it("an unread text keeps the walk back as a hold does: no reach settler asked, nothing closed", async () => {
    // An unread text holds every routine row (hold.ts isHeld); every sign-up step is routine, the part's own included.
    const walk = restWalk({ reach: TO_S1_23 });
    const writes = await run(walk, turnS1_09OnV3(OWNER_MATCH), {
      holds: [],
      unreadEventIds: ["event-unread"],
    });
    expect(walk.reachCalls).toEqual([]);
    expect(writes.closes).toEqual([]);
  });
});

describe("writes.ts: S1-32 and S1-35 at reach (R22, R23; defaults 225 and 227)", () => {
  /** The turn answering S1-29's question "1 Nothing left to sign". */
  const s1_29 = () => turnAnswering("S1-29", "oq-s1-29-sam", NOTHING_LEFT);
  const s1_29Row = () => [questionRowAt("S1-29", "oq-s1-29-sam")];

  it("S1-32's stub answers wait: the walk stops waitsOnEvent, nothing of S1-32 written (no question, row or clock)", async () => {
    const walk = restWalk({ reach: { "S1-32": REACH_WAITS }, questions: s1_29Row() });
    const writes = await run(walk, s1_29());
    expect(walk.reachCalls.map((call) => call.stepId)).toEqual(["S1-32"]);
    expect(shapeOf(writes)).toEqual({
      asked: [],
      closed: [["oq-s1-29-sam", "answered", null]],
      rows: [],
      gives: ["terms", "bill_card"],
    });
    expect(JSON.stringify(writes)).not.toContain("s1-32");
  });

  it("S1-32 confirmed, S1-35's stub takes its added branch to S1-50: S1-35 written as walked, then S1-50 and S1-79", async () => {
    const walk = restWalk({ reach: { "S1-32": CONFIRMED, "S1-35": ONE_KIND }, questions: s1_29Row() });
    const writes = await run(walk, s1_29());
    expect(walk.reachCalls.map((call) => call.stepId)).toEqual(["S1-32", "S1-35"]);
    expect(walk.writerCalls.map((call) => call.stepId)).toEqual(["S1-29", "S1-35", "S1-50", "S1-79"]);
    expect(shapeOf(writes)).toEqual({
      asked: [],
      closed: [["oq-s1-29-sam", "answered", null]],
      rows: [
        ["S1-35", 0, null],
        ["S1-50", 0, null],
        ["S1-79", 0, null],
      ],
      gives: ["terms", "bill_card", "live"],
    });
  });

  it("'ask' at S1-32 is refused by the walk's ask: notBuilt recipient (san -> out), nothing written", async () => {
    const walk = restWalk({ reach: { "S1-32": REACH_ASKS }, questions: s1_29Row() });
    expectNotBuilt(await thrownBy(run(walk, s1_29())), "recipient", ["S1-32"]);
  });

  it("a writer that gives control_proven is refused eventKeyAtWalk, naming the step and the key alone", async () => {
    const writers = {
      ...restWriters(),
      "S1-35": givingOnlyWriter(JSON.parse('["control_proven"]') as SetupKey[]),
    };
    const walk = restWalk({
      reach: { "S1-32": CONFIRMED, "S1-35": ONE_KIND },
      questions: s1_29Row(),
      writers,
    });
    expectRefused(await thrownBy(run(walk, s1_29())), "eventKeyAtWalk", ["S1-35", "control_proven"]);
  });
});

describe("writes.ts: asks-by-words answers and owner-lane asks and answers (defaults 228 and 229; R2, R30)", () => {
  it("S1-23's answer closes its question, writes its gives and its later lines (tells kept), and walks on with writer lane owner", async () => {
    const walk = restWalk({ questions: [questionRowAt("S1-23", "oq-s1-23-sam")] });
    const writes = await run(walk, turnAnswering("S1-23", "oq-s1-23-sam"));
    expect(walk.writerCalls.map((call) => [call.stepId, call.choiceId, call.writerLane])).toEqual([
      ["S1-23", "oq-s1-23-sam", "owner"],
    ]);
    expect(shapeOf(writes)).toEqual({
      // S1-12 asks by words though its later line carries the read-back's buttons: no options, no read-back.
      asked: [["S1-12", [], null]],
      closed: [["oq-s1-23-sam", "answered", null]],
      rows: [
        ["S1-23", 0, null],
        ["S1-12", 0, "oq-s1-12-sam-1"],
      ],
      gives: ["license"],
    });
    expect(writes.versionsRead).toEqual([{ table: "open_questions", rowId: "oq-s1-23-sam", version: 1 }]);
  });

  it("an owner -> san buttons step asked by text: S1-12's answer asks S1-21 of the owner, its row naming S1-21 and line 0", async () => {
    const walk = restWalk({ questions: [questionRowAt("S1-12", "oq-s1-12-sam")] });
    const writes = await run(walk, turnAnswering("S1-12", "oq-s1-12-sam"));
    expect(shapeOf(writes)).toMatchObject({
      asked: [["S1-21", [], null]],
      rows: [
        ["S1-12", 0, null],
        ["S1-21", 0, "oq-s1-21-sam-1"],
      ],
    });
  });

  it("an owner -> san page step asked by text: S1-21's button answered, S1-24 asked of the owner", async () => {
    const walk = restWalk({ questions: [questionRowAt("S1-21", "oq-s1-21-sam")] });
    const writes = await run(walk, turnAnswering("S1-21", "oq-s1-21-sam", "Keep them"));
    expect(walk.writerCalls.map((call) => [call.stepId, call.writerLane])).toEqual([["S1-21", "owner"]]);
    expect(shapeOf(writes)).toEqual({
      asked: [["S1-24", [], null]],
      closed: [["oq-s1-21-sam", "answered", null]],
      rows: [["S1-24", 0, "oq-s1-24-sam-1"]],
      gives: ["booking_rules", "price_oks"],
    });
  });

  it("an owner -> san page split asked by text: S1-24's button answered, S1-29 asked with its card's safe default", async () => {
    const walk = restWalk({ questions: [questionRowAt("S1-24", "oq-s1-24-sam")] });
    const writes = await run(walk, turnAnswering("S1-24", "oq-s1-24-sam", "None booked yet"));
    expect(shapeOf(writes).asked).toEqual([["S1-29", [], null]]);
    expect(writes.asks[0]?.safeDefault).toBe("that work stays offline, saved.");
  });

  const buttons = { buttons: ["Keep them", "Change one"] };
  it.each([
    [
      "line 0 is not Rosie's",
      {
        say: [
          { from: "owner", to: "san" },
          { from: "san", to: "owner", elements: buttons },
        ],
      },
    ],
    ["line 0 is Rosie's to someone else", { say: [{ from: "san", to: "staff", elements: buttons }] }],
    ["the step is another lane's", { who: "staff" }],
    ["the step goes by portal", { via: "portal" }],
  ])("an owner-lane step is not asked when %s: notBuilt recipient", async (_, change) => {
    const graph = flowARest();
    Object.assign(stepIn(graph, "S1-21"), change);
    const walk = restWalk({ graph, questions: [questionRowAt("S1-12", "oq-s1-12-sam")] });
    expectNotBuilt(await thrownBy(run(walk, turnAnswering("S1-12", "oq-s1-12-sam"))), "recipient", ["S1-21"]);
  });

  it("default 116's shape at a step that does not ask by words is read as before: refused branchNotInBundle", async () => {
    const walk = restWalk({ questions: [questionRowAt("S1-21", "oq-s1-21-sam")] });
    const words = turnAnswering("S1-21", "oq-s1-21-sam");
    expectRefused(await thrownBy(run(walk, words)), "branchNotInBundle", ["S1-21"]);
    const unnamed: Choice = { ...words.choice, branch: null };
    const none = { part: { ...words.part, choice: unnamed }, context: words.context };
    expectRefused(await thrownBy(run(walk, none)), "branchNotInBundle", ["S1-21"]);
    expect(walk.writerCalls).toEqual([]);
  });

  it("an asks-by-words answer with no branch at all is read once the graph is: S1-23 answered", async () => {
    const walk = restWalk({ questions: [questionRowAt("S1-23", "oq-s1-23-sam")] });
    const words = turnAnswering("S1-23", "oq-s1-23-sam");
    const unnamed: Choice = { ...words.choice, branch: null };
    const writes = await run(walk, { part: { ...words.part, choice: unnamed }, context: words.context });
    expect(shapeOf(writes).closed).toEqual([["oq-s1-23-sam", "answered", null]]);
  });

  it("a read-back's 'That's right' never answers S1-12's first ask: branchNotInBundle, nothing written", async () => {
    const walk = restWalk({ questions: [questionRowAt("S1-12", "oq-s1-12-sam")] });
    const answer = turnAnswering("S1-12", "oq-s1-12-sam", "That's right");
    expectRefused(await thrownBy(run(walk, answer)), "branchNotInBundle", ["S1-12"]);
  });
});

describe("writes.ts: a graph with no stop field keeps K-01 v1's reading (default 209's table, default 214)", () => {
  it("bundle v3: S1-09's owner branch waits after S1-10, and its helper branch is still refused at S1-77 (notBuilt, tells)", async () => {
    const { bundles } = bundleV3Bundles();
    const questions = questionsOver([s1_09QuestionRow()]);
    const writers = writersOf(waitWriters());
    const deps = {
      bundles,
      turnKey: () => SAM,
      questions: questions.questions,
      writers: writers.writers,
      reachSettlers: reachSettlersOf(TO_S1_23).reachSettlers,
    };
    const owner = turnS1_09OnV3(OWNER_MATCH);
    const writes = await createWritesOf<WalkTestRepo>(deps)(owner.part, owner.context, NOTHING_OPEN);
    expect(writes.asks).toEqual([]);
    expect(writes.messages.map((row) => row.step)).toEqual(["S1-10"]);
    const helper = turnS1_09OnV3(HELPER);
    expectNotBuilt(
      await thrownBy(createWritesOf<WalkTestRepo>(deps)(helper.part, helper.context, NOTHING_OPEN)),
      "tells",
      ["S1-77"],
    );
  });
});

describe("writes.ts: the writer call left open to a waiting step's start (default 234 (1); A11 fills it)", () => {
  it("a writer that takes the start is bound as any step writer and runs unchanged on a turn's part and choice", async () => {
    const seen: string[] = [];
    const open: OpenStepWriter<WalkTestRepo> = (call: OpenStepWriterCall<WalkTestRepo>) => {
      if (call.start !== undefined) {
        seen.push(`start ${call.start.kind}`);
        return Promise.resolve({ state: [], stateEvents: [], gives: [], asks: [], messages: [] });
      }
      seen.push(`part ${call.choice.choiceId}`);
      return tellingWriter(call);
    };
    const walk = restWalk({ reach: TO_S1_23, writers: { ...restWriters(), "S1-75": open } });
    const writes = await run(walk, turnS1_09OnV3(OWNER_MATCH));
    expect(seen).toEqual([`part ${turnS1_09OnV3(OWNER_MATCH).choice.choiceId}`]);
    expect(writes.messages.map((row) => row.step)).toEqual(["S1-75", "S1-23"]);
  });

  it("a started call carries the start in place of the part and its choice, its why the waiting step with no choice", async () => {
    const turn = turnS1_09OnV3(OWNER_MATCH);
    const graph = restGraph();
    const step = graph.step("S1-75");
    if (step === null) throw new Error("the graph holds S1-75");
    const call: StartedWriterCall<WalkTestRepo> = {
      repo: turn.context.repo,
      step,
      start: { kind: "event", step: "S1-10", key: "id_checked", ref: "upload-demo-owner-1" },
      writer: {
        turn: turn.context,
        why: { step: "S1-10", choice: null },
        zone: "America/New_York",
        writerLane: "owner",
        rowId: (kind) => `${kind}-s1-75-${SAM}-1`,
        text: () => ({ service: "imessage", chatId: "unused" }),
      },
    };
    const kinds: string[] = [];
    const open: OpenStepWriter<WalkTestRepo> = (given) => {
      kinds.push(given.start?.kind ?? "part");
      return Promise.resolve({ state: [], stateEvents: [], gives: [], asks: [], messages: [] });
    };
    await open(call);
    expect(kinds).toEqual(["event"]);
    expect([call.part, call.choice, call.writer.why]).toEqual([
      undefined,
      undefined,
      { step: "S1-10", choice: null },
    ]);
  });
});
