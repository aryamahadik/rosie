// T-1482's proofs (the card's Proves it with, as its Lead note 1 and DL-1074 bind it to frozen K-09 README default 189),
// unit side: `npm run test:unit -- actions/src/tool-api/journey-1/plan`. The code under test is real: S1-08's writer
// (writer.ts planWriter), with homes/stop's readStop and mayText as they are, called alone and through T-1461's walk
// (commit/walk createWritesOf) on T-1491's test graph. The doubles are never the writer: the stop home's reads (T-307's
// and T-317's doubles over the frozen seeds, homes/stop/test-support, on the runtime side as the binding gives them),
// T-1491's walk doubles (bundle v1's flow A with S1-08 and S1-09, the question read, the stand-in writers of S1-02, S1-11,
// S1-03 and S1-74) and a stand-in buttons settler at S1-04 answering T-1491's stand-in rows (T-1492's settler is not this
// card's). Values come from the contracts' fixtures (K-09 commit-s1-02.json, commit-s1-02-unmapped-end.json and
// commit-s1-04.json; the K-04 and K-29 seeds): the master's sample cast and the 555-01xx range (rule 9).
//   - "texts": one row with every field of default 181, its id from WriterContext.rowId("outbox"); no state, no ask,
//     nothing given;
//   - "noTexts": no row, and the walk goes on to S1-09's question;
//   - no stop reads bound: notBuilt, nothing read or written;
//   - another step, or a turn with no person, refused; a turn with no service or chat id refused as the walk refuses it;
//   - on the walk, S1-08's row sits after S1-04's rows and before S1-09's question (the step and line stamp is T-1479's
//     and H1a's, not this card's).

import { describe, expect, it } from "vitest";

import type { CommitTurnContext, UnitWrites } from "../../../commit";
import {
  WalkRefusedError,
  createWritesOf,
  flowGraphOf,
  textSourceOf,
  type ButtonsSettler,
  type StepRows,
  type StepWriter,
  type StepWriterCall,
} from "../../../commit/walk";
import {
  NOTHING_OPEN,
  SAM,
  allWriters,
  bundleV1Bundles,
  decidedOf,
  flowAWithPlan,
  planWriters,
  questionsOver,
  requestTurnFields,
  s1_04SettledRows,
  turnTwoOnV1,
  type WalkTestRepo,
} from "../../../commit/walk/test-support";
import type { StopHomeReads } from "../../../homes/stop";
import { readsOn, seedWorld, type World } from "../../../homes/stop/test-support";
import { NotBuiltError } from "../../errors";
import { stoppedWorld } from "../kinds/test-support";
import {
  FOLDER,
  PLAN_STEP,
  PlanNotBuiltError,
  PlanRefusedError,
  planWriter,
  type PlanFault,
  type PlanWriterDeps,
} from "./index";

/** The moment Sam's number is stopped from in the stopped world: before turn 2's texts (commit-s1-02.json's 14:05). */
const STOPPED_AT = "2026-10-19T14:04:00Z";

/** The stop home's five reads, in the order readStop makes them for a mobile. */
const STOP_READS = ["handle", "handleIdsOfPerson", "phoneOfHandle", "personIdsOfHandle", "consentsOfPersons"];

/** The stop home's reads over `world` on the runtime side (scope none), each read written down in `log` as it is made. */
function stopReads(world: World, log: string[]): StopHomeReads {
  const reads = readsOn(world, null);
  return {
    handle: (handleId) => {
      log.push("handle");
      return reads.handle(handleId);
    },
    handleIdsOfPerson: (personId) => {
      log.push("handleIdsOfPerson");
      return reads.handleIdsOfPerson(personId);
    },
    phoneOfHandle: (handleId) => {
      log.push("phoneOfHandle");
      return reads.phoneOfHandle(handleId);
    },
    consentsOfPersons: (personIds) => {
      log.push("consentsOfPersons");
      return reads.consentsOfPersons(personIds);
    },
    personIdsOfHandle: (handleId) => {
      log.push("personIdsOfHandle");
      return reads.personIdsOfHandle(handleId);
    },
  };
}

/** Turn 2 on bundle v1 ("All on the list"), its context's call repo one that writes down every touch of it. */
function turnWithRepo(): {
  context: CommitTurnContext<WalkTestRepo>;
  turn: ReturnType<typeof turnTwoOnV1>;
  touched: string[];
} {
  const turn = turnTwoOnV1("c-01");
  const touched: string[] = [];
  const plain: WalkTestRepo = { name: "walk-test-repo" };
  const repo = new Proxy(plain, {
    get(target, key, receiver) {
      touched.push(String(key));
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  return { context: { ...turn.context, repo }, turn, touched };
}

/** What a direct call of the writer was handed and did: the call, and every row id it asked for. */
interface Direct {
  readonly call: StepWriterCall<WalkTestRepo>;
  /** The kinds the writer asked WriterContext.rowId for, in order. */
  readonly ids: string[];
}

/**
 * One call of a step's writer at `stepId` of T-1491's test graph, on `context`, as the walk makes it: the part and choice
 * of turn 2, the walk's own textSourceOf for WriterContext.text, and default 131's row ids under the turn key "unit".
 */
function callAt(stepId: string, context: CommitTurnContext<WalkTestRepo>): Direct {
  const step = flowGraphOf(flowAWithPlan(), "A").step(stepId);
  if (step === null) throw new Error(`T-1491's test graph holds ${stepId}`);
  const { part, choice } = turnTwoOnV1("c-01");
  const ids: string[] = [];
  const call: StepWriterCall<WalkTestRepo> = {
    repo: context.repo,
    step,
    part,
    choice,
    writer: {
      turn: context,
      why: { step: "S1-02", choice: "All on the list" },
      zone: null,
      writerLane: "owner",
      rowId: (kind) => {
        ids.push(kind);
        return `${kind}-${stepId.toLowerCase()}-unit-${String(ids.filter((each) => each === kind).length)}`;
      },
      text: () => textSourceOf(context.request),
    },
  };
  return { call, ids };
}

/** What a promise settled to: its value, or what it rejected with. */
async function settled<T>(promise: Promise<T>): Promise<{ value: T | null; thrown: unknown }> {
  return promise.then(
    (value) => ({ value, thrown: null }),
    (thrown: unknown) => ({ value: null, thrown }),
  );
}

/** A step writer's rows with every list empty. */
const NO_ROWS: StepRows = { state: [], stateEvents: [], gives: [], asks: [], messages: [] };

function expectRefused(error: unknown, fault: PlanFault, ids: readonly string[]): void {
  expect(error).toBeInstanceOf(PlanRefusedError);
  expect(error).toMatchObject({ name: "PlanRefusedError", fault, ids });
}

function expectStopNotWired(error: unknown): void {
  expect(error).toBeInstanceOf(PlanNotBuiltError);
  expect(error).toBeInstanceOf(NotBuiltError);
  expect(error).toMatchObject({ seam: "stopNotWired", ids: [PLAN_STEP], call: "gateAndCommit" });
}

// ---------------------------------------------------------------------------------------------------------------
// The writer alone, called as the walk calls it

describe("S1-08's writer: one quick reply when the stop home lets Rosie text the owner (default 189 'texts')", () => {
  it("one outbox row with every field of default 181, its id from WriterContext.rowId('outbox'); no state, no entry, no ask, nothing given", async () => {
    const { context, touched } = turnWithRepo();
    const log: string[] = [];
    const { call, ids } = callAt(PLAN_STEP, context);
    const rows = await planWriter<WalkTestRepo>({ stop: stopReads(seedWorld(), log) })(call);
    const { service } = requestTurnFields(context.request);
    expect(["imessage", "rcs", "sms", "email"]).toContain(service);
    expect(rows).toEqual({
      state: [],
      stateEvents: [],
      gives: [],
      asks: [],
      messages: [
        {
          id: "outbox-s1-08-unit-1",
          recipientHandleId: "handle-sam",
          recipientPersonId: "person-sam",
          businessId: "biz-lees-barbershop",
          bookingId: null,
          channel: service,
          sendClass: "quick_reply",
          openQuestionId: null,
          copyOfRowId: null,
          versionsRead: [],
        },
      ],
    });
    // The id is the one rowId gave, asked once, for an outbox row.
    expect(ids).toEqual(["outbox"]);
    // The row is to the turn's own handle and person, under the call's business (the context's, never a request value).
    expect(rows.messages[0]?.recipientHandleId).toBe(context.turn.handleId);
    expect(rows.messages[0]?.recipientPersonId).toBe(context.request.caller.personId);
    expect(rows.messages[0]?.businessId).toBe(context.businessId);
    // It read the owner through the stop reads alone, and never touched the call's transaction.
    expect(log).toEqual(STOP_READS);
    expect(touched).toEqual([]);
  });

  it("keeps nothing between calls: the same call twice gives the same rows", async () => {
    const writer = planWriter<WalkTestRepo>({ stop: stopReads(seedWorld(), []) });
    const first = await writer(callAt(PLAN_STEP, turnTwoOnV1("c-01").context).call);
    const second = await writer(callAt(PLAN_STEP, turnTwoOnV1("c-01").context).call);
    expect(second).toEqual(first);
    expect(first.messages).toHaveLength(1);
  });
});

describe("S1-08's writer: no row when the stop home rules noTexts (default 189 'noTexts')", () => {
  it("Sam's number stopped for every business: no row, no row id taken, every list empty", async () => {
    const log: string[] = [];
    const { context, touched } = turnWithRepo();
    const { call, ids } = callAt(PLAN_STEP, context);
    const rows = await planWriter<WalkTestRepo>({ stop: stopReads(stoppedWorld(STOPPED_AT), log) })(call);
    expect(rows).toEqual(NO_ROWS);
    expect(ids).toEqual([]);
    expect(log).toEqual(STOP_READS);
    expect(touched).toEqual([]);
  });

  it("a turn whose texts hold no text (a tapback alone) is not texting in, and with no yes on file gets no row", async () => {
    const { context } = turnWithRepo();
    for (const text of decidedOf(context.request).context.texts) text.kind = "tapback";
    const { call, ids } = callAt(PLAN_STEP, context);
    const rows = await planWriter<WalkTestRepo>({ stop: stopReads(seedWorld(), []) })(call);
    expect(rows).toEqual(NO_ROWS);
    expect(ids).toEqual([]);
  });
});

describe("S1-08's writer fails closed: notBuilt with no stop reads bound, refused for another step or no person", () => {
  it("no stop reads bound: notBuilt (stopNotWired), nothing read, no row id taken", async () => {
    const { context, touched } = turnWithRepo();
    const { call, ids } = callAt(PLAN_STEP, context);
    const deps: PlanWriterDeps = {};
    const { value, thrown } = await settled(planWriter<WalkTestRepo>(deps)(call));
    expect(value).toBeNull();
    expectStopNotWired(thrown);
    expect(ids).toEqual([]);
    expect(touched).toEqual([]);
  });

  it.each(["S1-02", "S1-03", "S1-04", "S1-09", "S1-11", "S1-74"])(
    "called for %s: refused (wrongStep), nothing read",
    async (stepId) => {
      const log: string[] = [];
      const { call, ids } = callAt(stepId, turnTwoOnV1("c-01").context);
      const { value, thrown } = await settled(
        planWriter<WalkTestRepo>({ stop: stopReads(seedWorld(), log) })(call),
      );
      expect(value).toBeNull();
      expectRefused(thrown, "wrongStep", [PLAN_STEP, stepId]);
      expect(log).toEqual([]);
      expect(ids).toEqual([]);
    },
  );

  it("a turn that names no person: refused (noPerson), nothing read", async () => {
    const { context } = turnTwoOnV1("c-01");
    const noPerson: CommitTurnContext<WalkTestRepo> = {
      ...context,
      request: { ...context.request, caller: { ...context.request.caller, personId: null } },
    };
    const log: string[] = [];
    const { call, ids } = callAt(PLAN_STEP, noPerson);
    const { value, thrown } = await settled(
      planWriter<WalkTestRepo>({ stop: stopReads(seedWorld(), log) })(call),
    );
    expect(value).toBeNull();
    expectRefused(thrown, "noPerson", [PLAN_STEP]);
    expect(log).toEqual([]);
    expect(ids).toEqual([]);
  });

  it("with no stop reads bound and no person, notBuilt comes first (the port before the turn)", async () => {
    const { context } = turnTwoOnV1("c-01");
    const noPerson: CommitTurnContext<WalkTestRepo> = {
      ...context,
      request: { ...context.request, caller: { ...context.request.caller, personId: null } },
    };
    const { thrown } = await settled(planWriter<WalkTestRepo>({})(callAt(PLAN_STEP, noPerson).call));
    expectStopNotWired(thrown);
  });
});

describe("a turn with no service or chat id is refused as the walk refuses it (WalkRefusedError noServiceOrChatId)", () => {
  const CASES: readonly (readonly [string, (turn: Record<string, unknown>) => void])[] = [
    ["no service", (turn) => delete turn.service],
    ["a service that is not K-06's", (turn) => (turn.service = "whatsapp")],
    ["no chat id", (turn) => delete turn.chatId],
    ["a null chat id", (turn) => (turn.chatId = null)],
    ["an empty chat id", (turn) => (turn.chatId = "")],
  ];

  it.each(CASES)("%s: refused before any stop read, whatever the stop home would rule", async (_, change) => {
    for (const world of [seedWorld(), stoppedWorld(STOPPED_AT)]) {
      const { context } = turnTwoOnV1("c-01");
      change(requestTurnFields(context.request));
      const log: string[] = [];
      const { call, ids } = callAt(PLAN_STEP, context);
      const { value, thrown } = await settled(
        planWriter<WalkTestRepo>({ stop: stopReads(world, log) })(call),
      );
      expect(value).toBeNull();
      expect(thrown).toBeInstanceOf(WalkRefusedError);
      expect(thrown).toMatchObject({ fault: "noServiceOrChatId" });
      expect(log).toEqual([]);
      expect(ids).toEqual([]);
    }
  });
});

describe("what S1-08's writer throws names faults, steps and seams: never an id, the chat id or a number", () => {
  it("no refusal or notBuilt carries the person, the handle, the business or the chat id", async () => {
    const { context } = turnTwoOnV1("c-01");
    const chatId = String(requestTurnFields(context.request).chatId);
    const noPerson: CommitTurnContext<WalkTestRepo> = {
      ...context,
      request: { ...context.request, caller: { ...context.request.caller, personId: null } },
    };
    const stop = stopReads(seedWorld(), []);
    const errors = [
      (await settled(planWriter<WalkTestRepo>({})(callAt(PLAN_STEP, context).call))).thrown,
      (await settled(planWriter<WalkTestRepo>({ stop })(callAt("S1-09", context).call))).thrown,
      (await settled(planWriter<WalkTestRepo>({ stop })(callAt(PLAN_STEP, noPerson).call))).thrown,
    ];
    expect(errors.map((error) => (error instanceof Error ? error.message : null))).toEqual([
      "gateAndCommit: the plan's row is not built (stopNotWired: S1-08); nothing was written",
      "the plan refused the part (wrongStep: S1-08, S1-09); nothing was written",
      "the plan refused the part (noPerson: S1-08); nothing was written",
    ]);
    for (const error of errors) {
      const message = error instanceof Error ? error.message : "";
      for (const value of ["person-sam", "handle-sam", "biz-lees-barbershop", chatId, "+1555"]) {
        expect(message).not.toContain(value);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// On the walk: T-1491's test graph, a stand-in buttons settler at S1-04 so the walk goes on to S1-08 and S1-09

/**
 * T-1461's walk on T-1491's test graph with the stand-in writers (allWriters), S1-08 bound to `s1_08`, and a stand-in
 * buttons settler at S1-04 that answers T-1491's stand-in rows (commit-s1-04.json's company kind, giving companies): every
 * question read, writer call and settler ask written down in `log`, in order, beside the stop reads.
 */
function planWalk(s1_08: StepWriter<WalkTestRepo>, log: string[]) {
  const { bundles } = bundleV1Bundles({ A: flowAWithPlan() });
  const fake = questionsOver();
  const bound = new Map(Object.entries({ ...allWriters(), [PLAN_STEP]: s1_08 }));
  const settler: ButtonsSettler<WalkTestRepo> = (call) => {
    log.push(`settle ${call.step.id}`);
    return Promise.resolve(s1_04SettledRows());
  };
  return createWritesOf<WalkTestRepo>({
    bundles,
    turnKey: () => SAM,
    questions: {
      liveQuestion(repo, handleId, id) {
        log.push("question");
        return fake.questions.liveQuestion(repo, handleId, id);
      },
    },
    writers: (stepId) => {
      const writer = bound.get(stepId);
      if (writer === undefined) return null;
      return (call) => {
        log.push(`write ${call.step.id}`);
        return writer(call);
      };
    },
    buttonsSettlers: (stepId) => (stepId === "S1-04" ? settler : null),
  });
}

/** Turn 2 ("All on the list") on the walk given, and what it wrote or threw. */
async function walkTurn(
  writesOf: ReturnType<typeof planWalk>,
  context?: CommitTurnContext<WalkTestRepo>,
): Promise<{ value: UnitWrites | null; thrown: unknown }> {
  const turn = turnTwoOnV1("c-01");
  return settled(writesOf(turn.part, context ?? turn.context, NOTHING_OPEN));
}

describe("on the walk, with a stand-in settler at S1-04: S1-08's row sits after S1-04's rows and before S1-09's question", () => {
  it("'All on the list': S1-02's and S1-11's rows, S1-04's settled rows, S1-08's row (no question), then S1-09's question and its row", async () => {
    const log: string[] = [];
    const { value: writes, thrown } = await walkTurn(
      planWalk(planWriter<WalkTestRepo>({ stop: stopReads(seedWorld(), log) }), log),
    );
    expect(thrown).toBeNull();
    if (writes === null) throw new Error("the walk wrote the part");
    // The settler answers S1-04's rows first, then S1-08's writer reads the owner through the stop reads alone.
    expect(log).toEqual([
      "question",
      "write S1-02",
      "write S1-11",
      "settle S1-04",
      "write S1-08",
      ...STOP_READS,
    ]);
    // S1-02's three picks, then S1-04's settled rows; S1-08 writes no state.
    const settledRows = s1_04SettledRows();
    expect(writes.state.slice(-settledRows.state.length)).toEqual(settledRows.state);
    expect(writes.state).toHaveLength(4);
    expect(writes.gives.at(-1)).toBe("companies");
    // S1-08's row, then S1-09's row asking S1-09's question; S1-09 the one question opened, S1-04 none.
    expect(writes.messages.map((row) => [row.id, row.openQuestionId])).toEqual([
      ["outbox-s1-08-sam-1", null],
      ["outbox-s1-09-sam-1", "oq-s1-09-sam-1"],
    ]);
    expect(writes.asks.map((ask) => ask.question.step)).toEqual(["S1-09"]);
    expect(writes.stateEvents).toEqual([]);
    const service = requestTurnFields(turnTwoOnV1("c-01").context.request).service;
    expect(writes.messages[0]).toEqual({
      id: "outbox-s1-08-sam-1",
      recipientHandleId: "handle-sam",
      recipientPersonId: "person-sam",
      businessId: "biz-lees-barbershop",
      bookingId: null,
      channel: service,
      sendClass: "quick_reply",
      openQuestionId: null,
      copyOfRowId: null,
      versionsRead: [],
    });
  });

  it("gives the very writes T-1491's stand-in for S1-08 gave (commit/walk planWriters), row for row", async () => {
    const real = await walkTurn(planWalk(planWriter<WalkTestRepo>({ stop: stopReads(seedWorld(), []) }), []));
    const standIn = planWriters()[PLAN_STEP];
    if (standIn === undefined) throw new Error("T-1491 binds a stand-in at S1-08");
    const stood = await walkTurn(planWalk(standIn, []));
    expect(real.thrown).toBeNull();
    expect(real.value).toEqual(stood.value);
  });

  it("noTexts (Sam's number stopped): no S1-08 row, and the walk goes on to S1-09's question", async () => {
    const log: string[] = [];
    const { value: writes, thrown } = await walkTurn(
      planWalk(planWriter<WalkTestRepo>({ stop: stopReads(stoppedWorld(STOPPED_AT), log) }), log),
    );
    expect(thrown).toBeNull();
    if (writes === null) throw new Error("the walk wrote the part");
    expect(log).toEqual([
      "question",
      "write S1-02",
      "write S1-11",
      "settle S1-04",
      "write S1-08",
      ...STOP_READS,
    ]);
    expect(writes.messages.map((row) => [row.id, row.openQuestionId])).toEqual([
      ["outbox-s1-09-sam-1", "oq-s1-09-sam-1"],
    ]);
    expect(writes.asks.map((ask) => ask.question.step)).toEqual(["S1-09"]);
    expect(writes.state).toHaveLength(4);
  });

  it("no stop reads bound: the walk rejects with notBuilt after S1-04's settler, and nothing is returned", async () => {
    const log: string[] = [];
    const { value, thrown } = await walkTurn(planWalk(planWriter<WalkTestRepo>({}), log), undefined);
    expect(value).toBeNull();
    expectStopNotWired(thrown);
    expect(log).toEqual(["question", "write S1-02", "write S1-11", "settle S1-04", "write S1-08"]);
  });

  it("a turn with no service or chat id: refused at S1-08's writer as the walk refuses it, with no stop read, nothing returned", async () => {
    const log: string[] = [];
    const { context } = turnTwoOnV1("c-01");
    delete requestTurnFields(context.request).service;
    const { value, thrown } = await walkTurn(
      planWalk(planWriter<WalkTestRepo>({ stop: stopReads(seedWorld(), log) }), log),
      context,
    );
    expect(value).toBeNull();
    expect(thrown).toBeInstanceOf(WalkRefusedError);
    expect(thrown).toMatchObject({ fault: "noServiceOrChatId" });
    expect(log).toEqual(["question", "write S1-02", "write S1-11", "settle S1-04", "write S1-08"]);
  });

  it("S1-08's writer bound at another step (S1-11): refused (wrongStep), nothing returned", async () => {
    const { bundles } = bundleV1Bundles({ A: flowAWithPlan() });
    const writer = planWriter<WalkTestRepo>({ stop: stopReads(seedWorld(), []) });
    const bound = new Map(Object.entries({ ...allWriters(), "S1-11": writer, [PLAN_STEP]: writer }));
    const writesOf = createWritesOf<WalkTestRepo>({
      bundles,
      turnKey: () => SAM,
      questions: questionsOver().questions,
      writers: (stepId) => bound.get(stepId) ?? null,
      buttonsSettlers: (stepId) => (stepId === "S1-04" ? () => Promise.resolve(s1_04SettledRows()) : null),
    });
    const { value, thrown } = await walkTurn(writesOf);
    expect(value).toBeNull();
    expectRefused(thrown, "wrongStep", [PLAN_STEP, "S1-11"]);
  });
});

describe("the folder", () => {
  it("keeps FOLDER with no entry: S1-08 has no K-09 call of its own", () => {
    expect(FOLDER).toEqual({ folder: "plan", entries: [] });
  });
});
