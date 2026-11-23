// What the files port refuses (T-437; K-13 v1): a request the contract has no shape for. The checks are the schema's,
// written by hand, with the code checks it leaves (a day or time that exists in the calendar), so the double and the
// R2 adapter (T-438) refuse exactly the same requests:
//   - every object is private: visibility is "private", never "public" (refuse-public-object.json);
//   - a read link names its viewer, the caller's permission token: whom it checked and on what ground; a listing view
//     names no person and only a photo has one (refuse-read-without-permission.json,
//     refuse-listing-read-of-id-document.json);
//   - the port makes every key: no request names its own (refuse-caller-names-key.json);
//   - an ID document is the person's own, with no business (refuse-id-document-for-business.json);
//   - nothing a browser runs as a page is a type here (refuse-svg-upload.json);
//   - a delete is for erasure only (refuse-delete-without-erasure.json);
//   - each write kind takes its own types, owner and source, and only a photo comes in by text.
// A problem line names the field, never its value (no id, key, name or words in any message).

import { isSafeId } from "../../shared/redact";
import { isDay, isKeyId, isSha256, isUtc, parseObjectKey, sha256Hex } from "./keys";
import {
  MEDIA_TYPES,
  OWNER_KINDS,
  READ_LINK_LIFE,
  UPLOAD_KINDS,
  UPLOAD_LINK_LIFE,
  UPLOAD_MAX_BYTES,
  UPLOAD_MEDIA_TYPES,
  VIEWER_GROUNDS,
  WRITE_KINDS,
  WRITE_RULES,
} from "./rules";
import type {
  CheckUploadRequest,
  DeleteObjectRequest,
  FileKind,
  FilesCallName,
  MediaType,
  OwnerKind,
  ReadLinkRequest,
  ServerReadRequest,
  ServerWriteRequest,
  UploadKind,
  UploadLinkRequest,
  UploadMediaType,
  ViewerGround,
  WriteKind,
} from "./types";

type Obj = Record<string, unknown>;

export interface Checked<T> {
  /** The request, copied, when K-13 v1 has its shape; null when it does not. */
  request: T | null;
  /** The fields at fault, never their values; empty when the request has its shape. */
  problems: string[];
}

/**
 * A request K-13 v1 has no shape for, or a write body that is not the request's bytes: refused before any call is
 * made, so it writes no span and changes nothing. Its message and problems name fields, never values.
 */
export class FilesRequestRefused extends Error {
  override readonly name = "FilesRequestRefused";
  readonly call: FilesCallName;
  readonly problems: readonly string[];

  constructor(call: FilesCallName, problems: readonly string[]) {
    super(`${call}: the request has no shape in K-13 v1 (${problems.join("; ")})`);
    this.call = call;
    this.problems = problems;
  }
}

const TABLE_NAME = /^[a-z][a-z0-9_]*$/;

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(path: string, value: Obj, fields: readonly string[], problems: string[]): void {
  for (const field of fields) if (!(field in value)) problems.push(`${path}.${field} is missing`);
  for (const field of Object.keys(value))
    if (!fields.includes(field)) problems.push(`${path}.${field} is not a field of v1`);
}

/** The common `id`: a non-empty string, compared whole. */
function isId(value: unknown): value is string {
  return typeof value === "string" && /./.test(value);
}

function isIdOrNull(value: unknown): value is string | null {
  return value === null || isId(value);
}

function isWholeInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function checkId(path: string, value: Obj, field: string, nullable: boolean, problems: string[]): void {
  if (!(field in value)) return;
  const ok = nullable ? isIdOrNull(value[field]) : isId(value[field]);
  if (!ok) problems.push(`${path}.${field} is not an id${nullable ? " or null" : ""}`);
}

/** K-13 v1 `owner` of one of the `allowed` kinds, each kind with exactly its own fields; problems pushed otherwise. */
function checkOwner(path: string, owner: unknown, allowed: readonly OwnerKind[], problems: string[]): void {
  if (!isObject(owner)) {
    problems.push(`${path} is not an object`);
    return;
  }
  const kind = owner.kind;
  if (!oneOf(kind, allowed)) {
    problems.push(`${path}.kind is not ${allowed.join(", ")}`);
    return;
  }
  if (kind === "person") {
    exactFields(path, owner, ["kind", "personId", "businessId"], problems);
    checkId(path, owner, "personId", false, problems);
    checkId(path, owner, "businessId", true, problems);
  } else if (kind === "business") {
    exactFields(path, owner, ["kind", "businessId"], problems);
    checkId(path, owner, "businessId", false, problems);
  } else if (kind === "booking") {
    exactFields(path, owner, ["kind", "businessId", "bookingId", "personId"], problems);
    checkId(path, owner, "businessId", false, problems);
    checkId(path, owner, "bookingId", false, problems);
    checkId(path, owner, "personId", true, problems);
  } else {
    exactFields(path, owner, ["kind"], problems);
  }
}

/** K-13 v1 `rowRef`: a K-08 table name and safe id. */
function checkRowRef(path: string, file: unknown, problems: string[]): void {
  if (!isObject(file)) {
    problems.push(`${path} is not an object`);
    return;
  }
  exactFields(path, file, ["table", "id"], problems);
  if ("table" in file && !(typeof file.table === "string" && TABLE_NAME.test(file.table)))
    problems.push(`${path}.table is not a K-08 table name`);
  if ("id" in file && !(typeof file.id === "string" && isSafeId(file.id)))
    problems.push(`${path}.id is not a K-08 safe id`);
}

/** K-13 v1 `viewer`: the caller's permission token. */
function checkViewer(path: string, viewer: unknown, problems: string[]): ViewerGround | null {
  if (!isObject(viewer)) {
    problems.push(`${path} is not an object`);
    return null;
  }
  exactFields(path, viewer, ["as", "personId"], problems);
  const as = viewer.as;
  if (!oneOf(as, VIEWER_GROUNDS)) {
    if ("as" in viewer) problems.push(`${path}.as is not ${VIEWER_GROUNDS.join(", ")}`);
    return null;
  }
  if (!("personId" in viewer)) return as;
  if (as === "listing" && viewer.personId !== null)
    problems.push(`${path}.personId is not null (a listing view names no person)`);
  if (as !== "listing" && !isId(viewer.personId))
    problems.push(`${path}.personId is not an id (every view but the listing's names its viewer)`);
  return as;
}

/** K-13 v1 `objectKey` (or `uploadObjectKey`), on a calendar day: its kind, or null with a problem pushed. */
function checkKey(path: string, key: unknown, uploadOnly: boolean, problems: string[]): FileKind | null {
  const parsed = parseObjectKey(key);
  if (parsed === null) {
    problems.push(`${path} is not a K-13 v1 object key`);
    return null;
  }
  if (uploadOnly && !oneOf<UploadKind>(parsed.kind, UPLOAD_KINDS)) {
    problems.push(`${path} is not an upload kind's key`);
    return null;
  }
  return parsed.kind;
}

function done<T>(request: Obj, problems: string[]): Checked<T> {
  return problems.length === 0
    ? { request: structuredClone(request) as unknown as T, problems }
    : { request: null, problems };
}

/** Checks a request against K-13 v1's `uploadLink.request`. */
export function checkUploadLinkRequest(request: unknown): Checked<UploadLinkRequest> {
  if (!isObject(request)) return { request: null, problems: ["the request is not an object"] };
  const problems: string[] = [];
  exactFields(
    "request",
    request,
    ["kind", "owner", "mediaType", "sizeBytes", "visibility", "lifeSeconds"],
    problems,
  );
  const kind: unknown = request.kind;
  if ("kind" in request && !oneOf<UploadKind>(kind, UPLOAD_KINDS))
    problems.push("request.kind is not an upload kind");
  if ("owner" in request)
    checkOwner("request.owner", request.owner, ["person", "business", "booking"], problems);
  if ("mediaType" in request && !oneOf<UploadMediaType>(request.mediaType, UPLOAD_MEDIA_TYPES))
    problems.push("request.mediaType is not a photo or PDF type");
  if ("sizeBytes" in request && !isWholeInRange(request.sizeBytes, 1, Number.MAX_SAFE_INTEGER))
    problems.push("request.sizeBytes is not a whole number of 1 or more");
  if ("visibility" in request && request.visibility !== "private")
    problems.push("request.visibility is not private (every object is private)");
  if (
    "lifeSeconds" in request &&
    !isWholeInRange(request.lifeSeconds, UPLOAD_LINK_LIFE.min, UPLOAD_LINK_LIFE.max)
  )
    problems.push("request.lifeSeconds is not whole seconds from 60 to 1800");
  if (kind === "idDocument") {
    const owner = request.owner;
    if (!isObject(owner) || owner.kind !== "person" || owner.businessId !== null)
      problems.push("request.owner is not a person with no business (an ID document is the person's own)");
  }
  return done(request, problems);
}

/** Checks a request against K-13 v1's `checkUpload.request`. */
export function checkCheckUploadRequest(request: unknown): Checked<CheckUploadRequest> {
  if (!isObject(request)) return { request: null, problems: ["the request is not an object"] };
  const problems: string[] = [];
  exactFields("request", request, ["objectKey", "mediaType", "maxBytes"], problems);
  if ("objectKey" in request) checkKey("request.objectKey", request.objectKey, true, problems);
  if ("mediaType" in request && !oneOf<UploadMediaType>(request.mediaType, UPLOAD_MEDIA_TYPES))
    problems.push("request.mediaType is not a photo or PDF type");
  if ("maxBytes" in request && request.maxBytes !== UPLOAD_MAX_BYTES)
    problems.push("request.maxBytes is not the 10 MiB limit");
  return done(request, problems);
}

/** Checks a request against K-13 v1's `readLink.request`: no viewer, no link. */
export function checkReadLinkRequest(request: unknown): Checked<ReadLinkRequest> {
  if (!isObject(request)) return { request: null, problems: ["the request is not an object"] };
  const problems: string[] = [];
  exactFields("request", request, ["objectKey", "file", "viewer", "lifeSeconds"], problems);
  const kind =
    "objectKey" in request ? checkKey("request.objectKey", request.objectKey, false, problems) : null;
  if ("file" in request) checkRowRef("request.file", request.file, problems);
  const as = "viewer" in request ? checkViewer("request.viewer", request.viewer, problems) : null;
  if (
    "lifeSeconds" in request &&
    !isWholeInRange(request.lifeSeconds, READ_LINK_LIFE.min, READ_LINK_LIFE.max)
  )
    problems.push("request.lifeSeconds is not whole seconds from 60 to 900");
  if (as === "listing" && kind !== null && kind !== "photo")
    problems.push("request.objectKey is not a photo's (only a photo is shown on the listing)");
  return done(request, problems);
}

/** Checks a request against K-13 v1's `serverWrite.request`, with each write kind's types, owner and source. */
export function checkServerWriteRequest(request: unknown): Checked<ServerWriteRequest> {
  if (!isObject(request)) return { request: null, problems: ["the request is not an object"] };
  const problems: string[] = [];
  exactFields(
    "request",
    request,
    ["kind", "owner", "mediaType", "sizeBytes", "sha256", "writeId", "day", "visibility", "source"],
    problems,
  );
  const kind: unknown = request.kind;
  const known = oneOf<WriteKind>(kind, WRITE_KINDS) ? kind : null;
  if ("kind" in request && known === null) problems.push("request.kind is not a write kind");
  const rules = known === null ? null : WRITE_RULES[known];
  if ("owner" in request) checkOwner("request.owner", request.owner, rules?.owners ?? OWNER_KINDS, problems);
  if ("mediaType" in request) {
    if (!oneOf<MediaType>(request.mediaType, MEDIA_TYPES))
      problems.push("request.mediaType is not a K-13 v1 type");
    else if (rules !== null && !rules.mediaTypes.includes(request.mediaType))
      problems.push("request.mediaType is not a type this write kind takes");
  }
  if ("sizeBytes" in request && !isWholeInRange(request.sizeBytes, 1, Number.MAX_SAFE_INTEGER))
    problems.push("request.sizeBytes is not a whole number of 1 or more");
  if ("sha256" in request && !isSha256(request.sha256))
    problems.push("request.sha256 is not a lowercase hex sha256");
  if ("writeId" in request && !isKeyId(request.writeId))
    problems.push("request.writeId is not 26 lowercase letters and digits");
  if ("day" in request && !isDay(request.day)) problems.push("request.day is not a calendar day");
  if ("visibility" in request && request.visibility !== "private")
    problems.push("request.visibility is not private (every object is private)");
  if ("source" in request) checkSource(request.source, rules?.sources ?? ["rosie", "linq"], problems);
  return done(request, problems);
}

/**
 * The faults of a server write's body against its request: the body travels beside the request, and `sizeBytes` and
 * `sha256` say which bytes, so other bytes are the writer's fault and nothing is written (R2 checks the same sha256 on
 * its put). Empty when the body is the request's bytes.
 */
export async function writeBodyProblems(request: ServerWriteRequest, body: unknown): Promise<string[]> {
  if (!(body instanceof Uint8Array)) return ["body is not bytes"];
  if (body.byteLength !== request.sizeBytes) return ["body is not request.sizeBytes long"];
  return (await sha256Hex(body)) === request.sha256 ? [] : ["body's sha256 is not request.sha256"];
}

function checkSource(source: unknown, allowed: readonly string[], problems: string[]): void {
  if (!isObject(source)) {
    problems.push("request.source is not an object");
    return;
  }
  const kind = source.kind;
  if (kind !== "rosie" && kind !== "linq") {
    problems.push("request.source.kind is not rosie or linq");
    return;
  }
  if (!allowed.includes(kind))
    problems.push("request.source.kind is not one this write kind takes (only a photo comes in by text)");
  if (kind === "rosie") {
    exactFields("request.source", source, ["kind"], problems);
    return;
  }
  exactFields("request.source", source, ["kind", "eventId", "attachmentId"], problems);
  checkId("request.source", source, "eventId", false, problems);
  checkId("request.source", source, "attachmentId", false, problems);
}

/** Checks a request against K-13 v1's `serverRead.request`. */
export function checkServerReadRequest(request: unknown): Checked<ServerReadRequest> {
  if (!isObject(request)) return { request: null, problems: ["the request is not an object"] };
  const problems: string[] = [];
  exactFields("request", request, ["objectKey", "file"], problems);
  if ("objectKey" in request) checkKey("request.objectKey", request.objectKey, false, problems);
  if ("file" in request && request.file !== null) checkRowRef("request.file", request.file, problems);
  return done(request, problems);
}

/** Checks a request against K-13 v1's `deleteObject.request`: for erasure only. */
export function checkDeleteObjectRequest(request: unknown): Checked<DeleteObjectRequest> {
  if (!isObject(request)) return { request: null, problems: ["the request is not an object"] };
  const problems: string[] = [];
  exactFields("request", request, ["objectKey", "file", "reason", "erasure"], problems);
  if ("objectKey" in request) checkKey("request.objectKey", request.objectKey, false, problems);
  if ("file" in request) checkRowRef("request.file", request.file, problems);
  if ("reason" in request && request.reason !== "erasure")
    problems.push(
      "request.reason is not erasure (v1 deletes for erasure only; no deletion rule is invented)",
    );
  if ("erasure" in request) {
    const erasure = request.erasure;
    if (!isObject(erasure)) problems.push("request.erasure is not an object");
    else {
      exactFields("request.erasure", erasure, ["personId", "checkedAt"], problems);
      checkId("request.erasure", erasure, "personId", false, problems);
      if ("checkedAt" in erasure && !isUtc(erasure.checkedAt))
        problems.push("request.erasure.checkedAt is not a UTC time");
    }
  }
  return done(request, problems);
}
