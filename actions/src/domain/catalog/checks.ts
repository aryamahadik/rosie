// The catalog's cross-row checks (C-096; T-1433; K-25 v1 rule 9; K-05 v1.18 CQ-349 rulings (2) and (4); T-320's security
// notes N1): each rule across rows that the database does not hold alone, made by the service before any write, from
// what its reads answer (reads.ts). Each refusal names its rule (errors.ts), and a refused call writes nothing.
//   (a) depositOverPrice      a deposit is never over the price known then: the way's price rules in effect at or after
//                             the save, its place's rules, else the service's own (README ruling 4 (a)), at each instant
//                             and for each booking (rulesPricing); on a list path each rule's price, on a visit path each
//                             rule's starting price (A4-13: "never more than the starting price"). A percent is under the
//                             price by its form (1 to 99), and a photos path's deposit is checked against its quote at
//                             booking (K-30), so neither is checked here. The same check at a price's save (an add, a
//                             change, a withdrawal or a close): no rule the save leaves pricing a way, and not pricing it
//                             before, is under its deposit (read 3).
//   (b) noPriceInEffect       a list-priced way has a price rule of its place or of the service in effect at its save.
//   (c) locationNotOnBusiness a way's location is one of the business's (a location of another business, or none, reads
//                             as null under the call's scope);
//       locationNotOfPlace    and of its place's kind: a shop or office for the business's place, a meeting spot for a
//                             meeting spot, one with a travel area for the customer's place (S1-43).
//       workerNotOnBusiness   a price rule's worker is a worker resource of the business.
//   (d) companyNotOnBusiness  a kind placed on the business is under the business's one company (K-23 companies_business_key:
//                             one company per business), as read 1 names it on the business's kinds.
//   (e) spaceNotOnBusiness    the space or thing a link names is the business's, as read, never as the caller says.
//   (h) noMoneyPath           with the business's no money through Rosie (K-23 business_setup.no_money, M02), or with no
//                             setup row yet (null, read as the closed side: K-05 v1.18 default 161), a way's path takes no
//                             money: nothing before, and after counter (A) or own (B) or none.
// Only active ways are held to (a) and (b): an inactive way is offered for no new booking, so it can be stopped whatever
// its prices (default). Money is whole cents compared as read, never rounded or converted; a price in another currency
// than the way's is refused (currencyMismatch), never compared.

import { refuse } from "./errors";
import { inEffectAt, isEmpty, rangeOf, sameConditions } from "./prices";
import { takesNoMoney } from "./rows";
import type {
  BusinessKind,
  BusinessSetup,
  LocationKind,
  LocationRow,
  Place,
  PlaceOrThingRow,
  PriceRuleRow,
  ResourceRow,
  WayRow,
} from "./types";

/** How a way's price is known: a list price, a quote from photos, or at the visit (K-25 service_money.path's first part). */
function pricedBy(path: string): string {
  return path.split("|")[0] ?? "";
}

/** (h) With no money through Rosie, or no setup row yet (the closed side), only a path that takes no money. */
export function checkBusinessMoney(path: string, setup: BusinessSetup | null): void {
  if ((setup === null || setup.noMoney) && !takesNoMoney(path)) refuse("noMoneyPath", ["path", "noMoney"]);
}

/** The location kinds the business's place and a meeting spot take (K-25 rule 9; K-23 locations_kind_known). */
const PLACE_KINDS: Readonly<Record<Exclude<Place, "customer" | "video">, readonly LocationKind[]>> = {
  business: ["shop", "office"],
  meeting_spot: ["meeting_spot"],
};

/**
 * (c) A way's location is the business's, as read under its scope (`location` null: none of the business's has the id),
 * and of its place's kind. A way at video names none (rows.ts checkWayMoney holds that).
 */
export function checkLocation(
  place: Place,
  locationId: string | null,
  location: LocationRow | null,
  businessId: string,
): void {
  if (locationId === null) return;
  if (location?.id !== locationId || location.businessId !== businessId)
    refuse("locationNotOnBusiness", ["locationId"]);
  const fits =
    place === "customer"
      ? location.travelMiles !== null && location.travelMiles > 0
      : place === "video"
        ? false
        : PLACE_KINDS[place].includes(location.kind);
  if (!fits) refuse("locationNotOfPlace", ["place", "locationId"]);
}

/**
 * Whether rules of the way's place with a service rule's other conditions (its worker, days and clock times) cover the
 * service rule's dates from `fromMs` on: there, for every booking it would price at the way, a rule of the place with one
 * condition more is in effect and wins (K-25 "How a price is found": the most conditions set win).
 */
function placeCovers(
  rule: PriceRuleRow,
  placed: readonly PriceRuleRow[],
  wayId: string,
  fromMs: number,
): boolean {
  const atPlace = { ...rule.conditions, serviceMoneyId: wayId };
  const ranges = placed
    .filter((each) => sameConditions(each.conditions, atPlace))
    .map(rangeOf)
    .sort((a, b) => a.from - b.from);
  const own = rangeOf(rule);
  let from = Math.max(own.from, fromMs);
  for (const range of ranges) {
    if (own.to !== null && from >= own.to) return true;
    if (range.from > from) return false;
    if (range.to === null) return true;
    from = Math.max(from, range.to);
  }
  return own.to !== null && from >= own.to;
}

/**
 * The rules that price a way at some instant from `fromMs` (its save) on, of `rules` (those in effect at or after it):
 * every rule of its place, and every rule of the service's own but one its place's rules cover there (README ruling
 * 4 (a): "its place's rule, else the service's own", at each instant and for each booking: a place's price set for a
 * later date, or on some days only, leaves the service's own pricing the way meanwhile). A price withdrawn before it
 * started holds no instant and prices nothing.
 */
export function rulesPricing(wayId: string, rules: readonly PriceRuleRow[], fromMs: number): PriceRuleRow[] {
  const live = rules.filter((rule) => !isEmpty(rangeOf(rule)));
  const placed = live.filter((rule) => rule.conditions.serviceMoneyId === wayId);
  const own = live.filter(
    (rule) => rule.conditions.serviceMoneyId === null && !placeCovers(rule, placed, wayId, fromMs),
  );
  return [...placed, ...own];
}

/** (b) An active list-priced way has a price rule of its place or of the service in effect at `atMs`, its save. */
export function checkListPriced(
  way: Pick<WayRow, "id" | "path" | "active">,
  rules: readonly PriceRuleRow[],
  atMs: number,
): void {
  if (!way.active || pricedBy(way.path) !== "list") return;
  const priced = rules.some(
    (rule) =>
      (rule.conditions.serviceMoneyId === null || rule.conditions.serviceMoneyId === way.id) &&
      inEffectAt(rule, atMs),
  );
  if (!priced) refuse("noPriceInEffect", ["path"]);
}

/** The way's deposit in cents when (a) holds it: an active way's on a list or visit path; else null (nothing to hold). */
function heldDeposit(way: Pick<WayRow, "path" | "active" | "depositCents">): number | null {
  const priced = pricedBy(way.path);
  return way.active && (priced === "list" || priced === "visit") ? way.depositCents : null;
}

/** (a) A deposit is never over a rule's known price: a list path's price, a visit path's starting price (A4-13). */
function checkUnder(
  way: Pick<WayRow, "path" | "currency">,
  deposit: number,
  pricing: readonly PriceRuleRow[],
  fields: readonly string[],
): void {
  for (const rule of pricing) {
    if (rule.currency !== way.currency) refuse("currencyMismatch", ["currency"]);
    const known = pricedBy(way.path) === "list" ? rule.priceCents : rule.fromCents;
    if (known === null || deposit > known) refuse("depositOverPrice", fields);
  }
}

/**
 * (a) An active way's deposit in cents is never over the price known then by any rule that prices it from `fromMs` (its
 * save) on (`rules`, in effect at or after it; rulesPricing): on a list path each rule's price, on a visit path each
 * rule's starting price, and a visit path with no starting price known takes no deposit (fails closed). `fields` name
 * what the refusal blames: the deposit at the way's save.
 */
export function checkDeposit(
  way: Pick<WayRow, "id" | "path" | "active" | "depositCents" | "currency">,
  rules: readonly PriceRuleRow[],
  fromMs: number,
  fields: readonly string[],
): void {
  const deposit = heldDeposit(way);
  if (deposit === null) return;
  const pricing = rulesPricing(way.id, rules, fromMs);
  if (pricedBy(way.path) === "visit" && pricing.length === 0) refuse("depositOverPrice", fields);
  checkUnder(way, deposit, pricing, fields);
}

/**
 * (a) at a price's save (README ruling 4 (a), read 3): every active way of the service keeps its deposit under each rule
 * that prices it from `fromMs` (the save) on among `rulesAfter` (the service's rules as the save leaves them) and did
 * not among `rulesBefore` (as read): the rule an add or a change opens, the price a withdrawal opens again, or a
 * service's own price a closed or withdrawn price of the way's place no longer covers. A rule that priced the way before
 * was held at its own save. `fieldsOf` names what the refusal blames for a way.
 */
export function checkDepositsUnder(
  ways: readonly WayRow[],
  rulesBefore: readonly PriceRuleRow[],
  rulesAfter: readonly PriceRuleRow[],
  fromMs: number,
  fieldsOf: (way: WayRow) => readonly string[],
): void {
  for (const way of ways) {
    const deposit = heldDeposit(way);
    if (deposit === null) continue;
    const before = new Set(rulesPricing(way.id, rulesBefore, fromMs).map((rule) => rule.id));
    const newly = rulesPricing(way.id, rulesAfter, fromMs).filter((rule) => !before.has(rule.id));
    checkUnder(way, deposit, newly, fieldsOf(way));
  }
}

/** What a price's own save blames for a way: the starting price on a visit path, else the price. */
export function priceFieldsOf(way: Pick<WayRow, "path">): readonly string[] {
  return pricedBy(way.path) === "visit" ? ["fromCents"] : ["priceCents"];
}

/** (c) A price rule's worker is a worker resource of the business, as read under its scope (null: none of its). */
export function checkWorker(
  workerResourceId: string | null,
  resource: ResourceRow | null,
  businessId: string,
): void {
  if (workerResourceId === null) return;
  if (resource?.id !== workerResourceId || resource.businessId !== businessId || resource.kind !== "worker")
    refuse("workerNotOnBusiness", ["conditions.workerResourceId"]);
}

/**
 * (d) A kind placed on the business is under its one company: every kind the business holds (read 1, and those placed in
 * this call) names that company. A business with no kind yet names none, so the database's
 * company_kinds_company_business_fk holds the first (default).
 */
export function checkCompany(companyId: string, kinds: readonly BusinessKind[]): void {
  if (kinds.some((kind) => kind.companyId !== companyId)) refuse("companyNotOnBusiness", ["companyId"]);
}

/** (e) The space or thing a link names is the business's, as read under its scope (null: none of its). */
export function checkSpace(placeOrThingId: string, row: PlaceOrThingRow | null, businessId: string): void {
  if (row?.id !== placeOrThingId || row.businessId !== businessId)
    refuse("spaceNotOnBusiness", ["placeOrThing.id"]);
}
