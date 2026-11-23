// The files double (T-437; C-219; K-13 v1 README "The double"): the stand-in for R2 in every test, and the files port's
// first implementation, before the R2 adapter (T-438). An in-memory store holding each object's bytes, type, size and
// owner by key. It makes no network call, reads no key and logs nothing, so no key, link, hash or file leaves it.
//
//   uploadLink    a link for one file: wrongType (the type first), tooLarge (over 10 MiB), or ready with a key the
//                 port makes (`<kind>/<day>/<id>`) and an opaque https://files.example/upload/... address.
//   put           the browser's PUT, test-only: stores the bytes under the link's key, as the link would; refused after
//                 expiresAt, past maxBytes, with another Content-Type, a second time, or on any other address.
//   checkUpload   reads what came by its leading bytes (../port/sniff.ts), never the Content-Type alone: stored,
//                 notStored, or refused with the file removed before the answer.
//   readLink      only on the caller's permission token (the request's viewer): a short link to one object, until its
//                 end, always an attachment with nosniff; notFound when nothing is under the key. Its span is the view's
//                 log line, read back by views().
//   get           the read link fetched, test-only: the bytes with Content-Disposition: attachment and
//                 X-Content-Type-Options: nosniff until its end; nothing is ever served without a live read link, so no
//                 object is public.
//   serverWrite   a system object under `<kind>/<day>/<writeId>`: stored; the same bytes again answer repeated with the
//                 first storedAt; other bytes answer conflict and are never written over. The body must be the
//                 request's bytes (sizeBytes and sha256).
//   serverRead    an object's bytes beside the answer, for Rosie's own code; no view.
//   deleteObject  for erasure only: deleted, or alreadyGone; read links to it then serve nothing.
//   failNext      the test's choice, never a field of a request: the next call (or `times` calls) answers unavailable,
//                 writing its span (failed, or timedOut); later calls answer as before.
//   objects()     the keys it holds, so an erasure test can see nothing is left; objectInfo(key) each one's owner,
//                 type, size and visibility (always private).
//
// A request K-13 v1 has no shape for is refused with FilesRequestRefused before any call: no span, nothing changes, and
// its fields at fault are kept for the test (never their values). Each call writes one K-08 v1 portCall span, provider
// r2, which K-13 v1's filesSpan accepts; with no trace given, it goes on the double's own.

import type { BundleId, OutsideCallSpan } from "../../shared/spans";
import {
  buildFilesSpan,
  checkCheckUploadRequest,
  checkDeleteObjectRequest,
  checkReadLinkRequest,
  checkServerReadRequest,
  checkServerWriteRequest,
  checkUploadLinkRequest,
  dayOf,
  FilesRequestRefused,
  gotOfCheckUpload,
  gotOfDeleteObject,
  gotOfReadLink,
  gotOfServerRead,
  gotOfServerWrite,
  gotOfUploadLink,
  isKeyId,
  linkExpiresAt,
  linkIsLive,
  newKeyId,
  objectKeyOf,
  sha256Hex,
  SNIFF_BYTES,
  storedFileRefusal,
  UPLOAD_MAX_BYTES,
  uploadLinkRefusal,
  utcSeconds,
  viewRecordOf,
  writeBodyProblems,
  writeObjectKey,
  type Checked,
  type CheckUploadOutcome,
  type CheckUploadRequest,
  type DeleteObjectOutcome,
  type DeleteObjectRequest,
  type FileKind,
  type FileOwner,
  type FilesCall,
  type FilesCallName,
  type FilesGot,
  type FilesOutcome,
  type FilesPort,
  type FilesTrace,
  type MediaType,
  type ObjectKey,
  type ReadLinkOutcome,
  type ReadLinkRequest,
  type ServerReadAnswer,
  type ServerReadOutcome,
  type ServerReadRequest,
  type ServerWriteOutcome,
  type ServerWriteRequest,
  type UploadKind,
  type UploadLinkOutcome,
  type UploadLinkRequest,
  type UploadMediaType,
  type UploadOwner,
  type ViewRecord,
} from "../port";

export interface FilesDoubleOptions {
  /** The clock, an RFC 3339 UTC time, read at each call and each put or get. Default: the real clock. */
  readonly now?: () => string;
  /**
   * The id of the next upload key (26 lowercase letters and digits), so a test can replay a fixture's key. Default: the
   * port's own, from crypto.getRandomValues.
   */
  readonly newId?: () => string;
  /**
   * The address of the next link (https), so a test can replay a fixture's address. Default: an opaque
   * https://files.example/upload/... or https://files.example/read/... address that holds no key.
   */
  readonly linkUrl?: (use: "upload" | "read") => string;
}

export interface FailOptions {
  /** How many calls take the error. Default: 1. */
  readonly times?: number;
  /** True when the error is a timeout (the span's outcome timedOut); false or absent for a failure (failed). */
  readonly timedOut?: boolean;
}

/** One request the double took (one K-13 v1 has the shape of), with its call. */
export type FilesRequestRecord =
  | { call: "uploadLink"; request: UploadLinkRequest }
  | { call: "checkUpload"; request: CheckUploadRequest }
  | { call: "readLink"; request: ReadLinkRequest }
  | { call: "serverWrite"; request: ServerWriteRequest }
  | { call: "serverRead"; request: ServerReadRequest }
  | { call: "deleteObject"; request: DeleteObjectRequest };

/** One request K-13 v1 has no shape for, with the fields at fault (never their values). */
export interface RejectedRequest {
  call: FilesCallName;
  request: unknown;
  problems: string[];
}

/** Why the browser's PUT was refused. */
export type PutRefusal = "unknownLink" | "expired" | "used" | "wrongContentType" | "tooLarge";

/** What the browser's PUT to an upload link got. */
export type PutAnswer =
  | { result: "stored"; status: 200 }
  | { result: "refused"; status: 403 | 409 | 413 | 415; reason: PutRefusal };

/** Why a fetch of an address served nothing. */
export type GetRefusal = "unknownLink" | "expired" | "notFound";

/** What a fetch of a read link got: the file, always an attachment with nosniff, or nothing. */
export type GetAnswer =
  | {
      result: "served";
      status: 200;
      bytes: Uint8Array;
      headers: {
        "Content-Type": MediaType;
        "Content-Disposition": "attachment";
        "X-Content-Type-Options": "nosniff";
      };
    }
  | { result: "refused"; status: 403 | 404; reason: GetRefusal };

/** What the double holds for one object, without its bytes. */
export interface StoredObjectInfo {
  objectKey: ObjectKey;
  kind: FileKind;
  owner: FileOwner;
  mediaType: MediaType;
  sizeBytes: number;
  /** Every object is private: nothing is served without a read link. */
  visibility: "private";
  storedAt: string;
  /** How it came: by an upload link, or a server write from Rosie's code or by text. */
  came: "upload" | "rosie" | "linq";
}

/**
 * The trace a span goes on when the caller gives none: placeholder ids, numbered in call order, and bundle v0's id
 * (K-01 bundle-v0-skeleton.json), as K-13 v1's span fixtures use. No turn and no handle.
 */
export const FILES_DOUBLE_TRACE: { readonly traceId: string; readonly bundleId: BundleId } = {
  traceId: "trace-files-double",
  bundleId: { hash: "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037", build: 1 },
};

/** The double's own link host (K-13 v1 README "The double": opaque https://files.example/... addresses). */
export const DOUBLE_LINK_HOST = "https://files.example";

const HTTPS_URL = /^https:\/\/[^\s]+$/;

interface StoredObject {
  kind: FileKind;
  owner: FileOwner;
  mediaType: MediaType;
  bytes: Uint8Array;
  sha256: string;
  storedAt: string;
  came: StoredObjectInfo["came"];
}

interface UploadLinkRecord {
  objectKey: ObjectKey;
  kind: UploadKind;
  owner: UploadOwner;
  contentType: UploadMediaType;
  maxBytes: number;
  expiresAt: string;
  used: boolean;
}

interface ReadLinkRecord {
  objectKey: ObjectKey;
  expiresAt: string;
}

interface Script {
  readonly timedOut: boolean;
  remaining: number;
}

/** What one call will answer, and what it changes once its span is written. */
interface Plan<O extends FilesOutcome> {
  outcome: O;
  commit?: () => void;
  bytes?: Uint8Array | null;
}

const defaultNow = (): string => new Date().toISOString();

export class FilesDouble implements FilesPort {
  readonly #nowFn: () => string;
  readonly #newIdFn: () => string;
  readonly #linkUrlFn: ((use: "upload" | "read") => string) | undefined;
  #objects = new Map<ObjectKey, StoredObject>();
  #uploadLinks = new Map<string, UploadLinkRecord>();
  #readLinks = new Map<string, ReadLinkRecord>();
  /** Every key an upload link was made for: the port never makes the same key twice. */
  #issued = new Set<ObjectKey>();
  #requests: FilesRequestRecord[] = [];
  #rejected: RejectedRequest[] = [];
  #spans: OutsideCallSpan[] = [];
  #script: Script[] = [];
  /** How many spans went on the double's own trace. */
  #ownSpans = 0;

  constructor(options: FilesDoubleOptions = {}) {
    this.#nowFn = options.now ?? defaultNow;
    this.#newIdFn = options.newId ?? newKeyId;
    this.#linkUrlFn = options.linkUrl;
  }

  // ---- what the test chooses ----

  /** The next call (any of the six; or the next `times` calls) answers unavailable; later calls answer as before. */
  failNext(options: FailOptions = {}): void {
    const times = options.times ?? 1;
    if (!Number.isInteger(times) || times < 1)
      throw new TypeError("failNext: times is not a whole number of 1 or more");
    this.#script.push({ timedOut: options.timedOut === true, remaining: times });
  }

  /** Back to a new double: no object, no link, no record, no span, no error waiting. */
  reset(): void {
    this.#objects = new Map();
    this.#uploadLinks = new Map();
    this.#readLinks = new Map();
    this.#issued = new Set();
    this.#requests = [];
    this.#rejected = [];
    this.#spans = [];
    this.#script = [];
    this.#ownSpans = 0;
  }

  // ---- the browser's side, test-only ----

  /**
   * The browser's PUT to an upload link: stores the bytes under the link's key, as the link would, once. Refused (and
   * nothing stored) on an address that is no live upload link, after expiresAt, a second time, with a Content-Type other
   * than the type asked, or past maxBytes.
   */
  async put(url: string, bytes: Uint8Array, contentType: string): Promise<PutAnswer> {
    const sha256 = await sha256Hex(bytes);
    const link = this.#uploadLinks.get(url);
    if (link === undefined) return { result: "refused", status: 403, reason: "unknownLink" };
    const now = this.#clock();
    if (!linkIsLive(link.expiresAt, now)) return { result: "refused", status: 403, reason: "expired" };
    if (link.used || this.#objects.has(link.objectKey))
      return { result: "refused", status: 409, reason: "used" };
    if (contentType !== link.contentType)
      return { result: "refused", status: 415, reason: "wrongContentType" };
    if (bytes.byteLength > link.maxBytes) return { result: "refused", status: 413, reason: "tooLarge" };
    link.used = true;
    this.#objects.set(link.objectKey, {
      kind: link.kind,
      owner: structuredClone(link.owner),
      mediaType: link.contentType,
      bytes: bytes.slice(),
      sha256,
      storedAt: utcSeconds(now),
      came: "upload",
    });
    return { result: "stored", status: 200 };
  }

  /**
   * A fetch of an address: a live read link serves its one object's bytes as an attachment with nosniff; any other
   * address (an upload link, an object's key, a lapsed or unknown link) serves nothing, so no object is public.
   */
  get(url: string): GetAnswer {
    const link = this.#readLinks.get(url);
    if (link === undefined) return { result: "refused", status: 403, reason: "unknownLink" };
    if (!linkIsLive(link.expiresAt, this.#clock()))
      return { result: "refused", status: 403, reason: "expired" };
    const stored = this.#objects.get(link.objectKey);
    if (stored === undefined) return { result: "refused", status: 404, reason: "notFound" };
    return {
      result: "served",
      status: 200,
      bytes: stored.bytes.slice(),
      headers: {
        "Content-Type": stored.mediaType,
        "Content-Disposition": "attachment",
        "X-Content-Type-Options": "nosniff",
      },
    };
  }

  // ---- what the test reads ----

  /** The keys the double holds, in the order they were stored. */
  objects(): string[] {
    return [...this.#objects.keys()];
  }

  /** What the double holds under a key, without its bytes; null when nothing is there. */
  objectInfo(objectKey: string): StoredObjectInfo | null {
    const stored = this.#objects.get(objectKey);
    if (stored === undefined) return null;
    return {
      objectKey,
      kind: stored.kind,
      owner: structuredClone(stored.owner),
      mediaType: stored.mediaType,
      sizeBytes: stored.bytes.byteLength,
      visibility: "private",
      storedAt: stored.storedAt,
      came: stored.came,
    };
  }

  /** Every request the double took (one K-13 v1 has the shape of), with its call, in order. */
  requests(): readonly FilesRequestRecord[] {
    return structuredClone(this.#requests);
  }

  /** Requests K-13 v1 has no shape for, in order, with the fields at fault (never their values). */
  rejectedRequests(): readonly RejectedRequest[] {
    return structuredClone(this.#rejected);
  }

  /** The span each call wrote, in order. */
  spans(): readonly OutsideCallSpan[] {
    return structuredClone(this.#spans);
  }

  /** Each view, one per read link given, read back from its span (RULES 4.5 "each view logged"). */
  views(): readonly ViewRecord[] {
    return this.#spans.map(viewRecordOf).filter((view): view is ViewRecord => view !== null);
  }

  // ---- the port's calls ----

  uploadLink(request: unknown, call: FilesCall = {}): Promise<UploadLinkOutcome> {
    return settle(
      () =>
        this.#run("uploadLink", request, call, checkUploadLinkRequest, gotOfUploadLink, (asked, now) =>
          this.#planUploadLink(asked, now),
        ).outcome,
    );
  }

  checkUpload(request: unknown, call: FilesCall = {}): Promise<CheckUploadOutcome> {
    return settle(
      () =>
        this.#run("checkUpload", request, call, checkCheckUploadRequest, gotOfCheckUpload, (asked) =>
          this.#planCheckUpload(asked),
        ).outcome,
    );
  }

  readLink(request: unknown, call: FilesCall = {}): Promise<ReadLinkOutcome> {
    return settle(
      () =>
        this.#run("readLink", request, call, checkReadLinkRequest, gotOfReadLink, (asked, now) =>
          this.#planReadLink(asked, now),
        ).outcome,
    );
  }

  async serverWrite(request: unknown, body: Uint8Array, call: FilesCall = {}): Promise<ServerWriteOutcome> {
    const checked = checkServerWriteRequest(request);
    // A copy, so the bytes checked are the bytes kept.
    const bytes: unknown = body instanceof Uint8Array ? body.slice() : body;
    if (checked.request !== null) {
      const problems = await writeBodyProblems(checked.request, bytes);
      if (problems.length > 0) this.#refuse("serverWrite", request, problems);
    }
    return this.#run(
      "serverWrite",
      request,
      call,
      () => checked,
      gotOfServerWrite,
      (asked, now) => this.#planServerWrite(asked, bytes as Uint8Array, now),
    ).outcome;
  }

  serverRead(request: unknown, call: FilesCall = {}): Promise<ServerReadAnswer> {
    return settle(() => {
      const plan = this.#run("serverRead", request, call, checkServerReadRequest, gotOfServerRead, (asked) =>
        this.#planServerRead(asked),
      );
      const { outcome, bytes } = plan;
      if ("error" in outcome) return { outcome, bytes: null };
      if (bytes === undefined || bytes === null) throw new Error("serverRead: the bytes were lost");
      return { outcome, bytes };
    });
  }

  deleteObject(request: unknown, call: FilesCall = {}): Promise<DeleteObjectOutcome> {
    return settle(
      () =>
        this.#run("deleteObject", request, call, checkDeleteObjectRequest, gotOfDeleteObject, (asked) =>
          this.#planDeleteObject(asked),
        ).outcome,
    );
  }

  // ---- inside: each call's answer ----

  #planUploadLink(request: UploadLinkRequest, now: Date): Plan<UploadLinkOutcome> {
    const refusal = uploadLinkRefusal(request);
    if (refusal !== null) return { outcome: refusal };
    const id = this.#newIdFn();
    if (!isKeyId(id)) throw new TypeError("newId: the id is not 26 lowercase letters and digits");
    const objectKey = objectKeyOf(request.kind, dayOf(now), id);
    if (this.#issued.has(objectKey) || this.#objects.has(objectKey))
      throw new TypeError("newId: the key is already in use (the port never makes the same key twice)");
    const url = this.#address("upload", objectKey);
    const expiresAt = linkExpiresAt(now, request.lifeSeconds);
    return {
      outcome: {
        result: "ready",
        objectKey,
        url,
        method: "PUT",
        contentType: request.mediaType,
        maxBytes: UPLOAD_MAX_BYTES,
        expiresAt,
      },
      commit: () => {
        this.#issued.add(objectKey);
        this.#uploadLinks.set(url, {
          objectKey,
          kind: request.kind,
          owner: structuredClone(request.owner),
          contentType: request.mediaType,
          maxBytes: UPLOAD_MAX_BYTES,
          expiresAt,
          used: false,
        });
      },
    };
  }

  #planCheckUpload(request: CheckUploadRequest): Plan<CheckUploadOutcome> {
    const stored = this.#objects.get(request.objectKey);
    if (stored === undefined) return { outcome: { result: "notStored" } };
    const refusal = storedFileRefusal(
      { sizeBytes: stored.bytes.byteLength, leading: stored.bytes.subarray(0, SNIFF_BYTES) },
      request,
    );
    if (refusal !== null)
      return {
        outcome: refusal,
        commit: () => {
          this.#objects.delete(request.objectKey);
        },
      };
    return {
      outcome: {
        result: "stored",
        sizeBytes: stored.bytes.byteLength,
        mediaType: request.mediaType,
        storedAt: stored.storedAt,
      },
    };
  }

  #planReadLink(request: ReadLinkRequest, now: Date): Plan<ReadLinkOutcome> {
    if (!this.#objects.has(request.objectKey)) return { outcome: { error: "notFound" } };
    const url = this.#address("read", request.objectKey);
    const expiresAt = linkExpiresAt(now, request.lifeSeconds);
    return {
      outcome: { result: "link", url, expiresAt, disposition: "attachment", noSniff: true },
      commit: () => {
        this.#readLinks.set(url, { objectKey: request.objectKey, expiresAt });
      },
    };
  }

  #planServerWrite(request: ServerWriteRequest, body: Uint8Array, now: Date): Plan<ServerWriteOutcome> {
    const objectKey = writeObjectKey(request);
    const there = this.#objects.get(objectKey);
    if (there !== undefined)
      return there.sha256 === request.sha256
        ? { outcome: { result: "stored", objectKey, storedAt: there.storedAt, repeated: true } }
        : { outcome: { error: "conflict" } };
    // A key an upload link was made for belongs to that upload: a write never lands on it.
    if (this.#issued.has(objectKey)) return { outcome: { error: "conflict" } };
    const storedAt = utcSeconds(now);
    return {
      outcome: { result: "stored", objectKey, storedAt, repeated: false },
      commit: () => {
        this.#objects.set(objectKey, {
          kind: request.kind,
          owner: structuredClone(request.owner),
          mediaType: request.mediaType,
          bytes: body.slice(),
          sha256: request.sha256,
          storedAt,
          came: request.source.kind,
        });
      },
    };
  }

  #planServerRead(request: ServerReadRequest): Plan<ServerReadOutcome> {
    const stored = this.#objects.get(request.objectKey);
    if (stored === undefined) return { outcome: { error: "notFound" }, bytes: null };
    return {
      outcome: { result: "read", mediaType: stored.mediaType, sizeBytes: stored.bytes.byteLength },
      bytes: stored.bytes.slice(),
    };
  }

  #planDeleteObject(request: DeleteObjectRequest): Plan<DeleteObjectOutcome> {
    const there = this.#objects.has(request.objectKey);
    return {
      outcome: { result: "deleted", alreadyGone: !there },
      commit: () => {
        this.#objects.delete(request.objectKey);
        // An upload link not yet used for this key can no longer land a file: nothing comes back after an erasure.
        for (const link of this.#uploadLinks.values())
          if (link.objectKey === request.objectKey) link.used = true;
      },
    };
  }

  // ---- inside: the common run of a call ----

  /**
   * One call: the request checked (refused with no span when K-13 has no shape for it), the error the test set or the
   * call's answer, then its span. The span is built before anything changes, so a call whose span cannot be written
   * (an attempt below 1, a clock that gives no time) is refused and leaves nothing behind.
   */
  #run<R, O extends FilesOutcome>(
    name: FilesCallName,
    request: unknown,
    call: FilesCall,
    check: (request: unknown) => Checked<R>,
    got: (request: R) => FilesGot,
    plan: (request: R, now: Date) => Plan<O>,
  ): Plan<O> {
    const checked = check(request);
    if (checked.request === null) return this.#refuse(name, request, checked.problems);
    const asked = checked.request;
    const now = this.#clock();
    const scripted = this.#script[0];
    const planned: Plan<O> =
      scripted === undefined ? plan(asked, now) : { outcome: { error: "unavailable" } as O, bytes: null };
    const span = buildFilesSpan({
      call: name,
      trace: call.trace ?? this.#ownTrace(),
      at: now,
      ms: 0,
      attempt: call.attempt ?? 1,
      step: call.step,
      got: got(asked),
      outcome: planned.outcome,
      timedOut: scripted?.timedOut === true,
    });
    planned.commit?.();
    if (scripted !== undefined) {
      scripted.remaining -= 1;
      if (scripted.remaining <= 0) this.#script.shift();
    }
    if (call.trace === undefined) this.#ownSpans += 1;
    this.#spans.push(span);
    this.#requests.push({ call: name, request: structuredClone(asked) } as FilesRequestRecord);
    return { outcome: structuredClone(planned.outcome), bytes: planned.bytes ?? null };
  }

  /** A request K-13 v1 has no shape for: refused before any call, no span, and its fields at fault kept. */
  #refuse(call: FilesCallName, request: unknown, problems: string[]): never {
    this.#rejected.push({ call, request: cloneForRecord(request), problems: [...problems] });
    throw new FilesRequestRefused(call, problems);
  }

  #clock(): Date {
    const at = new Date(this.#nowFn());
    if (Number.isNaN(at.getTime())) throw new TypeError("now: the clock gave no valid time");
    return at;
  }

  /** A new link's address: the test's, or an opaque one on the double's host that holds no key. */
  #address(use: "upload" | "read", objectKey: ObjectKey): string {
    const url =
      this.#linkUrlFn === undefined ? `${DOUBLE_LINK_HOST}/${use}/${newKeyId()}` : this.#linkUrlFn(use);
    const id = objectKey.slice(objectKey.lastIndexOf("/") + 1);
    if (!HTTPS_URL.test(url)) throw new TypeError("linkUrl: the address is not https");
    if (url.includes(id)) throw new TypeError("linkUrl: the address holds the object key");
    if (this.#uploadLinks.has(url) || this.#readLinks.has(url))
      throw new TypeError("linkUrl: the address is already a link");
    return url;
  }

  /** The double's own trace for the next span on it. */
  #ownTrace(): FilesTrace {
    const seq = this.#ownSpans + 1;
    return {
      traceId: FILES_DOUBLE_TRACE.traceId,
      spanId: `span-files-double-${String(seq).padStart(4, "0")}`,
      seq,
      bundleId: FILES_DOUBLE_TRACE.bundleId,
      turnId: null,
      handleRef: null,
    };
  }
}

/** A promise of the work's answer, or a rejection with what it threw. */
function settle<T>(work: () => T): Promise<T> {
  try {
    return Promise.resolve(work());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error("the call was not made"));
  }
}

/** A copy of a refused request for the record; a value that cannot be copied is recorded as its type only. */
function cloneForRecord(request: unknown): unknown {
  try {
    return structuredClone(request);
  } catch {
    return typeof request;
  }
}

/** A new files double. */
export function createFilesDouble(options: FilesDoubleOptions = {}): FilesDouble {
  return new FilesDouble(options);
}
