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
import commitRefused from "../../../contracts/tool-api/fixtures/commit-s1-02-refused-step-not-in-bundle.json";
import commitS102 from "../../../contracts/tool-api/fixtures/commit-s1-02.json";
import commitNotBuilt from "../../../contracts/tool-api/fixtures/commit-s1-04-not-built.json";
import stopRecorded from "../../../contracts/tool-api/fixtures/stop-recorded.json";
import parkTurnSamRefused from "../../../contracts/data-access/fixtures/park-turn-sam-refused-at-once.json";
import pollVote from "../../../contracts/inbound-event/fixtures/poll-vote.json";
import decideDisagree from "../../../contracts/model/fixtures/decide-reads-disagree.json";
import decideNoneFits from "../../../contracts/model/fixtures/decide-none-fits.json";
import decideS102 from "../../../contracts/model/fixtures/decide-s1-02-choose.json";
import safetyCrisisWords from "../../../contracts/model/fixtures/safety-crisis-words.json";
import safetyEmergencyNow from "../../../contracts/model/fixtures/safety-emergency-now.json";
import safetyThreat from "../../../contracts/model/fixtures/safety-threat.json";
import safetyTimeoutDangerWord from "../../../contracts/model/fixtures/safety-timeout-danger-word.json";
import type { CommitContext, InboxEntry, LeasedTurn } from "../actor";
import { BUNDLE_A, BUNDLE_B, WHOLE_A, WHOLE_B } from "../bundle/test-support";
import { prepareHandoff, type HandleRef, type InboundEvent } from "../gateway";
import { fakeKeyStore } from "../gateway/test-support";
import { setGuardDeps, setReplyDeps } from "../guard";
import { fakeCore as fakeReplyCore, phone, ROSIE_NUMBER, type FakeRow } from "../guard/replies/test-support";
import { fakeTargets } from "../guard/test-support";
import type { SafetyResult } from "../safety/types";
import { spanProblems, type BundleId } from "../trace";
import { KEYWORD_RUNS, runTurnLoop, setTurnDeps, turnReplyCore, type TurnOutcome } from "./index";
import { PASSED_ON_LINE, parkedRowId } from "./park";
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
  fakeReply,
  fakeTurnFace,
  safetyNoFor,
  storedText,
  targetsAnswer,
  testTurn,
  turnDeps,
  type FakeDecide,
  type FakeFacts,
  type FakeReply,
  type FakeTurnFace,
  type TestTurn,
  type TextSpec,
} from "./test-support";
import type {
  DecideResult,
  GateAndCommitRequest,
  ParkTurnLineRequest,
  ParkTurnRequest,
  TurnParty,
} from "./types";

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
  /** The second half's doubles: K-05's rows (its parkTurn among them) and the dispatcher, logging into the face's log. */
  reply: FakeReply;
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
  const reply = fakeReply();
  const facts = fakeFacts(spec.who.party, spec.times);
  for (const text of spec.texts) facts.safety.set(text.eventId, safetyNoFor(text.eventId));
  restores.push(setTurnDeps(turnDeps(facts, face, ai, keys, reply)));
  const targets = fakeTargets();
  targets.answers.set(
    spec.who.party.handleId,
    targetsAnswer(
      spec.who.party.handleId,
      spec.targets ?? { roles: [], openQuestionIds: [], bookingIds: [] },
    ),
  );
  restores.push(setGuardDeps({ targets: targets.port }));
  return { t, face, ai, facts, reply };
}

/**
 * A vote as the actor's inbox keeps it: K-06's poll-vote.json with this event's id, option words, send time and trace,
 * scrubbed and sealed by the gateway's own hand-off (K-06 v1.2: the option's words in the box, none in the clear).
 */
async function storedVote(
  spec: { eventId: string; optionWords: string; sentAt: string; traceId: string },
  handle: HandleRef,
  seq: number,
): Promise<InboxEntry> {
  const overrides: Json = {
    eventId: spec.eventId,
    handle,
    sentAt: spec.sentAt,
    traceId: spec.traceId,
    poll: { ...pollVote.poll, optionWords: spec.optionWords },
  };
  const event = { ...(pollVote as Json), ...overrides } as InboundEvent;
  const prepared = await prepareHandoff(
    { event, partKey: null, traceId: spec.traceId, bundleId: BUNDLE_A },
    keys,
  );
  if (prepared.door !== "actor") throw new Error("not an actor event");
  return {
    seq,
    event: prepared.handoff.event,
    partKey: null,
    traceId: spec.traceId,
    bundleId: BUNDLE_A,
    startsTurn: true,
  };
}

/** As `setUp`, for a turn of these stored entries on bundle A, each with safety-no.json as its safety result. */
async function setUpEntries(spec: {
  who: Party;
  turnId: string;
  traceId: string;
  entries: InboxEntry[];
  times: string[];
}): Promise<Setup> {
  const t = testTurn({
    turnId: spec.turnId,
    traceId: spec.traceId,
    bundleId: BUNDLE_A,
    manifest: await checkedManifest(WHOLE_A, BUNDLE_A),
    entries: spec.entries,
  });
  const face = fakeTurnFace();
  const ai = fakeDecide(face.log);
  const reply = fakeReply();
  const facts = fakeFacts(spec.who.party, spec.times);
  for (const entry of spec.entries) facts.safety.set(entry.event.eventId, safetyNoFor(entry.event.eventId));
  restores.push(setTurnDeps(turnDeps(facts, face, ai, keys, reply)));
  const targets = fakeTargets();
  const { handleId } = spec.who.party;
  targets.answers.set(handleId, targetsAnswer(handleId, { roles: [], openQuestionIds: [], bookingIds: [] }));
  restores.push(setGuardDeps({ targets: targets.port }));
  return { t, face, ai, facts, reply };
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

  it("a vote for an option that reads STOP is a STOP too (DL-540): its words opened from its box, its own core-only turn, the commit request stop-recorded.json's", async () => {
    const vote = await storedVote(
      {
        eventId: "evt-ben-0007",
        optionWords: "STOP",
        sentAt: "2026-10-21T19:30:00Z",
        traceId: "trace-ben-0007",
      },
      BEN.handle,
      1,
    );
    // The gateway sealed the option's words (K-06 v1.2): the stored vote holds them only in its form 2 box.
    expect(vote.event.poll).toEqual({ pollId: pollVote.poll.pollId, optionId: pollVote.poll.optionId });
    expect(vote.event.sealed?.v).toBe(2);
    expect(JSON.stringify(vote.event)).not.toContain('"STOP"');
    const { t, face, ai } = await setUpEntries({
      who: BEN,
      turnId: "turn-ben-stop",
      traceId: "trace-ben-0007",
      entries: [vote],
      times: [stopRecorded.request.now],
    });
    const { core, gate } = gateOverReplyCore(stopRecorded.request.now);
    face.gate = (request) => gate(request);
    restores.push(setReplyDeps({ core: turnReplyCore, rows: core.rows, rosieNumber: ROSIE_NUMBER }));

    const outcome = committed(await runTurnLoop(t.turn));

    // The same one commit as a typed STOP's: the vote's safety record first (it is read on arrival now), then its STOP.
    expect(requestsOf(face)).toEqual([stopRecorded.request]);
    expect(face.frontierCalls).toEqual([]);
    expect(ai.decideCalls).toEqual([]);
    expect(
      outcome.replies?.replies.map((reply) => [reply.text.kind, reply.outcome, reply.line, reply.stopped]),
    ).toEqual([["pollVote", "replied", "stopReply", true]]);
    expect(core.outbox.get("out-ben-stop-reply")?.finalParts?.fixedLines).toEqual(["stopReply"]);
  });

  it("a vote for an option of other words goes on to the frontier as K-02's pollVote text, its words opened from its box", async () => {
    const vote = await storedVote(
      {
        eventId: pollVote.eventId,
        optionWords: "Sat 2:00pm",
        sentAt: pollVote.sentAt,
        traceId: "trace-alex-0009",
      },
      ALEX.handle,
      1,
    );
    expect(vote.event.poll).toEqual({ pollId: pollVote.poll.pollId, optionId: pollVote.poll.optionId });
    const { t, face } = await setUpEntries({
      who: ALEX,
      turnId: "turn-alex-vote",
      traceId: "trace-alex-0009",
      entries: [vote],
      times: ["2026-10-23T14:06:42Z"],
    });

    await runTurnLoop(t.turn);

    expect(face.frontierCalls.map((request) => request.texts)).toEqual([
      [
        {
          eventId: pollVote.eventId,
          kind: "pollVote",
          words: "Sat 2:00pm",
          sentAt: { utc: pollVote.sentAt, zone: ALEX.party.zone },
          attachments: [],
          poll: { pollId: pollVote.poll.pollId, optionId: pollVote.poll.optionId },
          tapback: null,
        },
      ],
    ]);
  });

  it("a vote kept before K-06 v1.2 (no box, its option words plain) is read as it was kept: its words from its poll, a STOP among them", async () => {
    const sealed = await storedVote(
      {
        eventId: "evt-ben-0007",
        optionWords: "STOP",
        sentAt: "2026-10-21T19:30:00Z",
        traceId: "trace-ben-0007",
      },
      BEN.handle,
      1,
    );
    // As T-243's gateway kept a vote: no box, the option's words in its plain poll (README item 5).
    const kept: InboxEntry = {
      ...sealed,
      event: { ...sealed.event, sealed: null, poll: { ...pollVote.poll, optionWords: "STOP" } },
    };
    const { t, face, ai } = await setUpEntries({
      who: BEN,
      turnId: "turn-ben-stop",
      traceId: "trace-ben-0007",
      entries: [kept],
      times: [stopRecorded.request.now],
    });
    const { core, gate } = gateOverReplyCore(stopRecorded.request.now);
    face.gate = (request) => gate(request);
    restores.push(setReplyDeps({ core: turnReplyCore, rows: core.rows, rosieNumber: ROSIE_NUMBER }));

    const outcome = committed(await runTurnLoop(t.turn));

    // Its STOP is the one core action: kept with no box, it was never read on arrival, so no safety record rides with it.
    expect(requestsOf(face)).toEqual([
      {
        ...stopRecorded.request,
        core: stopRecorded.request.core.filter((action) => action.call !== "recordSafetyOutcome"),
      },
    ]);
    expect(ai.decideCalls).toEqual([]);
    expect(outcome.replies?.replies.map((reply) => [reply.outcome, reply.stopped])).toEqual([
      ["replied", true],
    ]);
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
    // The run is replaced while it reads its texts' safety results through its leased turn, before the replies run.
    const turn: LeasedTurn = {
      ...t.turn,
      resultsOf: (eventIds) => {
        t.abort();
        return t.turn.resultsOf(eventIds);
      },
    };

    const outcome = await runTurnLoop(turn);

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

  it("a STOP turn whose replies run again after its decided commit went through: the rerun's core-only commit is answered repeated, as K-05 answers the first commit, and its gate span says so, not zero parts as if nothing committed", async () => {
    const { t, face, ai } = await setUp({
      who: SAM,
      turnId: "turn-s1-02-sam-kinds",
      traceId: "trace-sam-0001",
      texts: [DECIDED, keywordText("STOP")],
      times: [buildFrontierS102.request.now, commitS102.request.now],
      targets: SAM_S1_02_TARGETS,
    });
    face.frontier = () => structuredClone(buildFrontierS102.outcome);
    ai.decide = () => decided(decideS102);
    const core = fakeReplyCore(commitS102.request.now, [
      phone("+15555550100", "handle-sam", "person-sam", 3),
    ]);
    core.ids.set("turn-s1-02-sam-kinds", { reply: "out-sam-stop-reply" });
    // The stop reply's words are left unwritten once (the answer lost on its way), so the replies ask for the turn to run
    // again after the commit went through.
    core.failPlanOnce.add("out-sam-stop-reply");
    // K-09 gateAndCommit as the action layer answers it: one commit per turn id, the shared core behind it. A repeat
    // writes nothing and answers the first commit (K-09 README: "a repeat returns the first commit"; K-05 v1 item 1): its
    // rows, `repeated`, and the parts gated in this call, none for a core-only request.
    face.gate = async (request) => {
      const records = request.core.filter((action) => action.call === "recordSafetyOutcome");
      const answer = await core.core.commitCore({
        caller: request.caller as never,
        actions: request.core.slice(records.length) as never,
      });
      if ("error" in answer) return answer;
      const outcome = structuredClone(commitS102.outcome);
      const results = [...records.map(() => outcome.core[0]), ...answer.core];
      if (!answer.repeated) return { ...outcome, core: results } as never;
      return {
        ...outcome,
        repeated: true,
        parts: request.input.kind === "decided" ? outcome.parts : [],
        core: results,
        written: { written: [], outboxRows: outcome.written.outboxRows, promoted: [] },
        openQuestions: { opened: [], closed: [] },
      } as never;
    };
    restores.push(setReplyDeps({ core: turnReplyCore, rows: core.rows, rosieNumber: ROSIE_NUMBER }));

    const outcome = committed(await runTurnLoop(t.turn));

    // The decided commit went through on the replies' first run; their rerun sent the core-only repeat.
    expect(requestsOf(face).map((request) => request.input.kind)).toEqual(["decided", "coreOnly"]);
    expect(t.commits.map((sent) => sent.answer)).toMatchObject([
      { result: "committed", repeated: false },
      { result: "committed", repeated: true },
    ]);
    // The rerun's gate span says it was answered as a repeat of the turn's commit, beside the first commit's part.
    const gates = t.spans.filter((span) => span.hop === "gate");
    expect(gates.map((span) => [span.outcome, span.decided])).toEqual([
      ["ok", { part: 0, result: "committed", choice: "c-01" }],
      ["ok", { parts: 0, repeated: true }],
    ]);
    const commits = t.spans.filter((span) => span.hop === "commit");
    expect(commits.map((span) => span.decided?.repeated)).toEqual([false, true]);
    for (const span of t.spans) expect(spanProblems(span)).toEqual([]);
    // The STOP was recorded once, and its reply's words written on the rerun.
    expect(core.consents).toHaveLength(1);
    expect(outcome.replies?.replies.map((reply) => [reply.outcome, reply.line, reply.stopped])).toEqual([
      ["replied", "stopReply", true],
    ]);
    expect(outcome.replies?.rerun).toBe(false);
    expect(core.outbox.get("out-sam-stop-reply")?.finalParts?.fixedLines).toEqual(["stopReply"]);
    expect(t.replied.count).toBe(1);
  });
});

describe("a STOP read as danger is still recorded: a keyword turn committed with no business that holds a stop word leaves out each danger text's safety record, so the STOP commits at once and the danger text stays unread (DL-944, the architect's card E; T-1454)", () => {
  /** Ben's keyword texts (stop-recorded.json's STOP is evt-ben-0007). */
  const HELP = { eventId: "evt-ben-0006", body: "HELP", sentAt: "2026-10-21T19:29:58Z" };
  const STOP = { eventId: "evt-ben-0007", body: "STOP", sentAt: "2026-10-21T19:30:00Z" };
  const START = { eventId: "evt-ben-0008", body: "START", sentAt: "2026-10-21T19:30:00Z" };
  /** Sam's answer to S1-02 (decided) and his STOP. */
  const DECIDED = S1_02_TEXT;
  const SAM_STOP = { eventId: "evt-sam-0003", body: "STOP", sentAt: "2026-10-19T14:05:02Z" };
  const BEN_PHONE = "+15555550131";
  const SAM_PHONE = "+15555550100";

  /** K-02's reads that find danger (any outcome but No): an emergency, crisis words, Unsure by a danger word, a threat. */
  const DANGER: Readonly<Record<string, unknown>> = {
    emergency: safetyEmergencyNow,
    crisisWords: safetyCrisisWords,
    unsureOnTimeout: safetyTimeoutDangerWord,
    threat: safetyThreat,
  };

  /** A read as the read on arrival kept it for one text: the fixture under that text's own event id. */
  const readAs = (fixture: unknown, eventId: string): SafetyResult => ({
    ...(structuredClone(fixture) as SafetyResult),
    eventId,
  });

  type Gate = NonNullable<FakeTurnFace["gate"]>;
  type Core = ReturnType<typeof fakeReplyCore>;
  type Wired = Setup & { core: Core; gate: Gate };

  /** True for a text's safety record read as anything but No (an Unsure included). */
  const isDangerRecord = (action: GateAndCommitRequest["core"][number]): boolean =>
    action.call === "recordSafetyOutcome" &&
    (action.request as { safety: SafetyResult }).safety.outcomes.some((outcome) => outcome !== "No");

  /**
   * K-09 gateAndCommit as staging's gate answers it (T-1415's realGate): a core-only request whose caller names no business
   * goes to the keyword door, whose commit answers a safety record read as anything but No notBuilt and rolls the whole
   * commit back, the STOP's record with it, writing nothing (actions turn-face/commit.ts noBusinessSafetyLines, its
   * default 5; DL-864 note 2; door.test.ts's "a danger outcome in a keyword turn answers notBuilt"). Every other request
   * goes on to `commit`.
   */
  const throughKeywordDoor =
    (commit: Gate): Gate =>
    (request, index) =>
      request.input.kind === "coreOnly" &&
      request.caller.businessId === null &&
      request.core.some(isDangerRecord)
        ? { error: "notBuilt", call: "gateAndCommit" }
        : commit(request, index);

  /**
   * The commit behind the gate, over T-267's shared-core double: each record answered as stop-recorded.json's, the keyword
   * texts' core actions by the core; a decided request answered commit-s1-02.json's (its parts), a core-only one with no
   * parts and the core's own rows.
   */
  function overReplyCore(core: Core): Gate {
    return async (request) => {
      const records = request.core.filter((action) => action.call === "recordSafetyOutcome");
      const answer = await core.core.commitCore({
        caller: request.caller as never,
        actions: request.core.slice(records.length) as never,
      });
      if ("error" in answer) return answer;
      const results = [...records.map(() => structuredClone(stopRecorded.outcome.core[0])), ...answer.core];
      if (request.input.kind === "decided") {
        return { ...structuredClone(commitS102.outcome), core: results } as never;
      }
      const outboxRows = [...core.outbox.values()].map((row) => ({ id: row.id, commitSeq: row.commitSeq }));
      return {
        result: "committed",
        turnId: request.turn.id,
        committedAt: request.now,
        repeated: answer.repeated,
        parts: [],
        planner: null,
        core: results,
        written: { written: [], outboxRows, promoted: [] },
        effects: [],
        openQuestions: { opened: [], closed: [] },
      } as never;
    };
  }

  /** The gate through the keyword door over the shared core of this phone, and the replies wired to that core. */
  function wire(setup: Setup, now: string, phoneOf: ReturnType<typeof phone>): Wired {
    const core = fakeReplyCore(now, [phoneOf]);
    const gate = throughKeywordDoor(overReplyCore(core));
    setup.face.gate = gate;
    restores.push(setReplyDeps({ core: turnReplyCore, rows: core.rows, rosieNumber: ROSIE_NUMBER }));
    return { ...setup, core, gate };
  }

  /**
   * Ben's turn of keyword texts alone (stop-recorded.json's turn and trace ids), each text read as `read` gives it, else
   * No, with the lease's CommitContext `context` when given.
   */
  async function benRun(
    texts: Omit<TextSpec, "traceId">[],
    read: Readonly<Record<string, SafetyResult>>,
    context?: CommitContext,
  ): Promise<Wired> {
    const setup = await setUp({
      who: BEN,
      turnId: "turn-ben-stop",
      traceId: "trace-ben-0007",
      texts,
      times: [stopRecorded.request.now],
      ...(context === undefined ? {} : { context }),
    });
    for (const [eventId, result] of Object.entries(read)) setup.facts.safety.set(eventId, result);
    const wired = wire(setup, stopRecorded.request.now, phone(BEN_PHONE, "handle-ben", "person-ben", 3));
    wired.core.ids.set("turn-ben-stop", { consent: "consent-ben-stop", reply: "out-ben-stop-reply" });
    return wired;
  }

  /** Sam's turn (S1-02's ids; the frontier and decide answer its fixtures), each text read as `read` gives it, else No. */
  async function samRun(
    texts: Omit<TextSpec, "traceId">[],
    read: Readonly<Record<string, SafetyResult>>,
  ): Promise<Wired> {
    const setup = await setUp({
      who: SAM,
      turnId: "turn-s1-02-sam-kinds",
      traceId: "trace-sam-0001",
      texts,
      times: [buildFrontierS102.request.now, commitS102.request.now],
      targets: SAM_S1_02_TARGETS,
    });
    for (const [eventId, result] of Object.entries(read)) setup.facts.safety.set(eventId, result);
    setup.face.frontier = () => structuredClone(buildFrontierS102.outcome);
    setup.ai.decide = () => decided(decideS102);
    return wire(setup, commitS102.request.now, phone(SAM_PHONE, "handle-sam", "person-sam", 3));
  }

  /** A request's core actions in order: a record by its text, a STOP's or START's record by kind and text, a line by id. */
  function callsOf(request: GateAndCommitRequest | undefined): string[][] {
    return (request?.core ?? []).map((action) => {
      const body = action.request as {
        safety?: { eventId: string };
        kind?: string;
        inboundEventId?: string;
        fixedLineId?: string;
      };
      if (action.call === "recordSafetyOutcome") return [action.call, body.safety?.eventId ?? ""];
      if (action.call === "recordStopOrStart")
        return [action.call, body.kind ?? "", body.inboundEventId ?? ""];
      return [action.call, body.fixedLineId ?? ""];
    });
  }

  const stopReplies = (outcome: TurnOutcome): unknown[][] | undefined =>
    outcome.replies?.replies.map((reply) => [reply.keyword.kind, reply.outcome, reply.line, reply.stopped]);

  const restoreAll = (): void => {
    restores.splice(0).forEach((restore) => {
      restore();
    });
  };

  it("a STOP beside a text read as an emergency, keyword texts alone: the core-only commit holds the STOP's record and recordStopOrStart and no danger record, so the STOP is recorded for every business and its one reply goes, while the danger text's result is still kept and its hold handed on as it was (on main the door refuses the commit, notBuilt, and the STOP is never recorded)", async () => {
    const emergency = readAs(safetyEmergencyNow, HELP.eventId);
    // The danger text's hold as the actor keeps it until PostgreSQL records it: no hold id, its outcome's rule.
    const context: CommitContext = {
      holds: [
        {
          eventId: HELP.eventId,
          holdId: null,
          rule: "after_safe",
          outcomes: ["An emergency"],
          blocksBooking: true,
        },
      ],
      unread: [],
    };
    const { t, face, ai, facts, core } = await benRun([HELP, STOP], { [HELP.eventId]: emergency }, context);

    const outcome = committed(await runTurnLoop(t.turn));

    // One core-only commit on the turn's first run, under the caller of every business; never the frontier or decide.
    expect(face.frontierCalls).toEqual([]);
    expect(ai.decideCalls).toEqual([]);
    expect(face.gateCalls).toHaveLength(1);
    const request = requestsOf(face)[0];
    expect(request?.input).toEqual({ kind: "coreOnly" });
    expect(request?.caller).toEqual(stopRecorded.request.caller);
    expect(request?.turn.eventIds).toEqual([HELP.eventId, STOP.eventId]);
    // The STOP's record (No), its recordStopOrStart, then HELP's line, in the return order; nothing names the danger text:
    // no record for it and no release of its hold.
    expect(callsOf(request)).toEqual([
      ["recordSafetyOutcome", STOP.eventId],
      ["recordStopOrStart", "stop", STOP.eventId],
      ["sendFixedLine", "helpReply"],
    ]);
    expect(JSON.stringify(request?.core)).not.toContain(HELP.eventId);
    // The lease's CommitContext reached the gate as the lease handed it: the danger text's hold binds this commit.
    expect(face.gateCalls[0]?.at).toBe(t.context);
    expect(t.context).toEqual(context);
    // The STOP is recorded for every business (one texts row with no business, the number stopped), and its one reply's
    // words are written by code; HELP's line goes to no stopped number.
    expect(core.consents.map((row) => [row.id, row.businessId, row.revoked])).toEqual([
      ["consent-ben-stop", null, true],
    ]);
    expect(core.phones.get(BEN_PHONE)?.stopped).toBe(true);
    expect(core.outbox.get("out-ben-stop-reply")?.finalParts?.fixedLines).toEqual(["stopReply"]);
    expect(stopReplies(outcome)).toEqual([
      ["help", "refused", null, null],
      ["stop", "replied", "stopReply", true],
    ]);
    expect(outcome.replies?.rerun).toBe(false);
    // The danger text's result is still kept, as the read on arrival gave it: the turn read it and changed nothing.
    expect(facts.asked).toEqual([HELP.eventId, STOP.eventId]);
    expect(facts.safety.get(HELP.eventId)).toEqual(emergency);
    expect(t.commits.map((sent) => sent.answer)).toMatchObject([{ result: "committed" }]);
    expect(t.replied.count).toBe(1);
  });

  it("a bare STOP whose own text is read as danger (tp-01's case): its record is left out and the STOP commits at once, stop-recorded.json's request but for that record, for an emergency, crisis words, Unsure by a danger word and a threat alike", async () => {
    for (const [name, fixture] of Object.entries(DANGER)) {
      const danger = readAs(fixture, STOP.eventId);
      const { t, face, facts, core } = await benRun([STOP], { [STOP.eventId]: danger });

      const outcome = committed(await runTurnLoop(t.turn));

      expect(requestsOf(face), name).toEqual([
        {
          ...stopRecorded.request,
          core: stopRecorded.request.core.filter((action) => action.call !== "recordSafetyOutcome"),
        },
      ]);
      expect(core.consents, name).toHaveLength(1);
      expect(core.phones.get(BEN_PHONE)?.stopped, name).toBe(true);
      expect(core.outbox.get("out-ben-stop-reply")?.finalParts?.fixedLines, name).toEqual(["stopReply"]);
      expect(stopReplies(outcome), name).toEqual([["stop", "replied", "stopReply", true]]);
      expect(facts.safety.get(STOP.eventId), name).toEqual(danger);
      expect(t.replied.count, name).toBe(1);
      restoreAll();
    }
  });

  it("a STOP from a handle with no number, read as danger, can become no core action: the turn still closes once, with no record for the danger text, and its result is kept", async () => {
    const email = { kind: "email", address: "ben@example.com" };
    const setup = await setUp({
      who: { handle: email, party: BEN.party },
      turnId: "turn-ben-email-stop",
      traceId: "trace-ben-0008",
      texts: [{ eventId: "evt-ben-0009", body: "STOP", sentAt: "2026-10-21T19:31:00Z" }],
      times: ["2026-10-21T19:31:02Z"],
    });
    const danger = readAs(safetyEmergencyNow, "evt-ben-0009");
    setup.facts.safety.set("evt-ben-0009", danger);
    const { t, face, facts, core } = wire(
      setup,
      "2026-10-21T19:31:02Z",
      phone(BEN_PHONE, "handle-ben", "person-ben"),
    );

    const outcome = committed(await runTurnLoop(t.turn));

    expect(outcome.replies?.replies.map((reply) => [reply.outcome, reply.errorCode])).toEqual([
      ["refused", "noPhone"],
    ]);
    expect(face.gateCalls).toHaveLength(1);
    const request = requestsOf(face)[0];
    expect(request?.input).toEqual({ kind: "coreOnly" });
    expect(request?.caller.businessId).toBeNull();
    expect(request?.core).toEqual([]);
    expect(core.consents).toEqual([]);
    expect(facts.safety.get("evt-ben-0009")).toEqual(danger);
    expect(t.replied.count).toBe(1);
  });

  it("a STOP beside a decided text read as danger whose decided request the gate refuses on its tries (DL-521): the decided request keeps the danger record first, under the business, and the core-only commit that follows leaves it out and records the STOP", async () => {
    // The decided request's tries: refused by limit 6 before the re-read, which cannot run; or the database busy on it and
    // on its one resend.
    const decidedTries = { valueFailsWords: 1, transient: 2 } as const;
    for (const refusal of ["valueFailsWords", "transient"] as const) {
      const emergency = readAs(safetyEmergencyNow, DECIDED.eventId);
      const { t, face, ai, core, gate } = await samRun([DECIDED, SAM_STOP], { [DECIDED.eventId]: emergency });
      face.gate = (request, index) => {
        if (request.input.kind !== "decided") return gate(request, index);
        if (refusal === "transient") return { error: "transient", sqlstate: "40001" };
        return structuredClone(commitLimit6First.outcome);
      };
      ai.reread = () => ({ error: "modelsDown" });

      const outcome = committed(await runTurnLoop(t.turn));

      const requests = requestsOf(face);
      expect(
        requests.map((request) => request.input.kind),
        refusal,
      ).toEqual([...Array<string>(decidedTries[refusal]).fill("decided"), "coreOnly"]);
      // The decided request names the business and keeps every text's record, the danger text's first (unchanged).
      expect(requests[0]?.caller.businessId, refusal).toBe(SAM.party.businessId);
      expect(callsOf(requests[0]), refusal).toEqual([
        ["recordSafetyOutcome", DECIDED.eventId],
        ["recordSafetyOutcome", SAM_STOP.eventId],
        ["recordStopOrStart", "stop", SAM_STOP.eventId],
      ]);
      // The core-only commit, under the caller of every business, leaves the danger record out and records the STOP.
      const coreOnly = requests.at(-1);
      expect(coreOnly?.caller.businessId, refusal).toBeNull();
      expect(callsOf(coreOnly), refusal).toEqual([
        ["recordSafetyOutcome", SAM_STOP.eventId],
        ["recordStopOrStart", "stop", SAM_STOP.eventId],
      ]);
      expect(core.phones.get(SAM_PHONE)?.stopped, refusal).toBe(true);
      expect(outcome.answer.parts, refusal).toEqual([]);
      expect(stopReplies(outcome), refusal).toEqual([["stop", "replied", "stopReply", true]]);
      expect(t.replied.count, refusal).toBe(1);
      restoreAll();
    }
  });

  it("a STOP beside a decided text read as danger whose decided part cannot be made on its run (its frontier or decide fails: DL-508): the keyword texts' core-only commit leaves the danger record out and records the STOP on that run", async () => {
    for (const failing of ["frontier", "decide"] as const) {
      const emergency = readAs(safetyEmergencyNow, DECIDED.eventId);
      const { t, face, ai, core } = await samRun([DECIDED, SAM_STOP], { [DECIDED.eventId]: emergency });
      if (failing === "frontier") face.frontier = () => ({ error: "transient", sqlstate: "40001" });
      else ai.decide = () => ({ error: "modelsDown" });

      const outcome = committed(await runTurnLoop(t.turn));

      expect(face.gateCalls, failing).toHaveLength(1);
      const request = requestsOf(face)[0];
      expect(request?.input, failing).toEqual({ kind: "coreOnly" });
      expect(request?.caller.businessId, failing).toBeNull();
      expect(callsOf(request), failing).toEqual([
        ["recordSafetyOutcome", SAM_STOP.eventId],
        ["recordStopOrStart", "stop", SAM_STOP.eventId],
      ]);
      expect(core.phones.get(SAM_PHONE)?.stopped, failing).toBe(true);
      expect(stopReplies(outcome), failing).toEqual([["stop", "replied", "stopReply", true]]);
      expect(t.replied.count, failing).toBe(1);
      restoreAll();
    }
  });

  it("HELP read as danger, and START read as danger, with no stop word in the turn keep DL-864 note 2's answer: the core-only commit carries the danger record first, the keyword door answers notBuilt, and nothing is written; that notBuilt is final (K-09 v1.13 default 219), so no second commit goes and the turn is parked at once with the passedOn line (default 218; 'Who reads v1.13', the runtime engineer's note a)", async () => {
    for (const text of [HELP, START]) {
      const danger = readAs(safetyEmergencyNow, text.eventId);
      const { t, face, core, reply } = await benRun([text], { [text.eventId]: danger });

      const outcome = await runTurnLoop(t.turn);

      const reason = { from: "toolApi", fault: "notBuilt", ids: ["gateAndCommit"] };
      expect(outcome, text.body).toMatchObject({
        result: "notCommitted",
        why: "notRecorded",
        gateCalls: 1,
        parkedAtOnce: { reason, answer: { result: "parked", repeated: false } },
      });
      expect("aiDown" in outcome, text.body).toBe(false);
      const own =
        text === HELP ? ["sendFixedLine", "helpReply"] : ["recordStopOrStart", "start", text.eventId];
      // One core-only commit: the replies run no second one after the final answer.
      expect(requestsOf(face), text.body).toHaveLength(1);
      const request = requestsOf(face)[0];
      expect(request?.caller.businessId, text.body).toBeNull();
      expect(callsOf(request), text.body).toEqual([["recordSafetyOutcome", text.eventId], own]);
      // The door's one answer, then the lease told the turn is parked, with no call (K-05 commitTurn's turnParked).
      expect(
        t.commits.map((sent) => sent.answer),
        text.body,
      ).toEqual([
        { error: "notBuilt", call: "gateAndCommit" },
        { error: "turnParked", turnId: "turn-ben-stop", parkedAt: stopRecorded.request.now },
      ]);
      expect(
        outcome.replies?.replies.map((one) => [one.outcome, one.errorCode]),
        text.body,
      ).toEqual([["notRecorded", "notBuilt"]]);
      // Nothing written by the commit: the shared core behind the door never ran.
      expect(core.commits, text.body).toEqual([]);
      expect(core.consents, text.body).toEqual([]);
      expect(core.outbox.size, text.body).toBe(0);
      // The park: Ben's turn on try 1, the notBuilt reason, the passedOn line's row to Ben's own handle alone.
      expect(reply.rows.parks, text.body).toHaveLength(1);
      expect(reply.rows.parks[0], text.body).toMatchObject({
        turn: { id: "turn-ben-stop", handleId: "handle-ben", tries: 1 },
        reason,
        outboxRows: [
          { id: "out-turn-ben-stop-parked", recipientHandleId: "handle-ben", sendClass: "quick_reply" },
        ],
      });
      expect(reply.dispatcher.wakes, text.body).toEqual([
        { turnId: "turn-ben-stop", handleId: "handle-ben", outboxRowIds: ["out-turn-ben-stop-parked"] },
      ]);
      expect(t.replied.count, text.body).toBe(0);
      restoreAll();
    }
  });

  it("unchanged: a STOP whose texts are all read as No keeps every record, in the return order: beside HELP, alone, and beside a decided text whose decided request the gate refuses", async () => {
    const beside = await benRun([HELP, STOP], {});
    const besideOutcome = committed(await runTurnLoop(beside.t.turn));
    expect(callsOf(requestsOf(beside.face)[0])).toEqual([
      ["recordSafetyOutcome", HELP.eventId],
      ["recordSafetyOutcome", STOP.eventId],
      ["recordStopOrStart", "stop", STOP.eventId],
      ["sendFixedLine", "helpReply"],
    ]);
    expect(stopReplies(besideOutcome)).toEqual([
      ["help", "refused", null, null],
      ["stop", "replied", "stopReply", true],
    ]);
    restoreAll();

    const alone = await benRun([STOP], {});
    committed(await runTurnLoop(alone.t.turn));
    expect(requestsOf(alone.face)).toEqual([stopRecorded.request]);
    restoreAll();

    const refused = await samRun([DECIDED, SAM_STOP], {});
    refused.face.gate = (request, index) =>
      request.input.kind === "decided"
        ? { error: "transient", sqlstate: "40001" }
        : refused.gate(request, index);
    committed(await runTurnLoop(refused.t.turn));
    const coreOnly = requestsOf(refused.face).at(-1);
    expect(coreOnly?.caller.businessId).toBeNull();
    expect(callsOf(coreOnly)).toEqual([
      ["recordSafetyOutcome", DECIDED.eventId],
      ["recordSafetyOutcome", SAM_STOP.eventId],
      ["recordStopOrStart", "stop", SAM_STOP.eventId],
    ]);
    expect(refused.core.phones.get(SAM_PHONE)?.stopped).toBe(true);
  });

  it("unchanged: a decided commit with a business keeps the danger record first, beside a STOP and with no keyword text", async () => {
    for (const texts of [[DECIDED, SAM_STOP], [DECIDED]]) {
      const label = texts.map((text) => text.eventId).join(" ");
      const emergency = readAs(safetyEmergencyNow, DECIDED.eventId);
      const { t, face, core } = await samRun(texts, { [DECIDED.eventId]: emergency });

      const outcome = committed(await runTurnLoop(t.turn));

      expect(face.gateCalls, label).toHaveLength(1);
      const request = requestsOf(face)[0];
      expect(request?.input, label).toEqual(commitS102.request.input);
      expect(request?.caller.businessId, label).toBe(SAM.party.businessId);
      expect(callsOf(request), label).toEqual(
        texts.length === 2
          ? [
              ["recordSafetyOutcome", DECIDED.eventId],
              ["recordSafetyOutcome", SAM_STOP.eventId],
              ["recordStopOrStart", "stop", SAM_STOP.eventId],
            ]
          : [["recordSafetyOutcome", DECIDED.eventId]],
      );
      expect(request?.core[0], label).toEqual({
        call: "recordSafetyOutcome",
        request: {
          caller: request?.caller,
          safety: emergency,
          handleId: "handle-sam",
          bookingId: null,
          sentByActor: null,
        },
      });
      expect(outcome.answer.parts, label).toEqual(commitS102.outcome.parts);
      expect(core.phones.get(SAM_PHONE)?.stopped, label).toBe(texts.length === 2);
      restoreAll();
    }
  });
});

describe("a final answer before the commit parks the turn at once (K-09 v1.13 default 218; T-1529's ruling cards 6 and 7; T-1552)", () => {
  const TURN = commitS102.request.turn.id;
  const SAM_PHONE = "+15555550100";
  const PARKED_AT = parkTurnSamRefused.request.parkedAt;
  /** commit-s1-02-refused-step-not-in-bundle.json's answer, as K-05 v1.23 parks with it (default 216, field for field). */
  const REFUSED = {
    from: commitRefused.outcome.from,
    fault: commitRefused.outcome.fault,
    ids: [...commitRefused.outcome.ids],
  };

  const restoreAll = (): void => {
    restores.splice(0).forEach((restore) => {
      restore();
    });
  };

  /**
   * park-turn-sam-refused-at-once.json's request for this run's turn (its ids, texts, trace, pinned bundle and try), with
   * `reason` as its reason and its entry's why: the passedOn line's one row to Sam's own handle.
   */
  function samPark(tries: number, reason: typeof REFUSED, parkedAt = PARKED_AT): ParkTurnRequest {
    const fixture = parkTurnSamRefused.request;
    const request = JSON.parse(
      JSON.stringify(fixture).replaceAll(fixture.turn.id, TURN),
    ) as ParkTurnLineRequest;
    return {
      ...request,
      turn: {
        ...request.turn,
        eventIds: [S1_02_TEXT.eventId],
        traceId: commitS102.request.turn.traceId,
        bundleId: BUNDLE_A,
        tries,
      },
      parkedAt,
      reason,
      events: request.events.map((entry) => ({
        ...entry,
        newValues: { state: "parked", tries },
        why: { refused: reason },
      })),
    };
  }

  /** Sam's answer to S1-02 on this try: the frontier and decide answer their fixtures; the gate is each test's. */
  async function samRun(): Promise<Setup> {
    const setup = await setUp({
      who: SAM,
      turnId: TURN,
      traceId: commitS102.request.turn.traceId,
      texts: [S1_02_TEXT],
      times: [buildFrontierS102.request.now, commitS102.request.now, PARKED_AT],
      targets: SAM_S1_02_TARGETS,
    });
    setup.face.frontier = () => structuredClone(buildFrontierS102.outcome);
    setup.ai.decide = () => decided(decideS102);
    return setup;
  }

  /**
   * Sam's answer to S1-02 beside his keyword text `word`: the decided request answers turnRefused; a core-only request goes
   * to T-267's shared-core double over Sam's phone, as stop-recorded.json answers its records.
   */
  async function besideKeyword(
    word: "STOP" | "START" | "HELP",
  ): Promise<Setup & { core: ReturnType<typeof fakeReplyCore> }> {
    const setup = await setUp({
      who: SAM,
      turnId: TURN,
      traceId: commitS102.request.turn.traceId,
      texts: [S1_02_TEXT, { eventId: "evt-sam-0003", body: word, sentAt: "2026-10-19T14:05:02Z" }],
      times: [buildFrontierS102.request.now, commitS102.request.now],
      targets: SAM_S1_02_TARGETS,
    });
    setup.face.frontier = () => structuredClone(buildFrontierS102.outcome);
    setup.ai.decide = () => decided(decideS102);
    const core = fakeReplyCore(commitS102.request.now, [phone(SAM_PHONE, "handle-sam", "person-sam", 3)]);
    setup.face.gate = async (request) => {
      if (request.input.kind === "decided") return structuredClone(commitRefused.outcome);
      const records = request.core.filter((action) => action.call === "recordSafetyOutcome");
      const answer = await core.core.commitCore({
        caller: request.caller as never,
        actions: request.core.slice(records.length) as never,
      });
      if ("error" in answer) return answer;
      return {
        result: "committed",
        turnId: request.turn.id,
        committedAt: request.now,
        repeated: answer.repeated,
        parts: [],
        planner: null,
        core: [...records.map(() => structuredClone(stopRecorded.outcome.core[0])), ...answer.core],
        written: {
          written: [],
          outboxRows: [...core.outbox.values()].map((row) => ({ id: row.id, commitSeq: row.commitSeq })),
          promoted: [],
        },
        effects: [],
        openQuestions: { opened: [], closed: [] },
      } as never;
    };
    restores.push(setReplyDeps({ core: turnReplyCore, rows: core.rows, rosieNumber: ROSIE_NUMBER }));
    return { ...setup, core };
  }

  /** Each answer the lease's commit gave the run, by its error code ("committed" for a commit). */
  const answersOf = (t: TestTurn): string[] =>
    t.commits.map((sent) => ("error" in sent.answer ? sent.answer.error : "committed"));

  it("gateAndCommit's turnRefused (commit-s1-02-refused-step-not-in-bundle.json's answer) on try 1 is never sent again: the turn is parked at once with its labels as the reason and one passedOn row to the turn's own handle (park-turn-sam-refused-at-once.json), the dispatcher is woken once and the lease is told the turn is parked", async () => {
    const { t, face, ai, reply } = await samRun();
    face.gate = answersInTurn(commitRefused.outcome);

    const outcome = await runTurnLoop(t.turn);

    // One gateAndCommit, as the decided turn sends it: no resend, no re-read, no second call.
    expect(requestsOf(face)).toEqual([commitS102.request]);
    expect(ai.rereadCalls).toEqual([]);
    expect(face.log).toEqual(["frontier", "decide", "gate", "gate:answered"]);
    expect(outcome).toEqual({
      result: "notCommitted",
      why: "turnRefused",
      gateCalls: 1,
      replies: null,
      parkedAtOnce: { reason: REFUSED, answer: { result: "parked", parkedAt: PARKED_AT, repeated: false } },
    });
    // The park: park-turn-sam-refused-at-once.json's request for this turn, on try 1, with the refusal's labels.
    expect(reply.rows.parks).toEqual([samPark(1, REFUSED)]);
    const [row] = (reply.rows.parks[0] as ParkTurnLineRequest).outboxRows;
    expect(row.recipientHandleId).toBe(commitS102.request.turn.handleId);
    expect(row.finalParts.sends).toEqual([
      { kind: "words", text: PASSED_ON_LINE, calendarFile: "none", options: [], link: null },
    ]);
    expect(row.finalParts.fixedLines).toEqual(["passedOn"]);
    // The dispatcher woken once for the line's row; the lease told the turn is parked, with no call.
    expect(reply.dispatcher.wakes).toEqual([
      { turnId: TURN, handleId: "handle-sam", outboxRowIds: [parkedRowId(TURN)] },
    ]);
    expect(t.commits.map((sent) => sent.answer)).toEqual([
      commitRefused.outcome,
      { error: "turnParked", turnId: TURN, parkedAt: PARKED_AT },
    ]);
    expect(t.replied.count).toBe(0);
    // Labels, ids and counts only in the spans: never the text's words, the line's words or the number.
    expect(t.spans.map((span) => span.hop)).toEqual([
      "guard",
      "frontier",
      "decideReads",
      "gate",
      "commit",
      "lease",
    ]);
    for (const span of t.spans) expect(spanProblems(span)).toEqual([]);
    expect(t.spans.find((span) => span.hop === "commit")).toMatchObject({
      outcome: "refused",
      error_code: "turnRefused",
    });
    expect(t.spans.at(-1)?.decided).toEqual({
      parked: true,
      atOnce: true,
      from: "walk",
      fault: "stepNotInBundle",
      ids: ["S1-04"],
      repeated: false,
      woken: true,
      sends: 1,
    });
    const logged = JSON.stringify(t.spans);
    for (const words of [S1_02_TEXT.body, PASSED_ON_LINE, "passed this on", SAM_PHONE]) {
      expect(logged).not.toContain(words);
    }
  });

  it("on try 2 or 3 (a rerun after crashes) the turn is parked on the try the lease counted, with the same reason and line", async () => {
    for (const tries of [2, 3]) {
      const { t, face, reply } = await samRun();
      face.gate = answersInTurn(commitRefused.outcome);
      const turn: LeasedTurn = { ...t.turn, tries };

      const outcome = await runTurnLoop(turn);

      expect(
        requestsOf(face).map((request) => request.turn.tries),
        String(tries),
      ).toEqual([tries]);
      expect(outcome, String(tries)).toMatchObject({
        why: "turnRefused",
        parkedAtOnce: { reason: REFUSED, answer: { result: "parked", repeated: false } },
      });
      expect(reply.rows.parks, String(tries)).toEqual([samPark(tries, REFUSED)]);
      expect(answersOf(t), String(tries)).toEqual(["turnRefused", "turnParked"]);
      restoreAll();
    }
  });

  it("notBuilt from gateAndCommit (commit-s1-04-not-built.json's answer) parks at once with {toolApi, notBuilt, [gateAndCommit]}; notBuilt from buildFrontier parks with [buildFrontier], and nothing goes to decide or the gate", async () => {
    const atGate = await samRun();
    atGate.face.gate = answersInTurn(commitNotBuilt.outcome);
    const gated = await runTurnLoop(atGate.t.turn);
    const gateReason = { from: "toolApi", fault: "notBuilt", ids: ["gateAndCommit"] };
    expect(atGate.face.gateCalls).toHaveLength(1);
    expect(gated).toMatchObject({
      why: "notBuilt",
      gateCalls: 1,
      parkedAtOnce: { reason: gateReason, answer: { result: "parked" } },
    });
    expect(atGate.reply.rows.parks).toEqual([samPark(1, gateReason)]);
    expect(answersOf(atGate.t)).toEqual(["notBuilt", "turnParked"]);
    restoreAll();

    const atFrontier = await samRun();
    atFrontier.face.frontier = () => ({ error: "notBuilt", call: "buildFrontier" });
    const fronted = await runTurnLoop(atFrontier.t.turn);
    const frontierReason = { from: "toolApi", fault: "notBuilt", ids: ["buildFrontier"] };
    expect(atFrontier.ai.decideCalls).toEqual([]);
    expect(atFrontier.face.gateCalls).toEqual([]);
    expect(fronted).toMatchObject({
      why: "notBuilt",
      gateCalls: 0,
      parkedAtOnce: { reason: frontierReason, answer: { result: "parked" } },
    });
    // The park is the run's next K-09-dated call: its time is the clock's second value.
    expect(atFrontier.reply.rows.parks).toEqual([samPark(1, frontierReason, commitS102.request.now)]);
    expect(answersOf(atFrontier.t)).toEqual(["turnParked"]);
  });

  it("a transient answer is retried as today (one resend, then the lease's rerun), and a refusal that is not final, or a turnRefused whose labels are words, keeps today's path: nothing is parked", async () => {
    const cases: { answer: Record<string, unknown>; why: string; calls: number }[] = [
      { answer: { error: "transient", sqlstate: "40001" }, why: "transient", calls: 2 },
      {
        answer: { error: "versionChanged", table: "clock_rows", rowId: "clock-s1-02-sam" },
        why: "versionChanged",
        calls: 1,
      },
      {
        answer: { error: "turnRefused", from: "walk", fault: "step not in bundle", ids: ["S1-04"] },
        why: "turnRefused",
        calls: 1,
      },
    ];
    for (const { answer, why, calls } of cases) {
      const { t, face, reply } = await samRun();
      face.gate = answersInTurn(answer);

      const outcome = await runTurnLoop(t.turn);

      expect(outcome, why).toEqual({ result: "notCommitted", why, gateCalls: calls, replies: null });
      expect(requestsOf(face), why).toEqual(Array<unknown>(calls).fill(commitS102.request));
      expect(reply.rows.parks, why).toEqual([]);
      expect(reply.dispatcher.wakes, why).toEqual([]);
      expect(answersOf(t), why).toEqual(Array<string>(calls).fill(why));
      restoreAll();
    }
  });

  it("a turnRefused's ids reach the park each once, labels only (K-09 v1.13 default 216), and the same labels are the entry's why", async () => {
    const { t, face, reply } = await samRun();
    face.gate = answersInTurn({
      error: "turnRefused",
      from: "companies",
      fault: "secondCompany",
      ids: ["S1-04", "S1-04", SAM_PHONE, "two words", "S1-08"],
    });

    const outcome = await runTurnLoop(t.turn);

    const reason = { from: "companies", fault: "secondCompany", ids: ["S1-04", "S1-08"] };
    expect(outcome).toMatchObject({ parkedAtOnce: { reason, answer: { result: "parked" } } });
    expect(reply.rows.parks).toEqual([samPark(1, reason)]);
    expect(JSON.stringify(reply.rows.parks)).not.toContain(SAM_PHONE);
  });

  it("a STOP's core-only commit stands before any park: a decided text and a STOP whose decided request answers turnRefused commit the STOP core-only on that run, under the caller of every business, and nothing is parked (DL-508, DL-521)", async () => {
    const { t, face, reply, core } = await besideKeyword("STOP");

    const outcome = committed(await runTurnLoop(t.turn));

    expect(requestsOf(face).map((request) => request.input.kind)).toEqual(["decided", "coreOnly"]);
    expect(requestsOf(face)[1]?.caller.businessId).toBeNull();
    expect(core.phones.get(SAM_PHONE)?.stopped).toBe(true);
    expect(outcome.replies?.replies.map((one) => [one.outcome, one.line, one.stopped])).toEqual([
      ["replied", "stopReply", true],
    ]);
    expect(answersOf(t)).toEqual(["turnRefused", "committed"]);
    expect(reply.rows.parks).toEqual([]);
    expect(t.replied.count).toBe(1);
  });

  it("a STOP whose core-only commit does not commit either is never parked at once: it keeps today's path, the lease's rerun, and no passedOn line is written", async () => {
    const setup = await besideKeyword("STOP");
    const refusing = setup.face.gate;
    setup.face.gate = (request, index) =>
      request.input.kind === "decided" && refusing !== null
        ? refusing(request, index)
        : { error: "transient", sqlstate: "40001" };

    const outcome = await runTurnLoop(setup.t.turn);

    expect(outcome).toMatchObject({ result: "notCommitted", why: "notRecorded" });
    expect("parkedAtOnce" in outcome).toBe(false);
    const kinds = requestsOf(setup.face).map((request) => request.input.kind);
    expect(kinds[0]).toBe("decided");
    expect(kinds.slice(1).length).toBeGreaterThan(0);
    expect(kinds.slice(1).every((kind) => kind === "coreOnly")).toBe(true);
    expect(setup.reply.rows.parks).toEqual([]);
    expect(answersOf(setup.t)).not.toContain("turnParked");
  });

  it("HELP or START beside a decided text whose decided request answers turnRefused: one gateAndCommit, none on the replies' reruns, then the turn is parked at once", async () => {
    for (const word of ["HELP", "START"] as const) {
      const { t, face, reply } = await besideKeyword(word);

      const outcome = await runTurnLoop(t.turn);

      expect(requestsOf(face), word).toHaveLength(1);
      expect(requestsOf(face)[0]?.input, word).toEqual(commitS102.request.input);
      expect(outcome, word).toMatchObject({
        result: "notCommitted",
        gateCalls: 1,
        parkedAtOnce: { reason: REFUSED, answer: { result: "parked", repeated: false } },
      });
      expect(reply.rows.parks, word).toHaveLength(1);
      expect(reply.rows.parks[0], word).toMatchObject({ reason: REFUSED, turn: { id: TURN, tries: 1 } });
      expect(answersOf(t), word).toEqual(["turnRefused", "turnParked"]);
      restoreAll();
    }
  });

  it("a run no longer the turn's parks nothing (the run that has the turn now does), and a park K-05 cannot take now leaves the turn to the lease's rerun, the lease not told", async () => {
    const gone = await samRun();
    gone.face.gate = () => {
      gone.t.abort();
      return structuredClone(commitRefused.outcome);
    };
    const ended = await runTurnLoop(gone.t.turn);
    expect(ended).toEqual({ result: "notCommitted", why: "turnRefused", gateCalls: 1, replies: null });
    expect(gone.reply.rows.parks).toEqual([]);
    expect(answersOf(gone.t)).toEqual(["turnRefused"]);
    restoreAll();

    const busy = await samRun();
    busy.face.gate = answersInTurn(commitRefused.outcome);
    busy.reply.rows.park = () => ({ error: "transient", sqlstate: "40001" });
    const notDone = await runTurnLoop(busy.t.turn);
    expect(notDone).toMatchObject({ parkedAtOnce: { reason: REFUSED, answer: { error: "transient" } } });
    expect(busy.reply.rows.parks).toHaveLength(2);
    expect(busy.reply.dispatcher.wakes).toEqual([]);
    expect(answersOf(busy.t)).toEqual(["turnRefused"]);
  });
});
