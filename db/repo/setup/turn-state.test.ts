// T-667: setup/turn-state.ts's refusals that come before the database is reached (K-05 v1.2 item 26: unknownFact with
// nothing read; a request out of shape throws), without a database, and fact-homes.ts's rule for each table scoped none
// (round 2). The integration test, turn-state.int.test.ts, reads every part's seed row back against local PostgreSQL and
// holds each rule there.
import { describe, expect, it } from "vitest";
import type { Sql } from "../scope";
import type { ReadTurnStateRequest } from "../turn-state";
import { SETUP_FACT_HOMES, UNSCOPED_ROWS, unscopedRowsOf } from "./fact-homes";
import { readTurnState } from "./turn-state";

/** A client that records any use and refuses it: a call that reaches it has read something. */
function untouchable(): { sql: Sql; reached: () => boolean } {
  let used = false;
  const refuse = (): never => {
    used = true;
    throw new Error("the database was reached");
  };
  const sql = new Proxy(refuse, { get: refuse, apply: refuse }) as unknown as Sql;
  return { sql, reached: () => used };
}

const request = (facts: ReadTurnStateRequest["facts"]): ReadTurnStateRequest => ({
  handleId: "handle-sam",
  businessId: "biz-lees-barbershop",
  bookingIds: [],
  facts,
});

describe("setup/turn-state.ts readTurnState before the database", () => {
  it("answers unknownFact for the first fact, in the request's order, that has no home, with nothing read", async () => {
    for (const [table, column] of [
      ["proof_codes", "code_hash"],
      ["sessions", "device_sha256"],
      ["page_links", "code_sha256"],
      ["emergency_contacts", "mobile"],
      ["documents", "issuer"],
      ["locations", "travel_centre"],
      ["staging_testers", "id"],
      ["sign_in_attempts", "id"],
      ["contact_changes", "id"],
      ["sealing_keys", "wrapped_key"],
      ["harm_reports", "id"],
      ["company_kinds", "no_such_column"],
    ] as const) {
      const { sql, reached } = untouchable();
      const outcome = await readTurnState(
        sql,
        request([
          {
            key: "kind",
            table: "company_kinds",
            rowId: "company-lees-barbershop/barber",
            column: "pf_facts",
          },
          { key: "zone", table: "businesses", rowId: "biz-lees-barbershop", column: "time_zone" },
          { key: "refused", table, rowId: "x", column },
          { key: "also", table: "no_such_table", rowId: "x", column: "id" },
        ]),
      );
      expect(outcome, `${table}.${column}`).toEqual({ error: "unknownFact", key: "refused", table, column });
      expect(reached(), `${table}.${column}`).toBe(false);
    }
  });

  it("refuses a request out of shape with a TypeError, with nothing read", async () => {
    const malformed: unknown[] = [
      null,
      { ...request([]), extra: true },
      { handleId: "handle-sam", businessId: "biz-lees-barbershop", bookingIds: [] },
      { ...request([]), handleId: "" },
      { ...request([]), businessId: " " },
      { ...request([]), bookingIds: ["b", "b"] },
      request([{ key: "k", table: "services", rowId: "svc", column: "name", extra: 1 } as never]),
      request([{ key: "", table: "services", rowId: "svc", column: "name" }]),
      request([{ key: "k", table: "Services", rowId: "svc", column: "name" }]),
      request([{ key: "k", table: "services", rowId: "", column: "name" }]),
    ];
    for (const shape of malformed) {
      const { sql, reached } = untouchable();
      await expect(readTurnState(sql, shape as ReadTurnStateRequest)).rejects.toThrow(TypeError);
      expect(reached()).toBe(false);
    }
  });
});

describe("fact-homes.ts UNSCOPED_ROWS (round 2: DL-925 item 8)", () => {
  it("gives every setup home scoped none its rule, and no other table one", () => {
    const unscoped = Object.entries(SETUP_FACT_HOMES)
      .filter(([, home]) => home.scopedBy === null)
      .map(([table]) => table);
    expect(Object.keys(UNSCOPED_ROWS).sort()).toEqual(unscoped.sort());
    expect(UNSCOPED_ROWS).toEqual({
      accounts: "person",
      proof_codes: "personCode",
      sessions: "person",
      kinds: "catalog",
      kind_flows: "catalog",
      calendar_links: "calendarLink",
      busy_blocks: "busyBlock",
    });
    for (const table of unscoped) {
      expect(unscopedRowsOf(table), table).toBe(UNSCOPED_ROWS[table]);
    }
  });

  it("throws for a table with no rule: no row of a table scoped none is read by its name alone", () => {
    for (const table of ["staff", "business_setup", "persons", "no_such_table", "__proto__", "toString"]) {
      expect(() => unscopedRowsOf(table), table).toThrow(/has no rule/);
    }
  });
});
