// Rows and proposals for the owner rule evaluator's tests and limit 2's (T-300). Never imported by the Worker. The rules
// rows come from K-26 v1's own fixtures (contracts/db-schema/rules/fixtures: the tap list Sam kept, the note-only rule, the
// refused unknown kind) and, where a test needs a rule no fixture holds (a minimum, a notice, months offered, a cap), from
// rows made here in the fixtures' form for the same businesses and people (Lee's Barbershop, Lee Home Services, Sam Lee),
// with made-up values (rule 9). Times are the K-09 fixtures' (Fri Oct 23 2026 in America/New_York).

import { contractFile } from "../../tool-api/test-support";
import type { Money, PriceBasis, Proposal, ProposedPrice, RuleRow } from "./index";

export const BARBERSHOP = "biz-lees-barbershop";
export const HOME_SERVICES = "biz-lee-home-services";
/** The barbershop's zone and Lee Home Services' (K-04 and K-23 seeds). */
export const ZONE = "America/New_York";
/** When Sam kept the tap list (K-26 README: 2:12pm Mon Oct 19), the start of every seeded rule. */
export const TAP_LIST_KEPT = "2026-10-19T18:12:00Z";
/** K-09 commit-limit-2-owner-rule.json's now: Fri Oct 23, 9:30am in the barbershop's zone. */
export const NOW = "2026-10-23T13:30:04Z";
/** Fri Oct 23, 9:00pm in the barbershop's zone: Alex's "tonight at 9pm". */
export const TONIGHT_9PM = { utc: "2026-10-24T01:00:00Z", zone: ZONE };
/** Sat Oct 24, 11:00am in the barbershop's zone (A7-17's visit time in the master). */
export const SAT_11AM = { utc: "2026-10-24T15:00:00Z", zone: ZONE };
/** Sat Nov 14, 11:00am: K-09 commit-limit-2-owner-rule.json's booked visit. */
export const NOV_14 = { utc: "2026-11-14T16:00:00Z", zone: ZONE };
/** The start of Mon Nov 2 in the barbershop's zone: K-26's change date (S11-57). */
export const NOV_2 = "2026-11-02T05:00:00Z";

/** Whole cents in US dollars. */
export const usd = (cents: number): Money => ({ cents, currency: "USD" });

/** A proposed price in whole US cents, in ProposedPrice's form: a list price always has its amount. */
export function priceOf(
  basis: PriceBasis,
  cents: number | null,
  extras: readonly number[] = [],
): ProposedPrice {
  const price = cents === null ? null : usd(cents);
  if (basis !== "list") return { basis, price, extras: extras.map(usd) };
  if (price === null) throw new Error("a list price always has its amount (ProposedPrice)");
  return { basis, price, extras: extras.map(usd) };
}

/**
 * A price outside ProposedPrice's type, in whole US cents, as a maker that builds it without the type's help could hand
 * it over: a list price with no amount, or a basis none of the sources names. Only the tests that the evaluator cannot
 * read it, and so fails closed (the lead's ruling, DL-328), build one.
 */
export function priceOutsideType(
  basis: string,
  cents: number | null,
  extras: readonly number[] = [],
): ProposedPrice {
  const given = { basis, price: cents === null ? null : usd(cents), extras: extras.map(usd) };
  return given as unknown as ProposedPrice;
}

type Values = Readonly<Record<string, unknown>>;

function text(values: Values, key: string): string {
  const value = values[key];
  if (typeof value !== "string") throw new Error(`a K-26 rules row without ${key}`);
  return value;
}

function textOrNull(values: Values, key: string): string | null {
  const value = values[key];
  return typeof value === "string" ? value : null;
}

function numberOrNull(values: Values, key: string): number | null {
  const value = values[key];
  return typeof value === "number" ? value : null;
}

/** A K-26 v1 fixture row's values (snake_case columns) as a data-access read hands them over; its words are left out. */
export function ruleRowOf(values: Values): RuleRow {
  const on = values.value_on;
  return {
    id: text(values, "id"),
    businessId: text(values, "business_id"),
    ruleKind: text(values, "rule_kind"),
    valueType: text(values, "value_type"),
    flow: textOrNull(values, "flow"),
    kindId: textOrNull(values, "kind_id"),
    valueOn: typeof on === "boolean" ? on : null,
    valueCents: numberOrNull(values, "value_cents"),
    valueCurrency: textOrNull(values, "value_currency"),
    valueSpanMinutes: null,
    valueCount: numberOrNull(values, "value_count"),
    valueDates: null,
    effectiveFrom: text(values, "effective_from"),
    effectiveTo: textOrNull(values, "effective_to"),
  };
}

interface Fixture {
  readonly rows?: readonly { readonly table: string; readonly values: Values }[];
  readonly refused?: { readonly table: string; readonly values: Values };
}

/** The rules rows of one of K-26 v1's accepted fixtures, freshly read. */
export function k26Rows(file: string): RuleRow[] {
  const fixture = contractFile(`db-schema/rules/fixtures/${file}`) as Fixture;
  return (fixture.rows ?? []).filter((row) => row.table === "rules").map((row) => ruleRowOf(row.values));
}

/** The row one of K-26 v1's refused fixtures tries to insert, freshly read, as a read would hand it over. */
export function refusedK26Row(file: string): RuleRow {
  const fixture = contractFile(`db-schema/rules/fixtures/invalid/${file}`) as Fixture;
  if (fixture.refused === undefined) throw new Error(`${file} refuses no row`);
  return ruleRowOf(fixture.refused.values);
}

/** The values of one row of a K-26 v1 fixture, by id, with its words, freshly read. */
export function k26Values(file: string, id: string): Values {
  const fixture = contractFile(`db-schema/rules/fixtures/${file}`) as Fixture;
  const row = (fixture.rows ?? []).find((each) => each.values.id === id);
  if (row === undefined) throw new Error(`${file} has no row ${id}`);
  return row.values;
}

/** A rules row in the fixtures' form: the barbershop's, business-wide, set by Sam when he kept the tap list. */
const BASE: RuleRow = {
  id: "",
  businessId: BARBERSHOP,
  ruleKind: "",
  valueType: "",
  flow: null,
  kindId: null,
  valueOn: null,
  valueCents: null,
  valueCurrency: null,
  valueSpanMinutes: null,
  valueCount: null,
  valueDates: null,
  effectiveFrom: TAP_LIST_KEPT,
  effectiveTo: null,
};

export const onRule = (id: string, kind: string, on: boolean, more: Partial<RuleRow> = {}): RuleRow => ({
  ...BASE,
  id,
  ruleKind: kind,
  valueType: "on",
  valueOn: on,
  ...more,
});

export const moneyRule = (id: string, kind: string, cents: number, more: Partial<RuleRow> = {}): RuleRow => ({
  ...BASE,
  id,
  ruleKind: kind,
  valueType: "money",
  valueCents: cents,
  valueCurrency: "USD",
  ...more,
});

export const spanRule = (
  id: string,
  kind: string,
  minutes: number,
  more: Partial<RuleRow> = {},
): RuleRow => ({
  ...BASE,
  id,
  ruleKind: kind,
  valueType: "span",
  valueSpanMinutes: minutes,
  ...more,
});

export const countRule = (id: string, kind: string, count: number, more: Partial<RuleRow> = {}): RuleRow => ({
  ...BASE,
  id,
  ruleKind: kind,
  valueType: "count",
  valueCount: count,
  ...more,
});

export const datesRule = (
  id: string,
  kind: string,
  from: string | null,
  until: string | null,
  more: Partial<RuleRow> = {},
): RuleRow => ({ ...BASE, id, ruleKind: kind, valueType: "dates", valueDates: { from, until }, ...more });

/** The barbershop's notice: 24 hours (a made-up value; K-26 v1 kind notice). */
export const NOTICE_24H = spanRule("rule-lees-barbershop-notice", "notice", 24 * 60);

/** Lee Home Services' $250 minimum (arch 06 line 301's example; K-26 v1 kind minimum_job). */
export const MINIMUM_250 = moneyRule("rule-lee-home-services-minimum", "minimum_job", 25_000, {
  businessId: HOME_SERVICES,
});

/** A proposal at the barbershop, in flow A, made and ruled at K-09's now, with nothing set unless given. */
export function proposalOf(more: Partial<Proposal> = {}): Proposal {
  return {
    businessId: BARBERSHOP,
    businessZone: ZONE,
    flow: "A",
    kindId: null,
    rulesAt: NOW,
    madeAt: NOW,
    visitAt: null,
    price: null,
    deposit: null,
    fee: null,
    customer: null,
    ...more,
  };
}

/** A returning customer of the business, not a member who pays elsewhere, with no no-shows and no card on file. */
export const RETURNING = {
  isNew: false,
  isOwn: true,
  memberPayingElsewhere: false,
  noShows: 0,
  cardOnFile: false,
} as const;
