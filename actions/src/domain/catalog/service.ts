// The catalog and pricing service base (C-096, T-320; arch 02 diagram line 105, "Catalog & pricing"; arch 09 lines 457,
// 478, 488; RULES 3.7): it reads and writes a business's kinds of work, services with their price kinds, ways and price
// rules, where a price change closes one row and opens the next, and takes terms snapshots, for journeys 1 and 2 to call
// (T-633, T-634 and the journey 1 lane, once T-1429 binds its reads and T-667 lets the commit write the setup tables).
//
// One service serves one Tool API call, inside the call's business scope (T-290: CallContext.businessId), and reads its
// now from the clock it is given (BP 9.4). It reads only through the five reads the caller hands in by name (reads.ts);
// with none bound, every call answers notBuilt before it reads or builds anything (fails closed; DL-888). Every write is
// a K-05 v1 stateWrite, an insert or an update naming the version read, held by rows.ts checkCatalogWrite; nothing is
// deleted (CQ-128 (2): removing a space's link to a service answers notBuilt until K-05 has a delete write). Calls run
// one at a time, and each sees what the earlier calls of the same service built (a service added, then its price, in
// one turn); a call that is refused builds nothing and changes nothing the later calls see.
//
// Prices (K-25 v1 "Prices"): every price is a rule with effective dates, and a rule's values are never edited in place.
//   addPrice       a new rule; refused (overlap) when a rule of the same service with the same conditions is in effect
//                  at any instant of its dates (K-25 price_rules_one_in_effect; refuse-overlapping-effective-dates.json).
//   changePrice    the rule in effect at the change's instant is closed there (its end date) and the new one opens at
//                  that same instant, keeping the old one's end (S11-54: "$35 closed and $40 opened at the start of Mon
//                  Nov 2"). A booking copied its line's price when it was made (K-30), and no change writes a booking
//                  line or a rule's price, so a booking made before keeps its price, even for a visit after (RULES 3.7).
//                  Refused when no rule is in effect then (noPriceToChange) or a later price of the same conditions is
//                  already set (overlap): the owner withdraws or corrects that one first.
//   withdrawPrice  a price set for a later date, before it starts: closed at its own start (an empty range) and the
//                  price it replaced opened again at that instant as a new row (seed-price-withdrawn-before-start.json).
//   closePrice     a price stops at an instant, none opening (a place no longer priced).
// A rule saved beside another of as many conditions that can both apply is a possible tie: one price_rule_ties row per
// pair, asked at the save, answered by the owner (answerTie); meanwhile the lower price applies (the resolver's, C-132).
//
// Nothing here logs. What it throws names a reason and fields (errors.ts), never an amount, a name or an id's value.
//
// Defaults used (for ops/QUESTIONS.md):
//   1. Row ids are the caller's when given, else made by rule: `<svc|way|price|tie>-<turn key>-<n>`, n counting this
//      service's rows of that kind in call order, so a repeated turn builds the same ids (payments' default 1). A
//      snapshot's rule rows are `btr-<booking>-rule-<rule>` and `btr-<booking>-limit-<limit>`.
//   2. With the kind's `nomoney` fact, a way takes nothing before and its after is counter (A), own (B) or none (a free
//      service): K-25 rule 9 names counter and own; none moves no money either. K-23 business_setup.no_money is not one
//      of the five reads, so the kind's fact is what is checked.
//   3. The business's one currency (K-25 rule 7) is the caller's (no column holds it): every new amount is in it, and a
//      way's or a rule's amounts in another are refused (currencyMismatch), never relabelled.
//   4. A change, a close or a new price is never dated before now (`backdated`): effective dates are history.
//   5. A price changed on a rule that ended later with nothing after keeps that end; a change while a later price of the
//      same conditions is set is refused (overlap), not merged: the sources give no such case.
//   6. A snapshot's kind of work is its key service's (the booking's first line), and its cancel rule that service's
//      way's own, else the flow's default; with several lines the sources do not say whose rule wins.
//   7. A rule that replaces a tied one (a change, a withdrawal) is asked about again: a tie's answer names its two rows.
//   8. Spans are whole minutes ("120 minutes"), so a night is 1440 minutes, not a calendar day.
//   9. One write per row per call: a second write to a row, or an update of a row inserted in this call, is refused
//      (rowTwice), so every update names the version the commit will compare. A row this call changed is seen by the
//      later calls as changed but at the version read, since the commit compares every version before it writes.
//  10. notBuilt names the call the service serves: NotBuiltError for a K-09 v1 call, LaneNotBuiltError for a lane's.
//  11. A space-service link takes the space as the caller read it (its id and business): none of the five reads answers
//      K-23 places_or_things, and K-25 leaves to code that it is the service's business's.
//  12. A kind placed in a call offers no money path in that call: K-24's paths are read for the business's kinds only.
//  13. Fact and switch names are checked for form, and nomoney as both or neither; K-26's closed registry of names is
//      not one of the five reads.
//
// Known limit (for T-667): company_kinds' primary key is two columns (company_id, kind_id). placeKind and updateKind
// name its row by both, as K-05 v1's stateWrite key allows ("the row's primary key, column to value"), but
// db/repo/commit-turn.ts carries a versioned table's rows by a one-column key only (oneKey), so the commit refuses
// those writes until T-667 accepts them; and K-05's RowRef has one rowId, so no write names the kind's version read.

import type { RowRef, StateWrite, UnitWrites } from "../../commit";
import { notBuiltFor, refuse } from "./errors";
import { inEffectAt, isEmpty, isPossibleTie, overlaps, rangeOf, ruleValues, sameConditions } from "./prices";
import type { CatalogReads } from "./reads";
import {
  checkConditions,
  checkWayMoney,
  extrasOrNull,
  flowOf,
  idOrNull,
  insert,
  interval,
  isCurrency,
  msOf,
  requireBoolean,
  requireCents,
  requireClock,
  requireId,
  requireKindId,
  requireLanguage,
  requireMinutes,
  requireNames,
  requireUtc,
  requireVersion,
  requireWords,
  requireZone,
  update,
  updateByKey,
  wayValues,
  type WayDraft,
} from "./rows";
import { snapshotOf, type SnapshotInput } from "./terms";
import {
  PLACES,
  PRICE_KINDS,
  type Built,
  type BusinessKind,
  type CatalogWrites,
  type Place,
  type PriceChange,
  type PriceConditions,
  type PriceKind,
  type PriceRuleRow,
  type PriceRulesRead,
  type PriceTieRow,
  type ServiceRow,
  type TermsSnapshot,
  type WayRow,
} from "./types";

// ---- what the service is built with and given --------------------------------------------------------------------------

/** What one call's catalog service is built with, inside the call's business scope. */
export interface CatalogDeps {
  /** The Tool API call it serves (a K-09 v1 call or a lane's): its notBuilt names that call. */
  readonly call: string;
  /** The call's business (CallContext.businessId): every row read and written is this business's. */
  readonly businessId: string;
  /** The business's one currency, such as USD (K-25 rule 7; default 3). */
  readonly currency: string;
  /** The call's now in UTC, from the clock it is given (BP 9.4). */
  readonly now: string;
  /** The turn's (or the call's) key, the last part of every row id made by rule (default 1). */
  readonly turnKey: string;
  /** The five reads, handed in by name (T-1429 binds them). None bound: every call answers notBuilt. */
  readonly reads?: CatalogReads;
}

/** A kind of work placed on the business (K-23 company_kinds; S11-58 once the business exists). */
export interface PlaceKindInput {
  readonly companyId: string;
  readonly kindId: string;
  readonly tradeName: string | null;
  readonly facts: readonly string[];
  readonly switchesA: readonly string[];
  readonly switchesB: readonly string[];
}

/** A change to a kind of work's trade name, facts or switches; what is left out stays. */
export interface UpdateKindInput {
  readonly companyId: string;
  readonly kindId: string;
  /** The version the read-back showed; refused when it changed since (limit 4). */
  readonly expectVersion?: number;
  readonly tradeName?: string | null;
  readonly facts?: readonly string[];
  readonly switchesA?: readonly string[];
  readonly switchesB?: readonly string[];
}

/** A line of the business's list (S1-12 gives services: "Service, Price kind, Price, Time it takes"). */
export interface AddServiceInput {
  readonly id?: string;
  /** One of the business's kinds of work (K-25 rule 9). */
  readonly kindId: string;
  readonly name: string;
  readonly priceKind: PriceKind;
  /** For per_unit, what one unit is; null for any other price kind. */
  readonly unit: string | null;
  readonly lengthMinutes: number;
  /** Its place in the list, from 1; default after the last. */
  readonly position?: number;
  /** Offered for new bookings; default true. */
  readonly active?: boolean;
  /** What the profession file says of it, a JSON object's text; default none. */
  readonly extras?: string | null;
}

/** A change to a service (S11-56; a service stops by active false, never deleted); what is left out stays. */
export interface UpdateServiceInput {
  readonly serviceId: string;
  readonly expectVersion?: number;
  readonly name?: string;
  readonly priceKind?: PriceKind;
  readonly unit?: string | null;
  readonly lengthMinutes?: number;
  readonly position?: number;
  readonly active?: boolean;
  readonly extras?: string | null;
}

/** A way: a service at one place, with its money (S1-13 gives ways; S1-43). Its currency is the business's. */
export interface AddWayInput {
  readonly id?: string;
  readonly serviceId: string;
  readonly place: Place;
  readonly locationId: string | null;
  readonly path: string;
  readonly depositCents: number | null;
  readonly depositPercent: number | null;
  readonly feeCents: number | null;
  readonly cutoffBeforeMinutes: number | null;
  readonly cutoffDayBeforeAt: string | null;
  readonly tipLine: boolean | null;
  readonly active?: boolean;
}

/** A change to a way's money (S11-56: "for new bookings only"), in place with its version raised. */
export interface UpdateWayInput {
  readonly wayId: string;
  readonly serviceId: string;
  readonly expectVersion?: number;
  readonly path?: string;
  readonly depositCents?: number | null;
  readonly depositPercent?: number | null;
  readonly feeCents?: number | null;
  readonly cutoffBeforeMinutes?: number | null;
  readonly cutoffDayBeforeAt?: string | null;
  readonly tipLine?: boolean | null;
  readonly active?: boolean;
}

/**
 * A space or thing and a service it takes (K-25 item_services; S1-81). The space is as the caller read it (K-23
 * places_or_things, its id and business): none of the five reads answers it, and K-25 leaves to code that it is the
 * same business's as the service, so a space of another business is refused.
 */
export interface SpaceLinkInput {
  readonly placeOrThing: { readonly id: string; readonly businessId: string };
  readonly serviceId: string;
}

/** A new price rule (S1-12's prices; S2-15's price by person; a place's or a time's price). */
export interface AddPriceInput {
  readonly id?: string;
  readonly serviceId: string;
  readonly conditions: PriceConditions;
  readonly priceCents: number;
  /** On a path priced at the visit, the 'from' price; null: none. */
  readonly fromCents: number | null;
  /** The owner, or an admin the owner lets set prices (never Rosie). */
  readonly setByPersonId: string;
  /** Default now. */
  readonly effectiveFrom?: string;
  /** Default open: in effect until changed. */
  readonly effectiveTo?: string | null;
}

/** A price change from an instant (S11-54: "Sam raises the haircut to $40 for visits from Mon Nov 2"). */
export interface ChangePriceInput {
  /** The new rule's id. */
  readonly id?: string;
  readonly serviceId: string;
  /** The conditions of the price that changes; none: the service's own price. */
  readonly conditions: PriceConditions;
  readonly priceCents: number;
  readonly fromCents: number | null;
  readonly setByPersonId: string;
  /** From when visits take the new price; default now. */
  readonly effectiveFrom?: string;
  /** The version of the rule in effect the read-back showed; refused when it changed since (limit 4). */
  readonly expectVersion?: number;
}

/** A price set for a later date withdrawn before it starts. */
export interface WithdrawPriceInput {
  readonly ruleId: string;
  readonly serviceId: string;
  readonly setByPersonId: string;
  /** The id of the row that opens the replaced price again. */
  readonly id?: string;
  readonly expectVersion?: number;
}

/** A price that stops at an instant, none opening. */
export interface ClosePriceInput {
  readonly ruleId: string;
  readonly serviceId: string;
  /** Default now. */
  readonly at?: string;
  readonly expectVersion?: number;
}

/** The owner's answer to a possible tie: which rule wins where both apply. */
export interface AnswerTieInput {
  readonly tieId: string;
  readonly serviceId: string;
  readonly winnerRuleId: string;
  readonly answeredByPersonId: string;
  readonly expectVersion?: number;
}

/** One call's catalog and pricing service. */
export interface Catalog {
  readonly businessId: string;
  /** Read 1: the business's kinds of work with their money paths per flow, and those placed in this call. */
  kinds(): Promise<readonly BusinessKind[]>;
  /** Read 2: the business's services in list order, as this call has left them. */
  services(): Promise<readonly ServiceRow[]>;
  /** Read 3: a service's ways, as this call has left them. */
  ways(serviceId: string): Promise<readonly WayRow[]>;
  /** Read 4: a service's price rules in effect at or after `at`, and its ties, as this call has left them. */
  priceRules(serviceId: string, at: string): Promise<PriceRulesRead>;
  placeKind(input: PlaceKindInput): Promise<Built>;
  updateKind(input: UpdateKindInput): Promise<Built>;
  addService(input: AddServiceInput): Promise<Built>;
  updateService(input: UpdateServiceInput): Promise<Built>;
  addWay(input: AddWayInput): Promise<Built>;
  updateWay(input: UpdateWayInput): Promise<Built>;
  linkSpace(input: SpaceLinkInput): Promise<Built>;
  /** CQ-128 (2): no turn removes a link while K-05 has no delete write; always notBuilt, nothing written. */
  unlinkSpace(input: SpaceLinkInput): Promise<never>;
  addPrice(input: AddPriceInput): Promise<PriceChange>;
  changePrice(input: ChangePriceInput): Promise<PriceChange>;
  withdrawPrice(input: WithdrawPriceInput): Promise<PriceChange>;
  closePrice(input: ClosePriceInput): Promise<PriceChange>;
  answerTie(input: AnswerTieInput): Promise<Built>;
  /** The booking's terms snapshot, once: frozen, its writes inserts only. */
  takeTermsSnapshot(input: SnapshotInput): Promise<TermsSnapshot>;
  /** Everything this service built so far, in call order: what the turn's one commit carries. */
  written(): CatalogWrites;
}

// ---- helpers --------------------------------------------------------------------------------------------------------

const byPosition = (a: ServiceRow, b: ServiceRow): number =>
  a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const byId = (a: { readonly id: string }, b: { readonly id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  const found = allowed.find((each) => each === value);
  if (found === undefined) return refuse("badInput", [field]);
  return found;
}

function centsOrNull(value: unknown, field: string, min: number): number | null {
  return value === null ? null : requireCents(value, field, min);
}

function minutesOrNull(value: unknown, field: string): number | null {
  return value === null ? null : requireMinutes(value, field);
}

function clockOrNull(value: unknown, field: string): string | null {
  return value === null ? null : requireClock(value, field);
}

function booleanOrNull(value: unknown, field: string): boolean | null {
  return value === null ? null : requireBoolean(value, field);
}

function wordsOrNull(value: unknown, field: string): string | null {
  return value === null ? null : requireWords(value, field);
}

/** The columns whose values differ between two rows' column maps. */
function changed(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(after))
    if (JSON.stringify(value) !== JSON.stringify(before[column])) set[column] = value;
  return set;
}

/** A row read at its version (limit 4). */
const ref = (table: string, rowId: string, version: number): RowRef => ({ table, rowId, version });

/**
 * A passed part's writes with a call's catalog writes added (T-305 UnitWrites): the rows read and the rows written,
 * after what the part already writes.
 */
export function withCatalog(unit: UnitWrites, writes: CatalogWrites): UnitWrites {
  return {
    ...unit,
    versionsRead: [...unit.versionsRead, ...writes.versionsRead],
    state: [...unit.state, ...writes.state],
  };
}

// ---- the service ----------------------------------------------------------------------------------------------------

/** The catalog and pricing service for one call, inside the call's business scope. */
export function createCatalog(deps: CatalogDeps): Catalog {
  const call = requireWords(deps.call, "call");
  const businessId = requireId(deps.businessId, "businessId");
  if (!isCurrency(deps.currency)) refuse("badInput", ["currency"]);
  const currency = deps.currency;
  const now = requireUtc(deps.now, "now");
  const nowMs = msOf(now);
  const turnKey = requireId(deps.turnKey, "turnKey");

  // What this call built so far, which every later call of the service reads through.
  const placedKinds: BusinessKind[] = [];
  const kindEdits = new Map<string, BusinessKind>();
  const addedServices: ServiceRow[] = [];
  const serviceEdits = new Map<string, ServiceRow>();
  const addedWays: WayRow[] = [];
  const wayEdits = new Map<string, WayRow>();
  const addedRules: PriceRuleRow[] = [];
  const ruleCloses = new Map<string, string>();
  const addedTies: PriceTieRow[] = [];
  const tieEdits = new Map<string, PriceTieRow>();
  const links = new Set<string>();
  const snapshots = new Map<string, TermsSnapshot>();
  /** `<table>:<id>` of every row written this call: one write per row (default 9). */
  const touched = new Set<string>();
  const counters = new Map<string, number>();
  const built: CatalogWrites[] = [];

  let tail: Promise<unknown> = Promise.resolve();
  /** Runs one call after the one before has finished, so each sees what the earlier ones built. */
  function serial<T>(work: (reads: CatalogReads) => Promise<T>): Promise<T> {
    const run = tail.then(() => {
      // No reads bound: notBuilt before anything is read or built (DL-888; fails closed).
      const reads = deps.reads;
      if (reads === undefined) throw notBuiltFor(call);
      return work(reads);
    });
    tail = run.catch(() => undefined);
    return run;
  }

  function newId(prefix: string, given: unknown, table: string): string {
    if (given !== undefined) {
      const id = requireId(given, "id");
      if (touched.has(`${table}:${id}`)) refuse("rowTwice", ["id"]);
      return id;
    }
    const n = (counters.get(prefix) ?? 0) + 1;
    return `${prefix}-${turnKey}-${String(n)}`;
  }

  /** Counts a row id made by rule only once its call succeeds, so a refused call leaves the next id as it was. */
  function claimId(prefix: string, given: unknown): void {
    if (given === undefined) counters.set(prefix, (counters.get(prefix) ?? 0) + 1);
  }

  /** Refuses a second write to a row this call wrote. */
  function once(table: string, id: string): void {
    if (touched.has(`${table}:${id}`)) refuse("rowTwice", [table]);
  }

  /** The version an update names: the one read, refused when the caller read another (limit 4). */
  function versionRead(given: unknown, version: number, table: string): number {
    if (given === undefined) return version;
    if (requireVersion(given, "expectVersion") !== version) refuse("versionChanged", [table]);
    return version;
  }

  function record(id: string, writes: CatalogWrites): Built {
    built.push(writes);
    return { id, writes };
  }

  function own<T extends { readonly businessId: string }>(rows: readonly T[], field: string): readonly T[] {
    for (const row of rows) if (row.businessId !== businessId) refuse("otherBusiness", [field]);
    return rows;
  }

  // ---- the reads, as this call has left them ----

  const kindKey = (companyId: string, kindId: string): string => `${companyId}|${kindId}`;

  async function kindsNow(reads: CatalogReads): Promise<BusinessKind[]> {
    const read = own(await reads.kindsOf(businessId), "kinds");
    return [
      ...read.map((kind) => kindEdits.get(kindKey(kind.companyId, kind.kindId)) ?? kind),
      ...placedKinds,
    ];
  }

  async function servicesNow(reads: CatalogReads): Promise<ServiceRow[]> {
    const read = own(await reads.servicesOf(businessId), "services");
    return [...read.map((service) => serviceEdits.get(service.id) ?? service), ...addedServices].sort(
      byPosition,
    );
  }

  async function serviceOf(reads: CatalogReads, serviceId: unknown): Promise<ServiceRow> {
    const id = requireId(serviceId, "serviceId");
    const found = (await servicesNow(reads)).find((service) => service.id === id);
    if (found === undefined) return refuse("notFound", ["serviceId"]);
    return found;
  }

  async function waysNow(reads: CatalogReads, serviceId: string): Promise<WayRow[]> {
    const read = own(await reads.waysOf(businessId, serviceId), "ways");
    for (const way of read) if (way.serviceId !== serviceId) refuse("badRead", ["ways"]);
    return [
      ...read.map((way) => wayEdits.get(way.id) ?? way),
      ...addedWays.filter((way) => way.serviceId === serviceId),
    ];
  }

  async function rulesNow(reads: CatalogReads, serviceId: string, at: string): Promise<PriceRulesRead> {
    const read = await reads.priceRulesOf(businessId, serviceId, at);
    own(read.rules, "rules");
    own(read.ties, "ties");
    for (const row of [...read.rules, ...read.ties])
      if (row.serviceId !== serviceId) refuse("badRead", ["rules"]);
    const atMs = msOf(at);
    const rules = [...read.rules, ...addedRules.filter((rule) => rule.serviceId === serviceId)]
      .map((rule) => {
        const closed = ruleCloses.get(rule.id);
        return closed === undefined ? rule : { ...rule, effectiveTo: closed };
      })
      .filter((rule) => rule.effectiveTo === null || msOf(rule.effectiveTo) > atMs || isEmpty(rangeOf(rule)))
      .sort(byId);
    const ties = [
      ...read.ties.map((tie) => tieEdits.get(tie.id) ?? tie),
      ...addedTies.filter((tie) => tie.serviceId === serviceId),
    ];
    return { rules, ties };
  }

  /** Whether a row was built in this call (it has no version to compare yet), not read from the database. */
  const builtHere = (id: string, inserted: readonly { readonly id: string }[]): boolean =>
    inserted.some((row) => row.id === id);

  /** The ties a rule saved now makes with the service's other rules (K-25 price_rule_ties), one per pair. */
  function tiesFor(rule: PriceRuleRow, others: PriceRulesRead): PriceTieRow[] {
    const asked = new Set(others.ties.map((tie) => `${tie.firstRuleId}|${tie.secondRuleId}`));
    const ties: PriceTieRow[] = [];
    for (const other of others.rules) {
      if (!isPossibleTie(other, rule)) continue;
      if (asked.has(`${other.id}|${rule.id}`) || asked.has(`${rule.id}|${other.id}`)) continue;
      const n = (counters.get("tie") ?? 0) + ties.length + 1;
      ties.push({
        id: `tie-${turnKey}-${String(n)}`,
        businessId,
        serviceId: rule.serviceId,
        firstRuleId: other.id,
        secondRuleId: rule.id,
        askedAt: now,
        winnerRuleId: null,
        answeredAt: null,
        answeredByPersonId: null,
        version: 1,
      });
    }
    return ties;
  }

  function tieInsert(tie: PriceTieRow): StateWrite {
    return insert("price_rule_ties", {
      id: tie.id,
      business_id: tie.businessId,
      service_id: tie.serviceId,
      first_rule_id: tie.firstRuleId,
      second_rule_id: tie.secondRuleId,
      asked_at: tie.askedAt,
      winner_rule_id: null,
      answered_at: null,
      answered_by_person_id: null,
    });
  }

  /** A price's own fields: the conditions in K-25's forms (a place one of the service's ways), the money and who set it. */
  async function priceFields(
    reads: CatalogReads,
    service: ServiceRow,
    input: Pick<AddPriceInput, "conditions" | "priceCents" | "fromCents" | "setByPersonId">,
  ): Promise<Pick<PriceRuleRow, "conditions" | "priceCents" | "fromCents" | "currency" | "setByPersonId">> {
    const given: unknown = input.conditions;
    if (typeof given !== "object" || given === null) return refuse("badInput", ["conditions"]);
    const conditions = checkConditions(input.conditions);
    const fromCents = centsOrNull(input.fromCents, "fromCents", 1);
    if (conditions.serviceMoneyId !== null) {
      const way = (await waysNow(reads, service.id)).find((each) => each.id === conditions.serviceMoneyId);
      if (way === undefined) return refuse("notFound", ["conditions.serviceMoneyId"]);
      // A path priced from photos takes the quote made for the booking, never a rule; a 'from' price is a visit
      // path's only (K-25 "Prices"; K-30 booking_lines_range_and_from).
      const priced = way.path.split("|")[0];
      if (priced === "photos") refuse("badInput", ["conditions.serviceMoneyId"]);
      if (fromCents !== null && priced !== "visit") refuse("badInput", ["fromCents"]);
    }
    return {
      conditions,
      priceCents: requireCents(input.priceCents, "priceCents", 0),
      fromCents,
      currency,
      setByPersonId: requireId(input.setByPersonId, "setByPersonId"),
    };
  }

  /** An instant a price starts or stops at: UTC, never before now (default 4). */
  function fromNow(value: unknown, field: string): string {
    const at = value === undefined ? now : requireUtc(value, field);
    if (msOf(at) < nowMs) refuse("backdated", [field]);
    return at;
  }

  /** The service's row read at its version, when it was read from the database (limit 4). */
  function serviceRefs(service: ServiceRow): RowRef[] {
    return addedServices.some((each) => each.id === service.id)
      ? []
      : [ref("services", service.id, service.version)];
  }

  /** The rows a rule's ties rest on, at their versions (limit 4). */
  function tieRefs(ties: readonly PriceTieRow[], rules: readonly PriceRuleRow[]): RowRef[] {
    return ties.flatMap((tie) => {
      const first = rules.find((rule) => rule.id === tie.firstRuleId);
      return first === undefined || addedRules.some((rule) => rule.id === first.id)
        ? []
        : [ref("price_rules", first.id, first.version)];
    });
  }

  /** Records a price call's rows: rules closed and opened, ties asked. */
  function recordPrice(args: {
    readonly closed: PriceRuleRow | null;
    readonly closeAt: string | null;
    readonly opened: PriceRuleRow | null;
    readonly openedGiven: unknown;
    readonly ties: readonly PriceTieRow[];
    readonly state: readonly StateWrite[];
    readonly versionsRead: readonly RowRef[];
  }): PriceChange {
    const writes: CatalogWrites = { versionsRead: [...args.versionsRead], state: [...args.state] };
    if (args.closed !== null && args.closeAt !== null) {
      ruleCloses.set(args.closed.id, args.closeAt);
      touched.add(`price_rules:${args.closed.id}`);
    }
    if (args.opened !== null) {
      claimId("price", args.openedGiven);
      addedRules.push(args.opened);
      touched.add(`price_rules:${args.opened.id}`);
    }
    for (const tie of args.ties) {
      claimId("tie", undefined);
      addedTies.push(tie);
      touched.add(`price_rule_ties:${tie.id}`);
    }
    built.push(writes);
    return {
      closedRuleId: args.closed?.id ?? null,
      openedRuleId: args.opened?.id ?? null,
      tieIds: args.ties.map((tie) => tie.id),
      writes,
    };
  }

  /** The rule a price call closes, as read: a committed row, written once this call, at the version read. */
  function closable(rule: PriceRuleRow, expectVersion: unknown): number {
    if (addedRules.some((added) => added.id === rule.id)) refuse("rowTwice", ["price_rules"]);
    once("price_rules", rule.id);
    return versionRead(expectVersion, rule.version, "price_rules");
  }

  // ---- the calls ----

  return {
    businessId,

    kinds: () => serial((reads) => kindsNow(reads)),
    services: () => serial((reads) => servicesNow(reads)),
    ways: (serviceId) => serial(async (reads) => waysNow(reads, (await serviceOf(reads, serviceId)).id)),
    priceRules: (serviceId, at) =>
      serial(async (reads) => rulesNow(reads, (await serviceOf(reads, serviceId)).id, requireUtc(at, "at"))),

    placeKind: (input) =>
      serial(async (reads) => {
        const companyId = requireId(input.companyId, "companyId");
        const kindId = requireKindId(input.kindId, "kindId");
        const tradeName = wordsOrNull(input.tradeName, "tradeName");
        const facts = requireNames(input.facts, "facts");
        const switchesA = requireNames(input.switchesA, "switchesA");
        const switchesB = requireNames(input.switchesB, "switchesB");
        // K-23 company_kinds_nomoney_fact_and_switch: a profession sets both or neither (SPEC-master 5d).
        if (facts.includes("nomoney") !== (switchesA.includes("nomoney") || switchesB.includes("nomoney")))
          refuse("badInput", ["facts", "switchesA", "switchesB"]);
        if ((await kindsNow(reads)).some((kind) => kind.kindId === kindId)) refuse("kindTwice", ["kindId"]);
        const key = kindKey(companyId, kindId);
        once("company_kinds", key);
        const state = [
          insert("company_kinds", {
            company_id: companyId,
            kind_id: kindId,
            business_id: businessId,
            trade_name: tradeName,
            pf_facts: [...facts],
            pf_switches_a: [...switchesA],
            pf_switches_b: [...switchesB],
          }),
        ];
        // Its money paths are K-24's, read once it is the business's: none offered in this call.
        placedKinds.push({
          companyId,
          kindId,
          businessId,
          tradeName,
          facts,
          switchesA,
          switchesB,
          version: 1,
          paths: { A: [], B: [] },
        });
        touched.add(`company_kinds:${key}`);
        return record(key, { versionsRead: [], state });
      }),

    updateKind: (input) =>
      serial(async (reads) => {
        const companyId = requireId(input.companyId, "companyId");
        const kindId = requireKindId(input.kindId, "kindId");
        const key = kindKey(companyId, kindId);
        const kind = (await kindsNow(reads)).find(
          (each) => each.companyId === companyId && each.kindId === kindId,
        );
        if (kind === undefined) return refuse("notFound", ["kindId"]);
        if (placedKinds.includes(kind)) refuse("rowTwice", ["company_kinds"]);
        once("company_kinds", key);
        const version = versionRead(input.expectVersion, kind.version, "company_kinds");
        const next: BusinessKind = {
          ...kind,
          tradeName:
            input.tradeName === undefined ? kind.tradeName : wordsOrNull(input.tradeName, "tradeName"),
          facts: input.facts === undefined ? kind.facts : requireNames(input.facts, "facts"),
          switchesA:
            input.switchesA === undefined ? kind.switchesA : requireNames(input.switchesA, "switchesA"),
          switchesB:
            input.switchesB === undefined ? kind.switchesB : requireNames(input.switchesB, "switchesB"),
        };
        if (
          next.facts.includes("nomoney") !==
          (next.switchesA.includes("nomoney") || next.switchesB.includes("nomoney"))
        )
          refuse("badInput", ["facts", "switchesA", "switchesB"]);
        const columns = (row: BusinessKind): Record<string, unknown> => ({
          trade_name: row.tradeName,
          pf_facts: row.facts,
          pf_switches_a: row.switchesA,
          pf_switches_b: row.switchesB,
        });
        const set = changed(columns(kind), columns(next));
        if (Object.keys(set).length === 0) refuse("badInput", ["set"]);
        const state = [
          updateByKey("company_kinds", { company_id: companyId, kind_id: kindId }, version, set),
        ];
        // Later calls see the change at the version read: the commit compares every version before it writes.
        kindEdits.set(key, { ...next, version });
        touched.add(`company_kinds:${key}`);
        return record(key, { versionsRead: [], state });
      }),

    addService: (input) =>
      serial(async (reads) => {
        const id = newId("svc", input.id, "services");
        const kindId = requireKindId(input.kindId, "kindId");
        if (!(await kindsNow(reads)).some((kind) => kind.kindId === kindId))
          refuse("kindNotOnBusiness", ["kindId"]);
        const name = requireWords(input.name, "name");
        const priceKind = oneOf(input.priceKind, PRICE_KINDS, "priceKind");
        const unit = wordsOrNull(input.unit, "unit");
        if ((priceKind === "per_unit") !== (unit !== null)) refuse("badInput", ["unit"]);
        const lengthMinutes = requireMinutes(input.lengthMinutes, "lengthMinutes");
        const services = await servicesNow(reads);
        if (services.some((service) => service.id === id)) refuse("rowTwice", ["services"]);
        const last = services.reduce((most, service) => Math.max(most, service.position), 0);
        const position = requireCents(input.position ?? last + 1, "position", 1);
        const active = requireBoolean(input.active ?? true, "active");
        const extras = extrasOrNull(input.extras ?? null, "extras");
        const row: ServiceRow = {
          id,
          businessId,
          kindId,
          name,
          priceKind,
          unit,
          lengthMinutes,
          position,
          active,
          version: 1,
        };
        const state = [
          insert("services", {
            id,
            business_id: businessId,
            kind_id: kindId,
            name,
            price_kind: priceKind,
            unit,
            length: interval(lengthMinutes),
            position,
            active,
            extras,
          }),
        ];
        claimId("svc", input.id);
        addedServices.push(row);
        touched.add(`services:${id}`);
        return record(id, { versionsRead: [], state });
      }),

    updateService: (input) =>
      serial(async (reads) => {
        const service = await serviceOf(reads, input.serviceId);
        if (builtHere(service.id, addedServices)) refuse("rowTwice", ["services"]);
        once("services", service.id);
        const version = versionRead(input.expectVersion, service.version, "services");
        const next: ServiceRow = {
          ...service,
          name: input.name === undefined ? service.name : requireWords(input.name, "name"),
          priceKind:
            input.priceKind === undefined
              ? service.priceKind
              : oneOf(input.priceKind, PRICE_KINDS, "priceKind"),
          unit: input.unit === undefined ? service.unit : wordsOrNull(input.unit, "unit"),
          lengthMinutes:
            input.lengthMinutes === undefined
              ? service.lengthMinutes
              : requireMinutes(input.lengthMinutes, "lengthMinutes"),
          position:
            input.position === undefined ? service.position : requireCents(input.position, "position", 1),
          active: input.active === undefined ? service.active : requireBoolean(input.active, "active"),
        };
        if ((next.priceKind === "per_unit") !== (next.unit !== null)) refuse("badInput", ["unit"]);
        const columns = (row: ServiceRow): Record<string, unknown> => ({
          name: row.name,
          price_kind: row.priceKind,
          unit: row.unit,
          length: interval(row.lengthMinutes),
          position: row.position,
          active: row.active,
        });
        const set = changed(columns(service), columns(next));
        if (input.extras !== undefined) set.extras = extrasOrNull(input.extras, "extras");
        if (Object.keys(set).length === 0) refuse("badInput", ["set"]);
        const state = [update("services", service.id, version, set)];
        serviceEdits.set(service.id, { ...next, version });
        touched.add(`services:${service.id}`);
        return record(service.id, { versionsRead: [], state });
      }),

    addWay: (input) =>
      serial(async (reads) => {
        const id = newId("way", input.id, "service_money");
        const service = await serviceOf(reads, input.serviceId);
        const kind = (await kindsNow(reads)).find((each) => each.kindId === service.kindId);
        if (kind === undefined) return refuse("kindNotOnBusiness", ["serviceId"]);
        const place = oneOf(input.place, PLACES, "place");
        const path: unknown = input.path;
        if (typeof path !== "string") return refuse("badInput", ["path"]);
        const depositCents = centsOrNull(input.depositCents, "depositCents", 1);
        const feeCents = centsOrNull(input.feeCents, "feeCents", 1);
        const draft: WayDraft = {
          flow: flowOf(place),
          place,
          locationId: idOrNull(input.locationId, "locationId"),
          path,
          depositCents,
          depositPercent: centsOrNull(input.depositPercent, "depositPercent", 1),
          feeCents,
          currency: depositCents !== null || feeCents !== null ? currency : null,
          cutoffBeforeMinutes: minutesOrNull(input.cutoffBeforeMinutes, "cutoffBeforeMinutes"),
          cutoffDayBeforeAt: clockOrNull(input.cutoffDayBeforeAt, "cutoffDayBeforeAt"),
          tipLine: booleanOrNull(input.tipLine, "tipLine"),
          active: requireBoolean(input.active ?? true, "active"),
        };
        checkWayMoney(draft, kind, currency);
        const ways = await waysNow(reads, service.id);
        if (ways.some((way) => way.id === id)) refuse("rowTwice", ["service_money"]);
        if (ways.some((way) => way.place === draft.place && way.locationId === draft.locationId))
          refuse("wayTwice", ["place", "locationId"]);
        const state = [
          insert("service_money", {
            id,
            service_id: service.id,
            business_id: businessId,
            ...wayValues(draft),
          }),
        ];
        claimId("way", input.id);
        addedWays.push({ ...draft, id, serviceId: service.id, businessId, version: 1 });
        touched.add(`service_money:${id}`);
        return record(id, { versionsRead: serviceRefs(service), state });
      }),

    updateWay: (input) =>
      serial(async (reads) => {
        const service = await serviceOf(reads, input.serviceId);
        const wayId = requireId(input.wayId, "wayId");
        const way = (await waysNow(reads, service.id)).find((each) => each.id === wayId);
        if (way === undefined) return refuse("notFound", ["wayId"]);
        if (builtHere(way.id, addedWays)) refuse("rowTwice", ["service_money"]);
        once("service_money", way.id);
        const version = versionRead(input.expectVersion, way.version, "service_money");
        const kind = (await kindsNow(reads)).find((each) => each.kindId === service.kindId);
        if (kind === undefined) return refuse("kindNotOnBusiness", ["serviceId"]);
        // A field left out stays as read; one given as null clears it.
        const pick = (key: keyof UpdateWayInput, current: unknown): unknown => {
          const given: unknown = input[key];
          if (given === undefined) return current;
          return given;
        };
        const path = pick("path", way.path);
        if (typeof path !== "string") return refuse("badInput", ["path"]);
        const depositCents = centsOrNull(pick("depositCents", way.depositCents), "depositCents", 1);
        const feeCents = centsOrNull(pick("feeCents", way.feeCents), "feeCents", 1);
        const next: WayRow = {
          ...way,
          path,
          depositCents,
          depositPercent: centsOrNull(pick("depositPercent", way.depositPercent), "depositPercent", 1),
          feeCents,
          // A way's amounts keep their currency, which must be the business's one (K-25 rule 7): never converted.
          currency: depositCents !== null || feeCents !== null ? (way.currency ?? currency) : null,
          cutoffBeforeMinutes: minutesOrNull(
            pick("cutoffBeforeMinutes", way.cutoffBeforeMinutes),
            "cutoffBeforeMinutes",
          ),
          cutoffDayBeforeAt: clockOrNull(
            pick("cutoffDayBeforeAt", way.cutoffDayBeforeAt),
            "cutoffDayBeforeAt",
          ),
          tipLine: booleanOrNull(pick("tipLine", way.tipLine), "tipLine"),
          active: requireBoolean(pick("active", way.active), "active"),
        };
        checkWayMoney(next, kind, currency);
        const set = changed(wayValues(way), wayValues(next));
        if (Object.keys(set).length === 0) refuse("badInput", ["set"]);
        const state = [update("service_money", way.id, version, set)];
        wayEdits.set(way.id, { ...next, version });
        touched.add(`service_money:${way.id}`);
        return record(way.id, { versionsRead: serviceRefs(service), state });
      }),

    linkSpace: (input) =>
      serial(async (reads) => {
        const given: unknown = input.placeOrThing;
        if (typeof given !== "object" || given === null) return refuse("badInput", ["placeOrThing"]);
        const placeOrThingId = requireId(input.placeOrThing.id, "placeOrThing.id");
        if (input.placeOrThing.businessId !== businessId)
          refuse("otherBusiness", ["placeOrThing.businessId"]);
        const service = await serviceOf(reads, input.serviceId);
        const key = `${placeOrThingId}|${service.id}`;
        if (links.has(key)) refuse("rowTwice", ["item_services"]);
        const state = [
          insert("item_services", {
            place_or_thing_id: placeOrThingId,
            service_id: service.id,
            business_id: businessId,
          }),
        ];
        links.add(key);
        return record(key, { versionsRead: serviceRefs(service), state });
      }),

    unlinkSpace: () => Promise.reject(notBuiltFor(call)),

    addPrice: (input) =>
      serial(async (reads) => {
        const service = await serviceOf(reads, input.serviceId);
        const fields = await priceFields(reads, service, input);
        const id = newId("price", input.id, "price_rules");
        const effectiveFrom = fromNow(input.effectiveFrom, "effectiveFrom");
        const effectiveTo =
          input.effectiveTo === undefined || input.effectiveTo === null
            ? null
            : requireUtc(input.effectiveTo, "effectiveTo");
        if (effectiveTo !== null && msOf(effectiveTo) <= msOf(effectiveFrom))
          refuse("badInput", ["effectiveTo"]);
        const rule: PriceRuleRow = {
          id,
          businessId,
          serviceId: service.id,
          ...fields,
          effectiveFrom,
          effectiveTo,
          version: 1,
        };
        const read = await rulesNow(reads, service.id, effectiveFrom);
        if (read.rules.some((other) => other.id === id)) refuse("rowTwice", ["price_rules"]);
        // K-25 price_rules_one_in_effect: one price per service and conditions at any instant (23P01).
        if (
          read.rules.some(
            (other) =>
              sameConditions(other.conditions, rule.conditions) && overlaps(rangeOf(other), rangeOf(rule)),
          )
        )
          refuse("overlap", ["effectiveFrom", "effectiveTo"]);
        const ties = tiesFor(rule, read);
        return recordPrice({
          closed: null,
          closeAt: null,
          opened: rule,
          openedGiven: input.id,
          ties,
          state: [insert("price_rules", ruleValues(rule)), ...ties.map(tieInsert)],
          versionsRead: [...serviceRefs(service), ...tieRefs(ties, read.rules)],
        });
      }),

    changePrice: (input) =>
      serial(async (reads) => {
        const service = await serviceOf(reads, input.serviceId);
        const fields = await priceFields(reads, service, input);
        const id = newId("price", input.id, "price_rules");
        const at = fromNow(input.effectiveFrom, "effectiveFrom");
        const atMs = msOf(at);
        const read = await rulesNow(reads, service.id, at);
        if (read.rules.some((other) => other.id === id)) refuse("rowTwice", ["price_rules"]);
        const same = read.rules.filter((rule) => sameConditions(rule.conditions, fields.conditions));
        const current = same.find((rule) => inEffectAt(rule, atMs));
        if (current === undefined) return refuse("noPriceToChange", ["conditions", "effectiveFrom"]);
        if (current.currency !== currency) refuse("currencyMismatch", ["currency"]);
        const version = closable(current, input.expectVersion);
        // A later price of the same conditions is already set: the owner withdraws or corrects it first (default 5).
        if (
          same.some((rule) => rule.id !== current.id && !isEmpty(rangeOf(rule)) && rangeOf(rule).from > atMs)
        )
          refuse("overlap", ["effectiveFrom"]);
        const opened: PriceRuleRow = {
          id,
          businessId,
          serviceId: service.id,
          ...fields,
          effectiveFrom: at,
          effectiveTo: current.effectiveTo,
          version: 1,
        };
        // The new rule is saved beside the others, the old one closed at its instant.
        const others: PriceRulesRead = {
          rules: read.rules.map((rule) => (rule.id === current.id ? { ...rule, effectiveTo: at } : rule)),
          ties: read.ties,
        };
        const ties = tiesFor(opened, others);
        return recordPrice({
          closed: current,
          closeAt: at,
          opened,
          openedGiven: input.id,
          ties,
          state: [
            update("price_rules", current.id, version, { effective_to: at }),
            insert("price_rules", ruleValues(opened)),
            ...ties.map(tieInsert),
          ],
          versionsRead: [...serviceRefs(service), ...tieRefs(ties, read.rules)],
        });
      }),

    withdrawPrice: (input) =>
      serial(async (reads) => {
        const service = await serviceOf(reads, input.serviceId);
        const ruleId = requireId(input.ruleId, "ruleId");
        const setByPersonId = requireId(input.setByPersonId, "setByPersonId");
        const read = await rulesNow(reads, service.id, now);
        const target = read.rules.find((rule) => rule.id === ruleId);
        if (target === undefined || isEmpty(rangeOf(target))) return refuse("notFound", ["ruleId"]);
        // Only a price set for a later date is withdrawn, before it starts (K-25 "Prices").
        if (msOf(target.effectiveFrom) < nowMs) refuse("started", ["ruleId"]);
        const version = closable(target, input.expectVersion);
        const startMs = msOf(target.effectiveFrom);
        const replaced = read.rules.find(
          (rule) =>
            rule.id !== target.id &&
            sameConditions(rule.conditions, target.conditions) &&
            rule.effectiveTo !== null &&
            msOf(rule.effectiveTo) === startMs &&
            !isEmpty(rangeOf(rule)),
        );
        const state: StateWrite[] = [
          update("price_rules", target.id, version, { effective_to: target.effectiveFrom }),
        ];
        let opened: PriceRuleRow | null = null;
        let ties: PriceTieRow[] = [];
        if (replaced !== undefined) {
          if (replaced.currency !== currency) refuse("currencyMismatch", ["currency"]);
          const id = newId("price", input.id, "price_rules");
          if (read.rules.some((other) => other.id === id)) refuse("rowTwice", ["price_rules"]);
          // The price it replaced opens again as a new row from that instant (the closed one never reopens).
          opened = {
            id,
            businessId,
            serviceId: service.id,
            conditions: replaced.conditions,
            priceCents: replaced.priceCents,
            fromCents: replaced.fromCents,
            currency: replaced.currency,
            setByPersonId,
            effectiveFrom: target.effectiveFrom,
            effectiveTo: target.effectiveTo,
            version: 1,
          };
          const others: PriceRulesRead = {
            rules: read.rules.map((rule) =>
              rule.id === target.id ? { ...rule, effectiveTo: target.effectiveFrom } : rule,
            ),
            ties: read.ties,
          };
          ties = tiesFor(opened, others);
          state.push(insert("price_rules", ruleValues(opened)), ...ties.map(tieInsert));
        }
        return recordPrice({
          closed: target,
          closeAt: target.effectiveFrom,
          opened,
          openedGiven: input.id,
          ties,
          state,
          versionsRead: [
            ...serviceRefs(service),
            ...(replaced === undefined || addedRules.some((rule) => rule.id === replaced.id)
              ? []
              : [ref("price_rules", replaced.id, replaced.version)]),
            ...tieRefs(ties, read.rules),
          ],
        });
      }),

    closePrice: (input) =>
      serial(async (reads) => {
        const service = await serviceOf(reads, input.serviceId);
        const ruleId = requireId(input.ruleId, "ruleId");
        const at = fromNow(input.at, "at");
        const read = await rulesNow(reads, service.id, now);
        const target = read.rules.find((rule) => rule.id === ruleId);
        if (target === undefined || isEmpty(rangeOf(target))) return refuse("notFound", ["ruleId"]);
        const range = rangeOf(target);
        if (msOf(at) < range.from) refuse("closedBeforeStart", ["at"]);
        if (range.to !== null && msOf(at) >= range.to) refuse("badInput", ["at"]);
        const version = closable(target, input.expectVersion);
        return recordPrice({
          closed: target,
          closeAt: at,
          opened: null,
          openedGiven: undefined,
          ties: [],
          state: [update("price_rules", target.id, version, { effective_to: at })],
          versionsRead: serviceRefs(service),
        });
      }),

    answerTie: (input) =>
      serial(async (reads) => {
        const service = await serviceOf(reads, input.serviceId);
        const tieId = requireId(input.tieId, "tieId");
        const winner = requireId(input.winnerRuleId, "winnerRuleId");
        const answeredBy = requireId(input.answeredByPersonId, "answeredByPersonId");
        const read = await rulesNow(reads, service.id, now);
        const tie = read.ties.find((each) => each.id === tieId);
        if (tie === undefined) return refuse("notFound", ["tieId"]);
        if (addedTies.some((each) => each.id === tie.id)) refuse("rowTwice", ["price_rule_ties"]);
        if (tie.winnerRuleId !== null) refuse("tieAnswer", ["tieId"]);
        if (winner !== tie.firstRuleId && winner !== tie.secondRuleId) refuse("tieAnswer", ["winnerRuleId"]);
        once("price_rule_ties", tie.id);
        const version = versionRead(input.expectVersion, tie.version, "price_rule_ties");
        const state = [
          update("price_rule_ties", tie.id, version, {
            winner_rule_id: winner,
            answered_at: now,
            answered_by_person_id: answeredBy,
          }),
        ];
        tieEdits.set(tie.id, {
          ...tie,
          winnerRuleId: winner,
          answeredAt: now,
          answeredByPersonId: answeredBy,
        });
        touched.add(`price_rule_ties:${tie.id}`);
        return record(tie.id, { versionsRead: serviceRefs(service), state });
      }),

    takeTermsSnapshot: (input) =>
      serial(async (reads) => {
        const bookingId = requireId(input.bookingId, "bookingId");
        if (snapshots.has(bookingId)) refuse("snapshotTaken", ["bookingId"]);
        const flow = oneOf(input.flow, ["A", "B"] as const, "flow");
        const given: unknown = input.noticesShown;
        if (!Array.isArray(given)) return refuse("badInput", ["noticesShown"]);
        const noticesShown = given.map((notice: unknown, index) =>
          requireWords(notice, `noticesShown.${String(index)}`),
        );
        const checked: SnapshotInput = {
          bookingId,
          flow,
          serviceId: requireId(input.serviceId, "serviceId"),
          serviceMoneyId: requireId(input.serviceMoneyId, "serviceMoneyId"),
          termsConsentId: idOrNull(input.termsConsentId, "termsConsentId"),
          termsVersion: requireWords(input.termsVersion, "termsVersion"),
          termsLanguage: requireLanguage(input.termsLanguage, "termsLanguage"),
          noticesShown,
          zone: requireZone(input.zone, "zone"),
        };
        const service = await serviceOf(reads, checked.serviceId);
        const way = (await waysNow(reads, service.id)).find((each) => each.id === checked.serviceMoneyId);
        if (way === undefined) return refuse("notFound", ["serviceMoneyId"]);
        const sources = await reads.termsSourcesOf(businessId, flow, now);
        const snapshot = snapshotOf({
          input: checked,
          businessId,
          writtenAt: now,
          service,
          way,
          sources,
          versionsRead: [
            ...serviceRefs(service),
            ...(addedWays.some((each) => each.id === way.id)
              ? []
              : [ref("service_money", way.id, way.version)]),
          ],
        });
        snapshots.set(bookingId, snapshot);
        touched.add(`booking_terms:${bookingId}`);
        built.push(snapshot.writes);
        return snapshot;
      }),

    written: () => {
      const seen = new Set<string>();
      const versionsRead: RowRef[] = [];
      for (const row of built.flatMap((writes) => writes.versionsRead)) {
        const key = `${row.table}|${row.rowId}|${String(row.version)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        versionsRead.push(row);
      }
      return { versionsRead, state: built.flatMap((writes) => writes.state) };
    },
  };
}
