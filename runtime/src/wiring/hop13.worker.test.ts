// T-564's join, hop 13 of D-017, the walking skeleton's last (C-055, C-044; build prompt section 10, D-017; 02-contracts
// section 11, 'Delivery receipt; the clock arms': K-06 delivered, K-05 arm; ADR-013 section 6: K-09 README v1.5 default
// 134), in the Workers runtime. The composition root is composed for the test environment as hop 12's tests compose it,
// now with this hop's port: the arming (./real.ts realArming, RootOptions.armingCalls), over K-05 doubles of armClock and
// cancelClock and the question's facts on the rows the commit wrote (./test-support.ts fakeArmingCalls). The JOIN runs to
// its reply (one part sent to @rosie/adapters' Linq double), then the double's own delivery receipt for that part
// (T-411's fakeDelivered, carried as a K-06 delivered event by T-412's eventFromDoubleEvent) reaches the gateway:
//
//   - The receipt door marks the part delivered (K-05 markPart, the row's first delivery, naming S1-02's question) and
//     hands it to T-255's clock arming, which arms S1-02's clock row (K-05 armClock) at step 9's due time: S1-02's card
//     sets no Clock line and the question is about no visit, so 8pm the day after delivery in Lee's Barbershop's zone
//     (arch 02 line 127; K-09 README v1.5 default 134). Its question opens; there is no never-delivered row to cancel (the
//     commit's own, STATE note 37), and Sam's actor is told. The delivered and clockArmed spans go on the JOIN's trace,
//     under its trace id and bundle v2, after the part's providerAccepted span; the receipt's webhook has its own trace,
//     its receive alone.
//   - A second delivered event for the same part (Linq's retry of the webhook, and another event for the part) arms
//     nothing more: K-05 answers it repeated, saying it repeats the row's first delivery at that delivery's stored time
//     (K-05 v1.9 item 48), so the dispatcher hands it back to the arming (T-1228), whose memory of the armed part makes
//     no K-05 call: its clockArmed span says repeated.
//   - With no arming calls bound (the Worker until T-567), the part is still marked delivered and the arming fails
//     closed: nothing is armed, its span says it failed, and the receipt is answered 503 (T-1244).
//
// T-1244: a receipt whose arming ends failed is not answered as done. The arming's port rejects (ArmingNotDone), the
// gateway answers 503 with the part still marked delivered, and Linq sends the receipt again: a repeat of the row's first
// delivery, handed back to the arming, which arms the clock once, and answered 200. A repeat after a completed arming is
// answered 200 with no second clock row, in the isolate that armed it (its memory) or another (K-05 armClock answers it
// repeated), and a receipt for a row that asks no question is answered 200 with nothing read or armed.
//
// T-1514 (DL-1033 fault 2; K-05 v1.21 defaults 200 to 204): Rosie's first-text lines go once, on the doubles as T-1513's
// db/repo writes and reads them. A second text to the same handle and business carries neither the opener nor the
// privacy link (the JOIN's writePlan wrote K-04's opener mark), and, once a delivery receipt for a words part carrying
// the STOP, HELP and rates line set the phone row's time (its version raised once), no such line either; a repeated
// receipt, a later line-carrying delivery, a poll part or its plain words retry, a row without the line and a handle
// with no phone row each write nothing.
//
// Each test runs the JOIN on a fresh rig, and the Durable Objects' storage is reset after each (as hop 12's tests run it).
// Test owner 1 holds no role, so the JOIN's S1-02 row is read by its sign-up line as the owner and its first text opens
// with signUpOpener (K-01 README default 19; T-1511); the turn pins bundle v2, which carries the line (T-1477), as hops 10
// to 12 do (T-1512): on bundle v0 finalize would refuse the text and nothing would be sent or delivered.
// Test values only (rule 9): the master's sample cast, the fictional 555-01xx numbers and the fixtures' own words.
import joinRunContext from "@rosie/ai/recordings/contexts/join-s1-01.json";
import commitS101Sam from "@rosie/contracts/data-access/fixtures/commit-s1-01-sam.json";
import textFixture from "@rosie/contracts/inbound-event/fixtures/text-imessage.json";
import planS102 from "@rosie/contracts/message-plan/fixtures/plan-s1-02.json";
import finalizePass from "@rosie/contracts/tool-api/fixtures/finalize-pass.json";
import type { CommitTurnRequest } from "@rosie/db/repo/commit-turn";
import { reset, runDurableObjectAlarm } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { QUIET_MS, turnIdOf, type HandleActor } from "../actor";
import { ARMING_TRIES } from "../clocks/arming";
import { dueOf } from "../clocks/due";
import { actorNameOf } from "../gateway";
import type { Hop, Span } from "../trace";
import { leaks, spansOfLogLines, spansOfTrace } from "../trace/hop-check";
import { flush } from "../turn/test-support";
import { composeRoot, SKELETON_FLAG, type HandleActors, type Root } from "./index";
import type { ArmingCalls, OutboxCalls } from "./real";
import {
  BUNDLE_V2,
  bundleV2FixedLine,
  fakeFlags,
  SAM_CHAT,
  samPhoneRow,
  skeletonFakes,
  TEST_OWNER_1,
  testClock,
  type LinqInboundEvent,
  type SignedWebhook,
  type SkeletonFakes,
} from "./test-support";

type Json = Record<string, unknown>;
type Namespace = DurableObjectNamespace<HandleActor>;

/** A run through the Workers runtime's own steps: a resource guard above Vitest's 5 s default. */
const TEST_MS = 30_000;
/** How long a step of the actor's lent work may take before a wait gives up. */
const WAIT_MS = 15_000;

/** Lee's Barbershop's zone, as test owner 1's seed holds it (K-04 seed-business-head.json businesses.time_zone). */
const BARBERSHOP_ZONE = "America/New_York";

/** The JOIN run's own context (K-02 README "v1.1", recording 2; T-1145 round 2, DL-347). */
const JOIN_CONTEXT = joinRunContext as unknown as {
  readonly texts: readonly {
    readonly eventId: string;
    readonly words: string;
    readonly sentAt: { utc: string };
  }[];
};
const [JOIN_TEXT_OF_RECORDING] = JOIN_CONTEXT.texts;

/** The fictional number the JOIN comes from, in each form a number could leak in. */
const CAST_NUMBERS = ["0100"].flatMap((line) => [`+1555555${line}`, `1555555${line}`, `555555${line}`]);

const OWNER_ACTOR = actorNameOf(TEST_OWNER_1.handle);

function namespace(): Namespace {
  return (exports as unknown as { HandleActor: Namespace }).HandleActor;
}

function handleActors(): HandleActors<DurableObjectId> {
  const ns = namespace();
  return { idFromName: (name) => ns.idFromName(name), get: (id) => ns.get(id) };
}

function stubOf(actorName: string): DurableObjectStub<HandleActor> {
  return namespace().get(namespace().idFromName(actorName));
}

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

/**
 * Linq's delivery receipt for one part the Linq double accepted: the double's own (T-411 fakeDelivered), carried as a
 * K-06 delivered event by T-412's eventFromDoubleEvent (./test-support.ts FakeLinqLine.deliveredReceipt).
 */
function deliveredReceiptOf(fakes: SkeletonFakes, partKey: string, eventId: string): LinqInboundEvent {
  return fakes.linq.deliveredReceipt(partKey, eventId);
}

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

/**
 * What the root's arming and outbox ports are fed: the doubles' own calls, or those calls wrapped by a test (T-1244), and
 * for the arming null where no calls are bound (the Worker until T-567).
 */
interface Feeds {
  readonly armingCalls: ArmingCalls | null;
  readonly outboxCalls: OutboxCalls;
}

/** The root for "test", every joined port fed its double, this hop's arming and the outbox as `feeds` gives them. */
function testRoot(fakes: SkeletonFakes, actors: HandleActors<DurableObjectId>, feeds: Feeds): Root {
  return composeRoot({
    environment: "test",
    sets: { fake: fakes.ports },
    actors,
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
    outboxCalls: feeds.outboxCalls,
    sendStateCall: fakes.dispatch.sendState,
    linqSendCall: fakes.linq.call,
    retryQueue: fakes.retryQueue,
    // This hop: the clock arming's K-05 calls and reads, over the rows the commit wrote and test owner 1's seeded rows.
    armingCalls: feeds.armingCalls,
    flags: fakeFlags([SKELETON_FLAG]),
  });
}

/** What the gateway answered a webhook: its status and the trace id it opened. */
interface Answered {
  readonly status: number;
  readonly traceId: string;
}

interface Rig {
  readonly fakes: SkeletonFakes;
  readonly root: Root;
  /** Posts a signed webhook through the root's Linq route; answers the trace id the gateway opened, once it answered 200. */
  post(event: LinqInboundEvent, partKey?: string | null): Promise<string>;
  /** Posts a signed webhook through the Linq route of `through` (the rig's root when left out), whatever it answers. */
  send(event: LinqInboundEvent, partKey: string | null, through?: Root): Promise<Answered>;
  /**
   * Another Worker isolate: a root composed anew over the same doubles and feeds, with its own memories (the parts it
   * armed, the rows' traces), as the one a crash or a new isolate gives Linq's retry (T-1244).
   */
  isolate(): Root;
  spans(): Span[];
  traceOf(traceId: string): Span[];
  restore(): void;
}

/**
 * A rig whose root is fed the doubles' own calls, or what `feedsOf` gives in their place; bundle v2 active, the JOIN's pin
 * (T-1512).
 */
function rig(log: MockInstance, feedsOf: (fakes: SkeletonFakes) => Partial<Feeds> = () => ({})): Rig {
  const fakes = skeletonFakes(testClock(), { bundle: BUNDLE_V2 });
  const feeds: Feeds = {
    armingCalls: fakes.arming.calls,
    outboxCalls: fakes.dispatch.outbox,
    ...feedsOf(fakes),
  };
  const root = testRoot(fakes, handleActors(), feeds);
  const restore = root.install();
  const spans = (): Span[] => spansOfLogLines(log.mock.calls.map((call: unknown[]) => call[0]));
  const send = async (
    event: LinqInboundEvent,
    partKey: string | null,
    through: Root = root,
  ): Promise<Answered> => {
    const response = await through.linqWebhook(webhookRequest(await fakes.sign(event, partKey)));
    const traceId = response.headers.get("x-trace-id");
    if (traceId === null) throw new Error("the gateway answered with no trace id");
    return { status: response.status, traceId };
  };
  return {
    fakes,
    root,
    async post(event, partKey = null) {
      const { status, traceId } = await send(event, partKey);
      if (status !== 200) throw new Error(`the gateway answered ${String(status)}`);
      return traceId;
    },
    send,
    isolate: () => testRoot(fakes, handleActors(), feeds),
    spans,
    traceOf: (traceId) => spansOfTrace(spans(), traceId),
    restore,
  };
}

/** K-05's transient answer (db/repo TransientError: a serialization failure), as armClock gives it. */
const TRANSIENT: Awaited<ReturnType<ArmingCalls["armClock"]>> = { error: "transient", sqlstate: "40001" };

/**
 * The arming's calls with armClock answering transient on its first `times` calls, then as the double answers, each
 * request kept in `asked` in order (the double's own `arms` keeps only the calls it answered).
 */
function armClockFailing(calls: ArmingCalls, times: number, asked: unknown[]): ArmingCalls {
  let left = times;
  return {
    ...calls,
    armClock(request) {
      asked.push(request);
      if (left === 0) return calls.armClock(request);
      left -= 1;
      return Promise.resolve(TRANSIENT);
    },
  };
}

/**
 * The outbox calls with markPartV12 answering each delivered mark as for a row that asks no question (K-05 markPart's
 * openQuestionId null), every other answer as the double gives it.
 */
function askingNoQuestion(calls: OutboxCalls): OutboxCalls {
  return {
    ...calls,
    async markPartV12(request) {
      const answer = await calls.markPartV12(request);
      return request.outcome === "delivered" && "result" in answer
        ? { ...answer, openQuestionId: null }
        : answer;
    },
  };
}

/** The gateway's failure lines (gateway/answer.ts logFailure), parsed, in order. */
function failureLines(log: MockInstance): Json[] {
  return log.mock.calls
    .map((call: unknown[]) => call[0])
    .filter((line): line is string => typeof line === "string" && line.includes('"gateway_failed"'))
    .map((line) => JSON.parse(line) as Json);
}

/** A turn run to its reply: its turn id, trace id, the row its commit wrote, the row's question and its clock row. */
interface RanTurn {
  readonly turnId: string;
  readonly traceId: string;
  readonly row: string;
  readonly question: string;
  readonly clock: string;
}

/** The JOIN's turn, run on `run` to its reply: its turn id, trace id, the row its commit wrote and the row's question. */
function runJoin(run: Rig): Promise<RanTurn> {
  return runText(run, joinAsRecorded());
}

/**
 * A later text from test owner 1 on Sam's chat, in the JOIN's form under an event id of its own, its turn recorded to go
 * the JOIN run's way (./test-support.ts recordTurn: S1-01's commit and S1-02's row under the turn's own id, the row's plan
 * plan-s1-02.json's), run on `run` to its reply.
 */
function runLaterText(run: Rig, eventId: string): Promise<RanTurn> {
  const text = {
    ...joinAsRecorded(),
    eventId,
    messageId: `linq-msg-demo-in-${eventId}`,
  } as unknown as LinqInboundEvent;
  run.fakes.decide.recordTurn([eventId]);
  return runText(run, text);
}

/** One text's turn, run on `run` to its reply. */
async function runText(run: Rig, text: LinqInboundEvent): Promise<RanTurn> {
  run.fakes.known(text.eventId);
  const traceId = await run.post(text);
  await settle(OWNER_ACTOR);
  await run.fakes.clock.advance(QUIET_MS);
  await runDurableObjectAlarm(stubOf(OWNER_ACTOR));
  const turnId = await turnIdOf([text.eventId]);
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
  const question = `oq-s1-02-${turnId}-1`;
  return { turnId, traceId, row: `outbox-s1-02-${turnId}-1`, question, clock: `clock-${question}` };
}

/** The spans of a hop in a trace. */
function spansOf(spans: readonly Span[], hop: Hop): Span[] {
  return spans.filter((span) => span.hop === hop);
}

/** The one span of a hop in a trace. */
function onlySpan(spans: readonly Span[], hop: Hop): Span {
  const found = spansOf(spans, hop);
  expect(found.map((span) => span.hop)).toEqual([hop]);
  const [span] = found;
  if (span === undefined) throw new Error(`no ${hop} span`);
  return span;
}

/** The local calendar date of an instant in a zone, as YYYY-MM-DD. */
function localDateOf(utc: string, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(utc));
}

/** The local wall clock of an instant in a zone, as HH:MM:SS (24 hours). */
function localTimeOf(utc: string, zone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(utc));
}

/** The calendar date after a YYYY-MM-DD date. */
function dayAfter(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("hop 13 joined: the double's delivery receipt reaches the gateway, the part is marked delivered and S1-02's clock row arms", () => {
  it(
    "the receipt marks the JOIN's part delivered (K-05 markPart, the row's first delivery) and arms S1-02's clock row (K-05 armClock) at T-255's due time, 8pm the day after delivery in Lee's Barbershop's zone, under the JOIN's trace id",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = rig(log);
      try {
        const { turnId, traceId, row, question, clock } = await runJoin(run);
        const key = `${row}/1/1`;
        const { arming, dispatch, linq } = run.fakes;
        const accepted = linq.accepted.get(key);
        if (accepted?.providerMessageId == null) throw new Error("the double accepted no part");
        // Before the receipt: the commit's clock row is waiting, its question waiting, and nothing was asked of K-05.
        expect(arming.clockRow(clock)).toMatchObject({ state: "waiting", version: 1, dueAt: null });
        expect(arming.questionStatus(question)).toBe("waiting");
        expect(arming.arms).toEqual([]);

        // The double's delivery receipt for the part reaches the gateway, echoing the part's key.
        const receipt = deliveredReceiptOf(run.fakes, key, "evt-linq-delivered-sam-0001");
        expect(receipt.status).toMatchObject({ messageId: accepted.providerMessageId });
        const deliveredAt = String(receipt.status?.at);
        const receiptTraceId = await run.post(receipt, key);

        // K-05 markPart: the part delivered, found by its message id, the row's first delivery, naming S1-02's question.
        expect(
          dispatch.partMarks
            .filter((call) => call.request.outcome === "delivered")
            .map((call) => [call.request, call.answer]),
        ).toMatchObject([
          [
            { outcome: "delivered", providerMessageId: accepted.providerMessageId, at: deliveredAt },
            {
              result: "marked",
              outboxRowId: row,
              partNo: 1,
              tryNo: 1,
              repeated: false,
              firstDelivery: true,
              openQuestionId: question,
              row: { state: "delivered" },
            },
          ],
        ]);
        expect(dispatch.row(row)).toMatchObject({ state: "delivered", parts: [{ key, state: "delivered" }] });

        // The question's facts read once: no Clock line, Lee's Barbershop's zone, no visit, no never-delivered row.
        expect(arming.factReads).toEqual([question]);
        // K-05 armClock, once, named by the question: armed at the receipt's second, due at step 9's time.
        const due = dueOf({ deliveredAt, clockLine: null, visitStartsAt: null, zone: BARBERSHOP_ZONE });
        expect(due.branch).toBe("noVisit");
        expect(arming.arms.map((call) => call.request)).toEqual([
          { openQuestionId: question, deliveredAt, dueAt: due.dueAt, dueZone: BARBERSHOP_ZONE },
        ]);
        // T-255's rule, read again on the wall clock: 8pm, the day after the delivery's local date, in the shop's zone.
        expect(localTimeOf(due.dueAt, BARBERSHOP_ZONE)).toBe("20:00:00");
        expect(localDateOf(due.dueAt, BARBERSHOP_ZONE)).toBe(
          dayAfter(localDateOf(deliveredAt, BARBERSHOP_ZONE)),
        );
        expect(arming.arms.map((call) => call.answer)).toEqual([
          {
            result: "armed",
            repeated: false,
            clock: {
              clockRowId: clock,
              version: 2,
              armedAt: deliveredAt,
              dueAt: due.dueAt,
              dueZone: BARBERSHOP_ZONE,
              handleId: TEST_OWNER_1.handleId,
            },
          },
        ]);
        // The clock row the commit made, armed; its question open (K-05 default 8); no never-delivered row to cancel.
        expect(arming.clockRow(clock)).toEqual({
          state: "armed",
          version: 2,
          armedAt: deliveredAt,
          dueAt: due.dueAt,
          dueZone: BARBERSHOP_ZONE,
          cancelledAt: null,
        });
        expect(arming.questionStatus(question)).toBe("open");
        expect(arming.cancels).toEqual([]);
        // Sam's actor was named for its alarm (T-254).
        expect(arming.actorReads).toEqual([TEST_OWNER_1.handleId]);

        // Under the JOIN's trace id and bundle v2: one delivered span, then one clockArmed span, after the part's
        // providerAccepted span; labels and counts only.
        const trace = run.traceOf(traceId);
        const accept = onlySpan(trace, "providerAccepted");
        const delivered = onlySpan(trace, "delivered");
        const armed = onlySpan(trace, "clockArmed");
        expect(delivered).toMatchObject({
          trace_id: traceId,
          bundle_id: BUNDLE_V2,
          outcome: "ok",
          provider: "linq",
          error_code: null,
          got: { firstDelivery: true, repeated: false },
          rows: [{ table: "outbox_rows", id: row }],
        });
        expect(armed).toMatchObject({
          trace_id: traceId,
          bundle_id: BUNDLE_V2,
          outcome: "ok",
          error_code: null,
          got: { firstDelivery: true, partNo: 1, tryNo: 1 },
          decided: {
            result: "armed",
            branch: "noVisit",
            zoneFrom: "business",
            clockLineUnread: false,
            neverDelivered: "none",
            synced: true,
          },
          rows: [{ table: "clock_rows", id: clock }],
        });
        expect(Date.parse(delivered.at)).toBeGreaterThanOrEqual(Date.parse(accept.at));
        expect(Date.parse(armed.at)).toBeGreaterThanOrEqual(Date.parse(delivered.at));
        expect(new Set([delivered.turn_id, armed.turn_id])).toEqual(new Set([turnId]));
        // The receipt's own webhook opened its own trace: its receive alone, written.
        expect(receiptTraceId).not.toBe(traceId);
        expect(run.traceOf(receiptTraceId).map((span) => [span.hop, span.outcome])).toEqual([
          ["receive", "ok"],
        ]);
        // No span holds the number, Sam's chat id, the due time or the zone.
        expect(leaks(run.spans(), [...CAST_NUMBERS, SAM_CHAT, due.dueAt, BARBERSHOP_ZONE])).toEqual([]);
      } finally {
        run.restore();
      }
    },
  );

  it(
    "a second delivered event for the same part arms nothing more: Linq's retry of the webhook and another event for the part are each answered repeated by K-05, saying they repeat the row's first delivery (K-05 v1.9 item 48), and the arming they are handed back to asks K-05 nothing more",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = rig(log);
      try {
        const { traceId, row, clock } = await runJoin(run);
        const key = `${row}/1/1`;
        const { arming, dispatch } = run.fakes;
        const receipt = deliveredReceiptOf(run.fakes, key, "evt-linq-delivered-sam-0001");
        const deliveredAt = String(receipt.status?.at);
        await run.post(receipt, key);
        expect(arming.arms).toHaveLength(1);
        const first = arming.clockRow(clock);
        expect(first).toMatchObject({ state: "armed", version: 2 });

        // Linq sends the same webhook again (the same event id), and then another event for the part.
        const again = await run.post(receipt, key);
        const another = await run.post(
          deliveredReceiptOf(run.fakes, key, "evt-linq-delivered-sam-0002"),
          key,
        );

        // K-05 answered each repeated, changing nothing, and said what each repeats: the row's first delivery, at the time
        // it stored for it, never the repeat's own (K-05 v1.9 item 48, defaults 85 and 86).
        const repeats = { firstOfRow: true, deliveredAt };
        expect(
          dispatch.partMarks
            .filter((call) => call.request.outcome === "delivered")
            .map((call) => call.answer),
        ).toMatchObject([
          { result: "marked", repeated: false, firstDelivery: true, repeatedDelivery: null },
          { result: "marked", repeated: true, firstDelivery: false, repeatedDelivery: repeats },
          { result: "marked", repeated: true, firstDelivery: false, repeatedDelivery: repeats },
        ]);
        // Each repeat was handed back to the arming (T-1228), whose memory of the armed part asked K-05 nothing more.
        expect(arming.arms).toHaveLength(1);
        expect(arming.factReads).toHaveLength(1);
        expect(arming.cancels).toEqual([]);
        expect(arming.clockRow(clock)).toEqual(first);
        // The gateway answered each repeat as a known event, on its own trace.
        for (const repeat of [again, another]) {
          expect(run.traceOf(repeat)).toMatchObject([
            { hop: "receive", outcome: "dropped", decided: { knownEventId: true, answered: 200 } },
          ]);
        }
        // On the JOIN's trace: the one arming, then one repeated arming for each repeat, with no clock row of its own;
        // each receipt's delivered span, the repeats saying so and that they repeat the row's first delivery.
        const trace = run.traceOf(traceId);
        expect(spansOf(trace, "clockArmed")).toMatchObject([
          { outcome: "ok", decided: { result: "armed" } },
          { outcome: "ok", decided: { result: "repeated" } },
          { outcome: "ok", decided: { result: "repeated" } },
        ]);
        expect(spansOf(trace, "clockArmed").map((span) => span.rows ?? [])).toEqual([
          [{ table: "clock_rows", id: clock }],
          [],
          [],
        ]);
        expect(spansOf(trace, "delivered").map((span) => span.got)).toEqual([
          { firstDelivery: true, repeated: false },
          { firstDelivery: false, repeated: true, firstOfRow: true },
          { firstDelivery: false, repeated: true, firstOfRow: true },
        ]);
      } finally {
        run.restore();
      }
    },
  );

  it(
    "with no arming calls bound (the Worker until T-567) the part is still marked delivered and the arming fails closed: nothing is armed, its span says it failed, and the receipt is answered 503 (T-1244)",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = rig(log, () => ({ armingCalls: null }));
      try {
        const { traceId, row, clock, question } = await runJoin(run);
        const key = `${row}/1/1`;
        const answered = await run.send(
          deliveredReceiptOf(run.fakes, key, "evt-linq-delivered-sam-0001"),
          key,
        );

        // Not done: 503, so Linq sends the receipt again (T-1244).
        expect(answered.status).toBe(503);
        expect(run.fakes.dispatch.row(row)).toMatchObject({ state: "delivered" });
        // Nothing reached the doubles: the clock row and its question stay as the commit wrote them.
        expect(run.fakes.arming.arms).toEqual([]);
        expect(run.fakes.arming.factReads).toEqual([]);
        expect(run.fakes.arming.clockRow(clock)).toMatchObject({ state: "waiting", version: 1 });
        expect(run.fakes.arming.questionStatus(question)).toBe("waiting");
        // Each read was refused before anything was read (NoDatabaseError), tried as no answer (T-255's ARMING_TRIES).
        expect(onlySpan(run.traceOf(traceId), "clockArmed")).toMatchObject({
          outcome: "failed",
          error_code: "noAnswer",
          decided: { result: "failed", synced: false },
        });
      } finally {
        run.restore();
      }
    },
  );
});

describe("T-1244: a receipt whose clock arming fails is answered 503, so Linq sends it again and its repeat arms the clock", () => {
  it(
    "a first delivery whose arming fails to the end (armClock transient on each of its tries) is answered 503 with the part still marked delivered; the same receipt again is handed back to the arming, which arms the clock once, and is answered 200",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const asked: unknown[] = [];
      const run = rig(log, (fakes) => ({
        armingCalls: armClockFailing(fakes.arming.calls, ARMING_TRIES, asked),
      }));
      try {
        const { traceId, row, question, clock } = await runJoin(run);
        const key = `${row}/1/1`;
        const { arming, dispatch } = run.fakes;
        const receipt = deliveredReceiptOf(run.fakes, key, "evt-linq-delivered-sam-0001");
        const deliveredAt = String(receipt.status?.at);
        const due = dueOf({ deliveredAt, clockLine: null, visitStartsAt: null, zone: BARBERSHOP_ZONE });
        const request = { openQuestionId: question, deliveredAt, dueAt: due.dueAt, dueZone: BARBERSHOP_ZONE };
        const deliveredMarks = (): unknown[] =>
          dispatch.partMarks
            .filter((call) => call.request.outcome === "delivered")
            .map((call) => call.answer);

        // The first receipt: the mark records the row's first delivery, then armClock answers transient on every try.
        const first = await run.send(receipt, key);

        expect(first.status).toBe(503);
        // The part stays marked delivered.
        expect(dispatch.row(row)).toMatchObject({ state: "delivered", parts: [{ key, state: "delivered" }] });
        expect(deliveredMarks()).toMatchObject([
          { result: "marked", repeated: false, firstDelivery: true, repeatedDelivery: null },
        ]);
        // Nothing armed: armClock was asked on each of the arming's tries, the same request each time, and answered
        // transient each time; the clock row and its question stay as the commit wrote them, and no actor was told.
        expect(arming.factReads).toEqual([question]);
        expect(asked).toEqual(Array.from({ length: ARMING_TRIES }, () => request));
        expect(arming.arms).toEqual([]);
        expect(arming.clockRow(clock)).toMatchObject({ state: "waiting", version: 1, dueAt: null });
        expect(arming.questionStatus(question)).toBe("waiting");
        expect(arming.actorReads).toEqual([]);
        // The JOIN's trace: the arming's span says it failed, transient.
        expect(onlySpan(run.traceOf(traceId), "clockArmed")).toMatchObject({
          outcome: "failed",
          error_code: "transient",
          decided: { result: "failed", synced: false },
        });
        // The receipt's own trace: its receive, answered 503. The gateway's one failure line names the error alone.
        expect(run.traceOf(first.traceId)).toMatchObject([
          {
            hop: "receive",
            outcome: "failed",
            error_code: "handoffFailed",
            decided: { signatureValid: true, answered: 503 },
          },
        ]);
        expect(failureLines(log)).toEqual([
          {
            level: "error",
            msg: "gateway_failed",
            trace_id: first.traceId,
            stage: "handoff",
            error: "ArmingNotDone",
            // T-1465: the hand-off's line names the event's kind and the door's refusal label; an arming not done is no
            // refusal of the door's own and carries none, so its name still says why.
            kind: "delivered",
            refusal: "unlabeled",
          },
        ]);

        // Linq sends the same receipt again (the same event id).
        const again = await run.send(receipt, key);

        expect(again.status).toBe(200);
        // K-05 answered it repeated, saying it repeats the row's first delivery, at the stored time (K-05 v1.9 item 48).
        expect(deliveredMarks()).toMatchObject([
          { result: "marked", repeated: false, firstDelivery: true, repeatedDelivery: null },
          {
            result: "marked",
            repeated: true,
            firstDelivery: false,
            repeatedDelivery: { firstOfRow: true, deliveredAt },
          },
        ]);
        // Handed back to the arming: the question's facts read again and armClock asked once more, with the same request,
        // which armed the clock once, as the first receipt's arming would have.
        expect(arming.factReads).toEqual([question, question]);
        expect(asked).toEqual(Array.from({ length: ARMING_TRIES + 1 }, () => request));
        expect(arming.arms.map((call) => call.request)).toEqual([request]);
        expect(arming.arms.map((call) => call.answer)).toEqual([
          {
            result: "armed",
            repeated: false,
            clock: {
              clockRowId: clock,
              version: 2,
              armedAt: deliveredAt,
              dueAt: due.dueAt,
              dueZone: BARBERSHOP_ZONE,
              handleId: TEST_OWNER_1.handleId,
            },
          },
        ]);
        expect(arming.clockRow(clock)).toEqual({
          state: "armed",
          version: 2,
          armedAt: deliveredAt,
          dueAt: due.dueAt,
          dueZone: BARBERSHOP_ZONE,
          cancelledAt: null,
        });
        expect(arming.questionStatus(question)).toBe("open");
        expect(arming.cancels).toEqual([]);
        expect(arming.actorReads).toEqual([TEST_OWNER_1.handleId]);
        // The JOIN's trace: the failed arming, then the repeat's; the repeat's delivered span says what it repeats.
        const trace = run.traceOf(traceId);
        expect(spansOf(trace, "clockArmed")).toMatchObject([
          { outcome: "failed", decided: { result: "failed" } },
          { outcome: "ok", decided: { result: "armed" }, rows: [{ table: "clock_rows", id: clock }] },
        ]);
        expect(spansOf(trace, "delivered").map((span) => span.got)).toEqual([
          { firstDelivery: true, repeated: false },
          { firstDelivery: false, repeated: true, firstOfRow: true },
        ]);
        // The retry's own trace: a known event, answered 200; no second failure line.
        expect(run.traceOf(again.traceId)).toMatchObject([
          { hop: "receive", outcome: "dropped", decided: { knownEventId: true, answered: 200 } },
        ]);
        expect(failureLines(log)).toHaveLength(1);
        // No span holds the number, Sam's chat id, the due time or the zone.
        expect(leaks(run.spans(), [...CAST_NUMBERS, SAM_CHAT, due.dueAt, BARBERSHOP_ZONE])).toEqual([]);
      } finally {
        run.restore();
      }
    },
  );

  it(
    "a repeat after a completed arming is answered 200 with no second clock row: the isolate that armed it asks K-05 nothing, and in another isolate K-05 armClock answers it repeated with the first arming",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = rig(log);
      try {
        const { row, question, clock } = await runJoin(run);
        const key = `${row}/1/1`;
        const { arming } = run.fakes;
        const receipt = deliveredReceiptOf(run.fakes, key, "evt-linq-delivered-sam-0001");
        const deliveredAt = String(receipt.status?.at);
        const due = dueOf({ deliveredAt, clockLine: null, visitStartsAt: null, zone: BARBERSHOP_ZONE });
        const request = { openQuestionId: question, deliveredAt, dueAt: due.dueAt, dueZone: BARBERSHOP_ZONE };
        const armedClock = {
          clockRowId: clock,
          version: 2,
          armedAt: deliveredAt,
          dueAt: due.dueAt,
          dueZone: BARBERSHOP_ZONE,
          handleId: TEST_OWNER_1.handleId,
        };
        expect((await run.send(receipt, key)).status).toBe(200);
        const armed = arming.clockRow(clock);
        expect(armed).toMatchObject({ state: "armed", version: 2 });

        // The isolate that armed it: the repeat goes back to the arming, whose memory of the part makes no K-05 call.
        expect((await run.send(receipt, key)).status).toBe(200);
        expect(arming.factReads).toEqual([question]);
        expect(arming.arms).toHaveLength(1);

        // Another isolate, with no memory of the part: armClock is asked for the stored delivery, and K-05 answers it
        // repeated with the first arming (K-05 v1 item 5).
        const other = await run.send(receipt, key, run.isolate());

        expect(other.status).toBe(200);
        expect(arming.factReads).toEqual([question, question]);
        expect(arming.arms.map((call) => call.request)).toEqual([request, request]);
        expect(arming.arms.map((call) => call.answer)).toEqual([
          { result: "armed", repeated: false, clock: armedClock },
          { result: "armed", repeated: true, clock: armedClock },
        ]);
        // One clock row, as its one arming left it: no second row or write, no cancel, the actor told once.
        expect(arming.clockRow(clock)).toEqual(armed);
        expect(arming.questionStatus(question)).toBe("open");
        expect(arming.cancels).toEqual([]);
        expect(arming.actorReads).toEqual([TEST_OWNER_1.handleId]);
        // The other isolate knows no row's trace: its arming's span is on the receipt's own trace, saying repeated.
        expect(spansOf(run.traceOf(other.traceId), "clockArmed")).toMatchObject([
          { outcome: "ok", decided: { result: "repeated" } },
        ]);
        expect(failureLines(log)).toEqual([]);
      } finally {
        run.restore();
      }
    },
  );

  it(
    "a receipt for a row that asks no question is answered 200, with nothing read or armed",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = rig(log, (fakes) => ({ outboxCalls: askingNoQuestion(fakes.dispatch.outbox) }));
      try {
        const { traceId, row, question, clock } = await runJoin(run);
        const key = `${row}/1/1`;
        const { arming, dispatch } = run.fakes;
        const answered = await run.send(
          deliveredReceiptOf(run.fakes, key, "evt-linq-delivered-sam-0001"),
          key,
        );

        expect(answered.status).toBe(200);
        expect(dispatch.row(row)).toMatchObject({ state: "delivered" });
        // No question to arm: no facts read, no armClock call, and the clock row as the commit wrote it.
        expect(arming.factReads).toEqual([]);
        expect(arming.arms).toEqual([]);
        expect(arming.clockRow(clock)).toMatchObject({ state: "waiting", version: 1 });
        expect(arming.questionStatus(question)).toBe("waiting");
        expect(onlySpan(run.traceOf(traceId), "clockArmed")).toMatchObject({
          outcome: "dropped",
          decided: { result: "noQuestion" },
        });
        expect(failureLines(log)).toEqual([]);
      } finally {
        run.restore();
      }
    },
  );
});

// ---- T-1514: Rosie's first-text lines go once (K-05 v1.21 defaults 200 to 204; DL-1033 fault 2) -------------------------

/** K-03's plan-s1-02.json: the plan the composer double answers for each S1-02 row (recording 4's, and a recorded turn's). */
const PLAN_S1_02 = planS102 as unknown as {
  readonly lines: readonly { readonly text: string }[];
  readonly question: { readonly text: string };
};
/** The words plan-s1-02.json plans, a line each. */
const PLANNED_WORDS = [...PLAN_S1_02.lines.map((line) => line.text), PLAN_S1_02.question.text].join("\n");
/** Bundle v2's first-text lines, word for word: S1-02's own opener, the STOP, HELP and rates line, the privacy link. */
const OPENER = bundleV2FixedLine("signUpOpener");
const OPT_OUT_LINE = bundleV2FixedLine("optOutLine");
const PRIVACY_LINK = bundleV2FixedLine("privacyLink");
/** Rosie's first text to test owner 1: the opener before the plan's words, then Q-30's lines, the link alone last. */
const FIRST_TEXT = [`${OPENER} ${PLANNED_WORDS}`, OPT_OUT_LINE, PRIVACY_LINK].join("\n");
/** A later text that still owes the STOP, HELP and rates line: the plan's words, then that line alone. */
const LATER_TEXT_WITH_LINE = [PLANNED_WORDS, OPT_OUT_LINE].join("\n");

/** A row's final parts of one words send of `text`, carrying `fixedLines`, as finalize writes them into the row. */
function onePartOf(row: string, text: string, fixedLines: readonly string[]): Json {
  return {
    row,
    channel: "imessage",
    sends: [{ kind: "words", text, calendarFile: "none", options: [], link: null }],
    fixedLines,
    slotValues: [],
    threadReplyTo: null,
  };
}

/** One markPartV12 request, as the outbox port hands it to K-05. */
type MarkRequest = Parameters<OutboxCalls["markPartV12"]>[0];

/** A second of one test minute, in UTC, as K-05 writes a time. */
const secondOf = (second: number): string => `2026-10-19T14:02:${String(second).padStart(2, "0")}Z`;

/**
 * K-05 commit-s1-01-sam.json's request committed on the K-05 double under ids of this test's own: one S1-02 row to test
 * owner 1 at Lee's Barbershop. Answers the row's id.
 */
async function commitOwnRow(fakes: SkeletonFakes, name: string): Promise<string> {
  const request = structuredClone(commitS101Sam.request) as unknown as CommitTurnRequest;
  const [first] = request.writes.outboxRows;
  if (first === undefined) throw new Error("commit-s1-01-sam.json writes an outbox row");
  const row = `outbox-t1514-${name}`;
  const committed = await fakes.turnRows.calls.commitTurn({
    ...request,
    turn: { ...request.turn, id: `turn-t1514-${name}`, eventIds: [`evt-t1514-${name}`] },
    writes: { ...request.writes, outboxRows: [{ ...first, id: row }] },
  });
  if (!("result" in committed) || committed.repeated) throw new Error("the commit was not taken");
  return row;
}

/** K-05 writePlan on the finalize double for `row` at its first version: finalize-pass.json's plan, and `finalParts`. */
function planOwnRow(fakes: SkeletonFakes, row: string, finalParts: Json): Promise<unknown> {
  return fakes.finalize.data.writePlan({
    outboxRowId: row,
    expectVersion: 1,
    plan: { ...finalizePass.request.plan, row },
    finalParts,
  } as never);
}

describe("T-1514: Rosie's first-text lines go once, the doubles writing and reading the opener mark and the opt-out line's delivery time as db/repo does (K-05 v1.21 defaults 200 to 204)", () => {
  it(
    "a second text to the same handle and business, before any delivery receipt, carries neither the opener nor the privacy link (the JOIN's writePlan wrote the mark) and the STOP, HELP and rates line again, never yet delivered; the line's first delivery, the second row's, sets the phone's time and raises its version once, and the first row's later delivery writes nothing",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = rig(log);
      try {
        const { finalize, dispatch, linq, turnRows, clock } = run.fakes;
        const handle = TEST_OWNER_1.handleId;
        const business = TEST_OWNER_1.businessId;

        // Rosie's first text: all three lines, and K-04's opener mark, written with the plan, naming the JOIN's row at
        // its turn's commit time.
        const first = await runJoin(run);
        expect(finalize.plans.get(first.row)?.finalParts).toEqual(
          onePartOf(first.row, FIRST_TEXT, ["signUpOpener", "optOutLine", "privacyLink"]),
        );
        const committedAt = turnRows.turns.get(first.turnId)?.at;
        expect(committedAt).toEqual(expect.any(String));
        const mark = { handleId: handle, businessId: business, sentAt: committedAt, outboxRowId: first.row };
        expect(finalize.openersSent).toEqual([mark]);
        // The phone row the JOIN's text opened at receipt: the line never delivered.
        const opened = dispatch.phones.get(handle);
        expect(opened).toMatchObject({ stopped: false, optoutLineDeliveredAt: null, version: 1 });

        // A second text, its turn going the JOIN's way: another S1-02 row to the same handle at the same business.
        const second = await runLaterText(run, "evt-sam-0001");
        expect(second.row).not.toBe(first.row);
        expect(finalize.factReads).toEqual([
          { outboxRowId: first.row, businessId: business },
          { outboxRowId: second.row, businessId: business },
        ]);
        expect(finalize.plans.get(second.row)?.finalParts).toEqual(
          onePartOf(second.row, LATER_TEXT_WITH_LINE, ["optOutLine"]),
        );
        // Linq was sent exactly those words, and the mark is written once: the later row did not move it.
        expect(linq.requests.map((request) => request.text)).toEqual([FIRST_TEXT, LATER_TEXT_WITH_LINE]);
        expect(linq.requests[1]?.text).not.toContain(OPENER);
        expect(linq.requests[1]?.text).not.toContain(PRIVACY_LINK);
        expect(finalize.openersSent).toEqual([mark]);
        // Nothing delivered yet: the phone row as the text's chat open left it.
        expect(dispatch.phones.get(handle)).toEqual(opened);

        // The second row's part is delivered first: a words part of a row carrying the line, so the phone's time is that
        // receipt's and its version rises by exactly one.
        const secondKey = `${second.row}/1/1`;
        const secondReceipt = deliveredReceiptOf(run.fakes, secondKey, "evt-linq-delivered-sam-0002");
        const secondAt = String(secondReceipt.status?.at);
        await run.post(secondReceipt, secondKey);
        const marked = { ...opened, optoutLineDeliveredAt: secondAt, version: 2 };
        expect(dispatch.phones.get(handle)).toEqual(marked);

        // Later, the first row's part is delivered too: it carries the line as well, and writes nothing (the time is
        // set only where it is null), though the part and its row are marked delivered.
        await clock.advance(2000);
        const firstKey = `${first.row}/1/1`;
        const firstReceipt = deliveredReceiptOf(run.fakes, firstKey, "evt-linq-delivered-sam-0001");
        expect(String(firstReceipt.status?.at)).not.toBe(secondAt);
        await run.post(firstReceipt, firstKey);
        expect(dispatch.row(first.row)).toMatchObject({ state: "delivered" });
        expect(dispatch.row(second.row)).toMatchObject({ state: "delivered" });
        expect(dispatch.phones.get(handle)).toEqual(marked);
      } finally {
        run.restore();
      }
    },
  );

  it(
    "a second text to the same phone after the first text's line was delivered carries no STOP, HELP and rates line, no opener and no privacy link: the receipt set the phone's time and raised its version once, a repeated receipt and another event for the part wrote nothing more, and the second row, which carries no line, changes no phone when it is delivered",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = rig(log);
      try {
        const { finalize, dispatch, linq } = run.fakes;
        const handle = TEST_OWNER_1.handleId;
        const first = await runJoin(run);
        const opened = dispatch.phones.get(handle);
        expect(opened).toMatchObject({ stopped: false, optoutLineDeliveredAt: null, version: 1 });

        // The first text's delivery receipt: its words part carries the line.
        const key = `${first.row}/1/1`;
        const receipt = deliveredReceiptOf(run.fakes, key, "evt-linq-delivered-sam-0001");
        const deliveredAt = String(receipt.status?.at);
        await run.post(receipt, key);
        const marked = { ...opened, optoutLineDeliveredAt: deliveredAt, version: 2 };
        expect(dispatch.phones.get(handle)).toEqual(marked);
        // Linq's retry of the webhook, and another event for the part: each a repeat, which writes nothing.
        await run.post(receipt, key);
        await run.post(deliveredReceiptOf(run.fakes, key, "evt-linq-delivered-sam-0002"), key);
        expect(
          dispatch.partMarks
            .filter((call) => call.request.outcome === "delivered")
            .map((call) => "result" in call.answer && call.answer.repeated),
        ).toEqual([false, true, true]);
        expect(dispatch.phones.get(handle)).toEqual(marked);

        // The second text: nothing is owed any more, so its words are the plan's own and no fixed line is recorded.
        const second = await runLaterText(run, "evt-sam-0001");
        expect(finalize.plans.get(second.row)?.finalParts).toEqual(onePartOf(second.row, PLANNED_WORDS, []));
        expect(linq.requests.map((request) => request.text)).toEqual([FIRST_TEXT, PLANNED_WORDS]);
        for (const line of [OPENER, OPT_OUT_LINE, PRIVACY_LINK]) {
          expect(linq.requests[1]?.text).not.toContain(line);
        }
        expect(finalize.openersSent.map((sent) => sent.outboxRowId)).toEqual([first.row]);

        // Its own delivery: a row without the line changes no phone.
        const secondKey = `${second.row}/1/1`;
        await run.post(deliveredReceiptOf(run.fakes, secondKey, "evt-linq-delivered-sam-0003"), secondKey);
        expect(dispatch.row(second.row)).toMatchObject({ state: "delivered" });
        expect(dispatch.phones.get(handle)).toEqual(marked);
      } finally {
        run.restore();
      }
    },
  );

  it("the markPartV12 double by direct call, as db/repo's markPartIn (default 203; db/repo default 29): a delivered poll part and its plain words retry, which carry the poll's words and not the line, write nothing; the words send's delivery sets the phone's time at that receipt and raises its version by one; its repeat writes nothing", async () => {
    const fakes = skeletonFakes(testClock(), { bundle: BUNDLE_V2 });
    const { dispatch } = fakes;
    const handle = TEST_OWNER_1.handleId;
    const row = await commitOwnRow(fakes, "poll");
    const poll = {
      kind: "poll",
      text: PLAN_S1_02.question.text,
      calendarFile: "none",
      options: [
        { id: "c-01", label: "All on the list" },
        { id: "c-02", label: "One isn't on the list yet" },
      ],
      link: null,
    };
    const words = onePartOf(row, LATER_TEXT_WITH_LINE, ["optOutLine"]);
    expect(await planOwnRow(fakes, row, { ...words, sends: [...(words.sends as Json[]), poll] })).toEqual({
      result: "written",
      outboxRowId: row,
      version: 2,
    });
    // Sam's phone row with the line not yet delivered.
    const phone = { ...samPhoneRow(), optoutLineDeliveredAt: null };
    dispatch.phones.set(handle, phone);
    const mark = (request: MarkRequest): ReturnType<OutboxCalls["markPartV12"]> =>
      dispatch.outbox.markPartV12(request);
    const sent = (key: string, messageId: string, at: string): MarkRequest => ({
      outcome: "sent",
      idempotencyKey: key,
      providerMessageId: messageId,
      providerOptionIds: null,
      at,
    });
    const claim = (now: string): ReturnType<OutboxCalls["claimOutboxV12"]> =>
      dispatch.outbox.claimOutboxV12({
        claimer: "t1514-dispatcher",
        recipientHandleId: handle,
        now,
        limit: 8,
      });

    // Claimed and both sends accepted; then the poll fails and goes again plain, as words (default 8): try 2 of part 2,
    // sent under the row's next claim.
    expect(await claim(secondOf(0))).toMatchObject({ result: "claimed", claimed: [{ outboxRowId: row }] });
    await mark(sent(`${row}/1/1`, "linq-msg-t1514-words", secondOf(1)));
    await mark(sent(`${row}/2/1`, "linq-msg-t1514-poll", secondOf(2)));
    expect(
      await mark({
        outcome: "failed",
        idempotencyKey: `${row}/2/1`,
        errorCode: "4006",
        retry: true,
        at: secondOf(3),
      }),
    ).toMatchObject({ result: "marked", repeated: false, nextKey: `${row}/2/2` });
    expect(await claim(secondOf(4))).toMatchObject({ result: "claimed", claimed: [{ outboxRowId: row }] });
    await mark(sent(`${row}/2/2`, "linq-msg-t1514-poll-plain", secondOf(5)));

    // The poll's plain words retry is delivered: a try of kind words, but of the poll send, so nothing is written.
    expect(
      await mark({ outcome: "delivered", providerMessageId: "linq-msg-t1514-poll-plain", at: secondOf(6) }),
    ).toMatchObject({ result: "marked", repeated: false, partNo: 2, tryNo: 2 });
    expect(dispatch.phones.get(handle)).toEqual(phone);
    // The poll's own try is delivered after all: a poll part writes nothing.
    expect(
      await mark({ outcome: "delivered", providerMessageId: "linq-msg-t1514-poll", at: secondOf(7) }),
    ).toMatchObject({ result: "marked", repeated: false, partNo: 2, tryNo: 1 });
    expect(dispatch.phones.get(handle)).toEqual(phone);

    // The words send, which carries the line, is delivered: the phone's time is this receipt's, its version one more.
    expect(
      await mark({ outcome: "delivered", providerMessageId: "linq-msg-t1514-words", at: secondOf(8) }),
    ).toMatchObject({ result: "marked", repeated: false, partNo: 1, tryNo: 1, row: { state: "delivered" } });
    const marked = { ...phone, optoutLineDeliveredAt: secondOf(8), version: phone.version + 1 };
    expect(dispatch.phones.get(handle)).toEqual(marked);
    // The same receipt again: a repeat, which writes nothing.
    expect(
      await mark({ outcome: "delivered", providerMessageId: "linq-msg-t1514-words", at: secondOf(9) }),
    ).toMatchObject({ result: "marked", repeated: true });
    expect(dispatch.phones.get(handle)).toEqual(marked);
  });

  it("the markPartV12 double by direct call: a handle with no phone row gets none, and a stopped phone's line time is set with nothing of its STOP touched", async () => {
    const fakes = skeletonFakes(testClock(), { bundle: BUNDLE_V2 });
    const { dispatch } = fakes;
    const handle = TEST_OWNER_1.handleId;
    const deliver = async (name: string, second: number): Promise<string> => {
      const row = await commitOwnRow(fakes, name);
      await planOwnRow(fakes, row, onePartOf(row, LATER_TEXT_WITH_LINE, ["optOutLine"]));
      const claimed = await dispatch.outbox.claimOutboxV12({
        claimer: "t1514-dispatcher",
        recipientHandleId: handle,
        now: secondOf(second),
        limit: 8,
      });
      expect(claimed).toMatchObject({ result: "claimed", claimed: [{ outboxRowId: row }] });
      await dispatch.outbox.markPartV12({
        outcome: "sent",
        idempotencyKey: `${row}/1/1`,
        providerMessageId: `linq-msg-t1514-${name}`,
        providerOptionIds: null,
        at: secondOf(second + 1),
      });
      expect(
        await dispatch.outbox.markPartV12({
          outcome: "delivered",
          providerMessageId: `linq-msg-t1514-${name}`,
          at: secondOf(second + 2),
        }),
      ).toMatchObject({ result: "marked", repeated: false, row: { state: "delivered" } });
      return secondOf(second + 2);
    };

    // No phone row for the handle (as an email handle has none): the part is marked delivered and no row is made.
    expect(dispatch.phones.size).toBe(0);
    await deliver("no-phone", 0);
    expect(dispatch.phones.size).toBe(0);

    // A stopped phone that never got the line: its time is set and its version raised; stopped and its time stay.
    const stopped = {
      ...samPhoneRow(),
      stopped: true,
      stopAt: "2026-10-19T13:00:00Z",
      optoutLineDeliveredAt: null,
    };
    dispatch.phones.set(handle, stopped);
    const deliveredAt = await deliver("stopped", 10);
    expect(dispatch.phones.get(handle)).toEqual({
      ...stopped,
      optoutLineDeliveredAt: deliveredAt,
      version: stopped.version + 1,
    });
  });
});
