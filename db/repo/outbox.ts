// Data-access K-05 v1 items 2 to 4, with v1.1 items 13 to 16 and v1.2 items 30 to 32: write a row's plan and final
// parts, list the rows a crash left unplanned, claim outbox rows in commit order, renew a claim just before a part goes,
// and move a row's parts and the row with them (T-196, T-1135; C-152; K-05 README items 2 to 4, 13 to 16 and 30 to 32,
// and "The stop and the send"; K-07 v1's states, allowed moves and outbox_claims ("How a claim lapses"); arch 01 lines
// 39 to 41 and 65; arch 02 lines 123 to 127; arch 06 line 313; arch 11 line 576). The runtime calls them, never a Tool
// API path: finalize writes the final parts (C-087, join 10: T-561), and the dispatcher claims, renews, marks and
// receives (C-124, C-125, join 11: T-562).
//
// The outbox calls come in versions, each answering its own contract's shapes:
//   K-05 v1    claimOutbox, markPart and markRow, as T-196 built them: a claim writes no outbox_claims row and never
//              lapses (K-05 v1 open gap 1), and every answer is v1's.
//   K-05 v1.2  claimOutboxV12, renewClaim, markPartV12 and markRowV12 (T-1135): the dispatcher's send loop, as
//              runtime/src/dispatch/types.ts's OutboxStore calls it. Each writes what v1.1 and v1.2 add (the claim, its
//              renewal and re-claim, the row after a mark, a failure's message id and Retry-After, waitingChat, the
//              port, the phone read with the renewal, a receipt found by its part's key), and its answer always carries
//              the new fields, so it is a v1.1 answer with v1.2's fields added (K-05 v1.2: every v1.1 exchange is a
//              v1.2 exchange). Only these write outbox_claims (default 20). markPartV12's answer is K-05 v1.9's from
//              T-1227: it also states repeatedDelivery, what a repeated delivery receipt repeats (v1.9 item 48).
//   K-05 v1.13 claimOutboxV113 (T-1279; ADR-016 card R0): claimOutboxV12's claim, each claimed row also carrying
//              emailPurpose and notAfter, K-04 v1.1's outbox_rows.email_purpose and not_after as stored, null where the
//              column is null (v1.13 item 64): limit 8 withdraws a row at or after its notAfter at every try, and the
//              email port tells a code row by its purpose (ADR-016 sections 3 and 5; cards E1 and F). claimOutboxV12
//              keeps answering v1.2's claimed row, which v1.2 closes, so its consumers are unchanged: a claimed row
//              with neither field is a v1 to v1.12 answer. The claim writes the same rows either way.
// writePlan and unplannedRows are the same in every version.
//
// A row with no turn (K-04 v1.1's job row: turn_id null and a job id in its place, such as a sign-in code's email row,
// ADR-016 section 1) is written, claimed, renewed and marked as any row: no call here reads a row's turn, and only
// unplannedRows names one, finding rows by it, so it never lists a job row (ADR-016 section 1's reader table). The
// claimed row carries no turn id and no job id. A failed mark with no followUps on such a row is marked as for any
// row (v1.13 item 66); one that carries followUps is refused before anything is written, the failure included
// (default 19), which is what item 66's noTurn holds for it, until the task that writes follow-ups gives that refusal
// its own answer (item 66: the refusal goes with the card that builds each of the three).
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
//                  not open, so they are skipped. Under v1 a claim never lapses (K-05 v1 open gap 1).
//   claimOutboxV12 claimOutbox, and (v1.1 item 13) each claim writes the row's outbox_claims row under the row's lock:
//                  claimer, claimed_at = now, lapses_at = now + 60 s (K-07 default 2), claim_no 1 for a row with none or
//                  raised by one, first_try_at and next_try_not_before kept, the claim's version raised; it is returned as
//                  claim, with claimedFrom (checked, held or sending) and (v1.2 item 30) port: linq for the imessage, rcs
//                  and sms channels, email for email, so never an SMS port (DL-012). Under the recipient's lock the walk
//                  also takes a sending row whose claim has lapsed (lapses_at <= now) or that has no claim row (K-05
//                  default 20), by compare-and-set on the row's version and the claim's claim_no: its unsent parts under
//                  their stored keys with attempts raised, its accepted parts listed as sent. A sending row with a live
//                  claim stops the walk. The sweep also walks a recipient whose first row not passed is such a row.
//   renewClaim     The dispatcher's call just before each send of a part (v1.1 item 14; K-05 default 11). It locks the row
//                  and its claim: the row must be sending and the claim the caller's (claimer and claimNo), or claimLost
//                  (a lapsed claim nobody took again is still the caller's); the key a pending part of the row (notFound,
//                  wrongState); a next_try_not_before after `at` answers notYet with it. Then lapses_at = at + 60 s,
//                  first_try_at = at if null, next_try_not_before cleared; only the claim's version rises, never the
//                  row's. In the same transaction (v1.2 item 32) it reads the recipient's phone row FOR SHARE, which waits
//                  for a STOP whose commit is writing that row, so the renewal sees the stop, and returns its stopped flag,
//                  chat flag and version as recipient (null with no phone row: an email handle). It refuses nothing for
//                  a stop: what a stop allows is limit 8's (C-125; K-05 default 38).
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
//   markPartV12    markPart, answering the row's state and version after the mark (v1.1 item 15: the dispatcher compares
//                  them in its next markRow), and: failed may carry providerMessageId, stored in linq_message_id when the
//                  part holds none, and with retry nextTryNotBefore, the provider's Retry-After, stored in the claim's
//                  next_try_not_before; delivered may carry the part's key the receipt echoes (v1.2 item 31): when no part
//                  holds the receipt's message id, the part under the key is the receipt's if it holds no message id of
//                  its own (a 4001 or 4006 gave none), and the receipt's id is stored on it, so a later receipt finds it
//                  the first way and a receipt after a 4001 or 4006 moves failed to delivered (K-05 default 39). A part
//                  under the key that holds another message id is not the receipt's (notFound). From K-05 v1.9 (item
//                  48; T-1227) every answer also states repeatedDelivery. On a receipt that repeats a recorded
//                  delivery it is what the receipt repeats, read in the same transaction from the row's part tries
//                  as they stand locked, with no write: firstOfRow, true when no other part try of the row holds an
//                  earlier delivered_at (a tie counts as first: K-05 default 85), and deliveredAt, the part try's
//                  stored delivered_at, never the repeat's own time (default 86). On every other answer it is null
//                  (default 87). firstDelivery keeps v1's meaning: a repeat never says it (default 88). So the
//                  answer is K-05 v1.9's markPart.v1dot9Response.
//   markRow        Limit 8's outcome at send (arch 06 line 313), compare-and-set on the row's version: held sets held_until
//                  (the row returns to the open rows, claimed again once it passes), droppedStopped and withdrawn close
//                  it, and stale clears plan and final_parts, so unplannedRows lists it and it is composed again from
//                  today's record (S13-57).
//   markRowV12     markRow, and waitingChat (v1.1 item 16): sending to waiting_chat, held_until cleared and the row's
//                  outbox_claims row deleted; no clock arms and nothing is sent (arch 06 line 313; RULES 4.1b; MC C9).
//                  The other outcomes keep the claim row, so claim_no keeps counting the row's claims (a held row's
//                  morning claim is claim 2: K-07 outbox-held-text-hours).
//
// Every move these calls make is one of K-07 v1's (ROW_MOVES and PART_MOVES below, K-07's lists word for word: the
// integration test compares them with outbox-effects.v1.schema.json). A move K-07 does not allow is refused before
// anything is written (delivered back to sending, anything out of dropped_stopped): K-05 v1.1's wrongState, with the
// state the row or part stands in now.
//
// Locks: every call that writes a row's parts or its claim locks the outbox row first (FOR UPDATE), so two calls on one
// row run one after the other and never wait on each other in a circle; renewClaim's phone read comes last.
//
// Side (K-05 README "Scope": runtime; T-191's roles): each call is one transaction on the primary, uncached, run as
// rosie_job with no business scope (inRuntimeTransaction clears it; read committed for the writes, so a FOR SHARE read
// that waited sees the row the other transaction committed), so the dispatcher's sweep sees every business's rows.
// outbox_parts, outbox_claims and phones have no row-level security (the dispatcher alone reads and writes the first two,
// and the runtime side alone reads phones: K-04, K-07).
//
// Answers: K-05 v1's responses and errors, and K-05 v1.1's wrongState for a move K-07 does not allow (default 1); the
// v1.2 calls K-05 v1.2's, with v1.1's claimLost and notYet. A serialization failure, a deadlock (a renewal's with a STOP
// that is committing included: K-05 v1.2 item 32) or a lost connection answers transient: nothing was written, and the
// same request may be sent again. A request a call cannot carry out throws a TypeError, a database refusal no K-05
// answer names throws DataAccessDatabaseError (its SQLSTATE and names only), and nothing is written either way.
//
// Nothing here logs. What it throws names a call, a field, a table or a state, never a value, a row id or a key (a key
// carries its row id); a refusal never carries PostgresError.detail, which can hold a row's words (CQ-59; the security
// reviewer's note (a) on T-189). A phone row is read for its two flags and its version only, never its number.
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
//  12. A claim reads the row's claim row FOR UPDATE under the row's lock. A checked row that was claimed before (a sent
//      row whose accepted part failed and went back to checked, or a stale row composed again) or a held row keeps its
//      claim row, so its claim updates it, claim_no + 1, keeping first_try_at and next_try_not_before (K-05 item 13:
//      "kept from it"); a row with none gets claim 1. The claim's times are the request's `now`, not the database's.
//  13. A lapsed sending row whose part's latest try failed with no next try (a 4001 or 4006 waiting for its receipt, or
//      for its minute: K-07 rule 2) stops its recipient's walk unclaimed, as default 5 says for any claimable row: a new
//      dispatcher cannot know when the minute ends, and nothing is sent twice. Its receipt (markPartV12 delivered, by
//      message id or key) or a failure with retry (its next try) moves it; until then the sweep finds it again.
//  14. renewClaim checks in K-05 item 14's order: the row (notFound), then the claim (claimLost, naming the claimer and
//      claim number now, or null and null with no claim row), then the part, then the Retry-After (notYet). A key no
//      part holds answers notFound (outbox_parts, the key); a key of another row's part, or of a part that is not
//      pending, answers wrongState with that part's state (renewClaim.errors: "the part is not this row's or not
//      pending"). The part is read without a lock: its row's lock, held, keeps it still. A renewal whose at + 60 s is
//      not after the claim's claimed_at is refused by outbox_claims_lapse_after_claim (DataAccessDatabaseError).
//  15. renewClaim's phone row is the one whose handle_id is the row's recipient (K-04 phones_handle_key), read last, so a
//      refusal waits on no phone lock. With no phone row (an email handle, or a number whose first turn wrote none)
//      recipient is null, which T-562 treats as unreadable and sends nothing (K-05 README, the consumer note for T-562).
//  16. A receipt found by its key answers notFound naming the receipt's message id, as a receipt by message id does,
//      when the part under the key holds another message id; under the row's lock the part is read again, so a receipt
//      whose id a twin receipt stored meanwhile is that part's (a repeat). A part under the key that is pending (never
//      accepted) answers wrongState: K-07 has no pending-to-delivered move.
//  17. markPartV12 failed stores providerMessageId only as the part moves to failed (when it holds none); a failure for a
//      part already failed, a repeat or its next try's writing, stores none (the part does not move).
//  18. markPartV12 failed's nextTryNotBefore is written to the claim only with the next try it holds (retry true, a mark
//      that is not a repeat). A row with no claim row (claimed by v1 code) refuses it, thrown with nothing written: the
//      Retry-After would otherwise be lost. A failure with retry and no nextTryNotBefore leaves the claim as it is.
//  19. markPartV12 refuses a failure carrying followUps or events (a failed safety line's other ways, written with its
//      first failure: v1.1 item 15), thrown with nothing written, until the task that writes them (T-1136) lands: a
//      safety failure is never recorded without the rows that follow it (K-05 default 22).
//  20. Only the v1.2 calls write outbox_claims; the v1 calls keep T-196's behaviour and answers unchanged, so a row a v1
//      claim holds has no claim row and a v1.2 claim takes it again at once (K-05 default 20). The two are never run
//      against one outbox: the dispatcher (T-562) calls the v1.2 calls only.
//  21. markPartV12 reads repeatedDelivery (K-05 v1.9 item 48) only for a delivery receipt that repeats a recorded
//      delivery, from the delivered_at of the row's part tries, whatever their state. A delivered part try of the row
//      that holds no delivered_at, the repeated one or another, is thrown with nothing written: which delivery was the
//      row's first cannot be read from it, and it is never answered by a guess (T-1226's reviews). No K-05 call writes
//      such a part, and since K-04 v1.1 the database refuses one: migration 0032 adds and validates the CHECK
//      outbox_parts_delivered_has_time (state <> 'delivered' or delivered_at is not null; CQ-211). So
//      repeatedDeliveryOf's guard ("a delivered part holds no delivered_at") is a second guard, which that CHECK makes
//      unreachable on a migrated database; its code stays (DL-584). The v1 call reads none of this and answers as
//      before.
import type * as K05 from "../../contracts/generated/data-access/data-access.v1";
import type * as K05v11 from "../../contracts/generated/data-access/data-access.v1.1";
import type * as K05v12 from "../../contracts/generated/data-access/data-access.v1.2";
import type * as K05v19 from "../../contracts/generated/data-access/data-access.v1.9";
import type * as K12 from "../../contracts/generated/port-email/port-email.v1";
import { commitSeqOf, instantOf, transientOrScrubbed } from "./clocks";
import type { Sql } from "./scope";
import { assertRequestShape, inRuntimeTransaction, utc, utcOrNull } from "./targets";

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

// ---- the v1.2 calls' shapes (K-05 v1.2, which refers on to v1.1 for renewClaim's request, markPart's answer and
// markRow) ------------------------------------------------------------------------------------------------------------

/** K-07 v1 outboxClaim, K-05 v1.1's claim: who holds the row, when it lapses, its number and the two kept times. */
export type OutboxClaim = K05v12.OutboxClaim;
/** K-07 v1 port in K-05 v1.2's names: linq or email, never an SMS port (DL-012). */
export type Port = K05v12.Port;
/** The state a claimed row was claimed from: K-07's moves to sending by claimOutbox. */
export type ClaimedFrom = "checked" | "held" | "sending";

/** K-05 v1.2 claimedRow as a v1.2 call always writes it: v1's fields, v1.1's claim and claimedFrom, v1.2's port. */
export type ClaimedRowV12 = ClaimedRow & { claim: OutboxClaim; claimedFrom: ClaimedFrom; port: Port };

/** K-05 v1.2 claimOutbox.response: each claimed row with its claim and port. */
export interface ClaimOutboxV12Response {
  result: "claimed";
  claimed: ClaimedRowV12[];
  passedHeld: PassedHeld[];
}
export type ClaimOutboxV12Outcome = ClaimOutboxV12Response | K05.TransientError;

export type RenewClaimRequest = K05v12.RenewClaimRequest;
/** K-05 v1.2 phoneFlags: the recipient's stopped flag, chat flag and phone row version. */
export type PhoneFlags = K05v12.PhoneFlags;
/** K-05 v1.2 renewClaim.response as a v1.2 call always writes it: the renewed claim and the phone read with it. */
export interface RenewClaimResponse {
  result: "renewed";
  outboxRowId: string;
  claim: OutboxClaim;
  /** The recipient's phone row as this transaction read it, FOR SHARE; null with no phone row (an email handle). */
  recipient: PhoneFlags | null;
}
export type ClaimLostError = K05v12.ClaimLostError;
export type NotYetError = K05v12.NotYetError;
export type RenewClaimError =
  ClaimLostError | NotYetError | WrongStateError | K05.NotFoundError | K05.TransientError;
export type RenewClaimOutcome = RenewClaimResponse | RenewClaimError;

export type MarkPartV12Request = K05v12.MarkPartRequest;
/** The row after a mark: its state in K-07's words and its version (K-05 v1.1 markPart.response row). */
export interface RowAfter {
  state: RowState;
  version: number;
}
/** K-05 v1.9 repeatedDelivery (item 48): the delivery a repeated receipt repeats, whether the row's first, and when. */
export type RepeatedDelivery = K05v19.RepeatedDelivery;
/**
 * markPartV12's answer, K-05 v1.9's markPart.v1dot9Response (T-1227): v1's fields, the row after the mark, which a v1.2
 * call always writes (v1.1 item 15), and repeatedDelivery, always stated: what a repeated delivery receipt repeats,
 * and null on every other answer (v1.9 item 48).
 */
export type MarkPartV12Response = K05v19.MarkPartV1Dot9Response;
export type MarkPartV12Outcome = MarkPartV12Response | MarkPartError;

export type MarkRowV12Request = K05v12.MarkRowRequest;
export type MarkRowV12Response = K05v12.MarkRowResponse;
export type MarkRowV12Outcome = MarkRowV12Response | MarkRowError;

// ---- the v1.13 claim's shapes (K-05 v1.13 item 64; its claimedRow takes two optional fields, which a v1.13 call always
// writes, and its claimOutbox.request is v1.2's) ------------------------------------------------------------------------

/** K-12 v1's purpose of an email row: K-04 v1.1 outbox_rows.email_purpose, which its CHECK holds to these six. */
export type EmailPurpose = K12.EmailPurpose;

/**
 * K-05 v1.13 claimedRow as a v1.13 call always writes it (README item 64): v1.2's claimed row, and emailPurpose and
 * notAfter, outbox_rows.email_purpose and not_after as stored, null where the column is null. K-04 v1.1's CHECKs hold a
 * purpose to an email row and give a code row its notAfter (outbox_rows_email_purpose_is_email,
 * outbox_rows_code_has_not_after). It carries no turn id and no job id (ADR-016 section 1's reader table).
 */
export type ClaimedRowV113 = ClaimedRowV12 & { emailPurpose: EmailPurpose | null; notAfter: string | null };

/** K-05 v1.13 claimOutbox.response: each claimed row with its claim, port, purpose and end. */
export interface ClaimOutboxV113Response {
  result: "claimed";
  claimed: ClaimedRowV113[];
  passedHeld: PassedHeld[];
}
export type ClaimOutboxV113Outcome = ClaimOutboxV113Response | K05.TransientError;

// ---- request checks: what the database cannot be trusted to refuse ---------------------------------------------------

const WRITE_PLAN = "writePlan";
const UNPLANNED_ROWS = "unplannedRows";
const CLAIM_OUTBOX = "claimOutbox";
const RENEW_CLAIM = "renewClaim";
const MARK_PART = "markPart";
const MARK_ROW = "markRow";

/** K-05 claimOutbox.limit: at most this many rows in all. */
const MAX_LIMIT = 100;
/** K-07 default 2: a claim lapses 60 s after it is taken or renewed. */
const CLAIM_LAPSE_MS = 60_000;
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

/** Refuses a record that lacks one of `required` or has a field outside `required` and `optional`. */
function assertFieldsWithin(
  call: string,
  record: Row,
  required: readonly string[],
  optional: readonly string[],
  what: string,
): void {
  const known = (key: string): boolean => required.includes(key) || optional.includes(key);
  if (!required.every((field) => Object.hasOwn(record, field)) || !Object.keys(record).every(known)) {
    fail(call, `${what} takes ${required.join(", ")}, and may take ${optional.join(", ")}`);
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

interface RenewChecked {
  readonly outboxRowId: string;
  readonly claimer: string;
  readonly claimNo: number;
  readonly key: string;
  readonly at: Date;
}

/** renewClaim's request: every field required (K-05 v1.1 renewClaim.request). */
function checkRenew(request: RenewClaimRequest): RenewChecked {
  assertRequestShape(request, RENEW_CLAIM, ["outboxRowId", "claimer", "claimNo", "idempotencyKey", "at"]);
  const raw = request as unknown as Row;
  const claimNo = raw.claimNo;
  if (typeof claimNo !== "number" || !Number.isSafeInteger(claimNo) || claimNo < 1) {
    fail(RENEW_CLAIM, "claimNo is not a claim number (a positive integer)");
  }
  return {
    outboxRowId: idOf(RENEW_CLAIM, raw.outboxRowId, "outboxRowId"),
    claimer: idOf(RENEW_CLAIM, raw.claimer, "claimer"),
    claimNo,
    key: partKeyOf(RENEW_CLAIM, raw.idempotencyKey),
    at: instantOf(RENEW_CLAIM, raw.at, "at"),
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
  | {
      readonly outcome: "delivered";
      readonly providerMessageId: string;
      /** v1.2: the part's key the receipt echoes, used only when no part holds the message id; v1: always null. */
      readonly key: string | null;
      readonly at: Date;
    }
  | {
      readonly outcome: "failed";
      readonly key: string;
      readonly errorCode: string;
      readonly retry: boolean;
      /** v1.1: the provider's message id the failure carries; v1: always null. */
      readonly providerMessageId: string | null;
      /** v1.1: the provider's Retry-After for the next try (retry true only); v1: always null. */
      readonly nextTryNotBefore: Date | null;
      readonly at: Date;
    };

/** markPart's attempt, the same in every version. */
function attemptOf(raw: Row): MarkChecked {
  assertFields(MARK_PART, raw, ["outcome", "idempotencyKey", "at"], "an attempt");
  return {
    outcome: "attempt",
    key: partKeyOf(MARK_PART, raw.idempotencyKey),
    at: instantOf(MARK_PART, raw.at, "at"),
  };
}

/** markPart's sent, the same in every version. */
function sentOf(raw: Row): MarkChecked {
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

/** markPart failed's fields of every version: its code, whether a next try follows, its key and time. */
function failureOf(raw: Row): { key: string; errorCode: string; retry: boolean; at: Date } {
  const errorCode = raw.errorCode;
  if (typeof errorCode !== "string" || errorCode === "" || errorCode.includes("\u0000")) {
    fail(MARK_PART, "errorCode is not a non-empty code");
  }
  if (typeof raw.retry !== "boolean") {
    fail(MARK_PART, "retry is not true or false");
  }
  return {
    key: partKeyOf(MARK_PART, raw.idempotencyKey),
    errorCode,
    retry: raw.retry,
    at: instantOf(MARK_PART, raw.at, "at"),
  };
}

/** K-05 v1 markPart.request. */
function checkMarkPart(request: MarkPartRequest): MarkChecked {
  if (!isRecord(request)) {
    fail(MARK_PART, "the request is not an object");
  }
  const raw = request as Row;
  switch (raw.outcome) {
    case "attempt":
      return attemptOf(raw);
    case "sent":
      return sentOf(raw);
    case "delivered":
      assertFields(MARK_PART, raw, ["outcome", "providerMessageId", "at"], "a delivery receipt");
      return {
        outcome: "delivered",
        providerMessageId: idOf(MARK_PART, raw.providerMessageId, "providerMessageId"),
        key: null,
        at: instantOf(MARK_PART, raw.at, "at"),
      };
    case "failed":
      assertFields(MARK_PART, raw, ["outcome", "idempotencyKey", "errorCode", "retry", "at"], "a failure");
      return { outcome: "failed", ...failureOf(raw), providerMessageId: null, nextTryNotBefore: null };
    default:
      return fail(MARK_PART, "outcome is not attempt, sent, delivered or failed");
  }
}

/** K-05 v1.2 markPart.request: v1.1's failure fields (followUps refused: default 19) and v1.2's receipt key. */
function checkMarkPartV12(request: MarkPartV12Request): MarkChecked {
  if (!isRecord(request)) {
    fail(MARK_PART, "the request is not an object");
  }
  const raw = request as Row;
  switch (raw.outcome) {
    case "attempt":
      return attemptOf(raw);
    case "sent":
      return sentOf(raw);
    case "delivered": {
      assertFieldsWithin(
        MARK_PART,
        raw,
        ["outcome", "providerMessageId", "at"],
        ["idempotencyKey"],
        "a delivery receipt",
      );
      const key = raw.idempotencyKey;
      return {
        outcome: "delivered",
        // A receipt always carries its message id (refuse-mark-delivered-key-only).
        providerMessageId: idOf(MARK_PART, raw.providerMessageId, "providerMessageId"),
        key: key === undefined || key === null ? null : partKeyOf(MARK_PART, key),
        at: instantOf(MARK_PART, raw.at, "at"),
      };
    }
    case "failed": {
      if (Object.hasOwn(raw, "followUps") || Object.hasOwn(raw, "events")) {
        fail(
          MARK_PART,
          "followUps and events (a failed safety line's other ways) are not written here (default 19)",
        );
      }
      assertFieldsWithin(
        MARK_PART,
        raw,
        ["outcome", "idempotencyKey", "errorCode", "retry", "at"],
        ["providerMessageId", "nextTryNotBefore"],
        "a failure",
      );
      const failure = failureOf(raw);
      const messageId = raw.providerMessageId;
      const notBefore = raw.nextTryNotBefore;
      const nextTryNotBefore =
        notBefore === undefined || notBefore === null
          ? null
          : instantOf(MARK_PART, notBefore, "nextTryNotBefore");
      if (nextTryNotBefore !== null && !failure.retry) {
        // The schema's if/then: a Retry-After holds a next try, so it goes only with retry true.
        fail(MARK_PART, "nextTryNotBefore is null for a failure with no retry");
      }
      return {
        outcome: "failed",
        ...failure,
        providerMessageId:
          messageId === undefined || messageId === null
            ? null
            : idOf(MARK_PART, messageId, "providerMessageId"),
        nextTryNotBefore,
      };
    }
    default:
      return fail(MARK_PART, "outcome is not attempt, sent, delivered or failed");
  }
}

/** markRow's outcomes under K-05 v1 and the K-07 state each moves the row to. */
const MARKED_STATES = {
  held: "held",
  droppedStopped: "dropped_stopped",
  stale: "stale",
  withdrawn: "withdrawn",
} as const satisfies Record<MarkRowRequest["outcome"], RowState>;

/** markRow's outcomes under K-05 v1.1 and v1.2: v1's, and waitingChat. */
const MARKED_STATES_V12 = {
  ...MARKED_STATES,
  waitingChat: "waiting_chat",
} as const satisfies Record<MarkRowV12Request["outcome"], RowState>;

type MarkRowOutcomeName = keyof typeof MARKED_STATES;
type MarkRowV12OutcomeName = keyof typeof MARKED_STATES_V12;

interface MarkRowChecked<O extends MarkRowV12OutcomeName> {
  readonly outboxRowId: string;
  readonly expectVersion: number;
  readonly outcome: O;
  readonly heldUntil: Date | null;
}

function isMarkRowOutcome(value: unknown): value is MarkRowOutcomeName {
  return typeof value === "string" && Object.hasOwn(MARKED_STATES, value);
}

function isMarkRowV12Outcome(value: unknown): value is MarkRowV12OutcomeName {
  return typeof value === "string" && Object.hasOwn(MARKED_STATES_V12, value);
}

/** markRow's request, its outcome one of the version's (`isOutcome`, named by `outcomes` when refused). */
function checkMarkRowOf<O extends MarkRowV12OutcomeName>(
  request: unknown,
  isOutcome: (value: unknown) => value is O,
  outcomes: string,
): MarkRowChecked<O> {
  assertRequestShape(request, MARK_ROW, ["outboxRowId", "expectVersion", "outcome", "heldUntil", "at"]);
  const raw = request as Row;
  const outcome = raw.outcome;
  if (!isOutcome(outcome)) {
    fail(MARK_ROW, `outcome is not ${outcomes}`);
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

function checkMarkRow(request: MarkRowRequest): MarkRowChecked<MarkRowOutcomeName> {
  return checkMarkRowOf(request, isMarkRowOutcome, "held, droppedStopped, stale or withdrawn");
}

function checkMarkRowV12(request: MarkRowV12Request): MarkRowChecked<MarkRowV12OutcomeName> {
  return checkMarkRowOf(
    request,
    isMarkRowV12Outcome,
    "held, droppedStopped, stale, withdrawn or waitingChat",
  );
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

// ---- the claim on a sending row (K-07 outbox_claims; K-05 v1.1 items 13, 14 and 16) -------------------------------------

/** An outbox_claims row as read. */
interface ClaimRead {
  claimer: string;
  claimed_at: Date;
  lapses_at: Date;
  claim_no: number;
  first_try_at: Date | null;
  next_try_not_before: Date | null;
  version: number;
}

const CLAIM_COLUMNS = "claimer, claimed_at, lapses_at, claim_no, first_try_at, next_try_not_before, version";

/** When a claim taken or renewed at `at` lapses (K-07 default 2). */
function lapseAfter(at: Date): Date {
  return new Date(at.getTime() + CLAIM_LAPSE_MS);
}

/** The row's claim, locked; undefined when it has none. The caller holds the row's lock. */
async function lockClaim(tx: Sql, rowId: string): Promise<ClaimRead | undefined> {
  const [claim] = await tx<ClaimRead[]>`
    select ${tx.unsafe(CLAIM_COLUMNS)} from outbox_claims where outbox_row_id = ${rowId} for update
  `;
  return claim;
}

/** A claim row in K-07's names (outboxClaim). */
function claimOf(claim: ClaimRead): OutboxClaim {
  return {
    claimer: claim.claimer,
    claimedAt: utc(claim.claimed_at),
    lapsesAt: utc(claim.lapses_at),
    claimNo: claim.claim_no,
    firstTryAt: utcOrNull(claim.first_try_at),
    nextTryNotBefore: utcOrNull(claim.next_try_not_before),
  };
}

/** The claim a v1.2 claim takes: who, at which moment, over the claim row read under the row's lock (if any). */
interface Claiming {
  readonly claimer: string;
  readonly now: Date;
  readonly current: ClaimRead | undefined;
}

/**
 * Writes the claim a claim takes (K-05 v1.1 item 13; default 12): claim 1 for a row with no claim row; else the row's
 * claim taken over by compare-and-set on its claim_no and version, claim_no + 1, its two kept times as they are.
 */
async function writeClaim(tx: Sql, rowId: string, claiming: Claiming): Promise<OutboxClaim> {
  const { claimer, now, current } = claiming;
  const lapses = lapseAfter(now);
  const [written] =
    current === undefined
      ? await tx<ClaimRead[]>`
          insert into outbox_claims (outbox_row_id, claimer, claimed_at, lapses_at, claim_no)
          values (${rowId}, ${claimer}, ${now}, ${lapses}, 1)
          returning ${tx.unsafe(CLAIM_COLUMNS)}
        `
      : await tx<ClaimRead[]>`
          update outbox_claims
          set claimer = ${claimer}, claimed_at = ${now}, lapses_at = ${lapses}, claim_no = claim_no + 1,
              version = version + 1
          where outbox_row_id = ${rowId} and claim_no = ${current.claim_no} and version = ${current.version}
          returning ${tx.unsafe(CLAIM_COLUMNS)}
        `;
  if (written === undefined) {
    throw new Error("claimOutbox: a claim moved while its row was locked");
  }
  return claimOf(written);
}

/** K-07 outboxRow.port, from the channel as K-07 ties them (K-05 v1.2 item 30): no SMS port (DL-012). */
function portOf(channel: Channel): Port {
  return channel === "email" ? "email" : "linq";
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

// ---- claimOutbox (K-05 v1 item 3; v1.1 item 13 and v1.2 item 30 in claimOutboxV12) ------------------------------------

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
  /** K-04 v1.1: an email row's K-12 purpose, else null (outbox_rows_email_purpose_known and _is_email). */
  email_purpose: EmailPurpose | null;
  /** K-04 v1.1: no part of the row is sent at or after it; a code row always has one (outbox_rows_code_has_not_after). */
  not_after: Date | null;
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

/**
 * The v1.2 sweep's recipients: as claimableRecipients, and a recipient whose first open row that is not passed is a
 * sending row whose claim lapsed or that has no claim row (K-05 v1.1 item 13; default 20).
 */
async function claimableRecipientsV12(tx: Sql, now: Date): Promise<string[]> {
  const rows = await tx<{ recipient_handle_id: string }[]>`
    select f.recipient_handle_id
    from (
      select distinct on (r.recipient_handle_id) r.recipient_handle_id, r.state,
             (c.outbox_row_id is null or c.lapses_at <= ${now}) as lapsed
      from outbox_rows r
      left join outbox_claims c on c.outbox_row_id = r.id
      where r.state in ('planned', 'checked', 'sending', 'stale')
         or (r.state = 'held' and (r.held_until is null or r.held_until <= ${now}))
      order by r.recipient_handle_id, r.commit_seq
    ) as f
    join (
      select recipient_handle_id, min(commit_seq) as first_open
      from outbox_rows
      where state in ${tx(OPEN_STATES)}
      group by recipient_handle_id
    ) as o on o.recipient_handle_id = f.recipient_handle_id
    where f.state in ('checked', 'held') or (f.state = 'sending' and f.lapsed)
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
 * when a part's latest try failed with no next try: the row is not sendable as it stands (defaults 5 and 13).
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

/** The state a row is claimed from (K-07: checked, held or sending to sending, by claimOutbox). */
function claimedFromOf(state: RowState): ClaimedFrom {
  if (state === "checked" || state === "held" || state === "sending") {
    return state;
  }
  throw new Error(`claimOutbox: K-07 lets no claim move a ${state} row`);
}

/**
 * One row a claim took: v1's claimed row, the state it was claimed from, its port, (v1.2) its claim, and (v1.13) its
 * purpose and end as stored, which only a v1.13 claim answers.
 */
interface Taken {
  readonly row: ClaimedRow;
  readonly from: ClaimedFrom;
  readonly port: Port;
  /** The claim a v1.2 claim wrote; null under v1, which writes none. */
  readonly claim: OutboxClaim | null;
  readonly emailPurpose: EmailPurpose | null;
  readonly notAfter: Date | null;
}

/**
 * Claims one row under the recipient's lock: its parts, then its move to sending under compare-and-set (K-07: checked,
 * held or, for a lapsed claim, sending to sending, by claimOutbox), then, for a v1.2 claim (`claiming`), its claim row.
 * Null when the row is not sendable as it stands (defaults 5 and 13): nothing is written.
 */
async function claimRow(
  tx: Sql,
  row: OpenRow,
  recipientHandleId: string,
  claiming: Claiming | null,
): Promise<Taken | null> {
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
  const claim = claiming === null ? null : await writeClaim(tx, row.id, claiming);
  return {
    row: {
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
    },
    from: claimedFromOf(row.state),
    port: portOf(row.channel),
    claim,
    emailPurpose: row.email_purpose,
    notAfter: row.not_after,
  };
}

/**
 * One recipient's walk under its lock (K-05 item 3, and v1.1 item 13 for `v12`; K-07 "How K-05 v1's calls use them"),
 * adding to `taken` and `passedHeld` until the walk stops or the limit is reached.
 */
async function walkRecipient(
  tx: Sql,
  recipientHandleId: string,
  request: ClaimChecked,
  v12: boolean,
  taken: Taken[],
  passedHeld: PassedHeld[],
): Promise<void> {
  const rows = await tx<OpenRow[]>`
    select id, commit_seq, state, held_until, version, recipient_person_id, business_id, booking_id,
           open_question_id, channel, send_class, versions_read, final_parts, trace_id, email_purpose, not_after
    from outbox_rows
    where recipient_handle_id = ${recipientHandleId} and state in ${tx(OPEN_STATES)}
    order by commit_seq
    for update
  `;
  for (const row of rows) {
    if (taken.length >= request.limit) {
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
    let current: ClaimRead | undefined;
    if (row.state === "sending") {
      if (!v12) {
        // v1: claimed earlier and not finished, and a claim never lapses (K-05 v1 open gap 1). Commit order: stop.
        return;
      }
      // v1.1: a live claim stops the walk; a lapsed claim, or none (default 20), is taken again.
      current = await lockClaim(tx, row.id);
      if (current !== undefined && current.lapses_at.getTime() > request.now.getTime()) {
        return;
      }
    } else if (row.state === "checked" || row.state === "held") {
      current = v12 ? await lockClaim(tx, row.id) : undefined;
    } else {
      // planned or stale: no final parts yet. Commit order: stop.
      return;
    }
    const claiming = v12 ? { claimer: request.claimer, now: request.now, current } : null;
    const one = await claimRow(tx, row, recipientHandleId, claiming);
    if (one === null) {
      return;
    }
    taken.push(one);
  }
}

async function claimIn(
  tx: Sql,
  request: ClaimChecked,
  v12: boolean,
): Promise<{ taken: Taken[]; passedHeld: PassedHeld[] }> {
  let recipients: string[];
  if (request.recipientHandleId !== null) {
    recipients = [request.recipientHandleId];
  } else if (v12) {
    recipients = await claimableRecipientsV12(tx, request.now);
  } else {
    recipients = await claimableRecipients(tx, request.now);
  }
  const taken: Taken[] = [];
  const passedHeld: PassedHeld[] = [];
  for (const recipient of recipients) {
    if (taken.length >= request.limit) {
      break;
    }
    if (await lockRecipient(tx, recipient)) {
      await walkRecipient(tx, recipient, request, v12, taken, passedHeld);
    }
  }
  return { taken, passedHeld };
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
    return await inRuntimeTransaction(sql, { readOnly: false }, async (tx): Promise<ClaimOutboxResponse> => {
      const { taken, passedHeld } = await claimIn(tx, checked, false);
      return { result: "claimed", claimed: taken.map((one) => one.row), passedHeld };
    });
  } catch (error) {
    return transientOrScrubbed(CLAIM_OUTBOX, error);
  }
}

function claimedV12(one: Taken): ClaimedRowV12 {
  if (one.claim === null) {
    throw new Error("claimOutbox: a v1.2 claim wrote no claim");
  }
  return { ...one.row, claim: one.claim, claimedFrom: one.from, port: one.port };
}

/**
 * K-05 v1.2's claim (v1.1 item 13, v1.2 item 30): claimOutbox, each claim written to outbox_claims and returned with the
 * state it was claimed from and the row's port, and a sending row whose claim lapsed taken again. One transaction on the
 * primary, on the runtime side; pass the client's primary handle, run as rosie_job. Answers claimed or transient.
 */
export async function claimOutboxV12(sql: Sql, request: ClaimOutboxRequest): Promise<ClaimOutboxV12Outcome> {
  const checked = checkClaim(request);
  try {
    return await inRuntimeTransaction(
      sql,
      { readOnly: false },
      async (tx): Promise<ClaimOutboxV12Response> => {
        const { taken, passedHeld } = await claimIn(tx, checked, true);
        return { result: "claimed", claimed: taken.map(claimedV12), passedHeld };
      },
    );
  } catch (error) {
    return transientOrScrubbed(CLAIM_OUTBOX, error);
  }
}

function claimedV113(one: Taken): ClaimedRowV113 {
  return { ...claimedV12(one), emailPurpose: one.emailPurpose, notAfter: utcOrNull(one.notAfter) };
}

/**
 * K-05 v1.13's claim (README item 64; ADR-016 card R0, T-1279): claimOutboxV12's claim, writing the same rows, each
 * claimed row also carrying emailPurpose and notAfter, the row's email_purpose and not_after as stored (K-04 v1.1),
 * null where the column is null, on every claim of the row, a re-claim's included. So limit 8 reads the time from
 * which no part of the row is sent at every try, and the email port the row's K-12 purpose (ADR-016 sections 3 and 5).
 * A row at or past its notAfter is claimed as any row, so that limit 8 can withdraw it (K-07: sending to withdrawn, by
 * markRow): the claim decides nothing by notAfter. A row with no turn (K-04 v1.1's job row) is claimed as any row, and
 * the claimed row carries neither its turn id nor its job id. One transaction on the primary, on the runtime side; pass
 * the client's primary handle, run as rosie_job. Answers claimed or transient.
 */
export async function claimOutboxV113(
  sql: Sql,
  request: ClaimOutboxRequest,
): Promise<ClaimOutboxV113Outcome> {
  const checked = checkClaim(request);
  try {
    return await inRuntimeTransaction(
      sql,
      { readOnly: false },
      async (tx): Promise<ClaimOutboxV113Response> => {
        const { taken, passedHeld } = await claimIn(tx, checked, true);
        return { result: "claimed", claimed: taken.map(claimedV113), passedHeld };
      },
    );
  } catch (error) {
    return transientOrScrubbed(CLAIM_OUTBOX, error);
  }
}

// ---- renewClaim (K-05 v1.1 item 14, v1.2 item 32) -----------------------------------------------------------------------

/** The recipient's phone row, read FOR SHARE: a STOP whose commit is writing it is waited for (default 15). */
async function phoneFlagsOf(tx: Sql, recipientHandleId: string): Promise<PhoneFlags | null> {
  const [phone] = await tx<{ stopped: boolean; chat_open: boolean; version: number }[]>`
    select stopped, chat_open, version from phones where handle_id = ${recipientHandleId}
    for share
  `;
  return phone === undefined
    ? null
    : { stopped: phone.stopped, chatOpen: phone.chat_open, version: phone.version };
}

async function renewIn(tx: Sql, renew: RenewChecked): Promise<RenewClaimOutcome> {
  const { outboxRowId } = renew;
  const [row] = await tx<{ state: RowState; recipient_handle_id: string }[]>`
    select state, recipient_handle_id from outbox_rows where id = ${outboxRowId} for update
  `;
  if (row === undefined) {
    return { error: "notFound", table: "outbox_rows", rowId: outboxRowId };
  }
  const claim = await lockClaim(tx, outboxRowId);
  if (row.state !== "sending" || claim?.claimer !== renew.claimer || claim.claim_no !== renew.claimNo) {
    // The caller sends nothing (default 14). A lapsed claim nobody took again is still the caller's: no lapse check.
    return {
      error: "claimLost",
      table: "outbox_rows",
      rowId: outboxRowId,
      claimer: claim?.claimer ?? null,
      claimNo: claim?.claim_no ?? null,
      state: row.state,
    };
  }
  const [part] = await tx<{ outbox_row_id: string; state: PartState }[]>`
    select outbox_row_id, state from outbox_parts where idempotency_key = ${renew.key}
  `;
  if (part === undefined) {
    return { error: "notFound", table: "outbox_parts", rowId: renew.key };
  }
  if (part.outbox_row_id !== outboxRowId || part.state !== "pending") {
    return wrongState("outbox_parts", renew.key, part.state);
  }
  const notBefore = claim.next_try_not_before;
  if (notBefore !== null && notBefore.getTime() > renew.at.getTime()) {
    // K-07 rule 6: the provider's Retry-After holds the try.
    return { error: "notYet", outboxRowId, notBefore: utc(notBefore) };
  }
  const [renewed] = await tx<ClaimRead[]>`
    update outbox_claims
    set lapses_at = ${lapseAfter(renew.at)}, first_try_at = coalesce(first_try_at, ${renew.at}),
        next_try_not_before = null, version = version + 1
    where outbox_row_id = ${outboxRowId} and claim_no = ${claim.claim_no} and version = ${claim.version}
    returning ${tx.unsafe(CLAIM_COLUMNS)}
  `;
  if (renewed === undefined) {
    throw new Error("renewClaim: the claim moved while its row was locked");
  }
  return {
    result: "renewed",
    outboxRowId,
    claim: claimOf(renewed),
    recipient: await phoneFlagsOf(tx, row.recipient_handle_id),
  };
}

/**
 * Renews the caller's claim just before a part goes, and reads the recipient's stop with it (K-05 v1.1 item 14, v1.2
 * item 32; README "The stop and the send"): one read committed transaction on the primary, on the runtime side. Pass
 * the client's primary handle, run as rosie_job. Answers renewed (the claim with lapsesAt at + 60 s, firstTryAt set
 * once, nextTryNotBefore cleared, and recipient: the phone's stopped and chat flags as this transaction read them,
 * FOR SHARE, or null with no phone row), claimLost, notYet, wrongState, notFound or transient. A stopped phone is no
 * refusal: limit 8 decides what goes (C-125). Throws for a request it cannot carry out; nothing is written then either.
 */
export async function renewClaim(sql: Sql, request: RenewClaimRequest): Promise<RenewClaimOutcome> {
  const checked = checkRenew(request);
  try {
    return await inRuntimeTransaction(sql, { readOnly: false }, (tx) => renewIn(tx, checked));
  } catch (error) {
    return transientOrScrubbed(RENEW_CLAIM, error);
  }
}

// ---- markPart (K-05 v1 item 4; v1.1 item 15 and v1.2 item 31 in markPartV12) ---------------------------------------------

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

/** The part a mark names: its row's id and its key, and whether a receipt found it by its key (v1.2 item 31). */
interface FoundPart {
  readonly rowId: string;
  readonly key: string;
  readonly receiptByKey: boolean;
}

interface PartFound {
  outbox_row_id: string;
  idempotency_key: string;
  linq_message_id: string | null;
}

/**
 * The part a mark names, found without a lock; null when no part holds the key or id. A receipt is found by its message
 * id, else (v1.2, with the key it echoes) by its key when the part under it holds no message id.
 */
async function findPart(tx: Sql, mark: MarkChecked): Promise<FoundPart | null> {
  if (mark.outcome !== "delivered") {
    const [found] = await tx<PartFound[]>`
      select outbox_row_id, idempotency_key, linq_message_id from outbox_parts where idempotency_key = ${mark.key}
    `;
    return found === undefined
      ? null
      : { rowId: found.outbox_row_id, key: found.idempotency_key, receiptByKey: false };
  }
  const [byMessage] = await tx<PartFound[]>`
    select outbox_row_id, idempotency_key, linq_message_id from outbox_parts
    where linq_message_id = ${mark.providerMessageId}
    order by try_no desc, part_no
    limit 1
  `;
  if (byMessage !== undefined) {
    return { rowId: byMessage.outbox_row_id, key: byMessage.idempotency_key, receiptByKey: false };
  }
  if (mark.key === null) {
    return null;
  }
  const [byKey] = await tx<PartFound[]>`
    select outbox_row_id, idempotency_key, linq_message_id from outbox_parts where idempotency_key = ${mark.key}
  `;
  if (byKey === undefined) {
    return null;
  }
  // A part under the key that holds another message id is not the receipt's (default 16).
  return byKey.linq_message_id === null
    ? { rowId: byKey.outbox_row_id, key: byKey.idempotency_key, receiptByKey: true }
    : null;
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

/** Holds the next try's Retry-After in the row's claim (K-05 v1.1 item 15; K-07 rule 6; default 18). */
async function holdNextTry(tx: Sql, rowId: string, notBefore: Date): Promise<void> {
  const [held] = await tx<{ claim_no: number }[]>`
    update outbox_claims set next_try_not_before = ${notBefore}, version = version + 1
    where outbox_row_id = ${rowId}
    returning claim_no
  `;
  if (held === undefined) {
    throw new Error("markPart: the row has no claim to hold its next try's Retry-After (default 18)");
  }
}

/** A mark's answer as v1 gives it, the row after the mark, which v1.1 adds to it, and what v1.9 says of a repeat. */
interface PartMarked {
  readonly answer: MarkPartResponse;
  readonly row: RowAfter;
  /** K-05 v1.9 item 48: the delivery a repeated receipt repeats; null on every other mark, and where it is not read. */
  readonly repeatedDelivery: RepeatedDelivery | null;
}

/**
 * The delivery a repeated delivery receipt repeats (K-05 v1.9 item 48), from the row's part tries as markPartIn holds
 * them, locked: `part` is the delivered part try the receipt names, `parts` every part try of its row. firstOfRow: no
 * other part try of the row, of either part and any try, holds a delivered_at earlier than this one's, a tie counting
 * as first (K-05 default 85). deliveredAt: this part try's delivered_at as stored, never the repeat's own time (default
 * 86). A delivered part try that holds no delivered_at is thrown, never answered by a guess (default 21 above): a
 * second guard, which K-04 v1.1's CHECK outbox_parts_delivered_has_time (migration 0032) makes unreachable on a
 * migrated database. Its code stays.
 */
function repeatedDeliveryOf(part: PartRow, parts: readonly PartRow[]): RepeatedDelivery {
  const deliveredAt = part.delivered_at;
  if (deliveredAt === null || parts.some((one) => one.state === "delivered" && one.delivered_at === null)) {
    throw new Error(
      "markPart: a delivered part holds no delivered_at, so the delivery a receipt repeats cannot be read",
    );
  }
  const firstOfRow = parts.every(
    (one) => one.delivered_at === null || one.delivered_at.getTime() >= deliveredAt.getTime(),
  );
  return { firstOfRow, deliveredAt: utc(deliveredAt) };
}

/**
 * One mark in the caller's transaction. `reads.repeatedDelivery`: whether a repeated delivery receipt's answer says
 * what it repeats (K-05 v1.9's markPartV12), or not (the v1 call, whose answer has no place for it).
 */
async function markPartIn(
  tx: Sql,
  mark: MarkChecked,
  reads: { readonly repeatedDelivery: boolean },
): Promise<PartMarked | MarkPartError> {
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
  if (
    mark.outcome === "delivered" &&
    found.receiptByKey &&
    part.linq_message_id !== null &&
    part.linq_message_id !== mark.providerMessageId
  ) {
    // Read again under the lock (default 16): the part under the key now holds another message id.
    return { error: "notFound", table: "outbox_parts", rowId: mark.providerMessageId };
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
    return {
      answer: marked(true, false, part.attempts, decision.repeat.nextKey),
      row: { state: row.state, version: row.version },
      // Only a delivery receipt says what it repeats (K-05 v1.9 item 48, default 87): a repeated sent or failure, null.
      // Nothing is written: the read is of the part tries this transaction already holds, locked.
      repeatedDelivery:
        reads.repeatedDelivery && mark.outcome === "delivered" ? repeatedDeliveryOf(part, parts) : null,
    };
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
      // A part found by its message id holds it already; one found by its key holds none and keeps the receipt's
      // (v1.2 item 31), so a later receipt finds it the first way.
      await tx`
        update outbox_parts
        set state = 'delivered', delivered_at = ${mark.at},
            linq_message_id = coalesce(linq_message_id, ${mark.providerMessageId}), version = version + 1
        where idempotency_key = ${part.idempotency_key} and state in ('sent', 'failed')
      `;
      break;
    case "failed":
      if (change.to === "failed") {
        // v1.1: the failure's message id, kept when the part holds none (default 17); v1 gives none.
        await tx`
          update outbox_parts
          set state = 'failed', failed_at = ${mark.at}, error_code = ${mark.errorCode},
              linq_message_id = coalesce(linq_message_id, ${mark.providerMessageId}), version = version + 1
          where idempotency_key = ${part.idempotency_key} and state in ('pending', 'sent')
        `;
      }
      if (nextKey !== null && change.nextTry !== null) {
        // Default 8: the next try goes plain, as words, under a new key (arch 01 line 65; arch 07 line 367).
        await tx`
          insert into outbox_parts (outbox_row_id, part_no, try_no, idempotency_key, attempts, kind, state)
          values (${row.id}, ${part.part_no}, ${change.nextTry}, ${nextKey}, 1, 'words', 'pending')
        `;
        if (mark.nextTryNotBefore !== null) {
          await holdNextTry(tx, row.id, mark.nextTryNotBefore);
        }
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
  return {
    answer: marked(false, firstDelivery, attempts, nextKey),
    row: { state: rowTo, version: moved.version },
    // A mark that records something repeats no delivery (K-05 v1.9 default 87).
    repeatedDelivery: null,
  };
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
    const marked = await inRuntimeTransaction(sql, { readOnly: false }, (tx) =>
      markPartIn(tx, checked, { repeatedDelivery: false }),
    );
    return "answer" in marked ? marked.answer : marked;
  } catch (error) {
    return transientOrScrubbed(MARK_PART, error);
  }
}

/**
 * K-05 v1.2's markPart (v1.1 item 15, v1.2 item 31): markPart, its answer carrying the row's state and version after
 * the mark; a failure's message id and Retry-After kept (the part's linq_message_id, the claim's next_try_not_before);
 * a receipt found by its part's key when no part holds its message id. From K-05 v1.9 (item 48; T-1227) its answer also
 * states repeatedDelivery on every mark: for a delivery receipt that repeats a recorded delivery, whether that delivery
 * was the row's first (no other part try of the row holds an earlier delivered_at; a tie counts as first) and its
 * stored delivered_at, read in this one transaction from the part tries it locks, with nothing written; null on every
 * other answer. firstDelivery stays false on a repeat. One transaction on the primary, on the runtime side; pass the
 * client's primary handle, run as rosie_job. Answers marked, notFound, wrongState or transient. Throws for a request it
 * cannot carry out (a safety line's followUps among them: default 19) and for a delivered part that holds no
 * delivered_at (default 21); nothing is written then either.
 */
export async function markPartV12(sql: Sql, request: MarkPartV12Request): Promise<MarkPartV12Outcome> {
  const checked = checkMarkPartV12(request);
  try {
    const marked = await inRuntimeTransaction(sql, { readOnly: false }, (tx) =>
      markPartIn(tx, checked, { repeatedDelivery: true }),
    );
    if (!("answer" in marked)) {
      return marked;
    }
    return {
      ...marked.answer,
      row: { ...marked.row },
      repeatedDelivery: marked.repeatedDelivery,
    } satisfies MarkPartV12Response;
  } catch (error) {
    return transientOrScrubbed(MARK_PART, error);
  }
}

// ---- markRow (K-05 v1 item 4: limit 8's outcomes; v1.1 item 16's waitingChat in markRowV12) -----------------------------

async function markRowIn<O extends MarkRowV12OutcomeName>(
  tx: Sql,
  mark: MarkRowChecked<O>,
): Promise<{ result: "marked"; outboxRowId: string; version: number; outcome: O } | MarkRowError> {
  const { outboxRowId } = mark;
  const [row] = await tx<{ state: RowState; version: number }[]>`
    select state, version from outbox_rows where id = ${outboxRowId} for update
  `;
  if (row === undefined) {
    return { error: "notFound", table: "outbox_rows", rowId: outboxRowId };
  }
  const to: RowState = MARKED_STATES_V12[mark.outcome];
  // Limit 8's outcomes start only from sending (K-07 rowMove): checked before the version, as K-05 v1.1 item 16 lists it.
  if (!rowMoveAllowed(row.state, to, "markRow")) {
    return wrongState("outbox_rows", outboxRowId, row.state);
  }
  if (row.version !== mark.expectVersion) {
    return versionChanged(outboxRowId, mark.expectVersion, row.version);
  }
  let marked: { version: number } | undefined;
  if (mark.outcome === "held") {
    [marked] = await tx<{ version: number }[]>`
      update outbox_rows set state = 'held', held_until = ${mark.heldUntil}, version = version + 1
      where id = ${outboxRowId} and version = ${mark.expectVersion} and state = 'sending'
      returning version
    `;
  } else if (mark.outcome === "stale") {
    [marked] = await tx<{ version: number }[]>`
      update outbox_rows set state = 'stale', plan = null, final_parts = null, version = version + 1
      where id = ${outboxRowId} and version = ${mark.expectVersion} and state = 'sending'
      returning version
    `;
  } else if (mark.outcome === "waitingChat") {
    // v1.1 item 16: the row waits with no clock and no held_until, and lets its claim go (K-07 default 11).
    [marked] = await tx<{ version: number }[]>`
      update outbox_rows set state = 'waiting_chat', held_until = null, version = version + 1
      where id = ${outboxRowId} and version = ${mark.expectVersion} and state = 'sending'
      returning version
    `;
    await tx`delete from outbox_claims where outbox_row_id = ${outboxRowId}`;
  } else {
    [marked] = await tx<{ version: number }[]>`
      update outbox_rows set state = ${to}, version = version + 1
      where id = ${outboxRowId} and version = ${mark.expectVersion} and state = 'sending'
      returning version
    `;
  }
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

/**
 * K-05 v1.2's markRow (v1.1 item 16): markRow, and waitingChat, which moves a sending row to waiting_chat, clears its
 * held_until and deletes its outbox_claims row (no clock, nothing sent); the other outcomes keep the claim row. One
 * transaction on the primary, on the runtime side; pass the client's primary handle, run as rosie_job. Answers as
 * markRow. Throws for a request it cannot carry out (held with no time, waitingChat with one); nothing is written then.
 */
export async function markRowV12(sql: Sql, request: MarkRowV12Request): Promise<MarkRowV12Outcome> {
  const checked = checkMarkRowV12(request);
  try {
    return await inRuntimeTransaction(sql, { readOnly: false }, (tx) => markRowIn(tx, checked));
  } catch (error) {
    return transientOrScrubbed(MARK_ROW, error);
  }
}
