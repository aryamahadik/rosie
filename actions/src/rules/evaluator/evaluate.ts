// The owner rule evaluator (C-082, T-300; arch 06 line 301: "One rule evaluator, shared with search, passes every typed
// rule"; arch 05 line 237: "Every filter is exact, including the owner's own rules"). Plain code with no reads and no
// writes: limit 2 at the gate, and search (C-097) for each candidate row, hand it the business's K-26 v1 rules rows and
// one proposal, and get one verdict, so the gate and search never disagree about a rule.
//
// In this order:
//   1. Every row is checked against the closed K-26 v1 registry (registry.ts): its kind known, its value of the kind's one
//      type and in range, its scope and dates in form. Any row that fails refuses the whole verdict, in effect or not, in
//      scope or not: a rule the evaluator cannot read is never ignored, since it may be the one that forbids the proposal.
//   2. The rules that apply: the proposal's business's rules in effect at its rulesAt (effective_from inclusive,
//      effective_to exclusive: arch 09 line 488), in its scope (a flow's rule for that flow, a kind of work's for that
//      kind). Where one kind has rules in several scopes, the most specific wins: kind and flow, then kind, then flow,
//      then the whole business (K-26 README, "Effective dates and scope").
//   3. Each rule, each dates kind's rules of one scope (their ranges add up), and a note kind's rules once, are checked
//      against the proposal as the kind governs it. Any broken check makes the verdict broken, each saying what its rule
//      allows (arch 06 line 301: "Rosie says what the rule allows"); else it holds, with the notes for the owner's
//      booking card and whether an OK rule makes the booking wait for the owner's OK.
// What it returns names rule ids, kinds, labels, amounts, days and instants: never the owner's words or a person's.
//
// Defaults used (for ops/QUESTIONS.md):
//   1. A proposal whose flow or kind of work is not known gets every flow's or kind's rules, and none wins over another:
//      each must hold (the stricter reading, never the looser), a dates kind's ranges adding up only within one scope.
//      With both known, the most specific scope wins.
//   2. The minimum is held on the price and every extra added up in the minimum's currency; an amount in another currency
//      cannot be shown to meet it, so the minimum is broken (fails closed). The same holds for a deposit or fee cap.
//   3. A photo quote not priced yet has no total: its minimum does not apply until it is priced (A4-05: "checked when it
//      is priced, before any yes"). A price set only at the visit or by the hour holds, noted minimumNotChecked for the
//      owner's booking card (arch 06 line 301, DD).
//   4. The OK rules (ok_same_day, ok_new_customer, ok_dates) never break: where one applies the booking waits for the
//      owner's OK (A4-98, B4-115), which the verdict says (ownerOkFirst). "Same day" is the visit's day in the business's
//      zone being the day the proposal is made there; a dates rule's days are the business's (K-26 README rule 8).
//   5. The settings kinds (waitlist, tip_line, bank_transfer_over, one_bill) turn features on and hold no booking back, and
//      a note is never enforced: each is not applicable. A deposit or fee cap is held as the owner's own rule (S1-21).
//   6. members_paying_elsewhere unset means on (the K-26 registry), so with no rule members who pay elsewhere are booked;
//      no_show_count breaks when the count is reached and no card is on file.
//   7. A notice's earliest start is the proposal's time plus the notice; what it allows is shown in the visit's zone.

import { isZone, wallOf } from "../../values";
import { RULE_KINDS, RULE_KIND_NAMES, isRuleKind, type RuleKind, type RuleValueType } from "./registry";
import type {
  Allowance,
  BrokenCheck,
  Day,
  DayRange,
  Money,
  NotApplicableWhy,
  NotedCheck,
  OwnerRule,
  Proposal,
  RefusedRule,
  RefusedWhy,
  RuleCheck,
  RuleRow,
  RuleValue,
  RulesVerdict,
} from "./types";

const MINUTE_MS = 60_000;
/** A registry-shaped kind name (K-26 v1 rule_kinds_id_form). */
const KIND_NAME_FORM = /^[a-z]+(?:_[a-z]+)*$/u;
/** A kind of work's id (K-26 v1 rules_kind_id_form; K-23 company_kinds_kind_id_form). */
const KIND_ID_FORM = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
/** A currency code (CQ-09; K-26 v1 rules_value_in_range). */
const CURRENCY_FORM = /^[A-Z]{3}$/u;
const DAY_FORM = /^(\d{4})-(\d{2})-(\d{2})$/u;

// ---- reading a row ----------------------------------------------------------------------------------------------------

/** Whether a value is a calendar day written YYYY-MM-DD. */
export function isDay(value: string): boolean {
  const match = DAY_FORM.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** An instant's epoch milliseconds, or null when the value is no instant. */
function instantOf(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

const isMoney = (cents: number, currency: string): boolean =>
  Number.isSafeInteger(cents) && cents >= 0 && CURRENCY_FORM.test(currency);

/** A row's value in its kind's one type, or null when it is missing or out of range (K-26 v1 rules_value_*). */
function valueOf(type: RuleValueType, row: RuleRow): RuleValue | null {
  switch (type) {
    case "on":
      return row.valueOn === null ? null : { type, on: row.valueOn };
    case "money": {
      const { valueCents: cents, valueCurrency: currency } = row;
      if (cents === null || currency === null || !isMoney(cents, currency)) return null;
      return { type, money: { cents, currency } };
    }
    case "span": {
      const minutes = row.valueSpanMinutes;
      return minutes !== null && Number.isFinite(minutes) && minutes > 0 ? { type, minutes } : null;
    }
    case "count": {
      const count = row.valueCount;
      return count !== null && Number.isSafeInteger(count) && count >= 1 ? { type, count } : null;
    }
    case "dates": {
      if (row.valueDates === null) return null;
      const { from, until } = row.valueDates;
      if ((from !== null && !isDay(from)) || (until !== null && !isDay(until))) return null;
      if (from !== null && until !== null && from >= until) return null;
      return { type, days: { from, until } };
    }
    case "note":
      return { type };
  }
}

/** A row read against the registry: the typed rule, or why it is refused. */
export type RuleReading =
  { readonly ok: true; readonly rule: OwnerRule } | { readonly ok: false; readonly refused: RefusedRule };

/** Reads one K-26 v1 rules row against the closed registry (step 1): a kind not in it is refused, never ignored. */
export function readRule(row: RuleRow): RuleReading {
  const refuse = (why: RefusedWhy): RuleReading => ({
    ok: false,
    refused: { ruleId: row.id, kind: KIND_NAME_FORM.test(row.ruleKind) ? row.ruleKind : null, why },
  });
  if (!isRuleKind(row.ruleKind)) return refuse("unknownKind");
  const kind = row.ruleKind;
  const { valueType } = RULE_KINDS[kind];
  if (row.valueType !== valueType) return refuse("wrongType");
  const flow = row.flow === null || row.flow === "A" || row.flow === "B" ? row.flow : undefined;
  if (flow === undefined) return refuse("badScope");
  if (row.kindId !== null && !KIND_ID_FORM.test(row.kindId)) return refuse("badScope");
  const from = instantOf(row.effectiveFrom);
  const to = row.effectiveTo === null ? null : instantOf(row.effectiveTo);
  if (from === null || (row.effectiveTo !== null && (to === null || to <= from))) return refuse("badDates");
  const value = valueOf(valueType, row);
  if (value === null) return refuse("badValue");
  return {
    ok: true,
    rule: {
      id: row.id,
      businessId: row.businessId,
      kind,
      flow,
      kindId: row.kindId,
      value,
      effectiveFrom: from,
      effectiveTo: to,
    },
  };
}

// ---- the rules that apply (step 2) --------------------------------------------------------------------------------

const inEffect = (rule: OwnerRule, at: number): boolean =>
  rule.effectiveFrom <= at && (rule.effectiveTo === null || at < rule.effectiveTo);

const inScope = (rule: OwnerRule, proposal: Proposal): boolean =>
  rule.businessId === proposal.businessId &&
  (rule.flow === null || proposal.flow === null || rule.flow === proposal.flow) &&
  (rule.kindId === null || proposal.kindId === null || rule.kindId === proposal.kindId);

/** How specific a rule's scope is: kind and flow 3, kind 2, flow 1, the whole business 0. */
const rankOf = (rule: OwnerRule): number => (rule.kindId === null ? 0 : 2) + (rule.flow === null ? 0 : 1);

const byId = (a: OwnerRule, b: OwnerRule): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The rules that apply to a proposal at `at` (epoch ms), by kind in the registry's order, each kind's rules by id: in
 * effect, in scope, and with flow and kind of work both known the most specific scope only (default 1).
 */
export function rulesThatApply(
  rules: readonly OwnerRule[],
  proposal: Proposal,
  at: number,
): ReadonlyMap<RuleKind, readonly OwnerRule[]> {
  const byKind = new Map<RuleKind, OwnerRule[]>();
  for (const rule of rules) {
    if (!inEffect(rule, at) || !inScope(rule, proposal)) continue;
    const list = byKind.get(rule.kind);
    if (list === undefined) byKind.set(rule.kind, [rule]);
    else list.push(rule);
  }
  const mostSpecific = proposal.flow !== null && proposal.kindId !== null;
  const applying = new Map<RuleKind, readonly OwnerRule[]>();
  for (const kind of RULE_KIND_NAMES) {
    const list = byKind.get(kind);
    if (list === undefined) continue;
    const top = Math.max(...list.map(rankOf));
    const kept = mostSpecific ? list.filter((rule) => rankOf(rule) === top) : list;
    applying.set(kind, [...kept].sort(byId));
  }
  return applying;
}

// ---- checking a proposal (step 3) ---------------------------------------------------------------------------------

/** The proposal's instants, read once. */
interface Run {
  readonly proposal: Proposal;
  /** The instant whose rules apply. */
  readonly rulesAt: number;
  readonly madeAt: number;
  /** The visit's start, or null when the proposal sets no time. */
  readonly visit: number | null;
}

type Of = Pick<RuleCheck, "kind" | "ruleIds">;

const ofRules = (kind: RuleKind, rules: readonly OwnerRule[]): Of => ({
  kind,
  ruleIds: rules.map((rule) => rule.id),
});
const holds = (of: Of): RuleCheck => ({ ...of, result: "holds" });
const notApplicable = (of: Of, why: NotApplicableWhy): RuleCheck => ({ ...of, result: "notApplicable", why });
const ownerOkFirst = (of: Of): RuleCheck => ({ ...of, result: "ownerOkFirst" });
const broken = (of: Of, allows: Allowance): RuleCheck => ({ ...of, result: "broken", allows });

/** The rule's value, which readRule typed by its kind (a mismatch cannot be read, so it throws). */
function onOf(rule: OwnerRule): boolean {
  const { value } = rule;
  if (value.type !== "on") throw new TypeError("an on rule without an on value");
  return value.on;
}
function moneyOf(rule: OwnerRule): Money {
  const { value } = rule;
  if (value.type !== "money") throw new TypeError("a money rule without an amount");
  return { cents: value.money.cents, currency: value.money.currency };
}
function spanOf(rule: OwnerRule): number {
  const { value } = rule;
  if (value.type !== "span") throw new TypeError("a span rule without a span");
  return value.minutes;
}
function countOf(rule: OwnerRule): number {
  const { value } = rule;
  if (value.type !== "count") throw new TypeError("a count rule without a count");
  return value.count;
}
function daysOf(rule: OwnerRule): DayRange {
  const { value } = rule;
  if (value.type !== "dates") throw new TypeError("a dates rule without its days");
  return { from: value.days.from, until: value.days.until };
}

const pad = (value: number, width: number): string => String(value).padStart(width, "0");

/** The day an instant falls on in a zone, YYYY-MM-DD. */
export function dayOf(instantMs: number, zone: string): Day {
  const { year, month, day } = wallOf(instantMs, zone);
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** Whether a day lies in a range [from, until). */
export function inDays(day: Day, range: DayRange): boolean {
  return (range.from === null || range.from <= day) && (range.until === null || day < range.until);
}

/** A UTC instant written as the shared formats write it, without milliseconds when there are none. */
function utcOf(instantMs: number): string {
  return new Date(instantMs).toISOString().replace(".000Z", "Z");
}

const rangeOrder = (a: DayRange, b: DayRange): number => {
  const from = (a.from ?? "") < (b.from ?? "") ? -1 : (a.from ?? "") > (b.from ?? "") ? 1 : 0;
  if (from !== 0) return from;
  return (a.until ?? "~") < (b.until ?? "~") ? -1 : (a.until ?? "~") > (b.until ?? "~") ? 1 : 0;
};

/** ok_dates over all its rules that apply: the visit's day in any range makes the booking wait for the owner's OK. */
function okDatesCheck(rules: readonly OwnerRule[], run: Run): RuleCheck {
  const of = ofRules("ok_dates", rules);
  if (run.visit === null) return notApplicable(of, "notInProposal");
  const day = dayOf(run.visit, run.proposal.businessZone);
  return rules.some((rule) => inDays(day, daysOf(rule))) ? ownerOkFirst(of) : holds(of);
}

/** months_offered over all its rules that apply: the ranges add up, and a day in none breaks it. */
function monthsCheck(rules: readonly OwnerRule[], run: Run): RuleCheck {
  const of = ofRules("months_offered", rules);
  if (run.visit === null) return notApplicable(of, "notInProposal");
  const day = dayOf(run.visit, run.proposal.businessZone);
  const ranges = rules.map(daysOf);
  if (ranges.some((range) => inDays(day, range))) return holds(of);
  return broken(of, { kind: "dates", days: [...ranges].sort(rangeOrder) });
}

/** minimum_job on the booking's total with any extra work (arch 06 line 301; defaults 2 and 3). */
function minimumCheck(rule: OwnerRule, run: Run): RuleCheck {
  const of = ofRules(rule.kind, [rule]);
  const minimum = moneyOf(rule);
  const { price } = run.proposal;
  if (price === null) return notApplicable(of, "notInProposal");
  if (price.basis === "atVisit" || price.basis === "hourly") {
    return { ...of, result: "noted", note: "minimumNotChecked" };
  }
  if (price.price === null) return notApplicable(of, "notPricedYet");
  const amounts = [price.price, ...price.extras];
  const sameCurrency = amounts.every((amount) => amount.currency === minimum.currency);
  const total = amounts.reduce((sum, amount) => sum + amount.cents, 0);
  return sameCurrency && total >= minimum.cents
    ? holds(of)
    : broken(of, { kind: "minimum", atLeast: minimum });
}

/** deposit_cap or fee_cap: the amount the proposal takes is at most the cap (default 2). */
function capCheck(rule: OwnerRule, amount: Money | null, what: "deposit" | "fee"): RuleCheck {
  const of = ofRules(rule.kind, [rule]);
  const cap = moneyOf(rule);
  if (amount === null) return notApplicable(of, "notInProposal");
  return amount.currency === cap.currency && amount.cents <= cap.cents
    ? holds(of)
    : broken(of, { kind: "atMost", of: what, cap });
}

/** One rule against the proposal, as its kind governs it. */
function checkOne(rule: OwnerRule, run: Run): RuleCheck {
  const of = ofRules(rule.kind, [rule]);
  const { proposal } = run;
  const { customer } = proposal;
  switch (rule.kind) {
    case "ok_same_day": {
      if (!onOf(rule)) return holds(of);
      if (run.visit === null) return notApplicable(of, "notInProposal");
      const zone = proposal.businessZone;
      return dayOf(run.visit, zone) === dayOf(run.madeAt, zone) ? ownerOkFirst(of) : holds(of);
    }
    case "ok_new_customer":
      if (!onOf(rule)) return holds(of);
      if (customer === null) return notApplicable(of, "notInProposal");
      return customer.isNew ? ownerOkFirst(of) : holds(of);
    case "ok_dates":
      return okDatesCheck([rule], run);
    case "notice": {
      if (run.visit === null || proposal.visitAt === null) return notApplicable(of, "notInProposal");
      const minutes = spanOf(rule);
      const earliest = run.madeAt + minutes * MINUTE_MS;
      if (run.visit >= earliest) return holds(of);
      return broken(of, {
        kind: "notice",
        minutes,
        from: { utc: utcOf(earliest), zone: proposal.visitAt.zone },
      });
    }
    case "months_offered":
      return monthsCheck([rule], run);
    case "minimum_job":
      return minimumCheck(rule, run);
    case "deposit_cap":
      return capCheck(rule, proposal.deposit, "deposit");
    case "fee_cap":
      return capCheck(rule, proposal.fee, "fee");
    case "waitlist":
    case "tip_line":
    case "bank_transfer_over":
    case "one_bill":
      return notApplicable(of, "setting");
    case "no_show_count": {
      if (customer === null) return notApplicable(of, "notInProposal");
      const count = countOf(rule);
      return customer.noShows >= count && !customer.cardOnFile
        ? broken(of, { kind: "cardToBook", afterNoShows: count })
        : holds(of);
    }
    case "members_paying_elsewhere":
      if (customer === null) return notApplicable(of, "notInProposal");
      return !onOf(rule) && customer.memberPayingElsewhere
        ? broken(of, { kind: "noMembersPayingElsewhere" })
        : holds(of);
    case "own_customers_only":
      if (customer === null) return notApplicable(of, "notInProposal");
      return onOf(rule) && !customer.isOwn ? broken(of, { kind: "ownCustomersOnly" }) : holds(of);
    case "note":
      return notApplicable(of, "note");
  }
}

/**
 * A dates kind's rules by scope (flow and kind of work), in order: the ranges of one scope add up, and where several
 * scopes apply (a proposal whose flow or kind of work is not known: default 1) each scope's ranges are checked on their
 * own, so one scope's days never widen another's.
 */
function byScope(rules: readonly OwnerRule[]): OwnerRule[][] {
  const groups = new Map<string, OwnerRule[]>();
  for (const rule of rules) {
    const key = JSON.stringify([rule.flow, rule.kindId]);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [rule]);
    else group.push(rule);
  }
  return [...groups.values()];
}

/** One kind's checks: a dates kind once per scope over its rules, a note once, any other kind once per rule. */
function checksOfKind(kind: RuleKind, rules: readonly OwnerRule[], run: Run): RuleCheck[] {
  switch (kind) {
    case "ok_dates":
      return byScope(rules).map((group) => okDatesCheck(group, run));
    case "months_offered":
      return byScope(rules).map((group) => monthsCheck(group, run));
    case "note":
      return [notApplicable(ofRules(kind, rules), "note")];
    default:
      return rules.map((rule) => checkOne(rule, run));
  }
}

const isWholeMoney = (money: Money): boolean =>
  Number.isSafeInteger(money.cents) && CURRENCY_FORM.test(money.currency);

/**
 * The proposal's instants as epoch ms. A proposal the evaluator cannot read (an instant that is none, a zone the platform
 * does not know, an amount that is not whole cents with a currency code, a count that is no whole number) is a fault of
 * whoever made it: it throws, so nothing passes on it. The message names no value.
 */
function readProposal(proposal: Proposal): Run {
  const rulesAt = instantOf(proposal.rulesAt);
  const madeAt = instantOf(proposal.madeAt);
  const visit = proposal.visitAt === null ? null : instantOf(proposal.visitAt.utc);
  if (rulesAt === null || madeAt === null) throw new TypeError("the proposal's times are not instants");
  if (proposal.visitAt !== null && (visit === null || !isZone(proposal.visitAt.zone))) {
    throw new TypeError("the proposal's visit is not an instant in a zone");
  }
  if (!isZone(proposal.businessZone)) throw new TypeError("the proposal's business zone is not a zone");
  const { price, deposit, fee, customer } = proposal;
  const amounts = [
    ...(price === null ? [] : [...(price.price === null ? [] : [price.price]), ...price.extras]),
    ...(deposit === null ? [] : [deposit]),
    ...(fee === null ? [] : [fee]),
  ];
  if (!amounts.every(isWholeMoney)) throw new TypeError("the proposal's amounts are not whole cents");
  if (customer !== null && !(Number.isSafeInteger(customer.noShows) && customer.noShows >= 0)) {
    throw new TypeError("the proposal's no-show count is not a whole number");
  }
  return { proposal, rulesAt, madeAt, visit };
}

/**
 * The evaluator: every K-26 v1 rules row the business has, checked against the registry, then the rules that apply to
 * the proposal checked against it. One verdict: refused (a row it cannot read, never ignored), broken (with what each
 * broken rule allows), or holds (with the owner's notes and whether the owner's OK comes first).
 */
export function evaluateRules(rows: readonly RuleRow[], proposal: Proposal): RulesVerdict {
  const run = readProposal(proposal);
  const rules: OwnerRule[] = [];
  const refused: RefusedRule[] = [];
  for (const row of rows) {
    const reading = readRule(row);
    if (reading.ok) rules.push(reading.rule);
    else refused.push(reading.refused);
  }
  const [firstRefused, ...moreRefused] = refused;
  if (firstRefused !== undefined) return { result: "refused", refused: [firstRefused, ...moreRefused] };

  const checks: RuleCheck[] = [];
  for (const [kind, applying] of rulesThatApply(rules, proposal, run.rulesAt)) {
    checks.push(...checksOfKind(kind, applying, run));
  }
  const brokenChecks = checks.filter((check): check is BrokenCheck => check.result === "broken");
  const [firstBroken, ...moreBroken] = brokenChecks;
  if (firstBroken !== undefined) return { result: "broken", broken: [firstBroken, ...moreBroken], checks };
  return {
    result: "holds",
    checks,
    notes: checks.filter((check): check is NotedCheck => check.result === "noted"),
    ownerOkFirst: checks.some((check) => check.result === "ownerOkFirst"),
  };
}
