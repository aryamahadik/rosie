// T-728: the journey-states seed set (C-155; QUESTIONS.md M5.7, NQ-M5-7's default: "a named seed set (journey-states)
// for tests only, never part of staging's default seed run"; K-30 v1 bookings and changes and K-32 v1 money, both
// frozen: contracts/db-schema/bookings-changes and contracts/db-schema/money, their table lists, READMEs and the seed
// fixtures seed-booking-flow-a.json, seed-booking-flow-b.json, seed-quote-owner-ok.json, seed-payment-deposit.json and
// seed-pack-credits.json; K-04 v1 reservations, the saved time; build prompt 3.5: a task that needs a key depends on the
// contract field and the fixture-set seed for it; fixture set v1's test-kit/SCENARIOS.md, one test per money combo;
// build prompt rule 9). It puts demo-shop bookings in the states journeys 4 to 6 start from, so each journey lane builds
// and tests without the one before it. T-201's runner runs it as `node db/seeds/run.mjs --set journey-states`; the
// staging seed run (infra/scripts/seed-staging.sh, D-017's sets) never names it.
//
// For each money combo SCENARIOS.md lists ("### A · `list|card|counter` on acupuncturist (Follow-up treatment)": a flow, a
// money path, a demo shop and its service), four bookings, one per stage, each the shop's customer 1 booking that
// service for themselves, with ids made from the shop's id, the flow and the path (`<key>` = <shop>-<a|b>-<path with
// dashes>, the services seed's own key) and the stage:
//   request       booking-journey-<key>-request: where journey 4 starts (02-contracts section 8: request, who_for,
//                 reach_by, customer). The head at stage entry with the customer as booker, person served and payer
//                 (who_for), and the details row: the door (chat) and made by the customer, every booking value still
//                 undecided. reach_by and customer are the customers seed's own row (K-28: its way and the record).
//   time_saved    booking-journey-<key>-time-saved: where journey 5 starts (time_saved, contact or link, address). As
//                 above, plus approval, timing and times decided (A4-98, A4-15, A4-66); the line copied in at the saved
//                 time (A4-21, B4-23): the service, its way and price, the deposit and the fee; the saved time itself, a
//                 held reservation of the pro's time inside the shop's open hours, for the booking; the secure link
//                 texted to the customer's mobile (A4-42 contact, B4-29 link); for flow B the place, the town checked
//                 and the street address (B4-77, B4-30); for a path priced from photos, the quote the line copies.
//   money_before  booking-journey-<key>-money-before: where journey 6 starts (money_before per combo). As above, plus
//                 what the booking took (taken asked, A5-04) and the money before of its path: none takes nothing;
//                 card saves a card (A5-07, no charge); deposit and full save a card and take the deposit or the full
//                 price on it, one Stripe charge each, with its effect, payment, item and ledger line (K-32, as
//                 seed-payment-deposit.json does).
//   booked        booking-journey-<key>-booked: booked (A6-10, B6-10), where A6-14's code, A6-15's staff told and
//                 journey 7 start. As above, with the head at stage booked, the reservation booked, the visit (its
//                 arrival window and free-cancel time) and the terms snapshot naming the owner's rules in force.
//
//   const result = await seedJourneyStates(sql);   // result.tables.bookings: { rows: n, inserted: n, kept: 0 }
//
// What is read, and from where (rule 9):
//   - test-kit/SCENARIOS.md: each "### <flow> · `<path>` on <shop> (<service>)" line, which names the combo, its shop
//     and its service by name, in the file's order. The service must be the one the services seed made from that shop's
//     money example of that flow and path, under that name; anything else is refused, naming the line.
//   - the other seeds' plans, made from the same verified files: the shop's business, owner, location and flow defaults
//     (setup, T-213), its services, ways, prices, owner rules and price OK limit (services, T-214), its team (staff,
//     T-727), its open hours (availability, T-215) and its customers (customers, T-217). So every row names the rows
//     those seeds wrote, and a second run makes the same ids, times and amounts.
//   - when fixture set v1 was made (test-kit/COVERAGE.md line 3), which dates every row, as the other seeds do.
//   No phone number, email address, name, address or card is read from a fixture or written: the customer and the pro
//   are the customers and staff seeds' own demo people (no handle or phone row is written here, and every saved time is
//   saved for its booking, default 3), the Stripe ids are the Stripe double's stand-ins, and the street address is a
//   stand-in that opens to nothing (default 8).
//
// Defaults where no source decides (each named in the constants below and in the card's report):
//   1. One booking per stage and combo, so a lane's test changes its own booking and no other lane's (the card: "each
//      journey lane builds without the one before it"). The customer is the shop's customer 1 (JOURNEY_CUSTOMER), who
//      texts (the reach card's default), booking for themselves (booker, person served and payer), at the chat door.
//   2. The pro: the flow's first team member (the staff seed's), else the owner where the flow names no staff (FS row
//      T01, "just me"), as a K-04 worker resource of the journey set's own (res-journey-<person>): no other seed makes
//      one (the availability seed's default 1).
//   3. The saved time is saved for the booking (K-04 reservations.booking_id), not for the customer's mobile, so it is
//      outside the cap of 2 saved times a mobile holds at once (db/repo/reservations.ts holderOf): a lane's own reserve()
//      for that customer still has both. It was saved when fixture set v1 was made and held for the standard door's 10
//      minutes (SAVED_TIME_MINUTES, reservations.ts STANDARD_HOLD_MINUTES); a held row whose end has passed still holds
//      the time until its release (reservations.ts default 3), so reserve() gives it to nobody else.
//   4. When: each pro's visits follow one another inside the shop's open hours (the availability seed's weekly hours),
//      from VISITS_FROM_DAYS days after fixture set v1 was made, each as long as the service (the services seed's
//      length), and for an arrival window (K-23 flow_defaults.arrive, else the setup seed's default, window) its
//      ARRIVAL_WINDOW_MINUTES window then the work, as seed-booking-flow-b.json reserves 8 to 11 for arriving 8 to 10.
//   5. Booking values: approval now (the demo customer is on the business's list, so not new, and the visit is weeks
//      ahead, so not same day: K-26 ok_new_customer and ok_same_day ask nothing), timing settime, times the arrival
//      setting, taken asked (as the service asks, A5-04) from the money stage on.
//   6. A path priced from photos: the quote is the example's price (the services seed holds it as no rule, default 6:
//      "the example's price is that one booking's"), one option, priced by the owner, so no price OK is asked (K-26's
//      limit asks about a pro's price), and sent when the time was saved, good for 7 days (quotes_sent_good_7_days).
//   7. A path priced at the visit: K-30's line needs a price rule (booking_lines_price_source), which the services seed
//      makes none of (its default 6: the example's price is the one booking's, set at the visit, never a promise), so
//      this set writes one of its own (price-journey-<key>) holding what is promised before the visit: nothing, 0 (the
//      price is set at the visit, S13-45), with the deposit as its 'from' price on a deposit path (K-30
//      booking_lines_deposit_with_deposit_path: a deposit is never more than the price, or the 'from' price).
//   8. Flow B's place: the town is the shop's own (its listing address's last part), inside its travel area, in the
//      demo zone; the street address is SEALED_ADDRESS_STAND_IN, sealed for the customer as K-30's own seed fixtures
//      hold theirs (no file gives a customer's address, and a seed holds no key to seal one), never checked (no state).
//   9. Money: the card and each charge go through the Stripe double's stand-in ids (K-14 v1; K-32's seeds), on the
//      shop's demo account; each Stripe effect is the seed's own job (EFFECT_JOB_ID), succeeded on its one try.
//   10. The terms snapshot: no K-29 consent row (no file gives the words a customer ticked, A5-07), version
//      TERMS_VERSION (K-30 v1's seeds'), in English, with the flow's free-cancel rule (K-23 flow_defaults; the ways
//      hold none) and the owner's rules and price OK limit in force for the flow.
//   Not seeded: page answers and access notes, owner OKs, the waitlist, check-in codes and staff told (later steps
//   write them), and no K-29 row (consents, chat links): the card's states stop at booked.
//
// Checked before anything is written: every SCENARIOS.md combo is one of its flow's 28 paths, once, at a shop that has
// that flow and that service; every amount fits its path (a deposit never above the price, a charge above $0); no Stripe
// id holds 13 digits in a row; every id is made once. Inside the transaction: the core, setup, services, staff,
// availability and customers seeds' rows each state names are there.
//
// In order, stopping at the first failure: opens and checks fixture set v1 against its manifest as the core seed does
// (lib/fixture-set.ts), so only bytes that were hashed are parsed; plans every row; then, in one transaction as the job
// role rosie_job with no business scope (T-191), checks the other seeds' rows and writes these. Idempotent, as the other
// seeds: a row is inserted only when its primary key is free (ON CONFLICT DO NOTHING), nothing is updated or deleted,
// so a second run writes nothing and leaves every row as it was, version included; a row that went missing is written
// again as the first run wrote it. A clash on any other key or constraint (a pro's time another reservation holds) is
// an error, and the transaction rolls back. Nothing is printed, and no error names a value of a row.
import { createHash } from "node:crypto";
import type postgres from "postgres";
import { SCOPE_SETTING, type Sql, type Tx } from "../repo/scope";
import { type CoreSeedTableCount, SEED_ROLE } from "./core";
import { customersPlanOf } from "./customers";
import { DEMO_TIME_ZONE } from "./lib/demo-shops";
import {
  type FixtureSet,
  openFixtureSet,
  type VerifiedFixtureSet,
  verifyFixtureSet,
} from "./lib/fixture-set";
import { availabilityPlanOf, lengthMinutesOf } from "./setup-availability";
import { DEFAULT_ARRIVE, type Flow, setupPlanOf } from "./setup-business";
import { centsOf, DEMO_CURRENCY, PATHS_OF_FLOW, servicesRulesPlanOf } from "./setup-services-rules";
import { staffPlanOf } from "./setup-staff";

/** The test kit's scenarios: one test per money combo, each on a named demo shop and service. */
export const SCENARIOS_FILE = "test-kit/SCENARIOS.md";
/** The stages, in journey order, each a booking of its own per combo (see the top of this file). */
export const JOURNEY_STAGES = ["request", "time_saved", "money_before", "booked"] as const;
export type JourneyStage = (typeof JOURNEY_STAGES)[number];
/** Default 1: the customer each booking is for, by place on the customers seed's list (customer 1 texts). */
export const JOURNEY_CUSTOMER = 1;
/** Default 1: how the requests came in (K-30 booking_details.door): the customer's own chat with Rosie's number. */
export const JOURNEY_DOOR = "chat";
/** Default 3: how long a time is saved: the standard door's 10 minutes (db/repo/reservations.ts STANDARD_HOLD_MINUTES). */
export const SAVED_TIME_MINUTES = 10;
/** Default 4: the first visit day, this many days after fixture set v1 was made. */
export const VISITS_FROM_DAYS = 60;
/** Default 4: an arrival window's length, as K-30's seed-booking-flow-b.json ("arriving 8–10am"). */
export const ARRIVAL_WINDOW_MINUTES = 120;
/** Default 8: the street address's stand-in bytes: no address, and no key opens them. */
export const SEALED_ADDRESS_STAND_IN = "journey-states-sealed-address-stand-in";
/** Default 9: the job each Stripe effect of this set is written under (K-07 effects_turn_or_job). */
export const EFFECT_JOB_ID = "seed-journey-states";
/** Default 10: the terms version every snapshot names (K-30 v1's own seeds'). */
export const TERMS_VERSION = "2026-10-19.1";
export const TERMS_LANGUAGE = "en";
/** The Stripe double's stand-in id forms (K-14 v1 "The double"; K-32 v1 seed-payment-deposit.json). */
export const STRIPE_ACCOUNT_PREFIX = "stripe-acct-demo-";

const STAGE_SLUG: Readonly<Record<JourneyStage, string>> = {
  request: "request",
  time_saved: "time-saved",
  money_before: "money-before",
  booked: "booked",
};
const STAGE_LETTER: Readonly<Record<JourneyStage, string>> = {
  request: "R",
  time_saved: "S",
  money_before: "M",
  booked: "B",
};

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const SEVEN_DAYS_MS = 7 * DAY_MS;
// How far the visits may run past the first visit day before the seed gives up (a shop with no open hours).
const MAX_DAYS = 366;
// "### A · `list|card|counter` on acupuncturist (Follow-up treatment)": the flow, the path, the shop and the service.
const SCENARIO_LINE = /^### (A|B) · `([a-z]+\|[a-z]+\|[a-z]+)` on ([A-Za-z0-9-]+) \((.+)\)$/;
// "24 hours", "2 days": a free-cancel span as the setup seed writes it (K-23 flow_defaults.cutoff_before).
const CUTOFF_SPAN = /^([1-9][0-9]{0,3}) (hour|hours|day|days)$/;
// "19:00": a clock time the day before (K-23 flow_defaults.cutoff_day_before_at).
const CLOCK_TIME = /^([01][0-9]|2[0-3]):([0-5][0-9])(?::00)?$/;
// K-32 saved_cards_no_card_number and ledger_lines_stripe_id: 13 or more digits in a row, once spaces and dashes go.
const CARD_NUMBER_RUN = /[0-9]{13,}/;

/** One money combo of SCENARIOS.md: its flow, path, shop and service, and where it is in the file. */
export interface Scenario {
  readonly flow: Flow;
  readonly path: string;
  readonly shopId: string;
  readonly serviceName: string;
  /** Its line in SCENARIOS.md, from 1. */
  readonly line: number;
  /** Its place among its flow's combos, from 1. */
  readonly index: number;
}

export interface JourneyResourceRow {
  readonly id: string;
  readonly business_id: string;
  readonly kind: "worker";
  readonly name: string;
  readonly person_id: string;
  readonly active: true;
}

export interface JourneyPriceRuleRow {
  readonly id: string;
  readonly business_id: string;
  readonly service_id: string;
  readonly price_cents: number;
  readonly from_cents: number | null;
  readonly currency: string;
  readonly set_by_person_id: string;
  readonly effective_from: Date;
}

export interface JourneyBookingRow {
  readonly id: string;
  readonly business_id: string;
  readonly flow: Flow;
  readonly stage: "entry" | "booked";
  readonly booker_person_id: string;
  readonly served_person_id: string;
  readonly payer_person_id: string;
  readonly private: false;
  readonly deceased: false;
}

export interface JourneyDetailsRow {
  readonly booking_id: string;
  readonly business_id: string;
  readonly number: string;
  readonly door: typeof JOURNEY_DOOR;
  readonly made_by: "customer";
  readonly approval: "now" | null;
  readonly timing: "settime" | null;
  readonly times: "setstart" | "window" | null;
  readonly taken: "asked" | null;
}

export interface JourneyQuoteRow {
  readonly id: string;
  readonly booking_id: string;
  readonly business_id: string;
  readonly service_id: string;
  readonly basis: "photos";
  readonly priced_by_person_id: string;
  readonly priced_at: Date;
  readonly price_ok_limit_id: null;
  readonly state: "sent";
  readonly sent_at: Date;
  readonly good_until: Date;
  readonly currency: string;
}

export interface JourneyQuoteOptionRow {
  readonly id: string;
  readonly quote_id: string;
  readonly business_id: string;
  readonly position: 1;
  readonly label: null;
  readonly price_cents: number;
  readonly up_to_cents: null;
}

export interface JourneyLineRow {
  readonly id: string;
  readonly booking_id: string;
  readonly business_id: string;
  readonly position: 1;
  readonly service_id: string;
  readonly service_money_id: string;
  readonly price_rule_id: string | null;
  readonly quote_option_id: string | null;
  readonly path: string;
  readonly price_kind: string;
  readonly unit: null;
  readonly units: 1;
  readonly price_cents: number;
  readonly from_cents: number | null;
  readonly deposit_cents: number | null;
  readonly fee_cents: number | null;
  readonly currency: string;
  readonly paid_by: "money";
}

export interface JourneyReservationRow {
  readonly id: string;
  readonly business_id: string;
  readonly resource_id: string;
  readonly resource_kind: "worker";
  readonly worker_person_id: string;
  /** A tstzrange [start, end) of instants, as PostgreSQL reads it. */
  readonly during: string;
  readonly state: "held" | "booked";
  readonly queued_at: Date;
  readonly seats: 1;
  readonly held_until: Date | null;
  readonly booking_id: string;
}

export interface JourneyAddressRow {
  readonly id: string;
  readonly booking_id: string;
  readonly business_id: string;
  readonly position: 1;
  readonly area: string;
  readonly address: Uint8Array;
  readonly sealed_for_person_id: string;
  readonly zone: string;
  readonly state_code: null;
  readonly location_id: string;
  readonly checked_at: null;
}

export interface JourneyLinkRow {
  readonly id: string;
  readonly booking_id: string;
  readonly business_id: string;
  readonly purpose: "secure_page";
  readonly person_id: string;
  readonly handle_id: string;
  readonly given_via: "text";
  readonly code_sha256: string;
  readonly issued_at: Date;
}

export interface JourneyEffectRow {
  readonly id: string;
  readonly job_id: typeof EFFECT_JOB_ID;
  readonly business_id: string;
  readonly booking_id: string;
  readonly kind: "stripe_save_card" | "stripe_charge";
  readonly port: "stripe";
  readonly person_id: string;
  readonly amount_cents: number | null;
  readonly currency: string | null;
  readonly port_request: postgres.JSONValue;
  readonly idempotency_key: string;
  readonly state: "succeeded";
  readonly tries: 1;
  readonly runs: 1;
  readonly first_try_at: Date;
  readonly last_try_at: Date;
  readonly provider_object_id: string;
  readonly ledger_line_id: string | null;
  readonly trace_id: string;
  readonly created_at: Date;
}

export interface JourneySavedCardRow {
  readonly id: string;
  readonly business_id: string;
  readonly person_id: string;
  readonly booking_id: string;
  readonly stripe_customer_id: string;
  readonly stripe_payment_method_id: string;
  readonly save_effect_id: string;
  readonly asked_at: Date;
  readonly saved_at: Date;
}

export interface JourneyPaymentRow {
  readonly id: string;
  readonly business_id: string;
  readonly payer_person_id: string;
  readonly booking_id: string;
  readonly purpose: "deposit" | "full_price";
  readonly method: "card";
  readonly amount_cents: number;
  readonly currency: string;
  readonly state: "paid";
  readonly effect_id: string;
  readonly saved_card_id: string;
  readonly asked_at: Date;
  readonly paid_at: Date;
}

export interface JourneyPaymentItemRow {
  readonly id: string;
  readonly payment_id: string;
  readonly business_id: string;
  readonly booking_line_id: string;
  readonly share: "deposit" | "full";
  readonly amount_cents: number;
  readonly currency: string;
}

export interface JourneyLedgerRow {
  readonly id: string;
  readonly business_id: string;
  readonly booking_id: string;
  readonly kind: "charge";
  readonly amount_cents: number;
  readonly currency: string;
  readonly payment_id: string;
  readonly effect_id: string;
  readonly stripe_object_id: string;
  readonly moved_at: Date;
  readonly written_by: "effect_result";
  readonly written_at: Date;
}

export interface JourneyVisitRow {
  readonly id: string;
  readonly booking_id: string;
  readonly business_id: string;
  readonly position: 1;
  readonly reservation_id: string;
  readonly arrival_window: string | null;
  readonly cutoff_at: Date | null;
}

export interface JourneyTermsRow {
  readonly booking_id: string;
  readonly business_id: string;
  readonly terms_consent_id: null;
  readonly terms_version: typeof TERMS_VERSION;
  readonly terms_language: typeof TERMS_LANGUAGE;
  readonly cutoff_before: string | null;
  readonly cutoff_day_before_at: string | null;
  readonly cutoff_zone: string | null;
  readonly written_at: Date;
}

export interface JourneyTermsRuleRow {
  readonly id: string;
  readonly booking_id: string;
  readonly business_id: string;
  readonly rule_id: string | null;
  readonly price_ok_limit_id: string | null;
}

/** The rows of every state, table by table, in the order their keys need them written. */
export interface JourneySeedRows {
  readonly resources: readonly JourneyResourceRow[];
  readonly price_rules: readonly JourneyPriceRuleRow[];
  readonly bookings: readonly JourneyBookingRow[];
  readonly booking_details: readonly JourneyDetailsRow[];
  readonly quotes: readonly JourneyQuoteRow[];
  readonly quote_options: readonly JourneyQuoteOptionRow[];
  readonly booking_lines: readonly JourneyLineRow[];
  readonly reservations: readonly JourneyReservationRow[];
  readonly booking_addresses: readonly JourneyAddressRow[];
  readonly secure_links: readonly JourneyLinkRow[];
  readonly effects: readonly JourneyEffectRow[];
  readonly saved_cards: readonly JourneySavedCardRow[];
  readonly payments: readonly JourneyPaymentRow[];
  readonly payment_items: readonly JourneyPaymentItemRow[];
  readonly ledger_lines: readonly JourneyLedgerRow[];
  readonly booking_visits: readonly JourneyVisitRow[];
  readonly booking_terms: readonly JourneyTermsRow[];
  readonly booking_terms_rules: readonly JourneyTermsRuleRow[];
}

export type JourneySeedTable = keyof JourneySeedRows;

/** One booking of the set: its combo, its stage and every key a lane starting from it needs. */
export interface JourneyState {
  readonly flow: Flow;
  readonly path: string;
  readonly shopId: string;
  readonly stage: JourneyStage;
  /** Where its combo is in SCENARIOS.md. */
  readonly scenarioLine: number;
  readonly businessId: string;
  readonly serviceId: string;
  readonly wayId: string;
  readonly bookingId: string;
  readonly number: string;
  readonly customerId: string;
  readonly customerPersonId: string;
  readonly customerHandleId: string;
  /** The pro's worker resource and person (default 2). */
  readonly resourceId: string;
  readonly proPersonId: string;
  /** From time_saved on (null before). */
  readonly reservationId: string | null;
  readonly during: { readonly start: string; readonly end: string } | null;
  readonly lineId: string | null;
  readonly linkId: string | null;
  /** Flow B, from time_saved on. */
  readonly addressId: string | null;
  /** A path priced from photos, from time_saved on. */
  readonly quoteId: string | null;
  /** From money_before on, for a path that takes money before. */
  readonly savedCardId: string | null;
  /** From money_before on, for a deposit or full path. */
  readonly paymentId: string | null;
  /** Booked only. */
  readonly visitId: string | null;
}

export interface JourneySeedPlan {
  readonly rows: JourneySeedRows;
  /** One entry per combo and stage, in SCENARIOS.md's order, then the stages' order. */
  readonly states: readonly JourneyState[];
  readonly scenarios: readonly Scenario[];
  /** When every row is dated (when fixture set v1 was made), and the file that says so. */
  readonly seededAt: { readonly at: Date; readonly source: string };
  /** The other seeds' keys the states name, checked inside the transaction. */
  readonly needs: {
    readonly customerIds: readonly string[];
    readonly wayIds: readonly string[];
    readonly priceRuleIds: readonly string[];
    readonly personIds: readonly string[];
    readonly locationIds: readonly string[];
    readonly ruleIds: readonly string[];
    readonly priceOkLimitIds: readonly string[];
  };
}

export interface JourneySeedResult {
  /** The database role that wrote the rows (current_user inside the seed's transaction). */
  readonly ranAs: string;
  /** The fixture set that was checked: its folder, its manifest's sha256 and how many files the manifest lists. */
  readonly fixtureSet: {
    readonly dir: string;
    readonly manifestSha256: string;
    readonly filesChecked: number;
  };
  readonly seededAt: { readonly at: Date; readonly source: string };
  readonly tables: Readonly<Record<JourneySeedTable, CoreSeedTableCount>>;
  readonly states: readonly JourneyState[];
}

export interface JourneySeedOptions {
  /** Fixture set v1's folder. Default fixtures/v1. Anything outside the repository's fixtures/ folder is refused. */
  fixturesDir?: string;
}

const pathKey = (flow: Flow, path: string): string => `${flow.toLowerCase()}-${path.replaceAll("|", "-")}`;

/** The key of a combo's rows: the services seed's own (<shop>-<a|b>-<path with dashes>). */
export const comboKey = (shopId: string, flow: Flow, path: string): string =>
  `${shopId}-${pathKey(flow, path)}`;

/** The booking a lane starts from: the combo's booking at that stage. */
export const journeyBookingId = (shopId: string, flow: Flow, path: string, stage: JourneyStage): string =>
  `booking-journey-${comboKey(shopId, flow, path)}-${STAGE_SLUG[stage]}`;

/** The combos SCENARIOS.md lists, in its order. A "### " line that is not one, or a combo given twice, is refused. */
export function scenariosOf(text: string): Scenario[] {
  const scenarios: Scenario[] = [];
  const seen = new Set<string>();
  const counts: Record<Flow, number> = { A: 0, B: 0 };
  text.split("\n").forEach((raw, offset) => {
    const line = raw.replace(/\r$/, "");
    if (!line.startsWith("### ")) {
      return;
    }
    const at = offset + 1;
    const match = SCENARIO_LINE.exec(line);
    const flow = match?.[1];
    const path = match?.[2];
    const shopId = match?.[3];
    const serviceName = match?.[4];
    if (
      (flow !== "A" && flow !== "B") ||
      path === undefined ||
      shopId === undefined ||
      serviceName === undefined
    ) {
      throw new Error(
        `${SCENARIOS_FILE} line ${String(at)}: not "### <flow> · \`<path>\` on <shop> (<service>)"`,
      );
    }
    if (!PATHS_OF_FLOW[flow].includes(path)) {
      throw new Error(`${SCENARIOS_FILE} line ${String(at)}: its path is not one of flow ${flow}'s 28`);
    }
    const combo = `${flow} ${path}`;
    if (seen.has(combo)) {
      throw new Error(`${SCENARIOS_FILE} line ${String(at)}: flow ${flow}'s path ${path} is listed twice`);
    }
    seen.add(combo);
    counts[flow] += 1;
    scenarios.push({ flow, path, shopId, serviceName, line: at, index: counts[flow] });
  });
  if (scenarios.length === 0) {
    throw new Error(`${SCENARIOS_FILE} lists no money combo`);
  }
  return scenarios;
}

// The demo shops' zone's wall clock at an instant, read as if it were UTC (milliseconds).
const ZONE_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: DEMO_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

function wallClockAt(at: number): number {
  const parts = ZONE_CLOCK.formatToParts(new Date(at));
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((entry) => entry.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
}

/**
 * The instant of a wall-clock time in the demo shops' zone: `day` is the date's midnight read as UTC (milliseconds) and
 * `minutes` the time past it. A time the zone skips or repeats is refused.
 */
function instantAt(day: number, minutes: number): Date {
  const wall = day + minutes * MINUTE_MS;
  let at = wall - (wallClockAt(wall) - wall);
  at = wall - (wallClockAt(at) - at);
  if (
    Number.isNaN(at) ||
    wallClockAt(at) !== wall ||
    wallClockAt(at - HOUR_MS) === wall ||
    wallClockAt(at + HOUR_MS) === wall
  ) {
    throw new Error(`a visit's time is not one instant in ${DEMO_TIME_ZONE}`);
  }
  return new Date(at);
}

/** ISO day of the week of a date's midnight read as UTC: 1 (Monday) to 7 (Sunday). */
const weekdayOf = (day: number): number => ((new Date(day).getUTCDay() + 6) % 7) + 1;

/** "HH:MM" (as K-27 weekly_hours and K-23 write a clock time) in minutes past midnight. */
function minutesOfClock(clock: string): number {
  const match = CLOCK_TIME.exec(clock);
  if (match?.[1] === undefined || match[2] === undefined) {
    if (clock === "24:00" || clock === "24:00:00") {
      return 24 * 60;
    }
    throw new Error(`a clock time is not "HH:MM"`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

const range = (start: Date, end: Date): string => `[${start.toISOString()},${end.toISOString()})`;

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Refuses a plan that would write one key twice in a table, which ON CONFLICT DO NOTHING would otherwise drop. */
function requireUnique(table: string, keys: readonly string[]): void {
  if (new Set(keys).size !== keys.length) {
    throw new Error(`the journey-states seed would write two ${table} rows with one key; stopping`);
  }
}

/** An open span of a day, in minutes past midnight. */
interface Span {
  readonly opens: number;
  readonly closes: number;
}

/** Where a pro's next visit may start: days after the first visit day, and minutes past that day's midnight. */
interface Cursor {
  day: number;
  minute: number;
}

/**
 * The pro's next free time of `minutes` inside the shop's open hours: on the cursor's day from the cursor's minute,
 * else the first span of a later open day. The cursor moves past it, so one pro's visits never overlap.
 */
function nextVisit(
  cursor: Cursor,
  firstDay: number,
  spansOf: (weekday: number) => readonly Span[],
  minutes: number,
): { day: number; start: number } {
  for (let guard = 0; guard < MAX_DAYS; guard += 1) {
    const day = firstDay + cursor.day * DAY_MS;
    for (const span of spansOf(weekdayOf(day))) {
      const start = Math.max(cursor.minute, span.opens);
      if (start + minutes <= span.closes) {
        cursor.minute = start + minutes;
        return { day, start };
      }
    }
    cursor.day += 1;
    cursor.minute = 0;
  }
  throw new Error(`no open time of ${String(minutes)} minutes in ${String(MAX_DAYS)} days`);
}

/** When free cancel ends for a visit starting at `start` (local `day` and `minute`), by the flow's rule; null for none. */
function cutoffAt(
  rule: { readonly before: string | null; readonly dayBeforeAt: string | null },
  start: Date,
  day: number,
  minute: number,
): Date | null {
  if (rule.before !== null) {
    const span = CUTOFF_SPAN.exec(rule.before);
    if (span?.[1] === undefined || span[2] === undefined) {
      throw new Error("a flow's free-cancel span is not a form the seed knows");
    }
    const count = Number(span[1]);
    return span[2].startsWith("hour")
      ? new Date(start.getTime() - count * HOUR_MS)
      : instantAt(day - count * DAY_MS, minute);
  }
  if (rule.dayBeforeAt !== null) {
    return instantAt(day - DAY_MS, minutesOfClock(rule.dayBeforeAt));
  }
  return null;
}

/** An amount the shop file words ("$35", "free"), in cents; null when it gives none or none the seed can read. */
function amountOf(words: string | null): number | null {
  if (words === null) {
    return null;
  }
  return words === "free" ? 0 : centsOf(words);
}

/**
 * Plans every row of the journey-states seed from a verified fixture set (pure: no database), from the other seeds'
 * plans, so each row names the business, owner, location, service, way, price, team member and customer they wrote.
 */
export function journeyStatesPlanOf(verified: VerifiedFixtureSet): JourneySeedPlan {
  const scenariosFile = verified.files.get(SCENARIOS_FILE);
  if (scenariosFile === undefined) {
    throw new Error(`the fixture set at ${verified.dir} has no ${SCENARIOS_FILE}`);
  }
  const scenarios = scenariosOf(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(scenariosFile.bytes),
  );
  const setup = setupPlanOf(verified);
  const services = servicesRulesPlanOf(verified);
  const staff = staffPlanOf(verified);
  const customers = customersPlanOf(verified);
  const availability = availabilityPlanOf(verified);
  const at = setup.seededAt.at;

  const setupOf = new Map(setup.seeded.map((shop) => [shop.shopId, shop]));
  const servicesOf = new Map(services.shops.map((shop) => [shop.shopId, shop]));
  const staffOf = new Map(staff.shops.map((shop) => [shop.shopId, shop]));
  const customersOf = new Map(customers.shops.map((shop) => [shop.shopId, shop]));
  const serviceRowOf = new Map(services.rows.services.map((row) => [row.id, row]));
  const wayRowOf = new Map(services.rows.service_money.map((row) => [row.id, row]));
  const priceRuleOf = new Map(services.rows.price_rules.map((row) => [row.id, row]));
  const locationOf = new Map(setup.rows.locations.map((row) => [row.id, row]));
  const flowDefaultOf = new Map(
    setup.rows.flow_defaults.map((row) => [`${row.business_id} ${row.flow}`, row]),
  );
  const spansOfLocation = new Map<string, Map<number, Span[]>>();
  for (const row of availability.rows.weekly_hours) {
    const byDay = spansOfLocation.get(row.location_id) ?? new Map<number, Span[]>();
    const spans = byDay.get(row.weekday) ?? [];
    spans.push({ opens: minutesOfClock(row.opens_at), closes: minutesOfClock(row.closes_at) });
    spans.sort((a, b) => a.opens - b.opens);
    byDay.set(row.weekday, spans);
    spansOfLocation.set(row.location_id, byDay);
  }

  const firstDay = Math.floor(wallClockAt(at.getTime()) / DAY_MS) * DAY_MS + VISITS_FROM_DAYS * DAY_MS;
  const heldUntil = new Date(at.getTime() + SAVED_TIME_MINUTES * MINUTE_MS);
  const goodUntil = new Date(at.getTime() + SEVEN_DAYS_MS);

  const rows = {
    resources: [] as JourneyResourceRow[],
    price_rules: [] as JourneyPriceRuleRow[],
    bookings: [] as JourneyBookingRow[],
    booking_details: [] as JourneyDetailsRow[],
    quotes: [] as JourneyQuoteRow[],
    quote_options: [] as JourneyQuoteOptionRow[],
    booking_lines: [] as JourneyLineRow[],
    reservations: [] as JourneyReservationRow[],
    booking_addresses: [] as JourneyAddressRow[],
    secure_links: [] as JourneyLinkRow[],
    effects: [] as JourneyEffectRow[],
    saved_cards: [] as JourneySavedCardRow[],
    payments: [] as JourneyPaymentRow[],
    payment_items: [] as JourneyPaymentItemRow[],
    ledger_lines: [] as JourneyLedgerRow[],
    booking_visits: [] as JourneyVisitRow[],
    booking_terms: [] as JourneyTermsRow[],
    booking_terms_rules: [] as JourneyTermsRuleRow[],
  };
  const states: JourneyState[] = [];
  const cursors = new Map<string, Cursor>();
  const resourceIds = new Set<string>();
  const needs = {
    customerIds: new Set<string>(),
    wayIds: new Set<string>(),
    priceRuleIds: new Set<string>(),
    personIds: new Set<string>(),
    locationIds: new Set<string>(),
    ruleIds: new Set<string>(),
    priceOkLimitIds: new Set<string>(),
  };

  for (const scenario of scenarios) {
    const { flow, path, shopId } = scenario;
    const where = `${SCENARIOS_FILE} line ${String(scenario.line)}`;
    const shop = setupOf.get(shopId);
    const shopServices = servicesOf.get(shopId);
    const shopStaff = staffOf.get(shopId);
    const shopCustomers = customersOf.get(shopId);
    if (
      shop === undefined ||
      shopServices === undefined ||
      shopStaff === undefined ||
      shopCustomers === undefined
    ) {
      throw new Error(`${where}: names a shop the fixture set has no file for`);
    }
    if (!shop.flows.includes(flow)) {
      throw new Error(`${where}: its shop has no flow ${flow}`);
    }
    const service = shopServices.services.find((entry) => entry.flow === flow && entry.path === path);
    const serviceRow = service === undefined ? undefined : serviceRowOf.get(service.serviceId);
    const way = service === undefined ? undefined : wayRowOf.get(service.wayId);
    if (service === undefined || serviceRow === undefined || way === undefined) {
      throw new Error(`${where}: its shop has no money example of that flow and path`);
    }
    if (serviceRow.name !== scenario.serviceName) {
      throw new Error(`${where}: its service is not the one the shop's example of that flow and path names`);
    }
    const customer = shopCustomers.customers.find((entry) => entry.position === JOURNEY_CUSTOMER);
    if (customer === undefined) {
      throw new Error(`${where}: the customers seed gives its shop no customer ${String(JOURNEY_CUSTOMER)}`);
    }
    const location = locationOf.get(shop.locationId);
    const spans = spansOfLocation.get(shop.locationId);
    if (location === undefined || spans === undefined) {
      throw new Error(`${where}: the setup and availability seeds give its shop no location with open hours`);
    }
    const length = lengthMinutesOf(serviceRow.length);
    if (length === null) {
      throw new Error(`${where}: its service's length is not a form the seed knows`);
    }

    // Default 2: the flow's first team member, else the owner.
    const member = shopStaff.teams.find((team) => team.flow === flow)?.members[0];
    const proPersonId = member?.personId ?? shopStaff.ownerPersonId;
    const resourceId = `res-journey-${proPersonId.replace(/^person-demo-/, "")}`;
    if (!resourceIds.has(resourceId)) {
      resourceIds.add(resourceId);
      rows.resources.push({
        id: resourceId,
        business_id: shop.businessId,
        kind: "worker",
        name: member === undefined ? "Demo owner" : `Demo team member ${flow}${String(member.position)}`,
        person_id: proPersonId,
        active: true,
      });
    }
    const cursor = cursors.get(resourceId) ?? { day: 0, minute: 0 };
    cursors.set(resourceId, cursor);

    // Defaults 4 and 10: the flow's arrival setting and free-cancel rule (K-23 flow_defaults; the ways hold none).
    const defaults = flowDefaultOf.get(`${shop.businessId} ${flow}`);
    const arrive = defaults?.arrive ?? DEFAULT_ARRIVE;
    const cutoffRule = {
      before: defaults?.cutoff_before ?? null,
      dayBeforeAt: defaults?.cutoff_day_before_at ?? null,
    };

    // The line's price, by the path's first part (K-30 rule 10; booking_lines_price_source).
    const [priceBy, before] = path.split("|");
    let priceRuleId: string | null = null;
    let priceCents: number;
    let fromCents: number | null = null;
    let quotePrice: number | null = null;
    const depositCents = way.deposit_cents;
    if (priceBy === "list") {
      const rule = service.priceRuleId === null ? undefined : priceRuleOf.get(service.priceRuleId);
      if (rule === undefined) {
        throw new Error(`${where}: the services seed holds no list price for its service`);
      }
      priceRuleId = rule.id;
      priceCents = rule.price_cents;
      needs.priceRuleIds.add(rule.id);
    } else if (priceBy === "photos") {
      // Default 6: the quote is the example's price.
      quotePrice = amountOf(service.priceNotHeld);
      if (quotePrice === null) {
        throw new Error(`${where}: its example gives no price to quote from photos`);
      }
      priceCents = quotePrice;
    } else {
      // Default 7: nothing is promised before the visit (S13-45), as a price rule of this set's own; a deposit path's
      // deposit is its 'from' price.
      priceCents = 0;
      fromCents = before === "deposit" ? depositCents : null;
      priceRuleId = `price-journey-${comboKey(shopId, flow, path)}`;
      rows.price_rules.push({
        id: priceRuleId,
        business_id: shop.businessId,
        service_id: service.serviceId,
        price_cents: priceCents,
        from_cents: fromCents,
        currency: DEMO_CURRENCY,
        set_by_person_id: shop.ownerPersonId,
        effective_from: at,
      });
    }
    if (depositCents !== null && depositCents > (fromCents ?? priceCents)) {
      throw new Error(`${where}: its deposit is more than its price (K-30: never more than the price)`);
    }
    const chargeCents = before === "deposit" ? depositCents : before === "full" ? priceCents : null;
    if (chargeCents !== null && chargeCents <= 0) {
      throw new Error(
        `${where}: its path takes money before, but nothing to take (K-32: a payment is above $0)`,
      );
    }

    needs.customerIds.add(customer.customerId);
    needs.wayIds.add(way.id);
    needs.personIds.add(proPersonId);
    needs.locationIds.add(shop.locationId);
    const shopRules = services.rows.rules.filter(
      (rule) => rule.business_id === shop.businessId && (rule.flow === null || rule.flow === flow),
    );
    const shopLimits = services.rows.price_ok_limits.filter(
      (limit) => limit.business_id === shop.businessId && (limit.flow === null || limit.flow === flow),
    );

    const key = comboKey(shopId, flow, path);
    for (const stage of JOURNEY_STAGES) {
      const stageKey = `${key}-${STAGE_SLUG[stage]}`;
      const bookingId = journeyBookingId(shopId, flow, path, stage);
      const number = `JS${flow}${String(scenario.index).padStart(2, "0")}${STAGE_LETTER[stage]}`;
      const saved = stage !== "request";
      const paid = stage === "money_before" || stage === "booked";
      const booked = stage === "booked";
      rows.bookings.push({
        id: bookingId,
        business_id: shop.businessId,
        flow,
        stage: booked ? "booked" : "entry",
        booker_person_id: customer.personId,
        served_person_id: customer.personId,
        payer_person_id: customer.personId,
        private: false,
        deceased: false,
      });
      rows.booking_details.push({
        booking_id: bookingId,
        business_id: shop.businessId,
        number,
        door: JOURNEY_DOOR,
        made_by: "customer",
        approval: saved ? "now" : null,
        timing: saved ? "settime" : null,
        times: saved ? arrive : null,
        taken: paid ? "asked" : null,
      });

      const state: {
        -readonly [K in keyof JourneyState]: JourneyState[K];
      } = {
        flow,
        path,
        shopId,
        stage,
        scenarioLine: scenario.line,
        businessId: shop.businessId,
        serviceId: service.serviceId,
        wayId: way.id,
        bookingId,
        number,
        customerId: customer.customerId,
        customerPersonId: customer.personId,
        customerHandleId: customer.handleId,
        resourceId,
        proPersonId,
        reservationId: null,
        during: null,
        lineId: null,
        linkId: null,
        addressId: null,
        quoteId: null,
        savedCardId: null,
        paymentId: null,
        visitId: null,
      };

      if (saved) {
        // The quote a photos line copies (default 6), sent when the time was saved.
        let quoteOptionId: string | null = null;
        if (quotePrice !== null) {
          const quoteId = `quote-journey-${stageKey}`;
          quoteOptionId = `qopt-journey-${stageKey}-1`;
          rows.quotes.push({
            id: quoteId,
            booking_id: bookingId,
            business_id: shop.businessId,
            service_id: service.serviceId,
            basis: "photos",
            priced_by_person_id: shop.ownerPersonId,
            priced_at: at,
            price_ok_limit_id: null,
            state: "sent",
            sent_at: at,
            good_until: goodUntil,
            currency: DEMO_CURRENCY,
          });
          rows.quote_options.push({
            id: quoteOptionId,
            quote_id: quoteId,
            business_id: shop.businessId,
            position: 1,
            label: null,
            price_cents: quotePrice,
            up_to_cents: null,
          });
          state.quoteId = quoteId;
        }

        const lineId = `line-journey-${stageKey}-1`;
        rows.booking_lines.push({
          id: lineId,
          booking_id: bookingId,
          business_id: shop.businessId,
          position: 1,
          service_id: service.serviceId,
          service_money_id: way.id,
          price_rule_id: priceRuleId,
          quote_option_id: quoteOptionId,
          path,
          price_kind: serviceRow.price_kind,
          unit: null,
          units: 1,
          price_cents: priceCents,
          from_cents: fromCents,
          deposit_cents: depositCents,
          fee_cents: way.fee_cents,
          currency: DEMO_CURRENCY,
          paid_by: "money",
        });
        state.lineId = lineId;

        // The saved time (default 3), then booked: the pro's next free time in open hours (default 4).
        const windowed = arrive === "window";
        const visit = nextVisit(
          cursor,
          firstDay,
          (weekday) => spans.get(weekday) ?? [],
          (windowed ? ARRIVAL_WINDOW_MINUTES : 0) + length,
        );
        const start = instantAt(visit.day, visit.start);
        const end = instantAt(visit.day, visit.start + (windowed ? ARRIVAL_WINDOW_MINUTES : 0) + length);
        const reservationId = `rsv-journey-${stageKey}`;
        rows.reservations.push({
          id: reservationId,
          business_id: shop.businessId,
          resource_id: resourceId,
          resource_kind: "worker",
          worker_person_id: proPersonId,
          during: range(start, end),
          state: booked ? "booked" : "held",
          queued_at: at,
          seats: 1,
          held_until: booked ? null : heldUntil,
          booking_id: bookingId,
        });
        state.reservationId = reservationId;
        state.during = { start: start.toISOString(), end: end.toISOString() };

        // Contact (A4-42) or link (B4-29): the secure link texted to the customer's mobile; only its code's hash.
        const linkId = `link-journey-${stageKey}`;
        rows.secure_links.push({
          id: linkId,
          booking_id: bookingId,
          business_id: shop.businessId,
          purpose: "secure_page",
          person_id: customer.personId,
          handle_id: customer.handleId,
          given_via: "text",
          code_sha256: sha256Hex(`journey-states secure link code stand-in ${linkId}`),
          issued_at: at,
        });
        state.linkId = linkId;

        // Flow B's place and street address (default 8).
        if (flow === "B") {
          const area = location.address.split(", ").pop()?.trim() ?? "";
          if (area === "" || area === location.address) {
            throw new Error(`${where}: its shop's address names no town after its street`);
          }
          const addressId = `addr-journey-${stageKey}-1`;
          rows.booking_addresses.push({
            id: addressId,
            booking_id: bookingId,
            business_id: shop.businessId,
            position: 1,
            area,
            address: new TextEncoder().encode(SEALED_ADDRESS_STAND_IN),
            sealed_for_person_id: customer.personId,
            zone: DEMO_TIME_ZONE,
            state_code: null,
            location_id: shop.locationId,
            checked_at: null,
          });
          state.addressId = addressId;
        }

        // Money before, by the path's second part (default 9).
        if (paid && before !== "none") {
          const account = { kind: "business", accountId: `${STRIPE_ACCOUNT_PREFIX}${shopId}` };
          const customerId = `stripe-customer-demo-journey-${shopId}-customer-${String(JOURNEY_CUSTOMER)}`;
          const cardId = `card-journey-${stageKey}`;
          const methodId = `stripe-card-demo-journey-${stageKey}`;
          const saveEffectId = `eff-journey-${stageKey}-save-card`;
          rows.effects.push({
            id: saveEffectId,
            job_id: EFFECT_JOB_ID,
            business_id: shop.businessId,
            booking_id: bookingId,
            kind: "stripe_save_card",
            port: "stripe",
            person_id: customer.personId,
            amount_cents: null,
            currency: null,
            port_request: { account, customerId },
            idempotency_key: saveEffectId,
            state: "succeeded",
            tries: 1,
            runs: 1,
            first_try_at: at,
            last_try_at: at,
            provider_object_id: `stripe-setup-demo-journey-${stageKey}`,
            ledger_line_id: null,
            trace_id: `trace-journey-${stageKey}`,
            created_at: at,
          });
          rows.saved_cards.push({
            id: cardId,
            business_id: shop.businessId,
            person_id: customer.personId,
            booking_id: bookingId,
            stripe_customer_id: customerId,
            stripe_payment_method_id: methodId,
            save_effect_id: saveEffectId,
            asked_at: at,
            saved_at: at,
          });
          state.savedCardId = cardId;

          if (chargeCents !== null) {
            const purpose = before === "deposit" ? "deposit" : "full_price";
            const share = before === "deposit" ? "deposit" : "full";
            const chargeEffectId = `eff-journey-${stageKey}-${share}`;
            const paymentId = `pay-journey-${stageKey}-${share}`;
            const ledgerId = `ledger-journey-${stageKey}-${share}`;
            rows.effects.push({
              id: chargeEffectId,
              job_id: EFFECT_JOB_ID,
              business_id: shop.businessId,
              booking_id: bookingId,
              kind: "stripe_charge",
              port: "stripe",
              person_id: customer.personId,
              amount_cents: chargeCents,
              currency: DEMO_CURRENCY,
              port_request: {
                account,
                purpose,
                customerId,
                paymentMethodId: methodId,
                customerPresent: true,
                description: `${serviceRow.name}: ${purpose === "deposit" ? "deposit" : "paid in full"}`,
              },
              idempotency_key: chargeEffectId,
              state: "succeeded",
              tries: 1,
              runs: 1,
              first_try_at: at,
              last_try_at: at,
              provider_object_id: `stripe-payment-demo-journey-${stageKey}`,
              ledger_line_id: ledgerId,
              trace_id: `trace-journey-${stageKey}`,
              created_at: at,
            });
            rows.payments.push({
              id: paymentId,
              business_id: shop.businessId,
              payer_person_id: customer.personId,
              booking_id: bookingId,
              purpose,
              method: "card",
              amount_cents: chargeCents,
              currency: DEMO_CURRENCY,
              state: "paid",
              effect_id: chargeEffectId,
              saved_card_id: cardId,
              asked_at: at,
              paid_at: at,
            });
            rows.payment_items.push({
              id: `item-journey-${stageKey}-${share}-1`,
              payment_id: paymentId,
              business_id: shop.businessId,
              booking_line_id: lineId,
              share,
              amount_cents: chargeCents,
              currency: DEMO_CURRENCY,
            });
            rows.ledger_lines.push({
              id: ledgerId,
              business_id: shop.businessId,
              booking_id: bookingId,
              kind: "charge",
              amount_cents: chargeCents,
              currency: DEMO_CURRENCY,
              payment_id: paymentId,
              effect_id: chargeEffectId,
              stripe_object_id: `stripe-charge-demo-journey-${stageKey}`,
              moved_at: at,
              written_by: "effect_result",
              written_at: at,
            });
            state.paymentId = paymentId;
          }
        }

        // Booked: the visit and the terms snapshot naming the owner's rules in force (default 10).
        if (booked) {
          const visitId = `visit-journey-${stageKey}-1`;
          rows.booking_visits.push({
            id: visitId,
            booking_id: bookingId,
            business_id: shop.businessId,
            position: 1,
            reservation_id: reservationId,
            arrival_window: windowed
              ? range(start, instantAt(visit.day, visit.start + ARRIVAL_WINDOW_MINUTES))
              : null,
            cutoff_at: cutoffAt(cutoffRule, start, visit.day, visit.start),
          });
          state.visitId = visitId;
          rows.booking_terms.push({
            booking_id: bookingId,
            business_id: shop.businessId,
            terms_consent_id: null,
            terms_version: TERMS_VERSION,
            terms_language: TERMS_LANGUAGE,
            cutoff_before: cutoffRule.before,
            cutoff_day_before_at: cutoffRule.before === null ? cutoffRule.dayBeforeAt : null,
            cutoff_zone:
              cutoffRule.before === null && cutoffRule.dayBeforeAt !== null ? DEMO_TIME_ZONE : null,
            written_at: at,
          });
          for (const rule of shopRules) {
            needs.ruleIds.add(rule.id);
            rows.booking_terms_rules.push({
              id: `btr-journey-${stageKey}-${rule.id}`,
              booking_id: bookingId,
              business_id: shop.businessId,
              rule_id: rule.id,
              price_ok_limit_id: null,
            });
          }
          for (const limit of shopLimits) {
            needs.priceOkLimitIds.add(limit.id);
            rows.booking_terms_rules.push({
              id: `btr-journey-${stageKey}-${limit.id}`,
              booking_id: bookingId,
              business_id: shop.businessId,
              rule_id: null,
              price_ok_limit_id: limit.id,
            });
          }
        }
      }
      states.push(state);
    }
  }

  const stripeIds = [
    ...rows.saved_cards.flatMap((card) => [card.stripe_customer_id, card.stripe_payment_method_id]),
    ...rows.ledger_lines.map((line) => line.stripe_object_id),
    ...rows.effects.map((effect) => effect.provider_object_id),
  ];
  if (stripeIds.some((id) => CARD_NUMBER_RUN.test(id.replace(/[ -]/g, "")))) {
    throw new Error(
      "refusing to write a Stripe id that holds 13 digits in a row (K-32: never a card number)",
    );
  }
  for (const [table, keys] of [
    ["resources", rows.resources.map((row) => row.id)],
    ["price_rules", rows.price_rules.map((row) => row.id)],
    ["bookings", rows.bookings.map((row) => row.id)],
    ["booking_details numbers", rows.booking_details.map((row) => `${row.business_id} ${row.number}`)],
    ["quotes", rows.quotes.map((row) => row.id)],
    ["quote_options", rows.quote_options.map((row) => row.id)],
    ["booking_lines", rows.booking_lines.map((row) => row.id)],
    ["reservations", rows.reservations.map((row) => row.id)],
    ["booking_addresses", rows.booking_addresses.map((row) => row.id)],
    ["secure_links", rows.secure_links.map((row) => row.id)],
    ["secure_links codes", rows.secure_links.map((row) => row.code_sha256)],
    ["effects", rows.effects.map((row) => row.id)],
    ["saved_cards", rows.saved_cards.map((row) => row.id)],
    ["payments", rows.payments.map((row) => row.id)],
    ["payment_items", rows.payment_items.map((row) => row.id)],
    ["ledger_lines", rows.ledger_lines.map((row) => row.id)],
    ["booking_visits", rows.booking_visits.map((row) => row.id)],
    ["booking_terms_rules", rows.booking_terms_rules.map((row) => row.id)],
  ] as const) {
    requireUnique(table, keys);
  }

  return {
    rows,
    states,
    scenarios,
    seededAt: setup.seededAt,
    needs: {
      customerIds: [...needs.customerIds],
      wayIds: [...needs.wayIds],
      priceRuleIds: [...needs.priceRuleIds],
      personIds: [...needs.personIds],
      locationIds: [...needs.locationIds],
      ruleIds: [...needs.ruleIds],
      priceOkLimitIds: [...needs.priceOkLimitIds],
    },
  };
}

/** Seeds the journey states from fixture set v1 (see the top of this file). */
export async function seedJourneyStates(
  sql: Sql,
  options: JourneySeedOptions = {},
): Promise<JourneySeedResult> {
  return seedJourneyStatesFrom(sql, openFixtureSet(options.fixturesDir));
}

/** The entry every seed set exports under one name, so a runner finds a set by its file name (T-201). */
export const seed = seedJourneyStates;

/**
 * Refuses to write before the seeds this one builds on, naming the first one whose rows are missing: each combo's
 * customer (customers), way and list price (services), pro (core or staff), location's open hours (availability), and
 * the owner's rules and price OK limits a snapshot names (services).
 */
async function requirePriorRows(tx: Tx, plan: JourneySeedPlan): Promise<void> {
  const missing = async (
    what: string,
    run: string,
    ids: readonly string[],
    query: (ids: readonly string[]) => Promise<{ id: string }[]>,
  ): Promise<void> => {
    if (ids.length === 0) {
      return;
    }
    const found = new Set((await query(ids)).map((row) => row.id));
    const absent = ids.filter((id) => !found.has(id));
    if (absent.length > 0) {
      throw new Error(
        `${what} are missing for ${String(absent.length)} of ${String(ids.length)}: run ${run} first (nothing was written)`,
      );
    }
  };
  const { needs } = plan;
  await missing(
    "the pros (the core seed's owners and the staff seed's team)",
    "db/seeds/core.ts and db/seeds/setup-staff.ts",
    needs.personIds,
    (ids) => tx<{ id: string }[]>`select id from persons where id = any(${ids}::text[])`,
  );
  await missing(
    "the services seed's ways",
    "db/seeds/setup-services-rules.ts",
    needs.wayIds,
    (ids) => tx<{ id: string }[]>`select id from service_money where id = any(${ids}::text[])`,
  );
  await missing(
    "the services seed's list prices",
    "db/seeds/setup-services-rules.ts",
    needs.priceRuleIds,
    (ids) => tx<{ id: string }[]>`select id from price_rules where id = any(${ids}::text[])`,
  );
  await missing(
    "the services seed's owner rules",
    "db/seeds/setup-services-rules.ts",
    needs.ruleIds,
    (ids) => tx<{ id: string }[]>`select id from rules where id = any(${ids}::text[])`,
  );
  await missing(
    "the services seed's price OK limits",
    "db/seeds/setup-services-rules.ts",
    needs.priceOkLimitIds,
    (ids) => tx<{ id: string }[]>`select id from price_ok_limits where id = any(${ids}::text[])`,
  );
  await missing(
    "the availability seed's open hours",
    "db/seeds/setup-availability.ts",
    needs.locationIds,
    (ids) =>
      tx<{ id: string }[]>`
        select distinct location_id as id from weekly_hours where location_id = any(${ids}::text[])
      `,
  );
  await missing(
    "the customers seed's customers",
    "db/seeds/customers.ts",
    needs.customerIds,
    (ids) => tx<{ id: string }[]>`select id from customers where id = any(${ids}::text[])`,
  );
}

/** Inserts `rows` with `insert` unless there are none (postgres.js makes no statement of an empty list). */
async function written(count: number, insert: () => Promise<{ count: number }>): Promise<number> {
  return count === 0 ? 0 : (await insert()).count;
}

/** seedJourneyStates, from a fixture set already opened (tests open a temporary copy of the set inside its own jail). */
export async function seedJourneyStatesFrom(sql: Sql, set: FixtureSet): Promise<JourneySeedResult> {
  const verified = verifyFixtureSet(set);
  const plan = journeyStatesPlanOf(verified);
  const { rows } = plan;

  const result = await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${SEED_ROLE}`);
    // The runtime side runs with no business scope (K-05 "Scope"); '' reads as none, as an unset scope does.
    await tx`select set_config(${SCOPE_SETTING}, '', true)`;
    const [who] = await tx<{ role: string }[]>`select current_user as role`;
    await requirePriorRows(tx, plan);

    const inserted: Record<JourneySeedTable, number> = {
      resources: await written(
        rows.resources.length,
        () => tx`
          insert into resources ${tx(rows.resources, "id", "business_id", "kind", "name", "person_id", "active")}
          on conflict (id) do nothing
        `,
      ),
      price_rules: await written(
        rows.price_rules.length,
        () => tx`
          insert into price_rules ${tx(
            rows.price_rules,
            "id",
            "business_id",
            "service_id",
            "price_cents",
            "from_cents",
            "currency",
            "set_by_person_id",
            "effective_from",
          )}
          on conflict (id) do nothing
        `,
      ),
      bookings: await written(
        rows.bookings.length,
        () => tx`
          insert into bookings ${tx(
            rows.bookings,
            "id",
            "business_id",
            "flow",
            "stage",
            "booker_person_id",
            "served_person_id",
            "payer_person_id",
            "private",
            "deceased",
          )}
          on conflict (id) do nothing
        `,
      ),
      booking_details: await written(
        rows.booking_details.length,
        () => tx`
          insert into booking_details ${tx(
            rows.booking_details,
            "booking_id",
            "business_id",
            "number",
            "door",
            "made_by",
            "approval",
            "timing",
            "times",
            "taken",
          )}
          on conflict (booking_id) do nothing
        `,
      ),
      quotes: await written(
        rows.quotes.length,
        () => tx`
          insert into quotes ${tx(
            rows.quotes,
            "id",
            "booking_id",
            "business_id",
            "service_id",
            "basis",
            "priced_by_person_id",
            "priced_at",
            "price_ok_limit_id",
            "state",
            "sent_at",
            "good_until",
            "currency",
          )}
          on conflict (id) do nothing
        `,
      ),
      quote_options: await written(
        rows.quote_options.length,
        () => tx`
          insert into quote_options ${tx(
            rows.quote_options,
            "id",
            "quote_id",
            "business_id",
            "position",
            "label",
            "price_cents",
            "up_to_cents",
          )}
          on conflict (id) do nothing
        `,
      ),
      booking_lines: await written(
        rows.booking_lines.length,
        () => tx`
          insert into booking_lines ${tx(
            rows.booking_lines,
            "id",
            "booking_id",
            "business_id",
            "position",
            "service_id",
            "service_money_id",
            "price_rule_id",
            "quote_option_id",
            "path",
            "price_kind",
            "unit",
            "units",
            "price_cents",
            "from_cents",
            "deposit_cents",
            "fee_cents",
            "currency",
            "paid_by",
          )}
          on conflict (id) do nothing
        `,
      ),
      reservations: await written(
        rows.reservations.length,
        () => tx`
          insert into reservations ${tx(
            rows.reservations,
            "id",
            "business_id",
            "resource_id",
            "resource_kind",
            "worker_person_id",
            "during",
            "state",
            "queued_at",
            "seats",
            "held_until",
            "booking_id",
          )}
          on conflict (id) do nothing
        `,
      ),
      booking_addresses: await written(
        rows.booking_addresses.length,
        () => tx`
          insert into booking_addresses ${tx(
            rows.booking_addresses,
            "id",
            "booking_id",
            "business_id",
            "position",
            "area",
            "address",
            "sealed_for_person_id",
            "zone",
            "state_code",
            "location_id",
            "checked_at",
          )}
          on conflict (id) do nothing
        `,
      ),
      secure_links: await written(
        rows.secure_links.length,
        () => tx`
          insert into secure_links ${tx(
            rows.secure_links,
            "id",
            "booking_id",
            "business_id",
            "purpose",
            "person_id",
            "handle_id",
            "given_via",
            "code_sha256",
            "issued_at",
          )}
          on conflict (id) do nothing
        `,
      ),
      effects: await written(rows.effects.length, () => {
        const values = rows.effects.map((row) => ({ ...row, port_request: tx.json(row.port_request) }));
        return tx`
          insert into effects ${tx(
            values,
            "id",
            "job_id",
            "business_id",
            "booking_id",
            "kind",
            "port",
            "person_id",
            "amount_cents",
            "currency",
            "port_request",
            "idempotency_key",
            "state",
            "tries",
            "runs",
            "first_try_at",
            "last_try_at",
            "provider_object_id",
            "ledger_line_id",
            "trace_id",
            "created_at",
          )}
          on conflict (id) do nothing
        `;
      }),
      saved_cards: await written(
        rows.saved_cards.length,
        () => tx`
          insert into saved_cards ${tx(
            rows.saved_cards,
            "id",
            "business_id",
            "person_id",
            "booking_id",
            "stripe_customer_id",
            "stripe_payment_method_id",
            "save_effect_id",
            "asked_at",
            "saved_at",
          )}
          on conflict (id) do nothing
        `,
      ),
      payments: await written(
        rows.payments.length,
        () => tx`
          insert into payments ${tx(
            rows.payments,
            "id",
            "business_id",
            "payer_person_id",
            "booking_id",
            "purpose",
            "method",
            "amount_cents",
            "currency",
            "state",
            "effect_id",
            "saved_card_id",
            "asked_at",
            "paid_at",
          )}
          on conflict (id) do nothing
        `,
      ),
      payment_items: await written(
        rows.payment_items.length,
        () => tx`
          insert into payment_items ${tx(
            rows.payment_items,
            "id",
            "payment_id",
            "business_id",
            "booking_line_id",
            "share",
            "amount_cents",
            "currency",
          )}
          on conflict (id) do nothing
        `,
      ),
      ledger_lines: await written(
        rows.ledger_lines.length,
        () => tx`
          insert into ledger_lines ${tx(
            rows.ledger_lines,
            "id",
            "business_id",
            "booking_id",
            "kind",
            "amount_cents",
            "currency",
            "payment_id",
            "effect_id",
            "stripe_object_id",
            "moved_at",
            "written_by",
            "written_at",
          )}
          on conflict (id) do nothing
        `,
      ),
      booking_visits: await written(
        rows.booking_visits.length,
        () => tx`
          insert into booking_visits ${tx(
            rows.booking_visits,
            "id",
            "booking_id",
            "business_id",
            "position",
            "reservation_id",
            "arrival_window",
            "cutoff_at",
          )}
          on conflict (id) do nothing
        `,
      ),
      booking_terms: await written(
        rows.booking_terms.length,
        () => tx`
          insert into booking_terms ${tx(
            rows.booking_terms,
            "booking_id",
            "business_id",
            "terms_consent_id",
            "terms_version",
            "terms_language",
            "cutoff_before",
            "cutoff_day_before_at",
            "cutoff_zone",
            "written_at",
          )}
          on conflict (booking_id) do nothing
        `,
      ),
      booking_terms_rules: await written(
        rows.booking_terms_rules.length,
        () => tx`
          insert into booking_terms_rules ${tx(
            rows.booking_terms_rules,
            "id",
            "booking_id",
            "business_id",
            "rule_id",
            "price_ok_limit_id",
          )}
          on conflict (id) do nothing
        `,
      ),
    };
    return { ranAs: who?.role ?? "", inserted };
  });

  const count = (table: JourneySeedTable): CoreSeedTableCount => {
    const total = rows[table].length;
    const inserted = result.inserted[table];
    return { rows: total, inserted, kept: total - inserted };
  };
  const tables = {} as Record<JourneySeedTable, CoreSeedTableCount>;
  for (const table of Object.keys(rows) as JourneySeedTable[]) {
    tables[table] = count(table);
  }
  return {
    ranAs: result.ranAs,
    fixtureSet: {
      dir: verified.dir,
      manifestSha256: verified.manifestSha256,
      filesChecked: verified.filesChecked,
    },
    seededAt: plan.seededAt,
    tables,
    states: plan.states,
  };
}
