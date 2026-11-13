// K-08's scrub hop at the gateway (T-1096; C-044; K-08 v1 hop `scrub`; arch 02 line 109: "Before any write it swaps card
// numbers ... and Social Security numbers for a tag"), run inside the Workers runtime. A webhook whose event its actor
// writes shows receive, then scrub, then the hand-off: receive is seq 1 and starts first, scrub is seq 2 and ends before
// the event reaches its door, each span valid against K-08 v1 (runtime/src/trace's code form of its span definition), and
// T-465's hop checker (tests/e2e/_driver/hops.ts) passes the two as the walking skeleton's first hops. The scrub span holds
// counts only: a text holding a test card number gives cardNumbersTagged 1 and no digit of the number. Every other answer
// ends the trace at receive. The Linq port is a double answering one K-06 fixture's event, the key store is the fake, and
// the doors are stubs that note when the event reached them. Test values only: the public test cards and the printed
// sample Social Security number (rule 9).
import { afterEach, describe, expect, it, vi } from "vitest";

import traceDuplicate from "../../../contracts/event-trace/fixtures/trace-duplicate-webhook.json";
import traceSkeleton from "../../../contracts/event-trace/fixtures/trace-skeleton.json";
import delivered from "../../../contracts/inbound-event/fixtures/delivered.json";
import refuseCard from "../../../contracts/inbound-event/fixtures/invalid/refuse-unscrubbed-card.json";
import refuseSsn from "../../../contracts/inbound-event/fixtures/invalid/refuse-unscrubbed-ssn.json";
import cardNumber from "../../../contracts/inbound-event/fixtures/text-with-card-number.json";
import textImessage from "../../../contracts/inbound-event/fixtures/text-imessage.json";
import { SKELETON_HOPS, checkHops, readReceipt } from "../../../tests/e2e/_driver/hops";
import { spanProblems, type Span, type Trace } from "../trace";
import { hopsOfTrace, leaks, spansOfLogLines, spansOfTrace } from "../trace/hop-check";
import { handleLinqWebhook } from "./linq-webhook";
import { openWords, type SealingKeyStore } from "./seal";
import { fakeKeyStore, present, type FakeKeyStore } from "./test-support";
import type {
  ActorHandoff,
  ActorStub,
  GatewayDeps,
  InboundEvent,
  LinqPort,
  ReceiptSink,
  SealedHandoff,
  StoreAnswer,
} from "./types";

type Json = Record<string, unknown>;

/** A K-08 v1 trace document as T-465's checker reads it (the contract's generated type). */
type K08Trace = Parameters<typeof checkHops>[0];

const WHERE = { environment: "staging", version: "test-sha" };
const START = Date.parse("2026-10-12T16:20:01Z");

const SKELETON = traceSkeleton as unknown as Trace;
const DUPLICATE = traceDuplicate as unknown as Trace;

/** The gateway's hops of the walking skeleton, by T-465's list: up to and including scrub. */
const GATEWAY_HOPS = SKELETON_HOPS.slice(0, SKELETON_HOPS.indexOf("scrub") + 1);

/** The whole test card number refuse-unscrubbed-card.json holds, spaced as the text holds it. */
const CARD = "4242 4242 4242 4242";

/** A clock that moves on 1 ms each time it is read, so each step the gateway times has an instant of its own. */
function steppingClock(): () => number {
  let tick = 0;
  return () => {
    tick += 1;
    return START + tick;
  };
}

interface Log {
  /** The spans written so far, in the order they were written. */
  spans(): Span[];
  /** Every log line written so far, as one string. */
  text(): string;
}

function captureLog(): Log {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  return {
    spans: () => spansOfLogLines(log.mock.calls.map((call: unknown[]) => call[0])),
    text: () => JSON.stringify(log.mock.calls),
  };
}

function webhook(): Request {
  return new Request("https://rosie.test/test/webhooks/linq", {
    method: "POST",
    headers: { "webhook-id": "w", "webhook-timestamp": "1", "webhook-signature": "s" },
    body: "{}",
  });
}

/** The K-11 double: verifies any webhook as `event`, carrying the trace id the gateway opened. */
function verifying(event: Json, partKey: string | null = null): LinqPort {
  return {
    verifyWebhook: (request) =>
      Promise.resolve({
        result: "event",
        httpStatus: 200,
        event: { ...event, traceId: request.traceId } as InboundEvent,
        partKey,
      }),
  };
}

const rejecting: LinqPort = {
  verifyWebhook: () => Promise.resolve({ result: "rejected", httpStatus: 401, reason: "badSignature" }),
};

interface Reached<T> {
  readonly handoff: T;
  /** The clock's reading when the event reached the door. */
  readonly at: number;
}

interface Doors {
  readonly actor: ActorStub & { readonly reached: Reached<SealedHandoff>[] };
  readonly receipts: ReceiptSink & { readonly reached: Reached<ActorHandoff>[] };
  readonly keys: FakeKeyStore;
}

/** Doors that note each hand-off and when it came, and answer `answer` (a thrown write for an Error). */
function doors(now: () => number, answer: StoreAnswer | Error = "written"): Doors {
  const reply = (): Promise<StoreAnswer> =>
    answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  const actorReached: Reached<SealedHandoff>[] = [];
  const receiptsReached: Reached<ActorHandoff>[] = [];
  return {
    actor: {
      reached: actorReached,
      accept(handoff) {
        actorReached.push({ handoff, at: now() });
        return reply();
      },
    },
    receipts: {
      reached: receiptsReached,
      accept(handoff) {
        receiptsReached.push({ handoff, at: now() });
        return reply();
      },
    },
    keys: fakeKeyStore(),
  };
}

function depsOf(
  linq: LinqPort,
  d: Doors,
  now: (() => number) | undefined,
  keys: SealingKeyStore = d.keys,
): GatewayDeps {
  return {
    linq,
    actor: d.actor,
    receipts: d.receipts,
    keys,
    bundleId: () => ({ hash: "a".repeat(64), build: 1 }),
    ...(now === undefined ? {} : { now }),
  };
}

/** One webhook through the gateway: its answer, its trace id and that trace's spans, by when each started. */
async function send(
  deps: GatewayDeps,
  log: Log,
): Promise<{ status: number; traceId: string; trace: Span[] }> {
  const response = await handleLinqWebhook(webhook(), deps, WHERE);
  const traceId = present(response.headers.get("x-trace-id"), "the answer's x-trace-id");
  return { status: response.status, traceId, trace: spansOfTrace(log.spans(), traceId) };
}

/** The spans of one trace as K-08 v1's trace document, in seq order, opened by a text's webhook. */
function k08Trace(spans: readonly Span[]): K08Trace {
  const [first, ...rest] = [...spans].sort((a, b) => a.seq - b.seq);
  const head = present(first, "the trace's first span");
  return {
    trace_id: head.trace_id,
    opened_by: "textWebhook",
    bundle_id: head.bundle_id,
    turn_id: null,
    job_id: null,
    handle_ref: null,
    joined_trace_ids: [],
    spans: [head, ...rest],
  };
}

/** Every string a value holds, at any depth. */
function stringsIn(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value as unknown[]) stringsIn(item, into);
  else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value as Json)) stringsIn(item, into);
  }
  return into;
}

function scrubOf(trace: readonly Span[]): Span {
  return present(
    trace.find((span) => span.hop === "scrub"),
    "the scrub span",
  );
}

const startOf = (span: Span): number => Date.parse(span.at);
const endOf = (span: Span): number => Date.parse(span.at) + span.ms;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a text its actor writes: receive, then scrub, then the hand-off", () => {
  it("receive is seq 1 and starts first; scrub is seq 2, ends before the hand-off, and holds K-08's two counts", async () => {
    const log = captureLog();
    const now = steppingClock();
    const d = doors(now);

    const { status, traceId, trace } = await send(depsOf(verifying(textImessage), d, now), log);

    expect(status).toBe(200);
    expect(trace.map((span) => [span.hop, span.seq])).toEqual([
      ["receive", 1],
      ["scrub", 2],
    ]);
    expect(trace.flatMap((span) => spanProblems(span))).toEqual([]);
    const [receive, scrub] = trace;
    if (receive === undefined || scrub === undefined) throw new Error("two spans");
    expect(scrub).toEqual({
      trace_id: traceId,
      span_id: expect.any(String) as string,
      seq: 2,
      hop: "scrub",
      at: expect.any(String) as string,
      ms: expect.any(Number) as number,
      bundle_id: receive.bundle_id,
      turn_id: null,
      handle_ref: null,
      event_id: "evt-alex-0001",
      decided: { cardNumbersTagged: 0, ssnsTagged: 0 },
      outcome: "ok",
      error_code: null,
    });
    expect(receive).toMatchObject({ outcome: "ok", event_id: "evt-alex-0001", provider: "linq" });

    // The hand-off came after the scrub ended and before receive's answer, under the same trace id.
    const handoff = present(d.actor.reached[0], "the hand-off");
    expect(d.actor.reached).toHaveLength(1);
    expect(handoff.handoff.traceId).toBe(traceId);
    expect(handoff.handoff.event.traceId).toBe(traceId);
    expect(startOf(receive)).toBeLessThan(startOf(scrub));
    expect(endOf(scrub)).toBeLessThanOrEqual(handoff.at);
    expect(handoff.at).toBeLessThanOrEqual(endOf(receive));
  });

  it("T-465's checkHops passes the gateway's spans as the skeleton's first hops, trace-skeleton.json's receive and scrub", async () => {
    const log = captureLog();
    const now = steppingClock();

    const stepped = await send(depsOf(verifying(textImessage), doors(now), now), log);
    // The Workers clock, which stands still between I/O steps: the instants are equal, the order is seq's.
    const workers = await send(depsOf(verifying(textImessage), doors(Date.now), undefined), log);

    expect(GATEWAY_HOPS).toEqual(["receive", "scrub"]);
    expect(hopsOfTrace(SKELETON).slice(0, GATEWAY_HOPS.length)).toEqual(GATEWAY_HOPS);
    for (const { traceId, trace } of [stepped, workers]) {
      const check = checkHops(k08Trace(trace), GATEWAY_HOPS);
      expect(check.problems).toEqual([]);
      expect(check.ok).toBe(true);
      expect(check.traceId).toBe(traceId);
      expect(check.hops).toEqual(GATEWAY_HOPS);
      expect(readReceipt(k08Trace(trace))).toMatchObject({
        eventId: "evt-alex-0001",
        outcome: "ok",
        droppedAtReceipt: false,
        hopsAfter: ["scrub"],
      });
    }
    // Without the scrub span the same check names the hop, as T-466's will.
    const receiveOnly = stepped.trace.filter((span) => span.hop === "receive");
    expect(checkHops(k08Trace(receiveOnly), GATEWAY_HOPS).problems).toEqual([
      { kind: "missing", hop: "scrub", message: "hop scrub is missing: every hop runs once" },
    ]);
  });
});

describe("the scrub span holds counts only, never a word or a digit", () => {
  it("a text holding a test card number: cardNumbersTagged 1, ssnsTagged 0, and no digit of the number in any span or line", async () => {
    const log = captureLog();
    const now = steppingClock();
    const d = doors(now);

    const { status, traceId, trace } = await send(depsOf(verifying(refuseCard), d, now), log);

    expect(status).toBe(200);
    const scrub = scrubOf(trace);
    expect(scrub.decided).toEqual({ cardNumbersTagged: 1, ssnsTagged: 0 });
    expect(scrub).not.toHaveProperty("got");
    // Its only strings are its ids, its hop, its start, the bundle's hash and its outcome: no fact is a string, so none
    // can carry a digit of the number.
    const allowed = [
      traceId,
      scrub.span_id,
      "scrub",
      scrub.at,
      scrub.bundle_id.hash,
      refuseCard.eventId,
      "ok",
    ];
    const strings = stringsIn(scrub);
    expect(strings).toHaveLength(allowed.length);
    expect(strings).toEqual(expect.arrayContaining(allowed));
    expect(spanProblems(scrub)).toEqual([]);

    // No span and no log line holds the number, spaced as the text holds it or run together, or the text's words. The
    // whole number only: random trace ids can hold "4242" by chance (DL-116).
    expect(refuseCard.body).toContain(CARD);
    const text = log.text();
    expect(text).not.toContain(CARD);
    expect(text).not.toContain(CARD.replaceAll(" ", ""));
    expect(leaks(log.spans(), [refuseCard.body])).toEqual([]);

    // What the actor stored is K-06's tagged text (text-with-card-number.json): the scrub the span counts is the one
    // that went before the write.
    const stored = present(d.actor.reached[0], "the hand-off").handoff;
    const words = await openWords(
      present(stored.event.sealed, "the sealed box"),
      d.keys.keyOf(refuseCard.handle),
      stored.actorName,
      stored.event.eventId,
    );
    expect(words.body).toBe(cardNumber.body);
    expect(stored.event.scrubbed).toEqual({ cards: 1, ssns: 0 });
  });

  it.each<[string, Json, Record<string, number>, readonly string[]]>([
    [
      "a Social Security number",
      refuseSsn,
      { cardNumbersTagged: 0, ssnsTagged: 1 },
      ["123-45-6789", "123456789"],
    ],
    [
      "two test cards and a Social Security number",
      {
        ...refuseCard,
        body: "Cards 4242 4242 4242 4242 and 5555 5555 5555 4444, SSN 123-45-6789",
      },
      { cardNumbersTagged: 2, ssnsTagged: 1 },
      [CARD, "4242424242424242", "5555 5555 5555 4444", "5555555555554444", "123-45-6789", "123456789"],
    ],
    [
      "an email: a Social Security number in its body and a test card in its subject",
      {
        ...refuseCard,
        provider: "email",
        handle: { kind: "email", address: "a@example.com" },
        service: "email",
        body: "It's 123-45-6789",
        email: {
          replyAddress: "booking-x@reply.example.com",
          subject: "Re: card 4242 4242 4242 4242",
          senderCheck: "passed",
        },
      },
      { cardNumbersTagged: 1, ssnsTagged: 1 },
      [CARD, "4242424242424242", "123-45-6789", "123456789", "Re: card"],
    ],
  ])(
    "%s: the counts of what was swapped, and none of it in any line",
    async (_name, event, counts, never) => {
      const log = captureLog();
      const now = steppingClock();

      const { status, trace } = await send(depsOf(verifying(event), doors(now), now), log);

      expect(status).toBe(200);
      expect(trace.map((span) => span.hop)).toEqual(["receive", "scrub"]);
      expect(scrubOf(trace).decided).toEqual(counts);
      expect(trace.flatMap((span) => spanProblems(span))).toEqual([]);
      const text = log.text();
      for (const value of never) expect(text).not.toContain(value);
    },
  );

  it("a text with a tag already in it (text-with-card-number.json): nothing more is swapped, so the count is 0", async () => {
    const log = captureLog();
    const now = steppingClock();

    const { trace } = await send(depsOf(verifying(cardNumber), doors(now), now), log);

    expect(scrubOf(trace).decided).toEqual({ cardNumbersTagged: 0, ssnsTagged: 0 });
  });
});

describe("every other answer ends the trace at receive", () => {
  it("a known event id: dropped at receipt with nothing after it, as trace-duplicate-webhook.json", async () => {
    const log = captureLog();
    const now = steppingClock();
    const d = doors(now, "duplicate");

    const { status, trace } = await send(depsOf(verifying(textImessage), d, now), log);

    expect(status).toBe(200);
    expect(d.actor.reached).toHaveLength(1);
    expect(trace.map((span) => span.hop)).toEqual(hopsOfTrace(DUPLICATE));
    expect(checkHops(k08Trace(trace), hopsOfTrace(DUPLICATE)).problems).toEqual([]);
    expect(readReceipt(k08Trace(trace))).toMatchObject({
      outcome: "dropped",
      knownEventId: true,
      droppedAtReceipt: true,
      repeatedWebhook: true,
      hopsAfter: [],
    });
  });

  it("a receipt (delivered.json) goes to the dispatcher's door with no words: its own trace is its receive", async () => {
    const log = captureLog();
    const now = steppingClock();
    const d = doors(now);

    const { status, trace } = await send(depsOf(verifying(delivered, "part-key-1"), d, now), log);

    expect(status).toBe(200);
    expect(d.receipts.reached).toHaveLength(1);
    expect(d.actor.reached).toHaveLength(0);
    expect(trace.map((span) => [span.hop, span.outcome])).toEqual([["receive", "ok"]]);
  });

  it.each<[string, (d: Doors) => SealingKeyStore, StoreAnswer | Error, string]>([
    ["a failing actor write", (d) => d.keys, new Error("actor write failed"), "handoffFailed"],
    [
      "a seal that fails (the key store throws)",
      () => ({ getOrCreateKey: () => Promise.reject(new Error("down")) }),
      "written",
      "sealFailed",
    ],
  ])("%s: 503 and the receive span alone, failed", async (_name, keysOf, answer, code) => {
    const log = captureLog();
    const now = steppingClock();
    const d = doors(now, answer);

    const { status, trace } = await send(depsOf(verifying(refuseCard), d, now, keysOf(d)), log);

    expect(status).toBe(503);
    expect(trace.map((span) => [span.hop, span.outcome, span.error_code])).toEqual([
      ["receive", "failed", code],
    ]);
    expect(log.text()).not.toContain(CARD);
  });

  it("a bad signature: 401, nothing scrubbed or handed on, the receive span alone, refused", async () => {
    const log = captureLog();
    const now = steppingClock();
    const d = doors(now);

    const { status, trace } = await send(depsOf(rejecting, d, now), log);

    expect(status).toBe(401);
    expect(d.actor.reached).toHaveLength(0);
    expect(trace.map((span) => [span.hop, span.outcome])).toEqual([["receive", "refused"]]);
  });
});
