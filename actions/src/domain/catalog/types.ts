// What the catalog and pricing service (C-096, T-320) reads and gives. Every row it reads is one of the five reads its
// port answers (reads.ts): K-23 v1's company_kinds and flow_defaults (contracts/db-schema/business-setup), K-24 v1's
// kind_flows (kinds-of-work), K-25 v1's services, service_money, price_rules and price_rule_ties (services-prices) and
// K-26 v1's rules and price_ok_limits (rules). Every row it writes is one of those parts' or K-30 v1's terms snapshot
// (bookings-changes: booking_terms, booking_terms_rules), as a K-05 v1 stateWrite: an insert, or an update that names the
// version it read (limit 4). Nothing is ever deleted (K-25 rule 6; CQ-128 (2)).
//
// Money is whole cents with its currency (CQ-09), never a decimal. Instants are UTC ending in Z. A span (a service's
// length, a free-cancel time) is whole minutes, written as PostgreSQL interval text ("120 minutes"); a clock time is
// "HH:MM" or "HH:MM:SS". Ids are opaque strings code makes (CQ-09).

import type { RowRef, StateWrite } from "../../commit";

/** K-04 v1 bookings.flow: A, the customer comes to the business; B, the business goes to the customer. */
export type Flow = "A" | "B";

/** K-25 v1 services.price_kind: what the price counts (S1-12's four). */
export const PRICE_KINDS = ["one_price", "per_hour", "per_unit", "by_answers"] as const;
export type PriceKind = (typeof PRICE_KINDS)[number];

/** K-25 v1 service_money.place: where the service happens on a way (FS row L01). */
export const PLACES = ["business", "customer", "meeting_spot", "video"] as const;
export type Place = (typeof PLACES)[number];

// ---- the rows the five reads answer --------------------------------------------------------------------------------

/**
 * A kind's K-24 v1 kind_flows row in one flow, by its K-05 v1.18 item 77 name (`<kind id>/<flow>`) and version (README
 * item 72, default 155): the row a way that rests on one of its paths names at the version read (limit 4).
 */
export interface KindFlowRow {
  readonly rowId: string;
  readonly flow: Flow;
  readonly version: number;
}

/**
 * One of the business's kinds of work (read 1): its K-23 v1 company_kinds row, with the money paths K-24 v1 kind_flows'
 * combos say the trade really uses in each flow (empty for a drafted kind not yet reviewed, which then offers none).
 */
export interface BusinessKind {
  /**
   * K-05 v1.18 item 77's name of its company_kinds row, `<company id>/<kind id>`, as the database builds it (never split):
   * what a write that rests on the kind names in its version reads (README item 72; CQ-349 (1)).
   */
  readonly rowId: string;
  readonly companyId: string;
  /** The profession file's id (K-24 kinds.id), such as barber. */
  readonly kindId: string;
  readonly businessId: string;
  /** Its own trade name, such as Lee Plumbing; null: the business's name. */
  readonly tradeName: string | null;
  /** pf_facts: the plug-in's facts for this kind (the `nomoney` fact among them). */
  readonly facts: readonly string[];
  /** pf_switches_a and pf_switches_b: the plug-in switches on in each flow (`sensitive` among them). */
  readonly switchesA: readonly string[];
  readonly switchesB: readonly string[];
  /** company_kinds.version as read. */
  readonly version: number;
  /** K-24 kind_flows.combos per flow: the only money paths a way of this kind may take (S1-13; K-25 rule 9). */
  readonly paths: { readonly A: readonly string[]; readonly B: readonly string[] };
  /** The kind_flows rows those paths come from, flow A then B, by name and version; none for a drafted kind. */
  readonly flows: readonly KindFlowRow[];
}

/**
 * The business's K-23 v1 business_setup row as read 1 answers it (README item 72; CQ-349 (2)): its no money through
 * Rosie (M02) alone, with the row's key and version, so a way's money path is checked against it (K-25 rule 9) and a
 * commit compares that version (limit 4).
 */
export interface BusinessSetup {
  readonly businessId: string;
  readonly noMoney: boolean;
  readonly version: number;
}

/** Read 1: the business's kinds of work and its setup's no money, one moment's (README item 72). */
export interface KindsRead {
  /**
   * The business's setup, or null when it has no setup row yet: not known, read as the closed side, no money through
   * Rosie, never as money allowed (K-05 v1.18 default 161).
   */
  readonly setup: BusinessSetup | null;
  readonly kinds: readonly BusinessKind[];
}

/** K-23 v1 locations.kind: where a way's place is (K-23 locations_kind_known). */
export type LocationKind = "shop" | "office" | "meeting_spot";

/**
 * A K-23 v1 locations row of the business, as K-05 v1.2 readTurnState's facts read it by id under the call's business
 * (T-667's setup homes; K-05 v1.18 ruling 4 (c)): its kind and travel area, with its version. Never its address or map
 * point.
 */
export interface LocationRow {
  readonly id: string;
  readonly businessId: string;
  readonly kind: LocationKind;
  /** The travel area's miles from this shop or office, or null when it has none (only a shop or office has one). */
  readonly travelMiles: number | null;
  readonly version: number;
}

/**
 * A K-04 v1 resources row of the business, as readTurnState's facts read it by id under the call's business (K-05 v1.18
 * ruling 4 (d)): its kind (worker, room, vehicle, class_session) and whether it is active. Never its name.
 */
export interface ResourceRow {
  readonly id: string;
  readonly businessId: string;
  readonly kind: string;
  readonly active: boolean;
  readonly version: number;
}

/**
 * A K-23 v1 places_or_things row of the business, as readTurnState's facts read it by id under the call's business
 * (T-320 N1; default 11 withdrawn): its kind (space or thing). Never its name.
 */
export interface PlaceOrThingRow {
  readonly id: string;
  readonly businessId: string;
  readonly kind: string;
  readonly version: number;
}

/** A K-25 v1 services row (read 2). Its extras are not read: no code reads a sub-key (K-25 README). */
export interface ServiceRow {
  readonly id: string;
  readonly businessId: string;
  readonly kindId: string;
  readonly name: string;
  readonly priceKind: PriceKind;
  /** For per_unit, what one unit is (such as night); null otherwise. */
  readonly unit: string | null;
  /** services.length in whole minutes. */
  readonly lengthMinutes: number;
  readonly position: number;
  readonly active: boolean;
  readonly version: number;
}

/** A K-25 v1 service_money row: one way per service and place (read 3). */
export interface WayRow {
  readonly id: string;
  readonly serviceId: string;
  readonly businessId: string;
  readonly flow: Flow;
  readonly place: Place;
  /** The shop, office or meeting spot (K-23 locations.id); null only for video. */
  readonly locationId: string | null;
  /** price|before|after, one of the master's 28 for the flow. */
  readonly path: string;
  readonly depositCents: number | null;
  readonly depositPercent: number | null;
  readonly feeCents: number | null;
  readonly currency: string | null;
  /** The way's own free-cancel time before the visit, in whole minutes; null: none of its own in this form. */
  readonly cutoffBeforeMinutes: number | null;
  /** Or its own free-cancel clock time the day before, "HH:MM"; null: none of its own in this form. */
  readonly cutoffDayBeforeAt: string | null;
  readonly tipLine: boolean | null;
  readonly active: boolean;
  readonly version: number;
}

/** A price rule's conditions (K-25 v1 price_rules: place, worker, time); none set: the service's own price. */
export interface PriceConditions {
  /** The place: a way of this service (service_money.id). */
  readonly serviceMoneyId: string | null;
  /** The worker: the person giving the work, as their worker resource (K-04 resources.id). */
  readonly workerResourceId: string | null;
  /** The days, as ISO weekday digits in order (1 Monday to 7 Sunday), such as 67; null: every day. */
  readonly weekdays: string | null;
  /** From this clock time, "HH:MM"; null: the day's start. */
  readonly fromTime: string | null;
  /** Until this clock time, not included; null: the day's end. */
  readonly untilTime: string | null;
}

/** No condition: the service's own price. */
export const NO_CONDITIONS: PriceConditions = {
  serviceMoneyId: null,
  workerResourceId: null,
  weekdays: null,
  fromTime: null,
  untilTime: null,
};

/** A K-25 v1 price_rules row (read 4). */
export interface PriceRuleRow {
  readonly id: string;
  readonly businessId: string;
  readonly serviceId: string;
  readonly conditions: PriceConditions;
  readonly priceCents: number;
  readonly fromCents: number | null;
  readonly currency: string;
  readonly setByPersonId: string;
  readonly effectiveFrom: string;
  /** Null: in effect. Equal to effectiveFrom: withdrawn before it started, an empty range that prices no visit. */
  readonly effectiveTo: string | null;
  readonly version: number;
}

/** A K-25 v1 price_rule_ties row (read 4): a possible tie, and the owner's answer once given. */
export interface PriceTieRow {
  readonly id: string;
  readonly businessId: string;
  readonly serviceId: string;
  readonly firstRuleId: string;
  readonly secondRuleId: string;
  readonly askedAt: string;
  readonly winnerRuleId: string | null;
  readonly answeredAt: string | null;
  readonly answeredByPersonId: string | null;
  readonly version: number;
}

/** Read 4: a service's price rules in effect at or after a time, and its ties. */
export interface PriceRulesRead {
  readonly rules: readonly PriceRuleRow[];
  readonly ties: readonly PriceTieRow[];
}

/** K-23 v1 flow_defaults: the business's default free-cancel time in one flow (H06). */
export interface FlowDefault {
  /**
   * K-05 v1.18 item 77's name of the row, `<business id>/<flow>`, as the database builds it: what a snapshot that copies
   * the default names in its version reads (README item 77, CQ-349 (1)).
   */
  readonly rowId: string;
  readonly businessId: string;
  readonly flow: Flow;
  readonly cutoffBeforeMinutes: number | null;
  readonly cutoffDayBeforeAt: string | null;
  readonly version: number;
}

/** A K-26 v1 rules row or price_ok_limits row, as a terms snapshot names it (never its value: K-30 default 11). */
export interface ScopedRow {
  readonly id: string;
  readonly businessId: string;
  /** Null: both flows. */
  readonly flow: Flow | null;
  /** Null: all the business's kinds. */
  readonly kindId: string | null;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly version: number;
}

/** Read 5: what a terms snapshot copies or names (K-30 v1 booking_terms, booking_terms_rules). */
export interface TermsSources {
  /** The business's default free-cancel time in the flow, or null when it has none there. */
  readonly flowDefault: FlowDefault | null;
  /** K-26 rules rows: at least every row in force at the time asked. */
  readonly rules: readonly ScopedRow[];
  /** K-26 price_ok_limits rows: at least every row in force at the time asked. */
  readonly priceOkLimits: readonly ScopedRow[];
}

// ---- what the service gives -----------------------------------------------------------------------------------------

/**
 * What a call of the service writes in the turn's one commit: the rows its decision rests on at the versions read
 * (limit 4), and its rows as K-05 v1 stateWrites (an insert, or an update naming the version read). They go into the
 * part's UnitWrites (T-305: `versionsRead`, `state`).
 */
export interface CatalogWrites {
  readonly versionsRead: readonly RowRef[];
  readonly state: readonly StateWrite[];
}

/** A row written, with what the commit carries for it. */
export interface Built {
  /** The row's id (for a link, its space and service; for a snapshot, its booking). */
  readonly id: string;
  readonly writes: CatalogWrites;
}

/** A price change: the rule it closed, the rule it opened, and any tie the new rule makes. */
export interface PriceChange {
  /** The rule closed at the change's instant (its end date), or null when none was in effect then. */
  readonly closedRuleId: string | null;
  /** The rule opened at that instant, or null when nothing opens (a price closed, or withdrawn with none to take over). */
  readonly openedRuleId: string | null;
  /** Ties the opened rule makes with rules of as many conditions that can both apply (the read-back asks which wins). */
  readonly tieIds: readonly string[];
  readonly writes: CatalogWrites;
}

/** A terms snapshot (K-30 v1 booking_terms and booking_terms_rules), frozen once taken. */
export interface TermsSnapshot {
  readonly bookingId: string;
  readonly flow: Flow;
  readonly kindId: string;
  readonly writtenAt: string;
  readonly termsConsentId: string | null;
  readonly termsVersion: string;
  readonly termsLanguage: string;
  readonly noticesShown: readonly string[];
  /** The cancel rule copied in: the way's own, else the flow's default, else none (a job sent now). */
  readonly cutoff: {
    readonly from: "way" | "flowDefault" | "none";
    readonly beforeMinutes: number | null;
    readonly dayBeforeAt: string | null;
    /** The IANA zone dayBeforeAt is read in; set exactly with it. */
    readonly zone: string | null;
  };
  /** The K-26 rules in force at writtenAt for the booking's flow and kind of work, by id. */
  readonly ruleIds: readonly string[];
  /** The K-26 price OK limits in force then, by id. */
  readonly priceOkLimitIds: readonly string[];
  readonly writes: CatalogWrites;
}
