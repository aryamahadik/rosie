// The money home's part of the booking record (T-593; C-101, C-088; S13-55).
//
// The record engine (T-137, K-01 v1 `record`) compiles one record per flow: the ten homes, the 16 named slots with their
// rows, the money ways, one fee per booking and the ledger rules. The money home reads its part of it: its step
// (record.homes.money, S13-55), the named slots whose home is that step (the pay.* slots), the ways by before choice
// (none, card, deposit, full) and credit, and onefee. Nothing here is written down a second time: the ways, rows and
// home are read from the bundle's record. What is refused, each problem named with labels only:
//   - a record that is not one fee per booking (onefee not true: one late-cancel and no-show fee per booking, S13-55);
//   - a way or a row that holds a card (D66; S13-55 "Nothing is ever held on a card"; MC: never a card hold);
//   - a way missing, or a way whose fields are not K-01's (now, card, fee, back);
//   - no money home step, or no named slot whose home it is.

import { isLabel } from "../../../../runtime/src/trace";
import type { SlotRow } from "../../finalize/slots/record";
import { RECORD_SLOT_NAMES, type RecordSlotName } from "../../finalize/slots/vocabulary";

export type FlowLetter = "A" | "B";

/** The four ways a service asks money before the visit (S13-55: nothing, a card saved, a deposit or the full price). */
export const FOUR_WAYS = ["none", "card", "deposit", "full"] as const;
export type FourWay = (typeof FOUR_WAYS)[number];

/** The way a service paid by a pack credit reads (K-01 record.ways.credit; S13-55 "A pack credit covers its own service"). */
export const CREDIT_WAY = "credit";

/** One money way as K-01 record.ways.<way> writes it: what is paid now, whether a card is saved, the fee, what goes back. */
export interface MoneyWay {
  /** An amount of the service ("deposit", "paid"), "0", or "credit". */
  readonly now: string;
  /** Whether a card is saved; "asis" keeps the card the service's own way saves (the credit way). */
  readonly card: boolean | "asis";
  /** The fee the way may keep: an amount ("fee"), a chain whose first known amount counts ("fee|deposit"), "0" or "credit". */
  readonly fee: string;
  /** What goes back on a cancel in time: an amount, "0" or "credit". */
  readonly back: string;
}

/** The money home's part of one flow's record. */
export interface MoneyRecord {
  readonly flow: FlowLetter;
  /** The money home's step (record.homes.money; S13-55). */
  readonly home: string;
  /** The money ways by name: the four ways and credit (record.ways). */
  readonly ways: Readonly<Record<string, MoneyWay>>;
  /** The money slots: the named slots whose home is the money home's step, in K-03 order. */
  readonly moneySlots: readonly RecordSlotName[];
  /** Every named slot's rows, first fit wins (record.slots.<slot>.rows), as the slot filler reads them. */
  readonly rows: Readonly<Partial<Record<RecordSlotName, readonly SlotRow[]>>>;
}

/** The money home cannot read this record or this booking. Its message and problems hold labels only, never an amount or words. */
export class MoneyHomeError extends Error {
  readonly problems: readonly string[];

  constructor(message: string, problems: readonly string[] = []) {
    super(problems.length === 0 ? message : `${message}: ${problems.join("; ")}`);
    this.name = "MoneyHomeError";
    this.problems = problems;
  }
}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `{{hold}}`, `{{hold:$40}}` or `{{hold|words}}`: a card hold slot (D66; T-137's HOLD_SLOT reads the same three). */
export const HOLD_SLOT = /\{\{\s*hold\s*(?:[:|}])/;

const WAY_FIELDS = ["now", "card", "fee", "back"];

function readWay(name: string, raw: unknown, problems: string[]): MoneyWay | null {
  if (!isObj(raw)) {
    problems.push(`way ${name} is not a way`);
    return null;
  }
  for (const key of Object.keys(raw))
    if (!WAY_FIELDS.includes(key)) problems.push(`way ${name} has a field ${key} that K-01 does not name`);
  const { now, card, fee, back } = raw;
  if (typeof now !== "string" || typeof fee !== "string" || typeof back !== "string") {
    problems.push(`way ${name}: now, fee and back are not each a field name`);
    return null;
  }
  if (typeof card !== "boolean" && card !== "asis") {
    problems.push(`way ${name}: card is not true, false or asis`);
    return null;
  }
  return { now, card, fee, back };
}

function readRows(slot: RecordSlotName, raw: unknown, problems: string[]): readonly SlotRow[] {
  const rows: unknown = isObj(raw) ? raw.rows : undefined;
  if (!Array.isArray(rows) || rows.length === 0) {
    problems.push(`slot ${slot} has no rows`);
    return [];
  }
  const list: readonly unknown[] = rows;
  const out: SlotRow[] = [];
  for (const [index, row] of list.entries()) {
    const at = `slot ${slot} row ${String(index + 1)}`;
    if (!isObj(row) || typeof row.text !== "string") {
      problems.push(`${at} has no words`);
      continue;
    }
    if (HOLD_SLOT.test(row.text)) problems.push(`${at} holds a card hold slot (D66: nothing is held)`);
    const when = row.when;
    if (when !== undefined && !isObj(when)) {
      problems.push(`${at} has a when that is not a table`);
      continue;
    }
    out.push(when === undefined ? { text: row.text } : { when, text: row.text });
  }
  return out;
}

/**
 * Reads the money home's part of one flow's compiled record (K-01 v1 `record`, a bundle's flows.<flow>.record). Throws
 * MoneyHomeError, naming every problem, when the record is not one the money home can rule by.
 */
export function readMoneyRecord(flow: FlowLetter, record: unknown): MoneyRecord {
  const problems: string[] = [];
  if (!isObj(record)) throw new MoneyHomeError(`flow ${flow}'s record is not a record`);
  if (record.onefee !== true)
    problems.push("onefee is not true: the record does not hold one fee per booking (S13-55)");

  const homes = isObj(record.homes) ? record.homes : {};
  const home = homes.money;
  if (!isLabel(home)) problems.push("record.homes has no money home step");

  const ways: Record<string, MoneyWay> = {};
  if (isObj(record.ways)) {
    for (const [name, raw] of Object.entries(record.ways)) {
      if (name === "hold") {
        problems.push("way hold is refused (D66: nothing is held on a card)");
        continue;
      }
      const way = readWay(name, raw, problems);
      if (way !== null) ways[name] = way;
    }
  } else problems.push("record.ways is not a table of ways");
  for (const name of [...FOUR_WAYS, CREDIT_WAY])
    if (!(name in ways) && isObj(record.ways) && !(name in record.ways))
      problems.push(`way ${name} is missing`);

  const rows: Partial<Record<RecordSlotName, readonly SlotRow[]>> = {};
  const moneySlots: RecordSlotName[] = [];
  const slots = isObj(record.slots) ? record.slots : null;
  if (slots === null) problems.push("record.slots is not a table of named slots");
  else
    for (const slot of RECORD_SLOT_NAMES) {
      const raw = slots[slot];
      if (raw === undefined) {
        problems.push(`slot ${slot} is missing`);
        continue;
      }
      rows[slot] = readRows(slot, raw, problems);
      if (isObj(raw) && raw.home === home) moneySlots.push(slot);
    }
  if (isLabel(home) && slots !== null && moneySlots.length === 0)
    problems.push(`no named slot has the money home ${home} as its home`);

  if (problems.length > 0 || !isLabel(home))
    throw new MoneyHomeError(`flow ${flow}'s record cannot be read by the money home`, problems);
  return { flow, home, ways, moneySlots, rows };
}
