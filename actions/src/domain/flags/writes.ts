// What one flags call writes (T-317), in K-05 v1.1's shapes, and the two ways it reaches the database:
//   - as a core action of a turn, in the turn's one commit (gateAndCommit's runCore: UnitWrites; C-087, T-305);
//   - made alone, with no turn (the handle actor writing on return, a page's STOP for the caller's own number, the owner
//     portal's pause): K-05's commit with no turn, keyed by the call's key (QUESTIONS.md CQ-44; K-05 open gap 16), whose
//     writes carry every row's event-log entry, since no turn's commit adds them.
// Every event-log entry names ids, kinds, flags and times only (K-08 v1 plainValue: never a number, an address or a
// person's words), so a consent row's words and a pause's phone number never reach the log.

import type {
  Ask,
  ClockNew,
  EventEntry,
  OutboxRowNew,
  RowRef,
  StateWrite,
  UnitWrites,
  Why,
  Writes,
} from "../../commit";

/** What one flags call writes. Every list is present, empty when it has none. */
export interface FlagWrites {
  readonly why: Why;
  /** Every row the call's decision rests on, at the version read (limit 4: arch 06 line 305). */
  readonly versionsRead: readonly RowRef[];
  readonly state: readonly StateWrite[];
  /** One event-log entry per state write (K-08 v1 kinds: consent.*, phone.*, booking.flagged, pause.*). */
  readonly stateEvents: readonly EventEntry[];
  /** A work phone's "which texts?" question, whose clock the commit adds (build.ts questionClock). */
  readonly asks: readonly Ask[];
  /** Outbox rows: only a turn's commit writes them (K-04 outbox_rows.turn_id is not null). */
  readonly messages: readonly OutboxRowNew[];
  /** Clock rows armed and due at the commit that no question owns: a pause's call-off clocks (S11-62). */
  readonly clocks: readonly ClockNew[];
}

/** Nothing written: a refusal or a repeat. */
export function noWrites(step: string): FlagWrites {
  return {
    why: { step, choice: null },
    versionsRead: [],
    state: [],
    stateEvents: [],
    asks: [],
    messages: [],
    clocks: [],
  };
}

/** Whether a call writes nothing at all. */
export function writesNothing(writes: FlagWrites): boolean {
  return (
    writes.state.length === 0 &&
    writes.stateEvents.length === 0 &&
    writes.asks.length === 0 &&
    writes.messages.length === 0 &&
    writes.clocks.length === 0
  );
}

const copy = <T>(value: T): T => structuredClone(value);

/**
 * The writes as one core action's UnitWrites, in the turn's commit (T-305's runCore). UnitWrites has no list for a clock
 * row no question owns, so a call that arms one cannot ride in a turn's commit yet: refused here rather than left out
 * (new task: UnitWrites gains the core actions' own clock rows, for S11-62's call-off clocks).
 */
export function unitWritesOf(writes: FlagWrites): UnitWrites {
  if (writes.clocks.length > 0) {
    throw new TypeError("a core action's own clock rows have no list in the turn's commit yet");
  }
  return {
    why: copy(writes.why),
    versionsRead: copy([...writes.versionsRead]),
    state: copy([...writes.state]),
    stateEvents: copy([...writes.stateEvents]),
    asks: copy([...writes.asks]),
    closes: [],
    clockCancels: [],
    messages: copy([...writes.messages]),
    reservations: { confirm: [], release: [] },
    effects: { write: [], letGo: [] },
    gives: [],
  };
}

/** A clock row as K-05 v1 clockNew writes it, with its fields typed (the generator types clockNew loosely). */
export interface DueClock extends ClockNew {
  id: string;
  kind: "step";
  openQuestionId: null;
  reservationId: null;
  handleId: string | null;
  businessId: string;
  bookingId: string;
  fires: Record<string, unknown>;
  due: { dueAt: string; dueZone: string };
}

/**
 * The writes as K-05 v1.1 Writes for a call made alone, with no turn: state and its entries, and each clock row with its
 * own entry. A call with no turn writes no outbox row and asks no question (K-04 outbox_rows.turn_id is not null), so a
 * plan that holds one is refused rather than sent.
 */
export function aloneWritesOf(writes: FlagWrites, zone: string | null): Writes {
  if (writes.messages.length > 0 || writes.asks.length > 0) {
    throw new TypeError("a call made alone writes no outbox row and asks no question");
  }
  const clockEntries = writes.clocks.map((clock): EventEntry => {
    const id = typeof clock.id === "string" ? clock.id : "";
    const businessId = typeof clock.businessId === "string" ? clock.businessId : null;
    return eventEntry({
      id: `log-${id}-created`,
      kind: "clock_row.created",
      zone,
      businessId,
      actor: null,
      table: "clock_rows",
      rowId: id,
      old: null,
      new: { kind: clock.kind, state: "armed" },
      why: writes.why,
    });
  });
  return {
    state: copy([...writes.state]),
    openQuestions: { open: [], close: [] },
    clockRows: { make: copy([...writes.clocks]), cancel: [] },
    outboxRows: [],
    reservations: { confirm: [], release: [] },
    events: [...copy([...writes.stateEvents]), ...clockEntries],
  };
}

/** Who acts in an entry: the person whose own act it is, with their role at the business, or Rosie (null). */
export interface EntryActor {
  readonly personId: string;
  readonly role: EventEntry["actorRole"];
}

export interface EntryInput {
  readonly id: string;
  readonly kind: string;
  readonly zone: string | null;
  readonly businessId: string | null;
  readonly actor: EntryActor | null;
  readonly table: string;
  readonly rowId: string;
  readonly old: Record<string, unknown> | null;
  readonly new: Record<string, unknown>;
  readonly why: Why;
}

/** One event-log entry in K-05 v1 eventEntry's shape and K-08 v1's kinds (arch 09 line 457: who, what, old and new, why). */
export function eventEntry(input: EntryInput): EventEntry {
  return {
    id: input.id,
    kind: input.kind,
    zone: input.zone,
    businessId: input.businessId,
    actorKind: input.actor === null ? "rosie" : "person",
    actorPersonId: input.actor?.personId ?? null,
    actorRole: input.actor?.role ?? null,
    tableName: input.table,
    rowId: input.rowId,
    oldValues: input.old,
    newValues: input.new,
    sealed: null,
    why:
      input.why.choice === null
        ? { step: input.why.step }
        : { step: input.why.step, choice: input.why.choice },
    approvedBy: null,
    proofs: null,
  };
}
