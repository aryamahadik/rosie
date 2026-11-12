// The turn lease, run inside the Workers runtime (T-248). The actor is the real Durable Object reached through the
// gateway's door: each text goes through the real safety read on arrival (its double answers safety-no.json, so nothing
// is held) and the real batch window, whose closed batches go to the actor's own lease. Doubles: the safety read, shared
// core and clock of src/safety/test-support.ts (one fake clock for the safety read, the batch and the lease); the turn's
// work (T-251, T-252), which only records each turn it is handed; and K-05 v1 commitTurn, which answers as
// commit-first.json and commit-repeat-same-turn.json state (a repeat of a committed turn id writes nothing and returns
// the first result). The alarm is fired with `runDurableObjectAlarm`, so "not yet due" is tested against the fake clock.
// Each run pins its bundle first (T-249), so K-05's bundle reads and the KV namespace are the doubles of
// src/bundle/test-support.ts, with bundle v0 active (active-bundle.json). The PostgreSQL-down path is unwired, as the
// composition root installs it today, unless a test wires it (ADR-018 section 1: the lease's `stopAmong` reads each text
// through it): its doubles (src/outage/db/test-support.ts), PostgreSQL answering, and the actor's copy of the pinned
// bundle's keyword list (bundle v0's: STOP, START, HELP), taken at each pin. Test method: T-1128's
// (runtime/src/spikes/do-test-pool/FINDINGS.md). Test values only (rule 9).
import { evictDurableObject, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import commitFirst from "../../../contracts/data-access/fixtures/commit-first.json";
import commitRepeat from "../../../contracts/data-access/fixtures/commit-repeat-same-turn.json";
import reactionFromCustomer from "../../../contracts/inbound-event/fixtures/reaction-from-customer.json";
import textImessage from "../../../contracts/inbound-event/fixtures/text-imessage.json";
import safetyCrisisWords from "../../../contracts/model/fixtures/safety-crisis-words.json";
import safetyNo from "../../../contracts/model/fixtures/safety-no.json";
import safetyThreat from "../../../contracts/model/fixtures/safety-threat.json";
import {
  actorNameOf,
  durableObjectActor,
  openWords,
  prepareHandoff,
  type ActorNamespace,
  type HandleActorRpc,
  type InboundEvent,
  type SealedHandoff,
} from "../gateway";
import { fakeKeyStore, present } from "../gateway/test-support";
import { fakeBundles } from "../bundle/test-support";
import { setDbOutageDeps, type OutageView, type TextKind } from "../outage/db";
import { dbFakes, type DbFakes } from "../outage/db/test-support";
import { harness, TEST_IDS, type Harness } from "../safety/test-support";
import type { SafetyResult } from "../safety/types";
import type { LeaseHost } from "./lease";
import {
  LEASE_MS,
  PARK_RETRY_MS,
  setBatchHooks,
  setBundleDeps,
  setLeaseHooks,
  setSafetyDeps,
  turnIdOf,
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
  type ParkAnswer,
  type ParkingTurn,
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
  readHolds(): Promise<HoldEntry[]>;
  readOutage(): Promise<OutageView>;
  markHoldReleased(holdId: string): Promise<"released" | "neverReleased" | "noSuchHold">;
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

/** The host the actor gave its lease (handle-actor.ts), as the lease asks it. */
function leaseHostIn(instance: unknown): LeaseHost {
  return (instance as { lease: { host: LeaseHost } }).lease.host;
}

async function handoffOf(
  eventId: string,
  options: { body?: string; trace?: string; tapback?: boolean } = {},
): Promise<SealedHandoff> {
  const trace = options.trace ?? TRACE;
  // A tapback (K-06 reaction-from-customer.json): no words, so nothing of it is read.
  const event: Json =
    options.tapback === true
      ? { ...(reactionFromCustomer as Json), eventId }
      : { ...(textImessage as Json), eventId, body: options.body ?? "Can I move my haircut to Friday?" };
  const prepared = await prepareHandoff(
    {
      event: { ...event, traceId: trace } as InboundEvent,
      partKey: null,
      traceId: trace,
      bundleId: BUNDLE,
    },
    keys,
  );
  if (prepared.door !== "actor") throw new Error("not an actor event");
  return prepared.handoff;
}

async function arrive(
  eventId: string,
  options: { body?: string; trace?: string; tapback?: boolean } = {},
): Promise<void> {
  expect(await door().accept(await handoffOf(eventId, options))).toBe("written");
}

/** K-05 v1 commitTurn as the fixtures state it: the first commit of a turn id, then the repeat's first result. */
interface FakeCommits {
  /** Every request, in order. */
  readonly calls: CommitTurnRequest[];
  /**
   * What the lease handed the commit hook beside each request (the safety holds open and the texts not read yet at
   * commit time), in order.
   */
  readonly contexts: CommitContext[];
  /** Each turn id committed, once, with its first answer. */
  readonly committed: Map<string, CommitTurnAnswer>;
  /** True: the next commit goes through, but its answer is lost on the way back (the call throws). */
  loseNextAnswer: boolean;
  commitTurn(request: CommitTurnRequest, at?: CommitContext): Promise<CommitTurnAnswer>;
}

const FIRST = commitFirst.outcome as unknown as CommitTurnAnswer;
const REPEAT = commitRepeat.outcome as unknown as CommitTurnAnswer;

function fakeCommits(): FakeCommits {
  const k05: FakeCommits = {
    calls: [],
    contexts: [],
    committed: new Map(),
    loseNextAnswer: false,
    commitTurn(request, at) {
      k05.calls.push(request);
      if (at !== undefined) k05.contexts.push(at);
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
  /** The PostgreSQL-down path's doubles while a test wires it (PostgreSQL answering until a test says it is down). */
  db: DbFakes | null;
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
  options: {
    turnWired?: boolean;
    capture?: ClosedBatch[];
    restarts?: boolean;
    /** What the safety read says for each event id (default: No for every text). */
    answers?: Record<string, SafetyResult>;
    /**
     * The PostgreSQL-down path wired (T-270), as D-017 will wire it: its doubles over the test's key store, PostgreSQL
     * answering. It reads each text it follows against the actor's copy of the pinned bundle's keyword list, which the first
     * turn's pin takes (a text read before any pin reads `unknown`). Unwired by default, as the root installs it today.
     */
    downPath?: boolean;
    /** K-05 v1 parkTurn after a third lapse with no commit (T-253); none wired unless given. */
    park?: (turn: ParkingTurn) => Promise<ParkAnswer>;
  } = {},
): Promise<void> {
  const h = harness(keys, options.answers ?? ALL_NO);
  const k05 = fakeCommits();
  const turns: LeasedTurn[] = [];
  const db = options.downPath === true ? dbFakes(keys, {}, { start: 0, ids: TEST_IDS }) : null;
  const restoreDown = db === null ? (): void => undefined : setDbOutageDeps(db.outageDeps);
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
          commit: (request, at) => k05.commitTurn(request, at),
          ...(options.park === undefined ? {} : { park: options.park }),
        },
  );
  const restoreBundles = setBundleDeps(fakeBundles().deps);
  const run: Run = {
    h,
    k05,
    db,
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
    restoreDown();
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

/** The actor's stored schedule, earliest first. */
function scheduleOf(): Promise<{ kind: string; due_ms: number }[]> {
  return runInDurableObject(stub(), (_, state) =>
    state.storage.sql
      .exec<{ kind: string; due_ms: number }>("SELECT kind, due_ms FROM batch_schedule ORDER BY due_ms, kind")
      .toArray(),
  );
}

/** lease_turns.restart of each turn, in the order they opened: 0, 1 for the one restart, 2 for the second (ADR-018). */
function restartsWritten(): Promise<number[]> {
  return runInDurableObject(stub(), (_, state) =>
    state.storage.sql
      .exec<{ restart: number }>("SELECT restart FROM lease_turns ORDER BY seq")
      .toArray()
      .map((row) => row.restart),
  );
}

/** One statement on the actor's own storage (a fault a test puts in its way). */
function exec(query: string): Promise<void> {
  return runInDurableObject(stub(), (_, state) => {
    state.storage.sql.exec(query);
  });
}

/** The PostgreSQL-down path's reading of a text it follows (`outage_texts.kind`), or undefined when it has no row. */
async function readingOf(eventId: string): Promise<TextKind | null | undefined> {
  return (await actorOf().readOutage()).texts.find((text) => text.eventId === eventId)?.kind;
}

/** The actor's lease host asked whether these texts may hold a stop word, inside the actor, as the lease asks it. */
function stopAmong(eventIds: string[]): Promise<boolean | undefined> {
  return runInDurableObject(stub(), (instance) => leaseHostIn(instance).stopAmong?.(eventIds));
}

/** A text (or a tapback) arrives, and its batch closes 3 s on, alone: what it starts settles. */
async function batchOf(
  run: Run,
  eventId: string,
  options: { body?: string; tapback?: boolean } = {},
): Promise<void> {
  await arrive(eventId, options);
  await run.settle();
  await run.tick(3000);
  await run.settle();
}

/** A turn of evt-1 (its batch closes at 3 s), then its one restart by evt-2's batch (at 6 s): the restarted turn's run. */
async function restartedOnce(run: Run): Promise<LeasedTurn> {
  await batchOf(run, "evt-1");
  await batchOf(run, "evt-2");
  const restarted = present(run.turns[1], "the restarted turn");
  expect(restarted).toMatchObject({ eventIds: ["evt-1", "evt-2"], restart: true, tries: 1 });
  return restarted;
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

  // With the PostgreSQL-down path wired (ADR-018 section 1): the third text reads as another text, so its batch may hold no
  // stop word and the restarted turn takes no second restart. Unwired, as the root installs it today, the lease cannot
  // know that, and such a batch restarts the turn once more (the second restart's own tests, below).
  it("a second such text waits for the next turn, which opens with it once the restarted turn commits", async () => {
    await withLease(
      async (run) => {
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
      },
      { downPath: true },
    );
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

  it("an alarm with no lease held puts the lease's entry in step: an entry due now that a wired runTurn left cannot re-arm the alarm in a loop once runTurn is unwired (T-248 security note c)", async () => {
    await withLease(
      async (run) => {
        // What a wired runTurn left behind: a batch the lease took waits, no lease is held, and the lease's entry is due
        // now (a crash came before the next turn opened; then a back-only rollback unwired runTurn).
        await runInDurableObject(stub(), async (_, state) => {
          state.storage.sql.exec(
            "INSERT INTO lease_batches (batch_id, items, turn_id, seen_ms) VALUES (1, '[]', NULL, 0)",
          );
          state.storage.sql.exec(
            "INSERT OR REPLACE INTO batch_schedule (kind, due_ms) VALUES ('turnLease', ?)",
            run.h.clock.now(),
          );
          await state.storage.setAlarm(Date.now());
        });

        expect(await runDurableObjectAlarm(stub())).toBe(true);
        expect(await scheduleOf()).toEqual([]);
        expect(await alarmOf()).toBeNull();
        expect(await runDurableObjectAlarm(stub())).toBe(false);
        expect(await actorOf().readWaitingBatches()).toEqual([1]);
      },
      { turnWired: false },
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

// QUESTIONS.md CQ-65 as DL-119 replaced it (T-1088): once its texts have been read, a batch reaches its turn while a safety
// hold is open; each run of a turn carries the holds open at its start, and the commit hook is handed the holds open at
// commit time. The lease refuses no commit for a hold: T-252's gate will (here the K-05 double commits whatever it is
// sent, so these tests show what the gate is handed, not a gate).
describe("safety holds bind commits, not hand-offs", () => {
  const CRISIS = "I don't want to be alive anymore";
  const STOP_AND_THREAT = "STOP. If Riley messes up my hair again I'll hurt him";
  const crisis = (eventId: string): SafetyResult => ({
    ...(safetyCrisisWords as unknown as SafetyResult),
    eventId,
  });
  const threat = (eventId: string): SafetyResult => ({
    ...(safetyThreat as unknown as SafetyResult),
    eventId,
  });
  /** The open hold the shared core's double records for a crisis-words text (K-09: the hold id it gives, after_safe). */
  const crisisHold = (eventId: string): OpenHold => ({
    eventId,
    holdId: `hold-${eventId}`,
    rule: "after_safe",
    outcomes: ["Crisis words"],
    blocksBooking: false,
  });

  it("a danger text's batch reaches its turn with the hold open: the turn carries the hold, and the commit hook is handed it", async () => {
    await withLease(
      async (run) => {
        await arrive("evt-1", { body: CRISIS });
        await run.settle();

        // Danger closed the batch at once; its text was read, so it went to the lease though the hold is open.
        expect(run.turns.map((turn) => turn.eventIds)).toEqual([["evt-1"]]);
        const turn = present(run.turns[0], "the turn");
        expect(turn.holds).toEqual([crisisHold("evt-1")]);
        expect(await actorOf().readHolds()).toMatchObject([{ eventId: "evt-1", released: false }]);

        expect(await run.commit(turn)).toMatchObject({ result: "committed" });
        expect(run.k05.contexts).toEqual([{ holds: [crisisHold("evt-1")], unread: [] }]);
      },
      { answers: { "evt-1": crisis("evt-1") } },
    );
  });

  it("a STOP inside a threat text reaches its turn, with the threat's hold, which is never released, beside it", async () => {
    await withLease(
      async (run) => {
        await arrive("evt-1", { body: STOP_AND_THREAT });
        await run.settle();

        const turn = present(run.turns[0], "the turn");
        expect(turn.eventIds).toEqual(["evt-1"]);
        // The turn's text is the one with the STOP in it, sealed as the inbox keeps it (the guard reads it: T-251).
        const entry = present(turn.entries[0], "the turn's text");
        const words = await openWords(
          present(entry.event.sealed, "the sealed words"),
          keys.keyOf(entry.event.handle),
          actorNameOf(entry.event.handle),
          entry.event.eventId,
        );
        expect(words.body).toBe(STOP_AND_THREAT);
        const threatHold: OpenHold = {
          eventId: "evt-1",
          holdId: "hold-evt-1",
          rule: "never",
          outcomes: ["A threat to staff or others"],
          blocksBooking: false,
        };
        expect(turn.holds).toEqual([threatHold]);
        expect(await actorOf().markHoldReleased("hold-evt-1")).toBe("neverReleased");

        await run.commit(turn);
        expect(run.k05.contexts).toEqual([{ holds: [threatHold], unread: [] }]);
      },
      { answers: { "evt-1": threat("evt-1") } },
    );
  });

  it("a hold that opens mid-turn binds that commit, and the next turn after the commit carries it", async () => {
    await withLease(
      async (run) => {
        // A turn restarted once (evt-1, then evt-2), with no hold open at its start.
        await arrive("evt-1");
        await run.tick(3000);
        await arrive("evt-2");
        await run.tick(3000);
        await run.settle();
        const restarted = present(run.turns[1], "the restarted turn");
        expect(restarted).toMatchObject({ eventIds: ["evt-1", "evt-2"], restart: true, holds: [] });

        // Mid-turn, evt-3 brings crisis words: its batch closes at once and waits for the next turn (the restart is used).
        await arrive("evt-3", { body: CRISIS });
        await run.settle();
        expect(await actorOf().readWaitingBatches()).toEqual([3]);
        expect(run.turns).toHaveLength(2);

        // The commit is handed the hold open now, not the turn's empty list from its start.
        expect(await run.commit(restarted)).toMatchObject({ result: "committed" });
        expect(run.k05.contexts).toEqual([{ holds: [crisisHold("evt-3")], unread: [] }]);

        // The waiting batch opens the next turn, which carries the hold open then.
        await run.settle();
        expect(run.turns).toHaveLength(3);
        expect(run.turns[2]).toMatchObject({
          eventIds: ["evt-3"],
          restart: false,
          holds: [crisisHold("evt-3")],
        });
      },
      // The down path wired (ADR-018 section 1): the crisis words read as another text, so evt-3's batch takes no second
      // restart and waits, as it did before that rule.
      { answers: { ...ALL_NO, "evt-3": crisis("evt-3") }, downPath: true },
    );
  });

  it("a lapsed turn's rerun carries the holds open at the rerun, not those of its first run", async () => {
    await withLease(
      async (run) => {
        await arrive("evt-1");
        await run.tick(3000);
        await arrive("evt-2");
        await run.tick(3000);
        await run.settle();
        const restarted = present(run.turns[1], "the restarted turn");
        expect(restarted.holds).toEqual([]);

        await arrive("evt-3", { body: CRISIS });
        await run.settle();
        expect(await actorOf().readWaitingBatches()).toEqual([3]);

        // No commit within 60 s: the restarted turn reruns under the same id, with the hold now open.
        await run.tick(LEASE_MS);
        await run.settle();
        const rerun = present(run.turns[2], "the rerun");
        expect(rerun).toMatchObject({ turnId: restarted.turnId, tries: 2, holds: [crisisHold("evt-3")] });

        // Released before the commit (after a clear "we're safe"): the commit is handed no open hold.
        expect(await actorOf().markHoldReleased("hold-evt-3")).toBe("released");
        expect(await run.commit(rerun)).toMatchObject({ result: "committed" });
        expect(run.k05.contexts).toEqual([{ holds: [], unread: [] }]);
      },
      // The down path wired (ADR-018 section 1): evt-3's batch reads as no stop word and waits for the next turn.
      { answers: { ...ALL_NO, "evt-3": crisis("evt-3") }, downPath: true },
    );
  });

  // QUESTIONS.md CQ-65's addendum (DL-127): a text not read yet at commit time counts as an open hold for T-252's gate, so
  // the commit is handed those texts beside the holds.
  it("the commit is handed the texts not read yet beside the holds: being read, never wired, or with no safety row; once a text takes the timeout rule it is among the holds instead", async () => {
    await withLease(
      async (run) => {
        await arrive("evt-1");
        await run.tick(3000);
        await run.settle();
        const turn = present(run.turns[0], "the turn");

        // Mid-turn: evt-2's read never answers (being read); evt-3 comes while no safety read is wired; evt-4's read never
        // starts (the safety clock breaks as it is stored, so it has no safety row; T-247 security note d).
        await arrive("evt-2");
        const restoreUnwired = setSafetyDeps(null);
        try {
          await arrive("evt-3");
        } finally {
          restoreUnwired();
        }
        let broken = true;
        const restoreBroken = setSafetyDeps({
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
          await expect(door().accept(await handoffOf("evt-4"))).rejects.toThrow();
        } finally {
          restoreBroken();
        }

        expect(await run.commit(turn)).toMatchObject({ result: "committed" });
        expect(run.k05.contexts).toEqual([{ holds: [], unread: ["evt-2", "evt-3", "evt-4"] }]);

        // 7 s: evt-2 has had no verdict in 4 s: the outage line and its unread hold. A commit sent again now is handed
        // evt-2 among the holds (rule unread) and the two others as not read yet.
        await run.h.clock.advance(4000);
        await vi.waitFor(async () => {
          expect(await actorOf().readHolds()).toMatchObject([
            { eventId: "evt-2", rule: "unread", released: false },
          ]);
        });
        expect(await run.commit(turn)).toMatchObject({ result: "committed", repeated: true });
        expect(run.k05.contexts[1]).toEqual({
          holds: [{ eventId: "evt-2", holdId: null, rule: "unread", outcomes: [], blocksBooking: false }],
          unread: ["evt-3", "evt-4"],
        });
      },
      { answers: { "evt-1": safetyNo as unknown as SafetyResult } },
    );
  });
});

// ADR-018 section 1 (CQ-230; T-1311): a STOP never waits on a restarted turn. A waiting batch that may hold a stop word
// restarts a turn that has used its one restart a second time, while that turn is leased and not left for the park, so the
// STOP's turn commits on its first run (T-1263), never after the running turn's lapses; the turn so opened is never
// restarted again. The lease asks its host (`stopAmong`); the actor answers from the PostgreSQL-down path's reading of each
// text, and true while that path is unwired, as the composition root installs it today (round 2, DL-570).
describe("a STOP batch restarts a restarted turn once more (ADR-018 section 1)", () => {
  it("with the down path wired and a keyword copy that reads STOP: a turn, its restart by a second batch, then a STOP batch: a third turn opens at once with every text, as a restart; the restarted turn's commit answers replaced, one lease row is held, and the fake clock never reaches the lease's 60 s; a fourth batch, a STOP's or not, then waits for the next turn", async () => {
    await withLease(
      async (run) => {
        const restarted = await restartedOnce(run);
        await arrive("evt-3", { body: "STOP" });
        await run.settle();
        // The actor's copy of bundle v0's keyword list, taken at the first turn's pin, reads it as a STOP.
        expect(await readingOf("evt-3")).toBe("stop");
        await run.tick(3000);
        await run.settle();

        expect(run.turns).toHaveLength(3);
        const third = present(run.turns[2], "the second restart's run");
        expect(third.turnId).toBe(await turnIdOf(["evt-1", "evt-2", "evt-3"]));
        expect(third).toMatchObject({
          eventIds: ["evt-1", "evt-2", "evt-3"],
          restart: true,
          tries: 1,
          leaseUntil: 9000 + LEASE_MS,
        });
        expect(third.entries.map((entry) => entry.event.eventId)).toEqual(["evt-1", "evt-2", "evt-3"]);
        expect(restarted.signal.aborted).toBe(true);
        expect(third.signal.aborted).toBe(false);
        expect(await actorOf().readTurns()).toMatchObject([
          { eventIds: ["evt-1"], state: "replaced", restart: false, leaseUntil: null },
          { turnId: restarted.turnId, state: "replaced", restart: true, leaseUntil: null },
          { turnId: third.turnId, state: "leased", restart: true, tries: 1, leaseUntil: 9000 + LEASE_MS },
        ]);
        expect(await restartsWritten()).toEqual([0, 1, 2]);
        expect(await run.commit(restarted)).toEqual({ error: "replaced" });
        expect(run.k05.calls).toEqual([]);
        expect(await leaseRows()).toBe(1);
        expect(await actorOf().readWaitingBatches()).toEqual([]);
        // At once: 3 s after the STOP, never at the restarted turn's lapse.
        expect(run.h.clock.now()).toBe(9000);
        expect(run.h.clock.now()).toBeLessThan(LEASE_MS);

        // A fourth batch, a STOP's, and a fifth, another text's, wait: the second restart's turn is never restarted.
        await batchOf(run, "evt-4", { body: "STOP" });
        await batchOf(run, "evt-5");
        expect(await readingOf("evt-4")).toBe("stop");
        expect(run.turns).toHaveLength(3);
        expect(await actorOf().readWaitingBatches()).toEqual([4, 5]);

        // Once that turn commits, the waiting batches open the next turn together.
        expect(await run.commit(third)).toMatchObject({ result: "committed", repeated: false });
        await run.settle();
        expect(run.turns).toHaveLength(4);
        expect(run.turns[3]).toMatchObject({ eventIds: ["evt-4", "evt-5"], restart: false, tries: 1 });
        expect(await actorOf().readTurns()).toMatchObject([
          { state: "replaced" },
          { state: "replaced" },
          { turnId: third.turnId, state: "committed" },
          { eventIds: ["evt-4", "evt-5"], state: "leased", restart: false },
        ]);
        expect(await actorOf().readWaitingBatches()).toEqual([]);
        // PostgreSQL answered throughout: the actor took no STOP itself.
        expect(present(run.db, "the down path").direct.sent).toEqual([]);
      },
      { downPath: true },
    );
  });

  it.each([
    ["a START", { body: "START" }, "start"],
    ["HELP", { body: "HELP" }, "other"],
    ["another text", {}, "other"],
    ["a tapback, which has no words to read", { tapback: true }, undefined],
  ] as const)(
    "with the down path wired, after the one restart, a batch read as %s holds no stop word: it waits for the next turn",
    async (_what, text, reading) => {
      await withLease(
        async (run) => {
          const restarted = await restartedOnce(run);
          await batchOf(run, "evt-3", text);
          expect(await readingOf("evt-3")).toBe(reading);
          expect(run.turns).toHaveLength(2);
          expect(await actorOf().readWaitingBatches()).toEqual([3]);
          expect(await restartsWritten()).toEqual([0, 1]);

          expect(await run.commit(restarted)).toMatchObject({ result: "committed" });
          await run.settle();
          expect(run.turns).toHaveLength(3);
          expect(run.turns[2]).toMatchObject({ eventIds: ["evt-3"], restart: false, tries: 1 });
        },
        { downPath: true },
      );
    },
  );

  it.each([
    ["a text read as unknown (its words could not be opened: the key store failed)", "unknown"],
    ["a readable text with no reading (its arrive write threw: the path has no row for it)", "noRow"],
    ["a text whose reading throws", "throws"],
  ] as const)(
    "with the down path wired, after the one restart, a batch with %s may hold a stop word: it restarts the turn a second time",
    async (_what, fault) => {
      await withLease(
        async (run) => {
          const db = present(run.db, "the down path");
          const restarted = await restartedOnce(run);
          if (fault === "unknown") db.keyReads.push(false);
          if (fault === "noRow") {
            await exec(
              "CREATE TRIGGER refuse_outage_text BEFORE INSERT ON outage_texts BEGIN SELECT RAISE(ABORT, 'the storage refused'); END",
            );
          }
          await arrive("evt-3");
          await run.settle();
          if (fault === "throws") {
            expect(await readingOf("evt-3")).toBe("other");
            // The stored reading can no longer be read.
            await exec("ALTER TABLE outage_texts RENAME TO outage_texts_moved");
          } else {
            expect(await readingOf("evt-3")).toBe(fault === "unknown" ? "unknown" : undefined);
          }
          await run.tick(3000);
          await run.settle();

          expect(run.turns).toHaveLength(3);
          expect(run.turns[2]).toMatchObject({
            eventIds: ["evt-1", "evt-2", "evt-3"],
            restart: true,
            tries: 1,
          });
          expect(restarted.signal.aborted).toBe(true);
          expect(await actorOf().readTurns()).toMatchObject([
            { state: "replaced" },
            { turnId: restarted.turnId, state: "replaced" },
            { eventIds: ["evt-1", "evt-2", "evt-3"], state: "leased", restart: true },
          ]);
          expect(await restartsWritten()).toEqual([0, 1, 2]);
        },
        { downPath: true },
      );
    },
  );

  it("the actor's lease host answers from the down path's reading of each text whose words are read: true for a STOP, unknown, a text with no reading or one it cannot find; false for a START, HELP, another text or a tapback alone; and true for any batch while the path is unwired", async () => {
    await withLease(
      async (run) => {
        const db = present(run.db, "the down path");
        // Read before any pin, evt-1 reads unknown (no keyword list copied yet); its turn's pin copies bundle v0's list.
        await batchOf(run, "evt-1");
        await arrive("evt-2", { body: "STOP" });
        await arrive("evt-3", { body: "START" });
        await arrive("evt-4", { body: "HELP" });
        await arrive("evt-5");
        await arrive("evt-6", { tapback: true });
        await run.settle();
        db.keyReads.push(false);
        await arrive("evt-7");
        await run.settle();
        await exec(
          "CREATE TRIGGER refuse_outage_text BEFORE INSERT ON outage_texts BEGIN SELECT RAISE(ABORT, 'the storage refused'); END",
        );
        await arrive("evt-8");
        await run.settle();
        expect((await actorOf().readOutage()).texts.map((text) => [text.eventId, text.kind])).toEqual([
          ["evt-1", "unknown"],
          ["evt-2", "stop"],
          ["evt-3", "start"],
          ["evt-4", "other"],
          ["evt-5", "other"],
          ["evt-7", "unknown"],
        ]);

        expect(await stopAmong(["evt-2"])).toBe(true);
        expect(await stopAmong(["evt-1"])).toBe(true);
        expect(await stopAmong(["evt-7"])).toBe(true);
        expect(await stopAmong(["evt-8"])).toBe(true);
        expect(await stopAmong(["evt-nowhere"])).toBe(true);
        expect(await stopAmong(["evt-3", "evt-4", "evt-5", "evt-6", "evt-2"])).toBe(true);
        expect(await stopAmong(["evt-3"])).toBe(false);
        expect(await stopAmong(["evt-4"])).toBe(false);
        expect(await stopAmong(["evt-5"])).toBe(false);
        expect(await stopAmong(["evt-6"])).toBe(false);
        expect(await stopAmong(["evt-3", "evt-4", "evt-5", "evt-6"])).toBe(false);

        // Unwired, the path reads nothing: any batch may hold a stop word.
        const restore = setDbOutageDeps(null);
        try {
          expect(await stopAmong(["evt-5"])).toBe(true);
          expect(await stopAmong(["evt-6"])).toBe(true);
          expect(await stopAmong(["evt-3", "evt-4"])).toBe(true);
        } finally {
          restore();
        }
      },
      { downPath: true },
    );
  });

  it("the lease reads a host without stopAmong as no stop word, so a host built before this rule keeps the one restart: after it, a STOP batch waits", async () => {
    await withLease(
      async (run) => {
        await restartedOnce(run);
        await runInDurableObject(stub(), (instance) => {
          delete leaseHostIn(instance).stopAmong;
        });
        await batchOf(run, "evt-3", { body: "STOP" });
        expect(await readingOf("evt-3")).toBe("stop");
        expect(run.turns).toHaveLength(2);
        expect(await actorOf().readWaitingBatches()).toEqual([3]);
        expect(await restartsWritten()).toEqual([0, 1]);
      },
      { downPath: true },
    );
  });

  it("the lease reads a host whose stopAmong throws as a stop word: after the one restart, a batch read as another text restarts the turn a second time", async () => {
    await withLease(
      async (run) => {
        await restartedOnce(run);
        await runInDurableObject(stub(), (instance) => {
          leaseHostIn(instance).stopAmong = () => {
            throw new Error("the storage failed");
          };
        });
        await batchOf(run, "evt-3");
        expect(await readingOf("evt-3")).toBe("other");
        expect(run.turns).toHaveLength(3);
        expect(run.turns[2]).toMatchObject({
          eventIds: ["evt-1", "evt-2", "evt-3"],
          restart: true,
          tries: 1,
        });
        expect(await restartsWritten()).toEqual([0, 1, 2]);
      },
      { downPath: true },
    );
  });

  it("with the down path not wired, as the root installs it today: a turn, its restart by a second batch, then a third batch holding no stop word: a third turn opens at once with every text, as a restart; a fourth batch, a STOP's or not, waits for the next turn, which opens once that third turn commits", async () => {
    await withLease(async (run) => {
      const restarted = await restartedOnce(run);
      await batchOf(run, "evt-3");

      expect(run.turns).toHaveLength(3);
      const third = present(run.turns[2], "the second restart's run");
      expect(third.turnId).toBe(await turnIdOf(["evt-1", "evt-2", "evt-3"]));
      expect(third).toMatchObject({
        eventIds: ["evt-1", "evt-2", "evt-3"],
        restart: true,
        tries: 1,
        leaseUntil: 9000 + LEASE_MS,
      });
      expect(restarted.signal.aborted).toBe(true);
      expect(await actorOf().readTurns()).toMatchObject([
        { eventIds: ["evt-1"], state: "replaced" },
        { turnId: restarted.turnId, state: "replaced", restart: true },
        { turnId: third.turnId, state: "leased", restart: true, tries: 1 },
      ]);
      expect(await restartsWritten()).toEqual([0, 1, 2]);
      expect(await run.commit(restarted)).toEqual({ error: "replaced" });
      expect(await leaseRows()).toBe(1);

      await batchOf(run, "evt-4", { body: "STOP" });
      await batchOf(run, "evt-5");
      expect(run.turns).toHaveLength(3);
      expect(await actorOf().readWaitingBatches()).toEqual([4, 5]);

      expect(await run.commit(third)).toMatchObject({ result: "committed", repeated: false });
      await run.settle();
      expect(run.turns).toHaveLength(4);
      expect(run.turns[3]).toMatchObject({ eventIds: ["evt-4", "evt-5"], restart: false, tries: 1 });
      expect(await actorOf().readTurns()).toMatchObject([
        { state: "replaced" },
        { state: "replaced" },
        { turnId: third.turnId, state: "committed" },
        { eventIds: ["evt-4", "evt-5"], state: "leased", restart: false },
      ]);
      expect(await actorOf().readWaitingBatches()).toEqual([]);
    });
  });

  it("with the down path not wired: when the turn the second restart opened never commits, the batches waiting behind it, a STOP's among them, open the next turn once it parks at its third lapse", async () => {
    const parked: string[] = [];
    await withLease(
      async (run) => {
        await restartedOnce(run);
        await batchOf(run, "evt-3");
        const third = present(run.turns[2], "the second restart's run");
        expect(third).toMatchObject({ eventIds: ["evt-1", "evt-2", "evt-3"], restart: true, tries: 1 });
        await batchOf(run, "evt-4", { body: "STOP" });
        expect(await actorOf().readWaitingBatches()).toEqual([4]);

        // Its runs never commit: two lapses rerun it under its own id, and the STOP's batch still waits.
        await run.tick(LEASE_MS);
        await run.settle();
        await run.tick(LEASE_MS);
        await run.settle();
        expect(run.turns.slice(2).map((turn) => [turn.turnId, turn.tries])).toEqual([
          [third.turnId, 1],
          [third.turnId, 2],
          [third.turnId, 3],
        ]);
        expect(await actorOf().readWaitingBatches()).toEqual([4]);

        // Its third lapse parks it; the waiting batch then opens the next turn.
        await run.tick(LEASE_MS);
        await run.settle();
        expect(parked).toEqual([third.turnId]);
        expect(run.turns).toHaveLength(6);
        expect(run.turns[5]).toMatchObject({ eventIds: ["evt-4"], restart: false, tries: 1 });
        expect(await actorOf().readTurns()).toMatchObject([
          { state: "replaced" },
          { state: "replaced" },
          { turnId: third.turnId, state: "parked", tries: 3, leaseUntil: null },
          { eventIds: ["evt-4"], state: "leased", restart: false },
        ]);
        expect(await actorOf().readWaitingBatches()).toEqual([]);
      },
      {
        park: (turn) => {
          parked.push(turn.turnId);
          return Promise.resolve<ParkAnswer>({
            result: "parked",
            parkedAt: "2026-11-07T15:16:00Z",
            repeated: false,
          });
        },
      },
    );
  });

  describe("a STOP batch waits as today behind a turn it cannot restart (the down path wired, its copy reading STOP)", () => {
    it("behind a restarted turn that has begun its commit, which may have gone through", async () => {
      await withLease(
        async (run) => {
          const restarted = await restartedOnce(run);
          run.k05.loseNextAnswer = true;
          expect(await run.commit(restarted)).toEqual({ error: "noAnswer" });

          await batchOf(run, "evt-3", { body: "STOP" });
          expect(await readingOf("evt-3")).toBe("stop");
          expect(run.turns).toHaveLength(2);
          expect(await actorOf().readWaitingBatches()).toEqual([3]);
          expect(await actorOf().readTurns()).toMatchObject([
            { state: "replaced" },
            { turnId: restarted.turnId, state: "committing" },
          ]);

          // Sent again, the commit answers repeated, and the STOP's batch opens the next turn.
          expect(await run.commit(restarted)).toMatchObject({ result: "committed", repeated: true });
          await run.settle();
          expect(run.turns[2]).toMatchObject({ eventIds: ["evt-3"], restart: false, tries: 1 });
        },
        { downPath: true },
      );
    });

    it("behind a restarted turn that holds its lease for its reply", async () => {
      await withLease(
        async (run) => {
          const restarted = await restartedOnce(run);
          expect(
            await runInDurableObject(stub(), () => restarted.commit(requestFor(restarted), { reply: true })),
          ).toMatchObject({ result: "committed" });

          await batchOf(run, "evt-3", { body: "STOP" });
          expect(run.turns).toHaveLength(2);
          expect(await actorOf().readWaitingBatches()).toEqual([3]);
          expect(await actorOf().readTurns()).toMatchObject([
            { state: "replaced" },
            { turnId: restarted.turnId, state: "committed", leaseUntil: 6000 + LEASE_MS },
          ]);

          // Its reply ends: the STOP's batch opens the next turn.
          await runInDurableObject(stub(), () => restarted.replied());
          await run.settle();
          expect(run.turns[2]).toMatchObject({ eventIds: ["evt-3"], restart: false, tries: 1 });
        },
        { downPath: true },
      );
    });

    it("behind a restarted turn that is being parked", async () => {
      const parks: string[] = [];
      await withLease(
        async (run) => {
          const restarted = await restartedOnce(run);
          // Three lapses with no commit: the third begins the park, which K-05 cannot take at first (transient).
          for (let lapse = 0; lapse < 3; lapse += 1) {
            await run.tick(LEASE_MS);
            await run.settle();
          }
          expect(parks).toEqual([restarted.turnId]);
          expect(await actorOf().readTurns()).toMatchObject([
            { state: "replaced" },
            { turnId: restarted.turnId, state: "parking", tries: 3 },
          ]);

          await batchOf(run, "evt-3", { body: "STOP" });
          expect(run.turns).toHaveLength(4);
          expect(await actorOf().readWaitingBatches()).toEqual([3]);

          // The park, tried again 30 s after its first try, goes through: the STOP's batch opens the next turn.
          await run.tick(PARK_RETRY_MS - 3000);
          await run.settle();
          expect(parks).toEqual([restarted.turnId, restarted.turnId]);
          expect(run.turns).toHaveLength(5);
          expect(run.turns[4]).toMatchObject({ eventIds: ["evt-3"], restart: false, tries: 1 });
        },
        {
          downPath: true,
          park: (turn) => {
            parks.push(turn.turnId);
            return Promise.resolve<ParkAnswer>(
              parks.length === 1
                ? { error: "transient" }
                : { result: "parked", parkedAt: "2026-11-07T15:16:00Z", repeated: false },
            );
          },
        },
      );
    });

    it("behind a restarted turn past its third lapse, left for the park (none wired)", async () => {
      await withLease(
        async (run) => {
          const restarted = await restartedOnce(run);
          for (let lapse = 0; lapse < 3; lapse += 1) {
            await run.tick(LEASE_MS);
            await run.settle();
          }
          expect(run.turns.map((turn) => turn.tries)).toEqual([1, 1, 2, 3]);
          expect(await actorOf().readTurns()).toMatchObject([
            { state: "replaced" },
            { turnId: restarted.turnId, state: "leased", tries: 3 },
          ]);

          await batchOf(run, "evt-3", { body: "STOP" });
          expect(await readingOf("evt-3")).toBe("stop");
          expect(run.turns).toHaveLength(4);
          expect(await actorOf().readWaitingBatches()).toEqual([3]);
          expect(await restartsWritten()).toEqual([0, 1]);
        },
        { downPath: true },
      );
    });

    it("while PostgreSQL is known down: no batch restarts the turn; the actor takes the STOP itself at once, and its batch stays with the batch window", async () => {
      await withLease(
        async (run) => {
          const db = present(run.db, "the down path");
          // A first turn pins bundle v0 (the actor copies its keyword list) and commits, so every later text is read.
          await batchOf(run, "evt-1");
          expect(await run.commit(present(run.turns[0], "the first turn"))).toMatchObject({
            result: "committed",
          });
          // A turn, and its one restart.
          await batchOf(run, "evt-2");
          await batchOf(run, "evt-3");
          const restarted = present(run.turns[2], "the restarted turn");
          expect(restarted).toMatchObject({ eventIds: ["evt-2", "evt-3"], restart: true, tries: 1 });
          db.down = true;

          await batchOf(run, "evt-4", { body: "STOP" });
          // Asked for the STOP, PostgreSQL does not answer: the actor took it (its reply straight through Linq, past the
          // opt-out; its record queued for the return), and no turn opened or restarted.
          expect((await actorOf().readOutage()).down).not.toBeNull();
          expect((await actorOf().readOutage()).texts.find((text) => text.eventId === "evt-4")).toMatchObject(
            {
              kind: "stop",
              keyword: "handled",
            },
          );
          expect(db.direct.sent.map((sent) => sent.idempotencyKey)).toEqual(["keyword:evt-4:stopReply"]);
          expect(run.turns).toHaveLength(3);
          expect(await actorOf().readTurns()).toMatchObject([
            { state: "committed" },
            { state: "replaced" },
            { turnId: restarted.turnId, state: "leased", restart: true },
          ]);
          expect(await restartsWritten()).toEqual([0, 0, 1]);
          expect(await actorOf().readWaitingBatches()).toEqual([]);
          expect(await actorOf().readBatches()).toMatchObject([
            { batchId: 1, handed: true },
            { batchId: 2, handed: true },
            { batchId: 3, handed: true },
            { batchId: 4, handed: false },
          ]);
        },
        { downPath: true },
      );
    });
  });
});
