// T-414: the Linq send adapter against K-11 v1's send fixtures, its recorded vendor samples
// (contracts/port-linq/vendor-samples) and T-1121's live answers of Nov 17 (adapters/spikes/linq-live/samples). No
// network and no real key: the HTTP call is a stub that records each request and answers with a recorded response, and
// the key is a made-up string built here (rule 7). Every number is the fixtures' fictional 555-01xx; the live samples
// show a number only as its last 2 digits (rule 9).
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { findPrivateValue, redactFreeText } from "../../shared/redact";
import { loadRecordedSample } from "../../shared/samples";
import { createLinqDouble } from "../double/double";
import { sendPartProblems as doubleProblems } from "../double/validate";
import { LINQ_API_TOKEN, createLinqSender, type LinqSendEnv, type LinqSenderOptions } from "./send";
import type { AttachFile, LinqFile, SendPartFailed, SendPartOutcome, SendPartRequest } from "./types";
import { sendPartProblems } from "./validate";
import { LINQ_API_BASE, REASONS, USER_AGENT, failed } from "./wire";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..", "..");
const CONTRACTS = path.join(ROOT, "contracts");
const FIXTURES = path.join(CONTRACTS, "port-linq", "fixtures");
const VENDOR = path.join(CONTRACTS, "port-linq", "vendor-samples");
const LIVE = path.join(ROOT, "adapters", "spikes", "linq-live", "samples");
const K11_ID = "https://rosie.invalid/contracts/port-linq/port-linq.v1.schema.json";

// Made up here, not a key of any service, and not in a key's shape (rule 7).
const FAKE_KEY = "fake-linq-key-t414-0001";
// A second made-up key, of letters alone: no run of digits, no vendor prefix, no email or phone shape, so no
// shared/redact.ts pattern catches it (FAKE_KEY's "414-0001" reads as a phone number there), and only the adapter's own
// screen of the key it sends keeps it out of an outcome.
const LETTERS_KEY = "fakeKeyRoundTwoLettersOnlyZqXwVb";
/** Both fake keys, each with a label for the test's name, so no test name prints a key. */
const BOTH_KEYS: [string, string][] = [
  ["the first fake key", FAKE_KEY],
  ["the letters-only fake key", LETTERS_KEY],
];
const NOW = "2026-10-23T14:05:03Z";
/** The attachment id the recorded calendar send names (vendor-samples/send-message-request-calendar-file.json). */
const CALENDAR_ATTACHMENT = "linq-att-demo-0002";
/** A photo's attachment id, in the sample cast's form. */
const PHOTO_ATTACHMENT = "linq-att-demo-0003";

interface SendExchange {
  call: string;
  given: { now: string; note: string };
  request: SendPartRequest;
  outcome: SendPartOutcome;
}

/** One request as the stub saw it. */
interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  redirect: string;
}

/** One file of a T-1121 live run (adapters/spikes/linq-live/FINDINGS.md 'The samples'). */
interface LiveSample {
  request: { method: string; path: string; body: Record<string, unknown> };
  response: { status: number; headers: Record<string, string>; body: unknown };
}

interface LiveChat {
  id: string;
  service: string;
  health_status: { status: string };
  message: { id: string; created_at: string; service: string | null };
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8")) as unknown;
const sendFixture = (name: string): SendExchange => readJson(path.join(FIXTURES, name)) as SendExchange;
const vendor = (name: string): unknown => loadRecordedSample(VENDOR, name);
const live = (name: string): LiveSample => loadRecordedSample(LIVE, name) as LiveSample;
const liveChat = (sample: LiveSample): LiveChat => (sample.response.body as { chat: LiveChat }).chat;

const ACCEPTED = [
  "send-text.json",
  "send-poll.json",
  "send-link-card.json",
  "send-calendar-file.json",
  "send-photo.json",
  "send-typing.json",
  "send-tapback.json",
  "send-threaded-reply.json",
  "send-override-optout.json",
];
const FAILURES = ["error-403-2024.json", "error-4006.json", "error-rate-limit.json"];
const SENDS = [...ACCEPTED, ...FAILURES];
const REFUSED = [
  "invalid/refuse-poll-six-options.json",
  "invalid/refuse-tapback-on-poll.json",
  "invalid/refuse-bold.json",
  "invalid/refuse-sms-channel.json",
];

const LIVE_SEND = "live-2026-11-17T00-27-34Z-03-send-send.json";
const LIVE_STOPPED = "live-2026-11-17T00-37-18Z-01-stopped-send.json";
const LIVE_OVERRIDE = "live-2026-11-17T00-37-18Z-02-stopped-override-send.json";

let validateExchange: ValidateFunction;
let validateSendErrors: ValidateFunction;
let validateSendResponse: ValidateFunction;

beforeAll(() => {
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  // Every contract's schemas, so the $refs between them resolve (as the Linq double's test loads them).
  for (const folder of readdirSync(CONTRACTS, { withFileTypes: true })) {
    if (!folder.isDirectory() || ["scripts", "generated", "node_modules"].includes(folder.name)) continue;
    for (const file of readdirSync(path.join(CONTRACTS, folder.name)))
      if (file.endsWith(".schema.json"))
        ajv.addSchema(readJson(path.join(CONTRACTS, folder.name, file)) as object);
  }
  const exchange = ajv.getSchema(`${K11_ID}#/$defs/sendPart.exchange`);
  const errors = ajv.getSchema(`${K11_ID}#/$defs/sendPart.errors`);
  const response = ajv.getSchema(`${K11_ID}#/$defs/sendPart.response`);
  if (exchange === undefined || errors === undefined || response === undefined)
    throw new Error("a contract schema is missing");
  validateExchange = exchange;
  validateSendErrors = errors;
  validateSendResponse = response;
});

function expectSendError(outcome: unknown): void {
  expect(validateSendErrors(outcome), JSON.stringify(validateSendErrors.errors)).toBe(true);
}

function expectSendResponse(outcome: unknown): void {
  expect(validateSendResponse(outcome), JSON.stringify(validateSendResponse.errors)).toBe(true);
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

/** A stub of the step that puts a file up: records each file and answers the given attachment id. */
function attachStub(attachmentId: string): { attachFile: AttachFile; files: LinqFile[] } {
  const files: LinqFile[] = [];
  return {
    files,
    attachFile: (file) => {
      files.push(file);
      return Promise.resolve({ result: "attached", attachmentId });
    },
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Linq's error answer in its documented form (K-11 README spike row 14), with words made up for a test. */
function linqError(
  status: number,
  code: number | string | null,
  options: { message?: string; retryAfter?: unknown; headers?: Record<string, string> } = {},
): Response {
  const error: Record<string, unknown> = {
    status,
    code,
    message: options.message ?? "Made up for a test.",
    doc_url: "https://docs.linqapp.com/error/",
  };
  if (options.retryAfter !== undefined) error.retry_after = options.retryAfter;
  return json(status, { success: false, error, trace_id: "linq-trace-demo-0099" }, options.headers);
}

/** A recorded vendor error body, answered with the status it names. */
function vendorError(name: string): Response {
  const body = vendor(name) as { error: { status: number } };
  return json(body.error.status, body);
}

/** Linq's answer to a message send, in the recorded send-message-response.json's shape, with this id and time. */
function messageAnswer(chatId: string, id: string, createdAt: string): Response {
  const answer = structuredClone(vendor("send-message-response.json")) as {
    chat_id: string;
    message: Record<string, unknown>;
  };
  answer.chat_id = chatId;
  answer.message.id = id;
  answer.message.created_at = createdAt;
  return json(202, answer);
}

/** Linq's answer to a poll, in the recorded create-poll-response.json's shape, with these options in order. */
function pollAnswer(options: readonly string[]): Response {
  const answer = structuredClone(vendor("create-poll-response.json")) as { poll: { options: unknown[] } };
  answer.poll.options = options.map((text, index) => ({
    option_id: `linq-opt-demo-${String(index + 1)}`,
    text,
    can_be_edited: false,
    voters: [],
  }));
  return json(202, answer);
}

/** An answer that accepts any part: the recorded shape for its call. */
function acceptAny(request: SendPartRequest): () => Response {
  switch (request.kind) {
    case "poll":
      return () => pollAnswer(request.options);
    case "tapback":
      return () => json(202, vendor("reaction-response.json"));
    case "typing":
      return () => new Response(null, { status: 204 });
    default:
      return () => messageAnswer(request.chatId, "linq-msg-demo-0099", NOW);
  }
}

/** The recorded answer each fixture's request is answered with (README 'Recorded vendor samples'; rows 9 to 12). */
function recordedAnswer(name: string, fixture: SendExchange): Response {
  const outcome = fixture.outcome;
  switch (name) {
    case "send-text.json":
      return json(202, vendor("send-message-response.json"));
    case "send-poll.json":
      return json(202, vendor("create-poll-response.json"));
    case "send-tapback.json":
      return json(202, vendor("reaction-response.json"));
    case "send-typing.json":
      return new Response(null, { status: 204 });
    case "error-403-2024.json":
      return vendorError("error-2024.json");
    case "error-4006.json":
      return vendorError("error-4006.json");
    case "error-rate-limit.json":
      return vendorError("error-1007-rate-limit.json");
    default:
      if (outcome.result !== "accepted" || outcome.providerMessageId === null)
        throw new Error(`${name} is not a message send Linq accepted`);
      return messageAnswer(outcome.chatId, outcome.providerMessageId, outcome.acceptedAt);
  }
}

/** The words of a message send, by K-11 README spike row 10's body, for a fixture with no recorded request. */
function wordsBody(request: SendPartRequest): Record<string, unknown> {
  return {
    message: { parts: [{ type: "text", value: request.text }], idempotency_key: request.idempotencyKey },
  };
}

/**
 * A recorded request as this adapter writes it: the sample's explicit override_optout false is left out, since the
 * adapter never sends the field but on a marked send (the recorded calendar and link sends carry no such field either).
 */
function withoutFalseOverride(sample: unknown): Record<string, unknown> {
  const { override_optout: override, ...rest } = sample as Record<string, unknown>;
  expect(override).toBe(false);
  return rest;
}

interface ExpectedCall {
  method: string;
  path: string;
  body: unknown;
}

/** The request each fixture must build: its recorded vendor request where K-11 has one (README's samples table). */
function expectedCall(name: string, request: SendPartRequest): ExpectedCall {
  const chat = `/chats/${request.chatId}`;
  switch (name) {
    case "send-poll.json":
      return { method: "POST", path: `${chat}/polls`, body: vendor("create-poll-request.json") };
    case "send-link-card.json":
      return { method: "POST", path: `${chat}/messages`, body: vendor("send-message-request-link.json") };
    case "send-calendar-file.json":
      return {
        method: "POST",
        path: `${chat}/messages`,
        body: vendor("send-message-request-calendar-file.json"),
      };
    case "send-threaded-reply.json":
      return {
        method: "POST",
        path: `${chat}/messages`,
        body: withoutFalseOverride(vendor("send-message-request.json")),
      };
    case "send-tapback.json":
      return {
        method: "POST",
        path: `/messages/${request.tapback?.onMessageId ?? ""}/reactions`,
        body: vendor("reaction-request.json"),
      };
    case "send-typing.json":
      return { method: "POST", path: `${chat}/typing`, body: null };
    case "send-photo.json":
      return {
        method: "POST",
        path: `${chat}/messages`,
        body: {
          message: {
            parts: [{ type: "media", attachment_id: PHOTO_ATTACHMENT }],
            idempotency_key: request.idempotencyKey,
          },
        },
      };
    case "send-override-optout.json":
      return {
        method: "POST",
        path: `${chat}/messages`,
        body: { ...wordsBody(request), override_optout: true },
      };
    default:
      // send-text.json and the three failures: words alone (send-message-response.json is send-text.json's answer).
      return { method: "POST", path: `${chat}/messages`, body: wordsBody(request) };
  }
}

function sender(rest: Partial<LinqSenderOptions> = {}) {
  return createLinqSender({ env: { LINQ_API_TOKEN: FAKE_KEY }, now: () => NOW, ...rest });
}

/** One fixture through the adapter, answered with its recorded answer, at the fixture's own time. */
async function runFixture(name: string) {
  const fixture = sendFixture(name);
  const stub = stubFetch(() => recordedAnswer(name, fixture));
  const attach = attachStub(name === "send-photo.json" ? PHOTO_ATTACHMENT : CALENDAR_ATTACHMENT);
  const outcome = await sender({
    fetch: stub.fetch,
    now: () => fixture.given.now,
    attachFile: attach.attachFile,
  }).sendPart(fixture.request);
  return { fixture, stub, attach, outcome };
}

/** The request's own words, link and number, which no outcome may hold, and the key. */
function privateValues(request: SendPartRequest): string[] {
  return [
    request.text,
    request.link,
    request.to,
    request.calendarFile?.ics,
    ...request.options,
    FAKE_KEY,
  ].filter((value): value is string => typeof value === "string" && value !== "");
}

/** A request's JSON body, or {} for one with none (typing dots). */
function bodyOf(seen: Seen | undefined): Record<string, unknown> {
  const text = seen?.body ?? "";
  return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
}

/** Every byte of `value` as a %XX escape: a URL encoding of it whatever its characters, so it differs from the raw value. */
function percentEncoded(value: string): string {
  return [...new TextEncoder().encode(value)]
    .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
    .join("");
}

/**
 * Words that echo the key, as an error.message or a file step's reason might: raw, URL-encoded (every byte, in either
 * case of hex, and twice over), inside a longer token, in capitals, cut short, and masked down to its first or last 4.
 */
function keyEchoes(key: string): [string, string][] {
  const encoded = percentEncoded(key);
  return [
    ["raw", `Bad token ${key}`],
    ["URL-encoded", `Bad token ${encoded}`],
    ["URL-encoded in lower-case hex", `Bad token ${encoded.toLowerCase()}`],
    ["URL-encoded twice", `Bad token ${encoded.replace(/%/g, "%25")}`],
    ["inside a longer token", `Bad request: token=${key}&retry=no`],
    ["glued to other letters", `Bad token x${key}x`],
    ["in capitals", `Bad token ${key.toUpperCase()}`],
    ["cut short", `Bad token ${key.slice(0, 8)}...`],
    ["masked down to its first 4", `Bad token ${key.slice(0, 4)}****`],
    ["masked down to its last 4", `Bad token ****${key.slice(-4)}`],
  ];
}

describe("the K-11 v1 send fixtures", () => {
  it("tests every sendPart fixture K-11 v1's index lists", () => {
    const index = readJson(path.join(FIXTURES, "index.json")) as {
      fixtures: { file: string; def: string }[];
    };
    const sends = index.fixtures
      .filter((entry) => entry.def === "sendPart.exchange")
      .map((entry) => entry.file);
    expect([...SENDS, ...REFUSED].sort()).toEqual(sends.sort());
  });
});

describe("sendPart: each send fixture builds the recorded vendor request", () => {
  it.each(SENDS)(
    "%s: the recorded request under its K-07 key, and Linq's recorded answer read into the fixture's outcome",
    async (name) => {
      const { fixture, stub, outcome } = await runFixture(name);
      expect(outcome).toEqual(fixture.outcome);
      expect(validateExchange({ ...fixture, outcome }), JSON.stringify(validateExchange.errors)).toBe(true);

      expect(stub.seen).toHaveLength(1);
      const [seen] = stub.seen;
      if (seen === undefined) throw new Error("no request was sent");
      const expected = expectedCall(name, fixture.request);
      expect(seen.method).toBe(expected.method);
      expect(seen.url).toBe(`${LINQ_API_BASE}${expected.path}`);
      expect(seen.redirect).toBe("manual");
      expect(seen.headers).toEqual({
        authorization: `Bearer ${FAKE_KEY}`,
        "user-agent": USER_AGENT,
        ...(expected.body === null ? {} : { "content-type": "application/json" }),
      });
      // Byte for byte, in the recorded sample's field order.
      expect(seen.body).toBe(expected.body === null ? "" : JSON.stringify(expected.body));
    },
  );

  it("carries each keyed part's K-07 key as Linq's idempotency_key, verbatim", async () => {
    for (const name of SENDS) {
      const { fixture, stub } = await runFixture(name);
      const body = bodyOf(stub.seen[0]);
      const sent =
        fixture.request.kind === "poll"
          ? (body.poll as { idempotency_key?: unknown }).idempotency_key
          : (body.message as { idempotency_key?: unknown } | undefined)?.idempotency_key;
      if (fixture.request.kind === "tapback" || fixture.request.kind === "typing") {
        // Linq's reaction and typing calls take no key (K-11 README spike rows 11 and 12).
        expect(stub.seen[0]?.body.includes("idempotency_key"), name).toBe(false);
      } else {
        expect(sent, name).toBe(fixture.request.idempotencyKey);
      }
    }
  });

  it("puts the calendar file up first, as the recorded upload names it, and sends the id it answers", async () => {
    const { fixture, attach, stub } = await runFixture("send-calendar-file.json");
    const upload = vendor("attachment-upload-request.json") as { filename: string; content_type: string };
    expect(attach.files).toHaveLength(1);
    const [file] = attach.files;
    if (file?.kind !== "calendarFile") throw new Error("no calendar file went up");
    expect(file.fileName).toBe(upload.filename);
    expect(file.mediaType).toBe(upload.content_type);
    expect(new TextDecoder().decode(file.bytes)).toBe(fixture.request.calendarFile?.ics);
    expect(stub.seen[0]?.body).toContain(`"attachment_id":"${CALENDAR_ATTACHMENT}"`);
  });

  it("puts the photo up by its K-13 file id and image type, and sends it as the media part alone", async () => {
    const { fixture, attach } = await runFixture("send-photo.json");
    expect(attach.files).toEqual([
      { kind: "photo", fileId: fixture.request.photo?.fileId, mediaType: fixture.request.photo?.mediaType },
    ]);
  });

  it("puts nothing up for a part with no file", async () => {
    for (const name of SENDS.filter(
      (file) => !["send-calendar-file.json", "send-photo.json"].includes(file),
    )) {
      const { attach } = await runFixture(name);
      expect(attach.files, name).toEqual([]);
    }
  });

  it("builds the same request every time for one part, so Linq dedupes a repeat by its key", async () => {
    for (const name of SENDS) {
      const fixture = sendFixture(name);
      const stub = stubFetch(acceptAny(fixture.request));
      const send = sender({ fetch: stub.fetch, attachFile: attachStub(CALENDAR_ATTACHMENT).attachFile });
      await send.sendPart(fixture.request);
      await send.sendPart(structuredClone(fixture.request));
      expect(stub.seen, name).toHaveLength(2);
      expect(stub.seen[1], name).toEqual(stub.seen[0]);
    }
  });
});

describe("sendPart: T-1121's live answers of Nov 17, replayed", () => {
  const liveAnswer = (sample: LiveSample): Response =>
    json(sample.response.status, sample.response.body, sample.response.headers);

  it("reads the live send's 201 in its real shape, the message inside the chat, its service the chat's", async () => {
    const sample = live(LIVE_SEND);
    const chat = liveChat(sample);
    const request = sendFixture("send-text.json").request;
    const stub = stubFetch(() => liveAnswer(sample));
    const outcome = await sender({ fetch: stub.fetch }).sendPart(request);
    // At that moment the message's own service is null and the chat's is iMessage (FINDINGS vendor fact 4).
    expect(chat.message.service).toBeNull();
    expect(chat.service).toBe("iMessage");
    expect(outcome).toEqual({
      result: "accepted",
      providerMessageId: chat.message.id,
      providerOptionIds: null,
      chatId: request.chatId,
      service: "imessage",
      acceptedAt: chat.message.created_at,
    });
    expectSendResponse(outcome);
  });

  it("sends the words as the live send did, into the chat by its id and with no number on the wire", async () => {
    const sample = live(LIVE_SEND);
    const request = sendFixture("send-text.json").request;
    const stub = stubFetch(() => liveAnswer(sample));
    await sender({ fetch: stub.fetch }).sendPart(request);
    const [seen] = stub.seen;
    const body = bodyOf(seen);
    const liveMessage = sample.request.body.message as { parts: Record<string, unknown>[] };
    const message = body.message as { parts: Record<string, unknown>[] };
    // The live run sent by number (POST /v3/chats, with from and to); the product's path names the chat in its URL and
    // carries the same message: its parts' form and its idempotency key (K-11 README page S; arch 07 line 369).
    expect(sample.request.path).toBe("/api/partner/v3/chats");
    expect(seen?.url).toBe(`${LINQ_API_BASE}/chats/${request.chatId}/messages`);
    expect(Object.keys(message)).toEqual(Object.keys(liveMessage));
    expect(message.parts.map((part) => Object.keys(part))).toEqual(
      liveMessage.parts.map((part) => Object.keys(part)),
    );
    expect(message.parts[0]?.type).toBe(liveMessage.parts[0]?.type);
    // The live send wrote override_optout false; this adapter never sends the field on an unmarked part.
    expect(sample.request.body.override_optout).toBe(false);
    expect(Object.keys(body)).toEqual(["message"]);
    expect(`${seen?.url ?? ""} ${seen?.body ?? ""}`).not.toContain(request.to);
  });

  it("reads the live send after STOP, 403 with code 2024, as error-403-2024.json's optedOut", async () => {
    const fixture = sendFixture("error-403-2024.json");
    const stub = stubFetch(() => liveAnswer(live(LIVE_STOPPED)));
    expect(await sender({ fetch: stub.fetch }).sendPart(fixture.request)).toEqual(fixture.outcome);
  });

  it("lets the marked send after STOP through as the live run answered it: 201, accepted (against K-11 spike row 15)", async () => {
    const sample = live(LIVE_OVERRIDE);
    const chat = liveChat(sample);
    const request = sendFixture("send-override-optout.json").request;
    const stub = stubFetch(() => liveAnswer(sample));
    const outcome = await sender({ fetch: stub.fetch }).sendPart(request);
    // The chat still reads opted out (FINDINGS vendor fact 6), and the one send went through.
    expect(chat.health_status.status).toBe("OPTED_OUT");
    expect(outcome).toEqual({
      result: "accepted",
      providerMessageId: chat.message.id,
      providerOptionIds: null,
      chatId: request.chatId,
      service: "imessage",
      acceptedAt: chat.message.created_at,
    });
    expectSendResponse(outcome);
    // The request carries the field as the live one did: override_optout true at the top, beside the message.
    const body = bodyOf(stub.seen[0]);
    expect(sample.request.body.override_optout).toBe(true);
    expect(body.override_optout).toBe(true);
    expect(Object.keys(body)).toEqual(
      Object.keys(sample.request.body).filter((name) => name !== "from" && name !== "to"),
    );
    expect(Object.keys(body.message as object)).toEqual(Object.keys(sample.request.body.message as object));
  });

  it("still reads a 403 with code 2024 on a marked send as optedOut, whichever way Linq answers", async () => {
    const fixture = sendFixture("send-override-optout.json");
    const stub = stubFetch(() => liveAnswer(live(LIVE_STOPPED)));
    const outcome = await sender({ fetch: stub.fetch }).sendPart(fixture.request);
    expect(outcome).toEqual({
      result: "failed",
      kind: "optedOut",
      httpStatus: 403,
      code: "2024",
      reason: "Recipient asked you to stop messaging them",
      retryAfterSeconds: null,
      providerMessageId: null,
    });
    expect(validateExchange({ ...fixture, outcome }), JSON.stringify(validateExchange.errors)).toBe(true);
  });
});

/** Every part kind, unmarked, from the fixtures and K-11's other allowed forms (words on RCS or SMS, typing stop). */
function unmarkedParts(): [string, SendPartRequest][] {
  const parts: [string, SendPartRequest][] = SENDS.map((name) => [name, sendFixture(name).request]);
  const text = sendFixture("send-text.json").request;
  const typing = sendFixture("send-typing.json").request;
  const link = sendFixture("send-link-card.json").request;
  const calendar = sendFixture("send-calendar-file.json").request;
  const thread = sendFixture("send-threaded-reply.json").request;
  parts.push(
    ["words on RCS", { ...text, service: "rcs" }],
    ["words on SMS", { ...text, service: "sms" }],
    ["a link card on RCS", { ...link, service: "rcs" }],
    ["typing stop", { ...typing, typing: "stop" }],
    ["words with a calendar file and a thread", { ...calendar, threadedReplyTo: thread.threadedReplyTo }],
  );
  return parts.map(([label, request]) => [label, { ...request, overrideOptout: false }]);
}

describe("override_optout: only on a send the caller marks as allowed after an exact STOP", () => {
  it("fails if any other send sets it: no request of an unmarked part holds override_optout", async () => {
    for (const [label, request] of unmarkedParts()) {
      const stub = stubFetch(acceptAny(request));
      const outcome = await sender({
        fetch: stub.fetch,
        attachFile: attachStub(CALENDAR_ATTACHMENT).attachFile,
      }).sendPart(request);
      expect(outcome.result, label).toBe("accepted");
      expect(stub.seen, label).toHaveLength(1);
      for (const seen of stub.seen) {
        expect(seen.body.includes("override_optout"), label).toBe(false);
        expect(seen.url.includes("override_optout"), label).toBe(false);
        expect(JSON.stringify(seen.headers).includes("override_optout"), label).toBe(false);
      }
    }
  });

  it("sends override_optout true, once, at the top of a marked message send: words, a calendar file, a link card, a photo", async () => {
    const markable = unmarkedParts().filter(([, request]) =>
      ["words", "linkCard", "photo"].includes(request.kind),
    );
    expect(markable.map(([, request]) => request.kind)).toEqual(
      expect.arrayContaining(["words", "linkCard", "photo"]),
    );
    for (const [label, unmarked] of markable) {
      const request: SendPartRequest = { ...unmarked, overrideOptout: true };
      const stub = stubFetch(acceptAny(request));
      const outcome = await sender({
        fetch: stub.fetch,
        attachFile: attachStub(CALENDAR_ATTACHMENT).attachFile,
      }).sendPart(request);
      expect(outcome.result, label).toBe("accepted");
      const [seen] = stub.seen;
      const body = bodyOf(seen);
      expect(body.override_optout, label).toBe(true);
      expect(Object.keys(body), label).toEqual(["message", "override_optout"]);
      expect(seen?.body.split("override_optout").length, label).toBe(2);
      expect(seen?.url.includes("override_optout"), label).toBe(false);
    }
  });

  it("refuses a marked poll or tapback before any request: Linq's poll and reaction calls take no override_optout", async () => {
    for (const name of ["send-poll.json", "send-tapback.json"]) {
      const request: SendPartRequest = { ...sendFixture(name).request, overrideOptout: true };
      const stub = stubFetch(acceptAny(request));
      const outcome = await sender({ fetch: stub.fetch }).sendPart(request);
      expect(outcome, name).toMatchObject({
        result: "failed",
        kind: "refused",
        httpStatus: null,
        code: null,
      });
      expectSendError(outcome);
      expect((outcome as SendPartFailed).reason, name).toContain("override_optout");
      expect(stub.seen, name).toEqual([]);
    }
  });

  it("refuses typing dots marked to pass an opt-out (K-11: never past an opt-out), with the double's answer", async () => {
    const request: SendPartRequest = { ...sendFixture("send-typing.json").request, overrideOptout: true };
    const stub = stubFetch(acceptAny(request));
    const outcome = await sender({ fetch: stub.fetch }).sendPart(request);
    expect(outcome).toEqual(createLinqDouble({ now: () => NOW }).sendPart(request));
    expect(outcome).toMatchObject({ kind: "refused", httpStatus: 400, code: "1004" });
    expect(stub.seen).toEqual([]);
  });
});

describe("refused before any request is built: bold, read receipts and an SMS channel", () => {
  it.each(REFUSED)("refuses %s with the double's answer, and sends and puts up nothing", async (name) => {
    const request = sendFixture(name).request;
    const stub = stubFetch(acceptAny(request));
    const attach = attachStub(CALENDAR_ATTACHMENT);
    const outcome = await sender({ fetch: stub.fetch, attachFile: attach.attachFile }).sendPart(request);
    expect(outcome).toEqual(createLinqDouble({ now: () => NOW }).sendPart(request));
    expect(outcome).toMatchObject({ result: "failed", kind: "refused", httpStatus: 400, code: "1004" });
    expectSendError(outcome);
    expect(stub.seen).toEqual([]);
    expect(attach.files).toEqual([]);
  });

  it("refuses bold text decorations, a read receipt and a chosen SMS channel in any spelling, before any request", async () => {
    const text = sendFixture("send-text.json").request;
    const calendar = sendFixture("send-calendar-file.json").request;
    const thread = sendFixture("send-threaded-reply.json").request;
    const others = [
      "send-poll.json",
      "send-link-card.json",
      "send-photo.json",
      "send-typing.json",
      "send-tapback.json",
    ];
    const requests: [string, unknown][] = [
      ["bold, as K-11's fixture writes it", sendFixture("invalid/refuse-bold.json").request],
      ["bold, in Linq's own field name", { ...text, text_decorations: [{ style: "bold", range: [0, 4] }] }],
      ["a bold flag", { ...text, bold: true }],
      ["a read receipt as a kind", { ...text, kind: "readReceipt", text: null }],
      ["marking the chat read as a kind", { ...text, kind: "markRead", text: null }],
      ["a read receipt beside the words", { ...text, readReceipt: true }],
      ["SMS chosen, as K-11's fixture writes it", sendFixture("invalid/refuse-sms-channel.json").request],
      ["SMS chosen, in Linq's own field name", { ...text, preferred_service: "SMS" }],
      ["a calendar file on SMS", { ...calendar, service: "sms" }],
      ["a threaded reply on SMS", { ...thread, service: "sms" }],
      ...others.map((name): [string, unknown] => [
        `${name} on SMS`,
        { ...sendFixture(name).request, service: "sms" },
      ]),
    ];
    for (const [label, request] of requests) {
      const stub = stubFetch(() => messageAnswer("linq-chat-demo-alex", "linq-msg-demo-0099", NOW));
      const attach = attachStub(CALENDAR_ATTACHMENT);
      const outcome = await sender({ fetch: stub.fetch, attachFile: attach.attachFile }).sendPart(request);
      expect(outcome, label).toMatchObject({
        result: "failed",
        kind: "refused",
        httpStatus: 400,
        code: "1004",
      });
      expectSendError(outcome);
      expect(stub.seen, label).toEqual([]);
      expect(attach.files, label).toEqual([]);
    }
  });

  it("sends words into a chat Linq reports as SMS, and no request ever names a service, bold or a read receipt", async () => {
    for (const [label, request] of unmarkedParts()) {
      const stub = stubFetch(acceptAny(request));
      const outcome = await sender({
        fetch: stub.fetch,
        attachFile: attachStub(CALENDAR_ATTACHMENT).attachFile,
      }).sendPart(request);
      expect(outcome.result, label).toBe("accepted");
      for (const seen of stub.seen) {
        for (const name of ["preferred_service", "text_decorations", "service", "bold", "read"])
          expect(seen.body.includes(`"${name}"`), `${label}: ${name}`).toBe(false);
        expect(new URL(seen.url).pathname, label).toMatch(
          /^\/api\/partner\/v3\/(?:chats\/[^/]+\/(?:messages|polls|typing)|messages\/[^/]+\/reactions)$/,
        );
      }
    }
  });

  it("gives every request the double's problems, and every request the double refuses the double's answer", async () => {
    const text = sendFixture("send-text.json").request;
    const poll = sendFixture("send-poll.json").request;
    const link = sendFixture("send-link-card.json").request;
    const calendar = sendFixture("send-calendar-file.json").request;
    const photo = sendFixture("send-photo.json").request;
    const typing = sendFixture("send-typing.json").request;
    const tapback = sendFixture("send-tapback.json").request;
    const withoutOverride: Record<string, unknown> = { ...text };
    delete withoutOverride.overrideOptout;
    const faults: unknown[] = [
      { ...poll, service: "rcs" },
      { ...text, service: "sms", threadedReplyTo: { messageId: "linq-msg-demo-0001" } },
      { ...text, idempotencyKey: null },
      { ...text, idempotencyKey: "out-a7-03-alex" },
      { ...text, idempotencyKey: "out-a7-03-alex/3/1" },
      { ...text, to: "5555550101" },
      { ...text, text: "   " },
      { ...text, text: null },
      { ...text, options: ["Sat 12:00pm"] },
      { ...text, link: "https://rosie.example.com/b/x" },
      { ...text, overrideOptout: "yes" },
      { ...text, chatId: "" },
      { ...text, kind: "edit" },
      { ...text, service: "email" },
      withoutOverride,
      { ...poll, options: ["Sat 12:00pm"] },
      { ...poll, options: ["Sat 12:00pm", " "] },
      { ...link, service: "sms" },
      { ...link, link: "http://rosie.example.com/b/booking-alex-haircut" },
      { ...link, text: "See your booking" },
      { ...calendar, service: "rcs" },
      { ...calendar, calendarFile: { ...calendar.calendarFile, fileName: "visit.txt" } },
      { ...calendar, calendarFile: { ...calendar.calendarFile, ics: "SUMMARY:Haircut" } },
      { ...calendar, calendarFile: { ...calendar.calendarFile, action: "none" } },
      { ...photo, service: "rcs" },
      { ...photo, photo: { fileId: "file-demo-lees-price-list", mediaType: "application/pdf" } },
      { ...typing, idempotencyKey: "out-a7-03-alex/1/1" },
      { ...typing, typing: null },
      { ...tapback, tapback: { reaction: "love", onMessageId: "linq-msg-demo-in-alex-0012", onPoll: false } },
      { ...tapback, tapback: null },
      "words",
      null,
      [],
    ];
    const requests: unknown[] = [
      ...[...SENDS, ...REFUSED].map((name) => sendFixture(name).request),
      ...faults,
    ];
    let refused = 0;
    for (const request of requests) {
      expect(sendPartProblems(request)).toEqual(doubleProblems(request));
      if (doubleProblems(request).length === 0) continue;
      refused += 1;
      const stub = stubFetch(() => messageAnswer("linq-chat-demo-alex", "linq-msg-demo-0099", NOW));
      expect(await sender({ fetch: stub.fetch }).sendPart(request)).toEqual(
        createLinqDouble({ now: () => NOW }).sendPart(request),
      );
      expect(stub.seen).toEqual([]);
    }
    expect(refused).toBe(REFUSED.length + faults.length);
  });
});

describe("the key: read only from the Worker environment by name, sent only as the bearer, never logged", () => {
  it("reads no name but LINQ_API_TOKEN from the environment it is given", async () => {
    for (const name of SENDS) {
      const fixture = sendFixture(name);
      const read: string[] = [];
      // An environment that holds other names too, and records every name read from it.
      const env = new Proxy(
        { LINQ_API_TOKEN: FAKE_KEY, LINQ_WEBHOOK_SECRET: "fake-webhook-secret", OTHER_KEY: "fake-other-key" },
        {
          get(target, property, receiver) {
            read.push(String(property));
            return Reflect.get(target, property, receiver) as unknown;
          },
        },
      );
      const stub = stubFetch(() => recordedAnswer(name, fixture));
      await sender({
        env,
        fetch: stub.fetch,
        attachFile: attachStub(CALENDAR_ATTACHMENT).attachFile,
      }).sendPart(fixture.request);
      expect([...new Set(read)], name).toEqual([LINQ_API_TOKEN]);
      expect(JSON.stringify(stub.seen), name).not.toContain("fake-webhook-secret");
      expect(JSON.stringify(stub.seen), name).not.toContain("fake-other-key");
    }
  });

  it("reads the key by name at each call", async () => {
    const request = sendFixture("send-text.json").request;
    const env: { LINQ_API_TOKEN?: string } = {};
    const stub = stubFetch(acceptAny(request));
    const send = sender({ env, fetch: stub.fetch });
    expect(await send.sendPart(request)).toMatchObject({ result: "failed", kind: "refused" });
    env.LINQ_API_TOKEN = FAKE_KEY;
    expect(await send.sendPart(request)).toMatchObject({ result: "accepted" });
    env.LINQ_API_TOKEN = "fake-linq-key-t414-0002";
    expect(await send.sendPart(request)).toMatchObject({ result: "accepted" });
    delete env.LINQ_API_TOKEN;
    expect(await send.sendPart(request)).toMatchObject({ result: "failed", kind: "refused" });
    expect(stub.seen.map((seen) => seen.headers.authorization)).toEqual([
      `Bearer ${FAKE_KEY}`,
      "Bearer fake-linq-key-t414-0002",
    ]);
  });

  it("sends the key only in the Authorization header, as its bearer, in every request, and never in an outcome", async () => {
    for (const name of SENDS) {
      const { stub, outcome } = await runFixture(name);
      for (const seen of stub.seen) {
        expect(
          Object.entries(seen.headers).filter(([, value]) => value.includes(FAKE_KEY)),
          name,
        ).toEqual([["authorization", `Bearer ${FAKE_KEY}`]]);
        expect(seen.url.startsWith(`${LINQ_API_BASE}/`), name).toBe(true);
        expect(seen.url, name).not.toContain(FAKE_KEY);
        expect(seen.body, name).not.toContain(FAKE_KEY);
      }
      expect(JSON.stringify(outcome), name).not.toContain(FAKE_KEY);
    }
  });

  it("refuses with no key, or one no header can carry, before any request, naming only the key's name", async () => {
    const request = sendFixture("send-calendar-file.json").request;
    const envs: LinqSendEnv[] = [
      {},
      { LINQ_API_TOKEN: "" },
      { LINQ_API_TOKEN: "   " },
      { LINQ_API_TOKEN: 42 },
      { LINQ_API_TOKEN: null },
      { LINQ_API_TOKEN: `${FAKE_KEY}\n` },
      { LINQ_API_TOKEN: `${FAKE_KEY} 2` },
      { LINQ_API_TOKEN: "fake-linq-kéy" },
    ];
    for (const env of envs) {
      const stub = stubFetch(acceptAny(request));
      const attach = attachStub(CALENDAR_ATTACHMENT);
      const outcome = await sender({ env, fetch: stub.fetch, attachFile: attach.attachFile }).sendPart(
        request,
      );
      expect(outcome).toMatchObject({ result: "failed", kind: "refused", httpStatus: null, code: null });
      expectSendError(outcome);
      expect((outcome as SendPartFailed).reason).toContain(LINQ_API_TOKEN);
      expect(JSON.stringify(outcome)).not.toContain(FAKE_KEY);
      expect(stub.seen).toEqual([]);
      expect(attach.files).toEqual([]);
    }
  });

  it("writes nothing to a log line, the key least of all, whatever Linq answers or however the call fails", async () => {
    const lines: string[] = [];
    const record = (...args: unknown[]): void => {
      lines.push(args.map((arg) => (typeof arg === "string" ? arg : inspect(arg))).join(" "));
    };
    const spies = [
      vi.spyOn(console, "log").mockImplementation(record),
      vi.spyOn(console, "info").mockImplementation(record),
      vi.spyOn(console, "warn").mockImplementation(record),
      vi.spyOn(console, "error").mockImplementation(record),
      vi.spyOn(console, "debug").mockImplementation(record),
      vi.spyOn(console, "trace").mockImplementation(record),
    ];
    const outcomes: SendPartOutcome[] = [];
    try {
      for (const name of SENDS) outcomes.push((await runFixture(name)).outcome);
      const text = sendFixture("send-text.json").request;
      const calendar = sendFixture("send-calendar-file.json").request;
      const answers: (() => Response | Promise<Response>)[] = [
        () => linqError(401, null, { message: `Bad token ${FAKE_KEY}` }),
        () => linqError(429, 1007, { retryAfter: 65, headers: { "retry-after": "30" } }),
        () => linqError(500, 4001),
        () => new Response("<html>gateway</html>", { status: 502 }),
        () =>
          new Response(null, { status: 302, headers: { location: `https://example.com/?k=${FAKE_KEY}` } }),
        () => Promise.reject(new TypeError(`fetch failed for Bearer ${FAKE_KEY}`)),
      ];
      for (const answer of answers)
        outcomes.push(await sender({ fetch: stubFetch(answer).fetch }).sendPart(text));
      const hung = stubFetch(
        (request) =>
          new Promise<Response>((_resolve, reject) => {
            request.signal.addEventListener("abort", () => {
              reject(new Error(`aborted with Bearer ${FAKE_KEY}`));
            });
          }),
      );
      outcomes.push(await sender({ fetch: hung.fetch, timeoutMs: 20 }).sendPart(text));
      const throwing: AttachFile = () => Promise.reject(new Error(`upload failed for Bearer ${FAKE_KEY}`));
      outcomes.push(
        await sender({ fetch: stubFetch(acceptAny(calendar)).fetch, attachFile: throwing }).sendPart(
          calendar,
        ),
      );
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(outcomes.length).toBe(SENDS.length + 8);
    expect(lines.filter((line) => line.includes(FAKE_KEY))).toEqual([]);
    expect(lines).toEqual([]);
    for (const outcome of outcomes) expect(JSON.stringify(outcome)).not.toContain(FAKE_KEY);
  });
});

describe("the key in Linq's error.message: no part of it is ever kept in a reason, whatever its shape", () => {
  const text = sendFixture("send-text.json").request;
  /** Linq's error answers, each with the words it carries, and the adapter's fixed words for it. */
  const answers: [string, (message: string) => Response, string][] = [
    ["401 with no code", (message) => linqError(401, null, { message }), REASONS.refused],
    ["403 code 2024", (message) => linqError(403, 2024, { message }), REASONS.optedOut],
    ["429 code 1007", (message) => linqError(429, 1007, { message, retryAfter: 65 }), REASONS.rateLimited],
    ["500 code 4001", (message) => linqError(500, 4001, { message }), REASONS.failed4001],
    ["504 code 4006", (message) => linqError(504, 4006, { message }), REASONS.timedOut4006],
    ["503 with no code", (message) => linqError(503, null, { message }), REASONS.serverError],
  ];

  it("has a letters-only fake key that no shared/redact.ts pattern catches, so only the adapter's screen can", () => {
    expect(LETTERS_KEY).toMatch(/^[A-Za-z]+$/);
    for (const words of [
      LETTERS_KEY,
      `Bad token ${LETTERS_KEY}`,
      `Bad token ${percentEncoded(LETTERS_KEY)}`,
    ]) {
      expect(findPrivateValue(words)).toBeUndefined();
      expect(redactFreeText(words)).toBe(words);
    }
  });

  it.each(BOTH_KEYS)(
    "gives the adapter's fixed words, never Linq's, when error.message echoes %s raw, URL-encoded or in part",
    async (_label, key) => {
      for (const [shape, message] of keyEchoes(key)) {
        for (const [answerLabel, answer, reason] of answers) {
          const label = `${shape}, ${answerLabel}`;
          const stub = stubFetch(() => answer(message));
          const outcome = await sender({ env: { LINQ_API_TOKEN: key }, fetch: stub.fetch }).sendPart(text);
          // The key echoed is the one the request went with.
          expect(
            stub.seen.map((seen) => seen.headers.authorization),
            label,
          ).toEqual([`Bearer ${key}`]);
          expect(outcome, label).toMatchObject({ result: "failed", reason, providerMessageId: null });
          expectSendError(outcome);
          const written = JSON.stringify(outcome);
          for (const form of [key, key.toLowerCase(), key.toUpperCase(), percentEncoded(key)])
            expect(written.includes(form), label).toBe(false);
        }
      }
    },
  );

  it.each(BOTH_KEYS)(
    "keeps Linq's words that hold no part of %s, even when they name LINQ_API_TOKEN",
    async (_label, key) => {
      for (const message of [`${LINQ_API_TOKEN} is not valid`, "Made up for a test."]) {
        const stub = stubFetch(() => linqError(401, null, { message }));
        const outcome = await sender({ env: { LINQ_API_TOKEN: key }, fetch: stub.fetch }).sendPart(text);
        expect(outcome, message).toMatchObject({ kind: "refused", httpStatus: 401, reason: message });
        expectSendError(outcome);
      }
    },
  );
});

describe("sendPart: Linq's answers read into K-11's outcomes", () => {
  const text = sendFixture("send-text.json").request;
  const link = sendFixture("send-link-card.json").request;
  const tapback = sendFixture("send-tapback.json").request;
  const cases: [string, SendPartRequest, () => Response | Promise<Response>, Partial<SendPartFailed>][] = [
    [
      "code 4001, delivery failed",
      text,
      () => linqError(500, 4001),
      { kind: "mayStillDeliver", httpStatus: 500, code: "4001", retryAfterSeconds: null },
    ],
    ["code 4006 under a 504", text, () => linqError(504, 4006), { kind: "mayStillDeliver", code: "4006" }],
    [
      "400 code 1005, a link as the first message of a new chat",
      link,
      () => linqError(400, 1005),
      { kind: "refused", httpStatus: 400, code: "1005", reason: "Made up for a test." },
    ],
    [
      "400 code 1004, content Linq refuses",
      text,
      () => linqError(400, 1004),
      { kind: "refused", httpStatus: 400, code: "1004" },
    ],
    [
      "400 for a tapback on a poll, with no code",
      tapback,
      () => linqError(400, null, { message: "Polls take stickers only" }),
      { kind: "refused", httpStatus: 400, code: null, reason: "Polls take stickers only" },
    ],
    [
      "403 code 2008, not on the allowed list",
      text,
      () => linqError(403, 2008),
      { kind: "refused", httpStatus: 403, code: "2008" },
    ],
    [
      "403 that is not JSON",
      text,
      () => new Response("Forbidden", { status: 403 }),
      { kind: "refused", httpStatus: 403, code: null, reason: REASONS.refused },
    ],
    [
      "401 with no body",
      text,
      () => new Response(null, { status: 401 }),
      { kind: "refused", httpStatus: 401 },
    ],
    [
      "code 2024 under a 400: K-11 reads 2024 only at 403",
      text,
      () => linqError(400, 2024),
      { kind: "refused", httpStatus: 400, code: null },
    ],
    [
      "code 2024 under a 500",
      text,
      () => linqError(500, 2024),
      { kind: "transient", httpStatus: 500, code: null },
    ],
    [
      "500 with its code as text",
      text,
      () => linqError(500, "5000"),
      { kind: "transient", httpStatus: 500, code: "5000" },
    ],
    [
      "503 with no body",
      text,
      () => new Response(null, { status: 503 }),
      { kind: "transient", httpStatus: 503, code: null, reason: REASONS.serverError },
    ],
    [
      "429 with Retry-After 30 and no body",
      text,
      () => new Response(null, { status: 429, headers: { "retry-after": "30" } }),
      {
        kind: "rateLimited",
        httpStatus: 429,
        code: null,
        retryAfterSeconds: 30,
        reason: REASONS.rateLimited,
      },
    ],
    [
      "429 with Retry-After 2.5",
      text,
      () => linqError(429, 1007, { headers: { "retry-after": "2.5" } }),
      { kind: "rateLimited", code: "1007", retryAfterSeconds: 3 },
    ],
    [
      "429 with Retry-After 30 and the body's retry_after 65",
      text,
      () => linqError(429, 1007, { retryAfter: 65, headers: { "retry-after": "30" } }),
      { kind: "rateLimited", retryAfterSeconds: 65 },
    ],
    [
      "429 with Retry-After 90 and the body's retry_after 65",
      text,
      () => linqError(429, 1007, { retryAfter: 65, headers: { "retry-after": "90" } }),
      { kind: "rateLimited", retryAfterSeconds: 90 },
    ],
    [
      "429 with a date for Retry-After and the body's retry_after 65",
      text,
      () =>
        linqError(429, 1007, { retryAfter: 65, headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" } }),
      { kind: "rateLimited", retryAfterSeconds: 65 },
    ],
    [
      "429 with the body's retry_after as text",
      text,
      () => linqError(429, 1007, { retryAfter: "12" }),
      { kind: "rateLimited", retryAfterSeconds: 12 },
    ],
    [
      "429 with neither wait",
      text,
      () => linqError(429, 1007, { retryAfter: -5 }),
      { kind: "rateLimited", retryAfterSeconds: null },
    ],
    [
      "302, a redirect not followed",
      text,
      () => new Response(null, { status: 302, headers: { location: "https://example.com/" } }),
      { kind: "transient", httpStatus: null, code: null, reason: REASONS.unreadable },
    ],
    [
      "202 with no message id",
      text,
      () => json(202, { chat_id: "linq-chat-demo-alex", message: { service: "iMessage" } }),
      { kind: "transient", httpStatus: null, reason: REASONS.unreadable },
    ],
    [
      "200 that is not JSON",
      text,
      () => new Response("<html></html>", { status: 200 }),
      { kind: "transient", httpStatus: null },
    ],
    [
      "a network error",
      text,
      () => Promise.reject(new TypeError("fetch failed")),
      { kind: "transient", httpStatus: null, code: null, reason: REASONS.noAnswer },
    ],
  ];

  it.each(cases)("reads %s", async (_label, request, answer, expected) => {
    const stub = stubFetch(answer);
    const outcome = await sender({ fetch: stub.fetch }).sendPart(request);
    expect(outcome).toMatchObject({ result: "failed", providerMessageId: null, ...expected });
    expectSendError(outcome);
    expect(stub.seen).toHaveLength(1);
    for (const value of privateValues(request)) expect(JSON.stringify(outcome)).not.toContain(value);
  });

  it("keeps Linq's message as the reason only when it holds no number, address, key or words of the request", async () => {
    const messages: [string, string][] = [
      ["Recipient +15555550101 asked you to stop", REASONS.optedOut],
      ["Recipient (555) 555-0101 asked you to stop", REASONS.optedOut],
      ["Write to help@example.com", REASONS.optedOut],
      [`Token Bearer ${FAKE_KEY} is blocked`, REASONS.optedOut],
      [`Stopped: ${text.text ?? ""}`, REASONS.optedOut],
      ["Recipient asked\nyou to stop", REASONS.optedOut],
      ["x".repeat(301), REASONS.optedOut],
      ["   ", REASONS.optedOut],
      ["Recipient asked you to stop messaging them", "Recipient asked you to stop messaging them"],
    ];
    for (const [message, reason] of messages) {
      const stub = stubFetch(() => linqError(403, 2024, { message }));
      const outcome = await sender({ fetch: stub.fetch }).sendPart(text);
      expect(outcome, message).toMatchObject({ kind: "optedOut", reason });
      expectSendError(outcome);
    }
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
    const outcome = await sender({ fetch: stub.fetch, timeoutMs: 20 }).sendPart(text);
    expect(outcome).toEqual(failed("transient", null, null, REASONS.noAnswer));
    expectSendError(outcome);
  });

  it("takes any 2xx for a tapback or typing dots, which make no message, and reads no service for them", async () => {
    for (const request of [tapback, sendFixture("send-typing.json").request]) {
      for (const status of [200, 202, 204]) {
        const stub = stubFetch(() => new Response(null, { status }));
        const outcome = await sender({ fetch: stub.fetch }).sendPart(request);
        expect(outcome).toEqual({
          result: "accepted",
          providerMessageId: null,
          providerOptionIds: null,
          chatId: request.chatId,
          service: null,
          acceptedAt: NOW,
        });
      }
    }
  });

  it("reads a message's service as Linq names it, and Linq's time only when it is one", async () => {
    const cases: [unknown, unknown, string | null, string][] = [
      ["RCS", "2026-10-23T14:05:04Z", "rcs", "2026-10-23T14:05:04Z"],
      ["SMS", "2026-10-23T14:05:04.250Z", "sms", "2026-10-23T14:05:04.250Z"],
      [null, "yesterday", null, NOW],
      ["Carrier pigeon", "2026-13-45T99:99:99Z", null, NOW],
      ["iMessage", 1761228304, "imessage", NOW],
    ];
    for (const [service, createdAt, readService, acceptedAt] of cases) {
      const stub = stubFetch(() =>
        json(202, {
          chat_id: text.chatId,
          message: { id: "linq-msg-demo-0099", service, created_at: createdAt },
        }),
      );
      const outcome = await sender({ fetch: stub.fetch }).sendPart(text);
      expect(outcome).toMatchObject({ result: "accepted", service: readService, acceptedAt });
      expectSendResponse(outcome);
    }
  });
});

describe("polls: Linq's option ids in the order of the request's options", () => {
  const fixture = sendFixture("send-poll.json");
  const recorded = vendor("create-poll-response.json") as { poll: { options: Record<string, unknown>[] } };

  function withOptions(options: Record<string, unknown>[]): Response {
    const answer = structuredClone(recorded);
    answer.poll.options = options;
    return json(202, answer);
  }

  it("finds each option's id by its words, whatever order Linq lists them in", async () => {
    const [first, second, third] = recorded.poll.options;
    if (first === undefined || second === undefined || third === undefined) throw new Error("3 options");
    const stub = stubFetch(() => withOptions([third, first, second]));
    const outcome = await sender({ fetch: stub.fetch }).sendPart(fixture.request);
    expect(outcome).toEqual(fixture.outcome);
  });

  it("reads an answer whose options do not match the request's one for one as unreadable", async () => {
    const [first, second, third] = recorded.poll.options;
    if (first === undefined || second === undefined || third === undefined) throw new Error("3 options");
    const answers: Record<string, unknown>[][] = [
      [first, second],
      [first, second, { ...third, text: "Sat 4:00pm" }],
      [first, second, second],
      [first, second, { ...third, option_id: null }],
      [first, second, { ...third, option_id: first.option_id }],
    ];
    for (const options of answers) {
      const stub = stubFetch(() => withOptions(options));
      const outcome = await sender({ fetch: stub.fetch }).sendPart(fixture.request);
      expect(outcome).toEqual(failed("transient", null, null, REASONS.unreadable));
    }
  });
});

describe("a part that carries a file", () => {
  const calendar = sendFixture("send-calendar-file.json").request;
  const photo = sendFixture("send-photo.json").request;

  it("is refused before any request when no step to put files up is given, so it goes again without its file", async () => {
    for (const request of [calendar, photo]) {
      const stub = stubFetch(acceptAny(request));
      const outcome = await sender({ fetch: stub.fetch }).sendPart(request);
      expect(outcome).toMatchObject({ result: "failed", kind: "refused", httpStatus: null, code: null });
      expectSendError(outcome);
      expect(stub.seen).toEqual([]);
    }
  });

  it("answers the file step's failure as the part's, and sends no message", async () => {
    const failures = [
      failed("refused", 400, "1004", "The file was refused."),
      failed("rateLimited", 429, "1007", "Rate limit exceeded", 65),
      failed("transient", 503, null, "A server error at Linq."),
    ];
    for (const failure of failures) {
      const stub = stubFetch(acceptAny(calendar));
      const attachFile: AttachFile = () => Promise.resolve(failure);
      const outcome = await sender({ fetch: stub.fetch, attachFile }).sendPart(calendar);
      expect(outcome).toEqual(failure);
      expect(stub.seen).toEqual([]);
    }
  });

  it.each(BOTH_KEYS)(
    "screens the file step's reason as Linq's message, with %s: no key, whole number or words of the part reach the outcome",
    async (_label, key) => {
      const reasons = [
        ...keyEchoes(key).map(([, words]) => words),
        `Upload for ${calendar.to} refused`,
        "Upload for (555) 555-0101 refused",
        `Upload refused: ${calendar.text ?? ""}`,
      ];
      const failures = [
        (reason: string) => failed("refused", 400, "1004", reason),
        (reason: string) => failed("rateLimited", 429, "1007", reason, 65),
        (reason: string) => failed("transient", 503, null, reason),
      ];
      for (const [index, reason] of reasons.entries()) {
        for (const failure of failures) {
          const label = `reason ${String(index)}`;
          const stub = stubFetch(acceptAny(calendar));
          const attachFile: AttachFile = () => Promise.resolve(failure(reason));
          const outcome = await sender({
            env: { LINQ_API_TOKEN: key },
            fetch: stub.fetch,
            attachFile,
          }).sendPart(calendar);
          expect(outcome, label).toEqual({ ...failure(reason), reason: REASONS.fileStep });
          expectSendError(outcome);
          expect(stub.seen, label).toEqual([]);
          const written = JSON.stringify(outcome);
          for (const value of [key, percentEncoded(key), calendar.to, calendar.text ?? ""])
            expect(written.includes(value), label).toBe(false);
        }
      }
    },
  );

  it.each(BOTH_KEYS)(
    "keeps a file step's reason that holds nothing private, and reads its code as Linq's, digits alone (%s)",
    async (_label, key) => {
      const steps: [AttachFile, SendPartFailed][] = [
        [
          () => Promise.resolve(failed("refused", 400, "1004", "The file was refused.")),
          failed("refused", 400, "1004", "The file was refused."),
        ],
        [
          () => Promise.resolve({ ...failed("refused", 400, null, "The file was refused."), code: key }),
          failed("refused", 400, null, "The file was refused."),
        ],
        [
          () => Promise.resolve({ ...failed("refused", 400, null, "The file was refused."), reason: "" }),
          failed("refused", 400, null, REASONS.fileStep),
        ],
      ];
      for (const [attachFile, expected] of steps) {
        const stub = stubFetch(acceptAny(calendar));
        const outcome = await sender({
          env: { LINQ_API_TOKEN: key },
          fetch: stub.fetch,
          attachFile,
        }).sendPart(calendar);
        expect(outcome).toEqual(expected);
        expectSendError(outcome);
        expect(stub.seen).toEqual([]);
      }
    },
  );

  it("answers transient when the file step throws or answers what cannot be read, and sends no message", async () => {
    const steps: AttachFile[] = [
      () => Promise.reject(new Error("upload failed")),
      () => Promise.resolve({ result: "attached", attachmentId: "" }),
      () => Promise.resolve({ result: "attached", attachmentId: "two words" }),
      () =>
        Promise.resolve({ result: "uploaded" } as unknown as { result: "attached"; attachmentId: string }),
      () => Promise.resolve(null as unknown as { result: "attached"; attachmentId: string }),
    ];
    for (const attachFile of steps) {
      const stub = stubFetch(acceptAny(photo));
      const outcome = await sender({ fetch: stub.fetch, attachFile }).sendPart(photo);
      expect(outcome).toMatchObject({ result: "failed", kind: "transient", httpStatus: null, code: null });
      expectSendError(outcome);
      expect(stub.seen).toEqual([]);
    }
  });
});

describe("ids in a path", () => {
  it("are percent-encoded, so no id names another of Linq's paths", async () => {
    const text = { ...sendFixture("send-text.json").request, chatId: "linq/../messages?to=x#y z" };
    const tapback = sendFixture("send-tapback.json").request;
    const like = { ...tapback, tapback: { ...tapback.tapback, onMessageId: "msg/1?x" } } as SendPartRequest;
    for (const [request, pathname] of [
      [text, "/api/partner/v3/chats/linq%2F..%2Fmessages%3Fto%3Dx%23y%20z/messages"],
      [like, "/api/partner/v3/messages/msg%2F1%3Fx/reactions"],
    ] as const) {
      const stub = stubFetch(acceptAny(request));
      expect((await sender({ fetch: stub.fetch }).sendPart(request)).result).toBe("accepted");
      const url = new URL(stub.seen[0]?.url ?? "");
      expect(url.origin).toBe("https://api.linqapp.com");
      expect(url.pathname).toBe(pathname);
      expect(url.search).toBe("");
      expect(url.hash).toBe("");
    }
  });

  it("refuses, before any request, an id of . or .., which a URL would read as a step to another path", async () => {
    const text = sendFixture("send-text.json").request;
    const tapback = sendFixture("send-tapback.json").request;
    const requests = [
      { ...text, chatId: ".." },
      { ...text, chatId: "." },
      { ...tapback, tapback: { ...tapback.tapback, onMessageId: ".." } },
    ];
    for (const request of requests) {
      const stub = stubFetch(acceptAny(request as SendPartRequest));
      const outcome = await sender({ fetch: stub.fetch }).sendPart(request);
      expect(outcome).toMatchObject({ result: "failed", kind: "refused", httpStatus: null, code: null });
      expectSendError(outcome);
      expect(stub.seen).toEqual([]);
    }
  });
});

describe("making the adapter", () => {
  it("refuses a time limit that is not a whole number of milliseconds above 0", () => {
    for (const timeoutMs of [0, -1, 1.5, Number.NaN])
      expect(() => createLinqSender({ env: {}, timeoutMs })).toThrow(RangeError);
  });
});
