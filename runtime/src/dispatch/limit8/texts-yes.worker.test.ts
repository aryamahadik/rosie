// Limit 8 and a texts yes after a STOP (T-1099; C-125), run inside the Workers runtime (Vitest project "workers"),
// through the real dispatcher against T-257's and T-259's fakes (../test-support.ts). After a STOP only the person's
// own yes from the number that stopped turns texts back on (RULES 7.1, 7.5; S13-32, MASTER-FLOW-A lines 7213 to 7215
// and 7242; MC C1): never a yes the business entered by text or on the Today page, whose texts row is newer than the
// STOP and is what K-05 v1.2 default 35 reads as the covering row (T-050's security review, round 1 note a and round 3
// note a). The story is K-09 v1.1's frozen chain on Alex M. at Lee's Barbershop: Sam's '1 Yes' for Sat Oct 24
// (j3-confirm-business-booking-yes.json), Alex's STOP (j3-stop-tells-businesses.json), then Sam's '1 Yes' for Sat
// Oct 31 on the Today page (j3-confirm-business-booking-texts-off-page.json), and the turn variant
// (j3-confirm-business-booking-texts-off.json). Names are the master's sample cast; phones are 555-01xx (rule 9). New
// York is on EDT (UTC-4) until 2026-11-01.
import { describe, expect, it } from "vitest";

import confirmTextsOffPage from "../../../../contracts/tool-api/fixtures/j3-confirm-business-booking-texts-off-page.json";
import confirmTextsOff from "../../../../contracts/tool-api/fixtures/j3-confirm-business-booking-texts-off.json";
import confirmYes from "../../../../contracts/tool-api/fixtures/j3-confirm-business-booking-yes.json";
import stopTellsBusinesses from "../../../../contracts/tool-api/fixtures/j3-stop-tells-businesses.json";
import startRecorded from "../../../../contracts/tool-api/fixtures/start-recorded.json";
import { decideLimit8, stopStands, yesAfterStop } from "./limit8";
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
import type { ChatTarget, ClaimedRow, SendState, TextsConsentRead } from "../types";

const ALEX: ChatTarget = { to: "+15555550101", chatId: "linq-chat-demo-alex", service: "imessage" };
const SAM: ChatTarget = { to: "+15555550100", chatId: "linq-chat-demo-sam", service: "imessage" };
const LEES = "biz-lees-barbershop";

/** Alex's STOP, from his own mobile (j3-stop-tells-businesses.json): his texts row for every business, revoked. */
const STOP_AT = stopTellsBusinesses.given.now;
const [STOP_CONSENT_ID = ""] = stopTellsBusinesses.outcome.consentRowIds;
const STOP_ROW: TextsConsentRead = {
  consentId: STOP_CONSENT_ID,
  businessId: null,
  revoked: true,
  at: STOP_AT,
  fromContact: true,
  bookingId: null,
};

/**
 * Sam's '1 Yes' on the Today page for Sat Oct 31 with Alex's mobile stopped, as an answer holding both textsOff and a
 * consentId (the schema's anyOf takes it: T-050 round 3 note a). The consent id is an example; K-29 would hold the row
 * as a texts yes at Lee's for that booking, given on the page by Sam, so never from Alex's number.
 */
const PAGE_ANSWER = { ...confirmTextsOffPage.outcome, consentId: "consent-alex-texts-desk" };
const PAGE_YES: TextsConsentRead = {
  consentId: PAGE_ANSWER.consentId,
  businessId: confirmTextsOffPage.request.caller.businessId,
  revoked: false,
  at: confirmTextsOffPage.given.now,
  fromContact: false,
  bookingId: PAGE_ANSWER.bookingId,
};
/** The same row as K-05 v1.2's sendState gives it today: no word of who gave it, nor of its booking. */
const PAGE_YES_AS_K05_V12: TextsConsentRead = {
  consentId: PAGE_YES.consentId,
  businessId: PAGE_YES.businessId,
  revoked: false,
  at: PAGE_YES.at,
};

/** Alex's START, from his own mobile, the next morning (example time); its row covers every business. */
const START_AT = "2026-10-23T15:00:00.000Z";
const START_ROW: TextsConsentRead = {
  consentId: "consent-alex-start",
  businessId: null,
  revoked: false,
  at: START_AT,
  fromContact: true,
  bookingId: null,
};

/** 10:12am in New York on Fri Oct 23, the Today page's '1 Yes': inside every text hour. */
const AFTER_PAGE_YES = "2026-10-23T14:12:05.000Z";

interface Setup {
  store: FakeOutboxStore;
  linq: FakeLinq;
  state: FakeSendState;
  spans: Span[];
  deps: () => DispatchDeps;
}

function setup(seeds: readonly SeedRow[], start: string): Setup {
  const clock = new FakeClock(start);
  const store = new FakeOutboxStore(seeds);
  const linq = new FakeLinq(clock.now);
  const state = new FakeSendState();
  const spans: Span[] = [];
  const recipients = new FakeRecipients({ "handle-alex": ALEX, "handle-sam": SAM });
  return {
    store,
    linq,
    state,
    spans,
    deps: () => ({
      store,
      linq,
      recipients,
      sendState: state,
      environment: "production",
      traceFor: traceCollector(spans),
      now: clock.now,
      claimer: "dispatcher-1",
      limit: 100,
    }),
  };
}

/** A row to Alex about one of his bookings (or none): words for the test only, never logged. */
const toAlex = (id: string, bookingId: string | null, overrides: Partial<SeedRow> = {}): SeedRow => ({
  id,
  recipient: "handle-alex",
  commitSeq: 1,
  bookingId,
  sends: [words("Reminder: your haircut is Sat Oct 31, 11:00am.")],
  ...overrides,
});

/** Alex's phone as K-04 holds it after his STOP: stopped, its chat closed (phones_stop_closes_chat), with a texts row. */
const stoppedAlex = (textsConsent: TextsConsentRead | null): Partial<SendState> => ({
  stopped: true,
  stopAt: STOP_AT,
  chatOpen: false,
  textsConsent,
});

/** Each dispatch span as [row id, outcome, the refused yes's label]. */
const spanSummary = (spans: readonly Span[]): unknown[] =>
  spans
    .filter((span) => span.hop === "dispatch")
    .map((span) => [span.rows?.[0]?.id, span.outcome, span.decided?.textsYes ?? null]);

describe("after a STOP, a texts yes the business entered never turns texts back on (S13-32 line 7215)", () => {
  it("a texts row written by a business's '1 Yes' leaves send state stopped and the row is not sent", async () => {
    // Alex's yes of Oct 22 (Sam's '1' while Alex's number was his own for this booking) came before his STOP; the
    // business's '1 Yes' on the Today page the next day is the newest texts row at Lee's (K-05 v1.2 default 35).
    expect(Date.parse(confirmYes.given.now)).toBeLessThan(Date.parse(STOP_AT));
    expect(Date.parse(PAGE_YES.at)).toBeGreaterThan(Date.parse(STOP_AT));
    const seeds = [
      toAlex("out-alex-desk-reminder", PAGE_ANSWER.bookingId),
      toAlex("out-alex-sam-book-reminder", confirmYes.outcome.bookingId, { commitSeq: 2 }),
      toAlex("out-alex-quick-reply", null, { commitSeq: 3, sendClass: "quick_reply" }),
    ];
    const t = setup(seeds, AFTER_PAGE_YES);
    t.state.forHandle("handle-alex", stoppedAlex(PAGE_YES));

    const report = await runDispatch(t.deps());

    expect(report.rows.map((row) => [row.outboxRowId, row.outcome, row.partsSent])).toEqual([
      ["out-alex-desk-reminder", "droppedStopped", 0],
      ["out-alex-sam-book-reminder", "droppedStopped", 0],
      ["out-alex-quick-reply", "droppedStopped", 0],
    ]);
    expect(t.linq.requests).toEqual([]);
    expect(t.store.rowMarks.map((mark) => mark.request.outcome)).toEqual([
      "droppedStopped",
      "droppedStopped",
      "droppedStopped",
    ]);
    expect(spanSummary(t.spans)).toEqual([
      ["out-alex-desk-reminder", "dropped", "notFromContact"],
      ["out-alex-sam-book-reminder", "dropped", "notFromContact"],
      ["out-alex-quick-reply", "dropped", "notFromContact"],
    ]);
    const logged = JSON.stringify(t.spans);
    expect(logged).not.toContain("+1555");
    expect(logged).not.toContain("Reminder");
  });

  it("the same yes as K-05 v1.2 gives it, with no word of who gave it, leaves it stopped too: limit 8 fails closed", async () => {
    const t = setup([toAlex("out-alex-desk-reminder", PAGE_ANSWER.bookingId)], AFTER_PAGE_YES);
    t.state.forHandle("handle-alex", stoppedAlex(PAGE_YES_AS_K05_V12));

    const report = await runDispatch(t.deps());

    expect(report.rows.map((row) => [row.outcome, row.partsSent])).toEqual([["droppedStopped", 0]]);
    expect(t.linq.requests).toEqual([]);
    expect(spanSummary(t.spans)).toEqual([["out-alex-desk-reminder", "dropped", "notKnown"]]);
  });

  it("the stop read again just before the send counts no yes: a STOP committed during the chat lookup drops the row, and a business's '1 Yes' newer than it does not bring it back", async () => {
    const t = setup([toAlex("out-alex-desk-reminder", PAGE_ANSWER.bookingId)], AFTER_PAGE_YES);
    const recipients = new FakeRecipients({ "handle-alex": ALEX });
    recipients.beforeAnswer = (): Promise<void> => {
      t.state.forHandle("handle-alex", stoppedAlex(PAGE_YES));
      return Promise.resolve();
    };

    const report = await runDispatch({ ...t.deps(), recipients });

    expect(report.rows.map((row) => [row.outcome, row.partsSent])).toEqual([["droppedStopped", 0]]);
    expect(t.linq.requests).toEqual([]);
    expect(t.store.row("out-alex-desk-reminder").state).toBe("dropped_stopped");
  });
});

describe("the person's own yes from the number that stopped turns texts back on (RULES 7.5; S13-32 line 7242)", () => {
  it("the person's own START from that number turns texts back on: STOP, then the business's '1 Yes', then Alex's START", async () => {
    const row = toAlex("out-alex-desk-reminder", PAGE_ANSWER.bookingId);
    const claimedRow = claimed({ outboxRowId: row.id, bookingId: PAGE_ANSWER.bookingId });

    // 1. After his STOP: the newest texts row is the STOP itself.
    const afterStop = setup([row], "2026-10-22T16:40:05.000Z");
    afterStop.state.forHandle("handle-alex", stoppedAlex(STOP_ROW));
    expect((await runDispatch(afterStop.deps())).rows.map((done) => done.outcome)).toEqual([
      "droppedStopped",
    ]);
    expect(stopStands(claimedRow, stateOf(stoppedAlex(STOP_ROW)))).toBe(true);

    // 2. After Sam's '1 Yes' on the Today page: still stopped.
    const afterPageYes = setup([row], AFTER_PAGE_YES);
    afterPageYes.state.forHandle("handle-alex", stoppedAlex(PAGE_YES));
    expect((await runDispatch(afterPageYes.deps())).rows.map((done) => done.outcome)).toEqual([
      "droppedStopped",
    ]);
    expect(stopStands(claimedRow, stateOf(stoppedAlex(PAGE_YES)))).toBe(true);

    // 3. After Alex texts START from his mobile: the flag is cleared and his chat open again, as K-09's
    // start-recorded.json records a START, and the newest texts row is his own START, for every business.
    const started: Partial<SendState> = {
      stopped: startRecorded.outcome.stopped,
      chatOpen: startRecorded.outcome.chatOpen,
      stopAt: STOP_AT,
      textsConsent: START_ROW,
    };
    const afterStart = setup([row], "2026-10-23T15:00:05.000Z");
    afterStart.state.forHandle("handle-alex", started);
    const report = await runDispatch(afterStart.deps());
    expect(report.rows.map((done) => [done.outcome, done.partsSent])).toEqual([["sent", 1]]);
    expect(afterStart.linq.requests.map((request) => [request.chatId, request.overrideOptout])).toEqual([
      [ALEX.chatId, false],
    ]);
    expect(stopStands(claimedRow, stateOf(started))).toBe(false);
  });

  it("his own fresh yes on a new booking, sent from his number, lifts the stop for that booking only: its row waits for the chat, never dropped, and the others stay dropped", async () => {
    const ownYes: TextsConsentRead = {
      consentId: "consent-alex-texts-new-booking",
      businessId: LEES,
      revoked: false,
      at: "2026-10-23T14:30:00.000Z",
      fromContact: true,
      bookingId: "booking-alex-new",
    };
    const t = setup(
      [
        toAlex("out-alex-new-booking", "booking-alex-new"),
        toAlex("out-alex-sam-book-reminder", confirmYes.outcome.bookingId, { commitSeq: 2 }),
        toAlex("out-alex-no-booking", null, { commitSeq: 3, sendClass: "quick_reply" }),
      ],
      "2026-10-23T14:30:05.000Z",
    );
    t.state.forHandle("handle-alex", stoppedAlex(ownYes));

    const report = await runDispatch(t.deps());

    expect(report.rows.map((row) => [row.outboxRowId, row.outcome])).toEqual([
      ["out-alex-new-booking", "waitingChat"],
      ["out-alex-sam-book-reminder", "droppedStopped"],
      ["out-alex-no-booking", "droppedStopped"],
    ]);
    expect(t.linq.requests).toEqual([]);
    expect(t.store.row("out-alex-new-booking")).toMatchObject({ state: "waiting_chat", claim: null });
    expect(spanSummary(t.spans)).toEqual([
      ["out-alex-new-booking", "held", null],
      ["out-alex-sam-book-reminder", "dropped", "otherBooking"],
      ["out-alex-no-booking", "dropped", "otherBooking"],
    ]);
  });
});

describe("an answer holding textsOff and a consentId is refused where the dispatcher meets it", () => {
  it("in Sam's turn: his texts-off line goes, and the answer's consent never lifts Alex's stop", async () => {
    // j3-confirm-business-booking-texts-off.json's answer with the yes fixture's consent id added: both at once.
    const answer = { ...confirmTextsOff.outcome, consentId: confirmYes.outcome.consentId };
    expect(answer.textsOff).not.toBeNull();
    expect(answer.consentId).not.toBeNull();
    const answeredAt = confirmTextsOff.given.now;
    // Alex texted STOP earlier that morning (the fixture's note; the time is an example).
    const stopAt = "2026-10-22T12:40:02.000Z";
    // The consent the answer names, as K-29 holds it: a texts yes at Lee's for the booking, written in Sam's own turn
    // (caller turn, person-sam), so never Alex's word from his number.
    const answerYes: TextsConsentRead = {
      consentId: answer.consentId,
      businessId: confirmTextsOff.request.caller.businessId,
      revoked: false,
      at: answeredAt,
      fromContact: false,
      bookingId: answer.bookingId,
    };
    const t = setup(
      [
        {
          id: answer.textsOff.outboxRowId,
          recipient: "handle-sam",
          commitSeq: 1,
          sendClass: "quick_reply",
          bookingId: answer.bookingId,
          fixedLines: [answer.textsOff.fixedLineId],
          sends: [words("Texts to this customer are off. Reach them their way.")],
        },
        toAlex("out-alex-sam-book-reminder", answer.bookingId, { commitSeq: 2 }),
      ],
      "2026-10-22T14:03:05.000Z",
    );
    t.state.forHandle("handle-sam", { audience: "owner" });
    t.state.forHandle("handle-alex", { ...stoppedAlex(answerYes), stopAt });

    const report = await runDispatch(t.deps());

    expect(report.rows.map((row) => [row.outboxRowId, row.outcome, row.partsSent])).toEqual([
      ["out-sam-alex-texts-off", "sent", 1],
      ["out-alex-sam-book-reminder", "droppedStopped", 0],
    ]);
    expect(t.linq.requests.map((request) => request.chatId)).toEqual([SAM.chatId]);
    expect(spanSummary(t.spans)).toContainEqual(["out-alex-sam-book-reminder", "dropped", "notFromContact"]);

    // Read as K-05 v1.2 gives the row today, with no word of who gave it: refused all the same.
    const asFrozen = setup(
      [toAlex("out-alex-sam-book-reminder", answer.bookingId)],
      "2026-10-22T14:03:05.000Z",
    );
    asFrozen.state.forHandle("handle-alex", {
      ...stoppedAlex({ consentId: answer.consentId, businessId: LEES, revoked: false, at: answeredAt }),
      stopAt,
    });
    expect((await runDispatch(asFrozen.deps())).rows.map((row) => row.outcome)).toEqual(["droppedStopped"]);
    expect(asFrozen.linq.requests).toEqual([]);
  });

  it("on the Today page: no row for the page, and the answer's consent never lifts Alex's stop", async () => {
    expect(PAGE_ANSWER.textsOff).toEqual({ fixedLineId: "textsOffReachTheirWay", outboxRowId: null });
    expect(PAGE_ANSWER.consentId).not.toBeNull();
    const t = setup([toAlex("out-alex-desk-reminder", PAGE_ANSWER.bookingId)], AFTER_PAGE_YES);
    t.state.forHandle("handle-alex", stoppedAlex(PAGE_YES));

    const report = await runDispatch(t.deps());

    expect(report.rows.map((row) => [row.outcome, row.partsSent])).toEqual([["droppedStopped", 0]]);
    expect(t.linq.requests).toEqual([]);
    expect(spanSummary(t.spans)).toEqual([["out-alex-desk-reminder", "dropped", "notFromContact"]]);
  });
});

describe("hard invariant: a texts yes that is not the person's own since the stop sends nothing", () => {
  /** A seeded generator (mulberry32): the same rows on every run, so the test is never flaky. */
  function seeded(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("1,000 random rows to stopped phones, each with a texts row that is not the person's own yes since the stop, give zero sends", async () => {
    const random = seeded(20261108);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const handles = ["handle-alex", "handle-ben", "handle-sam", "handle-cy", "handle-dee"];
    const bookings = ["booking-alex-desk", "booking-alex-sam-book", null];
    const beforeStop = "2026-10-22T09:00:00.000Z";
    const own = (bookingId: string | null | undefined, at: string): TextsConsentRead => ({
      consentId: "consent-own",
      businessId: LEES,
      revoked: false,
      at,
      fromContact: true,
      ...(bookingId === undefined ? {} : { bookingId }),
    });
    // Every kind of texts row that must leave a stop standing.
    const rowsThatKeepTheStop: (TextsConsentRead | null | undefined)[] = [
      undefined,
      null,
      STOP_ROW,
      PAGE_YES,
      PAGE_YES_AS_K05_V12,
      { ...PAGE_YES, consentId: "consent-sam-text-yes", bookingId: "booking-alex-sam-book" },
      // A yes for every business that did not come from that number.
      {
        consentId: "consent-not-from-contact",
        businessId: null,
        revoked: false,
        at: AFTER_PAGE_YES,
        fromContact: false,
      },
      own("booking-alex-desk", beforeStop),
      own("booking-alex-desk", STOP_AT),
      own("booking-alex-other", AFTER_PAGE_YES),
      own(null, AFTER_PAGE_YES),
      own(undefined, AFTER_PAGE_YES),
    ];
    let sent = 0;
    let dropped = 0;

    for (let batch = 0; batch < 10; batch += 1) {
      const hour = String(batch * 2 + 1).padStart(2, "0");
      const seeds: SeedRow[] = Array.from({ length: 100 }, (_, index) => ({
        id: `out-${String(batch)}-${String(index)}`,
        recipient: pick(handles),
        commitSeq: index + 1,
        sendClass: pick(["routine", "quick_reply", "visit_now"]),
        bookingId: pick(bookings),
        sends: random() < 0.3 ? [words("First part."), words("Second part.")] : [words("One part.")],
      }));
      const t = setup(seeds, `2026-10-24T${hour}:15:00.000Z`);
      for (const handle of handles) {
        const textsConsent = pick(rowsThatKeepTheStop);
        t.state.forHandle(handle, {
          stopped: true,
          chatOpen: false,
          audience: pick(["customer", "owner", "team"] as const),
          // An own yes for this very booking with no stop time known lifts nothing either.
          stopAt: random() < 0.1 ? null : STOP_AT,
          ...(textsConsent === undefined ? {} : { textsConsent }),
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
});

describe("yesAfterStop: every check fails closed", () => {
  const OWN_YES: TextsConsentRead = {
    consentId: "consent-alex-texts-desk-own",
    businessId: LEES,
    revoked: false,
    at: AFTER_PAGE_YES,
    fromContact: true,
    bookingId: "booking-alex-desk",
  };
  const row = claimed({ bookingId: "booking-alex-desk" });

  it("lifts the stop only for the person's own yes from that number, after the stop, for this row's booking or every business", () => {
    /** Stopped at STOP_AT, with this texts row. */
    const after = (textsConsent: TextsConsentRead | null): Partial<SendState> => ({
      stopAt: STOP_AT,
      textsConsent,
    });
    const cases: [string, Partial<SendState>, ClaimedRow, unknown][] = [
      ["no texts row read", { stopAt: STOP_AT }, row, { lifts: false, refused: null }],
      ["no texts row", after(null), row, { lifts: false, refused: null }],
      ["the STOP row", after(STOP_ROW), row, { lifts: false, refused: null }],
      ["the business's yes", after(PAGE_YES), row, { lifts: false, refused: "notFromContact" }],
      ["K-05 v1.2's row", after(PAGE_YES_AS_K05_V12), row, { lifts: false, refused: "notKnown" }],
      ["no stop time", { stopAt: null, textsConsent: OWN_YES }, row, { lifts: false, refused: "notKnown" }],
      ["stop time not read", { textsConsent: OWN_YES }, row, { lifts: false, refused: "notKnown" }],
      [
        "at the stop's instant",
        after({ ...OWN_YES, at: STOP_AT }),
        row,
        { lifts: false, refused: "notAfterStop" },
      ],
      [
        "before the stop",
        after({ ...OWN_YES, at: "2026-10-22T09:00:00.000Z" }),
        row,
        { lifts: false, refused: "notAfterStop" },
      ],
      [
        "its booking not read",
        after({ ...PAGE_YES_AS_K05_V12, fromContact: true }),
        row,
        { lifts: false, refused: "notKnown" },
      ],
      [
        "another booking",
        after({ ...OWN_YES, bookingId: "booking-alex-other" }),
        row,
        { lifts: false, refused: "otherBooking" },
      ],
      [
        "no booking named",
        after({ ...OWN_YES, bookingId: null }),
        row,
        { lifts: false, refused: "otherBooking" },
      ],
      [
        "a row about no booking",
        after(OWN_YES),
        claimed({ bookingId: null }),
        { lifts: false, refused: "otherBooking" },
      ],
      ["his own yes for this booking", after(OWN_YES), row, { lifts: true }],
      ["his own START", after(START_ROW), claimed({ bookingId: null }), { lifts: true }],
    ];
    for (const [name, patch, claimedRow, expected] of cases) {
      const state = stateOf({ stopped: true, chatOpen: false, ...patch });
      expect([name, yesAfterStop(claimedRow, state)]).toEqual([name, expected]);
    }
  });

  it("a stopped phone still gets a safety line and a stop reply, with the override, whatever the texts row", () => {
    for (const textsConsent of [PAGE_YES, OWN_YES, START_ROW, null]) {
      const state = stateOf(stoppedAlex(textsConsent));
      for (const [sendClass, fixedLines, reason] of [
        ["safety", [], "safety"],
        ["quick_reply", ["stopReply"], "stopReply"],
      ] as const) {
        const decision = decideLimit8({
          row: claimed({ sendClass, finalParts: { ...claimed().finalParts, fixedLines } }),
          state,
          now: AFTER_PAGE_YES,
          honourOverride: false,
          partOut: false,
        });
        expect(decision).toEqual({ action: "send", reason, overrideOptout: true });
      }
    }
  });

  it("a row his own yes lifted goes on to the other checks: with the chat closed by the stop, it waits for it", () => {
    const decision = decideLimit8({
      row,
      state: stateOf(stoppedAlex(OWN_YES)),
      now: AFTER_PAGE_YES,
      honourOverride: false,
      partOut: false,
    });
    expect(decision).toEqual({ action: "mark", outcome: "waitingChat", heldUntil: null });
  });

  it("a stop with no texts row read decides as before, with no label", () => {
    const decision = decideLimit8({
      row,
      state: stateOf({ stopped: true, chatOpen: false }),
      now: AFTER_PAGE_YES,
      honourOverride: false,
      partOut: false,
    });
    expect(decision).toEqual({ action: "mark", outcome: "droppedStopped", heldUntil: null });
  });
});

/** Alex's row as the dispatcher would claim it, for limit 8's own decision. */
function claimed(overrides: Partial<ClaimedRow> = {}): ClaimedRow {
  return {
    outboxRowId: "out-alex-desk-reminder",
    version: 4,
    commitSeq: 1,
    recipientHandleId: "handle-alex",
    recipientPersonId: "person-alex",
    businessId: LEES,
    bookingId: "booking-alex-desk",
    openQuestionId: null,
    channel: "imessage",
    sendClass: "routine",
    versionsRead: [],
    finalParts: {
      row: "out-alex-desk-reminder",
      channel: "imessage",
      sends: [words("Reminder: your haircut is Sat Oct 31, 11:00am.")],
      fixedLines: [],
      threadReplyTo: null,
    },
    parts: [],
    traceId: "trace-alex-desk-reminder",
    claim: {
      claimer: "dispatcher-1",
      claimedAt: AFTER_PAGE_YES,
      lapsesAt: "2026-10-23T14:13:05.000Z",
      claimNo: 1,
      firstTryAt: null,
      nextTryNotBefore: null,
    },
    claimedFrom: "checked",
    ...overrides,
  };
}

/** A send state as FakeSendState answers by default (an open chat, a customer in New York), with what differs. */
function stateOf(patch: Partial<SendState>): SendState {
  return {
    stopped: false,
    chatOpen: true,
    audience: "customer",
    visitZone: null,
    businessZone: "America/New_York",
    textHours: { start: "08:00", end: "20:00" },
    textHoursOverride: false,
    currentVersions: [],
    closed: { booking: false, question: false },
    ...patch,
  };
}
