// Staging's test-phone line (T-1186; C-205; K-21 v1 testPhoneParts; build prompt 9.4 'The test-phone page'; DL-373's ruling
// on T-565's gap (a)): one Durable Object, `TestPhoneLine`, where staging's send paths and the test-phone page's list meet.
// The dispatcher sends each part from a handle actor's isolate and the page entry answers in another, so a record kept in
// one isolate's memory may never see the other's sends. Both call this one object instead, which every isolate reaches:
//
//   sendPart    K-11 v1 sendPart as staging's send path makes it (./pages.ts lineLinqSend): through T-565's parts recorder
//               in front of the Linq double (T-411), answered as the double answers. A part the double recorded is kept in
//               this object's storage, with the time of the answer and the answer (K-21 v1 RecordedPart), once per
//               idempotency key: the double's own record is in memory, so a repeat after an eviction is not listed twice
//   partsTo     the parts kept to one number, in the order they were sent (testPhoneParts' parts)
//   sendEmail   K-12 v1 sendEmail through the email double (T-418), for the email rows once they are joined: an email the
//               double accepted is kept, once per idempotency key
//   sentEmails  K-12 v1 doubleSentEmails over what is kept, oldest first (testPhoneParts' emails)
//
// One object for all of staging's test phones (./pages.ts TEST_PHONE_LINE_NAME): the roster's fictional 555-01xx phones all
// text through the one Linq double, as they would through one Linq line. The line never signs or verifies an email, so the
// email double is handed no webhook secret at all (never RESEND_WEBHOOK_SECRET; K-12 README line 22). The doubles are test
// code in the Worker bundle on staging only (DL-373 gap (d), CQ-181): production binds no TestPhoneLine. Nothing here logs:
// the records hold whole messages by design and leave only through the staging-only testPhoneParts answer.
//
// This module is the Workers runtime's alone (cloudflare:workers): the Worker's main module exports the class, and nothing
// the composition root imports loads it, so the root's Node tests never do.

import { DurableObject } from "cloudflare:workers";

import {
  createEmailDouble,
  type DoubleSentEmailsOutcome,
  type EmailDouble,
  type RecordedEmail,
  type SendEmailOutcome,
  type SendEmailRequest,
} from "@rosie/adapters/email/double";
import { createLinqDouble, type SendPartOutcome } from "@rosie/adapters/linq/double";
import {
  createPartsRecorder,
  type PartsRecorder,
  type RecordedPart,
} from "@rosie/actions/src/page-calls/staging/test-phone/index";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The number a sendPart request is to, or null when it names none (the double then refuses it and records nothing). */
function recipientOf(request: unknown): string | null {
  return isRecord(request) && typeof request.to === "string" ? request.to : null;
}

/** The kept parts and emails, each as the JSON of its record, under the recipient it went to. */
function createTables(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS test_phone_parts (
       seq INTEGER PRIMARY KEY AUTOINCREMENT,
       idempotency_key TEXT UNIQUE,
       recipient TEXT NOT NULL,
       record TEXT NOT NULL
     )`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS test_phone_emails (
       seq INTEGER PRIMARY KEY AUTOINCREMENT,
       idempotency_key TEXT NOT NULL UNIQUE,
       recipient TEXT NOT NULL,
       record TEXT NOT NULL
     )`,
  );
}

export class TestPhoneLine extends DurableObject {
  readonly #recorder: PartsRecorder;
  readonly #emails: EmailDouble;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    createTables(ctx.storage.sql);
    this.#recorder = createPartsRecorder(createLinqDouble());
    this.#emails = createEmailDouble();
  }

  /** K-11 v1 sendPart through the Linq double, answered as the double answers; a part it recorded is kept. */
  async sendPart(request: unknown): Promise<SendPartOutcome> {
    const to = recipientOf(request);
    const before = to === null ? 0 : this.#recorder.partsTo(to).length;
    const outcome = await this.#recorder.sendPart(request);
    if (to === null) return outcome;
    const parts = this.#recorder.partsTo(to);
    const recorded = parts.length > before ? parts[parts.length - 1] : undefined;
    if (recorded !== undefined) {
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO test_phone_parts (idempotency_key, recipient, record) VALUES (?, ?, ?)",
        recorded.sent.idempotencyKey,
        to,
        JSON.stringify(recorded),
      );
    }
    return outcome;
  }

  /** The parts kept to this number, in the order they were sent. */
  partsTo(number: string): RecordedPart[] {
    return this.ctx.storage.sql
      .exec<{ record: string }>(
        "SELECT record FROM test_phone_parts WHERE recipient = ? ORDER BY seq",
        number,
      )
      .toArray()
      .map((row) => JSON.parse(row.record) as RecordedPart);
  }

  /** K-12 v1 sendEmail through the email double, answered as the double answers; an email it accepted is kept. */
  async sendEmail(request: SendEmailRequest): Promise<SendEmailOutcome> {
    const outcome = await this.#emails.sendEmail(request);
    if (outcome.result !== "accepted") return outcome;
    const recorded = (await this.#emails.doubleSentEmails({ to: null })).emails.find(
      (email) => email.providerMessageId === outcome.providerMessageId,
    );
    if (recorded !== undefined) {
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO test_phone_emails (idempotency_key, recipient, record) VALUES (?, ?, ?)",
        recorded.request.idempotencyKey,
        recorded.request.to,
        JSON.stringify(recorded),
      );
    }
    return outcome;
  }

  /**
   * K-12 v1 doubleSentEmails over what is kept: every email (`to` null), or those to one address, oldest first. A request
   * of any other shape is refused, never read as every email.
   */
  sentEmails(request: unknown): DoubleSentEmailsOutcome {
    const to: unknown = isRecord(request) ? request.to : undefined;
    if (to !== null && typeof to !== "string") throw new TypeError("badSentEmailsRequest");
    const sql = this.ctx.storage.sql;
    const rows =
      to === null
        ? sql.exec<{ record: string }>("SELECT record FROM test_phone_emails ORDER BY seq")
        : sql.exec<{ record: string }>(
            "SELECT record FROM test_phone_emails WHERE recipient = ? ORDER BY seq",
            to,
          );
    return {
      result: "recorded",
      emails: rows.toArray().map((row) => JSON.parse(row.record) as RecordedEmail),
    };
  }
}
