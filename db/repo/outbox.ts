// Data-access K-05 v1 items 2 to 4: write a row's plan and final parts, list the rows a crash left unplanned, claim
// outbox rows in commit order, and move a row's parts and the row with them (T-196; C-152; K-05 README items 2, 3 and
// 4; K-07 v1's states and allowed moves; arch 01 lines 39 to 41 and 65; arch 02 lines 123 to 127; arch 06 line 313;
// arch 11 line 576). The runtime calls them, never a Tool API path: finalize writes the final parts (C-087, join 10:
// T-561), and the dispatcher claims, marks and receives (C-124, C-125, join 11: T-562).
//
//   writePlan      Locks the row. A row that holds a plan answers alreadyPlanned, checked before its version (after a
//                  crash "only rows without a plan are composed": arch 11 line 576); else the version is compared and the
//                  plan and the final parts (K-03 v1 rowPlan, finalParts) are written together, moving the row planned
//                  (or stale) to checked.
//   unplannedRows  A read: a turn's rows whose plan is null, in commit order (outbox_rows_unplanned_idx), so after a
//                  crash only they are composed. A stale row is listed too (markRow stale cleared its plan: S13-57).
//   claimOutbox    Recipients one at a time, earliest open commit_seq first, each under a transaction-level advisory lock
//                  keyed on the recipient's handle id (pg_try_advisory_xact_lock): a recipient another claim holds is
//                  skipped, SKIP LOCKED's meaning per recipient. Under the lock its open rows are read in commit_seq order
//                  FOR UPDATE and walked: a row held for text hours (held_until after now) is passed and reported in
//                  passedHeld (arch 02 line 125, DD); a waiting_chat row is passed and not reported (K-07: it waits for the
//                  chat, not the dispatcher); a row claimed earlier and not finished (sending), or one with no final parts
//                  (planned, stale), stops the walk; a checked row, or a held row whose held_until has passed, is claimed:
//                  its state moves to sending under compare-and-set and its version rises by one, and each part gets its
//                  row under '<row>/<part>/<try>' (a new part try 1, attempts 1, its K-03 send kind; a part the provider
//                  never accepted keeps its stored key with attempts raised; an accepted part is listed as sent). At most
//                  `limit` rows in all. Finished rows (sent, delivered, dropped_stopped, withdrawn, failed, superseded) are
//                  not open, so they are skipped. Under v1 a claim never lapses (K-05 v1 open gap 1; v1.1's re-claim of a
//                  lapsed claim and its outbox_claims row are not here).
//   markPart       One part's outcome, found by its key (attempt, sent, failed) or by the provider's message id
//                  (delivered: outbox_parts_linq_message_idx). The part moves as K-07's partMove allows, and the row moves
//                  with its parts in the same transaction, as K-07 says (the row follows the latest try of each part):
//                  the last part accepted moves sending to sent; every part's latest try delivered moves sent, or sending
//                  after a 4001 or 4006, to delivered; failed with retry on a part of a sent row moves it back to checked,
//                  so it is claimed again. `sent` records the provider's ids and sent_at; `delivered` records delivered_at
//                  and says firstDelivery when no part of the row was delivered before, so the caller arms the question's
//                  clock (arch 02 line 127); `failed` records failed_at and the error code, and with retry writes the
//                  next try's part row under a new key (arch 01 line 65); `attempt` raises attempts for a retry under the
//                  same key after a timeout. A second receipt, a second sent or a second failure for the same key changes
//                  nothing and says repeated. Every mark that changes a part raises the row's version by one (K-07 "raising
//                  the row's version").
//   markRow        Limit 8's outcome at send (arch 06 line 313), compare-and-set on the row's version: held sets held_until
//                  (the row returns to the open rows, claimed again once it passes), droppedStopped and withdrawn close
//                  it, and stale clears plan and final_parts, so unplannedRows lists it and it is composed again from
//                  today's record (S13-57).
//
// Every move these calls make is one of K-07 v1's (ROW_MOVES and PART_MOVES below, K-07's lists word for word: the
// integration test compares them with outbox-effects.v1.schema.json). A move K-07 does not allow is refused before
// anything is written (delivered back to sending, anything out of dropped_stopped): K-05 v1.1's wrongState, with the
// state the row or part stands in now.
//
// Side (K-05 README "Scope": runtime; T-191's roles): each call is one transaction on the primary, uncached, run as
// rosie_job with no business scope (inRuntimeTransaction clears it), so the dispatcher's sweep sees every business's
// rows. outbox_parts has no row-level security (the dispatcher alone reads and writes it: K-04).
//
// Answers: K-05 v1's responses and errors, and K-05 v1.1's wrongState for a move K-07 does not allow (default 1). A
// serialization failure, a deadlock or a lost connection answers transient: nothing was written, and the same request
// may be sent again. A request a call cannot carry out throws a TypeError, a database refusal no K-05 answer names
// throws DataAccessDatabaseError (its SQLSTATE and names only), and nothing is written either way.
//
// Nothing here logs. What it throws names a call, a field, a table or a state, never a value, a row id or a key (a key
// carries its row id); a refusal never carries PostgresError.detail, which can hold a row's words (CQ-59; the security
// reviewer's note (a) on T-189).
//
// Defaults used (for ops/QUESTIONS.md; each where no source decides):
//   1. A refusal K-05 v1's errors do not name answers K-05 v1.1's wrongState (frozen: "markRow and markPart need a
//      wrong-state error"): markRow on a row that is not sending; markPart on a part not in a state its move starts from
//      (K-07 partMove: sent for a failed part, a receipt for a pending one, an attempt on a part already accepted); and
//      markPart on a part whose row is not in a state that mark may change: attempt and sent only while the row is
//      sending (a part is sent only under a claim), delivered and failed while it is sending, sent, checked (sent, with a
//      part's next try waiting for its claim) or delivered (a late receipt of an earlier try). So a held, stale,
//      withdrawn, failed, waiting or superseded row, and a dropped_stopped one, takes no part mark: nothing moves out of
//      dropped_stopped (its question takes step 9's never-delivered path). A mark whose row move K-07 does not list
//      (such as a checked row to delivered) is refused the same way.
//   2. writePlan on a row with no plan in a state writePlan never moves from (only planned and stale can have none under
//      K-07's moves) throws: writePlan.errors (v1, unchanged in v1.1 and v1.2) has no answer for it.
//   3. writePlan's code checks (K-05 item 2: "that the plan's row is this row is a code check"): the plan's and the
//      final parts' row are the request's row, their channel is the row's, and the plan's copyOf is the row's
//      copy_of_row_id; the final parts carry one or two K-03 sends. A mismatch is thrown and nothing is written.
//   4. A held row whose held_until is null (no K-05 call writes one) counts as due. The sweep (no recipient) walks only
//      recipients whose first open row that is not passed is claimable, earliest open commit_seq first.
//   5. A claimable row whose stored final parts are missing or are not one or two K-03 sends, or one of whose parts'
//      latest try failed with no next try written (no K-07 move under v1 leaves a claimable row so), stops its
//      recipient's walk, as a row with no final parts does: nothing is written for it, and later rows wait (fail
//      closed: nothing is sent twice).
//   6. A row's parts are the ones its final parts name now (part 1 and, with a second send, part 2); a part row past them
//      (left by a stale row composed again with fewer sends) is neither handed out nor counted when the row moves.
//   7. At a re-claim a pending try 1 takes the send kind its final parts give now (the claim copies the kind from the
//      final parts: K-07 partKind), and a later try keeps its own (a retry goes plain, as words).
//   8. markPart failed with retry writes the next try as words with attempts 1 (K-07: "A plain retry of a refused part is
//      words"; outbox-poll-failed-plain), its try the part's highest try + 1. A failure for a part already failed is a
//      repeat: with its next try written, it answers that key; with none and retry true, the next try is written now
//      (K-07 retry rule 2: "a new key only if no delivery receipt comes within 1 minute"; outbox-4006-new-key); with none
//      and retry false, it answers no key.
//   9. A sent row whose accepted part is reported failed without retry stays sent (K-07 lists no such row move); the
//      part is failed. A delivered receipt finds its part by the provider's message id, the latest try if two held one.
//  10. The recipient's advisory lock is pg_try_advisory_xact_lock(hashtextextended('outbox-recipient:' || id, 0)): its
//      own name space, as reservations.ts and clocks.ts key theirs ('resource:', 'person:').
//  11. Commit order is commit_seq, the order K-04's identity column gives at insert (K-05 item 1): two commits to one
//      recipient in flight at once can commit in the other order, and a walk sees only committed rows (the architect's
//      note c on T-189: the walk uses order, not adjacency).
import type * as K05 from "../../contracts/generated/data-access/data-access.v1";
import type * as K05v11 from "../../contracts/generated/data-access/data-access.v1.1";
import { commitSeqOf, instantOf, transientOrScrubbed } from "./clocks";
import type { Sql } from "./scope";
import { assertRequestShape, inRuntimeTransaction, utc } from "./targets";

type Json = Parameters<Sql["json"]>[0];
type Row = Record<string, unknown>;

// ---- K-07 v1's states and allowed moves -----------------------------------------------------------------------------

/** K-07 v1 rowState (K-04 outbox_rows.state, held to these by outbox_rows_state_known). */
export type RowState =
  | "planned"
  | "checked"
  | "sending"
  | "sent"
  | "delivered"
  | "held"
  | "dropped_stopped"
  | "stale"
  | "withdrawn"
  | "failed"
  | "waiting_chat"
  | "superseded";

/** K-07 v1 partState (K-04 outbox_parts.state, held by outbox_parts_state_known). */
export type PartState = "pending" | "sent" | "delivered" | "failed";

/** K-07 v1 partKind: K-03 v1's send kind (K-04 outbox_parts_kind_known). */
export type SendKind = "words" | "poll" | "linkCard" | "tapback";

/** K-07 v1 outboxActor: the K-05 call that makes a move. */
export type OutboxActor =
  "commitTurn" | "writePlan" | "claimOutbox" | "markPart" | "markRow" | "dispatcherGivesUp";

/** One allowed move: from a state (null: the row or part is written), to a state, by a call. */
export interface Move<S extends string> {
  readonly from: S | null;
  readonly to: S;
  readonly by: OutboxActor;
}

/** K-07 v1 rowMove: the only moves of an outbox row (outbox-effects README "Allowed moves"; schema $defs/rowMove). */
export const ROW_MOVES: readonly Move<RowState>[] = [
  { from: null, to: "planned", by: "commitTurn" },
  { from: "planned", to: "checked", by: "writePlan" },
  { from: "stale", to: "checked", by: "writePlan" },
  { from: "checked", to: "sending", by: "claimOutbox" },
  { from: "held", to: "sending", by: "claimOutbox" },
  { from: "sending", to: "sending", by: "claimOutbox" },
  { from: "sending", to: "sent", by: "markPart" },
  { from: "sent", to: "delivered", by: "markPart" },
  { from: "sending", to: "delivered", by: "markPart" },
  { from: "sent", to: "checked", by: "markPart" },
  { from: "sending", to: "held", by: "markRow" },
  { from: "sending", to: "dropped_stopped", by: "markRow" },
  { from: "sending", to: "stale", by: "markRow" },
  { from: "sending", to: "withdrawn", by: "markRow" },
  { from: "sending", to: "failed", by: "dispatcherGivesUp" },
  { from: "sending", to: "waiting_chat", by: "markRow" },
  { from: "waiting_chat", to: "superseded", by: "commitTurn" },
  { from: "waiting_chat", to: "withdrawn", by: "commitTurn" },
];

/** K-07 v1 partMove: the only moves of a part under one key (schema $defs/partMove). */
export const PART_MOVES: readonly Move<PartState>[] = [
  { from: null, to: "pending", by: "claimOutbox" },
  { from: null, to: "pending", by: "markPart" },
  { from: "pending", to: "pending", by: "claimOutbox" },
  { from: "pending", to: "pending", by: "markPart" },
  { from: "pending", to: "sent", by: "markPart" },
  { from: "sent", to: "delivered", by: "markPart" },
  { from: "pending", to: "failed", by: "markPart" },
  { from: "sent", to: "failed", by: "markPart" },
  { from: "failed", to: "delivered", by: "markPart" },
];

function allowed<S extends string>(
  moves: readonly Move<S>[],
  from: S | null,
  to: S,
  by: OutboxActor,
): boolean {
  return moves.some((move) => move.from === from && move.to === to && move.by === by);
}

/** Whether K-07 v1 lets `by` move an outbox row from `from` (null: writing it) to `to`. */
export function rowMoveAllowed(from: RowState | null, to: RowState, by: OutboxActor): boolean {
  return allowed(ROW_MOVES, from, to, by);
}

/** Whether K-07 v1 lets `by` move a part from `from` (null: writing its row) to `to`. */
export function partMoveAllowed(from: PartState | null, to: PartState, by: OutboxActor): boolean {
  return allowed(PART_MOVES, from, to, by);
}

/** The rows a walk reads: every state that is not finished (K-07: finished rows are skipped). */
const OPEN_STATES: readonly RowState[] = ["planned", "checked", "sending", "held", "stale", "waiting_chat"];

/** Row states a delivered or failed mark may change a part of (default 1). */
const PART_OUT_ROW_STATES: ReadonlySet<RowState> = new Set<RowState>([
  "sending",
  "sent",
  "checked",
  "delivered",
]);

// ---- the calls' shapes (K-05 v1, and v1.1's wrongState) -------------------------------------------------------------

export type WritePlanRequest = K05.WritePlanRequest;
export type WritePlanResponse = K05.WritePlanResponse;
export type WritePlanError = K05.WritePlanErrors;
export type WritePlanOutcome = WritePlanResponse | WritePlanError;

export type UnplannedRowsRequest = K05.UnplannedRowsRequest;
export type UnplannedRowsResponse = K05.UnplannedRowsResponse;
export type UnplannedRowsOutcome = UnplannedRowsResponse | K05.TransientError;

export type ClaimOutboxRequest = K05.ClaimOutboxRequest;
export type ClaimOutboxResponse = K05.ClaimOutboxResponse;
export type ClaimedRow = K05.ClaimedRow;
export type ClaimedPart = K05.ClaimedPart;
export type ClaimOutboxOutcome = ClaimOutboxResponse | K05.TransientError;

export type MarkPartRequest = K05.MarkPartRequest;
export type MarkPartResponse = K05.MarkPartResponse;
export type WrongStateError = K05v11.WrongStateError;
export type MarkPartError = K05.NotFoundError | WrongStateError | K05.TransientError;
export type MarkPartOutcome = MarkPartResponse | MarkPartError;

export type MarkRowRequest = K05.MarkRowRequest;
export type MarkRowResponse = K05.MarkRowResponse;
export type MarkRowError = K05.VersionChangedError | WrongStateError | K05.NotFoundError | K05.TransientError;
export type MarkRowOutcome = MarkRowResponse | MarkRowError;

type Channel = K05.Channel;
type SendClass = K05.SendClass;
type PassedHeld = ClaimOutboxResponse["passedHeld"][number];

// ---- request checks: what the database cannot be trusted to refuse ---------------------------------------------------

const WRITE_PLAN = "writePlan";
const UNPLANNED_ROWS = "unplannedRows";
const CLAIM_OUTBOX = "claimOutbox";
const MARK_PART = "markPart";
const MARK_ROW = "markRow";

/** K-05 claimOutbox.limit: at most this many rows in all. */
const MAX_LIMIT = 100;
/** K-04 outbox_parts_key_form as K-05 writes it: '<row>/<part>/<try>'. */
const PART_KEY = /^.+\/[12]\/[1-9][0-9]*$/;
const CHANNELS: ReadonlySet<string> = new Set<Channel>(["imessage", "rcs", "sms", "email"]);
const SEND_KINDS: ReadonlySet<string> = new Set<SendKind>(["words", "poll", "linkCard", "tapback"]);
const CALENDAR_FILES: ReadonlySet<string> = new Set(["none", "new", "move", "cancel"]);

/** A request a call cannot carry out: thrown before anything is written (or inside the transaction, rolling it back). */
function fail(call: string, what: string): never {
  throw new TypeError(`${call}: ${what}`);
}

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An opaque id (formats.v1 id): a non-empty string with no NUL, compared whole and never parsed (CQ-09). */
function idOf(call: string, value: unknown, what: string): string {
  if (typeof value !== "string" || value === "" || value.includes("\u0000")) {
    fail(call, `${what} is not a non-empty id`);
  }
  return value;
}

function nullableIdOf(call: string, value: unknown, what: string): string | null {
  return value === null ? null : idOf(call, value, what);
}

function versionOf(call: string, value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    fail(call, `${what} is not a version (a positive integer)`);
  }
  return value;
}

function partKeyOf(call: string, value: unknown): string {
  if (typeof value !== "string" || !PART_KEY.test(value) || value.includes("\u0000")) {
    fail(call, "idempotencyKey is not a part key '<row>/<part>/<try>'");
  }
  return value;
}

/** Refuses a record that does not have exactly these fields (the schema's required and additionalProperties false). */
function assertFields(call: string, record: Row, fields: readonly string[], what: string): void {
  const keys = Object.keys(record);
  if (keys.length !== fields.length || !fields.every((field) => Object.hasOwn(record, field))) {
    fail(call, `${what} takes exactly ${fields.join(", ")}`);
  }
}

function isSendKind(value: unknown): value is SendKind {
  return typeof value === "string" && SEND_KINDS.has(value);
}

function isChannel(value: unknown): value is Channel {
  return typeof value === "string" && CHANNELS.has(value);
}

/** One K-03 v1 send, checked as the schema gives it; its kind. */
function checkSend(call: string, send: unknown, what: string): SendKind {
  if (!isRecord(send)) {
    fail(call, `${what} is not an object`);
  }
  assertFields(call, send, ["kind", "text", "calendarFile", "options", "link"], what);
  if (!isSendKind(send.kind)) {
    fail(call, `${what}.kind is not one of K-03's send kinds`);
  }
  if (send.text !== null && typeof send.text !== "string") {
    fail(call, `${what}.text is not text or null`);
  }
  if (typeof send.calendarFile !== "string" || !CALENDAR_FILES.has(send.calendarFile)) {
    fail(call, `${what}.calendarFile is not one of K-03's calendar files`);
  }
  if (!Array.isArray(send.options)) {
    fail(call, `${what}.options is not a list`);
  }
  if (send.link !== null && typeof send.link !== "string") {
    fail(call, `${what}.link is not text or null`);
  }
  return send.kind;
}

/** The send kinds of stored final parts, as far as a claim relies on them: one or two K-03 sends; null otherwise. */
function sendKindsOf(finalParts: unknown): SendKind[] | null {
  if (!isRecord(finalParts) || !Array.isArray(finalParts.sends)) {
    return null;
  }
  const sends = finalParts.sends as unknown[];
  if (sends.length < 1 || sends.length > 2) {
    return null;
  }
  const kinds: SendKind[] = [];
  for (const send of sends) {
    if (!isRecord(send) || !isSendKind(send.kind)) {
      return null;
    }
    kinds.push(send.kind);
  }
  return kinds;
}

interface PlanChecked {
  readonly outboxRowId: string;
  readonly expectVersion: number;
  readonly plan: Row;
  readonly finalParts: Row;
  readonly channel: Channel;
  readonly copyOf: string | null;
}

/** writePlan's request: its ids, the K-03 rowPlan and finalParts, both of this row (default 3). */
function checkWritePlan(request: WritePlanRequest): PlanChecked {
  assertRequestShape(request, WRITE_PLAN, ["outboxRowId", "expectVersion", "plan", "finalParts"]);
  const raw = request as unknown as Row;
  const outboxRowId = idOf(WRITE_PLAN, raw.outboxRowId, "outboxRowId");
  const expectVersion = versionOf(WRITE_PLAN, raw.expectVersion, "expectVersion");

  const plan = raw.plan;
  if (!isRecord(plan)) {
    fail(WRITE_PLAN, "plan is not an object");
  }
  assertFields(WRITE_PLAN, plan, ["row", "channel", "copyOf", "plan"], "plan");
  if (plan.row !== outboxRowId) {
    fail(WRITE_PLAN, "plan.row is not the row the plan is written into");
  }
  if (!isChannel(plan.channel)) {
    fail(WRITE_PLAN, "plan.channel is not one of K-03's channels");
  }
  const copyOf = nullableIdOf(WRITE_PLAN, plan.copyOf, "plan.copyOf");
  if (!isRecord(plan.plan)) {
    fail(WRITE_PLAN, "plan.plan is not an object");
  }

  const finalParts = raw.finalParts;
  if (!isRecord(finalParts)) {
    fail(WRITE_PLAN, "finalParts is not an object");
  }
  assertFields(
    WRITE_PLAN,
    finalParts,
    ["row", "channel", "sends", "fixedLines", "slotValues", "threadReplyTo"],
    "finalParts",
  );
  if (finalParts.row !== outboxRowId) {
    fail(WRITE_PLAN, "finalParts.row is not the row the plan is written into");
  }
  if (finalParts.channel !== plan.channel) {
    fail(WRITE_PLAN, "finalParts.channel is not the plan's channel");
  }
  const sends = finalParts.sends;
  if (!Array.isArray(sends) || sends.length < 1 || sends.length > 2) {
    fail(WRITE_PLAN, "finalParts.sends is not one or two sends");
  }
  (sends as unknown[]).forEach((send, index) => {
    checkSend(WRITE_PLAN, send, `finalParts.sends[${String(index)}]`);
  });
  const fixedLines = finalParts.fixedLines;
  if (!Array.isArray(fixedLines) || !(fixedLines as unknown[]).every((line) => typeof line === "string")) {
    fail(WRITE_PLAN, "finalParts.fixedLines is not a list of fixed line ids");
  }
  const slotValues = finalParts.slotValues;
  if (!Array.isArray(slotValues) || !(slotValues as unknown[]).every(isRecord)) {
    fail(WRITE_PLAN, "finalParts.slotValues is not a list of slot values");
  }
  nullableIdOf(WRITE_PLAN, finalParts.threadReplyTo, "finalParts.threadReplyTo");

  return { outboxRowId, expectVersion, plan, finalParts, channel: plan.channel, copyOf };
}

interface ClaimChecked {
  readonly claimer: string;
  readonly recipientHandleId: string | null;
  readonly now: Date;
  readonly limit: number;
}

function checkClaim(request: ClaimOutboxRequest): ClaimChecked {
  assertRequestShape(request, CLAIM_OUTBOX, ["claimer", "recipientHandleId", "now", "limit"]);
  const raw = request as unknown as Row;
  const limit = raw.limit;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    fail(CLAIM_OUTBOX, `limit is not a whole number from 1 to ${String(MAX_LIMIT)}`);
  }
  return {
    claimer: idOf(CLAIM_OUTBOX, raw.claimer, "claimer"),
    recipientHandleId: Object.hasOwn(raw, "recipientHandleId")
      ? idOf(CLAIM_OUTBOX, raw.recipientHandleId, "recipientHandleId")
      : null,
    now: instantOf(CLAIM_OUTBOX, raw.now, "now"),
    limit,
  };
}

type MarkChecked =
  | { readonly outcome: "attempt"; readonly key: string; readonly at: Date }
  | {
      readonly outcome: "sent";
      readonly key: string;
      readonly providerMessageId: string;
      readonly providerOptionIds: string[] | null;
      readonly at: Date;
    }
  | { readonly outcome: "delivered"; readonly providerMessageId: string; readonly at: Date }
  | {
      readonly outcome: "failed";
      readonly key: string;
      readonly errorCode: string;
      readonly retry: boolean;
      readonly at: Date;
    };

function checkMarkPart(request: MarkPartRequest): MarkChecked {
  if (!isRecord(request)) {
    fail(MARK_PART, "the request is not an object");
  }
  const raw = request as Row;
  switch (raw.outcome) {
    case "attempt":
      assertFields(MARK_PART, raw, ["outcome", "idempotencyKey", "at"], "an attempt");
      return {
        outcome: "attempt",
        key: partKeyOf(MARK_PART, raw.idempotencyKey),
        at: instantOf(MARK_PART, raw.at, "at"),
      };
    case "sent": {
      assertFields(
        MARK_PART,
        raw,
        ["outcome", "idempotencyKey", "providerMessageId", "providerOptionIds", "at"],
        "a sent mark",
      );
      const optionIds = raw.providerOptionIds;
      if (optionIds !== null && !Array.isArray(optionIds)) {
        fail(MARK_PART, "providerOptionIds is not a list or null");
      }
      return {
        outcome: "sent",
        key: partKeyOf(MARK_PART, raw.idempotencyKey),
        providerMessageId: idOf(MARK_PART, raw.providerMessageId, "providerMessageId"),
        providerOptionIds:
          optionIds === null
            ? null
            : (optionIds as unknown[]).map((id, index) =>
                idOf(MARK_PART, id, `providerOptionIds[${String(index)}]`),
              ),
        at: instantOf(MARK_PART, raw.at, "at"),
      };
    }
    case "delivered":
      assertFields(MARK_PART, raw, ["outcome", "providerMessageId", "at"], "a delivery receipt");
      return {
        outcome: "delivered",
        providerMessageId: idOf(MARK_PART, raw.providerMessageId, "providerMessageId"),
        at: instantOf(MARK_PART, raw.at, "at"),
      };
    case "failed": {
      assertFields(MARK_PART, raw, ["outcome", "idempotencyKey", "errorCode", "retry", "at"], "a failure");
      const errorCode = raw.errorCode;
      if (typeof errorCode !== "string" || errorCode === "" || errorCode.includes("\u0000")) {
        fail(MARK_PART, "errorCode is not a non-empty code");
      }
      if (typeof raw.retry !== "boolean") {
        fail(MARK_PART, "retry is not true or false");
      }
      return {
        outcome: "failed",
        key: partKeyOf(MARK_PART, raw.idempotencyKey),
        errorCode,
        retry: raw.retry,
        at: instantOf(MARK_PART, raw.at, "at"),
      };
    }
    default:
      return fail(MARK_PART, "outcome is not attempt, sent, delivered or failed");
  }
}

/** markRow's outcomes and the K-07 state each moves the row to. */
const MARKED_STATES = {
  held: "held",
  droppedStopped: "dropped_stopped",
  stale: "stale",
  withdrawn: "withdrawn",
} as const satisfies Record<MarkRowRequest["outcome"], RowState>;

type MarkRowOutcomeName = keyof typeof MARKED_STATES;

interface MarkRowChecked {
  readonly outboxRowId: string;
  readonly expectVersion: number;
  readonly outcome: MarkRowOutcomeName;
  readonly heldUntil: Date | null;
}

function isMarkRowOutcome(value: unknown): value is MarkRowOutcomeName {
  return typeof value === "string" && Object.hasOwn(MARKED_STATES, value);
}

function checkMarkRow(request: MarkRowRequest): MarkRowChecked {
  assertRequestShape(request, MARK_ROW, ["outboxRowId", "expectVersion", "outcome", "heldUntil", "at"]);
  const raw = request as unknown as Row;
  const outcome = raw.outcome;
  if (!isMarkRowOutcome(outcome)) {
    fail(MARK_ROW, "outcome is not held, droppedStopped, stale or withdrawn");
  }
  // The schema's if/then/else: held carries the time it is held until, every other outcome null.
  let heldUntil: Date | null = null;
  if (outcome === "held") {
    heldUntil = instantOf(MARK_ROW, raw.heldUntil, "heldUntil (held needs the time it is held until)");
  } else if (raw.heldUntil !== null) {
    fail(MARK_ROW, "heldUntil is null for any outcome but held");
  }
  instantOf(MARK_ROW, raw.at, "at");
  return {
    outboxRowId: idOf(MARK_ROW, raw.outboxRowId, "outboxRowId"),
    expectVersion: versionOf(MARK_ROW, raw.expectVersion, "expectVersion"),
    outcome,
    heldUntil,
  };
}

// ---- answers ----------------------------------------------------------------------------------------------------------

function wrongState(
  table: WrongStateError["table"],
  rowId: string,
  state: RowState | PartState,
): WrongStateError {
  return { error: "wrongState", table, rowId, state };
}

function versionChanged(rowId: string, readVersion: number, currentVersion: number): K05.VersionChangedError {
  return { error: "versionChanged", changed: [{ table: "outbox_rows", rowId, readVersion, currentVersion }] };
}

// ---- writePlan (K-05 v1 item 2) -------------------------------------------------------------------------------------

async function writePlanIn(tx: Sql, request: PlanChecked): Promise<WritePlanOutcome> {
  const { outboxRowId } = request;
  const [row] = await tx<
    { state: RowState; planned: boolean; version: number; channel: Channel; copy_of_row_id: string | null }[]
  >`
    select state, plan is not null as planned, version, channel, copy_of_row_id
    from outbox_rows where id = ${outboxRowId}
    for update
  `;
  if (row === undefined) {
    return { error: "notFound", table: "outbox_rows", rowId: outboxRowId };
  }
  // A row that holds a plan keeps it, checked before its version: a repeat writes nothing.
  if (row.planned) {
    return { error: "alreadyPlanned", outboxRowId, version: row.version };
  }
  if (!rowMoveAllowed(row.state, "checked", "writePlan")) {
    throw new Error(
      `writePlan: a row with no plan is ${row.state}, a state writePlan never moves (default 2)`,
    );
  }
  if (row.version !== request.expectVersion) {
    return versionChanged(outboxRowId, request.expectVersion, row.version);
  }
  if (row.channel !== request.channel || row.copy_of_row_id !== request.copyOf) {
    fail(WRITE_PLAN, "the plan's channel or copyOf is not the row's (default 3)");
  }
  const [written] = await tx<{ version: number }[]>`
    update outbox_rows
    set plan = ${tx.json(request.plan as Json)}, final_parts = ${tx.json(request.finalParts as Json)},
        state = 'checked', version = version + 1
    where id = ${outboxRowId} and version = ${request.expectVersion} and plan is null
    returning version
  `;
  if (written === undefined) {
    throw new Error("writePlan: the row moved while it was locked");
  }
  return { result: "written", outboxRowId, version: written.version };
}

/**
 * Writes the composer's plan and the final parts after code into one outbox row (K-05 v1 item 2; arch 01 lines 39 to
 * 41): one transaction on the primary, on the runtime side. Pass the client's primary handle, run as rosie_job. Answers
 * written (the row checked, its version raised), alreadyPlanned (the row holds a plan, which stays), versionChanged,
 * notFound or transient. Throws for a request it cannot carry out; nothing is written then either.
 */
export async function writePlan(sql: Sql, request: WritePlanRequest): Promise<WritePlanOutcome> {
  const checked = checkWritePlan(request);
  try {
    return await inRuntimeTransaction(sql, { readOnly: false }, (tx) => writePlanIn(tx, checked));
  } catch (error) {
    return transientOrScrubbed(WRITE_PLAN, error);
  }
}

// ---- unplannedRows (K-05 v1 item 2, after a crash) -------------------------------------------------------------------

/**
 * A turn's outbox rows that have no plan, in commit order (K-05 v1 item 2; arch 11 line 576: after a crash past the
 * commit "only rows without a plan are composed"): a read-only transaction on the primary, on the runtime side.
 */
export async function unplannedRows(sql: Sql, request: UnplannedRowsRequest): Promise<UnplannedRowsOutcome> {
  assertRequestShape(request, UNPLANNED_ROWS, ["turnId"]);
  const turnId = idOf(UNPLANNED_ROWS, (request as unknown as Row).turnId, "turnId");
  try {
    return await inRuntimeTransaction(sql, { readOnly: true }, async (tx) => {
      const rows = await tx<
        {
          id: string;
          version: number;
          commit_seq: string;
          recipient_handle_id: string;
          channel: Channel;
          copy_of_row_id: string | null;
        }[]
      >`
        select id, version, commit_seq, recipient_handle_id, channel, copy_of_row_id
        from outbox_rows where turn_id = ${turnId} and plan is null
        order by commit_seq
      `;
      return {
        result: "rows",
        rows: rows.map((row) => ({
          outboxRowId: row.id,
          version: row.version,
          commitSeq: commitSeqOf(row.commit_seq),
          recipientHandleId: row.recipient_handle_id,
          channel: row.channel,
          copyOfRowId: row.copy_of_row_id,
        })),
      } satisfies UnplannedRowsResponse;
    });
  } catch (error) {
    return transientOrScrubbed(UNPLANNED_ROWS, error);
  }
}

// ---- claimOutbox (K-05 v1 item 3) -------------------------------------------------------------------------------------

interface OpenRow {
  id: string;
  commit_seq: string;
  state: RowState;
  held_until: Date | null;
  version: number;
  recipient_person_id: string | null;
  business_id: string | null;
  booking_id: string | null;
  open_question_id: string | null;
  channel: Channel;
  send_class: SendClass;
  versions_read: unknown;
  final_parts: unknown;
  trace_id: string;
}

interface PartRow {
  part_no: number;
  try_no: number;
  idempotency_key: string;
  attempts: number;
  kind: SendKind;
  state: PartState;
  linq_message_id: string | null;
  delivered_at: Date | null;
}

const PART_COLUMNS = "part_no, try_no, idempotency_key, attempts, kind, state, linq_message_id, delivered_at";

/** A held row whose held_until is still ahead (default 4: none counts as due). */
function heldAhead(row: { state: RowState; held_until: Date | null }, now: Date): boolean {
  return row.state === "held" && row.held_until !== null && row.held_until.getTime() > now.getTime();
}

/**
 * The sweep's recipients (no recipient named): those whose first open row that is not passed (a held row not yet due, a
 * waiting row) is claimable, so a recipient whose walk would stop at once is not locked; earliest open commit_seq first
 * (default 4). A read without locks: each walk reads its rows again under its recipient's lock.
 */
async function claimableRecipients(tx: Sql, now: Date): Promise<string[]> {
  const rows = await tx<{ recipient_handle_id: string }[]>`
    select f.recipient_handle_id
    from (
      select distinct on (recipient_handle_id) recipient_handle_id, state
      from outbox_rows
      where state in ('planned', 'checked', 'sending', 'stale')
         or (state = 'held' and (held_until is null or held_until <= ${now}))
      order by recipient_handle_id, commit_seq
    ) as f
    join (
      select recipient_handle_id, min(commit_seq) as first_open
      from outbox_rows
      where state in ${tx(OPEN_STATES)}
      group by recipient_handle_id
    ) as o on o.recipient_handle_id = f.recipient_handle_id
    where f.state in ('checked', 'held')
    order by o.first_open
  `;
  return rows.map((row) => row.recipient_handle_id);
}

/** The recipient's transaction-level lock, or false when another claim holds it (default 10). */
async function lockRecipient(tx: Sql, recipientHandleId: string): Promise<boolean> {
  const [lock] = await tx<{ taken: boolean }[]>`
    select pg_try_advisory_xact_lock(hashtextextended(${`outbox-recipient:${recipientHandleId}`}, 0)) as taken
  `;
  return lock?.taken === true;
}

/** The latest try of each part number, by part number. */
function latestTries(parts: readonly PartRow[]): Map<number, PartRow> {
  const latest = new Map<number, PartRow>();
  for (const part of parts) {
    const known = latest.get(part.part_no);
    if (known === undefined || part.try_no > known.try_no) {
      latest.set(part.part_no, part);
    }
  }
  return latest;
}

function keyOf(rowId: string, partNo: number, tryNo: number): string {
  return `${rowId}/${String(partNo)}/${String(tryNo)}`;
}

function partNoOf(index: number): 1 | 2 {
  if (index === 0) {
    return 1;
  }
  if (index === 1) {
    return 2;
  }
  throw new Error("an outbox row has at most two parts");
}

type PartPlan =
  | { readonly write: "insert"; readonly partNo: 1 | 2; readonly kind: SendKind }
  | { readonly write: "again"; readonly partNo: 1 | 2; readonly part: PartRow; readonly kind: SendKind }
  | { readonly write: "none"; readonly partNo: 1 | 2; readonly part: PartRow };

/**
 * What the claim writes for each of the row's parts (K-05 item 3; arch 11 line 576), decided before anything is
 * written: a new part try 1; a part never accepted, again under its stored key; an accepted part, listed as sent. Null
 * when a part's latest try failed with no next try: the row is not sendable as it stands (default 5).
 */
function planParts(parts: readonly PartRow[], kinds: readonly SendKind[]): PartPlan[] | null {
  const latest = latestTries(parts);
  const plans: PartPlan[] = [];
  for (const [index, kind] of kinds.entries()) {
    const partNo = partNoOf(index);
    const part = latest.get(partNo);
    if (part === undefined) {
      plans.push({ write: "insert", partNo, kind });
    } else if (part.state === "pending") {
      plans.push({ write: "again", partNo, part, kind });
    } else if (part.state === "sent" || part.state === "delivered") {
      plans.push({ write: "none", partNo, part });
    } else {
      return null;
    }
  }
  return plans;
}

/** Writes the planned parts (K-07: (new) to pending, pending to pending, by claimOutbox) and lists them. */
async function writeParts(tx: Sql, rowId: string, plans: readonly PartPlan[]): Promise<ClaimedPart[]> {
  const claimed: ClaimedPart[] = [];
  for (const plan of plans) {
    if (plan.write === "insert") {
      if (!partMoveAllowed(null, "pending", "claimOutbox")) {
        throw new Error("claimOutbox: K-07 lets no claim write a part");
      }
      const idempotencyKey = keyOf(rowId, plan.partNo, 1);
      await tx`
        insert into outbox_parts (outbox_row_id, part_no, try_no, idempotency_key, attempts, kind, state)
        values (${rowId}, ${plan.partNo}, 1, ${idempotencyKey}, 1, ${plan.kind}, 'pending')
      `;
      claimed.push({ partNo: plan.partNo, tryNo: 1, idempotencyKey, attempts: 1, sent: false });
    } else if (plan.write === "again") {
      if (!partMoveAllowed("pending", "pending", "claimOutbox")) {
        throw new Error("claimOutbox: K-07 lets no claim hand a pending part out again");
      }
      // Default 7: try 1 takes the kind the final parts give now; a later try (a plain retry) keeps its own.
      const kind = plan.part.try_no === 1 ? plan.kind : plan.part.kind;
      const [again] = await tx<{ attempts: number }[]>`
        update outbox_parts set attempts = attempts + 1, kind = ${kind}, version = version + 1
        where idempotency_key = ${plan.part.idempotency_key} and state = 'pending'
        returning attempts
      `;
      if (again === undefined) {
        throw new Error("claimOutbox: a part moved while it was locked");
      }
      claimed.push({
        partNo: plan.partNo,
        tryNo: plan.part.try_no,
        idempotencyKey: plan.part.idempotency_key,
        attempts: again.attempts,
        sent: false,
      });
    } else {
      claimed.push({
        partNo: plan.partNo,
        tryNo: plan.part.try_no,
        idempotencyKey: plan.part.idempotency_key,
        attempts: plan.part.attempts,
        sent: true,
      });
    }
  }
  return claimed;
}

function partsOf(parts: readonly ClaimedPart[]): ClaimedRow["parts"] {
  const [first, second] = parts;
  if (first === undefined || parts.length > 2) {
    throw new Error("claimOutbox: a claimed row has one or two parts");
  }
  return second === undefined ? [first] : [first, second];
}

/**
 * Claims one row under the recipient's lock: its parts, then its move to sending under compare-and-set (K-07: checked or
 * held to sending, by claimOutbox). Null when the row is not sendable as it stands (default 5): nothing is written.
 */
async function claimRow(tx: Sql, row: OpenRow, recipientHandleId: string): Promise<ClaimedRow | null> {
  if (!rowMoveAllowed(row.state, "sending", "claimOutbox")) {
    throw new Error(`claimOutbox: K-07 lets no claim move a ${row.state} row`);
  }
  const kinds = sendKindsOf(row.final_parts);
  if (kinds === null) {
    return null;
  }
  const parts = await tx<PartRow[]>`
    select ${tx.unsafe(PART_COLUMNS)} from outbox_parts
    where outbox_row_id = ${row.id}
    order by part_no, try_no
    for update
  `;
  const plans = planParts(parts, kinds);
  if (plans === null) {
    return null;
  }
  const [moved] = await tx<{ version: number }[]>`
    update outbox_rows set state = 'sending', version = version + 1
    where id = ${row.id} and state = ${row.state} and version = ${row.version}
    returning version
  `;
  if (moved === undefined) {
    throw new Error("claimOutbox: a row moved while it was locked");
  }
  const claimedParts = await writeParts(tx, row.id, plans);
  return {
    outboxRowId: row.id,
    version: moved.version,
    commitSeq: commitSeqOf(row.commit_seq),
    recipientHandleId,
    recipientPersonId: row.recipient_person_id,
    businessId: row.business_id,
    bookingId: row.booking_id,
    openQuestionId: row.open_question_id,
    channel: row.channel,
    sendClass: row.send_class,
    versionsRead: row.versions_read as K05.RowRef[],
    finalParts: row.final_parts as K05.FinalParts,
    parts: partsOf(claimedParts),
    traceId: row.trace_id,
  };
}

/**
 * One recipient's walk under its lock (K-05 item 3; K-07 "How K-05 v1's calls use them"), adding to `claimed` and
 * `passedHeld` until the walk stops or the limit is reached.
 */
async function walkRecipient(
  tx: Sql,
  recipientHandleId: string,
  request: ClaimChecked,
  claimed: ClaimedRow[],
  passedHeld: PassedHeld[],
): Promise<void> {
  const rows = await tx<OpenRow[]>`
    select id, commit_seq, state, held_until, version, recipient_person_id, business_id, booking_id,
           open_question_id, channel, send_class, versions_read, final_parts, trace_id
    from outbox_rows
    where recipient_handle_id = ${recipientHandleId} and state in ${tx(OPEN_STATES)}
    order by commit_seq
    for update
  `;
  for (const row of rows) {
    if (claimed.length >= request.limit) {
      return;
    }
    if (row.state === "waiting_chat") {
      continue;
    }
    if (heldAhead(row, request.now)) {
      if (row.held_until !== null) {
        passedHeld.push({ outboxRowId: row.id, heldUntil: utc(row.held_until) });
      }
      continue;
    }
    if (row.state !== "checked" && row.state !== "held") {
      // sending: claimed earlier and not finished; planned or stale: no final parts yet. Commit order: stop.
      return;
    }
    const one = await claimRow(tx, row, recipientHandleId);
    if (one === null) {
      return;
    }
    claimed.push(one);
  }
}

async function claimIn(tx: Sql, request: ClaimChecked): Promise<ClaimOutboxResponse> {
  const recipients =
    request.recipientHandleId === null
      ? await claimableRecipients(tx, request.now)
      : [request.recipientHandleId];
  const claimed: ClaimedRow[] = [];
  const passedHeld: PassedHeld[] = [];
  for (const recipient of recipients) {
    if (claimed.length >= request.limit) {
      break;
    }
    if (await lockRecipient(tx, recipient)) {
      await walkRecipient(tx, recipient, request, claimed, passedHeld);
    }
  }
  return { result: "claimed", claimed, passedHeld };
}

/**
 * Claims each recipient's next sendable rows in commit order for one dispatcher, so no row is sent twice (K-05 v1 item
 * 3; arch 02 line 125): one transaction on the primary, on the runtime side. Pass the client's primary handle, run as
 * rosie_job. With `recipientHandleId`, that recipient only (the actor's own after a commit); without, every recipient
 * with sendable rows (the dispatcher's sweep). Answers claimed (each row sending at its new version, with its final
 * parts and its parts' keys, per recipient in commit order, and the held rows later rows passed) or transient.
 */
export async function claimOutbox(sql: Sql, request: ClaimOutboxRequest): Promise<ClaimOutboxOutcome> {
  const checked = checkClaim(request);
  try {
    return await inRuntimeTransaction(sql, { readOnly: false }, (tx) => claimIn(tx, checked));
  } catch (error) {
    return transientOrScrubbed(CLAIM_OUTBOX, error);
  }
}

// ---- markPart (K-05 v1 item 4) ------------------------------------------------------------------------------------------

interface MarkedRow {
  id: string;
  state: RowState;
  version: number;
  final_parts: unknown;
  open_question_id: string | null;
}

/** A part's change, worked out before anything is written. */
interface PartChange {
  /** The part's new state, or null when it keeps its own (a next try written for a part already failed). */
  readonly to: PartState | null;
  /** The next try written with it (failed with retry), or null. */
  readonly nextTry: number | null;
}

/**
 * The state the row moves to with its parts (K-07: "The row follows the latest try of each part"): every part's latest
 * try delivered, delivered; every one accepted, sent; a sent row with a part's next try waiting, checked; else where it
 * is. `parts` are the row's part rows after the change; the row's parts are the ones its final parts name (default 6).
 */
function rowStateAfter(state: RowState, parts: readonly PartRow[], partCount: number): RowState {
  const latest = latestTries(parts);
  const states: PartState[] = [];
  for (let partNo = 1; partNo <= partCount; partNo += 1) {
    const part = latest.get(partNo);
    if (part === undefined) {
      return state;
    }
    states.push(part.state);
  }
  if (states.every((one) => one === "delivered")) {
    return "delivered";
  }
  if (states.every((one) => one === "sent" || one === "delivered")) {
    return "sent";
  }
  if (state === "sent" && states.includes("pending")) {
    return "checked";
  }
  return state;
}

/** The part a mark names, found without a lock: its row's id and its key; null when no part holds the key or id. */
async function findPart(tx: Sql, mark: MarkChecked): Promise<{ rowId: string; key: string } | null> {
  const [found] =
    mark.outcome === "delivered"
      ? await tx<{ outbox_row_id: string; idempotency_key: string }[]>`
          select outbox_row_id, idempotency_key from outbox_parts
          where linq_message_id = ${mark.providerMessageId}
          order by try_no desc, part_no
          limit 1
        `
      : await tx<{ outbox_row_id: string; idempotency_key: string }[]>`
          select outbox_row_id, idempotency_key from outbox_parts where idempotency_key = ${mark.key}
        `;
  return found === undefined ? null : { rowId: found.outbox_row_id, key: found.idempotency_key };
}

/** The repeat's answer, or the change a non-repeat mark makes; or wrongState (default 1). Nothing is written here. */
function decideMark(
  mark: MarkChecked,
  row: MarkedRow,
  part: PartRow,
  parts: readonly PartRow[],
): { repeat: { nextKey: string | null } } | { change: PartChange } | { refused: WrongStateError } {
  const refusePart = { refused: wrongState("outbox_parts", part.idempotency_key, part.state) };
  const refuseRow = { refused: wrongState("outbox_rows", row.id, row.state) };
  switch (mark.outcome) {
    case "attempt":
      if (!partMoveAllowed(part.state, "pending", "markPart")) {
        return refusePart;
      }
      return row.state === "sending" ? { change: { to: "pending", nextTry: null } } : refuseRow;
    case "sent":
      if (part.state === "sent" || part.state === "delivered") {
        return { repeat: { nextKey: null } };
      }
      if (!partMoveAllowed(part.state, "sent", "markPart")) {
        return refusePart;
      }
      return row.state === "sending" ? { change: { to: "sent", nextTry: null } } : refuseRow;
    case "delivered":
      if (part.state === "delivered") {
        return { repeat: { nextKey: null } };
      }
      if (!partMoveAllowed(part.state, "delivered", "markPart")) {
        return refusePart;
      }
      return PART_OUT_ROW_STATES.has(row.state) ? { change: { to: "delivered", nextTry: null } } : refuseRow;
    case "failed": {
      const highest = Math.max(
        ...parts.filter((one) => one.part_no === part.part_no).map((one) => one.try_no),
      );
      if (part.state === "failed") {
        // A repeat (default 8): its next try's key when one is written; else, with retry, the next try now.
        if (highest > part.try_no) {
          return { repeat: { nextKey: keyOf(row.id, part.part_no, highest) } };
        }
        if (!mark.retry) {
          return { repeat: { nextKey: null } };
        }
        if (!partMoveAllowed(null, "pending", "markPart")) {
          return refusePart;
        }
        return PART_OUT_ROW_STATES.has(row.state)
          ? { change: { to: null, nextTry: highest + 1 } }
          : refuseRow;
      }
      if (!partMoveAllowed(part.state, "failed", "markPart")) {
        return refusePart;
      }
      if (mark.retry && !partMoveAllowed(null, "pending", "markPart")) {
        return refusePart;
      }
      return PART_OUT_ROW_STATES.has(row.state)
        ? { change: { to: "failed", nextTry: mark.retry ? highest + 1 : null } }
        : refuseRow;
    }
  }
}

async function markPartIn(tx: Sql, mark: MarkChecked): Promise<MarkPartOutcome> {
  const found = await findPart(tx, mark);
  if (found === null) {
    const rowId = mark.outcome === "delivered" ? mark.providerMessageId : mark.key;
    return { error: "notFound", table: "outbox_parts", rowId };
  }
  // The row first, then its parts: the order claimOutbox locks them in, so the two never wait on each other in a circle.
  const [row] = await tx<MarkedRow[]>`
    select id, state, version, final_parts, open_question_id from outbox_rows where id = ${found.rowId} for update
  `;
  if (row === undefined) {
    throw new Error("markPart: a part's row is missing");
  }
  const parts = await tx<PartRow[]>`
    select ${tx.unsafe(PART_COLUMNS)} from outbox_parts
    where outbox_row_id = ${row.id}
    order by part_no, try_no
    for update
  `;
  const part = parts.find((one) => one.idempotency_key === found.key);
  if (part === undefined) {
    throw new Error("markPart: a part moved while it was found");
  }
  const marked = (repeated: boolean, firstDelivery: boolean, attempts: number, nextKey: string | null) => ({
    result: "marked" as const,
    outboxRowId: row.id,
    partNo: partNoOf(part.part_no - 1),
    tryNo: part.try_no,
    attempts,
    repeated,
    firstDelivery,
    openQuestionId: row.open_question_id,
    nextKey,
  });

  const decision = decideMark(mark, row, part, parts);
  if ("refused" in decision) {
    return decision.refused;
  }
  if ("repeat" in decision) {
    return marked(true, false, part.attempts, decision.repeat.nextKey);
  }
  const { change } = decision;

  // The row's move with its parts (K-07), worked out on the parts as they will stand, before anything is written.
  const kinds = sendKindsOf(row.final_parts);
  if (kinds === null) {
    throw new Error("markPart: a row whose part is out has no final parts to count its parts by");
  }
  const after: PartRow[] = parts.map((one) =>
    one.idempotency_key === part.idempotency_key && change.to !== null ? { ...one, state: change.to } : one,
  );
  const nextKey = change.nextTry === null ? null : keyOf(row.id, part.part_no, change.nextTry);
  if (nextKey !== null && change.nextTry !== null) {
    after.push({
      part_no: part.part_no,
      try_no: change.nextTry,
      idempotency_key: nextKey,
      attempts: 1,
      kind: "words",
      state: "pending",
      linq_message_id: null,
      delivered_at: null,
    });
  }
  const rowTo = rowStateAfter(row.state, after, kinds.length);
  if (rowTo !== row.state && !rowMoveAllowed(row.state, rowTo, "markPart")) {
    return wrongState("outbox_rows", row.id, row.state);
  }
  const firstDelivery = change.to === "delivered" && parts.every((one) => one.delivered_at === null);

  let attempts = part.attempts;
  switch (mark.outcome) {
    case "attempt": {
      const [updated] = await tx<{ attempts: number }[]>`
        update outbox_parts set attempts = attempts + 1, version = version + 1
        where idempotency_key = ${part.idempotency_key} and state = 'pending'
        returning attempts
      `;
      if (updated === undefined) {
        throw new Error("markPart: a part moved while it was locked");
      }
      attempts = updated.attempts;
      break;
    }
    case "sent":
      await tx`
        update outbox_parts
        set state = 'sent', linq_message_id = ${mark.providerMessageId},
            linq_option_ids = ${mark.providerOptionIds === null ? null : tx.json(mark.providerOptionIds)},
            sent_at = ${mark.at}, version = version + 1
        where idempotency_key = ${part.idempotency_key} and state = 'pending'
      `;
      break;
    case "delivered":
      await tx`
        update outbox_parts set state = 'delivered', delivered_at = ${mark.at}, version = version + 1
        where idempotency_key = ${part.idempotency_key} and state in ('sent', 'failed')
      `;
      break;
    case "failed":
      if (change.to === "failed") {
        await tx`
          update outbox_parts
          set state = 'failed', failed_at = ${mark.at}, error_code = ${mark.errorCode}, version = version + 1
          where idempotency_key = ${part.idempotency_key} and state in ('pending', 'sent')
        `;
      }
      if (nextKey !== null && change.nextTry !== null) {
        // Default 8: the next try goes plain, as words, under a new key (arch 01 line 65; arch 07 line 367).
        await tx`
          insert into outbox_parts (outbox_row_id, part_no, try_no, idempotency_key, attempts, kind, state)
          values (${row.id}, ${part.part_no}, ${change.nextTry}, ${nextKey}, 1, 'words', 'pending')
        `;
      }
      break;
  }
  // Every mark that changes a part raises the row's version by one, its state moving with its parts or not.
  const [moved] = await tx<{ version: number }[]>`
    update outbox_rows set state = ${rowTo}, version = version + 1
    where id = ${row.id} and version = ${row.version}
    returning version
  `;
  if (moved === undefined) {
    throw new Error("markPart: the row moved while it was locked");
  }
  return marked(false, firstDelivery, attempts, nextKey);
}

/**
 * Records what happened to one part, and moves its row with it (K-05 v1 item 4; K-07 v1 partMove and rowMove): one
 * transaction on the primary, on the runtime side. Pass the client's primary handle, run as rosie_job. Answers marked
 * (repeated true for a mark already recorded, which changes nothing; firstDelivery true on the row's first delivery
 * receipt; nextKey after a failure with retry), notFound, wrongState (a move K-07 does not allow: nothing written) or
 * transient. Throws for a request it cannot carry out; nothing is written then either.
 */
export async function markPart(sql: Sql, request: MarkPartRequest): Promise<MarkPartOutcome> {
  const checked = checkMarkPart(request);
  try {
    return await inRuntimeTransaction(sql, { readOnly: false }, (tx) => markPartIn(tx, checked));
  } catch (error) {
    return transientOrScrubbed(MARK_PART, error);
  }
}

// ---- markRow (K-05 v1 item 4: limit 8's outcomes) -----------------------------------------------------------------------

async function markRowIn(tx: Sql, mark: MarkRowChecked): Promise<MarkRowOutcome> {
  const { outboxRowId } = mark;
  const [row] = await tx<{ state: RowState; version: number }[]>`
    select state, version from outbox_rows where id = ${outboxRowId} for update
  `;
  if (row === undefined) {
    return { error: "notFound", table: "outbox_rows", rowId: outboxRowId };
  }
  const to = MARKED_STATES[mark.outcome];
  // Limit 8's outcomes start only from sending (K-07 rowMove): checked before the version, as K-05 v1.1 item 16 lists it.
  if (!rowMoveAllowed(row.state, to, "markRow")) {
    return wrongState("outbox_rows", outboxRowId, row.state);
  }
  if (row.version !== mark.expectVersion) {
    return versionChanged(outboxRowId, mark.expectVersion, row.version);
  }
  const [marked] =
    mark.outcome === "held"
      ? await tx<{ version: number }[]>`
          update outbox_rows set state = 'held', held_until = ${mark.heldUntil}, version = version + 1
          where id = ${outboxRowId} and version = ${mark.expectVersion} and state = 'sending'
          returning version
        `
      : mark.outcome === "stale"
        ? await tx<{ version: number }[]>`
            update outbox_rows set state = 'stale', plan = null, final_parts = null, version = version + 1
            where id = ${outboxRowId} and version = ${mark.expectVersion} and state = 'sending'
            returning version
          `
        : await tx<{ version: number }[]>`
            update outbox_rows set state = ${to}, version = version + 1
            where id = ${outboxRowId} and version = ${mark.expectVersion} and state = 'sending'
            returning version
          `;
  if (marked === undefined) {
    throw new Error("markRow: the row moved while it was locked");
  }
  return { result: "marked", outboxRowId, version: marked.version, outcome: mark.outcome };
}

/**
 * Limit 8's outcome for a claimed row (K-05 v1 item 4; arch 06 line 313), compare-and-set on its version: one
 * transaction on the primary, on the runtime side. Pass the client's primary handle, run as rosie_job. Answers marked
 * (the row's new version), wrongState (the row is not sending: K-07's limit-8 moves start only there), versionChanged,
 * notFound or transient. Throws for a request it cannot carry out (held with no time); nothing is written then either.
 */
export async function markRow(sql: Sql, request: MarkRowRequest): Promise<MarkRowOutcome> {
  const checked = checkMarkRow(request);
  try {
    return await inRuntimeTransaction(sql, { readOnly: false }, (tx) => markRowIn(tx, checked));
  } catch (error) {
    return transientOrScrubbed(MARK_ROW, error);
  }
}
