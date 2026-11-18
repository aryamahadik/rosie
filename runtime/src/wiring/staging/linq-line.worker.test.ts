// T-1449 (DL-940; D-018): staging's real Linq line beside the test-phone line, inside the Workers runtime with
// wrangler.jsonc's staging environment. Its sends go through ./send.ts's linqSendCall as stagingSendCalls binds it (the
// all-or-nothing rule's two bindings present: the pool's TestPhoneLine, and a HYPERDRIVE_JOB stand-in whose connection
// string is never read, since a send reads no database), and through the root's Linq send port (../real.ts realLinqSend
// and linqAnswerOf, the port the dispatcher sends each part through). Linq's API is stood in for with claimHost
// (runtime/test/outbound.ts), so every request the real sender makes is answered in this isolate and none leaves; any
// other host would trip the pool's outbound tripwire and fail the test.
//
//   - the real line on (ENVIRONMENT staging, STAGING_LINQ_LINE "real", STAGING_LINQ_ALLOWLIST holding the roster phone
//     +15555550150): a part to the test phone +15555550101 (send-text.json's own) goes to the test-phone line and is
//     recorded there, and Linq's stand-in gets nothing; a part to the roster phone goes through T-414's sender behind
//     T-416's guard, Linq's stand-in gets exactly one send request, and the part is answered accepted from Linq's recorded
//     answer (vendor-samples/send-message-response.json, send-text.json's own outcome); an ill-formed `to` and
//     ROSIE_NUMBER's value are refused by the guard before any request, as is the roster phone's part while
//     LINQ_API_TOKEN or ROSIE_NUMBER is missing, and every part while the list cannot be read; with no list at all, a
//     fiction-range number is a test phone (the line) and any other `to` is refused (rosterMissing);
//   - the switch absent, "double" or "": every part, the roster phone's too, goes to the test-phone line, Linq's stand-in
//     gets nothing, and no name this card adds is read (./linq-line.test.ts shows the real sender is never made);
//   - the test-phone page's send, signed by the page's own signer, through the Worker's page route, with the real line on
//     (../test-phone.worker.test.ts's first case, run on this card's verify input): the gateway verifies it under the
//     page's own secret and hands it to tp-04's actor; with tp-04's number on the list it is answered 401 and reaches no
//     actor; with the page's secret missing the page answers 503 and nothing is posted;
//   - no key, secret or number in any log line, span or answer.
//   - T-1456: the Worker's own root (workerRoot) on the real line, with T-1254's handle as the Worker makes it: a signed
//     Linq receipt's verify asks the root's handle for its chat on the runtime side (HYPERDRIVE_JOB's connection string
//     read once, HYPERDRIVE_APP's never; both stand-ins fail that read, so no database or host is reached) and, with no
//     answer, the receipt is not placed: the gateway answers 503 and its failure line names receiptHandleUnknown; a
//     message.received asks nothing; no line holds the chat id.
// Test values only (rule 9): K-11's and K-21's fixtures and vendor samples, whole fiction-range numbers (555-01xx), a
// made-up key and made-up secrets.
import { createLinqWebhookDouble } from "@rosie/adapters/linq/double-webhooks";
import deliveredJson from "@rosie/contracts/inbound-event/fixtures/delivered.json";
import textJson from "@rosie/contracts/inbound-event/fixtures/text-imessage.json";
import testPhoneSendJson from "@rosie/contracts/page-api/fixtures/test-phone-send.json";
import sendText from "@rosie/contracts/port-linq/fixtures/send-text.json";
import sendMessageResponse from "@rosie/contracts/port-linq/vendor-samples/send-message-response.json";
import {
  sha256Hex,
  type PhoneStates,
  type RosterPhone,
  type TestPhoneRoster,
  type TesterAccess,
} from "@rosie/actions/src/page-calls/staging/test-phone/index";
import { REASONS as GUARD_REASONS } from "@rosie/adapters/linq/roster";
import { LINQ_API_BASE, LINQ_API_TOKEN } from "@rosie/adapters/linq/send";
import { createExecutionContext, reset, runInDurableObject } from "cloudflare:test";
import { env as poolEnv, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { claimHost } from "../../../test/outbound";
import type { HandleActor } from "../../actor";
import type { LinqSendRequest } from "../../dispatch/types";
import { actorNameOf, handleLinqWebhook, pagePathOf } from "../../gateway";
import { createWorker } from "../../index";
import {
  composeRoot,
  lineLinqSend,
  LINQ_WEBHOOK_SECRET,
  SKELETON_FLAG,
  testPhoneLineOf,
  workerRoot,
  type HandleActors,
  type LinqSendCall,
  type Root,
} from "../index";
import {
  fakeFlags,
  skeletonFakes,
  testWebhookSecret,
  withSamPhoneRow,
  type LinqInboundEvent,
  type SignedWebhook,
} from "../test-support";
import {
  REAL_LINQ_LINE,
  STAGING_LINQ_LINE,
  stagingLinqVerifyInputs,
  TEST_PHONE_WEBHOOK_SECRET,
} from "./linq-line";
import type { StagingDb, StagingEnv } from "./part";
import { stagingSendCalls } from "./send";

type Json = Record<string, unknown>;

/** A run through the Workers runtime's own steps: a resource guard above Vitest's 5 s default, as the root's tests have. */
const TEST_MS = 30_000;

/** The roster phone: on STAGING_LINQ_ALLOWLIST (a fiction number here, standing in for the user's own iPhone). */
const ROSTER_PHONE = "+15555550150";
/** A test phone: send-text.json's own `to`, in the fiction range and off the list. */
const TEST_PHONE = sendText.request.to;
/** K-21 test-roster.json's tp-04, the number testPhoneSend signs as (the second customer: 555-0104). */
const TP_04_NUMBER = "+15555550104";
/** Rosie's own line for these tests (the Linq double's made-up line). */
const ROSIE = "+15555550199";
/** A made-up Linq key, letters only, so no other pattern a scan knows hides it. */
const FAKE_KEY = "fakeLinqKeyTOneFourFourNineLettersOnly";
/** Linq's API host, the one the real sender sends to (adapters/src/linq/send/wire.ts). */
const LINQ_HOST = new URL(LINQ_API_BASE).host;
/** Every name this card adds; none is read while the line is off. */
const NEW_NAMES = ["STAGING_LINQ_ALLOWLIST", "ROSIE_NUMBER", LINQ_API_TOKEN, TEST_PHONE_WEBHOOK_SECRET];

/** Every number these tests hold, each in the forms a number could leak in. */
const NUMBER_FORMS = [ROSTER_PHONE, TEST_PHONE, TP_04_NUMBER, ROSIE].flatMap((number) => [
  number,
  number.slice(1),
  number.slice(2),
  `${number.slice(5, 8)}-${number.slice(8)}`,
]);

// ---- what each test logs ------------------------------------------------------------------------------------------------

let logged: string[] = [];

beforeEach(() => {
  logged = [];
  const keep = (...args: unknown[]): void => {
    logged.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(keep);
  vi.spyOn(console, "warn").mockImplementation(keep);
  vi.spyOn(console, "error").mockImplementation(keep);
});

afterEach(async () => {
  vi.restoreAllMocks();
  // The line and the actors keep what a test recorded in their own storage: each test starts from none.
  await reset();
});

/** The JSON lines among the test's log lines whose `msg` is this one, in order. */
function linesOf(msg: string): Json[] {
  const found: Json[] = [];
  for (const line of logged) {
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

/** No log line of the test, and no text given, holds the key, a secret or any number of these tests. */
function expectNothingLeaked(secrets: readonly string[], ...texts: readonly string[]): void {
  const all = [...logged, ...texts];
  expect(all.length).toBeGreaterThan(0);
  for (const text of all) {
    for (const value of [FAKE_KEY, ...secrets, ...secrets.map((secret) => secret.slice("whsec_".length))])
      expect(text.includes(value), "a text holds the key or a secret").toBe(false);
    for (const form of NUMBER_FORMS) expect(text.includes(form), "a text holds a number").toBe(false);
  }
}

// ---- the env a send is bound over ---------------------------------------------------------------------------------------

/** The pool's TestPhoneLine namespace (env.staging's TEST_PHONE_LINE binding). */
function poolLine(): DurableObjectNamespace {
  const namespace = poolEnv.TEST_PHONE_LINE;
  if (namespace === undefined) throw new Error("env.staging binds no TEST_PHONE_LINE");
  return namespace as unknown as DurableObjectNamespace;
}

/** The parts the line recorded to a number, read from its own storage. */
function lineParts(number: string): Promise<{ sent: Json }[]> {
  return testPhoneLineOf(poolLine()).partsTo(number) as unknown as Promise<{ sent: Json }[]>;
}

interface SendEnv {
  readonly env: StagingEnv;
  /** Every name read from the env, by a get or by an `in`, in order. */
  readonly names: string[];
}

/**
 * Staging's env with the real line on (or as `changes` say: undefined leaves a name out): the pool's line, a
 * HYPERDRIVE_JOB stand-in whose connection string fails the test if anything reads it, the roster phone on the list,
 * Rosie's line and the made-up key; each read counted.
 */
function sendEnv(changes: Json = {}): SendEnv {
  const values: Json = {
    ENVIRONMENT: "staging",
    BASE_PATH: "/test",
    DB_SCHEMA: "",
    HYPERDRIVE_JOB: {
      get connectionString(): string {
        throw new Error("t1449: a send read HYPERDRIVE_JOB's connection string");
      },
    },
    TEST_PHONE_LINE: poolLine(),
    [STAGING_LINQ_LINE]: REAL_LINQ_LINE,
    STAGING_LINQ_ALLOWLIST: ROSTER_PHONE,
    ROSIE_NUMBER: ROSIE,
    [LINQ_API_TOKEN]: FAKE_KEY,
    ...changes,
  };
  for (const [name, value] of Object.entries(changes))
    if (value === undefined) Reflect.deleteProperty(values, name);
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
  return { env: env as unknown as StagingEnv, names };
}

/** The root's handle, never called: a part's send reads no database. */
const NO_DB: StagingDb = {
  runtime: () => Promise.reject(new Error("t1449: a send made a database call")),
  toolApi: () => Promise.reject(new Error("t1449: a send made a database call")),
  counts: () => ({
    opened: 0,
    ended: 0,
    connectionsOpen: 0,
    connectionsPeak: 0,
    quietReads: 0,
    quietWrites: 0,
  }),
};

/** ./send.ts's linqSendCall over `env`, bound as stagingSendCalls binds it, and the root's Linq send port over it. */
function sendsOver(env: StagingEnv): { call: LinqSendCall; port: Root["ports"]["linqSend"]["parts"] } {
  const { linqSendCall } = stagingSendCalls({ env, db: NO_DB });
  if (linqSendCall === null) throw new Error("the send is not bound with both bindings present");
  const root = composeRoot({
    environment: "staging",
    actors: null,
    vars: { ENVIRONMENT: "staging", GIT_SHA: "test-sha" },
    linqSendCall,
  });
  return { call: linqSendCall, port: root.ports.linqSend.parts };
}

/** send-text.json's request (K-11 v1 sendPart, the dispatcher's kinds) to `to`, under a key of its own. */
function partTo(to: string, key = sendText.request.idempotencyKey): LinqSendRequest {
  return { ...(structuredClone(sendText.request) as unknown as LinqSendRequest), to, idempotencyKey: key };
}

interface LinqRequest {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly body: Json;
}

/** Linq's API, stood in for in this test (claimHost): each request is kept, and answered with Linq's recorded answer. */
function standInLinq(): LinqRequest[] {
  const requests: LinqRequest[] = [];
  claimHost(LINQ_HOST, async (request) => {
    requests.push({
      url: request.url,
      method: request.method,
      authorization: request.headers.get("authorization"),
      body: await request.json<Json>(),
    });
    return new Response(JSON.stringify(sendMessageResponse), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  });
  return requests;
}

/** A failed K-11 answer the guard or the sender gave before any request: refused, no status, no code. */
const refusedWith = (reason: string): Json => ({
  result: "failed",
  kind: "refused",
  httpStatus: null,
  code: null,
  reason,
  retryAfterSeconds: null,
  providerMessageId: null,
});

// ---- the sends ----------------------------------------------------------------------------------------------------------

describe("sends with the real line on (STAGING_LINQ_LINE real, STAGING_LINQ_ALLOWLIST holding +15555550150)", () => {
  it("a part to the test phone +15555550101 goes to the test-phone line and is recorded there; Linq's stand-in gets nothing", async () => {
    const linq = standInLinq();
    const { port } = sendsOver(sendEnv().env);

    const answer = await port.sendPart(partTo(TEST_PHONE));

    expect(answer).toMatchObject({
      result: "accepted",
      chatId: sendText.request.chatId,
      service: "imessage",
    });
    const recorded = await lineParts(TEST_PHONE);
    expect(recorded.map((part) => part.sent.idempotencyKey)).toEqual([sendText.request.idempotencyKey]);
    expect(recorded[0]?.sent).toMatchObject({ to: TEST_PHONE, text: sendText.request.text });
    expect(linq).toEqual([]);
    expectNothingLeaked([], JSON.stringify(answer));
  });

  it("a part to the roster phone goes through T-414's sender behind T-416's guard: Linq's stand-in gets exactly one send request, the key only in its bearer, and the root's Linq send port answers accepted from Linq's recorded answer; the line records nothing", async () => {
    const linq = standInLinq();
    const { port } = sendsOver(sendEnv().env);

    const answer = await port.sendPart(partTo(ROSTER_PHONE));

    // Linq's recorded answer (send-message-response.json) read through the adapter and ../real.ts linqAnswerOf: exactly
    // send-text.json's own outcome, the answer the dispatcher marks the part from.
    expect(answer).toEqual(sendText.outcome);
    expect(linq).toHaveLength(1);
    const [request] = linq;
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe(`${LINQ_API_BASE}/chats/${sendText.request.chatId}/messages`);
    expect(request?.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(request?.body).toMatchObject({
      message: {
        parts: [{ type: "text", value: sendText.request.text }],
        idempotency_key: sendText.request.idempotencyKey,
      },
    });
    expect(JSON.stringify(request?.body)).not.toContain(FAKE_KEY);
    expect(await lineParts(ROSTER_PHONE)).toEqual([]);
    expect(await lineParts(TEST_PHONE)).toEqual([]);
    expectNothingLeaked([], JSON.stringify(answer));
  });

  it("an ill-formed `to` and ROSIE_NUMBER's value are refused by the guard before any request, each logged with at most its last 2 digits; nothing reaches the line", async () => {
    const linq = standInLinq();
    const { call, port } = sendsOver(sendEnv().env);

    const illFormed = await port.sendPart(partTo("+1 555 555 0150", "out-t1449-ill-formed/1/1"));
    const ownLine = await port.sendPart(partTo(ROSIE, "out-t1449-own-line/1/1"));
    // The same through the binding itself, before the root's port reads the answer.
    const direct = await call(partTo("15555550150", "out-t1449-no-plus/1/1"));

    expect(illFormed).toEqual(refusedWith(GUARD_REASONS.notE164));
    expect(ownLine).toEqual(refusedWith(GUARD_REASONS.ownLine));
    expect(direct).toEqual(refusedWith(GUARD_REASONS.notE164));
    expect(linq).toEqual([]);
    expect(linesOf("linqRosterRefused").map((line) => [line.why, line.destination])).toEqual([
      ["notE164", "***50"],
      ["ownLine", "***99"],
      ["notE164", "***50"],
    ]);
    expect(await lineParts(ROSIE)).toEqual([]);
    expectNothingLeaked([], JSON.stringify([illFormed, ownLine, direct]));
  });

  it.each([
    [
      "LINQ_API_TOKEN missing",
      { [LINQ_API_TOKEN]: undefined },
      `${LINQ_API_TOKEN} is not set: nothing was sent.`,
    ],
    ["LINQ_API_TOKEN blank", { [LINQ_API_TOKEN]: "" }, `${LINQ_API_TOKEN} is not set: nothing was sent.`],
    ["ROSIE_NUMBER missing", { ROSIE_NUMBER: undefined }, GUARD_REASONS.lineUnknown],
  ])(
    "%s: the roster phone's part is refused before any request, the name named alone",
    async (_name, changes, reason) => {
      const linq = standInLinq();
      const { port } = sendsOver(sendEnv(changes).env);

      const answer = await port.sendPart(partTo(ROSTER_PHONE));

      expect(answer).toEqual(refusedWith(reason));
      expect(linq).toEqual([]);
      expect(await lineParts(ROSTER_PHONE)).toEqual([]);
      expectNothingLeaked([], JSON.stringify(answer));
    },
  );

  it("STAGING_LINQ_ALLOWLIST missing names no number: a fiction-range number is then a test phone and goes to the line, and any other `to` is refused by the guard (rosterMissing) before any request", async () => {
    const linq = standInLinq();
    const { port } = sendsOver(sendEnv({ STAGING_LINQ_ALLOWLIST: undefined }).env);

    const toFiction = await port.sendPart(partTo(ROSTER_PHONE));
    const toOther = await port.sendPart(partTo("+1 555 555 0150", "out-t1449-ill-formed/1/1"));

    expect(toFiction).toMatchObject({ result: "accepted" });
    expect(await lineParts(ROSTER_PHONE)).toHaveLength(1);
    expect(toOther).toEqual(refusedWith(GUARD_REASONS.rosterMissing));
    expect(linq).toEqual([]);
    expectNothingLeaked([], JSON.stringify([toFiction, toOther]));
  });

  it("a list that cannot be read (a space after the comma): the guard refuses the roster phone, and no number is taken for a test phone, so the test phone's part is refused too and nothing reaches the line or Linq", async () => {
    const linq = standInLinq();
    const { port } = sendsOver(sendEnv({ STAGING_LINQ_ALLOWLIST: `${ROSTER_PHONE}, +15555550142` }).env);

    const toRoster = await port.sendPart(partTo(ROSTER_PHONE));
    const toTestPhone = await port.sendPart(partTo(TEST_PHONE, "out-t1449-test-phone/1/1"));

    for (const answer of [toRoster, toTestPhone]) {
      expect(answer).toMatchObject({ result: "failed", kind: "refused", httpStatus: null, code: null });
      if (answer.result !== "failed") throw new Error("the part was not refused");
      expect(answer.reason).toMatch(/^STAGING_LINQ_ALLOWLIST: entry 2 of 2 is not an E\.164 number/u);
    }
    expect(linq).toEqual([]);
    expect(await lineParts(TEST_PHONE)).toEqual([]);
    expectNothingLeaked([], JSON.stringify([toRoster, toTestPhone]));
  });
});

describe("sends with the real line off: every path as before", () => {
  it.each([
    ["absent", undefined],
    ['"double"', "double"],
    ['""', ""],
  ])(
    "STAGING_LINQ_LINE %s: a part to the roster phone, as every part, goes to the test-phone line; Linq's stand-in gets nothing, and no name this card adds is read",
    async (_name, value) => {
      const linq = standInLinq();
      const { env, names } = sendEnv({ [STAGING_LINQ_LINE]: value });
      const { port } = sendsOver(env);

      const toRoster = await port.sendPart(partTo(ROSTER_PHONE));
      const toRosie = await port.sendPart(partTo(ROSIE, "out-t1449-own-line/1/1"));

      for (const answer of [toRoster, toRosie]) expect(answer).toMatchObject({ result: "accepted" });
      expect((await lineParts(ROSTER_PHONE)).map((part) => part.sent.idempotencyKey)).toEqual([
        sendText.request.idempotencyKey,
      ]);
      expect(await lineParts(ROSIE)).toHaveLength(1);
      expect(linq).toEqual([]);
      // As the part is built: ENVIRONMENT and the two bindings' presence (T-1401); at each send: the switch and the line.
      expect(new Set(names)).toEqual(
        new Set(["ENVIRONMENT", "HYPERDRIVE_JOB", "TEST_PHONE_LINE", STAGING_LINQ_LINE]),
      );
      for (const name of NEW_NAMES) expect(names, name).not.toContain(name);
      expect(linesOf("linqRosterRefused")).toEqual([]);
    },
  );

  it("with the real line on, the same part to the roster phone reads the guard's names and the key, and goes to Linq, never the line (the contrast)", async () => {
    const linq = standInLinq();
    const { env, names } = sendEnv();

    await sendsOver(env).port.sendPart(partTo(ROSTER_PHONE));

    expect(linq).toHaveLength(1);
    expect(names).toEqual(expect.arrayContaining(["STAGING_LINQ_ALLOWLIST", "ROSIE_NUMBER", LINQ_API_TOKEN]));
    expect(names).not.toContain(TEST_PHONE_WEBHOOK_SECRET);
    expect(await lineParts(ROSTER_PHONE)).toEqual([]);
  });
});

// ---- the test-phone page's send, with the real line on ------------------------------------------------------------------

type ActorNamespace = DurableObjectNamespace<HandleActor>;

function actorNamespace(): ActorNamespace {
  return (exports as unknown as { HandleActor: ActorNamespace }).HandleActor;
}

/** The HandleActor namespace as the root takes it. */
function handleActors(): HandleActors<DurableObjectId> {
  const ns = actorNamespace();
  return { idFromName: (name) => ns.idFromName(name), get: (id) => ns.get(id) };
}

function actorOf(actorName: string): DurableObjectStub<HandleActor> {
  return actorNamespace().get(actorNamespace().idFromName(actorName));
}

const TOKEN = testPhoneSendJson.request.page.sessionToken;
const TP_04_ACTOR = actorNameOf({ kind: "phone", address: TP_04_NUMBER });

/** The page's session, roster and phone reads: the fixture's token a tester's, tp-04 its roster phone. */
async function pageReads(): Promise<{ access: TesterAccess; roster: TestPhoneRoster; phones: PhoneStates }> {
  const tester = await sha256Hex(TOKEN);
  const tp04: RosterPhone = { testPhoneId: "tp-04", number: TP_04_NUMBER, email: null };
  return {
    access: { standing: (hash) => Promise.resolve(hash === tester ? "tester" : "noSession") },
    roster: { phone: (testPhoneId) => Promise.resolve(testPhoneId === "tp-04" ? tp04 : null) },
    phones: {
      state: () => Promise.resolve({ chatOpen: true, stopped: false, stoppedAt: null, chatLink: null }),
    },
  };
}

interface PageRun {
  readonly root: Root;
  /** testPhoneSend through the Worker's own page route, with test-phone-send.json's request. */
  send(): Promise<{ status: number; outcome: Json; traceId: string }>;
  restore(): void;
}

/**
 * The root ../test-phone.worker.test.ts's rig composes (the test environment's fakes, the HandleActor namespace, the
 * skeleton flag on, staging's vars and test-phone line), with this card's verify input over `lineValues` in place of the
 * fakes' one secret: Linq's made-up secret and the page's own beside it.
 */
async function pageRig(lineValues: Json): Promise<PageRun> {
  const fakes = withSamPhoneRow(skeletonFakes());
  const line = testPhoneLineOf(poolLine());
  const root = composeRoot({
    environment: "test",
    sets: { fake: fakes.ports },
    linqSendCall: (request) => lineLinqSend(line).sendPart(request),
    actors: handleActors(),
    vars: { ENVIRONMENT: "staging", GIT_SHA: "test-sha" },
    clock: fakes.clock,
    linq: stagingLinqVerifyInputs(lineValues as unknown as StagingEnv),
    handleKey: fakes.handleKeys.call,
    chatOpenCall: fakes.dispatch.openChat,
    safetyReaders: fakes.models.readers,
    bundleReads: fakes.bundleReads.calls,
    handleTargets: fakes.handleTargets.call,
    frontierScope: fakes.frontier.scope,
    deciders: fakes.decide.deciders,
    turnRows: fakes.turnRows.calls,
    gateReads: fakes.gate.reads,
    composeReads: fakes.compose.reads,
    composers: fakes.composer.composers,
    finalizeData: fakes.finalize.data,
    outboxCalls: fakes.dispatch.outbox,
    sendStateCall: fakes.dispatch.sendState,
    flags: fakeFlags([SKELETON_FLAG]),
    testPhone: { ...(await pageReads()), line },
  });
  const restore = root.install();
  const worker = createWorker(
    () => root.gateway,
    () => null,
    (request) => root.linqWebhook(request),
  );
  return {
    root,
    restore,
    async send() {
      const traceId = crypto.randomUUID();
      const response = await Promise.resolve(
        worker.fetch(
          new Request(`https://rosie.test${poolEnv.BASE_PATH}${pagePathOf("testPhoneSend")}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-trace-id": traceId },
            body: JSON.stringify(testPhoneSendJson.request),
          }),
          poolEnv,
          createExecutionContext(),
        ),
      );
      return { status: response.status, outcome: await response.json<Json>(), traceId };
    },
  };
}

/** Staging on the real line, with the roster phone on the list and both made-up secrets set. */
function pageLineValues(changes: Json = {}): { values: Json; linqSecret: string; pageSecret: string } {
  const linqSecret = testWebhookSecret();
  const pageSecret = testWebhookSecret();
  const values: Json = {
    ENVIRONMENT: "staging",
    [STAGING_LINQ_LINE]: REAL_LINQ_LINE,
    STAGING_LINQ_ALLOWLIST: ROSTER_PHONE,
    ROSIE_NUMBER: ROSIE,
    [LINQ_WEBHOOK_SECRET]: linqSecret,
    [TEST_PHONE_WEBHOOK_SECRET]: pageSecret,
    ...changes,
  };
  for (const [name, value] of Object.entries(changes))
    if (value === undefined) Reflect.deleteProperty(values, name);
  return { values, linqSecret, pageSecret };
}

/** The gateway's own receive span on a trace, not the handle actor's beside it. */
function gatewayReceive(traceId: unknown): Json | undefined {
  return linesOf("span").find(
    (line) =>
      line.trace_id === traceId &&
      line.hop === "receive" &&
      (line.got as { door?: unknown } | undefined)?.door !== "handleActor",
  );
}

describe("the test-phone page's send with the real line on: signed by the page's own signer under TEST_PHONE_WEBHOOK_SECRET", () => {
  it(
    "reaches tp-04's actor: the gateway's verify takes the page's own secret from a test phone, and the page answers sent with the gateway's 200",
    { timeout: TEST_MS },
    async () => {
      const line = pageLineValues();
      const run = await pageRig(line.values);
      try {
        const answer = await run.send();
        await actorOf(TP_04_ACTOR).safetyIdle();
        await actorOf(TP_04_ACTOR).batchIdle();

        expect(answer.status).toBe(200);
        expect(answer.outcome).toEqual({
          result: "sent",
          eventId: expect.any(String) as string,
          traceId: expect.any(String) as string,
          gatewayStatus: 200,
        });
        expect(gatewayReceive(answer.outcome.traceId)?.decided).toMatchObject({
          signatureValid: true,
          knownEventId: false,
          answered: 200,
        });
        const inbox = await runInDurableObject(actorOf(TP_04_ACTOR), (actor: HandleActor) =>
          actor.readInbox(),
        );
        expect(inbox.map((entry) => entry.event.eventId)).toEqual([answer.outcome.eventId]);
        expectNothingLeaked([line.linqSecret, line.pageSecret]);
      } finally {
        run.restore();
      }
    },
  );

  it(
    "with tp-04's number on STAGING_LINQ_ALLOWLIST (a roster phone), the page's secret cannot speak for it: the gateway answers 401 (badSignature) and no actor gets it",
    { timeout: TEST_MS },
    async () => {
      const line = pageLineValues({ STAGING_LINQ_ALLOWLIST: `${ROSTER_PHONE},${TP_04_NUMBER}` });
      const run = await pageRig(line.values);
      try {
        const answer = await run.send();

        expect(answer.status).toBe(200);
        expect(answer.outcome).toMatchObject({ result: "sent", gatewayStatus: 401 });
        const receive = gatewayReceive(answer.outcome.traceId);
        expect(receive).toMatchObject({
          outcome: "refused",
          error_code: "badSignature",
          decided: { signatureValid: false, answered: 401 },
        });
        const inbox = await runInDurableObject(actorOf(TP_04_ACTOR), (actor: HandleActor) =>
          actor.readInbox(),
        );
        expect(inbox).toEqual([]);
        expectNothingLeaked([line.linqSecret, line.pageSecret]);
      } finally {
        run.restore();
      }
    },
  );

  it(
    "with TEST_PHONE_WEBHOOK_SECRET missing, the page signs nothing: it answers 503, its failure named by the error alone, and nothing reaches the gateway or an actor",
    { timeout: TEST_MS },
    async () => {
      const line = pageLineValues({ [TEST_PHONE_WEBHOOK_SECRET]: undefined });
      const run = await pageRig(line.values);
      try {
        const answer = await run.send();

        expect(answer.status).toBe(503);
        expect(
          linesOf("gateway_failed").filter((failed) => failed.trace_id === answer.traceId),
        ).toContainEqual(expect.objectContaining({ stage: "pageHandler", error: "MissingSecretError" }));
        expect(linesOf("span").filter((span) => span.hop === "receive")).toEqual([]);
        const inbox = await runInDurableObject(actorOf(TP_04_ACTOR), (actor: HandleActor) =>
          actor.readInbox(),
        );
        expect(inbox).toEqual([]);
        expectNothingLeaked([line.linqSecret]);
      } finally {
        run.restore();
      }
    },
  );
});

// ---- T-1456: the Worker's root asks its own handle for a receipt's chat --------------------------------------------------

/** The roster phone's chat on the real line, as Linq names it (made up). */
const ROSTER_CHAT = "linq-chat-t1456-roster";
const TRACE = "4f1c2b7a-9d3e-4c5f-8a6b-1e2d3c4b5a69";

interface RootEnv {
  readonly env: StagingEnv;
  readonly linqSecret: string;
  /** Reads of each Hyperdrive binding's connection string: T-1254's handle reads its side's at each call. */
  readonly reads: { job: number; app: number };
}

/**
 * Staging's env on the real line for workerRoot: Linq's made-up secret, the roster phone on the list, Rosie's line, and
 * HYPERDRIVE_JOB and HYPERDRIVE_APP stand-ins whose connection strings count each read and then fail it, so a call reaches
 * no database and no host, and its side is known by the binding it read.
 */
function rootEnv(): RootEnv {
  const linqSecret = testWebhookSecret();
  const reads = { job: 0, app: 0 };
  const values: Json = {
    ENVIRONMENT: "staging",
    BASE_PATH: "/test",
    DB_SCHEMA: "",
    GIT_SHA: "test-sha",
    [STAGING_LINQ_LINE]: REAL_LINQ_LINE,
    STAGING_LINQ_ALLOWLIST: ROSTER_PHONE,
    ROSIE_NUMBER: ROSIE,
    [LINQ_WEBHOOK_SECRET]: linqSecret,
    HYPERDRIVE_JOB: {
      get connectionString(): string {
        reads.job += 1;
        throw new Error("t1456: no database stands behind this HYPERDRIVE_JOB");
      },
    },
    HYPERDRIVE_APP: {
      get connectionString(): string {
        reads.app += 1;
        throw new Error("t1456: no database stands behind this HYPERDRIVE_APP");
      },
    },
  };
  return { env: values as unknown as StagingEnv, linqSecret, reads };
}

/** A K-06 fixture's event from the roster phone on its chat, received now (to the whole second, as the double signs it). */
function rosterEvent(fixture: object, eventId: string): LinqInboundEvent {
  const at = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace(/[.][0-9]{3}Z$/u, "Z");
  const event = structuredClone(fixture) as LinqInboundEvent;
  return {
    ...event,
    eventId,
    handle: { kind: "phone", address: ROSTER_PHONE },
    chatId: ROSTER_CHAT,
    receivedAt: at,
    sentAt: event.sentAt === null ? null : at,
    status: event.status === null ? null : { ...event.status, at },
    traceId: `trace-${eventId}`,
  };
}

/** The webhook as Linq posts it to {BASE_PATH}/webhooks/linq. */
function linqPost(webhook: SignedWebhook): Request {
  return new Request("https://rosie.test/test/webhooks/linq", {
    method: "POST",
    headers: {
      "webhook-id": webhook.webhookId,
      "webhook-timestamp": webhook.timestamp,
      "webhook-signature": webhook.signature,
    },
    body: webhook.raw,
  });
}

describe("the Worker's root on the real line (workerRoot, T-1456): a Linq receipt's chat is asked of the root's own handle", () => {
  it(
    "a signed message.delivered: the verify asks the root's handle on the runtime side (HYPERDRIVE_JOB read once, HYPERDRIVE_APP never), and with no answer the receipt is not placed: the gateway answers 503, its line naming receiptHandleUnknown; a message.received asks nothing; no line holds the chat id",
    { timeout: TEST_MS },
    async () => {
      const { env, linqSecret, reads } = rootEnv();
      const root = workerRoot(env);
      // Nothing is read of either binding's connection string as the root is built.
      expect(reads).toEqual({ job: 0, app: 0 });
      const linq = createLinqWebhookDouble({ secret: linqSecret });
      const receipt = await linq.sign({
        event: rosterEvent(deliveredJson, "evt-t1456-delivered-0001"),
        partKey: "out-t1456-roster-join/1/1",
      });

      const verified = await root.ports.linqVerify
        .verifyWebhook({ ...receipt, receivedAt: new Date().toISOString(), traceId: TRACE })
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect(verified).toMatchObject({ name: "LinqWebhookError", code: "receiptHandleUnknown" });
      expect(reads).toEqual({ job: 1, app: 0 });

      const response = await handleLinqWebhook(linqPost(receipt), root.gateway, {
        environment: "staging",
        version: "test-sha",
      });

      expect(response.status).toBe(503);
      const traceId = response.headers.get("x-trace-id");
      expect(linesOf("gateway_failed").filter((failed) => failed.trace_id === traceId)).toEqual([
        {
          level: "error",
          msg: "gateway_failed",
          trace_id: traceId,
          stage: "verify",
          error: "LinqWebhookError",
          code: "receiptHandleUnknown",
        },
      ]);
      expect(reads.app).toBe(0);

      const jobReadsBefore = reads.job;
      const text = await linq.sign({ event: rosterEvent(textJson, "evt-t1456-text-0001"), partKey: null });
      const textAnswer = await root.ports.linqVerify.verifyWebhook({
        ...text,
        receivedAt: new Date().toISOString(),
        traceId: TRACE,
      });

      expect(textAnswer).toMatchObject({
        result: "event",
        event: { kind: "text", handle: { kind: "phone", address: ROSTER_PHONE }, chatId: ROSTER_CHAT },
      });
      expect(reads).toEqual({ job: jobReadsBefore, app: 0 });
      expectNothingLeaked([linqSecret]);
      for (const line of logged) expect(line.includes(ROSTER_CHAT), "a line holds the chat id").toBe(false);
    },
  );
});
