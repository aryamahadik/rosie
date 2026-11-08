// A safety read cut off by the actor's eviction, run inside the Workers runtime (T-1088). The actor is the real Durable
// Object reached through the gateway's door; the safety read, shared core, Linq send and clock are the doubles of
// src/safety/test-support.ts, and the same fake clock runs the actor's stored schedule. Each test cuts the actor off in
// the middle of a read and wakes a new instance on the same id: a deploy or a reset does this in production, and the 4 s
// deadline lived only in memory. The cut is the instance's reset (`ctx.abort`, after its storage is synced, as T-248's
// crash test does): `evictDurableObject` waits for the work in flight to drain, and a cut-off read's work never ends.
// The new instance is woken by its stored alarm (`runDurableObjectAlarm`) or by a new text. Before the cut the read
// never answers and its deadline has no timer; after it, the doubles answer on the fake clock. Test method: T-1128's.
// Test values only (rule 9).
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import textImessage from "../../../contracts/inbound-event/fixtures/text-imessage.json";
import safetyEmergencyNow from "../../../contracts/model/fixtures/safety-emergency-now.json";
import safetyNo from "../../../contracts/model/fixtures/safety-no.json";
import safetyTimeoutDangerWord from "../../../contracts/model/fixtures/safety-timeout-danger-word.json";
import {
  durableObjectActor,
  prepareHandoff,
  type ActorNamespace,
  type HandleActorRpc,
  type InboundEvent,
} from "../gateway";
import { fakeKeyStore } from "../gateway/test-support";
import {
  setBatchHooks,
  setSafetyDeps,
  type BatchEntry,
  type ClosedBatch,
  type HandleActor,
  type HoldEntry,
  type SafetyEntry,
} from "../actor";
import { harness, type Harness } from "./test-support";
import type { SafetyReadRequest, SafetyResult } from "./types";

type Json = Record<string, unknown>;

const BUNDLE = { hash: "a".repeat(64), build: 1 };
const TRACE = "11111111-2222-4333-8444-555555555555";
const ALEX = "phone:+15555550101";
const keys = fakeKeyStore();

const EMERGENCY_TEXT = "my lips are swelling after the beard color and I can't breathe well";
const BLEEDING_TEXT = "Riley's cut won't stop bleeding, please help";
const PLAIN_TEXT = "Can I get a haircut on Thursday afternoon?";

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

interface Run {
  h: Harness;
  /** The reads the actor sent before the eviction (that read never answered). */
  cutOff: SafetyReadRequest[];
  /** Every batch handed to the lease, in order. */
  handed: ClosedBatch[];
  /** Cuts the actor off in the middle of its read (a new instance follows), then puts the doubles that answer in place. */
  evict(): Promise<void>;
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
 * 4 s deadline has no timer; after it, the read answers `answers` after `delayMs` and the deadline runs on the fake clock.
 */
async function withEviction(
  answers: Record<string, SafetyResult>,
  options: { delayMs?: number },
  body: (run: Run) => Promise<void>,
): Promise<void> {
  const h = harness(keys, answers, { delayMs: options.delayMs ?? 0 });
  const cutOff: SafetyReadRequest[] = [];
  const handed: ClosedBatch[] = [];
  const restoreSafety = setSafetyDeps({
    ...h.deps,
    read: {
      read(request) {
        cutOff.push(request);
        return new Promise(() => undefined);
      },
    },
    clock: { now: () => h.clock.now(), after: () => new Promise<void>(() => undefined) },
  });
  const restoreBatch = setBatchHooks({
    clock: h.clock,
    toLease: (batch) => {
      handed.push(batch);
    },
  });
  let restoreAnswering = (): void => undefined;
  const run: Run = {
    h,
    cutOff,
    handed,
    async evict() {
      // What outlives the cut: the safety entry stored when the read was queued, and the alarm set for the schedule.
      expect((await scheduleOf()).map((entry) => entry.kind)).toContain("safetyRead");
      expect(await alarmOf()).not.toBeNull();
      // The instance's memory goes (the read in flight, its 4 s deadline); its storage and its alarm stay.
      const cut = await runInDurableObject(stub(), async (_, state) => {
        await state.storage.sync();
        state.abort("cut off mid-read");
      }).then(
        () => "still running",
        () => "cut off",
      );
      expect(cut).toBe("cut off");
      restoreAnswering = setSafetyDeps(h.deps);
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
    restoreAnswering();
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

  it("firing past the deadline while the read's work still runs sends no second read and comes back in 1 s, never in a loop", async () => {
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

      await h.clock.advance(1000);
      await runDurableObjectAlarm(stub());
      expect(await scheduleOf()).toContainEqual({ kind: "safetyRead", due_ms: 6000 });
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

  it("a cut-off read that cannot start again is left unresolved and held, the actor still starts, and nothing polls for it", async () => {
    await withEviction({}, {}, async (run) => {
      await arrive("evt-1", PLAIN_TEXT);
      await run.h.clock.advance(1000);
      await run.evict();
      const restore = setSafetyDeps({
        ...run.h.deps,
        keys: {
          getOrCreateKey: () => {
            throw new Error("the key store broke");
          },
        },
      });
      try {
        await run.h.clock.advance(2000);
        await run.wake();
        await actorOf().batchIdle();
        await vi.waitFor(async () => {
          expect(await actorOf().readBatches()).toMatchObject([{ reason: "quiet", handed: false }]);
          expect(await scheduleOf()).toEqual([]);
          expect(await alarmOf()).toBeNull();
        });
        expect(await actorOf().readSafety()).toMatchObject([
          { eventId: "evt-1", state: "lineFailed", danger: false },
        ]);
        expect(await actorOf().routineHeld()).toBe(true);
        expect(run.h.read.requests).toEqual([]);
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
