// Test support for T-375's tests (C-118): the rows the recorded-model double (T-004) holds no plan for, each with the
// plan the model would answer, written here as K-03 v1 plans the way T-373's and T-374's tests serve a plan the double
// does not hold (ai/recordings is outside this card); and a slot source for the action layer's own slot filler (T-310),
// so a test reads what the reader would read. No network, no key, no live call (J-02; DL-027: CI makes none). Never
// imported by the Worker.
//
// Names and values are the master's sample cast (Alex M., Riley, Sam, Dee W., Lee's Barbershop, Sat Oct 24, 11:00am) and
// fixture set v1's therapist demo shop (Maya, "First session"), never a real person (rule 9). The quotes are a sample
// customer's questions, none of them private (RULES 4.5): a private quote reaches staff only as "Read it on the secure
// page" (A7-12; plan-relay-private-a7-12.json).

import type { SlotSource } from "../../../../actions/src/finalize/slots";
import { COMPOSER_EXAMPLES, type ComposeInput, type MessagePlan } from "../prompt";
import { recordedInput } from "../test-support";

const ZONE = "America/New_York";
const at = (utc: string): { utc: string; zone: string } => ({ utc, zone: ZONE });

/** The A7-12 relay the double holds (relay-private-a7-12): Alex's question to Riley, with a private part. */
export const PRIVATE_RELAY: ComposeInput = recordedInput("relay-private-a7-12");

// ---- a relay into English, and one into Spanish (S13-37: translated, with the original kept) -------------------------

/** Alex's question in Spanish: "Is there parking near the shop?". */
export const SPANISH_QUOTE = "¿Hay estacionamiento cerca de la tienda?";

/** A7-12's relay of Alex's Spanish question to Riley, who reads English: the quote is clear, so limit 7 gives it whole. */
export const RELAY_INTO_ENGLISH: ComposeInput = {
  ...PRIVATE_RELAY,
  row: "outbox-a7-12-riley-2",
  turn: "turn-a7-12-alex-asks-es",
  facts: [
    { slot: "alex.staff", value: "Alex M." },
    { slot: "relay.quote", value: SPANISH_QUOTE },
  ],
  allowedLinks: [],
};

/** The relay into English: the original through {{relay.quote}}, once, and the model's translation beside it. */
export const TRANSLATED_INTO_ENGLISH: MessagePlan = {
  formats: ["text", "poll"],
  lines: [
    { role: "first", text: "{{alex.staff}} asks, in Spanish: {{relay.quote}}" },
    { role: "fact", text: "In English, they ask whether there is parking near the shop." },
  ],
  question: { text: "Your answer for {{alex.staff}}?", optionIds: ["A7-12/1", "A7-12/2", "A7-12/3"] },
  pageType: null,
  threadReplyTo: null,
};

/** Alex's question in English, relayed to a colleague of Riley's who reads Spanish (their stored language). */
export const ENGLISH_QUOTE = "Can I bring my dog to the visit?";

export const RELAY_INTO_SPANISH: ComposeInput = {
  ...RELAY_INTO_ENGLISH,
  row: "outbox-a7-12-avery-1",
  turn: "turn-a7-12-alex-asks-en",
  facts: [
    { slot: "alex.staff", value: "Alex M." },
    { slot: "relay.quote", value: ENGLISH_QUOTE },
  ],
  audience: { role: "staff", name: "Avery", way: "texts", handlingLine: null },
  language: "es",
  options: [
    { id: "A7-12/1", label: "Sí" },
    { id: "A7-12/2", label: "No" },
    { id: "A7-12/3", label: "Llamar a Alex" },
  ],
};

/** The relay into Spanish: the English original through {{relay.quote}}, and the model's Spanish beside it. */
export const TRANSLATED_INTO_SPANISH: MessagePlan = {
  formats: ["text", "poll"],
  lines: [
    { role: "first", text: "{{alex.staff}} pregunta, en inglés: {{relay.quote}}" },
    { role: "fact", text: "En español: pregunta si puede llevar a su perro a la visita." },
  ],
  question: { text: "¿Tu respuesta para {{alex.staff}}?", optionIds: ["A7-12/1", "A7-12/2", "A7-12/3"] },
  pageType: null,
  threadReplyTo: null,
};

// ---- a Spanish text gets a Spanish plan (arch 06 line 341) ------------------------------------------------------------

/** The composer prompt's fourth worked example: A6-02's wait for the owner's answer, in Spanish (Alex wrote in it twice). */
const WAIT_IN_SPANISH = COMPOSER_EXAMPLES[3];
if (WAIT_IN_SPANISH?.input.language !== "es")
  throw new Error("the prompt's fourth example is the Spanish one");

/** Stored language: the prompt's own Spanish row, no text to reply to, and the plan it shows. */
export const STORED_SPANISH: ComposeInput = WAIT_IN_SPANISH.input;
export const SPANISH_PLAN: MessagePlan = WAIT_IN_SPANISH.plan;

/** The language of the text: Alex texts in Spanish while waiting, and the row replies to that text, in the chat. */
export const SPANISH_TEXT: ComposeInput = {
  ...WAIT_IN_SPANISH.input,
  row: "outbox-a6-02-alex-es",
  turn: "turn-a6-02-alex-asks-es",
  channel: "imessage",
  inbound: { text: "¿Ya respondió la barbería?", sentAt: at("2026-10-22T15:10:00Z") },
};

/** The same row answered in English, as a model might, whatever <language> says. */
export const ENGLISH_PLAN: MessagePlan = {
  formats: ["text"],
  lines: [
    { role: "first", text: "{{biz.name}} hasn't answered your request yet." },
    { role: "fact", text: "{{svc.intext}} · {{day}} · {{visit.time}} · {{pro.name}}" },
    { role: "fact", text: "You'll hear back by {{ask.by}}. Nothing is charged for this visit until then." },
  ],
  question: null,
  pageType: null,
  threadReplyTo: null,
};

/** The same wait, Alex texting in English: the language of the text is English, so a Spanish plan is not theirs. */
export const ENGLISH_TEXT: ComposeInput = {
  ...SPANISH_TEXT,
  row: "outbox-a6-02-alex-en",
  turn: "turn-a6-02-alex-asks-en",
  conversation: [],
  language: "en",
  inbound: { text: "Has the barbershop answered yet?", sentAt: at("2026-10-22T15:10:00Z") },
};

// ---- sensitive work (S13-22; RULES 4.6) --------------------------------------------------------------------------------

/** A6-15's new booking to Maya on sensitive work, the row the double holds (sensitive-a6-15: plan-sensitive.json). */
export const SENSITIVE: ComposeInput = recordedInput("sensitive-a6-15");

/**
 * The same row as the bundle's master line would write it with its sample values as slots (arch 12 line 592): the
 * customer's sample name and the shop's sample service as example words, and the master's own words after "|".
 */
export const SENSITIVE_WITH_SAMPLES: ComposeInput = {
  ...SENSITIVE,
  masterText: {
    step: "A6-15",
    text: "New booking: {{day:Sat}} {{visit.time:11:00am}}, {{alex.staff:Alex M.}} · {{svc.intext:First session|visit}} Answers and notes: open the job.",
  },
};

/**
 * A7-01's reminder to Alex on sensitive work, its master line ("Reminder: your visit is Sat at 11:00am with Riley ... /
 * Lee's Barbershop · Haircut") with the therapist shop's sample values as slots: the service comes as nothing.
 */
export const SENSITIVE_REMINDER: ComposeInput = {
  row: "outbox-a7-01-alex-1",
  turn: "turn-a7-01-reminder",
  conversation: [],
  masterText: {
    step: "A7-01",
    text: "Reminder: your visit is {{day:Sat}} at {{visit.time:11:00am}} with {{pro.name:Maya}}. {{biz.name:Lee Associates}} · {{svc.intext:First session}}",
  },
  facts: [
    { slot: "day", value: "Sat Oct 24" },
    { slot: "visit.time", value: "11:00am" },
    { slot: "pro.name", value: "Maya" },
    { slot: "biz.name", value: "Lee Associates" },
    { slot: "svc.intext", value: "" },
  ],
  audience: { role: "customer", name: "Alex", way: "texts", handlingLine: null },
  language: "en",
  channel: "imessage",
  situation: "gentle",
  allowedFormats: ["text"],
  allowedLinks: ["link.secure"],
  options: [],
  pageTypes: [],
  openQuestions: [],
  inbound: null,
};

/** The reminder as "your visit": the day, the time, the pro and the business as slots, the service slot kept, no service. */
export const YOUR_VISIT_PLAN: MessagePlan = {
  formats: ["text"],
  lines: [
    { role: "first", text: "Reminder: your visit is {{day}} at {{visit.time}} with {{pro.name}}." },
    { role: "fact", text: "{{biz.name}} · {{svc.intext}}" },
    { role: "action", text: "The details are on the secure page: {{link.secure}}" },
  ],
  question: null,
  pageType: null,
  threadReplyTo: null,
};

/**
 * The slot filler's source for these rows with the sensitive switch on (T-310's SlotSource): the record holds the
 * customer's whole name and the service, which the switch hides.
 */
export const SENSITIVE_SOURCE: SlotSource = {
  filledAt: "2026-10-22T14:00:00Z",
  zones: { visit: ZONE, business: ZONE },
  channel: "imessage",
  sensitive: true,
  record: null,
  facts: {
    business: { name: "Lee Associates", displayName: "Lee Associates" },
    customerName: "Alex M.",
    proName: "Maya",
    serviceName: "First session",
    visit: { start: at("2026-10-24T15:00:00Z") },
    links: { secure: "https://rosfield.com/v/s03" },
  },
};

// ---- private words in a reply to its sender (RULES 4.5; S12-30) --------------------------------------------------------

/**
 * S12-30's reply to Dee, who texted a card number: the edge scrub swapped it for its tag, and an earlier text's ID number
 * too; the row read gave a health word as "a private detail".
 */
export const PRIVATE_WORDS_REPLY: ComposeInput = {
  row: "outbox-s12-30-dee-1",
  turn: "turn-s12-30-dee-card",
  conversation: [
    { from: "reader", text: "Is a private detail a problem for my cut?", sentAt: at("2026-10-22T14:00:00Z") },
    { from: "rosie", text: "Riley will go over it at your visit.", sentAt: at("2026-10-22T14:00:20Z") },
    { from: "reader", text: "My SSN is [SSN] if the shop needs it.", sentAt: at("2026-10-22T14:01:00Z") },
  ],
  masterText: {
    step: "S12-30",
    text: "For your safety, I deleted that photo. Cards go only on the secure pay page.",
  },
  facts: [],
  audience: { role: "customer", name: "Dee", way: "texts", handlingLine: null },
  language: "en",
  channel: "imessage",
  situation: "routine",
  allowedFormats: ["text", "linkCard"],
  allowedLinks: ["link.pay"],
  options: [],
  pageTypes: [],
  openQuestions: [],
  inbound: { text: "Here's my card for Saturday: [card number]", sentAt: at("2026-10-22T14:02:00Z") },
};

/** The reply: what was deleted and where cards go, once, with the pay page's link; nothing of the detail. */
export const DELETED_PLAN: MessagePlan = {
  formats: ["text", "linkCard"],
  lines: [
    { role: "first", text: "For your safety, I deleted that. Cards go only on the secure pay page." },
    { role: "action", text: "Open the pay page: {{link.pay}}" },
  ],
  question: null,
  pageType: null,
  threadReplyTo: null,
};

// ---- helpers ------------------------------------------------------------------------------------------------------------

/** A plan with one line's words changed, as a model might write them. */
export function withLine(plan: MessagePlan, k: number, text: string): MessagePlan {
  if (plan.lines[k] === undefined) throw new Error(`the plan has no line ${String(k)}`);
  return { ...plan, lines: plan.lines.map((line, n) => (n === k ? { ...line, text } : line)) };
}

/** A plan with its question's words changed. */
export function withQuestion(plan: MessagePlan, text: string): MessagePlan {
  if (plan.question === null) throw new Error("the plan has no question");
  return { ...plan, question: { ...plan.question, text } };
}
