// ADR-018's card H (T-1312; CQ-231): the direct danger line never waits for its hold, and every routine part stays held
// until the hold is written. Run inside the Workers runtime: the actor is the real Durable Object reached through the
// gateway's door; the safety read, the shared core, the Linq send and the clock are the doubles of ./test-support, and a
// turn's commit goes through the actor's own lease to K-05's double, as in ./store.worker.test.ts. Each test proves a line
// of the record's section 3, card H, "Proves it with", or a point of its section 2 that the card gives. Where a test makes
// a write throw, the actor's own storage call throws for it, picked by its table and its order (a SQLite trigger that
// refuses a write cannot also count it: its abort undoes the count); where it makes a seal fail, it does so at the
// platform's WebCrypto encrypt, for one text's result only. `closeResults` is reached on the actor's own safety read,
// inside a storage transaction, as the lease's end of a turn calls it. Test values only (rule 9).
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

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
import { fakeKeyStore, present } from "../gateway/test-support";
import {
  setBatchHooks,
  setBundleDeps,
  setLeaseHooks,
  setSafetyDeps,
  type CommitAnswer,
  type CommitContext,
  type CommitTurnAnswer,
  type CommitTurnRequest,
  type HandleActor,
  type HoldEntry,
  type LeasedTurn,
  type QueuedEntry,
  type SafetyEntry,
} from "../actor";
import type { SafetyOnArrival } from "./arrival";
import { harness, type Harness } from "./test-support";
import type {
  RecordSafetyOutcomeRequest,
  ReleaseSafetyHoldRequest,
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

/** A danger the bundle's danger-word list does not hold: only a read finds it, and a re-read's No gives it no line. */
const SMOKE_TEXT = "there is smoke pouring out of the dryer in the back room";
/** A danger whose hold the core lifts at once after its line (harm to a child or older adult: arch 06 line 319). */
const HARM_TEXT = "my mom's carer leaves her alone without food for days";
/** The idempotency key of evt-1's emergency line on the direct path (`safety:<event id>:<line id>`). */
const LINE_KEY = "safety:evt-1:safetyEmergency";

/** How long a test waits for the actor's own work under load (a resource guard, not part of any claim). */
const WAIT = { timeout: 5000 };

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
interface HoldRpc {
  readSafety(): Promise<SafetyEntry[]>;
  readHolds(): Promise<HoldEntry[]>;
  routineHeld(): Promise<boolean>;
  markHoldReleased(holdId: string): Promise<"released" | "neverReleased" | "noSuchHold">;
  writeSafetyOnReturn(): Promise<number>;
  readCopies(): Promise<{ returns: QueuedEntry[] }>;
  safetyIdle(): Promise<void>;
  batchIdle(): Promise<void>;
}

function actorOf(): HoldRpc {
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

/** Nothing is left for the safety read to read again: the stored schedule holds no safety entry. */
async function noSafetyEntry(): Promise<void> {
  expect((await scheduleOf()).map((entry) => entry.kind)).not.toContain("safetyRead");
}

const asResult = (fixture: unknown): SafetyResult => fixture as SafetyResult;
const no = (eventId: string): SafetyResult => ({ ...asResult(safetyNo), eventId });
const emergency = (eventId: string): SafetyResult => ({ ...asResult(safetyEmergencyNow), eventId });
/** A danger whose hold's rule is at once: harm to a child or older adult, read now (no danger word). */
const harm = (eventId: string): SafetyResult => ({
  ...no(eventId),
  read: {
    labels: [
      { outcome: "Harm to a child or older adult", tense: "now", evidence: "x", atRisk: "a", writer: "w" },
    ],
  },
  outcomes: ["Harm to a child or older adult"],
});

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

/** A read that answers each text's n-th read as `answer(eventId, n)` says, at once. */
function readsBy(answer: (eventId: string, nth: number) => SafetyResult): SafetyReadPort & {
  requests: SafetyReadRequest[];
} {
  const requests: SafetyReadRequest[] = [];
  return {
    requests,
    read(request) {
      requests.push(request);
      const nth = requests.filter((each) => each.eventId === request.eventId).length;
      return Promise.resolve(verdict(answer(request.eventId, nth)));
    },
  };
}

/**
 * Counts the safetyRead spans of re-reads whose answer was not used (`via` reread), from the logs, kept quiet: the span
 * is recorded only once such an answer has been dealt with.
 */
function rereadSpans(): () => number {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  return () => log.mock.calls.filter((call) => String(call[0]).includes('"via":"reread"')).length;
}

/** The shared core's double, with every recordSafetyOutcome call kept: those that throw (PostgreSQL down) too. */
function countingCore(h: Harness, calls: RecordSafetyOutcomeRequest[]): SafetyDeps["core"] {
  return {
    recordSafetyOutcome(request) {
      calls.push(request);
      return h.core.recordSafetyOutcome(request);
    },
    sendFixedLine: (request) => h.core.sendFixedLine(request),
    releaseSafetyHold: (request) => h.core.releaseSafetyHold(request),
  };
}

/** evt-1's hold as the labels kept for it build it (`holdFromKept`): An emergency's rule, no id, no booking block. */
const KEPT_HOLD: HoldEntry = {
  eventId: "evt-1",
  holdId: null,
  rule: "after_safe",
  blocksBooking: false,
  released: false,
};

// ---- inside the actor --------------------------------------------------------------------------------------------------

/** The actor's own safety read, reached inside the actor. */
function safetyOf(instance: HandleActor): SafetyOnArrival {
  return (instance as unknown as { safety: SafetyOnArrival }).safety;
}

function unreadTexts(): Promise<string[]> {
  return runInDurableObject(stub(), (instance) => safetyOf(instance).unreadTexts());
}

/** Closes these texts inside a storage transaction, as the step that ends their turn for good does (ADR-015 card B). */
function closeResults(eventIds: readonly string[]): Promise<void> {
  return runInDurableObject(stub(), (instance, state) => {
    state.storage.transactionSync(() => {
      safetyOf(instance).closeResults(eventIds);
    });
  });
}

/** The event ids a safety table of event ids holds, in the order written. */
function idsIn(table: "safety_closed" | "safety_pending" | "safety_line_done"): Promise<string[]> {
  return runInDurableObject(stub(), (_, state) =>
    state.storage.sql
      .exec<{ event_id: string }>(`SELECT event_id FROM ${table} ORDER BY rowid`)
      .toArray()
      .map((row) => row.event_id),
  );
}

/** The outcome labels kept for a text (none: empty). */
function labelsOf(eventId: string): Promise<string[]> {
  return runInDurableObject(stub(), (_, state) => {
    const row = state.storage.sql
      .exec<{ outcomes: string }>("SELECT outcomes FROM safety_outcomes WHERE event_id = ?", eventId)
      .toArray()[0];
    return row === undefined ? [] : (JSON.parse(row.outcomes) as string[]);
  });
}

/** The K-01 id of the danger line noted for a text on the direct path (none: null). */
function notedLineOf(eventId: string): Promise<string | null> {
  return runInDurableObject(stub(), (_, state) => {
    const row = state.storage.sql
      .exec<{ line: string }>("SELECT line FROM safety_noted_lines WHERE event_id = ?", eventId)
      .toArray()[0];
    return row === undefined ? null : (JSON.parse(row.line) as { id: string }).id;
  });
}

function exec(query: string, ...bindings: SqlStorageValue[]): Promise<void> {
  return runInDurableObject(stub(), (_, state) => {
    state.storage.sql.exec(query, ...bindings);
  });
}

/** The tables whose writes a test makes the storage refuse. */
type FaultTable = "safety_holds" | "safety_outcomes";

const isFaultTable = (name: string | undefined): name is FaultTable =>
  name === "safety_holds" || name === "safety_outcomes";

interface WriteFault {
  /** How many writes of this table the storage refused. */
  refused(table: FaultTable): number;
  /** The storage takes every write again. */
  lift(): void;
}

const WRITE = /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+(\w+)/i;

/**
 * Makes the actor's storage throw, inside the actor, at each write (an insert, an update or a delete) of a named table
 * that the table's `refuse` picks by the write's order, the first being 1, until `lift`. Every other statement runs as
 * it is.
 */
async function faultWrites(
  refuse: Partial<Record<FaultTable, (nth: number) => boolean>>,
): Promise<WriteFault> {
  const seen = new Map<FaultTable, number>();
  const refused = new Map<FaultTable, number>();
  let lifted = false;
  await runInDurableObject(stub(), (_, state) => {
    const { sql } = state.storage;
    const run = sql.exec.bind(sql);
    const faulted = (
      query: string,
      ...bindings: SqlStorageValue[]
    ): SqlStorageCursor<Record<string, SqlStorageValue>> => {
      const table = WRITE.exec(query)?.[1];
      const picks = isFaultTable(table) ? refuse[table] : undefined;
      if (!lifted && isFaultTable(table) && picks !== undefined) {
        const nth = (seen.get(table) ?? 0) + 1;
        seen.set(table, nth);
        if (picks(nth)) {
          refused.set(table, (refused.get(table) ?? 0) + 1);
          throw new Error("the storage refused");
        }
      }
      return run(query, ...bindings);
    };
    vi.spyOn(sql, "exec").mockImplementation(faulted);
  });
  return {
    refused: (table) => refused.get(table) ?? 0,
    lift: () => {
      lifted = true;
    },
  };
}

/**
 * Makes every seal of one text's kept result fail at the platform's WebCrypto encrypt: only a seal whose additional data
 * is `<actor name>|result:<event id>`; every other seal (the gateway's, the write-on-return queue's) runs as it is. The
 * text's result is then owed, so its danger stays pending (ADR-015 section 2).
 */
function failSeal(eventId: string): void {
  const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  const name = `${ALEX}|result:${eventId}`;
  vi.spyOn(crypto.subtle, "encrypt").mockImplementation(async (algorithm, key, data) => {
    const named = typeof algorithm === "object" ? algorithm.additionalData : undefined;
    if (named !== undefined && new TextDecoder().decode(named) === name) throw new Error("the seal failed");
    return encrypt(algorithm, key, data);
  });
}

// ---- the actor, its doubles and its lease ------------------------------------------------------------------------------

/** The actor's own turn lease, wired: each turn the lease hands its work, and what each commit was handed. */
interface Lease {
  turns: LeasedTurn[];
  contexts: CommitContext[];
}

/** Commits this run of the turn through the lease, inside the actor, as the turn's work does (commit-first.json). */
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
  lease: Lease;
  /** Cuts the actor off (its memory goes; its storage and alarm stay), then puts `next` in place. */
  evict(next?: SafetyDeps): Promise<void>;
  /** Wakes the actor the way its stored alarm does. */
  wake(): Promise<void>;
  /** Settles the safety work and the batch work of what has arrived. */
  settle(): Promise<void>;
}

/**
 * Runs a test body with the doubles set for the isolate and put back after: the read answers `answers` at once, unless
 * `deps` gives other doubles. With `lease`, closed batches go to the actor's own turn lease, whose commit is K-05's
 * double (each context kept); else each closed batch is dropped.
 */
async function withActor(
  answers: Record<string, SafetyResult>,
  options: { deps?: (h: Harness) => SafetyDeps; lease?: boolean },
  body: (run: Run) => Promise<void>,
): Promise<void> {
  const h = harness(keys, answers);
  const restores: (() => void)[] = [setSafetyDeps(options.deps?.(h) ?? h.deps)];
  const lease: Lease = { turns: [], contexts: [] };
  if (options.lease === true) {
    const first = commitFirst.outcome as unknown as CommitTurnAnswer;
    restores.push(
      setBatchHooks({ clock: h.clock }),
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
  } else {
    restores.push(setBatchHooks({ clock: h.clock, toLease: () => undefined }));
  }
  const run: Run = {
    h,
    lease,
    async evict(next) {
      const cut = await runInDurableObject(stub(), async (_, state) => {
        await state.storage.sync();
        state.abort("cut off");
      }).then(
        () => "still running",
        () => "cut off",
      );
      expect(cut).toBe("cut off");
      if (next !== undefined) restores.push(setSafetyDeps(next));
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
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

// ---- card H's proofs ---------------------------------------------------------------------------------------------------

describe("the guard: no write before a danger's direct line can stop it (ADR-018 section 2)", () => {
  it("with the core not answering and every write to safety_holds throwing: a danger verdict's direct line goes once, on that application, under its noted key, before any re-read is due, and its record is queued; the text stays pending, among unreadTexts, with routineHeld true, and a commit through the actor's lease is handed it in CommitContext.unread", async () => {
    await withActor({ "evt-1": emergency("evt-1") }, { lease: true }, async (run) => {
      run.h.core.down = true;
      const faults = await faultWrites({ safety_holds: () => true });
      await arrive("evt-1", SMOKE_TEXT);
      await run.settle();

      // Step 1's write of the hold, the direct path's and dangerSent's each threw; the line went all the same, at once,
      // under the key of the line noted for the text.
      expect(faults.refused("safety_holds")).toBe(3);
      expect(run.h.direct.sent.map((send) => [send.at, send.idempotencyKey, send.overrideOptout])).toEqual([
        [0, LINE_KEY, true],
      ]);
      expect(await notedLineOf("evt-1")).toBe("safetyEmergency");
      expect(await actorOf().readSafety()).toMatchObject([
        {
          eventId: "evt-1",
          state: "done",
          danger: true,
          path: "direct",
          lineId: "safetyEmergency",
          handedAfterMs: 0,
        },
      ]);
      expect((await actorOf().readCopies()).returns).toMatchObject([
        { key: "recordSafetyOutcome:evt-1", call: "recordSafetyOutcome", rank: "danger" },
      ]);

      // No hold: the danger stays pending, among the texts not read, with routine work held, read again 30 s on.
      expect(await actorOf().readHolds()).toEqual([]);
      expect(await idsIn("safety_pending")).toEqual(["evt-1"]);
      expect(await unreadTexts()).toEqual(["evt-1"]);
      expect(await actorOf().routineHeld()).toBe(true);
      await vi.waitFor(async () => {
        expect(await scheduleOf()).toContainEqual({ kind: "safetyRead", due_ms: 30_000 });
      }, WAIT);

      // Its batch closed at once on the danger and reached the lease.
      await vi.waitFor(() => {
        expect(run.lease.turns.map((turn) => turn.eventIds)).toEqual([["evt-1"]]);
      }, WAIT);
      const turn = present(run.lease.turns[0], "the turn");
      expect(turn.holds).toEqual([]);
      // While the core is not answering for the queued danger record, the lease sends no commit (CQ-104 (f)).
      expect(await commitOf(turn)).toEqual({ error: "transient" });
      expect(run.lease.contexts).toEqual([]);
      // Once it answers, the record replays first; the replay's write of the core's hold throws too (point 4, guarded),
      // so the commit is handed the text among the texts not read.
      run.h.core.down = false;
      expect(await commitOf(turn)).toMatchObject({ result: "committed" });
      expect(run.h.core.recorded.map((call) => call.request.caller.kind)).toEqual(["actorOnReturn"]);
      expect(faults.refused("safety_holds")).toBe(4);
      expect(run.lease.contexts).toEqual([{ holds: [], unread: ["evt-1"] }]);
      // The turn's end closed the text; its hold not written, its note stays (point 3).
      expect(await idsIn("safety_closed")).toEqual(["evt-1"]);
      expect(await idsIn("safety_pending")).toEqual(["evt-1"]);
      expect(await unreadTexts()).toEqual(["evt-1"]);
      expect(run.h.clock.now()).toBeLessThan(30_000);
      expect(run.h.direct.sent).toHaveLength(1);
    });
  });
});

describe("a danger is complete only once its hold is written (ADR-018 section 2, points 1 to 3)", () => {
  it("with only the first two hold writes throwing, dangerSent's write succeeds and the note clears on that application", async () => {
    await withActor({ "evt-1": emergency("evt-1") }, {}, async (run) => {
      run.h.core.down = true;
      const faults = await faultWrites({ safety_holds: (nth) => nth <= 2 });
      await arrive("evt-1", SMOKE_TEXT);
      await run.settle();

      expect(faults.refused("safety_holds")).toBe(2);
      expect(run.h.direct.sent.map((send) => [send.at, send.idempotencyKey])).toEqual([[0, LINE_KEY]]);
      // dangerSent's write: the hold from the labels kept for the text.
      expect(await actorOf().readHolds()).toEqual([KEPT_HOLD]);
      expect(await idsIn("safety_pending")).toEqual([]);
      expect(await idsIn("safety_line_done")).toEqual([]);
      expect(await unreadTexts()).toEqual([]);
      await vi.waitFor(noSafetyEntry, WAIT);
    });
  });

  it.each(["with no turn's end before it", "after closeResults, which leaves the note"] as const)(
    "with the hold writes throwing until after the line, the next due re-read writes the hold from the kept labels and clears the note, with no read sent to the read double, no second send and no core call: %s",
    async (when) => {
      const calls: RecordSafetyOutcomeRequest[] = [];
      await withActor(
        { "evt-1": emergency("evt-1") },
        { deps: (h) => ({ ...h.deps, core: countingCore(h, calls) }) },
        async (run) => {
          run.h.core.down = true;
          const faults = await faultWrites({ safety_holds: () => true });
          await arrive("evt-1", SMOKE_TEXT);
          await run.settle();
          expect(run.h.direct.sent.map((send) => send.idempotencyKey)).toEqual([LINE_KEY]);
          expect(await actorOf().readHolds()).toEqual([]);
          expect(await idsIn("safety_pending")).toEqual(["evt-1"]);
          expect(await idsIn("safety_line_done")).toEqual(["evt-1"]);
          expect(calls).toHaveLength(1);
          expect(run.h.read.requests).toHaveLength(1);

          // After the line, the storage takes the hold's writes again.
          faults.lift();
          if (when === "after closeResults, which leaves the note") {
            await closeResults(["evt-1"]);
            expect(await idsIn("safety_closed")).toEqual(["evt-1"]);
            expect(await idsIn("safety_pending")).toEqual(["evt-1"]);
            expect(await idsIn("safety_line_done")).toEqual(["evt-1"]);
            expect(await unreadTexts()).toEqual(["evt-1"]);
          }

          // 30 s: the re-read is due. The danger lacks only its hold: written from its kept labels, it is complete.
          await run.h.clock.advance(30_000);
          await run.wake();
          await vi.waitFor(async () => {
            expect(await idsIn("safety_pending")).toEqual([]);
          }, WAIT);
          expect(await actorOf().readHolds()).toEqual([KEPT_HOLD]);
          expect(await idsIn("safety_line_done")).toEqual([]);
          expect(await unreadTexts()).toEqual([]);
          await vi.waitFor(noSafetyEntry, WAIT);
          await run.settle();
          expect(run.h.read.requests).toHaveLength(1);
          expect(run.h.direct.sent).toHaveLength(1);
          expect(calls).toHaveLength(1);
        },
      );
    },
  );

  it("a re-read sent while the hold still could not be written, answered once it can: the answer's step writes the hold from the kept labels and completes the danger, its danger verdict not used, with no second send and no core call", async () => {
    const calls: RecordSafetyOutcomeRequest[] = [];
    const requests: SafetyReadRequest[] = [];
    await withActor(
      {},
      {
        deps: (h) => ({
          ...h.deps,
          core: countingCore(h, calls),
          // Every read says An emergency: the first at once, a re-read 1 s after it is sent.
          read: {
            async read(request) {
              requests.push(request);
              if (requests.length > 1) await h.clock.after(1000);
              return verdict(emergency(request.eventId));
            },
          },
        }),
      },
      async (run) => {
        run.h.core.down = true;
        const faults = await faultWrites({ safety_holds: () => true });
        await arrive("evt-1", SMOKE_TEXT);
        await run.settle();
        expect(run.h.direct.sent).toHaveLength(1);

        // 30 s: the re-read is due; the hold's write still throws, so the read is sent.
        await run.h.clock.advance(30_000);
        await run.wake();
        await vi.waitFor(() => {
          expect(requests).toHaveLength(2);
        }, WAIT);
        expect(await idsIn("safety_pending")).toEqual(["evt-1"]);

        // 31 s: the storage takes the writes again, and the answer lands: the hold is written, the danger complete.
        faults.lift();
        await run.h.clock.advance(1000);
        await vi.waitFor(async () => {
          expect(await idsIn("safety_pending")).toEqual([]);
        }, WAIT);
        expect(await actorOf().readHolds()).toEqual([KEPT_HOLD]);
        await vi.waitFor(noSafetyEntry, WAIT);
        expect(run.h.direct.sent).toHaveLength(1);
        expect(calls).toHaveLength(1);
      },
    );
  });

  it("a resume of a danger whose line and record were done and whose result was settled, its hold missing (its row put back to reading, as a cut before the application's last step would leave it), writes the hold from the kept labels and completes it, with no read sent", async () => {
    await withActor({ "evt-1": emergency("evt-1") }, {}, async (run) => {
      run.h.core.down = true;
      const faults = await faultWrites({ safety_holds: () => true });
      await arrive("evt-1", SMOKE_TEXT);
      await run.settle();
      expect(await idsIn("safety_line_done")).toEqual(["evt-1"]);
      faults.lift();
      await exec("UPDATE safety_events SET state = 'reading' WHERE event_id = 'evt-1'");

      await run.evict();
      await run.wake();
      await vi.waitFor(async () => {
        expect(await idsIn("safety_pending")).toEqual([]);
      }, WAIT);
      expect(await actorOf().readHolds()).toEqual([KEPT_HOLD]);
      await vi.waitFor(noSafetyEntry, WAIT);
      await run.settle();
      expect(run.h.read.requests).toHaveLength(1);
      expect(run.h.direct.sent).toHaveLength(1);
    });
  });
});

describe("the record's replay writes the core's hold when the actor holds none (ADR-018 section 2, point 4)", () => {
  it("the queued record replayed while the actor holds no outcome hold writes the core's hold with its id and rule (markHoldReleased of that id then answers released), and the next due re-read finds the danger complete with no read", async () => {
    await withActor({ "evt-1": emergency("evt-1") }, {}, async (run) => {
      run.h.core.down = true;
      const faults = await faultWrites({ safety_holds: () => true });
      await arrive("evt-1", SMOKE_TEXT);
      await run.settle();
      expect(await actorOf().readHolds()).toEqual([]);
      faults.lift();

      // The core answers again: the record replays, and its hold becomes the actor's, with its id.
      run.h.core.down = false;
      expect(await actorOf().writeSafetyOnReturn()).toBe(1);
      expect(run.h.core.recorded.map((call) => call.request.caller.kind)).toEqual(["actorOnReturn"]);
      expect(await actorOf().readHolds()).toEqual([
        { eventId: "evt-1", holdId: "hold-evt-1", rule: "after_safe", blocksBooking: true, released: false },
      ]);
      expect(await actorOf().markHoldReleased("hold-evt-1")).toBe("released");

      // 30 s: its hold written (released or not), the danger is complete: its note clears, no read is sent, and the
      // released hold stays released.
      await run.h.clock.advance(30_000);
      await run.wake();
      await vi.waitFor(async () => {
        expect(await idsIn("safety_pending")).toEqual([]);
      }, WAIT);
      expect(await actorOf().readHolds()).toEqual([
        { eventId: "evt-1", holdId: "hold-evt-1", rule: "after_safe", blocksBooking: true, released: true },
      ]);
      await run.settle();
      expect(run.h.read.requests).toHaveLength(1);
      expect(run.h.direct.sent).toHaveLength(1);
    });
  });

  it("replayed after the re-read's hold, the id lands on it as today", async () => {
    await withActor({ "evt-1": emergency("evt-1") }, {}, async (run) => {
      run.h.core.down = true;
      const faults = await faultWrites({ safety_holds: () => true });
      await arrive("evt-1", SMOKE_TEXT);
      await run.settle();
      faults.lift();

      // 30 s: the re-read writes the hold from the kept labels, with no id, and the danger is complete.
      await run.h.clock.advance(30_000);
      await run.wake();
      await vi.waitFor(async () => {
        expect(await idsIn("safety_pending")).toEqual([]);
      }, WAIT);
      expect(await actorOf().readHolds()).toEqual([KEPT_HOLD]);
      expect(await actorOf().markHoldReleased("hold-evt-1")).toBe("noSuchHold");

      // The core answers again: the record replays, and the core's id lands on that hold.
      run.h.core.down = false;
      expect(await actorOf().writeSafetyOnReturn()).toBe(1);
      expect(await actorOf().readHolds()).toEqual([{ ...KEPT_HOLD, holdId: "hold-evt-1" }]);
      expect(await actorOf().markHoldReleased("hold-evt-1")).toBe("released");
    });
  });
});

describe("holdFromKept fills only a missing hold (ADR-018 section 2, point 5)", () => {
  it("a pending danger whose outcome hold the core released: holdFromKept, on a re-read that answers No, leaves it released", async () => {
    const rereads = rereadSpans();
    const read = readsBy((eventId, nth) => (nth === 1 ? emergency(eventId) : no(eventId)));
    await withActor({}, { deps: (h) => ({ ...h.deps, read }) }, async (run) => {
      // The core answers: its hold takes the place of step 1's, with its id. The seal fails, so the result is owed and
      // the danger stays pending, its line and record done.
      failSeal("evt-1");
      await arrive("evt-1", SMOKE_TEXT);
      await run.settle();
      expect(await idsIn("safety_pending")).toEqual(["evt-1"]);
      expect(await idsIn("safety_line_done")).toEqual(["evt-1"]);
      // The core released it: the actor is told by its id (the turn's gate or the console).
      expect(await actorOf().markHoldReleased("hold-evt-1")).toBe("released");
      const released: HoldEntry = {
        eventId: "evt-1",
        holdId: "hold-evt-1",
        rule: "after_safe",
        blocksBooking: true,
        released: true,
      };
      expect(await actorOf().readHolds()).toEqual([released]);

      // 30 s: read again, No: not used (the first verdict stands), and the hold stays released.
      await run.h.clock.advance(30_000);
      await run.wake();
      await vi.waitFor(() => {
        expect(rereads()).toBe(1);
      }, WAIT);
      expect(read.requests).toHaveLength(2);
      expect(await actorOf().readHolds()).toEqual([released]);
      // Still pending, its result owed: every commit is handed it among the texts not read.
      expect(await idsIn("safety_pending")).toEqual(["evt-1"]);
      expect(await unreadTexts()).toEqual(["evt-1"]);
    });
  });

  it("a pending danger whose outcome hold the core released at once: holdFromKept, on a resume after the cut and at that resume's re-read, which answers No, leaves it released", async () => {
    const rereads = rereadSpans();
    const releases: ReleaseSafetyHoldRequest[] = [];
    await withActor(
      { "evt-1": harm("evt-1") },
      {
        deps: (h) => ({
          ...h.deps,
          // The core takes the at-once release after the line, and its answer never comes: the cut comes during it.
          core: {
            ...h.core,
            releaseSafetyHold(request) {
              releases.push(request);
              return new Promise(() => undefined);
            },
          },
        }),
      },
      async (run) => {
        // The seal fails, so the result is owed and the danger stays pending, its line and record done.
        failSeal("evt-1");
        await arrive("evt-1", HARM_TEXT);
        await vi.waitFor(() => {
          expect(releases.map((request) => request.holdId)).toEqual(["hold-evt-1"]);
        }, WAIT);
        expect(await actorOf().readSafety()).toMatchObject([
          { eventId: "evt-1", state: "reading", danger: true },
        ]);
        expect(await idsIn("safety_pending")).toEqual(["evt-1"]);
        // The core released it: the actor is told by its id (the turn's gate or the console).
        expect(await actorOf().markHoldReleased("hold-evt-1")).toBe("released");
        const released: HoldEntry = {
          eventId: "evt-1",
          holdId: "hold-evt-1",
          rule: "at_once",
          blocksBooking: false,
          released: true,
        };
        expect(await actorOf().readHolds()).toEqual([released]);

        // 1 s: the cut, during the release. A new instance resumes the danger, still pending, and reads it again: No.
        await run.h.clock.advance(1000);
        await run.evict({ ...run.h.deps, read: readsBy((eventId) => no(eventId)) });
        await run.wake();
        await vi.waitFor(async () => {
          expect(await actorOf().readSafety()).toMatchObject([
            { eventId: "evt-1", state: "lineFailed", danger: true },
          ]);
        }, WAIT);
        expect(await actorOf().readHolds()).toEqual([released]);
        await vi.waitFor(() => {
          expect(rereads()).toBe(1);
        }, WAIT);
        expect(await actorOf().readHolds()).toEqual([released]);
        expect(await idsIn("safety_pending")).toEqual(["evt-1"]);
      },
    );
  });
});

describe("with the labels lost too, no hold is built from them (ADR-018 section 2, open point 4)", () => {
  it("with the labels write throwing too, the text stays pending and unread through re-reads that answer No, and a re-read that finds danger writes the labels and the hold and completes it", async () => {
    const rereads = rereadSpans();
    const read = readsBy((eventId, nth) => (nth === 1 || nth === 4 ? emergency(eventId) : no(eventId)));
    await withActor({}, { deps: (h) => ({ ...h.deps, read }) }, async (run) => {
      run.h.core.down = true;
      const faults = await faultWrites({ safety_holds: () => true, safety_outcomes: () => true });
      await arrive("evt-1", SMOKE_TEXT);
      await run.settle();
      expect(faults.refused("safety_outcomes")).toBe(1);
      expect(run.h.direct.sent.map((send) => send.idempotencyKey)).toEqual([LINE_KEY]);
      expect(await labelsOf("evt-1")).toEqual([]);
      expect(await actorOf().readHolds()).toEqual([]);
      expect(await idsIn("safety_pending")).toEqual(["evt-1"]);
      // The storage takes every write again, but with no labels kept no hold can be built.
      faults.lift();

      // 30 s and 60 s: read again, No: still no hold, the text pending and unread, routine work held.
      for (const [at, seen] of [
        [30_000, 1],
        [60_000, 2],
      ] as const) {
        await run.h.clock.advance(at - run.h.clock.now());
        await run.wake();
        await vi.waitFor(() => {
          expect(rereads()).toBe(seen);
        }, WAIT);
        expect(await actorOf().readHolds()).toEqual([]);
        expect(await idsIn("safety_pending")).toEqual(["evt-1"]);
        expect(await unreadTexts()).toEqual(["evt-1"]);
        expect(await actorOf().routineHeld()).toBe(true);
      }
      expect(read.requests).toHaveLength(3);
      expect(run.h.direct.sent).toHaveLength(1);

      // 90 s: the re-read finds danger: applied again, its step 1 writes the labels and the hold, and it completes. Its
      // line goes again under the noted key, which Linq takes as one message.
      await run.h.clock.advance(90_000 - run.h.clock.now());
      await run.wake();
      await vi.waitFor(async () => {
        expect(await idsIn("safety_pending")).toEqual([]);
      }, WAIT);
      expect(await labelsOf("evt-1")).toEqual(["An emergency"]);
      expect(await actorOf().readHolds()).toEqual([
        { eventId: "evt-1", holdId: null, rule: "after_safe", blocksBooking: true, released: false },
      ]);
      expect(await unreadTexts()).toEqual([]);
      expect(run.h.direct.sent.map((send) => send.idempotencyKey)).toEqual([LINE_KEY, LINE_KEY]);
      await vi.waitFor(noSafetyEntry, WAIT);
    });
  });
});

describe("the outbox path's write of the core's hold, unchanged (ADR-018 section 2)", () => {
  it("a throw at the outbox path's writeHold still leaves the danger pending, and its next application that finds danger writes the core's hold with its id", async () => {
    await withActor({ "evt-1": emergency("evt-1") }, {}, async (run) => {
      // The core answers. Only the second write of the hold throws: the core's (step 1's went in).
      const faults = await faultWrites({ safety_holds: (nth) => nth === 2 });
      await arrive("evt-1", SMOKE_TEXT);
      await run.settle();

      expect(faults.refused("safety_holds")).toBe(1);
      expect(run.h.core.recorded).toHaveLength(1);
      expect(await actorOf().readHolds()).toEqual([
        { eventId: "evt-1", holdId: null, rule: "after_safe", blocksBooking: true, released: false },
      ]);
      expect(await actorOf().readSafety()).toMatchObject([
        { eventId: "evt-1", state: "lineFailed", danger: true },
      ]);
      expect(await idsIn("safety_pending")).toEqual(["evt-1"]);
      expect(await idsIn("safety_line_done")).toEqual([]);

      // 30 s: its re-read finds danger: applied again, the core answers, and its hold is written with its id.
      await run.h.clock.advance(30_000);
      await run.wake();
      await vi.waitFor(async () => {
        expect(await idsIn("safety_pending")).toEqual([]);
      }, WAIT);
      expect(run.h.core.recorded).toHaveLength(2);
      expect(await actorOf().readHolds()).toEqual([
        { eventId: "evt-1", holdId: "hold-evt-1", rule: "after_safe", blocksBooking: true, released: false },
      ]);
      expect(await actorOf().readSafety()).toMatchObject([
        { eventId: "evt-1", state: "done", danger: true, path: "outbox" },
      ]);
      expect(await actorOf().markHoldReleased("hold-evt-1")).toBe("released");
    });
  });
});
