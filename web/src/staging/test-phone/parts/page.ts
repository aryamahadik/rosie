// The test-phone page's thread view (T-524; C-205; build prompt 9.4 "The test-phone page": it "shows, in order, each
// part the Linq double would have sent"; K-21 v1 testPhoneParts): HTML made on the Worker, with no script and no form,
// for the frame (shell/frame.ts). Staging only: routes.ts puts the folder's routes behind the staging-only guard
// (T-522), and web/src/routes.ts marks the folder staging only.
//
// The view is at /staging/test-phone/parts under BASE_PATH, for the test phone the address's `phone` field names by its
// roster id, as the send page's address does (send/page.ts). For K-21 v1 testPhoneParts' answer it shows:
//   - each part the Linq double recorded for the phone, in the answer's order, which is the order the parts were sent,
//     so the newest is last: each with its kind in plain words (K-11 v1 sendPart's kinds, a text's calendar file and
//     thread told apart: KIND_WORDS), when it was sent, what it carried and what the double answered. Every part is
//     one Rosie sent: the answer holds no text of the phone's own, so each is marked as Rosie's;
//   - beside them, the email double's output for the phone's own person, in the answer's order;
//   - the phone's stop state and whether its chat is open, as the answer gives them;
//   - its chat link with the ready text, through the chat-link component (T-513), or nothing at all when the answer
//     has none.
// Under the texts, "Check again" opens the view again (a plain reload: the page runs no script and never polls), "Send a
// text as this phone" opens the send page with this phone chosen, and "Choose another phone" opens the picker (T-525).
//
// What the view never shows: a phone number beyond the last four digits the answer gives (each part's `to` is the
// phone's own number: rule 9; K-21 v1 README, "A phone shows its last four digits only"), Rosie's number (the chat-link
// component keeps it to the link's href: CQ-326's default), the tester's session token (it rides in the HttpOnly cookie
// and the call's envelope alone: auth/cookies.ts), or a part's idempotency key and chat id. Every value from the answer
// is escaped with escapeHtml. No source gives these words beyond K-21 v1's on a stopped phone (K-04 v1 phones.stopped)
// and K-04 v1's on an open chat (phones.chat_open); the rest are plain stand-ins.

import { startHref, type Problem } from "../../../auth/pages";
import type { ResponseOf } from "../../../client/calls";
import { renderChatLink } from "../../../components/chat-link/chat-link";
import type { WebConfig } from "../../../shell/config";
import { escapeHtml } from "../../../shell/frame";
import type { RoutePage } from "../../../shell/route";
import { pickerHref } from "../picker/page";
import { PHONE_FIELD, TEST_PHONE_PATH, testPhoneHref } from "../send/page";

/** The thread view's path under BASE_PATH: under the test-phone page's own. */
export const PARTS_PATH = `${TEST_PHONE_PATH}/parts`;

/** K-21 v1 testPhoneParts' answer: the phone's parts, its person's emails, its state and its chat link. */
export type TestPhoneParts = ResponseOf<"testPhoneParts">;
/** One part the Linq double recorded (K-21 v1 `RecordedPart`): the request K-11 v1 sendPart took, and its outcome. */
export type RecordedPart = TestPhoneParts["parts"][number];
/** One email the email double recorded for the phone's own person (K-21 v1 `RecordedEmail`). */
export type RecordedEmail = TestPhoneParts["emails"][number];
/** The phone's state (K-21 v1 `TestPhoneState`). */
export type TestPhoneState = TestPhoneParts["phone"];
/** What K-11 v1 sendPart took. */
type SentPart = RecordedPart["sent"];
/** What the Linq double answered: accepted, or failed with K-11 v1 sendPart.errors' kind. */
type PartOutcome = RecordedPart["outcome"];
type FailedKind = Extract<PartOutcome, { result: "failed" }>["kind"];
type CalendarAction = NonNullable<SentPart["calendarFile"]>["action"];

/**
 * What a part is, as the view names it: K-11 v1's send kinds (words, poll, linkCard, photo, typing, tapback), a words
 * part told apart by what it carries: a threaded reply (K-11 v1 threadedReplyTo), else a text with a calendar file,
 * else a text.
 */
export type PartKind =
  "text" | "calendarFile" | "threadedReply" | "poll" | "linkCard" | "photo" | "typing" | "tapback";

/** Each kind's words on the view. */
export const KIND_WORDS: Readonly<Record<PartKind, string>> = {
  text: "Text",
  calendarFile: "Text with a calendar file",
  threadedReply: "Threaded reply",
  poll: "Poll",
  linkCard: "Link card",
  photo: "Photo",
  typing: "Typing dots",
  tapback: "Tapback",
};

/** The service each part went by (K-11 v1 LinqService). */
export const SERVICE_WORDS: Readonly<Record<SentPart["service"], string>> = {
  imessage: "iMessage",
  rcs: "RCS",
  sms: "SMS",
};

/** What a calendar file does on the phone (K-11 v1 LinqCalendarFile.action). */
export const CALENDAR_WORDS: Readonly<Record<CalendarAction, string>> = {
  new: "it adds the booking to the phone's calendar.",
  move: "it moves the booking in the phone's calendar.",
  cancel: "it cancels the booking in the phone's calendar.",
};

/** Why a part was not sent, by K-11 v1 sendPart.errors' kind. */
export const FAILED_WORDS: Readonly<Record<FailedKind, string>> = {
  optedOut: "the phone opted out, so Linq blocks Rosie's texts to it",
  mayStillDeliver: "Linq did not finish, so it may still arrive",
  rateLimited: "Linq asked Rosie to wait before sending more",
  refused: "Linq refused it",
  transient: "Linq could not be reached",
};

/** The view's words. */
export const WORDS = {
  title: "This phone's texts",
  testPhone: "Test phone",
  ending: "ending",
  intro:
    "Staging only. What Rosie sent this test phone, as the Linq double recorded each part, in the order sent: the newest is last. The phone's own texts are not listed here. Below them, what the email double sent this phone's person.",
  partsHeading: "Texts from Rosie",
  noParts: "Nothing yet: the Linq double has recorded nothing sent to this phone.",
  fromRosie: "From Rosie",
  by: "by",
  inReplyTo: "In reply to message",
  partHere: "part",
  pollOptions: "Its options, word for word:",
  calendarFile: "Calendar file",
  calendarText: "The calendar file's text",
  noLink: "It names no link.",
  photo: "The photo's file:",
  typingStart: "Rosie's typing dots show on the phone.",
  typingStop: "Rosie's typing dots are cleared.",
  tapbackOn: "on the phone's message",
  pastOptOut: "Sent past the phone's opt-out, as only a stop reply or a safety line may be.",
  taken: "The Linq double took it.",
  takenAs: "The Linq double took it as message",
  notSent: "Not sent:",
  linqAnswered: "Linq answered",
  noAnswer: "no answer came",
  linqCode: "code",
  checkAgain: "Check again",
  sendAs: "Send a text as this phone",
  choose: "Choose another phone",
  emailsHeading: "Emails to this phone's person",
  noEmails: "No email yet.",
  emailTo: "To",
  stateHeading: "Its state",
  stoppedMark: "Stopped.",
  stoppedLine: "Rosie's texts to this phone are off for every business until it texts START.",
  notStoppedMark: "Not stopped.",
  notStoppedLine: "Rosie's texts to this phone are on.",
  lastStopped: "Last stopped",
  chatOpenMark: "Chat open.",
  chatOpenLine: "This phone has texted Rosie's number, and has not texted STOP since.",
  chatClosedMark: "Chat not open.",
  chatClosedLine: "This phone has not texted Rosie's number yet, or it texted STOP.",
  chatLinkHeading: "Its chat link",
  chooseTitle: "Choose a test phone",
  noneChosen: "No test phone is chosen, so there are no texts to show. Choose one first.",
  badPhone: "That is not a test phone's roster id. Choose a phone from the list.",
  chooseLink: "Choose a test phone",
  notOnRoster: "is not a test phone on staging's roster, so nothing was read. Choose another.",
  signInTitle: "Sign in first",
  signInLine: "A test phone's texts are for staging's testers and Rosie's team, signed in.",
  signIn: "Sign in",
  notTesterTitle: "Not a tester",
  notTesterLine:
    "This account is neither one of staging's testers nor on Rosie's team, so it cannot see a test phone's texts.",
  signInAsOther: "Sign in with another account",
  tryAgainTitle: "Not read",
  tryAgainLine: "That did not go through, and nothing was read. Check again in a moment.",
} as const;

/** The thread view's address on this site, for the test phone with this roster id: its path under BASE_PATH. */
export function partsHref(config: WebConfig, testPhoneId: string): string {
  const query = new URLSearchParams();
  query.set(PHONE_FIELD, testPhoneId);
  return `${config.basePath}${PARTS_PATH}?${query.toString()}`;
}

/** What a part is (PartKind). */
export function kindOf(sent: SentPart): PartKind {
  switch (sent.kind) {
    case "words":
      if (sent.threadedReplyTo !== null) return "threadedReply";
      return sent.calendarFile === null ? "text" : "calendarFile";
    case "poll":
    case "linkCard":
    case "photo":
    case "typing":
    case "tapback":
      return sent.kind;
  }
}

const p = (words: string): string => `<p>${escapeHtml(words)}</p>`;
const code = (value: string): string => `<code>${escapeHtml(value)}</code>`;
const link = (href: string, words: string): string =>
  `<p><a href="${escapeHtml(href)}">${escapeHtml(words)}</a></p>`;
/** A plain mark: its words in bold, then what it means. */
const mark = (marked: string, line: string): string =>
  `<p><strong>${escapeHtml(marked)}</strong> ${escapeHtml(line)}</p>`;
/** A text as it was sent, each line break shown as one. */
const textOf = (text: string): string =>
  `<blockquote><p>${text.split("\n").map(escapeHtml).join("<br>")}</p></blockquote>`;
/** An ordered list of rows, each row's lines; a line that says so when there is none. */
const listOf = (rows: readonly string[][], none: string): string[] =>
  rows.length === 0 ? [p(none)] : ["<ol>", ...rows.flat(), "</ol>"];

/** K-21's `utc` (an instant ending in Z), as the view writes it: its date and time in UTC. */
const UTC = /^([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]+)?)Z$/;

/** An instant the answer gives, in a time element that keeps it whole: "2026-10-23 14:05:03 UTC". */
export function timeOf(utc: string): string {
  const read = UTC.exec(utc);
  const shown = read === null ? utc : `${read[1] ?? ""} ${read[2] ?? ""} UTC`;
  return `<time datetime="${escapeHtml(utc)}">${escapeHtml(shown)}</time>`;
}

/** The message a threaded reply sits under, with the part here that is that message, when one is. */
function threadLine(messageId: string, parts: readonly RecordedPart[]): string {
  const at = parts.findIndex(
    ({ outcome }) => outcome.result === "accepted" && outcome.providerMessageId === messageId,
  );
  const here = at === -1 ? "" : ` (${WORDS.partHere} ${String(at + 1)})`;
  return `<p>${escapeHtml(WORDS.inReplyTo)} ${code(messageId)}${escapeHtml(here)}.</p>`;
}

/** What a part carried, by its kind. */
function carried(sent: SentPart, parts: readonly RecordedPart[]): string[] {
  switch (sent.kind) {
    case "words": {
      const file = sent.calendarFile;
      return [
        ...(sent.threadedReplyTo === null ? [] : [threadLine(sent.threadedReplyTo.messageId, parts)]),
        textOf(sent.text ?? ""),
        ...(file === null
          ? []
          : [
              `<p>${escapeHtml(WORDS.calendarFile)} ${code(file.fileName)}: ${escapeHtml(CALENDAR_WORDS[file.action])}</p>`,
              `<details><summary>${escapeHtml(WORDS.calendarText)}</summary><pre>${escapeHtml(file.ics)}</pre></details>`,
            ]),
      ];
    }
    case "poll":
      return [
        p(WORDS.pollOptions),
        "<ol>",
        ...sent.options.map((option) => `<li>${escapeHtml(option)}</li>`),
        "</ol>",
      ];
    case "linkCard": {
      const href = sent.link;
      if (href === null) return [p(WORDS.noLink)];
      // A link card is the whole message, an https link (K-11 v1 sendPart.request.link): it opens as the phone's would.
      return [href.startsWith("https://") ? link(href, href) : `<p>${code(href)}</p>`];
    }
    case "photo":
      return sent.photo === null
        ? []
        : [`<p>${escapeHtml(WORDS.photo)} ${code(sent.photo.fileId)}, ${code(sent.photo.mediaType)}.</p>`];
    case "typing":
      return [p(sent.typing === "stop" ? WORDS.typingStop : WORDS.typingStart)];
    case "tapback":
      return sent.tapback === null
        ? []
        : [
            `<p>${escapeHtml(`A ${sent.tapback.reaction} ${WORDS.tapbackOn}`)} ${code(sent.tapback.onMessageId)}.</p>`,
          ];
  }
}

/** What the Linq double answered for a part. */
function outcomeLine(outcome: PartOutcome): string {
  if (outcome.result === "accepted")
    return outcome.providerMessageId === null
      ? p(WORDS.taken)
      : `<p>${escapeHtml(WORDS.takenAs)} ${code(outcome.providerMessageId)}.</p>`;
  const answered = [
    outcome.httpStatus === null ? WORDS.noAnswer : `${WORDS.linqAnswered} ${String(outcome.httpStatus)}`,
    ...(outcome.code === null ? [] : [`${WORDS.linqCode} ${outcome.code}`]),
  ].join(", ");
  return `<p><strong>${escapeHtml(WORDS.notSent)}</strong> ${escapeHtml(`${FAILED_WORDS[outcome.kind]} (${answered}): ${outcome.reason}`)}</p>`;
}

/** One part's row: its kind, that Rosie sent it and when, what it carried and what the double answered. */
function partRow(part: RecordedPart, parts: readonly RecordedPart[]): string[] {
  const { sent } = part;
  return [
    "<li>",
    `<h3>${escapeHtml(KIND_WORDS[kindOf(sent)])}</h3>`,
    `<p>${escapeHtml(WORDS.fromRosie)}, ${timeOf(part.at)}, ${escapeHtml(`${WORDS.by} ${SERVICE_WORDS[sent.service]}`)}.</p>`,
    ...carried(sent, parts),
    ...(sent.overrideOptout ? [p(WORDS.pastOptOut)] : []),
    outcomeLine(part.outcome),
    "</li>",
  ];
}

/** One email's row: its subject, to whom and when, and its words. */
function emailRow(email: RecordedEmail): string[] {
  return [
    "<li>",
    `<h3>${escapeHtml(email.subject)}</h3>`,
    `<p>${escapeHtml(WORDS.emailTo)} ${code(email.to)}, ${timeOf(email.at)}.</p>`,
    textOf(email.text),
    "</li>",
  ];
}

/** The phone's stop state and whether its chat is open, as the answer gives them. */
function stateLines(phone: TestPhoneState): string[] {
  return [
    phone.stopped
      ? mark(WORDS.stoppedMark, WORDS.stoppedLine)
      : mark(WORDS.notStoppedMark, WORDS.notStoppedLine),
    ...(phone.stoppedAt === null
      ? []
      : [`<p>${escapeHtml(WORDS.lastStopped)} ${timeOf(phone.stoppedAt)}.</p>`]),
    phone.chatOpen
      ? mark(WORDS.chatOpenMark, WORDS.chatOpenLine)
      : mark(WORDS.chatClosedMark, WORDS.chatClosedLine),
  ];
}

/** The links under the texts: this view again, the send page for this phone, and the picker. */
function linkLines(config: WebConfig, testPhoneId: string): string[] {
  return [
    link(partsHref(config, testPhoneId), WORDS.checkAgain),
    link(testPhoneHref(config, testPhoneId), WORDS.sendAs),
    link(pickerHref(config), WORDS.choose),
  ];
}

/**
 * The thread view (see the top of this file) for the test phone the address chose, `testPhoneId`, with K-21 v1
 * testPhoneParts' answer for it.
 */
export function partsPage(config: WebConfig, testPhoneId: string, answer: TestPhoneParts): RoutePage {
  const { phone, parts, emails } = answer;
  const chatLink = renderChatLink(answer.chatLink);
  const main = [
    `<h1>${escapeHtml(WORDS.title)}</h1>`,
    `<p>${escapeHtml(WORDS.testPhone)} ${code(phone.testPhoneId)}, ${escapeHtml(`${WORDS.ending} ${phone.last4}`)}.</p>`,
    p(WORDS.intro),
    `<h2>${escapeHtml(WORDS.partsHeading)}</h2>`,
    ...listOf(
      parts.map((part) => partRow(part, parts)),
      WORDS.noParts,
    ),
    ...linkLines(config, testPhoneId),
    `<h2>${escapeHtml(WORDS.emailsHeading)}</h2>`,
    ...listOf(emails.map(emailRow), WORDS.noEmails),
    `<h2>${escapeHtml(WORDS.stateHeading)}</h2>`,
    ...stateLines(phone),
    ...(chatLink === "" ? [] : [`<h2>${escapeHtml(WORDS.chatLinkHeading)}</h2>`, chatLink]),
  ].join("\n");
  return { title: WORDS.title, main };
}

const problemLine = (problem: Problem | null): string[] =>
  problem === null ? [] : [`<p role="alert">${escapeHtml(problem.words)}</p>`];

/**
 * The page for an address that names no test phone (200), or a value that is no roster id (400, said on top): nothing
 * is read, and the link opens the picker.
 */
export function choosePage(config: WebConfig, problem: Problem | null): RoutePage {
  const main = [
    `<h1>${escapeHtml(WORDS.chooseTitle)}</h1>`,
    ...problemLine(problem),
    p(WORDS.noneChosen),
    link(pickerHref(config), WORDS.chooseLink),
  ].join("\n");
  return { title: WORDS.chooseTitle, main, status: problem?.status ?? 200 };
}

/** The page for a roster id the server does not hold (K-21 v1 notTestPhone), naming it: 400, nothing read. */
export function notOnRosterPage(config: WebConfig, testPhoneId: string): RoutePage {
  const main = [
    `<h1>${escapeHtml(WORDS.chooseTitle)}</h1>`,
    `<p role="alert">${escapeHtml(`${testPhoneId} ${WORDS.notOnRoster}`)}</p>`,
    link(pickerHref(config), WORDS.chooseLink),
  ].join("\n");
  return { title: WORDS.chooseTitle, main, status: 400 };
}

/**
 * The page that asks for sign-in first: the view sits behind the tester login (T-520). 200 when the browser sent no
 * session; 403 when the server answered that no live session came (K-21 v1 signInNeeded).
 */
export function signInFirstPage(config: WebConfig, refused: boolean): RoutePage {
  const main = [
    `<h1>${escapeHtml(WORDS.signInTitle)}</h1>`,
    p(WORDS.signInLine),
    link(startHref(config, null), WORDS.signIn),
  ].join("\n");
  return { title: WORDS.signInTitle, main, status: refused ? 403 : 200 };
}

/** The page for a signed-in person who is neither a tester nor on Rosie's team (K-21 v1 notTester): nothing was read. */
export function notTesterPage(config: WebConfig): RoutePage {
  const main = [
    `<h1>${escapeHtml(WORDS.notTesterTitle)}</h1>`,
    p(WORDS.notTesterLine),
    link(startHref(config, null), WORDS.signInAsOther),
  ].join("\n");
  return { title: WORDS.notTesterTitle, main, status: 403 };
}

/** The page for K-21 v1's transient answer: nothing was read; "Check again" opens the view again for the same phone. */
export function tryAgainPage(config: WebConfig, testPhoneId: string): RoutePage {
  const main = [
    `<h1>${escapeHtml(WORDS.tryAgainTitle)}</h1>`,
    `<p role="alert">${escapeHtml(WORDS.tryAgainLine)}</p>`,
    link(partsHref(config, testPhoneId), WORDS.checkAgain),
  ].join("\n");
  return { title: WORDS.tryAgainTitle, main, status: 503 };
}
