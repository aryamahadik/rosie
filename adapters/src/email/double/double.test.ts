// T-418: the email double against K-12 v1's fixtures and schema, and K-06 v1's email events. No network and no real key:
// the webhook secrets are made-up test strings built here (rule 7), and every name and address is the fixtures' own
// (Lee's Barbershop and the master's sample cast on example.com, .example and reply.example.com: rule 9).
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { beforeAll, describe, expect, it } from "vitest";

import { EmailDoubleError, createEmailDouble, type EmailDouble } from "./double";
import type {
  DoubleSentEmailsOutcome,
  DoubleSentEmailsRequest,
  DoubleWebhookOutcome,
  DoubleWebhookRequest,
  EmailEvent,
  EmailFailureCode,
  ReadReplyOutcome,
  ReadReplyRequest,
  ScriptedSendFailure,
  SendEmailFailed,
  SendEmailOutcome,
  SendEmailRequest,
  VerifyWebhookOutcome,
  VerifyWebhookRequest,
} from "./types";

const CONTRACTS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "contracts",
);
const FIXTURES = path.join(CONTRACTS, "port-email", "fixtures");
const K06_FIXTURES = path.join(CONTRACTS, "inbound-event", "fixtures");
const K12_ID = "https://rosie.invalid/contracts/port-email/port-email.v1.schema.json";
const K06_ID = "https://rosie.invalid/contracts/inbound-event/inbound-event.v1.schema.json";

// Made-up test secrets: "whsec_" and base64, built here. Not keys of any service.
const SECRET = `whsec_${btoa("rosie-email-double-test-key-0001")}`;
const OTHER_SECRET = `whsec_${btoa("rosie-email-double-test-key-0002")}`;
const NOW = "2026-10-23T14:05:03Z";

interface Given {
  now: string;
  note: string;
  signing?: "valid" | "oneByteChanged";
}

interface Exchange<Request, Outcome> {
  call: string;
  given: Given;
  request: Request;
  outcome: Outcome;
}

type SendExchange = Exchange<SendEmailRequest, SendEmailOutcome>;
type VerifyExchange = Exchange<VerifyWebhookRequest, VerifyWebhookOutcome>;
type ReadExchange = Exchange<ReadReplyRequest, ReadReplyOutcome>;
type WebhookExchange = Exchange<DoubleWebhookRequest, DoubleWebhookOutcome>;
type SentExchange = Exchange<DoubleSentEmailsRequest, DoubleSentEmailsOutcome>;

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
const fixtureFile = (name: string): string => path.join(FIXTURES, name);
const sendFixture = (name: string): SendExchange => readJson(fixtureFile(name)) as SendExchange;
const verifyFixture = (name: string): VerifyExchange => readJson(fixtureFile(name)) as VerifyExchange;
const readFixture = (name: string): ReadExchange => readJson(fixtureFile(name)) as ReadExchange;
const webhookFixture = (name: string): WebhookExchange => readJson(fixtureFile(name)) as WebhookExchange;
const sentFixture = (name: string): SentExchange => readJson(fixtureFile(name)) as SentExchange;
const k06 = (name: string): EmailEvent => readJson(path.join(K06_FIXTURES, name)) as EmailEvent;

const SENDS = [
  "send-confirmation-with-chat-link.json",
  "send-copy-of-text.json",
  "send-code.json",
  "send-fallback-s12-10.json",
];
const SEND_FAILURES = ["send-rate-limited.json", "send-daily-quota.json"];
const REFUSED = [
  "invalid/refuse-marketing-email.json",
  "invalid/refuse-no-reply-address.json",
  "invalid/refuse-from-other-domain.json",
  "invalid/refuse-subject-line-break.json",
];
const VERIFIES = [
  "delivered.json",
  "bounced.json",
  "verify-reply-received.json",
  "verify-ignored-delivery-delayed.json",
  "verify-bad-signature.json",
];
const READS = [
  "inbound-reply-passed.json",
  "inbound-reply-failed-check.json",
  "reply-automatic-ignored.json",
];
const DOUBLES = ["double-signed-webhook.json", "double-signed-reply.json", "double-sent-emails.json"];

let validateExchange: ValidateFunction;
let validateEvent: ValidateFunction;
let validateSendErrors: ValidateFunction;

beforeAll(() => {
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  // Every contract's schemas, so the $refs between them resolve (the same loading as the other doubles' tests).
  for (const folder of readdirSync(CONTRACTS, { withFileTypes: true })) {
    if (!folder.isDirectory() || ["scripts", "generated", "node_modules"].includes(folder.name)) continue;
    for (const file of readdirSync(path.join(CONTRACTS, folder.name)))
      if (file.endsWith(".schema.json"))
        ajv.addSchema(readJson(path.join(CONTRACTS, folder.name, file)) as object);
  }
  const exchange = ajv.getSchema(K12_ID);
  const event = ajv.getSchema(K06_ID);
  const sendErrors = ajv.getSchema(`${K12_ID}#/$defs/sendEmail.errors`);
  if (exchange === undefined || event === undefined || sendErrors === undefined)
    throw new Error("a contract schema is missing");
  validateExchange = exchange;
  validateEvent = event;
  validateSendErrors = sendErrors;
});

function expectExchange(exchange: unknown): void {
  expect(validateExchange(exchange), JSON.stringify(validateExchange.errors)).toBe(true);
}

function expectEvent(event: unknown): void {
  expect(validateEvent(event), JSON.stringify(validateEvent.errors)).toBe(true);
}

const given = (now: string, signing?: "valid" | "oneByteChanged"): Given =>
  signing === undefined
    ? { now, note: "the email double's answer" }
    : { now, note: "the email double's answer", signing };

const doubleAt = (now: string): EmailDouble =>
  createEmailDouble({ now: () => now, webhookSecret: () => SECRET });

async function sentEmails(double: EmailDouble): Promise<SendEmailRequest[]> {
  return (await double.doubleSentEmails({ to: null })).emails.map((email) => email.request);
}

/** A double that recorded Ben's confirmation as its first email, email-double-msg-0001 (K-12 double-sent-emails.json). */
async function withBenConfirmation(): Promise<EmailDouble> {
  const confirmation = sendFixture("send-confirmation-with-chat-link.json");
  const double = doubleAt(confirmation.given.now);
  expect(await double.sendEmail(confirmation.request)).toMatchObject({
    result: "accepted",
    providerMessageId: "email-double-msg-0001",
  });
  return double;
}

describe("the K-12 v1 fixtures", () => {
  it("tests every fixture K-12 v1's index lists", () => {
    const index = readJson(fixtureFile("index.json")) as { fixtures: { file: string }[] };
    expect([...SENDS, ...SEND_FAILURES, ...REFUSED, ...VERIFIES, ...READS, ...DOUBLES].sort()).toEqual(
      index.fixtures.map((entry) => entry.file).sort(),
    );
  });
});

describe("sendEmail: every K-12 send fixture is recorded", () => {
  it.each(SENDS)("accepts and records %s, answering as the schema allows", async (name) => {
    const fixture = sendFixture(name);
    const double = doubleAt(fixture.given.now);
    const outcome = await double.sendEmail(fixture.request);
    expect(outcome).toEqual({
      result: "accepted",
      providerMessageId: "email-double-msg-0001",
      acceptedAt: fixture.given.now,
    });
    expectExchange({ ...fixture, outcome });
    expect(await double.doubleSentEmails({ to: null })).toEqual({
      result: "recorded",
      emails: [
        {
          recordedAt: fixture.given.now,
          providerMessageId: "email-double-msg-0001",
          request: fixture.request,
        },
      ],
    });
  });

  it("records every send fixture once, oldest first, each with its own id, and lists one person's", async () => {
    const double = doubleAt(NOW);
    // The failure fixtures repeat send-code's and the S12-10 email's keys with the same email: each is sent once.
    for (const name of [...SENDS, ...SEND_FAILURES])
      expect((await double.sendEmail(sendFixture(name).request)).result).toBe("accepted");
    const all = await double.doubleSentEmails({ to: null });
    expect(all.emails.map((email) => email.request)).toEqual(SENDS.map((name) => sendFixture(name).request));
    expect(new Set(all.emails.map((email) => email.providerMessageId)).size).toBe(SENDS.length);
    expectExchange({ call: "doubleSentEmails", given: given(NOW), request: { to: null }, outcome: all });
    const alex = await double.doubleSentEmails({ to: "alex@example.com" });
    expect(alex.emails.map((email) => email.request.idempotencyKey)).toEqual([
      "out-a7-03-alex-email/1/1",
      "out-alex-confirm-by-email/1/1",
    ]);
  });

  it("gives the test-phone page K-12 double-sent-emails.json: Ben's confirmation with its chat link", async () => {
    const fixture = sentFixture("double-sent-emails.json");
    const double = await withBenConfirmation();
    await double.sendEmail(sendFixture("send-copy-of-text.json").request);
    const outcome = await double.doubleSentEmails(fixture.request);
    expect(outcome).toEqual(fixture.outcome);
    expectExchange({ ...fixture, outcome });
    await expect(double.doubleSentEmails({ to: "Ben@Example.com" })).rejects.toBeInstanceOf(EmailDoubleError);
    await expect(double.doubleSentEmails({})).rejects.toBeInstanceOf(EmailDoubleError);
  });
});

describe("sendEmail: failures the test chooses", () => {
  it.each(SEND_FAILURES)(
    "answers %s as the fixture does, sends nothing, and the key goes again later",
    async (name) => {
      const fixture = sendFixture(name);
      const expected = fixture.outcome as SendEmailFailed;
      const double = doubleAt(fixture.given.now);
      double.failNextSend(
        expected.kind === "rateLimited"
          ? { kind: "rateLimited", retryAfterSeconds: expected.retryAfterSeconds }
          : { kind: "quotaReached" },
      );
      const outcome = await double.sendEmail(fixture.request);
      expect(outcome).toEqual(fixture.outcome);
      expectExchange({ ...fixture, outcome });
      expect(await sentEmails(double)).toEqual([]);
      expect(await double.sendEmail(fixture.request)).toMatchObject({ result: "accepted" });
      expect(await sentEmails(double)).toEqual([fixture.request]);
    },
  );

  it("answers every other failure K-12 defines in the contract's form", async () => {
    const request = sendFixture("send-copy-of-text.json").request;
    const choices: ScriptedSendFailure[] = [
      { kind: "quotaReached", code: "monthly_quota_exceeded" },
      { kind: "refused" },
      { kind: "refused", httpStatus: 403, code: null },
      { kind: "transient" },
      { kind: "transient", httpStatus: 503 },
      { kind: "transient", httpStatus: 409 },
      { kind: "transient", httpStatus: null },
      { kind: "rateLimited" },
    ];
    for (const choice of choices) {
      const double = doubleAt(NOW);
      double.failNextSend(choice);
      const outcome = await double.sendEmail(request);
      expect(outcome).toMatchObject({ result: "failed", kind: choice.kind });
      expectExchange({ call: "sendEmail", given: given(NOW), request, outcome });
      expect(await sentEmails(double)).toEqual([]);
    }
  });

  it("refuses a choice the contract has no form for", () => {
    const double = doubleAt(NOW);
    const choices = [
      { kind: "refused", httpStatus: 500 },
      { kind: "refused", httpStatus: 429 },
      { kind: "transient", httpStatus: 404 },
      { kind: "rateLimited", retryAfterSeconds: -1 },
      { kind: "transient", code: "Not A Name" },
      { kind: "bounced" },
    ] as unknown as ScriptedSendFailure[];
    for (const choice of choices)
      expect(() => {
        double.failNextSend(choice);
      }).toThrow(EmailDoubleError);
    expect(() => {
      double.failNextSend({ kind: "transient" }, { times: 0 });
    }).toThrow(EmailDoubleError);
  });

  it("applies a failure to the chosen address only, the chosen number of times", async () => {
    const double = doubleAt(NOW);
    const sam = sendFixture("send-code.json").request;
    const alex = sendFixture("send-copy-of-text.json").request;
    double.failNextSend({ kind: "transient" }, { to: sam.to, times: 2 });
    expect((await double.sendEmail(alex)).result).toBe("accepted");
    expect((await double.sendEmail(sam)).result).toBe("failed");
    expect((await double.sendEmail({ ...sam, idempotencyKey: "out-sam-email-check-code/1/2" })).result).toBe(
      "failed",
    );
    expect((await double.sendEmail({ ...sam, idempotencyKey: "out-sam-email-check-code/1/3" })).result).toBe(
      "accepted",
    );
  });
});

describe("sendEmail: refused fixtures are refused", () => {
  it.each(REFUSED)("refuses %s, records nothing, and names only the fields at fault", async (name) => {
    const fixture = sendFixture(name);
    const double = doubleAt(fixture.given.now);
    const outcome = await double.sendEmail(fixture.request);
    expect(outcome).toMatchObject({ result: "failed", kind: "refused", code: "validation_error" });
    expect(validateSendErrors(outcome), JSON.stringify(validateSendErrors.errors)).toBe(true);
    expect(await sentEmails(double)).toEqual([]);
    const rejected = double.rejectedRequests();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.request).toEqual(fixture.request);
    const problems = rejected[0]?.problems ?? [];
    expect(problems.length).toBeGreaterThan(0);
    const lines = JSON.stringify([outcome, problems]);
    for (const value of [
      fixture.request.to,
      fixture.request.from.address,
      fixture.request.subject,
      fixture.request.text,
    ])
      expect(lines).not.toContain(value);
  });

  it("answers the From domain as Resend answers an unverified domain (403), and every other fault 400", async () => {
    for (const name of REFUSED) {
      const outcome = await doubleAt(NOW).sendEmail(sendFixture(name).request);
      expect(outcome).toMatchObject({ httpStatus: name.includes("from-other-domain") ? 403 : 400 });
    }
  });

  it("takes each refused fixture once its one fault is fixed", async () => {
    const copy = sendFixture("send-copy-of-text.json").request;
    const fixes: [string, (request: SendEmailRequest) => SendEmailRequest][] = [
      ["invalid/refuse-no-reply-address.json", (request) => ({ ...request, replyTo: copy.replyTo })],
      ["invalid/refuse-from-other-domain.json", (request) => ({ ...request, from: copy.from })],
      ["invalid/refuse-subject-line-break.json", (request) => ({ ...request, subject: copy.subject })],
      // A purpose of v1 makes it sendable to the port; its offer words are C-092's to refuse (K-12 README 'Fixtures').
      ["invalid/refuse-marketing-email.json", (request) => ({ ...request, purpose: "copy" })],
    ];
    for (const [name, fix] of fixes)
      expect((await doubleAt(NOW).sendEmail(fix(sendFixture(name).request))).result).toBe("accepted");
  });

  it("refuses what K-12 leaves to code, and what a booking and each purpose carry", async () => {
    const copy = sendFixture("send-copy-of-text.json").request;
    const confirmation = sendFixture("send-confirmation-with-chat-link.json").request;
    const code = sendFixture("send-code.json").request;
    const rfc5 = "<rfc-demo-0005@email.example.com>";
    const faults: unknown[] = [
      { ...copy, text: copy.text.slice(copy.assistantLine.length + 2) },
      { ...copy, assistantLine: "This is Rosie for Lee's Barbershop." },
      { ...copy, manageLink: "https://example.com/m/zz9" },
      { ...copy, thread: { inReplyTo: rfc5, references: [rfc5, "<rfc-demo-0006@email.example.com>"] } },
      { ...copy, thread: { inReplyTo: rfc5, references: [] } },
      { ...copy, chatLink: confirmation.chatLink },
      {
        ...copy,
        bookingId: null,
        replyTo: null,
        manageLink: null,
        thread: { inReplyTo: null, references: [] },
      },
      { ...confirmation, chatLink: null },
      { ...confirmation, text: confirmation.text.replace(confirmation.chatLink?.link ?? "", "") },
      { ...confirmation, bookingId: null, replyTo: null, manageLink: null },
      { ...code, replyTo: "booking-alex-haircut@reply.example.com" },
      { ...code, thread: { inReplyTo: rfc5, references: [rfc5] } },
      { ...copy, to: "Alex@Example.com" },
      { ...copy, html: "<p>Sure.</p>" },
      { ...copy, idempotencyKey: "out-a7-03-alex-email" },
      "an email",
      null,
    ];
    const double = doubleAt(NOW);
    for (const request of faults)
      expect(await double.sendEmail(request)).toMatchObject({ result: "failed", kind: "refused" });
    expect(await sentEmails(double)).toEqual([]);
    expect(double.rejectedRequests()).toHaveLength(faults.length);
  });
});

describe("sendEmail: one idempotency key sends once", () => {
  it("answers a repeat with the first answer and records the email once", async () => {
    const double = doubleAt(NOW);
    const request = sendFixture("send-copy-of-text.json").request;
    const first = await double.sendEmail(request);
    expect(await double.sendEmail(structuredClone(request))).toEqual(first);
    expect(await sentEmails(double)).toEqual([request]);
  });

  it("refuses the same key with another email (409 invalid_idempotent_request) and keeps the first", async () => {
    const double = doubleAt(NOW);
    const request = sendFixture("send-copy-of-text.json").request;
    await double.sendEmail(request);
    const other = { ...request, subject: "Your haircut at Lee's Barbershop, again" };
    const outcome = await double.sendEmail(other);
    expect(outcome).toMatchObject({
      result: "failed",
      kind: "refused",
      httpStatus: 409,
      code: "invalid_idempotent_request",
      retryAfterSeconds: null,
    });
    expectExchange({ call: "sendEmail", given: given(NOW), request: other, outcome });
    expect(await sentEmails(double)).toEqual([request]);
  });

  it("sends again under one key only after Resend's 24 hours", async () => {
    let clock = NOW;
    const double = createEmailDouble({ now: () => clock });
    const request = sendFixture("send-copy-of-text.json").request;
    const first = await double.sendEmail(request);
    clock = "2026-10-24T14:05:02Z";
    expect(await double.sendEmail(request)).toEqual(first);
    clock = "2026-10-24T14:05:03Z";
    expect(await double.sendEmail(request)).toEqual({
      result: "accepted",
      providerMessageId: "email-double-msg-0002",
      acceptedAt: clock,
    });
    expect(await sentEmails(double)).toEqual([request, request]);
  });
});

describe("verifyWebhook: Svix's signature, then Resend's body", () => {
  it.each(VERIFIES)("answers %s as the fixture does, signed at test time", async (name) => {
    const fixture = verifyFixture(name);
    const double = doubleAt(fixture.given.now);
    const webhook = await double.signRaw(
      {
        webhookId: fixture.request.webhookId,
        timestamp: fixture.request.timestamp,
        raw: fixture.request.raw,
        receivedAt: fixture.request.receivedAt,
        traceId: fixture.request.traceId,
      },
      { oneByteChanged: fixture.given.signing === "oneByteChanged" },
    );
    expect({ ...webhook, signature: fixture.request.signature }).toEqual(fixture.request);
    const outcome = await double.verifyWebhook(webhook);
    expect(outcome).toEqual(fixture.outcome);
    expectExchange({ ...fixture, request: webhook, outcome });
    if (outcome.result === "event") {
      expectEvent(outcome.event);
      // The delivered and bounce events are their K-06 events byte for byte: the same fields, in K-06's order.
      expect(JSON.stringify(outcome.event)).toBe(
        JSON.stringify((fixture.outcome as { event: unknown }).event),
      );
    }
  });

  it("rejects another key, a changed body, a bad or missing signature, and a stale or malformed timestamp", async () => {
    const fixture = verifyFixture("delivered.json");
    const double = doubleAt(fixture.given.now);
    const input = {
      webhookId: fixture.request.webhookId,
      raw: fixture.request.raw,
      receivedAt: fixture.request.receivedAt,
      traceId: fixture.request.traceId,
    };
    const signed = await double.signRaw({ ...input, timestamp: fixture.request.timestamp });
    const other = createEmailDouble({ webhookSecret: () => OTHER_SECRET });
    const cases: [unknown, string][] = [
      [await other.signRaw({ ...input, timestamp: fixture.request.timestamp }), "badSignature"],
      [{ ...signed, raw: signed.raw.replace("alex@example.com", "riley@example.com") }, "badSignature"],
      [{ ...signed, signature: "" }, "badSignature"],
      [{ ...signed, signature: signed.signature.replace("v1,", "v2,") }, "badSignature"],
      [{ ...signed, timestamp: `${fixture.request.timestamp}.5` }, "badTimestamp"],
      [
        await double.signRaw({ ...input, timestamp: String(Number(fixture.request.timestamp) - 301) }),
        "staleTimestamp",
      ],
      [await double.signRaw(input, { stale: true }), "staleTimestamp"],
      [{ ...signed, receivedAt: "yesterday" }, "badSignature"],
      ["not a webhook", "badSignature"],
    ];
    for (const [request, reason] of cases)
      expect(await double.verifyWebhook(request)).toEqual({ result: "rejected", httpStatus: 401, reason });
    // A double with no webhook key verifies nothing; the right key still passes.
    expect(await createEmailDouble().verifyWebhook(signed)).toEqual({
      result: "rejected",
      httpStatus: 401,
      reason: "badSignature",
    });
    expect(await double.verifyWebhook(signed)).toMatchObject({ result: "event" });
  });

  it("reads a suppressed or failed email as a failed receipt with no Message-ID, and takes an address out", async () => {
    const double = doubleAt(NOW);
    const data = {
      created_at: "2026-10-23T14:05:03.402Z",
      email_id: "email-msg-demo-0007",
      message_id: "<rfc-demo-0007@email.example.com>",
      from: "Lee's Barbershop <rosie@mail.rosfield.com>",
      to: ["Alex@Example.com"],
      subject: "Your haircut at Lee's Barbershop",
    };
    const cases: [Record<string, unknown>, EmailFailureCode, string, string | null][] = [
      [
        {
          suppressed: {
            message: "The address is on the suppression list.",
            type: "OnAccountSuppressionList",
          },
        },
        "suppressed",
        "The address is on the suppression list.",
        null,
      ],
      [{ failed: { reason: "reached_daily_quota" } }, "notSent", "reached_daily_quota", null],
      [
        {
          bounce: {
            message: "550 5.2.2 <alex@example.com>: mailbox full",
            subType: "MailboxFull",
            type: "Transient",
          },
        },
        "bounceTemporary",
        "550 5.2.2 [redacted]: mailbox full",
        "<rfc-demo-0007@email.example.com>",
      ],
    ];
    const types: Record<EmailFailureCode, string> = {
      bouncePermanent: "email.bounced",
      bounceTemporary: "email.bounced",
      suppressed: "email.suppressed",
      notSent: "email.failed",
    };
    for (const [extra, code, reason, rfcMessageId] of cases) {
      const raw = JSON.stringify({
        type: types[code],
        created_at: "2026-10-23T14:05:09.126Z",
        data: { ...data, ...extra },
      });
      const webhook = await double.signRaw({
        webhookId: `evt-email-${code}-0007`,
        raw,
        receivedAt: "2026-10-23T14:05:10Z",
        traceId: `trace-email-${code}-0007`,
      });
      const outcome = await double.verifyWebhook(webhook);
      expect(outcome).toMatchObject({
        result: "event",
        httpStatus: 200,
        event: {
          kind: "failed",
          handle: { kind: "email", address: "alex@example.com" },
          status: { messageId: "email-msg-demo-0007", at: "2026-10-23T14:05:09Z", failure: { code, reason } },
        },
        rfcMessageId,
      });
      expectExchange({ call: "verifyWebhook", given: given(NOW, "valid"), request: webhook, outcome });
    }
  });

  it("answers 200 and drops a type Rosie does not use, a reply to no receiving address, and a body it cannot read", async () => {
    const double = doubleAt(NOW);
    const at = "2026-10-23T14:05:09.126Z";
    const cases: [string, string][] = [
      [
        JSON.stringify({ type: "email.opened", created_at: at, data: { email_id: "email-msg-demo-0007" } }),
        "email.opened",
      ],
      [
        JSON.stringify({
          type: "email.received",
          created_at: at,
          data: {
            email_id: "resend-in-demo-alex-0009",
            from: "alex@example.com",
            to: ["rosie@mail.rosfield.com"],
          },
        }),
        "email.received",
      ],
      [
        JSON.stringify({
          type: "email.delivered",
          created_at: at,
          data: { email_id: "email-msg-demo-0007", to: [] },
        }),
        "email.delivered",
      ],
      ["not json", "unknown.unreadable"],
      [JSON.stringify({ type: "Email Delivered", data: {} }), "unknown.unreadable"],
    ];
    for (const [raw, eventType] of cases) {
      const webhook = await double.signRaw({
        webhookId: "evt-email-ignored-0001",
        raw,
        receivedAt: "2026-10-23T14:05:10Z",
        traceId: "trace-email-ignored-0001",
      });
      const outcome = await double.verifyWebhook(webhook);
      expect(outcome).toEqual({ result: "ignored", httpStatus: 200, eventType });
      expectExchange({ call: "verifyWebhook", given: given(NOW, "valid"), request: webhook, outcome });
    }
  });
});

describe("doubleWebhook: faked delivered and bounce receipts", () => {
  it("makes K-12 double-signed-webhook.json, and verifyWebhook gives back its event and Message-ID", async () => {
    const fixture = webhookFixture("double-signed-webhook.json");
    const double = await withBenConfirmation();
    const outcome = await double.doubleWebhook(fixture.request);
    expect(outcome.webhook.raw).toBe(fixture.outcome.webhook.raw);
    expect(outcome.webhook.timestamp).toBe(fixture.outcome.webhook.timestamp);
    expect(outcome.webhook.signature).toMatch(/^v1,[A-Za-z0-9+/]+=*$/);
    expect({
      ...outcome,
      webhook: { ...outcome.webhook, signature: fixture.outcome.webhook.signature },
    }).toEqual(fixture.outcome);
    expectExchange({ ...fixture, outcome });
    const verified = await double.verifyWebhook(outcome.webhook);
    expect(verified).toEqual({
      result: "event",
      httpStatus: 200,
      event: fixture.request.event,
      rfcMessageId: fixture.request.rfcMessageId,
    });
    expectExchange({
      call: "verifyWebhook",
      given: fixture.given,
      request: outcome.webhook,
      outcome: verified,
    });
    if (verified.result === "event") expectEvent(verified.event);
  });

  const FAILURES: [EmailFailureCode, string | null][] = [
    ["bouncePermanent", "<email-double-0001@double.example.com>"],
    ["bounceTemporary", "<email-double-0001@double.example.com>"],
    ["suppressed", null],
    ["notSent", null],
  ];

  it.each(FAILURES)(
    "fakes a %s receipt that verifyWebhook gives back as its K-06 event",
    async (code, rfcMessageId) => {
      const fixture = webhookFixture("double-signed-webhook.json");
      const double = await withBenConfirmation();
      const event: EmailEvent = {
        ...fixture.request.event,
        eventId: `evt-email-double-${code}`,
        kind: "failed",
        status: {
          messageId: "email-double-msg-0001",
          at: "2026-10-24T11:00:07Z",
          failure: { code, reason: "The recipient's mail server rejected the email." },
        },
      };
      const outcome = await double.doubleWebhook({ event, rfcMessageId });
      expectExchange({
        call: "doubleWebhook",
        given: fixture.given,
        request: { event, rfcMessageId },
        outcome,
      });
      const verified = await double.verifyWebhook(outcome.webhook);
      expect(verified).toEqual({ result: "event", httpStatus: 200, event, rfcMessageId });
      expectExchange({
        call: "verifyWebhook",
        given: fixture.given,
        request: outcome.webhook,
        outcome: verified,
      });
      if (verified.result === "event") expectEvent(verified.event);
    },
  );

  it("signs a receipt the gateway gets long after its event as a later try, inside the window", async () => {
    const fixture = webhookFixture("double-signed-webhook.json");
    const double = await withBenConfirmation();
    const status = { messageId: "email-double-msg-0001", at: "2026-10-24T09:00:00Z", failure: null };
    const event: EmailEvent = { ...fixture.request.event, status };
    const outcome = await double.doubleWebhook({ event, rfcMessageId: null });
    expect(outcome.webhook.timestamp).toBe(String(Date.parse(event.receivedAt) / 1000));
    expect(await double.verifyWebhook(outcome.webhook)).toEqual({
      result: "event",
      httpStatus: 200,
      event,
      rfcMessageId: null,
    });
  });

  it("signs stale or with one byte changed on request, which verifyWebhook rejects", async () => {
    const fixture = webhookFixture("double-signed-webhook.json");
    const double = await withBenConfirmation();
    const stale = await double.doubleWebhook(fixture.request, { stale: true });
    const older = await double.doubleWebhook(fixture.request, { stale: 600 });
    const changed = await double.doubleWebhook(fixture.request, { oneByteChanged: true });
    expect(await double.verifyWebhook(stale.webhook)).toMatchObject({ reason: "staleTimestamp" });
    expect(await double.verifyWebhook(older.webhook)).toMatchObject({ reason: "staleTimestamp" });
    expect(await double.verifyWebhook(changed.webhook)).toMatchObject({ reason: "badSignature" });
  });

  it("refuses, by label, a receipt it cannot fake", async () => {
    const fixture = webhookFixture("double-signed-webhook.json");
    const double = await withBenConfirmation();
    const event = fixture.request.event;
    const failedWith = (code: EmailFailureCode, reason: string): EmailEvent => ({
      ...event,
      kind: "failed",
      status: { messageId: "email-double-msg-0001", at: "2026-10-24T11:00:07Z", failure: { code, reason } },
    });
    const rfc = "<email-double-0001@double.example.com>";
    const cases: [unknown, string][] = [
      [
        {
          event: { ...event, status: { ...event.status, messageId: "email-double-msg-0099" } },
          rfcMessageId: null,
        },
        "notRecorded",
      ],
      [
        { event: { ...event, handle: { kind: "email", address: "alex@example.com" } }, rfcMessageId: null },
        "wrongHandle",
      ],
      [{ event: failedWith("suppressed", "Suppressed."), rfcMessageId: rfc }, "messageIdOnUnsent"],
      [
        { event: failedWith("bouncePermanent", "No mailbox for ben@example.com."), rfcMessageId: rfc },
        "addressInReason",
      ],
      [{ event: { ...event, provider: "linq" }, rfcMessageId: null }, "badRequest"],
      [
        {
          event: { ...event, status: { ...event.status, at: "2026-10-24T11:00:07.5Z" } },
          rfcMessageId: null,
        },
        "badRequest",
      ],
      [{ event, rfcMessageId: "email-double-0001" }, "badRequest"],
      [{ event }, "badRequest"],
    ];
    for (const [request, code] of cases)
      await expect(double.doubleWebhook(request)).rejects.toMatchObject({ name: "EmailDoubleError", code });
  });

  it("signs nothing without a test key, or with a key that is not whsec_ and base64", async () => {
    const confirmation = sendFixture("send-confirmation-with-chat-link.json");
    const fixture = webhookFixture("double-signed-webhook.json");
    for (const [webhookSecret, code] of [
      [undefined, "noSecret"],
      [() => "not-a-key", "badSecret"],
    ] as const) {
      const double = createEmailDouble({
        now: () => confirmation.given.now,
        ...(webhookSecret === undefined ? {} : { webhookSecret }),
      });
      await double.sendEmail(confirmation.request);
      await expect(double.doubleWebhook(fixture.request)).rejects.toMatchObject({ code });
    }
  });
});

describe("doubleWebhook and readReply: an inbound reply in two steps", () => {
  it("makes K-12 double-signed-reply.json; readReply on its id gives K-06 email-reply-check-passed.json byte for byte", async () => {
    const fixture = webhookFixture("double-signed-reply.json");
    const double = doubleAt(fixture.given.now);
    const outcome = await double.doubleWebhook(fixture.request);
    expect(outcome.receivedEmailId).toBe("email-double-in-0001");
    expect(outcome.webhook.raw).toBe(fixture.outcome.webhook.raw);
    expect(outcome.webhook.timestamp).toBe(fixture.outcome.webhook.timestamp);
    expect({
      ...outcome,
      webhook: { ...outcome.webhook, signature: fixture.outcome.webhook.signature },
    }).toEqual(fixture.outcome);
    expectExchange({ ...fixture, outcome });
    // Step 1: the webhook carries the reply's metadata only.
    const notice = await double.verifyWebhook(outcome.webhook);
    expect(notice).toEqual({
      result: "reply",
      eventId: "evt-email-alex-0001",
      receivedEmailId: "email-double-in-0001",
      replyAddress: "booking-alex-haircut@reply.example.com",
    });
    expectExchange({
      call: "verifyWebhook",
      given: fixture.given,
      request: outcome.webhook,
      outcome: notice,
    });
    // Step 2: the gateway reads the reply before it answers, with its own receipt time and trace.
    const request: ReadReplyRequest = {
      eventId: "evt-email-alex-0001",
      receivedEmailId: "email-double-in-0001",
      receivedAt: outcome.webhook.receivedAt,
      traceId: outcome.webhook.traceId,
    };
    const read = await double.readReply(request);
    expectExchange({ call: "readReply", given: given(fixture.given.now), request, outcome: read });
    expect(read.result === "event" ? JSON.stringify(read.event) : read.result).toBe(
      JSON.stringify(k06("email-reply-check-passed.json")),
    );
  });

  it.each([
    ["inbound-reply-passed.json", "email-reply-check-passed.json"],
    ["inbound-reply-failed-check.json", "email-reply-check-failed.json"],
  ])("answers %s with K-06 %s byte for byte", async (name, k06Name) => {
    const fixture = readFixture(name);
    const event = k06(k06Name);
    const double = doubleAt(fixture.given.now);
    const signed = await double.doubleWebhook(
      { event, rfcMessageId: null },
      { receivedEmailId: fixture.request.receivedEmailId },
    );
    expect(await double.verifyWebhook(signed.webhook)).toEqual({
      result: "reply",
      eventId: fixture.request.eventId,
      receivedEmailId: fixture.request.receivedEmailId,
      replyAddress: event.email?.replyAddress,
    });
    const read = await double.readReply(fixture.request);
    expect(read).toEqual(fixture.outcome);
    expect(JSON.stringify(read)).toBe(JSON.stringify(fixture.outcome));
    expectExchange({ ...fixture, outcome: read });
    if (read.result === "event") expectEvent(read.event);
  });

  it("answers an automatic reply ignored, as reply-automatic-ignored.json", async () => {
    const fixture = readFixture("reply-automatic-ignored.json");
    const double = doubleAt(fixture.given.now);
    const outOfOffice: EmailEvent = {
      ...k06("email-reply-check-passed.json"),
      eventId: fixture.request.eventId,
      messageId: "email-msg-demo-alex-0003",
      sentAt: "2026-10-23T14:05:40Z",
      receivedAt: fixture.request.receivedAt,
      body: "I am away until Monday and will read your email then.",
      email: {
        replyAddress: "booking-alex-haircut@reply.example.com",
        subject: "Automatic reply: Your haircut at Lee's Barbershop",
        senderCheck: "passed",
      },
      traceId: fixture.request.traceId,
    };
    const signed = await double.doubleWebhook(
      { event: outOfOffice, rfcMessageId: null },
      { receivedEmailId: fixture.request.receivedEmailId, automatic: true },
    );
    expect(await double.verifyWebhook(signed.webhook)).toMatchObject({ result: "reply" });
    const read = await double.readReply(fixture.request);
    expect(read).toEqual(fixture.outcome);
    expectExchange({ ...fixture, outcome: read });
  });

  it("gives each read the gateway's own receivedAt and traceId, reads a kept reply again, and carries attachments", async () => {
    const double = doubleAt(NOW);
    const event: EmailEvent = {
      ...k06("email-reply-check-passed.json"),
      attachments: [{ attachmentId: "resend-att-demo-alex-0001", mediaType: "image/jpeg" }],
    };
    expectEvent(event);
    const signed = await double.doubleWebhook({ event, rfcMessageId: null });
    expect(JSON.parse(signed.webhook.raw)).toMatchObject({
      data: { attachments: [{ id: "resend-att-demo-alex-0001", content_type: "image/jpeg" }] },
    });
    const request: ReadReplyRequest = {
      eventId: event.eventId,
      receivedEmailId: "email-double-in-0001",
      receivedAt: event.receivedAt,
      traceId: event.traceId,
    };
    expect(await double.readReply(request)).toEqual({ result: "event", httpStatus: 200, event });
    const retried = {
      ...request,
      receivedAt: "2026-10-23T18:30:09Z",
      traceId: "trace-email-alex-0001-retry",
    };
    expect(await double.readReply(retried)).toEqual({
      result: "event",
      httpStatus: 200,
      event: { ...event, receivedAt: retried.receivedAt, traceId: retried.traceId },
    });
    const second = await double.doubleWebhook({
      event: { ...event, eventId: "evt-email-alex-0004" },
      rfcMessageId: null,
    });
    expect(second.receivedEmailId).toBe("email-double-in-0002");
  });

  it("answers a read failure the test chooses, and an id it keeps no reply for, in the contract's form", async () => {
    const fixture = readFixture("inbound-reply-passed.json");
    const double = doubleAt(fixture.given.now);
    await double.doubleWebhook(
      { event: k06("email-reply-check-passed.json"), rfcMessageId: null },
      { receivedEmailId: fixture.request.receivedEmailId },
    );
    double.failNextRead({ kind: "transient" });
    double.failNextRead({ kind: "unreadable", code: "email_above_quota" });
    const unknown = { ...fixture.request, receivedEmailId: "resend-in-demo-alex-0099" };
    const answers: [ReadReplyRequest, ReadReplyOutcome, Record<string, unknown>][] = [];
    for (const [request, expected] of [
      [fixture.request, { kind: "transient", httpStatus: 503 }],
      [fixture.request, { kind: "unreadable", httpStatus: 200, code: "email_above_quota" }],
      [unknown, { kind: "unreadable", httpStatus: 200, code: "not_found" }],
    ] as const)
      answers.push([request, await double.readReply(request), expected]);
    for (const [request, outcome, expected] of answers) {
      expect(outcome).toMatchObject({ result: "failed", ...expected });
      expectExchange({ call: "readReply", given: given(fixture.given.now), request, outcome });
    }
    // Resend retries after the 503, and the reply is still there.
    expect(await double.readReply(fixture.request)).toEqual(fixture.outcome);
    expect(() => {
      double.failNextRead({ kind: "lost" } as unknown as { kind: "transient" });
    }).toThrow(EmailDoubleError);
  });

  it("refuses, by label, a reply it cannot fake", async () => {
    const double = doubleAt(NOW);
    const event = k06("email-reply-check-passed.json");
    const reply = event.email;
    if (reply === null) throw new Error("the K-06 reply has no email fields");
    const cases: [unknown, string][] = [
      [{ event, rfcMessageId: "<rfc-demo-0007@email.example.com>" }, "messageIdOnReply"],
      [
        {
          event: { ...event, email: { ...reply, replyAddress: "booking-alex-haircut@mail.rosfield.com" } },
          rfcMessageId: null,
        },
        "notReceivingDomain",
      ],
      [{ event: { ...event, sentAt: null }, rfcMessageId: null }, "badRequest"],
      [
        {
          event: { ...event, attachments: [{ attachmentId: "", mediaType: "image/jpeg" }] },
          rfcMessageId: null,
        },
        "badRequest",
      ],
      [{ event: { ...event, chatId: "linq-chat-demo-alex" }, rfcMessageId: null }, "badRequest"],
    ];
    for (const [request, code] of cases)
      await expect(double.doubleWebhook(request)).rejects.toMatchObject({ name: "EmailDoubleError", code });
    expect(
      await double.readReply({
        eventId: event.eventId,
        receivedEmailId: "email-double-in-0001",
        receivedAt: event.receivedAt,
        traceId: event.traceId,
      }),
    ).toMatchObject({ result: "failed", kind: "unreadable", code: "not_found" });
  });
});

describe("reset and isolation", () => {
  it("reset clears the record, the keys, the kept replies, the scripts and the ids", async () => {
    const double = await withBenConfirmation();
    const event = k06("email-reply-check-passed.json");
    await double.doubleWebhook({ event, rfcMessageId: null });
    double.failNextSend({ kind: "transient" }, { times: 3 });
    double.failNextRead({ kind: "transient" }, { times: 3 });
    await double.sendEmail(sendFixture("send-code.json").request);
    await double.sendEmail("not an email");
    double.reset();
    expect(await sentEmails(double)).toEqual([]);
    expect(double.rejectedRequests()).toEqual([]);
    expect(
      await double.readReply({
        eventId: event.eventId,
        receivedEmailId: "email-double-in-0001",
        receivedAt: event.receivedAt,
        traceId: event.traceId,
      }),
    ).toMatchObject({ result: "failed", code: "not_found" });
    expect(
      await double.sendEmail(sendFixture("send-confirmation-with-chat-link.json").request),
    ).toMatchObject({
      result: "accepted",
      providerMessageId: "email-double-msg-0001",
    });
  });

  it("hands out copies: changing what it gave back, or what it was given, changes nothing it keeps", async () => {
    const double = doubleAt(NOW);
    const request = sendFixture("send-copy-of-text.json").request;
    await double.sendEmail(request);
    request.text = "changed";
    const [first] = (await double.doubleSentEmails({ to: null })).emails;
    if (first === undefined) throw new Error("nothing recorded");
    expect(first.request.text).not.toBe("changed");
    first.request.text = "changed again";
    expect((await double.doubleSentEmails({ to: null })).emails[0]?.request.text).toBe(
      sendFixture("send-copy-of-text.json").request.text,
    );
  });
});
