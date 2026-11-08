// The batch window, run inside the Workers runtime (T-247). The actor is the real Durable Object reached through the
// gateway's door; the safety read, shared core, Linq send and the clock are the doubles of src/safety/test-support.ts, and
// the same fake clock is the batch's clock. The alarm is fired with `runDurableObjectAlarm` (it runs `alarm()` whatever
// its real time), so "not yet due" is tested through the stored schedule against the fake clock. Test method: T-1128's.
// Test values only (rule 9).
import { evictDurableObject, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import textImessage from "../../../contracts/inbound-event/fixtures/text-imessage.json";
import safetyCrisisWords from "../../../contracts/model/fixtures/safety-crisis-words.json";
import safetyEmergencyNow from "../../../contracts/model/fixtures/safety-emergency-now.json";
import safetyNo from "../../../contracts/model/fixtures/safety-no.json";
import safetyThreat from "../../../contracts/model/fixtures/safety-threat.json";
import {
  durableObjectActor,
  prepareHandoff,
  type ActorNamespace,
  type HandleActorRpc,
  type InboundEvent,
  type SealedHandoff,
} from "../gateway";
import { fakeKeyStore } from "../gateway/test-support";
import { harness, type Harness } from "../safety/test-support";
import type { SafetyResult } from "../safety/types";
import {
  setBatchHooks,
  setSafetyDeps,
  type BatchEntry,
  type ClosedBatch,
  type HandleActor,
  type HoldEntry,
  type SafetyEntry,
} from "./index";

type Json = Record<string, unknown>;

const BUNDLE = { hash: "a".repeat(64), build: 1 };
const TRACE = "11111111-2222-4333-8444-555555555555";
const ALEX = "phone:+15555550101";
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

interface BatchRpc {
  readBatches(): Promise<BatchEntry[]>;
  readHolds(): Promise<HoldEntry[]>;
  readSafety(): Promise<SafetyEntry[]>;
  markHoldReleased(holdId: string): Promise<"released" | "neverReleased" | "noSuchHold">;
  safetyIdle(): Promise<void>;
  batchIdle(): Promise<void>;
}

function stub(): DurableObjectStub<HandleActor> {
  return namespace().get(namespace().idFromName(ALEX));
}

function actorOf(): BatchRpc {
  return stub();
}

async function handoffOf(eventId: string, body: string): Promise<SealedHandoff> {
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
  return prepared.handoff;
}

async function arrive(eventId: string, body = "Can I get a haircut on Thursday afternoon?"): Promise<void> {
  expect(await door().accept(await handoffOf(eventId, body))).toBe("written");
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
  handed: ClosedBatch[];
  /** How many times the lease was handed a batch, refused or not. */
  calls(): number;
  /**
   * Makes the actor crash the next time a hand-off reaches the lease, in "refusesThenCrashes": the hand-off's writes so far
   * are persisted first (a real hand-off does I/O before it could crash: the lease hashes and sets the alarm), then the
   * actor's state is reset.
   */
  armCrash(): Promise<void>;
  /** The fake clock moves, then the alarm runs, as the platform would at the stored time. */
  tick(ms: number): Promise<void>;
  /** Settles the safety work and the batch work of what has arrived. */
  settle(): Promise<void>;
}

async function withBatch(
  answers: Record<string, SafetyResult>,
  body: (run: Run) => Promise<void>,
  lease: "wired" | "unwired" | "failsOnce" | "refusesThenCrashes" = "wired",
  options: { restarts?: boolean; delayMs?: number } = {},
): Promise<void> {
  const h = harness(keys, answers, { delayMs: options.delayMs ?? 0 });
  const handed: ClosedBatch[] = [];
  let failed = false;
  let calls = 0;
  let crash: (() => Promise<void>) | null = null;
  // A fake-clock timer that is still waiting keeps `evictDurableObject` from finishing. A test that restarts the actor
  // gives the safety read's 4 s deadline a promise with no timer: every read in it answers at once, so it never fires.
  const deps = options.restarts
    ? { ...h.deps, clock: { now: () => h.clock.now(), after: () => new Promise<void>(() => undefined) } }
    : h.deps;
  const restoreSafety = setSafetyDeps(deps);
  const restoreBatch = setBatchHooks({
    clock: h.clock,
    ...(lease === "unwired"
      ? {}
      : {
          toLease: (batch: ClosedBatch) => {
            calls += 1;
            if ((lease === "failsOnce" || lease === "refusesThenCrashes") && !failed) {
              failed = true;
              throw new Error("lease refused");
            }
            const crashNow = crash;
            if (crashNow !== null) {
              crash = null;
              // The actor dies in the middle of the hand-off: the hand-off never answers.
              return crashNow();
            }
            handed.push(batch);
            return undefined;
          },
        }),
  });
  const run: Run = {
    h,
    handed,
    calls: () => calls,
    async armCrash() {
      await runInDurableObject(stub(), (_, state) => {
        crash = async () => {
          await state.storage.sync();
          state.abort("a crash in the hand-off");
          await new Promise<void>(() => undefined);
        };
      });
    },
    async tick(ms) {
      await h.clock.advance(ms);
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
    restoreBatch();
    restoreSafety();
  }
}

const NO = (ids: string[]): Record<string, SafetyResult> =>
  Object.fromEntries(ids.map((id) => [id, asResult(safetyNo)]));

const idsOf = (batch: ClosedBatch): string[] => batch.entries.map((entry) => entry.event.eventId);

/** The id the shared core gave the hold of this text, as the actor recorded it (what K-09 releaseSafetyHold names). */
async function holdIdOf(eventId: string): Promise<string> {
  const hold = (await actorOf().readHolds()).find((entry) => entry.eventId === eventId);
  if (hold?.holdId === undefined || hold.holdId === null) throw new Error("no recorded hold");
  return hold.holdId;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("the batch window", () => {
  it("one text closes the batch 3 s after it, not before", async () => {
    await withBatch(NO(["evt-1"]), async (run) => {
      await arrive("evt-1");
      await run.settle();
      await run.tick(2999);
      expect(run.handed).toHaveLength(0);
      expect(await actorOf().readBatches()).toEqual([
        { batchId: 0, reason: null, handed: false, eventIds: ["evt-1"] },
      ]);

      await run.tick(1);
      await run.settle();
      expect(run.handed).toHaveLength(1);
      expect(run.handed.map(idsOf)[0]).toEqual(["evt-1"]);
      expect(run.handed[0]).toMatchObject({ reason: "quiet", firstAt: 0, lastAt: 0, closedAt: 3000 });
    });
  });

  it("a later text pushes the close to 3 s after it", async () => {
    await withBatch(NO(["evt-1", "evt-2"]), async (run) => {
      await arrive("evt-1");
      await run.tick(2000);
      await arrive("evt-2");
      await run.tick(2999);
      expect(run.handed).toHaveLength(0);
      await run.tick(1);
      await run.settle();
      expect(run.handed).toHaveLength(1);
      expect(run.handed.map(idsOf)[0]).toEqual(["evt-1", "evt-2"]);
      expect(run.handed[0]).toMatchObject({ reason: "quiet", closedAt: 5000 });
    });
  });

  // The 6 s cap is in the code (`deadlineOf`) but arrival cannot reach it: two texts are at most 3 s apart (else the first
  // batch has closed) and the third text closes the batch. QUESTIONS.md: the card's "0, 2 and 4 s close at 6 s".
  it("two texts 2.9 s apart close 3 s after the second, inside the 6 s cap", async () => {
    await withBatch(NO(["evt-1", "evt-2"]), async (run) => {
      await arrive("evt-1");
      await run.tick(2900);
      await arrive("evt-2");
      await run.tick(2999);
      expect(run.handed).toHaveLength(0);
      await run.tick(1);
      await run.settle();
      expect(run.handed.map(idsOf)[0]).toEqual(["evt-1", "evt-2"]);
      expect(run.handed[0]).toMatchObject({ reason: "quiet", closedAt: 5900 });
    });
  });

  it("texts at 0, 2 and 4 s: the third closes the batch at 4 s, which is before 6 s", async () => {
    await withBatch(NO(["evt-1", "evt-2", "evt-3", "evt-4"]), async (run) => {
      await arrive("evt-1");
      await run.tick(2000);
      await arrive("evt-2");
      await run.tick(2000);
      await arrive("evt-3");
      await run.settle();
      expect(run.handed).toHaveLength(1);
      expect(run.handed[0]).toMatchObject({ reason: "third", closedAt: 4000 });
      expect(run.handed.map(idsOf)[0]).toEqual(["evt-1", "evt-2", "evt-3"]);

      // A fourth text opens the next batch, with its own window.
      await arrive("evt-4");
      await run.tick(3000);
      await run.settle();
      expect(run.handed.map(idsOf)).toEqual([["evt-1", "evt-2", "evt-3"], ["evt-4"]]);
      expect(run.handed[1]?.batchId).toBeGreaterThan(run.handed[0]?.batchId ?? 0);
    });
  });

  it("a third text closes the batch at once", async () => {
    await withBatch(NO(["evt-1", "evt-2", "evt-3"]), async (run) => {
      await arrive("evt-1");
      await arrive("evt-2");
      await arrive("evt-3");
      await run.settle();
      expect(run.handed).toHaveLength(1);
      expect(run.handed[0]).toMatchObject({ reason: "third", closedAt: 0 });
      expect(run.handed.map(idsOf)[0]).toEqual(["evt-1", "evt-2", "evt-3"]);
    });
  });

  it("a close that is run twice hands the batch once", async () => {
    await withBatch(NO(["evt-1"]), async (run) => {
      await arrive("evt-1");
      await run.tick(3000);
      await run.settle();
      await run.tick(1000);
      await run.settle();
      expect(run.handed).toHaveLength(1);
      expect((await actorOf().readBatches()).map((entry) => entry.handed)).toEqual([true]);
    });
  });
});

describe("a hold from the safety read", () => {
  it("danger closes the batch at once, and no text is handed on until the hold lifts", async () => {
    await withBatch({ "evt-1": asResult(safetyCrisisWords), ...NO(["evt-2"]) }, async (run) => {
      await arrive("evt-1", "I don't want to be alive anymore");
      await run.settle();
      // Closed at once (before 3 s), but held.
      expect(await actorOf().readBatches()).toMatchObject([
        { reason: "danger", handed: false, eventIds: ["evt-1"] },
      ]);

      await arrive("evt-2");
      await run.tick(3000);
      await run.tick(3000);
      await run.settle();
      expect(await actorOf().readBatches()).toMatchObject([
        { reason: "danger", handed: false, eventIds: ["evt-1"] },
        { reason: "quiet", handed: false, eventIds: ["evt-2"] },
      ]);
      expect(run.handed).toHaveLength(0);

      // The hold lifts (after a clear "we're safe"): both go on, in order. The core's hold id names it (note a).
      expect(await actorOf().markHoldReleased(await holdIdOf("evt-1"))).toBe("released");
      await run.settle();
      expect(run.handed.map(idsOf)).toEqual([["evt-1"], ["evt-2"]]);
    });
  });

  it("a threat's hold never lifts, so nothing is handed on", async () => {
    await withBatch({ "evt-1": asResult(safetyThreat), ...NO(["evt-2"]) }, async (run) => {
      await arrive("evt-1", "if Riley messes up my hair again I'll hurt him");
      await run.settle();
      await arrive("evt-2");
      await run.tick(3000);
      await run.tick(3000);
      await run.settle();
      expect(await actorOf().markHoldReleased(await holdIdOf("evt-1"))).toBe("neverReleased");
      await run.tick(3000);
      await run.settle();
      expect(run.handed).toHaveLength(0);
      expect(await actorOf().readBatches()).toMatchObject([{ handed: false }, { handed: false }]);
    });
  });

  it("a text still being read keeps its closed batch back until the read ends", async () => {
    // evt-1 has no answer: the read never ends, and at 4 s the outage line is sent and routine work stays held.
    await withBatch({}, async (run) => {
      await arrive("evt-1");
      await run.tick(3000);
      await run.tick(1000);
      await run.tick(3000);
      await run.settle();
      expect(run.handed).toHaveLength(0);
      expect(await actorOf().readBatches()).toMatchObject([{ reason: "quiet", handed: false }]);
    });
  });
});

describe("the lease seam and restarts", () => {
  it("an actor restart inside the window still closes the batch from stored state", async () => {
    await withBatch(
      NO(["evt-1", "evt-2"]),
      async (run) => {
        await arrive("evt-1");
        await run.tick(1000);
        await arrive("evt-2");
        await run.settle();

        await evictDurableObject(stub());
        expect(await actorOf().readBatches()).toMatchObject([{ reason: null, eventIds: ["evt-1", "evt-2"] }]);

        await run.tick(2999);
        expect(run.handed).toHaveLength(0);
        await run.tick(1);
        await run.settle();
        expect(run.handed).toHaveLength(1);
        expect(run.handed.map(idsOf)[0]).toEqual(["evt-1", "evt-2"]);
        expect(run.handed[0]).toMatchObject({ reason: "quiet", closedAt: 4000 });
      },
      "wired",
      { restarts: true },
    );
  });

  it("a restart after the close, before the hand-off, still hands the batch on", async () => {
    await withBatch(
      NO(["evt-1"]),
      async (run) => {
        await arrive("evt-1");
        await run.settle();
        await evictDurableObject(stub());
        await run.tick(3000);
        await run.settle();
        await evictDurableObject(stub());
        await run.tick(1000);
        await run.settle();
        expect(run.handed).toHaveLength(1);
      },
      "wired",
      { restarts: true },
    );
  });

  it("with no lease wired, the closed batch stays stored and is not marked handed", async () => {
    await withBatch(
      NO(["evt-1"]),
      async (run) => {
        await arrive("evt-1");
        await run.tick(3000);
        await run.settle();
        expect(await actorOf().readBatches()).toMatchObject([{ reason: "quiet", handed: false }]);
      },
      "unwired",
    );
  });

  it("a lease that refuses is tried again with the same batch", async () => {
    await withBatch(
      NO(["evt-1"]),
      async (run) => {
        await arrive("evt-1");
        await run.tick(3000);
        await run.settle();
        expect(run.handed).toHaveLength(0);
        await run.tick(1000);
        await run.settle();
        expect(run.handed).toHaveLength(1);
        expect(run.handed[0]?.batchId).toBe(1);
      },
      "failsOnce",
    );
  });

  it("writes no word of a text into the logs", async () => {
    const spy = vi.spyOn(console, "log");
    await withBatch(NO(["evt-1"]), async (run) => {
      await arrive("evt-1", "SECRETWORD about my haircut");
      await run.tick(3000);
      await run.settle();
    });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("SECRETWORD");
  });
});

describe("T-247's security notes, before the lease is wired (DL-110)", () => {
  it("note c: a crash in the middle of a hand-off leaves the release entry, so the restarted actor hands the batch again", async () => {
    await withBatch(
      NO(["evt-1"]),
      async (run) => {
        await arrive("evt-1");
        await run.settle();
        // Closed at 3 s; the lease refuses it, so it is handed again 1 s later, from a release entry already due.
        await run.tick(3000);
        await run.settle();
        expect(run.calls()).toBe(1);
        expect(await scheduleOf()).toContainEqual({ kind: "batchRelease", due_ms: 4000 });

        // That second hand-off is cut off: the actor crashes while the lease has the batch.
        await run.armCrash();
        await run.h.clock.advance(1000);
        const crashed = await runDurableObjectAlarm(stub()).then(
          () => "finished",
          () => "crashed",
        );
        expect(crashed).toBe("crashed");
        expect(run.calls()).toBe(2);
        expect(run.handed).toHaveLength(0);

        // The restarted actor finds the entry and sets its alarm from it; the alarm (no new text) hands the same batch.
        expect(await actorOf().readBatches()).toMatchObject([{ batchId: 1, handed: false }]);
        expect(await scheduleOf()).toContainEqual(expect.objectContaining({ kind: "batchRelease" }));
        expect(await alarmOf()).not.toBeNull();
        await run.h.clock.advance(1000);
        // Fires the alarm now (the platform may already have fired it at its real time).
        await runDurableObjectAlarm(stub());
        await vi.waitFor(() => {
          expect(run.handed.map((batch) => batch.batchId)).toEqual([1]);
        });
        expect(await actorOf().readBatches()).toMatchObject([{ batchId: 1, handed: true }]);
      },
      "refusesThenCrashes",
      { restarts: true },
    );
  });

  it("note d: a batched text whose safety read never started counts as held", async () => {
    await withBatch(NO(["evt-1", "evt-2"]), async (run) => {
      // The read's start fails once the text is stored (the safety clock throws), so the text is in the batch window
      // with no safety row; the gateway's retry is a duplicate and starts nothing.
      let broken = true;
      const restore = setSafetyDeps({
        ...run.h.deps,
        clock: {
          now: () => {
            if (broken) {
              broken = false;
              throw new Error("the clock broke");
            }
            return run.h.clock.now();
          },
          after: (ms) => run.h.clock.after(ms),
        },
      });
      const first = await handoffOf("evt-1", "Can I get a haircut on Thursday afternoon?");
      try {
        await expect(door().accept(first)).rejects.toThrow();
        expect(await door().accept(first)).toBe("duplicate");
      } finally {
        restore();
      }
      await arrive("evt-2");
      await run.settle();
      expect((await actorOf().readSafety()).map((entry) => entry.eventId)).toEqual(["evt-2"]);

      await run.tick(3000);
      await run.settle();
      expect(await actorOf().readBatches()).toMatchObject([
        { batchId: 1, reason: "quiet", handed: false, eventIds: ["evt-1", "evt-2"] },
      ]);
      expect(run.handed).toHaveLength(0);
    });
  });

  it("note e: a late danger verdict after a no-match timeout closes the open batch at once, as an on-time one does", async () => {
    const late = { ...asResult(safetyEmergencyNow), eventId: "evt-1" };
    await withBatch(
      { "evt-1": late, ...NO(["evt-2"]) },
      async (run) => {
        // Every read answers 5 s after its text: past the 4 s deadline. (Nothing here waits for the reads to settle: the
        // fake clock never reaches evt-2's.)
        await arrive("evt-1");
        await run.tick(2900);
        await arrive("evt-2");
        // 4 s: evt-1 has no verdict and no danger word, so the outage line goes and its batch stays open (it would close
        // at 5.9 s, 3 s after evt-2).
        await run.tick(1100);
        await vi.waitFor(() => {
          expect(run.h.core.fixed.map((call) => call.request.caller.requestId)).toEqual(["safety:evt-1"]);
        });
        expect(await actorOf().readBatches()).toEqual([
          { batchId: 0, reason: null, handed: false, eventIds: ["evt-1", "evt-2"] },
        ]);

        // 5 s: the late verdict finds danger, and the open batch closes then.
        await run.h.clock.advance(1000);
        await vi.waitFor(async () => {
          expect(await actorOf().readBatches()).toMatchObject([
            { batchId: 1, reason: "danger", eventIds: ["evt-1", "evt-2"] },
          ]);
        });
        expect(run.h.core.recorded.map((call) => call.request.safety.eventId)).toEqual(["evt-1"]);
        expect(run.handed).toHaveLength(0);
      },
      "wired",
      { delayMs: 5000 },
    );
  });

  it("note e: one threat text sets no alarm that fires every second; nothing is handed on", async () => {
    await withBatch({ "evt-1": asResult(safetyThreat) }, async (run) => {
      await arrive("evt-1", "if Riley messes up my hair again I'll hurt him");
      await run.settle();
      expect(await actorOf().readBatches()).toMatchObject([{ reason: "danger", handed: false }]);
      expect(await scheduleOf()).toEqual([]);
      expect(await alarmOf()).toBeNull();

      await run.h.clock.advance(5000);
      expect(await runDurableObjectAlarm(stub())).toBe(false);
      expect(run.handed).toHaveLength(0);
    });
  });

  it("note e: a held batch polls nothing until its hold is released, and the release hands it on", async () => {
    await withBatch({ "evt-1": asResult(safetyCrisisWords) }, async (run) => {
      await arrive("evt-1", "I don't want to be alive anymore");
      await run.settle();
      expect(await actorOf().readBatches()).toMatchObject([{ reason: "danger", handed: false }]);
      expect(await scheduleOf()).toEqual([]);
      expect(await alarmOf()).toBeNull();

      expect(await actorOf().markHoldReleased(await holdIdOf("evt-1"))).toBe("released");
      await run.settle();
      expect(run.handed.map(idsOf)).toEqual([["evt-1"]]);
      expect(await scheduleOf()).toEqual([]);
    });
  });

  it("note e: with no safety read wired, a text is held and nothing polls", async () => {
    await withBatch({}, async (run) => {
      const restore = setSafetyDeps(null);
      try {
        await arrive("evt-1");
        await run.tick(3000);
        await run.settle();
        expect(await actorOf().readBatches()).toMatchObject([{ reason: "quiet", handed: false }]);
        expect(await scheduleOf()).toEqual([]);
        expect(await alarmOf()).toBeNull();
        expect(run.handed).toHaveLength(0);
      } finally {
        restore();
      }
    });
  });
});
