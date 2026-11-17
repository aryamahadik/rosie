// openReviewItem and decideReviewItem (T-319; C-104; K-09 v1; K-37 v1 review_items; Q-18): the team review queue, due
// within 1 business day (new work S1-03, control S1-75, a listing check S1-76, an owner's claim S11-52, a booking cap
// S12-28) or the same day (a harm report A3-49, a missed legal deadline S11-70), and the team's decision, which writes
// back to the row under review in the same commit (K-37 README: "What the decision changes ... is written to the row
// under review in its own part"): control proven by the team (K-23 business_setup.control_proven_at and
// control_proven_via team_check) and a new-work draft approved or kept offline (K-24 new_work_drafts.state). The kinds of
// later journeys write nothing back in K-09 v1. Only a person on Rosie's team decides (Q-18): a member live on K-36's
// recipient list (K-05 v1.13 personStanding's `team`).
//
// Defaults used (for ops/QUESTIONS.md), beside time.ts's 4 and 5:
//  18. A review item is keyed by the caller's request id with its kind and subject (K-09 v1: "the turn or request id is
//      the key"), so one turn may open items of two kinds and a repeat names the first.
//  19. Its due time is read in the business's zone (CQ-05), UTC for an item about no business or a business with no zone.
//  20. Who raised it: the caller's person for the steps an owner asks (new work, control, a listing check, an owner's
//      claim); null for those Rosie raises (a booking cap, a harm report, a missed deadline: K-37 raised_by_person_id
//      "Null when Rosie raised it"; a harm report never names its reporter here).
//  21. A done decision on control, a listing check or new work must write back (writeBackNotForKind with none): their
//      steps' safe default keeps the business offline until the row under review says otherwise. The row under review is
//      the item's subject: for control and a listing check a business_setup or businesses row, keyed by the business; for
//      new work its new_work_drafts row. The write-back has no K-08 kind (K-09 README open gap 1), so no entry is written
//      for it.
//  22. A decided item asked again with the same outcome answers repeated; with another, or a wait, alreadyDone.
//  29. The row a done decision writes back to belongs to the call's business, checked before any write (arch 10 line
//      546; the security reviewer's note c on round 1): the caller's business, else the item's. A row of another business,
//      or of none while the call has one, is refused (otherBusiness: nothing is written); with neither, nothing is
//      checked (Rosie's team on an item about no business). The business is read with the version the write compares.

import type { RowRef, StateWrite } from "../../commit";
import type { ErrorsOf, RequestOf, ResponseOf } from "../../tool-api";
import { PagingRefusedError } from "./errors";
import type { PagingPlan, PagingPorts } from "./page";
import type { ReviewKind, StoredReviewItem } from "./ports";
import { membersAt } from "./recipients";
import { endOfDay, isZone, nextBusinessDay } from "./time";
import { noPagingWrites, pagingEntry, type PagingWrites } from "./writes";

export type OpenReviewItemRequest = RequestOf<"openReviewItem">;
export type OpenReviewItemResponse = ResponseOf<"openReviewItem">;
export type OpenReviewItemError = ErrorsOf<"openReviewItem">;
export type OpenReviewItemAnswer = OpenReviewItemResponse | OpenReviewItemError;
export type DecideReviewItemRequest = RequestOf<"decideReviewItem">;
export type DecideReviewItemResponse = ResponseOf<"decideReviewItem">;
export type DecideReviewItemError = ErrorsOf<"decideReviewItem">;
export type DecideReviewItemAnswer = DecideReviewItemResponse | DecideReviewItemError;

/** The step each review kind comes from (K-37 v1 review_items.kind's sources). */
export const REVIEW_STEP: Readonly<Record<ReviewKind, string>> = {
  new_work: "S1-03",
  control: "S1-75",
  listing_match: "S1-76",
  owner_claim: "S11-52",
  booking_cap: "S12-28",
  harm_report: "A3-49",
  missed_deadline: "S11-70",
};

/** The kinds due the same day (A3-49 "today"; S11-70 "the same day"); every other within 1 business day. */
const SAME_DAY: readonly ReviewKind[] = ["harm_report", "missed_deadline"];

/** The kinds Rosie raises, which name no person who asked (default 20). */
const RAISED_BY_ROSIE: readonly ReviewKind[] = ["booking_cap", "harm_report", "missed_deadline"];

/** When the team's answer is due (K-37 v1 review_items.due_at; time.ts defaults 4 and 5). */
export function dueAtOf(kind: ReviewKind, openedAt: string, zone: string): string {
  return SAME_DAY.includes(kind) ? endOfDay(openedAt, zone) : nextBusinessDay(openedAt, zone);
}

/** A review item's key (default 18). */
export function reviewKeyOf(request: OpenReviewItemRequest): string {
  return JSON.stringify([
    request.caller.requestId,
    request.kind,
    request.subject?.table ?? null,
    request.subject?.rowId ?? null,
  ]);
}

// ---- openReviewItem -------------------------------------------------------------------------------------------------

/** One openReviewItem call: its request and the call's now. */
export interface OpenReviewItemCall {
  readonly request: OpenReviewItemRequest;
  readonly now: string;
}

/** The business's zone, UTC for none (default 19). */
async function zoneOf(businessId: string | null, ports: PagingPorts): Promise<string> {
  if (businessId === null) return "UTC";
  const zone = await ports.reader.businessZone(businessId);
  return zone !== null && isZone(zone) ? zone : "UTC";
}

/** Plans one openReviewItem call: the item, due by its kind's rule. Reads only. */
export async function planOpenReviewItem(
  call: OpenReviewItemCall,
  ports: PagingPorts,
): Promise<PagingPlan<OpenReviewItemAnswer>> {
  const { request, now } = call;
  const { kind, subject, caller } = request;
  const step = REVIEW_STEP[kind];
  const key = reviewKeyOf(request);
  const nothing = (answer: OpenReviewItemAnswer): PagingPlan<OpenReviewItemAnswer> => ({
    key,
    answer,
    writes: noPagingWrites(step),
  });
  const reviewItemId = await ports.ids.rowId("reviewItem", key);
  const stored = await ports.reader.reviewItem(reviewItemId);
  if (stored !== null) return nothing({ reviewItemId, dueAt: stored.dueAt, repeated: true });
  // The row under review exists (K-37 rule 5, kept by code).
  if (subject !== null && (await ports.reader.row(subject.table, subject.rowId)) === null) {
    return nothing({ error: "notFound", table: subject.table, rowId: subject.rowId });
  }

  const dueAt = dueAtOf(kind, now, await zoneOf(caller.businessId, ports));
  const values = {
    kind,
    business_id: caller.businessId,
    subject_table: subject?.table ?? null,
    subject_row_id: subject?.rowId ?? null,
    turn_id: caller.turnId,
    raised_by_person_id: RAISED_BY_ROSIE.includes(kind) ? null : caller.personId,
    summary: request.summary,
    opened_at: now,
    due_at: dueAt,
    state: "open",
  };
  return {
    key,
    answer: { reviewItemId, dueAt, repeated: false },
    writes: {
      ...noPagingWrites(step),
      state: [{ op: "insert", table: "review_items", values: { id: reviewItemId, ...values } }],
      stateEvents: [
        pagingEntry({
          kind: "review_item.opened",
          move: "opened",
          table: "review_items",
          rowId: reviewItemId,
          businessId: null,
          actor: null,
          old: null,
          new: values,
          step,
        }),
      ],
    },
  };
}

// ---- decideReviewItem -----------------------------------------------------------------------------------------------

/** One decideReviewItem call: its request and the call's now. */
export interface DecideReviewItemCall {
  readonly request: DecideReviewItemRequest;
  readonly now: string;
}

type Decision = DecideReviewItemRequest["decision"];
type Done = Extract<Decision, { state: "done" }>;

/** The row a done decision writes back to, and how; null when its kind writes nothing back (default 21). */
interface WriteBack {
  readonly table: "business_setup" | "new_work_drafts";
  readonly key: Record<string, string>;
  readonly rowId: string;
  /** Column to new value; null when the decision writes nothing there (control not proven). */
  readonly set: Record<string, unknown> | null;
}

/** The write-back a done decision makes for its item, or "refused" when it does not fit the item (default 21). */
function writeBackOf(item: StoredReviewItem, decision: Done, now: string): WriteBack | null | "refused" {
  const back = decision.writeBack;
  const subject = item.subjectTable === null || item.subjectRowId === null ? null : item.subjectRowId;
  switch (item.kind) {
    case "control":
    case "listing_match": {
      if (back?.table !== "business_setup" || subject === null) return "refused";
      if (item.subjectTable !== "business_setup" && item.subjectTable !== "businesses") return "refused";
      if (item.businessId !== null && item.businessId !== subject) return "refused";
      return {
        table: "business_setup",
        key: { business_id: subject },
        rowId: subject,
        set: back.controlProven ? { control_proven_at: now, control_proven_via: "team_check" } : null,
      };
    }
    case "new_work": {
      if (back?.table !== "new_work_drafts" || subject === null) return "refused";
      if (item.subjectTable !== "new_work_drafts") return "refused";
      // The draft's business is read with its version and checked against the call's before any write (default 29).
      return { table: "new_work_drafts", key: { id: subject }, rowId: subject, set: { state: back.state } };
    }
    default:
      return back === null ? null : "refused";
  }
}

/** Plans one decideReviewItem call: done with its write-back, or waiting until a time. Reads only. */
export async function planDecideReviewItem(
  call: DecideReviewItemCall,
  ports: PagingPorts,
): Promise<PagingPlan<DecideReviewItemAnswer>> {
  const { request, now } = call;
  const { decision, caller } = request;
  const key = `decide:${request.reviewItemId}`;
  const nothing = (answer: DecideReviewItemAnswer, step: string): PagingPlan<DecideReviewItemAnswer> => ({
    key,
    answer,
    writes: noPagingWrites(step),
  });

  // Only a person on Rosie's team decides (Q-18): a member live on the list now.
  const personId = caller.personId;
  const team = membersAt(await ports.reader.members(), now);
  if (personId === null || !team.some((member) => member.personId === personId)) {
    return nothing({ error: "notTeam" }, "S1-03");
  }
  const item = await ports.reader.reviewItem(request.reviewItemId);
  if (item === null) {
    return nothing({ error: "notFound", table: "review_items", rowId: request.reviewItemId }, "S1-03");
  }
  const step = REVIEW_STEP[item.kind];
  if (caller.businessId !== null && item.businessId !== null && caller.businessId !== item.businessId) {
    throw new PagingRefusedError("otherBusiness", [item.id]);
  }
  if (item.state === "done") {
    return decision.state === "done" && decision.outcome === item.outcome
      ? nothing({ state: "done", decidedAt: item.decidedAt, written: [], repeated: true }, step)
      : nothing({ error: "alreadyDone", reviewItemId: item.id }, step);
  }
  if (item.version !== request.expectVersion) {
    return nothing(
      {
        error: "versionChanged",
        changed: [
          {
            table: "review_items",
            rowId: item.id,
            readVersion: request.expectVersion,
            currentVersion: item.version,
          },
        ],
      },
      step,
    );
  }

  const itemWritten: RowRef = { table: "review_items", rowId: item.id, version: item.version + 1 };
  if (decision.state === "waiting") {
    const set = { state: "waiting", wait_until: decision.waitUntil };
    return {
      key,
      answer: { state: "waiting", decidedAt: null, written: [itemWritten], repeated: false },
      writes: decisionWrites(item, set, personId, step, "review_item.waiting", "waiting", null),
    };
  }

  const back = writeBackOf(item, decision, now);
  if (back === "refused") return nothing({ error: "writeBackNotForKind", kind: item.kind }, step);
  const set = { state: "done", decided_at: now, decided_by_person_id: personId, outcome: decision.outcome };
  const written: RowRef[] = [itemWritten];
  let backWrite: StateWrite | null = null;
  if (back !== null && back.set !== null) {
    const row = await ports.reader.row(back.table, back.rowId);
    if (row === null) return nothing({ error: "notFound", table: back.table, rowId: back.rowId }, step);
    // The row written back to is the call's business's, before any write (default 29): a new-work draft of another
    // business, or a business's setup other than the caller's, is refused with nothing written.
    const scope = caller.businessId ?? item.businessId;
    if (scope !== null && row.businessId !== scope) {
      throw new PagingRefusedError("otherBusiness", [item.id, back.rowId]);
    }
    backWrite = { op: "update", table: back.table, key: back.key, expectVersion: row.version, set: back.set };
    written.push({ table: back.table, rowId: back.rowId, version: row.version + 1 });
  }
  return {
    key,
    answer: { state: "done", decidedAt: now, written, repeated: false },
    writes: decisionWrites(item, set, personId, step, "review_item.decided", "decided", backWrite),
  };
}

/** A decision's writes: the item's update and its entry (team only), then the write-back with no entry (default 21). */
function decisionWrites(
  item: StoredReviewItem,
  set: Record<string, unknown>,
  personId: string,
  step: string,
  kind: "review_item.waiting" | "review_item.decided",
  move: string,
  backWrite: StateWrite | null,
): PagingWrites {
  return {
    ...noPagingWrites(step),
    state: [
      { op: "update", table: "review_items", key: { id: item.id }, expectVersion: item.version, set },
      ...(backWrite === null ? [] : [backWrite]),
    ],
    stateEvents: [
      pagingEntry({
        kind,
        move,
        table: "review_items",
        rowId: item.id,
        businessId: null,
        actor: { personId, role: null },
        old: { state: item.state },
        new: { ...set, business_id: item.businessId },
        step,
      }),
    ],
  };
}
