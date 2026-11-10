// The closed registry of owner rule kinds, K-26 v1 (contracts/db-schema/rules: the table rule_kinds, which migration 0023
// seeds from fixtures/seed-rule-registry.json; arch 09 lines 480 and 482; C-157). The evaluator knows exactly these 16
// kinds, each with its one value type, and what each one governs; a rule of any other kind, or with a value of another
// type than its kind's, is refused, never ignored (evaluate.ts). A new kind is a registry entry that a migration's seed
// adds and a K-26 minor version records (K-26 README rule 6: "so limit 2's evaluator and the settings pages know it before
// a row uses it"): it reaches the evaluator only by a change here, and registry.test holds this list to the seed.

/** The one type a kind's value takes (K-26 v1 rule_kinds.value_type). */
export type RuleValueType = "on" | "money" | "span" | "count" | "dates" | "note";

/**
 * What a kind governs in a proposal (what a booking, a move or a charge would do), as the K-26 v1 registry's `means` says:
 *   - time: the visit's day or start (ok_same_day, ok_dates, notice, months_offered);
 *   - money: the booking's total, a deposit or a fee (minimum_job, deposit_cap, fee_cap);
 *   - who: the person a new booking is for (ok_new_customer, no_show_count, members_paying_elsewhere, own_customers_only);
 *   - setting: a feature the owner turns on (waitlist, tip_line, bank_transfer_over, one_bill), which holds no booking back;
 *   - note: the owner's own words, which the AI reads and code never enforces (arch 09 line 482).
 */
export type RuleGoverns = "time" | "money" | "who" | "setting" | "note";

export interface RuleKindEntry {
  readonly valueType: RuleValueType;
  /** The plug-in fact a business's kinds of work must list before the rule is offered (K-26 v1 needs_fact); null: any. */
  readonly needsFact: string | null;
  readonly governs: RuleGoverns;
}

/** K-26 v1's 16 rule kinds, in the registry seed's order (seed-rule-registry.json). */
export const RULE_KINDS = {
  /** A same-day booking waits for the owner's OK (A4-98). Unset: books on the yes. */
  ok_same_day: { valueType: "on", needsFact: null, governs: "time" },
  /** A new customer's booking waits for the owner's OK (A4-98; B4-115). Unset: books on the yes. */
  ok_new_customer: { valueType: "on", needsFact: null, governs: "who" },
  /** A booking on these dates waits for the owner's OK; several ranges may be in effect. Unset: no date waits. */
  ok_dates: { valueType: "dates", needsFact: null, governs: "time" },
  /** A booking needs at least this much notice before its start (FS H05). Unset: no notice beyond the times card. */
  notice: { valueType: "span", needsFact: null, governs: "time" },
  /** Bookings are offered only on these dates; several ranges add up (FS H08). Unset: all year. */
  months_offered: { valueType: "dates", needsFact: null, governs: "time" },
  /** The least a booking's total may be, with any extra work (arch 06 line 301). Unset: no minimum. */
  minimum_job: { valueType: "money", needsFact: null, governs: "money" },
  /** The most a deposit may be (S1-21). Unset: no cap beyond the price known then. */
  deposit_cap: { valueType: "money", needsFact: null, governs: "money" },
  /** The most a late-cancel or no-show fee may be (S1-21; FS V08). Unset: no cap beyond what was paid now. */
  fee_cap: { valueType: "money", needsFact: null, governs: "money" },
  /** The business keeps a waitlist for full times (A4-60). Unset: off. */
  waitlist: { valueType: "on", needsFact: "waitlist", governs: "setting" },
  /** A tip line on the bills Rosie sends (FS V11). Unset: off. */
  tip_line: { valueType: "on", needsFact: "tips", governs: "setting" },
  /** A bill over this amount may be paid by bank transfer (FS V12). Unset: off. */
  bank_transfer_over: { valueType: "money", needsFact: "banktransfer", governs: "setting" },
  /** One bill a period for many visits (FS V17). Unset: off. */
  one_bill: { valueType: "on", needsFact: "monthlybill", governs: "setting" },
  /** After this many no-shows or late cancels with no card, a card is needed to book. Unset: off. */
  no_show_count: { valueType: "count", needsFact: null, governs: "who" },
  /** Take bookings from members who pay elsewhere; off: those bookings are declined (A4-80). Unset: on. */
  members_paying_elsewhere: { valueType: "on", needsFact: "packs", governs: "who" },
  /** Only the business's own customers may book (FS K10; A4-43). Unset: off. */
  own_customers_only: { valueType: "on", needsFact: null, governs: "who" },
  /** The owner's own words, which the AI reads and code never enforces (arch 09 line 482). Unset: no note. */
  note: { valueType: "note", needsFact: null, governs: "note" },
} as const satisfies Readonly<Record<string, RuleKindEntry>>;

/** A kind in the K-26 v1 registry. */
export type RuleKind = keyof typeof RULE_KINDS;

/** The registry's kinds, in its order. */
export const RULE_KIND_NAMES = Object.keys(RULE_KINDS) as readonly RuleKind[];

/** Whether a name is a kind of the K-26 v1 registry (an own key of RULE_KINDS, never one inherited). */
export function isRuleKind(name: string): name is RuleKind {
  return Object.hasOwn(RULE_KINDS, name);
}

/** A kind's registry entry. */
export function kindEntry(kind: RuleKind): RuleKindEntry {
  return RULE_KINDS[kind];
}
