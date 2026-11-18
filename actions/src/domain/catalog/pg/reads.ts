// The catalog's read port on PostgreSQL (T-1429; C-096; DL-888, DL-911; widened by T-1433): T-320's CatalogReads
// (../reads.ts) bound to K-05 v1.18's five catalog reads as db/repo builds them (T-1428: db/repo/catalog-reads.ts), and
// its three reads of a row by id to K-05 v1.2 readTurnState's facts with T-667's setup homes (db/repo/setup/turn-state.ts),
// under the call's own business. Journey 1's calls (T-633, T-634) build it for each call with the call's business
// (CallContext.businessId) and the turn's handle, and hand it to createCatalog by name (its `reads`), as the turn face
// hands in its reads (../../../tool-api/turn-face/pg).
//
//   kindsOf          readBusinessKinds      item 72: setup the business_setup row's no_money with its key and version, or
//                                           null; each company_kinds row as BusinessKind with item 77's name (rowId),
//                                           paths.A and paths.B the combos of that flow's kind_flows row, or empty when
//                                           the kind has none there, and flows each kind_flows row's name and version
//   servicesOf       readBusinessServices   item 73: each services row as ServiceRow
//   waysOf           readServiceWays        item 74: each service_money row as WayRow
//   priceRulesOf     readServicePriceRules  item 75: each price_rules row as PriceRuleRow, its conditions together, and
//                                           each price_rule_ties row as PriceTieRow
//   termsSourcesOf   readTermsSources       item 76: flowDefault the flow_defaults row of the flow asked, with item 77's
//                                           name, or null when the business has none there; rules and priceOkLimits each
//                                           row as ScopedRow
//   locationOf       readTurnState facts    locations' business_id, kind and travel_miles (README ruling 4 (c))
//   resourceOf       readTurnState facts    resources' business_id, kind and active (ruling 4 (d))
//   placeOrThingOf   readTurnState facts    places_or_things' business_id and kind (T-320 N1)
//
// Each list read calls the standalone K-05 read on the Tool API's client, rosie_app (T-1428's handoff; DL-911): one
// read-only transaction of its own at repeatable read on the primary, uncached, with the scope set to the call's business
// and confirmed (requireBusinessScope) before its first read, so every row and version one answer holds is one moment's.
// It runs beside the call's own transaction (db/repo/scope.ts withBusiness: read committed, which the In forms refuse), on
// a connection of its own from the same client; no In form is used. Each read of a row by id is readTurnState, a turn's
// read run by rosie_job (K-05 v1.2 item 26, default 25), on the runtime side's client the call hands in with the turn's
// handle, in a read-only transaction of its own at repeatable read under the call's business: a row of another business,
// or none, answers notFound for that row, which the port reads as null (the check's refusal), never as a row. A call with
// no turn handle (an owner page's, K-21) reads no row by id: those reads throw (noTurn) and the call fails closed (K-05
// open gap 84). Of readTurnState's answer only its business and the facts asked are used: never the handle's address,
// its people, roles, open questions, bookings, pauses or consents. The catalog writes nothing there: its rows go into the
// turn's one commit as stateWrites (../service.ts), which compares every version read (limit 4).
//
// The port is bound in full (T-1433 widens what T-1429 bound as it stood, DL-911): read 1's setup, item 77's names and
// the kind_flows rows' versions are mapped from their own fields of the answer, as every other field is, never filled
// with a default.
//
// Fails closed (K-05 README "Who reads them": "A notFound or transient answer, or a row of another business, throws and
// fails closed, never an empty list or a guessed row"); the service's own otherBusiness and badRead checks stay:
//   - a port read asked for another business than the call's is refused before anything is read (otherBusiness), and a
//     binding with no business is never made (a TypeError when it is built);
//   - a K-05 error answer, notFound (the business, or for readTurnState the turn's handle, does not exist or the scope
//     does not show it) or transient, is thrown as CatalogReadError carrying that answer as K-05 gave it, so the call's
//     handler can answer K-09's own error (a transient, for one); readTurnState's notFound of the very row asked is the
//     row's absence (null), and its unknownFact, which no home here can draw, throws;
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
  type BusinessSetupRead,
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
import { readTurnState, type SetupTurnStateOutcome } from "../../../../../db/repo/setup/turn-state";
import type { NotFoundError, TransientError } from "../../../../../db/repo/targets";
import type { FactValue, ReadTurnStateRequest } from "../../../../../db/repo/turn-state";
import type { CatalogReads } from "../reads";
import type {
  BusinessKind,
  BusinessSetup,
  Flow,
  FlowDefault,
  KindFlowRow,
  LocationKind,
  LocationRow,
  PlaceOrThingRow,
  PriceConditions,
  PriceRuleRow,
  PriceTieRow,
  ResourceRow,
  ScopedRow,
  ServiceRow,
  WayRow,
} from "../types";

// ---- the five K-05 v1.18 reads the port is bound to ------------------------------------------------------------------

/**
 * The K-05 reads the binding calls: v1.18's five catalog reads, and v1.2's readTurnState with T-667's setup homes for a
 * row by id. Each takes its request and answers its response or one of its errors (notFound, transient, and for
 * readTurnState unknownFact), or throws as db/repo throws. pgCatalogK05Reads binds them to db/repo; a test hands in
 * fakes.
 */
export interface CatalogK05Reads {
  readBusinessKinds(request: ReadBusinessKindsRequest): Promise<ReadBusinessKindsOutcome>;
  readBusinessServices(request: ReadBusinessServicesRequest): Promise<ReadBusinessServicesOutcome>;
  readServiceWays(request: ReadServiceWaysRequest): Promise<ReadServiceWaysOutcome>;
  readServicePriceRules(request: ReadServicePriceRulesRequest): Promise<ReadServicePriceRulesOutcome>;
  readTermsSources(request: ReadTermsSourcesRequest): Promise<ReadTermsSourcesOutcome>;
  readTurnState(request: ReadTurnStateRequest): Promise<SetupTurnStateOutcome>;
}

/**
 * The reads on PostgreSQL: the five on `toolApi`, a client whose connections run as rosie_app, the Tool API's role
 * (T-1428's handoff; its security review N1), each db/repo's standalone read in a read-only transaction at repeatable
 * read of its own; and readTurnState on `runtime`, the runtime side's client, rosie_job (K-05 v1.2 item 26, default 25),
 * in one of its own. With no runtime client (a call with no turn) readTurnState throws noTurn and reads nothing.
 */
export function pgCatalogK05Reads(toolApi: Sql, runtime: Sql | null = null): CatalogK05Reads {
  return {
    readBusinessKinds: (request) => readBusinessKinds(toolApi, request),
    readBusinessServices: (request) => readBusinessServices(toolApi, request),
    readServiceWays: (request) => readServiceWays(toolApi, request),
    readServicePriceRules: (request) => readServicePriceRules(toolApi, request),
    readTermsSources: (request) => readTermsSources(toolApi, request),
    readTurnState: (request) =>
      runtime === null
        ? Promise.reject(new CatalogReadError("readTurnState", "noTurn", null))
        : readTurnState(runtime, request),
  };
}

// ---- what the binding throws ------------------------------------------------------------------------------------------

/** The K-05 reads the binding names in what it throws: the five catalog reads and readTurnState. */
export type CatalogReadName = CatalogRead | "readTurnState";

/**
 * Why a catalog read failed the call closed: K-05's own error answer (notFound, transient), another business than the
 * call's, asked or answered (otherBusiness), or a row by id asked by a call that holds no turn handle (noTurn: K-05
 * open gap 84).
 */
export type CatalogReadFault = "notFound" | "transient" | "otherBusiness" | "noTurn";

/**
 * A catalog read failed the call closed (the top of this file): never read as none. `answer` is K-05's error answer as
 * the read gave it (notFound with its table and row, transient with its SQLSTATE), passed on so the call's handler can
 * answer its own error; null for otherBusiness and noTurn. The message names the read and the code, never a value or an
 * id.
 */
export class CatalogReadError extends Error {
  override name = "CatalogReadError";
  /** The K-05 read that failed (a label). */
  readonly read: CatalogReadName;
  readonly code: CatalogReadFault;
  readonly answer: NotFoundError | TransientError | null;

  constructor(read: CatalogReadName, code: CatalogReadFault, answer: NotFoundError | TransientError | null) {
    super(
      code === "otherBusiness"
        ? `${read} met another business than the call's: the call fails closed`
        : code === "noTurn"
          ? `${read} reads a row by its id for a turn, and the call holds no turn handle: the call fails closed`
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

/** A kind_flows row by item 77's name and version, as the answer gives them (its combos are the kind's paths). */
function flowRowOf(row: KindFlowRead): KindFlowRow {
  return { rowId: row.rowId, flow: row.flow, version: row.version };
}

function kindOf(row: BusinessKindRead): BusinessKind {
  return {
    rowId: row.rowId,
    companyId: row.companyId,
    kindId: row.kindId,
    businessId: row.businessId,
    tradeName: row.tradeName,
    facts: [...row.facts],
    switchesA: [...row.switchesA],
    switchesB: [...row.switchesB],
    version: row.version,
    paths: { A: pathsIn(row.flows, "A"), B: pathsIn(row.flows, "B") },
    flows: row.flows.map(flowRowOf),
  };
}

/** business_setup's no money with its key and version, as read 1 answers it (CQ-349 (2)). */
function setupOf(row: BusinessSetupRead): BusinessSetup {
  return { businessId: row.businessId, noMoney: row.noMoney, version: row.version };
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
    rowId: row.rowId,
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

// ---- a row by its id: readTurnState's facts (README v1.18 ruling 4 (c), (d); T-667's setup homes) ---------------------

/** The columns each read of a row by id asks for: never an address, a map point, a name or a person's id. */
const LOCATION_FACTS = ["business_id", "kind", "travel_miles"] as const;
const RESOURCE_FACTS = ["business_id", "kind", "active"] as const;
const SPACE_FACTS = ["business_id", "kind"] as const;

/** K-23 locations_kind_known. */
const LOCATION_KINDS: readonly LocationKind[] = ["shop", "office", "meeting_spot"];

/** A row's facts by column, the row's one version, or null when the business's scope shows no such row. */
interface RowFacts {
  readonly values: ReadonlyMap<string, unknown>;
  readonly version: number;
}

/** A fact's value that is not what its column holds: the read fails the call closed, naming the column, never the value. */
function cannotHold(table: string, column: string): never {
  throw new Error(`readTurnState answered ${table}.${column} with a value the column cannot hold`);
}

function textFact(facts: RowFacts, table: string, column: string): string {
  const value = facts.values.get(column);
  return typeof value === "string" ? value : cannotHold(table, column);
}

/** The facts of `table`'s row `rowId`, as one readTurnState answers them, every one of the row asked and one version. */
function rowFactsOf(
  facts: readonly FactValue[],
  table: string,
  rowId: string,
  columns: readonly string[],
): RowFacts {
  const values = new Map<string, unknown>();
  let version: number | null = null;
  for (const column of columns) {
    const fact = facts.find((each) => each.key === column);
    if (fact?.table !== table || fact.rowId !== rowId || fact.column !== column) {
      throw new Error(`readTurnState did not answer the ${table} facts it was asked`);
    }
    if (version !== null && fact.version !== version) {
      throw new Error(`readTurnState answered one ${table} row at two versions`);
    }
    version = fact.version;
    values.set(column, fact.value);
  }
  if (version === null) throw new Error(`readTurnState was asked no ${table} fact`);
  return { values, version };
}

function locationRowOf(id: string, businessId: string, facts: RowFacts): LocationRow {
  const kind = textFact(facts, "locations", "kind");
  const found = LOCATION_KINDS.find((each) => each === kind);
  if (found === undefined) return cannotHold("locations", "kind");
  const miles = facts.values.get("travel_miles");
  if (miles !== null && typeof miles !== "number") return cannotHold("locations", "travel_miles");
  return { id, businessId, kind: found, travelMiles: miles, version: facts.version };
}

function resourceRowOf(id: string, businessId: string, facts: RowFacts): ResourceRow {
  const active = facts.values.get("active");
  if (typeof active !== "boolean") return cannotHold("resources", "active");
  return {
    id,
    businessId,
    kind: textFact(facts, "resources", "kind"),
    active,
    version: facts.version,
  };
}

function spaceRowOf(id: string, businessId: string, facts: RowFacts): PlaceOrThingRow {
  return { id, businessId, kind: textFact(facts, "places_or_things", "kind"), version: facts.version };
}

/** The turn's handle a binding reads rows by id for: a non-empty id, or null for a call with no turn. */
function callHandle(handleId: unknown): string | null {
  if (handleId === null) return null;
  if (typeof handleId !== "string" || handleId === "") {
    throw new TypeError(
      "the catalog's reads of a row by id are bound to the turn's handle, a non-empty id, or none",
    );
  }
  return handleId;
}

// ---- the port -----------------------------------------------------------------------------------------------------------

/**
 * T-320's CatalogReads over `k05`, for the call's own business: every port read refuses another business before it
 * reads, asks K-05 for the call's business alone, throws K-05's error answers and any row of another business, and maps
 * each row field by field (the top of this file). `businessId` must be the call's own (CallContext.businessId), never a
 * value from a request; with none the binding is not made (TypeError). `handleId` is the turn's handle, for the reads of
 * a row by id (readTurnState is a turn's read); null for a call with no turn, whose reads of a row by id throw noTurn.
 */
export function catalogReadsOf(
  k05: CatalogK05Reads,
  businessId: string,
  handleId: string | null = null,
): CatalogReads {
  const business = callBusiness(businessId);
  const handle = callHandle(handleId);

  /**
   * One row of the business by its id, through readTurnState's facts under the call's business: its facts, or null when
   * readTurnState answers notFound for that very row (another business's, or none). Any other notFound (the turn's
   * handle, the business) or transient is thrown with K-05's answer; unknownFact, which none of these homes can draw,
   * throws; an answer for another business, or naming another business's row, fails the call closed.
   */
  const rowById = async (
    table: string,
    rowId: string,
    columns: readonly string[],
  ): Promise<RowFacts | null> => {
    const read = "readTurnState";
    if (handle === null) throw new CatalogReadError(read, "noTurn", null);
    const outcome = await k05.readTurnState({
      handleId: handle,
      businessId: business,
      bookingIds: [],
      facts: columns.map((column) => ({ key: column, table, rowId, column })),
    });
    if ("error" in outcome) {
      if (outcome.error === "notFound" && outcome.table === table && outcome.rowId === rowId) return null;
      if (outcome.error === "unknownFact") {
        throw new Error(`readTurnState refused a ${table} fact as unknown: the call fails closed`);
      }
      throw new CatalogReadError(read, outcome.error, outcome);
    }
    if (outcome.businessId !== business) throw new CatalogReadError(read, "otherBusiness", null);
    const facts = rowFactsOf(outcome.facts, table, rowId, columns);
    if (facts.values.get("business_id") !== business) throw new CatalogReadError(read, "otherBusiness", null);
    return facts;
  };

  /** Another business than the call's is refused before anything is read. */
  const asking = (read: CatalogReadName, asked: string): void => {
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
      ours(read, answer.businessId, [...answer.kinds, ...(answer.setup === null ? [] : [answer.setup])]);
      return {
        setup: answer.setup === null ? null : setupOf(answer.setup),
        kinds: answer.kinds.map(kindOf),
      };
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

    async locationOf(asked, locationId) {
      asking("readTurnState", asked);
      const facts = await rowById("locations", locationId, LOCATION_FACTS);
      return facts === null ? null : locationRowOf(locationId, business, facts);
    },

    async resourceOf(asked, resourceId) {
      asking("readTurnState", asked);
      const facts = await rowById("resources", resourceId, RESOURCE_FACTS);
      return facts === null ? null : resourceRowOf(resourceId, business, facts);
    },

    async placeOrThingOf(asked, placeOrThingId) {
      asking("readTurnState", asked);
      const facts = await rowById("places_or_things", placeOrThingId, SPACE_FACTS);
      return facts === null ? null : spaceRowOf(placeOrThingId, business, facts);
    },
  };
}

/**
 * The turn a call reads rows by id for (K-05 v1.2 readTurnState, a turn's read): the runtime side's client, whose
 * connections run as rosie_job (item 26, default 25), and the turn's handle.
 */
export interface CatalogTurn {
  readonly runtime: Sql;
  readonly handleId: string;
}

/**
 * T-320's CatalogReads on PostgreSQL for one call: K-05 v1.18's standalone reads on `toolApi` (a client whose
 * connections run as rosie_app, on the primary, uncached), under `businessId`, the call's own business, and readTurnState
 * on `turn`'s runtime client for its handle; with no turn (null), each read of a row by id throws noTurn. Each read takes
 * a connection of its client's own beside the one the call's transaction holds.
 */
export function pgCatalogReads(
  toolApi: Sql,
  businessId: string,
  turn: CatalogTurn | null = null,
): CatalogReads {
  return catalogReadsOf(
    pgCatalogK05Reads(toolApi, turn?.runtime ?? null),
    businessId,
    turn?.handleId ?? null,
  );
}
