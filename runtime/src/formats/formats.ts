// Allowed formats (T-261; C-128): for each outbox row, code lists what this phone allows right now, and the composer
// picks from it (arch 07 line 365, "How the AI picks the format", and the formats table, lines 373 to 393). A pure
// module: it reads the row's facts and asks the capability check through a lookup it is handed; it writes nothing and
// logs nothing. Wiring it into the compose input and the root is a later join; the composer's pick is T-373's.
//
// The channel, first that tells (arch 07 line 365):
//   1. an email row: email, which takes text alone (its own row with typed options: arch 07 line 371);
//   2. no chat with Rosie's number (K-04 phones.chat_open): text alone. Rosie never opens a chat (arch 07 line 369;
//      RULES 4.1b; K-11 sendPart goes only into an existing chat), so such a text is the SMS port's, which takes words
//      alone;
//   3. the service of the text the row replies to, when its own recipient sent it (HANDOFF 6; K-06 `service`, as the
//      actor stored it). A chat Linq reports as SMS gets text only, and one it reports as RCS text and link cards (CQ-11
//      as DL-031 answered it; K-11 v1 README open gap 8);
//   4. else Linq's capability check, kept 10 minutes (./capability.ts);
//   5. else text alone: the check failed, or could not tell (arch 07 line 365, DD).
//
// Then each format, as the table allows it:
//   text          always;
//   poll          iMessage, in an existing chat, for a closed question with 2 to 5 options (line 379);
//   link card     iMessage or RCS, for an action on a secure page: a page type the step allows, or a secure-page link
//                 the message may carry (link.secure, or link.pay, which pays through the secure page) (line 381);
//   calendar file iMessage, with a confirmation, move or call-off (line 383);
//   tapback       iMessage, in reply to a text or photo of the recipient's own (a message a like can go on: K-06
//                 messageId; never a poll, which Linq rejects), when every part of the turn maps to no_op, no question
//                 is open and the tag is routine (line 391).
// Code's own tested formats (MC 8 'iPhone tests'), which the composer does not pick:
//   typing dots    iMessage, from the turn lease to the reply, so only for a reply (line 385);
//   threaded reply iMessage, when a reply answers one of several open questions (line 389).
// Never listed: bold text decorations and read receipts, not tested yet (MC 8: a format not tested gets its test
// first; lines 377, 387), and arch 07 line 393's Never row. None is a K-03 format or a code format here, so no list
// can hold one.
//
// The vote rule (line 379): phones before iOS 26 show no poll, and Linq cannot tell which phone it is, so until the
// handle has voted in a poll, a poll plan's words also carry its options in msgtext.js's text form; after that the
// choices go only in the poll (S13-16). Without a poll, the words carry the options in that form (line 365: "the
// step's elements, in msgtext.js's text form unless a poll or card carries them"). typedOptionsFor applies both.

import type {
  AllowedFormats,
  AnsweredText,
  Capability,
  CapabilityLookup,
  Channel,
  ChannelFrom,
  CodeFormat,
  Format,
  FormatsRow,
  LinqService,
  StepFacts,
} from "./types";

/** K-03 v1's formats, in its order: the closed list the composer picks from (arch 07 lines 373 to 393). */
export const FORMATS: readonly Format[] = ["text", "poll", "linkCard", "calendarFile", "tapback"];

/** Code's own formats tested on Nov 5 (MC 8 'iPhone tests'), in the table's order (arch 07 lines 385, 389). */
export const CODE_FORMATS: readonly CodeFormat[] = ["typingDots", "threadedReply"];

/**
 * Formats not tested yet, so never listed until their test passes (MC 8 'iPhone tests'): bold text decorations (arch
 * 07 line 377) and read receipts (line 387).
 */
export const UNTESTED_FORMATS: readonly string[] = ["bold", "readReceipt"];

/**
 * Never, any time (arch 07 line 393): screen and bubble effects, stickers and text animations; voice memos, location
 * requests, App Clips, Linq payment requests and group chats; contact cards, which Linq refuses for our line.
 */
export const NEVER_FORMATS: readonly string[] = [
  "screenEffect",
  "bubbleEffect",
  "sticker",
  "textAnimation",
  "voiceMemo",
  "locationRequest",
  "appClip",
  "linqPaymentRequest",
  "groupChat",
  "contactCard",
];

/** A poll asks a closed question with 2 to 5 options (arch 07 line 379; K-11 sendPart poll). */
export const POLL_OPTIONS = { min: 2, max: 5 } as const;

/** The links that open an action on the secure page (K-03 v1 linkSlot; slots.json: link.pay pays through it). */
const SECURE_PAGE_LINKS: ReadonlySet<string> = new Set(["link.secure", "link.pay"]);

/** Several open questions, so a reply can thread under the one it answers (arch 07 line 389). */
const SEVERAL = 2;

/** The text the row replies to: the turn's text when the row's own recipient sent it (arch 07 line 397), else null. */
function replyTo(row: FormatsRow): AnsweredText | null {
  return row.answers !== null && row.answers.fromHandleId === row.to.handleId ? row.answers : null;
}

/** The service a Linq answer names for the number now; with none named, iMessage only when Linq says it takes it. */
function channelOfCheck(capability: Capability): LinqService | null {
  if (capability.result !== "checked") return null;
  if (capability.service === "rcs" || capability.service === "sms") return capability.service;
  return capability.imessage ? "imessage" : null;
}

/** The capability check's answer, or failed when the lookup itself throws: text alone either way. */
async function lookUp(capabilities: CapabilityLookup, phone: string): Promise<Capability> {
  try {
    return await capabilities.lookup(phone);
  } catch {
    return { result: "failed", cached: false };
  }
}

/** The channel and where it came from (arch 07 line 365): see the top. */
async function channelOf(
  row: FormatsRow,
  capabilities: CapabilityLookup,
): Promise<{ channel: Channel | null; channelFrom: ChannelFrom }> {
  const to = row.to;
  if (to.kind === "email") return { channel: "email", channelFrom: "email" };
  if (!to.chatOpen) return { channel: null, channelFrom: "noChat" };
  const service = replyTo(row)?.service;
  if (service === "imessage" || service === "rcs" || service === "sms") {
    return { channel: service, channelFrom: "answeredText" };
  }
  const capability = await lookUp(capabilities, to.phone);
  const checked = channelOfCheck(capability);
  if (checked === null) return { channel: null, channelFrom: "checkFailed" };
  return { channel: checked, channelFrom: capability.cached ? "capabilityCache" : "capabilityCheck" };
}

const pollFits = (step: StepFacts): boolean =>
  Number.isInteger(step.optionCount) &&
  step.optionCount >= POLL_OPTIONS.min &&
  step.optionCount <= POLL_OPTIONS.max;

const securePageAction = (step: StepFacts): boolean =>
  step.pageTypes.length > 0 || step.allowedLinks.some((link) => SECURE_PAGE_LINKS.has(link));

/** A tapback in place of a reply (arch 07 line 391): on the recipient's own text or photo, a "thanks!" turn. */
function tapbackFits(reply: AnsweredText | null, step: StepFacts): boolean {
  return (
    reply !== null &&
    (reply.kind === "text" || reply.kind === "photo") &&
    step.turnAllNoOp &&
    step.openQuestionCount === 0 &&
    step.situation === "routine"
  );
}

/**
 * The formats and code formats a row's channel allows with its step and turn (the table, arch 07 lines 377 to 393). A
 * Linq channel is only ever known in an existing chat (see channelOf), so the poll's "in an existing chat" holds here.
 */
export function formatsOn(
  channel: Channel | null,
  row: FormatsRow,
): Pick<AllowedFormats, "formats" | "codeFormats"> {
  const step = row.step;
  const reply = replyTo(row);
  const imessage = channel === "imessage";
  const allowed = new Set<Format>(["text"]);
  if (imessage && pollFits(step)) allowed.add("poll");
  if ((imessage || channel === "rcs") && securePageAction(step)) allowed.add("linkCard");
  if (imessage && step.calendarFile !== "none") allowed.add("calendarFile");
  if (imessage && tapbackFits(reply, step)) allowed.add("tapback");

  const code = new Set<CodeFormat>();
  if (imessage && reply !== null) code.add("typingDots");
  if (imessage && reply !== null && step.openQuestionCount >= SEVERAL) code.add("threadedReply");

  return {
    formats: ["text", ...FORMATS.filter((format) => format !== "text" && allowed.has(format))],
    codeFormats: CODE_FORMATS.filter((format) => code.has(format)),
  };
}

/** What this phone allows right now for one outbox row (arch 07 line 365): see the top. Never throws. */
export async function allowedFormatsFor(
  row: FormatsRow,
  capabilities: CapabilityLookup,
): Promise<AllowedFormats> {
  const { channel, channelFrom } = await channelOf(row, capabilities);
  return {
    channel,
    channelFrom,
    ...formatsOn(channel, row),
    choicesOnlyInPoll: row.to.kind === "phone" && row.to.votedInPoll,
  };
}

/**
 * The formats a plan goes as: its own when this phone allows every one of them now, else text alone (arch 07 line 365:
 * "a plan outside the list goes as text alone and is logged"; the log is the caller's, through the non-blocking Format
 * check, C-092).
 */
export function formatsToSend(
  allowed: AllowedFormats,
  planFormats: readonly string[],
): [Format, ...Format[]] {
  const own = FORMATS.filter((format) => planFormats.includes(format));
  const [first, ...rest] = own;
  const inList = planFormats.every((format) =>
    allowed.formats.some((allowedFormat) => allowedFormat === format),
  );
  return first === undefined || !inList ? ["text"] : [first, ...rest];
}

/**
 * The step's options as the words carry them for this plan, or null when the words carry none (arch 07 lines 365, 379):
 * `typed` is the options in msgtext.js's text form (the bundle's own form of the buttons, C-064), or null with none.
 * Without a poll, the words carry them; with a poll, until the handle has voted in a poll as well; after a vote, only the
 * poll does.
 */
export function typedOptionsFor(
  allowed: AllowedFormats,
  planFormats: readonly string[],
  typed: string | null,
): string | null {
  if (typed === null) return null;
  if (!formatsToSend(allowed, planFormats).includes("poll")) return typed;
  return allowed.choicesOnlyInPoll ? null : typed;
}
