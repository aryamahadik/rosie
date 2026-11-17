// T-667: setup/turn-state.ts's refusals that come before the database is reached (K-05 v1.2 item 26: unknownFact with
// nothing read; a request out of shape throws), without a database. The integration test, turn-state.int.test.ts, reads
// every part's seed row back against local PostgreSQL.
import { describe, expect, it } from "vitest";
import type { Sql } from "../scope";
import type { ReadTurnStateRequest } from "../turn-state";
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
          { key: "kind", table: "company_kinds", rowId: "company-lees-barbershop/barber", column: "pf_facts" },
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
