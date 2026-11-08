// What a booking took, read by the money home (T-593; C-101, C-088; S13-55; K-01 v1 record.ways, onefee, ledger_rules).
//
// S13-55: "Money before is one of four ways per service: nothing, a card saved, a deposit or the full price. Nothing is
// ever held on a card. Several services in one booking: all that's due now is added up and taken in one payment, on one
// card. ... One late-cancel and no-show fee per booking, set by the business. When the services' fees differ, the largest
// counts. A deposit service with no fee of its own: its deposit is the fee. The fee comes out of what was paid now, never
// more than what was paid now, and the rest goes back." The ledger rules say it once more (record.ledger_rules): "keep:
// the booking's one fee (the largest service fee), counted only when a card is saved or money was paid now, and never
// more than what was paid now when money was paid now. A service paid by a pack credit adds nothing to due or paidnow."
//
// Each service's way is read from the record's ways table (record.ways.<way>: now, card, fee, back), never written here.
// The reading is the master's booking record (overlay-core.js recordOf, line 669, and tookPath, line 582, which the
// record's rows were written against): what the services ask before the money step, what the booking took from it on
// (`took`), nothing counted between the money step and the write (`written` false), a failed charge taking nothing, a
// service added after booking (D91) taking nothing now, a pack credit adding nothing to what is due or paid now.
//
// Amounts are whole cents in the booking's currency (formats.v1 `money`; CQ-09). An amount a way names that the service
// does not carry is not known (null), never guessed: the slot filler leaves a slot that reads it unfilled. Charges and
// the ledger themselves are C-101's domain service (M5); this reading only says what a booking took.

import { isLabel } from "../../../../runtime/src/trace";
import type {
  AfterChoice,
  BeforeChoice,
  BookingValues,
  PriceChoice,
  RecordValue,
} from "../../finalize/slots/record";
import type { Money } from "../../finalize/slots/types";
import {
  CREDIT_WAY,
  MoneyHomeError,
  type FlowLetter,
  type FourWay,
  type MoneyRecord,
  type MoneyWay,
} from "./record";

/** The amounts a service carries (the flow's amount table for its money path, its own amounts laid over), whole cents. */
export interface ServiceAmounts {
  readonly price?: Money;
  readonly deposit?: Money;
  readonly paid?: Money;
  readonly fee?: Money;
  readonly rest?: Money;
}

/** The amount names a way's fields may name (K-01 record.ways: "deposit", "paid", "fee", "fee|deposit" ...). */
const AMOUNT_NAMES = ["price", "deposit", "paid", "fee", "rest"] as const;
type AmountName = (typeof AMOUNT_NAMES)[number];
type Cents = number | null;
type AmountCents = Readonly<Partial<Record<AmountName, number>>>;

/** One service of a booking: its money path, how it is paid and its amounts. */
export interface MoneyService {
  /** "own" for the booking's own service, else the service's id (a label). */
  readonly id: string;
  readonly price: PriceChoice;
  readonly before: BeforeChoice;
  readonly after: AfterChoice;
  /** By its money way, or by a pack credit (K-01 bookingValues paidby). */
  readonly paidBy: "money" | "credit";
  readonly amounts: ServiceAmounts;
  /** Added after booking (D91): it takes nothing now, and its price is paid at the visit or on the bill like any rest. */
  readonly later?: boolean;
}

/** A booking's money, as the step that speaks of it reads it. */
export interface MoneyBooking {
  readonly flow: FlowLetter;
  /** The booking's currency (ISO 4217): every amount is in it. */
  readonly currency: string;
  /** The booking's services, its own first (S13-55: several services, one payment on one card). */
  readonly services: readonly MoneyService[];
  /** From the money step on (a step stamped `took`): what the booking took; before it, what its services ask. */
  readonly took: boolean;
  /** False between the money step and the write (a step stamped `wr` false): nothing counts as taken. Default true. */
  readonly written?: boolean;
  /**
   * The booking values as the step reads them (K-01 bookingValues: implied values written in, events only on a step
   * stamped `ev`); a group left out reads its first value. Its paidby is the own service's.
   */
  readonly booking?: Partial<BookingValues>;
  /** The trade's switches that are on. */
  readonly switches?: readonly string[];
  /** The trade's facts, or null when it lists none. */
  readonly facts?: readonly string[] | null;
}

/** A money path: price, before and after (K-01 `combo`). */
export interface MoneyPath {
  readonly price: PriceChoice;
  readonly before: BeforeChoice;
  readonly after: AfterChoice;
}

/** What one way does with a service's amounts: paid now, a card saved, the fee it may keep, what goes back. */
export interface WayEffect {
  readonly way: string;
  /** Paid now: 0 for nothing and a card, the deposit, or the full price (null: the amount is not known). */
  readonly now: Money | null;
  /** A card is saved. */
  readonly card: boolean;
  /** The fee this way may keep: the service's fee, or its deposit when it has none (fee|deposit); 0 for nothing. */
  readonly fee: Money | null;
  /** What goes back on a cancel in time. */
  readonly back: Money | null;
}

/** One service of the booking, as its way reads it. */
export interface ServiceMoney extends WayEffect {
  readonly id: string;
  /** The service's money path as the booking took it (a credit, nothing taken or a later service reads none before). */
  readonly took: MoneyPath;
  /** Something was paid now for it (an amount not known counts as something). */
  readonly paysNow: boolean;
  /** What is left to pay for it (null: not known yet, such as a price set at the visit). */
  readonly due: Money | null;
  readonly credit: boolean;
  readonly later: boolean;
  /** A failed charge took nothing from it. */
  readonly failed: boolean;
}

/** The booking's one late-cancel and no-show fee (S13-55; record.onefee; ledger_rules keep). */
export interface OneFee {
  /** A fee applies: a card is saved or money was paid now, and the largest service fee is above 0 (or not known). */
  readonly applies: boolean;
  /** The fee: the largest service fee, never above what was paid now; 0 when none applies (null: not known). */
  readonly amount: Money | null;
  /** The largest service fee was above what was paid now, so the fee is what was paid now. */
  readonly capped: boolean;
  /** Where it would come from: out of what was paid now, or the saved card with the owner's yes (S11-22). */
  readonly from: "none" | "paidNow" | "savedCard";
}

/** The ledger amounts (record ledger_rules; overlay-core.js LEDGER_AMOUNTS), each null when not known. */
export interface MoneyLedger {
  readonly paidnow: Money | null;
  readonly due: Money | null;
  readonly keep: Money | null;
  readonly back: Money | null;
  readonly later: Money | null;
  readonly backlate: Money | null;
}

/** A booking's money as the money home reads it. */
export interface MoneyReading {
  readonly flow: FlowLetter;
  readonly currency: string;
  readonly took: boolean;
  readonly written: boolean;
  /** The money path the step reads: the services' one path (D73), and after the money step what the booking took. */
  readonly path: MoneyPath;
  /** The booking values the rows read, the own service's paidby written in. */
  readonly booking: Partial<BookingValues>;
  readonly switches: readonly string[];
  readonly facts: readonly string[] | null;
  /** The record values that hold (K-01 gate `rec`), in K-01 order. */
  readonly values: readonly RecordValue[];
  readonly services: readonly ServiceMoney[];
  readonly oneFee: OneFee;
  readonly ledger: MoneyLedger;
}

/** The record values in K-01 order (overlay-core.js REC line 595). */
const VALUE_ORDER: readonly RecordValue[] = [
  "nothing",
  "card",
  "paid",
  "full",
  "rest",
  "credit",
  "several",
  "keep",
  "written",
];

const ZERO_NAMES: ReadonlySet<string> = new Set(["0", CREDIT_WAY]);

function isAmountName(name: string): name is AmountName {
  return (AMOUNT_NAMES as readonly string[]).includes(name);
}

/** Amounts as whole cents, each checked: whole, not below zero, in the booking's currency. Errors name labels only. */
function centsOf(id: string, amounts: ServiceAmounts, currency: string): AmountCents {
  const out: Partial<Record<AmountName, number>> = {};
  for (const name of AMOUNT_NAMES) {
    const amount = amounts[name];
    if (amount === undefined) continue;
    if (!Number.isSafeInteger(amount.cents) || amount.cents < 0)
      throw new MoneyHomeError(`the ${name} amount of service ${id} is not whole cents`);
    if (amount.currency !== currency)
      throw new MoneyHomeError(`the ${name} amount of service ${id} is not in the booking's currency`);
    out[name] = amount.cents;
  }
  return out;
}

/** The amount a way's field names: 0 for "0" and "credit"; a chain's first known amount; one name's, or null. */
function amountNamed(field: string, cents: AmountCents): Cents {
  if (ZERO_NAMES.has(field)) return 0;
  for (const name of field.split("|")) {
    const value = isAmountName(name) ? cents[name] : undefined;
    if (value !== undefined) return value;
  }
  return null;
}

/** Does a way's field name something above 0? An amount not known counts as something (overlay-core.js recordOf `pos`). */
function positive(field: string, cents: AmountCents): boolean {
  if (ZERO_NAMES.has(field)) return false;
  const value = amountNamed(field, cents);
  return value === null || value > 0;
}

function wayOf(record: MoneyRecord, name: string): MoneyWay {
  const way = record.ways[name];
  if (way === undefined)
    throw new MoneyHomeError(`the record has no money way ${isLabel(name) ? name : "by that name"}`);
  return way;
}

function asMoney(cents: Cents, currency: string): Money | null {
  return cents === null ? null : { cents, currency };
}

/**
 * What one way of the record does with a service's amounts (record.ways.<way>). `savesCard` is the service's own card
 * where the way keeps it as it is (the credit way's card "asis").
 */
export function wayEffect(
  record: MoneyRecord,
  way: string,
  amounts: ServiceAmounts,
  currency: string,
  savesCard = false,
): WayEffect {
  const w = wayOf(record, way);
  const cents = centsOf(way, amounts, currency);
  return {
    way,
    now: asMoney(amountNamed(w.now, cents), currency),
    card: w.card === "asis" ? savesCard : w.card,
    fee: asMoney(amountNamed(w.fee, cents), currency),
    back: asMoney(amountNamed(w.back, cents), currency),
  };
}

/** The four ways' effects on one service's amounts: nothing, a card saved, a deposit, the full price (S13-55). */
export function fourWays(
  record: MoneyRecord,
  amounts: ServiceAmounts,
  currency: string,
): Readonly<Record<FourWay, WayEffect>> {
  return {
    none: wayEffect(record, "none", amounts, currency),
    card: wayEffect(record, "card", amounts, currency),
    deposit: wayEffect(record, "deposit", amounts, currency),
    full: wayEffect(record, "full", amounts, currency),
  };
}

/** D91: a service added after booking is paid like any rest: the booking's own way after the visit, else the counter (A) or bill (B). */
function laterWay(service: MoneyService, services: readonly MoneyService[], flow: FlowLetter): MoneyPath {
  const own = services.find((candidate) => candidate.later !== true);
  const after = own !== undefined && own.after !== "none" ? own.after : flow === "B" ? "bill" : "counter";
  return { price: service.price, before: "none", after };
}

/** D73: several services read as one money path, a service paid by a credit left out; null when only credits are left. */
function severalPath(services: readonly MoneyService[], flow: FlowLetter): MoneyPath | null {
  const all: MoneyPath[] = services
    .filter((service) => service.paidBy !== "credit")
    .map((service) => (service.later === true ? laterWay(service, services, flow) : service));
  if (all.length === 0) return null;
  const paying = all.filter((path) => !(path.before === "none" && path.after === "none"));
  const read = paying.length > 0 ? paying : all;
  const price: PriceChoice = read.some((path) => path.price === "visit")
    ? "visit"
    : read.some((path) => path.price === "photos")
      ? "photos"
      : "list";
  const before: BeforeChoice = read.every((path) => path.before === "full")
    ? "full"
    : read.some((path) => path.before === "full" || path.before === "deposit")
      ? "deposit"
      : read.some((path) => path.before === "card")
        ? "card"
        : "none";
  const afters = [...new Set(read.filter((path) => path.before !== "full").map((path) => path.after))];
  const only = afters.length === 1 ? afters[0] : undefined;
  const after: AfterChoice = afters.length === 0 ? "none" : (only ?? (flow === "A" ? "counter" : "bill"));
  return { price, before, after };
}

/** After the money step a path reads what the booking took: nothing taken reads nothing before; a credit, no money. */
function tookPath(path: MoneyPath, flow: FlowLetter, nothingTaken: boolean, credit: boolean): MoneyPath {
  if (nothingTaken) {
    if (path.before === "none" && path.after === "none") return path;
    return { price: path.price, before: "none", after: credit ? "none" : flow === "B" ? "own" : "counter" };
  }
  if (!credit) return path;
  const before = path.before === "deposit" || path.before === "full" ? "none" : path.before;
  return { price: path.price, before, after: "none" };
}

/** One service while the booking is read. */
interface Row {
  readonly service: MoneyService;
  readonly took: MoneyPath;
  readonly way: string;
  readonly credit: boolean;
  readonly cents: AmountCents;
  readonly card: boolean;
  readonly charged: Cents;
  now: Cents;
  nowPos: boolean;
  back: Cents;
  fee: Cents;
  feePos: boolean;
  failed: boolean;
  due: Cents;
  duePos: boolean;
}

function sum(values: readonly Cents[]): Cents {
  let total = 0;
  for (const value of values) {
    if (value === null) return null;
    total += value;
  }
  return total;
}

/** The booking values with the own service's paidby written in; a booking that says otherwise is refused. */
function bookingValues(booking: MoneyBooking, own: MoneyService): Partial<BookingValues> {
  const given = booking.booking ?? {};
  if (given.paidby !== undefined && given.paidby !== own.paidBy)
    throw new MoneyHomeError("the booking's paidby is not its own service's");
  return { ...given, paidby: own.paidBy };
}

function readRow(
  service: MoneyService,
  booking: MoneyBooking,
  record: MoneyRecord,
  nothingTaken: boolean,
): Row {
  const credit = service.paidBy === "credit";
  let took: MoneyPath = { price: service.price, before: service.before, after: service.after };
  if (service.later === true && !credit && !nothingTaken)
    took = laterWay(service, booking.services, booking.flow);
  else if (nothingTaken || credit) took = tookPath(took, booking.flow, nothingTaken, credit);
  const way = credit ? CREDIT_WAY : took.before;
  const w = wayOf(record, way);
  const cents = centsOf(service.id, service.amounts, booking.currency);
  const now = amountNamed(w.now, cents);
  return {
    service,
    took,
    way,
    credit,
    cents,
    card: w.card === "asis" ? took.before === "card" : w.card,
    charged: now,
    now,
    nowPos: positive(w.now, cents),
    back: amountNamed(w.back, cents),
    fee: amountNamed(w.fee, cents),
    feePos: positive(w.fee, cents),
    failed: false,
    due: 0,
    duePos: false,
  };
}

/** What is left to pay for one service (overlay-core.js recordOf, the due of each service). */
function readDue(row: Row, unwritten: boolean): void {
  const rest = row.cents.rest;
  if (row.took.after === "none") {
    row.due = 0;
    row.duePos = false;
  } else if (row.service.price === "visit") {
    row.due = null;
    row.duePos = true;
  } else if (!row.failed && !unwritten && row.took.before === row.service.before && rest !== undefined) {
    row.due = rest;
    row.duePos = rest > 0;
  } else {
    const price = row.cents.price;
    row.due = price === undefined || row.now === null ? null : Math.max(0, price - row.now);
    row.duePos = row.due === null || row.due > 0;
  }
}

/** A booking's money, as the money home reads it from the record's ways (a booking it cannot read is refused). */
export function readMoney(booking: MoneyBooking, record: MoneyRecord): MoneyReading {
  const { flow, currency, services } = booking;
  if (record.flow !== flow)
    throw new MoneyHomeError(`a flow ${flow} booking was given the flow ${record.flow} record`);
  const own = services[0];
  if (own === undefined) throw new MoneyHomeError("the booking has no service");
  if (!services.every((service) => isLabel(service.id)))
    throw new MoneyHomeError("a service's id is not a label");
  if (own.later === true)
    throw new MoneyHomeError("the booking's own service is never one added after booking");
  const values = bookingValues(booking, own);

  const took = booking.took;
  const unwritten = took && booking.written === false;
  const nothingTaken = took && values.taken === "nothing";
  const hasLater = services.some((service) => service.later === true);
  const rows = services.map((service) => readRow(service, booking, record, nothingTaken));

  // A failed charge took nothing from the services it charged: the ones added later, else every one that took money.
  if (values.charge === "failed")
    for (const row of rows)
      if (hasLater ? row.service.later === true : row.nowPos) {
        row.failed = true;
        row.now = 0;
        row.nowPos = false;
        row.back = 0;
      }
  // Between the money step and the write nothing counts as taken (no fee either); a card saved stays saved.
  if (unwritten)
    for (const row of rows) {
      row.now = 0;
      row.nowPos = false;
      row.back = 0;
      row.fee = 0;
      row.feePos = false;
    }
  for (const row of rows) readDue(row, unwritten);

  const card = rows.some((row) => row.card);
  const paid = rows.some((row) => row.nowPos);
  const rest = rows.some((row) => row.duePos);
  const credits = unwritten ? 0 : rows.filter((row) => row.credit).length;
  const paidNow = sum(rows.map((row) => row.now));

  // One fee per booking: the largest service fee, only when a card is saved or money was paid now.
  const held = card || paid;
  const fees = rows.map((row) => row.fee);
  const known = fees.every((fee) => fee !== null);
  const largest = Math.max(0, ...fees.map((fee) => fee ?? 0));
  let keep: Cents = !held ? 0 : known ? largest : null;
  let applies = held && (known ? largest > 0 : rows.some((row) => row.feePos));
  // The fee comes out of what was paid now, never more than what was paid now (S13-55).
  const capped = paid && paidNow !== null && paidNow > 0 && keep !== null && keep > paidNow;
  if (capped) keep = paidNow;
  const ledger: MoneyLedger = {
    paidnow: asMoney(paidNow, currency),
    due: asMoney(sum(rows.map((row) => row.due)), currency),
    keep: asMoney(keep, currency),
    back: asMoney(sum(rows.map((row) => row.back)), currency),
    later: asMoney(sum(rows.filter((row) => row.service.later === true).map((row) => row.charged)), currency),
    backlate: asMoney(paidNow === null || keep === null ? null : Math.max(0, paidNow - keep), currency),
  };
  if (unwritten) {
    keep = 0;
    applies = false;
  }

  const holds: Readonly<Record<RecordValue, boolean>> = {
    nothing: !paid && !card && credits === 0,
    card,
    paid,
    full: paid && !rest,
    rest,
    credit: rows.some((row) => row.credit),
    several: rows.length >= 2,
    keep: credits > 0 || applies,
    written: took && !unwritten,
  };

  const ownPath: MoneyPath = { price: own.price, before: own.before, after: own.after };
  const combined = services.length >= 2 ? (severalPath(services, flow) ?? ownPath) : ownPath;
  const path = took ? tookPath(combined, flow, nothingTaken, own.paidBy === "credit") : combined;

  return {
    flow,
    currency,
    took,
    written: !unwritten,
    path,
    booking: values,
    switches: [...(booking.switches ?? [])],
    facts: booking.facts === undefined || booking.facts === null ? null : [...booking.facts],
    values: VALUE_ORDER.filter((value) => holds[value]),
    services: rows.map((row) => ({
      id: row.service.id,
      way: row.way,
      took: row.took,
      now: asMoney(row.now, currency),
      paysNow: row.nowPos,
      card: row.card,
      fee: asMoney(row.fee, currency),
      back: asMoney(row.back, currency),
      due: asMoney(row.due, currency),
      credit: row.credit,
      later: row.service.later === true,
      failed: row.failed,
    })),
    oneFee: {
      applies,
      amount: asMoney(applies ? keep : 0, currency),
      capped: capped && applies,
      from: !applies ? "none" : paid ? "paidNow" : "savedCard",
    },
    ledger,
  };
}

/** Does the reading hold this record value? */
export function holds(reading: MoneyReading, value: RecordValue): boolean {
  return reading.values.includes(value);
}

/**
 * The booking took money: from the money step on (took), written, and something paid now (S13-55: "money already
 * taken"). Before the money step "paid" only means the money is asked for; between the money step and the write
 * nothing counts as taken.
 */
export function moneyTaken(reading: MoneyReading): boolean {
  return holds(reading, "paid") && holds(reading, "written");
}

/** A service of this booking paid a deposit now: its way is the deposit and something was paid for it. */
export function depositTaken(reading: MoneyReading): boolean {
  return reading.services.some((service) => service.way === "deposit" && service.paysNow);
}

/** The ledger as the slot filler's facts take it (T-310 LedgerFacts): an amount not known is left out, never guessed. */
export function ledgerFacts(reading: MoneyReading): Partial<Record<keyof MoneyLedger, Money>> {
  const out: Partial<Record<keyof MoneyLedger, Money>> = {};
  const { ledger } = reading;
  for (const name of ["paidnow", "due", "keep", "back", "later", "backlate"] as const) {
    const amount = ledger[name];
    if (amount !== null) out[name] = amount;
  }
  return out;
}
