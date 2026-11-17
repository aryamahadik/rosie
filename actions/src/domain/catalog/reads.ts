// The catalog's reads (C-096, T-320; DL-888; widened by T-1433): a port the caller hands in by name, with no default
// reader. T-1427 added the five list reads as K-05 v1.18 (items 72 to 76), T-1428 built them in db/repo and T-1429 bound
// this port to them (pg/). T-1433 widens it, as K-05 v1.18 item 72 and the CQ-349 rulings ask: read 1 carries the
// business's setup (no_money, null read as the closed side), item 77's names and the kind_flows rows' versions; and three
// reads of a row of the business by its id (a way's location, a rule's worker, a linked space), which K-05 v1.2
// readTurnState's facts answer under the call's business with T-667's setup homes (README ruling 4 (c) and (d)), so the
// catalog's cross-row checks can be made before any write (checks.ts). Until a reader is bound, every call of the service
// answers notBuilt and writes nothing (fails closed): there is no stand-in that answers "none".
//
// Each read runs under the call's business scope (row-level security leaves the call's business only: arch 10 line 546;
// K-04 v1 rule 4), on the primary and uncached, as every decision reads (arch 10 line 538), and answers each row with its
// version (limit 4). The service still refuses a row of another business, or of another service than the one asked
// (otherBusiness, badRead), so a leaky reader fails closed too. No read answers a person's words, a number or an address.

import type {
  Flow,
  KindsRead,
  LocationRow,
  PlaceOrThingRow,
  PriceRulesRead,
  ResourceRow,
  ServiceRow,
  TermsSources,
  WayRow,
} from "./types";

export interface CatalogReads {
  /**
   * (1) The business's kinds of work: K-23 company_kinds of the business, each with K-24 kind_flows' combos per flow
   * (the money-path check, K-25 rule 9), item 77's names and the flows' versions, and the business's K-23
   * business_setup.no_money with its version, or null when it has no setup row (README item 72; CQ-349 (2)).
   */
  kindsOf(businessId: string): Promise<KindsRead>;
  /** (2) The business's services (K-25 services: kind, price kind, unit, length, position, active, version). */
  servicesOf(businessId: string): Promise<readonly ServiceRow[]>;
  /** (3) A service's ways (K-25 service_money), every one, offered or not. */
  waysOf(businessId: string, serviceId: string): Promise<readonly WayRow[]>;
  /**
   * (4) A service's price rules with their conditions in effect at or after `at` (a UTC instant: effective_to null or
   * after it), and the service's price_rule_ties: what a change closes, and what a new rule must not overlap.
   */
  priceRulesOf(businessId: string, serviceId: string, at: string): Promise<PriceRulesRead>;
  /**
   * (5) A terms snapshot's sources at `at`: K-23 flow_defaults of the flow (with item 77's name), and the K-26 rules and
   * price_ok_limits of the business, at least every row in force at `at` (the service keeps those whose scope covers the
   * booking).
   */
  termsSourcesOf(businessId: string, flow: Flow, at: string): Promise<TermsSources>;
  /**
   * (6) A K-23 locations row of the business by its id (its kind and travel area), or null when the business's scope
   * shows no location by that id: another business's, or none (K-05 v1.2 readTurnState answers notFound; ruling 4 (c)).
   */
  locationOf(businessId: string, locationId: string): Promise<LocationRow | null>;
  /**
   * (7) A K-04 resources row of the business by its id (its kind and whether it is active), or null when the business's
   * scope shows none by that id (ruling 4 (d): a price rule's worker).
   */
  resourceOf(businessId: string, resourceId: string): Promise<ResourceRow | null>;
  /**
   * (8) A K-23 places_or_things row of the business by its id (its kind), or null when the business's scope shows none
   * by that id (T-320 N1: the space a link names, read instead of trusted).
   */
  placeOrThingOf(businessId: string, placeOrThingId: string): Promise<PlaceOrThingRow | null>;
}
