// The owner's ID upload as "the ID confirmed" (T-321; C-094; MC C10; K-22 v1 `id_uploads`; K-13 v1 checkUpload): an ID
// document the person uploaded on the secure page, never in the chat, accepted as given. A `sign_up` upload counts as
// "the ID confirmed" wherever the master, C4 or C8 asks for it (S1-10 gives id_checked; S1-32's ID half); a `re_check`
// upload is S13-45 row 8's ID re-check, the second proof that isn't the phone (a new owner mobile or email, a new device,
// a hand-over): C-094's "second proofs included".
//
// MC C10: "Any document is accepted as given, with no check, and that counts as 'the ID confirmed' wherever the master,
// C4 or C8 asks for it. No face match or video check runs. An ID-check service is added later behind a switch that stays
// off until Jay turns it on." So this service takes no face-match, selfie or video port, never reads the file's bytes
// (K-13 serverRead) and never asks a person to view it (K-13 readLink): the only port call it makes is K-13 checkUpload,
// because K-13's freeze record holds that "S1-10's ID upload counts as confirmed only once checkUpload answers stored".
// The ID-check service has no column and no port until Jay turns it on (K-22 README; 02-contracts K-19).
//
// It reads K-22 v1's id_uploads through IdUploadReader (by person: the table is per person across businesses, K-22 v1
// rule 4) without the object key, which stays sealed and secure-page-only (K-22 v1 rule 6). Recording writes nothing
// itself: confirmUpload answers the id_uploads row the caller's one commit writes (K-21 v1 finishUpload; the event turn
// that gives id_checked writes it as a StepRow, the object key sealed under the person's key by the writer), so the
// row, its gives and S1-10's walk land together or not at all (arch 01 line 39).
//
// Nothing here logs. The object key goes only into the answered row, for the commit to seal; it never enters an error, a
// span, a log line or an answer to a page (K-13 README "The object key"; K-21 v1 default 12). An error names its field,
// never a value.
//
// Defaults used (for ops/QUESTIONS.md):
//   I1. "The ID confirmed" reads the person's sign_up row alone (K-22 v1 id_uploads.purpose: "sign_up: ... counts as the
//       ID confirmed"); a re_check row on its own confirms no sign-up, and answers only the re-check (idReChecked).
//   I2. A re-check counts as the second proof when its upload came at or after the moment the caller names (the request
//       that needs it, or the sign-in it completes); an older re-check proves nothing new (S13-45 row 8: each new owner
//       mobile or email, new device or hand-over asks it again).
//   I3. A sign_up upload while one is on file records nothing and asks no port: the first stands (K-22 v1
//       id_uploads_one_sign_up; S1-10 "Done once, for every company"), and the answer names it, so a repeat of the same
//       upload answers alike.
//   I4. The row's content_type is the type checkUpload read from the stored bytes, and uploaded_at is its storedAt (K-13
//       "What checkUpload reads"; K-22 v1 uploaded_at "when it was uploaded"). A stored answer of another type than the
//       one asked, or outside K-13's upload types, is a port fault: refused (IdUploadPortError), nothing recorded.
//   I5. A row of the person outside K-22 v1's purposes, or with no time in UTC, is refused as unreadable
//       (IdUploadReadError, naming the column): the service fails closed rather than guess either way.
//
// Not here: the page calls signedUpload and finishUpload and the S1-10 upload page (T-636b, T-521); the event turn that
// gives id_checked and walks on to S1-75 (K-09 v1.14, A7); the data-access read of id_uploads by person and the sealed
// insert (K-05 v1.24, A9); who may see an ID file and its read link (Q-31: no K-21 v1 call shows one).

import type * as K13 from "../../../../../contracts/generated/port-files/port-files.v1";

/** K-22 v1 `id_uploads.purpose` (id_uploads_purpose_known), in its order. */
export const ID_UPLOAD_PURPOSES = ["sign_up", "re_check"] as const;
export type IdUploadPurpose = (typeof ID_UPLOAD_PURPOSES)[number];

/** The types K-13 v1 takes for an upload, an ID document's included: a photo or a PDF (MC C10 "a photo or file"). */
export const ID_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/webp",
  "application/pdf",
] as const satisfies readonly K13.UploadMediaType[];

/** K-13 v1 uploadMaxBytes: the largest file a signed upload takes (10 MiB). */
export const ID_UPLOAD_MAX_BYTES: K13.UploadMaxBytes = 10485760;

/** The key a sign_up upload gives (S1-10 "gives id_checked"; K-01 v1 step.gives). */
export const ID_CHECKED = "id_checked";

/** K-22 v1 `id_uploads`, the columns the service reads: never the object key (sealed, secure-page-only: rule 6). */
export interface IdUploadOnFile {
  readonly id: string;
  readonly personId: string;
  readonly purpose: IdUploadPurpose;
  readonly contentType: string;
  /** When it was uploaded, UTC. */
  readonly uploadedAt: string;
}

/** K-22 v1's id_uploads of one person, every purpose, without the object key. */
export interface IdUploadReader {
  idUploadsOfPerson(personId: string): Promise<readonly IdUploadOnFile[]>;
}

/** The one K-13 v1 call the service makes: what came to an upload link (checkUpload). */
export interface IdFilesPort {
  checkUpload(request: K13.CheckUploadRequest): Promise<K13.CheckUploadResult | K13.CheckUploadErrors>;
}

/** Whether a person's ID is confirmed (C10): by their sign_up upload, named by id, or not. */
export type IdConfirmed =
  | { readonly confirmed: true; readonly uploadId: string; readonly uploadedAt: string }
  | { readonly confirmed: false };

/** Whether a person passed the ID re-check since a moment (S13-45 row 8): by a re_check upload, named by id, or not. */
export type IdReChecked =
  | { readonly reChecked: true; readonly uploadId: string; readonly uploadedAt: string }
  | { readonly reChecked: false };

/** What signedUpload kept on the server with the upload id (K-13 uploadLink; K-21 v1): never a browser's word. */
export interface PendingIdUpload {
  /** The upload id the page names (K-21 v1 default 12: never the object key). */
  readonly uploadId: string;
  /** The K-13 kind the link was made for. */
  readonly kind: K13.UploadKind;
  /** Whose the file is, bound on the server from the page's session and link (K-13 "Owners"). */
  readonly owner: K13.UploadOwner;
  /** The key uploadLink made, kept on the server. */
  readonly objectKey: string;
  /** The type asked for the link. */
  readonly mediaType: K13.UploadMediaType;
}

export interface ConfirmUploadRequest {
  /** The person the call acts for: the session's, which is the setupIdCheck link's person (K-21 v1). */
  readonly personId: string;
  readonly purpose: IdUploadPurpose;
  readonly upload: PendingIdUpload;
  /** The id_uploads row's id, made by the caller's code (CQ-09), so a repeat names the same row. */
  readonly rowId: string;
}

/** K-22 v1 `id_uploads` as the commit writes it, the object key to be sealed under personId's key (rule 6). */
export interface IdUploadRowNew {
  readonly id: string;
  readonly personId: string;
  readonly purpose: IdUploadPurpose;
  /** Plain here, for the writer to seal: never logged, never in a span, an entry or an answer to a page. */
  readonly objectKey: string;
  readonly contentType: K13.UploadMediaType;
  readonly uploadedAt: string;
}

/** Why an upload is not an ID upload of this person, refused before any port is asked. */
export type NotAnIdUpload =
  /** Not a K-13 idDocument upload. */
  | "kind"
  /** Not this person's own file with no business (K-13 refuse-id-document-for-business; K-22 v1 rule 4). */
  | "owner"
  /** Not a type K-13 takes for an upload. */
  | "mediaType";

/** What confirmUpload answers. Only "record" gives a row to write; every other outcome writes nothing. */
export type ConfirmUploadAnswer =
  /** Stored: the row to write; a sign_up gives id_checked (S1-10), a re_check nothing (a second proof only). */
  | {
      readonly outcome: "record";
      readonly row: IdUploadRowNew;
      readonly gives: readonly (typeof ID_CHECKED)[];
    }
  /** A sign_up already on file: the ID is confirmed by it, nothing new recorded and no port asked (default I3). */
  | { readonly outcome: "alreadyConfirmed"; readonly uploadId: string }
  /** No file came to the link (K-13 notStored; K-21 uploadNotFound). */
  | { readonly outcome: "notStored" }
  /** The file came but is refused and was removed by the port (K-13 tooLarge or wrongType). */
  | { readonly outcome: "refused"; readonly error: "tooLarge" | "wrongType" }
  /** The port failed; nothing is known and nothing changed: the caller checks again (K-21 providerUnavailable). */
  | { readonly outcome: "unavailable" }
  /** Not an ID upload of this person: refused before the port is asked. */
  | { readonly outcome: "notAnIdUpload"; readonly why: NotAnIdUpload };

export interface IdUploadAccess {
  /** Whether a person's ID is confirmed: their sign_up upload (C10). */
  idConfirmed(personId: string): Promise<IdConfirmed>;
  /** Whether a person passed the ID re-check at or after `since` (UTC): their latest re_check upload since then. */
  idReChecked(personId: string, since: string): Promise<IdReChecked>;
  /** An upload, checked by K-13 checkUpload, as the id_uploads row that records it, or why none is recorded. */
  confirmUpload(request: ConfirmUploadRequest): Promise<ConfirmUploadAnswer>;
}

export interface IdUploadAccessOptions {
  /** K-22 v1's id_uploads by person, without the object key. */
  readonly reader: IdUploadReader;
  /** K-13 v1 checkUpload. Left out, confirmUpload refuses (IdUploadNotWiredError) before anything is read. */
  readonly files?: IdFilesPort;
}

/** confirmUpload with no files port bound: nothing read, nothing recorded. */
export class IdUploadNotWiredError extends Error {
  override name = "IdUploadNotWiredError";

  constructor() {
    super("the files port is not bound: no upload is checked or recorded");
  }
}

/** K-13 answered outside its contract (default I4): nothing recorded. Names the field, never a value. */
export class IdUploadPortError extends Error {
  override name = "IdUploadPortError";

  constructor(readonly field: string) {
    super(`checkUpload answered outside K-13 v1: ${field}`);
  }
}

/** An id_uploads row the service cannot read (default I5): refused, naming the column, never a value. */
export class IdUploadReadError extends Error {
  override name = "IdUploadReadError";

  constructor(readonly column: string) {
    super(`unreadable id upload row: ${column}`);
  }
}

/** Ids are opaque strings (CQ-09); the message names the argument, never its value. */
function assertId(value: unknown, what: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${what} must be a non-empty id`);
  }
}

/** An instant in UTC as K-13 and K-22 write it (CQ-09): a date and time ending in Z that the clock reads. */
function isUtc(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isPurpose(value: unknown): value is IdUploadPurpose {
  return (ID_UPLOAD_PURPOSES as readonly unknown[]).includes(value);
}

function isMediaType(value: unknown): value is K13.UploadMediaType {
  return (ID_MEDIA_TYPES as readonly unknown[]).includes(value);
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The person's rows of one purpose, oldest first (ties by id), never another person's even from a reader that gives
 * them. A row of the person outside K-22 v1's purposes, or with no time in UTC, fails closed (default I5).
 */
function rowsOf(
  rows: readonly IdUploadOnFile[],
  personId: string,
  purpose: IdUploadPurpose,
): IdUploadOnFile[] {
  const theirs = rows.filter((row) => row.personId === personId);
  for (const row of theirs) {
    if (!isPurpose(row.purpose)) throw new IdUploadReadError("id_uploads.purpose");
    if (!isUtc(row.uploadedAt)) throw new IdUploadReadError("id_uploads.uploaded_at");
  }
  return theirs
    .filter((row) => row.purpose === purpose)
    .sort((a, b) => Date.parse(a.uploadedAt) - Date.parse(b.uploadedAt) || byText(a.id, b.id));
}

/** C10 over rows read: the person's sign_up upload counts as the ID confirmed (the first, if a reader gives two). */
export function idConfirmedOf(rows: readonly IdUploadOnFile[], personId: string): IdConfirmed {
  const [first] = rowsOf(rows, personId, "sign_up");
  return first === undefined
    ? { confirmed: false }
    : { confirmed: true, uploadId: first.id, uploadedAt: first.uploadedAt };
}

/** S13-45 row 8 over rows read: the person's latest re_check upload at or after `since` (default I2). */
export function idReCheckedOf(rows: readonly IdUploadOnFile[], personId: string, since: string): IdReChecked {
  if (!isUtc(since)) throw new TypeError("since must be an instant in UTC");
  const after = Date.parse(since);
  const latest = rowsOf(rows, personId, "re_check")
    .filter((row) => Date.parse(row.uploadedAt) >= after)
    .at(-1);
  return latest === undefined
    ? { reChecked: false }
    : { reChecked: true, uploadId: latest.id, uploadedAt: latest.uploadedAt };
}

/** The request's shape, each field named on its own, never a value. */
function checkRequest(request: ConfirmUploadRequest): void {
  assertId(request.personId, "personId");
  assertId(request.rowId, "rowId");
  if (!isPurpose(request.purpose)) throw new TypeError("purpose must be sign_up or re_check");
  assertId(request.upload.uploadId, "uploadId");
  if (typeof request.upload.objectKey !== "string" || request.upload.objectKey === "") {
    throw new TypeError("objectKey must be a non-empty key");
  }
}

/** Whether the pending upload is this person's own ID document (K-13 kind idDocument, owner the person, no business). */
function notAnIdUpload(personId: string, upload: PendingIdUpload): NotAnIdUpload | null {
  if (upload.kind !== "idDocument") return "kind";
  const { owner } = upload;
  if (owner.kind !== "person" || owner.personId !== personId || owner.businessId !== null) return "owner";
  if (!isMediaType(upload.mediaType)) return "mediaType";
  return null;
}

/** The row a stored answer records (default I4), or a port fault. */
function rowOf(request: ConfirmUploadRequest, stored: K13.UploadStored): IdUploadRowNew {
  if (!isMediaType(stored.mediaType) || stored.mediaType !== request.upload.mediaType) {
    throw new IdUploadPortError("mediaType");
  }
  if (!isUtc(stored.storedAt)) throw new IdUploadPortError("storedAt");
  return {
    id: request.rowId,
    personId: request.personId,
    purpose: request.purpose,
    objectKey: request.upload.objectKey,
    contentType: stored.mediaType,
    uploadedAt: stored.storedAt,
  };
}

/** What K-13 answered, as confirmUpload answers it; an answer outside K-13 v1 is a port fault (default I4). */
function answerOf(
  request: ConfirmUploadRequest,
  checked: K13.CheckUploadResult | K13.CheckUploadErrors,
): ConfirmUploadAnswer {
  const said = checked as { readonly result?: unknown; readonly error?: unknown };
  if (said.result === "stored") {
    const row = rowOf(request, checked as K13.UploadStored);
    return { outcome: "record", row, gives: request.purpose === "sign_up" ? [ID_CHECKED] : [] };
  }
  if (said.result === "notStored") return { outcome: "notStored" };
  if (said.error === "unavailable") return { outcome: "unavailable" };
  if (said.error === "tooLarge") return { outcome: "refused", error: "tooLarge" };
  if (said.error === "wrongType") return { outcome: "refused", error: "wrongType" };
  throw new IdUploadPortError("result");
}

export function createIdUploadAccess(options: IdUploadAccessOptions): IdUploadAccess {
  const { reader, files } = options;

  const rowsOfPerson = async (personId: string): Promise<readonly IdUploadOnFile[]> => {
    assertId(personId, "personId");
    return reader.idUploadsOfPerson(personId);
  };

  return {
    async idConfirmed(personId) {
      return idConfirmedOf(await rowsOfPerson(personId), personId);
    },

    async idReChecked(personId, since) {
      if (!isUtc(since)) throw new TypeError("since must be an instant in UTC");
      return idReCheckedOf(await rowsOfPerson(personId), personId, since);
    },

    async confirmUpload(request) {
      if (files === undefined) throw new IdUploadNotWiredError();
      checkRequest(request);
      const why = notAnIdUpload(request.personId, request.upload);
      if (why !== null) return { outcome: "notAnIdUpload", why };
      if (request.purpose === "sign_up") {
        const onFile = idConfirmedOf(await rowsOfPerson(request.personId), request.personId);
        if (onFile.confirmed) return { outcome: "alreadyConfirmed", uploadId: onFile.uploadId };
      }
      const checked = await files.checkUpload({
        objectKey: request.upload.objectKey,
        mediaType: request.upload.mediaType,
        maxBytes: ID_UPLOAD_MAX_BYTES,
      });
      return answerOf(request, checked);
    },
  };
}
