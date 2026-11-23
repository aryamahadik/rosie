// Data-access K-05 v1 item 12: park a turn after a third crash before its commit (T-197; C-152; K-05 README item 12;
// arch 11 line 576: "A third crash before the commit parks the turn for Rosie's team, freeing the inbox for later texts;
// the person hears once that nothing changed and that Rosie's team will reply within 1 business day"; K-37 v1
// parked_turns; QUESTIONS.md CQ-96). The runtime's park (runtime/src/turn/park.ts, TurnRows.parkTurn; joined at D-017)
// calls it; no Tool API path does.
//
// K-05 v1.23 item 84 (T-1542, T-1529's ruling card 4; DL-1185; README defaults 216 to 224): the same call also takes
// v1.23's form, parkTurn.lineRequest: a turn parked at once on a final refusal (tries 1 to 3, with the refusal's labels
// as its reason) or after a third crash (tries 3, no reason), with exactly one row that carries K-01's passedOn line in
// its plan and final parts. The two forms never overlap (the schema's parkTurn.request): a v1.23 request names a reason
// or its row holds a plan or final parts, which a v1 row never does, so either one sends the request down v1.23's path,
// and every other request is v1's, checked and written exactly as before.
//
// One transaction on the primary, on the runtime side (K-05 README "Scope": runtime; run as rosie_job, no business
// scope), writes all of it or nothing:
//   1. the turns row as parked, with its tries (3 in v1's form; 1 to 3 in v1.23's) and parked_at (NQ-RT-3's default: a
//      turn row is written once, as committed or parked). Its id is the primary key, so a park sent again (a lost
//      answer, the lease's retry) meets the first: `insert ... on conflict (id) do nothing` waits for a park of the same
//      id still in flight and then finds it. A parked turn answers its first park (when, and its outbox rows by turn id
//      in commit order) with repeated true, whatever the repeat's body or form (v1.23 default 223), and writes nothing; a
//      committed turn answers alreadyCommitted: it is never parked.
//   2. K-37's parked_turns row for Rosie's team: open, with a plain error summary (default 1; in v1.23's form with a
//      reason, built from the reason's labels and the try: v1.23 default 220), the reply due 1 business day after the
//      park (default 2), and when the person was told left empty (default 3; v1.23 open gap 104).
//   3. the one outbox row (at most one in v1's form, exactly one in v1.23's), under the turn's id, bundle and trace id,
//      with commit_seq from K-04's identity column. In v1's form it is the "nothing changed" row with no plan, in K-04's
//      first state, as the request gives it (CQ-96 (a)); the runtime never words it. In v1.23's form it is inserted the
//      same way, planned at version 1, and then, in the same transaction, given the request's plan and final parts and
//      moved to checked at version 2, K-07's two moves `(new) -> planned` and `planned -> checked`, as sign-in-send.ts
//      writes a code's email row (v1.23 default 221): no reader ever sees it without final parts, so the claim walks and
//      claims it like any checked row and no longer passes it (K-05 default 183 passes a parked turn's row only while it
//      has no plan). writePlan's opener mark and markPart's opt-out time are not written (defaults 200 and 203): the row
//      carries neither line, and neither call runs.
//   4. the request's event-log entries, each under the turn's id, trace id and bundle, at parkedAt (v1.23 default 222:
//      one turn.parked).
//
// Answers: parked (repeated or not), alreadyCommitted, or transient (a serialization failure, a deadlock or a lost
// connection: nothing was written, and the same request may be sent again). K-05 gives parkTurn no other refusal, so a
// database rule that refuses a write (an outbox row id already taken, a handle that does not exist) throws
// DataAccessDatabaseError, carrying only the SQLSTATE and the names of the table and the constraint, and a request this
// call cannot carry out throws a TypeError, named by its field and never by its value; nothing is written either way.
// What v1.23's form is checked for before any statement (README item 84 and its card 4 list): tries 1 to 3; a reason of
// three K-08 safe ids (letters, digits and _ . : / # -, never a run that reads as a number), its ids each once, required
// before the third try (default 218); exactly one row in parkedRowNew's form, whose recipient is the turn's own handle
// (default 219), whose plan is parkedLinePlan and whose final parts are parkedLineParts, each naming the row and its
// channel, the words exactly the passedOn line (default 216). Not checked (item 84): whether the refusal is final (the
// runtime's, by T-1529's ruling 1), the reason against the turn, the words against the turn's pinned bundle, and the
// entries beyond v1's form (the schema leaves an entry's why free: default 222).
//
// Nothing here logs. error_summary holds no value from the turn's sealed texts, nor any of the request's values but the
// reason's labels and the try: a fixed description, or default 220's form of labels (K-37 rule 4: plain descriptions
// only). The row's words are the passedOn line, a constant of the schema checked here, never the model's or a slot's.
//
// Defaults used (for ops/QUESTIONS.md; each where no source decides):
//   1. error_summary is PARKED_ERROR_SUMMARY, fixed, for a park with no reason: K-05 v1's parkTurn carries no error
//      (QUESTIONS.md CQ-96 (b)), and a fixed text can never hold a value from the sealed texts. With a reason it is
//      v1.23 default 220's form (parkedErrorSummary).
//   2. reply_due_at is 1 business day after parked_at in Rosie's team's zone, America/New_York (Q-54's default zone for
//      the team's day; Q-18: the team is Jay and the CTO), Monday to Friday, no holidays (K-37 open gap: the business-day
//      calendar): the next weekday at the same local time, so a Saturday park is due on Monday, as K-37's
//      seed-parked-turn shows.
//   3. person_told_at stays null at the park: the row is written, not yet sent (who sets it once the row goes out is a
//      new question; v1.23 open gap 104).
//   4. Which form a request takes (T-1531's database engineer review, note 5): v1.23's when it names a reason or its
//      row holds a plan or final parts, else v1's. So a row with a plan and no reason on a third try is v1.23's crash
//      park (park-turn-maya-crash-with-line), and a v1.23 request whose one row lost its plan is still v1.23's, refused.
import type * as K05 from "../../contracts/generated/data-access/data-access.v1.1";
import type * as K05v123 from "../../contracts/generated/data-access/data-access.v1.23";
import {
  checkEventEntry,
  checkOutboxRowNew,
  checkTurn,
  insertOutboxRow,
  instantOf,
  logEntryOf,
  outboxRowsOfTurn,
  transientOrScrubbed,
} from "./clocks";
import { appendEvent } from "./event-log";
import type { Sql } from "./scope";
import { assertId, assertRequestShape, inRuntimeTransaction, utc } from "./targets";

/**
 * K-05 v1.23 parkTurn.request (items 12 and 84): v1's form (park-turn.json: the turn with tries 3, at most one row with
 * no plan) or v1.23's parkTurn.lineRequest. A v1 request (ParkTurnV1Request) is one of these.
 */
export type ParkTurnRequest = K05v123.ParkTurnRequest;
/** K-05 v1 parkTurn.request (park-turn.json): the turn with tries 3, when, at most one row with no plan, its entries. */
export type ParkTurnV1Request = K05.ParkTurnRequest;
/**
 * K-05 v1.23 parkTurn.lineRequest (item 84): the turn with tries 1 to 3, when, a final refusal's reason (required before
 * the third try, none for a crash), exactly one row with the passedOn line in its plan and final parts, its entries.
 */
export type ParkTurnLineRequest = K05v123.ParkTurnLineRequest;
/** K-05 v1.23 parkReason: a final refusal's labels (from, fault, ids), each a K-08 safe id (default 217). */
export type ParkReason = K05v123.ParkReason;
/** K-05 v1 parkTurn.response: parked; a repeat writes nothing and answers the first park with repeated true. */
export type ParkTurnResponse = K05.ParkTurnResponse;
/** K-05 v1 parkTurn.errors: the turn committed (never parked), or transient (nothing written). */
export type ParkTurnError = K05.AlreadyCommittedError | K05.TransientError;
export type ParkTurnOutcome = ParkTurnResponse | ParkTurnError;

/** The parked turn's error for Rosie's team after crashes: plain and fixed, never a value of the turn (default 1). */
export const PARKED_ERROR_SUMMARY =
  "Crashed three times before the commit (try 3 of 3); nothing was committed";

/**
 * K-01's passedOn fixed line, word for word, its two apostrophes the typographic one (U+2019), as bundles/v2's manifest
 * and K-01 v1's fixed-lines.json hold it: the only words a v1.23 park's row carries (K-05 v1.23 parkedLineParts, default
 * 216).
 */
export const PASSED_ON_LINE = "I’ve passed this on. Rosie’s team will reply within 1 business day.";

/** The zone Rosie's team's business days are counted in (default 2). */
export const TEAM_ZONE = "America/New_York";

const PARK = "parkTurn";

type Row = Record<string, unknown>;
type Json = Parameters<Sql["json"]>[0];

/** K-05 v1 channel (K-03 v1 channel; K-04 outbox_rows_channel_known). */
const CHANNELS = new Set(["imessage", "rcs", "sms", "email"]);
/** K-08 v1 safeId: letters, digits and _ . : / # -, starting with a letter or digit. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/#-]*$/;
/** K-08 v1 safeId's refusal: a run of digits and phone punctuation, seven or more long, reads as a number. */
const READS_AS_NUMBER = /^[0-9().+ -]{7,}$/;

const V1_FIELDS = ["turn", "parkedAt", "outboxRows", "events"];
const LINE_FIELDS = ["turn", "parkedAt", "reason", "outboxRows", "events"];
const LINE_REQUIRED = ["turn", "parkedAt", "outboxRows", "events"];
/** K-05 v1.23 parkedRowNew: v1's ten outboxRowNew fields, then the plan and the final parts. */
const ROW_FIELDS = [
  "id",
  "recipientHandleId",
  "recipientPersonId",
  "businessId",
  "bookingId",
  "channel",
  "sendClass",
  "openQuestionId",
  "copyOfRowId",
  "versionsRead",
  "plan",
  "finalParts",
];

/** A request the call cannot carry out, named by its field and never by its value. */
function fail(what: string): never {
  throw new TypeError(`${PARK}: ${what}`);
}

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An object with exactly these keys and no other. */
function exactly(value: unknown, keys: readonly string[]): value is Row {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isEmptyList(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

function isLabel(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value) && !READS_AS_NUMBER.test(value);
}

function assertNullableId(value: unknown, what: string): void {
  if (value !== null) {
    assertId(value, `${PARK}: ${what}`);
  }
}

/**
 * The error summary of K-37's row for Rosie's team (v1.23 default 220): with a reason, `Refused as final (<from>:
 * <fault>[; <ids, joined by ", ">]) on try <tries> of 3; nothing was committed`, built from the reason's labels and the
 * try alone; with none (a crash), PARKED_ERROR_SUMMARY (default 1).
 */
export function parkedErrorSummary(reason: ParkReason | null, tries: number): string {
  if (reason === null) {
    return PARKED_ERROR_SUMMARY;
  }
  const ids = reason.ids.length === 0 ? "" : `; ${reason.ids.join(", ")}`;
  return `Refused as final (${reason.from}: ${reason.fault}${ids}) on try ${String(tries)} of 3; nothing was committed`;
}

/** What code found before the database is reached: when, the reason (v1.23's, else null) and which form. */
interface ParkChecked {
  readonly parkedAt: Date;
  readonly reason: ParkReason | null;
  /** v1.23's form: the one row is planned then checked with the request's plan and final parts. */
  readonly line: boolean;
}

/** Whether a request takes v1.23's form (default 4): it names a reason, or a row of it holds a plan or final parts. */
function isLineForm(request: unknown): boolean {
  if (!isRecord(request)) {
    return false;
  }
  if (Object.hasOwn(request, "reason")) {
    return true;
  }
  const rows = request.outboxRows;
  return (
    Array.isArray(rows) &&
    rows.some(
      (row: unknown) => isRecord(row) && (Object.hasOwn(row, "plan") || Object.hasOwn(row, "finalParts")),
    )
  );
}

/** The request's entries, as v1 checks them (K-05 v1 eventEntry: the rest is the event log's and K-08's). */
function checkEvents(events: unknown): void {
  if (!Array.isArray(events)) {
    throw new TypeError(`${PARK}: events is not a list`);
  }
  events.forEach((entry: unknown) => {
    checkEventEntry(PARK, entry);
  });
}

/** v1's form, checked as before T-1542 (K-05 v1 item 12): the turn with tries 3 and at most one row with no plan. */
function checkV1Park(request: unknown): ParkChecked {
  assertRequestShape(request, PARK, V1_FIELDS);
  const raw = request as Row;
  checkTurn(PARK, raw.turn, 3);
  const parkedAt = instantOf(PARK, raw.parkedAt, "parkedAt");
  const { outboxRows, events } = raw;
  if (!Array.isArray(outboxRows) || outboxRows.length > 1) {
    throw new TypeError(`${PARK}: outboxRows is a list of at most one row (the one "nothing changed" line)`);
  }
  outboxRows.forEach((row: unknown) => {
    checkOutboxRowNew(PARK, row);
  });
  checkEvents(events);
  return { parkedAt, reason: null, line: false };
}

/** K-05 v1.23 parkReason (default 217): from, fault and ids alone, each a K-08 safe id, the ids each once. */
function reasonOf(value: unknown): ParkReason {
  if (!exactly(value, ["from", "fault", "ids"])) {
    fail("reason takes from, fault and ids alone");
  }
  if (!isLabel(value.from)) {
    fail(
      "reason.from is not a label (a K-08 safe id: letters, digits and _ . : / # -, never a number or words)",
    );
  }
  if (!isLabel(value.fault)) {
    fail(
      "reason.fault is not a label (a K-08 safe id: letters, digits and _ . : / # -, never a number or words)",
    );
  }
  const { ids } = value;
  if (!Array.isArray(ids)) {
    fail("reason.ids is not a list");
  }
  ids.forEach((id: unknown, index) => {
    if (!isLabel(id)) {
      fail(`reason.ids[${String(index)}] is not a label (a K-08 safe id, never a number or words)`);
    }
  });
  if (new Set(ids).size !== ids.length) {
    fail("reason.ids names one id more than once");
  }
  return { from: value.from, fault: value.fault, ids: ids as string[] };
}

/** K-05 v1.23 parkedLinePlan: the row's code-built plan, text alone, no lines, question, page type, thread or copy. */
function checkParkedPlan(plan: unknown, rowId: string, channel: string): void {
  const what = "outboxRows[0].plan";
  const inner = isRecord(plan) ? plan.plan : undefined;
  const form =
    exactly(plan, ["row", "channel", "copyOf", "plan"]) &&
    plan.copyOf === null &&
    exactly(inner, ["formats", "lines", "question", "pageType", "threadReplyTo"]) &&
    Array.isArray(inner.formats) &&
    inner.formats.length === 1 &&
    inner.formats[0] === "text" &&
    isEmptyList(inner.lines) &&
    inner.question === null &&
    inner.pageType === null &&
    inner.threadReplyTo === null;
  if (!form) {
    fail(`${what} is not parkedLinePlan (text alone, with no lines, question, page type, thread or copy)`);
  }
  if (plan.row !== rowId) {
    fail(`${what}.row is not the row's id`);
  }
  if (plan.channel !== channel) {
    fail(`${what}.channel is not the row's channel`);
  }
}

/** K-05 v1.23 parkedLineParts: one words send of the passedOn line alone, naming the row and its channel. */
function checkParkedParts(parts: unknown, rowId: string, channel: string): void {
  const what = "outboxRows[0].finalParts";
  const sends = isRecord(parts) ? parts.sends : undefined;
  const send: unknown = Array.isArray(sends) && sends.length === 1 ? sends[0] : undefined;
  const fixedLines = isRecord(parts) ? parts.fixedLines : undefined;
  const form =
    exactly(parts, ["row", "channel", "sends", "fixedLines", "slotValues", "threadReplyTo"]) &&
    exactly(send, ["kind", "text", "calendarFile", "options", "link"]) &&
    send.kind === "words" &&
    send.calendarFile === "none" &&
    isEmptyList(send.options) &&
    send.link === null &&
    Array.isArray(fixedLines) &&
    fixedLines.length === 1 &&
    fixedLines[0] === "passedOn" &&
    isEmptyList(parts.slotValues) &&
    parts.threadReplyTo === null;
  if (!form) {
    fail(
      `${what} is not parkedLineParts (one words send, fixedLines passedOn alone, no option, link, calendar file, ` +
        "slot value or thread)",
    );
  }
  if (send.text !== PASSED_ON_LINE) {
    fail(`${what}.sends[0].text is not K-01's passedOn line, word for word (default 216)`);
  }
  if (parts.row !== rowId) {
    fail(`${what}.row is not the row's id`);
  }
  if (parts.channel !== channel) {
    fail(`${what}.channel is not the row's channel`);
  }
}

/** K-05 v1.23 parkedRowNew (default 219): a quick reply to the turn's own handle, with the passedOn line. */
function checkParkedRow(row: unknown, handleId: string): void {
  const what = "outboxRows[0]";
  if (!exactly(row, ROW_FIELDS)) {
    fail(`${what} takes parkedRowNew's fields alone, each present (its plan and final parts among them)`);
  }
  assertId(row.id, `${PARK}: ${what}.id`);
  if (row.recipientHandleId !== handleId) {
    fail(
      `${what}.recipientHandleId is not the turn's handleId: the line goes to the turn's own handle alone`,
    );
  }
  assertNullableId(row.recipientPersonId, `${what}.recipientPersonId`);
  assertNullableId(row.businessId, `${what}.businessId`);
  if (row.bookingId !== null) {
    fail(`${what}.bookingId is not null: the line is about no booking`);
  }
  if (row.openQuestionId !== null) {
    fail(`${what}.openQuestionId is not null: the line asks no question`);
  }
  if (row.copyOfRowId !== null) {
    fail(`${what}.copyOfRowId is not null: the row is no email copy`);
  }
  if (row.sendClass !== "quick_reply") {
    fail(`${what}.sendClass is not quick_reply`);
  }
  if (!isEmptyList(row.versionsRead)) {
    fail(`${what}.versionsRead is not empty: the line is decided on no versions`);
  }
  if (typeof row.channel !== "string" || !CHANNELS.has(row.channel)) {
    fail(`${what}.channel is not one of K-05's channels`);
  }
  checkParkedPlan(row.plan, row.id, row.channel);
  checkParkedParts(row.finalParts, row.id, row.channel);
}

/** v1.23's form (item 84), checked before the database is reached; anything else throws a TypeError. */
function checkLinePark(request: Row): ParkChecked {
  assertRequestShape(request, PARK, LINE_FIELDS);
  for (const field of LINE_REQUIRED) {
    if (!Object.hasOwn(request, field)) {
      fail(`the request needs ${field}`);
    }
  }
  checkTurn(PARK, request.turn);
  const turn = request.turn as Row;
  const parkedAt = instantOf(PARK, request.parkedAt, "parkedAt");
  const reason = Object.hasOwn(request, "reason") ? reasonOf(request.reason) : null;
  if (reason === null && turn.tries !== 3) {
    fail("reason is missing before the third try: only a final refusal parks a turn then, and names it");
  }
  const rows = request.outboxRows;
  if (!Array.isArray(rows) || rows.length !== 1) {
    fail("outboxRows is not exactly one row: v1.23's park writes the passedOn line, never an unworded row");
  }
  checkParkedRow(rows[0], turn.handleId as string);
  checkEvents(request.events);
  return { parkedAt, reason, line: true };
}

/** What code checks before the database is reached, in the request's form (default 4). */
function checkPark(request: ParkTurnRequest): ParkChecked {
  return isLineForm(request) ? checkLinePark(request as unknown as Row) : checkV1Park(request);
}

/** A turn id met again: its first park, or alreadyCommitted; nothing is written. */
async function repeatOf(tx: Sql, turnId: string): Promise<ParkTurnOutcome> {
  const [turn] = await tx<{ state: string; committed_at: Date | null; parked_at: Date | null }[]>`
    select state, committed_at, parked_at from turns where id = ${turnId}
  `;
  if (turn?.state === "committed" && turn.committed_at !== null) {
    return { error: "alreadyCommitted", turnId, committedAt: utc(turn.committed_at) };
  }
  if (turn?.state !== "parked" || turn.parked_at === null) {
    throw new Error("parkTurn: the turn id is taken by a turn that is neither parked nor committed");
  }
  return {
    result: "parked",
    turnId,
    parkedAt: utc(turn.parked_at),
    outboxRows: await outboxRowsOfTurn(tx, turnId),
    repeated: true,
  };
}

/**
 * v1.23's row, just inserted planned at version 1: its plan and final parts written and moved to checked at version 2,
 * K-07's `planned -> checked` (default 221), as sign-in-send.ts does for a code's email row. No row moved throws, so the
 * whole park rolls back.
 */
async function planAndCheck(tx: Sql, row: K05v123.ParkedRowNew): Promise<void> {
  const [checked] = await tx<{ version: number }[]>`
    update outbox_rows
    set plan = ${tx.json(row.plan as unknown as Json)}, final_parts = ${tx.json(row.finalParts as unknown as Json)},
        state = 'checked', version = version + 1
    where id = ${row.id} and version = 1 and plan is null
    returning version
  `;
  if (checked?.version !== 2) {
    throw new Error("parkTurn: the line's row did not take its plan and final parts");
  }
}

/** The whole park inside the transaction `tx` (the runtime side, no scope). */
async function parkIn(tx: Sql, request: ParkTurnRequest, checked: ParkChecked): Promise<ParkTurnOutcome> {
  const { turn } = request;
  const { parkedAt } = checked;
  const inserted = await tx<{ id: string }[]>`
    insert into turns (
      id, handle_id, event_ids, state, bundle_hash, bundle_build, trace_id, joined_trace_ids, tries, parked_at
    ) values (
      ${turn.id}, ${turn.handleId}, ${turn.eventIds}, 'parked', ${turn.bundleId.hash}, ${turn.bundleId.build},
      ${turn.traceId}, ${turn.joinedTraceIds}, ${turn.tries}, ${parkedAt}
    )
    on conflict (id) do nothing
    returning id
  `;
  if (inserted.length === 0) {
    return repeatOf(tx, turn.id);
  }

  // K-37's row for the team: the next weekday at the same local time in the team's zone (default 2); its summary the
  // fixed crash text, or default 220's form of the reason's labels.
  await tx`
    insert into parked_turns (turn_id, error_summary, person_told_at, reply_due_at)
    select ${turn.id}, ${parkedErrorSummary(checked.reason, turn.tries)}, null,
           (parked.local + case extract(isodow from parked.local)
                             when 5 then interval '3 days'
                             when 6 then interval '2 days'
                             else interval '1 day'
                           end) at time zone ${TEAM_ZONE}::text
    from (select ${parkedAt}::timestamptz at time zone ${TEAM_ZONE}::text as local) as parked
  `;

  const outboxRows: K05.OutboxRowWritten[] = [];
  for (const row of request.outboxRows) {
    outboxRows.push(await insertOutboxRow(tx, turn, row));
    if (checked.line) {
      await planAndCheck(tx, row as K05v123.ParkedRowNew);
    }
  }
  const context = {
    turnId: turn.id,
    traceId: turn.traceId,
    bundle: { hash: turn.bundleId.hash, build: turn.bundleId.build },
  };
  for (const entry of request.events) {
    await appendEvent(tx, context, logEntryOf(entry, parkedAt));
  }
  return { result: "parked", turnId: turn.id, parkedAt: utc(parkedAt), outboxRows, repeated: false };
}

/**
 * Parks a turn (K-05 v1 item 12, v1.23 item 84; arch 11 line 576): after a third crash before its commit, or, in v1.23's
 * form, at once on a final refusal with its reason, the passedOn line in its one row. One transaction on the primary, on
 * the runtime side. Pass the client's primary handle, run as rosie_job. Answers parked (repeated true for a turn already
 * parked, which writes nothing), alreadyCommitted (the turn committed: it is never parked) or transient. Throws for a
 * request it cannot carry out, before any statement, and a database refusal as DataAccessDatabaseError; nothing is
 * written then either.
 */
export async function parkTurn(sql: Sql, request: ParkTurnRequest): Promise<ParkTurnOutcome> {
  const checked = checkPark(request);
  try {
    return await inRuntimeTransaction(sql, { readOnly: false }, (tx) => parkIn(tx, request, checked));
  } catch (error) {
    return transientOrScrubbed(PARK, error);
  }
}
