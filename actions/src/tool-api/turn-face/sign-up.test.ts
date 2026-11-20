// T-1468's unit proof (card F1; DL-961 card F; DL-994): the turn face's binding hands the walk its question read and the
// sign-up steps' read-only writers, so the owner's answer to S1-02's question is written. `npm run test:unit --
// actions/src/tool-api/turn-face`.
//
// Under test, as they are: commit.ts's binding (TurnCommitBinding.questions and .writers, signUpStepWriters,
// turnCommitDeps, keywordCommitDeps) through the Tool API base and the turn face, with the commit, the gate's own checks of
// decide's output, T-1461's walk on bundle v1's flow A, T-633's writers with T-632's matcher, T-634's writer with bundle
// v1's own trade overlays, and runCore with the safety service.
//
// Doubles, for ports only: items 78 and 79 as db/repo answers them (journey-1/kinds' K-05 double: the 243 seeded kinds),
// the stop home's reads (the frozen seeds' world), the trade port over bundle v1's files, the question read over K-05
// v1.2's openQuestionRead row, K-05's commitTurn (T-305's fake), readOpenHolds and the safety reads (T-318's world), the
// same-bytes sealer, and limits 1 to 6 as the gate framework's scripted doubles, each passing: their reads need a
// database, and the integration test (pg/sign-up.int.test.ts) runs them for real as rosie_app.
//
// The turn is K-09's commit-s1-02.json (Sam's "Barbershop, plumbing, electrical", choosing "All on the list") pinned to
// bundle v1, with other words or another option of S1-02's question where a case needs them. Values come from the
// contracts' fixtures, fixture set v1 and bundle v1 (rule 9).

import { describe, expect, it } from "vitest";

import type { Span } from "../../../../runtime/src/trace";
import type { GateAndCommitRequest } from "../../commit";
import { sameSealer } from "../../commit/core/test-support";
import { k05Fake } from "../../commit/test-support";
import { WalkNotBuiltError, type StepWriter, type StepWriters } from "../../commit/walk";
import {
  NOTHING_OPEN,
  bundleV1Id,
  commitS1_02,
  contextOf,
  decidedOf,
  passedPartOf,
  questionsOver,
  s1_02QuestionRow,
  turnTwoOnV1,
} from "../../commit/walk/test-support";
import { KEYED_IDS, NO_EVENT_SOURCES } from "../../domain/flags";
import { flagsReaderOn, messagesReaderOn } from "../../domain/flags/test-support";
import { NOT_TOLD_YET, PLUGIN_LISTS_NO_STOP_WORDS } from "../../domain/safety";
import { BARBERSHOP, fixtureSafetyIds, safetyWorldOf } from "../../domain/safety/test-support";
import { fakeBundles } from "../../frontier/assemble/test-support";
import type { DecidePart } from "../../gate/framework";
import { scriptedLimits } from "../../gate/framework/test-support";
import type { StopHomeReads } from "../../homes/stop";
import { readsOn, seedWorld } from "../../homes/stop/test-support";
import { KindsReadError, kindsReadsOf, kindsWriters } from "../journey-1/kinds";
import {
  GIFT_CARDS,
  PACK_HIKES,
  earlierPick,
  fakeK05,
  type FakeK05,
  type FakeK05Given,
} from "../journey-1/kinds/test-support";
import { PF_TEXT_KEYS, PlugInRefusedError, createPlugInWriters } from "../journey-1/plug-ins";
import { overlayV1, tradesOverV1 } from "../journey-1/plug-ins/test-support";
import { traceFor } from "../test-support";
import { createToolApi, type SpanRefusedReport } from "../tool-api";
import { createToolApiValidator } from "../validator";
import {
  SAM_KEY,
  noDatabaseScope,
  openHoldsOn,
  publishedBundleV1,
  safetyReadsOn,
} from "./calls-test-support";
import {
  NOTHING_OPEN_AT,
  keywordCommitDeps,
  signUpStepWriters,
  turnCommitDeps,
  type KeywordCommitBinding,
  type SignUpWriterDeps,
  type TurnCommitBinding,
} from "./commit";
import { callHandlers, createTurnFace, type GateAndCommitCallAnswer, type TurnFaceCalls } from "./turn-face";

type Json = Record<string, unknown>;

const validator = createToolApiValidator();

/** The safety record's id commit-s1-02.json names for Sam's text; every other row takes the Worker's keyed id. */
const S1_02_IDS = fixtureSafetyIds({ "evt-sam-0001": { outcome: "safety-outcome-sam-0001" } });

/** The 12 keys commit-s1-02.json states its part gives: S1-02's kinds, then S1-11's 11 pf keys. */
const STATED_GIVES = commitS1_02().given.stated.gives;

// ---------------------------------------------------------------------------------------------------------------
// Turn 2: commit-s1-02.json on bundle v1

/**
 * commit-s1-02.json's request pinned to bundle v1 (T-1461's turnTwoOnV1), its one part choosing `choiceId` (c-01 "All on
 * the list", c-02 "One isn't on the list yet", c-03 "Not a service we book") in decide's agreed parts and in both reads,
 * and, when `words` are given, the turn's text, the part's quote and its kinds field set to them.
 */
function secondTurn(choiceId = "c-01", words?: string): GateAndCommitRequest {
  const { request } = turnTwoOnV1(choiceId).exchange;
  const decided = decidedOf(request);
  const change = (part: DecidePart): void => {
    if (part.verb !== "choose") throw new Error("commit-s1-02.json's part chooses");
    part.choice = choiceId;
    if (words === undefined) return;
    part.quote = words;
    for (const field of part.fields) {
      if (field.name === "kinds") {
        field.value = words;
        field.words = words;
      }
    }
  };
  for (const entry of decided.decide.parts) change(entry.part);
  for (const read of decided.decide.reads) for (const part of read.output.parts) change(part);
  if (words !== undefined) decided.context.texts[0].words = words;
  return request;
}

// ---------------------------------------------------------------------------------------------------------------
// The binding over the doubles

interface Given {
  /** Items 78 and 79. Default: the 243 seeded kinds, no pick on file. */
  readonly k05?: FakeK05Given;
  /** The stop home's reads. Left out: no stop port is bound. */
  readonly stop?: StopHomeReads;
  /** The version S1-02's question row is read at. Default: 2, as armClock leaves it. */
  readonly questionVersion?: number;
  /** The step writers bound in place of signUpStepWriters'. */
  readonly writers?: (deps: SignUpWriterDeps) => StepWriters;
  /** The two new binding fields left out, as before T-1468. */
  readonly leftOut?: boolean;
}

/** The turn face's commit binding over the doubles (the top of this file), and what each double saw. */
function doubles(given: Given = {}) {
  const k05: FakeK05 = fakeK05(given.k05);
  const trades = tradesOverV1();
  const questions = questionsOver([{ ...s1_02QuestionRow(), version: given.questionVersion ?? 2 }]);
  const commit = k05Fake({ now: commitS1_02().request.now });
  const world = safetyWorldOf();
  const signUp: SignUpWriterDeps = {
    kinds: { reads: kindsReadsOf(k05.k05), ...(given.stop === undefined ? {} : { stop: given.stop }) },
    plugIns: { bundles: trades.bundles },
  };
  const binding: TurnCommitBinding<unknown> = {
    bundles: fakeBundles(publishedBundleV1()),
    commitTurn: commit.commitTurn,
    readOpenHolds: openHoldsOn(world),
    safetyReads: safetyReadsOn(world),
    sealer: sameSealer(),
    stopWords: PLUGIN_LISTS_NO_STOP_WORDS,
    telling: NOT_TOLD_YET,
    safetyExtra: {
      flagsReader: () => flagsReaderOn(world.flags, BARBERSHOP),
      messagesReader: () => messagesReaderOn(world.flags, BARBERSHOP),
      ids: S1_02_IDS,
    },
    turnKey: () => SAM_KEY,
    limits: () => scriptedLimits(),
    ...(given.leftOut === true
      ? {}
      : {
          questions: questions.questions,
          writers: given.writers === undefined ? signUpStepWriters(signUp) : given.writers(signUp),
        }),
  };
  const calls: TurnFaceCalls<unknown> = { scope: noDatabaseScope(), commit: turnCommitDeps(binding) };
  return { calls, binding, commit, k05, trades, questions, world };
}

type Doubles = ReturnType<typeof doubles>;

/** One gateAndCommit through the turn face: its answer, or what it threw. */
async function through(
  made: Doubles,
  request: GateAndCommitRequest,
): Promise<{ answer: GateAndCommitCallAnswer | null; thrown: unknown }> {
  const face = createTurnFace<never>({
    scope: { withBusiness: () => Promise.reject(new Error("the frontier is not called here")) },
    bundles: fakeBundles(publishedBundleV1()),
    validator,
    calls: made.calls,
  });
  const { trace } = traceFor(request);
  return face.gateAndCommit(structuredClone(request), NOTHING_OPEN_AT, trace).then(
    (answer) => ({ answer, thrown: undefined }),
    (thrown: unknown) => ({ answer: null, thrown }),
  );
}

/** The committed answer, held to K-09's response. */
function committed(answer: GateAndCommitCallAnswer | null): Json & {
  parts: Json[];
  openQuestions: { opened: string[]; closed: string[] };
} {
  expect(answer, JSON.stringify(answer)).toHaveProperty("result", "committed");
  expect(validator.check("gateAndCommit", "response", answer)).toEqual([]);
  return answer as unknown as Json & { parts: Json[]; openQuestions: { opened: string[]; closed: string[] } };
}

/** The one K-05 commit request a run sent. */
function sentBy(made: Doubles) {
  const [sent, ...more] = made.commit.requests;
  if (sent === undefined || more.length > 0) throw new Error("one commit was sent");
  return sent;
}

/** The values of each insert into `table` in the commit a run sent, in order. */
function inserted(made: Doubles, table: string): Json[] {
  return sentBy(made).writes.state.flatMap((write) =>
    write.op === "insert" && write.table === table ? [write.values] : [],
  );
}

/** The tables the walk's state writes name in the commit a run sent, in order (the safety record's row left out). */
function walkTables(made: Doubles): string[] {
  return sentBy(made)
    .writes.state.map((write) => write.table)
    .filter((table) => table !== "safety_outcomes");
}

/** The 11 text blocks S1-11 loads for the pick `pickId` from the trade `trade`'s overlay in bundle v1, in pf key order. */
function blocksOf(pickId: string, trade: string): Json[] {
  const overlay = overlayV1(trade) as { pluginText: Record<string, string> };
  return PF_TEXT_KEYS.map((key) => ({
    picked_kind_id: pickId,
    pf_key: key,
    business_id: null,
    block: overlay.pluginText[key],
  }));
}

const NOT_BUILT = { error: "notBuilt", call: "gateAndCommit" };

// ---------------------------------------------------------------------------------------------------------------

describe("signUpStepWriters: the sign-up steps' read-only writers by step id (T-1468)", () => {
  it("answers a writer for S1-02, S1-03, S1-74 and S1-11, and null for S1-01, S1-04 and any other id", () => {
    const made = doubles();
    const writers = signUpStepWriters<unknown>({
      kinds: { reads: kindsReadsOf(made.k05.k05) },
      plugIns: { bundles: made.trades.bundles },
    });
    for (const stepId of ["S1-02", "S1-03", "S1-74", "S1-11"]) {
      expect(typeof writers(stepId), stepId).toBe("function");
    }
    for (const stepId of [
      "S1-01",
      "S1-04",
      "S1-08",
      "S11-21",
      "A3-22",
      "s1-02",
      "S1-02 ",
      "",
      "constructor",
      "toString",
      "__proto__",
    ]) {
      expect(writers(stepId), stepId).toBeNull();
    }
    // Building the lookup reads nothing.
    expect(made.k05.asked).toEqual([]);
    expect(made.trades.reads).toEqual([]);
  });
});

describe("turn 2 through the turn face with the question read and the sign-up writers bound (T-1468)", () => {
  it("'All on the list': three picks, the first pick's 11 text blocks, S1-04's question with its outbox row, and S1-02's question closed at the version the question read answers", async () => {
    const made = doubles({ questionVersion: 7 });
    const { answer, thrown } = await through(made, secondTurn());
    expect(thrown).toBeUndefined();
    const result = committed(answer);
    expect(result.parts).toEqual([
      expect.objectContaining({ part: 0, choiceId: "c-01", result: "committed", gives: STATED_GIVES }),
    ]);
    expect(result.openQuestions).toEqual({ opened: ["oq-s1-04-sam-1"], closed: ["oq-s1-02"] });

    // Three picks in the owner's order, then the first pick's 11 blocks from bundle v1's barber overlay, and no other.
    expect(walkTables(made)).toEqual([
      "picked_kinds",
      "picked_kinds",
      "picked_kinds",
      ...PF_TEXT_KEYS.map(() => "picked_kind_texts"),
    ]);
    expect(
      inserted(made, "picked_kinds").map((row) => [row.id, row.position, row.outcome, row.kind_id]),
    ).toEqual([
      ["pick-s1-02-sam-1", 1, "listed", "barber"],
      ["pick-s1-02-sam-2", 2, "listed", "plumber"],
      ["pick-s1-02-sam-3", 3, "listed", "electrician"],
    ]);
    expect(inserted(made, "picked_kind_texts")).toEqual(blocksOf("pick-s1-02-sam-1", "barber"));
    expect(PF_TEXT_KEYS).toHaveLength(11);
    expect(made.trades.reads).toEqual([{ bundleId: bundleV1Id(), tradeId: "barber" }]);

    // S1-04's question and the quick reply asking it; S1-02's question closed at the question double's version, 7.
    const sent = sentBy(made);
    expect(sent.writes.openQuestions.open.map((question) => [question.id, question.step])).toEqual([
      ["oq-s1-04-sam-1", "S1-04"],
    ]);
    expect(sent.writes.outboxRows.map((row) => [row.id, row.openQuestionId, row.sendClass])).toEqual([
      ["outbox-s1-04-sam-1", "oq-s1-04-sam-1", "quick_reply"],
    ]);
    expect(sent.writes.openQuestions.close).toEqual([
      { id: "oq-s1-02", expectVersion: 7, status: "answered", answeredOptionId: null },
    ]);

    // The question is read once, on the call's own repo, for the turn's handle; items 78 and 79 once each, for the
    // call's own business and the turn's person.
    expect(made.questions.reads).toEqual([
      {
        repo: { name: "no database", businessId: BARBERSHOP },
        handleId: "handle-sam",
        openQuestionId: "oq-s1-02",
      },
    ]);
    expect(made.k05.asked).toEqual([
      { read: "readKindCatalog" },
      { read: "readPickedKinds", request: { businessId: BARBERSHOP, personId: "person-sam" } },
    ]);
  });

  it("with a stop double, 'One isn't on the list yet' reaches S1-03, whose draft names S1-02's new_work pick, then S1-11 and S1-04's question", async () => {
    const made = doubles({ stop: readsOn(seedWorld(), null) });
    const { answer, thrown } = await through(made, secondTurn("c-02", `Barbershop, ${PACK_HIKES}`));
    expect(thrown).toBeUndefined();
    const result = committed(answer);
    expect(result.parts).toEqual([
      expect.objectContaining({ choiceId: "c-02", result: "committed", gives: STATED_GIVES }),
    ]);
    // S1-02's rows (the drafted kind before its pick), S1-03's draft, then S1-11's blocks for the first kind named.
    expect(walkTables(made)).toEqual([
      "picked_kinds",
      "kinds",
      "picked_kinds",
      "new_work_drafts",
      ...PF_TEXT_KEYS.map(() => "picked_kind_texts"),
    ]);
    const picks = inserted(made, "picked_kinds");
    expect(picks.map((row) => [row.id, row.position, row.outcome])).toEqual([
      ["pick-s1-02-sam-1", 1, "listed"],
      ["pick-s1-02-sam-2", 2, "new_work"],
    ]);
    // The draft is the new_work pick's, by the row id S1-02's writer gave it in the same walk: one kindsWriters serves
    // both steps, and T-634's wrapper hands the walk's own call through.
    expect(inserted(made, "new_work_drafts")).toEqual([
      {
        id: "draft-s1-03-sam-1",
        picked_kind_id: "pick-s1-02-sam-2",
        business_id: null,
        state: "drafting",
        drafted_at: commitS1_02().request.now,
      },
    ]);
    expect(inserted(made, "kinds").map((row) => [row.id, row.name, row.source])).toEqual([
      [picks[1]?.kind_id, PACK_HIKES, "new_work"],
    ]);
    expect(inserted(made, "picked_kind_texts")).toEqual(blocksOf("pick-s1-02-sam-1", "barber"));
    // S1-03's message, then S1-04's question's quick reply.
    expect(sentBy(made).writes.outboxRows.map((row) => [row.id, row.openQuestionId])).toEqual([
      ["outbox-s1-03-sam-1", null],
      ["outbox-s1-04-sam-1", "oq-s1-04-sam-1"],
    ]);
    expect(result.openQuestions).toEqual({ opened: ["oq-s1-04-sam-1"], closed: ["oq-s1-02"] });
  });

  it("with barber on file in item 79, 'Barbershop, plumbing' picks plumbing alone, and S1-11 loads plumbing's 11 blocks", async () => {
    const made = doubles({ k05: { picks: [earlierPick(1)] } });
    const { answer, thrown } = await through(made, secondTurn("c-01", "Barbershop, plumbing"));
    expect(thrown).toBeUndefined();
    const result = committed(answer);
    expect(result.parts).toEqual([expect.objectContaining({ result: "committed", gives: STATED_GIVES })]);
    expect(
      inserted(made, "picked_kinds").map((row) => [row.id, row.position, row.outcome, row.kind_id]),
    ).toEqual([["pick-s1-02-sam-1", 2, "listed", "plumber"]]);
    expect(inserted(made, "picked_kind_texts")).toEqual(blocksOf("pick-s1-02-sam-1", "plumber"));
    expect(made.trades.reads).toEqual([{ bundleId: bundleV1Id(), tradeId: "plumber" }]);
  });

  it("with every named kind on file nothing is picked or loaded: the walk still closes S1-02's question and asks S1-04's, giving kinds alone", async () => {
    const plumbing = { ...earlierPick(2), id: "pick-sam-plumbing", words: "plumbing", kindId: "plumber" };
    const made = doubles({ k05: { picks: [earlierPick(1), plumbing] } });
    const { answer, thrown } = await through(made, secondTurn("c-01", "Barbershop, plumbing"));
    expect(thrown).toBeUndefined();
    const result = committed(answer);
    expect(result.parts).toEqual([expect.objectContaining({ result: "committed", gives: ["kinds"] })]);
    expect(walkTables(made)).toEqual([]);
    expect(made.trades.reads).toEqual([]);
    expect(result.openQuestions).toEqual({ opened: ["oq-s1-04-sam-1"], closed: ["oq-s1-02"] });
    expect(sentBy(made).writes.outboxRows.map((row) => row.id)).toEqual(["outbox-s1-04-sam-1"]);
  });

  it("S1-11 bound while S1-02's writer has no wrapper refuses noPicks, and nothing is committed", async () => {
    const bare = (deps: SignUpWriterDeps): StepWriters => {
      const kinds = kindsWriters(deps.kinds);
      const plugIns = createPlugInWriters(deps.plugIns);
      const bound: Record<string, StepWriter> = {
        "S1-02": kinds["S1-02"],
        "S1-11": plugIns.plugIns,
      };
      return (stepId) => (Object.hasOwn(bound, stepId) ? (bound[stepId] ?? null) : null);
    };
    const made = doubles({ writers: bare });
    const { answer, thrown } = await through(made, secondTurn());
    expect(answer).toBeNull();
    expect(thrown).toBeInstanceOf(PlugInRefusedError);
    expect(thrown).toMatchObject({ fault: "noPicks" });
    expect(made.commit.requests).toEqual([]);
    expect(made.trades.reads).toEqual([]);
  });

  it("with the stop port left out, 'One isn't on the list yet' and 'Not a service we book' each answer notBuilt, and nothing is committed", async () => {
    for (const [choiceId, words, stepId] of [
      ["c-02", `Barbershop, ${PACK_HIKES}`, "S1-03"],
      ["c-03", GIFT_CARDS, "S1-74"],
    ] as const) {
      const made = doubles();
      const request = secondTurn(choiceId, words);
      const { answer, thrown } = await through(made, request);
      expect(thrown, choiceId).toBeUndefined();
      expect(answer, choiceId).toEqual(NOT_BUILT);
      expect(made.commit.requests, choiceId).toEqual([]);
      expect(made.commit.commits, choiceId).toEqual([]);
      // What the walk itself answers under the binding: the branch's own step cannot tell the owner (stopNotWired),
      // and returns no row.
      const { ports } = made.calls.commit(NOTHING_OPEN_AT);
      await expect(
        ports.writesOf(passedPartOf(request), contextOf(request), NOTHING_OPEN),
        choiceId,
      ).rejects.toMatchObject({ name: "KindsNotBuiltError", seam: "stopNotWired", ids: [stepId] });
    }
  });

  it("with the stop port left out, 'All on the list' still commits: it needs no stop read", async () => {
    const made = doubles();
    const { answer } = await through(made, secondTurn());
    expect(committed(answer).parts).toEqual([expect.objectContaining({ result: "committed" })]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A failed read fails the call closed

/** A person's row id made up for these tests: no fixture, seed or request holds it. */
const MADE_UP_ROW = "person-t1468-made-up-7c1e";
/** A SQLSTATE no id, time or hash of the turn holds. */
const SQLSTATE = "40P01";

/** Turn 2 through the Tool API base as any caller calls it, which records the base's own gate span. */
async function throughBase(made: Doubles, request: GateAndCommitRequest) {
  const reports: SpanRefusedReport[] = [];
  const base = createToolApi<unknown>({
    validator,
    scope: made.calls.scope,
    handlers: callHandlers(made.calls, NOTHING_OPEN_AT),
    onSpanRefused: (report) => {
      reports.push(report);
    },
  });
  const { trace, spans } = traceFor(request);
  const thrown: unknown = await base.call("gateAndCommit", structuredClone(request), trace).then(
    () => undefined,
    (error: unknown) => error,
  );
  return { thrown, spans, reports };
}

/** Every text an error holds but its `answer`: its name, message and stack. */
function saidBy(error: unknown): string {
  if (!(error instanceof Error)) throw new Error("the call threw an Error");
  return [error.name, error.message, error.stack ?? ""].join("\n");
}

describe("a failed item 78 or item 79 read rejects through the Tool API base with KindsReadError (T-1468; K-05 default 61)", () => {
  const failures: readonly {
    name: string;
    k05: FakeK05Given;
    read: string;
    fault: string;
    secret: string;
  }[] = [
    {
      name: "item 79 notFound with a made-up row id",
      k05: { picked: { error: "notFound", table: "persons", rowId: MADE_UP_ROW } },
      read: "readPickedKinds",
      fault: "notFound",
      secret: MADE_UP_ROW,
    },
    {
      name: "item 79 transient with a SQLSTATE",
      k05: { picked: { error: "transient", sqlstate: SQLSTATE } },
      read: "readPickedKinds",
      fault: "transient",
      secret: SQLSTATE,
    },
    {
      name: "item 78 transient with a SQLSTATE",
      k05: { catalog: { error: "transient", sqlstate: SQLSTATE } },
      read: "readKindCatalog",
      fault: "transient",
      secret: SQLSTATE,
    },
  ];

  it.each(failures)(
    "$name: nothing is written, and no span or report holds the id or the SQLSTATE",
    async ({ k05, read, fault, secret }) => {
      const made = doubles({ k05 });
      const { thrown, spans, reports } = await throughBase(made, secondTurn());
      expect(thrown).toBeInstanceOf(KindsReadError);
      expect(thrown).toMatchObject({ name: "KindsReadError", read, fault });
      // Nothing is written: no commit was sent, and no trade overlay was read after the failed read.
      expect(made.commit.requests).toEqual([]);
      expect(made.commit.commits).toEqual([]);
      expect(made.trades.reads).toEqual([]);
      // The base's one gate span names the error by its name alone, and nothing was reported beside it.
      expect(spans).toHaveLength(1);
      expect(spans.map((span: Span) => span.hop)).toEqual(["gate"]);
      expect(validator.checkSpan(spans[0])).toEqual([]);
      expect(JSON.stringify(spans)).toContain("KindsReadError");
      expect(JSON.stringify(spans)).not.toContain(secret);
      expect(reports).toEqual([]);
      // Its name, message and stack hold neither; only `answer`, which nothing here reads, does.
      expect(saidBy(thrown)).not.toContain(secret);
      expect(JSON.stringify((thrown as KindsReadError).answer)).toContain(secret);

      // Through the turn face the same call rejects the same way, with nothing written.
      const again = doubles({ k05 });
      const faced = await through(again, secondTurn());
      expect(faced.answer).toBeNull();
      expect(faced.thrown).toBeInstanceOf(KindsReadError);
      expect(faced.thrown).toMatchObject({ read, fault });
      expect(again.commit.requests).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------------------------------------------
// The new fields left out: as before

describe("a binding that leaves the question read and the writers out behaves as before (T-1468)", () => {
  it("turn 2's answer is notBuilt: no question, kind, pick or overlay is read, and nothing is committed", async () => {
    const made = doubles({ leftOut: true });
    expect(Object.hasOwn(made.binding, "questions")).toBe(false);
    expect(Object.hasOwn(made.binding, "writers")).toBe(false);
    const { answer, thrown } = await through(made, secondTurn());
    expect(thrown).toBeUndefined();
    expect(answer).toEqual(NOT_BUILT);
    expect(made.questions.reads).toEqual([]);
    expect(made.k05.asked).toEqual([]);
    expect(made.trades.reads).toEqual([]);
    expect(made.commit.requests).toEqual([]);
  });

  it("the question read bound alone: the answer walks to S1-02's writer, finds none bound, and is notBuilt with nothing read", async () => {
    const made = doubles({ writers: () => () => null });
    const { answer } = await through(made, secondTurn());
    expect(answer).toEqual(NOT_BUILT);
    expect(made.questions.reads).toEqual([]);
    expect(made.k05.asked).toEqual([]);
    expect(made.commit.requests).toEqual([]);
  });

  it("the keyword door's commit hands the walk neither, whatever its binding object carries; the turn face's hands it both", async () => {
    const made = doubles();
    const turn = turnTwoOnV1("c-01");
    // The turn face's deps over this binding write the answer.
    const faced = turnCommitDeps(made.binding)(NOTHING_OPEN_AT);
    const writes = await faced.ports.writesOf(turn.part, turn.context, NOTHING_OPEN);
    expect(writes.closes.map((close) => close.id)).toEqual(["oq-s1-02"]);
    // The door's deps over the same object (its two fields are no part of KeywordCommitBinding) walk no answer.
    const { world } = made;
    const door = keywordCommitDeps(made.binding as unknown as KeywordCommitBinding<unknown>, {
      reader: () => flagsReaderOn(world.flags, null),
      messagesReader: () => messagesReaderOn(world.flags, null),
      ids: KEYED_IDS,
      events: NO_EVENT_SOURCES,
    })(NOTHING_OPEN_AT);
    const before = made.questions.reads.length;
    await expect(door.ports.writesOf(turn.part, turn.context, NOTHING_OPEN)).rejects.toBeInstanceOf(
      WalkNotBuiltError,
    );
    expect(made.questions.reads).toHaveLength(before);
  });
});
