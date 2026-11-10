// What the safety service refuses before anything is written (T-318; C-104): fail closed, nothing goes in the commit for
// it, and the call's transaction rolls back. A refusal K-09 v1 lists for the call (notFound, neverReleased, stillDanger,
// wrongRule, notAllowed, versionChanged) is an answer, not a throw; these are the cases K-09 has no answer for. Each
// names a rule and the rows at fault by id, never a person's words, a number or an address (K-08 v1: "Never the raw
// number or words"). While a refused record fails the turn, the handle actor keeps its own hold and sends the checked
// line itself (runtime/src/safety/types.ts SafetyCore: a throw counts as the core not answering).

export type SafetyFault =
  /** A text's outcome rides in the commit of the turn its text joins (K-34 v1 safety_outcomes_text_has_handle_and_turn). */
  | "textNeedsTurn"
  /** A core action's caller is not the turn's own: another turn, or not a turn at all. */
  | "notTheTurn"
  /** A text's event is not one of the turn's texts, or came from another handle than the turn's. */
  | "notTheTurnsText"
  /** The call runs under one business and names another (arch 10 line 546). */
  | "otherBusiness"
  /** A text's outcome names no handle (K-34 v1: required for a text). */
  | "textNeedsHandle"
  /** A danger outcome whose step must send its checked line, with no line for it in the bundle (A3-22: never silent). */
  | "noSafetyLine"
  /**
   * The line goes with the danger question (a label of unknown tense, arch 06 line 329), and the pinned bundle holds no
   * words for K-01's safetyAsk: the line never goes without it (fail closed, as finalize's inserter refuses such a row:
   * T-1164's lineNotInBundle; T-1176, CQ-172).
   */
  | "noSafetyAsk"
  /** The checked line has nobody to go to: no row could be built for its recipient (MC C9), or no owner to tell (A3-48). */
  | "safetyLineNotBuilt"
  /**
   * A harm report names the business it came from (K-34 v1 harm_reports.business_id is not null). Filed only with the
   * hotline its line gives: with none in the pinned bundle the record sends 911 and files no report, never refused for
   * want of a hotline (record.ts default 10; CQ-164 (c)).
   */
  | "harmReportNeedsBusiness"
  /** A booking_private release whose booking is not private yet (A3-50: "Once the booking is made private"). */
  | "bookingNotPrivate"
  /** A threat's pause T-317 refused with an answer K-09 v1 lists no record error for: never dropped (record.ts default 17). */
  | "pauseRefused";

export class SafetyRefusedError extends Error {
  readonly fault: SafetyFault;
  /** The rows at fault, by id (never a value). */
  readonly rowIds: readonly string[];

  constructor(fault: SafetyFault, rowIds: readonly string[] = []) {
    super(`safety refused: ${fault}`);
    this.name = "SafetyRefusedError";
    this.fault = fault;
    this.rowIds = [...rowIds];
  }
}
