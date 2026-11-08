// The turn lease, run inside the Workers runtime (T-248). The actor is the real Durable Object reached through the
// gateway's door: each text goes through the real safety read on arrival (its double answers safety-no.json, so nothing
// is held) and the real batch window, whose closed batches go to the actor's own lease. Doubles: the safety read, shared
// core and clock of src/safety/test-support.ts (one fake clock for the safety read, the batch and the lease); the turn's
// work (T-251, T-252), which only records each turn it is handed; and K-05 v1 commitTurn, which answers as
// commit-first.json and commit-repeat-same-turn.json state (a repeat of a committed turn id writes nothing and returns
// the first result). The alarm is fired with `runDurableObjectAlarm`, so "not yet due" is tested against the fake clock.
// Each run pins its bundle first (T-249), so K-05's bundle reads and the KV namespace are the doubles of
// src/bundle/test-support.ts, with bundle v0 active (active-bundle.json). Test method: T-1128's
// (runtime/src/spikes/do-test-pool/FINDINGS.md). Test values only (rule 9).
import { evictDurableObject, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import commitFirst from "../../../contracts/data-access/fixtures/commit-first.json";
import commitRepeat from "../../../contracts/data-access/fixtures/commit-repeat-same-turn.json";
import textImessage from "../../../contracts/inbound-event/fixtures/text-imessage.json";
import safetyNo from "../../../contracts/model/fixtures/safety-no.json";
import {
  durableObjectActor,
  prepareHandoff,
  type ActorNamespace,
  type HandleActorRpc,
  type InboundEvent,
} from "../gateway";
import { fakeKeyStore } from "../gateway/test-support";
import { fakeBundles } from "../bundle/test-support";
import { harness, type Harness } from "../safety/test-support";
import type { SafetyResult } from "../safety/types";
import {
  LEASE_MS,
  setBatchHooks,
  setBundleDeps,
  setLeaseHooks,
  setSafetyDeps,
  turnIdOf,
  type BatchEntry,
  type ClosedBatch,
  type CommitAnswer,
  type CommitTurnAnswer,
  type CommitTurnRequest,
  type HandleActor,
  type LeasedTurn,
  type TurnEntry,
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

/** The actor's reads over RPC, typed here (the stub's own type cannot carry the sealed event's open shape). */
interface LeaseRpc {
  readTurns(): Promise<TurnEntry[]>;
  readWaitingBatches(): Promise<number[]>;
  readBatches(): Promise<BatchEntry[]>;
  safetyIdle(): Promise<void>;
  batchIdle(): Promise<void>;
}

function stub(): DurableObjectStub<HandleActor> {
  return namespace().get(namespace().idFromName(ALEX));
}

function actorOf(): LeaseRpc {
  return stub();
}

/** The lease inside the actor, for calling it the way the batch window does. */
interface LeaseInside {
  take(batch: ClosedBatch): Promise<"taken" | "unwired">;
}

function leaseIn(instance: unknown): LeaseInside {
  return (instance as { lease: LeaseInside }).lease;
}

async function arrive(eventId: string, options: { body?: string; trace?: string } = {}): Promise<void> {
  const trace = options.trace ?? TRACE;
  const overrides: Json = { eventId, body: options.body ?? "Can I move my haircut to Friday?" };
  const prepared = await prepareHandoff(
    {
      event: { ...(textImessage as Json), ...overrides, traceId: trace } as InboundEvent,
      partKey: null,
      traceId: trace,
      bundleId: BUNDLE,
    },
    keys,
  );
  if (prepared.door !== "actor") throw new Error("not an actor event");
  expect(await door().accept(prepared.handoff)).toBe("written");
}

/** K-05 v1 commitTurn as the fixtures state it: the first commit of a turn id, then the repeat's first result. */
interface FakeCommits {
  /** Every request, in order. */
  readonly calls: CommitTurnRequest[];
  /** Each turn id committed, once, with its first answer. */
  readonly committed: Map<string, CommitTurnAnswer>;
  /** True: the next commit goes through, but its answer is lost on the way back (the call throws). */
  loseNextAnswer: boolean;
  commitTurn(request: CommitTurnRequest): Promise<CommitTurnAnswer>;
}

const FIRST = commitFirst.outcome as unknown as CommitTurnAnswer;
const REPEAT = commitRepeat.outcome as unknown as CommitTurnAnswer;

function fakeCommits(): FakeCommits {
  const k05: FakeCommits = {
    calls: [],
    committed: new Map(),
    loseNextAnswer: false,
    commitTurn(request) {
      k05.calls.push(request);
      if (k05.committed.has(request.turn.id)) {
        // commit-repeat-same-turn.json: the same turn id again writes nothing and returns the first commit, repeated.
        return Promise.resolve({ ...REPEAT, turnId: request.turn.id });
      }
      // commit-first.json.
      const first = { ...FIRST, turnId: request.turn.id };
      k05.committed.set(request.turn.id, first);
      if (k05.loseNextAnswer) {
        k05.loseNextAnswer = false;
        return Promise.reject(new Error("the answer was lost"));
      }
      return Promise.resolve(first);
    },
  };
  return k05;
}

/** commit-first.json's request, for this run of the turn (the gate's writes are the fixture's: T-252 builds real ones). */
function requestFor(turn: LeasedTurn): CommitTurnRequest {
  const base = commitFirst.request as unknown as CommitTurnRequest;
  return {
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
}

interface Run {
  h: Harness;
  k05: FakeCommits;
  /** Every turn the lease handed the turn's work, in order. */
  turns: LeasedTurn[];
  /** The fake clock moves, then the alarm runs, as the platform would at the stored time. */
  tick(ms: number): Promise<void>;
  /** Settles the safety work, the batch work and the turns' work of what has arrived. */
  settle(): Promise<void>;
  /** Commits this run of the turn through the lease, inside the actor, as the turn's work does. */
  commit(turn: LeasedTurn, request?: CommitTurnRequest): Promise<CommitAnswer>;
}

const IDS = Array.from({ length: 12 }, (_, index) => `evt-${String(index + 1)}`);
const ALL_NO: Record<string, SafetyResult> = Object.fromEntries(
  IDS.map((id) => [id, safetyNo as unknown as SafetyResult]),
);

async function withLease(
  body: (run: Run) => Promise<void>,
  options: { turnWired?: boolean; capture?: ClosedBatch[]; restarts?: boolean } = {},
): Promise<void> {
  const h = harness(keys, ALL_NO);
  const k05 = fakeCommits();
  const turns: LeasedTurn[] = [];
  // A fake-clock timer still waiting keeps `evictDurableObject` from finishing: a test that restarts the actor gives the
  // safety read's 4 s deadline a promise with no timer (every read here answers at once, so it never matters).
  const deps = options.restarts
    ? { ...h.deps, clock: { now: () => h.clock.now(), after: () => new Promise<void>(() => undefined) } }
    : h.deps;
  const restoreSafety = setSafetyDeps(deps);
  const capture = options.capture;
  const restoreBatch = setBatchHooks({
    clock: h.clock,
    ...(capture === undefined
      ? {}
      : {
          toLease: (batch: ClosedBatch) => {
            capture.push(batch);
          },
        }),
  });
  const restoreLease = setLeaseHooks(
    options.turnWired === false
      ? {}
      : {
          runTurn: (turn) => {
            turns.push(turn);
          },
          commit: (request) => k05.commitTurn(request),
        },
  );
  const restoreBundles = setBundleDeps(fakeBundles().deps);
  const run: Run = {
    h,
    k05,
    turns,
    async tick(ms) {
      await h.clock.advance(ms);
      await runDurableObjectAlarm(stub());
    },
    async settle() {
      await actorOf().safetyIdle();
      await actorOf().batchIdle();
    },
    commit(turn, request) {
      return runInDurableObject(stub(), () => turn.commit(request ?? requestFor(turn)));
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

/** What the lease table holds: how many rows (at most one, by its own CHECK). */
function leaseRows(): Promise<number> {
  return runInDurableObject(
    stub(),
    (_, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM turn_lease").one().n,
  );
}

function alarmOf(): Promise<number | null> {
  return runInDurableObject(stub(), (_, state) => state.storage.getAlarm());
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("the turn id", () => {
  it("the same texts always give the same turn id, in whatever order they came", async () => {
    const id = await turnIdOf(["evt-alex-0012", "evt-alex-0013", "evt-alex-0014"]);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(await turnIdOf(["evt-alex-0012", "evt-alex-0013", "evt-alex-0014"])).toBe(id);
    expect(await turnIdOf(["evt-alex-0014", "evt-alex-0012", "evt-alex-0013"])).toBe(id);
    expect(await turnIdOf(["evt-alex-0013", "evt-alex-0014", "evt-alex-0012", "evt-alex-0013"])).toBe(id);
  });

  it("a different set of texts gives a different turn id, even when an id holds the separator or a quote", async () => {
    const sets: string[][] = [
      ["evt-1"],
      ["evt-2"],
      ["evt-1", "evt-2"],
      ["evt-1", "evt-2", "evt-3"],
      ["evt-1", "evt-3"],
      ["evt-1\nevt-2"],
      ['evt-1"\n"evt-2'],
      ['evt-1","evt-2'],
      ["evt-1,evt-2"],
      ["evt-1 evt-2"],
      ["evt-1evt-2"],
      ["EVT-1"],
    ];
    const ids = await Promise.all(sets.map((set) => turnIdOf(set)));
    expect(new Set(ids).size).toBe(sets.length);
    await expect(turnIdOf([])).rejects.toThrow("noTexts");
  });

  it("is SHA-256 over the sorted ids, each a JSON string, one per line: a fixed form, so a rerun after a deploy keeps its id", async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode('"evt-alex-0012"\n"evt-alex-0013"'),
    );
    const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(await turnIdOf(["evt-alex-0013", "evt-alex-0012"])).toBe(hex);
  });

  it("a batch's turn carries the hash of its texts' event ids, its sealed texts, and the first text's trace id", async () => {
    await withLease(async (run) => {
      await arrive("evt-1", { trace: "11111111-2222-4333-8444-555555555551" });
      await arrive("evt-2", { trace: "11111111-2222-4333-8444-555555555552" });
      await arrive("evt-3", { trace: "11111111-2222-4333-8444-555555555553" });
      await run.settle();

      expect(run.turns).toHaveLength(1);
      const [turn] = run.turns;
      expect(turn?.turnId).toBe(await turnIdOf(["evt-1", "evt-2", "evt-3"]));
      expect(turn).toMatchObject({
        eventIds: ["evt-1", "evt-2", "evt-3"],
        traceId: "11111111-2222-4333-8444-555555555551",
        joinedTraceIds: ["11111111-2222-4333-8444-555555555552", "11111111-2222-4333-8444-555555555553"],
        tries: 1,
        restart: false,
        leaseUntil: LEASE_MS,
      });
      // The texts as the inbox keeps them: sealed, in arrival order.
      expect(turn?.entries.map((entry) => entry.event.eventId)).toEqual(["evt-1", "evt-2", "evt-3"]);
      expect(turn?.entries.every((entry) => entry.event.sealed !== null)).toBe(true);
      expect(await actorOf().readTurns()).toEqual([
        {
          turnId: turn?.turnId,
          eventIds: ["evt-1", "evt-2", "evt-3"],
          state: "leased",
          restart: false,
          tries: 1,
          leaseUntil: LEASE_MS,
          committedAt: null,
        },
      ]);
      expect(await actorOf().readBatches()).toMatchObject([{ handed: true }]);
    });
  });
});

describe("one lease per handle", () => {
  it("two lease attempts at once for one batch give exactly one lease and one run", async () => {
    const captured: ClosedBatch[] = [];
    await withLease(
      async (run) => {
        await arrive("evt-1");
        await arrive("evt-2");
        await arrive("evt-3");
        await run.settle();
        const [batch] = captured;
        if (batch === undefined) throw new Error("no batch closed");

        const answers = await runInDurableObject(stub(), (instance) =>
          Promise.all(Array.from({ length: 10 }, () => leaseIn(instance).take(batch))),
        );
        await run.settle();

        expect(answers).toEqual(Array.from({ length: 10 }, () => "taken"));
        expect(run.turns.map((turn) => turn.eventIds)).toEqual([["evt-1", "evt-2", "evt-3"]]);
        expect(await leaseRows()).toBe(1);
        expect(await actorOf().readTurns()).toMatchObject([{ state: "leased", leaseUntil: LEASE_MS }]);
      },
      { capture: captured },
    );
  });

  it("two different batches at once, with no turn running, give exactly one lease, whose turn holds both", async () => {
    const captured: ClosedBatch[] = [];
    await withLease(
      async (run) => {
        for (const eventId of ["evt-1", "evt-2", "evt-3", "evt-4", "evt-5", "evt-6"]) await arrive(eventId);
        await run.settle();
        expect(captured.map((batch) => batch.batchId)).toEqual([1, 2]);
        const [one, two] = captured;
        if (one === undefined || two === undefined) throw new Error("no batches closed");

        await runInDurableObject(stub(), (instance) =>
          Promise.all([
            leaseIn(instance).take(one),
            leaseIn(instance).take(two),
            leaseIn(instance).take(two),
            leaseIn(instance).take(one),
          ]),
        );
        await run.settle();

        expect(await leaseRows()).toBe(1);
        const turns = await actorOf().readTurns();
        const live = turns.filter((turn) => turn.leaseUntil !== null);
        expect(live).toHaveLength(1);
        expect(live[0]).toMatchObject({
          state: "leased",
          eventIds: ["evt-1", "evt-2", "evt-3", "evt-4", "evt-5", "evt-6"],
        });
        expect(live[0]?.turnId).toBe(await turnIdOf(["evt-1", "evt-2", "evt-3", "evt-4", "evt-5", "evt-6"]));
        // Any turn opened on the way was replaced by the one restart, never left beside it.
        expect(
          turns.filter((turn) => turn.leaseUntil === null).every((turn) => turn.state === "replaced"),
        ).toBe(true);
        expect(await actorOf().readWaitingBatches()).toEqual([]);
      },
      { capture: captured },
    );
  });

  it("a batch handed again after a crash (at least once) starts no second turn", async () => {
    await withLease(async (run) => {
      await arrive("evt-1");
      await run.tick(3000);
      await run.settle();
      expect(run.turns).toHaveLength(1);

      // A crash between the lease taking the batch and the batch window's mark: the window hands it again.
      await runInDurableObject(stub(), (_, state) => {
        state.storage.sql.exec("UPDATE batches SET handed = 0 WHERE batch_id = 1");
        state.storage.sql.exec(
          "INSERT OR REPLACE INTO batch_schedule (kind, due_ms) VALUES ('batchRelease', 3000)",
        );
      });
      await run.tick(0);
      await run.settle();

      expect(run.turns).toHaveLength(1);
      expect(await actorOf().readBatches()).toMatchObject([{ batchId: 1, handed: true }]);
      expect(await actorOf().readTurns()).toMatchObject([{ eventIds: ["evt-1"], state: "leased" }]);
    });
  });
});

describe("the restart rule", () => {
  it("a text before the commit restarts the turn once, with it; the replaced turn never commits", async () => {
    await withLease(async (run) => {
      await arrive("evt-1");
      await run.tick(3000);
      await run.settle();
      const first = run.turns[0];
      if (first === undefined) throw new Error("no turn");
      expect(first).toMatchObject({
        eventIds: ["evt-1"],
        restart: false,
        tries: 1,
        leaseUntil: 3000 + LEASE_MS,
      });

      await arrive("evt-2");
      await run.tick(3000);
      await run.settle();

      expect(run.turns).toHaveLength(2);
      const restarted = run.turns[1];
      if (restarted === undefined) throw new Error("no restart");
      expect(restarted.turnId).toBe(await turnIdOf(["evt-1", "evt-2"]));
      expect(restarted).toMatchObject({
        eventIds: ["evt-1", "evt-2"],
        restart: true,
        tries: 1,
        leaseUntil: 6000 + LEASE_MS,
      });
      expect(restarted.entries.map((entry) => entry.event.eventId)).toEqual(["evt-1", "evt-2"]);
      expect(first.signal.aborted).toBe(true);
      expect(restarted.signal.aborted).toBe(false);

      expect(await run.commit(first)).toEqual({ error: "replaced" });
      expect(run.k05.calls).toEqual([]);
      expect(await actorOf().readTurns()).toMatchObject([
        { turnId: first.turnId, state: "replaced", leaseUntil: null },
        { turnId: restarted.turnId, state: "leased", restart: true, leaseUntil: 6000 + LEASE_MS },
      ]);
      expect(await leaseRows()).toBe(1);
    });
  });

  it("a second such text waits for the next turn, which opens with it once the restarted turn commits", async () => {
    await withLease(async (run) => {
      await arrive("evt-1");
      await run.tick(3000);
      await arrive("evt-2");
      await run.tick(3000);
      await run.settle();
      const restarted = run.turns[1];
      if (restarted === undefined) throw new Error("no restart");

      await arrive("evt-3");
      await run.tick(3000);
      await run.settle();
      // No third run: the restart happens once.
      expect(run.turns).toHaveLength(2);
      expect(await actorOf().readWaitingBatches()).toEqual([3]);
      expect(await actorOf().readBatches()).toMatchObject([
        { batchId: 1, handed: true },
        { batchId: 2, handed: true },
        { batchId: 3, handed: true },
      ]);

      const answer = await run.commit(restarted);
      expect(answer).toEqual({ ...FIRST, turnId: restarted.turnId });
      await run.settle();

      expect(run.turns).toHaveLength(3);
      const next = run.turns[2];
      expect(next?.turnId).toBe(await turnIdOf(["evt-3"]));
      expect(next).toMatchObject({ eventIds: ["evt-3"], restart: false, tries: 1 });
      expect(await actorOf().readTurns()).toMatchObject([
        { state: "replaced" },
        {
          turnId: restarted.turnId,
          state: "committed",
          committedAt: "2026-11-07T15:06:30Z",
          leaseUntil: null,
        },
        { turnId: next?.turnId, state: "leased", restart: false },
      ]);
      expect(await actorOf().readWaitingBatches()).toEqual([]);
      expect(await leaseRows()).toBe(1);
    });
  });

  it("after the commit, a text opens the next turn", async () => {
    await withLease(async (run) => {
      await arrive("evt-1");
      await run.tick(3000);
      await run.settle();
      const first = run.turns[0];
      if (first === undefined) throw new Error("no turn");
      expect(await run.commit(first)).toMatchObject({ result: "committed", repeated: false });
      expect(await leaseRows()).toBe(0);

      await arrive("evt-2");
      await run.tick(3000);
      await run.settle();
      expect(run.turns).toHaveLength(2);
      expect(run.turns[1]).toMatchObject({ eventIds: ["evt-2"], restart: false, tries: 1 });
      expect(await actorOf().readTurns()).toMatchObject([
        { turnId: first.turnId, state: "committed" },
        { eventIds: ["evt-2"], state: "leased" },
      ]);
    });
  });

  it("a text that closes once the turn has sent its commit waits: the commit may have gone through", async () => {
    await withLease(async (run) => {
      await arrive("evt-1");
      await run.tick(3000);
      await run.settle();
      const first = run.turns[0];
      if (first === undefined) throw new Error("no turn");
      run.k05.loseNextAnswer = true;
      expect(await run.commit(first)).toEqual({ error: "noAnswer" });

      await arrive("evt-2");
      await run.tick(3000);
      await run.settle();
      expect(run.turns).toHaveLength(1);
      expect(await actorOf().readTurns()).toMatchObject([{ turnId: first.turnId, state: "committing" }]);
      expect(await actorOf().readWaitingBatches()).toEqual([2]);

      // Sent again, the same turn id returns the first commit; then the waiting text opens the next turn.
      expect(await run.commit(first)).toMatchObject({ result: "committed", repeated: true });
      await run.settle();
      expect(run.turns.map((turn) => turn.eventIds)).toEqual([["evt-1"], ["evt-2"]]);
      expect(run.k05.committed.size).toBe(1);
    });
  });
});

describe("a lapsed lease", () => {
  it("a lease that lapses (fake clock past 60 s, no commit) reruns from the sealed texts with the same turn id, so a repeat commit returns the first result", async () => {
    await withLease(async (run) => {
      await arrive("evt-1");
      await arrive("evt-2");
      await run.tick(3000);
      await run.settle();
      const first = run.turns[0];
      if (first === undefined) throw new Error("no turn");
      expect(first).toMatchObject({ eventIds: ["evt-1", "evt-2"], tries: 1, leaseUntil: 63_000 });

      // The commit goes through in PostgreSQL, but its answer never comes back: the actor saw no commit.
      run.k05.loseNextAnswer = true;
      expect(await run.commit(first)).toEqual({ error: "noAnswer" });

      await run.tick(59_999);
      await run.settle();
      expect(run.turns).toHaveLength(1);

      await run.tick(1);
      await run.settle();
      expect(run.turns).toHaveLength(2);
      const rerun = run.turns[1];
      if (rerun === undefined) throw new Error("no rerun");
      expect(rerun.turnId).toBe(first.turnId);
      expect(rerun).toMatchObject({
        eventIds: ["evt-1", "evt-2"],
        tries: 2,
        restart: false,
        leaseUntil: 123_000,
      });
      // The same sealed texts, read again from the inbox.
      expect(rerun.entries).toEqual(first.entries);
      expect(first.signal.aborted).toBe(true);

      // commit-repeat-same-turn.json: the repeat writes nothing and returns the first commit.
      const answer = await run.commit(rerun);
      expect(answer).toEqual({ ...REPEAT, turnId: first.turnId });
      expect(answer).toMatchObject({ repeated: true, committedAt: "2026-11-07T15:06:30Z" });
      expect(run.k05.calls.map((call) => [call.turn.id, call.turn.tries])).toEqual([
        [first.turnId, 1],
        [first.turnId, 2],
      ]);
      expect(run.k05.committed.size).toBe(1);
      expect(await actorOf().readTurns()).toEqual([
        {
          turnId: first.turnId,
          eventIds: ["evt-1", "evt-2"],
          state: "committed",
          restart: false,
          tries: 2,
          leaseUntil: null,
          committedAt: "2026-11-07T15:06:30Z",
        },
      ]);
      expect(await leaseRows()).toBe(0);
    });
  });

  it("a lease that lapses while the actor is gone reruns the turn when the alarm wakes it", async () => {
    await withLease(
      async (run) => {
        await arrive("evt-1");
        await run.tick(3000);
        await run.settle();
        const first = run.turns[0];
        if (first === undefined) throw new Error("no turn");

        await evictDurableObject(stub());
        await run.tick(LEASE_MS);
        await run.settle();

        expect(run.turns).toHaveLength(2);
        const rerun = run.turns[1];
        if (rerun === undefined) throw new Error("no rerun");
        expect(rerun).toMatchObject({ turnId: first.turnId, tries: 2, eventIds: ["evt-1"] });
        expect(await run.commit(rerun)).toMatchObject({ result: "committed", repeated: false });
      },
      { restarts: true },
    );
  });

  it("a third lapse is left for the park (T-253): no fourth try, nothing polls, and a later text waits", async () => {
    await withLease(async (run) => {
      await arrive("evt-1");
      await run.tick(3000);
      await run.tick(LEASE_MS);
      await run.tick(LEASE_MS);
      await run.settle();
      expect(run.turns.map((turn) => turn.tries)).toEqual([1, 2, 3]);

      await run.tick(LEASE_MS);
      await run.settle();
      expect(run.turns).toHaveLength(3);
      expect(await alarmOf()).toBeNull();

      await arrive("evt-2");
      await run.tick(3000);
      await run.settle();
      expect(run.turns).toHaveLength(3);
      expect(await actorOf().readWaitingBatches()).toEqual([2]);
      expect(await actorOf().readTurns()).toMatchObject([{ eventIds: ["evt-1"], state: "leased", tries: 3 }]);
    });
  });
});

describe("the seam to the turn's work", () => {
  it("with no turn's work wired, nothing runs, the batch stays stored with the batch window, and nothing polls", async () => {
    await withLease(
      async (run) => {
        await arrive("evt-1");
        await run.tick(3000);
        await run.settle();
        expect(await actorOf().readBatches()).toMatchObject([{ batchId: 1, reason: "quiet", handed: false }]);
        expect(await actorOf().readTurns()).toEqual([]);
        expect(await leaseRows()).toBe(0);
        expect(await alarmOf()).toBeNull();
      },
      { turnWired: false },
    );
  });

  it("a commit that names another turn is refused, and nothing is sent", async () => {
    await withLease(async (run) => {
      await arrive("evt-1");
      await run.tick(3000);
      await run.settle();
      const first = run.turns[0];
      if (first === undefined) throw new Error("no turn");
      const other = requestFor(first);
      expect(await run.commit(first, { ...other, turn: { ...other.turn, id: "turn-alex-book-1" } })).toEqual({
        error: "wrongTurn",
      });
      expect(run.k05.calls).toEqual([]);
    });
  });

  it("writes no word of a text into the logs", async () => {
    const spy = vi.spyOn(console, "log");
    await withLease(async (run) => {
      await arrive("evt-1", { body: "SECRETWORD about my haircut" });
      await run.tick(3000);
      await run.settle();
      const first = run.turns[0];
      if (first === undefined) throw new Error("no turn");
      await run.commit(first);
      await run.settle();
    });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("SECRETWORD");
  });
});
