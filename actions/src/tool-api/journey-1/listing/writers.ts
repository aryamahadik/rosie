// S1-09's and S1-76's read-only step writers (T-635a; K-09 README defaults 204 and 205, as DL-1133's Fixes 1 and 5 restate
// them; T-1461's StepWriter, actions/src/commit/walk/writes.ts). A writer never writes: it reads, then returns StepRows,
// and the commit writes what writesOf returns in the turn's one commit, or nothing at all. The walk calls S1-09's as the
// answered split's writer, after S1-09's settler and before any step of the settled branch, and S1-76's on "No match,
// or already listed". Each reads S1-09's reading from the turn object (settle.ts) and refuses (notSettled) when none is
// held, so a binding that hands the writers without the settler writes nothing: the three are bound together or not at
// all (listingSteps, index.ts). Nothing binds them here (the ruling's card 7 binds them in the turn face).
//
// S1-09's writer (default 204): only the call's business, and only when the caller's person owns the company the turn runs
// under (item 79; default 182), else refused (noCompany) with nothing written. Nothing of the listing is kept on any
// branch (K-15 README default 9; DL-1133 Fix 5): the rows hold the owner's own typed words and nothing a candidate gave.
//   (1) K-04 businesses, the call's business head, updated at the version read (item 26): name and display_name both the
//       name S1-09's reading gives (the deciding try's, else the first try's), as typed with only the four marks folded,
//       on every branch. status is never written.
//   (2) K-23 business_setup, inserted only when none is on file (item 26), with listing_phone, website and listing_email
//       null and every other column at its default, so the row a listing check's done decision writes control to is on
//       file; a row on file is not written. No control column and no other column.
//   (3) The read-back (MASTER-FLOW-A line 127), only on "An owner; the listing matches": one quick reply naming S1-09 and
//       line 1 (K-05 v1.22 lineNo: say[2] is S1-09's second line from Rosie to the owner), to the turn's handle and
//       person, under the call's business, on the turn's service, no booking, no question and no plan, written only when
//       the stop home lets Rosie text this owner (default 189). Its slots are filled at compose from the record, which
//       holds the typed name and none of the listing's address or phone (open gap 185).
//   It gives `business`, with no event-log entry for its state rows (K-08 v1.1 has no kind for either: open gap 1).
//
// S1-76's writer (default 205): (1) its message, one quick reply naming S1-76 and line 0, to the turn's handle and
// person, under the call's business, on the turn's service, written only when the stop home lets Rosie text; (2) one team
// review item through T-319's openReviewItemCore: kind listing_match (K-37 v1), its subject the call's businesses row,
// raised by the caller's person, due within 1 business day in the business's zone (its caller names the call's business:
// DL-1133 Fix 6), keyed by the turn with its kind and subject so a rerun names the first, with the review_item.opened
// entry openReviewItemCore gives. Its summary is one of six fixed sentences (summary.ts), the claim and the reason read
// from S1-09's reading, never the words, a listing's fields or a banned word. It gives nothing.
//
// A message to the owner reads the owner with readStop (homes/stop, T-590) on the stop reads the binding hands in (the
// runtime side's: rosie_app reads no handles, person_handles or phones, DL-982), and mayText rules, as T-633's toldOwner
// and T-1482's S1-08 writer rule theirs. Each writer reads through its deps alone, each read awaited before the next. A
// port left out answers notBuilt before anything is read. Nothing here logs; what it throws names faults, steps and seams
// (errors.ts), or is the walk's own refusal (WriterContext.text).
//
// Defaults used (for ops/QUESTIONS.md):
//   L1. The checks run in this order, each before anything is read: the step (wrongStep), the reading held (notSettled)
//       and its branch the one handed (branchNotSettled), the person (noPerson), the ports the branch needs
//       (stopNotWired, pagingNotWired), then the turn's service through WriterContext.text() where a row is written.
//   L2. S1-09's writer reads item 79, then the business head, then the setup row (open gap 193's reads: reads.ts), in that
//       order, and the stop home last, for the read-back alone.
//   L3. S1-76's writer opens its review item after its message is ruled, so a turn that cannot carry the row names no
//       review item id; the item's request id is the turn's own (K-09 caller.requestId).
//   L4. The read-back names both its step and its line (K-05 v1.22: both or neither); S1-76's row names S1-76 and line 0.

import type { CommitTurnContext, OutboxRowNew } from "../../../commit";
import type { StepRows, StepWriter, StepWriterCall } from "../../../commit/walk";
import { openReviewItemCore, type PagingDeps } from "../../../domain/paging";
import { mayText, readStop, type StopHomeReads } from "../../../homes/stop";
import { ListingNotBuiltError, ListingRefusedError } from "./errors";
import type { ListingReads } from "./reads";
import {
  BUSINESS,
  NO_MATCH,
  OWNER_MATCHES,
  S1_09,
  S1_76,
  type ListingReading,
  type WalkReadings,
} from "./settle";
import { listingSummaryOf } from "./summary";

/** The review item S1-76 opens (K-37 v1 review_items.kind; T-319 REVIEW_STEP listing_match: S1-76). */
export const LISTING_MATCH_REVIEW = "listing_match";

/** The read-back's line (K-05 v1.22 lineNo): S1-09's second line from Rosie to the owner (writes.ts default 16). */
export const READ_BACK_LINE = 1;

/** What the two writers read with, bound by the wiring (card 7); a port left out fails its step closed. */
export interface ListingWriterDeps<Repo = unknown> {
  /** Item 79 and item 26 (reads.ts): the turn's company, the business head and the setup row. */
  readonly reads: ListingReads<Repo>;
  /** The stop home's reads, bound on the runtime side. Left out: the read-back and S1-76's message answer notBuilt. */
  readonly stop?: StopHomeReads;
  /** T-319's paging ports for S1-76's review item. Left out, or with no reader: S1-76's writer answers notBuilt. */
  readonly paging?: PagingDeps<Repo>;
}

/** The read-only step writers of S1-09 and S1-76 by step id. */
export type ListingWriters<Repo = unknown> = Readonly<Record<typeof S1_09 | typeof S1_76, StepWriter<Repo>>>;

/** The turn's person: who is told and who raises the review item (K-09 caller.personId, the turn party's). */
function personOf<Repo>(turn: CommitTurnContext<Repo>, stepId: string): string {
  const { personId } = turn.request.caller;
  if (personId === null) throw new ListingRefusedError("noPerson", [stepId]);
  return personId;
}

/** Whether the turn batches texts from its own handle: its decided texts hold a text (homes/stop TurnRef.texted). */
function textedIn<Repo>(call: StepWriterCall<Repo>): boolean {
  const { input } = call.writer.turn.request;
  return input.kind === "decided" && input.decided.context.texts.some((text) => text.kind === "text");
}

/** The stop reads bound, or notBuilt (stopNotWired) before anything is read. */
function stopOf(stop: StopHomeReads | undefined, stepId: string): StopHomeReads {
  if (stop === undefined) throw new ListingNotBuiltError("gateAndCommit", "stopNotWired", [stepId]);
  return stop;
}

/** The paging ports bound, never the service's default reader (as kinds/writers.ts pagingOf). */
function pagingOf<Repo>(paging: PagingDeps<Repo> | undefined, stepId: string): PagingDeps<Repo> {
  // As the wiring handed it in: a reader left out, or null (which its type says it cannot be), is not bound either.
  const reader: unknown = paging?.reader;
  if (paging === undefined || reader === undefined || reader === null) {
    throw new ListingNotBuiltError("gateAndCommit", "pagingNotWired", [stepId]);
  }
  return paging;
}

/**
 * The step's one message to the owner: a quick reply to the turn's handle and person, about the call's business, on the
 * turn's service, naming its step and line, with no plan; none when the stop home rules noTexts.
 */
async function toldOwner<Repo>(
  stop: StopHomeReads,
  call: StepWriterCall<Repo>,
  personId: string,
  lineNo: number,
): Promise<OutboxRowNew[]> {
  const { turn } = call.writer;
  const { service } = call.writer.text();
  const handleId = turn.turn.handleId;
  const reading = await readStop(stop, { personId, businessId: turn.businessId, handleId });
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
      channel: service,
      sendClass: "quick_reply",
      openQuestionId: null,
      copyOfRowId: null,
      versionsRead: [],
      step: call.step.id,
      lineNo,
    },
  ];
}

/** S1-09's reading held for this walk and part, as a branch; notSettled when none is held or it answered "ask". */
async function settledOf<Repo>(
  readings: WalkReadings<Repo>,
  call: StepWriterCall<Repo>,
  stepId: string,
): Promise<Extract<ListingReading, { outcome: "branch" }>> {
  const held = readings.held(call.writer.turn, call.part.index);
  if (held === null) throw new ListingRefusedError("notSettled", [stepId]);
  const reading = await held;
  if (reading.outcome !== "branch") throw new ListingRefusedError("notSettled", [stepId]);
  return reading;
}

/**
 * The read-only step writers of S1-09 and S1-76 over `deps` and one walk's readings (the top of this file), by step id.
 * Throws ListingRefusedError, ListingNotBuiltError, ListingReadError, the walk's WalkRefusedError (noServiceOrChatId,
 * through WriterContext.text) or what a read port throws: the call then fails closed with nothing written.
 */
export function listingWriters<Repo = unknown>(
  deps: ListingWriterDeps<Repo>,
  readings: WalkReadings<Repo>,
): ListingWriters<Repo> {
  const s1_09: StepWriter<Repo> = async (call) => {
    if (call.step.id !== S1_09) throw new ListingRefusedError("wrongStep", [S1_09, call.step.id]);
    const reading = await settledOf(readings, call, S1_09);
    if (call.choice.branch !== reading.branch) throw new ListingRefusedError("branchNotSettled", [S1_09]);
    const { turn } = call.writer;
    const personId = personOf(turn, S1_09);
    const readBack = reading.branch === OWNER_MATCHES;
    const stop = readBack ? stopOf(deps.stop, S1_09) : null;

    // Whose rows (default 204): the caller's person owns the company the turn runs under, whose business is the call's.
    const company = await deps.reads.turnCompany({ businessId: turn.businessId, personId });
    if (company === null) throw new ListingRefusedError("noCompany", [S1_09]);
    const asked = { handleId: turn.turn.handleId, businessId: turn.businessId };
    const head = await deps.reads.businessHead(call.repo, asked);
    const setupOnFile = await deps.reads.setupOnFile(call.repo, asked);

    const rows: StepRows = {
      state: [
        {
          op: "update",
          table: "businesses",
          key: { id: turn.businessId },
          expectVersion: head.version,
          set: { name: reading.name, display_name: reading.name },
        },
        ...(setupOnFile
          ? []
          : [
              {
                op: "insert" as const,
                table: "business_setup",
                values: {
                  business_id: turn.businessId,
                  listing_phone: null,
                  website: null,
                  listing_email: null,
                },
              },
            ]),
      ],
      stateEvents: [],
      gives: [BUSINESS],
      asks: [],
      messages: stop === null ? [] : await toldOwner(stop, call, personId, READ_BACK_LINE),
    };
    return rows;
  };

  const s1_76: StepWriter<Repo> = async (call) => {
    if (call.step.id !== S1_76) throw new ListingRefusedError("wrongStep", [S1_76, call.step.id]);
    const reading = await settledOf(readings, call, S1_76);
    if (reading.branch !== NO_MATCH || reading.reason === null) {
      throw new ListingRefusedError("branchNotSettled", [S1_76]);
    }
    const { turn } = call.writer;
    const personId = personOf(turn, S1_76);
    const stop = stopOf(deps.stop, S1_76);
    const paging = pagingOf(deps.paging, S1_76);

    const messages = await toldOwner(stop, call, personId, 0);
    const { caller } = turn.request;
    const run = await openReviewItemCore<Repo>(
      {
        call: "openReviewItem",
        request: {
          caller: {
            kind: "turn",
            turnId: turn.turn.id,
            requestId: caller.requestId,
            businessId: turn.businessId,
            personId,
            traceId: turn.turn.traceId,
          },
          kind: LISTING_MATCH_REVIEW,
          subject: { table: "businesses", rowId: turn.businessId },
          summary: listingSummaryOf(reading.claim, reading.reason),
        },
      },
      turn,
      paging,
    );
    const { result, writes } = run;
    if (result.call !== "openReviewItem" || result.error !== null) {
      const code = result.error === null ? result.call : result.error.error;
      throw new ListingRefusedError("reviewRefused", [S1_76, code]);
    }
    const others =
      writes.asks.length + writes.closes.length + writes.clockCancels.length + writes.messages.length;
    if (others > 0 || (writes.clocks ?? []).length > 0) {
      throw new ListingRefusedError("reviewWrites", [S1_76]);
    }
    const rows: StepRows = {
      state: writes.state,
      stateEvents: writes.stateEvents,
      gives: [],
      asks: [],
      messages,
    };
    return rows;
  };

  return { [S1_09]: s1_09, [S1_76]: s1_76 };
}
