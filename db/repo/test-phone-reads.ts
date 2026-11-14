// Data-access v1.12: staging's test-phone page's three reads (K-05 v1.12 items 53, 54 and 55; T-1300, the D-017 path
// audit's D2; DL-498, DL-542; QUESTIONS.md CQ-206 and CQ-214), readTesterStanding widened by v1.15 (item 68; T-1402,
// DL-535, DL-757). Their caller is staging's test-phone page (C-205), through its three ports
// (actions/src/page-calls/staging/test-phone/types.ts TesterAccess.standing, TestPhoneRoster.phone and
// PhoneStates.state), which the runtime engineer's binding maps (RootOptions.testPhone in runtime/src/wiring: the audit's
// P6b, a part of T-1154). Items 56 and 57, the actor's copies' two reads, are db/repo/copy-reads.ts's (T-1301).
//
//   readTesterStanding  a session token's sha256 and a time give the standing of the call for staging's test tools (item
//                       68, which widens item 53's step 2), in its order:
//                         1. the session: K-22 v1's session_for_token(token_sha256, at) (0020), the session with that
//                            hash that has not ended and has not expired at `at`, its person alone (sessions_token_key
//                            makes it one row at most). None answers noSession, whether the hash is unknown, the session
//                            ended or it expired (default 104), and nothing more is read;
//                         2. the tester rows of that person, in one statement: K-36 v1's team_page_recipients with
//                            removed_at null (team_page_recipients_one_live_per_person), or K-22 v1.3's staging_testers
//                            with removed_at null (staging_testers_one_live_per_person, 0036), each read by person_id and
//                            removed_at alone. Either answers tester, neither notTester (default 136): live is removed_at
//                            null, whatever added_at says, so a listing that ended ends the standing at once, the
//                            session live or not (default 138).
//                       It answers the standing alone: never the session, the person, a hash, which row stood, or
//                       whether a person, a team row or a listing exists or when a listing ended (default 139). The
//                       check tester stands by its team row (default 105); a human tester by a listing staging's
//                       testers' seed writes (T-1281), with no team row.
//   readRosterPhone     a roster phone's number and email on file, by the K-04 handle id the roster's list gives for its
//                       roster id (item 54; default 106: the list is the seed's own, and the binding finds the id there):
//                         1. the phone: handles by id, of kind phone, its address, the number in E.164 form
//                            (handles_address_form). None, or a handle of kind email, answers phone null (default 107),
//                            and nothing more is read;
//                         2. the email on file: the handle's people (person_handles by handle_id, two at most); for
//                            exactly one, that person's other handles (person_handles by person_id), and of those the
//                            ones of kind email (handles by id, two at most). Exactly one gives its address; no person,
//                            two people, no email handle or two give null (default 107), never another person's email.
//                       It answers the request's handle id, the number and the email alone, never the person, a name or
//                       another handle.
//   readPhoneState      a roster phone's own state by its number (item 55):
//                         1. the phone row: phones by number, its chat_open, stopped and stop_at. stoppedAt is stop_at
//                            while stopped is true, else null (DL-193: after a START the row keeps the last STOP's time,
//                            which is no STOP in force); a stopped phone's chat is closed (phones_stop_closes_chat), and the
//                            answer holds that too. No row answers phone null and chatLink null (default 108), and no chat
//                            link is read: none can name a number with no row (chat_links_phone_fk);
//                         2. the chat link: chat_links by phone_number (chat_links_phone_idx), the newest by issued_at, a
//                            tie to the lower id (default 2), whatever its purpose, business or use: its short_code and
//                            ready_text as stored, or null for none (default 109).
//                       It answers no number, and of the link nothing but its code and its ready text.
//
// Role and scope (README v1.12 "Where each read lives", v1.15 item 68; K-04 v1 rule 4: sessions, team rows, listings,
// handles and phones are scoped none). Each read runs on the client it is handed, the runtime side's, as rosie_job (the
// role is the connection's: nothing here checks it), in one read-only transaction at repeatable read on the primary,
// uncached (targets.ts inRuntimeTransaction, which sets the business scope empty for the transaction, as the seeds set
// it), so the answer is one moment's and nothing is written. rosie_job reads handles, person_handles and phones through
// its own grants (0012), team_page_recipients through its own (0017), staging_testers through its own behind its one
// policy (0036; K-22 v1.3 rule 10), every business's chat links behind chat_links_runtime with no scope (0013), and the
// session through session_for_token, which it may execute (0020): no other definer function and no table owner's
// rights. rosie_app, the Tool API's role, holds no grant on handles, phones, team_page_recipients or staging_testers,
// so its call is refused by PostgreSQL's privilege check (42501, thrown as DataAccessDatabaseError).
//
// What they read and answer (README v1.12 and v1.15 "What the new tasks must hold to"). Each statement reads one table
// or the one function, but item 68's step 2, which reads the two tester lists in one statement (default 136); none
// joins, and none selects `*` or a whole row: session_for_token's person_id; team_page_recipients' and staging_testers'
// person_id and removed_at; handles' id, kind and address and person_handles' two ids; phones' chat_open, stopped and
// stop_at (by its key, number) and chat_links' id, short_code, ready_text and issued_at (by phone_number); and no other
// column. No statement names token_sha256, device_sha256 or code_hash: the token's hash is session_for_token's first
// argument, bound as a parameter and named nowhere. None reads a column of sealing_keys, messages, consents or
// proof_codes. The request's hash, a number, an email address, a short code and a ready text are never logged or put in
// an error. The integration test reads every statement the reads send and checks it. v1.15 restates item 68's request
// and response for their text alone (the same shape), so the v1.12 types below stand for it.
//
// Errors (K-05 README: every call may answer transient). A serialization failure, a deadlock or a lost connection answers
// transient, with only its SQLSTATE. Any other database error is thrown scrubbed, as DataAccessDatabaseError with its
// SQLSTATE and names alone (clocks.ts transientOrScrubbed: PostgreSQL's own error can hold a row's values). A request of
// the wrong shape throws a TypeError before any statement is sent (default 1), and a record the answer would have to guess
// around a BrokenRecordError (default 3); each names the call, a field or a rule, never a value. Nothing here logs, and
// nothing is written on any of them.
//
// Defaults used (for ops/QUESTIONS.md; each where no source decides):
//   1. A request is refused before any statement for its shape alone, each field as its v1.12 definition gives it: a
//      tokenSha256 that is not 64 lower-case hex characters (the token itself passed as its hash among them) and an at
//      that is not an instant in UTC; a handleId that is not a K-08 safe id or reads as a number (the answer's handleRef;
//      arming-reads.ts default 3: no request carries an address or a number as the id); a number not in E.164 form; and
//      any field beside the call's own (refuse-tester-standing-token-not-hash's sessionToken,
//      refuse-roster-phone-by-roster-id's testPhoneId). The refusal names the field, never its value, so no hash, token,
//      number or address reaches an error.
//   2. "A tie to the lower id" (item 55 step 2) compares ids byte by byte (collate "C"), never parsed (CQ-09), as every
//      K-05 read that orders by id does.
//   3. A stopped phone row with no stop_at, which phones_stopped_has_time refuses, throws BrokenRecordError and nothing is
//      answered (turn-face-reads.ts default 2's rule: fail closed rather than answer half): a stopped phone's answer always
//      carries the time of the STOP in force, never one made up.
import type * as K05 from "../../contracts/generated/data-access/data-access.v1.12";
import { instantOf, transientOrScrubbed } from "./clocks";
import type { Sql } from "./scope";
import { assertRequestShape, inRuntimeTransaction, utc } from "./targets";
import { BrokenRecordError } from "./turn-face-reads";

// ---- the requests and the answers (data-access.v1.12.schema.json) ----------------------------------------------------

/**
 * K-05 v1.12 readTesterStanding.request: the session token's sha256 and the time, never the token, a person or an
 * address (v1.15 restates it for its text alone).
 */
export type ReadTesterStandingRequest = K05.ReadTesterStandingRequest;
/** K-05 v1.12 readTesterStanding.response: the standing alone (tester, notTester or noSession; v1.15's text, one shape). */
export type ReadTesterStandingResponse = K05.ReadTesterStandingResponse;
/** K-05 v1.12 readTesterStanding.errors: transient alone. */
export type ReadTesterStandingError = K05.ReadTesterStandingErrors;
export type ReadTesterStandingOutcome = ReadTesterStandingResponse | ReadTesterStandingError;

/** K-05 v1.12 readRosterPhone.request: the K-04 handle id the roster's list gives, never a roster id or a number. */
export type ReadRosterPhoneRequest = K05.ReadRosterPhoneRequest;
/** K-05 v1.12 readRosterPhone.response: the request's handle id and the phone's number and email on file, or null. */
export type ReadRosterPhoneResponse = K05.ReadRosterPhoneResponse;
/** K-05 v1.12 readRosterPhone.errors: transient alone; no phone handle by the id is an answer (default 107). */
export type ReadRosterPhoneError = K05.ReadRosterPhoneErrors;
export type ReadRosterPhoneOutcome = ReadRosterPhoneResponse | ReadRosterPhoneError;

/** K-05 v1.12 readPhoneState.request: the roster phone's number, the phones row's key. */
export type ReadPhoneStateRequest = K05.ReadPhoneStateRequest;
/** K-05 v1.12 readPhoneState.response: the phone row's state and its newest chat link, or no row; never the number. */
export type ReadPhoneStateResponse = K05.ReadPhoneStateResponse;
/** K-05 v1.12 readPhoneState.errors: transient alone; no phone row is an answer (default 108). */
export type ReadPhoneStateError = K05.ReadPhoneStateErrors;
export type ReadPhoneStateOutcome = ReadPhoneStateResponse | ReadPhoneStateError;

type TesterStanding = ReadTesterStandingResponse["standing"];
type PhoneState = K05.PhoneStateOpen | K05.PhoneStateStopped;

const STANDING = "readTesterStanding";
const ROSTER_PHONE = "readRosterPhone";
const PHONE_STATE = "readPhoneState";
/** K-22 v1 sessions_token_hash_form, K-05 v1.12 tokenSha256: a sha256 in lower-case hex. */
const TOKEN_SHA256 = /^[0-9a-f]{64}$/;
/** K-08 v1 safeId: letters, digits and _ . : / # -, starting with a letter or digit. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/#-]*$/;
/** K-08 v1 safeId's refusal: a run of digits and phone punctuation, seven or more long, reads as a number. */
const READS_AS_NUMBER = /^[0-9().+ -]{7,}$/;
/** K-05 v1 phoneNumber (K-04 phones_number_form): E.164. */
const E164 = /^\+[1-9][0-9]{6,14}$/;

// ---- the requests' shape (default 1) ----------------------------------------------------------------------------------

/** The request's fields as a record, refused unless it is a plain object with no field but the call's own. */
function fieldsOf(request: unknown, call: string, fields: readonly string[]): Record<string, unknown> {
  assertRequestShape(request, call, fields);
  return request as Record<string, unknown>;
}

/** The token's hash and the time: a hash of 64 lower-case hex characters, never the token, and an instant in UTC. */
function standingRequestOf(request: unknown): { tokenSha256: string; at: Date } {
  const { tokenSha256, at } = fieldsOf(request, STANDING, ["tokenSha256", "at"]);
  if (typeof tokenSha256 !== "string" || !TOKEN_SHA256.test(tokenSha256)) {
    throw new TypeError(
      `${STANDING}: tokenSha256 is the session token's sha256 in lower-case hex, never the token itself`,
    );
  }
  return { tokenSha256, at: instantOf(STANDING, at, "at") };
}

/** The handle's id: a K-08 safe id, never a number or an address (default 1). */
function handleIdOf(request: unknown): string {
  const { handleId } = fieldsOf(request, ROSTER_PHONE, ["handleId"]);
  if (typeof handleId !== "string" || !SAFE_ID.test(handleId) || READS_AS_NUMBER.test(handleId)) {
    throw new TypeError(
      `${ROSTER_PHONE}: handleId is a K-04 handle id (a K-08 safe id), never a number or an address`,
    );
  }
  return handleId;
}

/** The phone's number, in E.164 form. */
function numberOf(request: unknown): string {
  const { number } = fieldsOf(request, PHONE_STATE, ["number"]);
  if (typeof number !== "string" || !E164.test(number)) {
    throw new TypeError(`${PHONE_STATE}: number is a phone number in E.164 form`);
  }
  return number;
}

// ---- readTesterStanding (items 53 and 68) -------------------------------------------------------------------------------

/** The standing inside the read's own transaction, on the runtime side: item 68's two reads in order, the second as needed. */
async function standingIn(tx: Sql, tokenSha256: string, at: Date): Promise<TesterStanding> {
  // Step 1: the live session with the hash at `at`, through K-22's own function; its person alone. None: noSession.
  const [session] = await tx<{ person_id: string }[]>`
    select person_id from session_for_token(${tokenSha256}, ${at})
  `;
  if (session === undefined) {
    return "noSession";
  }
  // Step 2: the person's live team row or live listing (removed_at null on either), both lists in one statement, each by
  // person_id and removed_at alone. Either: tester; neither: notTester (default 136).
  const [rows] = await tx<{ tester: boolean }[]>`
    select exists (
      select 1 from team_page_recipients where person_id = ${session.person_id} and removed_at is null
    ) or exists (
      select 1 from staging_testers where person_id = ${session.person_id} and removed_at is null
    ) as tester
  `;
  return rows?.tester === true ? "tester" : "notTester";
}

/**
 * The standing of the session a staging page call carries (K-05 v1.15 item 68, widening v1.12's item 53): tester when a
 * live session has the token's sha256 at `at` and its person holds a live K-36 team row or a live K-22 v1.3 listing,
 * notTester when its person holds neither (a listing that ended included), noSession when no live session has the
 * hash, whatever the reason. One read-only transaction at repeatable read on the primary, uncached, writing nothing.
 * Pass the runtime side's client (rosie_job): the role is the connection's. transient on a serialization failure, a
 * deadlock or a lost connection. Throws a TypeError for a request of the wrong shape, and any other database error
 * scrubbed (DataAccessDatabaseError); nothing is written on any of them. The hash is the session's key: it is never
 * answered, logged or put in an error.
 */
export async function readTesterStanding(
  sql: Sql,
  request: ReadTesterStandingRequest,
): Promise<ReadTesterStandingOutcome> {
  const { tokenSha256, at } = standingRequestOf(request);
  try {
    const standing = await inRuntimeTransaction(sql, { readOnly: true }, (tx) =>
      standingIn(tx, tokenSha256, at),
    );
    return { standing };
  } catch (error) {
    return transientOrScrubbed(STANDING, error);
  }
}

// ---- readRosterPhone (item 54) ------------------------------------------------------------------------------------------

/**
 * Step 2, the email on file (default 107): the phone handle's people, two at most; for exactly one, that person's other
 * handles; of those, the ones of kind email, two at most. Exactly one gives its address, anything else null.
 */
async function emailOnFileIn(tx: Sql, handleId: string): Promise<string | null> {
  const people = await tx<{ person_id: string }[]>`
    select person_id from person_handles where handle_id = ${handleId} limit 2
  `;
  const [person, ...others] = people;
  if (person === undefined || others.length > 0) {
    return null;
  }
  const links = await tx<{ handle_id: string }[]>`
    select handle_id from person_handles where person_id = ${person.person_id}
  `;
  // The phone handle itself is no email handle (step 1 read it as a phone).
  const handleIds = links.map((link) => link.handle_id).filter((id) => id !== handleId);
  if (handleIds.length === 0) {
    return null;
  }
  const emails = await tx<{ address: string }[]>`
    select address from handles where id in ${tx(handleIds)} and kind = 'email' limit 2
  `;
  const [email, ...more] = emails;
  return email !== undefined && more.length === 0 ? email.address : null;
}

/** The roster phone inside the read's own transaction, on the runtime side: item 54's reads in order, each as needed. */
async function rosterPhoneIn(tx: Sql, handleId: string): Promise<ReadRosterPhoneResponse> {
  // Step 1: the phone handle by its id; none, or one of kind email, is no roster phone (default 107).
  const [phone] = await tx<{ address: string }[]>`
    select address from handles where id = ${handleId} and kind = 'phone'
  `;
  if (phone === undefined) {
    return { handleId, phone: null };
  }
  return { handleId, phone: { number: phone.address, email: await emailOnFileIn(tx, handleId) } };
}

/**
 * A roster test phone's number and email on file (K-05 v1.12 item 54), by the K-04 handle id the roster's list gives for
 * its roster id: the phone handle's address, and the one email handle of its one person, or null; phone null when K-04
 * holds no phone handle by that id. One read-only transaction at repeatable read on the primary, uncached, writing
 * nothing. Pass the runtime side's client (rosie_job). transient on a serialization failure, a deadlock or a lost
 * connection. Throws a TypeError for a request of the wrong shape, and any other database error scrubbed
 * (DataAccessDatabaseError: the Tool API's role meets 42501, since it holds no grant on handles). The number and the
 * email are a person's: never log them.
 */
export async function readRosterPhone(
  sql: Sql,
  request: ReadRosterPhoneRequest,
): Promise<ReadRosterPhoneOutcome> {
  const handleId = handleIdOf(request);
  try {
    return await inRuntimeTransaction(sql, { readOnly: true }, (tx) => rosterPhoneIn(tx, handleId));
  } catch (error) {
    return transientOrScrubbed(ROSTER_PHONE, error);
  }
}

// ---- readPhoneState (item 55) -------------------------------------------------------------------------------------------

/** Step 1's columns of the phone row: its chat, its stopped flag and the last STOP's time. */
interface PhoneRow {
  chat_open: boolean;
  stopped: boolean;
  stop_at: Date | null;
}

/**
 * The row as the page shows it (default 108): a stopped phone's chat closed and the STOP in force at stop_at; a phone not
 * stopped has no STOP in force, whatever stop_at keeps. A stopped row with no stop_at is a broken record (default 3).
 */
function phoneStateOf(row: PhoneRow): PhoneState {
  if (!row.stopped) {
    return { chatOpen: row.chat_open, stopped: false, stoppedAt: null };
  }
  if (row.stop_at === null) {
    throw new BrokenRecordError(`${PHONE_STATE}: a stopped phone row holds no STOP time`);
  }
  return { chatOpen: false, stopped: true, stoppedAt: utc(row.stop_at) };
}

/** The phone's state inside the read's own transaction, on the runtime side: item 55's two reads, the second as needed. */
async function phoneStateIn(tx: Sql, number: string): Promise<ReadPhoneStateResponse> {
  // Step 1: the phone row by its key; none is phone null, and no chat link can name it (chat_links_phone_fk).
  const [row] = await tx<PhoneRow[]>`
    select chat_open, stopped, stop_at from phones where number = ${number}
  `;
  if (row === undefined) {
    return { phone: null, chatLink: null };
  }
  const phone = phoneStateOf(row);
  // Step 2: the phone's newest chat link, a tie to the lower id, whatever its purpose, business or use (default 109).
  const [link] = await tx<{ short_code: string; ready_text: string }[]>`
    select short_code, ready_text from chat_links where phone_number = ${number}
    order by issued_at desc, id collate "C" limit 1
  `;
  return {
    phone,
    chatLink: link === undefined ? null : { shortCode: link.short_code, readyText: link.ready_text },
  };
}

/**
 * A roster phone's own state (K-05 v1.12 item 55): its K-04 phone row's chat open, stopped and the STOP in force, and its
 * newest K-29 chat link's short code and ready text, or null; phone and chatLink null when the number has no phone row.
 * One read-only transaction at repeatable read on the primary, uncached, writing nothing. Pass the runtime side's client
 * (rosie_job). transient on a serialization failure, a deadlock or a lost connection. Throws a TypeError for a request of
 * the wrong shape, a BrokenRecordError for a record it would have to guess around (default 3), and any other database
 * error scrubbed (DataAccessDatabaseError: the Tool API's role meets 42501, since it holds no grant on phones). The number
 * and the ready text are never logged.
 */
export async function readPhoneState(
  sql: Sql,
  request: ReadPhoneStateRequest,
): Promise<ReadPhoneStateOutcome> {
  const number = numberOf(request);
  try {
    return await inRuntimeTransaction(sql, { readOnly: true }, (tx) => phoneStateIn(tx, number));
  } catch (error) {
    return transientOrScrubbed(PHONE_STATE, error);
  }
}
