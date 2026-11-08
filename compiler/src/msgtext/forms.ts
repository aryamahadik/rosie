// The plain-text forms of messages (T-134; C-064; K-01 v1 `message.plainText`).
//
// A master message is [from, to, text] or [from, to, text, elements]: its chat elements (buttons, a card, a time picker,
// a code, ...) show as the chat app shows them, and a customer on plain SMS gets the same message as text, which
// msgtext.js smsText() writes (msgtext.js lines 1-3). Every form here is smsText()'s own, called on the vendored script
// (script.ts); nothing of its wording is copied.
//
//   plainText()     the whole message as plain text: smsText() (K-01 message.plainText; MC 1 "a message as plain SMS").
//                   Slots such as {{due:$125}} stay in.
//   elementTexts()  each element's own form, in the order smsText() writes them after the words (msgtext.js lines
//                   53-65): what smsText() adds for that element, so the words and the forms, one per line, are the
//                   plain text. It lets code send one part plain and leave another out (arch 07 line 367: "A refused
//                   part goes again plain"), or drop the stop line where code adds it as a fixed line (arch 07 line 361).
//   typedOptions()  the buttons' form, "Reply 1 Accept, 2 Another time, 3 Decline.": the options typed, as the words
//                   carry them when no poll does (arch 07 lines 365, 367, 379; the message checks read it, T-312).
//   bareLinks()     a card's link alone (arch 07 line 367: "a card's bare link"; line 381: "SMS gets the link alone on
//                   its own line"), and a pay card's (msgtext.js line 6: ui.pay is "a pay card").
//   bundleMessage() a message as the bundle writes it, an object with its plain-text form (K-01 message).
//   flowMessages()  every message of a loaded flow: each step's say, each variant's say and addSay, branch steps too.
import type { FlowGraph, FlowLetter, Lane, Message, MessageElements, StepId } from "../graph/types.ts";
import { loadMsgText } from "./script";

/**
 * The element keys that have a text form of their own, in the order smsText() writes them after the words: card
 * (msgtext.js line 53), pay (54), list (55-58), times (59), code (60), form (61), photos (62), stars (63), buttons (64)
 * and the stop line (65). The script's other keys (letters, photoLink, lang, as, en) only change how these read.
 */
export const TEXT_FORM_KINDS = [
  "card",
  "pay",
  "list",
  "times",
  "code",
  "form",
  "photos",
  "stars",
  "buttons",
  "stop",
] as const;

export type TextFormKind = (typeof TEXT_FORM_KINDS)[number];

/** One element's plain-text form. */
export interface ElementText {
  kind: TextFormKind;
  text: string;
}

/** A message as the bundle writes it: its parts named, and its plain-text form (K-01 v1 message). */
export interface BundleMessage {
  from: Lane;
  to: Lane;
  text: string;
  elements?: MessageElements;
  plainText: string;
}

/** Where a message sits in its step: the step's own `say`, or a variant's `say` or `addSay` (SPEC-master 4, 5f). */
export type MessageList = "say" | "vary.say" | "vary.addSay";

/** One message of a flow, with where it is. */
export interface FlowMessage {
  flow: FlowLetter;
  step: StepId;
  list: MessageList;
  /** The variant's key, such as pf:sensitive, for a variant's message; else null. */
  vary: string | null;
  /** Its place in its list, from 0. */
  index: number;
  message: Message;
}

function isTextFormKind(key: string): key is TextFormKind {
  return (TEXT_FORM_KINDS as readonly string[]).includes(key);
}

/** The element keys msgtext.js knows (KEYS, line 27), a fresh copy. */
export function elementKeys(): string[] {
  return [...loadMsgText().KEYS];
}

/** The message as a customer on plain SMS gets it: msgtext.js smsText(). */
export function plainText(message: Message): string {
  return loadMsgText().smsText(message);
}

/**
 * Each element's own plain-text form, in smsText()'s order. An element's form is what smsText() adds for it to the
 * message read up to it (its words, the keys that only change how elements read, and the elements written before it),
 * so a form reads exactly as in the whole message: the stop line leaves out what the words already say, and stars
 * after a card with a link ask for a tap on the page. An element smsText() writes nothing for (a false `stars`) has no
 * form. Throws if smsText() does not write an element's form after what comes before it.
 */
export function elementTexts(message: Message): ElementText[] {
  const [from, to, text, elements] = message;
  if (elements === undefined) return [];
  const script = loadMsgText();
  const shown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(elements)) if (!isTextFormKind(key)) shown[key] = value;
  let before = script.smsText([from, to, text, { ...shown }]);
  const out: ElementText[] = [];
  for (const kind of TEXT_FORM_KINDS) {
    if (!Object.hasOwn(elements, kind)) continue;
    shown[kind] = elements[kind];
    const after = script.smsText([from, to, text, { ...shown }]);
    if (after === before) continue;
    if (before !== "" && !after.startsWith(`${before}\n`))
      throw new Error(
        `msgtext.js smsText() did not write the ${kind} element's form after what comes before it`,
      );
    out.push({ kind, text: before === "" ? after : after.slice(before.length + 1) });
    before = after;
  }
  return out;
}

/** The options typed, as the words carry them when no poll does: the buttons' form, or null with no buttons. */
export function typedOptions(message: Message): string | null {
  return elementTexts(message).find((form) => form.kind === "buttons")?.text ?? null;
}

/** The link of each card the message carries, alone: a card's, then a pay card's (smsText()'s order). */
export function bareLinks(message: Message): string[] {
  const elements = message[3];
  const links = [elements?.card?.link, elements?.pay?.link];
  return links.filter((link): link is string => typeof link === "string" && link !== "");
}

/** The message as the bundle writes it (K-01 message), with its plain-text form. Nothing of `message` is shared. */
export function bundleMessage(message: Message): BundleMessage {
  const [from, to, text, elements] = message;
  const plain = plainText(message);
  return elements === undefined
    ? { from, to, text, plainText: plain }
    : { from, to, text, elements: structuredClone(elements), plainText: plain };
}

/**
 * Every message of a loaded flow (compiler/src/load/flow.ts), step by step in the flow's order, branch steps included:
 * the step's own `say`, then each variant's `say` and `addSay`, in the variants' order.
 */
export function flowMessages(graph: FlowGraph): FlowMessage[] {
  const out: FlowMessage[] = [];
  const add = (
    step: StepId,
    list: MessageList,
    vary: string | null,
    messages: Message[] | undefined,
  ): void => {
    (messages ?? []).forEach((message, index) => {
      out.push({ flow: graph.flow, step, list, vary, index, message });
    });
  };
  for (const step of Object.values(graph.steps)) {
    add(step.id, "say", null, step.say);
    for (const [key, patch] of Object.entries(step.vary ?? {})) {
      add(step.id, "vary.say", key, patch.say);
      add(step.id, "vary.addSay", key, patch.addSay);
    }
  }
  return out;
}
