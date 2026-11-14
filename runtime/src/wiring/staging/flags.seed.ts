// The seed of staging's release flags' test file (T-1393; ./flags.worker.test.ts; key FLAGS in infra/test-rig/files.mjs):
// the flag rows its reads answer from. The rig's globalSetup (infra/test-rig/rig.mjs) runs it once, in Node, on this
// file's database, after the migrations and bundle v0, with a client of the connecting login.
//
//   - Every flag of the staging flag set (infra/flags/staging.json), at the global scope, as `flags.sh apply` writes a flag
//     that has no row yet (infra/flags/flags.mjs apply: db/repo's createFlag): the skeleton flag, on.
//   - One flag of this test's own, off at the global scope and on for one phone, each row carrying a setting, so a read
//     shows which row decided, and that neither the scope nor the setting leaves the binding.
// It writes in one transaction as the runtime side's role, rosie_job, the only role granted release_flags
// (db/migrations/0012_core_rls.sql). Test values only (rule 9): fictional 555-01xx numbers and made-up settings.
import { createFlag, GLOBAL_SCOPE, phoneScope } from "../../../../db/repo/flags";
import type { Sql } from "../../../../db/repo/scope";
import stagingSet from "../../../../infra/flags/staging.json";

/** The staging flag set's flags, as `flags.sh apply` reads them: each name with on or off. */
export const STAGING_FLAGS: Readonly<Record<string, boolean>> = stagingSet.flags;

/** This test's own flag: off at the global scope, on for PHONE_ON alone. */
export const PHONE_FLAG = "t1393_phone_only";
/** The phone the flag is on for, and one with no row of its own (fictional 555-01xx numbers). */
export const PHONE_ON = "+15555550143";
export const PHONE_WITHOUT_ROW = "+15555550144";
/** The settings the two rows carry: never in an answer, a span, a log line or an error. */
export const GLOBAL_SETTING = "t1393-made-up-global-setting";
export const PHONE_SETTING = "t1393-made-up-phone-setting";
/** A flag name no row holds. */
export const FLAG_WITHOUT_ROW = "t1393_no_row";

/** Seeds this file's database (see the top of this file). */
export async function seed(sql: Sql): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe("set local role rosie_job");
    for (const [name, enabled] of Object.entries(STAGING_FLAGS)) {
      await createFlag(tx, { name, scope: GLOBAL_SCOPE, enabled });
    }
    await createFlag(tx, {
      name: PHONE_FLAG,
      scope: GLOBAL_SCOPE,
      enabled: false,
      value: { setting: GLOBAL_SETTING },
    });
    await createFlag(tx, {
      name: PHONE_FLAG,
      scope: phoneScope(PHONE_ON),
      enabled: true,
      value: { setting: PHONE_SETTING },
    });
  });
}
