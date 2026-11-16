// The catalog's five reads (C-096, T-320; DL-888): a port the caller hands in by name, with no default reader. No K-05
// call reads K-23, K-24, K-25, K-26 or K-30 rows yet (T-320 run 1's NEED): T-1427 adds the five as a K-05 minor version,
// T-1428 builds them in db/repo and T-1429 binds this port to them, as T-300's OwnerRules and T-318's SafetyReader were
// built before K-05 v1.4 had their reads. Until a reader is bound, every call of the service answers notBuilt and writes
// nothing (fails closed): there is no stand-in that answers "none".
//
// Each read runs on the call's own transaction under its business scope (row-level security leaves the call's business
// only: arch 10 line 546; K-04 v1 rule 4), on the primary and uncached, as every decision reads (arch 10 line 538), and
// answers each row with its version (limit 4). The service still refuses a row of another business, or of another service
// than the one asked (otherBusiness, badRead), so a leaky reader fails closed too. No read answers a person's words, a
// number or an address.

import type { Flow, BusinessKind, PriceRulesRead, ServiceRow, TermsSources, WayRow } from "./types";

export interface CatalogReads {
  /**
   * (1) The business's kinds of work: K-23 company_kinds of the business, each with K-24 kind_flows' combos per flow
   * (the money-path check, K-25 rule 9).
   */
  kindsOf(businessId: string): Promise<readonly BusinessKind[]>;
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
   * (5) A terms snapshot's sources at `at`: K-23 flow_defaults of the flow, and the K-26 rules and price_ok_limits of the
   * business, at least every row in force at `at` (the service keeps those whose scope covers the booking).
   */
  termsSourcesOf(businessId: string, flow: Flow, at: string): Promise<TermsSources>;
}
