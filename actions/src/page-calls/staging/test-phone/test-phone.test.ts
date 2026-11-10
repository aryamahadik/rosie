// T-565: the test-phone page's two server calls against K-21 v1. The card's proofs:
//   1. test-phone-send.json and test-phone-parts.json give their responses;
//   2. wherever ENVIRONMENT is not exactly "staging", production first, both calls answer K-21's only answer there,
//      stagingOnly (the card's "404": see the handoff), and reach no tool code: the request is not read and no port is
//      touched;
//   3. a send as a phone that is not a seeded test phone is refused (notTestPhone), with nothing signed, posted or read.
// Beside them: the sign-in and tester checks, a request K-21 refuses, the gateway's answers, the repeat rule, the doubles'
// records as the page lists them (the real Linq and email doubles), `since`, and no log line at all. No network and no
// real key: the webhook secret is made up for each run, and the gateway's verify is T-413's adapter itself.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEmailDouble } from "@rosie/adapters/email/double";
import { createLinqDouble, type SendPartOutcome, type SendPartRequest } from "@rosie/adapters/linq/double";
import { createLinqWebhookDouble } from "@rosie/adapters/linq/double-webhooks";

import type { PageCallName, PageRequest } from "../../../../../runtime/src/gateway";
import { isLabel } from "../../../../../runtime/src/trace";
import { TestPhoneError } from "./errors";
import {
  STAGING_ENVIRONMENT,
  TEST_PHONE_WEBHOOK_URL,
  createTestPhoneHandlers,
  testPhoneParts,
  testPhoneSend,
  type TestPhoneCall,
} from "./handlers";
import { sha256Hex } from "./ids";
import { createPartsRecorder } from "./parts";
import {
  ALEX_EMAIL,
  DOUBLE_SIGNED_WEBHOOK,
  FIRE_NOW_IN_PRODUCTION,
  PARTS_FIXTURE,
  ROSTER,
  SEND_FIXTURE,
  TESTER_TOKEN,
  TEST_PHONE_EVENT,
  fakeAccess,
  fakeGateway,
  fakePhoneStates,
  fakeRoster,
  k11Fixture,
  k12Problems,
  k12SendRequest,
  k21Fixture,
  k21Problems,
  pageRequest,
  recordedEmails,
  rosterPhone,
  scriptedLinqDouble,
  testWebhookSecret,
  tripwire,
  type Exchange,
} from "./test-support";
import type { ChatLink, PhoneState, SendIds, TestPhoneDeps, TesterStanding } from "./types";

const TP03 = rosterPhone("tp-03");
const TP04 = rosterPhone("tp-04");

/** The ids test-phone-send.json's server made: K-06 test-phone-page.json's own. */
const FIXTURE_IDS: SendIds = {
  eventId: TEST_PHONE_EVENT.eventId,
  messageId: TEST_PHONE_EVENT.messageId ?? "",
  chatId: TEST_PHONE_EVENT.chatId ?? "",
};

interface PartsOutcome {
  readonly phone: { readonly testPhoneId: string; readonly stopped: boolean };
  readonly chatLink: ChatLink;
  readonly parts: readonly { at: string }[];
  readonly emails: readonly { at: string; to: string; subject: string; text: string }[];
}

const PARTS_OUTCOME = PARTS_FIXTURE.outcome as unknown as PartsOutcome;

async function standings(entries: [string, TesterStanding][]): Promise<Map<string, TesterStanding>> {
  const hashed = await Promise.all(
    entries.map(async ([token, standing]) => [await sha256Hex(token), standing] as const),
  );
  return new Map(hashed);
}

/** The tester of K-21 v1's staging fixtures, signed in. */
const testerAccess = async (): Promise<ReturnType<typeof fakeAccess>> =>
  fakeAccess(await standings([[TESTER_TOKEN, "tester"]]));

/** A gateway entry the call must not reach. */
const unreachedGateway = () =>
  vi.fn<TestPhoneDeps["gateway"]>(() => Promise.reject(new Error("the gateway was reached")));

/** test-phone-send.json's request with some of its fields changed. */
const sendRequest = (changes: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...structuredClone(SEND_FIXTURE.request),
  ...changes,
});

/** test-phone-parts.json's request with some of its fields changed. */
const partsRequest = (changes: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...structuredClone(PARTS_FIXTURE.request),
  ...changes,
});

/** A request whose page envelope carries another session token, or none. */
const withToken = (request: Record<string, unknown>, token: string | null): Record<string, unknown> => ({
  ...request,
  page: { ...(request.page as Record<string, unknown>), sessionToken: token },
});

let logSpies: unknown[] = [];

beforeEach(() => {
  logSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined),
  );
});

afterEach(() => {
  // Nothing here logs: never a word, a token, a number, an email or the doubles' records.
  for (const spy of logSpies) expect(spy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe("test-phone-send.json gives its response", () => {
  it("signs K-06 test-phone-page.json as the roster's tp-04 and posts it to the gateway: the event id, the gateway's trace and its status", async () => {
    const secret = testWebhookSecret();
    const sent = SEND_FIXTURE.outcome as { eventId: string; traceId: string };
    const gateway = fakeGateway({ secret, receivedAt: SEND_FIXTURE.given.now, traceId: sent.traceId });
    const access = await testerAccess();
    const roster = fakeRoster();
    const touched: string[] = [];
    const deps: TestPhoneDeps = {
      access,
      roster,
      phones: tripwire("phones", touched),
      linqWebhooks: createLinqWebhookDouble({ secret }),
      gateway: gateway.entry,
      parts: tripwire("parts", touched),
      emails: tripwire("emails", touched),
      now: () => Date.parse(SEND_FIXTURE.given.now),
      ids: () => Promise.resolve(FIXTURE_IDS),
    };

    const answer = await createTestPhoneHandlers(deps).testPhoneSend(
      pageRequest("testPhoneSend", SEND_FIXTURE.request),
    );

    expect(answer).toEqual(SEND_FIXTURE.outcome);
    expect(k21Problems({ ...SEND_FIXTURE, outcome: answer })).toEqual([]);
    // One webhook, K-11 v1 double-signed-webhook.json's, whose event the gateway's verify gives back as K-06 v1
    // test-phone-page.json, byte for byte, under the gateway's own receipt time and trace.
    expect(gateway.posted).toHaveLength(1);
    const posted = gateway.posted[0];
    const webhook = DOUBLE_SIGNED_WEBHOOK.outcome.webhook;
    expect(posted?.method).toBe("POST");
    expect(posted?.url).toBe(TEST_PHONE_WEBHOOK_URL);
    expect(posted?.webhookId).toBe(webhook.webhookId);
    expect(posted?.timestamp).toBe(webhook.timestamp);
    expect(posted?.raw).toBe(webhook.raw);
    expect(posted?.verified).toEqual({
      result: "event",
      httpStatus: 200,
      event: TEST_PHONE_EVENT,
      partKey: null,
    });
    expect(DOUBLE_SIGNED_WEBHOOK.request.event).toEqual(TEST_PHONE_EVENT);
    // The session was asked for by its token's sha256 at the call's moment, the phone by the roster's id; the page named
    // no number, and send read nothing of the parts, the emails or the phone's state.
    expect(access.asked).toEqual([
      { tokenSha256: await sha256Hex(TESTER_TOKEN), at: SEND_FIXTURE.given.now },
    ]);
    expect(roster.asked).toEqual(["tp-04"]);
    expect(touched).toEqual([]);
  });
});

describe("test-phone-parts.json gives its response", () => {
  it("lists tp-03's two parts as the Linq double took and answered them, its person's email, its stop state and its chat link", async () => {
    // Staging's send path: the recorder in front of a Linq double answering K-11 v1's own send-text.json and
    // send-poll.json (the fixture's parts are those two exchanges, word for word), each at its exchange's moment.
    const text = k11Fixture("send-text.json");
    const poll = k11Fixture("send-poll.json");
    const moments = [text.given.now, poll.given.now];
    const recorder = createPartsRecorder(scriptedLinqDouble([text.outcome, poll.outcome]), {
      now: () => moments.shift() ?? "",
    });
    expect(await recorder.sendPart(text.request)).toEqual(text.outcome);
    expect(await recorder.sendPart(poll.request)).toEqual(poll.outcome);

    // The email double's record: the copy to Alex as test-phone-parts.json shows it, in K-12 v1's own shape.
    const email = PARTS_OUTCOME.emails[0];
    if (email === undefined) throw new Error("test-phone-parts.json lists an email");
    const record = {
      recordedAt: email.at,
      providerMessageId: "email-double-msg-0001",
      request: {
        ...k12SendRequest("send-copy-of-text.json"),
        to: email.to,
        subject: email.subject,
        text: email.text,
      },
    };
    expect(k12Problems("doubleSentEmails.response", { result: "recorded", emails: [record] })).toEqual([]);
    const emails = recordedEmails([record]);

    // tp-03's own state: its chat open, not stopped, and the chat link K-09 issueChatLink gave it.
    const phones = fakePhoneStates(
      new Map<string, PhoneState>([
        [TP03.number, { chatOpen: true, stopped: false, stoppedAt: null, chatLink: PARTS_OUTCOME.chatLink }],
      ]),
    );
    const touched: string[] = [];
    const gateway = unreachedGateway();
    const deps: TestPhoneDeps = {
      access: await testerAccess(),
      roster: fakeRoster(),
      phones,
      linqWebhooks: tripwire("linqWebhooks", touched),
      gateway,
      parts: recorder,
      emails,
      now: () => Date.parse(PARTS_FIXTURE.given.now),
    };

    const answer = await createTestPhoneHandlers(deps).testPhoneParts(
      pageRequest("testPhoneParts", PARTS_FIXTURE.request),
    );

    expect(answer).toEqual(PARTS_FIXTURE.outcome);
    expect(k21Problems({ ...PARTS_FIXTURE, outcome: answer })).toEqual([]);
    expect(emails.asked).toEqual([{ to: ALEX_EMAIL }]);
    expect(phones.asked).toEqual([TP03.number]);
    expect(gateway).not.toHaveBeenCalled();
    expect(touched).toEqual([]);
  });
});

describe("outside staging both calls answer stagingOnly and reach no tool code", () => {
  // The Worker's ENVIRONMENT is "production" there; any value but exactly "staging" is refused the same way.
  const ELSEWHERE = ["production", "", "Staging", "STAGING", "staging ", " staging", "preview", "test"];
  const CALLS: [TestPhoneCall, Exchange][] = [
    ["testPhoneSend", SEND_FIXTURE],
    ["testPhoneParts", PARTS_FIXTURE],
  ];

  for (const [call, fixture] of CALLS) {
    it.each(ELSEWHERE)(
      `${call} with ENVIRONMENT %j answers stagingOnly, reading nothing and reaching no port`,
      async (environment) => {
        const touched: string[] = [];
        const deps: TestPhoneDeps = tripwire("deps", touched);
        const handlers = createTestPhoneHandlers(deps);
        const page: PageRequest = {
          call,
          request: tripwire("request", touched),
          trace: tripwire("trace", touched),
          environment,
        };

        const answer = await handlers[call](page);

        // K-21's one answer outside staging, as fire-now-in-production.json gives it for every staging-only call.
        expect(answer).toEqual(FIRE_NOW_IN_PRODUCTION.outcome);
        expect(answer).toEqual({ error: "stagingOnly" });
        expect(touched).toEqual([]);
        // K-21 v1 accepts it as the call's production outcome, and refuses the fixture's staging answer there (the pattern
        // of invalid/refuse-fire-now-in-production.json).
        const production = { ...fixture, given: { ...fixture.given, environment: "production" } };
        expect(k21Problems({ ...production, outcome: answer })).toEqual([]);
        expect(k21Problems(production)).not.toEqual([]);
      },
    );
  }

  it("the refused fixture's pattern holds: refuse-fire-now-in-production.json is refused by K-21 v1, its fixed twin accepted", () => {
    expect(k21Problems(k21Fixture("invalid/refuse-fire-now-in-production.json"))).not.toEqual([]);
    expect(k21Problems(FIRE_NOW_IN_PRODUCTION)).toEqual([]);
  });

  it("the handlers' own staging is exactly the Worker's staging ENVIRONMENT", () => {
    expect(STAGING_ENVIRONMENT).toBe("staging");
    expect(CALLS.map(([call]) => call)).toEqual(["testPhoneSend", "testPhoneParts"]);
  });
});

describe("a send as a phone that is not a seeded test phone is refused", () => {
  // A roster id the roster does not hold, a number or last four digits in place of a roster id, another case.
  const NOT_SEEDED = ["tp-99", "+15555550104", "0104", "TP-04", "tp-04 "];

  async function refusedDeps(touched: string[]): Promise<{
    deps: TestPhoneDeps;
    gateway: ReturnType<typeof unreachedGateway>;
    roster: ReturnType<typeof fakeRoster>;
  }> {
    const gateway = unreachedGateway();
    const roster = fakeRoster();
    return {
      gateway,
      roster,
      deps: {
        access: await testerAccess(),
        roster,
        phones: tripwire("phones", touched),
        linqWebhooks: tripwire("linqWebhooks", touched),
        gateway,
        parts: tripwire("parts", touched),
        emails: tripwire("emails", touched),
        now: () => Date.parse(SEND_FIXTURE.given.now),
        ids: () => Promise.reject(new Error("no ids are made for a refused send")),
      },
    };
  }

  it.each(NOT_SEEDED)(
    "testPhoneSend as %j answers notTestPhone: nothing is signed or posted",
    async (testPhoneId) => {
      const touched: string[] = [];
      const { deps, gateway, roster } = await refusedDeps(touched);

      const answer = await testPhoneSend(pageRequest("testPhoneSend", sendRequest({ testPhoneId })), deps);

      expect(answer).toEqual({ error: "notTestPhone", testPhoneId });
      expect(k21Problems(answer, "testPhoneSend.errors")).toEqual([]);
      expect(roster.asked).toEqual([testPhoneId]);
      expect(gateway).not.toHaveBeenCalled();
      expect(touched).toEqual([]);
    },
  );

  it.each(NOT_SEEDED)(
    "testPhoneParts for %j answers notTestPhone: no double's record and no phone is read",
    async (testPhoneId) => {
      const touched: string[] = [];
      const { deps, gateway } = await refusedDeps(touched);

      const answer = await testPhoneParts(pageRequest("testPhoneParts", partsRequest({ testPhoneId })), deps);

      expect(answer).toEqual({ error: "notTestPhone", testPhoneId });
      expect(k21Problems(answer, "testPhoneParts.errors")).toEqual([]);
      expect(gateway).not.toHaveBeenCalled();
      expect(touched).toEqual([]);
    },
  );

  it("every phone the roster holds is sent as, by its own number", async () => {
    const secret = testWebhookSecret();
    for (const phone of ROSTER) {
      const gateway = fakeGateway({
        secret,
        receivedAt: SEND_FIXTURE.given.now,
        traceId: "trace-gateway-0001",
      });
      const deps: TestPhoneDeps = {
        access: await testerAccess(),
        roster: fakeRoster(),
        phones: fakePhoneStates(new Map()),
        linqWebhooks: createLinqWebhookDouble({ secret }),
        gateway: gateway.entry,
        parts: { partsTo: () => [] },
        emails: recordedEmails([]),
        now: () => Date.parse(SEND_FIXTURE.given.now),
      };
      const answer = await testPhoneSend(
        pageRequest("testPhoneSend", sendRequest({ testPhoneId: phone.testPhoneId })),
        deps,
      );
      expect(answer).toMatchObject({ result: "sent", gatewayStatus: 200 });
      const verified = gateway.posted[0]?.verified;
      expect(verified?.result === "event" ? verified.event.handle.address : null).toBe(phone.number);
    }
  });
});

describe("who may call: a signed-in roster tester or a person on Rosie's team", () => {
  async function checkedDeps(
    standing: [string, TesterStanding][],
    touched: string[],
  ): Promise<TestPhoneDeps> {
    return {
      access: fakeAccess(await standings(standing)),
      roster: tripwire("roster", touched),
      phones: tripwire("phones", touched),
      linqWebhooks: tripwire("linqWebhooks", touched),
      gateway: unreachedGateway(),
      parts: tripwire("parts", touched),
      emails: tripwire("emails", touched),
    };
  }

  const CASES: [PageCallName, Record<string, unknown>][] = [
    ["testPhoneSend", sendRequest()],
    ["testPhoneParts", partsRequest()],
  ];

  for (const [call, request] of CASES) {
    const handle = call === "testPhoneSend" ? testPhoneSend : testPhoneParts;
    const errors = `${call}.errors`;

    it(`${call} with no session token answers signInNeeded, asking no one`, async () => {
      const touched: string[] = [];
      const deps = {
        ...(await checkedDeps([], touched)),
        access: tripwire("access", touched),
      };
      for (const page of [
        withToken(request, null),
        { ...request, page: { requestId: "req-1", traceId: "t-1" } },
      ]) {
        const answer = await handle(pageRequest(call, page), deps);
        expect(answer).toEqual({ error: "signInNeeded" });
        expect(k21Problems(answer, errors)).toEqual([]);
      }
      expect(touched).toEqual([]);
    });

    it(`${call} with a token no live session has answers signInNeeded`, async () => {
      const touched: string[] = [];
      const deps = await checkedDeps([[TESTER_TOKEN, "tester"]], touched);
      const answer = await handle(
        pageRequest(call, withToken(request, "placeholder-session-token-ended-0009")),
        deps,
      );
      expect(answer).toEqual({ error: "signInNeeded" });
      expect(touched).toEqual([]);
    });

    it(`${call} for a person neither on the roster's testers nor on Rosie's team answers notTester`, async () => {
      const touched: string[] = [];
      const deps = await checkedDeps([[TESTER_TOKEN, "notTester"]], touched);
      const answer = await handle(pageRequest(call, request), deps);
      expect(answer).toEqual({ error: "notTester" });
      expect(k21Problems(answer, errors)).toEqual([]);
      expect(touched).toEqual([]);
    });

    it(`${call} admits only a session the access port says is a tester's: any other answer is notTester`, async () => {
      const touched: string[] = [];
      const deps = {
        ...(await checkedDeps([], touched)),
        access: { standing: () => Promise.resolve("maybe" as TesterStanding) },
      };
      expect(await handle(pageRequest(call, request), deps)).toEqual({ error: "notTester" });
      expect(touched).toEqual([]);
    });

    it(`${call} hands the access port the token's sha256, never the token`, async () => {
      const access = fakeAccess(new Map());
      const touched: string[] = [];
      await handle(pageRequest(call, request), { ...(await checkedDeps([], touched)), access });
      expect(access.asked).toHaveLength(1);
      expect(access.asked[0]?.tokenSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(JSON.stringify(access.asked)).not.toContain(TESTER_TOKEN);
    });
  }
});

describe("a request that is not K-21 v1's gives no outcome", () => {
  const CASES: [PageCallName, Record<string, unknown>][] = [
    ["testPhoneSend", sendRequest({ words: "" })],
    ["testPhoneSend", sendRequest({ number: "+15555550104" })],
    ["testPhoneSend", sendRequest({ threadedReplyTo: 7 })],
    ["testPhoneParts", partsRequest({ since: "yesterday" })],
    ["testPhoneParts", partsRequest({ since: "2026-02-30T14:06:00Z" })],
    ["testPhoneParts", partsRequest({ testPhoneId: "" })],
  ];

  it.each(CASES)(
    "%s: TestPhoneError badRequest, naming fields only, before any port",
    async (call, request) => {
      const touched: string[] = [];
      const deps: TestPhoneDeps = tripwire("deps", touched);
      const handle = call === "testPhoneSend" ? testPhoneSend : testPhoneParts;

      const failure: unknown = await handle(pageRequest(call, request), deps).then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(TestPhoneError);
      const error = failure as TestPhoneError;
      expect(error.code).toBe("badRequest");
      expect(error.problems.length).toBeGreaterThan(0);
      expect(isLabel(error.name)).toBe(true);
      for (const value of ["+15555550104", "yesterday", "2026-02-30", TESTER_TOKEN, "Saturday"])
        expect(`${error.message} ${error.problems.join(" ")}`).not.toContain(value);
      expect(touched).toEqual([]);
    },
  );

  it("a handler handed the other call's request gives no outcome (a wiring fault)", async () => {
    const deps: TestPhoneDeps = tripwire("deps", []);
    await expect(testPhoneSend(pageRequest("testPhoneParts", partsRequest()), deps)).rejects.toMatchObject({
      code: "wrongCall",
    });
    await expect(testPhoneParts(pageRequest("testPhoneSend", sendRequest()), deps)).rejects.toMatchObject({
      code: "wrongCall",
    });
  });
});

describe("testPhoneSend: what the gateway answered", () => {
  async function sendWith(gatewayOptions: {
    secret: string;
    status?: number;
    noTraceHeader?: boolean;
  }): Promise<{ answer: Promise<unknown>; posted: ReturnType<typeof fakeGateway>["posted"] }> {
    const gateway = fakeGateway({
      receivedAt: SEND_FIXTURE.given.now,
      traceId: "trace-gateway-0002",
      ...gatewayOptions,
    });
    const deps: TestPhoneDeps = {
      access: await testerAccess(),
      roster: fakeRoster(),
      phones: fakePhoneStates(new Map()),
      linqWebhooks: createLinqWebhookDouble({ secret: testWebhookSecret() }),
      gateway: gateway.entry,
      parts: { partsTo: () => [] },
      emails: recordedEmails([]),
      now: () => Date.parse(SEND_FIXTURE.given.now),
    };
    return {
      answer: testPhoneSend(pageRequest("testPhoneSend", sendRequest()), deps),
      posted: gateway.posted,
    };
  }

  it("a gateway whose secret is not the double's answers 401: sent, with that status and the gateway's trace", async () => {
    const { answer, posted } = await sendWith({ secret: testWebhookSecret() });
    const sent = await answer;
    expect(sent).toMatchObject({ result: "sent", traceId: "trace-gateway-0002", gatewayStatus: 401 });
    expect(k21Problems(sent, "testPhoneSend.response")).toEqual([]);
    expect(posted[0]?.verified).toEqual({ result: "rejected", httpStatus: 401, reason: "badSignature" });
  });

  it("a gateway that could not write answers 503: sent, with that status", async () => {
    const { answer } = await sendWith({ secret: testWebhookSecret(), status: 503 });
    const sent = await answer;
    expect(sent).toMatchObject({ result: "sent", gatewayStatus: 503 });
    expect(k21Problems(sent, "testPhoneSend.response")).toEqual([]);
  });

  it.each([404, 400, 500, 202])("a gateway answer of %i has no place in K-21: no outcome", async (status) => {
    const { answer } = await sendWith({ secret: testWebhookSecret(), status });
    await expect(answer).rejects.toMatchObject({ name: "TestPhoneError", code: "gatewayStatus" });
  });

  it("a gateway answer with no trace id gives no outcome", async () => {
    const { answer } = await sendWith({ secret: testWebhookSecret(), noTraceHeader: true });
    await expect(answer).rejects.toMatchObject({ name: "TestPhoneError", code: "gatewayTrace" });
  });
});

describe("testPhoneSend: a repeat of one submit sends the same event, which the gateway drops", () => {
  it("one requestId makes one event id; another submit, or another session, makes another; one phone keeps one chat", async () => {
    const secret = testWebhookSecret();
    const gateway = fakeGateway({
      secret,
      receivedAt: SEND_FIXTURE.given.now,
      traceId: "trace-gateway-0003",
    });
    const otherToken = "placeholder-session-token-tester-0002";
    const deps: TestPhoneDeps = {
      access: fakeAccess(
        await standings([
          [TESTER_TOKEN, "tester"],
          [otherToken, "tester"],
        ]),
      ),
      roster: fakeRoster(),
      phones: fakePhoneStates(new Map()),
      linqWebhooks: createLinqWebhookDouble({ secret }),
      gateway: gateway.entry,
      parts: { partsTo: () => [] },
      emails: recordedEmails([]),
      now: () => Date.parse(SEND_FIXTURE.given.now),
    };
    const send = async (request: Record<string, unknown>): Promise<string> => {
      const answer = await testPhoneSend(pageRequest("testPhoneSend", request), deps);
      return (answer as { eventId: string }).eventId;
    };

    const withRequestId = (
      requestId: string,
      changes: Record<string, unknown> = {},
    ): Record<string, unknown> =>
      sendRequest({ ...changes, page: { ...(SEND_FIXTURE.request.page as object), requestId } });

    const first = await send(sendRequest());
    const repeat = await send(sendRequest());
    const nextSubmit = await send(withRequestId("req-testphone-0099"));
    const otherSession = await send(withToken(sendRequest(), otherToken));
    const otherPhone = await send(withRequestId("req-testphone-0100", { testPhoneId: "tp-03" }));
    // The requestId is the key (K-21 v1 testPhoneSend.request "Repeat"): the same one again, even naming another phone,
    // is a repeat of the first submit, and answers its event.
    const reusedKey = await send(sendRequest({ testPhoneId: "tp-03" }));

    expect(repeat).toBe(first);
    expect(reusedKey).toBe(first);
    expect(new Set([first, nextSubmit, otherSession, otherPhone]).size).toBe(4);
    const events = gateway.posted.map((posted) =>
      posted.verified.result === "event" ? posted.verified.event : null,
    );
    expect(events.map((event) => event?.eventId)).toEqual([
      first,
      first,
      nextSubmit,
      otherSession,
      otherPhone,
      first,
    ]);
    // Every send as tp-04 lands in one chat; tp-03's is its own.
    const chats = events.map((event) => event?.chatId);
    expect(new Set(chats.slice(0, 4)).size).toBe(1);
    expect(chats[4]).not.toBe(chats[0]);
    expect(chats[5]).toBe(chats[4]);
    // Each id is a label (K-08: it may stand in a span) and carries neither the number, the words nor the token.
    for (const event of events) {
      for (const id of [event?.eventId, event?.messageId, event?.chatId]) {
        expect(isLabel(id)).toBe(true);
        for (const secretValue of ["5555550104", "5555550101", "0104", "Saturday", TESTER_TOKEN])
          expect(id).not.toContain(secretValue);
      }
    }
  });
});

describe("testPhoneParts: the doubles' own records, as the page lists them", () => {
  const STATES = new Map<string, PhoneState>([
    [TP03.number, { chatOpen: true, stopped: true, stoppedAt: "2026-10-23T14:10:00Z", chatLink: null }],
  ]);

  it("each part the real Linq double recorded to that phone, in order, once per key, with its time and answer", async () => {
    const double = createLinqDouble({ now: () => "2026-10-23T14:05:00Z" });
    // The recorder's own clock moves a second at each part it keeps.
    let second = 0;
    const recorder = createPartsRecorder(double, {
      now: () => `2026-10-23T14:05:${String((second += 1)).padStart(2, "0")}Z`,
    });
    const text = k11Fixture("send-text.json").request;
    const poll = k11Fixture("send-poll.json").request;
    const typing = k11Fixture("send-typing.json").request;
    const sixOptions = k11Fixture("invalid/refuse-poll-six-options.json").request;
    const toTp04: SendPartRequest = { ...text, idempotencyKey: "out-tp04/1/1", to: TP04.number };

    const answers: SendPartOutcome[] = [];
    for (const request of [text, text, poll, typing, typing, toTp04, sixOptions])
      answers.push(await recorder.sendPart(request));

    const deps: TestPhoneDeps = {
      access: await testerAccess(),
      roster: fakeRoster(),
      phones: fakePhoneStates(STATES),
      linqWebhooks: tripwire("linqWebhooks", []),
      gateway: unreachedGateway(),
      parts: recorder,
      emails: recordedEmails([]),
    };
    const answer = (await testPhoneParts(pageRequest("testPhoneParts", partsRequest()), deps)) as {
      parts: { at: string; sent: SendPartRequest; outcome: SendPartOutcome }[];
    };

    expect(k21Problems(answer, "testPhoneParts.response")).toEqual([]);
    // The double's own record for tp-03, in its order: the text once (the repeat under its key was dropped), the poll,
    // and each typing call; never tp-04's part or the request K-11 refuses.
    const record = double.sentRequests().filter((part) => part.to === TP03.number);
    expect(answer.parts.map((part) => part.sent)).toEqual(record);
    expect(answer.parts.map((part) => part.sent.kind)).toEqual(["words", "poll", "typing", "typing"]);
    // Each with the double's answer to it and the moment of that answer.
    expect(answer.parts.map((part) => part.outcome)).toEqual([
      answers[0],
      answers[2],
      answers[3],
      answers[4],
    ]);
    expect(answer.parts.map((part) => part.at)).toEqual([
      "2026-10-23T14:05:01Z",
      "2026-10-23T14:05:02Z",
      "2026-10-23T14:05:03Z",
      "2026-10-23T14:05:04Z",
    ]);
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[6]).toMatchObject({ result: "failed", kind: "refused" });
    expect(double.rejectedRequests()).toHaveLength(1);
  });

  it("the real email double's emails to the phone's own person only, as K-21 lists them, and the phone's stop state", async () => {
    const email = createEmailDouble({ now: () => "2026-10-23T14:05:06Z", webhookSecret: testWebhookSecret });
    const copy = { ...k12SendRequest("send-copy-of-text.json"), to: ALEX_EMAIL };
    expect(await email.sendEmail(copy)).toMatchObject({ result: "accepted" });
    expect(await email.sendEmail(k12SendRequest("send-code.json"))).toMatchObject({ result: "accepted" });

    const deps: TestPhoneDeps = {
      access: await testerAccess(),
      roster: fakeRoster(),
      phones: fakePhoneStates(STATES),
      linqWebhooks: tripwire("linqWebhooks", []),
      gateway: unreachedGateway(),
      parts: { partsTo: () => [] },
      emails: email,
    };
    const answer = await testPhoneParts(pageRequest("testPhoneParts", partsRequest()), deps);

    expect(answer).toEqual({
      result: "parts",
      phone: {
        testPhoneId: "tp-03",
        last4: "0101",
        chatOpen: true,
        stopped: true,
        stoppedAt: "2026-10-23T14:10:00Z",
      },
      chatLink: null,
      parts: [],
      emails: [{ at: "2026-10-23T14:05:06Z", to: ALEX_EMAIL, subject: copy.subject, text: copy.text }],
    });
    expect(k21Problems(answer, "testPhoneParts.response")).toEqual([]);
  });

  it("a phone whose person has no email on file reads no email (an address of null would list everyone's)", async () => {
    const emails = recordedEmails([]);
    const deps: TestPhoneDeps = {
      access: await testerAccess(),
      roster: fakeRoster(),
      phones: fakePhoneStates(new Map()),
      linqWebhooks: tripwire("linqWebhooks", []),
      gateway: unreachedGateway(),
      parts: { partsTo: () => [] },
      emails,
    };
    const answer = await testPhoneParts(
      pageRequest("testPhoneParts", partsRequest({ testPhoneId: "tp-04" })),
      deps,
    );
    expect(answer).toEqual({
      result: "parts",
      phone: { testPhoneId: "tp-04", last4: "0104", chatOpen: false, stopped: false, stoppedAt: null },
      chatLink: null,
      parts: [],
      emails: [],
    });
    expect(TP04.email).toBeNull();
    expect(emails.asked).toEqual([]);
  });

  it("since: only the parts and emails after that moment", async () => {
    const text = k11Fixture("send-text.json");
    const poll = k11Fixture("send-poll.json");
    const moments = [text.given.now, poll.given.now];
    const recorder = createPartsRecorder(scriptedLinqDouble([text.outcome, poll.outcome]), {
      now: () => moments.shift() ?? "",
    });
    await recorder.sendPart(text.request);
    await recorder.sendPart(poll.request);
    const email = createEmailDouble({ now: () => "2026-10-23T14:05:06Z", webhookSecret: testWebhookSecret });
    await email.sendEmail({ ...k12SendRequest("send-copy-of-text.json"), to: ALEX_EMAIL });
    const deps: TestPhoneDeps = {
      access: await testerAccess(),
      roster: fakeRoster(),
      phones: fakePhoneStates(new Map()),
      linqWebhooks: tripwire("linqWebhooks", []),
      gateway: unreachedGateway(),
      parts: recorder,
      emails: email,
    };
    /** The moments of the parts and emails listed after `since`. */
    const after = async (since: string | null): Promise<{ parts: string[]; emails: string[] }> => {
      const answer = await testPhoneParts(pageRequest("testPhoneParts", partsRequest({ since })), deps);
      expect(k21Problems(answer, "testPhoneParts.response")).toEqual([]);
      const listed = answer as { parts: { at: string }[]; emails: { at: string }[] };
      return { parts: listed.parts.map((part) => part.at), emails: listed.emails.map((each) => each.at) };
    };

    expect(await after(null)).toEqual({
      parts: [text.given.now, poll.given.now],
      emails: ["2026-10-23T14:05:06Z"],
    });
    // Strictly after: the text's own moment leaves the poll and the email.
    expect(await after(text.given.now)).toEqual({
      parts: [poll.given.now],
      emails: ["2026-10-23T14:05:06Z"],
    });
    expect(await after("2026-10-23T14:05:05.5Z")).toEqual({ parts: [], emails: ["2026-10-23T14:05:06Z"] });
    expect(await after("2026-10-23T14:05:06Z")).toEqual({ parts: [], emails: [] });
  });
});
