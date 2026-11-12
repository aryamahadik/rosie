// T-1302: the test-phone roster's one list (db/seeds/lib/roster.ts; K-05 v1.12 default 106) against the rows the seeds
// write, on local PostgreSQL (`npm run db:up`; `npm run test:integration -- db/seeds`). The block migrates a fresh test
// schema of its own (db/repo/test-db.ts), loads D-017's two test-phone sets into it (the skeleton seed for tp-01, the
// staging-core seed for tp-02 to tp-05, with no STAGING_TEST_PHONES, so at the fake handles), and drops it at the end;
// the shared public schema is never touched.
//
// The card's proof: every roster id resolves to one handle whose number matches the list and K-21 v1's frozen
// test-roster.json (read here with node:fs, never through the list). The handle is read as K-05 v1.12 item 54 reads it:
// as rosie_job with no business scope, by the list's handle id, of kind phone. The numbers are the fictional 555-01xx.
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePrimaryUrl } from "../../repo/client";
import type { Sql } from "../../repo/scope";
import { createTestDatabase, type TestDatabase } from "../../repo/test-db";
import { seedSkeleton } from "../skeleton";
import { seedStagingCore } from "../staging-core";
import { ROSTER, rosterPhone } from "./roster";

const SLOW = { timeout: 120_000 };
const K21_PHONES = (
  JSON.parse(
    readFileSync(new URL("../../../contracts/page-api/fixtures/test-roster.json", import.meta.url), "utf8"),
  ) as { outcome: { phones: { testPhoneId: string; last4: string }[] } }
).outcome.phones;

/** Connections that run as rosie_job, the runtime side's role, with `schema` first and no business scope. */
function runtimeClient(schema: string): Sql {
  return postgres(resolvePrimaryUrl(), {
    max: 2,
    onnotice: () => undefined,
    connection: {
      application_name: "rosie-t1302-roster",
      search_path: `${schema}, public`,
      role: "rosie_job",
    },
  });
}

describe("every roster id resolves to one handle, on a fresh schema with D-017's test-phone sets", () => {
  let db: TestDatabase;
  let runtime: Sql;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_roster" });
    runtime = runtimeClient(db.schema);
    await seedSkeleton(db.sql);
    await seedStagingCore(db.sql, { env: {} });
  }, 120_000);

  afterAll(async () => {
    await runtime.end({ timeout: 5 });
    await db.drop();
  }, 120_000);

  it(
    "each of K-21's roster ids names the list's handle, one phone handle whose number is the list's and +1 555 555 with K-21's last four digits; the number is that handle's alone",
    SLOW,
    async () => {
      expect(K21_PHONES.map((phone) => phone.testPhoneId)).toEqual(ROSTER.map((phone) => phone.testPhoneId));
      for (const k21 of K21_PHONES) {
        const listed = rosterPhone(k21.testPhoneId);
        expect(listed, k21.testPhoneId).not.toBeNull();
        const handleId = listed?.handleId ?? "";
        const handles = await runtime<{ id: string; kind: string; address: string }[]>`
          select id, kind, address from handles where id = ${handleId} and kind = 'phone'
        `;
        expect([...handles], k21.testPhoneId).toEqual([
          { id: handleId, kind: "phone", address: listed?.fakeNumber },
        ]);
        expect(handles[0]?.address, k21.testPhoneId).toBe(`+1555555${k21.last4}`);
        const holders = await runtime<{ id: string }[]>`
          select id from handles where address = ${handles[0]?.address ?? ""}
        `;
        expect(
          holders.map((row) => row.id),
          k21.testPhoneId,
        ).toEqual([handleId]);
      }
    },
  );

  it("the roster's five handles are five different handles at five different numbers", SLOW, async () => {
    const [found] = await runtime<{ handles: number; numbers: number }[]>`
      select count(distinct id)::int as handles, count(distinct address)::int as numbers
      from handles where id in ${runtime(ROSTER.map((phone) => phone.handleId))}
    `;
    expect(found).toEqual({ handles: ROSTER.length, numbers: ROSTER.length });
  });
});
