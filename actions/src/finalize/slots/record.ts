// The record's named slots (pay.*, clock.pay, two.count, reach.*, who.ok): each is a list of rows in the bundle's
// record, and the first row whose `when` fits the booking's path and record values gives the slot's words (K-01
// record.slots and slotRow; K-03 slots.json "reads"; overlay-core.js slotRow line 766 and litOn line 440).
//
// The reading is the path as the message's step reads it: the money choices (after the money step, what the booking
// took), the booking values by group, the trade's switches and facts, and the record values the booking holds (credit,
// card, paid, keep ...). The caller reads the step's stamps (took, ev, wr) into it, so they are not read again here.

import type { RecordSlotName } from "./vocabulary";

/** The price choice of the money path (K-01 `price`). */
export const PRICE_CHOICES = ["list", "photos", "visit"] as const;
/** What is taken before the visit; no hold (K-01 `before`; D66 #3). */
export const BEFORE_CHOICES = ["none", "card", "deposit", "full"] as const;
/** What is paid after (K-01 `after`). */
export const AFTER_CHOICES = ["none", "counter", "bill", "card", "own"] as const;

/**
 * The booking values by group, each group's first value its default (K-01 `bookingValues`; overlay-core.js BOOKING
 * lines 225 to 244 and EVENT_GROUPS lines 320 to 325: "a group left out has its first value"). Only live values: the
 * record's live.off cuts reach notsafe, times noperson and line, and approval expert.
 */
export const BOOKING_GROUPS = {
  timing: ["settime", "sentnow"],
  times: ["window", "setstart", "stay", "seat"],
  reach: ["texts", "callsonly", "textsonly", "email"],
  paidby: ["money", "credit"],
  privacy: ["open", "private"],
  taken: ["asked", "nothing"],
  approval: ["now", "ownerok"],
  madeby: ["customer", "shop"],
  charge: ["none", "later", "failed"],
  contact: ["kept", "switched", "stopped"],
  payer: ["self", "other"],
} as const;

/** The record values a booking may hold (overlay-core.js REC line 595; K-01 gate `rec`). */
export const RECORD_VALUES = [
  "nothing",
  "card",
  "paid",
  "full",
  "rest",
  "credit",
  "several",
  "keep",
  "written",
] as const;

export type PriceChoice = (typeof PRICE_CHOICES)[number];
export type BeforeChoice = (typeof BEFORE_CHOICES)[number];
export type AfterChoice = (typeof AFTER_CHOICES)[number];
export type BookingGroup = keyof typeof BOOKING_GROUPS;
export type BookingValues = { readonly [G in BookingGroup]: (typeof BOOKING_GROUPS)[G][number] };
export type RecordValue = (typeof RECORD_VALUES)[number];

/**
 * One row of a named record slot, as the bundle holds it (K-01 `slotRow`). Its `when` is read here key by key, so a
 * row read from a bundle's JSON is accepted as it is and checked as it is read.
 */
export interface SlotRow {
  readonly when?: Readonly<Record<string, unknown>> | undefined;
  readonly text: string;
}

/** The path and record values a message's record slots are read on. */
export interface RecordReading {
  readonly price: PriceChoice;
  readonly before: BeforeChoice;
  readonly after: AfterChoice;
  /** The booking values; a group left out reads its first value. */
  readonly booking: Partial<BookingValues>;
  /** The trade's switches that are on (K-01 gate switchOn, switchOff; SPEC-master 5b). */
  readonly switches: readonly string[];
  /** The trade's facts, or null when it lists none (then every fact gate shows; SPEC-master 5d). */
  readonly facts: readonly string[] | null;
  /** The record values the booking holds. */
  readonly values: readonly RecordValue[];
  /** Each named slot's rows, first fit wins: the bundle's record.slots rows, a trade's own rows laid first. */
  readonly rows: Readonly<Partial<Record<RecordSlotName, readonly SlotRow[]>>>;
}

/** The row a slot reads, or why none can be read. */
export type RowPick =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly why: string };

const GROUP_OF = new Map<string, BookingGroup>();
for (const group of Object.keys(BOOKING_GROUPS) as BookingGroup[]) {
  for (const value of BOOKING_GROUPS[group]) GROUP_OF.set(value, group);
}

/** The value a booking group reads: the one given, else the group's first (overlay-core.js line 8). */
export function bookingValue(reading: RecordReading, group: BookingGroup): string {
  return reading.booking[group] ?? BOOKING_GROUPS[group][0];
}

const STAMPS = new Set(["took", "ev", "wr"]);

function stringList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const items: readonly unknown[] = value;
  return items.every((item) => typeof item === "string") ? items : null;
}

/**
 * Booking values listed: every group named must hold one of the values listed for it; a value no group has never
 * holds (overlay-core.js bookingFits line 423).
 */
function bookingFits(listed: readonly string[], reading: RecordReading): boolean {
  const byGroup = new Map<BookingGroup, string[]>();
  for (const value of listed) {
    const group = GROUP_OF.get(value);
    if (group === undefined) return false;
    byGroup.set(group, [...(byGroup.get(group) ?? []), value]);
  }
  for (const [group, values] of byGroup) {
    if (!values.includes(bookingValue(reading, group))) return false;
  }
  return true;
}

/** Does a row's `when` fit the reading? null when a key cannot be read (a bundle the filler cannot trust). */
function fits(when: Readonly<Record<string, unknown>>, reading: RecordReading): boolean | null {
  const facts = reading.facts;
  const switches = reading.switches;
  const held: readonly string[] = reading.values;
  for (const [key, raw] of Object.entries(when)) {
    if (STAMPS.has(key)) continue;
    const list = stringList(raw);
    if (list === null) return null;
    let lit: boolean;
    switch (key) {
      case "price":
        lit = list.includes(reading.price);
        break;
      case "before":
        lit = list.includes(reading.before);
        break;
      case "after":
        lit = list.includes(reading.after);
        break;
      case "booking":
        lit = bookingFits(list, reading);
        break;
      case "pf":
      case "factOn":
        lit = facts === null || list.some((fact) => facts.includes(fact));
        break;
      case "factOff":
        lit = facts === null || !list.some((fact) => facts.includes(fact));
        break;
      case "switchOn":
        lit = list.some((name) => switches.includes(name));
        break;
      case "switchOff":
        lit = !list.some((name) => switches.includes(name));
        break;
      case "rec":
        lit = list.some((value) => held.includes(value));
        break;
      case "recOff":
        lit = !list.some((value) => held.includes(value));
        break;
      default:
        return null;
    }
    if (!lit) return false;
  }
  return true;
}

function isOneOf(list: readonly string[], value: unknown): boolean {
  return typeof value === "string" && list.includes(value);
}

/** What is wrong with a reading, or null when every choice, booking value and record value is one K-01 knows. */
export function readingProblem(reading: RecordReading): string | null {
  if (!isOneOf(PRICE_CHOICES, reading.price)) return "the path's price choice is not one K-01 knows";
  if (!isOneOf(BEFORE_CHOICES, reading.before)) return "the path's before choice is not one K-01 knows";
  if (!isOneOf(AFTER_CHOICES, reading.after)) return "the path's after choice is not one K-01 knows";
  const groups: Readonly<Record<string, readonly string[]>> = BOOKING_GROUPS;
  for (const [group, value] of Object.entries(reading.booking)) {
    const values = groups[group];
    if (values === undefined) return `the booking group ${group} is not one K-01 knows`;
    if (!isOneOf(values, value)) return `the booking value of ${group} is not one K-01 knows`;
  }
  for (const value of reading.values) {
    if (!isOneOf(RECORD_VALUES, value)) return "a record value is not one K-01 knows";
  }
  return null;
}

/** The first row of a named slot whose `when` fits the reading (overlay-core.js slotRow line 766). */
export function pickRow(reading: RecordReading, slot: RecordSlotName): RowPick {
  const problem = readingProblem(reading);
  if (problem !== null) return { ok: false, why: problem };
  const rows = reading.rows[slot];
  if (rows === undefined || rows.length === 0)
    return { ok: false, why: `the bundle's record has no rows for ${slot}` };
  for (const [index, row] of rows.entries()) {
    const text: unknown = row.text;
    const at = `row ${String(index + 1)} of ${slot}`;
    if (typeof text !== "string") return { ok: false, why: `${at} has no words` };
    if (row.when === undefined) return { ok: true, text };
    const lit = fits(row.when, reading);
    if (lit === null) return { ok: false, why: `${at} has a when the filler cannot read` };
    if (lit) return { ok: true, text };
  }
  return { ok: false, why: `no row of ${slot} fits this booking's path and record values` };
}
