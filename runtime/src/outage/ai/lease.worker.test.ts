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
//
// T-1337 (DL-656): an outage line's row written before a STOP that has not committed is dropped at send, never sent. The
// real runDispatch and limit 8 run over the dispatcher's doubles (../../dispatch/test-support.ts), K-09's doubles write
// each row into the K-05 outbox double as the core does, and the root's own port (../../wiring/root.ts actorReadingPort)
// asks this real actor, through its stub, right before the send; no outage_texts row is written by hand.
//
// T-1341 (DL-669): each outage row written outside a turn's commit is woken by its own writer, while the actor's one
// reading says exactly false. Where a test joins it, the writers' wake is one run of that real dispatcher for the recipient
// the wake names, as the root builds it, joined as the safety read's SafetyDeps.wake and as the AI-down path's
// OutageDeps.wake; no test runs the dispatcher unless it says so.
//
// T-1352 (DL-687, DL-698): the danger line's row is woken by its own writer at once, never gated and never awaited. Where a
// test joins it, the danger wake is one safety run of that real dispatcher for the recipient the wake names (K-05 v1.14's
// safety-only claim, which the outbox double answers), as the root builds it, joined as SafetyDeps.wakeSafety.
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import fixedLinesFixture from "../../../../contracts/bundle/fixtures/fixed-lines.json";
import buildFrontierS102 from "../../../../contracts/tool-api/fixtures/build-frontier-s1-02.json";
import commitS102 from "../../../../contracts/tool-api/fixtures/commit-s1-02.json";
import decideS102 from "../../../../contracts/model/fixtures/decide-s1-02-choose.json";
import safetyChildOrElder from "../../../../contracts/model/fixtures/safety-child-or-elder.json";
import safetyEmergencyNow from "../../../../contracts/model/fixtures/safety-emergency-now.json";
import {
  setBatchHooks,
  setBundleDeps,
  setLeaseHooks,
  setSafetyDeps,
  turnIdOf,
  type BatchEntry,
  type HandleActor,
  type HoldEntry,
  type SafetyEntry,
  type TurnEntry,
} from "../../actor";
import type { ActorCopies } from "../../actor/copies/copies";
import { BUNDLE_A, fakeBundles, WHOLE_A } from "../../bundle/test-support";
import type { ClockActors, ClockDirectory } from "../../clocks/types";
import { runDispatch, type DispatchDeps } from "../../dispatch/dispatcher";
import { dispatchSendDoor } from "../../dispatch/retry/door";
import {
  FakeClock,
  FakeLinq,
  FakeOutboxStore,
  FakeRecipients,
  FakeSendState,
  traceCollector,
  words,
  type SeedRow,
} from "../../dispatch/test-support";
import type { LinqFailed } from "../../dispatch/types";
import { actorNameOf, durableObjectActor, type ActorNamespace, type HandleActorRpc } from "../../gateway";
import { fakeKeyStore } from "../../gateway/test-support";
import { setGuardDeps } from "../../guard";
import { fakeTargets } from "../../guard/test-support";
import type { JobTry } from "../../queues";
import { fakeRead, harness, TEST_IDS, type Harness } from "../../safety/test-support";
import type {
  CoreError,
  HandleIds,
  SafetyDeps,
  SafetyResult,
  SendFixedLineRequest,
  SendFixedLineResponse,
} from "../../safety/types";
import { openTrace, type Span } from "../../trace";
import { actorReadingPort } from "../../wiring/root";
import { setDbOutageDeps, type OutageView } from "../db";
import { dbFakes, idsOf, type DbFakes } from "../db/test-support";
import { setTurnDeps, turnHooks } from "../../turn";
import {
  ALEX,
  SAM,
  SAM_S1_02_TARGETS,
  decided,
  fakeDecide,
  fakeFacts,
  fakeTurnFace,
  hold,
  retarget,
  safetyNoFor,
  storedText,
  targetsAnswer,
  turnDeps,
  until,
  type FakeDecide,
  type FakeTurnFace,
  type Hold,
} from "../../turn/test-support";
import type { TurnDeps, TurnParty } from "../../turn/types";
import {
  MODELS_DOWN,
  OUTAGE_LINE_ID,
  RETRY_MS,
  outageLineRequest,
  setOutageDeps,
  type OutageWake,
  type WaitingTurn,
} from "./index";
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
  readSafety(): Promise<SafetyEntry[]>;
  readHolds(): Promise<HoldEntry[]>;
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
 * text, with the key store the gateway sealed it under. `wiring` (T-1337) names the handle's ids the safety read's calls
 * use (TEST_IDS's when left out) and the turn's dispatcher (the turn's doubles' when left out); and (T-1341) the outage
 * lines' writers' wake, joined as the root joins it, as the safety read's `SafetyDeps.wake` and, after the AI-down path's
 * own record of each wake (`o.wakes`), as its `OutageDeps.wake` (none when left out: the rows wait for a run); and
 * (T-1352) the danger line's own wake, joined as the root joins it, as the safety read's `SafetyDeps.wakeSafety` (none
 * when left out: the danger line's row waits for the recipient's next run).
 */
async function downRigFor(
  who: Party,
  eventIds: string[],
  down: number,
  downPath: boolean,
  answers: Record<string, SafetyResult> = {},
  wiring: {
    ids?: HandleIds;
    dispatcher?: TurnDeps["dispatcher"];
    wake?: (request: OutageWake) => Promise<void>;
    wakeSafety?: (request: OutageWake) => Promise<void>;
  } = {},
): Promise<DownRig> {
  const all: Record<string, SafetyResult> = {
    ...Object.fromEntries(eventIds.map((eventId) => [eventId, safetyNoFor(eventId)])),
    ...answers,
  };
  const f = dbFakes(keys, all, { start: 0, ids: wiring.ids ?? TEST_IDS });
  const read = fakeRead(f.clock, all);
  const stopped = { value: false };
  const wake = wiring.wake;
  const wakeSafety = wiring.wakeSafety;
  const h: Harness = {
    clock: f.clock,
    core: f.core,
    direct: f.direct,
    read,
    stopped,
    deps: {
      ...f.safetyDeps,
      read,
      isStopped: () => stopped.value,
      ...(wake === undefined ? {} : { wake }),
      ...(wakeSafety === undefined ? {} : { wakeSafety }),
    },
  };
  const o = outageHarness(f.clock);
  const outageDeps =
    wake === undefined
      ? o.deps
      : {
          ...o.deps,
          async wake(request: OutageWake): Promise<void> {
            await o.deps.wake?.(request);
            await wake(request);
          },
        };
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
  const turnSet = turnDeps(facts, face, ai, keys);
  restores.push(
    setSafetyDeps(h.deps),
    setBatchHooks({ clock: f.clock }),
    setLeaseHooks(turnHooks),
    setBundleDeps(f.bundleDeps),
    setTurnDeps(wiring.dispatcher === undefined ? turnSet : { ...turnSet, dispatcher: wiring.dispatcher }),
    setGuardDeps({ targets: targets.port }),
    setOutageDeps(outageDeps),
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
    // The try that wrote the rows woke them, and the rerun, whose asks K-09 answered repeated with the same two rows, woke
    // them again (T-1341: a first wake may have been lost); a second wake sends nothing twice (one claim, one key per part).
    const woken = {
      handleId: SAM.party.handleId,
      outboxRowIds: ["out-safety-evt-sam-0001-outage", "out-safety-evt-sam-0002-outage"],
    };
    expect(rig.o.wakes).toEqual([woken, woken]);
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

  // ---- round 2 (DL-644): a STOP the actor takes while an earlier line of the try is out -------------------------------

  /**
   * K-09's answers held while `gate` is closed: the core takes each outage line's request at once (it is noted, and its row
   * written) and answers once the gate opens, as a core slow to answer while the actor goes on taking texts, the way
   * `lateInWindow` lands a text while a run waits in decide.
   */
  function holdAnswers(rig: DownRig, gate: Hold): void {
    const send = rig.o.lines.sendFixedLine.bind(rig.o.lines);
    rig.o.lines.sendFixedLine = async (request) => {
      const answer = await send(request);
      await gate.wait();
      return answer;
    };
  }

  /**
   * The first text's line, asked for before the STOP came, is the only outage line by any path: none after it from the
   * turn's outage path (the stopped flag read once, before the first line), no wake for its row, none by the safety read's
   * timeout rule through the core, none straight through Linq.
   */
  function onlyTheFirstLine(rig: DownRig): void {
    expect(rig.o.lines.requests.map((sent) => [sent.at, sent.request.caller.requestId])).toEqual([
      [3000, `safety:${A}`],
    ]);
    expect([...rig.o.lines.rows.keys()]).toEqual([`safety:${A}`]);
    expect(rig.o.wakes).toEqual([]);
    expect(rig.o.stoppedReads).toEqual([actorNameOf(SAM.handle)]);
    expect(rig.f.core.fixed).toEqual([]);
    expect(rig.f.direct.sent.filter((send) => send.fixedLineId === "outage")).toEqual([]);
  }

  it.each([
    [
      "unwired, as the root installs it today: the actor's reading holds even the first line, so no request is out when the STOP comes, and no line goes by any path",
      false,
    ],
    [
      "wired, as D-017 is to wire it, each text read by the real classify (the first two as other texts, the STOP as a STOP): the first line's request is out when the STOP comes, and no line after it goes",
      true,
    ],
  ] as const)(
    "a STOP the actor takes while the run's first outage line is out (round 2; RULES 7.2), with the down path %s; the try wakes no row, and the restart the STOP makes sends none",
    async (_how, downPath) => {
      const rig = await downRigFor(SAM, [A, B, STOP], 99, downPath);
      const gate = hold(true);
      holdAnswers(rig, gate);
      // Sam's two texts in one batch window, which closes at 3 s: the turn's run finds the models down and asks for the
      // outage line text by text, the core holding its answer to the first.
      await text(rig, A);
      await text(rig, B);
      if (downPath) {
        expect((await rig.actor.readOutage()).texts).toEqual([
          expect.objectContaining({ eventId: A, kind: "other" }),
          expect.objectContaining({ eventId: B, kind: "other" }),
        ]);
        expect(await actorAnswer()).toBe(false);
      }
      await rig.tick(3000);
      if (downPath) {
        await until(() => rig.o.lines.requests.length === 1, "the first line's request");
        expect(rig.o.waits).toEqual([]);
      } else {
        await until(() => rig.o.waits.length === 1, "the run's wait");
        expect(rig.o.lines.requests).toEqual([]);
      }

      // The STOP comes now: the actor takes it into its open 3 s batch window, and its answer turns to a possible STOP.
      await text(rig, STOP);
      expect((await rig.actor.readBatches()).at(-1)).toMatchObject({ reason: null, eventIds: [STOP] });
      if (downPath) {
        expect((await rig.actor.readOutage()).texts).toContainEqual(
          expect.objectContaining({ eventId: STOP, kind: "stop", keyword: "left" }),
        );
      }
      expect(await actorAnswer()).toBe(true);

      // The core answers the first line; the try asks the actor again right before the second, and its word holds that
      // line and the wake.
      gate.closed = false;
      await until(() => rig.o.waits.length === 1, "the run's wait");
      if (downPath) onlyTheFirstLine(rig);
      else noOutageLine(rig);

      // The window closes at 6 s: the STOP's batch restarts the turn (the one restart), whose run holds the STOP and sends
      // none.
      await rig.tick(3000);
      await until(() => rig.o.waits.length === 2, "the restart's wait");
      expect(await rig.actor.readTurns()).toMatchObject([
        { eventIds: [A, B], state: "replaced" },
        { eventIds: [A, B, STOP], state: "leased", restart: true, tries: 1 },
      ]);
      if (downPath) onlyTheFirstLine(rig);
      else noOutageLine(rig);
    },
  );
});

// ---- T-1337: an outage line's row written before a STOP commits goes nowhere while the STOP waits ----------------------

describe("an outage line's row written before a STOP that has not committed is never sent: the dispatcher asks the recipient's real actor right before the send and drops the row (T-1337; DL-656; RULES 7.2), with the down path wired as D-017 is to wire it (DL-615 5(c))", () => {
  const A = "evt-sam-0001";
  const B = "evt-sam-0002";
  const STOP = "evt-sam-0004";
  const DANGER = "evt-sam-0005";
  const S = "evt-sam-0007";

  const BODIES: Record<string, string> = {
    [A]: "Barbershop, plumbing, electrical",
    [B]: "and lawn care",
    [STOP]: "STOP",
    [DANGER]: "Test words: my lips are swelling",
    [S]: "Test words: is Saturday open?",
  };

  /** A danger verdict (safety-emergency-now.json) for DANGER. */
  const DANGER_VERDICT: Record<string, SafetyResult> = {
    [DANGER]: { ...(safetyEmergencyNow as unknown as SafetyResult), eventId: DANGER },
  };

  /** Sam's K-04 handle id: the recipient of every row here, and the id the safety read's calls name (idsOf). */
  const SAM_HANDLE_ID = SAM.party.handleId;
  const SAM_IDS: HandleIds = idsOf(SAM.party);
  const SAM_CHAT = { to: "+15555550100", chatId: "linq-chat-demo-sam", service: "imessage" } as const;

  /** K-01's outage line, word for word as the fixture bundle holds it: the words the core writes into the row. */
  const OUTAGE_TEXT =
    (fixedLinesFixture as { lines: { id: string; text: string | null }[] }).lines.find(
      (line) => line.id === "outage",
    )?.text ?? "(no outage line)";

  /** The row K-09's double (./test-support.ts fakeLines) writes for a text's AI-down outage line. */
  const rowOf = (eventId: string): string => `out-safety-${eventId}-outage`;

  /** The directory as the root's arming port answers it: Sam's K-04 handle id names his actor; no other id names one. */
  const directory: ClockDirectory = {
    actorNameOf: (handleId) => Promise.resolve(handleId === SAM_HANDLE_ID ? actorNameOf(SAM.handle) : null),
  };

  /** The HandleActor namespace as the root takes it (root.ts HandleActors): each stub with the actor's RPC methods. */
  function actors(): ClockActors<DurableObjectId> {
    const ns = namespace();
    return { idFromName: (name) => ns.idFromName(name), get: (id) => ns.get(id) };
  }

  /** The real actor's one reading over RPC (HandleActor.mayHaveStoppedNow), as the root's port asks it. */
  const stubSays = (): Promise<boolean> => stubOf(SAM).mayHaveStoppedNow();

  /** The same reading inside the actor, through the private function the safety read and the AI-down path call. */
  const insideSays = (): Promise<boolean> =>
    runInDurableObject(stubOf(SAM), (instance) =>
      (instance as unknown as { mayHaveStopped(): boolean }).mayHaveStopped(),
    );

  /** The dispatcher's side for one test (T-1337). */
  interface Sends {
    /** The K-05 outbox double each K-09 double writes its sendable row into, as the core writes it. */
    readonly store: FakeOutboxStore;
    readonly linq: FakeLinq;
    /** Limit 8's send-state double: Sam's chat open and not stopped, since no commit has set the flag. */
    readonly state: FakeSendState;
    readonly spans: Span[];
    /** The rows written, in order. */
    readonly written: string[];
    /** Each answer the root's port to the real actor gave the dispatcher, in order ("threw" for a rejection). */
    readonly answers: unknown[];
    /** The dispatcher's ports, the root's port to the real actor among them unless another (or null: none) is given. */
    deps(port?: DispatchDeps["mayHaveStopped"] | null): DispatchDeps;
    /** The turn's dispatcher as the root wires it (root.ts `dispatcher.wake`): one run for the recipient the wake names. */
    readonly dispatcher: TurnDeps["dispatcher"];
    /** Writes a sendable row, its one part the line's words, after the rows written before it (commit order). */
    write(seed: Omit<SeedRow, "commitSeq" | "sends">): void;
    /** Each claim any run asked the outbox double for, by the recipient it named (null: none), in order (T-1341). */
    readonly claims: (string | null)[];
    /** Each wake an outage line's writer made, in order: the safety read's and the AI-down path's alike (T-1341). */
    readonly woken: OutageWake[];
    /** How many of the next wakes throw before their run starts (a wake that fails). */
    wakeFails: number;
    /** Where the next run waits behind `runGate` until the test opens it: its chat lookup or its claim's renewal. */
    heldAt: "the chat lookup" | "the claim's renewal" | null;
    readonly runGate: Hold;
    /** True once a run reached the await it was held at. */
    reached: boolean;
    /**
     * How many writers' wakes' runs have ended. The safety read's writer starts its wake and never awaits it (DL-679), so
     * its line can be decided while the run is still out.
     */
    ended: number;
    /**
     * The outage lines' writers' wake as the root builds it (../../wiring/root.ts `outageWake`, T-1341): one run of the real
     * dispatcher for the recipient the wake names, on these ports, the root's port to the real actor among them.
     */
    wake(request: OutageWake): Promise<void>;
    /**
     * The danger line's own wake as the root builds it (../../wiring/root.ts `dangerWake`, T-1352): one safety run of the
     * real dispatcher for the recipient the wake names (sendClass "safety": K-05 v1.14's safety-only claim), on these ports.
     */
    wakeSafety(request: OutageWake): Promise<void>;
    /** Each danger wake the danger line's writer made, in order (T-1352). */
    readonly dangerWoken: OutageWake[];
    /** How each next danger wake fails before its run starts: a throw at the call, or a rejection (T-1352). */
    dangerWakeFails: ("throws" | "rejects")[];
    /** How many danger wakes' runs have ended (T-1352). */
    dangerEnded: number;
    /** The row whose part's renewal the next run waits at behind `runGate`: a point only that row's run reaches (T-1352). */
    heldRenewalOf: string | null;
    /** While true, every claim reaches the outbox double without `sendClass`: a store or wrapper that drops it (T-1352). */
    dropsSendClass: boolean;
  }

  function sends(): Sends {
    const clock = new FakeClock("2026-10-19T14:05:30.000Z");
    const store = new FakeOutboxStore([]);
    const linq = new FakeLinq(clock.now);
    const state = new FakeSendState();
    const recipients = new FakeRecipients({ [SAM_HANDLE_ID]: SAM_CHAT });
    const spans: Span[] = [];
    const written: string[] = [];
    const answers: unknown[] = [];
    // The root's own port (../../wiring/root.ts actorReadingPort), over the HandleActor namespace and the real actor.
    const rootPort = actorReadingPort(directory, actors());
    const recorded: NonNullable<DispatchDeps["mayHaveStopped"]> = async (handleId) => {
      try {
        const answer = await rootPort(handleId);
        answers.push(answer);
        return answer;
      } catch (error) {
        answers.push("threw");
        throw error;
      }
    };
    /** Holds the run behind `runGate` at `at` when the test asked for it there, once. */
    const holdAt = async (at: Sends["heldAt"]): Promise<void> => {
      if (to.heldAt !== at) return;
      to.heldAt = null;
      to.reached = true;
      await to.runGate.wait();
    };
    const deps = (port: DispatchDeps["mayHaveStopped"] | null = recorded): DispatchDeps => ({
      store: {
        claimOutbox: (request) => {
          to.claims.push(request.recipientHandleId ?? null);
          if (!to.dropsSendClass) return store.claimOutbox(request);
          const dropped = { ...request };
          delete dropped.sendClass;
          return store.claimOutbox(dropped);
        },
        renewClaim: async (request) => {
          await holdAt("the claim's renewal");
          if (to.heldRenewalOf !== null && to.heldRenewalOf === request.outboxRowId) {
            to.heldRenewalOf = null;
            to.reached = true;
            await to.runGate.wait();
          }
          return store.renewClaim(request);
        },
        markPart: (request) => store.markPart(request),
        markRow: (request) => store.markRow(request),
      },
      linq,
      recipients: {
        chatFor: async (handleId) => {
          await holdAt("the chat lookup");
          return recipients.chatFor(handleId);
        },
      },
      sendState: state,
      environment: "test",
      traceFor: traceCollector(spans),
      now: clock.now,
      claimer: "dispatcher-t1337",
      ...(port === null ? {} : { mayHaveStopped: port }),
    });
    let commitSeq = 0;
    const to: Sends = {
      store,
      linq,
      state,
      spans,
      written,
      answers,
      deps,
      dispatcher: {
        async wake(request) {
          await runDispatch(deps(), { recipientHandleId: request.handleId });
        },
      },
      write(seed) {
        commitSeq += 1;
        const row: SeedRow = { ...seed, commitSeq, sends: [words(OUTAGE_TEXT)] };
        store.rows.set(row.id, new FakeOutboxStore([row]).row(row.id));
        written.push(row.id);
      },
      claims: [],
      woken: [],
      wakeFails: 0,
      heldAt: null,
      runGate: hold(true),
      reached: false,
      ended: 0,
      async wake(request) {
        to.woken.push(structuredClone(request));
        if (to.wakeFails > 0) {
          to.wakeFails -= 1;
          throw new Error("the wake failed");
        }
        // As the root's run: its report, a claim error included, is not read (the rows wait for the next run).
        await runDispatch(deps(), { recipientHandleId: request.handleId });
        to.ended += 1;
      },
      dangerWoken: [],
      dangerWakeFails: [],
      dangerEnded: 0,
      heldRenewalOf: null,
      dropsSendClass: false,
      wakeSafety(request) {
        to.dangerWoken.push(structuredClone(request));
        const fails = to.dangerWakeFails.shift();
        if (fails === "throws") throw new Error("the danger wake failed");
        if (fails === "rejects") return Promise.reject(new Error("the danger wake's run failed"));
        // As the root's run: a safety run for the named recipient; its report is not read.
        return runDispatch(deps(), { recipientHandleId: request.handleId, sendClass: "safety" }).then(() => {
          to.dangerEnded += 1;
        });
      },
    };
    return to;
  }

  /** A row K-09's sendFixedLine wrote now (not a repeat), sendable, with the request's send class and fixed line. */
  function noteLine(
    to: Sends,
    request: SendFixedLineRequest,
    answer: SendFixedLineResponse | CoreError,
  ): void {
    if ("error" in answer || answer.repeated || answer.outboxRowId === null) return;
    to.write({
      id: answer.outboxRowId,
      recipient: request.recipientHandleId,
      sendClass: request.sendClass,
      fixedLines: [request.fixedLineId],
    });
  }

  /**
   * K-09's doubles write each row into the outbox double as they take the request, as the core does: the AI-down path's
   * line (./test-support.ts fakeLines), the safety read's timeout line and a danger verdict's safety line (the safety
   * read's core double).
   */
  function writeRows(rig: DownRig, to: Sends): void {
    const lines = rig.o.lines;
    const aiLine = lines.sendFixedLine.bind(lines);
    lines.sendFixedLine = async (request) => {
      const answer = await aiLine(request);
      noteLine(to, request, answer);
      return answer;
    };
    const core = rig.f.core;
    const timeoutLine = core.sendFixedLine.bind(core);
    core.sendFixedLine = async (request) => {
      const answer = await timeoutLine(request);
      noteLine(to, request, answer);
      return answer;
    };
    const record = core.recordSafetyOutcome.bind(core);
    core.recordSafetyOutcome = async (request) => {
      const answer = await record(request);
      if ("error" in answer) return answer;
      const line = answer.safetyLine;
      if (line?.outboxRowId != null) {
        // A repeat of a record whose row is written already writes nothing and answers repeated, naming the same row, as
        // the core answers its request id again (T-1352).
        if (to.written.includes(line.outboxRowId)) return { ...answer, repeated: true };
        to.write({
          id: line.outboxRowId,
          recipient: SAM_HANDLE_ID,
          sendClass: "safety",
          fixedLines: [line.fixedLineId],
        });
      }
      return answer;
    };
  }

  /** K-09's answers held while `gate` is closed, the row written at once (as `holdAnswers` above). */
  function holdLines(rig: DownRig, gate: Hold): void {
    const send = rig.o.lines.sendFixedLine.bind(rig.o.lines);
    rig.o.lines.sendFixedLine = async (request) => {
      const answer = await send(request);
      await gate.wait();
      return answer;
    };
  }

  /** One of Sam's texts arrives now; its down-path reading settles, and its safety read too unless it gets no verdict. */
  async function text(rig: DownRig, eventId: string, read = true): Promise<void> {
    await arrive(SAM, eventId, BODIES[eventId] ?? "", new Date(rig.f.clock.now()).toISOString());
    if (read) await rig.actor.safetyIdle();
    await rig.actor.outageIdle();
  }

  /**
   * The three runs that can claim the row: the root's wake, the retry door's run, and a run with no recipient, which no
   * production code makes (DL-656: no outbox sweep exists; T-1341).
   */
  const RUNS = ["the root's wake", "the retry door's run", "a run with no recipient"] as const;
  type RunBy = (typeof RUNS)[number];

  async function runBy(to: Sends, how: RunBy, row: string): Promise<void> {
    switch (how) {
      case "the root's wake":
        await to.dispatcher.wake(
          { turnId: "turn-t1337", handleId: SAM_HANDLE_ID, outboxRowIds: [row] },
          openTrace({
            openedBy: "textWebhook",
            bundleId: { hash: "a".repeat(64), build: 1 },
            incomingTraceId: TRACE,
            sink: () => undefined,
          }),
        );
        return;
      case "the retry door's run": {
        // A send job come due for the row (dispatch/retry/door.ts), as the retry queue's consumer hands it in.
        const job: JobTry = {
          key: `retry-${row}/1/1#1`,
          kind: "send",
          businessId: SAM.party.businessId,
          traceId: TRACE,
          body: {
            outboxRowId: row,
            recipientHandleId: SAM_HANDLE_ID,
            failedKey: `${row}/1/1`,
            chain: "rerun",
            code: "sameKey",
          },
          try: 2,
          firstTriedAt: "2026-10-19T14:05:30.000Z",
        };
        expect(await dispatchSendDoor(to.deps()).retrySend(job)).toEqual({ result: "done" });
        return;
      }
      case "a run with no recipient":
        await runDispatch(to.deps());
        return;
    }
  }

  /** Nothing went to Linq, and each row was dropped as stopped on the real actor's word, never held. */
  function droppedOnTheActorsWord(to: Sends, rows: string[]): void {
    expect(to.linq.requests).toEqual([]);
    for (const row of rows) expect(to.store.row(row).state).toBe("dropped_stopped");
    expect(to.answers).toEqual(rows.map(() => true));
    expect(to.spans.filter((span) => span.hop === "dispatch")).toEqual(
      rows.map((): unknown =>
        expect.objectContaining({
          outcome: "dropped",
          limits: [{ limit: 8, result: "fail", outcome: "droppedStopped" }],
          decided: expect.objectContaining({ result: "droppedStopped", actorReading: "stopped" }) as unknown,
        }),
      ),
    );
  }

  /**
   * Row A (the architect's case 1): the line for A asked while nothing waits, K-09's answer held while a STOP lands, so the
   * row is written and the try wakes nothing (T-1323 round 2); the STOP stored, read as a STOP, and not committed. The
   * writers' wake is joined as the root joins it (T-1341), and the try's gate, the actor's word, leaves it unmade.
   */
  async function rowAWithStopWaiting(
    to: Sends,
    eventIds: string[] = [A, B, STOP],
    answers: Record<string, SafetyResult> = {},
  ): Promise<DownRig> {
    const rig = await downRigFor(SAM, eventIds, 99, true, answers, {
      ids: SAM_IDS,
      wake: (request) => to.wake(request),
    });
    writeRows(rig, to);
    const gate = hold(true);
    holdLines(rig, gate);
    await text(rig, A);
    await text(rig, B);
    expect(await stubSays()).toBe(false);
    await rig.tick(3000);
    await until(() => rig.o.lines.requests.length === 1, "the first line's request");
    // The STOP comes while the core holds its answer to A's line: the actor takes it into its open batch window.
    await text(rig, STOP);
    expect((await rig.actor.readOutage()).texts).toContainEqual(
      expect.objectContaining({ eventId: STOP, kind: "stop", keyword: "left" }),
    );
    expect(await stubSays()).toBe(true);
    expect(await insideSays()).toBe(true);
    gate.closed = false;
    await until(() => rig.o.waits.length === 1, "the run's wait");
    // Row A is written, and no wake goes for it; the STOP is stored but not committed.
    expect(to.written).toEqual([rowOf(A)]);
    expect(rig.o.wakes).toEqual([]);
    // No writer's wake reached a run, so nothing claimed the row (T-1341: the gate before the wake).
    expect(to.woken).toEqual([]);
    expect(to.claims).toEqual([]);
    expect(rig.face.gateCalls).toEqual([]);
    expect(await rig.actor.readTurns()).toMatchObject([{ eventIds: [A, B], state: "leased" }]);
    return rig;
  }

  it.each(RUNS)(
    "case 1, row A: with the STOP stored and not committed (no commit, the flag not set), %s sends nothing for row A, which is dropped as stopped",
    async (how) => {
      const to = sends();
      await rowAWithStopWaiting(to);

      await runBy(to, how, rowOf(A));

      droppedOnTheActorsWord(to, [rowOf(A)]);
    },
  );

  /** The row K-09's core double writes for a text's safety-read outage line (row S: ../../safety/test-support.ts). */
  const rowSOf = (eventId: string): string => `out-fixed-safety:${eventId}`;

  /** A text's safety entry, as the actor keeps it. */
  const safetyOf = async (rig: DownRig, eventId: string): Promise<SafetyEntry | undefined> =>
    (await rig.actor.readSafety()).find((entry) => entry.eventId === eventId);

  /**
   * Waits until a text's safety work has decided its line: its entry is done (the line handed on, its wake made or not).
   * Polled, as a STOP's own read with no verdict keeps the actor's safety work from ever being idle here.
   */
  async function lineDecided(rig: DownRig, eventId: string): Promise<void> {
    const started = Date.now();
    while ((await safetyOf(rig, eventId))?.state !== "done") {
      if (Date.now() - started > 3000) throw new Error(`gave up waiting for ${eventId}'s line`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /**
   * K-09's answers to the safety read's outage line held while `gate` is closed: the core takes the request and writes
   * its row at once (after `writeRows`), and answers once the gate opens. `asked` counts the requests taken.
   */
  function holdCoreAnswers(rig: DownRig, gate: Hold): { asked: number } {
    const held = { asked: 0 };
    const send = rig.f.core.sendFixedLine.bind(rig.f.core);
    rig.f.core.sendFixedLine = async (request) => {
      const answer = await send(request);
      held.asked += 1;
      await gate.wait();
      return answer;
    };
    return held;
  }

  it.each(RUNS)(
    "case 2, row S: the safety read's timeout line, written through the core while a STOP with no verdict either lands (the models down), is left unwoken by its writer's gate (T-1341; DL-669): %s sends nothing for row S",
    async (how) => {
      const to = sends();
      // No text here gets a verdict: the safety read is down with the models. The writers' wake is joined as the root
      // joins it (T-1341), and the core holds its answer to S's line.
      const rig = await downRigFor(
        SAM,
        [],
        99,
        true,
        {},
        { ids: SAM_IDS, wake: (request) => to.wake(request) },
      );
      writeRows(rig, to);
      const gate = hold(true);
      const held = holdCoreAnswers(rig, gate);
      await text(rig, S, false);
      expect((await rig.actor.readOutage()).texts).toEqual([
        expect.objectContaining({ eventId: S, kind: "other" }),
      ]);
      // 4 s on, the timeout rule asks the core for S's outage line: row S is written at once, the answer held.
      await rig.tick(4000);
      await until(() => held.asked === 1, "the core's answer to S's line");
      expect(rig.f.core.fixed.map((sent) => [sent.at, sent.request.fixedLineId])).toEqual([[4000, "outage"]]);
      const [rowS] = to.written;
      if (rowS === undefined) throw new Error("no row S");
      // Then the STOP, read as a STOP: its read gives no verdict either, so its unread hold keeps it from any turn.
      await text(rig, STOP, false);
      expect((await rig.actor.readOutage()).texts).toContainEqual(
        expect.objectContaining({ eventId: STOP, kind: "stop" }),
      );
      expect(await stubSays()).toBe(true);
      // The core answers: the writer's gate, the actor's word, makes no wake, so nothing claims row S; its result stands.
      gate.closed = false;
      await lineDecided(rig, S);
      expect(to.woken).toEqual([]);
      expect(to.claims).toEqual([]);
      expect(await safetyOf(rig, S)).toMatchObject({ path: "outbox", lineId: "outage" });
      expect(await rig.actor.readTurns()).toEqual([]);

      await runBy(to, how, rowS);

      droppedOnTheActorsWord(to, [rowS]);
    },
  );

  it("case 3, today's production path: the turn's third lapse parks it, and the park's wake, whose run inside the actor asks the actor's own stub (no deadlock), sends neither row A nor row S while the STOP waits (no claim about the park's own row)", async () => {
    const to = sends();
    const rig = await downRigFor(SAM, [A], 99, true, {}, { ids: SAM_IDS, dispatcher: to.dispatcher });
    writeRows(rig, to);
    await text(rig, A);
    await rig.tick(3000);
    await until(() => rig.o.waits.length === 1, "the first run's wait");
    // While the turn waits, S arrives; its read gives no verdict, and 4 s on the timeout rule writes row S.
    await text(rig, S, false);
    await rig.tick(4000);
    await rig.actor.safetyIdle();
    expect(to.written).toEqual([rowOf(A), `out-fixed-safety:${S}`]);
    // Then the STOP, read as a STOP, with no verdict: it waits behind its unread hold, outside the turn.
    await text(rig, STOP, false);
    expect(await stubSays()).toBe(true);

    // The turn tries every 30 s, and each lapse reruns it, until its third lapse at 183 s parks it.
    await rig.tick(33_000 - 7000);
    await until(() => rig.decidedAt.length === 2, "the second try");
    for (const [at, decides] of [
      [63_000, 3],
      [93_000, 4],
      [123_000, 5],
      [153_000, 6],
    ] as const) {
      await rig.tick(30_000);
      await until(() => rig.decidedAt.length === decides, `the try at ${String(at)} ms`);
    }
    expect(rig.decidedAt).toEqual([3000, 33_000, 63_000, 93_000, 123_000, 153_000]);
    await rig.tick(30_000);
    const started = Date.now();
    while ((await rig.actor.readTurns()).at(0)?.state !== "parked") {
      if (Date.now() - started > 3000) throw new Error("gave up waiting for the park");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(await rig.actor.readTurns()).toMatchObject([{ eventIds: [A], state: "parked", tries: 3 }]);
    expect(rig.face.gateCalls).toEqual([]);
    droppedOnTheActorsWord(to, [rowOf(A), `out-fixed-safety:${S}`]);
  });

  it("case 4, the boundary: every text no commit has taken reads other and the copy is not stopped, so the real actor answers false: each row goes once, under its part key, and a second run sends nothing more", async () => {
    const to = sends();
    const rig = await downRigFor(SAM, [A, B], 99, true, {}, { ids: SAM_IDS });
    writeRows(rig, to);
    await text(rig, A);
    await text(rig, B);
    await rig.tick(3000);
    await until(() => rig.o.waits.length === 1, "the run's wait");
    expect(to.written).toEqual([rowOf(A), rowOf(B)]);
    expect(await stubSays()).toBe(false);
    expect(await insideSays()).toBe(false);

    const first = await runDispatch(to.deps(), { recipientHandleId: SAM_HANDLE_ID });

    expect(first.rows.map((row) => [row.outboxRowId, row.outcome, row.partsSent])).toEqual([
      [rowOf(A), "sent", 1],
      [rowOf(B), "sent", 1],
    ]);
    expect(to.linq.requests.map((request) => [request.idempotencyKey, request.text])).toEqual([
      [`${rowOf(A)}/1/1`, OUTAGE_TEXT],
      [`${rowOf(B)}/1/1`, OUTAGE_TEXT],
    ]);
    expect(to.answers).toEqual([false, false]);
    expect((await runDispatch(to.deps(), { recipientHandleId: SAM_HANDLE_ID })).claimed).toBe(0);
    expect(to.linq.requests).toHaveLength(2);
  });

  it.each(["the chat lookup", "the claim's renewal"] as const)(
    "case 5: a STOP the actor accepts while the run waits on %s is read by the ask right before the send: nothing is sent",
    async (during) => {
      const to = sends();
      const rig = await downRigFor(SAM, [A, B, STOP], 99, true, {}, { ids: SAM_IDS });
      writeRows(rig, to);
      await text(rig, A);
      await text(rig, B);
      await rig.tick(3000);
      await until(() => rig.o.waits.length === 1, "the run's wait");
      expect(await stubSays()).toBe(false);
      let landed = false;
      const stopLands = async (now: boolean): Promise<void> => {
        if (!now || landed) return;
        landed = true;
        await text(rig, STOP);
      };
      const deps = to.deps();

      const report = await runDispatch(
        {
          ...deps,
          recipients: {
            chatFor: async (handleId) => {
              await stopLands(during === "the chat lookup");
              return deps.recipients.chatFor(handleId);
            },
          },
          store: {
            claimOutbox: (request) => to.store.claimOutbox(request),
            renewClaim: async (request) => {
              await stopLands(during === "the claim's renewal");
              return to.store.renewClaim(request);
            },
            markPart: (request) => to.store.markPart(request),
            markRow: (request) => to.store.markRow(request),
          },
        },
        { recipientHandleId: SAM_HANDLE_ID },
      );

      expect(landed).toBe(true);
      expect(report.rows.map((row) => [row.outboxRowId, row.outcome])).toEqual([
        [rowOf(A), "droppedStopped"],
        [rowOf(B), "droppedStopped"],
      ]);
      droppedOnTheActorsWord(to, [rowOf(A), rowOf(B)]);
    },
  );

  const FAULTS: { fault: string; port: () => DispatchDeps["mayHaveStopped"] | null; label: string }[] = [
    {
      fault: "the port throws (the namespace gives no stub)",
      port: () =>
        actorReadingPort(directory, {
          idFromName: (name) => namespace().idFromName(name),
          get: () => {
            throw new Error("no stub");
          },
        }),
      label: "threw",
    },
    {
      fault: "the answer is not a boolean",
      port: () =>
        actorReadingPort(directory, {
          idFromName: (name) => name,
          get: () => ({
            fireClockRow: () => Promise.reject(new Error("not used")),
            syncClocks: () => Promise.reject(new Error("not used")),
            mayHaveStoppedNow: () => Promise.resolve("false" as unknown as boolean),
          }),
        }),
      label: "notBoolean",
    },
    {
      fault: "the actor cannot be named",
      port: () => actorReadingPort({ actorNameOf: () => Promise.resolve(null) }, actors()),
      label: "threw",
    },
    { fault: "no port is joined", port: () => null, label: "noPort" },
  ];

  it.each(FAULTS)(
    "fails closed, the real actor's reading false: $fault, so the row is dropped and nothing is sent",
    async ({ port, label }) => {
      const to = sends();
      const rig = await downRigFor(SAM, [A], 99, true, {}, { ids: SAM_IDS });
      writeRows(rig, to);
      await text(rig, A);
      await rig.tick(3000);
      await until(() => rig.o.waits.length === 1, "the run's wait");
      expect(await stubSays()).toBe(false);

      const report = await runDispatch(to.deps(port()), { recipientHandleId: SAM_HANDLE_ID });

      expect(report.rows.map((row) => [row.outboxRowId, row.outcome, row.partsSent])).toEqual([
        [rowOf(A), "droppedStopped", 0],
      ]);
      expect(to.linq.requests).toEqual([]);
      expect(to.store.row(rowOf(A)).state).toBe("dropped_stopped");
      expect(to.spans.find((span) => span.hop === "dispatch")?.decided).toMatchObject({
        actorReading: label,
      });
    },
  );

  it("unchanged: the danger verdict's safety line (RULES 4.12) and a stop reply of the same recipient, claimed after the dropped row, still go", async () => {
    const to = sends();
    const rig = await rowAWithStopWaiting(to, [A, B, STOP, DANGER], DANGER_VERDICT);
    // A danger verdict while the STOP waits: the core records it, and its safety line's row is written, send class safety.
    await text(rig, DANGER);
    expect(rig.f.core.recorded.map((call) => call.request.safety.eventId)).toEqual([DANGER]);
    // The STOP's own reply, as a commit would write it.
    to.write({
      id: "out-sam-stop-reply",
      recipient: SAM_HANDLE_ID,
      sendClass: "quick_reply",
      fixedLines: ["stopReply"],
    });
    expect(to.written).toEqual([rowOf(A), `out-${DANGER}`, "out-sam-stop-reply"]);

    const report = await runDispatch(to.deps(), { recipientHandleId: SAM_HANDLE_ID });

    // Restated by T-1352 (DL-687, the lead's OK; rule 7.9): the run sends its safety row first (RULES 4.12: "the safety
    // message first"), then the rest in commit order.
    expect(report.rows.map((row) => [row.outboxRowId, row.outcome, row.partsSent])).toEqual([
      [`out-${DANGER}`, "sent", 1],
      [rowOf(A), "droppedStopped", 0],
      ["out-sam-stop-reply", "sent", 1],
    ]);
    expect(to.linq.requests.map((request) => request.idempotencyKey)).toEqual([
      `out-${DANGER}/1/1`,
      "out-sam-stop-reply/1/1",
    ]);
    // Only the outage line's row asked the actor.
    expect(to.answers).toEqual([true]);
  });

  it("unchanged: once the STOP commits (the flag set), limit 8 drops the row as it does today, before any ask", async () => {
    const to = sends();
    await rowAWithStopWaiting(to);
    to.state.forHandle(SAM_HANDLE_ID, { stopped: true, chatOpen: false });

    const report = await runDispatch(to.deps(), { recipientHandleId: SAM_HANDLE_ID });

    expect(report.rows.map((row) => [row.outboxRowId, row.outcome])).toEqual([[rowOf(A), "droppedStopped"]]);
    expect(to.linq.requests).toEqual([]);
    expect(to.answers).toEqual([]);
  });

  it("unchanged: with the down path unwired, as the root installs it today, stopPending is true, so an outage line's row is dropped at send (CQ-281)", async () => {
    const to = sends();
    const rig = await downRigFor(SAM, [A], 99, false, {}, { ids: SAM_IDS });
    writeRows(rig, to);
    await text(rig, A);
    expect(await stubSays()).toBe(true);
    // No path asks for a line while unwired, so the row stands in for one the core wrote before.
    to.write({
      id: rowOf(A),
      recipient: SAM_HANDLE_ID,
      sendClass: "quick_reply",
      fixedLines: [OUTAGE_LINE_ID],
    });

    const report = await runDispatch(to.deps(), { recipientHandleId: SAM_HANDLE_ID });

    expect(report.rows.map((row) => [row.outboxRowId, row.outcome])).toEqual([[rowOf(A), "droppedStopped"]]);
    droppedOnTheActorsWord(to, [rowOf(A)]);
  });

  // ---- T-1341: each outage row's own writer wakes the recipient's dispatcher; no sweep runs ----------------------------

  describe("T-1341 (DL-669): an outage line's row written outside a turn's commit reaches a dispatcher run at once, by its own writer's wake (the safety read's SafetyDeps.wake, the AI-down path's OutageDeps.wake), joined as the root joins it, while the actor's one reading says exactly false; T-1337's ask decides it there", () => {
    /** The writers' wake joined to the rig, as the root joins it to both ports. */
    const joined = (to: Sends): { ids: HandleIds; wake: (request: OutageWake) => Promise<void> } => ({
      ids: SAM_IDS,
      wake: (request) => to.wake(request),
    });

    it("row S, sent by its writer alone: a text read as another text gets no verdict in 4 s, the core writes its outage line's row, and the writer's own wake sends it once, before the clock moves past the 4 s deadline; nothing else runs, and a later run sends nothing more", async () => {
      const to = sends();
      const rig = await downRigFor(SAM, [], 99, true, {}, joined(to));
      writeRows(rig, to);
      await text(rig, S, false);
      expect((await rig.actor.readOutage()).texts).toEqual([
        expect.objectContaining({ eventId: S, kind: "other" }),
      ]);
      expect(await stubSays()).toBe(false);

      await rig.tick(4000);
      await rig.actor.safetyIdle();

      const rowS = rowSOf(S);
      expect(to.written).toEqual([rowS]);
      // The fake clock is still at the verdict deadline (arch 02 line 111): the line went in the same safety work.
      expect(rig.f.clock.now()).toBe(4000);
      expect(to.woken).toEqual([{ handleId: SAM_HANDLE_ID, outboxRowIds: [rowS] }]);
      // One claim, the writer's, for the recipient it named; one part to Linq, under the row's part key, past no opt-out.
      expect(to.claims).toEqual([SAM_HANDLE_ID]);
      expect(
        to.linq.requests.map((request) => [request.idempotencyKey, request.text, request.overrideOptout]),
      ).toEqual([[`${rowS}/1/1`, OUTAGE_TEXT, false]]);
      expect(to.store.row(rowS).state).toBe("sent");
      // The real actor answered its own reading through its stub from inside its safety work (no deadlock: not noAnswer).
      expect(to.answers).toEqual([false]);
      expect(to.spans.filter((span) => span.hop === "dispatch")).toEqual([
        expect.objectContaining({
          outcome: "ok",
          decided: expect.objectContaining({ result: "sent", actorReading: "notStopped" }) as unknown,
        }),
      ]);
      expect(await safetyOf(rig, S)).toMatchObject({
        state: "done",
        path: "outbox",
        lineId: "outage",
        handedAfterMs: 4000,
      });
      // Nothing else ran: no turn (S's unread hold keeps its batch back), so no commit and no park; nothing went straight
      // through Linq; and the test made no run.
      expect(await rig.actor.readTurns()).toEqual([]);
      expect(rig.f.direct.sent).toEqual([]);

      // A later run for the recipient finds nothing to send.
      expect((await runDispatch(to.deps(), { recipientHandleId: SAM_HANDLE_ID })).claimed).toBe(0);
      expect(to.linq.requests).toHaveLength(1);
    });

    it.each(["the chat lookup", "the claim's renewal"] as const)(
      "row S behind T-1337's hold: a STOP the actor takes while its writer's own run waits on %s is read by the ask right before the send, so nothing is sent and row S is dropped as stopped",
      async (during) => {
        const to = sends();
        const rig = await downRigFor(SAM, [], 99, true, {}, joined(to));
        writeRows(rig, to);
        to.heldAt = during;
        await text(rig, S, false);
        expect(await stubSays()).toBe(false);
        await rig.tick(4000);
        await until(() => to.reached, `the writer's run at ${during}`);
        // The STOP lands while the writer's run waits; its read gives no verdict, so it waits uncommitted.
        await text(rig, STOP, false);
        expect(await stubSays()).toBe(true);

        to.runGate.closed = false;
        await lineDecided(rig, S);
        // The line was decided when the wake started (DL-679: never awaited); the run ends once it goes on.
        await until(() => to.ended === 1, "the writer's run's end");

        expect(to.woken).toEqual([{ handleId: SAM_HANDLE_ID, outboxRowIds: [rowSOf(S)] }]);
        expect(to.claims).toEqual([SAM_HANDLE_ID]);
        droppedOnTheActorsWord(to, [rowSOf(S)]);
        expect(await safetyOf(rig, S)).toMatchObject({ state: "done", path: "outbox", lineId: "outage" });
      },
    );

    /**
     * A text's safety read held while `gate` is closed: no verdict in 4 s; once the gate opens, a verdict with danger
     * (safety-emergency-now.json, under the text's own event id) as its late answer.
     */
    function lateDangerFor(rig: DownRig, eventId: string, gate: Hold): void {
      const late = fakeRead(rig.f.clock, {
        [eventId]: { ...(safetyEmergencyNow as unknown as SafetyResult), eventId },
      });
      const read = rig.h.read.read.bind(rig.h.read);
      rig.h.read.read = async (request) => {
        if (request.eventId !== eventId) return read(request);
        await gate.wait();
        return late.read(request);
      };
    }

    it("row S's wake is started, never awaited (DL-679; RULES 4.12): a text read as another text gets no verdict in 4 s, and its outage line's row is written and its writer's wake started while that run is held; its verdict then comes late, with danger, and the danger line's handling (sendDanger's record and safety row, the danger's hold in place of the unread one, the open batch closed for danger and handed on) completes while the run is still held; then the run sends row S once", async () => {
      const to = sends();
      // B is read as No at once; S's read gives no verdict in 4 s, and answers with danger once `verdict` opens.
      const rig = await downRigFor(SAM, [B], 99, true, {}, joined(to));
      writeRows(rig, to);
      const verdict = hold(true);
      lateDangerFor(rig, S, verdict);
      // The writer's run waits at its chat lookup, after its claim; the turn the danger's batch opens waits in decide.
      to.heldAt = "the chat lookup";
      rig.ai.decideHold.closed = true;
      await text(rig, S, false);
      // B comes 2 s on, so the batch window (3 s after the latest text) is still open at S's 4 s deadline.
      await rig.tick(2000);
      await text(rig, B, false);
      await lineDecided(rig, B);
      expect((await rig.actor.readOutage()).texts).toEqual([
        expect.objectContaining({ eventId: S, kind: "other" }),
        expect.objectContaining({ eventId: B, kind: "other" }),
      ]);
      expect(await stubSays()).toBe(false);

      // 4 s from S's arrival, the timeout rule writes row S through the core and its writer starts the wake, whose run
      // claims the row and waits at the chat lookup. The line's result is kept meanwhile: nothing waited for the run.
      await rig.tick(2000);
      await until(() => to.reached, "the writer's run at the chat lookup");
      await lineDecided(rig, S);
      const rowS = rowSOf(S);
      expect(to.written).toEqual([rowS]);
      expect(to.woken).toEqual([{ handleId: SAM_HANDLE_ID, outboxRowIds: [rowS] }]);
      expect(to.claims).toEqual([SAM_HANDLE_ID]);
      expect(await safetyOf(rig, S)).toMatchObject({
        state: "done",
        danger: false,
        path: "outbox",
        lineId: "outage",
        handedAfterMs: 4000,
      });
      expect(await rig.actor.readHolds()).toEqual([
        { eventId: S, holdId: null, rule: "unread", blocksBooking: false, released: false },
      ]);
      expect((await rig.actor.readBatches()).at(-1)).toMatchObject({ reason: null, eventIds: [S, B] });

      // S's verdict comes now, late, with danger, while the writer's run is still held.
      verdict.closed = false;
      await until(() => rig.ai.decideCalls.length === 1, "the turn the danger's batch opens");

      // sendDanger: the core recorded the danger at once, and its safety line's row (send class safety) is written.
      expect(
        rig.f.core.recorded.map((call) => [
          call.at,
          call.request.safety.eventId,
          "error" in call.response ? null : (call.response.safetyLine?.fixedLineId ?? null),
        ]),
      ).toEqual([[4000, S, "safetyEmergency"]]);
      expect(to.written).toEqual([rowS, `out-${S}`]);
      expect(await safetyOf(rig, S)).toMatchObject({
        state: "done",
        danger: true,
        path: "outbox",
        lineId: "safetyEmergency",
        handedAfterMs: 4000,
      });
      // The unread hold is lifted: the danger's own hold is in its place.
      expect(await rig.actor.readHolds()).toMatchObject([
        { eventId: S, holdId: `hold-${S}`, rule: "after_safe", released: false },
      ]);
      // The batch close for danger: the open window closed at once and went to the lease, whose turn waits in decide.
      expect(await rig.actor.readBatches()).toMatchObject([
        { reason: "danger", handed: true, eventIds: [S, B] },
      ]);
      expect(await rig.actor.readTurns()).toMatchObject([{ eventIds: [S, B], state: "leased" }]);
      // All of it while the writer's run is still held: nothing has gone to Linq, and row S is still claimed by it.
      expect(to.ended).toBe(0);
      expect(to.linq.requests).toEqual([]);
      expect(to.store.row(rowS).state).toBe("sending");
      expect(to.claims).toEqual([SAM_HANDLE_ID]);

      // The run goes on: the actor's reading still says false (both texts read as other), so row S goes once.
      to.runGate.closed = false;
      await until(() => to.ended === 1, "the writer's run's end");
      expect(
        to.linq.requests.map((request) => [request.idempotencyKey, request.text, request.overrideOptout]),
      ).toEqual([[`${rowS}/1/1`, OUTAGE_TEXT, false]]);
      expect(to.store.row(rowS).state).toBe("sent");
      expect(to.answers).toEqual([false]);

      // The turn's held decide answers (the models down), so nothing is left waiting when the test ends; what that run
      // asks for and sends is not this test's claim.
      rig.ai.decideHold.closed = false;
      await until(() => rig.o.waits.length === 1, "the turn's run's wait");
    });

    it.each([
      ["the writer's wake throws", true],
      ["no wake is joined", false],
    ] as const)(
      "row S, a failed wake: %s, so the line's result stands (path outbox, its hand-off time, not lineFailed, nothing straight through Linq) and row S stays sendable; the recipient's next run sends it once",
      async (_how, wired) => {
        const to = sends();
        to.wakeFails = 1;
        const rig = await downRigFor(SAM, [], 99, true, {}, wired ? joined(to) : { ids: SAM_IDS });
        writeRows(rig, to);
        await text(rig, S, false);
        await rig.tick(4000);
        await rig.actor.safetyIdle();

        const rowS = rowSOf(S);
        expect(to.woken).toEqual(wired ? [{ handleId: SAM_HANDLE_ID, outboxRowIds: [rowS] }] : []);
        expect(to.claims).toEqual([]);
        expect(to.linq.requests).toEqual([]);
        expect(to.store.row(rowS).state).toBe("checked");
        expect(await safetyOf(rig, S)).toMatchObject({
          state: "done",
          path: "outbox",
          lineId: "outage",
          handedAfterMs: 4000,
        });
        expect(rig.f.direct.sent).toEqual([]);

        // The recipient's next run (here the root's wake for a commit) sends it once: the reading says exactly false.
        await runBy(to, "the root's wake", rowS);

        expect(to.linq.requests.map((request) => request.idempotencyKey)).toEqual([`${rowS}/1/1`]);
        expect(to.store.row(rowS).state).toBe("sent");
        expect(to.answers).toEqual([false]);
      },
    );

    it("a repeated answer to the safety read's outage line names a row an earlier ask wrote: the writer wakes it all the same, and it goes once", async () => {
      const to = sends();
      const rig = await downRigFor(SAM, [], 99, true, {}, joined(to));
      writeRows(rig, to);
      // The core wrote the row at an earlier ask (writeRows), and answers this one repeated, naming it.
      const send = rig.f.core.sendFixedLine.bind(rig.f.core);
      rig.f.core.sendFixedLine = async (request) => {
        const answer = await send(request);
        return "error" in answer ? answer : { ...answer, repeated: true };
      };
      await text(rig, S, false);
      await rig.tick(4000);
      await rig.actor.safetyIdle();

      expect(to.woken).toEqual([{ handleId: SAM_HANDLE_ID, outboxRowIds: [rowSOf(S)] }]);
      expect(to.linq.requests.map((request) => request.idempotencyKey)).toEqual([`${rowSOf(S)}/1/1`]);
      expect(await safetyOf(rig, S)).toMatchObject({ state: "done", path: "outbox", lineId: "outage" });
    });

    it("row A, the boundary: a text read as another text, whose turn's decide answers modelsDown, gets its outage line's row sent once by the try's own wake, before the clock reaches the try's start plus 30 s; nothing else runs", async () => {
      const to = sends();
      const rig = await downRigFor(SAM, [A], 99, true, {}, joined(to));
      writeRows(rig, to);
      await text(rig, A);
      expect(await stubSays()).toBe(false);

      await rig.tick(3000);
      await until(() => rig.o.waits.length === 1, "the try's wait");

      expect(rig.decidedAt).toEqual([3000]);
      expect(rig.f.clock.now()).toBeLessThan(3000 + RETRY_MS);
      expect(to.written).toEqual([rowOf(A)]);
      expect(rig.o.wakes).toEqual([{ handleId: SAM_HANDLE_ID, outboxRowIds: [rowOf(A)] }]);
      expect(to.claims).toEqual([SAM_HANDLE_ID]);
      expect(to.linq.requests.map((request) => [request.idempotencyKey, request.text])).toEqual([
        [`${rowOf(A)}/1/1`, OUTAGE_TEXT],
      ]);
      expect(to.store.row(rowOf(A)).state).toBe("sent");
      expect(to.answers).toEqual([false]);
      // Nothing else ran: the turn is still leased (no commit, no park), and the test made no run.
      expect(rig.face.gateCalls).toEqual([]);
      expect(await rig.actor.readTurns()).toMatchObject([{ eventIds: [A], state: "leased", tries: 1 }]);
    });

    it("row A, a repeated answer: the first try's wake throws, so row A waits; the lease's lapse reruns the turn, the core answers repeated with row A's id, and the rerun's wake sends it once; nothing is sent twice", async () => {
      const to = sends();
      to.wakeFails = 1;
      const rig = await downRigFor(SAM, [A], 99, true, {}, joined(to));
      writeRows(rig, to);
      await text(rig, A);

      // The first try writes row A; its wake throws, and nothing claims the row.
      await rig.tick(3000);
      await until(() => rig.o.waits.length === 1, "the first try's wait");
      expect(to.written).toEqual([rowOf(A)]);
      expect(to.claims).toEqual([]);
      expect(to.linq.requests).toEqual([]);
      expect(to.store.row(rowOf(A)).state).toBe("checked");

      // The next try at 33 s asks for no line (A's is done for the run); the lease lapses at 63 s and reruns the turn,
      // which asks for A's line again: K-09 answers repeated with row A, and the rerun's wake sends it.
      await rig.tick(RETRY_MS);
      await until(() => rig.decidedAt.length === 2, "the second try");
      await rig.tick(RETRY_MS);
      await until(() => rig.o.waits.length === 2, "the rerun's wait");
      expect(rig.decidedAt).toEqual([3000, 33_000, 63_000]);
      expect(rig.o.lines.requests.map((sent) => [sent.at, sent.request.caller.requestId])).toEqual([
        [3000, `safety:${A}`],
        [63_000, `safety:${A}`],
      ]);
      expect(to.written).toEqual([rowOf(A)]);
      expect(rig.o.wakes).toEqual([
        { handleId: SAM_HANDLE_ID, outboxRowIds: [rowOf(A)] },
        { handleId: SAM_HANDLE_ID, outboxRowIds: [rowOf(A)] },
      ]);
      expect(to.claims).toEqual([SAM_HANDLE_ID]);
      expect(to.linq.requests.map((request) => request.idempotencyKey)).toEqual([`${rowOf(A)}/1/1`]);
      expect(to.answers).toEqual([false]);

      // A later run for the recipient finds nothing more to send.
      expect((await runDispatch(to.deps(), { recipientHandleId: SAM_HANDLE_ID })).claimed).toBe(0);
      expect(to.linq.requests).toHaveLength(1);
    });

    it("unchanged: with PostgreSQL down, the safety read's outage line goes straight through Linq, writes no row and wakes nothing", async () => {
      const to = sends();
      const rig = await downRigFor(SAM, [], 99, true, {}, joined(to));
      writeRows(rig, to);
      await text(rig, S, false);
      rig.f.down = true;
      await rig.tick(4000);
      await rig.actor.safetyIdle();

      expect(rig.f.direct.sent.map((sent) => [sent.fixedLineId, sent.overrideOptout])).toEqual([
        ["outage", false],
      ]);
      expect(to.written).toEqual([]);
      expect(to.woken).toEqual([]);
      expect(to.claims).toEqual([]);
      expect(await safetyOf(rig, S)).toMatchObject({ state: "done", path: "outage", lineId: "outage" });
    });
  });

  // ---- T-1352: the danger line's row is woken by its writer at once, on a safety run nothing holds back or gates --------

  describe("T-1352 (DL-687, DL-698; K-05 v1.14 item 67): the danger line's row is woken by its writer at once, never gated and never awaited, on a safety run of the real dispatcher that no other row's claim, plan or hold holds back, so it reaches Linq within its 5 s; a run's safety rows go first (RULES 4.12; RULES 7.2: the run takes nothing a STOP binds)", () => {
    /** The danger line's row the core writes for a text's danger (the safety read's core double: `out-<event id>`). */
    const dangerRowOf = (eventId: string): string => `out-${eventId}`;
    /** Sam's routine row, written by an earlier commit. */
    const ROUTINE = "out-sam-routine";

    /** Both writers' wakes joined to the rig as the root joins them: SafetyDeps.wake and SafetyDeps.wakeSafety. */
    const bothWakes = (
      to: Sends,
    ): {
      ids: HandleIds;
      wake: (request: OutageWake) => Promise<void>;
      wakeSafety: (request: OutageWake) => Promise<void>;
    } => ({
      ids: SAM_IDS,
      wake: (request) => to.wake(request),
      wakeSafety: (request) => to.wakeSafety(request),
    });

    /** A verdict with danger under a text's own event id: safety-emergency-now.json, or the fixture given. */
    const dangerOf = (eventId: string, fixture: unknown = safetyEmergencyNow): SafetyResult => ({
      ...(fixture as SafetyResult),
      eventId,
    });

    /** A text's safety read held while `gate` is closed; once it opens, `result` is its answer (on time, or late). */
    function readHeld(rig: DownRig, eventId: string, gate: Hold, result: SafetyResult): void {
      const answer = fakeRead(rig.f.clock, { [eventId]: result });
      const read = rig.h.read.read.bind(rig.h.read);
      rig.h.read.read = async (request) => {
        if (request.eventId !== eventId) return read(request);
        await gate.wait();
        return answer.read(request);
      };
    }

    /** Each claim the outbox double answered, in order: its class (null: every class) and the rows it took. */
    const claimsOf = (to: Sends): unknown[] =>
      to.store.claims.map((claim) => [claim.request.sendClass ?? null, claim.took]);

    /** Each part Linq was handed, in order: its key, and whether it went past an opt-out. */
    const linqOf = (to: Sends): unknown[] =>
      to.linq.requests.map((request) => [request.idempotencyKey, request.overrideOptout]);

    /** When each part reached Linq, on the actor's fake clock. */
    function reachedLinqAt(rig: DownRig, to: Sends): Map<string, number> {
      const reached = new Map<string, number>();
      to.linq.beforeAnswer = (request) => {
        reached.set(request.idempotencyKey, rig.f.clock.now());
        return Promise.resolve();
      };
      return reached;
    }

    /**
     * The turn a danger's batch opens waits in decide while a test runs (its decides held), so its models-down run asks for
     * no outage line meanwhile; at the end its held decides answer, and what that run asks for is not the test's claim.
     */
    async function endTurns(rig: DownRig): Promise<void> {
      rig.ai.decideHold.closed = false;
      if ((await rig.actor.readTurns()).some((turn) => turn.state === "leased")) {
        await until(() => rig.o.waits.length >= 1, "the turn's run's wait");
      }
    }

    /**
     * Makes the actor's storage refuse, once, the write of the core's hold for a text (writeHold's insert naming the core's
     * hold id), as a storage that throws there does: the danger stays open and is read again 30 s on (ADR-018 section 2).
     */
    async function refuseCoreHold(eventId: string): Promise<() => number> {
      let refused = 0;
      await runInDurableObject(stubOf(SAM), (_, state) => {
        const { sql } = state.storage;
        const run = sql.exec.bind(sql);
        const faulted = (
          query: string,
          ...bindings: SqlStorageValue[]
        ): SqlStorageCursor<Record<string, SqlStorageValue>> => {
          if (
            refused === 0 &&
            query.includes("INSERT OR REPLACE INTO safety_holds") &&
            bindings.includes(`hold-${eventId}`)
          ) {
            refused += 1;
            throw new Error("the storage refused");
          }
          return run(query, ...bindings);
        };
        vi.spyOn(sql, "exec").mockImplementation(faulted);
      });
      return () => refused;
    }

    /** Linq's reported failure of a part (K-11 refused, a status): its next try goes under a new key (K-07 rule 1). */
    const REPORTED: LinqFailed = {
      result: "failed",
      kind: "refused",
      httpStatus: 500,
      code: "500",
      reason: "a reported failure",
      retryAfterSeconds: null,
      providerMessageId: null,
    };

    /**
     * Case 1's start (DL-679; T-1341 round 2's text): S, read as another text, gets no verdict in 4 s, so its timeout rule
     * writes row S through the core and its writer's wake's run claims it and waits at S's own renewal, a point no other run
     * reaches; B, read as No 2 s after S, keeps the batch window open at S's deadline. The turn the danger's batch opens
     * waits in decide. Returns the gate of S's late verdict, a danger.
     */
    async function rowSHeld(rig: DownRig, to: Sends): Promise<Hold> {
      writeRows(rig, to);
      const verdict = hold(true);
      readHeld(rig, S, verdict, dangerOf(S));
      to.heldRenewalOf = rowSOf(S);
      rig.ai.decideHold.closed = true;
      await text(rig, S, false);
      await rig.tick(2000);
      await text(rig, B, false);
      await lineDecided(rig, B);
      expect(await stubSays()).toBe(false);
      await rig.tick(2000);
      await until(() => to.reached, "row S's run at S's renewal");
      await lineDecided(rig, S);
      expect(to.written).toEqual([rowSOf(S)]);
      expect(claimsOf(to)).toEqual([[null, [rowSOf(S)]]]);
      return verdict;
    }

    it("case 1 (DL-679): with row S's run holding S's live claim at S's own renewal, S's verdict comes late with danger at 4000: the danger line's row D goes at once on its own safety run, which took D alone past S's claim, the clock not moved past 4000 (S's arrival + 5000), with no reading asked; S is still sending under its run's claim; the danger's record, its hold in place of the unread one, the batch closed for danger and the leased turn are as T-1341 round 2 has them; then S goes once, after D, and a later run sends nothing more", async () => {
      const to = sends();
      const rig = await downRigFor(SAM, [B], 99, true, {}, bothWakes(to));
      const reached = reachedLinqAt(rig, to);
      const verdict = await rowSHeld(rig, to);
      const rowS = rowSOf(S);
      const rowD = dangerRowOf(S);

      verdict.closed = false;
      await until(() => to.dangerEnded === 1, "the danger run's end");

      expect(rig.f.clock.now()).toBe(4000);
      expect(to.written).toEqual([rowS, rowD]);
      expect(to.dangerWoken).toEqual([{ handleId: SAM_HANDLE_ID, outboxRowIds: [rowD] }]);
      expect(claimsOf(to)).toEqual([
        [null, [rowS]],
        ["safety", [rowD]],
      ]);
      expect(linqOf(to)).toEqual([[`${rowD}/1/1`, false]]);
      expect(reached.get(`${rowD}/1/1`)).toBe(4000);
      expect(to.store.row(rowD).state).toBe("sent");
      expect(to.store.row(rowS)).toMatchObject({ state: "sending", claim: { claimNo: 1 } });
      expect(to.answers).toEqual([]);

      await until(() => rig.ai.decideCalls.length === 1, "the turn the danger's batch opens");
      expect(
        rig.f.core.recorded.map((call) => [
          call.at,
          call.request.safety.eventId,
          "error" in call.response ? null : (call.response.safetyLine?.fixedLineId ?? null),
        ]),
      ).toEqual([[4000, S, "safetyEmergency"]]);
      expect(await safetyOf(rig, S)).toMatchObject({
        state: "done",
        danger: true,
        path: "outbox",
        lineId: "safetyEmergency",
        handedAfterMs: 4000,
      });
      expect(await rig.actor.readHolds()).toMatchObject([
        { eventId: S, holdId: `hold-${S}`, rule: "after_safe", released: false },
      ]);
      expect(await rig.actor.readBatches()).toMatchObject([
        { reason: "danger", handed: true, eventIds: [S, B] },
      ]);
      expect(await rig.actor.readTurns()).toMatchObject([{ eventIds: [S, B], state: "leased" }]);

      // S's run goes on: the reading says exactly false (both texts read as other), so S's part goes once, after D's.
      to.runGate.closed = false;
      await until(() => to.ended === 1, "row S's run's end");
      expect(linqOf(to)).toEqual([
        [`${rowD}/1/1`, false],
        [`${rowS}/1/1`, false],
      ]);
      expect(to.store.row(rowS).state).toBe("sent");
      expect(to.answers).toEqual([false]);
      expect((await runDispatch(to.deps(), { recipientHandleId: SAM_HANDLE_ID })).claimed).toBe(0);
      expect(to.linq.requests).toHaveLength(2);

      await endTurns(rig);
    });

    it("case 1's variant (never awaited, DL-679): with D's Linq answer held too, the danger's handling completes while D's run is out: the record, the hold in place of the unread hold (lifted), the batch closed for danger and handed on, the leased turn; the actor's safety work is idle only once D's run ends, after which S goes", async () => {
      const to = sends();
      const rig = await downRigFor(SAM, [B], 99, true, {}, bothWakes(to));
      const verdict = await rowSHeld(rig, to);
      const rowS = rowSOf(S);
      const rowD = dangerRowOf(S);
      const answerD = hold(true);
      to.linq.beforeAnswer = async (request) => {
        if (request.idempotencyKey === `${rowD}/1/1`) await answerD.wait();
      };

      verdict.closed = false;
      await until(() => rig.ai.decideCalls.length === 1, "the turn the danger's batch opens");

      // D's part is with Linq, its answer held, and its run is not over: the danger's handling did not wait for it.
      expect(linqOf(to)).toEqual([[`${rowD}/1/1`, false]]);
      expect(to.dangerEnded).toBe(0);
      expect(to.store.row(rowD).state).toBe("sending");
      expect(await safetyOf(rig, S)).toMatchObject({
        state: "done",
        danger: true,
        path: "outbox",
        lineId: "safetyEmergency",
        handedAfterMs: 4000,
      });
      expect(await rig.actor.readHolds()).toMatchObject([
        { eventId: S, holdId: `hold-${S}`, rule: "after_safe", released: false },
      ]);
      expect(await rig.actor.readBatches()).toMatchObject([
        { reason: "danger", handed: true, eventIds: [S, B] },
      ]);
      expect(await rig.actor.readTurns()).toMatchObject([{ eventIds: [S, B], state: "leased" }]);

      // S's run goes on and sends S; D's run is still out, so the actor's safety work is not idle until it ends.
      to.runGate.closed = false;
      await until(() => to.ended === 1, "row S's run's end");
      let idle = false;
      const idling = rig.actor.safetyIdle().then(() => {
        idle = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(idle).toBe(false);
      answerD.closed = false;
      await idling;
      expect(to.dangerEnded).toBe(1);
      expect(to.store.row(rowD).state).toBe("sent");
      expect(linqOf(to)).toEqual([
        [`${rowD}/1/1`, false],
        [`${rowS}/1/1`, false],
      ]);

      await endTurns(rig);
    });

    it.each(["before D is written", "after D went"] as const)(
      "case 2, a STOP that may wait: as case 1, with a STOP taken %s while row S's run is held, stored and read as a stop but not committed (no commit, limit 8's flag clear), and the deps' stopped flag set too: D still goes at once, with no gate and no reading asked; on release the reading answers true, S is dropped as stopped, and Linq holds D's part alone; T-1337's three later runs send nothing",
      async (when) => {
        const to = sends();
        // No text here but S gets a verdict: the STOP's read gives none, so its unread hold keeps it from any turn.
        const rig = await downRigFor(SAM, [], 99, true, {}, bothWakes(to));
        writeRows(rig, to);
        const verdict = hold(true);
        readHeld(rig, S, verdict, dangerOf(S));
        const rowS = rowSOf(S);
        const rowD = dangerRowOf(S);
        to.heldRenewalOf = rowS;
        rig.ai.decideHold.closed = true;
        await text(rig, S, false);
        expect(await stubSays()).toBe(false);
        await rig.tick(4000);
        await until(() => to.reached, "row S's run at S's renewal");
        await lineDecided(rig, S);
        const stopWaits = async (): Promise<void> => {
          await text(rig, STOP, false);
          expect((await rig.actor.readOutage()).texts).toContainEqual(
            expect.objectContaining({ eventId: STOP, kind: "stop" }),
          );
          expect(await stubSays()).toBe(true);
          expect(rig.face.gateCalls).toEqual([]);
          rig.h.stopped.value = true;
        };
        if (when === "before D is written") await stopWaits();

        verdict.closed = false;
        await until(() => to.dangerEnded === 1, "the danger run's end");
        expect(to.dangerWoken).toEqual([{ handleId: SAM_HANDLE_ID, outboxRowIds: [rowD] }]);
        expect(linqOf(to)).toEqual([[`${rowD}/1/1`, false]]);
        expect(to.answers).toEqual([]);
        if (when === "after D went") await stopWaits();

        to.runGate.closed = false;
        await until(() => to.ended === 1, "row S's run's end");
        expect(to.store.row(rowS).state).toBe("dropped_stopped");
        expect(to.answers).toEqual([true]);
        expect(linqOf(to)).toEqual([[`${rowD}/1/1`, false]]);
        for (const how of RUNS) await runBy(to, how, rowS);
        expect(linqOf(to)).toEqual([[`${rowD}/1/1`, false]]);
        expect(rig.face.gateCalls).toEqual([]);

        await endTurns(rig);
      },
    );

    it.each([
      ["checked and not claimed", {}],
      ["held for text hours and due now", { heldUntil: "2026-10-19T14:00:00.000Z" }],
    ] as const)(
      "case 3, nothing a STOP binds rides the danger wake: with a routine row %s and a STOP waiting, not committed, a danger verdict's row D is woken and goes alone; the routine row stays as it was, unread",
      async (_how, routine) => {
        const to = sends();
        // The STOP's read gives no verdict, so its unread hold keeps it from any turn: stored, read as a stop, uncommitted.
        const rig = await downRigFor(SAM, [], 99, true, DANGER_VERDICT, bothWakes(to));
        writeRows(rig, to);
        rig.ai.decideHold.closed = true;
        to.write({
          id: ROUTINE,
          recipient: SAM_HANDLE_ID,
          sendClass: "routine",
          fixedLines: [],
          ...routine,
        });
        const before = { state: to.store.row(ROUTINE).state, version: to.store.row(ROUTINE).version };
        await text(rig, STOP, false);
        expect((await rig.actor.readOutage()).texts).toContainEqual(
          expect.objectContaining({ eventId: STOP, kind: "stop" }),
        );
        expect(await stubSays()).toBe(true);

        // The danger text, its verdict on time: polled, as the STOP's own read keeps the safety work from being idle.
        await text(rig, DANGER, false);
        await until(() => to.dangerEnded === 1, "the danger run's end");

        expect(rig.face.gateCalls).toEqual([]);
        const rowD = dangerRowOf(DANGER);
        expect(to.dangerWoken).toEqual([{ handleId: SAM_HANDLE_ID, outboxRowIds: [rowD] }]);
        expect(claimsOf(to)).toEqual([["safety", [rowD]]]);
        expect(linqOf(to)).toEqual([[`${rowD}/1/1`, false]]);
        expect(to.store.row(ROUTINE)).toMatchObject({ ...before, claim: null });
        expect(to.state.reads).toEqual([rowD, rowD]);
        expect(to.answers).toEqual([]);

        await endTurns(rig);
      },
    );

    it("case 4: an earlier routine row's reported failure left it sending under a live claim, its retry job queued and no run in flight; a danger verdict at 1500 writes D, which reaches Linq at 1500, before its text's arrival + 5000; the routine row's claim and its job are untouched", async () => {
      const to = sends();
      const rig = await downRigFor(SAM, [], 99, true, {}, bothWakes(to));
      writeRows(rig, to);
      rig.ai.decideHold.closed = true;
      to.write({ id: ROUTINE, recipient: SAM_HANDLE_ID, sendClass: "routine", fixedLines: [] });
      to.linq.failures.set(`${ROUTINE}/1/1`, REPORTED);
      const jobs: string[] = [];
      const failed = await runDispatch(
        {
          ...to.deps(),
          retries: {
            schedule: (plan) => {
              jobs.push(plan.job.key);
              return Promise.resolve("queued");
            },
          },
        },
        { recipientHandleId: SAM_HANDLE_ID },
      );
      expect(failed.rows.map((row) => [row.outboxRowId, row.outcome, row.retry?.scheduled])).toEqual([
        [ROUTINE, "failed", "queued"],
      ]);
      expect(jobs).toEqual([`retry-${ROUTINE}/1/1#1`]);
      expect(to.store.row(ROUTINE)).toMatchObject({ state: "sending", claim: { claimNo: 1 } });
      const claim = structuredClone(to.store.row(ROUTINE).claim);
      const reached = reachedLinqAt(rig, to);

      // A danger text arrives at 0; its verdict comes at 1500, with danger.
      const verdict = hold(true);
      readHeld(rig, DANGER, verdict, dangerOf(DANGER));
      await text(rig, DANGER, false);
      await rig.tick(1500);
      verdict.closed = false;
      await until(() => to.dangerEnded === 1, "the danger run's end");

      const rowD = dangerRowOf(DANGER);
      expect(claimsOf(to)).toEqual([
        [null, [ROUTINE]],
        ["safety", [rowD]],
      ]);
      expect(linqOf(to)).toEqual([
        [`${ROUTINE}/1/1`, false],
        [`${rowD}/1/1`, false],
      ]);
      expect(reached.get(`${rowD}/1/1`)).toBe(1500);
      expect(to.store.row(rowD).state).toBe("sent");
      expect(to.store.row(ROUTINE)).toMatchObject({ state: "sending", claim });
      expect(jobs).toHaveLength(1);

      await endTurns(rig);
    });

    it("case 5: a run of every class whose claim took [R, S, D] (the danger line's own wake not joined, so D waited) sends D first, then R and S in commit order; only S is asked", async () => {
      const to = sends();
      const rig = await downRigFor(SAM, [], 99, true, DANGER_VERDICT, {
        ids: SAM_IDS,
        wake: (request) => to.wake(request),
      });
      writeRows(rig, to);
      rig.ai.decideHold.closed = true;
      to.write({ id: ROUTINE, recipient: SAM_HANDLE_ID, sendClass: "routine", fixedLines: [] });
      to.write({
        id: rowOf(A),
        recipient: SAM_HANDLE_ID,
        sendClass: "quick_reply",
        fixedLines: [OUTAGE_LINE_ID],
      });
      await text(rig, DANGER);
      const rowD = dangerRowOf(DANGER);
      expect(to.written).toEqual([ROUTINE, rowOf(A), rowD]);
      expect(to.claims).toEqual([]);
      expect(await stubSays()).toBe(false);

      await runBy(to, "the root's wake", rowD);

      expect(claimsOf(to)).toEqual([[null, [ROUTINE, rowOf(A), rowD]]]);
      expect(linqOf(to)).toEqual([
        [`${rowD}/1/1`, false],
        [`${ROUTINE}/1/1`, false],
        [`${rowOf(A)}/1/1`, false],
      ]);
      expect(to.answers).toEqual([false]);

      await endTurns(rig);
    });

    it.each([
      ["the danger wake throws at the call", "throws"],
      ["the danger wake's run rejects", "rejects"],
      ["no danger wake is joined", null],
    ] as const)(
      "case 6, a failed wake: %s, so the line's result stands (path outbox, its hand-off time), its hold is written and released at once as before, nothing goes to Linq or straight through it, and D stays checked; the recipient's next run sends D once",
      async (_how, fails) => {
        const to = sends();
        const rig = await downRigFor(
          SAM,
          [],
          99,
          true,
          { [DANGER]: dangerOf(DANGER, safetyChildOrElder) },
          fails === null ? { ids: SAM_IDS, wake: (request) => to.wake(request) } : bothWakes(to),
        );
        writeRows(rig, to);
        rig.ai.decideHold.closed = true;
        if (fails !== null) to.dangerWakeFails.push(fails);

        await text(rig, DANGER);

        const rowD = dangerRowOf(DANGER);
        expect(to.written).toEqual([rowD]);
        expect(to.dangerWoken).toEqual(
          fails === null ? [] : [{ handleId: SAM_HANDLE_ID, outboxRowIds: [rowD] }],
        );
        expect(to.claims).toEqual([]);
        expect(to.linq.requests).toEqual([]);
        expect(to.store.row(rowD).state).toBe("checked");
        expect(await safetyOf(rig, DANGER)).toMatchObject({
          state: "done",
          danger: true,
          path: "outbox",
          lineId: "outcomeLine",
          handedAfterMs: 0,
        });
        expect(await rig.actor.readHolds()).toMatchObject([
          { eventId: DANGER, holdId: `hold-${DANGER}`, rule: "at_once", released: true },
        ]);
        expect(rig.f.core.released.map((release) => release.holdId)).toEqual([`hold-${DANGER}`]);
        expect(rig.f.direct.sent).toEqual([]);

        await runBy(to, "the root's wake", rowD);

        expect(linqOf(to)).toEqual([[`${rowD}/1/1`, false]]);
        expect(to.store.row(rowD).state).toBe("sent");

        await endTurns(rig);
      },
    );

    it("case 7, a repeated answer: the core's hold write is refused the first time, so the danger stays open and its re-read 30 s on applies it again; the core answers repeated, naming D, and its writer wakes D again; Linq gets D's part once in all", async () => {
      const to = sends();
      const rig = await downRigFor(SAM, [], 99, true, DANGER_VERDICT, bothWakes(to));
      writeRows(rig, to);
      rig.ai.decideHold.closed = true;
      const refused = await refuseCoreHold(DANGER);
      const rowD = dangerRowOf(DANGER);
      const woken = { handleId: SAM_HANDLE_ID, outboxRowIds: [rowD] };

      await text(rig, DANGER);

      expect(refused()).toBe(1);
      expect(to.dangerWoken).toEqual([woken]);
      expect(linqOf(to)).toEqual([[`${rowD}/1/1`, false]]);
      expect(await safetyOf(rig, DANGER)).toMatchObject({ state: "lineFailed", danger: true });

      await rig.tick(30_000);
      await until(() => to.dangerEnded === 2, "the second danger run's end");

      expect(rig.f.core.recorded.map((call) => call.request.caller.requestId)).toEqual([
        `safety:${DANGER}`,
        `safety:${DANGER}`,
      ]);
      expect(to.written).toEqual([rowD]);
      expect(to.dangerWoken).toEqual([woken, woken]);
      expect(claimsOf(to)).toEqual([
        ["safety", [rowD]],
        ["safety", []],
      ]);
      expect(linqOf(to)).toEqual([[`${rowD}/1/1`, false]]);
      await until(() => to.store.row(rowD).state === "sent", "D sent");

      await endTurns(rig);
    });

    it("case 8, the run's guards: a transient safety claim is repeated, and D goes", async () => {
      const to = sends();
      const rig = await downRigFor(SAM, [], 99, true, DANGER_VERDICT, bothWakes(to));
      writeRows(rig, to);
      rig.ai.decideHold.closed = true;
      to.store.transientClaims = 2;

      await text(rig, DANGER);

      const rowD = dangerRowOf(DANGER);
      expect(claimsOf(to)).toEqual([
        ["safety", "transient"],
        ["safety", "transient"],
        ["safety", [rowD]],
      ]);
      expect(linqOf(to)).toEqual([[`${rowD}/1/1`, false]]);

      await endTurns(rig);
    });

    it("case 8, the run's guards: a store or wrapper that drops the field hands back a routine row with D; D goes, and the routine row is never read or sent, its claim left to lapse (RULES 7.2: fails closed)", async () => {
      const to = sends();
      const rig = await downRigFor(SAM, [], 99, true, DANGER_VERDICT, bothWakes(to));
      writeRows(rig, to);
      rig.ai.decideHold.closed = true;
      to.write({ id: ROUTINE, recipient: SAM_HANDLE_ID, sendClass: "routine", fixedLines: [] });
      to.dropsSendClass = true;

      await text(rig, DANGER);

      const rowD = dangerRowOf(DANGER);
      expect(claimsOf(to)).toEqual([[null, [ROUTINE, rowD]]]);
      expect(linqOf(to)).toEqual([[`${rowD}/1/1`, false]]);
      expect(to.state.reads).toEqual([rowD, rowD]);
      expect(to.store.row(ROUTINE)).toMatchObject({ state: "sending", claim: { claimNo: 1 } });
      expect(to.store.rowMarks).toEqual([]);
      expect(to.spans.filter((span) => span.hop === "dispatch")).toEqual([
        expect.objectContaining({ outcome: "ok", rows: [{ table: "outbox_rows", id: rowD }] }),
        expect.objectContaining({
          outcome: "refused",
          decided: expect.objectContaining({ result: "storeError" }) as unknown,
          error_code: "notSafetyClass",
          rows: [{ table: "outbox_rows", id: ROUTINE }],
        }),
      ]);

      await endTurns(rig);
    });

    it("the architect's case 5, other blockers: a turn's planned row and ten checked routine rows written before D: D is claimed and sent, and none of them is read", async () => {
      const to = sends();
      const rig = await downRigFor(SAM, [], 99, true, DANGER_VERDICT, bothWakes(to));
      writeRows(rig, to);
      rig.ai.decideHold.closed = true;
      to.write({
        id: "out-sam-planned",
        recipient: SAM_HANDLE_ID,
        sendClass: "routine",
        fixedLines: [],
        planned: true,
      });
      for (let n = 1; n <= 10; n += 1) {
        to.write({
          id: `${ROUTINE}-${String(n)}`,
          recipient: SAM_HANDLE_ID,
          sendClass: "routine",
          fixedLines: [],
        });
      }

      await text(rig, DANGER);

      const rowD = dangerRowOf(DANGER);
      expect(claimsOf(to)).toEqual([["safety", [rowD]]]);
      expect(linqOf(to)).toEqual([[`${rowD}/1/1`, false]]);
      expect(to.state.reads).toEqual([rowD, rowD]);
      expect(to.store.row("out-sam-planned").state).toBe("planned");
      expect(to.store.row(`${ROUTINE}-10`).state).toBe("checked");

      await endTurns(rig);
    });
  });
});
