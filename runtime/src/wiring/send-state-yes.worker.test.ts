// K-05 v1.8's texts consent through the send-state port and limit 8 (T-1217, T-1102's card B; DL-456; C-124, C-125), in
// the Workers runtime. The send-state port (./real.ts realSendState and sendStateOf, T-562) maps sendState's texts consent
// row across unchanged, with v1.8's fromContact and bookingId (K-05 README item 47; defaults 78 to 84; T-1216's read),
// leaves each out when the answer has none, so limit 8 reads it as not known, and never derives the stopped flag from the
// row (STATE note 10; default 84). Limit 8 (../dispatch/limit8 decideLimit8 and yesAfterStop, T-1099) then lifts a stop
// only on the person's own yes (fromContact true) newer than the stop: for a row about the booking it names, or for every
// row on START's yes for every business (RULES 7.1, 7.5; S13-32, MASTER-FLOW-A lines 7214, 7215 and 7242).
//
// Each K-05 answer is a frozen fixture (contracts/data-access/fixtures): v1.8's send-state-stop-row, -business-yes,
// -own-start and -own-yes-one-booking, v1.2's send-state-stopped, and three answers v1.8's schema refuses
// (fixtures/invalid: a STOP read as the person's own yes, who gave a yes left out, its booking left out). Each is read for
// the row the fixtures read it for, Alex's Nov 14 confirmation as K-05 claimed it (claim-in-order-with-port.json, handed
// on by the outbox port's claimedRowOf), or that row about another booking, at the fixture's own time. Two of the card's
// cases need a stopped phone their fixture does not hold: the business's yes (Sam's '1 Yes' for Nov 28, newer than
// Alex's STOP) and START's yes beside a flag still set. Each takes the phone row K-05 reads after Alex's STOP
// (send-state-stop-row.json) with its own fixture's texts row, and says so. Test values only (rule 9): the master's
// sample cast, the fictional 555-01xx numbers and the fixtures' own ids and words.
import claimInOrderWithPort from "@rosie/contracts/data-access/fixtures/claim-in-order-with-port.json";
import refuseBookingLeftOut from "@rosie/contracts/data-access/fixtures/invalid/refuse-send-state-booking-left-out.json";
import refuseStopReadAsOwnYes from "@rosie/contracts/data-access/fixtures/invalid/refuse-send-state-stop-read-as-own-yes.json";
import refuseYesSourceLeftOut from "@rosie/contracts/data-access/fixtures/invalid/refuse-send-state-yes-source-left-out.json";
import sendStateBusinessYes from "@rosie/contracts/data-access/fixtures/send-state-business-yes.json";
import sendStateOwnStart from "@rosie/contracts/data-access/fixtures/send-state-own-start.json";
import sendStateOwnYesOneBooking from "@rosie/contracts/data-access/fixtures/send-state-own-yes-one-booking.json";
import sendStateStopRow from "@rosie/contracts/data-access/fixtures/send-state-stop-row.json";
import sendStateStopped from "@rosie/contracts/data-access/fixtures/send-state-stopped.json";
import type { ClaimedRowV12 } from "@rosie/db/repo/outbox";
import type { SendStateResponse } from "@rosie/db/repo/send-state";
import { describe, expect, it } from "vitest";

import { runDispatch } from "../dispatch/dispatcher";
import { decideLimit8, yesAfterStop, type Limit8Decision, type YesRefused } from "../dispatch/limit8";
import { FakeClock, FakeLinq, FakeOutboxStore, traceCollector, words } from "../dispatch/test-support";
import type { ClaimedRow, SendState, TextsConsentRead } from "../dispatch/types";
import type { Span } from "../trace";
import { claimedRowOf, realSendState } from "./index";

const NOV14 = "booking-alex-riley-nov14";
const NOV21 = "booking-alex-riley-nov21";
const NOV28 = "booking-alex-riley-nov28";

/** A K-05 answer as its fixture holds it. */
const answerOf = (outcome: unknown): SendStateResponse => structuredClone(outcome) as SendStateResponse;

/** Alex's STOP for every business, while his confirmation is claimed: stopped, chat closed, the STOP row (v1.8). */
const STOP_ROW = answerOf(sendStateStopRow.outcome);
/** Sam's '1 Yes' for Alex's Nov 28 haircut, written in Sam's turn: not stopped; fromContact false, Nov 28. */
const BUSINESS_YES = answerOf(sendStateBusinessYes.outcome);
/** Alex's own START: the flag cleared, chat open; fromContact true, no business, no booking. */
const OWN_START = answerOf(sendStateOwnStart.outcome);
/** Alex's own fresh yes for Nov 21, from his number, after his STOP: still stopped; fromContact true, Nov 21. */
const OWN_YES_ONE_BOOKING = answerOf(sendStateOwnYesOneBooking.outcome);

/** The phone row K-05 reads after Alex's STOP (send-state-stop-row.json), beside another fixture's texts row. */
const onStoppedPhone = (answer: SendStateResponse): SendStateResponse => ({
  ...answer,
  phone: structuredClone(STOP_ROW.phone),
});

/** Alex's confirmation, about Nov 14, as K-05 v1.2 claimed it (claim-in-order-with-port.json), handed on by the port. */
function claimedAlex(): ClaimedRow {
  const claimed = (claimInOrderWithPort.outcome.claimed as unknown as readonly ClaimedRowV12[]).find(
    (row) => row.outboxRowId === STOP_ROW.outboxRowId,
  );
  if (claimed === undefined) throw new Error("claim-in-order-with-port.json claims the row sendState reads");
  return claimedRowOf(claimed);
}
const ALEX_ROW = claimedAlex();
/** The same row about another booking, or about none. */
const about = (bookingId: string | null): ClaimedRow => ({ ...ALEX_ROW, bookingId });

/** The send-state port over a K-05 double that gives this answer to the row's read, as K-05 gives it. */
async function throughPort(answer: SendStateResponse, row: ClaimedRow = ALEX_ROW): Promise<SendState> {
  const requests: unknown[] = [];
  const port = realSendState({
    call: (request) => {
      requests.push(request);
      return Promise.resolve(structuredClone(answer));
    },
  });
  const state = await port.sendState.sendStateFor(row);
  expect(requests).toEqual([{ outboxRowId: row.outboxRowId }]);
  if ("error" in state) throw new Error("the read answered an error");
  return state;
}

/** The texts row a read gave, which these fixtures always hold. */
function textsRowOf(state: SendState): TextsConsentRead {
  const row = state.textsConsent;
  if (row === undefined || row === null) throw new Error("the read gave no texts row");
  return row;
}

/** Limit 8's decision for the row at the fixture's own time, off staging (no override), with no part out yet. */
const limit8 = (row: ClaimedRow, state: SendState, now: string): Limit8Decision =>
  decideLimit8({ row, state, now, honourOverride: false, partOut: false });

const DROPPED = { action: "mark", outcome: "droppedStopped", heldUntil: null };
const droppedRefused = (yesRefused: YesRefused): Limit8Decision => ({
  action: "mark",
  outcome: "droppedStopped",
  heldUntil: null,
  yesRefused,
});
const WAITS_FOR_CHAT = { action: "mark", outcome: "waitingChat", heldUntil: null };
/** A reply in the same turn goes at any hour (Q-15; RULES 4.3): Alex's confirmation is a quick reply. */
const GOES_IN_TURN = { action: "send", reason: "sameTurn", overrideOptout: false };

describe("the send-state port maps K-05 v1.8's fromContact and bookingId across unchanged (T-1217)", () => {
  it("gives each v1.8 fixture's texts row field for field, and the phone's flag, stop time and chat as K-04 stores them", async () => {
    for (const answer of [STOP_ROW, BUSINESS_YES, OWN_START, OWN_YES_ONE_BOOKING]) {
      const state = await throughPort(answer);
      expect(state.textsConsent).toStrictEqual(answer.textsConsent);
      expect([state.stopped, state.stopAt, state.chatOpen]).toEqual([
        answer.phone?.stopped,
        answer.phone?.stopAt,
        answer.phone?.chatOpen,
      ]);
    }
    // What each states (item 47): the STOP is no one's yes; the business's yes is not Alex's own; START and his fresh
    // yes are, START for every business and booking, the fresh yes for its one booking.
    expect(textsRowOf(await throughPort(STOP_ROW))).toMatchObject({
      revoked: true,
      fromContact: false,
      bookingId: null,
    });
    expect(textsRowOf(await throughPort(BUSINESS_YES))).toMatchObject({
      fromContact: false,
      bookingId: NOV28,
    });
    expect(textsRowOf(await throughPort(OWN_START))).toMatchObject({
      businessId: null,
      fromContact: true,
      bookingId: null,
    });
    expect(textsRowOf(await throughPort(OWN_YES_ONE_BOOKING))).toMatchObject({
      fromContact: true,
      bookingId: NOV21,
    });
  });

  it("leaves each field out when the answer has none, so limit 8 reads it as not known and the stop stands", async () => {
    // K-05 v1.2's answer (send-state-stopped.json, Alex's STOP) holds neither: the row goes across with its four fields.
    const v12 = textsRowOf(await throughPort(answerOf(sendStateStopped.outcome)));
    expect(v12).toStrictEqual(sendStateStopped.outcome.textsConsent);
    expect(Object.keys(v12)).toEqual(["consentId", "businessId", "revoked", "at"]);

    // Alex's own yes for Nov 21 on his stopped number, its booking left out: not known, even for Nov 21's own row.
    const noBooking = await throughPort(answerOf(refuseBookingLeftOut));
    expect(textsRowOf(noBooking)).toStrictEqual(refuseBookingLeftOut.textsConsent);
    expect("bookingId" in textsRowOf(noBooking)).toBe(false);
    for (const row of [about(NOV21), ALEX_ROW]) {
      expect(limit8(row, noBooking, refuseBookingLeftOut.readAt)).toStrictEqual(droppedRefused("notKnown"));
    }

    // Sam's yes for Nov 28 with who gave it left out, beside Alex's stopped phone: not known, for Nov 28's own row too.
    const noSource = await throughPort(onStoppedPhone(answerOf(refuseYesSourceLeftOut)));
    expect("fromContact" in textsRowOf(noSource)).toBe(false);
    expect(textsRowOf(noSource).bookingId).toBe(NOV28);
    expect(limit8(about(NOV28), noSource, refuseYesSourceLeftOut.readAt)).toStrictEqual(
      droppedRefused("notKnown"),
    );
  });

  it("leaves out a value of neither field's type, which no K-05 version gives: it is never read as a yes", async () => {
    const own = textsRowOf(await throughPort(OWN_YES_ONE_BOOKING));
    const malformed = {
      ...OWN_YES_ONE_BOOKING,
      textsConsent: { ...own, fromContact: "true", bookingId: 21 },
    } as unknown as SendStateResponse;
    const state = await throughPort(malformed);
    expect(textsRowOf(state)).toStrictEqual({
      consentId: own.consentId,
      businessId: own.businessId,
      revoked: own.revoked,
      at: own.at,
    });
    expect(limit8(about(NOV21), state, sendStateOwnYesOneBooking.given.now)).toStrictEqual(
      droppedRefused("notKnown"),
    );
  });

  it("never derives the stopped flag, or its end, from the texts row (STATE note 10; default 84)", async () => {
    // START's own yes for every business beside a phone row whose flag is still set: stopped, as the phone says.
    const startOnStopped = await throughPort(onStoppedPhone(OWN_START));
    expect([startOnStopped.stopped, startOnStopped.stopAt, startOnStopped.chatOpen]).toEqual([
      true,
      STOP_ROW.phone?.stopAt,
      false,
    ]);
    // Alex's STOP row beside a phone row not stopped: not stopped, as the phone says.
    const stopOnOpenChat = await throughPort({ ...BUSINESS_YES, textsConsent: STOP_ROW.textsConsent });
    expect([stopOnOpenChat.stopped, stopOnOpenChat.stopAt, stopOnOpenChat.chatOpen]).toEqual([
      false,
      null,
      true,
    ]);
    // START cleared the flag and kept the STOP's time (DL-193): both read as stored.
    const started = await throughPort(OWN_START);
    expect([started.stopped, started.stopAt]).toEqual([false, STOP_ROW.phone?.stopAt]);
  });
});

describe("limit 8 over K-05 v1.8's fixtures, through the port (T-1099's yesAfterStop; S13-32 lines 7214, 7215, 7242)", () => {
  it("a STOP row is never a yes: send-state-stop-row drops every row to Alex with no yes to refuse, and so does a STOP an answer marks as his own (v1.8's schema refuses it)", async () => {
    const now = sendStateStopRow.given.now;
    const stop = await throughPort(STOP_ROW);
    const markedOwn = await throughPort(answerOf(refuseStopReadAsOwnYes));
    // The port hands the mislabelled STOP on as it is, never mending it; limit 8 reads `revoked` first.
    expect(textsRowOf(markedOwn)).toMatchObject({ revoked: true, fromContact: true });
    for (const row of [ALEX_ROW, about(NOV21), about(NOV28), about(null)]) {
      expect(yesAfterStop(row, stop)).toEqual({ lifts: false, refused: null });
      expect(yesAfterStop(row, markedOwn)).toEqual({ lifts: false, refused: null });
      expect(limit8(row, stop, now)).toStrictEqual(DROPPED);
      expect(limit8(row, markedOwn, now)).toStrictEqual(DROPPED);
    }
  });

  it("a business-entered yes keeps a stopped number stopped: Sam's '1 Yes' for Nov 28 (send-state-business-yes) lifts nothing, for its own booking or any other", async () => {
    const now = sendStateBusinessYes.given.now;
    // As the fixture reads it, Alex is not stopped: limit 8 reads no yes, and the row goes on to the other checks.
    expect(limit8(ALEX_ROW, await throughPort(BUSINESS_YES), now)).toStrictEqual(GOES_IN_TURN);
    // Beside the phone row K-05 reads after Alex's STOP: the business's yes is newer than the stop, and not his own.
    const stopped = await throughPort(onStoppedPhone(BUSINESS_YES));
    expect(stopped.stopped).toBe(true);
    expect(Date.parse(textsRowOf(stopped).at)).toBeGreaterThan(Date.parse(stopped.stopAt ?? ""));
    for (const row of [about(NOV28), ALEX_ROW, about(NOV21), about(null)]) {
      expect(limit8(row, stopped, now)).toStrictEqual(droppedRefused("notFromContact"));
    }
  });

  it("the person's own START lifts the stop: send-state-own-start lets the row on to the other checks, and beside a flag still set START's yes lifts it for every row, which then waits for the chat the stop closed", async () => {
    const now = sendStateOwnStart.given.now;
    // As the fixture reads it, START's commit cleared the flag and opened the chat: the row goes on and is sent.
    expect(limit8(ALEX_ROW, await throughPort(OWN_START), now)).toStrictEqual(GOES_IN_TURN);
    // Beside a phone row whose flag is still set: START's own yes for every business, newer than the stop, lifts it.
    const flagStillSet = await throughPort(onStoppedPhone(OWN_START));
    expect(flagStillSet.stopped).toBe(true);
    for (const row of [ALEX_ROW, about(NOV21), about(NOV28), about(null)]) {
      expect(yesAfterStop(row, flagStillSet)).toEqual({ lifts: true });
      expect(limit8(row, flagStillSet, now)).toStrictEqual(WAITS_FOR_CHAT);
    }
  });

  it("an own yes for one booking lifts the stop for that booking only: send-state-own-yes-one-booking drops the Nov 14 confirmation, and a row about Nov 21 passes the stop and waits for the chat", async () => {
    const now = sendStateOwnYesOneBooking.given.now;
    const state = await throughPort(OWN_YES_ONE_BOOKING);
    expect([state.stopped, state.chatOpen]).toEqual([true, false]);
    expect(limit8(ALEX_ROW, state, now)).toStrictEqual(droppedRefused("otherBooking"));
    expect(limit8(about(NOV21), state, now)).toStrictEqual(WAITS_FOR_CHAT);
    for (const row of [about(NOV28), about(null)]) {
      expect(limit8(row, state, now)).toStrictEqual(droppedRefused("otherBooking"));
    }
  });

  it("a safety line and a stop reply still go to the stopped number, with the override, whatever v1.8's texts row", async () => {
    const safety: ClaimedRow = { ...ALEX_ROW, sendClass: "safety" };
    const stopReply: ClaimedRow = {
      ...ALEX_ROW,
      finalParts: { ...ALEX_ROW.finalParts, fixedLines: ["stopReply"] },
    };
    for (const answer of [
      STOP_ROW,
      onStoppedPhone(BUSINESS_YES),
      onStoppedPhone(OWN_START),
      OWN_YES_ONE_BOOKING,
    ]) {
      const state = await throughPort(answer);
      expect(limit8(safety, state, answer.readAt)).toStrictEqual({
        action: "send",
        reason: "safety",
        overrideOptout: true,
      });
      expect(limit8(stopReply, state, answer.readAt)).toStrictEqual({
        action: "send",
        reason: "stopReply",
        overrideOptout: true,
      });
    }
  });
});

describe("through the dispatcher: the real send-state port feeds limit 8, and nothing reaches Linq after the STOP", () => {
  /** Rows to Alex about each booking the fixtures name, and one about none, all quick replies, in commit order. */
  const ROWS: readonly (readonly [string, string | null])[] = [
    ["out-alex-nov14", NOV14],
    ["out-alex-nov21", NOV21],
    ["out-alex-nov28", NOV28],
    ["out-alex-no-booking", null],
  ];

  /** One run of the dispatcher over those rows, every send-state read answered with this K-05 answer. */
  async function dispatchWith(answer: SendStateResponse): Promise<{
    rows: unknown[];
    spans: unknown[];
    logged: string;
    linq: FakeLinq;
    store: FakeOutboxStore;
  }> {
    const clock = new FakeClock(answer.readAt);
    const store = new FakeOutboxStore(
      ROWS.map(([id, bookingId], index) => ({
        id,
        recipient: ALEX_ROW.recipientHandleId,
        commitSeq: index + 1,
        sendClass: "quick_reply",
        bookingId,
        sends: [words("You're booked with Riley at Lee's Barbershop.")],
      })),
    );
    const linq = new FakeLinq(clock.now);
    const port = realSendState({ call: () => Promise.resolve(structuredClone(answer)) });
    const spans: Span[] = [];
    const report = await runDispatch({
      store,
      linq,
      recipients: port.recipients,
      sendState: port.sendState,
      environment: "production",
      traceFor: traceCollector(spans),
      now: clock.now,
      claimer: "dispatcher-1",
    });
    return {
      rows: report.rows.map((row) => [row.outboxRowId, row.outcome, row.partsSent]),
      spans: spans
        .filter((span) => span.hop === "dispatch")
        .map((span) => [span.rows?.[0]?.id, span.outcome, span.decided?.textsYes ?? null]),
      logged: JSON.stringify(spans),
      linq,
      store,
    };
  }

  it("drops each row the stop binds, the refused yes's label on its span, parks the one an own yes lifts, and sends nothing", async () => {
    const stop = await dispatchWith(STOP_ROW);
    expect(stop.rows).toEqual(ROWS.map(([id]) => [id, "droppedStopped", 0]));
    expect(stop.spans).toEqual(ROWS.map(([id]) => [id, "dropped", null]));

    const businessYes = await dispatchWith(onStoppedPhone(BUSINESS_YES));
    expect(businessYes.rows).toEqual(ROWS.map(([id]) => [id, "droppedStopped", 0]));
    expect(businessYes.spans).toEqual(ROWS.map(([id]) => [id, "dropped", "notFromContact"]));

    const ownYes = await dispatchWith(OWN_YES_ONE_BOOKING);
    expect(ownYes.rows).toEqual([
      ["out-alex-nov14", "droppedStopped", 0],
      ["out-alex-nov21", "waitingChat", 0],
      ["out-alex-nov28", "droppedStopped", 0],
      ["out-alex-no-booking", "droppedStopped", 0],
    ]);
    expect(ownYes.spans).toEqual([
      ["out-alex-nov14", "dropped", "otherBooking"],
      ["out-alex-nov21", "held", null],
      ["out-alex-nov28", "dropped", "otherBooking"],
      ["out-alex-no-booking", "dropped", "otherBooking"],
    ]);
    expect(ownYes.store.row("out-alex-nov21")).toMatchObject({ state: "waiting_chat", claim: null });

    const startFlagStillSet = await dispatchWith(onStoppedPhone(OWN_START));
    expect(startFlagStillSet.rows).toEqual(ROWS.map(([id]) => [id, "waitingChat", 0]));
    expect(startFlagStillSet.spans).toEqual(ROWS.map(([id]) => [id, "held", null]));

    for (const run of [stop, businessYes, ownYes, startFlagStillSet]) {
      expect(run.linq.requests).toEqual([]);
      expect(run.store.marks).toEqual([]);
      expect(run.logged).not.toContain("+1555");
      expect(run.logged).not.toContain("booked");
    }
  });
});
