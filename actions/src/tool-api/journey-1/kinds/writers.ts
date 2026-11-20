// S1-02's, S1-03's and S1-74's read-only step writers (T-633; DL-961 ruling 2; DL-988; DL-994; T-1461's StepWriter,
// actions/src/commit/walk/writes.ts): what each of the three steps writes when the walk walks it on S1-02's answer. Card F
// binds them by step id into the turn face (turn-face/commit.ts createWritesOf); nothing binds them here. A writer never
// writes: it reads, then returns StepRows, and the commit writes what writesOf returns. The walk calls them in its order:
// S1-02's (the answered split: its gives) first, then the chosen branch's own step (S1-03 or S1-74).
//
//   S1-02  answer.ts: the owner's words read by T-632's matcher over item 78's catalog, kept under the chosen branch as
//          K-24 picked_kinds rows (a drafted kind's kinds row before its new_work pick), numbered after item 79's picks;
//          gives `kinds` unless every part is not booked. commit-s1-02.json's "All on the list": three listed picks.
//   S1-03  for each new_work pick S1-02's writer wrote in the same run, its draft (K-24 new_work_drafts, state drafting,
//          no business), then its message to the owner. It opens no review item and needs no paging port: the checklist
//          has not been asked when the walk reaches S1-03, so the draft is `drafting` (K-24 v1 new_work_drafts.state), and
//          the drafted kind stays offline (S1-02's safe default) while setup goes on at once (the branch rejoins at S1-11).
//   S1-74  its message to the owner, and nothing else: no kind (S1-02's writer keeps the words not_booked, with no kind),
//          and the path ends with its branch's end text (the walk's).
//
// The review item's plan (newWorkReviewPlan) is its own exported function, for the later card that saves the checklist
// (K-09 SetupS1_03's save): one team review item per draft through T-319's openReviewItemCore (K-37 review_items, kind
// new_work, subject the draft, due within 1 business day: Q-18) and that draft moved to in_review in the same rows. The
// team decides the item with decideReviewItemAlone from its console, which writes the draft's state back (approved, or
// kept offline). No writer here calls it.
//
// A message to the owner (S1-03's, S1-74's) is one quick reply to the turn's own handle and person, on the turn's service,
// with no plan (words go in after the commit: arch 01 line 41), written only when the stop home lets Rosie text: the owner
// is read with readStop (homes/stop, T-590) on the stop reads the binding gives (the runtime side's: rosie_app reads no
// handles, person_handles or phones, DL-982), and mayText rules (DL-878's handoff 1). "noTexts" writes no row; the step's
// other rows are written.
//
// Each writer reads only through its deps (item 78 on the Tool API's client and item 79 on the runtime side, each in its
// own read-only transaction: reads.ts; the stop reads), each read awaited before the next, never side by side, and never
// on the call's transaction, which it is handed and never uses. Nothing here logs; what it throws names faults, steps and
// codes (errors.ts).
//
// Defaults used (for ops/QUESTIONS.md), beside answer.ts's:
//   8. S1-03's writer drafts each new_work pick of the answer in the walk's order, each in state `drafting`, and one
//      message tells the owner, once for the step. No review item opens at the walk (DL-994 item 1): K-24 v1 names
//      `drafting` "the owner is still answering the checklist" and `in_review` "sent to Rosie's team (K-37's review item
//      is open)", and K-05 v1.19 words the same order ("its draft (drafting, then in_review)"); the review opens with the
//      checklist's save, through newWorkReviewPlan.
//   9. The draft has no business, as its pick (answer.ts default 4; new_work_drafts_pick_business_fk holds it to the
//      pick's), and its review item names none either (the item's caller names no business: K-09 caller.businessId "Null
//      only where no business exists yet"), so the team's decision may write back to the draft (T-319 review.ts default 29
//      compares the row's business with the item's), and the item is due by the next business day in UTC (review.ts
//      default 19).
//  10. newWorkReviewPlan is handed each draft's row id and the version it was read at (item 79's draft read), and moves
//      that draft to in_review at that version in the same rows as its item, the item's insert first, so a draft that
//      moved since is refused by the commit (limit 4). openReviewItem's check that the subject exists (K-37 rule 5, kept
//      by code) reads the draft through the bound reader: it is on file by then. A draft whose item is already on file (a
//      repeat) plans no row, and a draft named twice is planned once.
//  11. The review item's summary names the step and what the team checks, with no private value (K-37 v1: "without private
//      values"): never the owner's words, which the item's entry would carry into the event log (T-319 review.ts puts the
//      summary in review_item.opened's new values); Rosie's team reads the draft's words through its console (K-05 v1.19
//      default 176).
//  12. mayText rules the message for the call's business (the outbox row's), on the turn's own handle, as a quick reply
//      (K-09 v1.5 default 133), the turn texting in when its decided texts hold a text. optOutLine has no field in the
//      outbox row: finalize decides the opt-out line from the same phones row when it writes the words
//      (finalize/fixed-lines/insert.ts), so the writers rule mayText alone.
//  13. S1-74 opens no review item: K-37 has no kind for work Rosie never books (K-24 open gap "'Not a service we book' in
//      the team's queue"), so the team sees the owner's words on the not_booked picks S1-02's writer keeps.
//  16. The change home (S13-56; T-594) is not called: the walk-time writers write no booking and no checklist block, so
//      there is no change claim to settle (DL-994 item 9).

import type { CommitTurnContext, EventEntry, OutboxRowNew, StateWrite } from "../../../commit";
import type { StepRows, StepWriter, StepWriterCall } from "../../../commit/walk";
import { openReviewItemCore, type PagingDeps } from "../../../domain/paging";
import { mayText, readStop, type StopHomeReads } from "../../../homes/stop";
import { answerOf, type KindsAnswer, type KindsPick } from "./answer";
import { KindsNotBuiltError, KindsRefusedError } from "./errors";
import type { KindsReads } from "./reads";

/** The steps this folder writes, in the order the walk meets them. */
export const KINDS_STEPS = ["S1-02", "S1-03", "S1-74"] as const;

/** One of the steps this folder writes. */
export type KindsStep = (typeof KINDS_STEPS)[number];

/** A draft's state while the owner is still answering the checklist (K-24 v1 new_work_drafts.state): the walk's. */
export const DRAFTING = "drafting";

/** A draft's state once it is sent to Rosie's team, K-37's review item open (K-24 v1 new_work_drafts.state). */
export const IN_REVIEW = "in_review";

/** The review item of S1-03's new work (K-37 v1 review_items.kind; T-319 REVIEW_STEP new_work: S1-03). */
export const NEW_WORK_REVIEW = "new_work";

/** The step the review item's plan is about, as its refusals name it. */
const REVIEW_STEP_ID: KindsStep = "S1-03";

/** The review item's summary (default 11): what the team must check, with no private value. */
export const REVIEW_SUMMARY =
  "New work drafted from the owner's own words, offline until Rosie's team checks it against the official rules for that work (S1-03).";

/** What the three writers read with, each bound by the wiring (card F); a port left out fails its step closed. */
export interface KindsWriterDeps {
  /** Items 78 and 79 (reads.ts): the catalog as rosie_app and the owner's picks as rosie_job, each in its own transaction. */
  readonly reads: KindsReads;
  /**
   * The stop home's reads of the owner's contact (homes/stop readStop), bound on the runtime side: handles, person_handles,
   * phones and K-29's rows, which rosie_app does not read. Left out: S1-03's and S1-74's messages answer notBuilt.
   */
  readonly stop?: StopHomeReads;
}

/** The read-only step writers of S1-02, S1-03 and S1-74 by step id (card F binds them; T-1461 WalkDeps.writers). */
export type KindsWriters<Repo = unknown> = Readonly<Record<KindsStep, StepWriter<Repo>>>;

/** A writer called for its own step only. */
function stepIs<Repo>(call: StepWriterCall<Repo>, stepId: KindsStep): void {
  if (call.step.id !== stepId) throw new KindsRefusedError("wrongStep", [stepId, call.step.id]);
}

/** The turn's person: who owns the picks and is told (K-09 caller.personId, the turn party's). */
function personOf<Repo>(turn: CommitTurnContext<Repo>, stepId: string): string {
  const { personId } = turn.request.caller;
  if (personId === null) throw new KindsRefusedError("noPerson", [stepId]);
  return personId;
}

/** Whether the turn batches texts from its own handle: its decided texts hold a text (homes/stop TurnRef.texted). */
function textedIn<Repo>(call: StepWriterCall<Repo>): boolean {
  const { input } = call.writer.turn.request;
  return input.kind === "decided" && input.decided.context.texts.some((text) => text.kind === "text");
}

/**
 * The step's message to the owner (default 12): one quick reply to the turn's handle and person, on the turn's service,
 * about the call's business, with no plan, when the stop home lets Rosie text; none when it rules noTexts.
 */
async function toldOwner<Repo>(deps: KindsWriterDeps, call: StepWriterCall<Repo>): Promise<OutboxRowNew[]> {
  const stepId = call.step.id;
  if (deps.stop === undefined) throw new KindsNotBuiltError("gateAndCommit", "stopNotWired", [stepId]);
  const { turn } = call.writer;
  const personId = personOf(turn, stepId);
  const handleId = turn.turn.handleId;
  const reading = await readStop(deps.stop, { personId, businessId: turn.businessId, handleId });
  const decision = mayText(reading, {
    sendClass: "quick_reply",
    bookingId: null,
    turn: { id: turn.turn.id, handleId, texted: textedIn(call) },
  });
  if (decision.ruling === "noTexts") return [];
  return [
    {
      id: call.writer.rowId("outbox"),
      recipientHandleId: handleId,
      recipientPersonId: personId,
      businessId: turn.businessId,
      bookingId: null,
      channel: call.writer.text().service,
      sendClass: "quick_reply",
      openQuestionId: null,
      copyOfRowId: null,
      versionsRead: [],
    },
  ];
}

// ---- the review item's plan (the later checklist card's; no writer here calls it) -------------------------------------

/** A new-work draft on file, as item 79 reads it (K-05 v1.19 newWorkDraftRead): its row id and the version read. */
export interface DraftOnFile {
  readonly id: string;
  readonly version: number;
}

/** The rows that send drafts to Rosie's team: per draft, its review item's insert, then the draft's move to in_review. */
export interface NewWorkReviewPlan {
  readonly state: readonly StateWrite[];
  /** One review_item.opened entry per item planned (T-319's); the draft's move has no K-08 kind (answer.ts default 7). */
  readonly stateEvents: readonly EventEntry[];
}

/** The paging ports bound, never the service's default reader (as commit/core's pagingPortOf). */
function pagingOf<Repo>(paging: PagingDeps<Repo> | undefined): PagingDeps<Repo> {
  // As the wiring handed it in: a reader left out, or null (which its type says it cannot be), is not bound either.
  const reader: unknown = paging?.reader;
  if (paging === undefined || reader === undefined || reader === null) {
    throw new KindsNotBuiltError("gateAndCommit", "pagingNotWired", [REVIEW_STEP_ID]);
  }
  return paging;
}

/**
 * The review item's plan for the drafts the owner's checklist is done for (K-09 SetupS1_03's save; defaults 9 to 11): for
 * each draft, in the order given, exactly one team review item through T-319's openReviewItemCore as a core action of this
 * turn (kind new_work, its subject the draft, its caller the turn's own, naming no business) with its review_item.opened
 * entry, then that draft's move to in_review at the version handed in. A draft whose item is on file plans no row. It
 * reads through `paging`'s reader alone, one draft after another, and writes nothing: its caller hands the rows to the
 * turn's one commit. Throws KindsNotBuiltError (pagingNotWired) with no reader bound, and KindsRefusedError when the turn
 * names no person (noPerson) or openReviewItem refuses (reviewRefused, reviewWrites): nothing is planned then.
 */
export async function newWorkReviewPlan<Repo>(
  paging: PagingDeps<Repo> | undefined,
  turn: CommitTurnContext<Repo>,
  drafts: readonly DraftOnFile[],
): Promise<NewWorkReviewPlan> {
  const ports = pagingOf(paging);
  const personId = personOf(turn, REVIEW_STEP_ID);
  const { caller } = turn.request;
  const state: StateWrite[] = [];
  const stateEvents: EventEntry[] = [];
  const planned = new Set<string>();
  for (const draft of drafts) {
    if (planned.has(draft.id)) continue;
    planned.add(draft.id);
    const run = await openReviewItemCore<Repo>(
      {
        call: "openReviewItem",
        request: {
          caller: {
            kind: "turn",
            turnId: turn.turn.id,
            requestId: caller.requestId,
            businessId: null,
            personId,
            traceId: turn.turn.traceId,
          },
          kind: NEW_WORK_REVIEW,
          subject: { table: "new_work_drafts", rowId: draft.id },
          summary: REVIEW_SUMMARY,
        },
      },
      turn,
      ports,
    );
    const { result, writes } = run;
    if (result.call !== "openReviewItem" || result.error !== null) {
      const code = result.error === null ? result.call : result.error.error;
      throw new KindsRefusedError("reviewRefused", [REVIEW_STEP_ID, code]);
    }
    const others =
      writes.asks.length + writes.closes.length + writes.clockCancels.length + writes.messages.length;
    if (others > 0 || (writes.clocks ?? []).length > 0) {
      throw new KindsRefusedError("reviewWrites", [REVIEW_STEP_ID]);
    }
    // The item is on file (a repeat): its draft moved with it, so nothing is planned for this draft.
    if (writes.state.length === 0) continue;
    state.push(...writes.state, {
      op: "update",
      table: "new_work_drafts",
      key: { id: draft.id },
      expectVersion: draft.version,
      set: { state: IN_REVIEW },
    });
    stateEvents.push(...writes.stateEvents);
  }
  return { state, stateEvents };
}

// ---- the step writers ---------------------------------------------------------------------------------------------------

/**
 * The read-only step writers of S1-02, S1-03 and S1-74 over `deps` (the top of this file), by step id. S1-02's answer is
 * kept for the walk's run (its turn context and the part's index) so S1-03's writer drafts the new_work picks it wrote,
 * by their row ids; it is let go with the run.
 */
export function kindsWriters<Repo = unknown>(deps: KindsWriterDeps): KindsWriters<Repo> {
  const answers = new WeakMap<object, Map<number, KindsAnswer>>();
  const remember = (call: StepWriterCall<Repo>, answer: KindsAnswer): void => {
    const key: object = call.writer.turn;
    const byPart = answers.get(key) ?? new Map<number, KindsAnswer>();
    byPart.set(call.part.index, answer);
    answers.set(key, byPart);
  };
  const recalled = (call: StepWriterCall<Repo>): KindsAnswer | null =>
    answers.get(call.writer.turn)?.get(call.part.index) ?? null;

  const s1_02: StepWriter<Repo> = async (call) => {
    stepIs(call, "S1-02");
    const answer = await answerOf(deps.reads, call);
    remember(call, answer);
    const rows: StepRows = {
      state: answer.state,
      stateEvents: [],
      gives: answer.gives,
      asks: [],
      messages: [],
    };
    return rows;
  };

  const s1_03: StepWriter<Repo> = async (call) => {
    stepIs(call, "S1-03");
    const stepId = call.step.id;
    const fresh: KindsPick[] = (recalled(call)?.picks ?? []).filter((pick) => pick.outcome === "new_work");
    if (fresh.length === 0) throw new KindsRefusedError("notAnswered", [stepId]);
    // The message is ruled first, so a step that cannot tell the owner (no stop reads bound) names no draft row id.
    const messages = await toldOwner(deps, call);
    const { request } = call.writer.turn;
    const state = fresh.map((pick): StateWrite => ({
      op: "insert",
      table: "new_work_drafts",
      values: {
        id: call.writer.rowId("draft"),
        picked_kind_id: pick.id,
        business_id: null,
        state: DRAFTING,
        drafted_at: request.now,
      },
    }));
    const rows: StepRows = { state, stateEvents: [], gives: [], asks: [], messages };
    return rows;
  };

  const s1_74: StepWriter<Repo> = async (call) => {
    stepIs(call, "S1-74");
    const rows: StepRows = {
      state: [],
      stateEvents: [],
      gives: [],
      asks: [],
      messages: await toldOwner(deps, call),
    };
    return rows;
  };

  return { "S1-02": s1_02, "S1-03": s1_03, "S1-74": s1_74 };
}
