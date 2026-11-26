// T-1561: K-05 v1.24's readStagingTestBusinesses (item 89, defaults 226 and 232), staging's test businesses, against
// local PostgreSQL (`npm run test:integration -- db/repo/staging-test-businesses`). The schema comes from migrating a
// fresh test schema (db/repo/test-db.ts), which is dropped when the file ends; the public schema is never touched.
//
// The read runs as K-05 v1.24 names it: through a client whose connections run as rosie_job, the runtime side's role,
// unscoped; the role is the connection's. The checks read every statement the rosie_job client sent (postgres.js debug,
// kept in memory and never printed): one read-only transaction at repeatable read on one connection, the business scope
// confirmed empty by a statement that reads no table, then one statement over companies joined to accounts that never
// names person_roles, businesses or phones, the numbers bound as parameters and never in a statement's text. Every
// answer is checked against data-access v1.24 with Ajv 2020-12, strict.
//
// The tables' owner loads K-04's seed-business-head.json and the rows read-staging-test-businesses-sam's note lists, in
// its order, every column not named taking its default, and a case's rows. Names are fixture set v1's demo shops and the
// master's sample cast (rule 9); the rows a case adds carry example ids (t1561) and numbers in the fiction range 555-0100
// to 555-0199.
import { readdirSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DataAccessDatabaseError } from "./clocks";
import type { Sql } from "./scope";
import { readStagingTestBusinesses, type ReadStagingTestBusinessesRequest } from "./staging-test-businesses";
import { createTestDatabase, type TestDatabase } from "./test-db";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Row = Record<string, Json>;

const CONTRACTS = new URL("../../contracts/", import.meta.url);
const ACCESS_DIR = new URL("data-access/fixtures/", CONTRACTS);
const CORE_DIR = new URL("db-schema/core/fixtures/", CONTRACTS);
const SLOW = { timeout: 60_000 };

const BARBERSHOP = "biz-lees-barbershop";
const YOGA = "biz-yoga-studio";
const MOVERS = "biz-movers";
const SAM = "person-sam";
const MAYA = "person-maya";
const SAM_NUMBER = "+15555550100";
const TP_02_NUMBER = "+15555550101";
const MAYA_NUMBER = "+15555550104";
const NUMBERS = [SAM_NUMBER, TP_02_NUMBER, MAYA_NUMBER];

interface Exchange {
  call: string;
  given: { k04Seeds: string[]; after: string[]; now: string; note?: string };
  request: Row;
  outcome: Row;
}

interface TableRow {
  table: string;
  values: Row;
}

interface IndexEntry {
  file: string;
  version: string;
  def?: string;
  expect: string;
}

const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));
const exchangeOf = (file: string): Exchange => readJson(new URL(file, ACCESS_DIR)) as Exchange;
const INDEX = (readJson(new URL("index.json", ACCESS_DIR)) as { fixtures: IndexEntry[] }).fixtures;
const OWN = INDEX.filter((entry) => (entry.def ?? "").startsWith("readStagingTestBusinesses."));

// ---- the contract's own schema (Ajv 2020-12, strict, as contracts:check runs it) ---------------------------------------

function schemaFiles(dir: URL): URL[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".schema.json") && !file.endsWith(".meta.schema.json"))
    .filter((file) => !file.startsWith("generated/") && !file.startsWith("scripts/"))
    .filter((file) => !file.includes("node_modules"))
    .map((file) => new URL(file, dir));
}

const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
for (const file of schemaFiles(CONTRACTS)) {
  ajv.addSchema(readJson(file) as object);
}
const V124_ID = (readJson(new URL("data-access/data-access.v1.24.schema.json", CONTRACTS)) as { $id: string })
  .$id;

function schemaErrors(def: string, value: unknown): string[] {
  const validate = ajv.getSchema(`${V124_ID}#/$defs/${def}`);
  if (validate === undefined) {
    throw new Error(`data-access v1.24 has no $defs/${def}`);
  }
  return validate(value)
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
}

// ---- databases and clients ------------------------------------------------------------------------------------------

interface Sent {
  connection: number;
  text: string;
  parameters: readonly unknown[];
}

let db: TestDatabase;
let job: Sql;
let app: Sql;
const sent: Sent[] = [];

function roleClient(role: string, name: string, record: boolean): Sql {
  return db.connect({
    // One connection for a client that records nothing, so a setting a case makes on it holds for its next read.
    max: record ? 2 : 1,
    onnotice: () => undefined,
    ...(record
      ? {
          debug: (connection: number, text: string, parameters: unknown[]) => {
            sent.push({ connection, text, parameters: [...parameters] });
          },
        }
      : {}),
    connection: { application_name: name, search_path: `${db.schema}, public`, role },
  });
}

beforeAll(async () => {
  db = await createTestDatabase({ name: "staging_test_businesses" });
  job = roleClient("rosie_job", "rosie-t1561-staging-job", true);
  app = roleClient("rosie_app", "rosie-t1561-staging-app", false);
}, 60_000);

afterAll(async () => {
  await job.end({ timeout: 5 });
  await app.end({ timeout: 5 });
  await db.drop();
});

/** Empties the tables, then writes K-04's seed-business-head.json and `rows`, as the owner, in one transaction. */
async function given(rows: readonly TableRow[]): Promise<void> {
  await db.sql`truncate businesses, persons, handles, bundles, release_flags restart identity cascade`;
  const head = (readJson(new URL("seed-business-head.json", CORE_DIR)) as { rows: TableRow[] }).rows;
  await db.sql.begin(async (tx) => {
    for (const row of [...head, ...rows]) {
      await tx`insert into ${tx(row.table)} ${tx(row.values as Record<string, never>)}`;
    }
  });
}

const row = (table: string, values: Row): TableRow => ({ table, values });
const company = (id: string, owner: string, name: string, businessId: string | null): TableRow =>
  row("companies", { id, owner_person_id: owner, name, business_id: businessId });

/** The rows read-staging-test-businesses-sam's note lists, in its order. */
const NOTE_ROWS: readonly TableRow[] = [
  row("persons", { id: SAM, name: "Sam Lee", language: null }),
  row("persons", { id: MAYA, name: "Maya", language: "en" }),
  row("handles", { id: "handle-sam", kind: "phone", address: SAM_NUMBER }),
  row("handles", { id: "handle-maya", kind: "phone", address: MAYA_NUMBER }),
  row("person_handles", { person_id: SAM, handle_id: "handle-sam" }),
  row("person_handles", { person_id: MAYA, handle_id: "handle-maya" }),
  row("phones", { number: SAM_NUMBER, handle_id: "handle-sam" }),
  row("phones", { number: MAYA_NUMBER, handle_id: "handle-maya" }),
  row("accounts", { person_id: SAM, mobile: SAM_NUMBER, mobile_proven_at: null }),
  row("accounts", { person_id: MAYA, mobile: MAYA_NUMBER, mobile_proven_at: null }),
  company("company-lees-barbershop", SAM, "Lee's Barbershop LLC", BARBERSHOP),
  company("company-yoga-studio", MAYA, "Yoga Studio LLC", YOGA),
  row("person_roles", {
    id: "role-sam-movers",
    person_id: SAM,
    business_id: MOVERS,
    role: "owner",
    ended_at: null,
  }),
];

async function watched(request: unknown): Promise<{ outcome: unknown; statements: Sent[]; logged: number }> {
  const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
  const spies = methods.map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
  sent.length = 0;
  try {
    let outcome: unknown;
    try {
      outcome = await readStagingTestBusinesses(job, request as ReadStagingTestBusinessesRequest);
    } catch (error) {
      outcome = error;
    }
    return {
      outcome,
      statements: [...sent],
      logged: spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0),
    };
  } finally {
    for (const spy of spies) {
      spy.mockRestore();
    }
  }
}

/**
 * The transaction's own statements, which carry no read (its probe, begin, the scope's reset, commit, rollback), and
 * postgres.js's own lookup of the server's array types on a new connection.
 */
const FRAME =
  /^(select 1|begin isolation level repeatable read read only|select set_config\(\$1, '', true\)|commit|rollback|select b\.oid, b\.typarray\s[^;]*)$/;
const SCOPE_PROBE = "select current_setting($1, true) as scope";

/**
 * Every statement the read sent: in one read-only transaction on one connection, the scope probe (no table) before one
 * statement over companies and accounts alone, the numbers its parameters and never its text.
 */
function expectStatements(statements: readonly Sent[], numbers: readonly string[]): void {
  const begin = statements.findIndex((statement) => statement.text.trim().startsWith("begin"));
  expect(statements[begin]?.text.trim()).toBe("begin isolation level repeatable read read only");
  const inside = statements.slice(begin);
  expect(new Set(inside.map((statement) => statement.connection)).size).toBe(1);
  expect(inside.at(-1)?.text.trim()).toBe("commit");
  const reads = statements.filter((statement) => !FRAME.test(statement.text.trim()));
  expect(reads.map((statement) => statement.text.trim().startsWith(SCOPE_PROBE))).toEqual([true, false]);
  const [probe, read] = reads;
  expect(probe?.parameters).toEqual(["rosie.business_id"]);
  expect(read?.text).toMatch(/from companies c\s+join accounts a on a\.person_id = c\.owner_person_id/);
  expect([...(read?.parameters ?? [])].sort()).toEqual([...numbers].sort());
  for (const statement of statements) {
    for (const word of ["person_roles", "businesses", "phones", "handles", "persons "]) {
      expect(statement.text.includes(word), word).toBe(false);
    }
    for (const number of NUMBERS) {
      expect(statement.text.includes(number)).toBe(false);
    }
  }
}

// ---- the tests ------------------------------------------------------------------------------------------------------

describe("readStagingTestBusinesses's fixtures (K-05 v1.24 item 89)", () => {
  it("the index lists item 89's one exchange and its one refused twin, each as its definition takes it", () => {
    expect(OWN.map((entry) => `${entry.file} ${entry.expect}`).sort()).toEqual([
      "invalid/refuse-staging-test-businesses-no-numbers.json refuse",
      "read-staging-test-businesses-sam.json accept",
    ]);
    for (const entry of OWN) {
      const errors = schemaErrors(entry.def ?? "", exchangeOf(entry.file));
      if (entry.expect === "accept") {
        expect(errors, entry.file).toEqual([]);
      } else {
        expect(errors, entry.file).not.toEqual([]);
      }
    }
  });

  it(
    "read-staging-test-businesses-sam: as rosie_job, the barbershop alone, by its company's owner, never the movers by a role",
    SLOW,
    async () => {
      const exchange = exchangeOf("read-staging-test-businesses-sam.json");
      expect(exchange.given.k04Seeds).toEqual(["seed-business-head.json"]);
      await given(NOTE_ROWS);
      const run = await watched(exchange.request);
      expect(run.outcome).toEqual(exchange.outcome);
      expect(schemaErrors("readStagingTestBusinesses.response", run.outcome)).toEqual([]);
      expect(
        schemaErrors("readStagingTestBusinesses.exchange", { ...exchange, outcome: run.outcome }),
      ).toEqual([]);
      expectStatements(run.statements, exchange.request.numbers as string[]);
      expect(run.logged).toBe(0);
    },
  );

  it(
    "refuse-staging-test-businesses-no-numbers: refused before any statement; put right, it is read-staging-test-businesses-sam",
    SLOW,
    async () => {
      const twin = exchangeOf("read-staging-test-businesses-sam.json");
      const refused = exchangeOf("invalid/refuse-staging-test-businesses-no-numbers.json");
      await given(NOTE_ROWS);
      const run = await watched(refused.request);
      expect(run.outcome).toBeInstanceOf(TypeError);
      expect((run.outcome as Error).message).toBe(
        "readStagingTestBusinesses: numbers is a list of at least one number",
      );
      expect(run.statements).toEqual([]);
      expect(refused.outcome).toEqual(twin.outcome);
      expect({ ...refused.given, note: "" }).toEqual({ ...twin.given, note: "" });
      expect(twin.request).toEqual({ numbers: [SAM_NUMBER, TP_02_NUMBER] });
    },
  );
});

describe("readStagingTestBusinesses beyond the fixtures (README item 89, default 232)", () => {
  it(
    "answers each business once, in id order byte by byte, whatever the order of the numbers; a company with no business names none; a proven mobile and one not proven alike",
    SLOW,
    async () => {
      await given([
        ...NOTE_ROWS.filter((each) => each.table !== "companies" && each.table !== "accounts"),
        row("accounts", { person_id: SAM, mobile: SAM_NUMBER, mobile_proven_at: "2026-11-23T14:58:41Z" }),
        row("accounts", { person_id: MAYA, mobile: MAYA_NUMBER, mobile_proven_at: null }),
        company("company-lees-barbershop", SAM, "Lee's Barbershop LLC", BARBERSHOP),
        company("company-t1561-movers", SAM, "Movers LLC", MOVERS),
        company("company-t1561-sam-no-business", SAM, "Lee Plumbing", null),
        company("company-yoga-studio", MAYA, "Yoga Studio LLC", YOGA),
      ]);
      const both = await watched({ numbers: [MAYA_NUMBER, SAM_NUMBER] });
      expect(both.outcome).toEqual({ result: "testBusinesses", businessIds: [BARBERSHOP, MOVERS, YOGA] });
      expectStatements(both.statements, [MAYA_NUMBER, SAM_NUMBER]);
      const maya = await watched({ numbers: [MAYA_NUMBER] });
      expect(maya.outcome).toEqual({ result: "testBusinesses", businessIds: [YOGA] });
      expectStatements(maya.statements, [MAYA_NUMBER]);
    },
  );

  it("a number no account holds names no business: an empty list", SLOW, async () => {
    await given(NOTE_ROWS);
    const run = await watched({ numbers: [TP_02_NUMBER] });
    expect(run.outcome).toEqual({ result: "testBusinesses", businessIds: [] });
    expect(schemaErrors("readStagingTestBusinesses.response", run.outcome)).toEqual([]);
    expectStatements(run.statements, [TP_02_NUMBER]);
  });

  it("a request of the wrong shape is refused before any statement, never naming a number", async () => {
    for (const request of [
      { numbers: [SAM_NUMBER, SAM_NUMBER] },
      { numbers: ["5555550100"] },
      { numbers: [] },
    ]) {
      const run = await watched(request);
      expect(run.outcome).toBeInstanceOf(TypeError);
      expect((run.outcome as Error).message.includes("555")).toBe(false);
      expect(run.statements).toEqual([]);
    }
  });
});

describe("the side the read runs on (default 226)", () => {
  it("the clients run as rosie_job and rosie_app with no business scope", async () => {
    for (const [client, role] of [
      [job, "rosie_job"],
      [app, "rosie_app"],
    ] as const) {
      const [found] = await client<{ who: string; scope: string | null }[]>`
        select current_user as who, current_setting('rosie.business_id', true) as scope
      `;
      expect(found?.who).toBe(role);
      expect(found?.scope ?? "").toBe("");
    }
  });

  it(
    "the Tool API's role is refused by PostgreSQL's privilege check (no grant on accounts), scrubbed, naming no number",
    SLOW,
    async () => {
      await given(NOTE_ROWS);
      let error: unknown = null;
      try {
        await readStagingTestBusinesses(app, { numbers: [SAM_NUMBER] });
      } catch (thrown) {
        error = thrown;
      }
      expect(error).toBeInstanceOf(DataAccessDatabaseError);
      expect((error as DataAccessDatabaseError).code).toBe("42501");
      const text = `${(error as Error).message} ${JSON.stringify(error)}`;
      for (const value of [SAM_NUMBER, BARBERSHOP, SAM]) {
        expect(text.includes(value), value).toBe(false);
      }
    },
  );

  it(
    "a business scope a connection kept is emptied for the read's transaction, so every company shows: the barbershop through a connection scoped to the yoga studio",
    SLOW,
    async () => {
      await given(NOTE_ROWS);
      const scoped = roleClient("rosie_job", "rosie-t1561-staging-scoped", false);
      try {
        await scoped`select set_config('rosie.business_id', ${YOGA}, false)`;
        const [hidden] = await scoped<{ n: number }[]>`
          select count(*)::int as n from companies where business_id = ${BARBERSHOP}
        `;
        expect(hidden?.n).toBe(0);
        expect(await readStagingTestBusinesses(scoped, { numbers: [SAM_NUMBER] })).toEqual({
          result: "testBusinesses",
          businessIds: [BARBERSHOP],
        });
      } finally {
        await scoped.end({ timeout: 5 });
      }
    },
  );
});
