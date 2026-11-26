// T-1561: K-05 v1.24's openReviewItemsOf (item 88, defaults 226 and 228), a business's open K-37 review items of one
// kind, against local PostgreSQL (`npm run test:integration -- db/repo/open-review-items`). The schema comes from
// migrating a fresh test schema (db/repo/test-db.ts), which is dropped when the file ends; the public schema is never
// touched.
//
// The read runs as K-05 v1.24 names it: through a client whose connections run as rosie_job, the runtime side's role,
// with no business scope; the role is the connection's. review_items has no row-level security, so nothing but the read's
// own statement holds it to its business: the checks read every statement the rosie_job client sent (postgres.js debug,
// kept in memory and never printed) and hold each read to one statement naming business_id = the request's business,
// bound as a parameter, in one read-only transaction at repeatable read on one connection, never naming the summary or
// another column the item leaves out. Every answer is checked against data-access v1.24 with Ajv 2020-12, strict.
//
// The tables' owner loads K-04's seed-person-roles.json (with its chain) and Lee Home Services' businesses row, the one
// row of K-23's seed-company-two-kinds.json the fixtures need (no K-04 seed holds that business), then the review items
// a fixture's note or a case lists. Names are fixture set v1's demo shops and the master's sample cast (rule 9); the items
// a case adds carry example ids (t1561), and every summary is a plain stand-in sentence for the team.
import { readdirSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DataAccessDatabaseError } from "./clocks";
import { openReviewItemsOf, type OpenReviewItemsOfRequest } from "./open-review-items";
import type { Sql } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Row = Record<string, Json>;

const CONTRACTS = new URL("../../contracts/", import.meta.url);
const ACCESS_DIR = new URL("data-access/fixtures/", CONTRACTS);
const SCHEMA_DIR = new URL("db-schema/", CONTRACTS);
const SLOW = { timeout: 60_000 };

const LEE = "biz-lee-home-services";
const BARBERSHOP = "biz-lees-barbershop";
const SAM = "person-sam";
const SUMMARY = "The listing Sam named does not match a business on file. Check it before it goes live.";
const OPENED_AT = "2026-11-23T15:00:00Z";
const DUE_AT = "2026-11-24T15:00:00Z";

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
const OWN = INDEX.filter((entry) => (entry.def ?? "").startsWith("openReviewItemsOf."));

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
    max: 2,
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
  db = await createTestDatabase({ name: "open_review_items" });
  job = roleClient("rosie_job", "rosie-t1561-review-job", true);
  app = roleClient("rosie_app", "rosie-t1561-review-app", false);
}, 60_000);

afterAll(async () => {
  await job.end({ timeout: 5 });
  await app.end({ timeout: 5 });
  await db.drop();
});

function seedRows(seed: URL, seen: Set<string>): TableRow[] {
  if (seen.has(seed.href)) {
    return [];
  }
  seen.add(seed.href);
  const file = readJson(seed) as { after: string[]; rows: TableRow[] };
  return [...file.after.flatMap((before) => seedRows(new URL(before, seed), seen)), ...file.rows];
}

/** Lee Home Services' businesses row, as K-23's seed-company-two-kinds.json holds it (its own row alone). */
const LEE_BUSINESS: TableRow = (() => {
  const seed = readJson(new URL("business-setup/fixtures/seed-company-two-kinds.json", SCHEMA_DIR)) as {
    rows: TableRow[];
  };
  const row = seed.rows.find((each) => each.table === "businesses" && each.values.id === LEE);
  if (row === undefined) {
    throw new Error("seed-company-two-kinds.json holds no Lee Home Services row");
  }
  return row;
})();

/** Empties the tables, then writes K-04's seed-person-roles.json (with its chain), Lee Home Services and `items`. */
async function given(items: readonly TableRow[]): Promise<void> {
  await db.sql`truncate businesses, persons, handles, bundles, release_flags restart identity cascade`;
  const rows = [
    ...seedRows(new URL("core/fixtures/seed-person-roles.json", SCHEMA_DIR), new Set()),
    LEE_BUSINESS,
    ...items,
  ];
  await db.sql.begin(async (tx) => {
    for (const row of rows) {
      await tx`insert into ${tx(row.table)} ${tx(row.values as Record<string, never>)}`;
    }
  });
}

/** A review item: open by default, at version 1, opened and due as the fixtures' moment has it. */
function item(
  id: string,
  businessId: string | null,
  kind: string,
  change: { state?: "open" | "waiting" | "done"; raisedBy?: string | null; version?: number } = {},
): TableRow {
  const state = change.state ?? "open";
  return {
    table: "review_items",
    values: {
      id,
      kind,
      business_id: businessId,
      raised_by_person_id: change.raisedBy === undefined ? SAM : change.raisedBy,
      summary: SUMMARY,
      opened_at: OPENED_AT,
      due_at: DUE_AT,
      state,
      wait_until: state === "waiting" ? "2026-11-26T15:00:00Z" : null,
      decided_at: state === "done" ? "2026-11-23T16:00:00Z" : null,
      decided_by_person_id: state === "done" ? "person-alex" : null,
      outcome: state === "done" ? "approved" : null,
      version: change.version ?? 1,
    },
  };
}

/** The item open-review-items-lee-listing-match's note lists. */
const LEE_LISTING_MATCH = item("review-lee-listing-match", LEE, "listing_match");
const NOTE_ROWS: Readonly<Record<string, readonly TableRow[]>> = {
  "open-review-items-lee-listing-match.json": [LEE_LISTING_MATCH],
  "open-review-items-lee-none.json": [LEE_LISTING_MATCH],
};

async function watched(request: unknown): Promise<{ outcome: unknown; statements: Sent[]; logged: number }> {
  const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
  const spies = methods.map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
  sent.length = 0;
  try {
    let outcome: unknown;
    try {
      outcome = await openReviewItemsOf(job, request as OpenReviewItemsOfRequest);
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
const NEVER_NAMED = [
  "summary",
  "subject_table",
  "subject_row_id",
  "turn_id",
  "opened_at",
  "due_at",
  "wait_until",
  "decided_at",
  "decided_by_person_id",
  "outcome",
];

/** Every statement the read sent: one read naming business_id = the request's business, in one read-only transaction. */
function expectStatements(statements: readonly Sent[], businessId: string): void {
  const begin = statements.findIndex((statement) => statement.text.trim().startsWith("begin"));
  expect(statements[begin]?.text.trim()).toBe("begin isolation level repeatable read read only");
  const inside = statements.slice(begin);
  expect(new Set(inside.map((statement) => statement.connection)).size).toBe(1);
  expect(inside.at(-1)?.text.trim()).toBe("commit");
  const reads = statements.filter((statement) => !FRAME.test(statement.text.trim()));
  expect(reads).toHaveLength(1);
  for (const read of reads) {
    expect(read.text.includes("from review_items")).toBe(true);
    expect(read.text).toMatch(/where business_id = \$1 /);
    expect(read.parameters[0]).toBe(businessId);
    for (const word of NEVER_NAMED) {
      expect(read.text.includes(word), word).toBe(false);
    }
  }
}

// ---- the tests ------------------------------------------------------------------------------------------------------

describe("openReviewItemsOf's fixtures (K-05 v1.24 item 88)", () => {
  it("the index lists item 88's two exchanges and its one refused twin, each as its definition takes it", () => {
    expect(
      OWN.filter((entry) => entry.expect === "accept")
        .map((entry) => entry.file)
        .sort(),
    ).toEqual(["open-review-items-lee-listing-match.json", "open-review-items-lee-none.json"]);
    const refused = OWN.filter((entry) => entry.expect === "refuse");
    expect(refused.map((entry) => entry.file)).toEqual(["invalid/refuse-open-review-items-summary.json"]);
    for (const entry of OWN) {
      const errors = schemaErrors(entry.def ?? "", exchangeOf(entry.file));
      if (entry.expect === "accept") {
        expect(errors, entry.file).toEqual([]);
      } else {
        expect(errors, entry.file).not.toEqual([]);
      }
    }
  });

  for (const file of ["open-review-items-lee-listing-match.json", "open-review-items-lee-none.json"]) {
    it(`${file}: as rosie_job, the fixture's outcome, one statement naming the business`, SLOW, async () => {
      const exchange = exchangeOf(file);
      await given(NOTE_ROWS[file] ?? []);
      const run = await watched(exchange.request);
      expect(run.outcome).toEqual(exchange.outcome);
      expect(schemaErrors("openReviewItemsOf.response", run.outcome)).toEqual([]);
      expect(schemaErrors("openReviewItemsOf.exchange", { ...exchange, outcome: run.outcome })).toEqual([]);
      expectStatements(run.statements, LEE);
      expect(run.logged).toBe(0);
    });
  }

  it(
    "refuse-open-review-items-summary: the read never answers the summary; put right, the twin is open-review-items-lee-listing-match's outcome",
    SLOW,
    async () => {
      const twin = exchangeOf("open-review-items-lee-listing-match.json");
      const refused = exchangeOf("invalid/refuse-open-review-items-summary.json");
      await given([LEE_LISTING_MATCH]);
      const outcome = await openReviewItemsOf(job, twin.request as unknown as OpenReviewItemsOfRequest);
      expect(outcome).toEqual(twin.outcome);
      expect(outcome).not.toEqual(refused.outcome);
      expect(JSON.stringify(outcome).includes(SUMMARY)).toBe(false);
      const [first] = refused.outcome.items as Row[];
      const { summary, ...putRight } = first ?? {};
      expect(summary).toBe(SUMMARY);
      expect({ ...refused.outcome, items: [putRight] }).toEqual(twin.outcome);
    },
  );
});

describe("openReviewItemsOf beyond the fixtures (README item 88, default 228)", () => {
  it(
    "answers only the business's items of the kind that are open or waiting, in id order byte by byte: never a done item, another business's, one with no business, or another kind",
    SLOW,
    async () => {
      await given([
        item("review-t1561-control-a", LEE, "control", { state: "waiting", raisedBy: null, version: 2 }),
        item("review-t1561-control-B", LEE, "control"),
        item("review-t1561-control-done", LEE, "control", { state: "done", version: 2 }),
        item("review-t1561-control-shop", BARBERSHOP, "control"),
        item("review-t1561-control-none", null, "control"),
        item("review-t1561-listing", LEE, "listing_match"),
      ]);
      const run = await watched({ businessId: LEE, kind: "control" });
      expect(run.outcome).toEqual({
        result: "openReviewItems",
        businessId: LEE,
        kind: "control",
        items: [
          { id: "review-t1561-control-B", kind: "control", state: "open", version: 1, raisedByPersonId: SAM },
          {
            id: "review-t1561-control-a",
            kind: "control",
            state: "waiting",
            version: 2,
            raisedByPersonId: null,
          },
        ],
      });
      expect(schemaErrors("openReviewItemsOf.response", run.outcome)).toEqual([]);
      expectStatements(run.statements, LEE);
      // The barbershop's own: its open control item alone.
      const shop = await watched({ businessId: BARBERSHOP, kind: "control" });
      expect(shop.outcome).toMatchObject({ items: [{ id: "review-t1561-control-shop", state: "open" }] });
      expectStatements(shop.statements, BARBERSHOP);
    },
  );

  it(
    "a business with only done items of the kind, and a business no row names: an empty list",
    SLOW,
    async () => {
      await given([item("review-t1561-done", LEE, "owner_claim", { state: "done", version: 2 })]);
      for (const businessId of [LEE, "biz-t1561-nowhere"]) {
        const run = await watched({ businessId, kind: "owner_claim" });
        expect(run.outcome).toEqual({
          result: "openReviewItems",
          businessId,
          kind: "owner_claim",
          items: [],
        });
        expectStatements(run.statements, businessId);
      }
    },
  );

  it("a request of the wrong shape is refused before any statement", async () => {
    for (const request of [{ businessId: LEE }, { businessId: LEE, kind: "control", summary: true }, null]) {
      const run = await watched(request);
      expect(run.outcome).toBeInstanceOf(TypeError);
      expect(run.statements).toEqual([]);
    }
  });
});

describe("the side the read runs on (default 226; K-37 rule 2)", () => {
  it("the clients run as rosie_job and rosie_app with no business scope", async () => {
    for (const [client, role] of [
      [job, "rosie_job"],
      [app, "rosie_app"],
    ] as const) {
      const [row] = await client<{ who: string; scope: string | null }[]>`
        select current_user as who, current_setting('rosie.business_id', true) as scope
      `;
      expect(row?.who).toBe(role);
      expect(row?.scope ?? "").toBe("");
    }
  });

  it(
    "the Tool API's role is refused by PostgreSQL's privilege check (no grant on review_items), scrubbed, naming no value",
    SLOW,
    async () => {
      await given([LEE_LISTING_MATCH]);
      let error: unknown = null;
      try {
        await openReviewItemsOf(app, { businessId: LEE, kind: "listing_match" });
      } catch (thrown) {
        error = thrown;
      }
      expect(error).toBeInstanceOf(DataAccessDatabaseError);
      expect((error as DataAccessDatabaseError).code).toBe("42501");
      const text = `${(error as Error).message} ${JSON.stringify(error)}`;
      for (const value of [LEE, "review-lee-listing-match", SUMMARY]) {
        expect(text.includes(value), value).toBe(false);
      }
    },
  );
});
