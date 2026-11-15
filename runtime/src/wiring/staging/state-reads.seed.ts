// The seed of staging's state reads' test file (T-1400; ./state-reads.worker.test.ts; key STATE_READS in
// infra/test-rig/files.mjs): the rows K-05 v1.11's readTurnParty answers from, one handle for each of its nine accepted
// fixtures (contracts/data-access/fixtures/read-turn-party-*.json). The rig's globalSetup (infra/test-rig/rig.mjs) runs it
// once, in Node, on this file's database, after the migrations and bundle v0, with a client of the connecting login.
//
// One world, written once. Six of the nine fixtures ask about one number, Sam's, in six states of his rows that cannot
// stand in one database together (one company cannot both name the barbershop and name no business yet), the rig seeds a
// file's database once, and the Worker's logins may not delete a role or a company (db/migrations/0012 and 0019: no
// DELETE on person_roles or companies). So the four fixtures whose rows can stand together are seeded exactly, and the
// other five each stand on a handle, a person and businesses of their own, in their fixture's shape: the rows its note
// lists, under this file's ids. What differs from the fixture is each one's number, ids and names, and nothing the read
// decides by (which roles are live, which company names which business, who holds a business's live owner role). The
// fixtures' own values are proved on the database side by K-05's contract test (tests/contract; T-1270) and db/repo's
// own (db/repo/turn-party.int.test.ts; T-1269).
//
//   exactly, the fixture's own request and answer:
//     read-turn-party-test-owner-1   test owner 1 as db/seeds/skeleton.ts writes him (T-1148's SKELETON_ROWS): Sam, his
//                                    handle at tp-01's number, their link, and his one company, which names Lee's
//                                    Barbershop; no role. The turn runs under the barbershop.
//     read-turn-party-one-role       Riley as K-04's seed-person-roles.json holds Riley, value for value: the person, the
//                                    handle, their link and the one live role, staff at Lee's Barbershop. A staff role is
//                                    no owner role, so test owner 1's answer stands beside it.
//     read-turn-party-first-text     a number Rosie has never seen, as its fixture's `after` step leaves it
//                                    (handle-key-first-sight.json's request, run by db/repo's own handleSealingKeyIn): a
//                                    handle, a person with no name and their link; no role and no company.
//     read-turn-party-unknown        its number: no row at all.
//   in the fixture's shape, on this file's own ids (STAND_INS below):
//     read-turn-party-sign-up-before-business   one person who owns two companies, neither with a business yet.
//     read-turn-party-several-businesses        one person with three live owner roles at three businesses, no company.
//     read-turn-party-several-companies         one person with no role who owns two companies, each naming a business.
//     read-turn-party-handed-over               one person with no role whose one company names a business whose live
//                                               owner role another person holds, who writes from no handle here.
//     read-turn-party-owner-role-ended          one person whose one company names a business where their owner role
//                                               ended (S11-100's handover time) and no one holds the live owner role.
//
// It writes as the other seeds do: the skeleton set by its own seed, then every other row in one transaction as the
// runtime side's role, rosie_job, with no business scope, through its own grants and policies. Nothing is updated or
// deleted. Test values only (rule 9): the master's sample cast as the fixtures hold it, made-up ids and names,
// fiction-range 555-01xx numbers, and a made-up wrapping key that wraps nothing but one throwaway data key.
//
// The skeleton seed is loaded inside seed() and never at the top of this file: it reads fixture files through Node's own
// modules (db/seeds/lib/fixture-set.ts), and the test file, which runs in the Workers runtime, imports this file's
// constants.
import keyFirstSight from "../../../../contracts/data-access/fixtures/handle-key-first-sight.json";
import seedPersonRoles from "../../../../contracts/db-schema/core/fixtures/seed-person-roles.json";
import { handleSealingKeyIn, type HandleSealingKeyRequest } from "../../../../db/repo/handle-keys";
import { SCOPE_SETTING, type Sql, type Tx } from "../../../../db/repo/scope";

/** A handle of this file's own that stands in a fixture's shape: the fixture, the handle a text from it carries, its ids. */
export interface StandIn {
  /** The K-05 v1.11 fixture whose shape its rows have. */
  readonly fixture: string;
  /** Its handle as K-06 writes one (a fiction-range number). */
  readonly handle: { readonly kind: "phone"; readonly address: string };
  /** Its K-04 handle id, and the one person who writes from it. */
  readonly handleId: string;
  readonly personId: string;
}

/** Sam between S1-04 and S1-09: two companies, neither with a business yet. */
export const SIGNING_UP: StandIn = {
  fixture: "read-turn-party-sign-up-before-business.json",
  handle: { kind: "phone", address: "+15555550171" },
  handleId: "handle-t1400-signing-up",
  personId: "person-t1400-signing-up",
};

/** Sam as K-04's seed-person-roles.json holds him: three live owner roles at three businesses, and no company. */
export const THREE_ROLES: StandIn = {
  fixture: "read-turn-party-several-businesses.json",
  handle: { kind: "phone", address: "+15555550172" },
  handleId: "handle-t1400-three-roles",
  personId: "person-t1400-three-roles",
};

/** A person with no role who owns two companies, each a business of its own. */
export const TWO_COMPANIES: StandIn = {
  fixture: "read-turn-party-several-companies.json",
  handle: { kind: "phone", address: "+15555550173" },
  handleId: "handle-t1400-two-companies",
  personId: "person-t1400-two-companies",
};

/** S11-100's old owner after the hand-over: the company still names them, and another person holds the live owner role. */
export const HANDED_OVER: StandIn = {
  fixture: "read-turn-party-handed-over.json",
  handle: { kind: "phone", address: "+15555550174" },
  handleId: "handle-t1400-old-owner",
  personId: "person-t1400-old-owner",
};

/** S11-100's old owner once their owner role has ended, before a new owner holds it. */
export const ROLE_ENDED: StandIn = {
  fixture: "read-turn-party-owner-role-ended.json",
  handle: { kind: "phone", address: "+15555550175" },
  handleId: "handle-t1400-role-ended",
  personId: "person-t1400-role-ended",
};

/** The five handles that stand in a fixture's shape, in the README's order of cases. */
export const STAND_INS: readonly StandIn[] = [
  SIGNING_UP,
  THREE_ROLES,
  TWO_COMPANIES,
  HANDED_OVER,
  ROLE_ENDED,
];

/** The businesses the stand-ins' roles and companies name: none is ever a party's, and none is Lee's Barbershop. */
export const STAND_IN_BUSINESSES = {
  threeRoles: ["biz-t1400-roles-a", "biz-t1400-roles-b", "biz-t1400-roles-c"],
  twoCompanies: ["biz-t1400-companies-a", "biz-t1400-companies-b"],
  handedOver: "biz-t1400-handed-over",
  roleEnded: "biz-t1400-role-ended",
} as const;

/** The hand-over's new owner: a person who writes from no handle of this file. */
export const NEW_OWNER_PERSON = "person-t1400-new-owner";

/** S11-100's handover time (read-turn-party-owner-role-ended.json: Mon Nov 30 at 9:00am in New York). */
export const HANDOVER_AT = "2026-11-30T14:00:00Z";

/** The stand-in businesses' zone: not the barbershop's, so a zone answered is seen to be the party's own business's. */
const STAND_IN_ZONE = "America/Chicago";

/** A made-up wrapping key for the first text's key row: 32 bytes of 0x2c as base64, never a key of anything else. */
const SEED_WRAP_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(44)));

type Cell = string | number | null;

/** The one row of K-04's seed-person-roles.json with this table whose `column` holds `value`, value for value. */
function k04Row(table: string, column: string, value: string): Record<string, Cell> {
  const row = seedPersonRoles.rows.find(
    (each) => each.table === table && (each.values as Record<string, Cell>)[column] === value,
  );
  if (row === undefined) throw new Error(`K-04's seed-person-roles.json holds no ${table} row for the seed`);
  return { ...(row.values as Record<string, Cell>) };
}

async function insert(tx: Tx, table: string, values: Record<string, Cell>): Promise<void> {
  await tx`insert into ${tx(table)} ${tx(values)}`;
}

/** A stand-in's person (no name), its phone handle and their link. */
async function insertStandIn(tx: Tx, standIn: StandIn): Promise<void> {
  await insert(tx, "persons", { id: standIn.personId, name: null, language: null });
  await insert(tx, "handles", {
    id: standIn.handleId,
    kind: standIn.handle.kind,
    address: standIn.handle.address,
  });
  await insert(tx, "person_handles", { person_id: standIn.personId, handle_id: standIn.handleId });
}

async function insertBusiness(tx: Tx, id: string): Promise<void> {
  await insert(tx, "businesses", {
    id,
    name: "T-1400 example business",
    display_name: "T-1400 example business",
    status: "saved",
    time_zone: STAND_IN_ZONE,
  });
}

/** A company and the business it names (null: none yet), at the version its fixture's note gives such a row. */
async function insertCompany(
  tx: Tx,
  id: string,
  ownerPersonId: string,
  businessId: string | null,
): Promise<void> {
  await insert(tx, "companies", {
    id,
    owner_person_id: ownerPersonId,
    name: "T-1400 example company LLC",
    business_id: businessId,
    version: businessId === null ? 1 : 2,
  });
}

/** Seeds this file's database (see the top of this file). */
export async function seed(sql: Sql): Promise<void> {
  const { seedSkeleton } = await import("../../../../db/seeds/skeleton");
  // read-turn-party-test-owner-1: T-1148's SKELETON_ROWS, by its own seed.
  await seedSkeleton(sql);
  await sql.begin(async (tx) => {
    await tx.unsafe("set local role rosie_job");
    // The runtime side runs with no business scope (K-05 "Scope"); '' reads as none, as an unset scope does.
    await tx`select set_config(${SCOPE_SETTING}, '', true)`;

    // read-turn-party-one-role: Riley's four rows of K-04's seed-person-roles.json.
    await insert(tx, "persons", k04Row("persons", "id", "person-riley"));
    await insert(tx, "handles", k04Row("handles", "id", "handle-riley"));
    await insert(tx, "person_handles", k04Row("person_handles", "person_id", "person-riley"));
    await insert(tx, "person_roles", k04Row("person_roles", "id", "role-riley-barber"));

    // read-turn-party-first-text: its `after` step, handle-key-first-sight.json's request as it stands, under a made-up
    // wrapping key. It writes the handle, a person with no name and their link (and that person's key, which this
    // file's read never reads).
    const firstSight = await handleSealingKeyIn(
      tx,
      { resolve: (name) => (name === keyFirstSight.request.wrappingKeyName ? SEED_WRAP_KEY : undefined) },
      keyFirstSight.request as HandleSealingKeyRequest,
    );
    const { created } = firstSight.outcome;
    if (!created.handle || !created.person) {
      throw new Error("the seed did not write the first text's handle and person");
    }

    // read-turn-party-sign-up-before-business, in its shape: two companies with no business yet.
    await insertStandIn(tx, SIGNING_UP);
    await insertCompany(tx, "company-t1400-signing-up-a", SIGNING_UP.personId, null);
    await insertCompany(tx, "company-t1400-signing-up-b", SIGNING_UP.personId, null);

    // read-turn-party-several-businesses, in its shape: three live owner roles, no company.
    await insertStandIn(tx, THREE_ROLES);
    for (const businessId of STAND_IN_BUSINESSES.threeRoles) {
      await insertBusiness(tx, businessId);
      await insert(tx, "person_roles", {
        id: `role-${businessId}`,
        person_id: THREE_ROLES.personId,
        business_id: businessId,
        role: "owner",
        version: 1,
      });
    }

    // read-turn-party-several-companies, in its shape: no role, two companies, each naming a business of its own.
    await insertStandIn(tx, TWO_COMPANIES);
    for (const businessId of STAND_IN_BUSINESSES.twoCompanies) {
      await insertBusiness(tx, businessId);
      await insertCompany(tx, `company-${businessId}`, TWO_COMPANIES.personId, businessId);
    }

    // read-turn-party-handed-over, in its shape: the old owner's company still names the business, whose live owner
    // role the new owner holds.
    await insertStandIn(tx, HANDED_OVER);
    await insertBusiness(tx, STAND_IN_BUSINESSES.handedOver);
    await insertCompany(
      tx,
      "company-t1400-handed-over",
      HANDED_OVER.personId,
      STAND_IN_BUSINESSES.handedOver,
    );
    await insert(tx, "persons", { id: NEW_OWNER_PERSON, name: null, language: null });
    await insert(tx, "person_roles", {
      id: "role-t1400-new-owner",
      person_id: NEW_OWNER_PERSON,
      business_id: STAND_IN_BUSINESSES.handedOver,
      role: "owner",
      version: 1,
    });

    // read-turn-party-owner-role-ended, in its shape: the company still names the business, where the person's owner
    // role ended at the handover time and no one holds the live owner role.
    await insertStandIn(tx, ROLE_ENDED);
    await insertBusiness(tx, STAND_IN_BUSINESSES.roleEnded);
    await insertCompany(tx, "company-t1400-role-ended", ROLE_ENDED.personId, STAND_IN_BUSINESSES.roleEnded);
    await insert(tx, "person_roles", {
      id: "role-t1400-role-ended",
      person_id: ROLE_ENDED.personId,
      business_id: STAND_IN_BUSINESSES.roleEnded,
      role: "owner",
      ended_at: HANDOVER_AT,
      version: 2,
    });
  });
}
