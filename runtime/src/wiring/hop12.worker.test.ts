// T-563's join, hop 12 of D-017 (C-124; build prompt section 10, D-017: "a webhook fixture in gives exactly one outbox row
// and one send to the Linq double"; 02-contracts section 11, 'Send to the Linq double': K-11; DL-315, DL-433; CQ-152), in
// the Workers runtime. The composition root is composed for the test environment as hop 11's tests compose it, now with
// this hop's port and the dispatcher's retries: the Linq send, K-11 sendPart through the root's Linq door to
// @rosie/adapters' Linq double (T-411; ./test-support.ts FakeLinqLine, RootOptions.linqSendCall), and T-258's retries: a
// row left waiting for its next try goes on the retry queue (fakeRetryQueue, RootOptions.retryQueue), and each test hands
// the due messages to the queue's consumer (runtime/src/queues consumeRetries), which runs them through the root's door
// with the ports `install()` set, as the Worker's queue handler does. The JOIN opens Sam's chat at receipt (T-1213), so
// limit 8 lets its reply go.
//
//   - No duplicate send (the hard invariant): the double takes the JOIN's reply, and its answer is lost on the way back
//     (no answer). The dispatcher keeps the part pending under its key and puts its next try on the queue about 60 s
//     later (CQ-152). The same webhook sent again is dropped at receipt. When the try comes due, the row is claimed again
//     (claim 2) and the part goes under the same key: the double answers with its first message, so it records one send.
//     A retry forced through the door afterwards claims nothing and sends nothing: still one send.
//   - No answer ever (CQ-152; K-07 rule 5): each try goes again a minute later under the same key and a new claim, the
//     claim keeping the first try's time, until 15 minutes have passed since it: then no new job is started (the next way
//     is C-126's), and the double still holds the one part it took.
//   - A 4006 from the double (K-11 error-4006.json): try 1 is marked failed with no new key, and its job waits a minute
//     for a receipt. None comes, so the door writes try 2 under a new key (K-07 outbox-4006-new-key.json), the row is
//     claimed again and try 2 goes. Its delivery receipt marks it delivered: one part delivered, try 1 failed.
//   - A 4006 whose receipt comes within the minute (K-11 verify-delivered-after-4006.json): the receipt, found by the part's
//     key, moves try 1 to delivered; when the minute is out the door finds it delivered and writes no new key (K-07 retry
//     rule 2): one send, one part delivered.
//
// Each test runs the JOIN on a fresh rig, and the Durable Objects' storage is reset after each (as hop 11's tests run it).
// Test values only (rule 9): the master's sample cast, the fictional 555-01xx numbers and the fixtures' own words.
import joinRunContext from "@rosie/ai/recordings/contexts/join-s1-01.json";
import deliveredFixture from "@rosie/contracts/inbound-event/fixtures/delivered.json";
import textFixture from "@rosie/contracts/inbound-event/fixtures/text-imessage.json";
import { reset, runDurableObjectAlarm } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { QUIET_MS, turnIdOf, type HandleActor } from "../actor";
import { actorNameOf } from "../gateway";
import { consumeRetries, type BatchReport } from "../queues";
import { batchOf, LOG, messageId } from "../queues/test-support";
import type { Hop, Span } from "../trace";
import { leaks, spansOfLogLines, spansOfTrace } from "../trace/hop-check";
import { flush } from "../turn/test-support";
import { composeRoot, SKELETON_FLAG, type HandleActors, type Root } from "./index";
import {
  bundleV0FixedLine,
  fakeFlags,
  SAM_CHAT,
  skeletonFakes,
  TEST_OWNER_1,
  TEST_OWNER_1_BUSINESS_NAME,
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
/** Past a retry's wait: the claim's 60 s and the receipt's minute (K-07 default 2; RECEIPT_WAIT_S). */
const PAST_THE_MINUTE_MS = 61_000;

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

/** Linq's delivery receipt for one part: K-06 delivered.json on Sam's chat, with Linq's message id and its time. */
function deliveredReceipt(eventId: string, providerMessageId: string, at: number): LinqInboundEvent {
  return {
    ...(structuredClone(deliveredFixture) as Json),
    eventId,
    handle: { ...TEST_OWNER_1.handle },
    chatId: SAM_CHAT,
    status: {
      messageId: providerMessageId,
      at: new Date(at).toISOString().replace(/\.\d{3}Z$/u, "Z"),
      failure: null,
    },
  } as unknown as LinqInboundEvent;
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
 * The root for "test", every joined port fed its double, the Linq send (T-563) and the retry queue among them, and hop
 * 13's arming (T-564), so a delivery receipt's arming arms and the receipt is answered 200: one whose arming fails is
 * answered 503 (T-1244).
 */
function testRoot(fakes: SkeletonFakes, actors: HandleActors<DurableObjectId>): Root {
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
    // This hop: each part through the root's Linq door to @rosie/adapters' Linq double, and the dispatcher's waits on
    // the retry queue.
    linqSendCall: fakes.linq.call,
    retryQueue: fakes.retryQueue,
    armingCalls: fakes.arming.calls,
    flags: fakeFlags([SKELETON_FLAG]),
  });
}

interface Rig {
  readonly fakes: SkeletonFakes;
  readonly root: Root;
  /** Posts a signed webhook through the root's Linq route; answers the trace id the gateway opened. */
  post(event: LinqInboundEvent, partKey?: string | null): Promise<string>;
  /** Hands the retry queue's due messages to the queue's consumer, as the Worker's queue handler gets them. */
  deliverDue(): Promise<BatchReport>;
  spans(): Span[];
  traceOf(traceId: string): Span[];
  restore(): void;
}

function rig(log: MockInstance): Rig {
  const fakes = skeletonFakes();
  const root = testRoot(fakes, handleActors());
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
    async deliverDue() {
      const at = fakes.clock.now();
      const due = fakes.retryQueue.due(at);
      const { batch } = batchOf(
        due.map((entry) => ({ id: messageId(), body: entry.message })),
        at,
      );
      // No ports handed in: the consumer takes this isolate's, which the root's install() set (T-563).
      return consumeRetries(batch, { queue: fakes.retryQueue, log: LOG, now: () => fakes.clock.now() });
    },
    spans,
    traceOf: (traceId) => spansOfTrace(spans(), traceId),
    restore,
  };
}

/** The JOIN's turn, run on `run` to its reply: its turn id, trace id and the row its commit wrote. */
async function runJoin(run: Rig): Promise<{ turnId: string; traceId: string; row: string }> {
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
  return { turnId, traceId, row: `outbox-s1-02-${turnId}-1` };
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

/** Every string a value holds, at any depth. */
function stringsOf(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value as unknown[]) stringsOf(item, into);
  else if (typeof value === "object" && value !== null)
    for (const item of Object.values(value)) stringsOf(item, into);
  return into;
}

/** No span holds the JOIN's number, Sam's chat id, or a line of the part's words. */
function expectNothingLeaked(run: Rig, text: string): void {
  const spans = run.spans();
  expect(leaks(spans, [...CAST_NUMBERS, SAM_CHAT])).toEqual([]);
  expect(stringsOf(spans).filter((value) => text.split("\n").some((line) => value.includes(line)))).toEqual(
    [],
  );
}

/** The final parts' one text finalize wrote into the row: the opener first, the STOP, HELP and rates line and the link last. */
function finalTextOf(run: Rig, row: string): string {
  const written = run.fakes.finalize.plans.get(row);
  if (written === undefined) throw new Error("finalize wrote no final parts into the JOIN turn's row");
  expect(written.finalParts.sends).toHaveLength(1);
  const text = written.finalParts.sends[0].text ?? "";
  const opener = bundleV0FixedLine("opener").replace("<business>", TEST_OWNER_1_BUSINESS_NAME);
  expect(text.startsWith(`${opener} `)).toBe(true);
  expect(text.split("\n").slice(-2)).toEqual([
    bundleV0FixedLine("optOutLine"),
    bundleV0FixedLine("privacyLink"),
  ]);
  return text;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("hop 12 joined: each part sent to @rosie/adapters' Linq double through the root's Linq send port, once per row-part-try key", () => {
  it(
    "no duplicate send: Linq's answer lost, the same webhook sent again and the retry ~60 s later under a re-claim with the same key still leave one recorded send; a retry forced afterwards sends nothing",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = rig(log);
      try {
        // The double takes the reply, and its answer never comes back: no answer (K-11 transient with no status).
        run.fakes.linq.loseNextAnswers(1);
        const { turnId, traceId, row } = await runJoin(run);
        const key = `${row}/1/1`;
        const { dispatch, linq, retryQueue } = run.fakes;
        const text = finalTextOf(run, row);

        // The double recorded the part once, with the final parts' words, to Sam's chat by iMessage.
        expect(linq.double.sentRequests()).toMatchObject([
          {
            idempotencyKey: key,
            to: TEST_OWNER_1.handle.address,
            chatId: SAM_CHAT,
            service: "imessage",
            kind: "words",
            text,
            overrideOptout: false,
          },
        ]);
        // The dispatcher heard no answer: nothing marked, the part pending under its key, the row still sending.
        expect(dispatch.partMarks).toEqual([]);
        expect(dispatch.row(row)).toMatchObject({
          state: "sending",
          claim: { claimNo: 1 },
          parts: [{ key, state: "pending", attempts: 1 }],
        });
        expect(onlySpan(run.traceOf(traceId), "dispatch")).toMatchObject({
          outcome: "timedOut",
          error_code: "transient",
          turn_id: turnId,
          provider: "linq",
          call: "sendPart",
          attempt: 1,
          decided: { result: "failed", claimNo: 1, retry: "sameKey" },
        });
        expect(spansOf(run.traceOf(traceId), "providerAccepted")).toEqual([]);
        // Its next try is on the retry queue (T-258's job, the root's DispatchDeps.retries): the same key, about 60 s on.
        expect(retryQueue.sent.map((entry) => entry.message)).toMatchObject([
          {
            v: 1,
            try: 2,
            lastError: "SendFailed:transient",
            job: {
              key: `retry-${key}#1`,
              kind: "send",
              businessId: TEST_OWNER_1.businessId,
              traceId,
              body: {
                outboxRowId: row,
                recipientHandleId: TEST_OWNER_1.handleId,
                failedKey: key,
                chain: "rerun",
                code: "transient",
              },
            },
          },
        ]);
        const delay = retryQueue.sent[0]?.options.delaySeconds ?? 0;
        expect(delay).toBeGreaterThanOrEqual(59);
        expect(delay).toBeLessThanOrEqual(61);

        // The same webhook sent again: dropped at receipt as a known event id, nothing stored and nothing sent.
        const again = await run.post(joinAsRecorded());
        await settle(OWNER_ACTOR);
        expect(again).not.toBe(traceId);
        // The gateway's own receive span (the actor's own beside it is its inbox door's: T-1108's gap).
        expect(
          run.traceOf(again).filter((span) => span.hop === "receive" && span.got?.door !== "handleActor"),
        ).toMatchObject([{ outcome: "dropped", decided: { knownEventId: true, answered: 200 } }]);
        expect(dispatch.claims).toHaveLength(1);
        expect(linq.double.sentRequests()).toHaveLength(1);
        // Not before its time: nothing is due yet.
        expect((await run.deliverDue()).reports).toEqual([]);

        // A minute on, the try comes due and the consumer runs it through the root's door: the row is claimed again
        // (claim 2, from sending), its part under the same key with attempts 2, and the part goes again under that key.
        await run.fakes.clock.advance(PAST_THE_MINUTE_MS);
        const report = await run.deliverDue();
        expect(report.reports.map((each) => [each.outcome, each.jobKey, each.traceId])).toEqual([
          ["done", `retry-${key}#1`, traceId],
        ]);
        const reclaim = dispatch.claims[1]?.answer;
        if (reclaim === undefined || "error" in reclaim) throw new Error("the retry claimed nothing");
        expect(
          reclaim.claimed.map((claimed) => [
            claimed.outboxRowId,
            claimed.claimedFrom,
            claimed.claim.claimNo,
            claimed.parts,
          ]),
        ).toEqual([
          [row, "sending", 2, [{ partNo: 1, tryNo: 1, idempotencyKey: key, attempts: 2, sent: false }]],
        ]);
        // The line was handed the one key twice; the double answered the second with its first message and recorded
        // one send: one message for Sam.
        expect(linq.requests.map((request) => request.idempotencyKey)).toEqual([key, key]);
        expect(linq.double.sentRequests()).toHaveLength(1);
        const accepted = linq.accepted.get(key);
        if (accepted?.providerMessageId == null) throw new Error("the double accepted no part");
        expect(dispatch.partMarks.map((call) => [call.request, call.answer])).toMatchObject([
          [
            { outcome: "sent", idempotencyKey: key, providerMessageId: accepted.providerMessageId },
            { result: "marked", repeated: false, row: { state: "sent" } },
          ],
        ]);
        expect(dispatch.row(row)).toMatchObject({ state: "sent", claim: { claimNo: 2 } });
        // The retry's run is on the JOIN's trace: its dispatch span sent the part under claim 2, its acceptance once.
        expect(
          spansOf(run.traceOf(traceId), "dispatch").map((span) => [
            span.outcome,
            span.decided?.result,
            span.decided?.claimNo,
          ]),
        ).toEqual([
          ["timedOut", "failed", 1],
          ["ok", "sent", 2],
        ]);
        expect(onlySpan(run.traceOf(traceId), "providerAccepted").rows).toEqual([
          { table: "outbox_parts", id: key },
        ]);
        expect(retryQueue.sent).toHaveLength(1);

        // A retry forced through the root's door now: the row is sent, so nothing is claimed and nothing is sent.
        expect(
          await run.root.queue.sends.retrySend({
            key: `retry-${key}#2`,
            kind: "send",
            businessId: TEST_OWNER_1.businessId,
            traceId,
            body: {
              outboxRowId: row,
              recipientHandleId: TEST_OWNER_1.handleId,
              failedKey: key,
              chain: "rerun",
              code: "forced",
            },
            try: 2,
            firstTriedAt: new Date(run.fakes.clock.now()).toISOString(),
          }),
        ).toEqual({ result: "done" });
        expect(dispatch.claims.map((call) => call.answer)).toMatchObject([
          { result: "claimed" },
          { result: "claimed" },
          { result: "claimed", claimed: [], passedHeld: [] },
        ]);
        expect(linq.requests).toHaveLength(2);
        expect(linq.double.sentRequests()).toHaveLength(1);
        expectNothingLeaked(run, text);
      } finally {
        run.restore();
      }
    },
  );

  it(
    "no new retry job once 15 minutes of tries have passed since the first try (CQ-152; K-07 rule 5): every retry goes under the one key, and the double still holds one send",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = rig(log);
      try {
        // Linq takes the part every time, and no answer ever comes back.
        run.fakes.linq.loseNextAnswers(100);
        const { row } = await runJoin(run);
        const key = `${row}/1/1`;
        const { dispatch, linq, retryQueue } = run.fakes;
        const firstTryAt = dispatch.row(row)?.claim?.firstTryAt;
        if (firstTryAt == null) throw new Error("the part's first try set no firstTryAt on its claim");

        // Each try comes due a minute after the last and goes again under the same key, under a new claim, and each
        // failure starts the next job, until 15 minutes have passed since the first try: then no new job is started.
        for (let round = 1; round <= 20 && retryQueue.sent.length === round; round += 1) {
          await run.fakes.clock.advance(PAST_THE_MINUTE_MS);
          expect((await run.deliverDue()).reports.map((each) => each.outcome)).toEqual(["done"]);
        }
        // 61 s a round: rounds 1 to 14 each start the next job (854 s), and round 15's failure, 915 s after the first
        // try, starts none.
        expect(retryQueue.sent.map((entry) => entry.message.job.key)).toEqual(
          Array.from({ length: 15 }, (_each, index) => `retry-${key}#${String(index + 1)}`),
        );
        expect(retryQueue.due(run.fakes.clock.now() + 3_600_000)).toEqual([]);
        expect(dispatch.row(row)).toMatchObject({ state: "sending", claim: { claimNo: 16, firstTryAt } });
        // Sixteen sends under the one key, and the double holds the one part it took.
        expect(linq.requests).toHaveLength(16);
        expect(new Set(linq.requests.map((request) => request.idempotencyKey))).toEqual(new Set([key]));
        expect(linq.double.sentRequests()).toHaveLength(1);
        expect(dispatch.partMarks).toEqual([]);
      } finally {
        run.restore();
      }
    },
  );

  it(
    "a 4006 from the double is retried under a new try key once its minute passes with no receipt, and still gives one delivered part",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = rig(log);
      try {
        run.fakes.linq.double.failNextSend({ kind: "mayStillDeliver", code: "4006" });
        const { traceId, row } = await runJoin(run);
        const first = `${row}/1/1`;
        const second = `${row}/1/2`;
        const { dispatch, linq, retryQueue } = run.fakes;
        const text = finalTextOf(run, row);

        // Try 1 failed with 4006, which may still deliver: marked failed with no new key (K-05 mark-failed-4006.json),
        // and its job waits the minute for a receipt (K-07 retry rule 2).
        expect(dispatch.partMarks.map((call) => [call.request, call.answer])).toMatchObject([
          [
            { outcome: "failed", idempotencyKey: first, errorCode: "4006", retry: false },
            { result: "marked", tryNo: 1, repeated: false, nextKey: null, row: { state: "sending" } },
          ],
        ]);
        expect(onlySpan(run.traceOf(traceId), "dispatch")).toMatchObject({
          outcome: "failed",
          error_code: "4006",
          decided: { result: "failed", claimNo: 1, retry: "awaitReceipt", waitSeconds: 60 },
        });
        expect(retryQueue.sent.map((entry) => entry.message.job.body)).toEqual([
          {
            outboxRowId: row,
            recipientHandleId: TEST_OWNER_1.handleId,
            failedKey: first,
            chain: "awaitReceipt",
            code: "4006",
          },
        ]);

        // The minute out with no receipt: the door has the store write try 2 under a new key (K-07
        // outbox-4006-new-key.json), the row is claimed again and try 2 goes, accepted.
        await run.fakes.clock.advance(PAST_THE_MINUTE_MS);
        expect((await run.deliverDue()).reports.map((each) => each.outcome)).toEqual(["done"]);
        expect(dispatch.partMarks.slice(1).map((call) => [call.request, call.answer])).toMatchObject([
          [
            { outcome: "failed", idempotencyKey: first, errorCode: "4006", retry: true },
            { result: "marked", tryNo: 1, repeated: false, nextKey: second },
          ],
          [
            { outcome: "sent", idempotencyKey: second },
            { result: "marked", tryNo: 2, repeated: false, row: { state: "sent" } },
          ],
        ]);
        const reclaim = dispatch.claims[1]?.answer;
        if (reclaim === undefined || "error" in reclaim) throw new Error("the retry claimed nothing");
        expect(reclaim.claimed.map((claimed) => [claimed.claim.claimNo, claimed.parts])).toEqual([
          [2, [{ partNo: 1, tryNo: 2, idempotencyKey: second, attempts: 2, sent: false }]],
        ]);
        // The double recorded two tries under two keys, the first refused with 4006, the second accepted.
        expect(linq.double.sentRequests().map((request) => [request.idempotencyKey, request.text])).toEqual([
          [first, text],
          [second, text],
        ]);
        const accepted = linq.accepted.get(second);
        if (accepted?.providerMessageId == null) throw new Error("the double accepted no try 2");
        expect(linq.accepted.has(first)).toBe(false);

        // Try 2's delivery receipt reaches the root's receipt door: the part delivered, the row's first delivery.
        const delivered = linq.double.fakeDelivered(second);
        expect(delivered.messageId).toBe(accepted.providerMessageId);
        await run.post(
          deliveredReceipt("evt-linq-delivered-sam-4006", accepted.providerMessageId, run.fakes.clock.now()),
          second,
        );
        expect(dispatch.partMarks.at(-1)).toMatchObject({
          request: { outcome: "delivered", providerMessageId: accepted.providerMessageId },
          answer: {
            result: "marked",
            tryNo: 2,
            repeated: false,
            firstDelivery: true,
            row: { state: "delivered" },
          },
        });
        // One part delivered: try 2; try 1 stays failed.
        expect(dispatch.row(row)?.parts.map((part) => [part.key, part.state])).toEqual([
          [first, "failed"],
          [second, "delivered"],
        ]);
        expect(dispatch.row(row)).toMatchObject({ state: "delivered" });
        expect(retryQueue.sent).toHaveLength(1);
        expectNothingLeaked(run, text);
      } finally {
        run.restore();
      }
    },
  );

  it(
    "a 4006 whose receipt comes within the minute is delivered by its key, and no new key is written or sent: one send, one part delivered",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = rig(log);
      try {
        run.fakes.linq.double.failNextSend({ kind: "mayStillDeliver", code: "4006" });
        const { row } = await runJoin(run);
        const first = `${row}/1/1`;
        const { dispatch, linq } = run.fakes;
        const text = finalTextOf(run, row);
        expect(dispatch.partMarks.map((call) => call.request.outcome)).toEqual(["failed"]);

        // 25 s on, Linq's receipt for try 1 comes, carrying its message id and echoing the part's key: the part holds no
        // message id (the 4006 gave none), so the store finds it by the key and moves it to delivered (K-05 v1.2 item 31).
        await run.fakes.clock.advance(25_000);
        await run.post(
          deliveredReceipt("evt-linq-delivered-sam-0001", "linq-msg-demo-sam-0001", run.fakes.clock.now()),
          first,
        );
        expect(dispatch.partMarks.at(-1)).toMatchObject({
          request: { outcome: "delivered", idempotencyKey: first },
          answer: { result: "marked", tryNo: 1, firstDelivery: true, row: { state: "delivered" } },
        });

        // The minute out: the door asks the store for the part's next try, finds it delivered and ends its retries.
        await run.fakes.clock.advance(PAST_THE_MINUTE_MS - 25_000);
        expect((await run.deliverDue()).reports.map((each) => each.outcome)).toEqual(["done"]);
        expect(dispatch.partMarks.at(-1)).toMatchObject({
          request: { outcome: "failed", idempotencyKey: first, retry: true },
          answer: { error: "wrongState", table: "outbox_parts", state: "delivered" },
        });
        // No new claim, no new key, nothing sent again.
        expect(dispatch.claims).toHaveLength(1);
        expect(dispatch.row(row)?.parts.map((part) => [part.key, part.state])).toEqual([
          [first, "delivered"],
        ]);
        expect(linq.double.sentRequests().map((request) => request.idempotencyKey)).toEqual([first]);
        expect(linq.requests).toHaveLength(1);
        expectNothingLeaked(run, text);
      } finally {
        run.restore();
      }
    },
  );
});
