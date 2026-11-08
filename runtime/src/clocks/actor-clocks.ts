// The handle actor's clock rows (T-254; C-054; arch 10 line 540: "each actor keeps one alarm at its earliest row").
//
// A Durable Object has one alarm. The safety read's schedule (T-1088), the batch window (T-247) and the turn lease
// (T-248) already share it through the stored schedule of ../actor/batch.ts (`batch_schedule`: one entry per kind, the
// alarm at the earliest entry). The clocks add their own kind, `clockRow`, due at the handle's earliest armed clock row
// (K-05 v1 dueClocks' `nextDueAt`, rounded up to the whole second K-05 writes), so the one alarm also wakes the actor for
// its clock rows; the alarm's clock part runs only when that entry is due, and leaves the other kinds as they are.
//
// When it runs, the actor reads its handle's due rows (K-05 v1 dueClocks for: handle), fires each through the one fire
// path (./fire.ts, by alarm), reads again, and keeps the entry at what is left: at once when more rows are due, in 60 s
// when a row is still due after its firing (the call failed or its version moved), at the next armed row, or none. The
// minute sweep hands the actor a row it missed and staging's Fire now a row to fire early (`fireRow`): the same fire
// path, behind the same in-flight guard, so the alarm, the sweep and Fire now firing one row at once make one call.
//
// The actor names its handle by K-04 handles.id the first time the arming (T-255) or the sweep names it, and refuses a
// row of another handle afterwards: a clock turn reads this actor's holds, so it must be this handle's. Unwired (no
// clock ports), no entry is kept, so no alarm keeps coming back for rows it cannot fire. Never logged: a row's `fires`.

import { createScheduleTable, scheduleEntry, unscheduleEntry } from "../actor/batch";
import { isLabel } from "../trace";
import {
  clockDeps,
  dueReadOf,
  fireOnce,
  InFlight,
  isDueClock,
  utcOf,
  type DueRead,
  type FireHost,
} from "./fire";
import type { ClockDeps, DueClock, FireBy, FireReport } from "./types";

/** The clock rows' kind in the actor's stored schedule. */
export const SCHEDULE_CLOCK = "clockRow";
/** How many due rows one read takes (due-for-handle.json's limit). */
export const HANDLE_LIMIT = 10;
/** When a due row that could not be fired is looked at again: one sweep's period. */
export const CLOCK_RETRY_MS = 60_000;

export interface ActorClocksHost extends FireHost {
  storage: DurableObjectStorage;
  /** Sets the actor's one alarm to the earliest entry of the stored schedule (the batch window's `arm`). */
  arm(): Promise<void>;
}

interface HandleRow extends Record<string, SqlStorageValue> {
  handle_id: string;
}

/** The first whole second at or after `ms`: K-05 reads `now` to the second, so an alarm set there finds the row due. */
const wholeSecondFrom = (ms: number): number => Math.ceil(ms / 1000) * 1000;

export class ActorClocks {
  private readonly inFlight = new InFlight();

  constructor(private readonly host: ActorClocksHost) {
    createScheduleTable(host.storage.sql);
    // The handle this actor's clock rows belong to (K-04 handles.id): one row at most.
    host.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS clock_handle (one INTEGER PRIMARY KEY CHECK (one = 1), handle_id TEXT NOT NULL)",
    );
  }

  private get sql(): SqlStorage {
    return this.host.storage.sql;
  }

  /** The handle's K-04 id, once the arming or the sweep has named it. */
  handleId(): string | null {
    return (
      this.sql.exec<HandleRow>("SELECT handle_id FROM clock_handle WHERE one = 1").toArray()[0]?.handle_id ??
      null
    );
  }

  /** The clock entry's due time on the actor's clock, or null when none is stored. */
  dueAt(): number | null {
    const row = this.sql
      .exec<{ due_ms: number }>("SELECT due_ms FROM batch_schedule WHERE kind = ?", SCHEDULE_CLOCK)
      .toArray()[0];
    return row?.due_ms ?? null;
  }

  /** Names the actor's handle the first time; false when the actor already names another (one actor, one handle). */
  private own(handleId: string): boolean {
    this.sql.exec("INSERT OR IGNORE INTO clock_handle (one, handle_id) VALUES (1, ?)", handleId);
    return this.handleId() === handleId;
  }

  /**
   * The arming's call (T-255), once it arms a row of this handle: fires the handle's due rows, then keeps the clock entry
   * at its earliest armed row. A handle id that is not a label, or not this actor's, is refused: nothing is read.
   */
  async sync(handleId: string): Promise<FireReport[]> {
    if (!isLabel(handleId) || !this.own(handleId)) return [];
    return this.pass(handleId);
  }

  /** The alarm's clock part: runs only when the clock entry is due. Never throws: a failure looks again in 60 s. */
  async onAlarm(): Promise<void> {
    try {
      const due = this.dueAt();
      if (due === null || due > this.host.now()) return;
      const handleId = this.handleId();
      if (handleId === null) {
        unscheduleEntry(this.sql, SCHEDULE_CLOCK);
        await this.host.arm();
        return;
      }
      await this.pass(handleId);
    } catch {
      await this.retryLater();
    }
  }

  /**
   * One row of this handle, handed by the minute sweep (a row the alarm missed) or staging's Fire now: the alarm's own
   * fire path. Then the clock entry is kept at what is left of the handle's rows.
   */
  async fireRow(row: DueClock, by: FireBy): Promise<FireReport> {
    const refused = (errorCode: string): FireReport => ({
      clockRowId: isDueClock(row) ? row.clockRowId : "",
      by,
      outcome: "refused",
      repeated: false,
      turnId: null,
      traceId: null,
      errorCode,
    });
    if (by !== "sweep" && by !== "fireNow") return refused("badBy");
    if (!isDueClock(row) || row.handleId === null) return refused("badRow");
    if (!this.own(row.handleId)) return refused("wrongHandle");
    const report = await this.fire(row, by);
    try {
      const set = clockDeps();
      const read = set === null ? null : await this.readDue(set, row.handleId);
      this.scheduleFrom(read, new Set([row.clockRowId]), set === null);
      await this.host.arm();
    } catch {
      await this.retryLater();
    }
    return report;
  }

  /** Fires every due row of the handle by the alarm, then keeps the clock entry at what is left. */
  private async pass(handleId: string): Promise<FireReport[]> {
    const set = clockDeps();
    if (set === null) {
      this.scheduleFrom(null, new Set(), true);
      await this.host.arm();
      return [];
    }
    const first = await this.readDue(set, handleId);
    const reports: FireReport[] = [];
    for (const row of first?.rows ?? []) reports.push(await this.fire(row, "alarm"));
    const after = first === null || first.rows.length === 0 ? first : await this.readDue(set, handleId);
    this.scheduleFrom(after, new Set(reports.map((report) => report.clockRowId)), false);
    await this.host.arm();
    return reports;
  }

  /** K-05 v1 dueClocks for this handle, checked; only this handle's rows are kept. Null when it gave no due answer. */
  private async readDue(set: ClockDeps, handleId: string): Promise<DueRead | null> {
    let answer: unknown;
    try {
      answer = await set.data.dueClocks({
        for: "handle",
        handleId,
        now: utcOf(this.host.now()),
        limit: HANDLE_LIMIT,
      });
    } catch {
      return null;
    }
    const read = dueReadOf(answer);
    if (read === null) return null;
    return { ...read, rows: read.rows.filter((row) => row.handleId === handleId) };
  }

  /**
   * Keeps the clock entry in step with the handle's rows: none when unwired; in 60 s when the read failed or a row is
   * still due after its firing; at once when a due row has not been fired in this pass; else at the next armed row.
   */
  private scheduleFrom(read: DueRead | null, attempted: ReadonlySet<string>, unwired: boolean): void {
    if (unwired) {
      unscheduleEntry(this.sql, SCHEDULE_CLOCK);
      return;
    }
    const now = this.host.now();
    if (read === null) {
      scheduleEntry(this.sql, SCHEDULE_CLOCK, now + CLOCK_RETRY_MS);
      return;
    }
    if (read.rows.some((row) => !attempted.has(row.clockRowId))) {
      scheduleEntry(this.sql, SCHEDULE_CLOCK, now);
      return;
    }
    if (read.rows.length > 0) {
      scheduleEntry(this.sql, SCHEDULE_CLOCK, now + CLOCK_RETRY_MS);
      return;
    }
    if (read.nextDueAt === null) unscheduleEntry(this.sql, SCHEDULE_CLOCK);
    else scheduleEntry(this.sql, SCHEDULE_CLOCK, wholeSecondFrom(read.nextDueAt));
  }

  /** The one fire path, behind this actor's in-flight guard. */
  private fire(row: DueClock, by: FireBy): Promise<FireReport> {
    return this.inFlight.run(row.clockRowId, () => fireOnce(row, by, this.host));
  }

  /** After a throw (the storage or the schedule failed): the clock entry is looked at again in 60 s. */
  private async retryLater(): Promise<void> {
    try {
      scheduleEntry(this.sql, SCHEDULE_CLOCK, this.host.now() + CLOCK_RETRY_MS);
      await this.host.arm();
    } catch {
      // The storage itself failed: the platform runs the alarm again.
    }
  }
}
