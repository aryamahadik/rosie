// What the finalize call reads, calls and gives (C-093, T-313; K-09 v1 finalizeMessage; arch 02 line 123: "Code inserts
// its options and fixed lines and fills its slots, then the claim check runs limit 7 and the message checks. | One
// rewrite, told what failed. Fails again: the step's fallback text, Jay's reviewed one or else its master line with slots
// filled, through the same checks (DD). None passes: 'I've passed this on. Rosie's team will reply within 1 business
// day.' (S13-29; DD after S12-24); the question is withdrawn, so no clock arms (RULES 5.2), and the team is paged").
//
// K-09 v1's request and answer, K-03 v1's final parts and check result and K-05 v1's writePlan and cancelClock are the
// generated contract types (`npm run contracts:types`; ADR-005), reached through the Tool API's call types, so the call
// and the base read one shape. What code knows about the row, the fixed lines it carries (T-314), the two K-05 writes
// (T-196 builds the real repo) and the review item a passed-on message opens are ports, each another task's, so the call
// is tested with doubles and fails closed (notBuilt) while one is not built.

import type * as K05 from "../../../../contracts/generated/data-access/data-access.v1";
import type { AnswerOf, CallContext, ErrorsOf, RequestOf, ResponseOf } from "../../tool-api";
import type { CheckContext, CheckName } from "../checks";
import type { ClaimContext, Reader } from "../claim-check";
import type { SlotSource } from "../slots";

// ---- K-09 v1 finalizeMessage (contracts/tool-api), through the Tool API's call types --------------------------------

export type FinalizeRequest = RequestOf<"finalizeMessage">;
export type FinalizeResponse = ResponseOf<"finalizeMessage">;
/** K-09 v1 `finalizeMessage.errors`: each "Refused, nothing written". */
export type FinalizeError = ErrorsOf<"finalizeMessage">;
export type FinalizeAnswer = AnswerOf<"finalizeMessage">;
/** K-09 v1 `finalizeMessage.response.outcome`. */
export type FinalizeOutcome = FinalizeResponse["outcome"];

/** K-03 v1 `rowPlan`: the plan as the row will store it. */
export type RowPlan = FinalizeRequest["plan"];
/** K-03 v1 `plan`: the composer's structured output. */
export type Plan = RowPlan["plan"];
export type PlanLine = Plan["lines"][number];
export type PlanQuestion = NonNullable<Plan["question"]>;
/** K-03 v1 `finalParts`: the message after code, at most two sends. */
export type FinalParts = NonNullable<FinalizeResponse["finalParts"]>;
export type Send = FinalParts["sends"][number];
/** K-03 v1 `calendarFile`. */
export type CalendarFile = Send["calendarFile"];
/** K-03 v1 `channel`. */
export type Channel = FinalParts["channel"];
/** K-03 v1 `checkResult`: one attempt's checks and what happens next. */
export type CheckResult = FinalizeResponse["checks"][number];
export type CheckOutcome = CheckResult["checks"][number];
/** What was checked (K-03 v1 `checkResult.attempt`): the composer's plan, the one rewrite, or the step's fallback text. */
export type Attempt = CheckResult["attempt"];
/** What happens after one attempt (K-03 v1 `checkResult.outcome`). */
export type AttemptOutcome = CheckResult["outcome"];
/** K-07 v1 `rowState`, as K-09 v1's rowClosed names it. */
export type RowState = Extract<FinalizeError, { error: "rowClosed" }>["state"];

/** K-05 v1 `notFoundError`, as K-09 v1 answers it. */
export type NotFound = Extract<FinalizeError, { error: "notFound" }>;
/** K-05 v1 `transientError`: nothing read or written; the same request may be sent again. */
export type Transient = Extract<FinalizeError, { error: "transient" }>;

// ---- K-05 v1 writePlan and cancelClock (contracts/data-access) ------------------------------------------------------

/** K-05 v1 `writePlan.request`: the plan and the final parts, written together into the row (K-07 v1 planned to checked). */
export type WritePlanRequest = K05.WritePlanRequest;
/** K-05 v1 `writePlan.response` or one of its errors (`alreadyPlanned`: the row holds a plan, which stays). */
export type WritePlanAnswer = K05.WritePlanResponse | K05.WritePlanErrors;
/** K-05 v1 `cancelClock.request`: with `withdrawQuestion`, the question is withdrawn in the same transaction. */
export type CancelClockRequest = K05.CancelClockRequest;
export type CancelClockAnswer = K05.CancelClockResponse | K05.CancelClockErrors;

// ---- the review item a passed-on message opens (K-37 v1 review_items) ----------------------------------------------

/**
 * The review kind of a passed-on message. K-37 v1 `review_items.kind` and K-09 v1 `openReviewItem.kind` hold no kind for
 * it (K-37 README open gaps: a review the sources name beyond 02-contracts' K-37 row is a v1.1 change, a CHECK that only
 * widens), so this is the name proposed for that minor version; until it lands no real adapter can write it, and the port
 * runs on a fake repo (the card's "fake repo").
 */
export const PASSED_ON_REVIEW = "passed_on";

/**
 * K-09 v1 `openReviewItem.request` for a passed-on message: its caller, the outbox row as its subject (K-37 v1
 * subject_table, subject_row_id), and a summary in plain words with no value in it (K-37 v1 rule 4); the kind is the one
 * proposed above.
 */
export type PassedOnReview = Omit<RequestOf<"openReviewItem">, "kind"> & {
  readonly kind: typeof PASSED_ON_REVIEW;
};
/** K-09 v1 `openReviewItem.response` (the item and when the team's answer is due) or one of its errors. */
export type ReviewItemAnswer = ResponseOf<"openReviewItem"> | ErrorsOf<"openReviewItem">;

// ---- what code knows about the row ---------------------------------------------------------------------------------

/** The question the row asks, with its clock row, each at the version read (K-04 v1 open_questions, clock_rows). */
export interface QuestionClock {
  readonly openQuestionId: string;
  readonly openQuestionVersion: number;
  readonly clockRowId: string;
  readonly clockVersion: number;
}

/**
 * The row as the finalize call reads it, on the primary, uncached (K-09 v1 finalizeMessage.request: "the row, its slots'
 * values and the reader's audience"). Every value a person reads comes from here, never from the plan (rule 4).
 */
export interface FinalizeRow {
  readonly outboxRowId: string;
  /** The row's version now (K-04 v1 rule 2): the request's expectVersion must be it (limit 4 at the write). */
  readonly version: number;
  readonly state: RowState;
  readonly channel: Channel;
  /** The final parts the row holds, written with its plan; null while it holds none (K-07 v1 planned and stale). */
  readonly finalParts: FinalParts | null;
  /**
   * The fixed line code writes into this row word for word, or null: the guard's STOP, START and HELP replies (T-267), a
   * safety line, the outage line. Such a row is never composed nor finalized here (STATE note 17; T-267's security note
   * b: finalizeMessage never writes stopReply; K-09 v1 open gap 16).
   */
  readonly fixedLineId: string | null;
  /** The step whose line the row is (K-01 v1 stepId), named in a passed-on review item's summary. */
  readonly step: string;
  /** Who reads it, for limit 7 (K-03 v1 composeInput `audience.role`, through the claim check's readerOf). */
  readonly reader: Reader;
  /**
   * The rest of limit 7's context: the field each value was actually read from where it is not the slot's own (STATE note
   * 12: "T-313 names, in ClaimContext.fields, the field each value was actually read from"), and whether the relayed words
   * were read clear (RULES 4.5).
   */
  readonly claim: Omit<ClaimContext, "reader">;
  /** What the row's slots are filled from (T-310): the record and code facts for this reader. */
  readonly source: SlotSource;
  /**
   * What the message checks read beside the final parts (T-312): the bundle's shared lists, the reader's language and
   * name, the business, the step's options with their labels (code inserts them word for word: arch 07 line 361), the
   * options in msgtext.js's text form while the words carry them (arch 07 line 379), what this phone allows now, the
   * composer's facts and the step's master line.
   */
  readonly checks: CheckContext;
  /** The calendar file the row's booking carries when the plan picks one: new, move or cancel, or none (arch 07 line 383). */
  readonly calendarFile: CalendarFile;
  /** The step's fallback text: Jay's reviewed one, else its master line with its slots (arch 02 line 123); null if none. */
  readonly fallbackText: string | null;
  /** The question the row asks and its clock row, withdrawn on the passed-on path (RULES 5.2); null when it asks none. */
  readonly question: QuestionClock | null;
}

/** The row read: the row, or K-05's notFound or transient (nothing read). */
export type RowRead = FinalizeRow | NotFound | Transient;

// ---- the ports and what the call runs with -------------------------------------------------------------------------

/**
 * What the finalize call calls, each another task's:
 *   - readRow: the row as above (the Tool API turn face's read; K-05 has no call for it yet: K-05 v1.2's readTurnState
 *     reads turn state for the frontier, T-315 and T-557);
 *   - insertFixedLines: the fixed lines this row carries, added word for word to the parts code built, with their K-01 ids
 *     in `fixedLines` (arch 07 line 361: the opener, the opt-out line, the handling line, safety lines, checked terms;
 *     C-089, T-314);
 *   - writePlan: K-05 v1 writePlan (item 2), the plan and the final parts together (T-196 builds the real repo);
 *   - cancelClock: K-05 v1 cancelClock with withdrawQuestion (item 5: "the passed-on path: arch 02 line 123");
 *   - openReviewItem: one team review item for a passed-on message (K-37 v1 review_items; T-319 builds the service).
 * Each gets the call's context, so it runs inside the call's one transaction and business scope (the Tool API base), and
 * an error answer rolls everything back. Each throws FinalizeNotBuiltError until its task lands (notBuiltPorts), so the
 * call answers notBuilt and writes nothing (fail closed).
 */
export interface FinalizePorts<Repo = unknown> {
  readRow(outboxRowId: string, call: CallContext<Repo>): Promise<RowRead>;
  insertFixedLines(parts: FinalParts, row: FinalizeRow, call: CallContext<Repo>): Promise<FinalParts>;
  writePlan(request: WritePlanRequest, call: CallContext<Repo>): Promise<WritePlanAnswer>;
  cancelClock(request: CancelClockRequest, call: CallContext<Repo>): Promise<CancelClockAnswer>;
  openReviewItem(request: PassedOnReview, call: CallContext<Repo>): Promise<ReviewItemAnswer>;
}

/**
 * One line of what happened, in labels only: the row, the attempt, its outcome and the checks it missed, never a value,
 * a detail or a text's words (K-08 v1: "never the raw number or words"). A sendAndLog outcome is "sends and is logged"
 * (arch 07 line 417).
 */
export interface FinalizeNote {
  readonly row: string;
  readonly attempt: Attempt;
  readonly outcome: AttemptOutcome;
  readonly missed: readonly CheckName[];
}

/** What the finalize call runs with. */
export interface FinalizeDeps<Repo = unknown> {
  readonly ports: FinalizePorts<Repo>;
  /** Now, in UTC (RFC 3339 ending in Z): when a passed-on message's question is withdrawn (K-05 v1 cancelClock `at`). */
  readonly now: () => string;
  /** Told one note per attempt checked (FinalizeNote: labels only). */
  readonly log: (note: FinalizeNote) => void;
}
