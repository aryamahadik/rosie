// The catalog's cross-row checks (C-096; T-1433; K-25 v1 rule 9; K-05 v1.18 CQ-349 rulings (2) and (4); T-320's security
// notes N1): each rule across rows that the database does not hold alone, made by the service before any write, from
// what its reads answer (reads.ts). Each refusal names its rule (errors.ts), and a refused call writes nothing.
//   (a) depositOverPrice      a deposit is never over the price known then: the way's price rules in effect at or after
//                             the save, its place's rules, else the service's own (README ruling 4 (a)); on a list path
//                             each rule's price, on a visit path each rule's starting price (A4-13: "never more than the
//                             starting price"). A percent is under the price by its form (1 to 99), and a photos path's
//                             deposit is checked against its quote at booking (K-30), so neither is checked here. The same
//                             check at a price's save: a rule never prices a way under its deposit (read 3).
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
import { inEffectAt, isEmpty, rangeOf } from "./prices";
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
 * The rules that price a way, of `rules` (those in effect at or after the time read): its place's, else the service's
 * own (README ruling 4 (a)); a price withdrawn before it started holds no instant and prices nothing.
 */
export function rulesPricing(wayId: string, rules: readonly PriceRuleRow[]): PriceRuleRow[] {
  const live = rules.filter((rule) => !isEmpty(rangeOf(rule)));
  const placed = live.filter((rule) => rule.conditions.serviceMoneyId === wayId);
  return placed.length > 0 ? placed : live.filter((rule) => rule.conditions.serviceMoneyId === null);
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

/**
 * (a) An active way's deposit in cents is never over the price known then by any rule that prices it (`rules`, in effect
 * at or after its save): on a list path each rule's price, on a visit path each rule's starting price, and a visit path
 * with no starting price known takes no deposit (fails closed). `fields` name what the refusal blames: the deposit at the
 * way's save, the price at the price's.
 */
export function checkDeposit(
  way: Pick<WayRow, "id" | "path" | "active" | "depositCents" | "currency">,
  rules: readonly PriceRuleRow[],
  fields: readonly string[],
): void {
  const deposit = way.depositCents;
  const priced = pricedBy(way.path);
  if (deposit === null || !way.active || (priced !== "list" && priced !== "visit")) return;
  const pricing = rulesPricing(way.id, rules);
  if (priced === "visit" && pricing.length === 0) refuse("depositOverPrice", fields);
  for (const rule of pricing) {
    if (rule.currency !== way.currency) refuse("currencyMismatch", ["currency"]);
    const known = priced === "list" ? rule.priceCents : rule.fromCents;
    if (known === null || deposit > known) refuse("depositOverPrice", fields);
  }
}

/**
 * (a) at a price's save: every active way the new rule prices among `rulesAfter` (the service's rules as the save leaves
 * them, the new one among them) keeps its deposit under the new rule's known price (README ruling 4 (a), read 3).
 */
export function checkDepositsUnder(
  rule: PriceRuleRow,
  ways: readonly WayRow[],
  rulesAfter: readonly PriceRuleRow[],
): void {
  for (const way of ways) {
    if (!rulesPricing(way.id, rulesAfter).some((each) => each.id === rule.id)) continue;
    checkDeposit(way, [rule], pricedBy(way.path) === "visit" ? ["fromCents"] : ["priceCents"]);
  }
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
