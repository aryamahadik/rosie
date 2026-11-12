// The turn loop's calls (T-251), run inside the Workers runtime against fixture fakes: the real guard (T-250) and fixed
// replies (T-267) run, and every outside call is a port answered from the frozen fixtures (./test-support.ts): K-09 v1's
// buildFrontier, closestEntries and gateAndCommit, K-02 v1's decide and its re-read, the handle's directory and each
// text's safety result (safety-no.json). The run is handed a leased turn with the fixture's own ids, whose commit goes to
// the turn's commit hook as the lease's does (the lease itself runs for real in lease-turn.worker.test.ts). Test values
// only (rule 9).
import { afterEach, describe, expect, it } from "vitest";

import buildFrontierS102 from "../../../contracts/tool-api/fixtures/build-frontier-s1-02.json";
import closestEntriesFixture from "../../../contracts/tool-api/fixtures/closest-entries.json";
import commitLimit4 from "../../../contracts/tool-api/fixtures/commit-limit-4-changed.json";
import commitLimit6First from "../../../contracts/tool-api/fixtures/commit-limit-6-reread-first.json";
import commitLimit6Fails from "../../../contracts/tool-api/fixtures/commit-limit-6-value-fails.json";
import commitS102 from "../../../contracts/tool-api/fixtures/commit-s1-02.json";
import stopRecorded from "../../../contracts/tool-api/fixtures/stop-recorded.json";
import decideDisagree from "../../../contracts/model/fixtures/decide-reads-disagree.json";
import decideNoneFits from "../../../contracts/model/fixtures/decide-none-fits.json";
import decideS102 from "../../../contracts/model/fixtures/decide-s1-02-choose.json";
import type { CommitContext } from "../actor";
import { BUNDLE_A, BUNDLE_B, WHOLE_A, WHOLE_B } from "../bundle/test-support";
import { fakeKeyStore } from "../gateway/test-support";
import { setGuardDeps, setReplyDeps } from "../guard";
import { fakeCore as fakeReplyCore, phone, ROSIE_NUMBER, type FakeRow } from "../guard/replies/test-support";
import { fakeTargets } from "../guard/test-support";
import { spanProblems, type BundleId } from "../trace";
import { KEYWORD_RUNS, runTurnLoop, setTurnDeps, turnReplyCore, type TurnOutcome } from "./index";
import {
  ALEX,
  BEN,
  ONE_REREAD,
  SAM,
  SAM_S1_02_TARGETS,
  TWO_READS,
  a7_17Context,
  answersInTurn,
  checkedManifest,
  decided,
  fakeDecide,
  fakeFacts,
  fakeTurnFace,
  safetyNoFor,
  storedText,
  targetsAnswer,
  testTurn,
  turnDeps,
  type FakeDecide,
  type FakeFacts,
  type FakeTurnFace,
  type TestTurn,
  type TextSpec,
} from "./test-support";
import type { DecideResult, GateAndCommitRequest, TurnParty } from "./types";

type Json = Record<string, unknown>;

const keys = fakeKeyStore();
const restores: (() => void)[] = [];

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

interface Party {
  handle: (typeof SAM)["handle"];
  party: TurnParty;
}

interface Setup {
  t: TestTurn;
  face: FakeTurnFace;
  ai: FakeDecide;
  facts: FakeFacts;
}

/**
 * One run's doubles: the turn (the fixture's turn and trace ids, its texts sealed as the inbox keeps them), the turn face
 * and decide (answers set by each test), the guard's targets, and each text's safety result (No).
 */
async function setUp(spec: {
  who: Party;
  turnId: string;
  traceId: string;
  bundleId?: BundleId;
  texts: Omit<TextSpec, "traceId">[];
  times: string[];
  targets?: Parameters<typeof targetsAnswer>[1];
  context?: CommitContext;
}): Promise<Setup> {
  const bundleId = spec.bundleId ?? BUNDLE_A;
  const whole = bundleId.hash === BUNDLE_B.hash ? WHOLE_B : WHOLE_A;
  const entries = await Promise.all(
    spec.texts.map((text, index) =>
      storedText({ ...text, traceId: spec.traceId }, spec.who.handle, keys, bundleId, index + 1),
    ),
  );
  const t = testTurn({
    turnId: spec.turnId,
    traceId: spec.traceId,
    bundleId,
    manifest: await checkedManifest(whole, bundleId),
    entries,
    ...(spec.context === undefined ? {} : { context: spec.context }),
  });
  const face = fakeTurnFace();
  const ai = fakeDecide(face.log);
  const facts = fakeFacts(spec.who.party, spec.times);
  for (const text of spec.texts) facts.safety.set(text.eventId, safetyNoFor(text.eventId));
  restores.push(setTurnDeps(turnDeps(facts, face, ai, keys)));
  const targets = fakeTargets();
  targets.answers.set(
    spec.who.party.handleId,
    targetsAnswer(
      spec.who.party.handleId,
      spec.targets ?? { roles: [], openQuestionIds: [], bookingIds: [] },
    ),
  );
  restores.push(setGuardDeps({ targets: targets.port }));
  return { t, face, ai, facts };
}

function committed(outcome: TurnOutcome): Extract<TurnOutcome, { result: "committed" }> {
  if (outcome.result !== "committed") throw new Error(`the turn did not commit: ${outcome.why}`);
  return outcome;
}

const requestsOf = (face: FakeTurnFace): GateAndCommitRequest[] => face.gateCalls.map((call) => call.request);

const S1_02_TEXT = {
  eventId: "evt-sam-0001",
  body: "Barbershop, plumbing, electrical",
  sentAt: "2026-10-19T14:05:00Z",
};

describe("one turn: frontier, decide, gate and commit", () => {
  it("with the frontier and decide answering build-frontier-s1-02.json and decide-s1-02-choose.json, the commit request is commit-s1-02.json's", async () => {
    const { t, face, ai } = await setUp({
      who: SAM,
      turnId: "turn-s1-02-sam-kinds",
      traceId: "trace-sam-0001",
      texts: [S1_02_TEXT],
      times: [buildFrontierS102.request.now, commitS102.request.now],
      targets: SAM_S1_02_TARGETS,
    });
    face.frontier = () => structuredClone(buildFrontierS102.outcome);
    ai.decide = () => decided(decideS102);
    face.gate = answersInTurn(commitS102.outcome);

    const outcome = committed(await runTurnLoop(t.turn));

    expect(face.frontierCalls).toEqual([buildFrontierS102.request]);
    expect(ai.decideCalls).toEqual([buildFrontierS102.outcome.context]);
    expect(ai.rereadCalls).toEqual([]);
    expect(requestsOf(face)).toEqual([commitS102.request]);
    // The lease's CommitContext went to the gate unchanged: the very object the lease handed the commit hook.
    expect(face.gateCalls[0]?.at).toBe(t.context);
    expect(outcome).toMatchObject({ gateCalls: 1, reread: false, replies: null });
    expect(outcome.answer).toEqual(commitS102.outcome);
    expect(face.log).toEqual(["frontier", "decide", "gate", "gate:answered"]);
    // Through the lease's commit, once, carrying the K-09 request for this turn id.
    expect(t.commits).toHaveLength(1);
    expect(t.commits[0]?.request.turn).toEqual(commitS102.request.turn);
    expect(t.commits[0]?.answer).toMatchObject({ result: "committed", turnId: "turn-s1-02-sam-kinds" });
  });

  it("records the guard, frontier, decide, gate and commit spans with labels, ids and counts only, under the pinned bundle", async () => {
    const { t, face, ai } = await setUp({
      who: SAM,
      turnId: "turn-s1-02-sam-kinds",
      traceId: "trace-sam-0001",
      texts: [S1_02_TEXT],
      times: [buildFrontierS102.request.now, commitS102.request.now],
      targets: SAM_S1_02_TARGETS,
    });
    face.frontier = () => structuredClone(buildFrontierS102.outcome);
    ai.decide = () => decided(decideS102);
    face.gate = answersInTurn(commitS102.outcome);
    committed(await runTurnLoop(t.turn));

    expect(t.spans.map((span) => span.hop)).toEqual(["guard", "frontier", "decideReads", "gate", "commit"]);
    for (const span of t.spans) {
      expect(spanProblems(span)).toEqual([]);
      expect(span.bundle_id).toEqual(BUNDLE_A);
      expect(span.turn_id).toBe("turn-s1-02-sam-kinds");
    }
    const [, frontier, decide, gate, commit] = t.spans;
    expect(frontier).toMatchObject({ outcome: "ok", business_id: "biz-lees-barbershop" });
    expect(frontier?.got).toEqual({ texts: 1, roles: 2, openQuestions: 1, bookings: 0 });
    expect(frontier?.decided).toEqual({ choices: 5, flagged: 0, collapsed: 0 });
    expect(decide?.model_calls).toEqual(TWO_READS);
    expect(decide?.decided).toMatchObject({
      agreed: true,
      reread: false,
      parts: 1,
      oneQuestion: 0,
      verbs: ["choose"],
    });
    expect(gate?.limits).toEqual(commitS102.outcome.parts[0]?.limits);
    expect(gate?.decided).toEqual({ part: 0, result: "committed", choice: "c-01" });
    expect(commit?.rows).toEqual([
      { table: "picked_kinds", id: "pick-sam-barbershop" },
      { table: "picked_kinds", id: "pick-sam-plumbing" },
      { table: "picked_kinds", id: "pick-sam-electrical" },
      { table: "outbox_rows", id: "out-s1-04-sam" },
    ]);
    // Never a text's words, a field's value, a name or a number in any span. The commit's row ids are the fixture's labels
    // (pick-sam-plumbing), so the words are looked for as the text and the value write them.
    const logged = JSON.stringify(t.spans);
    for (const words of [
      "Barbershop, plumbing, electrical",
      "Barbershop",
      "Sam Lee",
      "+15555550100",
      "5555550100",
    ]) {
      expect(logged).not.toContain(words);
    }
  });

  it("a limit failure (commit-limit-4-changed.json) stops only that choice: the turn commits once, as the gate answers, with no re-read and no second call", async () => {
    const decidedInput = commitLimit4.request.input.decided;
    const { t, face, ai } = await setUp({
      who: SAM,
      turnId: "turn-sam-s2-22-changed",
      traceId: "trace-sam-0118",
      texts: [{ eventId: "evt-sam-0118", body: "1", sentAt: "2026-10-21T13:10:00Z" }],
      times: ["2026-10-21T13:10:02Z", commitLimit4.request.now],
      targets: {
        roles: [{ businessId: "biz-lees-barbershop", personId: "person-sam", role: "owner" }],
        openQuestionIds: ["oq-s2-22-sam"],
        bookingIds: [],
      },
    });
    face.frontier = () => ({
      context: structuredClone(decidedInput.context),
      flagged: [],
      collapsedBookingIds: [],
    });
    ai.decide = () => decided(decidedInput.decide);
    face.gate = answersInTurn(commitLimit4.outcome);

    const outcome = committed(await runTurnLoop(t.turn));

    expect(requestsOf(face)).toEqual([commitLimit4.request]);
    expect(ai.rereadCalls).toEqual([]);
    expect(outcome.gateCalls).toBe(1);
    expect(outcome.answer).toEqual(commitLimit4.outcome);
    // Part 0 alone is stopped, by limit 4 (a fresh yes); the text's safety outcome committed beside it.
    expect(outcome.answer.parts.map((part) => [part.part, part.result])).toEqual([[0, "stopped"]]);
    expect(outcome.answer.parts[0]?.stoppedBy).toEqual({ limit: 4, outcome: "ask", action: "freshYes" });
    expect(outcome.answer.core.map((result) => [result.call, result.error])).toEqual([
      ["recordSafetyOutcome", null],
    ]);
    const gate = t.spans.find((span) => span.hop === "gate");
    expect(gate).toMatchObject({
      outcome: "refused",
      decided: { part: 0, result: "stopped", choice: "c-01" },
    });
    expect(gate?.limits?.find((limit) => limit.limit === 4)).toEqual({
      limit: 4,
      result: "fail",
      outcome: "freshYes",
    });
    expect(t.spans.find((span) => span.hop === "commit")?.outcome).toBe("ok");
  });
});

describe("the one re-read (Q-41: one Sonnet re-read, then one question; never a commit on a difference)", () => {
  const disagreeSetup = (): Promise<Setup> =>
    setUp({
      who: ALEX,
      turnId: "turn-a7-17-alex-either",
      traceId: "trace-alex-0417",
      bundleId: BUNDLE_B,
      texts: [
        {
          eventId: "evt-alex-0417",
          body: "can Avery do it, or I'll just come Saturday at 2",
          sentAt: "2026-10-23T15:20:00Z",
        },
      ],
      times: ["2026-10-23T15:20:04Z", "2026-10-23T15:20:09Z"],
      targets: {
        roles: [{ businessId: "biz-lees-barbershop", personId: "person-alex", role: "customer" }],
        openQuestionIds: ["oq-a7-17"],
        bookingIds: ["bk-alex-sat"],
      },
    });

  /** decide-reads-disagree.json before its re-read: Sonnet's and Haiku's reads, which disagree, and no re-read yet. */
  const beforeReread = (): DecideResult => {
    const fixture = structuredClone(decideDisagree) as unknown as DecideResult;
    const [first, check] = fixture.reads;
    const firstParts = (first?.output as { parts: DecideResult["parts"][number]["part"][] }).parts;
    return {
      ...fixture,
      reads: [first, check].filter((read) => read !== undefined),
      agreed: false,
      reread: false,
      parts: firstParts.map((part) => ({ part, outcome: "oneQuestion" as const })),
    };
  };

  const context = (): Json => {
    const flowA = (WHOLE_B.flows.A ?? {}) as { routing: { alwaysOn: { prefixSha256: string } } };
    return a7_17Context(BUNDLE_B, flowA.routing.alwaysOn.prefixSha256);
  };

  /** A committed answer for the turn's request: the one question asked, nothing changed for the part. */
  const askedAnswer = (request: GateAndCommitRequest): Json => ({
    result: "committed",
    turnId: request.turn.id,
    committedAt: request.now,
    repeated: false,
    parts: [
      {
        part: 0,
        choiceId: null,
        result: "asked",
        limits: [1, 2, 3, 4, 5, 6].map((limit) => ({ limit, result: "notChecked", outcome: null })),
        stoppedBy: null,
        gives: [],
        dependsOnPart: null,
      },
    ],
    planner: null,
    core: [{ call: "recordSafetyOutcome", response: { outcomeId: "safety-outcome-alex-0417" }, error: null }],
    written: { written: [], outboxRows: [{ id: "out-a7-17-alex-which", commitSeq: 1 }], promoted: [] },
    effects: [],
    openQuestions: { opened: ["oq-a7-17-alex-2"], closed: ["oq-a7-17"] },
  });

  it("decide-reads-disagree.json gives exactly one re-read call, then a commit request with that part as one question and nothing changed", async () => {
    const { t, face, ai } = await disagreeSetup();
    face.frontier = () => ({ context: context() as never, flagged: [], collapsedBookingIds: [] });
    ai.decide = () => decided(beforeReread());
    ai.reread = () => decided(decideDisagree, ONE_REREAD);
    face.gate = (request) => askedAnswer(request) as never;

    const outcome = committed(await runTurnLoop(t.turn));

    expect(ai.rereadCalls).toHaveLength(1);
    expect(ai.rereadCalls[0]).toEqual({
      context: context(),
      decide: beforeReread(),
      why: "disagreed",
      failing: [],
    });
    expect(face.gateCalls).toHaveLength(1);
    const request = requestsOf(face)[0];
    if (request?.input.kind !== "decided") throw new Error("not a decided turn");
    // The re-read's result, unchanged: three reads, the re-read run, the part one question with nothing changed.
    expect(request.input.decided.decide).toEqual(decideDisagree);
    expect(request.input.decided.decide.parts.map((part) => part.outcome)).toEqual(["oneQuestion"]);
    expect(request.input.decided.context).toEqual(context());
    expect(request.core).toEqual([
      {
        call: "recordSafetyOutcome",
        request: {
          caller: request.caller,
          safety: safetyNoFor("evt-alex-0417"),
          handleId: "handle-alex",
          bookingId: null,
          sentByActor: null,
        },
      },
    ]);
    expect(outcome).toMatchObject({ reread: true, gateCalls: 1 });
    expect(face.log).toEqual(["frontier", "decide", "reread", "gate", "gate:answered"]);
    const reread = t.spans.find((span) => span.hop === "reread");
    expect(reread).toMatchObject({ outcome: "ok", got: { why: "disagreed" }, model_calls: ONE_REREAD });
    expect(reread?.decided).toMatchObject({ reread: true, oneQuestion: 1, verbs: ["ask"] });
  });

  it("never commits on a difference: a re-read that fails, or that says it did not run, sends nothing to the gate", async () => {
    for (const reread of [
      () => ({ error: "modelsDown" }),
      () => decided({ ...beforeReread(), reread: false }, ONE_REREAD),
      () => decided({ ...decideDisagree, turnId: "turn-of-another-handle" }, ONE_REREAD),
    ]) {
      const { t, face, ai } = await disagreeSetup();
      face.frontier = () => ({ context: context() as never, flagged: [], collapsedBookingIds: [] });
      ai.decide = () => decided(beforeReread());
      ai.reread = reread;
      face.gate = (request) => askedAnswer(request) as never;

      const outcome = await runTurnLoop(t.turn);

      expect(outcome.result).toBe("notCommitted");
      expect(ai.rereadCalls).toHaveLength(1);
      expect(face.gateCalls).toEqual([]);
      expect(t.commits).toEqual([]);
      restores.splice(0).forEach((restore) => {
        restore();
      });
    }
  });

  it("a value that fails its words before the re-read (commit-limit-6-reread-first.json) gets the one re-read, then the gate again (commit-limit-6-value-fails.json)", async () => {
    const first = commitLimit6First.request.input.decided;
    const { t, face, ai } = await setUp({
      who: SAM,
      turnId: "turn-s1-02-sam-vague",
      traceId: "trace-sam-0002",
      texts: [
        { eventId: "evt-sam-0002", body: "barbering and some other stuff", sentAt: "2026-10-19T14:06:00Z" },
      ],
      times: ["2026-10-19T14:06:02Z", commitLimit6First.request.now, commitLimit6Fails.request.now],
      targets: {
        roles: [{ businessId: "biz-lees-barbershop", personId: "person-sam", role: "owner" }],
        openQuestionIds: ["oq-s1-02"],
        bookingIds: [],
      },
    });
    face.frontier = () => ({ context: structuredClone(first.context), flagged: [], collapsedBookingIds: [] });
    ai.decide = () => decided(first.decide);
    ai.reread = () => decided(commitLimit6Fails.request.input.decided.decide, ONE_REREAD);
    face.gate = answersInTurn(commitLimit6First.outcome, commitLimit6Fails.outcome);

    const outcome = committed(await runTurnLoop(t.turn));

    expect(requestsOf(face)).toEqual([commitLimit6First.request, commitLimit6Fails.request]);
    expect(ai.rereadCalls).toHaveLength(1);
    expect(ai.rereadCalls[0]).toMatchObject({
      why: "valueFailsWords",
      failing: [{ part: 0, fields: ["kinds"] }],
    });
    expect(outcome).toMatchObject({ reread: true, gateCalls: 2 });
    expect(outcome.answer).toEqual(commitLimit6Fails.outcome);
    expect(t.spans.filter((span) => span.hop === "commit").map((span) => span.outcome)).toEqual([
      "refused",
      "ok",
    ]);
    expect(t.spans.find((span) => span.hop === "commit")?.error_code).toBe("valueFailsWords");
  });

  it("nothing fits: meaning search adds the closest entries (closest-entries.json) and the one re-read runs on them", async () => {
    const { t, face, ai } = await setUp({
      who: ALEX,
      turnId: "turn-alex-gift-card",
      traceId: "trace-alex-0501",
      texts: [{ eventId: "evt-alex-0501", body: "do you sell gift cards?", sentAt: "2026-10-22T16:00:00Z" }],
      times: ["2026-10-22T16:00:03Z", "2026-10-22T16:00:09Z"],
      targets: {
        roles: [{ businessId: "biz-lees-barbershop", personId: "person-alex", role: "customer" }],
        openQuestionIds: [],
        bookingIds: [],
      },
    });
    const stillNoneFits = {
      ...structuredClone(decideNoneFits),
      reads: [
        ...structuredClone(decideNoneFits.reads),
        { model: "sonnet", role: "reread", output: structuredClone(decideNoneFits.reads[0]?.output) },
      ],
      reread: true,
    };
    face.frontier = () => ({
      context: structuredClone(closestEntriesFixture.request.context) as never,
      flagged: [],
      collapsedBookingIds: [],
    });
    ai.decide = () => decided(decideNoneFits);
    face.search = () => structuredClone(closestEntriesFixture.outcome);
    ai.reread = () => decided(stillNoneFits, ONE_REREAD);
    face.gate = (request) =>
      ({
        result: "committed",
        turnId: request.turn.id,
        committedAt: request.now,
        repeated: false,
        parts: [],
        planner: null,
        core: [],
        written: { written: [], outboxRows: [], promoted: [] },
        effects: [],
        openQuestions: { opened: [], closed: [] },
      }) as never;

    committed(await runTurnLoop(t.turn));

    expect(face.searchCalls).toEqual([closestEntriesFixture.request]);
    expect(ai.rereadCalls).toHaveLength(1);
    expect(ai.rereadCalls[0]).toMatchObject({
      why: "noneFits",
      context: closestEntriesFixture.outcome.context,
    });
    const request = requestsOf(face)[0];
    if (request?.input.kind !== "decided") throw new Error("not a decided turn");
    expect(request.input.decided.context).toEqual(closestEntriesFixture.outcome.context);
    expect(request.input.decided.decide).toEqual(stillNoneFits);
    expect(request.input.planner).toBeNull();
    expect(t.spans.find((span) => span.hop === "search")).toMatchObject({
      outcome: "ok",
      got: { quotes: 1, choices: 1 },
      decided: { added: ["A3-51"], choices: 2 },
    });
  });
});

describe("the commit through the lease", () => {
  it("an answer lost on its way is sent again, once, as the same request; the repeat answers the first commit", async () => {
    const { t, face, ai } = await setUp({
      who: SAM,
      turnId: "turn-s1-02-sam-kinds",
      traceId: "trace-sam-0001",
      texts: [S1_02_TEXT],
      times: [buildFrontierS102.request.now, commitS102.request.now],
      targets: SAM_S1_02_TARGETS,
    });
    face.frontier = () => structuredClone(buildFrontierS102.outcome);
    ai.decide = () => decided(decideS102);
    face.loseGate.add(0);
    face.gate = answersInTurn({ ...commitS102.outcome, repeated: true });

    const outcome = committed(await runTurnLoop(t.turn));

    expect(requestsOf(face)).toEqual([commitS102.request, commitS102.request]);
    expect(t.commits.map((sent) => sent.answer)).toMatchObject([
      { error: "noAnswer" },
      { result: "committed" },
    ]);
    expect(outcome.answer.repeated).toBe(true);
    expect(outcome.gateCalls).toBe(2);
  });

  it("a frontier or decide that gives no answer ends the run with nothing sent to the gate", async () => {
    for (const fail of ["frontier", "decide"] as const) {
      const { t, face, ai } = await setUp({
        who: SAM,
        turnId: "turn-s1-02-sam-kinds",
        traceId: "trace-sam-0001",
        texts: [S1_02_TEXT],
        times: [buildFrontierS102.request.now],
        targets: SAM_S1_02_TARGETS,
      });
      face.frontier = () =>
        fail === "frontier"
          ? { error: "transient", sqlstate: "40001" }
          : structuredClone(buildFrontierS102.outcome);
      ai.decide = () => (fail === "decide" ? { error: "modelsDown" } : decided(decideS102));
      face.gate = answersInTurn(commitS102.outcome);

      const outcome = await runTurnLoop(t.turn);

      expect(outcome).toMatchObject({
        result: "notCommitted",
        why: fail === "frontier" ? "transient" : "modelsDown",
      });
      expect(face.gateCalls).toEqual([]);
      expect(ai.decideCalls).toHaveLength(fail === "frontier" ? 0 : 1);
      restores.splice(0).forEach((restore) => {
        restore();
      });
    }
  });
});

describe("keyword texts (K-09 README default 35; T-267's replies)", () => {
  /** T-267's shared-core double over Ben's phone, behind the gate: the core-only commit's keyword actions and rows. */
  function gateOverReplyCore(now: string): {
    core: ReturnType<typeof fakeReplyCore>;
    gate: (request: GateAndCommitRequest) => Promise<never>;
  } {
    const core = fakeReplyCore(now, [phone("+15555550131", "handle-ben", "person-ben", 3)]);
    core.ids.set("turn-ben-stop", { consent: "consent-ben-stop", reply: "out-ben-stop-reply" });
    const gate = async (request: GateAndCommitRequest): Promise<never> => {
      const records = request.core.filter((action) => action.call === "recordSafetyOutcome");
      const actions = request.core.slice(records.length);
      const answer = await core.core.commitCore({
        caller: request.caller as never,
        actions: actions as never,
      });
      if ("error" in answer) return answer as never;
      return {
        result: "committed",
        turnId: request.turn.id,
        committedAt: request.now,
        repeated: answer.repeated,
        parts: [],
        planner: null,
        core: [...records.map(() => stopRecorded.outcome.core[0]), ...answer.core],
        written: {
          written: [],
          outboxRows: [...core.outbox.values()].map((row: FakeRow) => ({
            id: row.id,
            commitSeq: row.commitSeq,
          })),
          promoted: [],
        },
        effects: [],
        openQuestions: { opened: [], closed: [] },
      } as never;
    };
    return { core, gate };
  }

  it("a bare STOP is its own core-only turn: the commit request is stop-recorded.json's, its safety record first, and the stop reply's words are written by code", async () => {
    const { t, face, ai } = await setUp({
      who: BEN,
      turnId: "turn-ben-stop",
      traceId: "trace-ben-0007",
      texts: [{ eventId: "evt-ben-0007", body: "STOP", sentAt: "2026-10-21T19:30:00Z" }],
      times: [stopRecorded.request.now],
    });
    const { core, gate } = gateOverReplyCore(stopRecorded.request.now);
    face.gate = (request) => gate(request);
    restores.push(setReplyDeps({ core: turnReplyCore, rows: core.rows, rosieNumber: ROSIE_NUMBER }));

    const outcome = committed(await runTurnLoop(t.turn));

    expect(requestsOf(face)).toEqual([stopRecorded.request]);
    // Never the frontier, decide or a re-read: a STOP waits for none of them.
    expect(face.frontierCalls).toEqual([]);
    expect(ai.decideCalls).toEqual([]);
    expect(outcome.replies?.replies.map((reply) => [reply.outcome, reply.line, reply.stopped])).toEqual([
      ["replied", "stopReply", true],
    ]);
    expect(outcome.replies?.rerun).toBe(false);
    // The stop reply's row holds the fixed line word for word, written by code: no plan lines, no composer.
    const row = core.outbox.get("out-ben-stop-reply");
    expect(row?.finalParts?.fixedLines).toEqual(["stopReply"]);
    expect(row?.plan?.plan.lines).toEqual([]);
    expect(t.spans.map((span) => span.hop)).toEqual(["guard", "gate", "commit", "fillAndChecks"]);
    for (const span of t.spans) expect(spanProblems(span)).toEqual([]);
  });

  it("when the replies say rerun, the keyword texts run again, and the commit goes through on its next run", async () => {
    const { t, face } = await setUp({
      who: BEN,
      turnId: "turn-ben-stop",
      traceId: "trace-ben-0007",
      texts: [{ eventId: "evt-ben-0007", body: "STOP", sentAt: "2026-10-21T19:30:00Z" }],
      times: [stopRecorded.request.now],
    });
    const { core, gate } = gateOverReplyCore(stopRecorded.request.now);
    // The first run's commit, and the one resend of it, find the database busy; the replies record nothing and ask again.
    face.gate = (request, index) => (index < 2 ? { error: "transient", sqlstate: "40001" } : gate(request));
    restores.push(setReplyDeps({ core: turnReplyCore, rows: core.rows, rosieNumber: ROSIE_NUMBER }));

    const outcome = committed(await runTurnLoop(t.turn));

    expect(face.gateCalls).toHaveLength(3);
    expect(requestsOf(face)).toEqual([stopRecorded.request, stopRecorded.request, stopRecorded.request]);
    expect(outcome.replies?.replies.map((reply) => reply.outcome)).toEqual(["replied"]);
    expect(core.outbox.get("out-ben-stop-reply")?.finalParts?.fixedLines).toEqual(["stopReply"]);
    expect(KEYWORD_RUNS).toBeGreaterThanOrEqual(2);
  });

  it("a keyword text beside a decided one rides in that turn's one commit, after every text's safety record, and never reaches decide", async () => {
    const { t, face, ai } = await setUp({
      who: SAM,
      turnId: "turn-s1-02-sam-kinds",
      traceId: "trace-sam-0001",
      texts: [S1_02_TEXT, { eventId: "evt-sam-0003", body: "HELP", sentAt: "2026-10-19T14:05:01Z" }],
      times: [buildFrontierS102.request.now, commitS102.request.now],
      targets: SAM_S1_02_TARGETS,
    });
    const core = fakeReplyCore(commitS102.request.now, [
      phone("+15555550100", "handle-sam", "person-sam", 3),
    ]);
    face.frontier = () => structuredClone(buildFrontierS102.outcome);
    ai.decide = () => decided(decideS102);
    face.gate = async (request) => {
      const records = request.core.filter((action) => action.call === "recordSafetyOutcome");
      const answer = await core.core.commitCore({
        caller: (request.core[records.length]?.request as { caller: never }).caller,
        actions: request.core.slice(records.length) as never,
      });
      if ("error" in answer) return answer;
      return {
        ...structuredClone(commitS102.outcome),
        core: [...records.map(() => commitS102.outcome.core[0]), ...answer.core],
      } as never;
    };
    restores.push(setReplyDeps({ core: turnReplyCore, rows: core.rows, rosieNumber: ROSIE_NUMBER }));

    const outcome = committed(await runTurnLoop(t.turn));

    // HELP never reaches the frontier or decide (the guard's hard invariant): only Sam's answer to S1-02 does.
    expect(face.frontierCalls[0]?.texts.map((text) => text.eventId)).toEqual(["evt-sam-0001"]);
    expect(ai.decideCalls).toHaveLength(1);
    expect(face.gateCalls).toHaveLength(1);
    const request = requestsOf(face)[0];
    expect(request?.input).toEqual(commitS102.request.input);
    expect(request?.turn.eventIds).toEqual(["evt-sam-0001", "evt-sam-0003"]);
    expect(request?.core.map((action) => action.call)).toEqual([
      "recordSafetyOutcome",
      "recordSafetyOutcome",
      "sendFixedLine",
    ]);
    expect(
      request?.core
        .slice(0, 2)
        .map((action) => (action.request as { safety: { eventId: string } }).safety.eventId),
    ).toEqual(["evt-sam-0001", "evt-sam-0003"]);
    expect(outcome.answer.parts).toEqual(commitS102.outcome.parts);
    expect(outcome.replies?.replies.map((reply) => [reply.keyword.kind, reply.outcome, reply.line])).toEqual([
      ["help", "replied", "helpReply"],
    ]);
  });

  it("a STOP the replies could not record (not wired) never lets the turn close without it: nothing is sent, and the lease reruns the turn", async () => {
    const { t, face } = await setUp({
      who: BEN,
      turnId: "turn-ben-stop",
      traceId: "trace-ben-0007",
      texts: [{ eventId: "evt-ben-0007", body: "STOP", sentAt: "2026-10-21T19:30:00Z" }],
      times: [stopRecorded.request.now],
    });
    face.gate = answersInTurn(stopRecorded.outcome);
    restores.push(setReplyDeps(null));

    const outcome = await runTurnLoop(t.turn);

    expect(outcome).toMatchObject({ result: "notCommitted", why: "notRecorded", gateCalls: 0 });
    expect(outcome.replies?.replies.map((reply) => [reply.outcome, reply.errorCode])).toEqual([
      ["notRecorded", "unwired"],
    ]);
    expect(face.gateCalls).toEqual([]);
    expect(t.commits).toEqual([]);
  });

  it("a keyword text that can become no core action (a STOP from a handle with no number) still lets the turn close once, with its safety record", async () => {
    const email = { kind: "email", address: "ben@example.com" };
    const { t, face } = await setUp({
      who: { handle: email, party: BEN.party },
      turnId: "turn-ben-email-stop",
      traceId: "trace-ben-0008",
      texts: [{ eventId: "evt-ben-0008", body: "STOP", sentAt: "2026-10-21T19:31:00Z" }],
      times: ["2026-10-21T19:31:02Z"],
    });
    face.gate = (request) =>
      ({
        result: "committed",
        turnId: request.turn.id,
        committedAt: request.now,
        repeated: false,
        parts: [],
        planner: null,
        core: [stopRecorded.outcome.core[0]],
        written: { written: [], outboxRows: [], promoted: [] },
        effects: [],
        openQuestions: { opened: [], closed: [] },
      }) as never;
    restores.push(
      setReplyDeps({ core: turnReplyCore, rows: fakeReplyCore("x", []).rows, rosieNumber: ROSIE_NUMBER }),
    );

    const outcome = committed(await runTurnLoop(t.turn));

    expect(outcome.replies?.replies.map((reply) => [reply.outcome, reply.errorCode])).toEqual([
      ["refused", "noPhone"],
    ]);
    expect(face.gateCalls).toHaveLength(1);
    const request = requestsOf(face)[0];
    expect(request?.input).toEqual({ kind: "coreOnly" });
    expect(request?.caller.businessId).toBeNull();
    expect(request?.core).toEqual([
      {
        call: "recordSafetyOutcome",
        request: {
          caller: request?.caller,
          safety: safetyNoFor("evt-ben-0008"),
          handleId: "handle-ben",
          bookingId: null,
          sentByActor: null,
        },
      },
    ]);
  });
});

describe("a run that is no longer the turn's", () => {
  it("a run replaced while it decides (the lease's restart, or a lapse's rerun) sends nothing to the gate", async () => {
    const { t, face, ai } = await setUp({
      who: SAM,
      turnId: "turn-s1-02-sam-kinds",
      traceId: "trace-sam-0001",
      texts: [S1_02_TEXT],
      times: [buildFrontierS102.request.now, commitS102.request.now],
      targets: SAM_S1_02_TARGETS,
    });
    face.frontier = () => structuredClone(buildFrontierS102.outcome);
    ai.decide = () => {
      t.abort();
      return decided(decideS102);
    };
    face.gate = answersInTurn(commitS102.outcome);

    const outcome = await runTurnLoop(t.turn);

    expect(outcome).toMatchObject({ result: "notCommitted", why: "replaced", gateCalls: 0 });
    expect(face.gateCalls).toEqual([]);
    expect(t.commits).toEqual([]);
  });

  it("a run replaced during its valueFailsWords re-read sends the turn to the gate no second time", async () => {
    const first = commitLimit6First.request.input.decided;
    const { t, face, ai } = await setUp({
      who: SAM,
      turnId: "turn-s1-02-sam-vague",
      traceId: "trace-sam-0002",
      texts: [
        { eventId: "evt-sam-0002", body: "barbering and some other stuff", sentAt: "2026-10-19T14:06:00Z" },
      ],
      times: ["2026-10-19T14:06:02Z", commitLimit6First.request.now, commitLimit6Fails.request.now],
      targets: {
        roles: [{ businessId: "biz-lees-barbershop", personId: "person-sam", role: "owner" }],
        openQuestionIds: ["oq-s1-02"],
        bookingIds: [],
      },
    });
    face.frontier = () => ({ context: structuredClone(first.context), flagged: [], collapsedBookingIds: [] });
    ai.decide = () => decided(first.decide);
    ai.reread = () => {
      t.abort();
      return decided(commitLimit6Fails.request.input.decided.decide, ONE_REREAD);
    };
    face.gate = answersInTurn(commitLimit6First.outcome, commitLimit6Fails.outcome);

    const outcome = await runTurnLoop(t.turn);

    expect(ai.rereadCalls).toHaveLength(1);
    expect(requestsOf(face)).toEqual([commitLimit6First.request]);
    expect(outcome).toMatchObject({ result: "notCommitted", why: "replaced", gateCalls: 1 });
    expect(t.commits).toHaveLength(1);
  });

  it("a STOP's run replaced before its commit sends nothing: the restart's run records it", async () => {
    const { t, face, facts } = await setUp({
      who: BEN,
      turnId: "turn-ben-stop",
      traceId: "trace-ben-0007",
      texts: [{ eventId: "evt-ben-0007", body: "STOP", sentAt: "2026-10-21T19:30:00Z" }],
      times: [stopRecorded.request.now],
    });
    face.gate = answersInTurn(stopRecorded.outcome);
    const core = fakeReplyCore(stopRecorded.request.now, [
      phone("+15555550131", "handle-ben", "person-ben", 3),
    ]);
    restores.push(setReplyDeps({ core: turnReplyCore, rows: core.rows, rosieNumber: ROSIE_NUMBER }));
    // The run is replaced while it reads its texts' safety results, before the replies run.
    const deps = turnDeps(facts, face, fakeDecide(face.log), keys);
    restores.push(
      setTurnDeps({
        ...deps,
        safety: {
          resultsOf(eventIds) {
            t.abort();
            return deps.safety.resultsOf(eventIds);
          },
        },
      }),
    );

    const outcome = await runTurnLoop(t.turn);

    expect(outcome).toMatchObject({ result: "notCommitted", why: "replaced", gateCalls: 0 });
    expect(facts.asked).toEqual(["evt-ben-0007"]);
    expect(face.gateCalls).toEqual([]);
    expect(core.commits).toEqual([]);
    expect(t.commits).toEqual([]);
  });
});

describe("keyword texts never wait for a missing safety result, and a STOP never waits for the decided part (ADR-015 card C; DL-508)", () => {
  /** Sam's answer to S1-02 (decided); a text of his whose safety result the turn cannot read; his keyword text. */
  const DECIDED = S1_02_TEXT;
  const NO_RESULT = { eventId: "evt-sam-0002", body: "and lawn care", sentAt: "2026-10-19T14:05:01Z" };
  const KEYWORD_ID = "evt-sam-0003";
  const WORDS = ["STOP", "START", "HELP"] as const;
  /** The steps before the gate that can fail on a run: the targets read, the frontier, decide and the one re-read. */
  const FAILING = ["targets", "frontier", "decide", "reread"] as const;

  type Word = (typeof WORDS)[number];
  type Failing = (typeof FAILING)[number];

  const keywordText = (word: Word): Omit<TextSpec, "traceId"> => ({
    eventId: KEYWORD_ID,
    body: word,
    sentAt: "2026-10-19T14:05:02Z",
  });

  /** The keyword text's own core action: a STOP's or a START's record (K-09 recordStopOrStart), HELP's fixed line. */
  const keywordAction = (word: Word): string[] =>
    word === "HELP"
      ? ["sendFixedLine", "helpReply", "handle-sam"]
      : ["recordStopOrStart", word === "STOP" ? "stop" : "start", KEYWORD_ID];

  interface ActionBody {
    safety?: { eventId: string };
    kind?: string;
    inboundEventId?: string;
    fixedLineId?: string;
    recipientHandleId?: string;
  }

  /** A request's core actions, in order: each text's record by its event id, each keyword's action by what it names. */
  function coreOf(request: GateAndCommitRequest | undefined): string[][] {
    return (request?.core ?? []).map((action) => {
      const body = action.request as ActionBody;
      if (action.call === "recordSafetyOutcome") return [action.call, body.safety?.eventId ?? ""];
      if (action.call === "recordStopOrStart")
        return [action.call, body.kind ?? "", body.inboundEventId ?? ""];
      return [action.call, body.fixedLineId ?? "", body.recipientHandleId ?? ""];
    });
  }

  /**
   * One run of Sam's turn over these texts. The safety port answers No for each text but `noResult`'s (left out, as
   * `resultsOf` leaves out a result it cannot give: ADR-015 section 3). The frontier, decide and the gate answer the S1-02
   * fixtures, unless `failing` names the step that fails on this run (the targets read and the frontier: transient;
   * decide, or the one re-read after reads that disagree: the models down). A keyword text's core action goes to T-267's
   * shared-core double over Sam's phone, behind the gate, after the records.
   */
  async function samTurn(
    texts: Omit<TextSpec, "traceId">[],
    noResult: readonly string[],
    failing: Failing | null = null,
  ): Promise<Setup> {
    const setup = await setUp({
      who: SAM,
      turnId: "turn-s1-02-sam-kinds",
      traceId: "trace-sam-0001",
      texts,
      times: [buildFrontierS102.request.now, commitS102.request.now],
      targets: SAM_S1_02_TARGETS,
    });
    const { face, ai, facts } = setup;
    for (const eventId of noResult) facts.safety.delete(eventId);
    if (failing === "targets") {
      const targets = fakeTargets();
      targets.answers.set(SAM.party.handleId, { error: "transient", sqlstate: "40001" });
      restores.push(setGuardDeps({ targets: targets.port }));
    }
    face.frontier = () =>
      failing === "frontier"
        ? { error: "transient", sqlstate: "40001" }
        : structuredClone(buildFrontierS102.outcome);
    ai.decide = () =>
      failing === "decide"
        ? { error: "modelsDown" }
        : decided(failing === "reread" ? { ...decideS102, agreed: false } : decideS102);
    ai.reread = () => ({ error: "modelsDown" });
    const core = fakeReplyCore(commitS102.request.now, [
      phone("+15555550100", "handle-sam", "person-sam", 3),
    ]);
    face.gate = async (request) => {
      const records = request.core.filter((action) => action.call === "recordSafetyOutcome");
      const answer = await core.core.commitCore({
        caller: request.caller as never,
        actions: request.core.slice(records.length) as never,
      });
      if ("error" in answer) return answer;
      const outcome = structuredClone(commitS102.outcome);
      return {
        ...outcome,
        parts: request.input.kind === "decided" ? outcome.parts : [],
        core: [...records.map(() => outcome.core[0]), ...answer.core],
      } as never;
    };
    restores.push(setReplyDeps({ core: turnReplyCore, rows: core.rows, rosieNumber: ROSIE_NUMBER }));
    return setup;
  }

  const restoreAll = (): void => {
    restores.splice(0).forEach((restore) => {
      restore();
    });
  };

  it("a decided text, a STOP and a text with no result commit on the turn's first run: the STOP's recordStopOrStart, the decided text's record, none for the text with no result, and the decided input; the same with START and with HELP", async () => {
    for (const word of WORDS) {
      const { t, face, ai, facts } = await samTurn(
        [DECIDED, NO_RESULT, keywordText(word)],
        [NO_RESULT.eventId],
      );

      const outcome = committed(await runTurnLoop(t.turn));

      // The run went past the missing result: the frontier and decide ran, and the one commit carries the decided input.
      expect(facts.asked).toEqual([DECIDED.eventId, NO_RESULT.eventId, KEYWORD_ID]);
      expect(face.frontierCalls).toHaveLength(1);
      expect(ai.decideCalls).toHaveLength(1);
      expect(face.gateCalls).toHaveLength(1);
      const request = requestsOf(face)[0];
      expect(request?.input).toEqual(commitS102.request.input);
      expect(request?.turn.eventIds).toEqual([DECIDED.eventId, NO_RESULT.eventId, KEYWORD_ID]);
      // Each text's record but the one with no result, then the keyword text's own action.
      expect(coreOf(request)).toEqual([
        ["recordSafetyOutcome", DECIDED.eventId],
        ["recordSafetyOutcome", KEYWORD_ID],
        keywordAction(word),
      ]);
      expect(request?.core[0]).toEqual({
        call: "recordSafetyOutcome",
        request: {
          caller: request?.caller,
          safety: safetyNoFor(DECIDED.eventId),
          handleId: "handle-sam",
          bookingId: null,
          sentByActor: null,
        },
      });
      expect(outcome.answer.parts).toEqual(commitS102.outcome.parts);
      expect(outcome.replies?.replies.map((reply) => [reply.keyword.kind, reply.outcome])).toEqual([
        [word.toLowerCase(), "replied"],
      ]);
      // On its first run: one commit through the lease, and the lease told the reply ended, so no lapse reruns the turn
      // and no park follows.
      expect(t.commits.map((sent) => sent.answer)).toMatchObject([{ result: "committed" }]);
      expect(t.replied.count).toBe(1);
      restoreAll();
    }
  });

  it("the same batch whose targets read, frontier, decide or re-read fails commits its keyword text core-only on its first run, with the records it has (STOP, START and HELP)", async () => {
    for (const failing of FAILING) {
      for (const word of WORDS) {
        const { t, face, ai } = await samTurn(
          [DECIDED, NO_RESULT, keywordText(word)],
          [NO_RESULT.eventId],
          failing,
        );

        const outcome = committed(await runTurnLoop(t.turn));

        // The step failed on this run, and nothing after it ran.
        expect(face.frontierCalls).toHaveLength(failing === "targets" ? 0 : 1);
        expect(ai.decideCalls).toHaveLength(failing === "targets" || failing === "frontier" ? 0 : 1);
        expect(ai.rereadCalls).toHaveLength(failing === "reread" ? 1 : 0);
        // One core-only commit, as a turn of keyword texts alone makes, under the caller of every business.
        expect(face.gateCalls).toHaveLength(1);
        const request = requestsOf(face)[0];
        expect(request?.input).toEqual({ kind: "coreOnly" });
        expect(request?.caller.businessId).toBeNull();
        expect(coreOf(request)).toEqual([
          ["recordSafetyOutcome", DECIDED.eventId],
          ["recordSafetyOutcome", KEYWORD_ID],
          keywordAction(word),
        ]);
        expect(outcome.answer.parts).toEqual([]);
        expect(outcome.replies?.replies.map((reply) => [reply.keyword.kind, reply.outcome])).toEqual([
          [word.toLowerCase(), "replied"],
        ]);
        expect(t.commits.map((sent) => sent.answer)).toMatchObject([{ result: "committed" }]);
        expect(t.replied.count).toBe(1);
        restoreAll();
      }
    }
  });

  it("a batch with no keyword text and a missing result still ends noSafetyResult, with no frontier, decide or gate call", async () => {
    const { t, face, ai, facts } = await samTurn([DECIDED, NO_RESULT], [NO_RESULT.eventId]);

    const outcome = await runTurnLoop(t.turn);

    expect(outcome).toEqual({ result: "notCommitted", why: "noSafetyResult", gateCalls: 0, replies: null });
    expect(facts.asked).toEqual([DECIDED.eventId, NO_RESULT.eventId]);
    expect(face.frontierCalls).toEqual([]);
    expect(ai.decideCalls).toEqual([]);
    expect(ai.rereadCalls).toEqual([]);
    expect(face.gateCalls).toEqual([]);
    expect(t.commits).toEqual([]);
    expect(t.replied.count).toBe(0);
  });

  it("a turn of keyword texts alone is unchanged: with its result missing, a STOP, a START or HELP commits core-only with no record for it, never reaching the frontier or decide", async () => {
    for (const word of WORDS) {
      const { t, face, ai } = await samTurn([keywordText(word)], [KEYWORD_ID]);

      const outcome = committed(await runTurnLoop(t.turn));

      expect(face.frontierCalls).toEqual([]);
      expect(ai.decideCalls).toEqual([]);
      expect(face.gateCalls).toHaveLength(1);
      const request = requestsOf(face)[0];
      expect(request?.input).toEqual({ kind: "coreOnly" });
      expect(request?.caller.businessId).toBeNull();
      expect(coreOf(request)).toEqual([keywordAction(word)]);
      expect(outcome.replies?.replies.map((reply) => reply.outcome)).toEqual(["replied"]);
      expect(t.replied.count).toBe(1);
      restoreAll();
    }
  });

  it("every result present: a decided text and a STOP whose targets read fails, and separately whose frontier, decide or re-read fails, commit the STOP on the first run through keywordTurn, with every text's record", async () => {
    for (const failing of FAILING) {
      const { t, face, ai } = await samTurn([DECIDED, keywordText("STOP")], [], failing);

      const outcome = committed(await runTurnLoop(t.turn));

      expect(face.frontierCalls).toHaveLength(failing === "targets" ? 0 : 1);
      expect(ai.rereadCalls).toHaveLength(failing === "reread" ? 1 : 0);
      expect(face.gateCalls).toHaveLength(1);
      const request = requestsOf(face)[0];
      expect(request?.input).toEqual({ kind: "coreOnly" });
      expect(request?.caller.businessId).toBeNull();
      expect(coreOf(request)).toEqual([
        ["recordSafetyOutcome", DECIDED.eventId],
        ["recordSafetyOutcome", KEYWORD_ID],
        keywordAction("STOP"),
      ]);
      expect(outcome.replies?.replies.map((reply) => [reply.outcome, reply.line, reply.stopped])).toEqual([
        ["replied", "stopReply", true],
      ]);
      // On its first run, with no rerun and no park: the lease is told the reply ended.
      expect(t.commits.map((sent) => sent.answer)).toMatchObject([{ result: "committed" }]);
      expect(t.replied.count).toBe(1);
      restoreAll();
    }
  });

  it("every result present: the same batch with START, and with HELP, in place of the STOP keeps today's behaviour: the run ends with nothing sent, and the lease's retry runs it again", async () => {
    const why: Record<Failing, string> = {
      targets: "transient",
      frontier: "transient",
      decide: "modelsDown",
      reread: "modelsDown",
    };
    for (const failing of FAILING) {
      for (const word of ["START", "HELP"] as const) {
        const { t, face, ai } = await samTurn([DECIDED, keywordText(word)], [], failing);

        const outcome = await runTurnLoop(t.turn);

        expect(outcome).toMatchObject({
          result: "notCommitted",
          why: why[failing],
          gateCalls: 0,
          replies: null,
        });
        // The models down: the AI-down path's waiting texts, as before (T-271).
        expect("aiDown" in outcome).toBe(failing === "decide" || failing === "reread");
        expect(face.frontierCalls).toHaveLength(failing === "targets" ? 0 : 1);
        expect(ai.rereadCalls).toHaveLength(failing === "reread" ? 1 : 0);
        expect(face.gateCalls).toEqual([]);
        expect(t.commits).toEqual([]);
        expect(t.replied.count).toBe(0);
        restoreAll();
      }
    }
  });

  it("a STOP's run replaced while the decided part is made sends nothing: the run that has the turn now records it", async () => {
    const { t, face, ai } = await samTurn([DECIDED, NO_RESULT, keywordText("STOP")], [NO_RESULT.eventId]);
    ai.decide = () => {
      t.abort();
      return decided(decideS102);
    };

    const outcome = await runTurnLoop(t.turn);

    expect(outcome).toMatchObject({ result: "notCommitted", why: "replaced", gateCalls: 0 });
    expect(face.gateCalls).toEqual([]);
    expect(t.commits).toEqual([]);
  });

  /**
   * How the gate refuses the decided request on its tries (DL-521), while it commits a core-only request as before: limit
   * 6 before the re-read (commit-limit-6-reread-first.json's refusal, naming part 0's field kinds), with the one re-read
   * unable to run (the models down), so there is no second try; the same with the re-read run, and the database busy on
   * its request and that request's one resend; and the database busy on the first request and its one resend.
   */
  const REFUSALS = ["valueFailsWords", "afterReread", "transient"] as const;
  type Refusal = (typeof REFUSALS)[number];

  function refuseDecided({ face, ai }: Setup, refusal: Refusal): void {
    const commit = face.gate;
    face.gate = (request, index) => {
      if (request.input.kind !== "decided") {
        return commit === null ? { error: "unwired" } : commit(request, index);
      }
      if (refusal === "transient" || request.input.decided.decide.reread) {
        return { error: "transient", sqlstate: "40001" };
      }
      return structuredClone(commitLimit6First.outcome);
    };
    ai.reread = () =>
      refusal === "afterReread"
        ? decided({ ...decideS102, reread: true }, ONE_REREAD)
        : { error: "modelsDown" };
  }

  it("every result present: a decided text and a STOP whose decided request the gate refuses on its tries commit the STOP core-only on that run, with no park (DL-521)", async () => {
    // The decided request's tries: the first request, the re-read's request and its one resend, or one resend.
    const decidedTries: Record<Refusal, number> = { valueFailsWords: 1, afterReread: 3, transient: 2 };
    for (const refusal of REFUSALS) {
      const setup = await samTurn([DECIDED, keywordText("STOP")], []);
      refuseDecided(setup, refusal);
      const { t, face, ai } = setup;

      const outcome = committed(await runTurnLoop(t.turn));

      // The decided input went to the gate on its tries only; then the keyword texts' core-only request, once.
      const requests = requestsOf(face);
      expect(requests.map((request) => request.input.kind)).toEqual([
        ...Array<string>(decidedTries[refusal]).fill("decided"),
        "coreOnly",
      ]);
      expect(requests[0]?.input).toEqual(commitS102.request.input);
      expect(ai.rereadCalls.map((request) => [request.why, request.failing])).toEqual(
        refusal === "transient" ? [] : [["valueFailsWords", [{ part: 0, fields: ["kinds"] }]]],
      );
      // Under the caller of every business, with every text's record, as a turn of keyword texts alone commits.
      const coreOnly = requests.at(-1);
      expect(coreOnly?.caller.businessId).toBeNull();
      expect(coreOf(coreOnly)).toEqual([
        ["recordSafetyOutcome", DECIDED.eventId],
        ["recordSafetyOutcome", KEYWORD_ID],
        keywordAction("STOP"),
      ]);
      expect(outcome.answer.parts).toEqual([]);
      expect(outcome.replies?.replies.map((reply) => [reply.outcome, reply.line, reply.stopped])).toEqual([
        ["replied", "stopReply", true],
      ]);
      expect(outcome.replies?.rerun).toBe(false);
      // On its run, with no rerun and no park: the lease's last commit committed, and it is told the reply ended.
      expect(t.commits.map((sent) => "result" in sent.answer)).toEqual([
        ...Array<boolean>(decidedTries[refusal]).fill(false),
        true,
      ]);
      expect(t.replied.count).toBe(1);
      restoreAll();
    }
  });

  it("every result present: the same batch with START, and with HELP, in place of the STOP keeps today's behaviour: the decided input on every commit the replies ask for, then the run ends with nothing committed, and the lease's retry", async () => {
    // Each of the replies' runs sends the decided input on its tries; the one re-read runs once in the turn's run.
    const decidedTries: Record<Refusal, number> = {
      valueFailsWords: KEYWORD_RUNS,
      afterReread: 3 + (KEYWORD_RUNS - 1),
      transient: 2 * KEYWORD_RUNS,
    };
    const lastError: Record<Refusal, string> = {
      valueFailsWords: "valueFailsWords",
      afterReread: "valueFailsWords",
      transient: "transient",
    };
    for (const refusal of REFUSALS) {
      for (const word of ["START", "HELP"] as const) {
        const setup = await samTurn([DECIDED, keywordText(word)], []);
        refuseDecided(setup, refusal);
        const { t, face, ai } = setup;

        const outcome = await runTurnLoop(t.turn);

        expect(outcome).toMatchObject({
          result: "notCommitted",
          why: "notRecorded",
          gateCalls: decidedTries[refusal],
        });
        expect(
          outcome.replies?.replies.map((reply) => [reply.keyword.kind, reply.outcome, reply.errorCode]),
        ).toEqual([[word.toLowerCase(), "notRecorded", lastError[refusal]]]);
        // The re-read that found the models down: the AI-down path's waiting texts, as before (T-271).
        expect("aiDown" in outcome).toBe(refusal === "valueFailsWords");
        expect(requestsOf(face).map((request) => request.input.kind)).toEqual(
          Array<string>(decidedTries[refusal]).fill("decided"),
        );
        expect(ai.rereadCalls).toHaveLength(refusal === "transient" ? 0 : 1);
        expect(t.commits.every((sent) => "error" in sent.answer)).toBe(true);
        expect(t.replied.count).toBe(0);
        restoreAll();
      }
    }
  });

  it("a STOP whose core-only commit is refused too gets no decided input again on that run: the replies' rerun commits it core-only at once", async () => {
    const setup = await samTurn([DECIDED, keywordText("STOP")], []);
    refuseDecided(setup, "valueFailsWords");
    const { t, face } = setup;
    const refusing = face.gate;
    // The database busy on the first core-only request and on its one resend.
    face.gate = (request, index) =>
      index === 1 || index === 2 || refusing === null
        ? { error: "transient", sqlstate: "40001" }
        : refusing(request, index);

    const outcome = committed(await runTurnLoop(t.turn));

    expect(requestsOf(face).map((request) => request.input.kind)).toEqual([
      "decided",
      "coreOnly",
      "coreOnly",
      "coreOnly",
    ]);
    expect(outcome.replies?.replies.map((reply) => [reply.outcome, reply.line, reply.stopped])).toEqual([
      ["replied", "stopReply", true],
    ]);
    expect(t.replied.count).toBe(1);
  });

  it("a STOP's run replaced while the gate refuses its decided request sends no core-only request: the run that has the turn now records it", async () => {
    const setup = await samTurn([DECIDED, keywordText("STOP")], []);
    refuseDecided(setup, "valueFailsWords");
    const { t, face, ai } = setup;
    ai.reread = () => {
      t.abort();
      return { error: "modelsDown" };
    };

    const outcome = await runTurnLoop(t.turn);

    expect(outcome).toMatchObject({ result: "notCommitted", why: "replaced", gateCalls: 1 });
    expect(requestsOf(face).map((request) => request.input.kind)).toEqual(["decided"]);
    expect(t.commits).toHaveLength(1);
    expect(t.replied.count).toBe(0);
  });
});
