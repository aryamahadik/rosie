// The money slots' lines for a booking (T-593; C-088; S13-55; K-01 v1 record.slots; K-03 v1 slots.json "reads").
//
// Each money slot (pay.asks, pay.price, pay.took ... the named slots whose home is the money home's step) holds rows in
// first-fit order: the first row whose `when` fits the booking's path and record values gives the slot's words. Which
// row fits is decided by the slot filler's own row reader (T-310 pickRow, overlay-core.js slotRow line 766), run on the
// reading this home computes from what the booking took; it is never written down a second time here. The money home
// then refuses a row whose words claim what the booking did not take ("refuses any money line the booking did not take";
// S13-55: "After the money step, messages speak only of what it took"): such a slot is left without words, so a message
// that needs it fails the slot filler and the message checks, and is never sent saying what did not happen.

import { pickRow, type RecordReading } from "../../finalize/slots/record";
import type { RecordSlotName } from "../../finalize/slots/vocabulary";
import { checkMoneyLine, type ClaimRefusal, type MoneyClaim } from "./claims";
import { readMoney, type MoneyBooking, type MoneyReading } from "./money";
import type { MoneyRecord } from "./record";

/** A money slot's line: the row the booking's reading fits, its words as the record holds them (nested slots unfilled). */
export interface MoneyLine {
  readonly slot: RecordSlotName;
  readonly ok: true;
  /** The row's place in the slot's rows, from 0 (first fit). */
  readonly row: number;
  readonly text: string;
  readonly claims: readonly MoneyClaim[];
}

/** A money slot left without words: its first-fit row claims what the booking did not take, or no row can be read. */
export interface RefusedMoneyLine {
  readonly slot: RecordSlotName;
  readonly ok: false;
  /** The first-fit row refused, or null when no row fits or a row cannot be read. */
  readonly row: number | null;
  readonly refused: readonly ClaimRefusal[];
  /** "claims": the row's words claim what the booking did not take; "noRow": no row of the slot can be read for it. */
  readonly why: "claims" | "noRow";
}

export type MoneySlotLine = MoneyLine | RefusedMoneyLine;

/** The reading the slot filler reads a record slot's rows on (T-310 RecordReading), from the money home's reading. */
export function recordReading(money: MoneyReading, record: MoneyRecord): RecordReading {
  return {
    price: money.path.price,
    before: money.path.before,
    after: money.path.after,
    booking: money.booking,
    switches: money.switches,
    facts: money.facts,
    values: money.values,
    rows: record.rows,
  };
}

/**
 * The first row of a slot that fits the reading, by the slot filler's own reader: the shortest run of the slot's rows
 * that the reader finds a row in ends at it. Null when the reader finds none, or cannot read a row before one fits.
 */
export function firstFit(reading: RecordReading, slot: RecordSlotName): number | null {
  const rows = reading.rows[slot] ?? [];
  if (!pickRow(reading, slot).ok) return null;
  for (let end = 1; end <= rows.length; end += 1) {
    if (pickRow({ ...reading, rows: { ...reading.rows, [slot]: rows.slice(0, end) } }, slot).ok)
      return end - 1;
  }
  return null;
}

/** One money slot's line for the booking, or its refusal. */
export function moneyLine(money: MoneyReading, record: MoneyRecord, slot: RecordSlotName): MoneySlotLine {
  const reading = recordReading(money, record);
  const row = firstFit(reading, slot);
  const text = row === null ? undefined : record.rows[slot]?.[row]?.text;
  if (row === null || text === undefined) return { slot, ok: false, row: null, refused: [], why: "noRow" };
  const check = checkMoneyLine(text, money);
  if (!check.ok) return { slot, ok: false, row, refused: check.refused, why: "claims" };
  return { slot, ok: true, row, text, claims: check.claims };
}

/** Every money slot's line for a booking, in K-03 order (the slot filler fills their nested amounts from the ledger). */
export function moneyLines(money: MoneyReading, record: MoneyRecord): readonly MoneySlotLine[] {
  return record.moneySlots.map((slot) => moneyLine(money, record, slot));
}

/** Reads a booking and gives its money slots' lines: what the slot filler asks of the money home. */
export function linesForBooking(booking: MoneyBooking, record: MoneyRecord): readonly MoneySlotLine[] {
  return moneyLines(readMoney(booking, record), record);
}
