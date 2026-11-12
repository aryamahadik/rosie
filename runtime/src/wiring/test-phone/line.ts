// Staging's test-phone line (T-1186; C-205; K-21 v1 testPhoneParts; build prompt 9.4 'The test-phone page'; DL-373's ruling
// on T-565's gap (a)): one Durable Object, `TestPhoneLine`, where staging's send paths and the test-phone page's list meet.
// The dispatcher sends each part from a handle actor's isolate and the page entry answers in another, so a record kept in
// one isolate's memory may never see the other's sends. Both call this one object instead, which every isolate reaches:
//
//   sendPart    K-11 v1 sendPart as staging's send path makes it (./pages.ts lineLinqSend): through T-565's parts recorder
//               in front of the Linq double (T-411), answered as the double answers. A part the double newly recorded in
//               this call is kept in this object's storage, with the time of the answer and the answer (K-21 v1
//               RecordedPart)
//   partsTo     the parts kept to one number, in the order they were sent (testPhoneParts' parts)
//   sendEmail   K-12 v1 sendEmail through the email double (T-418), for the email rows once they are joined: an email the
//               double newly recorded in this call is kept
//   sentEmails  K-12 v1 doubleSentEmails over what is kept, oldest first (testPhoneParts' emails)
//
// What is kept is bounded (T-1238; DL-392): at most PARTS_PER_RECIPIENT parts to each number and EMAILS_PER_RECIPIENT emails
// to each address, and at most PART_RECIPIENTS numbers and EMAIL_RECIPIENTS addresses in all. The record that would pass a
// cap drops the oldest in the same transaction that stores it: past a recipient's cap, that recipient's oldest record; past
// the recipients in all, the recipient sent to least recently, whole. So a flood to one recipient only ever drops that
// recipient's own records, and the line never holds more than recipients times the cap. The caps are constants of this
// module: no request can name, raise or lift them. T-565's recorder is made for each send, so no part stays in it once the
// send is over. The doubles' own memory of what they took (requests, keys, emails) is theirs and lasts until the object is
// evicted, as before: trimming it would change their answers, and it is what tells a repeat from a new send.
//
// The line's record mirrors what the doubles actually sent (T-1238; DL-504): a send is kept only when its double newly
// recorded it in that call. For parts, T-565's recorder, made for the send, lists a part only when the Linq double's record
// grew (actions/src/page-calls/staging/test-phone/parts.ts); for emails, the email double's record must grow in the call.
// The line remembers no dropped key of its own, and needs none. Within the object's life a double answers a repeat from
// its own memory (Linq's dedupe; Resend's idempotency key, for its 24 hours) and records nothing, so the line stores
// nothing and drops nothing, even when a cap has dropped that key's record. When a double sends a repeat again as a new
// message (after an eviction, whose new doubles know no key; the email double past those 24 hours), the line keeps that
// send once, as any new send, so it may drop an oldest record or recipient as above. A key the table still holds is never
// stored twice (idempotency_key is UNIQUE): sent again after an eviction, it keeps its first record.
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
import { createLinqDouble, type LinqDouble, type SendPartOutcome } from "@rosie/adapters/linq/double";
import {
  createPartsRecorder,
  type RecordedPart,
} from "@rosie/actions/src/page-calls/staging/test-phone/index";

/**
 * Parts kept to one number. A reply row is at most two sends, the words and then one poll or card (K-03 FinalParts; arch 07
 * line 367), so a 20-text staging run sends its phone about 40 parts, with a few safety or fixed lines besides: 200 holds
 * that run five times over, or a tester's last hundred or so texts.
 */
export const PARTS_PER_RECIPIENT = 200;

/** Emails kept to one address: at most one copy or notice a row, so 100 holds a 20-text run's emails with room to spare. */
export const EMAILS_PER_RECIPIENT = 100;

/**
 * Numbers and addresses kept in all. Staging's roster has five test phones, each with at most one person's address (Q-53;
 * K-21 test-roster.json), and the seeded staff's notices add a few addresses: 20 holds them all four times over. So at most
 * 4,000 parts and 2,000 emails are ever kept.
 */
export const PART_RECIPIENTS = 20;
export const EMAIL_RECIPIENTS = 20;

/** One table's caps: records per recipient, and recipients in all. */
interface Caps {
  readonly table: "test_phone_parts" | "test_phone_emails";
  readonly perRecipient: number;
  readonly recipients: number;
}

const PARTS: Caps = {
  table: "test_phone_parts",
  perRecipient: PARTS_PER_RECIPIENT,
  recipients: PART_RECIPIENTS,
};
const EMAILS: Caps = {
  table: "test_phone_emails",
  perRecipient: EMAILS_PER_RECIPIENT,
  recipients: EMAIL_RECIPIENTS,
};

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

/**
 * Keeps one record and drops what then passes a cap, in one transaction: the recipient's oldest records past its cap, then
 * every record of a recipient past the caps' recipients, the one sent to least recently first. A key the table already
 * holds stores nothing, so nothing is dropped. A typing part has no key (K-11) and is kept each time, as the double
 * records it.
 */
function keep(
  storage: DurableObjectStorage,
  caps: Caps,
  key: string | null,
  recipient: string,
  record: string,
): void {
  const sql = storage.sql;
  const { table } = caps;
  storage.transactionSync(() => {
    if (
      key !== null &&
      sql.exec(`SELECT 1 FROM ${table} WHERE idempotency_key = ?`, key).toArray().length > 0
    )
      return;
    sql.exec(
      `INSERT INTO ${table} (idempotency_key, recipient, record) VALUES (?, ?, ?)`,
      key,
      recipient,
      record,
    );
    sql.exec(
      `DELETE FROM ${table} WHERE seq IN (
         SELECT seq FROM ${table} WHERE recipient = ? ORDER BY seq DESC LIMIT -1 OFFSET ?
       )`,
      recipient,
      caps.perRecipient,
    );
    sql.exec(
      `DELETE FROM ${table} WHERE recipient IN (
         SELECT recipient FROM ${table} GROUP BY recipient ORDER BY MAX(seq) DESC LIMIT -1 OFFSET ?
       )`,
      caps.recipients,
    );
  });
}

export class TestPhoneLine extends DurableObject {
  readonly #linq: LinqDouble;
  readonly #emails: EmailDouble;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    createTables(ctx.storage.sql);
    this.#linq = createLinqDouble();
    this.#emails = createEmailDouble();
  }

  /**
   * K-11 v1 sendPart through the Linq double, answered as the double answers; a part the double newly recorded in this
   * call is kept (T-565's recorder lists nothing else).
   */
  async sendPart(request: unknown): Promise<SendPartOutcome> {
    // T-565's recorder for this send alone, in front of the line's one double: the part leaves it once it is kept.
    const recorder = createPartsRecorder(this.#linq);
    const outcome = await recorder.sendPart(request);
    const to = recipientOf(request);
    if (to === null) return outcome;
    const recorded = recorder.partsTo(to)[0];
    if (recorded !== undefined) {
      keep(this.ctx.storage, PARTS, recorded.sent.idempotencyKey, to, JSON.stringify(recorded));
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

  /**
   * K-12 v1 sendEmail through the email double, answered as the double answers. An email is kept only when the double
   * newly recorded it in this call, as T-565's recorder keeps a part: its record grew by one, and the newest is this send.
   * A repeat it answers from its memory, a refusal and a failure record nothing, so nothing is kept and nothing dropped.
   * The double answers at once, so nothing runs between its record and this one.
   */
  async sendEmail(request: SendEmailRequest): Promise<SendEmailOutcome> {
    const before = (await this.#emails.doubleSentEmails({ to: null })).emails.length;
    const outcome = await this.#emails.sendEmail(request);
    if (outcome.result !== "accepted") return outcome;
    const after = (await this.#emails.doubleSentEmails({ to: null })).emails;
    const recorded = after.length > before ? after[after.length - 1] : undefined;
    if (recorded !== undefined) {
      keep(
        this.ctx.storage,
        EMAILS,
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
