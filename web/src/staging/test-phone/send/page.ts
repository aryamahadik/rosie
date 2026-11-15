// The test-phone page's send side (T-523; C-205; build prompt 9.4 "The test-phone page"; K-21 v1 testPhoneSend): HTML
// made on the Worker, with no script, for the frame (shell/frame.ts). Staging only: routes.ts puts the folder's routes
// behind the staging-only guard (T-522), and web/src/routes.ts marks the folder staging only.
//
// The page is at /staging/test-phone under BASE_PATH (auth/consoles.ts STAGING_TOOLS_PATH: the address the signed-in
// page gives testers and Rosie's team). It holds two forms:
//   - Choose: a GET of this same address that names a test phone by its roster id, in the address's `phone` field. A
//     roster id is all the page ever names a phone by, never a number (K-21 v1 testPhoneSend binds the phone by the
//     roster's id). The seeded test-state picker (T-525) can set the same field: testPhoneHref gives the address.
//   - Send: a POST to /staging/test-phone/send of the text, the Linq message it replies under (optional, as the
//     address's `replyTo` field can give it) and the chosen phone. With no test phone chosen, the form holds no phone
//     and its fields and send button are disabled; the send route refuses such a POST as well, with nothing sent
//     (send.ts).
// After a send the page shows which phone sent what, the gateway's answer, and the answer's trace id and event id, with
// the form ready for the next text as the same phone.
//
// What the page never holds or shows: a webhook secret, a signature or a signed webhook (the server builds the event and
// the Linq double signs it: K-11 v1 doubleWebhook, T-565), a phone number, or the tester's session token (it rides in
// the HttpOnly cookie and the call's envelope alone: auth/cookies.ts). Every value from a request or an answer is
// escaped with escapeHtml. No source gives these words beyond build prompt 9.4's on opt-out words; the rest are plain
// stand-ins.

import { STAGING_TOOLS_PATH } from "../../../auth/consoles";
import { startHref, type Problem } from "../../../auth/pages";
import type { ResponseOf } from "../../../client/calls";
import type { WebConfig } from "../../../shell/config";
import { escapeHtml } from "../../../shell/frame";
import type { RoutePage } from "../../../shell/route";

/** The test-phone page's path under BASE_PATH: where the signed-in page sends testers (auth/consoles.ts). */
export const TEST_PHONE_PATH = STAGING_TOOLS_PATH;
/** Where the page's send form posts. */
export const SEND_PATH = `${TEST_PHONE_PATH}/send`;

/** The field naming the chosen test phone by its roster id: in the page's address and in the send form. */
export const PHONE_FIELD = "phone";
/** The field naming the Linq message a text replies under: in the page's address and in the send form. */
export const REPLY_FIELD = "replyTo";
/** The send form's text. */
export const WORDS_FIELD = "words";
/** The send form's own id for this submit (K-21 v1 page.requestId). */
export const REQUEST_FIELD = "requestId";

/** K-21 v1 testPhoneSend.request.words: at most 10,000 characters. */
export const WORDS_MAX = 10_000;
/** The longest roster id the page takes. */
export const PHONE_MAX = 128;
/** The longest Linq message id the page takes. */
export const REPLY_MAX = 256;

/**
 * A roster id as the page takes one: 1 to 128 visible characters, no space. K-21 v1's ids are opaque; staging's roster
 * names its phones so (tp-01 to tp-05 in K-21's fixtures), and the server answers notTestPhone for any it does not hold.
 */
const ROSTER_ID = /^[\x21-\x7E]{1,128}$/;
/** A Linq message id as the page takes one (K-06 v1 threadedReplyTo): 1 to 256 visible characters, no space. */
const MESSAGE_ID = /^[\x21-\x7E]{1,256}$/;

/** A field's value read as an id: null when it is empty or missing, the id when it reads as one, false otherwise. */
function idOf(raw: string | null, shape: RegExp): string | null | false {
  const value = (raw ?? "").trim();
  if (value === "") return null;
  return shape.test(value) ? value : false;
}

/** The chosen test phone's roster id, from a field (idOf). */
export function rosterIdOf(raw: string | null): string | null | false {
  return idOf(raw, ROSTER_ID);
}

/** The Linq message a text replies under, from a field (idOf). */
export function messageIdOf(raw: string | null): string | null | false {
  return idOf(raw, MESSAGE_ID);
}

/**
 * The test-phone page's address on this site: with the chosen phone, and the message to reply under, when they are
 * given. Its path under BASE_PATH, never a host.
 */
export function testPhoneHref(
  config: WebConfig,
  testPhoneId: string | null = null,
  replyTo: string | null = null,
): string {
  const query = new URLSearchParams();
  if (testPhoneId !== null) query.set(PHONE_FIELD, testPhoneId);
  if (replyTo !== null) query.set(REPLY_FIELD, replyTo);
  const search = query.toString();
  return `${config.basePath}${TEST_PHONE_PATH}${search === "" ? "" : `?${search}`}`;
}

/** The gateway's answer to the signed webhook (K-21 v1 TestPhoneSent.gatewayStatus). */
export type GatewayStatus = ResponseOf<"testPhoneSend">["gatewayStatus"];

/** The page's words. */
export const WORDS = {
  title: "Test phone",
  intro:
    "Staging only. Send Rosie a text as one of staging's test phones: the server signs it through the Linq double, as Linq would, and posts it into staging's gateway.",
  chooseHeading: "Choose a test phone",
  phoneLabel: "The test phone's roster id, such as tp-01",
  choose: "Choose",
  sendHeading: "Send a text",
  noneChosen: "No test phone is chosen, so nothing can be sent. Choose one first.",
  sendingAs: "Sending as test phone",
  wordsLabel: "Text",
  replyLabel: "Reply under a message (optional): its Linq message id",
  send: "Send",
  sendAs: "Send as",
  optOut:
    "A bare STOP, CANCEL, END, QUIT, UNSUBSCRIBE or OPTOUT, or any other opt-out word sent alone, stops Rosie's texts to that phone for every business. Only a test about STOP sends one, from the STOP test phone, and it ends by texting START.",
  sentHeading: "Sent",
  notTakenHeading: "Not taken",
  sentAs: "As test phone",
  repliedUnder: "As a reply under",
  traceLabel: "Trace id",
  eventLabel: "Event id",
  badForm: "That form could not be read. Send it again from this page.",
  noPhone: "No test phone is chosen, so nothing was sent. Choose one first.",
  badPhone: "That is not a test phone's roster id. Type one such as tp-01.",
  noWords: "Type the text to send.",
  tooLong: "That text is too long: at most 10,000 characters.",
  badReply: "That is not a Linq message id. Leave it empty to send a plain text.",
  notOnRoster: "is not a test phone on staging's roster, so nothing was sent. Choose another.",
  tryAgain: "That did not go through, and nothing was sent. Try again in a moment.",
  signInTitle: "Sign in first",
  signInLine: "The test-phone page is for staging's testers and Rosie's team, signed in.",
  nothingSent: "Nothing was sent.",
  signIn: "Sign in",
  notTesterTitle: "Not a tester",
  notTesterLine:
    "This account is neither one of staging's testers nor on Rosie's team, so it cannot send as a test phone.",
  signInAsOther: "Sign in with another account",
} as const;

/** What the gateway's answer means, by its status (arch 02 line 109, as K-21 v1 names the three). */
export const GATEWAY_WORDS: Readonly<Record<GatewayStatus, string>> = {
  200: "The gateway took it (200).",
  401: "The gateway refused it (401): the signed webhook did not check, so the text did not reach Rosie.",
  503: "The gateway could not take it (503): its write failed, so the text did not reach Rosie. Send it again in a moment.",
};

/** A text the page sent, with K-21 v1 testPhoneSend's response to it. */
export interface SentText {
  readonly testPhoneId: string;
  /** The text as sent. */
  readonly words: string;
  readonly threadedReplyTo: string | null;
  readonly answer: ResponseOf<"testPhoneSend">;
}

/** One showing of the test-phone page. */
export interface TestPhoneView {
  /** The send form's request id: a new one each time the form is shown. */
  readonly requestId: string;
  /** The chosen test phone's roster id, or null when none is chosen: send is then disabled. */
  readonly testPhoneId: string | null;
  /** The reply field's value: the message the next text replies under, or "". */
  readonly replyTo: string;
  /** The text field's value: what was typed, kept when it was not sent, or "". */
  readonly words: string;
  /** The text just sent, with its answer, or null. */
  readonly sent: SentText | null;
  /** A problem to show on top, with the page's status, or null. */
  readonly problem: Problem | null;
}

const p = (words: string): string => `<p>${escapeHtml(words)}</p>`;
const code = (value: string): string => `<code>${escapeHtml(value)}</code>`;
const hidden = (name: string, value: string): string =>
  `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
const problemLine = (problem: Problem | null): string[] =>
  problem === null ? [] : [`<p role="alert">${escapeHtml(problem.words)}</p>`];

/** What was sent and the gateway's answer, with the answer's trace id and event id. */
function sentSection(sent: SentText): string[] {
  const { answer } = sent;
  return [
    `<h2>${escapeHtml(answer.gatewayStatus === 200 ? WORDS.sentHeading : WORDS.notTakenHeading)}</h2>`,
    `<p>${escapeHtml(WORDS.sentAs)} ${code(sent.testPhoneId)}:</p>`,
    `<blockquote><p>${sent.words.split("\n").map(escapeHtml).join("<br>")}</p></blockquote>`,
    ...(sent.threadedReplyTo === null
      ? []
      : [`<p>${escapeHtml(WORDS.repliedUnder)} ${code(sent.threadedReplyTo)}.</p>`]),
    p(GATEWAY_WORDS[answer.gatewayStatus]),
    `<p>${escapeHtml(WORDS.traceLabel)}: ${code(answer.traceId)}</p>`,
    `<p>${escapeHtml(WORDS.eventLabel)}: ${code(answer.eventId)}</p>`,
  ];
}

/**
 * The test-phone page (see the top of this file). Its status is the problem's when there is one; after a send, 502
 * when the gateway did not take the text (it answered 401 or 503); else 200.
 */
export function testPhonePage(config: WebConfig, view: TestPhoneView): RoutePage {
  const chosen = view.testPhoneId;
  const off = chosen === null ? " disabled" : "";
  const main = [
    `<h1>${escapeHtml(WORDS.title)}</h1>`,
    ...problemLine(view.problem),
    p(WORDS.intro),
    ...(view.sent === null ? [] : sentSection(view.sent)),
    `<h2>${escapeHtml(WORDS.chooseHeading)}</h2>`,
    `<form method="get" action="${escapeHtml(`${config.basePath}${TEST_PHONE_PATH}`)}">`,
    `<p><label for="${PHONE_FIELD}">${escapeHtml(WORDS.phoneLabel)}</label><br>`,
    `<input id="${PHONE_FIELD}" name="${PHONE_FIELD}" type="text" value="${escapeHtml(chosen ?? "")}" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="${String(PHONE_MAX)}" required></p>`,
    `<p><button>${escapeHtml(WORDS.choose)}</button></p>`,
    "</form>",
    `<h2>${escapeHtml(WORDS.sendHeading)}</h2>`,
    chosen === null ? p(WORDS.noneChosen) : `<p>${escapeHtml(WORDS.sendingAs)} ${code(chosen)}.</p>`,
    `<form method="post" action="${escapeHtml(`${config.basePath}${SEND_PATH}`)}">`,
    hidden(REQUEST_FIELD, view.requestId),
    ...(chosen === null ? [] : [hidden(PHONE_FIELD, chosen)]),
    `<p><label for="${WORDS_FIELD}">${escapeHtml(WORDS.wordsLabel)}</label><br>`,
    // The line break after the tag is the parser's to drop, so a text that starts with a line break keeps it.
    `<textarea id="${WORDS_FIELD}" name="${WORDS_FIELD}" rows="4" cols="40" maxlength="${String(WORDS_MAX)}" required${off}>`,
    `${escapeHtml(view.words)}</textarea></p>`,
    `<p><label for="${REPLY_FIELD}">${escapeHtml(WORDS.replyLabel)}</label><br>`,
    `<input id="${REPLY_FIELD}" name="${REPLY_FIELD}" type="text" value="${escapeHtml(view.replyTo)}" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="${String(REPLY_MAX)}"${off}></p>`,
    `<p><button${off}>${escapeHtml(chosen === null ? WORDS.send : `${WORDS.sendAs} ${chosen}`)}</button></p>`,
    "</form>",
    p(WORDS.optOut),
  ].join("\n");
  const gatewayTook = view.sent === null || view.sent.answer.gatewayStatus === 200;
  return {
    title: WORDS.title,
    main,
    forms: true,
    status: view.problem?.status ?? (gatewayTook ? 200 : 502),
  };
}

/**
 * The page that asks for sign-in first: the test-phone page sits behind the tester login (T-520). 200 when the page was
 * opened; 403 after a send that was refused for it, saying that nothing was sent.
 */
export function signInFirstPage(config: WebConfig, afterSend: boolean): RoutePage {
  const main = [
    `<h1>${escapeHtml(WORDS.signInTitle)}</h1>`,
    p(WORDS.signInLine),
    ...(afterSend ? [p(WORDS.nothingSent)] : []),
    `<p><a href="${escapeHtml(startHref(config, null))}">${escapeHtml(WORDS.signIn)}</a></p>`,
  ].join("\n");
  return { title: WORDS.signInTitle, main, status: afterSend ? 403 : 200 };
}

/** The page for a signed-in person who is neither a tester nor on Rosie's team (K-21 v1 notTester): nothing was sent. */
export function notTesterPage(config: WebConfig): RoutePage {
  const main = [
    `<h1>${escapeHtml(WORDS.notTesterTitle)}</h1>`,
    p(WORDS.notTesterLine),
    p(WORDS.nothingSent),
    `<p><a href="${escapeHtml(startHref(config, null))}">${escapeHtml(WORDS.signInAsOther)}</a></p>`,
  ].join("\n");
  return { title: WORDS.notTesterTitle, main, status: 403 };
}

/** The problem for a roster id the server does not hold (K-21 v1 notTestPhone), naming it. */
export function notOnRoster(testPhoneId: string): Problem {
  return { words: `${testPhoneId} ${WORDS.notOnRoster}`, status: 400 };
}
