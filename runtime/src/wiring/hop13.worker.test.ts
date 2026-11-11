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
//     under its trace id and bundle v0, after the part's providerAccepted span; the receipt's webhook has its own trace,
//     its receive alone.
//   - A second delivered event for the same part (Linq's retry of the webhook, and another event for the part) arms
//     nothing more: K-05 answers it repeated, nothing is handed to the arming, and no clockArmed span is added.
//   - With no arming calls bound (the Worker until T-567), the part is still marked delivered and the arming fails
//     closed: nothing is armed, and its span says it failed.
//
// Each test runs the JOIN on a fresh rig, and the Durable Objects' storage is reset after each (as hop 12's tests run it).
// Test values only (rule 9): the master's sample cast, the fictional 555-01xx numbers and the fixtures' own words.
import joinRunContext from "@rosie/ai/recordings/contexts/join-s1-01.json";
import textFixture from "@rosie/contracts/inbound-event/fixtures/text-imessage.json";
import { reset, runDurableObjectAlarm } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { QUIET_MS, turnIdOf, type HandleActor } from "../actor";
import { dueOf } from "../clocks/due";
import { actorNameOf } from "../gateway";
import type { Hop, Span } from "../trace";
import { leaks, spansOfLogLines, spansOfTrace } from "../trace/hop-check";
import { flush } from "../turn/test-support";
import { composeRoot, SKELETON_FLAG, type HandleActors, type Root } from "./index";
import {
  BUNDLE_V0,
  fakeFlags,
  SAM_CHAT,
  skeletonFakes,
  TEST_OWNER_1,
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

/** The root for "test", every joined port fed its double, this hop's arming among them unless `armed` is false. */
function testRoot(fakes: SkeletonFakes, actors: HandleActors<DurableObjectId>, armed: boolean): Root {
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
    outboxCalls: fakes.dispatch.outbox,
    sendStateCall: fakes.dispatch.sendState,
    linqSendCall: fakes.linq.call,
    retryQueue: fakes.retryQueue,
    // This hop: the clock arming's K-05 calls and reads, over the rows the commit wrote and test owner 1's seeded rows.
    armingCalls: armed ? fakes.arming.calls : null,
    flags: fakeFlags([SKELETON_FLAG]),
  });
}

interface Rig {
  readonly fakes: SkeletonFakes;
  readonly root: Root;
  /** Posts a signed webhook through the root's Linq route; answers the trace id the gateway opened. */
  post(event: LinqInboundEvent, partKey?: string | null): Promise<string>;
  spans(): Span[];
  traceOf(traceId: string): Span[];
  restore(): void;
}

function rig(log: MockInstance, armed = true): Rig {
  const fakes = skeletonFakes();
  const root = testRoot(fakes, handleActors(), armed);
  const restore = root.install();
  const spans = (): Span[] => spansOfLogLines(log.mock.calls.map((call: unknown[]) => call[0]));
  return {
    fakes,
    root,
    async post(event, partKey = null) {
      const response = await root.linqWebhook(webhookRequest(await fakes.sign(event, partKey)));
      if (response.status !== 200) throw new Error(`the gateway answered ${String(response.status)}`);
      const traceId = response.headers.get("x-trace-id");
      if (traceId === null) throw new Error("the gateway answered with no trace id");
      return traceId;
    },
    spans,
    traceOf: (traceId) => spansOfTrace(spans(), traceId),
    restore,
  };
}

/** The JOIN's turn, run on `run` to its reply: its turn id, trace id, the row its commit wrote and the row's question. */
async function runJoin(
  run: Rig,
): Promise<{ turnId: string; traceId: string; row: string; question: string; clock: string }> {
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

        // Under the JOIN's trace id and bundle v0: one delivered span, then one clockArmed span, after the part's
        // providerAccepted span; labels and counts only.
        const trace = run.traceOf(traceId);
        const accept = onlySpan(trace, "providerAccepted");
        const delivered = onlySpan(trace, "delivered");
        const armed = onlySpan(trace, "clockArmed");
        expect(delivered).toMatchObject({
          trace_id: traceId,
          bundle_id: BUNDLE_V0,
          outcome: "ok",
          provider: "linq",
          error_code: null,
          got: { firstDelivery: true, repeated: false },
          rows: [{ table: "outbox_rows", id: row }],
        });
        expect(armed).toMatchObject({
          trace_id: traceId,
          bundle_id: BUNDLE_V0,
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
    "a second delivered event for the same part arms nothing more: Linq's retry of the webhook and another event for the part are each answered repeated by K-05, and nothing is handed to the arming",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = rig(log);
      try {
        const { traceId, row, clock } = await runJoin(run);
        const key = `${row}/1/1`;
        const { arming, dispatch } = run.fakes;
        const receipt = deliveredReceiptOf(run.fakes, key, "evt-linq-delivered-sam-0001");
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

        // K-05 answered each repeated, changing nothing; the arming was asked nothing more.
        expect(
          dispatch.partMarks
            .filter((call) => call.request.outcome === "delivered")
            .map((call) => call.answer),
        ).toMatchObject([
          { result: "marked", repeated: false, firstDelivery: true },
          { result: "marked", repeated: true, firstDelivery: false },
          { result: "marked", repeated: true, firstDelivery: false },
        ]);
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
        // On the JOIN's trace: one clockArmed span; each receipt's delivered span, the repeats saying so.
        const trace = run.traceOf(traceId);
        expect(spansOf(trace, "clockArmed")).toHaveLength(1);
        expect(spansOf(trace, "delivered").map((span) => span.got)).toEqual([
          { firstDelivery: true, repeated: false },
          { firstDelivery: false, repeated: true },
          { firstDelivery: false, repeated: true },
        ]);
      } finally {
        run.restore();
      }
    },
  );

  it(
    "with no arming calls bound (the Worker until T-567) the part is still marked delivered and the arming fails closed: nothing is armed, and its span says it failed",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = rig(log, false);
      try {
        const { traceId, row, clock, question } = await runJoin(run);
        const key = `${row}/1/1`;
        await run.post(deliveredReceiptOf(run.fakes, key, "evt-linq-delivered-sam-0001"), key);

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
