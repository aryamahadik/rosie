// What the owner rule evaluator (C-082, T-300) reads and says. It reads K-26 v1's rules rows (the owner's typed rules)
// and one proposal (what a booking, a move or a charge would do, as limit 2 at the gate or search for one candidate row
// asks: arch 06 line 301, arch 05 line 237), and says for each rule whether it holds, and on failure what the rule allows.
// It names rule ids, kinds, labels, amounts, days and instants: never the owner's words (a rule's `words`, which the AI
// reads, are not read here) and never a person's.

import type { Money, Time } from "../../../../contracts/generated/common/formats.v1";
import type { RuleKind } from "./registry";

export type { Money, Time };

/** A day in the business's zone, written YYYY-MM-DD (K-26 v1 rules.value_dates: "days in the business's zone"). */
export type Day = string;

/**
 * A range of days [from, until): from its first day up to, not including, `until`, as PostgreSQL writes a daterange in its
 * canonical form; a null end is open (K-26 v1 rules.value_dates).
 */
export interface DayRange {
  readonly from: Day | null;
  readonly until: Day | null;
}

/**
 * One K-26 v1 `rules` row as a data-access read hands it over, its kind and value not yet checked against the registry.
 * The owner's `words` are left out: the evaluator never reads them.
 */
export interface RuleRow {
  readonly id: string;
  readonly businessId: string;
  /** rules.rule_kind, checked against the closed registry (registry.ts). */
  readonly ruleKind: string;
  /** rules.value_type, which must be the kind's one type. */
  readonly valueType: string;
  /** rules.flow: A or B; null for both. */
  readonly flow: string | null;
  /** rules.kind_id: the kind of work (K-23 company_kinds.kind_id); null for all the business's kinds. */
  readonly kindId: string | null;
  readonly valueOn: boolean | null;
  readonly valueCents: number | null;
  readonly valueCurrency: string | null;
  /** rules.value_span as whole minutes (the read turns the interval into minutes); null for any other type. */
  readonly valueSpanMinutes: number | null;
  readonly valueCount: number | null;
  readonly valueDates: DayRange | null;
  /** When it took effect, a UTC instant (rules.effective_from). */
  readonly effectiveFrom: string;
  /** When it stopped, a UTC instant; null while in effect (rules.effective_to). */
  readonly effectiveTo: string | null;
}

/** A rule's value, typed by its kind's one value type (K-26 v1 rules_value_matches_type). */
export type RuleValue =
  | { readonly type: "on"; readonly on: boolean }
  | { readonly type: "money"; readonly money: Money }
  | { readonly type: "span"; readonly minutes: number }
  | { readonly type: "count"; readonly count: number }
  | { readonly type: "dates"; readonly days: DayRange }
  | { readonly type: "note" };

/** A rule the evaluator has checked against the registry: its kind known and its value of the kind's type. */
export interface OwnerRule {
  readonly id: string;
  readonly businessId: string;
  readonly kind: RuleKind;
  readonly flow: "A" | "B" | null;
  readonly kindId: string | null;
  readonly value: RuleValue;
  /** effective_from and effective_to as epoch milliseconds; null: in effect. */
  readonly effectiveFrom: number;
  readonly effectiveTo: number | null;
}

/**
 * Why a row is refused, never ignored:
 *   unknownKind  its kind is not in the K-26 v1 registry (refuse-unknown-rule-kind.json: phone_line);
 *   wrongType    its value type is not its kind's one type (rules_kind_fk);
 *   badValue     its value is missing or out of range for its type (rules_value_matches_type, rules_value_in_range);
 *   badScope     its flow is not A or B, or its kind of work is out of form (rules_flow_known, rules_kind_id_form);
 *   badDates     its effective dates are not instants in order (rules_dates_in_order).
 */
export type RefusedWhy = "unknownKind" | "wrongType" | "badValue" | "badScope" | "badDates";

export interface RefusedRule {
  readonly ruleId: string;
  /** The kind as the row names it when it is a registry-shaped name (lowercase words joined by underscores); else null. */
  readonly kind: string | null;
  readonly why: RefusedWhy;
}

/**
 * How a price is set (A4-05 "From the list, from photos, or at the visit?"; arch 06 line 301 adds by the hour): from the
 * price list, quoted from photos, at the visit, or by the hour.
 */
export type PriceBasis = "list" | "photoQuote" | "atVisit" | "hourly";

/**
 * The booking's price as a proposal sets it: its basis, the price before any extra work (`price`), and the extra work on
 * the booking, each amount on its own (`extras`; arch 06 line 301: "the booking's total with any extra work"). A price
 * goes without its amount only as the sources allow (the lead's ruling, DL-328): a photo quote not priced yet, and a
 * price set at the visit or by the hour. A list price always has its amount. A price outside this type (a list price
 * with no amount, a basis not named here) cannot be read: the evaluator throws, so nothing passes on it.
 */
export type ProposedPrice =
  /** From the price list: its amount is always given. */
  | { readonly basis: "list"; readonly price: Money; readonly extras: readonly Money[] }
  /** Quoted from photos: null until it is priced, its minimum checked then (A4-05: "checked when it is priced"). */
  | { readonly basis: "photoQuote"; readonly price: Money | null; readonly extras: readonly Money[] }
  /** Set at the visit or by the hour: nobody knows the total before the visit, so a price given is not read. */
  | { readonly basis: "atVisit" | "hourly"; readonly price: Money | null; readonly extras: readonly Money[] };

/** What the who-rules read about the person a new booking is for. */
export interface CustomerFacts {
  /** A new customer of the business (ok_new_customer; A4-98). */
  readonly isNew: boolean;
  /** One of the business's own customers (own_customers_only; FS K10). */
  readonly isOwn: boolean;
  /** A member who pays elsewhere (members_paying_elsewhere; A4-80). */
  readonly memberPayingElsewhere: boolean;
  /** Their no-shows and late cancels with no card (no_show_count). */
  readonly noShows: number;
  /** A card is on file for this booking (no_show_count: "a card is needed to book"). */
  readonly cardOnFile: boolean;
}

/**
 * What one booking, move or charge would do, as far as owner rules read it: limit 2 asks it of a part's walk, search of
 * one candidate row. A facet left null is not part of the proposal, so the rules that govern only it do not apply.
 */
export interface Proposal {
  /** The business whose rules apply. */
  readonly businessId: string;
  /** The business's zone (K-04 businesses.time_zone): rule dates and "same day" are days in it (K-26 README rule 8). */
  readonly businessZone: string;
  /** The visit's flow; null when not known, so every flow's rules apply. */
  readonly flow: "A" | "B" | null;
  /** The kind of work (K-23 company_kinds.kind_id); null when not known, so every kind's rules apply. */
  readonly kindId: string | null;
  /**
   * The instant whose rules apply, UTC: for a new booking the time it is made; for one already made, the time it was made,
   * since a booking keeps the rules it was made with (S1-21; S11-57: "for new bookings only").
   */
  readonly rulesAt: string;
  /** When the proposal is made, UTC (the turn's now): notice counts from it, and "same day" is its day. */
  readonly madeAt: string;
  /** The visit's start in the visit's zone, when the proposal sets or moves it; null otherwise. */
  readonly visitAt: Time | null;
  /** The booking's price, when the proposal sets it; null otherwise (a move keeps the price it was made with). */
  readonly price: ProposedPrice | null;
  /** A deposit the proposal takes; null for none. */
  readonly deposit: Money | null;
  /** A late-cancel or no-show fee the proposal charges; null for none. */
  readonly fee: Money | null;
  /** The person a new booking is for; null when the proposal makes no new booking. */
  readonly customer: CustomerFacts | null;
}

/** What a broken rule allows: what Rosie says when it fails (arch 06 line 301: "Rosie says what the rule allows"). */
export type Allowance =
  /** minimum_job: a total of at least this, with any extra work. */
  | { readonly kind: "minimum"; readonly atLeast: Money }
  /** notice: a start at or after `from` (the proposal's time plus the notice), shown in the visit's zone. */
  | { readonly kind: "notice"; readonly minutes: number; readonly from: Time }
  /** months_offered: a day in one of these ranges (every range in effect, which add up), in order. */
  | { readonly kind: "dates"; readonly days: readonly DayRange[] }
  /** deposit_cap or fee_cap: a deposit or fee of at most this. */
  | { readonly kind: "atMost"; readonly of: "deposit" | "fee"; readonly cap: Money }
  /** own_customers_only: only the business's own customers book. */
  | { readonly kind: "ownCustomersOnly" }
  /** members_paying_elsewhere off: members who pay elsewhere are not booked. */
  | { readonly kind: "noMembersPayingElsewhere" }
  /** no_show_count: after this many no-shows or late cancels, a booking needs a card on file. */
  | { readonly kind: "cardToBook"; readonly afterNoShows: number };

/** A note for the owner's booking card (arch 06 line 301: "the owner's booking card says the minimum could not be checked"). */
export type RuleNote = "minimumNotChecked";

/**
 * Why a rule in effect does not apply to this proposal:
 *   notInProposal  the proposal has nothing it governs (no time, price, deposit, fee or new booking);
 *   notPricedYet   a photo quote not priced yet: its minimum is checked when it is priced (A4-05);
 *   setting        it turns a feature on and holds no booking back (waitlist, tip_line, bank_transfer_over, one_bill);
 *   note           the owner's own words, which code never enforces (arch 09 line 482).
 */
export type NotApplicableWhy = "notInProposal" | "notPricedYet" | "setting" | "note";

interface CheckOf {
  readonly kind: RuleKind;
  /** The rules the check read: one rule, or for a dates or note kind every one of its rules that applies. */
  readonly ruleIds: readonly string[];
}

/**
 * One rule's check (or one dates or note kind's, over all its rules that apply):
 *   holds          the rule holds;
 *   notApplicable  it governs nothing in this proposal;
 *   ownerOkFirst   an OK rule applies: the booking waits for the owner's OK (A4-98), which never refuses it;
 *   noted          it holds with a note on the owner's booking card;
 *   broken         it fails, and says what it allows.
 */
export type RuleCheck =
  | (CheckOf & { readonly result: "holds" })
  | (CheckOf & { readonly result: "notApplicable"; readonly why: NotApplicableWhy })
  | (CheckOf & { readonly result: "ownerOkFirst" })
  | (CheckOf & { readonly result: "noted"; readonly note: RuleNote })
  | (CheckOf & { readonly result: "broken"; readonly allows: Allowance });

export type BrokenCheck = Extract<RuleCheck, { result: "broken" }>;
export type NotedCheck = Extract<RuleCheck, { result: "noted" }>;

/**
 * The evaluator's verdict on one proposal:
 *   refused  a row it cannot read (an unknown kind, a wrong type, a bad value, scope or dates): never ignored, so nothing
 *            passes on it, whatever the other rules say;
 *   broken   at least one rule fails: each broken check says what its rule allows;
 *   holds    every rule that applies holds, with the notes for the owner's booking card and whether an OK rule makes the
 *            booking wait for the owner's OK first.
 */
export type RulesVerdict =
  | { readonly result: "refused"; readonly refused: readonly [RefusedRule, ...RefusedRule[]] }
  | {
      readonly result: "broken";
      readonly broken: readonly [BrokenCheck, ...BrokenCheck[]];
      readonly checks: readonly RuleCheck[];
    }
  | {
      readonly result: "holds";
      readonly checks: readonly RuleCheck[];
      readonly notes: readonly NotedCheck[];
      readonly ownerOkFirst: boolean;
    };
