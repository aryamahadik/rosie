// Data-access v1.2: a handle's targets, the guard's read (K-05 v1.2 item 27; QUESTIONS.md NQ-RT-2; T-220).
//
// handleTargets lists, across every business, what a text from one handle may be about (arch 02 line 115: "It then
// lists the handle's roles, open questions and bookings"):
//   persons        the handle's people (one handle can be several people: arch 01 line 55), in id order, each with
//                  its live roles (person_roles, ended_at null) in business id order, then role;
//   openQuestions  every live open question sent to the handle (status waiting or open: open_questions_handle_live_idx),
//                  every business's, in id order, with its options as sent, the versions it was decided on, when it
//                  went out and the poll it went out as (below);
//   bookings       the bookings its people booked or are served by (bookings_booker_idx, bookings_served_idx), in
//                  every stage (the stage picks the hub: arch 03 line 163), every business's, in id order;
//   phone          the phone's stopped and chat flags, or null for an email handle or a number with no phone row yet.
// Every list empty is the doors (arch 03 line 165). The guard maps the answer to the K-09 draft's guardTargets (C-051,
// T-556). A payer or a worker who is neither booker nor served is not listed (K-05 open gap 23).
//
// When an open question went out (K-05 v1.2 item 26, default 41): only the outbox rows that ask it and go to its own
// handle count, so an email copy to another handle never does, and only their parts that have gone, sent or delivered,
// never pending and never once failed (K-07 v1's part states). A part went at its sent_at, or at its delivered_at when
// Linq's acceptance was never recorded (a 4001 or 4006 that delivered anyway: item 31). sentAt is the latest such time,
// and pollId the Linq message id of the latest such part of kind poll, so a poll that failed after Linq accepted it gives
// none, since its options go again typed (K-07 outbox-poll-failed-plain).
//
// Side (K-05 v1.2 README "Scope" and line 153; K-04 v1 rule 4): the runtime side, run by rosie_job with no business
// scope (T-191: the guard's role, the only one that reads phones and handles), so every business's rows are seen, and
// each row names its business for the reads that follow under that business's scope (default 25). Under a business
// scope the call refuses to run: row-level security would hide the other businesses' targets, and the guard would offer
// the doors where there are targets.
//
// Reads (arch 10 lines 504, 538): the primary, uncached, in one read-only transaction at repeatable read, so every list
// is one moment's. Ids are compared byte by byte (collate "C"), never parsed (CQ-09). A serialization failure, a
// deadlock or a lost connection answers transient: the same request may be sent again. Nothing here logs: addresses and
// ids of people are personal data.
//
// This file also holds the runtime side's one transaction and its transient answer, which send-state.ts and
// handle-keys.ts use too (the same rules as bundles.ts's, whose helpers are not exported).
import { isLostConnection, reserveConnection } from "./bundles";
import { scrubbed, transientOrScrubbed } from "./clocks";
import { readBusinessScope, SCOPE_SETTING, type Sql, type Tx } from "./scope";

type Db = Sql | Tx;

// ---- shared by the three v1.2 calls of T-220 ------------------------------------------------------------------------

/** The `transient` answer every K-05 call may give (data-access.v1.schema.json transientError). */
export interface TransientError {
  error: "transient";
  sqlstate: string;
}

/** K-05's notFound: the row does not exist (on the runtime side no scope hides one). */
export interface NotFoundError {
  error: "notFound";
  table: string;
  rowId: string;
}

/** Options of a read: the moment it is read at, for the test's fake clock (K-05 `given.now`). */
export interface ReadOptions {
  /** Default: the transaction's now() on the database. */
  now?: Date;
}

/** A serialization failure, a deadlock, and a server that shut down or dropped this backend (57P01 to 57P03). */
const TRANSIENT_SQLSTATES = new Set(["40001", "40P01", "57P01", "57P02", "57P03"]);
/** postgres.js's own codes for a connection that is gone, which carry no SQLSTATE: they answer 08006. */
const LOST_CONNECTION_CODES = new Set([
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECTION_ENDED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
]);
const LOST_CONNECTION_SQLSTATE = "08006";
/**
 * The codes of a connection that never opened (T-1268), which carry no SQLSTATE either: postgres.js's own
 * CONNECT_TIMEOUT (no answer to the startup within connect_timeout), and the socket's own for an address that refused
 * the connection, could not be reached or could not be resolved. No statement went out on such a connection, so nothing
 * was written and the same request may be sent again: they answer 08001 (sqlclient_unable_to_establish_sqlconnection).
 */
const NEVER_CONNECTED_CODES = new Set([
  "CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EHOSTDOWN",
  "ENETDOWN",
  "EADDRNOTAVAIL",
  "ENOTFOUND",
]);
/** Every other failure of the name lookup (getaddrinfo: EAI_AGAIN, EAI_FAIL, ...): no address, so no connect was tried. */
const NAME_LOOKUP_FAILED = /^EAI_[A-Z]+$/;
const NEVER_CONNECTED_SQLSTATE = "08001";
/**
 * JavaScript's own errors for a value or a program at fault. postgres.js rejects a statement with one when it cannot
 * build the statement or read its rows (a value it cannot send), never when its socket fails.
 */
const FAULT_NAMES = new Set([
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
]);
/**
 * PostgreSQL's refusals of a session at its start, whose message names the host, the user or the role (T-1268 round 2;
 * PostgreSQL's errcodes.txt, with the backend's messages): class 28, invalid authorization (28000
 * invalid_authorization_specification: "no pg_hba.conf entry for host ..., user ...", "role ... does not exist"; 28P01
 * invalid_password: "password authentication failed for user ..."), and 53300 too_many_connections ("too many
 * connections for role ...", "sorry, too many clients already"). Not transient: a retry cannot mend a refused login, and
 * 53300 is CQ-271's (until the architect rules, scrubbed and not transient).
 */
const SESSION_REFUSED_SQLSTATE = /^(28[0-9A-Z]{3}|53300)$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;
/**
 * A client's own codes for a connect or a session that failed and is not answered transient (T-1268 round 2):
 *   - Node's socket: EACCES and EPERM, a connect the system did not permit; ECONNABORTED, one it gave up;
 *   - postgres.js 3.4.9's own (connection.js): SASL_SIGNATURE_MISMATCH, a server whose SCRAM signature is wrong (its
 *     authentication), and MESSAGE_NOT_SUPPORTED, a protocol message it cannot read (NegotiateProtocolVersion at the
 *     session's start); its connection codes (CONNECT_TIMEOUT, CONNECTION_CLOSED, CONNECTION_DESTROYED,
 *     CONNECTION_ENDED) are answered transient above;
 *   - Node's certificate checks, by OpenSSL's X509_V_ERR_ names as Node's TLS gives them (a certificate not trusted,
 *     expired, revoked or not for this host), OUT_OF_MEM among them (X509_V_ERR_OUT_OF_MEM, 17, in the OpenSSL headers
 *     Node 24.12.0 installs), and UNSPECIFIED, the code Node gives a verify error it does not list (T-1268 round 3):
 *     Node's X509ErrorCode starts from "UNSPECIFIED" and names only the codes it lists, so a newer OpenSSL check
 *     (X509_V_ERR_UNABLE_TO_GET_CRL_ISSUER, 33, and the others) comes up as UNSPECIFIED, with no mark of a connection.
 */
const SESSION_FAILED_CODES = new Set([
  "EACCES",
  "EPERM",
  "ECONNABORTED",
  "SASL_SIGNATURE_MISMATCH",
  "MESSAGE_NOT_SUPPORTED",
  "UNSPECIFIED",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_CRL",
  "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "UNABLE_TO_DECRYPT_CRL_SIGNATURE",
  "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
  "CERT_SIGNATURE_FAILURE",
  "CRL_SIGNATURE_FAILURE",
  "CERT_NOT_YET_VALID",
  "CERT_HAS_EXPIRED",
  "CRL_NOT_YET_VALID",
  "CRL_HAS_EXPIRED",
  "ERROR_IN_CERT_NOT_BEFORE_FIELD",
  "ERROR_IN_CERT_NOT_AFTER_FIELD",
  "ERROR_IN_CRL_LAST_UPDATE_FIELD",
  "ERROR_IN_CRL_NEXT_UPDATE_FIELD",
  "OUT_OF_MEM",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_CHAIN_TOO_LONG",
  "CERT_REVOKED",
  "INVALID_CA",
  "PATH_LENGTH_EXCEEDED",
  "INVALID_PURPOSE",
  "CERT_UNTRUSTED",
  "CERT_REJECTED",
  "HOSTNAME_MISMATCH",
]);
/** Node's TLS errors (ERR_TLS_CERT_ALTNAME_INVALID, its host and certificate on it, and the others) and OpenSSL's. */
const TLS_CODE = /^ERR_(TLS|SSL)_[A-Z0-9_]+$/;
/**
 * An error's own marks of a connection: its address, port, host name or certificate (Node's socket, name lookup and TLS
 * errors; postgres.js's connection errors), one error per address (errors), or Node's mark of a system error (syscall,
 * errno). db/repo's own errors and PostgreSQL's refusals carry none.
 */
const CONNECTION_MARKS = ["address", "port", "hostname", "host", "cert", "errors", "syscall", "errno"];
/** The name a scrubbed error carries when its caller names no call. */
const UNNAMED_CALL = "a db/repo call";

/**
 * A failure to open or keep a session that is not answered transient, and that transientOrThrow (and clocks.ts's
 * scrubbed) therefore throws scrubbed (T-1268 round 2): PostgreSQL's refusal of a session at its start
 * (SESSION_REFUSED_SQLSTATE), or a PostgresError with no SQLSTATE, which cannot be told apart from one; a client's error
 * with a code of SESSION_FAILED_CODES or TLS_CODE, or with a mark of a connection (CONNECTION_MARKS). Never db/repo's
 * own errors, a statement's own refusal of any other SQLSTATE, or one of JavaScript's own for a faulty value.
 */
export function isSessionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (error.name === "PostgresError") {
    return typeof code !== "string" || !SQLSTATE.test(code) || SESSION_REFUSED_SQLSTATE.test(code);
  }
  if (FAULT_NAMES.has(error.name)) {
    return false;
  }
  if (typeof code === "string" && (SESSION_FAILED_CODES.has(code) || TLS_CODE.test(code))) {
    return true;
  }
  return CONNECTION_MARKS.some((mark) => Object.hasOwn(error, mark));
}

/**
 * The transient answer for a serialization failure, a deadlock, a lost connection or a connection that never opened
 * (K-05 README: nothing was written, the same request may be sent again); any other error is thrown. The answer carries
 * only a SQLSTATE, never the error's message, host, port, user, statement or parameters (T-1268).
 *
 * A socket error with no code is a lost connection too (08006): postgres.js's Workers build passes its socket's failure
 * up as the socket gives it, with no code, and rejects the statement in flight with it, putting that statement on it as
 * own properties (query and parameters, empty for a statement it never built; args, its values).
 *
 * A failure to open or keep a session that is not transient (isSessionFailure: EACCES, a TLS or certificate error,
 * postgres.js's SASL_SIGNATURE_MISMATCH, PostgreSQL's class 28 and 53300) is thrown scrubbed, never as it is (T-1268
 * round 2): clocks.ts's scrubbed, with `call`, the K-05 call's name, and the code alone (a PostgresError as
 * DataAccessDatabaseError, any other as a new Error with no message, stack, cause or property of the original's). Every
 * other error is thrown as it is: db/repo's own, a statement's own refusal of any other SQLSTATE, and JavaScript's own
 * for a faulty value (postgres.js could not build or read a statement).
 */
export function transientOrThrow(error: unknown, call: string = UNNAMED_CALL): TransientError {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string") {
    if (TRANSIENT_SQLSTATES.has(code) || /^08[0-9A-Z]{3}$/.test(code)) {
      return { error: "transient", sqlstate: code };
    }
    if (LOST_CONNECTION_CODES.has(code)) {
      return { error: "transient", sqlstate: LOST_CONNECTION_SQLSTATE };
    }
    if (NEVER_CONNECTED_CODES.has(code) || NAME_LOOKUP_FAILED.test(code)) {
      return { error: "transient", sqlstate: NEVER_CONNECTED_SQLSTATE };
    }
  } else if (
    error instanceof Error &&
    error.name !== "PostgresError" &&
    !FAULT_NAMES.has(error.name) &&
    (Object.hasOwn(error, "query") || Object.hasOwn(error, "parameters"))
  ) {
    return { error: "transient", sqlstate: LOST_CONNECTION_SQLSTATE };
  }
  if (isSessionFailure(error)) {
    throw scrubbed(call, error);
  }
  throw error;
}

/**
 * True when an error inRuntimeTransaction meets says its connection is gone (DL-649, T-1330's finding a), so no rollback
 * is written to it and it is never released: postgres.js 3.4.9 writes a statement on a connection whose socket has
 * closed to no socket at all, from a timer, which throws outside any promise, and the statement never settles. Gone is
 * isLostConnection's rule as T-1314 left it (bundles.ts: a lost connection's code, ECONNABORTED among them, 08xxx, 57P01
 * to 57P03, or a socket's failure with no code on a statement), and a statement's failure that is a session's failure
 * (isSessionFailure: a TLS or certificate error, EACCES, PostgreSQL's class 28 and 53300, a client's error with a
 * connection's marks) or that transientOrThrow answers 08001 (NEVER_CONNECTED_CODES, a name lookup's failure). A
 * statement's failure is one postgres.js rejected a statement with: its queryError puts the statement on it (query and
 * parameters, own properties). An error fn makes itself, on no statement, found no connection gone, whatever its code:
 * its connection is still open, so it is rolled back and released as before.
 */
function foundGone(error: unknown): boolean {
  if (isLostConnection(error)) {
    return true;
  }
  if (!(error instanceof Error) || !(Object.hasOwn(error, "query") || Object.hasOwn(error, "parameters"))) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return (
    isSessionFailure(error) ||
    (typeof code === "string" && (NEVER_CONNECTED_CODES.has(code) || NAME_LOOKUP_FAILED.test(code)))
  );
}

/**
 * One transaction of the runtime side (K-05 "Scope": runtime) on one reserved connection of `sql`, the primary: a
 * read-only one at repeatable read (`readOnly`, every read one moment), or a read committed one that writes. The
 * business scope is cleared at its start ('' reads as none, as an unset scope does), so a setting a connection kept
 * never narrows it. As bundles.ts's: a connection found gone (foundGone) is rethrown without a rollback (the server
 * rolled the transaction back when the backend went) and is never released, and the stale error a killed connection
 * keeps is taken first by an ordinary query. The connection is reserved through bundles.ts's reserveConnection (T-1334),
 * so a reserve() that never connects leaves as a connection that never opened, the code 08001 alone, which
 * transientOrThrow answers transient, never as postgres.js raises it.
 */
export async function inRuntimeTransaction<T>(
  sql: Sql,
  options: { readOnly: boolean },
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  await sql`select 1`;
  const reserved = await reserveConnection(sql);
  let lost = false;
  try {
    await reserved.unsafe(options.readOnly ? "begin isolation level repeatable read read only" : "begin");
    let result: T;
    try {
      await reserved`select set_config(${SCOPE_SETTING}, '', true)`;
      result = await fn(reserved);
    } catch (error) {
      if (!foundGone(error)) {
        await reserved`rollback`;
      }
      throw error;
    }
    await reserved`commit`;
    return result;
  } catch (error) {
    lost = foundGone(error);
    throw error;
  } finally {
    if (!lost) {
      reserved.release();
    }
  }
}

/** Throws when `db` runs under a business scope: the runtime side's calls must see every business's rows. */
export async function assertRuntimeSide(db: Db, call: string): Promise<void> {
  if ((await readBusinessScope(db)) !== null) {
    throw new Error(
      `${call} runs on the runtime side, with no business scope: a scope hides other businesses' rows`,
    );
  }
}

/** UTC text ending in Z, without a zero fraction (the contract's form: 2026-11-07T08:06:00Z). */
export function utc(date: Date): string {
  return date.toISOString().replace(".000Z", "Z");
}

export function utcOrNull(date: Date | null): string | null {
  return date === null ? null : utc(date);
}

/** Refuses a request that is not a plain object with exactly the call's fields (K-05 requests: no other property). */
export function assertRequestShape(request: unknown, call: string, fields: readonly string[]): void {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    throw new TypeError(`${call}: the request is an object`);
  }
  const extra = Object.keys(request).filter((key) => !fields.includes(key));
  if (extra.length > 0) {
    throw new TypeError(`${call}: the request takes only ${fields.join(", ")}`);
  }
}

/** Refuses an id that is not a non-empty string (K-05 ids: opaque, non-empty; CQ-09). */
export function assertId(value: unknown, what: string): asserts value is string {
  if (typeof value !== "string" || value === "" || value.includes("\u0000")) {
    throw new TypeError(`${what} is a non-empty id`);
  }
}

/** The moment a read is taken at: the option, else the transaction's now() on the database. */
export async function readMoment(tx: Db, options: ReadOptions): Promise<Date> {
  if (options.now !== undefined) {
    if (Number.isNaN(options.now.getTime())) {
      throw new TypeError("now is a valid date");
    }
    return options.now;
  }
  const [row] = await tx<{ now: Date }[]>`select now() as now`;
  if (row === undefined) {
    throw new Error("select now() returned no row");
  }
  return row.now;
}

// ---- handleTargets --------------------------------------------------------------------------------------------------

export type Role = "owner" | "admin" | "staff" | "own_business" | "customer";
export type BookingStage = "entry" | "booked" | "checked_in" | "done" | "cancelled";

export interface HandleTargetsRequest {
  handleId: string;
}

/** A row and the version it was read at (K-02 facts; K-04 versions_read). */
export interface RowRef {
  table: string;
  rowId: string;
  version: number;
}

export interface RoleRead {
  roleId: string;
  businessId: string;
  role: Role;
  version: number;
}

export interface PersonTargets {
  personId: string;
  roles: RoleRead[];
}

/** K-05 v1.2 openQuestionRead: a live open question sent to the handle. */
export interface OpenQuestionRead {
  id: string;
  businessId: string | null;
  bookingId: string | null;
  personId: string | null;
  turnId: string;
  step: string;
  status: "waiting" | "open";
  /** The options as sent, in order: K-03 v1 option objects as open_questions.options stores them. */
  options: unknown[];
  readback: string | null;
  versionsRead: RowRef[];
  clock: string | null;
  sentAt: string | null;
  pollId: string | null;
  askCount: number;
  bundleId: { hash: string; build: number };
  version: number;
}

/** K-05 v1.2 bookingHead. */
export interface BookingHead {
  id: string;
  businessId: string;
  flow: "A" | "B";
  stage: BookingStage;
  bookerPersonId: string;
  servedPersonId: string | null;
  payerPersonId: string | null;
  private: boolean;
  deceased: boolean;
  version: number;
}

/** K-05 v1.2 phoneFlags. */
export interface PhoneFlags {
  stopped: boolean;
  chatOpen: boolean;
  version: number;
}

export interface HandleTargetsResponse {
  result: "targets";
  handleId: string;
  readAt: string;
  persons: PersonTargets[];
  openQuestions: OpenQuestionRead[];
  bookings: BookingHead[];
  phone: PhoneFlags | null;
}

export type HandleTargetsOutcome = HandleTargetsResponse | NotFoundError | TransientError;

interface RoleRow {
  id: string;
  person_id: string;
  business_id: string;
  role: Role;
  version: number;
}

interface QuestionRow {
  id: string;
  business_id: string | null;
  booking_id: string | null;
  person_id: string | null;
  turn_id: string;
  step: string;
  status: "waiting" | "open";
  options: unknown[];
  readback: string | null;
  versions_read: RowRef[];
  clock: string | null;
  ask_count: number;
  bundle_hash: string;
  bundle_build: number;
  version: number;
  sent_at: Date | null;
  poll_id: string | null;
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

const toQuestion = (row: QuestionRow): OpenQuestionRead => ({
  id: row.id,
  businessId: row.business_id,
  bookingId: row.booking_id,
  personId: row.person_id,
  turnId: row.turn_id,
  step: row.step,
  status: row.status,
  options: row.options,
  readback: row.readback,
  versionsRead: row.versions_read,
  clock: row.clock,
  sentAt: utcOrNull(row.sent_at),
  pollId: row.poll_id,
  askCount: row.ask_count,
  bundleId: { hash: row.bundle_hash, build: row.bundle_build },
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

/**
 * Every live open question sent to a handle that the transaction sees, in id order, each with when it went out and the
 * poll it went out as (see the top of this file): on the runtime side every business's; under a business scope,
 * row-level security leaves that business's questions and outbox rows only.
 */
export async function liveOpenQuestionsOfHandle(db: Db, handleId: string): Promise<OpenQuestionRead[]> {
  const rows = await db<QuestionRow[]>`
    select q.id, q.business_id, q.booking_id, q.person_id, q.turn_id, q.step, q.status, q.options, q.readback,
           q.versions_read, q.clock, q.ask_count, q.bundle_hash, q.bundle_build, q.version,
           went.sent_at, went.poll_id
    from open_questions q
    left join lateral (
      select max(coalesce(p.sent_at, p.delivered_at)) as sent_at,
             (array_agg(p.linq_message_id
                        order by coalesce(p.sent_at, p.delivered_at) desc, r.commit_seq desc, p.part_no desc,
                                 p.try_no desc)
                filter (where p.kind = 'poll'))[1] as poll_id
      from outbox_rows r
      join outbox_parts p on p.outbox_row_id = r.id
      where r.open_question_id = q.id
        and r.recipient_handle_id = q.handle_id
        and p.state in ('sent', 'delivered')
    ) went on true
    where q.handle_id = ${handleId} and q.status in ('waiting', 'open')
    order by q.id collate "C"
  `;
  return rows.map(toQuestion);
}

/**
 * The guard's targets inside the transaction `db`, which must run on the runtime side (no business scope). Prefer
 * handleTargets(); this is for a caller that already holds a transaction.
 */
export async function handleTargetsIn(
  db: Db,
  request: HandleTargetsRequest,
  options: ReadOptions = {},
): Promise<HandleTargetsResponse | NotFoundError> {
  assertRequestShape(request, "handleTargets", ["handleId"]);
  assertId(request.handleId, "handleId");
  await assertRuntimeSide(db, "handleTargets");
  const { handleId } = request;

  const [handle] = await db<{ id: string }[]>`select id from handles where id = ${handleId}`;
  if (handle === undefined) {
    return { error: "notFound", table: "handles", rowId: handleId };
  }
  const readAt = await readMoment(db, options);

  const links = await db<{ person_id: string }[]>`
    select person_id from person_handles where handle_id = ${handleId} order by person_id collate "C"
  `;
  const personIds = links.map((link) => link.person_id);

  const roles =
    personIds.length === 0
      ? []
      : await db<RoleRow[]>`
          select id, person_id, business_id, role, version from person_roles
          where person_id in ${db(personIds)} and ended_at is null
          order by person_id collate "C", business_id collate "C", role collate "C", id collate "C"
        `;

  const bookings =
    personIds.length === 0
      ? []
      : await db<BookingRow[]>`
          select id, business_id, flow, stage, booker_person_id, served_person_id, payer_person_id, private,
                 deceased, version
          from bookings
          where booker_person_id in ${db(personIds)} or served_person_id in ${db(personIds)}
          order by id collate "C"
        `;

  const openQuestions = await liveOpenQuestionsOfHandle(db, handleId);

  const [phone] = await db<{ stopped: boolean; chat_open: boolean; version: number }[]>`
    select stopped, chat_open, version from phones where handle_id = ${handleId}
  `;

  return {
    result: "targets",
    handleId,
    readAt: utc(readAt),
    persons: personIds.map((personId) => ({
      personId,
      roles: roles
        .filter((role) => role.person_id === personId)
        .map((role) => ({
          roleId: role.id,
          businessId: role.business_id,
          role: role.role,
          version: role.version,
        })),
    })),
    openQuestions,
    bookings: bookings.map(toBooking),
    phone:
      phone === undefined
        ? null
        : { stopped: phone.stopped, chatOpen: phone.chat_open, version: phone.version },
  };
}

/**
 * A handle's targets across every business (K-05 v1.2 item 27), for the guard: one read-only transaction on the
 * primary, uncached, on the runtime side. Pass the client's primary handle, run as rosie_job. notFound when the handle
 * does not exist; transient on a serialization failure, a deadlock or a lost connection.
 */
export async function handleTargets(
  sql: Sql,
  request: HandleTargetsRequest,
  options: ReadOptions = {},
): Promise<HandleTargetsOutcome> {
  assertRequestShape(request, "handleTargets", ["handleId"]);
  assertId(request.handleId, "handleId");
  try {
    return await inRuntimeTransaction(sql, { readOnly: true }, (tx) => handleTargetsIn(tx, request, options));
  } catch (error) {
    // A statement's own refusal and postgres.js's statement errors leave scrubbed too: the call's name and the code
    // alone, never the statement's values (T-1322; clocks.ts transientOrScrubbed).
    return transientOrScrubbed("handleTargets", error);
  }
}
