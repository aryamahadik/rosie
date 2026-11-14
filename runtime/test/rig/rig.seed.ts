// The seed of the Workers test rig's own test file (T-1253; ADR-014 section 4, "The rig's first tests (piece 5)"): two
// businesses, each with rows the first tests count, and the people who hold them. The rig's globalSetup
// (infra/test-rig/rig.mjs) runs it once, in Node, on this file's database (key RIG in infra/test-rig/files.mjs), after the
// migrations and bundle v0, with a client of the connecting login.
//
// It writes as the core seed does (db/seeds/core.ts): in one transaction as the runtime side's role, rosie_job, with no
// business scope, whose row-level security policies let it write every business's rows; it never bypasses them.
// Business A holds two roles and business B one, so a count tells the two scopes apart; persons span businesses, and the
// Tool API's role has no grant on them. Test values only: made-up names and ids, no phone number (rule 9).
import { SCOPE_SETTING, type Sql } from "../../../db/repo/scope";

/** The two businesses, each with the people who hold a role there, in id order. */
export const RIG_BUSINESSES = [
  { id: "rig-business-a", name: "Rig Test Business A", people: ["rig-person-1", "rig-person-2"] },
  { id: "rig-business-b", name: "Rig Test Business B", people: ["rig-person-3"] },
] as const;

/** Every person the seed writes: one table that spans businesses. */
export const RIG_PERSONS = ["rig-person-1", "rig-person-2", "rig-person-3"] as const;

/** Seeds this file's database (see the top of this file). */
export async function seed(sql: Sql): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe("set local role rosie_job");
    // The runtime side runs with no business scope (K-05 "Scope"); '' reads as none, as an unset scope does.
    await tx`select set_config(${SCOPE_SETTING}, '', true)`;
    for (const business of RIG_BUSINESSES) {
      await tx`
        insert into businesses (id, name, display_name, time_zone)
        values (${business.id}, ${business.name}, ${business.name}, 'America/New_York')
      `;
    }
    for (const person of RIG_PERSONS) {
      await tx`insert into persons (id, name) values (${person}, ${`Rig ${person}`})`;
    }
    for (const business of RIG_BUSINESSES) {
      for (const person of business.people) {
        await tx`
          insert into person_roles (id, person_id, business_id, role)
          values (${`${business.id}-${person}`}, ${person}, ${business.id}, 'staff')
        `;
      }
    }
  });
}
