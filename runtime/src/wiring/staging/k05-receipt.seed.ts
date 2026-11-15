// The seed of staging's receipt calls' test file (T-1394; ./k05-receipt.worker.test.ts; key K05_RECEIPT in
// infra/test-rig/files.mjs): the rows its two K-05 calls answer from. The rig's globalSetup (infra/test-rig/rig.mjs) runs
// it once, in Node, on this file's database, after the migrations and bundle v0, with a client of the connecting login.
//
//   - Test owner 1 (K-21 v1 tp-01: Sam, handle-sam and person-sam at the roster's fiction-range number), exactly as
//     staging holds him before T-570's JOIN: db/seeds/skeleton.ts's own set (T-1148), so his handle and person exist,
//     linked, with no sealing key and no phone row (K-05 handle-key-person-no-key.json, open-chat-first-text-sam.json).
//   - One held key row whose stored wrapping name is another upper-case name, for one more fiction-range number: a
//     handle, a person with no name, their link and that person's key, written by db/repo's own handleSealingKeyIn (K-05
//     v1.2 item 29, a first sight) under OTHER_WRAP_KEY_NAME, so the row is a real one that its own made-up wrapping key
//     opens. Staging's resolver takes SEALING_WRAP_KEY alone (./secrets.ts), so a text from that number is never sealed,
//     whatever the env holds under the other name.
// The second set is written in one transaction as the runtime side's role, rosie_job, with no business scope, as the
// skeleton seed writes its own. Test values only (rule 9): fiction-range 555-01xx numbers, made-up ids and a made-up
// wrapping key that wraps nothing but this row's throwaway data key.
//
// The skeleton seed is loaded inside seed() and never at the top of this file: it reads fixture files through Node's own
// modules (db/seeds/lib/fixture-set.ts), and the test file, which runs in the Workers runtime, imports this file's
// constants.
import { handleSealingKeyIn } from "../../../../db/repo/handle-keys";
import { SCOPE_SETTING, type Sql } from "../../../../db/repo/scope";
import { TEST_OWNER_1_PHONE } from "../../../../db/seeds/lib/roster";

/** Test owner 1's handle, by the roster's list (db/seeds/lib/roster.ts): its K-04 id and its fiction-range number. */
export const SAM_HANDLE = { id: TEST_OWNER_1_PHONE.handleId, number: TEST_OWNER_1_PHONE.fakeNumber } as const;

/** The other upper-case name the held key row stores: a name staging's resolver never takes. */
export const OTHER_WRAP_KEY_NAME = "T1394_OTHER_WRAP_KEY";

/** The made-up wrapping key the held key row is wrapped under: 32 bytes of 0x2b as base64, never a key of anything else. */
export const OTHER_WRAP_KEY_VALUE = btoa(String.fromCharCode(...new Uint8Array(32).fill(43)));

/** The handle whose one held key row stores OTHER_WRAP_KEY_NAME (a fictional 555-01xx number, made-up ids). */
export const OTHER_NAME_HANDLE = {
  id: "handle-t1394-other-name",
  personId: "person-t1394-other-name",
  number: "+15555550151",
} as const;

/** Seeds this file's database (see the top of this file). */
export async function seed(sql: Sql): Promise<void> {
  const { seedSkeleton } = await import("../../../../db/seeds/skeleton");
  await seedSkeleton(sql);
  await sql.begin(async (tx) => {
    await tx.unsafe("set local role rosie_job");
    // The runtime side runs with no business scope (K-05 "Scope"); '' reads as none, as an unset scope does.
    await tx`select set_config(${SCOPE_SETTING}, '', true)`;
    const made = await handleSealingKeyIn(
      tx,
      { resolve: (name) => (name === OTHER_WRAP_KEY_NAME ? OTHER_WRAP_KEY_VALUE : undefined) },
      {
        handle: { kind: "phone", address: OTHER_NAME_HANDLE.number },
        newHandleId: OTHER_NAME_HANDLE.id,
        newPersonId: OTHER_NAME_HANDLE.personId,
        wrappingKeyName: OTHER_WRAP_KEY_NAME,
      },
    );
    const { created, key } = made.outcome;
    if (!created.handle || !created.person || !created.key || key.wrappingKeyName !== OTHER_WRAP_KEY_NAME) {
      throw new Error("the seed did not write the held key row under the other name");
    }
  });
}
