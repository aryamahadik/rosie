// The AI provider down inside the real actor (T-271), run inside the Workers runtime: each text goes through the gateway's
// door, the real safety read on arrival, the real batch window, the real turn lease (T-248: a 60 s lease, a lapse reruns
// the turn) and the real bundle pin, whose `runTurn` is the turn loop's own (`turnHooks`), through the AI-down path.
// Doubles: the turn's ports (../../turn/test-support.ts) answering the K-09 and K-02 fixtures with the running turn's own
// ids, a decide fake that answers the AI gateway's typed `modelsDown` (no live model call, J-02), the safety read's
// doubles (../../safety/test-support.ts) on whose fake clock the actor, the lease and the 30 s retries all run, and K-09's
// sendFixedLine for the outage line (./test-support.ts). Test method: T-1128's. Test values only (rule 9).
//
// T-1323: before any outage line of a run goes, the AI-down path asks the actor that runs the turn the one reading the
// safety read's own outage line asks (the actor's copy of the stopped flag, or T-1313's `stopPending`), which is true while
// the PostgreSQL-down path is unwired. So a test whose claim is the line runs as DL-615 sets: with the down path unwired,
// as the root installs it today (no line by any path, every other effect kept), and with it wired, as D-017 is to wire
// it, over ../db/test-support.ts's doubles (PostgreSQL answering, as in the original test), the handle's keyword copy
// installed by the actor's own code, each text read by the real classify before the line's moment, and every original
// assertion word for word.
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import buildFrontierS102 from "../../../../contracts/tool-api/fixtures/build-frontier-s1-02.json";
import commitS102 from "../../../../contracts/tool-api/fixtures/commit-s1-02.json";
import decideS102 from "../../../../contracts/model/fixtures/decide-s1-02-choose.json";
import safetyEmergencyNow from "../../../../contracts/model/fixtures/safety-emergency-now.json";
import {
  setBatchHooks,
  setBundleDeps,
  setLeaseHooks,
  setSafetyDeps,
  turnIdOf,
  type BatchEntry,
  type HandleActor,
  type TurnEntry,
} from "../../actor";
import type { ActorCopies } from "../../actor/copies/copies";
import { BUNDLE_A, fakeBundles, WHOLE_A } from "../../bundle/test-support";
import { actorNameOf, durableObjectActor, type ActorNamespace, type HandleActorRpc } from "../../gateway";
import { fakeKeyStore } from "../../gateway/test-support";
import { setGuardDeps } from "../../guard";
import { fakeTargets } from "../../guard/test-support";
import { fakeRead, harness, TEST_IDS, type Harness } from "../../safety/test-support";
import type { SafetyDeps, SafetyResult } from "../../safety/types";
import { setDbOutageDeps, type OutageView } from "../db";
import { dbFakes, type DbFakes } from "../db/test-support";
import { setTurnDeps, turnHooks } from "../../turn";
import {
  ALEX,
  SAM,
  SAM_S1_02_TARGETS,
  decided,
  fakeDecide,
  fakeFacts,
  fakeTurnFace,
  retarget,
  safetyNoFor,
  storedText,
  targetsAnswer,
  turnDeps,
  until,
  type FakeDecide,
  type FakeTurnFace,
} from "../../turn/test-support";
import type { TurnParty } from "../../turn/types";
import { MODELS_DOWN, RETRY_MS, outageLineRequest, setOutageDeps, type WaitingTurn } from "./index";
import { outageHarness, type OutageHarness } from "./test-support";

const TRACE = "11111111-2222-4333-8444-555555555555";
const keys = fakeKeyStore();
const restores: (() => void)[] = [];

type Namespace = DurableObjectNamespace<HandleActor>;

function namespace(): Namespace {
  return (exports as unknown as { HandleActor: Namespace }).HandleActor;
}

function door(): ReturnType<typeof durableObjectActor> {
  const ns = namespace();
  const adapter: ActorNamespace<DurableObjectId> = {
    idFromName: (name) => ns.idFromName(name),
    get: (id): HandleActorRpc => ns.get(id),
  };
  return durableObjectActor(adapter);
}

interface Party {
  handle: (typeof SAM)["handle"];
  party: TurnParty;
}

/** The actor's reads over RPC, typed here. */
interface ActorRpc {
  readTurns(): Promise<TurnEntry[]>;
  readBatches(): Promise<BatchEntry[]>;
  readWaitingBatches(): Promise<number[]>;
  safetyIdle(): Promise<void>;
  batchIdle(): Promise<void>;
  readOutage(): Promise<OutageView>;
  outageIdle(): Promise<void>;
}

function stubOf(who: Party): DurableObjectStub<HandleActor> {
  return namespace().get(namespace().idFromName(actorNameOf(who.handle)));
}

const actorOf = (who: Party): ActorRpc => stubOf(who);

/** A text arrives through the gateway's door: K-06's text, sealed under the handle's key, as the gateway hands it. */
async function arrive(who: Party, eventId: string, body: string, sentAt: string): Promise<void> {
  const entry = await storedText({ eventId, body, sentAt, traceId: TRACE }, who.handle, keys, BUNDLE_A, 0);
  const handoff = {
    event: entry.event,
    partKey: null,
    traceId: TRACE,
    bundleId: { hash: "a".repeat(64), build: 1 },
    actorName: actorNameOf(who.handle),
  };
  expect(await door().accept(handoff)).toBe("written");
}

afterEach(async () => {
  while (restores.length > 0) restores.pop()?.();
  await reset();
});

interface Rig {
  h: Harness;
  o: OutageHarness;
  face: FakeTurnFace;
  ai: FakeDecide;
  /** The fake clock's time at each decide call. */
  decidedAt: number[];
  /** The fake clock moves, then the alarm runs, as the platform would at the stored time. */
  tick(ms: number): Promise<void>;
  actor: ActorRpc;
}

const S1_02 = "turn-s1-02-sam-kinds";

/** A fixture with the running turn's own turn id in place of the fixture's. */
const forTurn = <T>(value: T, to: string): T =>
  retarget(value, { turnId: [S1_02, to], traceId: ["trace-sam-0001", TRACE] });

/**
 * Sam's handle in the real actor: every text read as No, the S1-02 fixtures answering for whichever turn asks, decide
 * down on its first `down` calls, and the AI-down path on the safety read's fake clock (the actor's clock too).
 */
function rigFor(who: Party, eventIds: string[], down: number): Rig {
  const answers = Object.fromEntries(eventIds.map((eventId) => [eventId, safetyNoFor(eventId)]));
  const h = harness(keys, answers);
  const o = outageHarness(h.clock);
  const face = fakeTurnFace();
  const ai = fakeDecide(face.log);
  const facts = fakeFacts(who.party, [buildFrontierS102.request.now, commitS102.request.now]);
  for (const [eventId, result] of Object.entries(answers)) facts.safety.set(eventId, result);
  const targets = fakeTargets();
  targets.answers.set(who.party.handleId, targetsAnswer(who.party.handleId, SAM_S1_02_TARGETS));
  const decidedAt: number[] = [];
  face.frontier = (request) => forTurn(buildFrontierS102.outcome, request.turn.id);
  ai.decide = (context) => {
    decidedAt.push(h.clock.now());
    return decidedAt.length <= down ? { error: MODELS_DOWN } : decided(forTurn(decideS102, context.turnId));
  };
  face.gate = (request) => forTurn(commitS102.outcome, request.turn.id) as never;
  restores.push(
    setSafetyDeps(h.deps),
    setBatchHooks({ clock: h.clock }),
    setLeaseHooks(turnHooks),
    setBundleDeps(fakeBundles().deps),
    setTurnDeps(turnDeps(facts, face, ai, keys)),
    setGuardDeps({ targets: targets.port }),
    setOutageDeps(o.deps),
  );
  return {
    h,
    o,
    face,
    ai,
    decidedAt,
    actor: actorOf(who),
    async tick(ms) {
      await h.clock.advance(ms);
      await runDurableObjectAlarm(stubOf(who));
    },
  };
}

/** `rigFor`'s rig over the PostgreSQL-down path's doubles. */
interface DownRig extends Rig {
  f: DbFakes;
}

/**
 * As `rigFor`, over ../db/test-support.ts's doubles (DL-615's method: one `down` switch for the safety core, the probe and
 * the bundle registry; PostgreSQL answering), with the PostgreSQL-down path wired, as D-017 is to wire it, when
 * `downPath`, and unwired otherwise, as the root installs it today. Each text is read as No unless `answers` says
 * otherwise. The handle's keyword copy is bundle A's, installed by the actor's own ActorCopies.refreshKeywords before any
 * text arrives (the call each turn's pin makes: handle-actor.ts pinAndCopy), so the down path's real classify reads each
 * text, with the key store the gateway sealed it under.
 */
async function downRigFor(
  who: Party,
  eventIds: string[],
  down: number,
  downPath: boolean,
  answers: Record<string, SafetyResult> = {},
): Promise<DownRig> {
  const all: Record<string, SafetyResult> = {
    ...Object.fromEntries(eventIds.map((eventId) => [eventId, safetyNoFor(eventId)])),
    ...answers,
  };
  const f = dbFakes(keys, all, { start: 0, ids: TEST_IDS });
  const read = fakeRead(f.clock, all);
  const stopped = { value: false };
  const h: Harness = {
    clock: f.clock,
    core: f.core,
    direct: f.direct,
    read,
    stopped,
    deps: { ...f.safetyDeps, read, isStopped: () => stopped.value },
  };
  const o = outageHarness(f.clock);
  const face = fakeTurnFace();
  const ai = fakeDecide(face.log);
  const facts = fakeFacts(who.party, [buildFrontierS102.request.now, commitS102.request.now]);
  for (const [eventId, result] of Object.entries(all)) facts.safety.set(eventId, result);
  const targets = fakeTargets();
  targets.answers.set(who.party.handleId, targetsAnswer(who.party.handleId, SAM_S1_02_TARGETS));
  const decidedAt: number[] = [];
  face.frontier = (request) => forTurn(buildFrontierS102.outcome, request.turn.id);
  ai.decide = (context) => {
    decidedAt.push(f.clock.now());
    return decidedAt.length <= down ? { error: MODELS_DOWN } : decided(forTurn(decideS102, context.turnId));
  };
  face.gate = (request) => forTurn(commitS102.outcome, request.turn.id) as never;
  restores.push(
    setSafetyDeps(h.deps),
    setBatchHooks({ clock: f.clock }),
    setLeaseHooks(turnHooks),
    setBundleDeps(f.bundleDeps),
    setTurnDeps(turnDeps(facts, face, ai, keys)),
    setGuardDeps({ targets: targets.port }),
    setOutageDeps(o.deps),
  );
  if (downPath) restores.push(setDbOutageDeps(f.outageDeps));
  const copied = await runInDurableObject(stubOf(who), (instance) =>
    (instance as unknown as { copies: ActorCopies }).copies.refreshKeywords(
      WHOLE_A.manifest as unknown as Record<string, unknown>,
    ),
  );
  expect(copied).toBe(true);
  return {
    h,
    o,
    face,
    ai,
    decidedAt,
    f,
    actor: actorOf(who),
    async tick(ms) {
      await f.clock.advance(ms);
      await runDurableObjectAlarm(stubOf(who));
    },
  };
}

describe("the AI-down path inside the real lease", () => {
  it("with the down path unwired, as the root installs it today: a turn the models are down for runs again every 30 s, across the lease's lapse, and commits once when they are back; no text is told, since the actor's one reading holds each outage line back (T-1323; DL-615)", async () => {
    const rig = rigFor(SAM, ["evt-sam-0001", "evt-sam-0002"], 3);
    await arrive(SAM, "evt-sam-0001", "Barbershop, plumbing, electrical", "2026-10-19T14:05:00Z");
    await arrive(SAM, "evt-sam-0002", "and lawn care", "2026-10-19T14:05:01Z");
    await actorOf(SAM).safetyIdle();

    // The batch closes at 3 s and the lease runs the turn: the models are down, and it waits. Neither text gets the line:
    // while the PostgreSQL-down path is unwired, the actor's one reading counts a possible STOP (T-1313's stopPending).
    await rig.tick(3000);
    await until(() => rig.o.waits.length === 1, "the first run's wait");
    const turnId = await turnIdOf(["evt-sam-0001", "evt-sam-0002"]);
    expect(rig.decidedAt).toEqual([3000]);
    expect(rig.o.lines.requests).toEqual([]);

    // 30 s on, the turn runs again; the next try would come at the lease's lapse (63 s), so the run ends there.
    await rig.tick(RETRY_MS);
    await until(() => rig.decidedAt.length === 2, "the second try");
    expect(rig.decidedAt).toEqual([3000, 33_000]);
    expect(await rig.actor.readTurns()).toMatchObject([{ turnId, state: "leased", tries: 1 }]);

    // The lease lapses at 63 s and reruns the turn (try 2), 30 s after the last try: still down, and still no line.
    await rig.tick(RETRY_MS);
    await until(() => rig.o.waits.length === 2, "the rerun's wait");
    expect(rig.decidedAt).toEqual([3000, 33_000, 63_000]);
    expect(await rig.actor.readTurns()).toMatchObject([{ turnId, state: "leased", tries: 2 }]);

    // Back at 93 s: the turn commits once, and the lease is released.
    await rig.tick(RETRY_MS);
    await until(() => rig.face.gateCalls.length === 1, "the commit");
    await actorOf(SAM).batchIdle();
    expect(rig.decidedAt).toEqual([3000, 33_000, 63_000, 93_000]);
    expect(rig.face.gateCalls.map((call) => call.request.turn.id)).toEqual([turnId]);
    expect(await rig.actor.readTurns()).toMatchObject([
      { turnId, state: "committed", tries: 2, leaseUntil: null },
    ]);
    // No line by any path: none asked of K-09 by the turn's outage path (the actor's word came before the stopped flag the
    // deps read, which was never asked), none by the safety read's timeout rule through the core, none straight through
    // Linq; so no row and no wake.
    expect(rig.o.lines.requests).toEqual([]);
    expect(rig.o.lines.rows.size).toBe(0);
    expect(rig.o.wakes).toEqual([]);
    expect(rig.o.stoppedReads).toEqual([]);
    expect(rig.h.core.fixed).toEqual([]);
    expect(rig.h.direct.sent).toEqual([]);
  });

  it("with the down path wired, as D-017 is to wire it, each text read as another text by the real classify: a turn the models are down for runs again every 30 s, across the lease's lapse, and commits once when they are back; each waiting text is told once", async () => {
    const rig = await downRigFor(SAM, ["evt-sam-0001", "evt-sam-0002"], 3, true);
    await arrive(SAM, "evt-sam-0001", "Barbershop, plumbing, electrical", "2026-10-19T14:05:00Z");
    await arrive(SAM, "evt-sam-0002", "and lawn care", "2026-10-19T14:05:01Z");
    await actorOf(SAM).safetyIdle();
    // Before the line's moment the down path has read each text no commit has taken as another text (DL-615).
    await actorOf(SAM).outageIdle();
    expect((await actorOf(SAM).readOutage()).texts).toEqual([
      expect.objectContaining({ eventId: "evt-sam-0001", kind: "other" }),
      expect.objectContaining({ eventId: "evt-sam-0002", kind: "other" }),
    ]);

    // The batch closes at 3 s and the lease runs the turn: the models are down, both texts get the line, and it waits.
    await rig.tick(3000);
    await until(() => rig.o.waits.length === 1, "the first run's wait");
    const turnId = await turnIdOf(["evt-sam-0001", "evt-sam-0002"]);
    expect(rig.decidedAt).toEqual([3000]);
    expect(rig.o.lines.requests.map((sent) => [sent.at, sent.request.caller.requestId])).toEqual([
      [3000, "safety:evt-sam-0001"],
      [3000, "safety:evt-sam-0002"],
    ]);

    // 30 s on, the turn runs again; the next try would come at the lease's lapse (63 s), so the run ends there.
    await rig.tick(RETRY_MS);
    await until(() => rig.decidedAt.length === 2, "the second try");
    expect(rig.decidedAt).toEqual([3000, 33_000]);
    expect(await rig.actor.readTurns()).toMatchObject([{ turnId, state: "leased", tries: 1 }]);

    // The lease lapses at 63 s and reruns the turn (try 2), 30 s after the last try: still down, it asks for each line
    // again under the same request id, and K-09 answers repeated, so nothing more is sent.
    await rig.tick(RETRY_MS);
    await until(() => rig.o.waits.length === 2, "the rerun's wait");
    expect(rig.decidedAt).toEqual([3000, 33_000, 63_000]);
    expect(await rig.actor.readTurns()).toMatchObject([{ turnId, state: "leased", tries: 2 }]);

    // Back at 93 s: the turn commits once, and the lease is released.
    await rig.tick(RETRY_MS);
    await until(() => rig.face.gateCalls.length === 1, "the commit");
    await actorOf(SAM).batchIdle();
    expect(rig.decidedAt).toEqual([3000, 33_000, 63_000, 93_000]);
    expect(rig.face.gateCalls.map((call) => call.request.turn.id)).toEqual([turnId]);
    expect(await rig.actor.readTurns()).toMatchObject([
      { turnId, state: "committed", tries: 2, leaseUntil: null },
    ]);
    // Each text got the line once: one row per text, the rerun's asks answered repeated.
    expect([...rig.o.lines.rows.keys()]).toEqual(["safety:evt-sam-0001", "safety:evt-sam-0002"]);
    expect(rig.o.lines.requests).toHaveLength(4);
    expect(rig.o.wakes).toHaveLength(1);
  });

  it("the turn's outage line is the safety read's own request for the same text (its timeout rule's), so K-09 sends it once per text", async () => {
    // The safety read never answers: at 4 s its timeout rule sends the outage line, with no danger word in the text.
    // That line is a step on the way here (DL-615, the architect's 5(b)): the PostgreSQL-down path runs wired, as D-017 is
    // to wire it, over ../db/test-support.ts's doubles (PostgreSQL answering), with the handle's keyword copy bundle A's,
    // installed by the actor's own ActorCopies.refreshKeywords (no turn runs here), and has read the text as another text.
    const f = dbFakes(keys, {}, { start: 0, ids: TEST_IDS });
    const read = fakeRead(f.clock, {});
    const deps: SafetyDeps = { ...f.safetyDeps, read, isStopped: () => false };
    const h: Harness = {
      clock: f.clock,
      core: f.core,
      direct: f.direct,
      read,
      stopped: { value: false },
      deps,
    };
    restores.push(setSafetyDeps(h.deps), setBatchHooks({ clock: h.clock }), setDbOutageDeps(f.outageDeps));
    const copied = await runInDurableObject(stubOf(ALEX), (instance) =>
      (instance as unknown as { copies: ActorCopies }).copies.refreshKeywords(
        WHOLE_A.manifest as unknown as Record<string, unknown>,
      ),
    );
    expect(copied).toBe(true);
    await arrive(ALEX, "evt-alex-0601", "Test words: can I come Thursday?", "2026-10-22T16:00:00Z");
    await actorOf(ALEX).outageIdle();
    expect((await actorOf(ALEX).readOutage()).texts).toEqual([
      expect.objectContaining({ eventId: "evt-alex-0601", kind: "other" }),
    ]);
    await h.clock.advance(4000);
    await actorOf(ALEX).safetyIdle();
    expect(h.core.fixed).toHaveLength(1);

    const waiting: WaitingTurn = {
      actorName: actorNameOf(ALEX.handle),
      handleId: "handle-alex",
      businessId: "biz-lees-barbershop",
      personId: "person-alex",
      texts: [{ eventId: "evt-alex-0601", traceId: TRACE, lined: false }],
      stopAsked: false,
    };
    const text = waiting.texts[0];
    if (text === undefined) throw new Error("no text");
    expect(outageLineRequest(waiting, text)).toEqual(h.core.fixed[0]?.request);
  });
});

// ---- T-1323: a STOP stored and not committed holds the AI-down path's outage line back ------------------------------

describe("a STOP stored behind the turn, or in its open batch window, gets no AI-down outage line, with the down path wired or not (T-1323; RULES 7.2), while a danger line still goes (RULES 4.12)", () => {
  const A = "evt-sam-0001";
  const B = "evt-sam-0002";
  const C = "evt-sam-0003";
  const STOP = "evt-sam-0004";
  const DANGER = "evt-sam-0005";
  const OTHER = "evt-sam-0006";

  const BODIES: Record<string, string> = {
    [A]: "Barbershop, plumbing, electrical",
    [B]: "and lawn care",
    [C]: "Test words: Saturday works too",
    [STOP]: "STOP",
    [DANGER]: "Test words: my lips are swelling",
    [OTHER]: "Test words: thanks!",
  };

  /** A danger verdict (safety-emergency-now.json) for DANGER. */
  const DANGER_VERDICT: Record<string, SafetyResult> = {
    [DANGER]: { ...(safetyEmergencyNow as unknown as SafetyResult), eventId: DANGER },
  };

  /** One of Sam's texts arrives now, and its safety read and the down path's reading of it settle. */
  async function text(rig: DownRig, eventId: string): Promise<void> {
    await arrive(SAM, eventId, BODIES[eventId] ?? "", new Date(rig.f.clock.now()).toISOString());
    await rig.actor.safetyIdle();
    await rig.actor.outageIdle();
  }

  /** Polls an answer of the actor's until it holds. */
  async function eventually(check: () => Promise<boolean>, what: string): Promise<void> {
    const started = Date.now();
    while (!(await check())) {
      if (Date.now() - started > 3000) throw new Error(`gave up waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /** The actor's answer to the AI-down path now (handle-actor.ts `mayHaveStopped`), inside the actor. */
  const actorAnswer = (): Promise<boolean> =>
    runInDurableObject(stubOf(SAM), (instance) =>
      (instance as unknown as { mayHaveStopped(): boolean }).mayHaveStopped(),
    );

  /** lease_turns.restart of each turn, in the order they opened: 0, 1 for the one restart, 2 for the second (ADR-018). */
  const restartsWritten = (): Promise<number[]> =>
    runInDurableObject(stubOf(SAM), (_, state) =>
      state.storage.sql
        .exec<{ restart: number }>("SELECT restart FROM lease_turns ORDER BY seq")
        .toArray()
        .map((row) => row.restart),
    );

  /**
   * No outage line by any path (DL-615): none asked of K-09 by the turn's outage path, so no row and no wake; none by the
   * safety read's timeout rule through the core; none straight through Linq. And the actor's word held it back before the
   * stopped flag the deps read was asked.
   */
  function noOutageLine(rig: DownRig): void {
    expect(rig.o.lines.requests).toEqual([]);
    expect(rig.o.lines.rows.size).toBe(0);
    expect(rig.o.wakes).toEqual([]);
    expect(rig.o.stoppedReads).toEqual([]);
    expect(rig.f.core.fixed).toEqual([]);
    expect(rig.f.direct.sent.filter((send) => send.fixedLineId === "outage")).toEqual([]);
  }

  /**
   * The danger verdict's own safety line went at once, through the core's outbox row (RULES 4.12: "Danger first"; arch 02
   * line 111: "at any hour, past any opt-out"; runtime/src/safety/arrival.ts sendDanger never asks `stopped`).
   */
  function dangerLineWent(rig: DownRig, at: number): void {
    expect(
      rig.f.core.recorded.map((call) => [
        call.at,
        call.request.safety.eventId,
        "error" in call.response ? null : (call.response.safetyLine?.fixedLineId ?? null),
      ]),
    ).toEqual([[at, DANGER, "safetyEmergency"]]);
  }

  /**
   * Way 2 (DL-621): Sam's first text's turn (its batch closes at 3 s) waits in decide, held by the test, while `late`
   * arrives and sits in its open 3 s batch window; the clock has not moved since, so the window is still open.
   */
  async function lateInWindow(rig: DownRig, late: string): Promise<void> {
    rig.ai.decideHold.closed = true;
    await text(rig, A);
    await rig.tick(3000);
    await until(() => rig.ai.decideCalls.length === 1, "the turn's decide");
    await text(rig, late);
    expect((await rig.actor.readBatches()).at(-1)).toMatchObject({ reason: null, eventIds: [late] });
  }

  /** The held decides answer that the models are down; the turn's run asks for the outage line, then waits 30 s. */
  async function modelsDownNow(rig: DownRig, waits = 1): Promise<void> {
    rig.ai.decideHold.closed = false;
    await until(() => rig.o.waits.length === waits, "the run's wait");
  }

  it.each([
    ["unwired, as the root installs it today", false],
    ["wired, as D-017 is to wire it, the STOP read as a STOP by the real classify", true],
  ] as const)(
    "way 2, with the down path %s: a STOP in its open 3 s batch window when the turn's run first asks for the outage line gets no line to that number by any path, and the restart it then makes holds the STOP and sends none; a danger verdict's safety line still goes",
    async (_how, downPath) => {
      const rig = await downRigFor(SAM, [A, STOP, DANGER], 99, downPath, DANGER_VERDICT);
      await lateInWindow(rig, STOP);
      if (downPath) {
        expect((await rig.actor.readOutage()).texts).toEqual([
          expect.objectContaining({ eventId: A, kind: "other" }),
          expect.objectContaining({ eventId: STOP, kind: "stop", keyword: "left" }),
        ]);
      }
      expect(await actorAnswer()).toBe(true);

      await modelsDownNow(rig);
      expect(rig.decidedAt).toEqual([3000]);
      noOutageLine(rig);

      // A danger verdict while the STOP is still in its window: its safety line goes at once, and danger closes the
      // window, so the STOP's batch restarts the turn with it (the one restart); that run holds the STOP and sends none.
      await text(rig, DANGER);
      dangerLineWent(rig, 3000);
      await until(() => rig.o.waits.length === 2, "the restart's wait");
      expect(await rig.actor.readTurns()).toMatchObject([
        { eventIds: [A], state: "replaced" },
        { eventIds: [A, STOP, DANGER], state: "leased", restart: true, tries: 1 },
      ]);
      noOutageLine(rig);
    },
  );

  it.each([
    ["unwired, as the root installs it today: any batch may hold a stop word", false],
    [
      "wired, as D-017 is to wire it: the third text read as unknown, its words not opened by the down path's key read (the turn's own key store opens them)",
      true,
    ],
  ] as const)(
    "way 1, with the down path %s: a STOP stored behind the turn the second restart opened, then that turn's next models-down runs (its try and the lease's rerun) send no line to that number by any path; a danger verdict's safety line still goes",
    async (_how, downPath) => {
      const rig = await downRigFor(SAM, [A, B, C, STOP, DANGER], 99, downPath, DANGER_VERDICT);
      rig.ai.decideHold.closed = true;
      // A turn at 3 s, its one restart at 6 s, then its second restart at 9 s (ADR-018 section 1: a batch that may hold a
      // stop word), each run waiting in decide.
      await text(rig, A);
      await rig.tick(3000);
      await until(() => rig.ai.decideCalls.length === 1, "the first turn's decide");
      await text(rig, B);
      await rig.tick(3000);
      await until(() => rig.ai.decideCalls.length === 2, "the restart's decide");
      if (downPath) rig.f.keyReads.push(false);
      await text(rig, C);
      await rig.tick(3000);
      await until(() => rig.ai.decideCalls.length === 3, "the second restart's decide");
      // The STOP: its batch closes at 12 s and waits behind the turn the second restart opened (lease.ts planOf).
      await text(rig, STOP);
      await rig.tick(3000);
      await eventually(async () => (await rig.actor.readWaitingBatches()).length === 1, "the STOP's batch");
      expect(await rig.actor.readTurns()).toMatchObject([
        { eventIds: [A], state: "replaced" },
        { eventIds: [A, B], state: "replaced", restart: true },
        { eventIds: [A, B, C], state: "leased", restart: true, tries: 1, leaseUntil: 9000 + 60_000 },
      ]);
      expect(await restartsWritten()).toEqual([0, 1, 2]);
      if (downPath) {
        expect((await rig.actor.readOutage()).texts).toEqual([
          expect.objectContaining({ eventId: A, kind: "other" }),
          expect.objectContaining({ eventId: B, kind: "other" }),
          expect.objectContaining({ eventId: C, kind: "unknown" }),
          expect.objectContaining({ eventId: STOP, kind: "stop", keyword: "left" }),
        ]);
      }
      // A danger verdict now: its safety line goes at once, and its batch waits behind the turn too.
      await text(rig, DANGER);
      dangerLineWent(rig, 12_000);
      await eventually(async () => (await rig.actor.readWaitingBatches()).length === 2, "the danger's batch");
      expect(await actorAnswer()).toBe(true);

      // The turn's next models-down run: its decide answers, and it asks for the line with the STOP stored behind it. The
      // replaced runs' decides answer too, and those runs end with no ask.
      await modelsDownNow(rig);
      await until(() => rig.decidedAt.length === 3, "every held decide's answer");
      expect(rig.decidedAt).toEqual([12_000, 12_000, 12_000]);
      noOutageLine(rig);

      // Its next try at 39 s (30 s after the run began, at its restart at 9 s), then the lease's lapse at 69 s reruns it
      // (try 2), which asks again: still no line.
      await rig.tick(39_000 - 12_000);
      await until(() => rig.decidedAt.length === 4, "the next try");
      await rig.tick(69_000 - 39_000);
      await until(() => rig.o.waits.length === 2, "the rerun's wait");
      expect(rig.decidedAt).toEqual([12_000, 12_000, 12_000, 39_000, 69_000]);
      expect((await rig.actor.readTurns()).at(-1)).toMatchObject({
        eventIds: [A, B, C],
        state: "leased",
        tries: 2,
      });
      noOutageLine(rig);
    },
  );

  it("the boundary, with the down path wired: another text in its open batch window, each text read as another text by the real classify and the copy not stopped: the run's outage line goes, once per text, the restart that text makes included", async () => {
    const rig = await downRigFor(SAM, [A, OTHER], 99, true);
    await lateInWindow(rig, OTHER);
    expect((await rig.actor.readOutage()).texts).toEqual([
      expect.objectContaining({ eventId: A, kind: "other" }),
      expect.objectContaining({ eventId: OTHER, kind: "other" }),
    ]);
    expect(await actorAnswer()).toBe(false);

    await modelsDownNow(rig);
    expect(rig.o.lines.requests.map((sent) => [sent.at, sent.request.caller.requestId])).toEqual([
      [3000, `safety:${A}`],
    ]);
    expect(rig.o.stoppedReads).toEqual([actorNameOf(SAM.handle)]);

    // The window closes at 6 s: the other text restarts the turn, whose run asks for both lines; K-09 answers the first
    // repeated, so each text has its line once.
    await rig.tick(3000);
    await until(() => rig.o.waits.length === 2, "the restart's wait");
    expect(rig.o.lines.requests.map((sent) => [sent.at, sent.request.caller.requestId])).toEqual([
      [3000, `safety:${A}`],
      [6000, `safety:${A}`],
      [6000, `safety:${OTHER}`],
    ]);
    expect([...rig.o.lines.rows.keys()]).toEqual([`safety:${A}`, `safety:${OTHER}`]);
    expect(rig.f.core.fixed).toEqual([]);
    expect(rig.f.direct.sent).toEqual([]);
  });

  const faults: { fault: string; unreadable?: true; sql?: string[] }[] = [
    { fault: "is read as unknown (its words not opened: the down path's key read failed)", unreadable: true },
    // Its `arrive` write threw: the down path has no reading of it.
    { fault: "has no reading", sql: [`DELETE FROM outage_texts WHERE event_id = '${OTHER}'`] },
    {
      fault: "cannot be found",
      sql: [
        `DELETE FROM outage_texts WHERE event_id = '${OTHER}'`,
        `DELETE FROM inbox WHERE event_id = '${OTHER}'`,
      ],
    },
    { fault: "has a reading that throws", sql: ["DROP TABLE outage_texts"] },
  ];

  it.each(faults)(
    "with the down path wired, fails closed as T-1313 does: a text in its open batch window that $fault counts as a possible STOP, and no outage line goes by any path",
    async ({ unreadable, sql }) => {
      const rig = await downRigFor(SAM, [A, OTHER], 99, true);
      rig.ai.decideHold.closed = true;
      await text(rig, A);
      await rig.tick(3000);
      await until(() => rig.ai.decideCalls.length === 1, "the turn's decide");
      if (unreadable === true) rig.f.keyReads.push(false);
      await text(rig, OTHER);
      if (unreadable === true) {
        expect((await rig.actor.readOutage()).texts).toContainEqual(
          expect.objectContaining({ eventId: OTHER, kind: "unknown" }),
        );
      }
      await runInDurableObject(stubOf(SAM), (_, state) => {
        for (const query of sql ?? []) state.storage.sql.exec(query);
      });
      expect(await actorAnswer()).toBe(true);

      await modelsDownNow(rig);
      noOutageLine(rig);
    },
  );
});
