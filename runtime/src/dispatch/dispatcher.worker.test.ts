// The outbox dispatcher's tests (T-257), run inside the Workers runtime (Vitest project "workers"), against fakes that
// answer as K-05 v1.1's and K-11 v1's fixtures state (test-support.ts). Names and values are the master's sample cast
// and fixture set v1's barber shop; phones are 555-01xx (rule 9).
import { describe, expect, it } from "vitest";

import { handleDeliveryReceipt, runDispatch, type DispatchDeps } from "./dispatcher";
import {
  FakeClock,
  FakeClockArming,
  FakeLinq,
  FakeOutboxStore,
  FakeRecipients,
  traceCollector,
  words,
  type SeedRow,
} from "./test-support";
import { openTrace, type Span } from "../trace";
import type { CalendarFileBuilder, ChatTarget, LinqCalendarFile, PlannedSend } from "./types";

const ALEX: ChatTarget = { to: "+15555550101", chatId: "linq-chat-demo-alex", service: "imessage" };
const SAM: ChatTarget = { to: "+15555550100", chatId: "linq-chat-demo-sam", service: "imessage" };

/** A gate a test opens: it holds a run at a point until `open` is called. */
function gate(): {
  entered: Promise<void>;
  markEntered: () => void;
  released: Promise<void>;
  open: () => void;
} {
  let markEntered = (): void => undefined;
  let open = (): void => undefined;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { entered, markEntered, released, open };
}

interface Setup {
  clock: FakeClock;
  store: FakeOutboxStore;
  linq: FakeLinq;
  recipients: FakeRecipients;
  arming: FakeClockArming;
  spans: Span[];
  deps: (claimer: string) => DispatchDeps;
}

function setup(
  seeds: readonly SeedRow[],
  chats = { "handle-alex": ALEX, "handle-sam": SAM },
  start?: string,
): Setup {
  const clock = new FakeClock(start);
  const store = new FakeOutboxStore(seeds);
  const linq = new FakeLinq(clock.now);
  const recipients = new FakeRecipients(chats);
  const arming = new FakeClockArming();
  const spans: Span[] = [];
  const traceFor = traceCollector(spans);
  return {
    clock,
    store,
    linq,
    recipients,
    arming,
    spans,
    deps: (claimer) => ({ store, linq, recipients, traceFor, now: clock.now, claimer }),
  };
}

const alexRows = (count: number): SeedRow[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `out-alex-${String(index + 1)}`,
    recipient: "handle-alex",
    commitSeq: index + 1,
    sends: [words(`Alex message ${String(index + 1)}`)],
  }));

describe("one recipient's rows go in commit order", () => {
  it("sends three committed rows to the Linq fake in commit order and records each sent", async () => {
    // Seeded out of order: commit order is the database's commit_seq, not insertion order (claim-in-order.json).
    const rows = alexRows(3);
    const t = setup([...rows].reverse());

    const report = await runDispatch(t.deps("dispatcher-1"));

    expect(report.claimed).toBe(3);
    expect(report.rows.map((row) => [row.outboxRowId, row.outcome, row.partsSent])).toEqual([
      ["out-alex-1", "sent", 1],
      ["out-alex-2", "sent", 1],
      ["out-alex-3", "sent", 1],
    ]);
    expect(t.linq.requests.map((request) => request.idempotencyKey)).toEqual([
      "out-alex-1/1/1",
      "out-alex-2/1/1",
      "out-alex-3/1/1",
    ]);
    expect(t.linq.requests.map((request) => request.text)).toEqual([
      "Alex message 1",
      "Alex message 2",
      "Alex message 3",
    ]);
    // markPart sent (K-05 mark-sent.json): the key and Linq's message id, then the row is sent.
    expect(t.store.marks.map((mark) => mark.outcome)).toEqual(["sent", "sent", "sent"]);
    expect(t.store.marks[0]).toMatchObject({
      outcome: "sent",
      idempotencyKey: "out-alex-1/1/1",
      providerMessageId: "linq-msg-test-0001",
      providerOptionIds: null,
    });
    expect(rows.map((row) => t.store.row(row.id).state)).toEqual(["sent", "sent", "sent"]);
  });

  it("renews the claim before each send, the first send setting firstTryAt (renew-claim-first-send.json)", async () => {
    const t = setup(alexRows(1));
    await runDispatch(t.deps("dispatcher-1"));

    expect(
      t.store.renewals.map(({ request, answer }) => [request.idempotencyKey, request.claimNo, answer]),
    ).toEqual([["out-alex-1/1/1", 1, "renewed"]]);
    expect(t.store.row("out-alex-1").claim?.firstTryAt).toBe(t.clock.now());
  });

  it("sends a poll with its options and a link card with its link, each under its part key", async () => {
    const poll: PlannedSend = {
      kind: "poll",
      text: null,
      calendarFile: "none",
      options: ["Sat 12:00pm", "Sat 2:00pm", "Sat 3:30pm"],
      link: null,
    };
    const card: PlannedSend = {
      kind: "linkCard",
      text: "preview words that are not sent",
      calendarFile: "none",
      options: [],
      link: "https://rosie.example.com/b/booking-alex-haircut",
    };
    const t = setup([
      {
        id: "out-a7-03-alex",
        recipient: "handle-alex",
        commitSeq: 1,
        sends: [words("Which time works?"), poll],
      },
      {
        id: "out-alex-secure-link",
        recipient: "handle-alex",
        commitSeq: 2,
        sends: [words("Here is your link."), card],
      },
    ]);

    await runDispatch(t.deps("dispatcher-1"));

    const [text, pollSend, , cardSend] = t.linq.requests;
    expect(text).toMatchObject({
      kind: "words",
      to: ALEX.to,
      chatId: ALEX.chatId,
      service: "imessage",
      options: [],
    });
    expect(pollSend).toMatchObject({
      idempotencyKey: "out-a7-03-alex/2/1",
      kind: "poll",
      text: null,
      options: ["Sat 12:00pm", "Sat 2:00pm", "Sat 3:30pm"],
    });
    expect(cardSend).toMatchObject({
      idempotencyKey: "out-alex-secure-link/2/1",
      kind: "linkCard",
      text: null,
      link: "https://rosie.example.com/b/booking-alex-haircut",
    });
    // The poll's option ids go to markPart sent, in the options' order (send-poll.json).
    expect(t.store.marks[1]).toMatchObject({
      outcome: "sent",
      idempotencyKey: "out-a7-03-alex/2/1",
      providerOptionIds: ["linq-opt-test-1", "linq-opt-test-2", "linq-opt-test-3"],
    });
  });

  it("gives words a calendar file and a thread on iMessage, and words alone on a chat Linq reports as SMS", async () => {
    const file: LinqCalendarFile = {
      action: "new",
      fileName: "visit.ics",
      ics: "BEGIN:VCALENDAR\nEND:VCALENDAR",
    };
    const calendar: CalendarFileBuilder = { build: () => Promise.resolve(file) };
    const send: PlannedSend = { ...words("You're booked."), calendarFile: "new" };
    const seeds: SeedRow[] = [
      { id: "out-alex-booked", recipient: "handle-alex", commitSeq: 1, sends: [send] },
      { id: "out-sam-booked", recipient: "handle-sam", commitSeq: 2, sends: [send] },
    ];
    const t = setup(seeds, { "handle-alex": ALEX, "handle-sam": { ...SAM, service: "sms" } });

    await runDispatch({ ...t.deps("dispatcher-1"), calendar });

    const byKey = new Map(t.linq.requests.map((request) => [request.idempotencyKey, request]));
    expect(byKey.get("out-alex-booked/1/1")?.calendarFile).toEqual(file);
    expect(byKey.get("out-sam-booked/1/1")).toMatchObject({
      service: "sms",
      calendarFile: null,
      threadedReplyTo: null,
    });
  });
});

describe("a held row lets the next pass (claim-held-lets-later-pass.json)", () => {
  const evening = "2026-11-08T01:31:08.000Z";
  const seeds: SeedRow[] = [
    {
      id: "out-sam-passon-evening",
      recipient: "handle-sam",
      commitSeq: 1,
      sends: [words("Alex passed on the visit.")],
      heldUntil: "2026-11-08T13:00:00.000Z",
    },
    {
      id: "out-sam-reply-evening",
      recipient: "handle-sam",
      commitSeq: 2,
      sends: [words("Got it, Sam.")],
      sendClass: "quick_reply",
    },
  ];

  it("sends Sam's quick reply, leaves the held row for the morning and then sends it", async () => {
    const t = setup(seeds, { "handle-alex": ALEX, "handle-sam": SAM }, evening);

    const night = await runDispatch(t.deps("dispatcher-1"), { recipientHandleId: "handle-sam" });

    expect(night.passedHeld).toEqual([
      { outboxRowId: "out-sam-passon-evening", heldUntil: "2026-11-08T13:00:00.000Z" },
    ]);
    expect(night.rows.map((row) => [row.outboxRowId, row.outcome])).toEqual([
      ["out-sam-reply-evening", "sent"],
    ]);
    expect(t.linq.keysInOrder).toEqual(["out-sam-reply-evening/1/1"]);
    expect(t.store.row("out-sam-passon-evening").state).toBe("held");

    t.clock.advance(11 * 3600_000 + 30 * 60_000); // 13:01 UTC
    const morning = await runDispatch(t.deps("dispatcher-1"), { recipientHandleId: "handle-sam" });

    expect(morning.passedHeld).toEqual([]);
    expect(morning.rows.map((row) => [row.outboxRowId, row.outcome])).toEqual([
      ["out-sam-passon-evening", "sent"],
    ]);
    expect(t.linq.keysInOrder).toEqual(["out-sam-reply-evening/1/1", "out-sam-passon-evening/1/1"]);
  });
});

describe("two runs for one recipient send each part exactly once", () => {
  const keys = ["out-alex-1/1/1", "out-alex-2/1/1", "out-alex-3/1/1"];

  it("two runs started at once: the claim's lock hands each row to one run", async () => {
    const t = setup(alexRows(3));

    const [a, b] = await Promise.all([
      runDispatch(t.deps("dispatcher-1")),
      runDispatch(t.deps("dispatcher-2")),
    ]);

    expect(a.claimed + b.claimed).toBe(3);
    expect(t.linq.requests.map((request) => request.idempotencyKey)).toEqual(keys);
    expect(t.linq.accepted.size).toBe(3);
    expect(["out-alex-1", "out-alex-2", "out-alex-3"].map((id) => t.store.row(id).state)).toEqual([
      "sent",
      "sent",
      "sent",
    ]);
  });

  it("a second run that starts while the first is mid-send meets the live claim and takes nothing", async () => {
    const t = setup(alexRows(3));
    const hold = gate();
    t.linq.beforeAnswer = async (request) => {
      if (request.idempotencyKey === keys[0]) {
        hold.markEntered();
        await hold.released;
      }
    };

    const first = runDispatch(t.deps("dispatcher-1"));
    await hold.entered;
    const second = await runDispatch(t.deps("dispatcher-2"));
    hold.open();
    const done = await first;

    expect(second.claimed).toBe(0);
    expect(done.rows.map((row) => row.outcome)).toEqual(["sent", "sent", "sent"]);
    expect(t.linq.requests.map((request) => request.idempotencyKey)).toEqual(keys);
  });

  it("a run whose claim lapsed and was taken again sends nothing more: renewClaim says claimLost", async () => {
    const t = setup(alexRows(3));
    const hold = gate();
    let first = true;
    t.recipients.beforeAnswer = async () => {
      if (first) {
        first = false;
        hold.markEntered();
        await hold.released;
      }
    };

    const stalled = runDispatch(t.deps("dispatcher-1")); // claimed all three rows, then stalls
    await hold.entered;
    t.clock.advance(61_000); // its claims lapse
    const takeover = await runDispatch(t.deps("dispatcher-2"));
    hold.open();
    const resumed = await stalled;

    expect(takeover.rows.map((row) => row.outcome)).toEqual(["sent", "sent", "sent"]);
    expect(resumed.rows.map((row) => row.outcome)).toEqual(["claimLost", "notReached", "notReached"]);
    expect(t.store.row("out-alex-1").claim).toMatchObject({ claimer: "dispatcher-2", claimNo: 2 });
    expect(t.store.renewals.filter(({ answer }) => answer === "claimLost")).toHaveLength(1);
    expect(t.linq.requests.map((request) => request.idempotencyKey)).toEqual(keys);
  });

  it("a send in the air when its claim lapses goes under its one key: one message, the part recorded once", async () => {
    // Part 1 is accepted and recorded; part 2's send is held in the air past the lapse; the takeover claims the row
    // again (claim-lapsed-reclaimed.json), skips the sent part and sends part 2 under its stored key.
    const t = setup([
      {
        id: "out-a7-03-alex",
        recipient: "handle-alex",
        commitSeq: 1,
        sends: [
          words("Which time works?"),
          {
            kind: "poll",
            text: null,
            calendarFile: "none",
            options: ["Sat 12:00pm", "Sat 2:00pm"],
            link: null,
          },
        ],
      },
    ]);
    const hold = gate();
    let held = false;
    t.linq.beforeAnswer = async (request) => {
      if (request.idempotencyKey === "out-a7-03-alex/2/1" && !held) {
        held = true;
        hold.markEntered();
        await hold.released;
      }
    };

    const stalled = runDispatch(t.deps("dispatcher-1"));
    await hold.entered;
    t.clock.advance(61_000);
    const takeover = await runDispatch(t.deps("dispatcher-2"));
    hold.open();
    const resumed = await stalled;

    expect(takeover.rows).toEqual([
      { outboxRowId: "out-a7-03-alex", recipientHandleId: "handle-alex", outcome: "sent", partsSent: 1 },
    ]);
    const partOne = t.linq.requests.filter((request) => request.idempotencyKey === "out-a7-03-alex/1/1");
    const partTwo = t.linq.requests.filter((request) => request.idempotencyKey === "out-a7-03-alex/2/1");
    expect(partOne).toHaveLength(1);
    expect(partTwo).toHaveLength(2); // the one case two calls name a key: Linq answers both with one message
    expect(t.linq.accepted.size).toBe(2);
    expect(resumed.rows[0]?.outcome).toBe("sent");
    const sentMarks = t.store.marks.filter((mark) => mark.outcome === "sent");
    expect(new Set(sentMarks.map((mark) => mark.idempotencyKey)).size).toBe(2);
    expect(t.store.row("out-a7-03-alex").state).toBe("sent");
  });
});

describe("a delivery receipt marks the part delivered and hands it to clock arming", () => {
  const twoParts: SeedRow = {
    id: "out-a7-03-alex",
    recipient: "handle-alex",
    commitSeq: 1,
    openQuestionId: "question-alex-new-time",
    sends: [
      words("Which time works?"),
      { kind: "poll", text: null, calendarFile: "none", options: ["Sat 12:00pm", "Sat 2:00pm"], link: null },
    ],
  };

  function receiptDeps(t: Setup): Parameters<typeof handleDeliveryReceipt>[0] {
    const trace = openTrace({
      openedBy: "providerWebhook",
      bundleId: { hash: "0123456789abcdef".repeat(4), build: 1 },
      sink: (span) => t.spans.push(span),
    });
    return { store: t.store, clockArming: t.arming, trace };
  }

  it("marks by Linq's message id, arms on the first delivery and again for the second part, never twice for one", async () => {
    const t = setup([twoParts]);
    await runDispatch(t.deps("dispatcher-1"));
    const deps = receiptDeps(t);
    const at = "2026-11-07T15:06:40Z";

    const first = await handleDeliveryReceipt(deps, {
      providerMessageId: "linq-msg-test-0001",
      partKey: null,
      at,
    });
    const again = await handleDeliveryReceipt(deps, {
      providerMessageId: "linq-msg-test-0001",
      partKey: null,
      at,
    });
    const second = await handleDeliveryReceipt(deps, {
      providerMessageId: "linq-msg-test-0002",
      partKey: null,
      at,
    });

    expect(first).toEqual({
      result: "delivered",
      outboxRowId: "out-a7-03-alex",
      partNo: 1,
      firstDelivery: true,
    });
    expect(again).toEqual({ result: "repeated", outboxRowId: "out-a7-03-alex", partNo: 1 });
    expect(second).toEqual({
      result: "delivered",
      outboxRowId: "out-a7-03-alex",
      partNo: 2,
      firstDelivery: false,
    });
    expect(t.arming.delivered).toEqual([
      {
        outboxRowId: "out-a7-03-alex",
        partNo: 1,
        tryNo: 1,
        firstDelivery: true,
        openQuestionId: "question-alex-new-time",
        deliveredAt: at,
      },
      {
        outboxRowId: "out-a7-03-alex",
        partNo: 2,
        tryNo: 1,
        firstDelivery: false,
        openQuestionId: "question-alex-new-time",
        deliveredAt: at,
      },
    ]);
    expect(t.store.row("out-a7-03-alex").state).toBe("delivered");
  });

  it("hands nothing on for a receipt no part holds, and says so with the echoed key", async () => {
    const t = setup([twoParts]);
    await runDispatch(t.deps("dispatcher-1"));

    const result = await handleDeliveryReceipt(receiptDeps(t), {
      providerMessageId: "linq-msg-unknown",
      partKey: "out-sam-booked-riley/1/1",
      at: "2026-11-07T15:07:00Z",
    });

    expect(result).toEqual({ result: "unmatched", partKey: "out-sam-booked-riley/1/1" });
    expect(t.arming.delivered).toEqual([]);
  });
});

describe("rows for two recipients are sent independently", () => {
  it("sends both recipients at once, each in its own commit order", async () => {
    const t = setup([
      ...alexRows(2),
      { id: "out-sam-1", recipient: "handle-sam", commitSeq: 3, sends: [words("Sam message 1")] },
      { id: "out-sam-2", recipient: "handle-sam", commitSeq: 4, sends: [words("Sam message 2")] },
    ]);

    const report = await runDispatch(t.deps("dispatcher-1"));

    expect(report.rows.every((row) => row.outcome === "sent")).toBe(true);
    const keysOf = (to: string): string[] =>
      t.linq.requests.filter((request) => request.to === to).map((request) => request.idempotencyKey);
    expect(keysOf(ALEX.to)).toEqual(["out-alex-1/1/1", "out-alex-2/1/1"]);
    expect(keysOf(SAM.to)).toEqual(["out-sam-1/1/1", "out-sam-2/1/1"]);
  });

  it("one recipient's failed send stops that recipient's later rows and no one else's", async () => {
    const t = setup([
      ...alexRows(2),
      { id: "out-sam-1", recipient: "handle-sam", commitSeq: 3, sends: [words("Sam message 1")] },
    ]);
    t.linq.failures.set("out-alex-1/1/1", {
      result: "failed",
      kind: "mayStillDeliver",
      httpStatus: 500,
      code: "4006",
      reason: "Message send timed out",
      retryAfterSeconds: null,
      providerMessageId: null,
    });

    const report = await runDispatch(t.deps("dispatcher-1"));

    expect(report.rows.map((row) => [row.outboxRowId, row.outcome])).toEqual([
      ["out-alex-1", "failed"],
      ["out-alex-2", "notReached"],
      ["out-sam-1", "sent"],
    ]);
    expect(t.linq.keysInOrder).toEqual(["out-alex-1/1/1", "out-sam-1/1/1"]);
    // The failure is recorded under its key with Linq's code; the next try's key is T-258's.
    expect(t.store.marks).toContainEqual(
      expect.objectContaining({
        outcome: "failed",
        idempotencyKey: "out-alex-1/1/1",
        errorCode: "4006",
        retry: false,
      }),
    );
  });
});

describe("what stops a run before it sends", () => {
  it("sends nothing when the claim answers transient", async () => {
    const t = setup(alexRows(1));
    t.store.failNextClaim = { error: "transient", sqlstate: "40001" };

    const report = await runDispatch(t.deps("dispatcher-1"));

    expect(report).toMatchObject({ claimError: "transient", claimed: 0, rows: [] });
    expect(t.linq.requests).toEqual([]);
  });

  it("sends nothing for a recipient whose chat is not known", async () => {
    const t = setup(alexRows(1), { "handle-alex": ALEX, "handle-sam": SAM });
    const noChat = new FakeRecipients({});
    const report = await runDispatch({ ...t.deps("dispatcher-1"), recipients: noChat });

    expect(report.rows.map((row) => row.outcome)).toEqual(["noChat"]);
    expect(t.linq.requests).toEqual([]);
  });

  it("waits for a Retry-After that has not passed (renew-claim-not-yet.json) and sends nothing", async () => {
    const t = setup(alexRows(1).map((row) => ({ ...row, nextTryNotBefore: "2026-11-07T15:08:36.000Z" })));

    const report = await runDispatch(t.deps("dispatcher-1"));

    expect(report.rows.map((row) => row.outcome)).toEqual(["retryAfter"]);
    expect(t.linq.requests).toEqual([]);
    expect(t.spans.map((span) => [span.hop, span.outcome])).toEqual([["dispatch", "held"]]);
  });
});

describe("what the spans carry", () => {
  it("a dispatch span and a providerAccepted span per sent part, with no words, number or key", async () => {
    const t = setup(alexRows(2));
    await runDispatch(t.deps("dispatcher-1"));

    expect(t.spans.map((span) => [span.hop, span.outcome])).toEqual([
      ["providerAccepted", "ok"],
      ["dispatch", "ok"],
      ["providerAccepted", "ok"],
      ["dispatch", "ok"],
    ]);
    const dispatch = t.spans.find((span) => span.hop === "dispatch");
    expect(dispatch).toMatchObject({
      provider: "linq",
      call: "sendPart",
      attempt: 1,
      handle_ref: "handle-alex",
    });
    const logged = JSON.stringify(t.spans);
    expect(logged).not.toContain("+1555");
    expect(logged).not.toContain("Alex message");
  });
});
