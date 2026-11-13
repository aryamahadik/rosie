// Data-access v1.13: a sign-in's send side, startSignIn and sendSignInCode (K-05 v1.13 items 58 and 59; T-1280, ADR-016
// section 7's card R1; DL-526, DL-546, DL-610). Their caller is the sign-in page call's server side (B1, T-1282), on the
// runtime side's client as ADR-016 section 6 rules: startSignIn before the page answers, sendSignInCode after it, each
// as rosie_job through HYPERDRIVE_JOB's login (ADR-014), never in one transaction with a Tool API call.
//
//   startSignIn     K-21 signInStart's server side (item 58; ADR-016 section 4, rules 0 to 5; K-22 v1.2 rule 9). In one
//                   transaction, by the database's clock:
//                     0. the hour's bound, every contact's starts, read before any lock and any account: with
//                        SIGN_IN_STARTS_PER_HOUR (100) started after one hour before now, paused (hourBound) until the
//                        (n - 100 + 1)-th of them, by started_at then id, plus 1 hour; nothing written;
//                     1. the contact's lock, pg_advisory_xact_lock(hashtext('sign_in_attempts:' || <contact hash>)), the
//                        blocking form (DL-546), so two starts of one contact run one after the other; then the repeat:
//                        an attempt with the request's key answers started, repeated, with its own id, attempt id and
//                        expiry and personId null; nothing written;
//                     2. the contact's pause: the latest paused_until after now of the contact's attempts, paused
//                        (contactPause) until it; nothing written;
//                     3. the day's cap: with SIGN_IN_STARTS_PER_DAY (5) of the contact's attempts started after 24 hours
//                        before now, paused (dayCap) until the (n - 5 + 1)-th of them plus 24 hours; nothing written;
//                     4. the account, one statement for an email or a mobile, none for a link (K-22 default 15): the
//                        accounts whose email is the address with email_proven_at set, or whose mobile is the number,
//                        counted, with whether the person holds a live owner or admin role (person_roles, ended_at null);
//                        exactly one names its person, none or several name none (ADR-016 open point 14);
//                     5. the insert: the attempt, started_at its default now() and expires_at now() + 10 minutes,
//                        answered started with its ids, its expiry and personId, which is the server's alone.
//                   Rules 0 to 3 read no account, and rules 4 and 5 send the same statements whether or not one
//                   matches, so a pause, a cap and a start answer alike for any typed contact (K-21 schema line 780).
//   sendSignInCode  the code and its email row, after the page answered (item 59; ADR-016 section 1). In one
//                   transaction, by the database's clock:
//                     1. the contact's lock, the same as startSignIn's, on the attempt's own contact hash, read and
//                        locked in one statement, so the hash never leaves the database; no attempt is notFound
//                        (sign_in_attempts);
//                     2. the attempt, FOR UPDATE: one that names a code answers that send again, repeated (its code, its
//                        email row found by the attempt's id as its job id, the code's end); one with no person answers
//                        notSent noPerson; one whose expires_at is before now notSent attemptExpired; nothing written;
//                     3. the address, read for the attempt's person and never taken from the caller (K-22 rule 4): the
//                        account's email with email_proven_at set and its handle of kind email; none is notSent
//                        noProvenEmail;
//                     4. the handle's lock (DL-610, below), then proof_code_limits(<that handle>, 'sign_in', now() - 24
//                        hours, now()): CODES_PER_DAY (5) or more codes to it, every person and purpose, is notSent
//                        dayCap, and a sign-in code of it paused notSent codePaused;
//                     5. the writes: the proof_codes row (sign_in, the person, no business, that handle, email, the
//                        keyed hash and its secret's name, sent_at now(), expires_at 10 minutes on); the email row with
//                        no turn (job_id the attempt's id, that handle and person, no business, booking, question or
//                        copy, email, quick_reply, email_purpose code, not_after the code's expires_at as stored,
//                        versions_read empty, the request's bundle and trace), inserted planned at version 1, then given
//                        its plan and final parts and moved to checked at version 2 (K-07's two moves); the attempt's
//                        proof_code_id; and the three entries of ADR-016 section 1, answered sent.
//
// The locks (DL-546; DL-610). Both calls take K-22 rule 9's lock on the contact's hash before they read the attempts,
// the account or the day's codes, so two starts or two sends of one contact never both pass a count (T-322's security
// note b). One person can reach one email handle from two contacts, since a typed mobile may use way email (K-21 schema
// line 700), while proof_code_limits counts per handle; so sendSignInCode also takes a transaction lock on the handle,
// pg_advisory_xact_lock(hashtextextended('proof_code_limits:' || <handle id>, 0)), after the contact's and before it
// reads proof_code_limits: one send per handle at a time, from whichever contact. Every call takes them in one order,
// the contact's, the attempt's row, the handle's, so no two calls here wait on each other in a circle.
//
// Read committed (DL-610; K-22 README rule 9, DL-526's ruling). A count read after a lock must see what the lock's last
// holder committed, which only a statement's own snapshot gives: under repeatable read the snapshot would be taken
// before the wait. Both calls run in targets.ts's inRuntimeTransaction, whose BEGIN takes the server's default level,
// and the first statement each sends in it, after that helper's scope reset, checks that the level is read committed;
// at any other (a role or server whose default_transaction_isolation was changed) they throw before anything is read or
// written. That level is kept.
//
// Times (K-05 default 112; DL-546). Every time either call reads or writes is its transaction's now(), never one from
// the request, which carries none: started_at (its default) and expires_at, the counts' windows, the code's sent_at and
// expires_at, the row's not_after (the code's stored expires_at itself) and the entries' at (the code's sent_at as the
// insert returned it, to the millisecond).
//
// Role and scope (ADR-016 section 6; K-05 v1.13's calls table). Each runs on the client it is handed, the runtime
// side's, as rosie_job (the role is the connection's: nothing here checks it), with rosie.business_id set empty for the
// transaction (inRuntimeTransaction) and rosie.person_id never set. rosie_job holds SELECT, INSERT and UPDATE on
// sign_in_attempts (0034) and proof_codes (0020), SELECT on accounts, handles and person_roles, SELECT, INSERT and UPDATE
// on outbox_rows and SELECT and INSERT on event_log behind their runtime policies (0012), and EXECUTE on
// proof_code_limits, K-22's own definer function, the only one used. rosie_app, the Tool API's role, holds no grant on
// sign_in_attempts (0034), so its call is refused by privilege (42501, thrown as DataAccessDatabaseError).
//
// What never leaves (K-05 v1.13, "What the new tasks must hold to"; BP rule 7). No statement returns token_sha256,
// device_sha256, code_hash, contact_hash, request_sha256 or last_check_sha256, and none selects `*` of a sign-in table.
// The contact is read for the account alone and never kept. The code is only in the row's final parts, the words the page
// call made, never in a column, an answer or an entry. No answer or error holds a hash, the contact, an address or the
// words, and nothing here logs.
//
// Errors (K-05 README: every call may answer transient). A database rule that refuses a write (23505, 23514, 23503,
// 23P01) answers constraint, its SQLSTATE and the constraint's name alone; a serialization failure, a deadlock or a lost
// connection answers transient; any other database error is thrown scrubbed (clocks.ts transientOrScrubbed:
// DataAccessDatabaseError, its SQLSTATE and names alone). A request of the wrong shape throws a TypeError before any
// statement, naming the field and never a value; a record the answer would have to guess around throws
// BrokenRecordError. Nothing is written on any of them: each call is one transaction.
//
// Defaults used (for ops/QUESTIONS.md; each where no source decides):
//   1. A paused start's until is the moment K-22 rule 9 states, rounded up to the millisecond, the precision every K-05
//      answer's time carries (targets.ts utc), so it is never a moment at which the rule still holds; rows with whole
//      seconds (every fixture's) give it exactly.
//   2. A start's id (the attempt's server id, the job id of its code row and entries) and a send's code id and row id,
//      which name the entries (log-<id>-<move>), must be K-08 safe ids (letters, digits and _ . : / # -, never reading
//      as a number), as K-08 holds an entry's id and job_id; and a start's id must differ from its attempt id, which the
//      page holds (K-22 default 14: a page that knew the server's id could make a check's key). Each is refused with a
//      TypeError before any statement. The ids' 128 random bits are the page call's to draw (K-05 default 125; T-1282).
//   3. Rule 2 reads every attempt of the contact for its latest pause, without K-22 rule 9's optional 25-minute
//      narrowing (DL-546, from T-1274's database engineer note a): a pause set from a skewed clock still holds to its end.
//   4. A send's plan and final parts are K-05 v1.13 codeRowPlan and codeFinalParts exactly, as T-322's words.ts builds
//      them: the request's row named in both, no field beyond those, one words send of non-empty text; anything else is
//      refused with a TypeError before any statement (writePlan's code check, outbox.ts default 3).
//   5. A repeated send whose code has no row, or whose job id names no email row or more than one, throws
//      BrokenRecordError and answers nothing: a repeat never answers a send it cannot find.
//   6. The handle's lock key, 'proof_code_limits:' || the handle's id under 64-bit hashtextextended, is this file's (its
//      own name space, as outbox.ts keys its recipients'); another writer of codes to a handle (K-09's sendProofCode,
//      T-322) that takes the same key runs one at a time with this send.
import type * as K05 from "../../contracts/generated/data-access/data-access.v1.13";
import { commitSeqOf, transientOrScrubbed } from "./clocks";
import { appendEvent, type EventContext, type EventEntry } from "./event-log";
import type { Sql } from "./scope";
import { assertId, assertRequestShape, inRuntimeTransaction, utc } from "./targets";
import { BrokenRecordError } from "./turn-face-reads";

type Json = Parameters<Sql["json"]>[0];

// ---- the requests and the answers (data-access.v1.13.schema.json) --------------------------------------------------

/** K-05 v1.13 startSignIn.request: two ids, the start's and the device's sha256, the contact, its keyed hash, way email. */
export type StartSignInRequest = K05.StartSignInRequest;
/** K-05 v1.13 startSignIn.started: the attempt written, or a repeat's first; personId for the server alone. */
export type StartSignInStarted = K05.StartSignInStarted;
/** K-05 v1.13 startSignIn.paused: until when, and the rule that held; nothing written. */
export type StartSignInPaused = K05.StartSignInPaused;
export type StartSignInResponse = K05.StartSignInResponse;
/** K-05 v1.13 startSignIn.errors: constraint or transient; nothing written. */
export type StartSignInError = K05.StartSignInErrors;
export type StartSignInOutcome = StartSignInResponse | StartSignInError;

/** K-05 v1.13 sendSignInCode.request: the attempt, the trace, the bundle, the code's id and hash, the row and its words. */
export type SendSignInCodeRequest = K05.SendSignInCodeRequest;
/** K-05 v1.13 sendSignInCode.sent: the code, the row, its commit order and version, the code's end, three entries. */
export type SendSignInCodeSent = K05.SendSignInCodeSent;
/** K-05 v1.13 sendSignInCode.repeated: the first send's code, row and end; nothing written. */
export type SendSignInCodeRepeated = K05.SendSignInCodeRepeated;
/** K-05 v1.13 sendSignInCode.notSent: why nothing was written or sent. */
export type SendSignInCodeNotSent = K05.SendSignInCodeNotSent;
export type SendSignInCodeResponse = K05.SendSignInCodeResponse;
/** K-05 v1.13 sendSignInCode.errors: notFound (sign_in_attempts), constraint or transient; nothing written. */
export type SendSignInCodeError = K05.SendSignInCodeErrors;
export type SendSignInCodeOutcome = SendSignInCodeResponse | SendSignInCodeError;

const START = "startSignIn";
const SEND = "sendSignInCode";

/** ADR-016 rule 0's bound (SIGN_IN_STARTS_PER_HOUR; open point 13): starts of every contact in one hour. */
export const SIGN_IN_STARTS_PER_HOUR = 100;
/** ADR-016 rule 3's cap (SIGN_IN_STARTS_PER_DAY; open point 1): starts of one contact in a rolling 24 hours. */
export const SIGN_IN_STARTS_PER_DAY = 5;
/** K-05 item 59 step 4: codes to one handle in 24 hours, every person and purpose (S13-45; ADR-016 open point 1). */
export const CODES_PER_DAY = 5;
/** The handle's lock's name space (DL-610; default 6): 'proof_code_limits:' || the handle's id. */
export const HANDLE_LOCK_PREFIX = "proof_code_limits:";

const START_FIELDS = [
  "id",
  "attemptId",
  "requestSha256",
  "deviceSha256",
  "contact",
  "contactHash",
  "hashKeyName",
  "way",
] as const;
const SEND_FIELDS = [
  "signInAttemptId",
  "traceId",
  "bundle",
  "code",
  "emailRowId",
  "plan",
  "finalParts",
] as const;
/** K-05 v1.13 sha256Hex, the form of every hash K-22 v1.2 keeps. */
const SHA256 = /^[0-9a-f]{64}$/;
/** K-05 v1.13 hashKeyName: a Workers secret's name, never its value. */
const KEY_NAME = /^[A-Z][A-Z0-9_]*$/;
/** K-05 v1.12 emailOnFile: one @, no space, lower case (K-04 handles_address_form). */
const EMAIL = /^[^@\sA-Z]+@[^@\sA-Z]+$/;
/** K-05 v1 phoneNumber: E.164 (K-04 phones_number_form). */
const MOBILE = /^\+[1-9][0-9]{6,14}$/;
/** K-08 v1 safeId: letters, digits and _ . : / # -, starting with a letter or digit. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/#-]*$/;
/** K-08 v1 safeId's refusal: a run of digits and phone punctuation, seven or more long, reads as a number. */
const READS_AS_NUMBER = /^[0-9().+ -]{7,}$/;
/** A database rule that refuses a write answers `constraint` (K-05 README item 1). */
const CONSTRAINT_SQLSTATES = new Set(["23P01", "23514", "23505", "23503"]);
const NAME = /^[a-z_][a-z0-9_]{0,62}$/;
/** The one level these calls run at (DL-610), as PostgreSQL names it in transaction_isolation. */
const READ_COMMITTED = "read committed";

// ---- the requests' shape (defaults 2 and 4) ---------------------------------------------------------------------------

function fail(call: string, what: string): never {
  throw new TypeError(`${call}: ${what}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An object with exactly these keys and no other. */
function exactly(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isEmptyList(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

/** The request's fields, each present and no other (K-05 requests: additionalProperties false). */
function fieldsOf(request: unknown, call: string, fields: readonly string[]): Record<string, unknown> {
  assertRequestShape(request, call, fields);
  const values = request as Record<string, unknown>;
  for (const field of fields) {
    if (!Object.hasOwn(values, field)) {
      fail(call, `the request needs ${field}`);
    }
  }
  return values;
}

/** A K-08 safe id (default 2), named by its field, never by its value. */
function safeIdOf(call: string, value: unknown, what: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value) || READS_AS_NUMBER.test(value)) {
    fail(call, `${what} is a K-08 safe id (letters, digits and _ . : / # -), never a number or words`);
  }
  return value;
}

/** A sha256 or a keyed HMAC-SHA-256 in lower-case hex: a hash, never what it hashes. */
function hashOf(call: string, value: unknown, what: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail(call, `${what} is a sha256 in lower-case hex, never what it hashes`);
  }
  return value;
}

function keyNameOf(call: string, value: unknown, what: string): string {
  if (typeof value !== "string" || !KEY_NAME.test(value)) {
    fail(call, `${what} is a secret's name (A-Z, 0-9 and _), never its value`);
  }
  return value;
}

/** A start, checked: what its statements bind, the contact split for the account read. */
interface StartChecked {
  readonly id: string;
  readonly attemptId: string;
  readonly requestSha256: string;
  readonly deviceSha256: string;
  /** The typed email the account read looks for, or null. */
  readonly email: string | null;
  /** The typed mobile the account read looks for, or null. */
  readonly mobile: string | null;
  /** A link start reads no account (K-22 default 15). */
  readonly link: boolean;
  readonly contactHash: string;
  readonly hashKeyName: string;
}

/** K-05 v1.13 signInContact: an email in lower case, a mobile in E.164, or a link, each with its own fields alone. */
function contactOf(value: unknown): Pick<StartChecked, "email" | "mobile" | "link"> {
  if (exactly(value, ["kind", "address"]) && value.kind === "email") {
    if (typeof value.address !== "string" || !EMAIL.test(value.address)) {
      fail(START, "contact.address is an email address in lower case");
    }
    return { email: value.address, mobile: null, link: false };
  }
  if (exactly(value, ["kind", "number"]) && value.kind === "mobile") {
    if (typeof value.number !== "string" || !MOBILE.test(value.number)) {
      fail(START, "contact.number is a mobile number in E.164");
    }
    return { email: null, mobile: value.number, link: false };
  }
  if (exactly(value, ["kind"]) && value.kind === "link") {
    return { email: null, mobile: null, link: true };
  }
  return fail(START, "contact is an email, a mobile or a link, each with its own fields alone");
}

function checkStart(request: unknown): StartChecked {
  const values = fieldsOf(request, START, START_FIELDS);
  const id = safeIdOf(START, values.id, "id");
  const { attemptId } = values;
  assertId(attemptId, `${START}: attemptId`);
  if (attemptId === id) {
    fail(START, "id is the server's own and never the page's attempt id (default 2)");
  }
  if (values.way !== "email") {
    fail(START, "way is email: this version serves no other (refuse-start-sign-in-text-way)");
  }
  return {
    id,
    attemptId,
    requestSha256: hashOf(START, values.requestSha256, "requestSha256"),
    deviceSha256: hashOf(START, values.deviceSha256, "deviceSha256"),
    ...contactOf(values.contact),
    contactHash: hashOf(START, values.contactHash, "contactHash"),
    hashKeyName: keyNameOf(START, values.hashKeyName, "hashKeyName"),
  };
}

/** A send, checked: what its statements bind; the plan and final parts as given, checked (default 4). */
interface SendChecked {
  readonly attemptId: string;
  readonly traceId: string;
  readonly bundleHash: string;
  readonly bundleBuild: number;
  readonly codeId: string;
  readonly codeHash: string;
  readonly hashKeyName: string;
  readonly rowId: string;
  readonly plan: Json;
  readonly finalParts: Json;
}

/** K-05 v1.13 codeRowPlan, exactly (default 4): the row's own, email, no copy, text alone, no lines, question or thread. */
function checkPlan(plan: unknown, rowId: string): void {
  const inner = isRecord(plan) ? plan.plan : undefined;
  const right =
    exactly(plan, ["row", "channel", "copyOf", "plan"]) &&
    plan.row === rowId &&
    plan.channel === "email" &&
    plan.copyOf === null &&
    exactly(inner, ["formats", "lines", "question", "pageType", "threadReplyTo"]) &&
    Array.isArray(inner.formats) &&
    inner.formats.length === 1 &&
    inner.formats[0] === "text" &&
    isEmptyList(inner.lines) &&
    inner.question === null &&
    inner.pageType === null &&
    inner.threadReplyTo === null;
  if (!right) {
    fail(SEND, "plan is the email row's code-built plan (codeRowPlan), naming the request's row");
  }
}

/** K-05 v1.13 codeFinalParts, exactly (default 4): one words send of the code's line, nothing else. */
function checkFinalParts(parts: unknown, rowId: string): void {
  const sends = isRecord(parts) ? parts.sends : undefined;
  const send: unknown = Array.isArray(sends) && sends.length === 1 ? sends[0] : undefined;
  const right =
    exactly(parts, ["row", "channel", "sends", "fixedLines", "slotValues", "threadReplyTo"]) &&
    parts.row === rowId &&
    parts.channel === "email" &&
    exactly(send, ["kind", "text", "calendarFile", "options", "link"]) &&
    send.kind === "words" &&
    typeof send.text === "string" &&
    send.text !== "" &&
    send.calendarFile === "none" &&
    isEmptyList(send.options) &&
    send.link === null &&
    isEmptyList(parts.fixedLines) &&
    isEmptyList(parts.slotValues) &&
    parts.threadReplyTo === null;
  if (!right) {
    fail(SEND, "finalParts are the email row's one code line (codeFinalParts), naming the request's row");
  }
}

function checkSend(request: unknown): SendChecked {
  const values = fieldsOf(request, SEND, SEND_FIELDS);
  const attemptId = safeIdOf(SEND, values.signInAttemptId, "signInAttemptId");
  const { traceId, bundle, code } = values;
  assertId(traceId, `${SEND}: traceId`);
  if (
    !exactly(bundle, ["hash", "build"]) ||
    typeof bundle.hash !== "string" ||
    !SHA256.test(bundle.hash) ||
    typeof bundle.build !== "number" ||
    !Number.isSafeInteger(bundle.build) ||
    bundle.build < 1
  ) {
    fail(SEND, "bundle is a bundle id: a hash of 64 lower-case hex digits and a build from 1");
  }
  if (!exactly(code, ["id", "codeHash", "hashKeyName"])) {
    fail(SEND, "code takes id, codeHash and hashKeyName alone");
  }
  const rowId = safeIdOf(SEND, values.emailRowId, "emailRowId");
  checkPlan(values.plan, rowId);
  checkFinalParts(values.finalParts, rowId);
  return {
    attemptId,
    traceId,
    bundleHash: bundle.hash,
    bundleBuild: bundle.build,
    codeId: safeIdOf(SEND, code.id, "code.id"),
    // A code is never stored, only its keyed hash (refuse-send-sign-in-code-plain-code).
    codeHash: hashOf(SEND, code.codeHash, "code.codeHash"),
    hashKeyName: keyNameOf(SEND, code.hashKeyName, "code.hashKeyName"),
    rowId,
    plan: values.plan as Json,
    finalParts: values.finalParts as Json,
  };
}

// ---- shared by both calls -----------------------------------------------------------------------------------------

/**
 * The transaction's level, checked as its first statement (DL-610): read committed, so every statement after a lock
 * wait reads what the lock's holder committed. Any other level throws before anything is read or written.
 */
async function assertReadCommitted(tx: Sql, call: string): Promise<void> {
  const [row] = await tx<{ level: string }[]>`select current_setting('transaction_isolation') as level`;
  if (row?.level !== READ_COMMITTED) {
    throw new Error(
      `${call} runs at read committed only (DL-610): a count read after a lock must see what its holder committed`,
    );
  }
}

/** A database rule's refusal as K-05's constraint answer: the SQLSTATE and the constraint's name, nothing else. */
function constraintOf(error: unknown): K05.ConstraintError | null {
  const failure = error as { name?: unknown; code?: unknown; constraint_name?: unknown } | null | undefined;
  const code = failure?.code;
  const constraint = failure?.constraint_name;
  if (
    failure?.name === "PostgresError" &&
    typeof code === "string" &&
    CONSTRAINT_SQLSTATES.has(code) &&
    typeof constraint === "string" &&
    NAME.test(constraint)
  ) {
    return { error: "constraint", sqlstate: code, constraint };
  }
  return null;
}

// ---- startSignIn (item 58) ----------------------------------------------------------------------------------------

/** A count's window: how many attempts it holds, and when the rule stops holding (null under the limit). */
interface WindowRow {
  n: number;
  until: Date | null;
}

/** paused until the window's time, by its rule, when the window holds `limit` or more (K-22 rule 9; default 1). */
function pausedBy(
  window: WindowRow | undefined,
  limit: number,
  by: StartSignInPaused["by"],
): StartSignInPaused | null {
  if (window === undefined || window.n < limit) {
    return null;
  }
  if (window.until === null) {
    throw new Error(`${START}: a full window gave no time`);
  }
  return { result: "paused", until: utc(window.until), by };
}

/** The account's one statement (rule 4): how many accounts match, the person when one does, and its role flag. */
interface AccountRow {
  accounts: number;
  person_id: string | null;
  owner_or_admin: boolean;
}

/** The attempt as startSignIn answers it: never a hash. */
interface AttemptRow {
  id: string;
  attempt_id: string;
  expires_at: Date;
}

async function startIn(tx: Sql, req: StartChecked): Promise<StartSignInResponse> {
  await assertReadCommitted(tx, START);

  // Rule 0: the hour's bound, every contact's starts, read before any lock and any account.
  const [hour] = await tx<WindowRow[]>`
    with win as (
      select count(*)::integer as n,
             (array_agg(a.started_at order by a.started_at, a.id collate "C"))[
               count(*)::integer - ${SIGN_IN_STARTS_PER_HOUR} + 1
             ] + interval '1 hour' as u
      from sign_in_attempts a
      where a.started_at > now() - interval '1 hour'
    )
    select w.n,
           date_trunc('milliseconds', w.u)
             + case when w.u > date_trunc('milliseconds', w.u) then interval '1 millisecond' else interval '0' end
             as until
    from win w
  `;
  const hourBound = pausedBy(hour, SIGN_IN_STARTS_PER_HOUR, "hourBound");
  if (hourBound !== null) {
    return hourBound;
  }

  // Rule 9's lock on the contact's hash, the blocking form (DL-546): two starts of one contact run one after the other.
  await tx`select pg_advisory_xact_lock(hashtext('sign_in_attempts:' || ${req.contactHash}))`;

  // Rule 1: the repeat, by the request's key; nothing written, no code to follow.
  const [repeat] = await tx<AttemptRow[]>`
    select a.id, a.attempt_id, a.expires_at from sign_in_attempts a where a.request_sha256 = ${req.requestSha256}
  `;
  if (repeat !== undefined) {
    return {
      result: "started",
      id: repeat.id,
      attemptId: repeat.attempt_id,
      expiresAt: utc(repeat.expires_at),
      repeated: true,
      personId: null,
    };
  }

  // Rule 2: the contact's latest pause, every attempt of it (default 3).
  const [pause] = await tx<{ until: Date | null }[]>`
    with win as (
      select max(a.paused_until) as u
      from sign_in_attempts a
      where a.contact_hash = ${req.contactHash} and a.paused_until > now()
    )
    select date_trunc('milliseconds', w.u)
             + case when w.u > date_trunc('milliseconds', w.u) then interval '1 millisecond' else interval '0' end
             as until
    from win w
  `;
  if (pause !== undefined && pause.until !== null) {
    return { result: "paused", until: utc(pause.until), by: "contactPause" };
  }

  // Rule 3: the day's cap, the contact's starts in a rolling 24 hours.
  const [day] = await tx<WindowRow[]>`
    with win as (
      select count(*)::integer as n,
             (array_agg(a.started_at order by a.started_at, a.id collate "C"))[
               count(*)::integer - ${SIGN_IN_STARTS_PER_DAY} + 1
             ] + interval '24 hours' as u
      from sign_in_attempts a
      where a.contact_hash = ${req.contactHash} and a.started_at > now() - interval '24 hours'
    )
    select w.n,
           date_trunc('milliseconds', w.u)
             + case when w.u > date_trunc('milliseconds', w.u) then interval '1 millisecond' else interval '0' end
             as until
    from win w
  `;
  const dayCap = pausedBy(day, SIGN_IN_STARTS_PER_DAY, "dayCap");
  if (dayCap !== null) {
    return dayCap;
  }

  // Rule 4: the account, one statement whether or not one matches; none for a link (K-22 default 15).
  let personId: string | null = null;
  let ownerOrAdmin = false;
  if (!req.link) {
    const [account] = await tx<AccountRow[]>`
      select count(*)::integer as accounts,
             min(a.person_id) as person_id,
             coalesce(
               bool_or(exists (
                 select 1 from person_roles r
                 where r.person_id = a.person_id and r.role in ('owner', 'admin') and r.ended_at is null
               )),
               false
             ) as owner_or_admin
      from accounts a
      where (a.email = ${req.email} and a.email_proven_at is not null) or a.mobile = ${req.mobile}
    `;
    if (account?.accounts === 1 && account.person_id !== null) {
      personId = account.person_id;
      ownerOrAdmin = account.owner_or_admin;
    }
  }

  // Rule 5: the attempt, started_at its default now() (K-22 default 16), 10 minutes to run.
  const [inserted] = await tx<AttemptRow[]>`
    insert into sign_in_attempts (
      id, attempt_id, request_sha256, device_sha256, contact_hash, hash_key_name, way, person_id, owner_or_admin,
      expires_at
    ) values (
      ${req.id}, ${req.attemptId}, ${req.requestSha256}, ${req.deviceSha256}, ${req.contactHash}, ${req.hashKeyName},
      'email', ${personId}, ${ownerOrAdmin}, now() + interval '10 minutes'
    )
    returning id, attempt_id, expires_at
  `;
  if (inserted === undefined) {
    throw new Error(`${START}: the insert returned no row`);
  }
  return {
    result: "started",
    id: inserted.id,
    attemptId: inserted.attempt_id,
    expiresAt: utc(inserted.expires_at),
    repeated: false,
    personId,
  };
}

/**
 * A sign-in's start (K-05 v1.13 item 58), before the page answers: ADR-016 section 4's rules 0 to 5 under K-22 rule 9's
 * lock, in one read committed transaction on the primary, uncached, by the database's clock. Pass the runtime side's
 * client (rosie_job): the role is the connection's. Answers started (written, or a repeat's first with personId null)
 * or paused (hourBound, contactPause or dayCap, nothing written); constraint for an id or a key already taken and
 * transient, nothing written. Throws a TypeError for a request of the wrong shape before any statement, and any other
 * database error scrubbed (DataAccessDatabaseError). personId is the server's alone: never the page's or a span's.
 */
export async function startSignIn(sql: Sql, request: StartSignInRequest): Promise<StartSignInOutcome> {
  const checked = checkStart(request);
  try {
    return await inRuntimeTransaction(sql, { readOnly: false }, (tx) => startIn(tx, checked));
  } catch (error) {
    return constraintOf(error) ?? transientOrScrubbed(START, error);
  }
}

// ---- sendSignInCode (item 59) -------------------------------------------------------------------------------------

/** The attempt as the send reads it, locked: its person, its code, whether its 10 minutes have passed. */
interface SendAttemptRow {
  person_id: string | null;
  proof_code_id: string | null;
  expired: boolean;
}

/** The first send, answered again (step 2): its code, its row by the attempt's id as its job id, the code's end. */
async function repeatedSend(
  tx: Sql,
  attemptId: string,
  proofCodeId: string,
): Promise<SendSignInCodeRepeated> {
  const [code] = await tx<{ expires_at: Date }[]>`
    select c.expires_at from proof_codes c where c.id = ${proofCodeId}
  `;
  const rows = await tx<{ id: string }[]>`
    select o.id from outbox_rows o where o.job_id = ${attemptId} order by o.commit_seq
  `;
  const [row, ...more] = rows;
  if (code === undefined || row === undefined || more.length > 0) {
    throw new BrokenRecordError(`${SEND}: the attempt's code or its one email row is missing (default 5)`);
  }
  return {
    result: "sent",
    proofCodeId,
    outboxRowId: row.id,
    expiresAt: utc(code.expires_at),
    repeated: true,
  };
}

/** The three entries of ADR-016 section 1 (K-05 item 59), built from what the call wrote, never handed in. */
function entriesOf(
  req: SendChecked,
  personId: string,
  handleId: string,
  code: { sent_at: Date; expires_at: Date },
): EventEntry[] {
  const common = {
    zone: null,
    businessId: null,
    actorKind: "rosie",
    actorPersonId: null,
    actorRole: null,
    sealed: null,
    approvedBy: null,
    proofs: null,
    at: code.sent_at,
  } as const;
  return [
    {
      ...common,
      id: `log-${req.rowId}-created`,
      kind: "outbox_row.created",
      tableName: "outbox_rows",
      rowId: req.rowId,
      oldValues: null,
      newValues: { state: "planned", channel: "email", send_class: "quick_reply" },
      why: { step: "S11-52" },
    },
    {
      ...common,
      id: `log-${req.rowId}-planned`,
      kind: "outbox_row.planned",
      tableName: "outbox_rows",
      rowId: req.rowId,
      oldValues: { state: "planned" },
      newValues: { state: "checked" },
      why: { step: "S11-52" },
    },
    {
      ...common,
      id: `log-${req.codeId}-sent`,
      kind: "proof_code.sent",
      tableName: "proof_codes",
      rowId: req.codeId,
      oldValues: null,
      newValues: {
        person_id: personId,
        purpose: "sign_in",
        sent_to_handle_id: handleId,
        channel: "email",
        sent_at: utc(code.sent_at),
        expires_at: utc(code.expires_at),
      },
      why: { step: "S11-52" },
    },
  ];
}

async function sendIn(tx: Sql, req: SendChecked): Promise<SendSignInCodeResponse | K05.NotFoundError> {
  await assertReadCommitted(tx, SEND);

  // Step 1: the contact's lock, rule 9's, on the attempt's own contact hash, which never leaves the database.
  const located = await tx`
    select pg_advisory_xact_lock(hashtext('sign_in_attempts:' || a.contact_hash)) as locked
    from sign_in_attempts a
    where a.id = ${req.attemptId}
  `;
  if (located.length === 0) {
    return { error: "notFound", table: "sign_in_attempts", rowId: req.attemptId };
  }

  // Step 2: the attempt, locked.
  const [attempt] = await tx<SendAttemptRow[]>`
    select a.person_id, a.proof_code_id, a.expires_at < now() as expired
    from sign_in_attempts a
    where a.id = ${req.attemptId}
    for update
  `;
  if (attempt === undefined) {
    throw new BrokenRecordError(`${SEND}: the attempt it locked is gone`);
  }
  if (attempt.proof_code_id !== null) {
    return repeatedSend(tx, req.attemptId, attempt.proof_code_id);
  }
  if (attempt.person_id === null) {
    return { result: "notSent", why: "noPerson" };
  }
  if (attempt.expired) {
    return { result: "notSent", why: "attemptExpired" };
  }
  const personId = attempt.person_id;

  // Step 3: the address, the person's proven email and its handle, never the caller's (K-22 rule 4).
  const [address] = await tx<{ handle_id: string }[]>`
    select h.id as handle_id
    from accounts a
    join handles h on h.address = a.email and h.kind = 'email'
    where a.person_id = ${personId} and a.email_proven_at is not null
  `;
  if (address === undefined) {
    return { result: "notSent", why: "noProvenEmail" };
  }
  const handleId = address.handle_id;

  // Step 4: the handle's lock (DL-610: one person, two contacts, one handle), then its day's codes, read after it.
  await tx`select pg_advisory_xact_lock(hashtextextended(${HANDLE_LOCK_PREFIX + handleId}, 0))`;
  const [limits] = await tx<{ sent_since: number; paused: boolean }[]>`
    select l.sent_since, l.paused_until is not null as paused
    from proof_code_limits(${handleId}, 'sign_in', now() - interval '24 hours', now()) l
  `;
  if (limits === undefined) {
    throw new BrokenRecordError(`${SEND}: proof_code_limits answered no row`);
  }
  if (limits.sent_since >= CODES_PER_DAY) {
    return { result: "notSent", why: "dayCap" };
  }
  if (limits.paused) {
    return { result: "notSent", why: "codePaused" };
  }

  // Step 5: the code, its email row (planned, then checked with its plan and final parts), the attempt's code id, and
  // the three entries, all in this transaction.
  const [code] = await tx<{ sent_at: Date; expires_at: Date }[]>`
    insert into proof_codes (
      id, purpose, person_id, business_id, sent_to_handle_id, channel, code_hash, hash_key_name, sent_at, expires_at
    ) values (
      ${req.codeId}, 'sign_in', ${personId}, null, ${handleId}, 'email', ${req.codeHash}, ${req.hashKeyName}, now(),
      now() + interval '10 minutes'
    )
    returning sent_at, expires_at
  `;
  if (code === undefined) {
    throw new Error(`${SEND}: the code's insert returned no row`);
  }
  const [row] = await tx<{ commit_seq: string | number }[]>`
    insert into outbox_rows (
      id, turn_id, job_id, recipient_handle_id, recipient_person_id, business_id, booking_id, channel, send_class,
      versions_read, open_question_id, copy_of_row_id, bundle_hash, bundle_build, trace_id, email_purpose, not_after
    ) values (
      ${req.rowId}, null, ${req.attemptId}, ${handleId}, ${personId}, null, null, 'email', 'quick_reply',
      '[]'::jsonb, null, null, ${req.bundleHash}, ${req.bundleBuild}, ${req.traceId}, 'code',
      (select c.expires_at from proof_codes c where c.id = ${req.codeId})
    )
    returning commit_seq
  `;
  const [checked] = await tx<{ version: number }[]>`
    update outbox_rows
    set plan = ${tx.json(req.plan)}, final_parts = ${tx.json(req.finalParts)}, state = 'checked', version = 2
    where id = ${req.rowId} and version = 1 and state = 'planned'
    returning version
  `;
  const [given] = await tx<{ version: number }[]>`
    update sign_in_attempts a
    set proof_code_id = ${req.codeId}, version = a.version + 1
    where a.id = ${req.attemptId} and a.proof_code_id is null
    returning a.version
  `;
  if (row === undefined || checked?.version !== 2 || given === undefined) {
    throw new Error(`${SEND}: the email row or the attempt did not take its write`);
  }
  const context: EventContext = { turnId: null, jobId: req.attemptId, traceId: req.traceId, bundle: null };
  const entries = entriesOf(req, personId, handleId, code);
  for (const entry of entries) {
    await appendEvent(tx, context, entry);
  }
  const [created, planned, sent] = entries.map((entry) => entry.id);
  if (created === undefined || planned === undefined || sent === undefined) {
    throw new Error(`${SEND}: three entries are written`);
  }
  return {
    result: "sent",
    proofCodeId: req.codeId,
    outboxRowId: req.rowId,
    commitSeq: commitSeqOf(row.commit_seq),
    version: 2,
    expiresAt: utc(code.expires_at),
    entryIds: [created, planned, sent],
    repeated: false,
  };
}

/**
 * A sign-in's code and its email row (K-05 v1.13 item 59), after the page answered: the code row, the email row with no
 * turn written checked with its plan and final parts, the attempt's code id and three entries, under K-22 rule 9's lock
 * and the handle's (DL-610), in one read committed transaction on the primary, uncached, by the database's clock. Pass
 * the runtime side's client (rosie_job): the role is the connection's. Answers sent, sent repeated (the first send,
 * nothing written) or notSent (noPerson, attemptExpired, noProvenEmail, dayCap, codePaused: nothing written); notFound
 * (sign_in_attempts), constraint or transient, nothing written. Throws a TypeError for a request of the wrong shape before
 * any statement, a BrokenRecordError for a record it would have to guess around, and any other database error scrubbed
 * (DataAccessDatabaseError). The code is in the final parts alone: never in an answer, an entry or an error.
 */
export async function sendSignInCode(
  sql: Sql,
  request: SendSignInCodeRequest,
): Promise<SendSignInCodeOutcome> {
  const checked = checkSend(request);
  try {
    return await inRuntimeTransaction(sql, { readOnly: false }, (tx) => sendIn(tx, checked));
  } catch (error) {
    return constraintOf(error) ?? transientOrScrubbed(SEND, error);
  }
}
