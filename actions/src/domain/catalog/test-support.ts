// Doubles for the catalog and pricing tests (T-320). Never imported by the Worker. No database: an in-memory store of the
// frozen contracts' seed rows (K-04 core, K-23 business setup, K-24 kinds of work, K-25 services and prices, K-26 rules,
// K-30 bookings), each file's `after` chain first and each file once (K-04 v1's README, "Seed and refused-row
// fixtures"), which applies K-05 v1 stateWrites as the commit does (an insert, or an update that names the version it
// read and raises it), and a fake of the catalog's five reads over it, scoped by business as row-level security scopes
// them (arch 10 line 546). Names, ids and amounts come only from the fixtures' demo shops and the master's sample cast
// (Sam, Dee, Andre; Lee's Barbershop, Lee Home Services, the movers' vault visit), never a real person (rule 9); no
// phone number is used. Made up here: the time of Sam's raise on Mon Oct 26 (K-30 seed-booking-line-price-copied gives
// the day only) and of his withdrawal on Wed Oct 28.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { StateWrite } from "../../commit";
import { CatalogRefusedError, type CatalogRefusal } from "./errors";
import type { CatalogReads } from "./reads";
import type {
  BusinessKind,
  BusinessSetup,
  Flow,
  FlowDefault,
  LocationRow,
  PlaceOrThingRow,
  PriceRuleRow,
  PriceTieRow,
  ResourceRow,
  ScopedRow,
  ServiceRow,
  WayRow,
} from "./types";

/** The frozen db-schema parts' folder. */
const DB_SCHEMA_DIR = fileURLToPath(new URL("../../../../contracts/db-schema/", import.meta.url));

export type Row = Record<string, unknown>;

export interface SeedRow {
  readonly table: string;
  readonly values: Readonly<Row>;
}

interface SeedFile {
  readonly after?: readonly string[];
  readonly rows?: readonly SeedRow[];
  readonly refused?: { readonly table: string; readonly values: Readonly<Row> };
}

function readSeed(file: string): SeedFile {
  return JSON.parse(readFileSync(file, "utf8")) as SeedFile;
}

/** The rows of seed fixtures (paths under contracts/db-schema/), each file's `after` chain first and each file once. */
export function seedRows(files: readonly string[]): SeedRow[] {
  const rows: SeedRow[] = [];
  const loaded = new Set<string>();
  const load = (file: string): void => {
    if (loaded.has(file)) return;
    loaded.add(file);
    const seed = readSeed(file);
    for (const after of seed.after ?? []) load(path.resolve(path.dirname(file), after));
    rows.push(...(seed.rows ?? []));
  };
  for (const file of files) load(path.join(DB_SCHEMA_DIR, ...file.split("/")));
  return rows;
}

/** One fixture file's own rows, without its `after` chain. */
export function fixtureRows(file: string): SeedRow[] {
  return [...(readSeed(path.join(DB_SCHEMA_DIR, ...file.split("/"))).rows ?? [])];
}

/** The row a refused fixture tries to insert, and the fixture's own rows. */
export function refusedFixture(file: string): { readonly rows: SeedRow[]; readonly refused: SeedRow } {
  const seed = readSeed(path.join(DB_SCHEMA_DIR, ...file.split("/")));
  if (seed.refused === undefined) throw new Error(`${file} refuses no row`);
  return { rows: [...(seed.rows ?? [])], refused: seed.refused };
}

/**
 * The seeds every test starts from: the barbershop's and Lee Home Services' kinds, services, ways and prices, the rules,
 * and K-04's worker resources (Riley and Avery at the barbershop, which a price by person names; T-1433).
 */
export const SEEDS = [
  "kinds-of-work/fixtures/seed-kinds-sample.json",
  "business-setup/fixtures/seed-company-two-kinds.json",
  "services-prices/fixtures/seed-price-rule-dates.json",
  "rules/fixtures/seed-rules-tap-list.json",
  "rules/fixtures/seed-note-only-rule.json",
  "rules/fixtures/seed-price-ok-limit.json",
  "bookings-changes/fixtures/seed-booking-line-price-copied.json",
  "core/fixtures/seed-resources.json",
] as const;

// ---- the store ------------------------------------------------------------------------------------------------------

/** Each table's primary key (the frozen table lists); every other table's is its id. */
const PRIMARY_KEYS: Readonly<Record<string, readonly string[]>> = {
  company_kinds: ["company_id", "kind_id"],
  kind_flows: ["kind_id", "flow"],
  flow_defaults: ["business_id", "flow"],
  business_setup: ["business_id"],
  item_services: ["place_or_thing_id", "service_id"],
  booking_terms: ["booking_id"],
  booking_details: ["booking_id"],
  person_handles: ["person_id", "handle_id"],
  phones: ["number"],
  sealing_keys: ["person_id"],
};

/** The tables with no version column: their rows are only inserted (and links deleted). */
const UNVERSIONED: readonly string[] = [
  "item_services",
  "booking_terms",
  "booking_terms_rules",
  "person_handles",
];

/** A write the store refuses as the commit would: a row twice, a row not found, or a version that moved on. */
export class StoreRefusedError extends Error {
  override name = "StoreRefusedError";
}

function keyOf(table: string, values: Readonly<Row>): string {
  return (PRIMARY_KEYS[table] ?? ["id"]).map((column) => JSON.stringify(values[column] ?? null)).join("|");
}

/** The rows of every table, which applies K-05 v1 stateWrites all or nothing. */
export class Store {
  private tables = new Map<string, Row[]>();

  constructor(rows: readonly SeedRow[] = []) {
    for (const row of rows) this.put(row.table, { ...row.values });
  }

  /** Every row of a table, as stored. */
  rows(table: string): Row[] {
    return this.tables.get(table) ?? [];
  }

  /** The row of a table with this id (or key), or undefined. */
  row(table: string, key: string | Readonly<Row>): Row | undefined {
    const wanted = typeof key === "string" ? keyOf(table, { id: key }) : keyOf(table, key);
    return this.rows(table).find((row) => keyOf(table, row) === wanted);
  }

  /** Adds or replaces a row by its key (a seed row, or a test's own state). */
  put(table: string, values: Row): void {
    const rows = this.rows(table).filter((row) => keyOf(table, row) !== keyOf(table, values));
    this.tables.set(table, [...rows, values]);
  }

  /** Removes a row by its key (a test's own state before a seed's change). */
  drop(table: string, id: string): void {
    this.tables.set(
      table,
      this.rows(table).filter((row) => row.id !== id),
    );
  }

  clone(): Store {
    const copy = new Store();
    for (const [table, rows] of this.tables)
      copy.tables.set(
        table,
        rows.map((row) => structuredClone(row)),
      );
    return copy;
  }

  /** Applies writes in order, all or nothing, as the commit does (K-05 v1: inserts, and updates compared and set). */
  apply(writes: readonly StateWrite[]): void {
    const next = this.clone();
    for (const write of writes) {
      if (write.op === "insert") {
        if (next.row(write.table, write.values) !== undefined)
          throw new StoreRefusedError(`${write.table}: a row with this key exists`);
        const values: Row = { ...write.values };
        if (!UNVERSIONED.includes(write.table) && values.version === undefined) values.version = 1;
        next.put(write.table, values);
        continue;
      }
      const row = next.row(write.table, write.key);
      if (row === undefined) throw new StoreRefusedError(`${write.table}: no row with this key`);
      const version = typeof row.version === "number" ? row.version : 1;
      if (version !== write.expectVersion)
        throw new StoreRefusedError(`${write.table}: the version moved on`);
      next.put(write.table, { ...row, ...write.set, version: version + 1 });
    }
    this.tables = next.tables;
  }
}

// ---- the five reads over the store ------------------------------------------------------------------------------------

const text = (row: Readonly<Row>, column: string): string => {
  const value = row[column];
  if (typeof value !== "string") throw new Error(`a stored row without ${column}`);
  return value;
};

const textOrNull = (row: Readonly<Row>, column: string): string | null => {
  const value = row[column];
  return typeof value === "string" ? value : null;
};

const numberOrNull = (row: Readonly<Row>, column: string): number | null => {
  const value = row[column];
  return typeof value === "number" ? value : null;
};

const versionOf = (row: Readonly<Row>): number => numberOrNull(row, "version") ?? 1;

const strings = (row: Readonly<Row>, column: string): string[] => {
  const value = row[column];
  return Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : [];
};

const UNIT_MINUTES: Readonly<Record<string, number>> = { minute: 1, hour: 60, day: 1440 };

/** A PostgreSQL interval as the fixtures write it ("2 hours 30 minutes", "1 day", "120 minutes") in whole minutes. */
export function minutesOf(interval: string): number {
  const parts = interval.trim().split(/\s+/u);
  let minutes = 0;
  for (let index = 0; index < parts.length; index += 2) {
    const amount = Number(parts[index]);
    const unit = UNIT_MINUTES[(parts[index + 1] ?? "").replace(/s$/u, "")];
    if (!Number.isFinite(amount) || unit === undefined) throw new Error(`not an interval: ${interval}`);
    minutes += amount * unit;
  }
  return minutes;
}

const minutesOrNull = (row: Readonly<Row>, column: string): number | null => {
  const value = textOrNull(row, column);
  return value === null ? null : minutesOf(value);
};

/** A clock time as K-25 keeps it, "HH:MM" (a time column's ":00" seconds left off). */
const clockOrNull = (row: Readonly<Row>, column: string): string | null => {
  const value = textOrNull(row, column);
  return value === null ? null : value.replace(/^(\d{2}:\d{2}):00$/u, "$1");
};

const flowOrNull = (row: Readonly<Row>, column: string): Flow | null => {
  const value = row[column];
  return value === "A" || value === "B" ? value : null;
};

const inForceAt = (row: Readonly<Row>, at: number): boolean => {
  const from = Date.parse(text(row, "effective_from"));
  const to = textOrNull(row, "effective_to");
  return from <= at && (to === null || at < Date.parse(to));
};

/** K-05 v1.18 item 77's name of a row whose key is two columns: the key's values joined by "/" (the database builds it). */
const nameOf = (first: string, second: string): string => `${first}/${second}`;

export function kindOf(store: Store, row: Readonly<Row>): BusinessKind {
  const kindId = text(row, "kind_id");
  const flowRow = (flow: Flow): Row | undefined =>
    store.rows("kind_flows").find((each) => each.kind_id === kindId && each.flow === flow);
  const paths = (flow: Flow): string[] => {
    const found = flowRow(flow);
    return found === undefined ? [] : strings(found, "combos");
  };
  const flows = (["A", "B"] as const).flatMap((flow) => {
    const found = flowRow(flow);
    return found === undefined ? [] : [{ rowId: nameOf(kindId, flow), flow, version: versionOf(found) }];
  });
  return {
    rowId: nameOf(text(row, "company_id"), kindId),
    companyId: text(row, "company_id"),
    kindId,
    businessId: text(row, "business_id"),
    tradeName: textOrNull(row, "trade_name"),
    facts: strings(row, "pf_facts"),
    switchesA: strings(row, "pf_switches_a"),
    switchesB: strings(row, "pf_switches_b"),
    version: versionOf(row),
    paths: { A: paths("A"), B: paths("B") },
    flows,
  };
}

/** A business_setup row as read 1 answers it: its no money alone, with its key and version. */
function setupOf(row: Readonly<Row>): BusinessSetup {
  return { businessId: text(row, "business_id"), noMoney: row.no_money === true, version: versionOf(row) };
}

function locationOf(row: Readonly<Row>): LocationRow {
  return {
    id: text(row, "id"),
    businessId: text(row, "business_id"),
    kind: text(row, "kind") as LocationRow["kind"],
    travelMiles: numberOrNull(row, "travel_miles"),
    version: versionOf(row),
  };
}

function resourceOf(row: Readonly<Row>): ResourceRow {
  return {
    id: text(row, "id"),
    businessId: text(row, "business_id"),
    kind: text(row, "kind"),
    active: row.active !== false,
    version: versionOf(row),
  };
}

function placeOrThingOf(row: Readonly<Row>): PlaceOrThingRow {
  return {
    id: text(row, "id"),
    businessId: text(row, "business_id"),
    kind: text(row, "kind"),
    version: versionOf(row),
  };
}

export function serviceOf(row: Readonly<Row>): ServiceRow {
  return {
    id: text(row, "id"),
    businessId: text(row, "business_id"),
    kindId: text(row, "kind_id"),
    name: text(row, "name"),
    priceKind: text(row, "price_kind") as ServiceRow["priceKind"],
    unit: textOrNull(row, "unit"),
    lengthMinutes: minutesOf(text(row, "length")),
    position: numberOrNull(row, "position") ?? 1,
    active: row.active !== false,
    version: versionOf(row),
  };
}

export function wayOf(row: Readonly<Row>): WayRow {
  const tip = row.tip_line;
  return {
    id: text(row, "id"),
    serviceId: text(row, "service_id"),
    businessId: text(row, "business_id"),
    flow: flowOrNull(row, "flow") ?? "A",
    place: text(row, "place") as WayRow["place"],
    locationId: textOrNull(row, "location_id"),
    path: text(row, "path"),
    depositCents: numberOrNull(row, "deposit_cents"),
    depositPercent: numberOrNull(row, "deposit_percent"),
    feeCents: numberOrNull(row, "fee_cents"),
    currency: textOrNull(row, "currency"),
    cutoffBeforeMinutes: minutesOrNull(row, "cutoff_before"),
    cutoffDayBeforeAt: clockOrNull(row, "cutoff_day_before_at"),
    tipLine: typeof tip === "boolean" ? tip : null,
    active: row.active !== false,
    version: versionOf(row),
  };
}

export function ruleOf(row: Readonly<Row>): PriceRuleRow {
  return {
    id: text(row, "id"),
    businessId: text(row, "business_id"),
    serviceId: text(row, "service_id"),
    conditions: {
      serviceMoneyId: textOrNull(row, "service_money_id"),
      workerResourceId: textOrNull(row, "worker_resource_id"),
      weekdays: textOrNull(row, "weekdays"),
      fromTime: clockOrNull(row, "from_time"),
      untilTime: clockOrNull(row, "until_time"),
    },
    priceCents: numberOrNull(row, "price_cents") ?? 0,
    fromCents: numberOrNull(row, "from_cents"),
    currency: text(row, "currency"),
    setByPersonId: text(row, "set_by_person_id"),
    effectiveFrom: text(row, "effective_from"),
    effectiveTo: textOrNull(row, "effective_to"),
    version: versionOf(row),
  };
}

function tieOf(row: Readonly<Row>): PriceTieRow {
  return {
    id: text(row, "id"),
    businessId: text(row, "business_id"),
    serviceId: text(row, "service_id"),
    firstRuleId: text(row, "first_rule_id"),
    secondRuleId: text(row, "second_rule_id"),
    askedAt: text(row, "asked_at"),
    winnerRuleId: textOrNull(row, "winner_rule_id"),
    answeredAt: textOrNull(row, "answered_at"),
    answeredByPersonId: textOrNull(row, "answered_by_person_id"),
    version: versionOf(row),
  };
}

function scopedOf(row: Readonly<Row>): ScopedRow {
  return {
    id: text(row, "id"),
    businessId: text(row, "business_id"),
    flow: flowOrNull(row, "flow"),
    kindId: textOrNull(row, "kind_id"),
    effectiveFrom: text(row, "effective_from"),
    effectiveTo: textOrNull(row, "effective_to"),
    version: versionOf(row),
  };
}

function flowDefaultOf(row: Readonly<Row>): FlowDefault {
  return {
    rowId: nameOf(text(row, "business_id"), text(row, "flow")),
    businessId: text(row, "business_id"),
    flow: flowOrNull(row, "flow") ?? "A",
    cutoffBeforeMinutes: minutesOrNull(row, "cutoff_before"),
    cutoffDayBeforeAt: clockOrNull(row, "cutoff_day_before_at"),
    version: versionOf(row),
  };
}

/** Each read asked, by name, in order. */
export type ReadLog = string[];

/**
 * The catalog's reads over the store, as T-1429's binding answers them under the call's business scope: only the
 * business's rows (row-level security), each with its version (and item 77's name for a key of two columns); the
 * business's setup, or null with none; a service's rules in effect at or after the instant asked; the rules and limits in
 * force then; a location, resource or space by its id, or null when the business has none by that id (T-1433). `scoped:
 * false` answers every business's rows, as a leaky binding would.
 */
export function readsOf(
  store: Store,
  log: ReadLog = [],
  options: { readonly scoped?: boolean } = {},
): CatalogReads {
  const scoped = options.scoped ?? true;
  const mine = (businessId: string) => (row: Readonly<Row>) => !scoped || row.business_id === businessId;
  /** A row of `table` by its id under the business, or null. */
  const byId = (table: string, businessId: string, id: string): Row | null =>
    store
      .rows(table)
      .filter(mine(businessId))
      .find((row) => row.id === id) ?? null;
  return {
    kindsOf(businessId) {
      log.push("kindsOf");
      const [setup] = store.rows("business_setup").filter(mine(businessId));
      return Promise.resolve({
        setup: setup === undefined ? null : setupOf(setup),
        kinds: store
          .rows("company_kinds")
          .filter(mine(businessId))
          .map((row) => kindOf(store, row)),
      });
    },
    servicesOf(businessId) {
      log.push("servicesOf");
      return Promise.resolve(store.rows("services").filter(mine(businessId)).map(serviceOf));
    },
    waysOf(businessId, serviceId) {
      log.push("waysOf");
      return Promise.resolve(
        store
          .rows("service_money")
          .filter(mine(businessId))
          .filter((row) => row.service_id === serviceId)
          .map(wayOf),
      );
    },
    priceRulesOf(businessId, serviceId, at) {
      log.push("priceRulesOf");
      const atMs = Date.parse(at);
      const rules = store
        .rows("price_rules")
        .filter(mine(businessId))
        .filter((row) => row.service_id === serviceId)
        .map(ruleOf)
        .filter((rule) => rule.effectiveTo === null || Date.parse(rule.effectiveTo) > atMs);
      const ties = store
        .rows("price_rule_ties")
        .filter(mine(businessId))
        .filter((row) => row.service_id === serviceId)
        .map(tieOf);
      return Promise.resolve({ rules, ties });
    },
    termsSourcesOf(businessId, flow, at) {
      log.push("termsSourcesOf");
      const atMs = Date.parse(at);
      const defaults = store
        .rows("flow_defaults")
        .filter(mine(businessId))
        .find((row) => row.flow === flow);
      return Promise.resolve({
        flowDefault: defaults === undefined ? null : flowDefaultOf(defaults),
        rules: store
          .rows("rules")
          .filter(mine(businessId))
          .filter((row) => inForceAt(row, atMs))
          .map(scopedOf),
        priceOkLimits: store
          .rows("price_ok_limits")
          .filter(mine(businessId))
          .filter((row) => inForceAt(row, atMs))
          .map(scopedOf),
      });
    },
    locationOf(businessId, locationId) {
      log.push("locationOf");
      const row = byId("locations", businessId, locationId);
      return Promise.resolve(row === null ? null : locationOf(row));
    },
    resourceOf(businessId, resourceId) {
      log.push("resourceOf");
      const row = byId("resources", businessId, resourceId);
      return Promise.resolve(row === null ? null : resourceOf(row));
    },
    placeOrThingOf(businessId, placeOrThingId) {
      log.push("placeOrThingOf");
      const row = byId("places_or_things", businessId, placeOrThingId);
      return Promise.resolve(row === null ? null : placeOrThingOf(row));
    },
  };
}

// ---- the cast and the times ---------------------------------------------------------------------------------------------

export const BARBERSHOP = "biz-lees-barbershop";
export const HOME_SERVICES = "biz-lee-home-services";
export const MOVERS = "biz-movers";
export const SAM = "person-sam";
export const ZONE = "America/New_York";

/** When Sam confirmed the money card (K-25 README: 2:11pm Mon Oct 19), the start of every seeded price. */
export const CARD_CONFIRMED = "2026-10-19T18:11:00Z";
/** Sam's raise of the haircut, on Mon Oct 26 (K-30 seed-booking-line-price-copied; the time is made up). */
export const RAISE_DAY = "2026-10-26T14:00:00Z";
/** The start of Mon Nov 2 in the barbershop's zone: S11-54's change date (K-25 README). */
export const NOV_2 = "2026-11-02T05:00:00Z";
/** Sam withdraws the faucet rebuild's raise on Wed Oct 28 (K-25 seed-price-withdrawn-before-start; time made up). */
export const WITHDRAW_DAY = "2026-10-28T14:00:00Z";
/** When Dee's skin fade booking was written, its snapshot's written_at (K-30 seed-terms-snapshot). */
export const SKIN_FADE_WRITTEN = "2026-10-22T22:30:00Z";
/** Dee's haircut visit, Sat Nov 7 at 11:00am in the barbershop's zone, after her move (K-30 seed). */
export const DEE_VISIT = "2026-11-07T16:00:00Z";

/** The store of SEEDS, with the haircut's rules as they stood before Sam's raise: the $35 row open, no $40 row yet. */
export function beforeRaise(): Store {
  const store = new Store(seedRows(SEEDS));
  const { rows } = refusedFixture("services-prices/fixtures/invalid/refuse-overlapping-effective-dates.json");
  store.drop("price_rules", "price-lees-haircut-40");
  for (const row of rows) store.put(row.table, { ...row.values });
  return store;
}

/** The faucet rebuild at Lee Home Services before any raise: its $35 row open (seed-price-withdrawn-before-start). */
export function faucetBeforeRaise(store: Store): Store {
  const rows = fixtureRows("services-prices/fixtures/seed-price-withdrawn-before-start.json");
  for (const row of rows) {
    if (row.table !== "price_rules") store.put(row.table, { ...row.values });
    else if (row.values.id === "price-lee-plumbing-faucet-rebuild-35")
      store.put(row.table, { ...row.values, effective_to: null, version: 1 });
  }
  return store;
}

/** The price rule rows of one service, by id, as stored. */
export function rulesOfService(store: Store, serviceId: string): Row[] {
  return store
    .rows("price_rules")
    .filter((row) => row.service_id === serviceId)
    .sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
}

/** A seed row's values with every column the table list has, a column left out taking its default (null, version 1). */
export function withDefaults(values: Readonly<Row>, columns: readonly string[]): Row {
  const row: Row = {};
  for (const column of columns) row[column] = values[column] ?? (column === "version" ? 1 : null);
  return row;
}

/** K-25 v1 price_rules' columns. */
export const PRICE_RULE_COLUMNS: readonly string[] = [
  "id",
  "business_id",
  "service_id",
  "service_money_id",
  "worker_resource_id",
  "weekdays",
  "from_time",
  "until_time",
  "price_cents",
  "from_cents",
  "currency",
  "set_by_person_id",
  "effective_from",
  "effective_to",
  "version",
];

/** The reason a call refused with, or null when it did not refuse. */
export function refusalOf(run: () => unknown): CatalogRefusal | null {
  try {
    run();
  } catch (error) {
    if (error instanceof CatalogRefusedError) return error.reason;
    throw error;
  }
  return null;
}

/** Every string anywhere in a value, keys excluded. */
export function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => stringsIn(item));
  if (typeof value === "object" && value !== null)
    return Object.values(value).flatMap((item) => stringsIn(item));
  return [];
}
