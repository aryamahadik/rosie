// What the Resend send adapter refuses for its shape, before any request (T-419; K-12 v1 `sendEmail.request` and README
// 'The email row'): the exact field set, each field's form, what an email about a booking and each purpose carry, and the
// checks K-12 leaves to code (the text's first line is the assistant line; the text holds the manage link and the chat
// link word for word; the last reference is inReplyTo). They are the email double's checks (T-418,
// adapters/src/email/double/validate.ts), written again here so production code takes nothing from the double; this
// folder's test holds the two to the same answer on every K-12 fixture and on every fault the double's own test names.
// A problem line names the field, never its value: no address and no words in any message.

type Obj = Record<string, unknown>;

/** K-12 `emailAddress`: lower case, as K-04 handles.address writes an email handle. */
export const EMAIL_ADDRESS = /^[^@\sA-Z]+@[^@\sA-Z]+$/;
/** K-12 `rfcMessageId`: an email's Message-ID with its angle brackets. */
const RFC_MESSAGE_ID = /^<[^<>@\s]+@[^<>@\s]+>$/;
/** K-07 `idempotencyKey` as an email part's: `<row>/<part>/<try>`. */
const PART_KEY = /^.+\/[12]\/[1-9][0-9]*$/;
/** K-12 `sender`: the one confirmation address on mail.rosfield.com (DL-028), and a one-line name. */
const FROM_ADDRESS = /^[a-z0-9._+-]+@mail[.]rosfield[.]com$/;
const FROM_NAME = /^[^\r\n<>"]*\S[^\r\n<>"]*$/;
const ONE_LINE = /^[^\r\n]*\S[^\r\n]*$/;
const ASSISTANT_LINE = /^[^\r\n]*[Aa]utomated[^\r\n]*$/;
const HTTPS_LINK = /^https:\/\/\S+$/;
const SMS_LINK = /^sms:\+[1-9][0-9]{6,14}&body=\S+$/;
const ONE_WORD = /^\S+$/;
const WORDS = /\S/;

const PURPOSES: readonly unknown[] = ["confirmation", "copy", "emailWay", "nextWay", "code", "notice"];

/** The problem line of a From address off mail.rosfield.com: alone, it is answered as Resend answers an unverified domain. */
export const FROM_DOMAIN_PROBLEM = "from.address is not on mail.rosfield.com";

const SEND_FIELDS = [
  "idempotencyKey",
  "purpose",
  "bookingId",
  "from",
  "to",
  "replyTo",
  "subject",
  "text",
  "assistantLine",
  "manageLink",
  "chatLink",
  "thread",
];

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** Whether a value is a K-12 email address (lower case). */
export const isEmailAddress = (value: unknown): value is string =>
  typeof value === "string" && EMAIL_ADDRESS.test(value);

/** Every listed field present, none other. */
function exactFields(path: string, value: Obj, fields: readonly string[], problems: string[]): void {
  for (const field of fields) if (!(field in value)) problems.push(`${path}.${field} is missing`);
  for (const field of Object.keys(value))
    if (!fields.includes(field)) problems.push(`${path}.${field} is not a field of v1`);
}

function checkFrom(value: unknown, problems: string[]): void {
  if (!isObject(value)) {
    problems.push("from is not an object");
    return;
  }
  exactFields("from", value, ["name", "address"], problems);
  if (typeof value.name !== "string" || !FROM_NAME.test(value.name))
    problems.push("from.name is not one line of words without angle brackets or quotes");
  if (typeof value.address !== "string" || !FROM_ADDRESS.test(value.address))
    problems.push(FROM_DOMAIN_PROBLEM);
}

function checkChatLink(value: unknown, problems: string[]): void {
  if (!isObject(value)) {
    problems.push("chatLink is not an object");
    return;
  }
  exactFields("chatLink", value, ["link", "readyText", "shortCode", "qrText"], problems);
  if (typeof value.link !== "string" || !SMS_LINK.test(value.link))
    problems.push("chatLink.link is not an sms: link with a body");
  if (typeof value.readyText !== "string" || !WORDS.test(value.readyText))
    problems.push("chatLink.readyText is not words");
  if (typeof value.shortCode !== "string" || !ONE_WORD.test(value.shortCode))
    problems.push("chatLink.shortCode is not one word");
  if (typeof value.qrText !== "string" || !ONE_WORD.test(value.qrText))
    problems.push("chatLink.qrText is not one word");
}

function checkThread(value: unknown, problems: string[]): void {
  if (!isObject(value)) {
    problems.push("thread is not an object");
    return;
  }
  exactFields("thread", value, ["inReplyTo", "references"], problems);
  const inReplyTo = value.inReplyTo;
  if (inReplyTo !== null && !(typeof inReplyTo === "string" && RFC_MESSAGE_ID.test(inReplyTo)))
    problems.push("thread.inReplyTo is not a Message-ID or null");
  const references: unknown = value.references;
  if (
    !Array.isArray(references) ||
    !(references as unknown[]).every((ref) => typeof ref === "string" && RFC_MESSAGE_ID.test(ref))
  ) {
    problems.push("thread.references is not a list of Message-IDs");
    return;
  }
  if (typeof inReplyTo !== "string") return;
  // RFC 5322: the last of References is the message this one answers (K-12 leaves it to code).
  if (references.length === 0) problems.push("thread.references is empty though inReplyTo names a message");
  else if ((references as unknown[])[references.length - 1] !== inReplyTo)
    problems.push("thread.references does not end with inReplyTo");
}

/** The problems with one sendEmail request, one line each; empty when K-12 v1 allows it. */
export function sendEmailProblems(request: unknown): string[] {
  if (!isObject(request)) return ["the request is not an object"];
  const problems: string[] = [];
  exactFields("request", request, SEND_FIELDS, problems);
  if (problems.length > 0) return problems;

  const { bookingId, replyTo, manageLink, chatLink, text, assistantLine } = request;
  if (typeof request.idempotencyKey !== "string" || !PART_KEY.test(request.idempotencyKey))
    problems.push("idempotencyKey is not <row>/<part>/<try>");
  if (!PURPOSES.includes(request.purpose)) problems.push("purpose is not a transactional purpose of v1");
  if (bookingId !== null && !isId(bookingId)) problems.push("bookingId is not an id or null");
  checkFrom(request.from, problems);
  if (!isEmailAddress(request.to)) problems.push("to is not a lower-case email address");
  if (replyTo !== null && !isEmailAddress(replyTo))
    problems.push("replyTo is not a lower-case email address or null");
  if (typeof request.subject !== "string" || !ONE_LINE.test(request.subject))
    problems.push("subject is not one line of words");
  if (typeof text !== "string" || !WORDS.test(text)) problems.push("text is not words");
  if (typeof assistantLine !== "string" || !ASSISTANT_LINE.test(assistantLine))
    problems.push("assistantLine is not one line that says automated");
  if (manageLink !== null && !(typeof manageLink === "string" && HTTPS_LINK.test(manageLink)))
    problems.push("manageLink is not an https link or null");
  if (chatLink !== null) checkChatLink(chatLink, problems);
  checkThread(request.thread, problems);
  if (problems.length > 0) return problems;

  // What a booking carries (RULES 4.1; arch 07 line 371): an email about no booking has no reply address, manage link
  // or thread, since an email thread belongs to one booking (K-04 threads_chat_or_email).
  const thread = request.thread as { inReplyTo: string | null; references: string[] };
  if (bookingId === null) {
    if (replyTo !== null) problems.push("replyTo is set on an email about no booking");
    if (manageLink !== null) problems.push("manageLink is set on an email about no booking");
    if (thread.inReplyTo !== null || thread.references.length > 0)
      problems.push("thread is set on an email about no booking");
  } else {
    if (replyTo === null) problems.push("replyTo is missing on an email about a booking");
    if (manageLink === null) problems.push("manageLink is missing on an email about a booking");
  }
  // What each purpose carries (MC C9; RULES 4.1, 4.1b).
  if (request.purpose === "confirmation") {
    if (bookingId === null) problems.push("a confirmation names its booking");
    if (chatLink === null) problems.push("a confirmation carries the chat link");
  } else if (chatLink !== null) problems.push("only a confirmation carries the chat link");
  if (request.purpose === "copy" && bookingId === null) problems.push("a copy names its booking");

  // What K-12 leaves to code (README 'The email row').
  const words = text as string;
  if (words.split(/\r?\n/)[0] !== assistantLine) problems.push("text does not start with assistantLine");
  if (typeof manageLink === "string" && !words.includes(manageLink))
    problems.push("text does not hold manageLink");
  if (isObject(chatLink) && typeof chatLink.link === "string" && !words.includes(chatLink.link))
    problems.push("text does not hold chatLink.link");
  return problems;
}
