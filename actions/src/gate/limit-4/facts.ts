// Where limit 4 (C-084, T-302) gets what it reads, each behind a port so the rule (versions.ts) is plain code:
//   - the open question a part answers, with the versions it was decided on (K-04 v1 open_questions.versions_read: "the
//     row references of K-02's facts, which the commit compares and sets (limit 4)"), its ask count and the turn that
//     wrote its row (open_questions.turn_id), read through K-05 v1.2's openQuestionRead on the call's scoped transaction:
//     the read limit 3's reader makes (db/repo/targets.ts liveOpenQuestionsOfHandle), mapped as limit 3 maps it
//     (../limit-3/facts.ts askedQuestionOf), keeping the row's turn, which that read already answers (T-1448);
//   - today's facts, the reload: each row the question showed at its version now (db/repo/send-state.ts
//     currentVersionsOf, the read limit 8 makes of an outbox row's versions_read), within the question row's bound
//     (below), and the booking head the part acts on (db/repo/bookings-head.ts getBookingHead: its stage and version),
//     both on the same transaction.
//
// The call's transaction runs under its business (row-level security, arch 10 line 546), so a row of another business
// reads as gone. currentVersionsOf reads the core homes it lists (send-state.ts VERSIONED_HOMES) as they stand and, within
// the bound limit 4 hands it, the setup homes (setup/fact-homes.ts SETUP_FACT_HOMES), each row by its name: a two-column
// key by K-05 v1.18 item 77's name, which the SQL builds from the row's own columns and compares whole. It throws on any
// other table: limit 4 then throws, so the gate fails the whole call and nothing passes, until the task that migrates a
// domain part's versioned table adds it there.
//
// The bound (T-1448; T-1436's open question 3 and its security reviewer's note b; DL-938): the stored question row's own
// business and the turn that wrote it, whose handle's people a person's row must be of, as sendState binds an outbox
// row's (send-state.ts default 1); never a request's words. The rules are setup/fact-homes.ts rowBound's, the one function
// readTurnState and sendState also call (T-667 round 2, items 8a and 8b). A setup row outside the bound is left out, so
// limit 4 counts it gone, failing closed.
//
// As rosie_app (the Tool API's role, the gate's call transaction) PostgreSQL refuses three reads here (42501), so limit 4
// throws and the gate fails the whole call (fail closed; QUESTIONS.md, from T-1448): a row whose rule reads the people
// (K-22 accounts, sessions and proof_codes; K-27 calendar_links), since those people come from turns and person_handles,
// which 0012 grants rosie_job alone (pg/reload.int.test.ts); a K-22 accounts row besides, which 0020 grants rosie_job
// alone; and, before any reload, the question read itself, whose went-out join reads outbox_parts, which 0012 grants
// rosie_job alone too. On rosie_job, under a business's scope or none, all three are read.
//
// Every read gives tables, ids, stages and versions; a person's words are never read here, and nothing here logs.

import { getBookingHead } from "../../../../db/repo/bookings-head";
import type { Sql, Tx } from "../../../../db/repo/scope";
import { currentVersionsOf, type SetupBound } from "../../../../db/repo/send-state";
import { liveOpenQuestionsOfHandle } from "../../../../db/repo/targets";
import { askedQuestionOf, type AskedQuestion, type RowRef } from "../limit-3/facts";

export type { SetupBound };

/** A booking's stage (K-04 v1 bookings.stage). */
export type BookingStage = "entry" | "booked" | "checked_in" | "done" | "cancelled";

/** A booking head as it stands now: the stage the reload checks, and its version. */
export interface BookingNow {
  readonly id: string;
  readonly stage: BookingStage;
  readonly version: number;
}

/**
 * The open question a part answers as K-04 stores it (open_questions), as limit 4 reads it: limit 3's AskedQuestion, with
 * the turn that wrote the row (T-1448).
 */
export interface StoredQuestion extends AskedQuestion {
  /** open_questions.turn_id: the turn that wrote the row, whose handle's people bound a person's setup row it names. */
  readonly turnId: string;
}

/** The open questions' read limit 4 makes, on the call's transaction. */
export interface StoredQuestionReader {
  /** The open question `openQuestionId` when it is live (waiting or open) and was sent to `handleId`; else null. */
  liveQuestion(handleId: string, openQuestionId: string): Promise<StoredQuestion | null>;
}

/** Today's facts, read again at the gate (arch 06 line 305: "Reload once"). */
export interface TodayReader {
  /**
   * Each row at its version now, in the order given; a row that no longer exists, that the call's scope does not see, or
   * a setup row outside `bound` (the stored question row's: T-1448), is left out (so limit 4 counts it gone).
   */
  currentVersions(rows: readonly RowRef[], bound: SetupBound): Promise<readonly RowRef[]>;
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

/**
 * The open questions over the data-access call, on the call's own transaction: limit 3's read (K-05 v1.2
 * openQuestionRead, under the call's row-level security), each row mapped as limit 3 maps it, with its turn.
 */
export function storedQuestionReaderOf(db: Sql | Tx): StoredQuestionReader {
  return {
    async liveQuestion(handleId, openQuestionId) {
      const live = await liveOpenQuestionsOfHandle(db, handleId);
      const found = live.find((question) => question.id === openQuestionId);
      return found === undefined ? null : { ...askedQuestionOf(handleId, found), turnId: found.turnId };
    },
  };
}

/** Today's facts over the data-access calls, on the call's own transaction under its business scope. */
export function todayReaderOf(db: Sql | Tx): TodayReader {
  return {
    currentVersions: (rows, bound) =>
      currentVersionsOf(db, rows, { businessId: bound.businessId, turnId: bound.turnId }),
    async booking(bookingId) {
      const head = await getBookingHead(db, bookingId);
      return head === null ? null : { id: head.id, stage: head.stage, version: head.version };
    },
  };
}
