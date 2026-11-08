// One filler per slot of K-03 v1's vocabulary (C-088). Each reads the record or a code fact in its value type and
// gives the words a person reads, in the slot's sensitive form when the sensitive switch is on (slots.json
// `sensitiveForm`; RULES 4.6; S13-22; D41). A slot whose fact is missing, or held in the wrong form, is left unfilled:
// the plan fails and the Values check stops the message (arch 07 line 409; arch 02 line 123).
//
// Example words in a slot are illustrations the filler replaces, never a value (K-03 `slottedText`; MC C6): only
// {{keep:words}} reads its own words (renames never change them, E12, E17), and the words after '|' only stand in for
// a service under the sensitive switch ({{svc.intext:Skin fade|visit}} says "visit"; D41). Those own words are written
// by the plan, not supplied by code: they never carry a digit (a number is always a value, rule 4) and never join the
// slot values the Values check reads.

import {
  TimeFormatError,
  clockLabel,
  dayAndRangeLabel,
  dayLabel,
  rangeLabel,
  shortClock,
  weekdayLabel,
} from "./clock";
import { MoneyFormatError, formatMoney } from "./money";
import { bookingValue, pickRow } from "./record";
import type { SlotRef } from "./syntax";
import type { Money, SlotSource, Time, TimeRange } from "./types";
import type {
  FilledBy,
  RecordSlotName,
  SendSlotName,
  SensitiveForm,
  SlotName,
  ValueType,
} from "./vocabulary";

/** A send slot bound to the calendar day it stands for (YYYY-MM-DD in the reader's zone). */
export interface Binding {
  readonly slot: SendSlotName;
  readonly day: string;
}

/** What one filler gives for one slot. */
export type Outcome =
  /** The words, with any send slots bound inside them (a record row that names today or tomorrow). */
  | { readonly kind: "value"; readonly value: string; readonly bound: readonly Binding[] }
  /** The slot's own words, written in the plan, not a value: shown, never listed as a slot value. */
  | { readonly kind: "own"; readonly text: string }
  /** Nothing, under the sensitive switch: one separator next to the slot goes too (SPEC-master 5h). */
  | { readonly kind: "empty" }
  /** Left as a send slot, bound to its day, for the send to word (arch 07 line 409). */
  | { readonly kind: "send"; readonly slot: SendSlotName; readonly day: string }
  /** No value: the slot stays as written. `why` says what was wrong with the fact, null when there was none. */
  | { readonly kind: "missing"; readonly why: string | null };

/** A record row's words with their own slots filled, one level down. */
export interface NestedFill {
  readonly text: string;
  /** The slots inside the row that could not be filled. */
  readonly missing: readonly string[];
  readonly bound: readonly Binding[];
}

/** A day read in the reader's zone, or why it cannot be. */
export type DayRead =
  { readonly ok: true; readonly day: string } | { readonly ok: false; readonly why: string };

/** What a filler may read besides its slot. */
export interface FillContext {
  readonly source: SlotSource;
  /** The day 'today' or 'tomorrow' stands for when filled now: the fill day in the reader's zone, or the next. */
  sendDay(slot: SendSlotName): DayRead;
  /** The calendar day of an instant in the reader's zone. */
  dayOf(utc: string): DayRead;
  /** A record row's words with their own slots filled. */
  nested(text: string): NestedFill;
}

export interface SlotFiller {
  /** Who fills it, as slots.json says: the slot filler, or the send (today, tomorrow). */
  readonly filledBy: FilledBy;
  readonly valueType: ValueType;
  readonly sensitiveForm: SensitiveForm;
  fill(ref: SlotRef, ctx: FillContext): Outcome;
}

const NO_BINDINGS: readonly Binding[] = [];

function value(words: string, bound: readonly Binding[] = NO_BINDINGS): Outcome {
  return { kind: "value", value: words, bound };
}

function missing(why: string | null = null): Outcome {
  return { kind: "missing", why };
}

const DIGIT = /[0-9]/;

/** A slot's own words, written in the plan: shown as they are, unless they carry a number (rule 4). */
function own(text: string): Outcome {
  return DIGIT.test(text)
    ? missing("a slot's own words carry no number: every number is a value code fills (rule 4)")
    : { kind: "own", text };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Words from a fact: present and not blank, trimmed. */
function words(fact: string | undefined, what: string): Outcome {
  if (fact === undefined) return missing();
  const text: unknown = fact;
  if (typeof text !== "string" || text.trim() === "") return missing(`${what} is blank`);
  return value(text.trim());
}

function money(amount: Money | undefined): Outcome {
  if (amount === undefined) return missing();
  try {
    return value(formatMoney(amount));
  } catch (error) {
    if (error instanceof MoneyFormatError) return missing(error.message);
    throw error;
  }
}

function shown<T>(fact: T | undefined, show: (fact: T) => string): Outcome {
  if (fact === undefined) return missing();
  if (!isRecord(fact)) return missing("a time must be { utc, zone } (CQ-09)");
  try {
    return value(show(fact));
  } catch (error) {
    if (error instanceof TimeFormatError) return missing(error.message);
    throw error;
  }
}

const LINK = /^\S+$/;

function link(fact: string | undefined): Outcome {
  if (fact === undefined) return missing();
  const text: unknown = fact;
  if (typeof text !== "string" || !LINK.test(text)) return missing("a link is one word with no spaces");
  return value(text);
}

const E164 = /^\+[1-9][0-9]{6,14}$/;
const NANP = /^\+1([2-9][0-9]{2})([0-9]{3})([0-9]{4})$/;

/** A phone in E.164: +15555550177 reads (555) 555-0177; a number outside +1 stays as stored. */
function phone(fact: string | undefined): Outcome {
  if (fact === undefined) return missing();
  const text: unknown = fact;
  if (typeof text !== "string" || !E164.test(text))
    return missing("a phone number must be E.164, such as +15555550177");
  const nanp = NANP.exec(text);
  if (nanp === null) return value(text);
  const [, area = "", exchange = "", line = ""] = nanp;
  return value(`(${area}) ${exchange}-${line}`);
}

/** Initials: "Alex M." reads "A.M." (D41; overlay-core.js initials line 1356). */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => /\p{L}/u.exec(part)?.[0])
    .filter((letter): letter is string => letter !== undefined)
    .map((letter) => `${letter.toUpperCase()}.`)
    .join("");
}

/** A person's name, as initials under the sensitive switch when its form says so. */
function personName(fact: string | undefined, form: SensitiveForm, ctx: FillContext): Outcome {
  const name = words(fact, "the name");
  if (name.kind !== "value" || form !== "initials" || !ctx.source.sensitive) return name;
  const short = initials(name.value);
  return short === "" ? missing("the name has no letter to make initials from") : value(short);
}

/** The service under the sensitive switch: the words after '|', else nothing (one separator next to it goes too). */
function emptyOrAlternate(ref: SlotRef, fact: string | undefined, ctx: FillContext): Outcome {
  if (!ctx.source.sensitive) return words(fact, "the service name");
  const alternate = ref.other?.split("|")[0]?.trim() ?? "";
  return alternate === "" ? { kind: "empty" } : own(alternate);
}

function sentNow(ctx: FillContext): boolean {
  const reading = ctx.source.record;
  return reading !== null && bookingValue(reading, "timing") === "sentnow";
}

function setStart(ctx: FillContext): boolean {
  const reading = ctx.source.record;
  return reading !== null && bookingValue(reading, "times") === "setstart";
}

/** The master's words for a time slot on a sent-now booking (overlay-core.js TIMED_WORDS line 1360; SPEC-master 5h). */
const SENT_NOW = {
  window: "in about 60 to 90 minutes",
  arrive: "arriving in about 60 to 90 minutes",
  cutoff: "the pro is on the way",
} as const;

function cutoffLabel(time: Time): string {
  return `${weekdayLabel(time)} ${shortClock(time)}`;
}

function deadlineLabel(time: Time): string {
  return `${clockLabel(time)} ${weekdayLabel(time)}`;
}

function windowFill(ctx: FillContext, verb: boolean): Outcome {
  if (sentNow(ctx)) return value(verb ? SENT_NOW.arrive : SENT_NOW.window);
  const visit = ctx.source.facts.visit;
  if (setStart(ctx))
    return shown(visit?.arrival?.start ?? visit?.start, (start: Time) =>
      verb ? `starts at ${clockLabel(start)}` : clockLabel(start),
    );
  return shown(visit?.arrival, (arrival: TimeRange) => {
    const range = rangeLabel(arrival.start, arrival.end);
    return verb ? `arriving ${range}` : range;
  });
}

/** The visit's day; on a sent-now booking 'today' (or 'tomorrow' past midnight), worded at send (SPEC-master 5h). */
function dayFill(ctx: FillContext): Outcome {
  const start = ctx.source.facts.visit?.start;
  if (start === undefined || !sentNow(ctx)) return shown(start, dayLabel);
  const visitDay = ctx.dayOf(start.utc);
  if (!visitDay.ok) return missing(visitDay.why);
  for (const slot of ["today", "tomorrow"] as const) {
    const bound = ctx.sendDay(slot);
    if (!bound.ok) return missing(bound.why);
    if (bound.day === visitDay.day) return { kind: "send", slot, day: bound.day };
  }
  return shown(start, dayLabel);
}

function sendFill(slot: SendSlotName, ctx: FillContext): Outcome {
  const bound = ctx.sendDay(slot);
  return bound.ok ? { kind: "send", slot, day: bound.day } : missing(bound.why);
}

/** A record slot: the first row whose `when` fits, its own slots filled (K-01 record.slots; overlay-core.js line 766). */
function recordFiller(slot: RecordSlotName, valueType: ValueType): SlotFiller {
  return {
    filledBy: "slotFiller",
    valueType,
    sensitiveForm: "asIs",
    fill(_ref, ctx) {
      const reading = ctx.source.record;
      if (reading === null) return missing("no booking record is read for this message");
      const row = pickRow(reading, slot);
      if (!row.ok) return missing(row.why);
      const nested = ctx.nested(row.text);
      if (nested.missing.length > 0)
        return missing(
          `its row needs ${nested.missing.map((name) => `{{${name}}}`).join(", ")}, with no value`,
        );
      return value(nested.text, nested.bound);
    },
  };
}

function filler(
  valueType: ValueType,
  sensitiveForm: SensitiveForm,
  fill: (ref: SlotRef, ctx: FillContext) => Outcome,
): SlotFiller {
  return { filledBy: "slotFiller", valueType, sensitiveForm, fill };
}

/** Every slot of K-03 v1 and its filler. The type asks for one per slot name; the tests check slots.json against it. */
export const FILLERS: Readonly<Record<SlotName, SlotFiller>> = {
  // The record's 16 named slots (master-A.json and master-B.json record.slots).
  "pay.asks": recordFiller("pay.asks", "phrase"),
  "pay.price": recordFiller("pay.price", "phrase"),
  "pay.took": recordFiller("pay.took", "phrase"),
  "pay.left": recordFiller("pay.left", "phrase"),
  "pay.cancel": recordFiller("pay.cancel", "phrase"),
  "pay.late": recordFiller("pay.late", "phrase"),
  "pay.noshow": recordFiller("pay.noshow", "phrase"),
  "pay.back": recordFiller("pay.back", "phrase"),
  "pay.after": recordFiller("pay.after", "phrase"),
  "pay.staff": recordFiller("pay.staff", "phrase"),
  "pay.failed": recordFiller("pay.failed", "phrase"),
  "clock.pay": recordFiller("clock.pay", "deadline"),
  "two.count": recordFiller("two.count", "phrase"),
  "reach.way": recordFiller("reach.way", "phrase"),
  "reach.to": recordFiller("reach.to", "phrase"),
  "who.ok": recordFiller("who.ok", "phrase"),

  // The auto-fill slots (SPEC-master 5h; overlay-core.js SLOTS line 1285).
  "alex.staff": filler("personName", "initials", (_ref, ctx) =>
    personName(ctx.source.facts.customerName, "initials", ctx),
  ),
  "name.staff": filler("personName", "initials", (_ref, ctx) =>
    personName(ctx.source.facts.otherName, "initials", ctx),
  ),
  "svc.intext": filler("words", "emptyOrAlternate", (ref, ctx) =>
    emptyOrAlternate(ref, ctx.source.facts.serviceName, ctx),
  ),
  arrive: filler("timeRange", "asIs", (_ref, ctx) => windowFill(ctx, true)),
  window: filler("timeRange", "asIs", (_ref, ctx) => windowFill(ctx, false)),
  cutoff: filler("deadline", "asIs", (_ref, ctx) =>
    sentNow(ctx) ? value(SENT_NOW.cutoff) : shown(ctx.source.facts.visit?.cutoff, cutoffLabel),
  ),
  day: filler("date", "asIs", (_ref, ctx) => dayFill(ctx)),
  keep: filler("words", "asIs", (ref, ctx) => {
    const kept = ref.example?.trim() ?? "";
    return kept === "" ? money(ctx.source.facts.ledger?.keep) : own(kept);
  }),

  // The amounts on the booking's money path (SPEC-master 5h; overlay-core.js AMOUNTS line 981).
  price: filler("money", "asIs", (_ref, ctx) => money(ctx.source.facts.amounts?.price)),
  fee: filler("money", "asIs", (_ref, ctx) => money(ctx.source.facts.amounts?.fee)),
  deposit: filler("money", "asIs", (_ref, ctx) => money(ctx.source.facts.amounts?.deposit)),
  rest: filler("money", "asIs", (_ref, ctx) => money(ctx.source.facts.amounts?.rest)),
  paid: filler("money", "asIs", (_ref, ctx) => money(ctx.source.facts.amounts?.paid)),
  name: filler("words", "emptyOrAlternate", (ref, ctx) =>
    emptyOrAlternate(ref, ctx.source.facts.serviceName, ctx),
  ),

  // The ledger amounts (overlay-core.js LEDGER_AMOUNTS line 597).
  paidnow: filler("money", "asIs", (_ref, ctx) => money(ctx.source.facts.ledger?.paidnow)),
  due: filler("money", "asIs", (_ref, ctx) => money(ctx.source.facts.ledger?.due)),
  back: filler("money", "asIs", (_ref, ctx) => money(ctx.source.facts.ledger?.back)),
  later: filler("money", "asIs", (_ref, ctx) => money(ctx.source.facts.ledger?.later)),
  backlate: filler("money", "asIs", (_ref, ctx) => money(ctx.source.facts.ledger?.backlate)),

  // Filled at send in the reader's zone (arch 07 line 409): bound here to the day each stands for.
  today: {
    filledBy: "send",
    valueType: "date",
    sensitiveForm: "asIs",
    fill: (_ref, ctx) => sendFill("today", ctx),
  },
  tomorrow: {
    filledBy: "send",
    valueType: "date",
    sensitiveForm: "asIs",
    fill: (_ref, ctx) => sendFill("tomorrow", ctx),
  },

  // The links (CQ-17's proposed names).
  "link.secure": filler("link", "asIs", (_ref, ctx) => link(ctx.source.facts.links?.secure)),
  "link.pay": filler("link", "asIs", (_ref, ctx) => link(ctx.source.facts.links?.pay)),
  "link.chat": filler("link", "asIs", (_ref, ctx) => link(ctx.source.facts.links?.chat)),
  // The chat link's QR code goes only where a screen shows it, a page or an email, never a text (MC C9).
  "link.chatqr": filler("link", "asIs", (_ref, ctx) =>
    ctx.source.channel === "email"
      ? link(ctx.source.facts.links?.chat)
      : missing("a QR code shows only on a page or in an email, never in a text"),
  ),

  // The slots the compiler makes from the sample cast's values (arch 12 line 592; CQ-17's proposed names).
  "biz.name": filler("businessName", "displayName", (_ref, ctx) => {
    const business = ctx.source.facts.business;
    if (business === undefined) return missing();
    return ctx.source.sensitive
      ? words(business.displayName, "the display name")
      : words(business.name, "the business name");
  }),
  "biz.phone": filler("phone", "asIs", (_ref, ctx) => phone(ctx.source.facts.business?.phone)),
  "owner.name": filler("personName", "asIs", (_ref, ctx) =>
    personName(ctx.source.facts.business?.ownerName, "asIs", ctx),
  ),
  "pro.name": filler("personName", "asIs", (_ref, ctx) => personName(ctx.source.facts.proName, "asIs", ctx)),
  "visit.time": filler("time", "asIs", (_ref, ctx) => shown(ctx.source.facts.visit?.start, clockLabel)),
  "visit.place": filler("place", "asIs", (_ref, ctx) => words(ctx.source.facts.visit?.place, "the place")),
  "visit.code": filler("code", "asIs", (_ref, ctx) =>
    words(ctx.source.facts.visit?.code, "the check-in code"),
  ),
  "ask.by": filler("deadline", "asIs", (_ref, ctx) => shown(ctx.source.facts.askBy, deadlineLabel)),
  "change.when": filler("timeRange", "asIs", (_ref, ctx) =>
    shown(ctx.source.facts.change?.when, (when: { readonly start: Time; readonly end: Time | null }) =>
      dayAndRangeLabel(when.start, when.end),
    ),
  ),
  "change.price": filler("money", "asIs", (_ref, ctx) => money(ctx.source.facts.change?.price)),
  "relay.quote": filler("words", "asIs", (_ref, ctx) => words(ctx.source.facts.relayQuote, "the quote")),
};
