// T-1148: test owner 1's seed for D-017, the walking skeleton's one turn (C-202; ADR-013 sections 4, 6 and 7, new task
// 4; DL-330). Test owner 1 is K-21 v1 test-roster.json's tp-01: Sam, the master's sample owner (S1-01: "Sam writes to
// Rosie first"), at the fictional 555-0100. JOIN from that phone must be a first text: the handle's one person has no
// role, no open question, no booking and no phone row (K-05 v1.2 targets-first-text.json), so the guard finds no target
// and the frontier offers the sign-up door (K-02 v1.1 default 9), under the business head that phone is seeded for
// (K-09 README v1.5 default 130). The rows, with the fixtures' ids:
//   businesses      biz-lees-barbershop  K-04 v1 seed-business-head.json's row, value for value, version included, so
//                                        a database that holds that fixture (the given seed of K-09 v1.5's
//                                        build-frontier-s1-01.json) and one this seed made hold the same business head
//   persons         person-sam           the name K-04 seed-person-roles.json and K-02 v1.1 context-s1-01.json's writer
//                                        give him, Sam Lee; no language stored yet (K-02 v1.1 default 11)
//   handles         handle-sam           kind phone, at tp-01's number: K-04 seed-person-roles.json's handle-sam, the
//                                        number tests/e2e/skeleton's JOIN comes from
//   person_handles  Sam writes from that handle
//   companies       company-lees-barbershop
//                                        the barbershop's company, owned by Sam (T-1197; CQ-185): K-23 v1
//                                        seed-company-two-kinds.json's row for tp-01's business, value for value,
//                                        version included
//   company_kinds   company-lees-barbershop's barber
//                                        the barbershop's one kind of work, K-23's row likewise: fixture set v1's
//                                        barber shop, with its facts and no switch on in either flow
// The kind of work is here so turn 1's S1-02 row reads K-05 v1.6's businessSensitive as false (item 45: kinds of work,
// none lists sensitive), and is filled in its routine form, as K-09 v1.6's compose-input-s1-02-v1.6.json and T-1175's
// recording 4 have it; with none the read answers null, which the caller reads as on (K-05 open gap 47; DL-391). The
// guard reads no kind of work (K-05 v1.2 handleTargets), so JOIN stays a first text.
// Never seeded here: a role (K-04's seed-person-roles.json gives Sam three owner roles, and T-202's staging set plans a
// customer role for each test phone: either makes JOIN a turn with a target), an open question, a booking, a phone row
// (the number has none until turn 1 commits) and a sealing key (the gateway's handleSealingKey makes Sam's key at his
// first text: K-05 handle-key-person-no-key.json). No value is a real person's: the names are the master's sample cast
// (MC C6) and the number is in the fiction range 555-0100 to 555-0199 (rule 9).
//
//   const result = await seedSkeleton(sql);   // result.tables.handles: { rows: 1, inserted: 1, kept: 0 }
//
// In one transaction as the job role rosie_job with no business scope (T-191), as the core seed writes, stopping at the
// first failure: refuses when another handle holds tp-01's number; writes each row only when its primary key is free
// (ON CONFLICT DO NOTHING; nothing is updated or deleted; a clash on any other key, such as another company already
// holding the barbershop, is an error that rolls the whole transaction back); then reads tp-01's handle as the guard
// does (K-05 v1.2 handleTargets, db/repo/targets.ts) and refuses, rolling the whole transaction back, unless that handle
// holds tp-01's number and the guard would find a first text: test owner 1 alone, with no live role, no live open
// question, no booking and no phone row. So this set is loaded in place of K-04's seed-person-roles.json and of any
// other row for tp-01, never on top of them; and once a turn from tp-01 has committed it refuses to run again (S1-02's
// question waits for Sam's answer), since only a fresh schema makes his JOIN a first text again. Otherwise idempotent:
// a second run writes nothing and leaves every row as it was, version included; a row that went missing is written
// again as the first run wrote it. Nothing is printed, and no error names a value of a row: the caller (T-201's runner)
// prints the counts this returns.
//
// D-017's run loads, in order: db/seeds/core.ts (T-200's demo shops, which share no id or number with this set), then
// this set.
//
// tp-01's roster id, its handle's id and the handle's number are the roster's list's (lib/roster.ts, T-1302; K-05 v1.12
// default 106), the one list the test-phone page's roster reads too, so the page and this seed cannot drift.
import { SCOPE_SETTING, type Sql, type Tx } from "../repo/scope";
import { handleTargetsIn } from "../repo/targets";
import { type CoreSeedTableCount, SEED_ROLE } from "./core";
import { FICTIONAL_MOBILE } from "./lib/demo-shops";
import { TEST_OWNER_1_PHONE } from "./lib/roster";

/** Test owner 1 (K-21 v1 test-roster.json tp-01) by the fixtures' ids, never by the number. */
export const TEST_OWNER_1 = {
  testPhoneId: TEST_OWNER_1_PHONE.testPhoneId,
  businessId: "biz-lees-barbershop",
  personId: "person-sam",
  handleId: TEST_OWNER_1_PHONE.handleId,
} as const;

export interface SkeletonBusinessRow {
  readonly id: string;
  readonly name: string;
  readonly display_name: string;
  readonly status: "offline" | "saved" | "live";
  readonly time_zone: string;
  readonly text_hours_start: string;
  readonly text_hours_end: string;
  readonly version: number;
}

export interface SkeletonPersonRow {
  readonly id: string;
  readonly name: string;
  /** None stored yet: a first text's writer (K-02 v1.1 default 11). */
  readonly language: null;
}

export interface SkeletonHandleRow {
  readonly id: string;
  readonly kind: "phone";
  readonly address: string;
}

export interface SkeletonPersonHandleRow {
  readonly person_id: string;
  readonly handle_id: string;
}

/** K-23 v1 companies: a company and the business it is (one company is one business, B10). */
export interface SkeletonCompanyRow {
  readonly id: string;
  readonly owner_person_id: string;
  readonly name: string;
  readonly business_id: string;
  readonly version: number;
}

/** K-23 v1 company_kinds: a kind of work of a company, its facts and the plug-in switches on in each flow. */
export interface SkeletonCompanyKindRow {
  readonly company_id: string;
  readonly kind_id: string;
  readonly business_id: string;
  readonly trade_name: string | null;
  readonly pf_facts: readonly string[];
  /** Never K-26's sensitive here: the barbershop's switch reads off (K-05 v1.6 item 45). */
  readonly pf_switches_a: readonly string[];
  readonly pf_switches_b: readonly string[];
  readonly version: number;
}

/** The set's rows, table by table, in the order their foreign keys need. */
export interface SkeletonSeedRows {
  readonly businesses: readonly SkeletonBusinessRow[];
  readonly persons: readonly SkeletonPersonRow[];
  readonly handles: readonly SkeletonHandleRow[];
  readonly person_handles: readonly SkeletonPersonHandleRow[];
  readonly companies: readonly SkeletonCompanyRow[];
  readonly company_kinds: readonly SkeletonCompanyKindRow[];
}

export type SkeletonSeedTable = keyof SkeletonSeedRows;

/** Every row this set writes (see the top of this file for each value's source). */
export const SKELETON_ROWS: SkeletonSeedRows = {
  businesses: [
    {
      id: TEST_OWNER_1.businessId,
      name: "Lee's Barbershop",
      display_name: "Lee's Barbershop",
      status: "live",
      time_zone: "America/New_York",
      text_hours_start: "08:00",
      text_hours_end: "20:00",
      version: 3,
    },
  ],
  persons: [{ id: TEST_OWNER_1.personId, name: "Sam Lee", language: null }],
  handles: [{ id: TEST_OWNER_1.handleId, kind: "phone", address: TEST_OWNER_1_PHONE.fakeNumber }],
  person_handles: [{ person_id: TEST_OWNER_1.personId, handle_id: TEST_OWNER_1.handleId }],
  companies: [
    {
      id: "company-lees-barbershop",
      owner_person_id: TEST_OWNER_1.personId,
      name: "Lee's Barbershop LLC",
      business_id: TEST_OWNER_1.businessId,
      version: 2,
    },
  ],
  company_kinds: [
    {
      company_id: "company-lees-barbershop",
      kind_id: "barber",
      business_id: TEST_OWNER_1.businessId,
      trade_name: null,
      pf_facts: ["children", "documents", "extrawork", "groups", "photos"],
      pf_switches_a: [],
      pf_switches_b: [],
      version: 1,
    },
  ],
};

export interface SkeletonSeedResult {
  /** The database role that wrote the rows (current_user inside the seed's transaction). */
  readonly ranAs: string;
  readonly tables: Readonly<Record<SkeletonSeedTable, CoreSeedTableCount>>;
  /** Whose first text the seed made ready, by id. */
  readonly testOwner: typeof TEST_OWNER_1;
}

/** The seed refused: tp-01's JOIN would not be a first text. Names no value of a row. Nothing was written. */
export class SkeletonSeedError extends Error {
  override readonly name = "SkeletonSeedError";
}

const WHERE_TO_LOAD =
  "load this set in place of K-04's seed-person-roles.json and of any other row for tp-01, never on top of them, " +
  "and after a turn from tp-01 only on a fresh schema";

const counted = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

/** The test owner's handle, the one row the guard reads tp-01's number by. */
function testOwnerHandle(rows: SkeletonSeedRows): SkeletonHandleRow {
  const handle = rows.handles.find((row) => row.id === TEST_OWNER_1.handleId);
  if (handle === undefined) {
    throw new Error("the skeleton seed has no row for test owner 1's handle");
  }
  return handle;
}

/** Refuses, before anything is written, when another handle already holds tp-01's number. */
async function refuseNumberOfAnotherHandle(tx: Tx, handle: SkeletonHandleRow): Promise<void> {
  const others = await tx<{ id: string }[]>`
    select id from handles where address = ${handle.address} and id <> ${handle.id}
  `;
  if (others.length > 0) {
    throw new SkeletonSeedError(
      `the skeleton seed refused, writing nothing: another handle holds tp-01's number, so JOIN from it would not ` +
        `reach test owner 1's handle; ${WHERE_TO_LOAD}`,
    );
  }
}

/**
 * Reads tp-01's handle as the guard does (K-05 v1.2 handleTargets, inside the seed's transaction, on the runtime side)
 * and refuses unless JOIN from it is a first text: the handle holds tp-01's number, and its one person, test owner 1,
 * has no live role, no live open question, no booking and no phone row (targets-first-text.json).
 */
async function requireFirstText(tx: Tx, handle: SkeletonHandleRow): Promise<void> {
  const problems: string[] = [];
  const [stored] = await tx<{ kind: string; address: string }[]>`
    select kind, address from handles where id = ${handle.id}
  `;
  if (stored?.kind !== handle.kind || stored.address !== handle.address) {
    problems.push("test owner 1's handle holds another number");
  }
  const targets = await handleTargetsIn(tx, { handleId: handle.id });
  if ("error" in targets) {
    problems.push("test owner 1's handle is missing");
  } else {
    const people = targets.persons.length;
    if (people !== 1 || targets.persons[0]?.personId !== TEST_OWNER_1.personId) {
      problems.push(`the handle has ${counted(people, "person", "people")}, not test owner 1 alone`);
    }
    const roles = targets.persons.reduce((sum, person) => sum + person.roles.length, 0);
    if (roles > 0) {
      problems.push(counted(roles, "live role", "live roles"));
    }
    if (targets.openQuestions.length > 0) {
      problems.push(counted(targets.openQuestions.length, "live open question", "live open questions"));
    }
    if (targets.bookings.length > 0) {
      problems.push(counted(targets.bookings.length, "booking", "bookings"));
    }
    if (targets.phone !== null) {
      problems.push("a phone row");
    }
  }
  if (problems.length > 0) {
    throw new SkeletonSeedError(
      `the skeleton seed refused, writing nothing: tp-01's JOIN would not be a first text ` +
        `(K-05 v1.2 targets-first-text.json): ${problems.join("; ")}; ${WHERE_TO_LOAD}`,
    );
  }
}

/** Seeds test owner 1's first text for D-017 (see the top of this file). */
export async function seedSkeleton(sql: Sql): Promise<SkeletonSeedResult> {
  const rows = SKELETON_ROWS;
  const handle = testOwnerHandle(rows);
  if (rows.handles.some((row) => !FICTIONAL_MOBILE.test(row.address))) {
    throw new SkeletonSeedError("refusing to write a mobile outside the fiction range 555-0100 to 555-0199");
  }

  const written = await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${SEED_ROLE}`);
    // The runtime side runs with no business scope (K-05 "Scope"); '' reads as none, as an unset scope does.
    await tx`select set_config(${SCOPE_SETTING}, '', true)`;
    const [who] = await tx<{ role: string }[]>`select current_user as role`;
    await refuseNumberOfAnotherHandle(tx, handle);
    const businesses = await tx`
      insert into businesses ${tx(
        rows.businesses,
        "id",
        "name",
        "display_name",
        "status",
        "time_zone",
        "text_hours_start",
        "text_hours_end",
        "version",
      )}
      on conflict (id) do nothing
    `;
    const persons = await tx`
      insert into persons ${tx(rows.persons, "id", "name", "language")} on conflict (id) do nothing
    `;
    const handles = await tx`
      insert into handles ${tx(rows.handles, "id", "kind", "address")} on conflict (id) do nothing
    `;
    const personHandles = await tx`
      insert into person_handles ${tx(rows.person_handles, "person_id", "handle_id")}
      on conflict (person_id, handle_id) do nothing
    `;
    const companies = await tx`
      insert into companies ${tx(rows.companies, "id", "owner_person_id", "name", "business_id", "version")}
      on conflict (id) do nothing
    `;
    const companyKinds = await tx`
      insert into company_kinds ${tx(
        rows.company_kinds,
        "company_id",
        "kind_id",
        "business_id",
        "trade_name",
        "pf_facts",
        "pf_switches_a",
        "pf_switches_b",
        "version",
      )}
      on conflict (company_id, kind_id) do nothing
    `;
    await requireFirstText(tx, handle);
    return {
      ranAs: who?.role ?? "",
      inserted: {
        businesses: businesses.count,
        persons: persons.count,
        handles: handles.count,
        person_handles: personHandles.count,
        companies: companies.count,
        company_kinds: companyKinds.count,
      },
    };
  });

  const count = (table: SkeletonSeedTable): CoreSeedTableCount => {
    const total = rows[table].length;
    const inserted = written.inserted[table];
    return { rows: total, inserted, kept: total - inserted };
  };
  return {
    ranAs: written.ranAs,
    tables: {
      businesses: count("businesses"),
      persons: count("persons"),
      handles: count("handles"),
      person_handles: count("person_handles"),
      companies: count("companies"),
      company_kinds: count("company_kinds"),
    },
    testOwner: TEST_OWNER_1,
  };
}

/** The entry every seed set exports under one name, so a runner finds a set by its file name (T-201). */
export const seed = seedSkeleton;
