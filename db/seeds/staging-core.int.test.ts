// T-202: staging's seeded state, its core rows (db/seeds/staging-core.ts), against local PostgreSQL (`npm run db:up`;
// `npm run test:integration -- db/seeds/staging-core`). Each block that needs a database migrates a fresh test schema of
// its own (db/repo/test-db.ts) and drops it at the end; the shared public schema is never touched.
//
// The card's proofs: `node db/seeds/run.mjs --set staging-core` on a fresh schema creates the test businesses in
// America/New_York and one customer person, handle and phone per configured test phone; with no test-phone variable set,
// the fixed fake handles the test-phone page sends as; no real number is in the repository (a grep test); the run is
// idempotent. The lead's (DL-341, DL-439): tp-01 is left out (no handle, phone row or customer role for it); the core,
// staging-core and skeleton sets load together, and tp-01's JOIN is still a first text; each phone row's chat is left
// at the table's defaults, never open.
//
// What the rows must be is read here from the files themselves (node:fs), never through the seed: fixture set v1's shop
// files for the test businesses; K-21 v1 test-roster.json for the roster; K-21 v1 test-phone-send.json and K-06 v1
// test-phone-page.json for the number the test-phone page sends as. No value is a real person's: every number here is in
// the fiction range 555-0100 to 555-0199, the configured ones too, in an area code no seed set uses (rule 9). Bytes are
// changed only in temporary copies of fixtures/v1 in the OS temp folder.
import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolvePrimaryUrl } from "../repo/client";
import type { Sql } from "../repo/scope";
import { handleTargets } from "../repo/targets";
import { createTestDatabase, type TestDatabase } from "../repo/test-db";
import { seedCore } from "./core";
import { CUSTOMER_AREA_CODES } from "./customers";
import { FICTIONAL_AREA_CODES } from "./lib/demo-shops";
import { FixtureAccessError, FixtureChecksumError, openFixtureSet } from "./lib/fixture-set";
import { STAFF_AREA_CODES } from "./setup-staff";
import { seedSkeleton, SKELETON_ROWS, TEST_OWNER_1 } from "./skeleton";
import {
  LEFT_OUT,
  seed,
  seedStagingCore,
  seedStagingCoreFrom,
  StagingCoreSeedError,
  type StagingCoreSeedResult,
  TEST_PHONE_ROLE,
  TEST_PHONE_SHOP,
  TEST_PHONES,
  TEST_PHONES_VARIABLE,
  testPhoneNumbers,
} from "./staging-core";

const SLOW = { timeout: 120_000 };
const RUNTIME_ROLE = "rosie_job";
const REPO = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const V1 = path.join(REPO, "fixtures/v1");
const SHOPS = "test-kit/shops";
const RUNNER = path.join(REPO, "db/seeds/run.mjs");
const ROSTER_FILE = path.join(REPO, "contracts/page-api/fixtures/test-roster.json");
const SEND_FILE = path.join(REPO, "contracts/page-api/fixtures/test-phone-send.json");
const PAGE_EVENT_FILE = path.join(REPO, "contracts/inbound-event/fixtures/test-phone-page.json");
const TABLES = ["businesses", "persons", "person_roles", "handles", "person_handles", "phones"] as const;
const ZONE = "America/New_York";
const BARBER_BUSINESS = "biz-demo-barber";
// The fiction range: 555-0100 to 555-0199 in an area code, as E.164 (NANP keeps it for fiction).
const FICTIONAL = /^\+1[2-9][0-9]{2}55501[0-9]{2}$/;
// Anything written like a North American phone number: +1 optional, then area code, exchange and line, with or
// without spaces, dots, dashes or brackets, and no letter or digit straight before or after it.
const PHONE_LIKE = /(?<![\w+])(?:\+?1[\s.-]?)?\(?[2-9][0-9]{2}\)?[\s.-]?[0-9]{3}[\s.-]?[0-9]{4}(?!\w)/g;
// The numbers a test gives through STAGING_TEST_PHONES, standing in for the build Mac's: fictional too, in an area code
// no seed set uses (checked below).
const CONFIGURED_AREA_CODE = "860";
const CONFIGURED: Readonly<Record<string, string>> = {
  "tp-01": "+18605550141",
  "tp-02": "+18605550142",
  "tp-03": "+18605550143",
  "tp-04": "+18605550144",
  "tp-05": "+18605550145",
};
// The integration project's database, on this machine; the runner's line for it.
const LOCAL_URL = resolvePrimaryUrl();
const LOCAL = "the local database";
// The variables the runner and this set read: each child run sets only the ones it names.
const CHILD_VARIABLES = new Set([
  "DATABASE_URL",
  "DATABASE_REPLICA_URL",
  "DB_SCHEMA",
  "STAGING_DATABASE_URL",
  "CI",
  TEST_PHONES_VARIABLE,
]);

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (values: Iterable<string>): string[] => [...values].sort(byCodePoint);
const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
const configured = (testPhoneId: string): string => CONFIGURED[testPhoneId] ?? "";

interface RosterPhone {
  testPhoneId: string;
  last4: string;
  role: string;
  businessId: string | null;
}

const ROSTER = readJson(ROSTER_FILE) as {
  given: { note: string };
  outcome: { businesses: { businessId: string; flow: string; kindIds: string[] }[]; phones: RosterPhone[] };
};
const SEND = readJson(SEND_FILE) as { request: { testPhoneId: string } };
const PAGE_EVENT = readJson(PAGE_EVENT_FILE) as { handle: { kind: string; address: string } };

/** The demo shop files of fixture set v1, read here: each shop's `id` and `name`. */
const SHOP_FILES = readdirSync(path.join(V1, SHOPS))
  .filter((name) => name.endsWith(".json"))
  .map((name) => readJson(path.join(V1, SHOPS, name)) as { id: string; name: string });

/** Each shop's business head as the core seed writes it, and this set again: the test businesses, in id order. */
const TEST_BUSINESSES = SHOP_FILES.map((shop) => ({
  id: `biz-demo-${shop.id}`,
  name: shop.name,
  display_name: shop.name,
  status: "offline",
  time_zone: ZONE,
  text_hours_start: "08:00",
  text_hours_end: "20:00",
  version: 1,
})).sort((a, b) => byCodePoint(a.id, b.id));

/** A test phone as the seed must write it: its roster id, its number and the keys made from the id. */
interface Phone {
  testPhoneId: string;
  number: string;
  personId: string;
  roleId: string;
  handleId: string;
}

const phoneOf = (testPhoneId: string, number: string): Phone => ({
  testPhoneId,
  number,
  personId: `person-${testPhoneId}`,
  roleId: `role-${testPhoneId}-customer`,
  handleId: `handle-${testPhoneId}`,
});

/** The number the test-phone page sends as for a roster phone: +1 555 555 and its last four digits. */
const fakeNumberOf = (phone: RosterPhone): string => `+1555555${phone.last4}`;

/** With no variable: every roster phone but tp-01, at its fake handle, in roster order. */
const FAKE_SEEDED: readonly Phone[] = ROSTER.outcome.phones
  .filter((phone) => phone.testPhoneId !== "tp-01")
  .map((phone) => phoneOf(phone.testPhoneId, fakeNumberOf(phone)));

/** The seeded keys of each phone, as the result names them (never the number). */
const seededKeys = (phones: readonly Phone[]): Record<string, string>[] =>
  phones.map((phone) => ({
    testPhoneId: phone.testPhoneId,
    personId: phone.personId,
    roleId: phone.roleId,
    handleId: phone.handleId,
    businessId: BARBER_BUSINESS,
  }));

/** The rows the test phones' five tables must hold for `phones`, each in code-point order of its key. */
function phoneRowsFor(phones: readonly Phone[]): Record<string, unknown[]> {
  const by =
    <T>(key: (row: T) => string) =>
    (a: T, b: T) =>
      byCodePoint(key(a), key(b));
  return {
    persons: phones
      .map((phone) => ({ id: phone.personId, name: null, language: null, version: 1 }))
      .sort(by((row) => row.id)),
    person_roles: phones
      .map((phone) => ({
        id: phone.roleId,
        person_id: phone.personId,
        business_id: BARBER_BUSINESS,
        role: "customer",
        ended_at: null,
        version: 1,
      }))
      .sort(by((row) => row.id)),
    handles: phones
      .map((phone) => ({ id: phone.handleId, kind: "phone", address: phone.number }))
      .sort(by((row) => row.id)),
    person_handles: phones
      .map((phone) => ({ person_id: phone.personId, handle_id: phone.handleId }))
      .sort(by((row) => row.person_id)),
    // Every column but the number and the handle at K-04's default: the chat not open, not stopped, nothing recorded.
    phones: phones
      .map((phone) => ({
        number: phone.number,
        handle_id: phone.handleId,
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
      }))
      .sort(by((row) => row.number)),
  };
}

/** The five test-phone tables' rows, as phoneRowsFor gives them. */
async function phoneRows(sql: Sql): Promise<Record<string, unknown[]>> {
  return {
    persons: [...(await sql`select id, name, language, version from persons order by id collate "C"`)],
    person_roles: [
      ...(await sql`
        select id, person_id, business_id, role, ended_at, version from person_roles order by id collate "C"
      `),
    ],
    handles: [...(await sql`select id, kind, address from handles order by id collate "C"`)],
    person_handles: [
      ...(await sql`select person_id, handle_id from person_handles order by person_id collate "C"`),
    ],
    phones: [
      ...(await sql`
        select number, handle_id, chat_open, chat_open_at, chat_way, stopped, stop_at, start_at,
               linq_contact_added_at, poll_voted_at, optout_line_delivered_at, version
        from phones order by number collate "C"
      `),
    ],
  };
}

/** The business heads, in id order, with the text hours in the fixtures' form (08:00). */
async function businessRows(sql: Sql): Promise<unknown[]> {
  return [
    ...(await sql`
      select id, name, display_name, status, time_zone, to_char(text_hours_start, 'HH24:MI') as text_hours_start,
             to_char(text_hours_end, 'HH24:MI') as text_hours_end, version
      from businesses order by id collate "C"
    `),
  ];
}

async function rowCounts(sql: Sql): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)}`;
    counts[table] = row?.n ?? -1;
  }
  return counts;
}

/** Every row of the tables the three sets write, in key order, as plain arrays. */
async function snapshot(sql: Sql): Promise<Record<string, unknown[]>> {
  return {
    businesses: [...(await sql`select * from businesses order by id`)],
    persons: [...(await sql`select * from persons order by id`)],
    person_roles: [...(await sql`select * from person_roles order by id`)],
    handles: [...(await sql`select * from handles order by id`)],
    person_handles: [...(await sql`select * from person_handles order by person_id, handle_id`)],
    phones: [...(await sql`select * from phones order by number`)],
    companies: [...(await sql`select * from companies order by id`)],
    company_kinds: [...(await sql`select * from company_kinds order by company_id, kind_id`)],
  };
}

/** Empties every table of a test schema (truncating the heads cascades to the rest). */
async function empty(sql: Sql): Promise<void> {
  await sql`truncate businesses, persons, handles, bundles, release_flags cascade`;
}

/** What a refused call threw. */
async function refusal(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("the seed ran; it should have refused");
}

/** The parts of a number a line must never hold: the whole, without its +, and its last seven digits. */
const partsOf = (number: string): string[] => [number, number.slice(1), number.slice(-7)];

/** Connections that run as rosie_job, the guard's role, with `schema` first and no business scope. */
function runtimeClient(schema: string): Sql {
  return postgres(resolvePrimaryUrl(), {
    max: 2,
    onnotice: () => undefined,
    connection: {
      application_name: "rosie-t202-staging-core",
      search_path: `${schema}, public`,
      role: RUNTIME_ROLE,
    },
  });
}

/** The guard's read of a test phone's handle (K-05 v1.2 handleTargets): a customer of the barber, the chat closed. */
async function expectCustomerOfTheBarber(runtime: Sql, phone: Phone): Promise<void> {
  expect(await handleTargets(runtime, { handleId: phone.handleId })).toMatchObject({
    result: "targets",
    handleId: phone.handleId,
    persons: [
      {
        personId: phone.personId,
        roles: [{ roleId: phone.roleId, businessId: BARBER_BUSINESS, role: "customer", version: 1 }],
      },
    ],
    openQuestions: [],
    bookings: [],
    phone: { stopped: false, chatOpen: false, version: 1 },
  });
}

/** The guard's read of tp-01's handle: test owner 1 alone, with no role and no phone row, so JOIN is a first text. */
async function expectFirstText(runtime: Sql): Promise<void> {
  expect(await handleTargets(runtime, { handleId: TEST_OWNER_1.handleId })).toMatchObject({
    result: "targets",
    handleId: TEST_OWNER_1.handleId,
    persons: [{ personId: TEST_OWNER_1.personId, roles: [] }],
    openQuestions: [],
    bookings: [],
    phone: null,
  });
}

const counts = (rows: number, inserted: number) => ({ rows, inserted, kept: rows - inserted });

/** A run's table counts: 245 test businesses, and `phones` rows in each test-phone table. */
function tablesOf(
  businessesInserted: number,
  phones: number,
  phonesInserted: number,
): Record<string, unknown> {
  return {
    businesses: counts(TEST_BUSINESSES.length, businessesInserted),
    persons: counts(phones, phonesInserted),
    person_roles: counts(phones, phonesInserted),
    handles: counts(phones, phonesInserted),
    person_handles: counts(phones, phonesInserted),
    phones: counts(phones, phonesInserted),
  };
}

// ---- the runner, run as deploy scripts run it ------------------------------------------------------------------------

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `node db/seeds/run.mjs --set staging-core` with this environment's variables, less the child's own, plus `env`. */
function runSeed(env: Readonly<Record<string, string>>): Promise<Run> {
  const childEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !CHILD_VARIABLES.has(name)) {
      childEnv[name] = value;
    }
  }
  Object.assign(childEnv, env);
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [RUNNER, "--set", "staging-core"],
      { cwd: REPO, env: childEnv, timeout: 110_000 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : error.code;
        if (typeof code === "number") {
          resolve({ code, stdout, stderr });
        } else {
          reject(error ?? new Error("the runner ended with no exit code"));
        }
      },
    );
  });
}

const lines = (text: string): string[] => text.split("\n").filter((line) => line !== "");

/** The lines a successful run prints: the target, one line of row counts per table, and the totals. */
function seededLines(schema: string, tables: readonly (readonly [string, number, number])[]): string[] {
  const plural = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;
  const rows = tables.reduce((total, [, n]) => total + n, 0);
  const inserted = tables.reduce((total, [, , added]) => total + added, 0);
  return [
    `seed: set staging-core into schema ${schema} on ${LOCAL}`,
    ...tables.map(
      ([table, n, added]) =>
        `seed: ${table}: ${plural(n, "row", "rows")} (${String(added)} inserted, ${String(n - added)} kept)`,
    ),
    `seed: done: set staging-core into schema ${schema}: ${plural(rows, "row", "rows")} in ` +
      `${plural(tables.length, "table", "tables")} (${String(inserted)} inserted, ${String(rows - inserted)} kept)`,
  ];
}

// ---- temporary copies of fixture set v1 ------------------------------------------------------------------------------

interface Copy {
  /** Its fixtures/ folder: the jail the copy is opened with. */
  fixtures: string;
  /** The copy of fixtures/v1. */
  v1: string;
}

const copies: string[] = [];

/** A byte-for-byte copy of fixtures/v1 at <temp>/fixtures/v1. */
function copyOfFixtureSet(): Copy {
  const root = mkdtempSync(path.join(tmpdir(), "rosie-seed-staging-core-"));
  copies.push(root);
  const fixtures = path.join(root, "fixtures");
  const v1 = path.join(fixtures, "v1");
  cpSync(V1, v1, { recursive: true });
  return { fixtures, v1 };
}

/** Flips one bit of the byte in the middle of a file. */
function flipOneByte(file: string): void {
  const bytes = readFileSync(file);
  const at = Math.floor(bytes.length / 2);
  bytes[at] = (bytes[at] ?? 0) ^ 0x01;
  writeFileSync(file, bytes);
}

afterAll(() => {
  for (const root of copies) {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- the grep test's helpers -----------------------------------------------------------------------------------------

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

// ---- the tests -------------------------------------------------------------------------------------------------------

describe("the test phones: K-21 v1 test-roster.json's, at the numbers the test-phone page sends as", () => {
  it("TEST_PHONES is the roster's five phones in its order, each at +1 555 555 and its last four digits, in the fiction range", () => {
    expect(TEST_PHONES).toEqual(
      ROSTER.outcome.phones.map((phone) => ({
        testPhoneId: phone.testPhoneId,
        fakeNumber: fakeNumberOf(phone),
      })),
    );
    expect(TEST_PHONES).toHaveLength(5);
    for (const phone of TEST_PHONES) {
      expect(phone.fakeNumber, phone.testPhoneId).toMatch(FICTIONAL);
    }
  });

  it("the page sends as those numbers: test-phone-send.json's phone, tp-04, texts in as K-06 test-phone-page.json's handle", () => {
    const sent = TEST_PHONES.find((phone) => phone.testPhoneId === SEND.request.testPhoneId);
    expect(SEND.request.testPhoneId).toBe("tp-04");
    expect(PAGE_EVENT.handle).toEqual({ kind: "phone", address: sent?.fakeNumber });
  });

  it("tp-01 is test owner 1, the skeleton seed's: the one phone this set leaves out, at the skeleton's handle's number", () => {
    expect(LEFT_OUT).toEqual([TEST_OWNER_1.testPhoneId]);
    expect(LEFT_OUT).toEqual(["tp-01"]);
    const testOwner = TEST_PHONES.find((phone) => phone.testPhoneId === TEST_OWNER_1.testPhoneId);
    expect(SKELETON_ROWS.handles).toEqual([
      { id: TEST_OWNER_1.handleId, kind: "phone", address: testOwner?.fakeNumber },
    ]);
  });

  it("the test phones are customers of fixture set v1's barber, where K-21's roster seats its test phones", () => {
    expect([TEST_PHONE_SHOP, TEST_PHONE_ROLE]).toEqual(["barber", "customer"]);
    expect(SHOP_FILES.map((shop) => shop.id)).toContain(TEST_PHONE_SHOP);
    expect(ROSTER.given.note).toContain("fixture set v1's barber as Lee's Barbershop (flow A)");
    const [barbershop] = ROSTER.outcome.businesses;
    expect(barbershop).toMatchObject({ flow: "A", kindIds: [TEST_PHONE_SHOP] });
    expect(
      ROSTER.outcome.phones.filter((phone) => phone.role === "customer").map((phone) => phone.businessId),
    ).toEqual([barbershop?.businessId]);
  });

  it("their area code, 555, is no other seed set's (the core, staff and customers seeds' mobiles), nor the configured numbers' here", () => {
    const codes = new Set(TEST_PHONES.map((phone) => phone.fakeNumber.slice(2, 5)));
    expect([...codes]).toEqual(["555"]);
    const others: readonly string[] = [...FICTIONAL_AREA_CODES, ...STAFF_AREA_CODES, ...CUSTOMER_AREA_CODES];
    expect(others).not.toContain("555");
    expect(others).not.toContain(CONFIGURED_AREA_CODE);
    for (const number of Object.values(CONFIGURED)) {
      expect(number).toMatch(FICTIONAL);
      expect(number.slice(2, 5)).toBe(CONFIGURED_AREA_CODE);
    }
  });
});

/** Variables the set cannot read, and what its refusal says of each. */
const BAD_VALUES: readonly (readonly [string, string])[] = [
  [`tp-02 ${configured("tp-02")}`, "entry 1 is not <roster id>=<number in E.164 form>"],
  [`tp-02=${configured("tp-02")},`, "entry 2 is not <roster id>=<number in E.164 form>"],
  [
    `tp-02=${configured("tp-02")},=${configured("tp-03")}`,
    "entry 2 is not <roster id>=<number in E.164 form>",
  ],
  ["tp-02=", "entry 1 is not <roster id>=<number in E.164 form>"],
  [
    `tp-09=${configured("tp-02")}`,
    "entry 1 names no phone on the roster (tp-01, tp-02, tp-03, tp-04, tp-05)",
  ],
  [`TP-02=${configured("tp-02")}`, "entry 1 names no phone on the roster"],
  ["tp-02=8605550142", "entry 1 gives a number not in E.164 form"],
  ["tp-02=+1 860 555 0142", "entry 1 gives a number not in E.164 form"],
  ["tp-02=860-555-0142", "entry 1 gives a number not in E.164 form"],
  [`tp-02=${configured("tp-02")},tp-02=${configured("tp-03")}`, "names tp-02 twice (entries 1 and 2)"],
  [`tp-02=${configured("tp-02")},tp-03=${configured("tp-02")}`, "entries 1 and 2 give the same number"],
  ["tp-03=+15555550100", "entry 1 gives tp-03 the fake handle of tp-01, test owner 1"],
];

describe("STAGING_TEST_PHONES, read at run time (NQ-DB-2's default)", () => {
  const ALL_FAKE = TEST_PHONES.map((phone) => ({ testPhoneId: phone.testPhoneId, number: phone.fakeNumber }));

  it("unset or blank: every roster phone at its fixed fake handle", () => {
    for (const value of [undefined, "", "  ", "\n"]) {
      expect(testPhoneNumbers(value), JSON.stringify(value)).toEqual({
        from: "fakeHandles",
        phones: ALL_FAKE,
      });
    }
  });

  it("set: the phones it names, with their numbers, in roster order, with spaces around entries and their parts taken off", () => {
    const value = ` tp-05 = ${configured("tp-05")} ,tp-01=${configured("tp-01")},tp-03=${configured("tp-03")} `;
    expect(testPhoneNumbers(value)).toEqual({
      from: "variable",
      phones: ["tp-01", "tp-03", "tp-05"].map((id) => ({ testPhoneId: id, number: configured(id) })),
    });
  });

  it("refuses an entry it cannot read, a phone not on the roster, a number not in E.164 form, a phone or number given twice, and tp-01's fake handle for another phone, naming the entry and no part of the value", () => {
    const parts = [CONFIGURED_AREA_CODE, "555", "0100", "0142", "0143"];
    for (const [value, says] of BAD_VALUES) {
      let error: unknown;
      try {
        testPhoneNumbers(value);
      } catch (thrown) {
        error = thrown;
      }
      expect(error, value).toBeInstanceOf(StagingCoreSeedError);
      const message = (error as Error).message;
      expect(message, value).toContain(`${TEST_PHONES_VARIABLE} ${says}`);
      expect(message, value).toContain("(no part of its value is shown)");
      expect(
        parts.filter((part) => message.includes(part)),
        value,
      ).toEqual([]);
    }
  });
});

describe("on a fresh schema, with no test-phone variable set", () => {
  let db: TestDatabase;
  let runtime: Sql;
  let first: StagingCoreSeedResult;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_staging_core" });
    runtime = runtimeClient(db.schema);
    first = await seedStagingCore(db.sql, { env: {} });
  }, 120_000);

  afterAll(async () => {
    await runtime.end({ timeout: 5 });
    await db.drop();
  }, 120_000);

  it("is the set T-201's runner finds by its file name: `seed` is this seed", () => {
    expect(seed).toBe(seedStagingCore);
  });

  it("writes as the job role, rosie_job, with no business scope: the test businesses, and a person, a customer role, a handle, a link and a phone row for each test phone but tp-01", async () => {
    expect(first.ranAs).toBe(RUNTIME_ROLE);
    expect(first.tables).toEqual(tablesOf(TEST_BUSINESSES.length, 4, 4));
    expect(first.numbersFrom).toBe("fakeHandles");
    expect(first.testPhones).toEqual(seededKeys(FAKE_SEEDED));
    expect(first.fixtureSet.filesChecked).toBeGreaterThan(TEST_BUSINESSES.length);
    expect(await rowCounts(db.sql)).toEqual({
      businesses: 245,
      persons: 4,
      person_roles: 4,
      handles: 4,
      person_handles: 4,
      phones: 4,
    });
  });

  it("creates the test businesses in America/New_York: every demo shop's business head, row for row as the core seed writes it", async () => {
    expect(TEST_BUSINESSES).toHaveLength(245);
    expect(await businessRows(db.sql)).toEqual(TEST_BUSINESSES);
    const [zones] = await db.sql<
      { zones: string[] }[]
    >`select array_agg(distinct time_zone) as zones from businesses`;
    expect(zones?.zones).toEqual([ZONE]);
    expect(TEST_BUSINESSES.map((business) => business.id)).toContain(BARBER_BUSINESS);
  });

  it("gives each test phone its fixed fake handle and a person with the customer role at the barber; each phone row keeps the table's defaults: the chat not open, not stopped", async () => {
    expect(FAKE_SEEDED.map((phone) => phone.testPhoneId)).toEqual(["tp-02", "tp-03", "tp-04", "tp-05"]);
    expect(await phoneRows(db.sql)).toEqual(phoneRowsFor(FAKE_SEEDED));
    const [open] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from phones where chat_open or chat_open_at is not null or chat_way is not null
    `;
    expect(open?.n).toBe(0);
  });

  it("leaves tp-01 out: no handle at its number, and no person, role, handle or phone row of its own", async () => {
    const [testOwner] = TEST_PHONES.filter((phone) => phone.testPhoneId === "tp-01");
    const [found] = await db.sql<{ handles: number; phones: number; ids: number }[]>`
      select
        (select count(*)::int from handles where address = ${testOwner?.fakeNumber ?? ""}) as handles,
        (select count(*)::int from phones where number = ${testOwner?.fakeNumber ?? ""}) as phones,
        (select count(*)::int from (
          select id from persons union all select id from person_roles union all select id from handles
          union all select person_id from person_handles union all select handle_id from phones
        ) as keys where id like '%tp-01%') as ids
    `;
    expect(found).toEqual({ handles: 0, phones: 0, ids: 0 });
    expect(first.testPhones.map((phone) => phone.testPhoneId)).not.toContain("tp-01");
  });

  it("the guard (K-05 handleTargets, as rosie_job) reads each test phone as its own person, a customer of the barber, with a phone row whose chat is closed and not stopped", async () => {
    for (const phone of FAKE_SEEDED) {
      await expectCustomerOfTheBarber(runtime, phone);
    }
  });

  it(
    "runs twice with no change: the second run writes nothing, and every row stays as it was, version included",
    SLOW,
    async () => {
      const before = await snapshot(db.sql);
      const second = await seedStagingCore(db.sql, { env: {} });
      expect(second.ranAs).toBe(RUNTIME_ROLE);
      expect(second.tables).toEqual(tablesOf(0, 4, 0));
      expect(second.testPhones).toEqual(first.testPhones);
      expect(await snapshot(db.sql)).toEqual(before);
    },
  );

  it(
    "writes rows that went missing again, as the first run wrote them, and changes nothing else",
    SLOW,
    async () => {
      const before = await snapshot(db.sql);
      const tp05 = FAKE_SEEDED.find((phone) => phone.testPhoneId === "tp-05");
      await db.sql`delete from phones where number = ${tp05?.number ?? ""}`;
      await db.sql`delete from person_handles where handle_id = 'handle-tp-02'`;
      await db.sql`delete from person_roles where id = 'role-tp-04-customer'`;
      const third = await seedStagingCore(db.sql, { env: {} });
      expect(third.tables).toEqual({
        ...tablesOf(0, 4, 0),
        person_roles: counts(4, 1),
        person_handles: counts(4, 1),
        phones: counts(4, 1),
      });
      expect(await snapshot(db.sql)).toEqual(before);
    },
  );
});

describe("with STAGING_TEST_PHONES set: only the phones it names, at the numbers it gives", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_staging_core_variable" });
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  }, 120_000);

  beforeEach(async () => {
    await empty(db.sql);
  });

  it(
    "seeds the phones it names at its numbers, in roster order; tp-01 is left out though named: no row for it or at its number",
    SLOW,
    async () => {
      const env = {
        [TEST_PHONES_VARIABLE]: `tp-05=${configured("tp-05")}, tp-01=${configured("tp-01")}, tp-03=${configured("tp-03")}`,
      };
      const seeded = ["tp-03", "tp-05"].map((id) => phoneOf(id, configured(id)));
      const result = await seedStagingCore(db.sql, { env });
      expect(result.ranAs).toBe(RUNTIME_ROLE);
      expect(result.numbersFrom).toBe("variable");
      expect(result.tables).toEqual(tablesOf(245, 2, 2));
      expect(result.testPhones).toEqual(seededKeys(seeded));
      expect(await phoneRows(db.sql)).toEqual(phoneRowsFor(seeded));
      expect(await businessRows(db.sql)).toEqual(TEST_BUSINESSES);
      // Neither tp-01's configured number nor any fake handle was written.
      const [found] = await db.sql<{ n: number }[]>`
        select count(*)::int as n from handles
        where address in ${db.sql([configured("tp-01"), ...TEST_PHONES.map((phone) => phone.fakeNumber)])}
      `;
      expect(found?.n).toBe(0);

      const before = await snapshot(db.sql);
      const again = await seedStagingCore(db.sql, { env });
      expect(again.tables).toEqual(tablesOf(0, 2, 0));
      expect(await snapshot(db.sql)).toEqual(before);
    },
  );

  it("naming tp-01 alone seeds no test phone: the test businesses only", SLOW, async () => {
    const result = await seedStagingCore(db.sql, {
      env: { [TEST_PHONES_VARIABLE]: `tp-01=${configured("tp-01")}` },
    });
    expect(result.tables).toEqual(tablesOf(245, 0, 0));
    expect(result.testPhones).toEqual([]);
    expect(await rowCounts(db.sql)).toEqual({
      businesses: 245,
      persons: 0,
      person_roles: 0,
      handles: 0,
      person_handles: 0,
      phones: 0,
    });
  });

  it(
    "refuses a variable it cannot read before fixture set v1 or the database is read, writing nothing",
    SLOW,
    async () => {
      // A fixture set that cannot be opened: the variable is refused first, so this folder is never looked at.
      const fixturesDir = path.join(tmpdir(), "rosie-t202-no-such-fixture-set");
      for (const [value, says] of BAD_VALUES) {
        const error = await refusal(
          seedStagingCore(db.sql, { env: { [TEST_PHONES_VARIABLE]: value }, fixturesDir }),
        );
        expect(error, value).toBeInstanceOf(StagingCoreSeedError);
        expect(error.message, value).toContain(says);
      }
      expect(await rowCounts(db.sql)).toEqual(Object.fromEntries(TABLES.map((table) => [table, 0])));
    },
  );
});

describe("refuses, writing nothing", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_staging_core_refusals" });
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  }, 120_000);

  beforeEach(async () => {
    await empty(db.sql);
  });

  it("when another handle holds a test phone's number", SLOW, async () => {
    const tp03 = FAKE_SEEDED.find((phone) => phone.testPhoneId === "tp-03");
    await db.sql`insert into handles (id, kind, address) values ('handle-other', 'phone', ${tp03?.number ?? ""})`;
    const before = await snapshot(db.sql);
    const error = await refusal(seedStagingCore(db.sql, { env: {} }));
    expect(error).toBeInstanceOf(StagingCoreSeedError);
    expect(error.message).toContain("another handle holds tp-03's number");
    expect(error.message).not.toMatch(/555/);
    expect(await snapshot(db.sql)).toEqual(before);
  });

  it(
    "when a test phone's handle holds another number: a number changes only on a fresh schema",
    SLOW,
    async () => {
      await seedStagingCore(db.sql, { env: {} });
      const before = await snapshot(db.sql);
      const error = await refusal(
        seedStagingCore(db.sql, { env: { [TEST_PHONES_VARIABLE]: `tp-02=${configured("tp-02")}` } }),
      );
      expect(error).toBeInstanceOf(StagingCoreSeedError);
      expect(error.message).toContain("tp-02's handle holds another number");
      expect(
        partsOf(configured("tp-02")).filter((part) => error.message.includes(part)),
        error.message,
      ).toEqual([]);
      expect(await snapshot(db.sql)).toEqual(before);
    },
  );

  it(
    "when fixture set v1 does not match MANIFEST.sha256: one changed byte in a shop file stops it before anything is written",
    SLOW,
    async () => {
      const copy = copyOfFixtureSet();
      const changed = `${SHOPS}/barber.json`;
      flipOneByte(path.join(copy.v1, changed));
      const error = await refusal(
        seedStagingCoreFrom(
          db.sql,
          openFixtureSet(copy.v1, { jail: copy.fixtures }),
          testPhoneNumbers(undefined),
        ),
      );
      expect(error).toBeInstanceOf(FixtureChecksumError);
      expect((error as FixtureChecksumError).problems).toEqual([`changed: ${changed}`]);
      expect(await rowCounts(db.sql)).toEqual(Object.fromEntries(TABLES.map((table) => [table, 0])));
    },
  );

  it(
    "when fixture set v1 lies outside the repository's fixtures/ folder, even an intact copy",
    SLOW,
    async () => {
      const copy = copyOfFixtureSet();
      const error = await refusal(seedStagingCore(db.sql, { env: {}, fixturesDir: copy.v1 }));
      expect(error).toBeInstanceOf(FixtureAccessError);
      expect(await rowCounts(db.sql)).toEqual(Object.fromEntries(TABLES.map((table) => [table, 0])));
    },
  );

  it(
    "and loads from an untouched copy opened inside its own jail, so each refusal above had its one reason",
    SLOW,
    async () => {
      const copy = copyOfFixtureSet();
      const result = await seedStagingCoreFrom(
        db.sql,
        openFixtureSet(copy.v1, { jail: copy.fixtures }),
        testPhoneNumbers(undefined),
      );
      expect(result.tables).toEqual(tablesOf(245, 4, 4));
    },
  );
});

describe("the core, staging-core and skeleton sets load together, in either order (DL-341)", () => {
  let one: TestDatabase;
  let two: TestDatabase;
  let runtimeOne: Sql;
  let runtimeTwo: Sql;

  beforeAll(async () => {
    one = await createTestDatabase({ name: "seeds_staging_core_together" });
    two = await createTestDatabase({ name: "seeds_staging_core_together_two" });
    runtimeOne = runtimeClient(one.schema);
    runtimeTwo = runtimeClient(two.schema);
  }, 240_000);

  afterAll(async () => {
    await runtimeOne.end({ timeout: 5 });
    await runtimeTwo.end({ timeout: 5 });
    await one.drop();
    await two.drop();
  }, 120_000);

  it(
    "core, then this set, then skeleton (D-017's two, this set between): no shared id or number but the business heads, which this set keeps; tp-01's JOIN is still a first text; a second run of all three writes nothing",
    SLOW,
    async () => {
      const core = await seedCore(one.sql);
      const coreBusinesses = await businessRows(one.sql);
      const staging = await seedStagingCore(one.sql, { env: {} });
      expect(staging.tables).toEqual(tablesOf(0, 4, 4));
      expect(await businessRows(one.sql)).toEqual(coreBusinesses);
      expect(coreBusinesses).toEqual(TEST_BUSINESSES);
      const skeleton = await seedSkeleton(one.sql);
      for (const count of Object.values(skeleton.tables)) {
        expect(count).toEqual(counts(1, 1));
      }

      // The test phones share no id or number with the core seed's owners or with test owner 1's rows.
      const ours = new Set<string>(
        FAKE_SEEDED.flatMap((phone) => [phone.number, phone.personId, phone.roleId, phone.handleId]),
      );
      const theirs = [
        ...core.shops.flatMap((shop) => [shop.personId, shop.roleId, shop.handleId, shop.phoneNumber]),
        ...Object.values(TEST_OWNER_1),
        ...SKELETON_ROWS.handles.map((handle) => handle.address),
      ];
      expect(theirs.filter((key) => ours.has(key))).toEqual([]);

      expect(await rowCounts(one.sql)).toEqual({
        businesses: 246,
        persons: 250,
        person_roles: 249,
        handles: 250,
        person_handles: 250,
        phones: 249,
      });
      await expectFirstText(runtimeOne);
      for (const phone of FAKE_SEEDED) {
        await expectCustomerOfTheBarber(runtimeOne, phone);
      }

      const before = await snapshot(one.sql);
      const coreAgain = await seedCore(one.sql);
      const stagingAgain = await seedStagingCore(one.sql, { env: {} });
      const skeletonAgain = await seedSkeleton(one.sql);
      expect(coreAgain.tables.phones).toEqual(counts(245, 0));
      expect(stagingAgain.tables).toEqual(tablesOf(0, 4, 0));
      for (const count of Object.values(skeletonAgain.tables)) {
        expect(count).toEqual(counts(1, 0));
      }
      expect(await snapshot(one.sql)).toEqual(before);
    },
  );

  it(
    "this set, then skeleton, then core: every set loads, tp-01's JOIN is a first text, and the rows are the other order's",
    SLOW,
    async () => {
      expect((await seedStagingCore(two.sql, { env: {} })).tables).toEqual(tablesOf(245, 4, 4));
      await seedSkeleton(two.sql);
      const core = await seedCore(two.sql);
      expect(core.tables.businesses).toEqual(counts(245, 0));
      expect(core.tables.persons).toEqual(counts(245, 245));
      await expectFirstText(runtimeTwo);
      expect(await snapshot(two.sql)).toEqual(await snapshot(one.sql));
    },
  );
});

describe("node db/seeds/run.mjs --set staging-core", () => {
  let db: TestDatabase;
  const local = (): Record<string, string> => ({ DATABASE_URL: LOCAL_URL, DB_SCHEMA: db.schema });

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_staging_core_run" });
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  }, 120_000);

  it(
    "on a fresh schema with no test-phone variable set: the test businesses in America/New_York and each test phone's rows at its fake handle, tp-01 left out, with a line of row counts per table",
    SLOW,
    async () => {
      const run = await runSeed(local());
      expect(run.code, run.stderr).toBe(0);
      expect(lines(run.stdout)).toEqual(
        seededLines(db.schema, [
          ["businesses", 245, 245],
          ...TABLES.slice(1).map((table) => [table, 4, 4] as const),
        ]),
      );
      expect(run.stderr).toBe("");
      expect(await businessRows(db.sql)).toEqual(TEST_BUSINESSES);
      expect(await phoneRows(db.sql)).toEqual(phoneRowsFor(FAKE_SEEDED));
    },
  );

  it("a second run writes nothing and keeps every row (idempotent)", SLOW, async () => {
    const before = await snapshot(db.sql);
    const run = await runSeed(local());
    expect(run.code, run.stderr).toBe(0);
    expect(lines(run.stdout)).toEqual(
      seededLines(db.schema, [
        ["businesses", 245, 0],
        ...TABLES.slice(1).map((table) => [table, 4, 0] as const),
      ]),
    );
    expect(await snapshot(db.sql)).toEqual(before);
  });

  it(
    "with STAGING_TEST_PHONES set, on an emptied schema: only its phones, at its numbers, and no line names a number",
    SLOW,
    async () => {
      await empty(db.sql);
      const named = ["tp-01", "tp-02", "tp-04"];
      const value = named.map((id) => `${id}=${configured(id)}`).join(",");
      const run = await runSeed({ ...local(), [TEST_PHONES_VARIABLE]: value });
      expect(run.code, run.stderr).toBe(0);
      expect(lines(run.stdout)).toEqual(
        seededLines(db.schema, [
          ["businesses", 245, 245],
          ...TABLES.slice(1).map((table) => [table, 2, 2] as const),
        ]),
      );
      const seeded = ["tp-02", "tp-04"].map((id) => phoneOf(id, configured(id)));
      expect(await phoneRows(db.sql)).toEqual(phoneRowsFor(seeded));
      const out = `${run.stdout}${run.stderr}`;
      expect(named.flatMap((id) => partsOf(configured(id))).filter((part) => out.includes(part))).toEqual([]);
    },
  );

  it(
    "refuses a variable it cannot read: exit 1, the refusal naming the entry and no part of the value, nothing written",
    SLOW,
    async () => {
      await empty(db.sql);
      const run = await runSeed({ ...local(), [TEST_PHONES_VARIABLE]: `tp-02 ${configured("tp-02")}` });
      expect(run.code).toBe(1);
      expect(lines(run.stdout)).toEqual([`seed: set staging-core into schema ${db.schema} on ${LOCAL}`]);
      expect(lines(run.stderr)).toEqual([
        `seed: failed: the staging core seed refused, writing nothing: ${TEST_PHONES_VARIABLE} entry 1 is not ` +
          "<roster id>=<number in E.164 form> (entries are separated by commas) (no part of its value is shown)",
      ]);
      expect(partsOf(configured("tp-02")).filter((part) => run.stderr.includes(part))).toEqual([]);
      expect(await rowCounts(db.sql)).toEqual(Object.fromEntries(TABLES.map((table) => [table, 0])));
    },
  );
});

describe("no real number is in the repository: the numbers come from the environment at run time", () => {
  it("every phone-like string in the seed sets (db/seeds, this set and its test included) and in the K-21 and K-06 fixtures the test phones mirror is in the fiction range, and this set's own are the roster's five fake handles", () => {
    const files = [...filesIn(path.join(REPO, "db/seeds")), ROSTER_FILE, SEND_FILE, PAGE_EVENT_FILE];
    const self = path.join(REPO, "db/seeds/staging-core.ts");
    expect(files).toContain(self);
    expect(files).toContain(path.join(REPO, "db/seeds/staging-core.int.test.ts"));
    const notFictional: string[] = [];
    for (const file of files) {
      for (const match of readFileSync(file, "utf8").matchAll(PHONE_LIKE)) {
        if (!FICTIONAL.test(`+1${nationalDigits(match[0])}`)) {
          notFictional.push(`${path.relative(REPO, file)}: ${match[0]}`);
        }
      }
    }
    expect(notFictional).toEqual([]);
    const own = [...readFileSync(self, "utf8").matchAll(PHONE_LIKE)].map((match) => match[0]);
    expect(sorted(own)).toEqual(sorted(ROSTER.outcome.phones.map(fakeNumberOf)));

    // The grep catches a number written any common way. The samples are built here from parts, so this file holds no
    // phone-like string outside the fiction range: one in area code 555, which serves no one, and a fictional one.
    const parts = ["555", "123", "4567"];
    const fiction = ["212", "555", "0123"];
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
  });
});
