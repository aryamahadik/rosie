// The catalog's read port on PostgreSQL (T-1429; C-096; DL-888, DL-911): T-320's CatalogReads (../reads.ts) bound to
// K-05 v1.18's five catalog reads as db/repo builds them (T-1428: db/repo/catalog-reads.ts), under the call's own
// business. Journey 1's calls (T-633, T-634) build it for each call with the call's business (CallContext.businessId)
// and hand it to createCatalog by name (its `reads`), as the turn face hands in its reads (../../../tool-api/turn-face/pg).
//
//   kindsOf          readBusinessKinds      item 72: each company_kinds row as BusinessKind, paths.A and paths.B the
//                                           combos of that flow's kind_flows row, or empty when the kind has none there
//   servicesOf       readBusinessServices   item 73: each services row as ServiceRow
//   waysOf           readServiceWays        item 74: each service_money row as WayRow
//   priceRulesOf     readServicePriceRules  item 75: each price_rules row as PriceRuleRow, its conditions together, and
//                                           each price_rule_ties row as PriceTieRow
//   termsSourcesOf   readTermsSources       item 76: flowDefault the flow_defaults row of the flow asked, or null when
//                                           the business has none there; rules and priceOkLimits each row as ScopedRow
//
// Each port read calls the standalone K-05 read on the Tool API's client, rosie_app (T-1428's handoff; DL-911): one
// read-only transaction of its own at repeatable read on the primary, uncached, with the scope set to the call's business
// and confirmed (requireBusinessScope) before its first read, so every row and version one answer holds is one moment's.
// It runs beside the call's own transaction (db/repo/scope.ts withBusiness: read committed, which the In forms refuse), on
// a connection of its own from the same client; no In form is used. The catalog writes nothing there: its rows go into
// the turn's one commit as stateWrites (../service.ts), which compares every version read (limit 4).
//
// The port is bound as it stands (DL-911, lead note 1; K-05 README item 72 and "What the new tasks must hold to"): read
// 1's setup (no_money), item 77's rowIds and the kind_flows rows' names and versions have no field in it yet, so they are
// left unread here; the catalog cross-row checks card (T-1433) widens the port and reads them. Every field the port has is
// mapped from its own field of the answer, never filled with a default.
//
// Fails closed (K-05 README "Who reads them": "A notFound or transient answer, or a row of another business, throws and
// fails closed, never an empty list or a guessed row"); the service's own otherBusiness and badRead checks stay:
//   - a port read asked for another business than the call's is refused before anything is read (otherBusiness), and a
//     binding with no business is never made (a TypeError when it is built);
//   - a K-05 error answer, notFound (the business does not exist or its scope does not show it) or transient, is thrown
//     as CatalogReadError carrying that answer as K-05 gave it, so the call's handler can answer K-09's own error (a
//     transient, for one);
//   - an answer for another business, or holding a row of another business, is thrown (otherBusiness), never used;
//   - whatever db/repo throws (a request it refuses; a stored value its answer cannot carry: a span not whole minutes, a
//     clock time of 24:00 or with a fraction, an empty trade name, a NULL element in a list) leaves as it was thrown, its
//     words unchanged, and so does the service's call that made the read.
// Nothing here logs; what it throws names a read and a code, never a value or an id.

import {
  readBusinessKinds,
  readBusinessServices,
  readServicePriceRules,
  readServiceWays,
  readTermsSources,
  type BusinessKindRead,
  type CatalogRead,
  type FlowDefaultRead,
  type KindFlowRead,
  type OwnerRuleRead,
  type PriceConditionsRead,
  type PriceOkLimitRead,
  type PriceRuleRead,
  type PriceTieRead,
  type ReadBusinessKindsOutcome,
  type ReadBusinessKindsRequest,
  type ReadBusinessServicesOutcome,
  type ReadBusinessServicesRequest,
  type ReadServicePriceRulesOutcome,
  type ReadServicePriceRulesRequest,
  type ReadServiceWaysOutcome,
  type ReadServiceWaysRequest,
  type ReadTermsSourcesOutcome,
  type ReadTermsSourcesRequest,
  type ServiceRead,
  type WayRead,
} from "../../../../../db/repo/catalog-reads";
import type { Sql } from "../../../../../db/repo/scope";
import type { NotFoundError, TransientError } from "../../../../../db/repo/targets";
import type { CatalogReads } from "../reads";
import type {
  BusinessKind,
  Flow,
  FlowDefault,
  PriceConditions,
  PriceRuleRow,
  PriceTieRow,
  ScopedRow,
  ServiceRow,
  WayRow,
} from "../types";

// ---- the five K-05 v1.18 reads the port is bound to ------------------------------------------------------------------

/**
 * K-05 v1.18's five catalog reads as the binding calls them: each takes its request and answers its response or one of
 * its errors (notFound, transient), or throws as db/repo throws. pgCatalogK05Reads binds them to db/repo's standalone
 * reads; a test hands in fakes.
 */
export interface CatalogK05Reads {
  readBusinessKinds(request: ReadBusinessKindsRequest): Promise<ReadBusinessKindsOutcome>;
  readBusinessServices(request: ReadBusinessServicesRequest): Promise<ReadBusinessServicesOutcome>;
  readServiceWays(request: ReadServiceWaysRequest): Promise<ReadServiceWaysOutcome>;
  readServicePriceRules(request: ReadServicePriceRulesRequest): Promise<ReadServicePriceRulesOutcome>;
  readTermsSources(request: ReadTermsSourcesRequest): Promise<ReadTermsSourcesOutcome>;
}

/**
 * The five reads on `toolApi`, a client whose connections run as rosie_app, the Tool API's role (T-1428's handoff; its
 * security review N1): each db/repo's standalone read, in a read-only transaction at repeatable read of its own.
 */
export function pgCatalogK05Reads(toolApi: Sql): CatalogK05Reads {
  return {
    readBusinessKinds: (request) => readBusinessKinds(toolApi, request),
    readBusinessServices: (request) => readBusinessServices(toolApi, request),
    readServiceWays: (request) => readServiceWays(toolApi, request),
    readServicePriceRules: (request) => readServicePriceRules(toolApi, request),
    readTermsSources: (request) => readTermsSources(toolApi, request),
  };
}

// ---- what the binding throws ------------------------------------------------------------------------------------------

/**
 * Why a catalog read failed the call closed: K-05's own error answer (notFound, transient), or another business than
 * the call's, asked or answered (otherBusiness).
 */
export type CatalogReadFault = "notFound" | "transient" | "otherBusiness";

/**
 * A catalog read failed the call closed (the top of this file): never read as none. `answer` is K-05's error answer as
 * the read gave it (notFound with its table and row, transient with its SQLSTATE), passed on so the call's handler can
 * answer its own error; null for otherBusiness. The message names the read and the code, never a value or an id.
 */
export class CatalogReadError extends Error {
  override name = "CatalogReadError";
  /** The K-05 read that failed (a label). */
  readonly read: CatalogRead;
  readonly code: CatalogReadFault;
  readonly answer: NotFoundError | TransientError | null;

  constructor(read: CatalogRead, code: CatalogReadFault, answer: NotFoundError | TransientError | null) {
    super(
      code === "otherBusiness"
        ? `${read} met another business than the call's: the call fails closed`
        : `${read} answered ${code}: the call fails closed`,
    );
    this.read = read;
    this.code = code;
    this.answer = answer;
  }
}

/** Whether a read's outcome is one of K-05's error answers: an object with its own "error" code. */
function isErrorAnswer(outcome: object): outcome is NotFoundError | TransientError {
  return "error" in outcome;
}

/** A read's response, or its K-05 error answer thrown (never read as none). */
function answered<T extends object>(read: CatalogRead, outcome: T | NotFoundError | TransientError): T {
  if (isErrorAnswer(outcome)) throw new CatalogReadError(read, outcome.error, outcome);
  return outcome;
}

/** The business a binding is built for: a non-empty id, never none (the call's own: CallContext.businessId). */
function callBusiness(businessId: unknown): string {
  if (typeof businessId !== "string" || businessId === "") {
    throw new TypeError(
      "the catalog's reads are bound to the call's own business, a non-empty id, never none",
    );
  }
  return businessId;
}

// ---- the rows, field by field (README items 72 to 76, "The mapping") ---------------------------------------------------

/** paths.A or paths.B: the combos of the kind's kind_flows row in that flow, or empty when it has none there. */
function pathsIn(flows: readonly KindFlowRead[], flow: Flow): string[] {
  const rows = flows.filter((row) => row.flow === flow);
  const [row, ...more] = rows;
  if (more.length > 0) {
    throw new Error("readBusinessKinds answered two kind_flows rows of one kind in one flow");
  }
  return row === undefined ? [] : [...row.combos];
}

function kindOf(row: BusinessKindRead): BusinessKind {
  return {
    companyId: row.companyId,
    kindId: row.kindId,
    businessId: row.businessId,
    tradeName: row.tradeName,
    facts: [...row.facts],
    switchesA: [...row.switchesA],
    switchesB: [...row.switchesB],
    version: row.version,
    paths: { A: pathsIn(row.flows, "A"), B: pathsIn(row.flows, "B") },
  };
}

function serviceOf(row: ServiceRead): ServiceRow {
  return {
    id: row.id,
    businessId: row.businessId,
    kindId: row.kindId,
    name: row.name,
    priceKind: row.priceKind,
    unit: row.unit,
    lengthMinutes: row.lengthMinutes,
    position: row.position,
    active: row.active,
    version: row.version,
  };
}

function wayOf(row: WayRead): WayRow {
  return {
    id: row.id,
    serviceId: row.serviceId,
    businessId: row.businessId,
    flow: row.flow,
    place: row.place,
    locationId: row.locationId,
    path: row.path,
    depositCents: row.depositCents,
    depositPercent: row.depositPercent,
    feeCents: row.feeCents,
    currency: row.currency,
    cutoffBeforeMinutes: row.cutoffBeforeMinutes,
    cutoffDayBeforeAt: row.cutoffDayBeforeAt,
    tipLine: row.tipLine,
    active: row.active,
    version: row.version,
  };
}

function conditionsOf(conditions: PriceConditionsRead): PriceConditions {
  return {
    serviceMoneyId: conditions.serviceMoneyId,
    workerResourceId: conditions.workerResourceId,
    weekdays: conditions.weekdays,
    fromTime: conditions.fromTime,
    untilTime: conditions.untilTime,
  };
}

function ruleOf(row: PriceRuleRead): PriceRuleRow {
  return {
    id: row.id,
    businessId: row.businessId,
    serviceId: row.serviceId,
    conditions: conditionsOf(row.conditions),
    priceCents: row.priceCents,
    fromCents: row.fromCents,
    currency: row.currency,
    setByPersonId: row.setByPersonId,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    version: row.version,
  };
}

function tieOf(row: PriceTieRead): PriceTieRow {
  return {
    id: row.id,
    businessId: row.businessId,
    serviceId: row.serviceId,
    firstRuleId: row.firstRuleId,
    secondRuleId: row.secondRuleId,
    askedAt: row.askedAt,
    winnerRuleId: row.winnerRuleId,
    answeredAt: row.answeredAt,
    answeredByPersonId: row.answeredByPersonId,
    version: row.version,
  };
}

function flowDefaultOf(row: FlowDefaultRead): FlowDefault {
  return {
    businessId: row.businessId,
    flow: row.flow,
    cutoffBeforeMinutes: row.cutoffBeforeMinutes,
    cutoffDayBeforeAt: row.cutoffDayBeforeAt,
    version: row.version,
  };
}

/** A K-26 rules or price_ok_limits row as a terms snapshot names it (ScopedRow): never a rule's kind or value. */
function scopedOf(row: OwnerRuleRead | PriceOkLimitRead): ScopedRow {
  return {
    id: row.id,
    businessId: row.businessId,
    flow: row.flow,
    kindId: row.kindId,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    version: row.version,
  };
}

// ---- the port -----------------------------------------------------------------------------------------------------------

/**
 * T-320's CatalogReads over `k05`, for the call's own business: every port read refuses another business before it
 * reads, asks K-05 for the call's business alone, throws K-05's error answers and any row of another business, and maps
 * each row field by field (the top of this file). `businessId` must be the call's own (CallContext.businessId), never a
 * value from a request; with none the binding is not made (TypeError).
 */
export function catalogReadsOf(k05: CatalogK05Reads, businessId: string): CatalogReads {
  const business = callBusiness(businessId);

  /** Another business than the call's is refused before anything is read. */
  const asking = (read: CatalogRead, asked: string): void => {
    if (asked !== business) throw new CatalogReadError(read, "otherBusiness", null);
  };

  /** The answer's business and every row's must be the call's own; a row of another business is never used. */
  const ours = (
    read: CatalogRead,
    echoed: string,
    rows: readonly { readonly businessId: string }[],
  ): void => {
    if (echoed !== business || rows.some((row) => row.businessId !== business)) {
      throw new CatalogReadError(read, "otherBusiness", null);
    }
  };

  return {
    async kindsOf(asked) {
      const read = "readBusinessKinds";
      asking(read, asked);
      const answer = answered(read, await k05.readBusinessKinds({ businessId: business }));
      ours(read, answer.businessId, answer.kinds);
      return answer.kinds.map(kindOf);
    },

    async servicesOf(asked) {
      const read = "readBusinessServices";
      asking(read, asked);
      const answer = answered(read, await k05.readBusinessServices({ businessId: business }));
      ours(read, answer.businessId, answer.services);
      return answer.services.map(serviceOf);
    },

    async waysOf(asked, serviceId) {
      const read = "readServiceWays";
      asking(read, asked);
      const answer = answered(read, await k05.readServiceWays({ businessId: business, serviceId }));
      ours(read, answer.businessId, answer.ways);
      return answer.ways.map(wayOf);
    },

    async priceRulesOf(asked, serviceId, at) {
      const read = "readServicePriceRules";
      asking(read, asked);
      const answer = answered(read, await k05.readServicePriceRules({ businessId: business, serviceId, at }));
      ours(read, answer.businessId, [...answer.rules, ...answer.ties]);
      return { rules: answer.rules.map(ruleOf), ties: answer.ties.map(tieOf) };
    },

    async termsSourcesOf(asked, flow, at) {
      const read = "readTermsSources";
      asking(read, asked);
      const given: unknown = flow;
      if (given !== "A" && given !== "B") throw new TypeError(`${read}: the flow asked is A or B`);
      const answer = answered(read, await k05.readTermsSources({ businessId: business, at }));
      ours(read, answer.businessId, [...answer.flowDefaults, ...answer.rules, ...answer.priceOkLimits]);
      const [flowDefault, ...more] = answer.flowDefaults.filter((row) => row.flow === flow);
      if (more.length > 0) {
        throw new Error(`${read} answered two flow_defaults rows of one flow`);
      }
      return {
        flowDefault: flowDefault === undefined ? null : flowDefaultOf(flowDefault),
        rules: answer.rules.map(scopedOf),
        priceOkLimits: answer.priceOkLimits.map(scopedOf),
      };
    },
  };
}

/**
 * T-320's CatalogReads on PostgreSQL for one call: K-05 v1.18's standalone reads on `toolApi` (a client whose
 * connections run as rosie_app, on the primary, uncached), under `businessId`, the call's own business. Each read takes a
 * connection of the client's own beside the one the call's transaction holds.
 */
export function pgCatalogReads(toolApi: Sql, businessId: string): CatalogReads {
  return catalogReadsOf(pgCatalogK05Reads(toolApi), businessId);
}
