// The outbox dispatcher's interfaces (T-257; C-124). The dispatcher touches three outside things, each through an
// interface the runtime owns, so it is tested against fakes that answer as the frozen fixtures state (BP 5.2):
//
// - the data-access calls (K-05; the database engineer's C-152): `claimOutbox`, `renewClaim` and `markPart`.
//   Each call comes from K-05 v1.1 (T-071), the newest frozen minor version: `claimOutbox`'s `claim` and the re-claim
//   of a lapsed claim, `renewClaim` and `markPart`'s `row` are v1.1's additions; the rest of each shape is v1's.
// - the Linq port (K-11 v1; the integrations engineer's C-206 and C-211): `sendPart`.
// - the recipient's chat (to, chat id, service) and clock arming (C-055), which have no frozen call yet (NQ-RT-2:
//   K-05 v1.2's "recipient send state"), so each is a small interface of its own.
//
// The shapes are written by hand (the generated types are git-ignored, ADR-005, and the Worker must not depend on
// them). A K-05 call answers with its response or one of its errors; here an error is the object with an `error` key.

/** An instant in UTC, RFC 3339 (CQ-09). */
export type Utc = string;

/** K-03 v1's `send` as a claimed row carries it (message-plan `send`): what one part goes as. */
export interface PlannedSend {
  kind: "words" | "poll" | "linkCard" | "tapback";
  text: string | null;
  calendarFile: "none" | "new" | "move" | "cancel";
  options: readonly string[];
  link: string | null;
}

/** K-03 v1's `finalParts`, the part the dispatcher reads (the words, never logged). */
export interface FinalParts {
  row: string;
  channel: string;
  sends: readonly PlannedSend[];
  threadReplyTo: string | null;
}

/** K-05 v1 `claimedPart`. */
export interface ClaimedPart {
  partNo: 1 | 2;
  tryNo: number;
  idempotencyKey: string;
  attempts: number;
  sent: boolean;
}

/** K-07 v1 `outboxClaim` (K-05 v1.1's `claim`). */
export interface OutboxClaim {
  claimer: string;
  claimedAt: Utc;
  lapsesAt: Utc;
  claimNo: number;
  firstTryAt: Utc | null;
  nextTryNotBefore: Utc | null;
}

/** K-05 v1.1 `claimedRow` (v1's fields, and v1.1's `claim` and `claimedFrom`, which a v1.1 call always writes). */
export interface ClaimedRow {
  outboxRowId: string;
  version: number;
  commitSeq: number;
  recipientHandleId: string;
  recipientPersonId: string | null;
  businessId: string | null;
  bookingId: string | null;
  openQuestionId: string | null;
  channel: string;
  sendClass: string;
  finalParts: FinalParts;
  parts: readonly ClaimedPart[];
  traceId: string;
  claim: OutboxClaim;
  claimedFrom: "checked" | "held" | "sending";
}

export interface ClaimOutboxRequest {
  claimer: string;
  recipientHandleId?: string;
  now: Utc;
  limit: number;
}

export interface ClaimOutboxResponse {
  result: "claimed";
  claimed: readonly ClaimedRow[];
  passedHeld: readonly { outboxRowId: string; heldUntil: Utc }[];
}

/** K-05 `transientError`: nothing was written; the same request may be sent again. */
export interface TransientError {
  error: "transient";
  sqlstate: string;
}

export interface NotFoundError {
  error: "notFound";
  table: string;
  rowId: string;
}

/** K-05 v1.1 `wrongStateError`. */
export interface WrongStateError {
  error: "wrongState";
  table: "outbox_rows" | "outbox_parts" | "effects";
  rowId: string;
  state: string;
}

/** K-05 v1.1 `claimLostError`: the caller no longer holds the claim and sends nothing. */
export interface ClaimLostError {
  error: "claimLost";
  table: "outbox_rows" | "effects";
  rowId: string;
  claimer: string | null;
  claimNo: number | null;
  state: string;
}

export interface NotYetError {
  error: "notYet";
  outboxRowId: string;
  notBefore: Utc;
}

export interface RenewClaimRequest {
  outboxRowId: string;
  claimer: string;
  claimNo: number;
  idempotencyKey: string;
  at: Utc;
}

export interface RenewClaimResponse {
  result: "renewed";
  outboxRowId: string;
  claim: OutboxClaim;
}

/** K-05 v1.1 `markPart.request`, the outcomes the dispatcher writes: `sent` and `delivered`, and `failed`. */
export type MarkPartRequest =
  | {
      outcome: "sent";
      idempotencyKey: string;
      providerMessageId: string;
      providerOptionIds: readonly string[] | null;
      at: Utc;
    }
  | { outcome: "delivered"; providerMessageId: string; at: Utc }
  | {
      outcome: "failed";
      idempotencyKey: string;
      errorCode: string;
      retry: boolean;
      at: Utc;
      providerMessageId?: string | null;
    };

export interface MarkPartResponse {
  result: "marked";
  outboxRowId: string;
  partNo: 1 | 2;
  tryNo: number;
  attempts: number;
  repeated: boolean;
  firstDelivery: boolean;
  openQuestionId: string | null;
  nextKey: string | null;
  row?: { state: string; version: number };
}

/**
 * The K-05 calls the dispatcher makes (the database engineer's C-152 builds them; a fake answers here). Every call is
 * one transaction on the primary, uncached.
 */
export interface OutboxStore {
  /** K-05 v1.1 item 13. */
  claimOutbox(request: ClaimOutboxRequest): Promise<ClaimOutboxResponse | TransientError>;
  /** K-05 v1.1 item 14. */
  renewClaim(
    request: RenewClaimRequest,
  ): Promise<
    RenewClaimResponse | ClaimLostError | NotYetError | WrongStateError | NotFoundError | TransientError
  >;
  /** K-05 v1.1 item 15. */
  markPart(
    request: MarkPartRequest,
  ): Promise<MarkPartResponse | NotFoundError | WrongStateError | TransientError>;
}

/** K-11 v1 `sendPart.request`, the kinds the dispatcher sends from a row (words, poll, link card). */
export interface LinqSendRequest {
  idempotencyKey: string;
  to: string;
  chatId: string;
  service: LinqService;
  kind: "words" | "poll" | "linkCard";
  text: string | null;
  calendarFile: LinqCalendarFile | null;
  options: readonly string[];
  link: string | null;
  photo: null;
  tapback: null;
  threadedReplyTo: { messageId: string } | null;
  typing: null;
  overrideOptout: boolean;
}

export type LinqService = "imessage" | "rcs" | "sms";

export interface LinqCalendarFile {
  action: "new" | "move" | "cancel";
  fileName: string;
  ics: string;
}

/** K-11 v1 `sendPart.response`. */
export interface LinqAccepted {
  result: "accepted";
  providerMessageId: string | null;
  providerOptionIds: readonly string[] | null;
  chatId: string;
  service: LinqService | null;
  acceptedAt: Utc;
}

/** K-11 v1 `sendPart.errors`. */
export interface LinqFailed {
  result: "failed";
  kind: "optedOut" | "mayStillDeliver" | "rateLimited" | "refused" | "transient";
  httpStatus: number | null;
  code: string | null;
  reason: string;
  retryAfterSeconds: number | null;
  providerMessageId: string | null;
}

/** The Linq port as the dispatcher uses it (K-11 v1; the adapter is C-206, the double C-211). */
export interface LinqPort {
  sendPart(request: LinqSendRequest): Promise<LinqAccepted | LinqFailed>;
}

/** Where a recipient's chat is: the number (never logged), Linq's chat id and the service it reports. */
export interface ChatTarget {
  to: string;
  chatId: string;
  service: LinqService;
}

/** Reads a recipient's chat (NQ-RT-2: K-05 v1.2's recipient send state; a fake until then). Null: no chat known. */
export interface RecipientDirectory {
  chatFor(recipientHandleId: string): Promise<ChatTarget | null>;
}

/** Builds a calendar file from a booking, by code (arch 07 line 383; K-03 `calendarFile`). Null: none can be built. */
export interface CalendarFileBuilder {
  build(row: ClaimedRow, action: "new" | "move" | "cancel"): Promise<LinqCalendarFile | null>;
}

/** What 'handed to clock arming' (C-055) is told for one delivered part. */
export interface PartDelivered {
  outboxRowId: string;
  partNo: 1 | 2;
  tryNo: number;
  /** True on the row's first delivery receipt: the question's clock arms then (arch 02 line 127). */
  firstDelivery: boolean;
  openQuestionId: string | null;
  deliveredAt: Utc;
}

/** Clock arming (C-055), a stub here: called once per delivered part, never for a repeated receipt. */
export interface ClockArming {
  partDelivered(delivered: PartDelivered): Promise<void>;
}
