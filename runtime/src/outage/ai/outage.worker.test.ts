// The AI provider down (T-271; C-174; arch 11 line 564; arch 06 line 293), run inside the Workers runtime: the real turn
// loop (`runTurnThroughOutage`: the guard, the frontier, decide, the gate and commit, then compose) through the real
// AI-down path, with every outside call a port answered from the frozen fixtures (../../turn/test-support.ts): a decide
// fake that answers the AI gateway's typed `modelsDown` (no live model call, J-02), K-09 v1's turn face, and K-09 v1's
// sendFixedLine for the outage line (./test-support.ts), on a fake clock for the 30 s retries. The run is handed a leased
// turn with the fixture's own ids, as the lease hands it (the lease itself runs in ./lease.worker.test.ts). Test values
// only: the master's sample cast and the fixtures' ids; phones in the fictional 555-01xx range (rule 9).
import { afterEach, describe, expect, it } from "vitest";

import buildFrontierS102 from "../../../../contracts/tool-api/fixtures/build-frontier-s1-02.json";
import commitS102 from "../../../../contracts/tool-api/fixtures/commit-s1-02.json";
import finalizePassedOn from "../../../../contracts/tool-api/fixtures/finalize-passed-on.json";
import finalizeRewrite from "../../../../contracts/tool-api/fixtures/finalize-rewrite.json";
import decideS102 from "../../../../contracts/model/fixtures/decide-s1-02-choose.json";
import safetyEmergencyNow from "../../../../contracts/model/fixtures/safety-emergency-now.json";
import type { LeasedTurn } from "../../actor";
import { BUNDLE_A, WHOLE_A } from "../../bundle/test-support";
import { decideLimit8 } from "../../dispatch/limit8";
import type { ClaimedRow, SendState } from "../../dispatch/types";
import { actorNameOf } from "../../gateway";
import { fakeKeyStore } from "../../gateway/test-support";
import { setGuardDeps, setReplyDeps } from "../../guard";
import { fakeCore as fakeReplyCore, phone, ROSIE_NUMBER } from "../../guard/replies/test-support";
import { fakeTargets } from "../../guard/test-support";
import { timeoutResult } from "../../safety";
import type { SafetyResult } from "../../safety/types";
import { spanProblems } from "../../trace";
import { runTurnThroughOutage, setTurnDeps, turnReplyCore, type TurnOutcome } from "../../turn";
import {
  ALEX,
  ONE_REREAD,
  SAM,
  SAM_S1_02_TARGETS,
  answersInTurn,
  checkedManifest,
  decided,
  fakeDecide,
  fakeFacts,
  fakeReply,
  fakeTurnFace,
  planned,
  retarget,
  safetyNoFor,
  storedText,
  targetsAnswer,
  testTurn,
  turnDeps,
  unplannedRow,
  until,
  type FakeDecide,
  type FakeReply,
  type FakeTurnFace,
  type TestTurn,
  type TextSpec,
} from "../../turn/test-support";
import type { ComposeInput, GateAndCommitRequest, TurnParty } from "../../turn/types";
import {
  MODELS_DOWN,
  OUTAGE_LINE_ID,
  RETRY_MS,
  outageLineRequest,
  setOutageDeps,
  type OutageReport,
  type WaitingTurn,
} from "./index";
import { outageHarness, type OutageHarness } from "./test-support";

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
  /** The leased turn the run is handed: the test turn, with the lease's lapse `leaseMs` on. */
  turn: LeasedTurn;
  face: FakeTurnFace;
  ai: FakeDecide;
  reply: FakeReply;
  o: OutageHarness;
  /** The fake clock's time at each decide call. */
  decidedAt: number[];
}

/**
 * One run's doubles: the turn (the fixture's turn and trace ids, its texts sealed as the inbox keeps them), the turn face
 * and decide (answers set by each test), the guard's targets, each text's safety result (No unless given), and the
 * AI-down path's doubles on their fake clock (from 0), with the lease lapsing `leaseMs` on (10 minutes unless given).
 */
async function setUp(spec: {
  who: Party;
  turnId: string;
  traceId: string;
  texts: Omit<TextSpec, "traceId">[];
  times: string[];
  targets?: Parameters<typeof targetsAnswer>[1];
  safety?: Record<string, SafetyResult>;
  leaseMs?: number;
}): Promise<Setup> {
  const entries = await Promise.all(
    spec.texts.map((text, index) =>
      storedText({ ...text, traceId: spec.traceId }, spec.who.handle, keys, BUNDLE_A, index + 1),
    ),
  );
  const t = testTurn({
    turnId: spec.turnId,
    traceId: spec.traceId,
    bundleId: BUNDLE_A,
    manifest: await checkedManifest(WHOLE_A, BUNDLE_A),
    entries,
  });
  const o = outageHarness();
  const turn: LeasedTurn = { ...t.turn, leaseUntil: o.clock.now() + (spec.leaseMs ?? 10 * 60_000) };
  const face = fakeTurnFace();
  const ai = fakeDecide(face.log);
  const reply = fakeReply(face.log);
  const facts = fakeFacts(spec.who.party, spec.times);
  for (const text of spec.texts) {
    facts.safety.set(text.eventId, spec.safety?.[text.eventId] ?? safetyNoFor(text.eventId));
  }
  restores.push(setTurnDeps(turnDeps(facts, face, ai, keys, reply)));
  const targets = fakeTargets();
  targets.answers.set(
    spec.who.party.handleId,
    targetsAnswer(spec.who.party.handleId, spec.targets ?? SAM_S1_02_TARGETS),
  );
  restores.push(setGuardDeps({ targets: targets.port }));
  restores.push(setOutageDeps(o.deps));
  return { t, turn, face, ai, reply, o, decidedAt: [] };
}

/** decide answers the AI gateway's `modelsDown` on its first `down` calls, then S1-02's result; each call's time noted. */
function downThenBack(s: Setup, down: number, back: unknown = decideS102): void {
  s.ai.decide = () => {
    s.decidedAt.push(s.o.clock.now());
    return s.decidedAt.length <= down ? { error: MODELS_DOWN } : decided(back);
  };
}

/**
 * Runs the turn through the AI-down path and moves the fake clock 30 s at each wait the path begins, `retries` times
 * (each move only once the wait has begun), then waits for the run's report.
 */
async function runWithRetries(s: Setup, retries: number): Promise<OutageReport<TurnOutcome>> {
  const running = runTurnThroughOutage(s.turn);
  for (let retry = 1; retry <= retries; retry += 1) {
    await until(() => s.o.waits.length === retry, `wait ${String(retry)}`);
    await s.o.clock.advance(RETRY_MS);
  }
  return running;
}

const S1_02_TURN = "turn-s1-02-sam-kinds";
const SAM_TRACE = "trace-sam-0001";

const S1_02_TEXT = {
  eventId: "evt-sam-0001",
  body: "Barbershop, plumbing, electrical",
  sentAt: "2026-10-19T14:05:00Z",
};
const LAWN_TEXT = { eventId: "evt-sam-0002", body: "and lawn care", sentAt: "2026-10-19T14:05:03Z" };
const STOP_TEXT = { eventId: "evt-sam-0004", body: "STOP", sentAt: "2026-10-19T14:05:04Z" };
const DANGER_TEXT = {
  eventId: "evt-sam-0005",
  body: "Test words: a client's cut won't stop bleeding",
  sentAt: "2026-10-19T14:05:05Z",
};

/** Sam's turn answering S1-02, with these texts: the frontier and the gate answer the S1-02 fixtures. */
async function samTurn(
  texts: Omit<TextSpec, "traceId">[],
  extra: Partial<Parameters<typeof setUp>[0]> = {},
): Promise<Setup> {
  const s = await setUp({
    who: SAM,
    turnId: S1_02_TURN,
    traceId: SAM_TRACE,
    texts,
    times: [buildFrontierS102.request.now, commitS102.request.now],
    ...extra,
  });
  s.face.frontier = () => structuredClone(buildFrontierS102.outcome);
  s.face.gate = answersInTurn(commitS102.outcome);
  return s;
}

/** The waiting turn as the turn loop gives it for Sam's handle. */
function samWaiting(texts: { eventId: string }[]): WaitingTurn {
  return {
    actorName: actorNameOf(SAM.handle),
    handleId: "handle-sam",
    businessId: "biz-lees-barbershop",
    personId: "person-sam",
    texts: texts.map((text) => ({ eventId: text.eventId, traceId: SAM_TRACE, lined: false })),
    stopAsked: false,
  };
}

/** K-09 v1 sendFixedLine's request for the outage line to one of Sam's texts, written out. */
const samLine = (eventId: string): unknown => ({
  caller: {
    kind: "job",
    turnId: null,
    requestId: `safety:${eventId}`,
    businessId: "biz-lees-barbershop",
    personId: "person-sam",
    traceId: SAM_TRACE,
  },
  fixedLineId: "outage",
  recipientHandleId: "handle-sam",
  sendClass: "quick_reply",
  sentByActor: null,
});

describe("a decide fake returning provider-down: the outage line once per waiting text", () => {
  it("each waiting text gets the outage line once, through K-09 sendFixedLine, however many times the turn runs again", async () => {
    const s = await samTurn([S1_02_TEXT, LAWN_TEXT]);
    downThenBack(s, 2);

    const report = await runWithRetries(s, 2);

    // Two texts, three runs of the turn: two lines, both at the first run that found the models down.
    expect(s.o.lines.requests.map((sent) => sent.request)).toEqual([
      samLine("evt-sam-0001"),
      samLine("evt-sam-0002"),
    ]);
    expect(s.o.lines.requests.map((sent) => sent.at)).toEqual([0, 0]);
    expect(OUTAGE_LINE_ID).toBe("outage");
    expect(report.lines).toEqual([
      { eventId: "evt-sam-0001", outboxRowId: "out-safety-evt-sam-0001-outage", repeated: false },
      { eventId: "evt-sam-0002", outboxRowId: "out-safety-evt-sam-0002-outage", repeated: false },
    ]);
    // The dispatcher is woken once for the two rows, so they go at once.
    expect(s.o.wakes).toEqual([
      {
        handleId: "handle-sam",
        outboxRowIds: ["out-safety-evt-sam-0001-outage", "out-safety-evt-sam-0002-outage"],
      },
    ]);
    // The stopped flag was read once, by the handle's actor name, before the lines went.
    expect(s.o.stoppedReads).toEqual([actorNameOf(SAM.handle)]);
    expect(report).toMatchObject({ end: "committed", tries: 3 });
    expect(s.face.gateCalls).toHaveLength(1);
  });

  it("the outage line's request is K-09's, built from the waiting turn: kind job, the text's own trace, class quick_reply", () => {
    const waiting = samWaiting([S1_02_TEXT]);
    const text = waiting.texts[0];
    if (text === undefined) throw new Error("no text");
    expect(outageLineRequest(waiting, text)).toEqual(samLine("evt-sam-0001"));
  });

  it("a text the safety read's timeout rule gave the outage line already (K-02 timeout marker, no danger word) gets no second one", async () => {
    const s = await samTurn([S1_02_TEXT, LAWN_TEXT], {
      safety: { "evt-sam-0002": timeoutResult("evt-sam-0002", []) },
    });
    downThenBack(s, 1);

    await runWithRetries(s, 1);

    expect(s.o.lines.requests.map((sent) => sent.request)).toEqual([samLine("evt-sam-0001")]);
  });

  it("a rerun of the turn asks again under the same request id, and K-09 answers repeated: still one line per text", async () => {
    const first = await samTurn([S1_02_TEXT, LAWN_TEXT], { leaseMs: 60_000 });
    downThenBack(first, 99);
    const lapsed = await runWithRetries(first, 1);
    expect(lapsed).toMatchObject({ end: "leaseEnds", tries: 2 });

    // The lease's lapse reruns the turn: a new run of the same turn id, the same core.
    const rerun: LeasedTurn = { ...first.t.turn, tries: 2, leaseUntil: first.o.clock.now() + 60_000 };
    const again = runTurnThroughOutage(rerun);
    await until(() => first.o.lines.requests.length === 4, "the rerun's lines");
    first.t.abort();
    const report = await again;
    await first.o.clock.advance(RETRY_MS);

    expect(first.o.lines.requests.map((sent) => sent.request)).toEqual([
      samLine("evt-sam-0001"),
      samLine("evt-sam-0002"),
      samLine("evt-sam-0001"),
      samLine("evt-sam-0002"),
    ]);
    expect([...first.o.lines.rows.values()]).toEqual([
      "out-safety-evt-sam-0001-outage",
      "out-safety-evt-sam-0002-outage",
    ]);
    expect(report.lines.map((line) => line.repeated)).toEqual([true, true]);
    // Nothing new was written, so the dispatcher was not woken again.
    expect(first.o.wakes).toHaveLength(1);
  });

  it("a line the core does not answer for now is asked for again at the next run, and then goes once", async () => {
    const s = await samTurn([S1_02_TEXT]);
    s.o.lines.transient = 1;
    downThenBack(s, 2);

    const report = await runWithRetries(s, 2);

    expect(s.o.lines.requests.map((sent) => sent.at)).toEqual([0, RETRY_MS]);
    expect(report.lines).toEqual([
      { eventId: "evt-sam-0001", outboxRowId: "out-safety-evt-sam-0001-outage", repeated: false },
    ]);
  });

  it("never logs or puts in a span a text's words: the turn's spans hold labels and counts only, and every one passes K-08", async () => {
    const s = await samTurn([S1_02_TEXT, LAWN_TEXT]);
    downThenBack(s, 1);

    await runWithRetries(s, 1);

    // Both runs' guard and frontier; the decide reads' span of the run that answered (a modelsDown answer reports no
    // model call, and K-08 keeps no decideReads span without one); then that run's gate and commit.
    expect(s.t.spans.map((span) => span.hop)).toEqual([
      "guard",
      "frontier",
      "guard",
      "frontier",
      "decideReads",
      "gate",
      "commit",
    ]);
    for (const span of s.t.spans) expect(spanProblems(span)).toEqual([]);
    const written = JSON.stringify([s.t.spans, s.o.lines.requests, s.o.wakes]);
    for (const words of [S1_02_TEXT.body, LAWN_TEXT.body, "+15555550100"]) {
      expect(written).not.toContain(words);
    }
  });
});

describe("never to a stopped phone", () => {
  it("the handle's stopped flag says stopped: no line goes to any waiting text, and the turn still runs again every 30 s", async () => {
    const s = await samTurn([S1_02_TEXT, LAWN_TEXT]);
    s.o.stopped.value = true;
    downThenBack(s, 2);

    const report = await runWithRetries(s, 2);

    expect(s.o.lines.requests).toEqual([]);
    expect(report.lines).toEqual([]);
    expect(s.decidedAt).toEqual([0, RETRY_MS, 2 * RETRY_MS]);
    expect(report.end).toBe("committed");
  });

  it("a STOP among the turn's own texts: the phone asked to stop, so no line goes, and the stopped flag is not even read", async () => {
    const s = await samTurn([S1_02_TEXT, STOP_TEXT]);
    downThenBack(s, 99);

    const running = runTurnThroughOutage(s.turn);
    await until(() => s.o.waits.length === 1, "the first wait");
    await s.o.clock.advance(RETRY_MS);
    await until(() => s.o.waits.length === 2, "the second wait");
    s.t.abort();
    const report = await running;
    await s.o.clock.advance(RETRY_MS);

    expect(s.o.lines.requests).toEqual([]);
    expect(s.o.stoppedReads).toEqual([]);
    // The STOP never reached decide: only Sam's answer to S1-02 did, on each run.
    expect(s.face.frontierCalls.map((request) => request.texts.map((text) => text.eventId))).toEqual([
      ["evt-sam-0001"],
      ["evt-sam-0001"],
    ]);
    expect(report).toMatchObject({ end: "replaced", tries: 2 });
  });

  it("the core answers phoneStopped (K-09 sendFixedLine.errors): nothing more is asked for that handle, on this run or the next", async () => {
    const s = await samTurn([S1_02_TEXT, LAWN_TEXT]);
    s.o.lines.stopped.add("handle-sam");
    downThenBack(s, 2);

    const report = await runWithRetries(s, 2);

    expect(s.o.lines.requests.map((sent) => sent.request)).toEqual([samLine("evt-sam-0001")]);
    expect(s.o.lines.rows.size).toBe(0);
    expect(report.lines).toEqual([]);
    expect(s.o.wakes).toEqual([]);
  });

  it("T-259's stopped check: limit 8 drops the outage line's row (quick_reply, the outage line) for a stopped phone at send", () => {
    const at = { now: "2026-10-19T14:05:30Z", honourOverride: false, partOut: false };
    const row = outageRow();
    expect(decideLimit8({ row, state: sendState(true), ...at })).toMatchObject({
      action: "mark",
      outcome: "droppedStopped",
    });
    // The same row to a phone that is not stopped, its chat open, goes at any hour: a reply to the person's own text.
    expect(decideLimit8({ row, state: sendState(false), ...at })).toMatchObject({ action: "send" });
  });
});

describe("the turn runs again every 30 s until the models are back, then commits once", () => {
  it("retries at 30 s intervals on the fake clock while decide answers modelsDown, then the turn commits once", async () => {
    const s = await samTurn([S1_02_TEXT]);
    downThenBack(s, 3);

    const report = await runWithRetries(s, 3);

    expect(s.decidedAt).toEqual([0, RETRY_MS, 2 * RETRY_MS, 3 * RETRY_MS]);
    expect(report.triedAt).toEqual([0, RETRY_MS, 2 * RETRY_MS, 3 * RETRY_MS]);
    expect(s.o.waits).toEqual([
      { at: 0, ms: RETRY_MS },
      { at: RETRY_MS, ms: RETRY_MS },
      { at: 2 * RETRY_MS, ms: RETRY_MS },
    ]);
    // One commit: the S1-02 request, through the lease's commit, answered committed.
    expect(s.face.gateCalls.map((call) => call.request)).toEqual([commitS102.request]);
    expect(s.t.commits).toHaveLength(1);
    expect(report.outcome.result).toBe("committed");
    expect(report).toMatchObject({ end: "committed", tries: 4 });
    expect(s.t.replied.count).toBe(1);
  });

  it("a re-read the models cannot make (reads that disagree, then modelsDown) waits and retries the same way", async () => {
    const s = await samTurn([S1_02_TEXT]);
    s.ai.decide = () => {
      s.decidedAt.push(s.o.clock.now());
      return decided({ ...decideS102, agreed: false });
    };
    let rereads = 0;
    s.ai.reread = () => {
      rereads += 1;
      return rereads === 1 ? { error: MODELS_DOWN } : decided({ ...decideS102, reread: true }, ONE_REREAD);
    };

    const report = await runWithRetries(s, 1);

    expect(s.o.lines.requests.map((sent) => sent.request)).toEqual([samLine("evt-sam-0001")]);
    expect(s.ai.rereadCalls).toHaveLength(2);
    expect(s.face.gateCalls).toHaveLength(1);
    expect(report).toMatchObject({ end: "committed", tries: 2 });
  });

  it("the retry the lease would not outlast is the lease's own rerun: the run ends at its last try, with no wait past the lapse", async () => {
    const s = await samTurn([S1_02_TEXT], { leaseMs: 60_000 });
    downThenBack(s, 99);

    const report = await runWithRetries(s, 1);

    expect(s.decidedAt).toEqual([0, RETRY_MS]);
    expect(s.o.waits).toEqual([{ at: 0, ms: RETRY_MS }]);
    expect(report).toMatchObject({ end: "leaseEnds", tries: 2 });
    expect(report.outcome).toMatchObject({ result: "notCommitted", why: "modelsDown" });
    expect(s.face.gateCalls).toEqual([]);
  });

  it("a run no longer the turn's (a restart or a lapse took it) stops at once, mid-wait, and runs nothing more", async () => {
    const s = await samTurn([S1_02_TEXT]);
    downThenBack(s, 99);

    const running = runTurnThroughOutage(s.turn);
    await until(() => s.o.waits.length === 1, "the first wait");
    s.t.abort();
    const report = await running;
    // The time it would have run again passes, and nothing runs.
    await s.o.clock.advance(RETRY_MS);

    expect(report).toMatchObject({ end: "replaced", tries: 1 });
    expect(s.decidedAt).toEqual([0]);
  });

  it("a slow try (the gateway's own timeouts) does not push the next one back: it still begins 30 s after the last one began", async () => {
    const s = await samTurn([S1_02_TEXT]);
    s.ai.decide = async () => {
      s.decidedAt.push(s.o.clock.now());
      // Each try takes 10 s on the clock before it answers, as the gateway's attempts timing out would.
      await s.o.clock.after(10_000);
      return s.decidedAt.length <= 1 ? { error: MODELS_DOWN } : decided(decideS102);
    };

    const running = runTurnThroughOutage(s.turn);
    await until(() => s.decidedAt.length === 1, "the first try");
    await s.o.clock.advance(10_000);
    await until(() => s.o.waits.length === 1, "the first wait");
    expect(s.o.waits).toEqual([{ at: 10_000, ms: RETRY_MS - 10_000 }]);
    await s.o.clock.advance(RETRY_MS - 10_000);
    await until(() => s.decidedAt.length === 2, "the second try");
    await s.o.clock.advance(10_000);
    const report = await running;

    expect(s.decidedAt).toEqual([0, RETRY_MS]);
    expect(report).toMatchObject({ end: "committed", tries: 2, triedAt: [0, RETRY_MS] });
  });

  it("a run that fails for another reason (the frontier transient) is not the AI-down path: no line, no retry, the lease reruns it", async () => {
    const s = await samTurn([S1_02_TEXT]);
    s.face.frontier = () => ({ error: "transient", sqlstate: "40001" });

    const report = await runTurnThroughOutage(s.turn);

    expect(report).toMatchObject({ end: "notDown", tries: 1 });
    expect(s.o.lines.requests).toEqual([]);
    expect(s.o.waits).toEqual([]);
  });

  it("unwired (no setOutageDeps): one run, nothing sent, as before the AI-down path", async () => {
    const s = await samTurn([S1_02_TEXT]);
    restores.push(setOutageDeps(null));
    downThenBack(s, 99);

    const report = await runTurnThroughOutage(s.turn);

    expect(report).toMatchObject({ end: "unwired", tries: 1, lines: [] });
    expect(report.outcome).toMatchObject({ result: "notCommitted", why: "modelsDown" });
    expect(s.o.lines.requests).toEqual([]);
    expect(s.decidedAt).toEqual([0]);
  });
});

describe("on return: danger first, then stops, then the rest", () => {
  it("a queued danger text is handled before a queued STOP in the one commit, which a STOP never holds for the models' return: core-only, on the first run (DL-508)", async () => {
    // Arrival order is the reverse of the return order: the routine answer, then the STOP, then the danger text.
    const danger = { ...(safetyEmergencyNow as unknown as SafetyResult), eventId: DANGER_TEXT.eventId };
    const s = await samTurn([S1_02_TEXT, STOP_TEXT, DANGER_TEXT], {
      safety: { [DANGER_TEXT.eventId]: danger },
    });
    const core = fakeReplyCore(commitS102.request.now, [
      phone("+15555550100", "handle-sam", "person-sam", 3),
    ]);
    s.face.gate = async (request: GateAndCommitRequest) => {
      const records = request.core.filter((action) => action.call === "recordSafetyOutcome");
      const actions = request.core.slice(records.length);
      const answer = await core.core.commitCore({
        caller: (actions[0]?.request as { caller: never }).caller,
        actions: actions as never,
      });
      if ("error" in answer) return answer;
      return {
        ...structuredClone(commitS102.outcome),
        core: [...records.map(() => commitS102.outcome.core[0]), ...answer.core],
      } as never;
    };
    restores.push(setReplyDeps({ core: turnReplyCore, rows: core.rows, rosieNumber: ROSIE_NUMBER }));
    downThenBack(s, 2);

    const report = await runTurnThroughOutage(s.turn);

    // The models are down at the first try, and the STOP does not wait for their return (DL-508; arch 06 line 329: a
    // change that only protects commits at once): the turn commits on its first run, with no wait and no retry.
    expect(report).toMatchObject({ end: "committed", tries: 1 });
    expect(s.decidedAt).toEqual([0]);
    expect(s.o.waits).toEqual([]);
    expect(s.face.gateCalls).toHaveLength(1);
    const request = s.face.gateCalls[0]?.request;
    // The danger text's safety record first, then the others' in arrival order, then the STOP's record; core-only, since
    // the decided parts (the routine and danger texts' choices) could not be made on this run.
    expect(
      request?.core.map((action) => {
        const asked = action.request as { safety?: { eventId: string }; phoneNumber?: string };
        return [action.call, asked.safety?.eventId ?? "stop"];
      }),
    ).toEqual([
      ["recordSafetyOutcome", DANGER_TEXT.eventId],
      ["recordSafetyOutcome", S1_02_TEXT.eventId],
      ["recordSafetyOutcome", STOP_TEXT.eventId],
      ["recordStopOrStart", "stop"],
    ]);
    expect(request?.input.kind).toBe("coreOnly");
    // The STOP went to the stop path, never to decide: only the routine and danger texts did, in arrival order.
    expect(s.face.frontierCalls.at(-1)?.texts.map((text) => text.eventId)).toEqual([
      S1_02_TEXT.eventId,
      DANGER_TEXT.eventId,
    ]);
    // The stop is applied in that one commit, and its reply's words written by code.
    expect(core.phones.get("+15555550100")?.stopped).toBe(true);
    if (report.outcome.result !== "committed") throw new Error("not committed");
    expect(report.outcome.replies?.replies.map((reply) => [reply.keyword.kind, reply.outcome])).toEqual([
      ["stop", "replied"],
    ]);
    // No outage line: the turn committed on its first run, and the phone's own text asked to stop.
    expect(s.o.lines.requests).toEqual([]);
  });

  it("the return order keeps arrival order within each rank: two routine texts and a danger text give the danger record first", async () => {
    const danger = { ...(safetyEmergencyNow as unknown as SafetyResult), eventId: DANGER_TEXT.eventId };
    const s = await samTurn([S1_02_TEXT, LAWN_TEXT, DANGER_TEXT], {
      safety: { [DANGER_TEXT.eventId]: danger },
    });
    downThenBack(s, 1);

    await runWithRetries(s, 1);

    const records = s.face.gateCalls[0]?.request.core.map(
      (action) => (action.request as { safety: { eventId: string } }).safety.eventId,
    );
    expect(records).toEqual([DANGER_TEXT.eventId, S1_02_TEXT.eventId, LAWN_TEXT.eventId]);
    // Each waiting text, the danger text's included, got the outage line once while it waited.
    expect(s.o.lines.requests.map((sent) => sent.request.caller.requestId)).toEqual([
      `safety:${S1_02_TEXT.eventId}`,
      `safety:${LAWN_TEXT.eventId}`,
      `safety:${DANGER_TEXT.eventId}`,
    ]);
  });
});

// ---- after the commit -------------------------------------------------------------------------------------------------

const A7_17_TURN = finalizeRewrite.request.caller.turnId;
const A7_17_TRACE = finalizeRewrite.request.caller.traceId;
const A7_17_ROW = finalizeRewrite.request.outboxRowId;
/** A7-17's composer input for Alex's row, as far as the turn reads it (the rest rides through to the composer). */
const A7_17_INPUT: ComposeInput = {
  row: A7_17_ROW,
  turn: A7_17_TURN,
  channel: "imessage",
  situation: "problem",
};

/** A turn of Alex's that commits one row, A7-17's (finalize-rewrite.json), then composes it. */
async function alexCommitsA7_17(): Promise<Setup> {
  const s = await setUp({
    who: ALEX,
    turnId: A7_17_TURN,
    traceId: A7_17_TRACE,
    texts: [{ eventId: "evt-alex-0300", body: "Test words: ok, thanks", sentAt: "2026-10-23T13:00:00Z" }],
    times: ["2026-10-23T13:00:01Z", "2026-10-23T13:00:02Z"],
    targets: {
      roles: [{ businessId: "biz-lees-barbershop", personId: "person-alex", role: "customer" }],
      openQuestionIds: [],
      bookingIds: [],
    },
  });
  const ids = {
    turnId: [S1_02_TURN, A7_17_TURN] as [string, string],
    traceId: [SAM_TRACE, A7_17_TRACE] as [string, string],
  };
  s.face.frontier = () => retarget(structuredClone(buildFrontierS102.outcome), ids);
  s.ai.decide = () => decided(retarget(decideS102, ids));
  s.face.gate = (request) =>
    ({
      result: "committed",
      turnId: request.turn.id,
      committedAt: "2026-10-23T13:00:02Z",
      repeated: false,
      parts: [],
      planner: null,
      core: request.core.map(() => commitS102.outcome.core[0]),
      written: { written: [], outboxRows: [{ id: A7_17_ROW, commitSeq: 1 }], promoted: [] },
      effects: [],
      openQuestions: { opened: [], closed: [] },
    }) as never;
  s.reply.rows.unplanned = () => ({ result: "rows", rows: [unplannedRow(A7_17_ROW, 1, "handle-alex")] });
  s.face.composeInput = () => ({ result: "compose", input: A7_17_INPUT });
  s.reply.composer.compose = () => planned(finalizeRewrite.request.plan.plan);
  s.face.finalize = (request) =>
    structuredClone(
      request.attempt === "composed" ? finalizeRewrite.outcome : finalizePassedOn.outcome,
    ) as never;
  return s;
}

describe("a model call that fails after the commit takes step 7's path for its row, never the outage line", () => {
  it("the one rewrite cannot be made (modelsDown): the composed plan goes as the rewrite attempt and finalize runs the step's fallback (finalize-passed-on.json)", async () => {
    const s = await alexCommitsA7_17();
    s.reply.composer.rewrite = () => ({ error: MODELS_DOWN });

    const report = await runTurnThroughOutage(s.turn);

    expect(report).toMatchObject({ end: "committed", tries: 1, lines: [] });
    // finalize-rewrite.json, then finalize-passed-on.json word for word: its rewrite attempt is the composed plan,
    // unchanged, so its miss stands, the fallback runs inside the call, and its passed-on line is what the row holds.
    expect(s.face.finalizeCalls).toEqual([finalizeRewrite.request, finalizePassedOn.request]);
    expect(s.reply.composer.rewriteCalls).toHaveLength(1);
    if (report.outcome.result !== "committed") throw new Error("not committed");
    expect(report.outcome.composed?.rows).toEqual([
      expect.objectContaining({
        outboxRowId: A7_17_ROW,
        result: "passedOn",
        composerCalls: 2,
        rewrite: true,
        finalizeCalls: 2,
        finalParts: finalizePassedOn.outcome.finalParts,
        questionWithdrawn: true,
        errorCode: null,
      }),
    ]);
    expect(finalizePassedOn.outcome.checks.map((check) => check.attempt)).toEqual(["rewrite", "fallback"]);
    const fallback = s.t.spans.find((span) => span.hop === "rewriteOrFallback");
    expect(fallback?.got).toMatchObject({ attempt: "rewrite", planned: false });
    expect(fallback?.decided).toMatchObject({ outcome: "passedOn", fallback: true });
    // The turn committed: the outage line is never sent for it, and nothing runs again.
    expect(s.o.lines.requests).toEqual([]);
    expect(s.o.waits).toEqual([]);
    expect(s.face.gateCalls).toHaveLength(1);
  });

  it("the composer down on its first call after the commit: the row keeps no plan for the crash path's rerun (T-253), and no outage line goes", async () => {
    const s = await alexCommitsA7_17();
    s.reply.composer.compose = () => ({ error: MODELS_DOWN });

    const report = await runTurnThroughOutage(s.turn);

    expect(report).toMatchObject({ end: "committed", tries: 1, lines: [] });
    if (report.outcome.result !== "committed") throw new Error("not committed");
    expect(report.outcome.composed?.rows.map((row) => [row.result, row.errorCode])).toEqual([
      ["left", MODELS_DOWN],
    ]);
    expect(s.face.finalizeCalls).toEqual([]);
    expect(s.o.lines.requests).toEqual([]);
    expect(s.o.waits).toEqual([]);
  });
});

// ---- limit 8's own decision on the outage line's row ----------------------------------------------------------------

/** The row the core writes for the outage line, as the dispatcher claims it: send class quick_reply, the outage line. */
function outageRow(): ClaimedRow {
  return {
    outboxRowId: "out-safety-evt-sam-0001-outage",
    version: 1,
    commitSeq: 1,
    recipientHandleId: "handle-sam",
    recipientPersonId: "person-sam",
    businessId: "biz-lees-barbershop",
    bookingId: null,
    openQuestionId: null,
    channel: "imessage",
    sendClass: "quick_reply",
    versionsRead: [],
    finalParts: {
      row: "out-safety-evt-sam-0001-outage",
      channel: "imessage",
      sends: [],
      fixedLines: [OUTAGE_LINE_ID],
      threadReplyTo: null,
    },
    parts: [],
    traceId: SAM_TRACE,
    claim: {
      claimer: "dispatcher",
      claimedAt: "2026-10-19T14:05:30Z",
      lapsesAt: "2026-10-19T14:06:30Z",
      claimNo: 1,
      firstTryAt: null,
      nextTryNotBefore: null,
    },
    claimedFrom: "checked",
  };
}

/** Sam's send state: stopped (its chat closed, as STOP closes it) or not (its chat open). */
function sendState(stopped: boolean): SendState {
  return {
    stopped,
    chatOpen: !stopped,
    audience: "owner",
    visitZone: null,
    businessZone: "America/New_York",
    textHours: { start: "08:00", end: "20:00" },
    textHoursOverride: false,
    currentVersions: [],
    closed: { booking: false, question: false },
  };
}
