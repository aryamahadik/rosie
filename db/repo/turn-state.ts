// Data-access v1.2: read turn state, the stored state a turn's frontier is built from (K-05 v1.2 item 26; QUESTIONS.md
// M2-action-adapters.1; arch 02 line 117; arch 03 lines 157 to 175; T-219). Its callers are the frontier (C-075, T-315)
// and the Tool API's turn face (C-074, T-557).
//
// readTurnState reads, as one moment of the primary:
//   handle         the handle's kind and address (K-02 v1 writer.handle), for an email handle and a first text too;
//   persons        the handle's people (person_handles, persons): id, language and version, in id order;
//   roles          their live roles (ended_at null) at the request's business, in role id order;
//   phone          the handle's phones row, or null for an email handle or a number whose first turn wrote none;
//   openQuestions  every live open question sent to the handle at the business, in id order, with when it went out and
//                  the poll it went out as, read by targets.ts's liveOpenQuestionsOfHandle, so the guard, limit 3 and
//                  the frontier share one rule for both (item 26, default 41);
//   bookings       the requested booking heads, in the request's order, with their versions and the flags private and
//                  deceased;
//   pauses         the open pauses (cleared_at null) at the business on the handle's people or on its phone, in id
//                  order (address pauses are not read: K-05 open gap 17);
//   consents       the consent rows of the handle's people at the business, by at then id, without their exact words
//                  (default 36). A STOP or START row has no business, so no business read returns it: the stop reaches
//                  the turn as the phone's stopped flag (K-29 rule 4);
//   facts          each requested fact from its one home row, with that row's version (limit 4), in the request's order.
// The record flags (arch 03 line 175) are the phone's stopped flag, each booking's private and deceased, and the pauses.
// notFound names the first thing missing, in the request's order: the handle, the business, a booking, a fact's row (a
// row of another business counts as missing); nothing else is returned with it.
//
// A fact names its home: a table, the row's primary key as text and a column. The call reads only a home FACT_HOMES
// lists, taken from K-04 v1 core's frozen table list (contracts/db-schema/core/core.v1.tables.json): every versioned
// table with a one-column key, sealing_keys left out, with each column and its type, so no read is built from the
// request's words alone (default 30). Anything else answers unknownFact before anything is read: another part's table
// (K-07's dispatch tables, which no Tool API call reads: 0018; K-22 to K-35's parts, which T-667 adds), a table with no
// version, a sealed column (pauses.address, sealed under a person's key: K-04 rule 6; messages.words, which threads.ts
// stores sealed), and always a sealing key's column, a secret's hash or a table only Rosie's team reads (factTable,
// secretColumn). A value is written as K-04's seed fixtures write values: JSON for jsonb and text[], JSON booleans and
// numbers, a timestamptz in UTC ending in Z, a time as HH:MM, a tstzrange as [start,end).
//
// Side (K-05 v1.2 item 26, default 25; arch 10 line 546; K-04 v1 rule 4): a Tool API read, run by rosie_job, since it
// also reads tables only the runtime side holds (handles, person_handles, persons, phones, outbox_parts). With a
// business it runs under that business's scope: the transaction sets rosie.business_id, then requireBusinessScope()
// confirms it before the first read (with no scope rosie_job reads every business's rows: T-1094's note N2), so
// row-level security leaves that business's rows only; and every read of a business-scoped table also names the
// business, so the answer holds no other business's row even for a role row-level security does not bind (a table's
// owner). With businessId null (sign-up, S1-01) it runs on the runtime side and returns, of the business-scoped tables,
// only rows with no business: no role, booking or pause; open questions and consent rows with none. The rows K-04 scopes
// none (the handle, its people, its phone, a fact of a table scoped none) are read the same on both sides.
//
// Of outbox_parts (scoped none, the dispatcher's table) liveOpenQuestionsOfHandle reads, through the outbox rows the
// scope shows, item 26's five columns (state, kind, sent_at, delivered_at, linq_message_id), the key it joins on
// (outbox_row_id) and part_no and try_no as order tie-breaks, and returns none of them but as sentAt and pollId: never a
// part's words, idempotency key, option ids or error code. No grant changes: rosie_app is given nothing (DL-149).
//
// Reads (arch 10 lines 504, 538): the primary, uncached, in one read-only transaction at repeatable read, so every row
// and version is one moment's, and whatever committed before the call began is seen. Ids are compared byte by byte
// (collate "C"), never parsed (CQ-09). A serialization failure, a deadlock or a lost connection answers transient.
// Nothing here logs, and an error names a field, a table or a column, never a value: addresses, names and words are
// personal data.
import type { ConsentChannel, ConsentKind } from "./consent";
import {
  assertBusinessId,
  BusinessScopeError,
  readBusinessScope,
  requireBusinessScope,
  SCOPE_SETTING,
  type Sql,
  type Tx,
} from "./scope";
import type { PauseRead, PhoneRead } from "./send-state";
import {
  assertId,
  assertRequestShape,
  type BookingHead,
  type BookingStage,
  inRuntimeTransaction,
  liveOpenQuestionsOfHandle,
  type NotFoundError,
  type OpenQuestionRead,
  readMoment,
  type ReadOptions,
  type Role,
  type TransientError,
  transientOrThrow,
  utc,
  utcOrNull,
} from "./targets";

type Db = Sql | Tx;

// ---- the request and the answer (data-access.v1.2.schema.json readTurnState) ----------------------------------------

/** K-05 v1.2 factRef: a fact by its key and its one home (a table, the row's primary key as text, a column). */
export interface FactRef {
  key: string;
  table: string;
  rowId: string;
  column: string;
}

export interface ReadTurnStateRequest {
  handleId: string;
  /** The business the read runs under, or null before there is one (the runtime side). */
  businessId: string | null;
  /** The target booking heads, each named once. */
  bookingIds: string[];
  facts: FactRef[];
}

/** K-05 v1.2 factValue: the column's value now, as K-04's seed fixtures write values, and the row's version. */
export interface FactValue extends FactRef {
  value: unknown;
  version: number;
}

export interface TurnStatePerson {
  personId: string;
  language: string | null;
  version: number;
}

export interface TurnStateRole {
  roleId: string;
  personId: string;
  role: Role;
  version: number;
}

/** K-05 v1.2 consentRead: a consent row without its exact words, which stay in the row (default 36). */
export interface TurnStateConsent {
  id: string;
  personId: string;
  businessId: string | null;
  kind: ConsentKind;
  revoked: boolean;
  handleId: string | null;
  bookingId: string | null;
  wordsSha256: string;
  at: string;
  channel: ConsentChannel;
  chatLinkId: string | null;
  turnId: string | null;
}

export interface ReadTurnStateResponse {
  result: "turnState";
  handleId: string;
  handle: { kind: "phone" | "email"; address: string };
  businessId: string | null;
  readAt: string;
  persons: TurnStatePerson[];
  roles: TurnStateRole[];
  phone: PhoneRead | null;
  openQuestions: OpenQuestionRead[];
  bookings: BookingHead[];
  pauses: PauseRead[];
  consents: TurnStateConsent[];
  facts: FactValue[];
}

/** K-05 v1.2 unknownFactError: a fact whose home is not one FACT_HOMES lists. Nothing was read. */
export interface UnknownFactError {
  error: "unknownFact";
  key: string;
  table: string;
  column: string;
}

export type ReadTurnStateOutcome = ReadTurnStateResponse | NotFoundError | UnknownFactError | TransientError;

// ---- the homes a fact may name ----------------------------------------------------------------------------------------

/** A column type a fact may hold, as K-04 v1 core's table list spells it. */
export type FactColumnType =
  "text" | "integer" | "bigint" | "boolean" | "timestamptz" | "time" | "jsonb" | "text[]" | "tstzrange";

export interface FactHome {
  /** The table's one primary-key column, which a fact's rowId names. */
  readonly key: string;
  /** The column row-level security scopes the table by (K-04 rowLevelSecurity.column), or null for a table scoped none. */
  readonly scopedBy: string | null;
  /** Each column a fact may name, with its type. */
  readonly columns: Readonly<Record<string, FactColumnType>>;
}

function home(key: string, scopedBy: string | null, columns: Record<string, FactColumnType>): FactHome {
  return Object.freeze({ key, scopedBy, columns: Object.freeze({ ...columns }) });
}

/**
 * The homes a fact may name: every versioned table of K-04 v1 core with a one-column primary key, sealing_keys left
 * out (no key's column is ever a fact: rule 7), with every column the frozen table list gives and its type, except the
 * two sealed ones: pauses.address (K-04 rule 6) and messages.words (stored sealed by threads.ts). Tables keyed on more
 * than one column (bundles, release_flags, outbox_parts) and tables with no version (handles, person_handles,
 * openers_sent, event_log, bundle_values) hold no fact. The integration test holds this list to the frozen one.
 */
export const FACT_HOMES: Readonly<Record<string, FactHome>> = Object.freeze({
  bookings: home("id", "business_id", {
    id: "text",
    business_id: "text",
    flow: "text",
    stage: "text",
    booker_person_id: "text",
    served_person_id: "text",
    payer_person_id: "text",
    private: "boolean",
    deceased: "boolean",
    version: "integer",
  }),
  businesses: home("id", "id", {
    id: "text",
    name: "text",
    display_name: "text",
    status: "text",
    time_zone: "text",
    text_hours_start: "time",
    text_hours_end: "time",
    version: "integer",
  }),
  class_seats: home("resource_id", "business_id", {
    resource_id: "text",
    resource_kind: "text",
    business_id: "text",
    capacity: "integer",
    taken: "integer",
    version: "integer",
  }),
  clock_rows: home("id", "business_id", {
    id: "text",
    kind: "text",
    open_question_id: "text",
    reservation_id: "text",
    handle_id: "text",
    business_id: "text",
    booking_id: "text",
    due_at: "timestamptz",
    due_zone: "text",
    state: "text",
    armed_at: "timestamptz",
    fires: "jsonb",
    fired_at: "timestamptz",
    cancelled_at: "timestamptz",
    created_by_turn_id: "text",
    version: "integer",
  }),
  messages: home("id", "business_id", {
    id: "text",
    thread_id: "text",
    business_id: "text",
    booking_id: "text",
    direction: "text",
    channel: "text",
    service: "text",
    from_role: "text",
    to_role: "text",
    person_id: "text",
    event_id: "text",
    outbox_row_id: "text",
    sent_at: "timestamptz",
    delivered_at: "timestamptz",
    version: "integer",
  }),
  open_questions: home("id", "business_id", {
    id: "text",
    turn_id: "text",
    handle_id: "text",
    person_id: "text",
    business_id: "text",
    booking_id: "text",
    step: "text",
    options: "jsonb",
    readback: "text",
    versions_read: "jsonb",
    bundle_hash: "text",
    bundle_build: "integer",
    clock: "text",
    ask_count: "integer",
    status: "text",
    answered_option_id: "text",
    closed_at: "timestamptz",
    version: "integer",
  }),
  outbox_rows: home("id", "business_id", {
    id: "text",
    turn_id: "text",
    commit_seq: "bigint",
    recipient_handle_id: "text",
    recipient_person_id: "text",
    business_id: "text",
    booking_id: "text",
    channel: "text",
    send_class: "text",
    versions_read: "jsonb",
    open_question_id: "text",
    plan: "jsonb",
    final_parts: "jsonb",
    copy_of_row_id: "text",
    state: "text",
    held_until: "timestamptz",
    bundle_hash: "text",
    bundle_build: "integer",
    trace_id: "text",
    version: "integer",
  }),
  pauses: home("id", "business_id", {
    id: "text",
    business_id: "text",
    target: "text",
    person_id: "text",
    phone_number: "text",
    sealed_for_person_id: "text",
    set_by_turn_id: "text",
    set_at: "timestamptz",
    cleared_at: "timestamptz",
    cleared_by_person_id: "text",
    version: "integer",
  }),
  person_roles: home("id", "business_id", {
    id: "text",
    person_id: "text",
    business_id: "text",
    role: "text",
    ended_at: "timestamptz",
    version: "integer",
  }),
  persons: home("id", null, {
    id: "text",
    name: "text",
    language: "text",
    version: "integer",
  }),
  phones: home("number", null, {
    number: "text",
    handle_id: "text",
    chat_open: "boolean",
    chat_open_at: "timestamptz",
    chat_way: "text",
    stopped: "boolean",
    stop_at: "timestamptz",
    start_at: "timestamptz",
    linq_contact_added_at: "timestamptz",
    poll_voted_at: "timestamptz",
    optout_line_delivered_at: "timestamptz",
    version: "integer",
  }),
  reservations: home("id", "business_id", {
    id: "text",
    business_id: "text",
    resource_id: "text",
    resource_kind: "text",
    worker_person_id: "text",
    during: "tstzrange",
    state: "text",
    queued_at: "timestamptz",
    seats: "integer",
    held_until: "timestamptz",
    extended: "boolean",
    for_phone_number: "text",
    for_agent_token: "text",
    booking_id: "text",
    released_at: "timestamptz",
    released_why: "text",
    version: "integer",
  }),
  resources: home("id", "business_id", {
    id: "text",
    business_id: "text",
    kind: "text",
    name: "text",
    person_id: "text",
    active: "boolean",
    version: "integer",
  }),
  threads: home("id", null, {
    id: "text",
    handle_id: "text",
    kind: "text",
    booking_id: "text",
    linq_chat_id: "text",
    reply_address: "text",
    version: "integer",
  }),
  turns: home("id", null, {
    id: "text",
    handle_id: "text",
    event_ids: "text[]",
    state: "text",
    lease_until: "timestamptz",
    bundle_hash: "text",
    bundle_build: "integer",
    trace_id: "text",
    joined_trace_ids: "text[]",
    tries: "integer",
    committed_at: "timestamptz",
    parked_at: "timestamptz",
    version: "integer",
  }),
});

/**
 * Never a fact, whatever FACT_HOMES may come to list: a sealing key's table and the tables only Rosie's team reads
 * (K-05 v1.2 factTable: K-04 sealing_keys, K-34 harm_reports, K-36 team_pages and team_page_recipients, K-37's five).
 */
const NEVER_FACT_TABLES: ReadonlySet<string> = new Set([
  "sealing_keys",
  "harm_reports",
  "team_pages",
  "team_page_recipients",
  "parked_turns",
  "dead_letters",
  "gap_cases",
  "review_items",
  "live_turn_labels",
]);

/** A secret's hash is never a fact (K-05 v1.2 secretColumn: K-22 proof_codes and sessions). */
const SECRET_COLUMNS: ReadonlySet<string> = new Set([
  "proof_codes.code_hash",
  "sessions.token_sha256",
  "sessions.device_sha256",
]);

/** The first fact, in the request's order, whose home is not a fact home; null when every one is. */
function unknownFactOf(facts: readonly FactRef[]): UnknownFactError | null {
  for (const fact of facts) {
    const factHome = Object.hasOwn(FACT_HOMES, fact.table) ? FACT_HOMES[fact.table] : undefined;
    if (
      factHome === undefined ||
      !Object.hasOwn(factHome.columns, fact.column) ||
      NEVER_FACT_TABLES.has(fact.table) ||
      SECRET_COLUMNS.has(`${fact.table}.${fact.column}`)
    ) {
      return { error: "unknownFact", key: fact.key, table: fact.table, column: fact.column };
    }
  }
  return null;
}

// ---- the request's shape ------------------------------------------------------------------------------------------

const REQUEST_FIELDS = ["handleId", "businessId", "bookingIds", "facts"] as const;
const FACT_FIELDS: ReadonlySet<string> = new Set(["key", "table", "rowId", "column"]);
/** K-05's tableName and columnName (data-access.v1.schema.json tableName; v1.2 columnName). */
const NAME = /^[a-z_][a-z0-9_]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Refuses a request that is not readTurnState.request's shape, naming the field, never a value. */
function checkRequest(request: unknown): asserts request is ReadTurnStateRequest {
  assertRequestShape(request, "readTurnState", REQUEST_FIELDS);
  const fields = request as Record<string, unknown>;
  for (const field of REQUEST_FIELDS) {
    if (!Object.hasOwn(fields, field)) {
      throw new TypeError(`readTurnState: the request needs ${field}`);
    }
  }
  assertId(fields.handleId, "handleId");
  if (fields.businessId !== null) {
    assertId(fields.businessId, "businessId");
    assertBusinessId(fields.businessId);
  }
  const { bookingIds, facts } = fields;
  if (!Array.isArray(bookingIds)) {
    throw new TypeError("readTurnState: bookingIds is a list");
  }
  const seen = new Set<string>();
  for (const bookingId of bookingIds as unknown[]) {
    assertId(bookingId, "each of bookingIds");
    if (seen.has(bookingId)) {
      throw new TypeError("readTurnState: bookingIds names each booking once");
    }
    seen.add(bookingId);
  }
  if (!Array.isArray(facts)) {
    throw new TypeError("readTurnState: facts is a list");
  }
  for (const fact of facts as unknown[]) {
    if (
      !isRecord(fact) ||
      Object.keys(fact).length !== FACT_FIELDS.size ||
      !Object.keys(fact).every((field) => FACT_FIELDS.has(field))
    ) {
      throw new TypeError("readTurnState: each fact is exactly {key, table, rowId, column}");
    }
    if (typeof fact.key !== "string" || fact.key === "") {
      throw new TypeError("readTurnState: a fact's key is a non-empty string");
    }
    if (typeof fact.table !== "string" || !NAME.test(fact.table)) {
      throw new TypeError("readTurnState: a fact's table is a plain lower-case name");
    }
    assertId(fact.rowId, "a fact's rowId");
    if (typeof fact.column !== "string" || !NAME.test(fact.column)) {
      throw new TypeError("readTurnState: a fact's column is a plain lower-case name");
    }
  }
}

// ---- rows ---------------------------------------------------------------------------------------------------------

interface PersonRow {
  id: string;
  language: string | null;
  version: number;
}

interface RoleRow {
  id: string;
  person_id: string;
  role: Role;
  version: number;
}

interface PhoneRow {
  number: string;
  stopped: boolean;
  stop_at: Date | null;
  chat_open: boolean;
  chat_way: PhoneRead["chatWay"];
  linq_contact_added_at: Date | null;
  poll_voted_at: Date | null;
  optout_line_delivered_at: Date | null;
  version: number;
}

interface BookingRow {
  id: string;
  business_id: string;
  flow: "A" | "B";
  stage: BookingStage;
  booker_person_id: string;
  served_person_id: string | null;
  payer_person_id: string | null;
  private: boolean;
  deceased: boolean;
  version: number;
}

interface PauseRow {
  id: string;
  target: "person" | "phone";
  person_id: string | null;
  phone_number: string | null;
  set_by_turn_id: string | null;
  set_at: Date;
  version: number;
}

interface ConsentRow {
  id: string;
  person_id: string;
  business_id: string | null;
  kind: ConsentKind;
  revoked: boolean;
  handle_id: string | null;
  booking_id: string | null;
  words_sha256: string;
  at: Date;
  channel: ConsentChannel;
  chat_link_id: string | null;
  turn_id: string | null;
}

interface RangeRow {
  is_null: boolean;
  is_empty: boolean | null;
  lower: Date | null;
  upper: Date | null;
  lower_inc: boolean | null;
  upper_inc: boolean | null;
  version: number;
}

const toPhone = (row: PhoneRow): PhoneRead => ({
  number: row.number,
  stopped: row.stopped,
  stopAt: utcOrNull(row.stop_at),
  chatOpen: row.chat_open,
  chatWay: row.chat_way,
  linqContactAddedAt: utcOrNull(row.linq_contact_added_at),
  pollVotedAt: utcOrNull(row.poll_voted_at),
  optoutLineDeliveredAt: utcOrNull(row.optout_line_delivered_at),
  version: row.version,
});

const toBooking = (row: BookingRow): BookingHead => ({
  id: row.id,
  businessId: row.business_id,
  flow: row.flow,
  stage: row.stage,
  bookerPersonId: row.booker_person_id,
  servedPersonId: row.served_person_id,
  payerPersonId: row.payer_person_id,
  private: row.private,
  deceased: row.deceased,
  version: row.version,
});

const toPause = (row: PauseRow): PauseRead => ({
  id: row.id,
  target: row.target,
  personId: row.person_id,
  phoneNumber: row.phone_number,
  setByTurnId: row.set_by_turn_id,
  setAt: utc(row.set_at),
  version: row.version,
});

const toConsent = (row: ConsentRow): TurnStateConsent => ({
  id: row.id,
  personId: row.person_id,
  businessId: row.business_id,
  kind: row.kind,
  revoked: row.revoked,
  handleId: row.handle_id,
  bookingId: row.booking_id,
  wordsSha256: row.words_sha256,
  at: utc(row.at),
  channel: row.channel,
  chatLinkId: row.chat_link_id,
  turnId: row.turn_id,
});

const notFound = (table: string, rowId: string): NotFoundError => ({ error: "notFound", table, rowId });

// ---- the reads ----------------------------------------------------------------------------------------------------

/** A value as K-04's seed fixtures write it (see the top of this file). */
function factValueOf(type: FactColumnType, raw: unknown): unknown {
  if (raw === null || raw === undefined) {
    return null;
  }
  switch (type) {
    case "timestamptz":
      return utc(raw as Date);
    case "time":
      // PostgreSQL's time text is HH:MM:SS; whole minutes read as HH:MM, as K-04's seeds write them.
      return typeof raw === "string" ? raw.replace(/^([0-9]{2}:[0-9]{2}):00$/, "$1") : raw;
    case "bigint": {
      const value = Number(raw);
      if (!Number.isSafeInteger(value)) {
        throw new Error("readTurnState: a bigint fact is past the largest safe integer");
      }
      return value;
    }
    default:
      return raw;
  }
}

/** A tstzrange as K-04's seeds write it: [start,end) in UTC, or PostgreSQL's own text for an empty or open range. */
function rangeText(row: RangeRow): string | null {
  if (row.is_null) {
    return null;
  }
  if (row.is_empty === true) {
    return "empty";
  }
  const lower = row.lower === null ? "" : utc(row.lower);
  const upper = row.upper === null ? "" : utc(row.upper);
  return `${row.lower_inc === true ? "[" : "("}${lower},${upper}${row.upper_inc === true ? "]" : ")"}`;
}

/**
 * One fact from its home row, or null when the row does not exist or the business does not hold it: a row of a
 * business-scoped table must carry the request's business (with none, no business). Every name in the query comes from
 * FACT_HOMES, which the caller has checked the fact against.
 */
async function readFact(db: Db, fact: FactRef, businessId: string | null): Promise<FactValue | null> {
  const factHome = FACT_HOMES[fact.table];
  const type = factHome?.columns[fact.column];
  if (factHome === undefined || type === undefined) {
    throw new Error("readTurnState: a fact was read before its home was checked");
  }
  const column = db(fact.column);
  const ofBusiness =
    factHome.scopedBy === null
      ? db``
      : businessId === null
        ? db`and ${db(factHome.scopedBy)} is null`
        : db`and ${db(factHome.scopedBy)} = ${businessId}`;
  const ref: FactRef = { key: fact.key, table: fact.table, rowId: fact.rowId, column: fact.column };
  if (type === "tstzrange") {
    const [row] = await db<RangeRow[]>`
      select ${column} is null as is_null, isempty(${column}) as is_empty, lower(${column}) as lower,
             upper(${column}) as upper, lower_inc(${column}) as lower_inc, upper_inc(${column}) as upper_inc, version
      from ${db(fact.table)}
      where ${db(factHome.key)} = ${fact.rowId} ${ofBusiness}
    `;
    return row === undefined ? null : { ...ref, value: rangeText(row), version: row.version };
  }
  const [row] = await db<{ value: unknown; version: number }[]>`
    select ${column} as value, version
    from ${db(fact.table)}
    where ${db(factHome.key)} = ${fact.rowId} ${ofBusiness}
  `;
  return row === undefined ? null : { ...ref, value: factValueOf(type, row.value), version: row.version };
}

/** The requested heads in the request's order, or notFound for the first the business does not hold. */
async function bookingHeads(
  db: Db,
  bookingIds: readonly string[],
  businessId: string | null,
): Promise<BookingHead[] | NotFoundError> {
  const [first] = bookingIds;
  if (first === undefined) {
    return [];
  }
  if (businessId === null) {
    // Every booking has a business (K-04 bookings.business_id is not null), so with none no booking is found.
    return notFound("bookings", first);
  }
  const rows = await db<BookingRow[]>`
    select id, business_id, flow, stage, booker_person_id, served_person_id, payer_person_id, private, deceased,
           version
    from bookings
    where id in ${db([...bookingIds])} and business_id = ${businessId}
  `;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const heads: BookingHead[] = [];
  for (const bookingId of bookingIds) {
    const row = byId.get(bookingId);
    if (row === undefined) {
      return notFound("bookings", bookingId);
    }
    heads.push(toBooking(row));
  }
  return heads;
}

/** The open pauses at the business on these people or on this phone, in id order (never an address pause). */
async function openPauses(
  db: Db,
  businessId: string,
  personIds: readonly string[],
  phoneNumber: string | null,
): Promise<PauseRead[]> {
  if (personIds.length === 0 && phoneNumber === null) {
    return [];
  }
  const onPerson =
    personIds.length === 0 ? db`false` : db`(target = 'person' and person_id in ${db([...personIds])})`;
  const onPhone = phoneNumber === null ? db`false` : db`(target = 'phone' and phone_number = ${phoneNumber})`;
  const rows = await db<PauseRow[]>`
    select id, target, person_id, phone_number, set_by_turn_id, set_at, version
    from pauses
    where business_id = ${businessId} and cleared_at is null and (${onPerson} or ${onPhone})
    order by id collate "C"
  `;
  return rows.map(toPause);
}

/** These people's consent rows at the business (with none, the rows with no business), oldest first, no words. */
async function consentRows(
  db: Db,
  personIds: readonly string[],
  businessId: string | null,
): Promise<TurnStateConsent[]> {
  if (personIds.length === 0) {
    return [];
  }
  const ofBusiness = businessId === null ? db`business_id is null` : db`business_id = ${businessId}`;
  const rows = await db<ConsentRow[]>`
    select id, person_id, business_id, kind, revoked, handle_id, booking_id, words_sha256, at, channel, chat_link_id,
           turn_id
    from consents
    where person_id in ${db([...personIds])} and ${ofBusiness}
    order by at, id collate "C"
  `;
  return rows.map(toConsent);
}

/** Refuses a transaction on the wrong side: the request's business scope, or with no business no scope at all. */
async function assertSide(db: Db, businessId: string | null): Promise<void> {
  if (businessId === null) {
    if ((await readBusinessScope(db)) !== null) {
      throw new BusinessScopeError(
        "readTurnState with no business runs on the runtime side: a business scope hides the rows with none",
      );
    }
    return;
  }
  if ((await requireBusinessScope(db)) !== businessId) {
    throw new BusinessScopeError("readTurnState runs under the request's own business scope");
  }
}

async function readState(
  db: Db,
  request: ReadTurnStateRequest,
  options: ReadOptions,
): Promise<ReadTurnStateResponse | NotFoundError> {
  const { handleId, businessId } = request;

  const [handle] = await db<{ kind: "phone" | "email"; address: string }[]>`
    select kind, address from handles where id = ${handleId}
  `;
  if (handle === undefined) {
    return notFound("handles", handleId);
  }
  if (businessId !== null) {
    const [business] = await db<{ id: string }[]>`select id from businesses where id = ${businessId}`;
    if (business === undefined) {
      return notFound("businesses", businessId);
    }
  }
  const bookings = await bookingHeads(db, request.bookingIds, businessId);
  if (!Array.isArray(bookings)) {
    return bookings;
  }
  const facts: FactValue[] = [];
  for (const fact of request.facts) {
    const read = await readFact(db, fact, businessId);
    if (read === null) {
      return notFound(fact.table, fact.rowId);
    }
    facts.push(read);
  }
  const readAt = await readMoment(db, options);

  const persons = await db<PersonRow[]>`
    select p.id, p.language, p.version
    from person_handles ph
    join persons p on p.id = ph.person_id
    where ph.handle_id = ${handleId}
    order by p.id collate "C"
  `;
  const personIds = persons.map((person) => person.id);

  const [phone] = await db<PhoneRow[]>`
    select number, stopped, stop_at, chat_open, chat_way, linq_contact_added_at, poll_voted_at,
           optout_line_delivered_at, version
    from phones where handle_id = ${handleId}
  `;

  const roles =
    businessId === null || personIds.length === 0
      ? []
      : await db<RoleRow[]>`
          select id, person_id, role, version
          from person_roles
          where person_id in ${db(personIds)} and business_id = ${businessId} and ended_at is null
          order by id collate "C"
        `;

  // Under the scope row-level security leaves the business's questions and outbox rows; the filter keeps the answer to
  // them even where it does not bind, and on the runtime side keeps only the questions with no business.
  const openQuestions = (await liveOpenQuestionsOfHandle(db, handleId)).filter(
    (question) => question.businessId === businessId,
  );

  const pauses =
    businessId === null ? [] : await openPauses(db, businessId, personIds, phone?.number ?? null);
  const consents = await consentRows(db, personIds, businessId);

  return {
    result: "turnState",
    handleId,
    handle: { kind: handle.kind, address: handle.address },
    businessId,
    readAt: utc(readAt),
    persons: persons.map((person) => ({
      personId: person.id,
      language: person.language,
      version: person.version,
    })),
    roles: roles.map((role) => ({
      roleId: role.id,
      personId: role.person_id,
      role: role.role,
      version: role.version,
    })),
    phone: phone === undefined ? null : toPhone(phone),
    openQuestions,
    bookings,
    pauses,
    consents,
    facts,
  };
}

/**
 * Read turn state inside the transaction `db`, which must already run on the request's side: under the request's
 * business scope (checked with requireBusinessScope), or with businessId null on the runtime side, with no scope. It
 * should be a read-only transaction at repeatable read, so the answer is one moment's. Prefer readTurnState(); this is
 * for a caller that already holds such a transaction.
 */
export async function readTurnStateIn(
  db: Db,
  request: ReadTurnStateRequest,
  options: ReadOptions = {},
): Promise<ReadTurnStateResponse | NotFoundError | UnknownFactError> {
  checkRequest(request);
  const unknown = unknownFactOf(request.facts);
  if (unknown !== null) {
    return unknown;
  }
  await assertSide(db, request.businessId);
  return readState(db, request, options);
}

/**
 * A turn's stored state (K-05 v1.2 item 26), for the frontier: one read-only transaction at repeatable read on the
 * primary, uncached, under the request's business scope, or on the runtime side when businessId is null. Pass the
 * client's primary handle, run as rosie_job. unknownFact (nothing read) when a fact's home is not a fact home; notFound
 * for the first of the handle, the business, a booking or a fact's row that is missing or another business's; transient
 * on a serialization failure, a deadlock or a lost connection. A request of the wrong shape throws a TypeError.
 */
export async function readTurnState(
  sql: Sql,
  request: ReadTurnStateRequest,
  options: ReadOptions = {},
): Promise<ReadTurnStateOutcome> {
  checkRequest(request);
  const unknown = unknownFactOf(request.facts);
  if (unknown !== null) {
    return unknown;
  }
  const { businessId } = request;
  try {
    // The runtime side's transaction clears any scope a connection kept; with a business the scope is set first.
    return await inRuntimeTransaction(sql, { readOnly: true }, async (tx) => {
      if (businessId === null) {
        return readTurnStateIn(tx, request, options);
      }
      await tx`select set_config(${SCOPE_SETTING}, ${businessId}, true)`;
      const outcome = await readTurnStateIn(tx, request, options);
      if ((await requireBusinessScope(tx)) !== businessId) {
        throw new BusinessScopeError("readTurnState must end under the business scope it began with");
      }
      return outcome;
    });
  } catch (error) {
    return transientOrThrow(error);
  }
}
