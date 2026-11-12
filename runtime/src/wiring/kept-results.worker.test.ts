// ADR-015's card B (T-1264; DL-508), through the hop rig in the Workers runtime: the composition root composed for the
// test environment as the hop tests compose it (the HandleActor namespace, the skeleton flag on, the actor's ports
// installed, every joined port fed its double), with no double for any text's safety result. Each text's read on arrival
// goes through the joined safety read (T-554) over the recorded-model double; the real actor keeps the result it applied,
// sealed in its own storage (T-1262); each run of the text's turn reads it through its leased turn (`resultsOf`); and
// the lease removes a turn's rows and closes its texts in the storage transaction that ends the turn for good, while the
// PostgreSQL-down hand-off does so for the STOP and START texts that path took alone (T-1264).
//
// What a test adds to the rig, beside it: it watches the read on arrival (each answer, by event id), and wraps the
// turn's deps to watch each gate call, compose input and decide, and to hold one of them, or never answer it (a crash in
// the middle of a turn: the actor is then cut off, as ../turn/crash.worker.test.ts cuts it). A STOP, whose words the
// recorded-model double holds no read for, is read by the test itself, as a verdict (No); a danger text's words, which
// it holds no read for either, take the read's own path (no verdict: the timeout rule finds the danger word). A turn's
// gate is the joined one unless a test answers it: a STOP's keyword commit (T-267's shared-core double, as
// ../turn/lease-turn.worker.test.ts answers it) and a danger text's turn (no row written). The actor's stored rows are
// read inside it: its kept results (`safety_results`: event ids, and whether the box is kept, never the box), its closed
// texts (`safety_closed`) and its dangers not complete (`safety_pending`), event ids alone.
//
// Each test's texts go to a handle no other test of this file uses. Test values only (rule 9): the fictional 555-01xx
// numbers, made-up words and the frozen fixtures' ids and words.
import textFixture from "@rosie/contracts/inbound-event/fixtures/text-imessage.json";
import stopRecorded from "@rosie/contracts/tool-api/fixtures/stop-recorded.json";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

import {
  LEASE_MS,
  MAX_TRIES,
  QUIET_MS,
  setLeaseHooks,
  turnIdOf,
  type BatchEntry,
  type HandleActor,
  type SafetyEntry,
  type TurnEntry,
} from "../actor";
import { actorNameOf } from "../gateway";
import { setReplyDeps } from "../guard";
import { fakeCore as fakeReplyCore, phone, ROSIE_NUMBER } from "../guard/replies/test-support";
import { PROBE_MS, setDbOutageDeps, type OutageView } from "../outage/db";
import { dbFakes, idsOf } from "../outage/db/test-support";
import { REREAD_MS, setSafetyDeps } from "../safety";
import type { SafetyReadAnswer, SafetyResult } from "../safety/types";
import type { Span } from "../trace";
import { spansOfLogLines } from "../trace/hop-check";
import { turnReplyCore } from "../turn";
import { flush, hold, SAM, safetyNoFor, until } from "../turn/test-support";
import { setTurnDeps } from "../turn/turn";
import type { GateAndCommitAnswer, GateAndCommitRequest } from "../turn/types";
import { composeRoot, SKELETON_FLAG, type HandleActors, type Root } from "./index";
import {
  fakeFlags,
  JOIN_TEXT,
  SAM_CHAT,
  SAM_TRADES_TEXT,
  samPhoneRow,
  skeletonFakes,
  type LinqInboundEvent,
  type SignedWebhook,
  type SkeletonFakes,
} from "./test-support";

type Json = Record<string, unknown>;
type Namespace = DurableObjectNamespace<HandleActor>;

interface Handle {
  kind: string;
  address: string;
}

/** A run through the Workers runtime's own steps, crashes and lapses included: a resource guard, not part of any claim. */
const TEST_MS = 60_000;
/** How long a wait for the actor's own work may take on a machine busy with other builds. */
const WAIT_MS = 20_000;

/** K-06 text-imessage.json's words: a third text the recorded-model double holds a safety read for (No). */
const IMESSAGE_TEXT = String((textFixture as Json).body);
/** A STOP: a keyword text, whose read the recorded-model double does not hold, so the test reads it (No). */
const STOP_TEXT = "STOP";
/** Made-up words holding the bundle's danger words "cut won't stop bleeding"; the double holds no read for them. */
const DANGER_TEXT = "Test words: my cut won't stop bleeding";

/** One fictional number per test (555-0160 to 555-0169), so no test's actor holds another's texts. */
const handleOf = (line: number): Handle => ({ kind: "phone", address: `+155555501${String(line)}` });

function namespace(): Namespace {
  return (exports as unknown as { HandleActor: Namespace }).HandleActor;
}

/** The HandleActor namespace as the root takes it (exports.HandleActor in the pool). */
function handleActors(): HandleActors<DurableObjectId> {
  const ns = namespace();
  return { idFromName: (name) => ns.idFromName(name), get: (id) => ns.get(id) };
}

/** A stub taken now: one taken before a crash is broken by it. */
function stubOf(handle: Handle): DurableObjectStub<HandleActor> {
  return namespace().get(namespace().idFromName(actorNameOf(handle)));
}

/** The actor's calls over RPC, typed here. */
interface ActorRpc {
  readTurns(): Promise<TurnEntry[]>;
  readWaitingBatches(): Promise<number[]>;
  readBatches(): Promise<BatchEntry[]>;
  readSafety(): Promise<SafetyEntry[]>;
  readOutage(): Promise<OutageView>;
  safetyIdle(): Promise<void>;
  batchIdle(): Promise<void>;
  outageIdle(): Promise<void>;
}

const actorOf = (handle: Handle): ActorRpc => stubOf(handle);

/** A text of K-06's text-imessage.json form from this handle, with this event id and these words. */
function textOf(eventId: string, handle: Handle, body: string): LinqInboundEvent {
  return {
    ...(structuredClone(textFixture) as Json),
    eventId,
    handle: { ...handle },
    body,
    chatId: handle.address === SAM.handle.address ? SAM_CHAT : "linq-chat-demo-alex",
    messageId: `linq-msg-demo-in-${eventId}`,
  } as unknown as LinqInboundEvent;
}

/** The webhook as Linq posts it to {BASE_PATH}/webhooks/linq: the three headers and the raw body. */
function webhookRequest(webhook: SignedWebhook): Request {
  return new Request(`https://rosie.test${env.BASE_PATH}/webhooks/linq`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": webhook.webhookId,
      "webhook-timestamp": webhook.timestamp,
      "webhook-signature": webhook.signature,
    },
    body: webhook.raw,
  });
}

/** A promise that never settles, waiting on no timer: a call in the air when the actor is cut off. */
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

// ---- the actor's stored rows, read inside it ----------------------------------------------------------------------

interface KeptRow {
  readonly eventId: string;
  /** True when the row holds a sealed box; false while it is owed. */
  readonly kept: boolean;
}

/** The actor's kept results: each row's event id and whether its box is kept (never the box itself). */
function rowsOf(handle: Handle): Promise<KeptRow[]> {
  return runInDurableObject(stubOf(handle), (_actor: HandleActor, state) =>
    state.storage.sql
      .exec<{ event_id: string; kept: number }>(
        "SELECT event_id, box IS NOT NULL AS kept FROM safety_results ORDER BY rowid",
      )
      .toArray()
      .map((row) => ({ eventId: row.event_id, kept: row.kept === 1 })),
  );
}

/** The event ids a table of event ids holds, in the order written: the closed texts, or the dangers not complete. */
function idsIn(handle: Handle, table: "safety_closed" | "safety_pending"): Promise<string[]> {
  return runInDurableObject(stubOf(handle), (_actor: HandleActor, state) =>
    state.storage.sql
      .exec<{ event_id: string }>(`SELECT event_id FROM ${table} ORDER BY rowid`)
      .toArray()
      .map((row) => row.event_id),
  );
}

/**
 * A text's kept row is gone from the actor's storage after its read kept it (ADR-015 section 2: a storage that refused
 * both of the read's writes keeps no row): the row is deleted, nothing else.
 */
async function dropRow(handle: Handle, eventId: string): Promise<void> {
  const had = await runInDurableObject(stubOf(handle), (_actor: HandleActor, state) => {
    const { sql } = state.storage;
    const rows = sql.exec("SELECT 1 FROM safety_results WHERE event_id = ? AND box IS NOT NULL", eventId);
    const kept = rows.toArray().length;
    sql.exec("DELETE FROM safety_results WHERE event_id = ?", eventId);
    return kept;
  });
  expect(had).toBe(1);
}

/** Whether each closed batch holding this text has been handed to the lease, in order. */
async function handedOf(handle: Handle, eventId: string): Promise<boolean[]> {
  return (await actorOf(handle).readBatches())
    .filter((batch) => batch.reason !== null && batch.eventIds.includes(eventId))
    .map((batch) => batch.handed);
}

/** Cuts the actor off: what it awaited lived only in memory and is gone; its storage and its alarm stay. */
async function crash(handle: Handle): Promise<void> {
  const cut = await runInDurableObject(stubOf(handle), async (_actor: HandleActor, state) => {
    await state.storage.sync();
    state.abort("crash in the middle of a turn");
  }).then(
    () => "still running",
    () => "cut off",
  );
  expect(cut).toBe("cut off");
}

// ---- watching the read and the turn -----------------------------------------------------------------------------------

/** A verdict as a read answers it, with its one model call. */
function verdictOf(result: SafetyResult): SafetyReadAnswer {
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

/** One gate call the turn made, and what answered it (the joined gate, or the test's own). */
interface GateCall {
  readonly request: GateAndCommitRequest;
  answer: unknown;
}

/** A step of the turn a test can hold back on its n-th call (from 1): what it returns is awaited before the call goes on. */
type Before = (nth: number) => Promise<void>;

interface TurnWatch {
  readonly gateCalls: GateCall[];
  /** Each compose input's row, in order. */
  readonly composeRows: string[];
  /** How many decide calls the turn made. */
  readonly decides: { count: number };
  readonly before: { gate?: Before; compose?: Before; decide?: Before };
  /** The gate's answer in the joined gate's place, when a test gives one. */
  answer: ((request: GateAndCommitRequest, nth: number) => Promise<GateAndCommitAnswer>) | null;
}

/** The turn's deps as the root installed them, each gate call, compose input and decide watched (and held as a test says). */
function watchTurn(root: Root): { watch: TurnWatch; restore: () => void } {
  const watch: TurnWatch = {
    gateCalls: [],
    composeRows: [],
    decides: { count: 0 },
    before: {},
    answer: null,
  };
  let gates = 0;
  let composes = 0;
  const restore = setTurnDeps({
    ...root.turn,
    toolApi: {
      ...root.turn.toolApi,
      async gateAndCommit(request, at, trace) {
        gates += 1;
        const nth = gates;
        const call: GateCall = { request: structuredClone(request), answer: undefined };
        watch.gateCalls.push(call);
        await watch.before.gate?.(nth);
        const answer =
          watch.answer === null
            ? await root.turn.toolApi.gateAndCommit(request, at, trace)
            : await watch.answer(request, nth);
        call.answer = structuredClone(answer);
        return answer;
      },
      async composeInput(request, trace) {
        composes += 1;
        watch.composeRows.push(request.outboxRowId);
        await watch.before.compose?.(composes);
        return root.turn.toolApi.composeInput(request, trace);
      },
    },
    ai: {
      async decide(context, trace) {
        watch.decides.count += 1;
        await watch.before.decide?.(watch.decides.count);
        return root.turn.ai.decide(context, trace);
      },
      reread: (request, trace) => root.turn.ai.reread(request, trace),
    },
  });
  return { watch, restore };
}

/** The read on arrival as the root joined it, each answer's result kept by event id; a STOP read here, as a verdict (No). */
function watchReads(root: Root): { reads: Map<string, SafetyResult>; restore: () => void } {
  const reads = new Map<string, SafetyResult>();
  const restore = setSafetyDeps({
    ...root.safety,
    read: {
      async read(request) {
        const answer =
          request.words.body === STOP_TEXT
            ? verdictOf(safetyNoFor(request.eventId))
            : await root.safety.read.read(request);
        reads.set(request.eventId, structuredClone(answer.result));
        return answer;
      },
    },
  });
  return { reads, restore };
}

/** Each text's safety result a request records (its recordSafetyOutcome core actions), in the request's order. */
function recordsOf(request: GateAndCommitRequest | undefined): unknown[] {
  return (request?.core ?? [])
    .filter((action) => action.call === "recordSafetyOutcome")
    .map((action) => (action.request as { safety: unknown }).safety);
}

/** K-09's committed answer to a request, as a test's gate gives it: no part and no row written, each core action as given. */
function committedAnswer(
  request: GateAndCommitRequest,
  repeated: boolean,
  core: unknown[],
): GateAndCommitAnswer {
  return {
    result: "committed",
    turnId: request.turn.id,
    committedAt: stopRecorded.outcome.committedAt,
    repeated,
    parts: [],
    planner: null,
    core,
    written: { written: [], outboxRows: [], promoted: [] },
    effects: [],
    openQuestions: { opened: [], closed: [] },
  } as unknown as GateAndCommitAnswer;
}

/** A record's core result, as K-09 answers it at its place in the request (the turn reads none of it). */
const recordAnswer = { call: "recordSafetyOutcome", response: null, error: null };

// ---- the rig ----------------------------------------------------------------------------------------------------------

interface Rig {
  readonly fakes: SkeletonFakes;
  readonly root: Root;
  /** Each read on arrival's result, by event id: what the actor applied. */
  readonly reads: Map<string, SafetyResult>;
  readonly watch: TurnWatch;
  /** Signs one K-06 event with the Linq double and posts it through root.linqWebhook. */
  post(event: LinqInboundEvent): Promise<void>;
  /** The clock moves on, then the actor's alarm runs, as the platform would at the stored time. */
  tick(handle: Handle, ms: number): Promise<void>;
  /** Waits until the actor has read every text and run what its batch window and lease can (never while a run hangs). */
  settle(handle: Handle): Promise<void>;
  /** Waits until this turn's reply has ended: committed, its lease released. */
  untilReplied(handle: Handle, turnId: string): Promise<void>;
  /** The spans logged so far. */
  spans(): Span[];
  /** Restores this one too, when the test does. */
  also(restore: () => void): void;
  restore(): void;
}

/**
 * The root for "test" with the HandleActor namespace and the skeleton flag on, every joined port fed its double as
 * ./root.worker.test.ts feeds them (so a recorded turn goes the JOIN run's way to its reply), its actor ports installed,
 * the read on arrival and the turn watched.
 */
function rig(log: MockInstance): Rig {
  const fakes = skeletonFakes();
  const root = composeRoot({
    environment: "test",
    sets: { fake: fakes.ports },
    actors: handleActors(),
    vars: env,
    clock: fakes.clock,
    linq: fakes.linqInputs,
    handleKey: fakes.handleKeys.call,
    chatOpenCall: fakes.dispatch.openChat,
    safetyReaders: fakes.models.readers,
    turnRows: fakes.turnRows.calls,
    bundleReads: fakes.bundleReads.calls,
    handleTargets: fakes.handleTargets.call,
    frontierScope: fakes.frontier.scope,
    deciders: fakes.decide.deciders,
    gateReads: fakes.gate.reads,
    composeReads: fakes.compose.reads,
    composers: fakes.composer.composers,
    finalizeData: fakes.finalize.data,
    outboxCalls: fakes.dispatch.outbox,
    sendStateCall: fakes.dispatch.sendState,
    linqSendCall: fakes.linq.call,
    armingCalls: fakes.arming.calls,
    flags: fakeFlags([SKELETON_FLAG]),
  });
  // The turn's handle's phone row as K-05 reads it (chat open, not stopped), so limit 8 lets a reply go (T-562).
  fakes.dispatch.phones.set(SAM.party.handleId, samPhoneRow());
  const restores = [root.install()];
  const read = watchReads(root);
  const turn = watchTurn(root);
  restores.push(read.restore, turn.restore);
  const rigged: Rig = {
    fakes,
    root,
    reads: read.reads,
    watch: turn.watch,
    async post(event) {
      const response = await root.linqWebhook(webhookRequest(await fakes.sign(event)));
      if (response.status !== 200) throw new Error(`the gateway answered ${String(response.status)}`);
    },
    async tick(handle, ms) {
      await fakes.clock.advance(ms);
      await runDurableObjectAlarm(stubOf(handle));
    },
    async settle(handle) {
      for (let round = 0; round < 3; round += 1) {
        await actorOf(handle).safetyIdle();
        await actorOf(handle).outageIdle();
        await actorOf(handle).batchIdle();
      }
    },
    async untilReplied(handle, turnId) {
      const started = Date.now();
      for (;;) {
        const turns = await actorOf(handle).readTurns();
        if (
          turns.some(
            (turn) => turn.turnId === turnId && turn.state === "committed" && turn.leaseUntil === null,
          )
        )
          return;
        if (Date.now() - started > WAIT_MS) throw new Error(`gave up waiting for ${turnId}'s reply to end`);
        await flush(5);
      }
    },
    spans: () => spansOfLogLines(log.mock.calls.map((call: unknown[]) => call[0])),
    also(restore) {
      restores.push(restore);
    },
    restore() {
      for (const restore of restores.splice(0).reverse()) restore();
    },
  };
  return rigged;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

// ---- the turn reads its texts' kept results, and the step that ends it removes them ----------------------------------

describe("the turn reads each text's kept safety result through its leased turn (ADR-015 card B)", () => {
  it(
    "the JOIN turn's gateAndCommit request carries in its recordSafetyOutcome exactly the result the safety double answered for JOIN; once its reply ends its row is gone and its text closed, and a later turn's row is kept",
    { timeout: TEST_MS },
    async () => {
      const run = rig(vi.spyOn(console, "log").mockImplementation(() => undefined));
      const handle = handleOf(60);
      try {
        const join = "evt-kept-6001";
        const later = "evt-kept-6002";
        run.fakes.decide.recordTurn([join]);
        // The JOIN turn's commit is held at the gate until the later text has been read and its batch waits.
        const gate = hold();
        run.watch.before.gate = (nth) => (nth === 1 ? gate.wait() : Promise.resolve());
        await run.post(textOf(join, handle, JOIN_TEXT));
        await actorOf(handle).safetyIdle();
        // The read on arrival kept its result: one row, its box kept.
        expect(await rowsOf(handle)).toEqual([{ eventId: join, kept: true }]);
        await run.tick(handle, QUIET_MS);
        await until(() => run.watch.gateCalls.length === 1, "the JOIN turn's gate call", WAIT_MS);

        // A later text, read while the JOIN turn's commit is out: its row is kept, and its batch waits for the next turn.
        await run.post(textOf(later, handle, SAM_TRADES_TEXT));
        await actorOf(handle).safetyIdle();
        await run.tick(handle, QUIET_MS);
        expect(await actorOf(handle).readWaitingBatches()).toHaveLength(1);
        expect(await rowsOf(handle)).toEqual([
          { eventId: join, kept: true },
          { eventId: later, kept: true },
        ]);

        gate.closed = false;
        const turnId = await turnIdOf([join]);
        await run.untilReplied(handle, turnId);
        await run.settle(handle);

        // The request carries exactly the result the safety read answered for the JOIN: safety-no.json's, under its id.
        const request = run.watch.gateCalls[0]?.request;
        expect(request?.turn.id).toBe(turnId);
        expect(recordsOf(request)).toEqual([run.reads.get(join)]);
        expect(run.reads.get(join)).toEqual(safetyNoFor(join));
        expect(run.watch.gateCalls[0]?.answer).toMatchObject({ result: "committed", repeated: false });
        // Its reply ended: its row is gone and its text closed. The later turn's row is kept, its text open.
        expect(await rowsOf(handle)).toEqual([{ eventId: later, kept: true }]);
        expect(await idsIn(handle, "safety_closed")).toEqual([join]);
      } finally {
        run.restore();
      }
    },
  );

  it(
    "a crash before the commit gives a rerun whose request carries the same result",
    { timeout: TEST_MS },
    async () => {
      const run = rig(vi.spyOn(console, "log").mockImplementation(() => undefined));
      const handle = handleOf(61);
      try {
        const join = "evt-kept-6101";
        run.fakes.decide.recordTurn([join]);
        // The first run's gate call never answers: the run is cut off with its commit out, before K-05 took it.
        run.watch.before.gate = (nth) => (nth === 1 ? never() : Promise.resolve());
        await run.post(textOf(join, handle, JOIN_TEXT));
        await actorOf(handle).safetyIdle();
        await run.tick(handle, QUIET_MS);
        await until(() => run.watch.gateCalls.length === 1, "the first run's gate call", WAIT_MS);
        expect(run.fakes.turnRows.commits).toEqual([]);
        await crash(handle);

        // The lease lapses on a new instance and the turn reruns from its sealed texts, reading the same kept result.
        await run.tick(handle, LEASE_MS);
        const turnId = await turnIdOf([join]);
        await run.untilReplied(handle, turnId);
        await run.settle(handle);

        const read = run.reads.get(join);
        expect(read).toEqual(safetyNoFor(join));
        expect(
          run.watch.gateCalls.map((call) => [
            call.request.turn.id,
            call.request.turn.tries,
            recordsOf(call.request),
          ]),
        ).toEqual([
          [turnId, 1, [read]],
          [turnId, 2, [read]],
        ]);
        // K-05 took the rerun's commit, its first.
        expect(run.fakes.turnRows.commits.map((commit) => commit.turn.tries)).toEqual([2]);
        expect(run.watch.gateCalls[1]?.answer).toMatchObject({ result: "committed", repeated: false });
        expect(await rowsOf(handle)).toEqual([]);
        expect(await idsIn(handle, "safety_closed")).toEqual([join]);
      } finally {
        run.restore();
      }
    },
  );

  it(
    "a crash after the commit, before the reply ends, gives a rerun that reads the same result, whose commit answers repeated and composes only the row with no plan; the row goes when that reply ends",
    { timeout: TEST_MS },
    async () => {
      const run = rig(vi.spyOn(console, "log").mockImplementation(() => undefined));
      const handle = handleOf(62);
      try {
        const join = "evt-kept-6201";
        run.fakes.decide.recordTurn([join]);
        // The first run commits; its compose input for the row it wrote never answers: cut off in the middle of its reply.
        run.watch.before.compose = (nth) => (nth === 1 ? never() : Promise.resolve());
        await run.post(textOf(join, handle, JOIN_TEXT));
        await actorOf(handle).safetyIdle();
        await run.tick(handle, QUIET_MS);
        await until(() => run.watch.composeRows.length === 1, "the first run's compose input", WAIT_MS);
        const turnId = await turnIdOf([join]);
        const row = run.watch.composeRows[0] ?? "";
        expect(run.fakes.turnRows.commits).toHaveLength(1);
        // Committed, its lease held for the reply, and its row with no plan: the kept result is still there.
        expect(await actorOf(handle).readTurns()).toMatchObject([
          { turnId, state: "committed", leaseUntil: expect.any(Number) as unknown },
        ]);
        expect(run.fakes.finalize.plans.has(row)).toBe(false);
        expect(await rowsOf(handle)).toEqual([{ eventId: join, kept: true }]);
        await crash(handle);

        await run.tick(handle, LEASE_MS);
        await run.untilReplied(handle, turnId);
        await run.settle(handle);

        // The rerun read the same result, and its commit answered repeated (K-05 v1 commitTurn: nothing written again).
        const read = run.reads.get(join);
        expect(
          run.watch.gateCalls.map((call) => [
            call.request.turn.tries,
            recordsOf(call.request),
            (call.answer as { repeated?: unknown }).repeated,
          ]),
        ).toEqual([
          [1, [read], false],
          [2, [read], true],
        ]);
        expect(run.fakes.turnRows.commits).toHaveLength(2);
        expect([...run.fakes.turnRows.turns.keys()]).toEqual([turnId]);
        // It composed the one row the commit wrote, which held no plan, and finalize wrote that plan once.
        expect(run.watch.composeRows).toEqual([row, row]);
        expect(run.fakes.finalize.writes.map((write) => write.outboxRowId)).toEqual([row]);
        // Its reply ended: the row is gone and the text closed.
        expect(await rowsOf(handle)).toEqual([]);
        expect(await idsIn(handle, "safety_closed")).toEqual([join]);
      } finally {
        run.restore();
      }
    },
  );

  it(
    "a restart keeps the rows for the restart's run: its request carries both texts' results, and both go when its reply ends",
    { timeout: TEST_MS },
    async () => {
      const run = rig(vi.spyOn(console, "log").mockImplementation(() => undefined));
      const handle = handleOf(63);
      try {
        const first = "evt-kept-6301";
        const second = "evt-kept-6302";
        run.fakes.decide.recordTurn([first, second]);
        // The first run waits in decide, before any commit, while the second text's batch restarts the turn.
        const decide = hold();
        run.watch.before.decide = (nth) => (nth === 1 ? decide.wait() : Promise.resolve());
        await run.post(textOf(first, handle, JOIN_TEXT));
        await actorOf(handle).safetyIdle();
        await run.tick(handle, QUIET_MS);
        await until(() => run.watch.decides.count === 1, "the first run's decide", WAIT_MS);

        await run.post(textOf(second, handle, SAM_TRADES_TEXT));
        await actorOf(handle).safetyIdle();
        await run.tick(handle, QUIET_MS);
        const firstTurn = await turnIdOf([first]);
        const restart = await turnIdOf([first, second]);
        await until(() => run.watch.gateCalls.length === 1, "the restart's gate call", WAIT_MS);
        // The replaced run's decide answers only now: it is no longer the turn's, and commits nothing.
        decide.closed = false;
        await run.untilReplied(handle, restart);
        await run.settle(handle);

        expect(
          (await actorOf(handle).readTurns()).map((turn) => [turn.turnId, turn.state, turn.restart]),
        ).toEqual([
          [firstTurn, "replaced", false],
          [restart, "committed", true],
        ]);
        // The restart's run read both kept results: the first text's row was not removed when its turn was replaced.
        expect(run.watch.gateCalls.map((call) => [call.request.turn.id, recordsOf(call.request)])).toEqual([
          [restart, [run.reads.get(first), run.reads.get(second)]],
        ]);
        expect(run.reads.get(first)).toEqual(safetyNoFor(first));
        expect(run.reads.get(second)).toEqual(safetyNoFor(second));
        // The restart's reply ended: both rows are gone and both texts closed.
        expect(await rowsOf(handle)).toEqual([]);
        expect(await idsIn(handle, "safety_closed")).toEqual([first, second]);
      } finally {
        run.restore();
      }
    },
  );

  it(
    "a run asking for an id outside its turn gets nothing for it: each run is answered its own texts' results alone, through a restart and a lapse's rerun",
    { timeout: TEST_MS },
    async () => {
      const run = rig(vi.spyOn(console, "log").mockImplementation(() => undefined));
      const handle = handleOf(64);
      try {
        // The PostgreSQL-down path wired over the root's own sealing port, PostgreSQL answering (ADR-018 section 1): it
        // reads the third text as another text, so its batch, which may hold no stop word, waits behind the restarted turn.
        // Unwired, as the root installs it today, that batch would restart the turn a second time.
        const db = dbFakes(
          run.root.ports.sealing,
          {},
          { start: run.fakes.clock.now(), ids: idsOf(SAM.party) },
        );
        run.also(setDbOutageDeps(db.outageDeps));
        const [a, b, c, unknown] = ["evt-kept-6401", "evt-kept-6402", "evt-kept-6403", "evt-kept-6404"];
        // Each run asks its leased turn for every text of the handle and one that never arrived, and commits nothing.
        const asked: { turnId: string; tries: number; eventIds: string[]; answered: string[] }[] = [];
        run.also(
          setLeaseHooks({
            runTurn: async (turn) => {
              const results = await turn.resultsOf([a, b, c, unknown]);
              asked.push({
                turnId: turn.turnId,
                tries: turn.tries,
                eventIds: [...turn.eventIds],
                answered: results.map((result) => result.eventId),
              });
            },
          }),
        );
        await run.post(textOf(a, handle, JOIN_TEXT));
        await run.settle(handle);
        await run.tick(handle, QUIET_MS);
        await run.settle(handle);
        // A second batch before any commit restarts the turn with both texts.
        await run.post(textOf(b, handle, SAM_TRADES_TEXT));
        await run.settle(handle);
        await run.tick(handle, QUIET_MS);
        await run.settle(handle);
        // A third batch after the restart waits for the next turn: its text's result is kept, outside the running turn.
        await run.post(textOf(c, handle, IMESSAGE_TEXT));
        await run.settle(handle);
        await run.tick(handle, QUIET_MS);
        await run.settle(handle);
        expect(await actorOf(handle).readWaitingBatches()).toHaveLength(1);
        // The restart's lease lapses with no commit: the rerun reads again.
        await run.tick(handle, LEASE_MS);
        await run.settle(handle);

        const first = await turnIdOf([a]);
        const restart = await turnIdOf([a, b]);
        expect(asked).toEqual([
          { turnId: first, tries: 1, eventIds: [a], answered: [a] },
          { turnId: restart, tries: 1, eventIds: [a, b], answered: [a, b] },
          { turnId: restart, tries: 2, eventIds: [a, b], answered: [a, b] },
        ]);
        // Every text's result is kept: the restart and the lapse removed none, and the waiting text's was never answered.
        expect(await rowsOf(handle)).toEqual([
          { eventId: a, kept: true },
          { eventId: b, kept: true },
          { eventId: c, kept: true },
        ]);
        expect(await idsIn(handle, "safety_closed")).toEqual([]);
      } finally {
        run.restore();
      }
    },
  );
});

// ---- a park, and a text whose row is gone --------------------------------------------------------------------------

describe("a park removes a turn's rows, and a text with no row ends each run noSafetyResult (ADR-015 card B)", () => {
  it(
    "a park removes them: a turn whose commit K-05 never takes keeps its row through its three runs, and the park at its third lapse removes it and closes the text",
    { timeout: TEST_MS },
    async () => {
      const run = rig(vi.spyOn(console, "log").mockImplementation(() => undefined));
      const handle = handleOf(65);
      try {
        const text = "evt-kept-6501";
        run.fakes.decide.recordTurn([text]);
        run.fakes.turnRows.failCommitsWith = { error: "transient" };
        await run.post(textOf(text, handle, JOIN_TEXT));
        await run.settle(handle);
        await run.tick(handle, QUIET_MS);
        const turnId = await turnIdOf([text]);
        for (let tries = 1; tries <= MAX_TRIES; tries += 1) {
          await until(
            () => run.fakes.turnRows.commits.length === 2 * tries,
            `try ${String(tries)}'s commits`,
            WAIT_MS,
          );
          await run.settle(handle);
          // Each run read the same kept result; the row stays while the turn can still commit.
          expect(recordsOf(run.watch.gateCalls.at(-1)?.request)).toEqual([run.reads.get(text)]);
          expect(await rowsOf(handle)).toEqual([{ eventId: text, kept: true }]);
          await run.tick(handle, LEASE_MS);
        }
        await until(
          () => run.fakes.turnRows.turns.get(turnId)?.state === "parked",
          "the parked row",
          WAIT_MS,
        );
        await run.settle(handle);

        expect(
          (await actorOf(handle).readTurns()).map((turn) => [turn.turnId, turn.state, turn.tries]),
        ).toEqual([[turnId, "parked", MAX_TRIES]]);
        expect(await rowsOf(handle)).toEqual([]);
        expect(await idsIn(handle, "safety_closed")).toEqual([text]);
      } finally {
        run.restore();
      }
    },
  );

  it(
    "a text whose row is gone before the run gives no frontier, decide or gate call (noSafetyResult), and its third lapse parks the turn with its one nothing-changed row",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = rig(log);
      const handle = handleOf(66);
      try {
        const text = "evt-kept-6601";
        run.fakes.decide.recordTurn([text]);
        await run.post(textOf(text, handle, JOIN_TEXT));
        await actorOf(handle).safetyIdle();
        // Its read kept its result; the row is gone before its batch closes.
        await dropRow(handle, text);
        await run.tick(handle, QUIET_MS);
        await run.settle(handle);
        const turnId = await turnIdOf([text]);
        for (let tries = 2; tries <= MAX_TRIES; tries += 1) {
          await run.tick(handle, LEASE_MS);
          await run.settle(handle);
          expect((await actorOf(handle).readTurns()).map((turn) => turn.tries)).toEqual([tries]);
        }
        await run.tick(handle, LEASE_MS);
        await until(() => run.fakes.turnRows.parks.length === 1, "the park", WAIT_MS);
        await run.settle(handle);

        // Each of its three runs read no result and ended before the frontier: no frontier, decide or gate call.
        const hops = run
          .spans()
          .filter((span) => span.turn_id === turnId)
          .map((span) => span.hop);
        expect(hops.filter((hop) => hop === "guard")).toHaveLength(MAX_TRIES);
        expect(
          hops.filter((hop) => ["frontier", "decideReads", "reread", "gate", "commit"].includes(hop)),
        ).toEqual([]);
        expect(run.fakes.frontier.reads).toEqual([]);
        expect(run.watch.decides.count).toBe(0);
        expect(run.watch.gateCalls).toEqual([]);
        expect(run.fakes.turnRows.commits).toEqual([]);
        // Its third lapse parked it through K-05's park: its one "nothing changed" row, under the same turn id.
        expect(
          run.fakes.turnRows.parks.map((park) => [
            park.turn.id,
            park.turn.tries,
            park.outboxRows.map((row) => row.id),
          ]),
        ).toEqual([[turnId, MAX_TRIES, [`out-${turnId}-parked`]]]);
        expect((await actorOf(handle).readTurns()).map((turn) => [turn.turnId, turn.state])).toEqual([
          [turnId, "parked"],
        ]);
        expect(await rowsOf(handle)).toEqual([]);
        expect(await idsIn(handle, "safety_closed")).toEqual([text]);
      } finally {
        run.restore();
      }
    },
  );
});

// ---- a danger text whose line fails --------------------------------------------------------------------------------

describe("a danger text whose line fails (ADR-015 card B)", () => {
  it(
    "in a turn that commits and whose reply ends, then its 30 s re-read: no row for it afterwards",
    { timeout: TEST_MS },
    async () => {
      const run = rig(vi.spyOn(console, "log").mockImplementation(() => undefined));
      const handle = handleOf(67);
      try {
        const danger = "evt-kept-6701";
        run.fakes.decide.recordTurn([danger]);
        // The turn's commit is the test's own (no row written): what it holds of the danger is the record it carries. It
        // is held at the gate until the test has read the actor's rows.
        run.watch.answer = (request, nth) =>
          Promise.resolve(
            committedAnswer(
              request,
              nth > 1,
              request.core.map(() => recordAnswer),
            ),
          );
        const gate = hold();
        run.watch.before.gate = (nth) => (nth === 1 ? gate.wait() : Promise.resolve());
        // The core does not answer and Linq refuses: the danger's line fails.
        run.fakes.core.down = true;
        run.fakes.direct.fail = true;
        await run.post(textOf(danger, handle, DANGER_TEXT));
        // No verdict (the double holds no read of these words): at 4 s the timeout rule finds the danger word.
        await run.fakes.clock.advance(4000);
        await actorOf(handle).safetyIdle();
        expect(await actorOf(handle).readSafety()).toMatchObject([
          { eventId: danger, state: "lineFailed", danger: true },
        ]);
        expect(run.fakes.direct.sent).toEqual([]);
        expect(run.fakes.core.recorded).toEqual([]);
        expect(await idsIn(handle, "safety_pending")).toEqual([danger]);

        // The danger closed its batch at once and counts as read: its turn goes to its commit, carrying the kept result.
        await until(() => run.watch.gateCalls.length === 1, "the danger turn's gate call", WAIT_MS);
        expect(await rowsOf(handle)).toEqual([{ eventId: danger, kept: true }]);
        const records = recordsOf(run.watch.gateCalls[0]?.request);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ eventId: danger, outcomes: ["Unsure"], timedOut: true });

        // It commits and its reply ends, which removes the row and closes the text; the danger stays open, its line not
        // gone.
        gate.closed = false;
        const turnId = await turnIdOf([danger]);
        await run.untilReplied(handle, turnId);
        await run.settle(handle);
        expect(await rowsOf(handle)).toEqual([]);
        expect(await idsIn(handle, "safety_closed")).toEqual([danger]);
        expect(await idsIn(handle, "safety_pending")).toEqual([danger]);

        // The core answers again; the 30 s re-read applies the danger again and its line goes, through the core. Its
        // text is closed, so nothing is kept for it, and the danger is complete.
        run.fakes.core.down = false;
        run.fakes.direct.fail = false;
        await run.tick(handle, REREAD_MS);
        await run.settle(handle);
        await until(
          () => run.fakes.core.recorded.length === 1,
          "the danger's line through the core",
          WAIT_MS,
        );
        await run.settle(handle);
        expect(run.fakes.core.recorded.map((entry) => entry.request.safety.eventId)).toEqual([danger]);
        expect(await rowsOf(handle)).toEqual([]);
        expect(await idsIn(handle, "safety_closed")).toEqual([danger]);
        expect(await idsIn(handle, "safety_pending")).toEqual([]);
      } finally {
        run.restore();
      }
    },
  );
});

// ---- a STOP, with PostgreSQL down and with it up -------------------------------------------------------------------

describe("a STOP's kept result (ADR-015 card B)", () => {
  it(
    "a STOP taken while PostgreSQL is down has its row removed and its text closed at the hand-off, and joins no turn",
    { timeout: TEST_MS },
    async () => {
      const run = rig(vi.spyOn(console, "log").mockImplementation(() => undefined));
      const handle = handleOf(68);
      try {
        const prime = "evt-kept-6801";
        const stop = "evt-kept-6802";
        // The PostgreSQL-down path, wired over the root's own sealing port (the STOP is opened with the handle's key).
        const db = dbFakes(
          run.root.ports.sealing,
          {},
          { start: run.fakes.clock.now(), ids: idsOf(SAM.party) },
        );
        run.also(setDbOutageDeps(db.outageDeps));
        // While PostgreSQL answers, a first turn pins bundle v0 (the actor copies its keyword list), commits and replies.
        run.fakes.decide.recordTurn([prime]);
        await run.post(textOf(prime, handle, JOIN_TEXT));
        await run.settle(handle);
        await run.tick(handle, QUIET_MS);
        const primeTurn = await turnIdOf([prime]);
        await run.untilReplied(handle, primeTurn);
        await run.settle(handle);

        // PostgreSQL goes down; a STOP arrives. Its read keeps its result (No), and the actor takes it at once.
        db.down = true;
        await run.post(textOf(stop, handle, STOP_TEXT));
        await run.settle(handle);
        expect(db.direct.sent.map((sent) => sent.idempotencyKey)).toEqual([`keyword:${stop}:stopReply`]);
        expect((await actorOf(handle).readOutage()).texts.filter((text) => text.eventId === stop)).toEqual([
          expect.objectContaining({ kind: "stop", keyword: "handled" }),
        ]);
        expect(run.reads.get(stop)).toEqual(safetyNoFor(stop));
        // Its batch closes and is kept back while PostgreSQL is down: its result is still kept, its text open.
        await run.tick(handle, QUIET_MS);
        await run.settle(handle);
        expect(await handedOf(handle, stop)).toEqual([false]);
        expect(await rowsOf(handle)).toEqual([{ eventId: stop, kept: true }]);
        expect(await idsIn(handle, "safety_closed")).toEqual([prime]);

        // PostgreSQL is back: the queue replays the STOP's record, and the batch is handed on without the STOP the actor
        // took. At that hand-off its row is removed and its text closed; it joins no turn.
        db.down = false;
        await run.tick(handle, PROBE_MS);
        await run.settle(handle);
        await until(() => db.stops.length === 1, "the STOP's record on return", WAIT_MS);
        await run.settle(handle);
        expect(db.stops.map((request) => [request.kind, request.inboundEventId])).toEqual([["stop", stop]]);
        expect(await handedOf(handle, stop)).toEqual([true]);
        expect(await rowsOf(handle)).toEqual([]);
        expect(await idsIn(handle, "safety_closed")).toEqual([prime, stop]);
        expect((await actorOf(handle).readTurns()).map((turn) => turn.eventIds)).toEqual([[prime]]);
        expect(run.watch.gateCalls.map((call) => recordsOf(call.request))).toEqual([[run.reads.get(prime)]]);
      } finally {
        run.restore();
      }
    },
  );

  it(
    "a STOP in a turn with PostgreSQL up is recorded with its result, and its row goes when its turn ends",
    { timeout: TEST_MS },
    async () => {
      const run = rig(vi.spyOn(console, "log").mockImplementation(() => undefined));
      const handle = handleOf(69);
      try {
        const stop = "evt-kept-6901";
        // T-267's replies, over its shared-core double holding this number's phone (K-04: not stopped, version 3); the
        // keyword commit answered as ../turn/lease-turn.worker.test.ts answers it, behind the lease.
        const core = fakeReplyCore(stopRecorded.request.now, [
          phone(handle.address, SAM.party.handleId, SAM.party.personId, 3),
        ]);
        run.also(setReplyDeps({ core: turnReplyCore, rows: core.rows, rosieNumber: ROSIE_NUMBER }));
        run.watch.answer = async (request, nth) => {
          const records = request.core.filter((action) => action.call === "recordSafetyOutcome");
          const answer = await core.core.commitCore({
            caller: request.caller as never,
            actions: request.core.slice(records.length) as never,
          });
          if ("error" in answer) return answer;
          return committedAnswer(request, nth > 1, [...records.map(() => recordAnswer), ...answer.core]);
        };
        await run.post(textOf(stop, handle, STOP_TEXT));
        await run.settle(handle);
        expect(await rowsOf(handle)).toEqual([{ eventId: stop, kept: true }]);
        await run.tick(handle, QUIET_MS);
        const turnId = await turnIdOf([stop]);
        await run.untilReplied(handle, turnId);
        await run.settle(handle);

        // The STOP's turn commits core-only: its recordSafetyOutcome carries exactly the result its read gave, then its
        // recordStopOrStart; the phone row reads stopped.
        expect(run.watch.gateCalls).toHaveLength(1);
        const request = run.watch.gateCalls[0]?.request;
        expect(request?.input).toEqual({ kind: "coreOnly" });
        expect(request?.core.map((action) => action.call)).toEqual([
          "recordSafetyOutcome",
          "recordStopOrStart",
        ]);
        expect(recordsOf(request)).toEqual([run.reads.get(stop)]);
        expect(run.reads.get(stop)).toEqual(safetyNoFor(stop));
        expect(core.phones.get(handle.address)?.stopped).toBe(true);
        // Its turn ended: its row is gone and its text closed (no hand-off took it alone).
        expect(await rowsOf(handle)).toEqual([]);
        expect(await idsIn(handle, "safety_closed")).toEqual([stop]);
      } finally {
        run.restore();
      }
    },
  );
});
