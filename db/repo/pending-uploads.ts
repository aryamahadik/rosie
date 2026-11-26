// Data-access v1.24 and v1.25: the pending upload by its upload id (K-05 v1.24 item 86 and v1.25 item 94, defaults 226,
// 233 and 239; T-1573, DL-1232, DL-1250), read from K-22 v1.4's pending_uploads (migration 0041, README rule 11), where a
// page's signedUpload keeps an ID upload under the upload id it hands the page, and finishUpload sets finished_at once
// K-13 checkUpload answers stored (card A12). Their reader is the event turn's gate (card A11, bound by B11), after
// finishUpload hands the event {id_checked, S1-10, the upload id}: item 94's time is the one item 93 checks the link at
// and S1-10's id_uploads row takes as uploaded_at; item 86's answer is that row's person, purpose, media type and sealed
// object key (K-09 v1.14 defaults 224 and 225).
//
//   readPendingUpload     an upload id gives the upload as signedUpload kept it once its file is stored: its id, person,
//                         business (null for a sign_up ID, which is the person's for every company), purpose, media type
//                         and object key, the bytes sealed under the person's key as stored, in PostgreSQL's hex text
//                         form (K-05 v1.12 sealedBytes: a backslash, x and two lower-case hex digits a byte, the digits
//                         PostgreSQL's own encode(object_key, 'hex') writes), never opened, decoded or put in plain
//                         words on the way (refuse-pending-upload-plain-object-key). The event turn copies these bytes
//                         as they are into its id_uploads insert's values.object_key (default 233).
//   readUploadFinishedAt  an upload id gives finished_at alone, as finishedAt; never the object key, the person or the
//                         media type (refuse-upload-finished-object-key).
//
// Both answer none, with the request's upload id, when no row has the id or its finished_at is null ("its file never
// came"): one answer for both, as K-21 v1's uploadNotFound. A lapsed row (expires_at passed) is answered as it is kept:
// the lapse bounds the signed address, not the stored file, and neither item reads it.
//
// Role and side (items 86 and 94, default 226): the runtime side, as rosie_job (the role is the connection's: pass the
// runtime side's client), with the business scope set empty for the transaction, so pending_uploads_runtime (0012's
// pattern on business_id) shows every row, a sign_up row with no business included; its own read-only transaction at
// repeatable read on its own connection on the primary, uncached, beside a Tool API call's transaction and never on it, 1
// connection, released before it answers (targets.ts inRuntimeTransaction). rosie_job reads the table through 0041's
// SELECT. rosie_app holds no grant on pending_uploads at all (rule 11), so the Tool API's role is refused by
// PostgreSQL's privilege check (42501, thrown scrubbed as DataAccessDatabaseError).
//
// What they read. Each call sends one statement that reads one table, pending_uploads, by its primary key, the upload id
// bound as a parameter, and finished_at is not null; no `*` and no whole row. Item 86 names id, person_id, business_id,
// purpose, content_type and object_key (as its hex digits); item 94 names finished_at alone. Neither names created_at
// or expires_at, nor any other table.
//
// The object key is sealed and stays so: it is answered as stored and is never logged, put in an error or opened here;
// its readers never log it or put it in a span, an error or an entry. A broken record is refused with a message naming
// the call and the rule, never a value or an id.
//
// Errors (K-05 README: every call may answer transient). A serialization failure, a deadlock or a lost connection answers
// transient, with its SQLSTATE alone; any other database error is thrown scrubbed (clocks.ts transientOrScrubbed). A
// request of the wrong shape throws a TypeError before any statement, naming the field, never its value.
//
// Defaults used (for ops/QUESTIONS.md, each where no source decides):
//   1. uploadId is refused unless it is a non-empty string with no NUL (K-08 v1 id: opaque, non-empty; CQ-09; K-22 v1.4
//      pending_uploads.id: "an opaque string the server makes and nothing parses"); an upload id is never parsed.
//   2. A finished row item 86 would have to guess around throws BrokenRecordError and nothing is answered (turn-face-reads.ts
//      default 2's rule: fail closed rather than answer half): an object key of no bytes (K-05 sealedBytes holds one byte
//      at least), or a media type outside K-05 pendingUpload.contentType's form (^(image|application)/[a-z0-9.+-]+$,
//      K-22 id_uploads_content_type_form, which S1-10's id_uploads row would refuse), which pending_uploads holds no CHECK
//      for (K-22 v1.4 README default 33: checkUpload confirms it before finished_at is set; the database engineer's note 2
//      on T-1567). K-22's CHECK holds the purpose to sign_up or re_check, so only a broken write meets this.
import type * as K05 from "../../contracts/generated/data-access/data-access.v1.25";
import { transientOrScrubbed } from "./clocks";
import type { Sql } from "./scope";
import { assertRequestShape, inRuntimeTransaction, utc } from "./targets";
import { BrokenRecordError } from "./turn-face-reads";

// ---- the requests and the answers (data-access.v1.24.schema.json and v1.25's) ----------------------------------------

/** K-05 v1.24 readPendingUpload.request: the upload id alone (the event's ref). */
export type ReadPendingUploadRequest = K05.ReadPendingUploadRequest;
/** K-05 v1.24 readPendingUpload.response: the upload as kept, its object key sealed; or none. */
export type ReadPendingUploadResponse = K05.ReadPendingUploadResponse;
/** K-05 v1.24 pendingUpload: the upload's id, person, business, purpose, media type and sealed object key. */
export type PendingUpload = K05.PendingUpload;
/** K-05 v1.24 readPendingUpload.errors: transient alone. */
export type ReadPendingUploadError = K05.ReadPendingUploadErrors;
export type ReadPendingUploadOutcome = ReadPendingUploadResponse | ReadPendingUploadError;

/** K-05 v1.25 readUploadFinishedAt.request: the upload id alone, as item 86 takes it. */
export type ReadUploadFinishedAtRequest = K05.ReadUploadFinishedAtRequest;
/** K-05 v1.25 readUploadFinishedAt.response: the finished time alone; or none. */
export type ReadUploadFinishedAtResponse = K05.ReadUploadFinishedAtResponse;
/** K-05 v1.25 readUploadFinishedAt.errors: transient alone. */
export type ReadUploadFinishedAtError = K05.ReadUploadFinishedAtErrors;
export type ReadUploadFinishedAtOutcome = ReadUploadFinishedAtResponse | ReadUploadFinishedAtError;

const PENDING_UPLOAD = "readPendingUpload";
const UPLOAD_FINISHED_AT = "readUploadFinishedAt";
/** What encode(object_key, 'hex') gives a sealed value: two lower-case hex digits a byte, one byte at least. */
const HEX_DIGITS = /^(?:[0-9a-f]{2})+$/;
/** K-05 v1.24 pendingUpload.contentType's form (K-22 id_uploads_content_type_form). */
const CONTENT_TYPE = /^(image|application)\/[a-z0-9.+-]+$/;

/** The request's upload id: the request names it alone, a non-empty id with no NUL (default 1). */
function uploadIdOf(request: unknown, call: string): string {
  assertRequestShape(request, call, ["uploadId"]);
  const { uploadId } = request as Record<string, unknown>;
  if (typeof uploadId !== "string" || uploadId === "" || uploadId.includes("\u0000")) {
    throw new TypeError(`${call}: uploadId is an upload id, a non-empty text`);
  }
  return uploadId;
}

// ---- readPendingUpload (item 86) ------------------------------------------------------------------------------------

/** Item 86's columns as the read takes them: the object key as PostgreSQL's hex digits of the stored bytes. */
interface UploadRow {
  id: string;
  person_id: string;
  business_id: string | null;
  purpose: string;
  content_type: string;
  object_key_hex: string;
}

/** One finished upload in K-05's names (pendingUpload), the object key sealed as stored; a broken one throws (default 2). */
function pendingUploadOf(row: UploadRow): PendingUpload {
  if (row.purpose !== "sign_up" && row.purpose !== "re_check") {
    throw new BrokenRecordError(
      `${PENDING_UPLOAD}: a pending upload's purpose is neither sign_up nor re_check`,
    );
  }
  if (!CONTENT_TYPE.test(row.content_type)) {
    throw new BrokenRecordError(`${PENDING_UPLOAD}: a pending upload's media type is outside K-05's form`);
  }
  if (!HEX_DIGITS.test(row.object_key_hex)) {
    throw new BrokenRecordError(`${PENDING_UPLOAD}: a pending upload's sealed object key holds no bytes`);
  }
  return {
    uploadId: row.id,
    personId: row.person_id,
    businessId: row.business_id,
    purpose: row.purpose,
    contentType: row.content_type,
    objectKey: `\\x${row.object_key_hex}`,
  };
}

/** The finished upload inside the read's own transaction: one statement over pending_uploads by its primary key. */
async function pendingUploadIn(tx: Sql, uploadId: string): Promise<ReadPendingUploadResponse> {
  const [row] = await tx<UploadRow[]>`
    select id, person_id, business_id, purpose, content_type, encode(object_key, 'hex') as object_key_hex
    from pending_uploads
    where id = ${uploadId} and finished_at is not null
  `;
  if (row === undefined) {
    return { result: "none", uploadId };
  }
  return { result: "pendingUpload", upload: pendingUploadOf(row) };
}

/**
 * The pending upload by its upload id (K-05 v1.24 item 86): its person, business (null for a sign_up ID), purpose,
 * media type and object key, sealed under the person's key as stored (\x and its hex digits), never opened; none when
 * no row has the id or its file never came (finished_at null). One statement in one read-only transaction at repeatable
 * read on the primary, uncached, with no business scope, writing nothing. Pass the runtime side's client (rosie_job): the
 * role is the connection's, and the Tool API's role meets 42501. transient on a serialization failure, a deadlock or a
 * lost connection. Throws a TypeError for a request of the wrong shape, a BrokenRecordError for a row it would have to
 * guess around (default 2), and any other database error scrubbed (DataAccessDatabaseError). The object key is a
 * person's sealed key: never log it or put it in an error.
 */
export async function readPendingUpload(
  sql: Sql,
  request: ReadPendingUploadRequest,
): Promise<ReadPendingUploadOutcome> {
  const uploadId = uploadIdOf(request, PENDING_UPLOAD);
  try {
    return await inRuntimeTransaction(sql, { readOnly: true }, (tx) => pendingUploadIn(tx, uploadId));
  } catch (error) {
    return transientOrScrubbed(PENDING_UPLOAD, error);
  }
}

// ---- readUploadFinishedAt (item 94) ---------------------------------------------------------------------------------

/** The finished time inside the read's own transaction: one statement over pending_uploads, finished_at alone. */
async function finishedAtIn(tx: Sql, uploadId: string): Promise<ReadUploadFinishedAtResponse> {
  const [row] = await tx<{ finished_at: Date }[]>`
    select finished_at
    from pending_uploads
    where id = ${uploadId} and finished_at is not null
  `;
  if (row === undefined) {
    return { result: "none", uploadId };
  }
  return { result: "finished", uploadId, finishedAt: utc(row.finished_at) };
}

/**
 * The pending upload's finished time by its upload id (K-05 v1.25 item 94): the time finishUpload recorded once K-13
 * checkUpload passed, the time S1-10's id_uploads row takes as uploaded_at; none when no row has the id or its file
 * never came. Never the object key, the person or the media type. One statement in one read-only transaction at
 * repeatable read on the primary, uncached, with no business scope, writing nothing. Pass the runtime side's client
 * (rosie_job): the Tool API's role meets 42501. transient on a serialization failure, a deadlock or a lost connection.
 * Throws a TypeError for a request of the wrong shape and any other database error scrubbed (DataAccessDatabaseError).
 */
export async function readUploadFinishedAt(
  sql: Sql,
  request: ReadUploadFinishedAtRequest,
): Promise<ReadUploadFinishedAtOutcome> {
  const uploadId = uploadIdOf(request, UPLOAD_FINISHED_AT);
  try {
    return await inRuntimeTransaction(sql, { readOnly: true }, (tx) => finishedAtIn(tx, uploadId));
  } catch (error) {
    return transientOrScrubbed(UPLOAD_FINISHED_AT, error);
  }
}
