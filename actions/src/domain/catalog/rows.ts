// The catalog's field checks and its writes (C-096, T-320): every row it builds is held here to the forms K-23 v1, K-25 v1
// and K-30 v1 give it, with the rules across rows that K-25 rule 9 leaves to code, so a malformed row never reaches the
// commit. Every write passes checkCatalogWrite, the one gate between the service and the commit:
//   - only the catalog's own tables, and only an insert or an update naming the version read (K-05 v1 stateWrite; K-05
//     has no delete write, CQ-128 (2));
//   - a terms snapshot and its rules are inserted and never updated (K-30 rule 6), so one taken never changes;
//   - a price rule's values are never edited in place: an update only closes it (K-25 rule 6), so a booking that copied a
//     rule's price keeps it (RULES 3.7);
//   - a space-service link is only inserted (item_services carries no version).

import type { StateWrite } from "../../commit";
import { refuse } from "./errors";
import type { BusinessKind, Flow, Place, PriceConditions, WayRow } from "./types";

const UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$/u;
const CLOCK = /^([01][0-9]|2[0-3]):([0-5][0-9])(?::([0-5][0-9]))?$/u;
const CURRENCY = /^[A-Z]{3}$/u;
/** K-23 company_kinds_kind_id_form; K-24 kinds_id_form. */
const KIND_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/u;
/** K-23 company_kinds_names_form: a fact or switch name, lowercase letters and digits. */
const NAME = /^[a-z0-9]+$/u;
/** K-25 price_rules_weekdays_form: ISO weekday digits in order, one to six of them (every day is no condition). */
const WEEKDAYS = /^1?2?3?4?5?6?7?$/u;
/** K-30 booking_terms_version_given: a BCP 47 language tag. */
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]+)*$/u;
/** K-30 booking_terms_zone_with_clock: an IANA zone name. */
const ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/u;

/** The master's 28 money paths per flow, as K-25 v1's CHECK service_money_path_known lists them (D66: no hold). */
export const PATHS: Readonly<Record<Flow, readonly string[]>> = {
  A: [
    "list|none|none",
    "list|none|counter",
    "list|none|bill",
    "list|card|counter",
    "list|card|bill",
    "list|card|card",
    "list|deposit|counter",
    "list|deposit|bill",
    "list|deposit|card",
    "list|full|none",
    "photos|none|none",
    "photos|none|counter",
    "photos|none|bill",
    "photos|card|counter",
    "photos|card|bill",
    "photos|card|card",
    "photos|deposit|counter",
    "photos|deposit|bill",
    "photos|deposit|card",
    "photos|full|none",
    "visit|none|counter",
    "visit|none|bill",
    "visit|card|counter",
    "visit|card|bill",
    "visit|card|card",
    "visit|deposit|counter",
    "visit|deposit|bill",
    "visit|deposit|card",
  ],
  B: [
    "list|none|none",
    "list|none|bill",
    "list|none|own",
    "list|card|bill",
    "list|card|card",
    "list|card|own",
    "list|deposit|bill",
    "list|deposit|card",
    "list|deposit|own",
    "list|full|none",
    "photos|none|none",
    "photos|none|bill",
    "photos|none|own",
    "photos|card|bill",
    "photos|card|card",
    "photos|card|own",
    "photos|deposit|bill",
    "photos|deposit|card",
    "photos|deposit|own",
    "photos|full|none",
    "visit|none|bill",
    "visit|none|own",
    "visit|card|bill",
    "visit|card|card",
    "visit|card|own",
    "visit|deposit|bill",
    "visit|deposit|card",
    "visit|deposit|own",
  ],
};

// ---- fields ---------------------------------------------------------------------------------------------------------

/** An opaque id code makes (CQ-09): a non-empty string with no space around it. */
export function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

/** Refuses a field that is not an id. */
export function requireId(value: unknown, field: string): string {
  if (!isId(value)) refuse("badInput", [field]);
  return value;
}

/** Refuses a field that is neither an id nor null. */
export function idOrNull(value: unknown, field: string): string | null {
  return value === null ? null : requireId(value, field);
}

/** Refuses an instant that is not UTC ending in Z. */
export function requireUtc(value: unknown, field: string): string {
  if (typeof value !== "string" || !UTC.test(value) || Number.isNaN(Date.parse(value)))
    refuse("badInput", [field]);
  return value;
}

/** An instant's milliseconds; null stands for an open end. */
export function msOf(instant: string): number {
  return Date.parse(instant);
}

/** Refuses an amount that is not whole cents of at least `min`. */
export function requireCents(value: unknown, field: string, min: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) refuse("badInput", [field]);
  return value;
}

/** Refuses a span that is not a positive whole number of minutes. */
export function requireMinutes(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) refuse("badInput", [field]);
  return value;
}

/** Refuses a version that is not a positive whole number. */
export function requireVersion(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) refuse("badInput", [field]);
  return value;
}

/** Refuses a flag that is not a boolean. */
export function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") refuse("badInput", [field]);
  return value;
}

/** Refuses words that are blank or not a string (a name, a unit, a terms version). */
export function requireWords(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) refuse("badInput", [field]);
  return value;
}

/** A clock time's seconds after midnight, or null when it is not "HH:MM" or "HH:MM:SS". */
export function clockSeconds(value: string): number | null {
  const match = CLOCK.exec(value);
  if (match === null) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? "0");
}

/** Refuses a clock time that is not "HH:MM" or "HH:MM:SS". */
export function requireClock(value: unknown, field: string): string {
  if (typeof value !== "string" || clockSeconds(value) === null) refuse("badInput", [field]);
  return value;
}

/** Refuses a currency that is not three capital letters, or not the business's one (K-25 rule 7). */
export function requireCurrency(value: unknown, field: string, business: string): string {
  if (typeof value !== "string" || !CURRENCY.test(value)) refuse("badInput", [field]);
  if (value !== business) refuse("currencyMismatch", [field]);
  return value;
}

export function isCurrency(value: unknown): value is string {
  return typeof value === "string" && CURRENCY.test(value);
}

/** Refuses a kind of work's id that is not a profession file's form (K-23 company_kinds_kind_id_form). */
export function requireKindId(value: unknown, field: string): string {
  if (typeof value !== "string" || !KIND_ID.test(value)) refuse("badInput", [field]);
  return value;
}

/** Refuses a list of fact or switch names out of form or named twice (K-23 company_kinds_names_form). */
export function requireNames(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) refuse("badInput", [field]);
  const names: string[] = [];
  value.forEach((name: unknown, index) => {
    if (typeof name !== "string" || !NAME.test(name) || names.includes(name))
      refuse("badInput", [`${field}.${String(index)}`]);
    names.push(name);
  });
  return names;
}

export function requireLanguage(value: unknown, field: string): string {
  if (typeof value !== "string" || !LANGUAGE.test(value)) refuse("badInput", [field]);
  return value;
}

export function requireZone(value: unknown, field: string): string {
  if (typeof value !== "string" || !ZONE.test(value)) refuse("badInput", [field]);
  return value;
}

/** Refuses extras that are not a JSON object's text (K-25 services_extras_json), or null. */
export function extrasOrNull(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") return refuse("badInput", [field]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return refuse("badInput", [field]);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) refuse("badInput", [field]);
  return value;
}

/** A span as PostgreSQL interval input, in whole minutes, as K-04's seed fixtures write an interval ("120 minutes"). */
export function interval(minutes: number): string {
  return `${String(minutes)} minutes`;
}

/** The flow a place takes (K-25 service_money_flow_matches_place): the customer's place is flow B, every other A. */
export function flowOf(place: Place): Flow {
  return place === "customer" ? "B" : "A";
}

// ---- a way's money (S1-13; FS section 4; K-25 rule 9) ------------------------------------------------------------------

/** A way's fields as they will stand once written: its money, checked against its kind and the business's currency. */
export type WayDraft = Omit<WayRow, "id" | "serviceId" | "businessId" | "version">;

/**
 * Refuses a way whose money breaks K-25 v1's rules, its CHECKs and those it leaves to code (rule 9), and CQ-128 (1):
 *   - its place and location (video alone has none), and its path one of the master's 28 for its flow;
 *   - a path its kind's plug-in offers in that flow (K-24 kind_flows.combos), and with the kind's `nomoney` fact one that
 *     takes no money (default 2);
 *   - a deposit only on a deposit path and there exactly one of deposit_cents and deposit_percent: never both, on any
 *     path (CQ-128 (1): K-25 v1's CHECK lets a non-deposit path hold both; code refuses it until K-25 v1.1 does);
 *   - a fee only on a path that takes something before, and one on every card or full path but sensitive work's;
 *   - a currency exactly with an amount, the business's one; one form of free-cancel time; a tip line only on a bill.
 */
export function checkWayMoney(way: WayDraft, kind: BusinessKind, currency: string): void {
  if ((way.place === "customer") !== (way.flow === "B")) refuse("badInput", ["flow"]);
  if ((way.place === "video") !== (way.locationId === null)) refuse("badInput", ["locationId"]);
  if (!PATHS[way.flow].includes(way.path)) refuse("pathUnknown", ["path"]);
  if (!kind.paths[way.flow].includes(way.path)) refuse("pathNotOffered", ["path"]);
  const [, before, after] = way.path.split("|");
  if (
    kind.facts.includes("nomoney") &&
    (before !== "none" || !["none", "counter", "own"].includes(after ?? ""))
  )
    refuse("noMoneyPath", ["path"]);

  const deposits = [way.depositCents, way.depositPercent].filter((amount) => amount !== null).length;
  if (before === "deposit" ? deposits !== 1 : deposits !== 0)
    refuse("depositNotOnPath", ["depositCents", "depositPercent"]);
  if (way.depositCents !== null) requireCents(way.depositCents, "depositCents", 1);
  if (way.depositPercent !== null) {
    const percent = requireCents(way.depositPercent, "depositPercent", 1);
    if (percent > 99) refuse("badInput", ["depositPercent"]);
  }

  if (way.feeCents !== null) {
    requireCents(way.feeCents, "feeCents", 1);
    if (before === "none") refuse("feeOnNothingTaken", ["feeCents"]);
  }
  const sensitive = (way.flow === "A" ? kind.switchesA : kind.switchesB).includes("sensitive");
  if ((before === "card" || before === "full") && way.feeCents === null && !sensitive)
    refuse("feeMissing", ["feeCents"]);

  const amounts = way.depositCents !== null || way.feeCents !== null;
  if (amounts !== (way.currency !== null)) refuse("badInput", ["currency"]);
  if (way.currency !== null) requireCurrency(way.currency, "currency", currency);

  if (way.cutoffBeforeMinutes !== null && way.cutoffDayBeforeAt !== null)
    refuse("twoCutoffs", ["cutoffBeforeMinutes", "cutoffDayBeforeAt"]);
  if (way.cutoffBeforeMinutes !== null) requireMinutes(way.cutoffBeforeMinutes, "cutoffBeforeMinutes");
  if (way.cutoffDayBeforeAt !== null) requireClock(way.cutoffDayBeforeAt, "cutoffDayBeforeAt");
  if (way.tipLine !== null && after !== "bill") refuse("tipLineNotOnBill", ["tipLine"]);
}

/** A way's columns as K-25 v1 service_money names them. */
export function wayValues(way: WayDraft): Record<string, unknown> {
  return {
    flow: way.flow,
    place: way.place,
    location_id: way.locationId,
    path: way.path,
    deposit_cents: way.depositCents,
    deposit_percent: way.depositPercent,
    fee_cents: way.feeCents,
    currency: way.currency,
    cutoff_before: way.cutoffBeforeMinutes === null ? null : interval(way.cutoffBeforeMinutes),
    cutoff_day_before_at: way.cutoffDayBeforeAt,
    tip_line: way.tipLine,
    active: way.active,
  };
}

// ---- a price rule's conditions (K-25 price_rules) -----------------------------------------------------------------------

/** Refuses days that are not K-25's form (one to six ISO weekday digits in order), or null. */
function weekdaysOrNull(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !WEEKDAYS.test(value) || value.length < 1 || value.length > 6)
    return refuse("badInput", [field]);
  return value;
}

/** Refuses conditions out of K-25's forms: one form per condition, so like is compared with like. */
export function checkConditions(conditions: PriceConditions): PriceConditions {
  const serviceMoneyId = idOrNull(conditions.serviceMoneyId, "conditions.serviceMoneyId");
  const workerResourceId = idOrNull(conditions.workerResourceId, "conditions.workerResourceId");
  const weekdays = weekdaysOrNull(conditions.weekdays, "conditions.weekdays");
  const fromTime =
    conditions.fromTime === null ? null : requireClock(conditions.fromTime, "conditions.fromTime");
  const untilTime =
    conditions.untilTime === null ? null : requireClock(conditions.untilTime, "conditions.untilTime");
  // A day's start or end is no clock condition (K-25 price_rules_times_form).
  if (fromTime !== null && clockSeconds(fromTime) === 0) refuse("badInput", ["conditions.fromTime"]);
  if (untilTime !== null && clockSeconds(untilTime) === 0) refuse("badInput", ["conditions.untilTime"]);
  if (
    fromTime !== null &&
    untilTime !== null &&
    (clockSeconds(fromTime) ?? 0) >= (clockSeconds(untilTime) ?? 0)
  )
    refuse("badInput", ["conditions.untilTime"]);
  return { serviceMoneyId, workerResourceId, weekdays, fromTime, untilTime };
}

// ---- the writes -----------------------------------------------------------------------------------------------------

/** The tables the catalog writes, and how. */
const CATALOG_TABLES: Readonly<Record<string, "versioned" | "insertOnly" | "snapshot">> = {
  company_kinds: "versioned",
  services: "versioned",
  service_money: "versioned",
  price_rules: "versioned",
  price_rule_ties: "versioned",
  item_services: "insertOnly",
  booking_terms: "snapshot",
  booking_terms_rules: "snapshot",
};

/**
 * Holds one write to what the catalog may write (the module header), or refuses it: a table it does not write, a
 * delete, a snapshot updated, a price edited in place, a version set by hand.
 */
export function checkCatalogWrite(write: StateWrite): StateWrite {
  const given: unknown = write;
  const op = typeof given === "object" && given !== null ? (given as { op?: unknown }).op : undefined;
  const kind = CATALOG_TABLES[write.table];
  if (kind === undefined) return refuse("notCatalogWrite", [write.table]);
  if (op === "insert") return write;
  if (op !== "update" || write.op !== "update") return refuse("notCatalogWrite", [write.table]);
  if (kind === "snapshot") return refuse("snapshotImmutable", [write.table]);
  if (kind === "insertOnly") return refuse("notCatalogWrite", [write.table]);
  requireVersion(write.expectVersion, `${write.table}.expectVersion`);
  const columns = Object.keys(write.set);
  if (columns.includes("version")) refuse("notCatalogWrite", [`${write.table}.version`]);
  if (write.table === "price_rules" && columns.some((column) => column !== "effective_to"))
    refuse("notCatalogWrite", ["price_rules.set"]);
  return write;
}

/** An insert of one row (K-05 v1 stateWrite), checked; a column left out takes its default (its version 1). */
export function insert(table: string, values: Readonly<Record<string, unknown>>): StateWrite {
  return checkCatalogWrite({ op: "insert", table, values: { ...values } });
}

/** An update of one row by its id, naming the version read (K-05 v1 stateWrite; limit 4), checked. */
export function update(
  table: string,
  id: string,
  expectVersion: number,
  set: Readonly<Record<string, unknown>>,
): StateWrite {
  return checkCatalogWrite({ op: "update", table, key: { id }, expectVersion, set: { ...set } });
}

/** An update of a row keyed by more than its id (K-23 company_kinds: company and kind), checked. */
export function updateByKey(
  table: string,
  key: Readonly<Record<string, unknown>>,
  expectVersion: number,
  set: Readonly<Record<string, unknown>>,
): StateWrite {
  return checkCatalogWrite({ op: "update", table, key: { ...key }, expectVersion, set: { ...set } });
}
