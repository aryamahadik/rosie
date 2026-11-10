// T-565 inside the Workers runtime (workerd), where T-1186 joins the two calls to the Worker's page entry. With the
// Worker's own ENVIRONMENT (wrangler.jsonc env.staging), test-phone-send.json gives its response: the real Linq double
// signs, and T-413's verify, standing in for the gateway's, gives back K-06 test-phone-page.json; testPhoneParts lists
// what the parts recorder kept of the real Linq double's sends and the real email double's email. The K-21 checks, the
// token's sha256, the signing and the recorder make no code from strings (workerd refuses Function and eval when it
// serves a request; this pool's workerd does not, so the test traps both, as validator.worker.test.ts does, and the trap
// counts no call). With ENVIRONMENT "production" both calls answer stagingOnly and reach nothing. Values come only from
// the contracts' fixtures (rule 9); the webhook secret is made up for the run.

import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createEmailDouble } from "@rosie/adapters/email/double";
import { createLinqDouble } from "@rosie/adapters/linq/double";
import { createLinqWebhookDouble } from "@rosie/adapters/linq/double-webhooks";
import { createLinqWebhookVerifier, type VerifyWebhookResult } from "@rosie/adapters/linq/webhook";

import testPhonePage from "../../../../../contracts/inbound-event/fixtures/test-phone-page.json";
import testPhoneParts from "../../../../../contracts/page-api/fixtures/test-phone-parts.json";
import testPhoneSend from "../../../../../contracts/page-api/fixtures/test-phone-send.json";
import sendCopy from "../../../../../contracts/port-email/fixtures/send-copy-of-text.json";
import sendText from "../../../../../contracts/port-linq/fixtures/send-text.json";
import type { PageCallName, PageRequest } from "../../../../../runtime/src/gateway";
import { DEFAULT_BUNDLE_ID } from "../../../../../runtime/src/gateway/answer";
import { openTrace } from "../../../../../runtime/src/trace";
import { createTestPhoneHandlers } from "./handlers";
import { sha256Hex } from "./ids";
import { createPartsRecorder } from "./parts";
import type { RosterPhone, TestPhoneDeps } from "./types";

const TOKEN = testPhoneSend.request.page.sessionToken;
const ALEX = "alex.m@example.com";
const ROSTER: RosterPhone[] = [
  { testPhoneId: "tp-03", number: sendText.request.to, email: ALEX },
  { testPhoneId: "tp-04", number: testPhonePage.handle.address, email: null },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Traps Function and eval until the test ends, as validator.worker.test.ts does: each call is counted, then made. */
function trapCodeFromStrings(): { readonly calls: string[] } {
  const calls: string[] = [];
  const realFunction = globalThis.Function;
  const realEval = globalThis.eval;
  vi.stubGlobal(
    "Function",
    new Proxy(realFunction, {
      construct(target, args, newTarget) {
        calls.push("new Function");
        return Reflect.construct(target, args, newTarget) as object;
      },
      apply(target, self, args) {
        calls.push("Function()");
        return Reflect.apply(target, self, args) as unknown;
      },
    }),
  );
  vi.stubGlobal(
    "eval",
    new Proxy(realEval, {
      apply(target, self, args) {
        calls.push("eval()");
        return Reflect.apply(target, self, args) as unknown;
      },
    }),
  );
  return { calls };
}

function page(
  call: PageCallName,
  request: Readonly<Record<string, unknown>>,
  environment: string,
): PageRequest {
  return {
    call,
    request,
    trace: openTrace({ openedBy: "pageRequest", bundleId: DEFAULT_BUNDLE_ID, incomingTraceId: null }),
    environment,
  };
}

function secret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `whsec_${btoa(String.fromCharCode(...bytes))}`;
}

async function baseDeps(webhookSecret: string): Promise<Omit<TestPhoneDeps, "gateway" | "parts" | "emails">> {
  const tester = await sha256Hex(TOKEN);
  return {
    access: { standing: (hash) => Promise.resolve(hash === tester ? "tester" : "noSession") },
    roster: {
      phone: (testPhoneId) =>
        Promise.resolve(ROSTER.find((phone) => phone.testPhoneId === testPhoneId) ?? null),
    },
    phones: {
      state: () =>
        Promise.resolve({
          chatOpen: true,
          stopped: false,
          stoppedAt: null,
          chatLink: testPhoneParts.outcome.chatLink,
        }),
    },
    linqWebhooks: createLinqWebhookDouble({ secret: webhookSecret }),
  };
}

describe("the test-phone calls in workerd", () => {
  it("with the Worker's staging ENVIRONMENT, test-phone-send.json gives its response and makes no code from strings", async () => {
    expect(env.ENVIRONMENT).toBe("staging");
    const webhookSecret = secret();
    const verifier = createLinqWebhookVerifier({ secret: () => webhookSecret });
    const verified: VerifyWebhookResult[] = [];
    const trap = trapCodeFromStrings();
    const deps: TestPhoneDeps = {
      ...(await baseDeps(webhookSecret)),
      gateway: async (request) => {
        verified.push(
          await verifier.verifyWebhook({
            webhookId: request.headers.get("webhook-id") ?? "",
            timestamp: request.headers.get("webhook-timestamp") ?? "",
            signature: request.headers.get("webhook-signature") ?? "",
            raw: await request.text(),
            receivedAt: testPhoneSend.given.now,
            traceId: testPhoneSend.outcome.traceId,
          }),
        );
        return new Response("{}", { status: 200, headers: { "x-trace-id": testPhoneSend.outcome.traceId } });
      },
      parts: { partsTo: () => [] },
      emails: createEmailDouble({ webhookSecret: secret }),
      now: () => Date.parse(testPhoneSend.given.now),
      ids: () =>
        Promise.resolve({
          eventId: testPhonePage.eventId,
          messageId: testPhonePage.messageId,
          chatId: testPhonePage.chatId,
        }),
    };

    const answer = await createTestPhoneHandlers(deps).testPhoneSend(
      page("testPhoneSend", testPhoneSend.request, env.ENVIRONMENT),
    );

    expect(answer).toEqual(testPhoneSend.outcome);
    expect(verified).toEqual([{ result: "event", httpStatus: 200, event: testPhonePage, partKey: null }]);
    expect(trap.calls).toEqual([]);
  });

  it("with the Worker's staging ENVIRONMENT, testPhoneParts lists the real doubles' records for the phone", async () => {
    const webhookSecret = secret();
    const trap = trapCodeFromStrings();
    const recorder = createPartsRecorder(createLinqDouble({ now: () => sendText.given.now }), {
      now: () => sendText.given.now,
    });
    const sent = await recorder.sendPart(sendText.request);
    const emails = createEmailDouble({ now: () => "2026-10-23T14:05:06Z", webhookSecret: secret });
    await emails.sendEmail({ ...sendCopy.request, to: ALEX });
    const deps: TestPhoneDeps = {
      ...(await baseDeps(webhookSecret)),
      gateway: () => Promise.reject(new Error("the gateway was reached")),
      parts: recorder,
      emails,
      now: () => Date.parse(testPhoneParts.given.now),
    };

    const answer = await createTestPhoneHandlers(deps).testPhoneParts(
      page("testPhoneParts", testPhoneParts.request, env.ENVIRONMENT),
    );

    expect(answer).toEqual({
      result: "parts",
      phone: { testPhoneId: "tp-03", last4: "0101", chatOpen: true, stopped: false, stoppedAt: null },
      chatLink: testPhoneParts.outcome.chatLink,
      parts: [{ at: sendText.given.now, sent: sendText.request, outcome: sent }],
      emails: [
        {
          at: "2026-10-23T14:05:06Z",
          to: ALEX,
          subject: sendCopy.request.subject,
          text: sendCopy.request.text,
        },
      ],
    });
    expect(sent).toMatchObject({ result: "accepted" });
    expect(trap.calls).toEqual([]);
  });

  it("with ENVIRONMENT production both calls answer stagingOnly and reach nothing", async () => {
    const touched: string[] = [];
    const deps = new Proxy<Record<string, never>>(
      {},
      {
        get(_target, key) {
          touched.push(String(key));
          throw new Error("a port was reached");
        },
      },
    ) as unknown as TestPhoneDeps;
    const handlers = createTestPhoneHandlers(deps);

    expect(
      await handlers.testPhoneSend({ ...page("testPhoneSend", testPhoneSend.request, "production") }),
    ).toEqual({ error: "stagingOnly" });
    expect(
      await handlers.testPhoneParts({ ...page("testPhoneParts", testPhoneParts.request, "production") }),
    ).toEqual({ error: "stagingOnly" });
    expect(touched).toEqual([]);
  });
});
