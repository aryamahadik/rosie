// S1-02's, S1-03's and S1-74's read-only step writers (T-633; DL-961 ruling 2; DL-988; T-1461's StepWriter,
// actions/src/commit/walk/writes.ts): what each of the three steps writes when the walk walks it on S1-02's answer. Card F
// binds them by step id into the turn face (turn-face/commit.ts createWritesOf); nothing binds them here. A writer never
// writes: it reads, then returns StepRows, and the commit writes what writesOf returns. The walk calls them in its order:
// S1-02's (the answered split: its gives) first, then the chosen branch's own step (S1-03 or S1-74).
//
//   S1-02  answer.ts: the owner's words read by T-632's matcher over item 78's catalog, kept under the chosen branch as
//          K-24 picked_kinds rows (a drafted kind's kinds row before its new_work pick), numbered after item 79's picks;
//          gives `kinds` unless every part is not booked. commit-s1-02.json's "All on the list": three listed picks.
//   S1-03  for each new_work pick S1-02's writer wrote in the same run, its draft (K-24 new_work_drafts, in_review, so the
//          kind stays offline: S1-02's safe default) and one team review item through T-319's openReviewItemCore (K-37
//          review_items, kind new_work, subject the draft, due within 1 business day: Q-18), which the team decides with
//          decideReviewItemAlone from its console, writing the draft's state back (approved, or kept offline): that
//          decision resumes setup. Then its message to the owner.
//   S1-74  its message to the owner, and nothing else: no kind (S1-02's writer keeps the words not_booked, with no kind),
//          and the path ends with its branch's end text (the walk's).
//
// A message to the owner (S1-03's, S1-74's) is one quick reply to the turn's own handle and person, on the turn's service,
// with no plan (words go in after the commit: arch 01 line 41), written only when the stop home lets Rosie text: the owner
// is read with readStop (homes/stop, T-590) on the stop reads the binding gives (the runtime side's: rosie_app reads no
// handles, person_handles or phones, DL-982), and mayText rules (DL-878's handoff 1). "noTexts" writes no row; the step's
// other rows are written.
//
// Each writer reads only through its deps (item 78 on the Tool API's client and item 79 on the runtime side, each in its
// own read-only transaction: reads.ts; the stop reads; T-319's PagingReader), never on the call's transaction, which it is
// handed and never uses. Nothing here logs; what it throws names faults, steps and codes (errors.ts).
//
// Defaults used (for ops/QUESTIONS.md), beside answer.ts's:
//   8. S1-03 drafts each new_work pick of the answer, each with one review item, in the walk's order; one message tells
//      the owner, once for the step. Its review item opens when the walk walks S1-03 (the card's lead note 3: "S1-03 opens
//      one review item"), so its draft is in_review at once (K-24 new_work_drafts.state: "in_review: sent to Rosie's team
//      (K-37's review item is open)"); the owner's checklist answers (SetupS1_03's blocks) are a later call's.
//   9. The draft has no business, as its pick (answer.ts default 4; new_work_drafts_pick_business_fk holds it to the
//      pick's), and its review item names none either (the item's caller names no business: K-09 caller.businessId "Null
//      only where no business exists yet"), so the team's decision may write back to the draft (T-319 review.ts default 29
//      compares the row's business with the item's), and the item is due by the next business day in UTC (review.ts
//      default 19).
//  10. The review item's subject is the draft this same commit writes before it: openReviewItem's check that the subject
//      exists (K-37 rule 5, kept by code) reads that draft as this commit writes it (version 1, no business), and every
//      other row through the bound reader. K-05's commit writes the state rows in the request's order, so the draft is
//      there when the item is.
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

import type { StateWrite, EventEntry, OutboxRowNew } from "../../../commit";
import type { StepRows, StepWriter, StepWriterCall } from "../../../commit/walk";
import {
  openReviewItemCore,
  type PagingDeps,
  type PagingReader,
  type StoredRow,
} from "../../../domain/paging";
import { mayText, readStop, type StopHomeReads } from "../../../homes/stop";
import { answerOf, type KindsAnswer, type KindsPick } from "./answer";
import { KindsNotBuiltError, KindsRefusedError } from "./errors";
import type { KindsReads } from "./reads";

/** The steps this folder writes, in the order the walk meets them. */
export const KINDS_STEPS = ["S1-02", "S1-03", "S1-74"] as const;

/** One of the steps this folder writes. */
export type KindsStep = (typeof KINDS_STEPS)[number];

/** What review item S1-03 opens (K-37 v1 review_items.kind; T-319 REVIEW_STEP new_work: S1-03). */
export const NEW_WORK_REVIEW = "new_work";

/** The review item's summary (default 11): what the team must check, with no private value. */
export const REVIEW_SUMMARY =
  "New work drafted from the owner's own words, offline until Rosie's team checks it against the official rules for that work (S1-03).";

/** What the three writers read with, each bound by the wiring (card F); a port left out fails its step closed. */
export interface KindsWriterDeps<Repo = unknown> {
  /** Items 78 and 79 (reads.ts): the catalog as rosie_app and the owner's picks as rosie_job, each in its own transaction. */
  readonly reads: KindsReads;
  /**
   * The stop home's reads of the owner's contact (homes/stop readStop), bound on the runtime side: handles, person_handles,
   * phones and K-29's rows, which rosie_app does not read. Left out: S1-03's and S1-74's messages answer notBuilt.
   */
  readonly stop?: StopHomeReads;
  /**
   * The paging service's ports for S1-03's review item (T-319's PagingDeps): its reader (the runtime's PagingReader,
   * T-1444), ids, ENVIRONMENT and roster. Left out, or with no reader: S1-03 answers notBuilt, never the service's
   * default reader.
   */
  readonly paging?: PagingDeps<Repo>;
}

/** The read-only step writers of S1-02, S1-03 and S1-74 by step id (card F binds them; T-1461 WalkDeps.writers). */
export type KindsWriters<Repo = unknown> = Readonly<Record<KindsStep, StepWriter<Repo>>>;

/** A writer called for its own step only. */
function stepIs(call: StepWriterCall, stepId: KindsStep): void {
  if (call.step.id !== stepId) throw new KindsRefusedError("wrongStep", [stepId, call.step.id]);
}

/** The turn's person: who owns the picks and is told (K-09 caller.personId, the turn party's). */
function personOf(call: StepWriterCall): string {
  const { personId } = call.writer.turn.request.caller;
  if (personId === null) throw new KindsRefusedError("noPerson", [call.step.id]);
  return personId;
}

/** Whether the turn batches texts from its own handle: its decided texts hold a text (homes/stop TurnRef.texted). */
function textedIn(call: StepWriterCall): boolean {
  const { input } = call.writer.turn.request;
  return input.kind === "decided" && input.decided.context.texts.some((text) => text.kind === "text");
}

/**
 * The step's message to the owner (defaults 12): one quick reply to the turn's handle and person, on the turn's service,
 * about the call's business, with no plan, when the stop home lets Rosie text; none when it rules noTexts.
 */
async function toldOwner<Repo>(
  deps: KindsWriterDeps<Repo>,
  call: StepWriterCall<Repo>,
): Promise<OutboxRowNew[]> {
  const stepId = call.step.id;
  if (deps.stop === undefined) throw new KindsNotBuiltError("gateAndCommit", "stopNotWired", [stepId]);
  const { turn } = call.writer;
  const personId = personOf(call);
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

/** The paging ports bound for S1-03, never the service's default reader (as commit/core's pagingPortOf). */
function pagingOf<Repo>(
  paging: PagingDeps<Repo> | undefined,
  stepId: string,
): PagingDeps<Repo> & { readonly reader: (repo: Repo) => PagingReader } {
  // As the wiring handed it in: a reader left out, or null (which its type says it cannot be), is not bound either.
  const reader: unknown = paging?.reader;
  if (paging === undefined || reader === undefined || reader === null) {
    throw new KindsNotBuiltError("gateAndCommit", "pagingNotWired", [stepId]);
  }
  return paging as PagingDeps<Repo> & { readonly reader: (repo: Repo) => PagingReader };
}

/**
 * The bound reader, with the drafts this commit writes read as written (default 10): `row("new_work_drafts", <id>)` of one
 * of them answers it at version 1 with no business; every other read goes to the bound reader, unchanged.
 */
function withDrafts(bound: PagingReader, drafts: ReadonlyMap<string, StoredRow>): PagingReader {
  return {
    page: (pageId) => bound.page(pageId),
    members: () => bound.members(),
    chat: (handleId) => bound.chat(handleId),
    reachOf: (personId) => bound.reachOf(personId),
    handOff: (handOffId) => bound.handOff(handOffId),
    safetyRead: (outcomeId) => bound.safetyRead(outcomeId),
    ownerOf: (businessId) => bound.ownerOf(businessId),
    businessZone: (businessId) => bound.businessZone(businessId),
    businessName: (businessId) => bound.businessName(businessId),
    clock: (clockRowId) => bound.clock(clockRowId),
    reviewItem: (reviewItemId) => bound.reviewItem(reviewItemId),
    row: (table, rowId) => {
      const draft = table === "new_work_drafts" ? drafts.get(rowId) : undefined;
      return draft === undefined ? bound.row(table, rowId) : Promise.resolve({ ...draft });
    },
    outboxRowWritten: (rowId) => bound.outboxRowWritten(rowId),
  };
}

/**
 * One review item for one draft, through T-319's openReviewItemCore as a core action of this turn (its caller the turn's
 * own, naming no business: default 9): its review_items row and review_item.opened entry, or none on a repeat.
 */
async function reviewOf<Repo>(
  paging: PagingDeps<Repo> & { readonly reader: (repo: Repo) => PagingReader },
  call: StepWriterCall<Repo>,
  draftId: string,
  drafts: ReadonlyMap<string, StoredRow>,
): Promise<{ state: readonly StateWrite[]; stateEvents: readonly EventEntry[] }> {
  const stepId = call.step.id;
  const { turn } = call.writer;
  const { caller } = turn.request;
  const { reader } = paging;
  const run = await openReviewItemCore<Repo>(
    {
      call: "openReviewItem",
      request: {
        caller: {
          kind: "turn",
          turnId: turn.turn.id,
          requestId: caller.requestId,
          businessId: null,
          personId: personOf(call),
          traceId: turn.turn.traceId,
        },
        kind: NEW_WORK_REVIEW,
        subject: { table: "new_work_drafts", rowId: draftId },
        summary: REVIEW_SUMMARY,
      },
    },
    turn,
    { ...paging, reader: (repo) => withDrafts(reader(repo), drafts) },
  );
  const { result, writes } = run;
  if (result.call !== "openReviewItem" || result.error !== null) {
    const code = result.error === null ? result.call : result.error.error;
    throw new KindsRefusedError("reviewRefused", [stepId, code]);
  }
  const others =
    writes.asks.length + writes.closes.length + writes.clockCancels.length + writes.messages.length;
  if (others > 0 || (writes.clocks ?? []).length > 0) {
    throw new KindsRefusedError("reviewWrites", [stepId]);
  }
  return { state: writes.state, stateEvents: writes.stateEvents };
}

/**
 * The read-only step writers of S1-02, S1-03 and S1-74 over `deps` (the top of this file), by step id. S1-02's answer is
 * kept for the walk's run (its turn context and the part's index) so S1-03's writer drafts the new_work picks it wrote,
 * by their row ids; it is let go with the run.
 */
export function kindsWriters<Repo = unknown>(deps: KindsWriterDeps<Repo>): KindsWriters<Repo> {
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
    const paging = pagingOf(deps.paging, stepId);
    const { request } = call.writer.turn;
    const state: StateWrite[] = [];
    const stateEvents: EventEntry[] = [];
    const drafts = new Map<string, StoredRow>();
    for (const pick of fresh) {
      const id = call.writer.rowId("draft");
      drafts.set(id, { version: 1, businessId: null });
      state.push({
        op: "insert",
        table: "new_work_drafts",
        values: {
          id,
          picked_kind_id: pick.id,
          business_id: null,
          state: "in_review",
          drafted_at: request.now,
        },
      });
    }
    for (const draftId of drafts.keys()) {
      const review = await reviewOf(paging, call, draftId, drafts);
      state.push(...review.state);
      stateEvents.push(...review.stateEvents);
    }
    const rows: StepRows = { state, stateEvents, gives: [], asks: [], messages: await toldOwner(deps, call) };
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
