// T-1449 (DL-940; D-018), under Node (Vitest project "unit"): ./linq-line.ts's switch, its one rule for who is a test
// phone, the send by recipient over stand-ins (a recording test-phone line and a counting maker of the real sender, so
// nothing here reaches Linq or any network), and the Linq verify input the Worker's root is handed, each with every name
// read from the env counted. ./linq-line.worker.test.ts runs the real guarded sender against a stood-in Linq and the
// test-phone line's Durable Object, and the test-phone page's send through the Worker's route; ../linq.test.ts runs the
// two secrets through workerRoot's verify. Test values only (rule 9): every number a whole literal of the fiction range
// (555-01xx), a made-up key and made-up secrets.
//
// T-1456 (D-018's staging record; K-05 v1.10 item 51, the audit's CHAT; CQ-61): the real line's chat lookup, the
// verify's chatHandle bound to db/repo's readChatHandle on the root's handle (./part.ts stagingDb over a stand-in for
// T-1254's handle, its `open` seam, whose client is a stand-in for PostgreSQL answering readChatHandle's statements from
// rows made up here, so db/repo's own call runs and nothing leaves the process): bound only where the real line is on, the
// root hands its handle and HYPERDRIVE_JOB is bound, reading nothing more to be made; a known chat answers its number on
// the runtime side, read-only; an unknown chat, an email thread's or an email handle's chat and a transient read answer
// none; a call that cannot be made rejects, scrubbed. Then Linq's signed receipts through the gateway's Linq entry, with
// the root's verify on the real line: a known chat's message.delivered becomes its K-06 event for the roster phone and
// is answered 200, written, then duplicate; an unknown chat's, a transient read's, and the same receipt under main's
// verify input (no handle handed) are answered 503 with nothing written, the failure line naming receiptHandleUnknown
// and never the chat id or a number; Rosie's own reaction, a sent receipt and a failed poll on the known chat are placed
// too; a message.received and the test-phone page's own events verify as before and never ask the lookup.
//
// T-1465 (DL-978: four Linq events answered 503 handoffFailed right after the delivered receipt; DL-997): each receipt
// kind after the chat is placed, through the root's own Linq route and receipt door. A message.sent that is no delivery
// receipt (on iMessage, RCS or no service reported) is placed by one lookup and answered 200, written with nothing marked
// and no failure line, and so is Linq's repeat of it. A message.sent on SMS, a message.failed and a poll.failed are placed
// and then still refused by the door before its store is asked anything (../root.ts deliveredStatusOf, a WiringError
// carrying a label): 503, the receive span failed handoffFailed and naming the kind, the failure line naming the kind and
// the refusal's label (smsSentReceiptNoDoor, failedReceiptNoDoor), nothing marked. The handle's actor is never reached by
// a receipt; ./linq-line.worker.test.ts runs the same kinds, and Rosie's own reaction, over the HandleActor.
import { createLinqWebhookDouble } from "@rosie/adapters/linq/double-webhooks";
import deliveredJson from "@rosie/contracts/inbound-event/fixtures/delivered.json";
import pollFailedJson from "@rosie/contracts/inbound-event/fixtures/poll-failed.json";
import reactionFromRosieJson from "@rosie/contracts/inbound-event/fixtures/reaction-from-rosie.json";
import sentJson from "@rosie/contracts/inbound-event/fixtures/sent.json";
import textJson from "@rosie/contracts/inbound-event/fixtures/text-imessage.json";
import sendText from "@rosie/contracts/port-linq/fixtures/send-text.json";
import type { Sql } from "@rosie/db/repo/scope";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LinqAccepted, LinqFailed, LinqSendRequest } from "../../dispatch/types";
import { handleLinqWebhook, type ActorHandoff, type ReceiptSink, type StoreAnswer } from "../../gateway";
import { composeRoot, SKELETON_FLAG, type Root } from "../index";
import {
  fakeFlags,
  skeletonFakes,
  testClock,
  testWebhookSecret,
  type LinqInboundEvent,
  type SignedWebhook,
  type SkeletonFakes,
  type TestClock,
} from "../test-support";
import type { DbCallTiming, DbHandle, DbHandleOptions } from "./db";
import {
  isTestPhone,
  linqLineSend,
  READ_CHAT_HANDLE_CALL,
  REAL_LINQ_LINE,
  realLinqLineOn,
  STAGING_LINQ_LINE,
  stagingLinqVerifyInputs,
  TEST_PHONE_WEBHOOK_SECRET,
  type LinqLineEnv,
} from "./linq-line";
import { stagingDb, type StagingDb, type StagingEnv } from "./part";

/** The roster phone: on STAGING_LINQ_ALLOWLIST, as the user's own iPhone is on staging (here a fiction number). */
const ROSTER_PHONE = "+15555550150";
/** A test phone: send-text.json's own `to`, in the fiction range and off the list. */
const TEST_PHONE = "+15555550101";
/** A test phone with another area code: the range is any area code that is not toll-free. */
const OTHER_AREA_TEST_PHONE = "+12125550142";
/** Rosie's own line for these tests (the Linq double's made-up line). */
const ROSIE = "+15555550199";
/** Made-up secrets, in Linq's form: never Linq's, never staging's. */
const LINQ_SECRET = `whsec_${btoa("t1449 made-up linq webhook secret")}`;
const PAGE_SECRET = `whsec_${btoa("t1449 made-up test-phone page secret")}`;

/** The names this card adds, none of which is read anywhere while the real line is off. */
const NEW_NAMES = [
  "STAGING_LINQ_ALLOWLIST",
  "ROSIE_NUMBER",
  "LINQ_API_TOKEN",
  TEST_PHONE_WEBHOOK_SECRET,
] as const;

interface CountedEnv {
  readonly env: LinqLineEnv;
  /** Every name read from the env, by a get or by an `in`, in order. */
  readonly names: string[];
}

/** An env double holding `values`, whose every read is counted. */
function counted(values: Record<string, unknown>): CountedEnv {
  const names: string[] = [];
  const env = new Proxy(values, {
    get(target, name, receiver): unknown {
      if (typeof name === "string") names.push(name);
      return Reflect.get(target, name, receiver);
    },
    has(target, name): boolean {
      if (typeof name === "string") names.push(name);
      return Reflect.has(target, name);
    },
  });
  return { env: env as unknown as LinqLineEnv, names };
}

/** Staging with the real line on, the roster phone on the list, Rosie's line and both secrets set. */
const LINE_ON: Readonly<Record<string, unknown>> = {
  ENVIRONMENT: "staging",
  [STAGING_LINQ_LINE]: REAL_LINQ_LINE,
  STAGING_LINQ_ALLOWLIST: ROSTER_PHONE,
  ROSIE_NUMBER: ROSIE,
  LINQ_WEBHOOK_SECRET: LINQ_SECRET,
  [TEST_PHONE_WEBHOOK_SECRET]: PAGE_SECRET,
};

/** The values of the switch that leave the real line off: absent, the card's two, and near misses of "real". */
const OFF_VALUES: readonly (readonly [string, unknown])[] = [
  ["absent", undefined],
  ['"double"', "double"],
  ['""', ""],
  ['"REAL"', "REAL"],
  ['"Real"', "Real"],
  ['" real"', " real"],
  ['"real "', "real "],
  ['"real\\n"', "real\n"],
  ["true", true],
  ["1", 1],
  ["null", null],
  ['["real"]', ["real"]],
];

/** LINE_ON with the switch at `value` (left out of the env entirely when undefined). */
function withSwitch(value: unknown): Record<string, unknown> {
  const values: Record<string, unknown> = { ...LINE_ON };
  if (value === undefined) Reflect.deleteProperty(values, STAGING_LINQ_LINE);
  else values[STAGING_LINQ_LINE] = value;
  return values;
}

/** send-text.json's request (K-11 v1 sendPart, the dispatcher's kinds), sent to `to`. */
function partTo(to: unknown): LinqSendRequest {
  return { ...(structuredClone(sendText.request) as unknown as LinqSendRequest), to: to as string };
}

/** The test-phone line's stand-in: it keeps each request and answers accepted, as the line's double does. */
function standInLine(): { send: (request: LinqSendRequest) => Promise<LinqAccepted>; got: string[] } {
  const got: string[] = [];
  return {
    got,
    send: (request) => {
      got.push(request.to);
      const accepted = structuredClone(sendText.outcome) as unknown as LinqAccepted;
      return Promise.resolve({ ...accepted, providerMessageId: "line-msg-t1449" });
    },
  };
}

/** The real sender's stand-in and a maker that counts each sender it makes; each part it gets is kept. */
function countingMaker(): {
  make: (env: LinqLineEnv) => { sendPart: (request: unknown) => Promise<LinqFailed> };
  made: LinqLineEnv[];
  got: unknown[];
} {
  const made: LinqLineEnv[] = [];
  const got: unknown[] = [];
  const answer: LinqFailed = {
    result: "failed",
    kind: "refused",
    httpStatus: null,
    code: null,
    reason: "the real sender's stand-in",
    retryAfterSeconds: null,
    providerMessageId: null,
  };
  return {
    made,
    got,
    make: (env) => {
      made.push(env);
      return {
        sendPart: (request) => {
          got.push(request);
          return Promise.resolve(answer);
        },
      };
    },
  };
}

describe("the switch (DL-940): the real line is on only where ENVIRONMENT is staging and STAGING_LINQ_LINE is exactly real", () => {
  it("staging and real: on, read ENVIRONMENT first, then the switch", () => {
    const line = counted({ ...LINE_ON });

    expect(realLinqLineOn(line.env)).toBe(true);
    expect(line.names).toEqual(["ENVIRONMENT", STAGING_LINQ_LINE]);
  });

  it.each(OFF_VALUES)("staging with the switch %s: off", (_name, value) => {
    const line = counted(withSwitch(value));

    expect(realLinqLineOn(line.env)).toBe(false);
    expect(line.names).toEqual(["ENVIRONMENT", STAGING_LINQ_LINE]);
  });

  it.each(["production", "test", "preview", "", "Staging", "staging "])(
    "ENVIRONMENT %j with the switch real: off, and the switch is never read",
    (environment) => {
      const line = counted({ ...LINE_ON, ENVIRONMENT: environment });

      expect(realLinqLineOn(line.env)).toBe(false);
      expect(line.names).toEqual(["ENVIRONMENT"]);
    },
  );
});

describe("who is a test phone: in the fiction range, off STAGING_LINQ_ALLOWLIST (read as T-416's guard reads it), and not ROSIE_NUMBER", () => {
  const list = (allowlist: unknown, rosie: unknown = ROSIE): CountedEnv =>
    counted({ STAGING_LINQ_ALLOWLIST: allowlist, ROSIE_NUMBER: rosie });

  it("a fiction-range number off the list is a test phone, any area code that is not toll-free; the list's own and Rosie's line are not", () => {
    const line = list(ROSTER_PHONE);

    for (const number of [TEST_PHONE, OTHER_AREA_TEST_PHONE, "+15555550100", "+15555550198"])
      expect(isTestPhone(line.env, number), number).toBe(true);
    expect(isTestPhone(line.env, ROSTER_PHONE)).toBe(false);
    expect(isTestPhone(line.env, ROSIE)).toBe(false);
    // Rosie's own line is never a test phone, on the list or not.
    expect(isTestPhone(list(`${ROSTER_PHONE},${ROSIE}`).env, ROSIE)).toBe(false);
  });

  it("a number written any other way is no test phone, and nothing is read for it", () => {
    const line = list(ROSTER_PHONE);
    const written: unknown[] = [
      "+1 555 555 0101",
      "+1-555-555-0101",
      "+1 (555) 555-0101",
      "15555550101",
      " +15555550101",
      "+15555550101 ",
      "+15555550101\n",
      "tel:+15555550101",
      "+15555550101,+15555550142",
      15555550101,
      null,
      undefined,
      { number: TEST_PHONE },
      [TEST_PHONE],
    ];

    for (const number of written) expect(isTestPhone(line.env, number), String(number)).toBe(false);
    expect(line.names).toEqual([]);
  });

  it("a list with several entries: each is a roster phone, and every other fiction-range number a test phone", () => {
    const line = list(`${ROSTER_PHONE},+15555550142,+12125550143`);

    expect(isTestPhone(line.env, "+15555550142")).toBe(false);
    expect(isTestPhone(line.env, "+12125550143")).toBe(false);
    expect(isTestPhone(line.env, ROSTER_PHONE)).toBe(false);
    expect(isTestPhone(line.env, TEST_PHONE)).toBe(true);
    expect(isTestPhone(line.env, "+12125550142")).toBe(true);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["not text", 15555550150],
  ])(
    "a list %s names no number: every fiction-range number but Rosie's line is a test phone",
    (_name, value) => {
      const line = list(value);

      expect(isTestPhone(line.env, TEST_PHONE)).toBe(true);
      expect(isTestPhone(line.env, ROSTER_PHONE)).toBe(true);
      expect(isTestPhone(line.env, ROSIE)).toBe(false);
    },
  );

  it.each([
    ["a space after an entry", `${ROSTER_PHONE} `],
    ["a space after the comma", `${ROSTER_PHONE}, +15555550142`],
    ["an empty entry at the end", `${ROSTER_PHONE},`],
    ["an empty entry at the start", `,${ROSTER_PHONE}`],
    ["another separator", `${ROSTER_PHONE};+15555550142`],
    ["an entry with spaces", "+1 555 555 0150"],
    ["a line break", `${ROSTER_PHONE}\n`],
  ])(
    "a list that cannot be read (%s): no number is taken for a test phone, as the guard refuses every send then",
    (_name, value) => {
      const line = list(value);

      for (const number of [TEST_PHONE, OTHER_AREA_TEST_PHONE, ROSTER_PHONE, "+15555550142"])
        expect(isTestPhone(line.env, number), number).toBe(false);
    },
  );

  it("reads the list, then Rosie's line, at each call: a changed list is the one the next call reads", () => {
    const values: Record<string, unknown> = { STAGING_LINQ_ALLOWLIST: ROSTER_PHONE, ROSIE_NUMBER: ROSIE };
    const line = counted(values);

    expect(isTestPhone(line.env, TEST_PHONE)).toBe(true);
    expect(line.names).toEqual(["STAGING_LINQ_ALLOWLIST", "ROSIE_NUMBER"]);
    values.STAGING_LINQ_ALLOWLIST = `${ROSTER_PHONE},${TEST_PHONE}`;
    expect(isTestPhone(line.env, TEST_PHONE)).toBe(false);
  });
});

describe("the send by recipient (./send.ts's linqSendCall), over stand-ins: nothing here reaches Linq", () => {
  it.each(OFF_VALUES)(
    "the switch %s: every part, a roster phone's too, goes to the test-phone line; the real sender is never made, and no name this card adds is read",
    async (_name, value) => {
      const line = counted(withSwitch(value));
      const testPhoneLine = standInLine();
      const maker = countingMaker();
      const send = linqLineSend(line.env, testPhoneLine.send, { realSender: maker.make });

      for (const to of [ROSTER_PHONE, TEST_PHONE, ROSIE, "+1 555 555 0150"]) {
        expect(await send(partTo(to))).toMatchObject({
          result: "accepted",
          providerMessageId: "line-msg-t1449",
        });
      }

      expect(testPhoneLine.got).toEqual([ROSTER_PHONE, TEST_PHONE, ROSIE, "+1 555 555 0150"]);
      expect(maker.made).toEqual([]);
      expect(maker.got).toEqual([]);
      expect(new Set(line.names)).toEqual(new Set(["ENVIRONMENT", STAGING_LINQ_LINE]));
      for (const name of NEW_NAMES) expect(line.names, name).not.toContain(name);
    },
  );

  it("production with the switch real: every part to the line, the switch never read", async () => {
    const line = counted({ ...LINE_ON, ENVIRONMENT: "production" });
    const testPhoneLine = standInLine();
    const maker = countingMaker();
    const send = linqLineSend(line.env, testPhoneLine.send, { realSender: maker.make });

    await send(partTo(ROSTER_PHONE));

    expect(testPhoneLine.got).toEqual([ROSTER_PHONE]);
    expect(maker.made).toEqual([]);
    expect(line.names).toEqual(["ENVIRONMENT"]);
  });

  it("the real line on: a test phone's part goes to the test-phone line; every other part to the real sender, made once, at its first part, over the Worker's env", async () => {
    const line = counted({ ...LINE_ON });
    const testPhoneLine = standInLine();
    const maker = countingMaker();

    const send = linqLineSend(line.env, testPhoneLine.send, { realSender: maker.make });
    // Nothing is read or made as it is built.
    expect(line.names).toEqual([]);
    expect(maker.made).toEqual([]);

    const toTestPhone = await send(partTo(TEST_PHONE));
    expect(toTestPhone).toMatchObject({ result: "accepted", providerMessageId: "line-msg-t1449" });
    expect(maker.made).toEqual([]);

    // The roster phone, Rosie's own line and an ill-formed `to`: each to the real sender (whose guard refuses the last two).
    const others = [ROSTER_PHONE, ROSIE, "+1 555 555 0150", "15555550150"];
    for (const to of others) {
      expect(await send(partTo(to))).toMatchObject({
        result: "failed",
        reason: "the real sender's stand-in",
      });
    }

    // Read at each part: the switch, then (for a number in the range) the list and Rosie's line; never a key or a secret
    // (the real sender's own reads are its stand-in's here).
    expect(new Set(line.names)).toEqual(
      new Set(["ENVIRONMENT", STAGING_LINQ_LINE, "STAGING_LINQ_ALLOWLIST", "ROSIE_NUMBER"]),
    );
    expect(testPhoneLine.got).toEqual([TEST_PHONE]);
    // One sender, made over the Worker's env itself (by identity: nothing of the env is read to compare it).
    expect(maker.made).toHaveLength(1);
    expect(maker.made[0]).toBe(line.env);
    expect(maker.got.map((request) => (request as LinqSendRequest).to)).toEqual(others);
    // The request goes to the real sender as it came.
    expect(maker.got[0]).toEqual(partTo(ROSTER_PHONE));
  });

  it("the switch is read at each part: turned off, the next part to a roster phone goes to the test-phone line", async () => {
    const values: Record<string, unknown> = { ...LINE_ON };
    const testPhoneLine = standInLine();
    const maker = countingMaker();
    const send = linqLineSend(counted(values).env, testPhoneLine.send, { realSender: maker.make });

    await send(partTo(ROSTER_PHONE));
    values[STAGING_LINQ_LINE] = "double";
    await send(partTo(ROSTER_PHONE));

    expect(maker.got).toHaveLength(1);
    expect(testPhoneLine.got).toEqual([ROSTER_PHONE]);
  });
});

describe("the Linq verify input the Worker's root is handed (../root.ts workerRoot)", () => {
  it("production: LINQ_WEBHOOK_SECRET alone, read at each call, and nothing read to make it but ENVIRONMENT", () => {
    const line = counted({ ...LINE_ON, ENVIRONMENT: "production" });

    const inputs = stagingLinqVerifyInputs(line.env);

    expect(Object.keys(inputs)).toEqual(["webhookSecret"]);
    expect(line.names).toEqual(["ENVIRONMENT"]);
    expect(inputs.webhookSecret()).toBe(LINQ_SECRET);
    expect(line.names).toEqual(["ENVIRONMENT", "LINQ_WEBHOOK_SECRET"]);
  });

  it.each(OFF_VALUES)(
    "staging with the switch %s: LINQ_WEBHOOK_SECRET alone, as before; nothing more read",
    (_name, value) => {
      const line = counted(withSwitch(value));

      const inputs = stagingLinqVerifyInputs(line.env);

      expect(Object.keys(inputs)).toEqual(["webhookSecret"]);
      expect(inputs.pageSecret).toBeUndefined();
      expect(line.names).toEqual(["ENVIRONMENT", STAGING_LINQ_LINE]);
      expect(inputs.webhookSecret()).toBe(LINQ_SECRET);
    },
  );

  it("the real line on: the test-phone page's own secret beside it, named, read at each call, which speaks for a test phone alone", () => {
    const values: Record<string, unknown> = { ...LINE_ON };
    const line = counted(values);

    const inputs = stagingLinqVerifyInputs(line.env);
    const page = inputs.pageSecret;
    if (page === undefined) throw new Error("the real line gave no page secret");

    expect(line.names).toEqual(["ENVIRONMENT", STAGING_LINQ_LINE]);
    expect(page.name).toBe(TEST_PHONE_WEBHOOK_SECRET);
    expect(inputs.webhookSecret()).toBe(LINQ_SECRET);
    expect(page.secret()).toBe(PAGE_SECRET);
    // Read at each call: a missing or non-text value is no secret.
    Reflect.deleteProperty(values, TEST_PHONE_WEBHOOK_SECRET);
    expect(page.secret()).toBeUndefined();
    values[TEST_PHONE_WEBHOOK_SECRET] = 12345;
    expect(page.secret()).toBeUndefined();

    expect(page.speaksFor({ kind: "phone", address: TEST_PHONE })).toBe(true);
    expect(page.speaksFor({ kind: "phone", address: OTHER_AREA_TEST_PHONE })).toBe(true);
    expect(page.speaksFor({ kind: "phone", address: ROSTER_PHONE })).toBe(false);
    expect(page.speaksFor({ kind: "phone", address: ROSIE })).toBe(false);
    expect(page.speaksFor({ kind: "email", address: TEST_PHONE })).toBe(false);
    expect(page.speaksFor({ kind: "email", address: "tester@example.com" })).toBe(false);
  });
});

// ---- T-1456: the real line's chat lookup ----------------------------------------------------------------------------------

/** The roster phone's chat on the real line, as Linq names it (made up): a thread of kind chat holds it. */
const KNOWN_CHAT = "linq-chat-t1456-roster";
/** The roster phone's handle in K-04 (made up). */
const ROSTER_HANDLE_ID = "hdl-t1456-roster";
/** A chat no thread holds yet: a receipt can arrive before its chat is written. */
const UNKNOWN_CHAT = "linq-chat-t1456-unknown";
/** A chat id a thread of kind email holds (threads_chat_or_email leaves linq_chat_id free there). */
const EMAIL_THREAD_CHAT = "linq-chat-t1456-email-thread";
/** A chat whose thread is of kind chat and whose handle is an email handle. */
const EMAIL_HANDLE_CHAT = "linq-chat-t1456-email-handle";
const EMAIL_HANDLE_ID = "hdl-t1456-email";
/** A test phone's chat, which the test-phone page's text names: never looked up. */
const TEST_PHONE_CHAT = "linq-chat-t1456-test-phone";
/** Every chat id these tests name: none may reach an error, a span or a log line. */
const CHAT_IDS = [KNOWN_CHAT, UNKNOWN_CHAT, EMAIL_THREAD_CHAT, EMAIL_HANDLE_CHAT, TEST_PHONE_CHAT];
/** Every number these tests name, in the forms a number could leak in. */
const NUMBER_FORMS = [ROSTER_PHONE, TEST_PHONE, ROSIE].flatMap((number) => [
  number,
  number.slice(1),
  number.slice(2),
  `${number.slice(5, 8)}-${number.slice(8)}`,
]);
const TRACE_ID = "4f1c2b7a-9d3e-4c5f-8a6b-1e2d3c4b5a69";

/**
 * A HYPERDRIVE_JOB stand-in: its presence is all the verify input reads, and reading its connection string fails the
 * test (that is the handle's to read, at each call).
 */
const JOB_STAND_IN = {
  get connectionString(): string {
    throw new Error("t1456: the verify input read HYPERDRIVE_JOB's connection string");
  },
};

/** LINE_ON with HYPERDRIVE_JOB bound: staging's real line as T-572 sets it, with the runtime side's binding present. */
const LINE_WITH_JOB: Readonly<Record<string, unknown>> = { ...LINE_ON, HYPERDRIVE_JOB: JOB_STAND_IN };

type Row = Record<string, unknown>;

/** One statement a read sent: its text with each bound value as $?, whitespace folded, and the values apart. */
interface Statement {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface ChatTables {
  /** postgres.js's client as db/repo calls it: a tagged template and reserve(), whose connection has unsafe and release. */
  readonly sql: Sql;
  /** Every statement sent, in order. */
  readonly statements: Statement[];
  /** How many reserved connections were let go. */
  released(): number;
}

/** readChatHandle's two reads (db/repo/threads.ts chatHandleIn), known by their table and key. */
const THREAD_BY_CHAT = /\bfrom threads where linq_chat_id = \$\?$/u;
const HANDLE_BY_ID = /\bfrom handles where id = \$\?$/u;

/**
 * PostgreSQL stood in for readChatHandle (db/repo/threads.ts, T-1259), so db/repo's own call runs: K-04 threads by
 * linq_chat_id and handles by id, from the rows made up below; every other statement (the transaction's own) answers no
 * rows. With `failRead`, the threads read throws it instead.
 */
function chatTables(failRead?: Error): ChatTables {
  const threads = new Map<string, Row>([
    [KNOWN_CHAT, { kind: "chat", handle_id: ROSTER_HANDLE_ID }],
    [EMAIL_THREAD_CHAT, { kind: "email", handle_id: ROSTER_HANDLE_ID }],
    [EMAIL_HANDLE_CHAT, { kind: "chat", handle_id: EMAIL_HANDLE_ID }],
  ]);
  const handles = new Map<string, Row>([
    [ROSTER_HANDLE_ID, { kind: "phone", address: ROSTER_PHONE }],
    [EMAIL_HANDLE_ID, { kind: "email", address: "tester@example.com" }],
  ]);
  const statements: Statement[] = [];
  let released = 0;
  const rowsOf = (table: ReadonlyMap<string, Row>, key: unknown): Row[] => {
    const row = typeof key === "string" ? table.get(key) : undefined;
    return row === undefined ? [] : [{ ...row }];
  };
  const query = (strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]> => {
    const text = strings.join("$?").replace(/\s+/gu, " ").trim();
    statements.push({ text, values });
    if (THREAD_BY_CHAT.test(text)) {
      return failRead === undefined ? Promise.resolve(rowsOf(threads, values[0])) : Promise.reject(failRead);
    }
    if (HANDLE_BY_ID.test(text)) return Promise.resolve(rowsOf(handles, values[0]));
    return Promise.resolve([]);
  };
  const reserved = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => query(strings, ...values),
    {
      unsafe: (text: string): Promise<Row[]> => {
        statements.push({ text, values: [] });
        return Promise.resolve([]);
      },
      release: (): void => {
        released += 1;
      },
    },
  );
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => query(strings, ...values),
    { reserve: () => Promise.resolve(reserved) },
  );
  return { sql: sql as unknown as Sql, statements, released: () => released };
}

/** One call the handle stand-in was asked for: its side and its name. */
interface HandleCall {
  readonly side: "runtime" | "toolApi";
  readonly call: string;
}

/** When the stand-in's connect and guard started, and their milliseconds (made up). */
const STEP = { at: "2026-11-18T05:00:00Z", ms: 1 };

interface LookupRig {
  /** The root's handle (./part.ts stagingDb) over the stand-in. */
  readonly db: StagingDb;
  readonly tables: ChatTables;
  /** Every call the handle was asked for, in order. */
  readonly calls: HandleCall[];
  /** Every line the handle wrote: each call's timing (./part.ts dbCallLine). */
  readonly written: string[];
}

/**
 * The root's handle (./part.ts stagingDb) over a stand-in for T-1254's handle (its `open` seam): each call is kept; then,
 * as T-1254's handle does once its guard has passed, the call's timing is handed over and its code runs, here on
 * chatTables. With `refuse`, a call fails with it before any code runs (a connect that fails).
 */
function lookupRig(options: { readonly failRead?: Error; readonly refuse?: Error } = {}): LookupRig {
  const tables = chatTables(options.failRead);
  const calls: HandleCall[] = [];
  const written: string[] = [];
  const open = (_env: StagingEnv, handleOptions: DbHandleOptions): DbHandle => {
    const run = <T>(side: HandleCall["side"], call: string, fn: (sql: Sql) => Promise<T>): Promise<T> => {
      calls.push({ side, call });
      if (options.refuse !== undefined) return Promise.reject(options.refuse);
      const timing: DbCallTiming = {
        call,
        side,
        binding: side === "runtime" ? "HYPERDRIVE_JOB" : "HYPERDRIVE_APP",
        login: side === "runtime" ? "rosie_worker_job" : "rosie_worker_app",
        connect: STEP,
        guard: STEP,
      };
      handleOptions.timing?.(timing);
      return fn(tables.sql);
    };
    return {
      runtime: (call, fn) => run("runtime", call, fn),
      toolApi: (call, fn) => run("toolApi", call, fn),
      counts: () => ({
        opened: calls.length,
        ended: calls.length,
        connectionsOpen: 0,
        connectionsPeak: calls.length === 0 ? 0 : 1,
        quietReads: 0,
        quietWrites: 0,
      }),
    };
  };
  const db = stagingDb({ ENVIRONMENT: "staging", GIT_SHA: "test-sha" } as unknown as StagingEnv, {
    open,
    write: (line) => written.push(line),
  });
  return { db, tables, calls, written };
}

/** The verify input's chat lookup on the real line, with the rig's handle and HYPERDRIVE_JOB bound. */
function boundLookup(rig: LookupRig): (chatId: string) => Promise<string | null> {
  const lookup = stagingLinqVerifyInputs(counted({ ...LINE_WITH_JOB }).env, rig.db).chatHandle;
  if (lookup === undefined) throw new Error("the real line bound no chat lookup");
  return (chatId) => Promise.resolve(lookup(chatId));
}

/** A serialization failure as postgres.js rejects a statement with it: transient (K-05). */
function serializationFailure(): Error {
  return Object.assign(new Error("could not serialize access due to concurrent update"), {
    name: "PostgresError",
    code: "40001",
    severity: "ERROR",
  });
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

/** No text given holds a chat id of these tests or a number in any form. */
function expectNoChatIdOrNumber(texts: readonly string[]): void {
  expect(texts.length).toBeGreaterThan(0);
  for (const text of texts) {
    for (const chatId of CHAT_IDS) expect(text.includes(chatId), "a text holds a chat id").toBe(false);
    for (const form of NUMBER_FORMS) expect(text.includes(form), "a text holds a number").toBe(false);
  }
}

describe("the real line's chat lookup (T-1456): db/repo's readChatHandle on the root's handle, bound only where the line is on, the handle handed and HYPERDRIVE_JOB bound", () => {
  it("bound: chatHandle beside the two secrets; making it reads ENVIRONMENT, the switch and HYPERDRIVE_JOB's presence alone, and asks the handle nothing", () => {
    const line = counted({ ...LINE_WITH_JOB });
    const rig = lookupRig();

    const inputs = stagingLinqVerifyInputs(line.env, rig.db);

    expect(Object.keys(inputs)).toEqual(["webhookSecret", "pageSecret", "chatHandle"]);
    expect(inputs.chatHandle).toBeTypeOf("function");
    expect(inputs.optionWords).toBeUndefined();
    expect(inputs.pageSecret?.name).toBe(TEST_PHONE_WEBHOOK_SECRET);
    expect(line.names).toEqual(["ENVIRONMENT", STAGING_LINQ_LINE, "HYPERDRIVE_JOB"]);
    expect(rig.calls).toEqual([]);
    expect(rig.written).toEqual([]);
  });

  it.each(OFF_VALUES)(
    "the switch %s, with the handle handed and HYPERDRIVE_JOB bound: no lookup, LINQ_WEBHOOK_SECRET alone as before, and HYPERDRIVE_JOB never read",
    (_name, value) => {
      const line = counted({ ...withSwitch(value), HYPERDRIVE_JOB: JOB_STAND_IN });
      const rig = lookupRig();

      const inputs = stagingLinqVerifyInputs(line.env, rig.db);

      expect(Object.keys(inputs)).toEqual(["webhookSecret"]);
      expect(line.names).toEqual(["ENVIRONMENT", STAGING_LINQ_LINE]);
      expect(rig.calls).toEqual([]);
    },
  );

  it("production with the switch real, the handle handed and HYPERDRIVE_JOB bound: no lookup, and nothing read but ENVIRONMENT", () => {
    const line = counted({ ...LINE_WITH_JOB, ENVIRONMENT: "production" });
    const rig = lookupRig();

    const inputs = stagingLinqVerifyInputs(line.env, rig.db);

    expect(Object.keys(inputs)).toEqual(["webhookSecret"]);
    expect(line.names).toEqual(["ENVIRONMENT"]);
    expect(rig.calls).toEqual([]);
  });

  it.each([
    ["absent", undefined],
    ["null", null],
  ])(
    "the real line on with HYPERDRIVE_JOB %s: the two secrets and no lookup, as a staging with no binding keeps every input null (DL-768)",
    (_name, value) => {
      const values: Record<string, unknown> = { ...LINE_WITH_JOB, HYPERDRIVE_JOB: value };
      if (value === undefined) Reflect.deleteProperty(values, "HYPERDRIVE_JOB");
      const line = counted(values);
      const rig = lookupRig();

      const inputs = stagingLinqVerifyInputs(line.env, rig.db);

      expect(Object.keys(inputs)).toEqual(["webhookSecret", "pageSecret"]);
      expect(line.names).toEqual(["ENVIRONMENT", STAGING_LINQ_LINE, "HYPERDRIVE_JOB"]);
      expect(rig.calls).toEqual([]);
    },
  );

  it("the real line on with no handle handed (main's call): the two secrets and no lookup, HYPERDRIVE_JOB not read", () => {
    const line = counted({ ...LINE_WITH_JOB });

    const inputs = stagingLinqVerifyInputs(line.env);

    expect(Object.keys(inputs)).toEqual(["webhookSecret", "pageSecret"]);
    expect(line.names).toEqual(["ENVIRONMENT", STAGING_LINQ_LINE]);
  });

  it("a known chat: one call on the runtime side named readChatHandle, db/repo's own read in one read-only transaction that writes nothing, answering the roster phone's number; the chat id only as the threads read's bound value; the call's timing line on no trace, holding no chat id or number", async () => {
    const rig = lookupRig();

    expect(await boundLookup(rig)(KNOWN_CHAT)).toBe(ROSTER_PHONE);

    expect(READ_CHAT_HANDLE_CALL).toBe("readChatHandle");
    expect(rig.calls).toEqual([{ side: "runtime", call: READ_CHAT_HANDLE_CALL }]);
    const texts = rig.tables.statements.map((statement) => statement.text);
    expect(texts.filter((text) => /^begin\b/u.test(text))).toEqual([
      "begin isolation level repeatable read read only",
    ]);
    expect(texts.filter((text) => /^(insert|update|delete|merge|truncate|copy)\b/iu.test(text))).toEqual([]);
    expect(texts.at(-1)).toBe("commit");
    expect(rig.tables.released()).toBe(1);
    const withChat = rig.tables.statements.filter((statement) => statement.values.includes(KNOWN_CHAT));
    expect(withChat.map((statement) => statement.text)).toEqual([expect.stringMatching(THREAD_BY_CHAT)]);
    for (const text of texts) expect(text.includes(KNOWN_CHAT)).toBe(false);
    expect(rig.written.map((line) => JSON.parse(line) as unknown)).toEqual([
      expect.objectContaining({
        msg: "dbCall",
        trace_id: null,
        call: READ_CHAT_HANDLE_CALL,
        side: "runtime",
        binding: "HYPERDRIVE_JOB",
        login: "rosie_worker_job",
      }),
    ]);
    expectNoChatIdOrNumber(rig.written);
  });

  it.each([
    ["an unknown chat (no thread holds it)", UNKNOWN_CHAT],
    ["a chat a thread of kind email holds", EMAIL_THREAD_CHAT],
    ["a chat whose handle is an email handle", EMAIL_HANDLE_CHAT],
  ])("%s: none (K-05 default 94), read once on the runtime side", async (_name, chatId) => {
    const rig = lookupRig();

    expect(await boundLookup(rig)(chatId)).toBeNull();
    expect(rig.calls).toEqual([{ side: "runtime", call: READ_CHAT_HANDLE_CALL }]);
  });

  it("a transient read (a serialization failure): none, the transaction rolled back", async () => {
    const rig = lookupRig({ failRead: serializationFailure() });

    expect(await boundLookup(rig)(KNOWN_CHAT)).toBeNull();
    expect(rig.tables.statements.map((statement) => statement.text)).toContain("rollback");
    expect(rig.calls).toEqual([{ side: "runtime", call: READ_CHAT_HANDLE_CALL }]);
  });

  it("a call that cannot be made (a connect that fails, its error naming a host and the statement's values): it rejects, scrubbed to the call's name and the client's code, with no chat id or host in it", async () => {
    const leaky = Object.assign(new Error(`connect ECONNREFUSED db.t1456.invalid:5432 (${KNOWN_CHAT})`), {
      code: "ECONNREFUSED",
      address: "db.t1456.invalid",
      port: 5432,
      query: "select kind, handle_id from threads where linq_chat_id = $1",
      parameters: [KNOWN_CHAT],
    });
    const rig = lookupRig({ refuse: leaky });

    const error = await rejectionOf(boundLookup(rig)(KNOWN_CHAT));

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ call: READ_CHAT_HANDLE_CALL, code: "ECONNREFUSED" });
    expect((error as Error).message.startsWith(`${READ_CHAT_HANDLE_CALL}: `)).toBe(true);
    for (const text of [(error as Error).message, (error as Error).stack ?? "", JSON.stringify(error)]) {
      expect(text.includes(KNOWN_CHAT), "the error holds the chat id").toBe(false);
      expect(text.includes("db.t1456.invalid"), "the error holds the host").toBe(false);
    }
    expect(rig.tables.statements).toEqual([]);
  });
});

// ---- T-1456: Linq's signed receipts through the gateway, on the real line ---------------------------------------------------

/** Where the gateway's Linq entry runs, as the root's route hands it. */
const WHERE = { environment: "staging", version: "test-sha" };
/** The key the roster phone's part was sent under (K-07 '<row>/<part>/<try>'), which its receipts echo. */
const PART_KEY = "out-t1456-roster-join/1/1";

type Json = Record<string, unknown>;

/** An instant to the whole second, as K-06 and the Linq double write one. */
const wholeSecond = (ms: number): string =>
  new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/[.][0-9]{3}Z$/u, "Z");

/**
 * A K-06 fixture's event as Linq's webhook for `sender` on `chatId`, received now on `clock`: its own kind, the eventId
 * given, and every time it holds made now (the Linq double signs it as received then, inside the 300 s window).
 */
function onChat(
  fixture: object,
  chatId: string,
  clock: TestClock,
  eventId: string,
  sender: string = ROSTER_PHONE,
): LinqInboundEvent {
  const at = wholeSecond(clock.now());
  const event = structuredClone(fixture) as LinqInboundEvent;
  return {
    ...event,
    eventId,
    handle: { kind: "phone", address: sender },
    chatId,
    receivedAt: at,
    sentAt: event.sentAt === null ? null : at,
    status: event.status === null ? null : { ...event.status, at },
    traceId: `trace-${eventId}`,
  };
}

/** delivered.json's receipt for the roster phone's part on `chatId`, as Linq signs it on the real line. */
function deliveredOn(chatId: string, secret: string, clock: TestClock): Promise<SignedWebhook> {
  return createLinqWebhookDouble({ secret }).sign({
    event: onChat(deliveredJson, chatId, clock, "evt-t1456-delivered-0001"),
    partKey: PART_KEY,
  });
}

/** The webhook as Linq posts it to {BASE_PATH}/webhooks/linq: the three headers and the raw body. */
function post(webhook: SignedWebhook): Request {
  return new Request("https://rosie.test/test/webhooks/linq", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": webhook.webhookId,
      "webhook-timestamp": webhook.timestamp,
      "webhook-signature": webhook.signature,
    },
    body: webhook.raw,
  });
}

interface GatewayOptions {
  /** false: the verify input with no handle handed, as main's workerRoot hands it. Default: the lookup rig's handle. */
  readonly handle?: boolean;
  /** What the lookup's threads read throws instead of answering. */
  readonly failRead?: Error;
}

interface GatewayRig {
  readonly root: Root;
  readonly fakes: SkeletonFakes;
  readonly clock: TestClock;
  readonly lookup: LookupRig;
  readonly linqSecret: string;
  readonly pageSecret: string;
  /** Every line written on console.log since the rig was made. */
  logged(): string[];
}

/**
 * The root ../linq.test.ts composes for the gateway (the test environment's fakes, the skeleton flag on, staging's vars),
 * with the Worker's own verify input on the real line: Linq's and the page's made-up secrets, HYPERDRIVE_JOB bound, and
 * the lookup rig's handle handed as workerRoot hands the root's own.
 */
function gatewayRig(options: GatewayOptions = {}): GatewayRig {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const linqSecret = testWebhookSecret();
  const pageSecret = testWebhookSecret();
  const env = counted({
    ...LINE_WITH_JOB,
    LINQ_WEBHOOK_SECRET: linqSecret,
    [TEST_PHONE_WEBHOOK_SECRET]: pageSecret,
  }).env;
  const lookup = lookupRig(options.failRead === undefined ? {} : { failRead: options.failRead });
  const clock = testClock();
  const fakes = skeletonFakes(clock);
  const root = composeRoot({
    environment: "test",
    sets: { fake: fakes.ports },
    actors: null,
    vars: { ENVIRONMENT: "staging", GIT_SHA: "test-sha" },
    clock,
    flags: fakeFlags([SKELETON_FLAG]),
    handleKey: fakes.handleKeys.call,
    chatOpenCall: fakes.dispatch.openChat,
    // The receipt door's store (T-562): a receipt that gets past the verify is marked here.
    outboxCalls: fakes.dispatch.outbox,
    sendStateCall: fakes.dispatch.sendState,
    linq: options.handle === false ? stagingLinqVerifyInputs(env) : stagingLinqVerifyInputs(env, lookup.db),
  });
  return {
    root,
    fakes,
    clock,
    lookup,
    linqSecret,
    pageSecret,
    logged: () => log.mock.calls.map(([line]) => String(line)),
  };
}

/** A receipt door that stores each receipt once, as the dispatcher's door answers a part it finds again: written, then duplicate. */
function receiptDoor(): ReceiptSink & { readonly accepted: ActorHandoff[] } {
  const seen = new Set<string>();
  const accepted: ActorHandoff[] = [];
  return {
    accepted,
    accept(handoff): Promise<StoreAnswer> {
      accepted.push(handoff);
      const answer: StoreAnswer = seen.has(handoff.event.eventId) ? "duplicate" : "written";
      seen.add(handoff.event.eventId);
      return Promise.resolve(answer);
    },
  };
}

/** The JSON lines among `lines` whose msg is this one, in order. */
function jsonLines(lines: readonly string[], msg: string): Json[] {
  const found: Json[] = [];
  for (const line of lines) {
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value === "object" && value !== null && (value as Json).msg === msg)
        found.push(value as Json);
    } catch {
      // Not a JSON line.
    }
  }
  return found;
}

const receiveSpans = (lines: readonly string[]): Json[] =>
  jsonLines(lines, "span").filter((span) => span.hop === "receive");

/** The webhooks that fail the lookup, each through the root's own route. */
const UNPLACED: readonly (readonly [string, string, GatewayOptions])[] = [
  ["an unknown chat (its receipt before its chat is written)", UNKNOWN_CHAT, {}],
  ["a transient read", KNOWN_CHAT, { failRead: serializationFailure() }],
];

/** sent.json's receipt for the roster phone's part on the known chat, on `service` (null: Linq reports none). */
function sentOn(service: "imessage" | "rcs" | "sms" | null, clock: TestClock): LinqInboundEvent {
  return { ...onChat(sentJson, KNOWN_CHAT, clock, `evt-t1465-sent-${service ?? "none"}-0001`), service };
}

/**
 * The sent receipts no one acts on by design (T-1465; DL-997 item 2): a message.sent that is no delivery receipt, on any
 * service but SMS, none reported included (../../clocks/due.ts isDeliveryReceipt; arch 02 step 9). The root's receipt
 * door answers each written with nothing marked, so the gateway answers 200 and Linq does not send it again. These are
 * what staging answered 503 after Rosie's first delivered reply (DL-978).
 */
const SENT_TAKEN: readonly (readonly [string, (clock: TestClock) => LinqInboundEvent])[] = [
  ["a message.sent on iMessage", (clock) => sentOn("imessage", clock)],
  ["a message.sent on RCS", (clock) => sentOn("rcs", clock)],
  ["a message.sent that reports no service", (clock) => sentOn(null, clock)],
];

/**
 * The receipts the root's receipt door still refuses (T-1465; DL-997 item 3), each with the label its refusal carries: a
 * failed receipt (the dispatcher's retry or next way, arch 02 step 8) and a sent one on SMS (SMS's delivery receipt,
 * which arms the clock, arch 02 step 9) are a part's news that must be acted on, and no door acts on them yet. Each stays
 * 503, so Linq's retry keeps it.
 */
const STILL_REFUSED: readonly (readonly [string, string, (clock: TestClock) => LinqInboundEvent])[] = [
  ["a message.sent on SMS", "smsSentReceiptNoDoor", (clock) => sentOn("sms", clock)],
  [
    "a message.failed",
    "failedReceiptNoDoor",
    (clock) => {
      const event = onChat(pollFailedJson, KNOWN_CHAT, clock, "evt-t1465-failed-0001");
      return {
        ...event,
        service: "imessage",
        status:
          event.status === null
            ? null
            : { ...event.status, failure: { code: "4006", reason: "message failed" } },
      };
    },
  ],
  [
    "a poll.failed",
    "failedReceiptNoDoor",
    (clock) => onChat(pollFailedJson, KNOWN_CHAT, clock, "evt-t1465-poll-failed-0001"),
  ],
];

describe("Linq's signed receipts through the gateway's Linq entry, with the root's verify on the real line (T-1456)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a known chat's message.delivered becomes its K-06 delivered event for the roster phone, handed to the receipt door with its part key, and is answered 200, written; the same receipt again is answered 200, duplicate; one lookup each", async () => {
    const rig = gatewayRig();
    const door = receiptDoor();
    const deps = { ...rig.root.gateway, receipts: door };
    const webhook = await deliveredOn(KNOWN_CHAT, rig.linqSecret, rig.clock);

    const first = await handleLinqWebhook(post(webhook), deps, WHERE);
    const again = await handleLinqWebhook(post(webhook), deps, WHERE);

    expect([first.status, again.status]).toEqual([200, 200]);
    expect(await first.json()).toEqual({ ok: true, trace_id: first.headers.get("x-trace-id") });
    expect(door.accepted).toHaveLength(2);
    expect(door.accepted[0]?.partKey).toBe(PART_KEY);
    expect(door.accepted[0]?.event).toMatchObject({
      eventId: "evt-t1456-delivered-0001",
      provider: "linq",
      kind: "delivered",
      handle: { kind: "phone", address: ROSTER_PHONE },
      chatId: KNOWN_CHAT,
      status: { messageId: deliveredJson.status.messageId, failure: null },
      fromRosie: false,
    });
    expect(receiveSpans(rig.logged()).map((span) => [span.outcome, span.decided])).toEqual([
      ["ok", { signatureValid: true, knownEventId: false, answered: 200 }],
      ["dropped", { signatureValid: true, knownEventId: true, answered: 200 }],
    ]);
    expect(rig.lookup.calls).toEqual([
      { side: "runtime", call: READ_CHAT_HANDLE_CALL },
      { side: "runtime", call: READ_CHAT_HANDLE_CALL },
    ]);
    expect(jsonLines(rig.logged(), "gateway_failed")).toEqual([]);
  });

  it("through the root's own Linq route and receipt door: the known chat's receipt is answered 200, and the door asks its store to mark the part delivered by the receipt's message id and key", async () => {
    const rig = gatewayRig();
    const webhook = await deliveredOn(KNOWN_CHAT, rig.linqSecret, rig.clock);

    const response = await rig.root.linqWebhook(post(webhook));

    expect(response.status).toBe(200);
    expect(rig.fakes.dispatch.partMarks.map((mark) => mark.request)).toEqual([
      expect.objectContaining({
        outcome: "delivered",
        providerMessageId: deliveredJson.status.messageId,
        idempotencyKey: PART_KEY,
      }),
    ]);
    expect(jsonLines(rig.logged(), "gateway_failed")).toEqual([]);
  });

  it.each(UNPLACED)(
    "%s: 503 through the root's route, nothing marked, the receive span failed verifyUnavailable, the failure line naming receiptHandleUnknown; no line holds a chat id or a number",
    async (_name, chatId, options) => {
      const rig = gatewayRig(options);
      const webhook = await deliveredOn(chatId, rig.linqSecret, rig.clock);

      const response = await rig.root.linqWebhook(post(webhook));

      expect(response.status).toBe(503);
      const traceId = response.headers.get("x-trace-id");
      expect(await response.json()).toEqual({ ok: false, error: "unavailable", trace_id: traceId });
      expect(rig.fakes.dispatch.partMarks).toEqual([]);
      expect(receiveSpans(rig.logged())).toEqual([
        expect.objectContaining({ trace_id: traceId, outcome: "failed", error_code: "verifyUnavailable" }),
      ]);
      expect(jsonLines(rig.logged(), "gateway_failed")).toEqual([
        {
          level: "error",
          msg: "gateway_failed",
          trace_id: traceId,
          stage: "verify",
          error: "LinqWebhookError",
          code: "receiptHandleUnknown",
        },
      ]);
      expect(rig.lookup.calls).toEqual([{ side: "runtime", call: READ_CHAT_HANDLE_CALL }]);
      expectNoChatIdOrNumber([...rig.logged(), ...rig.lookup.written]);
    },
  );

  it("on main (the verify input with no handle handed, as main's workerRoot hands it), the known chat's receipt is answered 503, receiptHandleUnknown, with nothing handed on and no read made", async () => {
    const rig = gatewayRig({ handle: false });
    const door = receiptDoor();
    const webhook = await deliveredOn(KNOWN_CHAT, rig.linqSecret, rig.clock);

    const response = await handleLinqWebhook(post(webhook), { ...rig.root.gateway, receipts: door }, WHERE);

    expect(response.status).toBe(503);
    expect(door.accepted).toEqual([]);
    expect(jsonLines(rig.logged(), "gateway_failed")).toEqual([
      expect.objectContaining({ stage: "verify", error: "LinqWebhookError", code: "receiptHandleUnknown" }),
    ]);
    expect(rig.lookup.calls).toEqual([]);
  });

  it.each([
    ["Rosie's own reaction (reaction-from-rosie.json)", reactionFromRosieJson, null, "reaction"],
    ["a sent receipt (sent.json)", sentJson, PART_KEY, "sent"],
    ["a failed poll (poll-failed.json)", pollFailedJson, null, "failed"],
  ])(
    "%s on the known chat: placed on the roster phone by one lookup",
    async (_name, fixture, partKey, kind) => {
      const rig = gatewayRig();
      const event = onChat(fixture, KNOWN_CHAT, rig.clock, `evt-t1456-${kind}-0001`);
      const webhook = await createLinqWebhookDouble({ secret: rig.linqSecret }).sign({ event, partKey });

      const answer = await rig.root.ports.linqVerify.verifyWebhook({
        ...webhook,
        receivedAt: rig.clock.utc(),
        traceId: TRACE_ID,
      });

      expect(answer).toMatchObject({
        result: "event",
        event: { kind, handle: { kind: "phone", address: ROSTER_PHONE }, chatId: KNOWN_CHAT },
      });
      expect(rig.lookup.calls).toEqual([{ side: "runtime", call: READ_CHAT_HANDLE_CALL }]);
    },
  );

  it.each(SENT_TAKEN)(
    "T-1465, %s on the known chat, through the root's own route: placed by one lookup, then answered 200 by the root's receipt door, written with nothing marked; Linq's repeat is answered 200 the same way",
    async (_name, eventOf) => {
      const rig = gatewayRig();
      const event = eventOf(rig.clock);
      const webhook = await createLinqWebhookDouble({ secret: rig.linqSecret }).sign({
        event,
        partKey: PART_KEY,
      });

      const response = await rig.root.linqWebhook(post(webhook));
      const again = await rig.root.linqWebhook(post(webhook));

      expect([response.status, again.status]).toEqual([200, 200]);
      const traceId = response.headers.get("x-trace-id");
      expect(await response.json()).toEqual({ ok: true, trace_id: traceId });
      // The chat was placed each time: the verify's one read answered the roster phone, and the event reached the door.
      expect(rig.lookup.calls).toEqual([
        { side: "runtime", call: READ_CHAT_HANDLE_CALL },
        { side: "runtime", call: READ_CHAT_HANDLE_CALL },
      ]);
      // The receive span names the kind (and the service, where Linq reports one): a receipt, so not sealed to an actor.
      const got = event.service === null ? { kind: "sent" } : { kind: "sent", service: event.service };
      const taken = {
        outcome: "ok",
        error_code: null,
        got,
        decided: { signatureValid: true, knownEventId: false, answered: 200 },
      };
      expect(receiveSpans(rig.logged())).toEqual([
        expect.objectContaining({ ...taken, trace_id: traceId }),
        expect.objectContaining({ ...taken, trace_id: again.headers.get("x-trace-id") }),
      ]);
      // Acted on by no one: the door's store is asked nothing, so no part is marked, and nothing failed.
      expect(rig.fakes.dispatch.partMarks).toEqual([]);
      expect(jsonLines(rig.logged(), "gateway_failed")).toEqual([]);
      expectNoChatIdOrNumber([...rig.logged(), ...rig.lookup.written]);
    },
  );

  it.each(STILL_REFUSED)(
    "T-1465, %s on the known chat, through the root's own route: placed by one lookup, then still refused by the root's receipt door (503), the failure line naming its kind and the refusal %s",
    async (_name, refusal, eventOf) => {
      const rig = gatewayRig();
      const event = eventOf(rig.clock);
      const webhook = await createLinqWebhookDouble({ secret: rig.linqSecret }).sign({
        event,
        partKey: event.kind === "sent" ? PART_KEY : null,
      });

      const response = await rig.root.linqWebhook(post(webhook));

      expect(response.status).toBe(503);
      const traceId = response.headers.get("x-trace-id");
      expect(await response.json()).toEqual({ ok: false, error: "unavailable", trace_id: traceId });
      // The chat was placed: the verify's one read answered the roster phone, and the event reached the hand-off.
      expect(rig.lookup.calls).toEqual([{ side: "runtime", call: READ_CHAT_HANDLE_CALL }]);
      // The receive span names the kind (and the service, where Linq reports one) beside handoffFailed.
      expect(receiveSpans(rig.logged())).toEqual([
        expect.objectContaining({
          trace_id: traceId,
          outcome: "failed",
          error_code: "handoffFailed",
          got: event.service === null ? { kind: event.kind } : { kind: event.kind, service: event.service },
          decided: { signatureValid: true, answered: 503 },
        }),
      ]);
      // The refusal is the root's receipt door's own (../root.ts deliveredStatusOf), thrown before its store is asked
      // anything: the handle's actor is never reached, and nothing is marked. The failure line names the event's kind and
      // the refusal's label, each from its closed list, and no chat id, number or field value.
      expect(jsonLines(rig.logged(), "gateway_failed")).toEqual([
        {
          level: "error",
          msg: "gateway_failed",
          trace_id: traceId,
          stage: "handoff",
          error: "WiringError",
          kind: event.kind,
          refusal,
        },
      ]);
      expect(rig.fakes.dispatch.partMarks).toEqual([]);
      expectNoChatIdOrNumber([...rig.logged(), ...rig.lookup.written]);
    },
  );

  it("unchanged: the test-phone page's own text from a test phone verifies to its event and from the roster phone stays badSignature (401); Linq's message.received from the roster phone verifies to its event; none asks the lookup", async () => {
    const rig = gatewayRig();
    const page = createLinqWebhookDouble({ secret: rig.pageSecret });
    const linq = createLinqWebhookDouble({ secret: rig.linqSecret });
    const verify = (webhook: SignedWebhook): Promise<unknown> =>
      rig.root.ports.linqVerify.verifyWebhook({ ...webhook, receivedAt: rig.clock.utc(), traceId: TRACE_ID });
    const text = (eventId: string, sender: string, chatId: string): LinqInboundEvent =>
      onChat(textJson, chatId, rig.clock, eventId, sender);

    const pageFromTestPhone = await verify(
      await page.sign({ event: text("evt-t1456-page-0001", TEST_PHONE, TEST_PHONE_CHAT), partKey: null }),
    );
    const pageFromRoster = await verify(
      await page.sign({ event: text("evt-t1456-page-0002", ROSTER_PHONE, KNOWN_CHAT), partKey: null }),
    );
    const linqFromRoster = await verify(
      await linq.sign({ event: text("evt-t1456-text-0001", ROSTER_PHONE, KNOWN_CHAT), partKey: null }),
    );

    expect(pageFromTestPhone).toMatchObject({
      result: "event",
      httpStatus: 200,
      partKey: null,
      event: { kind: "text", handle: { kind: "phone", address: TEST_PHONE }, chatId: TEST_PHONE_CHAT },
    });
    expect(pageFromRoster).toEqual({ result: "rejected", httpStatus: 401, reason: "badSignature" });
    expect(linqFromRoster).toMatchObject({
      result: "event",
      httpStatus: 200,
      event: { kind: "text", handle: { kind: "phone", address: ROSTER_PHONE }, chatId: KNOWN_CHAT },
    });
    expect(rig.lookup.calls).toEqual([]);
  });
});
