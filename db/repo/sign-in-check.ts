// Data-access v1.13: a sign-in's check side (K-05 v1.13 items 60 to 63; ADR-016 sections 4 and 6 and section 7's card
// R2; K-22 v1.2 rule 9's check; T-1284; DL-526, DL-610). The send side, startSignIn and sendSignInCode, is
// db/repo/sign-in-send.ts's (T-1280); the page calls that make these calls are T-1285's.
//
//   proveSignIn     a typed code's check (item 60), as the Tool API (rosie_app), in one transaction, in K-22 rule 9's
//                   order, every time the transaction's own now() (README default 112):
//                     1. the binding: sign_in_attempt(attemptId, deviceSha256, now()) locks the attempt FOR UPDATE; no
//                        row (an unknown id, another device, a null) answers attemptNotFound alone, nothing written;
//                     2. the check's key, sha256 of the attempt's id, the device's sha256 and requestId, a line feed
//                        between (K-22 rule 9 last_check_sha256; default 120: made here from the id the binding
//                        answered, which the page never learns), and the look, sign_in_attempt_tried(id, key, NULL,
//                        now()), which writes nothing: a repeat answers its first result, repeated (signedIn as
//                        alreadySignedIn, with no token), and never reaches check_proof_code;
//                     3. the attempt's own state, each recorded with its label and no try counted, before any code is
//                        checked: signed in answers alreadySignedIn, paused answers paused until its paused_until,
//                        past its expires_at answers expired. So a sixth check after five wrong ones answers paused
//                        from the server, cookie or none (STATE note 74);
//                     4. the code: check_proof_code(proof_code_id, typedHash, now()); an attempt with no code (no
//                        account, or no code yet) passes a null id, which answers unknown before any write;
//                     5. right: rosie.person_id set to the attempt's person (scope.ts setPersonScope, in this
//                        transaction: K-22 rule 4), device_known(deviceSha256), and for an attempt whose person held a
//                        live owner or admin role at its start, who has had a session (rule 5's select policy now
//                        shows the person's own), on a device device_known does not know, secondProofNeeded, recorded,
//                        no session; else the session inserted under rule 5's insert policy (its id and token's sha256
//                        the request's, the device's sha256, proven_via code, the attempt's code, started_at and
//                        last_seen_at now, expires_at 30 days on: default 124), the check recorded signedIn and
//                        sign_in_attempt_signed_in(id, session id). used: secondProofNeeded again, recorded. wrong,
//                        paused, expired and unknown: one wrong try, sign_in_attempt_tried(id, key, 'wrong', now()),
//                        and the answer is the attempt's after it, wrong with 5 less its wrong_tries left, or at the
//                        fifth paused until its paused_until (DL-526: every answer to a code that is not right comes
//                        from the attempt, so it is the same with or without an account and a code).
//                   The transaction then commits, and only then is its answer built: a wrong try is committed before
//                   anything that could fail after it, so it counts whatever fails after (K-22 README, the check's step
//                   5; ADR-016 section 4). A session the database refuses (an id or a token hash taken, 23505) answers
//                   constraint, and the whole transaction, the code's use included, rolls back.
//   endSession      a sign-out (item 61), as rosie_app, in one transaction: session_for_token(tokenSha256, now()); none
//                   (unknown, ended or expired) answers signedOut repeated, naming nothing and changing nothing; else
//                   rosie.person_id is set to its person and the session is ended now, signed_out, its version raised,
//                   under rule 5's update policy (only that person's own live session).
//   personStanding  the standing a signedIn answer gives (item 62), as rosie_job, in one read-only transaction: the
//                   person's live roles at every business but customer, in role id order, in K-21's names (default
//                   121); team, a live K-36 team row; tester, the same row (v1.12 default 103; default 122).
//   signInEntries   a check's or a sign-out's entries (item 63; DL-610: built here), as rosie_job, in one transaction:
//                   from the ids it is asked, it reads every value from the rows (default 119), and writes one entry
//                   per change of the row not yet logged, insert ... on conflict (id) do nothing, so a repeat writes
//                   nothing.
//
// The isolation level (DL-610; K-22 README, DL-526's ruling): proveSignIn and endSession run at READ COMMITTED, stated
// in their BEGIN, never the database's default taken on trust. proveSignIn locks the attempt and then reads the attempt,
// its code and the person's sessions in later statements, and each must see what committed before it ran: a check that
// waited on the attempt's lock while the send wrote the attempt's code must find that code (each statement of a READ
// COMMITTED transaction takes its own snapshot), where REPEATABLE READ would refuse the locked row as changed since the
// transaction's snapshot (40001) or read a code row older than the lock. So a check whose transaction began before the
// send's commit reads the code with an `at` earlier than its sent_at, which check_proof_code answers expired before any
// write (0020 line 748), and step 5 counts that as one wrong try of the attempt, as it counts the null id's unknown
// (DL-526's ruling): the attempt with a code and its twin with none count the same try. Keep the level: a later change
// to it breaks that rule.
//
// Roles and scope (README v1.13; ADR-016 section 6; ADR-014): each call runs on the client it is handed, and the role is
// the connection's: proveSignIn and endSession on the Tool API's (rosie_app), personStanding and signInEntries on the
// runtime side's (rosie_job). Each transaction sets rosie.business_id empty (a sign-in has no business: proof_codes and
// sessions are scoped none); proveSignIn and endSession also set rosie.person_id empty at their start, so a setting a
// connection kept never acts for anyone, and set it to a person only where item 60 or 61 says, through scope.ts's
// setter, for that transaction alone. rosie_app reaches an attempt only through K-22's three functions (no grant on
// sign_in_attempts), a code only through check_proof_code, and a session through session_for_token, device_known and
// rule 5's policies.
//
// Only hashes travel, and none leaves a call (README v1.13, "What the new tasks must hold to"): no statement returns
// token_sha256, device_sha256, code_hash, contact_hash, request_sha256 or last_check_sha256 (the session insert writes
// its two hashes and returns only its end); no answer, error or entry holds a hash, a token, the contact or the code's
// words. Nothing here logs.
//
// Errors (K-05 README: every call may answer transient). A serialization failure, a deadlock or a lost connection answers
// transient, with only its SQLSTATE (clocks.ts transientOrScrubbed). Any other database error is thrown scrubbed, as
// DataAccessDatabaseError with its SQLSTATE and names alone (clocks.ts scrubbed). A request of the wrong shape throws a
// TypeError before any statement is sent, naming the field, never its value; a record the answer would have to guess
// around throws a BrokenRecordError.
//
// Defaults used (for ops/QUESTIONS.md; each where no source decides):
//   1. A request is refused before any statement for its shape alone (default 1 of test-phone-reads.ts): a field beside
//      the call's own; an id that is not a non-empty string with no NUL; a sha256 that is not 64 lower-case hex
//      characters (a device cookie, a code, a token passed as its hash among them: refuse-end-session-token-not-hash);
//      entries that are not one or two asks of K-05's two forms (refuse-sign-in-entries-caller-values).
//   2. proveSignIn and endSession set rosie.person_id empty at their transaction's start, as inRuntimeTransaction sets
//      rosie.business_id: K-22 reads '' as no person (rule 4), so "unset until right" holds on a pooled connection
//      whatever an earlier session left on it.
//   3. A repeated check's first result is answered from the look's row (sign_in_attempt_tried with a NULL outcome): the
//      attempt's wrong_tries and paused_until, which no later check changed, since the key is the attempt's last check;
//      its proofCodeId is the attempt's code, as the binding answers it.
//   4. A session.started entry's values are the session row's as stored when the entries run (README item 63: "reads
//      every value from the row's plain columns"), so one written late carries the row's last_seen_at at that time (open
//      gap 70's rule for a late entry's time).
//   5. A used code with no person (a listing's control code, never a sign-in's) logs its use with actor Rosie, since K-04
//      event_log_person_actor needs a person for actor person.
import { createHash } from "node:crypto";
import type * as K05 from "../../contracts/generated/data-access/data-access.v1.13";
import { DataAccessDatabaseError, scrubbed, transientOrScrubbed } from "./clocks";
import { PERSON_SETTING, SCOPE_SETTING, setPersonScope, type Sql, type Tx } from "./scope";
import { assertRequestShape, inRuntimeTransaction, utc } from "./targets";
import { BrokenRecordError } from "./turn-face-reads";

type Json = Parameters<Sql["json"]>[0];

// ---- the requests and the answers (data-access.v1.13.schema.json) ------------------------------------------------------

/** K-05 v1.13 proveSignIn.request: the page's attempt id, the device's sha256, the check's request id, the typed code's
 * keyed hash and the session a right code starts; never the cookie, the code, the token or a time. */
export type ProveSignInRequest = K05.ProveSignInRequest;
/** K-05 v1.13 proveSignIn.response: K-21's label with what the server needs (never a hash). */
export type ProveSignInResponse = K05.ProveSignInResponse;
/** K-05 v1.13 proveSignIn.errors: attemptNotFound, constraint or transient. */
export type ProveSignInError = K05.ProveSignInErrors;
export type ProveSignInOutcome = ProveSignInResponse | ProveSignInError;

/** K-05 v1.13 endSession.request: the session token's sha256 alone. */
export type EndSessionRequest = K05.EndSessionRequest;
/** K-05 v1.13 endSession.response: signedOut, naming the session and person it ended, or repeated. */
export type EndSessionResponse = K05.EndSessionResponse;
/** K-05 v1.13 endSession.errors: transient alone. */
export type EndSessionError = K05.EndSessionErrors;
export type EndSessionOutcome = EndSessionResponse | EndSessionError;

/** K-05 v1.13 personStanding.request: the person proveSignIn answered. */
export type PersonStandingRequest = K05.PersonStandingRequest;
/** K-05 v1.13 personStanding.response: the live roles but customer, team and tester. */
export type PersonStandingResponse = K05.PersonStandingResponse;
/** K-05 v1.13 personStanding.errors: transient alone. */
export type PersonStandingError = K05.PersonStandingErrors;
export type PersonStandingOutcome = PersonStandingResponse | PersonStandingError;

/** K-05 v1.13 signInEntries.request: the job id, the trace and one or two asks, each a row by its id alone. */
export type SignInEntriesRequest = K05.SignInEntriesRequest;
/** K-05 v1.13 signInEntries.response: each entry the rows called for, written now or found written. */
export type SignInEntriesResponse = K05.SignInEntriesResponse;
/** K-05 v1.13 signInEntries.errors: notFound (an asked row) or transient. */
export type SignInEntriesError = K05.SignInEntriesErrors;
export type SignInEntriesOutcome = SignInEntriesResponse | SignInEntriesError;

type ConstraintAnswer = Extract<ProveSignInError, { error: "constraint" }>;
type NotFoundAnswer = Extract<SignInEntriesError, { error: "notFound" }>;
type EntryKind = SignInEntriesResponse["entries"][number]["kind"];
type StandingRole = PersonStandingResponse["roles"][number]["role"];

const PROVE = "proveSignIn";
const END = "endSession";
const STANDING = "personStanding";
const ENTRIES = "signInEntries";
/** K-05 v1.13 sha256Hex and tokenSha256 (K-22's hash forms): a sha256 in lower-case hex. */
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** RULES 6.2: five wrong codes pause it (K-22 sign_in_attempts_wrong_tries_range). */
const TRIES = 5;
/** A database rule that refuses a write answers constraint (K-05 README item 1), as clocks.ts reads one. */
const CONSTRAINT_SQLSTATES = new Set(["23P01", "23514", "23505", "23503"]);
/** README item 63's why for a code's and a session's start: S11-52, the portal sign-in. */
const SIGN_IN_STEP = { step: "S11-52" };
/** K-21's labels sign_in_attempt_tried records (K-22 sign_in_attempts_outcome_known), as far as a check writes them. */
type RecordedLabel = "signedIn" | "secondProofNeeded" | "wrong" | "paused" | "expired" | "alreadySignedIn";

// ---- the requests' shape (default 1) ----------------------------------------------------------------------------------

/** The request's fields as a record, refused unless it is a plain object with no field but the call's own. */
function fieldsOf(request: unknown, call: string, fields: readonly string[]): Record<string, unknown> {
  assertRequestShape(request, call, fields);
  return request as Record<string, unknown>;
}

/** K-05 id: a non-empty string with no NUL, compared whole and never parsed (CQ-09). Names the field, never the value. */
function idOf(call: string, value: unknown, what: string): string {
  if (typeof value !== "string" || value === "" || value.includes("\u0000")) {
    throw new TypeError(`${call}: ${what} is a non-empty id`);
  }
  return value;
}

/** K-05 v1.13 sha256Hex: 64 lower-case hex characters, never the value it hashes. Names the field, never the value. */
function hashOf(call: string, value: unknown, what: string): string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new TypeError(`${call}: ${what} is a sha256 in lower-case hex, never the value it hashes`);
  }
  return value;
}

interface ProveAsked {
  attemptId: string;
  deviceSha256: string;
  requestId: string;
  typedHash: string;
  sessionId: string;
  tokenSha256: string;
}

function proveRequestOf(request: unknown): ProveAsked {
  const fields = fieldsOf(request, PROVE, ["attemptId", "deviceSha256", "requestId", "typedHash", "session"]);
  const session = fieldsOf(fields.session, `${PROVE} session`, ["id", "tokenSha256"]);
  return {
    attemptId: idOf(PROVE, fields.attemptId, "attemptId"),
    deviceSha256: hashOf(PROVE, fields.deviceSha256, "deviceSha256"),
    requestId: idOf(PROVE, fields.requestId, "requestId"),
    typedHash: hashOf(PROVE, fields.typedHash, "typedHash"),
    sessionId: idOf(PROVE, session.id, "session.id"),
    tokenSha256: hashOf(PROVE, session.tokenSha256, "session.tokenSha256"),
  };
}

type Ask =
  | { kind: "proof_code.checked"; proofCodeId: string }
  | { kind: "session.started" | "session.ended"; sessionId: string };

interface EntriesAsked {
  jobId: string;
  traceId: string;
  asks: Ask[];
}

function askOf(value: unknown, index: number): Ask {
  const what = `entries[${String(index)}]`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${ENTRIES}: ${what} is an object`);
  }
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "proof_code.checked") {
    const fields = fieldsOf(value, `${ENTRIES} ${what}`, ["kind", "proofCodeId"]);
    return { kind, proofCodeId: idOf(ENTRIES, fields.proofCodeId, `${what}.proofCodeId`) };
  }
  if (kind === "session.started" || kind === "session.ended") {
    const fields = fieldsOf(value, `${ENTRIES} ${what}`, ["kind", "sessionId"]);
    return { kind, sessionId: idOf(ENTRIES, fields.sessionId, `${what}.sessionId`) };
  }
  throw new TypeError(`${ENTRIES}: ${what}.kind is proof_code.checked, session.started or session.ended`);
}

function entriesRequestOf(request: unknown): EntriesAsked {
  const fields = fieldsOf(request, ENTRIES, ["jobId", "traceId", "entries"]);
  const entries = fields.entries;
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 2) {
    throw new TypeError(`${ENTRIES}: entries is a list of one or two asks`);
  }
  return {
    jobId: idOf(ENTRIES, fields.jobId, "jobId"),
    traceId: idOf(ENTRIES, fields.traceId, "traceId"),
    asks: entries.map((ask: unknown, index) => askOf(ask, index)),
  };
}

// ---- the Tool API's transaction (proveSignIn, endSession) -------------------------------------------------------------

/**
 * One transaction on the Tool API's client at READ COMMITTED, stated in its BEGIN and kept (DL-610: the lock-then-read
 * needs a fresh snapshot per statement; the header says why). Its first statement sets no business and no person for
 * the transaction (default 2); `fn` sets a person only through scope.ts's setter.
 */
async function inToolApiTransaction<T>(sql: Sql, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const result = await sql.begin("isolation level read committed", async (tx) => {
    await tx`select set_config(${SCOPE_SETTING}, '', true), set_config(${PERSON_SETTING}, '', true)`;
    return fn(tx);
  });
  return result as T;
}

/** A database rule's refusal as K-05's constraint answer, from clocks.ts's scrubbed error: its SQLSTATE and name alone. */
function constraintOf(call: string, error: unknown): ConstraintAnswer | null {
  const clean = scrubbed(call, error);
  if (
    clean instanceof DataAccessDatabaseError &&
    CONSTRAINT_SQLSTATES.has(clean.code) &&
    clean.constraint !== null
  ) {
    return { error: "constraint", sqlstate: clean.code, constraint: clean.constraint };
  }
  return null;
}

// ---- proveSignIn (item 60) --------------------------------------------------------------------------------------------

/** sign_in_attempt's answer (K-22 rule 9), the columns the check reads: never a hash (the function returns none). */
interface Binding {
  id: string;
  person_id: string | null;
  owner_or_admin: boolean;
  proof_code_id: string | null;
  expired: boolean;
  paused_until: Date | null;
  paused: boolean;
  signed_in: boolean;
}

/** sign_in_attempt_tried's answer: whether the key repeats the last check, and the attempt's tries, pause and answer. */
interface Tried {
  repeated: boolean;
  wrong_tries: number;
  paused_until: Date | null;
  last_outcome: string | null;
}

/** What the committed check gives the answer, which is built only after the commit. */
type Checked =
  | { kind: "notFound" }
  | { kind: "repeat"; binding: Binding; tried: Tried }
  | { kind: "state"; binding: Binding; outcome: "alreadySignedIn" | "paused" | "expired" }
  | {
      kind: "signedIn";
      binding: Binding;
      personId: string;
      proofCodeId: string;
      sessionId: string;
      expiresAt: Date;
    }
  | { kind: "secondProof"; binding: Binding; personId: string; proofCodeId: string }
  | { kind: "tried"; binding: Binding; tried: Tried };

/** The check's key (K-22 rule 9 last_check_sha256; default 120): never over a typed code. */
function checkKeyOf(id: string, deviceSha256: string, requestId: string): string {
  return createHash("sha256").update(`${id}\n${deviceSha256}\n${requestId}`, "utf8").digest("hex");
}

/** sign_in_attempt_tried(id, key, outcome, now()): the look with outcome null, else the check recorded. */
async function recordCheck(tx: Tx, id: string, key: string, outcome: RecordedLabel | null): Promise<Tried> {
  const [row] = await tx<Tried[]>`
    select repeated, wrong_tries, paused_until, last_outcome
    from sign_in_attempt_tried(${id}, ${key}, ${outcome}::text, now())
  `;
  if (row === undefined) {
    throw new BrokenRecordError(`${PROVE}: the attempt the binding locked took no check`);
  }
  return row;
}

/** The attempt's person, which a code names (sign_in_attempts_code_has_person): none is a broken record. */
function personOf(binding: Binding): string {
  if (binding.person_id === null) {
    throw new BrokenRecordError(`${PROVE}: an attempt whose code was checked names no person`);
  }
  return binding.person_id;
}

/**
 * Step 5's right code: the person set for this transaction, device_known, and the second proof or the session. Every
 * read of sessions here is rule 5's, as the person, and only after the code was right.
 */
async function signInIn(
  tx: Tx,
  asked: ProveAsked,
  binding: Binding,
  key: string,
  proofCodeId: string,
): Promise<Checked> {
  const personId = personOf(binding);
  await setPersonScope(tx, personId);
  const [device] = await tx<{ known: boolean }[]>`select device_known(${asked.deviceSha256}) as known`;
  if (binding.owner_or_admin && device?.known !== true) {
    const [earlier] = await tx<{ had: boolean }[]>`
      select exists (select 1 from sessions s where s.person_id = ${personId}) as had
    `;
    if (earlier?.had === true) {
      await recordCheck(tx, binding.id, key, "secondProofNeeded");
      return { kind: "secondProof", binding, personId, proofCodeId };
    }
  }
  const [session] = await tx<{ expires_at: Date }[]>`
    insert into sessions (
      id, person_id, token_sha256, device_sha256, proven_via, proof_code_id, started_at, last_seen_at, expires_at
    ) values (
      ${asked.sessionId}, ${personId}, ${asked.tokenSha256}, ${asked.deviceSha256}, 'code', ${proofCodeId}, now(), now(),
      now() + interval '30 days'
    )
    returning expires_at
  `;
  if (session === undefined) {
    throw new BrokenRecordError(`${PROVE}: the session insert returned no row`);
  }
  await recordCheck(tx, binding.id, key, "signedIn");
  const [named] = await tx<{ named: boolean }[]>`
    select sign_in_attempt_signed_in(${binding.id}, ${asked.sessionId}) as named
  `;
  if (named?.named !== true) {
    throw new BrokenRecordError(`${PROVE}: the attempt did not take the session its code started`);
  }
  return {
    kind: "signedIn",
    binding,
    personId,
    proofCodeId,
    sessionId: asked.sessionId,
    expiresAt: session.expires_at,
  };
}

/** K-22 rule 9's check, steps 1 to 5, in the Tool API's transaction. Writes nothing on attemptNotFound or a repeat. */
async function checkIn(tx: Tx, asked: ProveAsked): Promise<Checked> {
  // Step 1: the binding, locked; no row for an unknown id, another device or a null.
  const [binding] = await tx<Binding[]>`
    select id, person_id, owner_or_admin, proof_code_id, expired, paused_until, paused, signed_in
    from sign_in_attempt(${asked.attemptId}, ${asked.deviceSha256}, now())
  `;
  if (binding === undefined) {
    return { kind: "notFound" };
  }
  // Step 2: the key and the look; a repeat answers its first result and counts nothing.
  const key = checkKeyOf(binding.id, asked.deviceSha256, asked.requestId);
  const look = await recordCheck(tx, binding.id, key, null);
  if (look.repeated) {
    return { kind: "repeat", binding, tried: look };
  }
  // Step 3: the attempt's own state, recorded with its label, no try counted.
  const state = binding.signed_in
    ? "alreadySignedIn"
    : binding.paused
      ? "paused"
      : binding.expired
        ? "expired"
        : null;
  if (state !== null) {
    await recordCheck(tx, binding.id, key, state);
    return { kind: "state", binding, outcome: state };
  }
  // Step 4: the code; a null id (no code) answers unknown before any write.
  const [code] = await tx<{ answer: string | null }[]>`
    select check_proof_code(${binding.proof_code_id}::text, ${asked.typedHash}, now()) as answer
  `;
  const answer = code?.answer ?? null;
  // Step 5.
  if (answer === "right" && binding.proof_code_id !== null) {
    return signInIn(tx, asked, binding, key, binding.proof_code_id);
  }
  if (answer === "used" && binding.proof_code_id !== null) {
    await recordCheck(tx, binding.id, key, "secondProofNeeded");
    return { kind: "secondProof", binding, personId: personOf(binding), proofCodeId: binding.proof_code_id };
  }
  if (answer === "wrong" || answer === "paused" || answer === "expired" || answer === "unknown") {
    // One wrong try of the attempt (DL-526); nothing more is written, and the transaction commits.
    return { kind: "tried", binding, tried: await recordCheck(tx, binding.id, key, "wrong") };
  }
  throw new BrokenRecordError(`${PROVE}: check_proof_code gave no answer the check knows`);
}

/** The answer read from the attempt's row as a check left it (step 5's wrong path, or a repeat's first result). */
function fromAttempt(binding: Binding, tried: Tried, repeated: boolean): ProveSignInResponse {
  const signInAttemptId = binding.id;
  const proofCodeId = binding.proof_code_id;
  switch (tried.last_outcome) {
    case "wrong": {
      const triesLeft = TRIES - tried.wrong_tries;
      if (triesLeft < 1 || triesLeft > TRIES - 1) {
        throw new BrokenRecordError(`${PROVE}: a wrong check left the attempt with no tries to count`);
      }
      return { outcome: "wrong", signInAttemptId, triesLeft, proofCodeId, repeated };
    }
    case "paused": {
      if (tried.paused_until === null) {
        throw new BrokenRecordError(`${PROVE}: a paused check left the attempt with no pause`);
      }
      return { outcome: "paused", signInAttemptId, until: utc(tried.paused_until), proofCodeId, repeated };
    }
    case "expired":
      return { outcome: "expired", signInAttemptId, proofCodeId, repeated };
    case "signedIn":
    case "alreadySignedIn":
      return { outcome: "alreadySignedIn", signInAttemptId, repeated };
    case "secondProofNeeded": {
      if (proofCodeId === null) {
        throw new BrokenRecordError(`${PROVE}: a second proof's attempt names no code`);
      }
      return {
        outcome: "secondProofNeeded",
        signInAttemptId,
        personId: personOf(binding),
        proofCodeId,
        repeated,
      };
    }
    default:
      throw new BrokenRecordError(`${PROVE}: the attempt's last check holds no answer the check knows`);
  }
}

/** The committed check as K-05's answer (built after the commit, so a wrong try counts whatever fails here). */
function answerOf(
  checked: Checked,
): ProveSignInResponse | Extract<ProveSignInError, { error: "attemptNotFound" }> {
  switch (checked.kind) {
    case "notFound":
      return { error: "attemptNotFound" };
    case "repeat":
      return fromAttempt(checked.binding, checked.tried, true);
    case "tried":
      return fromAttempt(checked.binding, checked.tried, false);
    case "state": {
      const { binding } = checked;
      if (checked.outcome === "alreadySignedIn") {
        return { outcome: "alreadySignedIn", signInAttemptId: binding.id, repeated: false };
      }
      if (checked.outcome === "expired") {
        return {
          outcome: "expired",
          signInAttemptId: binding.id,
          proofCodeId: binding.proof_code_id,
          repeated: false,
        };
      }
      if (binding.paused_until === null) {
        throw new BrokenRecordError(`${PROVE}: a paused attempt holds no pause`);
      }
      return {
        outcome: "paused",
        signInAttemptId: binding.id,
        until: utc(binding.paused_until),
        proofCodeId: binding.proof_code_id,
        repeated: false,
      };
    }
    case "secondProof":
      return {
        outcome: "secondProofNeeded",
        signInAttemptId: checked.binding.id,
        personId: checked.personId,
        proofCodeId: checked.proofCodeId,
        repeated: false,
      };
    case "signedIn":
      return {
        outcome: "signedIn",
        signInAttemptId: checked.binding.id,
        personId: checked.personId,
        sessionId: checked.sessionId,
        sessionExpiresAt: utc(checked.expiresAt),
        proofCodeId: checked.proofCodeId,
        repeated: false,
      };
  }
}

/**
 * A sign-in's check (K-05 v1.13 item 60): K-22 rule 9's steps in one READ COMMITTED transaction on the Tool API's client
 * (rosie_app), every time the database's now(). Answers K-21's label with what the server needs (the attempt's id, the
 * person on signedIn and secondProofNeeded, the session and its end on signedIn, the attempt's code), never a hash;
 * attemptNotFound alone for an unknown id, another device or a null; constraint when the database refuses the session
 * (23505: an id or a token hash taken), the whole check rolled back; transient on a serialization failure, a deadlock or
 * a lost connection. Every answer to a code that is not right comes from the attempt, the same with or without an
 * account. Throws a TypeError for a request of the wrong shape, a BrokenRecordError for a record it would have to guess
 * around, and any other database error scrubbed (DataAccessDatabaseError).
 */
export async function proveSignIn(sql: Sql, request: ProveSignInRequest): Promise<ProveSignInOutcome> {
  const asked = proveRequestOf(request);
  let checked: Checked;
  try {
    checked = await inToolApiTransaction(sql, (tx) => checkIn(tx, asked));
  } catch (error) {
    return constraintOf(PROVE, error) ?? transientOrScrubbed(PROVE, error);
  }
  return answerOf(checked);
}

// ---- endSession (item 61) ---------------------------------------------------------------------------------------------

async function endIn(tx: Tx, tokenSha256: string): Promise<EndSessionResponse> {
  const [live] = await tx<{ session_id: string; person_id: string }[]>`
    select session_id, person_id from session_for_token(${tokenSha256}, now())
  `;
  if (live === undefined) {
    return { result: "signedOut", repeated: true };
  }
  await setPersonScope(tx, live.person_id);
  // Rule 5's update policy admits only this person's own session while it has not ended.
  const ended = await tx<{ id: string }[]>`
    update sessions set ended_at = now(), ended_why = 'signed_out', version = version + 1
    where id = ${live.session_id} and ended_at is null
    returning id
  `;
  if (ended.length === 0) {
    return { result: "signedOut", repeated: true };
  }
  return { result: "signedOut", repeated: false, sessionId: live.session_id, personId: live.person_id };
}

/**
 * A sign-out (K-05 v1.13 item 61), in one READ COMMITTED transaction on the Tool API's client (rosie_app): the live
 * session with the token's sha256 is ended now, signed_out, as its own person (rule 5's update policy), and the answer
 * names it and its person for the session.ended entry; an unknown, ended or expired session answers signedOut repeated,
 * naming nothing and changing nothing. transient on a serialization failure, a deadlock or a lost connection. Throws a
 * TypeError for a request of the wrong shape (the token itself among them) and any other database error scrubbed.
 */
export async function endSession(sql: Sql, request: EndSessionRequest): Promise<EndSessionOutcome> {
  const fields = fieldsOf(request, END, ["tokenSha256"]);
  const tokenSha256 = hashOf(END, fields.tokenSha256, "tokenSha256");
  try {
    return await inToolApiTransaction(sql, (tx) => endIn(tx, tokenSha256));
  } catch (error) {
    return transientOrScrubbed(END, error);
  }
}

// ---- personStanding (item 62) -----------------------------------------------------------------------------------------

/** K-04's role in K-21's names (default 121): own_business as ownBusiness; a customer role is no standing. */
function standingRoleOf(role: string): StandingRole {
  switch (role) {
    case "owner":
    case "admin":
    case "staff":
      return role;
    case "own_business":
      return "ownBusiness";
    default:
      throw new BrokenRecordError(`${STANDING}: a live role K-21 has no standing for`);
  }
}

async function standingIn(tx: Sql, personId: string): Promise<PersonStandingResponse> {
  const roles = await tx<{ role: string; business_id: string }[]>`
    select role, business_id from person_roles
    where person_id = ${personId} and ended_at is null and role <> 'customer'
    order by id collate "C"
  `;
  const [team] = await tx<{ live: boolean }[]>`
    select exists (
      select 1 from team_page_recipients where person_id = ${personId} and removed_at is null
    ) as live
  `;
  const onTeam = team?.live === true;
  return {
    personId,
    roles: roles.map((row) => ({ role: standingRoleOf(row.role), businessId: row.business_id })),
    team: onTeam,
    tester: onTeam,
  };
}

/**
 * The standing a signedIn answer gives (K-05 v1.13 item 62), read after proveSignIn commits, by the person it answered:
 * the person's live roles at every business but customer, in role id order, in K-21's names; team, a live K-36 team
 * row; tester, by v1.12's rule, the same row. One read-only transaction at repeatable read on the runtime side's client
 * (rosie_job), with no business scope, writing nothing. transient on a serialization failure, a deadlock or a lost
 * connection (the page call then answers roles empty and both flags false). Throws a TypeError for a request of the
 * wrong shape and any other database error scrubbed.
 */
export async function personStanding(
  sql: Sql,
  request: PersonStandingRequest,
): Promise<PersonStandingOutcome> {
  const fields = fieldsOf(request, STANDING, ["personId"]);
  const personId = idOf(STANDING, fields.personId, "personId");
  try {
    return await inRuntimeTransaction(sql, { readOnly: true }, (tx) => standingIn(tx, personId));
  } catch (error) {
    return transientOrScrubbed(STANDING, error);
  }
}

// ---- signInEntries (item 63) ------------------------------------------------------------------------------------------

/** A proof code's plain columns the entries read: never code_hash. */
interface CodeRow {
  id: string;
  person_id: string | null;
  wrong_tries: number;
  paused_until: Date | null;
  used_at: Date | null;
}

/** A session's plain columns the entries read: never token_sha256 or device_sha256. */
interface SessionRow {
  id: string;
  person_id: string;
  proven_via: string;
  proof_code_id: string;
  started_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  ended_at: Date | null;
  ended_why: string | null;
}

/** One entry the rows call for, every value read from them (default 119). */
interface Entry {
  id: string;
  kind: EntryKind;
  actorKind: "person" | "rosie";
  actorPersonId: string | null;
  tableName: "proof_codes" | "sessions";
  rowId: string;
  oldValues: Record<string, Json> | null;
  newValues: Record<string, Json>;
  why: Record<string, Json> | null;
}

/** A code's entries: one per wrong try k (wrong_tries k − 1 → k, the fifth with its pause), then its use. */
function codeEntries(code: CodeRow): Entry[] {
  const entries: Entry[] = [];
  for (let k = 1; k <= code.wrong_tries; k += 1) {
    const base = { wrong_tries: k - 1 };
    const next = { wrong_tries: k };
    let oldValues: Record<string, Json> = base;
    let newValues: Record<string, Json> = next;
    if (k === TRIES) {
      if (code.paused_until === null) {
        throw new BrokenRecordError(`${ENTRIES}: a code with five wrong tries holds no pause`);
      }
      oldValues = { ...base, paused_until: null };
      newValues = { ...next, paused_until: utc(code.paused_until) };
    }
    entries.push({
      id: `log-${code.id}-wrong-${String(k)}`,
      kind: "proof_code.checked",
      actorKind: "rosie",
      actorPersonId: null,
      tableName: "proof_codes",
      rowId: code.id,
      oldValues,
      newValues,
      why: SIGN_IN_STEP,
    });
  }
  if (code.used_at !== null) {
    entries.push({
      id: `log-${code.id}-used`,
      kind: "proof_code.checked",
      actorKind: code.person_id === null ? "rosie" : "person",
      actorPersonId: code.person_id,
      tableName: "proof_codes",
      rowId: code.id,
      oldValues: { used_at: null },
      newValues: { used_at: utc(code.used_at) },
      why: SIGN_IN_STEP,
    });
  }
  return entries;
}

/** A session's entry for the asked move: its start, or its end once it has one (none before). */
function sessionEntries(kind: "session.started" | "session.ended", session: SessionRow): Entry[] {
  if (kind === "session.started") {
    return [
      {
        id: `log-${session.id}-started`,
        kind,
        actorKind: "person",
        actorPersonId: session.person_id,
        tableName: "sessions",
        rowId: session.id,
        oldValues: null,
        newValues: {
          person_id: session.person_id,
          proven_via: session.proven_via,
          proof_code_id: session.proof_code_id,
          started_at: utc(session.started_at),
          last_seen_at: utc(session.last_seen_at),
          expires_at: utc(session.expires_at),
        },
        why: SIGN_IN_STEP,
      },
    ];
  }
  if (session.ended_at === null || session.ended_why === null) {
    return [];
  }
  const ownTap = session.ended_why === "signed_out";
  return [
    {
      id: `log-${session.id}-ended`,
      kind,
      actorKind: ownTap ? "person" : "rosie",
      actorPersonId: ownTap ? session.person_id : null,
      tableName: "sessions",
      rowId: session.id,
      oldValues: { ended_at: null, ended_why: null },
      newValues: { ended_at: utc(session.ended_at), ended_why: session.ended_why },
      why: null,
    },
  ];
}

/** Each asked row, read before anything is written: a missing one answers notFound and nothing is written. */
async function entriesOf(tx: Sql, asks: readonly Ask[]): Promise<Entry[] | NotFoundAnswer> {
  const entries: Entry[] = [];
  for (const ask of asks) {
    if (ask.kind === "proof_code.checked") {
      const [code] = await tx<CodeRow[]>`
        select id, person_id, wrong_tries, paused_until, used_at from proof_codes where id = ${ask.proofCodeId}
      `;
      if (code === undefined) {
        return { error: "notFound", table: "proof_codes", rowId: ask.proofCodeId };
      }
      entries.push(...codeEntries(code));
    } else {
      const [session] = await tx<SessionRow[]>`
        select id, person_id, proven_via, proof_code_id, started_at, last_seen_at, expires_at, ended_at, ended_why
        from sessions where id = ${ask.sessionId}
      `;
      if (session === undefined) {
        return { error: "notFound", table: "sessions", rowId: ask.sessionId };
      }
      entries.push(...sessionEntries(ask.kind, session));
    }
  }
  return entries;
}

const jsonOrNull = (tx: Sql, value: Record<string, Json> | null): ReturnType<Sql["json"]> | null =>
  value === null ? null : tx.json(value);

async function entriesIn(tx: Sql, asked: EntriesAsked): Promise<SignInEntriesOutcome> {
  const entries = await entriesOf(tx, asked.asks);
  if (!Array.isArray(entries)) {
    return entries;
  }
  const logged: SignInEntriesResponse["entries"] = [];
  for (const entry of entries) {
    // No turn, bundle, business, zone or seal: team only (K-08 defaults 16 and 22); `at` the time it is written.
    const written = await tx<{ id: string }[]>`
      insert into event_log (
        id, at, job_id, trace_id, actor_kind, actor_person_id, kind, table_name, row_id, old_values, new_values, why
      ) values (
        ${entry.id}, now(), ${asked.jobId}, ${asked.traceId}, ${entry.actorKind}, ${entry.actorPersonId}, ${entry.kind},
        ${entry.tableName}, ${entry.rowId}, ${jsonOrNull(tx, entry.oldValues)}, ${tx.json(entry.newValues)},
        ${jsonOrNull(tx, entry.why)}
      )
      on conflict (id) do nothing
      returning id
    `;
    logged.push({ id: entry.id, kind: entry.kind, written: written.length > 0 });
  }
  return { result: "logged", entries: logged };
}

/**
 * The entries of a sign-in's check or of a sign-out (K-05 v1.13 item 63), after proveSignIn or endSession commits, on
 * the runtime side's client (rosie_job), in one transaction with no business scope. It takes ids alone and reads every
 * value from the rows: a code's proof_code.checked entries, one per wrong try and one for its use; a session's
 * session.started, and its session.ended once it has ended. Each entry carries the request's job id and trace, no turn,
 * bundle or business, and is written insert ... on conflict (id) do nothing, so a repeat writes nothing and says so
 * (written false). notFound for an asked row that does not exist, with nothing written; transient on a serialization
 * failure, a deadlock or a lost connection. Throws a TypeError for a request of the wrong shape (a value of the
 * caller's among them) and any other database error scrubbed.
 */
export async function signInEntries(sql: Sql, request: SignInEntriesRequest): Promise<SignInEntriesOutcome> {
  const asked = entriesRequestOf(request);
  try {
    return await inRuntimeTransaction(sql, { readOnly: false }, (tx) => entriesIn(tx, asked));
  } catch (error) {
    return transientOrScrubbed(ENTRIES, error);
  }
}
