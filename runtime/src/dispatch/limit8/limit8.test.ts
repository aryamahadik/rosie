// Limit 8's closed-question check, on decideLimit8 alone (T-1538; DL-1171, DL-1174; K-07 README's withdrawn, line 29 and
// line 53). The dispatcher's own cases are in limit8.worker.test.ts. The row is built from the Nov 22 turn's shape: a
// checked S1-02 row as the walk writes it (actions/src/commit/walk/writes.ts, asked: send class quick_reply, naming the
// question it asks, reading no versions), with no business (sign-up), to Sam's handle. Phones are not needed here;
// names are the master's sample cast (rule 9).
import { describe, expect, it } from "vitest";

import { decideLimit8, questionClosed, type Limit8Input } from "./limit8";
import type { ClaimedRow, SendState } from "../types";

/** 21:54Z on Nov 22, when the claim passed the stuck row and sent this one. */
const CLAIM_AT = "2026-11-22T21:54:00.000Z";
/** 11pm on Nov 22 in New York (EST), outside every text window. */
const NIGHT_NY = "2026-11-23T04:00:00.000Z";
const ROW = "outbox-s1-02-turn-sam-1936-1";
const QUESTION = "oq-s1-02-turn-sam-1936";

/** The 19:36Z turn's row as limit 8 is handed it at the claim. */
const s102Row = (overrides: Partial<ClaimedRow> = {}): ClaimedRow => ({
  outboxRowId: ROW,
  version: 4,
  commitSeq: 7,
  recipientHandleId: "handle-sam",
  recipientPersonId: "person-sam",
  businessId: null,
  bookingId: null,
  openQuestionId: QUESTION,
  channel: "imessage",
  port: "linq",
  sendClass: "quick_reply",
  versionsRead: [],
  finalParts: {
    row: ROW,
    channel: "imessage",
    sends: [{ kind: "words", text: "S1-02's question.", calendarFile: "none", options: [], link: null }],
    fixedLines: [],
    threadReplyTo: null,
  },
  parts: [{ partNo: 1, tryNo: 1, idempotencyKey: `${ROW}/1/1`, attempts: 1, sent: false }],
  traceId: "trace-s1-02-turn-sam-1936",
  claim: {
    claimer: "dispatcher-1",
    claimedAt: CLAIM_AT,
    lapsesAt: "2026-11-22T21:55:00.000Z",
    claimNo: 1,
    firstTryAt: null,
    nextTryNotBefore: null,
  },
  claimedFrom: "checked",
  ...overrides,
});

/**
 * Sam's send state at the claim, as the wiring maps K-05's answer for a row with no business (wiring/real.ts sendStateOf:
 * no zone and no text hours, each empty), an open chat, not stopped; the question open unless a case closes it.
 */
const samState = (overrides: Partial<SendState> = {}): SendState => ({
  stopped: false,
  stopAt: null,
  textsConsent: null,
  chatOpen: true,
  audience: "customer",
  visitZone: null,
  businessZone: "",
  textHours: { start: "", end: "" },
  textHoursOverride: false,
  currentVersions: [],
  closed: { booking: false, question: false },
  ...overrides,
});

/** The roster reset's withdrawal (db/seeds/roster-reset.ts): the question withdrawn, which K-05 reads as closed. */
const QUESTION_CLOSED = { booking: false, question: true } as const;

const decide = (input: Partial<Limit8Input> = {}): ReturnType<typeof decideLimit8> =>
  decideLimit8({
    row: s102Row(),
    state: samState(),
    now: CLAIM_AT,
    honourOverride: true,
    partOut: false,
    ...input,
  });

const WITHDRAWN = { action: "mark", outcome: "withdrawn", heldUntil: null };

describe("a row whose open question closed before its claim is withdrawn unsent (T-1538)", () => {
  it("withdraws the checked S1-02 row whose question the reset withdrew, though it read no versions", () => {
    const state = samState({ closed: QUESTION_CLOSED });

    expect(questionClosed(s102Row(), state)).toBe(true);
    expect(decide({ state })).toEqual(WITHDRAWN);
  });

  it("sends the same row as today while its question is still open (a same-turn reply)", () => {
    expect(questionClosed(s102Row(), samState())).toBe(false);
    expect(decide()).toEqual({ action: "send", reason: "sameTurn", overrideOptout: false });
  });

  it("withdraws it whether or not the versions it read moved", () => {
    const read = [{ table: "open_questions", rowId: QUESTION, version: 1 }];
    const row = s102Row({ versionsRead: read });

    // Unchanged: the question check alone withdraws it.
    expect(decide({ row, state: samState({ currentVersions: read, closed: QUESTION_CLOSED }) })).toEqual(
      WITHDRAWN,
    );
    // Moved by the withdrawal (version raised by one): withdrawn, as the stale path always did.
    const raised = [{ table: "open_questions", rowId: QUESTION, version: 2 }];
    expect(decide({ row, state: samState({ currentVersions: raised, closed: QUESTION_CLOSED }) })).toEqual(
      WITHDRAWN,
    );
    // Moved with the question still open (asked again): stale and composed again, as before.
    expect(decide({ row, state: samState({ currentVersions: raised }) })).toEqual({
      action: "mark",
      outcome: "stale",
      heldUntil: null,
    });
  });

  it("withdraws a routine row asking a closed question at night, rather than holding it for text hours", () => {
    const row = s102Row({ sendClass: "routine", businessId: "biz-lees-barbershop" });
    const hours = { businessZone: "America/New_York", textHours: { start: "09:00", end: "20:00" } };

    expect(decide({ row, now: NIGHT_NY, state: samState({ ...hours, closed: QUESTION_CLOSED }) })).toEqual(
      WITHDRAWN,
    );
    // Its question open, it is held as before.
    expect(decide({ row, now: NIGHT_NY, state: samState(hours) })).toMatchObject({
      action: "mark",
      outcome: "held",
    });
  });

  it("withdraws an email row asking a closed question too (an email row skips the chat rule, not this one)", () => {
    const row = s102Row({ channel: "email", port: "email", sendClass: "quick_reply" });

    expect(decide({ row, state: samState({ chatOpen: false, closed: QUESTION_CLOSED }) })).toEqual(WITHDRAWN);
  });

  it("never withdraws a row that asks no question on that read alone", () => {
    const row = s102Row({ openQuestionId: null });
    const state = samState({ closed: QUESTION_CLOSED });

    expect(questionClosed(row, state)).toBe(false);
    expect(decide({ row, state })).toEqual({ action: "send", reason: "sameTurn", overrideOptout: false });
  });
});

describe("limit 8's order is unchanged around the question check (T-1538)", () => {
  const state = (overrides: Partial<SendState> = {}): SendState =>
    samState({ closed: QUESTION_CLOSED, ...overrides });

  it("a stopped phone still drops the row as stopped, first", () => {
    expect(decide({ state: state({ stopped: true }) })).toEqual({
      action: "mark",
      outcome: "droppedStopped",
      heldUntil: null,
    });
  });

  it("a phone with no open chat still parks it waiting for the chat", () => {
    expect(decide({ state: state({ chatOpen: false }) })).toEqual({
      action: "mark",
      outcome: "waitingChat",
      heldUntil: null,
    });
  });

  it("a row with a part already out still goes whole", () => {
    expect(decide({ state: state(), partOut: true })).toEqual({
      action: "send",
      reason: "partOut",
      overrideOptout: false,
    });
  });

  it("a safety line and a stop reply still go, with no check of versions or question", () => {
    expect(decide({ row: s102Row({ sendClass: "safety" }), state: state() })).toEqual({
      action: "send",
      reason: "safety",
      overrideOptout: false,
    });
    const stopReply = s102Row({ finalParts: { ...s102Row().finalParts, fixedLines: ["stopReply"] } });
    expect(decide({ row: stopReply, state: state() })).toEqual({
      action: "send",
      reason: "stopReply",
      overrideOptout: false,
    });
  });

  it("a row past its end is still withdrawn at its end, before anything is read", () => {
    const row = s102Row({ notAfter: "2026-11-22T21:50:00.000Z" });

    expect(decide({ row, state: samState() })).toEqual(WITHDRAWN);
  });
});
