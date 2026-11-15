// The dispatcher's email branch (T-1286, "T-264a"; ADR-016 section 3 and its card E2; C-124, C-129), run inside the
// Workers runtime (Vitest project "workers"): the real dispatcher, the real retry queue producer and consumer (T-256) and
// the real send door, against T-257's and T-259's fakes (./test-support.ts), with the email double as the email port
// (../email/test-support.ts: K-12's own shape checks and Resend's idempotency). The code row is K-05 v1.13's own
// (claim-sam-sign-in-code.json: Sam's sign-in code, an email row with no turn, class quick_reply, purpose code, its
// notAfter the code's expires_at), and its send state is what runtime/src/wiring/real.ts sendStateOf gives an email
// handle: no phone row (not stopped, no open chat) and no business (no zone and no text hours).
//
// The lead note's cases T-1283 did not prove (ADR-016 section 3): the code row's one email-port send, equal to K-12
// send-code.json's request, at 3:00am, to an email handle with no phone row and no open chat, and none by any other port;
// the retry after minute 10 of a first try that failed at minute 9; no code, address or attempt id in a span or a log
// line. With them, DL-703's: the stop and the end read again just before the send, an email row only by the email port,
// and no give-up of a row with no turn. Names are the master's sample cast and addresses are on the reserved example
// domains (rule 9). New York is on EST (UTC-5) from 2026-11-01.
import { describe, expect, it, vi } from "vitest";

import claimSamSignInCode from "../../../contracts/data-access/fixtures/claim-sam-sign-in-code.json";
import sendCode from "../../../contracts/port-email/fixtures/send-code.json";
import { ASSISTANT_LINE, CODE_SUBJECT, ROSIE_FROM_ADDRESS, type EmailSendRequest } from "../email";
import { RecordingEmailPort } from "../email/test-support";
import { consumeRetries } from "../queues";
import { batchOf, depsOf, fakeQueue, LOG, messageId, type FakeQueue } from "../queues/test-support";
import type { Span } from "../trace";
import { runDispatch, type DispatchDeps, type DispatchReport } from "./dispatcher";
import { dispatchSendDoor, queueRetries } from "./retry";
import {
  FakeClock,
  FakeLinq,
  FakeOutboxStore,
  FakeRecipients,
  FakeSendState,
  traceCollector,
  words,
  yieldToOthers,
  type SeedRow,
} from "./test-support";
import type {
  ChatTarget,
  ClaimedRow,
  ClaimOutboxRequest,
  ClaimOutboxResponse,
  SendState,
  SendStateReader,
  TextsConsentRead,
  TransientError,
  Utc,
} from "./types";

const ROW_ID = "out-sam-sign-in-nov02-code";
const SAM_EMAIL = "handle-sam-email";
/** Sam's proven address, his email handle's (K-22 seed-owner-id-upload.json; K-05 v1.13's sign-in fixtures). */
const SAM_ADDRESS = "sam@example.com";
/** The code's own line (ADR-016 section 1), in the row's final parts and the email's text only. */
const CODE_WORDS = "Code 482913: type it on the sign-in page. It works for 10 minutes.";
/** The code's six digits (S11-52's example): never in a span or a log line. */
const CODE = "482913";
/** The attempt's two ids (start-sign-in-sam.json): the server's, the row's job id, and the page's. */
const ATTEMPT_IDS = ["sign-in-sam-nov02-1300", "attempt-sam-signin-nov02"];
/** The dispatch after the code's commit claims the row (the fixture's now): 8:00:02am in New York. */
const CLAIMED_AT = "2026-11-02T13:00:02.000Z";
/** The code's end, its expires_at: 10 minutes after it was made at 13:00:01Z (RULES 6.2). */
const NOT_AFTER = "2026-11-02T13:10:01.000Z";
/** Minute 9 of the code's life, when its first try fails in the retry case. */
const MINUTE_9 = "2026-11-02T13:09:01.000Z";
/** 3:00:02am in New York on Mon Nov 2 (EST): outside every text hour. */
const THREE_AM = "2026-11-02T08:00:02.000Z";
/** A chat for Sam's email handle, which an email row never asks for (555-01xx: rule 9). */
const SAM_CHAT: ChatTarget = { to: "+15555550100", chatId: "linq-chat-demo-sam", service: "imessage" };

/** K-12's code email (send-code.json), as the port's request type (its JSON gives its labels as plain strings). */
const SEND_CODE = sendCode.request as unknown as EmailSendRequest;
/** send-code.json's row: the row of its part key (`<row>/1/1`). */
const SEND_CODE_ROW = SEND_CODE.idempotencyKey.slice(0, -"/1/1".length);
/** send-code.json's words: its text after the assistant line and a blank line (K-12 'The email row'). */
const SEND_CODE_WORDS = SEND_CODE.text.slice(`${SEND_CODE.assistantLine}\n\n`.length);

const plus = (at: Utc, ms: number): Utc => new Date(Date.parse(at) + ms).toISOString();

/** Sam's email handle's send state as wiring/real.ts sendStateOf gives it: no phone row, no texts row, no business. */
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

/** The same send state from a reader that gives no texts row at all (the field left out). */
function withoutTextsRow(state: SendState): SendState {
  const read = { ...state };
  delete read.textsConsent;
  return read;
}

/** A STOP for Sam's address as K-29 would hold one: the newest texts row covering the contact, withdrawing texts. */
const EMAIL_STOP: TextsConsentRead = {
  consentId: "consent-sam-email-stop",
  businessId: null,
  revoked: true,
  at: "2026-11-02T13:00:02Z",
  fromContact: false,
  bookingId: null,
};

/** A send-state reader that answers its reads in turn, the last again after that (limit 8's read, then the second). */
function readsInTurn(...states: readonly SendState[]): SendStateReader {
  let reads = 0;
  return {
    sendStateFor: () => {
      const state = states[Math.min(reads, states.length - 1)];
      reads += 1;
      return state === undefined ? Promise.reject(new Error("no send state given")) : Promise.resolve(state);
    },
  };
}

/** The code row as the fake store holds it: one words send, to Sam's email handle, by the email port. */
const codeSeed = (id = ROW_ID, text = CODE_WORDS): SeedRow => ({
  id,
  recipient: SAM_EMAIL,
  commitSeq: 1,
  channel: "email",
  port: "email",
  sendClass: "quick_reply",
  sends: [words(text)],
});

/** What K-05 v1.13's claim names that T-257's fake leaves out, for a seeded row by its id. */
type Extra = Readonly<Record<string, Partial<ClaimedRow>>>;

/** The code row's v1.13 claim fields (item 64: its purpose and its notAfter) and its person. */
const codeExtra = (id = ROW_ID, notAfter = NOT_AFTER): Extra => ({
  [id]: { recipientPersonId: "person-sam", emailPurpose: "code", notAfter },
});

/** T-257's fake store answering its claim in K-05 v1.13's form: each claimed row also names what `extra` gives it. */
class FakeStoreV113 extends FakeOutboxStore {
  constructor(
    seeds: readonly SeedRow[],
    private readonly extra: Extra,
  ) {
    super(seeds);
  }

  override async claimOutbox(request: ClaimOutboxRequest): Promise<ClaimOutboxResponse | TransientError> {
    const answer = await super.claimOutbox(request);
    if ("error" in answer) return answer;
    return { ...answer, claimed: answer.claimed.map((row) => ({ ...row, ...this.extra[row.outboxRowId] })) };
  }
}

/** T-257's recipients with the email handles' addresses beside the chats (RecipientDirectory.emailFor), each ask kept. */
class EmailDirectory extends FakeRecipients {
  /** Every recipient a chat was asked for. */
  readonly chatsAsked: string[] = [];
  /** Every recipient an address was asked for. */
  readonly addressesAsked: string[] = [];
  /** Runs as an address is asked for: after limit 8's read and before the send (a stop commits, the clock moves). */
  onAddress: (() => void) | null = null;

  constructor(
    chats: Readonly<Record<string, ChatTarget>>,
    readonly addresses: Record<string, string | null>,
  ) {
    super(chats);
    this.beforeAnswer = (handle) => {
      this.chatsAsked.push(handle);
      return Promise.resolve();
    };
  }

  async emailFor(recipientHandleId: string): Promise<string | null> {
    await yieldToOthers(1);
    this.addressesAsked.push(recipientHandleId);
    this.onAddress?.();
    return this.addresses[recipientHandleId] ?? null;
  }
}

interface Rig {
  clock: FakeClock;
  store: FakeStoreV113;
  linq: FakeLinq;
  email: RecordingEmailPort;
  recipients: EmailDirectory;
  state: FakeSendState;
  spans: Span[];
  /** Every row the dispatcher opened a trace for, as the claim handed it over. */
  claimed: ClaimedRow[];
  queue: FakeQueue;
  deps: DispatchDeps;
  /** One run for Sam's email handle, as the code's commit wakes it (ADR-016 section 2). */
  run(deps?: DispatchDeps): Promise<DispatchReport>;
  /** Hands every retry job due by now to the retry queue's consumer, through the real send door. */
  deliverDue(): Promise<string[]>;
  /** Moves the clock to the next retry job and delivers what is due then; null when the queue is empty. */
  nextRetry(): Promise<string[] | null>;
}

/** The dispatcher, the retry queue (T-256's producer and consumer, on a fake binding) and its send door, on one clock. */
function rig(seeds: readonly SeedRow[], extra: Extra, start: Utc): Rig {
  const clock = new FakeClock(start);
  const ms = (): number => Date.parse(clock.now());
  const store = new FakeStoreV113(seeds, extra);
  const linq = new FakeLinq(clock.now);
  const email = new RecordingEmailPort(clock.now);
  const recipients = new EmailDirectory({ [SAM_EMAIL]: SAM_CHAT }, { [SAM_EMAIL]: SAM_ADDRESS });
  const state = new FakeSendState().forHandle(SAM_EMAIL, {
    stopAt: null,
    textsConsent: null,
    chatOpen: false,
    businessZone: "",
    textHours: { start: "", end: "" },
  });
  const spans: Span[] = [];
  const claimed: ClaimedRow[] = [];
  const collect = traceCollector(spans);
  const queue = fakeQueue({
    now: ms,
    set: (at) => {
      clock.advance(Date.parse(at) - ms());
    },
    to: (at) => {
      clock.advance(at - ms());
    },
    advance: (by) => {
      clock.advance(by);
    },
  });
  const deps: DispatchDeps = {
    store,
    linq,
    email: { port: email, fromAddress: ROSIE_FROM_ADDRESS },
    recipients,
    sendState: state,
    environment: "staging",
    traceFor: (row) => {
      claimed.push(structuredClone(row));
      return collect(row);
    },
    now: clock.now,
    claimer: "dispatcher-1",
    limit: 100,
    retries: queueRetries(queue, ms),
  };
  // The retry queue's door with the same ports under its own claimer, as D-017 joins it (retry/door.ts).
  const queueDeps = depsOf({ sends: dispatchSendDoor({ ...deps, claimer: "dispatcher-2" }) });
  const deliverDue = async (): Promise<string[]> => {
    const due = queue.due(ms());
    if (due.length === 0) return [];
    const { batch } = batchOf(
      due.map((entry) => ({ id: messageId(), body: entry.message })),
      ms(),
    );
    const done = await consumeRetries(batch, { queue, log: LOG, deps: queueDeps, now: ms });
    return done.reports.map((report) => report.outcome);
  };
  return {
    clock,
    store,
    linq,
    email,
    recipients,
    state,
    spans,
    claimed,
    queue,
    deps,
    run: (given = deps) => runDispatch(given, { recipientHandleId: SAM_EMAIL }),
    deliverDue,
    async nextRetry() {
      const at = queue.nextDueAt();
      if (at === null) return null;
      clock.advance(Math.max(0, at - ms()));
      return deliverDue();
    },
  };
}

/** Each dispatch span as [row, outcome, provider, call, attempt, limit 8's results, error code, claim number]. */
const dispatchSpans = (spans: readonly Span[]): unknown[] =>
  spans
    .filter((span) => span.hop === "dispatch")
    .map((span) => [
      span.rows?.[0]?.id,
      span.outcome,
      span.provider ?? null,
      span.call ?? null,
      span.attempt ?? null,
      span.limits?.map((limit) => [limit.result, limit.outcome]) ?? [],
      span.error_code ?? null,
      span.decided?.claimNo,
    ]);

/** Each try of the row's part as [key, state]. */
const triesOf = (t: Rig, id = ROW_ID): [string, string][] =>
  t.store.tries(id).map((part) => [part.key, part.state]);

/** Each row's [id, outcome, parts sent]. */
const outcomes = (report: DispatchReport): unknown[] =>
  report.rows.map((row) => [row.outboxRowId, row.outcome, row.partsSent]);

describe("the code row goes by the email port alone, in K-12 send-code.json's form (ADR-016 sections 1 and 3)", () => {
  it("the seeded row is claim-sam-sign-in-code.json's own, and send-code.json's text is its line, a blank line and its words", async () => {
    const [fixtureRow] = claimSamSignInCode.outcome.claimed;
    const t = rig([codeSeed()], codeExtra(), CLAIMED_AT);
    await t.run();

    expect(fixtureRow).toMatchObject({
      outboxRowId: ROW_ID,
      recipientHandleId: SAM_EMAIL,
      recipientPersonId: "person-sam",
      businessId: null,
      bookingId: null,
      openQuestionId: null,
      channel: "email",
      port: "email",
      sendClass: "quick_reply",
      versionsRead: [],
      emailPurpose: "code",
      notAfter: "2026-11-02T13:10:01Z",
      finalParts: { channel: "email", sends: [words(CODE_WORDS)], fixedLines: [], threadReplyTo: null },
      parts: [{ partNo: 1, tryNo: 1, idempotencyKey: `${ROW_ID}/1/1`, attempts: 1, sent: false }],
    });
    // The fake's claim hands the dispatcher the same row, in the dispatcher's shape.
    expect(t.claimed[0]).toMatchObject({
      outboxRowId: ROW_ID,
      recipientHandleId: SAM_EMAIL,
      recipientPersonId: "person-sam",
      businessId: null,
      bookingId: null,
      openQuestionId: null,
      channel: "email",
      port: "email",
      sendClass: "quick_reply",
      emailPurpose: "code",
      notAfter: NOT_AFTER,
      finalParts: { channel: "email", sends: [words(CODE_WORDS)], fixedLines: [], threadReplyTo: null },
      parts: [{ partNo: 1, tryNo: 1, idempotencyKey: `${ROW_ID}/1/1`, attempts: 1, sent: false }],
    });
    expect(Date.parse(NOT_AFTER)).toBe(Date.parse(fixtureRow?.notAfter ?? ""));
    expect(SEND_CODE.text).toBe(`${SEND_CODE.assistantLine}\n\n${SEND_CODE_WORDS}`);
    expect([SEND_CODE_ROW, SEND_CODE.purpose, SEND_CODE.subject]).toEqual([
      "out-sam-email-check-code",
      "code",
      CODE_SUBJECT,
    ]);
  });

  it("at 3:00am, to an email handle with no phone row and no open chat: exactly one email-port send equal to that request, and none by any other port", async () => {
    // send-code.json's request, with the row's key, the recipient's address and words, and the assistant line of an email
    // about no business (ADR-016 section 1): S1-10's code names the business it sets up, which no claimed row carries
    // (T-264's), so the row built from send-code.json's own request goes as that request but for that line.
    const fromSendCode: EmailSendRequest = {
      ...SEND_CODE,
      assistantLine: ASSISTANT_LINE,
      text: `${ASSISTANT_LINE}\n\n${SEND_CODE_WORDS}`,
    };
    expect({ ...fromSendCode, assistantLine: SEND_CODE.assistantLine, text: SEND_CODE.text }).toEqual(
      SEND_CODE,
    );
    const cases = [
      {
        name: "Sam's sign-in code row (claim-sam-sign-in-code.json)",
        rowId: ROW_ID,
        text: CODE_WORDS,
        address: SAM_ADDRESS,
        expected: {
          ...SEND_CODE,
          idempotencyKey: `${ROW_ID}/1/1`,
          to: SAM_ADDRESS,
          assistantLine: ASSISTANT_LINE,
          text: `${ASSISTANT_LINE}\n\n${CODE_WORDS}`,
        },
      },
      {
        name: "a row built from send-code.json's request",
        rowId: SEND_CODE_ROW,
        text: SEND_CODE_WORDS,
        address: SEND_CODE.to,
        expected: fromSendCode,
      },
    ];
    for (const { name, rowId, text, address, expected } of cases) {
      const t = rig([codeSeed(rowId, text)], codeExtra(rowId, plus(THREE_AM, 599_000)), THREE_AM);
      t.recipients.addresses[SAM_EMAIL] = address;

      const report = await t.run();

      expect([name, outcomes(report)]).toEqual([name, [[rowId, "sent", 1]]]);
      expect([name, t.email.requests]).toEqual([name, [expected]]);
      // The email double took it, once: K-12's own checks passed (the Resend adapter's match them).
      expect([name, await t.email.sent(), t.email.double.rejectedRequests()]).toEqual([name, [expected], []]);
      // None by any other port: no Linq send, and no chat asked for, though Sam's handle has one.
      expect([name, t.linq.requests, t.recipients.chatsAsked]).toEqual([name, [], []]);
      expect([name, t.recipients.addressesAsked]).toEqual([name, [SAM_EMAIL]]);
      expect(t.store.marks).toEqual([
        {
          outcome: "sent",
          idempotencyKey: `${rowId}/1/1`,
          providerMessageId: "email-double-msg-0001",
          providerOptionIds: null,
          at: THREE_AM,
        },
      ]);
      expect(t.store.row(rowId).state).toBe("sent");
      expect(dispatchSpans(t.spans)).toEqual([
        [rowId, "ok", "resend", "sendEmail", 1, [["pass", null]], null, 1],
      ]);
      expect(
        t.spans
          .filter((span) => span.hop === "providerAccepted")
          .map((span) => [span.provider, span.rows?.[0]?.id, span.at]),
      ).toEqual([["resend", `${rowId}/1/1`, THREE_AM]]);
    }
  });

  it("a row whose channel and port disagree is no email row (T-1283): it takes the text rules, and the email port is never asked", async () => {
    const seeds: SeedRow[] = [
      { ...codeSeed("out-sam-email-by-linq"), port: "linq" },
      { ...codeSeed("out-sam-text-by-email"), commitSeq: 2, channel: "imessage" },
    ];
    const t = rig(
      seeds,
      { ...codeExtra("out-sam-email-by-linq"), ...codeExtra("out-sam-text-by-email") },
      CLAIMED_AT,
    );

    const report = await t.run();

    // An email handle has no open chat: as text rows, both wait for one (RULES 4.1b), and nothing is sent.
    expect(outcomes(report)).toEqual([
      ["out-sam-email-by-linq", "waitingChat", 0],
      ["out-sam-text-by-email", "waitingChat", 0],
    ]);
    expect([t.email.requests, t.linq.requests, t.recipients.addressesAsked]).toEqual([[], [], []]);
  });
});

describe("where the email branch cannot send, nothing is sent and nothing is marked", () => {
  it("no email port joined: noEmailPort, before the address is read, the claim left to lapse", async () => {
    const t = rig([codeSeed()], codeExtra(), CLAIMED_AT);
    const noPort: DispatchDeps = { ...t.deps };
    delete noPort.email;

    const report = await t.run(noPort);

    expect(outcomes(report)).toEqual([[ROW_ID, "noEmailPort", 0]]);
    expect([t.recipients.addressesAsked, t.recipients.chatsAsked, t.store.renewals]).toEqual([[], [], []]);
    expect([t.store.marks, t.store.rowMarks, t.email.requests, t.linq.requests]).toEqual([[], [], [], []]);
    expect(t.store.row(ROW_ID).state).toBe("sending");
    expect(dispatchSpans(t.spans)).toEqual([
      [ROW_ID, "refused", null, null, null, [["pass", null]], null, 1],
    ]);
  });

  it("no address known: noAddress, whether emailFor answers none, answers what is no address, or is not joined", async () => {
    const directories: [string, (t: Rig) => DispatchDeps][] = [
      [
        "none for the handle",
        (t) => {
          t.recipients.addresses[SAM_EMAIL] = null;
          return t.deps;
        },
      ],
      [
        "no address",
        (t) => {
          t.recipients.addresses[SAM_EMAIL] = "sam";
          return t.deps;
        },
      ],
      ["no emailFor", (t) => ({ ...t.deps, recipients: new FakeRecipients({ [SAM_EMAIL]: SAM_CHAT }) })],
    ];
    for (const [name, depsOfRig] of directories) {
      const t = rig([codeSeed()], codeExtra(), CLAIMED_AT);

      const report = await t.run(depsOfRig(t));

      expect([name, outcomes(report)]).toEqual([name, [[ROW_ID, "noAddress", 0]]]);
      expect([name, t.store.renewals, t.store.marks, t.store.rowMarks]).toEqual([name, [], [], []]);
      expect([name, t.email.requests, t.linq.requests, t.recipients.chatsAsked]).toEqual([name, [], [], []]);
    }
  });

  it("an email row the email rows do not build yet (T-264's): notBuilt with its label, no address read, nothing sent", async () => {
    const twoSends: SeedRow = { ...codeSeed(), sends: [words(CODE_WORDS), words("And one more.")] };
    const cases: [string, SeedRow, Partial<ClaimedRow>, string][] = [
      ["a confirmation", codeSeed(), { emailPurpose: "confirmation", notAfter: null }, "purposeNotBuilt"],
      ["a next way", codeSeed(), { emailPurpose: "nextWay", notAfter: null }, "purposeNotBuilt"],
      ["a row that names no purpose", codeSeed(), {}, "purposeNotBuilt"],
      [
        "a code about a business",
        codeSeed(),
        { ...codeExtra()[ROW_ID], businessId: "biz-lees-barbershop" },
        "aboutNotBuilt",
      ],
      [
        "a code about a booking",
        codeSeed(),
        { ...codeExtra()[ROW_ID], bookingId: "booking-sam-nov20" },
        "aboutNotBuilt",
      ],
      ["a code in two sends", twoSends, codeExtra()[ROW_ID] ?? {}, "partsNotBuilt"],
    ];
    for (const [name, seed, extra, label] of cases) {
      const t = rig([seed], { [ROW_ID]: extra }, CLAIMED_AT);

      const report = await t.run();

      expect([name, outcomes(report)]).toEqual([name, [[ROW_ID, "notBuilt", 0]]]);
      expect([name, dispatchSpans(t.spans)]).toEqual([
        name,
        [[ROW_ID, "refused", null, null, null, [["pass", null]], label, 1]],
      ]);
      expect([name, t.recipients.addressesAsked, t.store.renewals, t.store.marks]).toEqual([
        name,
        [],
        [],
        [],
      ]);
      expect([name, t.email.requests, t.linq.requests, t.recipients.chatsAsked]).toEqual([name, [], [], []]);
    }
  });

  it("a row not built here holds back no row behind it, as a refused SMS-port row does not: the code behind it goes", async () => {
    const confirmation = codeSeed("out-sam-confirmation");
    const code: SeedRow = { ...codeSeed(), commitSeq: 2 };
    const t = rig(
      [confirmation, code],
      { "out-sam-confirmation": { emailPurpose: "confirmation", notAfter: null }, ...codeExtra() },
      CLAIMED_AT,
    );

    const report = await t.run();

    expect(outcomes(report)).toEqual([
      ["out-sam-confirmation", "notBuilt", 0],
      [ROW_ID, "sent", 1],
    ]);
    expect(t.email.keys).toEqual([`${ROW_ID}/1/1`]);
    // Nothing is written for the row not built: its claim lapses, and a later run reads it again.
    expect(t.store.row("out-sam-confirmation").state).toBe("sending");
    expect(t.store.marks.map((mark) => mark.idempotencyKey)).toEqual([`${ROW_ID}/1/1`]);
  });
});

describe("the stop and the end are read again just before the send (DL-703)", () => {
  it("a stop that commits after limit 8 (the address's newest texts row revoked) drops the row, unsent", async () => {
    const t = rig([codeSeed()], codeExtra(), CLAIMED_AT);
    t.recipients.onAddress = () => {
      t.state.forHandle(SAM_EMAIL, { textsConsent: EMAIL_STOP });
    };

    const report = await t.run();

    expect(outcomes(report)).toEqual([[ROW_ID, "droppedStopped", 0]]);
    expect(t.email.requests).toEqual([]);
    expect(t.store.rowMarks.map((mark) => [mark.request.outcome, mark.answer])).toEqual([
      ["droppedStopped", "droppedStopped"],
    ]);
    expect(t.store.renewals.map((renewal) => renewal.answer)).toEqual(["renewed"]);
    expect(dispatchSpans(t.spans)).toEqual([
      [ROW_ID, "dropped", null, null, null, [["fail", "droppedStopped"]], null, 1],
    ]);
  });

  it("a second read that holds no texts row cannot show the stop: nothing is sent or marked (unreadable)", async () => {
    const t = rig([codeSeed()], codeExtra(), CLAIMED_AT);

    const report = await t.run({
      ...t.deps,
      sendState: readsInTurn(emailState(), withoutTextsRow(emailState())),
    });

    expect(outcomes(report)).toEqual([[ROW_ID, "unreadable", 0]]);
    expect([t.email.requests, t.store.rowMarks, t.store.marks]).toEqual([[], [], []]);
    expect(t.store.row(ROW_ID).state).toBe("sending");
    expect(dispatchSpans(t.spans)).toEqual([
      [ROW_ID, "refused", null, null, null, [["fail", "unreadable"]], "sendStateInvalid", 1],
    ]);
  });

  it("an email row's stop is never the phone's flag (STATE note 10): a flag set after limit 8 does not hold its code back", async () => {
    const t = rig([codeSeed()], codeExtra(), CLAIMED_AT);
    t.recipients.onAddress = () => {
      t.state.forHandle(SAM_EMAIL, { stopped: true, stopAt: CLAIMED_AT });
    };

    const report = await t.run();

    expect(outcomes(report)).toEqual([[ROW_ID, "sent", 1]]);
    expect(t.email.keys).toEqual([`${ROW_ID}/1/1`]);
  });

  it("the code's end coming during the address's lookup withdraws the row, unsent", async () => {
    const t = rig([codeSeed()], codeExtra(), plus(NOT_AFTER, -500));
    t.recipients.onAddress = () => {
      t.clock.advance(1_000); // the lookup takes a second: the code's end passes meanwhile
    };

    const report = await t.run();

    expect(outcomes(report)).toEqual([[ROW_ID, "withdrawn", 0]]);
    expect(t.email.requests).toEqual([]);
    expect(t.store.row(ROW_ID).state).toBe("withdrawn");
    expect(t.store.rowMarks.map((mark) => [mark.request.outcome, mark.answer])).toEqual([
      ["withdrawn", "withdrawn"],
    ]);
    expect(dispatchSpans(t.spans)).toEqual([
      [ROW_ID, "dropped", null, null, null, [["fail", "withdrawn"]], null, 1],
    ]);
  });
});

describe("the retry at minute 10: no retry sends a dead code (ADR-016 section 3)", () => {
  it("a first try that failed at minute 9 takes a new key, and its retry after minute 10 withdraws the row unsent", async () => {
    const t = rig([codeSeed()], codeExtra(), MINUTE_9);
    t.email.double.failNextSend({ kind: "transient", httpStatus: 503 });

    const first = await t.run();

    expect(first.rows).toEqual([
      {
        outboxRowId: ROW_ID,
        recipientHandleId: SAM_EMAIL,
        outcome: "failed",
        partsSent: 0,
        retry: {
          why: "newKey",
          chain: "rerun",
          jobKey: `retry-${ROW_ID}/1/1#1`,
          waitSeconds: 60,
          scheduled: "queued",
        },
      },
    ]);
    expect(t.store.marks).toEqual([
      {
        outcome: "failed",
        idempotencyKey: `${ROW_ID}/1/1`,
        errorCode: "service_unavailable",
        retry: true,
        at: MINUTE_9,
        providerMessageId: null,
        nextTryNotBefore: null,
      },
    ]);
    expect(triesOf(t)).toEqual([
      [`${ROW_ID}/1/1`, "failed"],
      [`${ROW_ID}/1/2`, "pending"],
    ]);
    // The retry is due when the claim the try went under lapses: 13:10:01, the code's end.
    expect(t.queue.nextDueAt()).toBe(Date.parse(NOT_AFTER));

    t.clock.advance(61_000); // 13:10:02: after minute 10
    expect(await t.deliverDue()).toEqual(["done"]);

    expect(t.email.keys).toEqual([`${ROW_ID}/1/1`]);
    expect(t.store.row(ROW_ID).state).toBe("withdrawn");
    expect(t.store.rowMarks.map((mark) => [mark.request.outcome, mark.answer])).toEqual([
      ["withdrawn", "withdrawn"],
    ]);
    expect(triesOf(t)).toEqual([
      [`${ROW_ID}/1/1`, "failed"],
      [`${ROW_ID}/1/2`, "pending"],
    ]);
    expect(dispatchSpans(t.spans)).toEqual([
      [ROW_ID, "failed", "resend", "sendEmail", 1, [["pass", null]], "service_unavailable", 1],
      [ROW_ID, "dropped", null, null, null, [["fail", "withdrawn"]], null, 2],
    ]);
    expect([t.queue.waiting, t.linq.requests, await t.email.sent()]).toEqual([0, [], []]);
  });

  it("no give-up of a row with no turn: every try failing, a new key each minute until its end, then withdrawn; never failed, never followed up", async () => {
    const t = rig([codeSeed()], codeExtra(), CLAIMED_AT);
    t.email.double.failNextSend({ kind: "transient", httpStatus: 503 }, { times: 100 });

    await t.run();
    const deliveries: string[][] = [];
    for (let round = 0; round < 30; round += 1) {
      const delivered = await t.nextRetry();
      if (delivered === null) break;
      deliveries.push(delivered);
    }

    // Ten tries, 13:00:02 to 13:09:02, each under a new key (K-07 rule 1), every one before the code's end.
    expect(t.email.keys).toEqual(
      Array.from({ length: 10 }, (_, index) => `${ROW_ID}/1/${String(index + 1)}`),
    );
    expect(t.email.times.every((at) => Date.parse(at) < Date.parse(NOT_AFTER))).toBe(true);
    expect(t.email.times.at(-1)).toBe("2026-11-02T13:09:02.000Z");
    // The run after the end withdrew it: the one row mark; each part mark a failure with its next key, and no follow-up.
    expect(deliveries).toEqual(Array.from({ length: 10 }, () => ["done"]));
    expect(t.store.row(ROW_ID).state).toBe("withdrawn");
    expect(t.store.rowMarks.map((mark) => mark.request.outcome)).toEqual(["withdrawn"]);
    expect(t.store.marks.map((mark) => [mark.outcome, mark.outcome === "failed" && mark.retry])).toEqual(
      Array.from({ length: 10 }, () => ["failed", true]),
    );
    expect(t.store.marks.filter((mark) => "followUps" in mark)).toEqual([]);
    expect([t.queue.waiting, await t.email.sent(), t.linq.requests]).toEqual([0, [], []]);
  });

  it("a refusal (no key on staging) and a reached quota are not tried again: the part failed with no next try, the row withdrawn at its end", async () => {
    const choices = [
      ["refused", { kind: "refused", httpStatus: 401, code: "missing_api_key" }, "missing_api_key"],
      ["quotaReached", { kind: "quotaReached" }, "daily_quota_exceeded"],
    ] as const;
    for (const [name, choice, code] of choices) {
      const t = rig([codeSeed()], codeExtra(), CLAIMED_AT);
      t.email.double.failNextSend(choice, { times: 5 });

      const first = await t.run();

      // The row waits for its end, 13:10:01, 599 seconds on (K-12: no try clears it; ADR-016 section 3: never given up).
      expect([name, first.rows]).toEqual([
        name,
        [
          {
            outboxRowId: ROW_ID,
            recipientHandleId: SAM_EMAIL,
            outcome: "failed",
            partsSent: 0,
            retry: {
              why: "failedTry",
              chain: "rerun",
              jobKey: `retry-${ROW_ID}/1/1#1`,
              waitSeconds: 599,
              scheduled: "queued",
            },
          },
        ],
      ]);
      expect([name, t.store.marks]).toEqual([
        name,
        [
          {
            outcome: "failed",
            idempotencyKey: `${ROW_ID}/1/1`,
            errorCode: code,
            retry: false,
            at: CLAIMED_AT,
          },
        ],
      ]);
      expect([name, triesOf(t)]).toEqual([name, [[`${ROW_ID}/1/1`, "failed"]]]);
      expect([name, dispatchSpans(t.spans)]).toEqual([
        name,
        [[ROW_ID, "failed", "resend", "sendEmail", 1, [["pass", null]], code, 1]],
      ]);

      // A wake before its end (the next code's: ADR-016 section 2) sends nothing: the part has no next try.
      t.clock.advance(5 * 60_000);
      const wake = await t.run();
      expect([
        name,
        wake.rows.map((row) => [row.outcome, row.partsSent, row.retry?.why, row.retry?.waitSeconds]),
      ]).toEqual([name, [["awaitingRetry", 0, "failedTry", 299]]]);

      // At its end both waits come due: the first run withdraws the row, the second finds nothing.
      expect([name, await t.nextRetry()]).toEqual([name, ["done", "done"]]);
      expect([name, t.email.keys, t.store.row(ROW_ID).state]).toEqual([name, [`${ROW_ID}/1/1`], "withdrawn"]);
      expect([name, t.store.rowMarks.map((mark) => mark.request.outcome)]).toEqual([name, ["withdrawn"]]);
      expect([name, t.store.marks.length, t.queue.waiting, await t.email.sent()]).toEqual([name, 1, 0, []]);
    }
  });
});

describe("K-07's key rule for each failure the email port reports (K-12 'Outcomes of a send')", () => {
  it("no answer keeps the key: nothing is marked, the retry goes under the same key, and the email is sent once", async () => {
    const t = rig([codeSeed()], codeExtra(), CLAIMED_AT);
    t.email.double.failNextSend({ kind: "transient", httpStatus: null });

    const first = await t.run();

    expect(first.rows[0]).toMatchObject({
      outcome: "failed",
      retry: { why: "sameKey", waitSeconds: 60, scheduled: "queued" },
    });
    expect(t.store.marks).toEqual([]);
    expect(dispatchSpans(t.spans)).toEqual([
      [ROW_ID, "timedOut", "resend", "sendEmail", 1, [["pass", null]], "transient", 1],
    ]);

    expect(await t.nextRetry()).toEqual(["done"]);
    expect(t.email.keys).toEqual([`${ROW_ID}/1/1`, `${ROW_ID}/1/1`]);
    expect(await t.email.sent()).toHaveLength(1);
    expect(t.store.row(ROW_ID).state).toBe("sent");
    expect(t.store.tries(ROW_ID).map((part) => [part.key, part.state, part.attempts])).toEqual([
      [`${ROW_ID}/1/1`, "sent", 2],
    ]);
  });

  it("a reported failure takes a new key: a 409 still in progress, and a rate limit after its Retry-After", async () => {
    const choices = [
      ["inProgress", { kind: "transient", httpStatus: 409 }, "concurrent_idempotent_requests", null, 60],
      ["rateLimited", { kind: "rateLimited", retryAfterSeconds: 90 }, "rate_limit_exceeded", 90_000, 90],
    ] as const;
    for (const [name, choice, code, notBeforeMs, waitSeconds] of choices) {
      const t = rig([codeSeed()], codeExtra(), CLAIMED_AT);
      t.email.double.failNextSend(choice);

      const first = await t.run();

      expect([name, first.rows[0]?.retry]).toMatchObject([name, { why: "newKey", waitSeconds }]);
      expect([name, t.store.marks]).toEqual([
        name,
        [
          {
            outcome: "failed",
            idempotencyKey: `${ROW_ID}/1/1`,
            errorCode: code,
            retry: true,
            at: CLAIMED_AT,
            providerMessageId: null,
            nextTryNotBefore: notBeforeMs === null ? null : plus(CLAIMED_AT, notBeforeMs),
          },
        ],
      ]);

      expect([name, await t.nextRetry()]).toEqual([name, ["done"]]);
      expect([name, t.email.keys, t.store.row(ROW_ID).state]).toEqual([
        name,
        [`${ROW_ID}/1/1`, `${ROW_ID}/1/2`],
        "sent",
      ]);
    }
  });
});

describe("nothing of the code, the address or the attempt reaches a span or a log line", () => {
  it("over a send, a failed try and its retry, a refusal and its end, and a stop after limit 8", async () => {
    const lines: string[] = [];
    const levels = ["log", "info", "warn", "error", "debug"] as const;
    const spies = levels.map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
      }),
    );
    const spans: Span[] = [];
    try {
      const sent = rig([codeSeed()], codeExtra(), CLAIMED_AT);
      await sent.run();

      const retried = rig([codeSeed()], codeExtra(), MINUTE_9);
      retried.email.double.failNextSend({ kind: "transient", httpStatus: 503 });
      await retried.run();
      await retried.nextRetry();

      const refused = rig([codeSeed()], codeExtra(), CLAIMED_AT);
      refused.email.double.failNextSend({ kind: "refused", httpStatus: 401, code: "missing_api_key" });
      await refused.run();
      await refused.nextRetry();

      const stopped = rig([codeSeed()], codeExtra(), CLAIMED_AT);
      stopped.recipients.onAddress = () => {
        stopped.state.forHandle(SAM_EMAIL, { textsConsent: EMAIL_STOP });
      };
      await stopped.run();

      for (const t of [sent, retried, refused, stopped]) spans.push(...t.spans);
      // What each run did, so the check below reads real spans: a send, a retry withdrawn, a refusal withdrawn, a drop.
      expect([sent, retried, refused, stopped].map((t) => t.store.row(ROW_ID).state)).toEqual([
        "sent",
        "withdrawn",
        "withdrawn",
        "dropped_stopped",
      ]);
      expect(sent.email.requests[0]?.text).toContain(CODE);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    // Every field a span writes, but the random ids the trace draws (which could hold any run of hex digits).
    const written = JSON.stringify(spans.map((span) => ({ ...span, trace_id: "", span_id: "" })));
    expect(spans.length).toBeGreaterThan(5);
    expect(lines.length).toBeGreaterThan(0); // the retry queue's own lines (ids and labels)
    for (const secret of [CODE, SAM_ADDRESS, CODE_SUBJECT, ASSISTANT_LINE, ...ATTEMPT_IDS]) {
      expect([secret, written.includes(secret), lines.some((line) => line.includes(secret))]).toEqual([
        secret,
        false,
        false,
      ]);
    }
    // No address of any kind: a span holds labels only (runtime/src/trace validate.ts).
    expect(written).not.toContain("@");
  });
});
