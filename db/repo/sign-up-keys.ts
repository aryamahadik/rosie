// Data-access v1.24: S1-10's keys by person (K-05 v1.24 item 85, defaults 226 and 227; T-1561, the ruling T-1543's card
// A10, ops/reviews/signup-remainder/rule-rest.json; DL-1228). Its readers bind it on the runtime side: card A12 (the
// upload's hand-off: mobile.handleId, then item 50 readHandle, one read after the other), card E10 (staging's control
// event: the item's raised-by person's keys, then readHandle) and card B11 for A11 (the event turn's keys: idUpload is the
// key K-01 v1.1's S1-10 `waitsOnEvent` ["id_checked"] waits for, and K-09 v1.14 default 224's "no sign_up id_uploads row
// of that person is on file" and "the account mobile's handle is the turn's handle" are read from it).
//
//   readSignUpKeys  a person's id gives, read as one moment:
//                     idUpload  the person's sign_up K-22 id_uploads row (id_uploads_one_sign_up: one at most), its id and
//                               uploaded_at alone; a re_check upload is never an S1-10 key; null with none;
//                     mobile    the person's K-22 accounts row's mobile and mobile_proven_at, given only when both are set
//                               (default 227), with that number's K-04 phones.handle_id (accounts_mobile_fk makes the row
//                               exist; 0004 line 41 makes its handle_id not null); null otherwise.
//                   A person with no row anywhere answers both null, never notFound, so the read never tells whether a
//                   person exists.
//
// One moment (README item 85; the database engineer's review on T-1549): the three tables are read by ONE statement
// (left joins from a one-row base, so it answers exactly one row), and that statement runs in one read-only transaction at
// repeatable read (targets.ts inRuntimeTransaction): an upload or a proof committed while the read runs is seen whole or
// not at all.
//
// Role and side (default 226): the runtime side, as rosie_job (the role is the connection's: pass the runtime side's
// client), with the business scope set empty for the transaction, its own read-only transaction on its own connection on
// the primary, uncached, beside a Tool API call's transaction and never on it, 1 connection, released before it answers.
// rosie_job reads accounts and id_uploads through 0020's grants (line 516 and 517; accounts and id_uploads have no
// row-level security) and phones through 0012's. rosie_app holds no grant on accounts or id_uploads, so the Tool API's
// role is refused by PostgreSQL's privilege check (42501, thrown scrubbed as DataAccessDatabaseError).
//
// What it reads and never reads: id_uploads' id, uploaded_at, person_id and purpose; accounts' person_id, mobile and
// mobile_proven_at; phones' number and handle_id. No statement names object_key (sealed, audience secure-page-only:
// refuse-sign-up-keys-object-key), content_type or the account's email. The answer holds a number: this file never logs
// it or puts it in an error, and its readers never log it or put it in a span, an error or an entry (the security
// reviewer's note (c) on T-1549).
//
// Errors (K-05 README: every call may answer transient). A serialization failure, a deadlock or a lost connection answers
// transient, with its SQLSTATE alone; any other database error is thrown scrubbed (clocks.ts transientOrScrubbed). A
// request of the wrong shape throws a TypeError before any statement, naming the field, never its value.
//
// Defaults used (for ops/QUESTIONS.md, each where no source decides):
//   1. A proven mobile whose number has no phones row, which accounts_mobile_fk refuses, throws BrokenRecordError and
//      nothing is answered (turn-face-reads.ts default 2's rule: fail closed rather than answer a mobile with no handle).
//   2. personId is refused unless it is a non-empty string with no NUL (K-08 v1 id: opaque, non-empty; CQ-09); a person
//      id is never parsed.
import type * as K05 from "../../contracts/generated/data-access/data-access.v1.24";
import { transientOrScrubbed } from "./clocks";
import type { Sql } from "./scope";
import { assertRequestShape, inRuntimeTransaction, utc } from "./targets";
import { BrokenRecordError } from "./turn-face-reads";

/** K-05 v1.24 readSignUpKeys.request: the person whose S1-10 keys are read. */
export type ReadSignUpKeysRequest = K05.ReadSignUpKeysRequest;
/** K-05 v1.24 readSignUpKeys.response: the sign_up upload and the proven mobile with its handle id, each or null. */
export type ReadSignUpKeysResponse = K05.ReadSignUpKeysResponse;
/** K-05 v1.24 readSignUpKeys.errors: transient alone. */
export type ReadSignUpKeysError = K05.ReadSignUpKeysErrors;
export type ReadSignUpKeysOutcome = ReadSignUpKeysResponse | ReadSignUpKeysError;

const CALL = "readSignUpKeys";

/** The person's id: a non-empty id with no NUL (default 2). */
function personIdOf(request: unknown): string {
  assertRequestShape(request, CALL, ["personId"]);
  const { personId } = request as Record<string, unknown>;
  if (typeof personId !== "string" || personId === "" || personId.includes("\u0000")) {
    throw new TypeError(`${CALL}: personId is a K-04 person id, a non-empty text`);
  }
  return personId;
}

/** The one row the statement answers: each column null when its table holds no row for the person. */
interface KeysRow {
  upload_id: string | null;
  uploaded_at: Date | null;
  mobile: string | null;
  mobile_proven_at: Date | null;
  handle_id: string | null;
}

/** The keys inside the read's own transaction: one statement over id_uploads, accounts and phones. */
async function keysIn(tx: Sql, personId: string): Promise<ReadSignUpKeysResponse> {
  const [row] = await tx<KeysRow[]>`
    select u.id as upload_id, u.uploaded_at, a.mobile, a.mobile_proven_at, p.handle_id
    from (select 1) as one
    left join id_uploads u on u.person_id = ${personId} and u.purpose = 'sign_up'
    left join accounts a on a.person_id = ${personId}
    left join phones p on p.number = a.mobile and a.mobile_proven_at is not null
  `;
  if (row === undefined) {
    throw new BrokenRecordError(`${CALL}: the keys' statement answered no row`);
  }
  const idUpload =
    row.upload_id === null || row.uploaded_at === null
      ? null
      : { uploadId: row.upload_id, uploadedAt: utc(row.uploaded_at) };
  if (row.mobile === null || row.mobile_proven_at === null) {
    return { result: "signUpKeys", personId, idUpload, mobile: null };
  }
  if (row.handle_id === null) {
    throw new BrokenRecordError(`${CALL}: a proven account mobile has no phone row`);
  }
  return {
    result: "signUpKeys",
    personId,
    idUpload,
    mobile: { number: row.mobile, provenAt: utc(row.mobile_proven_at), handleId: row.handle_id },
  };
}

/**
 * S1-10's keys by person (K-05 v1.24 item 85): the person's sign_up upload (its id and time) and the account's proven
 * mobile with its K-04 handle id, each or null, read as one moment (one statement in one read-only transaction at
 * repeatable read on the primary, uncached, writing nothing). Pass the runtime side's client (rosie_job): the role is the
 * connection's, and the Tool API's role meets 42501. transient on a serialization failure, a deadlock or a lost
 * connection. Throws a TypeError for a request of the wrong shape, a BrokenRecordError for a proven mobile with no phone
 * row (default 1), and any other database error scrubbed (DataAccessDatabaseError). The number is a person's: never log
 * it.
 */
export async function readSignUpKeys(
  sql: Sql,
  request: ReadSignUpKeysRequest,
): Promise<ReadSignUpKeysOutcome> {
  const personId = personIdOf(request);
  try {
    return await inRuntimeTransaction(sql, { readOnly: true }, (tx) => keysIn(tx, personId));
  } catch (error) {
    return transientOrScrubbed(CALL, error);
  }
}
