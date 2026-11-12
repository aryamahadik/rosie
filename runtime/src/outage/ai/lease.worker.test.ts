// The AI provider down inside the real actor (T-271), run inside the Workers runtime: each text goes through the gateway's
// door, the real safety read on arrival, the real batch window, the real turn lease (T-248: a 60 s lease, a lapse reruns
// the turn) and the real bundle pin, whose `runTurn` is the turn loop's own (`turnHooks`), through the AI-down path.
// Doubles: the turn's ports (../../turn/test-support.ts) answering the K-09 and K-02 fixtures with the running turn's own
// ids, a decide fake that answers the AI gateway's typed `modelsDown` (no live model call, J-02), the safety read's
// doubles (../../safety/test-support.ts) on whose fake clock the actor, the lease and the 30 s retries all run, and K-09's
// sendFixedLine for the outage line (./test-support.ts). Test method: T-1128's. Test values only (rule 9).
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import buildFrontierS102 from "../../../../contracts/tool-api/fixtures/build-frontier-s1-02.json";
import commitS102 from "../../../../contracts/tool-api/fixtures/commit-s1-02.json";
import decideS102 from "../../../../contracts/model/fixtures/decide-s1-02-choose.json";
import {
  setBatchHooks,
  setBundleDeps,
  setLeaseHooks,
  setSafetyDeps,
  turnIdOf,
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
import type { SafetyDeps } from "../../safety/types";
import { setDbOutageDeps, type OutageView } from "../db";
import { dbFakes } from "../db/test-support";
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

describe("the AI-down path inside the real lease", () => {
  it("a turn the models are down for runs again every 30 s, across the lease's lapse, and commits once when they are back; each waiting text is told once", async () => {
    const rig = rigFor(SAM, ["evt-sam-0001", "evt-sam-0002"], 3);
    await arrive(SAM, "evt-sam-0001", "Barbershop, plumbing, electrical", "2026-10-19T14:05:00Z");
    await arrive(SAM, "evt-sam-0002", "and lawn care", "2026-10-19T14:05:01Z");
    await actorOf(SAM).safetyIdle();

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
