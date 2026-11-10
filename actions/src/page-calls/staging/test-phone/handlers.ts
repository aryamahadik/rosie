// The test-phone page's two server calls (T-565; C-074, C-205; K-21 v1 testPhoneSend and testPhoneParts; build prompt 9.4
// 'The test-phone page'), each a handler of the gateway's page entry (runtime/src/gateway/pages, T-266): the call, its
// request, the trace the entry opened and the Worker's ENVIRONMENT in; the call's K-21 outcome out.
//
// Staging only. Wherever ENVIRONMENT is not exactly "staging", each answers K-21's stagingOnly at once: its request is not
// read and no port is reached (BP 9.4 'Never in production'; K-21 v1 README default 15; fire-now-in-production.json). The
// page entry refuses both there before any handler runs (T-266); this is the handlers' own refusal besides.
//
// On staging, in this order (K-21 v1 README "Who may call" and "Staging only"):
//   1. a page with no session token answers signInNeeded;
//   2. a request that is not K-21 v1's gives no outcome (TestPhoneError badRequest: the entry answers 503, nothing done);
//   3. the session, by its token's sha256 (K-22 v1 session_for_token): none live answers signInNeeded; a person neither
//      on the roster's testers nor on Rosie's team answers notTester;
//   4. the phone, by the roster's id (Q-53): not a seeded test phone answers notTestPhone, with nothing signed, posted
//      or read;
//   5. testPhoneSend: the server builds the K-06 v1 text event for the roster's number, the Linq double signs it as Linq
//      would (K-11 v1 doubleWebhook, T-412), and it is posted to the gateway's Linq entry; the answer is the event's id,
//      the trace the gateway opened at receipt (its x-trace-id) and the gateway's status. The page never holds a webhook
//      secret or a number (K-21 v1 testPhoneSend.request). A repeat of one submit makes the same event id (./ids.ts),
//      which the gateway drops as known.
//      testPhoneParts: each part the Linq double recorded to that number, in order, with its time and its answer
//      (./parts.ts); the email double's emails to the phone's own person (K-12 v1 doubleSentEmails, T-418); the phone's
//      stop state and chat link; each after `since` when it is set.
//
// Neither call makes a K-09 call, so no caller.traceId is built; the event the double signs names the entry's trace
// (`trace.traceId`), never the envelope's page.traceId. Nothing here logs or writes a span: never the words, the token,
// a number, an email or the doubles' records, which hold whole messages by design and go only into this staging answer.

import type { InboundEvent, VerifyWebhookRequest } from "@rosie/adapters/linq/webhook";

import type { PageHandler, PageOutcome, PageRequest } from "../../../../../runtime/src/gateway";
import { TestPhoneError } from "./errors";
import { defaultSendIds, sha256Hex } from "./ids";
import {
  isId,
  lacksSessionToken,
  testPhonePartsProblems,
  testPhoneSendProblems,
  type SignedInPage,
  type TestPhonePartsRequest,
  type TestPhoneSendRequest,
} from "./request";
import type {
  NotTestPhone,
  NotTester,
  RecordedEmail,
  RosterPhone,
  SignInNeeded,
  StagingOnly,
  TestPhoneDeps,
  TestPhoneParts,
  TestPhoneSent,
} from "./types";

/** The one ENVIRONMENT these calls run in (wrangler.jsonc env.staging); any other value is refused, "" and "Staging" too. */
export const STAGING_ENVIRONMENT = "staging";

/**
 * Where the signed webhook is posted: a placeholder address on a reserved host (RFC 2606). The gateway's Linq entry the
 * root hands in (TestPhoneDeps.gateway) reads the method, the three signature headers and the body, never the address.
 */
export const TEST_PHONE_WEBHOOK_URL = "https://test-phone.invalid/webhooks/linq";

/** The calls served here (K-21 v1 `$defs/stagingOnlyCall`). */
export type TestPhoneCall = "testPhoneSend" | "testPhoneParts";

/** A roster number Linq could send to: E.164, + and 7 to 15 digits. */
const E164 = /^\+[1-9][0-9]{6,14}$/u;

/** How long before the gateway's receipt the phone sent the text (K-06 v1 test-phone-page.json: one second). */
const SENT_BEFORE_RECEIPT_MS = 1_000;

/** The two handlers, for the page entry's handlers (runtime/src/gateway GatewayDeps.pages). */
export interface TestPhoneHandlers {
  readonly testPhoneSend: PageHandler;
  readonly testPhoneParts: PageHandler;
}

/** Both handlers over one set of ports: the doubles they read must be the ones staging's send paths use. */
export function createTestPhoneHandlers(deps: TestPhoneDeps): TestPhoneHandlers {
  return {
    testPhoneSend: (page) => testPhoneSend(page, deps),
    testPhoneParts: (page) => testPhoneParts(page, deps),
  };
}

/** An instant as K-06 and the Linq double write it: RFC 3339 UTC, whole seconds, ending in Z. */
const utcSeconds = (ms: number): string => new Date(ms).toISOString().replace(/[.][0-9]+Z$/u, "Z");

const stagingOnly = (): PageOutcome => ({ error: "stagingOnly" }) satisfies StagingOnly;

const signInNeeded = (): PageOutcome => ({ error: "signInNeeded" }) satisfies SignInNeeded;

/** What the checks of steps 1 to 4 found: the phone and session to act for. */
interface Admitted {
  readonly phone: RosterPhone;
  readonly tokenSha256: string;
  readonly nowMs: number;
}

/** Admitted, or the refusal the call answers (signInNeeded, notTester or notTestPhone). */
type Admission = { readonly admitted: Admitted } | { readonly refusal: PageOutcome };

/** Steps 1 to 4, which both calls make before anything else is read. */
async function admit(
  page: PageRequest,
  call: TestPhoneCall,
  problemsOf: (request: unknown) => string[],
  deps: TestPhoneDeps,
): Promise<Admission> {
  if (page.call !== call) throw new TestPhoneError("wrongCall");
  if (lacksSessionToken(page.request)) return { refusal: signInNeeded() };
  const problems = problemsOf(page.request);
  if (problems.length > 0) throw new TestPhoneError("badRequest", problems);
  const request = page.request as unknown as { readonly page: SignedInPage; readonly testPhoneId: string };

  const nowMs = (deps.now ?? Date.now)();
  const tokenSha256 = await sha256Hex(request.page.sessionToken);
  const standing = await deps.access.standing(tokenSha256, utcSeconds(nowMs));
  if (standing === "noSession") return { refusal: signInNeeded() };
  // Only an answer that says tester admits; any other is notTester.
  if (standing !== "tester") return { refusal: { error: "notTester" } satisfies NotTester };

  const phone = await deps.roster.phone(request.testPhoneId);
  if (phone === null)
    return { refusal: { error: "notTestPhone", testPhoneId: request.testPhoneId } satisfies NotTestPhone };
  if (!E164.test(phone.number)) throw new TestPhoneError("badRosterPhone");
  return { admitted: { phone, tokenSha256, nowMs } };
}

/** K-21 v1 testPhoneSend: a text as a chosen roster test phone, signed by the Linq double and posted to the gateway. */
export async function testPhoneSend(page: PageRequest, deps: TestPhoneDeps): Promise<PageOutcome> {
  if (page.environment !== STAGING_ENVIRONMENT) return stagingOnly();
  const admission = await admit(page, "testPhoneSend", testPhoneSendProblems, deps);
  if ("refusal" in admission) return admission.refusal;
  const { phone, tokenSha256, nowMs } = admission.admitted;
  const request = page.request as unknown as TestPhoneSendRequest;

  const ids = await (deps.ids ?? defaultSendIds)({ phone, tokenSha256, requestId: request.page.requestId });
  const event: InboundEvent = {
    eventId: ids.eventId,
    provider: "linq",
    handle: { kind: "phone", address: phone.number },
    // A test phone texts over iMessage, as K-06 v1 test-phone-page.json does and the Linq double's capability check says.
    service: "imessage",
    kind: "text",
    messageId: ids.messageId,
    chatId: ids.chatId,
    sentAt: utcSeconds(nowMs - SENT_BEFORE_RECEIPT_MS),
    receivedAt: utcSeconds(nowMs),
    body: request.words,
    scrubbed: { cards: 0, ssns: 0 },
    attachments: [],
    threadedReplyTo: request.threadedReplyTo,
    poll: null,
    reaction: null,
    edit: null,
    status: null,
    fromRosie: false,
    email: null,
    traceId: page.trace.traceId,
  };
  const webhook = await deps.linqWebhooks.sign({ event, partKey: null });
  const answer = await deps.gateway(webhookRequest(webhook));

  const gatewayStatus = answer.status;
  if (gatewayStatus !== 200 && gatewayStatus !== 401 && gatewayStatus !== 503)
    throw new TestPhoneError("gatewayStatus");
  const traceId = answer.headers.get("x-trace-id");
  if (!isId(traceId)) throw new TestPhoneError("gatewayTrace");
  return { result: "sent", eventId: ids.eventId, traceId, gatewayStatus } satisfies TestPhoneSent;
}

/** K-21 v1 testPhoneParts: what one roster test phone would have got, from the doubles' records and its own state. */
export async function testPhoneParts(page: PageRequest, deps: TestPhoneDeps): Promise<PageOutcome> {
  if (page.environment !== STAGING_ENVIRONMENT) return stagingOnly();
  const admission = await admit(page, "testPhoneParts", testPhonePartsProblems, deps);
  if ("refusal" in admission) return admission.refusal;
  const { phone } = admission.admitted;
  const request = page.request as unknown as TestPhonePartsRequest;

  const since = request.since === null ? null : Date.parse(request.since);
  const after = (at: string): boolean => since === null || Date.parse(at) > since;

  const parts = deps.parts.partsTo(phone.number).filter((part) => after(part.at));
  // No email on file for the phone's person: no email is read (an address of null would list every person's).
  const emails = phone.email === null ? [] : await emailsTo(phone.email, deps);
  const state = await deps.phones.state(phone.number);
  return {
    result: "parts",
    phone: {
      testPhoneId: phone.testPhoneId,
      last4: phone.number.slice(-4),
      chatOpen: state.chatOpen,
      stopped: state.stopped,
      stoppedAt: state.stoppedAt,
    },
    chatLink:
      state.chatLink === null
        ? null
        : {
            link: state.chatLink.link,
            readyText: state.chatLink.readyText,
            shortCode: state.chatLink.shortCode,
          },
    parts: parts.map((part) => ({ at: part.at, sent: part.sent, outcome: part.outcome })),
    emails: emails.filter((email) => after(email.at)),
  } satisfies TestPhoneParts;
}

/** The email double's emails to one address, oldest first, as K-21 v1 RecordedEmail lists them. */
async function emailsTo(address: string, deps: TestPhoneDeps): Promise<RecordedEmail[]> {
  const output = await deps.emails.doubleSentEmails({ to: address });
  return output.emails
    .filter((email) => email.request.to === address)
    .map((email) => ({
      at: email.recordedAt,
      to: email.request.to,
      subject: email.request.subject,
      text: email.request.text,
    }));
}

/** The signed webhook as Linq posts it: the three signature headers by Linq's names (K-11 README spike row 2), the body. */
function webhookRequest(webhook: VerifyWebhookRequest): Request {
  return new Request(TEST_PHONE_WEBHOOK_URL, {
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
