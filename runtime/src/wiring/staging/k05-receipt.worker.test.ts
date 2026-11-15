// T-1394: staging's two K-05 calls at receipt (./k05-receipt.ts; the D-017 path audit's P2a; the lead's notes DL-438 to
// DL-468, DL-476, DL-757 and DL-768), inside the Workers runtime on T-1253's rig (infra/test-rig/files.mjs, key
// K05_RECEIPT) and through its pool bindings only (vitest.config.ts): this file's pair, HYPERDRIVE_JOB_K05_RECEIPT and
// HYPERDRIVE_APP_K05_RECEIPT, the two Worker logins on this file's own database (migrated, bundle v0 active, seeded by
// ./k05-receipt.seed.ts), and the pool's own HYPERDRIVE_JOB, which names rosie_rig_none, never made. Each test hands the
// Worker's root (workerRoot), a root composed as workerRoot composes it (stagingOptions over a handle whose lines are
// kept) or the binding itself (stagingReceiptCalls) an env of its own whose HYPERDRIVE_JOB and HYPERDRIVE_APP are pool
// bindings, or doubles over a pool binding that count the reads of its connection string, with a SEALING_WRAP_KEY made
// at random for the run and a made-up LINQ_WEBHOOK_SECRET, the Linq double's.
//
//   - Each call through its bound port, its answer from the seeded rows and shaped as its K-05 fixture: the key call
//     for test owner 1's number (the key made, then nothing made), a first sight, each data key a key object that
//     cannot be exported; the chat open for his handle (inserted, repeated, alreadyOpen) and for an unknown handle id.
//   - One signed text through the gateway's Linq entry (handleLinqWebhook with the root's doors, as the route calls it
//     with the flag on): from test owner 1's number, then from a number never seen: 200, the key row and the phone row
//     written once, one entry in the handle's inbox, its words sealed under the stored key; the same webhook again: 200,
//     dropped, nothing new written. Its end is hop 2's: the actor's ports are not installed.
//   - Each refusal or failure: 503, the row counts of handles, persons, person_handles, sealing_keys, phones and event_log
//     unchanged, no inbox entry, and the gateway's log line holding its stage and the error's name only. A chat open that
//     fails after its key call: 503 with nothing stored for the text, and the same webhook again is taken as a repeat.
//   - Unbound (no HYPERDRIVE_JOB, or production's environment): each port fails as with nothing bound, no binding read.
//   - No line written while this file runs holds a number, a wrapping key, the webhook secret, a chat id or a word.
// The test's own reads go through T-1254's handle (its quiet socket), so none leaves a rejection behind (T-1403).
// Test values only (rule 9): fiction-range 555-01xx numbers, made-up ids, words, keys and a made-up webhook secret.
import { createLinqWebhookDouble, type LinqWebhookDouble } from "@rosie/adapters/linq/double-webhooks";
import keyExisting from "@rosie/contracts/data-access/fixtures/handle-key-existing.json";
import keyFirstSight from "@rosie/contracts/data-access/fixtures/handle-key-first-sight.json";
import keyPersonNoKey from "@rosie/contracts/data-access/fixtures/handle-key-person-no-key.json";
import chatAlreadyOpen from "@rosie/contracts/data-access/fixtures/open-chat-alex-already-open.json";
import chatFirstTextRepeat from "@rosie/contracts/data-access/fixtures/open-chat-first-text-sam-repeat.json";
import chatFirstText from "@rosie/contracts/data-access/fixtures/open-chat-first-text-sam.json";
import textFixture from "@rosie/contracts/inbound-event/fixtures/text-imessage.json";
import type { OpenChatOnTextOutcome, OpenChatOnTextRequest } from "@rosie/db/repo/chat-open";
import { DataAccessDatabaseError } from "@rosie/db/repo/clocks";
import type { HandleSealingKeyRequest, HandleSealingKeyResult } from "@rosie/db/repo/handle-keys";
import { SealingError } from "@rosie/db/repo/sealing";
import { reset, runInDurableObject } from "cloudflare:test";
import { env as poolEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";

import type { HandleActor } from "../../actor";
import type { InboxEntry } from "../../actor/inbox";
import { actorNameOf, handleLinqWebhook, openWords } from "../../gateway";
import type { Span } from "../../trace";
import { spansOfLogLines, spansOfTrace } from "../../trace/hop-check";
import {
  composeRoot,
  NoDatabaseError,
  NotJoinedError,
  SEALING_WRAP_KEY,
  workerRoot,
  type Root,
} from "../index";
import { testWebhookSecret, type LinqInboundEvent, type SignedWebhook } from "../test-support";
import { DbClosedError, dbHandle } from "./db";
import {
  HANDLE_SEALING_KEY_CALL,
  NO_RECEIPT_INPUTS,
  OPEN_CHAT_ON_TEXT_CALL,
  stagingReceiptCalls,
  type ReceiptInputs,
} from "./k05-receipt";
import { OTHER_NAME_HANDLE, OTHER_WRAP_KEY_NAME, OTHER_WRAP_KEY_VALUE, SAM_HANDLE } from "./k05-receipt.seed";
import { stagingOptions } from "./options";
import { stagingDb, type StagingDb, type StagingEnv } from "./part";
import { sealingWrapKeys, WrappingKeyNameError } from "./secrets";

/** This file's key in the rig's list (infra/test-rig/files.mjs). */
const KEY = "K05_RECEIPT";
const JOB = `HYPERDRIVE_JOB_${KEY}`;
const APP = `HYPERDRIVE_APP_${KEY}`;
/** The pool's own job binding: its database, rosie_rig_none, is never made, so a connect through it fails. */
const POOL_JOB = "HYPERDRIVE_JOB";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$/u;
/** A made-up trace id for the calls a test makes through a port itself. */
const TRACE = "7b1e4c2a-3d5f-4a6b-8c9d-0e1f2a3b4c5d";
/** Where the gateway's Linq entry runs, as the root's route hands it (../root.ts). */
const WHERE = { environment: "staging", version: "test-sha" };

// The numbers of this file, each a whole fiction-range literal. Test owner 1's and the other-name row's are the seed's;
// the first sight's is handle-key-first-sight.json's own.
const FIRST_SIGHT_NUMBER = keyFirstSight.request.handle.address;
/** A number never seen, whose first text goes through the gateway. */
const NEW_TEXTER_NUMBER = "+15555550152";
/** A number never seen, whose text finds no wrapping key: nothing of it is ever written. */
const NO_KEY_NUMBER = "+15555550153";
/** A number never seen, whose text's chat open fails after its key call. */
const CHAT_FAILS_NUMBER = "+15555550154";

const NUMBERS = [
  SAM_HANDLE.number,
  OTHER_NAME_HANDLE.number,
  FIRST_SIGHT_NUMBER,
  NEW_TEXTER_NUMBER,
  NO_KEY_NUMBER,
  CHAT_FAILS_NUMBER,
];

/** The pool's Hyperdrive bindings, by name. */
const pool = poolEnv as unknown as Readonly<Record<string, Hyperdrive | undefined>>;

function poolBinding(name: string): Hyperdrive {
  const found = pool[name];
  if (found === undefined) throw new Error(`the pool has no Hyperdrive binding ${name}`);
  return found;
}

const DATABASE = inject("rosieRigDatabases")?.[KEY];

// ---- the run's made-up secrets (made inside a test, never as the file loads) -------------------------------------------

let madeWrapKey: string | undefined;
let madeWebhookSecret: string | undefined;
let madeLinqDouble: LinqWebhookDouble | undefined;

/** This run's SEALING_WRAP_KEY: 32 random bytes as base64, the form db/repo takes. Never a key of anything else. */
function wrapKey(): string {
  madeWrapKey ??= btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  return madeWrapKey;
}

/** This run's LINQ_WEBHOOK_SECRET, in Linq's form: the Linq double signs under it and the root's verify reads it. */
function webhookSecret(): string {
  madeWebhookSecret ??= testWebhookSecret();
  return madeWebhookSecret;
}

function linqDouble(): LinqWebhookDouble {
  madeLinqDouble ??= createLinqWebhookDouble({ secret: webhookSecret() });
  return madeLinqDouble;
}

// ---- what this file's isolate wrote and rejected -----------------------------------------------------------------------

/** Every unhandled rejection this isolate reports while this file runs. */
const rejections: unknown[] = [];
addEventListener("unhandledrejection", (event) => {
  rejections.push(event.reason);
});

/** Every line written on console.log and console.error while this file's tests ran, and the running test's own. */
const everyLine: string[] = [];
let lines: string[] = [];

beforeEach(() => {
  lines = [];
  const keep = (...args: unknown[]): void => {
    const line = args.map((arg) => String(arg)).join(" ");
    lines.push(line);
    everyLine.push(line);
  };
  vi.spyOn(console, "log").mockImplementation(keep);
  vi.spyOn(console, "error").mockImplementation(keep);
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Each test's actors start empty: hop 2 ends at the inbox, and nothing of one test's inbox reaches the next.
  await reset();
});

type Line = Record<string, unknown>;

const isRecord = (value: unknown): value is Line =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A written line as the JSON object it is, or none for a line that is no JSON object. */
function jsonOf(line: string): Line[] {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? [value] : [];
  } catch {
    return [];
  }
}

// ---- envs and doubles --------------------------------------------------------------------------------------------------

interface TestEnv {
  readonly env: StagingEnv;
  /** Every key read from the env, in order. */
  readonly keys: string[];
}

/** An env of the test's own: staging's vars (unless the fields say otherwise) and the fields, each key read recorded. */
function envOf(fields: Readonly<Record<string, unknown>>): TestEnv {
  const keys: string[] = [];
  const target: Record<string, unknown> = {
    ENVIRONMENT: "staging",
    BASE_PATH: "/test",
    DB_SCHEMA: "",
    GIT_SHA: "test-sha",
    ...fields,
  };
  const proxied = new Proxy(target, {
    get(object, key, receiver): unknown {
      if (typeof key === "string") keys.push(key);
      return Reflect.get(object, key, receiver);
    },
  });
  return { env: proxied as unknown as StagingEnv, keys };
}

const count = (keys: readonly string[], name: string): number => keys.filter((key) => key === name).length;

interface Counted {
  readonly binding: { readonly connectionString: string };
  readonly reads: { n: number };
}

/** A double over a pool binding that counts the reads of its connection string (and gives the pool binding's). */
function counted(binding: Hyperdrive): Counted {
  const reads = { n: 0 };
  return {
    binding: {
      get connectionString(): string {
        reads.n += 1;
        return binding.connectionString;
      },
    },
    reads,
  };
}

/**
 * Staging's bindings and secrets as this file hands them: this file's pair, the run's SEALING_WRAP_KEY and
 * LINQ_WEBHOOK_SECRET, and the pool's HandleActor namespace (env.staging's), with the fields a test changes.
 */
function staging(fields: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    HYPERDRIVE_JOB: poolBinding(JOB),
    HYPERDRIVE_APP: poolBinding(APP),
    SEALING_WRAP_KEY: wrapKey(),
    LINQ_WEBHOOK_SECRET: webhookSecret(),
    HANDLE_ACTOR: poolEnv.HANDLE_ACTOR,
    ...fields,
  };
}

// ---- this file's rows, read through the test's own job-side handle -----------------------------------------------------

/** The test's own job-side handle on this file's pair (T-1254's, each client on its quiet socket). */
const own = dbHandle(
  {
    ENVIRONMENT: "staging",
    DB_SCHEMA: "",
    HYPERDRIVE_JOB: poolBinding(JOB),
    HYPERDRIVE_APP: poolBinding(APP),
  },
  { log: () => undefined },
);

/** The row counts of the six tables the two calls write or read. */
interface Counts {
  readonly handles: number;
  readonly persons: number;
  readonly person_handles: number;
  readonly sealing_keys: number;
  readonly phones: number;
  readonly event_log: number;
}

function counts(): Promise<Counts> {
  return own.runtime("t1394Counts", async (sql) => {
    const [row] = await sql<Counts[]>`
      select (select count(*)::int from handles) as handles,
             (select count(*)::int from persons) as persons,
             (select count(*)::int from person_handles) as person_handles,
             (select count(*)::int from sealing_keys) as sealing_keys,
             (select count(*)::int from phones) as phones,
             (select count(*)::int from event_log) as event_log
    `;
    if (row === undefined) throw new Error("the counts read gave no row");
    return {
      handles: row.handles,
      persons: row.persons,
      person_handles: row.person_handles,
      sealing_keys: row.sealing_keys,
      phones: row.phones,
      event_log: row.event_log,
    };
  });
}

/** `before` with `delta` added: the counts a call that wrote exactly those rows leaves. */
const plus = (before: Counts, delta: Partial<Counts>): Counts => ({
  handles: before.handles + (delta.handles ?? 0),
  persons: before.persons + (delta.persons ?? 0),
  person_handles: before.person_handles + (delta.person_handles ?? 0),
  sealing_keys: before.sealing_keys + (delta.sealing_keys ?? 0),
  phones: before.phones + (delta.phones ?? 0),
  event_log: before.event_log + (delta.event_log ?? 0),
});

/** What the database holds for one number: its handle, its people, their keys, its phone row and its chat-opened entries. */
interface NumberRows {
  readonly handles: string[];
  readonly persons: string[];
  readonly keys: { person: string; name: string; held: boolean; version: number }[];
  readonly phones: { chatOpen: boolean; way: string | null; stopped: boolean; version: number }[];
  readonly entries: string[];
}

function rowsOf(number: string): Promise<NumberRows> {
  return own.runtime("t1394Rows", async (sql) => {
    const handles = await sql<{ id: string }[]>`select id from handles where address = ${number} order by id`;
    const persons = await sql<{ person_id: string }[]>`
      select ph.person_id from person_handles ph join handles h on h.id = ph.handle_id
      where h.address = ${number} order by ph.person_id
    `;
    const keys = await sql<
      { person_id: string; wrapping_key_name: string; held: boolean; version: number }[]
    >`
      select k.person_id, k.wrapping_key_name, (k.wrapped_key is not null) as held, k.version
      from sealing_keys k
      join person_handles ph on ph.person_id = k.person_id
      join handles h on h.id = ph.handle_id
      where h.address = ${number} order by k.person_id
    `;
    const phones = await sql<
      { chat_open: boolean; chat_way: string | null; stopped: boolean; version: number }[]
    >`select chat_open, chat_way, stopped, version from phones where number = ${number}`;
    const entries = await sql<{ id: string }[]>`
      select e.id from event_log e join handles h on h.id = e.row_id
      where h.address = ${number} and e.table_name = 'phones' and e.kind = 'phone.chat_opened' order by e.id
    `;
    return {
      handles: handles.map((row) => row.id),
      persons: persons.map((row) => row.person_id),
      keys: keys.map((row) => ({
        person: row.person_id,
        name: row.wrapping_key_name,
        held: row.held,
        version: row.version,
      })),
      phones: phones.map((row) => ({
        chatOpen: row.chat_open,
        way: row.chat_way,
        stopped: row.stopped,
        version: row.version,
      })),
      entries: entries.map((row) => row.id),
    };
  });
}

// ---- the handle's actor: hop 2's end ----------------------------------------------------------------------------------

type Namespace = DurableObjectNamespace<HandleActor>;

function namespace(): Namespace {
  const bound = poolEnv.HANDLE_ACTOR;
  if (bound === undefined) throw new Error("env.staging binds no HANDLE_ACTOR");
  return bound as unknown as Namespace;
}

const actorOf = (number: string): string => actorNameOf({ kind: "phone", address: number });

/** The ordered inbox of a number's actor, read inside its Durable Object (HandleActor.readInbox). */
function inboxOf(number: string): Promise<InboxEntry[]> {
  const stub = namespace().get(namespace().idFromName(actorOf(number)));
  return runInDurableObject(stub, (actor: HandleActor) => actor.readInbox());
}

// ---- a signed text through the gateway's Linq entry --------------------------------------------------------------------

interface Text {
  readonly number: string;
  readonly eventId: string;
  readonly body: string;
}

/** Test owner 1's first text, as T-570's JOIN arrives. */
const SAM_JOIN: Text = { number: SAM_HANDLE.number, eventId: "evt-t1394-sam-first", body: "JOIN" };

/** The words of every other text here: made up, so a line that held one would show it. */
const BODIES = {
  newTexter: "marigold lantern haircut on Saturday?",
  refused: "periwinkle thimble before noon?",
  chatFails: "saffron kettle after lunch?",
} as const;

/** K-06's text-imessage.json as that number's text, signed by the Linq double, received now (inside the 300 s window). */
function signed(text: Text): Promise<SignedWebhook> {
  const now = new Date().toISOString().replace(/[.][0-9]+Z$/u, "Z");
  const event: LinqInboundEvent = {
    ...(structuredClone(textFixture) as unknown as LinqInboundEvent),
    eventId: text.eventId,
    handle: { kind: "phone", address: text.number },
    messageId: `linq-msg-${text.eventId}`,
    chatId: `linq-chat-${text.eventId}`,
    sentAt: now,
    receivedAt: now,
    body: text.body,
  };
  return linqDouble().sign({ event, partKey: null });
}

interface Sent {
  readonly status: number;
  readonly body: unknown;
  readonly traceId: string;
  /** The JSON lines written while the gateway answered. */
  readonly lines: Line[];
}

/** One webhook as Linq posts it, through the gateway's Linq entry with the root's doors, as the route calls it. */
async function post(root: Root, webhook: SignedWebhook): Promise<Sent> {
  const before = lines.length;
  const request = new Request("https://rosie.test/test/webhooks/linq", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": webhook.webhookId,
      "webhook-timestamp": webhook.timestamp,
      "webhook-signature": webhook.signature,
    },
    body: webhook.raw,
  });
  const response = await handleLinqWebhook(request, root.gateway, WHERE);
  const body: unknown = await response.json();
  const traceId = response.headers.get("x-trace-id");
  if (traceId === null) throw new Error("the gateway answered with no trace id");
  return { status: response.status, body, traceId, lines: lines.slice(before).flatMap(jsonOf) };
}

/** The receive span the gateway wrote for one answer. */
function receiveOf(sent: Sent): Span {
  const span = spansOfTrace(spansOfLogLines(sent.lines), sent.traceId).find((one) => one.hop === "receive");
  if (span === undefined) throw new Error("the gateway wrote no receive span");
  return span;
}

/** The gateway's failure lines of one answer. */
const failuresOf = (sent: Sent): Line[] =>
  sent.lines.filter((line) => line.msg === "gateway_failed" && line.trace_id === sent.traceId);

/** The timing line the root's handle writes for one of the two calls: the job side, as rosie_worker_job. */
const callLine = (call: string, traceId: string | null): Line => ({
  level: "info",
  msg: "dbCall",
  trace_id: traceId,
  call,
  side: "runtime",
  binding: "HYPERDRIVE_JOB",
  login: "rosie_worker_job",
  connect: { at: expect.any(String) as string, ms: expect.any(Number) as number },
  guard: { at: expect.any(String) as string, ms: expect.any(Number) as number },
  environment: "staging",
  version: "test-sha",
});

/** The two calls' timing lines among the lines written (another part's calls, once bound, write their own). */
const receiptCalls = (written: readonly Line[]): Line[] =>
  written.filter(
    (line) =>
      line.msg === "dbCall" &&
      (line.call === HANDLE_SEALING_KEY_CALL || line.call === OPEN_CHAT_ON_TEXT_CALL),
  );

/** The key call through the gateway's key store, as the gateway makes it for a text that opens its number's chat. */
async function handleKeyOf(root: Root, number: string): Promise<{ key: CryptoKey; handleId: string }> {
  const found = await root.gateway.keys.getOrCreateHandleKey?.({ kind: "phone", address: number });
  if (found === undefined) throw new Error("the gateway's key store answers no handle id");
  if (!(found.key instanceof CryptoKey)) throw new Error("the key call handed over no key object");
  return { key: found.key, handleId: found.handleId };
}

// ---- what an error and a line give away --------------------------------------------------------------------------------

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

/** The texts an error gives away: its message, its stack but for the frames, its own fields as JSON, and as a string. */
function textsOf(error: unknown): string[] {
  if (!(error instanceof Error)) return [String(error)];
  const stack = (error.stack ?? "")
    .split("\n")
    .filter((line) => !/^\s+at\s/u.test(line))
    .join("\n");
  // Every own field, the ones JSON.stringify leaves out included (message, and the stack without its frames).
  const fields = Object.fromEntries(
    Object.getOwnPropertyNames(error).map((key): [string, unknown] => [key, Reflect.get(error, key)]),
  );
  return [error.message, stack, JSON.stringify(error), JSON.stringify({ ...fields, stack }), String(error)];
}

/** Whether `text` holds `part` as a whole name (not inside a longer name). */
function holds(text: string, part: string): boolean {
  const escaped = part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "u").test(text);
}

/** Every text holds none of the binding's string, host, user, password or database. */
function expectNothingOf(binding: { readonly connectionString: string }, texts: readonly string[]): void {
  const url = new URL(binding.connectionString);
  const parts = [
    binding.connectionString,
    url.host,
    url.hostname,
    decodeURIComponent(url.username),
    decodeURIComponent(url.password),
    decodeURIComponent(url.pathname.slice(1)),
  ].filter((part) => part !== "");
  expect(parts.length).toBeGreaterThanOrEqual(5);
  for (const text of texts) {
    for (const part of parts) {
      expect(holds(text, part), "a text holds a part of the binding's string").toBe(false);
    }
  }
}

/**
 * What no line and no error may hold: this file's numbers in any form, an actor's name, the run's wrapping key and the
 * seeded row's, the webhook secret, a chat id, and a word of a text.
 */
function neverWritten(): string[] {
  return [
    ...NUMBERS,
    ...NUMBERS.map((number) => number.slice(1)),
    "5555550",
    "555-01",
    "phone:",
    wrapKey(),
    OTHER_WRAP_KEY_VALUE,
    webhookSecret(),
    webhookSecret().slice("whsec_".length),
    "linq-chat-",
    "linq-msg-",
    SAM_JOIN.body,
    ...Object.values(BODIES),
    ...Object.values(BODIES).flatMap((body) => body.split(" ").filter((word) => word.length >= 7)),
  ];
}

function expectNothingWritten(texts: readonly string[]): void {
  const never = neverWritten();
  for (const text of texts) {
    for (const value of never)
      expect(text.includes(value), "a text holds a value it must never hold").toBe(false);
  }
}

// ---- a root whose K-05 answers and timing lines are kept ----------------------------------------------------------------

interface Recorded {
  readonly keys: { request: HandleSealingKeyRequest; result: HandleSealingKeyResult }[];
  readonly chats: { request: OpenChatOnTextRequest; outcome: OpenChatOnTextOutcome }[];
}

interface RecordingRoot {
  readonly root: Root;
  /** Each K-05 answer the binding handed its port, as it handed it. */
  readonly recorded: Recorded;
  readonly db: StagingDb;
  /** The timing lines the root's handle wrote. */
  readonly written: Line[];
  /** Every key read from the env, in order. */
  readonly keys: string[];
}

/**
 * A root composed as the Worker's is (../root.ts workerRoot: the real set over stagingOptions(env)), over a handle whose
 * timing lines are kept, with the binding's own two calls recorded as they answer: the binding is the one under test,
 * unchanged, and what its port makes of each answer is the port's (../real.ts).
 */
function recordingRoot(fields: Readonly<Record<string, unknown>>): RecordingRoot {
  const { env, keys } = envOf(fields);
  const written: Line[] = [];
  const db = stagingDb(env, {
    write: (line) => {
      everyLine.push(line);
      written.push(...jsonOf(line));
    },
  });
  const recorded: Recorded = { keys: [], chats: [] };
  const inputs = stagingOptions(env, {
    db,
    builders: {
      receipt: (part): ReceiptInputs => {
        const bound = stagingReceiptCalls(part);
        const { handleKey, chatOpenCall } = bound;
        if (handleKey === null || chatOpenCall === null) return bound;
        return {
          handleKey: async (request) => {
            const result = await handleKey(request);
            recorded.keys.push({ request, result });
            return result;
          },
          chatOpenCall: async (request) => {
            const outcome = await chatOpenCall(request);
            recorded.chats.push({ request, outcome });
            return outcome;
          },
        };
      },
    },
  });
  const root = composeRoot({
    environment: "staging",
    actors: null,
    vars: env,
    linq: { webhookSecret: () => env.LINQ_WEBHOOK_SECRET },
    ...inputs,
  });
  return { root, recorded, db, written, keys };
}

/** handle-key-person-no-key.json's request and open-chat-first-text-sam.json's, as K-05's two calls take them. */
const KEY_REQUEST: HandleSealingKeyRequest = {
  ...keyPersonNoKey.request,
  handle: { kind: "phone", address: keyPersonNoKey.request.handle.address },
};
const CHAT_REQUEST: OpenChatOnTextRequest = { ...chatFirstText.request, service: "imessage", traceId: TRACE };

/** A data key as K-05 hands it over: a key object for AES-256-GCM, to encrypt and decrypt, that cannot be exported. */
async function expectDataKey(key: CryptoKey): Promise<void> {
  expect({ type: key.type, extractable: key.extractable, usages: [...key.usages].sort() }).toEqual({
    type: "secret",
    extractable: false,
    usages: ["decrypt", "encrypt"],
  });
  expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
  await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
}

// ---- this file's database ----------------------------------------------------------------------------------------------

describe("this file's database: test owner 1 as staging holds him before his first text, and one held key row under another name", () => {
  it("the rig made this file's database and its seed wrote the rows, readable on the job side", async () => {
    expect(DATABASE).toMatch(/^rosie_rig_[0-9a-f]{8}_k05_receipt$/u);
    // The fixtures' rows are the seed's: test owner 1's number, handle and person.
    expect(keyPersonNoKey.request.handle.address).toBe(SAM_HANDLE.number);
    expect(keyPersonNoKey.outcome.handleId).toBe(SAM_HANDLE.id);
    expect(chatFirstText.request.handleId).toBe(SAM_HANDLE.id);

    // Test owner 1: a handle and a person, linked, with no key and no phone row (db/seeds/skeleton.ts).
    expect(await rowsOf(SAM_HANDLE.number)).toEqual({
      handles: [SAM_HANDLE.id],
      persons: [keyPersonNoKey.outcome.personId],
      keys: [],
      phones: [],
      entries: [],
    });
    // The held key row: wrapped under another upper-case name.
    expect(OTHER_WRAP_KEY_NAME).toMatch(/^[A-Z][A-Z0-9_]*$/u);
    expect(OTHER_WRAP_KEY_NAME).not.toBe(SEALING_WRAP_KEY);
    expect(await rowsOf(OTHER_NAME_HANDLE.number)).toEqual({
      handles: [OTHER_NAME_HANDLE.id],
      persons: [OTHER_NAME_HANDLE.personId],
      keys: [{ person: OTHER_NAME_HANDLE.personId, name: OTHER_WRAP_KEY_NAME, held: true, version: 1 }],
      phones: [],
      entries: [],
    });
    // No other number of this file is known yet.
    for (const number of [FIRST_SIGHT_NUMBER, NEW_TEXTER_NUMBER, NO_KEY_NUMBER, CHAT_FAILS_NUMBER]) {
      expect((await rowsOf(number)).handles).toEqual([]);
    }
  });
});

// ---- each call through its bound port ----------------------------------------------------------------------------------

describe("each call through its bound port, its answer from the seeded rows and shaped as its K-05 fixture", () => {
  it("the binding alone: built, it reads ENVIRONMENT and the presence of HYPERDRIVE_JOB, nothing else, and gives both calls", () => {
    const job = counted(poolBinding(JOB));
    const app = counted(poolBinding(APP));
    const { env, keys } = envOf(staging({ HYPERDRIVE_JOB: job.binding, HYPERDRIVE_APP: app.binding }));

    const bound = stagingReceiptCalls({ env, db: stagingDb(env), keys: sealingWrapKeys(env) });

    expect(bound.handleKey).toBeTypeOf("function");
    expect(bound.chatOpenCall).toBeTypeOf("function");
    expect(Object.keys(bound).sort()).toEqual(["chatOpenCall", "handleKey"]);
    // No connection string, no secret and nothing of the Tool API's side.
    expect(keys).toEqual(["ENVIRONMENT", "HYPERDRIVE_JOB"]);
    expect([job.reads.n, app.reads.n]).toEqual([0, 0]);
  });

  it("the key call through the gateway's key store: test owner 1's key is made (handle-key-person-no-key.json), then found with nothing made (handle-key-existing.json's shape); a first sight makes the handle, the person and the key (handle-key-first-sight.json); each data key cannot be exported", async () => {
    const job = counted(poolBinding(JOB));
    const app = counted(poolBinding(APP));
    const run = recordingRoot(staging({ HYPERDRIVE_JOB: job.binding, HYPERDRIVE_APP: app.binding }));
    // Building the root reads no connection string and no secret.
    expect([job.reads.n, app.reads.n]).toEqual([0, 0]);
    expect(count(run.keys, "SEALING_WRAP_KEY")).toBe(0);
    const before = await counts();

    // Test owner 1: his handle and person are the seed's; his key is made now.
    const made = await handleKeyOf(run.root, SAM_HANDLE.number);
    const afterMade = await counts();
    // The same call again: the key is found, and nothing is made.
    const found = await handleKeyOf(run.root, SAM_HANDLE.number);
    const afterFound = await counts();
    // A number never seen: the handle, a person with no name yet, their link and the key.
    const first = await handleKeyOf(run.root, FIRST_SIGHT_NUMBER);
    const afterFirst = await counts();

    const [madeCall, foundCall, firstCall] = run.recorded.keys;
    if (madeCall === undefined || foundCall === undefined || firstCall === undefined) {
      throw new Error("the binding answered fewer than three key calls");
    }
    expect(run.recorded.keys).toHaveLength(3);
    // The request the real sealing port sends (../real.ts): new ids on every call, the wrapping key by its name.
    expect(madeCall.request).toEqual({
      handle: { kind: "phone", address: SAM_HANDLE.number },
      newHandleId: expect.stringMatching(/^handle-/u) as string,
      newPersonId: expect.stringMatching(/^person-/u) as string,
      wrappingKeyName: SEALING_WRAP_KEY,
    });
    expect(foundCall.request.newHandleId).not.toBe(madeCall.request.newHandleId);

    // handle-key-person-no-key.json: handle-sam and person-sam, the key made, under SEALING_WRAP_KEY at version 1.
    expect(madeCall.result.outcome).toEqual({
      ...keyPersonNoKey.outcome,
      key: { ...keyPersonNoKey.outcome.key, createdAt: expect.stringMatching(UTC) as string },
    });
    expect(made.handleId).toBe(SAM_HANDLE.id);
    expect(afterMade).toEqual(plus(before, { sealing_keys: 1 }));
    // handle-key-existing.json's shape: the same handle, person and key row, nothing made.
    expect(foundCall.result.outcome).toEqual({
      ...madeCall.result.outcome,
      created: keyExisting.outcome.created,
    });
    expect(keyExisting.outcome.created).toEqual({ handle: false, person: false, key: false });
    expect(found.handleId).toBe(SAM_HANDLE.id);
    expect(afterFound).toEqual(afterMade);
    // handle-key-first-sight.json: the request's new ids are the rows', and all three were made.
    expect(firstCall.request.handle).toEqual(keyFirstSight.request.handle);
    expect(firstCall.result.outcome).toEqual({
      ...keyFirstSight.outcome,
      handleId: firstCall.request.newHandleId,
      personId: firstCall.request.newPersonId,
      key: { ...keyFirstSight.outcome.key, createdAt: expect.stringMatching(UTC) as string },
    });
    expect(first.handleId).toBe(firstCall.request.newHandleId);
    expect(afterFirst).toEqual(
      plus(afterFound, { handles: 1, persons: 1, person_handles: 1, sealing_keys: 1 }),
    );

    // The rows themselves, read on the job side.
    expect(await rowsOf(SAM_HANDLE.number)).toMatchObject({
      handles: [SAM_HANDLE.id],
      persons: [keyPersonNoKey.outcome.personId],
      keys: [{ person: keyPersonNoKey.outcome.personId, name: SEALING_WRAP_KEY, held: true, version: 1 }],
    });
    expect(await rowsOf(FIRST_SIGHT_NUMBER)).toEqual({
      handles: [firstCall.request.newHandleId],
      persons: [firstCall.request.newPersonId],
      keys: [{ person: firstCall.request.newPersonId, name: SEALING_WRAP_KEY, held: true, version: 1 }],
      phones: [],
      entries: [],
    });

    // Each data key: a key object that cannot be exported, beside the answer and never in it.
    for (const key of [made.key, found.key, first.key]) await expectDataKey(key);
    for (const call of run.recorded.keys) {
      expect(Object.keys(call.result).sort()).toEqual(["dataKey", "outcome"]);
      expect(Object.keys(call.result.outcome).sort()).toEqual(Object.keys(keyExisting.outcome).sort());
    }
    // The key found is the key made: what one sealed, the other opens (the stored row, unwrapped at each call).
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      made.key,
      new TextEncoder().encode("t1394 round trip"),
    );
    const opened = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, found.key, sealed);
    expect(new TextDecoder().decode(opened)).toBe("t1394 round trip");
    await expect(crypto.subtle.decrypt({ name: "AES-GCM", iv }, first.key, sealed)).rejects.toThrow();

    // Each call reached PostgreSQL on a client of its own, as rosie_worker_job, ended after it; the wrapping key was
    // read from the env at each call, and the Tool API's binding never.
    expect(run.written).toEqual(run.recorded.keys.map(() => callLine(HANDLE_SEALING_KEY_CALL, null)));
    expect(run.db.counts()).toMatchObject({ opened: 3, ended: 3, connectionsOpen: 0 });
    expect([job.reads.n, app.reads.n]).toEqual([3, 0]);
    expect(count(run.keys, "SEALING_WRAP_KEY")).toBe(3);
    expectNothingWritten(run.written.map((line) => JSON.stringify(line)));
  });

  it("the chat open through its port: test owner 1's first text inserts his phone row (open-chat-first-text-sam.json), its repeat is repeated (open-chat-first-text-sam-repeat.json), another text finds the chat open (open-chat-alex-already-open.json's shape), and an unknown handle id is notFound", async () => {
    const job = counted(poolBinding(JOB));
    const app = counted(poolBinding(APP));
    const run = recordingRoot(staging({ HYPERDRIVE_JOB: job.binding, HYPERDRIVE_APP: app.binding }));
    const firstText = CHAT_REQUEST;
    const laterText = {
      ...firstText,
      eventId: "evt-t1394-sam-later",
      receivedAt: "2026-10-19T18:09:41Z",
    };
    const unknown = { ...firstText, eventId: "evt-t1394-nobody", handleId: "handle-t1394-nobody" };
    const before = await counts();

    const inserted = await run.root.ports.chatOpen.openChatOnText(firstText);
    const afterInserted = await counts();
    const repeated = await run.root.ports.chatOpen.openChatOnText(firstText);
    const alreadyOpen = await run.root.ports.chatOpen.openChatOnText(laterText);
    const notFound = await run.root.ports.chatOpen.openChatOnText(unknown);
    const after = await counts();

    // What the gateway reads (../real.ts realChatOpen): the result, or the error's name.
    expect([inserted, repeated, alreadyOpen, notFound]).toEqual([
      { result: "inserted" },
      { result: "repeated" },
      { result: "alreadyOpen" },
      { error: "notFound" },
    ]);
    // What K-05 answered the binding, as it handed it on: each fixture's outcome, value for value.
    expect(run.recorded.chats.map((call) => call.request)).toEqual([
      firstText,
      firstText,
      laterText,
      unknown,
    ]);
    const outcomes = run.recorded.chats.map((call) => call.outcome);
    expect(outcomes[0]).toEqual(chatFirstText.outcome);
    expect(outcomes[1]).toEqual(chatFirstTextRepeat.outcome);
    // The first text's time, way and version stay (K-05 default 72).
    expect(outcomes[2]).toEqual({
      result: "alreadyOpen",
      handleId: SAM_HANDLE.id,
      phone: chatFirstText.outcome.phone,
      event: null,
    });
    expect(Object.keys(outcomes[2] ?? {}).sort()).toEqual(Object.keys(chatAlreadyOpen.outcome).sort());
    expect(outcomes[3]).toEqual({ error: "notFound", table: "handles", rowId: unknown.handleId });

    // One phone row and one entry, written by the first call alone.
    expect(afterInserted).toEqual(plus(before, { phones: 1, event_log: 1 }));
    expect(after).toEqual(afterInserted);
    expect(await rowsOf(SAM_HANDLE.number)).toMatchObject({
      phones: [{ chatOpen: true, way: "imessage", stopped: false, version: 1 }],
      entries: [chatFirstText.outcome.event.id],
    });

    // Each call reached PostgreSQL on a client of its own, its timing on the text's trace.
    expect(run.written).toEqual(outcomes.map(() => callLine(OPEN_CHAT_ON_TEXT_CALL, TRACE)));
    expect(run.db.counts()).toMatchObject({ opened: 4, ended: 4, connectionsOpen: 0 });
    expect([job.reads.n, app.reads.n]).toEqual([4, 0]);
    expectNothingWritten(run.written.map((line) => JSON.stringify(line)));
  });
});

// ---- one signed text through the gateway's Linq entry ------------------------------------------------------------------

/**
 * One signed text through the gateway's Linq entry on the Worker's root, then the same webhook again: 200 and one inbox
 * entry, its words sealed under the stored key; then 200, dropped, with nothing new written.
 */
async function receivedOnce(text: Text): Promise<{ first: Sent; again: Sent; afterFirst: Counts }> {
  const job = counted(poolBinding(JOB));
  const app = counted(poolBinding(APP));
  const { env } = envOf(staging({ HYPERDRIVE_JOB: job.binding, HYPERDRIVE_APP: app.binding }));
  const root = workerRoot(env);
  const webhook = await signed(text);

  const first = await post(root, webhook);
  const afterFirst = await counts();

  expect(first.status).toBe(200);
  expect(first.body).toEqual({ ok: true, trace_id: first.traceId });
  expect(first.traceId).toMatch(UUID);
  // The two calls, each on a job-side client of its own: the key call, then the chat open on the text's trace.
  expect(receiptCalls(first.lines)).toEqual([
    callLine(HANDLE_SEALING_KEY_CALL, null),
    callLine(OPEN_CHAT_ON_TEXT_CALL, first.traceId),
  ]);
  expect(failuresOf(first)).toEqual([]);
  expect(receiveOf(first)).toMatchObject({
    seq: 1,
    outcome: "ok",
    event_id: text.eventId,
    decided: { signatureValid: true, knownEventId: false, sealedToActor: true, answered: 200 },
    error_code: null,
  });

  // Hop 2's end: one entry in the handle's ordered inbox, with no words but the sealed ones.
  const inbox = await inboxOf(text.number);
  expect(inbox).toHaveLength(1);
  const [entry] = inbox;
  if (entry === undefined) throw new Error("no inbox entry");
  expect(entry).toMatchObject({ partKey: null, traceId: first.traceId, startsTurn: true });
  expect(entry.event).toMatchObject({
    eventId: text.eventId,
    kind: "text",
    handle: { kind: "phone", address: text.number },
  });
  expect(entry.event).not.toHaveProperty("body");
  expect(JSON.stringify(entry)).not.toContain(text.body);
  const sealed = entry.event.sealed;
  if (sealed === null) throw new Error("the words were not sealed");
  // The key the row holds opens them: the key call again hands over the stored key, unwrapped under SEALING_WRAP_KEY.
  const stored = await handleKeyOf(root, text.number);
  await expectDataKey(stored.key);
  expect((await openWords(sealed, stored.key, actorOf(text.number), text.eventId)).body).toBe(text.body);
  await expect(
    openWords(sealed, crypto.getRandomValues(new Uint8Array(32)), actorOf(text.number), text.eventId),
  ).rejects.toThrow();

  // The same webhook again, as Linq sends it after a lost answer: dropped as a known event id, nothing new written.
  const beforeAgain = await counts();
  const again = await post(root, webhook);
  expect(again.status).toBe(200);
  expect(receiveOf(again)).toMatchObject({
    outcome: "dropped",
    decided: { signatureValid: true, knownEventId: true, firstTrace: first.traceId, answered: 200 },
  });
  expect(await counts()).toEqual(beforeAgain);
  expect(beforeAgain).toEqual(afterFirst);
  expect((await inboxOf(text.number)).map((one) => [one.event.eventId, one.traceId])).toEqual([
    [text.eventId, first.traceId],
  ]);
  // The job side only.
  expect(job.reads.n).toBeGreaterThanOrEqual(5);
  expect(app.reads.n).toBe(0);
  expectNothingWritten([...first.lines, ...again.lines].map((line) => JSON.stringify(line)));
  return { first, again, afterFirst };
}

describe("one signed text through the gateway's Linq entry, on the Worker's root: hop 2's end", () => {
  it("from test owner 1's number, as T-570's JOIN arrives: 200, his key row and his phone row (chat open) written once, one entry in handle-sam's inbox; the same webhook again: 200, dropped, nothing new written", async () => {
    await receivedOnce(SAM_JOIN);

    // Written once, whichever call wrote them: one key row for person-sam under SEALING_WRAP_KEY, one phone row with its
    // chat open, one chat-opened entry.
    expect(await rowsOf(SAM_HANDLE.number)).toEqual({
      handles: [SAM_HANDLE.id],
      persons: [keyPersonNoKey.outcome.personId],
      keys: [{ person: keyPersonNoKey.outcome.personId, name: SEALING_WRAP_KEY, held: true, version: 1 }],
      phones: [{ chatOpen: true, way: "imessage", stopped: false, version: 1 }],
      entries: [expect.stringMatching(/\/chat-opened$/u) as string],
    });
  });

  it("from a number never seen: 200, and its one webhook writes the handle, the person, their link, the key, the phone row and the chat-opened entry; the same webhook again: 200, dropped, nothing new written", async () => {
    const text: Text = { number: NEW_TEXTER_NUMBER, eventId: "evt-t1394-new-texter", body: BODIES.newTexter };
    const before = await counts();

    const { afterFirst } = await receivedOnce(text);

    expect(afterFirst).toEqual(
      plus(before, { handles: 1, persons: 1, person_handles: 1, sealing_keys: 1, phones: 1, event_log: 1 }),
    );
    const rows = await rowsOf(text.number);
    expect(rows).toEqual({
      handles: [expect.stringMatching(/^handle-/u) as string],
      persons: [expect.stringMatching(/^person-/u) as string],
      keys: [{ person: rows.persons[0], name: SEALING_WRAP_KEY, held: true, version: 1 }],
      phones: [{ chatOpen: true, way: "imessage", stopped: false, version: 1 }],
      entries: [`${text.eventId}/chat-opened`],
    });
  });
});

// ---- each refusal or failure ---------------------------------------------------------------------------------------------

interface FailingCase {
  readonly name: string;
  /** Whose text it is. */
  readonly number: string;
  readonly eventId: string;
  /** The env's fields, made for the case. */
  readonly fields: () => Record<string, unknown>;
  /** The name of what the key call throws: the one thing of it the gateway logs. */
  readonly error: string;
  /** A line the failure writes besides, by msg: the handle's own refusal line, where its guard refused. */
  readonly also?: string;
  /** A name of the env that is never read. */
  readonly neverRead?: string;
}

const FAILING: readonly FailingCase[] = [
  {
    name: "SEALING_WRAP_KEY not in the env, for a number never seen (no handle, person or key row is left)",
    number: NO_KEY_NUMBER,
    eventId: "evt-t1394-no-wrap-key",
    fields: () => staging({ SEALING_WRAP_KEY: undefined }),
    error: "SealingError",
  },
  {
    name: "SEALING_WRAP_KEY not in the env, for test owner 1's number",
    number: SAM_HANDLE.number,
    eventId: "evt-t1394-no-wrap-key-sam",
    fields: () => staging({ SEALING_WRAP_KEY: undefined }),
    error: "SealingError",
  },
  {
    name: "a SEALING_WRAP_KEY that is no 256-bit key",
    number: NO_KEY_NUMBER,
    eventId: "evt-t1394-bad-wrap-key",
    fields: () => staging({ SEALING_WRAP_KEY: btoa("t1394 too short to be a key") }),
    error: "SealingError",
  },
  {
    name: "the held key row whose stored wrapping name is another upper-case name, with that name's own key in the env (never resolved)",
    number: OTHER_NAME_HANDLE.number,
    eventId: "evt-t1394-other-name",
    fields: () => staging({ [OTHER_WRAP_KEY_NAME]: OTHER_WRAP_KEY_VALUE }),
    error: "WrappingKeyNameError",
    neverRead: OTHER_WRAP_KEY_NAME,
  },
  {
    name: "the env's HYPERDRIVE_JOB the pool's own, on rosie_rig_none (the connect fails)",
    number: SAM_HANDLE.number,
    eventId: "evt-t1394-pool-own",
    fields: () => staging({ HYPERDRIVE_JOB: poolBinding(POOL_JOB) }),
    error: "DataAccessDatabaseError",
  },
  {
    name: "DB_SCHEMA set (no client is opened)",
    number: SAM_HANDLE.number,
    eventId: "evt-t1394-db-schema",
    fields: () => staging({ DB_SCHEMA: "preview_t1394" }),
    error: "DbClosedError",
  },
  {
    name: "the handle's refusal (HYPERDRIVE_JOB stores the Tool API's login)",
    number: SAM_HANDLE.number,
    eventId: "evt-t1394-guard",
    fields: () => staging({ HYPERDRIVE_JOB: poolBinding(APP) }),
    error: "DbGuardRefusal",
    also: "dbGuardRefused",
  },
  {
    name: "a HYPERDRIVE_JOB binding that gives no connection string",
    number: SAM_HANDLE.number,
    eventId: "evt-t1394-no-string",
    fields: () => staging({ HYPERDRIVE_JOB: {} }),
    error: "DbClosedError",
  },
  {
    name: "HYPERDRIVE_JOB unbound and HYPERDRIVE_APP bound (the port has no call)",
    number: SAM_HANDLE.number,
    eventId: "evt-t1394-unbound",
    fields: () => staging({ HYPERDRIVE_JOB: undefined }),
    error: "NoDatabaseError",
  },
];

describe("each refusal or failure: 503, the row counts unchanged, no inbox entry, and nothing of the failure in a line but its name", () => {
  it.each(FAILING)(
    "$name: 503 (sealFailed), the six tables' counts unchanged, no inbox entry; the log line holds stage prepare and the error's name only",
    async ({ number, eventId, fields, error, also, neverRead }) => {
      const { env, keys } = envOf(fields());
      const root = workerRoot(env);
      const webhook = await signed({ number, eventId, body: BODIES.refused });
      const before = await counts();
      const rowsBefore = await rowsOf(number);

      const sent = await post(root, webhook);

      expect(sent.status).toBe(503);
      expect(sent.body).toEqual({ ok: false, error: "unavailable", trace_id: sent.traceId });
      expect(receiveOf(sent)).toMatchObject({
        outcome: "failed",
        decided: { signatureValid: true, answered: 503 },
        error_code: "sealFailed",
      });
      const failed = failuresOf(sent);
      expect(failed).toEqual([
        { level: "error", msg: "gateway_failed", trace_id: sent.traceId, stage: "prepare", error },
      ]);
      expect(Object.keys(failed[0] ?? {}).sort()).toEqual(["error", "level", "msg", "stage", "trace_id"]);
      // The key call gave no key, so no chat open was made.
      expect(receiptCalls(sent.lines).filter((line) => line.call === OPEN_CHAT_ON_TEXT_CALL)).toEqual([]);
      if (also !== undefined) expect(sent.lines.map((line) => line.msg)).toContain(also);
      if (neverRead !== undefined) expect(count(keys, neverRead)).toBe(0);

      // Nothing written and nothing stored: Linq sends the text again.
      expect(await counts()).toEqual(before);
      expect(await rowsOf(number)).toEqual(rowsBefore);
      expect(await inboxOf(number)).toEqual([]);
      expectNothingWritten(sent.lines.map((line) => JSON.stringify(line)));
    },
  );

  it("a chat open that fails after its key call (the connect fails at that call): 503 (chatOpenFailed) with no phone row, no entry and nothing in the inbox; the same webhook again finds the key and is received", async () => {
    const text: Text = { number: CHAT_FAILS_NUMBER, eventId: "evt-t1394-chat-fails", body: BODIES.chatFails };
    const webhook = await signed(text);
    // The binding's string is read at each call: this file's own until the key call has read the wrapping key, then the
    // pool's own, whose database was never made. So the key call answers and the chat open's connect fails.
    const read: { keys: readonly string[] } = { keys: [] };
    const turned = envOf(
      staging({
        HYPERDRIVE_JOB: {
          get connectionString(): string {
            const name = count(read.keys, "SEALING_WRAP_KEY") > 0 ? POOL_JOB : JOB;
            return poolBinding(name).connectionString;
          },
        },
      }),
    );
    read.keys = turned.keys;
    const before = await counts();

    const failed = await post(workerRoot(turned.env), webhook);
    const afterFailed = await counts();

    expect(failed.status).toBe(503);
    expect(receiveOf(failed)).toMatchObject({
      outcome: "failed",
      decided: { signatureValid: true, answered: 503 },
      error_code: "chatOpenFailed",
    });
    expect(failuresOf(failed)).toEqual([
      {
        level: "error",
        msg: "gateway_failed",
        trace_id: failed.traceId,
        stage: "chat",
        error: "DataAccessDatabaseError",
      },
    ]);
    // The key call's own transaction had committed (K-05 item 29); the chat open wrote nothing, and nothing was stored.
    expect(afterFailed).toEqual(plus(before, { handles: 1, persons: 1, person_handles: 1, sealing_keys: 1 }));
    expect(await inboxOf(text.number)).toEqual([]);
    const keyRows = await rowsOf(text.number);
    expect(keyRows).toMatchObject({ phones: [], entries: [] });
    expect(keyRows.keys).toHaveLength(1);

    // Linq sends it again: the key is found, not made, and the chat opens.
    const again = await post(workerRoot(envOf(staging()).env), webhook);
    expect(again.status).toBe(200);
    expect(receiveOf(again)).toMatchObject({
      outcome: "ok",
      decided: { sealedToActor: true, answered: 200 },
    });
    expect(await counts()).toEqual(plus(afterFailed, { phones: 1, event_log: 1 }));
    expect(await rowsOf(text.number)).toEqual({
      ...keyRows,
      phones: [{ chatOpen: true, way: "imessage", stopped: false, version: 1 }],
      entries: [`${text.eventId}/chat-opened`],
    });
    expect(await inboxOf(text.number)).toHaveLength(1);
    expectNothingWritten([...failed.lines, ...again.lines].map((line) => JSON.stringify(line)));
  });

  it("what each call throws on the pool's own HYPERDRIVE_JOB: the call's name and SQLSTATE only, no number, host, user or password, through the binding and through its port", async () => {
    const { env } = envOf(staging({ HYPERDRIVE_JOB: poolBinding(POOL_JOB) }));
    const written: Line[] = [];
    const db = stagingDb(env, {
      write: (line) => {
        everyLine.push(line);
        written.push(...jsonOf(line));
      },
    });
    const bound = stagingReceiptCalls({ env, db, keys: sealingWrapKeys(env) });
    if (bound.handleKey === null || bound.chatOpenCall === null) {
      throw new Error("the binding is null with HYPERDRIVE_JOB bound");
    }
    const root = workerRoot(env);
    const chat: OpenChatOnTextRequest = { ...CHAT_REQUEST, eventId: "evt-t1394-pool-own-chat" };

    const thrown = [
      await rejectionOf(bound.handleKey(KEY_REQUEST)),
      await rejectionOf(handleKeyOf(root, SAM_HANDLE.number)),
      await rejectionOf(bound.chatOpenCall(chat)),
      await rejectionOf(root.ports.chatOpen.openChatOnText(chat)),
    ];

    const calls = [
      HANDLE_SEALING_KEY_CALL,
      HANDLE_SEALING_KEY_CALL,
      OPEN_CHAT_ON_TEXT_CALL,
      OPEN_CHAT_ON_TEXT_CALL,
    ];
    for (const [index, error] of thrown.entries()) {
      const call = calls[index] ?? "";
      expect(error).toBeInstanceOf(DataAccessDatabaseError);
      expect(error).toMatchObject({ call, code: "3D000", table: null, constraint: null });
      expect((error as Error).message).toBe(`${call}: the database refused the call (SQLSTATE 3D000)`);
      expect(Object.keys(error as Error).sort()).toEqual(["call", "code", "constraint", "name", "table"]);
      expectNothingOf(poolBinding(POOL_JOB), textsOf(error));
      expectNothingWritten(textsOf(error));
    }
    // The guard never passed: no timing line, and each client the binding's own handle opened was ended.
    expect(written).toEqual([]);
    expect(db.counts()).toMatchObject({ opened: 2, ended: 2, connectionsOpen: 0 });
  });

  it("an error the handle passes through as it came leaves scrubbed; the handle's own refusal, the resolver's and db/repo's leave as they are", async () => {
    // A stand-in for the handle only (the binding is the code under test): it rejects as the handle would pass on an
    // error of postgres.js, which carries the statement, its values and the address, then with each named refusal.
    const clientError = (): Error =>
      Object.assign(new Error(`write CONNECTION_CLOSED db.t1394.invalid:5432 for ${SAM_HANDLE.number}`), {
        code: "CONNECTION_CLOSED",
        errno: "CONNECTION_CLOSED",
        address: "db.t1394.invalid",
        port: 5432,
        query: "select id from handles where address = $1",
        parameters: [SAM_HANDLE.number],
        args: [SAM_HANDLE.number],
      });
    const named: Error[] = [
      new DbClosedError(HANDLE_SEALING_KEY_CALL, "runtime", "dbSchemaSet"),
      new WrappingKeyNameError(),
      new SealingError("wrapping_key_missing"),
    ];
    const failures: Error[] = [clientError(), clientError(), ...named];
    const calls: string[] = [];
    const db: StagingDb = {
      runtime: (call) => {
        calls.push(call);
        return Promise.reject(failures.shift() ?? new Error("the stand-in has no failure left"));
      },
      toolApi: () => Promise.reject(new Error("the receipt's calls never run on the Tool API's side")),
      counts: () => ({
        opened: 0,
        ended: 0,
        connectionsOpen: 0,
        connectionsPeak: 0,
        quietReads: 0,
        quietWrites: 0,
      }),
    };
    const { env } = envOf({ HYPERDRIVE_JOB: {} });
    const bound = stagingReceiptCalls({ env, db, keys: sealingWrapKeys(env) });
    if (bound.handleKey === null || bound.chatOpenCall === null) {
      throw new Error("the binding is null with HYPERDRIVE_JOB bound");
    }

    const scrubbedKey = await rejectionOf(bound.handleKey(KEY_REQUEST));
    const scrubbedChat = await rejectionOf(bound.chatOpenCall(CHAT_REQUEST));
    const passed = [
      await rejectionOf(bound.handleKey(KEY_REQUEST)),
      await rejectionOf(bound.chatOpenCall(CHAT_REQUEST)),
      await rejectionOf(bound.handleKey(KEY_REQUEST)),
    ];

    expect(calls).toEqual([
      HANDLE_SEALING_KEY_CALL,
      OPEN_CHAT_ON_TEXT_CALL,
      HANDLE_SEALING_KEY_CALL,
      OPEN_CHAT_ON_TEXT_CALL,
      HANDLE_SEALING_KEY_CALL,
    ]);
    for (const [error, call] of [
      [scrubbedKey, HANDLE_SEALING_KEY_CALL],
      [scrubbedChat, OPEN_CHAT_ON_TEXT_CALL],
    ] as const) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(`${call}: the database call failed (code CONNECTION_CLOSED)`);
      expect(Object.keys(error as Error).sort()).toEqual(["call", "code"]);
      expect(error).toMatchObject({ call, code: "CONNECTION_CLOSED" });
      expect((error as Error).cause).toBeUndefined();
      for (const text of textsOf(error)) {
        expect(text).not.toContain("t1394.invalid");
        expect(text).not.toContain("handles");
      }
      expectNothingWritten(textsOf(error));
    }
    expect(passed[0]).toBe(named[0]);
    expect(passed[1]).toBe(named[1]);
    expect(passed[2]).toBe(named[2]);
    // The resolver's refusal names the one secret it reads, by its name, and nothing else.
    expect(named[1]?.message).toBe(`the wrapping key resolver reads ${SEALING_WRAP_KEY} only`);
  });
});

// ---- unbound -------------------------------------------------------------------------------------------------------------

describe("unbound: each port fails as with nothing bound, and no binding is read", () => {
  it("HYPERDRIVE_JOB unbound and HYPERDRIVE_APP bound: the binding gives its nothing-bound input, both ports throw NoDatabaseError naming the call, and HYPERDRIVE_APP is read 0 times", async () => {
    for (const unbound of [{ HYPERDRIVE_JOB: undefined }, { HYPERDRIVE_JOB: null }]) {
      const app = counted(poolBinding(APP));
      const fields = staging({ ...unbound, HYPERDRIVE_APP: app.binding });
      const direct = envOf(fields);
      expect(
        stagingReceiptCalls({
          env: direct.env,
          db: stagingDb(direct.env),
          keys: sealingWrapKeys(direct.env),
        }),
      ).toBe(NO_RECEIPT_INPUTS);
      expect(direct.keys).toEqual(["ENVIRONMENT", "HYPERDRIVE_JOB"]);
      const { env, keys } = envOf(fields);
      const root = workerRoot(env);

      const key = await rejectionOf(handleKeyOf(root, SAM_HANDLE.number));
      const chat = await rejectionOf(root.ports.chatOpen.openChatOnText(CHAT_REQUEST));

      expect(key).toBeInstanceOf(NoDatabaseError);
      expect((key as Error).message).toBe(new NoDatabaseError(HANDLE_SEALING_KEY_CALL).message);
      expect(chat).toBeInstanceOf(NoDatabaseError);
      expect((chat as Error).message).toBe(new NoDatabaseError(OPEN_CHAT_ON_TEXT_CALL).message);
      expect(app.reads.n).toBe(0);
      expect(count(keys, "SEALING_WRAP_KEY")).toBe(0);
    }
    expect(NO_RECEIPT_INPUTS).toEqual({ handleKey: null, chatOpenCall: null });
  });

  it("production's environment with both bindings: the binding gives its nothing-bound input, the sealing and chat-open ports are closed (NotJoinedError), and no binding or secret is read", async () => {
    const job = counted(poolBinding(JOB));
    const app = counted(poolBinding(APP));
    const fields = staging({
      ENVIRONMENT: "production",
      BASE_PATH: "",
      HYPERDRIVE_JOB: job.binding,
      HYPERDRIVE_APP: app.binding,
    });
    const direct = envOf(fields);
    expect(
      stagingReceiptCalls({ env: direct.env, db: stagingDb(direct.env), keys: sealingWrapKeys(direct.env) }),
    ).toBe(NO_RECEIPT_INPUTS);
    expect(direct.keys).toEqual(["ENVIRONMENT"]);
    const { env, keys } = envOf(fields);
    const root = workerRoot(env);

    const key = await rejectionOf(handleKeyOf(root, SAM_HANDLE.number));
    const chat = await rejectionOf(root.ports.chatOpen.openChatOnText(CHAT_REQUEST));

    expect(root.environment).toBe("production");
    expect(key).toBeInstanceOf(NotJoinedError);
    expect((key as Error).message).toBe(new NotJoinedError("sealing").message);
    expect(chat).toBeInstanceOf(NotJoinedError);
    expect((chat as Error).message).toBe(new NotJoinedError("chatOpen").message);
    expect(keys.filter((name) => name.startsWith("HYPERDRIVE"))).toEqual([]);
    expect(count(keys, "SEALING_WRAP_KEY")).toBe(0);
    expect([job.reads.n, app.reads.n]).toEqual([0, 0]);
  });
});

// ---- the capture ---------------------------------------------------------------------------------------------------------

describe("the span and log capture", () => {
  it("no line written while this file ran holds a number, an actor's name, a wrapping key, the webhook secret, a chat id or a word of a text, and no rejection was left unhandled", async () => {
    // Its own round, so the capture is never empty: a text received, one refused for its wrapping key's name, and one
    // whose connect fails.
    const good = workerRoot(envOf(staging()).env);
    const received = await post(
      good,
      await signed({ number: SAM_HANDLE.number, eventId: "evt-t1394-capture", body: SAM_JOIN.body }),
    );
    expect(received.status).toBe(200);
    const refused = await post(
      good,
      await signed({
        number: OTHER_NAME_HANDLE.number,
        eventId: "evt-t1394-capture-refused",
        body: BODIES.refused,
      }),
    );
    expect(refused.status).toBe(503);
    const failing = workerRoot(envOf(staging({ HYPERDRIVE_JOB: poolBinding(POOL_JOB) })).env);
    const failed = await post(
      failing,
      await signed({ number: NO_KEY_NUMBER, eventId: "evt-t1394-capture-failed", body: BODIES.chatFails }),
    );
    expect(failed.status).toBe(503);

    const kinds = new Set(everyLine.flatMap(jsonOf).map((line) => line.msg));
    expect([...kinds]).toEqual(expect.arrayContaining(["dbCall", "span", "gateway_failed"]));
    expectNothingWritten(everyLine);
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(rejections.map((reason) => String(reason))).toEqual([]);
  });
});
