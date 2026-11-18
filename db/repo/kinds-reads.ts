// Data-access v1.19: the kind matcher's catalog and the owner's kinds so far (K-05 v1.19 items 78 and 79, defaults 167
// to 182; T-1455, T-1458; DL-949, DL-958, DL-960). Their callers are journey 1's first calls (C-074): T-633's matchKinds
// over T-632's matcher (C-130) with S1-02, S1-03 and S1-74, and T-634's S1-11, S1-04 and S1-08, each bound by its own
// card. Each answer is the contract's own shape.
//
//   readKindCatalog   the matcher's catalog (item 78): every K-24 kinds row whose source is trade_file, with its id,
//                     name, style, pattern, source and version, in id order; never facts, no column of kind_flows, and
//                     never a drafted kind (source new_work), whatever its draft's state. An empty list is answered as
//                     it stands: the catalog seed has not run (default 170).
//   readPickedKinds   the owner's kinds so far (item 79): every K-24 picked_kinds row of the request's business and every
//                     one of the request's person with no business, each with its picked_kind_texts by key and version
//                     (never the block), its new_work_drafts row and that draft's new_work_draft_blocks (never the
//                     answer); and every K-23 companies row of the business and of the person with no business.
//
// Item 78's role and scope (README item 78, default 167): the catalog is shared reference data with no business
// column. Migration 0021 leaves row-level security off on kinds and gives both rosie_app and rosie_job its SELECT, so
// the read runs as the Tool API's client, rosie_app, in the call's own transaction under whatever scope that holds
// (readKindCatalogIn), or in a read-only transaction of its own (readKindCatalog), and answers the same rows under any
// business and under none. The request names nothing.
//
// Item 79's role, scope and order (README item 79, defaults 171 to 174 and 180; T-1455 round 3; this card's lead note,
// DL-960): rosie_job, the one role that reads persons (0012) and sees a row with no business (0019, 0021), in one
// read-only transaction at repeatable read (targets.ts inRuntimeTransaction: it begins `isolation level repeatable read
// read only` and clears any scope the connection kept), so every statement reads one snapshot whatever scope it runs
// under. withBusiness() cannot host it: its end check refuses a scope that was emptied (scope.ts). In this order, each
// step only after the one before it passed:
//   1. the side, before any table is read: a role that holds rosie_app's rights and not rosie_job's is refused
//      (BusinessScopeError), as enterKeywordDoorSide and readOpenHolds refuse one, since row-level security binds
//      rosie_job and rosie_app sees no row with no business; a role that holds neither (the tables' owner, which
//      row-level security does not bind) runs until T-1093. Then the scope is confirmed empty (assertRuntimeSide);
//   2. persons by the request's person (it spans businesses and has no row-level security: 0012): notFound, table
//      persons;
//   3. with a business: the scope set to it (assertBusinessId, then set_config on the transaction's own connection, as
//      setup/turn-state.ts sets it: setBusinessScope takes a TransactionSql, and inRuntimeTransaction hands a plain Sql)
//      and confirmed by requireBusinessScope(), compared with the request's business, before businesses by it
//      (notFound, table businesses) and the business's picks, texts, drafts, blocks and companies, each statement
//      carrying business_id = <the business>; then the scope read again and compared with the request's business,
//      never only that one exists (T-1455's security note a), so the business's part ends under the scope it set;
//   4. the scope cleared (set_config to '', as commitTurn's Scope.to does for the runtime side) and confirmed empty
//      (assertRuntimeSide) before the person's rows with no business, each statement carrying business_id is null and
//      owner_person_id = <the person>. With businessId null step 3 is skipped, and step 1 has confirmed the scope empty.
// Each child is joined to its pick under the pick's rule in the same statement (default 180): a text or a draft to its
// pick, a block to its draft and that draft's pick, with the same business_id condition on every row joined, never a
// child's business_id is null alone (the three tables hold no owner_person_id, and their composite foreign keys are MATCH
// SIMPLE: 0021). So a business's pick whose text, draft or block still has no business is answered without that row,
// which is answered nowhere: the business's scope and statements leave it out, and the person's take only picks with
// no business.
//
// Columns (README items 78 and 79, and :1238): each statement names its item's columns and no other, never `*` and
// never a whole row: never kinds.facts, picked_kind_texts.block or new_work_draft_blocks.answer, no column of kind_flows
// or company_kinds, and no handles or phones row. Item 77's names (picked_kind_texts as <pick id>/<pf key>,
// new_work_draft_blocks as <draft id>/<block>) are built by the SQL from the row's own key columns (setup/row-names.ts
// rowNameSql), never built or split here. The integration test records every statement the two reads send and checks
// each.
//
// Orders (defaults 169 and 179): the catalog by id; picks by (picked_at, position, id); a pick's texts by pf_key; a
// draft's blocks by block; companies by id; ids and keys compared byte by byte (collate "C"). The business's picks and
// the person's are merged into one list as the database orders them: picked_at to the microsecond (an integer the SQL
// selects, since postgres.js's Date and targets.ts utc keep milliseconds only), then position, then the id's UTF-8
// bytes, collate "C"'s order on a UTF8 database; the companies by their ids' bytes the same way.
//
// Values (README :1238; T-1427's database review N1, default 156's rule): never an answer the contract refuses. A stored
// value the answer cannot carry makes the call throw and answer nothing, naming the call, the table and the column, never
// the value or the row: an empty kinds.style or companies.name (the tables hold them only not null, 0021 and 0019, and the
// contract asks at least one character), and a NULL element, or one that is no plug-in name, in new_work_draft_blocks'
// facts_on or switches_on (read through to_json: 0021's CHECK reads them through array_to_string, which lets a NULL
// element through). A value of spaces alone is carried as stored (T-1455's default 1). Instants are answered in UTC
// ending in Z (targets.ts utc), as every db/repo read answers them, readTurnState's picked_at, drafted_at and answered_at
// among them.
//
// Reads (arch 02 line 117; arch 10 lines 504, 538): the primary, uncached, in one read-only transaction; nothing is
// written. A serialization failure, a deadlock or a lost connection answers transient; every other failure is thrown,
// scrubbed of any value (clocks.ts transientOrScrubbed). Nothing here logs; an error names a call, a field, a table, a
// column or a rule, never a value or an id. A request of the wrong shape throws a TypeError before any statement.
//
// Defaults used (for ops/QUESTIONS.md; each where no source decides):
//   1. readKindCatalogIn refuses a transaction that is not read only at repeatable read or serializable, before any
//      table is read (this card's lead note 5; catalog-reads.ts default 1); it takes any business scope or none.
//   2. Item 79's side is checked first, the role and then the empty scope, with a business too: inRuntimeTransaction has
//      cleared the scope, and persons, which spans businesses, is read on the runtime side either way.
//   3. With a business the scope is compared with the request's business twice: as soon as it is set (before
//      businesses) and when the business's part ends (before it is cleared), also when the business is not found.
//   4. The merge key is picked_at's epoch in whole microseconds, `(extract(epoch from picked_at) * 1000000)::bigint`,
//      PostgreSQL's own resolution, compared as a bigint; ids as UTF-8 bytes (TextEncoder), which collate "C" compares.
//   5. facts_on and switches_on are held element by element to the plug-in name form (catalog-reads.ts default 3).
//   6. readAt is the database's now() (or the test's clock), read once the person's part is read: one snapshot.
import type postgres from "postgres";
import type * as K05 from "../../contracts/generated/data-access/data-access.v1.19";
import { transientOrScrubbed } from "./clocks";
import {
  assertBusinessId,
  BusinessScopeError,
  requireBusinessScope,
  SCOPE_SETTING,
  type Sql,
  type Tx,
} from "./scope";
import { rowNameSql, twoColumnKeyOf } from "./setup/row-names";
import {
  assertId,
  assertRequestShape,
  assertRuntimeSide,
  inRuntimeTransaction,
  type NotFoundError,
  readMoment,
  type ReadOptions,
  type TransientError,
  utc,
} from "./targets";

type Db = Sql | Tx;
/** A piece of a statement (postgres.js builds it into the statement that holds it, and never sends it alone). */
type Fragment = postgres.PendingQuery<postgres.Row[]>;

// ---- the requests and the answers (data-access.v1.19.schema.json) ----------------------------------------------------

export type ReadKindCatalogRequest = K05.ReadKindCatalogRequest;
export type ReadKindCatalogResponse = K05.ReadKindCatalogResponse;
/** K-05 v1.19 kindCatalogRow: a trade-file kinds row's id, name, style, pattern, source and version. */
export type KindCatalogRow = K05.KindCatalogRow;
export type ReadKindCatalogOutcome = ReadKindCatalogResponse | TransientError;

export type ReadPickedKindsRequest = K05.ReadPickedKindsRequest;
export type ReadPickedKindsResponse = K05.ReadPickedKindsResponse;
/** K-05 v1.19 pickedKindRead: a picked_kinds row with its texts' keys and its draft. */
export type PickedKindRead = K05.PickedKindRead;
/** K-05 v1.19 pickTextRead: a picked_kind_texts row's name, key, business and version, never its block. */
export type PickTextRead = K05.PickTextRead;
/** K-05 v1.19 newWorkDraftRead: a new_work_drafts row with its blocks. */
export type NewWorkDraftRead = K05.NewWorkDraftRead;
/** K-05 v1.19 draftBlockRead: a new_work_draft_blocks row, never its answer. */
export type DraftBlockRead = K05.DraftBlockRead;
/** K-05 v1.19 companyRead: every column of a companies row. */
export type CompanyRead = K05.CompanyRead;
/** K-05 v1.19 pickedKindsNotFoundError: the request's person or business is not there; nothing read beyond it. */
export interface PickedKindsNotFound extends NotFoundError {
  table: "persons" | "businesses";
}
export type ReadPickedKindsOutcome = ReadPickedKindsResponse | PickedKindsNotFound | TransientError;

/** The two calls, by their K-05 names. */
export type KindsRead = "readKindCatalog" | "readPickedKinds";

const CATALOG: KindsRead = "readKindCatalog";
const PICKED: KindsRead = "readPickedKinds";

// ---- shared ------------------------------------------------------------------------------------------------------------

/**
 * A stored value the answer cannot carry: the call throws and answers nothing, never a value the contract refuses. The
 * error names the call, the table, the column and the fault, never the value or the row.
 */
function cannotCarry(call: KindsRead, table: string, column: string, fault: string): never {
  throw new Error(`${call}: ${table}.${column} holds ${fault}, which the answer cannot carry`);
}

const UTF8 = new TextEncoder();

/** Two ids or keys compared byte by byte, as their UTF-8 bytes (collate "C"'s order on a UTF8 database; default 4). */
function compareBytes(a: string, b: string): number {
  const first = UTF8.encode(a);
  const second = UTF8.encode(b);
  const shorter = Math.min(first.length, second.length);
  for (let index = 0; index < shorter; index += 1) {
    const step = (first[index] ?? 0) - (second[index] ?? 0);
    if (step !== 0) {
      return step;
    }
  }
  return first.length - second.length;
}

// ---- readKindCatalog (item 78) -----------------------------------------------------------------------------------------

/** readKindCatalog's request names nothing (default 167; refuse-kind-catalog-names-business). */
function checkCatalogRequest(request: unknown): void {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    throw new TypeError(`${CATALOG}: the request is an object`);
  }
  if (Object.keys(request).length > 0) {
    throw new TypeError(
      `${CATALOG}: the request names nothing, since the catalog is the same under any business`,
    );
  }
}

/** The isolation levels whose one snapshot serves the whole transaction: every row one moment's. */
const ONE_MOMENT: ReadonlySet<string> = new Set(["repeatable read", "serializable"]);

/** Refuses a transaction that is not read only at repeatable read or serializable, before any table is read (default 1). */
async function assertOneMoment(db: Db, call: KindsRead): Promise<void> {
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

interface CatalogRow {
  id: string;
  name: string;
  style: string | null;
  pattern: KindCatalogRow["pattern"];
  /** The statement takes only trade-file kinds. */
  source: "trade_file";
  version: number;
}

async function catalogOf(db: Db, options: ReadOptions): Promise<ReadKindCatalogResponse> {
  const readAt = await readMoment(db, options);
  const kinds = await db<CatalogRow[]>`
    select id, name, style, pattern, source, version
    from kinds
    where source = 'trade_file'
    order by id collate "C"
  `;
  return {
    result: "kindCatalog",
    readAt: utc(readAt),
    kinds: kinds.map((row) => {
      if (row.style === null) {
        cannotCarry(CATALOG, "kinds", "style", "no style");
      }
      if (row.style === "") {
        cannotCarry(CATALOG, "kinds", "style", "an empty style");
      }
      return {
        id: row.id,
        name: row.name,
        style: row.style,
        pattern: row.pattern,
        source: row.source,
        version: row.version,
      };
    }),
  };
}

/**
 * The kind matcher's catalog (K-05 v1.19 item 78) inside the transaction `db`, the call's own (as rosie_app, the Tool
 * API's client), under any business scope or none, which does not narrow it: refused before any table is read unless it
 * is read only at repeatable read or serializable. Every trade-file kind in id order, never a drafted kind; an empty list
 * when the catalog seed has not run. A request of the wrong shape throws a TypeError; a stored value the answer cannot
 * carry throws.
 */
export async function readKindCatalogIn(
  db: Db,
  request: ReadKindCatalogRequest,
  options: ReadOptions = {},
): Promise<ReadKindCatalogResponse> {
  checkCatalogRequest(request);
  await assertOneMoment(db, CATALOG);
  return catalogOf(db, options);
}

/**
 * The kind matcher's catalog (K-05 v1.19 item 78) in a read-only transaction at repeatable read of its own, on the
 * primary, with no business scope (the same rows as under any). Pass the Tool API's client (rosie_app); rosie_job reads
 * it the same way. transient on a serialization failure, a deadlock or a lost connection. A request of the wrong shape
 * throws a TypeError before any statement; a stored value the answer cannot carry throws.
 */
export async function readKindCatalog(
  sql: Sql,
  request: ReadKindCatalogRequest,
  options: ReadOptions = {},
): Promise<ReadKindCatalogOutcome> {
  checkCatalogRequest(request);
  try {
    return await inRuntimeTransaction(sql, { readOnly: true }, (tx) =>
      readKindCatalogIn(tx, request, options),
    );
  } catch (error) {
    return transientOrScrubbed(CATALOG, error);
  }
}

// ---- readPickedKinds (item 79) -----------------------------------------------------------------------------------------

const PICKED_FIELDS = ["businessId", "personId"] as const;

/**
 * readPickedKinds' request: the business, stated, or null for a sign-up before its business
 * (refuse-picked-kinds-business-left-out), and the call's own person, never null (refuse-picked-kinds-no-person).
 */
function checkPickedRequest(request: unknown): { businessId: string | null; personId: string } {
  assertRequestShape(request, PICKED, PICKED_FIELDS);
  const values = request as Record<string, unknown>;
  for (const field of PICKED_FIELDS) {
    if (!Object.hasOwn(values, field)) {
      throw new TypeError(`${PICKED}: the request needs ${field}`);
    }
  }
  const { businessId, personId } = values;
  if (personId === null) {
    throw new TypeError(`${PICKED}: the request names its own person, never null`);
  }
  assertId(personId, "personId");
  if (businessId === null) {
    return { businessId: null, personId };
  }
  assertId(businessId, "businessId");
  assertBusinessId(businessId);
  return { businessId, personId };
}

/** notFound of the request's person or business: nothing is read beyond it (default 174). */
const notFound = (table: PickedKindsNotFound["table"], rowId: string): PickedKindsNotFound => ({
  error: "notFound",
  table,
  rowId,
});

/**
 * Refuses a role that holds rosie_app's rights and not rosie_job's (T-1455's security note b; this card's lead note 2):
 * row-level security binds rosie_job, and rosie_app sees no row with no business. A role that holds neither (the tables'
 * owner, until T-1093) runs; so does one that holds both.
 */
async function assertRuntimeRole(tx: Sql): Promise<void> {
  const [rights] = await tx<{ app: boolean; job: boolean }[]>`
    select pg_has_role(current_user, 'rosie_app', 'USAGE') as app,
           pg_has_role(current_user, 'rosie_job', 'USAGE') as job
  `;
  if (rights === undefined || (rights.app && !rights.job)) {
    throw new BusinessScopeError(
      `${PICKED} runs as rosie_job: a role with rosie_app's rights and not rosie_job's sees no row with no business`,
    );
  }
}

/** The scope the transaction runs under must be the request's own business (requireBusinessScope, then compared). */
async function assertBusinessScope(tx: Sql, businessId: string, when: string): Promise<void> {
  if ((await requireBusinessScope(tx)) !== businessId) {
    throw new BusinessScopeError(`${PICKED} ${when} under the request's own business scope`);
  }
}

/**
 * The rule every statement of one part carries (README item 79; default 180): on the pick (alias p) and the same
 * business_id condition on each row joined to it (t, d, b), or on the company (c).
 */
interface Rule {
  picks: Fragment;
  texts: Fragment;
  drafts: Fragment;
  blocks: Fragment;
  companies: Fragment;
}

/** The business's rows: business_id = the request's business, on every row a statement reads. */
function businessRule(db: Sql, businessId: string): Rule {
  return {
    picks: db`p.business_id = ${businessId}`,
    texts: db`p.business_id = ${businessId} and t.business_id = ${businessId}`,
    drafts: db`p.business_id = ${businessId} and d.business_id = ${businessId}`,
    blocks: db`p.business_id = ${businessId} and d.business_id = ${businessId} and b.business_id = ${businessId}`,
    companies: db`c.business_id = ${businessId}`,
  };
}

/** The person's rows with no business: the pick's (or company's) owner is the request's person, and no row's business. */
function personRule(db: Sql, personId: string): Rule {
  const pick = db`p.business_id is null and p.owner_person_id = ${personId}`;
  return {
    picks: pick,
    texts: db`${pick} and t.business_id is null`,
    drafts: db`${pick} and d.business_id is null`,
    blocks: db`${pick} and d.business_id is null and b.business_id is null`,
    companies: db`c.business_id is null and c.owner_person_id = ${personId}`,
  };
}

/** Item 77's name of a row of `table`, from its key columns under `alias`, built by the SQL (row-names.ts). */
function nameOf(db: Sql, table: "picked_kind_texts" | "new_work_draft_blocks", alias: string): Fragment {
  const key = twoColumnKeyOf(table);
  if (key === null) {
    throw new Error(`${PICKED}: ${table} has no name of item 77`);
  }
  return rowNameSql(
    db,
    key.map((column) => `${alias}.${column}`),
  );
}

interface PickRow {
  id: string;
  owner_person_id: string;
  position: number;
  words: string;
  outcome: PickedKindRead["outcome"];
  kind_id: string | null;
  company_id: string | null;
  business_id: string | null;
  picked_at: Date;
  /** picked_at's epoch in whole microseconds, as text (default 4). */
  picked_at_us: string;
  version: number;
}

interface TextRow {
  row_id: string;
  picked_kind_id: string;
  pf_key: PickTextRead["pfKey"];
  business_id: string | null;
  version: number;
}

interface DraftRow {
  id: string;
  picked_kind_id: string;
  business_id: string | null;
  state: NewWorkDraftRead["state"];
  drafted_at: Date;
  version: number;
}

interface BlockRow {
  row_id: string;
  draft_id: string;
  block: number;
  business_id: string | null;
  outcome: DraftBlockRead["outcome"];
  facts_on: unknown;
  switches_on: unknown;
  answered_at: Date;
  version: number;
}

interface CompanyRow {
  id: string;
  owner_person_id: string;
  name: string;
  business_id: string | null;
  version: number;
}

/** A pick with the key the two parts are merged by: picked_at in microseconds, then position, then the id's bytes. */
interface KeyedPick {
  at: bigint;
  pick: PickedKindRead;
}

/** One part's rows: the business's, or the person's with no business. */
interface Part {
  picks: KeyedPick[];
  companies: CompanyRead[];
}

const NO_PART: Part = { picks: [], companies: [] };

/** The most texts a pick holds (one per pf key: picked_kind_texts_key_known) and blocks a draft holds (1 to 15). */
const MOST_TEXTS = 11;
const MOST_BLOCKS = 15;

/** A pick's texts as the contract's list: at most one per pf key (picked_kind_texts' key). */
function textList(texts: PickTextRead[]): PickedKindRead["texts"] {
  if (texts.length > MOST_TEXTS) {
    throw new Error(`${PICKED}: more picked_kind_texts rows for one pick than there are pf keys`);
  }
  return texts as PickedKindRead["texts"];
}

/** A draft's blocks as the contract's list: at most one per block, 1 to 15 (new_work_draft_blocks' key). */
function blockList(blocks: DraftBlockRead[]): NewWorkDraftRead["blocks"] {
  if (blocks.length > MOST_BLOCKS) {
    throw new Error(`${PICKED}: more new_work_draft_blocks rows for one draft than there are blocks`);
  }
  return blocks as NewWorkDraftRead["blocks"];
}

/** pluginName: a plug-in fact or switch name (K-24 new_work_draft_blocks_names_form, element by element). */
const PLUGIN_NAME = /^[a-z0-9]+$/;

/**
 * new_work_draft_blocks' facts_on or switches_on read through to_json, element by element (default 5): each a plug-in
 * name. A NULL element (null here), a nested list or any other element throws.
 */
function namesOf(column: "facts_on" | "switches_on", raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    cannotCarry(PICKED, "new_work_draft_blocks", column, "no list");
  }
  const elements: unknown[] = raw;
  return elements.map((element) => {
    if (element === null) {
      cannotCarry(PICKED, "new_work_draft_blocks", column, "a NULL element");
    }
    if (typeof element !== "string" || !PLUGIN_NAME.test(element)) {
      cannotCarry(PICKED, "new_work_draft_blocks", column, "an element that is not a plug-in name");
    }
    return element;
  });
}

/** Appends `value` to the list `map` keeps under `key`. */
function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list === undefined) {
    map.set(key, [value]);
  } else {
    list.push(value);
  }
}

/**
 * One part's rows under `rule`, five statements, each carrying the rule and joining each child to its pick (a block to
 * its draft and that draft's pick), each list in its order: picks by (picked_at, position, id), texts by pf_key within a
 * pick, a draft's blocks by block, companies by id.
 */
async function partOf(db: Sql, rule: Rule): Promise<Part> {
  const picks = await db<PickRow[]>`
    select p.id, p.owner_person_id, p.position, p.words, p.outcome, p.kind_id, p.company_id, p.business_id,
           p.picked_at, (extract(epoch from p.picked_at) * 1000000)::bigint::text as picked_at_us, p.version
    from picked_kinds p
    where ${rule.picks}
    order by p.picked_at, p.position, p.id collate "C"
  `;
  const texts = await db<TextRow[]>`
    select ${nameOf(db, "picked_kind_texts", "t")} as row_id, t.picked_kind_id, t.pf_key, t.business_id, t.version
    from picked_kind_texts t
    join picked_kinds p on p.id = t.picked_kind_id
    where ${rule.texts}
    order by t.picked_kind_id collate "C", t.pf_key collate "C"
  `;
  const drafts = await db<DraftRow[]>`
    select d.id, d.picked_kind_id, d.business_id, d.state, d.drafted_at, d.version
    from new_work_drafts d
    join picked_kinds p on p.id = d.picked_kind_id
    where ${rule.drafts}
    order by d.id collate "C"
  `;
  const blocks = await db<BlockRow[]>`
    select ${nameOf(db, "new_work_draft_blocks", "b")} as row_id, b.draft_id, b.block, b.business_id, b.outcome,
           to_json(b.facts_on) as facts_on, to_json(b.switches_on) as switches_on, b.answered_at, b.version
    from new_work_draft_blocks b
    join new_work_drafts d on d.id = b.draft_id
    join picked_kinds p on p.id = d.picked_kind_id
    where ${rule.blocks}
    order by b.draft_id collate "C", b.block
  `;
  const companies = await db<CompanyRow[]>`
    select c.id, c.owner_person_id, c.name, c.business_id, c.version
    from companies c
    where ${rule.companies}
    order by c.id collate "C"
  `;
  const blocksOf = new Map<string, DraftBlockRead[]>();
  for (const row of blocks) {
    push(blocksOf, row.draft_id, {
      rowId: row.row_id,
      block: row.block,
      businessId: row.business_id,
      outcome: row.outcome,
      factsOn: namesOf("facts_on", row.facts_on),
      switchesOn: namesOf("switches_on", row.switches_on),
      answeredAt: utc(row.answered_at),
      version: row.version,
    });
  }
  const draftOf = new Map<string, NewWorkDraftRead>();
  for (const row of drafts) {
    draftOf.set(row.picked_kind_id, {
      id: row.id,
      businessId: row.business_id,
      state: row.state,
      draftedAt: utc(row.drafted_at),
      version: row.version,
      blocks: blockList(blocksOf.get(row.id) ?? []),
    });
  }
  const textsOf = new Map<string, PickTextRead[]>();
  for (const row of texts) {
    push(textsOf, row.picked_kind_id, {
      rowId: row.row_id,
      pfKey: row.pf_key,
      businessId: row.business_id,
      version: row.version,
    });
  }
  return {
    picks: picks.map((row) => ({
      at: BigInt(row.picked_at_us),
      pick: {
        id: row.id,
        ownerPersonId: row.owner_person_id,
        position: row.position,
        words: row.words,
        outcome: row.outcome,
        kindId: row.kind_id,
        companyId: row.company_id,
        businessId: row.business_id,
        pickedAt: utc(row.picked_at),
        version: row.version,
        texts: textList(textsOf.get(row.id) ?? []),
        draft: draftOf.get(row.id) ?? null,
      },
    })),
    companies: companies.map((row) => {
      if (row.name === "") {
        cannotCarry(PICKED, "companies", "name", "an empty name");
      }
      return {
        id: row.id,
        ownerPersonId: row.owner_person_id,
        name: row.name,
        businessId: row.business_id,
        version: row.version,
      };
    }),
  };
}

/** Item 79's order (default 179): picked_at to the microsecond, then position, then the id byte by byte. */
function pickOrder(a: KeyedPick, b: KeyedPick): number {
  if (a.at !== b.at) {
    return a.at < b.at ? -1 : 1;
  }
  if (a.pick.position !== b.pick.position) {
    return a.pick.position - b.pick.position;
  }
  return compareBytes(a.pick.id, b.pick.id);
}

/**
 * The business's part (step 3), under its scope, set and confirmed before businesses is read: null when the business
 * is not there, read before any of its rows.
 */
async function businessPart(tx: Sql, businessId: string): Promise<Part | null> {
  const [business] = await tx<{ id: string }[]>`select id from businesses where id = ${businessId}`;
  if (business === undefined) {
    return null;
  }
  return partOf(tx, businessRule(tx, businessId));
}

/**
 * The owner's kinds so far (K-05 v1.19 item 79) in one read-only transaction at repeatable read of its own, on the
 * primary: the request's business's picks and companies under that business's scope, then the request's person's with
 * no business on the runtime side, merged into item 79's order. Pass the client's primary handle, run as rosie_job; a
 * role with rosie_app's rights and not rosie_job's is refused (BusinessScopeError) before any table is read. notFound
 * (table persons, then businesses) when the person or the business is not there; transient on a serialization failure,
 * a deadlock or a lost connection. A request of the wrong shape throws a TypeError before any statement; a stored value
 * the answer cannot carry throws.
 */
export async function readPickedKinds(
  sql: Sql,
  request: ReadPickedKindsRequest,
  options: ReadOptions = {},
): Promise<ReadPickedKindsOutcome> {
  const { businessId, personId } = checkPickedRequest(request);
  try {
    return await inRuntimeTransaction(
      sql,
      { readOnly: true },
      async (tx): Promise<ReadPickedKindsResponse | PickedKindsNotFound> => {
        await assertRuntimeRole(tx);
        await assertRuntimeSide(tx, PICKED);
        const [person] = await tx<{ id: string }[]>`select id from persons where id = ${personId}`;
        if (person === undefined) {
          return notFound("persons", personId);
        }
        let business = NO_PART;
        if (businessId !== null) {
          await tx`select set_config(${SCOPE_SETTING}, ${businessId}, true)`;
          await assertBusinessScope(tx, businessId, "reads the business's rows");
          const part = await businessPart(tx, businessId);
          await assertBusinessScope(tx, businessId, "must end the business's part");
          if (part === null) {
            return notFound("businesses", businessId);
          }
          business = part;
          await tx`select set_config(${SCOPE_SETTING}, '', true)`;
          await assertRuntimeSide(tx, PICKED);
        }
        const own = await partOf(tx, personRule(tx, personId));
        const readAt = await readMoment(tx, options);
        return {
          result: "pickedKinds",
          businessId,
          personId,
          readAt: utc(readAt),
          picks: [...business.picks, ...own.picks].sort(pickOrder).map((keyed) => keyed.pick),
          companies: [...business.companies, ...own.companies].sort((a, b) => compareBytes(a.id, b.id)),
        };
      },
    );
  } catch (error) {
    return transientOrScrubbed(PICKED, error);
  }
}
