// Limit 8's tests (T-259; C-125, C-241), run inside the Workers runtime (Vitest project "workers") through the real
// dispatcher against fakes that answer as the frozen fixtures state (K-07's outbox-held-text-hours, outbox-dropped-stopped,
// outbox-stale-recomposed, outbox-waiting-chat-withdrawn and refuse-sms-channel; K-05's mark-held-for-text-hours and
// mark-waiting-chat; K-04's seed-business-head and phone rows). Names are the master's sample cast; phones are 555-01xx
// (rule 9). New York is on EST (UTC-5) from 2026-11-01, Los Angeles on PST (UTC-8).
import { describe, expect, it } from "vitest";

import { checkTextHours, instantOfLocal } from "./text-hours";
import { runDispatch, type DispatchDeps } from "../dispatcher";
import {
  FakeClock,
  FakeLinq,
  FakeOutboxStore,
  FakeRecipients,
  FakeSendState,
  traceCollector,
  words,
  type SeedRow,
} from "../test-support";
import type { Span } from "../../trace";
import type { ChatTarget } from "../types";

const BEN: ChatTarget = { to: "+15555550102", chatId: "linq-chat-demo-ben", service: "imessage" };
const SAM: ChatTarget = { to: "+15555550100", chatId: "linq-chat-demo-sam", service: "imessage" };

/** 8:30pm on Sat Nov 7 in New York. */
const EVENING_NY = "2026-11-08T01:30:00.000Z";
/** 9am on Sun Nov 8 in New York, 8am in New York on the same day, and 7:30am. */
const NINE_NY = "2026-11-08T14:00:00.000Z";
const EIGHT_NY = "2026-11-08T13:00:00.000Z";
const SEVEN_THIRTY_NY = "2026-11-08T12:30:00.000Z";
/** 11pm on Sat Nov 7 in New York. */
const NIGHT_NY = "2026-11-08T04:00:00.000Z";

interface Setup {
  clock: FakeClock;
  store: FakeOutboxStore;
  linq: FakeLinq;
  state: FakeSendState;
  spans: Span[];
  deps: (environment?: string) => DispatchDeps;
}

function setup(seeds: readonly SeedRow[], start: string): Setup {
  const clock = new FakeClock(start);
  const store = new FakeOutboxStore(seeds);
  const linq = new FakeLinq(clock.now);
  const state = new FakeSendState();
  const spans: Span[] = [];
  const recipients = new FakeRecipients({ "handle-ben": BEN, "handle-sam": SAM });
  return {
    clock,
    store,
    linq,
    state,
    spans,
    deps: (environment = "production") => ({
      store,
      linq,
      recipients,
      sendState: state,
      environment,
      traceFor: traceCollector(spans),
      now: clock.now,
      claimer: "dispatcher-1",
      limit: 100,
    }),
  };
}

const reminder = (overrides: Partial<SeedRow> = {}): SeedRow => ({
  id: "out-ben-reminder",
  recipient: "handle-ben",
  commitSeq: 1,
  sends: [words("Reminder: your visit is Sat Nov 14, 2:00pm.")],
  ...overrides,
});

describe("hard invariant: a stopped phone gets nothing it is not owed", () => {
  /** A seeded generator (mulberry32): the same 1,000 rows on every run, so the test is never flaky. */
  function seeded(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("1,000 random routine rows to a stopped phone give zero sends (outbox-dropped-stopped.json)", async () => {
    const random = seeded(20261107);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const handles = ["handle-ben", "handle-sam", "handle-cy", "handle-dee", "handle-eli"];
    let sent = 0;
    let dropped = 0;

    // Ten batches of 100 rows, each at another hour of the day, so no hour of the day lets a row through.
    for (let batch = 0; batch < 10; batch += 1) {
      const hour = String(batch * 2 + 1).padStart(2, "0");
      const seeds: SeedRow[] = Array.from({ length: 100 }, (_, index) => ({
        id: `out-${String(batch)}-${String(index)}`,
        recipient: pick(handles),
        commitSeq: index + 1,
        sendClass: "routine",
        channel: pick(["imessage", "rcs"]),
        bookingId: random() < 0.5 ? "booking-ben-skin-fade" : null,
        sends: random() < 0.3 ? [words("First part."), words("Second part.")] : [words("One part.")],
        // Some rows read versions that have since moved, some not: stopped wins either way.
        versionsRead: [{ table: "bookings", rowId: "booking-ben-skin-fade", version: 7 }],
      }));
      const t = setup(seeds, `2026-11-10T${hour}:15:00.000Z`);
      for (const handle of handles) {
        t.state.forHandle(handle, {
          stopped: true,
          chatOpen: random() < 0.5,
          audience: pick(["customer", "owner", "team"] as const),
          currentVersions: [
            { table: "bookings", rowId: "booking-ben-skin-fade", version: random() < 0.5 ? 7 : 8 },
          ],
        });
      }
      for (let run = 0; run < 20; run += 1) {
        const report = await runDispatch(t.deps());
        sent += report.rows.reduce((total, row) => total + row.partsSent, 0);
        dropped += report.rows.filter((row) => row.outcome === "droppedStopped").length;
        if (report.claimed === 0) break;
      }
      expect(t.linq.requests).toEqual([]);
      expect(t.store.marks).toEqual([]);
    }

    expect(sent).toBe(0);
    expect(dropped).toBe(1000);
  });

  it("drops the row with markRow droppedStopped and no clock arms (outbox-dropped-stopped.json)", async () => {
    const t = setup([reminder({ openQuestionId: "oq-ben-reminder" })], "2026-11-06T19:00:04.000Z");
    t.state.forHandle("handle-ben", { stopped: true });

    const report = await runDispatch(t.deps());

    expect(report.rows.map((row) => [row.outboxRowId, row.outcome, row.partsSent])).toEqual([
      ["out-ben-reminder", "droppedStopped", 0],
    ]);
    expect(t.store.row("out-ben-reminder").state).toBe("dropped_stopped");
    expect(t.store.rowMarks.map((mark) => mark.request.outcome)).toEqual(["droppedStopped"]);
    expect(t.store.rowMarks[0]?.request).toMatchObject({ outboxRowId: "out-ben-reminder", heldUntil: null });
    expect(t.linq.requests).toEqual([]);
  });

  it("a safety line still goes, at 3am, with the opt-out override on the send", async () => {
    const t = setup(
      [reminder({ id: "out-ben-safety", sendClass: "safety", sends: [words("Safety line.")] })],
      "2026-11-10T08:00:00.000Z",
    );
    t.state.forHandle("handle-ben", { stopped: true, chatOpen: false });

    const report = await runDispatch(t.deps());

    expect(report.rows.map((row) => row.outcome)).toEqual(["sent"]);
    expect(t.linq.requests).toHaveLength(1);
    expect(t.linq.requests[0]).toMatchObject({ overrideOptout: true, text: "Safety line." });
  });

  it("a stop reply still goes, at 3am, with the opt-out override on the send", async () => {
    const t = setup(
      [
        reminder({
          id: "out-ben-stop-reply",
          sendClass: "quick_reply",
          fixedLines: ["stopReply"],
          sends: [words("Stop reply.")],
        }),
      ],
      "2026-11-10T08:00:00.000Z",
    );
    t.state.forHandle("handle-ben", { stopped: true });

    const report = await runDispatch(t.deps());

    expect(report.rows.map((row) => row.outcome)).toEqual(["sent"]);
    expect(t.linq.requests[0]).toMatchObject({ overrideOptout: true, text: "Stop reply." });
  });

  it("an ordinary same-turn reply to a stopped phone does not go", async () => {
    const t = setup([reminder({ sendClass: "quick_reply" })], NIGHT_NY);
    t.state.forHandle("handle-ben", { stopped: true });

    const report = await runDispatch(t.deps());

    expect(report.rows.map((row) => row.outcome)).toEqual(["droppedStopped"]);
    expect(t.linq.requests).toEqual([]);
  });

  it("a stop that arrives between the two parts keeps the second part back", async () => {
    const t = setup(
      [reminder({ sends: [words("First part."), words("Second part.")] })],
      "2026-11-10T16:00:00.000Z",
    );
    t.linq.beforeAnswer = (): Promise<void> => {
      t.state.forHandle("handle-ben", { stopped: true });
      return Promise.resolve();
    };

    const report = await runDispatch(t.deps());

    expect(t.linq.requests.map((request) => request.text)).toEqual(["First part."]);
    expect(report.rows.map((row) => [row.outcome, row.partsSent])).toEqual([["droppedStopped", 1]]);
  });
});

describe("a stale row is composed again, or withdrawn when its booking closed", () => {
  const read = [{ table: "bookings", rowId: "booking-alex-riley-nov14", version: 1 }];
  const seed = (): SeedRow =>
    reminder({
      id: "out-riley-new-booking",
      recipient: "handle-sam",
      bookingId: "booking-alex-riley-nov14",
      versionsRead: read,
      sends: [words("New booking: Alex M. with you. Sat Nov 14, 11:00am")],
    });

  it("recomposes: the moved booking marks it stale, the new words go on the next claim (outbox-stale-recomposed.json)", async () => {
    const t = setup([seed()], "2026-11-07T15:08:05.000Z");
    // Sam moved the visit a moment before: the booking is at version 2 now.
    t.state.forHandle("handle-sam", {
      audience: "owner",
      currentVersions: [{ table: "bookings", rowId: "booking-alex-riley-nov14", version: 2 }],
    });

    const first = await runDispatch(t.deps());

    expect(first.rows.map((row) => [row.outcome, row.partsSent])).toEqual([["stale", 0]]);
    expect(t.store.row("out-riley-new-booking").state).toBe("stale");
    expect(t.linq.requests).toEqual([]);
    // Nothing more is claimed while it waits for its new plan, and still nothing is sent.
    expect((await runDispatch(t.deps())).claimed).toBe(0);

    t.store.recompose(
      "out-riley-new-booking",
      [words("New booking: Alex M. with you. Sat Nov 14, 11:30am")],
      [{ table: "bookings", rowId: "booking-alex-riley-nov14", version: 2 }],
    );
    t.clock.advance(5000);
    const second = await runDispatch(t.deps());

    expect(second.rows.map((row) => [row.outcome, row.partsSent])).toEqual([["sent", 1]]);
    expect(t.linq.requests.map((request) => request.text)).toEqual([
      "New booking: Alex M. with you. Sat Nov 14, 11:30am",
    ]);
  });

  it("withdraws a stale row whose booking closed, and never sends it", async () => {
    const t = setup([seed()], "2026-11-07T15:08:05.000Z");
    t.state.forHandle("handle-sam", {
      audience: "owner",
      currentVersions: [{ table: "bookings", rowId: "booking-alex-riley-nov14", version: 2 }],
      closed: { booking: true, question: false },
    });

    const report = await runDispatch(t.deps());
    t.clock.advance(3_600_000);
    const later = await runDispatch(t.deps());

    expect(report.rows.map((row) => row.outcome)).toEqual(["withdrawn"]);
    expect(t.store.row("out-riley-new-booking").state).toBe("withdrawn");
    expect(later.claimed).toBe(0);
    expect(t.linq.requests).toEqual([]);
  });

  it("a read version missing from the current rows counts as changed", async () => {
    const t = setup([seed()], "2026-11-07T15:08:05.000Z");
    t.state.forHandle("handle-sam", { audience: "owner", currentVersions: [] });

    const report = await runDispatch(t.deps());

    expect(report.rows.map((row) => row.outcome)).toEqual(["stale"]);
    expect(t.linq.requests).toEqual([]);
  });

  it("sends a row whose read versions are all unchanged", async () => {
    const t = setup([seed()], "2026-11-07T15:08:05.000Z");
    t.state.forHandle("handle-sam", { audience: "owner", currentVersions: read });

    const report = await runDispatch(t.deps());

    expect(report.rows.map((row) => row.outcome)).toEqual(["sent"]);
  });
});

describe("text hours", () => {
  it("holds a routine customer row at 8:30pm to 9am next day in New York (mark-held-for-text-hours.json)", async () => {
    const t = setup([reminder()], EVENING_NY);

    const report = await runDispatch(t.deps());

    expect(report.rows.map((row) => [row.outcome, row.partsSent])).toEqual([["held", 0]]);
    expect(t.store.rowMarks[0]?.request).toMatchObject({ outcome: "held", heldUntil: NINE_NY });
    expect(t.store.row("out-ben-reminder")).toMatchObject({ state: "held", heldUntil: NINE_NY });
    expect(t.linq.requests).toEqual([]);

    // The morning claim after held_until sends it.
    t.clock.advance(12 * 3600_000 + 31 * 60_000);
    const morning = await runDispatch(t.deps());
    expect(morning.rows.map((row) => row.outcome)).toEqual(["sent"]);
  });

  it("holds a routine customer row at 8:30am too: customers start at 9am, not 8am", async () => {
    const t = setup([reminder()], "2026-11-08T13:30:00.000Z");

    const report = await runDispatch(t.deps());

    expect(report.rows.map((row) => row.outcome)).toEqual(["held"]);
    expect(t.store.rowMarks[0]?.request.heldUntil).toBe(NINE_NY);
  });

  it("holds an owner row at 7:30am to 8am (outbox-held-text-hours.json)", async () => {
    const t = setup([reminder({ recipient: "handle-sam" })], SEVEN_THIRTY_NY);
    t.state.forHandle("handle-sam", { audience: "owner" });

    const report = await runDispatch(t.deps());

    expect(report.rows.map((row) => row.outcome)).toEqual(["held"]);
    expect(t.store.rowMarks[0]?.request).toMatchObject({ outcome: "held", heldUntil: EIGHT_NY });
  });

  it("holds a team row at 8:30pm to 8am next day", async () => {
    const t = setup([reminder({ recipient: "handle-sam" })], EVENING_NY);
    t.state.forHandle("handle-sam", { audience: "team" });

    const report = await runDispatch(t.deps());

    expect(report.rows.map((row) => row.outcome)).toEqual(["held"]);
    expect(t.store.rowMarks[0]?.request.heldUntil).toBe(EIGHT_NY);
  });

  it("uses the visit's zone, not the business's (CQ-05): a Los Angeles visit at 8:30pm there is held to 9am there", async () => {
    // 4:30am UTC: 11:30pm in New York (the business), 8:30pm in Los Angeles (the visit).
    const t = setup([reminder()], "2026-11-08T04:30:00.000Z");
    t.state.forHandle("handle-ben", { visitZone: "America/Los_Angeles" });

    const report = await runDispatch(t.deps());

    expect(report.rows.map((row) => row.outcome)).toEqual(["held"]);
    expect(t.store.rowMarks[0]?.request.heldUntil).toBe("2026-11-08T17:00:00.000Z");
  });

  it("uses the visit's zone the other way: 8:30pm in New York is 5:30pm in Los Angeles, so it goes", async () => {
    const t = setup([reminder()], EVENING_NY);
    t.state.forHandle("handle-ben", { visitZone: "America/Los_Angeles" });

    const report = await runDispatch(t.deps());

    expect(report.rows.map((row) => row.outcome)).toEqual(["sent"]);
  });

  it("falls back to the business's zone when the row is about no visit", async () => {
    const t = setup([reminder()], EVENING_NY);
    t.state.forHandle("handle-ben", { visitZone: null, businessZone: "America/Los_Angeles" });

    expect((await runDispatch(t.deps())).rows.map((row) => row.outcome)).toEqual(["sent"]);
  });

  it("sends a same-turn reply at 11pm", async () => {
    const t = setup([reminder({ sendClass: "quick_reply", sends: [words("Got it.")] })], NIGHT_NY);

    const report = await runDispatch(t.deps());

    expect(report.rows.map((row) => row.outcome)).toEqual(["sent"]);
    expect(t.linq.requests.map((request) => request.text)).toEqual(["Got it."]);
  });

  it("sends a visit happening now at 11pm", async () => {
    const t = setup([reminder({ sendClass: "visit_now" })], NIGHT_NY);

    expect((await runDispatch(t.deps())).rows.map((row) => row.outcome)).toEqual(["sent"]);
  });

  it("holds a routine row at 11pm", async () => {
    const t = setup([reminder()], NIGHT_NY);

    expect((await runDispatch(t.deps())).rows.map((row) => row.outcome)).toEqual(["held"]);
  });

  it("lets a later same-turn reply pass a row it held, in the same run (a held row lets later rows pass)", async () => {
    const t = setup(
      [reminder(), reminder({ id: "out-ben-reply", commitSeq: 2, sendClass: "quick_reply" })],
      NIGHT_NY,
    );

    const report = await runDispatch(t.deps());

    expect(report.rows.map((row) => [row.outboxRowId, row.outcome])).toEqual([
      ["out-ben-reminder", "held"],
      ["out-ben-reply", "sent"],
    ]);
  });

  it("sends a routine row inside hours: 9:00am goes, 8:00pm is held", async () => {
    const nine = setup([reminder()], NINE_NY);
    expect((await runDispatch(nine.deps())).rows.map((row) => row.outcome)).toEqual(["sent"]);
    const eight = setup([reminder()], "2026-11-08T01:00:00.000Z");
    expect((await runDispatch(eight.deps())).rows.map((row) => row.outcome)).toEqual(["held"]);
  });

  it("fails closed on a zone or hours that are not valid: nothing is sent and nothing is marked", async () => {
    const zone = setup([reminder()], NINE_NY);
    zone.state.forHandle("handle-ben", { businessZone: "Nowhere/Land" });
    expect((await runDispatch(zone.deps())).rows.map((row) => row.outcome)).toEqual(["unreadable"]);
    expect(zone.linq.requests).toEqual([]);
    expect(zone.store.rowMarks).toEqual([]);

    const hours = setup([reminder()], NINE_NY);
    hours.state.forHandle("handle-ben", { textHours: { start: "9am", end: "20:00" } });
    expect((await runDispatch(hours.deps())).rows.map((row) => row.outcome)).toEqual(["unreadable"]);
    expect(hours.linq.requests).toEqual([]);
  });

  describe("across daylight saving", () => {
    it("holds to 9am EDT after spring forward (Mar 7 8:30pm EST, then Mar 8 9am EDT)", () => {
      const verdict = checkTextHours(Date.parse("2026-03-08T01:30:00.000Z"), "America/New_York", {
        startMinutes: 540,
        endMinutes: 1200,
      });
      expect(verdict).toEqual({ inside: false, notBefore: "2026-03-08T13:00:00.000Z" });
    });

    it("holds to 9am EST after fall back (Nov 1 8:30pm EST, then Nov 2 9am EST)", () => {
      const verdict = checkTextHours(Date.parse("2026-11-02T01:30:00.000Z"), "America/New_York", {
        startMinutes: 540,
        endMinutes: 1200,
      });
      expect(verdict).toEqual({ inside: false, notBefore: "2026-11-02T14:00:00.000Z" });
    });

    it("reads the local clock on the day of the change", () => {
      expect(new Date(instantOfLocal("America/New_York", 2026, 3, 8, 540)).toISOString()).toBe(
        "2026-03-08T13:00:00.000Z",
      );
      expect(new Date(instantOfLocal("America/New_York", 2026, 3, 9, 480)).toISOString()).toBe(
        "2026-03-09T12:00:00.000Z",
      );
    });
  });
});

describe("a mobile with no open chat gets no text and no clock (mark-waiting-chat.json)", () => {
  it("parks the row waiting for the chat: no send, no claim, no held_until", async () => {
    const t = setup(
      [reminder({ id: "out-dee-booked-riley", recipient: "handle-ben", openQuestionId: "oq-dee" })],
      NINE_NY,
    );
    t.state.forHandle("handle-ben", { chatOpen: false });

    const report = await runDispatch(t.deps());

    expect(report.rows.map((row) => [row.outcome, row.partsSent])).toEqual([["waitingChat", 0]]);
    expect(t.linq.requests).toEqual([]);
    expect(t.store.rowMarks[0]?.request).toMatchObject({
      outcome: "waitingChat",
      heldUntil: null,
      outboxRowId: "out-dee-booked-riley",
    });
    expect(t.store.row("out-dee-booked-riley")).toMatchObject({
      state: "waiting_chat",
      claim: null,
      heldUntil: null,
    });
    // It is passed from then on, however long it waits, and still nothing goes.
    t.clock.advance(24 * 3_600_000);
    expect((await runDispatch(t.deps())).claimed).toBe(0);
    expect(t.linq.requests).toEqual([]);
  });

  it("parks a same-turn class row too: Rosie never writes first", async () => {
    const t = setup([reminder({ sendClass: "visit_now" })], NINE_NY);
    t.state.forHandle("handle-ben", { chatOpen: false });

    expect((await runDispatch(t.deps())).rows.map((row) => row.outcome)).toEqual(["waitingChat"]);
    expect(t.linq.requests).toEqual([]);
  });

  it("parks a safety line too when the phone is not stopped and has no open chat (MC C9: Rosie never writes first)", async () => {
    const t = setup(
      [reminder(), reminder({ id: "out-ben-safety", commitSeq: 2, sendClass: "safety" })],
      NINE_NY,
    );
    t.state.forHandle("handle-ben", { chatOpen: false });

    const report = await runDispatch(t.deps());

    // Restated by T-1352 (DL-687, the lead's OK; rule 7.9): the run takes its safety row first, then the reminder.
    expect(report.rows.map((row) => [row.outboxRowId, row.outcome])).toEqual([
      ["out-ben-safety", "waitingChat"],
      ["out-ben-reminder", "waitingChat"],
    ]);
    expect(t.store.rowMarks.map((mark) => [mark.request.outboxRowId, mark.answer])).toEqual([
      ["out-ben-safety", "waitingChat"],
      ["out-ben-reminder", "waitingChat"],
    ]);
    expect(t.linq.requests).toEqual([]);
  });

  it("parks a stop reply too when the phone is not stopped and has no open chat", async () => {
    const t = setup([reminder({ sendClass: "quick_reply", fixedLines: ["stopReply"] })], NINE_NY);
    t.state.forHandle("handle-ben", { chatOpen: false });

    expect((await runDispatch(t.deps())).rows.map((row) => row.outcome)).toEqual(["waitingChat"]);
    expect(t.linq.requests).toEqual([]);
  });

  for (const audience of ["owner", "team"] as const) {
    for (const sendClass of ["routine", "quick_reply", "visit_now", "safety"]) {
      it(`parks a ${sendClass} row to a ${audience} phone with no open chat, at any hour`, async () => {
        for (const at of [NINE_NY, NIGHT_NY, SEVEN_THIRTY_NY]) {
          const t = setup([reminder({ recipient: "handle-sam", sendClass })], at);
          t.state.forHandle("handle-sam", { audience, chatOpen: false });

          const report = await runDispatch(t.deps());

          expect(report.rows.map((row) => [row.outcome, row.partsSent])).toEqual([["waitingChat", 0]]);
          expect(t.linq.requests).toEqual([]);
          expect(t.store.row("out-ben-reminder")).toMatchObject({ state: "waiting_chat", claim: null });
        }
      });
    }
  }

  it("sends to an owner phone with an open chat, as before", async () => {
    const t = setup([reminder({ recipient: "handle-sam", sendClass: "quick_reply" })], NIGHT_NY);
    t.state.forHandle("handle-sam", { audience: "owner", chatOpen: true });

    expect((await runDispatch(t.deps())).rows.map((row) => row.outcome)).toEqual(["sent"]);
  });
});

describe("never an SMS port (refuse-sms-channel.json; C-241; DL-012; DL-031)", () => {
  it("refuses a row sent by an SMS port: nothing is sent, nothing is read, nothing is marked", async () => {
    const t = setup(
      [reminder({ id: "out-alex-booked-riley", channel: "sms", port: "sms", sendClass: "quick_reply" })],
      NINE_NY,
    );

    const report = await runDispatch(t.deps());

    expect(report.rows.map((row) => [row.outcome, row.partsSent])).toEqual([["refusedSms", 0]]);
    expect(t.linq.requests).toEqual([]);
    expect(t.state.reads).toEqual([]);
    expect(t.store.rowMarks).toEqual([]);
    expect(t.store.marks).toEqual([]);
    expect(t.spans.map((span) => [span.hop, span.outcome, span.error_code])).toEqual([
      ["dispatch", "refused", "smsRefused"],
    ]);
  });

  it("refuses a safety line sent by an SMS port as well, and lets the recipient's later rows pass it", async () => {
    const t = setup(
      [
        reminder({ channel: "sms", port: "sms", sendClass: "safety" }),
        reminder({
          id: "out-ben-safety-2",
          commitSeq: 2,
          sendClass: "safety",
          sends: [words("Safety line.")],
        }),
      ],
      NINE_NY,
    );

    const report = await runDispatch(t.deps());

    expect(report.rows.map((row) => [row.outboxRowId, row.outcome])).toEqual([
      ["out-ben-reminder", "refusedSms"],
      ["out-ben-safety-2", "sent"],
    ]);
    expect(t.linq.requests.map((request) => request.text)).toEqual(["Safety line."]);
  });

  it("lets a row on the sms channel through the linq port go, text only (K-07 README; DL-031)", async () => {
    const t = setup([reminder({ channel: "sms", port: "linq", sendClass: "quick_reply" })], NINE_NY);

    const report = await runDispatch(t.deps());

    expect(report.rows.map((row) => [row.outcome, row.partsSent])).toEqual([["sent", 1]]);
    expect(t.linq.requests).toHaveLength(1);
    expect(t.linq.requests[0]).toMatchObject({ kind: "words", options: [], link: null, calendarFile: null });
  });

  it("lets a row on the sms channel with no port named go too (the linq port is the only one)", async () => {
    const t = setup([reminder({ channel: "sms" })], NINE_NY);

    expect((await runDispatch(t.deps())).rows.map((row) => row.outcome)).toEqual(["sent"]);
  });
});

describe("the stopped flag is read again just before each send", () => {
  it("a stop that commits during the chat lookup lets no part out, and the row is dropped", async () => {
    const t = setup([reminder()], NINE_NY);
    const recipients = new FakeRecipients({ "handle-ben": BEN });
    recipients.beforeAnswer = (): Promise<void> => {
      t.state.forHandle("handle-ben", { stopped: true });
      return Promise.resolve();
    };

    const report = await runDispatch({ ...t.deps(), recipients });

    expect(report.rows.map((row) => [row.outcome, row.partsSent])).toEqual([["droppedStopped", 0]]);
    expect(t.linq.requests).toEqual([]);
    expect(t.store.row("out-ben-reminder").state).toBe("dropped_stopped");
  });

  it("a stop that commits meanwhile still lets a safety line out, with the opt-out override", async () => {
    const t = setup([reminder({ sendClass: "safety", sends: [words("Safety line.")] })], NINE_NY);
    const recipients = new FakeRecipients({ "handle-ben": BEN });
    recipients.beforeAnswer = (): Promise<void> => {
      t.state.forHandle("handle-ben", { stopped: true });
      return Promise.resolve();
    };

    const report = await runDispatch({ ...t.deps(), recipients });

    expect(report.rows.map((row) => row.outcome)).toEqual(["sent"]);
    expect(t.linq.requests[0]).toMatchObject({ overrideOptout: true, text: "Safety line." });
  });

  it("a read that keeps answering transient sends nothing", async () => {
    const t = setup([reminder()], NINE_NY);
    const recipients = new FakeRecipients({ "handle-ben": BEN });
    recipients.beforeAnswer = (): Promise<void> => {
      t.state.failReads = 3;
      return Promise.resolve();
    };

    const report = await runDispatch({ ...t.deps(), recipients });

    expect(report.rows.map((row) => [row.outcome, row.partsSent])).toEqual([["storeError", 0]]);
    expect(t.linq.requests).toEqual([]);
  });
});

describe("the staging text-hours override (BP 9.4)", () => {
  it("is honoured on staging: a test phone with the override gets a routine row at 8:30pm", async () => {
    const t = setup([reminder()], EVENING_NY);
    t.state.forHandle("handle-ben", { textHoursOverride: true });

    const report = await runDispatch(t.deps("staging"));

    expect(report.rows.map((row) => row.outcome)).toEqual(["sent"]);
  });

  it("is ignored outside staging: the same row is held on production, and on any other name", async () => {
    for (const environment of ["production", "Staging", "stagingx", ""]) {
      const t = setup([reminder()], EVENING_NY);
      t.state.forHandle("handle-ben", { textHoursOverride: true });

      const report = await runDispatch(t.deps(environment));

      expect(report.rows.map((row) => row.outcome)).toEqual(["held"]);
      expect(t.linq.requests).toEqual([]);
    }
  });

  it("does not hold a phone without the override on staging, and never skips a stop", async () => {
    const t = setup([reminder()], EVENING_NY);
    expect((await runDispatch(t.deps("staging"))).rows.map((row) => row.outcome)).toEqual(["held"]);

    const stopped = setup([reminder()], EVENING_NY);
    stopped.state.forHandle("handle-ben", { textHoursOverride: true, stopped: true });
    expect((await runDispatch(stopped.deps("staging"))).rows.map((row) => row.outcome)).toEqual([
      "droppedStopped",
    ]);
  });
});

describe("limit 8 fails closed", () => {
  it("sends nothing while the send-state read keeps answering transient, and keeps the claim", async () => {
    const t = setup([reminder()], NINE_NY);
    t.state.failReads = 3;

    const report = await runDispatch(t.deps());

    expect(report.rows.map((row) => [row.outcome, row.partsSent])).toEqual([["storeError", 0]]);
    expect(t.linq.requests).toEqual([]);
    expect(t.store.rowMarks).toEqual([]);
    expect(t.store.row("out-ben-reminder").state).toBe("sending");
  });

  it("repeats a read that answered transient once and then sends", async () => {
    const t = setup([reminder()], NINE_NY);
    t.state.failReads = 1;

    expect((await runDispatch(t.deps())).rows.map((row) => row.outcome)).toEqual(["sent"]);
  });

  it("reads the send state before each part and again just before its send, and sends only after both pass", async () => {
    const t = setup([reminder({ sends: [words("First part."), words("Second part.")] })], NINE_NY);

    const report = await runDispatch(t.deps());

    expect(report.rows.map((row) => [row.outcome, row.partsSent])).toEqual([["sent", 2]]);
    expect(t.state.reads).toEqual(Array.from({ length: 4 }, () => "out-ben-reminder"));
  });
});

describe("what the spans carry", () => {
  it("a limit-8 result on the dispatch span, with no words, number or key", async () => {
    const t = setup([reminder()], EVENING_NY);

    await runDispatch(t.deps());

    expect(t.spans).toHaveLength(1);
    expect(t.spans[0]).toMatchObject({
      hop: "dispatch",
      outcome: "held",
      limits: [{ limit: 8, result: "fail", outcome: "held" }],
    });
    const logged = JSON.stringify(t.spans);
    expect(logged).not.toContain("+1555");
    expect(logged).not.toContain("Reminder");
  });

  it("a pass is recorded as a pass on a span that sent", async () => {
    const t = setup([reminder()], NINE_NY);

    await runDispatch(t.deps());

    const dispatch = t.spans.find((span) => span.hop === "dispatch");
    expect(dispatch).toMatchObject({ outcome: "ok", limits: [{ limit: 8, result: "pass", outcome: null }] });
  });
});
