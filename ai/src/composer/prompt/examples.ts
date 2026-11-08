// The composer prompt's five worked examples (T-372, C-119; arch 07 line 399: "five worked examples across readers and
// channels, one a relay to staff with a private part (A7-12)"). Each is a whole K-03 v1 composeInput and the plan the
// composer should return for it; the prompt shows the input as composeInputText shows a real row (render.ts).
//
//   n  reader    channel   tag             language  step   the plan
//   1  staff     imessage  routine         en        A7-12  K-03's plan-relay-private-a7-12.json
//   2  customer  imessage  moneyOrConsent  en        A6-14  K-03's plan-confirmation-a6-14.json
//   3  owner     sms       routine         en        A6-02  the owner's request, its deadline as {{ask.by}}
//   4  customer  email     problem         es        A6-02  the customer's wait, translated
//   5  staff     rcs       gentle          en        A6-15  K-03's plan-sensitive.json
//
// Words and values are the master's sample cast and fixture set v1's therapist demo shop (rule 9; SPEC-master 6): the
// master lines of A7-12, A6-14 and A6-02 as the master writes them, with their sample values as slots (arch 12 line
// 592), and K-03's own fixtures' inputs and plans. Option ids are opaque ids in K-02's form (c-01), not K-03's
// placeholders (A7-12/1), so no example shows the model a step id; the row and turn ids and the step ids are never shown
// (render.ts). Each example's plan validates against K-03 v1's `$defs/plan`, and no example holds a raw price, date or
// name outside a slot or a code-supplied value, an emoji or a step id (prompt.test.ts).

import type { ComposeInputV1, MessagePlan } from "./types";

/** One worked example: what it shows, the row's input (a K-03 v1 input: slot facts only), the plan to return and why. */
export interface ComposerExample {
  /** A short title, shown on the example. */
  readonly title: string;
  readonly input: ComposeInputV1;
  readonly plan: MessagePlan;
  /** Why the plan is worded as it is, in plain words. */
  readonly why: string;
}

const ZONE = "America/New_York";

/** 1. A7-12: a relay to staff with a private part, on iMessage, as a poll. */
const RELAY_PRIVATE: ComposerExample = {
  title: "A relay to staff with a private part",
  input: {
    row: "row-example-relay",
    turn: "turn-example-relay",
    conversation: [],
    masterText: {
      step: "A7-12",
      text: "{{alex.staff:Alex M.}} asks: {{relay.quote:Can my son wait in the shop during my cut?}}",
    },
    facts: [
      { slot: "alex.staff", value: "Alex M." },
      { slot: "relay.quote", value: "Read it on the secure page" },
    ],
    audience: { role: "staff", name: "Riley", way: "texts", handlingLine: null },
    language: "en",
    channel: "imessage",
    situation: "routine",
    allowedFormats: ["text", "poll"],
    allowedLinks: ["link.secure"],
    options: [
      { id: "c-01", label: "Yes" },
      { id: "c-02", label: "No" },
      { id: "c-03", label: "Call Alex" },
    ],
    pageTypes: [],
    openQuestions: [],
    inbound: null,
  },
  plan: {
    formats: ["text", "poll"],
    lines: [
      { role: "first", text: "{{alex.staff}} asks: {{relay.quote}}" },
      { role: "action", text: "Read it on the secure page: {{link.secure}}" },
    ],
    question: { text: "Your answer for {{alex.staff}}?", optionIds: ["c-01", "c-02", "c-03"] },
    pageType: null,
    threadReplyTo: null,
  },
  why: "A relay names the sender and quotes them only through {{relay.quote}}. The customer's words held a child's details, so code filled the quote with \"Read it on the secure page\": the plan never retypes the example words in <master_text>, and it points to the secure page with its link. The question offers the three options by id, and the poll carries their labels.",
};

/** 2. A6-14: a confirmation to a customer, on iMessage, with a calendar file and a link card. */
const CONFIRMATION: ComposerExample = {
  title: "A confirmation to a customer",
  input: {
    row: "row-example-confirmation",
    turn: "turn-example-confirmation",
    conversation: [],
    masterText: { step: "A6-14", text: "You're booked! Give this code at the chair when you arrive." },
    facts: [
      { slot: "biz.name", value: "Lee's Barbershop" },
      { slot: "visit.code", value: "5160" },
      { slot: "svc.intext", value: "Haircut" },
      { slot: "day", value: "Sat Oct 24" },
      { slot: "visit.time", value: "11:00am" },
      { slot: "pro.name", value: "Riley" },
      { slot: "visit.place", value: "88 Elm St, Springfield" },
      { slot: "pay.price", value: "$35, paid at the chair" },
      { slot: "pay.took", value: "The card is saved for a $20 fee" },
      { slot: "pay.cancel", value: "Free to cancel until Fri 11am, then a $20 fee may apply" },
    ],
    audience: { role: "customer", name: "Alex", way: "texts", handlingLine: null },
    language: "en",
    channel: "imessage",
    situation: "moneyOrConsent",
    allowedFormats: ["text", "calendarFile", "linkCard"],
    allowedLinks: ["link.secure"],
    options: [],
    pageTypes: [],
    openQuestions: [],
    inbound: { text: "Yes, book it", sentAt: { utc: "2026-10-22T14:02:50Z", zone: ZONE } },
  },
  plan: {
    formats: ["text", "calendarFile", "linkCard"],
    lines: [
      {
        role: "first",
        text: "You're booked at {{biz.name}}. Give this code at the chair when you arrive: {{visit.code}}",
      },
      { role: "fact", text: "{{svc.intext}} · {{day}} · {{visit.time}} · {{pro.name}}" },
      { role: "fact", text: "{{visit.place}}" },
      { role: "fact", text: "{{pay.price}} · {{pay.took}}" },
      { role: "fact", text: "{{pay.cancel}}" },
      { role: "action", text: "Change the time or call off the visit: {{link.secure}}" },
    ],
    question: null,
    pageType: null,
    threadReplyTo: null,
  },
  why: "Money and consent: every value is a slot, never words that describe it. The first line says what happened, names the business and gives the code. Four fact lines carry what, when, who, where and the money, and the action line ends with the secure link, which the link card carries too; the calendar file rides with the words. The master line keeps its meaning and order, and now names the business, as every message does.",
};

/** 3. A6-02: a request the owner must answer, on sms (an owner's Android chat), with its deadline and default. */
const OWNER_REQUEST: ComposerExample = {
  title: "A request an owner must answer",
  input: {
    row: "row-example-request",
    turn: "turn-example-request",
    conversation: [],
    masterText: {
      step: "A6-02",
      text: [
        "New request from {{alex.staff}} Please answer within 4 of your text hours, or it isn't booked.",
        "{{svc.intext:Haircut}}",
        "{{day:Sat Oct 24}} · {{visit.time:11:00am}} · {{pro.name:Riley}}",
        "Nothing is charged for this visit until you accept",
      ].join("\n"),
    },
    facts: [
      { slot: "alex.staff", value: "Alex M." },
      { slot: "svc.intext", value: "Haircut" },
      { slot: "day", value: "Sat Oct 24" },
      { slot: "visit.time", value: "11:00am" },
      { slot: "pro.name", value: "Riley" },
      { slot: "ask.by", value: "2:50pm Thu" },
    ],
    audience: { role: "owner", name: "Sam", way: "texts", handlingLine: null },
    language: "en",
    channel: "sms",
    situation: "routine",
    allowedFormats: ["text"],
    allowedLinks: [],
    options: [
      { id: "c-01", label: "Accept" },
      { id: "c-02", label: "Another time" },
      { id: "c-03", label: "Decline" },
    ],
    pageTypes: [],
    openQuestions: [],
    inbound: null,
  },
  plan: {
    formats: ["text"],
    lines: [
      { role: "first", text: "New request from {{alex.staff}}." },
      { role: "fact", text: "{{svc.intext}} · {{day}} · {{visit.time}} · {{pro.name}}" },
      { role: "fact", text: "Nothing is charged for this visit until you accept." },
    ],
    question: {
      text: "Please answer by {{ask.by}}, or it isn't booked.",
      optionIds: ["c-01", "c-02", "c-03"],
    },
    pageType: null,
    threadReplyTo: null,
  },
  why: "An owner gets one ask that says what is decided, the money, the deadline and what silence does. The master line counts its deadline in text hours; the plan gives it as {{ask.by}}, a day and clock time. On sms there is no poll: the question still lists the option ids, and code types the options after it.",
};

/** 4. A6-02: the customer's wait for the owner's answer, by email, in Spanish, tagged problem. */
const WAIT_IN_SPANISH: ComposerExample = {
  title: "A problem update in the reader's language",
  input: {
    row: "row-example-waiting",
    turn: "turn-example-waiting",
    conversation: [
      {
        from: "reader",
        text: "Hola, quiero reservar un corte de pelo.",
        sentAt: { utc: "2026-10-22T14:35:00Z", zone: ZONE },
      },
      {
        from: "rosie",
        text: "¿Envío tu solicitud a la barbería?",
        sentAt: { utc: "2026-10-22T14:35:20Z", zone: ZONE },
      },
      { from: "reader", text: "Sí, envíala por favor.", sentAt: { utc: "2026-10-22T14:36:00Z", zone: ZONE } },
    ],
    masterText: {
      step: "A6-02",
      text: "{{biz.name:Lee's Barbershop}} hasn't answered yet. You'll hear by {{ask.by:Thu 11:20am}}. Nothing is charged for this visit until then.",
    },
    facts: [
      { slot: "biz.name", value: "Lee's Barbershop" },
      { slot: "svc.intext", value: "Haircut" },
      { slot: "day", value: "Sat Oct 24" },
      { slot: "visit.time", value: "11:00am" },
      { slot: "pro.name", value: "Riley" },
      { slot: "ask.by", value: "Thu 11:20am" },
    ],
    audience: { role: "customer", name: "Alex", way: "email", handlingLine: null },
    language: "es",
    channel: "email",
    situation: "problem",
    allowedFormats: ["text"],
    allowedLinks: [],
    options: [],
    pageTypes: [],
    openQuestions: [],
    inbound: null,
  },
  plan: {
    formats: ["text"],
    lines: [
      { role: "first", text: "{{biz.name}} aún no ha respondido a tu solicitud." },
      { role: "fact", text: "{{svc.intext}} · {{day}} · {{visit.time}} · {{pro.name}}" },
      {
        role: "fact",
        text: "Tendrás su respuesta antes de {{ask.by}}. Hasta entonces, no se cobra nada por esta visita.",
      },
    ],
    question: null,
    pageType: null,
    threadReplyTo: null,
  },
  why: "<language> is es because the reader wrote in Spanish twice, whatever their name suggests. The master line is translated, keeping its meaning, its order and its slots, and the request is named in full. The problem tone says calmly what happened, what is kept and what comes next, and blames no one.",
};

/** 5. A6-15: a new booking for sensitive work, to staff, on RCS (K-03's plan-sensitive.json). */
const SENSITIVE: ComposerExample = {
  title: "Sensitive work, to staff",
  input: {
    row: "row-example-sensitive",
    turn: "turn-example-sensitive",
    conversation: [],
    masterText: {
      step: "A6-15",
      text: "New booking: {{day:Sat}} {{visit.time:11:00am}}, {{alex.staff}} Answers and notes: open the job.",
    },
    facts: [
      { slot: "alex.staff", value: "A.M." },
      { slot: "svc.intext", value: "" },
      { slot: "day", value: "Sat Oct 24" },
      { slot: "visit.time", value: "11:00am" },
    ],
    audience: { role: "staff", name: "Maya", way: "texts", handlingLine: null },
    language: "en",
    channel: "rcs",
    situation: "gentle",
    allowedFormats: ["text"],
    allowedLinks: ["link.secure"],
    options: [],
    pageTypes: [],
    openQuestions: [],
    inbound: null,
  },
  plan: {
    formats: ["text"],
    lines: [
      {
        role: "first",
        text: "New booking: {{alex.staff}} · {{svc.intext:First session}} · {{day}} · {{visit.time}}",
      },
      { role: "action", text: "The details are on the secure page: {{link.secure}}" },
    ],
    question: null,
    pageType: null,
    threadReplyTo: null,
  },
  why: 'Sensitive work: code fills {{alex.staff}} with initials and {{svc.intext}} with nothing, so the plan writes the slots as any plan would and adds no service or reason in its own words; the master line\'s notes become the secure link, where the details stay. The tone is gentle: plain, with no "!".',
};

/** The five worked examples, in the order the prompt shows them. */
export const COMPOSER_EXAMPLES: readonly ComposerExample[] = Object.freeze([
  RELAY_PRIVATE,
  CONFIRMATION,
  OWNER_REQUEST,
  WAIT_IN_SPANISH,
  SENSITIVE,
]);
