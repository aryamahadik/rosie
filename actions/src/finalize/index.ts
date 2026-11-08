// The finalize call (C-093, T-313; K-09 v1 finalizeMessage; arch 02 line 123: "Code inserts its options and fixed lines
// and fills its slots, then the claim check runs limit 7 and the message checks. | One rewrite, told what failed. Fails
// again: the step's fallback text ... through the same checks (DD). None passes: 'I've passed this on. Rosie's team will
// reply within 1 business day.' ...; the question is withdrawn, so no clock arms (RULES 5.2)"; arch 07 lines 405 to
// 417). For one outbox row and its plan, in this order:
//
//   1. the row, read on the primary, uncached (readRow): a fixed-line row is never finalized here (STATE note 17); a row
//      no longer to be sent answers rowClosed; a row that holds a plan answers alreadyPlanned with its final parts
//      unchanged (K-05 v1 writePlan: checked before the version); a row whose version moved answers versionChanged;
//   2. the attempt, the composer's plan or its one rewrite: limit 7 on each slot, then the fill (T-311's claimPlan over
//      T-310's filler); the options and the parts (rewrite/parts.ts); the fixed lines (T-314's port); the seven message
//      checks (T-312), with what limit 7, the fill and the parts found joined to the check each breaks
//      (rewrite/attempt.ts);
//   3. what happens next (arch 07 line 417): every check passed, it sends; a miss on the composed plan gets its one
//      rewrite, told what failed, and nothing is written; a blocking miss on the rewrite takes the step's fallback text
//      through the same steps, except that limit 7 never cuts the master's words: a slot the reader may never see stays
//      as written, so Values fails on its '{{' (rewrite/fallback.ts; DL-158 ruling b); nothing passed, the passed-on line
//      goes, the question is withdrawn and one team review item is opened (rewrite/passed-on.ts); a miss only of Shape,
//      Length and reading or Format after the rewrite, or a message past four fact lines, sends and is logged;
//   4. the write: the plan and the final parts together (K-05 v1 writePlan, K-07 v1 planned to checked).
//
// Paging Rosie's team for a passed-on message is T-319's (M3b): teamPageId stays null here. Nothing here logs a value
// or a text's words: the notes are labels (FinalizeNote), the span keeps row ids, every throw names a fault. No check
// detail the answer gives holds a filled value (rewrite/told.ts withoutValues; DL-158 ruling c), and what the one
// rewrite is told is rewriteTold, never the parts it checked.

import type { CallContext, Handler } from "../tool-api";
import { claimPlan, claimText, type ClaimContext } from "./claim-check";
import {
  FinalizeNotBuiltError,
  FinalizeRefusedError,
  buildParts,
  checkAttempt,
  checksWithoutValues,
  claimFallback,
  outcomeOf,
  passedOnParts,
  passedOnReview,
  passedOnWords,
  problemFaults,
  withdrawRequest,
  type Attempt,
  type AttemptCheck,
  type AttemptOutcome,
  type CheckResult,
  type FinalParts,
  type FinalizeAnswer,
  type FinalizeDeps,
  type FinalizeError,
  type FinalizeNote,
  type FinalizePorts,
  type FinalizeRequest,
  type FinalizeRow,
  type PartFaults,
  type RowState,
} from "./rewrite";
import type { SlotValue } from "./slots";

export * from "./rewrite";

/** Rows no longer to be sent (K-07 v1; K-09 v1 rowClosed, as composeInput's: dropped, withdrawn, superseded or failed). */
const CLOSED_STATES: ReadonlySet<RowState> = new Set<RowState>([
  "dropped_stopped",
  "withdrawn",
  "superseded",
  "failed",
]);

/** The states writePlan moves to checked (K-07 v1: planned → checked, stale → checked). */
const PLANNABLE_STATES: ReadonlySet<RowState> = new Set<RowState>(["planned", "stale"]);

/** The one line besides a safety row that limit 8 lets past the stopped flag; never written here (T-267's note b). */
const STOP_REPLY = "stopReply";

/** What the rewrite is told when limit 7 cut the plan's question whole (T-311's handoff: "tell the rewrite"). */
export const QUESTION_CUT =
  "The question names a field this reader may never see, so it was cut; ask it without that field.";

/** Every port of the finalize call not built yet: each throws FinalizeNotBuiltError, so the call answers notBuilt. */
export function notBuiltPorts<Repo = unknown>(): FinalizePorts<Repo> {
  return {
    readRow: () => Promise.reject(new FinalizeNotBuiltError("readRow")),
    insertFixedLines: () => Promise.reject(new FinalizeNotBuiltError("insertFixedLines")),
    writePlan: () => Promise.reject(new FinalizeNotBuiltError("writePlan")),
    cancelClock: () => Promise.reject(new FinalizeNotBuiltError("cancelClock")),
    openReviewItem: () => Promise.reject(new FinalizeNotBuiltError("openReviewItem")),
  };
}

/** The default note: one JSON line of labels (the row, the attempt, its outcome, the checks it missed). */
export function logNote(note: FinalizeNote): void {
  console.info(
    JSON.stringify({
      level: "info",
      msg: "finalize_attempt",
      row: note.row,
      attempt: note.attempt,
      outcome: note.outcome,
      missed: note.missed,
    }),
  );
}

/** One attempt: what was checked, its parts and their checks. */
interface Checked {
  readonly attempt: Attempt;
  readonly parts: FinalParts;
  readonly check: AttemptCheck;
}

function addFaults(found: PartFaults, check: keyof PartFaults, faults: readonly string[]): void {
  const list = found[check] ?? [];
  for (const fault of faults) if (!list.includes(fault)) list.push(fault);
  if (list.length > 0) found[check] = list;
}

/**
 * K-03 v1 `checkResult` for one attempt: passedOn, and only it, withdraws the question and tells the team. No detail
 * holds a filled value (withoutValues), since T-252's compose loop tells the one rewrite these details as they come.
 */
function resultOf(row: FinalizeRow, checked: Checked, outcome: AttemptOutcome): CheckResult {
  const [first, ...rest] = checksWithoutValues(checked.check.checks, checked.parts.slotValues);
  if (first === undefined) throw new FinalizeRefusedError("partsNotWellFormed");
  const passedOn = outcome === "passedOn";
  return {
    row: row.outboxRowId,
    attempt: checked.attempt,
    checked: checked.parts,
    checks: [first, ...rest],
    outcome,
    questionWithdrawn: passedOn,
    teamPaged: passedOn,
  };
}

/** The fixed lines this row carries, added by T-314's port, then held to K-03's shape and T-267's one rule. */
async function withFixedLines<Repo>(
  parts: FinalParts,
  row: FinalizeRow,
  call: CallContext<Repo>,
  ports: FinalizePorts<Repo>,
): Promise<FinalParts> {
  const added = await ports.insertFixedLines(parts, row, call);
  const sends: readonly unknown[] = added.sends;
  if (added.row !== parts.row || added.channel !== parts.channel || sends.length < 1 || sends.length > 2)
    throw new FinalizeRefusedError("partsNotWellFormed");
  if (added.fixedLines.includes(STOP_REPLY)) throw new FinalizeRefusedError("stopReplyLine");
  return added;
}

/** A link card's preview: the business name as this reader may see it (biz.name through limit 7; arch 07 line 381). */
function cardOf(row: FinalizeRow, claim: ClaimContext): SlotValue | null {
  const filled = claimText("{{biz.name}}", row.source, claim);
  if (!filled.ok) return null;
  return filled.slotValues.find((fact) => fact.slot === "biz.name") ?? null;
}

/** The composer's plan, or its one rewrite, through limit 7, the fill, the parts, the fixed lines and the checks. */
async function planAttempt<Repo>(
  request: FinalizeRequest,
  row: FinalizeRow,
  claim: ClaimContext,
  call: CallContext<Repo>,
  ports: FinalizePorts<Repo>,
): Promise<Checked> {
  const plan = request.plan.plan;
  const claimed = claimPlan({ lines: plan.lines, question: plan.question }, row.source, claim);
  const built = buildParts({
    row: row.outboxRowId,
    channel: row.channel,
    formats: plan.formats,
    threadReplyTo: plan.threadReplyTo,
    lines: claimed.lines,
    question: claimed.question,
    slotValues: claimed.slotValues,
    options: row.checks.options,
    typedOptions: row.checks.typedOptions,
    calendarFile: row.calendarFile,
    card: plan.formats.includes("linkCard") ? cardOf(row, claim) : null,
  });
  const found: PartFaults = { ...built.faults };
  if (!claimed.ok) addFaults(found, "values", problemFaults(claimed.problems));
  if (claimed.questionCut) addFaults(found, "values", [QUESTION_CUT]);
  const parts = await withFixedLines(built.parts, row, call, ports);
  return { attempt: request.attempt, parts, check: checkAttempt(parts, row.checks, found) };
}

/**
 * The step's fallback text through the same steps: limit 7, never cutting it (a slot the reader may never see stays as
 * written), the fill, the words (text alone), the fixed lines, the checks.
 */
async function fallbackAttempt<Repo>(
  request: FinalizeRequest,
  row: FinalizeRow,
  claim: ClaimContext,
  text: string,
  call: CallContext<Repo>,
  ports: FinalizePorts<Repo>,
): Promise<Checked> {
  const claimed = claimFallback(text, row.source, claim);
  const built = buildParts({
    row: row.outboxRowId,
    channel: row.channel,
    formats: ["text"],
    threadReplyTo: request.plan.plan.threadReplyTo,
    lines: [{ text: claimed.text }],
    question: null,
    slotValues: claimed.slotValues,
    options: row.checks.options,
    typedOptions: row.checks.typedOptions,
    calendarFile: "none",
    card: null,
  });
  const found: PartFaults = { ...built.faults };
  if (!claimed.ok) addFaults(found, "values", problemFaults(claimed.problems));
  const parts = await withFixedLines(built.parts, row, call, ports);
  return { attempt: "fallback", parts, check: checkAttempt(parts, row.checks, found) };
}

type Written = { readonly ok: true } | { readonly ok: false; readonly answer: FinalizeError };

/** The plan and the final parts, written together (K-05 v1 writePlan); K-05's refusals as K-09 v1's errors. */
async function write<Repo>(
  request: FinalizeRequest,
  row: FinalizeRow,
  parts: FinalParts,
  call: CallContext<Repo>,
  ports: FinalizePorts<Repo>,
): Promise<Written> {
  const answer = await ports.writePlan(
    {
      outboxRowId: row.outboxRowId,
      expectVersion: request.expectVersion,
      plan: request.plan,
      finalParts: parts,
    },
    call,
  );
  if (!("error" in answer)) {
    call.span.rows.push({ table: "outbox_rows", id: row.outboxRowId });
    return { ok: true };
  }
  switch (answer.error) {
    case "alreadyPlanned": {
      // Another call planned the row first: its final parts come back unchanged (K-09 v1 alreadyPlanned).
      const again = await ports.readRow(row.outboxRowId, call);
      if ("error" in again) return { ok: false, answer: again };
      if (again.finalParts === null) throw new FinalizeRefusedError("writeRefused", answer.error);
      return {
        ok: false,
        answer: { error: "alreadyPlanned", outboxRowId: row.outboxRowId, finalParts: again.finalParts },
      };
    }
    case "versionChanged":
    case "notFound":
    case "transient":
      return { ok: false, answer };
    default:
      // An answer outside K-05 v1's writePlan errors: never passed on (fail closed).
      throw new FinalizeRefusedError("writeRefused");
  }
}

/** Tells the log what one attempt came to, in labels only. */
function note<Repo>(
  deps: FinalizeDeps<Repo>,
  row: FinalizeRow,
  checked: Checked,
  outcome: AttemptOutcome,
): void {
  deps.log({ row: row.outboxRowId, attempt: checked.attempt, outcome, missed: checked.check.missed });
}

/** A passing attempt, or one that sends and is logged: its parts written with the plan. */
async function sendParts<Repo>(
  request: FinalizeRequest,
  row: FinalizeRow,
  call: CallContext<Repo>,
  deps: FinalizeDeps<Repo>,
  outcome: "send" | "sendAndLog",
  checks: [CheckResult] | [CheckResult, CheckResult],
  parts: FinalParts,
): Promise<FinalizeAnswer> {
  const written = await write(request, row, parts, call, deps.ports);
  if (!written.ok) return written.answer;
  return { outcome, checks, finalParts: parts, questionWithdrawn: false, teamPageId: null };
}

/**
 * Nothing passed: the passed-on line written as the final parts, the question withdrawn with its clock row (K-05 v1
 * cancelClock), and one team review item opened (K-37 v1). Each in the call's one transaction, so an error answer from
 * any of them rolls the others back (the Tool API base).
 */
async function passOn<Repo>(
  request: FinalizeRequest,
  row: FinalizeRow,
  call: CallContext<Repo>,
  deps: FinalizeDeps<Repo>,
  checks: [CheckResult] | [CheckResult, CheckResult],
): Promise<FinalizeAnswer> {
  const words = passedOnWords(row.checks);
  if (words === null) throw new FinalizeRefusedError("noPassedOnLine");
  const parts = await withFixedLines(passedOnParts(row, request.plan, words), row, call, deps.ports);
  const written = await write(request, row, parts, call, deps.ports);
  if (!written.ok) return written.answer;

  const withdraw = withdrawRequest(row, deps.now());
  if (withdraw !== null) {
    const cancelled = await deps.ports.cancelClock(withdraw, call);
    if ("error" in cancelled) {
      if (
        cancelled.error === "versionChanged" ||
        cancelled.error === "notFound" ||
        cancelled.error === "transient"
      )
        return cancelled;
      throw new FinalizeRefusedError("clockRefused", cancelled.error);
    }
    call.span.rows.push({ table: "clock_rows", id: withdraw.clockRowId });
    const question = withdraw.withdrawQuestion;
    if (question !== null) call.span.rows.push({ table: "open_questions", id: question.openQuestionId });
  }

  const review = await deps.ports.openReviewItem(passedOnReview(row, request.caller), call);
  if ("error" in review) {
    if (review.error === "transient") return review;
    throw new FinalizeRefusedError("reviewRefused", review.error);
  }
  call.span.rows.push({ table: "review_items", id: review.reviewItemId });
  return { outcome: "passedOn", checks, finalParts: parts, questionWithdrawn: true, teamPageId: null };
}

/** The finalize call's steps for one request (see the top of this file). */
async function finalize<Repo>(
  request: FinalizeRequest,
  call: CallContext<Repo>,
  deps: FinalizeDeps<Repo>,
): Promise<FinalizeAnswer> {
  const { ports } = deps;
  if (request.plan.row !== request.outboxRowId) throw new FinalizeRefusedError("planForOtherRow");
  const read = await ports.readRow(request.outboxRowId, call);
  if ("error" in read) return read;
  const row = read;
  if (row.outboxRowId !== request.outboxRowId) throw new FinalizeRefusedError("rowMismatch");
  if (row.fixedLineId !== null) throw new FinalizeRefusedError("fixedLineRow");
  if (CLOSED_STATES.has(row.state))
    return { error: "rowClosed", outboxRowId: row.outboxRowId, state: row.state };
  if (row.finalParts !== null)
    return { error: "alreadyPlanned", outboxRowId: row.outboxRowId, finalParts: row.finalParts };
  if (!PLANNABLE_STATES.has(row.state)) throw new FinalizeRefusedError("rowNotPlannable");
  if (row.version !== request.expectVersion) {
    return {
      error: "versionChanged",
      changed: [
        {
          table: "outbox_rows",
          rowId: row.outboxRowId,
          readVersion: request.expectVersion,
          currentVersion: row.version,
        },
      ],
    };
  }
  if (request.plan.channel !== row.channel) throw new FinalizeRefusedError("channelMismatch");

  const claim: ClaimContext = { ...row.claim, reader: row.reader };
  const first = await planAttempt(request, row, claim, call, ports);
  const firstOutcome = outcomeOf(first.attempt, first.check, row.fallbackText !== null);
  note(deps, row, first, firstOutcome);
  switch (firstOutcome) {
    case "send":
    case "sendAndLog":
      return sendParts(
        request,
        row,
        call,
        deps,
        firstOutcome,
        [resultOf(row, first, firstOutcome)],
        first.parts,
      );
    case "rewrite":
      return {
        outcome: "rewrite",
        checks: [resultOf(row, first, "rewrite")],
        finalParts: null,
        questionWithdrawn: false,
        teamPageId: null,
      };
    case "passedOn":
      return passOn(request, row, call, deps, [resultOf(row, first, "passedOn")]);
    case "fallback":
      break;
  }

  const fallback = await fallbackAttempt(request, row, claim, row.fallbackText ?? "", call, ports);
  const fallbackOutcome = outcomeOf("fallback", fallback.check, false);
  note(deps, row, fallback, fallbackOutcome);
  const checks: [CheckResult, CheckResult] = [
    resultOf(row, first, "fallback"),
    resultOf(row, fallback, fallbackOutcome),
  ];
  if (fallbackOutcome === "send" || fallbackOutcome === "sendAndLog")
    return sendParts(request, row, call, deps, fallbackOutcome, checks, fallback.parts);
  return passOn(request, row, call, deps, checks);
}

/**
 * The finalize call's handler for the Tool API base (K-09 v1 finalizeMessage), which validates the request and the answer
 * against the frozen schema and runs it in one transaction under the caller's business scope.
 */
export function finalizeMessage<Repo>(deps: FinalizeDeps<Repo>): Handler<"finalizeMessage", Repo> {
  return (request, call) => finalize(request, call, deps);
}
