// The guard's fixed replies (T-267; C-052; arch 02 step 3, architecture.txt line 115; arch 10 'Phone number', line 524).
// The guard (../guard.ts) hands its keyword texts here: a stop word, START or HELP alone gets its fixed reply from code,
// never from the model or the composer.
//
//   1. Each keyword text becomes one K-09 v1 core action, in arrival order, all carried in the keyword turn's one commit
//      (a bare STOP runs in its own core-only turn: K-09 README default 35; stop-recorded.json):
//        - a stop word (any of the bundle's 16 opt-out words) is `recordStopOrStart` kind stop. The core sets the phone's
//          stopped flag, one flag for the number and so for every business (MC C1; D102), closes its chat, and adds K-29's
//          texts row that withdraws texts with no business, so for every business. CANCEL and CANCELAR also flag the
//          visit (`alsoCancelVisit`; RULES 7.4);
//        - START is `recordStopOrStart` kind start, from that text's own number and event: only START clears the flag
//          (RULES 7.5; MC C1; QUESTIONS.md CQ-74's default);
//        - HELP is `sendFixedLine` helpReply, a reply in the same turn (quick_reply; Q-15), to everyone (QUESTIONS.md
//          M3-M3b.2's default). From a stopped number the core refuses it (`phoneStopped`): that number's one reply to a
//          later text is T-268's.
//      A STOP is a protective change: nothing here waits on a safety hold, and the gate commits it under any hold (DL-128;
//      QUESTIONS.md CQ-65).
//   2. The core writes each reply as an outbox row of send class quick_reply (K-09 README default 6) and, for a STOP, one
//      row to the owner of each business with an open booking for that phone (v1.1 `businessesTold`, README default 50:
//      "Texts to this customer are off. Reach them their way."). After the commit, code writes each of those fixed lines'
//      words into its row, word for word, with a plan of no lines of its own (K-05 v1 `writePlan`, as
//      write-plan-alex-safety.json): the replies' words from words.ts, the notice's as K-01 writes it. Only the turn's
//      rows that still have no plan are written (K-05 v1 `unplannedRows`), so a rerun writes what a crash left and never
//      writes a row twice.
//   3. The dispatcher sends the rows, limit 8 deciding each (runtime/src/dispatch): the stop reply carries `stopReply` in
//      its fixed lines, so it goes to the stopped phone with Linq's override_optout (arch 10 line 524; K-11
//      send-override-optout.json), while every other row for that phone, from any business, is dropped.
//
// Fails closed: unwired (before D-017), a commit with no answer, or an answer that is not the contract's records
// nothing here and says so (`notRecorded`): the turn must run again. Sending these while PostgreSQL is down is T-269's
// and T-270's. Each keyword text gets one `fillAndChecks` span (K-08): labels and counts only, never a number, a text's
// words or a reply's words.

import type { PinnedBundle } from "../../bundle";
import { isLabel, type SpanFacts, type TraceContext } from "../../trace";
import { keyOf } from "../keywords";
import type { GuardText, Keyword, KeywordText } from "../types";
import type {
  BusinessTold,
  Channel,
  FixedLineRow,
  ReplyCoreAction,
  ReplyDeps,
  ReplyOutcome,
  TurnCaller,
  UnplannedRow,
  WordsFrom,
  WritePlanRequest,
} from "./types";
import { HELP_REPLY, fixedLinesOf, wordsFor } from "./words";

let deps: ReplyDeps | null = null;

/** Sets what the guard's replies need for this Worker isolate; returns the function that puts the earlier one back. */
export function setReplyDeps(next: ReplyDeps | null): () => void {
  const before = deps;
  deps = next;
  return () => {
    deps = before;
  };
}

/** One keyword turn, as the turn loop hands it over with the guard's `keywords` (T-251). */
export interface ReplyTurn<T extends GuardText> {
  /** The turn's id (K-04 turns.id): the commit's key, and the K-09 caller's turn and request id. */
  turnId: string;
  /** The turn's handle (K-04 handles.id): HELP's reply goes to it. */
  handleId: string;
  /** The handle's own number (E.164), which a STOP or a START is for; null for an email handle. Never logged. */
  phoneNumber: string | null;
  /** The person the handle is, when known (K-09 caller.personId). */
  personId: string | null;
  /** The turn's trace id (LeasedTurn.traceId; K-09 caller.traceId). */
  traceId: string;
  /** The guard's keyword texts, in arrival order (`GuardResult.keywords`). */
  keywords: readonly KeywordText<T>[];
  /** The bundle pinned for the turn: its manifest holds K-01's fixed lines. */
  bundle: Pick<PinnedBundle, "manifest">;
  /** The turn's trace: each keyword text's span goes on it. */
  trace: TraceContext;
}

/** How one keyword text's reply went. */
export interface KeywordReply<T extends GuardText> {
  readonly text: T;
  readonly keyword: Keyword;
  readonly outcome: ReplyOutcome;
  /** The reply's fixed line (K-01 id), or null when there is none. */
  readonly line: string | null;
  /** Where the reply's words came from, when this run wrote them. */
  readonly words: WordsFrom | null;
  /** The phone's stopped flag after a recorded STOP or START (K-04 phones.stopped, every business); else null. */
  readonly stopped: boolean | null;
  /** The rows whose words this run wrote: the reply's, then each business's notice. */
  readonly rowsWritten: readonly string[];
  /** The businesses told of a STOP (K-09 v1.1 `businessesTold`), whatever run wrote their rows. */
  readonly told: readonly string[];
  /** Why it did not go as planned, as a label; null when it did. */
  readonly errorCode: string | null;
}

export interface RepliesResult<T extends GuardText> {
  /** Each keyword text's reply, in arrival order. */
  readonly replies: readonly KeywordReply<T>[];
  /**
   * True when the turn must run again (or, with PostgreSQL down, T-269's path takes it): something was not recorded, or
   * a reply's words were left unwritten for a passing reason. A rerun repeats the commit, which answers its first
   * answers, and writes only the rows still without words.
   */
  readonly rerun: boolean;
}

const CHANNELS: readonly Channel[] = ["imessage", "rcs", "sms", "email"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is string => typeof value === "string" && value !== "";

const isIdOrNull = (value: unknown): value is string | null => value === null || isId(value);

/** An error code as a span may carry it: the code when it is a label, else badAnswer. */
const codeOf = (error: unknown): string => (isLabel(error) ? error : "badAnswer");

/** The words the person typed, as the guard read them: the body, or an email's subject when the body has none. */
function typedWords<T extends GuardText>(found: KeywordText<T>): string {
  const words = found.text.words;
  const body = words?.body ?? "";
  const read = keyOf(body) === "" ? (words?.subject ?? "") : body;
  return keyOf(read) === "" ? found.keyword.word : read;
}

/** The K-09 v1 core action for one keyword text; null for a STOP or a START when the turn has no number. */
export function actionFor<T extends GuardText>(
  found: KeywordText<T>,
  turn: Pick<ReplyTurn<T>, "handleId" | "phoneNumber">,
  caller: TurnCaller,
): ReplyCoreAction | null {
  const { keyword } = found;
  if (keyword.kind === "help") {
    return {
      call: "sendFixedLine",
      request: {
        caller,
        fixedLineId: HELP_REPLY,
        recipientHandleId: turn.handleId,
        sendClass: "quick_reply",
        sentByActor: null,
      },
    };
  }
  if (turn.phoneNumber === null) return null;
  return {
    call: "recordStopOrStart",
    request: {
      caller,
      kind: keyword.kind,
      phoneNumber: turn.phoneNumber,
      inboundEventId: found.text.eventId,
      words: typedWords(found),
      alsoCancelVisit: keyword.flagsVisit,
      workPhoneBusinessIds: null,
      sentByActor: null,
    },
  };
}

// ---- reading the core's answer (K-09 v1 CoreResult) ----------------------------------------------------------------

/** One core action's answer as the replies read it: refused with the core's code, or what it recorded. */
type Answered =
  | { refused: string }
  | { refused: null; stopped: boolean | null; reply: FixedLineRow | null; told: BusinessTold[] };

function fixedLineRowOf(value: unknown): FixedLineRow | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !isLabel(value.fixedLineId) || !isIdOrNull(value.outboxRowId)) return undefined;
  return { fixedLineId: value.fixedLineId, outboxRowId: value.outboxRowId };
}

/** v1.1's `businessesTold`; a v1 answer leaves it out, which tells no one. Undefined when it is not K-09's. */
function toldOf(value: unknown): BusinessTold[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const told: BusinessTold[] = [];
  for (const entry of value as unknown[]) {
    if (!isRecord(entry) || !isId(entry.businessId) || !isLabel(entry.fixedLineId)) return undefined;
    if (!isIdOrNull(entry.outboxRowId)) return undefined;
    told.push({
      businessId: entry.businessId,
      fixedLineId: entry.fixedLineId,
      outboxRowId: entry.outboxRowId,
    });
  }
  return told;
}

/** One `CoreResult` for its action, or undefined when it is not K-09's answer to that action. */
function answeredOf(entry: unknown, action: ReplyCoreAction): Answered | undefined {
  if (!isRecord(entry) || entry.call !== action.call) return undefined;
  if (entry.error !== null) {
    return isRecord(entry.error) && isLabel(entry.error.error) ? { refused: entry.error.error } : undefined;
  }
  const response = entry.response;
  if (!isRecord(response)) return undefined;
  if (action.call === "sendFixedLine") {
    if (!isIdOrNull(response.outboxRowId)) return undefined;
    const reply = { fixedLineId: action.request.fixedLineId, outboxRowId: response.outboxRowId };
    return { refused: null, stopped: null, reply, told: [] };
  }
  const reply = fixedLineRowOf(response.reply);
  const told = toldOf(response.businessesTold);
  if (typeof response.stopped !== "boolean" || reply === undefined || told === undefined) return undefined;
  return { refused: null, stopped: response.stopped, reply, told };
}

/** The commit's answers, one per action and in its order, or null when the answer is not K-09's for these actions. */
function answersOf(answer: unknown, actions: readonly ReplyCoreAction[]): Answered[] | null {
  if (!isRecord(answer) || answer.result !== "committed" || !Array.isArray(answer.core)) return null;
  const core = answer.core as unknown[];
  if (core.length !== actions.length) return null;
  const answers: Answered[] = [];
  for (const [index, action] of actions.entries()) {
    const answered = answeredOf(core[index], action);
    if (answered === undefined) return null;
    answers.push(answered);
  }
  return answers;
}

// ---- the words, written into the rows (K-05 v1 unplannedRows, writePlan) ----------------------------------------

/** K-05 v1 `writePlan.request` for a fixed line's row: the words, one part, the line's id; no lines of the plan's own. */
export function fixedLinePlan(row: UnplannedRow, fixedLineId: string, text: string): WritePlanRequest {
  return {
    outboxRowId: row.outboxRowId,
    expectVersion: row.version,
    plan: {
      row: row.outboxRowId,
      channel: row.channel,
      copyOf: null,
      plan: { formats: ["text"], lines: [], question: null, pageType: null, threadReplyTo: null },
    },
    finalParts: {
      row: row.outboxRowId,
      channel: row.channel,
      sends: [{ kind: "words", text, calendarFile: "none", options: [], link: null }],
      fixedLines: [fixedLineId],
      slotValues: [],
      threadReplyTo: null,
    },
  };
}

/** The turn's rows that still have no plan, read once, or why they could not be read. */
type Unplanned = { read: true; rows: ReadonlyMap<string, UnplannedRow> } | { read: false; errorCode: string };

function unplannedRowOf(value: unknown): UnplannedRow | null {
  if (!isRecord(value) || !isId(value.outboxRowId) || !isId(value.recipientHandleId)) return null;
  const { version, commitSeq, channel, copyOfRowId } = value;
  if (typeof version !== "number" || typeof commitSeq !== "number" || !isIdOrNull(copyOfRowId)) return null;
  if (!(CHANNELS as readonly unknown[]).includes(channel)) return null;
  return {
    outboxRowId: value.outboxRowId,
    version,
    commitSeq,
    recipientHandleId: value.recipientHandleId,
    channel: channel as Channel,
    copyOfRowId,
  };
}

async function unplannedOf(set: ReplyDeps, turnId: string): Promise<Unplanned> {
  let answer: unknown;
  try {
    answer = await set.rows.unplannedRows({ turnId });
  } catch {
    return { read: false, errorCode: "noAnswer" };
  }
  if (!isRecord(answer)) return { read: false, errorCode: "badAnswer" };
  if (answer.error !== undefined) return { read: false, errorCode: codeOf(answer.error) };
  if (answer.result !== "rows" || !Array.isArray(answer.rows)) return { read: false, errorCode: "badAnswer" };
  const rows = new Map<string, UnplannedRow>();
  for (const value of answer.rows as unknown[]) {
    const row = unplannedRowOf(value);
    if (row === null) return { read: false, errorCode: "badAnswer" };
    rows.set(row.outboxRowId, row);
  }
  return { read: true, rows };
}

/** What writing one row's words gave: written now, there already (an earlier run's), or why not. */
type Fill =
  { result: "written"; words: WordsFrom } | { result: "there" } | { result: "left"; errorCode: string };

async function fill(
  set: ReplyDeps,
  unplanned: Unplanned,
  lines: ReadonlyMap<string, string | null>,
  row: FixedLineRow & { outboxRowId: string },
): Promise<Fill> {
  if (!unplanned.read) return { result: "left", errorCode: unplanned.errorCode };
  const unplannedRow = unplanned.rows.get(row.outboxRowId);
  // Not among the turn's rows with no plan: an earlier run of this turn wrote its words already.
  if (unplannedRow === undefined) return { result: "there" };
  const words = wordsFor(row.fixedLineId, lines, set.rosieNumber);
  if (words === null) return { result: "left", errorCode: "noWords" };
  let answer: unknown;
  try {
    answer = await set.rows.writePlan(fixedLinePlan(unplannedRow, words.lineId, words.text));
  } catch {
    return { result: "left", errorCode: "noAnswer" };
  }
  if (!isRecord(answer)) return { result: "left", errorCode: "badAnswer" };
  if (answer.result === "written") return { result: "written", words: words.from };
  if (answer.error === "alreadyPlanned") return { result: "there" };
  return { result: "left", errorCode: codeOf(answer.error) };
}

// ---- the path --------------------------------------------------------------------------------------------------

const replyOf = <T extends GuardText>(
  found: KeywordText<T>,
  outcome: ReplyOutcome,
  errorCode: string | null,
): KeywordReply<T> => ({
  text: found.text,
  keyword: found.keyword,
  outcome,
  line: null,
  words: null,
  stopped: null,
  rowsWritten: [],
  told: [],
  errorCode,
});

/**
 * Records the turn's keyword texts through the shared core in its one commit, then writes each fixed reply's words, and
 * each STOP notice's, into its row by code. Never throws for an outside failure: each keyword text's outcome says how
 * it went, and `rerun` whether the turn must run again.
 */
export async function replyToKeywords<T extends GuardText>(turn: ReplyTurn<T>): Promise<RepliesResult<T>> {
  const timer = turn.trace.start("fillAndChecks");
  const caller: TurnCaller = {
    kind: "turn",
    turnId: turn.turnId,
    requestId: turn.turnId,
    businessId: null,
    personId: turn.personId,
    traceId: turn.traceId,
  };
  const acting: Acting<T>[] = [];
  const replies: KeywordReply<T>[] = turn.keywords.map((found, at) => {
    const action = actionFor(found, turn, caller);
    if (action === null) return replyOf(found, "refused", "noPhone");
    acting.push({ at, found, action });
    return replyOf(found, "notRecorded", "noAnswer");
  });

  const set = deps;
  if (acting.length > 0) {
    const answered =
      set === null
        ? acting.map(({ found }) => replyOf(found, "notRecorded", "unwired"))
        : await commitAndFill(set, turn, caller, acting);
    for (const [index, { at }] of acting.entries()) {
      const reply = answered[index];
      if (reply !== undefined) replies[at] = reply;
    }
  }

  for (const reply of replies) recordSpan(timer, reply);
  return { replies, rerun: replies.some(needsRerun) };
}

/**
 * Whether the turn must run again for this reply: nothing was recorded, or the words of its row or of a business's
 * notice were left unwritten for a reason a rerun can clear (no answer, a transient answer, a version that moved). Words
 * that do not exist (`noWords`) are not such a reason, nor a row the core did not write (`noRow`).
 */
const needsRerun = <T extends GuardText>(reply: KeywordReply<T>): boolean =>
  reply.outcome === "notRecorded" ||
  ((reply.outcome === "replied" || reply.outcome === "noWords") &&
    reply.errorCode !== null &&
    reply.errorCode !== "noWords");

/** A keyword text with a core action, and its place among the turn's keyword texts. */
interface Acting<T extends GuardText> {
  at: number;
  found: KeywordText<T>;
  action: ReplyCoreAction;
}

/** Each acting text's reply, in the same order as `acting`. */
async function commitAndFill<T extends GuardText>(
  set: ReplyDeps,
  turn: ReplyTurn<T>,
  caller: TurnCaller,
  acting: readonly Acting<T>[],
): Promise<KeywordReply<T>[]> {
  const actions = acting.map(({ action }) => action);
  let answer: unknown;
  let noAnswer = false;
  try {
    answer = await set.core.commitCore({ caller, actions });
  } catch {
    noAnswer = true;
  }
  const answers = noAnswer ? null : answersOf(answer, actions);
  if (answers === null) {
    const errorCode = noAnswer
      ? "noAnswer"
      : isRecord(answer) && answer.error !== undefined
        ? codeOf(answer.error)
        : "badAnswer";
    return acting.map(({ found }) => replyOf(found, "notRecorded", errorCode));
  }

  const lines = fixedLinesOf(turn.bundle.manifest);
  let unplanned: Unplanned | null = null;
  const unplannedRows = async (): Promise<Unplanned> => (unplanned ??= await unplannedOf(set, turn.turnId));

  const replies: KeywordReply<T>[] = [];
  for (const [index, { found }] of acting.entries()) {
    const answered = answers[index];
    if (answered === undefined) {
      replies.push(replyOf(found, "notRecorded", "badAnswer"));
      continue;
    }
    if (answered.refused !== null) {
      // The core refused this one action and wrote nothing for it; a transient refusal is not recorded.
      const outcome: ReplyOutcome = answered.refused === "transient" ? "notRecorded" : "refused";
      replies.push(replyOf(found, outcome, answered.refused));
      continue;
    }

    const { reply, stopped, told } = answered;
    const rowsWritten: string[] = [];
    let outcome: ReplyOutcome = "replied";
    let errorCode: string | null = null;
    let words: WordsFrom | null = null;

    if (reply === null) {
      outcome = "recordedNoReply"; // a work phone's STOP asks which texts instead (T-268)
    } else if (reply.outboxRowId === null) {
      outcome = "recordedNoReply";
      errorCode = "noRow";
    } else {
      const filled = await fill(set, await unplannedRows(), lines, {
        ...reply,
        outboxRowId: reply.outboxRowId,
      });
      if (filled.result === "written") {
        rowsWritten.push(reply.outboxRowId);
        words = filled.words;
      } else if (filled.result === "left") {
        outcome = "noWords";
        errorCode = filled.errorCode;
      }
    }

    // Each business's notice (RULES 7.5): its one fixed line, word for word, written by code like the reply's. A STOP
    // with no turn has no notice row yet: the clock turn of K-09 README default 56 writes it.
    for (const business of told) {
      if (business.outboxRowId === null) continue;
      const row = { fixedLineId: business.fixedLineId, outboxRowId: business.outboxRowId };
      const filled = await fill(set, await unplannedRows(), lines, row);
      if (filled.result === "written") rowsWritten.push(business.outboxRowId);
      else if (filled.result === "left") errorCode ??= filled.errorCode;
    }

    replies.push({
      text: found.text,
      keyword: found.keyword,
      outcome,
      line: reply?.fixedLineId ?? null,
      words,
      stopped,
      rowsWritten,
      told: told.map((business) => business.businessId),
      errorCode,
    });
  }
  return replies;
}

// ---- the span (K-08 v1) ----------------------------------------------------------------------------------------

const SPAN_OUTCOME: Record<ReplyOutcome, "ok" | "refused" | "failed"> = {
  replied: "ok",
  recordedNoReply: "ok",
  noWords: "failed",
  refused: "refused",
  notRecorded: "failed",
};

type Timer = ReturnType<TraceContext["start"]>;

/** One `fillAndChecks` span per keyword text: labels and counts only. A span the trace refuses is not kept. */
function recordSpan<T extends GuardText>(timer: Timer, reply: KeywordReply<T>): void {
  const got: SpanFacts = { keyword: reply.keyword.kind, flagsVisit: reply.keyword.flagsVisit };
  const decided: SpanFacts = {
    result: reply.outcome,
    line: reply.line !== null && isLabel(reply.line) ? reply.line : null,
    words: reply.words,
    stopped: reply.stopped,
    told: reply.told.length,
    rowsWritten: reply.rowsWritten.length,
  };
  try {
    timer.finish({
      outcome: SPAN_OUTCOME[reply.outcome],
      ...(isLabel(reply.text.eventId) ? { eventId: reply.text.eventId } : {}),
      got,
      decided,
      rows: reply.rowsWritten.filter((id) => isLabel(id)).map((id) => ({ table: "outbox_rows", id })),
      errorCode: reply.errorCode !== null && isLabel(reply.errorCode) ? reply.errorCode : null,
    });
  } catch {
    // No span for this reply; what was recorded and written stands.
  }
}
