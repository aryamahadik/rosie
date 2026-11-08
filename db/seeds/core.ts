// T-200: the core seed (C-155; K-04 v1 core; build prompt rule 9). From fixture set v1's 243 demo shops plus
// test-mixed-A and test-mixed-B (fixtures/v1/test-kit/shops/), each shop's business head, its owner (a person with the
// owner role), and the owner's handle, handle link and phone row: 245 rows in each of six tables, with ids made from the
// shop's file name (lib/demo-shops.ts says which values each row takes and why). Setup seeds (services, hours, rules)
// are T-212 to T-215, after F14; customer seeds are T-217, after F15 (02-contracts section 10; QUESTIONS.md CQ-14).
//
//   const result = await seedCore(sql);   // result.tables.businesses: { rows: 245, inserted: 245, kept: 0 }
//
// In order, stopping at the first failure:
//   1. Opens fixtures/v1, refusing anything outside the repository's fixtures/ folder (lib/fixture-set.ts).
//   2. Checks the whole set against its sha256 manifest, fixtures/v1/MANIFEST.sha256 (T-002), and stops on any
//      mismatch before a row is written. Only the bytes that were hashed are parsed.
//   3. Writes every row in one transaction as the job role, rosie_job (T-191, migration 0012), with no business scope:
//      the runtime side, whose row-level security policies let it write every business's rows. It never bypasses them.
//      The connection's role must be able to SET ROLE rosie_job (a superuser locally; a member of rosie_job elsewhere).
//
// Idempotent: a row is inserted only when its primary key is free (ON CONFLICT DO NOTHING), and nothing is ever updated
// or deleted, so a second run writes nothing and leaves every row as it was, version included; a row that went missing
// is written again as the first run wrote it. A clash on any other key (a number or address another handle holds, a
// second live owner role) is an error, and the whole transaction rolls back. Nothing is printed: the caller (T-201's
// runner) prints the counts this returns.
import { SCOPE_SETTING, type Sql } from "../repo/scope";
import {
  type CoreSeedRows,
  coreRowsOf,
  FICTIONAL_MOBILE,
  readDemoShops,
  type SeededShop,
  SHOPS_DIR,
} from "./lib/demo-shops";
import { filesUnder, type FixtureSet, openFixtureSet, verifyFixtureSet } from "./lib/fixture-set";

/** The role the seed writes as: the runtime side (T-191). */
export const SEED_ROLE = "rosie_job";

export type CoreSeedTable = keyof CoreSeedRows;

export interface CoreSeedTableCount {
  /** Rows the seed holds for the table. */
  readonly rows: number;
  /** Rows this run wrote. */
  readonly inserted: number;
  /** Rows that were there already, left as they were. */
  readonly kept: number;
}

export interface CoreSeedResult {
  /** The database role that wrote the rows (current_user inside the seed's transaction). */
  readonly ranAs: string;
  /** The fixture set that was checked: its folder, its manifest's sha256 and how many files the manifest lists. */
  readonly fixtureSet: {
    readonly dir: string;
    readonly manifestSha256: string;
    readonly filesChecked: number;
  };
  readonly tables: Readonly<Record<CoreSeedTable, CoreSeedTableCount>>;
  /** One entry per shop, in code-point order of id: its fixture file and its sha256, and every key it seeded. */
  readonly shops: readonly SeededShop[];
}

export interface CoreSeedOptions {
  /** Fixture set v1's folder. Default fixtures/v1. Anything outside the repository's fixtures/ folder is refused. */
  fixturesDir?: string;
}

/** Seeds the demo shops' core rows from fixture set v1 (see the top of this file). */
export async function seedCore(sql: Sql, options: CoreSeedOptions = {}): Promise<CoreSeedResult> {
  return seedCoreFrom(sql, openFixtureSet(options.fixturesDir));
}

/** The entry every seed set exports under one name, so a runner finds a set by its file name (T-201). */
export const seed = seedCore;

/** seedCore, from a fixture set already opened (tests open a temporary copy of the set inside its own jail). */
export async function seedCoreFrom(sql: Sql, set: FixtureSet): Promise<CoreSeedResult> {
  const verified = verifyFixtureSet(set);
  const shops = readDemoShops(filesUnder(verified, SHOPS_DIR));
  if (shops.length === 0) {
    throw new Error(`the fixture set at ${verified.dir} has no demo shop under ${SHOPS_DIR}`);
  }
  const { rows, seeded } = coreRowsOf(shops);
  const notFictional = rows.phones.filter((phone) => !FICTIONAL_MOBILE.test(phone.number));
  if (notFictional.length > 0) {
    throw new Error(
      `refusing to write ${String(notFictional.length)} mobile(s) outside the fiction range 555-0100 to 555-0199`,
    );
  }

  const written = await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${SEED_ROLE}`);
    // The runtime side runs with no business scope (K-05 "Scope"); '' reads as none, as an unset scope does.
    await tx`select set_config(${SCOPE_SETTING}, '', true)`;
    const [who] = await tx<{ role: string }[]>`select current_user as role`;
    const businesses = await tx`
      insert into businesses ${tx(rows.businesses, "id", "name", "display_name", "time_zone")}
      on conflict (id) do nothing
    `;
    const persons = await tx`insert into persons ${tx(rows.persons, "id")} on conflict (id) do nothing`;
    const personRoles = await tx`
      insert into person_roles ${tx(rows.person_roles, "id", "person_id", "business_id", "role")}
      on conflict (id) do nothing
    `;
    const handles = await tx`
      insert into handles ${tx(rows.handles, "id", "kind", "address")}
      on conflict (id) do nothing
    `;
    const personHandles = await tx`
      insert into person_handles ${tx(rows.person_handles, "person_id", "handle_id")}
      on conflict (person_id, handle_id) do nothing
    `;
    const phones = await tx`
      insert into phones ${tx(rows.phones, "number", "handle_id")}
      on conflict (number) do nothing
    `;
    return {
      ranAs: who?.role ?? "",
      inserted: {
        businesses: businesses.count,
        persons: persons.count,
        person_roles: personRoles.count,
        handles: handles.count,
        person_handles: personHandles.count,
        phones: phones.count,
      },
    };
  });

  const count = (table: CoreSeedTable): CoreSeedTableCount => {
    const total = rows[table].length;
    const inserted = written.inserted[table];
    return { rows: total, inserted, kept: total - inserted };
  };
  return {
    ranAs: written.ranAs,
    fixtureSet: {
      dir: verified.dir,
      manifestSha256: verified.manifestSha256,
      filesChecked: verified.filesChecked,
    },
    tables: {
      businesses: count("businesses"),
      persons: count("persons"),
      person_roles: count("person_roles"),
      handles: count("handles"),
      person_handles: count("person_handles"),
      phones: count("phones"),
    },
    shops: seeded,
  };
}
