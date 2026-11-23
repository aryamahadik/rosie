// S1-76's review item's paging reader on staging (T-1540, S1-09 design card 8 extended to S1-10; DL-1179; DL-972's note;
// K-09 README default 205; T-1444's lead note, point 2): the narrow PagingReader staging's gate hands S1-76's writer as
// its paging ports' reader (../real.ts GateListingReads.paging), for the three reads T-319's openReviewItem makes. It is
// no part of T-1444's binding of the paging service: it answers those three reads and refuses every other (notBuilt,
// naming openReviewItem), so every other paging call stays unbuilt until T-1444 binds the runtime's whole reader.
//
//   the turn's business  read once per reader, on first use, from the gate call's own transaction (db/repo scope.ts
//                 requireBusinessScope): the business scope db/repo's withBusiness set for the call from its caller's
//                 business and checks again at its end, which is the turn's (the paging service checks the item's caller
//                 against the turn: domain/paging handlers.ts checkTurn). Every read answers for that business alone; a
//                 call with no scope is refused (BusinessScopeError) before anything is read.
//   reviewItem    K-37 review_items by id, only a row of the turn's business, with its summary (K-37 v1 summary; review.ts
//                 default 30): review_items has no row-level security and rosie_app holds no grant on it (K-37 rule 2;
//                 0014), so the read names the business itself, and an id no row of that business holds answers null.
//   row           ("businesses", id) only: the turn's own business head's version, and its business (its own id), read
//                 under that business's scope (rosie_job sees only its scope's businesses: 0012 businesses_runtime);
//                 another business's id answers null, which openReviewItem answers notFound, with nothing read (T-1444's
//                 lead note: the subject is read under the caller's business); any other table is refused (notBuilt)
//                 before anything is read.
//   businessZone  the turn's own business's zone through K-05 v1.4 item 43 (db/repo safety-reads.ts readBusinessZone, in a
//                 read-only transaction of its own under that business's scope): notFound answers null, as the port reads
//                 a business it does not find; any other K-05 error answer is thrown (ListingPagingReadError, the read and
//                 the error's name alone); another business's zone is refused (ListingPagingScopeError) with nothing
//                 read, never answered null, which openReviewItem would read as UTC.
//
// Each read runs on a runtime-side client of its own that the root's handle opens, guards and ends for that one read
// (./part.ts StagingDb.runtime: HYPERDRIVE_JOB, rosie_worker_job, which inherits rosie_job), straight from the handle and
// never through the gate's slots, as the stop reads are (./tool-api-gate.ts): openReviewItem awaits each read before the
// next, so the gate call holds its own client and one of these at a time, 2 connections at most. reviewItem and row each
// run in a read-only transaction at repeatable read (db/repo targets.ts inRuntimeTransaction, as db/repo's standalone
// reads open theirs) under the turn's business's scope (db/repo scope.ts SCOPE_SETTING), and are the only statements this
// file writes: K-05 has no read of a review item by id or of a business head's version with no handle (K-05 v1.2 item 26
// needs one), and the reads are staging's alone, T-1444's to replace.
//
// Whatever a read throws leaves scrubbed under its call's name (db/repo clocks.ts scrubbed: a SQLSTATE or the client's
// code alone), so no statement's values ride out. Nothing here logs: no id, summary, zone or business is put in a line or
// an error.

import {
  noPagingReads,
  type PagingReader,
  type StoredReviewItem,
  type StoredRow,
} from "@rosie/actions/src/domain/paging";
import { scrubbed } from "@rosie/db/repo/clocks";
import { readBusinessZone } from "@rosie/db/repo/safety-reads";
import {
  assertBusinessId,
  requireBusinessScope,
  SCOPE_SETTING,
  type Sql,
  type Tx,
} from "@rosie/db/repo/scope";
import { inRuntimeTransaction, utc, utcOrNull } from "@rosie/db/repo/targets";

import type { StagingDb } from "./part";

/** Each read's name on the handle: on its timing line, and on every error that leaves it. */
export const LISTING_PAGING_CALLS = Object.freeze({
  reviewItem: "readReviewItem",
  businessRow: "readBusinessRow",
  businessZone: "readBusinessZone",
} as const);

/** The paging call the reader's refusals name: the one call it reads for (T-319's openReviewItem). */
const REVIEW_CALL = "openReviewItem";

/** A read asked for another business than the turn's: refused with nothing read. Names the read alone. */
export class ListingPagingScopeError extends Error {
  override readonly name = "ListingPagingScopeError";
  readonly read: string;

  constructor(read: string) {
    super(`${read}: the listing paging reader answers for the turn's own business alone`);
    this.read = read;
  }
}

/** A K-05 error answer to one of the reader's reads, thrown, never read as none. Names the read and the error alone. */
export class ListingPagingReadError extends Error {
  override readonly name = "ListingPagingReadError";
  readonly read: string;
  readonly fault: string;

  constructor(read: string, fault: string) {
    super(`${read}: K-05 answered ${fault}`);
    this.read = read;
    this.fault = fault;
  }
}

/** A K-37 review_items row as reviewItem reads it. */
interface ReviewItemRow {
  readonly id: string;
  readonly kind: StoredReviewItem["kind"];
  readonly business_id: string | null;
  readonly subject_table: string | null;
  readonly subject_row_id: string | null;
  readonly turn_id: string | null;
  readonly raised_by_person_id: string | null;
  readonly summary: string;
  readonly opened_at: Date;
  readonly due_at: Date;
  readonly state: StoredReviewItem["state"];
  readonly wait_until: Date | null;
  readonly decided_at: Date | null;
  readonly decided_by_person_id: string | null;
  readonly outcome: string | null;
  readonly version: number;
}

/** A row as the paging service reads a review item: times in UTC ending in Z. */
function storedReviewItemOf(row: ReviewItemRow): StoredReviewItem {
  return {
    id: row.id,
    kind: row.kind,
    businessId: row.business_id,
    subjectTable: row.subject_table,
    subjectRowId: row.subject_row_id,
    turnId: row.turn_id,
    raisedByPersonId: row.raised_by_person_id,
    summary: row.summary,
    openedAt: utc(row.opened_at),
    dueAt: utc(row.due_at),
    state: row.state,
    waitUntil: utcOrNull(row.wait_until),
    decidedAt: utcOrNull(row.decided_at),
    decidedByPersonId: row.decided_by_person_id,
    outcome: row.outcome,
    version: row.version,
  };
}

/** One read on a runtime-side client of its own; whatever it throws leaves scrubbed under its name. */
async function onRuntime<T>(db: StagingDb, call: string, read: (sql: Sql) => Promise<T>): Promise<T> {
  try {
    return await db.runtime(call, read);
  } catch (error) {
    throw scrubbed(call, error);
  }
}

/** One statement in a read-only transaction of its own, under `businessId`'s scope, on a runtime-side client. */
function underBusiness<T>(
  db: StagingDb,
  call: string,
  businessId: string,
  read: (tx: Sql) => Promise<T>,
): Promise<T> {
  assertBusinessId(businessId);
  return onRuntime(db, call, (sql) =>
    inRuntimeTransaction(sql, { readOnly: true }, async (tx) => {
      await tx`select set_config(${SCOPE_SETTING}, ${businessId}, true)`;
      return read(tx);
    }),
  );
}

/**
 * The narrow PagingReader for one gate call (see the top of this file), over the root's handle `db` and the call's own
 * transaction `call`, which only its business scope is read from. Making it reads nothing.
 */
export function listingPagingReader(db: StagingDb, call: Tx): PagingReader {
  const refuse = noPagingReads(REVIEW_CALL);
  let business: Promise<string> | null = null;
  /** The turn's business: the gate call's own scope, read once, on first use. */
  const turnBusiness = (): Promise<string> => (business ??= requireBusinessScope(call));
  return {
    ...refuse,
    async reviewItem(reviewItemId) {
      const businessId = await turnBusiness();
      const [row] = await underBusiness(
        db,
        LISTING_PAGING_CALLS.reviewItem,
        businessId,
        (tx) => tx<ReviewItemRow[]>`
          select id, kind, business_id, subject_table, subject_row_id, turn_id, raised_by_person_id, summary,
                 opened_at, due_at, state, wait_until, decided_at, decided_by_person_id, outcome, version
          from review_items
          where id = ${reviewItemId} and business_id = ${businessId}
        `,
      );
      return row === undefined ? null : storedReviewItemOf(row);
    },
    async row(table, rowId): Promise<StoredRow | null> {
      if (table !== "businesses") return refuse.row(table, rowId);
      const businessId = await turnBusiness();
      if (rowId !== businessId) return null;
      const [head] = await underBusiness(
        db,
        LISTING_PAGING_CALLS.businessRow,
        businessId,
        (tx) => tx<{ id: string; version: number }[]>`
          select id, version from businesses where id = ${businessId}
        `,
      );
      return head === undefined ? null : { version: head.version, businessId: head.id };
    },
    async businessZone(askedId) {
      const businessId = await turnBusiness();
      if (askedId !== businessId) throw new ListingPagingScopeError(LISTING_PAGING_CALLS.businessZone);
      const outcome = await onRuntime(db, LISTING_PAGING_CALLS.businessZone, (sql) =>
        readBusinessZone(sql, { businessId }),
      );
      if ("error" in outcome) {
        if (outcome.error === "notFound") return null;
        throw new ListingPagingReadError(LISTING_PAGING_CALLS.businessZone, outcome.error);
      }
      return outcome.timeZone;
    },
  };
}
