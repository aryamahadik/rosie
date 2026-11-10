// Limit 4, Versions (C-084, T-302; arch 06 line 305; arch 01 line 85 "Version: an integer on each shared row that every
// update raises. Commits compare and set it"; arch 10 line 506 "Versions and compare-and-set on bookings, quotes, open
// questions and schedules: two people can act on one booking from two chats"; C-179, arch 11 line 574 "Two people change
// one booking at once: limit 4's outcome"). It passes on "compare-and-set on every row the read-back showed"; on a failure
// it reloads once: "Nothing shown changed: commit. Changed but still possible: today's facts and a fresh yes. No longer
// possible: say what changed and offer the current choices. A second conflict on one question: a person." (K-09 v1
// limit4Outcome: freshYes is ask, saidWhatChanged refuse, toPerson wait.)
//
// For one gated part, in this order:
//   1. What it applies to: a choose of an option of an open question (K-02 v1 choice kind option). That question's row
//      holds what the read-back showed: versions_read (K-04 v1 open_questions; K-05 v1.2 openQuestionRead). Any other part
//      (pass_on, hand_off, a hub case, a which-booking pick, an any-time row, a door, a search entry) was shown no
//      read-back: notChecked; but the sign-up door passes, with nothing to compare and set (default 6).
//   2. The question, live on the turn's handle. One no longer live there (answered, defaulted or withdrawn since) is no
//      longer possible: say what changed (saidWhatChanged, questionClosed). A call with no turn (a secure page, an own
//      AI, a job) has no handle to read it on: what a page or a bound token showed is K-21's and T-328's, neither built,
//      so limit 4 answers notBuilt and the gate refuses the whole call (fail closed).
//   3. The reload: every row the question showed (limit 5's rows aside, below), read again now. None moved: pass. The
//      commit then compares and sets every one of them at the version shown (`compareAndSet`, K-05 v1 versionsRead; the
//      walk hands them to the commit: the commit's writesOf), so a commit made between this read and the commit is refused
//      with the rows that changed (K-05 v1 versionChanged), and the commit gates once more (T-305 GATE_RUNS: "reloads once
//      and gates again"), where this limit reloads again. A conflict on a row the read-back never showed leaves every
//      shown row as it was: nothing shown changed, so the part commits on that second run.
//   4. Something shown moved (another version, or the row is gone):
//        - a question already asked again (ask count 2 or more: its fresh yes went out) has had its conflict: this second
//          conflict on one question goes to a person (toPerson), with a review item; never a third try;
//        - else, no longer possible (a row shown is gone, or the part's booking is done, cancelled or gone): say what
//          changed and offer the current choices (saidWhatChanged);
//        - else, still possible: today's facts and a fresh yes (freshYes), the same question asked again (ask count one
//          more) from today's versions.
// What an outcome writes (the fresh yes, what changed, the review item) is the commit's (K-09 v1 limitNOutcome; T-305
// default 8): decideVersions says what, and the limit hands the gate its K-09 outcome.
//
// Nothing here logs. What it returns names labels, steps, tables, row ids and versions: never a person's words, phone
// number or name (K-08 v1 README line 75).
//
// Defaults used (for ops/QUESTIONS.md):
//   1. "Every row the read-back showed" is the question's versions_read, a question with no read-back included (its rows
//      are those it was decided on). A question with none passes: there is nothing to compare, as K-09 v1's fixtures state
//      limit 4 passing on S1-02's and A4-14's answers. "Changed" is per row: a version that moved is a change, whatever
//      column moved it, since K-04 v1 keeps no copy of the values a read-back showed to compare them with.
//   2. Reservations and class seats are limit 5's (arch 06 line 307; T-303 handoff 4): a reservations or class_seats row
//      the question showed is never compared here, nor sent to be compared, so a saved time that lapsed or was taken
//      answers limit 5's next open times, never a fresh yes; its confirm carries its own version (K-05 v1 item 1).
//   3. A second conflict on one question: the fresh yes is the same question asked again, so a conflict on a question
//      asked twice or more (K-04 v1 ask_count, the larger of the row's and the context's, as limit 3 reads it) is the
//      second. A question asked again for another reason (limit 3's fresh read-back) also goes to a person: never a
//      third ask of one question. A second conflict goes to a person even when the change also rules the part out.
//   4. Still possible unless a row shown is gone or the part's booking (its choice's target, else the question's) is done,
//      cancelled or gone: K-04 v1 holds no other rule of what a change rules out. A refinement (a branch gate read on
//      today's facts, T-292) changes this rule.
//   5. The review item is the team review queue's (K-37 v1 review_items: "each thing the sources send to a person on
//      Rosie's team"), its subject the question; K-37 v1 and K-09 v1 openReviewItem name no kind for it (QUESTIONS.md).
//   6. T-1183 (DL-364): K-02 v1.1's sign-up door (its default 9), on no booking, passes, as K-09 v1.5's commit-s1-01.json
//      and K-08 v1's trace-skeleton.json log it (ADR-013 section 2). Its walk (S1-01's thread, then S1-02's question and
//      its outbox row) only inserts rows new in the turn and reads no version (the fixture's stated writes: versionsRead
//      empty), so compare-and-set on every row it was shown holds with none to compare: nothing shown changed, so it
//      commits (arch 06 line 305), with no row to compare and set and nothing read. Every other door, and a sign-up door
//      that names a booking (not the door K-02 v1.1 shapes), stays notChecked as before (step 1).

import type { Choice, Context, GatePart, GateTurn, LimitOutcomes } from "../framework";
import type { AskedQuestion, QuestionReader, RowRef } from "../limit-3/facts";
import type { BookingStage, TodayReader } from "./facts";

/** Limit 4's outcomes when it fails (K-09 v1 limit4Outcome). */
export type Limit4Outcome = LimitOutcomes[4];

/** Changed but still possible: today's facts and a fresh yes (K-09 v1: ask). */
export function freshYesOutcome(): Limit4Outcome {
  return { limit: 4, outcome: "ask", action: "freshYes" };
}

/** No longer possible: say what changed and offer the current choices (K-09 v1: refuse). */
export function saidWhatChangedOutcome(): Limit4Outcome {
  return { limit: 4, outcome: "refuse", action: "saidWhatChanged" };
}

/** A second conflict on one question: a person (K-09 v1: wait). */
export function toPersonOutcome(): Limit4Outcome {
  return { limit: 4, outcome: "wait", action: "toPerson" };
}

/** A question asked this many times has had its fresh yes: a conflict on it now goes to a person (default 3). */
export const ASKS_BEFORE_PERSON = 2;

/** The tables whose rows are limit 5's, never compared here (default 2). */
export const RESERVED_TABLES: readonly string[] = ["reservations", "class_seats"];

/** The stages a booking no longer changes from (K-04 v1 bookings.stage; K-05 v1.2 sendState closed). */
export const CLOSED_STAGES: readonly BookingStage[] = ["done", "cancelled"];

/** A row the question showed that moved since: its version then, and now (null: gone, or out of the call's scope). */
export interface ChangedRow {
  readonly table: string;
  readonly rowId: string;
  readonly readVersion: number;
  readonly currentVersion: number | null;
}

/** Why a change rules the part out: a label, never words. */
export type NotPossibleWhy =
  /** The question the part answers is no longer live on this handle. */
  | "questionClosed"
  /** A row the question showed, or the part's booking, no longer exists for this call. */
  | "rowGone"
  /** The part's booking is done or cancelled. */
  | "bookingClosed";

/** Today's facts and a fresh yes: the same question asked again, from today's versions. */
export interface FreshYes {
  readonly kind: "freshYes";
  readonly openQuestionId: string;
  readonly step: string;
  readonly bookingId: string | null;
  /** The fresh yes's ask count: one more than the question's, so a conflict after it goes to a person. */
  readonly askCount: number;
  readonly changed: readonly ChangedRow[];
  /** The rows the question showed, at their versions today: what the fresh yes is built from. */
  readonly versionsToday: readonly RowRef[];
}

/** Say what changed and offer the current choices. */
export interface SaidWhatChanged {
  readonly kind: "saidWhatChanged";
  readonly openQuestionId: string;
  readonly step: string;
  readonly bookingId: string | null;
  readonly why: NotPossibleWhy;
  readonly changed: readonly ChangedRow[];
}

/** The team review item a second conflict opens (K-37 v1 review_items; default 5). */
export interface ReviewItem {
  /** The row under review: the question the two conflicts were on (K-37 v1 subject_table, subject_row_id). */
  readonly subject: { readonly table: "open_questions"; readonly rowId: string };
  readonly businessId: string;
  readonly bookingId: string | null;
  readonly step: string;
}

/** A second conflict on one question: a person, never a third try. */
export interface ToPerson {
  readonly kind: "toPerson";
  readonly openQuestionId: string;
  readonly step: string;
  readonly bookingId: string | null;
  readonly changed: readonly ChangedRow[];
  readonly review: ReviewItem;
}

export type VersionsDecision =
  /** Nothing shown changed: the commit compares and sets these rows at the versions shown. */
  | { readonly result: "pass"; readonly compareAndSet: readonly RowRef[] }
  | { readonly result: "notChecked" }
  /** A call with no turn: what its page or token showed is not built (step 2). */
  | { readonly result: "notBuilt" }
  | {
      readonly result: "fail";
      readonly outcome: Limit4Outcome;
      readonly next: FreshYes | SaidWhatChanged | ToPerson;
    };

/** What the rule reads, made only when it needs them. */
export interface VersionsPorts {
  readonly questions: () => QuestionReader;
  readonly today: () => TodayReader;
}

type ContextQuestion = Context["openQuestions"][number];

const NOT_CHECKED: VersionsDecision = { result: "notChecked" };
const NOT_BUILT: VersionsDecision = { result: "notBuilt" };

const rowKey = (table: string, rowId: string): string => JSON.stringify([table, rowId]);

/**
 * The rows the commit compares and sets for an answer to `question` (step 3): each row it showed, once at the version
 * shown, limit 5's rows left out (default 2). The walk sends them with the part's writes (K-05 v1 versionsRead).
 */
export function compareAndSetOf(question: AskedQuestion): RowRef[] {
  const seen = new Set<string>();
  const rows: RowRef[] = [];
  for (const row of question.versionsRead) {
    if (RESERVED_TABLES.includes(row.table)) continue;
    const key = JSON.stringify([row.table, row.rowId, row.version]);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ table: row.table, rowId: row.rowId, version: row.version });
  }
  return rows;
}

/** The rows shown that moved: another version now, or gone (left out of today's read). */
export function changedRows(shown: readonly RowRef[], today: readonly RowRef[]): ChangedRow[] {
  const now = new Map(today.map((row) => [rowKey(row.table, row.rowId), row.version]));
  const changed: ChangedRow[] = [];
  for (const row of shown) {
    const current = now.get(rowKey(row.table, row.rowId)) ?? null;
    if (current !== row.version) {
      changed.push({ table: row.table, rowId: row.rowId, readVersion: row.version, currentVersion: current });
    }
  }
  return changed;
}

/** K-02 v1.1's sign-up door on no booking (default 6): its commit inserts new rows only and compares none. */
function isSignUpDoor(choice: Choice | null): boolean {
  return (
    choice !== null && choice.kind === "door" && choice.door === "signUp" && choice.target.bookingId === null
  );
}

/** The open question a part answers: a choose of one of its options; null for any other part (step 1). */
function questionOf(part: GatePart): string | null {
  const { part: said, choice } = part;
  if (said.verb !== "choose") return null;
  if (choice === null) throw new TypeError("limit 4 got a choose part without its offered choice");
  return choice.kind === "option" ? choice.question : null;
}

/** The question as limit 4 reads it: live on `handleId`, or null. */
async function liveOn(
  ports: VersionsPorts,
  handleId: string,
  questionId: string,
): Promise<AskedQuestion | null> {
  const found = await ports.questions().liveQuestion(handleId, questionId);
  return found !== null && found.handleId === handleId ? found : null;
}

/** Why today's facts rule the part out, or null while it is still possible (default 4). */
async function whyNotPossible(
  changed: readonly ChangedRow[],
  bookingId: string | null,
  ports: VersionsPorts,
): Promise<NotPossibleWhy | null> {
  if (changed.some((row) => row.currentVersion === null)) return "rowGone";
  if (bookingId === null) return null;
  const booking = await ports.today().booking(bookingId);
  if (booking === null) return "rowGone";
  return CLOSED_STAGES.includes(booking.stage) ? "bookingClosed" : null;
}

/** The rows shown at today's versions: the unchanged as shown, the changed at their version now. */
function versionsToday(shown: readonly RowRef[], changed: readonly ChangedRow[]): RowRef[] {
  const moved = new Map(changed.map((row) => [rowKey(row.table, row.rowId), row.currentVersion]));
  return shown.flatMap((row) => {
    const key = rowKey(row.table, row.rowId);
    if (!moved.has(key)) return [{ ...row }];
    const now = moved.get(key) ?? null;
    return now === null ? [] : [{ table: row.table, rowId: row.rowId, version: now }];
  });
}

interface Answered {
  readonly choice: Choice;
  readonly openQuestionId: string;
  /** The question as the context lists it (decide's frontier), if any. */
  readonly asked: ContextQuestion | undefined;
}

/** The booking the part acts on: its choice's target, else the question's. */
function bookingOf(answered: Answered, question: AskedQuestion | null): string | null {
  return answered.choice.target.bookingId ?? question?.bookingId ?? answered.asked?.target.bookingId ?? null;
}

/** Limit 4 on one agreed part: pass, notChecked, notBuilt, or the failure with what the commit runs next. */
export async function decideVersions(
  part: GatePart,
  turn: GateTurn,
  ports: VersionsPorts,
): Promise<VersionsDecision> {
  // 1. What it applies to; the sign-up door passes with nothing to compare (default 6).
  const openQuestionId = questionOf(part);
  if (openQuestionId === null || part.choice === null) {
    return isSignUpDoor(part.choice) ? { result: "pass", compareAndSet: [] } : NOT_CHECKED;
  }
  const answered: Answered = {
    choice: part.choice,
    openQuestionId,
    asked: turn.context.openQuestions.find((question) => question.openQuestionId === openQuestionId),
  };

  // 2. The question, live on the turn's handle.
  const handleId = turn.request.turn?.handleId;
  if (handleId === undefined) return NOT_BUILT;
  const question = await liveOn(ports, handleId, openQuestionId);
  const step = question?.step ?? answered.asked?.step ?? answered.choice.step;
  const bookingId = bookingOf(answered, question);
  if (question === null) {
    return {
      result: "fail",
      outcome: saidWhatChangedOutcome(),
      next: { kind: "saidWhatChanged", openQuestionId, step, bookingId, why: "questionClosed", changed: [] },
    };
  }

  // 3. The reload: every row it showed, read again now.
  const shown = compareAndSetOf(question);
  const today = shown.length === 0 ? [] : await ports.today().currentVersions(shown);
  const changed = changedRows(shown, today);
  if (changed.length === 0) return { result: "pass", compareAndSet: shown };

  // 4. Something shown moved: a person on a second conflict, else what changed, else a fresh yes.
  const askCount = Math.max(question.askCount, answered.asked?.askCount ?? 0);
  if (askCount >= ASKS_BEFORE_PERSON) {
    return {
      result: "fail",
      outcome: toPersonOutcome(),
      next: {
        kind: "toPerson",
        openQuestionId,
        step,
        bookingId,
        changed,
        review: {
          subject: { table: "open_questions", rowId: openQuestionId },
          businessId: turn.businessId,
          bookingId,
          step,
        },
      },
    };
  }
  const why = await whyNotPossible(changed, bookingId, ports);
  if (why !== null) {
    return {
      result: "fail",
      outcome: saidWhatChangedOutcome(),
      next: { kind: "saidWhatChanged", openQuestionId, step, bookingId, why, changed },
    };
  }
  return {
    result: "fail",
    outcome: freshYesOutcome(),
    next: {
      kind: "freshYes",
      openQuestionId,
      step,
      bookingId,
      askCount: askCount + 1,
      changed,
      versionsToday: versionsToday(shown, changed),
    },
  };
}
