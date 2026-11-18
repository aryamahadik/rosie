// Why the catalog and pricing service refuses (C-096, T-320), and how it answers notBuilt. A refusal writes nothing: the
// call that asked fails closed, so the turn commits no catalog row. Its message and fields hold labels and field names
// only, never an amount, a name or a person's words (K-08 v1 README line 75).

import { LaneNotBuiltError, NotBuiltError, isCallName } from "../../tool-api";

/** Why a catalog row was refused: a label. */
export type CatalogRefusal =
  /** A field that is not the shape K-23, K-25 or K-30 takes: an empty id, a decimal amount, an unknown price kind. */
  | "badInput"
  /** A row of another business, given or read: every row is the call's business's (arch 10 line 546). */
  | "otherBusiness"
  /** A read answered a row it was not asked for (another service's way or rule), which the service never uses. */
  | "badRead"
  /** No such kind, service, way, rule or tie of this business, as read. */
  | "notFound"
  /** A kind of work already placed on the business. */
  | "kindTwice"
  /** A service whose kind is not one of the business's (K-23 company_kinds; K-25 rule 9). */
  | "kindNotOnBusiness"
  /** A path that is not one of the master's 28 for the way's flow (D66: never a hold). */
  | "pathUnknown"
  /** A path the kind's plug-in does not offer in that flow (K-24 kind_flows.combos; S1-13; K-25 rule 9). */
  | "pathNotOffered"
  /**
   * A path that takes money while the kind takes no money through Rosie (fact nomoney; fields path), or while the
   * business does (K-23 business_setup.no_money, M02; a business with no setup row read as no money through Rosie,
   * K-05 v1.18 default 161; fields path and noMoney): K-25 rule 9, "only nothing before and after counter (A) or own (B)".
   */
  | "noMoneyPath"
  /** A deposit over the price known then: a list price, or a visit path's starting price (K-25 rule 9; S1-13; A4-13). */
  | "depositOverPrice"
  /** A list-priced way with no price rule of its place or of the service in effect at its save (K-25 rule 9). */
  | "noPriceInEffect"
  /** A way's location that is not one of the business's, as the business's scope reads it (K-25 rule 9; S1-43). */
  | "locationNotOnBusiness"
  /** A location not of the way's place's kind: a shop or office, a meeting spot, one with a travel area (K-25 rule 9). */
  | "locationNotOfPlace"
  /** A price rule's worker that is not one of the business's worker resources (K-25 rule 9; T-320 N1). */
  | "workerNotOnBusiness"
  /** A kind of work placed under a company that is not the business's one company (K-23 companies; T-320 N1). */
  | "companyNotOnBusiness"
  /** A space linked to a service that is not one of the business's spaces or things (K-25 rule 9; T-320 N1). */
  | "spaceNotOnBusiness"
  /** A fact or switch name that is not in K-26 v1's registry (trade_facts, plugin_switches; K-05 CQ-349 (3)). */
  | "nameNotInRegistry"
  /**
   * A deposit on a path that takes none, both deposit_cents and deposit_percent on any path (CQ-128 (1): K-25 v1's CHECK
   * lets a non-deposit path hold both), or a deposit path without exactly one of them (FS row V06).
   */
  | "depositNotOnPath"
  /** A fee on a path that takes nothing before ("no fee possible": FS section 4). */
  | "feeOnNothingTaken"
  /** A card or full path with no fee, outside sensitive work (FS row V08; RULES 3.5; K-25 rule 9). */
  | "feeMissing"
  /** An amount in another currency than the business's one (K-25 rule 7). */
  | "currencyMismatch"
  /** A tip line on a path whose bill Rosie does not send (FS row V11). */
  | "tipLineNotOnBill"
  /** Both forms of free-cancel time on one way (FS row H06). */
  | "twoCutoffs"
  /** A second way of one service at one place (S1-13: one way per service and place). */
  | "wayTwice"
  /** A second write to one row in one turn, or a write to a row this turn inserted: one write per row per commit. */
  | "rowTwice"
  /** The version the caller read is not the version read now (limit 4: a write made from an old read). */
  | "versionChanged"
  /** Two rules of one service with the same conditions in effect at once (K-25 price_rules_one_in_effect). */
  | "overlap"
  /** A price change with no price in effect at its instant for those conditions: nothing to close. */
  | "noPriceToChange"
  /** A change dated before now: effective dates are history and never move back (arch 09 line 488). */
  | "backdated"
  /** A price withdrawn or closed at its own start after it started (K-25: only before it starts). */
  | "started"
  /** A price closed before its own start (K-25 price_rules_dates_in_order, 23514). */
  | "closedBeforeStart"
  /** A tie's answer that names neither of its two rules, or a tie answered already. */
  | "tieAnswer"
  /** A second terms snapshot of one booking: a snapshot is written once (K-30 rule 6). */
  | "snapshotTaken"
  /** A write that would change a terms snapshot or its rules (K-30 rule 6: insert only, never updated). */
  | "snapshotImmutable"
  /**
   * A write to a table the catalog does not write, or a delete (K-05 v1 has no delete write; CQ-128 (2)); or an update
   * whose set names the row's business, its id or a column of its key (T-320 N2: a row never moves business or key).
   */
  | "notCatalogWrite";

/** A catalog row refused: nothing is written. Names the reason and the fields at fault, never a value. */
export class CatalogRefusedError extends Error {
  override name = "CatalogRefusedError";
  readonly reason: CatalogRefusal;
  readonly fields: readonly string[];

  constructor(reason: CatalogRefusal, fields: readonly string[] = []) {
    super(
      fields.length === 0
        ? `catalog refused: ${reason}`
        : `catalog refused: ${reason} (${fields.join(", ")})`,
    );
    this.reason = reason;
    this.fields = [...fields];
  }
}

/** Throws the refusal. */
export function refuse(reason: CatalogRefusal, fields: readonly string[] = []): never {
  throw new CatalogRefusedError(reason, fields);
}

/** Whether an error is the service's refusal (nothing was built). */
export function isCatalogRefusal(error: unknown): error is CatalogRefusedError {
  return error instanceof CatalogRefusedError;
}

/**
 * The notBuilt of the Tool API call the service serves, which the base answers as notBuilt with the call's transaction
 * rolled back, so nothing is written (T-290; T-1022): NotBuiltError for a K-09 v1 call, LaneNotBuiltError for a journey
 * lane's call.
 */
export function notBuiltFor(call: string): NotBuiltError | LaneNotBuiltError {
  return isCallName(call) ? new NotBuiltError(call) : new LaneNotBuiltError(call);
}
