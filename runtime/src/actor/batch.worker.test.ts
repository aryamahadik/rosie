// The batch window, run inside the Workers runtime (T-247). The actor is the real Durable Object reached through the
// gateway's door; the safety read, shared core, Linq send and the clock are the doubles of src/safety/test-support.ts, and
// the same fake clock is the batch's clock. The alarm is fired with `runDurableObjectAlarm` (it runs `alarm()` whatever
// its real time), so "not yet due" is tested through the stored schedule against the fake clock. Test method: T-1128's.
// Test values only (rule 9).
import { evictDurableObject, reset, runDurableObjectAlarm } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import textImessage from "../../../contracts/inbound-event/fixtures/text-imessage.json";
import safetyCrisisWords from "../../../contracts/model/fixtures/safety-crisis-words.json";
import safetyNo from "../../../contracts/model/fixtures/safety-no.json";
import safetyThreat from "../../../contracts/model/fixtures/safety-threat.json";
import {
  durableObjectActor,
  prepareHandoff,
  type ActorNamespace,
  type HandleActorRpc,
  type InboundEvent,
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
  markHoldReleased(eventId: string): Promise<"released" | "neverReleased" | "noSuchHold">;
  safetyIdle(): Promise<void>;
  batchIdle(): Promise<void>;
}

function stub(): DurableObjectStub<HandleActor> {
  return namespace().get(namespace().idFromName(ALEX));
}

function actorOf(): BatchRpc {
  return stub();
}

async function arrive(eventId: string, body = "Can I get a haircut on Thursday afternoon?"): Promise<void> {
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

const asResult = (fixture: unknown): SafetyResult => fixture as SafetyResult;

interface Run {
  h: Harness;
  handed: ClosedBatch[];
  /** The fake clock moves, then the alarm runs, as the platform would at the stored time. */
  tick(ms: number): Promise<void>;
  /** Settles the safety work and the batch work of what has arrived. */
  settle(): Promise<void>;
}

async function withBatch(
  answers: Record<string, SafetyResult>,
  body: (run: Run) => Promise<void>,
  lease: "wired" | "unwired" | "failsOnce" = "wired",
  options: { restarts?: boolean } = {},
): Promise<void> {
  const h = harness(keys, answers);
  const handed: ClosedBatch[] = [];
  let failed = false;
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
            if (lease === "failsOnce" && !failed) {
              failed = true;
              throw new Error("lease refused");
            }
            handed.push(batch);
          },
        }),
  });
  const run: Run = {
    h,
    handed,
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

      // The hold lifts (after a clear "we're safe"): both go on, in order.
      expect(await actorOf().markHoldReleased("evt-1")).toBe("released");
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
      expect(await actorOf().markHoldReleased("evt-1")).toBe("neverReleased");
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
