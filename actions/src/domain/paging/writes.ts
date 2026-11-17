// What one paging call writes (T-319), in K-05 v1.1's shapes, and the three ways it reaches the database:
//   - as a core action of a turn, in the turn's one commit (gateAndCommit's runCore: UnitWrites, whose `clocks` carries
//     the escalation and next-page clock rows and whose `clockCancels` an answer's or an acknowledgement's cancel; C-087,
//     T-1156);
//   - made alone (a page's, the console's, a job's or a clock firing's call): K-05's commit with no turn, keyed by the
//     call's key (QUESTIONS.md CQ-44), as T-317's AloneCommit takes it, with every row's event-log entry, since no turn's
//     commit adds them;
//   - through the safety service's telling port, inside a safety record's writes (T-318's FlagWrites, which cancel no
//     clock row).
// Every event-log entry names ids, kinds, flags and times only (K-08 v1 plainValue: never a number, an address or a
// person's words). A team-only kind (K-08 v1.1 teamOnlyEventKind: team_page.*, review_item.*, harm_report.filed) carries no
// business, so no business scope reads it; the business it is about goes in its new values (K-08 README "v1.1").

import type { ClockCancel, ClockNew, EventEntry, UnitWrites, Writes } from "../../commit";
import { eventEntry, type EntryActor, type FlagWrites } from "../flags";

/** What one paging call writes: T-318's FlagWrites (asks always empty) and the clock rows it cancels. */
export interface PagingWrites extends FlagWrites {
  /** Clock rows cancelled: a hand-off's escalation on its answer, a page's next page on its acknowledgement. */
  readonly clockCancels: readonly ClockCancel[];
}

/** Nothing written: a refusal or a repeat. */
export function noPagingWrites(step: string): PagingWrites {
  return {
    why: { step, choice: null },
    versionsRead: [],
    state: [],
    stateEvents: [],
    asks: [],
    messages: [],
    clocks: [],
    clockCancels: [],
  };
}

/** Two writes, one after the other: every list joined in order (the first one's why). */
export function joinPaging(a: PagingWrites, b: PagingWrites): PagingWrites {
  return {
    why: a.why,
    versionsRead: [...a.versionsRead, ...b.versionsRead],
    state: [...a.state, ...b.state],
    stateEvents: [...a.stateEvents, ...b.stateEvents],
    asks: [...a.asks, ...b.asks],
    messages: [...a.messages, ...b.messages],
    clocks: [...a.clocks, ...b.clocks],
    clockCancels: [...a.clockCancels, ...b.clockCancels],
  };
}

/** Whether a call writes nothing at all. */
export function pagingWritesNothing(writes: PagingWrites): boolean {
  return (
    writes.state.length === 0 &&
    writes.stateEvents.length === 0 &&
    writes.messages.length === 0 &&
    writes.clocks.length === 0 &&
    writes.clockCancels.length === 0
  );
}

const copy = <T>(value: T): T => structuredClone(value);

/**
 * The writes as one core action's UnitWrites, in the turn's one commit: its clock rows and cancels included (T-1156).
 * The commit names the unit's step in every entry it writes for the unit's rows, so writes with no step (a page that
 * names none: page.ts default 12) are refused rather than logged with an empty one.
 */
export function pagingUnitWritesOf(writes: PagingWrites): UnitWrites {
  if (writes.why.step === "" && !pagingWritesNothing(writes)) {
    throw new TypeError("a paging write with no step rides in no turn's commit");
  }
  return {
    why: copy(writes.why),
    versionsRead: copy([...writes.versionsRead]),
    state: copy([...writes.state]),
    stateEvents: copy([...writes.stateEvents]),
    asks: [],
    clocks: copy([...writes.clocks]),
    closes: [],
    clockCancels: copy([...writes.clockCancels]),
    messages: copy([...writes.messages]),
    reservations: { confirm: [], release: [] },
    effects: { write: [], letGo: [] },
    gives: [],
  };
}

/**
 * The writes as the safety record's telling port hands them back (T-318's TellPlan.writes): a record tells by inserts
 * alone, so a plan that cancels a clock row is refused rather than dropped.
 */
export function tellWritesOf(writes: PagingWrites): FlagWrites {
  if (writes.clockCancels.length > 0) {
    throw new TypeError("the telling port cancels no clock row");
  }
  return {
    why: copy(writes.why),
    versionsRead: copy([...writes.versionsRead]),
    state: copy([...writes.state]),
    stateEvents: copy([...writes.stateEvents]),
    asks: [],
    messages: copy([...writes.messages]),
    clocks: copy([...writes.clocks]),
  };
}

/** A clock row as this service writes it (K-05 v1 clockNew, kind job, owned by the minute sweep: no handle). */
export interface JobClock extends ClockNew {
  id: string;
  kind: "job";
  openQuestionId: null;
  reservationId: null;
  handleId: null;
  businessId: string | null;
  bookingId: string | null;
  fires: Record<string, unknown>;
  due: { dueAt: string; dueZone: string };
}

/**
 * The writes as K-05 v1.1 Writes for a call made alone, with no turn: the state and its entries, each clock row made or
 * cancelled with its entry, and each outbox row with its entry (K-04 v1.1 lets work with no turn write a row, keyed by its
 * job: K-05 v1.13 "Why"; whether K-05's commit with no turn carries it is CQ-44's, and a firing with no turn CQ-28's).
 * Entries are Rosie's acts, in the clock's or row's own business, with the call's why.
 */
export function pagingAloneWritesOf(writes: PagingWrites, zone: string | null): Writes {
  const why = writes.why;
  const entry = (input: {
    id: string;
    kind: string;
    businessId: string | null;
    table: string;
    rowId: string;
    new: Record<string, unknown>;
  }): EventEntry => eventEntry({ ...input, zone, actor: null, old: null, why });
  const clockEntries = writes.clocks.map((clock) => {
    const id = typeof clock.id === "string" ? clock.id : "";
    const due = clock.due as { dueAt?: unknown; dueZone?: unknown } | undefined;
    return entry({
      id: `log-${id}-created`,
      kind: "clock_row.created",
      businessId: typeof clock.businessId === "string" ? clock.businessId : null,
      table: "clock_rows",
      rowId: id,
      new:
        due === undefined
          ? { kind: clock.kind, state: "waiting" }
          : { kind: clock.kind, state: "armed", due_at: due.dueAt, due_zone: due.dueZone },
    });
  });
  const cancelEntries = writes.clockCancels.map((cancel) =>
    entry({
      id: `log-${cancel.id}-cancelled`,
      kind: "clock_row.cancelled",
      businessId: null,
      table: "clock_rows",
      rowId: cancel.id,
      new: { state: "cancelled" },
    }),
  );
  const rowEntries = writes.messages.map((row) =>
    entry({
      id: `log-${row.id}-created`,
      kind: "outbox_row.created",
      businessId: row.businessId,
      table: "outbox_rows",
      rowId: row.id,
      new: { state: "planned", channel: row.channel, send_class: row.sendClass },
    }),
  );
  return {
    state: copy([...writes.state]),
    openQuestions: { open: [], close: [] },
    clockRows: { make: copy([...writes.clocks]), cancel: copy([...writes.clockCancels]) },
    outboxRows: copy([...writes.messages]),
    reservations: { confirm: [], release: [] },
    events: [...copy([...writes.stateEvents]), ...cancelEntries, ...clockEntries, ...rowEntries],
  };
}

/** One state entry: the row's kind, table and id, its old and new plain values, and who acted (Rosie when null). */
export function pagingEntry(input: {
  readonly kind: string;
  readonly move: string;
  readonly table: string;
  readonly rowId: string;
  /** The entry's business: null for a team-only kind (K-08 v1.1 teamOnlyEventKind). */
  readonly businessId: string | null;
  readonly actor: EntryActor | null;
  readonly old: Record<string, unknown> | null;
  readonly new: Record<string, unknown>;
  /** The step whose write it is, or null where no step applies (K-08 v1 why: null allowed). */
  readonly step: string | null;
}): EventEntry {
  const built = eventEntry({
    id: `log-${input.rowId}-${input.move}`,
    kind: input.kind,
    zone: null,
    businessId: input.businessId,
    actor: input.actor,
    table: input.table,
    rowId: input.rowId,
    old: input.old,
    new: input.new,
    why: { step: input.step ?? "", choice: null },
  });
  return input.step === null ? { ...built, why: null } : built;
}
