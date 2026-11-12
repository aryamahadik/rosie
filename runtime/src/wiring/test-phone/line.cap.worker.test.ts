// Staging's test-phone line keeps a bounded record (T-1238; DL-392), inside the Workers runtime with env.staging's
// TEST_PHONE_LINE binding (wrangler.jsonc), the class the Worker's main module exports (./line.ts):
//
//   - past a recipient's cap the oldest record is gone, from the answer and from the table, and the newest are kept in
//     order, for parts (PARTS_PER_RECIPIENT) and for emails (EMAILS_PER_RECIPIENT);
//   - past the recipients in all (PART_RECIPIENTS, EMAIL_RECIPIENTS), the recipient sent to least recently goes, whole;
//   - one recipient's flood drops only that recipient's own records, even with the line at its recipients in all;
//   - a repeated idempotency key adds nothing and drops nothing, and is answered as the first send was;
//   - after the object is rebuilt from storage (an eviction), the same records answer, and the caps still hold;
//   - a repeat of a key whose record the cap has dropped (its recipient dropped whole, or the key past its recipient's
//     cap) stores nothing and drops nothing, for parts and for emails: the double answers it from its memory (DL-504);
//   - after an eviction, a repeat of a dropped key is the new double's new send: kept once, as any new send.
//
// Each flood runs inside the object (runInDurableObject), so hundreds of sends take no network hop; every read is the
// line's own RPC answer, as the page reads it. Test values only (rule 9): the fictional 555-01xx numbers, example.com
// addresses and K-12's send-copy-of-text.json with its key and address changed.
import sendCopy from "@rosie/contracts/port-email/fixtures/send-copy-of-text.json";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import type { SendEmailRequest } from "@rosie/adapters/email/double";
import type { SendPartRequest } from "@rosie/adapters/linq/double";
import type { RecordedPart } from "@rosie/actions/src/page-calls/staging/test-phone/index";

import {
  EMAIL_RECIPIENTS,
  EMAILS_PER_RECIPIENT,
  PART_RECIPIENTS,
  PARTS_PER_RECIPIENT,
  type TestPhoneLine,
} from "./line";
import type { TestPhoneLinePort } from "./pages";

/** A run through the Workers runtime's own steps: the resource guard of the other wiring Workers tests. */
const TEST_MS = 30_000;

/** K-21 test-roster.json's tp-01 (Sam, 555-0100) and tp-04 (555-0104). */
const SAM = "+15555550100";
const TP_04 = "+15555550104";

/** One line: its stub, for runInDurableObject and the eviction, and its RPC calls as the page's port reaches them. */
interface Line extends TestPhoneLinePort {
  readonly stub: DurableObjectStub<TestPhoneLine>;
}

/** A line of its own for each test (and reset() after each), from env.staging's TEST_PHONE_LINE binding. */
function freshLine(): Line {
  const namespace = env.TEST_PHONE_LINE;
  if (namespace === undefined) throw new Error("env.staging binds no TEST_PHONE_LINE");
  const stub = namespace.get(namespace.idFromName(crypto.randomUUID()));
  // The stub's own type wraps the class's RPC methods, so it is typed as the port, as ./pages.ts testPhoneLineOf does.
  const port = stub as unknown as TestPhoneLinePort;
  return {
    stub,
    sendPart: (request) => port.sendPart(request),
    partsTo: (number) => port.partsTo(number),
    sendEmail: (request) => port.sendEmail(request),
    sentEmails: (request) => port.sentEmails(request),
  };
}

/** The i-th fictional number, +1 555 555 01ii. */
const numberOf = (i: number): string => `+155555501${String(i).padStart(2, "0")}`;

/** The i-th test address. */
const addressOf = (i: number): string => `tester-${String(i).padStart(2, "0")}@example.com`;

/** Part n to a number: K-11 v1 words under its own row key, as the dispatcher sends it. */
function part(to: string, n: number): SendPartRequest {
  return {
    idempotencyKey: `out-cap-${to.slice(-4)}-${String(n)}/1/1`,
    to,
    chatId: `chat-cap-${to.slice(-4)}`,
    service: "imessage",
    kind: "words",
    text: `Part ${String(n)} to ${to.slice(-4)}.`,
    calendarFile: null,
    options: [],
    link: null,
    photo: null,
    tapback: null,
    threadedReplyTo: null,
    typing: null,
    overrideOptout: false,
  };
}

/** Email n to an address: K-12's send-copy-of-text.json under its own key (its purpose types as a plain string). */
function email(to: string, n: number): SendEmailRequest {
  return {
    ...(sendCopy.request as SendEmailRequest),
    idempotencyKey: `out-cap-${to.slice(0, 9)}-${String(n)}/1/1`,
    to,
  };
}

/** Sends parts first..last to a number from inside the line, in order. */
async function sendParts(line: Line, to: string, first: number, last: number): Promise<void> {
  await runInDurableObject(line.stub, async (instance: TestPhoneLine) => {
    for (let n = first; n <= last; n += 1) {
      expect(await instance.sendPart(part(to, n))).toMatchObject({ result: "accepted" });
    }
  });
}

/** Sends emails first..last to an address from inside the line, in order. */
async function sendEmails(line: Line, to: string, first: number, last: number): Promise<void> {
  await runInDurableObject(line.stub, async (instance: TestPhoneLine) => {
    for (let n = first; n <= last; n += 1) {
      expect(await instance.sendEmail(email(to, n))).toMatchObject({ result: "accepted" });
    }
  });
}

/** The keys of the records a list holds, in its order. */
const partKeys = (parts: readonly RecordedPart[]): (string | null)[] =>
  parts.map((recorded) => recorded.sent.idempotencyKey);

async function emailKeys(line: Line, to: string | null): Promise<string[]> {
  const kept = await line.sentEmails({ to });
  return kept.emails.map((recorded) => recorded.request.idempotencyKey);
}

/** The keys parts first..last to a number were sent under, in order. */
function expectedPartKeys(to: string, first: number, last: number): string[] {
  const keys: string[] = [];
  for (let n = first; n <= last; n += 1) keys.push(part(to, n).idempotencyKey ?? "");
  return keys;
}

function expectedEmailKeys(to: string, first: number, last: number): string[] {
  const keys: string[] = [];
  for (let n = first; n <= last; n += 1) keys.push(email(to, n).idempotencyKey);
  return keys;
}

/** What one table holds, oldest first: each row's key and recipient. */
async function tableRows(
  line: Line,
  table: "test_phone_parts" | "test_phone_emails",
): Promise<{ key: string | null; recipient: string }[]> {
  return runInDurableObject(line.stub, (_instance: TestPhoneLine, state) =>
    state.storage.sql
      .exec<{ key: string | null; recipient: string }>(
        `SELECT idempotency_key AS key, recipient FROM ${table} ORDER BY seq`,
      )
      .toArray(),
  );
}

afterEach(async () => {
  await reset();
});

describe("the caps are fixed numbers of the module", () => {
  it("hold a 20-text run five times over (at most two parts and one email a row) and the roster's five phones four times over", () => {
    expect(PARTS_PER_RECIPIENT).toBeGreaterThanOrEqual(5 * 20 * 2);
    expect(EMAILS_PER_RECIPIENT).toBeGreaterThanOrEqual(5 * 20);
    // Staging's roster has five test phones: room for all of them, four times over.
    expect(PART_RECIPIENTS).toBeGreaterThanOrEqual(4 * 5);
    expect(EMAIL_RECIPIENTS).toBeGreaterThanOrEqual(4 * 5);
  });
});

describe("parts: past a number's cap the oldest go first", () => {
  it(
    "keeps the newest PARTS_PER_RECIPIENT parts to the number, in the order they were sent; the oldest are gone from the answer and the table",
    { timeout: TEST_MS },
    async () => {
      const line = freshLine();
      const past = 5;
      await sendParts(line, SAM, 1, PARTS_PER_RECIPIENT + past);

      const kept = await line.partsTo(SAM);
      expect(partKeys(kept)).toEqual(expectedPartKeys(SAM, past + 1, PARTS_PER_RECIPIENT + past));
      // Each kept part answers as it did before the cap: its words, its answer and its time.
      expect(kept[kept.length - 1]).toMatchObject({
        sent: { text: part(SAM, PARTS_PER_RECIPIENT + past).text, to: SAM },
        outcome: { result: "accepted", chatId: part(SAM, 1).chatId },
      });
      const rows = await tableRows(line, "test_phone_parts");
      expect(rows.map((row) => row.key)).toEqual(expectedPartKeys(SAM, past + 1, PARTS_PER_RECIPIENT + past));
    },
  );

  it(
    "one number's flood drops only its own parts: every other number keeps each of its parts, even with the line at its numbers in all",
    { timeout: TEST_MS },
    async () => {
      const line = freshLine();
      // PART_RECIPIENTS numbers in all: the flooded one and the others, three parts each.
      const others = Array.from({ length: PART_RECIPIENTS - 1 }, (_unused, i) => numberOf(i + 1));
      expect(others).toContain(TP_04);
      for (const other of others) await sendParts(line, other, 1, 3);
      await sendParts(line, SAM, 1, 2 * PARTS_PER_RECIPIENT);

      for (const other of others) {
        expect(partKeys(await line.partsTo(other)), other).toEqual(expectedPartKeys(other, 1, 3));
      }
      expect(partKeys(await line.partsTo(SAM))).toEqual(
        expectedPartKeys(SAM, PARTS_PER_RECIPIENT + 1, 2 * PARTS_PER_RECIPIENT),
      );
      const rows = await tableRows(line, "test_phone_parts");
      expect(rows).toHaveLength(others.length * 3 + PARTS_PER_RECIPIENT);
    },
  );

  it(
    "past PART_RECIPIENTS numbers, the number sent to least recently goes whole; the rest keep every part",
    { timeout: TEST_MS },
    async () => {
      const line = freshLine();
      const numbers = Array.from({ length: PART_RECIPIENTS }, (_unused, i) => numberOf(i));
      for (const number of numbers) await sendParts(line, number, 1, 2);
      // The first number is sent to again, so the second is now the one sent to least recently.
      const [first, second] = numbers as [string, string, ...string[]];
      await sendParts(line, first, 3, 3);
      const newcomer = numberOf(PART_RECIPIENTS);
      await sendParts(line, newcomer, 1, 1);

      expect(await line.partsTo(second)).toEqual([]);
      expect(partKeys(await line.partsTo(first))).toEqual(expectedPartKeys(first, 1, 3));
      for (const number of numbers.slice(2)) {
        expect(partKeys(await line.partsTo(number)), number).toEqual(expectedPartKeys(number, 1, 2));
      }
      expect(partKeys(await line.partsTo(newcomer))).toEqual(expectedPartKeys(newcomer, 1, 1));
      const rows = await tableRows(line, "test_phone_parts");
      expect(new Set(rows.map((row) => row.recipient)).size).toBe(PART_RECIPIENTS);
      expect(rows.some((row) => row.recipient === second)).toBe(false);
    },
  );

  it(
    "at the cap, a repeated idempotency key adds nothing and drops nothing, and is answered as the first send was",
    { timeout: TEST_MS },
    async () => {
      const line = freshLine();
      await sendParts(line, SAM, 1, PARTS_PER_RECIPIENT);
      const before = await line.partsTo(SAM);
      const oldest = before[0];
      const repeated = before[PARTS_PER_RECIPIENT - 1];
      if (oldest === undefined || repeated === undefined) throw new Error("the line kept no parts");

      // The newest and the oldest kept part, each sent again under its own key.
      expect(await line.sendPart(part(SAM, PARTS_PER_RECIPIENT))).toEqual(repeated.outcome);
      expect(await line.sendPart(part(SAM, 1))).toEqual(oldest.outcome);

      expect(await line.partsTo(SAM)).toEqual(before);
      const rows = await tableRows(line, "test_phone_parts");
      expect(rows.map((row) => row.key)).toEqual(expectedPartKeys(SAM, 1, PARTS_PER_RECIPIENT));
    },
  );
});

describe("emails: past an address's cap the oldest go first", () => {
  it(
    "keeps the newest EMAILS_PER_RECIPIENT emails to the address, oldest first; the oldest are gone from the answer and the table",
    { timeout: TEST_MS },
    async () => {
      const line = freshLine();
      const to = addressOf(1);
      const past = 3;
      await sendEmails(line, to, 1, EMAILS_PER_RECIPIENT + past);

      const expected = expectedEmailKeys(to, past + 1, EMAILS_PER_RECIPIENT + past);
      expect(await emailKeys(line, to)).toEqual(expected);
      expect(await emailKeys(line, null)).toEqual(expected);
      const rows = await tableRows(line, "test_phone_emails");
      expect(rows.map((row) => row.key)).toEqual(expected);
    },
  );

  it(
    "one address's flood drops only its own emails: every other address keeps each of its emails, even with the line at its addresses in all",
    { timeout: TEST_MS },
    async () => {
      const line = freshLine();
      const others = Array.from({ length: EMAIL_RECIPIENTS - 1 }, (_unused, i) => addressOf(i + 1));
      for (const other of others) await sendEmails(line, other, 1, 2);
      const flooded = addressOf(0);
      await sendEmails(line, flooded, 1, 2 * EMAILS_PER_RECIPIENT);

      for (const other of others) {
        expect(await emailKeys(line, other), other).toEqual(expectedEmailKeys(other, 1, 2));
      }
      expect(await emailKeys(line, flooded)).toEqual(
        expectedEmailKeys(flooded, EMAILS_PER_RECIPIENT + 1, 2 * EMAILS_PER_RECIPIENT),
      );
      expect(await tableRows(line, "test_phone_emails")).toHaveLength(
        others.length * 2 + EMAILS_PER_RECIPIENT,
      );
    },
  );

  it(
    "past EMAIL_RECIPIENTS addresses, the address sent to least recently goes whole; the rest keep every email",
    { timeout: TEST_MS },
    async () => {
      const line = freshLine();
      const addresses = Array.from({ length: EMAIL_RECIPIENTS }, (_unused, i) => addressOf(i));
      for (const address of addresses) await sendEmails(line, address, 1, 1);
      const [first, second] = addresses as [string, string, ...string[]];
      await sendEmails(line, first, 2, 2);
      const newcomer = addressOf(EMAIL_RECIPIENTS);
      await sendEmails(line, newcomer, 1, 1);

      expect(await emailKeys(line, second)).toEqual([]);
      expect(await emailKeys(line, first)).toEqual(expectedEmailKeys(first, 1, 2));
      for (const address of addresses.slice(2)) {
        expect(await emailKeys(line, address), address).toEqual(expectedEmailKeys(address, 1, 1));
      }
      expect(await emailKeys(line, newcomer)).toEqual(expectedEmailKeys(newcomer, 1, 1));
      const rows = await tableRows(line, "test_phone_emails");
      expect(new Set(rows.map((row) => row.recipient)).size).toBe(EMAIL_RECIPIENTS);
    },
  );

  it(
    "at the cap, a repeated idempotency key adds nothing and drops nothing, and is answered as the first send was",
    { timeout: TEST_MS },
    async () => {
      const line = freshLine();
      const to = addressOf(1);
      await sendEmails(line, to, 1, EMAILS_PER_RECIPIENT);
      const before = await line.sentEmails({ to });
      const first = before.emails[0];
      if (first === undefined) throw new Error("the line kept no emails");

      expect(await line.sendEmail(email(to, 1))).toEqual({
        result: "accepted",
        providerMessageId: first.providerMessageId,
        acceptedAt: expect.any(String) as string,
      });
      expect(await line.sentEmails({ to })).toEqual(before);
      const rows = await tableRows(line, "test_phone_emails");
      expect(rows.map((row) => row.key)).toEqual(expectedEmailKeys(to, 1, EMAILS_PER_RECIPIENT));
    },
  );
});

describe("after the object is rebuilt from storage", () => {
  it(
    "the same parts and emails answer, the caps still hold, and a key sent again to the new instance stores nothing",
    { timeout: TEST_MS },
    async () => {
      const line = freshLine();
      const to = addressOf(1);
      await sendParts(line, SAM, 1, PARTS_PER_RECIPIENT + 2);
      await sendParts(line, TP_04, 1, 2);
      await sendEmails(line, to, 1, EMAILS_PER_RECIPIENT + 2);
      const parts = await line.partsTo(SAM);
      const tp04 = await line.partsTo(TP_04);
      const emails = await line.sentEmails({ to: null });

      // An eviction: a new instance, with new doubles, over the same storage.
      await evictDurableObject(line.stub);

      expect(await line.partsTo(SAM)).toEqual(parts);
      expect(await line.partsTo(TP_04)).toEqual(tp04);
      expect(await line.sentEmails({ to: null })).toEqual(emails);
      expect(await line.sentEmails({ to })).toEqual(emails);

      // The new doubles never saw these keys, so they record them again; the line keeps each once and drops nothing.
      expect(await line.sendPart(part(SAM, PARTS_PER_RECIPIENT + 2))).toMatchObject({ result: "accepted" });
      expect(await line.sendEmail(email(to, EMAILS_PER_RECIPIENT + 2))).toMatchObject({ result: "accepted" });
      expect(await line.partsTo(SAM)).toEqual(parts);
      expect(await line.sentEmails({ to: null })).toEqual(emails);

      // A new part and a new email past the caps drop the next oldest, as before the rebuild.
      await sendParts(line, SAM, PARTS_PER_RECIPIENT + 3, PARTS_PER_RECIPIENT + 3);
      await sendEmails(line, to, EMAILS_PER_RECIPIENT + 3, EMAILS_PER_RECIPIENT + 3);
      expect(partKeys(await line.partsTo(SAM))).toEqual(expectedPartKeys(SAM, 4, PARTS_PER_RECIPIENT + 3));
      expect(partKeys(await line.partsTo(TP_04))).toEqual(expectedPartKeys(TP_04, 1, 2));
      expect(await emailKeys(line, to)).toEqual(expectedEmailKeys(to, 4, EMAILS_PER_RECIPIENT + 3));
    },
  );
});

describe("a repeat of a key whose record the cap has dropped: the double sends nothing, so the line keeps nothing (DL-504)", () => {
  it(
    "emails: with its address dropped whole, the repeat is answered as the first send, stores nothing and drops nothing; every other address keeps its email",
    { timeout: TEST_MS },
    async () => {
      const line = freshLine();
      const dropped = addressOf(0);
      const first = await line.sendEmail(email(dropped, 1));
      expect(first).toMatchObject({ result: "accepted" });
      // EMAIL_RECIPIENTS other addresses, one email each: the first address, sent to least recently, goes whole.
      const others = Array.from({ length: EMAIL_RECIPIENTS }, (_unused, i) => addressOf(i + 1));
      for (const other of others) await sendEmails(line, other, 1, 1);
      expect(await emailKeys(line, dropped)).toEqual([]);
      const before = await line.sentEmails({ to: null });
      const rows = await tableRows(line, "test_phone_emails");

      // The same email again under its key: the double answers it from its memory and sends nothing again.
      expect(await line.sendEmail(email(dropped, 1))).toEqual(first);

      expect(await line.sentEmails({ to: null })).toEqual(before);
      expect(await tableRows(line, "test_phone_emails")).toEqual(rows);
      expect(await emailKeys(line, dropped)).toEqual([]);
      for (const other of others) {
        expect(await emailKeys(line, other), other).toEqual(expectedEmailKeys(other, 1, 1));
      }
    },
  );

  it(
    "emails: with the key past its address's cap, the repeat is answered as the first send, stores nothing and drops nothing; the address keeps its newest in order, and another address all of its own",
    { timeout: TEST_MS },
    async () => {
      const line = freshLine();
      const to = addressOf(1);
      const other = addressOf(2);
      await sendEmails(line, other, 1, 2);
      const first = await line.sendEmail(email(to, 1));
      expect(first).toMatchObject({ result: "accepted" });
      await sendEmails(line, to, 2, EMAILS_PER_RECIPIENT + 1);
      expect(await emailKeys(line, to)).toEqual(expectedEmailKeys(to, 2, EMAILS_PER_RECIPIENT + 1));
      const before = await line.sentEmails({ to: null });
      const rows = await tableRows(line, "test_phone_emails");

      expect(await line.sendEmail(email(to, 1))).toEqual(first);

      expect(await line.sentEmails({ to: null })).toEqual(before);
      expect(await tableRows(line, "test_phone_emails")).toEqual(rows);
      expect(await emailKeys(line, to)).toEqual(expectedEmailKeys(to, 2, EMAILS_PER_RECIPIENT + 1));
      expect(await emailKeys(line, other)).toEqual(expectedEmailKeys(other, 1, 2));
    },
  );

  it(
    "parts: with its number dropped whole, the repeat is answered as the first send, stores nothing and drops nothing; every other number keeps its part",
    { timeout: TEST_MS },
    async () => {
      const line = freshLine();
      const dropped = numberOf(0);
      const first = await line.sendPart(part(dropped, 1));
      expect(first).toMatchObject({ result: "accepted" });
      // PART_RECIPIENTS other numbers, one part each: the first number, sent to least recently, goes whole.
      const others = Array.from({ length: PART_RECIPIENTS }, (_unused, i) => numberOf(i + 1));
      for (const other of others) await sendParts(line, other, 1, 1);
      expect(await line.partsTo(dropped)).toEqual([]);
      const rows = await tableRows(line, "test_phone_parts");

      // The same part again under its key: Linq's dedupe answers it from the double's memory, which records nothing.
      expect(await line.sendPart(part(dropped, 1))).toEqual(first);

      expect(await tableRows(line, "test_phone_parts")).toEqual(rows);
      expect(await line.partsTo(dropped)).toEqual([]);
      for (const other of others) {
        expect(partKeys(await line.partsTo(other)), other).toEqual(expectedPartKeys(other, 1, 1));
      }
    },
  );

  it(
    "parts: with the key past its number's cap, the repeat is answered as the first send, stores nothing and drops nothing; the number keeps its newest in order, and another number all of its own",
    { timeout: TEST_MS },
    async () => {
      const line = freshLine();
      await sendParts(line, TP_04, 1, 2);
      const first = await line.sendPart(part(SAM, 1));
      expect(first).toMatchObject({ result: "accepted" });
      await sendParts(line, SAM, 2, PARTS_PER_RECIPIENT + 1);
      const before = await line.partsTo(SAM);
      expect(partKeys(before)).toEqual(expectedPartKeys(SAM, 2, PARTS_PER_RECIPIENT + 1));
      const tp04 = await line.partsTo(TP_04);
      const rows = await tableRows(line, "test_phone_parts");

      expect(await line.sendPart(part(SAM, 1))).toEqual(first);

      expect(await line.partsTo(SAM)).toEqual(before);
      expect(await line.partsTo(TP_04)).toEqual(tp04);
      expect(await tableRows(line, "test_phone_parts")).toEqual(rows);
    },
  );
});

describe("after an eviction, a repeat of a key the cap has dropped is the new double's new send", () => {
  it(
    "emails: the new double sends it again as a new email, and the line keeps that send once, as the address's newest, dropping its oldest as for any new email",
    { timeout: TEST_MS },
    async () => {
      const line = freshLine();
      const to = addressOf(1);
      const other = addressOf(2);
      await sendEmails(line, other, 1, 2);
      await sendEmails(line, to, 1, EMAILS_PER_RECIPIENT + 1);
      expect(await emailKeys(line, to)).toEqual(expectedEmailKeys(to, 2, EMAILS_PER_RECIPIENT + 1));

      // An eviction: a new instance, whose new email double knows no key.
      await evictDurableObject(line.stub);

      const resent = await line.sendEmail(email(to, 1));
      if (resent.result !== "accepted") throw new Error("the new double did not accept the email");
      const kept = await line.sentEmails({ to });
      expect(kept.emails.map((recorded) => recorded.request.idempotencyKey)).toEqual([
        ...expectedEmailKeys(to, 3, EMAILS_PER_RECIPIENT + 1),
        email(to, 1).idempotencyKey,
      ]);
      // The kept record is the new double's send, as it answered it.
      expect(kept.emails[kept.emails.length - 1]).toEqual({
        recordedAt: resent.acceptedAt,
        providerMessageId: resent.providerMessageId,
        request: email(to, 1),
      });

      // Sent once more, it is the new double's repeat: answered as that send, and nothing more is kept or dropped.
      const rows = await tableRows(line, "test_phone_emails");
      expect(await line.sendEmail(email(to, 1))).toEqual(resent);
      expect(await line.sentEmails({ to })).toEqual(kept);
      expect(await tableRows(line, "test_phone_emails")).toEqual(rows);
      expect(await emailKeys(line, other)).toEqual(expectedEmailKeys(other, 1, 2));
    },
  );

  it(
    "parts: the new double sends it again as a new part, and the line keeps that send once, its number back, dropping the number sent to least recently as for any new number",
    { timeout: TEST_MS },
    async () => {
      const line = freshLine();
      const dropped = numberOf(0);
      await sendParts(line, dropped, 1, 1);
      const others = Array.from({ length: PART_RECIPIENTS }, (_unused, i) => numberOf(i + 1));
      for (const other of others) await sendParts(line, other, 1, 1);
      expect(await line.partsTo(dropped)).toEqual([]);

      // An eviction: a new instance, whose new Linq double knows no key.
      await evictDurableObject(line.stub);

      const resent = await line.sendPart(part(dropped, 1));
      expect(resent).toMatchObject({ result: "accepted" });
      // The kept record is the new double's send, as it answered it.
      const kept = await line.partsTo(dropped);
      expect(kept).toEqual([{ at: expect.any(String) as string, sent: part(dropped, 1), outcome: resent }]);
      // As for any new number past PART_RECIPIENTS, the one sent to least recently goes whole; the rest keep their part.
      const [leastRecent, ...rest] = others as [string, ...string[]];
      expect(await line.partsTo(leastRecent)).toEqual([]);
      for (const number of rest) {
        expect(partKeys(await line.partsTo(number)), number).toEqual(expectedPartKeys(number, 1, 1));
      }

      // Sent once more, it is the new double's repeat: answered as that send, and nothing more is kept or dropped.
      const rows = await tableRows(line, "test_phone_parts");
      expect(await line.sendPart(part(dropped, 1))).toEqual(resent);
      expect(await line.partsTo(dropped)).toEqual(kept);
      expect(await tableRows(line, "test_phone_parts")).toEqual(rows);
    },
  );
});
