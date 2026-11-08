// A safety read cut off by the actor's eviction, run inside the Workers runtime (T-1088). The actor is the real Durable
// Object reached through the gateway's door; the safety read, shared core, Linq send and clock are the doubles of
// src/safety/test-support.ts, and the same fake clock runs the actor's stored schedule. Each eviction test cuts the actor
// off in the middle of its safety work and wakes a new instance on the same id: a deploy or a reset does this in
// production, and what the instance awaited lived only in memory. The cut is the instance's reset (`ctx.abort`, after its
// storage is synced, as T-248's crash test does): `evictDurableObject` waits for the work in flight to drain, and a
// cut-off read's work never ends. The new instance is woken by its stored alarm (`runDurableObjectAlarm`) or by a new
// text. Before a cut the read never answers and nothing waits on a fake-clock timer; after it, the doubles answer on the
// fake clock. Round 2 (DL-127): a text with no verdict in 4 s (its unread hold open) is read again every 30 s until a
// verdict lands, from a stored entry, so an eviction cannot leave it held for good. Test method: T-1128's. Test values
// only (rule 9).
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import commitFirst from "../../../contracts/data-access/fixtures/commit-first.json";
import textImessage from "../../../contracts/inbound-event/fixtures/text-imessage.json";
import safetyEmergencyNow from "../../../contracts/model/fixtures/safety-emergency-now.json";
import safetyNo from "../../../contracts/model/fixtures/safety-no.json";
import safetyThreat from "../../../contracts/model/fixtures/safety-threat.json";
import safetyTimeoutDangerWord from "../../../contracts/model/fixtures/safety-timeout-danger-word.json";
import {
  durableObjectActor,
  prepareHandoff,
  type ActorNamespace,
  type HandleActorRpc,
  type InboundEvent,
} from "../gateway";
import { fakeKeyStore, present } from "../gateway/test-support";
import { fakeBundles } from "../bundle/test-support";
import {
  setBatchHooks,
  setBundleDeps,
  setLeaseHooks,
  setSafetyDeps,
  type BatchEntry,
  type ClosedBatch,
  type CommitAnswer,
  type CommitContext,
  type CommitTurnAnswer,
  type CommitTurnRequest,
  type HandleActor,
  type HoldEntry,
  type LeasedTurn,
  type OpenHold,
  type SafetyEntry,
} from "../actor";
import type { ModelCall } from "../trace/types";
import { timeoutResult } from "./rules";
import { harness, type Harness } from "./test-support";
import type {
  RecordSafetyOutcomeRequest,
  SafetyDeps,
  SafetyReadAnswer,
  SafetyReadPort,
  SafetyReadRequest,
  SafetyResult,
} from "./types";

type Json = Record<string, unknown>;

const BUNDLE = { hash: "a".repeat(64), build: 1 };
const TRACE = "11111111-2222-4333-8444-555555555555";
const ALEX = "phone:+15555550101";
const keys = fakeKeyStore();

const EMERGENCY_TEXT = "my lips are swelling after the beard color and I can't breathe well";
const BLEEDING_TEXT = "Riley's cut won't stop bleeding, please help";
const PLAIN_TEXT = "Can I get a haircut on Thursday afternoon?";
/** A danger the bundle's danger-word list does not hold, so a timeout gives it the outage line, not a safety line. */
const SMOKE_TEXT = "there is smoke pouring out of the dryer in the back room";

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
  return namespace().get(namespace().idFromName(ALEX));
}

/** The actor's calls over RPC, typed here (the stub's own type cannot carry the sealed event's open shape). */
interface ResumeRpc {
  readSafety(): Promise<SafetyEntry[]>;
  readHolds(): Promise<HoldEntry[]>;
  readBatches(): Promise<BatchEntry[]>;
  routineHeld(): Promise<boolean>;
  markHoldReleased(holdId: string): Promise<"released" | "neverReleased" | "noSuchHold">;
  safetyIdle(): Promise<void>;
  batchIdle(): Promise<void>;
}

function actorOf(): ResumeRpc {
  return stub();
}

async function arrive(eventId: string, body: string): Promise<void> {
  const overrides: Json = { eventId, body };
  const prepared = await prepareHandoff(
    {
      event: { ...(textImessage as Json), ...overrides, traceId: TRACE } as InboundEvent,
      partKey: null,
      traceId: TRACE,
      bundleId: BUNDLE,
    },
    keys,
  );
  if (prepared.door !== "actor") throw new Error("not an actor event");
  expect(await door().accept(prepared.handoff)).toBe("written");
}

/** The actor's stored schedule, earliest first. */
function scheduleOf(): Promise<{ kind: string; due_ms: number }[]> {
  return runInDurableObject(stub(), (_, state) =>
    state.storage.sql
      .exec<{ kind: string; due_ms: number }>("SELECT kind, due_ms FROM batch_schedule ORDER BY due_ms, kind")
      .toArray(),
  );
}

function alarmOf(): Promise<number | null> {
  return runInDurableObject(stub(), (_, state) => state.storage.getAlarm());
}

const asResult = (fixture: unknown): SafetyResult => fixture as SafetyResult;

/** The read's own no-verdict answer (K-02 `timedOut`, no read): both models timed out, as in a model outage. */
function gaveUp(eventId: string): SafetyReadAnswer {
  const call = (model: string, role: "haiku" | "sonnet"): ModelCall => ({
    model,
    role,
    purpose: "safetyRead",
    input_tokens: 400,
    cached_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 0,
    cost_micro_usd: 400,
    ms: 2000,
    outcome: "timedOut",
  });
  return {
    result: timeoutResult(eventId, []),
    modelCalls: [call("claude-haiku-5-5", "haiku"), call("claude-sonnet-5-5", "sonnet")],
  };
}

/** A verdict as the read answers it, with one model call. */
function verdict(result: SafetyResult): SafetyReadAnswer {
  return {
    result,
    modelCalls: [
      {
        model: "claude-haiku-5-5",
        role: "haiku",
        purpose: "safetyRead",
        input_tokens: 400,
        cached_tokens: 0,
        cache_write_tokens: 0,
        output_tokens: 40,
        cost_micro_usd: 600,
        ms: 1,
        outcome: "ok",
      },
    ],
  };
}

const idsOf = (batch: ClosedBatch): string[] => batch.entries.map((entry) => entry.event.eventId);

/** The actor's own turn lease, wired (round 4): each turn the lease hands its work, and what each commit was handed. */
interface Lease {
  turns: LeasedTurn[];
  contexts: CommitContext[];
}

/**
 * Commits this run of the turn through the lease, inside the actor, as the turn's work does: commit-first.json's request
 * for this turn (the gate's writes are the fixture's), which the K-05 double answers as committed.
 */
function commitOf(turn: LeasedTurn): Promise<CommitAnswer> {
  const base = commitFirst.request as unknown as CommitTurnRequest;
  const request: CommitTurnRequest = {
    ...base,
    turn: {
      ...base.turn,
      id: turn.turnId,
      eventIds: turn.eventIds,
      traceId: turn.traceId,
      joinedTraceIds: turn.joinedTraceIds,
      tries: turn.tries,
    },
  };
  return runInDurableObject(stub(), () => turn.commit(request));
}

interface Run {
  h: Harness;
  /** The reads the actor sent before the eviction (that read never answered). */
  cutOff: SafetyReadRequest[];
  /** Every batch handed to the lease, in order. */
  handed: ClosedBatch[];
  /** What the instance had before the first cut: a read that never answers, and (unless `deadlineRuns`) no 4 s timer. */
  stalled: SafetyDeps;
  /**
   * Cuts the actor off in the middle of its safety work (a new instance follows), then puts `next` in place: by default
   * the doubles that answer.
   */
  evict(next?: SafetyDeps): Promise<void>;
  /**
   * Wakes the actor the way its stored alarm does: the platform runs it at its time, the test now. (A new instance that
   * starts with the fake clock already past an entry sets its alarm for now, and the runtime may run that one first.)
   */
  wake(): Promise<void>;
  /** Settles the safety work and the batch work of what has arrived. */
  settle(): Promise<void>;
}

/**
 * Runs a test body with the doubles set for the isolate and put back after. Until `evict`, the read never answers and the
 * 4 s deadline has no timer (with `deadlineRuns`, it runs on the fake clock, so the timeout rule can apply before a cut);
 * after it, the read answers `answers` after `delayMs` and the deadline runs on the fake clock. With `before`, its doubles
 * are the ones in place until the first cut instead (round 3: a read that answers, a core that refuses, a Linq send that
 * never ends), on the fake clock. With `lease` (round 4), closed batches go to the actor's own turn lease, wired with the
 * turn's work (each turn kept in `lease.turns`) and K-05's commit double (each context kept in `lease.contexts`; it
 * commits whatever it is sent, so a test shows what T-252's gate is handed), not to `handed`.
 */
async function withEviction(
  answers: Record<string, SafetyResult>,
  options: {
    delayMs?: number;
    deadlineRuns?: boolean;
    before?: (h: Harness) => SafetyDeps;
    lease?: Lease;
  },
  body: (run: Run) => Promise<void>,
): Promise<void> {
  const h = harness(keys, answers, { delayMs: options.delayMs ?? 0 });
  const cutOff: SafetyReadRequest[] = [];
  const handed: ClosedBatch[] = [];
  const stalled: SafetyDeps = options.before?.(h) ?? {
    ...h.deps,
    read: {
      read(request) {
        cutOff.push(request);
        return new Promise(() => undefined);
      },
    },
    clock:
      options.deadlineRuns === true
        ? h.clock
        : { now: () => h.clock.now(), after: () => new Promise<void>(() => undefined) },
  };
  const restoreSafety = setSafetyDeps(stalled);
  const lease = options.lease;
  const restoreBatch = setBatchHooks(
    lease === undefined
      ? {
          clock: h.clock,
          toLease: (batch) => {
            handed.push(batch);
          },
        }
      : { clock: h.clock },
  );
  const restores: (() => void)[] = [];
  if (lease !== undefined) {
    const first = commitFirst.outcome as unknown as CommitTurnAnswer;
    restores.push(
      setLeaseHooks({
        runTurn: (turn) => {
          lease.turns.push(turn);
        },
        commit: (request, at) => {
          lease.contexts.push(at);
          return Promise.resolve({ ...first, turnId: request.turn.id });
        },
      }),
      setBundleDeps(fakeBundles().deps),
    );
  }
  const run: Run = {
    h,
    cutOff,
    handed,
    stalled,
    async evict(next = h.deps) {
      // What outlives the cut: the safety entry stored for the work in flight, and the alarm set for the schedule.
      expect((await scheduleOf()).map((entry) => entry.kind)).toContain("safetyRead");
      expect(await alarmOf()).not.toBeNull();
      // The instance's memory goes (the read in flight, its 4 s deadline, a late answer awaited); its storage and its
      // alarm stay.
      const cut = await runInDurableObject(stub(), async (_, state) => {
        await state.storage.sync();
        state.abort("cut off mid-read");
      }).then(
        () => "still running",
        () => "cut off",
      );
      expect(cut).toBe("cut off");
      restores.push(setSafetyDeps(next));
    },
    async wake() {
      await runDurableObjectAlarm(stub());
    },
    async settle() {
      await actorOf().safetyIdle();
      await actorOf().batchIdle();
    },
  };
  try {
    await body(run);
  } finally {
    for (const restore of restores.reverse()) restore();
    restoreBatch();
    restoreSafety();
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("the safety alarm", () => {
  it("is stored when the actor queues a read, at the read's 4 s deadline, and is cleared once the read ends", async () => {
    const answer = { ...asResult(safetyNo), eventId: "evt-1" };
    const h = harness(keys, { "evt-1": answer }, { delayMs: 1000 });
    const restoreSafety = setSafetyDeps(h.deps);
    const restoreBatch = setBatchHooks({ clock: h.clock, toLease: () => undefined });
    try {
      await arrive("evt-1", PLAIN_TEXT);
      expect(await scheduleOf()).toEqual([
        { kind: "batchClose", due_ms: 3000 },
        { kind: "safetyRead", due_ms: 4000 },
      ]);
      expect(await alarmOf()).not.toBeNull();

      await h.clock.advance(1000);
      await actorOf().safetyIdle();
      await actorOf().batchIdle();
      expect(await actorOf().readSafety()).toMatchObject([{ eventId: "evt-1", state: "done" }]);
      expect(await scheduleOf()).toEqual([{ kind: "batchClose", due_ms: 3000 }]);
    } finally {
      restoreBatch();
      restoreSafety();
    }
  });

  it("firing while the read still runs in this instance sends no second read", async () => {
    const answer = { ...asResult(safetyEmergencyNow), eventId: "evt-1" };
    const h = harness(keys, { "evt-1": answer }, { delayMs: 2000 });
    const restoreSafety = setSafetyDeps(h.deps);
    const restoreBatch = setBatchHooks({ clock: h.clock, toLease: () => undefined });
    try {
      await arrive("evt-1", EMERGENCY_TEXT);
      await h.clock.advance(1000);
      expect(await runDurableObjectAlarm(stub())).toBe(true);
      await h.clock.advance(1000);
      await actorOf().safetyIdle();

      expect(h.read.requests.map((request) => request.eventId)).toEqual(["evt-1"]);
      expect(h.core.recorded.map((call) => call.at)).toEqual([2000]);
    } finally {
      restoreBatch();
      restoreSafety();
    }
  });

  it("firing past the deadline while the read's work still runs sends no second read, and comes back in 1 s only until the line's 5 s budget is spent, then every 30 s", async () => {
    const answer = { ...asResult(safetyEmergencyNow), eventId: "evt-1" };
    const h = harness(keys, { "evt-1": answer });
    // The shared core takes the record and never answers, so this text's safety work runs on past its 4 s deadline.
    const restoreSafety = setSafetyDeps({
      ...h.deps,
      core: { ...h.core, recordSafetyOutcome: () => new Promise(() => undefined) },
    });
    const restoreBatch = setBatchHooks({ clock: h.clock, toLease: () => undefined });
    try {
      await arrive("evt-1", EMERGENCY_TEXT);
      await vi.waitFor(() => {
        expect(h.read.requests).toHaveLength(1);
      });
      await h.clock.advance(4000);
      await runDurableObjectAlarm(stub());
      expect(await actorOf().readSafety()).toMatchObject([{ eventId: "evt-1", state: "reading" }]);
      expect(await scheduleOf()).toContainEqual({ kind: "safetyRead", due_ms: 5000 });

      // 5 s: the line's budget is spent; the hang is looked at every 30 s from now on, never every second (security
      // note a), and no second read is sent while the work still runs here.
      await h.clock.advance(1000);
      await runDurableObjectAlarm(stub());
      expect(await scheduleOf()).toContainEqual({ kind: "safetyRead", due_ms: 35_000 });
      await h.clock.advance(30_000);
      await runDurableObjectAlarm(stub());
      expect(await scheduleOf()).toContainEqual({ kind: "safetyRead", due_ms: 65_000 });
      expect(await actorOf().readSafety()).toMatchObject([{ eventId: "evt-1", state: "reading" }]);
      expect(h.read.requests).toHaveLength(1);
    } finally {
      restoreBatch();
      restoreSafety();
    }
  });
});

describe("a read cut off by an eviction", () => {
  it("a read cut off at 1 s is read again when the alarm wakes the actor, and the danger line goes before the timeout rule's 4 s", async () => {
    const answer = { ...asResult(safetyEmergencyNow), eventId: "evt-1" };
    await withEviction({ "evt-1": answer }, { delayMs: 500 }, async (run) => {
      await arrive("evt-1", EMERGENCY_TEXT);
      await run.h.clock.advance(1000);
      await vi.waitFor(() => {
        expect(run.cutOff.map((request) => request.eventId)).toEqual(["evt-1"]);
      });
      expect(await actorOf().readSafety()).toMatchObject([{ eventId: "evt-1", state: "reading" }]);
      await run.evict();

      // 3 s: the stored alarm (the batch's close, the earliest entry) brings a new instance, which reads the text again
      // with the 1 s it has left.
      await run.h.clock.advance(2000);
      await run.wake();
      await vi.waitFor(() => {
        expect(run.h.read.requests.map((request) => request.eventId)).toEqual(["evt-1"]);
      });
      expect(run.h.read.requests[0]?.words.body).toBe(EMERGENCY_TEXT);
      expect(run.h.core.recorded).toEqual([]);

      // 3.5 s: the verdict (An emergency) comes; the checked line is handed on then, inside the 4 s of the timeout rule.
      await run.h.clock.advance(500);
      await run.settle();
      expect(run.h.core.recorded).toHaveLength(1);
      expect(run.h.core.recorded[0]?.at).toBe(3500);
      expect(run.h.core.recorded[0]?.request.safety).toEqual(answer);
      expect(await actorOf().readSafety()).toMatchObject([
        {
          eventId: "evt-1",
          state: "done",
          danger: true,
          path: "outbox",
          lineId: "safetyEmergency",
          handedAfterMs: 3500,
        },
      ]);
      expect(run.h.core.fixed).toEqual([]);

      // The settle path ran: the batch that closed at 3 s waited for the read and goes on now, with the hold open for its
      // commit; nothing is left for the safety alarm.
      await vi.waitFor(() => {
        expect(run.handed.map((batch) => batch.entries.map((entry) => entry.event.eventId))).toEqual([
          ["evt-1"],
        ]);
      });
      expect(await actorOf().readHolds()).toMatchObject([
        { eventId: "evt-1", rule: "after_safe", released: false },
      ]);
      await vi.waitFor(async () => {
        expect(await scheduleOf()).toEqual([]);
      });
    });
  });

  it("past 4 s, a cut-off read takes the timeout rule at once: a danger word's line goes at the alarm's 4 s, no later", async () => {
    const eventId = safetyTimeoutDangerWord.eventId;
    await withEviction({}, {}, async (run) => {
      await arrive(eventId, BLEEDING_TEXT);
      await run.h.clock.advance(1000);
      await run.evict();

      // 4 s: the safety alarm (the read's deadline) brings a new instance; the deadline has passed, so the danger-word
      // rule applies at once: Unsure, and the 911 line.
      await run.h.clock.advance(3000);
      await run.wake();
      await run.settle();

      expect(run.h.core.recorded).toHaveLength(1);
      expect(run.h.core.recorded[0]?.at).toBe(4000);
      expect(run.h.core.recorded[0]?.request.safety).toEqual(asResult(safetyTimeoutDangerWord));
      expect(run.h.core.recorded[0]?.response).toMatchObject({
        safetyLine: { fixedLineId: "safetyEmergency" },
      });
      expect(run.h.core.fixed).toEqual([]);
      expect(await actorOf().readSafety()).toMatchObject([
        { eventId, state: "done", danger: true, path: "outbox", handedAfterMs: 4000 },
      ]);
      expect(await actorOf().readHolds()).toMatchObject([{ eventId, rule: "after_safe", released: false }]);
    });
  });

  it("past 4 s with no danger word: the outage line at once, and the read sent again lifts the unread hold with its late verdict, so routine work is not held for ever", async () => {
    const answer = { ...asResult(safetyNo), eventId: "evt-1" };
    await withEviction({ "evt-1": answer }, { delayMs: 1000 }, async (run) => {
      await arrive("evt-1", PLAIN_TEXT);
      await run.h.clock.advance(1000);
      await run.evict();

      await run.h.clock.advance(3000);
      await run.wake();
      await run.settle();
      expect(run.h.core.fixed.map((call) => [call.at, call.request.fixedLineId])).toEqual([[4000, "outage"]]);
      expect(await actorOf().readHolds()).toMatchObject([
        { eventId: "evt-1", rule: "unread", released: false },
      ]);
      expect(await actorOf().routineHeld()).toBe(true);
      // The batch, closed by the alarm, waits: its text has not been read.
      await vi.waitFor(async () => {
        expect(await actorOf().readBatches()).toMatchObject([
          { reason: "quiet", handed: false, eventIds: ["evt-1"] },
        ]);
      });
      expect(run.handed).toEqual([]);
      expect(run.h.read.requests.map((request) => request.eventId)).toEqual(["evt-1"]);

      // 5 s: the read sent again says No; the unread hold lifts and the settle path hands the batch on.
      await run.h.clock.advance(1000);
      await vi.waitFor(() => {
        expect(run.handed.map((batch) => batch.entries.map((entry) => entry.event.eventId))).toEqual([
          ["evt-1"],
        ]);
      });
      expect(await actorOf().routineHeld()).toBe(false);
      expect(await actorOf().readHolds()).toMatchObject([
        { eventId: "evt-1", rule: "unread", released: true },
      ]);
    });
  });

  it("a new text wakes the actor too: the cut-off read is resumed first, in arrival order, and its danger closes the open batch at once", async () => {
    const danger = { ...asResult(safetyEmergencyNow), eventId: "evt-1" };
    const plain = { ...asResult(safetyNo), eventId: "evt-2" };
    await withEviction({ "evt-1": danger, "evt-2": plain }, { delayMs: 500 }, async (run) => {
      await arrive("evt-1", EMERGENCY_TEXT);
      await run.h.clock.advance(1000);
      await run.evict();

      // 2 s: a second text arrives; the new instance reads evt-1 again before it reads evt-2.
      await run.h.clock.advance(1000);
      await arrive("evt-2", PLAIN_TEXT);
      await vi.waitFor(() => {
        expect(run.h.read.requests.map((request) => request.eventId)).toEqual(["evt-1", "evt-2"]);
      });

      // 2.5 s: both verdicts; evt-1's danger closes the open batch at once (before its 3 s quiet close) and its line goes.
      await run.h.clock.advance(500);
      await run.settle();
      expect(run.h.core.recorded.map((call) => [call.at, call.request.safety.eventId])).toEqual([
        [2500, "evt-1"],
      ]);
      await vi.waitFor(async () => {
        expect(await actorOf().readBatches()).toMatchObject([
          { reason: "danger", handed: true, eventIds: ["evt-1", "evt-2"] },
        ]);
      });
      expect(run.handed[0]).toMatchObject({ reason: "danger", closedAt: 2500 });
    });
  });

  it("several cut-off reads resume in arrival order, each keeping its own deadline from its own arrival", async () => {
    const first = { ...asResult(safetyNo), eventId: "evt-1" };
    const second = { ...asResult(safetyNo), eventId: "evt-2" };
    await withEviction({ "evt-1": first, "evt-2": second }, { delayMs: 3000 }, async (run) => {
      await arrive("evt-1", "Is Thursday free?");
      await run.h.clock.advance(1000);
      await arrive("evt-2", "or Friday morning");
      await run.h.clock.advance(500);
      await vi.waitFor(() => {
        expect(run.cutOff.map((request) => request.eventId)).toEqual(["evt-1", "evt-2"]);
      });
      await run.evict();

      // 2.5 s: woken by the stored alarm; each text is read again, in arrival order. The reads answer at 5.5 s, so each
      // text's own deadline (4 s from its arrival: 4 s and 5 s) decides what it gets meanwhile.
      await run.h.clock.advance(1000);
      await run.wake();
      await vi.waitFor(() => {
        expect(run.h.read.requests.map((request) => request.eventId)).toEqual(["evt-1", "evt-2"]);
      });

      // 4 s: evt-1's deadline: the outage line, and its unread hold. 5 s: evt-2's.
      await run.h.clock.advance(1500);
      await vi.waitFor(() => {
        expect(run.h.core.fixed.map((call) => [call.at, call.request.caller.requestId])).toEqual([
          [4000, "safety:evt-1"],
        ]);
      });
      await run.h.clock.advance(1000);
      await vi.waitFor(() => {
        expect(run.h.core.fixed.map((call) => [call.at, call.request.caller.requestId])).toEqual([
          [4000, "safety:evt-1"],
          [5000, "safety:evt-2"],
        ]);
      });

      // 5.5 s: the verdicts come, late for both, and lift their unread holds: no text stays unread and held.
      await run.h.clock.advance(500);
      await vi.waitFor(async () => {
        expect(await actorOf().routineHeld()).toBe(false);
      });
      expect(run.h.core.fixed).toHaveLength(2);
      expect(await actorOf().readSafety()).toMatchObject([
        { eventId: "evt-1", state: "done", danger: false },
        { eventId: "evt-2", state: "done", danger: false },
      ]);
      expect(await actorOf().readHolds()).toMatchObject([
        { eventId: "evt-1", rule: "unread", released: true },
        { eventId: "evt-2", rule: "unread", released: true },
      ]);
    });
  });

  it("with nothing wired after the eviction, nothing is resumed and no alarm keeps firing for it; the text stays held", async () => {
    await withEviction({}, {}, async (run) => {
      await arrive("evt-1", PLAIN_TEXT);
      await run.h.clock.advance(1000);
      await run.evict();
      const restore = setSafetyDeps(null);
      try {
        await run.h.clock.advance(3000);
        await run.wake();
        await actorOf().batchIdle();
        // The alarm closed the batch and dropped the safety entry: nothing can resume the read, so nothing polls for it.
        await vi.waitFor(async () => {
          expect(await actorOf().readBatches()).toMatchObject([{ reason: "quiet", handed: false }]);
          expect(await scheduleOf()).toEqual([]);
          expect(await alarmOf()).toBeNull();
        });
        expect(await actorOf().readSafety()).toMatchObject([{ eventId: "evt-1", state: "reading" }]);
        expect(await actorOf().routineHeld()).toBe(true);
        expect(run.h.read.requests).toEqual([]);
      } finally {
        restore();
      }
    });
  });

  it("a cut-off read whose key store throws at once still gets the outage line (no verdict can come), keeps its unread hold, and is read again 30 s on (security note d)", async () => {
    const answer = { ...asResult(safetyNo), eventId: "evt-1" };
    await withEviction({ "evt-1": answer }, {}, async (run) => {
      await arrive("evt-1", PLAIN_TEXT);
      await run.h.clock.advance(1000);
      await run.evict({
        ...run.h.deps,
        keys: {
          getOrCreateKey: () => {
            throw new Error("the key store broke");
          },
        },
      });

      // 3 s: woken; the words cannot be opened, so the timeout rule applies at once, as for a read that fails on arrival:
      // no danger word can be matched, so the outage line goes, and the text stays unread and held.
      await run.h.clock.advance(2000);
      await run.wake();
      await run.settle();
      expect(run.h.core.fixed.map((call) => [call.at, call.request.fixedLineId])).toEqual([[3000, "outage"]]);
      expect(await actorOf().readSafety()).toMatchObject([
        { eventId: "evt-1", state: "done", danger: false, lineId: "outage" },
      ]);
      expect(await actorOf().readHolds()).toMatchObject([
        { eventId: "evt-1", rule: "unread", released: false },
      ]);
      expect(await actorOf().routineHeld()).toBe(true);
      expect(run.h.read.requests).toEqual([]);
      await vi.waitFor(async () => {
        expect(await actorOf().readBatches()).toMatchObject([{ reason: "quiet", handed: false }]);
        expect(await scheduleOf()).toEqual([{ kind: "safetyRead", due_ms: 33_000 }]);
      });

      // 33 s: the key store answers again; the re-read says No, the hold lifts and the batch goes on.
      const restore = setSafetyDeps(run.h.deps);
      try {
        await run.h.clock.advance(30_000);
        await run.wake();
        await vi.waitFor(() => {
          expect(run.handed.map(idsOf)).toEqual([["evt-1"]]);
        });
        expect(run.h.read.requests.map((request) => request.eventId)).toEqual(["evt-1"]);
        expect(await actorOf().readHolds()).toMatchObject([
          { eventId: "evt-1", rule: "unread", released: true },
        ]);
        expect(run.h.core.fixed).toHaveLength(1);
      } finally {
        restore();
      }
    });
  });

  it("writes no word of a resumed text into the logs", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const answer = { ...asResult(safetyEmergencyNow), eventId: "evt-1" };
    await withEviction({ "evt-1": answer }, {}, async (run) => {
      await arrive("evt-1", EMERGENCY_TEXT);
      await run.h.clock.advance(1000);
      await run.evict();
      await run.h.clock.advance(2000);
      await run.wake();
      await run.settle();
      expect(run.h.core.recorded).toHaveLength(1);
    });
    const lines = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(lines).toContain('"hop":"safetyRead"');
    expect(lines).not.toContain("lips are swelling");
    expect(lines).not.toContain("breathe");
    expect(lines).not.toContain("+15555550101");
  });
});

// Round 2 (DL-127; the security reviewer's gap on 37fc0f6): a text that took the timeout rule with no danger word has its
// unread hold open until a verdict lands. Its late answer was awaited only in memory, so an eviction could lose it and
// leave the text unread and held for good, with every later batch of the handle behind it. Now its next re-read is
// stored and the actor's alarm comes back for it every 30 s until a verdict lands (arch 11 line 564).
describe("a text with no verdict in 4 s (its unread hold open)", () => {
  it("an eviction between the timeout rule and the late verdict: the stored re-read wakes a new instance 30 s on, and the text's verdict lifts the hold", async () => {
    const answer = { ...asResult(safetyNo), eventId: "evt-1" };
    await withEviction({ "evt-1": answer }, { deadlineRuns: true }, async (run) => {
      await arrive("evt-1", PLAIN_TEXT);
      // 4 s: no verdict and no danger word: the outage line once, the unread hold, and the first re-read stored 30 s on.
      // The late answer is awaited in this instance's memory only.
      await run.h.clock.advance(4000);
      await run.settle();
      expect(run.h.core.fixed.map((call) => [call.at, call.request.fixedLineId])).toEqual([[4000, "outage"]]);
      expect(await actorOf().readHolds()).toMatchObject([
        { eventId: "evt-1", rule: "unread", released: false },
      ]);
      await vi.waitFor(async () => {
        expect(await scheduleOf()).toContainEqual({ kind: "safetyRead", due_ms: 34_000 });
      });

      // 5 s: the actor is cut off before the late answer comes; it is lost with the instance.
      await run.h.clock.advance(1000);
      await run.evict();
      expect(await actorOf().routineHeld()).toBe(true);
      expect(run.h.read.requests).toEqual([]);

      // 34 s: the stored entry wakes a new instance; the text is read again, its verdict (No) lifts the unread hold, and
      // the batch it kept back goes on. The outage line went once.
      await run.h.clock.advance(29_000);
      await run.wake();
      await vi.waitFor(() => {
        expect(run.handed.map(idsOf)).toEqual([["evt-1"]]);
      });
      expect(run.h.read.requests.map((request) => request.eventId)).toEqual(["evt-1"]);
      expect(await actorOf().readHolds()).toMatchObject([
        { eventId: "evt-1", rule: "unread", released: true },
      ]);
      expect(await actorOf().routineHeld()).toBe(false);
      expect(run.h.core.fixed).toHaveLength(1);
      await vi.waitFor(async () => {
        expect(await scheduleOf()).toEqual([]);
      });
    });
  });

  it("a second cut, between a resumed read's timeout rule and its late verdict, still ends in a re-read 30 s on that lifts the hold", async () => {
    const answer = { ...asResult(safetyNo), eventId: "evt-1" };
    await withEviction({ "evt-1": answer }, {}, async (run) => {
      await arrive("evt-1", PLAIN_TEXT);
      await run.h.clock.advance(1000);
      // The first cut; the new instance's read never answers either.
      await run.evict(run.stalled);

      // 4 s: woken past the deadline: the timeout rule at once (the outage line, the unread hold, its re-read 30 s on),
      // and the read is sent again for a late verdict.
      await run.h.clock.advance(3000);
      await run.wake();
      await run.settle();
      expect(run.h.core.fixed.map((call) => [call.at, call.request.fixedLineId])).toEqual([[4000, "outage"]]);
      expect(run.cutOff.map((request) => request.eventId)).toEqual(["evt-1", "evt-1"]);
      expect(await actorOf().readHolds()).toMatchObject([
        { eventId: "evt-1", rule: "unread", released: false },
      ]);

      // 4.5 s: the second cut, before that read answers (the case the security reviewer named).
      await run.h.clock.advance(500);
      await run.evict();

      // 34 s: the stored re-read wakes the actor; the verdict lifts the hold and the batch goes on.
      await run.h.clock.advance(29_500);
      await run.wake();
      await vi.waitFor(() => {
        expect(run.handed.map(idsOf)).toEqual([["evt-1"]]);
      });
      expect(run.h.read.requests.map((request) => request.eventId)).toEqual(["evt-1"]);
      expect(await actorOf().readHolds()).toMatchObject([
        { eventId: "evt-1", rule: "unread", released: true },
      ]);
      expect(run.h.core.fixed).toHaveLength(1);
    });
  });

  it("a model outage across several re-reads: each timedOut or failed answer keeps the hold and sets the next re-read 30 s after it; the outage line goes once; the first verdict lifts the hold", async () => {
    const h = harness(keys, {});
    const calls: SafetyReadRequest[] = [];
    // The models are down: the late answer (6 s) and the first re-read are the read's own timedOut marker, the second
    // re-read fails outright; the third comes after the models are back.
    const read: SafetyReadPort = {
      async read(request) {
        calls.push(request);
        if (calls.length === 1) {
          await h.clock.after(6000);
          return gaveUp(request.eventId);
        }
        if (calls.length === 2) return gaveUp(request.eventId);
        if (calls.length === 3) throw new Error("the models are down");
        return verdict({ ...asResult(safetyNo), eventId: request.eventId });
      },
    };
    const handed: ClosedBatch[] = [];
    const restoreSafety = setSafetyDeps({ ...h.deps, read });
    const restoreBatch = setBatchHooks({
      clock: h.clock,
      toLease: (batch) => {
        handed.push(batch);
      },
    });
    const holdOpen = async (): Promise<void> => {
      expect(await actorOf().readHolds()).toMatchObject([
        { eventId: "evt-1", rule: "unread", released: false },
      ]);
      expect(await actorOf().routineHeld()).toBe(true);
      expect(handed).toEqual([]);
    };
    try {
      await arrive("evt-1", PLAIN_TEXT);
      await h.clock.advance(4000);
      await actorOf().safetyIdle();
      expect(h.core.fixed.map((call) => [call.at, call.request.fixedLineId])).toEqual([[4000, "outage"]]);

      // 6 s: the late answer is itself timedOut: no verdict. The hold stays and the next re-read is 30 s after it.
      await h.clock.advance(2000);
      await vi.waitFor(async () => {
        expect(await scheduleOf()).toContainEqual({ kind: "safetyRead", due_ms: 36_000 });
      });
      await holdOpen();

      // 36 s: read again: timedOut again. 66 s: read again: the read fails.
      await h.clock.advance(30_000);
      await runDurableObjectAlarm(stub());
      await vi.waitFor(async () => {
        expect(calls).toHaveLength(2);
        expect(await scheduleOf()).toContainEqual({ kind: "safetyRead", due_ms: 66_000 });
      });
      await holdOpen();
      await h.clock.advance(30_000);
      await runDurableObjectAlarm(stub());
      await vi.waitFor(async () => {
        expect(calls).toHaveLength(3);
        expect(await scheduleOf()).toContainEqual({ kind: "safetyRead", due_ms: 96_000 });
      });
      await holdOpen();
      // Never lifted without a verdict, and the outage line is never sent again.
      expect(h.core.fixed).toHaveLength(1);
      expect(h.direct.sent).toEqual([]);

      // 96 s: the models are back: the verdict (No) lifts the hold, the batch goes on and the re-reads stop.
      await h.clock.advance(30_000);
      await runDurableObjectAlarm(stub());
      await vi.waitFor(() => {
        expect(handed.map(idsOf)).toEqual([["evt-1"]]);
      });
      expect(calls.map((request) => request.eventId)).toEqual(["evt-1", "evt-1", "evt-1", "evt-1"]);
      expect(await actorOf().readHolds()).toMatchObject([
        { eventId: "evt-1", rule: "unread", released: true },
      ]);
      expect(await actorOf().routineHeld()).toBe(false);
      await vi.waitFor(async () => {
        expect((await scheduleOf()).map((entry) => entry.kind)).not.toContain("safetyRead");
      });
      expect(h.core.fixed).toHaveLength(1);
    } finally {
      restoreBatch();
      restoreSafety();
    }
  });

  it("on return every held text is read again at once, in arrival order: a danger among them gets its line then, not at its own re-read, and the batch goes on once all are read", async () => {
    const h = harness(keys, {});
    let modelsBack = false;
    const answers: Record<string, SafetyResult> = {
      "evt-1": { ...asResult(safetyNo), eventId: "evt-1" },
      "evt-2": { ...asResult(safetyEmergencyNow), eventId: "evt-2" },
    };
    const calls: SafetyReadRequest[] = [];
    // Down: each read gives up after both models' 2 s, here late (6 s after it is sent). Back: each read answers at once.
    const read: SafetyReadPort = {
      async read(request) {
        calls.push(request);
        const answer = answers[request.eventId];
        if (!modelsBack || answer === undefined) {
          await h.clock.after(6000);
          return gaveUp(request.eventId);
        }
        return verdict(answer);
      },
    };
    const handed: ClosedBatch[] = [];
    const restoreSafety = setSafetyDeps({ ...h.deps, read });
    const restoreBatch = setBatchHooks({
      clock: h.clock,
      toLease: (batch) => {
        handed.push(batch);
      },
    });
    try {
      // A plain text, then a danger the danger-word list does not hold: each gets the outage line at its own 4 s, and
      // each late answer (6 s and 7 s) gives up: their re-reads are due at 36 s and 37 s.
      await arrive("evt-1", PLAIN_TEXT);
      await h.clock.advance(1000);
      await arrive("evt-2", SMOKE_TEXT);
      await h.clock.advance(6000);
      await actorOf().safetyIdle();
      expect(h.core.fixed.map((call) => [call.at, call.request.caller.requestId])).toEqual([
        [4000, "safety:evt-1"],
        [5000, "safety:evt-2"],
      ]);
      expect(h.core.recorded).toEqual([]);
      await vi.waitFor(async () => {
        expect(await scheduleOf()).toContainEqual({ kind: "safetyRead", due_ms: 36_000 });
      });

      // 36 s: the models are back. evt-1's re-read gives a verdict, so evt-2 (due at 37 s) is read again at once, and its
      // danger line goes now (the alarm is run until it has: the runtime may also run it on its own).
      modelsBack = true;
      await h.clock.advance(29_000);
      await vi.waitFor(async () => {
        await runDurableObjectAlarm(stub());
        expect(h.core.recorded.map((call) => [call.at, call.request.safety.eventId])).toEqual([
          [36_000, "evt-2"],
        ]);
      });
      expect(calls.slice(2).map((request) => request.eventId)).toEqual(["evt-1", "evt-2"]);
      expect(h.core.recorded[0]?.response).toMatchObject({ safetyLine: { fixedLineId: "safetyEmergency" } });

      // Both read: the batch they were in goes on, once, with evt-2's danger hold open for its commit.
      await vi.waitFor(() => {
        expect(handed.map(idsOf)).toEqual([["evt-1", "evt-2"]]);
      });
      expect(await actorOf().readHolds()).toMatchObject([
        { eventId: "evt-1", rule: "unread", released: true },
        { eventId: "evt-2", rule: "after_safe", released: false },
      ]);
      expect(await actorOf().readSafety()).toMatchObject([
        { eventId: "evt-1", state: "done", danger: false },
        { eventId: "evt-2", state: "done", danger: true, lineId: "safetyEmergency" },
      ]);
    } finally {
      restoreBatch();
      restoreSafety();
    }
  });

  it("a throw in the safety part of the alarm still lets the batch and lease handlers run, and moves the safety entry 30 s on (security note c)", async () => {
    const h = harness(keys, {});
    let broken = false;
    let reads = 0;
    // The first read gives up at once (timedOut): the timeout rule applies at 0 and the re-read is due at 30 s. Later
    // reads say No.
    const read: SafetyReadPort = {
      read(request) {
        reads += 1;
        return Promise.resolve(
          reads === 1
            ? gaveUp(request.eventId)
            : verdict({ ...asResult(safetyNo), eventId: request.eventId }),
        );
      },
    };
    const handed: ClosedBatch[] = [];
    const restoreSafety = setSafetyDeps({
      ...h.deps,
      read,
      clock: {
        now: () => {
          if (broken) throw new Error("the clock broke");
          return h.clock.now();
        },
        after: (ms) => h.clock.after(ms),
      },
    });
    const restoreBatch = setBatchHooks({
      clock: h.clock,
      toLease: (batch) => {
        handed.push(batch);
      },
    });
    try {
      await arrive("evt-1", PLAIN_TEXT);
      await actorOf().safetyIdle();
      expect(await actorOf().readHolds()).toMatchObject([{ rule: "unread", released: false }]);

      // 3 s: the batch's close is due, and the safety read's clock throws inside the alarm.
      broken = true;
      await h.clock.advance(3000);
      await runDurableObjectAlarm(stub());
      await actorOf().batchIdle();
      expect(await actorOf().readBatches()).toMatchObject([
        { reason: "quiet", handed: false, eventIds: ["evt-1"] },
      ]);
      expect(await scheduleOf()).toEqual([{ kind: "safetyRead", due_ms: 33_000 }]);
      expect(await alarmOf()).not.toBeNull();

      // 33 s: the clock answers again; the re-read lifts the hold and the batch goes on.
      broken = false;
      await h.clock.advance(30_000);
      await runDurableObjectAlarm(stub());
      await vi.waitFor(() => {
        expect(handed.map(idsOf)).toEqual([["evt-1"]]);
      });
      expect(reads).toBe(2);
    } finally {
      restoreBatch();
      restoreSafety();
    }
  });
});

// Round 3 (DL-132; the security reviewer's second FAIL on 032fc0f, GAP 1): a danger outcome stays open until its line has
// gone and its record is kept. The danger path writes the outcome's hold before its direct send and its record, so an
// eviction in between lost the line: a resumed read took the timeout rule and its danger verdict was dropped, or, on the
// late path, no re-read came at all. PostgreSQL is down in these tests (the core refuses), so the line goes straight
// through Linq; Linq's send before the cut never ends.
describe("a danger outcome cut off before its line and record are done", () => {
  type DirectLine = Parameters<SafetyDeps["direct"]["send"]>[0];

  /** A Linq send that never ends (the cut comes during it); each request is kept. */
  function hangingDirect(): { attempts: DirectLine[]; direct: SafetyDeps["direct"] } {
    const attempts: DirectLine[] = [];
    return {
      attempts,
      direct: {
        send(request) {
          attempts.push(request);
          return new Promise(() => undefined);
        },
      },
    };
  }

  /** The record kept for return: once the core answers again it is written, once, with the line the actor sent. */
  async function expectRecordKept(h: Harness, result: SafetyResult): Promise<void> {
    h.core.down = false;
    expect(await stub().writeSafetyOnReturn()).toBe(1);
    expect(h.core.recorded).toHaveLength(1);
    expect(h.core.recorded[0]?.request).toMatchObject({
      caller: { kind: "actorOnReturn" },
      safety: result,
      sentByActor: { fixedLineId: "safetyEmergency", linqMessageId: "linq-1" },
    });
    expect(await stub().writeSafetyOnReturn()).toBe(0);
  }

  it("the core refuses and Linq's send hangs until the cut: the resumed read's danger verdict is applied, not the timeout rule, so the emergency line goes once and its record is kept", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const answer = { ...asResult(safetyEmergencyNow), eventId: "evt-1" };
    const hanging = hangingDirect();
    await withEviction(
      { "evt-1": answer },
      { before: (h) => ({ ...h.deps, direct: hanging.direct }) },
      async (run) => {
        run.h.core.down = true;
        await arrive("evt-1", SMOKE_TEXT);
        // 0 s: the read says An emergency (the text holds no danger word). The core refuses, so the hold is written and
        // the line goes to Linq, which never answers.
        await vi.waitFor(() => {
          expect(hanging.attempts.map((request) => request.fixedLineId)).toEqual(["safetyEmergency"]);
        });
        expect(await actorOf().readSafety()).toMatchObject([{ eventId: "evt-1", state: "reading" }]);
        expect(await actorOf().readHolds()).toMatchObject([
          { eventId: "evt-1", rule: "after_safe", holdId: null, released: false },
        ]);

        // 1 s: the cut, during the send.
        await run.h.clock.advance(1000);
        await run.evict();

        // 4 s: the stored alarm wakes a new instance past the deadline. A verdict came before the cut, so no timeout rule
        // (no outage line): the text is read again, and its danger verdict goes through the same send with the same key.
        await run.h.clock.advance(3000);
        await run.wake();
        await vi.waitFor(() => {
          expect(run.h.direct.sent).toHaveLength(1);
        });
        expect(run.h.direct.sent[0]).toMatchObject({
          at: 4000,
          fixedLineId: "safetyEmergency",
          overrideOptout: true,
          idempotencyKey: hanging.attempts[0]?.idempotencyKey,
        });
        expect(run.h.read.requests.map((request) => request.eventId)).toEqual(["evt-1", "evt-1"]);
        expect(run.h.core.fixed).toEqual([]);
        await vi.waitFor(async () => {
          expect(await actorOf().readSafety()).toMatchObject([
            { eventId: "evt-1", state: "done", danger: true, path: "direct", lineId: "safetyEmergency" },
          ]);
          expect((await scheduleOf()).map((entry) => entry.kind)).not.toContain("safetyRead");
        });
        await expectRecordKept(run.h, answer);
        expect(await actorOf().readHolds()).toMatchObject([
          { eventId: "evt-1", rule: "after_safe", holdId: "hold-evt-1", released: false },
        ]);
        expect(run.h.direct.sent).toHaveLength(1);
      },
    );
    const lines = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(lines).toContain('"hop":"safetyRead"');
    expect(lines).not.toContain("smoke pouring");
    expect(lines).not.toContain("+15555550101");
  });

  it.each(["late", "reread"] as const)(
    "on the late path (a %s verdict found danger and its hold replaced the unread hold) the cut comes during the send: the stored re-read wakes the actor, and the line goes once with its record kept",
    async (kind) => {
      const answer = { ...asResult(safetyEmergencyNow), eventId: "evt-1" };
      const hanging = hangingDirect();
      await withEviction(
        { "evt-1": answer },
        {
          before: (h) => {
            let calls = 0;
            const read: SafetyReadPort = {
              async read(request) {
                calls += 1;
                // The read sent on arrival answers at 6 s, past the deadline: late, An emergency; reread, it gives up
                // (timedOut), and the re-read at 36 s says An emergency.
                if (calls === 1) {
                  await h.clock.after(6000);
                  return kind === "late" ? verdict(answer) : gaveUp(request.eventId);
                }
                return verdict(answer);
              },
            };
            return { ...h.deps, read, direct: hanging.direct };
          },
        },
        async (run) => {
          await arrive("evt-1", SMOKE_TEXT);
          // 4 s: no verdict and no danger word: the outage line (the core is still up) and the unread hold.
          await run.h.clock.advance(4000);
          await run.settle();
          expect(run.h.core.fixed.map((call) => [call.at, call.request.fixedLineId])).toEqual([
            [4000, "outage"],
          ]);
          run.h.core.down = true;

          // The danger verdict: its hold replaces the unread hold, the core refuses, and Linq's send never ends.
          if (kind === "late") {
            await run.h.clock.advance(2000);
          } else {
            await run.h.clock.advance(32_000);
            await run.wake();
          }
          await vi.waitFor(() => {
            expect(hanging.attempts.map((request) => request.fixedLineId)).toEqual(["safetyEmergency"]);
          });
          expect(await actorOf().readHolds()).toMatchObject([
            { eventId: "evt-1", rule: "after_safe", released: false },
          ]);
          // The text stays scheduled: its stored re-read now waits for the danger's line and record.
          const due = kind === "late" ? 34_000 : 66_000;
          expect(await scheduleOf()).toContainEqual({ kind: "safetyRead", due_ms: due });

          // The cut, during the send; the stored re-read wakes a new instance.
          await run.h.clock.advance(1000);
          await run.evict();
          await run.h.clock.advance(due - run.h.clock.now());
          await run.wake();
          await vi.waitFor(() => {
            expect(run.h.direct.sent).toHaveLength(1);
          });
          expect(run.h.direct.sent[0]).toMatchObject({
            at: due,
            fixedLineId: "safetyEmergency",
            idempotencyKey: hanging.attempts[0]?.idempotencyKey,
          });
          await vi.waitFor(async () => {
            expect(await actorOf().readSafety()).toMatchObject([
              { eventId: "evt-1", state: "done", danger: true, path: "direct", lineId: "safetyEmergency" },
            ]);
            expect((await scheduleOf()).map((entry) => entry.kind)).not.toContain("safetyRead");
          });
          expect(run.h.core.fixed).toHaveLength(1);
          await expectRecordKept(run.h, answer);
        },
      );
    },
  );

  it("a core that throws at once (no rejected promise) still gets the hold written and the line tried; with Linq refusing too, the text keeps its hold, stays scheduled, and its line goes once at the next re-read with its record kept (round 2 security note b)", async () => {
    const answer = { ...asResult(safetyEmergencyNow), eventId: "evt-1" };
    const h = harness(keys, {});
    let reads = 0;
    // The read sent on arrival says An emergency at 6 s, past the deadline; the re-read says it at once.
    const read: SafetyReadPort = {
      async read() {
        reads += 1;
        if (reads === 1) await h.clock.after(6000);
        return verdict(answer);
      },
    };
    const throwing: SafetyDeps["core"] = {
      recordSafetyOutcome: () => {
        throw new Error("the core broke");
      },
      sendFixedLine: (request) => h.core.sendFixedLine(request),
      releaseSafetyHold: (request) => h.core.releaseSafetyHold(request),
    };
    const restoreSafety = setSafetyDeps({ ...h.deps, read, core: throwing });
    const restoreBatch = setBatchHooks({ clock: h.clock, toLease: () => undefined });
    try {
      await arrive("evt-1", SMOKE_TEXT);
      await h.clock.advance(4000);
      await actorOf().safetyIdle();
      expect(h.core.fixed.map((call) => call.request.fixedLineId)).toEqual(["outage"]);

      // 6 s: the late verdict, An emergency. The core throws at once: the hold is still written in place of the unread
      // hold, and the line is tried through Linq, which refuses. The text is in the holds, and stays scheduled.
      h.direct.fail = true;
      await h.clock.advance(2000);
      await vi.waitFor(async () => {
        expect(await actorOf().readSafety()).toMatchObject([
          { eventId: "evt-1", state: "lineFailed", danger: true, path: "none" },
        ]);
      });
      expect(await actorOf().readHolds()).toMatchObject([
        { eventId: "evt-1", rule: "after_safe", holdId: null, released: false },
      ]);
      expect(await actorOf().routineHeld()).toBe(true);
      expect(h.direct.sent).toEqual([]);
      await vi.waitFor(async () => {
        expect(await scheduleOf()).toContainEqual({ kind: "safetyRead", due_ms: 36_000 });
      });

      // 36 s: Linq answers again. The re-read's danger verdict sends the line once, and its record is kept.
      h.direct.fail = false;
      await h.clock.advance(30_000);
      await runDurableObjectAlarm(stub());
      await vi.waitFor(() => {
        expect(h.direct.sent).toHaveLength(1);
      });
      expect(h.direct.sent[0]).toMatchObject({
        at: 36_000,
        fixedLineId: "safetyEmergency",
        idempotencyKey: "safety:evt-1:safetyEmergency",
      });
      await vi.waitFor(async () => {
        expect(await actorOf().readSafety()).toMatchObject([
          { eventId: "evt-1", state: "done", danger: true, path: "direct" },
        ]);
      });
      expect(await actorOf().readHolds()).toMatchObject([
        { eventId: "evt-1", rule: "after_safe", released: false },
      ]);
      expect(reads).toBe(2);
      const restoreCore = setSafetyDeps(h.deps);
      try {
        await expectRecordKept(h, answer);
      } finally {
        restoreCore();
      }
    } finally {
      restoreBatch();
      restoreSafety();
    }
  });

  it("a re-read that is still out gets no second read while it hangs: the alarm only moves the next re-read 30 s on (round 2 security note a)", async () => {
    const h = harness(keys, {});
    const calls: SafetyReadRequest[] = [];
    // The read sent on arrival gives up at once (timedOut): the timeout rule, and the first re-read due at 30 s. That
    // re-read never answers.
    const read: SafetyReadPort = {
      read(request) {
        calls.push(request);
        return calls.length === 1 ? Promise.resolve(gaveUp(request.eventId)) : new Promise(() => undefined);
      },
    };
    const restoreSafety = setSafetyDeps({ ...h.deps, read });
    const restoreBatch = setBatchHooks({ clock: h.clock, toLease: () => undefined });
    try {
      await arrive("evt-1", PLAIN_TEXT);
      await actorOf().safetyIdle();
      expect(await actorOf().readHolds()).toMatchObject([
        { eventId: "evt-1", rule: "unread", released: false },
      ]);
      await h.clock.advance(30_000);
      await runDurableObjectAlarm(stub());
      await vi.waitFor(() => {
        expect(calls).toHaveLength(2);
      });
      for (const at of [60_000, 90_000]) {
        await h.clock.advance(30_000);
        await runDurableObjectAlarm(stub());
        await vi.waitFor(async () => {
          expect(await scheduleOf()).toContainEqual({ kind: "safetyRead", due_ms: at + 30_000 });
        });
      }
      expect(calls).toHaveLength(2);
      expect(await actorOf().readHolds()).toMatchObject([
        { eventId: "evt-1", rule: "unread", released: false },
      ]);
    } finally {
      restoreBatch();
      restoreSafety();
    }
  });

  it("a resumed read that says No does not undo the danger its first read found: nothing goes for it, the hold stays, the text is read again 30 s on, and the next danger verdict sends the line once", async () => {
    const danger = { ...asResult(safetyEmergencyNow), eventId: "evt-1" };
    const hanging = hangingDirect();
    await withEviction(
      { "evt-1": danger },
      { before: (h) => ({ ...h.deps, direct: hanging.direct }) },
      async (run) => {
        run.h.core.down = true;
        await arrive("evt-1", SMOKE_TEXT);
        await vi.waitFor(() => {
          expect(hanging.attempts).toHaveLength(1);
        });
        await run.h.clock.advance(1000);
        let rereads = 0;
        await run.evict({
          ...run.h.deps,
          read: {
            read() {
              rereads += 1;
              return Promise.resolve(
                verdict(rereads === 1 ? { ...asResult(safetyNo), eventId: "evt-1" } : danger),
              );
            },
          },
        });

        // 4 s: woken; the read says No this time. Only the first verdict counts: nothing is sent, the hold stays, and the
        // text is read again 30 s on.
        await run.h.clock.advance(3000);
        await run.wake();
        await vi.waitFor(async () => {
          expect(rereads).toBe(1);
          expect(await scheduleOf()).toContainEqual({ kind: "safetyRead", due_ms: 34_000 });
        });
        expect(run.h.direct.sent).toEqual([]);
        expect(run.h.core.fixed).toEqual([]);
        expect(await actorOf().readHolds()).toMatchObject([
          { eventId: "evt-1", rule: "after_safe", released: false },
        ]);
        expect(await actorOf().readSafety()).toMatchObject([
          { eventId: "evt-1", state: "lineFailed", danger: true },
        ]);
        expect(await actorOf().routineHeld()).toBe(true);

        // 34 s: read again, An emergency: the line goes once, with the same key, and its record is kept.
        await run.h.clock.advance(30_000);
        await run.wake();
        await vi.waitFor(() => {
          expect(run.h.direct.sent).toHaveLength(1);
        });
        expect(run.h.direct.sent[0]).toMatchObject({
          at: 34_000,
          idempotencyKey: hanging.attempts[0]?.idempotencyKey,
        });
        expect(rereads).toBe(2);
        await expectRecordKept(run.h, danger);
      },
    );
  });

  it("a danger-word text cut off during its timeout line: a resumed read with no danger verdict still gets the danger-word rule, so the 911 line goes once, its record is kept and nothing is read again", async () => {
    const eventId = safetyTimeoutDangerWord.eventId;
    const hanging = hangingDirect();
    await withEviction(
      {},
      {
        before: (h) => ({
          ...h.deps,
          direct: hanging.direct,
          read: { read: () => new Promise(() => undefined) },
        }),
      },
      async (run) => {
        run.h.core.down = true;
        await arrive(eventId, BLEEDING_TEXT);
        // 4 s: no verdict: the danger word counts as Unsure; the core refuses and the 911 line goes to Linq, which never
        // answers.
        await run.h.clock.advance(4000);
        await vi.waitFor(() => {
          expect(hanging.attempts.map((request) => request.fixedLineId)).toEqual(["safetyEmergency"]);
        });
        await run.h.clock.advance(1000);
        let rereads = 0;
        await run.evict({
          ...run.h.deps,
          read: {
            read(request) {
              rereads += 1;
              return Promise.resolve(verdict({ ...asResult(safetyNo), eventId: request.eventId }));
            },
          },
        });

        // 5 s: woken. The read says No, which does not undo the Unsure the danger word gave; the danger-word rule still
        // holds, so the line goes now, once, with the same key, and nothing is read again.
        await run.wake();
        await vi.waitFor(() => {
          expect(run.h.direct.sent).toHaveLength(1);
        });
        expect(run.h.direct.sent[0]).toMatchObject({
          at: 5000,
          fixedLineId: "safetyEmergency",
          idempotencyKey: hanging.attempts[0]?.idempotencyKey,
        });
        await vi.waitFor(async () => {
          expect(await actorOf().readSafety()).toMatchObject([
            { eventId, state: "done", danger: true, path: "direct", lineId: "safetyEmergency" },
          ]);
          expect((await scheduleOf()).map((entry) => entry.kind)).not.toContain("safetyRead");
        });
        expect(rereads).toBe(1);
        await expectRecordKept(run.h, asResult(safetyTimeoutDangerWord));
      },
    );
  });
});

// Round 4 (DL-144; the architect's round 3 FAIL on 159d36b). A: a cut after the danger was noted but before its hold was
// written (during the handle's ids or the core's record) left the text pending with no hold, and the batch's held() kept
// that batch, and every later one, a STOP's included, back for as long as its re-reads said No. Now the hold is written
// from every outcome kept for the text when the danger is noted, before the core is called, and the batch goes on: holds
// bind commits, not hand-offs (CQ-65). B: a waiting text's No made every other waiting text due at once, so two such texts
// read each other back to back; now only a text that no longer waits does that, and never for an open danger, which keeps
// its own 30 s re-read.
describe("a danger cut off before the core answers (round 4)", () => {
  const STOP_TEXT = "STOP";
  const THREAT_TEXT = "if Riley messes up my hair again I'll hurt him";

  /** A core that takes the record and never answers (the cut comes during it); each request is kept in `attempts`. */
  function hangingCore(h: Harness, attempts: RecordSafetyOutcomeRequest[]): SafetyDeps["core"] {
    return {
      recordSafetyOutcome(request) {
        attempts.push(request);
        return new Promise(() => undefined);
      },
      sendFixedLine: (request) => h.core.sendFixedLine(request),
      releaseSafetyHold: (request) => h.core.releaseSafetyHold(request),
    };
  }

  it("a cut during recordSafetyOutcome: the hold written from its outcomes stands, so after the wake the batch goes on while the re-reads say No, a STOP in the next batch reaches its turn and commit with the danger's hold beside it, and the line goes once with its record kept", async () => {
    const danger = { ...asResult(safetyEmergencyNow), eventId: "evt-1" };
    const lease: Lease = { turns: [], contexts: [] };
    const attempts: RecordSafetyOutcomeRequest[] = [];
    await withEviction(
      { "evt-1": danger },
      { lease, before: (h) => ({ ...h.deps, core: hangingCore(h, attempts) }) },
      async (run) => {
        await arrive("evt-1", SMOKE_TEXT);
        // 0 s: the read says An emergency (no danger word). The danger is noted and its hold written from its outcomes
        // before the core is called; the core never answers.
        await vi.waitFor(() => {
          expect(attempts.map((request) => request.caller.requestId)).toEqual(["safety:evt-1"]);
        });
        expect(await actorOf().readHolds()).toEqual([
          { eventId: "evt-1", holdId: null, rule: "after_safe", blocksBooking: true, released: false },
        ]);
        expect(await actorOf().readSafety()).toMatchObject([{ eventId: "evt-1", state: "reading" }]);

        // 1 s: the cut, during the core's call. The re-reads now say No, then An emergency (the 33 s one).
        await run.h.clock.advance(1000);
        const reads: SafetyReadRequest[] = [];
        await run.evict({
          ...run.h.deps,
          read: {
            read(request) {
              reads.push(request);
              const again = reads.filter((each) => each.eventId === "evt-1").length;
              return Promise.resolve(
                verdict(
                  request.eventId === "evt-1" && again >= 2
                    ? danger
                    : { ...asResult(safetyNo), eventId: request.eventId },
                ),
              );
            },
          },
        });

        // 3 s: the stored alarm wakes a new instance. The text is read again (No: the first verdict stands, nothing is
        // sent) and stays scheduled; the batch, closed now, goes to the lease all the same, with the hold open.
        await run.h.clock.advance(2000);
        await run.wake();
        await vi.waitFor(() => {
          expect(lease.turns.map((turn) => turn.eventIds)).toEqual([["evt-1"]]);
        });
        const hold: OpenHold = {
          eventId: "evt-1",
          holdId: null,
          rule: "after_safe",
          outcomes: ["An emergency"],
          blocksBooking: true,
        };
        expect(present(lease.turns[0], "the turn").holds).toEqual([hold]);
        await vi.waitFor(() => {
          expect(reads.map((request) => request.eventId)).toEqual(["evt-1"]);
        });
        expect(await actorOf().readSafety()).toMatchObject([
          { eventId: "evt-1", state: "lineFailed", danger: true },
        ]);
        await vi.waitFor(async () => {
          expect(await scheduleOf()).toContainEqual({ kind: "safetyRead", due_ms: 33_000 });
        });
        expect(await commitOf(present(lease.turns[0], "the turn"))).toMatchObject({ result: "committed" });

        // 5 s: a STOP arrives; its batch closes at 8 s and reaches its own turn, and its commit is handed the danger's
        // hold and no unread text. T-305's hold rule (actions/src/commit/hold.ts isHeld, merged) then commits the STOP (a
        // protective change passes every hold) and holds every routine part (an after-safe hold lets none through); the
        // lease refuses nothing itself.
        await run.h.clock.advance(2000);
        await arrive("evt-2", STOP_TEXT);
        await run.settle();
        await run.h.clock.advance(3000);
        await run.wake();
        await vi.waitFor(() => {
          expect(lease.turns.map((turn) => turn.eventIds)).toEqual([["evt-1"], ["evt-2"]]);
        });
        const stopTurn = present(lease.turns[1], "the STOP's turn");
        expect(stopTurn.holds).toEqual([hold]);
        expect(await commitOf(stopTurn)).toMatchObject({ result: "committed" });
        expect(lease.contexts).toEqual([
          { holds: [hold], unread: [] },
          { holds: [hold], unread: [] },
        ]);
        expect(run.h.core.recorded).toEqual([]);
        expect(run.h.direct.sent).toEqual([]);

        // 33 s: the stored re-read says An emergency: the line goes once, through the core (the same request id as the
        // try the cut lost), whose hold takes the place of the one written before its call; nothing else is sent.
        await run.h.clock.advance(25_000);
        await run.wake();
        await vi.waitFor(() => {
          expect(run.h.core.recorded).toHaveLength(1);
        });
        expect(run.h.core.recorded[0]).toMatchObject({
          at: 33_000,
          request: { caller: { requestId: "safety:evt-1" }, safety: danger },
          response: { safetyLine: { fixedLineId: "safetyEmergency" } },
        });
        await vi.waitFor(async () => {
          expect(await actorOf().readSafety()).toMatchObject([
            { eventId: "evt-1", state: "done", danger: true, path: "outbox", lineId: "safetyEmergency" },
            { eventId: "evt-2", state: "done", danger: false, path: "none" },
          ]);
          expect((await scheduleOf()).map((entry) => entry.kind)).not.toContain("safetyRead");
        });
        expect(await actorOf().readHolds()).toEqual([
          {
            eventId: "evt-1",
            holdId: "hold-evt-1",
            rule: "after_safe",
            blocksBooking: true,
            released: false,
          },
        ]);
        expect(reads.map((request) => request.eventId)).toEqual(["evt-1", "evt-2", "evt-1"]);
        expect(run.h.core.fixed).toEqual([]);
        expect(run.h.direct.sent).toEqual([]);
      },
    );
  });

  it("a re-applied danger's hold takes the strictest rule of every outcome kept, not only the re-read's: a threat cut off before the core answered, then read as An emergency, keeps the threat's never hold with the core's id (the architect's note a)", async () => {
    const threat = { ...asResult(safetyThreat), eventId: "evt-1" };
    const emergency = { ...asResult(safetyEmergencyNow), eventId: "evt-1" };
    const lease: Lease = { turns: [], contexts: [] };
    await withEviction(
      { "evt-1": emergency },
      {
        lease,
        before: (h) => ({
          ...h.deps,
          read: { read: () => Promise.resolve(verdict(threat)) },
          core: hangingCore(h, []),
        }),
      },
      async (run) => {
        await arrive("evt-1", THREAT_TEXT);
        await vi.waitFor(async () => {
          expect(await actorOf().readHolds()).toMatchObject([
            { eventId: "evt-1", holdId: null, rule: "never", released: false },
          ]);
        });
        await run.h.clock.advance(1000);
        await run.evict();

        // 3 s: woken; the re-read says An emergency. The core records it (its hold: after-safe, by that read alone), and
        // the hold kept is the threat's never, with the core's id; the line goes once.
        await run.h.clock.advance(2000);
        await run.wake();
        await vi.waitFor(() => {
          expect(run.h.core.recorded).toHaveLength(1);
        });
        expect(run.h.core.recorded[0]?.response).toMatchObject({
          hold: { holdId: "hold-evt-1", releaseRule: "after_safe" },
        });
        await vi.waitFor(async () => {
          expect(await actorOf().readSafety()).toMatchObject([
            { eventId: "evt-1", state: "done", danger: true, path: "outbox" },
          ]);
        });
        expect(await actorOf().readHolds()).toMatchObject([
          { eventId: "evt-1", holdId: "hold-evt-1", rule: "never", released: false },
        ]);
        expect(await actorOf().markHoldReleased("hold-evt-1")).toBe("neverReleased");

        // The batch went on; its commit is handed the never hold with both outcomes, so only protective changes commit.
        await vi.waitFor(() => {
          expect(lease.turns.map((turn) => turn.eventIds)).toEqual([["evt-1"]]);
        });
        expect(await commitOf(present(lease.turns[0], "the turn"))).toMatchObject({ result: "committed" });
        expect(lease.contexts).toEqual([
          {
            holds: [
              {
                eventId: "evt-1",
                holdId: "hold-evt-1",
                rule: "never",
                outcomes: ["A threat to staff or others", "An emergency"],
                blocksBooking: true,
              },
            ],
            unread: [],
          },
        ]);
      },
    );
  });

  it("an open danger found with no hold on resume (its hold's write failed before the cut) gets it from its kept outcomes then, and its batch goes on", async () => {
    const danger = { ...asResult(safetyEmergencyNow), eventId: "evt-1" };
    await withEviction(
      { "evt-1": danger },
      { before: (h) => ({ ...h.deps, core: hangingCore(h, []) }) },
      async (run) => {
        await arrive("evt-1", SMOKE_TEXT);
        await vi.waitFor(async () => {
          expect(await actorOf().readHolds()).toHaveLength(1);
        });
        // The hold's write is lost (a storage that failed then): the danger is noted, with no hold.
        await runInDurableObject(stub(), (_, state) => {
          state.storage.sql.exec("DELETE FROM safety_holds");
        });
        await run.h.clock.advance(1000);
        // After the cut the re-read never answers, so only the resume can write the hold.
        await run.evict({ ...run.h.deps, read: { read: () => new Promise(() => undefined) } });

        // 3 s: woken; the resume writes the hold from the outcomes kept for the text, and the batch goes on with it.
        await run.h.clock.advance(2000);
        await run.wake();
        await vi.waitFor(() => {
          expect(run.handed.map(idsOf)).toEqual([["evt-1"]]);
        });
        expect(await actorOf().readHolds()).toEqual([
          { eventId: "evt-1", holdId: null, rule: "after_safe", blocksBooking: false, released: false },
        ]);
        expect(await actorOf().readSafety()).toMatchObject([
          { eventId: "evt-1", state: "lineFailed", danger: true },
        ]);
        expect(await actorOf().routineHeld()).toBe(true);
      },
    );
  });

  it("on the late path, an open danger whose hold's write failed (its unread hold still open) gets its hold at the next re-read, though that read says No, so its batch goes on", async () => {
    const danger = { ...asResult(safetyEmergencyNow), eventId: "evt-1" };
    await withEviction(
      { "evt-1": danger },
      {
        before: (h) => ({
          ...h.deps,
          // The read sent on arrival answers An emergency at 6 s, past the deadline; the core takes the record and never
          // answers.
          read: {
            async read() {
              await h.clock.after(6000);
              return verdict(danger);
            },
          },
          core: hangingCore(h, []),
        }),
      },
      async (run) => {
        await arrive("evt-1", SMOKE_TEXT);
        await run.h.clock.advance(4000);
        await vi.waitFor(() => {
          expect(run.h.core.fixed.map((call) => [call.at, call.request.fixedLineId])).toEqual([
            [4000, "outage"],
          ]);
        });
        await run.h.clock.advance(2000);
        await vi.waitFor(async () => {
          expect(await actorOf().readHolds()).toMatchObject([{ eventId: "evt-1", rule: "after_safe" }]);
        });
        // The hold's write is lost (a storage that failed then): the danger is noted, its unread hold still open.
        await runInDurableObject(stub(), (_, state) => {
          state.storage.sql.exec(
            "INSERT OR REPLACE INTO safety_holds (event_id, hold_id, rule, blocks_booking, released) VALUES ('evt-1', NULL, 'unread', 0, 0)",
          );
        });
        await run.h.clock.advance(1000);
        await run.evict({
          ...run.h.deps,
          read: { read: () => Promise.resolve(verdict({ ...asResult(safetyNo), eventId: "evt-1" })) },
        });

        // 34 s: the stored re-read says No. The first verdict stands: nothing is sent, the hold is written from the kept
        // outcomes in place of the unread hold, and the batch goes on with it.
        await run.h.clock.advance(27_000);
        await run.wake();
        await vi.waitFor(() => {
          expect(run.handed.map(idsOf)).toEqual([["evt-1"]]);
        });
        expect(await actorOf().readHolds()).toEqual([
          { eventId: "evt-1", holdId: null, rule: "after_safe", blocksBooking: false, released: false },
        ]);
        expect(run.h.core.fixed).toHaveLength(1);
        expect(run.h.direct.sent).toEqual([]);
        await vi.waitFor(async () => {
          expect(await scheduleOf()).toContainEqual({ kind: "safetyRead", due_ms: 64_000 });
        });
      },
    );
  });

  it("two open dangers whose re-reads answer No are each read once per 30 s: one's No never makes the other due at once (the architect's B)", async () => {
    const h = harness(keys, {});
    const reads: SafetyReadRequest[] = [];
    // Each text's first read says An emergency; every re-read says No. PostgreSQL is down and Linq refuses, so neither
    // line goes and both texts stay open.
    const read: SafetyReadPort = {
      read(request) {
        reads.push(request);
        const first = reads.filter((each) => each.eventId === request.eventId).length === 1;
        return Promise.resolve(
          verdict({
            ...asResult(first ? safetyEmergencyNow : safetyNo),
            eventId: request.eventId,
          }),
        );
      },
    };
    const restoreSafety = setSafetyDeps({ ...h.deps, read });
    const restoreBatch = setBatchHooks({ clock: h.clock, toLease: () => undefined });
    const readsOf = (eventId: string): number => reads.filter((each) => each.eventId === eventId).length;
    try {
      h.core.down = true;
      h.direct.fail = true;
      await arrive("evt-1", SMOKE_TEXT);
      await actorOf().safetyIdle();
      await h.clock.advance(1000);
      await arrive("evt-2", "the dryer in the back room is smoking and the lights went out");
      await actorOf().safetyIdle();
      expect(await actorOf().readSafety()).toMatchObject([
        { eventId: "evt-1", state: "lineFailed", danger: true },
        { eventId: "evt-2", state: "lineFailed", danger: true },
      ]);
      await vi.waitFor(async () => {
        expect(await scheduleOf()).toContainEqual({ kind: "safetyRead", due_ms: 30_000 });
      });

      // Each 30 s window: evt-1 is read at its due time (30 s, 60 s), evt-2 at its own (31 s, 61 s), and the safety entry
      // moves to the next one due. The alarm is run again after each answer: a No must not have made the other text due.
      for (const [at, one, two, next] of [
        [30_000, 2, 1, 31_000],
        [31_000, 2, 2, 60_000],
        [60_000, 3, 2, 61_000],
        [61_000, 3, 3, 90_000],
      ] as const) {
        await h.clock.advance(at - h.clock.now());
        await runDurableObjectAlarm(stub());
        await vi.waitFor(async () => {
          expect([readsOf("evt-1"), readsOf("evt-2")]).toEqual([one, two]);
          expect((await scheduleOf()).filter((entry) => entry.kind === "safetyRead")).toEqual([
            { kind: "safetyRead", due_ms: next },
          ]);
        });
        for (let again = 0; again < 3; again += 1) {
          await runDurableObjectAlarm(stub());
          await actorOf().batchIdle();
        }
        expect([readsOf("evt-1"), readsOf("evt-2")]).toEqual([one, two]);
      }
      expect(h.direct.sent).toEqual([]);
      expect(await actorOf().readHolds()).toMatchObject([
        { eventId: "evt-1", rule: "after_safe", released: false },
        { eventId: "evt-2", rule: "after_safe", released: false },
      ]);
    } finally {
      restoreBatch();
      restoreSafety();
    }
  });
});
