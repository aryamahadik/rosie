// The turn loop, second half (T-252; C-046; arch 02 step 7, architecture.txt line 123; arch 07 'Decide, then word', line
// 397). After the commit (T-251, ./turn.ts), each outbox row the commit wrote is composed, the rows in parallel, and then
// the outbox dispatcher is woken, once per committed turn.
//
//   1. The rows (K-05 v1 item 2): `unplannedRows` gives the turn's rows that hold no plan yet, each with its version (the
//      expectVersion of finalizeMessage and of writePlan), its channel and, for an email copy, its text row. Only the rows
//      this commit names (K-09 `written.outboxRows`, in commit order) are composed. A row that already holds a plan (a fixed
//      line's words that T-267's replies wrote, or an earlier run's plan) is not listed, so none is written twice.
//   2. A fixed line's row is never composed (STATE note 17; K-09 README open gap 16): every row the commit's own core
//      results name for a fixed line (a STOP's or a START's reply, each business told of a STOP, HELP's reply, a safety
//      line) and every row the replies wrote words into is left out, whether its words are written yet or not.
//   3. Each other row, all at once (one composer call per row: arch 07 line 397). K-09 `composeInput` gives K-03's composer
//      input (`compose`) or says the row is an email copy of a text row (`emailCopy`); its word and the row's own
//      `copyOfRowId` must agree, or the row is left.
//        - compose: the composer's plan (C-118), then K-09 `finalizeMessage` with attempt composed. send or sendAndLog: the
//          call has written the final parts with the plan (through K-05 v1 writePlan). rewrite: the composer's one
//          rewrite, told only each failed check and its detail, then finalizeMessage with attempt rewrite, which runs the
//          step's fallback and then the passed-on line itself (K-09 README default 11) and answers send, sendAndLog or
//          passedOn (the passed-on line written, the question withdrawn so no clock arms, the team paged). Never a second
//          rewrite. A rewrite the models cannot make (the AI gateway's `modelsDown`: T-271, arch 06 line 293) sends the
//          composed plan as the rewrite attempt, unchanged, so its miss stands and the step's fallback runs; never the
//          outage line, which is only for a text whose turn has not committed.
//        - emailCopy: no composer call and no finalize call. Once its text row's final parts are written in this run, the
//          copy takes that row's plan (copyOf the text row, its own row, channel email: plan-email-copy.json) and its final
//          parts (its own row and channel) through K-05 v1 `writePlan`. The email's own parts (the automated-assistant
//          line, the subject, typed options, the manage link) are the dispatcher's at send (C-129, T-264).
//   4. The dispatcher (C-124) is woken once, after every row's compose has ended, whatever each ended with, so the rows
//      written, a fixed line's included, go at once. A row left with no plan holds back only its own recipient's later
//      rows (K-05 v1 claimOutbox: commit order).
//
// Fails closed: a row whose compose cannot finish keeps no plan (`left`, with a label), so nothing is sent for it, and
// T-253's crash path composes it again from today's record (arch 11 line 576). A call answered transient, or whose answer
// was lost on its way, is sent once more as the same request (finalizeMessage and writePlan keep a written plan:
// alreadyPlanned). Never logged or put in a span: a plan's or a text's words, a check's detail, a slot's value (K-08 README
// line 79); the compose, fillAndChecks and rewriteOrFallback spans hold counts, labels and ids only.
//
// Not here: the step's fallback text and the passed-on line (the action layer's C-093, inside finalizeMessage), the
// composer itself (T-373 to T-375), paging the team (T-319), the crash path (T-253).

import { MODELS_DOWN } from "../outage/ai";
import { isLabel, type Outcome, type SpanFacts, type TraceContext } from "../trace";
import type { ModelCall, RowRef } from "../trace/types";
import type {
  CheckResult,
  ComposeInput,
  ComposeInputResponse,
  FinalizeMessageRequest,
  FinalParts,
  GateCommitted,
  MessagePlan,
  OutboxChannel,
  RowPlan,
  TurnCaller,
  TurnDeps,
  UnplannedOutboxRow,
} from "./types";

/** How many times one call is sent in all when it answers transient or its answer is lost: the first send and one more. */
export const SENDS_PER_CALL = 2;

// ---- what the second half gives ---------------------------------------------------------------------------------

/** How one committed row ended in this run. */
export interface RowComposed {
  readonly outboxRowId: string;
  /**
   * - `send`, `sendAndLog`, `passedOn`: finalizeMessage wrote the row's final parts with its plan (K-09 v1);
   * - `copied`: an email copy: its text row's plan and final parts were written into it (K-05 v1 writePlan), with no
   *   composer call;
   * - `planned`: the row held a plan already (an earlier run's: alreadyPlanned), so nothing was written now;
   * - `closed`: the row is no longer to be sent (rowClosed);
   * - `left`: nothing was written (`errorCode` says why): the row keeps no plan, and nothing is sent for it.
   */
  readonly result: "send" | "sendAndLog" | "passedOn" | "copied" | "planned" | "closed" | "left";
  /** For an email copy, the text row whose plan it takes; else null. */
  readonly copyOf: string | null;
  /** How many composer calls the row took: 0 (an email copy), 1, or 2 with the one rewrite. */
  readonly composerCalls: number;
  /** True when the one rewrite was asked for. */
  readonly rewrite: boolean;
  /** How many finalizeMessage calls the row took, a resend counted. */
  readonly finalizeCalls: number;
  /** The final parts the row holds now, as the store answered them; null when none. Kept in memory, never logged. */
  readonly finalParts: FinalParts | null;
  /** True when the row's question was withdrawn (passed on), so no clock arms for it (RULES 5.2). */
  readonly questionWithdrawn: boolean;
  /** The page to Rosie's team for a passed-on row (K-36 v1 team_pages, reason passed_on), or null. */
  readonly teamPageId: string | null;
  /** Why the row ended as it did, as a label; null when it went as planned. */
  readonly errorCode: string | null;
}

/** What the second half did for one committed turn. */
export interface ComposeReport {
  /** The rows the commit wrote that held no plan, each composed, copied, found planned or closed, or left, in commit order. */
  readonly rows: readonly RowComposed[];
  /** The commit's rows a fixed line goes in word for word, never composed, in commit order. */
  readonly fixedLineRows: readonly string[];
  /** Why the turn's rows with no plan could not be read (K-05 unplannedRows), so nothing was composed; else null. */
  readonly rowsError: string | null;
  /** True when the dispatcher took the wake; it is told once per committed turn, whether or not it took it. */
  readonly woken: boolean;
}

/** One committed turn, as the turn loop hands it over after its commit. */
export interface CommittedTurn {
  readonly set: TurnDeps;
  readonly turnId: string;
  /** The turn's handle (K-04 handles.id): the dispatcher's wake names it. */
  readonly handleId: string;
  /** The caller the commit went under: compose input and finalize go under the same one (K-09 v1 caller). */
  readonly caller: TurnCaller;
  readonly trace: TraceContext;
  /** K-09's committed answer, first or repeated. */
  readonly answer: GateCommitted;
  /** The rows T-267's replies wrote a fixed line's words into in this run. */
  readonly wordsWritten: readonly string[];
}

// ---- reading answers ------------------------------------------------------------------------------------------------

const CHANNELS: readonly OutboxChannel[] = ["imessage", "rcs", "sms", "email"];
const WRITTEN_OUTCOMES: readonly FinalWritten["outcome"][] = ["send", "sendAndLog", "passedOn"];
const ATTEMPTS: readonly CheckResult["attempt"][] = ["composed", "rewrite", "fallback"];

/** Codes a call is sent once more on: nothing was written (transient), or the answer was lost on its way. */
const RESEND_CODES: ReadonlySet<string> = new Set(["transient", "noAnswer"]);
/** Codes that say a call could not run (failed) rather than that it was refused. */
const FAILED_CODES: ReadonlySet<string> = new Set(["noAnswer", "transient", "badAnswer", "unwired"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is string => typeof value === "string" && value !== "";

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);

/** An error code as a span may carry it: the code when it is a label, else badAnswer. */
const codeOf = (error: unknown): string => (isLabel(error) ? error : "badAnswer");

const failedOrRefused = (code: string): Outcome => (FAILED_CODES.has(code) ? "failed" : "refused");

/** A call's answer that is not the one wanted: its error code (a label), with the answer kept to read an error's fields. */
interface Refused {
  readonly refused: string;
  readonly answer: unknown;
}

const isRefused = (value: object): value is Refused => "refused" in value;

/** An answer that is a K-09 or K-05 error is refused with its code; anything else that is not the contract's: badAnswer. */
const refusedOf = (answer: unknown): Refused => ({
  refused: isRecord(answer) ? codeOf(answer.error) : "badAnswer",
  answer,
});

const BAD_ANSWER: Refused = { refused: "badAnswer", answer: null };
const NO_ANSWER: Refused = { refused: "noAnswer", answer: null };

/**
 * Sends a call and reads its answer; one answered transient, or lost on its way (a throw: `noAnswer`), is sent once more,
 * as the same request. Never throws for the call's own failure.
 */
async function twice<T extends object>(
  send: () => Promise<unknown>,
  read: (answer: unknown) => T | Refused,
): Promise<T | Refused> {
  let last: T | Refused = NO_ANSWER;
  for (let sent = 1; sent <= SENDS_PER_CALL; sent += 1) {
    const answer = await settled(send);
    last = answer.lost ? NO_ANSWER : read(answer.value);
    if (!isRefused(last) || !RESEND_CODES.has(last.refused)) return last;
  }
  return last;
}

/** A call's answer, or that it was lost on its way (it threw); never a throw. */
async function settled(
  call: () => Promise<unknown>,
): Promise<{ lost: false; value: unknown } | { lost: true }> {
  try {
    return { lost: false, value: await call() };
  } catch {
    return { lost: true };
  }
}

/** K-05 v1 `unplannedRows`' rows, by row id; refused when the answer is not the contract's. */
function listedOf(answer: unknown): { rows: ReadonlyMap<string, UnplannedOutboxRow> } | Refused {
  if (!isRecord(answer) || answer.result !== "rows" || !Array.isArray(answer.rows)) return refusedOf(answer);
  const rows = new Map<string, UnplannedOutboxRow>();
  for (const value of answer.rows as unknown[]) {
    if (!isRecord(value) || !isId(value.outboxRowId) || !isId(value.recipientHandleId)) return BAD_ANSWER;
    const { version, commitSeq, channel } = value;
    const copyOfRowId =
      value.copyOfRowId === null ? null : isId(value.copyOfRowId) ? value.copyOfRowId : undefined;
    if (!isCount(version) || version < 1 || !isCount(commitSeq) || !oneOf(CHANNELS, channel))
      return BAD_ANSWER;
    if (copyOfRowId === undefined) return BAD_ANSWER;
    rows.set(value.outboxRowId, {
      outboxRowId: value.outboxRowId,
      version,
      commitSeq,
      recipientHandleId: value.recipientHandleId,
      channel,
      copyOfRowId,
    });
  }
  return { rows };
}

/** K-09 `composeInput`'s answer for this row of this turn: the input for this row, or the text row an email copy takes. */
function composeInputOf(
  answer: unknown,
  row: UnplannedOutboxRow,
  turnId: string,
): ComposeInputResponse | Refused {
  if (!isRecord(answer)) return BAD_ANSWER;
  if (answer.result === "compose") {
    const input = answer.input;
    // K-03 composeInput names its row and the turn that committed it: an input for another row is not taken.
    if (!isRecord(input) || input.row !== row.outboxRowId || input.turn !== turnId) return BAD_ANSWER;
    return { result: "compose", input: input as ComposeInput };
  }
  if (answer.result === "emailCopy") {
    return isId(answer.textRowId) ? { result: "emailCopy", textRowId: answer.textRowId } : BAD_ANSWER;
  }
  return refusedOf(answer);
}

/** What a composer call gave: the plan, or why there is none (a label); and the model calls it reported. */
interface Planned {
  readonly plan: MessagePlan | null;
  readonly code: string | null;
  readonly modelCalls: ModelCall[];
}

function isPlan(value: unknown): value is MessagePlan {
  if (!isRecord(value) || !Array.isArray(value.formats) || value.formats.length === 0) return false;
  if (!Array.isArray(value.lines)) return false;
  return "question" in value && "pageType" in value && "threadReplyTo" in value;
}

/** The model calls a composer call reports, for its span (K-08 v1 `modelCall`; the trace checks each one). */
function modelCallsOf(value: unknown): ModelCall[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).filter(
    (call): call is ModelCall => isRecord(call) && typeof call.model === "string",
  );
}

/** A composer call's answer as a plan, or why there is none. */
async function planOf(call: () => Promise<unknown>): Promise<Planned> {
  const answer = await settled(call);
  if (answer.lost) return { plan: null, code: "noAnswer", modelCalls: [] };
  const value = answer.value;
  if (!isRecord(value)) return { plan: null, code: "badAnswer", modelCalls: [] };
  const modelCalls = modelCallsOf(value.modelCalls);
  if (value.result === "planned" && isPlan(value.plan)) return { plan: value.plan, code: null, modelCalls };
  return { plan: null, code: value.result === "planned" ? "badAnswer" : codeOf(value.error), modelCalls };
}

function isCheckResult(value: unknown): value is CheckResult {
  if (!isRecord(value) || !oneOf(ATTEMPTS, value.attempt) || typeof value.outcome !== "string") return false;
  if (!Array.isArray(value.checks)) return false;
  return (value.checks as unknown[]).every(
    (check) =>
      isRecord(check) &&
      typeof check.check === "string" &&
      typeof check.passed === "boolean" &&
      (check.detail === null || typeof check.detail === "string"),
  );
}

/** K-03 final parts for this row, on its channel (that the final parts' row is this row is a code check: K-05 item 2). */
function isFinalPartsOf(value: unknown, row: UnplannedOutboxRow): value is FinalParts {
  if (!isRecord(value) || value.row !== row.outboxRowId || value.channel !== row.channel) return false;
  const { sends, fixedLines, slotValues, threadReplyTo } = value;
  if (!Array.isArray(sends) || sends.length < 1 || sends.length > 2) return false;
  if (!Array.isArray(fixedLines) || !(fixedLines as unknown[]).every(isId) || !Array.isArray(slotValues))
    return false;
  return threadReplyTo === null || isId(threadReplyTo);
}

/** finalizeMessage asked for the one rewrite: nothing was written. */
interface RewriteAsked {
  readonly outcome: "rewrite";
  readonly checks: readonly CheckResult[];
}

/** finalizeMessage wrote the row's final parts with its plan: sent, sent and logged, or the passed-on line. */
interface FinalWritten {
  readonly outcome: "send" | "sendAndLog" | "passedOn";
  readonly checks: readonly CheckResult[];
  readonly finalParts: FinalParts;
  readonly questionWithdrawn: boolean;
  readonly teamPageId: string | null;
}

type Finalized = RewriteAsked | FinalWritten;

/**
 * K-09 `finalizeMessage`'s answer for this row: send, sendAndLog or passedOn with this row's final parts, or rewrite with
 * none; one or two check results. A K-09 error is refused with its code (alreadyPlanned keeps the stored final parts).
 */
function finalizedOf(answer: unknown, row: UnplannedOutboxRow): Finalized | Refused {
  if (!isRecord(answer) || !(answer.outcome === "rewrite" || oneOf(WRITTEN_OUTCOMES, answer.outcome))) {
    return refusedOf(answer);
  }
  const { checks, finalParts, questionWithdrawn, teamPageId } = answer;
  if (!Array.isArray(checks) || checks.length < 1 || checks.length > 2) return BAD_ANSWER;
  if (!(checks as unknown[]).every(isCheckResult)) return BAD_ANSWER;
  if (typeof questionWithdrawn !== "boolean" || !(teamPageId === null || isId(teamPageId))) return BAD_ANSWER;
  const results = checks as CheckResult[];
  if (answer.outcome === "rewrite") {
    return finalParts === null ? { outcome: "rewrite", checks: results } : BAD_ANSWER;
  }
  if (!oneOf(WRITTEN_OUTCOMES, answer.outcome) || !isFinalPartsOf(finalParts, row)) return BAD_ANSWER;
  return { outcome: answer.outcome, checks: results, finalParts, questionWithdrawn, teamPageId };
}

/** K-05 `writePlan`'s answer for this row: written, or refused with its code (alreadyPlanned: the row keeps its plan). */
function writtenOf(row: UnplannedOutboxRow): (answer: unknown) => { version: number } | Refused {
  return (answer) => {
    if (!isRecord(answer) || answer.result !== "written") return refusedOf(answer);
    if (answer.outboxRowId !== row.outboxRowId || !isCount(answer.version)) return BAD_ANSWER;
    return { version: answer.version };
  };
}

/** Each failed check of the attempt the composer wrote, with its detail: all the one rewrite is told (default 32). */
function failedChecksOf(checks: readonly CheckResult[]): { check: string; detail: string | null }[] {
  const tried = checks.find((result) => result.attempt !== "fallback") ?? checks[0];
  return (tried?.checks ?? [])
    .filter((check) => !check.passed)
    .map((check) => ({ check: check.check, detail: check.detail }));
}

// ---- which rows ---------------------------------------------------------------------------------------------------

/** The rows the commit wrote, in commit order, each once. */
function committedRowIds(answer: GateCommitted): string[] {
  const ids: string[] = [];
  for (const row of answer.written.outboxRows) {
    if (isId(row.id) && !ids.includes(row.id)) ids.push(row.id);
  }
  return ids;
}

function addRow(rows: Set<string>, value: unknown): void {
  if (isId(value)) rows.add(value);
}

/**
 * The rows a fixed line goes in word for word, never composed (STATE note 17): those the commit's core results name for a
 * fixed line (K-09 v1 recordStopOrStart's reply and, v1.1, each business told; sendFixedLine's row; recordSafetyOutcome's
 * safety line), and every row the guard's replies wrote a fixed line's words into.
 */
function fixedLineRowsOf(answer: GateCommitted, wordsWritten: readonly string[]): Set<string> {
  const rows = new Set<string>();
  for (const id of wordsWritten) addRow(rows, id);
  for (const result of answer.core) {
    const response = result.response;
    if (!isRecord(response)) continue;
    if (result.call === "recordStopOrStart") {
      addRow(rows, isRecord(response.reply) ? response.reply.outboxRowId : null);
      const told: unknown = response.businessesTold;
      for (const business of Array.isArray(told) ? (told as unknown[]) : []) {
        addRow(rows, isRecord(business) ? business.outboxRowId : null);
      }
    } else if (result.call === "sendFixedLine") {
      addRow(rows, response.outboxRowId);
    } else if (result.call === "recordSafetyOutcome") {
      addRow(rows, isRecord(response.safetyLine) ? response.safetyLine.outboxRowId : null);
    }
  }
  return rows;
}

// ---- the second half ------------------------------------------------------------------------------------------------

/**
 * Composes every row the commit wrote that holds no plan and is no fixed line's, the rows in parallel, then wakes the
 * dispatcher once. Never throws for an outside failure: each row's result says how it ended.
 */
export async function composeCommitted(turn: CommittedTurn): Promise<ComposeReport> {
  const committed = committedRowIds(turn.answer);
  const fixed = fixedLineRowsOf(turn.answer, turn.wordsWritten);
  const listed = await twice(() => turn.set.rows.unplannedRows({ turnId: turn.turnId }), listedOf);
  let rows: RowComposed[] = [];
  let rowsError: string | null = null;
  if (isRefused(listed)) {
    rowsError = listed.refused;
  } else {
    const toCompose = committed
      .filter((id) => !fixed.has(id))
      .flatMap((id) => {
        const row = listed.rows.get(id);
        return row === undefined ? [] : [row];
      });
    rows = await composeRows(turn, toCompose);
  }
  const woken = await wake(turn, committed);
  return { rows, fixedLineRows: committed.filter((id) => fixed.has(id)), rowsError, woken };
}

/** What one row's compose gave: its result, and the plan and final parts this run wrote into it, which a copy takes. */
interface RowWork {
  readonly report: RowComposed;
  readonly stored: { readonly plan: RowPlan; readonly finalParts: FinalParts } | null;
}

/** The text row an email copy takes its plan from: its compose, when this run composes it; else null. */
type TextOf = (textRowId: string) => Promise<RowWork> | null;

/** Starts every row's compose at once (arch 07 line 397: in parallel) and gives their results in the same order. */
async function composeRows(turn: CommittedTurn, rows: readonly UnplannedOutboxRow[]): Promise<RowComposed[]> {
  const byId = new Map(rows.map((row) => [row.outboxRowId, row]));
  const works = new Map<string, Promise<RowWork>>();
  // A copy takes only a row the composer plans (no copyOfRowId of its own), so no copy ever waits on another copy.
  const textOf: TextOf = (textRowId) =>
    byId.get(textRowId)?.copyOfRowId === null ? (works.get(textRowId) ?? null) : null;
  for (const row of rows) works.set(row.outboxRowId, composeRow(turn, row, textOf));
  const done = await Promise.all(works.values());
  return done.map((work) => work.report);
}

/** What a row's result says besides how it ended. */
type RowFacts = Partial<Omit<RowComposed, "outboxRowId" | "result" | "errorCode">>;

function reportOf(
  row: UnplannedOutboxRow,
  result: RowComposed["result"],
  errorCode: string | null,
  facts: RowFacts,
): RowComposed {
  return {
    outboxRowId: row.outboxRowId,
    result,
    copyOf: facts.copyOf ?? null,
    composerCalls: facts.composerCalls ?? 0,
    rewrite: facts.rewrite ?? false,
    finalizeCalls: facts.finalizeCalls ?? 0,
    finalParts: facts.finalParts ?? null,
    questionWithdrawn: facts.questionWithdrawn ?? false,
    teamPageId: facts.teamPageId ?? null,
    errorCode,
  };
}

/** A row that ended with nothing written into it by this run. */
function ended(
  row: UnplannedOutboxRow,
  result: "planned" | "closed" | "left",
  errorCode: string | null,
  facts: RowFacts = {},
): RowWork {
  return { report: reportOf(row, result, errorCode, facts), stored: null };
}

/** How a refused call ends a row: a plan already there, a closed row, or left with the code. */
function endedBy(row: UnplannedOutboxRow, refused: Refused, facts: RowFacts): RowWork {
  if (refused.refused === "rowClosed") return ended(row, "closed", "rowClosed", facts);
  if (refused.refused !== "alreadyPlanned") return ended(row, "left", refused.refused, facts);
  // finalizeMessage's alreadyPlanned brings the stored final parts back (K-09 v1 FinalizeAlreadyPlannedError).
  const stored = isRecord(refused.answer) ? refused.answer.finalParts : null;
  const finalParts = isFinalPartsOf(stored, row) ? stored : null;
  return ended(row, "planned", "alreadyPlanned", { ...facts, finalParts });
}

/** One row: its compose input, then the composer and finalize, or, for an email copy, its text row's plan. */
async function composeRow(turn: CommittedTurn, row: UnplannedOutboxRow, textOf: TextOf): Promise<RowWork> {
  const asked = await twice(
    () =>
      turn.set.toolApi.composeInput({ caller: { ...turn.caller }, outboxRowId: row.outboxRowId }, turn.trace),
    (answer) => composeInputOf(answer, row, turn.turnId),
  );
  if (isRefused(asked)) return endedBy(row, asked, {});
  if (asked.result === "emailCopy") {
    // The Tool API and the row agree on the text row, or nothing is copied (never another row's plan).
    if (row.copyOfRowId !== asked.textRowId) return ended(row, "left", "copyMismatch");
    return copyRow(turn, row, asked.textRowId, textOf);
  }
  // A row stored as an email copy is never composed.
  if (row.copyOfRowId !== null) return ended(row, "left", "copyMismatch");
  return composeAndFinalize(turn, row, asked.input);
}

type Timer = ReturnType<TraceContext["start"]>;

/** The composer's plan, finalize with attempt composed, and at most one rewrite with finalize again. */
async function composeAndFinalize(
  turn: CommittedTurn,
  row: UnplannedOutboxRow,
  input: ComposeInput,
): Promise<RowWork> {
  const composeSpan = turn.trace.start("compose");
  const planned = await planOf(() => turn.set.composer.compose(input, turn.trace));
  recordCompose(turn, composeSpan, row, input, planned);
  const composed = planned.plan;
  if (composed === null) return ended(row, "left", planned.code, { composerCalls: 1 });

  const plan: RowPlan = { row: row.outboxRowId, channel: row.channel, copyOf: null, plan: composed };
  const checksSpan = turn.trace.start("fillAndChecks");
  const first = await finalize(turn, row, "composed", plan);
  recordChecks(turn, checksSpan, row, first.answer, first.calls);
  let finalizeCalls = first.calls;
  if (isRefused(first.answer)) return endedBy(row, first.answer, { composerCalls: 1, finalizeCalls });
  if (first.answer.outcome !== "rewrite") {
    return written(row, plan, first.answer, { composerCalls: 1, finalizeCalls });
  }

  // The one rewrite (arch 02 line 123; arch 07 line 417), told only what failed.
  const rewriteSpan = turn.trace.start("rewriteOrFallback");
  const failed = failedChecksOf(first.answer.checks);
  const rewritten = await planOf(() =>
    turn.set.composer.rewrite({ input, plan: composed, failed }, turn.trace),
  );
  const facts: RowFacts = { composerCalls: 2, rewrite: true };
  // The models are down after the commit (T-271; arch 06 line 293: "after it, step 7's fallback for that row"): no
  // rewrite can be made, so the composed plan goes as the rewrite attempt, unchanged. Its blocking miss stands, and
  // finalize fills the step's fallback text, or the passed-on line, in the same call (K-09 README default 11). Never the
  // outage line: that is for a text whose turn has not committed.
  const modelsDown = rewritten.plan === null && rewritten.code === MODELS_DOWN;
  if (rewritten.plan === null && !modelsDown) {
    const refused: Refused = { refused: rewritten.code ?? "badAnswer", answer: null };
    recordRewrite(turn, rewriteSpan, row, failed, rewritten, refused, 0);
    return ended(row, "left", refused.refused, { ...facts, finalizeCalls });
  }
  const rewrittenPlan: RowPlan = rewritten.plan === null ? plan : { ...plan, plan: rewritten.plan };
  const second = await finalize(turn, row, "rewrite", rewrittenPlan);
  finalizeCalls += second.calls;
  // Never a second rewrite: a rewrite answered "rewrite" again is not K-09's (the fallback is code's, in the same call).
  const last: FinalWritten | Refused =
    isRefused(second.answer) || second.answer.outcome !== "rewrite" ? second.answer : BAD_ANSWER;
  recordRewrite(turn, rewriteSpan, row, failed, rewritten, last, second.calls);
  if (isRefused(last)) return endedBy(row, last, { ...facts, finalizeCalls });
  return written(row, rewrittenPlan, last, { ...facts, finalizeCalls });
}

/** One finalizeMessage, sent once more when it answers transient or its answer is lost; with how many calls it took. */
async function finalize(
  turn: CommittedTurn,
  row: UnplannedOutboxRow,
  attempt: FinalizeMessageRequest["attempt"],
  plan: RowPlan,
): Promise<{ answer: Finalized | Refused; calls: number }> {
  const request: FinalizeMessageRequest = {
    caller: { ...turn.caller },
    outboxRowId: row.outboxRowId,
    expectVersion: row.version,
    attempt,
    plan,
  };
  let calls = 0;
  const answer = await twice(
    () => {
      calls += 1;
      return turn.set.toolApi.finalizeMessage(request, turn.trace);
    },
    (value) => finalizedOf(value, row),
  );
  return { answer, calls };
}

/** A row whose final parts finalizeMessage wrote with its plan: the plan and final parts an email copy of it takes. */
function written(row: UnplannedOutboxRow, plan: RowPlan, answer: FinalWritten, facts: RowFacts): RowWork {
  const report = reportOf(row, answer.outcome, null, {
    ...facts,
    finalParts: answer.finalParts,
    questionWithdrawn: answer.questionWithdrawn,
    teamPageId: answer.teamPageId,
  });
  return { report, stored: { plan, finalParts: answer.finalParts } };
}

/**
 * An email copy (arch 07 lines 371, 397): no composer call and no finalize call. Its text row's plan, with copyOf naming
 * that row, and its text row's final parts, on its own row and the email channel, go into it through K-05 writePlan,
 * once the text row's final parts are written in this run.
 */
async function copyRow(
  turn: CommittedTurn,
  row: UnplannedOutboxRow,
  textRowId: string,
  textOf: TextOf,
): Promise<RowWork> {
  const facts: RowFacts = { copyOf: textRowId };
  if (row.channel !== "email") return ended(row, "left", "copyNotEmail", facts);
  const pending = textOf(textRowId);
  if (pending === null) return ended(row, "left", "noTextRow", facts);
  const text = (await pending).stored;
  // The text row's plan is not known to this run (it was planned before, or it was left): nothing is copied now.
  if (text === null) return ended(row, "left", "noTextPlan", facts);
  const plan: RowPlan = {
    row: row.outboxRowId,
    channel: row.channel,
    copyOf: textRowId,
    plan: structuredClone(text.plan.plan),
  };
  const finalParts: FinalParts = {
    ...structuredClone(text.finalParts),
    row: row.outboxRowId,
    channel: row.channel,
  };
  const span = turn.trace.start("fillAndChecks");
  const wrote = await twice(
    () =>
      turn.set.rows.writePlan({ outboxRowId: row.outboxRowId, expectVersion: row.version, plan, finalParts }),
    writtenOf(row),
  );
  recordCopy(turn, span, row, textRowId, wrote);
  if (isRefused(wrote)) return endedBy(row, wrote, facts);
  return { report: reportOf(row, "copied", null, { ...facts, finalParts }), stored: null };
}

/** Wakes the dispatcher once for the committed turn; a dispatcher that does not take it leaves the rows to its sweep. */
async function wake(turn: CommittedTurn, outboxRowIds: readonly string[]): Promise<boolean> {
  const woken = await settled(() =>
    turn.set.dispatcher.wake(
      { turnId: turn.turnId, handleId: turn.handleId, outboxRowIds: [...outboxRowIds] },
      turn.trace,
    ),
  );
  // Not taken: the minute sweep claims every recipient's sendable rows (runtime/src/dispatch, no recipient named).
  return !woken.lost;
}

// ---- spans (K-08 v1: labels, counts and ids only) -----------------------------------------------------------------

const labelOrNull = (value: unknown): string | null => (isLabel(value) ? value : null);

const labelsOf = (value: unknown): string[] =>
  Array.isArray(value) ? (value as unknown[]).filter(isLabel) : [];

const countOf = (value: unknown): number => (Array.isArray(value) ? value.length : 0);

/** The row a span wrote (K-08 v1 rowRef: table and id), or none. */
const rowsOf = (row: UnplannedOutboxRow, wrote: boolean): RowRef[] =>
  wrote && isLabel(row.outboxRowId) ? [{ table: "outbox_rows", id: row.outboxRowId }] : [];

const businessOf = (turn: CommittedTurn): { businessId?: string } =>
  isLabel(turn.caller.businessId) ? { businessId: turn.caller.businessId } : {};

const withCalls = (modelCalls: ModelCall[]): { modelCalls?: ModelCall[] } =>
  modelCalls.length > 0 ? { modelCalls } : {};

/** What a composer was given, as a span may say it: never a word of it. */
function inputFacts(row: UnplannedOutboxRow, input: ComposeInput): SpanFacts {
  return {
    row: labelOrNull(row.outboxRowId),
    channel: labelOrNull(input.channel),
    situation: labelOrNull(input.situation),
    allowedFormats: labelsOf(input.allowedFormats),
    facts: countOf(input.facts),
    options: countOf(input.options),
    inbound: isRecord(input.inbound),
  };
}

/** What a plan holds, as a span may say it: its formats and counts, never its words. */
function planFacts(plan: MessagePlan): SpanFacts {
  return {
    formats: labelsOf(plan.formats),
    lines: plan.lines.length,
    question: plan.question !== null,
    optionIds: plan.question?.optionIds.length ?? 0,
  };
}

const failedNames = (result: CheckResult | undefined): string[] =>
  (result?.checks ?? [])
    .filter((check) => !check.passed)
    .map((check) => check.check)
    .filter(isLabel);

/** What finalize decided, as a span may say it: the outcome, the failed checks' names, the fixed lines' ids, counts. */
function checkFacts(answer: Finalized): SpanFacts {
  const [tried, fallback] = answer.checks;
  const facts: SpanFacts = {
    outcome: answer.outcome,
    failed: failedNames(tried),
    fallback: fallback !== undefined,
    fallbackFailed: failedNames(fallback),
  };
  if (answer.outcome === "rewrite") return facts;
  return {
    ...facts,
    fixedLines: labelsOf(answer.finalParts.fixedLines),
    sends: answer.finalParts.sends.length,
    questionWithdrawn: answer.questionWithdrawn,
    teamPaged: answer.teamPageId !== null,
  };
}

/** A finalize span's outcome: ok when final parts are in the row (sent, logged, passed on, or there already); a rewrite is refused. */
function finalizeOutcome(answer: Finalized | Refused): Outcome {
  if (isRefused(answer)) return answer.refused === "alreadyPlanned" ? "ok" : failedOrRefused(answer.refused);
  return answer.outcome === "rewrite" ? "refused" : "ok";
}

const wroteRow = (answer: Finalized | Refused): boolean => !isRefused(answer) && answer.outcome !== "rewrite";

function recordCompose(
  turn: CommittedTurn,
  span: Timer,
  row: UnplannedOutboxRow,
  input: ComposeInput,
  planned: Planned,
): void {
  finish(span, {
    outcome: planned.plan === null ? failedOrRefused(planned.code ?? "badAnswer") : "ok",
    ...businessOf(turn),
    got: inputFacts(row, input),
    ...(planned.plan === null ? {} : { decided: planFacts(planned.plan) }),
    ...withCalls(planned.modelCalls),
    errorCode: planned.code,
  });
}

function recordChecks(
  turn: CommittedTurn,
  span: Timer,
  row: UnplannedOutboxRow,
  answer: Finalized | Refused,
  calls: number,
): void {
  finish(span, {
    outcome: finalizeOutcome(answer),
    ...businessOf(turn),
    got: { row: labelOrNull(row.outboxRowId), attempt: "composed", calls },
    ...(isRefused(answer) ? {} : { decided: checkFacts(answer) }),
    rows: rowsOf(row, wroteRow(answer)),
    errorCode: isRefused(answer) ? answer.refused : null,
  });
}

function recordRewrite(
  turn: CommittedTurn,
  span: Timer,
  row: UnplannedOutboxRow,
  failed: readonly { check: string }[],
  rewritten: Planned,
  answer: Finalized | Refused,
  calls: number,
): void {
  finish(span, {
    outcome: finalizeOutcome(answer),
    ...businessOf(turn),
    got: {
      row: labelOrNull(row.outboxRowId),
      attempt: "rewrite",
      told: failed.map((check) => check.check).filter(isLabel),
      planned: rewritten.plan !== null,
      calls,
    },
    ...(isRefused(answer) ? {} : { decided: checkFacts(answer) }),
    rows: rowsOf(row, wroteRow(answer)),
    ...withCalls(rewritten.modelCalls),
    errorCode: isRefused(answer) ? answer.refused : null,
  });
}

function recordCopy(
  turn: CommittedTurn,
  span: Timer,
  row: UnplannedOutboxRow,
  textRowId: string,
  wrote: { version: number } | Refused,
): void {
  const code = isRefused(wrote) ? wrote.refused : null;
  finish(span, {
    outcome: code === null || code === "alreadyPlanned" ? "ok" : failedOrRefused(code),
    ...businessOf(turn),
    got: { row: labelOrNull(row.outboxRowId), copyOf: labelOrNull(textRowId), channel: row.channel },
    decided: { result: code ?? "copied" },
    rows: rowsOf(row, code === null),
    errorCode: code,
  });
}

/** Records a span; a span the trace refuses is not kept, and the row's compose goes on. */
function finish(span: Timer, fields: Parameters<Timer["finish"]>[0]): void {
  try {
    span.finish(fields);
  } catch {
    // No span for this step; what the step did stands.
  }
}
