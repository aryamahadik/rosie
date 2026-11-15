// The seed of staging's sign-in test file (T-1289; ./sign-in.worker.test.ts; key SIGN_IN in infra/test-rig/files.mjs):
// the accounts K-05 v1.13's sign-in calls find a person by (items 58 and 59: an account's proven email and its email
// handle) and the listings personStanding and the test-phone page's standing read (K-22 v1.3 staging_testers; K-05 v1.15
// items 68 and 69). The rig's globalSetup (infra/test-rig/rig.mjs) runs it once, in Node, on this file's database, after
// the migrations and bundle v0, with a client of the connecting login.
//
//   Sam          person-sam with his email handle and an account whose email, proven, is the address K-21 v1's
//                sign-in-request.json types (sam@lees-barbershop.example, on the reserved .example domain), and a live
//                listing as a staging tester (a row of this file's own), so his signed-in token passes the test-phone
//                page's admission. No role, no team row and no session: his first session starts on the code alone
//                (K-21 default 4).
//   the testers  K-22 v1.3's seed-staging-tester.json, every row as the fixture holds it (accounts included): tester one
//                listed, tester two whose listing ended, each with an email handle, a proven account, a used sign-in
//                code and a session. The web shell's sign-in route signs tester one in.
//
// It writes as the connecting login, in one transaction (accounts is the runtime side's to read, not to write). Nothing
// is updated or deleted. Test values only (rule 9): the contracts' fixtures, made-up ids, addresses on reserved domains,
// and no number at all.
import seedStagingTester from "../../../../contracts/db-schema/people-access/fixtures/seed-staging-tester.json";
import type { Sql, Tx } from "../../../../db/repo/scope";

/** Sam, as K-21 v1's sign-in-request.json signs him in by the email way. */
export const SAM = {
  personId: "person-sam",
  emailHandleId: "handle-sam-email",
  address: "sam@lees-barbershop.example",
  listingId: "staging-tester-t1289-sam",
  provenAt: "2026-10-01T09:00:00Z",
} as const;

/** Tester one, as K-22 v1.3's seed-staging-tester.json lists them. */
export const TESTER_ONE = {
  personId: "person-tester-one",
  emailHandleId: "handle-tester-one-email",
  address: "tester-one@example.com",
} as const;

/** The rows this seed writes in each table the sign-in calls write (none of them a call's). */
export const SEEDED_ROWS = {
  sign_in_attempts: 0,
  proof_codes: 2,
  sessions: 2,
  outbox_rows: 0,
  outbox_parts: 0,
} as const;

type Cell = string | number | boolean | null;
type Row = Record<string, Cell>;

async function insert(tx: Tx, table: string, values: Row): Promise<void> {
  await tx`insert into ${tx(table)} ${tx(values)}`;
}

/** Seeds this file's database (see the top of this file). */
export async function seed(sql: Sql): Promise<void> {
  await sql.begin(async (tx) => {
    await insert(tx, "persons", { id: SAM.personId, name: null, language: null });
    await insert(tx, "handles", { id: SAM.emailHandleId, kind: "email", address: SAM.address });
    await insert(tx, "person_handles", { person_id: SAM.personId, handle_id: SAM.emailHandleId });
    await insert(tx, "accounts", {
      person_id: SAM.personId,
      mobile: null,
      mobile_proven_at: null,
      email: SAM.address,
      email_proven_at: SAM.provenAt,
      version: 1,
    });
    await insert(tx, "staging_testers", {
      id: SAM.listingId,
      person_id: SAM.personId,
      added_at: SAM.provenAt,
      removed_at: null,
      version: 1,
    });

    // K-22 v1.3's two listed testers, every row as the fixture holds it, in its order.
    for (const row of seedStagingTester.rows) await insert(tx, row.table, { ...(row.values as Row) });
  });
}
