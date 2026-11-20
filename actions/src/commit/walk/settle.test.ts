// T-1502: the settler port in the commit's walk (K-09 README default 191 as T-1499's round 2 corrects it; DL-1018 card 4,
// DL-1021). A bound settler at a split step is asked once for the branch before the walk reads a branch from the graph and
// before any writer; the walk never reads the named option's branch, label or choiceId to find it; a label the pinned
// graph does not hold, a refusal or a failed read fails the part closed with nothing written and the question unread;
// a held answer asks no settler; a settler bound at a step with no branches is never asked; with no settler bound the
// walk is exactly today's. Proved on bundle v1 with T-1461's doubles (the bundle port, the question read, the stand-in
// writers) and a stand-in settler, never a double of the walk. S1-02's own settler is journey-1/kinds' (settle.test.ts).

import { describe, expect, it } from "vitest";

import type { Choice } from "../../gate/framework";
import type { OpenHolds, PassedPart, UnitWrites } from "../types";
import {
  WalkNotBuiltError,
  WalkRefusedError,
  createWritesOf,
  type StepSettler,
  type StepSettlerCall,
  type StepWriter,
  type WalkDeps,
  type WalkFault,
} from "./index";
import {
  NOTHING_OPEN,
  SAM,
  allWriters,
  branchIn,
  bundleV1Bundles,
  flowAV1,
  hold,
  questionsOver,
  skeletonBundles,
  turnOne,
  turnTwoOnV1,
  type GraphValue,
  type WalkTestRepo,
} from "./test-support";

const ALL = "All on the list";
const ONE = "One isn't on the list yet";
const NOT = "Not a service we book";

/** What the settled walk is given: the settler's answer (a label, or what it throws), the graph, what is bound. */
interface Given {
  /** The stand-in settler's answer: a label (any value, as a settler might answer it), or an Error it rejects with. */
  readonly answer?: unknown;
  readonly graph?: GraphValue;
  /** The step ids a settler is bound to. Default: S1-02. */
  readonly settledAt?: readonly string[];
  /** Leave the settlers out of the walk's deps entirely (today's walk). */
  readonly noSettlers?: boolean;
  /** Leave the question read out. */
  readonly noQuestions?: boolean;
}

/** One call a writer was given, as these tests read it: its step, the branch it was handed, and the part's choice id. */
interface Wrote {
  readonly stepId: string;
  readonly branch: string | null;
  readonly choiceId: string;
}

/** The walk on bundle v1 with a stand-in settler; every ask, question read and writer call written down in one log. */
function settledWalk(given: Given = {}) {
  const { bundles, reads } = bundleV1Bundles({ A: given.graph ?? flowAV1() });
  const log: string[] = [];
  const asks: StepSettlerCall<WalkTestRepo>[] = [];
  const wrote: Wrote[] = [];
  const fake = questionsOver();
  const questions: WalkDeps<WalkTestRepo>["questions"] = {
    liveQuestion(repo, handleId, id) {
      log.push("question");
      return fake.questions.liveQuestion(repo, handleId, id);
    },
  };
  const bound = new Map(Object.entries(allWriters()));
  const writers = (stepId: string): StepWriter<WalkTestRepo> | null => {
    const writer = bound.get(stepId);
    if (writer === undefined) return null;
    return (call) => {
      log.push(`write ${call.step.id}`);
      wrote.push({ stepId: call.step.id, branch: call.choice.branch, choiceId: call.choice.choiceId });
      return writer(call);
    };
  };
  const answer = Object.hasOwn(given, "answer") ? given.answer : ALL;
  const settler: StepSettler<WalkTestRepo> = (call) => {
    log.push(`settle ${call.step.id}`);
    asks.push(call);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer as string);
  };
  const settledAt = new Set(given.settledAt ?? ["S1-02"]);
  const writesOf = createWritesOf<WalkTestRepo>({
    bundles,
    turnKey: () => SAM,
    ...(given.noQuestions === true ? {} : { questions }),
    writers,
    ...(given.noSettlers === true
      ? {}
      : { settlers: (stepId: string) => (settledAt.has(stepId) ? settler : null) }),
  });
  return { writesOf, reads, log, asks, wrote, questionReads: fake.reads };
}

type Walk = ReturnType<typeof settledWalk>;

/** Turn 2's part naming `choiceId` (or the part given), answered by the walk with what is open. */
async function answer(walk: Walk, choiceId: string, open: OpenHolds = NOTHING_OPEN, part?: PassedPart) {
  const turn = turnTwoOnV1(choiceId);
  const writes = await walk.writesOf(part ?? turn.part, turn.context, open);
  return { ...turn, writes };
}

/** What turn 2's part naming `choiceId` threw on the walk, or null. */
async function refusal(walk: Walk, choiceId: string): Promise<unknown> {
  const turn = turnTwoOnV1(choiceId);
  return walk.writesOf(turn.part, turn.context, NOTHING_OPEN).then(
    () => null,
    (thrown: unknown) => thrown,
  );
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

/** S1-02's three branches, as bundle v1's flow A holds them. */
const S1_02_BRANCHES = [ALL, ONE, NOT];

// ---------------------------------------------------------------------------------------------------------------

describe("the walk asks S1-02's bound settler once, before it walks, and never reads the named option to find the branch", () => {
  it("asks once, before the question read and any writer, on the call's repo and business, with S1-02 as the pinned graph holds it, the part, its choice and the turn", async () => {
    const walk = settledWalk();
    const { writes, part, context, choice } = await answer(walk, "c-01");
    expect(walk.asks).toHaveLength(1);
    const [ask] = walk.asks;
    expect(ask?.repo).toBe(context.repo);
    expect(ask?.businessId).toBe(context.businessId);
    expect(ask?.turn).toBe(context);
    expect(ask?.part).toBe(part);
    expect(ask?.choice).toBe(choice);
    expect(ask?.step.id).toBe("S1-02");
    expect(ask?.step.split).toBe(true);
    expect(ask?.step.branches.map((branch) => branch.label)).toEqual(S1_02_BRANCHES);
    // The settler first; then the question's close is read, then each writer in the walk's order.
    expect(walk.log).toEqual(["settle S1-02", "question", "write S1-02", "write S1-11"]);
    expect(writes.closes.map((close) => close.id)).toEqual(["oq-s1-02"]);
  });

  it.each(["c-01", "c-02", "c-03"])(
    "%s named, settled 'All on the list': the writes of today's c-01 walk, each writer handed the settled branch",
    async (choiceId) => {
      const today = await answer(settledWalk({ noSettlers: true }), "c-01");
      const walk = settledWalk({ answer: ALL });
      const { writes } = await answer(walk, choiceId);
      expect(writes).toEqual(today.writes);
      expect(writes.why).toEqual({ step: "S1-02", choice: ALL });
      expect(walk.wrote).toEqual([
        { stepId: "S1-02", branch: ALL, choiceId },
        { stepId: "S1-11", branch: ALL, choiceId },
      ]);
    },
  );

  it.each([
    [ONE, ["S1-02", "S1-03", "S1-11"], ["outbox-s1-03-sam-1", "outbox-s1-04-sam-1"]],
    [NOT, ["S1-02", "S1-74"], ["outbox-s1-74-sam-1"]],
  ] as const)(
    "c-01 named, settled '%s': that branch is walked as a chosen one, its why naming it",
    async (settled, steps, rows) => {
      const walk = settledWalk({ answer: settled });
      const { writes } = await answer(walk, "c-01");
      expect(walk.wrote.map((each) => each.stepId)).toEqual(steps);
      expect(walk.wrote.every((each) => each.branch === settled)).toBe(true);
      expect(writes.messages.map((row) => row.id)).toEqual(rows);
      expect(writes.closes.map((close) => close.id)).toEqual(["oq-s1-02"]);
      expect(writes.why).toEqual({ step: "S1-02", choice: settled });
      // The same as today's walk of the option that names that branch.
      const today = await answer(settledWalk({ noSettlers: true }), settled === ONE ? "c-02" : "c-03");
      expect(writes).toEqual(today.writes);
    },
  );

  it("a choice with no branch, no label and another id still walks the settled branch: none of them is read to find it", async () => {
    const turn = turnTwoOnV1("c-02");
    const unread: Choice = { ...turn.choice, branch: null, label: "", choiceId: "c-unread" };
    const part: PassedPart = { ...turn.part, choice: unread };
    // Today's walk refuses it, since it walks the named option's branch.
    const today = await settledWalk({ noSettlers: true })
      .writesOf(part, turn.context, NOTHING_OPEN)
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );
    expectRefused(today, "branchNotInBundle", ["S1-02"]);
    // With the settler bound, the words' branch is walked; the writers are handed it as the branch chosen.
    const walk = settledWalk({ answer: ALL });
    const { writes } = await answer(walk, "c-02", NOTHING_OPEN, part);
    expect(writes.why).toEqual({ step: "S1-02", choice: ALL });
    expect(walk.wrote.map((each) => [each.stepId, each.branch])).toEqual([
      ["S1-02", ALL],
      ["S1-11", ALL],
    ]);
    expect(writes.closes.map((close) => close.id)).toEqual(["oq-s1-02"]);
  });

  it("the unit's why names the step and the settled branch, never the option named or the person's words", async () => {
    const { writes, choice } = await answer(settledWalk({ answer: ONE }), "c-01");
    expect(writes.why).toEqual({ step: "S1-02", choice: ONE });
    expect(JSON.stringify(writes.why)).not.toContain(choice.label);
    expect(JSON.stringify(writes.why)).not.toContain("Barbershop");
  });

  it("the same part twice asks the settler once each run and gives the same writes", async () => {
    const walk = settledWalk({ answer: ALL });
    const turn = turnTwoOnV1("c-02");
    const first = await walk.writesOf(turn.part, turn.context, NOTHING_OPEN);
    const second = await walk.writesOf(turn.part, turn.context, NOTHING_OPEN);
    expect(second).toEqual(first);
    expect(walk.asks).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("an answer the walk cannot take fails the part closed: nothing written, no writer called, the question unread", () => {
  it.each([
    ["a label S1-02 does not hold", "Maybe on the list"],
    ["a label in another case", "all on the list"],
    ["an empty label", ""],
    ["no label at all", null],
    ["a number", 3],
  ] as const)("%s is refused (settledNotInBundle), naming the step alone", async (_, answered) => {
    const walk = settledWalk({ answer: answered });
    const error = await refusal(walk, "c-01");
    expectRefused(error, "settledNotInBundle", ["S1-02"]);
    expect(walk.wrote).toEqual([]);
    expect(walk.questionReads).toEqual([]);
    expect(walk.log).toEqual(["settle S1-02"]);
    if (typeof answered === "string" && answered !== "") {
      expect((error as Error).message).not.toContain(answered);
    }
  });

  it("a later cut that rewords S1-02's branch fails closed: the label is checked against the turn's pinned graph", async () => {
    const graph = flowAV1();
    branchIn(graph, "S1-02", ALL).label = "Every kind on the list";
    const walk = settledWalk({ answer: ALL, graph });
    expectRefused(await refusal(walk, "c-01"), "settledNotInBundle", ["S1-02"]);
    expect(walk.wrote).toEqual([]);
  });

  it.each([
    ["refuses", new Error("the settler refused")],
    ["whose read fails", new Error("the settler's read failed")],
  ] as const)("a settler that %s: the walk rejects with what it threw", async (_, thrown) => {
    const walk = settledWalk({ answer: thrown });
    const error = await refusal(walk, "c-02");
    expect(error).toBe(thrown);
    expect(walk.asks).toHaveLength(1);
    expect(walk.wrote).toEqual([]);
    expect(walk.questionReads).toEqual([]);
  });

  it("with no question read bound, an answer is notBuilt (answer) and the settler is never asked", async () => {
    const walk = settledWalk({ noQuestions: true });
    const error = await refusal(walk, "c-01");
    expect(error).toBeInstanceOf(WalkNotBuiltError);
    expect(error).toMatchObject({ seam: "answer", ids: ["S1-02"] });
    expect(walk.asks).toEqual([]);
    expect(walk.wrote).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("when the walk asks no settler", () => {
  it.each([
    ["a threat's hold (never released)", { holds: [hold()], unreadEventIds: [] }],
    ["an after-safe hold", { holds: [hold("after_safe")], unreadEventIds: [] }],
    ["an at-once hold", { holds: [hold("at_once")], unreadEventIds: [] }],
    ["a text not yet read", { holds: [], unreadEventIds: ["evt-sam-0001"] }],
  ] as const)(
    "%s keeps the answer back: no settler asked, nothing read or written, its why the step alone",
    async (_, open) => {
      const walk = settledWalk();
      const { writes } = await answer(walk, "c-02", {
        holds: [...open.holds],
        unreadEventIds: [...open.unreadEventIds],
      });
      expectNothingWritten(writes);
      expect(writes.why).toEqual({ step: "S1-02", choice: null });
      expect(walk.log).toEqual([]);
    },
  );

  it("a settler bound at a step with no branches is never asked: an option named at S1-04 walks as today", async () => {
    const turn = turnTwoOnV1("c-01");
    const atS1_04: PassedPart = { ...turn.part, choice: { ...turn.choice, step: "S1-04" } };
    const run = (walk: Walk) =>
      walk.writesOf(atS1_04, turn.context, NOTHING_OPEN).then(
        () => null,
        (thrown: unknown) => thrown,
      );
    const bound = settledWalk({ settledAt: ["S1-02", "S1-04"] });
    const today = await run(settledWalk({ noSettlers: true }));
    const settled = await run(bound);
    expectRefused(today, "branchNotInBundle", ["S1-04"]);
    expect(settled).toEqual(today);
    expect(bound.asks).toEqual([]);
  });

  it("a part that enters a step (turn 1's sign-up door, on bundle v0) asks no settler, whatever is bound", async () => {
    const { part, context, exchange } = turnOne();
    const asked: string[] = [];
    const deps = {
      bundles: skeletonBundles().bundles,
      turnKey: () => SAM,
      questions: questionsOver().questions,
    };
    const today = await createWritesOf<WalkTestRepo>(deps)(part, context, NOTHING_OPEN);
    const settled = await createWritesOf<WalkTestRepo>({
      ...deps,
      settlers: (stepId) => (call) => {
        asked.push(stepId);
        return Promise.resolve(call.step.branches[0]?.label ?? "");
      },
    })(part, context, NOTHING_OPEN);
    expect(settled).toEqual(today);
    // Turn 1's own writes: S1-01's thread, then S1-02's question asked (commit-s1-01.json).
    expect(settled.asks.map((ask) => ask.question.step)).toEqual(["S1-02"]);
    expect(settled.gives).toEqual(exchange.given.stated.gives);
    expect(asked).toEqual([]);
  });

  it.each(["c-01", "c-02", "c-03"])(
    "%s named with settlers that bind none, or left out: today's walk of the named option",
    async (choiceId) => {
      const leftOut = await answer(settledWalk({ noSettlers: true }), choiceId);
      const none = settledWalk({ settledAt: [] });
      const bindNone = await answer(none, choiceId);
      expect(bindNone.writes).toEqual(leftOut.writes);
      expect(leftOut.writes.why).toEqual({ step: "S1-02", choice: leftOut.choice.branch });
      expect(none.asks).toEqual([]);
    },
  );
});
