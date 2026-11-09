// T-217: the customers seed from fixture set v1, against local PostgreSQL (`npm run db:up`;
// `npm run test:integration -- db/seeds/customers`). Each top-level block that needs the database migrates a fresh test
// schema of its own (db/repo/test-db.ts), runs the core and setup seeds (T-200, T-213) where it needs their rows, and
// drops the schema at the end; the shared public schema is never touched.
//
// The card's proofs: every seeded customer has a mobile; none has 'calls only'; re-running is idempotent. Beside them,
// the lead's: each customer comes with its customer role in the same commit (K-28 rule 7); no real phone number is
// committed (a grep test over the seed code and the shop files it reads, and over every phone row written); no email
// address or name comes from a fixture; the cast is never parsed (MC C6); it refuses before the core and setup seeds.
// Each expected row is built here, column by column, from the fixture files themselves (node:fs and node:crypto), never
// through the seed's own reader, and compared with the whole row the database holds. The wrapping key the setup seed
// seals the owners' ID uploads with is made here from random bytes for each run and is never written to a file or
// printed. Bytes are changed only in temporary copies of fixtures/v1 in the OS temp folder.
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_WRAPPING_KEY_NAME, type WrappingKeys } from "../repo/sealing";
import { type Sql, type Tx, withBusiness } from "../repo/scope";
import { createTestDatabase, type TestDatabase } from "../repo/test-db";
import { seedCore } from "./core";
import {
  CUSTOMER_AREA_CODES,
  type CustomerSeedResult,
  customersPlanOf,
  DEMO_CUSTOMER_WAYS,
  seedCustomers,
  seedCustomersFrom,
} from "./customers";
import { FICTIONAL_AREA_CODES } from "./lib/demo-shops";
import {
  FixtureAccessError,
  FixtureChecksumError,
  openFixtureSet,
  verifyFixtureSet,
} from "./lib/fixture-set";
import { seedSetupBusiness } from "./setup-business";
import { STAFF_AREA_CODES } from "./setup-staff";

const SLOW = { timeout: 120_000 };
const REPO = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const V1 = path.join(REPO, "fixtures/v1");
const SHOPS = "test-kit/shops";
const TABLES = ["persons", "handles", "person_handles", "phones", "person_roles", "customers"] as const;
// K-28 v1's ways (customers_way_known: "way is null or way in ('texts', 'textsonly', 'email')"), in the reach card's
// order (A4-82: Texts, Calls only, Texts only, Email) with calls only left out (Q-07).
const WAYS = ["texts", "textsonly", "email"] as const;
const CALLS_ONLY = "callsonly";
// The fiction range: 555-0100 to 555-0199 in an area code, as E.164 (NANP keeps it for fiction).
const FICTIONAL = /^\+1[2-9][0-9]{2}55501[0-9]{2}$/;
// Anything written like a North American phone number: +1 optional, then area code, exchange and line, with or
// without spaces, dots, dashes or brackets, and no letter or digit straight before or after it.
const PHONE_LIKE = /(?<![\w+])(?:\+?1[\s.-]?)?\(?[2-9][0-9]{2}\)?[\s.-]?[0-9]{3}[\s.-]?[0-9]{4}(?!\w)/g;

/** One wrapping key per run for the setup seed's ID uploads: random, in memory only, under the Workers secret's name. */
const WRAP_BYTES = crypto.getRandomValues(new Uint8Array(32));
const KEYS: WrappingKeys = {
  resolve: (name) => (name === DEFAULT_WRAPPING_KEY_NAME ? WRAP_BYTES : undefined),
};

const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
const sorted = (values: Iterable<string>): string[] => [...values].sort();

/** fixtures/v1/MANIFEST.sha256, read here: path to sha256. */
function manifest(): Map<string, string> {
  const listed = new Map<string, string>();
  for (const line of readFileSync(path.join(V1, "MANIFEST.sha256"), "utf8").split("\n")) {
    const match = /^([0-9a-f]{64}) {2}(\S.*)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      listed.set(match[2], match[1]);
    }
  }
  return listed;
}

/**
 * The demo shops' ids, read here from their files' names, in code-point order of id (the ids, not the file names:
 * "hair" comes before "hair-restoration", while "hair-restoration.json" comes first).
 */
function shopIds(): string[] {
  return sorted(
    readdirSync(path.join(V1, SHOPS))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length)),
  );
}

const SHOP_IDS = shopIds();
const LISTED = manifest();

interface Expected {
  shopId: string;
  position: number;
  way: (typeof WAYS)[number];
  customerId: string;
  personId: string;
  roleId: string;
  handleId: string;
  number: string;
  email: { handleId: string; address: string } | null;
}

/** Every customer the seed should write, in its order, with the fictional mobile each one takes. */
function expectedCustomers(): Expected[] {
  const customers: Expected[] = [];
  for (const shopId of SHOP_IDS) {
    WAYS.forEach((way, offset) => {
      const index = customers.length;
      const position = offset + 1;
      const key = `${shopId}-customer-${String(position)}`;
      const customerId = `customer-demo-${shopId}-${String(position)}`;
      const areaCode = CUSTOMER_AREA_CODES[Math.floor(index / 100)] ?? "none";
      customers.push({
        shopId,
        position,
        way,
        customerId,
        personId: `person-demo-${key}`,
        roleId: `role-demo-${key}`,
        handleId: `handle-demo-${key}`,
        number: `+1${areaCode}55501${String(index % 100).padStart(2, "0")}`,
        email:
          way === "email"
            ? { handleId: `handle-demo-${key}-email`, address: `${customerId.toLowerCase()}@example.com` }
            : null,
      });
    });
  }
  return customers;
}

const EXPECTED = expectedCustomers();

/**
 * When fixture set v1 was made: line 3 of test-kit/COVERAGE.md, Eastern time (fixtures/v1/README.md), turned into an
 * instant by PostgreSQL (the seed does it with Intl). The text cast keeps the client from parsing the wall time itself.
 */
async function fixtureSetMade(sql: Sql): Promise<Date> {
  const line = readFileSync(path.join(V1, "test-kit/COVERAGE.md"), "utf8").split("\n")[2] ?? "";
  const match = /^Generated \w{3} (\w{3}) (\d{2}) (\d{4}) (\d{2}):(\d{2}) from /.exec(line);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = String(months.indexOf(match?.[1] ?? "") + 1).padStart(2, "0");
  const local = `${match?.[3] ?? ""}-${month}-${match?.[2] ?? ""} ${match?.[4] ?? ""}:${match?.[5] ?? ""}`;
  const [row] = await sql<{ at: Date }[]>`
    select (${local}::text::timestamp at time zone 'America/New_York') as at
  `;
  return row?.at ?? new Date(Number.NaN);
}

async function rowCounts(sql: Sql): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)}`;
    counts[table] = row?.n ?? -1;
  }
  return counts;
}

/** Every row of the six tables the seed writes, in key order, as plain arrays. */
async function snapshot(sql: Sql): Promise<Record<string, unknown[]>> {
  return {
    persons: [...(await sql`select * from persons order by id`)],
    handles: [...(await sql`select * from handles order by id`)],
    person_handles: [...(await sql`select * from person_handles order by person_id, handle_id`)],
    phones: [...(await sql`select * from phones order by number`)],
    person_roles: [...(await sql`select * from person_roles order by id`)],
    customers: [...(await sql`select * from customers order by id`)],
  };
}

/** What a refused call threw. */
async function refusal(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("the call ran; it should have been refused");
}

/** The SQLSTATE and constraint of a refused statement. */
const refusedBy = (error: Error): { code: unknown; constraint: unknown } => {
  const failure = error as { code?: unknown; constraint_name?: unknown };
  return { code: failure.code, constraint: failure.constraint_name };
};

/** Carries what a transaction returned out of the rollback that undoes it. */
class RolledBack extends Error {
  constructor(readonly value: unknown) {
    super("rolled back by the test");
  }
}

/** Runs `fn` in one transaction, always rolled back, and returns what `fn` returned. */
async function thenRolledBack(sql: Sql, fn: (tx: Tx) => Promise<unknown>): Promise<unknown> {
  try {
    await sql.begin(async (tx) => {
      throw new RolledBack(await fn(tx));
    });
  } catch (error) {
    if (error instanceof RolledBack) {
      return error.value;
    }
    throw error;
  }
  throw new Error("the transaction was not rolled back");
}

/** Every file under a folder of the repository, recursively. */
function filesIn(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const file = path.join(folder, name);
    return statSync(file).isDirectory() ? filesIn(file) : [file];
  });
}

/** The digits of a phone-like match, without the country code: 10 digits for a North American number. */
function nationalDigits(match: string): string {
  const digits = match.replace(/[^0-9]/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

interface Copy {
  root: string;
  fixtures: string;
  v1: string;
}

const copies: string[] = [];

/** A byte-for-byte copy of fixtures/v1 at <temp>/fixtures/v1. */
function copyOfFixtureSet(): Copy {
  const root = mkdtempSync(path.join(tmpdir(), "rosie-seed-customers-"));
  copies.push(root);
  const fixtures = path.join(root, "fixtures");
  const v1 = path.join(fixtures, "v1");
  cpSync(V1, v1, { recursive: true });
  return { root, fixtures, v1 };
}

/** Rewrites one shop of a copy and its manifest line, so the copy still matches its manifest. */
function rewriteShop(copy: Copy, id: string, change: (shop: Record<string, unknown>) => void): void {
  const relative = `${SHOPS}/${id}.json`;
  const file = path.join(copy.v1, relative);
  const shop = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  change(shop);
  writeFileSync(file, `${JSON.stringify(shop, null, 1)}\n`);
  const manifestFile = path.join(copy.v1, "MANIFEST.sha256");
  const lines = readFileSync(manifestFile, "utf8")
    .split("\n")
    .map((line) => (line.endsWith(`  ${relative}`) ? `${sha256(file)}  ${relative}` : line));
  writeFileSync(manifestFile, lines.join("\n"));
}

/** Flips one bit of the byte in the middle of a file (doing it twice restores the file). */
function flipOneByte(file: string): void {
  const bytes = readFileSync(file);
  const at = Math.floor(bytes.length / 2);
  bytes[at] = (bytes[at] ?? 0) ^ 0x01;
  writeFileSync(file, bytes);
}

/** A shop's flow block in a copy being rewritten. */
function flowOf(shop: Record<string, unknown>, flow: string): Record<string, unknown> {
  return (shop.flows as Record<string, Record<string, unknown>>)[flow] ?? {};
}

function seedFromCopy(sql: Sql, copy: Copy): Promise<CustomerSeedResult> {
  return seedCustomersFrom(sql, openFixtureSet(copy.v1, { jail: copy.fixtures }));
}

afterAll(() => {
  for (const root of copies) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("the customers seed, loaded from fixture set v1 after the core and setup seeds", () => {
  let db: TestDatabase;
  let first: CustomerSeedResult;
  let seededAt: Date;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_customers" });
    await seedCore(db.sql);
    await seedSetupBusiness(db.sql, { wrappingKeys: KEYS });
    first = await seedCustomers(db.sql);
    seededAt = await fixtureSetMade(db.sql);
  }, 180_000);

  // Dropping a schema can pass the hook default while other builders load the database (a resource guard only).
  afterAll(async () => {
    await db.drop();
  }, 120_000);

  it("seeds three customers for each of the 245 demo shops, test-mixed-A and -B included: one for each way K-28 v1 allows, each a person of their own with a mobile, and the email way's customer an email as well", () => {
    expect(SHOP_IDS).toHaveLength(245);
    expect(SHOP_IDS).toEqual(expect.arrayContaining(["test-mixed-A", "test-mixed-B"]));
    expect([...DEMO_CUSTOMER_WAYS]).toEqual([...WAYS]);
    expect(first.shops.map((shop) => shop.shopId)).toEqual(SHOP_IDS);
    for (const shop of first.shops) {
      expect(
        shop.customers.map((customer) => [customer.position, customer.way]),
        shop.shopId,
      ).toEqual([
        [1, "texts"],
        [2, "textsonly"],
        [3, "email"],
      ]);
    }
    const people = 245 * WAYS.length;
    expect(EXPECTED).toHaveLength(people);
    for (const table of ["persons", "phones", "person_roles", "customers"] as const) {
      expect(first.tables[table], table).toEqual({ rows: people, inserted: people, kept: 0 });
    }
    // One mobile handle for each customer, and one email handle for each email way's customer, each linked to them.
    for (const table of ["handles", "person_handles"] as const) {
      expect(first.tables[table], table).toEqual({ rows: people + 245, inserted: people + 245, kept: 0 });
    }
  });

  it("every seeded customer has a mobile: the K-04 handle of a phone row and one of their own handles, a fictional number taken in order, and the record holds the way, the name on file, 18 or older, and K-28's defaults, added when fixture set v1 was made", async () => {
    expect(Number.isNaN(seededAt.getTime())).toBe(false);
    const byId = async (table: string, key: string): Promise<Map<string, Record<string, unknown>>> =>
      new Map(
        (await db.sql<Record<string, unknown>[]>`select * from ${db.sql(table)}`).map((row) => [
          String(row[key]),
          row,
        ]),
      );
    const customers = await byId("customers", "id");
    const persons = await byId("persons", "id");
    const roles = await byId("person_roles", "id");
    const handles = await byId("handles", "id");
    const phones = await byId("phones", "number");
    const links = new Set(
      (await db.sql<{ key: string }[]>`select person_id || ' ' || handle_id as key from person_handles`).map(
        (row) => row.key,
      ),
    );
    for (const expected of EXPECTED) {
      const where = expected.customerId;
      expect(customers.get(expected.customerId), where).toEqual({
        id: expected.customerId,
        business_id: `biz-demo-${expected.shopId}`,
        person_id: expected.personId,
        name: `Demo customer ${String(expected.position)}`,
        mobile_handle_id: expected.handleId,
        email_handle_id: expected.email?.handleId ?? null,
        way: expected.way,
        contact_times: null,
        first_name_only: false,
        no_voicemail: false,
        age_band: "18_or_older",
        fee_free: false,
        added_at: seededAt,
        version: 1,
      });
      // No name or language is taken from a fixture: both stay null until known, as the owners' and the team's do.
      expect(persons.get(expected.personId), where).toEqual({
        id: expected.personId,
        name: null,
        language: null,
        version: 1,
      });
      expect(roles.get(expected.roleId), where).toEqual({
        id: expected.roleId,
        person_id: expected.personId,
        business_id: `biz-demo-${expected.shopId}`,
        role: "customer",
        ended_at: null,
        version: 1,
      });
      expect(handles.get(expected.handleId), where).toEqual({
        id: expected.handleId,
        kind: "phone",
        address: expected.number,
      });
      expect(links.has(`${expected.personId} ${expected.handleId}`), where).toBe(true);
      // K-04's defaults: no chat open, not stopped, and no Linq contact add recorded for a fictional number.
      expect(phones.get(expected.number), where).toEqual({
        number: expected.number,
        handle_id: expected.handleId,
        chat_open: false,
        chat_open_at: null,
        chat_way: null,
        stopped: false,
        stop_at: null,
        start_at: null,
        linq_contact_added_at: null,
        poll_voted_at: null,
        optout_line_delivered_at: null,
        version: 1,
      });
      if (expected.email !== null) {
        expect(handles.get(expected.email.handleId), where).toEqual({
          id: expected.email.handleId,
          kind: "email",
          address: expected.email.address,
        });
        expect(links.has(`${expected.personId} ${expected.email.handleId}`), where).toBe(true);
      }
    }
    // Read from the database alone: no customer row lacks a mobile, and each mobile is the person's own phone handle.
    const [check] = await db.sql<{ customers: number; no_mobile: number; own_phone: number }[]>`
      select
        (select count(*)::int from customers) as customers,
        (select count(*)::int from customers where mobile_handle_id is null) as no_mobile,
        (select count(*)::int from customers c
          join handles h on h.id = c.mobile_handle_id and h.kind = 'phone'
          join phones p on p.handle_id = h.id and p.number = h.address
          join person_handles l on l.person_id = c.person_id and l.handle_id = c.mobile_handle_id) as own_phone
    `;
    expect(check).toEqual({ customers: EXPECTED.length, no_mobile: 0, own_phone: EXPECTED.length });
  });

  it("none has 'calls only': every way is texts, textsonly or email, one of each at every shop, and the database refuses calls only for a seeded customer (CHECK customers_way_known, 23514) while the same update to texts only passes", async () => {
    const ways = await db.sql<{ way: string | null; n: number }[]>`
      select way, count(*)::int as n from customers group by way order by way
    `;
    expect(ways).toEqual([
      { way: "email", n: 245 },
      { way: "texts", n: 245 },
      { way: "textsonly", n: 245 },
    ]);
    const [none] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from customers where way = ${CALLS_ONLY} or way is null
    `;
    expect(none?.n).toBe(0);
    const perShop = await db.sql<{ business_id: string; ways: string[] }[]>`
      select business_id, array_agg(way order by way) as ways from customers group by business_id
    `;
    expect(perShop).toHaveLength(245);
    for (const row of perShop) {
      expect(row.ways, row.business_id).toEqual(sorted(WAYS));
    }

    const id = "customer-demo-barber-1";
    const refused = await refusal(
      db.sql`update customers set way = ${CALLS_ONLY}, version = version + 1 where id = ${id}`,
    );
    expect(refusedBy(refused)).toEqual({ code: "23514", constraint: "customers_way_known" });
    const passed = await thenRolledBack(db.sql, async (tx) => [
      ...(await tx`
        update customers set way = 'textsonly', version = version + 1 where id = ${id} returning way, version
      `),
    ]);
    expect(passed).toEqual([{ way: "textsonly", version: 2 }]);
    const [after] = await db.sql<{ way: string; version: number }[]>`
      select way, version from customers where id = ${id}
    `;
    expect(after).toEqual({ way: "texts", version: 1 });
  });

  it("each customer comes with a live customer role at its business, written in the same commit as its record (K-28 rule 7), and only the email way's customer has an email on file, a handle of kind email of their own", async () => {
    const roles = await db.sql<{ id: string; roles: number; same_commit: boolean }[]>`
      select c.id, count(r.id)::int as roles, coalesce(bool_and(r.xmin = c.xmin), false) as same_commit
      from customers c
      left join person_roles r
        on r.person_id = c.person_id and r.business_id = c.business_id and r.role = 'customer' and r.ended_at is null
      group by c.id
      order by c.id
    `;
    expect(roles).toHaveLength(EXPECTED.length);
    for (const row of roles) {
      expect([row.roles, row.same_commit], row.id).toEqual([1, true]);
    }
    // One commit wrote every customer row, its role and its people rows.
    const [commits] = await db.sql<{ n: number }[]>`
      select count(distinct x)::int as n from (
        select xmin::text as x from customers
        union all select xmin::text from person_roles where role = 'customer'
        union all select p.xmin::text from persons p join customers c on c.person_id = p.id
      ) seeded
    `;
    expect(commits?.n).toBe(1);

    const [emails] = await db.sql<
      { with_email: number; email_way: number; email_kind: number; other_way: number }[]
    >`
      select
        count(*) filter (where c.email_handle_id is not null)::int as with_email,
        count(*) filter (where c.way = 'email')::int as email_way,
        count(*) filter (where h.kind = 'email' and l.person_id is not null)::int as email_kind,
        count(*) filter (where c.email_handle_id is not null and c.way <> 'email')::int as other_way
      from customers c
      left join handles h on h.id = c.email_handle_id
      left join person_handles l on l.person_id = c.person_id and l.handle_id = c.email_handle_id
    `;
    expect(emails).toEqual({ with_email: 245, email_way: 245, email_kind: 245, other_way: 0 });
  });

  it("no real phone number is committed: every phone-like string in the seed code and in the shop files it reads is in the fiction range, and so is every phone row written, the customers' in area codes neither the owners' nor the team's use", async () => {
    const files = [
      ...filesIn(path.join(REPO, "db/seeds")),
      ...filesIn(path.join(V1, SHOPS)),
      path.join(V1, "test-kit/COVERAGE.md"),
    ];
    expect(files).toContain(path.join(REPO, "db/seeds/customers.ts"));
    expect(files).toContain(path.join(REPO, "db/seeds/customers.int.test.ts"));
    const notFictional: string[] = [];
    for (const file of files) {
      for (const match of readFileSync(file, "utf8").matchAll(PHONE_LIKE)) {
        if (!FICTIONAL.test(`+1${nationalDigits(match[0])}`)) {
          notFictional.push(`${path.relative(REPO, file)}: ${match[0]}`);
        }
      }
    }
    expect(notFictional).toEqual([]);
    // The grep catches a number written any common way. The samples are built here from parts, so this file holds no
    // phone-like string: a non-fictional one in area code 555, which serves no one, and a fictional one.
    const parts = ["555", "123", "4567"];
    const fiction = ["206", "555", "0123"];
    for (const [written, isFiction] of [
      [`+1 ${parts.join(" ")}`, false],
      [`(${parts[0] ?? ""}) ${parts[1] ?? ""}-${parts[2] ?? ""}`, false],
      [parts.join("."), false],
      [`+1${parts.join("")}`, false],
      [`+1 ${fiction.join(" ")}`, true],
      [`(${fiction[0] ?? ""}) ${fiction[1] ?? ""}-${fiction[2] ?? ""}`, true],
    ] as const) {
      const matches = [...written.matchAll(PHONE_LIKE)].map((match) => match[0]);
      expect(matches, written).toEqual([written]);
      expect(FICTIONAL.test(`+1${nationalDigits(written)}`), written).toBe(isFiction);
    }

    const numbers = (await db.sql<{ number: string }[]>`select number from phones`).map((row) => row.number);
    expect(numbers).toHaveLength(245 + EXPECTED.length);
    for (const number of numbers) {
      expect(number).toMatch(FICTIONAL);
    }
    expect(new Set(numbers).size).toBe(numbers.length);
    const customerCodes: readonly string[] = CUSTOMER_AREA_CODES;
    const takenCodes: readonly string[] = [...FICTIONAL_AREA_CODES, ...STAFF_AREA_CODES];
    expect(customerCodes.filter((code) => takenCodes.includes(code))).toEqual([]);
    for (const expected of EXPECTED) {
      expect(customerCodes, expected.customerId).toContain(expected.number.slice(2, 5));
    }
  });

  it("no email address or name comes from a fixture: each email on file is its customer's id at example.com, each name on file the seed's label, each person's own name null, and no file fixture set v1 lists holds an email address or that label", async () => {
    const listedFiles = [...LISTED.keys()];
    expect(listedFiles.length).toBeGreaterThan(245);
    const holding = listedFiles.filter((relative) => {
      const text = readFileSync(path.join(V1, relative), "utf8");
      return text.includes("@") || text.includes("Demo customer");
    });
    expect(holding).toEqual([]);

    const emails = await db.sql<{ customer: string; address: string }[]>`
      select c.id as customer, h.address from customers c join handles h on h.id = c.email_handle_id order by c.id
    `;
    expect(emails).toHaveLength(245);
    for (const row of emails) {
      expect(row.address, row.customer).toBe(`${row.customer.toLowerCase()}@example.com`);
    }
    const names = await db.sql<{ name: string; n: number }[]>`
      select name, count(*)::int as n from customers group by name order by name
    `;
    expect(names).toEqual([
      { name: "Demo customer 1", n: 245 },
      { name: "Demo customer 2", n: 245 },
      { name: "Demo customer 3", n: 245 },
    ]);
    const [named] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from persons p join customers c on c.person_id = p.id
      where p.name is not null or p.language is not null
    `;
    expect(named?.n).toBe(0);
  });

  it("traces every shop to its fixture set v1 file at the hash MANIFEST.sha256 lists, and every row written to one shop's customer", async () => {
    expect(first.fixtureSet.manifestSha256).toBe(sha256(path.join(V1, "MANIFEST.sha256")));
    expect(first.fixtureSet.filesChecked).toBe(LISTED.size);
    expect(first.seededAt).toEqual({ at: seededAt, source: "test-kit/COVERAGE.md" });
    expect(LISTED.has(first.seededAt.source)).toBe(true);
    for (const shop of first.shops) {
      expect(shop.source).toBe(`${SHOPS}/${shop.shopId}.json`);
      expect(LISTED.get(shop.source), shop.source).toBe(shop.sha256);
      expect(sha256(path.join(V1, shop.source)), shop.source).toBe(shop.sha256);
      expect(shop.businessId, shop.source).toBe(`biz-demo-${shop.shopId}`);
      expect(
        shop.customers.map((customer) => ({
          customerId: customer.customerId,
          personId: customer.personId,
          roleId: customer.roleId,
          handleId: customer.handleId,
          number: customer.phoneNumber,
          email: customer.email,
        })),
        shop.source,
      ).toEqual(
        EXPECTED.filter((expected) => expected.shopId === shop.shopId).map((expected) => ({
          customerId: expected.customerId,
          personId: expected.personId,
          roleId: expected.roleId,
          handleId: expected.handleId,
          number: expected.number,
          email: expected.email,
        })),
      );
    }

    // Every customer row and customer role is one shop's seeded customer's, and every one of those is in the tables.
    const keys = async (rows: Promise<readonly { key: string }[]>): Promise<string[]> =>
      sorted((await rows).map((row) => row.key));
    const sql = db.sql;
    const seeded = first.shops.flatMap((shop) =>
      shop.customers.map((customer) => ({ ...customer, businessId: shop.businessId })),
    );
    expect(
      await keys(
        sql<{ key: string }[]>`select id || ' ' || business_id || ' ' || person_id as key from customers`,
      ),
    ).toEqual(sorted(seeded.map((c) => `${c.customerId} ${c.businessId} ${c.personId}`)));
    expect(
      await keys(
        sql<
          { key: string }[]
        >`select id || ' ' || business_id as key from person_roles where role = 'customer'`,
      ),
    ).toEqual(sorted(seeded.map((c) => `${c.roleId} ${c.businessId}`)));
  });

  it("writes as the job role, rosie_job, with no scope; under row-level security a shop's scope shows the Tool API role that shop's customers and customer roles only", async () => {
    expect(first.ranAs).toBe("rosie_job");
    const seen = async (businessId: string): Promise<{ customers: string[]; roles: string[] }> =>
      withBusiness(db.sql, businessId, async (tx) => {
        await tx`set local role rosie_app`;
        const customers = await tx<{ id: string }[]>`select id from customers order by id`;
        const roles = await tx<{ id: string }[]>`
          select id from person_roles where role = 'customer' order by id
        `;
        return { customers: customers.map((row) => row.id), roles: roles.map((row) => row.id) };
      });
    expect(await seen("biz-demo-plumber")).toEqual({
      customers: ["customer-demo-plumber-1", "customer-demo-plumber-2", "customer-demo-plumber-3"],
      roles: ["role-demo-plumber-customer-1", "role-demo-plumber-customer-2", "role-demo-plumber-customer-3"],
    });
    expect((await seen("biz-demo-test-mixed-B")).customers).toEqual([
      "customer-demo-test-mixed-B-1",
      "customer-demo-test-mixed-B-2",
      "customer-demo-test-mixed-B-3",
    ]);
  });

  it(
    "running the seed twice leaves the same rows: the second run writes nothing, and every row and version stays as it was",
    SLOW,
    async () => {
      const before = await snapshot(db.sql);
      const second = await seedCustomers(db.sql);
      for (const table of TABLES) {
        const total = first.tables[table].rows;
        expect(second.tables[table], table).toEqual({ rows: total, inserted: 0, kept: total });
      }
      expect(second.shops).toEqual(first.shops);
      expect(second.seededAt).toEqual(first.seededAt);
      expect(second.ranAs).toBe("rosie_job");
      expect(await snapshot(db.sql)).toEqual(before);
    },
  );

  it(
    "writes rows that went missing again, as the first run wrote them, and changes nothing else",
    SLOW,
    async () => {
      const before = await snapshot(db.sql);
      await db.sql`delete from customers where id in ('customer-demo-yoga-3', 'customer-demo-plumber-1')`;
      await db.sql`delete from person_roles where id = 'role-demo-yoga-customer-3'`;
      await db.sql`
        delete from person_handles
        where person_id = 'person-demo-yoga-customer-3' and handle_id = 'handle-demo-yoga-customer-3-email'
      `;
      const third = await seedCustomers(db.sql);
      expect(Object.fromEntries(TABLES.map((table) => [table, third.tables[table].inserted]))).toEqual({
        persons: 0,
        handles: 0,
        person_handles: 1,
        phones: 0,
        person_roles: 1,
        customers: 2,
      });
      expect(await snapshot(db.sql)).toEqual(before);
    },
  );
});

describe("the cast is an illustration, never parsed (Master Corrections C6)", () => {
  it(
    "plans the same rows from a copy whose shop files' customer casts name someone else, no one, or someone where there was no one",
    SLOW,
    () => {
      const original = customersPlanOf(verifyFixtureSet(openFixtureSet()));
      const copy = copyOfFixtureSet();
      const changed = ["barber", "plumber", "yoga"];
      rewriteShop(copy, "barber", (shop) => {
        flowOf(shop, "A").customer = "Someone else entirely (customer) · nobody else";
        flowOf(shop, "B").customer = null;
      });
      rewriteShop(copy, "plumber", (shop) => {
        delete flowOf(shop, "A").customer;
        flowOf(shop, "B").customer = "Three new families (customers)";
      });
      rewriteShop(copy, "yoga", (shop) => {
        flowOf(shop, "A").customer = "";
      });
      const recast = customersPlanOf(verifyFixtureSet(openFixtureSet(copy.v1, { jail: copy.fixtures })));
      expect(recast.rows).toEqual(original.rows);
      expect(recast.seededAt).toEqual(original.seededAt);
      // Only the rewritten files' hashes differ: the same shops, keys and customers, traced to the new bytes.
      const withoutHash = (plan: typeof original): unknown[] =>
        plan.shops.map((shop) => ({ ...shop, sha256: "" }));
      expect(withoutHash(recast)).toEqual(withoutHash(original));
      expect(
        recast.shops
          .filter((shop, index) => shop.sha256 !== original.shops[index]?.sha256)
          .map((shop) => shop.shopId),
      ).toEqual(changed);
    },
  );
});

describe("before the customers seed writes a row", () => {
  let db: TestDatabase;
  let empty: Record<string, number>;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_customers_checks" });
  }, 120_000);

  // Dropping a schema can pass the hook default while other builders load the database (a resource guard only).
  afterAll(async () => {
    await db.drop();
  }, 120_000);

  it(
    "refuses to run before the core and setup seeds, naming the one to run first, and writes nothing",
    SLOW,
    async () => {
      const noCore = await refusal(seedCustomers(db.sql));
      expect(noCore.message).toContain("run db/seeds/core.ts first");
      expect(noCore.message).toContain("245 of 245 shops");
      expect(await rowCounts(db.sql)).toEqual(Object.fromEntries(TABLES.map((table) => [table, 0])));

      await seedCore(db.sql);
      const afterCore = await rowCounts(db.sql);
      const noSetup = await refusal(seedCustomers(db.sql));
      expect(noSetup.message).toContain("run db/seeds/setup-business.ts first");
      expect(noSetup.message).toContain("245 of 245 shops");
      expect(await rowCounts(db.sql)).toEqual(afterCore);
      // Only the core seed's rows: 245 owners with their handles, phones and roles, and no customer.
      expect(afterCore).toEqual({
        persons: 245,
        handles: 245,
        person_handles: 245,
        phones: 245,
        person_roles: 245,
        customers: 0,
      });
    },
  );

  describe("with the core and setup seeds' rows in place", () => {
    beforeAll(async () => {
      await seedSetupBusiness(db.sql, { wrappingKeys: KEYS });
      empty = await rowCounts(db.sql);
    }, 120_000);

    it(
      "checks the whole set against MANIFEST.sha256 first: one changed byte in a shop file stops it",
      SLOW,
      async () => {
        const copy = copyOfFixtureSet();
        const changed = `${SHOPS}/plumber.json`;
        flipOneByte(path.join(copy.v1, changed));
        const error = await refusal(seedFromCopy(db.sql, copy));
        expect(error).toBeInstanceOf(FixtureChecksumError);
        expect((error as FixtureChecksumError).problems).toEqual([`changed: ${changed}`]);
        expect(await rowCounts(db.sql)).toEqual(empty);
      },
    );

    it(
      "refuses an intact copy of fixture set v1 that lies outside fixtures/, and writes nothing",
      SLOW,
      async () => {
        const copy = copyOfFixtureSet();
        const error = await refusal(seedCustomers(db.sql, { fixturesDir: copy.v1 }));
        expect(error).toBeInstanceOf(FixtureAccessError);
        expect(await rowCounts(db.sql)).toEqual(empty);
      },
    );

    it(
      "rolls back the whole run when a mobile it would give a customer is another handle's already (unique handles_address_key, 23505), and writes nothing",
      SLOW,
      async () => {
        const taken = EXPECTED[EXPECTED.length - 1];
        expect(taken?.shopId).toBe("yoga");
        await db.sql`
          insert into handles (id, kind, address) values ('handle-test-someone-else', 'phone', ${taken?.number ?? ""})
        `;
        try {
          const error = await refusal(seedCustomers(db.sql));
          expect(refusedBy(error)).toEqual({ code: "23505", constraint: "handles_address_key" });
          expect(await rowCounts(db.sql)).toEqual({ ...empty, handles: (empty.handles ?? 0) + 1 });
        } finally {
          await db.sql`delete from handles where id = 'handle-test-someone-else'`;
        }
        expect(await rowCounts(db.sql)).toEqual(empty);
      },
    );

    it(
      "loads from an untouched copy opened the same way, so each refusal above had its one reason",
      SLOW,
      async () => {
        const copy = copyOfFixtureSet();
        const result = await seedFromCopy(db.sql, copy);
        expect(result.ranAs).toBe("rosie_job");
        expect(result.tables.customers).toEqual({
          rows: EXPECTED.length,
          inserted: EXPECTED.length,
          kept: 0,
        });
        const counts = await rowCounts(db.sql);
        expect(counts.customers).toBe(EXPECTED.length);
        expect(counts.phones).toBe(245 + EXPECTED.length);
      },
    );
  });
});
