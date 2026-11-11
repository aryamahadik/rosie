// T-559's join, hop 8 of D-017 (C-046; build prompt section 10, D-017: "gate and one commit (state, the open question and
// its clock row, one outbox row, event log, under the turn id)"; 02-contracts section 11, 'Gate and one commit': K-09,
// K-05, K-04, K-07, K-08; ADR-013 sections 4 and 6; K-09 v1.5 README defaults 130 to 136), in the Workers runtime. The
// composition root is composed for the test environment as hop 7's tests compose it (the HandleActor namespace, the
// skeleton flag on, the actor's ports installed, every joined port fed its double), now with the gate port this hop joins:
// @rosie/actions' turn face's gateAndCommit (T-1141: the Tool API base with K-09 v1.5's checks and the call's business
// scope, T-305's gate with limits 1 to 6, T-1139's walk on the pinned bundle, T-1140's runCore, one K-05 commitTurn), its
// one commit through the root's turn-row port to the K-05 double over an in-memory K-04 (./test-support.ts fakeTurnRows),
// and its reads over test owner 1's seeded rows (fakeGateReads).
//
//   - The JOIN as recording 2 names it (evt-sam-0000, test owner 1, Sam's chat): hops 1 to 8 once each; one gate span
//     for the turn's one part, with commit-s1-01.json's limits (1, 4 and 6 pass; 2, 3 and 5 not checked), as K-08's
//     trace-skeleton.json draws them; one commit span naming commit-s1-01.json's rows by the run's ids; and K-04 holds
//     exactly the turn row (K-05's seven fields alone), the thread row, S1-02's open question, its clock row (waiting,
//     unarmed), one outbox row, the safety record's outcome row and their event-log entries, all under the one turn id
//     and the one trace id, each row id built by K-09 v1.5 default 131 from the turn's own id, each row's values those
//     commit-s1-01.json's given.stated.writes states but for the ids (the chat id is the stand-in both use). The request's
//     turn carried the JOIN event's service and chat id (default 135): the thread row and the outbox row took them, the
//     walk's one source. No span, log line or event-log entry's values holds the chat id.
//   - Hard invariant (exactly once): the same gateAndCommit again under the same turn id answers the first commit,
//     repeated, and writes nothing.
//   - Concurrency: two actors (two roots over one K-05) forced to commit the same turn id in parallel give one commit.
//
// The Durable Objects' storage is not cleared between this file's tests, so each test's texts go to a handle no other test
// uses, or to a fresh rig whose K-05 has seen nothing. Test values only (rule 9): the master's sample cast, the fictional
// 555-01xx numbers and the fixtures' own words.
import joinRunContext from "@rosie/ai/recordings/contexts/join-s1-01.json";
import traceSkeleton from "@rosie/contracts/event-trace/fixtures/trace-skeleton.json";
import textFixture from "@rosie/contracts/inbound-event/fixtures/text-imessage.json";
import commitS101 from "@rosie/contracts/tool-api/fixtures/commit-s1-01.json";
import { reset, runDurableObjectAlarm } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { QUIET_MS, turnIdOf, type HandleActor } from "../actor";
import { actorNameOf } from "../gateway";
import { openTrace, type Hop, type Span, type Trace } from "../trace";
import { checkHops, hopsOfTrace, leaks, spansOfLogLines, spansOfTrace } from "../trace/hop-check";
import { flush } from "../turn/test-support";
import type { GateCommitted } from "../turn/types";
import { composeRoot, SKELETON_FLAG, withTextSource, type HandleActors, type Root } from "./index";
import {
  BUNDLE_V0,
  fakeFlags,
  SAM_CHAT,
  skeletonFakes,
  TEST_OWNER_1,
  watchGate,
  type LinqInboundEvent,
  type SignedWebhook,
  type SkeletonFakes,
  type WatchedGateCall,
  type WrittenRow,
} from "./test-support";

type Json = Record<string, unknown>;
type Namespace = DurableObjectNamespace<HandleActor>;

/** A run through the Workers runtime's own steps: a resource guard above Vitest's 5 s default. */
const TEST_MS = 30_000;
/** How long a step of the actor's lent work may take before a wait gives up. */
const WAIT_MS = 15_000;

const SKELETON = traceSkeleton as unknown as Trace;
/** Hops 1 to 8 of a text's trace (K-08 trace-skeleton.json), in D-017's turn order: receive to the commit. */
const HOPS_1_TO_8: readonly Hop[] = hopsOfTrace(SKELETON).slice(
  0,
  hopsOfTrace(SKELETON).indexOf("commit") + 1,
);
/** Hops of those with no writer yet (T-260's gap b): the batch window writes no span until T-1108. Judged once written. */
const NO_WRITER_YET: readonly Hop[] = ["scrub", "batch"];

/** trace-skeleton.json's span of `hop`. */
function skeletonSpan(hop: Hop): Span {
  const span = SKELETON.spans.find((candidate) => candidate.hop === hop);
  if (span === undefined) throw new Error(`trace-skeleton.json has no ${hop} span`);
  return span;
}

/** K-09 v1.5 commit-s1-01.json as this file reads it: the rows its part gives (default 136) and its outcome. */
const S1_01 = commitS101 as unknown as {
  readonly given: {
    readonly stated: {
      readonly writes: {
        readonly state: readonly { readonly table: string; readonly values: Json }[];
        readonly openQuestions: readonly Json[];
        readonly outboxRows: readonly Json[];
      };
    };
  };
  readonly request: {
    readonly turn: { readonly id: string; readonly chatId: string; readonly service: string };
  };
  readonly outcome: {
    readonly parts: readonly { readonly limits: readonly Json[] }[];
    readonly written: {
      readonly written: readonly { readonly table: string; readonly rowId: string }[];
      readonly outboxRows: readonly { readonly id: string }[];
    };
  };
};
/** The fixture's turn key, as default 131 builds its row ids (`<kind>-<step>-sam-<n>`): the run's is its turn id. */
const FIXTURE_KEY = "sam";

/** The fixture's ids, built from the run's turn id instead (K-09 v1.5 default 131), in its values and keys alike. */
function asRun<T>(value: T, turnId: string): T {
  return JSON.parse(JSON.stringify(value).replaceAll(`-${FIXTURE_KEY}-1"`, `-${turnId}-1"`)) as T;
}

/** The JOIN run's own context (K-02 README "v1.1", recording 2; T-1145 round 2, DL-347). */
const JOIN_CONTEXT = joinRunContext as unknown as {
  readonly turnId: string;
  readonly texts: readonly {
    readonly eventId: string;
    readonly words: string;
    readonly sentAt: { utc: string };
  }[];
};
const [JOIN_TEXT_OF_RECORDING] = JOIN_CONTEXT.texts;

/** The fictional numbers this file's texts come from, in each form a number could leak in. */
const CAST_NUMBERS = ["0100"].flatMap((line) => [`+1555555${line}`, `1555555${line}`, `555555${line}`]);

const OWNER_ACTOR = actorNameOf(TEST_OWNER_1.handle);

function namespace(): Namespace {
  return (exports as unknown as { HandleActor: Namespace }).HandleActor;
}

/** The HandleActor namespace as the root takes it (exports.HandleActor in the pool). */
function handleActors(): HandleActors<DurableObjectId> {
  const ns = namespace();
  return { idFromName: (name) => ns.idFromName(name), get: (id) => ns.get(id) };
}

function stubOf(actorName: string): DurableObjectStub<HandleActor> {
  return namespace().get(namespace().idFromName(actorName));
}

/** Waits until the actor has read every text and handed on, and run, what its batch window and lease can. */
async function settle(actorName: string): Promise<void> {
  await stubOf(actorName).safetyIdle();
  await stubOf(actorName).batchIdle();
}

/** Waits until a committed turn's reply has ended and its lease is released (T-253). */
async function untilReplied(actorName: string, turnId: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    const turn = (await stubOf(actorName).readTurns()).find((entry) => entry.turnId === turnId);
    if (turn?.state === "committed" && turn.leaseUntil === null) return;
    if (Date.now() - started > WAIT_MS) {
      throw new Error(`gave up waiting for the turn's reply to end (state ${turn?.state ?? "none"})`);
    }
    await flush(5);
  }
}

/** The JOIN as recording 2 names it: K-06 text-imessage.json's form from test owner 1, on Sam's chat (imessage). */
function joinAsRecorded(): LinqInboundEvent {
  if (JOIN_TEXT_OF_RECORDING === undefined) throw new Error("recording 2's context holds its text");
  return {
    ...(structuredClone(textFixture) as Json),
    eventId: JOIN_TEXT_OF_RECORDING.eventId,
    handle: { ...TEST_OWNER_1.handle },
    body: JOIN_TEXT_OF_RECORDING.words,
    sentAt: JOIN_TEXT_OF_RECORDING.sentAt.utc,
    chatId: SAM_CHAT,
    messageId: `linq-msg-demo-in-${JOIN_TEXT_OF_RECORDING.eventId}`,
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

/** The handle actor's own receive span, beside the gateway's (T-1108). */
const actorReceive = (span: Span): boolean => span.hop === "receive" && span.got?.door === "handleActor";

/** A model call's own span beside the hops: a portCall to provider anthropic, one per attempt. */
const modelCall = (span: Span): boolean => span.hop === "portCall" && span.provider === "anthropic";

/** Every line a console method was handed, as text. */
const linesOf = (spy: MockInstance): string[] =>
  spy.mock.calls.map((call: unknown[]) =>
    call.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" "),
  );

/** The root for "test", every joined port fed its double (the gate's reads among them), composed over `fakes`. */
function testRoot(fakes: SkeletonFakes, actors: HandleActors<DurableObjectId> | null): Root {
  return composeRoot({
    environment: "test",
    sets: { fake: fakes.ports },
    actors,
    vars: env,
    clock: fakes.clock,
    linq: fakes.linqInputs,
    handleKey: fakes.handleKeys.call,
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
    flags: fakeFlags([SKELETON_FLAG]),
  });
}

interface Rig {
  readonly fakes: SkeletonFakes;
  readonly root: Root;
  /** Each gateAndCommit the turn handed the root, as the turn made it, with the gate port's answer. */
  readonly gateCalls: WatchedGateCall[];
  post(event: LinqInboundEvent): Promise<string>;
  spans(): Span[];
  traceOf(traceId: string): Span[];
  restore(): void;
}

/** The root for "test" with the HandleActor namespace, its actor ports installed and the turn's gate calls watched. */
function rig(log: MockInstance): Rig {
  const fakes = skeletonFakes();
  const root = testRoot(fakes, handleActors());
  const restoreRoot = root.install();
  const watched = watchGate(root);
  const spans = (): Span[] => spansOfLogLines(log.mock.calls.map((call: unknown[]) => call[0]));
  return {
    fakes,
    root,
    gateCalls: watched.calls,
    async post(event) {
      const response = await root.linqWebhook(webhookRequest(await fakes.sign(event)));
      if (response.status !== 200) throw new Error(`the gateway answered ${String(response.status)}`);
      const traceId = response.headers.get("x-trace-id");
      if (traceId === null) throw new Error("the gateway answered with no trace id");
      return traceId;
    },
    spans,
    traceOf: (traceId) => spansOfTrace(spans(), traceId),
    restore() {
      watched.restore();
      restoreRoot();
    },
  };
}

/** The JOIN's turn, run on `run` to its reply: its turn id and trace id. */
async function runJoin(run: Rig): Promise<{ turnId: string; traceId: string }> {
  const join = joinAsRecorded();
  run.fakes.known(join.eventId);
  const traceId = await run.post(join);
  await settle(OWNER_ACTOR);
  await run.fakes.clock.advance(QUIET_MS);
  await runDurableObjectAlarm(stubOf(OWNER_ACTOR));
  const turnId = await turnIdOf([join.eventId]);
  try {
    await untilReplied(OWNER_ACTOR, turnId);
  } catch (error) {
    const seen = run.traceOf(traceId).map((span) => `${span.hop}:${span.outcome}:${span.error_code ?? ""}`);
    throw new Error(
      `${error instanceof Error ? error.message : "no reply"}; the trace shows ${seen.join(", ")}`,
      { cause: error },
    );
  }
  await settle(OWNER_ACTOR);
  return { turnId, traceId };
}

/** The one span of a hop in a trace. */
function onlySpan(spans: readonly Span[], hop: Hop): Span {
  const found = spans.filter((span) => span.hop === hop);
  expect(found.map((span) => span.hop)).toEqual([hop]);
  const [span] = found;
  if (span === undefined) throw new Error(`no ${hop} span`);
  return span;
}

/** The rows of one table the K-05 double wrote. */
function rowsIn(fakes: SkeletonFakes, table: string): WrittenRow[] {
  return [...(fakes.turnRows.rows.get(table)?.values() ?? [])];
}

/** How many rows each table holds, and the event log's length: what a commit that writes nothing leaves as it was. */
function countsOf(fakes: SkeletonFakes): Json {
  return {
    turns: fakes.turnRows.turns.size,
    ...Object.fromEntries([...fakes.turnRows.rows].map(([table, rows]) => [table, rows.size])),
    eventLog: fakes.turnRows.eventLog.length,
  };
}

/** Every string a value holds, at any depth. */
function stringsOf(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value as unknown[]) stringsOf(item, into);
  else if (typeof value === "object" && value !== null)
    for (const item of Object.values(value)) stringsOf(item, into);
  return into;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await reset();
});

describe("hop 8 joined: the gate and one commit through @rosie/actions' turn face, under the turn id", () => {
  it(
    "the JOIN: hops 1 to 8 once each; one gate span with commit-s1-01.json's limits and one commit span with its rows; K-04 holds exactly 1 turn row (K-05's seven fields alone), 1 thread row, 1 open question, 1 clock row (waiting, unarmed), 1 outbox row and the event-log entries, under one turn id and one trace id, each id built from the turn's own id and each value commit-s1-01.json's; the request's turn carried the JOIN event's service and chat id; no span, log line or event-log value holds the chat id",
    { timeout: TEST_MS },
    async () => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const run = rig(log);
      try {
        const { turnId, traceId } = await runJoin(run);
        const trace = run.traceOf(traceId);

        // Hops 1 to 8 once each, in turn order, under the trace id and one bundle id; the model calls set aside.
        const unwritten = NO_WRITER_YET.filter((hop) => !trace.some((span) => span.hop === hop));
        const report = checkHops(trace, {
          traceId,
          expected: HOPS_1_TO_8,
          notWritten: unwritten,
          extra: (span) => actorReceive(span) || modelCall(span) || !HOPS_1_TO_8.includes(span.hop),
        });
        expect(report.problems).toEqual([]);
        expect(report.judged).toEqual(expect.arrayContaining(["decideReads", "gate", "commit"]));

        // The gate: one span for the turn's one part (the turn's; the Tool API base records none, DL-376), its limits
        // commit-s1-01.json's, as trace-skeleton.json's gate span logs them: 1, 4 and 6 pass; 2, 3 and 5 not checked.
        const gate = onlySpan(trace, "gate");
        expect(gate.limits).toEqual(skeletonSpan("gate").limits);
        expect(gate.limits).toEqual(S1_01.outcome.parts[0]?.limits);
        expect(gate).toMatchObject({
          outcome: "ok",
          error_code: null,
          turn_id: turnId,
          bundle_id: BUNDLE_V0,
          business_id: TEST_OWNER_1.businessId,
          decided: { part: 0, result: "committed", choice: "c-01" },
        });
        // The commit: one span, its rows commit-s1-01.json's (the thread, S1-02's question, its clock row and the outbox
        // row: the core action's own row is named in its response), each by the run's id.
        const commit = onlySpan(trace, "commit");
        const fixtureRows = [
          ...S1_01.outcome.written.written.map((row) => ({ table: row.table, id: row.rowId })),
          ...S1_01.outcome.written.outboxRows.map((row) => ({ table: "outbox_rows", id: row.id })),
        ];
        expect(commit.rows).toEqual(asRun(fixtureRows, turnId));
        expect(commit).toMatchObject({
          outcome: "ok",
          error_code: null,
          turn_id: turnId,
          decided: { repeated: false, parts: 1, committedParts: 1, core: 1, outboxRows: 1 },
        });
        expect(Date.parse(gate.at)).toBeGreaterThanOrEqual(Date.parse(onlySpan(trace, "decideReads").at));

        // The turn made one gateAndCommit, on decide's result; its request's turn is K-05's, and the root put the JOIN
        // event's service and chat id on it before the gate port took it (default 135): the gate answered committed.
        expect(run.gateCalls).toHaveLength(1);
        const [call] = run.gateCalls;
        if (call === undefined) throw new Error("the turn made no gateAndCommit");
        expect(call.request.turn).toEqual({
          id: turnId,
          handleId: TEST_OWNER_1.handleId,
          eventIds: [JOIN_CONTEXT.texts[0]?.eventId],
          bundleId: BUNDLE_V0,
          traceId,
          joinedTraceIds: [],
          tries: 1,
        });
        expect(call.answer).toMatchObject({ result: "committed", turnId, repeated: false });

        // K-05: one commitTurn, its turn K-05's seven fields alone, under the lease's turn id and the JOIN's trace.
        expect(run.fakes.turnRows.commits).toHaveLength(1);
        const [k05] = run.fakes.turnRows.commits;
        expect(k05?.turn).toEqual(call.request.turn);
        expect(Object.keys(k05?.turn ?? {}).sort()).toEqual([
          "bundleId",
          "eventIds",
          "handleId",
          "id",
          "joinedTraceIds",
          "traceId",
          "tries",
        ]);

        // K-04: exactly one turn row, committed.
        expect([...run.fakes.turnRows.turns.values()]).toMatchObject([
          {
            id: turnId,
            handleId: TEST_OWNER_1.handleId,
            state: "committed",
            traceId,
            bundleId: BUNDLE_V0,
            tries: 1,
          },
        ]);
        // Exactly one row in each table the part writes, and the safety record's outcome row (the core action's).
        expect([...run.fakes.turnRows.rows.keys()].sort()).toEqual([
          "clock_rows",
          "open_questions",
          "outbox_rows",
          "safety_outcomes",
          "threads",
        ]);
        const stated = S1_01.given.stated.writes;
        // The thread (S1-01): chat, no booking, its linq_chat_id the JOIN event's chat id, no reply address.
        const [threadWrite] = stated.state;
        expect(
          rowsIn(run.fakes, "threads").map((row) => [row.id, row.values, row.version, row.turnId]),
        ).toEqual([[`thread-s1-01-${turnId}-1`, asRun(threadWrite?.values, turnId), 1, turnId]]);
        expect(rowsIn(run.fakes, "threads")[0]?.values).toMatchObject({
          kind: "chat",
          booking_id: null,
          linq_chat_id: SAM_CHAT,
          reply_address: null,
        });
        // S1-02's open question: no options, clock null (step 9's default), waiting.
        expect(rowsIn(run.fakes, "open_questions").map((row) => [row.id, row.values, row.version])).toEqual([
          [`oq-s1-02-${turnId}-1`, { ...asRun(stated.openQuestions[0], turnId), status: "waiting" }, 1],
        ]);
        // Its clock row, the commit's own: waiting, not armed until the first delivery receipt (arch 02 line 127).
        expect(rowsIn(run.fakes, "clock_rows").map((row) => [row.id, row.version])).toEqual([
          [`clock-oq-s1-02-${turnId}-1`, 1],
        ]);
        expect(rowsIn(run.fakes, "clock_rows")[0]?.values).toMatchObject({
          kind: "question",
          openQuestionId: `oq-s1-02-${turnId}-1`,
          handleId: TEST_OWNER_1.handleId,
          businessId: TEST_OWNER_1.businessId,
          bookingId: null,
          fires: { step: "S1-02" },
          state: "waiting",
          createdByTurnId: turnId,
        });
        expect(rowsIn(run.fakes, "clock_rows")[0]?.values.due ?? null).toBeNull();
        // The one outbox row: to Sam, on the JOIN event's service, quick_reply, the question's id, no plan.
        expect(rowsIn(run.fakes, "outbox_rows").map((row) => [row.id, row.values, row.version])).toEqual([
          [`outbox-s1-02-${turnId}-1`, { ...asRun(stated.outboxRows[0], turnId), commitSeq: 1 }, 1],
        ]);
        expect(rowsIn(run.fakes, "outbox_rows")[0]?.values).toMatchObject({
          channel: "imessage",
          sendClass: "quick_reply",
          openQuestionId: `oq-s1-02-${turnId}-1`,
        });
        expect(rowsIn(run.fakes, "outbox_rows")[0]?.values).not.toHaveProperty("plan");
        // The safety record (K-09 README default 5): the JOIN read No, under the turn, its words sealed for Sam.
        const outcomes = rowsIn(run.fakes, "safety_outcomes");
        expect(outcomes.map((row) => row.values)).toMatchObject([
          {
            event_id: JOIN_CONTEXT.texts[0]?.eventId,
            turn_id: turnId,
            business_id: TEST_OWNER_1.businessId,
            outcomes: ["No"],
          },
        ]);
        expect(run.fakes.gate.sealedFor).toEqual([TEST_OWNER_1.personId]);
        expect(stringsOf(outcomes)).not.toContain("JOIN");

        // The event log: one entry per row, each under the turn id, its trace and its bundle.
        const logRows = run.fakes.turnRows.eventLog;
        expect(logRows.map((row) => [row.table_name, row.row_id])).toEqual(
          expect.arrayContaining([
            ["threads", `thread-s1-01-${turnId}-1`],
            ["open_questions", `oq-s1-02-${turnId}-1`],
            ["outbox_rows", `outbox-s1-02-${turnId}-1`],
          ]),
        );
        expect(new Set(logRows.map((row) => row.turn_id))).toEqual(new Set([turnId]));
        expect(new Set(logRows.map((row) => row.trace_id))).toEqual(new Set([traceId]));
        expect(
          new Set(logRows.map((row) => `${String(row.bundle_hash)}/${String(row.bundle_build)}`)),
        ).toEqual(new Set([`${BUNDLE_V0.hash}/${String(BUNDLE_V0.build)}`]));

        // The gate's reads ran under Lee's Barbershop's scope only, every one naming it.
        expect(run.fakes.gate.scopes).toEqual([TEST_OWNER_1.businessId]);
        expect(new Set(run.fakes.gate.seen.map((read) => read.businessId))).toEqual(
          new Set([TEST_OWNER_1.businessId]),
        );

        // The chat id's one home is the thread row: no span, log line or event-log entry's values hold it.
        expect(leaks(run.spans(), [SAM_CHAT, ...CAST_NUMBERS, "JOIN"])).toEqual([]);
        expect([...linesOf(log), ...linesOf(warn)].filter((line) => line.includes(SAM_CHAT))).toEqual([]);
        expect(
          stringsOf(logRows.map((row) => [row.old_values, row.new_values])).filter((text) =>
            text.includes(SAM_CHAT),
          ),
        ).toEqual([]);
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        run.restore();
      }
    },
  );

  it(
    "Hard invariant (exactly once): the same gateAndCommit again under the same turn id answers the first commit, repeated, and writes nothing",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const run = rig(log);
      try {
        const { turnId } = await runJoin(run);
        const [call] = run.gateCalls;
        if (call === undefined) throw new Error("the turn made no gateAndCommit");
        const first = call.answer as GateCommitted;
        const before = countsOf(run.fakes);
        const spansBefore = run.spans().length;

        const again = (await run.root.turn.toolApi.gateAndCommit(
          call.request,
          call.at,
          call.trace,
        )) as GateCommitted;

        expect(again).toMatchObject({
          result: "committed",
          turnId,
          committedAt: first.committedAt,
          repeated: true,
          parts: first.parts,
        });
        expect(again.written.outboxRows).toEqual(first.written.outboxRows);
        // The safety record answers its first record too (the text's event id is its key): nothing new is recorded.
        expect(again.core).toMatchObject([
          { call: "recordSafetyOutcome", response: { repeated: true }, error: null },
        ]);
        // Nothing written: every table and the event log as the first commit left them; K-05 was asked once more.
        expect(countsOf(run.fakes)).toEqual(before);
        expect(run.fakes.turnRows.commits.map((request) => request.turn.id)).toEqual([turnId, turnId]);
        // The base records no span for it: the turn records the gate and the commit, and it made this call no more.
        expect(run.spans()).toHaveLength(spansBefore);
      } finally {
        run.restore();
      }
    },
  );

  it(
    "Concurrency: two actors forced to commit the same turn id in parallel give one commit",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const run = rig(log);
      let request: WatchedGateCall["request"];
      let at: WatchedGateCall["at"];
      try {
        await runJoin(run);
        const [call] = run.gateCalls;
        if (call === undefined) throw new Error("the turn made no gateAndCommit");
        ({ request, at } = call);
      } finally {
        run.restore();
      }

      // A K-05 that has seen nothing, and two roots over it, as two actors' isolates over one database. Each is handed the
      // turn's request with the JOIN event's service and chat id on its turn, as each actor's root puts them there.
      const fakes = skeletonFakes();
      const roots = [testRoot(fakes, null), testRoot(fakes, null)];
      const sent = withTextSource(request, { service: "imessage", chatId: SAM_CHAT });
      const traceOf = () =>
        openTrace({
          openedBy: "textWebhook",
          bundleId: BUNDLE_V0,
          incomingTraceId: request.caller.traceId,
          sink: () => undefined,
          now: () => Date.now(),
        });

      const answers = (await Promise.all(
        roots.map((root) => root.turn.toolApi.gateAndCommit(sent, at, traceOf())),
      )) as GateCommitted[];

      expect(answers.map((answer) => [answer.result, answer.turnId])).toEqual([
        ["committed", request.turn.id],
        ["committed", request.turn.id],
      ]);
      expect(answers.map((answer) => answer.repeated).sort()).toEqual([false, true]);
      expect(new Set(answers.map((answer) => answer.committedAt)).size).toBe(1);
      expect(answers[0]?.written.outboxRows).toEqual(answers[1]?.written.outboxRows);
      // One commit: the turn row, each row and each event-log entry written once.
      expect(fakes.turnRows.commits.map((commit) => commit.turn.id)).toEqual([
        request.turn.id,
        request.turn.id,
      ]);
      expect(countsOf(fakes)).toEqual({
        turns: 1,
        safety_outcomes: 1,
        threads: 1,
        open_questions: 1,
        clock_rows: 1,
        outbox_rows: 1,
        eventLog: fakes.turnRows.eventLog.length,
      });
      expect(new Set(fakes.turnRows.eventLog.map((row) => row.id)).size).toBe(fakes.turnRows.eventLog.length);
    },
  );

  it(
    "a gateAndCommit whose trace is no run's carries neither the service nor the chat id: the walk fails the sign-up door's part closed, never guessed, and nothing is written",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const run = rig(log);
      let request: WatchedGateCall["request"];
      let at: WatchedGateCall["at"];
      try {
        await runJoin(run);
        const [call] = run.gateCalls;
        if (call === undefined) throw new Error("the turn made no gateAndCommit");
        ({ request, at } = call);
      } finally {
        run.restore();
      }
      // The turn's own request carries K-05's turn alone: the root puts the text's service and chat id on it.
      expect(request.turn).not.toHaveProperty("service");
      expect(request.turn).not.toHaveProperty("chatId");

      const fakes = skeletonFakes();
      const root = testRoot(fakes, null);
      const trace = openTrace({
        openedBy: "textWebhook",
        bundleId: BUNDLE_V0,
        incomingTraceId: request.caller.traceId,
        sink: () => undefined,
        now: () => Date.now(),
      });

      await expect(root.turn.toolApi.gateAndCommit(request, at, trace)).rejects.toMatchObject({
        name: "WalkRefusedError",
        fault: "noServiceOrChatId",
      });
      expect(fakes.turnRows.commits).toEqual([]);
      expect(countsOf(fakes)).toEqual({ turns: 0, eventLog: 0 });
    },
  );
});
