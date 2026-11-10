// recordSafetyOutcome (T-318; C-104; K-09 v1; K-34 v1; arch 06 lines 315 to 329; A3-22 to A3-26, A3-48 to A3-50, B3-17,
// B3-30 to B3-32; S13-10): one text's safety read, recorded with what it holds, in the commit of the turn its text joins
// (every text, No included: K-09 README default 5), or alone for free text from a page or an outside AI. It writes:
//
//   - the outcome row (K-34 safety_outcomes), one per text, never edited: the labels, tenses and outcomes plain (the gate,
//     the actor and the gold set read them without a key), and the words that name people sealed under the writer's key
//     (each label's evidence words, who is at risk and who wrote it, and the danger words matched: K-34 sealed_words);
//   - its hold (K-34 safety_holds) with the strictest rule of its outcomes: routine work waits until it is released;
//   - the protective changes the outcome itself calls for, through the flags calls (T-317's setRecordFlag plan; arch 03
//     lines 173 to 175: "The safety read alone sets the first three rows"): a threat pauses the person and their phone, so
//     their later visits are called off unless the owner decides and new requests wait for him (A3-48); unsafe at home
//     makes the booking private, which releases its hold in the same commit (A3-50);
//   - the outcome step's checked line, as an outbox row of send class safety, at any hour and past any opt-out, carrying
//     the danger question when a label's tense is unknown (default 18; the plan's `line`);
//   - who is told: a harm report to Rosie's team that day for harm to a child or older adult (K-34 harm_reports; A3-49),
//     and the owner or Rosie's team through the hand-offs and pages port (T-319) for crisis words, an emergency or a threat.
//
// It only reads, through its ports, and hands back what the commit is to write: a repeated turn runs it again before K-05
// answers `repeated` (STATE note 1). Nothing here logs; what it returns or throws names rows, rules and faults, never a
// person's words, a number or an address (K-08 v1).
//
// Defaults used (for ops/QUESTIONS.md):
//   1. The record's key is the text's event id (K-09 v1: "one outcome row per text, and a repeat returns the first"). A
//      repeat writes nothing and answers the first record from the stored rows; its hold is named while it is open, and
//      a released hold holds nothing, so a repeat answers it null (the batch turn after an at-once release is not held by
//      it). While open, the hold's rule is the strictest of the stored rule, the latest read's and any open hold of the same
//      id the turn is handed (the handle actor's: STATE note 21, its rule binds).
//   2. A read that timed out with no danger word holds at once (rules.ts ruleOf): its outage line is a quick_reply row,
//      never sent to a stopped phone; the actor's own unread hold keeps routine held until its re-read (DL-127).
//   3. Unsafe at home with no booking cannot hold `when_private` (K-34 safety_holds_private_has_booking): it holds
//      after_safe, the next stricter rule, so routine still waits; no booking is made private. With a booking, its hold
//      is written already released (booking_private, by this turn) when this commit makes it private; the answer still
//      names the hold, so the rest of this turn waits (fail closed) and the next turn finds nothing held.
//   4. A threat pauses the writer (the person at the handle, or the person on the page) and the handle's phone, at the
//      call's business; with no business there is no pause row to write (K-04 pauses.business_id), and the never hold
//      alone holds routine. A protective change the turn's own core actions already carry is left to them, so one turn
//      never writes it twice.
//   5. A hold needs a handle (K-34 safety_holds.handle_id): free text from a page or an AI with no handle writes no hold;
//      its answer says nothing books whenever its outcomes hold danger (arch 02 line 129).
//   6. read_at and held_at are the call's now: K-02 v1's result carries no time of its own. Every text of one turn so
//      shares them, so they never say which text came first: a release compares the texts' arrival (release.ts default
//      13).
//   7. The words sealed are one JSON value: {"labels": [{"evidence", "atRisk", "writer"}...], "dangerWords": [...]}, in
//      the read's order; with no person known nothing is sealed and the words are not kept (K-34 sealed_words "null when
//      no person is known"). A harm report seals the same words for the one who told Rosie (K-34 sealed_details).
//   8. A sealed value is written as PostgreSQL's bytea text input (\x and hex digits), as K-34's seeds write it, and its
//      event-log entry carries the same bytes as base64 (K-05 v1 sealedValues).
//   9. Every entry here is Rosie's own act (actor rosie), why step A3-22, the danger check that gives safe (its flow B twin
//      is B3-17; the call names no flow), zone null (UTC); a harm report's entry carries no business (K-08 v1.1 team only).
//  10. Harm to a child or older adult (A3-49; CQ-164 (c); T-1162): its checked line is the pinned bundle's when that line
//      gives a hotline from Rosie's safety list. With no hotline in the bundle (bundle v0 holds no A3-49 step), it is
//      safetyEmergency (911) to the writer, the strictest the sources allow, as the handle actor's direct path sends it
//      (T-1143), and the record is never refused for want of one: the outcome, its at-once hold and the 911 line are
//      written, and the turn goes on. A hotline is never made up or guessed (A3-49), so the harm report is filed only with
//      the hotline the line gives (K-34 harm_reports_child_or_elder_has_hotline), with the business known
//      (harm_reports.business_id is not null) and its zone, else the call is refused (harmReportNeedsBusiness). With no
//      hotline no report is filed and `told` names none (QUESTIONS.md: who tells Rosie's team that day until the bundle
//      holds the hotline); a repeat names the report by the same rule. Unsafe at home and a report about the owner or staff
//      file none here: K-02 v1 does not say whose risk it is or whom it names (CQ-22).
//  17. A protective flag the outcome calls for is never dropped. A pause T-317 refuses (no such person, phone or handle:
//      notFound) refuses the record with that answer, and nothing is written: the never hold cannot show a missing pause,
//      and the handle actor keeps its own hold and sends the checked line itself (errors.ts). A refusal K-09 v1 lists no
//      record error for fails the call (pauseRefused). A private flag T-317 refuses leaves the when_private hold held and
//      unreleased, which the answer names (default 3), so the booking waits until it is private.
//  18. The danger question on the core's own line (T-1176; CQ-172; arch 06 line 329; S13-24 rule 10): the line's row is
//      a safety row, whose words go in word for word after the commit (arch 07 lines 347, 361) and which finalize's
//      fixed-line inserter never reads (readOutboxRow answers fixedLineRow; T-1164's review). So the record's line
//      (RecordLine, the plan's `line`) carries K-01's safetyAsk itself, in the actor's cases: a label of unknown tense whose
//      outcome is not No, read from the record's own labels (the read's, or K-34's stored labels and tenses on a repeat),
//      as runtime/src/safety/rules.ts checkedLineFor asks it, and placed as it places it, on the same line after a space
//      (lineWordsOf). Never after No, a known tense (over, now, could restart, joke) or a read with no label (a timeout,
//      CQ-163 b). Only a safety line to the text's writer asks: a threat's line to the owner carries none (the actor sends
//      a threat's writer nothing, so it asks nothing; S13-10, A3-48), nor does the outage line. The words are the pinned
//      bundle's (SafetyWords): with no words port the record is not built (notBuilt), and with no words for safetyAsk it
//      is refused (noSafetyAsk), as finalize's inserter refuses such a row (T-1164): the line never goes without its
//      question. The K-09 v1 answer still names the line by its own id (safetyLine.fixedLineId), as the actor's line keeps
//      its id with the question added, and a line the commit writes no row for (the actor's own send, or one a page or an
//      AI shows) has no `line`.

import type { CoreAction, EventEntry, OutboxRowNew, SafetyHold, StateWrite } from "../../commit";
import { NotBuiltError, type ErrorsOf, type RequestOf, type ResponseOf } from "../../tool-api";
import {
  eventEntry,
  noWrites,
  planRecordFlag,
  type FlagIds,
  type FlagsReader,
  type FlagWrites,
  type RecordFlagError,
  type RecordFlagRequest,
  type VisitsCovered,
} from "../flags";
import type { MessagesConsent } from "../messages-consent";
import { SafetyRefusedError } from "./errors";
import type { SafetyIds } from "./ids";
import type {
  SafetyLineChoice,
  SafetyLines,
  SafetyReader,
  SafetyTelling,
  SafetyTold,
  SafetyWords,
  StopWords,
  StoredHold,
  StoredOutcome,
  WordsSealer,
} from "./ports";
import {
  SAFETY_ASK_LINE,
  asksIfInDanger,
  dangerOf,
  labelsOf,
  lineOutcomeOf,
  mustSendLine,
  nothingBooksUnder,
  ruleOf,
  storedLabels,
  strictestOf,
  tellsOf,
  type LabelTense,
  type ReleaseRule,
  type SafetyOutcome,
  type SafetyResult,
} from "./rules";

/** K-09 v1's request: v1.5 also takes v1.1's record on arrival (caller.kind actorOnArrival), not built here (notBuilt). */
export type RecordRequest = Exclude<RequestOf<"recordSafetyOutcome">, { caller: { kind: "actorOnArrival" } }>;
export type RecordResponse = ResponseOf<"recordSafetyOutcome">;
export type RecordError = ErrorsOf<"recordSafetyOutcome">;
export type RecordAnswer = RecordResponse | RecordError;
type HoldView = NonNullable<RecordResponse["hold"]>;
type LineView = NonNullable<RecordResponse["safetyLine"]>;

/** The step every entry of the record names (default 9). */
export const RECORD_STEP = "A3-22";

/** The outcome whose line gives a hotline and whose report goes to Rosie's team that day (A3-49; default 10). */
const HARM: SafetyOutcome = "Harm to a child or older adult";

/** The strictest safety line, 911 (A3-24; arch 02 line 111): harm's line when the bundle holds no hotline (default 10). */
const STRICTEST_LINE = "safetyEmergency";

/** The turn whose commit carries a record: its id, handle, texts and core actions (K-05 v1 turn; K-09 v1 coreAction). */
export interface CarryingTurn {
  readonly id: string;
  readonly handleId: string;
  readonly eventIds: readonly string[];
  readonly core: readonly CoreAction[];
}

export interface RecordCall {
  readonly request: RecordRequest;
  /** The turn whose commit carries it, or null for a call made alone. */
  readonly turn: CarryingTurn | null;
  /** The business the call runs under (its scope), or null on the runtime side. */
  readonly businessId: string | null;
  /** The call's now, UTC ending in Z. */
  readonly now: string;
  /** The holds open in force on the handle (the handle actor's and the turn's earlier core actions'): default 1. */
  readonly open: readonly SafetyHold[];
}

export interface RecordPorts {
  readonly reader: SafetyReader;
  readonly ids: SafetyIds;
  /** T-317's reads and ids, for the protective flags the outcome calls for. */
  readonly flags: { readonly reader: FlagsReader; readonly ids: FlagIds; readonly visits: VisitsCovered };
  /** T-307's rows for the business the call runs under, or null on the runtime side (no line row can be built there). */
  readonly messages: MessagesConsent | null;
  readonly sealer: WordsSealer | null;
  readonly lines: SafetyLines;
  readonly stopWords: StopWords;
  readonly telling: SafetyTelling;
  /** K-01's fixed lines' words from the pinned bundle, or null while none is wired (a line that asks is then not built). */
  readonly words: SafetyWords | null;
}

/**
 * The record's own checked line, as its commit writes the line's outbox row (default 18; T-1176, CQ-172): the line's
 * K-09 id, who it goes to, its row, and the danger question it carries. The row holds no words at the commit (K-05 v1
 * outboxRowNew: words go in after it, arch 01 line 41); a safety line's are fixed text, written into it word for word
 * (arch 07 lines 347, 361; K-05 writePlan, as write-plan-alex-safety.json: no lines of its own, the line's words and its
 * fixed line ids), here the line's own words and then the question's (lineWordsOf).
 */
export interface RecordLine {
  /** K-09 v1 fixedLineId: the outcome step's checked line, or the K-01 fixed line in its place (commit/core/lines.ts). */
  readonly fixedLineId: string;
  /** Who it goes to: the text's writer, or the business's owner for a threat (A3-48), who is never asked. */
  readonly to: SafetyLineChoice["to"];
  /** The outbox row the commit writes for it: the first T-307 builds (an email copy of it takes its words). */
  readonly outboxRowId: string;
  /** The K-01 v1 fixed lines its words hold, in order: the line, then safetyAsk when the danger question goes with it. */
  readonly fixedLines: readonly string[];
  /** The danger question's words, as the pinned bundle writes K-01's safetyAsk, when it goes with the line; else null. */
  readonly ask: string | null;
}

export interface RecordPlan {
  /** The key a repeat is known by: the text's event id. */
  readonly key: string;
  readonly answer: RecordAnswer;
  /** What the commit writes; `clocks` are the clock rows no question owns (a pause's call-off, a hand-off's escalation). */
  readonly writes: FlagWrites;
  /**
   * The record's own line, with the danger question it carries (default 18): the row this commit writes for its checked
   * line, or on a repeat the row the first record wrote. Null when it writes none: No, a refusal, a step with nothing to
   * send, the actor's own send, a line a page or an AI shows, or the outage line held back from a stopped phone.
   */
  readonly line: RecordLine | null;
}

// ---- small helpers ------------------------------------------------------------------------------------------------------

const hexOf = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** Sealed bytes as PostgreSQL's bytea text input (default 8). */
export function byteaText(bytes: Uint8Array): string {
  return `\\x${hexOf(bytes)}`;
}

/** Sealed bytes as base64, as K-05 v1 sealedValues carries them. */
export function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The words a read holds that name people, as one JSON value (default 7), or null when it holds none. */
export function wordsOf(result: SafetyResult): string | null {
  const labels = (result.read?.labels ?? []).map((label) => ({
    evidence: label.evidence,
    atRisk: label.atRisk,
    writer: label.writer,
  }));
  const dangerWords = result.dangerWords.map((match) => match.words);
  if (labels.length === 0 && dangerWords.length === 0) return null;
  return JSON.stringify({ labels, dangerWords });
}

/** Two writes, one after the other: every list joined in order. */
export function joinWrites(a: FlagWrites, b: FlagWrites): FlagWrites {
  return {
    why: a.why,
    versionsRead: [...a.versionsRead, ...b.versionsRead],
    state: [...a.state, ...b.state],
    stateEvents: [...a.stateEvents, ...b.stateEvents],
    asks: [...a.asks, ...b.asks],
    messages: [...a.messages, ...b.messages],
    clocks: [...a.clocks, ...b.clocks],
  };
}

type FlagTarget = RecordFlagRequest["target"];

const sameTarget = (a: FlagTarget, b: FlagTarget): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Whether the turn's own core actions already set this flag on this target (default 4). */
export function carriedByTurn(
  turn: CarryingTurn | null,
  flag: RecordFlagRequest["flag"],
  target: FlagTarget,
): boolean {
  if (turn === null) return false;
  return turn.core.some(
    (action) =>
      action.call === "setRecordFlag" &&
      action.request.flag === flag &&
      action.request.action === "set" &&
      sameTarget(action.request.target, target),
  );
}

/** A protective flag as planned: set (with its writes, or none when it already holds) or refused by T-317 (default 17). */
type FlagPlanned =
  | { readonly set: true; readonly writes: FlagWrites | null }
  | { readonly set: false; readonly refused: RecordFlagError };

/** One protective flag the outcome calls for, planned through T-317's setRecordFlag. */
async function flagWrites(
  call: RecordCall,
  ports: RecordPorts,
  flag: RecordFlagRequest["flag"],
  target: FlagTarget,
): Promise<FlagPlanned> {
  if (carriedByTurn(call.turn, flag, target)) return { set: true, writes: null };
  const plan = await planRecordFlag(
    {
      request: { caller: call.request.caller, flag, action: "set", target, expectVersion: null },
      now: call.now,
    },
    { reader: ports.flags.reader, ids: ports.flags.ids, visits: ports.flags.visits, sealer: null },
  );
  if ("error" in plan.answer) return { set: false, refused: plan.answer };
  return { set: true, writes: plan.answer.repeated ? null : plan.writes };
}

/**
 * A pause T-317 refused, as the record's own answer (default 17): K-09 v1 recordSafetyOutcome.errors holds notFound,
 * bookingPaused and transient in the same shapes; any other refusal fails the call, naming the pause's target by id.
 */
function pauseRefusal(refused: RecordFlagError, targetRowId: string): RecordError {
  if (refused.error === "notFound" || refused.error === "bookingPaused" || refused.error === "transient") {
    return refused;
  }
  throw new SafetyRefusedError("pauseRefused", [targetRowId]);
}

// ---- the record ---------------------------------------------------------------------------------------------------------

function checkCall(call: RecordCall): void {
  const { request, turn, businessId } = call;
  const { caller, safety } = request;
  if (businessId !== null && caller.businessId !== null && caller.businessId !== businessId) {
    throw new SafetyRefusedError("otherBusiness");
  }
  if (safety.source !== "text") return;
  if (request.handleId === null) throw new SafetyRefusedError("textNeedsHandle", [safety.eventId]);
  if (turn === null || caller.kind !== "turn" || caller.turnId === null) {
    throw new SafetyRefusedError("textNeedsTurn", [safety.eventId]);
  }
  if (caller.turnId !== turn.id) throw new SafetyRefusedError("notTheTurn", [turn.id]);
  if (!turn.eventIds.includes(safety.eventId) || request.handleId !== turn.handleId) {
    throw new SafetyRefusedError("notTheTurnsText", [safety.eventId]);
  }
}

/** Whether the line goes back to the caller to show (a page or an outside AI), with no outbox row. */
const callerShowsLine = (request: RecordRequest): boolean =>
  request.safety.source !== "text" || request.caller.kind === "page" || request.caller.kind === "agent";

/** A checked line and the send class its row takes. */
interface LinePick {
  readonly choice: SafetyLineChoice;
  readonly sendClass: "safety" | "quick_reply";
}

type WordKinds = readonly ("selfHarm" | "other")[];

/**
 * Harm to a child or older adult's checked line (default 10): the pinned bundle's when it gives a hotline from Rosie's
 * safety list (A3-49); otherwise safetyEmergency (911) to the writer, with no hotline, as the handle actor's direct path
 * sends it (T-1143). Never null, so no harm record is refused for want of a line, and never a hotline made up.
 */
function harmLineOf(lines: SafetyLines, wordKinds: WordKinds): SafetyLineChoice {
  const own = lines.lineOf(HARM, wordKinds);
  if (own !== null && own.hotline !== null) return own;
  return { fixedLineId: STRICTEST_LINE, to: "writer", hotline: null };
}

/** An outcome's checked line from the pinned bundle, or null when its step sends nothing here; harm's by its own rule. */
function lineChoiceOf(
  lines: SafetyLines,
  outcome: SafetyOutcome,
  wordKinds: WordKinds,
): SafetyLineChoice | null {
  return outcome === HARM ? harmLineOf(lines, wordKinds) : lines.lineOf(outcome, wordKinds);
}

/**
 * The checked line a record sends: its outcome step's (LINE_ORDER), as a safety row; for a read that timed out with no
 * danger word, the outage line, as a quick_reply row (default 2); null when nothing goes (No, or a step with nothing to
 * send). A danger outcome whose step must send and has no line is refused (`strict`), except on a repeat, which writes
 * nothing and names only what it knows; harm to a child or older adult always has one (default 10).
 */
function pickLine(
  ports: RecordPorts,
  read: {
    readonly outcomes: readonly SafetyOutcome[];
    readonly timedOut: boolean;
    readonly wordKinds: WordKinds;
  },
  eventId: string,
  strict: boolean,
): LinePick | null {
  const outcome = lineOutcomeOf(dangerOf(read.outcomes));
  if (outcome !== null) {
    const choice = lineChoiceOf(ports.lines, outcome, read.wordKinds);
    if (choice === null && strict && mustSendLine(outcome)) {
      throw new SafetyRefusedError("noSafetyLine", [eventId]);
    }
    return choice === null ? null : { choice, sendClass: "safety" };
  }
  if (!read.timedOut || read.outcomes.length > 0) return null;
  const outage = ports.lines.outageLine();
  return outage === null
    ? null
    : { choice: { fixedLineId: outage, to: "writer", hotline: null }, sendClass: "quick_reply" };
}

/**
 * The danger question's words a record's line carries (default 18), or null when none goes: a safety line to the text's
 * writer whose record's own labels hold one of unknown tense whose outcome is not No (rules.ts asksIfInDanger), as the
 * handle actor's direct path asks it. The words are the pinned bundle's K-01 safetyAsk: with no words port the record is
 * not built, and with none for safetyAsk (or blank ones) it is refused, so the line never goes without its question.
 * A line that asks nothing reads no words.
 */
function dangerQuestionOf(
  ports: RecordPorts,
  picked: LinePick,
  labels: readonly LabelTense[],
  eventId: string,
): string | null {
  if (picked.sendClass !== "safety" || picked.choice.to !== "writer" || !asksIfInDanger(labels)) return null;
  if (ports.words === null) throw new NotBuiltError("recordSafetyOutcome");
  const ask = ports.words.fixedLine(SAFETY_ASK_LINE);
  if (ask?.id !== SAFETY_ASK_LINE || ask.text.trim() === "") {
    throw new SafetyRefusedError("noSafetyAsk", [eventId]);
  }
  return ask.text;
}

/** The record's line for the row written for it, carrying the danger question when one goes (`ask`). */
function recordLine(choice: SafetyLineChoice, outboxRowId: string, ask: string | null): RecordLine {
  return {
    fixedLineId: choice.fixedLineId,
    to: choice.to,
    outboxRowId,
    fixedLines: ask === null ? [choice.fixedLineId] : [choice.fixedLineId, SAFETY_ASK_LINE],
    ask,
  };
}

/**
 * The words a record's line sends, placed as the handle actor's direct path places them (runtime/src/safety/rules.ts
 * checkedLineFor, line 173): the line's own words as the pinned bundle writes them, then the danger question on the same
 * line after a space, once.
 */
export function lineWordsOf(own: string, line: Pick<RecordLine, "ask">): string {
  return line.ask === null ? own : `${own} ${line.ask}`;
}

/** The outbox rows of the checked line, built by T-307 for its recipient; refused when nothing can carry it. */
async function lineRows(
  call: RecordCall,
  ports: RecordPorts,
  lineId: string,
  choice: SafetyLineChoice,
  sendClass: "safety" | "quick_reply",
): Promise<readonly OutboxRowNew[]> {
  const { request, businessId } = call;
  const messages = ports.messages;
  if (messages === null || businessId === null) {
    if (sendClass === "quick_reply") return [];
    throw new SafetyRefusedError("safetyLineNotBuilt", [lineId]);
  }
  let to: { personId: string | null; via: string | null };
  if (choice.to === "owner") {
    const owner = await ports.reader.ownerOf(businessId);
    if (owner === null) throw new SafetyRefusedError("safetyLineNotBuilt", [lineId]);
    to = { personId: owner.personId, via: owner.handleId };
  } else {
    to = { personId: request.caller.personId, via: request.handleId };
  }
  const built = await messages.outboxRows({
    id: lineId,
    to,
    bookingId: request.bookingId,
    openQuestionId: null,
    sendClass,
    versionsRead: [],
  });
  // A safety line goes past any opt-out, so only a recipient nothing can reach leaves it unbuilt (fail closed: the actor
  // sends it itself); the outage line is not a safety line and is never sent to a stopped phone.
  if (built.rows.length === 0 && sendClass === "safety") {
    throw new SafetyRefusedError("safetyLineNotBuilt", [lineId]);
  }
  return built.rows;
}

/** The hold a repeat names (default 1), or null when it holds nothing now. */
function repeatHold(
  stored: StoredHold | null,
  open: readonly SafetyHold[],
  latest: ReleaseRule | null,
): HoldView | null {
  if (stored === null) return null;
  const actors = open.filter((hold) => hold.holdId === stored.id);
  if (stored.releasedAt !== null && actors.length === 0) return null;
  const rule = strictestOf([
    stored.releasedAt === null ? stored.releaseRule : null,
    ...actors.map((hold) => hold.releaseRule),
    latest,
  ]);
  if (rule === null) return null;
  return {
    holdId: stored.id,
    releaseRule: rule,
    blocksBooking: stored.blocksBooking || actors.some((hold) => hold.blocksBooking),
  };
}

/**
 * The first record's answer, from the stored rows: nothing is written (default 1). Its line is the first record's, with
 * the danger question read from the stored labels and tenses (default 18).
 */
async function repeatAnswer(
  call: RecordCall,
  ports: RecordPorts,
  stored: StoredOutcome,
): Promise<{ readonly answer: RecordResponse; readonly line: RecordLine | null }> {
  const { request, businessId } = call;
  const eventId = stored.eventId;
  const latest = ruleOf(request.safety, false);
  const hold = repeatHold(await ports.reader.holdOfOutcome(stored.id), call.open, latest);

  let safetyLine: LineView | null = null;
  let line: RecordLine | null = null;
  const picked = pickLine(
    ports,
    { outcomes: stored.outcomes, timedOut: stored.timedOut, wordKinds: stored.dangerWordKinds },
    eventId,
    false,
  );
  if (picked !== null) {
    const lineId = await ports.ids.rowId("line", eventId);
    const written = await ports.reader.outboxRowWritten(lineId);
    safetyLine = { fixedLineId: picked.choice.fixedLineId, outboxRowId: written ? lineId : null };
    if (written) {
      line = recordLine(
        picked.choice,
        lineId,
        dangerQuestionOf(ports, picked, storedLabels(stored), eventId),
      );
    }
  }

  const told: SafetyTold[] = [];
  const tells = tellsOf(stored.outcomes);
  if (tells.length > 0) {
    const plan = await ports.telling.tell({
      eventId,
      outcomeId: stored.id,
      outcomes: tells,
      businessId: stored.businessId ?? businessId,
      handleId: stored.handleId,
      personId: stored.personId,
      bookingId: stored.bookingId,
      turnId: stored.turnId,
      now: call.now,
      repeated: true,
    });
    told.push(...plan.told);
  }
  // The first record filed a harm report only with the hotline its line gave (default 10).
  if (stored.outcomes.includes(HARM) && harmLineOf(ports.lines, stored.dangerWordKinds).hotline !== null) {
    told.push({ who: "team", via: "harmReport", id: await ports.ids.rowId("harmReport", eventId) });
  }

  // With no hold row (free text with no handle: default 5), nothing books while its outcomes hold danger.
  const storedRule = stored.handleId === null ? ruleOf(stored, false) : null;
  const answer: RecordResponse = {
    outcomeId: stored.id,
    outcomes: [...stored.outcomes],
    hold,
    safetyLine,
    told,
    nothingBooks:
      hold !== null
        ? nothingBooksUnder(hold)
        : storedRule !== null && nothingBooksUnder({ releaseRule: storedRule, blocksBooking: false }),
    repeated: true,
  };
  return { answer, line };
}

/** Plans one recordSafetyOutcome call: what it answers and what its commit writes. Reads only. */
export async function planRecordSafetyOutcome(call: RecordCall, ports: RecordPorts): Promise<RecordPlan> {
  checkCall(call);
  const { request, turn, businessId, now } = call;
  const { caller, safety, handleId, bookingId, sentByActor } = request;
  const eventId = safety.eventId;
  const why = { step: RECORD_STEP, choice: null };
  const nothing = (answer: RecordAnswer, line: RecordLine | null = null): RecordPlan => ({
    key: eventId,
    answer,
    writes: noWrites(RECORD_STEP),
    line,
  });

  const stored = await ports.reader.outcomeOfEvent(eventId);
  if (stored !== null) {
    const repeat = await repeatAnswer(call, ports, stored);
    return nothing(repeat.answer, repeat.line);
  }

  const personId = caller.personId;
  const turnId = safety.source === "text" && turn !== null ? turn.id : null;
  const outcomeId = await ports.ids.rowId("outcome", eventId);
  const blocksBooking = await ports.stopWords.stopsBooking(businessId, eventId);
  let rule = ruleOf(safety, blocksBooking);
  if (rule === "when_private" && bookingId === null) rule = "after_safe";

  // ---- the words that name people, sealed under the writer's key (default 7) ----------------------------------------
  const words = wordsOf(safety);
  let sealed: Uint8Array | null = null;
  if (words !== null && personId !== null) {
    // Never written in plain: with no sealer the call is not built yet (fail closed).
    if (ports.sealer === null) throw new NotBuiltError("recordSafetyOutcome");
    sealed = await ports.sealer.seal(words, personId);
  }

  let writes: FlagWrites = noWrites(RECORD_STEP);
  const state: StateWrite[] = [];
  const entries: EventEntry[] = [];
  const entry = (input: {
    id: string;
    kind: string;
    table: string;
    rowId: string;
    business: string | null;
    new: Record<string, unknown>;
    old?: Record<string, unknown> | null;
    sealedFor?: { forPersonId: string; base64: string } | null;
  }): EventEntry => ({
    ...eventEntry({
      id: input.id,
      kind: input.kind,
      zone: null,
      businessId: input.business,
      actor: null,
      table: input.table,
      rowId: input.rowId,
      old: input.old ?? null,
      new: input.new,
      why,
    }),
    sealed: input.sealedFor ?? null,
  });

  // ---- the outcome row (K-34 safety_outcomes), never edited ----------------------------------------------------------
  const { labels, tenses } = labelsOf(safety);
  const outcomeValues = {
    event_id: eventId,
    source: safety.source,
    handle_id: handleId,
    person_id: personId,
    booking_id: bookingId,
    turn_id: turnId,
    read_at: now,
    tries: safety.tries.map((each) => ({ model: each.model, result: each.result })),
    timed_out: safety.timedOut,
    labels,
    tenses,
    danger_word_lists: safety.dangerWords.map((match) => match.list),
    danger_word_kinds: safety.dangerWords.map((match) => match.kind),
    outcomes: [...safety.outcomes],
    lifted_to_unsure: safety.liftedToUnsure,
  };
  state.push({
    op: "insert",
    table: "safety_outcomes",
    values: {
      id: outcomeId,
      business_id: businessId,
      ...outcomeValues,
      sealed_words: sealed === null ? null : byteaText(sealed),
    },
  });
  entries.push(
    entry({
      id: `log-${outcomeId}-recorded`,
      kind: "safety_outcome.recorded",
      table: "safety_outcomes",
      rowId: outcomeId,
      business: businessId,
      new: outcomeValues,
      sealedFor:
        sealed === null || personId === null ? null : { forPersonId: personId, base64: base64Of(sealed) },
    }),
  );

  // ---- the protective flags the outcome calls for (defaults 4 and 17) -------------------------------------------------
  const flagged: FlagWrites[] = [];
  let madePrivate = false;
  if (businessId !== null && caller.businessId !== null) {
    if (safety.outcomes.includes("A threat to staff or others")) {
      // The writer, then the handle's phone; each named by id when refused, never by its number.
      const pauses: { readonly target: FlagTarget; readonly rowId: string }[] = [];
      if (personId !== null) pauses.push({ target: { personId }, rowId: personId });
      if (handleId !== null) {
        const handle = await ports.flags.reader.handle(handleId);
        if (handle === null) return nothing({ error: "notFound", table: "handles", rowId: handleId });
        if (handle.kind === "phone")
          pauses.push({ target: { phoneNumber: handle.address }, rowId: handle.id });
      }
      for (const pause of pauses) {
        const planned = await flagWrites(call, ports, "paused", pause.target);
        if (!planned.set) return nothing(pauseRefusal(planned.refused, pause.rowId));
        if (planned.writes !== null) flagged.push(planned.writes);
      }
    }
    if (rule === "when_private" && bookingId !== null) {
      const booking = await flagWrites(call, ports, "private", { bookingId });
      if (booking.set && booking.writes !== null) flagged.push(booking.writes);
      madePrivate = booking.set;
    }
  }

  // ---- the hold (K-34 safety_holds), with its release when the booking is made private here (A3-50) -------------------
  let hold: HoldView | null = null;
  if (rule !== null && handleId !== null) {
    const holdId = await ports.ids.rowId("hold", eventId);
    hold = { holdId, releaseRule: rule, blocksBooking };
    const holdValues = {
      safety_outcome_id: outcomeId,
      handle_id: handleId,
      person_id: personId,
      booking_id: bookingId,
      turn_id: turnId,
      release_rule: rule,
      blocks_booking: blocksBooking,
      held_at: now,
    };
    const released = madePrivate
      ? {
          released_at: now,
          released_why: "booking_private",
          released_by_turn_id: caller.turnId,
          released_by_outcome_id: null,
        }
      : null;
    state.push({
      op: "insert",
      table: "safety_holds",
      values: { id: holdId, business_id: businessId, ...holdValues, ...(released ?? {}) },
    });
    entries.push(
      entry({
        id: `log-${holdId}-set`,
        kind: "safety_hold.set",
        table: "safety_holds",
        rowId: holdId,
        business: businessId,
        new: holdValues,
      }),
    );
    if (released !== null) {
      entries.push(
        entry({
          id: `log-${holdId}-released`,
          kind: "safety_hold.released",
          table: "safety_holds",
          rowId: holdId,
          business: businessId,
          old: { released_at: null },
          new: released,
        }),
      );
    }
  }

  // ---- the checked line, with the danger question it carries (default 18) ----------------------------------------------
  let safetyLine: LineView | null = null;
  let line: RecordLine | null = null;
  let lineMessages: readonly OutboxRowNew[] = [];
  const wordKinds = safety.dangerWords.map((match) => match.kind);
  const picked = pickLine(
    ports,
    { outcomes: safety.outcomes, timedOut: safety.timedOut, wordKinds },
    eventId,
    sentByActor === null,
  );
  if (sentByActor !== null) {
    safetyLine = { fixedLineId: sentByActor.fixedLineId, outboxRowId: null };
  } else if (picked !== null) {
    const { choice, sendClass } = picked;
    if (callerShowsLine(request)) {
      safetyLine = { fixedLineId: choice.fixedLineId, outboxRowId: null };
    } else {
      // From the read's own labels, before the row is built: a line that cannot carry its question builds nothing.
      const ask = dangerQuestionOf(ports, picked, safety.read?.labels ?? [], eventId);
      const lineId = await ports.ids.rowId("line", eventId);
      lineMessages = await lineRows(call, ports, lineId, choice, sendClass);
      const first = lineMessages[0];
      safetyLine = first === undefined ? null : { fixedLineId: choice.fixedLineId, outboxRowId: first.id };
      line = first === undefined ? null : recordLine(choice, first.id, ask);
    }
  }

  // ---- who is told: the harm report (A3-49), then hand-offs and pages (T-319) ------------------------------------------
  const told: SafetyTold[] = [];
  let tellWrites: FlagWrites | null = null;
  const tells = tellsOf(safety.outcomes);
  if (tells.length > 0) {
    const plan = await ports.telling.tell({
      eventId,
      outcomeId,
      outcomes: tells,
      businessId,
      handleId,
      personId,
      bookingId,
      turnId,
      now,
      repeated: false,
    });
    told.push(...plan.told);
    tellWrites = plan.writes;
  }
  // With no hotline in the pinned bundle the record stands with its hold and 911, and no report is filed (default 10).
  const hotline = safety.outcomes.includes(HARM) ? harmLineOf(ports.lines, wordKinds).hotline : null;
  if (hotline !== null) {
    const harmId = await ports.ids.rowId("harmReport", eventId);
    if (businessId === null) throw new SafetyRefusedError("harmReportNeedsBusiness", [eventId]);
    const zone = await ports.reader.businessZone(businessId);
    if (zone === null) throw new SafetyRefusedError("harmReportNeedsBusiness", [eventId]);
    const reportValues = {
      business_id: businessId,
      kind: "harm_to_child_or_elder",
      safety_outcome_id: outcomeId,
      reporter_person_id: personId,
      booking_id: bookingId,
      named_person_id: null,
      hotline,
      reported_at: now,
      day_zone: zone,
    };
    state.push({
      op: "insert",
      table: "harm_reports",
      values: {
        id: harmId,
        ...reportValues,
        sealed_details: sealed === null ? null : byteaText(sealed),
        sealed_for_person_id: sealed === null ? null : personId,
      },
    });
    // Rosie's team's row: its entry carries no business, so no business scope reads it (K-08 v1.1 team only).
    entries.push(
      entry({
        id: `log-${harmId}-filed`,
        kind: "harm_report.filed",
        table: "harm_reports",
        rowId: harmId,
        business: null,
        new: reportValues,
        sealedFor:
          sealed === null || personId === null ? null : { forPersonId: personId, base64: base64Of(sealed) },
      }),
    );
    told.push({ who: "team", via: "harmReport", id: harmId });
  }

  // ---- what the commit writes, in order: the record, its flags, its line, who is told ---------------------------------
  writes = joinWrites(writes, {
    ...noWrites(RECORD_STEP),
    state,
    stateEvents: entries,
    messages: lineMessages,
  });
  for (const each of flagged) writes = joinWrites(writes, each);
  if (tellWrites !== null) writes = joinWrites(writes, tellWrites);

  return {
    key: eventId,
    answer: {
      outcomeId,
      outcomes: [...safety.outcomes],
      hold,
      safetyLine,
      told,
      // With no hold row (free text with no handle: default 5), nothing books while its outcomes hold danger.
      nothingBooks:
        hold !== null
          ? nothingBooksUnder(hold)
          : rule !== null && nothingBooksUnder({ releaseRule: rule, blocksBooking }),
      repeated: false,
    },
    writes,
    line,
  };
}
