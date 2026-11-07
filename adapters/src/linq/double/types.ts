// The Linq double's types (T-411; C-211; K-11 v1). They mirror the port's request and answer shapes in
// contracts/port-linq/port-linq.v1.schema.json by hand, because the generated contract types are git-ignored (ADR-005)
// and code that ships beside them must not depend on them (as runtime/src/trace/types.ts does). The contract test
// (T-090) and this folder's tests check the double's answers against the schema itself.

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

/** sendPart.request: one part into an existing chat. */
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

export interface SendPartAccepted {
  result: "accepted";
  providerMessageId: string | null;
  providerOptionIds: string[] | null;
  chatId: string;
  service: LinqService | null;
  acceptedAt: string;
}

export type SendFailureKind = "optedOut" | "mayStillDeliver" | "rateLimited" | "refused" | "transient";

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

export interface ContactAddRequest {
  phone: string;
}

export interface ContactAddAdded {
  result: "added";
  phone: string;
  alreadyContact: boolean;
  providerContactId: string | null;
}

export interface ContactAddFailed {
  result: "failed";
  phone: string;
  retryable: boolean;
  code: string | null;
  reason: string;
}

export type ContactAddOutcome = ContactAddAdded | ContactAddFailed;

export interface CapabilityCheckChecked {
  result: "checked";
  phone: string;
  imessage: boolean;
  service: LinqService | null;
  checkedAt: string;
  cacheSeconds: 600;
}

export interface CapabilityCheckFailed {
  result: "failed";
  phone: string;
  code: string | null;
  reason: string;
}

export type CapabilityCheckOutcome = CapabilityCheckChecked | CapabilityCheckFailed;

/**
 * What a test chooses for the next send: any failure the contract defines. The double fills the contract's status,
 * code and reason, so the outcome always passes sendPart.errors.
 */
export type ScriptedSendFailure =
  | { kind: "optedOut" }
  | { kind: "mayStillDeliver"; code: "4001" | "4006" }
  | { kind: "rateLimited"; retryAfterSeconds?: number | null }
  | { kind: "refused"; httpStatus?: number; code?: string | null }
  | { kind: "transient"; httpStatus?: number | null };

/** What a test chooses for a contact add. */
export type ScriptedContactAdd =
  | { result: "added"; providerContactId?: string | null }
  | { result: "failed"; retryable: boolean; code?: string | null; reason?: string };

/** What a test chooses for a capability check. */
export type ScriptedCapability =
  | { result: "checked"; imessage: boolean; service: LinqService | null }
  | { result: "failed"; code?: string | null; reason?: string };

/**
 * A faked event, as data the test can read (a signed webhook for the test-phone page is T-412's). A sent or delivered
 * receipt carries its part's key as `partKey` (K-11 README, 'A late receipt after 4001 or 4006'); every other kind
 * carries null.
 */
export type DoubleEvent =
  | { kind: "sent" | "delivered"; at: string; partKey: string; messageId: string | null; chatId: string }
  | {
      kind: "pollVote";
      at: string;
      partKey: null;
      messageId: string;
      optionId: string;
      voter: string;
      removed: boolean;
    }
  | {
      kind: "failed";
      at: string;
      partKey: string | null;
      messageId: string | null;
      code: string;
      reason: string;
    };
