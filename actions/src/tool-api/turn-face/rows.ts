// The turn face's compose input and finalize (T-1141; C-074 over C-090, C-093 and C-089): the two readRow ports and the
// fixed lines' facts bound to K-05 v1.3's readOutboxRow and readFixedLineFacts (T-1138), from K-05 v1.3 item 35's table
// ("T-1141 binds the ports from this table; nothing else is read for them"), the words the runtime hands in (default 47)
// and the pinned bundle the row was committed under. Both reads run on the runtime side (rosie_job) in a read-only
// transaction of their own under the call's business (STATE note 59; T-315's security note b); finalize's two K-05 writes
// (writePlan, cancelClock) are the runtime side's own transactions too.
//
// Where each field comes from (item 35's table, and the defaults below where the table leaves a rule to the caller):
//   - the row, its step and line (line 0 of the question it asks), its turn, bundle and channel: readOutboxRow; a null line
//     is refused, never guessed; a safety row (fixedLineRow) is the handlers' fixed-line refusal;
//   - the flow the step is read in: default 53 (an A or B step's own; a shared step's, the booking's, else the first of A,
//     then B, that the row's bundle lists whose graph holds the step; none: stepMissing);
//   - the reader: the one of the recipient's live roles the step's line from Rosie is written to (identity and access,
//     S13-31: "the role comes from what the message is about"), through readerOf; with none, refused (noReader);
//   - the source: the business head (biz.name and its display name), the business's zone, the row's channel, ask.by from
//     the question's armed clock row; the sensitive switch ON (DL-326 note b: fail closed until the business's switch is
//     read, so a first text shows the display name);
//   - the step's master line, links, card terms and fallback text: the pinned bundle, at the step, in that flow;
//   - the situation's safety outcomes: answers.texts' outcomes; the inbound text: the words the runtime handed in for
//     answers.texts (gateAndCommit's context.texts, held by the face for its turn: held.ts), only when answers.handleId
//     is the recipient's (DL-326 note d), else none; never words read from the database;
//   - finalize's question: the row's question with its clock row (a question with no clock row is refused: default 54);
//   - the fixed lines' facts: readFixedLineFacts' two facts, readOutboxRow's answers.texts as read (T-1164), and the row's
//     other lines: a K-01 safety line only on a row to the danger text's writer, never safetyAsk (DL-355).
// Nothing here logs; a refusal names a fault, never a value.
//
// Defaults used (for ops/QUESTIONS.md):
//   4. How Rosie addresses the reader (K-03 audience.name; finalize's readerName) is the first word of the stored name
//      ("Sam Lee" gives "Sam", as K-09's compose-input-s1-02.json shows), or null when none is stored.
//   5. The reader's language is the turn's (decide's agreed language, held with its words), else the stored one, else
//      "en", the language every bundle line has (K-01 fixedLines' fallback; CQ-171 (c)).
//   6. What the phone allows (C-128, not built) is text alone, the one format every channel takes (fail closed).
//   7. Rows about a booking, rows with no business and rows with options are refused here (each answers notBuilt): the
//      booking's record and calendar file (open gaps 30 and 35), a row with no business's zone, and the options' text
//      form until the handle has voted (arch 07 line 379) are not read yet. The skeleton's row has none of them.
//   8. The step's links are the link slots its master line names; its terms the lines of its card that name no slot
//      (K-03 v1.1 term facts; CQ-86's default), given to the checks as facts labelled "term" (T-313's own form).
//   9. The danger text's writer's row carries each danger outcome's K-01 line once (crisis words: safetyCrisis; an
//      emergency and every other danger outcome: safetyEmergency; Unsure: safetyCrisis, which also gives 911, since the
//      read does not say its danger words' kind); a threat's writer gets none (S13-10).

import { NotBuiltError } from "../errors";
import {
  ComposeInputRefusedError,
  slotsIn,
  type ComposeBundles,
  type ComposeInputDeps,
  type ComposeRow,
  type ComposeRowRead,
} from "../../compose-input";
import type { InboundText, Option } from "../../compose-input/types";
import { optOutLinesOf, withoutOptOutLine, READER_LANES, ROSIE_LANE } from "../../compose-input/master-line";
import { FIXED_LINE_OF } from "../../commit/core";
import { claimFacts, readerOf, type Reader } from "../../finalize/claim-check";
import type { CheckLists } from "../../finalize/checks";
import {
  claimedBusiness,
  fixedLineInserter,
  type AnsweredText,
  type FixedLineFacts,
  type FixedLinePorts,
} from "../../finalize/fixed-lines";
import {
  FinalizeNotBuiltError,
  FinalizeRefusedError,
  logNote,
  type CancelClockAnswer,
  type CancelClockRequest,
  type FinalizeDeps,
  type FinalizePorts,
  type FinalizeRow,
  type RowRead,
  type WritePlanAnswer,
  type WritePlanRequest,
} from "../../finalize";
import { VOCABULARY, type SlotName, type SlotSource } from "../../finalize/slots";
import { flowOfStep } from "../../frontier";
import { flowsListed } from "../../frontier/assemble/bundle";
import type { FlowLetter } from "../../frontier/assemble/types";
import type { Role } from "../../domain/identity-access";
import type { CallContext } from "../tool-api";
import { TurnFaceReadError, TurnFaceRefusedError } from "./errors";
import type { HeldTurns } from "./held";

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ---- K-05 v1.3's two reads, as the binding takes them (db/repo/turn-face-reads.ts) ----------------------------------

/** K-05 v1.3 readOutboxRow.response (item 35), the fields the binding reads. */
export interface OutboxRowRead {
  readonly result: "outboxRow";
  readonly outboxRowId: string;
  readonly businessId: string | null;
  readonly readAt: string;
  readonly row: {
    readonly turnId: string;
    readonly bundleId: { readonly hash: string; readonly build: number };
    readonly state: ComposeRow["state"];
    readonly version: number;
    readonly channel: ComposeRow["channel"];
    readonly sendClass: string;
    readonly bookingId: string | null;
    readonly openQuestionId: string | null;
    readonly copyOfRowId: string | null;
    readonly hasPlan: boolean;
    readonly finalParts: FinalizeRow["finalParts"];
  };
  readonly line: { readonly step: string; readonly index: number; readonly from: string } | null;
  readonly recipient: {
    readonly handleId: string;
    readonly kind: "phone" | "email";
    readonly personId: string | null;
    readonly name: string | null;
    readonly storedLanguage: string | null;
    readonly roles: readonly { readonly roleId: string; readonly role: Role; readonly version: number }[];
  };
  readonly answers: { readonly handleId: string; readonly texts: readonly AnsweredText[] };
  readonly slotSource: {
    readonly business: {
      readonly id: string;
      readonly name: string;
      readonly displayName: string;
      readonly timeZone: string;
      readonly version: number;
    } | null;
    readonly booking: { readonly flow: FlowLetter } | null;
    readonly question: {
      readonly id: string;
      readonly options: readonly Option[];
      readonly version: number;
      readonly clockRow: {
        readonly id: string;
        readonly state: string;
        readonly dueAt: string | null;
        readonly dueZone: string | null;
        readonly version: number;
      } | null;
    } | null;
  };
  readonly openQuestions: readonly { readonly id: string; readonly step: string; readonly text: string }[];
}

/** K-05 v1.3 readFixedLineFacts.response (item 36), the fields the binding reads. */
export interface FixedLineFactsRead {
  readonly result: "fixedLineFacts";
  readonly textedAboutBusiness: boolean;
  readonly optOutLineDeliveredAt: string | null;
}

/** A K-05 error answer: notFound, transient, or readOutboxRow's fixedLineRow. */
export interface RowErrorAnswer {
  readonly error: string;
}

/** What the two reads and finalize's two writes are, each the runtime side's own transaction (pg/calls.ts). */
export interface RowData {
  readOutboxRow(request: {
    outboxRowId: string;
    businessId: string;
  }): Promise<OutboxRowRead | RowErrorAnswer>;
  readFixedLineFacts(request: {
    outboxRowId: string;
    businessId: string;
  }): Promise<FixedLineFactsRead | RowErrorAnswer>;
  writePlan(request: WritePlanRequest): Promise<WritePlanAnswer>;
  cancelClock(request: CancelClockRequest): Promise<CancelClockAnswer>;
}

/** What the compose and finalize bindings read through: K-05's calls, the pinned bundles, and the turns the face holds. */
export interface RowBinding {
  readonly data: RowData;
  readonly bundles: ComposeBundles;
  readonly held: HeldTurns;
  /** Now, in UTC (RFC 3339 ending in Z), for a passed-on question's withdrawal. Default: the clock, to the second. */
  readonly now?: () => string;
  /** Told one note per finalize attempt (labels only). Default: finalize's own JSON line. */
  readonly log?: FinalizeDeps["log"];
}

// ---- the row, as both calls read it ---------------------------------------------------------------------------------

/** The step, as the row's bundle holds it in the flow default 53 gives, with that flow. */
interface StepRead {
  readonly flow: FlowLetter;
  readonly step: Json;
  readonly manifest: Json;
}

/** The step in one flow graph, when the value is K-01 v1's graph of that flow and holds it. */
function stepIn(graph: unknown, flow: FlowLetter, stepId: string): Json | null {
  if (!isRecord(graph) || graph.contract !== "bundle.v1" || graph.flow !== flow || !isRecord(graph.steps)) {
    return null;
  }
  const found = Object.hasOwn(graph.steps, stepId) ? graph.steps[stepId] : undefined;
  return isRecord(found) && (found.id === undefined || found.id === stepId) ? found : null;
}

/**
 * The row's step in the flow default 53 gives: an A or B step's own; a shared step's, the booking's for a row about one,
 * else the first of A, then B, the bundle lists whose graph holds it. Refused when the bundle or the step is missing.
 */
async function stepOf(bundles: ComposeBundles, read: OutboxRowRead, stepId: string): Promise<StepRead> {
  const manifest = await bundles.manifest(read.row.bundleId);
  if (!isRecord(manifest)) throw new TurnFaceRefusedError("bundleMissing");
  const listed = flowsListed(manifest);
  const own = flowOfStep(stepId);
  const booking = read.slotSource.booking?.flow ?? null;
  const order: FlowLetter[] = own !== null ? [own] : booking !== null ? [booking] : ["A", "B"];
  for (const flow of order.filter((letter) => listed.includes(letter))) {
    const step = stepIn(await bundles.flow(read.row.bundleId, flow), flow, stepId);
    if (step !== null) return { flow, step, manifest };
  }
  throw new TurnFaceRefusedError("stepMissing");
}

/** The step's messages from Rosie to a reader's lane, in its `say` order. */
function linesTo(step: Json, reader: Reader): Json[] {
  const say: unknown[] = Array.isArray(step.say) ? step.say : [];
  return say.filter(
    (message): message is Json =>
      isRecord(message) && message.from === ROSIE_LANE && message.to === READER_LANES[reader],
  );
}

/**
 * The reader: the first of the recipient's live roles (in role id order) whose reader the step's line from Rosie at the
 * row's index is written to (S13-31); with none, refused.
 */
function readerAndRole(read: OutboxRowRead, step: Json, index: number): { reader: Reader; role: Role } {
  for (const { role } of read.recipient.roles) {
    const reader = readerOf(role);
    if (reader !== null && linesTo(step, reader)[index] !== undefined) return { reader, role };
  }
  throw new TurnFaceRefusedError("noReader");
}

/** Default 4: how Rosie addresses the reader, the first word of the stored name. */
export function addressedAs(name: string | null): string | null {
  const first = name?.trim().split(/\s+/u)[0] ?? "";
  return first === "" ? null : first;
}

/** The link slots of the vocabulary (K-03 slots.json kind link). */
const LINK_SLOTS: ReadonlySet<string> = new Set(
  VOCABULARY.filter((slot) => slot.kind === "link").map((slot) => slot.name),
);

/** Default 8: the lines of the step's card on the reader's line that name no slot. */
function termsOf(line: Json): string[] {
  const elements = isRecord(line.elements) ? line.elements : {};
  const card = isRecord(elements.card) ? elements.card : {};
  const lines: unknown[] = Array.isArray(card.lines) ? card.lines : [];
  return lines.filter((each): each is string => typeof each === "string" && !each.includes("{{"));
}

/** What both calls take from one row read, checked: the row, its step and reader, its source and its words. */
interface RowView {
  readonly read: OutboxRowRead;
  readonly step: StepRead;
  readonly stepId: string;
  readonly index: number;
  readonly reader: Reader;
  readonly role: Role;
  readonly master: string;
  readonly optOutLines: readonly string[];
  readonly source: SlotSource;
  readonly language: string;
  readonly name: string | null;
}

/** The row read for `call`, refused (notBuilt) where default 7 says the binding reads no more yet. */
async function viewOf(
  binding: RowBinding,
  read: OutboxRowRead,
  call: "composeInput" | "finalizeMessage",
): Promise<RowView> {
  if (read.line === null) throw new TurnFaceRefusedError("noLine");
  const business = read.slotSource.business;
  if (business === null || read.row.bookingId !== null || read.slotSource.booking !== null) {
    throw new NotBuiltError(call);
  }
  const question = read.slotSource.question;
  if (question !== null && question.options.length > 0) throw new NotBuiltError(call);
  const stepId = read.line.step;
  const step = await stepOf(binding.bundles, read, stepId);
  const { reader, role } = readerAndRole(read, step.step, read.line.index);
  const line = linesTo(step.step, reader)[read.line.index];
  if (line === undefined || typeof line.text !== "string") throw new TurnFaceRefusedError("noReader");
  const optOutLines = optOutLinesOf(step.manifest);
  const clock = question?.clockRow ?? null;
  const askBy =
    clock !== null && clock.state === "armed" && clock.dueAt !== null && clock.dueZone !== null
      ? { askBy: { utc: clock.dueAt, zone: clock.dueZone } }
      : {};
  const held = binding.held.of(read.row.turnId);
  return {
    read,
    step,
    stepId,
    index: read.line.index,
    reader,
    role,
    master: withoutOptOutLine(line.text, optOutLines),
    optOutLines,
    source: {
      filledAt: read.readAt,
      zones: { visit: null, business: business.timeZone },
      channel: read.row.channel,
      // DL-326 note b: the switch is not read yet, so it is on (the display name shows): fail closed.
      sensitive: true,
      record: null,
      facts: { business: { name: business.name, displayName: business.displayName }, ...askBy },
    },
    language: held?.language ?? read.recipient.storedLanguage ?? "en",
    name: addressedAs(read.recipient.name),
  };
}

/** The text the row replies to: the words held for the turn's last text the face holds, only to their own sender. */
function inboundOf(binding: RowBinding, read: OutboxRowRead): InboundText | null {
  if (read.answers.handleId !== read.recipient.handleId) return null;
  const held = binding.held.of(read.row.turnId);
  if (held?.handleId !== read.answers.handleId) return null;
  const texts = read.answers.texts.flatMap((text) => {
    const words = held.texts.get(text.eventId);
    return words === undefined ? [] : [words];
  });
  const last = texts.at(-1);
  return last === undefined
    ? null
    : { text: last.words, sentAt: last.sentAt, fromHandleId: read.answers.handleId };
}

/** The outcomes of the texts the row answers, each once, in order (null: no row the scope shows). */
function outcomesOf(read: OutboxRowRead): string[] {
  return [...new Set(read.answers.texts.flatMap((text) => text.outcomes ?? []))];
}

// ---- compose input's readRow ------------------------------------------------------------------------------------------

/** The compose row of one read: item 35's table, then the defaults at the top. */
export async function composeRowOf(binding: RowBinding, read: OutboxRowRead): Promise<ComposeRow> {
  const view = await viewOf(binding, read, "composeInput");
  const links = slotsIn(view.master).filter((slot) => LINK_SLOTS.has(slot));
  return {
    outboxRowId: read.outboxRowId,
    turnId: read.row.turnId,
    state: read.row.state,
    hasPlan: read.row.hasPlan,
    channel: read.row.channel,
    copyOfRowId: read.row.copyOfRowId,
    fixedLineId: null,
    recipientHandleId: read.recipient.handleId,
    bundleId: read.row.bundleId,
    flow: view.step.flow,
    step: view.stepId,
    line: view.index,
    role: view.role,
    name: view.name,
    way: read.recipient.kind === "email" ? "email" : "texts",
    handlingLine: null,
    language: view.language,
    source: view.source,
    claim: {},
    factSlots: [],
    conversation: [],
    allowedFormats: ["text"],
    allowedLinks: links as ComposeRow["allowedLinks"],
    options: [],
    openQuestions: read.openQuestions.map((question) => ({ id: question.id, text: question.text })),
    inbound: inboundOf(binding, read),
    situation: { safetyOutcomes: outcomesOf(read), about: [] },
  };
}

/** A read's error as the calls answer it: notFound and transient are their own errors; any other is thrown. */
function rowErrorOf(
  error: RowErrorAnswer,
): { error: "notFound"; table: string; rowId: string } | { error: "transient"; sqlstate: string } {
  const answer = error as unknown as Json;
  if (answer.error === "notFound" && typeof answer.table === "string" && typeof answer.rowId === "string") {
    return { error: "notFound", table: answer.table, rowId: answer.rowId };
  }
  if (answer.error === "transient" && typeof answer.sqlstate === "string") {
    return { error: "transient", sqlstate: answer.sqlstate };
  }
  throw new TurnFaceReadError("readOutboxRow", error.error);
}

/** Compose input's deps: its readRow over readOutboxRow and the pinned bundles. */
export function composeInputDeps<Repo>(binding: RowBinding): ComposeInputDeps<Repo> {
  return {
    bundles: binding.bundles,
    ports: {
      async readRow(outboxRowId, call): Promise<ComposeRowRead> {
        const read = await binding.data.readOutboxRow({ outboxRowId, businessId: call.businessId });
        if ("error" in read) {
          if (read.error === "fixedLineRow") throw new ComposeInputRefusedError("fixedLineRow");
          return rowErrorOf(read);
        }
        return composeRowOf(binding, read);
      },
    },
  };
}

// ---- finalize's readRow and the fixed lines' facts --------------------------------------------------------------------

/** The bundle's shared lists the checks and the inserter read (K-01 v1 manifest lists: keywords and fixed lines). */
function listsOf(manifest: Json): CheckLists {
  const lists = isRecord(manifest.lists) ? manifest.lists : {};
  return { keywords: lists.keywords, fixedLines: lists.fixedLines } as CheckLists;
}

/** The finalize row of one read: item 35's table, then the defaults at the top. */
export async function finalizeRowOf(binding: RowBinding, read: OutboxRowRead): Promise<FinalizeRow> {
  const view = await viewOf(binding, read, "finalizeMessage");
  const question = read.slotSource.question;
  const clock = question?.clockRow ?? null;
  if (question !== null && clock === null) throw new TurnFaceRefusedError("noClockRow");
  const line = linesTo(view.step.step, view.reader)[view.index] ?? {};
  const terms = termsOf(line);
  const claim = { reader: view.reader };
  const masterFacts = claimFacts(
    slotsIn(view.master).filter((slot): slot is SlotName => !LINK_SLOTS.has(slot)),
    view.source,
    claim,
  );
  const fallback = view.step.step.fallbackText;
  const row: FinalizeRow = {
    outboxRowId: read.outboxRowId,
    version: read.row.version,
    state: read.row.state,
    channel: read.row.channel,
    finalParts: read.row.finalParts,
    fixedLineId: null,
    step: view.stepId,
    reader: view.reader,
    claim: {},
    source: view.source,
    checks: {
      lists: listsOf(view.step.manifest),
      language: view.language,
      businessName: null,
      options: [],
      typedOptions: null,
      allowedFormats: ["text"],
      facts: [...masterFacts, ...terms.map((value) => ({ slot: "term", value }))],
      terms,
      readerName: view.name,
      masterText: view.master,
    },
    calendarFile: "none",
    fallbackText: typeof fallback === "string" && fallback.trim() !== "" ? fallback : null,
    question:
      question === null || clock === null
        ? null
        : {
            openQuestionId: question.id,
            openQuestionVersion: question.version,
            clockRowId: clock.id,
            clockVersion: clock.version,
          },
  };
  // The business a fixed line names is the one limit 7 lets this reader see (T-314: claimedBusiness).
  return { ...row, checks: { ...row.checks, businessName: claimedBusiness(row) } };
}

/** Default 9: each danger outcome's K-01 line on a row to the danger text's writer; never safetyAsk, never a threat's. */
export function safetyLinesFor(read: OutboxRowRead): string[] {
  if (read.answers.handleId !== read.recipient.handleId) return [];
  const lines: string[] = [];
  for (const outcome of outcomesOf(read)) {
    if (outcome === "No" || outcome === "A threat to staff or others") continue;
    const line =
      outcome === "Unsure"
        ? "safetyCrisis"
        : ((FIXED_LINE_OF as Readonly<Record<string, string>>)[outcome] ?? "safetyEmergency");
    if (!lines.includes(line)) lines.push(line);
  }
  return lines;
}

/** Finalize's deps: readRow, the fixed lines' facts, writePlan and cancelClock over K-05, review items not built. */
export function finalizeDeps<Repo>(binding: RowBinding): FinalizeDeps<Repo> {
  // Each call's row read, for the fixed lines' facts of the same call (answers.texts as read: T-1164).
  const reads = new WeakMap<CallContext<Repo>, OutboxRowRead>();
  const facts: FixedLinePorts<Repo> = {
    async readFixedLines(row, call): Promise<FixedLineFacts> {
      const read = reads.get(call);
      if (read?.outboxRowId !== row.outboxRowId) throw new FinalizeNotBuiltError("insertFixedLines");
      const answer = await binding.data.readFixedLineFacts({
        outboxRowId: row.outboxRowId,
        businessId: call.businessId,
      });
      if ("error" in answer) throw new TurnFaceReadError("readFixedLineFacts", answer.error);
      return {
        textedAboutBusiness: answer.textedAboutBusiness,
        optOutLineDeliveredAt: answer.optOutLineDeliveredAt,
        lines: safetyLinesFor(read),
        answeredTexts: read.answers.texts,
      };
    },
  };
  const ports: FinalizePorts<Repo> = {
    async readRow(outboxRowId, call): Promise<RowRead> {
      const read = await binding.data.readOutboxRow({ outboxRowId, businessId: call.businessId });
      if ("error" in read) {
        if (read.error === "fixedLineRow") throw new FinalizeRefusedError("fixedLineRow");
        return rowErrorOf(read);
      }
      reads.set(call, read);
      return finalizeRowOf(binding, read);
    },
    insertFixedLines: fixedLineInserter(facts),
    writePlan: (request) => binding.data.writePlan(request),
    cancelClock: (request) => binding.data.cancelClock(request),
    openReviewItem: () => Promise.reject(new FinalizeNotBuiltError("openReviewItem")),
  };
  return {
    ports,
    now: binding.now ?? (() => new Date().toISOString().replace(/\.\d{3}Z$/u, "Z")),
    log: binding.log ?? logNote,
  };
}
