// Data-access v1.4: the safety service's seven reads (K-05 v1.4 items 37 to 43; T-1160, T-1161; DL-344, DL-345,
// DL-348). Their caller is the safety and hand-offs service (C-104, T-318) through runCore (C-087, T-1140), which T-1141
// binds as its SafetyReader (actions/src/domain/safety/ports.ts), all but arrivedAt (T-1155). Each answer's value is the
// port's own shape (default 60): safetyOutcome is a StoredOutcome, hold a StoredHold, written a boolean, owner an
// OwnerContact and timeZone a zone, so the wiring hands it on unchanged and maps only the errors (default 61).
//
//   readSafetyOutcomeOfEvent  a text's safety record by its event id (safety_outcomes_event_key), the record's first
//                             read: a row found is a repeat (item 37).
//   readSafetyOutcome         a safety outcome by its id: the danger text's, and the "we're safe" read a release is given
//                             (item 38).
//   readSafetyHold            a safety hold by its id, open or released, with its version (item 39).
//   readSafetyHoldOfOutcome   the one hold an outcome set, open or released (safety_holds_one_per_outcome; item 40).
//   readOutboxRowWritten      whether an outbox row with this id is written: its id alone (item 41).
//   readBusinessOwner         the business's one live owner and the handle they write from: their first phone handle,
//                             else their first email handle, in handle id order (item 42, defaults 58 and 59).
//   readBusinessZone          the business's time zone (item 43).
//
// Roles and scope (README "v1.4", defaults 55 to 57; K-04 v1 rule 4; STATE notes 5 and 22). The role is the
// connection's: the caller passes the client, or the transaction, of the role the read names.
//   The five record reads (items 37 to 41) and the zone (item 43) run as the Tool API's role, rosie_app, on the call's
//   own transaction under its business's scope: every table they read is business-scoped and granted to rosie_app (0012,
//   0016). With businessId null (the five; the zone always has a business) they run on the runtime side, as rosie_job
//   with no scope, and the read itself names `business_id is null`, since rosie_job with no scope sees every business's
//   rows. rosie_app sees no row without a scope, so there it would answer none whatever is stored: the read refuses a
//   role that holds rosie_app's rights and not rosie_job's (default 1).
//   readBusinessOwner runs as rosie_job, since person_handles and handles are tables only the runtime side holds (0012),
//   with the business's scope set and confirmed by requireBusinessScope() before the first read (with no scope rosie_job
//   reads every business's rows: T-1094's note N2). It refuses rosie_app the same way, before any read.
//   The request's business must be the transaction's scope, and with none no scope at all, or the read refuses to run
//   (default 2). With a business, each read first finds the business in its scope and answers notFound (table
//   businesses) otherwise, so a null or false answer always means none in this business, never no such business
//   (default 56). Besides the scope, every read of a business-scoped table names the business, so even a role that
//   row-level security does not bind (a table's owner, until T-1093) sees no other business's row: another business's
//   row, and one with no business under a business scope, answers as no row does, null or false (default 57).
//
// What these reads never touch (item 37; README "Consumers of v1.4", T-1161): rosie_app holds SELECT on the whole of
// safety_outcomes and outbox_rows, and rosie_job on handles, so each statement's column list is the barrier. No
// statement here names safety_outcomes.sealed_words, tries or danger_word_lists, outbox_rows.plan or final_parts (the
// message's words), handles.address or any other sealed, personal or key column; none selects `*`, and none takes a
// whole row (a bare row alias, to_jsonb, row_to_json). The integration test records every statement the seven reads
// send, pins each read's tables and checks all of it (DL-345).
//
// Reads (arch 02 line 117; arch 10 lines 504, 538): the primary, uncached. An In read runs inside the caller's own
// transaction, so a record or a release reads what its own commit then compares; the others open one read-only
// transaction at repeatable read of their own. Ids are compared byte by byte (collate "C"), never parsed (CQ-09). A
// serialization failure, a deadlock or a lost connection answers transient. Nothing here logs; an error names a call, a
// field or a rule, never a value or an id.
//
// Defaults used (for ops/QUESTIONS.md; each where no source decides):
//   1. A read with no business, and readBusinessOwner, refuse a role that holds rosie_app's rights and not rosie_job's
//      (BusinessScopeError) before any read: T-1138's rule for readOpenHolds with no business (DL-326 note 4), so a
//      Tool API client passed by mistake fails closed every time, not only when a row would be missing. A role that holds
//      neither (the tables' owner, until T-1093's login role) runs.
//   2. A request whose business is not the transaction's own scope is refused (BusinessScopeError), never read: the
//      security reviewer's note b on T-1160, as T-1138's In reads refuse it.
import type * as K05 from "../../contracts/generated/data-access/data-access.v1.4";
import { transientOrScrubbed } from "./clocks";
import {
  assertBusinessId,
  BusinessScopeError,
  readBusinessScope,
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

// ---- the requests and the answers (data-access.v1.4.schema.json) ----------------------------------------------------

/** K-05 v1.4 storedOutcome: a safety_outcomes row as the safety service reads it, never its sealed words. */
export type StoredOutcome = K05.StoredOutcome;
/** K-05 v1.4 storedHold: every column of a safety_holds row (none is sealed), with its version. */
export type StoredHold = K05.StoredHold;
/** K-05 v1.4 ownerContact: the owner's person and the handle they write from, by id, never an address. */
export type OwnerContact = K05.OwnerContact;
/** K-05 v1.4 moreThanOneOwnerError: two or more live owner roles; nothing else is returned (default 58). */
export type MoreThanOneOwnerError = K05.MoreThanOneOwnerError;

export type ReadSafetyOutcomeOfEventRequest = K05.ReadSafetyOutcomeOfEventRequest;
export type ReadSafetyOutcomeOfEventResponse = K05.ReadSafetyOutcomeOfEventResponse;
export type ReadSafetyOutcomeOfEventOutcome =
  ReadSafetyOutcomeOfEventResponse | NotFoundError | TransientError;

export type ReadSafetyOutcomeRequest = K05.ReadSafetyOutcomeRequest;
export type ReadSafetyOutcomeResponse = K05.ReadSafetyOutcomeResponse;
export type ReadSafetyOutcomeOutcome = ReadSafetyOutcomeResponse | NotFoundError | TransientError;

export type ReadSafetyHoldRequest = K05.ReadSafetyHoldRequest;
export type ReadSafetyHoldResponse = K05.ReadSafetyHoldResponse;
export type ReadSafetyHoldOutcome = ReadSafetyHoldResponse | NotFoundError | TransientError;

export type ReadSafetyHoldOfOutcomeRequest = K05.ReadSafetyHoldOfOutcomeRequest;
export type ReadSafetyHoldOfOutcomeResponse = K05.ReadSafetyHoldOfOutcomeResponse;
export type ReadSafetyHoldOfOutcomeOutcome = ReadSafetyHoldOfOutcomeResponse | NotFoundError | TransientError;

export type ReadOutboxRowWrittenRequest = K05.ReadOutboxRowWrittenRequest;
export type ReadOutboxRowWrittenResponse = K05.ReadOutboxRowWrittenResponse;
export type ReadOutboxRowWrittenOutcome = ReadOutboxRowWrittenResponse | NotFoundError | TransientError;

export type ReadBusinessOwnerRequest = K05.ReadBusinessOwnerRequest;
export type ReadBusinessOwnerResponse = K05.ReadBusinessOwnerResponse;
export type ReadBusinessOwnerOutcome =
  ReadBusinessOwnerResponse | NotFoundError | MoreThanOneOwnerError | TransientError;

export type ReadBusinessZoneRequest = K05.ReadBusinessZoneRequest;
export type ReadBusinessZoneResponse = K05.ReadBusinessZoneResponse;
export type ReadBusinessZoneOutcome = ReadBusinessZoneResponse | NotFoundError | TransientError;

/** The seven calls, by their K-05 names. */
export type SafetyRead =
  | "readSafetyOutcomeOfEvent"
  | "readSafetyOutcome"
  | "readSafetyHold"
  | "readSafetyHoldOfOutcome"
  | "readOutboxRowWritten"
  | "readBusinessOwner"
  | "readBusinessZone";

const notFound = (table: string, rowId: string): NotFoundError => ({ error: "notFound", table, rowId });

// ---- the requests' shape -------------------------------------------------------------------------------------------

/** The request's fields, refused unless it has exactly `fields`; names the field, never a value. */
function fieldsOf(request: unknown, call: SafetyRead, fields: readonly string[]): Record<string, unknown> {
  assertRequestShape(request, call, fields);
  const values = request as Record<string, unknown>;
  for (const field of fields) {
    if (!Object.hasOwn(values, field)) {
      throw new TypeError(`${call}: the request needs ${field}`);
    }
  }
  return values;
}

/**
 * Refuses a request that is not one row's key and the call's business, or null before there is one: always stated, so
 * no read runs with no scope by omission (STATE note 22; CQ-70; `refuse-safety-outcome-no-scope`).
 */
function checkKeyRequest(request: unknown, call: SafetyRead, key: string): void {
  const values = fieldsOf(request, call, [key, "businessId"]);
  assertId(values[key], key);
  if (values.businessId !== null) {
    assertId(values.businessId, "businessId");
    assertBusinessId(values.businessId);
  }
}

/**
 * Refuses a request that does not name one business: an owner and a zone are a business's, never null
 * (`refuse-business-owner-no-business`).
 */
function checkBusinessRequest(request: unknown, call: SafetyRead): void {
  const values = fieldsOf(request, call, ["businessId"]);
  if (values.businessId === null) {
    throw new TypeError(`${call}: the request names its business, never null`);
  }
  assertId(values.businessId, "businessId");
  assertBusinessId(values.businessId);
}

// ---- the side a read runs on ---------------------------------------------------------------------------------------

/**
 * Refuses a transaction on the wrong side (default 2): under the request's own business scope, or with no business no
 * scope at all.
 */
async function assertSide(db: Db, call: SafetyRead, businessId: string | null): Promise<void> {
  if (businessId === null) {
    if ((await readBusinessScope(db)) !== null) {
      throw new BusinessScopeError(
        `${call} with no business runs on the runtime side: a business scope hides the rows with none`,
      );
    }
    return;
  }
  if ((await requireBusinessScope(db)) !== businessId) {
    throw new BusinessScopeError(`${call} runs under the request's own business scope`);
  }
}

/**
 * Refuses a role that holds rosie_app's rights and not rosie_job's (default 1). rosie_job, and a role that holds
 * neither (the tables' owner), run.
 */
async function assertNotToolApiRole(db: Db, why: string): Promise<void> {
  const [rights] = await db<{ app: boolean; job: boolean }[]>`
    select pg_has_role(current_user, 'rosie_app', 'USAGE') as app,
           pg_has_role(current_user, 'rosie_job', 'USAGE') as job
  `;
  if (rights === undefined || (rights.app && !rights.job)) {
    throw new BusinessScopeError(why);
  }
}

/** With a business, the business found in its scope first, so none never means no such business (default 56). */
async function businessFound(db: Db, businessId: string): Promise<boolean> {
  const [business] = await db<{ id: string }[]>`select id from businesses where id = ${businessId}`;
  return business !== undefined;
}

/**
 * The opening of the five reads that take null (items 37 to 41): the side; then with no business the runtime role, and
 * with one the business found first. Answers notFound when the business is not there, else null.
 */
async function openRecordRead(
  db: Db,
  call: SafetyRead,
  businessId: string | null,
): Promise<NotFoundError | null> {
  await assertSide(db, call, businessId);
  if (businessId === null) {
    await assertNotToolApiRole(
      db,
      `${call} with no business runs on the runtime side, as rosie_job: rosie_app sees no row without a scope`,
    );
    return null;
  }
  return (await businessFound(db, businessId)) ? null : notFound("businesses", businessId);
}

/** The rows of the call's business, or with none the rows with no business, named in the read itself (item 37). */
function ofBusiness(db: Db, businessId: string | null) {
  return businessId === null ? db`business_id is null` : db`business_id = ${businessId}`;
}

/**
 * One read-only transaction at repeatable read on `sql`: on the runtime side (the scope cleared) with no business, else
 * under the business's scope, set first and still the same when the read ends. Transient errors are answered.
 */
async function inOwnTransaction<T>(
  sql: Sql,
  call: SafetyRead,
  businessId: string | null,
  read: (tx: Sql) => Promise<T>,
): Promise<T | TransientError> {
  try {
    return await inRuntimeTransaction(sql, { readOnly: true }, async (tx) => {
      if (businessId === null) {
        return read(tx);
      }
      await tx`select set_config(${SCOPE_SETTING}, ${businessId}, true)`;
      const outcome = await read(tx);
      if ((await requireBusinessScope(tx)) !== businessId) {
        throw new BusinessScopeError(`${call} must end under the business scope it began with`);
      }
      return outcome;
    });
  } catch (error) {
    // A statement's own refusal and postgres.js's statement errors leave scrubbed too: the read's name and the code
    // alone, never the statement's values (T-1322; clocks.ts transientOrScrubbed).
    return transientOrScrubbed(call, error);
  }
}

// ---- safety outcomes (items 37 and 38) -----------------------------------------------------------------------------

interface OutcomeRow {
  id: string;
  event_id: string;
  source: StoredOutcome["source"];
  handle_id: string | null;
  person_id: string | null;
  business_id: string | null;
  booking_id: string | null;
  turn_id: string | null;
  read_at: Date;
  timed_out: boolean;
  labels: StoredOutcome["labels"];
  tenses: StoredOutcome["tenses"];
  danger_word_kinds: StoredOutcome["dangerWordKinds"];
  outcomes: StoredOutcome["outcomes"];
  lifted_to_unsure: boolean;
}

const toOutcome = (row: OutcomeRow): StoredOutcome => ({
  id: row.id,
  eventId: row.event_id,
  source: row.source,
  handleId: row.handle_id,
  personId: row.person_id,
  businessId: row.business_id,
  bookingId: row.booking_id,
  turnId: row.turn_id,
  readAt: utc(row.read_at),
  timedOut: row.timed_out,
  labels: row.labels,
  tenses: row.tenses,
  dangerWordKinds: row.danger_word_kinds,
  outcomes: row.outcomes,
  liftedToUnsure: row.lifted_to_unsure,
});

/**
 * The safety_outcomes row `key` finds under the call's business, or null: the fifteen StoredOutcome columns alone, never
 * sealed_words, tries or danger_word_lists (item 37, default 60).
 */
async function outcomeWhere(
  db: Db,
  key: ReturnType<typeof ofBusiness>,
  businessId: string | null,
): Promise<StoredOutcome | null> {
  const [row] = await db<OutcomeRow[]>`
    select id, event_id, source, handle_id, person_id, business_id, booking_id, turn_id, read_at, timed_out, labels,
           tenses, danger_word_kinds, outcomes, lifted_to_unsure
    from safety_outcomes
    where ${key} and ${ofBusiness(db, businessId)}
  `;
  return row === undefined ? null : toOutcome(row);
}

/**
 * A text's safety record by its event id (K-05 v1.4 item 37), inside the transaction `db`, which must already run on the
 * request's side: under the request's business scope (as rosie_app, the Tool API's call transaction), or with businessId
 * null on the runtime side, with no scope, as rosie_job. Prefer it to readSafetyOutcomeOfEvent() inside the call's own
 * transaction, so the record reads what its commit then compares.
 */
export async function readSafetyOutcomeOfEventIn(
  db: Db,
  request: ReadSafetyOutcomeOfEventRequest,
  options: ReadOptions = {},
): Promise<ReadSafetyOutcomeOfEventResponse | NotFoundError> {
  checkKeyRequest(request, "readSafetyOutcomeOfEvent", "eventId");
  const { eventId, businessId } = request;
  const missing = await openRecordRead(db, "readSafetyOutcomeOfEvent", businessId);
  if (missing !== null) {
    return missing;
  }
  const readAt = await readMoment(db, options);
  return {
    result: "safetyOutcomeOfEvent",
    eventId,
    businessId,
    readAt: utc(readAt),
    safetyOutcome: await outcomeWhere(db, db`event_id = ${eventId}`, businessId),
  };
}

/**
 * A text's safety record by its event id (K-05 v1.4 item 37) in a read-only transaction of its own. Pass the Tool API's
 * client (rosie_app) with a business, the runtime's (rosie_job) with businessId null. notFound (table businesses) when
 * the business does not exist or its scope does not show it; transient on a serialization failure, a deadlock or a
 * lost connection. A request of the wrong shape throws a TypeError, a read on the wrong side a BusinessScopeError.
 */
export async function readSafetyOutcomeOfEvent(
  sql: Sql,
  request: ReadSafetyOutcomeOfEventRequest,
  options: ReadOptions = {},
): Promise<ReadSafetyOutcomeOfEventOutcome> {
  checkKeyRequest(request, "readSafetyOutcomeOfEvent", "eventId");
  return inOwnTransaction(sql, "readSafetyOutcomeOfEvent", request.businessId, (tx) =>
    readSafetyOutcomeOfEventIn(tx, request, options),
  );
}

/** A safety outcome by its id (K-05 v1.4 item 38), inside the transaction `db`, on the request's side as item 37's. */
export async function readSafetyOutcomeIn(
  db: Db,
  request: ReadSafetyOutcomeRequest,
  options: ReadOptions = {},
): Promise<ReadSafetyOutcomeResponse | NotFoundError> {
  checkKeyRequest(request, "readSafetyOutcome", "outcomeId");
  const { outcomeId, businessId } = request;
  const missing = await openRecordRead(db, "readSafetyOutcome", businessId);
  if (missing !== null) {
    return missing;
  }
  const readAt = await readMoment(db, options);
  return {
    result: "safetyOutcome",
    outcomeId,
    businessId,
    readAt: utc(readAt),
    safetyOutcome: await outcomeWhere(db, db`id = ${outcomeId}`, businessId),
  };
}

/** A safety outcome by its id (K-05 v1.4 item 38) in a read-only transaction of its own; clients and answers as item 37's. */
export async function readSafetyOutcome(
  sql: Sql,
  request: ReadSafetyOutcomeRequest,
  options: ReadOptions = {},
): Promise<ReadSafetyOutcomeOutcome> {
  checkKeyRequest(request, "readSafetyOutcome", "outcomeId");
  return inOwnTransaction(sql, "readSafetyOutcome", request.businessId, (tx) =>
    readSafetyOutcomeIn(tx, request, options),
  );
}

// ---- safety holds (items 39 and 40) --------------------------------------------------------------------------------

interface HoldRow {
  id: string;
  safety_outcome_id: string;
  business_id: string | null;
  handle_id: string;
  person_id: string | null;
  booking_id: string | null;
  turn_id: string | null;
  release_rule: StoredHold["releaseRule"];
  blocks_booking: boolean;
  held_at: Date;
  released_at: Date | null;
  released_why: StoredHold["releasedWhy"];
  released_by_turn_id: string | null;
  released_by_outcome_id: string | null;
  version: number;
}

const toHold = (row: HoldRow): StoredHold => ({
  id: row.id,
  safetyOutcomeId: row.safety_outcome_id,
  businessId: row.business_id,
  handleId: row.handle_id,
  personId: row.person_id,
  bookingId: row.booking_id,
  turnId: row.turn_id,
  releaseRule: row.release_rule,
  blocksBooking: row.blocks_booking,
  heldAt: utc(row.held_at),
  releasedAt: utcOrNull(row.released_at),
  releasedWhy: row.released_why,
  releasedByTurnId: row.released_by_turn_id,
  releasedByOutcomeId: row.released_by_outcome_id,
  version: row.version,
});

/** The safety_holds row `key` finds under the call's business, or null: all fifteen columns, none sealed (item 39). */
async function holdWhere(
  db: Db,
  key: ReturnType<typeof ofBusiness>,
  businessId: string | null,
): Promise<StoredHold | null> {
  const [row] = await db<HoldRow[]>`
    select id, safety_outcome_id, business_id, handle_id, person_id, booking_id, turn_id, release_rule, blocks_booking,
           held_at, released_at, released_why, released_by_turn_id, released_by_outcome_id, version
    from safety_holds
    where ${key} and ${ofBusiness(db, businessId)}
  `;
  return row === undefined ? null : toHold(row);
}

/**
 * A safety hold by its id (K-05 v1.4 item 39), open or released, with its version, inside the transaction `db`, on the
 * request's side as item 37's. Prefer it inside the release's own call transaction, whose commit compares the version.
 */
export async function readSafetyHoldIn(
  db: Db,
  request: ReadSafetyHoldRequest,
  options: ReadOptions = {},
): Promise<ReadSafetyHoldResponse | NotFoundError> {
  checkKeyRequest(request, "readSafetyHold", "holdId");
  const { holdId, businessId } = request;
  const missing = await openRecordRead(db, "readSafetyHold", businessId);
  if (missing !== null) {
    return missing;
  }
  const readAt = await readMoment(db, options);
  return {
    result: "safetyHold",
    holdId,
    businessId,
    readAt: utc(readAt),
    hold: await holdWhere(db, db`id = ${holdId}`, businessId),
  };
}

/** A safety hold by its id (K-05 v1.4 item 39) in a read-only transaction of its own; clients and answers as item 37's. */
export async function readSafetyHold(
  sql: Sql,
  request: ReadSafetyHoldRequest,
  options: ReadOptions = {},
): Promise<ReadSafetyHoldOutcome> {
  checkKeyRequest(request, "readSafetyHold", "holdId");
  return inOwnTransaction(sql, "readSafetyHold", request.businessId, (tx) =>
    readSafetyHoldIn(tx, request, options),
  );
}

/**
 * The one hold an outcome set (K-05 v1.4 item 40; K-34 safety_holds_one_per_outcome), open or released, or null when it
 * held nothing, inside the transaction `db`, on the request's side as item 37's.
 */
export async function readSafetyHoldOfOutcomeIn(
  db: Db,
  request: ReadSafetyHoldOfOutcomeRequest,
  options: ReadOptions = {},
): Promise<ReadSafetyHoldOfOutcomeResponse | NotFoundError> {
  checkKeyRequest(request, "readSafetyHoldOfOutcome", "outcomeId");
  const { outcomeId, businessId } = request;
  const missing = await openRecordRead(db, "readSafetyHoldOfOutcome", businessId);
  if (missing !== null) {
    return missing;
  }
  const readAt = await readMoment(db, options);
  return {
    result: "safetyHoldOfOutcome",
    outcomeId,
    businessId,
    readAt: utc(readAt),
    hold: await holdWhere(db, db`safety_outcome_id = ${outcomeId}`, businessId),
  };
}

/** The one hold an outcome set (K-05 v1.4 item 40) in a read-only transaction of its own; as item 37's. */
export async function readSafetyHoldOfOutcome(
  sql: Sql,
  request: ReadSafetyHoldOfOutcomeRequest,
  options: ReadOptions = {},
): Promise<ReadSafetyHoldOfOutcomeOutcome> {
  checkKeyRequest(request, "readSafetyHoldOfOutcome", "outcomeId");
  return inOwnTransaction(sql, "readSafetyHoldOfOutcome", request.businessId, (tx) =>
    readSafetyHoldOfOutcomeIn(tx, request, options),
  );
}

// ---- an outbox row written (item 41) -------------------------------------------------------------------------------

/**
 * Whether an outbox row with this id is written (K-05 v1.4 item 41), inside the transaction `db`, on the request's side
 * as item 37's. Only the row's id is read, never its plan or final parts (the message's words), nor any other column.
 */
export async function readOutboxRowWrittenIn(
  db: Db,
  request: ReadOutboxRowWrittenRequest,
  options: ReadOptions = {},
): Promise<ReadOutboxRowWrittenResponse | NotFoundError> {
  checkKeyRequest(request, "readOutboxRowWritten", "outboxRowId");
  const { outboxRowId, businessId } = request;
  const missing = await openRecordRead(db, "readOutboxRowWritten", businessId);
  if (missing !== null) {
    return missing;
  }
  const readAt = await readMoment(db, options);
  const [row] = await db<{ id: string }[]>`
    select id from outbox_rows where id = ${outboxRowId} and ${ofBusiness(db, businessId)}
  `;
  return {
    result: "outboxRowWritten",
    outboxRowId,
    businessId,
    readAt: utc(readAt),
    written: row !== undefined,
  };
}

/** Whether an outbox row is written (K-05 v1.4 item 41) in a read-only transaction of its own; as item 37's. */
export async function readOutboxRowWritten(
  sql: Sql,
  request: ReadOutboxRowWrittenRequest,
  options: ReadOptions = {},
): Promise<ReadOutboxRowWrittenOutcome> {
  checkKeyRequest(request, "readOutboxRowWritten", "outboxRowId");
  return inOwnTransaction(sql, "readOutboxRowWritten", request.businessId, (tx) =>
    readOutboxRowWrittenIn(tx, request, options),
  );
}

// ---- the business's owner (item 42) --------------------------------------------------------------------------------

/**
 * The business's owner and the handle they write from (K-05 v1.4 item 42), inside the transaction `db`, which must run
 * as rosie_job under the request's business scope (confirmed here by requireBusinessScope() before the first read).
 * The owner is the business's one live owner role (role owner, ended_at null): none answers owner null, and more than
 * one answers moreThanOneOwner and nothing else, never one of them (default 58). The handle is the owner's first phone
 * handle, else their first email handle, each in handle id order byte by byte (default 59); with none, owner null.
 * Of handles only id and kind are read, never the address.
 */
export async function readBusinessOwnerIn(
  db: Db,
  request: ReadBusinessOwnerRequest,
  options: ReadOptions = {},
): Promise<ReadBusinessOwnerResponse | NotFoundError | MoreThanOneOwnerError> {
  checkBusinessRequest(request, "readBusinessOwner");
  const { businessId } = request;
  await assertSide(db, "readBusinessOwner", businessId);
  await assertNotToolApiRole(
    db,
    "readBusinessOwner runs as rosie_job: rosie_app holds no grant on person_handles or handles",
  );
  if (!(await businessFound(db, businessId))) {
    return notFound("businesses", businessId);
  }
  const readAt = await readMoment(db, options);
  // Two rows are enough to tell one owner from more than one.
  const owners = await db<{ id: string; person_id: string }[]>`
    select id, person_id
    from person_roles
    where business_id = ${businessId} and role = 'owner' and ended_at is null
    order by id collate "C"
    limit 2
  `;
  if (owners.length > 1) {
    return { error: "moreThanOneOwner", businessId };
  }
  let owner: OwnerContact | null = null;
  const [role] = owners;
  if (role !== undefined) {
    const handles = await db<{ id: string; kind: string }[]>`
      select handles.id, handles.kind
      from person_handles
      join handles on handles.id = person_handles.handle_id
      where person_handles.person_id = ${role.person_id}
      order by handles.id collate "C"
    `;
    const handle = handles.find((row) => row.kind === "phone") ?? handles.find((row) => row.kind === "email");
    owner = handle === undefined ? null : { personId: role.person_id, handleId: handle.id };
  }
  return { result: "businessOwner", businessId, readAt: utc(readAt), owner };
}

/**
 * The business's owner and the handle they write from (K-05 v1.4 item 42) in a read-only transaction of its own. Pass
 * the runtime's client (rosie_job): the business's scope is set, and confirmed before the first read. notFound when the
 * business does not exist; moreThanOneOwner; transient. A request with no business throws a TypeError, a read on the
 * wrong side or role a BusinessScopeError.
 */
export async function readBusinessOwner(
  sql: Sql,
  request: ReadBusinessOwnerRequest,
  options: ReadOptions = {},
): Promise<ReadBusinessOwnerOutcome> {
  checkBusinessRequest(request, "readBusinessOwner");
  return inOwnTransaction(sql, "readBusinessOwner", request.businessId, (tx) =>
    readBusinessOwnerIn(tx, request, options),
  );
}

// ---- the business's zone (item 43) ---------------------------------------------------------------------------------

/**
 * The business's time zone (K-05 v1.4 item 43), inside the transaction `db`, which must run under the request's business
 * scope (as rosie_app, the Tool API's call transaction). Reading the business row finds the business first: a business
 * the scope does not show answers notFound, never a null zone (K-04 keeps every business's zone).
 */
export async function readBusinessZoneIn(
  db: Db,
  request: ReadBusinessZoneRequest,
  options: ReadOptions = {},
): Promise<ReadBusinessZoneResponse | NotFoundError> {
  checkBusinessRequest(request, "readBusinessZone");
  const { businessId } = request;
  await assertSide(db, "readBusinessZone", businessId);
  const [business] = await db<{ time_zone: string }[]>`
    select time_zone from businesses where id = ${businessId}
  `;
  if (business === undefined) {
    return notFound("businesses", businessId);
  }
  const readAt = await readMoment(db, options);
  return { result: "businessZone", businessId, readAt: utc(readAt), timeZone: business.time_zone };
}

/**
 * The business's time zone (K-05 v1.4 item 43) in a read-only transaction of its own. Pass the Tool API's client
 * (rosie_app): the business's scope is set first. notFound when the scope does not show the business; transient.
 */
export async function readBusinessZone(
  sql: Sql,
  request: ReadBusinessZoneRequest,
  options: ReadOptions = {},
): Promise<ReadBusinessZoneOutcome> {
  checkBusinessRequest(request, "readBusinessZone");
  return inOwnTransaction(sql, "readBusinessZone", request.businessId, (tx) =>
    readBusinessZoneIn(tx, request, options),
  );
}
