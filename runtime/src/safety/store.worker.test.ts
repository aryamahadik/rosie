// ADR-015's card A, the store (T-1262; the D-017 path audit's STORE; DL-508), run inside the Workers runtime: the arrival
// safety read's result kept sealed in the handle actor's own storage until its turn commits. The actor is the real
// Durable Object reached through the gateway's door; the safety read, the shared core, the Linq send and the clock are the
// doubles of ./test-support, and a turn's commit goes through the actor's own lease to K-05's double, as in
// ./resume.worker.test.ts. Each test proves a line of the record's section 5, card A, "Proves it with", or a lead note of
// DL-508. Where a test makes a seal fail, hang or wait, it does so at the platform's WebCrypto encrypt, for one text's
// result only; where it makes a write throw, a SQLite trigger refuses it. `resultsOf` and `closeResults` are reached on
// the actor's own safety read, inside the actor (card B wires them to the lease). Test values only (rule 9).
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
  type SealedHandoff,
} from "../gateway";
import { openWords, sealWords, type SealedBox, type SealedWords, type SealingKey } from "../gateway/seal";
import { fakeKeyStore, present } from "../gateway/test-support";
import {
  setBatchHooks,
  setBundleDeps,
  setLeaseHooks,
  setSafetyDeps,
  type ClosedBatch,
  type CommitAnswer,
  type CommitContext,
  type CommitTurnAnswer,
  type CommitTurnRequest,
  type HandleActor,
  type HoldEntry,
  type LeasedTurn,
  type OpenHold,
  type SafetyEntry,
} from "../actor";
import type { ModelCall } from "../trace/types";
import type { SafetyOnArrival } from "./arrival";
import { timeoutResult } from "./rules";
import { fakeRead, harness, type Harness } from "./test-support";
import {
  SAFETY_LINE_BUDGET_MS,
  type DirectLineRequest,
  type RecordSafetyOutcomeRequest,
  type SafetyDeps,
  type SafetyReadAnswer,
  type SafetyReadPort,
  type SafetyReadRequest,
  type SafetyResult,
} from "./types";

type Json = Record<string, unknown>;

const BUNDLE = { hash: "a".repeat(64), build: 1 };
const TRACE = "11111111-2222-4333-8444-555555555555";
const ALEX = "phone:+15555550101";
const ALEX_HANDLE = { kind: "phone", address: "+15555550101" };
const keys = fakeKeyStore();

const EMERGENCY_TEXT = "my lips are swelling after the beard color and I can't breathe well";
const PLAIN_TEXT = "Can I get a haircut on Thursday afternoon?";
/** A danger the bundle's danger-word list does not hold, so only a read can find it. */
const SMOKE_TEXT = "there is smoke pouring out of the dryer in the back room";
const STOP_TEXT = "STOP";

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
interface StoreRpc {
  readSafety(): Promise<SafetyEntry[]>;
  readHolds(): Promise<HoldEntry[]>;
  routineHeld(): Promise<boolean>;
  markHoldReleased(holdId: string): Promise<"released" | "neverReleased" | "noSuchHold">;
  writeSafetyOnReturn(): Promise<number>;
  safetyIdle(): Promise<void>;
  batchIdle(): Promise<void>;
}

function actorOf(): StoreRpc {
  return stub();
}

async function arrive(eventId: string, body: string): Promise<SealedHandoff> {
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
  return prepared.handoff;
}

/** The actor's stored schedule, earliest first. */
function scheduleOf(): Promise<{ kind: string; due_ms: number }[]> {
  return runInDurableObject(stub(), (_, state) =>
    state.storage.sql
      .exec<{ kind: string; due_ms: number }>("SELECT kind, due_ms FROM batch_schedule ORDER BY due_ms, kind")
      .toArray(),
  );
}

const asResult = (fixture: unknown): SafetyResult => fixture as SafetyResult;
const no = (eventId: string): SafetyResult => ({ ...asResult(safetyNo), eventId });
const emergency = (eventId: string): SafetyResult => ({ ...asResult(safetyEmergencyNow), eventId });
const crisis = (eventId: string): SafetyResult => ({ ...asResult(safetyCrisisWords), eventId });

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

/** The read's own no-verdict answer (K-02 `timedOut`, no read): both models timed out. */
function gaveUp(eventId: string): SafetyReadAnswer {
  const call = (model: string, role: "haiku" | "sonnet"): ModelCall => ({
    model,
    role,
    purpose: "safetyRead",
    input_tokens: 400,
    cached_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 0,
    cost_micro_usd: 400,
    ms: 2000,
    outcome: "timedOut",
  });
  return {
    result: timeoutResult(eventId, []),
    modelCalls: [call("claude-haiku-5-5", "haiku"), call("claude-sonnet-5-5", "sonnet")],
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

// ---- inside the actor --------------------------------------------------------------------------------------------------

/** The actor's own safety read, reached inside the actor. */
function safetyOf(instance: HandleActor): SafetyOnArrival {
  return (instance as unknown as { safety: SafetyOnArrival }).safety;
}

function resultsOf(eventIds: readonly string[]): Promise<readonly SafetyResult[]> {
  return runInDurableObject(stub(), (instance) => safetyOf(instance).resultsOf(eventIds));
}

/** Closes these texts inside a storage transaction, as the step that ends their turn for good does (card B). */
function closeResults(eventIds: readonly string[]): Promise<void> {
  return runInDurableObject(stub(), (instance, state) => {
    state.storage.transactionSync(() => {
      safetyOf(instance).closeResults(eventIds);
    });
  });
}

function unreadTexts(): Promise<string[]> {
  return runInDurableObject(stub(), (instance) => safetyOf(instance).unreadTexts());
}

function unreadAmong(eventIds: readonly string[]): Promise<boolean> {
  return runInDurableObject(stub(), (instance) => safetyOf(instance).unreadAmong(eventIds));
}

interface ResultRow extends Record<string, SqlStorageValue> {
  event_id: string;
  box: string | null;
}

/** The kept results' rows, as stored. */
function rowsOf(): Promise<ResultRow[]> {
  return runInDurableObject(stub(), (_, state) =>
    state.storage.sql.exec<ResultRow>("SELECT event_id, box FROM safety_results ORDER BY rowid").toArray(),
  );
}

/** The event ids a safety table of event ids holds, in the order written. */
function idsIn(
  table: "safety_closed" | "safety_pending" | "safety_noted_lines" | "safety_line_done",
): Promise<string[]> {
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

function exec(query: string, ...bindings: SqlStorageValue[]): Promise<void> {
  return runInDurableObject(stub(), (_, state) => {
    state.storage.sql.exec(query, ...bindings);
  });
}

/** A storage that throws at every insert into (or update of) this table: a SQLite trigger refuses it. */
function refuse(table: string, write: "INSERT" | "UPDATE"): Promise<void> {
  return exec(
    `CREATE TRIGGER refuse_${write.toLowerCase()}_${table} BEFORE ${write} ON ${table}
     BEGIN SELECT RAISE(ABORT, 'the storage refused'); END`,
  );
}

/** Opens a box as a test does, under a key, an actor name and a name; throws when it does not open. */
async function openBox(
  box: string,
  name: string,
  actorName = ALEX,
  key: SealingKey = keys.keyOf(ALEX_HANDLE),
): Promise<unknown> {
  const opened = await openWords(JSON.parse(box) as SealedBox, key, actorName, name);
  return JSON.parse(opened.body ?? "null") as unknown;
}

/** Every string held in every table of the actor's storage. */
function plainValues(): Promise<string[]> {
  return runInDurableObject(stub(), (_, state) => {
    const { sql } = state.storage;
    const tables = sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .toArray()
      .map((row) => row.name)
      .filter((name) => !name.startsWith("sqlite_") && !name.startsWith("_cf_"));
    const values: string[] = [];
    for (const name of tables) {
      for (const row of sql.exec(`SELECT * FROM "${name}"`).toArray()) {
        for (const value of Object.values(row)) if (typeof value === "string") values.push(value);
      }
    }
    return values;
  });
}

/** What K-34 seals of a result: each label's evidence words, who is at risk and who wrote it, and the danger words. */
function wordsOf(result: SafetyResult): string[] {
  const labels = result.read?.labels ?? [];
  return [
    ...labels.flatMap((label) => [label.evidence, label.atRisk, label.writer]),
    ...result.dangerWords.map((match) => match.words),
  ].filter((words) => words.trim() !== "");
}

async function expectNoPlainWords(result: SafetyResult): Promise<void> {
  const words = wordsOf(result);
  expect(words.length).toBeGreaterThan(0);
  const values = await plainValues();
  expect(values.length).toBeGreaterThan(0);
  for (const word of words)
    expect(
      values.filter((value) => value.includes(word)),
      word,
    ).toEqual([]);
}

interface SealFault {
  /** How many seals of the text's result reached the platform's encrypt. */
  calls(): number;
  /** Lets a seal waiting at the gate go on. */
  open(): void;
}

/**
 * Makes the seal of one text's kept result fail, hang, or wait at a gate the test opens, at the platform's WebCrypto
 * encrypt: only a seal whose additional data is `<actor name>|result:<event id>`, and only its first `times`; every
 * other seal (the gateway's, the write-on-return queue's) runs as it is.
 */
function faultSeal(
  eventId: string,
  fault: "fail" | "hang" | "gate",
  times = Number.POSITIVE_INFINITY,
): SealFault {
  const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  const name = `${ALEX}|result:${eventId}`;
  let calls = 0;
  let opened = false;
  vi.spyOn(crypto.subtle, "encrypt").mockImplementation(async (algorithm, key, data) => {
    const named = typeof algorithm === "object" ? algorithm.additionalData : undefined;
    if (named !== undefined && new TextDecoder().decode(named) === name) {
      calls += 1;
      if (calls <= times) {
        if (fault === "fail") throw new Error("the seal failed");
        if (fault === "hang") return new Promise<ArrayBuffer>(() => undefined);
        while (!opened) await new Promise((resolve) => setTimeout(resolve, 1));
      }
    }
    return encrypt(algorithm, key, data);
  });
  return {
    calls: () => calls,
    open: () => {
      opened = true;
    },
  };
}

/** One storage write of a safety table naming the watched text, or the moment the text's line was handed on. */
interface Write {
  table: string;
  query: string;
  bindings: SqlStorageValue[];
  /** The turn of the event loop it ran in: a later turn only after an await. */
  turn: number;
  at: number;
}

const WRITE = /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+(\w+)/i;

/**
 * Watches, inside the actor, each write of a safety table that names this text, in order. A write runs in a later turn
 * than the one before it only when the code awaited between them: the microtask queued at a write has run by the next
 * write only then.
 */
async function watchWrites(eventId: string, writes: Write[]): Promise<void> {
  await runInDurableObject(stub(), (_, state) => {
    const { sql } = state.storage;
    const run = sql.exec.bind(sql);
    let turn = 0;
    let awaited = false;
    const watched = (
      query: string,
      ...bindings: SqlStorageValue[]
    ): SqlStorageCursor<Record<string, SqlStorageValue>> => {
      const table = WRITE.exec(query)?.[1];
      if (table?.startsWith("safety_") === true && bindings.includes(eventId)) {
        if (awaited) turn += 1;
        awaited = false;
        queueMicrotask(() => {
          awaited = true;
        });
        writes.push({ table, query, bindings, turn, at: performance.now() });
      }
      return run(query, ...bindings);
    };
    vi.spyOn(sql, "exec").mockImplementation(watched);
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
  /** The safety doubles in place from the start. */
  deps: SafetyDeps;
  lease: Lease;
  /** Every batch handed on, with no lease wired. */
  handed: ClosedBatch[];
  /** Cuts the actor off (its memory goes; its storage and alarm stay), then puts `next` in place. */
  evict(next?: SafetyDeps): Promise<void>;
  /** Wakes the actor the way its stored alarm does. */
  wake(): Promise<void>;
  /** Settles the safety work and the batch work of what has arrived. */
  settle(): Promise<void>;
}

/**
 * Runs a test body with the doubles set for the isolate and put back after: the read answers `answers` after `delayMs`
 * on the fake clock, unless `deps` gives other doubles. With `lease`, closed batches go to the actor's own turn lease,
 * whose commit is K-05's double (each context kept); else each closed batch is kept in `handed`.
 */
async function withActor(
  answers: Record<string, SafetyResult>,
  options: { delayMs?: number; deps?: (h: Harness) => SafetyDeps; lease?: boolean },
  body: (run: Run) => Promise<void>,
): Promise<void> {
  const h = harness(keys, answers, { delayMs: options.delayMs ?? 0 });
  const deps = options.deps?.(h) ?? h.deps;
  const restores: (() => void)[] = [setSafetyDeps(deps)];
  const lease: Lease = { turns: [], contexts: [] };
  const handed: ClosedBatch[] = [];
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
    restores.push(
      setBatchHooks({
        clock: h.clock,
        toLease: (batch) => {
          handed.push(batch);
        },
      }),
    );
  }
  const run: Run = {
    h,
    deps,
    lease,
    handed,
    async evict(next) {
      const cut = await runInDurableObject(stub(), async (_, state) => {
        await state.storage.sync();
        state.abort("cut off mid-seal");
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

// ---- card A's proofs ---------------------------------------------------------------------------------------------------

describe("a No verdict (safety-no.json)", () => {
  it("keeps one row whose box opens, under the handle's key, the actor name and result:<event id>, to exactly the result the read port answered, and under no other event id or actor name nor as the text's words; no plain value in any of the actor's tables holds an evidence word, who is at risk, who wrote it or a danger word", async () => {
    const answer = asResult(safetyNo);
    await withActor({ [answer.eventId]: answer }, {}, async (run) => {
      await arrive(answer.eventId, PLAIN_TEXT);
      await run.settle();
      expect(run.h.read.requests.map((request) => request.eventId)).toEqual([answer.eventId]);

      const rows = await rowsOf();
      expect(rows.map((row) => row.event_id)).toEqual([answer.eventId]);
      const box = present(rows[0]?.box, "the kept box");
      expect(await openBox(box, `result:${answer.eventId}`)).toEqual(answer);
      await expect(openBox(box, "result:evt-alex-0202")).rejects.toThrow();
      await expect(openBox(box, `result:${answer.eventId}`, "phone:+15555550199")).rejects.toThrow();
      await expect(openBox(box, answer.eventId)).rejects.toThrow();
      const otherKey = crypto.getRandomValues(new Uint8Array(32));
      await expect(openBox(box, `result:${answer.eventId}`, ALEX, otherKey)).rejects.toThrow();
      expect(await resultsOf([answer.eventId])).toEqual([answer]);

      await expectNoPlainWords(answer);
    });
  });
});

describe("a danger verdict (safety-emergency-now.json)", () => {
  it("writes its owed row, its labels, its pending note, its hold and its flag with no await between them, and keeps its box before its line is sent; the seal's time before the line is measured against arch 04 line 211's 5 s", async ({
    annotate,
  }) => {
    const answer = emergency("evt-1");
    const writes: Write[] = [];
    let verdictAt = 0;
    let lineAt = 0;
    await withActor(
      { "evt-1": answer },
      {
        delayMs: 1000,
        deps: (h) => ({
          ...h.deps,
          read: {
            async read(request) {
              const got = await h.read.read(request);
              verdictAt = performance.now();
              return got;
            },
          },
          core: {
            ...h.core,
            recordSafetyOutcome(request) {
              lineAt = performance.now();
              writes.push({ table: "the line", query: "", bindings: [], turn: -1, at: lineAt });
              return h.core.recordSafetyOutcome(request);
            },
          },
        }),
      },
      async (run) => {
        await arrive("evt-1", EMERGENCY_TEXT);
        await watchWrites("evt-1", writes);
        await run.h.clock.advance(1000);
        await run.settle();

        expect(run.h.core.recorded.map((call) => [call.at, call.request.safety])).toEqual([[1000, answer]]);
        expect(writes.slice(0, 7).map((write) => write.table)).toEqual([
          "safety_results",
          "safety_outcomes",
          "safety_pending",
          "safety_holds",
          "safety_events",
          "safety_results",
          "the line",
        ]);
        const [owed, labels, noted, hold, flag, kept] = writes;
        // Step 1: the owed row (no box), then the labels, the pending note, the hold and the flag, in one turn of the
        // event loop: no await between them.
        expect(present(owed).query).toContain("NULL");
        expect(present(hold).query).toContain("INSERT OR REPLACE INTO safety_holds");
        expect(present(flag).query).toContain("SET danger = 1");
        expect([owed, labels, noted, hold, flag].map((write) => present(write).turn)).toEqual(
          Array.from({ length: 5 }, () => present(owed).turn),
        );
        // Steps 2 and 3: the box is kept after the seal's await, before the line.
        expect(present(kept).query).toContain("SET box = ?");
        expect(present(kept).turn).toBeGreaterThan(present(flag).turn);
        expect(typeof present(kept).bindings[0]).toBe("string");
        expect(await resultsOf(["evt-1"])).toEqual([answer]);

        // The seal (step 2) and the keep (step 3) between step 1 and the line, measured in real time.
        const sealMs = present(kept).at - present(flag).at;
        const toLineMs = lineAt - verdictAt;
        await annotate(
          `seal and keep before the line: ${sealMs.toFixed(3)} ms; verdict to line: ${toLineMs.toFixed(3)} ms; ` +
            `arch 04 line 211's budget: ${String(SAFETY_LINE_BUDGET_MS)} ms`,
        );
        expect(sealMs).toBeLessThan(SAFETY_LINE_BUDGET_MS / 5);
        expect(toLineMs).toBeLessThan(SAFETY_LINE_BUDGET_MS / 5);
      },
    );
  });

  it("with the labels insert throwing, its line still goes, with its owed row kept, its pending note, hold and flag written", async () => {
    const answer = emergency("evt-1");
    await withActor({ "evt-1": answer }, {}, async (run) => {
      await refuse("safety_outcomes", "INSERT");
      await arrive("evt-1", EMERGENCY_TEXT);
      await run.settle();

      expect(run.h.core.recorded.map((call) => call.request.safety)).toEqual([answer]);
      expect(await actorOf().readSafety()).toMatchObject([
        { eventId: "evt-1", state: "done", danger: true, path: "outbox", lineId: "safetyEmergency" },
      ]);
      expect(await actorOf().readHolds()).toMatchObject([
        { eventId: "evt-1", holdId: "hold-evt-1", rule: "after_safe", released: false },
      ]);
      expect(await labelsOf("evt-1")).toEqual([]);
      expect(await resultsOf(["evt-1"])).toEqual([answer]);
      expect(await idsIn("safety_pending")).toEqual([]);
    });
  });

  it("with the seal failing, the owed row keeps the text among unreadTexts and routineHeld and out of resultsOf while finish writes danger, and unreadAmong counts it read", async () => {
    const answer = emergency("evt-1");
    await withActor({ "evt-1": answer }, {}, async (run) => {
      const seal = faultSeal("evt-1", "fail");
      await arrive("evt-1", EMERGENCY_TEXT);
      await run.settle();

      expect(seal.calls()).toBe(1);
      // The line went (the core's outbox row) and its record is kept.
      expect(run.h.core.recorded.map((call) => call.request.safety)).toEqual([answer]);
      expect(await rowsOf()).toEqual([{ event_id: "evt-1", box: null }]);
      expect(await actorOf().readSafety()).toMatchObject([
        { eventId: "evt-1", state: "done", danger: true, path: "outbox" },
      ]);
      expect(await unreadTexts()).toEqual(["evt-1"]);
      expect(await actorOf().routineHeld()).toBe(true);
      expect(await resultsOf(["evt-1"])).toEqual([]);
      expect(await unreadAmong(["evt-1"])).toBe(false);
      // Read for its batch: the batch closed at once on its danger and went on.
      await vi.waitFor(() => {
        expect(run.handed.map((batch) => batch.entries.map((entry) => entry.event.eventId))).toEqual([
          ["evt-1"],
        ]);
      }, WAIT);
      // Its result not settled, it stays pending (its line and record done) and is read again 30 s on.
      expect(await idsIn("safety_pending")).toEqual(["evt-1"]);
      expect(await idsIn("safety_line_done")).toEqual(["evt-1"]);
      await vi.waitFor(async () => {
        expect(await scheduleOf()).toContainEqual({ kind: "safetyRead", due_ms: 30_000 });
      }, WAIT);
    });
  });

  it("through an eviction during the seal and a new instance's resumeCutOff (line 440), the text has its labels, its hold and its flag, the danger stays pending, and its next re-read that finds danger keeps the result and sends the line", async () => {
    const answer = emergency("evt-1");
    await withActor({ "evt-1": answer }, {}, async (run) => {
      const seal = faultSeal("evt-1", "hang");
      await arrive("evt-1", SMOKE_TEXT);
      await vi.waitFor(() => {
        expect(seal.calls()).toBe(1);
      }, WAIT);
      // During the seal: step 1 is written, the line is not sent.
      expect(await rowsOf()).toEqual([{ event_id: "evt-1", box: null }]);
      expect(run.h.core.recorded).toEqual([]);

      // 1 s: the cut, during the seal. The new instance's re-read answers 0.5 s after it is sent.
      await run.h.clock.advance(1000);
      vi.restoreAllMocks();
      await run.evict({ ...run.h.deps, read: fakeRead(run.h.clock, { "evt-1": answer }, 500) });
      await run.wake();
      await vi.waitFor(async () => {
        expect(await actorOf().readSafety()).toMatchObject([
          { eventId: "evt-1", state: "lineFailed", danger: true },
        ]);
      }, WAIT);
      expect(await labelsOf("evt-1")).toEqual(["An emergency"]);
      expect(await actorOf().readHolds()).toEqual([
        { eventId: "evt-1", holdId: null, rule: "after_safe", blocksBooking: true, released: false },
      ]);
      expect(await idsIn("safety_pending")).toEqual(["evt-1"]);
      expect(await rowsOf()).toEqual([{ event_id: "evt-1", box: null }]);
      expect(await unreadTexts()).toEqual(["evt-1"]);
      expect(await unreadAmong(["evt-1"])).toBe(false);
      expect(await resultsOf(["evt-1"])).toEqual([]);
      expect(run.h.core.recorded).toEqual([]);

      // 1.5 s: the re-read finds danger: the result is kept and the line goes, once; the danger is complete.
      await run.h.clock.advance(500);
      await vi.waitFor(() => {
        expect(run.h.core.recorded).toHaveLength(1);
      }, WAIT);
      expect(run.h.core.recorded[0]).toMatchObject({ at: 1500, request: { safety: answer } });
      await vi.waitFor(async () => {
        expect(await idsIn("safety_pending")).toEqual([]);
      }, WAIT);
      expect(await resultsOf(["evt-1"])).toEqual([answer]);
      expect(await unreadTexts()).toEqual([]);
    });
  });
});

describe("a STOP batched behind an owed danger whose re-reads answer No", () => {
  /** evt-1's first read says An emergency, and the STOP's (evt-2's) says No, each 1 s after it is sent; later reads say No at once. */
  function reads(h: Harness, requests: SafetyReadRequest[]): SafetyReadPort {
    return {
      async read(request) {
        requests.push(request);
        const nth = requests.filter((each) => each.eventId === request.eventId).length;
        if (nth > 1) return verdict(no(request.eventId));
        await h.clock.after(1000);
        return verdict(request.eventId === "evt-1" ? emergency("evt-1") : no(request.eventId));
      },
    };
  }

  describe.each([
    ["its seal fails", "fail"],
    ["an eviction during its seal", "evict"],
  ] as const)("the danger's result owed: %s", (_cause, fault) => {
    it.each(["its batch", "the next batch"] as const)(
      "a STOP in %s reaches the lease on the run that takes it, never waiting on the re-reads, and its turn's commit through the actor's own lease commits on that run, handed the owed text in CommitContext.unread and the danger's hold among the holds; the owed text is read again every 30 s meanwhile",
      async (where) => {
        const requests: SafetyReadRequest[] = [];
        const readsOf = (eventId: string): number =>
          requests.filter((request) => request.eventId === eventId).length;
        await withActor(
          {},
          { lease: true, deps: (h) => ({ ...h.deps, read: reads(h, requests) }) },
          async (run) => {
            const seal = faultSeal("evt-1", fault === "fail" ? "fail" : "hang");
            await arrive("evt-1", SMOKE_TEXT);
            if (where === "its batch") {
              await run.h.clock.advance(500);
              await arrive("evt-2", STOP_TEXT);
            }
            // 1 s: evt-1's danger verdict; its seal fails, or the actor is cut off during it.
            await run.h.clock.advance(1000 - run.h.clock.now());
            await vi.waitFor(() => {
              expect(seal.calls()).toBe(1);
            }, WAIT);
            if (fault === "evict") {
              vi.restoreAllMocks();
              await run.evict();
              await run.wake();
            } else if (where === "its batch") {
              await run.h.clock.advance(500);
            }

            const hold: OpenHold = {
              eventId: "evt-1",
              holdId: fault === "fail" ? "hold-evt-1" : null,
              rule: "after_safe",
              outcomes: ["An emergency"],
              blocksBooking: true,
            };
            const owedContext: CommitContext = { holds: [hold], unread: ["evt-1"] };
            const first = where === "its batch" ? ["evt-1", "evt-2"] : ["evt-1"];
            await vi.waitFor(() => {
              expect(run.lease.turns.map((turn) => turn.eventIds)).toEqual([first]);
            }, WAIT);
            // It reached the lease while evt-1 is owed, before any 30 s re-read.
            expect(run.h.clock.now()).toBeLessThan(30_000);
            expect(readsOf("evt-1")).toBe(fault === "fail" ? 1 : 2);
            expect(await rowsOf()).toContainEqual({ event_id: "evt-1", box: null });
            const firstTurn = present(run.lease.turns[0], "the first turn");
            expect(firstTurn.holds).toEqual([hold]);
            expect(await commitOf(firstTurn)).toMatchObject({ result: "committed" });
            expect(run.lease.contexts).toEqual([owedContext]);

            if (where === "the next batch") {
              // 2 s: the STOP arrives, read as No at 3 s; its batch closes at 5 s and reaches its own turn.
              await run.h.clock.advance(2000 - run.h.clock.now());
              await arrive("evt-2", STOP_TEXT);
              await run.h.clock.advance(1000);
              await run.settle();
              await run.h.clock.advance(2000);
              await run.wake();
              await vi.waitFor(() => {
                expect(run.lease.turns.map((turn) => turn.eventIds)).toEqual([["evt-1"], ["evt-2"]]);
              }, WAIT);
              const stopTurn = present(run.lease.turns[1], "the STOP's turn");
              expect(stopTurn.holds).toEqual([hold]);
              expect(await commitOf(stopTurn)).toMatchObject({ result: "committed" });
              expect(run.lease.contexts).toEqual([owedContext, owedContext]);
              expect(readsOf("evt-1")).toBe(fault === "fail" ? 1 : 2);
            }
            expect(await resultsOf(["evt-2"])).toEqual([no("evt-2")]);

            // 31 s and 61 s: the owed text is read again (No), each time 30 s on; it stays owed and among the texts not read.
            const before = readsOf("evt-1");
            for (const [at, reread] of [
              [31_000, 1],
              [61_000, 2],
            ] as const) {
              await run.h.clock.advance(at - run.h.clock.now());
              await run.wake();
              await vi.waitFor(async () => {
                expect(readsOf("evt-1")).toBe(before + reread);
                expect(await scheduleOf()).toContainEqual({ kind: "safetyRead", due_ms: at + 30_000 });
              }, WAIT);
            }
            expect(await rowsOf()).toContainEqual({ event_id: "evt-1", box: null });
            expect(await unreadTexts()).toEqual(["evt-1"]);
            expect(await actorOf().routineHeld()).toBe(true);
          },
        );
      },
    );
  });
});

describe("a crash or failed line during a danger, the turn ends, then the re-read", () => {
  it("a danger whose direct line fails, then closeResults([its id]), then its 30 s re-read applying the danger again: no row for the text afterwards, the line's key in the direct double's sends is the noted one only, and the pending note clears once the line and record are done", async () => {
    const answer = emergency("evt-1");
    await withActor({ "evt-1": answer }, {}, async (run) => {
      run.h.core.down = true;
      run.h.direct.fail = true;
      await arrive("evt-1", SMOKE_TEXT);
      await run.settle();
      expect(await actorOf().readSafety()).toMatchObject([
        { eventId: "evt-1", state: "lineFailed", danger: true },
      ]);
      expect(await resultsOf(["evt-1"])).toEqual([answer]);
      expect(await idsIn("safety_noted_lines")).toEqual(["evt-1"]);
      expect(await idsIn("safety_pending")).toEqual(["evt-1"]);

      // Its turn ends: the row goes and the text is closed; its line is not done, so it stays pending.
      await closeResults(["evt-1"]);
      expect(await rowsOf()).toEqual([]);
      expect(await idsIn("safety_closed")).toEqual(["evt-1"]);
      expect(await idsIn("safety_pending")).toEqual(["evt-1"]);

      // 30 s: Linq answers again; the re-read finds danger: the noted line goes and its record waits; nothing is kept.
      run.h.direct.fail = false;
      await run.h.clock.advance(30_000);
      await run.wake();
      await vi.waitFor(() => {
        expect(run.h.direct.sent).toHaveLength(1);
      }, WAIT);
      await vi.waitFor(async () => {
        expect(await idsIn("safety_pending")).toEqual([]);
      }, WAIT);
      expect(run.h.direct.sent.map((send) => send.idempotencyKey)).toEqual(["safety:evt-1:safetyEmergency"]);
      expect(await rowsOf()).toEqual([]);
      expect(await resultsOf(["evt-1"])).toEqual([]);
      expect(await idsIn("safety_noted_lines")).toEqual([]);
      await vi.waitFor(async () => {
        expect((await scheduleOf()).map((entry) => entry.kind)).not.toContain("safetyRead");
      }, WAIT);
      run.h.core.down = false;
      expect(await actorOf().writeSafetyOnReturn()).toBe(1);
      expect(run.h.core.recorded[0]?.request).toMatchObject({
        safety: answer,
        sentByActor: { fixedLineId: "safetyEmergency", linqMessageId: "linq-1" },
      });
    });
  });

  it("a danger whose instance is evicted mid-line, then closeResults([its id]), then its 30 s re-read applying the danger again: no row for the text afterwards, the line's key in the direct double's sends is the noted one only, and the pending note clears once the line and record are done", async () => {
    const answer = emergency("evt-1");
    const attempts: DirectLineRequest[] = [];
    await withActor(
      { "evt-1": answer },
      {
        deps: (h) => ({
          ...h.deps,
          direct: {
            send(request) {
              attempts.push(request);
              return new Promise(() => undefined);
            },
          },
        }),
      },
      async (run) => {
        run.h.core.down = true;
        await arrive("evt-1", SMOKE_TEXT);
        await vi.waitFor(() => {
          expect(attempts).toHaveLength(1);
        }, WAIT);

        // 1 s: the cut, during Linq's send. After it the first read says No, the next An emergency.
        await run.h.clock.advance(1000);
        const after = readsBy((eventId, nth) => (nth === 1 ? no(eventId) : answer));
        await run.evict({ ...run.h.deps, read: after });
        // 4 s: woken; no timeout rule (its danger is pending): read again, No, so nothing is sent.
        await run.h.clock.advance(3000);
        await run.wake();
        await vi.waitFor(async () => {
          expect(after.requests).toHaveLength(1);
          expect(await scheduleOf()).toContainEqual({ kind: "safetyRead", due_ms: 34_000 });
        }, WAIT);
        expect(run.h.direct.sent).toEqual([]);

        await closeResults(["evt-1"]);
        expect(await rowsOf()).toEqual([]);
        expect(await idsIn("safety_pending")).toEqual(["evt-1"]);

        // 34 s: the re-read finds danger: the noted line goes, with the key of the try the cut lost; nothing is kept.
        await run.h.clock.advance(30_000);
        await run.wake();
        await vi.waitFor(() => {
          expect(run.h.direct.sent).toHaveLength(1);
        }, WAIT);
        expect(run.h.direct.sent.map((send) => send.idempotencyKey)).toEqual([
          present(attempts[0]).idempotencyKey,
        ]);
        expect(present(attempts[0]).idempotencyKey).toBe("safety:evt-1:safetyEmergency");
        await vi.waitFor(async () => {
          expect(await idsIn("safety_pending")).toEqual([]);
        }, WAIT);
        expect(await rowsOf()).toEqual([]);
        expect(await resultsOf(["evt-1"])).toEqual([]);
      },
    );
  });

  it("a text closed between step 1 and step 3 keeps nothing", async () => {
    const answer = no("evt-1");
    await withActor({ "evt-1": answer }, {}, async (run) => {
      const seal = faultSeal("evt-1", "gate");
      await arrive("evt-1", PLAIN_TEXT);
      await vi.waitFor(() => {
        expect(seal.calls()).toBe(1);
      }, WAIT);
      expect(await rowsOf()).toEqual([{ event_id: "evt-1", box: null }]);

      await closeResults(["evt-1"]);
      seal.open();
      await run.settle();
      expect(await rowsOf()).toEqual([]);
      expect(await idsIn("safety_closed")).toEqual(["evt-1"]);
      expect(await resultsOf(["evt-1"])).toEqual([]);
      expect(await actorOf().readSafety()).toMatchObject([
        { eventId: "evt-1", state: "done", danger: false },
      ]);
    });
  });
});

describe("the noted danger line on the direct path", () => {
  it("a re-read whose danger chooses another line than the first: the double's sends hold only the first line's key, and the queued record's sentByActor names it", async () => {
    const attempts: string[] = [];
    const read = readsBy((eventId, nth) => (nth === 1 ? emergency(eventId) : crisis(eventId)));
    await withActor(
      {},
      {
        deps: (h) => ({
          ...h.deps,
          read,
          direct: {
            send(request) {
              attempts.push(request.idempotencyKey);
              return h.direct.send(request);
            },
          },
        }),
      },
      async (run) => {
        run.h.core.down = true;
        run.h.direct.fail = true;
        await arrive("evt-1", SMOKE_TEXT);
        await run.settle();
        expect(attempts).toEqual(["safety:evt-1:safetyEmergency"]);
        expect(await idsIn("safety_noted_lines")).toEqual(["evt-1"]);

        // 30 s: the re-read says Crisis words, whose own line is 988 and 911: the noted 911 line goes, with its key.
        run.h.direct.fail = false;
        await run.h.clock.advance(30_000);
        await run.wake();
        await vi.waitFor(() => {
          expect(run.h.direct.sent).toHaveLength(1);
        }, WAIT);
        expect(run.h.direct.sent.map((send) => send.idempotencyKey)).toEqual([
          "safety:evt-1:safetyEmergency",
        ]);
        expect(attempts).toEqual(["safety:evt-1:safetyEmergency", "safety:evt-1:safetyEmergency"]);
        await vi.waitFor(async () => {
          expect(await idsIn("safety_pending")).toEqual([]);
        }, WAIT);
        // The later read still widens the labels and replaces the kept result.
        expect(await labelsOf("evt-1")).toEqual(["An emergency", "Crisis words"]);
        expect(await resultsOf(["evt-1"])).toEqual([crisis("evt-1")]);
        run.h.core.down = false;
        expect(await actorOf().writeSafetyOnReturn()).toBe(1);
        expect(run.h.core.recorded[0]?.request).toMatchObject({
          safety: crisis("evt-1"),
          sentByActor: { fixedLineId: "safetyEmergency" },
        });
      },
    );
  });

  it("with the note's write throwing, the first line still goes on that application, not at the next re-read", async () => {
    const answer = emergency("evt-1");
    await withActor({ "evt-1": answer }, {}, async (run) => {
      run.h.core.down = true;
      await refuse("safety_noted_lines", "INSERT");
      await arrive("evt-1", SMOKE_TEXT);
      await run.settle();

      expect(run.h.direct.sent.map((send) => [send.at, send.idempotencyKey])).toEqual([
        [0, "safety:evt-1:safetyEmergency"],
      ]);
      expect(await actorOf().readSafety()).toMatchObject([
        { eventId: "evt-1", state: "done", danger: true, path: "direct", lineId: "safetyEmergency" },
      ]);
      expect(await idsIn("safety_noted_lines")).toEqual([]);
      expect(await idsIn("safety_pending")).toEqual([]);
      await vi.waitFor(async () => {
        expect((await scheduleOf()).map((entry) => entry.kind)).not.toContain("safetyRead");
      }, WAIT);
      run.h.core.down = false;
      expect(await actorOf().writeSafetyOnReturn()).toBe(1);
      expect(run.h.core.recorded[0]?.request.sentByActor).toMatchObject({ fixedLineId: "safetyEmergency" });
    });
  });
});

describe("what replaces a kept result, and what leaves it as it was", () => {
  it("a timeout with no danger word and then a late verdict leaves the verdict in the row, kept before the unread hold lifts", async () => {
    const answer = no("evt-1");
    await withActor({ "evt-1": answer }, { delayMs: 6000 }, async (run) => {
      await arrive("evt-1", PLAIN_TEXT);
      // 4 s: no verdict and no danger word: the stand-in is kept, with the unread hold and the outage line.
      await run.h.clock.advance(4000);
      await run.settle();
      expect(await resultsOf(["evt-1"])).toEqual([timeoutResult("evt-1", [])]);
      expect(await actorOf().readHolds()).toMatchObject([
        { eventId: "evt-1", rule: "unread", released: false },
      ]);

      // The box the row holds at the moment the unread hold lifts, copied by a trigger then.
      await exec("CREATE TABLE probe_lifted (box TEXT)");
      await exec(
        `CREATE TRIGGER probe_lift AFTER UPDATE OF released ON safety_holds
         WHEN NEW.rule = 'unread' AND NEW.released = 1 AND OLD.released = 0
         BEGIN INSERT INTO probe_lifted (box) SELECT box FROM safety_results WHERE event_id = NEW.event_id; END`,
      );
      // 6 s: the late verdict.
      await run.h.clock.advance(2000);
      await vi.waitFor(async () => {
        expect(await actorOf().readHolds()).toMatchObject([
          { eventId: "evt-1", rule: "unread", released: true },
        ]);
      }, WAIT);
      const lifted = await runInDurableObject(stub(), (_, state) =>
        state.storage.sql
          .exec<{ box: string | null }>("SELECT box FROM probe_lifted")
          .toArray()
          .map((row) => row.box),
      );
      expect(lifted).toHaveLength(1);
      expect(await openBox(present(lifted[0], "the box as the hold lifted"), "result:evt-1")).toEqual(answer);
      expect(await resultsOf(["evt-1"])).toEqual([answer]);
    });
  });

  it("a re-read with no verdict leaves the row as it was", async () => {
    const rereads = rereadSpans();
    const read: SafetyReadPort = { read: (request) => Promise.resolve(gaveUp(request.eventId)) };
    await withActor({}, { deps: (h) => ({ ...h.deps, read }) }, async (run) => {
      await arrive("evt-1", PLAIN_TEXT);
      await run.settle();
      const kept = present((await rowsOf())[0]?.box, "the stand-in's box");
      expect(await openBox(kept, "result:evt-1")).toEqual(timeoutResult("evt-1", []));

      // 30 s: read again; no verdict again. Its span comes once its answer is dealt with.
      await run.h.clock.advance(30_000);
      await run.wake();
      await vi.waitFor(() => {
        expect(rereads()).toBe(1);
      }, WAIT);
      expect(await rowsOf()).toEqual([{ event_id: "evt-1", box: kept }]);
    });
  });

  it("a non-danger answer while a danger is pending leaves the row as it was", async () => {
    const rereads = rereadSpans();
    const read = readsBy((eventId, nth) => (nth === 1 ? emergency(eventId) : no(eventId)));
    await withActor({}, { deps: (h) => ({ ...h.deps, read }) }, async (run) => {
      run.h.core.down = true;
      run.h.direct.fail = true;
      await arrive("evt-1", SMOKE_TEXT);
      await run.settle();
      const kept = present((await rowsOf())[0]?.box, "the danger's box");

      // 30 s: the re-read says No while the danger is pending: not used. Its span comes once its answer is dealt with.
      await run.h.clock.advance(30_000);
      await run.wake();
      await vi.waitFor(() => {
        expect(rereads()).toBe(1);
      }, WAIT);
      expect(read.requests).toHaveLength(2);
      expect(await rowsOf()).toEqual([{ event_id: "evt-1", box: kept }]);
      expect(await resultsOf(["evt-1"])).toEqual([emergency("evt-1")]);
      expect(await idsIn("safety_pending")).toEqual(["evt-1"]);
    });
  });

  it("a second answer while one lands leaves the row as the first left it (line 968: the actor's own paths never send a second read while one is out, so the test hands both answers to its late step)", async () => {
    const recorded: RecordSafetyOutcomeRequest[] = [];
    interface LateStep {
      applyLate(
        set: SafetyDeps,
        handoff: SealedHandoff,
        arrivedAt: number,
        late: { answer: SafetyReadAnswer; words: SealedWords; key: SealingKey },
      ): Promise<void>;
    }
    await withActor(
      {},
      {
        deps: (h) => ({
          ...h.deps,
          read: { read: () => new Promise(() => undefined) },
          // The core takes the record and never answers: the first answer's line stays under way, so it lands for good.
          core: {
            ...h.core,
            recordSafetyOutcome(request) {
              recorded.push(request);
              return new Promise(() => undefined);
            },
          },
        }),
      },
      async (run) => {
        const handoff = await arrive("evt-1", SMOKE_TEXT);
        // 4 s: no verdict: the timeout rule (the stand-in kept, the unread hold, the outage line).
        await run.h.clock.advance(4000);
        await run.settle();
        expect(await actorOf().readHolds()).toMatchObject([
          { eventId: "evt-1", rule: "unread", released: false },
        ]);

        const key = await keys.getOrCreateKey(ALEX_HANDLE);
        const words: SealedWords = { body: SMOKE_TEXT, subject: null };
        const lateOf = (
          result: SafetyResult,
        ): { answer: SafetyReadAnswer; words: SealedWords; key: SealingKey } => ({
          answer: verdict(result),
          words,
          key,
        });
        await runInDurableObject(stub(), (instance) => {
          const step = safetyOf(instance) as unknown as LateStep;
          void step.applyLate(run.deps, handoff, 0, lateOf(emergency("evt-1")));
        });
        await vi.waitFor(() => {
          expect(recorded).toHaveLength(1);
        }, WAIT);
        const kept = present((await rowsOf())[0]?.box, "the first answer's box");
        expect(await openBox(kept, "result:evt-1")).toEqual(emergency("evt-1"));

        await runInDurableObject(stub(), (instance) =>
          (safetyOf(instance) as unknown as LateStep).applyLate(
            run.deps,
            handoff,
            0,
            lateOf(crisis("evt-1")),
          ),
        );
        expect(await rowsOf()).toEqual([{ event_id: "evt-1", box: kept }]);
        expect(await labelsOf("evt-1")).toEqual(["An emergency"]);
        expect(recorded).toHaveLength(1);
      },
    );
  });

  it("a danger applied again replaces it, and the earlier box stays until the new one is kept", async () => {
    const read = readsBy((eventId, nth) => (nth === 1 ? emergency(eventId) : crisis(eventId)));
    await withActor({}, { deps: (h) => ({ ...h.deps, read }) }, async (run) => {
      run.h.core.down = true;
      run.h.direct.fail = true;
      await arrive("evt-1", SMOKE_TEXT);
      await run.settle();
      const earlier = present((await rowsOf())[0]?.box, "the first danger's box");
      expect(await openBox(earlier, "result:evt-1")).toEqual(emergency("evt-1"));

      // 30 s: the re-read's danger is applied again; its seal waits at the gate.
      const seal = faultSeal("evt-1", "gate");
      await run.h.clock.advance(30_000);
      await run.wake();
      await vi.waitFor(() => {
        expect(seal.calls()).toBe(1);
      }, WAIT);
      expect(await labelsOf("evt-1")).toEqual(["An emergency", "Crisis words"]);
      expect(await rowsOf()).toEqual([{ event_id: "evt-1", box: earlier }]);
      expect(await resultsOf(["evt-1"])).toEqual([emergency("evt-1")]);

      seal.open();
      await vi.waitFor(async () => {
        expect(await resultsOf(["evt-1"])).toEqual([crisis("evt-1")]);
      }, WAIT);
    });
  });

  it("applyLate (lines 987-992) replacing a real kept result with a danger word's timeout stand-in follows the last-applied-wins rule", async () => {
    const answer = emergency("evt-1");
    const read = readsBy((eventId, nth) => (nth === 1 ? answer : no(eventId)));
    await withActor({}, { deps: (h) => ({ ...h.deps, read }) }, async (run) => {
      run.h.core.down = true;
      run.h.direct.fail = true;
      // The text holds the plug-in's danger words ("lips are swelling").
      await arrive("evt-1", EMERGENCY_TEXT);
      await run.settle();
      expect(await resultsOf(["evt-1"])).toEqual([answer]);

      // 30 s: the re-read says No: the first verdict stands, but the danger word gets its line by the timeout rule, and
      // its stand-in is the result applied last: it replaces the model's verdict in the row and in the record.
      run.h.direct.fail = false;
      await run.h.clock.advance(30_000);
      await run.wake();
      await vi.waitFor(() => {
        expect(run.h.direct.sent).toHaveLength(1);
      }, WAIT);
      const stand = timeoutResult("evt-1", [{ words: "lips are swelling", list: "plugin", kind: "other" }]);
      await vi.waitFor(async () => {
        expect(await idsIn("safety_pending")).toEqual([]);
      }, WAIT);
      expect(await resultsOf(["evt-1"])).toEqual([stand]);
      expect(run.h.direct.sent.map((send) => send.idempotencyKey)).toEqual(["safety:evt-1:safetyEmergency"]);
      run.h.core.down = false;
      expect(await actorOf().writeSafetyOnReturn()).toBe(1);
      expect(run.h.core.recorded[0]?.request.safety).toEqual(stand);
    });
  });
});

describe("no row, and a new instance", () => {
  it("no row for words that open to nothing", async () => {
    await withActor({}, {}, async (run) => {
      await arrive("evt-1", "   ");
      await run.settle();
      expect(run.h.read.requests).toEqual([]);
      expect(await actorOf().readSafety()).toMatchObject([
        { eventId: "evt-1", state: "done", danger: false },
      ]);
      expect(await rowsOf()).toEqual([]);
      expect(await unreadTexts()).toEqual([]);
    });
  });

  it("no row for words that cannot be opened: the stand-in has no key and keeps its unread hold", async () => {
    await withActor(
      {},
      {
        deps: (h) => ({
          ...h.deps,
          keys: { getOrCreateKey: () => Promise.reject(new Error("the key store broke")) },
        }),
      },
      async (run) => {
        await arrive("evt-1", PLAIN_TEXT);
        await run.settle();
        expect(run.h.core.fixed.map((call) => call.request.fixedLineId)).toEqual(["outage"]);
        expect(await actorOf().readHolds()).toMatchObject([
          { eventId: "evt-1", rule: "unread", released: false },
        ]);
        expect(await rowsOf()).toEqual([]);
      },
    );
  });

  it("a new instance over the same storage answers a kept row", async () => {
    const answer = no("evt-1");
    await withActor({ "evt-1": answer }, {}, async (run) => {
      await arrive("evt-1", PLAIN_TEXT);
      await run.settle();
      await run.evict();
      expect(await resultsOf(["evt-1"])).toEqual([answer]);
    });
  });
});

describe("resultsOf and closeResults", () => {
  it("resultsOf leaves out an id with no row, an owed row, a box moved onto another row and a result naming another event, and throws when the key store throws; closeResults takes exactly the named rows and closes them", async () => {
    const ids = ["evt-1", "evt-2", "evt-3", "evt-4"];
    await withActor(Object.fromEntries(ids.map((id) => [id, no(id)])), {}, async (run) => {
      for (const id of ids) await arrive(id, PLAIN_TEXT);
      await run.settle();
      expect(await resultsOf(ids)).toEqual(ids.map(no));

      // evt-2 owed; evt-1's box moved onto evt-3's row; evt-4's box a result naming evt-1, sealed as evt-4's.
      await exec("UPDATE safety_results SET box = NULL WHERE event_id = 'evt-2'");
      await exec(
        "UPDATE safety_results SET box = (SELECT box FROM safety_results WHERE event_id = 'evt-1') WHERE event_id = 'evt-3'",
      );
      const named = await sealWords(
        { body: JSON.stringify(no("evt-1")), subject: null },
        keys.keyOf(ALEX_HANDLE),
        ALEX,
        "result:evt-4",
      );
      await exec("UPDATE safety_results SET box = ? WHERE event_id = 'evt-4'", JSON.stringify(named));
      expect(await resultsOf([...ids, "evt-5"])).toEqual([no("evt-1")]);

      // A read that cannot be done at all throws: the key store throws, or nothing is wired.
      const broken = setSafetyDeps({
        ...run.h.deps,
        keys: { getOrCreateKey: () => Promise.reject(new Error("the key store broke")) },
      });
      try {
        await expect(resultsOf(["evt-1"])).rejects.toThrow("the key store broke");
      } finally {
        broken();
      }
      const unwired = setSafetyDeps(null);
      try {
        await expect(resultsOf(["evt-1"])).rejects.toThrow("not wired");
      } finally {
        unwired();
      }

      await closeResults(["evt-1", "evt-3"]);
      expect((await rowsOf()).map((row) => row.event_id)).toEqual(["evt-2", "evt-4"]);
      expect(await idsIn("safety_closed")).toEqual(["evt-1", "evt-3"]);
      // Again: it changes nothing more.
      await closeResults(["evt-1", "evt-3"]);
      expect((await rowsOf()).map((row) => row.event_id)).toEqual(["evt-2", "evt-4"]);
      expect(await idsIn("safety_closed")).toEqual(["evt-1", "evt-3"]);
      expect(await resultsOf(["evt-1", "evt-3"])).toEqual([]);
    });
  });
});

describe("nothing of a result in a span, a log line or a plain column", () => {
  it("the span sink and the logs hold no word of a result, and no plain value in any of the actor's tables does, through a danger's direct line, its re-read, its record on return, resultsOf and closeResults", async () => {
    const consoles = (["log", "warn", "error", "info", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    const answer = emergency("evt-1");
    await withActor({ "evt-1": answer }, {}, async (run) => {
      run.h.core.down = true;
      run.h.direct.fail = true;
      await arrive("evt-1", EMERGENCY_TEXT);
      await run.settle();
      run.h.direct.fail = false;
      await run.h.clock.advance(30_000);
      await run.wake();
      await vi.waitFor(() => {
        expect(run.h.direct.sent).toHaveLength(1);
      }, WAIT);
      await vi.waitFor(async () => {
        expect(await idsIn("safety_pending")).toEqual([]);
      }, WAIT);
      expect(await resultsOf(["evt-1"])).toEqual([answer]);
      await expectNoPlainWords(answer);
      run.h.core.down = false;
      expect(await actorOf().writeSafetyOnReturn()).toBe(1);
      await closeResults(["evt-1"]);
      expect(await resultsOf(["evt-1"])).toEqual([]);
      await expectNoPlainWords(answer);
    });
    const lines = consoles
      .flatMap((spy) => spy.mock.calls)
      .map((call) => call.map(String).join(" "))
      .join("\n");
    expect(lines).toContain('"hop":"safetyRead"');
    for (const word of wordsOf(answer)) expect(lines).not.toContain(word);
  });
});

// ---- the lead notes of DL-508 ------------------------------------------------------------------------------------------

describe("a pending note when its text closes (DL-508, the security reviewer's note c)", () => {
  it("an owed danger whose line and record are done and whose re-reads answer No: after closeResults its pending note is cleared, so it is no longer re-read and no longer among unreadTexts, its hold released or not", async () => {
    const read = readsBy((eventId, nth) => (nth === 1 ? emergency(eventId) : no(eventId)));
    await withActor({}, { deps: (h) => ({ ...h.deps, read }) }, async (run) => {
      faultSeal("evt-1", "fail");
      await arrive("evt-1", SMOKE_TEXT);
      await run.settle();
      // The line went through the core's outbox row and its record is kept; the result is owed.
      expect(run.h.core.recorded).toHaveLength(1);
      expect(await idsIn("safety_pending")).toEqual(["evt-1"]);
      expect(await idsIn("safety_line_done")).toEqual(["evt-1"]);

      // 30 s: read again: No. Still owed and pending, and among the texts not read.
      await run.h.clock.advance(30_000);
      await run.wake();
      await vi.waitFor(async () => {
        expect(read.requests).toHaveLength(2);
        expect(await scheduleOf()).toContainEqual({ kind: "safetyRead", due_ms: 60_000 });
      }, WAIT);
      expect(await unreadTexts()).toEqual(["evt-1"]);

      // Its turn ends: the text closes, and its pending note goes with it.
      await closeResults(["evt-1"]);
      expect(await idsIn("safety_pending")).toEqual([]);
      expect(await idsIn("safety_line_done")).toEqual([]);
      expect(await unreadTexts()).toEqual([]);
      expect(await actorOf().markHoldReleased("hold-evt-1")).toBe("released");
      expect(await unreadTexts()).toEqual([]);
      expect(await actorOf().routineHeld()).toBe(false);

      // 60 s and 90 s: never read again.
      for (const at of [60_000, 90_000]) {
        await run.h.clock.advance(at - run.h.clock.now());
        await run.wake();
        await run.settle();
      }
      expect(read.requests).toHaveLength(2);
      expect((await scheduleOf()).map((entry) => entry.kind)).not.toContain("safetyRead");
    });
  });

  it("a danger whose line is not done keeps its pending note after closeResults, and is read again", async () => {
    const read = readsBy((eventId, nth) => (nth === 1 ? emergency(eventId) : no(eventId)));
    await withActor({}, { deps: (h) => ({ ...h.deps, read }) }, async (run) => {
      run.h.core.down = true;
      run.h.direct.fail = true;
      await arrive("evt-1", SMOKE_TEXT);
      await run.settle();
      expect(await idsIn("safety_line_done")).toEqual([]);

      await closeResults(["evt-1"]);
      expect(await idsIn("safety_pending")).toEqual(["evt-1"]);
      await run.h.clock.advance(30_000);
      await run.wake();
      await vi.waitFor(() => {
        expect(read.requests).toHaveLength(2);
      }, WAIT);
      expect(await idsIn("safety_pending")).toEqual(["evt-1"]);
      expect(await rowsOf()).toEqual([]);
    });
  });
});

describe("an owed text that is not a danger (DL-508, the runtime engineer's note b)", () => {
  it("on time, it reaches finish (line 1219) and counts as read for its batch, and is read again through waiting, which keeps its result then", async () => {
    const answer = no("evt-1");
    await withActor({ "evt-1": answer }, {}, async (run) => {
      const seal = faultSeal("evt-1", "fail", 1);
      await arrive("evt-1", PLAIN_TEXT);
      await run.settle();
      expect(await actorOf().readSafety()).toMatchObject([
        { eventId: "evt-1", state: "done", danger: false },
      ]);
      expect(await rowsOf()).toEqual([{ event_id: "evt-1", box: null }]);
      expect(await unreadAmong(["evt-1"])).toBe(false);
      expect(await unreadTexts()).toEqual(["evt-1"]);
      expect(await actorOf().routineHeld()).toBe(true);
      expect(await resultsOf(["evt-1"])).toEqual([]);

      // It waits, with no stored re-read yet: the actor's alarm reads it again at once, and this read's result is kept.
      await run.wake();
      await vi.waitFor(async () => {
        expect(await resultsOf(["evt-1"])).toEqual([answer]);
      }, WAIT);
      expect(seal.calls()).toBe(2);
      expect(run.h.read.requests.map((request) => request.eventId)).toEqual(["evt-1", "evt-1"]);
      expect(await unreadTexts()).toEqual([]);
      expect(await actorOf().routineHeld()).toBe(false);
      await vi.waitFor(async () => {
        expect((await scheduleOf()).map((entry) => entry.kind)).not.toContain("safetyRead");
      }, WAIT);
    });
  });
});
