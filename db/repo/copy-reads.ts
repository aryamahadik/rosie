// Data-access v1.12: the handle actor's two copy sources (K-05 v1.12 items 56 and 57; T-1301, the D-017 path audit's D4;
// DL-498, DL-542). Their caller is the handle actor's copies (C-046 the actor, C-053 its copies: runtime/src/actor/copies
// copies.ts, its timers' reload and its stopped flag's re-read), through setCopyDeps's two sources
// (runtime/src/actor/copies/types.ts CopyDeps.timers, a SafetyTimerSource, and CopyDeps.phones, a StoppedFlagSource),
// which the runtime engineer's own card binds for staging (the audit's P6c).
//
//   readLiveTimers   the reload of a handle's live safety timers (item 56; K-34 v1 safety_timers_worker_live_idx: "the
//                    actor reloads its copies"): K-34 safety_timers whose worker_handle_id is the request's handle and
//                    whose state is running or missed (a missed check stays open until SAFE: S13-10), at every
//                    business, earliest due_at first, a tie to the lower id (ids compared byte by byte, collate "C":
//                    CQ-09). Each timer is answered with the thirteen columns the copy keeps (SafetyTimerRow), state
//                    included, each named in K-05's form for its K-34 column (liveTimer). The address is sealed under
//                    address_for_person_id's key (K-34 rule 6): it is answered as stored, in PostgreSQL's hex text form,
//                    a backslash, x and two lower-case hex digits a byte, whose digits PostgreSQL writes itself
//                    (encode(address, 'hex')) and this file only puts after the backslash and x, so it is never opened,
//                    decoded or put in plain words on the way (default 110). None is an empty list, an answer.
//   readStoppedFlag  the re-read of a handle's stopped flag after a commit whose answer was lost (item 57; T-1206;
//                    DL-427): K-04 phones by handle_id (phones_handle_key), stopped and version alone, the version the
//                    copy orders its writes by. No row (an email handle, or a phone whose first text has not come)
//                    answers notFound (table phones, the request's handle id as its row id), never "not stopped": the
//                    port has no answer for none, so the copy keeps the stricter reading (default 111).
//
// Role and scope (items 56 and 57; README v1.12 "Why rosie_job", "Why no business scope"; K-04 v1 rule 4: the jobs that
// work across businesses by handle). Each read runs on the client it is handed, the runtime side's, as rosie_job (the role
// is the connection's), in one read-only transaction at repeatable read on the primary, uncached, begun when the call is
// made (targets.ts inRuntimeTransaction, which sets the business scope empty for the transaction, so a scope a connection
// kept never narrows it), so each answer is one moment's, fresh for every write committed before the call, and nothing is
// written. Neither uses a definer function or a table owner's rights: rosie_job reads every business's safety_timers
// behind 0016's runtime policy, and phones through its own grant (0012). One business's scope would hide another's timers
// and empty the copy of a live one (default 110), so readLiveTimers names no business and sets none. rosie_app, the Tool
// API's role, holds no grant on phones (0012), so its readStoppedFlag is refused by privilege (42501, thrown as
// DataAccessDatabaseError); it does hold SELECT on safety_timers, behind a policy that shows it no row without a scope, so
// its reload would answer "no live timer" whatever is live: readLiveTimers refuses to run on a role that holds rosie_app's
// rights and not rosie_job's (default 2).
//
// What they read (README v1.12 "What the new tasks must hold to"). Each statement that reads a table reads one, joins none
// and selects no `*` and no whole row: readLiveTimers item 56's thirteen columns of safety_timers, the address as its hex
// digits, finding the rows by worker_handle_id and state; readStoppedFlag phones.stopped and version alone, finding the
// row by handle_id. No statement names a column of sealing_keys, messages, consents or proof_codes, nor a phone's number,
// and the handle's id is each table read's one parameter. The integration test reads every statement both reads send and
// checks it.
//
// Errors (K-05 README: every call may answer transient). A serialization failure, a deadlock or a lost connection answers
// transient, with only its SQLSTATE. Any other database error is thrown scrubbed, as DataAccessDatabaseError with its
// SQLSTATE and names alone (clocks.ts transientOrScrubbed: PostgreSQL's own error can hold a row's values). A request of
// the wrong shape throws a TypeError before any statement is sent, a role that would see no timer a BusinessScopeError,
// and a record the answer would have to guess around a BrokenRecordError (default 3); each names the call, a field or a
// rule, never a value or an id. The copies read each as a failed read: the reload keeps the copy as it was and marks it
// stale, and the re-read keeps the stricter reading (copies.ts). Nothing here logs, and nothing is written on any of them.
//
// Defaults used (for ops/QUESTIONS.md; each where no source decides):
//   1. The request's handleId is a K-08 safe id that never reads as a number, as the answer's handleRef is (arming-reads.ts
//      default 3; chat-open.ts): a number or an address passed as the id is refused before any statement, so no request
//      carries one and every answer's handleId is a valid handleRef. A number in a field of its own
//      (refuse-stopped-flag-by-number) or a business beside the handle (refuse-live-timers-business-scope) is refused by
//      the request's shape: the request names the handle alone.
//   2. readLiveTimers refuses a role that holds rosie_app's rights and not rosie_job's (BusinessScopeError, read by rights,
//      pg_has_role USAGE, as ADR-014 has db/repo's role checks read them), as readOpenHolds with no business does
//      (turn-face-reads.ts; the database engineer's note 4 on T-1137): rosie_app sees no timer without a scope, and an
//      empty list would empty the copy of a live timer. rosie_job, and a role row-level security does not bind, see every
//      timer. readStoppedFlag needs no such check: rosie_app holds no grant on phones, so its read is refused (42501).
//   3. A live timer whose stored address is no bytes throws BrokenRecordError and nothing is answered (turn-face-reads.ts
//      default 2's rule: fail closed rather than answer half): K-05's sealedBytes holds at least one byte, and a list
//      without that timer would empty the copy of a live one. K-34 holds the column not null, and a sealed value always
//      holds bytes (db/repo/sealing.ts), so only a broken write meets this.
import type * as K05 from "../../contracts/generated/data-access/data-access.v1.12";
import { transientOrScrubbed } from "./clocks";
import { BusinessScopeError, type Sql } from "./scope";
import { assertRequestShape, inRuntimeTransaction, utc } from "./targets";
import { BrokenRecordError } from "./turn-face-reads";

// ---- the requests and the answers (data-access.v1.12.schema.json) ---------------------------------------------------

/** K-05 v1.12 readLiveTimers.request: the actor's handle alone, never a business. */
export type ReadLiveTimersRequest = K05.ReadLiveTimersRequest;
/** K-05 v1.12 readLiveTimers.response: the handle's live timers, earliest due first; none is an empty list. */
export type ReadLiveTimersResponse = K05.ReadLiveTimersResponse;
/** K-05 v1.12 liveTimer: one live timer's thirteen columns, as the copy keeps them, the address sealed as stored. */
export type LiveTimer = K05.LiveTimer;
/** K-05 v1.12 readLiveTimers.errors: transient alone. */
export type ReadLiveTimersError = K05.ReadLiveTimersErrors;
export type ReadLiveTimersOutcome = ReadLiveTimersResponse | ReadLiveTimersError;

/** K-05 v1.12 readStoppedFlag.request: the actor's handle alone, never a number. */
export type ReadStoppedFlagRequest = K05.ReadStoppedFlagRequest;
/** K-05 v1.12 readStoppedFlag.response: the handle's phone row's stopped flag and version. */
export type ReadStoppedFlagResponse = K05.ReadStoppedFlagResponse;
/** K-05 v1.12 phoneNotFoundError: no phone row for the handle (table phones); never read as not stopped. */
export type PhoneNotFoundError = K05.PhoneNotFoundError;
/** K-05 v1.12 readStoppedFlag.errors: notFound (table phones) or transient. */
export type ReadStoppedFlagError = K05.ReadStoppedFlagErrors;
export type ReadStoppedFlagOutcome = ReadStoppedFlagResponse | ReadStoppedFlagError;

const LIVE_TIMERS = "readLiveTimers";
const STOPPED_FLAG = "readStoppedFlag";
/** K-08 v1 safeId: letters, digits and _ . : / # -, starting with a letter or digit. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/#-]*$/;
/** K-08 v1 safeId's refusal: a run of digits and phone punctuation, seven or more long, reads as a number. */
const READS_AS_NUMBER = /^[0-9().+ -]{7,}$/;
/** What encode(address, 'hex') gives a sealed value: two lower-case hex digits a byte, one byte at least (sealedBytes). */
const HEX_DIGITS = /^(?:[0-9a-f]{2})+$/;

// ---- the requests' shape (default 1) --------------------------------------------------------------------------------

/**
 * The request's handle: the request names it alone, as a K-04 handle id that is a K-08 safe id, never a number or an
 * address (default 1). A TypeError before any statement otherwise, naming the field, never a value.
 */
function handleIdOf(request: unknown, call: string): string {
  assertRequestShape(request, call, ["handleId"]);
  const values = request as Record<string, unknown>;
  if (!Object.hasOwn(values, "handleId")) {
    throw new TypeError(`${call}: the request needs handleId`);
  }
  const { handleId } = values;
  if (typeof handleId !== "string" || !SAFE_ID.test(handleId) || READS_AS_NUMBER.test(handleId)) {
    throw new TypeError(
      `${call}: handleId is a K-04 handle id (a K-08 safe id), never a number or an address`,
    );
  }
  return handleId;
}

// ---- readLiveTimers (item 56) ---------------------------------------------------------------------------------------

/** Item 56's thirteen columns as the read takes them: the address as PostgreSQL's hex digits of the stored bytes. */
interface TimerRow {
  id: string;
  business_id: string;
  booking_id: string | null;
  worker_handle_id: string;
  emergency_contact_person_id: string;
  emergency_contact_handle_id: string;
  due_at: Date;
  due_zone: string;
  address_hex: string;
  address_for_person_id: string;
  clock_row_id: string;
  state: LiveTimer["state"];
  version: number;
}

/**
 * Refuses a role that holds rosie_app's rights and not rosie_job's (default 2): with no scope it sees no timer, so the
 * reload would answer none whatever is live. Reads PostgreSQL's own function, no table.
 */
async function assertTimersRole(tx: Sql): Promise<void> {
  const [rights] = await tx<{ app: boolean; job: boolean }[]>`
    select pg_has_role(current_user, 'rosie_app', 'USAGE') as app,
           pg_has_role(current_user, 'rosie_job', 'USAGE') as job
  `;
  if (rights === undefined || (rights.app && !rights.job)) {
    throw new BusinessScopeError(
      `${LIVE_TIMERS} runs on the runtime side, as rosie_job: rosie_app sees no timer without a business scope`,
    );
  }
}

/**
 * One live timer in K-05's names (liveTimer), the address in PostgreSQL's hex text form, the stored bytes' own digits
 * after a backslash and x, never opened or decoded (default 110). A stored address that is no bytes is a broken record
 * (default 3).
 */
function liveTimerOf(row: TimerRow): LiveTimer {
  if (!HEX_DIGITS.test(row.address_hex)) {
    throw new BrokenRecordError(`${LIVE_TIMERS}: a live timer's sealed address holds no bytes`);
  }
  return {
    id: row.id,
    businessId: row.business_id,
    bookingId: row.booking_id,
    workerHandleId: row.worker_handle_id,
    emergencyContactPersonId: row.emergency_contact_person_id,
    emergencyContactHandleId: row.emergency_contact_handle_id,
    dueAt: utc(row.due_at),
    dueZone: row.due_zone,
    address: `\\x${row.address_hex}`,
    addressForPersonId: row.address_for_person_id,
    clockRowId: row.clock_row_id,
    state: row.state,
    version: row.version,
  };
}

/**
 * The handle's live timers inside the read's own transaction, on the runtime side: running or missed, every business's,
 * earliest due first, a tie to the lower id byte by byte (safety_timers_worker_live_idx's rows).
 */
async function liveTimersIn(tx: Sql, handleId: string): Promise<ReadLiveTimersResponse> {
  await assertTimersRole(tx);
  const rows = await tx<TimerRow[]>`
    select id, business_id, booking_id, worker_handle_id, emergency_contact_person_id, emergency_contact_handle_id,
           due_at, due_zone, encode(address, 'hex') as address_hex, address_for_person_id, clock_row_id, state, version
    from safety_timers
    where worker_handle_id = ${handleId} and state in ('running', 'missed')
    order by due_at, id collate "C"
  `;
  return { handleId, timers: rows.map(liveTimerOf) };
}

/**
 * The reload of a handle's live safety timers for its actor's copy (K-05 v1.12 item 56): K-34's running and missed timers
 * whose pro writes from the handle, at every business, earliest due_at first, a tie to the lower id, each with the
 * thirteen columns the copy keeps, the sealed address as stored in PostgreSQL's hex text form, never opened; none is an
 * empty list. One read-only transaction at repeatable read on the primary, uncached, with no business scope, writing
 * nothing. Pass the runtime side's client (rosie_job): the role is the connection's. transient on a serialization
 * failure, a deadlock or a lost connection. Throws a TypeError for a request of the wrong shape, a BusinessScopeError on
 * a role that holds rosie_app's rights and not rosie_job's (default 2), a BrokenRecordError for a timer it would have to
 * guess around (default 3), and any other database error scrubbed (DataAccessDatabaseError); nothing is written on any of
 * them. The address is a person's sealed address: never log it or put it in an error.
 */
export async function readLiveTimers(
  sql: Sql,
  request: ReadLiveTimersRequest,
): Promise<ReadLiveTimersOutcome> {
  const handleId = handleIdOf(request, LIVE_TIMERS);
  try {
    return await inRuntimeTransaction(sql, { readOnly: true }, (tx) => liveTimersIn(tx, handleId));
  } catch (error) {
    return transientOrScrubbed(LIVE_TIMERS, error);
  }
}

// ---- readStoppedFlag (item 57) --------------------------------------------------------------------------------------

/** The handle's phone row inside the read's own transaction: stopped and version alone, or notFound (default 111). */
async function stoppedFlagIn(
  tx: Sql,
  handleId: string,
): Promise<ReadStoppedFlagResponse | PhoneNotFoundError> {
  const [phone] = await tx<{ stopped: boolean; version: number }[]>`
    select stopped, version from phones where handle_id = ${handleId}
  `;
  if (phone === undefined) {
    return { error: "notFound", table: "phones", rowId: handleId };
  }
  return { handleId, stopped: phone.stopped, phoneVersion: phone.version };
}

/**
 * The re-read of a handle's stopped flag for its actor's copy (K-05 v1.12 item 57): the handle's K-04 phone row's stopped
 * flag and version, read fresh in a transaction of its own begun when the call is made, on the client it is handed, never
 * a cache; notFound (table phones) when the handle has no phone row, which the copy reads as a failed re-read, never as
 * not stopped. One read-only transaction at repeatable read on the primary, uncached, with no business scope, writing
 * nothing. Pass the runtime side's client (rosie_job): the role is the connection's. transient on a serialization
 * failure, a deadlock or a lost connection. Throws a TypeError for a request of the wrong shape, and any other database
 * error scrubbed (DataAccessDatabaseError: the Tool API's role meets 42501, since it holds no grant on phones); nothing is
 * written on any of them.
 */
export async function readStoppedFlag(
  sql: Sql,
  request: ReadStoppedFlagRequest,
): Promise<ReadStoppedFlagOutcome> {
  const handleId = handleIdOf(request, STOPPED_FLAG);
  try {
    return await inRuntimeTransaction(sql, { readOnly: true }, (tx) => stoppedFlagIn(tx, handleId));
  } catch (error) {
    return transientOrScrubbed(STOPPED_FLAG, error);
  }
}
