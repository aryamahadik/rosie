// Where limit 4 (C-084, T-302) gets what it reads, each behind a port so the rule (versions.ts) is plain code:
//   - the open question a part answers, with the versions it was decided on (K-04 v1 open_questions.versions_read: "the
//     row references of K-02's facts, which the commit compares and sets (limit 4)") and its ask count, read through K-05
//     v1.2's openQuestionRead on the call's scoped transaction: limit 3's reader (../limit-3/facts.ts questionReaderOf);
//   - today's facts, the reload: each row the question showed at its version now (db/repo/send-state.ts
//     currentVersionsOf, the read limit 8 makes of an outbox row's versions_read), and the booking head the part acts on
//     (db/repo/bookings-head.ts getBookingHead: its stage and version), both on the same transaction.
//
// The call's transaction runs under its business (row-level security, arch 10 line 546), so a row of another business
// reads as gone. currentVersionsOf reads only the versioned homes it lists (send-state.ts VERSIONED_HOMES) and throws on
// any other table: limit 4 then throws, so the gate fails the whole call and nothing passes, until the task that migrates
// a domain part's versioned table adds it there.
//
// Every read gives tables, ids, stages and versions; a person's words are never read here, and nothing here logs.

import { getBookingHead } from "../../../../db/repo/bookings-head";
import type { Sql, Tx } from "../../../../db/repo/scope";
import { currentVersionsOf } from "../../../../db/repo/send-state";
import type { RowRef } from "../limit-3/facts";

/** A booking's stage (K-04 v1 bookings.stage). */
export type BookingStage = "entry" | "booked" | "checked_in" | "done" | "cancelled";

/** A booking head as it stands now: the stage the reload checks, and its version. */
export interface BookingNow {
  readonly id: string;
  readonly stage: BookingStage;
  readonly version: number;
}

/** Today's facts, read again at the gate (arch 06 line 305: "Reload once"). */
export interface TodayReader {
  /**
   * Each row at its version now, in the order given; a row that no longer exists, or that the call's scope does not see,
   * is left out (so limit 4 counts it gone).
   */
  currentVersions(rows: readonly RowRef[]): Promise<readonly RowRef[]>;
  /** The booking head now, or null when it no longer exists or the call's scope does not see it. */
  booking(bookingId: string): Promise<BookingNow | null>;
}

/**
 * The call's repo as the data-access calls take it: the Tool API's scoped transaction (tool-api/scope.ts, a postgres.js
 * transaction, which is a tagged-template function). Anything else is not a database: limit 4 throws, so the gate fails
 * the whole call and nothing passes.
 */
export function databaseOf(repo: unknown): Sql | Tx {
  if (typeof repo !== "function") {
    throw new TypeError("limit 4 reads through the call's database transaction");
  }
  return repo as Sql | Tx;
}

/** Today's facts over the data-access calls, on the call's own transaction under its business scope. */
export function todayReaderOf(db: Sql | Tx): TodayReader {
  return {
    currentVersions: (rows) => currentVersionsOf(db, rows),
    async booking(bookingId) {
      const head = await getBookingHead(db, bookingId);
      return head === null ? null : { id: head.id, stage: head.stage, version: head.version };
    },
  };
}
