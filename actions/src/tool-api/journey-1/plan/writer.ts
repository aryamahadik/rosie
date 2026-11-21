// S1-08's read-only step writer (T-1482; the S1-04 design ruling's card 13, DL-999; DL-1033; K-09 README defaults 181,
// 189 and 199 item (5), as DL-1074 has T-1482 take frozen default 189 in place of card 13's "It reads no table"): what
// S1-08, "Lays out the plan" (MASTER-FLOW-A.md lines 101 to 111: "needs companies pf.rules · gives" nothing), writes when
// the commit's walk walks it, after S1-04 (answered, or walked by T-1492's one-kind settler) and before S1-09's question.
// It is a T-1461 StepWriter (actions/src/commit/walk/writes.ts): it reads, then returns StepRows, and the commit writes
// what writesOf returns. The binding (T-1493, H1a) binds it at S1-08 with the stop reads; nothing binds it here.
//
// What it writes: one outbox row, the plan's quick reply to the owner, with no plan in it (words go in after the commit:
// arch 01 line 41), written only when the stop home lets Rosie text the owner. The owner is read with readStop
// (homes/stop, T-590) on the stop reads the binding hands in (the runtime side's: rosie_app reads no handles,
// person_handles or phones, DL-982), and mayText rules (DL-878's handoff 1), as T-633's toldOwner rules S1-03's and
// S1-74's messages (journey-1/kinds/writers.ts default 12). "noTexts" writes no row, and the walk goes on to S1-09.
//
// It reads through its deps alone (the stop reads, each awaited before the next inside readStop), never on the call's
// transaction, which it is handed and never uses. Nothing here logs; what it throws names faults, steps and seams
// (errors.ts), or is the walk's own refusal (WriterContext.text).
//
// Defaults used (for ops/QUESTIONS.md):
//   1. (K-09 README default 189, frozen) The row is written only when mayText rules "texts" for the call's business, the
//      turn's own handle and a quick reply with no booking, the turn counting as texting in when its decided texts hold a
//      text (T-633 default 12's reading of homes/stop TurnRef.texted). "noTexts": no row, nothing given. With no stop reads
//      bound the writer answers notBuilt (PlanNotBuiltError stopNotWired) with nothing read or written (fail closed). It
//      reads the stop home's rows and nothing else.
//   2. (Default 181) The row: its id WriterContext.rowId("outbox") (default 131: `outbox-s1-08-<turn key>-1`), to the
//      turn's handle and the caller's person, under the call's business (CommitTurnContext.businessId, which the walk has
//      already checked is the choice's target's), no booking, the turn's service as its channel (WriterContext.text(),
//      default 132), send class quick_reply (default 133), openQuestionId null (S1-08 asks nothing), copyOfRowId null and
//      no versions read (the walk's own rows name none: writes.ts default 7). No state row, no event-log entry, no
//      question, and no key given (S1-08 gives nothing).
//   3. The checks run in this order, each before anything is read: the step (wrongStep), the stop reads bound
//      (stopNotWired), the person (noPerson), then the turn's service and chat id through WriterContext.text(), whose
//      refusal is the walk's own (WalkRefusedError noServiceOrChatId). So a turn that could not carry the row is refused
//      whatever the stop home would rule, with no stop read made (T-633's toldOwner reads the service only for "texts";
//      the walk refuses the same turn at S1-09's question in any case, default 181).
//   4. The opt-out line is finalize's, from the same phones row, never the writer's (default 189; T-633 default 12): the
//      outbox row has no field for it, so the writer rules mayText alone.
//   5. The plan's words are compose input's and finalize's (S1-08's four term lines: default 186; card 14, T-1483), and
//      the opener is finalize's signUpOpener (default 199 item (6)). The owner's own plan lines, built from their kinds and
//      companies, are not here (CQ-86; open gaps 125 and 156).
//   6. The row's step and line stamp (S1-08, line 0) is the walk's (card 10, T-1479), proven end to end by H1a (T-1493),
//      not by this writer.
//   7. The writer's refusals are this folder's own (errors.ts), worded as kinds/'s are, since KindsRefusedError's message
//      names "the kinds of work", which S1-08 is not. The writer keeps nothing between calls: the same call twice gives
//      the same rows.

import type { CommitTurnContext, OutboxRowNew } from "../../../commit";
import type { StepRows, StepWriter, StepWriterCall } from "../../../commit/walk";
import { mayText, readStop, type StopHomeReads } from "../../../homes/stop";
import { PlanNotBuiltError, PlanRefusedError } from "./errors";

/** The step this writer writes. */
export const PLAN_STEP = "S1-08";

/** What S1-08's writer reads with, bound by the wiring (T-1493, H1a); a port left out fails the step closed. */
export interface PlanWriterDeps {
  /**
   * The stop home's reads of the owner's contact (homes/stop readStop), bound on the runtime side: handles,
   * person_handles, phones and K-29's rows, which rosie_app does not read. Left out: the writer answers notBuilt
   * (stopNotWired), nothing read or written.
   */
  readonly stop?: StopHomeReads;
}

/** The turn's person: who receives the plan's row (K-09 caller.personId, the turn party's). */
function personOf<Repo>(turn: CommitTurnContext<Repo>): string {
  const { personId } = turn.request.caller;
  if (personId === null) throw new PlanRefusedError("noPerson", [PLAN_STEP]);
  return personId;
}

/** Whether the turn batches texts from its own handle: its decided texts hold a text (homes/stop TurnRef.texted). */
function textedIn<Repo>(call: StepWriterCall<Repo>): boolean {
  const { input } = call.writer.turn.request;
  return input.kind === "decided" && input.decided.context.texts.some((text) => text.kind === "text");
}

/** S1-08 writes no state, no entry, no question and gives no key: at most its one message. */
function rowsOf(messages: readonly OutboxRowNew[]): StepRows {
  return { state: [], stateEvents: [], gives: [], asks: [], messages };
}

/**
 * S1-08's read-only step writer over `deps` (the top of this file): for a call at S1-08, one quick reply to the turn's
 * handle and person under the call's business when the stop home lets Rosie text the owner, else no row. Throws
 * PlanRefusedError (wrongStep, noPerson), PlanNotBuiltError (stopNotWired), the walk's WalkRefusedError
 * (noServiceOrChatId, through WriterContext.text) or what readStop and mayText throw: the call then fails closed with
 * nothing written.
 */
export function planWriter<Repo = unknown>(deps: PlanWriterDeps): StepWriter<Repo> {
  return async (call) => {
    if (call.step.id !== PLAN_STEP) throw new PlanRefusedError("wrongStep", [PLAN_STEP, call.step.id]);
    const { stop } = deps;
    if (stop === undefined) throw new PlanNotBuiltError("gateAndCommit", "stopNotWired", [PLAN_STEP]);
    const { turn } = call.writer;
    const personId = personOf(turn);
    const { service } = call.writer.text();
    const handleId = turn.turn.handleId;
    const reading = await readStop(stop, { personId, businessId: turn.businessId, handleId });
    const decision = mayText(reading, {
      sendClass: "quick_reply",
      bookingId: null,
      turn: { id: turn.turn.id, handleId, texted: textedIn(call) },
    });
    if (decision.ruling === "noTexts") return rowsOf([]);
    return rowsOf([
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
      },
    ]);
  };
}
