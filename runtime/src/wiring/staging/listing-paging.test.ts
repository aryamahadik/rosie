// The narrow listing paging reader (T-1540; ./listing-paging.ts), under Node (Vitest project "unit"), over a double of
// the root's handle that records each runtime-side call by its name and answers what a case gives it (the statements
// themselves, their transaction and their scope run on PostgreSQL in ./tool-api-gate.worker.test.ts), and a double of the
// gate call's own transaction that answers the business scope db/repo's withBusiness set:
//
//   - making it reads nothing; the turn's business is read from the call's own transaction once, on first use, and every
//     read answers for that business alone: reviewItem's row mapped as the paging service reads it (times in UTC ending
//     in Z, its summary), or null; row("businesses", <the turn's business>) its version and business, another business's
//     id null with no client opened, any other table refused notBuilt with nothing read; businessZone the turn's own zone
//     (K-05 item 43's answer), notFound null, any other error answer thrown as ListingPagingReadError, another business's
//     refused (ListingPagingScopeError) with no client opened;
//   - every other read of the port refuses notBuilt (openReviewItem) with nothing read; a call with no business scope is
//     refused (BusinessScopeError) before any client is opened;
//   - a failed read leaves scrubbed under its call's name, none of the statement's values on what is thrown; nothing logs.
// Test values only (rule 9): made-up ids and the master's sample shop's zone.
import { DataAccessDatabaseError } from "@rosie/db/repo/clocks";
import { BusinessScopeError, type Tx } from "@rosie/db/repo/scope";
import { NotBuiltError } from "@rosie/actions/src/tool-api/errors";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import {
  LISTING_PAGING_CALLS,
  ListingPagingReadError,
  ListingPagingScopeError,
  listingPagingReader,
} from "./listing-paging";
import type { StagingDb } from "./part";

const BUSINESS = "biz-t1540-listing";
const OTHER_BUSINESS = "biz-t1540-other";
const ITEM = "review-item-t1540-1";

/** The root's handle as a double: each runtime-side call written down by its name, answered as `answers` gives it. */
function handleDouble(answers: Readonly<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  const db = {
    runtime(call: string): Promise<unknown> {
      calls.push(call);
      const answer = answers[call];
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    toolApi(call: string): Promise<never> {
      calls.push(`toolApi ${call}`);
      return Promise.reject(new Error("no Tool API client is opened here"));
    },
    counts: () => ({
      opened: 0,
      ended: 0,
      connectionsOpen: 0,
      connectionsPeak: 0,
      quietReads: 0,
      quietWrites: 0,
    }),
  };
  return { db: db as unknown as StagingDb, calls };
}

/** The gate call's own transaction as a double: it answers its business scope, and writes down each statement. */
function callDouble(scope: string | null = BUSINESS) {
  const statements: string[] = [];
  const tx = (strings: TemplateStringsArray): Promise<unknown[]> => {
    statements.push(strings.join("?").replace(/\s+/gu, " ").trim());
    return Promise.resolve([{ scope }]);
  };
  return { tx: tx as unknown as Tx, statements };
}

/** A review_items row as postgres.js hands it over: its times as Dates. */
function reviewItemRow() {
  return {
    id: ITEM,
    kind: "listing_match",
    business_id: BUSINESS,
    subject_table: "businesses",
    subject_row_id: BUSINESS,
    turn_id: "turn-t1540-1",
    raised_by_person_id: "person-t1540-owner",
    summary: "A listing check (S1-76): stand-in summary.",
    opened_at: new Date("2026-10-19T18:09:06.000Z"),
    due_at: new Date("2026-10-20T18:09:06.000Z"),
    state: "open",
    wait_until: null,
    decided_at: null,
    decided_by_person_id: null,
    outcome: null,
    version: 1,
  };
}

/** What a promise rejected with; fails the test when it resolved. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the read to fail");
}

const consoleNames = ["log", "info", "warn", "error", "debug"] as const;
let spies: MockInstance[] = [];

beforeEach(() => {
  spies = consoleNames.map((name) => vi.spyOn(console, name).mockImplementation(() => undefined));
});

afterEach(() => {
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  for (const spy of spies) spy.mockRestore();
});

describe("the listing paging reader: openReviewItem's three reads under the turn's business alone (T-1540)", () => {
  it("its calls' names: the review item's and the business head's its own, the zone's K-05 item 43's", () => {
    expect(LISTING_PAGING_CALLS).toEqual({
      reviewItem: "readReviewItem",
      businessRow: "readBusinessRow",
      businessZone: "readBusinessZone",
    });
    expect(Object.isFrozen(LISTING_PAGING_CALLS)).toBe(true);
  });

  it("making it reads nothing; the turn's business is the call's own scope, read once on first use; the three reads each open one runtime-side client, in openReviewItem's order", async () => {
    const { db, calls } = handleDouble({
      readReviewItem: [],
      readBusinessRow: [{ id: BUSINESS, version: 3 }],
      readBusinessZone: {
        result: "businessZone",
        businessId: BUSINESS,
        readAt: "2026-10-19T18:09:06Z",
        timeZone: "America/New_York",
      },
    });
    const call = callDouble();

    const reader = listingPagingReader(db, call.tx);
    expect(calls).toEqual([]);
    expect(call.statements).toEqual([]);

    expect(await reader.reviewItem(ITEM)).toBeNull();
    expect(await reader.row("businesses", BUSINESS)).toEqual({ version: 3, businessId: BUSINESS });
    expect(await reader.businessZone(BUSINESS)).toBe("America/New_York");

    expect(calls).toEqual(["readReviewItem", "readBusinessRow", "readBusinessZone"]);
    // The scope read once, on the call's own transaction (db/repo's requireBusinessScope), never a client of its own.
    expect(call.statements).toEqual(["select current_setting(?, true) as scope"]);
  });

  it("reviewItem: the turn's business's row as the paging service reads it, its times in UTC ending in Z and its summary", async () => {
    const { db } = handleDouble({ readReviewItem: [reviewItemRow()] });

    expect(await listingPagingReader(db, callDouble().tx).reviewItem(ITEM)).toEqual({
      id: ITEM,
      kind: "listing_match",
      businessId: BUSINESS,
      subjectTable: "businesses",
      subjectRowId: BUSINESS,
      turnId: "turn-t1540-1",
      raisedByPersonId: "person-t1540-owner",
      summary: "A listing check (S1-76): stand-in summary.",
      openedAt: "2026-10-19T18:09:06Z",
      dueAt: "2026-10-20T18:09:06Z",
      state: "open",
      waitUntil: null,
      decidedAt: null,
      decidedByPersonId: null,
      outcome: null,
      version: 1,
    });
  });

  it("row: another business's id answers null with no client opened; any other table is refused notBuilt (openReviewItem) with nothing read; a head not found answers null", async () => {
    const { db, calls } = handleDouble({ readBusinessRow: [] });
    const call = callDouble();
    const reader = listingPagingReader(db, call.tx);

    const refused = await rejectionOf(reader.row("business_setup", BUSINESS));
    expect(refused).toBeInstanceOf(NotBuiltError);
    expect(refused).toMatchObject({ call: "openReviewItem" });
    expect(call.statements).toEqual([]);

    expect(await reader.row("businesses", OTHER_BUSINESS)).toBeNull();
    expect(calls).toEqual([]);

    expect(await reader.row("businesses", BUSINESS)).toBeNull();
    expect(calls).toEqual(["readBusinessRow"]);
  });

  it("businessZone: another business's is refused with no client opened, naming the read alone; notFound answers null; any other K-05 error answer is thrown, naming the read and the error alone", async () => {
    const other = handleDouble();
    const scopeError = await rejectionOf(
      listingPagingReader(other.db, callDouble().tx).businessZone(OTHER_BUSINESS),
    );
    expect(scopeError).toBeInstanceOf(ListingPagingScopeError);
    expect(scopeError).toMatchObject({ name: "ListingPagingScopeError", read: "readBusinessZone" });
    expect(String(scopeError)).not.toContain(OTHER_BUSINESS);
    expect(String(scopeError)).not.toContain(BUSINESS);
    expect(other.calls).toEqual([]);

    const notFound = handleDouble({
      readBusinessZone: { error: "notFound", table: "businesses", rowId: BUSINESS },
    });
    expect(await listingPagingReader(notFound.db, callDouble().tx).businessZone(BUSINESS)).toBeNull();

    const transient = handleDouble({ readBusinessZone: { error: "transient", code: "08006" } });
    const readError = await rejectionOf(
      listingPagingReader(transient.db, callDouble().tx).businessZone(BUSINESS),
    );
    expect(readError).toBeInstanceOf(ListingPagingReadError);
    expect(readError).toMatchObject({ read: "readBusinessZone", fault: "transient" });
    expect(String(readError)).not.toContain(BUSINESS);
  });

  it("every other read of the port refuses notBuilt (openReviewItem) with nothing read", async () => {
    const { db, calls } = handleDouble();
    const call = callDouble();
    const reader = listingPagingReader(db, call.tx);
    const others: [string, () => Promise<unknown>][] = [
      ["page", () => reader.page("page-1")],
      ["members", () => reader.members()],
      ["chat", () => reader.chat("handle-1")],
      ["reachOf", () => reader.reachOf("person-1")],
      ["handOff", () => reader.handOff("hand-off-1")],
      ["safetyRead", () => reader.safetyRead("outcome-1")],
      ["ownerOf", () => reader.ownerOf(BUSINESS)],
      ["businessName", () => reader.businessName(BUSINESS)],
      ["clock", () => reader.clock("clock-1")],
      ["outboxRowWritten", () => reader.outboxRowWritten("row-1")],
    ];
    for (const [name, read] of others) {
      const refused = await rejectionOf(read());
      expect(refused, name).toBeInstanceOf(NotBuiltError);
      expect(refused, name).toMatchObject({ call: "openReviewItem" });
    }
    expect(calls).toEqual([]);
    expect(call.statements).toEqual([]);
  });

  it("a call with no business scope is refused (BusinessScopeError) before any client is opened, for each of the three reads", async () => {
    const { db, calls } = handleDouble();
    for (const read of [
      (reader: ReturnType<typeof listingPagingReader>) => reader.reviewItem(ITEM),
      (reader: ReturnType<typeof listingPagingReader>) => reader.row("businesses", BUSINESS),
      (reader: ReturnType<typeof listingPagingReader>) => reader.businessZone(BUSINESS),
    ]) {
      const refused = await rejectionOf(read(listingPagingReader(db, callDouble("").tx)));
      expect(refused).toBeInstanceOf(BusinessScopeError);
    }
    expect(calls).toEqual([]);
  });

  it("a failed read leaves scrubbed under its call's name: a database refusal as its SQLSTATE alone, a client's error with none of the statement's values", async () => {
    const refusal = Object.assign(new Error(`permission denied for ${ITEM}`), {
      name: "PostgresError",
      code: "42501",
      query: `select ... where id = '${ITEM}'`,
      parameters: [ITEM, BUSINESS],
    });
    const lost = Object.assign(new Error(`write CONNECT_TIMEOUT db.example.test:5432 for ${BUSINESS}`), {
      code: "CONNECT_TIMEOUT",
      args: [ITEM, BUSINESS],
    });
    for (const [failure, call] of [
      [refusal, "readReviewItem"],
      [lost, "readBusinessRow"],
    ] as const) {
      const { db } = handleDouble({ [call]: failure });
      const reader = listingPagingReader(db, callDouble().tx);
      const thrown = await rejectionOf(
        call === "readReviewItem" ? reader.reviewItem(ITEM) : reader.row("businesses", BUSINESS),
      );
      expect(thrown).not.toBe(failure);
      if (failure === refusal) {
        expect(thrown).toBeInstanceOf(DataAccessDatabaseError);
        expect(thrown).toMatchObject({ call, code: "42501" });
      } else {
        expect(thrown).toMatchObject({ call, code: "CONNECT_TIMEOUT" });
      }
      const texts = [String(thrown), JSON.stringify(thrown), (thrown as Error).stack ?? ""];
      for (const text of texts) {
        expect(text).not.toContain(ITEM);
        expect(text).not.toContain(BUSINESS);
        expect(text).not.toContain("db.example.test");
      }
    }
  });
});
