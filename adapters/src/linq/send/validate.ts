// What the Linq send adapter refuses for its shape, before any request is built (T-414; K-11 v1 `sendPart.request`):
// the exact field set, so a field v1 does not have is refused (bold text decorations, a chosen service such as
// Linq's preferred_service, a read receipt), each field's form, what each kind carries and which kinds each service
// allows (arch 07 lines 365 to 393; DL-031). They are the Linq double's checks (T-411,
// adapters/src/linq/double/validate.ts), written again here so production code takes nothing from the double; this
// folder's test holds the two to the same answer on every K-11 fixture and on every fault it names. A problem line
// names the field, never its value: no words and no phone number in any message.

/** K-11 `phone`: E.164, as K-04's handles.address writes it. */
const PHONE = /^\+[1-9][0-9]{6,14}$/;
/** K-07 v1 `idempotencyKey`: `<row>/<part>/<try>`. */
const PART_KEY = /^.+\/[12]\/[1-9][0-9]*$/;
const SERVICES: readonly unknown[] = ["imessage", "rcs", "sms"];
const KINDS: readonly unknown[] = ["words", "poll", "linkCard", "tapback", "photo", "typing"];
const REQUEST_FIELDS = [
  "idempotencyKey",
  "to",
  "chatId",
  "service",
  "kind",
  "text",
  "calendarFile",
  "options",
  "link",
  "photo",
  "tapback",
  "threadedReplyTo",
  "typing",
  "overrideOptout",
];

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isId = (value: unknown): boolean => typeof value === "string" && value.length > 0;
const hasWords = (value: unknown): boolean => typeof value === "string" && /\S/.test(value);

/** Every listed field present, none other. */
function exactFields(path: string, value: Obj, fields: readonly string[], problems: string[]): void {
  for (const field of fields) if (!(field in value)) problems.push(`${path}.${field} is missing`);
  for (const field of Object.keys(value))
    if (!fields.includes(field)) problems.push(`${path}.${field} is not a field of v1`);
}

function checkCalendarFile(value: unknown, problems: string[]): void {
  if (!isObject(value)) {
    problems.push("calendarFile is not an object");
    return;
  }
  exactFields("calendarFile", value, ["action", "fileName", "ics"], problems);
  if (!["new", "move", "cancel"].includes(String(value.action)))
    problems.push("calendarFile.action is not known");
  if (typeof value.fileName !== "string" || !/^[^/\\]+[.]ics$/.test(value.fileName))
    problems.push("calendarFile.fileName is not an .ics name");
  if (typeof value.ics !== "string" || !value.ics.startsWith("BEGIN:VCALENDAR"))
    problems.push("calendarFile.ics is not a calendar file");
}

function checkPhoto(value: unknown, problems: string[]): void {
  if (!isObject(value)) {
    problems.push("photo is not an object");
    return;
  }
  exactFields("photo", value, ["fileId", "mediaType"], problems);
  if (!isId(value.fileId)) problems.push("photo.fileId is not an id");
  if (typeof value.mediaType !== "string" || !/^image\/[a-z0-9.+-]+$/.test(value.mediaType))
    problems.push("photo.mediaType is not an image type");
}

function checkTapback(value: unknown, problems: string[]): void {
  if (!isObject(value)) {
    problems.push("tapback is not an object");
    return;
  }
  exactFields("tapback", value, ["reaction", "onMessageId", "onPoll"], problems);
  if (value.reaction !== "like") problems.push("tapback.reaction is not like");
  if (!isId(value.onMessageId)) problems.push("tapback.onMessageId is not an id");
  if (value.onPoll !== false) problems.push("tapback.onPoll is not false: Linq refuses a tapback on a poll");
}

function checkThread(value: unknown, problems: string[]): void {
  if (!isObject(value)) {
    problems.push("threadedReplyTo is not an object");
    return;
  }
  exactFields("threadedReplyTo", value, ["messageId"], problems);
  if (!isId(value.messageId)) problems.push("threadedReplyTo.messageId is not an id");
}

/** The problems with one sendPart request, one line each; empty when K-11 v1 allows it. */
export function sendPartProblems(request: unknown): string[] {
  if (!isObject(request)) return ["the request is not an object"];
  const problems: string[] = [];
  exactFields("request", request, REQUEST_FIELDS, problems);
  if (problems.length > 0) return problems;

  const kind = request.kind;
  const service = request.service;
  if (!KINDS.includes(kind)) problems.push("kind is not a send kind of v1");
  if (!SERVICES.includes(service)) problems.push("service is not imessage, rcs or sms");
  if (typeof request.to !== "string" || !PHONE.test(request.to)) problems.push("to is not an E.164 number");
  if (!isId(request.chatId)) problems.push("chatId is not an id");
  if (typeof request.overrideOptout !== "boolean") problems.push("overrideOptout is not true or false");

  const key = request.idempotencyKey;
  if (key !== null && !(typeof key === "string" && PART_KEY.test(key)))
    problems.push("idempotencyKey is not <row>/<part>/<try>");
  if (request.text !== null && !hasWords(request.text)) problems.push("text is not words or null");
  if (request.calendarFile !== null) checkCalendarFile(request.calendarFile, problems);
  if (
    !Array.isArray(request.options) ||
    request.options.length > 5 ||
    !request.options.every((option) => hasWords(option))
  )
    problems.push("options is not a list of at most 5 words");
  if (request.link !== null && !(typeof request.link === "string" && /^https:\/\/\S+$/.test(request.link)))
    problems.push("link is not an https link or null");
  if (request.photo !== null) checkPhoto(request.photo, problems);
  if (request.tapback !== null) checkTapback(request.tapback, problems);
  if (request.threadedReplyTo !== null) checkThread(request.threadedReplyTo, problems);
  if (request.typing !== null && request.typing !== "start" && request.typing !== "stop")
    problems.push("typing is not start, stop or null");
  if (problems.length > 0) return problems;

  // What each kind carries (arch 07 lines 367 to 391): the kind's own field, and no other kind's.
  const optionCount = (request.options as unknown[]).length;
  const none = {
    text: request.text === null,
    calendarFile: request.calendarFile === null,
    options: optionCount === 0,
    link: request.link === null,
    photo: request.photo === null,
    tapback: request.tapback === null,
    threadedReplyTo: request.threadedReplyTo === null,
    typing: request.typing === null,
  };
  const allowed: Record<string, readonly (keyof typeof none)[]> = {
    words: ["text", "calendarFile", "threadedReplyTo"],
    poll: ["options"],
    linkCard: ["link"],
    tapback: ["tapback"],
    photo: ["photo"],
    typing: ["typing"],
  };
  const mayCarry = allowed[String(kind)] ?? [];
  for (const field of Object.keys(none) as (keyof typeof none)[]) {
    if (!mayCarry.includes(field) && !none[field])
      problems.push(`${field} is not carried by kind ${String(kind)}`);
  }
  if (kind === "words" && none.text) problems.push("words carry text");
  if (kind === "poll" && (optionCount < 2 || optionCount > 5)) problems.push("a poll carries 2 to 5 options");
  if (kind === "linkCard" && none.link) problems.push("a link card carries its link");
  if (kind === "tapback" && none.tapback) problems.push("a tapback carries its tapback");
  if (kind === "photo" && none.photo) problems.push("a photo carries its photo");
  if (kind === "typing" && none.typing) problems.push("typing dots carry start or stop");
  if (kind === "typing" && key !== null) problems.push("typing dots have no key");
  if (kind === "typing" && request.overrideOptout !== false)
    problems.push("typing dots never pass an opt-out");
  if (kind !== "typing" && key === null) problems.push("every part but typing dots carries its key");

  // What each service allows (arch 07 lines 377 to 391; DL-031): a chat Linq reports as SMS gets words alone.
  if (["poll", "tapback", "photo", "typing"].includes(String(kind)) && service !== "imessage")
    problems.push(`kind ${String(kind)} goes on iMessage only`);
  if (kind === "linkCard" && service === "sms") problems.push("a link card goes on iMessage or RCS only");
  if ((service === "sms" || service === "rcs") && !none.calendarFile)
    problems.push("a calendar file goes on iMessage only");
  if ((service === "sms" || service === "rcs") && !none.threadedReplyTo)
    problems.push("a threaded reply goes on iMessage only");
  return problems;
}
