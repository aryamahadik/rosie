// The test-phone page's two calls through the Worker (T-1186; K-21 v1 testPhoneSend and testPhoneParts; DL-373), inside the
// Workers runtime with wrangler.jsonc's staging vars (ENVIRONMENT "staging", BASE_PATH "/test"). The root is composed for
// the test environment with the HandleActor namespace, the skeleton flag on and staging's test-phone line (the
// TestPhoneLine Durable Object, ./test-phone/line.ts); the calls go in through the Worker's own route,
// {BASE_PATH}/page-api/<call>, to T-565's handlers, which the root binds into the gateway's page entry on staging only.
//
//   - test-phone-send.json reaches T-565's handler: the text is signed as tp-04 by the Linq double under the secret the
//     root's Linq verify reads, posted to the root's Linq route, verified and handed to tp-04's actor; the page answers
//     the handler's outcome with its own trace id, and the outcome's traceId is the trace the gateway opened.
//   - test-phone-parts.json lists what the doubles recorded (DL-373 gap (a)): Sam's text goes through the actor's turn,
//     whose dispatcher sends each part from the actor through the line (the store every isolate shares), and an email goes
//     through the line's email double; the page entry then reads both from the line, which keeps them in its own storage.
//   - with ENVIRONMENT production both calls answer stagingOnly and no handler runs: no port is reached.
//   - every other page call still answers 503; with the skeleton flag off, or with no database bound (the Worker's own
//     root), the two calls answer 503 too (DL-373 gap (c)).
//
// The line is env.staging's TEST_PHONE_LINE binding: wrangler.jsonc binds the class there, and the Worker's main module
// (runtime/src/index.ts) exports it, as for the HandleActor.
//
// Test values only (rule 9): K-21's fixtures, the fictional 555-01xx numbers of K-21 test-roster.json, example.com
// addresses and a webhook secret made up for the run.
import testPhonePartsJson from "@rosie/contracts/page-api/fixtures/test-phone-parts.json";
import testPhoneSendJson from "@rosie/contracts/page-api/fixtures/test-phone-send.json";
import sendCopy from "@rosie/contracts/port-email/fixtures/send-copy-of-text.json";
import textFixture from "@rosie/contracts/inbound-event/fixtures/text-imessage.json";
import { createExecutionContext, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

import {
  sha256Hex,
  type PhoneStates,
  type RosterPhone,
  type TestPhoneRoster,
  type TesterAccess,
} from "@rosie/actions/src/page-calls/staging/test-phone/index";
import type { SendEmailRequest } from "@rosie/adapters/email/double";

import { turnIdOf, type HandleActor } from "../actor";
import { actorNameOf, PAGE_CALLS, pagePathOf, type PageCallName } from "../gateway";
import { createWorker } from "../index";
import { SAM } from "../turn/test-support";
import {
  composeRoot,
  lineLinqSend,
  SKELETON_FLAG,
  TEST_PHONE_LINE_NAME,
  testPhoneLineOf,
  workerRoot,
  type HandleActors,
  type Root,
  type TestPhoneInputs,
  type TestPhoneLinePort,
} from "./index";
import type { TestPhoneLine } from "./test-phone/line";
import {
  fakeFlags,
  SAM_CHAT,
  SAM_TRADES_TEXT,
  skeletonFakes,
  withSamPhoneRow,
  type LinqInboundEvent,
  type SignedWebhook,
  type SkeletonFakes,
} from "./test-support";

type Json = Record<string, unknown>;

/** A run through the Workers runtime's own steps: a resource guard above Vitest's 5 s default, as root.worker.test.ts's. */
const TEST_MS = 30_000;

const TOKEN = testPhoneSendJson.request.page.sessionToken;
const SAM_NUMBER = SAM.handle.address;
const SAM_EMAIL = "sam@example.com";
const TP_04_NUMBER = "+15555550104";
/** K-21 test-roster.json's tp-01 (test owner 1, Sam: 555-0100) and tp-04 (the second customer: 555-0104). */
const ROSTER: readonly RosterPhone[] = [
  { testPhoneId: "tp-01", number: SAM_NUMBER, email: SAM_EMAIL },
  { testPhoneId: "tp-04", number: TP_04_NUMBER, email: null },
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---- the actors and the line -----------------------------------------------------------------------------------------

type ActorNamespace = DurableObjectNamespace<HandleActor>;
type LineNamespace = DurableObjectNamespace<TestPhoneLine>;

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

/** The TestPhoneLine namespace: env.staging's TEST_PHONE_LINE binding (the Worker's main module exports the class). */
function lineNamespace(): LineNamespace {
  const namespace = env.TEST_PHONE_LINE;
  if (namespace === undefined) throw new Error("env.staging binds no TEST_PHONE_LINE");
  return namespace;
}

/** Waits until the actor has read every text and handed on what its batch window can. */
async function settle(actorName: string): Promise<void> {
  await actorOf(actorName).safetyIdle();
  await actorOf(actorName).batchIdle();
}

/**
 * A page call's POST as the page sends it, with its JSON body and, when given, its trace id: the gateway pages' own
 * `pagePost` (../gateway/pages/test-support), written here so this file does not import that module and its 40-odd K-21
 * fixtures. The Workers pool sends a test file's runner, in one message, every module of the file's graph that the run
 * has already transformed (Vitest's warm modules), and this file's graph holds the Tool API's generated validators: with
 * those fixtures in it too, that message closed the runner's socket ("Worker exited unexpectedly") whenever the pages
 * test had run before this file (DL-420).
 */
function pagePost(path: string, body: unknown, options: { traceId?: string } = {}): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.traceId !== undefined) headers.set("x-trace-id", options.traceId);
  return new Request(`https://rosie.test${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

/** Polls an async check until it holds, or fails naming what it waited for. */
async function waitFor(check: () => Promise<boolean>, what: string, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ---- the test-phone ports: the session, roster and phone reads, each counting what reached it --------------------------

interface Reads {
  readonly access: TesterAccess;
  readonly roster: TestPhoneRoster;
  readonly phones: PhoneStates;
  /** Each port reached, in order. */
  readonly reached: string[];
}

async function testPhoneReads(): Promise<Reads> {
  const tester = await sha256Hex(TOKEN);
  const reached: string[] = [];
  return {
    reached,
    access: {
      standing(hash) {
        reached.push("access");
        return Promise.resolve(hash === tester ? "tester" : "noSession");
      },
    },
    roster: {
      phone(testPhoneId) {
        reached.push("roster");
        return Promise.resolve(ROSTER.find((phone) => phone.testPhoneId === testPhoneId) ?? null);
      },
    },
    phones: {
      state() {
        reached.push("phones");
        return Promise.resolve({
          chatOpen: true,
          stopped: false,
          stoppedAt: null,
          chatLink: testPhonePartsJson.outcome.chatLink,
        });
      },
    },
  };
}

/** The line, counting each call that reached it. */
function countingLine(line: TestPhoneLinePort, reached: string[]): TestPhoneLinePort {
  return {
    sendPart: (request) => {
      reached.push("line.sendPart");
      return line.sendPart(request);
    },
    partsTo: (number) => {
      reached.push("line.partsTo");
      return line.partsTo(number);
    },
    sendEmail: (request) => {
      reached.push("line.sendEmail");
      return line.sendEmail(request);
    },
    sentEmails: (request) => {
      reached.push("line.sentEmails");
      return line.sentEmails(request);
    },
  };
}

// ---- the rig: the root for the test environment, with the test-phone calls bound ---------------------------------------

interface Run {
  readonly fakes: SkeletonFakes;
  readonly root: Root;
  readonly reads: Reads;
  readonly line: TestPhoneLinePort;
  /** One page call through the Worker's route, in the Worker's environment. */
  page(call: PageCallName, request: Json, traceId?: string): Promise<Response>;
  /** Signs one K-06 event with the Linq double and posts it to the Worker's Linq route; answers the gateway's trace id. */
  text(event: LinqInboundEvent): Promise<string>;
  restore(): void;
}

interface RigOptions {
  /** The root's ENVIRONMENT (default the Worker's, staging). */
  readonly vars?: string;
  /** The ENVIRONMENT the Worker answers the call in (default staging, BASE_PATH "/test"; else BASE_PATH ""). */
  readonly worker?: string;
  /** The skeleton flag (default on). */
  readonly flagOn?: boolean;
  /** False: the session, roster and phone reads are not handed in, as where no database is bound (default true). */
  readonly database?: boolean;
}

async function rig(options: RigOptions = {}): Promise<Run> {
  // Sam's phone row, so the turn's reply this test waits for is sent (limit 8 at send, joined by T-562).
  const fakes = withSamPhoneRow(skeletonFakes());
  const reads = await testPhoneReads();
  const line = countingLine(testPhoneLineOf(lineNamespace()), reads.reached);
  const testPhone: TestPhoneInputs =
    options.database === false ? { access: null, roster: null, phones: null, line } : { ...reads, line };
  const root = composeRoot({
    environment: "test",
    sets: { fake: fakes.ports },
    // Staging's send path through the line, fed to the joined Linq send port (T-563): each part the dispatcher sends goes
    // to the line's Linq double.
    linqSendCall: (request) => lineLinqSend(line).sendPart(request),
    actors: handleActors(),
    vars: { ENVIRONMENT: options.vars ?? env.ENVIRONMENT, GIT_SHA: "test-sha" },
    clock: fakes.clock,
    linq: fakes.linqInputs,
    handleKey: fakes.handleKeys.call,
    // The chat-open port (T-1213) over the dispatch double: each text opens its number's chat before the actor.
    chatOpenCall: fakes.dispatch.openChat,
    safetyReaders: fakes.models.readers,
    bundleReads: fakes.bundleReads.calls,
    handleTargets: fakes.handleTargets.call,
    // The frontier port (T-557) over its K-05 double: test owner 1's seeded rows, as root.worker.test.ts feeds it.
    frontierScope: fakes.frontier.scope,
    // The decide port (T-558) over @rosie/ai's deciders on the recorded-model double, as the hop tests feed it.
    deciders: fakes.decide.deciders,
    // The gate port (T-559) over its reads' doubles, its one commit through the turn-row port to the K-05 double.
    turnRows: fakes.turnRows.calls,
    gateReads: fakes.gate.reads,
    composeReads: fakes.compose.reads,
    composers: fakes.composer.composers,
    finalizeData: fakes.finalize.data,
    // The outbox and send-state ports (T-562) over one K-05 double: the dispatcher claims the row the turn committed.
    outboxCalls: fakes.dispatch.outbox,
    sendStateCall: fakes.dispatch.sendState,
    flags: fakeFlags(options.flagOn === false ? [] : [SKELETON_FLAG]),
    testPhone,
  });
  const restore = root.install();
  const worker = createWorker(
    () => root.gateway,
    () => null,
    (request) => root.linqWebhook(request),
  );
  const where = options.worker ?? env.ENVIRONMENT;
  const workerEnv: Cloudflare.Env =
    where === env.ENVIRONMENT ? env : { ...env, ENVIRONMENT: where, BASE_PATH: "" };
  return {
    fakes,
    root,
    reads,
    line,
    page: (call, request, traceId) =>
      Promise.resolve(
        worker.fetch(
          pagePost(
            `${workerEnv.BASE_PATH}${pagePathOf(call)}`,
            request,
            traceId === undefined ? {} : { traceId },
          ),
          workerEnv,
          createExecutionContext(),
        ),
      ),
    async text(event) {
      const signed: SignedWebhook = await fakes.sign(event);
      const response = await worker.fetch(
        new Request(`https://rosie.test${env.BASE_PATH}/webhooks/linq`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "webhook-id": signed.webhookId,
            "webhook-timestamp": signed.timestamp,
            "webhook-signature": signed.signature,
          },
          body: signed.raw,
        }),
        env,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      const traceId = response.headers.get("x-trace-id");
      if (traceId === null) throw new Error("the gateway answered with no trace id");
      return traceId;
    },
    restore,
  };
}

/** The JSON log lines written so far (every runtime log line is one JSON object). */
function logLines(log: MockInstance): Json[] {
  return log.mock.calls.map(([line]) => JSON.parse(String(line)) as Json);
}

/** The gateway's own receive span on a trace, not the handle actor's beside it (got.door "handleActor"). */
function gatewayReceive(lines: readonly Json[], traceId: unknown): Json | undefined {
  return lines.find(
    (line) =>
      line.trace_id === traceId &&
      line.hop === "receive" &&
      (line.got as { door?: unknown } | undefined)?.door !== "handleActor",
  );
}

/** Sam's text: K-06's text-imessage.json with his handle, this event id and these words. */
function samText(eventId: string, body: string): LinqInboundEvent {
  return {
    ...(structuredClone(textFixture) as Json),
    eventId,
    handle: { ...SAM.handle },
    body,
    chatId: SAM_CHAT,
    messageId: `linq-msg-demo-in-${eventId}`,
  } as unknown as LinqInboundEvent;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

// ---- the tests --------------------------------------------------------------------------------------------------------

describe("testPhoneSend on staging: test-phone-send.json through the Worker's page entry", () => {
  it(
    "reaches T-565's handler, whose signed text the root's Linq route verifies and hands to tp-04's actor; the page answers the handler's outcome with its own trace id, and the outcome names the trace the gateway opened",
    { timeout: TEST_MS },
    async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = await rig();
      try {
        const pageTrace = crypto.randomUUID();
        const response = await run.page("testPhoneSend", testPhoneSendJson.request, pageTrace);
        const outcome = await response.json<Json>();
        const tp04 = actorNameOf({ kind: "phone", address: TP_04_NUMBER });
        await settle(tp04);

        expect(response.status).toBe(200);
        expect(response.headers.get("x-trace-id")).toBe(pageTrace);
        expect(outcome).toEqual({
          result: "sent",
          eventId: expect.any(String) as string,
          traceId: expect.stringMatching(UUID) as string,
          gatewayStatus: 200,
        });
        expect(outcome.traceId).not.toBe(pageTrace);
        // The gateway's own trace for the webhook: verified, not known before, answered 200.
        const lines = logLines(log);
        expect(gatewayReceive(lines, outcome.traceId)?.decided).toMatchObject({
          signatureValid: true,
          knownEventId: false,
          answered: 200,
        });
        // The event T-565 built is in tp-04's actor's inbox, under the id the page answered.
        const inbox = await runInDurableObject(actorOf(tp04), (actor: HandleActor) => actor.readInbox());
        expect(inbox.map((entry) => entry.event.eventId)).toEqual([outcome.eventId]);
        // The page entry's own span, on the page's trace: the handler answered a response.
        const pageSpan = lines.find((line) => line.trace_id === pageTrace && line.hop === "pageRequest");
        expect(pageSpan).toMatchObject({ outcome: "ok", decided: { answered: 200, answer: "response" } });
        expect(run.reads.reached).toEqual(["access", "roster"]);
      } finally {
        run.restore();
      }
    },
  );
});

describe("testPhoneParts on staging: test-phone-parts.json lists what the doubles recorded", () => {
  it(
    "lists the parts the dispatcher sent from Sam's actor through staging's test-phone line, and the email sent through the line's email double, read through the page entry from the line's own storage",
    { timeout: TEST_MS },
    async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const run = await rig();
      try {
        // Sam's text goes through the actor's turn; three seconds quiet close its batch, and the turn's dispatcher sends.
        run.fakes.known("evt-sam-0001");
        // Its turn's two decide reads (decide, joined by T-558, runs on the recorded-model double).
        run.fakes.decide.recordTurn(["evt-sam-0001"]);
        await run.text(samText("evt-sam-0001", SAM_TRADES_TEXT));
        const samActor = actorNameOf(SAM.handle);
        await settle(samActor);
        await run.fakes.clock.advance(3000);
        await runDurableObjectAlarm(actorOf(samActor));
        // The turn's dispatcher claims the row the turn committed and sends the final parts finalize wrote into it (T-562).
        const row = `outbox-s1-02-${await turnIdOf(["evt-sam-0001"])}-1`;
        await waitFor(
          async () => (await run.line.partsTo(SAM_NUMBER)).length > 0,
          "the dispatcher's parts in the line",
        );
        const sends = run.fakes.finalize.plans.get(row)?.finalParts.sends ?? [];
        expect(sends.length).toBeGreaterThan(0);
        expect(await run.line.partsTo(SAM_NUMBER)).toHaveLength(sends.length);
        // The email rows' stand-in: K-12's send-copy-of-text.json through the line's email double, to tp-01's own person
        // (the JSON's purpose types as a plain string).
        const copy = { ...sendCopy.request, to: SAM_EMAIL } as SendEmailRequest;
        const emailed = await run.line.sendEmail(copy);
        expect(emailed).toMatchObject({ result: "accepted" });

        const before = run.reads.reached.length;
        const response = await run.page("testPhoneParts", {
          ...testPhonePartsJson.request,
          testPhoneId: "tp-01",
        });
        const outcome = await response.json<{
          result: string;
          phone: Json;
          chatLink: Json | null;
          parts: { at: string; sent: Json; outcome: Json }[];
          emails: Json[];
        }>();

        expect(response.status).toBe(200);
        expect(outcome.result).toBe("parts");
        expect(outcome.phone).toEqual({
          testPhoneId: "tp-01",
          last4: "0100",
          chatOpen: true,
          stopped: false,
          stoppedAt: null,
        });
        expect(outcome.chatLink).toEqual(testPhonePartsJson.outcome.chatLink);
        // Each part the dispatcher sent, in order: its row-part-try key, Sam's number and chat, the words as finalized.
        expect(outcome.parts.map((part) => part.sent)).toEqual(
          sends.map(
            (send, index): unknown =>
              expect.objectContaining({
                idempotencyKey: `${row}/${String(index + 1)}/1`,
                to: SAM_NUMBER,
                chatId: SAM_CHAT,
                text: send.text,
              }) as unknown,
          ),
        );
        for (const part of outcome.parts) {
          expect(part.outcome).toMatchObject({ result: "accepted", chatId: SAM_CHAT, service: "imessage" });
          expect(part.at).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/);
        }
        expect(outcome.emails).toEqual([
          {
            at: expect.any(String) as string,
            to: SAM_EMAIL,
            subject: sendCopy.request.subject,
            text: sendCopy.request.text,
          },
        ]);
        // Read through the page entry: the session, the roster, then the line's parts and emails, then the phone.
        expect(run.reads.reached.slice(before)).toEqual([
          "access",
          "roster",
          "line.partsTo",
          "line.sentEmails",
          "phones",
        ]);
        // The line keeps them in its own storage, where every isolate's call reaches the one object.
        const kept = await runInDurableObject(
          lineNamespace().get(lineNamespace().idFromName(TEST_PHONE_LINE_NAME)),
          (_line, state) =>
            state.storage.sql
              .exec<{ recipient: string }>("SELECT recipient FROM test_phone_parts ORDER BY seq")
              .toArray(),
        );
        expect(kept).toEqual(sends.map(() => ({ recipient: SAM_NUMBER })));
      } finally {
        run.restore();
      }
    },
  );

  it("reads nothing from the line for a session that is not a tester's", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const run = await rig();
    try {
      const request = testPhonePartsJson.request;
      const response = await run.page("testPhoneParts", {
        ...request,
        page: { ...request.page, sessionToken: "placeholder-session-token-not-a-tester" },
        testPhoneId: "tp-01",
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ error: "signInNeeded" });
      expect(run.reads.reached).toEqual(["access"]);
    } finally {
      run.restore();
    }
  });
});

describe("with ENVIRONMENT production", () => {
  it("both calls answer stagingOnly and no handler runs: the root binds none, and the entry refuses before any port", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const run = await rig({ vars: "production", worker: "production" });
    try {
      expect(run.root.gateway.pages).toBeUndefined();
      for (const [call, request] of [
        ["testPhoneSend", testPhoneSendJson.request],
        ["testPhoneParts", testPhonePartsJson.request],
      ] as const) {
        const response = await run.page(call, request);
        expect(response.status, call).toBe(200);
        expect(await response.json(), call).toEqual({ error: "stagingOnly" });
      }
      expect(run.reads.reached).toEqual([]);
    } finally {
      run.restore();
    }
  });

  it("a root bound on staging still runs no handler for a call the Worker answers in production", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const run = await rig({ worker: "production" });
    try {
      expect(run.root.gateway.pages?.testPhoneSend).toBeDefined();
      for (const [call, request] of [
        ["testPhoneSend", testPhoneSendJson.request],
        ["testPhoneParts", testPhonePartsJson.request],
      ] as const) {
        const response = await run.page(call, request);
        expect(await response.json(), call).toEqual({ error: "stagingOnly" });
      }
      expect(run.reads.reached).toEqual([]);
    } finally {
      run.restore();
    }
  });
});

describe("every other call, and the two calls with nothing behind them", () => {
  it("every other page call still answers 503 (not connected), with its trace id", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const run = await rig();
    try {
      const others = PAGE_CALLS.filter((call) => call !== "testPhoneSend" && call !== "testPhoneParts");
      expect(others).toHaveLength(PAGE_CALLS.length - 2);
      for (const call of others) {
        const traceId = crypto.randomUUID();
        const response = await run.page(call, {}, traceId);
        expect(response.status, call).toBe(503);
        expect(response.headers.get("x-trace-id"), call).toBe(traceId);
        const span = logLines(log).find((line) => line.trace_id === traceId && line.hop === "pageRequest");
        expect(span?.error_code, call).toBe("notConnected");
      }
      expect(run.reads.reached).toEqual([]);
    } finally {
      run.restore();
    }
  });

  it("with the skeleton flag off, testPhoneSend answers 503: the root's Linq route answers 404, so nothing reaches an actor", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const run = await rig({ flagOn: false });
    try {
      const response = await run.page("testPhoneSend", testPhoneSendJson.request);

      expect(response.status).toBe(503);
      const tp04 = actorOf(actorNameOf({ kind: "phone", address: TP_04_NUMBER }));
      expect(await runInDurableObject(tp04, (actor: HandleActor) => actor.readInbox())).toEqual([]);
    } finally {
      run.restore();
    }
  });

  it("bound on staging with no database reads, both calls answer 503 and nothing is read from the line", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const run = await rig({ database: false });
    try {
      for (const [call, request] of [
        ["testPhoneSend", testPhoneSendJson.request],
        ["testPhoneParts", testPhonePartsJson.request],
      ] as const) {
        const traceId = crypto.randomUUID();
        const response = await run.page(call, request, traceId);
        expect(response.status, call).toBe(503);
        const span = logLines(log).find((line) => line.trace_id === traceId && line.hop === "pageRequest");
        expect(span?.error_code, call).toBe("handlerFailed");
      }
      expect(run.reads.reached).toEqual([]);
    } finally {
      run.restore();
    }
  });

  it("on the Worker's own root, which has no database to read until T-567, both calls stay unconfigured: 503, not connected", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const worker = createWorker((workerEnv) => workerRoot(workerEnv).gateway);
    for (const [call, request] of [
      ["testPhoneSend", testPhoneSendJson.request],
      ["testPhoneParts", testPhonePartsJson.request],
    ] as const) {
      const traceId = crypto.randomUUID();
      const response = await Promise.resolve(
        worker.fetch(
          pagePost(`${env.BASE_PATH}${pagePathOf(call)}`, request, { traceId }),
          env,
          createExecutionContext(),
        ),
      );
      expect(response.status, call).toBe(503);
      const span = logLines(log).find((line) => line.trace_id === traceId && line.hop === "pageRequest");
      expect(span?.error_code, call).toBe("notConnected");
    }
  });
});
