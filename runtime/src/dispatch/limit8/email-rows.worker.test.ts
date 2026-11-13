// Limit 8 for email rows (T-1283; ADR-016 section 3 and its card E1; C-124, C-125), run inside the Workers runtime
// (Vitest project "workers"): limit 8's own decision, and the real dispatcher against T-257's and T-259's fakes
// (../test-support.ts) where a run ends at limit 8. The code row is K-05 v1.13's own (claim-sam-sign-in-code.json: Sam's
// sign-in code, an email row with no turn, class quick_reply, purpose code, its notAfter the code's expires_at), and its
// send state is what runtime/src/wiring/real.ts sendStateOf gives an email handle: no phone row (not stopped, no open
// chat) and no business (no zone and no text hours, empty values limit 8 cannot read). The lead note's limit 8 cases
// (ADR-016 section 3): at notAfter, the revoked contact, the 3:00am code row, the text row with no chat. Names are the
// master's sample cast, and no address is needed (rule 9). New York is on EST (UTC-5) from 2026-11-01.
import { describe, expect, it } from "vitest";

import claimSamSignInCode from "../../../../contracts/data-access/fixtures/claim-sam-sign-in-code.json";
import { decideLimit8, emailStopped, endPassed, isEmailRow, stopStands, type Limit8Decision } from "./limit8";
import { partsInZone } from "./text-hours";
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
import type {
  ClaimedRow,
  ClaimOutboxRequest,
  ClaimOutboxResponse,
  SendState,
  TextsConsentRead,
  TransientError,
  Utc,
} from "../types";

const ROW_ID = "out-sam-sign-in-nov02-code";
const SAM_EMAIL = "handle-sam-email";
/** The code's own line (ADR-016 section 1), in the row's final parts only: never in a span. */
const CODE_WORDS = "Code 482913: type it on the sign-in page. It works for 10 minutes.";
/** The dispatch after the code's commit claims the row (the fixture's now): 8:00:02am in New York. */
const CLAIMED_AT = "2026-11-02T13:00:02Z";
/** The code's end, its expires_at: 10 minutes after it was made at 13:00:01Z (RULES 6.2). */
const NOT_AFTER = "2026-11-02T13:10:01Z";
/** Minute 9 of the code's life, when its first try fails in the retry case. */
const MINUTE_9 = "2026-11-02T13:09:01Z";
/** 3:00:02am in New York on Mon Nov 2 (EST): outside every text hour. */
const THREE_AM = "2026-11-02T08:00:02Z";

const plus = (at: Utc, ms: number): Utc => new Date(Date.parse(at) + ms).toISOString();

/** A claim taken at `at`, as K-05 v1.1 writes a first one (lapses 60 s later). */
const claimAt = (at: Utc): ClaimedRow["claim"] => ({
  claimer: "dispatcher-1",
  claimedAt: at,
  lapsesAt: plus(at, 60_000),
  claimNo: 1,
  firstTryAt: null,
  nextTryNotBefore: null,
});

/** Sam's code row as K-05 v1.13 claims it (claim-sam-sign-in-code.json), in the dispatcher's shape, with what differs. */
function codeRow(overrides: Partial<ClaimedRow> = {}): ClaimedRow {
  return {
    outboxRowId: ROW_ID,
    version: 3,
    commitSeq: 1,
    recipientHandleId: SAM_EMAIL,
    recipientPersonId: "person-sam",
    businessId: null,
    bookingId: null,
    openQuestionId: null,
    channel: "email",
    port: "email",
    sendClass: "quick_reply",
    versionsRead: [],
    finalParts: {
      row: ROW_ID,
      channel: "email",
      sends: [words(CODE_WORDS)],
      fixedLines: [],
      threadReplyTo: null,
    },
    parts: [{ partNo: 1, tryNo: 1, idempotencyKey: `${ROW_ID}/1/1`, attempts: 1, sent: false }],
    traceId: "trace-page-sam-nov02-1300",
    claim: { ...claimAt(CLAIMED_AT), lapsesAt: "2026-11-02T13:01:02Z" },
    claimedFrom: "checked",
    emailPurpose: "code",
    notAfter: NOT_AFTER,
    ...overrides,
  };
}

/** The same code row made at 3:00:01am in New York: claimed at 3:00:02am, its end at 3:10:01am. */
const threeAmRow = (overrides: Partial<ClaimedRow> = {}): ClaimedRow =>
  codeRow({ claim: claimAt(THREE_AM), notAfter: "2026-11-02T08:10:01Z", ...overrides });

/** The code row claimed again for its retry: its first try failed at minute 9, so try 2 goes under a new key. */
const retried = (at: Utc): ClaimedRow =>
  codeRow({
    version: 6,
    parts: [{ partNo: 1, tryNo: 2, idempotencyKey: `${ROW_ID}/1/2`, attempts: 1, sent: false }],
    claim: { ...claimAt(at), claimNo: 2, firstTryAt: MINUTE_9 },
    claimedFrom: "sending",
  });

/** The code row's twin on a text channel: to Ben's phone by the linq port, naming no purpose, as a text row never does. */
const textTwin = (channel: string, overrides: Partial<ClaimedRow> = {}): ClaimedRow =>
  codeRow({
    recipientHandleId: "handle-ben",
    recipientPersonId: "person-ben",
    channel,
    port: "linq",
    finalParts: { ...codeRow().finalParts, channel },
    emailPurpose: null,
    ...overrides,
  });

/**
 * Sam's email handle's send state as wiring/real.ts sendStateOf gives it: no phone row (not stopped, no stop time, no
 * open chat), no texts row (he never wrote to Rosie from that address), the audience customer (a row with no business:
 * K-05 default 31) and, with no business, no zone and no text hours: empty values, which limit 8 cannot read.
 */
const emailState = (patch: Partial<SendState> = {}): SendState => ({
  stopped: false,
  stopAt: null,
  textsConsent: null,
  chatOpen: false,
  audience: "customer",
  visitZone: null,
  businessZone: "",
  textHours: { start: "", end: "" },
  textHoursOverride: false,
  currentVersions: [],
  closed: { booking: false, question: false },
  ...patch,
});

/** Ben's phone, not stopped, never texted Rosie (no open chat, as send-state-no-chat.json reads Dee's), in New York. */
const phoneNoChat = (patch: Partial<SendState> = {}): SendState =>
  emailState({ businessZone: "America/New_York", textHours: { start: "08:00", end: "20:00" }, ...patch });

/** The same send state from a reader that gives no texts row at all (the field left out). */
function withoutTextsRow(state: SendState): SendState {
  const read = { ...state };
  delete read.textsConsent;
  return read;
}

/**
 * A STOP for Sam's email address as K-29 would hold one: the newest texts row covering the contact, for a row with no
 * business one covering every business (K-05 item 28, default 35). It withdraws texts, so it is no yes (default 82).
 */
const EMAIL_STOP: TextsConsentRead = {
  consentId: "consent-sam-email-stop",
  businessId: null,
  revoked: true,
  at: "2026-11-02T12:59:00Z",
  fromContact: false,
  bookingId: null,
};
/** A newer texts row for the address that does not withdraw (a START from it): no stop. */
const EMAIL_START: TextsConsentRead = {
  ...EMAIL_STOP,
  consentId: "consent-sam-email-start",
  revoked: false,
  at: "2026-11-02T12:59:30Z",
};

const SEND: Limit8Decision = { action: "send", reason: "sameTurn", overrideOptout: false };
const WITHDRAWN: Limit8Decision = { action: "mark", outcome: "withdrawn", heldUntil: null };
const DROPPED: Limit8Decision = { action: "mark", outcome: "droppedStopped", heldUntil: null };
const WAITING: Limit8Decision = { action: "mark", outcome: "waitingChat", heldUntil: null };

/** Limit 8's decision on staging, where the code goes (ADR-016 section 5). */
const decide = (row: ClaimedRow, state: SendState, now: Utc, partOut = false): Limit8Decision =>
  decideLimit8({ row, state, now, honourOverride: true, partOut });

/** K-05 v1.13's two claim fields for a seeded row, by its id. */
type Ends = Readonly<Record<string, Pick<ClaimedRow, "emailPurpose" | "notAfter">>>;

/**
 * T-257's fake store answering its claim in K-05 v1.13's form: each claimed row also names its emailPurpose and notAfter
 * (item 64), as claim-sam-sign-in-code.json does. Every other call is the fake's own.
 */
class FakeStoreV113 extends FakeOutboxStore {
  constructor(
    seeds: readonly SeedRow[],
    private readonly ends: Ends,
  ) {
    super(seeds);
  }

  override async claimOutbox(request: ClaimOutboxRequest): Promise<ClaimOutboxResponse | TransientError> {
    const answer = await super.claimOutbox(request);
    if ("error" in answer) return answer;
    return { ...answer, claimed: answer.claimed.map((row) => ({ ...row, ...this.ends[row.outboxRowId] })) };
  }
}

/** The code row as the fake store holds it: one part, to Sam's email handle, by the email port. */
const CODE_SEED: SeedRow = {
  id: ROW_ID,
  recipient: SAM_EMAIL,
  commitSeq: 1,
  channel: "email",
  port: "email",
  sendClass: "quick_reply",
  sends: [words(CODE_WORDS)],
};
const CODE_ENDS: Ends = { [ROW_ID]: { emailPurpose: "code", notAfter: NOT_AFTER } };

interface Setup {
  clock: FakeClock;
  store: FakeStoreV113;
  linq: FakeLinq;
  state: FakeSendState;
  spans: Span[];
  /** Every recipient the dispatcher asked for a chat. */
  asked: string[];
  deps: () => DispatchDeps;
}

function setup(seeds: readonly SeedRow[], ends: Ends, start: Utc): Setup {
  const clock = new FakeClock(start);
  const store = new FakeStoreV113(seeds, ends);
  const linq = new FakeLinq(clock.now);
  const state = new FakeSendState();
  const spans: Span[] = [];
  const asked: string[] = [];
  const recipients = new FakeRecipients({});
  recipients.beforeAnswer = (handle): Promise<void> => {
    asked.push(handle);
    return Promise.resolve();
  };
  // Sam's email handle as sendStateOf reads it (no phone row, no business); Ben's phone keeps the fake's own defaults.
  state.forHandle(SAM_EMAIL, {
    chatOpen: false,
    textsConsent: null,
    businessZone: "",
    textHours: { start: "", end: "" },
  });
  return {
    clock,
    store,
    linq,
    state,
    spans,
    asked,
    deps: () => ({
      store,
      linq,
      recipients,
      sendState: state,
      environment: "staging",
      traceFor: traceCollector(spans),
      now: clock.now,
      claimer: "dispatcher-1",
      limit: 100,
    }),
  };
}

/** Each dispatch span as [row id, outcome, limit 8's result and outcome, the claim it ran under]. */
const spanSummary = (spans: readonly Span[]): unknown[] =>
  spans
    .filter((span) => span.hop === "dispatch")
    .map((span) => [
      span.rows?.[0]?.id,
      span.outcome,
      span.limits?.map((limit) => [limit.limit, limit.result, limit.outcome]),
      span.decided?.claimNo,
    ]);

describe("the code row is K-05 v1.13's own (claim-sam-sign-in-code.json)", () => {
  it("holds the fixture's claimed row field for field, its purpose code and its notAfter among them", () => {
    expect(claimSamSignInCode.request.now).toBe(CLAIMED_AT);
    expect(claimSamSignInCode.outcome.claimed).toHaveLength(1);
    // The dispatcher's shape leaves out only K-03's slot values, which it never reads (wiring/real.ts claimedRowOf).
    expect(claimSamSignInCode.outcome.claimed[0]).toMatchObject(codeRow());
    expect(isEmailRow(codeRow())).toBe(true);
    // The 3:00am row is the same row made five hours earlier, its end still 10 minutes after it was made.
    expect(partsInZone(Date.parse(THREE_AM), "America/New_York").minutes).toBe(180);
    expect(Date.parse(threeAmRow().notAfter ?? "") - Date.parse(THREE_AM)).toBe(
      Date.parse(NOT_AFTER) - Date.parse(CLAIMED_AT),
    );
  });
});

describe("at its notAfter the row is withdrawn, unsent, at every try (ADR-016 section 3)", () => {
  it("the code row claimed at its notAfter is withdrawn; a moment before it, it goes", () => {
    expect(decide(codeRow(), emailState(), NOT_AFTER)).toEqual(WITHDRAWN);
    expect(decide(codeRow(), emailState(), plus(NOT_AFTER, 1))).toEqual(WITHDRAWN);
    expect(decide(codeRow(), emailState(), "2026-11-03T13:10:01Z")).toEqual(WITHDRAWN);
    expect(decide(codeRow(), emailState(), plus(NOT_AFTER, -1))).toEqual(SEND);
    expect(decide(codeRow(), emailState(), CLAIMED_AT)).toEqual(SEND);
    expect([endPassed(codeRow(), NOT_AFTER), endPassed(codeRow(), plus(NOT_AFTER, -1))]).toEqual([
      true,
      false,
    ]);
  });

  it("at every try: a re-claim after a lapsed claim, a retry after a first try that failed at minute 9, a second part after the first went", () => {
    const tries: [string, (at: Utc) => ClaimedRow, boolean][] = [
      ["a first claim", (at) => codeRow({ claim: claimAt(at) }), false],
      ["a re-claim of a lapsed claim", (at) => codeRow({ claim: { ...claimAt(at), claimNo: 2 } }), false],
      ["a retry after minute 9's failed try", retried, false],
      ["a second part after the first went", (at) => codeRow({ claim: claimAt(at) }), true],
    ];
    for (const [name, rowAt, partOut] of tries) {
      for (const at of [NOT_AFTER, plus(NOT_AFTER, 1_000), plus(NOT_AFTER, 3_600_000)]) {
        expect([name, at, decide(rowAt(at), emailState(), at, partOut)]).toEqual([name, at, WITHDRAWN]);
      }
      const before = plus(NOT_AFTER, -1);
      const goes = partOut ? { action: "send", reason: "partOut", overrideOptout: false } : SEND;
      expect([name, decide(rowAt(before), emailState(), before, partOut)]).toEqual([name, goes]);
    }
  });

  it("before anything else but the SMS refusal: at its end a row is withdrawn whatever its stop, chat, class, versions or hours", () => {
    const routineAtNight = textTwin("imessage", { sendClass: "routine", notAfter: THREE_AM });
    const stopReply = textTwin("rcs", {
      finalParts: { ...textTwin("rcs").finalParts, fixedLines: ["stopReply"] },
    });
    const cases: [string, ClaimedRow, SendState][] = [
      ["a revoked address", codeRow(), emailState({ textsConsent: EMAIL_STOP })],
      ["no texts row read", codeRow(), withoutTextsRow(emailState())],
      ["an email safety line", codeRow({ sendClass: "safety" }), emailState()],
      [
        "a stopped phone's safety line",
        textTwin("imessage", { sendClass: "safety" }),
        phoneNoChat({ stopped: true, stopAt: "2026-11-02T12:00:00Z" }),
      ],
      ["a stop reply to a stopped phone", stopReply, phoneNoChat({ stopped: true })],
      ["a phone with no open chat", textTwin("imessage"), phoneNoChat()],
      ["a routine text at 3:00am", routineAtNight, phoneNoChat({ chatOpen: true })],
      [
        "read versions that moved",
        codeRow({ versionsRead: [{ table: "bookings", rowId: "booking-sam-x", version: 1 }] }),
        emailState(),
      ],
    ];
    for (const [name, row, state] of cases) {
      expect([name, decide(row, state, row.notAfter ?? NOT_AFTER)]).toEqual([name, WITHDRAWN]);
    }
    // The SMS refusal alone comes first: there is no SMS port, and it has no K-05 move (CQ-55 (1)).
    expect(decide(textTwin("sms", { port: "sms" }), phoneNoChat(), NOT_AFTER)).toEqual({
      action: "refuseSms",
    });
  });

  it("a code row with no end, or an end or a clock that is not a time, is withdrawn, never sent (fails closed)", () => {
    const leftOut = codeRow();
    delete leftOut.notAfter;
    const rows: [string, ClaimedRow, Utc][] = [
      ["no end", codeRow({ notAfter: null }), CLAIMED_AT],
      ["its end left out", leftOut, CLAIMED_AT],
      ["an end that is not a time", codeRow({ notAfter: "ten minutes" }), CLAIMED_AT],
      ["a clock that is not a time", codeRow(), "now"],
    ];
    for (const [name, row, now] of rows) {
      expect([name, endPassed(row, now), decide(row, emailState(), now)]).toEqual([name, true, WITHDRAWN]);
    }
  });

  it("a row with no end goes on as before: an email row of another purpose, a v1.12 answer, a text row", () => {
    const v112 = codeRow();
    delete v112.emailPurpose;
    delete v112.notAfter;
    const v112Text = textTwin("imessage");
    delete v112Text.emailPurpose;
    delete v112Text.notAfter;
    const rows: [string, ClaimedRow, SendState][] = [
      ["a confirmation with no end", codeRow({ emailPurpose: "confirmation", notAfter: null }), emailState()],
      ["an email row of v1.12", v112, emailState()],
      ["a text row of v1.12", v112Text, phoneNoChat({ chatOpen: true })],
    ];
    for (const [name, row, state] of rows) {
      const late = "2026-11-09T13:00:00Z";
      expect([name, endPassed(row, late), decide(row, state, late)]).toEqual([name, false, SEND]);
    }
  });

  it("through the dispatcher: claimed at its notAfter, it is marked withdrawn, with no chat asked, no renewal and nothing sent, and never claimed again", async () => {
    const t = setup([CODE_SEED], CODE_ENDS, NOT_AFTER);

    const report = await runDispatch(t.deps(), { recipientHandleId: SAM_EMAIL });

    expect(report.rows.map((row) => [row.outboxRowId, row.outcome, row.partsSent])).toEqual([
      [ROW_ID, "withdrawn", 0],
    ]);
    expect(
      t.store.rowMarks.map((mark) => [mark.request.outcome, mark.request.heldUntil, mark.answer]),
    ).toEqual([["withdrawn", null, "withdrawn"]]);
    expect(t.store.row(ROW_ID).state).toBe("withdrawn");
    expect(t.linq.requests).toEqual([]);
    expect(t.asked).toEqual([]);
    expect(t.store.renewals).toEqual([]);
    expect(t.store.marks).toEqual([]);
    expect(spanSummary(t.spans)).toEqual([[ROW_ID, "dropped", [[8, "fail", "withdrawn"]], 1]]);
    expect(JSON.stringify(t.spans)).not.toContain("482913");

    t.clock.advance(60_000);
    expect((await runDispatch(t.deps(), { recipientHandleId: SAM_EMAIL })).claimed).toBe(0);
    expect(t.linq.requests).toEqual([]);
  });

  it("through the dispatcher: a first try that failed at minute 9 leaves its retry to minute 10, which withdraws it unsent", async () => {
    const t = setup([CODE_SEED], CODE_ENDS, MINUTE_9);
    // Minute 9's try as the store records it: the claim, the renewal that starts the tries, the failure with a retry.
    const first = await t.store.claimOutbox({ claimer: "dispatcher-1", now: MINUTE_9, limit: 10 });
    expect("error" in first ? first : first.claimed.map((row) => [row.outboxRowId, row.notAfter])).toEqual([
      [ROW_ID, NOT_AFTER],
    ]);
    const renewed = await t.store.renewClaim({
      outboxRowId: ROW_ID,
      claimer: "dispatcher-1",
      claimNo: 1,
      idempotencyKey: `${ROW_ID}/1/1`,
      at: MINUTE_9,
    });
    expect("error" in renewed ? renewed : renewed.claim.firstTryAt).toBe(MINUTE_9);
    const failed = await t.store.markPart({
      outcome: "failed",
      idempotencyKey: `${ROW_ID}/1/1`,
      errorCode: "transient",
      retry: true,
      at: MINUTE_9,
    });
    expect("error" in failed ? failed : failed.nextKey).toBe(`${ROW_ID}/1/2`);

    // The retry's run comes at minute 10, when the claim has lapsed: the row is claimed again and withdrawn.
    t.clock.advance(Date.parse(NOT_AFTER) - Date.parse(MINUTE_9));
    const retry = await runDispatch(t.deps(), { recipientHandleId: SAM_EMAIL });

    expect(retry.rows.map((row) => [row.outboxRowId, row.outcome, row.partsSent])).toEqual([
      [ROW_ID, "withdrawn", 0],
    ]);
    expect(spanSummary(t.spans)).toEqual([[ROW_ID, "dropped", [[8, "fail", "withdrawn"]], 2]]);
    expect(t.store.tries(ROW_ID).map((part) => [part.key, part.state])).toEqual([
      [`${ROW_ID}/1/1`, "failed"],
      [`${ROW_ID}/1/2`, "pending"],
    ]);
    expect(t.store.row(ROW_ID).state).toBe("withdrawn");
    expect(t.linq.requests).toEqual([]);
    expect(t.asked).toEqual([]);
  });

  it("through the dispatcher: a row whose dispatch never ran is withdrawn at its next wake, after its end", async () => {
    // The request's isolate ended before its dispatch (ADR-016 section 2; open point 6): the next code's wake comes later.
    const t = setup([CODE_SEED], CODE_ENDS, "2026-11-02T13:25:00Z");

    const report = await runDispatch(t.deps(), { recipientHandleId: SAM_EMAIL });

    expect(report.rows.map((row) => [row.outcome, row.partsSent])).toEqual([["withdrawn", 0]]);
    expect(t.linq.requests).toEqual([]);
    expect(t.asked).toEqual([]);
  });
});

describe("the revoked contact: an email address's stop is its newest texts consent row (ADR-016 section 3; K-05 item 28)", () => {
  it("the code row to an address whose newest texts row is revoked is droppedStopped, at any hour, whatever its class", () => {
    const state = emailState({ textsConsent: EMAIL_STOP });
    const rows: [string, ClaimedRow][] = [
      ["the code row", codeRow()],
      ["routine", codeRow({ sendClass: "routine", emailPurpose: "confirmation", notAfter: null })],
      ["a visit happening now", codeRow({ sendClass: "visit_now", emailPurpose: "nextWay", notAfter: null })],
      ["a safety line", codeRow({ sendClass: "safety", emailPurpose: "nextWay", notAfter: null })],
      ["a stop reply", codeRow({ finalParts: { ...codeRow().finalParts, fixedLines: ["stopReply"] } })],
    ];
    for (const [name, row] of rows) {
      for (const at of [CLAIMED_AT, THREE_AM]) {
        expect([name, at, decide(row, state, at)]).toEqual([name, at, DROPPED]);
      }
      expect([name, stopStands(row, state)]).toEqual([name, true]);
    }
    // A second part never goes to a stopped address either.
    expect(decide(codeRow(), state, CLAIMED_AT, true)).toEqual(DROPPED);
    expect(emailStopped(state)).toBe(true);
  });

  it("a newest texts row that does not withdraw, or none, is no stop: the code goes", () => {
    for (const textsConsent of [EMAIL_START, null]) {
      const state = emailState({ textsConsent });
      expect([textsConsent?.consentId, decide(codeRow(), state, CLAIMED_AT)]).toEqual([
        textsConsent?.consentId,
        SEND,
      ]);
      expect([emailStopped(state), stopStands(codeRow(), state)]).toEqual([false, false]);
    }
  });

  it("a send state that read no texts row cannot show the stop: nothing is sent or marked (unreadable), and the stop stands", () => {
    const state = withoutTextsRow(emailState());

    expect(decide(codeRow(), state, CLAIMED_AT)).toEqual({ action: "unreadable" });
    expect(decide(codeRow(), state, CLAIMED_AT, true)).toEqual({ action: "unreadable" });
    expect([emailStopped(state), stopStands(codeRow(), state)]).toEqual([null, true]);
  });

  it("a text row keeps the phone's stop as it was: a revoked texts row never stops a phone that is not stopped (STATE note 10)", () => {
    const state = phoneNoChat({ chatOpen: true, textsConsent: EMAIL_STOP });
    for (const channel of ["imessage", "rcs", "sms"]) {
      expect([channel, decide(textTwin(channel), state, CLAIMED_AT)]).toEqual([channel, SEND]);
      expect([channel, stopStands(textTwin(channel), state)]).toEqual([channel, false]);
    }
    // A stopped phone still gets its safety line, with the opt-out override, whatever its texts row says (T-1099).
    expect(
      decide(textTwin("imessage", { sendClass: "safety" }), { ...state, stopped: true }, CLAIMED_AT),
    ).toEqual({ action: "send", reason: "safety", overrideOptout: true });
  });

  it("through the dispatcher: the revoked contact's code row is marked droppedStopped, with no chat asked and nothing sent", async () => {
    const t = setup([CODE_SEED], CODE_ENDS, CLAIMED_AT);
    t.state.forHandle(SAM_EMAIL, { textsConsent: EMAIL_STOP });

    const report = await runDispatch(t.deps(), { recipientHandleId: SAM_EMAIL });

    expect(report.rows.map((row) => [row.outboxRowId, row.outcome, row.partsSent])).toEqual([
      [ROW_ID, "droppedStopped", 0],
    ]);
    expect(t.store.row(ROW_ID).state).toBe("dropped_stopped");
    expect(t.store.rowMarks.map((mark) => mark.request.outcome)).toEqual(["droppedStopped"]);
    expect(spanSummary(t.spans)).toEqual([[ROW_ID, "dropped", [[8, "fail", "droppedStopped"]], 1]]);
    // No texts yes was weighed: an email row's stop is its texts row as it stands.
    expect(t.spans.map((span) => span.decided?.textsYes ?? null)).toEqual([null]);
    expect(t.linq.requests).toEqual([]);
    expect(t.asked).toEqual([]);
    expect(t.store.renewals).toEqual([]);
  });

  it("through the dispatcher: with no texts row read nothing is sent or marked, and the row keeps its claim", async () => {
    const t = setup([CODE_SEED], CODE_ENDS, CLAIMED_AT);
    const noTextsRow = new FakeSendState().forHandle(SAM_EMAIL, { chatOpen: false });

    const report = await runDispatch(
      { ...t.deps(), sendState: noTextsRow },
      { recipientHandleId: SAM_EMAIL },
    );

    expect(report.rows.map((row) => [row.outcome, row.partsSent])).toEqual([["unreadable", 0]]);
    expect(t.store.rowMarks).toEqual([]);
    expect(t.store.row(ROW_ID).state).toBe("sending");
    expect(t.linq.requests).toEqual([]);
    expect(t.asked).toEqual([]);
  });
});

describe("the chat rule is a text rule: the 3:00am code row and the text row with no chat (ADR-016 section 3)", () => {
  it("the 3:00am code row: to an email handle with no phone row and no open chat, at 3:00am, it goes as a quick reply, reading no zone", () => {
    for (const honourOverride of [true, false]) {
      expect(
        decideLimit8({
          row: threeAmRow(),
          state: emailState(),
          now: THREE_AM,
          honourOverride,
          partOut: false,
        }),
      ).toEqual(SEND);
    }
    // Were it routine it would read the hours in a zone, which a row with no business has not: unreadable.
    expect(decide(threeAmRow({ sendClass: "routine" }), emailState(), THREE_AM)).toEqual({
      action: "unreadable",
    });
  });

  it("an email row goes on to the checks after the chat rule: a safety line goes, a stale row is composed again, a routine row waits for text hours", () => {
    // A confirmation about Sam's booking at Lee's, to his email handle with no open chat, at 3:00am in New York.
    const withBusiness = emailState({
      businessZone: "America/New_York",
      textHours: { start: "08:00", end: "20:00" },
    });
    const confirmation = threeAmRow({
      businessId: "biz-lees-barbershop",
      bookingId: "booking-sam-nov20",
      sendClass: "routine",
      versionsRead: [{ table: "bookings", rowId: "booking-sam-nov20", version: 1 }],
      emailPurpose: "confirmation",
      notAfter: null,
    });
    const current = { ...withBusiness, currentVersions: confirmation.versionsRead };

    expect(decide({ ...confirmation, sendClass: "safety" }, current, THREE_AM)).toEqual({
      action: "send",
      reason: "safety",
      overrideOptout: false,
    });
    const moved = [{ table: "bookings", rowId: "booking-sam-nov20", version: 2 }];
    expect(decide(confirmation, { ...current, currentVersions: moved }, THREE_AM)).toEqual({
      action: "mark",
      outcome: "stale",
      heldUntil: null,
    });
    // 9am in New York, when a customer's text hours open (RULES 4.3).
    expect(decide(confirmation, current, THREE_AM)).toEqual({
      action: "mark",
      outcome: "held",
      heldUntil: "2026-11-02T14:00:00.000Z",
    });
  });

  it("the text row with no chat: the code row's twin on a text channel to a phone with no open chat waits at 3:00am, whatever its class", () => {
    for (const channel of ["imessage", "rcs", "sms"]) {
      for (const sendClass of ["quick_reply", "routine", "visit_now", "safety"]) {
        const row = textTwin(channel, {
          sendClass,
          claim: claimAt(THREE_AM),
          notAfter: "2026-11-02T08:10:01Z",
        });
        expect([channel, sendClass, decide(row, phoneNoChat(), THREE_AM)]).toEqual([
          channel,
          sendClass,
          WAITING,
        ]);
      }
    }
  });

  it("a row whose channel and port disagree is read as a text row: with no open chat it waits", () => {
    const portLeftOut = codeRow();
    delete portLeftOut.port;
    const rows: [string, ClaimedRow][] = [
      ["the email channel by linq", codeRow({ port: "linq" })],
      ["the email channel with no port named", portLeftOut],
      ["a text channel by the email port", codeRow({ channel: "imessage" })],
    ];
    for (const [name, row] of rows) {
      expect([name, isEmailRow(row), decide(row, emailState(), CLAIMED_AT)]).toEqual([name, false, WAITING]);
    }
  });

  it("through the dispatcher: the text row with no chat at 3:00am is parked for its chat and nothing is sent", async () => {
    const twin: SeedRow = {
      ...CODE_SEED,
      id: "out-ben-twin",
      recipient: "handle-ben",
      channel: "imessage",
      port: "linq",
    };
    const t = setup(
      [twin],
      { "out-ben-twin": { emailPurpose: null, notAfter: "2026-11-02T08:10:01Z" } },
      THREE_AM,
    );
    t.state.forHandle("handle-ben", { chatOpen: false });

    const report = await runDispatch(t.deps(), { recipientHandleId: "handle-ben" });

    expect(report.rows.map((row) => [row.outboxRowId, row.outcome, row.partsSent])).toEqual([
      ["out-ben-twin", "waitingChat", 0],
    ]);
    expect(t.store.row("out-ben-twin")).toMatchObject({ state: "waiting_chat", claim: null });
    expect(t.linq.requests).toEqual([]);
    expect(t.asked).toEqual([]);
  });
});
