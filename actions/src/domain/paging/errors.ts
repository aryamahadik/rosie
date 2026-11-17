// What the paging and hand-offs service refuses before anything is written (T-319; C-104): fail closed, nothing goes in
// the commit for it, and the call's transaction rolls back. A refusal K-09 v1 lists for the call (pageClosed,
// noRecipients, pointerMissing, notPaged, notTold, notTeam, alreadyDone, writeBackNotForKind, notFound, versionChanged) is
// an answer, not a throw; these are the cases K-09 has no answer for. Each names a rule and the rows at fault by id, never
// a person's words, a number or an address (K-08 v1: "Never the raw number or words").

export type PagingFault =
  /** A core action's caller is not the turn's own: another turn, or not a turn at all. */
  | "notTheTurn"
  /** A call whose caller is a turn rides in that turn's one commit, never made alone (arch 02 line 121). */
  | "turnRidesInCommit"
  /** The call runs under one business and names another (arch 10 line 546). */
  | "otherBusiness"
  /** The row a page or a hand-off points at is not there (K-36 v1 foreign keys: hand_offs, harm_reports, review_items). */
  | "pointerNotFound"
  /** namedPersonId is only for a hand_off page (K-36 v1 team_pages_named_only_for_hand_off). */
  | "namedOnlyForHandOff"
  /** A pointer given for a reason that points at nothing (K-36 v1 team_pages pointer CHECKs: null for the other reasons). */
  | "pointerNotForReason"
  /** A hand-off's page opened before its escalate_at (K-36 v1 hand_offs_escalated_when_due). */
  | "handOffNotDue"
  /** A repeat page whose page is not stored, or names another reason or pointer than the page (K-36 v1 team_pages). */
  | "notThePage"
  /** A repeat page fired by a clock row that is not one of the page's own (K-36 v1 team_pages.next_page_clock_row_id). */
  | "notThePagesClock"
  /** A repeat page of a page paged once (K-36 v1 team_pages.repeat_minutes null: it waits in the team console). */
  | "pageNotRepeating"
  /** A hand-off or its alert needs the business's owner (K-36 v1 hand_offs.told_person_id is not null). */
  | "noOwner"
  /** A clock row's due zone, a harm report's day or a review's business days need the business's zone (CQ-05). */
  | "noBusinessZone"
  /** A report about the owner or staff names the person it is about (K-34 v1 harm_reports_named_only_about_owner_or_staff). */
  | "harmReportNeedsNamedPerson"
  /** Who is told needs a business (K-36 v1 hand_offs.business_id is not null). */
  | "tellNeedsBusiness";

export class PagingRefusedError extends Error {
  readonly fault: PagingFault;
  /** The rows at fault, by id (never a value). */
  readonly rowIds: readonly string[];

  constructor(fault: PagingFault, rowIds: readonly string[] = []) {
    super(`paging refused: ${fault}`);
    this.name = "PagingRefusedError";
    this.fault = fault;
    this.rowIds = [...rowIds];
  }
}
