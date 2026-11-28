// The price resolver (C-132, T-639; arch 05 line 253; S13-25 rule 19; K-25 v1 "How a price is found"): which of a
// service's price rules prices one visit. Plain functions over K-25 v1's rows as the catalog's read 4 answers them
// (actions/src/domain/catalog: PriceRuleRow, PriceTieRow); the reading itself is service.ts's.
//
//   1. Take the service's rules in effect at the visit's start: [effective_from, effective_to) holds it (a withdrawn
//      rule's empty range holds no instant, so it is never taken).
//   2. Keep those whose every condition holds: its way is the visit's, its worker gives the work, its days and clock times
//      hold the visit's start, read in the visit's zone, else the business's (K-25 rule 8; the caller says which).
//   3. The rule with the most conditions set wins (place, worker, time: 0 to 3).
//   4. Between rules with as many: the winner the owner named for their tie; with no answer yet, the lower price.
// Copying the winner into a booking line is journey 4's (K-30), not here.
//
// A possible tie is caught when the owner saves the second rule (the catalog's addPrice, changePrice and withdrawPrice
// write its price_rule_ties row): tiesAtSave says which rules a saved one ties with, by the catalog's own test
// (isPossibleTie), and tieQuestion gives the read-back that asks which wins the two rules' own values, filled by code.
//
// Defaults used (for ops/QUESTIONS.md):
//   1. A worker rule holds only when the visit names that worker; a visit with no worker chosen yet ("whoever goes") is
//      priced by the rules without one. A place rule holds only for its own way; a visit with no way yet takes none.
//   2. Between rules with as many conditions, a pair the owner has answered drops its loser; the rules left, when more
//      than one, take the lower price, as an unanswered tie does (S13-25 rule 19), also for a pair no tie row asks about
//      (a pair saved before the check, or read from a leaky past). Answers that beat every rule (a loop of three) leave
//      them all, at the lower price.
//   3. Two rules left at the same price: the one with the lower 'from' price (none counting as lowest), then the lower
//      id, so every reader picks the same rule. Their price is the same either way.
//   4. A visit's clock time is its start to the second in the zone given; a clock condition holds from its from_time
//      (included) until its until_time (not included), a missing one being the day's start or end (K-25 rule 8; the
//      catalog's conditionsKey reads them the same way).
//   5. The read-back asks an unanswered tie while both its rules still price visits from the instant asked; a tie of a
//      rule since closed (a change opens a new rule, which the catalog asks about again: its default 7) is not asked.
//
// Nothing here logs. What it throws names a reason and fields, never an amount, a name or an id's value.

import { isZone, wallOf, weekdayOf } from "../../values/zone";
import { conditionCount, inEffectAt, isPossibleTie } from "../catalog";
import type { PriceConditions, PriceRuleRow, PriceTieRow } from "../catalog";

// ---- what the resolver is asked and answers -----------------------------------------------------------------------------

/** One visit to price: the service, when it starts, at which way, with which worker, read in which zone. */
export interface Visit {
  readonly serviceId: string;
  /** The visit's start, UTC ending in Z: effective dates and the time conditions are matched against it. */
  readonly startsAt: string;
  /** The visit's way (K-25 service_money.id), the place a place rule names; null: none chosen yet (default 1). */
  readonly wayId: string | null;
  /** The worker giving the work (K-04 resources.id); null: none chosen yet, "whoever goes" (default 1). */
  readonly workerResourceId: string | null;
  /** The IANA zone the visit's days and clock times are read in: the visit's own, else the business's (K-25 rule 8). */
  readonly zone: string;
}

/** How the winner was found (K-25 "How a price is found", steps 3 and 4). */
export type DecidedBy =
  /** One rule had the most conditions set (step 3). */
  | "mostConditions"
  /** Several had as many, and the owner's answers to their ties left one (step 4). */
  | "ownerAnswer"
  /** Several had as many with no answer leaving one: the lower price, until the owner answers (S13-25 rule 19). */
  | "lowerPrice";

/** The price of a visit: the winning rule and its values, or none when no rule prices it. */
export type PriceAnswer =
  | {
      readonly found: true;
      readonly ruleId: string;
      readonly priceCents: number;
      /** On a path priced at the visit, the 'from' price shown as "from" (K-25 "Prices"); null: none. */
      readonly fromCents: number | null;
      readonly currency: string;
      /** How many conditions the winner sets (place, worker, time: 0 to 3). */
      readonly conditionCount: number;
      readonly decidedBy: DecidedBy;
      /**
       * The rules that had as many conditions and held for the visit, the winner among them, by id; just the winner when
       * it alone had the most.
       */
      readonly tiedRuleIds: readonly string[];
      /** The unanswered ties between the rules left (price_rule_ties ids): what the read-back still asks. */
      readonly openTieIds: readonly string[];
    }
  /** No rule in effect holds for the visit: a path quoted per booking (K-30), or a service with no price yet. */
  | { readonly found: false };

/** A rule's own values as a read-back shows them: code fills every number (rule 4). */
export interface RuleShown {
  readonly ruleId: string;
  readonly conditions: PriceConditions;
  readonly priceCents: number;
  readonly fromCents: number | null;
  readonly currency: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

/** The read-back's question for one unanswered tie: which of its two rules wins where both apply. */
export interface TieQuestion {
  readonly tieId: string;
  readonly serviceId: string;
  readonly askedAt: string;
  /** The rule saved first, then the one whose save caught the tie. */
  readonly first: RuleShown;
  readonly second: RuleShown;
}

// ---- refusals ---------------------------------------------------------------------------------------------------------

/** Why the resolver refused: a label. */
export type PriceResolverRefusal =
  /** A field not in its form: an empty id, an instant not UTC, a zone the platform does not know. */
  | "badInput"
  /** A row of another business: every row is the call's business's (arch 10 line 546). */
  | "otherBusiness"
  /** A row of another service than the one asked, or a tie naming a rule the read did not answer. */
  | "badRead";

/** The resolver refused: nothing is priced. Names the reason and the fields at fault, never a value. */
export class PriceResolverError extends Error {
  override name = "PriceResolverError";
  readonly reason: PriceResolverRefusal;
  readonly fields: readonly string[];

  constructor(reason: PriceResolverRefusal, fields: readonly string[] = []) {
    super(
      fields.length === 0
        ? `price resolver refused: ${reason}`
        : `price resolver refused: ${reason} (${fields.join(", ")})`,
    );
    this.reason = reason;
    this.fields = [...fields];
  }
}

function refuse(reason: PriceResolverRefusal, fields: readonly string[]): never {
  throw new PriceResolverError(reason, fields);
}

const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/u;

/** An opaque id (CQ-09): a non-empty string with no space around it. */
const isId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;

/** Refuses a field that is not an id. */
export function requireId(value: unknown, field: string): string {
  if (!isId(value)) refuse("badInput", [field]);
  return value;
}

function idOrNull(value: unknown, field: string): string | null {
  return value === null ? null : requireId(value, field);
}

/** Refuses an instant that is not UTC ending in Z. */
export function requireInstant(value: unknown, field: string): string {
  if (typeof value !== "string" || !UTC.test(value) || Number.isNaN(Date.parse(value)))
    refuse("badInput", [field]);
  return value;
}

/** A visit as asked, each field in its form. */
export function checkVisit(visit: Visit): Visit {
  const given: unknown = visit;
  if (typeof given !== "object" || given === null) return refuse("badInput", ["visit"]);
  const startsAt = requireInstant(visit.startsAt, "startsAt");
  if (!isZone(visit.zone)) refuse("badInput", ["zone"]);
  return {
    serviceId: requireId(visit.serviceId, "serviceId"),
    startsAt,
    wayId: idOrNull(visit.wayId, "wayId"),
    workerResourceId: idOrNull(visit.workerResourceId, "workerResourceId"),
    zone: visit.zone,
  };
}

// ---- step 2: the conditions --------------------------------------------------------------------------------------------

const CLOCK = /^(\d{2}):(\d{2})(?::(\d{2}))?$/u;

/** A clock condition's seconds after midnight; a missing one is the day's start or end (default 4). */
function clockSeconds(value: string | null, missing: number): number {
  if (value === null) return missing;
  const match = CLOCK.exec(value);
  if (match === null) return refuse("badRead", ["conditions"]);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? "0");
}

/** The visit's start on the zone's wall clock: its ISO weekday (1 Monday to 7 Sunday) and seconds after midnight. */
export function localStart(
  startsAt: string,
  zone: string,
): { readonly weekday: number; readonly seconds: number } {
  const ms = Date.parse(startsAt);
  const wall = wallOf(ms, zone);
  const day = weekdayOf(wall);
  const seconds = Math.floor(ms / 1000) % 60;
  return { weekday: day === 0 ? 7 : day, seconds: wall.hour * 3600 + wall.minute * 60 + seconds };
}

/** Whether every condition a rule sets holds for the visit (step 2). */
export function conditionsHold(conditions: PriceConditions, visit: Visit): boolean {
  if (conditions.serviceMoneyId !== null && conditions.serviceMoneyId !== visit.wayId) return false;
  if (conditions.workerResourceId !== null && conditions.workerResourceId !== visit.workerResourceId)
    return false;
  if (conditions.weekdays === null && conditions.fromTime === null && conditions.untilTime === null)
    return true;
  const start = localStart(visit.startsAt, visit.zone);
  if (conditions.weekdays !== null && !conditions.weekdays.includes(String(start.weekday))) return false;
  const from = clockSeconds(conditions.fromTime, 0);
  const until = clockSeconds(conditions.untilTime, 86_400);
  return from <= start.seconds && start.seconds < until;
}

// ---- steps 3 and 4: the winner ------------------------------------------------------------------------------------------

const byId = (a: { readonly id: string }, b: { readonly id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** The lower price first; then the lower 'from' price, none lowest; then the lower id (default 3). */
const byPrice = (a: PriceRuleRow, b: PriceRuleRow): number =>
  a.priceCents - b.priceCents || (a.fromCents ?? -1) - (b.fromCents ?? -1) || byId(a, b);

/** The tie row asking about two rules, either way round, or undefined when none asks. */
function tieOf(ties: readonly PriceTieRow[], a: string, b: string): PriceTieRow | undefined {
  return ties.find(
    (tie) =>
      (tie.firstRuleId === a && tie.secondRuleId === b) || (tie.firstRuleId === b && tie.secondRuleId === a),
  );
}

/**
 * The price of a visit from its service's rules and ties as read (K-25 "How a price is found"): `rules` holds at least
 * every rule of the service in effect at the visit's start, `ties` the service's ties. Every row must be the visit's
 * service's (badRead otherwise); the business is service.ts's to hold.
 */
export function resolvePrice(
  visit: Visit,
  rules: readonly PriceRuleRow[],
  ties: readonly PriceTieRow[],
): PriceAnswer {
  const asked = checkVisit(visit);
  for (const row of [...rules, ...ties]) if (row.serviceId !== asked.serviceId) refuse("badRead", ["rules"]);
  const at = Date.parse(asked.startsAt);

  // Steps 1 and 2: in effect at the start, every condition holding.
  const holding = rules
    .filter((rule) => inEffectAt(rule, at) && conditionsHold(rule.conditions, asked))
    .sort(byId);
  if (holding.length === 0) return { found: false };

  // Step 3: the most conditions set.
  const most = Math.max(...holding.map((rule) => conditionCount(rule.conditions)));
  const top = holding.filter((rule) => conditionCount(rule.conditions) === most);
  const answer = (
    winner: PriceRuleRow,
    decidedBy: DecidedBy,
    openTieIds: readonly string[],
  ): PriceAnswer => ({
    found: true,
    ruleId: winner.id,
    priceCents: winner.priceCents,
    fromCents: winner.fromCents,
    currency: winner.currency,
    conditionCount: most,
    decidedBy,
    tiedRuleIds: top.map((rule) => rule.id),
    openTieIds,
  });
  const [only] = top;
  if (top.length === 1 && only !== undefined) return answer(only, "mostConditions", []);

  // Step 4: a pair the owner answered drops its loser (default 2).
  const beaten = new Set<string>();
  for (const [index, a] of top.entries()) {
    for (const b of top.slice(index + 1)) {
      const winner = tieOf(ties, a.id, b.id)?.winnerRuleId ?? null;
      if (winner === a.id) beaten.add(b.id);
      else if (winner === b.id) beaten.add(a.id);
    }
  }
  const leftOver = top.filter((rule) => !beaten.has(rule.id));
  const left = leftOver.length === 0 ? top : leftOver;
  const [first] = left;
  if (left.length === 1 && first !== undefined) return answer(first, "ownerAnswer", []);

  // Still more than one: the lower price until the owner answers (S13-25 rule 19), with the ties still to ask.
  const open: string[] = [];
  for (const [index, a] of left.entries()) {
    for (const b of left.slice(index + 1)) {
      const tie = tieOf(ties, a.id, b.id);
      if (tie?.winnerRuleId === null) open.push(tie.id);
    }
  }
  const [lowest] = [...left].sort(byPrice);
  if (lowest === undefined) return { found: false };
  return answer(lowest, "lowerPrice", [...new Set(open)].sort());
}

// ---- the tie at the second save, and its read-back ------------------------------------------------------------------------

/**
 * The service's rules a rule being saved makes a possible tie with (arch 05 line 253): as many conditions set, not the
 * same conditions, both able to apply to one booking at an instant both are in effect (the catalog's isPossibleTie),
 * leaving out a pair a tie row already asks about. By id.
 */
export function tiesAtSave(
  saved: PriceRuleRow,
  rules: readonly PriceRuleRow[],
  ties: readonly PriceTieRow[],
): readonly PriceRuleRow[] {
  return rules
    .filter((other) => isPossibleTie(other, saved) && tieOf(ties, other.id, saved.id) === undefined)
    .sort(byId);
}

function shown(rule: PriceRuleRow): RuleShown {
  return {
    ruleId: rule.id,
    conditions: rule.conditions,
    priceCents: rule.priceCents,
    fromCents: rule.fromCents,
    currency: rule.currency,
    effectiveFrom: rule.effectiveFrom,
    effectiveTo: rule.effectiveTo,
  };
}

/**
 * The read-back's questions: each unanswered tie whose two rules are both among `rules`, with their own values, in the
 * order asked (askedAt, then id). `rules` are the service's rules in effect at or after an instant (read 4), so a tie of
 * a rule closed before then, which prices nothing more, is not asked (default 5); never one asked half-filled. Every row
 * must be one service's (badRead otherwise).
 */
export function tieQuestions(rules: readonly PriceRuleRow[], ties: readonly PriceTieRow[]): TieQuestion[] {
  const [any] = [...rules, ...ties];
  for (const row of [...rules, ...ties])
    if (any !== undefined && row.serviceId !== any.serviceId) refuse("badRead", ["rules", "ties"]);
  const questions: TieQuestion[] = [];
  const open = ties
    .filter((tie) => tie.winnerRuleId === null)
    .sort((a, b) => Date.parse(a.askedAt) - Date.parse(b.askedAt) || byId(a, b));
  for (const tie of open) {
    const first = rules.find((rule) => rule.id === tie.firstRuleId);
    const second = rules.find((rule) => rule.id === tie.secondRuleId);
    if (first === undefined || second === undefined) continue;
    questions.push({
      tieId: tie.id,
      serviceId: tie.serviceId,
      askedAt: tie.askedAt,
      first: shown(first),
      second: shown(second),
    });
  }
  return questions;
}
