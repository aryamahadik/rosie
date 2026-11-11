// T-202: staging's seeded state, its core rows (C-202; K-04 v1 core; build prompt 9.4 'Seeded state' and 'The test-phone
// page'; 02-contracts section 10 with CQ-14's default: C-202's M3 task seeds only K-04's core rows; QUESTIONS.md Q-54,
// Q-53 and NQ-DB-2; DL-341). T-201's runner runs it as `node db/seeds/run.mjs --set staging-core`. Table by table:
//   businesses      the ready-made test businesses: fixture set v1's demo shops (its 243 shops, test-mixed-A and
//                   test-mixed-B), each one's business head as the core seed (T-200) writes it, row for row
//                   (lib/demo-shops.ts: biz-demo-<shop>, the shop's own name, America/New_York by Q-54's default, status
//                   and text hours at the table's defaults). So this set alone makes them on a fresh schema, and after the
//                   core seed it keeps every one.
//   persons         person-<roster id>: one per test phone, name and language left null (null until known)
//   person_roles    role-<roster id>-customer: that person's customer role at fixture set v1's barber (biz-demo-barber),
//                   the shop K-21 v1 test-roster.json seats the roster's customer phones at ("fixture set v1's barber as
//                   Lee's Barbershop (flow A)")
//   handles         handle-<roster id>: kind phone, at the test phone's number
//   person_handles  the person writes from that handle
//   phones          the number's one row. Only the number and the handle are written, so every other column keeps the
//                   table's default: the chat is not open (chat_open false; chat_open_at and chat_way null), since a test
//                   phone's chat opens at its first text (CQ-194, T-1211); not stopped; no Linq contact add recorded.
//
// The test phones are K-21 v1 test-roster.json's (Q-53), by roster id (TEST_PHONES), less test owner 1, tp-01, which this
// set never seeds (DL-341): D-017's seed (skeleton.ts, T-1148) gives tp-01's handle a person with no role and no phone
// row, so its JOIN is a first text, and refuses to run on top of a role or a phone row for it.
//
// The numbers are personal data, so none is ever in the repository (NQ-DB-2's default). They are read at run time from
// the environment variable STAGING_TEST_PHONES on the build Mac: `<roster id>=<number>` entries separated by commas, each
// number in E.164 form (`tp-02=+1...,tp-03=+1...`), and only the phones it names are seeded. When it is unset or blank,
// every roster phone takes the fixed fake handle the test-phone page sends as (T-565, T-1186: +1 555 555 and the roster's
// last four digits, in the fiction range 555-0100 to 555-0199, the only numbers the Linq double signs as). No number is
// printed, put in an error or returned: a refusal names a roster id or an entry's place in the variable, nothing more.
//
//   const result = await seedStagingCore(sql);   // result.tables.phones: { rows: 4, inserted: 4, kept: 0 }
//
// In order, stopping at the first refusal, before anything is written: reads the variable, refusing an entry that is not
// `<roster id>=<number in E.164 form>`, names no roster phone, repeats a phone or a number, or gives another phone test
// owner 1's fake handle; opens and checks fixture set v1 against its manifest as the core seed does (lib/fixture-set.ts),
// so only bytes that were hashed are parsed; then, in one transaction as the job role rosie_job with no business scope
// (T-191), refuses when another handle holds a test phone's number, or a test phone's handle holds another number.
// Idempotent, as the core seed: a row is inserted only when its primary key is free (ON CONFLICT DO NOTHING), and nothing
// is updated or deleted, so a second run writes nothing and leaves every row as it was, version included; a row that went
// missing is written again as the first run wrote it; a test phone's number changes only on a fresh schema. A clash on
// any other key is an error, and the whole transaction rolls back. Nothing is printed: the runner prints the counts.
import { SCOPE_SETTING, type Sql, type Tx } from "../repo/scope";
import { type CoreSeedTableCount, SEED_ROLE } from "./core";
import {
  type BusinessSeedRow,
  coreRowsOf,
  type DemoShop,
  FICTIONAL_MOBILE,
  type HandleSeedRow,
  type PersonHandleSeedRow,
  type PersonSeedRow,
  type PhoneSeedRow,
  readDemoShops,
  SHOPS_DIR,
} from "./lib/demo-shops";
import { filesUnder, type FixtureSet, openFixtureSet, verifyFixtureSet } from "./lib/fixture-set";
import { TEST_OWNER_1 } from "./skeleton";

/** The environment variable on the build Mac that gives the test phones' numbers (NQ-DB-2's default). */
export const TEST_PHONES_VARIABLE = "STAGING_TEST_PHONES";

/** One phone of staging's test-phone roster, and the fixed fake handle the test-phone page sends as. */
export interface TestPhone {
  /** Its roster id (K-21 v1 test-roster.json testPhoneId): what the test-phone page names, never a number. */
  readonly testPhoneId: string;
  /** The number the test-phone page sends as: +1 555 555 and the roster's last four digits (the fiction range). */
  readonly fakeNumber: string;
}

/**
 * The roster, in K-21 v1 test-roster.json's order: tp-01 test owner 1, tp-02 test staff 1, tp-03 and tp-04 the two test
 * customers, tp-05 the one phone named for STOP tests.
 */
export const TEST_PHONES: readonly TestPhone[] = [
  { testPhoneId: "tp-01", fakeNumber: "+15555550100" },
  { testPhoneId: "tp-02", fakeNumber: "+15555550102" },
  { testPhoneId: "tp-03", fakeNumber: "+15555550101" },
  { testPhoneId: "tp-04", fakeNumber: "+15555550104" },
  { testPhoneId: "tp-05", fakeNumber: "+15555550105" },
];

/** The roster phones this set never seeds: test owner 1, whose rows are the skeleton seed's alone (DL-341). */
export const LEFT_OUT: readonly string[] = [TEST_OWNER_1.testPhoneId];

/** The demo shop whose business each test phone's person is a customer of (K-21 v1 test-roster.json). */
export const TEST_PHONE_SHOP = "barber";

/** The role each test phone's person holds there (CQ-14's default). */
export const TEST_PHONE_ROLE = "customer";

// K-04 handles_address_form for a phone, and phones_number_form: E.164.
const E164 = /^\+[1-9][0-9]{6,14}$/;
const ROSTER_IDS: readonly string[] = TEST_PHONES.map((phone) => phone.testPhoneId);
const ENTRY_FORM = "<roster id>=<number in E.164 form>";

export interface TestPhoneRoleSeedRow {
  readonly id: string;
  readonly person_id: string;
  readonly business_id: string;
  readonly role: typeof TEST_PHONE_ROLE;
}

/** The set's rows, table by table, in the order their foreign keys need. */
export interface StagingCoreSeedRows {
  readonly businesses: readonly BusinessSeedRow[];
  readonly persons: readonly PersonSeedRow[];
  readonly person_roles: readonly TestPhoneRoleSeedRow[];
  readonly handles: readonly HandleSeedRow[];
  readonly person_handles: readonly PersonHandleSeedRow[];
  readonly phones: readonly PhoneSeedRow[];
}

export type StagingCoreSeedTable = keyof StagingCoreSeedRows;

/** Where the numbers came from: the variable, or (it was unset or blank) the fixed fake handles. */
export type TestPhoneNumbersFrom = "variable" | "fakeHandles";

/** The test phones a run names, each with its number, in roster order; test owner 1 among them when named. */
export interface TestPhoneNumbers {
  readonly from: TestPhoneNumbersFrom;
  readonly phones: readonly { readonly testPhoneId: string; readonly number: string }[];
}

/** A test phone as seeded: its roster id and every key written for it, never its number. */
export interface SeededTestPhone {
  readonly testPhoneId: string;
  readonly personId: string;
  readonly roleId: string;
  readonly handleId: string;
  readonly businessId: string;
}

export interface StagingCoreSeedResult {
  /** The database role that wrote the rows (current_user inside the seed's transaction). */
  readonly ranAs: string;
  /** The fixture set that was checked: its folder, its manifest's sha256 and how many files the manifest lists. */
  readonly fixtureSet: {
    readonly dir: string;
    readonly manifestSha256: string;
    readonly filesChecked: number;
  };
  readonly tables: Readonly<Record<StagingCoreSeedTable, CoreSeedTableCount>>;
  readonly numbersFrom: TestPhoneNumbersFrom;
  /** One entry per test phone seeded, in roster order. */
  readonly testPhones: readonly SeededTestPhone[];
}

export interface StagingCoreSeedOptions {
  /** Where STAGING_TEST_PHONES is read. Default process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Fixture set v1's folder. Default fixtures/v1. Anything outside the repository's fixtures/ folder is refused. */
  fixturesDir?: string;
}

/** The seed refused, writing nothing. Its message names no number and no part of the variable's value. */
export class StagingCoreSeedError extends Error {
  override readonly name = "StagingCoreSeedError";
}

const refused = (why: string): StagingCoreSeedError =>
  new StagingCoreSeedError(`the staging core seed refused, writing nothing: ${why}`);

const variableRefused = (why: string): StagingCoreSeedError =>
  refused(`${TEST_PHONES_VARIABLE} ${why} (no part of its value is shown)`);

/**
 * The test phones STAGING_TEST_PHONES names, each with its number, in roster order (NQ-DB-2's default); unset or blank,
 * every roster phone with its fixed fake handle. Refuses, naming an entry by its place only: an entry that is not
 * `<roster id>=<number in E.164 form>`, a roster id that is not on the roster, a phone or a number named twice, and test
 * owner 1's fake handle given to another phone.
 */
export function testPhoneNumbers(value: string | undefined): TestPhoneNumbers {
  if (value === undefined || value.trim() === "") {
    return {
      from: "fakeHandles",
      phones: TEST_PHONES.map((phone) => ({ testPhoneId: phone.testPhoneId, number: phone.fakeNumber })),
    };
  }
  const named = new Map<string, { readonly number: string; readonly place: number }>();
  const placeOfNumber = new Map<string, number>();
  for (const [index, entry] of value.split(",").entries()) {
    const place = String(index + 1);
    const at = entry.indexOf("=");
    const id = at < 0 ? "" : entry.slice(0, at).trim();
    const number = at < 0 ? "" : entry.slice(at + 1).trim();
    if (id === "" || number === "") {
      throw variableRefused(`entry ${place} is not ${ENTRY_FORM} (entries are separated by commas)`);
    }
    if (!ROSTER_IDS.includes(id)) {
      throw variableRefused(`entry ${place} names no phone on the roster (${ROSTER_IDS.join(", ")})`);
    }
    if (!E164.test(number)) {
      throw variableRefused(
        `entry ${place} gives a number not in E.164 form (a + and 7 to 15 digits, no spaces)`,
      );
    }
    const before = named.get(id);
    if (before !== undefined) {
      throw variableRefused(`names ${id} twice (entries ${String(before.place)} and ${place})`);
    }
    const sameNumber = placeOfNumber.get(number);
    if (sameNumber !== undefined) {
      throw variableRefused(`entries ${String(sameNumber)} and ${place} give the same number`);
    }
    const leftOutPhone = TEST_PHONES.find(
      (phone) => phone.fakeNumber === number && LEFT_OUT.includes(phone.testPhoneId),
    );
    if (leftOutPhone !== undefined && leftOutPhone.testPhoneId !== id) {
      throw variableRefused(
        `entry ${place} gives ${id} the fake handle of ${leftOutPhone.testPhoneId}, test owner 1, which only the ` +
          "skeleton seed writes (DL-341)",
      );
    }
    named.set(id, { number, place: index + 1 });
    placeOfNumber.set(number, index + 1);
  }
  return {
    from: "variable",
    phones: TEST_PHONES.flatMap((phone) => {
      const given = named.get(phone.testPhoneId);
      return given === undefined ? [] : [{ testPhoneId: phone.testPhoneId, number: given.number }];
    }),
  };
}

/** The test businesses' rows and each test phone's, test owner 1 left out (see the top of this file). */
export function stagingCoreRowsOf(
  shops: readonly DemoShop[],
  numbers: TestPhoneNumbers,
): { rows: StagingCoreSeedRows; testPhones: SeededTestPhone[] } {
  const core = coreRowsOf(shops);
  const shop = core.seeded.find((seeded) => seeded.shopId === TEST_PHONE_SHOP);
  if (shop === undefined) {
    throw new Error(
      `the fixture set has no ${TEST_PHONE_SHOP} shop under ${SHOPS_DIR}, whose business the test phones are customers of`,
    );
  }
  const pairs = numbers.phones
    .filter((phone) => !LEFT_OUT.includes(phone.testPhoneId))
    .map((phone) => {
      const seeded: SeededTestPhone = {
        testPhoneId: phone.testPhoneId,
        personId: `person-${phone.testPhoneId}`,
        roleId: `role-${phone.testPhoneId}-${TEST_PHONE_ROLE}`,
        handleId: `handle-${phone.testPhoneId}`,
        businessId: shop.businessId,
      };
      return { number: phone.number, seeded };
    });
  return {
    rows: {
      businesses: core.rows.businesses,
      persons: pairs.map(({ seeded }) => ({ id: seeded.personId })),
      person_roles: pairs.map(({ seeded }): TestPhoneRoleSeedRow => ({
        id: seeded.roleId,
        person_id: seeded.personId,
        business_id: seeded.businessId,
        role: TEST_PHONE_ROLE,
      })),
      handles: pairs.map(({ number, seeded }): HandleSeedRow => ({
        id: seeded.handleId,
        kind: "phone",
        address: number,
      })),
      person_handles: pairs.map(({ seeded }) => ({ person_id: seeded.personId, handle_id: seeded.handleId })),
      phones: pairs.map(({ number, seeded }) => ({ number, handle_id: seeded.handleId })),
    },
    testPhones: pairs.map(({ seeded }) => seeded),
  };
}

/** Seeds staging's core rows: the test businesses and each test phone's (see the top of this file). */
export async function seedStagingCore(
  sql: Sql,
  options: StagingCoreSeedOptions = {},
): Promise<StagingCoreSeedResult> {
  const numbers = testPhoneNumbers((options.env ?? process.env)[TEST_PHONES_VARIABLE]);
  return seedStagingCoreFrom(sql, openFixtureSet(options.fixturesDir), numbers);
}

/** The entry every seed set exports under one name, so a runner finds a set by its file name (T-201). */
export const seed = seedStagingCore;

/**
 * Refuses, before anything is written, when another handle holds a test phone's number or a test phone's handle holds
 * another number: each number is one handle's (K-04 handles_address_key), and this set never updates a row.
 */
async function refuseClashes(
  tx: Tx,
  testPhones: readonly SeededTestPhone[],
  handles: readonly HandleSeedRow[],
): Promise<void> {
  if (handles.length === 0) {
    return;
  }
  const found = await tx<{ id: string; address: string }[]>`
    select id, address from handles
    where id in ${tx(handles.map((handle) => handle.id))}
       or address in ${tx(handles.map((handle) => handle.address))}
  `;
  const problems: string[] = [];
  for (const handle of handles) {
    const testPhoneId = testPhones.find((phone) => phone.handleId === handle.id)?.testPhoneId ?? handle.id;
    if (found.some((row) => row.id === handle.id && row.address !== handle.address)) {
      problems.push(`${testPhoneId}'s handle holds another number`);
    }
    if (found.some((row) => row.id !== handle.id && row.address === handle.address)) {
      problems.push(`another handle holds ${testPhoneId}'s number`);
    }
  }
  if (problems.length > 0) {
    throw refused(
      `${problems.join("; ")}; each number is one handle's, and this set never updates a row, so a test phone's ` +
        "number changes only on a fresh schema",
    );
  }
}

/** seedStagingCore, from a fixture set already opened (tests open a temporary copy of the set inside its own jail). */
export async function seedStagingCoreFrom(
  sql: Sql,
  set: FixtureSet,
  numbers: TestPhoneNumbers,
): Promise<StagingCoreSeedResult> {
  const verified = verifyFixtureSet(set);
  const shops = readDemoShops(filesUnder(verified, SHOPS_DIR));
  if (shops.length === 0) {
    throw new Error(`the fixture set at ${verified.dir} has no demo shop under ${SHOPS_DIR}`);
  }
  const { rows, testPhones } = stagingCoreRowsOf(shops, numbers);
  if (numbers.from === "fakeHandles" && rows.phones.some((phone) => !FICTIONAL_MOBILE.test(phone.number))) {
    throw refused("a fake handle lies outside the fiction range 555-0100 to 555-0199");
  }
  // postgres.js makes no statement of an empty list: a run that seeds no test phone writes none of their tables.
  const written = async (count: number, insert: () => Promise<{ count: number }>): Promise<number> =>
    count === 0 ? 0 : (await insert()).count;

  const result = await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${SEED_ROLE}`);
    // The runtime side runs with no business scope (K-05 "Scope"); '' reads as none, as an unset scope does.
    await tx`select set_config(${SCOPE_SETTING}, '', true)`;
    const [who] = await tx<{ role: string }[]>`select current_user as role`;
    await refuseClashes(tx, testPhones, rows.handles);
    const businesses = await written(
      rows.businesses.length,
      () => tx`
        insert into businesses ${tx(rows.businesses, "id", "name", "display_name", "time_zone")}
        on conflict (id) do nothing
      `,
    );
    const persons = await written(
      rows.persons.length,
      () => tx`insert into persons ${tx(rows.persons, "id")} on conflict (id) do nothing`,
    );
    const personRoles = await written(
      rows.person_roles.length,
      () => tx`
        insert into person_roles ${tx(rows.person_roles, "id", "person_id", "business_id", "role")}
        on conflict (id) do nothing
      `,
    );
    const handles = await written(
      rows.handles.length,
      () => tx`insert into handles ${tx(rows.handles, "id", "kind", "address")} on conflict (id) do nothing`,
    );
    const personHandles = await written(
      rows.person_handles.length,
      () => tx`
        insert into person_handles ${tx(rows.person_handles, "person_id", "handle_id")}
        on conflict (person_id, handle_id) do nothing
      `,
    );
    // The number and its handle only: chat_open, chat_open_at, chat_way and the rest keep the table's defaults.
    const phones = await written(
      rows.phones.length,
      () => tx`insert into phones ${tx(rows.phones, "number", "handle_id")} on conflict (number) do nothing`,
    );
    return {
      ranAs: who?.role ?? "",
      inserted: {
        businesses,
        persons,
        person_roles: personRoles,
        handles,
        person_handles: personHandles,
        phones,
      },
    };
  });

  const count = (table: StagingCoreSeedTable): CoreSeedTableCount => {
    const total = rows[table].length;
    const inserted = result.inserted[table];
    return { rows: total, inserted, kept: total - inserted };
  };
  return {
    ranAs: result.ranAs,
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
    numbersFrom: numbers.from,
    testPhones,
  };
}
