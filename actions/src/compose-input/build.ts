// The composer's input for one row (K-03 v1 composeInput; arch 07 line 397), built field by field in K-03's order, so
// nothing the row read carries beyond K-03's fields can reach it: never the frontier, nor any other list of choices
// (refuse-frontier-in-input.json). Each field:
//
//   row, turn         the row and the turn that committed it;
//   conversation      the reader's last 6 messages with this business, as the row read redacted them, oldest first, with
//                     the bundle's opt-out line taken out of Rosie's (master-line.ts; DL-245);
//   masterText        the step's line, word for word, its slots left in, never plainText (master-line.ts; DL-245);
//   facts             only what limit 7 lets this reader see (T-311's claimFacts over T-310's filler): each slot of the
//                     master line, then each slot the row is about, once, in that order, never a link (allowedLinks) or a
//                     slot filled at send; a secure-page-only field reads "Read it on the secure page", a field this
//                     reader may never see is not given, nor one code cannot fill; money values are the record's rows as
//                     T-310 fills them, so the input carries no money words of its own (DL-182; STATE note 56);
//   audience          the reader limit 7 reads (readerOf of the recipient's role), name, way and handling line;
//   language, channel, allowedFormats, options   as the row read gives them, each option's label word for word;
//   situation         code's tone tag (situation.ts; C-090);
//   allowedLinks      each link the step may carry, kept only when limit 7 shows it to this reader and code can fill it;
//   pageTypes         the step's (K-01 v1 step.pageTypes);
//   openQuestions     the questions still open with this reader, their words as sent, the opt-out line taken out;
//   inbound           the text the row replies to, only when it came from the row's own recipient: a reply to its sender
//                     (arch 07 line 397), else null.

import { claimFacts, claimText, type ClaimContext, type Reader } from "../finalize/claim-check";
import { VOCABULARY, isSlotName, type SlotName } from "../finalize/slots";
import { pieces } from "../finalize/slots/syntax";
import { ComposeInputRefusedError } from "./errors";
import { withoutOptOutLine, type MasterLine } from "./master-line";
import { sensitiveOn, signalsOf, situationOf } from "./situation";
import type {
  ComposeInput,
  ComposeRow,
  ConversationMessage,
  Fact,
  Format,
  Inbound,
  LinkSlot,
  OpenQuestion,
  Option,
} from "./types";

/** The most messages <conversation> holds: "the reader's last 6 messages with this business" (arch 07 line 397). */
export const MAX_CONVERSATION = 6;

/** Slots that are never facts: the links (allowedLinks names them) and today and tomorrow, filled at send. */
const NOT_FACTS: ReadonlySet<string> = new Set(
  VOCABULARY.filter((slot) => slot.kind === "link" || slot.kind === "send").map((slot) => slot.name),
);

/** The vocabulary slots a text names, each once, in order (the filler's own reading: slots/syntax.ts pieces). */
export function slotsIn(text: string): SlotName[] {
  const named: SlotName[] = [];
  for (const piece of pieces(text)) {
    if (piece.kind === "slot" && isSlotName(piece.ref.name) && !named.includes(piece.ref.name)) {
      named.push(piece.ref.name);
    }
  }
  return named;
}

/** The facts this reader may see: the master line's slots, then the row's, each once, through limit 7 and the fill. */
function factsOf(row: ComposeRow, claim: ClaimContext, masterText: string): Fact[] {
  const slots: SlotName[] = [];
  for (const slot of [...slotsIn(masterText), ...row.factSlots]) {
    if (isSlotName(slot) && !NOT_FACTS.has(slot) && !slots.includes(slot)) slots.push(slot);
  }
  return claimFacts(slots, row.source, claim).map(({ slot, value }) => ({ slot, value }));
}

/** The links this reader may be sent: each once, shown by limit 7 (not cut, not kept on the secure page) and filled. */
function linksOf(row: ComposeRow, claim: ClaimContext): LinkSlot[] {
  const kept: LinkSlot[] = [];
  for (const link of row.allowedLinks) {
    if (kept.includes(link) || !isSlotName(link)) continue;
    const claimed = claimText(`{{${link}}}`, row.source, claim);
    if (claimed.ok && claimed.slotValues.some((value) => value.slot === link)) kept.push(link);
  }
  return kept;
}

/**
 * The last 6 of the reader's messages, copied field by field, the opt-out line taken out of Rosie's; a message of
 * Rosie's that was that line alone says nothing once it is out, so it is left out.
 */
function conversationOf(row: ComposeRow, optOutLines: readonly string[]): ConversationMessage[] {
  const messages = row.conversation.flatMap((message): ConversationMessage[] => {
    const text = message.from === "rosie" ? withoutOptOutLine(message.text, optOutLines) : message.text;
    if (text === "" && message.text !== "") return [];
    return [{ from: message.from, text, sentAt: { utc: message.sentAt.utc, zone: message.sentAt.zone } }];
  });
  return messages.slice(-MAX_CONVERSATION);
}

/** The open questions, their words as sent with the opt-out line taken out. */
function openQuestionsOf(row: ComposeRow, optOutLines: readonly string[]): OpenQuestion[] {
  return row.openQuestions.map((question) => ({
    id: question.id,
    text: withoutOptOutLine(question.text, optOutLines),
  }));
}

/** The text the row replies to, only in a reply to its sender (arch 07 line 397); else null. */
function inboundOf(row: ComposeRow): Inbound | null {
  const inbound = row.inbound;
  if (inbound?.fromHandleId !== row.recipientHandleId) return null;
  return { text: inbound.text, sentAt: { utc: inbound.sentAt.utc, zone: inbound.sentAt.zone } };
}

/** At least one format, as K-03 v1 requires (allowedFormats minItems 1); refused when this phone allows none. */
function formatsOf(row: ComposeRow): [Format, ...Format[]] {
  const [first, ...rest] = row.allowedFormats;
  if (first === undefined) throw new ComposeInputRefusedError("inputRefused", 1);
  return [first, ...rest];
}

/** The composer's input for one row and its reader, from the row read and the step's master line (see the top). */
export function buildComposeInput(row: ComposeRow, reader: Reader, master: MasterLine): ComposeInput {
  const claim: ClaimContext = { ...row.claim, reader };
  const masterText = withoutOptOutLine(master.text, master.optOutLines);
  const facts = factsOf(row, claim, masterText);
  const allowedLinks = linksOf(row, claim);
  const named = [...slotsIn(masterText), ...facts.map((fact) => fact.slot), ...allowedLinks];
  const options: Option[] = row.options.map((option) => ({ id: option.id, label: option.label }));
  return {
    row: row.outboxRowId,
    turn: row.turnId,
    conversation: conversationOf(row, master.optOutLines),
    masterText: { step: master.step, text: masterText },
    facts,
    audience: { role: reader, name: row.name, way: row.way, handlingLine: row.handlingLine },
    language: row.language,
    channel: row.channel,
    situation: situationOf(signalsOf(row.situation, sensitiveOn(row.source), named)),
    allowedFormats: formatsOf(row),
    allowedLinks,
    options,
    pageTypes: [...master.pageTypes],
    openQuestions: openQuestionsOf(row, master.optOutLines),
    inbound: inboundOf(row),
  };
}
