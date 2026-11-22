// T-1480: walk, part 2 (K-09 README defaults 181, 187 and 188; the S1-04 design ruling's card 11, DL-999; DL-1106). An
// open question's option whose step, in the turn's pinned graph, is no split (S1-04, a plain step whose message carries
// buttons) answers one of that step's buttons: its branch must be one of the step's button labels in that graph, word
// for word, else the part is refused (branchNotInBundle) with nothing read or returned. The walk then closes the live
// question at its row's version (answeredOptionId null: none was stored), writes the step as an answer (its gives
// through its writer, its message not again) and walks on from its next, with T-1479's stamps. Proved on bundle v2's
// flow A (bundles/v2, T-1477) with K-09's commit-s1-04.json (the roster owner answers "All share one"), the bundles
// port, the question read and stand-in writers for S1-04 (T-1481's) and S1-08 (T-1482's), never a double of the walk:
// oq-s1-04 closed at its version, S1-04's rows, S1-08's row (S1-08, line 0, no question), then S1-09's question and its
// row, the fixture's stated rows, with S1-10 never read. Also: a label that is no button is refused; a missing S1-04 or
// S1-08 writer is refused before any read; a hold stops the walk at its first routine row; the same part twice gives
// equal writes; no buttons settler (T-1491) or split settler (T-1502) is asked at the answered step; graph.ts keeps the
// button labels as the frontier reads them (T-1478).

import { describe, expect, it } from "vitest";

import type { OpenQuestionRead } from "../../../../db/repo/targets";
import { flowViewOf } from "../../frontier/assemble/bundle";
import { copy } from "../../gate/framework/test-support";
import { buildCommitRequest } from "../build";
import { contractChecks, eventLogRowsOf } from "../test-support";
import type { OpenHolds, PassedPart, UnitWrites } from "../types";
import {
  WalkNotBuiltError,
  WalkRefusedError,
  createWritesOf,
  flowGraphOf,
  walkFrom,
  walkStretchFrom,
  type ButtonsSettler,
  type StepRows,
  type StepSettler,
  type StepWriter,
  type StepWriterCall,
  type WalkBundles,
  type WalkFault,
  type WalkSeam,
} from "./index";
import {
  NOTHING_OPEN,
  ROSTER,
  ROSTER_HANDLE,
  bundleV2Bundles,
  bundleV2Id,
  buttonAnswerWriters,
  decidedOf,
  flowAV1,
  flowAV2,
  hold,
  k05v122,
  questionsOver,
  s1_04QuestionRow,
  s1_04Writer,
  stepIn,
  tellingWriter,
  turnS1_04OnV2,
  type GraphValue,
  type WalkTestRepo,
} from "./test-support";

const ALL_SHARE = "All share one";

/** S1-04's buttons as bundle v2 holds them (byte for byte bundle v1's: K-09 README default 188). */
const S1_04_BUTTONS = ["Some share one", ALL_SHARE, "Each is its own"];

/** What the walk is given: the graph, the question rows, the writers and what else is bound. */
interface Given {
  /** Default: bundle v2's flow A. */
  readonly graph?: GraphValue;
  /** Default: a port over `graph` under bundle v2's id. */
  readonly bundles?: WalkBundles;
  /** Default: S1-04's question, open at version 1. */
  readonly rows?: readonly OpenQuestionRead[];
  /** The handle the question rows were sent to. Default: the roster owner's. */
  readonly sentTo?: string;
  /** Default: buttonAnswerWriters (S1-04's and S1-08's stand-ins). */
  readonly writers?: Readonly<Record<string, StepWriter<WalkTestRepo>>>;
  /** Leave the question read out of the walk's deps. */
  readonly noQuestions?: boolean;
  /** The step ids a buttons settler (T-1491) is bound to; it answers "ask" if ever asked. Default: none bound. */
  readonly buttonsAt?: readonly string[];
  /** The step ids a split settler (T-1502) is bound to; it answers "All share one" if ever asked. Default: none bound. */
  readonly settledAt?: readonly string[];
}

/** The walk over bundle v2 with commit-s1-04.json's turn key; every question read, writer call and settler ask written down. */
function buttonWalk(given: Given = {}) {
  const port = bundleV2Bundles({ A: given.graph ?? flowAV2() });
  const log: string[] = [];
  const seen: StepWriterCall<WalkTestRepo>[] = [];
  const asked: string[] = [];
  const fake = questionsOver(given.rows ?? [s1_04QuestionRow()], given.sentTo ?? ROSTER_HANDLE);
  const bound = new Map(Object.entries(given.writers ?? buttonAnswerWriters()));
  const writers = (stepId: string): StepWriter<WalkTestRepo> | null => {
    const writer = bound.get(stepId);
    if (writer === undefined) return null;
    return (call) => {
      log.push(`write ${call.step.id}`);
      seen.push(call);
      return writer(call);
    };
  };
  const buttonsAt = new Set(given.buttonsAt ?? []);
  const buttonsSettler: ButtonsSettler<WalkTestRepo> = (call) => {
    asked.push(`buttons ${call.step.id}`);
    return Promise.resolve("ask");
  };
  const settledAt = new Set(given.settledAt ?? []);
  const splitSettler: StepSettler<WalkTestRepo> = (call) => {
    asked.push(`split ${call.step.id}`);
    return Promise.resolve(ALL_SHARE);
  };
  const writesOf = createWritesOf<WalkTestRepo>({
    bundles: given.bundles ?? port.bundles,
    turnKey: () => ROSTER,
    ...(given.noQuestions === true
      ? {}
      : {
          questions: {
            liveQuestion(repo: WalkTestRepo, handleId: string, id: string) {
              log.push("question");
              return fake.questions.liveQuestion(repo, handleId, id);
            },
          },
        }),
    writers,
    ...(given.buttonsAt === undefined
      ? {}
      : { buttonsSettlers: (stepId: string) => (buttonsAt.has(stepId) ? buttonsSettler : null) }),
    ...(given.settledAt === undefined
      ? {}
      : { settlers: (stepId: string) => (settledAt.has(stepId) ? splitSettler : null) }),
  });
  return { writesOf, log, seen, asked, reads: port.reads, questionReads: fake.reads };
}

type Walk = ReturnType<typeof buttonWalk>;

/** The turn answering S1-04 with `choiceId` (or the part given), on the walk, with what is open. */
async function answer(walk: Walk, choiceId = "c-02", open: OpenHolds = NOTHING_OPEN, part?: PassedPart) {
  const turn = turnS1_04OnV2(choiceId);
  const writes = await walk.writesOf(part ?? turn.part, turn.context, open);
  return { ...turn, writes };
}

/** What the turn answering S1-04 (or the part given) threw on the walk, or null. */
async function refusal(walk: Walk, part?: PassedPart): Promise<unknown> {
  const turn = turnS1_04OnV2();
  return walk.writesOf(part ?? turn.part, turn.context, NOTHING_OPEN).then(
    () => null,
    (thrown: unknown) => thrown,
  );
}

/** The fixture's part with its choice's branch (the button it names) set to `branch`. */
function partNaming(branch: string | null): PassedPart {
  const { part, choice } = turnS1_04OnV2();
  return { ...part, choice: { ...choice, branch } };
}

function expectRefused(error: unknown, fault: WalkFault, ids: readonly string[]): void {
  expect(error).toBeInstanceOf(WalkRefusedError);
  expect(error).toMatchObject({ fault, ids });
}

function expectNotBuilt(error: unknown, seam: WalkSeam, ids: readonly string[]): void {
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

/** S1-09's card's safe default, as bundle v2 compiles it. */
function s1_09SafeDefault(): unknown {
  return (stepIn(flowAV2(), "S1-09").card as { safeDefault: unknown }).safeDefault;
}

/** S1-04's buttons in a graph's copy, to change. */
function s1_04Buttons(graph: GraphValue): unknown[] {
  const say = stepIn(graph, "S1-04").say as { from: string; elements?: { buttons?: unknown[] } }[];
  const buttons = say.find((message) => message.from === "san")?.elements?.buttons;
  if (buttons === undefined) throw new Error("S1-04's message carries buttons");
  return buttons;
}

/**
 * A bundles port over `graph` under bundle v2's id whose steps write down every key the walk reads of them (a step id
 * by its own name; listing them all as "*"), so a test can tell a step was never read.
 */
function recordingBundles(graph: GraphValue): { bundles: WalkBundles; read: string[] } {
  const read: string[] = [];
  const pin = bundleV2Id();
  const note = (key: string | symbol): void => {
    if (typeof key === "string") read.push(key);
  };
  return {
    read,
    bundles: {
      flow(bundleId, flow) {
        if (bundleId.hash !== pin.hash || bundleId.build !== pin.build || flow !== "A") {
          return Promise.resolve(null);
        }
        const value = copy(graph);
        const steps = new Proxy(value.steps, {
          get(target, key, receiver) {
            note(key);
            const found: unknown = Reflect.get(target, key, receiver);
            return found;
          },
          getOwnPropertyDescriptor(target, key) {
            note(key);
            return Reflect.getOwnPropertyDescriptor(target, key);
          },
          has(target, key) {
            note(key);
            return Reflect.has(target, key);
          },
          ownKeys(target) {
            read.push("*");
            return Reflect.ownKeys(target);
          },
        });
        return Promise.resolve({ ...value, steps });
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// commit-s1-04.json: the roster owner's "All share one", on bundle v2

describe("commit-s1-04.json's part on bundle v2: 'All share one' answers S1-04, closes its question, writes its gives and walks on", () => {
  it("gives, in order: oq-s1-04 closed at its version, S1-04's rows, S1-08's row (S1-08, line 0, no question), then S1-09's question and its row: the fixture's stated writes", async () => {
    const walk = buttonWalk();
    const { writes, exchange } = await answer(walk);
    const stated = exchange.given.stated.writes;
    const [plan, asking] = stated.outboxRows;
    const [opened] = stated.openQuestions;
    if (plan === undefined || asking === undefined || opened === undefined) {
      throw new Error("commit-s1-04.json states S1-08's row, S1-09's question and its row");
    }
    // The question read first (the close), then S1-04's writer, then S1-08's: the walk's order.
    expect(walk.log).toEqual(["question", "write S1-04", "write S1-08"]);
    expect(writes).toEqual({
      why: { step: "S1-04", choice: ALL_SHARE },
      versionsRead: [{ table: "open_questions", rowId: "oq-s1-04-roster-1", version: 1 }],
      state: stated.state,
      stateEvents: [],
      asks: [{ question: opened, safeDefault: s1_09SafeDefault() }],
      closes: [{ id: "oq-s1-04-roster-1", expectVersion: 1, status: "answered", answeredOptionId: null }],
      clockCancels: [],
      messages: [
        { ...plan, step: "S1-08", lineNo: 0 },
        { ...asking, step: "S1-09", lineNo: 0 },
      ],
      reservations: { confirm: [], release: [] },
      effects: { write: [], letGo: [] },
      gives: ["companies"],
    });
    // The fixture's own outcome: the question closed and the one opened, its outbox rows in order, the part's gives.
    expect(writes.closes.map((close) => close.id)).toEqual(exchange.outcome.openQuestions.closed);
    expect(writes.asks.map((ask) => ask.question.id)).toEqual(exchange.outcome.openQuestions.opened);
    expect(writes.messages.map((row) => row.id)).toEqual(
      exchange.outcome.written.outboxRows.map((row) => row.id),
    );
    expect(writes.gives).toEqual(exchange.given.stated.gives);
    expect(writes.gives).toEqual(exchange.outcome.parts[0]?.gives);
    // S1-08's row asks no question; S1-09's names the question it asks; neither is S1-04's message again.
    expect(writes.messages.map((row) => [row.id, row.openQuestionId, row.step, row.lineNo])).toEqual([
      ["outbox-s1-08-roster-1", null, "S1-08", 0],
      ["outbox-s1-09-roster-1", "oq-s1-09-roster-1", "S1-09", 0],
    ]);
    for (const named of ["outbox-s1-04", "oq-s1-04-roster-2"])
      expect(JSON.stringify(writes)).not.toContain(named);
  });

  it("walk.ts: a button start answers S1-04, walks S1-08 and stops at S1-09's question; through writesOf, S1-10 is never read", async () => {
    const walked = walkFrom(flowGraphOf(flowAV2(), "A"), {
      kind: "button",
      step: "S1-04",
      branch: ALL_SHARE,
    });
    expect(
      walked.moves.map((move) =>
        move.kind === "step" ? [move.step.id, move.answered ?? null] : [move.branch.label, null],
      ),
    ).toEqual([
      ["S1-04", ALL_SHARE],
      ["S1-08", null],
    ]);
    expect(walked.stop).toMatchObject({ kind: "asks", step: { id: "S1-09", split: true } });
    // A graph that holds an S1-10 the walk would refuse if it read it (no step's shape), every key read written down.
    const value = flowAV2();
    expect(stepIn(value, "S1-09").next).toBe("S1-10");
    (value.steps as Record<string, unknown>)["S1-10"] = "never read";
    const recording = recordingBundles(value);
    const { writes } = await answer(buttonWalk({ bundles: recording.bundles }));
    expect(writes.asks.map((ask) => ask.question.step)).toEqual(["S1-09"]);
    expect(recording.read).not.toContain("S1-10");
    expect(recording.read).not.toContain("*");
    expect(new Set(recording.read)).toEqual(new Set(["S1-04", "S1-08", "S1-09"]));
  });

  it("hands S1-04's writer, then S1-08's, the call's transaction, the step as bundle v2 holds it, the part's own choice (the button as its branch) and the owner's lane", async () => {
    const walk = buttonWalk();
    const { context, part, choice } = await answer(walk);
    expect(
      walk.seen.map((call) => [
        call.step.id,
        call.choice.branch,
        call.choice.choiceId,
        call.writer.writerLane,
      ]),
    ).toEqual([
      ["S1-04", ALL_SHARE, "c-02", "owner"],
      ["S1-08", ALL_SHARE, "c-02", "owner"],
    ]);
    for (const call of walk.seen) {
      expect(call.repo).toBe(context.repo);
      expect(call.part).toBe(part);
      expect(call.choice).toBe(choice);
      expect(call.writer.turn).toBe(context);
      expect(call.writer.why).toEqual({ step: "S1-04", choice: ALL_SHARE });
    }
    expect(walk.seen[0]?.step).toMatchObject({
      id: "S1-04",
      split: false,
      branches: [],
      gives: ["companies"],
      buttons: 3,
      buttonLabels: S1_04_BUTTONS,
      next: "S1-08",
    });
  });

  it.each([
    ["c-01", "Some share one"],
    ["c-02", ALL_SHARE],
    ["c-03", "Each is its own"],
  ] as const)(
    "%s, '%s', is one of S1-04's buttons: the same three moves, its why and writers naming it",
    async (choiceId, label) => {
      const walk = buttonWalk();
      const { writes, choice } = await answer(walk, choiceId);
      expect(choice.branch).toBe(label);
      expect(writes.why).toEqual({ step: "S1-04", choice: label });
      expect(walk.seen.map((call) => [call.step.id, call.choice.branch])).toEqual([
        ["S1-04", label],
        ["S1-08", label],
      ]);
      expect(writes.closes.map((close) => close.id)).toEqual(["oq-s1-04-roster-1"]);
      expect(writes.asks.map((ask) => ask.question.step)).toEqual(["S1-09"]);
      expect(writes.messages.map((row) => row.step)).toEqual(["S1-08", "S1-09"]);
    },
  );

  it("writes each row in K-05's own shapes and goes into the commit's one K-05 v1.22 request: S1-09's clock row, and the owner's answer approves the close", async () => {
    const { writes, context, exchange } = await answer(buttonWalk());
    const checks = contractChecks();
    for (const write of writes.state) expect(checks.k05("stateWrite", write)).toEqual([]);
    for (const ask of writes.asks) expect(checks.k05("openQuestionNew", ask.question)).toEqual([]);
    for (const row of writes.messages) expect(k05v122("outboxRowNew", row)).toEqual([]);
    for (const close of writes.closes) expect(checks.k05("openQuestionClose", close)).toEqual([]);
    for (const ref of writes.versionsRead) expect(checks.k05("rowRef", ref)).toEqual([]);
    expect(checks.k05("openQuestionRead", s1_04QuestionRow())).toEqual([]);
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
      units: [
        {
          writes,
          answer: { openQuestionId: "oq-s1-04-roster-1", optionId: null, eventId: "evt-roster-0002" },
        },
      ],
    });
    expect(k05v122("commitTurn.request", request)).toEqual([]);
    const logged = eventLogRowsOf(request, exchange.request.now);
    for (const row of logged) expect(checks.k08("eventLogRow", row), String(row.id)).toEqual([]);
    expect(request.versionsRead).toEqual([
      { table: "open_questions", rowId: "oq-s1-04-roster-1", version: 1 },
    ]);
    expect(request.writes.openQuestions.close).toEqual(writes.closes);
    expect(request.writes.openQuestions.open.map((question) => question.id)).toEqual(["oq-s1-09-roster-1"]);
    expect(request.writes.clockRows.make.map((clock) => clock.id)).toEqual(["clock-oq-s1-09-roster-1"]);
    expect(request.writes.outboxRows.map((row) => row.id)).toEqual([
      "outbox-s1-08-roster-1",
      "outbox-s1-09-roster-1",
    ]);
    expect(request.writes.events.find((entry) => entry.rowId === "oq-s1-04-roster-1")).toMatchObject({
      kind: "open_question.answered",
      actorKind: "person",
      actorPersonId: "person-roster-owner-1",
      approvedBy: {
        kind: "answer",
        open_question_id: "oq-s1-04-roster-1",
        option_id: null,
        event_id: "evt-roster-0002",
      },
    });
    // The rows the fixture's commit wrote that the walk names: the question opened, the one closed, the clock row.
    expect(exchange.outcome.written.written.map((row) => row.rowId)).toEqual(
      expect.arrayContaining(["oq-s1-09-roster-1", "oq-s1-04-roster-1", "clock-oq-s1-09-roster-1"]),
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A label that is no button

describe("a label that is no button of S1-04 in the turn's pinned graph is refused (branchNotInBundle), nothing read or returned", () => {
  it.each([
    ["S1-02's branch", "All on the list"],
    ["a button in another case", "all share one"],
    ["a button with a space after it", `${ALL_SHARE} `],
    ["the plain text's numbered button", `2 ${ALL_SHARE}`],
    ["an empty label", ""],
  ] as const)(
    "%s is refused, naming S1-04 alone, after the graph is read and before any other read",
    async (_, label) => {
      const walk = buttonWalk();
      const error = await refusal(walk, partNaming(label));
      expectRefused(error, "branchNotInBundle", ["S1-04"]);
      expect(walk.log).toEqual([]);
      expect(walk.reads).toEqual([{ bundleId: bundleV2Id(), flow: "A" }]);
      expect((error as Error).message).not.toContain(ALL_SHARE);
    },
  );

  it("a button reworded in a later cut (default 188) is refused: the label is checked against the turn's pinned graph, which then takes the new one", async () => {
    const graph = flowAV2();
    s1_04Buttons(graph)[1] = "All of them share one";
    const walk = buttonWalk({ graph });
    expectRefused(await refusal(walk), "branchNotInBundle", ["S1-04"]);
    expect(walk.log).toEqual([]);
    const reworded = buttonWalk({ graph });
    const { writes } = await answer(reworded, "c-02", NOTHING_OPEN, partNaming("All of them share one"));
    expect(writes.why).toEqual({ step: "S1-04", choice: "All of them share one" });
    expect(writes.closes.map((close) => close.id)).toEqual(["oq-s1-04-roster-1"]);
  });

  it("buttons holding a lettered pair give S1-04 no label, as the frontier then offers none (T-1478): every answer is refused", async () => {
    const graph = flowAV2();
    s1_04Buttons(graph)[1] = ["2", ALL_SHARE];
    expect(flowGraphOf(graph, "A").step("S1-04")).toMatchObject({ buttons: 3, buttonLabels: [] });
    expect(flowViewOf(graph, "A")?.step("S1-04")?.buttons).toBeNull();
    for (const label of S1_04_BUTTONS) {
      const walk = buttonWalk({ graph });
      expectRefused(await refusal(walk, partNaming(label)), "branchNotInBundle", ["S1-04"]);
      expect(walk.log).toEqual([]);
    }
  });

  it("an S1-04 whose message carries no buttons answers none: refused", async () => {
    const graph = flowAV2();
    stepIn(graph, "S1-04").say = [{ from: "owner", to: "san" }];
    const walk = buttonWalk({ graph });
    expectRefused(await refusal(walk), "branchNotInBundle", ["S1-04"]);
    expect(walk.log).toEqual([]);
  });

  it("a hub's case at S1-04 is no button answer: refused as before (branchNotInBundle), nothing read", async () => {
    const { part, choice } = turnS1_04OnV2();
    const hub: PassedPart = { ...part, choice: { ...choice, kind: "hub" } };
    const walk = buttonWalk();
    expectRefused(await refusal(walk, hub), "branchNotInBundle", ["S1-04"]);
    expect(walk.log).toEqual([]);
  });

  it("an option with no branch is refused before the graph is read, as before", async () => {
    const walk = buttonWalk();
    expectRefused(await refusal(walk, partNaming(null)), "branchNotInBundle", ["S1-04"]);
    expect(walk.reads).toEqual([]);
    expect(walk.log).toEqual([]);
  });

  it("walk.ts alone: a button start at a split, or with a label that is no button, is refused", () => {
    const graph = flowGraphOf(flowAV2(), "A");
    const thrown = (run: () => unknown): unknown => {
      try {
        run();
      } catch (error) {
        return error;
      }
      return null;
    };
    expectRefused(
      thrown(() => walkStretchFrom(graph, { kind: "button", step: "S1-09", branch: "Yes, an owner" })),
      "branchNotInBundle",
      ["S1-09"],
    );
    expectRefused(
      thrown(() => walkStretchFrom(graph, { kind: "button", step: "S1-04", branch: "All on the list" })),
      "branchNotInBundle",
      ["S1-04"],
    );
    expectRefused(
      thrown(() => walkStretchFrom(graph, { kind: "button", step: "S1-10", branch: ALL_SHARE })),
      "stepNotInBundle",
      ["S1-10"],
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A step that writes something with no writer bound

describe("a step that writes something with no writer bound is refused before anything is read", () => {
  it.each([
    ["S1-04, which gives companies", { "S1-08": tellingWriter }, "gives", ["S1-04", "companies"]],
    ["S1-08, which tells the owner", { "S1-04": s1_04Writer }, "tells", ["S1-08"]],
    ["both", {}, "gives", ["S1-04", "companies"]],
  ] as const)(
    "%s missing: notBuilt naming it, with no question read and no writer called",
    async (_, writers, seam, ids) => {
      const walk = buttonWalk({ writers });
      expectNotBuilt(await refusal(walk), seam, ids);
      expect(walk.log).toEqual([]);
      expect(walk.questionReads).toEqual([]);
    },
  );

  it("an answered S1-04 that gives nothing needs no writer: only its question is closed, then S1-08's row and S1-09's question", async () => {
    const graph = flowAV2();
    stepIn(graph, "S1-04").gives = [];
    const walk = buttonWalk({ graph, writers: { "S1-08": tellingWriter } });
    const { writes } = await answer(walk);
    expect(walk.log).toEqual(["question", "write S1-08"]);
    expect(writes.state).toEqual([]);
    expect(writes.gives).toEqual([]);
    expect(writes.closes.map((close) => close.id)).toEqual(["oq-s1-04-roster-1"]);
    expect(writes.messages.map((row) => row.id)).toEqual(["outbox-s1-08-roster-1", "outbox-s1-09-roster-1"]);
  });

  it("S1-04's writer giving a key S1-04 does not give is refused (givesNotStep)", async () => {
    const business: StepWriter<WalkTestRepo> = async (call) => {
      const rows: StepRows = await s1_04Writer(call);
      return { ...rows, gives: ["companies", "business"] };
    };
    const walk = buttonWalk({ writers: { "S1-04": business, "S1-08": tellingWriter } });
    expectRefused(await refusal(walk), "givesNotStep", ["S1-04", "business"]);
    expect(walk.log).toEqual(["question", "write S1-04"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The close

describe("the answered question is closed at the version its row is read at (default 11), answeredOptionId null", () => {
  it("the close and versionsRead take the row's version, read on the call's transaction for the turn's handle", async () => {
    const walk = buttonWalk({ rows: [{ ...s1_04QuestionRow(), version: 7 }] });
    const { writes, context } = await answer(walk);
    expect(writes.closes).toEqual([
      { id: "oq-s1-04-roster-1", expectVersion: 7, status: "answered", answeredOptionId: null },
    ]);
    expect(writes.versionsRead).toEqual([
      { table: "open_questions", rowId: "oq-s1-04-roster-1", version: 7 },
    ]);
    expect(walk.questionReads).toEqual([
      { repo: context.repo, handleId: ROSTER_HANDLE, openQuestionId: "oq-s1-04-roster-1" },
    ]);
  });

  it.each([
    ["no live question of that id", { rows: [] }, "questionNotLive", ["S1-04"]],
    ["a question sent to another handle", { sentTo: "handle-sam" }, "questionNotLive", ["S1-04"]],
    [
      "a row at another step",
      { rows: [{ ...s1_04QuestionRow(), step: "S1-02" }] },
      "questionNotLive",
      ["S1-04"],
    ],
    [
      "a row of another business",
      { rows: [{ ...s1_04QuestionRow(), businessId: "biz-lees-barbershop" }] },
      "businessNotInScope",
      [],
    ],
  ] as const)("%s is refused, with no writer called", async (_, given, fault, ids) => {
    const walk = buttonWalk(given);
    expectRefused(await refusal(walk), fault, ids);
    expect(walk.log).toEqual(["question"]);
  });

  it("a question stored with options is not answered yet (buttons): default 187's option ids are a later card", async () => {
    const rows = [{ ...s1_04QuestionRow(), options: [{ id: "S1-04/2", label: ALL_SHARE }] }];
    const walk = buttonWalk({ rows });
    expectNotBuilt(await refusal(walk), "buttons", ["S1-04"]);
    expect(walk.log).toEqual(["question"]);
  });

  it("with no question read bound, the answer is notBuilt (answer), nothing read or written", async () => {
    const walk = buttonWalk({ noQuestions: true });
    expectNotBuilt(await refusal(walk), "answer", ["S1-04"]);
    expect(walk.log).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Holds, the same part twice, the settlers, a bundle with no S1-08

describe("a hold, the same part twice, the settlers and a bundle that holds no S1-08", () => {
  it.each([
    ["a threat's hold (never released)", { holds: [hold()], unreadEventIds: [] }],
    ["an after-safe hold", { holds: [hold("after_safe")], unreadEventIds: [] }],
    ["an at-once hold", { holds: [hold("at_once")], unreadEventIds: [] }],
    ["a text not yet read", { holds: [], unreadEventIds: ["evt-roster-0002"] }],
  ] as const)(
    "%s stops the walk at S1-04, its first routine row: nothing closed or written, no question read, no writer called",
    async (_, open) => {
      const walk = buttonWalk();
      const { writes } = await answer(walk, "c-02", {
        holds: [...open.holds],
        unreadEventIds: [...open.unreadEventIds],
      });
      expectNothingWritten(writes);
      expect(writes.why).toEqual({ step: "S1-04", choice: ALL_SHARE });
      expect(walk.log).toEqual([]);
    },
  );

  it("the same part twice gives equal writes, reads the graph and the question afresh, and changes nothing it was given", async () => {
    const walk = buttonWalk();
    const { part, context } = turnS1_04OnV2();
    const given = copy({ part, request: context.request, turn: context.turn });
    const first = await walk.writesOf(part, context, NOTHING_OPEN);
    const second = await walk.writesOf(part, context, NOTHING_OPEN);
    expect(second).toEqual(first);
    expect(copy({ part, request: context.request, turn: context.turn })).toEqual(given);
    expect(walk.reads).toEqual([
      { bundleId: bundleV2Id(), flow: "A" },
      { bundleId: bundleV2Id(), flow: "A" },
    ]);
    expect(walk.log).toEqual([
      "question",
      "write S1-04",
      "write S1-08",
      "question",
      "write S1-04",
      "write S1-08",
    ]);
  });

  it("a buttons settler bound at every step (T-1491) is never asked for an answered S1-04: the walk starts there, so it never stops there", async () => {
    const plain = await answer(buttonWalk());
    const walk = buttonWalk({ buttonsAt: ["S1-02", "S1-04", "S1-08", "S1-09"] });
    const { writes } = await answer(walk);
    expect(writes).toEqual(plain.writes);
    expect(walk.asked).toEqual([]);
  });

  it("a split settler bound at S1-04 (T-1502) is never asked: S1-04 is no split, so the option answers its button", async () => {
    const plain = await answer(buttonWalk());
    const walk = buttonWalk({ settledAt: ["S1-04", "S1-09"] });
    const { writes } = await answer(walk);
    expect(writes).toEqual(plain.writes);
    expect(walk.asked).toEqual([]);
  });

  it("on bundle v1's flow A, which holds no S1-08, the walk on meets S1-08 missing: refused (stepNotInBundle) before anything is read", async () => {
    const walk = buttonWalk({ graph: flowAV1() });
    expectRefused(await refusal(walk), "stepNotInBundle", ["S1-08"]);
    expect(walk.log).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// graph.ts: the button labels

describe("graph.ts keeps the button labels of the messages Rosie sends, as the frontier reads them (T-1478)", () => {
  it("every step of bundle v2's flow A: the walk's labels are the frontier's, in order, and as many as its buttons", () => {
    const value = flowAV2();
    const walkGraph = flowGraphOf(value, "A");
    const frontier = flowViewOf(value, "A");
    for (const id of Object.keys(value.steps)) {
      const step = walkGraph.step(id);
      expect(step?.buttonLabels, id).toEqual(frontier?.step(id)?.buttons ?? []);
      expect(step?.buttonLabels.length, id).toBe(step?.buttons);
    }
    expect(walkGraph.step("S1-04")?.buttonLabels).toEqual(S1_04_BUTTONS);
    expect(walkGraph.step("S1-09")?.buttonLabels).toEqual(["Yes, an owner", "No, I help run it"]);
    expect(walkGraph.step("S1-02")?.buttonLabels).toEqual([]);
  });

  it("a message from anyone but Rosie adds no label, and a label with no words leaves the step none, as the frontier reads it", () => {
    const owners = flowAV2();
    const say = stepIn(owners, "S1-04").say as Record<string, unknown>[];
    say.push({ from: "owner", to: "san", elements: { buttons: ["Plumbing", "Electrical"] } });
    expect(flowGraphOf(owners, "A").step("S1-04")).toMatchObject({ buttons: 3, buttonLabels: S1_04_BUTTONS });
    expect(flowViewOf(owners, "A")?.step("S1-04")?.buttons).toEqual(S1_04_BUTTONS);
    const empty = flowAV2();
    s1_04Buttons(empty)[2] = "";
    expect(flowGraphOf(empty, "A").step("S1-04")).toMatchObject({ buttons: 3, buttonLabels: [] });
    expect(flowViewOf(empty, "A")?.step("S1-04")?.buttons).toBeNull();
  });
});
