// T-419: the Resend send adapter against K-12 v1's send fixtures and its recorded vendor samples
// (contracts/port-email/vendor-samples). No network and no real key: the HTTP call is a stub that records each request
// and answers with a recorded response, and the key is a made-up string built here (rule 7). Every name and address is
// the fixtures' own (Lee's Barbershop and the master's sample cast on example.com, .example and reply.example.com, and
// Rosie's address on mail.rosfield.com: rule 9).
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, inflateSync } from "node:zlib";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { encode } from "uqr";
import { beforeAll, describe, expect, it } from "vitest";

import { loadRecordedSample } from "../../shared/samples";
import { createEmailDouble } from "../double/double";
import { sendEmailProblems as doubleProblems } from "../double/validate";
import { QR_QUIET, QR_SCALE } from "./qr-png";
import {
  RESEND_API_KEY,
  TEST_INBOXES,
  createResendSender,
  readTestInboxes,
  type ResendSendEnv,
  type ResendSenderOptions,
} from "./send";
import type { SendEmailFailed, SendEmailOutcome, SendEmailRequest } from "./types";
import { sendEmailProblems } from "./validate";
import { QR_FILENAME, RESEND_EMAILS_URL, USER_AGENT, fromHeader } from "./wire";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS = path.resolve(HERE, "..", "..", "..", "..", "contracts");
const FIXTURES = path.join(CONTRACTS, "port-email", "fixtures");
const SAMPLES = path.join(CONTRACTS, "port-email", "vendor-samples");
const K12_ID = "https://rosie.invalid/contracts/port-email/port-email.v1.schema.json";

// Made up here, not a key of any service, and not in a key's shape (rule 7).
const FAKE_KEY = "fake-resend-key-t419-0001";
// The addresses the recorded samples hold outside the reserved example domains: Rosie's own sending address and the
// fixtures' .example address (README 'Fixtures': the reserved .example domain).
const SAMPLE_ALLOW = { allow: ["rosie@mail.rosfield.com", "sam@lees-barbershop.example"] };

interface SendExchange {
  call: string;
  given: { now: string; note: string };
  request: SendEmailRequest;
  outcome: SendEmailOutcome;
}

/** A recorded vendor answer: its status, headers and body (contracts/port-email/vendor-samples/error-*.json). */
interface RecordedAnswer {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** One request as the stub saw it. */
interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  redirect: string;
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
const sendFixture = (name: string): SendExchange => readJson(path.join(FIXTURES, name)) as SendExchange;
const sample = (name: string): unknown => loadRecordedSample(SAMPLES, name, SAMPLE_ALLOW);

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

/** The recorded error answer each failure fixture is read from. */
const ERROR_SAMPLES: Record<string, string> = {
  "send-rate-limited.json": "error-rate-limit.json",
  "send-daily-quota.json": "error-daily-quota.json",
};

// K-12's vendor samples hold the request of the copy and the confirmation; the code and the S12-10 email have none, so
// their bodies are written here by the same mapping (README 'Spike findings' row 1): no reply_to and no headers for an
// email about no booking, and no headers for the first email of a booking's thread.
const CODE_BODY = {
  from: "Rosie <rosie@mail.rosfield.com>",
  to: ["sam@lees-barbershop.example"],
  subject: "Your Rosie code",
  text: "This is Rosie, an automated assistant, setting up Lee's Barbershop.\n\nCode 4829: type it on the page to prove this email. It works for 10 minutes.",
};
const FALLBACK_BODY = {
  from: "Lee's Barbershop <rosie@mail.rosfield.com>",
  to: ["alex@example.com"],
  reply_to: "booking-alex-riley-nov14@reply.example.com",
  subject: "Booked: Sat Nov 14, 11:00am",
  text: "This is Rosie, the automated booking assistant for Lee's Barbershop.\n\nTexts are delayed, so this comes by email.\nYou're booked with Riley at Lee's Barbershop.\nSat Nov 14, 11:00am\n\nManage your booking: https://example.com/m/b14",
};

/** The Resend body each fixture's request must build. */
function expectedBody(name: string): unknown {
  switch (name) {
    case "send-copy-of-text.json":
      return sample("send-email-request.json");
    case "send-confirmation-with-chat-link.json":
      return sample("send-email-request-confirmation.json");
    case "send-code.json":
    case "send-rate-limited.json":
      return CODE_BODY;
    case "send-fallback-s12-10.json":
    case "send-daily-quota.json":
      return FALLBACK_BODY;
    default:
      throw new Error(`no expected body for ${name}`);
  }
}

let validateExchange: ValidateFunction;
let validateSendErrors: ValidateFunction;

beforeAll(() => {
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  // Every contract's schemas, so the $refs between them resolve (as the email double's test loads them).
  for (const folder of readdirSync(CONTRACTS, { withFileTypes: true })) {
    if (!folder.isDirectory() || ["scripts", "generated", "node_modules"].includes(folder.name)) continue;
    for (const file of readdirSync(path.join(CONTRACTS, folder.name)))
      if (file.endsWith(".schema.json"))
        ajv.addSchema(readJson(path.join(CONTRACTS, folder.name, file)) as object);
  }
  const exchange = ajv.getSchema(K12_ID);
  const sendErrors = ajv.getSchema(`${K12_ID}#/$defs/sendEmail.errors`);
  if (exchange === undefined || sendErrors === undefined) throw new Error("a contract schema is missing");
  validateExchange = exchange;
  validateSendErrors = sendErrors;
});

function expectSendError(outcome: unknown): void {
  expect(validateSendErrors(outcome), JSON.stringify(validateSendErrors.errors)).toBe(true);
}

/** A stub of the HTTP call: records each request and answers with `answer` (a Response, or a thrown error). */
function stubFetch(answer: (request: Request) => Response | Promise<Response>): {
  fetch: (request: Request) => Promise<Response>;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: async (request) => {
      seen.push({
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(request.headers),
        body: await request.clone().text(),
        redirect: request.redirect,
      });
      return answer(request);
    },
  };
}

/** Resend's answer to a send it took: the recorded send-email-response.json's shape, with the given id. */
function accepted(id: string): Response {
  return new Response(JSON.stringify({ id }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** The recorded send-email-response.json itself, as Resend's answer to send-copy-of-text.json's request. */
function recordedResponse(): Response {
  return new Response(JSON.stringify(sample("send-email-response.json")), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function recordedAnswer(name: string): Response {
  const answer = sample(name) as RecordedAnswer;
  return new Response(JSON.stringify(answer.body), {
    status: answer.status,
    headers: { "content-type": "application/json", ...answer.headers },
  });
}

/** Resend's error answer in its documented form: {statusCode, name, message} (README 'Spike findings' row 4). */
function resendError(status: number, name: string | null, headers: Record<string, string> = {}): Response {
  const body =
    name === null ? "" : JSON.stringify({ statusCode: status, name, message: "Made up for a test." });
  return new Response(body, { status, headers });
}

function sender(env: ResendSendEnv, rest: Omit<ResendSenderOptions, "env"> = {}) {
  return createResendSender({ env, now: () => "2026-10-23T14:05:03Z", ...rest });
}

const envFor = (to: string): ResendSendEnv => ({ RESEND_API_KEY: FAKE_KEY, STAGING_TEST_INBOXES: to });

/** The request's own words and addresses, which no outcome may hold. */
function privateValues(request: SendEmailRequest): string[] {
  return [request.to, request.from.address, request.subject, request.text, FAKE_KEY];
}

interface Png {
  width: number;
  height: number;
  header: number[];
  rows: Uint8Array[];
}

/** A PNG read back: its signature, each chunk's CRC, IHDR, and the image rows inflated, each after its filter byte. */
function readPng(bytes: Uint8Array): Png {
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const types: string[] = [];
  const idat: Uint8Array[] = [];
  let header: Uint8Array = new Uint8Array(0);
  let at = 8;
  while (at < bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(at + 8, at + 8 + length);
    expect(view.getUint32(at + 8 + length)).toBe(crc32(bytes.subarray(at + 4, at + 8 + length)));
    types.push(type);
    if (type === "IHDR") header = data;
    if (type === "IDAT") idat.push(data);
    at += 12 + length;
  }
  expect(types).toEqual(["IHDR", "IDAT", "IEND"]);
  const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const width = headerView.getUint32(0);
  const height = headerView.getUint32(4);
  const compressed = new Uint8Array(idat.reduce((total, part) => total + part.length, 0));
  idat.reduce((offset, part) => {
    compressed.set(part, offset);
    return offset + part.length;
  }, 0);
  const raw = inflateSync(compressed);
  const stride = 1 + Math.ceil(width / 8);
  expect(raw.length).toBe(stride * height);
  const rows: Uint8Array[] = [];
  for (let y = 0; y < height; y += 1) {
    expect(raw[y * stride]).toBe(0);
    rows.push(raw.subarray(y * stride + 1, (y + 1) * stride));
  }
  return { width, height, header: [...header.subarray(8)], rows };
}

/** Each pixel of a one-bit PNG: true for black. */
function isBlack(png: Png, x: number, y: number): boolean {
  const byte = png.rows[y]?.[x >> 3] ?? 0;
  return ((byte >> (7 - (x & 7))) & 1) === 0;
}

/** Holds a PNG to the QR code of `text` that uqr encodes, module for module, with its quiet zone. */
function expectQrOf(bytes: Uint8Array, text: string): void {
  const png = readPng(bytes);
  // Bit depth 1, colour type 0 (greyscale), deflate, filter method 0, no interlace.
  expect(png.header).toEqual([1, 0, 0, 0, 0]);
  const qr = encode(text, { ecc: "M", border: 0 });
  const side = (qr.size + 2 * QR_QUIET) * QR_SCALE;
  expect([png.width, png.height]).toEqual([side, side]);
  let wrong = 0;
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const r = Math.floor(y / QR_SCALE) - QR_QUIET;
      const c = Math.floor(x / QR_SCALE) - QR_QUIET;
      const dark = r >= 0 && r < qr.size && c >= 0 && c < qr.size && qr.data[r]?.[c] === true;
      if (isBlack(png, x, y) !== dark) wrong += 1;
    }
  }
  expect(wrong).toBe(0);
}

function decodeBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

describe("the K-12 v1 send fixtures", () => {
  it("tests every sendEmail fixture K-12 v1's index lists", () => {
    const index = readJson(path.join(FIXTURES, "index.json")) as {
      fixtures: { file: string; def: string }[];
    };
    const sends = index.fixtures
      .filter((entry) => entry.def === "sendEmail.exchange")
      .map((entry) => entry.file);
    expect([...SENDS, ...SEND_FAILURES, ...REFUSED].sort()).toEqual(sends.sort());
  });
});

describe("sendEmail: each send fixture builds the recorded Resend request", () => {
  it.each([...SENDS, ...SEND_FAILURES])(
    "%s: from mail.rosfield.com, reply-to, thread headers and the idempotency header, answered as the fixture",
    async (name) => {
      const fixture = sendFixture(name);
      const errorSample = ERROR_SAMPLES[name];
      const outcome = fixture.outcome;
      const stub = stubFetch(() => {
        if (errorSample !== undefined) return recordedAnswer(errorSample);
        if (name === "send-copy-of-text.json") return recordedResponse();
        return accepted(outcome.result === "accepted" ? outcome.providerMessageId : "");
      });
      const answer = await sender(envFor(fixture.request.to), {
        fetch: stub.fetch,
        now: () => fixture.given.now,
      }).sendEmail(fixture.request);

      expect(answer).toEqual(fixture.outcome);
      expect(validateExchange({ ...fixture, outcome: answer }), JSON.stringify(validateExchange.errors)).toBe(
        true,
      );
      expect(stub.seen).toHaveLength(1);
      const [seen] = stub.seen;
      if (seen === undefined) throw new Error("no request was sent");
      expect(seen.method).toBe("POST");
      expect(seen.url).toBe(RESEND_EMAILS_URL);
      expect(seen.redirect).toBe("manual");
      expect(seen.headers).toEqual({
        authorization: `Bearer ${FAKE_KEY}`,
        "content-type": "application/json",
        "idempotency-key": fixture.request.idempotencyKey,
        "user-agent": USER_AGENT,
      });

      const body = JSON.parse(seen.body) as Record<string, unknown>;
      const expected = expectedBody(name) as Record<string, unknown>;
      if (fixture.request.chatLink === null) {
        // Byte for byte, in the recorded sample's field order.
        expect(seen.body).toBe(JSON.stringify(expected));
      } else {
        // The QR's bytes are drawn at send time (the sample holds a placeholder): every other field byte for byte, and
        // the attachment's content read back as the QR code of the chat link's qrText.
        const attachments = body.attachments as { filename: string; content: string }[];
        expect(attachments.map((item) => item.filename)).toEqual([QR_FILENAME]);
        expect(JSON.stringify({ ...body, attachments: [] })).toBe(
          JSON.stringify({ ...expected, attachments: [] }),
        );
        expectQrOf(decodeBase64(attachments[0]?.content ?? ""), fixture.request.chatLink.qrText);
      }
      expect(body.from).toMatch(/<[a-z0-9._+-]+@mail[.]rosfield[.]com>$/);
    },
  );

  it("sends the recorded sample's headers (send-email-request-headers.json), and the key only as the bearer", async () => {
    const fixture = sendFixture("send-copy-of-text.json");
    const stub = stubFetch(() => recordedResponse());
    const answer = await sender(envFor(fixture.request.to), { fetch: stub.fetch }).sendEmail(fixture.request);
    expect(answer).toEqual(fixture.outcome);
    const headers = stub.seen[0]?.headers ?? {};
    for (const [header, value] of Object.entries(sample("send-email-request-headers.json") as object))
      expect(headers[header.toLowerCase()]).toBe(value);
    expect(Object.values(headers).filter((value) => value.includes(FAKE_KEY))).toEqual([
      `Bearer ${FAKE_KEY}`,
    ]);
    expect(stub.seen[0]?.body).not.toContain(FAKE_KEY);
    expect(JSON.stringify(answer)).not.toContain(FAKE_KEY);
  });

  it("builds the same body every time for one email, the QR's bytes included, so one key always sends one body", async () => {
    const fixture = sendFixture("send-confirmation-with-chat-link.json");
    const stub = stubFetch(() => accepted("email-msg-demo-0021"));
    const send = sender(envFor(fixture.request.to), { fetch: stub.fetch });
    await send.sendEmail(fixture.request);
    await send.sendEmail(structuredClone(fixture.request));
    expect(stub.seen).toHaveLength(2);
    expect(stub.seen[1]?.body).toBe(stub.seen[0]?.body);
    expect(stub.seen[1]?.headers).toEqual(stub.seen[0]?.headers);
  });
});

describe("sendEmail: refused before any request", () => {
  it.each(REFUSED)("refuses %s, sends nothing, and names no value", async (name) => {
    const fixture = sendFixture(name);
    const stub = stubFetch(() => accepted("email-msg-demo-0007"));
    const answer = await sender(envFor(fixture.request.to), { fetch: stub.fetch }).sendEmail(fixture.request);
    expect(answer).toMatchObject({ result: "failed", kind: "refused", code: "validation_error" });
    expect(answer).toMatchObject({ httpStatus: name.includes("from-other-domain") ? 403 : 400 });
    expectSendError(answer);
    expect(stub.seen).toEqual([]);
    for (const value of privateValues(fixture.request)) expect(JSON.stringify(answer)).not.toContain(value);
  });

  it("refuses refuse-marketing-email.json and refuse-no-reply-address.json as the email double does", async () => {
    for (const name of ["invalid/refuse-marketing-email.json", "invalid/refuse-no-reply-address.json"]) {
      const request = sendFixture(name).request;
      const stub = stubFetch(() => accepted("email-msg-demo-0007"));
      const answer = await sender(envFor(request.to), { fetch: stub.fetch }).sendEmail(request);
      expect(answer).toEqual(await createEmailDouble().sendEmail(request));
      expect(stub.seen).toEqual([]);
    }
  });

  it("refuses an address off the allow-list, with no request, naming the list and not the address", async () => {
    const fixture = sendFixture("send-copy-of-text.json");
    const lists: (string | undefined)[] = [
      "sam@lees-barbershop.example",
      "sam@lees-barbershop.example, riley@example.com",
      undefined,
      "",
      "   ",
      "alex@example.com, not-an-address",
      "alex@example.com;riley@example.com",
    ];
    for (const list of lists) {
      const stub = stubFetch(() => accepted("email-msg-demo-0007"));
      const env: ResendSendEnv =
        list === undefined
          ? { RESEND_API_KEY: FAKE_KEY }
          : { RESEND_API_KEY: FAKE_KEY, STAGING_TEST_INBOXES: list };
      const answer = await sender(env, { fetch: stub.fetch }).sendEmail(fixture.request);
      expect(answer).toMatchObject({ result: "failed", kind: "refused", httpStatus: 403, code: null });
      expectSendError(answer);
      expect((answer as SendEmailFailed).reason).toContain(TEST_INBOXES);
      for (const value of privateValues(fixture.request)) expect(JSON.stringify(answer)).not.toContain(value);
      expect(stub.seen).toEqual([]);
    }
  });

  it("refuses with no key (401 missing_api_key) or a key no header can carry, with no request, naming only the key's name", async () => {
    const fixture = sendFixture("send-copy-of-text.json");
    const cases: [ResendSendEnv, number, string][] = [
      [{ STAGING_TEST_INBOXES: fixture.request.to }, 401, "missing_api_key"],
      [{ RESEND_API_KEY: "", STAGING_TEST_INBOXES: fixture.request.to }, 401, "missing_api_key"],
      [{ RESEND_API_KEY: "   ", STAGING_TEST_INBOXES: fixture.request.to }, 401, "missing_api_key"],
      [{ RESEND_API_KEY: 42, STAGING_TEST_INBOXES: fixture.request.to }, 401, "missing_api_key"],
      [{ RESEND_API_KEY: `${FAKE_KEY}\n`, STAGING_TEST_INBOXES: fixture.request.to }, 403, "invalid_api_key"],
      [{ RESEND_API_KEY: `${FAKE_KEY} 2`, STAGING_TEST_INBOXES: fixture.request.to }, 403, "invalid_api_key"],
    ];
    for (const [env, httpStatus, code] of cases) {
      const stub = stubFetch(() => accepted("email-msg-demo-0007"));
      const answer = await sender(env, { fetch: stub.fetch }).sendEmail(fixture.request);
      expect(answer).toMatchObject({ result: "failed", kind: "refused", httpStatus, code });
      expectSendError(answer);
      expect((answer as SendEmailFailed).reason).toContain(RESEND_API_KEY);
      for (const value of privateValues(fixture.request)) expect(JSON.stringify(answer)).not.toContain(value);
      expect(stub.seen).toEqual([]);
    }
  });

  it("refuses a key Resend could not take as its Idempotency-Key, with no request", async () => {
    const request = sendFixture("send-copy-of-text.json").request;
    for (const idempotencyKey of [`${"r".repeat(253)}/1/1`, "out-café-alex-email/1/1"]) {
      const stub = stubFetch(() => accepted("email-msg-demo-0007"));
      const answer = await sender(envFor(request.to), { fetch: stub.fetch }).sendEmail({
        ...request,
        idempotencyKey,
      });
      expect(answer).toMatchObject({
        result: "failed",
        kind: "refused",
        httpStatus: 400,
        code: "invalid_idempotency_key",
      });
      expectSendError(answer);
      expect(stub.seen).toEqual([]);
    }
    const stub = stubFetch(() => accepted("email-msg-demo-0007"));
    const longest = `${"r".repeat(252)}/1/1`;
    expect(longest).toHaveLength(256);
    expect(
      await sender(envFor(request.to), { fetch: stub.fetch }).sendEmail({
        ...request,
        idempotencyKey: longest,
      }),
    ).toMatchObject({ result: "accepted" });
  });
});

describe("sendEmail: the key and the list, read by name at each call", () => {
  it("takes an address on the list, whatever its case, commas, spaces or line breaks", async () => {
    const fixture = sendFixture("send-copy-of-text.json");
    for (const list of [
      "alex@example.com",
      "  Sam@Lees-Barbershop.example,ALEX@example.com ",
      "sam@lees-barbershop.example\nalex@example.com\n",
    ]) {
      const stub = stubFetch(() => accepted("email-msg-demo-0007"));
      const answer = await sender(
        { RESEND_API_KEY: FAKE_KEY, STAGING_TEST_INBOXES: list },
        { fetch: stub.fetch },
      ).sendEmail(fixture.request);
      expect(answer).toMatchObject({ result: "accepted", providerMessageId: "email-msg-demo-0007" });
      expect(stub.seen).toHaveLength(1);
    }
    expect(readTestInboxes(" A@Example.com , b@example.com ")).toEqual({
      ok: true,
      inboxes: new Set(["a@example.com", "b@example.com"]),
    });
    expect(readTestInboxes(42)).toEqual({ ok: false });
  });

  it("reads the key and the list by name at each call", async () => {
    const request = sendFixture("send-copy-of-text.json").request;
    const env: { RESEND_API_KEY?: string; STAGING_TEST_INBOXES?: string } = {};
    const stub = stubFetch(() => accepted("email-msg-demo-0007"));
    const send = sender(env, { fetch: stub.fetch });
    expect(await send.sendEmail(request)).toMatchObject({ kind: "refused", httpStatus: 403 });
    env.STAGING_TEST_INBOXES = request.to;
    expect(await send.sendEmail(request)).toMatchObject({ kind: "refused", httpStatus: 401 });
    env.RESEND_API_KEY = FAKE_KEY;
    expect(await send.sendEmail(request)).toMatchObject({ result: "accepted" });
    delete env.RESEND_API_KEY;
    expect(await send.sendEmail(request)).toMatchObject({ kind: "refused", httpStatus: 401 });
    expect(stub.seen).toHaveLength(1);
  });

  it("reads no name but RESEND_API_KEY and STAGING_TEST_INBOXES from the environment it is given", async () => {
    const request = sendFixture("send-confirmation-with-chat-link.json").request;
    const read: string[] = [];
    // An environment that holds other names too, and records every name read from it.
    const env = new Proxy(
      { ...envFor(request.to), RESEND_WEBHOOK_SECRET: "fake-webhook-secret", OTHER_KEY: "fake-other-key" },
      {
        get(target, name, receiver) {
          read.push(String(name));
          return Reflect.get(target, name, receiver) as unknown;
        },
      },
    );
    const stub = stubFetch(() => accepted("email-msg-demo-0021"));
    expect(await sender(env, { fetch: stub.fetch }).sendEmail(request)).toMatchObject({ result: "accepted" });
    expect([...new Set(read)].sort()).toEqual([RESEND_API_KEY, TEST_INBOXES]);
    expect(stub.seen[0]?.body).not.toContain("fake-webhook-secret");
    expect(stub.seen[0]?.body).not.toContain("fake-other-key");
  });

  it("refuses, when it is made, a time limit that is not a whole number of milliseconds above 0", () => {
    for (const timeoutMs of [0, -1, 1.5, Number.NaN])
      expect(() => createResendSender({ env: {}, timeoutMs })).toThrow(RangeError);
  });
});

describe("sendEmail: the adapter refuses what the email double refuses", () => {
  it("gives the double's answer to every K-12 fixture and every fault the double's test names", async () => {
    const copy = sendFixture("send-copy-of-text.json").request;
    const confirmation = sendFixture("send-confirmation-with-chat-link.json").request;
    const code = sendFixture("send-code.json").request;
    const rfc5 = "<rfc-demo-0005@email.example.com>";
    const requests: unknown[] = [
      ...[...SENDS, ...SEND_FAILURES, ...REFUSED].map((name) => sendFixture(name).request),
      { ...copy, text: copy.text.slice(copy.assistantLine.length + 2) },
      { ...copy, assistantLine: "This is Rosie for Lee's Barbershop." },
      { ...copy, manageLink: "https://example.com/m/zz9" },
      { ...copy, thread: { inReplyTo: rfc5, references: [rfc5, "<rfc-demo-0006@email.example.com>"] } },
      { ...copy, thread: { inReplyTo: rfc5, references: [] } },
      { ...copy, thread: { inReplyTo: "rfc-demo-0005", references: ["rfc-demo-0005"] } },
      { ...copy, chatLink: confirmation.chatLink },
      {
        ...copy,
        bookingId: null,
        replyTo: null,
        manageLink: null,
        thread: { inReplyTo: null, references: [] },
      },
      { ...confirmation, chatLink: null },
      { ...confirmation, chatLink: { ...confirmation.chatLink, qrText: "two words" } },
      { ...confirmation, text: confirmation.text.replace(confirmation.chatLink?.link ?? "", "") },
      { ...confirmation, bookingId: null, replyTo: null, manageLink: null },
      { ...code, replyTo: "booking-alex-haircut@reply.example.com" },
      { ...code, thread: { inReplyTo: rfc5, references: [rfc5] } },
      { ...code, purpose: "copy" },
      { ...copy, to: "Alex@Example.com" },
      { ...copy, from: { name: "Lee's <Barbershop>", address: "rosie@mail.rosfield.com" } },
      { ...copy, from: { name: "Lee's Barbershop", address: "rosie@mail.rosfield.com", extra: 1 } },
      { ...copy, html: "<p>Sure.</p>" },
      { ...copy, idempotencyKey: "out-a7-03-alex-email" },
      { ...copy, manageLink: "http://example.com/m/a03" },
      "an email",
      null,
    ];
    let refused = 0;
    for (const request of requests) {
      expect(sendEmailProblems(request)).toEqual(doubleProblems(request));
      if (doubleProblems(request).length === 0) continue;
      refused += 1;
      const stub = stubFetch(() => accepted("email-msg-demo-0007"));
      const to = typeof request === "object" && request !== null && "to" in request ? String(request.to) : "";
      const answer = await sender(envFor(to), { fetch: stub.fetch }).sendEmail(request);
      expect(answer).toEqual(await createEmailDouble().sendEmail(request));
      expect(stub.seen).toEqual([]);
    }
    expect(refused).toBe(requests.length - SENDS.length - SEND_FAILURES.length);
  });
});

describe("sendEmail: Resend's answers read into K-12's outcomes", () => {
  const fixture = sendFixture("send-copy-of-text.json");
  const cases: [string, () => Response | Promise<Response>, Partial<SendEmailFailed>][] = [
    [
      "401 restricted_api_key",
      () => resendError(401, "restricted_api_key"),
      { kind: "refused", httpStatus: 401, code: "restricted_api_key" },
    ],
    [
      "403 that is not JSON (no User-Agent)",
      () => new Response("error code: 1010", { status: 403 }),
      { kind: "refused", httpStatus: 403, code: null },
    ],
    [
      "403 validation_error (an unverified domain)",
      () => resendError(403, "validation_error"),
      { kind: "refused", httpStatus: 403, code: "validation_error" },
    ],
    [
      "409 invalid_idempotent_request",
      () => resendError(409, "invalid_idempotent_request"),
      {
        kind: "refused",
        httpStatus: 409,
        code: "invalid_idempotent_request",
        reason: "This idempotency key was used with another email.",
      },
    ],
    [
      "409 concurrent_idempotent_requests",
      () => resendError(409, "concurrent_idempotent_requests"),
      { kind: "transient", httpStatus: 409, code: "concurrent_idempotent_requests" },
    ],
    [
      "422 missing_required_field",
      () => resendError(422, "missing_required_field"),
      { kind: "refused", httpStatus: 422, code: "missing_required_field" },
    ],
    [
      "429 monthly_quota_exceeded",
      () => resendError(429, "monthly_quota_exceeded"),
      { kind: "quotaReached", httpStatus: 429, code: "monthly_quota_exceeded", retryAfterSeconds: null },
    ],
    [
      "429 with no name and retry-after 2.5",
      () => resendError(429, null, { "retry-after": "2.5" }),
      { kind: "rateLimited", httpStatus: 429, code: "rate_limit_exceeded", retryAfterSeconds: 3 },
    ],
    [
      "429 rate_limit_exceeded with no retry-after",
      () => resendError(429, "rate_limit_exceeded"),
      { kind: "rateLimited", retryAfterSeconds: null },
    ],
    [
      "429 rate_limit_exceeded with a date for retry-after",
      () => resendError(429, "rate_limit_exceeded", { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }),
      { kind: "rateLimited", retryAfterSeconds: null },
    ],
    [
      "500 application_error",
      () => resendError(500, "application_error"),
      { kind: "transient", httpStatus: 500, code: "application_error" },
    ],
    [
      "503 with a name not in Resend's form",
      () => resendError(503, "Service Unavailable"),
      { kind: "transient", httpStatus: 503, code: null },
    ],
    [
      "200 with no id",
      () => new Response("{}", { status: 200 }),
      { kind: "transient", httpStatus: null, code: null },
    ],
    [
      "200 that is not JSON",
      () => new Response("<html></html>", { status: 200 }),
      { kind: "transient", httpStatus: null },
    ],
    [
      "302, a redirect not followed",
      () => new Response(null, { status: 302, headers: { location: "https://example.com/" } }),
      { kind: "transient", httpStatus: null },
    ],
    [
      "a network error",
      () => Promise.reject(new TypeError(`fetch failed for Bearer ${FAKE_KEY}`)),
      { kind: "transient", httpStatus: null, code: null },
    ],
  ];

  it.each(cases)("reads %s", async (_label, answer, expected) => {
    const stub = stubFetch(answer);
    const outcome = await sender(envFor(fixture.request.to), { fetch: stub.fetch }).sendEmail(
      fixture.request,
    );
    expect(outcome).toMatchObject({ result: "failed", ...expected });
    expectSendError(outcome);
    expect(stub.seen).toHaveLength(1);
    for (const value of privateValues(fixture.request)) expect(JSON.stringify(outcome)).not.toContain(value);
  });

  it("answers transient with no status when no answer comes in time", async () => {
    const stub = stubFetch(
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );
    const outcome = await sender(envFor(fixture.request.to), { fetch: stub.fetch, timeoutMs: 20 }).sendEmail(
      fixture.request,
    );
    expect(outcome).toEqual({
      result: "failed",
      kind: "transient",
      httpStatus: null,
      code: null,
      reason: "No answer came: a timeout or a network error.",
      retryAfterSeconds: null,
    });
  });
});

describe("the From header and the QR code", () => {
  it("writes the name plain unless it holds one of RFC 5322's specials, then in quotes", () => {
    const address = "rosie@mail.rosfield.com";
    const cases: [string, string][] = [
      ["Lee's Barbershop", "Lee's Barbershop <rosie@mail.rosfield.com>"],
      ["Rosie", "Rosie <rosie@mail.rosfield.com>"],
      ["Café Lumière & Co", "Café Lumière & Co <rosie@mail.rosfield.com>"],
      ["Hair, Nails & Spa", '"Hair, Nails & Spa" <rosie@mail.rosfield.com>'],
      ["Dr. Avery's Clinic", '"Dr. Avery\'s Clinic" <rosie@mail.rosfield.com>'],
      ["Studio (Main St)", '"Studio (Main St)" <rosie@mail.rosfield.com>'],
      ["A\\B Salon", '"A\\\\B Salon" <rosie@mail.rosfield.com>'],
      ["  Rosie  ", "Rosie <rosie@mail.rosfield.com>"],
    ];
    for (const [name, header] of cases) expect(fromHeader({ name, address })).toBe(header);
  });

  it("draws any qrText as a one-bit PNG holding exactly its QR code", async () => {
    for (const qrText of ["sms:+15555550188&body=BEN21X", `sms:+15555550188&body=${"x".repeat(300)}`]) {
      const fixture = sendFixture("send-confirmation-with-chat-link.json");
      const request: SendEmailRequest = {
        ...fixture.request,
        chatLink: fixture.request.chatLink === null ? null : { ...fixture.request.chatLink, qrText },
      };
      const stub = stubFetch(() => accepted("email-msg-demo-0021"));
      await sender(envFor(request.to), { fetch: stub.fetch }).sendEmail(request);
      const body = JSON.parse(stub.seen[0]?.body ?? "{}") as { attachments: { content: string }[] };
      expectQrOf(decodeBase64(body.attachments[0]?.content ?? ""), qrText);
    }
  });

  it("refuses, with no request, a confirmation whose QR code cannot be drawn", async () => {
    const fixture = sendFixture("send-confirmation-with-chat-link.json");
    const request: SendEmailRequest = {
      ...fixture.request,
      chatLink:
        fixture.request.chatLink === null ? null : { ...fixture.request.chatLink, qrText: "x".repeat(8000) },
    };
    const stub = stubFetch(() => accepted("email-msg-demo-0021"));
    const answer = await sender(envFor(request.to), { fetch: stub.fetch }).sendEmail(request);
    expect(answer).toMatchObject({ result: "failed", kind: "refused", httpStatus: 400, code: null });
    expectSendError(answer);
    expect(stub.seen).toEqual([]);
  });
});
