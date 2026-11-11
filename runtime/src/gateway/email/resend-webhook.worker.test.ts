// The Resend webhook door, run inside the Workers runtime (T-265). The email port is the email double (T-418), which
// makes and checks each webhook's Svix signature under the test environment's own made-up secret and answers K-12 v1's
// verify and read as the adapter will; the door to the handle's actor and the receipt door are stubs that store each
// event id once, and the key store is the gateway's fake. Fixtures: contracts/port-email and contracts/inbound-event (the
// two inbound fixtures' events are K-06's email-reply-check-passed.json and email-reply-check-failed.json byte for byte).
// Test values only: the fixtures' demo shop and sample cast, the public test card numbers and the printed sample Social
// Security number (rule 9); no real address, key or signature (rule 7).
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import worker, { createWorker } from "../../index";
import k06Failed from "../../../../contracts/inbound-event/fixtures/email-reply-check-failed.json";
import k06Passed from "../../../../contracts/inbound-event/fixtures/email-reply-check-passed.json";
import bounced from "../../../../contracts/port-email/fixtures/bounced.json";
import delivered from "../../../../contracts/port-email/fixtures/delivered.json";
import replyFailed from "../../../../contracts/port-email/fixtures/inbound-reply-failed-check.json";
import replyPassed from "../../../../contracts/port-email/fixtures/inbound-reply-passed.json";
import badSignature from "../../../../contracts/port-email/fixtures/verify-bad-signature.json";
import ignoredDelayed from "../../../../contracts/port-email/fixtures/verify-ignored-delivery-delayed.json";
import replyReceived from "../../../../contracts/port-email/fixtures/verify-reply-received.json";
import { handleDeliveryReceipt } from "../../dispatch/dispatcher";
import type { MarkPartRequest, OutboxStore, PartDelivered } from "../../dispatch/types";
import { logSink, openTrace, spanProblems } from "../../trace";
import { unwireWorker, workerRoot } from "../../wiring";
import { unconfiguredGateway } from "..";
import { present } from "../test-support";
import type { ReceiptSink } from "../types";
import { unconfiguredEmail } from ".";
import {
  EMAIL_BODY_LIMIT_BYTES,
  EMAIL_MAX_SIGNATURE_ENTRIES,
  handleResendWebhook,
  withSenderCheck,
} from "./resend-webhook";
import {
  captureLog,
  emailDouble,
  emailPortOf,
  OTHER_TEST_WEBHOOK_SECRET,
  resendRequest,
  signedFixture,
  signedReply,
  unsealed,
  worldAt,
  type World,
} from "./test-support";
import type { EmailDeps, EmailPort } from "./types";

type Json = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WHERE = { environment: "staging", version: "test-sha" };

/** Alex's address and the booking's reply address, as the two inbound fixtures hold them: never in a log line or an answer. */
const ALEX = replyPassed.outcome.event.handle.address;
const REPLY_ADDRESS = replyPassed.outcome.event.email.replyAddress;

/** The public test card numbers, spaced as a person types them. */
const CARD = "4242 4242 4242 4242";
const OTHER_CARD = "4111 1111 1111 1111";

/** When the gateway received a webhook at `now`, as it writes it. */
const receivedAtOf = (now: string): string => new Date(Date.parse(now)).toISOString();

/** A reply's webhook as the double fakes it for `event`, posted to the door. */
async function sendReply(
  world: World,
  event: Json,
  options: Parameters<typeof signedReply>[2] = {},
  deps: EmailDeps = world.deps,
): Promise<Response> {
  return handleResendWebhook(resendRequest(await signedReply(world.double, event, options)), deps, WHERE);
}

/** A K-12 fixture's own webhook, signed as its given.signing says, posted to the door. */
async function sendFixture(
  world: World,
  exchange: Parameters<typeof signedFixture>[1],
  deps: EmailDeps = world.deps,
): Promise<Response> {
  return handleResendWebhook(resendRequest(await signedFixture(world.double, exchange)), deps, WHERE);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an inbound reply (K-12 'Inbound replies'; K-06 email-reply-check-passed.json and email-reply-check-failed.json)", () => {
  it("a reply with a passed sender check reaches the handle's actor as the K-06 email event, sealed, in under 1 s", async () => {
    const log = captureLog();
    const world = worldAt(replyPassed.given.now);
    const receivedAt = receivedAtOf(replyPassed.given.now);
    const webhook = await signedReply(world.double, replyPassed.outcome.event, {
      receivedEmailId: replyPassed.request.receivedEmailId,
    });

    const started = performance.now();
    const response = await handleResendWebhook(resendRequest(webhook), world.deps, WHERE);
    const elapsed = performance.now() - started;

    expect(response.status).toBe(200);
    expect(elapsed).toBeLessThan(1000);
    const traceId = response.headers.get("x-trace-id");
    expect(traceId).toMatch(UUID);
    const answer = await response.text();
    expect(JSON.parse(answer)).toEqual({ ok: true, trace_id: traceId });

    // Verify first, with the webhook as sent; then the read of the reply it announced, under the webhook's id.
    expect(world.port.verified).toEqual([
      {
        webhookId: replyReceived.request.webhookId,
        timestamp: webhook.timestamp,
        signature: webhook.signature,
        raw: webhook.raw,
        receivedAt,
        traceId,
      },
    ]);
    expect(world.port.reads).toEqual([
      {
        eventId: replyPassed.request.eventId,
        receivedEmailId: replyPassed.request.receivedEmailId,
        receivedAt,
        traceId,
      },
    ]);

    // To the handle's actor and nowhere else: one actor per email handle, the words and the subject only in the box.
    expect(world.receipts.calls).toHaveLength(0);
    expect(world.actor.written).toHaveLength(1);
    const handoff = present(world.actor.written[0], "the hand-off");
    expect(handoff.actorName).toBe(`email:${ALEX}`);
    expect(handoff.partKey).toBeNull();
    expect(handoff.traceId).toBe(traceId);
    expect(handoff.event).not.toHaveProperty("body");
    expect(handoff.event.email).toEqual({ replyAddress: REPLY_ADDRESS, senderCheck: "passed" });
    expect(JSON.stringify(handoff)).not.toContain(k06Passed.body);
    expect(JSON.stringify(handoff)).not.toContain(k06Passed.email.subject);
    // The K-06 email event, as the fixture holds it, with the gateway's own receipt time and trace.
    expect(replyPassed.outcome.event).toEqual(k06Passed);
    expect(await unsealed(handoff, world.keys)).toEqual({ ...k06Passed, receivedAt, traceId });
    expect(world.keys.asked).toEqual([k06Passed.handle]);

    // receive, then the read's port call, then the scrub: labels, ids and counts only.
    const spans = log.spans();
    expect(spans.map((span) => [span.seq, span.hop])).toEqual([
      [1, "receive"],
      [2, "portCall"],
      [3, "scrub"],
    ]);
    for (const span of spans) {
      expect(spanProblems(span)).toEqual([]);
      expect(span.trace_id).toBe(traceId);
    }
    expect(spans[0]).toMatchObject({
      provider: "resend",
      event_id: "evt-email-alex-0001",
      outcome: "ok",
      got: { kind: "text", service: "email" },
      decided: { signatureValid: true, senderCheckPassed: true, knownEventId: false, answered: 200 },
      error_code: null,
    });
    expect(spans[1]).toMatchObject({
      provider: "resend",
      call: "readReply",
      attempt: 1,
      event_id: "evt-email-alex-0001",
      outcome: "ok",
      decided: { result: "event" },
    });
    expect(spans[2]).toMatchObject({ outcome: "ok", decided: { cardNumbersTagged: 0, ssnsTagged: 0 } });

    // Never logged or answered: an address, the subject, a word of the email.
    const seen = log.text() + answer;
    for (const secret of [ALEX, REPLY_ADDRESS, "reply.example.com", "haircut", k06Passed.body]) {
      expect(seen).not.toContain(secret);
    }
  });

  it("a failed check is marked so it proves nothing: the event the actor gets says failed, in the clear, and the span says so", async () => {
    const log = captureLog();
    const world = worldAt(replyFailed.given.now);
    const receivedAt = receivedAtOf(replyFailed.given.now);

    const response = await sendReply(world, replyFailed.outcome.event);

    expect(response.status).toBe(200);
    const traceId = response.headers.get("x-trace-id");
    const handoff = present(world.actor.written[0], "the hand-off");
    // The mark is K-06's own field, outside the sealed box, so whatever reads the event sees it before any word.
    expect(handoff.event.email).toEqual({ replyAddress: REPLY_ADDRESS, senderCheck: "failed" });
    expect(replyFailed.outcome.event).toEqual(k06Failed);
    expect(await unsealed(handoff, world.keys)).toEqual({ ...k06Failed, receivedAt, traceId });
    expect(log.spans()[0]).toMatchObject({
      hop: "receive",
      outcome: "ok",
      decided: { signatureValid: true, senderCheckPassed: false, knownEventId: false, answered: 200 },
    });
  });

  it.each([
    ["a word K-06 does not have", { senderCheck: "neutral" }],
    ["the word in capitals", { senderCheck: "PASSED" }],
    ["yes instead of the word", { senderCheck: true }],
    ["none at all", {}],
  ])(
    "a sender check that did not run, or that the port did not state as K-06 does (%s), is written failed: only the port's own passed is kept",
    async (_name, stated) => {
      const log = captureLog();
      const world = worldAt(replyPassed.given.now);
      // A port off the contract on purpose: the read's event with its sender check restated.
      const { replyAddress, subject } = replyPassed.outcome.event.email;
      const port = emailPortOf(world.double, (answer) => ({
        ...answer,
        event: { ...(answer.event as Json), email: { replyAddress, subject, ...stated } },
      }));

      const response = await sendReply(world, replyPassed.outcome.event, {}, { ...world.deps, email: port });

      expect(response.status).toBe(200);
      const handoff = present(world.actor.written[0], "the hand-off");
      expect(handoff.event.email).toEqual({ replyAddress: REPLY_ADDRESS, senderCheck: "failed" });
      expect(log.spans()[0]).toMatchObject({ decided: { senderCheckPassed: false } });
    },
  );

  it("withSenderCheck never turns a failed check into a passed one, and keeps a passed one as it is", () => {
    const passed = { ...k06Passed } as unknown as Parameters<typeof withSenderCheck>[0];
    const failed = { ...k06Failed } as unknown as Parameters<typeof withSenderCheck>[0];

    expect(withSenderCheck(passed)).toEqual({ event: k06Passed, passed: true });
    expect(withSenderCheck(failed)).toEqual({ event: k06Failed, passed: false });
    expect(withSenderCheck({ ...failed, email: null })).toMatchObject({
      event: { email: { senderCheck: "failed" } },
      passed: false,
    });
  });

  it("a card number in an email reply is scrubbed before any write: in its text and its subject, and a Social Security number too", async () => {
    const log = captureLog();
    const world = worldAt(replyPassed.given.now);
    const event = {
      ...replyPassed.outcome.event,
      eventId: "evt-email-alex-0003",
      messageId: "email-msg-demo-alex-0003",
      body: `My card is ${CARD} and my social is 123-45-6789`,
      email: { ...replyPassed.outcome.event.email, subject: `Re: card ${OTHER_CARD}` },
    };
    // Each door notes what it was handed at the moment of the write, so nothing unscrubbed can have come first.
    const handed: string[] = [];
    const actor: EmailDeps["actor"] = {
      accept(handoff) {
        handed.push(JSON.stringify(handoff));
        return world.actor.accept(handoff);
      },
    };

    const response = await sendReply(world, event, {}, { ...world.deps, actor });

    expect(response.status).toBe(200);
    expect(handed).toHaveLength(1);
    expect(world.receipts.calls).toHaveLength(0);
    const handoff = present(world.actor.written[0], "the hand-off");
    const opened = await unsealed(handoff, world.keys);
    expect(opened.body).toBe("My card is [card number] and my social is [SSN]");
    expect((opened.email as Json).subject).toBe("Re: card [card number]");
    expect(opened.scrubbed).toEqual({ cards: 2, ssns: 1 });
    expect(handoff.event.scrubbed).toEqual({ cards: 2, ssns: 1 });

    // The whole numbers, spaced as typed and run together: random ids and sealed boxes can hold a few of their digits by
    // chance (DL-116). Not in what was handed on, not in a log line, not in the answer.
    const seen = handed.join("") + log.text() + (await response.text());
    for (const number of [CARD, OTHER_CARD, "123-45-6789"]) {
      expect(seen).not.toContain(number);
      expect(seen).not.toContain(number.replaceAll(" ", ""));
    }
    expect(seen).not.toContain("My card is");

    const spans = log.spans();
    expect(spans.map((span) => span.hop)).toEqual(["receive", "portCall", "scrub"]);
    expect(spans[2]).toMatchObject({
      event_id: "evt-email-alex-0003",
      decided: { cardNumbersTagged: 2, ssnsTagged: 1 },
    });
    for (const span of spans) expect(spanProblems(span)).toEqual([]);
  });

  it("the same reply twice (Resend's retry): 200 both times, written once, the second a known event id", async () => {
    const log = captureLog();
    const world = worldAt(replyPassed.given.now);
    const webhook = await signedReply(world.double, replyPassed.outcome.event);

    const first = await handleResendWebhook(resendRequest(webhook), world.deps, WHERE);
    const second = await handleResendWebhook(resendRequest(webhook), world.deps, WHERE);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(world.actor.calls).toHaveLength(2);
    expect(world.actor.written).toHaveLength(1);
    const receives = log.spans().filter((span) => span.hop === "receive");
    expect(receives.map((span) => span.outcome)).toEqual(["ok", "dropped"]);
    expect(receives[1]).toMatchObject({
      decided: { signatureValid: true, knownEventId: true, answered: 200 },
    });
    // No scrub span for an event its actor did not write (trace-duplicate-webhook.json ends at receive).
    expect(log.spans().filter((span) => span.hop === "scrub")).toHaveLength(1);
  });

  it("the reply's one receive span is the door's, as K-08 states it (T-1108): sealedToActor once its actor wrote it, places 1 to 3 taken before the hand-off, which tells the actor so; a repeat names the trace the reply first arrived under", async () => {
    const log = captureLog();
    const world = worldAt(replyPassed.given.now);
    const webhook = await signedReply(world.double, replyPassed.outcome.event);
    // The actor's door as the gateway's is over the real actor: it answers the trace a stored event first arrived under.
    const asked: string[] = [];
    const actor: EmailDeps["actor"] = {
      accept: (handoff) => world.actor.accept(handoff),
      firstTrace(handoff) {
        asked.push(handoff.event.eventId);
        const stored = world.actor.written.find((one) => one.event.eventId === handoff.event.eventId);
        return Promise.resolve(stored?.traceId ?? null);
      },
    };
    const deps = { ...world.deps, actor };

    const first = await handleResendWebhook(resendRequest(webhook), deps, WHERE);
    const second = await handleResendWebhook(resendRequest(webhook), deps, WHERE);

    expect([first.status, second.status]).toEqual([200, 200]);
    const firstTrace = first.headers.get("x-trace-id");
    const repeatTrace = second.headers.get("x-trace-id");
    expect(repeatTrace).not.toBe(firstTrace);
    const spans = log.spans();
    // trace-skeleton.json's receive: decided.sealedToActor. The read's port call and the scrub follow it by seq, and
    // the hand-off says the door took those three places, so the actor's first span is the fourth.
    const written = spans.filter((span) => span.trace_id === firstTrace);
    expect(written.map((span) => [span.seq, span.hop, span.outcome])).toEqual([
      [1, "receive", "ok"],
      [2, "portCall", "ok"],
      [3, "scrub", "ok"],
    ]);
    expect(written[0]?.decided).toEqual({
      signatureValid: true,
      senderCheckPassed: true,
      knownEventId: false,
      sealedToActor: true,
      answered: 200,
    });
    expect(world.actor.calls.map((handoff) => handoff.seqBefore)).toEqual([3, 3]);
    // trace-duplicate-webhook.json's receive: dropped, the event id known, decided.firstTrace. Asked only for the repeat.
    const repeat = spans.filter((span) => span.trace_id === repeatTrace);
    expect(repeat.map((span) => [span.seq, span.hop, span.outcome])).toEqual([
      [1, "receive", "dropped"],
      [2, "portCall", "ok"],
    ]);
    expect(repeat[0]?.decided).toEqual({
      signatureValid: true,
      senderCheckPassed: true,
      knownEventId: true,
      firstTrace,
      answered: 200,
    });
    expect(asked).toEqual([replyPassed.outcome.event.eventId]);
    for (const span of spans) expect(spanProblems(span)).toEqual([]);
  });

  it("an automatic reply is 200 and dropped: nothing is written, so no loop of automatic emails starts", async () => {
    const log = captureLog();
    const world = worldAt(replyPassed.given.now);

    const response = await sendReply(world, replyPassed.outcome.event, { automatic: true });

    expect(response.status).toBe(200);
    expect(world.port.reads).toHaveLength(1);
    expect(world.actor.calls).toHaveLength(0);
    expect(world.keys.asked).toHaveLength(0);
    const spans = log.spans();
    expect(spans.map((span) => [span.hop, span.outcome])).toEqual([
      ["receive", "dropped"],
      ["portCall", "dropped"],
    ]);
    expect(spans[0]).toMatchObject({
      decided: { signatureValid: true, automaticReply: true, answered: 200 },
    });
    expect(spans[1]).toMatchObject({ decided: { result: "automaticReply" } });
  });

  it("a read that fails transient is 503 with nothing written, and Resend's retry is then written once", async () => {
    const log = captureLog();
    const world = worldAt(replyPassed.given.now);
    const webhook = await signedReply(world.double, replyPassed.outcome.event);
    world.double.failNextRead({ kind: "transient", code: "application_error" });

    const failedOnce = await handleResendWebhook(resendRequest(webhook), world.deps, WHERE);
    const retried = await handleResendWebhook(resendRequest(webhook), world.deps, WHERE);

    expect(failedOnce.status).toBe(503);
    expect(await failedOnce.json()).toMatchObject({ ok: false, error: "unavailable" });
    expect(retried.status).toBe(200);
    expect(world.actor.written).toHaveLength(1);
    const spans = log.spans();
    expect(spans[0]).toMatchObject({
      hop: "receive",
      outcome: "failed",
      error_code: "readTransient",
      decided: { signatureValid: true, answered: 503 },
    });
    expect(spans[1]).toMatchObject({
      hop: "portCall",
      outcome: "failed",
      error_code: "readTransient",
      got: { code: "application_error" },
      decided: { result: "transient" },
    });
    for (const span of spans) expect(spanProblems(span)).toEqual([]);
  });

  it("a reply Resend keeps no content of is 200 and dropped, named on its spans", async () => {
    const log = captureLog();
    const world = worldAt(replyPassed.given.now);
    const webhook = await signedReply(world.double, replyPassed.outcome.event);
    world.double.failNextRead({ kind: "unreadable" });

    const response = await handleResendWebhook(resendRequest(webhook), world.deps, WHERE);

    expect(response.status).toBe(200);
    expect(world.actor.calls).toHaveLength(0);
    expect(log.spans()[0]).toMatchObject({
      outcome: "dropped",
      error_code: "replyUnreadable",
      decided: { signatureValid: true, unreadableReply: true, answered: 200 },
    });
    expect(log.spans()[1]).toMatchObject({ hop: "portCall", got: { code: "not_found" }, outcome: "dropped" });
  });
});

describe("a delivery event (K-12 'Delivery events'; arch 02 line 127: Resend's delivered on email arms the clock)", () => {
  it("delivered.json reaches the receipt door as its K-06 event with the Message-ID beside it, never the actor's inbox", async () => {
    const log = captureLog();
    const world = worldAt(delivered.given.now);
    const receivedAt = receivedAtOf(delivered.given.now);

    const response = await sendFixture(world, delivered);

    expect(response.status).toBe(200);
    const traceId = response.headers.get("x-trace-id");
    const answer = await response.text();
    // Not the inbox: the actor is never called, no key is asked, and nothing is read from Resend.
    expect(world.actor.calls).toHaveLength(0);
    expect(world.keys.asked).toHaveLength(0);
    expect(world.port.reads).toHaveLength(0);
    expect(world.receipts.written).toEqual([
      {
        event: { ...delivered.outcome.event, receivedAt, traceId },
        partKey: null,
        traceId,
        bundleId: { hash: "a".repeat(64), build: 1 },
        rfcMessageId: delivered.outcome.rfcMessageId,
      },
    ]);
    const spans = log.spans();
    expect(spans.map((span) => span.hop)).toEqual(["receive"]);
    expect(spans[0]).toMatchObject({
      provider: "resend",
      event_id: "evt-email-delivered-0007",
      outcome: "ok",
      got: { kind: "delivered", service: "email" },
      decided: { signatureValid: true, knownEventId: false, answered: 200 },
    });
    expect(spanProblems(spans[0])).toEqual([]);
    const seen = log.text() + answer;
    for (const secret of [ALEX, "rfc-demo-0007", "Barbershop", "mail.rosfield.com"]) {
      expect(seen).not.toContain(secret);
    }
  });

  it("through the dispatcher's receipt handler, as the composition root builds the receipt door: the part is marked delivered and clock arming is told once", async () => {
    captureLog();
    const world = worldAt(delivered.given.now);
    const marks: MarkPartRequest[] = [];
    const armed: PartDelivered[] = [];
    const notUsed = (): Promise<never> => Promise.reject(new Error("a receipt makes no such call"));
    const delivereds = new Set<string>();
    // K-05 markPart delivered as its fixtures state: found by the provider's message id, first delivery once, then repeated.
    const store: OutboxStore = {
      markRow: notUsed,
      claimOutbox: notUsed,
      renewClaim: notUsed,
      markPart(request) {
        marks.push(request);
        const repeated = delivereds.has(request.providerMessageId ?? "");
        delivereds.add(request.providerMessageId ?? "");
        return Promise.resolve({
          result: "marked",
          outboxRowId: "out-a7-03-alex-email",
          partNo: 1,
          tryNo: 1,
          attempts: 1,
          repeated,
          firstDelivery: !repeated,
          openQuestionId: "oq-a7-03-alex",
          nextKey: null,
        });
      },
    };
    // The receipt door of runtime/src/wiring/root.ts, over this store and a clock arming that notes what it is told.
    const receipts: ReceiptSink = {
      async accept(handoff) {
        const status = handoff.event.status as { messageId: string; at: string };
        const trace = openTrace({
          openedBy: "textWebhook",
          bundleId: handoff.bundleId,
          incomingTraceId: handoff.traceId,
          sink: logSink(WHERE),
          now: () => Date.parse(delivered.given.now),
        });
        const result = await handleDeliveryReceipt(
          {
            store,
            clockArming: {
              partDelivered(part) {
                armed.push(part);
                return Promise.resolve();
              },
            },
            trace,
          },
          { providerMessageId: status.messageId, partKey: handoff.partKey, at: status.at },
        );
        if (result.result === "storeError") throw new Error("the outbox store gave no answer");
        return result.result === "repeated" ? "duplicate" : "written";
      },
    };
    const deps = { ...world.deps, receipts };

    const first = await sendFixture(world, delivered, deps);
    const again = await sendFixture(world, delivered, deps);

    expect([first.status, again.status]).toEqual([200, 200]);
    // Found by Resend's id for the email (K-07's providerMessageId), with no part key: K-12 echoes none.
    expect(marks).toEqual([
      { outcome: "delivered", providerMessageId: "email-msg-demo-0007", at: "2026-10-23T14:05:09Z" },
      { outcome: "delivered", providerMessageId: "email-msg-demo-0007", at: "2026-10-23T14:05:09Z" },
    ]);
    // Clock arming, once, at the receipt's own time; and never the inbox.
    expect(armed).toEqual([
      {
        outboxRowId: "out-a7-03-alex-email",
        partNo: 1,
        tryNo: 1,
        firstDelivery: true,
        openQuestionId: "oq-a7-03-alex",
        deliveredAt: "2026-10-23T14:05:09Z",
      },
    ]);
    expect(world.actor.calls).toHaveLength(0);
    expect(world.keys.asked).toHaveLength(0);
  });

  it("bounced.json reaches the receipt door as a failed event (the channel fallback's), never the actor", async () => {
    captureLog();
    const world = worldAt(bounced.given.now);

    const response = await sendFixture(world, bounced);

    expect(response.status).toBe(200);
    expect(world.actor.calls).toHaveLength(0);
    expect(world.receipts.written).toHaveLength(1);
    expect(world.receipts.written[0]).toMatchObject({
      event: { kind: "failed", status: bounced.outcome.event.status },
      partKey: null,
      rfcMessageId: bounced.outcome.rfcMessageId,
    });
  });

  it("a signed type Rosie does not use (verify-ignored-delivery-delayed.json) is 200 and handed on to no one", async () => {
    const log = captureLog();
    const world = worldAt(ignoredDelayed.given.now);

    const response = await sendFixture(world, ignoredDelayed);

    expect(response.status).toBe(200);
    expect(world.actor.calls).toHaveLength(0);
    expect(world.receipts.calls).toHaveLength(0);
    expect(world.port.reads).toHaveLength(0);
    expect(log.spans()).toHaveLength(1);
    expect(log.spans()[0]).toMatchObject({
      outcome: "dropped",
      got: { eventType: "email.delivery_delayed" },
      decided: { signatureValid: true, ignoredType: true, answered: 200 },
    });
    expect(log.spans()[0]).not.toHaveProperty("event_id");
  });
});

describe("a bad signature gets 401 (arch 02 line 109: 'Bad signature: 401, dropped')", () => {
  /** Nothing was read from Resend, no key asked, nothing handed to either door. */
  function expectNothingDone(world: World): void {
    expect(world.port.reads).toHaveLength(0);
    expect(world.keys.asked).toHaveLength(0);
    expect(world.actor.calls).toHaveLength(0);
    expect(world.receipts.calls).toHaveLength(0);
  }

  it("verify-bad-signature.json (one byte changed): 401, the reply never read, nothing written", async () => {
    const log = captureLog();
    const world = worldAt(badSignature.given.now);

    const response = await sendFixture(world, badSignature);

    expect(response.status).toBe(401);
    const traceId = response.headers.get("x-trace-id");
    expect(traceId).toMatch(UUID);
    expect(await response.json()).toEqual({ ok: false, error: "unauthorized", trace_id: traceId });
    expect(world.port.verified).toHaveLength(1);
    expectNothingDone(world);
    const spans = log.spans();
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      hop: "receive",
      provider: "resend",
      outcome: "refused",
      error_code: "badSignature",
      decided: { signatureValid: false, answered: 401 },
    });
    expect(spans[0]).not.toHaveProperty("event_id");
    expect(spanProblems(spans[0])).toEqual([]);
  });

  it("a webhook signed under another secret: 401, for a reply and for a delivery event alike", async () => {
    captureLog();
    const world = worldAt(delivered.given.now);
    const stranger = emailDouble(OTHER_TEST_WEBHOOK_SECRET);
    const receipt = await signedFixture(stranger, delivered);
    const replyWorld = worldAt(replyPassed.given.now);
    const reply = await signedReply(stranger, replyPassed.outcome.event);

    const first = await handleResendWebhook(resendRequest(receipt), world.deps, WHERE);
    const second = await handleResendWebhook(resendRequest(reply), replyWorld.deps, WHERE);

    expect([first.status, second.status]).toEqual([401, 401]);
    expectNothingDone(world);
    expectNothingDone(replyWorld);
  });

  it("a good signature over another body (the body changed after signing): 401", async () => {
    captureLog();
    const world = worldAt(delivered.given.now);
    const webhook = await signedFixture(world.double, delivered);

    const response = await handleResendWebhook(
      resendRequest({ ...webhook, raw: webhook.raw.replace("alex@example.com", "mallory@example.com") }),
      world.deps,
      WHERE,
    );

    expect(response.status).toBe(401);
    expectNothingDone(world);
  });

  it("odd headers are refused by the door itself before any HMAC: 401, the verify call never asked", async () => {
    const log = captureLog();
    const world = worldAt(delivered.given.now);
    const webhook = await signedFixture(world.double, delivered);
    const stale = String(Number(webhook.timestamp) - 302);
    const many = Array.from({ length: EMAIL_MAX_SIGNATURE_ENTRIES + 1 }, () => webhook.signature).join(" ");
    const odd: [string, Parameters<typeof resendRequest>[0]][] = [
      ["badSignature", { ...webhook, signature: null }],
      ["badSignature", { ...webhook, webhookId: null }],
      ["badSignature", { ...webhook, signature: webhook.signature.replace("v1,", "") }],
      ["badSignature", { ...webhook, signature: many }],
      ["badTimestamp", { ...webhook, timestamp: null }],
      ["badTimestamp", { ...webhook, timestamp: `${webhook.timestamp}.5` }],
      ["staleTimestamp", { ...webhook, timestamp: stale }],
    ];

    const statuses: number[] = [];
    for (const [, sent] of odd) {
      statuses.push((await handleResendWebhook(resendRequest(sent), world.deps, WHERE)).status);
    }

    expect(statuses).toEqual(odd.map(() => 401));
    expect(world.port.verified).toHaveLength(0);
    expectNothingDone(world);
    expect(log.spans().map((span) => span.error_code)).toEqual(odd.map(([reason]) => reason));
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])(
    "a clock that reads %s cannot measure the window: 401, the verify call never asked",
    async (_name, reading) => {
      captureLog();
      const world = worldAt(delivered.given.now);
      const webhook = await signedFixture(world.double, delivered);

      const response = await handleResendWebhook(
        resendRequest(webhook),
        { ...world.deps, now: () => reading },
        WHERE,
      );

      expect(response.status).toBe(401);
      expect(world.port.verified).toHaveLength(0);
      expectNothingDone(world);
    },
  );

  it("never keeps the request's own x-trace-id: the trace is opened at receipt", async () => {
    captureLog();
    const world = worldAt(delivered.given.now);
    const incoming = "11111111-2222-4333-8444-555555555555";
    const request = resendRequest(await signedFixture(world.double, delivered));
    request.headers.set("x-trace-id", incoming);

    const response = await handleResendWebhook(request, world.deps, WHERE);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-trace-id")).not.toBe(incoming);
    expect(world.receipts.written[0]?.traceId).toBe(response.headers.get("x-trace-id"));
  });
});

describe("a failure answers 503 with nothing stored, so Resend sends it again", () => {
  it("a verify call that cannot answer (an unset secret, the adapter down)", async () => {
    const log = captureLog();
    const world = worldAt(delivered.given.now);
    const down: EmailPort = {
      ...world.port,
      verifyWebhook: () => Promise.reject(new Error("no secret is set")),
    };

    const response = await sendFixture(world, delivered, { ...world.deps, email: down });

    expect(response.status).toBe(503);
    expect(world.receipts.calls).toHaveLength(0);
    expect(log.spans()[0]).toMatchObject({ outcome: "failed", error_code: "verifyUnavailable" });
  });

  it("a read that cannot answer (no key that reads received email: K-12 open gap 1)", async () => {
    const log = captureLog();
    const world = worldAt(replyPassed.given.now);
    const down: EmailPort = { ...world.port, readReply: () => Promise.reject(new Error("no receiving key")) };

    const response = await sendReply(world, replyPassed.outcome.event, {}, { ...world.deps, email: down });

    expect(response.status).toBe(503);
    expect(world.actor.calls).toHaveLength(0);
    expect(world.keys.asked).toHaveLength(0);
    expect(log.spans().map((span) => [span.hop, span.outcome, span.error_code])).toEqual([
      ["receive", "failed", "readUnavailable"],
      ["portCall", "failed", "readUnavailable"],
    ]);
  });

  const event = delivered.outcome.event;
  const id = delivered.request.webhookId;
  it.each<[string, unknown, string]>([
    ["a result K-12 v1 does not have", { result: "verified", httpStatus: 200 }, "unknownVerifyResult"],
    ["no answer object", null, "unknownVerifyResult"],
    [
      "a delivery event under another id than the webhook's",
      { result: "event", httpStatus: 200, event: { ...event, eventId: "evt-other" }, rfcMessageId: null },
      "badVerifyAnswer",
    ],
    [
      "a text handed back by the verify itself, which only a read may give",
      {
        result: "event",
        httpStatus: 200,
        event: { ...replyPassed.outcome.event, eventId: id },
        rfcMessageId: null,
      },
      "badVerifyAnswer",
    ],
    [
      "a delivery event for a phone handle",
      {
        result: "event",
        httpStatus: 200,
        event: { ...event, handle: { kind: "phone", address: "+15555550100" } },
        rfcMessageId: null,
      },
      "badVerifyAnswer",
    ],
    [
      "a delivery event of another provider",
      { result: "event", httpStatus: 200, event: { ...event, provider: "linq" }, rfcMessageId: null },
      "badVerifyAnswer",
    ],
    [
      "a Message-ID that is not text",
      { result: "event", httpStatus: 200, event, rfcMessageId: 7 },
      "badVerifyAnswer",
    ],
    [
      "a reply under another id than the webhook's",
      {
        result: "reply",
        eventId: "evt-other",
        receivedEmailId: "resend-in-demo-alex-0001",
        replyAddress: REPLY_ADDRESS,
      },
      "badVerifyAnswer",
    ],
    [
      "a reply with no email to read",
      { result: "reply", eventId: id, replyAddress: REPLY_ADDRESS },
      "badVerifyAnswer",
    ],
  ])("a verify answer off the contract: %s", async (_name, answer, code) => {
    const log = captureLog();
    const world = worldAt(delivered.given.now);
    const odd = { ...world.port, verifyWebhook: () => Promise.resolve(answer) } as unknown as EmailPort;

    const response = await sendFixture(world, delivered, { ...world.deps, email: odd });

    expect(response.status).toBe(503);
    expect(world.port.reads).toHaveLength(0);
    expect(world.actor.calls).toHaveLength(0);
    expect(world.receipts.calls).toHaveLength(0);
    expect(log.spans()[0]).toMatchObject({ outcome: "failed", error_code: code });
  });

  const reply = replyPassed.outcome.event;
  it.each<[string, (answer: Json) => unknown, string]>([
    ["a result K-12 v1 does not have", () => ({ result: "queued", httpStatus: 200 }), "unknownReadResult"],
    ["no answer object", () => null, "unknownReadResult"],
    [
      "a reply under another id than the webhook's",
      (answer) => ({ ...answer, event: { ...reply, eventId: "evt-other" } }),
      "badReadAnswer",
    ],
    [
      "a reply from a phone handle, which would name a phone's actor",
      (answer) => ({ ...answer, event: { ...reply, handle: { kind: "phone", address: "+15555550100" } } }),
      "badReadAnswer",
    ],
    [
      "a receipt handed back by the read",
      (answer) => ({ ...answer, event: { ...reply, kind: "delivered" } }),
      "badReadAnswer",
    ],
    [
      "a reply without its reply fields, so with no sender check to read",
      (answer) => ({ ...answer, event: { ...reply, email: null } }),
      "badReadAnswer",
    ],
    ["a failure of a kind K-12 does not have", () => ({ result: "failed", kind: "later" }), "badReadAnswer"],
  ])("a read answer off the contract: %s", async (_name, change, code) => {
    const log = captureLog();
    const world = worldAt(replyPassed.given.now);
    const odd = emailPortOf(world.double, change);

    const response = await sendReply(world, reply, {}, { ...world.deps, email: odd });

    expect(response.status).toBe(503);
    expect(world.actor.calls).toHaveLength(0);
    expect(world.receipts.calls).toHaveLength(0);
    expect(world.keys.asked).toHaveLength(0);
    expect(log.spans()[0]).toMatchObject({
      outcome: "failed",
      error_code: code,
      decided: { signatureValid: true, answered: 503 },
    });
  });

  it("a key store that gives no key: nothing is sealed or written", async () => {
    const log = captureLog();
    const world = worldAt(replyPassed.given.now);
    const keys = { getOrCreateKey: () => Promise.reject(new Error(`${CARD} no key`)) };

    const response = await sendReply(world, reply, {}, { ...world.deps, keys });

    expect(response.status).toBe(503);
    expect(world.actor.calls).toHaveLength(0);
    expect(log.spans()[0]).toMatchObject({ outcome: "failed", error_code: "sealFailed" });
    // A failure is logged by its stage and the error's name only: its message could carry words.
    expect(log.text()).not.toContain(CARD);
  });

  it("a failing actor write, then Resend's retry: 503, then written once, whole", async () => {
    captureLog();
    const world = worldAt(replyPassed.given.now);
    const webhook = await signedReply(world.double, reply);
    world.actor.failNext.push(new Error("storage failed"));

    const failedOnce = await handleResendWebhook(resendRequest(webhook), world.deps, WHERE);
    const retried = await handleResendWebhook(resendRequest(webhook), world.deps, WHERE);

    expect([failedOnce.status, retried.status]).toEqual([503, 200]);
    expect(world.actor.written).toHaveLength(1);
    expect(await unsealed(present(world.actor.written[0], "the hand-off"), world.keys)).toMatchObject({
      body: reply.body,
    });
  });

  it("an answer other than written or duplicate from a door is a failed write, never 200", async () => {
    captureLog();
    const world = worldAt(replyPassed.given.now);
    world.actor.failNext.push("queued" as unknown as "written");

    const response = await sendReply(world, reply);

    expect(response.status).toBe(503);
  });

  it("a failing receipt door: 503, so the receipt is not lost", async () => {
    const log = captureLog();
    const world = worldAt(delivered.given.now);
    world.receipts.failNext.push(new Error("the outbox store gave no answer"));

    const failedOnce = await sendFixture(world, delivered);
    const retried = await sendFixture(world, delivered);

    expect([failedOnce.status, retried.status]).toEqual([503, 200]);
    expect(world.receipts.written).toHaveLength(1);
    expect(log.spans()[0]).toMatchObject({
      outcome: "failed",
      error_code: "handoffFailed",
      decided: { signatureValid: true, answered: 503 },
    });
  });

  it("a body that cannot be read: 400, nothing verified", async () => {
    captureLog();
    const world = worldAt(delivered.given.now);
    const webhook = await signedFixture(world.double, delivered);
    const broken = new ReadableStream({
      start(controller) {
        controller.error(new Error("the connection dropped"));
      },
    });
    const request = new Request(resendRequest(webhook).url, {
      method: "POST",
      headers: resendRequest(webhook).headers,
      body: broken,
    });

    const response = await handleResendWebhook(request, world.deps, WHERE);

    expect(response.status).toBe(400);
    expect(world.port.verified).toHaveLength(0);
  });
});

describe("a body over the door's cap", () => {
  it("is answered 413 before any signature check, with nothing verified, read or handed on", async () => {
    const log = captureLog();
    const world = worldAt(delivered.given.now);
    const webhook = await signedFixture(world.double, delivered);

    const response = await handleResendWebhook(
      resendRequest({ ...webhook, signature: null, raw: "x".repeat(EMAIL_BODY_LIMIT_BYTES + 1) }),
      world.deps,
      WHERE,
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ ok: false, error: "payload_too_large" });
    expect(world.port.verified).toHaveLength(0);
    expect(world.receipts.calls).toHaveLength(0);
    expect(log.spans()[0]).toMatchObject({
      provider: "resend",
      outcome: "refused",
      error_code: "bodyTooLarge",
    });
    expect(spanProblems(log.spans()[0])).toEqual([]);
  });

  it("its cap is its own config value, and a mistyped value leaves the default", async () => {
    captureLog();
    const size = new TextEncoder().encode(delivered.request.raw).byteLength;
    const answer = async (emailBodyLimitBytes: number): Promise<number> => {
      const world = worldAt(delivered.given.now);
      return (await sendFixture(world, delivered, { ...world.deps, emailBodyLimitBytes })).status;
    };

    expect(await answer(size - 1)).toBe(413);
    expect(await answer(size)).toBe(200);
    expect(await answer(Number.NaN)).toBe(200);
    expect(await answer(-1)).toBe(200);
  });
});

describe("the Worker's route: POST {BASE_PATH}/webhooks/resend", () => {
  const context = createExecutionContext();

  afterEach(() => {
    unwireWorker();
  });

  it("is closed until a root binds the email port: a signed webhook is 503, with nothing read or handed on", async () => {
    const log = captureLog();
    const world = worldAt(delivered.given.now);
    const webhook = await signedFixture(world.double, delivered);
    // The gateway's doors as the root binds them for the Linq entry, and no email port.
    const closed = createWorker(() => ({
      ...unconfiguredGateway(),
      actor: world.actor,
      receipts: world.receipts,
      keys: world.keys,
      now: () => Date.parse(delivered.given.now),
      email: unconfiguredEmail(),
    }));
    const leftOut = createWorker(() => ({
      linq: unconfiguredGateway().linq,
      actor: world.actor,
      receipts: world.receipts,
      keys: world.keys,
      bundleId: () => ({ hash: "a".repeat(64), build: 1 }),
      now: () => Date.parse(delivered.given.now),
    }));

    const answers = [
      await closed.fetch(resendRequest(webhook), env, context),
      await leftOut.fetch(resendRequest(webhook), env, context),
    ];

    expect(answers.map((response) => response.status)).toEqual([503, 503]);
    expect(await answers[0]?.json()).toMatchObject({ ok: false, error: "unavailable" });
    expect(world.actor.calls).toHaveLength(0);
    expect(world.receipts.calls).toHaveLength(0);
    expect(log.spans().map((span) => span.error_code)).toEqual(["verifyUnavailable", "verifyUnavailable"]);
  });

  it("the Worker as it is deployed binds no email port, on staging and on production: 503 for a webhook that looks signed, 401 for one that does not, 405 for a GET", async () => {
    captureLog();
    const world = worldAt(delivered.given.now);
    const webhook = await signedFixture(world.double, delivered);
    // Signed now, so it is inside the window on the Worker's own clock.
    const fresh = await world.double.signRaw({
      webhookId: delivered.request.webhookId,
      raw: delivered.request.raw,
      receivedAt: new Date().toISOString(),
      traceId: delivered.request.traceId,
    });
    const production = { ...env, ENVIRONMENT: "production", BASE_PATH: "" };
    const deployed = createWorker((vars) => workerRoot(vars).gateway);

    const staging = await worker.fetch(resendRequest(fresh), env, context);
    const live = await deployed.fetch(resendRequest(fresh, "/webhooks/resend"), production, context);
    const stale = await worker.fetch(resendRequest(webhook), env, context);
    const get = await worker.fetch(new Request("https://rosie.test/test/webhooks/resend"), env, context);

    expect(staging.status).toBe(503);
    expect(staging.headers.get("x-trace-id")).toMatch(UUID);
    expect(live.status).toBe(503);
    // The fixture's own timestamp is long past on the real clock: refused by the door before any verify.
    expect(stale.status).toBe(401);
    expect(get.status).toBe(405);
    expect(await get.json()).toMatchObject({ ok: false, error: "method_not_allowed" });
  });

  it("with the email port bound, the route hands a reply to the actor and a delivery event to the receipt door, and GatewayDeps carries the cap", async () => {
    captureLog();
    const world = worldAt(replyPassed.given.now);
    const bound = (now: string, emailBodyLimitBytes?: number) =>
      createWorker(() => ({
        ...unconfiguredGateway(),
        email: world.port,
        actor: world.actor,
        receipts: world.receipts,
        keys: world.keys,
        now: () => Date.parse(now),
        ...(emailBodyLimitBytes === undefined ? {} : { emailBodyLimitBytes }),
      }));
    const reply = await signedReply(world.double, replyPassed.outcome.event);
    const receipt = await signedFixture(world.double, delivered);

    const replied = await bound(replyPassed.given.now).fetch(resendRequest(reply), env, context);
    const received = await bound(delivered.given.now).fetch(resendRequest(receipt), env, context);
    const capped = await bound(delivered.given.now, 64).fetch(resendRequest(receipt), env, context);
    const elsewhere = await bound(delivered.given.now).fetch(
      resendRequest(receipt, "/webhooks/resend"),
      env,
      context,
    );

    expect([replied.status, received.status, capped.status]).toEqual([200, 200, 413]);
    expect(world.actor.written.map((handoff) => handoff.event.eventId)).toEqual(["evt-email-alex-0001"]);
    expect(world.receipts.written.map((handoff) => handoff.event.eventId)).toEqual([
      "evt-email-delivered-0007",
    ]);
    // The route is under BASE_PATH (/test on staging): the bare path is the Worker's 404.
    expect(elsewhere.status).toBe(404);
  });
});
