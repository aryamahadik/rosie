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
import commitFirst from "../../../../contracts/data-access/fixtures/commit-first.json";
import commitRepeat from "../../../../contracts/data-access/fixtures/commit-repeat-same-turn.json";
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
  flush,
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
  LEASE_MS,
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
  type TurnEntry,
} from "../index";
import { ActorCopies, readCommit } from "./copies";
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
  readTurns(): Promise<TurnEntry[]>;
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

  it("a repeat through a K-05-shaped commit hook reloads the copy (T-1204): the first commit wrote Sam's timer row but its answer was lost, and the repeat says repeated in the lease's answer alone, its commitResult holding no rows; a first answer still reads its rows", async () => {
    await withTimerRig(async (rig) => {
      // The lease's commit hook answers as K-05 v1 commitTurn does: K-05's own commitResult in `committed`, with no core
      // results and no `repeated` inside it. The first commit writes Sam's timer row, but its answer is lost on the way
      // back: the turn sends the same request again, and the repeat answers its first commit with no rows.
      rig.api.answerShape = "k05";
      const turnId = await turnIdOf(["evt-sam-0301"]);
      rig.api.writes.push(structuredClone(SAM_TIMER));
      rig.api.loseNextAnswer = true;
      await rig.text("evt-sam-0301", 2);
      expect(rig.api.commits.map((commit) => commit.turn.id)).toEqual([turnId, turnId]);
      expect(rig.api.timers.get(SAM_TIMER.id)).toEqual(SAM_TIMER);
      expect(rig.api.answers).toEqual([
        {
          result: "committed",
          turnId,
          committedAt: "2026-10-27T13:20:02Z",
          repeated: true,
          committed: { written: [], outboxRows: [], promoted: [] },
        },
      ]);
      // Read alone, that commitResult names no timer row and no repeat: only the lease's flag tells of the lost rows.
      const repeat = rig.api.answers[0] as { committed: unknown };
      expect(readCommit(repeat.committed)).toEqual({ stopped: null, timersWritten: false });
      // The actor reads it with the lease's flag: it reloaded Sam's live timers, and the copy holds the row.
      expect(rig.api.reloads).toEqual(["handle-sam"]);
      let copies = await rig.actor.readCopies();
      expect(copies.timers).toEqual([copyOf(SAM_TIMER)]);
      expect(copies.timersStale).toBe(false);

      // A first answer that comes back reads its rows as before: none names a timer row, so nothing reloads.
      rig.api.writes.push(null);
      await rig.text("evt-sam-0302");
      expect(rig.api.answers[1]).toEqual({
        result: "committed",
        turnId: await turnIdOf(["evt-sam-0302"]),
        committedAt: "2026-10-27T13:20:02Z",
        repeated: false,
        committed: { written: [], outboxRows: [], promoted: [] },
      });
      expect(rig.api.reloads).toHaveLength(1);

      // A first answer whose rows name Sam's timer, moved an hour on (version 2): it reloads, and the copy holds the move.
      const moved: SafetyTimerRow = {
        ...structuredClone(SAM_TIMER),
        due_at: "2026-10-27T16:20:00Z",
        version: 2,
      };
      rig.api.writes.push(moved);
      await rig.text("evt-sam-0303");
      expect(rig.api.answers[2]).toMatchObject({
        repeated: false,
        committed: { written: [{ table: "safety_timers", rowId: SAM_TIMER.id, version: 2 }] },
      });
      expect(rig.api.reloads).toEqual(["handle-sam", "handle-sam"]);
      copies = await rig.actor.readCopies();
      expect(copies.timers).toEqual([copyOf(moved)]);
      expect(copies.timersStale).toBe(false);
    });
  });
});

// ---- a commit whose answer was lost, which a park answers alreadyCommitted (T-1206) -------------------------------------

/** Sam's text whose turn crashes three times: runs 1 and 2 before their commit, run 3 once its commit went through. */
const LOST_EVENT = "evt-sam-0311";

interface ParkRig {
  readonly api: FakeToolApi;
  readonly actor: CopiesRpc;
  /** The lost turn's id (CQ-09: the hash of its one text's event id). */
  readonly turnId: string;
  /**
   * The lost turn: Sam's text arrives and its turn runs three times. Runs 1 and 2 crash before their commit; run 3 commits
   * once through the lease (what the Tool API double writes next), and crashes before it can send the commit again. The
   * third lapse then parks the turn, and the park hook (K-05 v1 parkTurn through the double) answers. `beforePark` runs
   * between run 3's commit and that lapse.
   */
  lose(beforePark?: () => Promise<void>): Promise<void>;
  /** A later text of Sam's, whose turn commits once through the lease (sent again once if its answer is lost). */
  text(eventId: string): Promise<void>;
}

async function withParkRig(
  body: (rig: ParkRig) => Promise<void>,
  options: { phones?: boolean } = {},
): Promise<void> {
  const events = [LOST_EVENT, ...TIMER_EVENTS];
  const h: Harness = harness(keys, Object.fromEntries(events.map((id) => [id, safetyNoFor(id)])));
  const api = fakeToolApi();
  const turnId = await turnIdOf([LOST_EVENT]);
  const restores = [
    setSafetyDeps(h.deps),
    setBatchHooks({ clock: h.clock }),
    setLeaseHooks({
      runTurn: async (turn) => {
        const request = samCommit(turn);
        if (turn.turnId === turnId) {
          // Runs 1 and 2 crash before their commit; run 3 commits once, then crashes before it could send it again.
          if (turn.tries === 3) await turn.commit(request);
          return;
        }
        const answer = await turn.commit(request);
        if ("error" in answer && answer.error === "noAnswer") await turn.commit(request);
      },
      commit: (request, at) => api.commit(request, at),
      park: (turn) => api.park(turn),
    }),
    setBundleDeps(fakeBundles().deps),
    setCopyDeps(
      options.phones === false ? { timers: api.source } : { timers: api.source, phones: api.phones },
    ),
  ];
  const tick = async (ms: number): Promise<void> => {
    await h.clock.advance(ms);
    await runDurableObjectAlarm(stubOf(SAM_PARTY));
  };
  const idle = async (): Promise<void> => {
    await actorOf(SAM_PARTY).safetyIdle();
    await actorOf(SAM_PARTY).batchIdle();
  };
  const rig: ParkRig = {
    api,
    get actor(): CopiesRpc {
      return actorOf(SAM_PARTY);
    },
    turnId,
    async lose(beforePark) {
      const sent = api.commits.length;
      await arrive(SAM_PARTY, LOST_EVENT, "TIMER 2 hours", "2026-10-27T13:20:00Z");
      await tick(3000);
      await idle();
      await tick(LEASE_MS);
      await idle();
      await tick(LEASE_MS);
      await until(() => api.commits.length === sent + 1, "run 3's commit");
      await idle();
      await beforePark?.();
      await tick(LEASE_MS);
      await until(() => api.parks.length === 1, "the park after the third lapse");
      await idle();
    },
    async text(eventId) {
      const sent = api.commits.length;
      await arrive(SAM_PARTY, eventId, "TIMER 2 hours", "2026-10-27T13:20:00Z");
      await tick(3000);
      await until(() => api.commits.length > sent, "the turn's commit");
      await idle();
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

describe("a commit whose answer was lost, which a park answers alreadyCommitted (T-1206)", () => {
  it("reaches the actor's copies: the third run's commit wrote Sam's timer row and a STOP and its answer was lost; once the park answers alreadyCommitted, the copy holds the row and the stopped flag is set", async () => {
    await withParkRig(async (rig) => {
      rig.api.writes.push(structuredClone(SAM_TIMER));
      rig.api.stopWrites.push(true);
      rig.api.loseNextAnswer = true;
      await rig.lose();

      // Run 3's commit went through, Sam's timer row and his STOP (phone row version 3) with it, but no answer came back.
      expect(rig.api.commits.map((commit) => [commit.turn.id, commit.turn.tries])).toEqual([[rig.turnId, 3]]);
      expect(rig.api.answers).toEqual([]);
      expect(rig.api.timers.get(SAM_TIMER.id)).toEqual(SAM_TIMER);
      expect(rig.api.phone).toMatchObject({ stopped: true, version: 3 });
      // The third lapse parked it: K-05 answered alreadyCommitted, and the turn finished as committed, the lease released.
      expect(rig.api.parks).toEqual([rig.turnId]);
      expect(await rig.actor.readTurns()).toEqual([
        {
          turnId: rig.turnId,
          eventIds: [LOST_EVENT],
          state: "committed",
          restart: false,
          tries: 3,
          leaseUntil: null,
          committedAt: "2026-10-27T13:20:02Z",
        },
      ]);

      // The actor read that commit again by the handle id it named: Sam's live timers reloaded, his phone row's stopped
      // flag read again. The copy holds the row, and the stopped flag is set.
      expect(rig.api.reloads).toEqual(["handle-sam"]);
      expect(rig.api.phoneReads).toEqual(["handle-sam"]);
      const copies = await rig.actor.readCopies();
      expect(copies.timers).toEqual([copyOf(SAM_TIMER)]);
      expect(copies.timersStale).toBe(false);
      expect(copies.stopped).toEqual({
        stopped: true,
        phoneVersion: 3,
        turnId: null,
        setAt: expect.any(Number) as number,
      });
    });
  });

  it("fails safe when neither can be read again: with no re-read of the phone row wired and the reload down, the flag reads stopped and the timers' copy is stale; the next commit reloads the timers, and only a later write of the flag lets the stricter reading go", async () => {
    await withParkRig(
      async (rig) => {
        // The lost commit writes Sam's timer row and no flag: the actor cannot know that, so it reads the stricter way.
        rig.api.writes.push(structuredClone(SAM_TIMER));
        rig.api.loseNextAnswer = true;
        rig.api.reloadDown = true;
        await rig.lose();
        expect(rig.api.parks).toEqual([rig.turnId]);
        expect(rig.api.phone).toMatchObject({ stopped: false, version: 2 });
        expect(rig.api.reloads).toEqual(["handle-sam"]);
        expect(rig.api.phoneReads).toEqual([]);
        let copies = await rig.actor.readCopies();
        expect(copies.stopped).toEqual({
          stopped: true,
          phoneVersion: null,
          turnId: null,
          setAt: expect.any(Number) as number,
          lost: { turnId: rig.turnId, since: expect.any(Number) as number },
        });
        expect(copies.timers).toEqual([]);
        expect(copies.timersStale).toBe(true);

        // The next commit writes no timer row and no flag: the stale copy reloads and catches up; the flag stays stricter.
        rig.api.reloadDown = false;
        rig.api.writes.push(null);
        await rig.text("evt-sam-0301");
        expect(rig.api.reloads).toEqual(["handle-sam", "handle-sam"]);
        copies = await rig.actor.readCopies();
        expect(copies.timers).toEqual([copyOf(SAM_TIMER)]);
        expect(copies.timersStale).toBe(false);
        expect(copies.stopped).toMatchObject({ stopped: true, lost: { turnId: rig.turnId } });

        // A later commit records a START (phone row version 3): copied from its answer, it lets the stricter reading go.
        rig.api.writes.push(null);
        rig.api.stopWrites.push(false);
        await rig.text("evt-sam-0302");
        copies = await rig.actor.readCopies();
        expect(copies.stopped).toEqual({
          stopped: false,
          phoneVersion: 3,
          turnId: await turnIdOf(["evt-sam-0302"]),
          setAt: expect.any(Number) as number,
        });
      },
      { phones: false },
    );
  });

  it("reads the flag again, never guesses it: a lost commit that recorded START reads stopped while the re-read is down, and the next commit, writing no flag, reads the phone row again and finds it started", async () => {
    await withParkRig(async (rig) => {
      // An earlier commit records Sam's STOP: copied from its answer (phone row version 3).
      rig.api.writes.push(null);
      rig.api.stopWrites.push(true);
      await rig.text("evt-sam-0301");
      const stopTurn = await turnIdOf(["evt-sam-0301"]);
      expect((await rig.actor.readCopies()).stopped).toMatchObject({
        stopped: true,
        phoneVersion: 3,
        turnId: stopTurn,
      });

      // The lost turn's run 3 records his START (version 4), its answer lost; the phone row cannot be read just then.
      rig.api.writes.push(null);
      rig.api.stopWrites.push(false);
      rig.api.loseNextAnswer = true;
      rig.api.phoneDown = true;
      await rig.lose();
      expect(rig.api.phone).toMatchObject({ stopped: false, version: 4 });
      expect(rig.api.phoneReads).toEqual(["handle-sam"]);
      let copies = await rig.actor.readCopies();
      expect(copies.stopped).toEqual({
        stopped: true,
        phoneVersion: 3,
        turnId: stopTurn,
        setAt: expect.any(Number) as number,
        lost: { turnId: rig.turnId, since: expect.any(Number) as number },
      });

      // The next commit writes no flag: by its handle id, the phone row is read again, which says started (version 4).
      rig.api.phoneDown = false;
      rig.api.writes.push(null);
      await rig.text("evt-sam-0302");
      expect(rig.api.phoneReads).toEqual(["handle-sam", "handle-sam"]);
      copies = await rig.actor.readCopies();
      expect(copies.stopped).toEqual({
        stopped: false,
        phoneVersion: 4,
        turnId: null,
        setAt: expect.any(Number) as number,
      });

      // Nothing lost any more: a commit that writes no flag reads nothing again.
      rig.api.writes.push(null);
      await rig.text("evt-sam-0303");
      expect(rig.api.phoneReads).toHaveLength(2);
    });
  });

  it("with no handle id kept for the lost commit (sent before the lease kept them, across a deploy), the copies fail safe with nothing read: the flag reads stopped and the timers' copy is stale; the next commit reads both again by its own handle id", async () => {
    await withParkRig(async (rig) => {
      rig.api.writes.push(structuredClone(SAM_TIMER));
      rig.api.stopWrites.push(true);
      rig.api.loseNextAnswer = true;
      await rig.lose(async () => {
        await runInDurableObject(stubOf(SAM_PARTY), (_, state) => {
          state.storage.sql.exec("DELETE FROM lease_commit_handles");
        });
      });
      expect(rig.api.parks).toEqual([rig.turnId]);
      expect(rig.api.reloads).toEqual([]);
      expect(rig.api.phoneReads).toEqual([]);
      let copies = await rig.actor.readCopies();
      expect(copies.stopped).toEqual({
        stopped: true,
        phoneVersion: null,
        turnId: null,
        setAt: expect.any(Number) as number,
        lost: { turnId: rig.turnId, since: expect.any(Number) as number },
      });
      expect(copies.timers).toEqual([]);
      expect(copies.timersStale).toBe(true);

      // The next commit (no timer row, no flag) reads both again: the copy holds the row, and the STOP is read from the
      // phone row (version 3).
      rig.api.writes.push(null);
      await rig.text("evt-sam-0301");
      expect(rig.api.reloads).toEqual(["handle-sam"]);
      expect(rig.api.phoneReads).toEqual(["handle-sam"]);
      copies = await rig.actor.readCopies();
      expect(copies.timers).toEqual([copyOf(SAM_TIMER)]);
      expect(copies.timersStale).toBe(false);
      expect(copies.stopped).toEqual({
        stopped: true,
        phoneVersion: 3,
        turnId: null,
        setAt: expect.any(Number) as number,
      });
    });
  });

  it("a re-read answer that is not K-04's phone row, or is older than the copy, keeps the stricter reading; only a read of the row at least as new as the copy lets it go", async () => {
    await withParkRig(async () => {
      const result = await runInDurableObject(stubOf(SAM_PARTY), async (instance) => {
        const { copies } = insideOf(instance);
        copies.noteStopped({ stopped: true, phoneVersion: 4, turnId: "turn-sam-stop" });
        expect(copies.noteLostCommit("turn-sam-lost")).toBe(true);
        const answers: unknown[] = [
          null,
          "phone",
          { error: "transient" },
          { result: "timers", timers: [] },
          { result: "phone", stopped: "no", phoneVersion: 5 },
          { result: "phone", stopped: false, phoneVersion: 0 },
          { result: "phone", stopped: false, phoneVersion: 4.5 },
          { result: "phone", stopped: false },
        ];
        const reads: string[] = [];
        for (const answer of answers) {
          const restore = setCopyDeps({
            timers: { liveTimers: () => Promise.resolve({ result: "timers", timers: [] }) },
            phones: { stoppedFlag: () => Promise.resolve(answer as never) },
          });
          reads.push(await copies.rereadStopped("handle-sam"));
          restore();
        }
        const thrown = setCopyDeps({
          timers: { liveTimers: () => Promise.resolve({ result: "timers", timers: [] }) },
          phones: { stoppedFlag: () => Promise.reject(new Error("PostgreSQL is down")) },
        });
        reads.push(await copies.rereadStopped("handle-sam"));
        // A handle id that is not a label is never read.
        reads.push(await copies.rereadStopped("handle sam\n"));
        thrown();
        const unwired = setCopyDeps({
          timers: { liveTimers: () => Promise.resolve({ result: "timers", timers: [] }) },
        });
        reads.push(await copies.rereadStopped("handle-sam"));
        unwired();
        const stillLost = copies.readStopped();
        // A read older than the copy (version 3 behind 4) is not taken; one as new as it (version 4) is.
        const older = setCopyDeps({
          timers: { liveTimers: () => Promise.resolve({ result: "timers", timers: [] }) },
          phones: {
            stoppedFlag: () => Promise.resolve({ result: "phone", stopped: false, phoneVersion: 3 }),
          },
        });
        const olderRead = await copies.rereadStopped("handle-sam");
        older();
        const afterOlder = copies.readStopped();
        const same = setCopyDeps({
          timers: { liveTimers: () => Promise.resolve({ result: "timers", timers: [] }) },
          phones: {
            stoppedFlag: () => Promise.resolve({ result: "phone", stopped: true, phoneVersion: 4 }),
          },
        });
        const sameRead = await copies.rereadStopped("handle-sam");
        same();
        const after = copies.readStopped();
        // The actor's own note (a STOP it took while PostgreSQL was down, no version; its record not written yet), then a
        // lost commit: a row read, however new, never replaces the note, and the stricter reading stays.
        copies.noteStopped({ stopped: true, phoneVersion: null, turnId: null });
        copies.noteLostCommit("turn-sam-lost-2");
        const newer = setCopyDeps({
          timers: { liveTimers: () => Promise.resolve({ result: "timers", timers: [] }) },
          phones: {
            stoppedFlag: () => Promise.resolve({ result: "phone", stopped: false, phoneVersion: 9 }),
          },
        });
        const noteRead = await copies.rereadStopped("handle-sam");
        newer();
        return {
          reads,
          stillLost,
          olderRead,
          afterOlder,
          sameRead,
          after,
          noteRead,
          afterNote: copies.readStopped(),
        };
      });
      expect(result.reads).toEqual([
        "failed",
        "failed",
        "failed",
        "failed",
        "failed",
        "failed",
        "failed",
        "failed",
        "failed",
        "unwired",
        "unwired",
      ]);
      expect(result.stillLost).toMatchObject({
        stopped: true,
        phoneVersion: 4,
        lost: { turnId: "turn-sam-lost" },
      });
      expect(result.olderRead).toBe("older");
      expect(result.afterOlder).toMatchObject({
        stopped: true,
        phoneVersion: 4,
        lost: { turnId: "turn-sam-lost" },
      });
      expect(result.sameRead).toBe("copied");
      expect(result.after).toEqual({
        stopped: true,
        phoneVersion: 4,
        turnId: null,
        setAt: expect.any(Number) as number,
      });
      expect(result.noteRead).toBe("older");
      expect(result.afterNote).toEqual({
        stopped: true,
        phoneVersion: null,
        turnId: null,
        setAt: expect.any(Number) as number,
        lost: { turnId: "turn-sam-lost-2", since: expect.any(Number) as number },
      });
    });
  });
});

// ---- only DL-427's rule 1 ends a lost commit's mark (T-1206 round 2) ----------------------------------------------------

/** How a turn of Sam's runs, by its text's event id: each run commits (`every`), or only its third run does (`third`). */
type RunScript = "every" | "third";

interface LateRig {
  readonly api: FakeToolApi;
  readonly actor: CopiesRpc;
  /** Sam's text arrives and its batch closes: its turn opens and run 1 starts. Gives the turn id. */
  open(eventId: string): Promise<string>;
  /** The lease lapses (60 s on the actor's clock). */
  lapse(): Promise<void>;
  /**
   * A `third` turn: its runs 1 and 2 crash before their commit, run 3 commits once (as the double answers it), and the
   * third lapse parks it; the park answers alreadyCommitted and the turn finishes as committed. Gives the turn id.
   */
  lose(eventId: string): Promise<string>;
  /** Waits for the actor's own work: only while no answer is held (a run waiting for one is the actor's work too). */
  settle(): Promise<void>;
  /** The marks the copies keep, by turn id, in the order noted (the stored table). */
  marks(): Promise<string[]>;
}

async function withLateRig(
  scripts: Record<string, RunScript>,
  body: (rig: LateRig) => Promise<void>,
): Promise<void> {
  const h: Harness = harness(
    keys,
    Object.fromEntries(Object.keys(scripts).map((id) => [id, safetyNoFor(id)])),
  );
  const api = fakeToolApi();
  const restores = [
    setSafetyDeps(h.deps),
    setBatchHooks({ clock: h.clock }),
    setLeaseHooks({
      runTurn: async (turn) => {
        const request = samCommit(turn);
        if (scripts[turn.eventIds[0] ?? ""] === "third") {
          if (turn.tries === 3) await turn.commit(request);
          return;
        }
        const answer = await turn.commit(request);
        if ("error" in answer && answer.error === "noAnswer") await turn.commit(request);
      },
      commit: (request, at) => api.commit(request, at),
      park: (turn) => api.park(turn),
    }),
    setBundleDeps(fakeBundles().deps),
    // As production is wired today (wiring/ports.ts): no re-read of the phone row, so nothing reads the flag again.
    setCopyDeps({ timers: api.source }),
  ];
  const tick = async (ms: number): Promise<void> => {
    await h.clock.advance(ms);
    await runDurableObjectAlarm(stubOf(SAM_PARTY));
  };
  /** Polls the lease's turns until `turnId` reads as `ready` says (no lent work is awaited: a held answer may be one). */
  const turnWhen = async (
    turnId: string,
    ready: (turn: TurnEntry) => boolean,
    what: string,
  ): Promise<void> => {
    const started = Date.now();
    for (;;) {
      const turn = (await actorOf(SAM_PARTY).readTurns()).find((entry) => entry.turnId === turnId);
      if (turn !== undefined && ready(turn)) return;
      if (Date.now() - started > 10_000) throw new Error(`gave up waiting for ${what}`);
      await flush();
    }
  };
  const rig: LateRig = {
    api,
    get actor(): CopiesRpc {
      return actorOf(SAM_PARTY);
    },
    async open(eventId) {
      const turnId = await turnIdOf([eventId]);
      await arrive(SAM_PARTY, eventId, "TIMER 2 hours", "2026-10-27T13:20:00Z");
      await actorOf(SAM_PARTY).safetyIdle();
      await tick(3000);
      await turnWhen(turnId, (turn) => turn.tries === 1, "the turn's opening");
      return turnId;
    },
    lapse: () => tick(LEASE_MS),
    async lose(eventId) {
      const sent = api.commits.length;
      const parked = api.parks.length;
      const turnId = await rig.open(eventId);
      await tick(LEASE_MS);
      await turnWhen(turnId, (turn) => turn.tries === 2, "run 2");
      await tick(LEASE_MS);
      await until(() => api.commits.length === sent + 1, "run 3's commit");
      await tick(LEASE_MS);
      await until(() => api.parks.length === parked + 1, "the park after the third lapse");
      await turnWhen(turnId, (turn) => turn.state === "committed", "the parked turn finished as committed");
      return turnId;
    },
    async settle() {
      await actorOf(SAM_PARTY).safetyIdle();
      await actorOf(SAM_PARTY).batchIdle();
    },
    marks: () =>
      runInDurableObject(stubOf(SAM_PARTY), (_, state) =>
        state.storage.sql
          .exec<{ turn_id: string }>("SELECT turn_id FROM copy_lost_commits ORDER BY noted")
          .toArray()
          .map((row) => row.turn_id),
      ),
  };
  try {
    await body(rig);
  } finally {
    restores.reverse().forEach((restore) => {
      restore();
    });
  }
}

const anyTime = expect.any(Number) as number;

describe("only DL-427's rule 1 ends a lost commit's mark (T-1206 round 2)", () => {
  it("the security review's sequence: T0 records a START (v3) and its run-1 answer is slow; T0's rerun gets the repeat (v3 copied) and finishes; T1's run 3 records a STOP (v4), its answer lost, and the park answers alreadyCommitted; T0's slow answer (v3) then arrives, and the flag still reads stopped", async () => {
    await withLateRig({ "evt-sam-0321": "every", "evt-sam-0322": "third" }, async (rig) => {
      const slow = hold(true);
      rig.api.stopWrites.push(false, true);
      rig.api.slowNextAnswer = slow;
      const t0 = await rig.open("evt-sam-0321");
      await until(() => rig.api.commits.length === 1, "T0's run-1 commit");
      expect(rig.api.phone).toMatchObject({ stopped: false, version: 3 });

      // T0's lease lapses: its rerun sends the commit again, and the repeat answers with the first commit (START, v3).
      await rig.lapse();
      await until(() => rig.api.answers.length === 1, "the repeat's answer");
      expect(rig.api.answers[0]).toMatchObject({ turnId: t0, repeated: true });
      expect((await rig.actor.readTurns()).map((turn) => [turn.turnId, turn.state])).toEqual([
        [t0, "committed"],
      ]);
      expect((await rig.actor.readCopies()).stopped).toEqual({
        stopped: false,
        phoneVersion: 3,
        turnId: t0,
        setAt: anyTime,
      });

      // T1's run 3 records Sam's STOP (v4); its answer is lost, and the park answers alreadyCommitted: T1's mark is set.
      rig.api.loseNextAnswer = true;
      const t1 = await rig.lose("evt-sam-0322");
      expect(rig.api.parks).toEqual([t1]);
      expect(rig.api.phone).toMatchObject({ stopped: true, version: 4 });
      expect((await rig.actor.readCopies()).stopped).toEqual({
        stopped: true,
        phoneVersion: 3,
        turnId: t0,
        setAt: anyTime,
        lost: { turnId: t1, since: anyTime },
      });

      // T0's slow first answer (START, v3) arrives: the copy takes it (v3 is not below v3), but T0 opened before T1, so
      // T1's mark stays, whatever the version, and the flag still reads stopped.
      slow.closed = false;
      await until(() => rig.api.answers.length === 2, "T0's slow answer");
      await rig.settle();
      expect(rig.api.answers[1]).toMatchObject({ turnId: t0, repeated: false });
      expect(await rig.marks()).toEqual([t1]);
      expect((await rig.actor.readCopies()).stopped).toEqual({
        stopped: true,
        phoneVersion: 3,
        turnId: t0,
        setAt: anyTime,
        lost: { turnId: t1, since: anyTime },
      });
    });
  });

  it("two lost commits in a row, T0's and T1's, each keep their own mark: T0's slow answer (START, v3), arriving after T1's commit (STOP, v4) lost its answer, ends T0's own mark only, and the flag still reads stopped", async () => {
    await withLateRig({ "evt-sam-0321": "third", "evt-sam-0322": "third" }, async (rig) => {
      // T0's run 3 records Sam's START (v3); its answer is slow, and the park answers alreadyCommitted first.
      const slow = hold(true);
      rig.api.stopWrites.push(false, true);
      rig.api.slowNextAnswer = slow;
      const t0 = await rig.lose("evt-sam-0321");
      expect(await rig.marks()).toEqual([t0]);
      expect((await rig.actor.readCopies()).stopped).toEqual({
        stopped: true,
        phoneVersion: null,
        turnId: null,
        setAt: anyTime,
        lost: { turnId: t0, since: anyTime },
      });

      // T1's run 3 records Sam's STOP (v4); its answer is lost, and the park answers alreadyCommitted: a second mark.
      rig.api.loseNextAnswer = true;
      const t1 = await rig.lose("evt-sam-0322");
      expect(rig.api.parks).toEqual([t0, t1]);
      expect(rig.api.phone).toMatchObject({ stopped: true, version: 4 });
      expect(await rig.marks()).toEqual([t0, t1]);
      expect((await rig.actor.readCopies()).stopped).toMatchObject({
        stopped: true,
        lost: { turnId: t1 },
      });

      // T0's slow answer arrives: it is T0's own (rule 1), so it ends T0's mark and its START is copied; T1's mark stays.
      slow.closed = false;
      await until(() => rig.api.answers.length === 1, "T0's slow answer");
      await rig.settle();
      expect(rig.api.answers[0]).toMatchObject({ turnId: t0, repeated: false });
      expect(await rig.marks()).toEqual([t1]);
      expect((await rig.actor.readCopies()).stopped).toEqual({
        stopped: true,
        phoneVersion: 3,
        turnId: t0,
        setAt: anyTime,
        lost: { turnId: t1, since: anyTime },
      });
    });
  });

  it("each of rule 1's three paths ends a mark: a fresh read of the phone row, the actor's own version-less note, and a committed answer from the lost turn itself or from a turn opened after it (taken, or older than the copy)", async () => {
    const result = await runInDurableObject(stubOf(SAM_PARTY), async (instance, state) => {
      const { copies } = insideOf(instance);
      const marks = (): string[] =>
        state.storage.sql
          .exec<{ turn_id: string }>("SELECT turn_id FROM copy_lost_commits ORDER BY noted")
          .toArray()
          .map((row) => row.turn_id);
      const reads: Record<string, unknown> = {};
      // Turn 1 copied a START (v3); turn 2's commit was lost.
      copies.noteStopped({ stopped: false, phoneVersion: 3, turnId: "turn-1", opened: 1 });
      copies.noteLostCommit("turn-2", 2);
      // 1. A fresh read of the phone row (sent after the mark): it finds Sam's STOP (v4) and ends the mark.
      const restore = setCopyDeps({
        timers: { liveTimers: () => Promise.resolve({ result: "timers", timers: [] }) },
        phones: { stoppedFlag: () => Promise.resolve({ result: "phone", stopped: true, phoneVersion: 4 }) },
      });
      reads.fresh = await copies.rereadStopped("handle-sam");
      restore();
      reads.afterRead = { marks: marks(), copy: copies.readStopped() };
      // 2. The actor's own version-less note (a START taken while PostgreSQL was down) ends every mark.
      copies.noteLostCommit("turn-3", 3);
      copies.noteLostCommit("turn-4", 4);
      reads.beforeNote = marks();
      reads.note = copies.noteStopped({ stopped: false, phoneVersion: null, turnId: null });
      reads.afterNote = { marks: marks(), copy: copies.readStopped() };
      // 3a. The lost turn's own answer, come late (its STOP, v5), ends its own mark.
      copies.noteStopped({ stopped: false, phoneVersion: 4, turnId: null });
      copies.noteLostCommit("turn-5", 5);
      reads.own = copies.noteStopped({ stopped: true, phoneVersion: 5, turnId: "turn-5", opened: 5 });
      reads.afterOwn = { marks: marks(), copy: copies.readStopped() };
      // 3b. A later turn's answer ends the marks of every turn opened before it: taken (its START, v7)...
      copies.noteLostCommit("turn-6", 6);
      reads.later = copies.noteStopped({ stopped: false, phoneVersion: 7, turnId: "turn-7", opened: 7 });
      reads.afterLater = { marks: marks(), copy: copies.readStopped() };
      // ... or older than the copy (a newer write is copied already): the core's own word, so the copy is newer still.
      copies.noteLostCommit("turn-8", 8);
      copies.noteStopped({ stopped: true, phoneVersion: 10, turnId: null });
      reads.olderLater = copies.noteStopped({ stopped: false, phoneVersion: 9, turnId: "turn-9", opened: 9 });
      reads.afterOlderLater = { marks: marks(), copy: copies.readStopped() };
      return reads;
    });
    expect(result.fresh).toBe("copied");
    expect(result.afterRead).toEqual({
      marks: [],
      copy: { stopped: true, phoneVersion: 4, turnId: null, setAt: anyTime },
    });
    expect(result.beforeNote).toEqual(["turn-3", "turn-4"]);
    expect(result.note).toBe(true);
    expect(result.afterNote).toEqual({
      marks: [],
      copy: { stopped: false, phoneVersion: null, turnId: null, setAt: anyTime },
    });
    expect(result.own).toBe(true);
    expect(result.afterOwn).toEqual({
      marks: [],
      copy: { stopped: true, phoneVersion: 5, turnId: "turn-5", setAt: anyTime },
    });
    expect(result.later).toBe(true);
    expect(result.afterLater).toEqual({
      marks: [],
      copy: { stopped: false, phoneVersion: 7, turnId: "turn-7", setAt: anyTime },
    });
    expect(result.olderLater).toBe(false);
    expect(result.afterOlderLater).toEqual({
      marks: [],
      copy: { stopped: true, phoneVersion: 10, turnId: null, setAt: anyTime },
    });
  });

  it("nothing else ends a mark: an earlier turn's answer, whatever its version; the write-on-return replay's answer; a turn the lease cannot place; and a read of the phone row sent before the mark was set", async () => {
    const result = await runInDurableObject(stubOf(SAM_PARTY), async (instance, state) => {
      const { copies } = insideOf(instance);
      const marks = (): string[] =>
        state.storage.sql
          .exec<{ turn_id: string }>("SELECT turn_id FROM copy_lost_commits ORDER BY noted")
          .toArray()
          .map((row) => row.turn_id);
      const reads: Record<string, unknown> = {};
      copies.noteStopped({ stopped: false, phoneVersion: 3, turnId: "turn-1", opened: 1 });
      copies.noteLostCommit("turn-2", 2);
      // An earlier turn's late answer: taken by its version (9 is not below 3), yet turn 2's mark stays.
      reads.earlier = copies.noteStopped({ stopped: false, phoneVersion: 9, turnId: "turn-1", opened: 1 });
      // The write-on-return replay's answer (a version, no turn), and a write of a turn the lease gave no place.
      reads.replay = copies.noteStopped({ stopped: false, phoneVersion: 10, turnId: null });
      reads.unplaced = copies.noteStopped({ stopped: false, phoneVersion: 11, turnId: "turn-x" });
      reads.afterWrites = { marks: marks(), unread: copies.stoppedUnread(), copy: copies.readStopped() };
      // A read sent before turn 3's mark was set ends turn 2's mark (noted before it was sent), never turn 3's.
      let sent = false;
      let answer: (value: unknown) => void = () => undefined;
      const restore = setCopyDeps({
        timers: { liveTimers: () => Promise.resolve({ result: "timers", timers: [] }) },
        phones: {
          stoppedFlag: () => {
            sent = true;
            return new Promise((resolve) => {
              answer = resolve as (value: unknown) => void;
            });
          },
        },
      });
      const early = copies.rereadStopped("handle-sam");
      await until(() => sent, "the early read's send");
      copies.noteLostCommit("turn-3", 3);
      answer({ result: "phone", stopped: false, phoneVersion: 12 });
      reads.early = await early;
      restore();
      reads.afterEarly = { marks: marks(), unread: copies.stoppedUnread(), copy: copies.readStopped() };
      return reads;
    });
    expect(result.earlier).toBe(true);
    expect(result.replay).toBe(true);
    expect(result.unplaced).toBe(true);
    expect(result.afterWrites).toEqual({
      marks: ["turn-2"],
      unread: true,
      copy: {
        stopped: true,
        phoneVersion: 11,
        turnId: "turn-x",
        setAt: anyTime,
        lost: { turnId: "turn-2", since: anyTime },
      },
    });
    expect(result.early).toBe("copied");
    expect(result.afterEarly).toEqual({
      marks: ["turn-3"],
      unread: true,
      copy: {
        stopped: true,
        phoneVersion: 12,
        turnId: null,
        setAt: anyTime,
        lost: { turnId: "turn-3", since: anyTime },
      },
    });
  });

  it("a mark the storage cannot keep is kept in memory (DL-427 ruling 4): a lost commit's, so the flag still reads stopped until rule 1 ends it, and the timers' stale mark, so the next commit still reloads until a reload succeeds", async () => {
    const result = await runInDurableObject(stubOf(SAM_PARTY), async (_, state) => {
      // The actor's storage, whose writes of the marks fail (a full disk); every other statement goes through.
      const failing = /^INSERT OR IGNORE INTO (copy_lost_commits|copy_meta)/u;
      const sql = {
        exec: (query: string, ...bindings: unknown[]) => {
          if (failing.test(query)) throw new Error("the storage is full");
          return state.storage.sql.exec(query, ...(bindings as SqlStorageValue[]));
        },
      };
      const storage = {
        sql,
        transactionSync: <T>(work: () => T): T => state.storage.transactionSync(work),
      } as unknown as DurableObjectStorage;
      const copies = new ActorCopies({ storage, now: () => 1000 });
      const reads: Record<string, unknown> = {};
      copies.noteStopped({ stopped: false, phoneVersion: 3, turnId: "turn-1", opened: 1 });
      reads.stored = copies.noteLostCommit("turn-2", 2);
      reads.afterLost = { unread: copies.stoppedUnread(), copy: copies.readStopped() };
      // An earlier turn's answer ends nothing; the lost turn's own answer ends its mark held in memory.
      copies.noteStopped({ stopped: false, phoneVersion: 3, turnId: "turn-1", opened: 1 });
      reads.afterEarlier = copies.readStopped();
      copies.noteStopped({ stopped: true, phoneVersion: 4, turnId: "turn-2", opened: 2 });
      reads.afterOwn = { unread: copies.stoppedUnread(), copy: copies.readStopped() };
      // The timers: marked stale with the storage failing, they read stale; a reload that succeeds lets go.
      copies.markTimersStale();
      reads.stale = copies.timersStale();
      const restore = setCopyDeps({
        timers: { liveTimers: () => Promise.resolve({ result: "timers", timers: [] }) },
      });
      reads.reload = await copies.refreshTimers("handle-sam");
      restore();
      reads.staleAfterReload = copies.timersStale();
      return reads;
    });
    expect(result.stored).toBe(false);
    expect(result.afterLost).toEqual({
      unread: true,
      copy: {
        stopped: true,
        phoneVersion: 3,
        turnId: "turn-1",
        setAt: 1000,
        lost: { turnId: "turn-2", since: 1000 },
      },
    });
    expect(result.afterEarlier).toMatchObject({ stopped: true, lost: { turnId: "turn-2" } });
    expect(result.afterOwn).toEqual({
      unread: false,
      copy: { stopped: true, phoneVersion: 4, turnId: "turn-2", setAt: 1000 },
    });
    expect(result.stale).toBe(true);
    expect(result.reload).toBe("refreshed");
    expect(result.staleAfterReload).toBe(false);
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

// ---- the lease's repeated flag (T-1204) ---------------------------------------------------------------------------------

describe("what a commit gives the copies: the lease's repeated flag (T-1204)", () => {
  it("a repeat by the lease's flag reloads whatever the answer's shape: K-05's commitResult has no flag inside it (commit-repeat-same-turn.json), and K-09's answer, a null answer or `written` in neither shape reload too; the stopped flag reads as before", () => {
    // K-05 v1 commitTurn's repeat: its commitResult alone names no row and no repeat; with the lease's flag it reloads.
    expect(commitRepeat.outcome.repeated).toBe(true);
    expect(readCommit(commitRepeat.outcome.committed)).toEqual({ stopped: null, timersWritten: false });
    expect(readCommit(commitRepeat.outcome.committed, { repeated: commitRepeat.outcome.repeated })).toEqual({
      stopped: null,
      timersWritten: true,
    });
    // Whatever the answer's shape, each one alone.
    const shapes: unknown[] = [
      { written: [], outboxRows: [], promoted: [] },
      { written: [{ table: "phones", rowId: "handle-sam", version: 2 }], outboxRows: [], promoted: [] },
      samCommitted([], []),
      samCommitted([safetyRecordFor("evt-sam-0301")], []),
      null,
      "not an answer",
      [],
      { core: "not a list", written: "nor this" },
    ];
    for (const shape of shapes) {
      expect(readCommit(shape, { repeated: true }).timersWritten, JSON.stringify(shape)).toBe(true);
    }
    // A repeat's core results still give the stopped flag (it answers its first commit), as before.
    expect(readCommit(stopRecorded.outcome, { repeated: true })).toEqual({
      stopped: { stopped: true, phoneVersion: 4 },
      timersWritten: true,
    });
  });

  it("a first answer by the lease's flag keeps the answer's own rules; a flag that is not false may be a repeat, and reloads (fails safe, DL-413)", () => {
    // K-05 v1 commitTurn's first answer (commit-first.json): its rows name no timer row, so nothing reloads.
    expect(commitFirst.outcome.repeated).toBe(false);
    expect(readCommit(commitFirst.outcome.committed, { repeated: commitFirst.outcome.repeated })).toEqual({
      stopped: null,
      timersWritten: false,
    });
    // A first K-05 answer whose rows name a timer row reloads, as before.
    const withTimerRow = {
      written: [{ table: "safety_timers", rowId: SAM_TIMER.id, version: 1 }],
      outboxRows: [],
      promoted: [],
    };
    expect(readCommit(withTimerRow, { repeated: false }).timersWritten).toBe(true);
    // A null answer, and one whose `written` is in neither shape, read as before on a first answer.
    expect(readCommit(null, { repeated: false })).toEqual({ stopped: null, timersWritten: false });
    expect(readCommit({ core: "not a list", written: "nor this" }, { repeated: false })).toEqual({
      stopped: null,
      timersWritten: false,
    });
    // The lease's flag missing or not a boolean: it may be a repeat, so it reloads, each one alone.
    const flags: [string, unknown][] = [
      ["missing", undefined],
      ["null", null],
      ['the text "false"', "false"],
      ['the text "no"', "no"],
      ["0", 0],
      ["1", 1],
      ["an object", {}],
      ["a list", []],
    ];
    for (const [label, repeated] of flags) {
      expect(readCommit(commitFirst.outcome.committed, { repeated }).timersWritten, label).toBe(true);
    }
  });

  it("K-09's path reads as before: its lease flag is K-09's own `repeated` (turn.ts commitThroughToolApi), so every K-09 answer, first or repeated, reads the same with the lease's flag as without it", () => {
    const record = safetyRecordFor("evt-sam-0301");
    const refused = { call: LATER_TIMER_CALL, response: null, error: { error: "transient" } };
    const timerRow = { table: "safety_timers", rowId: SAM_TIMER.id, version: 2 };
    const phoneRow = { table: "phones", rowId: "handle-sam", version: 2 };
    const answers: Json[] = [false, true].flatMap((repeated): Json[] => [
      { ...stopRecorded.outcome, repeated },
      samCommitted([], [], repeated),
      samCommitted([record], [], repeated),
      samCommitted([record, TIMER_BY_CORE], [], repeated),
      samCommitted([record, refused], [], repeated),
      samCommitted([record], [timerRow], repeated),
      samCommitted([], [phoneRow], repeated),
      ...K09_CORE_CALLS.map((call) => samCommitted([{ call, response: {}, error: null }], [], repeated)),
      ...NOT_K09_RESULTS.map((result) => samCommitted([record, result], [], repeated)),
    ]);
    expect(answers).toHaveLength(2 * (7 + 15 + NOT_K09_RESULTS.length));
    for (const answer of answers) {
      expect(readCommit(answer, { repeated: answer.repeated }), JSON.stringify(answer)).toEqual(
        readCommit(answer),
      );
    }
    // So K-09's repeats reload and its first answers keep rules 1 and 2, as the tests above say.
    expect(readCommit(samCommitted([], [], true), { repeated: true }).timersWritten).toBe(true);
    expect(readCommit(samCommitted([record], []), { repeated: false }).timersWritten).toBe(false);
  });
});
