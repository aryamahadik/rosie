// The batch window of the handle actor (T-247; C-048; arch 02 step 2, line 113). Texts that arrive close together become one
// batch, which closes at whichever comes first of:
//
//   - 3 s after the latest text ("quiet"),
//   - the third text ("third"; at once),
//   - 6 s after the first text ("max"),
//   - a danger outcome of one of its texts ("danger"; arch 02 step S: the actor hands the safety line on first, and the
//     batch is not kept waiting).
//
// A closed batch is final: a later text opens the next one. A closed batch goes to the turn lease (T-248) only when no
// safety work holds routine work (`held()`: a text still unread, or a hold not released; arch 02 step S, arch 06 lines
// 317 to 327), and in order: a held batch keeps the later ones behind it.
//
// The Durable Object has one alarm. What is due is kept in a small stored schedule (`batch_schedule`: one row per kind of
// entry; the resume of a cut-off safety read, T-1088, adds its own kind), the alarm is set to the earliest row, and each
// entry's handler is idempotent: a restart inside the window still closes the batch from stored state.
//
// Not here: the lease and its restart rule (T-248). The seam is `BatchHooks.toLease`: it is handed each closed, released
// batch once, in order; a hook that throws is tried again later with the same batch id, so the lease must take a batch id
// it has seen as already handed. Never logged or put in a span: a text's words (K-08 README line 75). Nothing here logs.

import { readInbox, type InboxEntry } from "./inbox";

/** 3 s after the latest text. */
export const QUIET_MS = 3000;
/** 6 s after the first text of the batch. */
export const MAX_MS = 6000;
/** The third text closes the batch. */
export const MAX_TEXTS = 3;
/** While a closed batch waits for a hold, or the lease refused it, how often it is looked at again. */
export const RELEASE_RETRY_MS = 1000;

export type CloseReason = "quiet" | "third" | "max" | "danger";

/** What the turn lease is handed: the texts of one batch in arrival order, with how and when it closed. */
export interface ClosedBatch {
  /** Rises by one per batch and is never reused: the lease's key for "already handed". */
  batchId: number;
  reason: CloseReason;
  /** Clock milliseconds of the first and the latest text, and of the close. */
  firstAt: number;
  lastAt: number;
  closedAt: number;
  entries: InboxEntry[];
}

export interface BatchClock {
  now(): number;
}

/** Joined at D-017 (the lease, T-248); a test sets a fake clock. Unwired, a closed batch stays stored and nothing is handed on. */
export interface BatchHooks {
  clock: BatchClock;
  toLease?: (batch: ClosedBatch) => void | Promise<void>;
}

const realClock: BatchClock = { now: () => Date.now() };
let hooks: BatchHooks = { clock: realClock };

/** Sets the batch's clock and lease hand-off for this Worker isolate; returns the function that puts the earlier ones back. */
export function setBatchHooks(next: BatchHooks): () => void {
  const before = hooks;
  hooks = next;
  return () => {
    hooks = before;
  };
}

/** One stored batch as a reader sees it. */
export interface BatchEntry {
  batchId: number;
  reason: CloseReason | null;
  /** True once the lease was handed it. */
  handed: boolean;
  eventIds: string[];
}

/** The schedule's kinds. */
export const SCHEDULE_BATCH_CLOSE = "batchClose";
export const SCHEDULE_RELEASE = "batchRelease";

export interface BatchHost {
  storage: DurableObjectStorage;
  /** True while routine work must wait (the safety hold). */
  held(): boolean;
  /** True when this text found danger. */
  isDanger(eventId: string): boolean;
}

interface ItemRow extends Record<string, SqlStorageValue> {
  seq: number;
  event_id: string;
  at_ms: number;
}

interface BatchRow extends Record<string, SqlStorageValue> {
  batch_id: number;
  reason: string;
  first_ms: number;
  last_ms: number;
  closed_ms: number;
  handed: number;
}

export function createBatchTables(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS batch_items (
       seq INTEGER PRIMARY KEY,
       event_id TEXT NOT NULL,
       at_ms INTEGER NOT NULL,
       batch_id INTEGER
     )`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS batches (
       batch_id INTEGER PRIMARY KEY AUTOINCREMENT,
       reason TEXT NOT NULL,
       first_ms INTEGER NOT NULL,
       last_ms INTEGER NOT NULL,
       closed_ms INTEGER NOT NULL,
       handed INTEGER NOT NULL DEFAULT 0
     )`,
  );
  sql.exec("CREATE TABLE IF NOT EXISTS batch_schedule (kind TEXT PRIMARY KEY, due_ms INTEGER NOT NULL)");
}

export class BatchWindow {
  /** One hand-off at a time, so an alarm and a safety result cannot hand the same batch twice. */
  private releasing: Promise<void> = Promise.resolve();

  constructor(private readonly host: BatchHost) {
    createBatchTables(host.storage.sql);
  }

  private get sql(): SqlStorage {
    return this.host.storage.sql;
  }

  // ---- the window ------------------------------------------------------------------------------------------------

  /** Adds a stored text to the open batch, in one synchronous step: closes it at the third text, else sets the close time. */
  add(seq: number, eventId: string): void {
    const now = hooks.clock.now();
    this.sql.exec(
      "INSERT OR IGNORE INTO batch_items (seq, event_id, at_ms, batch_id) VALUES (?, ?, ?, NULL)",
      seq,
      eventId,
      now,
    );
    const open = this.openItems();
    if (open.length >= MAX_TEXTS) {
      this.close("third");
      return;
    }
    this.scheduleAt(SCHEDULE_BATCH_CLOSE, this.deadlineOf(open));
  }

  /** The close time of an open batch: 3 s after the latest text, but never later than 6 s after the first. */
  private deadlineOf(open: ItemRow[]): number {
    const first = open[0]?.at_ms ?? 0;
    const last = open[open.length - 1]?.at_ms ?? 0;
    return Math.min(last + QUIET_MS, first + MAX_MS);
  }

  private openItems(): ItemRow[] {
    return this.sql
      .exec<ItemRow>("SELECT seq, event_id, at_ms FROM batch_items WHERE batch_id IS NULL ORDER BY seq")
      .toArray();
  }

  /** Closes the open batch, if there is one. Idempotent. */
  private close(reason: CloseReason): number | null {
    const open = this.openItems();
    if (open.length === 0) {
      this.sql.exec("DELETE FROM batch_schedule WHERE kind = ?", SCHEDULE_BATCH_CLOSE);
      return null;
    }
    return this.host.storage.transactionSync(() => {
      const cursor = this.sql.exec<{ batch_id: number }>(
        "INSERT INTO batches (reason, first_ms, last_ms, closed_ms) VALUES (?, ?, ?, ?) RETURNING batch_id",
        reason,
        open[0]?.at_ms ?? 0,
        open[open.length - 1]?.at_ms ?? 0,
        hooks.clock.now(),
      );
      const batchId = cursor.one().batch_id;
      this.sql.exec("UPDATE batch_items SET batch_id = ? WHERE batch_id IS NULL", batchId);
      this.sql.exec("DELETE FROM batch_schedule WHERE kind = ?", SCHEDULE_BATCH_CLOSE);
      // The closed batch is looked at for the lease at once, by the alarm if nothing else gets there first.
      this.scheduleAt(SCHEDULE_RELEASE, hooks.clock.now());
      return batchId;
    });
  }

  /** Danger in a text of the open batch closes the batch at once (it still waits for the hold before the lease). */
  afterSafety(eventId: string): void {
    if (!this.host.isDanger(eventId)) return;
    if (this.openItems().some((item) => item.event_id === eventId)) this.close("danger");
  }

  // ---- the schedule and the alarm --------------------------------------------------------------------------------

  private scheduleAt(kind: string, dueMs: number): void {
    this.sql.exec("INSERT OR REPLACE INTO batch_schedule (kind, due_ms) VALUES (?, ?)", kind, dueMs);
  }

  /** Sets the one alarm to the earliest stored entry, or clears it when nothing is due. */
  async arm(): Promise<void> {
    const row = this.sql
      .exec<{ due_ms: number }>("SELECT MIN(due_ms) AS due_ms FROM batch_schedule")
      .toArray()[0];
    const due = row?.due_ms ?? null;
    if (due === null) {
      await this.host.storage.deleteAlarm();
      return;
    }
    await this.host.storage.setAlarm(Date.now() + Math.max(0, due - hooks.clock.now()));
  }

  /** The alarm: runs each due entry's handler (each one idempotent), hands on what is ready, and sets the alarm again. */
  async onAlarm(): Promise<void> {
    const now = hooks.clock.now();
    const due = this.sql
      .exec<{ kind: string }>("SELECT kind FROM batch_schedule WHERE due_ms <= ?", now)
      .toArray()
      .map((row) => row.kind);
    if (due.includes(SCHEDULE_BATCH_CLOSE)) this.closeIfDue(now);
    if (due.includes(SCHEDULE_RELEASE))
      this.sql.exec("DELETE FROM batch_schedule WHERE kind = ?", SCHEDULE_RELEASE);
    await this.release();
    await this.arm();
  }

  /** The close entry's handler: closes only when the stored times say it is due, else sets the time again. */
  private closeIfDue(now: number): void {
    const open = this.openItems();
    if (open.length === 0) {
      this.sql.exec("DELETE FROM batch_schedule WHERE kind = ?", SCHEDULE_BATCH_CLOSE);
      return;
    }
    const deadline = this.deadlineOf(open);
    if (now < deadline) {
      this.scheduleAt(SCHEDULE_BATCH_CLOSE, deadline);
      return;
    }
    const first = open[0]?.at_ms ?? 0;
    const last = open[open.length - 1]?.at_ms ?? 0;
    this.close(last + QUIET_MS <= first + MAX_MS ? "quiet" : "max");
  }

  // ---- the hand-off to the lease ---------------------------------------------------------------------------------

  /** Hands each closed batch to the lease, in order, once no safety work holds routine work. */
  release(): Promise<void> {
    const run = this.releasing.then(() => this.releaseNow());
    this.releasing = run.catch(() => undefined);
    return run;
  }

  private async releaseNow(): Promise<void> {
    const toLease = hooks.toLease;
    for (;;) {
      const next = this.sql
        .exec<BatchRow>(
          "SELECT batch_id, reason, first_ms, last_ms, closed_ms, handed FROM batches WHERE handed = 0 ORDER BY batch_id LIMIT 1",
        )
        .toArray()[0];
      if (next === undefined) {
        this.sql.exec("DELETE FROM batch_schedule WHERE kind = ?", SCHEDULE_RELEASE);
        return;
      }
      // Unwired: nothing is handed on and nothing polls; the batch stays stored.
      if (toLease === undefined) return;
      if (this.host.held()) {
        this.scheduleAt(SCHEDULE_RELEASE, hooks.clock.now() + RELEASE_RETRY_MS);
        return;
      }
      const eventSeqs = this.sql
        .exec<{ seq: number }>("SELECT seq FROM batch_items WHERE batch_id = ? ORDER BY seq", next.batch_id)
        .toArray()
        .map((row) => row.seq);
      const entries = readInbox(this.sql).filter((entry) => eventSeqs.includes(entry.seq));
      try {
        await toLease({
          batchId: next.batch_id,
          reason: next.reason as CloseReason,
          firstAt: next.first_ms,
          lastAt: next.last_ms,
          closedAt: next.closed_ms,
          entries,
        });
      } catch {
        this.scheduleAt(SCHEDULE_RELEASE, hooks.clock.now() + RELEASE_RETRY_MS);
        return;
      }
      this.sql.exec("UPDATE batches SET handed = 1 WHERE batch_id = ?", next.batch_id);
    }
  }

  /** Every stored batch, in order, with the texts of the open one last (batch id 0, reason null). */
  read(): BatchEntry[] {
    const items = this.sql
      .exec<{ event_id: string; batch_id: number | null }>(
        "SELECT event_id, batch_id FROM batch_items ORDER BY seq",
      )
      .toArray();
    const closed = this.sql
      .exec<BatchRow>(
        "SELECT batch_id, reason, first_ms, last_ms, closed_ms, handed FROM batches ORDER BY batch_id",
      )
      .toArray()
      .map((row): BatchEntry => ({
        batchId: row.batch_id,
        reason: row.reason as CloseReason,
        handed: row.handed === 1,
        eventIds: items.filter((item) => item.batch_id === row.batch_id).map((item) => item.event_id),
      }));
    const open = items.filter((item) => item.batch_id === null).map((item) => item.event_id);
    return open.length > 0
      ? [...closed, { batchId: 0, reason: null, handed: false, eventIds: open }]
      : closed;
  }
}
