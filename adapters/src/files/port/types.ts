// The files port's types (T-437; C-219; K-13 v1, contracts/port-files). They mirror the port's requests and answers in
// port-files.v1.schema.json by hand, because the generated contract types are git-ignored (ADR-005) and code that ships
// beside them must not depend on them (as the Places, geo, Linq and Stripe doubles' types do). The tests check every
// answer and every span against the schema itself.
//
// One port, two implementations: the in-memory double (adapters/src/files/double, T-437) and the R2 adapter
// (adapters/src/files/r2, T-438). Both take these types, refuse the same requests (./validate.ts), answer by the same
// rules (./rules.ts) and write the same span (./span.ts).

import type { BundleId } from "../../shared/spans";

// ---- the words of K-13 v1 ----

/** What a signed upload is (K-13 v1 `uploadKind`). */
export type UploadKind = "idDocument" | "photo" | "priceList" | "form" | "signedDocument" | "licenseFile";

/** What a server-side write is (K-13 v1 `writeKind`). */
export type WriteKind = "sealedTrace" | "eventLogExport" | "export" | "report" | "photo";

/** Any file's kind, the first part of every object key (K-13 v1 `fileKind`). */
export type FileKind = UploadKind | WriteKind;

/** The photo types (K-13 v1 `imageType`). Never image/svg+xml. */
export type ImageType = "image/jpeg" | "image/png" | "image/heic" | "image/heif" | "image/webp";

/** The types a signed upload takes: a photo or a PDF (K-13 v1 `uploadMediaType`). */
export type UploadMediaType = ImageType | "application/pdf";

/** Every type an object may have, the closed list (K-13 v1 `mediaType`). */
export type MediaType =
  | UploadMediaType
  | "video/mp4"
  | "video/quicktime"
  | "text/csv"
  | "application/vnd.apache.parquet"
  | "application/octet-stream";

/** Every object is private (K-13 v1 `visibility`): v1 has no other value. */
export type Visibility = "private";

/**
 * An object's key, `<kind>/<day>/<id>` (K-13 v1 `objectKey`): the file reference other contracts store. The port makes
 * every key; it never reaches a browser, a span or a log.
 */
export type ObjectKey = string;

/** A file that is one person's own (K-13 v1 `personOwner`). */
export interface PersonOwner {
  kind: "person";
  personId: string;
  /** Null for a file that covers every business of the person (an ID document). */
  businessId: string | null;
}

/** A file of the business itself (K-13 v1 `businessOwner`). */
export interface BusinessOwner {
  kind: "business";
  businessId: string;
}

/** A file of one booking (K-13 v1 `bookingOwner`). */
export interface BookingOwner {
  kind: "booking";
  businessId: string;
  bookingId: string;
  /** The one person the file is from or about; null for the business's own record of the visit. */
  personId: string | null;
}

/** A system object of Rosie's own (K-13 v1 `rosieOwner`). */
export interface RosieOwner {
  kind: "rosie";
}

/** Whose an upload is (K-13 v1 `uploadOwner`), bound on the server, never from the browser. */
export type UploadOwner = PersonOwner | BusinessOwner | BookingOwner;

/** Whose an object is (K-13 v1 `owner`). */
export type FileOwner = UploadOwner | RosieOwner;

/** The owner's kind, as a span names it (K-13 v1 `ownerKind`). */
export type OwnerKind = FileOwner["kind"];

/** On what ground the caller let this viewer see the file (K-13 v1 `viewerGround`). */
export type ViewerGround = "self" | "business" | "rosieTeam" | "listing";

/**
 * The caller's permission token for one read (K-13 v1 `viewer`): whom it checked and on what ground, before it asked.
 * A listing view names no person; every other view names its viewer. A read link without it is refused.
 */
export type Viewer =
  { as: "listing"; personId: null } | { as: "self" | "business" | "rosieTeam"; personId: string };

/** The row that names a file (K-13 v1 `rowRef`): its table and id, which a log names instead of the key. */
export interface RowRef {
  /** A K-08 table name: lowercase letters, digits and underscores. */
  table: string;
  /** A K-08 safe id: never a number, an address or words. */
  id: string;
}

/** The call failed, so nothing is known and nothing changed (K-13 v1 `unavailableError`). */
export interface UnavailableError {
  error: "unavailable";
}

// ---- uploadLink ----

/** K-13 v1 `uploadLink.request`: a signed upload from a secure page. */
export interface UploadLinkRequest {
  kind: UploadKind;
  owner: UploadOwner;
  /** The file's type as the browser reports it; checked again on the stored bytes. */
  mediaType: UploadMediaType;
  /** The file's size as the browser reports it; checked again on the stored bytes. */
  sizeBytes: number;
  visibility: Visibility;
  /** How long the link lasts: 60 to 1800 seconds. */
  lifeSeconds: number;
}

/** K-13 v1 `uploadLink.response`: one PUT of one file, of the type asked, to `url` before `expiresAt`. */
export interface UploadLinkReady {
  result: "ready";
  /** Kept on the server with the upload id; never given to the page. */
  objectKey: ObjectKey;
  url: string;
  method: "PUT";
  contentType: UploadMediaType;
  maxBytes: number;
  expiresAt: string;
}

/** K-13 v1 `uploadLink.errors`. */
export type UploadLinkError =
  | { error: "tooLarge"; maxBytes: number }
  | { error: "wrongType"; allowed: UploadMediaType[] }
  | UnavailableError;

export type UploadLinkOutcome = UploadLinkReady | UploadLinkError;

// ---- checkUpload ----

/** K-13 v1 `checkUpload.request`: what came to an upload link. */
export interface CheckUploadRequest {
  objectKey: ObjectKey;
  /** The type the upload was asked as. */
  mediaType: UploadMediaType;
  maxBytes: number;
}

/** K-13 v1 `checkUpload.response`. */
export type CheckUploadResult =
  | { result: "stored"; sizeBytes: number; mediaType: UploadMediaType; storedAt: string }
  | { result: "notStored" };

/** K-13 v1 `checkUpload.errors`: a refused file is removed before the answer. */
export type CheckUploadError =
  | { error: "tooLarge"; maxBytes: number; sizeBytes: number; removed: true }
  | { error: "wrongType"; allowed: UploadMediaType[]; removed: true }
  | UnavailableError;

export type CheckUploadOutcome = CheckUploadResult | CheckUploadError;

// ---- readLink ----

/** K-13 v1 `readLink.request`: asked only after the caller's own check of who may see the file. */
export interface ReadLinkRequest {
  /** Unsealed from its row on the server, never from a browser. */
  objectKey: ObjectKey;
  /** The row that names the file: the view's log line names it, never the key. */
  file: RowRef;
  viewer: Viewer;
  /** How long the link lasts: 60 to 900 seconds. */
  lifeSeconds: number;
}

/** K-13 v1 `readLink.response`: always an attachment with nosniff, never inline. */
export interface ReadLinkGiven {
  result: "link";
  url: string;
  expiresAt: string;
  disposition: "attachment";
  noSniff: true;
}

/** K-13 v1 `readLink.errors`. */
export type ReadLinkError = { error: "notFound" } | UnavailableError;

export type ReadLinkOutcome = ReadLinkGiven | ReadLinkError;

// ---- serverWrite ----

/** Where a server write's bytes came from (K-13 v1 `source`). */
export type WriteSource = { kind: "rosie" } | { kind: "linq"; eventId: string; attachmentId: string };

/** K-13 v1 `serverWrite.request`. The bytes travel beside it as the call's body, never in it. */
export interface ServerWriteRequest {
  kind: WriteKind;
  owner: FileOwner;
  mediaType: MediaType;
  /** The body's size. */
  sizeBytes: number;
  /** The body's sha256, lowercase hex. */
  sha256: string;
  /** 26 lowercase letters and digits, made once per object and kept for every retry. */
  writeId: string;
  /** The key's day, YYYY-MM-DD. */
  day: string;
  visibility: Visibility;
  source: WriteSource;
}

/** K-13 v1 `serverWrite.response`. */
export interface ServerWriteStored {
  result: "stored";
  objectKey: ObjectKey;
  storedAt: string;
  /** True when the same bytes were already under this key: nothing was written again. */
  repeated: boolean;
}

/** K-13 v1 `serverWrite.errors`. */
export type ServerWriteError = { error: "conflict" } | UnavailableError;

export type ServerWriteOutcome = ServerWriteStored | ServerWriteError;

// ---- serverRead ----

/** K-13 v1 `serverRead.request`: Rosie's own read of an object's bytes, for no person's eyes. */
export interface ServerReadRequest {
  objectKey: ObjectKey;
  /** The row that names the file, or null where no row names it yet. */
  file: RowRef | null;
}

/** K-13 v1 `serverRead.response`: the bytes come beside it. */
export interface ServerReadResult {
  result: "read";
  mediaType: MediaType;
  sizeBytes: number;
}

/** K-13 v1 `serverRead.errors`. */
export type ServerReadError = { error: "notFound" } | UnavailableError;

export type ServerReadOutcome = ServerReadResult | ServerReadError;

/** What serverRead gives: the answer, and the object's bytes beside it (README default 11), or none on an error. */
export type ServerReadAnswer =
  { outcome: ServerReadResult; bytes: Uint8Array } | { outcome: ServerReadError; bytes: null };

// ---- deleteObject ----

/** Whose erasure, and when the request was checked to be theirs (RULES 4.10). */
export interface Erasure {
  personId: string;
  checkedAt: string;
}

/** K-13 v1 `deleteObject.request`: for erasure under RULES 4.10 only (Q-31: no deletion rule is invented). */
export interface DeleteObjectRequest {
  objectKey: ObjectKey;
  file: RowRef;
  reason: "erasure";
  erasure: Erasure;
}

/** K-13 v1 `deleteObject.response`. */
export interface ObjectDeleted {
  result: "deleted";
  /** True when no object was there to delete. */
  alreadyGone: boolean;
}

/** K-13 v1 `deleteObject.errors`. */
export type DeleteObjectError = UnavailableError;

export type DeleteObjectOutcome = ObjectDeleted | DeleteObjectError;

// ---- the calls ----

/** The port's six calls, as K-13 v1 names them. */
export type FilesCallName =
  "uploadLink" | "checkUpload" | "readLink" | "serverWrite" | "serverRead" | "deleteObject";

/** Every error code an answer may carry, which is a span's error_code. */
export type FilesErrorCode = "unavailable" | "tooLarge" | "wrongType" | "notFound" | "conflict";

/** The trace a call's span goes on: the caller's ids, never a number, a name or an address (K-08 v1). */
export interface FilesTrace {
  traceId: string;
  spanId: string;
  /** Its place in the trace, from 1. */
  seq: number;
  bundleId: BundleId;
  turnId: string | null;
  /** A page call's request id or a job's id (K-13 v1 README "Spans"). */
  jobId?: string | null;
  eventId?: string | null;
  /** The handle's id in K-04's handles table, never the number. */
  handleRef: string | null;
  businessId?: string | null;
}

/** What the caller tells the port about one call, for its span. Never a field of the port's request. */
export interface FilesCall {
  /** The trace the span goes on. The double's default is its own trace, numbered in call order. */
  trace?: FilesTrace;
  /** The step whose page or turn asked, such as S1-10. Left out of the span when not given. */
  step?: string;
  /** Which try of this call, from 1. Default: 1. */
  attempt?: number;
}

/**
 * K-13 v1's six calls, as a caller takes them: the double now, the R2 adapter (T-438) on staging. Each answers with a
 * promise; an error K-13 defines is an outcome, never a rejection. A request K-13 has no shape for (a public object,
 * a read with no viewer, a caller's own key, a delete for another reason, a body that is not the request's bytes) is
 * refused with a FilesRequestRefused rejection before any call is made: it writes no span and changes nothing.
 */
export interface FilesPort {
  uploadLink(request: UploadLinkRequest, call?: FilesCall): Promise<UploadLinkOutcome>;
  checkUpload(request: CheckUploadRequest, call?: FilesCall): Promise<CheckUploadOutcome>;
  readLink(request: ReadLinkRequest, call?: FilesCall): Promise<ReadLinkOutcome>;
  serverWrite(request: ServerWriteRequest, body: Uint8Array, call?: FilesCall): Promise<ServerWriteOutcome>;
  serverRead(request: ServerReadRequest, call?: FilesCall): Promise<ServerReadAnswer>;
  deleteObject(request: DeleteObjectRequest, call?: FilesCall): Promise<DeleteObjectOutcome>;
}

/**
 * One view, read back from a readLink span that gave a link (RULES 4.5 "each view logged"; K-13 v1 README default 12):
 * who, on what ground, which row's file, when. Never the key or the link.
 */
export interface ViewRecord {
  at: string;
  traceId: string;
  spanId: string;
  kind: FileKind;
  as: ViewerGround;
  /** The viewer's person id, or null for a listing photo. */
  viewer: string | null;
  fileTable: string;
  fileRow: string;
}
