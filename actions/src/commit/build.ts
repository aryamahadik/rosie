// The one K-05 commit request of a turn (C-087, T-305): every unit's writes (the turn's core actions, then the parts the
// gate let through, in decide's order) under the turn's id, in one commitTurn request (K-05 v1 item 1, with K-05 v1.1's
// effect rows: arch 01 line 39; arch 02 line 121; arch 10 line 508). The commit adds what it owns:
//
//   - each asked question's clock row, unarmed: kind question, no due time, so it arms at the question's first delivery
//     receipt (arch 02 line 127; K-05 v1 clockNew and armClock), id `clock-<question id>` (default 2 below);
//   - one event-log entry per row it writes, in K-08 v1's kinds and shapes (arch 09 line 457: who, what, old and new, why,
//     approved by), each with the unit's why; the state writes' entries come with them (UnitWrites.stateEvents).
//
// Before anything is sent, code checks what K-05 v1.1's schema holds and the database would refuse, so a malformed turn is
// refused whole (fail closed: CommitRefusedError): no state write to a table with its own list; outbox rows with no plan
// or final parts (words are written in after the commit: arch 01 line 41; K-07 v1); every effect row on its own
// idempotency key (arch 10 line 542; K-07 v1 refuse-effect-without-key); no id given twice.
//
// The turn row is K-05 v1's `turn` with its seven fields alone (T-1150; K-09 v1.5 default 135): a gateAndCommit request's
// turn may also carry the service and the Linq chat id of the turn's last text (K-09 v1.5 gateAndCommit.turn), which are
// the walk's inputs, never the row's. K-05 v1's turn is closed and K-04 turns has no such column, and the chat id's one
// home is K-04 threads.linq_chat_id: never the turn row, an event-log entry's values, a span or a log line.
//
// Nothing here logs, and what it throws names faults and row ids, never a value (K-08 v1 README line 75).
//
// Defaults used (for ops/QUESTIONS.md):
//   1. Every row the commit writes gets its own event-log entry (K-08 v1 event-commit.json: the answer, the booking, the
//      clock cancelled, each a row of its own), although K-05 v1's fixtures log only the state change (they predate K-08's
//      kinds).
//   2. An asked question's clock row id is `clock-<question id>` and an entry's id `log-<row id>-<move>`, as K-05 v1's
//      fixtures name them (commit-opens-question.json); both are fixed by rule, so a rerun builds the same request.
//   3. The person's own act is the person's (actor person, with their role at the turn's business): the answer to the
//      question their part chose from (K-08 v1 README "Who"); everything the commit writes because of it is Rosie's. The
//      answer approves the answered question, the reservations the part books and the effects it writes (K-08 v1
//      approvalAnswer); nothing else carries an approval.
//   4. The entries' zone is the zone the turn's texts were read in (the frontier's: K-02 v1 text.sentAt.zone; CQ-05),
//      null (UTC) for a turn with no texts. Old values the commit did not read are null; the database stamps the time.

import { CommitRefusedError } from "./errors";
import type {
  ClockNew,
  CommitTurnRequest,
  EffectKind,
  EffectNew,
  EventEntry,
  OpenQuestionNew,
  RowRef,
  TurnRow,
  UnitWrites,
  Writes,
} from "./types";

/** The roles K-04 v1 person_roles names, which an event-log entry's actor role takes (K-08 v1 `role`). */
type ActorRole = NonNullable<EventEntry["actorRole"]>;
const ACTOR_ROLES: readonly ActorRole[] = ["owner", "admin", "staff", "own_business", "customer"];

/** K-07 v1 effectKind, every one (outbox-effects.v1.schema.json; K-05 v1.1 effectNew). */
export const EFFECT_KINDS: readonly EffectKind[] = [
  "stripe_save_card",
  "stripe_charge",
  "stripe_refund",
  "stripe_pay_link",
  "stripe_dispute_evidence",
  "rosfield_monthly_charge",
  "calendar_write",
  "calendar_update",
  "calendar_delete",
  "linq_contact_add",
];

/** The tables a state write never names: the commit writes them through their own lists, or they are write-once (K-05 v1 stateTable). */
export const NOT_STATE_TABLES: readonly string[] = [
  "turns",
  "open_questions",
  "clock_rows",
  "outbox_rows",
  "outbox_parts",
  "reservations",
  "class_seats",
  "event_log",
  "bundles",
  "bundle_values",
  "sealing_keys",
];

/** The fields of K-05 v1 outboxRowNew: an outbox row at the commit carries these and nothing else (no plan, no final parts). */
const OUTBOX_ROW_FIELDS: readonly string[] = [
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
];

/** The answer a part gave to the open question its choice belongs to (K-08 v1 approvalAnswer). */
export interface Answer {
  readonly openQuestionId: string;
  /** The option picked, as sent, or null for an open-ended answer. */
  readonly optionId: string | null;
  /** The inbound text that carried it (K-06 event id). */
  readonly eventId: string;
}

/** One unit of the commit: a core action's writes or a passed part's, with the answer its part gave, if any. */
export interface CommitUnit {
  readonly writes: UnitWrites;
  readonly answer: Answer | null;
}

/** Who acts in the turn: the person the turn acts for, and their role at a business (K-02 v1 writer). */
export interface TurnActor {
  readonly personId: string | null;
  roleAt(businessId: string): string | null;
}

export interface BuildInput {
  /** The request's turn: the row is written with K-05's seven fields of it alone (k05TurnRow). */
  readonly turn: TurnRow;
  /** The zone the turn's texts were read in, or null (default 4). */
  readonly zone: string | null;
  /** The business of the call's scope: the entries' business for a row that names none of its own (a close, a cancel). */
  readonly businessId: string;
  readonly actor: TurnActor;
  /** The core actions' units first, then the parts', in decide's order. */
  readonly units: readonly CommitUnit[];
}

/** An asked question's clock row: K-05 v1 clockNew with no due time, so it is written waiting. */
export interface QuestionClock extends ClockNew {
  id: string;
  kind: "question";
  openQuestionId: string;
  reservationId: null;
  handleId: string;
  businessId: string | null;
  bookingId: string | null;
  fires: { step: string; safeDefault: string | null };
}

const copy = <T>(value: T): T => structuredClone(value);

/**
 * The turn row K-05 writes: K-05 v1 `turn`'s seven fields of the request's turn (data-access.v1.schema.json `$defs/turn`,
 * closed), and nothing else, so the service and the chat id a K-09 v1.5 request's turn may carry never reach the row
 * (K-09 v1.5 default 135). The type check holds this literal to the generated K-05 turn (every field required, no other
 * allowed); a test holds its keys to the schema itself.
 */
export function k05TurnRow(turn: TurnRow): TurnRow {
  return {
    id: turn.id,
    handleId: turn.handleId,
    eventIds: copy(turn.eventIds),
    bundleId: copy(turn.bundleId),
    traceId: turn.traceId,
    joinedTraceIds: copy(turn.joinedTraceIds),
    tries: turn.tries,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-empty string field of a loose record (K-05 v1.1 effectNew is typed loosely by the generator). */
function stringField(record: Readonly<Record<string, unknown>>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The fault-checked view of one effect row: its id, kind, key and business. */
interface EffectView {
  readonly effectId: string;
  readonly kind: EffectKind;
  readonly key: string;
  readonly businessId: string | null;
}

/** Holds one effect row to its id, its kind and its own idempotency key (K-07 v1 effectRow); refuses it otherwise. */
export function effectView(effect: EffectNew): EffectView {
  const effectId = stringField(effect, "effectId");
  const kind = EFFECT_KINDS.find((each) => each === effect.kind);
  if (effectId === null || kind === undefined) {
    throw new CommitRefusedError("effectNotWellFormed", effectId === null ? [] : [effectId]);
  }
  const key = stringField(effect, "idempotencyKey");
  if (key === null) throw new CommitRefusedError("effectWithoutKey", [effectId]);
  return { effectId, kind, key, businessId: stringField(effect, "businessId") };
}

/** Refuses the first id two entries share. */
function onceEach(ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new CommitRefusedError("idTwice", [id]);
    seen.add(id);
  }
}

/**
 * What code checks before anything is sent (fail closed: the whole turn is refused, nothing written): the state writes'
 * tables, plan-free outbox rows, every effect row on its own key, and no row id given twice in one list.
 */
export function checkUnits(units: readonly CommitUnit[]): void {
  const all = units.map((unit) => unit.writes);
  for (const write of all.flatMap((writes) => writes.state)) {
    if (NOT_STATE_TABLES.includes(write.table)) throw new CommitRefusedError("stateTable", [write.table]);
  }
  for (const row of all.flatMap((writes) => writes.messages)) {
    const fields: unknown = row;
    const extra = isRecord(fields)
      ? Object.keys(fields).filter((key) => !OUTBOX_ROW_FIELDS.includes(key))
      : [];
    if (!isRecord(fields) || extra.length > 0) throw new CommitRefusedError("outboxRowWithPlan", [row.id]);
  }
  const effects = all.flatMap((writes) => writes.effects.write).map(effectView);
  const keys = new Set<string>();
  for (const effect of effects) {
    if (keys.has(effect.key)) throw new CommitRefusedError("effectKeyTwice", [effect.effectId]);
    keys.add(effect.key);
  }
  onceEach(effects.map((effect) => effect.effectId));
  onceEach(all.flatMap((writes) => writes.asks.map((ask) => ask.question.id)));
  onceEach(all.flatMap((writes) => writes.closes.map((close) => close.id)));
  onceEach(all.flatMap((writes) => writes.messages.map((row) => row.id)));
}

/** The unarmed clock row of an asked question (default 2): it waits, and arms at the question's first delivery receipt. */
export function questionClock(question: OpenQuestionNew, safeDefault: string | null): QuestionClock {
  return {
    id: `clock-${question.id}`,
    kind: "question",
    openQuestionId: question.id,
    reservationId: null,
    handleId: question.handleId,
    businessId: question.businessId,
    bookingId: question.bookingId,
    fires: { step: question.step, safeDefault },
  };
}

/** K-08 v1 approvalAnswer, in its column's spelling (K-04 event_log.approved_by). */
function approvalOf(answer: Answer): Record<string, unknown> {
  return {
    kind: "answer",
    open_question_id: answer.openQuestionId,
    option_id: answer.optionId,
    event_id: answer.eventId,
  };
}

/** One row the commit writes, as its event-log entry names it. */
interface Logged {
  readonly table: string;
  readonly rowId: string;
  readonly move: string;
  readonly kind: string;
  readonly businessId: string | null;
  readonly old: Record<string, unknown> | null;
  readonly new: Record<string, unknown>;
  /** Whether the part's answer approves this write (default 3). */
  readonly approved: boolean;
  /** Whether it is the person's own act: the answer itself (default 3). */
  readonly ownAct: boolean;
}

/** The event-log entry of one row a unit writes (K-05 v1 eventEntry in K-08 v1's kinds and shapes). */
function entryOf(input: BuildInput, unit: CommitUnit, row: Logged): EventEntry {
  const { why } = unit.writes;
  const personId = row.ownAct ? input.actor.personId : null;
  const role = personId === null ? null : input.actor.roleAt(row.businessId ?? input.businessId);
  return {
    id: `log-${row.rowId}-${row.move}`,
    kind: row.kind,
    zone: input.zone,
    businessId: row.businessId,
    actorKind: personId === null ? "rosie" : "person",
    actorPersonId: personId,
    actorRole: ACTOR_ROLES.find((each) => each === role) ?? null,
    tableName: row.table,
    rowId: row.rowId,
    oldValues: row.old,
    newValues: row.new,
    sealed: null,
    why: why.choice === null ? { step: why.step } : { step: why.step, choice: why.choice },
    approvedBy: row.approved && unit.answer !== null ? approvalOf(unit.answer) : null,
    proofs: null,
  };
}

/** Adds each row read once: the same row at the same version is one compare-and-set (limit 4). */
function addRead(reads: RowRef[], seen: Set<string>, row: RowRef): void {
  const key = JSON.stringify([row.table, row.rowId, row.version]);
  if (seen.has(key)) return;
  seen.add(key);
  reads.push(copy(row));
}

/** Writes one unit into the request's lists, in K-05's list order, with its rows' entries in the same order. */
function writeUnit(
  input: BuildInput,
  unit: CommitUnit,
  writes: Writes,
  effects: Required<Writes>["effects"],
): void {
  const { writes: unitWrites, answer } = unit;
  const log = (row: Logged): void => {
    writes.events.push(entryOf(input, unit, row));
  };
  const fallback = input.businessId;

  for (const close of unitWrites.closes) {
    writes.openQuestions.close.push(copy(close));
    const own = answer !== null && answer.openQuestionId === close.id && close.status === "answered";
    log({
      table: "open_questions",
      rowId: close.id,
      move: close.status,
      kind: `open_question.${close.status}`,
      businessId: fallback,
      old: null,
      new: { status: close.status, answered_option_id: close.answeredOptionId },
      approved: own,
      ownAct: own,
    });
  }
  for (const cancel of unitWrites.clockCancels) {
    writes.clockRows.cancel.push(copy(cancel));
    log({
      table: "clock_rows",
      rowId: cancel.id,
      move: "cancelled",
      kind: "clock_row.cancelled",
      businessId: fallback,
      old: null,
      new: { state: "cancelled" },
      approved: false,
      ownAct: false,
    });
  }
  writes.state.push(...unitWrites.state.map(copy));
  writes.events.push(...unitWrites.stateEvents.map(copy));
  for (const ask of unitWrites.asks) {
    const { question } = ask;
    const clock = questionClock(question, ask.safeDefault);
    writes.openQuestions.open.push(copy(question));
    writes.clockRows.make.push(clock);
    log({
      table: "open_questions",
      rowId: question.id,
      move: "opened",
      kind: "open_question.opened",
      businessId: question.businessId,
      old: null,
      new: { step: question.step, status: "waiting" },
      approved: false,
      ownAct: false,
    });
    log({
      table: "clock_rows",
      rowId: clock.id,
      move: "created",
      kind: "clock_row.created",
      businessId: question.businessId,
      old: null,
      new: { kind: "question", state: "waiting", open_question_id: question.id },
      approved: false,
      ownAct: false,
    });
  }
  for (const row of unitWrites.messages) {
    writes.outboxRows.push(copy(row));
    log({
      table: "outbox_rows",
      rowId: row.id,
      move: "created",
      kind: "outbox_row.created",
      businessId: row.businessId,
      old: null,
      new: { state: "planned", channel: row.channel, send_class: row.sendClass },
      approved: false,
      ownAct: false,
    });
  }
  for (const confirm of unitWrites.reservations.confirm) {
    writes.reservations.confirm.push(copy(confirm));
    log({
      table: "reservations",
      rowId: confirm.id,
      move: "booked",
      kind: "reservation.booked",
      businessId: fallback,
      old: { state: "held" },
      new: { state: "booked", booking_id: confirm.bookingId },
      approved: true,
      ownAct: false,
    });
  }
  for (const release of unitWrites.reservations.release) {
    writes.reservations.release.push(copy(release));
    log({
      table: "reservations",
      rowId: release.id,
      move: "released",
      kind: "reservation.released",
      businessId: fallback,
      old: null,
      new: { state: "released", released_why: release.why },
      approved: false,
      ownAct: false,
    });
  }
  for (const effect of unitWrites.effects.write) {
    const view = effectView(effect);
    effects.write.push(copy(effect));
    log({
      table: "effects",
      rowId: view.effectId,
      move: "created",
      kind: "effect.created",
      businessId: view.businessId,
      old: null,
      new: { kind: view.kind, state: "pending" },
      approved: true,
      ownAct: false,
    });
  }
  for (const letGo of unitWrites.effects.letGo) {
    effects.letGo.push(copy(letGo));
    log({
      table: "effects",
      rowId: letGo.effectId,
      move: "let-go",
      kind: "effect.result",
      businessId: fallback,
      old: { state: "outage" },
      new: { state: "cancelled" },
      approved: false,
      ownAct: false,
    });
  }
}

/**
 * The turn's one K-05 commitTurn request: the turn row (K-05's seven fields of the request's turn: k05TurnRow), every row
 * read, and every unit's writes in order with the rows the commit owns and the event-log entries. Checks the units first
 * (checkUnits): a fault refuses the whole turn.
 */
export function buildCommitRequest(input: BuildInput): CommitTurnRequest {
  checkUnits(input.units);
  const writes: Writes = {
    state: [],
    openQuestions: { open: [], close: [] },
    clockRows: { make: [], cancel: [] },
    outboxRows: [],
    reservations: { confirm: [], release: [] },
    events: [],
  };
  const effects: Required<Writes>["effects"] = { write: [], letGo: [] };
  const versionsRead: RowRef[] = [];
  const seenReads = new Set<string>();

  for (const unit of input.units) {
    for (const row of unit.writes.versionsRead) addRead(versionsRead, seenReads, row);
    writeUnit(input, unit, writes, effects);
  }

  onceEach(writes.events.map((entry) => entry.id));
  if (effects.write.length > 0 || effects.letGo.length > 0) writes.effects = effects;
  return { turn: k05TurnRow(input.turn), versionsRead, writes };
}
