// PostgreSQL down (T-270; C-175; arch 11 'PostgreSQL down', architecture.txt line 566), run inside the Workers runtime. Each
// text goes through the gateway's door into the real handle actor: the real safety read on arrival, batch window, turn
// lease (60 s; a lapse reruns the turn, a third parks it), bundle pin, the actor's copies and write-on-return queue (T-269),
// and the down path itself. The data-access fake fails as PostgreSQL unreachable (./test-support.ts): the probe, K-09's
// shared core, K-05's bundle reads and the turn's commit through the lease. The actor's clock, the safety read's and the
// stored schedule's are one fake clock; the platform's alarm is run at each step. Test method: T-1128's. Test values only:
// the master's sample cast (Sam), the frozen fixtures' ids, phones in the fictional 555-01xx range (rule 9).
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import fixedLines from "../../../../contracts/bundle/fixtures/fixed-lines.json";
import pollVote from "../../../../contracts/inbound-event/fixtures/poll-vote.json";
import safetyEmergencyNow from "../../../../contracts/model/fixtures/safety-emergency-now.json";
import {
  setBatchHooks,
  setBundleDeps,
  setCopyDeps,
  setLeaseHooks,
  setSafetyDeps,
  turnIdOf,
  type BatchEntry,
  type CommitTurnRequest,
  type CopiesView,
  type HandleActor,
  type LeasedTurn,
  type ReplayReport,
  type SafetyEntry,
  type TurnEntry,
} from "../../actor";
import type { ActorCopies } from "../../actor/copies/copies";
import type { LeaseHost } from "../../actor/lease";
import { SAM_TIMER } from "../../actor/copies/test-support";
import type { BundleId } from "../../bundle";
import {
  BUNDLE_A,
  BUNDLE_B,
  keyIn,
  textAt,
  WHOLE_A,
  WHOLE_B,
  type WholeBundle,
} from "../../bundle/test-support";
import {
  actorNameOf,
  durableObjectActor,
  prepareHandoff,
  type ActorNamespace,
  type HandleActorRpc,
} from "../../gateway";
import { fakeKeyStore } from "../../gateway/test-support";
import { keywordsOf } from "../../guard/keywords";
import { Q01_DRAFTED } from "../../guard/replies/words";
import type { Keyword } from "../../guard/types";
import type { SafetyResult } from "../../safety/types";
import { SAM, hold, safetyNoFor, storedText, until, type Hold } from "../../turn/test-support";
import {
  OUTAGE_WAIT_MS,
  PROBE_MS,
  setDbOutageDeps,
  TIMER_RETRY_MS,
  type DbOutage,
  type OutageView,
} from "./index";
import { dbFakes, idsOf, type DbFakes } from "./test-support";

const TRACE = "11111111-2222-4333-8444-555555555555";
const BUNDLE = { hash: "a".repeat(64), build: 1 };
const SAM_ACTOR = actorNameOf(SAM.handle);
const keys = fakeKeyStore();
const restores: (() => void)[] = [];

/** K-01's outage line, word for word (fixed-lines.json). */
const OUTAGE_TEXT = fixedLines.lines.find((line) => line.id === "outage")?.text ?? "";

/** The test's start: Tuesday Oct 27, 2026, 10:00am in New York (any instant; the timer test starts nearer its due time). */
const START = Date.parse("2026-10-27T14:00:00Z");

const PRIME = "evt-sam-0400";
const R1 = "evt-sam-0401";
const D1 = "evt-sam-0402";
const S1 = "evt-sam-0403";
const R2 = "evt-sam-0404";

afterEach(async () => {
  while (restores.length > 0) restores.pop()?.();
  await reset();
});

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

function stub(): DurableObjectStub<HandleActor> {
  return namespace().get(namespace().idFromName(SAM_ACTOR));
}

/** The actor's calls over RPC, typed here. */
interface Rpc {
  readCopies(): Promise<CopiesView>;
  readOutage(): Promise<OutageView>;
  readTurns(): Promise<TurnEntry[]>;
  readBatches(): Promise<BatchEntry[]>;
  readWaitingBatches(): Promise<number[]>;
  readSafety(): Promise<SafetyEntry[]>;
  writeOnReturn(): Promise<ReplayReport>;
  outageIdle(): Promise<void>;
  safetyIdle(): Promise<void>;
  batchIdle(): Promise<void>;
}

/** The commit a turn of Sam's sends through its lease: the turn, with Sam's K-04 handle id (K-05 v1 turn). */
function samCommit(turn: LeasedTurn): CommitTurnRequest {
  return {
    turn: {
      id: turn.turnId,
      handleId: SAM.party.handleId,
      eventIds: turn.eventIds,
      bundleId: { hash: turn.bundleId.hash, build: turn.bundleId.build },
      traceId: turn.traceId,
      joinedTraceIds: turn.joinedTraceIds,
      tries: turn.tries,
    },
    versionsRead: [],
    writes: null,
  };
}

interface Rig {
  readonly f: DbFakes;
  readonly actor: Rpc;
  /**
   * A text of Sam's arrives through the gateway's door, sealed under his key; the actor's lent work settles, unless
   * `settle` is false (a text whose read waits for its 4 s deadline on the fake clock: the next tick settles it).
   */
  arrive(eventId: string, body: string, settle?: boolean): Promise<void>;
  /** The fake clock moves, then the alarm runs, as the platform would at the stored time; the lent work settles. */
  tick(ms: number): Promise<void>;
  settle(): Promise<void>;
}

/**
 * Sam's handle in the real actor: its turns commit once through the lease (T-269's Tool API double) while PostgreSQL
 * answers, the safety read answers `answers`, and the down path is wired, all on one fake clock from `start`.
 */
function rigFor(answers: Record<string, SafetyResult>, start = START): Rig {
  const f = dbFakes(keys, answers, { start, ids: idsOf(SAM.party) });
  restores.push(
    setSafetyDeps(f.safetyDeps),
    setBatchHooks({ clock: f.clock }),
    setLeaseHooks({
      runTurn: async (turn) => {
        await turn.commit(samCommit(turn));
      },
      commit: (request, at) => f.commit(request, at),
    }),
    setBundleDeps(f.bundleDeps),
    setCopyDeps({ timers: f.api.source }),
    setDbOutageDeps(f.outageDeps),
  );
  const actor = stub() as unknown as Rpc;
  const rig: Rig = {
    f,
    actor,
    async arrive(eventId, body, settle = true) {
      const entry = await storedText(
        { eventId, body, sentAt: new Date(f.clock.now()).toISOString(), traceId: TRACE },
        SAM.handle,
        keys,
        BUNDLE,
        0,
      );
      const handoff = {
        event: entry.event,
        partKey: null,
        traceId: TRACE,
        bundleId: BUNDLE,
        actorName: SAM_ACTOR,
      };
      expect(await door().accept(handoff)).toBe("written");
      if (settle) await rig.settle();
    },
    async tick(ms) {
      await f.clock.advance(ms);
      await runDurableObjectAlarm(stub());
      await rig.settle();
    },
    async settle() {
      for (let round = 0; round < 3; round += 1) {
        await actor.safetyIdle();
        await actor.outageIdle();
        await actor.batchIdle();
      }
    },
  };
  return rig;
}

/** While PostgreSQL answers, a first text's turn pins bundle A (the actor copies its keyword list) and commits. */
async function prime(rig: Rig): Promise<void> {
  await rig.arrive(PRIME, "Test words: can I get a cut this week?");
  await rig.tick(3000);
  await until(() => rig.f.log.includes(`commit:${PRIME}`), "the first turn's commit", 10_000);
  await rig.settle();
  rig.f.log.length = 0;
}

/** The outage lines Linq was asked to send, as sent. */
const outageSends = (rig: Rig): DbFakes["direct"]["sent"] =>
  rig.f.direct.sent.filter((send) => send.fixedLineId === "outage");

const emergencyFor = (eventId: string): SafetyResult => ({
  ...(safetyEmergencyNow as unknown as SafetyResult),
  eventId,
});

describe("PostgreSQL down: a routine text gets the outage line once at 20 s", () => {
  it("with the data-access fake failing, a text waiting 20 s gets the outage line once, from the actor's copy, straight through Linq, and no second one however long it stays down", async () => {
    const rig = rigFor({ [PRIME]: safetyNoFor(PRIME), [R1]: safetyNoFor(R1) });
    await prime(rig);
    rig.f.down = true;
    const arrivedAt = rig.f.clock.now();
    await rig.arrive(R1, "Test words: can I come Friday at 3?");

    // The batch closes at 3 s and goes to the lease: the turn cannot pin its bundle, and nothing is sent yet.
    await rig.tick(3000);
    expect(rig.f.direct.sent).toEqual([]);
    expect(rig.f.probes).toEqual([]);

    // At 20 s the text has waited with no commit: PostgreSQL is asked, does not answer, and the outage line goes once.
    await rig.tick(OUTAGE_WAIT_MS - 3000);
    expect(rig.f.probes).toEqual([arrivedAt + OUTAGE_WAIT_MS]);
    expect(outageSends(rig)).toEqual([
      {
        actorName: SAM_ACTOR,
        fixedLineId: "outage",
        text: OUTAGE_TEXT,
        overrideOptout: false,
        idempotencyKey: `safety:${R1}:outage`,
        at: arrivedAt + OUTAGE_WAIT_MS,
      },
    ]);
    expect((await rig.actor.readOutage()).down).toEqual({
      since: arrivedAt + OUTAGE_WAIT_MS,
      nextProbe: arrivedAt + OUTAGE_WAIT_MS + PROBE_MS,
    });

    // Two more minutes down: asked again every 30 s, and still one line. The turn is held as it is: its lease's lapse
    // counts no try and parks nothing (turns queue in order).
    for (let step = 0; step < 4; step += 1) await rig.tick(PROBE_MS);
    expect(outageSends(rig)).toHaveLength(1);
    expect(rig.f.probes).toEqual([1, 2, 3, 4, 5].map((k) => arrivedAt + OUTAGE_WAIT_MS + (k - 1) * PROBE_MS));
    const turns = await rig.actor.readTurns();
    expect(turns.map((turn) => [turn.eventIds, turn.state, turn.tries])).toEqual([
      [[PRIME], "committed", 1],
      [[R1], "leased", 1],
    ]);

    // Its record waits for the return in the rest rank, as the K-09 request T-271 builds for the text.
    expect((await rig.actor.readCopies()).returns).toEqual([
      expect.objectContaining({ key: `sendFixedLine:${R1}`, call: "sendFixedLine", rank: "rest", tries: 0 }),
    ]);
    expect((await rig.actor.readOutage()).texts).toEqual([
      expect.objectContaining({ eventId: R1, kind: "other", line: "sent" }),
    ]);
  });

  it("a text the safety read's timeout rule gave the outage line already gets no second one at 20 s", async () => {
    // No verdict in 4 s for R1 and no danger word: the safety read sends the outage line itself, straight through Linq.
    const rig = rigFor({ [PRIME]: safetyNoFor(PRIME) });
    await prime(rig);
    rig.f.down = true;
    await rig.arrive(R1, "Test words: can I come Friday at 3?", false);
    await rig.tick(4000);
    expect(outageSends(rig).map((send) => send.idempotencyKey)).toEqual([`safety:${R1}:outage`]);

    await rig.tick(OUTAGE_WAIT_MS);
    await rig.tick(PROBE_MS);

    expect(outageSends(rig)).toHaveLength(1);
    expect((await rig.actor.readOutage()).texts).toEqual([
      expect.objectContaining({ eventId: R1, line: "went" }),
    ]);
  });
});

describe("PostgreSQL down: safety and STOP lines go from the actor", () => {
  it("a danger text still gets its safety line within 5 s of arrival, straight through Linq; its record waits in the danger rank", async () => {
    const rig = rigFor({ [PRIME]: safetyNoFor(PRIME), [D1]: emergencyFor(D1) });
    await prime(rig);
    rig.f.down = true;
    const arrivedAt = rig.f.clock.now();
    await rig.arrive(D1, "Test words: a client's cut won't stop bleeding");

    const safetyLines = rig.f.direct.sent.filter((send) => send.fixedLineId !== "outage");
    expect(safetyLines).toEqual([
      expect.objectContaining({
        actorName: SAM_ACTOR,
        fixedLineId: "safetyEmergency",
        overrideOptout: true,
        idempotencyKey: `safety:${D1}:safetyEmergency`,
      }),
    ]);
    expect((safetyLines[0]?.at ?? Infinity) - arrivedAt).toBeLessThanOrEqual(5000);
    expect(rig.f.core.recorded).toEqual([]);
    expect((await rig.actor.readCopies()).returns).toEqual([
      expect.objectContaining({ key: `recordSafetyOutcome:${D1}`, rank: "danger" }),
    ]);
  });

  it("a STOP still gets its reply and the flag: taken at once, its record waits in the stop rank, and no text after it gets the outage line", async () => {
    const rig = rigFor({ [PRIME]: safetyNoFor(PRIME), [S1]: safetyNoFor(S1), [R2]: safetyNoFor(R2) });
    await prime(rig);
    rig.f.down = true;
    const arrivedAt = rig.f.clock.now();
    await rig.arrive(S1, "Stop");

    // Read as a STOP by the pinned bundle's list (the actor's copy), PostgreSQL asked and not answering: the reply goes at
    // once, past the opt-out, in Q-01's drafted words while Jay's wait (bundle A's stopReply has none yet).
    expect(rig.f.probes).toEqual([arrivedAt]);
    expect(rig.f.direct.sent).toEqual([
      {
        actorName: SAM_ACTOR,
        fixedLineId: "stopReply",
        text: Q01_DRAFTED.stopReply,
        overrideOptout: true,
        idempotencyKey: `keyword:${S1}:stopReply`,
        at: arrivedAt,
      },
    ]);
    const copies = await rig.actor.readCopies();
    expect(copies.stopped).toMatchObject({ stopped: true, phoneVersion: null });
    expect(copies.returns).toEqual([
      expect.objectContaining({ key: `recordStopOrStart:${S1}`, call: "recordStopOrStart", rank: "stop" }),
    ]);

    // A text after it waits 20 s and gets no outage line: never to a stopped number.
    await rig.arrive(R2, "Test words: wait, can I still come at 3?");
    await rig.tick(OUTAGE_WAIT_MS);
    expect(rig.f.direct.sent).toHaveLength(1);
    expect((await rig.actor.readOutage()).texts).toEqual([
      expect.objectContaining({ eventId: S1, kind: "stop", keyword: "handled" }),
      expect.objectContaining({ eventId: R2, kind: "other", line: "stopped" }),
    ]);
    // Their batch waits with the batch window: no turn opens while PostgreSQL is down.
    expect((await rig.actor.readTurns()).map((turn) => turn.eventIds)).toEqual([[PRIME]]);
  });

  it("a safety timer due during the outage fires from the copy once: its due time, sealed address and contact, as copied; alerts that cannot go are tried again 5 s on", async () => {
    const due = Date.parse(SAM_TIMER.due_at);
    const rig = rigFor({ [PRIME]: safetyNoFor(PRIME) }, due - 10 * 60_000);
    rig.f.api.writes.push(structuredClone(SAM_TIMER));
    await prime(rig);
    const copied = (await rig.actor.readCopies()).timers;
    expect(copied.map((timer) => [timer.timerId, timer.state, timer.dueAt])).toEqual([
      [SAM_TIMER.id, "running", SAM_TIMER.due_at],
    ]);
    rig.f.down = true;
    rig.f.timers.fail = 1;

    // Due while PostgreSQL is down: fired from the copy at once; the first try does not go, and the next goes 5 s on.
    await rig.tick(due + 1000 - rig.f.clock.now());
    expect(rig.f.timers.fired).toEqual([]);
    await rig.tick(TIMER_RETRY_MS);
    expect(rig.f.timers.fired).toEqual([
      {
        at: due + 1000 + TIMER_RETRY_MS,
        request: { actorName: SAM_ACTOR, requestId: `timer:${SAM_TIMER.id}:1`, timer: copied[0] },
      },
    ]);
    // The address went as K-34 seals it, never opened by the actor.
    expect(rig.f.timers.fired[0]?.request.timer.address).toBe(SAM_TIMER.address);
    await rig.tick(PROBE_MS);
    await rig.tick(PROBE_MS);
    expect(rig.f.timers.fired).toHaveLength(1);
    expect((await rig.actor.readOutage()).timers).toEqual([
      { timerId: SAM_TIMER.id, version: 1, fired: "copy" },
    ]);
  });

  it("a timer due while PostgreSQL answers is left to the core's clock row: nothing fires from the copy, then or later", async () => {
    const due = Date.parse(SAM_TIMER.due_at);
    const rig = rigFor({ [PRIME]: safetyNoFor(PRIME) }, due - 10 * 60_000);
    rig.f.api.writes.push(structuredClone(SAM_TIMER));
    await prime(rig);

    // Due while PostgreSQL answers: the core's clock row fires the miss, so nothing fires from the copy, then or later.
    await rig.tick(due + 1000 - rig.f.clock.now());
    rig.f.down = true;
    await rig.tick(PROBE_MS);
    expect(rig.f.timers.fired).toEqual([]);
    expect((await rig.actor.readOutage()).timers).toEqual([
      { timerId: SAM_TIMER.id, version: 1, fired: "core" },
    ]);
  });
});

describe("no newer word ahead of an older one", () => {
  it("a STOP that went to its turn before the outage was known stays its turn's: a later START is left to its turn too, and no outage line goes while the STOP waits, the safety read's included; on return the turns commit them in order", async () => {
    const START_EVENT = "evt-sam-0405";
    const R3 = "evt-sam-0406";
    const rig = rigFor({
      [PRIME]: safetyNoFor(PRIME),
      [S1]: safetyNoFor(S1),
      [START_EVENT]: safetyNoFor(START_EVENT),
      [R2]: safetyNoFor(R2),
    });
    await prime(rig);
    // The STOP arrives while PostgreSQL answers: it goes to its turn, as any text does.
    await rig.arrive(S1, "STOP");
    expect((await rig.actor.readOutage()).texts).toEqual([
      expect.objectContaining({ eventId: S1, kind: "stop", keyword: "left" }),
    ]);
    // PostgreSQL goes down before the STOP's turn can commit: its batch is with the lease already.
    rig.f.down = true;
    await rig.tick(3000);
    await rig.arrive(START_EVENT, "START");
    await rig.arrive(R2, "Test words: can I still come at 3?");
    await rig.tick(OUTAGE_WAIT_MS);
    // No verdict for R3 in 4 s and no danger word: the safety read's timeout rule would send the outage line, but the
    // number's STOP waits with its turn, so none goes.
    await rig.arrive(R3, "Test words: hello?", false);
    await rig.tick(4000);

    // Nothing is taken ahead of the STOP its turn holds: no START reply, no record queued, the copy not touched, and no
    // outage line to a number whose STOP is not written yet.
    expect(rig.f.direct.sent).toEqual([]);
    expect(rig.f.core.fixed).toEqual([]);
    const copies = await rig.actor.readCopies();
    expect(copies.returns).toEqual([]);
    expect(copies.stopped?.stopped ?? false).toBe(false);
    expect((await rig.actor.readOutage()).texts).toEqual([
      expect.objectContaining({ eventId: S1, keyword: "left" }),
      expect.objectContaining({ eventId: START_EVENT, kind: "start", keyword: "left" }),
      expect.objectContaining({ eventId: R2, kind: "other", line: "stopped" }),
      expect.objectContaining({ eventId: R3, kind: "other", line: null }),
    ]);

    // Back: the turns commit the STOP, then the START, in arrival order.
    rig.f.down = false;
    await rig.tick(PROBE_MS);
    await until(
      () => rig.f.log.some((call) => call.startsWith("commit:") && call.includes(R2)),
      "the queued turns' commits",
      10_000,
    );
    const committed = rig.f.log
      .filter((call) => call.startsWith("commit:"))
      .flatMap((call) => call.slice("commit:".length).split("+"));
    expect(committed).toEqual([S1, START_EVENT, R2]);
    expect(rig.f.stops).toEqual([]);
  });
});

describe("STOP and START taken by the actor, in arrival order", () => {
  it("a START after a STOP whose reply did not go yet waits for it: the replies go, and the records are queued and written, in arrival order, so the last word decides", async () => {
    const START_EVENT = "evt-sam-0405";
    const rig = rigFor({
      [PRIME]: safetyNoFor(PRIME),
      [S1]: safetyNoFor(S1),
      [START_EVENT]: safetyNoFor(START_EVENT),
    });
    await prime(rig);
    rig.f.down = true;
    // Linq does not take the stop reply at first: the STOP is taken (the flag copied) and its reply tried again 5 s on.
    rig.f.direct.fail = true;
    await rig.arrive(S1, "STOP");
    await rig.arrive(START_EVENT, "START");
    expect((await rig.actor.readCopies()).stopped).toMatchObject({ stopped: true });
    expect((await rig.actor.readOutage()).texts).toEqual([
      expect.objectContaining({ eventId: S1, keyword: "handling" }),
      expect.objectContaining({ eventId: START_EVENT, kind: "start", keyword: null }),
    ]);

    // Linq takes sends again: the STOP's reply and record go first, then the START is taken after it.
    rig.f.direct.fail = false;
    await rig.tick(5000);
    expect(rig.f.direct.sent.map((send) => send.idempotencyKey)).toEqual([
      `keyword:${S1}:stopReply`,
      `keyword:${START_EVENT}:startReply`,
    ]);
    expect(rig.f.direct.sent.map((send) => send.overrideOptout)).toEqual([true, false]);
    const copies = await rig.actor.readCopies();
    expect(copies.stopped).toMatchObject({ stopped: false, phoneVersion: null });
    expect(copies.returns.map((entry) => [entry.rank, entry.key])).toEqual([
      ["stop", `recordStopOrStart:${S1}`],
      ["stop", `recordStopOrStart:${START_EVENT}`],
    ]);

    // Back: the STOP is written, then the START; the copy takes the last one's phone version, and texts are on.
    rig.f.down = false;
    await rig.tick(PROBE_MS);
    expect(rig.f.stops.map((stop) => [stop.kind, stop.inboundEventId])).toEqual([
      ["stop", S1],
      ["start", START_EVENT],
    ]);
    expect((await rig.actor.readCopies()).stopped).toMatchObject({ stopped: false, phoneVersion: 5 });
    // Neither joins a turn: their records hold them, and no reply goes twice.
    expect(rig.f.log.filter((call) => call.startsWith("commit:"))).toEqual([]);
    expect(rig.f.direct.sent).toHaveLength(2);
  });
});

describe("a live turn's commit waits for the write-on-return queue (QUESTIONS.md CQ-104 (f))", () => {
  it("a danger record queued in a blip is written before the turn's commit; while the core does not take it, the commit is not sent", async () => {
    const rig = rigFor({ [PRIME]: safetyNoFor(PRIME), [D1]: emergencyFor(D1) });
    await prime(rig);
    // The down path's own checks off (unwired): only the commit's own replay is at work here.
    restores.push(setDbOutageDeps(null));
    // A blip: the safety read's record and the first replay of it fail; everything else answers.
    rig.f.failRecords = 2;
    await rig.arrive(D1, "Test words: a client's cut won't stop bleeding");

    // The danger line went straight through Linq; the turn ran at once, but its commit was kept back.
    expect(rig.f.direct.sent.map((send) => send.fixedLineId)).toEqual(["safetyEmergency"]);
    expect(rig.f.log).toEqual([]);
    expect((await rig.actor.readCopies()).returns).toEqual([
      expect.objectContaining({ key: `recordSafetyOutcome:${D1}`, rank: "danger", tries: 1 }),
    ]);

    // The lease's lapse reruns the turn: the queue goes first, then the commit.
    await rig.tick(60_000);
    await until(() => rig.f.log.includes(`commit:${D1}`), "the rerun's commit", 10_000);
    expect(rig.f.log).toEqual([`recordSafetyOutcome:${D1}`, `commit:${D1}`]);
    expect((await rig.actor.readCopies()).returns).toEqual([]);
  });
});

describe("on return: danger first, then stops, then the rest, each write once", () => {
  it("the queued work replays danger, then stops, then the rest, across every queued turn and before any of them commits; the turns then commit in arrival order, and each write lands once", async () => {
    const rig = rigFor({
      [PRIME]: safetyNoFor(PRIME),
      [R1]: safetyNoFor(R1),
      [D1]: emergencyFor(D1),
      [S1]: safetyNoFor(S1),
      [R2]: safetyNoFor(R2),
    });
    await prime(rig);
    rig.f.down = true;

    // A routine text: its batch goes to the lease (the outage not known yet); at 20 s it gets the outage line.
    await rig.arrive(R1, "Test words: can I come Friday at 3?");
    await rig.tick(3000);
    await rig.tick(OUTAGE_WAIT_MS - 3000);
    // Then, in arrival order: a danger text (its safety line at once), a STOP (taken by the actor) and a routine text.
    await rig.arrive(D1, "Test words: a client's cut won't stop bleeding");
    await rig.arrive(S1, "STOP");
    await rig.arrive(R2, "Test words: also, is parking free?");
    await rig.tick(OUTAGE_WAIT_MS);
    // R1's lease lapses meanwhile: held, with no try counted.
    await rig.tick(2 * PROBE_MS);
    expect(rig.f.log).toEqual([]);
    expect(rig.f.direct.sent.map((send) => send.idempotencyKey)).toEqual([
      `safety:${R1}:outage`,
      `safety:${D1}:safetyEmergency`,
      `keyword:${S1}:stopReply`,
    ]);
    expect((await rig.actor.readCopies()).returns.map((entry) => [entry.rank, entry.key])).toEqual([
      ["danger", `recordSafetyOutcome:${D1}`],
      ["stop", `recordStopOrStart:${S1}`],
      ["rest", `sendFixedLine:${R1}`],
    ]);

    // PostgreSQL is back: the next ask finds it, and the queue goes first.
    rig.f.down = false;
    await rig.tick(PROBE_MS);
    await until(
      () => rig.f.log.some((call) => call.startsWith("commit:") && call.includes(R2)),
      "the queued turns' commits",
      10_000,
    );
    await rig.settle();

    const records = rig.f.log.filter((call) => !call.startsWith("commit:"));
    expect(records).toEqual([
      `recordSafetyOutcome:${D1}`,
      `recordStopOrStart:${S1}`,
      `sendFixedLine:safety:${R1}`,
    ]);
    const firstCommit = rig.f.log.findIndex((call) => call.startsWith("commit:"));
    expect(firstCommit).toBe(records.length);
    // The queued turns commit in arrival order, each text once; the STOP the actor took joins none.
    const committed = rig.f.log.slice(firstCommit).flatMap((call) => call.slice("commit:".length).split("+"));
    expect(committed).toEqual([R1, D1, R2]);

    // Each write landed once: the STOP record as start-recorded.json's shape, the actor's flag taking its phone version.
    expect(rig.f.stops).toEqual([
      {
        caller: {
          kind: "actorOnReturn",
          turnId: null,
          requestId: S1,
          businessId: null,
          personId: SAM.party.personId,
          traceId: TRACE,
        },
        kind: "stop",
        phoneNumber: SAM.handle.address,
        inboundEventId: S1,
        words: "STOP",
        alsoCancelVisit: false,
        workPhoneBusinessIds: null,
        sentByActor: { at: expect.any(String) as string, fixedLineId: "stopReply", linqMessageId: "linq-3" },
      },
    ]);
    expect(rig.f.core.fixed.map((sent) => sent.request)).toEqual([
      expect.objectContaining({
        caller: expect.objectContaining({ kind: "actorOnReturn", requestId: `safety:${R1}` }) as unknown,
        fixedLineId: "outage",
        recipientHandleId: SAM.party.handleId,
        sendClass: "quick_reply",
        sentByActor: expect.objectContaining({ fixedLineId: "outage", linqMessageId: "linq-1" }) as unknown,
      }),
    ]);
    expect(await rig.actor.writeOnReturn()).toEqual({ written: 0, refused: 0, left: 0 });
    const copies = await rig.actor.readCopies();
    expect(copies.returns).toEqual([]);
    expect(copies.stopped).toMatchObject({ stopped: true, phoneVersion: 4 });
    expect((await rig.actor.readOutage()).down).toBeNull();
    // The held turn ran again with the try it had.
    expect((await rig.actor.readTurns()).find((turn) => turn.eventIds.join() === R1)?.tries).toBe(1);
    expect(rig.f.direct.sent).toHaveLength(3);
  });
});

describe("on return, only the answer for the STOP note's own text replaces it (T-1208, DL-431)", () => {
  const FIRST_STOP = "evt-sam-0410";
  const START_TEXT = "evt-sam-0411";
  const LAST_STOP = "evt-sam-0412";
  const WAITING = "evt-sam-0413";
  const UNREAD = "evt-sam-0414";
  const LATER_START = "evt-sam-0415";

  const anyTime = expect.any(Number) as number;
  /** The actor's own STOP note: stopped, with no version (its record waits in the write-on-return queue). */
  const NOTE = { stopped: true, phoneVersion: null, turnId: null, setAt: anyTime };

  /** The STOP and START records the core took, in order: kind and text. */
  const recorded = (rig: Rig): [string, string][] =>
    rig.f.stops.map((stop) => [stop.kind, stop.inboundEventId]);

  /** A read of Sam's phone row sent now, as the actor's copies send one (T-1206's re-read), inside the actor. */
  const readPhoneRow = (): Promise<string> =>
    runInDurableObject(stub(), (instance) =>
      (instance as unknown as { copies: ActorCopies }).copies.rereadStopped(SAM.party.handleId),
    );

  const notBackWays: { way: string; fail: (f: DbFakes) => void }[] = [
    { way: "the core throws", fail: (f) => f.stopFails.set(LAST_STOP, "throw") },
    { way: "the core answers transient", fail: (f) => f.stopFails.set(LAST_STOP, "transient") },
    {
      way: "the key store throws",
      // The replay reads the handle's key for each record in turn: it answers for START's, and not for STOP's.
      fail: (f) => f.keyReads.push(true, false),
    },
  ];

  it.each(notBackWays)(
    "START then STOP in one outage; on return START's record is written and STOP's answers notBack ($way): the flag stays stopped, no outage line goes (the down path's or the safety read's), and a read of the phone row sent then never replaces the note; STOP's record, written on the next ask, replaces it and the flag stays stopped by version; a read sent after that ends it",
    async ({ fail }) => {
      const rig = rigFor({
        [PRIME]: safetyNoFor(PRIME),
        [START_TEXT]: safetyNoFor(START_TEXT),
        [LAST_STOP]: safetyNoFor(LAST_STOP),
        [WAITING]: safetyNoFor(WAITING),
      });
      // The copies' read of the phone row (T-1206) reaches the Tool API double's row of Sam's phone.
      restores.push(setCopyDeps({ timers: rig.f.api.source, phones: rig.f.api.phones }));
      await prime(rig);
      rig.f.down = true;
      await rig.arrive(START_TEXT, "START");
      await rig.arrive(LAST_STOP, "STOP");

      // Both taken by the actor at once, in arrival order: replied to, their records queued in the stop rank, the STOP's
      // note copied last.
      expect(rig.f.direct.sent.map((send) => send.idempotencyKey)).toEqual([
        `keyword:${START_TEXT}:startReply`,
        `keyword:${LAST_STOP}:stopReply`,
      ]);
      let copies = await rig.actor.readCopies();
      expect(copies.returns.map((entry) => [entry.rank, entry.key])).toEqual([
        ["stop", `recordStopOrStart:${START_TEXT}`],
        ["stop", `recordStopOrStart:${LAST_STOP}`],
      ]);
      expect(copies.stopped).toEqual(NOTE);

      // PostgreSQL answers again. The replay writes START's record (v4), whose answer is for another text, and STOP's
      // answers notBack: the replay stops there, and PostgreSQL is still known down while a stop write waits.
      fail(rig.f);
      rig.f.down = false;
      await rig.tick(PROBE_MS);
      expect(recorded(rig)).toEqual([["start", START_TEXT]]);
      copies = await rig.actor.readCopies();
      expect(copies.stopped).toEqual(NOTE);
      expect(copies.returns).toEqual([
        expect.objectContaining({ key: `recordStopOrStart:${LAST_STOP}`, tries: 1, refused: null }),
      ]);
      expect((await rig.actor.readOutage()).down).not.toBeNull();

      // A read of the phone row sent now finds the START (v4): the note's own record is not written yet, so it stays.
      rig.f.api.phone.stopped = false;
      rig.f.api.phone.version = 4;
      expect(await readPhoneRow()).toBe("older");
      expect((await rig.actor.readCopies()).stopped).toEqual(NOTE);

      // A text waits 20 s, and another gets no verdict in 4 s: no outage line goes to the number whose last word is STOP,
      // neither the down path's nor the safety read's timeout rule's (through the core, which answers again).
      await rig.arrive(WAITING, "Test words: wait, can I still come at 3?");
      await rig.tick(3000);
      await rig.arrive(UNREAD, "Test words: hello?", false);
      await rig.tick(4000);
      await rig.tick(OUTAGE_WAIT_MS - 7000);
      expect(outageSends(rig)).toEqual([]);
      expect(rig.f.core.fixed).toEqual([]);
      expect((await rig.actor.readOutage()).texts).toEqual([
        expect.objectContaining({ eventId: START_TEXT, kind: "start", keyword: "handled" }),
        expect.objectContaining({ eventId: LAST_STOP, kind: "stop", keyword: "handled" }),
        expect.objectContaining({ eventId: WAITING, kind: "other", line: "stopped" }),
        expect.objectContaining({ eventId: UNREAD, kind: "other", line: null }),
      ]);
      expect((await rig.actor.readCopies()).stopped).toEqual(NOTE);

      // The next ask, 30 s on: STOP's record is written now (v5), and its answer, for the note's own text, replaces the
      // note. The flag stays stopped, by version.
      await rig.tick(PROBE_MS - OUTAGE_WAIT_MS);
      expect(recorded(rig)).toEqual([
        ["start", START_TEXT],
        ["stop", LAST_STOP],
      ]);
      copies = await rig.actor.readCopies();
      expect(copies.returns).toEqual([]);
      expect(copies.stopped).toEqual({ stopped: true, phoneVersion: 5, turnId: null, setAt: anyTime });
      expect(outageSends(rig)).toEqual([]);
      expect(rig.f.core.fixed).toEqual([]);

      // A read sent after it finds Sam's START (v6, written since): taken by its version, it ends the stop.
      rig.f.api.phone.version = 6;
      expect(await readPhoneRow()).toBe("copied");
      expect((await rig.actor.readCopies()).stopped).toEqual({
        stopped: false,
        phoneVersion: 6,
        turnId: null,
        setAt: anyTime,
      });
    },
  );

  it("the queue [STOP, START, STOP]: on return the first STOP's answer and START's answer never replace the note, so the flag reads stopped while the last STOP's record waits; the last STOP's own answer does, stopped by version; a later turn's START ends it", async () => {
    const rig = rigFor({
      [PRIME]: safetyNoFor(PRIME),
      [FIRST_STOP]: safetyNoFor(FIRST_STOP),
      [START_TEXT]: safetyNoFor(START_TEXT),
      [LAST_STOP]: safetyNoFor(LAST_STOP),
      [WAITING]: safetyNoFor(WAITING),
      [LATER_START]: safetyNoFor(LATER_START),
    });
    await prime(rig);
    rig.f.down = true;
    await rig.arrive(FIRST_STOP, "STOP");
    await rig.arrive(START_TEXT, "START");
    await rig.arrive(LAST_STOP, "STOP");
    expect(rig.f.direct.sent.map((send) => send.idempotencyKey)).toEqual([
      `keyword:${FIRST_STOP}:stopReply`,
      `keyword:${START_TEXT}:startReply`,
      `keyword:${LAST_STOP}:stopReply`,
    ]);
    let copies = await rig.actor.readCopies();
    expect(copies.returns.map((entry) => [entry.rank, entry.key])).toEqual([
      ["stop", `recordStopOrStart:${FIRST_STOP}`],
      ["stop", `recordStopOrStart:${START_TEXT}`],
      ["stop", `recordStopOrStart:${LAST_STOP}`],
    ]);
    expect(copies.stopped).toEqual(NOTE);

    // Back: the replay writes the first STOP's record (v4) and START's (v5); the core answers transient for the last
    // STOP's. Neither answer is for the note's own text, whatever its kind or version: the flag still reads stopped.
    rig.f.stopFails.set(LAST_STOP, "transient");
    rig.f.down = false;
    await rig.tick(PROBE_MS);
    expect(recorded(rig)).toEqual([
      ["stop", FIRST_STOP],
      ["start", START_TEXT],
    ]);
    expect((await rig.actor.readCopies()).stopped).toEqual(NOTE);

    // A text waits 20 s meanwhile: no outage line to the number whose last word is STOP.
    await rig.arrive(WAITING, "Test words: is my 3pm still on?");
    await rig.tick(OUTAGE_WAIT_MS);
    expect(outageSends(rig)).toEqual([]);
    expect((await rig.actor.readOutage()).texts).toContainEqual(
      expect.objectContaining({ eventId: WAITING, kind: "other", line: "stopped" }),
    );
    expect((await rig.actor.readCopies()).stopped).toEqual(NOTE);

    // The next ask: the last STOP's record is written (v6), and its answer, for the note's own text, replaces the note.
    // The queued text's turn then commits.
    await rig.tick(PROBE_MS - OUTAGE_WAIT_MS);
    await until(() => rig.f.log.includes(`commit:${WAITING}`), "the queued text's commit", 10_000);
    await rig.settle();
    expect(recorded(rig)).toEqual([
      ["stop", FIRST_STOP],
      ["start", START_TEXT],
      ["stop", LAST_STOP],
    ]);
    copies = await rig.actor.readCopies();
    expect(copies.returns).toEqual([]);
    expect(copies.stopped).toEqual({ stopped: true, phoneVersion: 6, turnId: null, setAt: anyTime });

    // A later turn's START (the one phone row: the replay's last STOP wrote v6, so the START writes v7) ends it.
    rig.f.api.phone.stopped = true;
    rig.f.api.phone.version = 6;
    rig.f.api.stopWrites.push(false);
    const later = await turnIdOf([LATER_START]);
    await rig.arrive(LATER_START, "START");
    await rig.tick(3000);
    await until(() => rig.f.log.includes(`commit:${LATER_START}`), "the later turn's commit", 10_000);
    await rig.settle();
    expect((await rig.actor.readCopies()).stopped).toEqual({
      stopped: false,
      phoneVersion: 7,
      turnId: later,
      setAt: anyTime,
    });
  });
});

describe("a STOP stored but not committed stops the safety read's outage line to its number, with the down path wired or not (T-1313; RULES 7.2), while a danger line still goes (RULES 4.12)", () => {
  const FIRST = "evt-sam-0420";
  const STOP = "evt-sam-0421";
  const QUIET = "evt-sam-0422";
  const DANGER_WORD = "evt-sam-0423";
  const DANGER = "evt-sam-0424";
  const OTHER = "evt-sam-0425";
  const START = "evt-sam-0426";

  /** The safety read answers No for these texts and finds danger in DANGER; QUIET and DANGER_WORD get no verdict. */
  const answers = (): Record<string, SafetyResult> => ({
    [PRIME]: safetyNoFor(PRIME),
    [FIRST]: safetyNoFor(FIRST),
    [STOP]: safetyNoFor(STOP),
    [OTHER]: safetyNoFor(OTHER),
    [START]: safetyNoFor(START),
    [DANGER]: emergencyFor(DANGER),
  });

  /** Each safety record the core was asked for, as its text and the checked line the core's outbox row holds. */
  const safetyLines = (rig: Rig): [string, string | null][] =>
    rig.f.core.recorded.map((call) => [
      call.request.safety.eventId,
      "error" in call.response ? null : (call.response.safetyLine?.fixedLineId ?? null),
    ]);

  /** The safety read's state of one text. */
  const safetyOf = async (rig: Rig, eventId: string): Promise<SafetyEntry | undefined> =>
    (await rig.actor.readSafety()).find((entry) => entry.eventId === eventId);

  /** The actor's down path, inside the actor: the host's `stopped` asks its `stopPending`, the lease's host its `stopAmong`. */
  const readings = (eventIds: string[]): Promise<{ stopPending: boolean; stopAmong: boolean | undefined }> =>
    runInDurableObject(stub(), (instance) => {
      const inside = instance as unknown as { outage: DbOutage; lease: { host: LeaseHost } };
      return { stopPending: inside.outage.stopPending(), stopAmong: inside.lease.host.stopAmong?.(eventIds) };
    });

  /**
   * Sam's first turn has committed (the pin copied bundle A's keyword list), and the down path is unwired unless
   * `downPath`. FIRST's turn (its words `first`) then begins its commit, which the core does not answer yet (K-05
   * `transient`), so the lease keeps every later batch waiting for it.
   */
  async function commitBegun(rig: Rig, options: { downPath: boolean; first?: string }): Promise<void> {
    await prime(rig);
    if (!options.downPath) restores.push(setDbOutageDeps(null));
    const refused: string[] = [];
    restores.push(
      setLeaseHooks({
        runTurn: async (turn) => {
          await turn.commit(samCommit(turn));
        },
        commit: (request, at) => {
          if (!request.turn.eventIds.includes(FIRST)) return rig.f.commit(request, at);
          refused.push(request.turn.id);
          return Promise.resolve({ error: "transient" });
        },
      }),
    );
    await rig.arrive(FIRST, options.first ?? "Test words: can I come Friday at 3?");
    await rig.tick(3000);
    await until(() => refused.length > 0, "the first turn's commit", 10_000);
  }

  /**
   * As `commitBegun`; then Sam's STOP arrives, read by the safety read (No), and its batch closes 3 s on and waits: a STOP
   * stored, not committed, and no copy says stopped. With `unreadable`, the down path cannot open the STOP's words (its
   * key read fails), so it reads it as `unknown`.
   */
  async function stopWaiting(rig: Rig, options: { downPath: boolean; unreadable?: boolean }): Promise<void> {
    await commitBegun(rig, { downPath: options.downPath });
    if (options.unreadable === true) rig.f.keyReads.push(false);
    await rig.arrive(STOP, "STOP");
    await rig.tick(3000);
    expect((await rig.actor.readTurns()).map((turn) => [turn.eventIds, turn.state])).toEqual([
      [[PRIME], "committed"],
      [[FIRST], "committing"],
    ]);
    expect(await rig.actor.readWaitingBatches()).toHaveLength(1);
    expect((await rig.actor.readCopies()).stopped?.stopped ?? false).toBe(false);
    expect(rig.f.stops).toEqual([]);
  }

  /** A text with no verdict in 4 s and no danger word: the safety read's timeout rule, whose line is the outage line. */
  async function noVerdict(
    rig: Rig,
    eventId = QUIET,
    body = "Test words: hello, is anyone there?",
  ): Promise<void> {
    await rig.arrive(eventId, body, false);
    await rig.tick(4000);
  }

  /** No line RULES 7.2 forbids went: no outage line through the core's outbox row, nor straight through Linq. */
  async function noOutageLine(rig: Rig, eventId = QUIET): Promise<void> {
    expect(rig.f.core.fixed).toEqual([]);
    expect(outageSends(rig)).toEqual([]);
    expect(await safetyOf(rig, eventId)).toMatchObject({ path: "none", lineId: "outage" });
  }

  /** The danger lines RULES 4.12 requires still go at once, through the core's outbox row (send class safety). */
  async function dangerStillGoes(rig: Rig): Promise<void> {
    // No verdict in 4 s and a danger word: Unsure, and its safety line (911).
    const wordAt = rig.f.clock.now();
    await rig.arrive(DANGER_WORD, "Test words: a client's cut won't stop bleeding", false);
    await rig.tick(4000);
    // A danger verdict: its outcome's checked line, at once.
    const verdictAt = rig.f.clock.now();
    await rig.arrive(DANGER, "Test words: my lips are swelling");
    expect(safetyLines(rig)).toEqual([
      [DANGER_WORD, "safetyEmergency"],
      [DANGER, "safetyEmergency"],
    ]);
    expect(rig.f.core.recorded.map((call) => call.at)).toEqual([wordAt + 4000, verdictAt]);
    expect(await safetyOf(rig, DANGER_WORD)).toMatchObject({ danger: true, path: "outbox" });
    expect(await safetyOf(rig, DANGER)).toMatchObject({ danger: true, path: "outbox" });
  }

  it("with the down path unwired, as the root installs it today: a STOP waiting behind a turn whose commit has begun stops the timeout rule's outage line through the core, while a danger word's safety line and a danger verdict's still go", async () => {
    const rig = rigFor(answers());
    await stopWaiting(rig, { downPath: false });
    await noVerdict(rig);
    await noOutageLine(rig);
    await dangerStillGoes(rig);
    await noOutageLine(rig);
  });

  it("with the down path unwired and the core not answering: no outage line straight through Linq, and a danger verdict's safety line goes straight through Linq, past any opt-out", async () => {
    const rig = rigFor(answers());
    await stopWaiting(rig, { downPath: false });
    rig.f.down = true;
    await noVerdict(rig);
    await noOutageLine(rig);
    await rig.arrive(DANGER, "Test words: my lips are swelling");
    expect(rig.f.direct.sent).toEqual([
      expect.objectContaining({
        fixedLineId: "safetyEmergency",
        overrideOptout: true,
        idempotencyKey: `safety:${DANGER}:safetyEmergency`,
      }),
    ]);
    expect(await safetyOf(rig, DANGER)).toMatchObject({ danger: true, path: "direct" });
  });

  it("with the down path unwired: a STOP whose own read gives no verdict in 4 s gets no outage line", async () => {
    const rig = rigFor({ [PRIME]: safetyNoFor(PRIME) });
    await prime(rig);
    restores.push(setDbOutageDeps(null));
    await noVerdict(rig, STOP, "STOP");
    await noOutageLine(rig, STOP);
  });

  it("with the down path wired, the STOP read as a STOP by the keyword copy: no outage line, while the danger lines still go", async () => {
    const rig = rigFor(answers());
    await stopWaiting(rig, { downPath: true });
    expect((await rig.actor.readOutage()).texts).toContainEqual(
      expect.objectContaining({ eventId: STOP, kind: "stop", keyword: "left" }),
    );
    await noVerdict(rig);
    await noOutageLine(rig);
    await dangerStillGoes(rig);
    await noOutageLine(rig);
  });

  it("with the down path wired, the STOP's words not opened (read as unknown: it may be a stop word): no outage line, while the danger lines still go", async () => {
    const rig = rigFor(answers());
    await stopWaiting(rig, { downPath: true, unreadable: true });
    expect((await rig.actor.readOutage()).texts).toContainEqual(
      expect.objectContaining({ eventId: STOP, kind: "unknown" }),
    );
    await noVerdict(rig);
    await noOutageLine(rig);
    await dangerStillGoes(rig);
    await noOutageLine(rig);
  });

  const faults: { fault: string; sql: string[] }[] = [
    // Its `arrive` write threw: the down path has no reading of it.
    { fault: "has no reading", sql: [`DELETE FROM outage_texts WHERE event_id = '${STOP}'`] },
    {
      fault: "cannot be found",
      sql: [
        `DELETE FROM outage_texts WHERE event_id = '${STOP}'`,
        `DELETE FROM inbox WHERE event_id = '${STOP}'`,
      ],
    },
    { fault: "has a reading that throws", sql: ["DROP TABLE outage_texts"] },
  ];

  it.each(faults)(
    "with the down path wired, fails closed: a waiting text that $fault counts as a possible STOP, and no outage line goes",
    async ({ sql }) => {
      const rig = rigFor(answers());
      await stopWaiting(rig, { downPath: true });
      await runInDurableObject(stub(), (_, state) => {
        for (const query of sql) state.storage.sql.exec(query);
      });
      await noVerdict(rig);
      await noOutageLine(rig);
    },
  );

  it("with PostgreSQL down, the down path's own outage line asks the same reading: a text no commit has taken with no reading (its `arrive` write threw) withholds it at 20 s", async () => {
    const rig = rigFor(answers());
    await prime(rig);
    rig.f.down = true;
    await rig.arrive(OTHER, "Test words: thanks!");
    await runInDurableObject(stub(), (_, state) => {
      state.storage.sql.exec("DELETE FROM outage_texts WHERE event_id = ?", OTHER);
    });
    await rig.arrive(FIRST, "Test words: can I come Friday at 3?");
    await rig.tick(3000);
    await rig.tick(OUTAGE_WAIT_MS - 3000);
    expect(rig.f.probes).not.toEqual([]);
    expect(outageSends(rig)).toEqual([]);
    expect((await rig.actor.readOutage()).texts).toEqual([
      expect.objectContaining({ eventId: FIRST, kind: "other", line: "stopped" }),
    ]);
  });

  it("the host's `stopped` and the lease's `stopAmong` give one reading of the same outage_texts rows: a waiting batch read as another text, or a START, is no STOP to either; one read as a STOP or unknown is one to both; unwired, any is", async () => {
    const rig = rigFor(answers());
    await stopWaiting(rig, { downPath: true });
    expect(await readings([STOP])).toEqual({ stopPending: true, stopAmong: true });
    // The same waiting text, as the down path could have read it (the first turn's text, still committing, reads `other`).
    await runInDurableObject(stub(), (_, state) => {
      state.storage.sql.exec("UPDATE outage_texts SET kind = 'other' WHERE event_id = ?", STOP);
    });
    expect(await readings([STOP])).toEqual({ stopPending: false, stopAmong: false });
    await runInDurableObject(stub(), (_, state) => {
      state.storage.sql.exec("UPDATE outage_texts SET kind = 'start' WHERE event_id = ?", STOP);
    });
    expect(await readings([STOP])).toEqual({ stopPending: false, stopAmong: false });
    await runInDurableObject(stub(), (_, state) => {
      state.storage.sql.exec("UPDATE outage_texts SET kind = 'unknown' WHERE event_id = ?", STOP);
    });
    expect(await readings([STOP])).toEqual({ stopPending: true, stopAmong: true });
    restores.push(setDbOutageDeps(null));
    await runInDurableObject(stub(), (_, state) => {
      state.storage.sql.exec("UPDATE outage_texts SET kind = 'other' WHERE event_id = ?", STOP);
    });
    expect(await readings([STOP])).toEqual({ stopPending: true, stopAmong: true });
  });

  // ---- round 2 (DL-615): the proofs both rulings add ----------------------------------------------------------------

  /** The host's `stopPending` now, inside the actor (what `stopped` asks beside the copy). */
  const stopPendingNow = (): Promise<boolean> =>
    runInDurableObject(stub(), (instance) =>
      (instance as unknown as { outage: DbOutage }).outage.stopPending(),
    );

  /** The timed-out text arrives with no verdict; the test waits for the down path's reading of it before its 4 s. */
  async function quietRead(rig: Rig): Promise<number> {
    const arrivedAt = rig.f.clock.now();
    await rig.arrive(QUIET, "Test words: hello, is anyone there?", false);
    await rig.actor.outageIdle();
    return arrivedAt;
  }

  /** The outage line went once through the core's outbox row (K-09 sendFixedLine, send class quick_reply), at 4 s. */
  async function lineThroughCore(rig: Rig, arrivedAt: number): Promise<void> {
    expect(rig.f.core.fixed).toEqual([
      {
        at: arrivedAt + 4000,
        request: expect.objectContaining({
          fixedLineId: "outage",
          recipientHandleId: SAM.party.handleId,
          sendClass: "quick_reply",
          sentByActor: null,
        }) as unknown,
      },
    ]);
    expect(outageSends(rig)).toEqual([]);
    expect(await safetyOf(rig, QUIET)).toMatchObject({
      path: "outbox",
      lineId: "outage",
      handedAfterMs: 4000,
    });
  }

  /** The outage line went once straight through Linq (the core not answering), not past an opt-out; its record queued. */
  async function lineThroughLinq(rig: Rig, arrivedAt: number): Promise<void> {
    expect(rig.f.core.fixed).toEqual([]);
    expect(outageSends(rig)).toEqual([
      {
        actorName: SAM_ACTOR,
        fixedLineId: "outage",
        text: OUTAGE_TEXT,
        overrideOptout: false,
        idempotencyKey: `safety:${QUIET}:outage`,
        at: arrivedAt + 4000,
      },
    ]);
    expect(await safetyOf(rig, QUIET)).toMatchObject({
      path: "outage",
      lineId: "outage",
      handedAfterMs: 4000,
    });
    expect((await rig.actor.readCopies()).returns).toContainEqual(
      expect.objectContaining({ key: `sendFixedLine:${QUIET}`, call: "sendFixedLine", rank: "rest" }),
    );
  }

  it("the boundary, with the down path wired (the architect's 2(a); the security reviewer's (a)): a turn whose commit has begun holds its text with the lease and the timed-out text waits in the window, each read as another text by the real classify, the copy not stopped: the outage line goes once, through the core's outbox row", async () => {
    const rig = rigFor(answers());
    await commitBegun(rig, { downPath: true });
    const arrivedAt = await quietRead(rig);
    expect((await rig.actor.readOutage()).texts).toEqual([
      expect.objectContaining({ eventId: FIRST, kind: "other" }),
      expect.objectContaining({ eventId: QUIET, kind: "other" }),
    ]);
    expect((await rig.actor.readCopies()).stopped?.stopped ?? false).toBe(false);
    expect(await readings([FIRST, QUIET])).toEqual({ stopPending: false, stopAmong: false });
    await rig.tick(4000);
    await lineThroughCore(rig, arrivedAt);
    // Once: nothing more goes for it, by the safety read or by the down path's 20 s.
    await rig.tick(OUTAGE_WAIT_MS);
    expect(rig.f.core.fixed).toHaveLength(1);
    expect(outageSends(rig)).toEqual([]);
  });

  it("the boundary, with the down path wired (the architect's 2(a); the security reviewer's (a)): a START waiting behind the turn whose commit has begun is read as a START, the others as other texts: the outage line goes once, through the core's outbox row", async () => {
    const rig = rigFor(answers());
    await commitBegun(rig, { downPath: true });
    await rig.arrive(START, "START");
    await rig.tick(3000);
    expect(await rig.actor.readWaitingBatches()).toHaveLength(1);
    const arrivedAt = await quietRead(rig);
    expect((await rig.actor.readOutage()).texts).toEqual([
      expect.objectContaining({ eventId: FIRST, kind: "other" }),
      expect.objectContaining({ eventId: START, kind: "start", keyword: "left" }),
      expect.objectContaining({ eventId: QUIET, kind: "other" }),
    ]);
    expect((await rig.actor.readCopies()).stopped?.stopped ?? false).toBe(false);
    expect(await readings([START])).toEqual({ stopPending: false, stopAmong: false });
    await rig.tick(4000);
    await lineThroughCore(rig, arrivedAt);
  });

  it("the boundary, with the down path wired and the core not answering (the architect's 2(a); the security reviewer's (a)): the outage line goes once straight through Linq, not past an opt-out, under the key safety:<event id>:outage, its record queued", async () => {
    const rig = rigFor(answers());
    await commitBegun(rig, { downPath: true });
    rig.f.down = true;
    const arrivedAt = await quietRead(rig);
    expect((await rig.actor.readOutage()).texts).toEqual([
      expect.objectContaining({ eventId: FIRST, kind: "other" }),
      expect.objectContaining({ eventId: QUIET, kind: "other" }),
    ]);
    expect(await stopPendingNow()).toBe(false);
    await rig.tick(4000);
    await lineThroughLinq(rig, arrivedAt);
  });

  it("the handled carve-out (the architect's 2(b)): a STOP then a START the actor took itself while PostgreSQL was down, the copy not stopped: stopPending answers false, and the outage line goes once straight through Linq", async () => {
    const rig = rigFor(answers());
    await prime(rig);
    rig.f.down = true;
    await rig.arrive(STOP, "STOP");
    await rig.arrive(START, "START");
    expect(rig.f.direct.sent.map((send) => send.idempotencyKey)).toEqual([
      `keyword:${STOP}:stopReply`,
      `keyword:${START}:startReply`,
    ]);
    expect((await rig.actor.readCopies()).stopped).toMatchObject({ stopped: false });
    const arrivedAt = await quietRead(rig);
    expect((await rig.actor.readOutage()).texts).toEqual([
      expect.objectContaining({ eventId: STOP, kind: "stop", keyword: "handled" }),
      expect.objectContaining({ eventId: START, kind: "start", keyword: "handled" }),
      expect.objectContaining({ eventId: QUIET, kind: "other" }),
    ]);
    expect(await stopPendingNow()).toBe(false);
    await rig.tick(4000);
    expect(outageSends(rig)).toEqual([
      expect.objectContaining({
        fixedLineId: "outage",
        overrideOptout: false,
        idempotencyKey: `safety:${QUIET}:outage`,
        at: arrivedAt + 4000,
      }),
    ]);
    expect(await safetyOf(rig, QUIET)).toMatchObject({ path: "outage", lineId: "outage" });
  });

  it("the handled carve-out (the architect's 2(b); the security reviewer's (b)): a lone STOP the actor took itself while PostgreSQL was down is left out of stopPending, and the copy, which says stopped, withholds the outage line", async () => {
    const rig = rigFor(answers());
    await prime(rig);
    rig.f.down = true;
    await rig.arrive(STOP, "STOP");
    expect((await rig.actor.readCopies()).stopped).toMatchObject({ stopped: true });
    await quietRead(rig);
    expect((await rig.actor.readOutage()).texts).toEqual([
      expect.objectContaining({ eventId: STOP, kind: "stop", keyword: "handled" }),
      expect.objectContaining({ eventId: QUIET, kind: "other" }),
    ]);
    expect(await stopPendingNow()).toBe(false);
    await rig.tick(4000);
    await noOutageLine(rig);
  });

  it("the handled carve-out (the security reviewer's (b); RULES 7.5): a lone START the actor took itself while PostgreSQL was down withholds nothing: the outage line goes once straight through Linq", async () => {
    const rig = rigFor(answers());
    await prime(rig);
    rig.f.down = true;
    await rig.arrive(START, "START");
    expect((await rig.actor.readCopies()).stopped).toMatchObject({ stopped: false });
    const arrivedAt = await quietRead(rig);
    expect((await rig.actor.readOutage()).texts).toEqual([
      expect.objectContaining({ eventId: START, kind: "start", keyword: "handled" }),
      expect.objectContaining({ eventId: QUIET, kind: "other" }),
    ]);
    expect(await stopPendingNow()).toBe(false);
    await rig.tick(4000);
    await lineThroughLinq(rig, arrivedAt);
  });

  it("the accepted wired cost, pinned (the security reviewer's (c); CQ-282): a handle with no keyword copy (no turn has pinned a bundle yet) reads its first text as unknown, so the timeout rule's outage line is withheld, while a danger word's safety line still goes", async () => {
    const rig = rigFor(answers());
    const copy = await runInDurableObject(stub(), (instance) =>
      (instance as unknown as { copies: ActorCopies }).copies.readKeywords(),
    );
    expect(copy).toBeNull();
    await quietRead(rig);
    expect((await rig.actor.readOutage()).texts).toEqual([
      expect.objectContaining({ eventId: QUIET, kind: "unknown" }),
    ]);
    expect(await stopPendingNow()).toBe(true);
    await rig.tick(4000);
    await noOutageLine(rig);
    // No verdict in 4 s and a danger word: Unsure, and its safety line (911) through the core's outbox row.
    const wordAt = rig.f.clock.now();
    await rig.arrive(DANGER_WORD, "Test words: a client's cut won't stop bleeding", false);
    await rig.tick(4000);
    expect(safetyLines(rig)).toEqual([[DANGER_WORD, "safetyEmergency"]]);
    expect(rig.f.core.recorded.map((call) => call.at)).toEqual([wordAt + 4000]);
    expect(await safetyOf(rig, DANGER_WORD)).toMatchObject({ danger: true, path: "outbox" });
    await noOutageLine(rig);
  });

  it("a STOP among the texts of the turn whose commit has begun, not only in a waiting batch (the security reviewer's (d); lease.ts pendingEventIds: a turn leased, committing or being parked), withholds the outage line, with the down path wired", async () => {
    const rig = rigFor(answers());
    await commitBegun(rig, { downPath: true, first: "STOP" });
    expect((await rig.actor.readTurns()).map((turn) => [turn.eventIds, turn.state])).toEqual([
      [[PRIME], "committed"],
      [[FIRST], "committing"],
    ]);
    expect(await rig.actor.readWaitingBatches()).toEqual([]);
    await quietRead(rig);
    expect((await rig.actor.readOutage()).texts).toEqual([
      expect.objectContaining({ eventId: FIRST, kind: "stop", keyword: "left" }),
      expect.objectContaining({ eventId: QUIET, kind: "other" }),
    ]);
    expect((await rig.actor.readCopies()).stopped?.stopped ?? false).toBe(false);
    expect(await stopPendingNow()).toBe(true);
    await rig.tick(4000);
    await noOutageLine(rig);
    await dangerStillGoes(rig);
    await noOutageLine(rig);
  });
});

describe("a vote's words, once in its box, are read for a STOP (DL-540; T-1297)", () => {
  it("a vote for an option that reads STOP, while PostgreSQL is down, is taken as a STOP: the flag copied, the stop reply straight through Linq, its record written on return with the option's words", async () => {
    const VOTE = "evt-sam-0407";
    const rig = rigFor({ [PRIME]: safetyNoFor(PRIME), [VOTE]: safetyNoFor(VOTE) });
    await prime(rig);
    rig.f.down = true;
    // Sam's vote, through the gateway's own hand-off: K-06 v1.2 seals the option's words in its form 2 box.
    const prepared = await prepareHandoff(
      {
        event: {
          ...pollVote,
          eventId: VOTE,
          handle: SAM.handle,
          sentAt: new Date(rig.f.clock.now()).toISOString(),
          traceId: TRACE,
          poll: { ...pollVote.poll, optionWords: "Stop" },
        },
        partKey: null,
        traceId: TRACE,
        bundleId: BUNDLE,
      },
      keys,
    );
    if (prepared.door !== "actor") throw new Error("not an actor event");
    expect(prepared.handoff.event.poll).toEqual({
      pollId: pollVote.poll.pollId,
      optionId: pollVote.poll.optionId,
    });

    expect(await door().accept(prepared.handoff)).toBe("written");
    await rig.settle();

    expect((await rig.actor.readOutage()).texts).toEqual([
      expect.objectContaining({ eventId: VOTE, kind: "stop", keyword: "handled" }),
    ]);
    expect((await rig.actor.readCopies()).stopped).toMatchObject({ stopped: true });
    expect(rig.f.direct.sent.map((send) => [send.idempotencyKey, send.overrideOptout])).toEqual([
      [`keyword:${VOTE}:stopReply`, true],
    ]);
    expect((await rig.actor.readCopies()).returns.map((entry) => [entry.rank, entry.key])).toEqual([
      ["stop", `recordStopOrStart:${VOTE}`],
    ]);

    // Back: the STOP is written as the vote's, with the words the person chose; it joins no turn.
    rig.f.down = false;
    await rig.tick(PROBE_MS);
    expect(rig.f.stops.map((stop) => [stop.kind, stop.inboundEventId, stop.words])).toEqual([
      ["stop", VOTE, "Stop"],
    ]);
    expect(rig.f.log.filter((call) => call.startsWith("commit:"))).toEqual([]);
  });
});

describe("the down path's own outage line asks the one reading right before each text's line, not once per pass, so a STOP the actor takes while an earlier line is out holds every later line of the pass (T-1335; RULES 7.2), while a danger line still goes (RULES 4.12)", () => {
  const A = "evt-sam-0430";
  const B = "evt-sam-0431";
  const STOP = "evt-sam-0432";
  const LATE = "evt-sam-0433";
  const DANGER = "evt-sam-0434";

  /** The safety read answers No for each text and finds danger in DANGER. */
  const answers = (): Record<string, SafetyResult> => ({
    [PRIME]: safetyNoFor(PRIME),
    [A]: safetyNoFor(A),
    [B]: safetyNoFor(B),
    [STOP]: safetyNoFor(STOP),
    [LATE]: safetyNoFor(LATE),
    [DANGER]: emergencyFor(DANGER),
  });

  /**
   * Linq's answers to the outage lines held while `gate` is closed: Linq takes each line at once (it is noted in
   * `direct.sent`) and answers once the gate opens, as a Linq slow to answer while the actor goes on taking texts, the way
   * T-1323's `holdAnswers` holds K-09's. A stop reply and a safety line are answered at once.
   */
  function holdLineAnswers(rig: Rig, gate: Hold): void {
    const send = rig.f.direct.send.bind(rig.f.direct);
    rig.f.direct.send = async (request) => {
      const answer = await send(request);
      if (request.fixedLineId === "outage") await gate.wait();
      return answer;
    };
  }

  /** The actor's one answer now (handle-actor.ts `mayHaveStopped`: its copy of the flag, or the down path's `stopPending`). */
  const actorAnswer = (): Promise<boolean> =>
    runInDurableObject(stub(), (instance) =>
      (instance as unknown as { mayHaveStopped(): boolean }).mayHaveStopped(),
    );

  /** The outage line the down path sends for a text: K-01's words straight through Linq, not past an opt-out, under its key. */
  const lineFor = (eventId: string, at: number): DbFakes["direct"]["sent"][number] => ({
    actorName: SAM_ACTOR,
    fixedLineId: "outage",
    text: OUTAGE_TEXT,
    overrideOptout: false,
    idempotencyKey: `safety:${eventId}:outage`,
    at,
  });

  /**
   * Sam's first turn has committed (its pin copied bundle A's keyword list, through ActorCopies.refreshKeywords), then
   * PostgreSQL goes down. A and B arrive together and the real classify reads each as another text; their batch closes at
   * 3 s and goes to the lease, whose turn cannot pin its bundle. At 20 s the down path asks PostgreSQL, which does not
   * answer, and its pass sends A's line first: Linq takes it and holds its answer. Returns the 20 s mark, with A's line out
   * and the pass waiting on it (so nothing here waits for the down path's work to settle).
   */
  async function firstLineOut(rig: Rig, gate: Hold): Promise<number> {
    await prime(rig);
    rig.f.down = true;
    holdLineAnswers(rig, gate);
    const dueAt = rig.f.clock.now() + OUTAGE_WAIT_MS;
    await rig.arrive(A, "Test words: can I come Friday at 3?");
    await rig.arrive(B, "Test words: also, is parking free?");
    expect((await rig.actor.readOutage()).texts).toEqual([
      expect.objectContaining({ eventId: A, kind: "other", line: null }),
      expect.objectContaining({ eventId: B, kind: "other", line: null }),
    ]);
    expect(await actorAnswer()).toBe(false);
    await rig.tick(3000);
    expect(outageSends(rig)).toEqual([]);
    await rig.f.clock.advance(OUTAGE_WAIT_MS - 3000);
    await runDurableObjectAlarm(stub());
    await until(() => outageSends(rig).length === 1, "the first line's send");
    expect(rig.f.probes).toEqual([dueAt]);
    expect(outageSends(rig)).toEqual([lineFor(A, dueAt)]);
    return dueAt;
  }

  it("a STOP the actor takes while the pass's first line is out (its reading waits behind the pass, so it counts as a possible STOP, T-1313): no second line, then or later; the next check reads it as a STOP and takes it; a danger verdict's safety line still goes, past the opt-out", async () => {
    const rig = rigFor(answers());
    const gate = hold(true);
    const dueAt = await firstLineOut(rig, gate);

    // The STOP comes now: the actor stores it, opens a batch window with it and follows it, in the one step of `accept`.
    // Its reading waits behind the pass, so the actor's answer turns to a possible STOP.
    await rig.arrive(STOP, "STOP", false);
    expect((await rig.actor.readBatches()).at(-1)).toMatchObject({ reason: null, eventIds: [STOP] });
    expect((await rig.actor.readOutage()).texts).toContainEqual(
      expect.objectContaining({ eventId: STOP, kind: null }),
    );
    expect(await actorAnswer()).toBe(true);
    expect(outageSends(rig)).toEqual([lineFor(A, dueAt)]);

    // Linq answers A's line: the pass asks again right before B's line, and the answer holds it.
    gate.closed = false;
    await rig.settle();
    expect(outageSends(rig)).toEqual([lineFor(A, dueAt)]);
    // The next check reads the STOP as a STOP and takes it: the flag copied, its reply straight through Linq.
    expect(rig.f.direct.sent.map((send) => [send.idempotencyKey, send.overrideOptout])).toEqual([
      [`safety:${A}:outage`, false],
      [`keyword:${STOP}:stopReply`, true],
    ]);
    expect((await rig.actor.readOutage()).texts).toEqual([
      expect.objectContaining({ eventId: A, kind: "other", line: "sent" }),
      expect.objectContaining({ eventId: B, kind: "other", line: "stopped" }),
      expect.objectContaining({ eventId: STOP, kind: "stop", keyword: "handled" }),
    ]);
    let copies = await rig.actor.readCopies();
    expect(copies.stopped).toMatchObject({ stopped: true });
    // A's line went, so its record waits for the return; B's never went, so none waits for it.
    expect(copies.returns.map((entry) => [entry.rank, entry.key])).toEqual([
      ["stop", `recordStopOrStart:${STOP}`],
      ["rest", `sendFixedLine:${A}`],
    ]);

    // PostgreSQL stays down: B's line is not asked again.
    await rig.tick(PROBE_MS);
    await rig.tick(PROBE_MS);
    expect(outageSends(rig)).toEqual([lineFor(A, dueAt)]);

    // A danger verdict now, from the number whose STOP was just taken: its safety line goes at once, straight through Linq
    // past the opt-out (arch 02 line 111), and its record waits in the danger rank. It gets no outage line.
    const dangerAt = rig.f.clock.now();
    await rig.arrive(DANGER, "Test words: my lips are swelling");
    expect(rig.f.direct.sent.filter((send) => send.fixedLineId === "safetyEmergency")).toEqual([
      expect.objectContaining({
        actorName: SAM_ACTOR,
        overrideOptout: true,
        idempotencyKey: `safety:${DANGER}:safetyEmergency`,
        at: dangerAt,
      }),
    ]);
    copies = await rig.actor.readCopies();
    expect(copies.returns.map((entry) => [entry.rank, entry.key])).toEqual([
      ["danger", `recordSafetyOutcome:${DANGER}`],
      ["stop", `recordStopOrStart:${STOP}`],
      ["rest", `sendFixedLine:${A}`],
    ]);
    await rig.tick(OUTAGE_WAIT_MS);
    expect(outageSends(rig)).toEqual([lineFor(A, dueAt)]);
    expect((await rig.actor.readOutage()).texts).toContainEqual(
      expect.objectContaining({ eventId: DANGER, kind: "other", line: "stopped" }),
    );
  });

  it("the boundary: nothing comes while the pass's first line is out, every text no commit has taken read as another text and the copy not stopped: the reading asked again right before B's line answers no, and each text's line goes once", async () => {
    const rig = rigFor(answers());
    const gate = hold(true);
    const dueAt = await firstLineOut(rig, gate);
    expect(await actorAnswer()).toBe(false);

    gate.closed = false;
    await rig.settle();
    expect(outageSends(rig)).toEqual([lineFor(A, dueAt), lineFor(B, dueAt)]);
    expect((await rig.actor.readOutage()).texts).toEqual([
      expect.objectContaining({ eventId: A, kind: "other", line: "sent" }),
      expect.objectContaining({ eventId: B, kind: "other", line: "sent" }),
    ]);
    expect((await rig.actor.readCopies()).returns.map((entry) => [entry.rank, entry.key])).toEqual([
      ["rest", `sendFixedLine:${A}`],
      ["rest", `sendFixedLine:${B}`],
    ]);

    // Once: no second line for either, however long PostgreSQL stays down.
    await rig.tick(PROBE_MS);
    await rig.tick(PROBE_MS);
    expect(outageSends(rig)).toEqual([lineFor(A, dueAt), lineFor(B, dueAt)]);
  });

  it("fails closed as T-1313 does (CQ-282's accepted cost, pinned): a text of other words the actor takes while the first line is out has no reading yet either, so it holds B's line too, which is not asked again once that text reads as another text (a withheld line is final, as CQ-283's default has it for the safety read's line); the late text gets its own line once, at its 20 s", async () => {
    const rig = rigFor(answers());
    const gate = hold(true);
    const dueAt = await firstLineOut(rig, gate);
    await rig.arrive(LATE, "Test words: thanks!", false);
    expect((await rig.actor.readOutage()).texts).toContainEqual(
      expect.objectContaining({ eventId: LATE, kind: null }),
    );
    expect(await actorAnswer()).toBe(true);

    gate.closed = false;
    await rig.settle();
    expect(outageSends(rig)).toEqual([lineFor(A, dueAt)]);
    expect((await rig.actor.readOutage()).texts).toEqual([
      expect.objectContaining({ eventId: A, kind: "other", line: "sent" }),
      expect.objectContaining({ eventId: B, kind: "other", line: "stopped" }),
      expect.objectContaining({ eventId: LATE, kind: "other", line: null }),
    ]);
    expect((await rig.actor.readCopies()).stopped?.stopped ?? false).toBe(false);
    expect(await actorAnswer()).toBe(false);

    await rig.tick(OUTAGE_WAIT_MS);
    expect(outageSends(rig)).toEqual([lineFor(A, dueAt), lineFor(LATE, dueAt + OUTAGE_WAIT_MS)]);
    expect((await rig.actor.readOutage()).texts).toEqual([
      expect.objectContaining({ eventId: A, line: "sent" }),
      expect.objectContaining({ eventId: B, line: "stopped" }),
      expect.objectContaining({ eventId: LATE, line: "sent" }),
    ]);
  });

  it("fails closed as T-1313 does: the actor's copy of the stopped flag cannot be read when B's line is asked (a reading that throws counts as a stop), so no second line goes", async () => {
    const rig = rigFor(answers());
    const gate = hold(true);
    const dueAt = await firstLineOut(rig, gate);
    await runInDurableObject(stub(), (_, state) => {
      state.storage.sql.exec("DROP TABLE copy_stopped");
    });

    gate.closed = false;
    await rig.settle();
    expect(outageSends(rig)).toEqual([lineFor(A, dueAt)]);
    expect((await rig.actor.readOutage()).texts).toEqual([
      expect.objectContaining({ eventId: A, kind: "other", line: "sent" }),
      expect.objectContaining({ eventId: B, kind: "other", line: "stopped" }),
    ]);
  });
});

describe("a keyword copy before a handle's first pin: the list of the bundle a text arrived under, copied on arrival from the actor's BUNDLES binding, so the PostgreSQL-down path reads a first text (T-1324; CQ-282)", () => {
  const STOP = "evt-sam-0440";
  const HI = "evt-sam-0441";
  const WORD = "evt-sam-0442";
  const MANIFEST_A = keyIn(BUNDLE_A, "manifest");
  const MANIFEST_B = keyIn(BUNDLE_B, "manifest");

  /** A value under its K-01 key in the pool's BUNDLES namespace (KV), as the deploy publishes a bundle's values there. */
  async function publish(key: string, text: string): Promise<void> {
    const bundles = env.BUNDLES;
    if (bundles === undefined) throw new Error("the pool's staging environment binds BUNDLES (T-566)");
    await bundles.put(key, text);
  }

  /** A sample bundle's manifest as the compiler stores it, its keyword list (K-01 v1 lists.keywords) as `change` makes it. */
  function manifestWith(whole: WholeBundle, change: (keywords: Record<string, unknown>) => unknown): string {
    const manifest = structuredClone(whole.manifest) as unknown as {
      lists: { keywords: Record<string, unknown> };
    };
    manifest.lists.keywords = change(manifest.lists.keywords) as Record<string, unknown>;
    return JSON.stringify(manifest);
  }

  /** A text of Sam's arrives through the gateway's door under `bundleId`: the active id the gateway read at receipt. */
  async function arriveUnder(
    rig: Rig,
    bundleId: BundleId,
    eventId: string,
    body: string,
    settle = true,
  ): Promise<void> {
    const entry = await storedText(
      { eventId, body, sentAt: new Date(rig.f.clock.now()).toISOString(), traceId: TRACE },
      SAM.handle,
      keys,
      bundleId,
      0,
    );
    const handoff = { event: entry.event, partKey: null, traceId: TRACE, bundleId, actorName: SAM_ACTOR };
    expect(await door().accept(handoff)).toBe("written");
    if (settle) await rig.settle();
  }

  /** The actor's keyword copy, read inside the actor: its words in the list's order, its replies and when it was copied. */
  const keywordCopy = (): Promise<{
    words: Keyword[];
    replies: Record<string, string | null>;
    refreshedAt: number;
  } | null> =>
    runInDurableObject(stub(), (instance) => {
      const copy = (instance as unknown as { copies: ActorCopies }).copies.readKeywords();
      if (copy === null) return null;
      return {
        words: copy.list.all(),
        replies: Object.fromEntries(copy.replies),
        refreshedAt: copy.refreshedAt,
      };
    });

  /** Bundle A's keyword list as the guard reads it from bundle A's manifest: what a pin of bundle A copies. */
  const wordsOfA = (): Keyword[] => keywordsOf(WHOLE_A.manifest).all();

  /** The host's `stopPending` now, inside the actor (what the safety host's `stopped` asks beside the copy). */
  const stopPendingNow = (): Promise<boolean> =>
    runInDurableObject(stub(), (instance) =>
      (instance as unknown as { outage: DbOutage }).outage.stopPending(),
    );

  /** The safety read's state of one text. */
  const safetyOf = async (rig: Rig, eventId: string): Promise<SafetyEntry | undefined> =>
    (await rig.actor.readSafety()).find((entry) => entry.eventId === eventId);

  /** A first text with no verdict in 4 s arrives under bundle A; the test waits for the down path's reading of it. */
  async function firstTextHi(rig: Rig): Promise<number> {
    const arrivedAt = rig.f.clock.now();
    await arriveUnder(rig, BUNDLE_A, HI, "hi", false);
    await rig.actor.outageIdle();
    return arrivedAt;
  }

  it("a handle never pinned, PostgreSQL down: its first text, STOP, reads stop by the list of the bundle it arrived under (bundle A's, copied on arrival from KV, with no PostgreSQL); its reply goes at once past the opt-out, the flag reads stopped and its record waits in the stop rank, as T-270's STOP", async () => {
    const rig = rigFor({ [STOP]: safetyNoFor(STOP) });
    await publish(MANIFEST_A, textAt(MANIFEST_A));
    expect(await keywordCopy()).toBeNull();
    rig.f.down = true;
    const arrivedAt = rig.f.clock.now();
    await arriveUnder(rig, BUNDLE_A, STOP, "STOP");

    // Copied as a pin of bundle A copies it: its list, and its stop and start replies (no words yet: Q-01's while Jay's wait).
    expect(await keywordCopy()).toEqual({
      words: wordsOfA(),
      replies: { stopReply: null, startReply: null },
      refreshedAt: arrivedAt,
    });
    // Read as a STOP, PostgreSQL asked and not answering: the reply goes at once, past the opt-out, in Q-01's drafted words.
    expect(rig.f.probes).toEqual([arrivedAt]);
    expect(rig.f.direct.sent).toEqual([
      {
        actorName: SAM_ACTOR,
        fixedLineId: "stopReply",
        text: Q01_DRAFTED.stopReply,
        overrideOptout: true,
        idempotencyKey: `keyword:${STOP}:stopReply`,
        at: arrivedAt,
      },
    ]);
    const copies = await rig.actor.readCopies();
    expect(copies.stopped).toMatchObject({ stopped: true, phoneVersion: null });
    expect(copies.returns).toEqual([
      expect.objectContaining({ key: `recordStopOrStart:${STOP}`, call: "recordStopOrStart", rank: "stop" }),
    ]);
    expect((await rig.actor.readOutage()).texts).toEqual([
      expect.objectContaining({ eventId: STOP, kind: "stop", keyword: "handled" }),
    ]);
    // Its batch closes and waits with the batch window: no turn opens while PostgreSQL is down, and no bundle is pinned.
    await rig.tick(3000);
    expect(await rig.actor.readTurns()).toEqual([]);
    expect(await runInDurableObject(stub(), (instance) => instance.readPins())).toEqual([]);
  });

  it("a handle never pinned, PostgreSQL down: its first text, hi, with no verdict in 4 s, reads as another text by the list copied on arrival, so the timeout rule's outage line goes once, straight through Linq, not past an opt-out, its record queued; the down path's 20 s sends no second", async () => {
    const rig = rigFor({});
    await publish(MANIFEST_A, textAt(MANIFEST_A));
    rig.f.down = true;
    const arrivedAt = await firstTextHi(rig);
    expect((await keywordCopy())?.words).toEqual(wordsOfA());
    expect((await rig.actor.readOutage()).texts).toEqual([
      expect.objectContaining({ eventId: HI, kind: "other" }),
    ]);
    expect(await stopPendingNow()).toBe(false);

    await rig.tick(4000);
    expect(rig.f.core.fixed).toEqual([]);
    expect(outageSends(rig)).toEqual([
      {
        actorName: SAM_ACTOR,
        fixedLineId: "outage",
        text: OUTAGE_TEXT,
        overrideOptout: false,
        idempotencyKey: `safety:${HI}:outage`,
        at: arrivedAt + 4000,
      },
    ]);
    expect(await safetyOf(rig, HI)).toMatchObject({ path: "outage", lineId: "outage", handedAfterMs: 4000 });
    expect((await rig.actor.readCopies()).returns).toContainEqual(
      expect.objectContaining({ key: `sendFixedLine:${HI}`, call: "sendFixedLine", rank: "rest" }),
    );

    // Once: the down path's own line at 20 s sees the timeout rule's, and sends none.
    await rig.tick(OUTAGE_WAIT_MS);
    expect(rig.f.probes).not.toEqual([]);
    expect(outageSends(rig)).toHaveLength(1);
    expect((await rig.actor.readOutage()).texts).toEqual([
      expect.objectContaining({ eventId: HI, kind: "other", line: "went" }),
    ]);
  });

  it("a handle never pinned, PostgreSQL answering (the AI-down timeout CQ-282 names): its first text, hi, with no verdict in 4 s, reads as another text by the list copied on arrival, so the timeout rule's outage line goes once, through the core's outbox row", async () => {
    const rig = rigFor({});
    await publish(MANIFEST_A, textAt(MANIFEST_A));
    const arrivedAt = await firstTextHi(rig);
    expect((await rig.actor.readOutage()).texts).toEqual([
      expect.objectContaining({ eventId: HI, kind: "other" }),
    ]);
    expect(await stopPendingNow()).toBe(false);

    await rig.tick(4000);
    expect(rig.f.core.fixed).toEqual([
      {
        at: arrivedAt + 4000,
        request: expect.objectContaining({
          fixedLineId: "outage",
          recipientHandleId: SAM.party.handleId,
          sendClass: "quick_reply",
          sentByActor: null,
        }) as unknown,
      },
    ]);
    expect(outageSends(rig)).toEqual([]);
    expect(await safetyOf(rig, HI)).toMatchObject({ path: "outbox", lineId: "outage", handedAfterMs: 4000 });
    await rig.tick(OUTAGE_WAIT_MS);
    expect(rig.f.core.fixed).toHaveLength(1);
    expect(outageSends(rig)).toEqual([]);
  });

  const failedReads: { fault: string; publishes: () => Promise<void> }[] = [
    {
      fault: "finds no manifest under the bundle's key (a miss: PostgreSQL's copy is not read from here)",
      publishes: () => Promise.resolve(),
    },
    {
      fault: "finds a manifest that is not the bundle's own (bundle B's, under bundle A's key)",
      publishes: () => publish(MANIFEST_A, textAt(MANIFEST_B)),
    },
    {
      fault: "finds bundle A's manifest with a keyword list the guard cannot read (no opt-out word)",
      publishes: () =>
        publish(
          MANIFEST_A,
          manifestWith(WHOLE_A, (keywords) => ({ ...keywords, optOut: [], flagsVisit: [] })),
        ),
    },
  ];

  it.each(failedReads)(
    "a handle never pinned, PostgreSQL down: a keyword read that $fault copies nothing, so the first text reads unknown (it may be a stop word) and no outage line goes, the timeout rule's or the down path's",
    async ({ publishes }) => {
      const rig = rigFor({});
      await publishes();
      rig.f.down = true;
      await firstTextHi(rig);
      expect(await keywordCopy()).toBeNull();
      expect((await rig.actor.readOutage()).texts).toEqual([
        expect.objectContaining({ eventId: HI, kind: "unknown" }),
      ]);
      expect(await stopPendingNow()).toBe(true);

      await rig.tick(4000);
      expect(rig.f.core.fixed).toEqual([]);
      expect(outageSends(rig)).toEqual([]);
      expect(await safetyOf(rig, HI)).toMatchObject({ path: "none", lineId: "outage" });
      await rig.tick(OUTAGE_WAIT_MS);
      expect(rig.f.probes).not.toEqual([]);
      expect(outageSends(rig)).toEqual([]);
      expect((await rig.actor.readOutage()).texts).toEqual([
        expect.objectContaining({ eventId: HI, kind: "unknown", line: "stopped" }),
      ]);
    },
  );

  it("a copy already held is kept: once a pin has copied bundle A's list, a text that arrives under bundle B, whose list in KV has one more opt-out word, copies nothing on arrival, and is read by bundle A's list", async () => {
    const rig = rigFor({ [PRIME]: safetyNoFor(PRIME), [WORD]: safetyNoFor(WORD) });
    await prime(rig);
    const held = await keywordCopy();
    expect(held?.words).toEqual(wordsOfA());
    await publish(
      MANIFEST_B,
      manifestWith(WHOLE_B, (keywords) => ({
        ...keywords,
        optOut: [...(keywords.optOut as string[]), "TESTWORD"],
      })),
    );
    rig.f.down = true;
    await arriveUnder(rig, BUNDLE_B, WORD, "TESTWORD");
    expect(await keywordCopy()).toEqual(held);
    expect((await rig.actor.readOutage()).texts).toEqual([
      expect.objectContaining({ eventId: WORD, kind: "other" }),
    ]);
  });
});
