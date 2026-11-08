// Test sources for the money home, for the tests only.
//
// The record is T-137's compiled record as the merged bundle emitter (T-149) writes it into each flow (the home
// registry's emittedFlows: fixture set v1's master flows, no trade): flows.A.record is the A-record. The reference the
// module is held to is the master's own booking record and row choice, the vendored overlay-core.js recordOf() and
// slotRow() and lib.js parsePath() (fixtures/master/engine/work/build, read-only, loaded by compiler/src/path/core),
// run on that same compiled record. Amounts are the flows' own amount tables, the record's services and the laundry
// trade's (fixtures/master/engine/work/prof/laundry.json); words are the master's and the registry fixture's. Nothing
// is invented and no real person is named (rule 9).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadMaster } from "../../../../compiler/src/load/flow";
import { loadPathScripts } from "../../../../compiler/src/path/core";
import { BOOKING_GROUPS, type BookingValues } from "../../finalize/slots/record";
import type { Money } from "../../finalize/slots/types";
import { emittedFlows, objAt, type EmittedFlows } from "../registry/test-support";
import type { MoneyBooking, MoneyService, ServiceAmounts } from "./money";
import { readMoneyRecord, type FlowLetter, type MoneyRecord } from "./record";

type Obj = Record<string, unknown>;

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** The booking's currency in fixture set v1 (every amount there is in dollars). */
export const CURRENCY = "USD";

export function usd(cents: number): Money {
  return { cents, currency: CURRENCY };
}

/** An amount as the fixtures write it ("$140", "$1,200.50", "free"), in cents; undefined when it is not one (overlay-core.js amountN). */
export function centsOfText(text: unknown): number | undefined {
  if (typeof text === "number") return Number.isFinite(text) ? Math.round(text * 100) : undefined;
  if (typeof text !== "string") return undefined;
  const words = text.trim().toLowerCase();
  if (words === "free" || words === "0") return 0;
  const match = /^\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(words);
  if (match === null) return undefined;
  const whole = Number((match[1] ?? "0").replace(/,/g, ""));
  const part = (match[2] ?? "").padEnd(2, "0");
  return whole * 100 + Number(part);
}

/** A fixture amount row ({ price: "$35", fee: "$20", ... }) as the module's amounts; an amount not readable is left out. */
export function amountsOf(row: Readonly<Record<string, unknown>>): ServiceAmounts {
  const out: { -readonly [K in keyof ServiceAmounts]: Money } = {};
  for (const name of ["price", "deposit", "paid", "fee", "rest"] as const) {
    const cents = centsOfText(row[name]);
    if (cents !== undefined) out[name] = usd(cents);
  }
  return out;
}

/** The vendored path, as overlay-core.js reads it (the fields this support reads). */
export interface CorePath extends Obj {
  price: string;
  before: string;
  after: string;
  booking?: Record<string, string>;
  pf?: Record<string, boolean>;
  facts?: string[] | null;
  svc?: Obj[];
}

/** What the vendored record reading gives (overlay-core.js recordOf line 669). */
interface CoreRecord {
  facts: Record<string, boolean>;
  ledger: Record<string, { n: number | null; text: string | null }>;
  svc: { id: string; now: number | null; keep: number | null; back: number | null; due: number | null }[];
}

/** The parts of the vendored scripts the reference calls. */
interface Reference {
  syncWays(flow: unknown): void;
  recordOf(
    path: unknown,
    flow: FlowLetter,
    took: boolean,
    amounts: undefined,
    written: boolean | undefined,
  ): CoreRecord;
  slotRow(name: string, path: unknown, flow: FlowLetter, step: Obj): { i: number; text: string } | null;
  amountRow(table: unknown, path: unknown): Record<string, unknown>;
  bookingValue(path: unknown, group: string): unknown;
  parsePath(text: string, flow: FlowLetter): CorePath | { problems: string[] };
  validCombo(flow: FlowLetter, combo: { price: string; before: string; after: string }): boolean;
}

function reference(): Reference {
  const { core, lib } = loadPathScripts();
  const c = core as unknown as Reference;
  return {
    syncWays: (flow) => {
      c.syncWays(flow);
    },
    recordOf: (path, flow, took, amounts, written) => c.recordOf(path, flow, took, amounts, written),
    slotRow: (name, path, flow, step) => c.slotRow(name, path, flow, step),
    amountRow: (table, path) => c.amountRow(table, path),
    bookingValue: (path, group) => c.bookingValue(path, group),
    parsePath: (text, flow) => lib.parsePath(text, flow) as CorePath | { problems: string[] },
    validCombo: (flow, combo) => lib.validCombo(flow, combo),
  };
}

/** Both flows: the emitted flow graphs, the money home's records and the reference reading them. */
export interface Sources {
  readonly flows: EmittedFlows;
  readonly records: Readonly<Record<FlowLetter, MoneyRecord>>;
  readonly ref: Reference;
  /** The flow's amount table (K-01 flowGraph amounts). */
  table(flow: FlowLetter): Obj;
  /** Makes the reference read this flow's compiled record, ways and amounts (overlay-core.js syncWays). */
  use(flow: FlowLetter): void;
}

let cached: Sources | null = null;

export async function sources(): Promise<Sources> {
  if (cached !== null) return cached;
  const flows = await emittedFlows();
  const master = loadMaster();
  const ref = reference();
  const records = {
    A: readMoneyRecord("A", flows.A.record),
    B: readMoneyRecord("B", flows.B.record),
  };
  cached = {
    flows,
    records,
    ref,
    table: (flow) => objAt(flows[flow], ["amounts"]),
    use: (flow) => {
      const graph = flows[flow];
      ref.syncWays({
        id: flow,
        money: graph.money,
        d75: master[flow].d75,
        record: graph.record,
        amounts: graph.amounts,
      });
    },
  };
  return cached;
}

/** What a step is stamped with: the money step passed (took), and the booking written or not (wr). */
export interface Stamps {
  readonly took: boolean;
  readonly written?: boolean;
}

export const STAMPS: readonly Stamps[] = [{ took: false }, { took: true }, { took: true, written: false }];

function isPath(value: CorePath | { problems: string[] }): value is CorePath {
  return !("problems" in value);
}

/** A path from its text (lib.js parsePath: "list|card|counter +two-card booking=taken:nothing"), or null if none. */
export function pathOf(src: Sources, flow: FlowLetter, text: string): CorePath | null {
  src.use(flow);
  const path = src.ref.parsePath(`${flow} ${text}`, flow);
  return isPath(path) ? path : null;
}

const SERVICE_PRICES = ["list", "photos", "visit"] as const;
const SERVICE_BEFORES = ["none", "card", "deposit", "full"] as const;
const SERVICE_AFTERS = ["none", "counter", "bill", "card", "own"] as const;

function oneOf<T extends string>(list: readonly T[], value: unknown, at: string): T {
  if (typeof value === "string" && (list as readonly string[]).includes(value)) return value as T;
  throw new Error(`${at}: ${String(value)} is not one of ${list.join(", ")}`);
}

/** The booking a vendored path stands for: its services (its own first), their amounts and its booking values. */
export function bookingOf(src: Sources, flow: FlowLetter, path: CorePath, stamps: Stamps): MoneyBooking {
  const table = src.table(flow);
  const own: Obj = { id: "own", own: true, price: path.price, before: path.before, after: path.after };
  const list = Array.isArray(path.svc) && path.svc.length > 0 ? path.svc : [own];
  const ownCredit = src.ref.bookingValue(path, "paidby") === "credit";
  const services: MoneyService[] = list.map((service) => {
    const isOwn = service.own === true;
    const price = oneOf(SERVICE_PRICES, service.price, "price");
    const before = oneOf(SERVICE_BEFORES, service.before, "before");
    const after = oneOf(SERVICE_AFTERS, service.after, "after");
    const own = isObj(service.amounts) && !isOwn ? service.amounts : {};
    const amounts = amountsOf({ ...src.ref.amountRow(table, { price, before, after }), ...own });
    const credit = isOwn ? ownCredit : service.paidby === "credit";
    const base: MoneyService = {
      id: typeof service.id === "string" ? service.id : "own",
      price,
      before,
      after,
      paidBy: credit ? "credit" : "money",
      amounts,
    };
    return service.later === true ? { ...base, later: true } : base;
  });
  const booking: Partial<Record<keyof BookingValues, string>> = {};
  for (const group of Object.keys(BOOKING_GROUPS) as (keyof BookingValues)[]) {
    const value = src.ref.bookingValue(path, group);
    if (typeof value === "string") booking[group] = value;
  }
  const switches = Object.entries(path.pf ?? {})
    .filter(([, on]) => on)
    .map(([name]) => name);
  const out: MoneyBooking = {
    flow,
    currency: CURRENCY,
    services,
    took: stamps.took,
    booking: booking as Partial<BookingValues>,
    switches,
    facts: Array.isArray(path.facts) ? path.facts : null,
  };
  return stamps.written === undefined ? out : { ...out, written: stamps.written };
}

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The reference's reading of a path: its record values, its ledger in cents and the row each money slot takes. */
export interface ReferenceReading {
  readonly values: readonly string[];
  readonly ledger: Readonly<Record<string, number | null>>;
  readonly rows: Readonly<Record<string, number | null>>;
}

export function referenceOf(
  src: Sources,
  flow: FlowLetter,
  path: CorePath,
  stamps: Stamps,
  slots: readonly string[],
): ReferenceReading {
  src.use(flow);
  const written = stamps.took && stamps.written === false ? false : undefined;
  const record = src.ref.recordOf(path, flow, stamps.took, undefined, written);
  const step: Obj = { ev: flow };
  if (stamps.took) step.took = flow;
  if (written === false) step.wr = false;
  const rows: Record<string, number | null> = {};
  for (const slot of slots) rows[slot] = src.ref.slotRow(slot, path, flow, step)?.i ?? null;
  const ledger: Record<string, number | null> = {};
  for (const [name, at] of [
    ["paidnow", "now"],
    ["due", "due"],
    ["keep", "keep"],
    ["back", "back"],
    ["later", "later"],
    ["backlate", "backlate"],
  ] as const) {
    const n = record.ledger[at]?.n ?? null;
    ledger[name] = n === null ? null : Math.round(n * 100);
  }
  return {
    values: Object.entries(record.facts)
      .filter(([, on]) => on)
      .map(([name]) => name),
    ledger,
    rows,
  };
}

/** The money paths of a flow the master walks (lib.js validCombo). */
export function moneyPathsOf(src: Sources, flow: FlowLetter): string[] {
  src.use(flow);
  const out: string[] = [];
  for (const price of SERVICE_PRICES)
    for (const before of SERVICE_BEFORES)
      for (const after of SERVICE_AFTERS)
        if (src.ref.validCombo(flow, { price, before, after })) out.push(`${price}|${before}|${after}`);
  return out;
}

/** What each money path is read with: alone, with each booking value the money rows read, and riding each fixture. */
export const PATH_VARIANTS: readonly string[] = [
  "",
  "booking=paidby:credit",
  "booking=taken:nothing",
  "booking=charge:failed",
  "booking=payer:other",
  "booking=madeby:shop",
  "booking=approval:ownerok",
  "booking=timing:sentnow",
  "booking=reach:callsonly",
  "+two-card",
  "+two-full",
  "+credit-plus",
  "+added-later",
  "+shop-nothing",
  "+payer-other",
  "+two-card booking=paidby:credit",
  "+two-full booking=charge:failed",
  "+added-later booking=charge:failed",
];

/** The laundry trade's flow B (fixture set v1): its main path list|card|card, "A card is saved, with no fee", $35. */
export function laundryB(): {
  readonly main: string;
  readonly amounts: ServiceAmounts;
  readonly example: string;
} {
  const trade = JSON.parse(
    readFileSync(`${ROOT}fixtures/master/engine/work/prof/laundry.json`, "utf8"),
  ) as Obj;
  const money = objAt(trade, ["money", "B"]);
  const main = money.main;
  if (typeof main !== "string") throw new Error("laundry.json money.B has no main path");
  const table = objAt(money, ["amounts"]);
  const amounts = amountsOf({ ...objAt(table, ["*"]), ...objAt(table, ["list|*|*"]) });
  const example = objAt(money, ["examples"])[main];
  if (typeof example !== "string") throw new Error("laundry.json money.B has no example for its main path");
  return { main, amounts, example };
}

/** S13-55's own lines on silence and holds, word for word (master-A.json S13-55 `more`). */
export const S13_55_LINES = [
  "Nothing is ever held on a card.",
  "Rosie NEVER makes a new charge on silence. Silence: no fee, unless a signed schedule keeps part.",
  "A signed schedule keeps only its share of money already taken. It never makes a new charge.",
];
