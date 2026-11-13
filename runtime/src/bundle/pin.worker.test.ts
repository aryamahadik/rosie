// The bundle pin at turn start, run inside the Workers runtime (T-249). The actor is the real Durable Object reached
// through the gateway's door; each text goes through the real safety read on arrival (its double answers safety-no.json),
// the real batch window and the real turn lease, which pins the turn's bundle when it starts a run. Doubles: K-05 v1's
// bundle reads and the KV namespace (./test-support.ts: active-bundle.json's bundle v0 as bundle A, bundle-mini-a.json as
// bundle B, every value as the compiler stores it), the safety read, shared core and clock of src/safety/test-support.ts,
// the turn's work (T-251, T-252), which records each turn it is handed, and K-05 v1 commitTurn (commit-first.json). Spans
// are read from the log lines (one JSON line each, ADR-009). Test method: T-1128's. Test values only (rule 9).
import { evictDurableObject, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

import activeBundle from "../../../contracts/data-access/fixtures/active-bundle.json";
import valueOnMiss from "../../../contracts/data-access/fixtures/bundle-value-on-miss.json";
import commitFirst from "../../../contracts/data-access/fixtures/commit-first.json";
import textImessage from "../../../contracts/inbound-event/fixtures/text-imessage.json";
import safetyNo from "../../../contracts/model/fixtures/safety-no.json";
import {
  LEASE_MS,
  setBatchHooks,
  setLeaseHooks,
  setSafetyDeps,
  type CommitTurnAnswer,
  type CommitTurnRequest,
  type HandleActor,
  type LeasedTurn,
} from "../actor";
import {
  durableObjectActor,
  prepareHandoff,
  type ActorNamespace,
  type HandleActorRpc,
  type InboundEvent,
} from "../gateway";
import { fakeKeyStore } from "../gateway/test-support";
import { harness } from "../safety/test-support";
import type { SafetyResult } from "../safety/types";
import { spanProblems } from "../trace";
import { BundleError, bundleKvOf, setBundleDeps, type PinEntry, type ReadBundleValueAnswer } from "./index";
import {
  ACTIVE_A,
  BUNDLE_A,
  BUNDLE_B,
  WHOLE_A,
  WHOLE_B,
  fakeBundles,
  keyIn,
  textAt,
  type FakeBundles,
} from "./test-support";

type Json = Record<string, unknown>;

/** The bundle id the gateway stamped on each text at receipt (the active id it read then; K-08 README default 1). */
const ARRIVED = { hash: "a".repeat(64), build: 1 };
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

function stub(): DurableObjectStub<HandleActor> {
  return namespace().get(namespace().idFromName(ALEX));
}

/** The actor's reads over RPC, typed here. */
interface PinRpc {
  readPins(): Promise<PinEntry[]>;
  safetyIdle(): Promise<void>;
  batchIdle(): Promise<void>;
}

function actorOf(): PinRpc {
  return stub();
}

async function arrive(eventId: string, options: { body?: string; trace?: string } = {}): Promise<void> {
  const trace = options.trace ?? TRACE;
  const overrides: Json = { eventId, body: options.body ?? "Can I move my haircut to Friday?" };
  const prepared = await prepareHandoff(
    {
      event: { ...(textImessage as Json), ...overrides, traceId: trace } as InboundEvent,
      partKey: null,
      traceId: trace,
      bundleId: ARRIVED,
    },
    keys,
  );
  if (prepared.door !== "actor") throw new Error("not an actor event");
  expect(await door().accept(prepared.handoff)).toBe("written");
}

const FIRST = commitFirst.outcome as unknown as CommitTurnAnswer;

/** commit-first.json's request for this run of the turn, naming the turn's pinned bundle (T-252 builds the real writes). */
function requestFor(turn: LeasedTurn): CommitTurnRequest {
  const base = commitFirst.request as unknown as CommitTurnRequest;
  return {
    ...base,
    turn: {
      ...base.turn,
      id: turn.turnId,
      eventIds: turn.eventIds,
      bundleId: turn.bundleId,
      traceId: turn.traceId,
      joinedTraceIds: turn.joinedTraceIds,
      tries: turn.tries,
    },
  };
}

interface Run {
  bundles: FakeBundles;
  /** Every run of a turn whose work started, in order. */
  turns: LeasedTurn[];
  /** Every commit request that reached K-05, in order. */
  commits: CommitTurnRequest[];
  /** The fake clock moves, then the alarm runs, as the platform would at the stored time. */
  tick(ms: number): Promise<void>;
  /** Settles the safety work, the batch work and the runs started so far. */
  settle(): Promise<void>;
  /** Runs `work` inside the actor, as the turn's work does while the turn runs. */
  inside<T>(work: () => T | Promise<T>): Promise<T>;
}

const ALL_NO: Record<string, SafetyResult> = Object.fromEntries(
  ["evt-1", "evt-2", "evt-3"].map((id) => [id, safetyNo as unknown as SafetyResult]),
);

async function withPins(
  body: (run: Run) => Promise<void>,
  options: { kv?: boolean; restarts?: boolean; wired?: boolean } = {},
): Promise<void> {
  const h = harness(keys, ALL_NO);
  const bundles = fakeBundles({ kv: options.kv ?? true });
  const turns: LeasedTurn[] = [];
  const commits: CommitTurnRequest[] = [];
  // A fake-clock timer still waiting keeps `evictDurableObject` from finishing: a test that restarts the actor gives the
  // safety read's 4 s deadline a promise with no timer (every read here answers at once, so it never matters).
  const safety = options.restarts
    ? { ...h.deps, clock: { now: () => h.clock.now(), after: () => new Promise<void>(() => undefined) } }
    : h.deps;
  const restoreSafety = setSafetyDeps(safety);
  const restoreBatch = setBatchHooks({ clock: h.clock });
  const restoreLease = setLeaseHooks({
    runTurn: (turn) => {
      turns.push(turn);
    },
    commit: (request) => {
      commits.push(request);
      return Promise.resolve({ ...FIRST, turnId: request.turn.id } as CommitTurnAnswer);
    },
  });
  const restoreBundles = setBundleDeps(options.wired === false ? null : bundles.deps);
  const run: Run = {
    bundles,
    turns,
    commits,
    async tick(ms) {
      await h.clock.advance(ms);
      await runDurableObjectAlarm(stub());
    },
    async settle() {
      await actorOf().safetyIdle();
      await actorOf().batchIdle();
    },
    inside(work) {
      return runInDurableObject(stub(), () => work());
    },
  };
  try {
    await body(run);
  } finally {
    restoreBundles();
    restoreLease();
    restoreBatch();
    restoreSafety();
  }
}

function only<T>(list: readonly T[], index = 0): T {
  const item = list[index];
  if (item === undefined) throw new Error(`nothing at ${String(index)}`);
  return item;
}

/** ADR-009's fields beside a span on its log line. */
const LINE_FIELDS = new Set(["level", "msg", "environment", "version"]);

/** The spans logged so far: each log line whose msg is "span", as K-08's span (ADR-009's line fields left out). */
function spansOf(log: MockInstance): Json[] {
  return log.mock.calls
    .map((call) => JSON.parse(String(call[0])) as Json)
    .filter((line) => line.msg === "span")
    .map((line) => Object.fromEntries(Object.entries(line).filter(([key]) => !LINE_FIELDS.has(key))));
}

const readsOfActive = (bundles: FakeBundles): number =>
  bundles.calls.filter((call) => call.call === "readActiveBundle").length;

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("the pin at turn start", () => {
  it("a turn pins the active bundle id read from PostgreSQL (K-05 active-bundle.json) with its manifest, and its work gets the pin", async () => {
    await withPins(async (run) => {
      await arrive("evt-1");
      await run.tick(3000);
      await run.settle();

      const turn = only(run.turns);
      expect(ACTIVE_A).toEqual(activeBundle.outcome);
      expect(turn.bundleId).toEqual(activeBundle.outcome.bundleId);
      expect(turn.bundleId).toEqual(BUNDLE_A);
      expect(turn.bundle.bundleId).toEqual(BUNDLE_A);
      expect(turn.bundle.manifest.bundleId).toEqual(BUNDLE_A);
      expect(turn.bundle.manifest.storage.manifestKey).toBe(activeBundle.outcome.manifestKey);
      expect(turn.bundle.manifest.lists).toEqual((WHOLE_A.manifest as unknown as { lists: unknown }).lists);
      expect(turn.bundle.reads()).toEqual([
        { key: activeBundle.outcome.manifestKey, kind: "manifest", from: "kv" },
      ]);
      expect(run.bundles.calls).toEqual([{ call: "readActiveBundle", key: null }]);
      expect(await actorOf().readPins()).toEqual([
        { turnId: turn.turnId, bundleId: BUNDLE_A, pinnedAt: 3000 },
      ]);
    });
  });

  it("a turn started under bundle A keeps A even if the active id flips to B mid-turn; the next turn uses B", async () => {
    await withPins(async (run) => {
      await arrive("evt-1");
      await run.tick(3000);
      await run.settle();
      const first = only(run.turns);
      expect(first.bundleId).toEqual(BUNDLE_A);

      // The deploy's step 3 switches the active id while the turn runs (BP 5.4).
      run.bundles.active = "B";
      const graph = await run.inside(() => first.bundle.flow("A"));
      expect(graph).toEqual(WHOLE_A.flows.A);
      expect(first.bundle.reads()).toEqual([
        { key: keyIn(BUNDLE_A, "manifest"), kind: "manifest", from: "kv" },
        { key: keyIn(BUNDLE_A, "flow/A"), kind: "flow", from: "kv" },
      ]);
      expect(await run.inside(() => first.commit(requestFor(first)))).toMatchObject({ result: "committed" });
      expect(run.commits.map((request) => request.turn.bundleId)).toEqual([BUNDLE_A]);
      // Nothing read the active id again while the turn ran.
      expect(readsOfActive(run.bundles)).toBe(1);

      await arrive("evt-2");
      await run.tick(3000);
      await run.settle();
      const next = only(run.turns, 1);
      expect(next.turnId).not.toBe(first.turnId);
      expect(next).toMatchObject({ eventIds: ["evt-2"], tries: 1, restart: false });
      expect(next.bundleId).toEqual(BUNDLE_B);
      expect(next.bundle.manifest.bundleId).toEqual(BUNDLE_B);
      expect(await run.inside(() => next.bundle.flow("A"))).toEqual(WHOLE_B.flows.A);
      expect(next.bundle.reads().map((read) => read.key)).toEqual([
        keyIn(BUNDLE_B, "manifest"),
        keyIn(BUNDLE_B, "flow/A"),
      ]);
      expect(readsOfActive(run.bundles)).toBe(2);
      expect(await actorOf().readPins()).toEqual([
        { turnId: first.turnId, bundleId: BUNDLE_A, pinnedAt: 3000 },
        { turnId: next.turnId, bundleId: BUNDLE_B, pinnedAt: 6000 },
      ]);
    });
  });

  it("a lapsed lease reruns the turn under the bundle it was pinned with, after the active id flipped and the actor restarted", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await withPins(
      async (run) => {
        await arrive("evt-1");
        await run.tick(3000);
        await run.settle();
        const first = only(run.turns);
        expect(first.bundleId).toEqual(BUNDLE_A);

        run.bundles.active = "B";
        await evictDurableObject(stub());
        await run.tick(LEASE_MS);
        await run.settle();

        const rerun = only(run.turns, 1);
        expect(rerun).toMatchObject({ turnId: first.turnId, tries: 2 });
        expect(rerun.bundleId).toEqual(BUNDLE_A);
        expect(rerun.bundle.manifest.bundleId).toEqual(BUNDLE_A);
        expect(await run.inside(() => rerun.bundle.flow("A"))).toEqual(WHOLE_A.flows.A);
        expect(readsOfActive(run.bundles)).toBe(1);
        expect(await actorOf().readPins()).toEqual([
          { turnId: first.turnId, bundleId: BUNDLE_A, pinnedAt: 3000 },
        ]);
        // Each run's lease span carries the turn's one bundle; the rerun's says the pin was kept.
        expect(
          spansOf(log)
            .filter((span) => span.hop === "lease")
            .map((span) => [span.turn_id, span.bundle_id, span.decided]),
        ).toEqual([
          [
            first.turnId,
            BUNDLE_A,
            { leaseSeconds: 60, bundlePinned: true, bundleKept: false, tries: 1, restart: false },
          ],
          [
            first.turnId,
            BUNDLE_A,
            { leaseSeconds: 60, bundlePinned: true, bundleKept: true, tries: 2, restart: false },
          ],
        ]);
      },
      { restarts: true },
    );
  });

  it("a text before the commit restarts the turn under a new turn id, which pins the active id read at its own start", async () => {
    await withPins(async (run) => {
      await arrive("evt-1");
      await run.tick(3000);
      await run.settle();
      const first = only(run.turns);
      expect(first.bundleId).toEqual(BUNDLE_A);

      run.bundles.active = "B";
      await arrive("evt-2");
      await run.tick(3000);
      await run.settle();

      const restarted = only(run.turns, 1);
      expect(restarted).toMatchObject({ eventIds: ["evt-1", "evt-2"], restart: true, tries: 1 });
      expect(restarted.turnId).not.toBe(first.turnId);
      expect(restarted.bundleId).toEqual(BUNDLE_B);
      expect(first.signal.aborted).toBe(true);
      expect(await actorOf().readPins()).toEqual([
        { turnId: first.turnId, bundleId: BUNDLE_A, pinnedAt: 3000 },
        { turnId: restarted.turnId, bundleId: BUNDLE_B, pinnedAt: 6000 },
      ]);
    });
  });
});

describe("a KV miss", () => {
  it("a KV miss reads the part through the K-05 fake and the turn still runs (KV takes about 60 s to propagate)", async () => {
    await withPins(async (run) => {
      run.bundles.kvMissing.add(keyIn(BUNDLE_A, "manifest"));
      run.bundles.kvMissing.add(keyIn(BUNDLE_A, "flow/A"));
      await arrive("evt-1");
      await run.tick(3000);
      await run.settle();

      const turn = only(run.turns);
      expect(turn.bundleId).toEqual(BUNDLE_A);
      expect(turn.bundle.manifest.bundleId).toEqual(BUNDLE_A);
      expect(await run.inside(() => turn.bundle.flow("A"))).toEqual(WHOLE_A.flows.A);
      expect(turn.bundle.reads()).toEqual([
        { key: keyIn(BUNDLE_A, "manifest"), kind: "manifest", from: "postgres" },
        { key: keyIn(BUNDLE_A, "flow/A"), kind: "flow", from: "postgres" },
      ]);
      // KV was asked first each time; PostgreSQL's copy answered the misses (K-05 readBundleValue).
      expect(run.bundles.kvReads).toEqual([keyIn(BUNDLE_A, "manifest"), keyIn(BUNDLE_A, "flow/A")]);
      expect(run.bundles.calls).toEqual([
        { call: "readActiveBundle", key: null },
        { call: "readBundleValue", key: keyIn(BUNDLE_A, "manifest") },
        { call: "readBundleValue", key: keyIn(BUNDLE_A, "flow/A") },
      ]);
      // A part read once is not read again in the same run.
      await run.inside(() => turn.bundle.flow("A"));
      expect(run.bundles.calls).toHaveLength(3);
    });
  });

  it("with no BUNDLES binding (env.staging until T-566), every value comes from PostgreSQL's copy and the turn runs", async () => {
    expect(bundleKvOf(undefined)).toBeNull();
    await withPins(
      async (run) => {
        await arrive("evt-1");
        await run.tick(3000);
        await run.settle();

        const turn = only(run.turns);
        expect(turn.bundleId).toEqual(BUNDLE_A);
        expect(await run.inside(() => turn.bundle.flow("A"))).toEqual(WHOLE_A.flows.A);
        expect(turn.bundle.reads().map((read) => read.from)).toEqual(["postgres", "postgres"]);
        expect(run.bundles.kvReads).toEqual([]);
      },
      { kv: false },
    );
  });

  it("a value KV holds other bytes for is not the bundle's: PostgreSQL's copy is read instead", async () => {
    await withPins(async (run) => {
      // Bundle B's manifest and flow graph under bundle A's keys.
      run.bundles.kvHolds.set(keyIn(BUNDLE_A, "manifest"), textAt(keyIn(BUNDLE_B, "manifest")));
      run.bundles.kvHolds.set(keyIn(BUNDLE_A, "flow/A"), textAt(keyIn(BUNDLE_B, "flow/A")));
      await arrive("evt-1");
      await run.tick(3000);
      await run.settle();

      const turn = only(run.turns);
      expect(turn.bundle.manifest.bundleId).toEqual(BUNDLE_A);
      expect(await run.inside(() => turn.bundle.flow("A"))).toEqual(WHOLE_A.flows.A);
      expect(turn.bundle.reads().map((read) => read.from)).toEqual(["postgres", "postgres"]);
    });
  });

  it("a value that is not the bundle's own is never pinned: PostgreSQL's stand-in manifest (bundle-value-on-miss.json) starts no work", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await withPins(async (run) => {
      const key = valueOnMiss.request.key;
      expect(key).toBe(keyIn(BUNDLE_A, "manifest"));
      run.bundles.kvMissing.add(key);
      run.bundles.postgres.set(key, valueOnMiss.outcome as ReadBundleValueAnswer);
      await arrive("evt-1");
      await run.tick(3000);
      await run.settle();

      expect(run.turns).toEqual([]);
      const pins = await actorOf().readPins();
      expect(pins.map((pin) => pin.bundleId)).toEqual([BUNDLE_A]);
      const lease = spansOf(log).filter((span) => span.hop === "lease");
      expect(lease).toEqual([
        expect.objectContaining({
          turn_id: only(pins).turnId,
          bundle_id: BUNDLE_A,
          outcome: "failed",
          error_code: "unreadable",
          decided: { bundlePinned: false, tries: 1, restart: false },
        }),
      ]);

      // Once PostgreSQL's copy holds the manifest, the lapsed lease's rerun pins the same bundle and the work starts.
      run.bundles.postgres.delete(key);
      await run.tick(LEASE_MS);
      await run.settle();
      const rerun = only(run.turns);
      expect(rerun).toMatchObject({ turnId: only(pins).turnId, tries: 2 });
      expect(rerun.bundleId).toEqual(BUNDLE_A);
      expect(rerun.bundle.reads()).toEqual([{ key, kind: "manifest", from: "postgres" }]);
      expect(readsOfActive(run.bundles)).toBe(1);
    });
  });

  it("a part the manifest does not list is never read", async () => {
    await withPins(async (run) => {
      await arrive("evt-1");
      await run.tick(3000);
      await run.settle();
      const turn = only(run.turns);
      const before = { calls: run.bundles.calls.length, kv: run.bundles.kvReads.length };

      const codeOf = (work: () => Promise<unknown>): Promise<string> =>
        run.inside(() =>
          work().then(
            () => "read",
            (error: unknown) => (error instanceof BundleError ? error.code : "other"),
          ),
        );
      // Bundle v0 holds flow A only, and no trade.
      expect(await codeOf(() => turn.bundle.flow("B"))).toBe("notInBundle");
      expect(await codeOf(() => turn.bundle.trade("barber"))).toBe("notInBundle");
      expect(run.bundles.calls).toHaveLength(before.calls);
      expect(run.bundles.kvReads).toHaveLength(before.kv);
    });
  });
});

describe("no bundle to pin", () => {
  it("with no bundle active yet, no work starts; once one is active, the lapsed lease's rerun pins it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await withPins(async (run) => {
      run.bundles.active = null;
      await arrive("evt-1");
      await run.tick(3000);
      await run.settle();

      expect(run.turns).toEqual([]);
      expect(await actorOf().readPins()).toEqual([]);
      // No bundle was pinned, so the span carries the id the text arrived under (K-08 README default 1).
      expect(spansOf(log).filter((span) => span.hop === "lease")).toEqual([
        expect.objectContaining({ bundle_id: ARRIVED, outcome: "failed", error_code: "noActiveBundle" }),
      ]);

      run.bundles.active = "B";
      await run.tick(LEASE_MS);
      await run.settle();
      const turn = only(run.turns);
      expect(turn).toMatchObject({ tries: 2 });
      expect(turn.bundleId).toEqual(BUNDLE_B);
    });
  });

  it("with no K-05 port set (unwired until D-017), no work starts", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await withPins(
      async (run) => {
        await arrive("evt-1");
        await run.tick(3000);
        await run.settle();

        expect(run.turns).toEqual([]);
        expect(await actorOf().readPins()).toEqual([]);
        expect(spansOf(log).filter((span) => span.hop === "lease")).toEqual([
          expect.objectContaining({ bundle_id: ARRIVED, outcome: "failed", error_code: "unwired" }),
        ]);
      },
      { wired: false },
    );
  });
});

describe("spans", () => {
  it("every span of the turn carries the pinned bundle id (K-08), and the next turn's spans carry the next one", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const firstTrace = "11111111-2222-4333-8444-555555555551";
    const nextTrace = "11111111-2222-4333-8444-555555555552";
    await withPins(async (run) => {
      await arrive("evt-1", { trace: firstTrace, body: "SECRETWORD about my haircut" });
      await run.tick(3000);
      await run.settle();
      const first = only(run.turns);

      // Mid-turn: the active id flips, then the turn's work records its hops on the turn's trace and commits.
      run.bundles.active = "B";
      await run.inside(() => {
        first.trace.record({
          hop: "guard",
          ms: 4,
          outcome: "ok",
          got: { roles: 0, openQuestions: 0, bookings: 0 },
          decided: { keyword: null, targets: 0 },
        });
        first.trace.record({ hop: "frontier", ms: 30, outcome: "ok", decided: { choices: 1 } });
      });
      await run.inside(() => first.commit(requestFor(first)));

      await arrive("evt-2", { trace: nextTrace });
      await run.tick(3000);
      await run.settle();
      const next = only(run.turns, 1);
      await run.inside(() => {
        next.trace.record({ hop: "guard", ms: 3, outcome: "ok", decided: { keyword: null, targets: 0 } });
      });

      // A turn's spans, read as K-08 reads a trace, in order by seq (README "Traces"). The first to carry the turn's id
      // is the batch span, before the lease's (trace-skeleton.json: batch at seq 4, lease at seq 5; T-1108).
      const spans = spansOf(log);
      const bySeq = (list: Json[]): Json[] => [...list].sort((a, b) => Number(a.seq) - Number(b.seq));
      const ofFirst = bySeq(spans.filter((span) => span.turn_id === first.turnId));
      expect(ofFirst.map((span) => span.hop)).toEqual(["batch", "lease", "guard", "frontier"]);
      expect(ofFirst.map((span) => span.bundle_id)).toEqual([BUNDLE_A, BUNDLE_A, BUNDLE_A, BUNDLE_A]);
      expect(ofFirst.map((span) => span.trace_id)).toEqual([firstTrace, firstTrace, firstTrace, firstTrace]);
      expect(ofFirst[1]).toMatchObject({
        hop: "lease",
        outcome: "ok",
        got: { texts: 1, manifestFrom: "kv" },
        decided: { leaseSeconds: 60, bundlePinned: true, bundleKept: false, tries: 1, restart: false },
      });
      const ofNext = bySeq(spans.filter((span) => span.turn_id === next.turnId));
      expect(ofNext.map((span) => span.hop)).toEqual(["batch", "lease", "guard"]);
      expect(ofNext.map((span) => span.bundle_id)).toEqual([BUNDLE_B, BUNDLE_B, BUNDLE_B]);
      expect(ofNext.map((span) => span.trace_id)).toEqual([nextTrace, nextTrace, nextTrace]);
      for (const span of [...ofFirst, ...ofNext]) expect(spanProblems(span)).toEqual([]);
    });
    // No log line holds a text's words or the phone number.
    const everything = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(everything).not.toContain("SECRETWORD");
    expect(everything).not.toContain("+15555550101");
  });
});

describe("the KV binding", () => {
  it("reads a value's text by its K-01 key", async () => {
    const asked: unknown[][] = [];
    const namespace = {
      get: (...args: unknown[]) => {
        asked.push(args);
        return Promise.resolve("{}");
      },
    } as unknown as KVNamespace;
    const kv = bundleKvOf(namespace);
    expect(await kv?.get(keyIn(BUNDLE_A, "manifest"))).toBe("{}");
    expect(asked).toEqual([[keyIn(BUNDLE_A, "manifest"), "text"]]);
  });
});
