// Data-access v1.18: the catalog's five reads (K-05 v1.18 items 72 to 77, defaults 152 to 166; T-1427, T-1428; DL-888,
// DL-911). Their callers are T-320's catalog and pricing service (C-096: actions/src/domain/catalog/reads.ts
// CatalogReads) and limit 2's owner rules (C-082: actions/src/gate/limit-2/facts.ts OwnerRules.rulesOf), each bound by
// T-1429. Each answer is the contract's own shape (default 152), which T-1429 maps across field by field.
//
//   readBusinessKinds      the business's kinds of work (item 72): every K-23 company_kinds row of the business, named
//                          <company id>/<kind id> (item 77), in (company_id, kind_id) order, each with its kind's K-24
//                          kind_flows rows, named <kind id>/<flow>, flow A then B (none for a kind the catalog holds no
//                          flows for: default 155); and the business's K-23 business_setup.no_money with the row's key and
//                          version, or null when the business has no setup row yet (default 161).
//   readBusinessServices   the business's K-25 services, offered or not, in (position, id) order (item 73).
//   readServiceWays        one service's K-25 service_money rows under the business, offered or not, in id order (item 74).
//   readServicePriceRules  one service's K-25 price_rules whose effective_to is null or after `at`, each with its five
//                          conditions together, and every price_rule_ties row of the service, each list in id order (item
//                          75, default 157).
//   readTermsSources       the business's K-23 flow_defaults, flow A then B, named <business id>/<flow>, and its K-26
//                          rules and price_ok_limits whose [effective_from, effective_to) holds `at`, of every flow and
//                          kind of work, each list in id order (item 76, defaults 158 and 159).
//
// Role and scope (README "The calls v1.18 adds", default 154; K-04 v1 rule 4; arch 10 line 546): the Tool API's role,
// rosie_app, under the request's own business; the role is the connection's, so the caller passes the Tool API's client.
// The request names its business, never null. A read in a transaction of its own (readBusinessKinds and the others)
// sets the scope first; a read inside the caller's transaction (the In forms) needs that transaction to run under the
// request's own business. Either way requireBusinessScope() confirms the scope before the first read, and a read in its
// own transaction ends only under the business it began with. The business is found first (businesses by id): one that
// does not exist, or that the scope does not show, answers notFound (table businesses), so an empty list always means
// none in this business (item 72; v1.4 default 56). Besides the scope, every read of a business-scoped table names the
// business (business_id = the request's), so even a role that row-level security does not bind (a table's owner) is
// answered no other business's row; K-24's kind_flows, the shared catalog with no business, is read only for the kinds
// of the business's own company_kinds rows. A service of another business, or one not written yet, answers reads 3 and 4
// with empty lists, never notFound (default 153).
//
// Columns (README items 72 to 76; T-1428's card): each statement names its item's columns and no other, never `*` and
// never a whole row: no service's extras, no rule's words, nothing of business_setup but its key, no_money and version
// (never the listing's phone or email), no rule's or limit's set_by_person_id, no limit's amounts, no flow default's
// arrive, none of kind_flows' main_combo, switches_on, arrive, arrive_window_hours and cutoff, no price rule's
// worker_resource_kind. The integration test records every statement the five reads send and checks each.
//
// Names (item 77, default 163): a row whose primary key is two columns is named by its key's values in the key's order
// joined by '/', built by the SQL from the row's own columns (company_kinds company_id || '/' || kind_id, kind_flows
// kind_id || '/' || flow, flow_defaults business_id || '/' || flow) and never built or split here. No v1.18 request names
// a row by such a name, so no statement here compares one (where T-667's commit compares one, the compare carries the
// business filter: T-1427's database review N3).
//
// Values (README "Values", defaults 156 and 166; T-1427's database review N1 and N2, DL-911): never rounded, never an
// answer the contract refuses. A stored value an answer cannot carry makes the call throw and answer nothing (a request
// this layer cannot carry out: db/repo's default 1), naming the call, the table and the column, never the value:
//   spans     services.length, service_money.cutoff_before, flow_defaults.cutoff_before and rules.value_span, in whole
//             minutes from the column's own extract(epoch from ...) / 60, exact (a night written 1 day is 1440); a span
//             that counts months (its length in minutes is not fixed), that is no whole number of minutes, or that is under
//             one minute throws;
//   times     price_rules.from_time and until_time, and service_money's and flow_defaults' cutoff_day_before_at, as HH:MM,
//             with :SS only when its seconds are not zero; 24:00:00, or a time with a fraction of a second, which the
//             columns hold and clockTime cannot, throws;
//   names     company_kinds' pf_facts, pf_switches_a and pf_switches_b and kind_flows' combos, read through to_json so a
//             NULL element stays null (0019's and 0021's array_to_string CHECKs let one through): a NULL element, or one not
//             of the contract's form (a plug-in name; a money path), throws, as does a kind_flows row with no combo; an
//             empty company_kinds.trade_name throws (tradeName holds at least one character; null is the business's name);
//   money     K-25's bigint cents (price_cents, from_cents, deposit_cents, fee_cents) as JSON integers; one past the
//             largest safe integer throws;
//   days      rules.value_dates as {from, until}, each YYYY-MM-DD (to_char, whatever the session's DateStyle) or null for
//             an open end, [from, until) as PostgreSQL keeps a daterange; an empty range, which K-26 refuses, throws;
//   instants  in UTC ending in Z (targets.ts utc), as every db/repo read answers them.
//
// Reads (arch 02 line 117; arch 10 lines 504, 538; T-1427's database review N2): the primary, uncached, in one
// transaction that begins `isolation level repeatable read read only` (targets.ts inRuntimeTransaction), so every row and
// version an answer holds is one moment's. The In forms run only in a read-only transaction at repeatable read or
// serializable, and refuse any other (withBusiness's readOnly option is plain read only, at read committed). Ids are
// compared byte by byte (collate "C"), never parsed (CQ-09). A serialization failure, a deadlock or a lost connection
// answers transient. Nothing here logs; an error names a call, a field, a table, a column or a rule, never a value or an
// id.
//
// Defaults used (for ops/QUESTIONS.md; each where no source decides):
//   1. The In forms refuse a transaction that is not read only at repeatable read or serializable (README: "in one
//      read-only transaction, so every row and version it answers is one moment's"), before any table is read.
//   2. A span under one minute (zero, or negative) throws, as one that is not whole minutes does: spanMinutes starts at 1,
//      and K-23, K-25 and K-26 hold every such span above zero.
//   3. Each element of a facts, switches or combos list is held to the contract's own form (pluginName, moneyPath), not
//      only for NULL: a list holding one empty string passes company_kinds_names_form (array_to_string gives '') and is
//      no plug-in name, so it throws too.
//   4. A days bound PostgreSQL reads as infinity (a bound written 'infinity', which to_char gives as null) is answered as
//      an open end, as an unbounded side is: limit 2's DayRange reads a null end as open.
//   5. kind_flows is read for the kinds the business's company_kinds rows name, through a subquery under the business's
//      filter, in the same moment as the kinds themselves.
import type * as K05 from "../../contracts/generated/data-access/data-access.v1.18";
import { instantOf, transientOrScrubbed } from "./clocks";
import {
  assertBusinessId,
  BusinessScopeError,
  requireBusinessScope,
  SCOPE_SETTING,
  type Sql,
  type Tx,
} from "./scope";
import {
  assertId,
  assertRequestShape,
  inRuntimeTransaction,
  type NotFoundError,
  readMoment,
  type ReadOptions,
  type TransientError,
  utc,
  utcOrNull,
} from "./targets";

type Db = Sql | Tx;

// ---- the requests and the answers (data-access.v1.18.schema.json) ----------------------------------------------------

export type ReadBusinessKindsRequest = K05.ReadBusinessKindsRequest;
export type ReadBusinessKindsResponse = K05.ReadBusinessKindsResponse;
/** K-05 v1.18 businessKindRead: a company_kinds row, its name (item 77) and its kind's kind_flows rows. */
export type BusinessKindRead = K05.BusinessKindRead;
/** K-05 v1.18 kindFlowRead: a kind_flows row's combos, with its name (item 77) and version. */
export type KindFlowRead = K05.KindFlowRead;
/** K-05 v1.18 businessSetupRead: business_setup's no_money alone, with the row's key and version. */
export type BusinessSetupRead = K05.BusinessSetupRead;
export type ReadBusinessKindsOutcome = ReadBusinessKindsResponse | NotFoundError | TransientError;

export type ReadBusinessServicesRequest = K05.ReadBusinessServicesRequest;
export type ReadBusinessServicesResponse = K05.ReadBusinessServicesResponse;
/** K-05 v1.18 serviceRead: a services row, never its extras. */
export type ServiceRead = K05.ServiceRead;
export type ReadBusinessServicesOutcome = ReadBusinessServicesResponse | NotFoundError | TransientError;

export type ReadServiceWaysRequest = K05.ReadServiceWaysRequest;
export type ReadServiceWaysResponse = K05.ReadServiceWaysResponse;
/** K-05 v1.18 wayRead: every column of a service_money row. */
export type WayRead = K05.WayRead;
export type ReadServiceWaysOutcome = ReadServiceWaysResponse | NotFoundError | TransientError;

export type ReadServicePriceRulesRequest = K05.ReadServicePriceRulesRequest;
export type ReadServicePriceRulesResponse = K05.ReadServicePriceRulesResponse;
/** K-05 v1.18 priceRuleRead: a price_rules row, its five conditions together, never worker_resource_kind. */
export type PriceRuleRead = K05.PriceRuleRead;
export type PriceConditionsRead = K05.PriceConditionsRead;
/** K-05 v1.18 priceTieRead: every column of a price_rule_ties row. */
export type PriceTieRead = K05.PriceTieRead;
export type ReadServicePriceRulesOutcome = ReadServicePriceRulesResponse | NotFoundError | TransientError;

export type ReadTermsSourcesRequest = K05.ReadTermsSourcesRequest;
export type ReadTermsSourcesResponse = K05.ReadTermsSourcesResponse;
/** K-05 v1.18 flowDefaultRead: a flow_defaults row's free-cancel time, with its name (item 77), never arrive. */
export type FlowDefaultRead = K05.FlowDefaultRead;
/** K-05 v1.18 ownerRuleRead: a rules row, never its words or who set it. */
export type OwnerRuleRead = K05.OwnerRuleRead;
/** K-05 v1.18 dayRange: rules.value_dates as [from, until), an open end null. */
export type DayRange = K05.DayRange;
/** K-05 v1.18 priceOkLimitRead: a price_ok_limits row's scope, dates and version, never its amounts. */
export type PriceOkLimitRead = K05.PriceOkLimitRead;
export type ReadTermsSourcesOutcome = ReadTermsSourcesResponse | NotFoundError | TransientError;

/** The five calls, by their K-05 names. */
export type CatalogRead =
  | "readBusinessKinds"
  | "readBusinessServices"
  | "readServiceWays"
  | "readServicePriceRules"
  | "readTermsSources";

type Flow = KindFlowRead["flow"];

/** notFound of the business the request names (README items 72 to 76: catalogBusinessNotFoundError). */
const notFound = (businessId: string): NotFoundError => ({
  error: "notFound",
  table: "businesses",
  rowId: businessId,
});

// ---- the requests' shape -----------------------------------------------------------------------------------------------

/** The request's fields, refused unless it has exactly `fields`; names the field, never a value. */
function fieldsOf(request: unknown, call: CatalogRead, fields: readonly string[]): Record<string, unknown> {
  assertRequestShape(request, call, fields);
  const values = request as Record<string, unknown>;
  for (const field of fields) {
    if (!Object.hasOwn(values, field)) {
      throw new TypeError(`${call}: the request needs ${field}`);
    }
  }
  return values;
}

/** The request's business: named, never null (default 154; refuse-business-kinds-no-business). */
function businessOf(call: CatalogRead, values: Record<string, unknown>): string {
  const { businessId } = values;
  if (businessId === null) {
    throw new TypeError(`${call}: the request names its business, never null`);
  }
  assertId(businessId, "businessId");
  assertBusinessId(businessId);
  return businessId;
}

/** The request's service (refuse-service-ways-no-service). */
function serviceOf(values: Record<string, unknown>): string {
  const { serviceId } = values;
  assertId(serviceId, "serviceId");
  return serviceId;
}

/** The request's time: an instant in UTC ending in Z, on a day that exists (refuse-price-rules-at-with-offset). */
function atOf(call: CatalogRead, values: Record<string, unknown>): string {
  const { at } = values;
  instantOf(call, at, "at");
  return at as string;
}

/** readBusinessKinds' and readBusinessServices' request: the business alone. */
function checkBusinessRequest(request: unknown, call: CatalogRead): { businessId: string } {
  const values = fieldsOf(request, call, ["businessId"]);
  return { businessId: businessOf(call, values) };
}

/** readServiceWays' request: the business and the service. */
function checkWaysRequest(request: unknown): { businessId: string; serviceId: string } {
  const call = "readServiceWays";
  const values = fieldsOf(request, call, ["businessId", "serviceId"]);
  return { businessId: businessOf(call, values), serviceId: serviceOf(values) };
}

/** readServicePriceRules' request: the business, the service and the time. */
function checkPriceRulesRequest(request: unknown): { businessId: string; serviceId: string; at: string } {
  const call = "readServicePriceRules";
  const values = fieldsOf(request, call, ["businessId", "serviceId", "at"]);
  return { businessId: businessOf(call, values), serviceId: serviceOf(values), at: atOf(call, values) };
}

/** readTermsSources' request: the business and the time, and no flow (default 158; refuse-terms-sources-caller-flow). */
function checkTermsRequest(request: unknown): { businessId: string; at: string } {
  const call = "readTermsSources";
  const values = fieldsOf(request, call, ["businessId", "at"]);
  return { businessId: businessOf(call, values), at: atOf(call, values) };
}

// ---- the side a read runs on -------------------------------------------------------------------------------------------

/** The isolation levels whose one snapshot serves the whole transaction: every row one moment's. */
const ONE_MOMENT: ReadonlySet<string> = new Set(["repeatable read", "serializable"]);

/**
 * Refuses a transaction on the wrong side before any table is read: the scope must be the request's own business,
 * confirmed by requireBusinessScope() (BusinessScopeError with none or another), and the transaction read only at
 * repeatable read or serializable, so the answer is one moment's (default 1).
 */
async function enterSide(db: Db, call: CatalogRead, businessId: string): Promise<void> {
  if ((await requireBusinessScope(db)) !== businessId) {
    throw new BusinessScopeError(`${call} runs under the request's own business scope`);
  }
  const [moment] = await db<{ isolation: string; read_only: string }[]>`
    select current_setting('transaction_isolation') as isolation,
           current_setting('transaction_read_only') as read_only
  `;
  if (moment?.read_only !== "on" || !ONE_MOMENT.has(moment.isolation)) {
    throw new Error(
      `${call} runs in one read-only transaction at repeatable read, so every row and version it answers is one moment's`,
    );
  }
}

/** The business found in its scope first, so an empty list never means no such business (v1.4 default 56). */
async function businessFound(db: Db, businessId: string): Promise<boolean> {
  const [business] = await db<{ id: string }[]>`select id from businesses where id = ${businessId}`;
  return business !== undefined;
}

/**
 * One read-only transaction at repeatable read on `sql`, the primary (targets.ts inRuntimeTransaction: it begins
 * `isolation level repeatable read read only` and clears any scope the connection kept), under the business's scope,
 * set first and still the same when the read ends. A serialization failure, a deadlock or a lost connection answers
 * transient; every other failure is thrown, scrubbed of any value (clocks.ts transientOrScrubbed).
 */
async function inOwnTransaction<T>(
  sql: Sql,
  call: CatalogRead,
  businessId: string,
  read: (tx: Sql) => Promise<T>,
): Promise<T | TransientError> {
  try {
    return await inRuntimeTransaction(sql, { readOnly: true }, async (tx) => {
      await tx`select set_config(${SCOPE_SETTING}, ${businessId}, true)`;
      const outcome = await read(tx);
      if ((await requireBusinessScope(tx)) !== businessId) {
        throw new BusinessScopeError(`${call} must end under the business scope it began with`);
      }
      return outcome;
    });
  } catch (error) {
    return transientOrScrubbed(call, error);
  }
}

// ---- values (README "Values"; defaults 156 and 166; T-1427's database review N1 and N2) --------------------------------

/**
 * A stored value the answer cannot carry: the call throws and answers nothing, never a rounded or guessed value. The
 * error names the call, the table, the column and the fault, never the value or the row.
 */
function cannotCarry(call: CatalogRead, table: string, column: string, fault: string): never {
  throw new Error(`${call}: ${table}.${column} holds ${fault}, which the answer cannot carry`);
}

/** An interval's extract(epoch from ...) as text: whole seconds, with any fraction (numeric's own text). */
const SECONDS = /^(-?)([0-9]+)(?:\.([0-9]*))?$/;

/**
 * A span in whole minutes (spanMinutes, default 156) from the column's `seconds` (extract(epoch from column)::text) and
 * `months` (whether it counts months or years): null where the column is null; else a fixed whole number of minutes from
 * 1, or the call throws (default 2).
 */
function spanMinutesOf(
  call: CatalogRead,
  table: string,
  column: string,
  seconds: string | null,
  months: boolean | null,
): number | null {
  if (seconds === null) {
    return null;
  }
  if (months !== false) {
    cannotCarry(call, table, column, "a span that counts months, whose length in minutes is not fixed");
  }
  const match = SECONDS.exec(seconds);
  const whole = Number(match?.[2]);
  if (match === null || /[1-9]/.test(match[3] ?? "") || !Number.isSafeInteger(whole) || whole % 60 !== 0) {
    cannotCarry(call, table, column, "a span that is not a whole number of minutes");
  }
  if (match[1] === "-" || whole < 60) {
    cannotCarry(call, table, column, "a span under one minute");
  }
  return whole / 60;
}

/** A time column's text as PostgreSQL writes it: HH:MM:SS, from 00:00:00 to 23:59:59, with no fraction. */
const CLOCK = /^([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/;

/**
 * A clock time (clockTime, default 166) as HH:MM, with :SS only when its seconds are not zero; null where the column is
 * null. 24:00:00 and a time with a fraction of a second throw: never rounded (T-1427's database review N1).
 */
function clockTimeOf(call: CatalogRead, table: string, column: string, raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  if (!CLOCK.test(raw)) {
    cannotCarry(call, table, column, "a time that is the day's end or has a fraction of a second");
  }
  return raw.endsWith(":00") ? raw.slice(0, 5) : raw;
}

const WHOLE_NUMBER = /^-?[0-9]+$/;

/** A bigint amount in cents as a JSON integer (T-1427's database review N2); null where the column is null. */
function centsOf(
  call: CatalogRead,
  table: string,
  column: string,
  raw: string | number | bigint | null,
): number | null {
  if (raw === null) {
    return null;
  }
  const text = String(raw);
  const value = Number(text);
  if (!WHOLE_NUMBER.test(text) || !Number.isSafeInteger(value)) {
    cannotCarry(call, table, column, "an amount past the largest whole number an answer carries");
  }
  return value;
}

/** pluginName: a plug-in fact or switch name (K-23 company_kinds_names_form, element by element). */
const PLUGIN_NAME = /^[a-z0-9]+$/;
/** moneyPath: price|before|after (K-24 kind_flows_combos_form, element by element). */
const MONEY_PATH = /^(list|photos|visit)[|](none|card|deposit|full)[|](none|counter|bill|card|own)$/;

/**
 * An array column read through to_json, element by element: each a string of the contract's form. A NULL element (null
 * here), a nested list or any other element throws (T-1427's database review N1; default 3).
 */
function listOf(
  call: CatalogRead,
  table: string,
  column: string,
  raw: unknown,
  form: RegExp,
  what: string,
): string[] {
  if (!Array.isArray(raw)) {
    cannotCarry(call, table, column, "no list");
  }
  const elements: unknown[] = raw;
  return elements.map((element) => {
    if (element === null) {
      cannotCarry(call, table, column, "a NULL element");
    }
    if (typeof element !== "string" || !form.test(element)) {
      cannotCarry(call, table, column, `an element that is not ${what}`);
    }
    return element;
  });
}

/** At most two rows (a kind's flows, a business's flow defaults: one per flow), as the contract's list types them. */
function upToTwo<T>(call: CatalogRead, table: string, rows: readonly T[]): [] | [T] | [T, T] {
  const [first, second, ...more] = rows;
  if (more.length > 0) {
    throw new Error(`${call}: more than two ${table} rows for one key, one per flow`);
  }
  if (first === undefined) {
    return [];
  }
  return second === undefined ? [first] : [first, second];
}

/** A day bound as to_char writes it, YYYY-MM-DD (dayRange). */
const DAY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/**
 * rules.value_dates as {from, until} (dayRange), or null where the column is null (isempty answers null): each bound
 * YYYY-MM-DD or null for an open end (default 4); an empty range, or a bound in another form, throws.
 */
function dayRangeOf(
  call: CatalogRead,
  empty: boolean | null,
  from: string | null,
  until: string | null,
): DayRange | null {
  if (empty === null) {
    return null;
  }
  if (empty) {
    cannotCarry(call, "rules", "value_dates", "an empty range");
  }
  for (const day of [from, until]) {
    if (day !== null && !DAY.test(day)) {
      cannotCarry(call, "rules", "value_dates", "a day bound not written YYYY-MM-DD");
    }
  }
  return { from, until };
}

// ---- readBusinessKinds (item 72) ---------------------------------------------------------------------------------------

interface SetupRow {
  business_id: string;
  no_money: boolean;
  version: number;
}

interface KindRow {
  row_id: string;
  company_id: string;
  kind_id: string;
  business_id: string;
  trade_name: string | null;
  pf_facts: unknown;
  pf_switches_a: unknown;
  pf_switches_b: unknown;
  version: number;
}

interface KindFlowRow {
  row_id: string;
  kind_id: string;
  flow: Flow;
  combos: unknown;
  version: number;
}

async function kindsOf(
  db: Db,
  businessId: string,
  options: ReadOptions,
): Promise<ReadBusinessKindsResponse | NotFoundError> {
  const call = "readBusinessKinds";
  if (!(await businessFound(db, businessId))) {
    return notFound(businessId);
  }
  const readAt = await readMoment(db, options);
  const [setup] = await db<SetupRow[]>`
    select business_id, no_money, version from business_setup where business_id = ${businessId}
  `;
  const kinds = await db<KindRow[]>`
    select company_id || '/' || kind_id as row_id, company_id, kind_id, business_id, trade_name,
           to_json(pf_facts) as pf_facts, to_json(pf_switches_a) as pf_switches_a,
           to_json(pf_switches_b) as pf_switches_b, version
    from company_kinds
    where business_id = ${businessId}
    order by company_id collate "C", kind_id collate "C"
  `;
  const flows = await db<KindFlowRow[]>`
    select kind_id || '/' || flow as row_id, kind_id, flow, to_json(combos) as combos, version
    from kind_flows
    where kind_id in (select kind_id from company_kinds where business_id = ${businessId})
    order by kind_id collate "C", flow collate "C"
  `;
  const flowsOfKind = new Map<string, KindFlowRead[]>();
  for (const row of flows) {
    const [first, ...rest] = listOf(call, "kind_flows", "combos", row.combos, MONEY_PATH, "a money path");
    if (first === undefined) {
      cannotCarry(call, "kind_flows", "combos", "no money path");
    }
    const ofKind = flowsOfKind.get(row.kind_id) ?? [];
    ofKind.push({ rowId: row.row_id, flow: row.flow, combos: [first, ...rest], version: row.version });
    flowsOfKind.set(row.kind_id, ofKind);
  }
  const names = (row: KindRow, column: "pf_facts" | "pf_switches_a" | "pf_switches_b"): string[] =>
    listOf(call, "company_kinds", column, row[column], PLUGIN_NAME, "a plug-in name");
  return {
    result: "businessKinds",
    businessId,
    readAt: utc(readAt),
    setup:
      setup === undefined
        ? null
        : { businessId: setup.business_id, noMoney: setup.no_money, version: setup.version },
    kinds: kinds.map((row) => {
      if (row.trade_name === "") {
        cannotCarry(call, "company_kinds", "trade_name", "an empty name");
      }
      return {
        rowId: row.row_id,
        companyId: row.company_id,
        kindId: row.kind_id,
        businessId: row.business_id,
        tradeName: row.trade_name,
        facts: names(row, "pf_facts"),
        switchesA: names(row, "pf_switches_a"),
        switchesB: names(row, "pf_switches_b"),
        version: row.version,
        flows: upToTwo(call, "kind_flows", flowsOfKind.get(row.kind_id) ?? []),
      };
    }),
  };
}

/**
 * The business's kinds of work (K-05 v1.18 item 72) inside the transaction `db`, which must run under the request's
 * business scope (as rosie_app, the Tool API's call transaction) and be read only at repeatable read: refused before
 * any table is read otherwise (BusinessScopeError for the scope). notFound (table businesses) when the business does not
 * exist or the scope does not show it. A request of the wrong shape throws a TypeError; a stored value the answer
 * cannot carry throws.
 */
export async function readBusinessKindsIn(
  db: Db,
  request: ReadBusinessKindsRequest,
  options: ReadOptions = {},
): Promise<ReadBusinessKindsResponse | NotFoundError> {
  const { businessId } = checkBusinessRequest(request, "readBusinessKinds");
  await enterSide(db, "readBusinessKinds", businessId);
  return kindsOf(db, businessId, options);
}

/**
 * The business's kinds of work (K-05 v1.18 item 72) in a read-only transaction at repeatable read of its own, on the
 * primary, under the request's business scope. Pass the Tool API's client (rosie_app). notFound when the business does
 * not exist or its scope does not show it; transient on a serialization failure, a deadlock or a lost connection. A
 * request of the wrong shape throws a TypeError before any statement; a stored value the answer cannot carry throws.
 */
export async function readBusinessKinds(
  sql: Sql,
  request: ReadBusinessKindsRequest,
  options: ReadOptions = {},
): Promise<ReadBusinessKindsOutcome> {
  const { businessId } = checkBusinessRequest(request, "readBusinessKinds");
  return inOwnTransaction(sql, "readBusinessKinds", businessId, (tx) =>
    readBusinessKindsIn(tx, request, options),
  );
}

// ---- readBusinessServices (item 73) ------------------------------------------------------------------------------------

interface ServiceRow {
  id: string;
  business_id: string;
  kind_id: string;
  name: string;
  price_kind: ServiceRead["priceKind"];
  unit: string | null;
  length_seconds: string | null;
  length_months: boolean | null;
  position: number;
  active: boolean;
  version: number;
}

async function servicesOf(
  db: Db,
  businessId: string,
  options: ReadOptions,
): Promise<ReadBusinessServicesResponse | NotFoundError> {
  const call = "readBusinessServices";
  if (!(await businessFound(db, businessId))) {
    return notFound(businessId);
  }
  const readAt = await readMoment(db, options);
  const services = await db<ServiceRow[]>`
    select id, business_id, kind_id, name, price_kind, unit,
           extract(epoch from length)::text as length_seconds,
           (extract(year from length) <> 0 or extract(month from length) <> 0) as length_months,
           position, active, version
    from services
    where business_id = ${businessId}
    order by position, id collate "C"
  `;
  return {
    result: "businessServices",
    businessId,
    readAt: utc(readAt),
    services: services.map((row) => {
      const lengthMinutes = spanMinutesOf(call, "services", "length", row.length_seconds, row.length_months);
      if (lengthMinutes === null) {
        cannotCarry(call, "services", "length", "no length");
      }
      return {
        id: row.id,
        businessId: row.business_id,
        kindId: row.kind_id,
        name: row.name,
        priceKind: row.price_kind,
        unit: row.unit,
        lengthMinutes,
        position: row.position,
        active: row.active,
        version: row.version,
      };
    }),
  };
}

/**
 * The business's services (K-05 v1.18 item 73) inside the transaction `db`, on the request's side as
 * readBusinessKindsIn's.
 */
export async function readBusinessServicesIn(
  db: Db,
  request: ReadBusinessServicesRequest,
  options: ReadOptions = {},
): Promise<ReadBusinessServicesResponse | NotFoundError> {
  const { businessId } = checkBusinessRequest(request, "readBusinessServices");
  await enterSide(db, "readBusinessServices", businessId);
  return servicesOf(db, businessId, options);
}

/** The business's services (K-05 v1.18 item 73) in a transaction of its own; clients and answers as readBusinessKinds'. */
export async function readBusinessServices(
  sql: Sql,
  request: ReadBusinessServicesRequest,
  options: ReadOptions = {},
): Promise<ReadBusinessServicesOutcome> {
  const { businessId } = checkBusinessRequest(request, "readBusinessServices");
  return inOwnTransaction(sql, "readBusinessServices", businessId, (tx) =>
    readBusinessServicesIn(tx, request, options),
  );
}

// ---- readServiceWays (item 74) -----------------------------------------------------------------------------------------

interface WayRow {
  id: string;
  service_id: string;
  business_id: string;
  flow: Flow;
  place: WayRead["place"];
  location_id: string | null;
  path: string;
  deposit_cents: string | null;
  deposit_percent: number | null;
  fee_cents: string | null;
  currency: string | null;
  cutoff_before_seconds: string | null;
  cutoff_before_months: boolean | null;
  cutoff_day_before_at: string | null;
  tip_line: boolean | null;
  active: boolean;
  version: number;
}

async function waysOf(
  db: Db,
  businessId: string,
  serviceId: string,
  options: ReadOptions,
): Promise<ReadServiceWaysResponse | NotFoundError> {
  const call = "readServiceWays";
  if (!(await businessFound(db, businessId))) {
    return notFound(businessId);
  }
  const readAt = await readMoment(db, options);
  const ways = await db<WayRow[]>`
    select id, service_id, business_id, flow, place, location_id, path, deposit_cents, deposit_percent, fee_cents,
           currency, extract(epoch from cutoff_before)::text as cutoff_before_seconds,
           (extract(year from cutoff_before) <> 0 or extract(month from cutoff_before) <> 0) as cutoff_before_months,
           cutoff_day_before_at, tip_line, active, version
    from service_money
    where business_id = ${businessId} and service_id = ${serviceId}
    order by id collate "C"
  `;
  return {
    result: "serviceWays",
    businessId,
    serviceId,
    readAt: utc(readAt),
    ways: ways.map((row) => ({
      id: row.id,
      serviceId: row.service_id,
      businessId: row.business_id,
      flow: row.flow,
      place: row.place,
      locationId: row.location_id,
      path: row.path,
      depositCents: centsOf(call, "service_money", "deposit_cents", row.deposit_cents),
      depositPercent: row.deposit_percent,
      feeCents: centsOf(call, "service_money", "fee_cents", row.fee_cents),
      currency: row.currency,
      cutoffBeforeMinutes: spanMinutesOf(
        call,
        "service_money",
        "cutoff_before",
        row.cutoff_before_seconds,
        row.cutoff_before_months,
      ),
      cutoffDayBeforeAt: clockTimeOf(call, "service_money", "cutoff_day_before_at", row.cutoff_day_before_at),
      tipLine: row.tip_line,
      active: row.active,
      version: row.version,
    })),
  };
}

/**
 * One service's ways (K-05 v1.18 item 74) inside the transaction `db`, on the request's side as readBusinessKindsIn's. A
 * service the scope does not show (another business's, or one not written yet) answers an empty list, never notFound
 * (default 153).
 */
export async function readServiceWaysIn(
  db: Db,
  request: ReadServiceWaysRequest,
  options: ReadOptions = {},
): Promise<ReadServiceWaysResponse | NotFoundError> {
  const { businessId, serviceId } = checkWaysRequest(request);
  await enterSide(db, "readServiceWays", businessId);
  return waysOf(db, businessId, serviceId, options);
}

/** One service's ways (K-05 v1.18 item 74) in a transaction of its own; clients and answers as readBusinessKinds'. */
export async function readServiceWays(
  sql: Sql,
  request: ReadServiceWaysRequest,
  options: ReadOptions = {},
): Promise<ReadServiceWaysOutcome> {
  const { businessId } = checkWaysRequest(request);
  return inOwnTransaction(sql, "readServiceWays", businessId, (tx) =>
    readServiceWaysIn(tx, request, options),
  );
}

// ---- readServicePriceRules (item 75) -----------------------------------------------------------------------------------

interface PriceRuleRow {
  id: string;
  business_id: string;
  service_id: string;
  service_money_id: string | null;
  worker_resource_id: string | null;
  weekdays: string | null;
  from_time: string | null;
  until_time: string | null;
  price_cents: string;
  from_cents: string | null;
  currency: string;
  set_by_person_id: string;
  effective_from: Date;
  effective_to: Date | null;
  version: number;
}

interface PriceTieRow {
  id: string;
  business_id: string;
  service_id: string;
  first_rule_id: string;
  second_rule_id: string;
  asked_at: Date;
  winner_rule_id: string | null;
  answered_at: Date | null;
  answered_by_person_id: string | null;
  version: number;
}

async function priceRulesOf(
  db: Db,
  businessId: string,
  serviceId: string,
  at: string,
  options: ReadOptions,
): Promise<ReadServicePriceRulesResponse | NotFoundError> {
  const call = "readServicePriceRules";
  if (!(await businessFound(db, businessId))) {
    return notFound(businessId);
  }
  const readAt = await readMoment(db, options);
  const rules = await db<PriceRuleRow[]>`
    select id, business_id, service_id, service_money_id, worker_resource_id, weekdays, from_time, until_time,
           price_cents, from_cents, currency, set_by_person_id, effective_from, effective_to, version
    from price_rules
    where business_id = ${businessId} and service_id = ${serviceId}
      and (effective_to is null or effective_to > ${at}::timestamptz)
    order by id collate "C"
  `;
  const ties = await db<PriceTieRow[]>`
    select id, business_id, service_id, first_rule_id, second_rule_id, asked_at, winner_rule_id, answered_at,
           answered_by_person_id, version
    from price_rule_ties
    where business_id = ${businessId} and service_id = ${serviceId}
    order by id collate "C"
  `;
  return {
    result: "servicePriceRules",
    businessId,
    serviceId,
    at,
    readAt: utc(readAt),
    rules: rules.map((row) => {
      const priceCents = centsOf(call, "price_rules", "price_cents", row.price_cents);
      if (priceCents === null) {
        cannotCarry(call, "price_rules", "price_cents", "no price");
      }
      return {
        id: row.id,
        businessId: row.business_id,
        serviceId: row.service_id,
        conditions: {
          serviceMoneyId: row.service_money_id,
          workerResourceId: row.worker_resource_id,
          weekdays: row.weekdays,
          fromTime: clockTimeOf(call, "price_rules", "from_time", row.from_time),
          untilTime: clockTimeOf(call, "price_rules", "until_time", row.until_time),
        },
        priceCents,
        fromCents: centsOf(call, "price_rules", "from_cents", row.from_cents),
        currency: row.currency,
        setByPersonId: row.set_by_person_id,
        effectiveFrom: utc(row.effective_from),
        effectiveTo: utcOrNull(row.effective_to),
        version: row.version,
      };
    }),
    ties: ties.map((row) => ({
      id: row.id,
      businessId: row.business_id,
      serviceId: row.service_id,
      firstRuleId: row.first_rule_id,
      secondRuleId: row.second_rule_id,
      askedAt: utc(row.asked_at),
      winnerRuleId: row.winner_rule_id,
      answeredAt: utcOrNull(row.answered_at),
      answeredByPersonId: row.answered_by_person_id,
      version: row.version,
    })),
  };
}

/**
 * One service's price rules in effect at or after `at`, and its ties (K-05 v1.18 item 75), inside the transaction `db`,
 * on the request's side as readBusinessKindsIn's. A rule whose effective_to is null or after `at` is answered (a price
 * withdrawn before it started, effective_to equal to effective_from, while that instant is after `at`); every tie of the
 * service, answered or not (default 157). A service the scope does not show answers both lists empty (default 153).
 */
export async function readServicePriceRulesIn(
  db: Db,
  request: ReadServicePriceRulesRequest,
  options: ReadOptions = {},
): Promise<ReadServicePriceRulesResponse | NotFoundError> {
  const { businessId, serviceId, at } = checkPriceRulesRequest(request);
  await enterSide(db, "readServicePriceRules", businessId);
  return priceRulesOf(db, businessId, serviceId, at, options);
}

/**
 * One service's price rules in effect at or after `at`, and its ties (K-05 v1.18 item 75), in a transaction of its own;
 * clients and answers as readBusinessKinds'.
 */
export async function readServicePriceRules(
  sql: Sql,
  request: ReadServicePriceRulesRequest,
  options: ReadOptions = {},
): Promise<ReadServicePriceRulesOutcome> {
  const { businessId } = checkPriceRulesRequest(request);
  return inOwnTransaction(sql, "readServicePriceRules", businessId, (tx) =>
    readServicePriceRulesIn(tx, request, options),
  );
}

// ---- readTermsSources (item 76) ----------------------------------------------------------------------------------------

interface FlowDefaultRow {
  row_id: string;
  business_id: string;
  flow: Flow;
  cutoff_before_seconds: string | null;
  cutoff_before_months: boolean | null;
  cutoff_day_before_at: string | null;
  version: number;
}

interface OwnerRuleRow {
  id: string;
  business_id: string;
  rule_kind: string;
  value_type: OwnerRuleRead["valueType"];
  flow: Flow | null;
  kind_id: string | null;
  value_on: boolean | null;
  value_cents: number | null;
  value_currency: string | null;
  value_span_seconds: string | null;
  value_span_months: boolean | null;
  value_count: number | null;
  value_dates_empty: boolean | null;
  value_dates_from: string | null;
  value_dates_until: string | null;
  effective_from: Date;
  effective_to: Date | null;
  version: number;
}

interface PriceOkLimitRow {
  id: string;
  business_id: string;
  flow: Flow | null;
  kind_id: string | null;
  effective_from: Date;
  effective_to: Date | null;
  version: number;
}

async function termsSourcesOf(
  db: Db,
  businessId: string,
  at: string,
  options: ReadOptions,
): Promise<ReadTermsSourcesResponse | NotFoundError> {
  const call = "readTermsSources";
  if (!(await businessFound(db, businessId))) {
    return notFound(businessId);
  }
  const readAt = await readMoment(db, options);
  const defaults = await db<FlowDefaultRow[]>`
    select business_id || '/' || flow as row_id, business_id, flow,
           extract(epoch from cutoff_before)::text as cutoff_before_seconds,
           (extract(year from cutoff_before) <> 0 or extract(month from cutoff_before) <> 0) as cutoff_before_months,
           cutoff_day_before_at, version
    from flow_defaults
    where business_id = ${businessId}
    order by flow collate "C"
  `;
  const rules = await db<OwnerRuleRow[]>`
    select id, business_id, rule_kind, value_type, flow, kind_id, value_on, value_cents, value_currency,
           extract(epoch from value_span)::text as value_span_seconds,
           (extract(year from value_span) <> 0 or extract(month from value_span) <> 0) as value_span_months,
           value_count, isempty(value_dates) as value_dates_empty,
           to_char(lower(value_dates)::timestamp, 'YYYY-MM-DD') as value_dates_from,
           to_char(upper(value_dates)::timestamp, 'YYYY-MM-DD') as value_dates_until,
           effective_from, effective_to, version
    from rules
    where business_id = ${businessId} and tstzrange(effective_from, effective_to, '[)') @> ${at}::timestamptz
    order by id collate "C"
  `;
  const limits = await db<PriceOkLimitRow[]>`
    select id, business_id, flow, kind_id, effective_from, effective_to, version
    from price_ok_limits
    where business_id = ${businessId} and tstzrange(effective_from, effective_to, '[)') @> ${at}::timestamptz
    order by id collate "C"
  `;
  return {
    result: "termsSources",
    businessId,
    at,
    readAt: utc(readAt),
    flowDefaults: upToTwo(
      call,
      "flow_defaults",
      defaults.map((row) => ({
        rowId: row.row_id,
        businessId: row.business_id,
        flow: row.flow,
        cutoffBeforeMinutes: spanMinutesOf(
          call,
          "flow_defaults",
          "cutoff_before",
          row.cutoff_before_seconds,
          row.cutoff_before_months,
        ),
        cutoffDayBeforeAt: clockTimeOf(
          call,
          "flow_defaults",
          "cutoff_day_before_at",
          row.cutoff_day_before_at,
        ),
        version: row.version,
      })),
    ),
    rules: rules.map((row) => ({
      id: row.id,
      businessId: row.business_id,
      ruleKind: row.rule_kind,
      valueType: row.value_type,
      flow: row.flow,
      kindId: row.kind_id,
      valueOn: row.value_on,
      valueCents: row.value_cents,
      valueCurrency: row.value_currency,
      valueSpanMinutes: spanMinutesOf(
        call,
        "rules",
        "value_span",
        row.value_span_seconds,
        row.value_span_months,
      ),
      valueCount: row.value_count,
      valueDates: dayRangeOf(call, row.value_dates_empty, row.value_dates_from, row.value_dates_until),
      effectiveFrom: utc(row.effective_from),
      effectiveTo: utcOrNull(row.effective_to),
      version: row.version,
    })),
    priceOkLimits: limits.map((row) => ({
      id: row.id,
      businessId: row.business_id,
      flow: row.flow,
      kindId: row.kind_id,
      effectiveFrom: utc(row.effective_from),
      effectiveTo: utcOrNull(row.effective_to),
      version: row.version,
    })),
  };
}

/**
 * A terms snapshot's sources and the owner rules at `at` (K-05 v1.18 item 76) inside the transaction `db`, on the
 * request's side as readBusinessKindsIn's: both flows' defaults, and the rules and price OK limits in force at `at`, of
 * every flow and kind of work (defaults 158 and 159).
 */
export async function readTermsSourcesIn(
  db: Db,
  request: ReadTermsSourcesRequest,
  options: ReadOptions = {},
): Promise<ReadTermsSourcesResponse | NotFoundError> {
  const { businessId, at } = checkTermsRequest(request);
  await enterSide(db, "readTermsSources", businessId);
  return termsSourcesOf(db, businessId, at, options);
}

/**
 * A terms snapshot's sources and the owner rules at `at` (K-05 v1.18 item 76) in a transaction of its own; clients and
 * answers as readBusinessKinds'.
 */
export async function readTermsSources(
  sql: Sql,
  request: ReadTermsSourcesRequest,
  options: ReadOptions = {},
): Promise<ReadTermsSourcesOutcome> {
  const { businessId } = checkTermsRequest(request);
  return inOwnTransaction(sql, "readTermsSources", businessId, (tx) =>
    readTermsSourcesIn(tx, request, options),
  );
}
