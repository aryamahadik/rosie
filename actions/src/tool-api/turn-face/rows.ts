// The turn face's compose input and finalize (T-1141; C-074 over C-090, C-093 and C-089): the two readRow ports and the
// fixed lines' facts bound to K-05's readOutboxRow, as v1.6 answers it (v1.3's row with the business's sensitive switch:
// T-1197, T-1190), and v1.3's readFixedLineFacts (T-1138), from K-05 v1.3 item 35's table ("T-1141 binds the ports from
// this table; nothing else is read for them") and v1.6 item 45, the words the runtime hands in (default 47) and the
// pinned bundle the row was committed under. Both reads run on the runtime side (rosie_job) in a read-only transaction of
// their own under the call's business (STATE note 59; T-315's security note b; readOutboxRow, never readOutboxRowIn, so
// the read holds its own read-only transaction: DL-402 note b); finalize's two K-05 writes (writePlan, cancelClock) are
// the runtime side's own transactions too.
//
// Where each field comes from (item 35's table, and the defaults below where the table leaves a rule to the caller):
//   - the row, its step and line (line 0 of the question it asks), its turn, bundle and channel: readOutboxRow; a null line
//     is refused, never guessed; a safety row (fixedLineRow) is the handlers' fixed-line refusal;
//   - the flow the step is read in: default 53 (an A or B step's own; a shared step's, the booking's, else the first of A,
//     then B, that the row's bundle lists whose graph holds the step; none: stepMissing);
//   - the reader (ComposeRow.role, FinalizeRow.reader): K-05 v1.5 item 44's mapping, exactly as its rowReader states it
//     (rowReaderOf below; T-1184, DL-364, DL-370): a recipient who holds a live role at the row's business is read by the
//     role the message is for, through readerOf, never by the line; a recipient who holds no role is read by the audience
//     of the step line the row carries only when they are a person (default 64), the step is in section 1 of its flow (K-01
//     step.section, default 65) and that line's lane, told with no role (default 62), is owner, staff or cust; every other
//     row is refused (noReader, with rowReader's why). The sign-up reading's ComposeRow.role is the reader's own name
//     (default 63): it is how this one call reads the row, never written, cached or handed on as a role the person holds.
//     Only the row's own recipient's roles are read, as readOutboxRow answers them (S13-31);
//   - the source: the business head (biz.name and its display name), the business's zone, the row's channel, ask.by from
//     the question's armed clock row; the sensitive switch from readOutboxRow's businessSensitive (K-05 v1.6 item 45;
//     sensitiveOf below);
//   - the step's master line, links, card terms and fallback text: the pinned bundle, at the step, in that flow;
//   - the situation's safety outcomes: answers.texts' outcomes; the inbound text: the words the runtime handed in for
//     answers.texts (gateAndCommit's context.texts, held by the face for its turn: held.ts), only when answers.handleId
//     is the recipient's (DL-326 note d), else none; never words read from the database;
//   - finalize's question: the row's question with its clock row (a question with no clock row is refused: default 54);
//   - the fixed lines' facts: readFixedLineFacts' two facts, readOutboxRow's answers.texts as read (T-1164), and the row's
//     other lines: a K-01 safety line only on a row to the danger text's writer, never safetyAsk (DL-355).
// Nothing here logs; a refusal names a fault, never a value.
//
// The sensitive switch (K-05 v1.6 item 45 and default 67; RULES 4.6; S13-22; T-1190, DL-391, DL-395, DL-402). It is
// SlotSource.sensitive, which the claim check and the fill read (each slot in its sensitive form, so biz.name gives the
// display name) and the situation tag reads (gentle). For a row about no booking it is the row's business's switch as
// readOutboxRow answers it, and only an answer of exactly false is off: null (the business holds no kinds of work yet:
// open gap 47), a field left out (a v1.3 to v1.5 answer) and true are on, so it fails closed (DL-326 note b; the security
// review's N1 on T-1196: never `!x` or `x ?? false`, which would read a missing switch as off). A row about a booking is
// on whatever the business's switch (item 35's table; open gap 30: its booking's own switch is not read yet). A read that
// fails never gives a switch: K-05's transientError carries no row and no switch, so the call fails with its own
// transient error (nothing read, the same request may be sent again; DL-402 note a), never read as on, off or null; any
// other error answer, and a read that throws, is thrown (rowErrorOf).
//
// Defaults used (for ops/QUESTIONS.md):
//   4. How Rosie addresses the reader (K-03 audience.name; finalize's readerName) is the first word of the stored name
//      ("Sam Lee" gives "Sam", as K-09's compose-input-s1-02.json shows), or null when none is stored. Since T-1174,
//      compose input addresses ComposeRow.name itself (compose-input addressedAs), so the binding hands it the name as
//      the row read gives it, and finalize's readerName the same first word.
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
//  10. The role the message is for (rowReader's by-role branch, "the caller's": K-05 v1.5 README item 44; T-308) is the
//      first of the recipient's live roles, in role id order as stored, whose reader the step's line from Rosie at the
//      row's index is written to (S13-31: "the role comes from what the message is about"). When none is (every role reads
//      as no one, or as a reader the line is not written to), no role the recipient holds reads the row: it is refused as
//      roleReadsAsNoOne, the one refusal K-05 v1.5's rules give a recipient who holds a role, who is never read by the line.
//  11. A row K-05's readOutboxRow answers fixedLineRow (a safety row: K-05 v1.3) is refused here, thrown (fixedLineRow):
//      K-09 v1.6's fixedLineRow answer names the row's fixed line by its id, which K-05's error does not give, so it is
//      never guessed. A row whose bundle or step is missing is refused before a reader is looked for (K-05 v1.5
//      rowReader.errors; bundleMissing, stepMissing), so compose input never reaches its masterLineMissing for it.

import type * as K05 from "../../../../contracts/generated/data-access/data-access.v1.6";
import { NotBuiltError } from "../errors";
import {
  addressedAs,
  slotsIn,
  type ComposeBundles,
  type ComposeInputDeps,
  type ComposeRow,
  type ComposeRowRead,
} from "../../compose-input";
import type { InboundText } from "../../compose-input/types";
import { optOutLinesOf, withoutOptOutLine, READER_LANES, ROSIE_LANE } from "../../compose-input/master-line";
import { FIXED_LINE_OF } from "../../commit/core";
import { claimFacts, readerOf, type Reader } from "../../finalize/claim-check";
import type { CheckLists } from "../../finalize/checks";
import {
  claimedBusiness,
  fixedLineInserter,
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

// ---- K-05's two reads, as the binding takes them (db/repo/turn-face-reads.ts) ----------------------------------------

/**
 * K-05 v1.6 readOutboxRow.v1dot6Response (items 35 and 45): the answer a v1.6 call gives, as db/repo's readOutboxRow
 * types it (T-1197): v1.3's row with the row's business's sensitive switch, businessSensitive, always stated (true, false
 * or null). A v1.3 to v1.5 answer, which has none, is not this type; one that reaches the binding all the same reads as
 * null, on (default 67: sensitiveOf).
 */
export type OutboxRowRead = K05.ReadOutboxRowV1Dot6Response;

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

// ---- the reader: K-05 v1.5 rowReader (README item 44; defaults 62 to 65) ---------------------------------------------

/** K-05 v1.5 rowReader's request: what the reader mapping reads, from one row read and the row's bundle. */
export type RowReaderRequest = K05.RowReaderRequest;

/** K-05 v1.5 rowReader's outcome: the reader, by a role or by the sign-up line, or noReader with why. */
export type RowReaderOutcome = K05.RowReaderResponse | K05.RowReaderErrors;

/** K-01 v1's lanes (bundle.v1 lane). */
const LANES: readonly string[] = ["owner", "san", "staff", "cust", "agent", "pay", "out", "other"];

const isLane = (value: unknown): value is K05.Lane => typeof value === "string" && LANES.includes(value);

/** Section 1 of a flow, the sign-up section the sign-up door enters (K-02 v1.1 default 9; ADR-013 section 3). */
const SIGN_UP_SECTION = 1;

/** A flow graph's sections, 1 to 13 (K-01 v1 step.section; SPEC-master section 1). */
const isSection = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 13;

/**
 * Default 62: the lane of the step line the row carries, told with no role: the step's `say` messages from Rosie (from
 * san), in say order. When they all go to one lane, that lane, the row's index counted among them; null when they go to
 * two or more lanes (the index counts the lines to a reader, which only a role names), and null when the step has no line
 * from Rosie at that index.
 */
export function lineToOf(step: Json, index: number): K05.Lane | null {
  const say: unknown[] = Array.isArray(step.say) ? step.say : [];
  const fromRosie = say.filter(
    (message): message is Json => isRecord(message) && message.from === ROSIE_LANE,
  );
  const lanes = new Set(fromRosie.map((message) => message.to));
  const [lane] = lanes;
  return lanes.size === 1 && isLane(lane) && fromRosie[index] !== undefined ? lane : null;
}

/** The reader a reader lane names (K-01 lane to K-03 readerRole: READER_LANES, read back): owner, staff and cust. */
function readerOfLane(lane: K05.Lane | null): Reader | null {
  const readers: readonly Reader[] = ["owner", "staff", "customer"];
  return readers.find((reader) => READER_LANES[reader] === lane) ?? null;
}

/**
 * K-05 v1.5 rowReader (README item 44), exactly. A recipient who holds a live role at the row's business is read by the
 * role the message is for, through readerOf, and never by the line: the first role whose reader `lineFor` says the
 * step's line at the row's index is written to (default 10), else noReader roleReadsAsNoOne. A recipient who holds no
 * role is read by the line's audience only as a person (default 64) on a section 1 step (default 65) whose line goes to
 * owner, staff or cust (default 62): by the sign-up line, with no role id (default 63). Every other one is refused:
 * noReader, noRole (no person, or outside section 1) or lineHasNoReader (a line to no reader, or lineTo null).
 */
export function rowReaderOf(
  request: RowReaderRequest,
  lineFor: (reader: Reader) => boolean,
): RowReaderOutcome {
  const { outboxRowId, recipient } = request;
  const noReader = (why: K05.NoReaderError["why"]): K05.NoReaderError => ({
    error: "noReader",
    outboxRowId,
    why,
  });
  if (recipient.roles.length > 0) {
    for (const { roleId, role } of recipient.roles) {
      const reader = readerOf(role);
      if (reader !== null && lineFor(reader)) {
        return { result: "reader", outboxRowId, reader, from: "roles", roleId };
      }
    }
    return noReader("roleReadsAsNoOne");
  }
  if (recipient.personId === null || request.section !== SIGN_UP_SECTION) return noReader("noRole");
  const reader = readerOfLane(request.lineTo);
  if (reader === null) return noReader("lineHasNoReader");
  return { result: "reader", outboxRowId, reader, from: "signUpLine", roleId: null };
}

/** One row's reader, as item 44 maps it: rowReader's request, built from the read and the row's bundle, and its outcome. */
export interface RowReading {
  readonly request: RowReaderRequest;
  readonly outcome: RowReaderOutcome;
  /** The step the request was read from, in its flow (default 53). */
  readonly step: StepRead;
}

/**
 * The reader of one row read (item 35's table, row role; FinalizeRow.reader): rowReader's request from readOutboxRow's
 * answer (the row, its bundle and line, its own recipient's person and live roles as stored) and the row's bundle (the
 * flow, the step's section, the lane of its line), then rowReaderOf. A null line, a step the bundle does not hold and a
 * step with no section are refused before a reader is looked for (noLine, stepMissing).
 */
export async function readerOfRow(bundles: ComposeBundles, read: OutboxRowRead): Promise<RowReading> {
  const line = read.line;
  if (line === null) throw new TurnFaceRefusedError("noLine");
  const step = await stepOf(bundles, read, line.step);
  const section = step.step.section;
  if (!isSection(section)) throw new TurnFaceRefusedError("stepMissing");
  const request: RowReaderRequest = {
    outboxRowId: read.outboxRowId,
    bundleId: { hash: read.row.bundleId.hash, build: read.row.bundleId.build },
    line: { step: line.step, index: line.index, from: line.from },
    recipient: {
      personId: read.recipient.personId,
      roles: read.recipient.roles.map(({ roleId, role, version }) => ({ roleId, role, version })),
    },
    flow: step.flow,
    section,
    lineTo: lineToOf(step.step, line.index),
  };
  const outcome = rowReaderOf(request, (reader) => linesTo(step.step, reader)[line.index] !== undefined);
  return { request, outcome, step };
}

/** ComposeRow.role for a reading: the role the message is for, or the reader's own name (default 63), never stored. */
function roleOfReading(read: OutboxRowRead, outcome: K05.RowReaderResponse): Role {
  if (outcome.from === "signUpLine") return outcome.reader;
  const held = read.recipient.roles.find((each) => each.roleId === outcome.roleId);
  if (held === undefined) throw new TurnFaceRefusedError("noReader", "roleNotHeld");
  return held.role;
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
  /** The reader's name as the row read gives it (K-04 persons.name): ComposeRow.name, which compose input addresses. */
  readonly storedName: string | null;
  /** Default 4: the name Rosie addresses the reader by, its first word (finalize's readerName). */
  readonly name: string | null;
}

/**
 * The row's sensitive switch, SlotSource.sensitive (K-05 v1.6 item 45; see the top): on for a row about a booking (item
 * 35's table; open gap 30); for a row about no booking, off only when readOutboxRow's businessSensitive is exactly false.
 * null (no kinds of work stored), a field left out (default 67) and true are on, so nothing unknown reads as off.
 */
export function sensitiveOf(read: OutboxRowRead): boolean {
  if (read.row.bookingId !== null || read.slotSource.booking !== null) return true;
  return read.businessSensitive !== false;
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
  // Item 44's mapping (K-05 v1.5 rowReader): the reader, or the row refused with rowReader's why.
  const { outcome, step } = await readerOfRow(binding.bundles, read);
  if ("error" in outcome) throw new TurnFaceRefusedError("noReader", outcome.why);
  const { reader } = outcome;
  const role = roleOfReading(read, outcome);
  const line = linesTo(step.step, reader)[read.line.index];
  if (line === undefined || typeof line.text !== "string") {
    throw new TurnFaceRefusedError("noReader", "lineHasNoReader");
  }
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
      // K-05 v1.6 item 45: the business's switch, off only when readOutboxRow answers exactly false (see the top).
      sensitive: sensitiveOf(read),
      record: null,
      facts: { business: { name: business.name, displayName: business.displayName }, ...askBy },
    },
    language: held?.language ?? read.recipient.storedLanguage ?? "en",
    storedName: read.recipient.name,
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
    // The name as the row read gives it: compose input addresses the reader by its first word (T-1174; default 4).
    name: view.storedName,
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

/**
 * A read's error as the calls answer it: notFound and transient are their own errors, so the call fails with nothing read
 * (a transientError carries no row and no switch, never read as on, off or null: DL-402 note a); any other is thrown.
 */
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
          // Default 11: K-05's fixedLineRow names no fixed line, so K-09 v1.6's fixedLineRow cannot be given: refused.
          if (read.error === "fixedLineRow") throw new TurnFaceRefusedError("fixedLineRow");
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
