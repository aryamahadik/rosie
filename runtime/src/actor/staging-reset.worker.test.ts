// T-1452: the staging-only reset of a listed test handle's actor (./staging-reset.ts; DL-944 card A; ADR-017 sections 1, 5
// and 7), inside the Workers runtime, on the real HandleActor reached through the gateway's door. The safety read, the
// shared core, the Linq send and the clock are ../safety/test-support's doubles: the core is down and the direct line
// fails, so a danger the read finds has no path (its line fails, its hold has no core id, its re-read comes every 30 s),
// as on staging, where turnFace and linqDirect are closed (DL-944). Each turn commits through the actor's own lease to a
// K-05 double (commit-first.json), so the danger's turn ends, as the two held handles' turns did. The reset's hook is a
// test's own, targeting one actor by its name; staging's list and its wiring are ../wiring/staging/actor-reset's tests.
//
//   - A stuck target clears: no re-read is due and no alarm is set, no hold is open and no text is unread; only the
//     survivors are left (the whole-storage scan names every table: ADR-017 section 7); one log line of labels and
//     counts; the next hand-off writes the actor's name again and is read as on a new actor.
//   - An entry applies once; an actor no entry targets is untouched.
//   - Staging only: with ENVIRONMENT production, test or any other value, nothing is read or deleted.
//   - Each reason to wait defers it, logged at each try with nothing deleted: a live lease, a read out, a text waiting, a
//     PostgreSQL known down, a stop-rank write waiting.
//   - A STOP survives: the stopped copy still reads stopped, and the stop rank's refused write and held row stay.
//   - A table no rule names refuses it, with nothing deleted.
// No model call and no network. Test values only (rule 9): K-06's text-imessage.json form, K-02's safety fixtures, whole
// fiction-range numbers (555-01xx) and made-up ids.
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

import commitFirst from "../../../contracts/data-access/fixtures/commit-first.json";
import textImessage from "../../../contracts/inbound-event/fixtures/text-imessage.json";
import safetyEmergencyNow from "../../../contracts/model/fixtures/safety-emergency-now.json";
import safetyNo from "../../../contracts/model/fixtures/safety-no.json";
import { fakeBundles } from "../bundle/test-support";
import {
  durableObjectActor,
  prepareHandoff,
  type ActorNamespace,
  type HandleActorRpc,
  type InboundEvent,
} from "../gateway";
import { fakeKeyStore } from "../gateway/test-support";
import type { OpenHold, SafetyOnArrival } from "../safety/arrival";
import { harness, type Harness } from "../safety/test-support";
import type { SafetyDeps, SafetyReadAnswer, SafetyResult } from "../safety/types";
import type { ActorCopies } from "./copies/copies";
import type { ReturnQueue } from "./copies/return-queue";
import {
  QUIET_MS,
  setBatchHooks,
  setBundleDeps,
  setLeaseHooks,
  setSafetyDeps,
  type CommitOptions,
  type CommitTurnAnswer,
  type CommitTurnRequest,
  type CopiesView,
  type HandleActor,
  type HoldEntry,
  type LeasedTurn,
  type SafetyEntry,
  type TurnEntry,
} from "./index";
import {
  EMPTIED_TABLES,
  KEPT_TABLES,
  RESET_MARKER,
  runStagingReset,
  setStagingReset,
  TRIMMED_TABLES,
  type StagingResetHook,
} from "./staging-reset";

type Json = Record<string, unknown>;

const BUNDLE = { hash: "a".repeat(64), build: 1 };
const TRACE = "14521452-2222-4333-8444-555555555555";
/** The target's number and actor name (K-06 text-imessage.json's handle). */
const ALEX_NUMBER = "+15555550101";
const ALEX = `phone:${ALEX_NUMBER}`;
/** An actor no entry targets. */
const BLAKE_NUMBER = "+15555550102";
const BLAKE = `phone:${BLAKE_NUMBER}`;
/** The test's one entry, and the target its log line names (a label, never the number). */
const ENTRY = "t1452-test-1";
const TARGET = "tp-03";

const EMERGENCY_TEXT = "my lips are swelling after the beard color and I can't breathe well";
const PLAIN_TEXT = "Can I get a haircut on Thursday afternoon?";

/** How long a step of the actor's own work may take under load (a resource guard, not part of any claim). */
const TEST_MS = 30_000;

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

function stubOf(actorName: string): DurableObjectStub<HandleActor> {
  return namespace().get(namespace().idFromName(actorName));
}

/** The actor's calls over RPC, typed here (the stub's own type cannot carry the sealed event's open shape). */
interface ActorRpc {
  readSafety(): Promise<SafetyEntry[]>;
  readHolds(): Promise<HoldEntry[]>;
  readInbox(): Promise<{ seq: number; event: { eventId: string } }[]>;
  readTurns(): Promise<TurnEntry[]>;
  readCopies(): Promise<CopiesView>;
  routineHeld(): Promise<boolean>;
  mayHaveStoppedNow(): Promise<boolean>;
  safetyIdle(): Promise<void>;
  batchIdle(): Promise<void>;
}

function actorOf(actorName: string): ActorRpc {
  return stubOf(actorName);
}

/** The actor's own safety read, its copies and its write-on-return queue, reached inside the actor. */
function safetyOf(instance: HandleActor): SafetyOnArrival {
  return (instance as unknown as { safety: SafetyOnArrival }).safety;
}

function copiesOf(instance: HandleActor): ActorCopies {
  return (instance as unknown as { copies: ActorCopies }).copies;
}

function returnsOf(instance: HandleActor): ReturnQueue {
  return (instance as unknown as { returns: ReturnQueue }).returns;
}

const asResult = (fixture: unknown): SafetyResult => fixture as SafetyResult;
const emergency = (eventId: string): SafetyResult => ({ ...asResult(safetyEmergencyNow), eventId });
const no = (eventId: string): SafetyResult => ({ ...asResult(safetyNo), eventId });

/** A text from `number`, as the gateway hands it on: K-06 text-imessage.json's form under a made-up event id. */
async function arrive(number: string, eventId: string, body: string): Promise<void> {
  const overrides: Json = { eventId, body, handle: { kind: "phone", address: number } };
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

async function settle(actorName: string): Promise<void> {
  await actorOf(actorName).safetyIdle();
  await actorOf(actorName).batchIdle();
}

/** This run of the turn's commit request (commit-first.json, named for the turn). */
function requestOf(turn: LeasedTurn): CommitTurnRequest {
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

/** Each turn's work: commit through the lease at once (with `options`), as the turn loop does, keeping each run. */
function commitHooks(turns: LeasedTurn[], options?: CommitOptions): Parameters<typeof setLeaseHooks>[0] {
  const first = commitFirst.outcome as unknown as CommitTurnAnswer;
  return {
    runTurn: async (turn) => {
      turns.push(turn);
      await turn.commit(requestOf(turn), options);
    },
    commit: (request) => Promise.resolve({ ...first, turnId: request.turn.id }),
  };
}

interface Run {
  readonly h: Harness;
  /** The safety doubles in place: the harness's, with a 4 s deadline that holds no timer. */
  readonly deps: SafetyDeps;
  readonly turns: LeasedTurn[];
  readonly restore: () => void;
}

/**
 * The doubles for one test: the read answers `answers` at once (a text with no answer is never answered); the core is
 * down and the direct line fails, so a danger has no path; each turn commits at once with no reply; bundle A is pinned.
 */
function setUp(answers: Record<string, SafetyResult>): Run {
  const h = harness(keys, answers);
  h.core.down = true;
  h.direct.fail = true;
  const deps: SafetyDeps = {
    ...h.deps,
    clock: { now: () => h.clock.now(), after: () => new Promise<void>(() => undefined) },
  };
  const turns: LeasedTurn[] = [];
  const restores = [
    setSafetyDeps(deps),
    setBatchHooks({ clock: h.clock }),
    setBundleDeps(fakeBundles().deps),
    setLeaseHooks(commitHooks(turns)),
  ];
  return {
    h,
    deps,
    turns,
    restore: () => {
      for (const restore of restores.reverse()) restore();
    },
  };
}

/** A hook whose one entry targets the actors of these names; each name it is asked about is kept. */
function hookFor(...targets: string[]): StagingResetHook & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    matches(actorName) {
      asked.push(actorName);
      return targets.includes(actorName) ? [{ entry: ENTRY, target: TARGET }] : [];
    },
  };
}

/**
 * A danger text that ends stuck, as the two held handles did: its read finds an emergency, its line has no path (the
 * core down, the direct line failing), its after_safe hold has no core id and its re-read is 30 s on; its turn commits
 * and ends. Checked here.
 */
async function stick(run: Run, number: string, eventId: string): Promise<void> {
  const actorName = `phone:${number}`;
  await arrive(number, eventId, EMERGENCY_TEXT);
  await settle(actorName);
  const actor = actorOf(actorName);
  expect((await actor.readSafety()).find((entry) => entry.eventId === eventId)).toMatchObject({
    state: "lineFailed",
    danger: true,
    path: "none",
  });
  expect((await actor.readHolds()).find((hold) => hold.eventId === eventId)).toEqual({
    eventId,
    holdId: null,
    rule: "after_safe",
    blocksBooking: true,
    released: false,
  });
  expect((await actor.readTurns()).at(-1)).toMatchObject({ state: "committed", leaseUntil: null });
  expect(await scheduleOf(actorName)).toContainEqual({
    kind: "safetyRead",
    due_ms: run.h.clock.now() + 30_000,
  });
  expect(await actor.routineHeld()).toBe(true);
}

/** The actor's stored schedule, earliest first. */
function scheduleOf(actorName: string): Promise<{ kind: string; due_ms: number }[]> {
  return runInDurableObject(stubOf(actorName), (_, state) =>
    state.storage.sql
      .exec<{ kind: string; due_ms: number }>("SELECT kind, due_ms FROM batch_schedule ORDER BY due_ms, kind")
      .toArray(),
  );
}

function alarmOf(actorName: string): Promise<number | null> {
  return runInDurableObject(stubOf(actorName), (_, state) => state.storage.getAlarm());
}

/** The holds a commit is handed and the texts it counts as unread, as the actor's own safety read answers them now. */
function heldOf(actorName: string): Promise<{ holds: OpenHold[]; unread: string[] }> {
  return runInDurableObject(stubOf(actorName), (instance) => ({
    holds: safetyOf(instance).openHolds(),
    unread: safetyOf(instance).unreadTexts(),
  }));
}

/** Every table of the actor's storage (sqlite_master, the sqlite_ and _cf_ names left out), each row as JSON. */
function scanOf(actorName: string): Promise<Record<string, string[]>> {
  return runInDurableObject(stubOf(actorName), (_, state) => {
    const { sql } = state.storage;
    const scan: Record<string, string[]> = {};
    const tables = sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .toArray()
      .map((row) => row.name)
      .filter((name) => !name.startsWith("sqlite_") && !name.startsWith("_cf_"));
    for (const table of tables) {
      scan[table] = sql
        .exec(`SELECT * FROM "${table}"`)
        .toArray()
        .map((row) => JSON.stringify(row));
    }
    return scan;
  });
}

/** The sqlite_sequence rows: each AUTOINCREMENT table's highest id. */
function sequenceOf(actorName: string): Promise<string[]> {
  return runInDurableObject(stubOf(actorName), (_, state) =>
    state.storage.sql
      .exec("SELECT name, seq FROM sqlite_sequence ORDER BY name")
      .toArray()
      .map((row) => JSON.stringify(row)),
  );
}

/** The reset's log lines, as written. */
function resetLines(log: MockInstance): Json[] {
  return log.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((line) => line.includes('"msg":"actorReset"'))
    .map((line) => JSON.parse(line) as Json);
}

/** The reset's log lines as text, for what they must never hold. */
function resetText(log: MockInstance): string {
  return resetLines(log)
    .map((line) => JSON.stringify(line))
    .join("\n");
}

/** Runs the actor's alarm now, as the platform runs it at its stored time, then lets its lent work end. */
async function wake(actorName: string): Promise<void> {
  expect(await runDurableObjectAlarm(stubOf(actorName))).toBe(true);
  await settle(actorName);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("a stuck target clears (DL-944 card A)", () => {
  it(
    "a target holding a pending danger with no path, its after_safe hold with no id and its 30 s re-read is cleared at that alarm: no re-read due, no alarm set, no hold open and no text unread; only the survivors are left; one log line of labels and counts; the next hand-off writes the name again",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = setUp({ "evt-t1452-a1": emergency("evt-t1452-a1"), "evt-t1452-a2": no("evt-t1452-a2") });
      const restores: (() => void)[] = [];
      try {
        // Stuck before the deploy that sets the hook, as the two held handles are.
        await stick(run, ALEX_NUMBER, "evt-t1452-a1");
        expect((await heldOf(ALEX)).holds.map((hold) => [hold.eventId, hold.rule, hold.holdId])).toEqual([
          ["evt-t1452-a1", "after_safe", null],
        ]);
        const before = await scanOf(ALEX);
        const sequence = await sequenceOf(ALEX);
        restores.push(setStagingReset(hookFor(ALEX)));
        expect(resetLines(log)).toEqual([]);

        // Its 30 s re-read's alarm: the reset runs first.
        await run.h.clock.advance(30_000);
        await wake(ALEX);

        const actor = actorOf(ALEX);
        expect(await actor.readSafety()).toEqual([]);
        expect(await actor.readHolds()).toEqual([]);
        expect(await actor.readInbox()).toEqual([]);
        expect(await actor.routineHeld()).toBe(false);
        expect(await heldOf(ALEX)).toEqual({ holds: [], unread: [] });
        expect(await scheduleOf(ALEX)).toEqual([]);
        expect(await alarmOf(ALEX)).toBeNull();
        // No re-read was sent: the text was gone before the alarm's safety work ran.
        expect(run.h.read.requests.map((request) => request.eventId)).toEqual(["evt-t1452-a1"]);

        // The whole storage (ADR-017 section 7): every table named by a rule; the survivors as they were, the rest empty.
        const after = await scanOf(ALEX);
        const named = [...KEPT_TABLES, ...TRIMMED_TABLES, ...EMPTIED_TABLES];
        expect(new Set(named).size).toBe(named.length);
        expect(Object.keys(after).filter((table) => !named.includes(table))).toEqual([]);
        expect(Object.keys(before).filter((table) => !named.includes(table))).toEqual([]);
        for (const table of EMPTIED_TABLES) expect(after[table] ?? [], table).toEqual([]);
        // The stored schedule is kept, and its owners keep it (above: nothing is left, so no entry).
        for (const table of KEPT_TABLES.filter(
          (name) => name !== RESET_MARKER && name !== "batch_schedule",
        )) {
          expect(after[table], table).toEqual(before[table]);
        }
        expect(after[RESET_MARKER]?.map((row) => (JSON.parse(row) as Json).entry_id)).toEqual([ENTRY]);
        // The newest lease_turns row, its items emptied (DL-427): the lease's turn order goes on from it.
        expect(after.lease_turns?.map((row) => (JSON.parse(row) as Json).items)).toEqual(["[]"]);
        expect(after.return_queue).toEqual([]);
        expect(after.return_held).toEqual([]);
        expect(await sequenceOf(ALEX)).toEqual(sequence);
        // Nothing of the text or the handle is left: no event id, no address.
        const stored = JSON.stringify(after);
        expect(stored).not.toContain("evt-t1452-a1");
        expect(stored).not.toContain(ALEX_NUMBER);

        // One log line, labels and counts only: never a number, a word or an address.
        expect(resetLines(log)).toEqual([
          {
            level: "info",
            msg: "actorReset",
            outcome: "applied",
            entries: [ENTRY],
            targets: [TARGET],
            removed: {
              texts: 1,
              holds: 1,
              openHolds: 1,
              rows: expect.any(Number) as unknown,
              tables: expect.any(Number) as unknown,
            },
            environment: "staging",
            version: expect.any(String) as unknown,
          },
        ]);
        expect(resetText(log)).not.toContain(ALEX_NUMBER);
        expect(resetText(log)).not.toContain("5555550101");
        expect(resetText(log)).not.toContain("swelling");

        // The next hand-off: the safety read writes the actor's name again and reads the text as on a new actor.
        await arrive(ALEX_NUMBER, "evt-t1452-a2", PLAIN_TEXT);
        await settle(ALEX);
        expect(await actor.readSafety()).toEqual([
          expect.objectContaining({ eventId: "evt-t1452-a2", state: "done", danger: false }),
        ]);
        expect((await scanOf(ALEX)).safety_meta).toEqual([JSON.stringify({ k: "actorName", v: ALEX })]);
        expect((await actor.readInbox()).map((entry) => entry.seq)).toEqual([2]);
        expect(resetLines(log).filter((line) => line.outcome === "applied")).toHaveLength(1);
      } finally {
        for (const restore of restores.reverse()) restore();
        run.restore();
      }
    },
  );

  it(
    "a target's first hand-off on a fresh actor applies its entry with nothing to delete, so a later stuck danger of that actor is never reset by it",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = setUp({ "evt-t1452-a3": emergency("evt-t1452-a3") });
      const restores = [setStagingReset(hookFor(ALEX))];
      try {
        await stick(run, ALEX_NUMBER, "evt-t1452-a3");
        await run.h.clock.advance(30_000);
        await wake(ALEX);

        expect(resetLines(log)).toEqual([
          expect.objectContaining({
            outcome: "applied",
            entries: [ENTRY],
            removed: { texts: 0, holds: 0, openHolds: 0, rows: 0, tables: 0 },
          }),
        ]);
        expect((await actorOf(ALEX).readHolds()).map((hold) => hold.eventId)).toEqual(["evt-t1452-a3"]);
      } finally {
        for (const restore of restores.reverse()) restore();
        run.restore();
      }
    },
  );
});

describe("once, and only on targets", () => {
  it(
    "an entry applies once: a danger stuck after it stays as it is; an actor no entry targets is untouched, with no marker and no line",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = setUp({
        "evt-t1452-b1": emergency("evt-t1452-b1"),
        "evt-t1452-b2": emergency("evt-t1452-b2"),
        "evt-t1452-b3": emergency("evt-t1452-b3"),
      });
      const hook = hookFor(ALEX);
      const restores: (() => void)[] = [];
      try {
        await stick(run, ALEX_NUMBER, "evt-t1452-b1");
        restores.push(setStagingReset(hook));
        await run.h.clock.advance(30_000);
        await wake(ALEX);
        expect(await actorOf(ALEX).readHolds()).toEqual([]);

        // Stuck again after the entry was applied: the next alarms leave it as it is.
        await stick(run, ALEX_NUMBER, "evt-t1452-b2");
        await run.h.clock.advance(30_000);
        await wake(ALEX);
        expect((await actorOf(ALEX).readHolds()).map((hold) => hold.eventId)).toEqual(["evt-t1452-b2"]);
        expect((await scanOf(ALEX))[RESET_MARKER]).toHaveLength(1);
        expect(resetLines(log).map((line) => line.outcome)).toEqual(["applied"]);

        // An actor no entry targets: asked about, and untouched.
        await stick(run, BLAKE_NUMBER, "evt-t1452-b3");
        const before = await scanOf(BLAKE);
        await wake(BLAKE);
        const after = await scanOf(BLAKE);
        expect(after).toEqual(before);
        expect(after[RESET_MARKER]).toBeUndefined();
        expect(hook.asked).toContain(BLAKE);
        expect(resetLines(log).map((line) => line.outcome)).toEqual(["applied"]);
      } finally {
        for (const restore of restores.reverse()) restore();
        run.restore();
      }
    },
  );
});

describe("staging only", () => {
  it(
    "with ENVIRONMENT production, test or any value but staging, nothing is read or deleted: the hook is never asked and no line is written",
    { timeout: TEST_MS },
    async () => {
      const run = setUp({ "evt-t1452-c1": emergency("evt-t1452-c1") });
      const hook = hookFor(ALEX);
      let restoreHook = (): void => undefined;
      try {
        await stick(run, ALEX_NUMBER, "evt-t1452-c1");
        restoreHook = setStagingReset(hook);
        const before = await scanOf(ALEX);
        const lines: string[] = [];
        for (const environment of ["production", "test", "Staging", "", undefined]) {
          // On the actor's own storage: nothing changes.
          const outcome = await runInDurableObject(stubOf(ALEX), (instance, state) =>
            runStagingReset({
              storage: state.storage,
              env: { ENVIRONMENT: environment, GIT_SHA: "test-sha" },
              handedName: ALEX,
              safety: safetyOf(instance),
              pending: () => [],
              log: (line) => lines.push(line),
            }),
          );
          expect(outcome, String(environment)).toBe("none");
          // On a storage that fails at any touch: nothing is read.
          let touched = 0;
          const untouchable = new Proxy(
            {},
            {
              get() {
                touched += 1;
                throw new Error("the reset read the storage");
              },
            },
          ) as unknown as DurableObjectStorage;
          const pending = vi.fn(() => []);
          expect(
            runStagingReset({
              storage: untouchable,
              env: { ENVIRONMENT: environment },
              handedName: ALEX,
              safety: {},
              pending,
              log: (line) => lines.push(line),
            }),
            String(environment),
          ).toBe("none");
          expect(touched, String(environment)).toBe(0);
          expect(pending).not.toHaveBeenCalled();
        }
        expect(await scanOf(ALEX)).toEqual(before);
        expect(hook.asked).toEqual([]);
        expect(lines).toEqual([]);
        // With no hook set, staging reads nothing either.
        restoreHook();
        let touched = 0;
        const untouchable = new Proxy(
          {},
          {
            get() {
              touched += 1;
              throw new Error("the reset read the storage");
            },
          },
        ) as unknown as DurableObjectStorage;
        expect(
          runStagingReset({
            storage: untouchable,
            env: { ENVIRONMENT: "staging" },
            handedName: ALEX,
            safety: {},
            pending: () => [],
          }),
        ).toBe("none");
        expect(touched).toBe(0);
      } finally {
        restoreHook();
        run.restore();
      }
    },
  );
});

describe("each reason to wait defers it, logged at each try, with nothing deleted", () => {
  /** The reset's deferred lines' reasons, in order. */
  const deferredWhy = (log: MockInstance): unknown[] =>
    resetLines(log)
      .filter((line) => line.outcome === "deferred")
      .map((line) => line.why);

  /** The stuck danger and its hold are still there: nothing was deleted. */
  async function stillStuck(eventId: string): Promise<void> {
    expect((await actorOf(ALEX).readHolds()).map((hold) => hold.eventId)).toContain(eventId);
    expect((await actorOf(ALEX).readInbox()).map((entry) => entry.event.eventId)).toContain(eventId);
    expect(resetLines(log()).filter((line) => line.outcome === "applied")).toEqual([]);
  }

  let spy: MockInstance | null = null;
  const log = (): MockInstance => {
    if (spy === null) throw new Error("no log spy");
    return spy;
  };

  it("a turn that holds a live lease (its committed reply not ended)", { timeout: TEST_MS }, async () => {
    spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const run = setUp({ "evt-t1452-d1": emergency("evt-t1452-d1"), "evt-t1452-d2": no("evt-t1452-d2") });
    const restores: (() => void)[] = [];
    try {
      await stick(run, ALEX_NUMBER, "evt-t1452-d1");
      // The next turn commits with its reply to come, so it keeps the lease for 60 s, its texts taken by its commit.
      restores.push(setLeaseHooks(commitHooks(run.turns, { reply: true })));
      await arrive(ALEX_NUMBER, "evt-t1452-d2", PLAIN_TEXT);
      await settle(ALEX);
      await run.h.clock.advance(QUIET_MS);
      await wake(ALEX);
      expect((await actorOf(ALEX).readTurns()).at(-1)).toMatchObject({ state: "committed" });
      expect((await actorOf(ALEX).readTurns()).at(-1)?.leaseUntil).not.toBeNull();

      restores.push(setStagingReset(hookFor(ALEX)));
      await wake(ALEX);
      await wake(ALEX);

      expect(deferredWhy(log())).toEqual([["leaseLive"], ["leaseLive"]]);
      await stillStuck("evt-t1452-d1");
    } finally {
      for (const restore of restores.reverse()) restore();
      run.restore();
    }
  });

  it(
    "a read out: a re-read sent and not answered (rereading) defers it alone; a text's read on arrival not answered (inFlight) defers it with that text waiting",
    { timeout: TEST_MS },
    async () => {
      spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = setUp({ "evt-t1452-e1": emergency("evt-t1452-e1") });
      const restores: (() => void)[] = [];
      try {
        await stick(run, ALEX_NUMBER, "evt-t1452-e1");
        // The re-read the next alarm sends is never answered.
        const silent = { read: (): Promise<SafetyReadAnswer> => new Promise(() => undefined) };
        restores.push(setSafetyDeps({ ...run.deps, read: silent }));
        await run.h.clock.advance(30_000);
        await wake(ALEX);

        restores.push(setStagingReset(hookFor(ALEX)));
        await wake(ALEX);
        expect(deferredWhy(log())).toEqual([["readOut"]]);
        await stillStuck("evt-t1452-e1");

        // A text whose read on arrival is never answered: its hand-off stores it, and the next one waits for it.
        await arrive(ALEX_NUMBER, "evt-t1452-e2", PLAIN_TEXT);
        await arrive(ALEX_NUMBER, "evt-t1452-e3", PLAIN_TEXT);
        expect(deferredWhy(log()).at(-1)).toEqual(["readOut", "textsWaiting"]);
        await stillStuck("evt-t1452-e1");
      } finally {
        for (const restore of restores.reverse()) restore();
        run.restore();
      }
    },
  );

  it("a text that waits in the batch window", { timeout: TEST_MS }, async () => {
    spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const run = setUp({
      "evt-t1452-f1": emergency("evt-t1452-f1"),
      "evt-t1452-f2": no("evt-t1452-f2"),
      "evt-t1452-f3": no("evt-t1452-f3"),
    });
    const restores: (() => void)[] = [];
    try {
      await stick(run, ALEX_NUMBER, "evt-t1452-f1");
      await arrive(ALEX_NUMBER, "evt-t1452-f2", PLAIN_TEXT);
      await settle(ALEX);
      restores.push(setStagingReset(hookFor(ALEX)));
      // The next hand-off: its own text is not stored yet, and the one before it waits in the open batch.
      await arrive(ALEX_NUMBER, "evt-t1452-f3", PLAIN_TEXT);
      expect(deferredWhy(log())).toEqual([["textsWaiting"]]);
      await stillStuck("evt-t1452-f1");
    } finally {
      for (const restore of restores.reverse()) restore();
      run.restore();
    }
  });

  it("PostgreSQL known down (the down path's state row)", { timeout: TEST_MS }, async () => {
    spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const run = setUp({ "evt-t1452-g1": emergency("evt-t1452-g1") });
    const restores: (() => void)[] = [];
    try {
      await stick(run, ALEX_NUMBER, "evt-t1452-g1");
      // The row ../outage/db writes while PostgreSQL is known down (outage_state: one row at most).
      await runInDurableObject(stubOf(ALEX), (_, state) => {
        state.storage.sql.exec("INSERT INTO outage_state (one, since_ms, probe_ms) VALUES (1, 0, 20000)");
      });
      restores.push(setStagingReset(hookFor(ALEX)));
      await wake(ALEX);
      expect(deferredWhy(log())).toEqual([["postgresDown"]]);
      await stillStuck("evt-t1452-g1");
    } finally {
      for (const restore of restores.reverse()) restore();
      run.restore();
    }
  });

  it("a stop-rank write that waits for the core (a STOP is never lost)", { timeout: TEST_MS }, async () => {
    spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const run = setUp({ "evt-t1452-h1": emergency("evt-t1452-h1") });
    const restores: (() => void)[] = [];
    try {
      await stick(run, ALEX_NUMBER, "evt-t1452-h1");
      await runInDurableObject(stubOf(ALEX), (instance) => {
        returnsOf(instance).enqueue({
          key: "recordStopOrStart:evt-t1452-h0",
          call: "recordStopOrStart",
          rank: "stop",
          box: "sealed-stand-in",
        });
      });
      restores.push(setStagingReset(hookFor(ALEX)));
      await wake(ALEX);
      expect(deferredWhy(log())).toEqual([["stopWriteWaiting"]]);
      await stillStuck("evt-t1452-h1");
      expect((await actorOf(ALEX).readCopies()).returns).toEqual([
        expect.objectContaining({ key: "recordStopOrStart:evt-t1452-h0", rank: "stop", refused: null }),
      ]);
    } finally {
      for (const restore of restores.reverse()) restore();
      run.restore();
    }
  });
});

describe("a STOP survives", () => {
  it(
    "the stopped copy still reads stopped afterwards; the stop rank's refused write and held row stay, while a refused danger write and its held row go",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = setUp({ "evt-t1452-i1": emergency("evt-t1452-i1") });
      const restores: (() => void)[] = [];
      try {
        await stick(run, ALEX_NUMBER, "evt-t1452-i1");
        await runInDurableObject(stubOf(ALEX), async (instance) => {
          expect(
            copiesOf(instance).noteStopped({ stopped: true, phoneVersion: 4, turnId: "turn-t1452-stop" }),
          ).toBe(true);
          const returns = returnsOf(instance);
          returns.enqueue({
            key: "recordSafetyOutcome:evt-t1452-i0",
            call: "recordSafetyOutcome",
            rank: "danger",
            box: "sealed-stand-in",
          });
          returns.enqueue({
            key: "recordStopOrStart:evt-t1452-i0",
            call: "recordStopOrStart",
            rank: "stop",
            box: "sealed-stand-in",
          });
          // The core refuses both: each holds its rank (DL-167).
          expect(await returns.replay(() => Promise.resolve({ refused: "phoneStopped" }))).toEqual({
            written: 0,
            refused: 2,
            left: 2,
          });
        });
        expect((await actorOf(ALEX).readCopies()).stopped?.stopped).toBe(true);

        restores.push(setStagingReset(hookFor(ALEX)));
        await wake(ALEX);

        expect(resetLines(log).map((line) => line.outcome)).toEqual(["applied"]);
        const copies = await actorOf(ALEX).readCopies();
        expect(copies.stopped?.stopped).toBe(true);
        expect(copies.returns).toEqual([
          expect.objectContaining({
            key: "recordStopOrStart:evt-t1452-i0",
            rank: "stop",
            refused: "phoneStopped",
          }),
        ]);
        expect(await actorOf(ALEX).mayHaveStoppedNow()).toBe(true);
        const after = await scanOf(ALEX);
        expect(after.return_held?.map((row) => (JSON.parse(row) as Json).key)).toEqual([
          "recordStopOrStart:evt-t1452-i0",
        ]);
        expect(after.copy_stopped).toHaveLength(1);
        expect(await actorOf(ALEX).readHolds()).toEqual([]);
      } finally {
        for (const restore of restores.reverse()) restore();
        run.restore();
      }
    },
  );
});

describe("a table no rule names", () => {
  it("refuses the reset, with nothing deleted, and logs it", { timeout: TEST_MS }, async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const run = setUp({ "evt-t1452-j1": emergency("evt-t1452-j1") });
    const restores: (() => void)[] = [];
    try {
      await stick(run, ALEX_NUMBER, "evt-t1452-j1");
      await runInDurableObject(stubOf(ALEX), (_, state) => {
        state.storage.sql.exec("CREATE TABLE t1452_unnamed (k TEXT PRIMARY KEY)");
      });
      const before = await scanOf(ALEX);
      restores.push(setStagingReset(hookFor(ALEX)));
      await wake(ALEX);

      expect(resetLines(log).map((line) => [line.outcome, line.why])).toEqual([
        ["refused", ["unknownTable"]],
      ]);
      const after = await scanOf(ALEX);
      expect(after[RESET_MARKER]).toBeUndefined();
      expect(after.safety_holds).toEqual(before.safety_holds);
      expect(after.inbox).toEqual(before.inbox);
    } finally {
      for (const restore of restores.reverse()) restore();
      run.restore();
    }
  });
});
