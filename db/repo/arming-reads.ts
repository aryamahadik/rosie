// Data-access v1.10: the clock arming's two reads (K-05 v1.10 items 49 and 50; T-1258, the D-017 path audit's D1b;
// DL-492, DL-506; QUESTIONS.md CQ-200). Their callers are the clock arming (C-055, through runtime/src/wiring/real.ts
// ArmingCalls.questionFacts and ArmingCalls.actorNameOf), and the minute sweep and staging's Fire now (C-054) for a clock
// row's actor; the bindings are the runtime engineer's (the audit's P5, with the outbox calls: DL-468).
//
//   readQuestionFacts  the facts T-255's due rule reads about one open question (item 49; runtime/src/clocks/types.ts
//                      QuestionFacts): the question first (open_questions by its primary key; none answers notFound,
//                      table open_questions), then, naming the question's own business beside each key, its business's
//                      zone (businesses by open_questions.business_id), its visit (the booking's flow, bookings by
//                      open_questions.booking_id at that business, and its start, the earliest lower(during) among that
//                      booking's held or booked reservations at that business: default 90) and its never-delivered clock
//                      row with its version (clock_rows by open_question_id and kind, chosen as default 92 says). A question
//                      with no business reads none of businesses, bookings and reservations, and answers businessZone and
//                      visit null whatever its booking_id holds. The answer is the port's own names: clockLine
//                      (open_questions.clock as stored), businessZone, visit (null for a question with no business, for no
//                      booking, and for a booking with no held or booked reservation) and neverDelivered.
//   readHandle         a K-04 handle by its id (item 50): handles by its primary key, the columns kind and address alone,
//                      answered in K-06 v1's handle shape with handleId the request's; handle null when no row has the id
//                      (default 95). No actor name is built here: the consumer builds it from the answer with the gateway's
//                      own runtime/src/gateway/seal.ts actorNameOf (default 93).
//
// Role and scope (items 49 and 50; K-04 v1 rule 4; turn-face-reads.ts and safety-reads.ts: the role is the
// connection's). Each read runs on the client it is handed, the runtime side's, as rosie_job, in one read-only
// transaction at repeatable read on the primary, uncached (targets.ts inRuntimeTransaction, which clears the business
// scope at its start), so the answer is one moment's and nothing is written. Neither uses a definer function or a table
// owner's rights: rosie_job reads open_questions, businesses, bookings, reservations and clock_rows behind their runtime
// policies and handles through its own grant (0012). With no scope rosie_job sees every business's rows, so each read of
// a business-scoped table after the question names the question's own business itself, and the answer holds nothing of
// another business even under a role row-level security does not bind (a table's owner). Neither read checks the role it
// runs as, and neither reads anything its item does not name: readQuestionFacts reads the question first (item 49), and
// on the deployed Worker ADR-014's guard checks the login and its one membership in every call before db/repo runs.
// rosie_app, the Tool API's role, holds no grant on handles (0012), so a Tool API client's readHandle is refused by
// privilege (42501, thrown as DataAccessDatabaseError).
//
// What these reads never touch (item 49: "never an address or an address's zone", default 91; item 50; the card's security
// review): no statement here names a visit's address or zone (K-30's booking_addresses, or any other table's address),
// a message's words (messages.words, outbox_rows' plan and final parts, a sealed column) or any column of sealing_keys,
// and none selects `*` or a whole row. readQuestionFacts reads nothing of the question's options, read-back, versions
// read, handle, person or status, and never its own clock row of kind question (armClock finds that one: item 5).
// readHandle reads a handle's address, a phone number or an email address, because the actor's name must hold it; it
// answers it to its caller alone, and nothing here logs it or puts it in an error. The integration test reads every
// statement both reads send and checks it.
//
// Errors (K-05 README: every call may answer transient). A serialization failure, a deadlock or a lost connection answers
// transient, with only its SQLSTATE. Any other database error is thrown scrubbed, as DataAccessDatabaseError with its
// SQLSTATE and names alone (clocks.ts's transientOrScrubbed: PostgreSQL's own error can hold a row's values). A request
// of the wrong shape throws a TypeError, and a record the answer would have to guess around a BrokenRecordError (default
// 1); each names a call, a field or a rule, never a value or an id, and nothing is written on any of them.
//
// Defaults used (for ops/QUESTIONS.md; each where no source decides):
//   1. A stored record the answer would have to guess around throws BrokenRecordError, and nothing is answered
//      (turn-face-reads.ts default 2's rule: fail closed rather than answer half), in the two cases item 49 is silent on:
//      a question whose business row is missing, and a question whose booking is not under the question's own business.
//      A visit is never guessed: no answer gives a no-visit due rule to a question with a business that names a booking
//      it cannot read. A question with no business is neither: item 49 reads none of businesses, bookings and
//      reservations for it and answers businessZone and visit null, whatever its booking_id holds.
//   2. The never-delivered row's read names the question's own business too (business_id is not distinct from the
//      question's, so a question with no business finds its rows with none): item 49's "every later read names the
//      question's own business beside its key", as readOutboxRow names it for a question's clock row (turn-face-reads.ts).
//   3. readHandle's handleId is a K-08 safe id that never reads as a number (its schema's handleRef), as openChatOnText's
//      is (chat-open.ts): an address or a number passed as the id is refused before any read, so no request carries one.
import type * as K05 from "../../contracts/generated/data-access/data-access.v1.10";
import { transientOrScrubbed } from "./clocks";
import type { Sql } from "./scope";
import { assertId, assertRequestShape, inRuntimeTransaction, utc } from "./targets";
import { BrokenRecordError } from "./turn-face-reads";

// ---- the requests and the answers (data-access.v1.10.schema.json) ------------------------------------------------------

/** K-05 v1.10 readQuestionFacts.request: the open question alone, never its business, booking or zone. */
export type ReadQuestionFactsRequest = K05.ReadQuestionFactsRequest;
/** K-05 v1.10 readQuestionFacts.response: the Clock line, the business's zone, the visit, the never-delivered row. */
export type ReadQuestionFactsResponse = K05.ReadQuestionFactsResponse;
/** K-05 v1.10 questionVisit: the booking's flow and its start, never an address or an address's zone. */
export type QuestionVisit = K05.QuestionVisit;
/** K-05 v1.10 neverDeliveredRow: the question's never-delivered clock row and the version read. */
export type NeverDeliveredRow = K05.NeverDeliveredRow;
/** K-05 v1.10 readQuestionFacts.errors: notFound (table open_questions) or transient. */
export type ReadQuestionFactsError = K05.ReadQuestionFactsErrors;
export type ReadQuestionFactsOutcome = ReadQuestionFactsResponse | ReadQuestionFactsError;

/** K-05 v1.10 readHandle.request: a K-04 handle's id, never an address. */
export type ReadHandleRequest = K05.ReadHandleRequest;
/** K-05 v1.10 readHandle.response: the handle's kind and address as stored (K-06 v1 handle), or null. */
export type ReadHandleResponse = K05.ReadHandleResponse;
/** K-05 v1.10 readHandle.errors: transient alone; a handle K-04 does not hold is an answer (default 95). */
export type ReadHandleError = K05.ReadHandleErrors;
export type ReadHandleOutcome = ReadHandleResponse | ReadHandleError;

const QUESTION_FACTS = "readQuestionFacts";
const READ_HANDLE = "readHandle";
/** K-08 v1 safeId: letters, digits and _ . : / # -, starting with a letter or digit. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/#-]*$/;
/** K-08 v1 safeId's refusal: a run of digits and phone punctuation, seven or more long, reads as a number. */
const READS_AS_NUMBER = /^[0-9().+ -]{7,}$/;

// ---- the requests' shape -------------------------------------------------------------------------------------------

/** The request's one field, refused unless the request is exactly that field; names the field, never a value. */
function onlyField(request: unknown, call: string, field: string): unknown {
  assertRequestShape(request, call, [field]);
  const values = request as Record<string, unknown>;
  if (!Object.hasOwn(values, field)) {
    throw new TypeError(`${call}: the request needs ${field}`);
  }
  return values[field];
}

/** The question's id: the request names the question alone (`refuse-question-facts-caller-business`). */
function questionIdOf(request: unknown): string {
  const openQuestionId = onlyField(request, QUESTION_FACTS, "openQuestionId");
  assertId(openQuestionId, "openQuestionId");
  return openQuestionId;
}

/** The handle's id: a K-08 safe id, never a number or an address (default 3). */
function handleIdOf(request: unknown): string {
  const handleId = onlyField(request, READ_HANDLE, "handleId");
  if (typeof handleId !== "string" || !SAFE_ID.test(handleId) || READS_AS_NUMBER.test(handleId)) {
    throw new TypeError(
      `${READ_HANDLE}: handleId is a K-04 handle id (a K-08 safe id), never a number or an address`,
    );
  }
  return handleId;
}

// ---- readQuestionFacts (item 49) ---------------------------------------------------------------------------------------

/** The open_questions columns the read takes: its business, its booking and its Clock line, nothing else. */
interface QuestionRow {
  business_id: string | null;
  booking_id: string | null;
  clock: string | null;
}

/** The business's zone: businesses by the question's own business, its key (a missing row: default 1). */
async function businessZoneOf(tx: Sql, businessId: string): Promise<string> {
  const [business] = await tx<{ time_zone: string }[]>`
    select time_zone from businesses where id = ${businessId}
  `;
  if (business === undefined) {
    throw new BrokenRecordError(`${QUESTION_FACTS}: the question's business is missing`);
  }
  return business.time_zone;
}

/**
 * The visit (default 90): the booking at the question's business, its flow as stored, and its start, the earliest lower
 * bound of during among its held or booked reservations at that business (reservations_booking_idx); a released or a
 * waiting row holds no time of the visit. Null when no such reservation is left. A booking not under the question's
 * business is a broken record (default 1).
 */
async function visitOf(tx: Sql, bookingId: string, businessId: string): Promise<QuestionVisit | null> {
  const [booking] = await tx<{ flow: QuestionVisit["flow"] }[]>`
    select flow from bookings where id = ${bookingId} and business_id = ${businessId}
  `;
  if (booking === undefined) {
    throw new BrokenRecordError(
      `${QUESTION_FACTS}: the question's booking is not under the question's business`,
    );
  }
  const [start] = await tx<{ starts_at: Date | null }[]>`
    select min(lower(during)) as starts_at
    from reservations
    where booking_id = ${bookingId} and business_id = ${businessId} and state in ('held', 'booked')
  `;
  const startsAt = start?.starts_at ?? null;
  return startsAt === null ? null : { flow: booking.flow, startsAt: utc(startsAt) };
}

/**
 * The question's never-delivered clock row with its version (default 92): of several, the waiting or armed one with the
 * lowest id, else the one with the lowest id, ids compared byte by byte (collate "C"), never parsed (CQ-09); at the
 * question's own business, or with none at none (default 2). Null when it has none.
 */
async function neverDeliveredOf(
  tx: Sql,
  openQuestionId: string,
  businessId: string | null,
): Promise<NeverDeliveredRow | null> {
  const [row] = await tx<{ id: string; version: number }[]>`
    select id, version
    from clock_rows
    where open_question_id = ${openQuestionId}
      and kind = 'never_delivered'
      and business_id is not distinct from ${businessId}
    order by state in ('waiting', 'armed') desc, id collate "C"
    limit 1
  `;
  return row === undefined ? null : { clockRowId: row.id, version: row.version };
}

/**
 * The question's facts inside the read's own transaction, on the runtime side: the question first, by its key (item 49).
 * A question with no business reads none of businesses, bookings and reservations: businessZone and visit are null,
 * whatever its booking_id holds.
 */
async function questionFactsIn(
  tx: Sql,
  openQuestionId: string,
): Promise<ReadQuestionFactsResponse | K05.NotFoundError> {
  const [question] = await tx<QuestionRow[]>`
    select business_id, booking_id, clock from open_questions where id = ${openQuestionId}
  `;
  if (question === undefined) {
    return { error: "notFound", table: "open_questions", rowId: openQuestionId };
  }
  const businessId = question.business_id;
  let businessZone: string | null = null;
  let visit: QuestionVisit | null = null;
  if (businessId !== null) {
    businessZone = await businessZoneOf(tx, businessId);
    visit = question.booking_id === null ? null : await visitOf(tx, question.booking_id, businessId);
  }
  return {
    openQuestionId,
    clockLine: question.clock,
    businessZone,
    visit,
    neverDelivered: await neverDeliveredOf(tx, openQuestionId, businessId),
  };
}

/**
 * The facts the clock arming's due rule reads about one open question (K-05 v1.10 item 49): its Clock line as stored, its
 * business's zone, the visit it is about (never an address or an address's zone) and its never-delivered row. One
 * read-only transaction at repeatable read on the primary, uncached, writing nothing. Pass the runtime side's client
 * (rosie_job): the role is the connection's. A question with no business answers businessZone and visit null, reading
 * none of businesses, bookings and reservations. notFound (table open_questions) when no question has the id; transient
 * on a serialization failure, a deadlock or a lost connection. Throws a TypeError for a request of the wrong shape, a
 * BrokenRecordError for a record it would have to guess around (default 1), and any other database error scrubbed
 * (DataAccessDatabaseError); nothing is written on any of them.
 */
export async function readQuestionFacts(
  sql: Sql,
  request: ReadQuestionFactsRequest,
): Promise<ReadQuestionFactsOutcome> {
  const openQuestionId = questionIdOf(request);
  try {
    return await inRuntimeTransaction(sql, { readOnly: true }, (tx) => questionFactsIn(tx, openQuestionId));
  } catch (error) {
    return transientOrScrubbed(QUESTION_FACTS, error);
  }
}

// ---- readHandle (item 50) ----------------------------------------------------------------------------------------------

type StoredHandle = NonNullable<ReadHandleResponse["handle"]>;

/** The handle by its id inside the read's own transaction: kind and address alone, as K-04 stores them. */
async function handleIn(tx: Sql, handleId: string): Promise<ReadHandleResponse> {
  const [handle] = await tx<StoredHandle[]>`
    select kind, address from handles where id = ${handleId}
  `;
  return { handleId, handle: handle === undefined ? null : { kind: handle.kind, address: handle.address } };
}

/**
 * A K-04 handle by its id (K-05 v1.10 item 50): its kind and address as stored, in K-06 v1's handle shape, from which the
 * consumer names the handle's actor with the gateway's own actorNameOf; handle null when K-04 holds no handle with the
 * id. One read-only transaction at repeatable read on the primary, uncached, writing nothing. Pass the runtime side's
 * client (rosie_job). transient on a serialization failure, a deadlock or a lost connection. Throws a TypeError for a
 * request of the wrong shape, and any other database error scrubbed (DataAccessDatabaseError: the Tool API's role meets
 * 42501, since it holds no grant on handles). The address is a person's number or email address: never log it.
 */
export async function readHandle(sql: Sql, request: ReadHandleRequest): Promise<ReadHandleOutcome> {
  const handleId = handleIdOf(request);
  try {
    return await inRuntimeTransaction(sql, { readOnly: true }, (tx) => handleIn(tx, handleId));
  } catch (error) {
    return transientOrScrubbed(READ_HANDLE, error);
  }
}
