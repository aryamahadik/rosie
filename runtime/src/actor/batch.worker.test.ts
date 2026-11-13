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
import { WHOLE_A } from "../bundle/test-support";
import { fakeKeyStore } from "../gateway/test-support";
import { setDbOutageDeps, type OutageView } from "../outage/db";
import { dbFakes, type DbFakes } from "../outage/db/test-support";
import { fakeRead, harness, TEST_IDS, type Harness } from "../safety/test-support";
import type { SafetyDeps, SafetyResult } from "../safety/types";
import type { ActorCopies } from "./copies/copies";
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
  routineHeld(): Promise<boolean>;
  markHoldReleased(holdId: string): Promise<"released" | "neverReleased" | "noSuchHold">;
  safetyIdle(): Promise<void>;
  batchIdle(): Promise<void>;
  readOutage(): Promise<OutageView>;
  outageIdle(): Promise<void>;
}

function stub(): DurableObjectStub<HandleActor> {
  return namespace().get(namespace().idFromName(ALEX));
}

function actorOf(): BatchRpc {
  return stub();
}

/**
 * The doubles of ../outage/db/test-support.ts as this file's harness (DL-615; the architect's 5(c)): their one `down`
 * switch, the core's, covers the probe and the bundle registry too; the safety read answers `answers` after `delayMs`.
 */
function dbHarness(f: DbFakes, answers: Record<string, SafetyResult>, delayMs: number): Harness {
  const read = fakeRead(f.clock, answers, delayMs);
  const stopped = { value: false };
  const deps: SafetyDeps = { ...f.safetyDeps, read, isStopped: () => stopped.value };
  return { clock: f.clock, core: f.core, direct: f.direct, read, stopped, deps };
}

/**
 * Wires the PostgreSQL-down path as D-017 is to wire it (DL-615): its ports are the doubles', and, since no turn has pinned
 * a bundle here, the actor's keyword copy is bundle A's, installed by its own ActorCopies.refreshKeywords, so the real
 * classify reads each text with the key store the gateway sealed it under. Answers the function that unwires it.
 */
async function wireDownPath(f: DbFakes): Promise<() => void> {
  const restore = setDbOutageDeps(f.outageDeps);
  const copied = await runInDurableObject(stub(), (instance) =>
    (instance as unknown as { copies: ActorCopies }).copies.refreshKeywords(
      WHOLE_A.manifest as unknown as Record<string, unknown>,
    ),
  );
  expect(copied).toBe(true);
  return restore;
}

/** The down path has read each of these texts as another text (no stop word), before any timeout fires (DL-615). */
async function readAsOther(...eventIds: string[]): Promise<void> {
  await actorOf().outageIdle();
  expect((await actorOf().readOutage()).texts).toEqual(
    eventIds.map((eventId) => expect.objectContaining({ eventId, kind: "other" }) as unknown),
  );
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
  options: { restarts?: boolean; delayMs?: number; downPath?: boolean } = {},
): Promise<void> {
  // With `downPath` (DL-615), the doubles are ../outage/db/test-support.ts's and the PostgreSQL-down path is wired as D-017
  // is to wire it, before the first text arrives.
  const db = options.downPath === true ? dbFakes(keys, answers, { start: 0, ids: TEST_IDS }) : null;
  const h =
    db === null
      ? harness(keys, answers, { delayMs: options.delayMs ?? 0 })
      : dbHarness(db, answers, options.delayMs ?? 0);
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
  const restoreDown = db === null ? null : await wireDownPath(db);
  try {
    await body(run);
  } finally {
    restoreDown?.();
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

// Holds bind commits, not hand-offs (QUESTIONS.md CQ-65 as DL-119 replaced it; T-1088): once every text of a batch has been
// read, the batch goes on while its outcome hold stays open, and the turn carries the hold to its commit (lease.ts), so a
// STOP or a protecting change inside a danger or threat text reaches its turn. The first two tests and the two note e
// tests below held the batch for the hold (T-247's rule, which DL-119 replaced); they now show the hold staying open.
describe("a hold from the safety read", () => {
  it("danger closes the batch at once, and the read batch goes on while its hold stays open (DL-119)", async () => {
    await withBatch({ "evt-1": asResult(safetyCrisisWords), ...NO(["evt-2"]) }, async (run) => {
      await arrive("evt-1", "I don't want to be alive anymore");
      await run.settle();
      // Closed at once (before 3 s) and handed on: its text has been read; the hold is open and binds the commit.
      expect(await actorOf().readBatches()).toMatchObject([
        { reason: "danger", handed: true, eventIds: ["evt-1"] },
      ]);
      expect(run.handed.map(idsOf)).toEqual([["evt-1"]]);
      expect(run.handed[0]).toMatchObject({ reason: "danger", closedAt: 0 });
      expect(await actorOf().readHolds()).toMatchObject([
        { eventId: "evt-1", rule: "after_safe", released: false },
      ]);

      await arrive("evt-2");
      await run.tick(3000);
      await run.tick(3000);
      await run.settle();
      expect(await actorOf().readBatches()).toMatchObject([
        { reason: "danger", handed: true, eventIds: ["evt-1"] },
        { reason: "quiet", handed: true, eventIds: ["evt-2"] },
      ]);
      expect(run.handed.map(idsOf)).toEqual([["evt-1"], ["evt-2"]]);
      expect(await actorOf().readHolds()).toMatchObject([{ eventId: "evt-1", released: false }]);

      // The hold lifts (after a clear "we're safe"): the hold changes, and nothing is handed twice. The core's hold id
      // names it (note a).
      expect(await actorOf().markHoldReleased(await holdIdOf("evt-1"))).toBe("released");
      await run.settle();
      expect(await actorOf().readHolds()).toMatchObject([{ eventId: "evt-1", released: true }]);
      expect(run.handed.map(idsOf)).toEqual([["evt-1"], ["evt-2"]]);
    });
  });

  it("a threat's hold never lifts, yet its read batch goes on to its turn (a STOP in it must reach the turn), in order", async () => {
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
      expect(run.handed.map(idsOf)).toEqual([["evt-1"], ["evt-2"]]);
      expect(await actorOf().readBatches()).toMatchObject([
        { reason: "danger", handed: true },
        { reason: "quiet", handed: true },
      ]);
      expect(await actorOf().readHolds()).toMatchObject([
        { eventId: "evt-1", rule: "never", released: false },
      ]);
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

  it("a text with no verdict in 4 s keeps its batch back (its unread hold) until a late verdict lifts it; then the batch goes on", async () => {
    await withBatch(
      NO(["evt-1"]),
      async (run) => {
        await arrive("evt-1");
        await run.tick(3000);
        await run.tick(1000);
        await run.settle();
        // 4 s: no verdict, the outage line, and the unread hold: the text is not read yet, so its batch waits.
        expect(await actorOf().readHolds()).toMatchObject([{ rule: "unread", released: false }]);
        expect(await actorOf().readBatches()).toMatchObject([{ reason: "quiet", handed: false }]);
        expect(run.handed).toHaveLength(0);

        // 6 s: the late verdict says No; the hold lifts, and the settle path hands the batch on (nothing polled for it).
        await run.h.clock.advance(2000);
        await vi.waitFor(() => {
          expect(run.handed.map(idsOf)).toEqual([["evt-1"]]);
        });
        expect(await actorOf().readHolds()).toMatchObject([{ rule: "unread", released: true }]);
      },
      "wired",
      { delayMs: 6000 },
    );
  });

  it("a batch waits only for its own texts' reads: a read batch goes on while a later text is still read; a held batch keeps later ones behind it", async () => {
    // evt-1 to evt-3 and evt-5 are read as No 1 s after they arrive; evt-4 has no answer, so it is never read.
    await withBatch(
      NO(["evt-1", "evt-2", "evt-3", "evt-5"]),
      async (run) => {
        await arrive("evt-1");
        await arrive("evt-2");
        await arrive("evt-3");
        await arrive("evt-4");
        expect(await actorOf().readBatches()).toMatchObject([
          { batchId: 1, reason: "third", handed: false, eventIds: ["evt-1", "evt-2", "evt-3"] },
          { batchId: 0, reason: null, eventIds: ["evt-4"] },
        ]);

        // 1 s: the first batch's texts are read. evt-4 is still being read, and keeps only its own batch back.
        await run.h.clock.advance(1000);
        await vi.waitFor(() => {
          expect(run.handed.map(idsOf)).toEqual([["evt-1", "evt-2", "evt-3"]]);
        });

        // 3 s: evt-4's batch closes, held while it is read; 4 s: no verdict, so its unread hold keeps it back.
        await run.tick(2000);
        await run.tick(1000);
        await arrive("evt-5");
        await run.tick(3000);
        await run.settle();
        expect(await actorOf().readBatches()).toMatchObject([
          { batchId: 1, handed: true },
          { batchId: 2, reason: "quiet", handed: false, eventIds: ["evt-4"] },
          { batchId: 3, reason: "quiet", handed: false, eventIds: ["evt-5"] },
        ]);
        expect(run.handed).toHaveLength(1);
      },
      "wired",
      { delayMs: 1000 },
    );
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

  it("T-248 security note d: the routineHeld() RPC counts a waiting text with no safety row as held, as the batch does", async () => {
    await withBatch(NO(["evt-1", "evt-2"]), async (run) => {
      // As above: evt-1 is stored and batched, but its read never started, so it has no safety row.
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
      try {
        await expect(
          door().accept(await handoffOf("evt-1", "Can I get a haircut on Thursday afternoon?")),
        ).rejects.toThrow();
      } finally {
        restore();
      }
      await arrive("evt-2");
      await run.settle();
      // evt-2 was read (No), and no hold is open: only evt-1, with no safety row, holds routine work.
      expect(await actorOf().readSafety()).toMatchObject([{ eventId: "evt-2", state: "done" }]);
      expect(await actorOf().readHolds()).toEqual([]);
      expect(await actorOf().routineHeld()).toBe(true);
    });
  });

  it("note e: a late danger verdict after a no-match timeout closes the open batch at once, as an on-time one does", async () => {
    const late = { ...asResult(safetyEmergencyNow), eventId: "evt-1" };
    // The outage line is a step on the way here (DL-615, the architect's 5(b)): the down path runs wired, as D-017 is to
    // wire it, and has read both texts as other texts.
    await withBatch(
      { "evt-1": late, ...NO(["evt-2"]) },
      async (run) => {
        // Every read answers 5 s after its text: past the 4 s deadline. (Nothing here waits for the reads to settle: the
        // fake clock never reaches evt-2's.)
        await arrive("evt-1");
        await readAsOther("evt-1");
        await run.tick(2900);
        await arrive("evt-2");
        await readAsOther("evt-1", "evt-2");
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
      { delayMs: 5000, downPath: true },
    );
  });

  it("note e: one threat text sets no alarm that fires every second; its batch is handed on once, with the hold open", async () => {
    await withBatch({ "evt-1": asResult(safetyThreat) }, async (run) => {
      await arrive("evt-1", "if Riley messes up my hair again I'll hurt him");
      await run.settle();
      expect(await actorOf().readBatches()).toMatchObject([{ reason: "danger", handed: true }]);
      expect(await scheduleOf()).toEqual([]);
      expect(await alarmOf()).toBeNull();

      await run.h.clock.advance(5000);
      expect(await runDurableObjectAlarm(stub())).toBe(false);
      expect(run.handed.map(idsOf)).toEqual([["evt-1"]]);
      expect(await actorOf().readHolds()).toMatchObject([{ rule: "never", released: false }]);
    });
  });

  it("note e: an outcome hold keeps no batch back and nothing polls; its release hands nothing again", async () => {
    await withBatch({ "evt-1": asResult(safetyCrisisWords) }, async (run) => {
      await arrive("evt-1", "I don't want to be alive anymore");
      await run.settle();
      expect(await actorOf().readBatches()).toMatchObject([{ reason: "danger", handed: true }]);
      expect(run.handed.map(idsOf)).toEqual([["evt-1"]]);
      expect(await scheduleOf()).toEqual([]);
      expect(await alarmOf()).toBeNull();

      expect(await actorOf().markHoldReleased(await holdIdOf("evt-1"))).toBe("released");
      await run.settle();
      expect(run.handed.map(idsOf)).toEqual([["evt-1"]]);
      expect(await scheduleOf()).toEqual([]);
      expect(await alarmOf()).toBeNull();
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
