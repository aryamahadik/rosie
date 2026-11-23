// The port's rules (T-437; K-13 v1): the closed lists, each kind's types, owners and sources, and the answers both the
// double and the R2 adapter (T-438) must give the same way. No source gives any call a time budget; the calling stage's
// applies.

import { bytesShowType } from "./sniff";
import { objectKeyOf, utcSeconds } from "./keys";
import type {
  CheckUploadError,
  ImageType,
  MediaType,
  ObjectKey,
  OwnerKind,
  UploadKind,
  UploadLinkError,
  UploadMediaType,
  ViewerGround,
  WriteKind,
  WriteSource,
} from "./types";

export const UPLOAD_KINDS: readonly UploadKind[] = [
  "idDocument",
  "photo",
  "priceList",
  "form",
  "signedDocument",
  "licenseFile",
];

export const WRITE_KINDS: readonly WriteKind[] = [
  "sealedTrace",
  "eventLogExport",
  "export",
  "report",
  "photo",
];

/** The photo types K-21 v1 takes (default 17). Never image/svg+xml. */
export const IMAGE_TYPES: readonly ImageType[] = [
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/webp",
];

/** A photo or a PDF: what an upload takes. */
export const UPLOAD_MEDIA_TYPES: readonly UploadMediaType[] = [...IMAGE_TYPES, "application/pdf"];

/** Every type an object may have, the closed list. */
export const MEDIA_TYPES: readonly MediaType[] = [
  ...UPLOAD_MEDIA_TYPES,
  "video/mp4",
  "video/quicktime",
  "text/csv",
  "application/vnd.apache.parquet",
  "application/octet-stream",
];

export const OWNER_KINDS: readonly OwnerKind[] = ["person", "business", "booking", "rosie"];

export const VIEWER_GROUNDS: readonly ViewerGround[] = ["self", "business", "rosieTeam", "listing"];

/** The largest file an upload takes: 10 MiB (K-13 v1 `uploadMaxBytes`, default 4). */
export const UPLOAD_MAX_BYTES = 10_485_760;

/** An upload link lasts 1 to 30 minutes, as the caller asks (default 3). */
export const UPLOAD_LINK_LIFE = { min: 60, max: 1800 } as const;

/** A read link lasts 1 to 15 minutes, as the caller asks (default 3). */
export const READ_LINK_LIFE = { min: 60, max: 900 } as const;

/** Each write kind's types, owners and sources (K-13 v1 README "Media types" and "Owners"; default 17). */
export const WRITE_RULES: Readonly<
  Record<
    WriteKind,
    {
      readonly mediaTypes: readonly MediaType[];
      readonly owners: readonly OwnerKind[];
      readonly sources: readonly WriteSource["kind"][];
    }
  >
> = {
  sealedTrace: { mediaTypes: ["application/octet-stream"], owners: ["rosie"], sources: ["rosie"] },
  eventLogExport: { mediaTypes: ["application/vnd.apache.parquet"], owners: ["rosie"], sources: ["rosie"] },
  export: { mediaTypes: ["text/csv"], owners: ["business"], sources: ["rosie"] },
  report: {
    mediaTypes: ["application/pdf", ...IMAGE_TYPES, "video/mp4", "video/quicktime"],
    owners: ["booking"],
    sources: ["rosie"],
  },
  photo: { mediaTypes: IMAGE_TYPES, owners: ["person", "business", "booking"], sources: ["rosie", "linq"] },
};

/** The types an upload kind takes: a photo the image types only; every other kind a photo or a PDF. */
export function uploadTypesFor(kind: UploadKind): UploadMediaType[] {
  return kind === "photo" ? [...IMAGE_TYPES] : [...UPLOAD_MEDIA_TYPES];
}

/**
 * Why uploadLink gives no link, or null when it gives one: the type is checked first (a PDF asked as a photo answers
 * wrongType with the kind's types), then the size (over 10 MiB answers tooLarge).
 */
export function uploadLinkRefusal(request: {
  kind: UploadKind;
  mediaType: UploadMediaType;
  sizeBytes: number;
}): Exclude<UploadLinkError, { error: "unavailable" }> | null {
  const allowed = uploadTypesFor(request.kind);
  if (!allowed.includes(request.mediaType)) return { error: "wrongType", allowed };
  if (request.sizeBytes > UPLOAD_MAX_BYTES) return { error: "tooLarge", maxBytes: UPLOAD_MAX_BYTES };
  return null;
}

/**
 * What checkUpload answers for a file that came, or null when it is kept: its leading bytes must show the type asked
 * (never the browser's word), then it must be within maxBytes. A refused file is removed before the answer, so each
 * refusal says removed.
 */
export function storedFileRefusal(
  stored: { sizeBytes: number; leading: Uint8Array },
  asked: { mediaType: UploadMediaType; maxBytes: number },
): Exclude<CheckUploadError, { error: "unavailable" }> | null {
  if (!bytesShowType(stored.leading, asked.mediaType))
    return { error: "wrongType", allowed: [asked.mediaType], removed: true };
  if (stored.sizeBytes > asked.maxBytes)
    return { error: "tooLarge", maxBytes: asked.maxBytes, sizeBytes: stored.sizeBytes, removed: true };
  return null;
}

/** When a link made at `now` for `lifeSeconds` stops working, in whole seconds: now plus the life. */
export function linkExpiresAt(now: Date, lifeSeconds: number): string {
  const whole = Math.floor(now.getTime() / 1000) * 1000;
  return utcSeconds(new Date(whole + lifeSeconds * 1000));
}

/** True while a link still works: before its end, never at it. */
export function linkIsLive(expiresAt: string, now: Date): boolean {
  return now.getTime() < Date.parse(expiresAt);
}

/** A stored write's key: `<kind>/<day>/<writeId>` of its request. */
export function writeObjectKey(request: { kind: WriteKind; day: string; writeId: string }): ObjectKey {
  return objectKeyOf(request.kind, request.day, request.writeId);
}
