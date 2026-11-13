// The outbox dispatcher's interfaces (T-257; C-124). The dispatcher touches three outside things, each through an
// interface the runtime owns, so it is tested against fakes that answer as the frozen fixtures state (BP 5.2):
//
// - the data-access calls (K-05; the database engineer's C-152): `claimOutbox`, `renewClaim` and `markPart`.
//   Each call comes from K-05 v1.1 (T-071), the newest frozen minor version: `claimOutbox`'s `claim` and the re-claim
//   of a lapsed claim, `renewClaim` and `markPart`'s `row` are v1.1's additions; the rest of each shape is v1's.
//   `markPart`'s `repeatedDelivery` is v1.9's (T-1226; item 48): what a repeated delivery receipt repeats.
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
  /** The K-01 fixed line ids code added (a stop reply carries `stopReply`: limit 8 lets it go to a stopped phone). */
  fixedLines: readonly string[];
  threadReplyTo: string | null;
}

/** K-05 `rowRef`: a row and the version it was read at. */
export interface VersionRef {
  table: string;
  rowId: string;
  version: number;
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
  /**
   * The port the row goes by (K-07 `outboxRow.port`; K-05 v1's claimedRow does not carry it yet: K-05 v1.2). Left out, it
   * is `linq`. Only `sms` is refused (refuse-sms-channel.json).
   */
  port?: string;
  sendClass: string;
  /** The rows the plan rested on, at the versions read: limit 8 checks them unchanged at send. */
  versionsRead: readonly VersionRef[];
  finalParts: FinalParts;
  parts: readonly ClaimedPart[];
  traceId: string;
  claim: OutboxClaim;
  claimedFrom: "checked" | "held" | "sending";
  /**
   * K-05 v1.13 `claimedRow.emailPurpose` (item 64; T-1277): K-04 v1.1 outbox_rows.email_purpose as stored, K-12 v1's
   * purpose of an email row, from which the email port takes the row's K-12 purpose (ADR-016 section 5); null for a row
   * that names none, which a text row always is. Left out by an answer before v1.13. Limit 8 reads one value of it: a
   * `code` row always has its `notAfter` (K-04 v1.1 outbox_rows_code_has_not_after), so one claimed without it never goes.
   */
  emailPurpose?: "confirmation" | "copy" | "emailWay" | "nextWay" | "code" | "notice" | null;
  /**
   * K-05 v1.13 `claimedRow.notAfter` (item 64; T-1277): K-04 v1.1 outbox_rows.not_after as stored. No part of the row is
   * sent at or after it: limit 8 withdraws the row, unsent, at any try at or after it (ADR-016 section 3). A code row's is
   * its code's expires_at. Null for a row with no end, and left out by an answer before v1.13: no end.
   */
  notAfter?: Utc | null;
}

export interface ClaimOutboxRequest {
  claimer: string;
  recipientHandleId?: string;
  now: Utc;
  limit: number;
  /**
   * K-05 v1.14 `claimOutbox.request.sendClass` (item 67; T-1352): the safety-only claim of a danger line's own wake, its
   * one value `safety`, sent only with `recipientHandleId` (default 134). It waits for the recipient's lock rather than
   * skip it (default 129) and walks only the recipient's safety rows, passing one it cannot claim (defaults 130 to 132),
   * so no row of another class is read, taken or counted toward `limit`. Left out: v1.13's claim of every class.
   */
  sendClass?: "safety";
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

/**
 * K-05 v1.1 `markPart.request`, the outcomes the dispatcher writes: `sent` and `delivered`, and `failed` (T-258: with
 * `retry`, the next try's key; with v1.1's `nextTryNotBefore`, the provider's Retry-After). `delivered` may carry the
 * part's key the receipt echoes (K-05 v1.2 item 31).
 */
export type MarkPartRequest =
  | {
      outcome: "sent";
      idempotencyKey: string;
      providerMessageId: string;
      providerOptionIds: readonly string[] | null;
      at: Utc;
    }
  | {
      outcome: "delivered";
      providerMessageId: string;
      at: Utc;
      /**
       * K-05 v1.2 item 31: the part's key the receipt echoes (K-11 `partKey`). The store finds the part by the message id
       * first; when no part holds it, the part under this key is the receipt's if it holds no message id of its own (a
       * 4001 or 4006 gave none: K-11 error-4006.json). Left out: by the message id alone.
       */
      idempotencyKey?: string;
    }
  | {
      outcome: "failed";
      idempotencyKey: string;
      errorCode: string;
      /** True writes the next try's part under a new key (K-07 rule 1), answered as `nextKey`. */
      retry: boolean;
      at: Utc;
      providerMessageId?: string | null;
      /**
       * K-05 v1.1: the provider's Retry-After as a time, kept in the claim's `next_try_not_before` so no try goes before
       * it (K-07 rule 6); only with `retry` true. Left out or null: none given.
       */
      nextTryNotBefore?: Utc | null;
    };

/**
 * K-05 v1.9 `repeatedDelivery` (item 48): the delivery a repeated delivery receipt repeats, read by the store in the
 * mark's own transaction from the row's part tries, with nothing written.
 */
export interface RepeatedDelivery {
  /** True when no other part try of the row was delivered earlier (a tie counts as first: default 85). */
  firstOfRow: boolean;
  /** The part try's delivery time as stored, never the repeat's own time (default 86). */
  deliveredAt: Utc;
}

export interface MarkPartResponse {
  result: "marked";
  outboxRowId: string;
  partNo: 1 | 2;
  tryNo: number;
  attempts: number;
  repeated: boolean;
  /** True only on the mark that records the row's first delivery; a repeat never says it (K-05 default 88). */
  firstDelivery: boolean;
  openQuestionId: string | null;
  nextKey: string | null;
  row?: { state: string; version: number };
  /**
   * K-05 v1.9 item 48: on a `delivered` mark that repeats a recorded delivery, what it repeats; null on every other
   * answer (default 87). Left out by an answer of v1 to v1.8: not known, and never read as a first delivery (default 89).
   */
  repeatedDelivery?: RepeatedDelivery | null;
}

/** K-05 v1.1 `markRow.request`: limit 8's outcome for a claimed row (compare-and-set on the row's version). */
export interface MarkRowRequest {
  outboxRowId: string;
  expectVersion: number;
  outcome: "held" | "droppedStopped" | "stale" | "withdrawn" | "waitingChat";
  /** For held, until when; null otherwise. */
  heldUntil: Utc | null;
  at: Utc;
}

export interface MarkRowResponse {
  result: "marked";
  outboxRowId: string;
  version: number;
  outcome: MarkRowRequest["outcome"];
}

/** K-05 `versionChangedError` (the row's own version moved since it was claimed). */
export interface VersionChangedError {
  error: "versionChanged";
  changed: readonly { table: string; rowId: string; readVersion: number; currentVersion: number }[];
}

/**
 * The K-05 calls the dispatcher makes (the database engineer's C-152 builds them; a fake answers here). Every call is
 * one transaction on the primary, uncached.
 */
export interface OutboxStore {
  /** K-05 v1 item 4, with v1.1's `waitingChat` (item 16): limit 8's outcome. */
  markRow(
    request: MarkRowRequest,
  ): Promise<MarkRowResponse | VersionChangedError | WrongStateError | NotFoundError | TransientError>;
  /** K-05 v1.1 item 13. */
  claimOutbox(request: ClaimOutboxRequest): Promise<ClaimOutboxResponse | TransientError>;
  /** K-05 v1.1 item 14. */
  renewClaim(
    request: RenewClaimRequest,
  ): Promise<
    RenewClaimResponse | ClaimLostError | NotYetError | WrongStateError | NotFoundError | TransientError
  >;
  /**
   * K-05 v1.1 item 15, with v1.9's `repeatedDelivery` (item 48). The store throws, with nothing written, when it cannot
   * read what a repeated delivery repeats (a delivered part try with no delivery time): the error is no answer, and the
   * caller lets it surface.
   */
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

/**
 * K-05 v1.8 `sendState.textsConsent` (`textsConsentRead`: v1.2's item 28 and default 35, with v1.8's item 47): the newest
 * texts consent row for the recipient's contact that covers the row's business, its business's or every business's (a
 * STOP or a START), by `at`, a tie to the lower id (K-29: "the newest row decides"), and from v1.8 who gave it and for
 * which booking. Limit 8 reads it beside the stopped flag (T-1099): after a STOP only the person's own yes from that
 * number turns texts back on (RULES 7.1, 7.5; S13-32, MASTER-FLOW-A lines 7213 to 7215 and 7242).
 */
export interface TextsConsentRead {
  consentId: string;
  /** Null for a STOP or a START, which covers every business (one number: D102; K-29). */
  businessId: string | null;
  /** True when the row withdraws texts: a STOP, or a switch away from this contact (K-29: a withdrawal is a new row). */
  revoked: boolean;
  /** When the yes was given or the stop came. */
  at: Utc;
  /**
   * Whether the yes is the person's own word sent from the contact the row covers: a START, a fresh yes on a new booking
   * or a chat link's ready text, sent from that number (K-29 `consents.channel` text, written by a turn on that same
   * handle: `consents.turn_id`, K-04 `turns.handle_id`; or recorded on return from that number's own text, as K-09's
   * start-recorded.json). False for a yes the business entered ('1 Yes' by the owner's text or on the Today page: A3-30;
   * S13-32 line 7215), a page's, an AI's or an email's, and for every row that withdraws. K-05 v1.8 gives it (item 47;
   * defaults 78 to 82), and the send-state port maps it across unchanged (T-1217). Left out by an answer before v1.8:
   * not known, so no yes lifts a stop.
   */
  fromContact?: boolean;
  /**
   * The booking the yes was given for (K-29 `consents.booking_id`; null when it names none): a fresh yes turns that
   * booking's texts back on (S13-32 line 7242). K-05 v1.8 gives it too (item 47; default 81). Left out by an answer
   * before v1.8: not known.
   */
  bookingId?: string | null;
}

/**
 * What limit 8 reads about a claimed row's recipient just before a send (NQ-RT-2's default: K-05 v1.2's "recipient send
 * state", one primary, uncached read; T-072 builds it, T-220 serves it, joined at D-017; a fake answers until then).
 * Its fields are NQ-RT-2's list (stopped, chat open, zone, text hours, the current versions of the rows the row read)
 * and what CQ-05 and RULES 4.3 need from them: who the recipient is (8am for owner and team) and the test-phone override.
 */
export interface SendState {
  /** K-04 phones: the stopped flag. STOP sets it for every business and START clears it (K-04 0004; K-09 v1). */
  stopped: boolean;
  /**
   * K-04 phones.stop_at, K-05 v1.2 `phone.stopAt`: when the stop came (a stopped phone always has it:
   * phones_stopped_has_time). Left out or null: not known, so no yes lifts the stop.
   */
  stopAt?: Utc | null;
  /**
   * K-05 v1.2 `textsConsent`: the newest texts row covering the contact for the row's business, or null when there is
   * none (T-1099). Left out by a reader that does not give it: the stopped flag alone decides, as before.
   */
  textsConsent?: TextsConsentRead | null;
  /** K-04 phones: whether the mobile has an open chat (it has texted Rosie). */
  chatOpen: boolean;
  /** Who the recipient is: a customer's text hours start at 9am, the owner's and team's at 8am (RULES 4.3). */
  audience: "customer" | "owner" | "team";
  /** The zone of the visit the row is about, when it is about one (CQ-05: the visit's zone first). */
  visitZone: string | null;
  /** The business's own zone (K-04 businesses.time_zone), the fallback. */
  businessZone: string;
  /** K-04 businesses text hours (H04), "HH:MM" each. */
  textHours: { start: string; end: string };
  /** The staging test phone's text-hours override (BP 9.4): honoured on staging only, by the caller's environment. */
  textHoursOverride: boolean;
  /** Each row of the row's `versionsRead` as it stands now; a row missing here counts as changed. */
  currentVersions: readonly VersionRef[];
  /** Whether the row's booking or question has closed since (a stale row then is withdrawn, not composed again). */
  closed: { booking: boolean; question: boolean };
}

/** Reads the send state of a claimed row's recipient. A transient answer sends nothing (limit 8 fails closed). */
export interface SendStateReader {
  sendStateFor(row: ClaimedRow): Promise<SendState | TransientError>;
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
  /**
   * True on the row's first delivery receipt: the question's clock arms then (arch 02 line 127). Also true on a repeat
   * of that receipt (K-05 v1.9 item 48), which is handed on as the first was.
   */
  firstDelivery: boolean;
  openQuestionId: string | null;
  /** The receipt's time; for a repeat of the row's first delivery, that delivery's stored time, never the repeat's. */
  deliveredAt: Utc;
}

/**
 * Clock arming (C-055), a stub here: called once per part newly marked delivered, and again for each repeated receipt
 * of the row's first delivery (K-05 v1.9 item 48), since a crash between markPart's commit and the arming would
 * otherwise lose the arming for good. The arming is safe to repeat (K-05 armClock answers an armed row `repeated` with
 * its first arming). Never called for any other repeated receipt.
 */
export interface ClockArming {
  partDelivered(delivered: PartDelivered): Promise<void>;
}
