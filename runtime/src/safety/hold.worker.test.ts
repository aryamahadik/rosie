// ADR-018's card H (T-1312; CQ-231): the direct danger line never waits for its hold, and every routine part stays held
// until the hold is written. Run inside the Workers runtime: the actor is the real Durable Object reached through the
// gateway's door; the safety read, the shared core, the Linq send and the clock are the doubles of ./test-support, and a
// turn's commit goes through the actor's own lease to K-05's double, as in ./store.worker.test.ts. Each test proves a line
// of the record's section 3, card H, "Proves it with", or a point of its section 2 that the card gives; the two blocks
// after them prove T-1318's card (T-1312's security notes b and a), the two after those T-1348's (T-1318's new tasks 1 and
// 2: a danger whose pending note was never written is read again until its hold is written, and a cut-off resume never
// clears a danger flag the first read set), and the last T-1364's (T-1348's new task B and its security note a: a danger
// whose line is not done keeps a lasting mark, so its line is tried again until it goes, however its note's writes fail).
// Where a test makes a write (or a read) throw, the actor's own storage call throws for it, picked by its table and its
// order (a SQLite trigger that refuses a write cannot also count it: its abort undoes the count); T-1364's refuse every
// write of a pending note with such a trigger instead, since it is kept in the storage and so refuses a resumed
// instance's writes too. Where a test makes a seal fail, it does so at the platform's WebCrypto encrypt, for one text's
// result only. `closeResults` is reached on the actor's own safety read, inside a storage transaction, as the lease's end
// of a turn calls it. Test values only (rule 9).
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import commitFirst from "../../../contracts/data-access/fixtures/commit-first.json";
import textImessage from "../../../contracts/inbound-event/fixtures/text-imessage.json";
import safetyCrisisWords from "../../../contracts/model/fixtures/safety-crisis-words.json";
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
  RecordSafetyOutcomeResponse,
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

/** The shared core's double that takes each record and never answers (a cut comes during its call); each request is kept. */
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

/**
 * The shared core's double answering a text's record again as K-09 v1 does ("one outcome row per text, and a repeat
 * returns the first"): its first answer, marked repeated, so a danger applied again gets no second line. `rows` keeps the
 * outbox row of each line the core wrote.
 */
function repeatingCore(h: Harness, rows: string[]): SafetyDeps["core"] {
  const first = new Map<string, RecordSafetyOutcomeResponse>();
  return {
    async recordSafetyOutcome(request) {
      const answer = await h.core.recordSafetyOutcome(request);
      if ("error" in answer) return answer;
      const earlier = first.get(request.safety.eventId);
      if (earlier !== undefined) return { ...earlier, repeated: true };
      first.set(request.safety.eventId, answer);
      const row = answer.safetyLine?.outboxRowId ?? null;
      if (row !== null) rows.push(row);
      return answer;
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

/** A text's kept K-02 result, as the actor's own safety read answers it for a turn (none kept: empty). */
function keptResults(eventId: string): Promise<readonly SafetyResult[]> {
  return runInDurableObject(stub(), (instance) => safetyOf(instance).resultsOf([eventId]));
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
type FaultTable = "safety_holds" | "safety_outcomes" | "safety_pending";

const isFaultTable = (name: string | undefined): name is FaultTable =>
  name === "safety_holds" || name === "safety_outcomes" || name === "safety_pending";

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

const READ = /^\s*SELECT\b[\s\S]*?\bFROM\s+(\w+)/i;

/**
 * Makes the actor's storage throw, inside the actor, at each read of a table (a SELECT whose first table it is) that names
 * this event id among its bindings and that `refuse` picks by the read's order, the first being 1. Every other statement
 * runs as it is. Returns how many reads the storage refused.
 */
async function faultReads(
  table: string,
  eventId: string,
  refuse: (nth: number) => boolean,
): Promise<() => number> {
  let seen = 0;
  let refused = 0;
  await runInDurableObject(stub(), (_, state) => {
    const { sql } = state.storage;
    const run = sql.exec.bind(sql);
    const faulted = (
      query: string,
      ...bindings: SqlStorageValue[]
    ): SqlStorageCursor<Record<string, SqlStorageValue>> => {
      if (READ.exec(query)?.[1] === table && bindings.includes(eventId)) {
        seen += 1;
        if (refuse(seen)) {
          refused += 1;
          throw new Error("the storage refused");
        }
      }
      return run(query, ...bindings);
    };
    vi.spyOn(sql, "exec").mockImplementation(faulted);
  });
  return () => refused;
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

// ---- T-1318: T-1312's security notes b and a ---------------------------------------------------------------------------

describe("a danger with no hold names itself among the texts not read, its pending note written or not (T-1318, note b)", () => {
  it.each([
    {
      then: "the replay's write of the core's hold throwing too: the lease's commit is handed the text as unread, and it stays unread with no hold written",
      replayWrites: false,
    },
    {
      then: "the storage taking the replay's write: the replay's hold clears it, and the lease's commit is handed that hold, with the core's id, and nothing unread",
      replayWrites: true,
    },
  ])(
    "with markDangerPending and every hold write throwing, the line goes once on that application and the text is among unreadTexts, routine work held, until a hold is written; then $then",
    async ({ replayWrites }) => {
      await withActor({ "evt-1": emergency("evt-1") }, { lease: true }, async (run) => {
        run.h.core.down = true;
        const faults = await faultWrites({ safety_holds: () => true, safety_pending: () => true });
        await arrive("evt-1", SMOKE_TEXT);
        await run.settle();

        // The pending note and the three writes of the hold (step 1's, the direct path's and dangerSent's) each threw;
        // the line went all the same, once, at once, under the key of the line noted for the text; its record waits.
        expect(faults.refused("safety_pending")).toBe(1);
        expect(faults.refused("safety_holds")).toBe(3);
        expect(run.h.direct.sent.map((send) => [send.at, send.idempotencyKey, send.overrideOptout])).toEqual([
          [0, LINE_KEY, true],
        ]);
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

        // No note and no hold, its result kept: the danger names itself among the texts not read, routine work held.
        expect(await idsIn("safety_pending")).toEqual([]);
        expect(await actorOf().readHolds()).toEqual([]);
        expect(await unreadTexts()).toEqual(["evt-1"]);
        expect(await actorOf().routineHeld()).toBe(true);

        // Its batch closed at once on the danger and reached the lease.
        await vi.waitFor(() => {
          expect(run.lease.turns.map((turn) => turn.eventIds)).toEqual([["evt-1"]]);
        }, WAIT);
        const turn = present(run.lease.turns[0], "the turn");
        expect(turn.holds).toEqual([]);
        // While the core is not answering for the queued danger record, the lease sends no commit (CQ-104 (f)).
        expect(await commitOf(turn)).toEqual({ error: "transient" });
        expect(run.lease.contexts).toEqual([]);
        expect(await unreadTexts()).toEqual(["evt-1"]);

        // The core answers: the lease's commit replays the record first, and the core takes it.
        if (replayWrites) faults.lift();
        run.h.core.down = false;
        expect(await commitOf(turn)).toMatchObject({ result: "committed" });
        expect(run.h.core.recorded.map((call) => call.request.caller.kind)).toEqual(["actorOnReturn"]);
        if (replayWrites) {
          // The replay's hold, the core's with its id, clears it: the commit is handed that hold and nothing unread.
          const hold = { eventId: "evt-1", holdId: "hold-evt-1", rule: "after_safe", blocksBooking: true };
          expect(run.lease.contexts).toEqual([
            { holds: [{ ...hold, outcomes: ["An emergency"] }], unread: [] },
          ]);
          expect(await actorOf().readHolds()).toEqual([{ ...hold, released: false }]);
          expect(await unreadTexts()).toEqual([]);
        } else {
          // The replay's write threw too (guarded): the commit is handed the text among the texts not read, and with no
          // hold written it stays there, routine work held.
          expect(faults.refused("safety_holds")).toBe(4);
          expect(run.lease.contexts).toEqual([{ holds: [], unread: ["evt-1"] }]);
          expect(await actorOf().readHolds()).toEqual([]);
          expect(await unreadTexts()).toEqual(["evt-1"]);
          expect(await actorOf().routineHeld()).toBe(true);
        }
        expect(run.h.direct.sent).toHaveLength(1);
      });
    },
  );
});

describe("the replay's check for a hold and its write are one guarded step (T-1318, note a)", () => {
  it("holdOnReturn with its first read throwing and a released hold present: the hold stays released", async () => {
    await withActor({ "evt-1": emergency("evt-1") }, {}, async (run) => {
      // The seal fails, so the result is owed and the danger stays pending after its line: it is read again 30 s on.
      failSeal("evt-1");
      // The core is not answering: the line goes straight through Linq, step 1's hold stands, and the record waits.
      run.h.core.down = true;
      await arrive("evt-1", SMOKE_TEXT);
      await run.settle();
      expect(run.h.direct.sent.map((send) => send.idempotencyKey)).toEqual([LINE_KEY]);
      expect((await actorOf().readCopies()).returns).toMatchObject([{ key: "recordSafetyOutcome:evt-1" }]);
      const stepOne: HoldEntry = {
        eventId: "evt-1",
        holdId: null,
        rule: "after_safe",
        blocksBooking: true,
        released: false,
      };
      expect(await actorOf().readHolds()).toEqual([stepOne]);

      // The core answers again. 30 s: the re-read finds danger, applied again through the core: its id lands on the hold.
      run.h.core.down = false;
      await run.h.clock.advance(30_000);
      await run.wake();
      await vi.waitFor(async () => {
        expect(await actorOf().readHolds()).toEqual([{ ...stepOne, holdId: "hold-evt-1" }]);
      }, WAIT);
      await run.settle();
      // The core released it: the actor is told by its id (the turn's gate or the console).
      expect(await actorOf().markHoldReleased("hold-evt-1")).toBe("released");
      const released: HoldEntry = { ...stepOne, holdId: "hold-evt-1", released: true };
      expect(await actorOf().readHolds()).toEqual([released]);

      // The queued record replays and the core takes it; holdOnReturn's first read of the text's hold throws. Nothing
      // is written on it: the released hold stays released.
      const refused = await faultReads("safety_holds", "evt-1", (nth) => nth === 1);
      expect(await actorOf().writeSafetyOnReturn()).toBe(1);
      expect(run.h.core.recorded.map((call) => call.request.caller.kind)).toEqual(["job", "actorOnReturn"]);
      expect(refused()).toBe(1);
      expect(await actorOf().readHolds()).toEqual([released]);
    });
  });
});

// ---- T-1348: T-1318's new tasks 1 and 2 --------------------------------------------------------------------------------

describe("a danger whose hold is not written is read again on the read's own schedule until it is, its pending note written or not (T-1348, task 1)", () => {
  it.each([
    {
      then: "the storage recovering before the record's replay: the replay then lands the core's id on that hold, and once the core releases it the routine parts go",
      replayFirst: false,
    },
    {
      then: "the record's replay coming first, its write of the core's hold throwing too, so the replay leaves no hold: the re-read writes it all the same",
      replayFirst: true,
    },
  ])(
    "on the direct path, with markDangerPending and every hold write throwing, the line goes once and the text is read again 30 s on; once the storage recovers, that re-read writes the hold from the kept labels, with no read sent, no second send and no core call; $then",
    async ({ replayFirst }) => {
      const calls: RecordSafetyOutcomeRequest[] = [];
      await withActor(
        { "evt-1": emergency("evt-1") },
        { deps: (h) => ({ ...h.deps, core: countingCore(h, calls) }) },
        async (run) => {
          run.h.core.down = true;
          const faults = await faultWrites({ safety_holds: () => true, safety_pending: () => true });
          await arrive("evt-1", SMOKE_TEXT);
          await run.settle();

          // The note and the three writes of the hold threw; the line went once, at once, under its noted key, and its
          // record waits. No note and no hold: the text names itself among the texts not read, routine work held.
          expect(faults.refused("safety_pending")).toBe(1);
          expect(faults.refused("safety_holds")).toBe(3);
          expect(run.h.direct.sent.map((send) => [send.at, send.idempotencyKey])).toEqual([[0, LINE_KEY]]);
          expect(await idsIn("safety_pending")).toEqual([]);
          expect(await idsIn("safety_line_done")).toEqual(["evt-1"]);
          expect(await actorOf().readHolds()).toEqual([]);
          expect(await unreadTexts()).toEqual(["evt-1"]);
          expect(await actorOf().routineHeld()).toBe(true);
          // It waits for its hold: it is read again on the read's own schedule, 30 s on, as a noted danger is.
          await vi.waitFor(async () => {
            expect(await scheduleOf()).toContainEqual({ kind: "safetyRead", due_ms: 30_000 });
          }, WAIT);

          if (replayFirst) {
            // The core answers again: the record replays while the hold's write still throws (guarded), and it leaves
            // the queue with no hold written.
            run.h.core.down = false;
            expect(await actorOf().writeSafetyOnReturn()).toBe(1);
            expect(faults.refused("safety_holds")).toBe(4);
            expect(await actorOf().writeSafetyOnReturn()).toBe(0);
            expect(await actorOf().readHolds()).toEqual([]);
            expect(await unreadTexts()).toEqual(["evt-1"]);
          }

          // The storage takes every write again. 15 s: nothing is due yet, so nothing is read or written for it.
          faults.lift();
          await run.h.clock.advance(15_000);
          await run.wake();
          await run.settle();
          expect(await actorOf().readHolds()).toEqual([]);
          expect(await unreadTexts()).toEqual(["evt-1"]);

          // 30 s: its re-read is due. Its line and record done and its result kept, it lacks only its hold: written from
          // the kept labels, the danger is complete, with no read sent (ADR-018 section 2, point 2).
          await run.h.clock.advance(15_000);
          await run.wake();
          await vi.waitFor(async () => {
            expect(await actorOf().readHolds()).toEqual([KEPT_HOLD]);
          }, WAIT);
          expect(await unreadTexts()).toEqual([]);
          expect(await idsIn("safety_pending")).toEqual([]);
          expect(await idsIn("safety_line_done")).toEqual([]);
          await vi.waitFor(noSafetyEntry, WAIT);
          await run.settle();
          expect(run.h.read.requests).toHaveLength(1);

          if (!replayFirst) {
            // The core answers again: the record replays, and the core's id lands on that hold. The core releases it
            // (the turn's gate or the console names it by its id), and the routine parts go.
            run.h.core.down = false;
            expect(await actorOf().writeSafetyOnReturn()).toBe(1);
            expect(await actorOf().readHolds()).toEqual([{ ...KEPT_HOLD, holdId: "hold-evt-1" }]);
            expect(await actorOf().markHoldReleased("hold-evt-1")).toBe("released");
            expect(await actorOf().routineHeld()).toBe(false);
          }
          // The line went once and nothing sent it again: one send, and the core had the danger's first try (refused)
          // and the record's replay only.
          expect(run.h.direct.sent).toHaveLength(1);
          expect(calls.map((call) => call.caller.kind)).toEqual(["job", "actorOnReturn"]);
        },
      );
    },
  );

  it("on the outbox path, with markDangerPending, step 1's hold and the core's hold write throwing, the core holds the line and the text, with no hold and no at-once release, is read again 30 s on; the storage recovers while that read is out, and its No is not used, but its step writes the note and the hold from the kept labels; the danger stays pending until the read that finds it again: applied again, the core answers the repeat, its hold takes the core's id and is released at once, and the routine parts go; the line went once", async () => {
    const rows: string[] = [];
    const requests: SafetyReadRequest[] = [];
    const rereads = rereadSpans();
    await withActor(
      {},
      {
        deps: (h) => ({
          ...h.deps,
          core: repeatingCore(h, rows),
          // The read on arrival finds the harm at once; each re-read answers 1 s after it is sent: No, then the harm.
          read: {
            async read(request) {
              requests.push(request);
              if (requests.length === 1) return verdict(harm(request.eventId));
              await h.clock.after(1000);
              return verdict(requests.length === 2 ? no(request.eventId) : harm(request.eventId));
            },
          },
        }),
      },
      async (run) => {
        const faults = await faultWrites({ safety_holds: () => true, safety_pending: () => true });
        await arrive("evt-1", HARM_TEXT);
        await run.settle();

        // The core took the record and holds the line's outbox row. The note, step 1's hold and the core's hold each
        // threw: no note, no hold, and no at-once release. The text names itself among the texts not read.
        expect(faults.refused("safety_pending")).toBe(1);
        expect(faults.refused("safety_holds")).toBe(2);
        expect(run.h.core.recorded.map((call) => call.request.caller.requestId)).toEqual(["safety:evt-1"]);
        expect(rows).toEqual(["out-evt-1"]);
        expect(run.h.core.released).toEqual([]);
        expect(await actorOf().readSafety()).toMatchObject([
          { eventId: "evt-1", state: "lineFailed", danger: true },
        ]);
        expect(await idsIn("safety_pending")).toEqual([]);
        expect(await actorOf().readHolds()).toEqual([]);
        expect(await unreadTexts()).toEqual(["evt-1"]);
        expect(await actorOf().routineHeld()).toBe(true);
        await vi.waitFor(async () => {
          expect(await scheduleOf()).toContainEqual({ kind: "safetyRead", due_ms: 30_000 });
        }, WAIT);

        // 30 s: read again on the read's own schedule; the storage takes every write again while the read is out.
        await run.h.clock.advance(30_000);
        await run.wake();
        await vi.waitFor(() => {
          expect(requests).toHaveLength(2);
        }, WAIT);
        faults.lift();

        // 31 s: its No is not used (the first verdict stands). Its step writes the note, then the hold from the kept
        // labels: the danger stays pending (its hold has no core id and was never released at once), read again 30 s on.
        await run.h.clock.advance(1000);
        await vi.waitFor(() => {
          expect(rereads()).toBe(1);
        }, WAIT);
        const kept: HoldEntry = {
          eventId: "evt-1",
          holdId: null,
          rule: "at_once",
          blocksBooking: false,
          released: false,
        };
        expect(await actorOf().readHolds()).toEqual([kept]);
        expect(await idsIn("safety_pending")).toEqual(["evt-1"]);
        expect(await labelsOf("evt-1")).toEqual(["Harm to a child or older adult"]);
        expect(await unreadTexts()).toEqual([]);
        expect(await actorOf().routineHeld()).toBe(true);
        expect(run.h.core.recorded).toHaveLength(1);
        await vi.waitFor(async () => {
          expect(await scheduleOf()).toContainEqual({ kind: "safetyRead", due_ms: 61_000 });
        }, WAIT);

        // 61 s: read again; 62 s: the harm again. Applied again, it reaches the core as a repeat of its record, answered
        // repeated with its hold: the hold takes the core's id and is released at once after the line, so the routine
        // parts go, and the danger is complete.
        await run.h.clock.advance(30_000);
        await run.wake();
        await vi.waitFor(() => {
          expect(requests).toHaveLength(3);
        }, WAIT);
        await run.h.clock.advance(1000);
        await vi.waitFor(async () => {
          expect(await idsIn("safety_pending")).toEqual([]);
        }, WAIT);
        await run.settle();
        expect(await actorOf().readHolds()).toEqual([{ ...kept, holdId: "hold-evt-1", released: true }]);
        expect(run.h.core.released.map((request) => request.holdId)).toEqual(["hold-evt-1"]);
        expect(await actorOf().routineHeld()).toBe(false);
        await vi.waitFor(noSafetyEntry, WAIT);
        // The line went once: the core wrote one outbox row for it and answered the repeat as repeated, and nothing went
        // straight through Linq.
        expect(run.h.core.recorded.map((call) => call.request.caller.requestId)).toEqual([
          "safety:evt-1",
          "safety:evt-1",
        ]);
        expect(rows).toEqual(["out-evt-1"]);
        expect(run.h.direct.sent).toEqual([]);
      },
    );
  });
});

describe("a cut-off danger whose pending note was never written resumes as a danger in application, never as a fresh read (T-1348, task 2)", () => {
  it("cut off during the core's call with its note's and its hold's writes refused, then resumed with the models answering No: its danger flag, labels and kept result stay, its hold is written from the kept labels before its batch reaches the lease, so no routine part goes before it, and it stays pending; the read that finds the danger again sends its line once", async () => {
    const attempts: RecordSafetyOutcomeRequest[] = [];
    const rereads = rereadSpans();
    // After the cut, the first read says No and the second finds the emergency again.
    const after = readsBy((eventId, nth) => (nth === 2 ? emergency(eventId) : no(eventId)));
    await withActor(
      { "evt-1": emergency("evt-1") },
      { lease: true, deps: (h) => ({ ...h.deps, core: hangingCore(h, attempts) }) },
      async (run) => {
        const faults = await faultWrites({ safety_holds: () => true, safety_pending: () => true });
        await arrive("evt-1", SMOKE_TEXT);

        // 0 s: the read finds An emergency. The note's and the hold's writes throw; the flag, the labels and the result
        // are written; the core is called and never answers. Until its hold is written the text is among the texts not
        // read.
        await vi.waitFor(() => {
          expect(attempts.map((request) => request.caller.requestId)).toEqual(["safety:evt-1"]);
        }, WAIT);
        expect(faults.refused("safety_pending")).toBe(1);
        expect(faults.refused("safety_holds")).toBe(1);
        expect(await actorOf().readSafety()).toMatchObject([
          { eventId: "evt-1", state: "reading", danger: true },
        ]);
        expect(await idsIn("safety_pending")).toEqual([]);
        expect(await actorOf().readHolds()).toEqual([]);
        expect(await labelsOf("evt-1")).toEqual(["An emergency"]);
        expect(await keptResults("evt-1")).toEqual([emergency("evt-1")]);
        expect(await unreadTexts()).toEqual(["evt-1"]);
        expect(run.lease.turns).toEqual([]);

        // 1 s: the cut, during the core's call; the storage takes every write again. 3 s: a new instance resumes it.
        faults.lift();
        await run.h.clock.advance(1000);
        await run.evict({ ...run.h.deps, read: after });
        await run.h.clock.advance(2000);
        await run.wake();

        // Resumed as a danger in application: its note is written, its hold is written from the kept labels, and it is
        // read again at once. The read's No is not used: the flag, the labels and the kept result stay.
        await vi.waitFor(async () => {
          expect(await actorOf().readSafety()).toMatchObject([
            { eventId: "evt-1", state: "lineFailed", danger: true },
          ]);
          expect(rereads()).toBe(1);
        }, WAIT);
        expect(after.requests).toHaveLength(1);
        expect(await labelsOf("evt-1")).toEqual(["An emergency"]);
        expect(await keptResults("evt-1")).toEqual([emergency("evt-1")]);
        expect(await actorOf().readHolds()).toEqual([KEPT_HOLD]);
        expect(await idsIn("safety_pending")).toEqual(["evt-1"]);
        expect(await unreadTexts()).toEqual([]);
        expect(await actorOf().routineHeld()).toBe(true);
        await vi.waitFor(async () => {
          expect(await scheduleOf()).toContainEqual({ kind: "safetyRead", due_ms: 33_000 });
        }, WAIT);

        // Its batch reaches the lease with the hold written, and its commit is handed that hold: no routine part goes
        // before it.
        await vi.waitFor(() => {
          expect(run.lease.turns.map((turn) => turn.eventIds)).toEqual([["evt-1"]]);
        }, WAIT);
        const turn = present(run.lease.turns[0], "the turn");
        const hold = {
          eventId: "evt-1",
          holdId: null,
          rule: "after_safe",
          outcomes: ["An emergency"],
          blocksBooking: false,
        };
        expect(turn.holds).toEqual([hold]);
        expect(await commitOf(turn)).toMatchObject({ result: "committed" });
        expect(run.lease.contexts).toEqual([{ holds: [hold], unread: [] }]);

        // 33 s: read again, An emergency: applied again, its line goes once, through the core, which answers now; its
        // hold takes the core's, and the danger is complete.
        await run.h.clock.advance(30_000);
        await run.wake();
        await vi.waitFor(async () => {
          expect(await idsIn("safety_pending")).toEqual([]);
        }, WAIT);
        await run.settle();
        expect(run.h.core.recorded.map((call) => [call.at, call.request.caller.requestId])).toEqual([
          [33_000, "safety:evt-1"],
        ]);
        expect(await actorOf().readSafety()).toMatchObject([
          { eventId: "evt-1", state: "done", danger: true, path: "outbox", lineId: "safetyEmergency" },
        ]);
        expect(await actorOf().readHolds()).toEqual([
          {
            eventId: "evt-1",
            holdId: "hold-evt-1",
            rule: "after_safe",
            blocksBooking: true,
            released: false,
          },
        ]);
        expect(after.requests).toHaveLength(2);
        expect(attempts).toHaveLength(1);
        expect(run.h.direct.sent).toEqual([]);
        await vi.waitFor(noSafetyEntry, WAIT);
      },
    );
  });
});

// ---- T-1364: T-1348's new task B and its security reviewer's note a ----------------------------------------------------

/**
 * Makes the actor's storage refuse every write of a pending note (an insert into safety_pending), in this instance and in
 * each one after an eviction: a SQLite trigger kept in the storage refuses it, so `markDangerPending` throws however
 * often it is tried, a resume's included. Clearing a note (a delete) still runs.
 */
function refuseNotes(): Promise<void> {
  return exec(
    `CREATE TRIGGER refuse_note BEFORE INSERT ON safety_pending
     BEGIN SELECT RAISE(ABORT, 'the storage refused'); END`,
  );
}

/** A text's line mark as its row keeps it: 1 while its danger line is not done, 0 once it is, null when never set. */
function lineMarkOf(eventId: string): Promise<number | null> {
  return runInDurableObject(stub(), (_, state) => {
    const row = state.storage.sql
      .exec<{ line_open: number | null }>("SELECT line_open FROM safety_events WHERE event_id = ?", eventId)
      .toArray()[0];
    return row === undefined ? null : row.line_open;
  });
}

/** Linq's double for the direct line, keeping each send tried (its time and key), whether Linq takes it or refuses it. */
function triedDirect(h: Harness, tries: [number, string][]): SafetyDeps["direct"] {
  return {
    send(request) {
      tries.push([h.clock.now(), request.idempotencyKey]);
      return h.direct.send(request);
    },
  };
}

/**
 * Makes the actor's storage throw, inside the actor, at the first write whose statement holds `set`: "SET danger = 1" is
 * `markDanger`'s alone (the danger flag with the line mark, one statement), "SET line_open = 0" the write that clears the
 * mark once the line is done. Every other statement runs as it is. Returns how many it refused.
 */
async function refuseFirstWrite(set: "SET danger = 1" | "SET line_open = 0"): Promise<() => number> {
  let refused = 0;
  await runInDurableObject(stub(), (_, state) => {
    const { sql } = state.storage;
    const run = sql.exec.bind(sql);
    const faulted = (
      query: string,
      ...bindings: SqlStorageValue[]
    ): SqlStorageCursor<Record<string, SqlStorageValue>> => {
      if (refused === 0 && query.includes(set)) {
        refused += 1;
        throw new Error("the storage refused");
      }
      return run(query, ...bindings);
    };
    vi.spyOn(sql, "exec").mockImplementation(faulted);
  });
  return () => refused;
}

const crisis = (eventId: string): SafetyResult => ({ ...asResult(safetyCrisisWords), eventId });

/** Linq's double that keeps each send tried and never answers: a cut comes during it. */
function hangingDirect(h: Harness, tries: [number, string][]): SafetyDeps["direct"] {
  return {
    send(request) {
      tries.push([h.clock.now(), request.idempotencyKey]);
      return new Promise(() => undefined);
    },
  };
}

/** evt-1's hold as a danger's step 1 writes it from An emergency's read: its rule, no id, the booking block. */
const STEP_ONE_HOLD: HoldEntry = {
  eventId: "evt-1",
  holdId: null,
  rule: "after_safe",
  blocksBooking: true,
  released: false,
};

describe("a danger whose line is not done keeps a lasting mark, however its pending note's writes fail, so its line is tried again on the read's schedule until it goes, once (T-1364)", () => {
  it("task B, its first case: with markDangerPending throwing at every write, the hold written and Linq refusing the line, the danger's line mark is set with its flag; it is read again every 30 s, a No is not used, and its line is tried again under the same key at each read that finds danger until Linq takes it, once; then the mark clears and nothing is read or sent again", async () => {
    const tries: [number, string][] = [];
    const rereads = rereadSpans();
    // On arrival and at every re-read but the first, which says No, the read finds An emergency.
    const read = readsBy((eventId, nth) => (nth === 2 ? no(eventId) : emergency(eventId)));
    await withActor(
      {},
      { deps: (h) => ({ ...h.deps, read, direct: triedDirect(h, tries) }) },
      async (run) => {
        run.h.core.down = true;
        run.h.direct.fail = true;
        await refuseNotes();
        await arrive("evt-1", SMOKE_TEXT);
        await run.settle();

        // 0 s: the note's write threw; the hold, the flag with its line mark, the labels and the result were written. The
        // line was tried once, straight through Linq under its noted key, and refused.
        expect(tries).toEqual([[0, LINE_KEY]]);
        expect(run.h.direct.sent).toEqual([]);
        expect(await idsIn("safety_pending")).toEqual([]);
        expect(await actorOf().readHolds()).toEqual([STEP_ONE_HOLD]);
        expect(await keptResults("evt-1")).toEqual([emergency("evt-1")]);
        expect(await actorOf().readSafety()).toMatchObject([
          { eventId: "evt-1", state: "lineFailed", danger: true },
        ]);
        expect(await lineMarkOf("evt-1")).toBe(1);
        expect(await notedLineOf("evt-1")).toBe("safetyEmergency");
        await vi.waitFor(async () => {
          expect(await scheduleOf()).toContainEqual({ kind: "safetyRead", due_ms: 30_000 });
        }, WAIT);

        // 30 s: read again, No: not used (the first verdict stands), and no line is tried. Still no note; the flag, the
        // labels, the kept result and the mark stay, and the next read is 30 s on.
        await run.h.clock.advance(30_000);
        await run.wake();
        await vi.waitFor(() => {
          expect(rereads()).toBe(1);
        }, WAIT);
        expect(read.requests).toHaveLength(2);
        expect(tries).toHaveLength(1);
        expect(await idsIn("safety_pending")).toEqual([]);
        expect(await labelsOf("evt-1")).toEqual(["An emergency"]);
        expect(await keptResults("evt-1")).toEqual([emergency("evt-1")]);
        expect(await actorOf().readSafety()).toMatchObject([
          { eventId: "evt-1", state: "lineFailed", danger: true },
        ]);
        expect(await lineMarkOf("evt-1")).toBe(1);
        await vi.waitFor(async () => {
          expect(await scheduleOf()).toContainEqual({ kind: "safetyRead", due_ms: 60_000 });
        }, WAIT);

        // 60 s: An emergency: applied again, its line is tried again under the same key, and Linq still refuses it.
        await run.h.clock.advance(30_000);
        await run.wake();
        await vi.waitFor(() => {
          expect(tries).toEqual([
            [0, LINE_KEY],
            [60_000, LINE_KEY],
          ]);
        }, WAIT);
        await vi.waitFor(async () => {
          expect(await scheduleOf()).toContainEqual({ kind: "safetyRead", due_ms: 90_000 });
        }, WAIT);
        expect(run.h.direct.sent).toEqual([]);
        expect(await lineMarkOf("evt-1")).toBe(1);

        // Linq takes sends again. 90 s: An emergency: the line goes, once, under the same key, and its record is queued;
        // the mark clears, and nothing is left to read.
        run.h.direct.fail = false;
        await run.h.clock.advance(30_000);
        await run.wake();
        await vi.waitFor(() => {
          expect(run.h.direct.sent).toHaveLength(1);
        }, WAIT);
        await run.settle();
        expect(run.h.direct.sent.map((send) => [send.at, send.idempotencyKey, send.overrideOptout])).toEqual([
          [90_000, LINE_KEY, true],
        ]);
        expect(await lineMarkOf("evt-1")).toBe(0);
        expect(await actorOf().readSafety()).toMatchObject([
          { eventId: "evt-1", state: "done", danger: true, path: "direct", lineId: "safetyEmergency" },
        ]);
        expect((await actorOf().readCopies()).returns).toMatchObject([
          { key: "recordSafetyOutcome:evt-1", call: "recordSafetyOutcome", rank: "danger" },
        ]);
        await vi.waitFor(noSafetyEntry, WAIT);

        // A danger whose line went is not sent again: 30 s and 60 s on, nothing is read or tried.
        await run.h.clock.advance(60_000);
        await run.wake();
        await run.settle();
        expect(read.requests).toHaveLength(4);
        expect(tries).toHaveLength(3);
        expect(run.h.direct.sent).toHaveLength(1);
      },
    );
  });

  it("task B, its second case: cut off during its direct line, then resumed while markDangerPending still throws: its flag and line mark stay, the resume's No is not used, and its line is tried again under the same key at each read that finds danger until Linq takes it, once", async () => {
    const tries: [number, string][] = [];
    const rereads = rereadSpans();
    // After the cut: the resume's read says No, and each later read finds An emergency.
    const after = readsBy((eventId, nth) => (nth === 1 ? no(eventId) : emergency(eventId)));
    await withActor(
      { "evt-1": emergency("evt-1") },
      { deps: (h) => ({ ...h.deps, direct: hangingDirect(h, tries) }) },
      async (run) => {
        run.h.core.down = true;
        await refuseNotes();
        await arrive("evt-1", SMOKE_TEXT);

        // 0 s: the read finds An emergency. The note's write throws; the hold, the flag with its line mark, the labels and
        // the result are written; the line is handed to Linq, which never answers.
        await vi.waitFor(() => {
          expect(tries).toEqual([[0, LINE_KEY]]);
        }, WAIT);
        expect(await actorOf().readSafety()).toMatchObject([
          { eventId: "evt-1", state: "reading", danger: true },
        ]);
        expect(await lineMarkOf("evt-1")).toBe(1);
        expect(await idsIn("safety_pending")).toEqual([]);
        expect(await actorOf().readHolds()).toEqual([STEP_ONE_HOLD]);
        expect(await keptResults("evt-1")).toEqual([emergency("evt-1")]);

        // 1 s: the cut, during the send. 3 s: a new instance resumes it, the core not answering and Linq refusing.
        await run.h.clock.advance(1000);
        run.h.direct.fail = true;
        await run.evict({ ...run.h.deps, read: after, direct: triedDirect(run.h, tries) });
        await run.h.clock.advance(2000);
        await run.wake();

        // Resumed as a danger in application: its note's write throws again, and it is read again at once. The No is not
        // used: still no note, and the hold, the flag, the labels, the kept result and the mark stay; next read 30 s on.
        await vi.waitFor(() => {
          expect(rereads()).toBe(1);
        }, WAIT);
        expect(after.requests).toHaveLength(1);
        expect(await actorOf().readSafety()).toMatchObject([
          { eventId: "evt-1", state: "lineFailed", danger: true },
        ]);
        expect(await idsIn("safety_pending")).toEqual([]);
        expect(await lineMarkOf("evt-1")).toBe(1);
        expect(await actorOf().readHolds()).toEqual([STEP_ONE_HOLD]);
        expect(await labelsOf("evt-1")).toEqual(["An emergency"]);
        expect(await keptResults("evt-1")).toEqual([emergency("evt-1")]);
        expect(tries).toHaveLength(1);
        await vi.waitFor(async () => {
          expect(await scheduleOf()).toContainEqual({ kind: "safetyRead", due_ms: 33_000 });
        }, WAIT);

        // 33 s: An emergency: applied again, its line is tried under the noted key, and Linq refuses it.
        await run.h.clock.advance(30_000);
        await run.wake();
        await vi.waitFor(() => {
          expect(tries).toEqual([
            [0, LINE_KEY],
            [33_000, LINE_KEY],
          ]);
        }, WAIT);
        await vi.waitFor(async () => {
          expect(await scheduleOf()).toContainEqual({ kind: "safetyRead", due_ms: 63_000 });
        }, WAIT);
        expect(await lineMarkOf("evt-1")).toBe(1);

        // Linq takes sends again. 63 s: An emergency: the line goes, once, under the same key; the mark clears.
        run.h.direct.fail = false;
        await run.h.clock.advance(30_000);
        await run.wake();
        await vi.waitFor(() => {
          expect(run.h.direct.sent).toHaveLength(1);
        }, WAIT);
        await run.settle();
        expect(run.h.direct.sent.map((send) => [send.at, send.idempotencyKey, send.overrideOptout])).toEqual([
          [63_000, LINE_KEY, true],
        ]);
        expect(await lineMarkOf("evt-1")).toBe(0);
        expect(await actorOf().readSafety()).toMatchObject([
          { eventId: "evt-1", state: "done", danger: true, path: "direct", lineId: "safetyEmergency" },
        ]);
        await vi.waitFor(noSafetyEntry, WAIT);

        // Its line went: 30 s and 60 s on, nothing is read or tried again.
        await run.h.clock.advance(60_000);
        await run.wake();
        await run.settle();
        expect(after.requests).toHaveLength(3);
        expect(tries).toHaveLength(3);
        expect(run.h.direct.sent).toHaveLength(1);
      },
    );
  });

  it("note a: a danger with no note cut off during the core's call, after its result was kept, with its hold's write refused, then resumed while safety_pending's writes keep failing and every other write succeeds: the resume writes its hold from the kept labels, and its line mark alone keeps it in application, so the read that finds it again sends its line, tried at each such read until it goes, once", async () => {
    const attempts: RecordSafetyOutcomeRequest[] = [];
    const tries: [number, string][] = [];
    // After the cut, every read finds An emergency.
    const after = readsBy((eventId) => emergency(eventId));
    await withActor(
      { "evt-1": emergency("evt-1") },
      { deps: (h) => ({ ...h.deps, core: hangingCore(h, attempts) }) },
      async (run) => {
        await refuseNotes();
        const faults = await faultWrites({ safety_holds: () => true });
        await arrive("evt-1", SMOKE_TEXT);

        // 0 s: the read finds An emergency. The note's and the hold's writes throw; the flag with its line mark, the
        // labels and the result are written; the core is called and never answers.
        await vi.waitFor(() => {
          expect(attempts.map((request) => request.caller.requestId)).toEqual(["safety:evt-1"]);
        }, WAIT);
        expect(faults.refused("safety_holds")).toBe(1);
        expect(await actorOf().readSafety()).toMatchObject([
          { eventId: "evt-1", state: "reading", danger: true },
        ]);
        expect(await lineMarkOf("evt-1")).toBe(1);
        expect(await idsIn("safety_pending")).toEqual([]);
        expect(await actorOf().readHolds()).toEqual([]);
        expect(await keptResults("evt-1")).toEqual([emergency("evt-1")]);

        // 1 s: the cut, during the core's call; the hold's writes go in again, the note's still throw. The core is not
        // answering and Linq refuses at first. 3 s: a new instance resumes it.
        faults.lift();
        await run.h.clock.advance(1000);
        run.h.core.down = true;
        run.h.direct.fail = true;
        await run.evict({ ...run.h.deps, read: after, direct: triedDirect(run.h, tries) });
        await run.h.clock.advance(2000);
        await run.wake();

        // Resumed: its note's write throws again, its hold is written from the kept labels and its result is kept, so
        // only its line mark says it is open. Read again at once, An emergency: applied again, its line is tried straight
        // through Linq, which refuses it; next read 30 s on.
        await vi.waitFor(() => {
          expect(tries).toEqual([[3000, LINE_KEY]]);
        }, WAIT);
        await vi.waitFor(async () => {
          expect(await scheduleOf()).toContainEqual({ kind: "safetyRead", due_ms: 33_000 });
        }, WAIT);
        expect(await idsIn("safety_pending")).toEqual([]);
        expect(await actorOf().readHolds()).toEqual([STEP_ONE_HOLD]);
        expect(await keptResults("evt-1")).toEqual([emergency("evt-1")]);
        expect(await actorOf().readSafety()).toMatchObject([
          { eventId: "evt-1", state: "lineFailed", danger: true },
        ]);
        expect(await lineMarkOf("evt-1")).toBe(1);
        expect(run.h.direct.sent).toEqual([]);

        // Linq takes sends again. 33 s: An emergency: the line goes, once, under the same key; the mark clears.
        run.h.direct.fail = false;
        await run.h.clock.advance(30_000);
        await run.wake();
        await vi.waitFor(() => {
          expect(run.h.direct.sent).toHaveLength(1);
        }, WAIT);
        await run.settle();
        expect(run.h.direct.sent.map((send) => [send.at, send.idempotencyKey, send.overrideOptout])).toEqual([
          [33_000, LINE_KEY, true],
        ]);
        expect(await lineMarkOf("evt-1")).toBe(0);
        await vi.waitFor(noSafetyEntry, WAIT);

        // Its line went: 30 s and 60 s on, nothing is read or tried again, and the core was asked only on arrival.
        await run.h.clock.advance(60_000);
        await run.wake();
        await run.settle();
        expect(after.requests).toHaveLength(2);
        expect(tries).toEqual([
          [3000, LINE_KEY],
          [33_000, LINE_KEY],
        ]);
        expect(run.h.direct.sent).toHaveLength(1);
        expect(attempts).toHaveLength(1);
      },
    );
  });

  it("a danger a late verdict finds, with markDangerPending throwing at every write, cut off during its direct line: no resume takes it (its row is no longer being read), so its line mark alone has it read again on the read's schedule, and its line goes, once", async () => {
    const tries: [number, string][] = [];
    await withActor(
      {},
      {
        deps: (h) => ({
          ...h.deps,
          // The read on arrival answers An emergency at 5 s, past the 4 s deadline.
          read: {
            async read(request) {
              await h.clock.after(5000);
              return verdict(emergency(request.eventId));
            },
          },
          direct: hangingDirect(h, tries),
        }),
      },
      async (run) => {
        run.h.core.down = true;
        await refuseNotes();
        await arrive("evt-1", SMOKE_TEXT);

        // 4 s: no verdict and no danger word: the timeout rule's unread hold, read again 30 s on.
        await run.h.clock.advance(4000);
        await vi.waitFor(async () => {
          expect(await actorOf().readHolds()).toMatchObject([{ eventId: "evt-1", rule: "unread" }]);
        }, WAIT);

        // 5 s: the late verdict, An emergency: the note's write throws; the flag with its line mark is written and the
        // hold takes the unread hold's place; the line is handed to Linq, which never answers.
        await run.h.clock.advance(1000);
        await vi.waitFor(() => {
          expect(tries).toEqual([[5000, LINE_KEY]]);
        }, WAIT);
        expect(await actorOf().readSafety()).toMatchObject([
          { eventId: "evt-1", state: "done", danger: true },
        ]);
        expect(await lineMarkOf("evt-1")).toBe(1);
        expect(await idsIn("safety_pending")).toEqual([]);
        expect(await actorOf().readHolds()).toEqual([STEP_ONE_HOLD]);

        // 6 s: the cut, during the send. A new instance resumes nothing (no row is being read), but the text waits by its
        // mark: read again 30 s after the timeout rule took it.
        await run.h.clock.advance(1000);
        await run.evict({
          ...run.h.deps,
          read: readsBy((eventId) => emergency(eventId)),
          direct: triedDirect(run.h, tries),
        });
        await run.wake();
        await vi.waitFor(async () => {
          expect(await scheduleOf()).toContainEqual({ kind: "safetyRead", due_ms: 34_000 });
        }, WAIT);
        expect(tries).toHaveLength(1);

        // 34 s: An emergency: applied again, its line goes, once, under the same key; the mark clears.
        await run.h.clock.advance(28_000);
        await run.wake();
        await vi.waitFor(() => {
          expect(run.h.direct.sent).toHaveLength(1);
        }, WAIT);
        await run.settle();
        expect(run.h.direct.sent.map((send) => [send.at, send.idempotencyKey, send.overrideOptout])).toEqual([
          [34_000, LINE_KEY, true],
        ]);
        expect(await lineMarkOf("evt-1")).toBe(0);
        await vi.waitFor(noSafetyEntry, WAIT);
        expect(tries).toHaveLength(2);
      },
    );
  });

  it("with the write that sets the flag and its line mark refused as well as the note's, and the line failing: the step that writes what the application came to writes the flag with the mark, so the danger is read again 30 s on and its line goes at the read that finds danger, once", async () => {
    const tries: [number, string][] = [];
    await withActor(
      { "evt-1": emergency("evt-1") },
      { deps: (h) => ({ ...h.deps, direct: triedDirect(h, tries) }) },
      async (run) => {
        run.h.core.down = true;
        run.h.direct.fail = true;
        await refuseNotes();
        const refused = await refuseFirstWrite("SET danger = 1");
        await arrive("evt-1", SMOKE_TEXT);
        await run.settle();

        // 0 s: the note's write and step 1's write of the flag with its mark threw; the line was tried and refused. The
        // flag and the mark are written together after the send, and the next read is 30 s on.
        expect(refused()).toBe(1);
        expect(tries).toEqual([[0, LINE_KEY]]);
        expect(await idsIn("safety_pending")).toEqual([]);
        expect(await actorOf().readHolds()).toEqual([STEP_ONE_HOLD]);
        expect(await actorOf().readSafety()).toMatchObject([
          { eventId: "evt-1", state: "lineFailed", danger: true },
        ]);
        expect(await lineMarkOf("evt-1")).toBe(1);
        await vi.waitFor(async () => {
          expect(await scheduleOf()).toContainEqual({ kind: "safetyRead", due_ms: 30_000 });
        }, WAIT);

        // Linq takes sends again. 30 s: An emergency: the line goes, once, under the same key; the mark clears.
        run.h.direct.fail = false;
        await run.h.clock.advance(30_000);
        await run.wake();
        await vi.waitFor(() => {
          expect(run.h.direct.sent).toHaveLength(1);
        }, WAIT);
        await run.settle();
        expect(run.h.direct.sent.map((send) => [send.at, send.idempotencyKey, send.overrideOptout])).toEqual([
          [30_000, LINE_KEY, true],
        ]);
        expect(await lineMarkOf("evt-1")).toBe(0);
        await vi.waitFor(noSafetyEntry, WAIT);
        expect(tries).toHaveLength(2);
      },
    );
  });

  it.each(["direct", "outbox"] as const)(
    "a danger whose line went is not sent again: with markDangerPending throwing at every write, the line goes on its first application (%s), its mark clears with it, and 30 s and 60 s on nothing is read, tried or recorded again",
    async (path) => {
      const tries: [number, string][] = [];
      const calls: RecordSafetyOutcomeRequest[] = [];
      await withActor(
        { "evt-1": emergency("evt-1") },
        { deps: (h) => ({ ...h.deps, core: countingCore(h, calls), direct: triedDirect(h, tries) }) },
        async (run) => {
          run.h.core.down = path === "direct";
          await refuseNotes();
          await arrive("evt-1", SMOKE_TEXT);
          await run.settle();

          expect(await idsIn("safety_pending")).toEqual([]);
          expect(await lineMarkOf("evt-1")).toBe(0);
          expect(await actorOf().readSafety()).toMatchObject([
            { eventId: "evt-1", state: "done", danger: true, path, lineId: "safetyEmergency" },
          ]);
          expect(calls).toHaveLength(1);
          expect(tries).toEqual(path === "direct" ? [[0, LINE_KEY]] : []);
          await vi.waitFor(noSafetyEntry, WAIT);

          for (const at of [30_000, 60_000]) {
            await run.h.clock.advance(at - run.h.clock.now());
            await run.wake();
            await run.settle();
          }
          expect(run.h.read.requests).toHaveLength(1);
          expect(calls).toHaveLength(1);
          expect(tries).toHaveLength(path === "direct" ? 1 : 0);
          expect(run.h.direct.sent).toHaveLength(path === "direct" ? 1 : 0);
          expect(await lineMarkOf("evt-1")).toBe(0);
        },
      );
    },
  );

  it("a danger whose line went, applied again for its missing hold while Linq refuses the repeat: its line mark stays clear, so once its hold is written nothing is read or tried again", async () => {
    const tries: [number, string][] = [];
    await withActor(
      { "evt-1": emergency("evt-1") },
      { deps: (h) => ({ ...h.deps, direct: triedDirect(h, tries) }) },
      async (run) => {
        run.h.core.down = true;
        await refuseNotes();
        const faults = await faultWrites({ safety_holds: () => true });
        await arrive("evt-1", SMOKE_TEXT);
        await run.settle();

        // 0 s: no note and no hold; the line went, once, and its mark cleared with it.
        expect(run.h.direct.sent.map((send) => [send.at, send.idempotencyKey])).toEqual([[0, LINE_KEY]]);
        expect(await actorOf().readHolds()).toEqual([]);
        expect(await lineMarkOf("evt-1")).toBe(0);

        // 30 s: Linq refuses sends now. The hold's write still throws, so the danger is read again and applied again for
        // its hold (T-1348); its line is tried under the same key and refused, and its mark stays clear.
        run.h.direct.fail = true;
        await run.h.clock.advance(30_000);
        await run.wake();
        await vi.waitFor(() => {
          expect(tries).toEqual([
            [0, LINE_KEY],
            [30_000, LINE_KEY],
          ]);
        }, WAIT);
        await run.settle();
        expect(await lineMarkOf("evt-1")).toBe(0);
        expect(await actorOf().readHolds()).toEqual([]);

        // The storage takes the hold's writes again. 60 s: the danger lacks only its hold: written from the kept labels,
        // it is complete, with no read sent. 90 s and 120 s: nothing is read or tried again.
        faults.lift();
        for (const at of [60_000, 90_000, 120_000]) {
          await run.h.clock.advance(at - run.h.clock.now());
          await run.wake();
          await run.settle();
        }
        expect(await actorOf().readHolds()).toEqual([KEPT_HOLD]);
        await vi.waitFor(noSafetyEntry, WAIT);
        expect(run.h.read.requests).toHaveLength(2);
        expect(tries).toHaveLength(2);
        expect(run.h.direct.sent).toHaveLength(1);
        expect(await lineMarkOf("evt-1")).toBe(0);
      },
    );
  });

  it("a danger whose line went but whose line mark could not be cleared counts its line as not done: its noted line stays, so the read that finds danger again, another danger this time, repeats the noted line under the same key, never another line, and then the mark clears", async () => {
    const read = readsBy((eventId, nth) => (nth === 1 ? emergency(eventId) : crisis(eventId)));
    await withActor({}, { deps: (h) => ({ ...h.deps, read }) }, async (run) => {
      run.h.core.down = true;
      await refuseNotes();
      const refused = await refuseFirstWrite("SET line_open = 0");
      await arrive("evt-1", SMOKE_TEXT);
      await run.settle();

      // 0 s: the line went, once, and its record is queued; the write that clears its mark threw, so the mark and the
      // noted line stay, and it is read again 30 s on.
      expect(refused()).toBe(1);
      expect(run.h.direct.sent.map((send) => [send.at, send.idempotencyKey])).toEqual([[0, LINE_KEY]]);
      expect(await lineMarkOf("evt-1")).toBe(1);
      expect(await notedLineOf("evt-1")).toBe("safetyEmergency");
      await vi.waitFor(async () => {
        expect(await scheduleOf()).toContainEqual({ kind: "safetyRead", due_ms: 30_000 });
      }, WAIT);

      // 30 s: Crisis words, whose own line is another: the noted line goes again under its key, which Linq takes as one
      // message, and the mark clears.
      await run.h.clock.advance(30_000);
      await run.wake();
      await vi.waitFor(() => {
        expect(run.h.direct.sent).toHaveLength(2);
      }, WAIT);
      await run.settle();
      expect(run.h.direct.sent.map((send) => [send.at, send.idempotencyKey])).toEqual([
        [0, LINE_KEY],
        [30_000, LINE_KEY],
      ]);
      expect(await labelsOf("evt-1")).toEqual(["An emergency", "Crisis words"]);
      expect(await lineMarkOf("evt-1")).toBe(0);
      await vi.waitFor(noSafetyEntry, WAIT);
    });
  });

  it("an actor whose safety_events table was made before the line mark gains its column as it starts, its rows unmarked; a danger read after that gets its mark in the write that sets its flag", async () => {
    const attempts: RecordSafetyOutcomeRequest[] = [];
    await withActor({ "evt-2": emergency("evt-2") }, {}, async (run) => {
      // The table as it was made before T-1364, holding a danger from then.
      await runInDurableObject(stub(), (_, state) => {
        const { sql } = state.storage;
        sql.exec("DROP TABLE safety_events");
        sql.exec(
          `CREATE TABLE safety_events (
             event_id TEXT PRIMARY KEY,
             arrived_ms INTEGER NOT NULL,
             state TEXT NOT NULL,
             danger INTEGER NOT NULL DEFAULT 0,
             path TEXT,
             line_id TEXT,
             handed_after_ms INTEGER
           )`,
        );
        sql.exec(
          `INSERT INTO safety_events (event_id, arrived_ms, state, danger, path, line_id, handed_after_ms)
           VALUES ('evt-old', 0, 'done', 1, 'outbox', 'safetyEmergency', 10)`,
        );
        sql.exec(
          `INSERT INTO safety_holds (event_id, hold_id, rule, blocks_booking, released)
           VALUES ('evt-old', 'hold-old', 'after_safe', 0, 1)`,
        );
      });

      // A new instance starts over that storage: the column is added, and the old row reads unmarked.
      await run.evict({ ...run.h.deps, core: hangingCore(run.h, attempts) });
      expect(await lineMarkOf("evt-old")).toBeNull();
      expect(await actorOf().readSafety()).toMatchObject([
        { eventId: "evt-old", state: "done", danger: true, path: "outbox" },
      ]);

      // A danger read now, its core call never answered: step 1 has written its flag and its mark together.
      await arrive("evt-2", SMOKE_TEXT);
      await vi.waitFor(() => {
        expect(attempts.map((request) => request.caller.requestId)).toEqual(["safety:evt-2"]);
      }, WAIT);
      expect(await actorOf().readSafety()).toMatchObject([
        { eventId: "evt-old", danger: true },
        { eventId: "evt-2", state: "reading", danger: true },
      ]);
      expect(await lineMarkOf("evt-2")).toBe(1);
      expect(await lineMarkOf("evt-old")).toBeNull();
    });
  });
});
