// Price rules' effective dates and conditions (C-096, T-320; arch 05 line 253; arch 09 lines 457, 478, 488; K-25 v1
// "Prices"): plain functions over rows, which the service uses to close one row and open the next, to refuse two rules
// of one service with the same conditions in effect at once, and to catch a possible tie at the second save.
//
//   - A rule prices visits that start in [effective_from, effective_to): a null end is open, and a rule closed at its own
//     start (withdrawn before it started) holds no instant and overlaps no rule, as K-25's EXCLUDE reads it.
//   - The same conditions are K-25 price_rules_one_in_effect's key: the place, the worker, the days and the clock times,
//     a missing clock time being the day's start or end.
//   - A possible tie is two rules of one service with as many conditions set (place, worker, time: 0 to 3) and not the
//     same conditions, that can both apply to one booking at some instant both are in effect: the same place or one has
//     none, the same worker or one has none, and days and clock times that meet.

import { clockSeconds, msOf } from "./rows";
import type { PriceConditions, PriceRuleRow } from "./types";

/** A rule's dates as milliseconds: [from, to), a null end open. */
export interface Range {
  readonly from: number;
  readonly to: number | null;
}

export function rangeOf(rule: Pick<PriceRuleRow, "effectiveFrom" | "effectiveTo">): Range {
  return { from: msOf(rule.effectiveFrom), to: rule.effectiveTo === null ? null : msOf(rule.effectiveTo) };
}

/** A range closed at its own start holds no instant (a price withdrawn before it started). */
export function isEmpty(range: Range): boolean {
  return range.to !== null && range.to <= range.from;
}

/** Whether two ranges share an instant (tstzrange's &&): never when either is empty. */
export function overlaps(a: Range, b: Range): boolean {
  if (isEmpty(a) || isEmpty(b)) return false;
  return (b.to === null || a.from < b.to) && (a.to === null || b.from < a.to);
}

/** Whether a rule is in effect at an instant: [from, to) holds it. */
export function inEffectAt(rule: Pick<PriceRuleRow, "effectiveFrom" | "effectiveTo">, at: number): boolean {
  const range = rangeOf(rule);
  return !isEmpty(range) && range.from <= at && (range.to === null || at < range.to);
}

/** The day's start and end of a clock condition, in seconds: a missing one is the day's start or end. */
function clockRange(conditions: PriceConditions): { readonly from: number; readonly until: number } {
  return {
    from: conditions.fromTime === null ? 0 : (clockSeconds(conditions.fromTime) ?? 0),
    until: conditions.untilTime === null ? 86_400 : (clockSeconds(conditions.untilTime) ?? 86_400),
  };
}

/** K-25 price_rules_one_in_effect's key for conditions. */
export function conditionsKey(conditions: PriceConditions): string {
  const clock = clockRange(conditions);
  return [
    conditions.serviceMoneyId ?? "",
    conditions.workerResourceId ?? "",
    conditions.weekdays ?? "",
    String(clock.from),
    String(clock.until),
  ].join("|");
}

export function sameConditions(a: PriceConditions, b: PriceConditions): boolean {
  return conditionsKey(a) === conditionsKey(b);
}

/** Whether a rule has a time condition: days or clock times. */
function hasTime(conditions: PriceConditions): boolean {
  return conditions.weekdays !== null || conditions.fromTime !== null || conditions.untilTime !== null;
}

/** How many conditions a rule sets (place, worker, time: 0 to 3): the most set wins (K-25 "How a price is found"). */
export function conditionCount(conditions: PriceConditions): number {
  return (
    (conditions.serviceMoneyId === null ? 0 : 1) +
    (conditions.workerResourceId === null ? 0 : 1) +
    (hasTime(conditions) ? 1 : 0)
  );
}

/** Whether two time conditions can hold at one instant: days that meet and clock times that meet. */
function timesMeet(a: PriceConditions, b: PriceConditions): boolean {
  const daysA = a.weekdays ?? "1234567";
  const daysB = b.weekdays ?? "1234567";
  if (!daysA.split("").some((day) => daysB.includes(day))) return false;
  const clockA = clockRange(a);
  const clockB = clockRange(b);
  return clockA.from < clockB.until && clockB.from < clockA.until;
}

/** Whether two rules' conditions can both hold for one booking. */
export function canBothApply(a: PriceConditions, b: PriceConditions): boolean {
  if (a.serviceMoneyId !== null && b.serviceMoneyId !== null && a.serviceMoneyId !== b.serviceMoneyId)
    return false;
  if (a.workerResourceId !== null && b.workerResourceId !== null && a.workerResourceId !== b.workerResourceId)
    return false;
  return timesMeet(a, b);
}

/**
 * Whether two rules of one service are a possible tie (arch 05 line 253): as many conditions set, not the same
 * conditions, that can both apply to one booking at an instant both are in effect.
 */
export function isPossibleTie(a: PriceRuleRow, b: PriceRuleRow): boolean {
  return (
    a.id !== b.id &&
    a.serviceId === b.serviceId &&
    conditionCount(a.conditions) === conditionCount(b.conditions) &&
    !sameConditions(a.conditions, b.conditions) &&
    canBothApply(a.conditions, b.conditions) &&
    overlaps(rangeOf(a), rangeOf(b))
  );
}

/** The rule's columns as K-25 v1 price_rules names them, for an insert. */
export function ruleValues(rule: Omit<PriceRuleRow, "version">): Record<string, unknown> {
  return {
    id: rule.id,
    business_id: rule.businessId,
    service_id: rule.serviceId,
    service_money_id: rule.conditions.serviceMoneyId,
    worker_resource_id: rule.conditions.workerResourceId,
    weekdays: rule.conditions.weekdays,
    from_time: rule.conditions.fromTime,
    until_time: rule.conditions.untilTime,
    price_cents: rule.priceCents,
    from_cents: rule.fromCents,
    currency: rule.currency,
    set_by_person_id: rule.setByPersonId,
    effective_from: rule.effectiveFrom,
    effective_to: rule.effectiveTo,
  };
}
