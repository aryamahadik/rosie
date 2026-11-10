// The test-phone page's two server calls (T-565; C-074, C-205; K-21 v1 testPhoneSend and testPhoneParts; build prompt 9.4
// 'The test-phone page'): what they answer and what they reach. The K-21 shapes are mirrored here by hand, as the doubles'
// types are, because the generated contract types are git-ignored (ADR-005); the tests hold every answer to K-21 v1's
// schema itself. Every port is handed in by the composition root (runtime/src/wiring, T-1186): nothing here opens a
// database, reads a key or logs.

import type { EmailDouble } from "@rosie/adapters/email/double";
import type { SendPartOutcome, SendPartRequest } from "@rosie/adapters/linq/double";
import type { LinqWebhookDouble } from "@rosie/adapters/linq/double-webhooks";

/**
 * A session's standing for staging's test tools (K-21 v1 README "Staging only": "a signed-in roster tester or a person on
 * Rosie's team"): noSession when no live session has the token, notTester when its person is neither.
 */
export type TesterStanding = "tester" | "notTester" | "noSession";

/** Who may use staging's test tools: the K-22 v1 session read and the roster and team lists, on the server. */
export interface TesterAccess {
  /**
   * The standing of the live session whose token has this sha256 (lower-case hex, K-22 v1 sessions.token_sha256) at `at`
   * (K-22 v1 session_for_token): tester when its person is a tester on staging's roster (Q-53) or holds a live K-36 v1
   * team_page_recipients row (Q-18), notTester when neither, noSession when no live session has that hash. The token
   * itself never leaves the handler.
   */
  standing(tokenSha256: string, at: string): Promise<TesterStanding>;
}

/** One phone of staging's test-phone roster as the server keeps it (Q-53; C-202): staging's config, never a browser value. */
export interface RosterPhone {
  /** The roster's id for the phone: what the page names, never a number. */
  readonly testPhoneId: string;
  /** Its number in E.164 form: never logged, never put in a span, and in no answer but as its last four digits. */
  readonly number: string;
  /** The email address on file for the phone's own person (its seeded customer, owner or staff member), or null. */
  readonly email: string | null;
}

/** Staging's test-phone roster: the seeded test phones, by the roster's id (K-21 v1 README "Staging only", "The picker"). */
export interface TestPhoneRoster {
  /** The seeded test phone with this roster id, or null when the roster has none by that id. */
  phone(testPhoneId: string): Promise<RosterPhone | null>;
}

/** A phone's chat link and its ready text, as K-09 v1 issueChatLink gave them (MC C9; K-29 v1 chat_links). */
export interface ChatLink {
  readonly link: string;
  readonly readyText: string;
  readonly shortCode: string;
}

/** What testPhoneParts shows of the phone itself: its K-04 v1 phones row and its chat link. */
export interface PhoneState {
  /** K-04 v1 phones.chat_open (false while the phone has no row yet). */
  readonly chatOpen: boolean;
  /** K-04 v1 phones.stopped: Rosie's texts to it are off for every business until START (MC C1). */
  readonly stopped: boolean;
  /** When the STOP in force came, or null. */
  readonly stoppedAt: string | null;
  /** The phone's chat link, or null. */
  readonly chatLink: ChatLink | null;
}

/** The phones' own state, read on the primary, uncached (K-21 v1 README "Who may call": every call). */
export interface PhoneStates {
  /** The state of the phone with this number. */
  state(number: string): Promise<PhoneState>;
}

/**
 * The gateway's Linq webhook entry (runtime/src/gateway handleLinqWebhook, behind the root's skeleton route): one POST of
 * a signed webhook, answered as Linq would be (200, 401 or 503, with the trace it opened in x-trace-id).
 */
export type LinqWebhookEntry = (request: Request) => Promise<Response>;

/** One part the Linq double recorded, as K-21 v1 RecordedPart lists it: when, the request as sendPart took it, its answer. */
export interface RecordedPart {
  readonly at: string;
  readonly sent: SendPartRequest;
  readonly outcome: SendPartOutcome;
}

/** The Linq double's record of parts, with their times and answers (./parts.ts). */
export interface PartsRecord {
  /** Each part recorded to this number, in the order it was sent. */
  partsTo(number: string): readonly RecordedPart[];
}

/** The ids one send makes (CQ-09: opaque, made by code, never parsed). */
export interface SendIds {
  /** The K-06 v1 event's id, which the gateway knows a repeat by (arch 02 line 109). */
  readonly eventId: string;
  /** Linq's id for the inbound message (K-06 messageId). */
  readonly messageId: string;
  /** Linq's id for the phone's chat with Rosie (K-06 chatId): the same for every send as one phone. */
  readonly chatId: string;
}

/** What a send's ids are made from: the roster phone, the session token's sha256 and the page's repeat key. */
export interface SendIdInput {
  readonly phone: RosterPhone;
  readonly tokenSha256: string;
  readonly requestId: string;
}

export type SendIdMaker = (input: SendIdInput) => Promise<SendIds>;

/** What the two handlers reach. */
export interface TestPhoneDeps {
  /** Who is signed in, and whether they may use staging's test tools. */
  readonly access: TesterAccess;
  /** Staging's test-phone roster. */
  readonly roster: TestPhoneRoster;
  /** The phones' own state (testPhoneParts). */
  readonly phones: PhoneStates;
  /** K-11 v1 doubleWebhook: the Linq double that signs a webhook as the chosen phone (T-412), under the test secret. */
  readonly linqWebhooks: Pick<LinqWebhookDouble, "sign">;
  /** The gateway's Linq webhook entry the signed webhook is posted to. */
  readonly gateway: LinqWebhookEntry;
  /** The parts the Linq double recorded: the same double the staging send path sends through. */
  readonly parts: PartsRecord;
  /** K-12 v1 doubleSentEmails: the email double the staging email rows send through (T-418). */
  readonly emails: Pick<EmailDouble, "doubleSentEmails">;
  /** Epoch milliseconds. Default Date.now. */
  readonly now?: () => number;
  /** The ids of a send. Default ./ids.ts defaultSendIds. */
  readonly ids?: SendIdMaker;
}

// ---- K-21 v1's answers (page-api.v1.schema.json) -------------------------------------------------------------------
// The handlers build each answer as an object literal that satisfies one of these, so it is also the page entry's
// PageOutcome (runtime/src/gateway/pages/types.ts).

/** `stagingOnlyError`: a staging-only call outside staging; nothing was read or done. */
export interface StagingOnly {
  readonly error: "stagingOnly";
}

/** `signInNeededError`: no live session came. */
export interface SignInNeeded {
  readonly error: "signInNeeded";
}

/** `notTesterError`: the session's person is neither a roster tester nor on Rosie's team. */
export interface NotTester {
  readonly error: "notTester";
}

/** `notTestPhoneError`: the roster has no test phone by that id. */
export interface NotTestPhone {
  readonly error: "notTestPhone";
  readonly testPhoneId: string;
}

/** `testPhoneSend.response`: sent into the gateway; the page shows the trace id. */
export interface TestPhoneSent {
  readonly result: "sent";
  readonly eventId: string;
  readonly traceId: string;
  readonly gatewayStatus: 200 | 401 | 503;
}

/** `testPhoneParts.response`'s email: one of the email double's emails to the phone's own person. */
export interface RecordedEmail {
  readonly at: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

/** `testPhoneParts.response`'s phone: its last four digits and its stop state. */
export interface TestPhoneState {
  readonly testPhoneId: string;
  readonly last4: string;
  readonly chatOpen: boolean;
  readonly stopped: boolean;
  readonly stoppedAt: string | null;
}

/** `testPhoneParts.response`: what the phone would have got. */
export interface TestPhoneParts {
  readonly result: "parts";
  readonly phone: TestPhoneState;
  readonly chatLink: ChatLink | null;
  readonly parts: readonly RecordedPart[];
  readonly emails: readonly RecordedEmail[];
}
