// The actor's own copies (T-269; C-053), run inside the Workers runtime. The actor is the real Durable Object reached through
// the gateway's door, with the real safety read on arrival, batch window, turn lease and bundle pin:
//
//   - the stopped flag: a bare STOP and a bare START go through the real turn loop (`turnHooks`) and the guard's fixed
//     replies (T-267, through `turnReplyCore`), whose commit is answered by T-267's shared-core double behind K-09's gate
//     (stop-recorded.json's shape); a test holds the gate's answer and the reply's first write, to read the copy between;
//   - the safety timers: the turn's commit through the lease is answered by the Tool API double (./test-support.ts), which
//     writes K-34's seed timer and serves the reload of the handle's live timers from the same rows;
//   - the checked safety lines: the safety read's bundle double (K-01's fixed-lines.json and bundle-mini-a.json's A3-24);
//   - the write-on-return queue: the actor's own queue, with sealed K-09 requests (start-recorded.json, stop-recorded.json,
//     j3-stop-on-return-tells-businesses.json), and the safety read's records made while the core double is down.
// Test method: T-1128's (runtime/src/spikes/do-test-pool/FINDINGS.md). Test values only: the master's sample cast and the
// frozen fixtures' ids, phones in the fictional 555-01xx range (rule 9).
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import fixedLines from "../../../../contracts/bundle/fixtures/fixed-lines.json";
import bundleMiniA from "../../../../contracts/bundle/fixtures/bundle-mini-a.json";
import safetyEmergencyNow from "../../../../contracts/model/fixtures/safety-emergency-now.json";
import startRecorded from "../../../../contracts/tool-api/fixtures/start-recorded.json";
import stopRecorded from "../../../../contracts/tool-api/fixtures/stop-recorded.json";
import stopOnReturn from "../../../../contracts/tool-api/fixtures/j3-stop-on-return-tells-businesses.json";
import k09v1 from "../../../../contracts/tool-api/tool-api.v1.schema.json";
import { fakeBundles } from "../../bundle/test-support";
import {
  actorNameOf,
  durableObjectActor,
  openWords,
  sealWords,
  type ActorNamespace,
  type HandleActorRpc,
  type HandleRef,
  type SealedBox,
} from "../../gateway";
import { fakeKeyStore } from "../../gateway/test-support";
import { setGuardDeps, setReplyDeps } from "../../guard";
import {
  fakeCore as fakeReplyCore,
  phone,
  ROSIE_NUMBER,
  type FakeCore,
  type FakeRow,
} from "../../guard/replies/test-support";
import { fakeTargets } from "../../guard/test-support";
import { fixtureBundle, harness, type Harness } from "../../safety/test-support";
import type { SafetyResult } from "../../safety/types";
import { setTurnDeps, turnHooks, turnReplyCore } from "../../turn";
import {
  ALEX,
  BEN,
  SAM,
  SAM_S1_02_TARGETS,
  fakeDecide,
  fakeFacts,
  fakeReply,
  fakeTurnFace,
  hold,
  safetyNoFor,
  storedText,
  targetsAnswer,
  turnDeps,
  until as untilWithin,
  type FakeReply,
  type FakeTurnFace,
  type Hold,
} from "../../turn/test-support";
import type { GateAndCommitAnswer, GateAndCommitRequest, TurnParty } from "../../turn/types";
import {
  setBatchHooks,
  setBundleDeps,
  setCopyDeps,
  setLeaseHooks,
  setSafetyDeps,
  turnIdOf,
  type CommitTurnRequest,
  type CopiesView,
  type HandleActor,
  type LeasedTurn,
  type ReplayReport,
  type SafetyTimerRow,
} from "../index";
import { readCommit, type ActorCopies } from "./copies";
import type { QueuedWrite, ReplayStep, ReturnQueue, ReturnWrite } from "./return-queue";
import { fakeToolApi, LATER_TIMER_CALL, SAM_TIMER, type FakeToolApi } from "./test-support";
import type { StoppedCopy } from "./types";

type Json = Record<string, unknown>;

const TRACE = "11111111-2222-4333-8444-555555555555";
const BUNDLE = { hash: "a".repeat(64), build: 1 };
const keys = fakeKeyStore();

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
  handle: HandleRef;
  party: TurnParty;
}

/** The actor's calls over RPC, typed here (the stub's own type cannot carry every shape). */
interface CopiesRpc {
  readCopies(): Promise<CopiesView>;
  writeOnReturn(): Promise<ReplayReport>;
  readHolds(): Promise<{ eventId: string; holdId: string | null }[]>;
  safetyIdle(): Promise<void>;
  batchIdle(): Promise<void>;
}

function stubOf(who: Party): DurableObjectStub<HandleActor> {
  return namespace().get(namespace().idFromName(actorNameOf(who.handle)));
}

const actorOf = (who: Party): CopiesRpc => stubOf(who);

/** The actor's own copies and queue, inside it. */
function insideOf(instance: unknown): { copies: ActorCopies; returns: ReturnQueue } {
  return instance as { copies: ActorCopies; returns: ReturnQueue };
}

/** A text arrives through the gateway's door: K-06's text, sealed under the handle's key, as the gateway hands it. */
async function arrive(who: Party, eventId: string, body: string, sentAt: string): Promise<void> {
  const entry = await storedText({ eventId, body, sentAt, traceId: TRACE }, who.handle, keys, BUNDLE, 0);
  const handoff = {
    event: entry.event,
    partKey: null,
    traceId: TRACE,
    bundleId: BUNDLE,
    actorName: actorNameOf(who.handle),
  };
  expect(await door().accept(handoff)).toBe("written");
}

/** Waits until `ready` holds, polling, for up to 10 s (a machine busy with other builds is slower). */
const until = (ready: () => boolean, what: string): Promise<void> => untilWithin(ready, what, 10_000);

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

// ---- the stopped flag (K-04 phones.stopped) ---------------------------------------------------------------------------

const STOP_EVENT = "evt-ben-0007";
const START_EVENT = startRecorded.request.inboundEventId;
const START_NOW = "2026-10-22T14:05:02Z";

interface StopRig {
  readonly face: FakeTurnFace;
  readonly reply: FakeReply;
  /** T-267's shared-core double: Ben's phone (K-04: stopped flag and version), K-29's rows, the outbox rows. */
  readonly core: FakeCore;
  /** While closed, the replies' first write of a reply's words (K-05 writePlan) waits: the reply cannot have gone. */
  readonly planHold: Hold;
  /** The rows whose words the replies began to write, in order. */
  readonly planCalls: string[];
  readonly actor: CopiesRpc;
  tick(ms: number): Promise<void>;
  settle(): Promise<void>;
}

/** stop-recorded.json's safety record for this turn's text (the keyword turn's first core result). */
function safetyRecordFor(eventId: string): Json {
  const first = stopRecorded.outcome.core[0];
  if (first === undefined) throw new Error("stop-recorded.json has no safety record");
  return { ...first, response: { ...first.response, outcomeId: `safety-outcome-${eventId}` } };
}

/**
 * K-09 gateAndCommit for a keyword turn, as stop-recorded.json answers it: the text's safety record first, then the
 * keyword's core actions as T-267's shared-core double records them (Ben's phone row and its version), with the rows the
 * commit wrote. A repeat writes nothing.
 */
async function keywordGate(core: FakeCore, request: GateAndCommitRequest): Promise<GateAndCommitAnswer> {
  const answer = await core.core.commitCore({
    caller: request.caller as never,
    actions: request.core.slice(1) as never,
  });
  if ("error" in answer) return answer;
  const benPhone = core.phones.get(BEN.handle.address);
  const rows = [...core.outbox.values()]
    .filter((row) => row.turnId === request.turn.id)
    .sort((a, b) => a.commitSeq - b.commitSeq)
    .map((row) => ({ id: row.id, commitSeq: row.commitSeq }));
  return {
    result: "committed",
    turnId: request.turn.id,
    committedAt: core.now,
    repeated: answer.repeated,
    parts: [],
    planner: null,
    core: [safetyRecordFor(request.turn.eventIds[0] ?? ""), ...answer.core],
    written: {
      written: answer.repeated
        ? []
        : [{ table: "phones", rowId: "handle-ben", version: benPhone?.version ?? 0 }],
      outboxRows: rows,
      promoted: [],
    },
    effects: [],
    openQuestions: { opened: [], closed: [] },
  } as unknown as GateAndCommitAnswer;
}

async function withStopRig(body: (rig: StopRig) => Promise<void>): Promise<void> {
  const answers: Record<string, SafetyResult> = {
    [STOP_EVENT]: safetyNoFor(STOP_EVENT),
    [START_EVENT]: safetyNoFor(START_EVENT),
  };
  const h = harness(keys, answers);
  const face = fakeTurnFace();
  const ai = fakeDecide(face.log);
  const reply = fakeReply(face.log);
  const facts = fakeFacts(BEN.party, [stopRecorded.request.now, START_NOW]);
  for (const [eventId, result] of Object.entries(answers)) facts.safety.set(eventId, result);
  const targets = fakeTargets();
  targets.answers.set(BEN.party.handleId, targetsAnswer(BEN.party.handleId, SAM_S1_02_TARGETS));
  // Ben's phone at version 3, as stop-recorded.json finds it (its STOP answers version 4, start-recorded.json's START 5).
  const core = fakeReplyCore(stopRecorded.request.now, [
    phone(BEN.handle.address, BEN.party.handleId, BEN.party.personId, 3),
  ]);
  face.gate = (request) => keywordGate(core, request);
  const planHold = hold(false);
  const planCalls: string[] = [];
  const restores = [
    setSafetyDeps(h.deps),
    setBatchHooks({ clock: h.clock }),
    setLeaseHooks(turnHooks),
    setBundleDeps(fakeBundles().deps),
    setTurnDeps(turnDeps(facts, face, ai, keys, reply)),
    setGuardDeps({ targets: targets.port }),
    setReplyDeps({
      core: turnReplyCore,
      rows: {
        unplannedRows: (request) => core.rows.unplannedRows(request),
        async writePlan(request) {
          planCalls.push(request.outboxRowId);
          await planHold.wait();
          return core.rows.writePlan(request);
        },
      },
      rosieNumber: ROSIE_NUMBER,
    }),
  ];
  const rig: StopRig = {
    face,
    reply,
    core,
    planHold,
    planCalls,
    get actor(): CopiesRpc {
      return actorOf(BEN);
    },
    async tick(ms) {
      await h.clock.advance(ms);
      await runDurableObjectAlarm(stubOf(BEN));
    },
    async settle() {
      await actorOf(BEN).safetyIdle();
      await actorOf(BEN).batchIdle();
    },
  };
  try {
    await body(rig);
  } finally {
    restores.reverse().forEach((restore) => {
      restore();
    });
  }
}

/** The row the core wrote for a reply line, by its fixed line. */
function replyRow(core: FakeCore, fixedLineId: string): FakeRow {
  const row = [...core.outbox.values()].find((entry) => entry.fixedLineId === fixedLineId);
  if (row === undefined) throw new Error(`no ${fixedLineId} row`);
  return row;
}

describe("the actor's copy of the stopped flag (K-04 phones.stopped)", () => {
  it("after STOP the actor's copy is set before the reply goes: once the commit answers, while the stop reply has no words and the dispatcher was not woken", async () => {
    await withStopRig(async (rig) => {
      const turnId = await turnIdOf([STOP_EVENT]);
      rig.face.gateHold.closed = true;
      rig.planHold.closed = true;
      await arrive(BEN, STOP_EVENT, "STOP", "2026-10-21T19:30:00Z");
      await rig.tick(3000);
      await until(() => rig.face.gateCalls.length === 1, "the STOP's commit at the gate");
      // The commit has not answered: nothing is copied yet.
      expect((await rig.actor.readCopies()).stopped).toBeNull();

      rig.face.gateHold.closed = false;
      await until(() => rig.planCalls.length === 1, "the stop reply's words being written");
      // The commit has answered and the reply has not gone: its row has no words yet and the dispatcher was not woken.
      const row = replyRow(rig.core, "stopReply");
      expect(rig.planCalls).toEqual([row.id]);
      expect(row.finalParts).toBeNull();
      expect(rig.reply.dispatcher.wakes).toEqual([]);
      expect((await rig.actor.readCopies()).stopped).toEqual({
        stopped: true,
        phoneVersion: 4,
        turnId,
        setAt: expect.any(Number) as number,
      });

      // Now the reply goes: its words are written and the dispatcher is woken for its row. The copy stays set.
      rig.planHold.closed = false;
      await rig.settle();
      expect(replyRow(rig.core, "stopReply").finalParts?.fixedLines).toEqual(["stopReply"]);
      expect(rig.reply.dispatcher.wakes).toHaveLength(1);
      expect(rig.reply.dispatcher.wakes[0]?.outboxRowIds).toContain(row.id);
      expect((await rig.actor.readCopies()).stopped).toMatchObject({ stopped: true, phoneVersion: 4 });
    });
  });

  it("START clears the copy the same way: once START's commit answers, before START's reply goes", async () => {
    await withStopRig(async (rig) => {
      await arrive(BEN, STOP_EVENT, "STOP", "2026-10-21T19:30:00Z");
      await rig.tick(3000);
      await rig.settle();
      expect((await rig.actor.readCopies()).stopped).toMatchObject({ stopped: true, phoneVersion: 4 });
      expect(rig.reply.dispatcher.wakes).toHaveLength(1);

      const turnId = await turnIdOf([START_EVENT]);
      rig.core.now = START_NOW;
      rig.face.gateHold.closed = true;
      rig.planHold.closed = true;
      await arrive(BEN, START_EVENT, "START", "2026-10-22T14:05:00Z");
      await rig.tick(3000);
      await until(() => rig.face.gateCalls.length === 2, "the START's commit at the gate");
      // Until START's commit answers, the copy still says stopped.
      expect((await rig.actor.readCopies()).stopped).toMatchObject({ stopped: true, phoneVersion: 4 });

      rig.face.gateHold.closed = false;
      await until(() => rig.planCalls.length === 2, "the start reply's words being written");
      const row = replyRow(rig.core, "startReply");
      expect(rig.planCalls[1]).toBe(row.id);
      expect(row.finalParts).toBeNull();
      expect(rig.reply.dispatcher.wakes).toHaveLength(1);
      expect((await rig.actor.readCopies()).stopped).toEqual({
        stopped: false,
        phoneVersion: 5,
        turnId,
        setAt: expect.any(Number) as number,
      });

      rig.planHold.closed = false;
      await rig.settle();
      expect(replyRow(rig.core, "startReply").finalParts?.fixedLines).toEqual(["startReply"]);
      expect(rig.reply.dispatcher.wakes).toHaveLength(2);
      expect((await rig.actor.readCopies()).stopped).toMatchObject({ stopped: false, phoneVersion: 5 });
    });
  });

  it("the phone row's version orders the writes: an older answer (a repeat of the STOP's commit after START) changes nothing", async () => {
    await withStopRig(async () => {
      const result = await runInDurableObject(stubOf(BEN), (instance) => {
        const { copies } = insideOf(instance);
        const taken = [
          copies.noteStopped({ stopped: false, phoneVersion: 5, turnId: "turn-ben-start" }),
          copies.noteStopped({ stopped: true, phoneVersion: 4, turnId: "turn-ben-stop" }),
          copies.noteStopped({ stopped: false, phoneVersion: 5, turnId: "turn-ben-start" }),
        ];
        return { taken, copy: copies.readStopped() };
      });
      expect(result.taken).toEqual([true, false, true]);
      expect(result.copy).toMatchObject({ stopped: false, phoneVersion: 5, turnId: "turn-ben-start" });
    });
  });

  it("the outage line never goes to a number the actor's copy says is stopped, even when the stopped flag the deps read says not", async () => {
    const h = harness(keys, {});
    const restore = setSafetyDeps(h.deps);
    try {
      await arrive(
        ALEX,
        "evt-alex-0300",
        "Can I get a haircut on Thursday afternoon?",
        "2026-10-21T19:30:00Z",
      );
      await runInDurableObject(stubOf(ALEX), (instance) => {
        insideOf(instance).copies.noteStopped({ stopped: true, phoneVersion: 4, turnId: null });
      });
      await h.clock.advance(4000);
      await actorOf(ALEX).safetyIdle();
      // No verdict in 4 s and no danger word: the outage line, but never to a stopped number.
      expect(h.stopped.value).toBe(false);
      expect(h.core.fixed).toEqual([]);
      expect(h.direct.sent).toEqual([]);
    } finally {
      restore();
    }
  });
});

// ---- the safety timers (K-34 safety_timers) ---------------------------------------------------------------------------

/** Sam, who sets the timer: K-34's seed timer is his (worker_handle_id handle-sam). */
const SAM_PARTY: Party = SAM;
const TIMER_EVENTS = ["evt-sam-0301", "evt-sam-0302", "evt-sam-0303", "evt-sam-0304"];

interface TimerRig {
  readonly api: FakeToolApi;
  readonly actor: CopiesRpc;
  /**
   * A text arrives, its batch closes and its turn commits through the lease (the Tool API double answers): once, or
   * `commits` times (2: the first answer was lost, and the same request was sent again).
   */
  text(eventId: string, commits?: number): Promise<void>;
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

async function withTimerRig(body: (rig: TimerRig) => Promise<void>): Promise<void> {
  const h: Harness = harness(keys, Object.fromEntries(TIMER_EVENTS.map((id) => [id, safetyNoFor(id)])));
  const api = fakeToolApi();
  const restores = [
    setSafetyDeps(h.deps),
    setBatchHooks({ clock: h.clock }),
    // The turn's work commits through the lease; the commit hook is the Tool API double. An answer lost on the way
    // (`noAnswer`) is sent again once, as the same request, as the turn does (../../turn/turn.ts `sendWithResend`).
    setLeaseHooks({
      runTurn: async (turn) => {
        const request = samCommit(turn);
        const answer = await turn.commit(request);
        if ("error" in answer && answer.error === "noAnswer") await turn.commit(request);
      },
      commit: (request, at) => api.commit(request, at),
    }),
    setBundleDeps(fakeBundles().deps),
    setCopyDeps({ timers: api.source }),
  ];
  let sent = 0;
  const rig: TimerRig = {
    api,
    get actor(): CopiesRpc {
      return actorOf(SAM_PARTY);
    },
    async text(eventId, commits = 1) {
      await arrive(SAM_PARTY, eventId, "TIMER 2 hours", "2026-10-27T13:20:00Z");
      await h.clock.advance(3000);
      await runDurableObjectAlarm(stubOf(SAM_PARTY));
      sent += commits;
      await until(() => api.commits.length === sent, "the turn's commit");
      await actorOf(SAM_PARTY).safetyIdle();
      await actorOf(SAM_PARTY).batchIdle();
    },
  };
  try {
    await body(rig);
  } finally {
    restores.reverse().forEach((restore) => {
      restore();
    });
  }
}

/** What the copy keeps of a K-34 row: its due time and zone, the address as K-34 seals it, the contact who said yes. */
function copyOf(row: SafetyTimerRow): Json {
  return {
    timerId: row.id,
    state: row.state,
    version: row.version,
    dueAt: row.due_at,
    dueZone: row.due_zone,
    address: row.address,
    addressFor: row.address_for_person_id,
    contact: { personId: row.emergency_contact_person_id, handleId: row.emergency_contact_handle_id },
    workerHandleId: row.worker_handle_id,
    clockRowId: row.clock_row_id,
    businessId: row.business_id,
    bookingId: row.booking_id,
    refreshedAt: expect.any(Number) as number,
  };
}

describe("the actor's copy of each live safety timer (K-34 safety_timers)", () => {
  it("a safety timer written through the Tool API fake appears in the actor copy with its due time, address and emergency contact", async () => {
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
    for (const spy of logs) spy.mockImplementation(() => undefined);
    await withTimerRig(async (rig) => {
      rig.api.writes.push(structuredClone(SAM_TIMER));
      await rig.text("evt-sam-0301");

      // The commit wrote the timer's row; the actor reloaded Sam's live timers by his K-04 handle id.
      expect(rig.api.reloads).toEqual(["handle-sam"]);
      const copies = await rig.actor.readCopies();
      expect(copies.timers).toEqual([copyOf(SAM_TIMER)]);
      expect(copies.timers[0]).toMatchObject({
        dueAt: "2026-10-27T15:20:00Z",
        dueZone: "America/New_York",
        address: SAM_TIMER.address,
        addressFor: "person-alex",
        contact: { personId: "person-morgan-lee", handleId: "handle-morgan-lee" },
      });
      expect(copies.timersStale).toBe(false);
    });
    // Never in a log line: the address (sealed as it is), or a contact's or customer's number.
    const lines = logs.flatMap((spy) => spy.mock.calls.map((call) => call.map(String).join(" ")));
    for (const line of lines) {
      expect(line).not.toContain(SAM_TIMER.address);
      expect(line).not.toContain("+15555550108");
    }
  });

  it("refreshed on every write: a timer moved, then marked safe, is copied again, then leaves the copy; a commit that writes no timer reads nothing", async () => {
    await withTimerRig(async (rig) => {
      rig.api.writes.push(structuredClone(SAM_TIMER));
      await rig.text("evt-sam-0301");
      expect((await rig.actor.readCopies()).timers).toEqual([copyOf(SAM_TIMER)]);

      // Moved an hour on (version 2).
      const moved: SafetyTimerRow = {
        ...structuredClone(SAM_TIMER),
        due_at: "2026-10-27T16:20:00Z",
        version: 2,
      };
      rig.api.writes.push(moved);
      await rig.text("evt-sam-0302");
      expect((await rig.actor.readCopies()).timers).toEqual([copyOf(moved)]);

      // A commit that writes no timer row reloads nothing.
      rig.api.writes.push(null);
      await rig.text("evt-sam-0303");
      expect(rig.api.reloads).toHaveLength(2);
      expect((await rig.actor.readCopies()).timers).toEqual([copyOf(moved)]);

      // SAFE: the row is safe (version 3), so it is no longer live and leaves the copy.
      rig.api.writes.push({
        ...structuredClone(moved),
        state: "safe",
        safe_at: "2026-10-27T15:05:00Z",
        version: 3,
      });
      await rig.text("evt-sam-0304");
      expect(rig.api.reloads).toHaveLength(3);
      expect((await rig.actor.readCopies()).timers).toEqual([]);
    });
  });

  it("a reload that fails keeps the copy as it was and marks it stale; the next commit reloads it", async () => {
    await withTimerRig(async (rig) => {
      rig.api.writes.push(structuredClone(SAM_TIMER));
      await rig.text("evt-sam-0301");

      const moved: SafetyTimerRow = {
        ...structuredClone(SAM_TIMER),
        due_at: "2026-10-27T16:20:00Z",
        version: 2,
      };
      rig.api.writes.push(moved);
      rig.api.reloadDown = true;
      await rig.text("evt-sam-0302");
      let copies = await rig.actor.readCopies();
      expect(copies.timers).toEqual([copyOf(SAM_TIMER)]);
      expect(copies.timersStale).toBe(true);

      // The next commit writes no timer, but the copy is stale: it reloads, and catches up with the move.
      rig.api.reloadDown = false;
      rig.api.writes.push(null);
      await rig.text("evt-sam-0303");
      copies = await rig.actor.readCopies();
      expect(rig.api.reloads).toHaveLength(3);
      expect(copies.timers).toEqual([copyOf(moved)]);
      expect(copies.timersStale).toBe(false);
    });
  });

  it("a reload answer that is not K-34's rows changes nothing: another handle's timer is not copied, and a row with no sealed address refuses the reload", async () => {
    await withTimerRig(async (rig) => {
      rig.api.writes.push(structuredClone(SAM_TIMER));
      await rig.text("evt-sam-0301");

      const result = await runInDurableObject(stubOf(SAM_PARTY), async (instance) => {
        const { copies } = insideOf(instance);
        const other = { ...structuredClone(SAM_TIMER), id: "timer-other", worker_handle_id: "handle-maya" };
        const restore = setCopyDeps({
          timers: { liveTimers: () => Promise.resolve({ result: "timers", timers: [SAM_TIMER, other] }) },
        });
        const otherHandle = await copies.refreshTimers("handle-sam");
        const afterOther = copies.readTimers().map((timer) => timer.timerId);
        setCopyDeps({
          timers: {
            liveTimers: () =>
              Promise.resolve({ result: "timers", timers: [{ ...structuredClone(SAM_TIMER), address: "" }] }),
          },
        });
        const noAddress = await copies.refreshTimers("handle-sam");
        restore();
        return { otherHandle, afterOther, noAddress, stale: copies.timersStale(), left: copies.readTimers() };
      });
      expect(result.otherHandle).toBe("refreshed");
      expect(result.afterOther).toEqual(["timer-sam-survey"]);
      expect(result.noAddress).toBe("failed");
      expect(result.stale).toBe(true);
      expect(result.left).toEqual([copyOf(SAM_TIMER)]);
    });
  });

  it("a timer row a core action wrote, which `written` leaves out, still reloads the copy: the actor reads the core result (T-1198); a commit that writes no timer still reads nothing", async () => {
    await withTimerRig(async (rig) => {
      // A later core action writes Sam's timer: its result names the row, and `written` leaves it out (actions/src/commit
      // default 9), its clock row too. The rows are written all the same.
      rig.api.timersByCore = LATER_TIMER_CALL;
      rig.api.writes.push(structuredClone(SAM_TIMER));
      await rig.text("evt-sam-0301");
      expect(rig.api.answers).toHaveLength(1);
      expect(rig.api.answers[0]).toMatchObject({
        result: "committed",
        repeated: false,
        committed: {
          core: [{ call: LATER_TIMER_CALL, response: { timerId: SAM_TIMER.id }, error: null }],
          written: { written: [] },
        },
      });
      expect(rig.api.reloads).toEqual(["handle-sam"]);
      let copies = await rig.actor.readCopies();
      expect(copies.timers).toEqual([copyOf(SAM_TIMER)]);
      expect(copies.timersStale).toBe(false);

      // Moved an hour on by the core action (version 2): copied again.
      const moved: SafetyTimerRow = {
        ...structuredClone(SAM_TIMER),
        due_at: "2026-10-27T16:20:00Z",
        version: 2,
      };
      rig.api.writes.push(moved);
      await rig.text("evt-sam-0302");
      expect(rig.api.reloads).toHaveLength(2);
      expect((await rig.actor.readCopies()).timers).toEqual([copyOf(moved)]);

      // A commit that writes no timer row, by the walk or a core action, reloads nothing.
      rig.api.writes.push(null);
      await rig.text("evt-sam-0303");
      expect(rig.api.answers[2]).toMatchObject({ committed: { core: [], written: { written: [] } } });
      expect(rig.api.reloads).toHaveLength(2);
      expect((await rig.actor.readCopies()).timers).toEqual([copyOf(moved)]);

      // SAFE by the core action (version 3): the row is no longer live and leaves the copy.
      rig.api.writes.push({
        ...structuredClone(moved),
        state: "safe",
        safe_at: "2026-10-27T15:05:00Z",
        version: 3,
      });
      await rig.text("evt-sam-0304");
      expect(rig.api.reloads).toHaveLength(3);
      copies = await rig.actor.readCopies();
      expect(copies.timers).toEqual([]);
      expect(copies.timersStale).toBe(false);
    });
  });

  it("a repeat after a lost first answer reloads the copy (T-1203): the first commit wrote Sam's timer row but its answer was lost, and the repeat answers with written []; a repeat with no timer written reloads harmlessly", async () => {
    await withTimerRig(async (rig) => {
      // The first commit writes Sam's timer row (its answer would list it), but the answer is lost on the way back: the
      // turn sends the same request again, and the repeat answers its first commit with no rows (K-05 v1 commitResult).
      const turnId = await turnIdOf(["evt-sam-0301"]);
      rig.api.writes.push(structuredClone(SAM_TIMER));
      rig.api.loseNextAnswer = true;
      await rig.text("evt-sam-0301", 2);
      expect(rig.api.commits.map((commit) => commit.turn.id)).toEqual([turnId, turnId]);
      expect(rig.api.timers.get(SAM_TIMER.id)).toEqual(SAM_TIMER);
      expect(rig.api.answers).toHaveLength(1);
      expect(rig.api.answers[0]).toMatchObject({
        result: "committed",
        repeated: true,
        committed: { repeated: true, core: [], written: { written: [], outboxRows: [], promoted: [] } },
      });
      // The actor reloaded Sam's live timers on the repeat: the copy holds the row.
      expect(rig.api.reloads).toEqual(["handle-sam"]);
      let copies = await rig.actor.readCopies();
      expect(copies.timers).toEqual([copyOf(SAM_TIMER)]);
      expect(copies.timersStale).toBe(false);

      // A first commit that wrote no timer row, its answer lost too: the repeat reloads, and the copy stays as it was.
      rig.api.writes.push(null);
      rig.api.loseNextAnswer = true;
      await rig.text("evt-sam-0302", 2);
      expect(rig.api.answers).toHaveLength(2);
      expect(rig.api.answers[1]).toMatchObject({
        repeated: true,
        committed: { repeated: true, core: [], written: { written: [] } },
      });
      expect(rig.api.reloads).toEqual(["handle-sam", "handle-sam"]);
      copies = await rig.actor.readCopies();
      expect(copies.timers).toEqual([copyOf(SAM_TIMER)]);
      expect(copies.timersStale).toBe(false);

      // A first answer that comes back keeps rules 1 and 2: it wrote no timer row, so nothing reloads.
      rig.api.writes.push(null);
      await rig.text("evt-sam-0303");
      expect(rig.api.answers[2]).toMatchObject({
        repeated: false,
        committed: { repeated: false, core: [], written: { written: [] } },
      });
      expect(rig.api.reloads).toHaveLength(2);
      expect((await rig.actor.readCopies()).timers).toEqual([copyOf(SAM_TIMER)]);
    });
  });
});

// ---- the checked safety lines (K-01) ------------------------------------------------------------------------------------

interface FixedLineFixture {
  id: string;
  text: string | null;
}

/** K-01's fixed line words by id (fixed-lines.json), and A3-24's checked line (bundle-mini-a.json), as the double reads them. */
function fixtureLine(id: string): string {
  const line = (fixedLines as { lines: FixedLineFixture[] }).lines.find((entry) => entry.id === id);
  if (line?.text === undefined || line.text === null) throw new Error(`no words for ${id}`);
  return line.text;
}

const A3_24 = (bundleMiniA.flows.A.steps as Record<string, { say?: { text: string }[] }>)["A3-24"]?.say?.[0]
  ?.text;

describe("the actor's copy of the checked safety lines (K-01 fixed lines and the outcome steps' lines)", () => {
  it("each written text copies the safety read's checked lines from its bundle; a line the bundle no longer gives keeps its words, and new words replace old ones", async () => {
    const texts = ["evt-alex-0301", "evt-alex-0302", "evt-alex-0303"];
    const h = harness(keys, Object.fromEntries(texts.map((id) => [id, safetyNoFor(id)])));
    const restore = setSafetyDeps(h.deps);
    try {
      await arrive(
        ALEX,
        "evt-alex-0301",
        "Can I get a haircut on Thursday afternoon?",
        "2026-10-21T19:30:00Z",
      );
      await actorOf(ALEX).safetyIdle();
      const expected = [
        { slot: "fixed:outage", lineId: "outage", text: fixtureLine("outage") },
        { slot: "fixed:safetyAsk", lineId: "safetyAsk", text: fixtureLine("safetyAsk") },
        { slot: "fixed:safetyCrisis", lineId: "safetyCrisis", text: fixtureLine("safetyCrisis") },
        { slot: "fixed:safetyEmergency", lineId: "safetyEmergency", text: fixtureLine("safetyEmergency") },
        { slot: "outcome:emergency", lineId: "safetyEmergency", text: A3_24 },
      ];
      expect((await actorOf(ALEX).readCopies()).lines).toEqual(
        expected.map((line) => ({ ...line, refreshedAt: expect.any(Number) as number })),
      );

      // The bundle cannot be read now: every line throws. The copy keeps every line it has.
      h.deps.bundle = {
        fixedLine: () => {
          throw new Error("KV is not answering");
        },
        outcomeLine: () => null,
        dangerWords: () => [],
      };
      await arrive(ALEX, "evt-alex-0302", "Thursday at 3 works", "2026-10-21T19:31:00Z");
      await actorOf(ALEX).safetyIdle();
      expect(
        (await actorOf(ALEX).readCopies()).lines.map(({ slot, lineId, text }) => ({ slot, lineId, text })),
      ).toEqual(expected);

      // A bundle with new words for the outage line: that line alone changes.
      const fixture = fixtureBundle();
      h.deps.bundle = {
        ...fixture,
        fixedLine: (id) =>
          id === "outage" ? { id: "outage", text: "Test words for the outage line." } : fixture.fixedLine(id),
      };
      await arrive(ALEX, "evt-alex-0303", "Thanks", "2026-10-21T19:32:00Z");
      await actorOf(ALEX).safetyIdle();
      const lines = (await actorOf(ALEX).readCopies()).lines.map(({ slot, lineId, text }) => ({
        slot,
        lineId,
        text,
      }));
      expect(lines).toEqual(
        expected.map((line) =>
          line.slot === "fixed:outage" ? { ...line, text: "Test words for the outage line." } : line,
        ),
      );
    } finally {
      restore();
    }
  });
});

// ---- the write-on-return queue ----------------------------------------------------------------------------------------

/** One K-09 request to queue: its call, its rank on return, its key and the request itself. */
interface Pending {
  key: string;
  call: string;
  rank: ReturnWrite["rank"];
  request: unknown;
}

const stopAction = stopRecorded.request.core[1];

/** Ben's writes, in the order queued: an outage line's record, his STOP, a danger record, his START, a second danger record. */
const BEN_WRITES: Pending[] = [
  {
    key: "sendFixedLine:evt-ben-0006",
    call: "sendFixedLine",
    rank: "rest",
    request: {
      caller: {
        kind: "job",
        turnId: null,
        requestId: "safety:evt-ben-0006",
        businessId: null,
        personId: "person-ben",
        traceId: TRACE,
      },
      fixedLineId: "outage",
      recipientHandleId: "handle-ben",
      sendClass: "quick_reply",
      sentByActor: {
        at: "2026-10-21T19:29:04Z",
        fixedLineId: "outage",
        linqMessageId: "linq-msg-ben-outage-1",
      },
    },
  },
  {
    key: "recordStopOrStart:evt-ben-0007",
    call: "recordStopOrStart",
    rank: "stop",
    request: stopAction?.request ?? null,
  },
  {
    key: "recordSafetyOutcome:evt-ben-0008",
    call: "recordSafetyOutcome",
    rank: "danger",
    request: {
      caller: {
        kind: "job",
        turnId: null,
        requestId: "safety:evt-ben-0008",
        businessId: null,
        personId: "person-ben",
        traceId: TRACE,
      },
      safety: { ...(safetyEmergencyNow as unknown as SafetyResult), eventId: "evt-ben-0008" },
      handleId: "handle-ben",
      bookingId: null,
      sentByActor: {
        at: "2026-10-21T19:40:01Z",
        fixedLineId: "safetyEmergency",
        linqMessageId: "linq-msg-ben-911-1",
      },
    },
  },
  {
    key: "recordStopOrStart:evt-ben-0011",
    call: "recordStopOrStart",
    rank: "stop",
    request: startRecorded.request,
  },
  {
    key: "recordSafetyOutcome:evt-ben-0012",
    call: "recordSafetyOutcome",
    rank: "danger",
    request: {
      caller: {
        kind: "job",
        turnId: null,
        requestId: "safety:evt-ben-0012",
        businessId: null,
        personId: "person-ben",
        traceId: TRACE,
      },
      safety: { ...(safetyEmergencyNow as unknown as SafetyResult), eventId: "evt-ben-0012" },
      handleId: "handle-ben",
      bookingId: null,
      sentByActor: {
        at: "2026-10-22T14:30:01Z",
        fixedLineId: "safetyEmergency",
        linqMessageId: "linq-msg-ben-911-2",
      },
    },
  },
];

/** The order on return (arch 11 line 566): danger, stops, then the rest, each in the order queued. */
const RETURN_ORDER = [
  "recordSafetyOutcome:evt-ben-0008",
  "recordSafetyOutcome:evt-ben-0012",
  "recordStopOrStart:evt-ben-0007",
  "recordStopOrStart:evt-ben-0011",
  "sendFixedLine:evt-ben-0006",
];

/** A request sealed under Ben's key, bound to its write's key, as a producer queues it. */
async function sealed(pending: Pending): Promise<ReturnWrite> {
  const key = await keys.getOrCreateKey(BEN.handle);
  const box = await sealWords(
    { body: JSON.stringify(pending.request), subject: null },
    key,
    actorNameOf(BEN.handle),
    `return:${pending.key}`,
  );
  return { key: pending.key, call: pending.call, rank: pending.rank, box: JSON.stringify(box) };
}

/** Opens a queued write's box as its producer does: the request it holds. */
async function opened(write: QueuedWrite): Promise<unknown> {
  const key = await keys.getOrCreateKey(BEN.handle);
  const words = await openWords(
    JSON.parse(write.box) as SealedBox,
    key,
    actorNameOf(BEN.handle),
    `return:${write.key}`,
  );
  return JSON.parse(words.body ?? "null");
}

/** The shared core as the replay reaches it: each write's answer by key (written unless the test says otherwise). */
interface ReplayCore {
  /** Every write sent, by key, in order, with the request its box held. */
  readonly sent: { key: string; request: unknown }[];
  /** Every write the core took, by key, in the order it took them. */
  readonly taken: string[];
  /** The answer for each key; unset: written. */
  readonly steps: Map<string, ReplayStep>;
  send(write: QueuedWrite): Promise<ReplayStep>;
}

function replayCore(): ReplayCore {
  const fake: ReplayCore = {
    sent: [],
    taken: [],
    steps: new Map(),
    async send(write) {
      fake.sent.push({ key: write.key, request: await opened(write) });
      const step = fake.steps.get(write.key) ?? "written";
      if (step === "written") fake.taken.push(write.key);
      return step;
    },
  };
  return fake;
}

/**
 * Queues Ben's writes in his actor's own queue, then runs `body` inside the actor with the queue, a replay core and the
 * actor's copies.
 */
async function withBensQueue<T>(
  body: (queue: ReturnQueue, core: ReplayCore, copies: ActorCopies) => Promise<T>,
): Promise<T> {
  const writes = await Promise.all(BEN_WRITES.map(sealed));
  return runInDurableObject(stubOf(BEN), async (instance) => {
    const { returns: queue, copies } = insideOf(instance);
    for (const write of writes) expect(queue.enqueue(write)).toBe("queued");
    return body(queue, replayCore(), copies);
  });
}

const STOP_KEY = "recordStopOrStart:evt-ben-0007";
const START_KEY = "recordStopOrStart:evt-ben-0011";

describe("the write-on-return queue", () => {
  it("replays in order and once: danger, then stops, then the rest, each in the order queued; a second replay sends nothing", async () => {
    const result = await withBensQueue(async (queue, core) => {
      const first = await queue.replay((write) => core.send(write));
      const second = await queue.replay((write) => core.send(write));
      return { first, second, sent: core.sent, left: queue.read() };
    });
    expect(result.sent.map((entry) => entry.key)).toEqual(RETURN_ORDER);
    // Each box held the request queued, unchanged.
    for (const entry of result.sent) {
      expect(entry.request).toEqual(BEN_WRITES.find((pending) => pending.key === entry.key)?.request);
    }
    expect(result.first).toEqual({ written: 5, refused: 0, left: 0 });
    expect(result.second).toEqual({ written: 0, refused: 0, left: 0 });
    expect(result.left).toEqual([]);
  });

  it("two replays at once send each write once", async () => {
    const result = await withBensQueue(async (queue, core) => {
      const [a, b] = await Promise.all([
        queue.replay((write) => core.send(write)),
        queue.replay((write) => core.send(write)),
      ]);
      return { reports: [a, b], sent: core.sent.map((entry) => entry.key) };
    });
    expect(result.sent).toEqual(RETURN_ORDER);
    expect(result.reports.map((report) => report.written).sort()).toEqual([0, 5]);
  });

  it("still down: the write the core is not answering for stops the replay there, and the next replay starts from it again, in order", async () => {
    const result = await withBensQueue(async (queue, core) => {
      // The core takes the first danger record, then answers transient (PostgreSQL still down) for the second.
      core.steps.set("recordSafetyOutcome:evt-ben-0012", "notBack");
      const first = await queue.replay((write) => core.send(write));
      const sentFirst = core.sent.map((entry) => entry.key);
      const waiting = queue.read().map((entry) => ({ key: entry.key, tries: entry.tries }));
      core.steps.delete("recordSafetyOutcome:evt-ben-0012");
      const second = await queue.replay((write) => core.send(write));
      return { first, sentFirst, waiting, second, sentAll: core.sent.map((entry) => entry.key) };
    });
    expect(result.sentFirst).toEqual(RETURN_ORDER.slice(0, 2));
    expect(result.first).toEqual({ written: 1, refused: 0, left: 4 });
    expect(result.waiting).toEqual([
      { key: "recordSafetyOutcome:evt-ben-0012", tries: 1 },
      { key: "recordStopOrStart:evt-ben-0007", tries: 0 },
      { key: "recordStopOrStart:evt-ben-0011", tries: 0 },
      { key: "sendFixedLine:evt-ben-0006", tries: 0 },
    ]);
    expect(result.second).toEqual({ written: 4, refused: 0, left: 0 });
    // The taken write never went again; the one that waited went first on return.
    expect(result.sentAll).toEqual([...RETURN_ORDER.slice(0, 2), ...RETURN_ORDER.slice(1)]);
  });

  it("a send that throws is the core not answering: nothing after it goes", async () => {
    const result = await withBensQueue(async (queue) => {
      const sent: string[] = [];
      const report = await queue.replay((write) => {
        sent.push(write.key);
        return Promise.reject(new Error("PostgreSQL is down"));
      });
      return { report, sent };
    });
    expect(result.sent).toEqual([RETURN_ORDER[0]]);
    expect(result.report).toEqual({ written: 0, refused: 0, left: 5 });
  });

  it("a write the core refuses is kept with its code and holds its rank: nothing queued after it in that rank goes before it, the other ranks go on, and once it is taken on a later replay the writes after it follow in their queued order; a write queued again once written is never replayed", async () => {
    const result = await withBensQueue(async (queue, core) => {
      // The core refuses Ben's STOP (versionChanged, a refusal that can pass on a retry), and takes it on the next replay.
      core.steps.set(STOP_KEY, { refused: "versionChanged" });
      const first = await queue.replay((write) => core.send(write));
      const kept = queue.read();
      const held = queue.held();
      core.steps.delete(STOP_KEY);
      const second = await queue.replay((write) => core.send(write));
      const heldAfter = queue.held();
      // START written already: queued again, it is known as done and never sent again.
      const again = queue.enqueue(await sealed(benWrite(3)));
      const third = await queue.replay((write) => core.send(write));
      return {
        first,
        kept,
        held,
        second,
        heldAfter,
        again,
        third,
        sent: core.sent.map((entry) => entry.key),
        taken: core.taken,
      };
    });
    // The STOP held the stop rank: the START queued after it was not sent. Danger and the rest went on.
    expect(result.first).toEqual({ written: 3, refused: 1, left: 2 });
    expect(result.kept).toEqual([
      {
        seq: expect.any(Number) as number,
        key: STOP_KEY,
        call: "recordStopOrStart",
        rank: "stop",
        tries: 1,
        refused: "versionChanged",
      },
      {
        seq: expect.any(Number) as number,
        key: START_KEY,
        call: "recordStopOrStart",
        rank: "stop",
        tries: 0,
        refused: null,
      },
    ]);
    expect(result.held).toEqual([
      { rank: "stop", key: STOP_KEY, code: "versionChanged", since: expect.any(Number) as number },
    ]);
    // Taken on the next replay, the STOP goes first and the START follows it; the rank, written through, is let go.
    expect(result.second).toEqual({ written: 2, refused: 0, left: 0 });
    expect(result.heldAfter).toEqual([]);
    expect(result.again).toBe("done");
    expect(result.third).toEqual({ written: 0, refused: 0, left: 0 });
    expect(result.sent).toEqual([
      "recordSafetyOutcome:evt-ben-0008",
      "recordSafetyOutcome:evt-ben-0012",
      STOP_KEY,
      "sendFixedLine:evt-ben-0006",
      STOP_KEY,
      START_KEY,
    ]);
    // The stop records reached the core in the order they were queued: Ben's STOP, then his START.
    expect(result.taken.filter((key) => key.startsWith("recordStopOrStart:"))).toEqual([STOP_KEY, START_KEY]);
  });

  it("a replay never lifts a stop: an older START refused with versionChanged, then a newer STOP; the STOP waits for the START, and Ben's phones.stopped ends true, as his last word was STOP", async () => {
    // Sent by Ben's actor while PostgreSQL was down: his START (start-recorded.json), then a newer STOP from his phone.
    const start: Pending = {
      key: START_KEY,
      call: "recordStopOrStart",
      rank: "stop",
      request: startRecorded.request,
    };
    const newerStop: Pending = {
      key: "recordStopOrStart:evt-ben-0013",
      call: "recordStopOrStart",
      rank: "stop",
      request: {
        ...stopOnReturn.request,
        caller: {
          ...stopOnReturn.request.caller,
          requestId: "evt-ben-0013",
          personId: "person-ben",
          traceId: "trace-ben-0013",
        },
        phoneNumber: BEN.handle.address,
        inboundEventId: "evt-ben-0013",
        sentByActor: {
          at: "2026-10-22T14:20:11Z",
          fixedLineId: "stopReply",
          linqMessageId: "linq-msg-ben-stop-2",
        },
      },
    };
    const writes = [await sealed(start), await sealed(newerStop)];
    const result = await runInDurableObject(stubOf(BEN), async (instance) => {
      const { returns: queue, copies } = insideOf(instance);
      for (const write of writes) expect(queue.enqueue(write)).toBe("queued");
      const core = replayCore();
      // K-04 phones for Ben's number as the core keeps it: stopped since stop-recorded.json, at version 4.
      const bensPhone = { stopped: true, version: 4 };
      const send = async (write: QueuedWrite): Promise<ReplayStep> => {
        const step = await core.send(write);
        const request = core.sent.at(-1)?.request as { kind?: string } | undefined;
        if (step === "written") {
          bensPhone.stopped = request?.kind === "stop";
          bensPhone.version += 1;
        }
        return step;
      };
      core.steps.set(start.key, { refused: "versionChanged" });
      const first = await queue.replay(send);
      const afterFirst = {
        phone: { ...bensPhone },
        sent: core.sent.map((entry) => entry.key),
        copy: copies.readStopped(),
      };
      core.steps.delete(start.key);
      const second = await queue.replay(send);
      return { first, afterFirst, second, phone: bensPhone, taken: core.taken, copy: copies.readStopped() };
    });
    // First replay: the START is refused, and the newer STOP is not written ahead of it.
    expect(result.first).toEqual({ written: 0, refused: 1, left: 2 });
    expect(result.afterFirst.sent).toEqual([start.key]);
    expect(result.afterFirst.phone).toEqual({ stopped: true, version: 4 });
    // Meanwhile the actor's copy keeps the stricter reading.
    expect(result.afterFirst.copy).toMatchObject({
      stopped: true,
      held: { key: start.key, code: "versionChanged" },
    });
    // Next replay: the START is taken, then the STOP after it. The phone ends stopped.
    expect(result.second).toEqual({ written: 2, refused: 0, left: 0 });
    expect(result.taken).toEqual([start.key, newerStop.key]);
    expect(result.phone).toEqual({ stopped: true, version: 6 });
    // Every stop or start record written in order: the hold is let go (nothing else was copied here).
    expect(result.copy).toBeNull();
  });

  it("a stop record the core can never take holds the stop rank with its code on every replay, and the actor's copy reads stopped meanwhile, whatever was copied last", async () => {
    const result = await withBensQueue(async (queue, core, copies) => {
      // Ben's copy says not stopped: his START was copied last (phone version 5).
      copies.noteStopped({ stopped: false, phoneVersion: 5, turnId: "turn-ben-start" });
      const before = copies.readStopped();
      // The core refuses Ben's STOP on every replay (notFromThatPhone never passes).
      core.steps.set(STOP_KEY, { refused: "notFromThatPhone" });
      const reports: ReplayReport[] = [];
      const copiesSeen: (StoppedCopy | null)[] = [];
      for (let replay = 0; replay < 3; replay += 1) {
        reports.push(await queue.replay((write) => core.send(write)));
        copiesSeen.push(copies.readStopped());
      }
      return {
        before,
        reports,
        copiesSeen,
        kept: queue.read(),
        held: queue.held(),
        sent: core.sent.map((entry) => entry.key),
      };
    });
    expect(result.before).toMatchObject({ stopped: false, phoneVersion: 5 });
    expect(result.reports).toEqual([
      { written: 3, refused: 1, left: 2 },
      { written: 0, refused: 1, left: 2 },
      { written: 0, refused: 1, left: 2 },
    ]);
    // The START queued after the STOP was never sent: the STOP holds the rank, kept with its code.
    expect(result.sent).toEqual([
      "recordSafetyOutcome:evt-ben-0008",
      "recordSafetyOutcome:evt-ben-0012",
      STOP_KEY,
      "sendFixedLine:evt-ben-0006",
      STOP_KEY,
      STOP_KEY,
    ]);
    expect(result.kept.map(({ key, tries, refused }) => ({ key, tries, refused }))).toEqual([
      { key: STOP_KEY, tries: 3, refused: "notFromThatPhone" },
      { key: START_KEY, tries: 0, refused: null },
    ]);
    expect(result.held).toEqual([
      { rank: "stop", key: STOP_KEY, code: "notFromThatPhone", since: expect.any(Number) as number },
    ]);
    // The stricter reading on every replay; what was copied last is kept beside it.
    for (const copy of result.copiesSeen) {
      expect(copy).toEqual({
        stopped: true,
        phoneVersion: 5,
        turnId: "turn-ben-start",
        setAt: expect.any(Number) as number,
        held: { key: STOP_KEY, code: "notFromThatPhone", since: result.held[0]?.since },
      });
    }
  });

  it("what lets the stricter reading go: the refused write taken on a later replay, then every stop or start record after it written in order; until the START is written, the copy still reads stopped", async () => {
    const result = await withBensQueue(async (queue, core, copies) => {
      copies.noteStopped({ stopped: false, phoneVersion: 5, turnId: "turn-ben-start" });
      core.steps.set(STOP_KEY, { refused: "versionChanged" });
      await queue.replay((write) => core.send(write));
      const refusedCopy = copies.readStopped();
      // The STOP is taken now, but the core gives the START after it no answer.
      core.steps.delete(STOP_KEY);
      core.steps.set(START_KEY, "notBack");
      const takenStop = await queue.replay((write) => core.send(write));
      const beforeStart = copies.readStopped();
      // The START is written: every stop or start record queued is written, in order.
      core.steps.delete(START_KEY);
      const writtenStart = await queue.replay((write) => core.send(write));
      return {
        refusedCopy,
        takenStop,
        beforeStart,
        writtenStart,
        after: copies.readStopped(),
        held: queue.held(),
        taken: core.taken,
      };
    });
    expect(result.refusedCopy).toMatchObject({ stopped: true, held: { key: STOP_KEY } });
    expect(result.takenStop).toEqual({ written: 1, refused: 0, left: 1 });
    expect(result.beforeStart).toMatchObject({
      stopped: true,
      held: { key: STOP_KEY, code: "versionChanged" },
    });
    expect(result.writtenStart).toEqual({ written: 1, refused: 0, left: 0 });
    // Let go: the copy reads what was copied last again, with no hold.
    expect(result.after).toEqual({
      stopped: false,
      phoneVersion: 5,
      turnId: "turn-ben-start",
      setAt: expect.any(Number) as number,
    });
    expect(result.held).toEqual([]);
    expect(result.taken.filter((key) => key.startsWith("recordStopOrStart:"))).toEqual([STOP_KEY, START_KEY]);
  });

  it("the danger rank keeps its own first-in order under the same rule: a refused danger record holds the danger rank while the stops and the rest go on, and the stopped copy is not touched", async () => {
    const firstDanger = "recordSafetyOutcome:evt-ben-0008";
    const secondDanger = "recordSafetyOutcome:evt-ben-0012";
    const result = await withBensQueue(async (queue, core, copies) => {
      core.steps.set(firstDanger, { refused: "bookingPaused" });
      const first = await queue.replay((write) => core.send(write));
      const kept = queue.read().map(({ key, tries, refused }) => ({ key, tries, refused }));
      const held = queue.held();
      const copy = copies.readStopped();
      core.steps.delete(firstDanger);
      const second = await queue.replay((write) => core.send(write));
      return {
        first,
        kept,
        held,
        copy,
        second,
        heldAfter: queue.held(),
        sent: core.sent.map((entry) => entry.key),
        taken: core.taken,
      };
    });
    expect(result.first).toEqual({ written: 3, refused: 1, left: 2 });
    expect(result.kept).toEqual([
      { key: firstDanger, tries: 1, refused: "bookingPaused" },
      { key: secondDanger, tries: 0, refused: null },
    ]);
    expect(result.held).toEqual([
      { rank: "danger", key: firstDanger, code: "bookingPaused", since: expect.any(Number) as number },
    ]);
    expect(result.copy).toBeNull();
    expect(result.second).toEqual({ written: 2, refused: 0, left: 0 });
    expect(result.heldAfter).toEqual([]);
    expect(result.sent).toEqual([
      firstDanger,
      STOP_KEY,
      START_KEY,
      "sendFixedLine:evt-ben-0006",
      firstDanger,
      secondDanger,
    ]);
    // The danger records reached the core in the order they were queued.
    expect(result.taken.filter((key) => key.startsWith("recordSafetyOutcome:"))).toEqual([
      firstDanger,
      secondDanger,
    ]);
  });

  it("a write queued again while it waits keeps its place with the newer box; the queue keeps boxes only, never the words or number in plain", async () => {
    const stop = { ...stopOnReturn.request, phoneNumber: BEN.handle.address, inboundEventId: "evt-ben-0007" };
    const newer = await sealed({ ...benWrite(1), request: stop });
    const result = await withBensQueue(async (queue, core) => {
      const again = queue.enqueue(newer);
      const order = queue.read().map((entry) => entry.key);
      const boxes = insideOfQueueStorage(queue).map((row) => row.box);
      await queue.replay((write) => core.send(write));
      return {
        again,
        order,
        boxes,
        sentStop: core.sent.find((entry) => entry.key === "recordStopOrStart:evt-ben-0007"),
      };
    });
    expect(result.again).toBe("requeued");
    expect(result.order).toEqual(RETURN_ORDER);
    expect(result.sentStop?.request).toEqual(stop);
    for (const box of result.boxes) {
      expect(box).not.toContain(BEN.handle.address);
      expect(box).not.toContain("STOP");
      expect(box).not.toContain("START");
      expect(Object.keys(JSON.parse(box) as Json).sort()).toEqual(["alg", "ct", "iv", "v"]);
    }
  });
});

/** One of Ben's writes, by its place in the order queued. */
function benWrite(index: number): Pending {
  const pending = BEN_WRITES[index];
  if (pending === undefined) throw new Error("no such write");
  return pending;
}

/** The queue's stored rows, as its storage holds them (box included), in replay order. */
function insideOfQueueStorage(queue: ReturnQueue): { key: string; box: string }[] {
  const storage = (queue as unknown as { host: { storage: DurableObjectStorage } }).host.storage;
  return storage.sql
    .exec<{ key: string; box: string }>("SELECT key, box FROM return_queue ORDER BY rank, seq")
    .toArray();
}

describe("the write-on-return queue, with the safety read's records", () => {
  it("with PostgreSQL down, the outage line's record and a danger line's record wait as labels; back up, the danger record is written first, each once, and its hold id lands", async () => {
    const danger = safetyEmergencyNow as unknown as SafetyResult;
    const h = harness(keys, { [danger.eventId]: danger });
    const order: string[] = [];
    const record = h.core.recordSafetyOutcome.bind(h.core);
    const fixed = h.core.sendFixedLine.bind(h.core);
    h.core.recordSafetyOutcome = (request) => {
      order.push(`record:${request.safety.eventId}`);
      return record(request);
    };
    h.core.sendFixedLine = (request) => {
      order.push(`fixed:${request.caller.requestId}`);
      return fixed(request);
    };
    const restore = setSafetyDeps(h.deps);
    try {
      h.core.down = true;
      // First a text the read gives no verdict for (the outage line), then the emergency (its safety line).
      await arrive(
        ALEX,
        "evt-alex-0299",
        "Can I get a haircut on Thursday afternoon?",
        "2026-10-22T16:40:00Z",
      );
      await h.clock.advance(4000);
      await actorOf(ALEX).safetyIdle();
      await arrive(
        ALEX,
        danger.eventId,
        "my lips are swelling after the beard color and I can't breathe well",
        "2026-10-22T16:41:00Z",
      );
      await actorOf(ALEX).safetyIdle();
      expect(h.direct.sent.map((sent) => sent.fixedLineId)).toEqual(["outage", "safetyEmergency"]);

      // Both records wait, the danger one first; a reader sees labels only.
      expect((await actorOf(ALEX).readCopies()).returns).toEqual([
        {
          seq: 2,
          key: `recordSafetyOutcome:${danger.eventId}`,
          call: "recordSafetyOutcome",
          rank: "danger",
          tries: 0,
          refused: null,
        },
        {
          seq: 1,
          key: "sendFixedLine:evt-alex-0299",
          call: "sendFixedLine",
          rank: "rest",
          tries: 0,
          refused: null,
        },
      ]);

      // Still down: the first write gets no answer, and nothing after it goes.
      order.length = 0;
      expect(await actorOf(ALEX).writeOnReturn()).toEqual({ written: 0, refused: 0, left: 2 });
      expect(order).toEqual([`record:${danger.eventId}`]);

      // Back up: danger first, then the rest, each once, as written on return with what the actor sent.
      h.core.down = false;
      order.length = 0;
      expect(await actorOf(ALEX).writeOnReturn()).toEqual({ written: 2, refused: 0, left: 0 });
      expect(order).toEqual([`record:${danger.eventId}`, "fixed:safety:evt-alex-0299"]);
      expect(h.core.recorded.map((call) => call.request.caller.kind)).toEqual(["actorOnReturn"]);
      expect(h.core.recorded[0]?.request.sentByActor).toMatchObject({ fixedLineId: "safetyEmergency" });
      expect(h.core.fixed.map((call) => call.request.caller.kind)).toEqual(["actorOnReturn"]);
      expect(h.core.fixed[0]?.request.sentByActor).toMatchObject({ fixedLineId: "outage" });
      expect(await actorOf(ALEX).readHolds()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ eventId: danger.eventId, holdId: `hold-${danger.eventId}` }),
        ]),
      );

      // Again: nothing is written twice.
      order.length = 0;
      expect(await actorOf(ALEX).writeOnReturn()).toEqual({ written: 0, refused: 0, left: 0 });
      expect(order).toEqual([]);
      expect(h.direct.sent).toHaveLength(2);
    } finally {
      restore();
    }
  });
});

// ---- what a commit says -----------------------------------------------------------------------------------------------

describe("what a commit gives the copies", () => {
  it("reads the last recordStopOrStart the core took, and whether a K-34 timer row was written, from K-09's or K-05's answer", () => {
    const stop = readCommit(stopRecorded.outcome);
    expect(stop).toEqual({ stopped: { stopped: true, phoneVersion: 4 }, timersWritten: false });
    // A STOP then a START in one commit: the last decides.
    const both = {
      ...stopRecorded.outcome,
      core: [
        ...stopRecorded.outcome.core,
        { call: "recordStopOrStart", response: startRecorded.outcome, error: null },
      ],
    };
    expect(readCommit(both).stopped).toEqual({ stopped: false, phoneVersion: 5 });
    // A refused STOP writes nothing, so it copies nothing.
    const refused = {
      ...stopRecorded.outcome,
      core: [{ call: "recordStopOrStart", response: null, error: { error: "notFromThatPhone" } }],
    };
    expect(readCommit(refused).stopped).toBeNull();
    // K-05's own commitResult (no core results) and a timer row.
    expect(
      readCommit({
        written: [{ table: "safety_timers", rowId: SAM_TIMER.id, version: 1 }],
        outboxRows: [],
        promoted: [],
      }),
    ).toEqual({ stopped: null, timersWritten: true });
    expect(readCommit(null)).toEqual({ stopped: null, timersWritten: false });
    expect(readCommit({ core: "not a list", written: "nor this" })).toEqual({
      stopped: null,
      timersWritten: false,
    });
  });
});

// ---- a safety timer a core action wrote (T-1198) ------------------------------------------------------------------------

/** K-09 v1's core actions, by call name, as its coreAction lists them (v1.1 to v1.6 take that list by reference). */
const K09_CORE_CALLS = (
  k09v1 as unknown as { $defs: { coreAction: { oneOf: { properties: { call: { const: string } } }[] } } }
).$defs.coreAction.oneOf.map((action) => action.properties.call.const);

/** K-09 gateAndCommit.committed for a turn of Sam's, with the core results and the rows `written` lists that a test gives. */
function samCommitted(core: unknown[], written: unknown[], repeated = false): Json {
  return {
    result: "committed",
    turnId: "turn-sam-timer",
    committedAt: "2026-10-27T13:20:02Z",
    repeated,
    parts: [],
    planner: null,
    core,
    written: { written, outboxRows: [], promoted: [] },
    effects: [],
    openQuestions: { opened: [], closed: [] },
  };
}

/** A later core action's result, gone through: it wrote Sam's timer row and its clock row, named in its own words. */
const TIMER_BY_CORE = {
  call: LATER_TIMER_CALL,
  response: { timerId: SAM_TIMER.id, version: 1 },
  error: null,
};

/**
 * Core results that are not K-09's coreResult, by DL-413's fail-safe shapes: not a record, or no string call; no error
 * field; error null but a response that is not a record; an error that is not K-09's refusal (a JSON object with its own
 * "error" code). Where one has a call, it is mostly one of K-09's own, whose well-formed result reads no.
 */
const NOT_K09_RESULTS: unknown[] = [
  // Not a record, or no string call.
  "not a result",
  null,
  7,
  [{ call: "recordSafetyOutcome", response: {}, error: null }],
  { response: { timerId: SAM_TIMER.id, version: 1 }, error: null },
  { call: 7, response: {}, error: null },
  // No error field.
  { call: LATER_TIMER_CALL },
  { call: "recordSafetyOutcome", response: {} },
  { call: "recordSafetyOutcome", response: {}, error: undefined },
  // Error null, but a response that is not a record.
  { call: "recordSafetyOutcome", response: null, error: null },
  { call: "releaseSafetyHold", error: null },
  { call: "sendFixedLine", response: [], error: null },
  { call: LATER_TIMER_CALL, response: "written", error: null },
  // An error that is not K-09's refusal.
  { call: "recordSafetyOutcome", response: null, error: "transient" },
  { call: "recordSafetyOutcome", response: null, error: {} },
  { call: "recordSafetyOutcome", response: null, error: { error: 7 } },
];

describe("what a commit gives the copies: a safety timer a core action wrote (T-1198)", () => {
  it("learns of it from the core results, never from `written` alone: a later core action's result that went through reads written, though K-09's `written` leaves its rows out; refused, it wrote nothing", () => {
    const record = safetyRecordFor("evt-sam-0301");
    // The text's safety record first, then the later core action; `written` lists none of their rows (default 9).
    expect(readCommit(samCommitted([record, TIMER_BY_CORE], []))).toEqual({
      stopped: null,
      timersWritten: true,
    });
    // A repeat answers its first commit, whose rows were written: it reloads too.
    expect(readCommit(samCommitted([record, TIMER_BY_CORE], [], true)).timersWritten).toBe(true);
    // Refused, the core action wrote nothing: nothing to reload.
    const refused = { call: LATER_TIMER_CALL, response: null, error: { error: "transient" } };
    expect(readCommit(samCommitted([record, refused], [])).timersWritten).toBe(false);
    // A core result that is not K-09's shape cannot say what it wrote: it reloads (fails safe, DL-413), each one alone.
    expect(
      readCommit(samCommitted([{ call: LATER_TIMER_CALL }, "not a result", null], [])).timersWritten,
    ).toBe(true);
    for (const result of NOT_K09_RESULTS) {
      expect(readCommit(samCommitted([record, result], [])).timersWritten, JSON.stringify(result)).toBe(true);
    }
    // `written` still tells: a timer row the walk wrote, in K-09's answer.
    expect(
      readCommit(samCommitted([record], [{ table: "safety_timers", rowId: SAM_TIMER.id, version: 2 }]))
        .timersWritten,
    ).toBe(true);
  });

  it("today's commits read as before: none of K-09's core actions writes a timer row, so each one's result, with `written` naming none, reads nothing", () => {
    expect(K09_CORE_CALLS).toHaveLength(15);
    for (const call of K09_CORE_CALLS) {
      const result = { call, response: {}, error: null };
      expect(readCommit(samCommitted([result], [])).timersWritten, call).toBe(false);
    }
    // stop-recorded.json as it stands: its safety record and STOP went through, and `written` names Ben's phone row.
    expect(readCommit(stopRecorded.outcome).timersWritten).toBe(false);
  });
});

// ---- an answer the copies cannot read, and a repeat (T-1198 round 2, T-1203; DL-413) ------------------------------------

describe("what a commit gives the copies: an answer it cannot read, and a repeat (DL-413)", () => {
  it("an answer in K-09's shape that cannot be read reloads (fails safe): core results missing or not a list, `repeated` not a boolean, rows not a list, or a row that names no table", () => {
    const first = samCommitted([], []);
    const without = (key: string): Json =>
      Object.fromEntries(Object.entries(first).filter(([name]) => name !== key));
    // In K-09's shape, a first answer with nothing written: nothing to reload.
    expect(readCommit(first)).toEqual({ stopped: null, timersWritten: false });
    // Its core results missing, or not a list.
    expect(readCommit(without("core"))).toEqual({ stopped: null, timersWritten: true });
    for (const core of ["not a list", null, {}, 7]) {
      expect(readCommit({ ...first, core }).timersWritten, JSON.stringify(core)).toBe(true);
    }
    // `repeated` missing or not a boolean: it may be a repeat (T-1203).
    expect(readCommit(without("repeated")).timersWritten).toBe(true);
    expect(readCommit({ ...first, repeated: "no" }).timersWritten).toBe(true);
    // The rows (`written.written`) missing or not a list.
    expect(readCommit({ ...first, written: { outboxRows: [], promoted: [] } }).timersWritten).toBe(true);
    expect(
      readCommit({ ...first, written: { written: "none", outboxRows: [], promoted: [] } }).timersWritten,
    ).toBe(true);
    // A row that names no table, in K-09's answer or K-05's own; a row that names another table reads no.
    const noTable: unknown[] = [null, "safety_timers", { rowId: SAM_TIMER.id, version: 1 }, { table: 7 }];
    for (const row of noTable) {
      expect(readCommit(samCommitted([], [row])).timersWritten, JSON.stringify(row)).toBe(true);
      expect(readCommit({ written: [row], outboxRows: [], promoted: [] }).timersWritten).toBe(true);
    }
    expect(
      readCommit(samCommitted([], [{ table: "phones", rowId: "handle-sam", version: 2 }])).timersWritten,
    ).toBe(false);
    // A null answer, and one whose `written` is in neither shape, read as before (the earlier test above).
  });

  it("a repeat reloads (T-1203): it answers its first commit with no rows, and that first answer may have been lost with the rows it named; a first answer keeps rules 1 and 2", () => {
    const record = safetyRecordFor("evt-sam-0301");
    // A repeat with no rows and no core result that may have written a timer: it reloads all the same.
    expect(readCommit(samCommitted([], [], true))).toEqual({ stopped: null, timersWritten: true });
    expect(readCommit(samCommitted([record], [], true)).timersWritten).toBe(true);
    for (const call of K09_CORE_CALLS) {
      const result = { call, response: {}, error: null };
      expect(readCommit(samCommitted([result], [], true)).timersWritten, call).toBe(true);
    }
    // stop-recorded.json repeated (no rows): its stopped flag is copied as before, and the timers reload.
    const stopRepeat = {
      ...stopRecorded.outcome,
      repeated: true,
      written: { ...stopRecorded.outcome.written, written: [] },
    };
    expect(readCommit(stopRepeat)).toEqual({
      stopped: { stopped: true, phoneVersion: 4 },
      timersWritten: true,
    });
    // The same answers, first: rules 1 and 2 decide, and none of them may have written a timer.
    expect(readCommit(samCommitted([], [])).timersWritten).toBe(false);
    expect(readCommit(samCommitted([record], [])).timersWritten).toBe(false);
    expect(readCommit(stopRecorded.outcome)).toEqual({
      stopped: { stopped: true, phoneVersion: 4 },
      timersWritten: false,
    });
  });
});
