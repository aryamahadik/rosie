// The span each try of each call writes (T-437; K-13 v1 `filesSpan`, README "Spans"): a K-08 v1 span on the portCall
// hop, provider r2, its call by K-13's name and its attempt. What it got and decided is K-13's closed list, built here
// from the request and the answer, so no object key, link, hash, file name or file ever enters it. An error leaves
// decided out; its name is the span's error_code, with outcome refused (tooLarge, wrongType, notFound, conflict),
// failed or timedOut (unavailable).
//
// A readLink span that gave a link is the view's log line (RULES 4.5 "each view logged"; README default 12; CQ-339's
// default): who, on what ground, which row's file, when. viewRecordOf reads it back.

import { buildOutsideCallSpan, type OutsideCallSpan } from "../../shared/spans";
import { FILE_KINDS, parseObjectKey } from "./keys";
import { VIEWER_GROUNDS } from "./rules";
import type {
  CheckUploadOutcome,
  CheckUploadRequest,
  DeleteObjectOutcome,
  DeleteObjectRequest,
  FileKind,
  FilesCallName,
  FilesErrorCode,
  FilesTrace,
  MediaType,
  OwnerKind,
  ReadLinkOutcome,
  ReadLinkRequest,
  ServerReadOutcome,
  ServerReadRequest,
  ServerWriteOutcome,
  ServerWriteRequest,
  UploadLinkOutcome,
  UploadLinkRequest,
  ViewRecord,
  ViewerGround,
} from "./types";

/** What a call got, K-13 v1 `filesSpan.got`'s closed list. `step` is added from the call. */
export interface FilesGot {
  kind: FileKind;
  owner?: OwnerKind;
  mediaType?: MediaType;
  sizeBytes?: number;
  source?: "rosie" | "linq";
  as?: ViewerGround;
  viewer?: string | null;
  fileTable?: string;
  fileRow?: string;
  erasureOf?: string;
}

/** What a call decided, K-13 v1 `filesSpan.decided`'s closed list. */
export interface FilesDecided {
  result: "ready" | "stored" | "notStored" | "link" | "read" | "deleted";
  sizeBytes?: number;
  repeated?: boolean;
  alreadyGone?: boolean;
}

/** Any answer a call gives. */
export type FilesOutcome =
  | UploadLinkOutcome
  | CheckUploadOutcome
  | ReadLinkOutcome
  | ServerWriteOutcome
  | ServerReadOutcome
  | DeleteObjectOutcome;

function kindOfKey(objectKey: string): FileKind {
  const parsed = parseObjectKey(objectKey);
  // The port checks every key before a span is written, so this is a fault in the caller of this module.
  if (parsed === null) throw new TypeError("the span's key is not a K-13 v1 object key");
  return parsed.kind;
}

export function gotOfUploadLink(request: UploadLinkRequest): FilesGot {
  return {
    kind: request.kind,
    owner: request.owner.kind,
    mediaType: request.mediaType,
    sizeBytes: request.sizeBytes,
  };
}

export function gotOfCheckUpload(request: CheckUploadRequest): FilesGot {
  return { kind: kindOfKey(request.objectKey), mediaType: request.mediaType };
}

export function gotOfReadLink(request: ReadLinkRequest): FilesGot {
  return {
    kind: kindOfKey(request.objectKey),
    as: request.viewer.as,
    viewer: request.viewer.personId,
    fileTable: request.file.table,
    fileRow: request.file.id,
  };
}

export function gotOfServerWrite(request: ServerWriteRequest): FilesGot {
  return {
    kind: request.kind,
    owner: request.owner.kind,
    mediaType: request.mediaType,
    sizeBytes: request.sizeBytes,
    source: request.source.kind,
  };
}

export function gotOfServerRead(request: ServerReadRequest): FilesGot {
  const got: FilesGot = { kind: kindOfKey(request.objectKey) };
  return request.file === null ? got : { ...got, fileTable: request.file.table, fileRow: request.file.id };
}

export function gotOfDeleteObject(request: DeleteObjectRequest): FilesGot {
  return {
    kind: kindOfKey(request.objectKey),
    fileTable: request.file.table,
    fileRow: request.file.id,
    erasureOf: request.erasure.personId,
  };
}

/** How a call ended, for its span: what it decided, or its error's code. */
export type FilesEnded = { decided: FilesDecided } | { errorCode: FilesErrorCode };

/** The span's ending, read from the answer: the error's name, or the decision in labels and counts. */
export function endedOf(outcome: FilesOutcome): FilesEnded {
  if ("error" in outcome) return { errorCode: outcome.error };
  switch (outcome.result) {
    case "ready":
    case "notStored":
    case "link":
      return { decided: { result: outcome.result } };
    case "stored":
      return "repeated" in outcome
        ? { decided: { result: "stored", repeated: outcome.repeated } }
        : { decided: { result: "stored", sizeBytes: outcome.sizeBytes } };
    case "read":
      return { decided: { result: "read", sizeBytes: outcome.sizeBytes } };
    case "deleted":
      return { decided: { result: "deleted", alreadyGone: outcome.alreadyGone } };
  }
}

export interface FilesSpanInput {
  call: FilesCallName;
  trace: FilesTrace;
  /** When the call started. */
  at: Date;
  /** How long it took, in milliseconds. */
  ms: number;
  /** Which try, from 1. */
  attempt: number;
  /** The step whose page or turn asked, when the caller named one. */
  step?: string | undefined;
  got: FilesGot;
  outcome: FilesOutcome;
  /** For unavailable: true when the call ran out of time (outcome timedOut), false when R2 failed it (failed). */
  timedOut?: boolean;
}

/** The call's K-08 v1 span, which K-13 v1's `filesSpan` accepts. */
export function buildFilesSpan(input: FilesSpanInput): OutsideCallSpan {
  const ended = endedOf(input.outcome);
  const got = input.step === undefined ? { ...input.got } : { step: input.step, ...input.got };
  const common = {
    traceId: input.trace.traceId,
    spanId: input.trace.spanId,
    seq: input.trace.seq,
    hop: "portCall",
    at: input.at,
    ms: input.ms,
    bundleId: input.trace.bundleId,
    turnId: input.trace.turnId,
    jobId: input.trace.jobId ?? null,
    eventId: input.trace.eventId ?? null,
    handleRef: input.trace.handleRef,
    businessId: input.trace.businessId ?? null,
    provider: "r2",
    call: input.call,
    attempt: input.attempt,
    got,
  } as const;
  if ("errorCode" in ended) {
    const outcome =
      ended.errorCode === "unavailable" ? (input.timedOut === true ? "timedOut" : "failed") : "refused";
    return buildOutsideCallSpan({ ...common, outcome, errorCode: ended.errorCode });
  }
  return buildOutsideCallSpan({ ...common, decided: { ...ended.decided }, outcome: "ok" });
}

/**
 * The view a readLink span records, or null when the span is no view (another call, an error, or no link given). A view
 * is the link's giving: one per readLink that answered a link (README default 12).
 */
export function viewRecordOf(span: OutsideCallSpan): ViewRecord | null {
  if (span.provider !== "r2" || span.call !== "readLink" || span.outcome !== "ok") return null;
  if (span.decided?.result !== "link") return null;
  const { kind, as, viewer, fileTable, fileRow } = span.got ?? {};
  const fileKind = FILE_KINDS.find((candidate) => candidate === kind);
  const ground = VIEWER_GROUNDS.find((candidate) => candidate === as);
  if (fileKind === undefined || ground === undefined) return null;
  if (typeof fileTable !== "string" || typeof fileRow !== "string") return null;
  if (viewer !== null && typeof viewer !== "string") return null;
  return {
    at: span.at,
    traceId: span.trace_id,
    spanId: span.span_id,
    kind: fileKind,
    as: ground,
    viewer,
    fileTable,
    fileRow,
  };
}
