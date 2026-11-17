// The Linq send adapter's types (T-414; C-206; K-11 v1 sendPart). They mirror the sendPart definitions of
// contracts/port-linq/port-linq.v1.schema.json by hand, field for field as the Linq double's types do
// (adapters/src/linq/double/types.ts), because the generated contract types are git-ignored (ADR-005) and production
// code takes nothing from the double. This folder's tests check every outcome against the schema itself.

export type LinqService = "imessage" | "rcs" | "sms";
export type SendKind = "words" | "poll" | "linkCard" | "tapback" | "photo" | "typing";

export interface CalendarFile {
  action: "new" | "move" | "cancel";
  fileName: string;
  ics: string;
}

export interface PhotoRef {
  fileId: string;
  mediaType: string;
}

export interface TapbackRef {
  reaction: "like";
  onMessageId: string;
  onPoll: false;
}

/** K-11 `sendPart.request`: one part into a chat that already exists. */
export interface SendPartRequest {
  idempotencyKey: string | null;
  to: string;
  chatId: string;
  service: LinqService;
  kind: SendKind;
  text: string | null;
  calendarFile: CalendarFile | null;
  options: string[];
  link: string | null;
  photo: PhotoRef | null;
  tapback: TapbackRef | null;
  threadedReplyTo: { messageId: string } | null;
  typing: "start" | "stop" | null;
  overrideOptout: boolean;
}

/** K-11 `sendPart.response`: Linq took the part (accepted is not delivered). */
export interface SendPartAccepted {
  result: "accepted";
  providerMessageId: string | null;
  providerOptionIds: string[] | null;
  chatId: string;
  service: LinqService | null;
  acceptedAt: string;
}

export type SendFailureKind = "optedOut" | "mayStillDeliver" | "rateLimited" | "refused" | "transient";

/** K-11 `sendPart.errors`. */
export interface SendPartFailed {
  result: "failed";
  kind: SendFailureKind;
  httpStatus: number | null;
  code: string | null;
  reason: string;
  retryAfterSeconds: number | null;
  providerMessageId: string | null;
}

export type SendPartOutcome = SendPartAccepted | SendPartFailed;

/**
 * A file a part carries, which goes up to Linq before the message that names it (K-11 README spike row 10: "Files go up
 * first: POST /attachments gives an upload URL, then PUT"; README default 6). A calendar file's bytes are its .ics text
 * in UTF-8, under the media type the recorded upload names (vendor-samples/attachment-upload-request.json); a photo is
 * K-13's file id with its image type, whose bytes the step that puts it up reads (K-11 `photo`: "an opaque id the
 * adapter reads the bytes by").
 */
export type LinqFile =
  | {
      readonly kind: "calendarFile";
      readonly fileName: string;
      readonly mediaType: "text/calendar";
      readonly bytes: Uint8Array;
    }
  | { readonly kind: "photo"; readonly fileId: string; readonly mediaType: string };

/** The file is up at Linq: the id the message's media part names (vendor-samples/send-message-request-calendar-file.json). */
export interface LinqFileAttached {
  readonly result: "attached";
  readonly attachmentId: string;
}

/** What putting a file up answers: attached, or the part's K-11 failure (refused, transient, a rate limit...). */
export type LinqAttachOutcome = LinqFileAttached | SendPartFailed;

/**
 * The step that puts a file up at Linq and answers its attachment id. The caller gives it: Linq's answer to
 * POST /attachments (where its upload URL and attachment id sit, and what the PUT needs) is not recorded in K-11 v1 or
 * its vendor samples, and this adapter invents no Linq field. Without it, a part that carries a file is refused before
 * any request, and the dispatcher sends it again plain, the words without their file (arch 07 line 367).
 */
export type AttachFile = (file: LinqFile) => Promise<LinqAttachOutcome>;
